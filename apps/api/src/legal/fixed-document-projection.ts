import { projectLegacyResource } from "@zzsh/content/legacy-plate";
import type { Pool, PoolClient } from "pg";
import { extractPlate, plateDigest, type PlateDocumentEnvelope } from "@zzsh/content/plate";

import { ADMIN_PERMISSION, hasPermission } from "../auth/admin-authorization";
import { APPROVAL_EXECUTION_MODE, approvalRegistration, type ApprovalProjectionViewer, type ApprovalRequestFacts } from "../auth/approval-business";
import {
  FIXED_DOCUMENT_PUBLISH_OPERATION,
  FIXED_DOCUMENT_PUBLISH_PERMISSION,
  FIXED_DOCUMENT_SUBMIT_PERMISSION,
  FIXED_DOC_EFFECTIVE,
  blockChangeCounts,
  diffDocumentBlocks,
  isLegalKind,
  parseFixedDocumentPublishPayload,
  type FixedDocumentPublishItem,
} from "./fixed-document-contract";
import { readCurrentLegalDocument, readLegalDocumentsByIds, type FixedDocType, type LegalDocumentVersion } from "./legal-documents";

/**
 * 固定文书发布审批投影：最显眼处给出用户端预览与当前生效版本的按块差异。
 * 只读冻结载荷与当前行，不改写任何已封存正文、摘要或接受记录。
 */

type NoticeItemRow = { id: string; type: string; resourceKey: string | null; revision: string };
type NoticeVersionRow = { id: string; itemId: string; state: string; title: string; payload: unknown; revision: string; sequence: number };

export type FixedDocumentFacts = {
  legalDrafts: Map<string, LegalDocumentVersion>;
  legalCurrent: Map<string, LegalDocumentVersion>;
  noticeItems: Map<string, NoticeItemRow>;
  noticeDrafts: Map<string, NoticeVersionRow>;
  noticePublished: Map<string, NoticeVersionRow>;
};

const EMPTY_FACTS: FixedDocumentFacts = {
  legalDrafts: new Map(), legalCurrent: new Map(), noticeItems: new Map(), noticeDrafts: new Map(), noticePublished: new Map(),
};

function payloadItems(row: ApprovalRequestFacts): FixedDocumentPublishItem[] {
  try {
    return parseFixedDocumentPublishPayload(row.finalPayload ?? row.operationPayload).items;
  } catch {
    return [];
  }
}

/** 按页批量取事实：查询条数与本页申请行数无关。 */
export async function loadFixedDocumentFacts(client: Pool | PoolClient, rows: readonly ApprovalRequestFacts[]): Promise<FixedDocumentFacts> {
  if (rows.length === 0) return EMPTY_FACTS;
  const items = rows.flatMap(payloadItems);
  if (items.length === 0) return EMPTY_FACTS;
  const legalIds = [...new Set(items.filter(item => isLegalKind(item.kind)).map(item => item.draftVersionId))];
  const legalKinds = [...new Set(items.filter(item => isLegalKind(item.kind)).map(item => item.kind))] as FixedDocType[];
  const noticeKeys = [...new Set(items.filter(item => item.kind === "NOTICE").map(item => item.key))];
  const noticeIds = [...new Set(items.filter(item => item.kind === "NOTICE").map(item => item.draftVersionId))];

  const legalDrafts = await readLegalDocumentsByIds(client as PoolClient, legalIds);
  const legalCurrent = new Map<string, LegalDocumentVersion>();
  for (const kind of legalKinds) {
    const current = await readCurrentLegalDocument(client as PoolClient, kind);
    if (current) legalCurrent.set(kind, current);
  }
  const noticeItems = noticeKeys.length === 0 ? [] : (await client.query<NoticeItemRow>(
    `SELECT i."id", i."type", i."resource_key" AS "resourceKey", i."revision"::text AS "revision"
       FROM "zzsh_content"."content_item" i WHERE i."resource_key" = ANY($1::text[])`, [noticeKeys],
  )).rows;
  const versionFields = `v."id", v."item_id" AS "itemId", v."state", v."title", v."payload", v."revision"::text AS "revision", v."sequence"`;
  const noticeDrafts = noticeIds.length === 0 ? [] : (await client.query<NoticeVersionRow>(
    `SELECT ${versionFields} FROM "zzsh_content"."content_version" v WHERE v."id" = ANY($1::text[])`, [noticeIds],
  )).rows;
  const itemIds = noticeItems.map(item => item.id);
  const noticePublished = itemIds.length === 0 ? [] : (await client.query<NoticeVersionRow>(
    `SELECT ${versionFields} FROM "zzsh_content"."content_version" v WHERE v."item_id" = ANY($1::text[]) AND v."state" = 'PUBLISHED'`, [itemIds],
  )).rows;
  return {
    legalDrafts: new Map(legalDrafts.map(row => [row.id, row])),
    legalCurrent,
    noticeItems: new Map(noticeItems.map(row => [row.resourceKey ?? "", row])),
    noticeDrafts: new Map(noticeDrafts.map(row => [row.id, row])),
    noticePublished: new Map(noticePublished.map(row => [row.itemId, row])),
  };
}

