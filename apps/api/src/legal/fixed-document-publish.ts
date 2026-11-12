import { projectLegacyResource } from "@zzsh/content/legacy-plate";
import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { plateDigest, validatePlateDocument, type PlateDocumentEnvelope } from "@zzsh/content/plate";

import type { ApprovalOperationExecutor } from "../auth/auth-security";
import { hashApprovalPayload } from "../auth/approval-audit";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { loadContentVersion, publishContentVersion, type ContentItemRow, type ContentVersionRow } from "../content/content";
import { loadResourceItem } from "../content/managed-content";
import { conflict, invalid, notFound } from "../supply/supply-util";
import {
  readCurrentLegalDocument,
  readCurrentPlatformDocuments,
  readLegalDocumentById,
  sealLegalDocumentByApproval,
  submitLegalDocument,
  type FixedDocType,
  type LegalDocumentVersion,
} from "./legal-documents";
import {
  FIXED_DOCUMENT_PUBLISH_OPERATION,
  FIXED_DOCUMENT_PUBLISH_TRIGGER,
  FIXED_DOC_EFFECTIVE,
  isLegalKind,
  parseFixedDocumentPublishPayload,
  type FixedDocumentPublishItem,
  type FixedDocumentPublishPayload,
} from "./fixed-document-contract";

export {
  FIXED_DOCUMENT_PUBLISH_OPERATION,
  FIXED_DOCUMENT_PUBLISH_TRIGGER,
  FIXED_DOCUMENT_SUBMIT_PERMISSION,
  FIXED_DOCUMENT_PUBLISH_PERMISSION,
  FIXED_DOC_EFFECTIVE,
  FIXED_DOCUMENT_PAYLOAD_SCHEMA,
  FIXED_DOCUMENT_KINDS,
  isLegalKind,
  parseFixedDocumentPublishPayload,
  diffDocumentBlocks,
  blockChangeCounts,
  type FixedDocumentKind,
  type FixedDocumentPublishItem,
  type FixedDocumentPublishPayload,
  type FixedDocumentBlockChange,
} from './fixed-document-contract';

export type LegalFixedTarget = { kind: FixedDocType; key: string; draft: LegalDocumentVersion; current: LegalDocumentVersion | null };
export type NoticeFixedTarget = { kind: "NOTICE"; key: string; item: ContentItemRow; draft: NoticeVersion; current: NoticeVersion | null; document: PlateDocumentEnvelope };
export type FixedDocumentTarget = LegalFixedTarget | NoticeFixedTarget;

/** 场景说明版本只读展示与发布所需字段；发布仍由 content 域的完整行校验完成。 */
type NoticeVersion = Pick<ContentVersionRow, "id" | "itemId" | "state" | "title" | "payload" | "revision" | "sequence">;

const NOTICE_VERSION_FIELDS = `v."id", v."item_id" AS "itemId", v."state", v."title", v."payload", v."revision"::text AS "revision", v."sequence"`;

function noticeDocument(version: NoticeVersion): PlateDocumentEnvelope {
  const payload = (projectLegacyResource(version.payload) ?? version.payload) as { kind?: string; document?: PlateDocumentEnvelope } | null;
  const document = payload?.kind === "notice" ? payload.document : undefined;
  if (!document || document.format !== "plate" || document.schemaVersion !== 1 || document.preset !== "notice") {
    throw conflict("场景说明版本不是 plate notice 内容");
  }
  const checked = validatePlateDocument(document, { preset: "notice", mode: "publish" });
  if (!checked.ok) throw conflict("场景说明发布校验未通过");
  return document;
}

/**
 * 逐项重核冻结事实：草稿仍存在、摘要一致、baseVersionId 仍是当前生效版本。
 * submit 要求 DRAFT；execute 要求 PENDING 且绑定本申请；read 只读投影，缺失不抛。
 */
