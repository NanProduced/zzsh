import { useEffect, useRef, useState } from "react";
import { AdminApiError, adminRequest, friendlyError, type RulesResponse } from "../../api";
import { SupplyWriteLockError, withSupplyWriteLock } from "../../lib/supply-write-lock";

type RuleKind = "price" | "term" | "agreement";
type Receipt = { id?: string; releaseId?: string; revision?: string; generation?: string; affectedCount?: number };
type Command = { operation: string; resourceId?: string; gameId: string; path: string; method: "POST" | "PUT"; body: Record<string, unknown> };
export type PendingRulesWrite = Command & { schema: 1; adminId: string; key: string; fingerprint: string; receipt?: Receipt };
export type RulesWriteState = { kind: "idle" | "busy" | "recovering" | "conflict" | "unknown" | "accepted" | "blocked" | "error" | "not_sent"; message?: string } | { kind: "done"; receipt: Receipt; operation: string; message?: never };
export const RULES_RELEASE_OPERATION = "supply.rules.release.activate";
export const rulesStorageKey = (adminId: string) => `zzsh.admin.rules.pending.v1:${adminId}`;

export const draftCommand = (gameId: string, kind: RuleKind, action: "create" | "update" | "seal", body: Record<string, unknown>, id?: string): Command => ({
  gameId, operation: `supply.rules.${kind}_draft.${action}`, ...(id ? { resourceId: id } : {}),
  path: `/supply/${kind}-drafts${id ? `/${encodeURIComponent(id)}` : ""}${action === "seal" ? "/seal" : ""}`, method: action === "update" ? "PUT" : "POST", body,
});

function receiptOf(value: unknown, operation: string, resourceId?: string): Receipt | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const r = value as Receipt, isRelease = operation === RULES_RELEASE_OPERATION;
  if (isRelease ? typeof r.releaseId !== "string" || !r.releaseId || typeof r.generation !== "string" || !/^[1-9]\d*$/.test(r.generation) : typeof r.id !== "string" || !r.id) return null;
  if (!isRelease && resourceId !== undefined && r.id !== resourceId) return null;
  if (r.affectedCount !== undefined && (!Number.isSafeInteger(r.affectedCount) || r.affectedCount < 0)) return null;
  return { ...(r.id ? { id: r.id } : {}), ...(r.releaseId ? { releaseId: r.releaseId } : {}), ...(r.generation ? { generation: r.generation } : {}), ...(typeof r.revision === "string" ? { revision: r.revision } : {}), ...(r.affectedCount === undefined ? {} : { affectedCount: r.affectedCount }) };
}

/** Saved intents are a lock, never a substitute for server authorization or an instruction to replay. */
export function parsePendingRulesWrite(raw: string | null, adminId: string): PendingRulesWrite | null {
  if (!raw) return null;
  if (raw.length > 512_000) throw new Error("规则请求恢复记录超出可用范围，请联系维护者核对原回执。");
  const value: unknown = JSON.parse(raw);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("规则请求恢复记录损坏，请联系维护者核对原回执。");
  const p = value as PendingRulesWrite;
  const id = (v: unknown) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(v);
  const match = /^supply\.rules\.(price|term|agreement)_draft\.(create|update|seal)$/.exec(p.operation);
  const expected = match ? draftCommand(p.gameId, match[1] as RuleKind, match[2] as "create" | "update" | "seal", {}, p.resourceId) : { path: "/supply/releases", method: "POST" };
  if (p.schema !== 1 || p.adminId !== adminId || !id(p.gameId) || !/^idem_[A-Za-z0-9_-]+$/.test(p.key) || !/^[0-9a-f]{64}$/.test(p.fingerprint)
    || (!match && p.operation !== RULES_RELEASE_OPERATION) || p.path !== expected.path || p.method !== expected.method
    || (p.resourceId !== undefined && !id(p.resourceId)) || (match?.[2] === "create" ? p.resourceId !== undefined : !id(p.resourceId))
    || !p.body || typeof p.body !== "object" || Array.isArray(p.body) || (p.receipt !== undefined && !receiptOf(p.receipt, p.operation, p.resourceId))
    || (p.operation === RULES_RELEASE_OPERATION && (p.resourceId !== p.gameId || p.body.gameId !== p.gameId || Object.keys(p.body).sort().join() !== ["agreementVersionId", "expectedGeneration", "gameId", "priceVersionId", "termVersionId"].join() || ![p.body.priceVersionId, p.body.termVersionId, p.body.agreementVersionId].every(id) || typeof p.body.expectedGeneration !== "string" || !/^(0|[1-9]\d{0,19})$/.test(p.body.expectedGeneration)))
    || (match?.[2] === "create" && p.body.gameId !== p.gameId)) throw new Error("规则请求恢复记录无法识别，请联系维护者核对原回执。");
  return p;
}

export async function rulesFingerprint(operation: string, resourceId: string | undefined, body: Record<string, unknown>): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify([operation, resourceId ?? null, body]));
  return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))).map(value => value.toString(16).padStart(2, "0")).join("");
}

