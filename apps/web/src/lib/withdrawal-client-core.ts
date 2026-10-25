export type WithdrawalResource = "withdrawal-bank-binding" | "channel-withdrawals" | "withdrawal-history";
export const WITHDRAWAL_SUBJECT_HEADER = "x-zzsh-expected-user-id";
export class WithdrawalRequestError extends Error {
  readonly status: number; readonly code: string; readonly requestId?: string; readonly uncertain: boolean;
  constructor(status: number, code: string, requestId?: string, uncertain = false) {
    super(code === "RECOVERY_STORAGE_UNAVAILABLE" ? "无法保存恢复信息，请保持页面并稍后重试。" : code === "PENDING_REQUEST_EXISTS" ? "请先查询原申请结果。" : code === "IDENTITY_CHANGED" ? "登录身份已变化，请重新进入页面。" : code === "BANK_BINDING_CURRENT_READ_UNAVAILABLE" ? "资料已保存，当前资料暂时无法读取，请刷新查看。" : "操作暂时无法完成，请稍后重试。");
    this.name = "WithdrawalRequestError";
    this.status = status; this.code = code; this.requestId = requestId; this.uncertain = uncertain;
  }
}
export const badWithdrawal = () => new WithdrawalRequestError(502, "WITHDRAWAL_CONTRACT_REQUIRED");
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw badWithdrawal();
  return value as Record<string, unknown>;
}
export function text(value: unknown, max = 512): string {
  if (typeof value !== "string" || !value || value.length > max || /[\u0000-\u001f]/.test(value)) throw badWithdrawal();
  return value;
}
export function id(value: unknown): string {
  const v = text(value, 180);
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(v)) throw badWithdrawal();
  return v;
}
export function cents(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d{0,23})$/.test(value)) throw badWithdrawal();
  return value;
}
export function revision(value: unknown): string { const v = cents(value); if (BigInt(v) > 9223372036854775807n) throw badWithdrawal(); return v; }
export function time(value: unknown): string {
  const v = text(value, 40);
  if (!/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d(?::?\d\d)?)$/.test(v)) throw badWithdrawal();
  const normalized = v.replace(" ", "T").replace(/([+-]\d\d)$/, "$1:00");
  if (!Number.isFinite(Date.parse(normalized))) throw badWithdrawal();
  return v;
}
export const nullableText = (v: unknown, max = 512) => v === null ? null : text(v, max);
export function strings(value: unknown): string[] { if (!Array.isArray(value) || value.length > 100) throw badWithdrawal(); return value.map(x => text(x, 160)); }
export function key(value: unknown): string { const v = text(value, 128); if (!/^[A-Za-z0-9._:-]+$/.test(v)) throw badWithdrawal(); return v; }
export function assertCurrent(current: () => boolean, signal?: AbortSignal) {
  if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (!current()) throw new WithdrawalRequestError(401, "IDENTITY_CHANGED");
}
export function recoveryStorage(): Storage {
  try { if (typeof window !== "undefined") return window.localStorage; } catch { /* Block writes without a durable recovery marker. */ }
  throw new WithdrawalRequestError(0, "RECOVERY_STORAGE_UNAVAILABLE");
}
export async function underWithdrawalLock<T>(scope: "bank-binding" | "channel-withdrawal", userId: string, run: () => Promise<T>): Promise<T> {
  if (typeof navigator === "undefined" || !navigator.locks) throw new WithdrawalRequestError(409, "WRITE_LOCK_UNAVAILABLE");
  return await navigator.locks.request(`zzsh.${scope}:${id(userId)}`, run);
}
export type WithdrawalWriteOptions = { signal?: AbortSignal; isCurrent?: () => boolean };
export async function withdrawalRequest(resource: WithdrawalResource, path: string, options: { expectedUserId: string; method?: "GET" | "POST"; body?: Record<string, unknown>; key?: string; signal?: AbortSignal }): Promise<unknown> {
  if (!["withdrawal-bank-binding", "channel-withdrawals", "withdrawal-history"].includes(resource) || path && !/^[/?]/.test(path) || path.includes("\\") || path.includes("#")) throw new WithdrawalRequestError(400, "INVALID_ARGUMENT");
  const method = options.method ?? "GET";
  const isCommand = method === "POST" && path === "";
  const headers: Record<string, string> = { [WITHDRAWAL_SUBJECT_HEADER]: id(options.expectedUserId) };
  if (method === "POST") headers["content-type"] = "application/json";
  if (options.key) headers["idempotency-key"] = key(options.key);
  let response: Response;
  try {
    response = await fetch(`/api/account/${resource}${path}`, { method, credentials: "same-origin", cache: "no-store", headers, body: options.body === undefined ? undefined : JSON.stringify(options.body), signal: options.signal });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new WithdrawalRequestError(0, "NETWORK_ERROR", undefined, isCommand);
  }
  const body = await response.json().catch(() => null);
  if (options.signal?.aborted) throw new DOMException("Aborted", "AbortError");
  if (!response.ok) {
    const e = body && typeof body === "object" && !Array.isArray(body) ? (body as { error?: Record<string, unknown> }).error : undefined;
    const code = typeof e?.code === "string" && /^[A-Z][A-Z0-9_]{0,63}$/.test(e.code) ? e.code : "INTERNAL_ERROR";
    const requestId = typeof e?.requestId === "string" && /^[A-Za-z0-9._:-]{1,160}$/.test(e.requestId) ? e.requestId : undefined;
    throw new WithdrawalRequestError(response.status, code, requestId, isCommand && response.status >= 500);
  }
  if (body === null) throw new WithdrawalRequestError(502, "WITHDRAWAL_CONTRACT_REQUIRED", undefined, isCommand);
  return body;
}
