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

const MAX_DIFF_BLOCKS = 400;

function diffBlocks(value: string): string[] {
  return value.split(/\n+/).map(block => block.trim()).filter(block => block.length > 0);
}

/**
 * 按块比对纯文字（LCS）：相邻的删除 + 新增合并为「修改」，其余标新增 / 删除。
 * 只读比较，不改写任何存储正文；超长文档退化为整篇一块，避免平方级开销失控。
 */
export function diffDocumentBlocks(before: string, after: string): FixedDocumentBlockChange[] {
  const left = diffBlocks(before), right = diffBlocks(after);
  if (left.length > MAX_DIFF_BLOCKS || right.length > MAX_DIFF_BLOCKS) {
    return before === after ? [{ status: "UNCHANGED", before, after }] : [{ status: "CHANGED", before, after }];
  }
  const width = right.length + 1;
  const table = new Int32Array((left.length + 1) * width);
  const at = (i: number, j: number): number => table[i * width + j] ?? 0;
  for (let i = left.length - 1; i >= 0; i -= 1) {
    for (let j = right.length - 1; j >= 0; j -= 1) {
      table[i * width + j] = left[i] === right[j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const ops: { type: "EQUAL" | "DELETE" | "INSERT"; text: string }[] = [];
  let i = 0, j = 0;
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) { ops.push({ type: "EQUAL", text: left[i]! }); i += 1; j += 1; }
    else if (at(i + 1, j) >= at(i, j + 1)) { ops.push({ type: "DELETE", text: left[i]! }); i += 1; }
    else { ops.push({ type: "INSERT", text: right[j]! }); j += 1; }
  }
  while (i < left.length) { ops.push({ type: "DELETE", text: left[i]! }); i += 1; }
  while (j < right.length) { ops.push({ type: "INSERT", text: right[j]! }); j += 1; }

  const changes: FixedDocumentBlockChange[] = [];
  for (let index = 0; index < ops.length;) {
    const op = ops[index]!;
    if (op.type === "EQUAL") { changes.push({ status: "UNCHANGED", before: op.text, after: op.text }); index += 1; continue; }
    const removed: string[] = [], added: string[] = [];
    while (index < ops.length && ops[index]!.type !== "EQUAL") {
      const run = ops[index]!;
      if (run.type === "DELETE") removed.push(run.text); else added.push(run.text);
      index += 1;
    }
    for (let pair = 0; pair < Math.max(removed.length, added.length); pair += 1) {
      const oldText = removed[pair], newText = added[pair];
      if (oldText !== undefined && newText !== undefined) changes.push({ status: "CHANGED", before: oldText, after: newText });
      else if (oldText !== undefined) changes.push({ status: "REMOVED", before: oldText, after: null });
      else changes.push({ status: "ADDED", before: null, after: newText! });
    }
  }
  return changes;
}

export function blockChangeCounts(changes: readonly FixedDocumentBlockChange[]): { added: number; removed: number; changed: number; unchanged: number } {
  return {
    added: changes.filter(change => change.status === "ADDED").length,
    removed: changes.filter(change => change.status === "REMOVED").length,
    changed: changes.filter(change => change.status === "CHANGED").length,
    unchanged: changes.filter(change => change.status === "UNCHANGED").length,
  };
}