function readbackContains(fresh: RulesResponse, original: PendingRulesWrite, receipt: Receipt): boolean {
  if (original.operation === RULES_RELEASE_OPERATION) {
    if (!fresh.release || !/^[1-9]\d*$/.test(fresh.release.generation)) return false;
    const current = BigInt(fresh.release.generation), accepted = BigInt(receipt.generation!);
    return current > accepted || (current === accepted && fresh.release.id === receipt.releaseId && fresh.release.priceVersionId === original.body.priceVersionId && fresh.release.termVersionId === original.body.termVersionId && fresh.release.agreementVersionId === original.body.agreementVersionId);
  }
  const match = /^supply\.rules\.(price|term|agreement)_draft\.(create|update|seal)$/.exec(original.operation)!;
  const versions = match[1] === "price" ? fresh.priceVersions : match[1] === "term" ? fresh.termVersions : fresh.agreementVersions;
  const version = versions.find(version => version.id === receipt.id);
  if (!version) return false;
  if (match[2] === "create") return true;
  if (match[2] === "seal") return version.status === "SEALED";
  return /^\d+$/.test(version.revision) && typeof original.body.expectedRevision === "string" && /^\d+$/.test(original.body.expectedRevision) && BigInt(version.revision) > BigInt(original.body.expectedRevision);
}

