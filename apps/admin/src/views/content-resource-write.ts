import { useEffect, useRef, useState } from "react";
import { validateResourceKey } from "@zzsh/content";
import { AdminApiError, adminRequest, friendlyError } from "../api";
import { withSupplyWriteLock } from "../lib/supply-write-lock";
import { resourcePath, type ContentOperation, type ResourceDetail } from "./content-resources-model";

type Pending = { schema: 1; adminId: string; resourceId: string; operation: ContentOperation; key: string; fingerprint: string; versionId?: string; expectedRevision?: string; gameId?: string; accepted?: boolean };
const operations: ContentOperation[] = ["content.resource.draft.create", "content.resource.draft.save", "content.resource.media-draft.save", "content.resource.draft.restore", "content.resource.publish", "content.resource.withdraw"];
export const contentPendingKey = (adminId: string) => `zzsh.admin.content.pending.v1:${adminId}`;
const pendingChanged = "zzsh:content-pending-changed";
export function parsePendingContent(raw: string | null, adminId: string): Pending | null {
  if (!raw) return null;
  if (raw.length > 4096) throw new Error("内容请求恢复记录过长");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("内容恢复记录损坏");
  const row = value as Pending;
  if (row.schema !== 1 || row.adminId !== adminId || !operations.includes(row.operation) || !/^idem_[A-Za-z0-9_-]{8,100}$/.test(row.key) || !/^[0-9a-f]{64}$/.test(row.fingerprint) || (row.accepted !== undefined && typeof row.accepted !== "boolean")) throw new Error("内容恢复记录无效");
  validateResourceKey(row.resourceId);
  if (row.gameId !== undefined && (typeof row.gameId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.gameId))) throw new Error("内容范围恢复记录无效");
  if (row.versionId !== undefined && (typeof row.versionId !== "string" || !row.versionId || row.versionId.length > 128)) throw new Error("内容版本恢复记录无效");
  if (row.expectedRevision !== undefined && (typeof row.expectedRevision !== "string" || !/^[1-9]\d*$/.test(row.expectedRevision))) throw new Error("内容并发版本恢复记录无效");
  return row;
}
export async function contentFingerprint(operation: ContentOperation, key: string, body: Record<string, unknown>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify([operation, key, body]))))).map(byte => byte.toString(16).padStart(2, "0")).join("");
}
export function contentWriteRequest(key: string, operation: ContentOperation) {
  const suffix = operation === "content.resource.publish" ? "publish" : operation === "content.resource.withdraw" ? "withdraw" : operation === "content.resource.draft.restore" ? "restore" : operation === "content.resource.media-draft.save" ? "media-draft" : "draft";
  return { path: `${resourcePath(key)}/${suffix}`, method: operation === "content.resource.draft.save" || operation === "content.resource.media-draft.save" ? "PUT" : "POST" } as const;
}
function validResult(value: unknown, key: string): value is ResourceDetail {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as ResourceDetail;
  return row.key === key && Boolean(row.item && typeof row.item.id === "string" && /^[1-9]\d*$/.test(row.item.revision)) && Boolean(row.current && row.current.key === key);
}