function noticeEnvelope(payload: unknown): PlateDocumentEnvelope | null {
  const row = (projectLegacyResource(payload) ?? payload) as { kind?: string; document?: PlateDocumentEnvelope; format?: string; value?: unknown } | null;
  const document = row?.kind === "notice" ? row.document : row?.format === "plate" ? row as unknown as PlateDocumentEnvelope : undefined;
  return document && document.format === "plate" && Array.isArray(document.value) ? document : null;
}

function plainText(body: string, document: PlateDocumentEnvelope | null): string {
  return document ? extractPlate(document).plainText : body;
}

/** 用户端预览与差异共用的纯文字投影：plate 取文档投影，text 取存储正文。 */
export function fixedDocumentPlainText(row: { body: string; bodyDocument: PlateDocumentEnvelope | null }): string {
  return plainText(row.body, row.bodyDocument);
}

export function fixedDocumentReadable(viewer: ApprovalProjectionViewer): boolean {
  return viewer.access.isBoss
    || hasPermission(viewer.access, FIXED_DOCUMENT_SUBMIT_PERMISSION)
    || hasPermission(viewer.access, FIXED_DOCUMENT_PUBLISH_PERMISSION)
    || hasPermission(viewer.access, ADMIN_PERMISSION.contentPlatformRead);
}

type ProjectionItem = Record<string, unknown>;

async function projectItem(item: FixedDocumentPublishItem, facts: FixedDocumentFacts): Promise<ProjectionItem> {
  const base: ProjectionItem = {
    kind: item.kind, key: item.key, draftVersionId: item.draftVersionId,
    baseVersionId: item.baseVersionId, digest: item.digest,
  };
  if (isLegalKind(item.kind)) {
    const draft = facts.legalDrafts.get(item.draftVersionId);
    const current = facts.legalCurrent.get(item.kind) ?? null;
    if (!draft) return { ...base, readAvailable: false, title: null, bodyFormat: null, preview: null, base: null, blocks: [], changes: blockChangeCounts([]) };
    const before = current ? plainText(current.body, current.bodyDocument) : "";
    const after = plainText(draft.body, draft.bodyDocument);
    const blocks = diffDocumentBlocks(before, after);
    return {
      ...base, readAvailable: true, title: draft.title, bodyFormat: draft.bodyFormat, status: draft.status,
      digestMatches: draft.digest === item.digest,
      baseMatches: (current?.id ?? null) === item.baseVersionId,
      preview: { body: draft.body, document: draft.bodyDocument },
      base: current ? { versionId: current.id, title: current.title, body: current.body, document: current.bodyDocument, effectiveAt: current.effectiveAt } : null,
      blocks, changes: blockChangeCounts(blocks),
    };
  }
  const draft = facts.noticeDrafts.get(item.draftVersionId);
  const resource = facts.noticeItems.get(item.key);
  const published = resource ? facts.noticePublished.get(resource.id) ?? null : null;
  if (!draft || !resource) return { ...base, readAvailable: false, title: null, bodyFormat: "plate", preview: null, base: null, blocks: [], changes: blockChangeCounts([]) };
  const document = noticeEnvelope(draft.payload);
  const baseDocument = published ? noticeEnvelope(published.payload) : null;
  const after = document ? extractPlate(document).plainText : "";
  const before = baseDocument ? extractPlate(baseDocument).plainText : "";
  const blocks = diffDocumentBlocks(before, after);
  return {
    ...base, readAvailable: true, title: draft.title, bodyFormat: "plate", status: draft.state,
    digestMatches: document ? await plateDigest(document) === item.digest : false,
    baseMatches: (published?.id ?? null) === item.baseVersionId,
    preview: { body: after, document },
    base: published ? { versionId: published.id, title: published.title, body: before, document: baseDocument, effectiveAt: null } : null,
    blocks, changes: blockChangeCounts(blocks),
  };
}