export function useRulesWrite(adminId: string, gameId: string, onReload: () => Promise<RulesResponse | undefined>, sessionId: string) {
  const [pending, setPending] = useState<PendingRulesWrite | null>(null);
  const [state, setState] = useState<RulesWriteState>({ kind: "idle" });
  const busy = useRef(false), writeSeq = useRef(0), alive = useRef(true), actor = useRef(adminId), scope = useRef(gameId), session = useRef(sessionId);
  actor.current = adminId; scope.current = gameId; session.current = sessionId;
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  useEffect(() => { ++writeSeq.current; busy.current = false; }, [adminId, gameId, sessionId]);
  useEffect(() => {
    const read = () => {
      try {
        const original = parsePendingRulesWrite(window.localStorage.getItem(rulesStorageKey(adminId)), adminId);
        setPending(original); setState(original ? { kind: original.receipt ? "accepted" : "unknown" } : { kind: "idle" });
      } catch { setPending(null); setState({ kind: "blocked", message: "无法读取规则请求恢复记录，已暂停新的写入。请联系维护者核对原结果。" }); }
    };
    read();
    const storage = (event: StorageEvent) => { if (event.key === rulesStorageKey(adminId)) read(); };
    window.addEventListener("storage", storage); return () => window.removeEventListener("storage", storage);
  }, [adminId, sessionId]);
  const current = () => alive.current && actor.current === adminId && scope.current === gameId && session.current === sessionId;
  const active = (sequence: number) => current() && sequence === writeSeq.current;
  const save = (record: PendingRulesWrite, sequence: number) => { window.localStorage.setItem(rulesStorageKey(adminId), JSON.stringify(record)); if (active(sequence)) setPending(record); };
  const clear = (original: PendingRulesWrite) => {
    const cached = parsePendingRulesWrite(window.localStorage.getItem(rulesStorageKey(adminId)), adminId);
    if (cached && cached.key !== original.key) throw new Error("恢复记录已变化，不能清理另一条请求");
    window.localStorage.removeItem(rulesStorageKey(adminId));
  };
  const settle = async (original: PendingRulesWrite, receipt: Receipt, sequence: number) => {
    try { save({ ...original, receipt }, sequence); }
    catch { if (active(sequence)) { setPending({ ...original, receipt }); setState({ kind: "accepted", message: "已收到写入回执，但恢复记录保存失败。请核对原结果，不能重新提交。" }); } return; }
    if (!active(sequence)) return;
    setState({ kind: "accepted", message: "已收到写入回执，正在重新读取规则。" });
    try {
      const fresh = await onReload();
      if (!active(sequence)) return;
      if (!fresh || fresh.game.id !== original.gameId || !readbackContains(fresh, original, receipt)) throw new Error("readback unavailable");
      clear(original); setPending(null); setState({ kind: "done", receipt, operation: original.operation });
      return { receipt, fresh };
    } catch { if (active(sequence)) setState({ kind: "accepted", message: "已收到写入回执，但规则回读失败。只能核对原结果，不能再次提交。" }); }
  };
  const write = async (command: Command) => {
    if (busy.current || pending || state.kind === "blocked" || !adminId || command.gameId !== gameId) return;
    const sequence = ++writeSeq.current;
    busy.current = true; setState({ kind: "busy" });
    try {
      return await withSupplyWriteLock(rulesStorageKey(adminId), async () => {
        if (!active(sequence)) return;
        let original: PendingRulesWrite | undefined, sent = false;
        try {
          const stored = parsePendingRulesWrite(window.localStorage.getItem(rulesStorageKey(adminId)), adminId);
          if (stored) { setPending(stored); setState({ kind: stored.receipt ? "accepted" : "unknown" }); return; }
          original = { ...command, schema: 1, adminId, key: `idem_${crypto.randomUUID().replaceAll("-", "")}`, fingerprint: await rulesFingerprint(command.operation, command.resourceId, command.body) };
          if (!active(sequence)) return;
          save(original, sequence); setState({ kind: "busy" }); sent = true;
          const result = await adminRequest<unknown>(command.path, command.body, command.method, { "idempotency-key": original.key });
          const receipt = receiptOf(result, command.operation, command.resourceId);
          if (!receipt) { if (active(sequence)) setState({ kind: "unknown", message: "写入回执不完整，原结果尚未核清。" }); return; }
          return await settle(original, receipt, sequence);
        } catch (failure) {
          if (sent && original && failure instanceof AdminApiError && failure.status >= 400 && failure.status < 500) {
            try { clear(original); if (active(sequence)) { setPending(null); setState(failure.status === 409 ? { kind: "conflict" } : { kind: "error", message: friendlyError(failure) }); } }
            catch { if (active(sequence)) setState({ kind: "blocked", message: "请求已被明确拒绝，但恢复记录已变化或清理失败，已暂停新的写入。" }); }
            return;
          }
          if (!active(sequence)) return;
          if (!sent || !original) { setState({ kind: "blocked", message: "无法保存原请求恢复记录，未发送写入命令。" }); return; }
          setState({ kind: "unknown", message: "请求可能已执行；网络异常或服务端错误不能证明写入失败。" });
        }
      });
    } catch (failure) {
      if (active(sequence)) setState({ kind: failure instanceof SupplyWriteLockError && failure.code === "LOCK_BUSY" ? "not_sent" : "blocked", message: `${failure instanceof SupplyWriteLockError ? failure.message : "无法取得供给写入锁。"} 本次未发送写入命令。` });
    } finally { if (sequence === writeSeq.current) busy.current = false; }
  };
  const recover = async () => {
    if (!pending || busy.current || pending.gameId !== gameId) return;
    const sequence = ++writeSeq.current;
    busy.current = true; setState({ kind: "recovering" });
    try {
      return await withSupplyWriteLock(rulesStorageKey(adminId), async () => {
        if (!active(sequence)) return;
        let original = pending;
        try {
          const stored = parsePendingRulesWrite(window.localStorage.getItem(rulesStorageKey(adminId)), adminId);
          if (stored && stored.key !== pending.key) { if (active(sequence)) { setPending(stored); setState({ kind: stored.receipt ? "accepted" : "unknown", message: "恢复记录已由另一窗口更新，请核对该原请求。" }); } return; }
          original = stored ?? pending;
          if (await rulesFingerprint(original.operation, original.resourceId, original.body) !== original.fingerprint) { if (active(sequence)) setState({ kind: "blocked", message: "本地原请求与指纹不一致，已暂停恢复查询和新写入；请联系维护者核对原命令。" }); return; }
          if (!active(sequence)) return;
          const query = new URLSearchParams({ operation: original.operation, fingerprint: original.fingerprint, ...(original.resourceId ? { resourceId: original.resourceId } : {}) });
          const result = await adminRequest<{ receipt: string; responseStatus?: number; operation?: string; resourceId?: string | null; result?: unknown }>(`/supply/operation-result?${query}`, undefined, "GET", { "idempotency-key": original.key });
          if (!active(sequence)) return;
          if (result.receipt !== "RECORDED") { setState({ kind: original.receipt ? "accepted" : "unknown", message: "暂未查到原回执，不代表请求未执行；继续保留原请求并禁止重发。" }); return; }
          const receipt = receiptOf(result.result, original.operation, original.resourceId);
          if (!receipt || result.responseStatus !== 200 || result.operation !== original.operation || result.resourceId !== (original.resourceId ?? null)) { setState({ kind: original.receipt ? "accepted" : "unknown", message: "原回执未提供匹配的完整写入结果，请联系维护者核对。" }); return; }
          return await settle(original, receipt, sequence);
        } catch (failure) { if (active(sequence)) setState({ kind: original.receipt ? "accepted" : "unknown", message: `原结果核对未完成：${friendlyError(failure)}` }); }
      });
    } catch (failure) { if (active(sequence)) setState({ kind: failure instanceof SupplyWriteLockError && failure.code === "LOCK_BUSY" ? "not_sent" : "blocked", message: `${failure instanceof SupplyWriteLockError ? failure.message : "无法取得供给写入锁。"} 本次未发送恢复查询。` }); }
    finally { if (sequence === writeSeq.current) busy.current = false; }
  };
  const locked = Boolean(pending) || ["blocked", "busy", "recovering"].includes(state.kind);
  useEffect(() => { if (!locked) return; const stop = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; }; window.addEventListener("beforeunload", stop); return () => window.removeEventListener("beforeunload", stop); }, [locked]);
  const dismissResult = () => { if (!pending && !busy.current && state.kind === "done") setState({ kind: "idle" }); };
  return { pending, state, write, recover, locked, dismissResult };
}