export function useContentResourceWrite(adminId: string, sessionId: string) {
  const [pending, setPending] = useState<Pending | null>(null), [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>(), [success, setSuccess] = useState<string>(), [blocked, setBlocked] = useState(false);
  const active = useRef({ adminId, sessionId, sequence: 0 }), busyRef = useRef(false), alive = useRef(true);
  active.current.adminId = adminId; active.current.sessionId = sessionId;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => {
    ++active.current.sequence; busyRef.current = false; setBusy(false); setError(undefined); setSuccess(undefined);
    const read = () => { try { setPending(parsePendingContent(localStorage.getItem(contentPendingKey(adminId)), adminId)); setBlocked(false); } catch { setBlocked(true); setError("原请求恢复记录无法读取，已暂停写入；请联系维护者核对。"); } };
    read();
    const listener = (event: StorageEvent) => { if (event.key === contentPendingKey(adminId)) read(); };
    window.addEventListener("storage", listener); window.addEventListener(pendingChanged, read);
    return () => { window.removeEventListener("storage", listener); window.removeEventListener(pendingChanged, read); };
  }, [adminId, sessionId]);
  const current = (sequence: number) => alive.current && active.current.adminId === adminId && active.current.sessionId === sessionId && active.current.sequence === sequence;
  const clear = (record: Pending) => {
    const stored = parsePendingContent(localStorage.getItem(contentPendingKey(adminId)), adminId);
    if (stored && stored.key !== record.key) throw new Error("另一窗口的原请求不能被清除");
    localStorage.removeItem(contentPendingKey(adminId));
    window.dispatchEvent(new Event(pendingChanged));
  };
  const write = async (key: string, operation: ContentOperation, body: Record<string, unknown>): Promise<ResourceDetail | undefined> => {
    if (busyRef.current || pending || blocked) return;
    const sequence = ++active.current.sequence; busyRef.current = true; setBusy(true); setError(undefined); setSuccess(undefined);
    let record: Pending | null = null, sent = false;
    try {
      const bodySnapshot = JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
      return await withSupplyWriteLock(contentPendingKey(adminId), async () => {
        const previous = parsePendingContent(localStorage.getItem(contentPendingKey(adminId)), adminId);
        if (previous) { if (current(sequence)) setPending(previous); return; }
        record = { schema: 1, adminId, resourceId: key, operation, key: `idem_${crypto.randomUUID().replaceAll("-", "")}`, fingerprint: await contentFingerprint(operation, key, bodySnapshot), ...(typeof bodySnapshot.versionId === "string" ? { versionId: bodySnapshot.versionId } : {}), ...(typeof bodySnapshot.expectedRevision === "string" ? { expectedRevision: bodySnapshot.expectedRevision } : {}), ...(typeof bodySnapshot.gameId === "string" ? { gameId: bodySnapshot.gameId } : {}) };
        if (!current(sequence)) return;
        localStorage.setItem(contentPendingKey(adminId), JSON.stringify(record)); setPending(record); window.dispatchEvent(new Event(pendingChanged));
        const request = contentWriteRequest(key, operation);
        sent = true;
        const result = await adminRequest<unknown>(request.path, bodySnapshot, request.method, { "idempotency-key": record.key });
        if (!validResult(result, key)) throw new Error("内容回执不完整");
        clear(record);
        if (current(sequence)) { setPending(null); setSuccess(operation === "content.resource.publish" ? "已发布，用户页面将读取这一版本。" : operation === "content.resource.withdraw" ? "已撤回，用户页面不再读取这一版本。" : operation === "content.resource.draft.restore" ? "历史版本已恢复为新草稿，线上内容保持不变。" : "草稿已保存，线上内容保持不变。"); }
        return current(sequence) ? result : undefined;
      });
    } catch (failure) {
      const rejected = failure instanceof AdminApiError && failure.status >= 400 && failure.status < 500 && failure.code !== "IDEMPOTENCY_KEY_REUSED";
      const conflict = failure instanceof AdminApiError && failure.status === 409 && failure.code !== "IDEMPOTENCY_KEY_REUSED";
      if (record && sent && rejected) {
        try { clear(record); if (current(sequence)) setPending(null); }
        catch { if (current(sequence)) setBlocked(true); }
      }
      if (current(sequence)) setError(record && sent && !rejected
        ? "请求结果尚未确认，原键与指纹已保留。请核对原结果，不能再次提交。"
        : conflict ? "内容已被其他会话更新或替换：当前输入已保留，没有覆盖线上或草稿。请复制修改后重新打开最新内容。" : sent ? friendlyError(failure) : "未发送操作：无法取得内容写入锁或保存恢复记录。");
    } finally { if (current(sequence)) { setBusy(false); busyRef.current = false; } }
  };
  const recover = async (): Promise<ResourceDetail | undefined> => {
    if (!pending || busyRef.current || blocked) return;
    const sequence = ++active.current.sequence; busyRef.current = true; setBusy(true); setError(undefined);
    try {
      return await withSupplyWriteLock(contentPendingKey(adminId), async () => {
        const original = parsePendingContent(localStorage.getItem(contentPendingKey(adminId)), adminId);
        if (!original || original.key !== pending.key) throw new Error("原请求记录已变化");
        const query = new URLSearchParams({ operation: original.operation, resourceId: original.resourceId, fingerprint: original.fingerprint, ...(original.gameId ? { gameId: original.gameId } : {}) });
        const receipt = await adminRequest<{ receipt: string; operation?: string; resourceId?: string; responseStatus?: number; result?: { itemId?: string } }>(`/content/operation-result?${query}`, undefined, "GET", { "idempotency-key": original.key });
        if (receipt.receipt !== "RECORDED") { if (current(sequence)) setError("暂未查到原回执，不代表操作没有发生；原请求继续保留。"); return; }
        if (receipt.operation !== original.operation || receipt.resourceId !== original.resourceId || receipt.responseStatus !== 200 || !receipt.result?.itemId) throw new Error("原回执不匹配");
        localStorage.setItem(contentPendingKey(adminId), JSON.stringify({ ...original, accepted: true }));
        const detail = await adminRequest<unknown>(resourcePath(original.resourceId));
        if (!validResult(detail, original.resourceId) || detail.item?.id !== receipt.result.itemId) throw new Error("当前内容回读失败");
        clear(original);
        if (current(sequence)) { setPending(null); setSuccess("已核实原操作记录，并重新读取当前内容。"); }
        return current(sequence) ? detail : undefined;
      });
    } catch (failure) { if (current(sequence)) setError(`原结果核对未完成：${friendlyError(failure)} 原请求继续保留。`); }
    finally { if (current(sequence)) { setBusy(false); busyRef.current = false; } }
  };
  return { pending, busy, error, success, blocked, locked: busy || Boolean(pending) || blocked, write, recover };
}
