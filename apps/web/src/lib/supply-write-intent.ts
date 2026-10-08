// Supply-specific version of the reviewed subject-bound trade intent pattern.
// One unresolved operation per subject/tab: no TTL deletes a write responsibility.
export type SupplyWriteAction = "create-account" | "create-draft" | "save-draft" | "quote" | "accept-rules" | "submit" | "media";
export type SupplyWriteReceipt = { accountId: string; revision?: string; versionId?: string; assetId?: string; purpose?: string; reviewState?: string };
export type SupplyWriteIntent = {
  version: 1; userId: string; gameId: string; accountId: string | null;
  action: SupplyWriteAction; key: string; body: Record<string, unknown>;
  phase: "pending" | "accepted"; uncertain?: boolean; receipt?: SupplyWriteReceipt; createdAt: string;
};
const PREFIX = "zzsh.supply-write.v1:";
export class SupplyIntentStorageError extends Error {
  constructor() { super("无法保留本次操作记录，暂不能提交；请保持页面并重试。"); }
}
function storage(): Storage {
  try { if (typeof window !== "undefined") return window.sessionStorage; } catch { /* unavailable */ }
  throw new SupplyIntentStorageError();
}
function serializable(value: unknown): void {
  if (value === null || ["string", "boolean"].includes(typeof value)) return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (Array.isArray(value)) { value.forEach(serializable); return; }
  if (typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype) {
    for (const [key, child] of Object.entries(value)) {
      if (/password|uploadToken|authorization|accessToken|secret(?!_kd)/i.test(key)) throw new SupplyIntentStorageError();
      serializable(child);
    }
    return;
  }
  throw new SupplyIntentStorageError();
}
export function loadSupplyIntent(userId: string): SupplyWriteIntent | null {
  try {
    const raw = storage().getItem(PREFIX + userId);
    if (!raw) return null;
    const value = JSON.parse(raw) as SupplyWriteIntent;
    if (value.version !== 1 || value.userId !== userId || typeof value.gameId !== "string" || !value.gameId || typeof value.key !== "string" || !value.key ||
      !(value.accountId === null || typeof value.accountId === "string" && value.accountId.length > 0) || !value.body || typeof value.body !== "object" || Array.isArray(value.body) ||
      (value.phase === "accepted" && (!value.receipt || typeof value.receipt.accountId !== "string" || !value.receipt.accountId)) ||
      !["create-account", "create-draft", "save-draft", "quote", "accept-rules", "submit", "media"].includes(value.action) ||
      !["pending", "accepted"].includes(value.phase) || !Number.isFinite(Date.parse(value.createdAt))) throw new SupplyIntentStorageError();
    serializable(value.body);
    return value;
  } catch { throw new SupplyIntentStorageError(); }
}
function write(value: SupplyWriteIntent): SupplyWriteIntent {
  try {
    const text = JSON.stringify(value), target = storage();
    target.setItem(PREFIX + value.userId, text);
    if (target.getItem(PREFIX + value.userId) !== text) throw new SupplyIntentStorageError();
    return value;
  } catch { throw new SupplyIntentStorageError(); }
}
export function sameSupplyIntent(left: SupplyWriteIntent | null | undefined, right: SupplyWriteIntent): boolean {
  return Boolean(left && left.userId === right.userId && left.gameId === right.gameId && left.accountId === right.accountId &&
    left.action === right.action && left.key === right.key && left.createdAt === right.createdAt && JSON.stringify(left.body) === JSON.stringify(right.body));
}
function matchingStoredIntent(intent: SupplyWriteIntent): SupplyWriteIntent {
  const current = loadSupplyIntent(intent.userId);
  if (!current || !sameSupplyIntent(current, intent)) throw new SupplyIntentStorageError();
  return current;
}
export function prepareSupplyIntent(input: Omit<SupplyWriteIntent, "version" | "phase" | "createdAt" | "receipt">): SupplyWriteIntent {
  serializable(input.body);
  const prior = loadSupplyIntent(input.userId);
  if (prior) {
    if (prior.phase !== "pending" || prior.gameId !== input.gameId || prior.accountId !== input.accountId || prior.action !== input.action || prior.key !== input.key || JSON.stringify(prior.body) !== JSON.stringify(input.body))
      throw new Error("已有待确认操作，请先恢复原请求结果。");
    return prior;
  }
  return write({ ...input, version: 1, phase: "pending", createdAt: new Date().toISOString(), body: JSON.parse(JSON.stringify(input.body)) });
}
export function acceptSupplyIntent(intent: SupplyWriteIntent, receipt: SupplyWriteReceipt): SupplyWriteIntent {
  const current = matchingStoredIntent(intent);
  return current.phase === "accepted" ? current : write({ ...current, phase: "accepted", receipt });
}
export function retainUncertainSupplyIntent(intent: SupplyWriteIntent): SupplyWriteIntent {
  const current = matchingStoredIntent(intent);
  return current.phase === "accepted" ? current : write({ ...current, uncertain: true });
}
export function clearSupplyIntent(intent: SupplyWriteIntent): boolean {
  try {
    const current = loadSupplyIntent(intent.userId);
    if (!current || !sameSupplyIntent(current, intent)) return false;
    const target = storage(); target.removeItem(PREFIX + intent.userId);
    if (target.getItem(PREFIX + intent.userId) !== null) throw new SupplyIntentStorageError();
    return true;
  } catch { throw new SupplyIntentStorageError(); }
}