/** 单笔申请的固定文书视图：预览 + 差异 + 本次执行结果（回执与已封存行双重核对）。 */
export async function fixedDocumentView(
  row: ApprovalRequestFacts,
  viewer: ApprovalProjectionViewer,
  facts: FixedDocumentFacts,
  receipt: { status: string; resultCode: string; resultDetail: string | null } | undefined,
): Promise<Record<string, unknown>> {
  const registration = approvalRegistration(row.operationCode);
  const base: Record<string, unknown> = {
    requestId: row.id,
    businessType: registration?.businessType ?? "content",
    businessTitle: registration?.title ?? "固定文书发布",
    operationCode: row.operationCode,
    executionMode: registration?.executionMode ?? APPROVAL_EXECUTION_MODE.genericTransaction,
  };
  if (!fixedDocumentReadable(viewer)) {
    return { ...base, summaryAvailable: false, detailsAvailable: false, restrictedReasonCodes: ["BUSINESS_PERMISSION_REQUIRED"] };
  }
  const payload = row.finalPayload ?? row.operationPayload;
  let items: FixedDocumentPublishItem[] = [];
  let payloadState: "KNOWN" | "INVALID" = "KNOWN";
  try {
    items = parseFixedDocumentPublishPayload(payload).items;
  } catch {
    payloadState = "INVALID";
  }
  const projected = await Promise.all(items.map(item => projectItem(item, facts)));
  const summary: Record<string, unknown> = {
    schemaVersion: 1,
    changeSummary: row.summary,
    payloadVersion: row.payloadVersion,
    payloadHash: row.finalPayloadHash ?? row.operationPayloadHash,
    requestPayloadHash: row.operationPayloadHash,
    finalPayloadHash: row.finalPayloadHash ?? null,
    payloadSource: row.finalPayload ? "APPROVED_FINAL" : "REQUEST_ORIGINAL",
    fixedDocument: { schema: "content-fixed-document-publish.v1", payloadState, items: projected },
  };
  const objectRefs = projected.flatMap(item => {
    const refs: Record<string, unknown>[] = [];
    if (typeof item.draftVersionId === "string") refs.push({ type: item.kind === "NOTICE" ? "content_version" : "legal_document_version", id: item.draftVersionId });
    if (typeof item.baseVersionId === "string") refs.push({ type: item.kind === "NOTICE" ? "content_version" : "legal_document_version", id: item.baseVersionId });
    return refs;
  });
  const effective = receipt?.status === "SUCCEEDED" && receipt.resultCode === FIXED_DOC_EFFECTIVE;
  const sealedRows = projected.every(item => {
    if (item.readAvailable !== true) return false;
    if (item.kind === "NOTICE") return facts.noticePublished.get(facts.noticeItems.get(String(item.key))?.id ?? "")?.id === item.draftVersionId;
    const draft = facts.legalDrafts.get(String(item.draftVersionId));
    return draft?.status === "SEALED" && draft.approvalRequestId === row.id;
  });
  const result: Record<string, unknown> = {
    resultAvailability: effective && sealedRows ? "KNOWN" : row.status === "EXECUTED" ? "UNRESOLVED" : "NOT_APPLICABLE",
  };
  if (receipt) result.executionReceipt = { status: receipt.status, resultCode: receipt.resultCode, resultDetail: receipt.resultDetail };
  if (effective) result.fixedDocumentResult = { knowledge: sealedRows ? "KNOWN" : "UNKNOWN", effectiveAt: receipt?.resultDetail ?? null, versionIds: projected.map(item => item.draftVersionId) };
  if (result.resultAvailability === "UNRESOLVED") result.resultReasonCode = "FIXED_DOCUMENT_RESULT_NOT_READ";
  return { ...base, summaryAvailable: true, detailsAvailable: true, summary, objectRefs, ...result };
}