export async function loadFixedDocumentTargets(
  client: PoolClient,
  payload: FixedDocumentPublishPayload,
  mode: "submit" | "execute" | "read",
  approvalRequestId?: string,
): Promise<FixedDocumentTarget[]> {
  const targets: FixedDocumentTarget[] = [];
  for (const item of payload.items) {
    if (isLegalKind(item.kind)) {
      // 写入函数（submit / seal）自己取 FOR UPDATE 并重核修订号与状态。
      const draft = await readLegalDocumentById(client, item.draftVersionId);
      if (!draft) { if (mode === "read") continue; throw notFound(); }
      if (draft.docType !== item.kind) throw conflict("固定文书类型与草稿不一致");
      if (draft.digest !== item.digest) throw conflict("固定文书摘要已变化，请重新提交");
      if (item.kind === "EARLY_SETTLEMENT" ? draft.bodyFormat !== "text" : draft.bodyFormat !== "plate") {
        throw conflict(item.kind === "EARLY_SETTLEMENT" ? "提前结算告知只能是纯文本" : "平台法律文书新版本只能使用 Plate 排版");
      }
      if (mode === "submit" && draft.status !== "DRAFT") throw conflict("固定文书草稿已提交或已封存");
      if (mode === "execute" && (draft.status !== "PENDING" || draft.approvalRequestId !== approvalRequestId)) throw conflict("固定文书草稿不在本申请的待审批状态");
      const current = await readCurrentLegalDocument(client, item.kind);
      if ((current?.id ?? null) !== item.baseVersionId) throw conflict("线上版本已变化，请重新提交固定文书发布");
      targets.push({ kind: item.kind, key: item.key, draft, current });
      continue;
    }
    const resource = await loadResourceItem(client, item.key, mode !== "read");
    if (!resource || resource.type !== "RESOURCE") { if (mode === "read") continue; throw notFound(); }
    const draft = await loadContentVersion(client, item.draftVersionId, mode !== "read");
    if (!draft || draft.itemId !== resource.id) { if (mode === "read") continue; throw notFound(); }
    const document = noticeDocument(draft);
    if (await plateDigest(document) !== item.digest) throw conflict("场景说明摘要已变化，请重新提交");
    if (mode !== "read" && draft.state !== "DRAFT") throw conflict("场景说明草稿已发布或已撤回");
    const current = (await client.query<NoticeVersion>(
      `SELECT ${NOTICE_VERSION_FIELDS} FROM "zzsh_content"."content_version" v WHERE v."item_id" = $1 AND v."state" = 'PUBLISHED'`, [resource.id],
    )).rows[0] ?? null;
    if ((current?.id ?? null) !== item.baseVersionId) throw conflict("线上版本已变化，请重新提交固定文书发布");
    targets.push({ kind: "NOTICE", key: item.key, item: resource, draft, current, document });
  }
  await assertPlatformPairRule(client, payload, mode);
  return targets;
}

/**
 * 任何时刻不允许只有一份当前版本：缺哪份，本次申请就必须带上哪份。
 * 两份都没有当前版本时，只含其中一份的申请提交即被拒。
 */
async function assertPlatformPairRule(client: PoolClient, payload: FixedDocumentPublishPayload, mode: "submit" | "execute" | "read"): Promise<void> {
  if (mode === "read") return;
  const current = await readCurrentPlatformDocuments(client);
  const missing = ([["PLATFORM_TERMS", current.terms], ["PLATFORM_PRIVACY", current.privacy]] as const)
    .filter(([, version]) => !version).map(([docType]) => docType);
  if (missing.length === 0) return;
  const submitted = new Set(payload.items.map(item => item.kind));
  const absent = missing.filter(docType => !submitted.has(docType));
  if (absent.length) {
    throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT,
      `平台服务协议与隐私政策必须同时首次生效；本次缺少${absent.map(docType => docType === "PLATFORM_TERMS" ? "平台服务协议" : "隐私政策").join("与")}`);
  }
}

export type FixedDocumentSubmission = { approvalRequestId: string; items: FixedDocumentPublishItem[]; payloadHash: string };

/**
 * 提交发布审批：同一事务内重核冻结事实、创建真实审批申请、把法律文书草稿置 PENDING。
 * 不写任何决定或执行回执；批准由审批中心决定事务里的执行器完成。
 */
