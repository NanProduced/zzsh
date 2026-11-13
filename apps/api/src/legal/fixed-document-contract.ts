import { ensureOnlyFields, invalid } from "../supply/supply-util";
import { FIXED_DOC_TYPES, type FixedDocType } from "./legal-documents";

/**
 * 固定文书发布的冻结载荷合同与纯函数工具。
 * 这里是无审批依赖的叶子模块：审批登记（approval-business）与执行器
 * （fixed-document-publish）共用同一份常量，避免模块环把登记值变成 undefined。
 */
export const FIXED_DOCUMENT_PUBLISH_OPERATION = "content.fixed_document.publish";
export const FIXED_DOCUMENT_PUBLISH_TRIGGER = "content.fixed_document.publish.requested";
export const FIXED_DOCUMENT_SUBMIT_PERMISSION = "content.fixed.submit";
export const FIXED_DOCUMENT_PUBLISH_PERMISSION = "content.fixed.publish";
export const FIXED_DOC_EFFECTIVE = "FIXED_DOC_EFFECTIVE";
export const FIXED_DOCUMENT_PAYLOAD_SCHEMA = "content-fixed-document-publish.v1";

export const FIXED_DOCUMENT_KINDS = [...FIXED_DOC_TYPES, "NOTICE"] as const;
export type FixedDocumentKind = (typeof FIXED_DOCUMENT_KINDS)[number];

export type FixedDocumentPublishItem = {
  kind: FixedDocumentKind;
  key: string;
  draftVersionId: string;
  digest: string;
  baseVersionId: string | null;
};
export type FixedDocumentPublishPayload = { items: FixedDocumentPublishItem[] };

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const RESOURCE_KEY = /^[a-z][a-z0-9._:-]{0,120}$/i;
const MAX_ITEMS = 10;

export function isLegalKind(kind: FixedDocumentKind): kind is FixedDocType {
  return kind !== "NOTICE";
}

/** 冻结载荷合同：只接受 items，逐项 kind/key/draftVersionId/digest/baseVersionId。 */
export function parseFixedDocumentPublishPayload(value: unknown): FixedDocumentPublishPayload {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("Fixed document payload is invalid", "payload");
  const record = value as Record<string, unknown>;
  ensureOnlyFields(record, ["items"]);
  if (!Array.isArray(record.items) || record.items.length < 1 || record.items.length > MAX_ITEMS) throw invalid("Fixed document payload is invalid", "items");
  const items: FixedDocumentPublishItem[] = [];
  const seen = new Set<string>();
  for (const [index, entry] of record.items.entries()) {
    const path = `items[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid("Fixed document item is invalid", path);
    const item = entry as Record<string, unknown>;
    ensureOnlyFields(item, ["kind", "key", "draftVersionId", "digest", "baseVersionId"]);
    const kind = item.kind;
    if (typeof kind !== "string" || !(FIXED_DOCUMENT_KINDS as readonly string[]).includes(kind)) throw invalid("Fixed document kind is invalid", `${path}.kind`);
    const key = item.key;
    if (typeof key !== "string" || !RESOURCE_KEY.test(key)) throw invalid("Fixed document key is invalid", `${path}.key`);
    if (kind === "NOTICE" ? !key.startsWith("placement:") : key !== kind) throw invalid("Fixed document key is invalid", `${path}.key`);
    if (typeof item.draftVersionId !== "string" || !ID.test(item.draftVersionId)) throw invalid("Fixed document draft version is invalid", `${path}.draftVersionId`);
    if (typeof item.digest !== "string" || !DIGEST.test(item.digest)) throw invalid("Fixed document digest is invalid", `${path}.digest`);
    if (item.baseVersionId !== null && (typeof item.baseVersionId !== "string" || !ID.test(item.baseVersionId))) throw invalid("Fixed document base version is invalid", `${path}.baseVersionId`);
    const identity = `${kind}:${key}`;
    if (seen.has(identity)) throw invalid("Fixed document item is duplicated", `${path}.kind`);
    seen.add(identity);
    items.push({ kind: kind as FixedDocumentKind, key, draftVersionId: item.draftVersionId, digest: item.digest, baseVersionId: item.baseVersionId as string | null });
  }
  return { items };
}

export type FixedDocumentBlockChange = { status: "ADDED" | "REMOVED" | "CHANGED" | "UNCHANGED"; before: string | null; after: string | null };

export { diffDocumentBlocks } from "@zzsh/content/legal-diff";

export function blockChangeCounts(changes: readonly FixedDocumentBlockChange[]): { added: number; removed: number; changed: number; unchanged: number } {
  return {
    added: changes.filter(change => change.status === "ADDED").length,
    removed: changes.filter(change => change.status === "REMOVED").length,
    changed: changes.filter(change => change.status === "CHANGED").length,
    unchanged: changes.filter(change => change.status === "UNCHANGED").length,
  };
}