export async function submitFixedDocumentPublish(
  client: PoolClient,
  actor: { id: string; sessionId: string },
  input: { payload: unknown; reason: string },
  requestId: string,
): Promise<FixedDocumentSubmission> {
  const payload = parseFixedDocumentPublishPayload(input.payload);
  const reason = typeof input.reason === "string" ? input.reason.trim() : "";
  if (reason.length < 3 || reason.length > 500) throw invalid("发布理由需 3 到 500 字", "reason");
  const targets = await loadFixedDocumentTargets(client, payload, "submit");
  const hashed = hashApprovalPayload(payload as unknown as Record<string, unknown>);
  const template = (await client.query<{ id: string; version: number }>(
    `SELECT "id", "version" FROM "zzsh_iam"."approval_template" WHERE "operation_code" = $1 AND "trigger_condition" = $2 FOR UPDATE`,
    [FIXED_DOCUMENT_PUBLISH_OPERATION, FIXED_DOCUMENT_PUBLISH_TRIGGER],
  )).rows[0];
  if (!template) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Approval template not found");
  const approvalRequestId = `approval_req_${randomUUID().replaceAll("-", "")}`;
  await client.query(
    `INSERT INTO "zzsh_iam"."approval_request"
      ("id", "template_id", "template_version", "operation_code", "trigger_condition", "payload_version", "operation_payload",
       "operation_payload_hash", "summary", "requested_by", "status", "expires_at")
     VALUES ($1, $2, $3, $4, $5, 1, $6::jsonb, $7, $8, $9, 'PENDING', 'infinity'::timestamptz)`,
    [approvalRequestId, template.id, template.version, FIXED_DOCUMENT_PUBLISH_OPERATION, FIXED_DOCUMENT_PUBLISH_TRIGGER,
      hashed.raw, hashed.hash, reason.slice(0, 240), actor.id],
  );
  for (const target of targets) {
    if (target.kind === "NOTICE") continue;
    const pending = await submitLegalDocument(client, target.draft.id, target.draft.revision, approvalRequestId);
    await recordAudit(client, {
      actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "legal.document.submit",
      objectType: "legal_document_version", objectId: pending.id, outcome: "SUCCESS", requestId,
      details: { approvalRequestId, docType: pending.docType, digest: pending.digest, baseVersionId: target.current?.id ?? null },
    });
  }
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "approval.request.created",
    objectType: "approval_request", objectId: approvalRequestId, outcome: "SUCCESS", requestId,
    details: {
      operationCode: FIXED_DOCUMENT_PUBLISH_OPERATION, triggerCondition: FIXED_DOCUMENT_PUBLISH_TRIGGER,
      payloadVersion: 1, operationPayloadHash: hashed.hash, templateVersion: template.version, summary: reason.slice(0, 240),
      items: payload.items,
    },
  });
  return { approvalRequestId, items: payload.items, payloadHash: hashed.hash };
}

/**
 * 审批决定事务内的执行器：逐项重核 → 法律文书同批同一 effective_at 封存 →
 * 场景说明发布 → 审计 FIXED_DOC_EFFECTIVE。任一步抛错整笔回滚，申请保持待审批。
 */
export const executeFixedDocumentPublish: ApprovalOperationExecutor = async (client, input, actor, requestId) => {
  const payload = parseFixedDocumentPublishPayload(input.operationPayload);
  const targets = await loadFixedDocumentTargets(client, payload, "execute", input.requestId);
  if (targets.length !== payload.items.length) throw conflict("固定文书草稿已不可读，请重新提交");
  const effectiveAt = (await client.query<{ at: Date }>("SELECT clock_timestamp() AS at")).rows[0]!.at;
  for (const target of targets) {
    if (target.kind === "NOTICE") {
      await publishContentVersion(client, actor.userId, target.item.id, target.draft.id, target.item.revision);
      continue;
    }
    await sealLegalDocumentByApproval(client, actor.userId, target.draft.id, input.requestId, effectiveAt);
  }
  await recordAudit(client, {
    actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId, action: FIXED_DOC_EFFECTIVE,
    objectType: "fixed_document_publish", objectId: input.requestId, outcome: "SUCCESS", requestId,
    reason: "固定文书发布已生效",
    details: {
      operationCode: FIXED_DOCUMENT_PUBLISH_OPERATION, effectiveAt: effectiveAt.toISOString(),
      items: payload.items, sealedVersionIds: targets.map(target => target.draft.id),
    },
  });
  return { resultCode: FIXED_DOC_EFFECTIVE, resultDetail: effectiveAt.toISOString() };
};