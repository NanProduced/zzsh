export type CreditEvent = {
  id: string;
  userId: string;
  eventKey: string;
  eventType: "INITIALIZED" | "BREACH_CONFIRMED" | "BREACH_REVERSED" | "RECOVERY_APPROVED";
  sourceType: string;
  sourceId: string;
  subjectRole: "OWNER" | "RENTER" | null;
  deltaScore: number;
  appliedDeltaScore: number;
  scoreBefore: number;
  scoreAfter: number;
  visibleReason: string;
  reversalOfId?: string | null;
  reversed?: boolean;
  createdAt: string;
};

export type CreditGuarantee = {
  accountId: string;
  displayNo: string | null;
  gameId: string;
  versionId: string | null;
  priceVersionId: string;
  releaseId: string;
  baseCents: string | null;
  requiredCents: string;
  score: number | null;
  state: "NOT_REQUIRED" | "REQUIRED" | "PAYMENT_PENDING" | "SATISFIED" | "REFUND_REQUESTED" | "REFUND_PROCESSING" | "REFUNDED" | "FAILED" | "UNKNOWN";
  reference: string | null;
  reasonCode?: string;
  paymentId?: string | null;
  paymentState?: string | null;
  paymentProviderState?: string | null;
  paymentAmountCents?: string | null;
  paymentObservedAmountCents?: string | null;
  paymentFinanceEventId?: string | null;
  paymentLedgerEntryRef?: string | null;
  refundId?: string | null;
  refundState?: string | null;
  refundProviderState?: string | null;
  refundAmountCents?: string | null;
  refundPolicyState?: string | null;
  refundFinanceEventId?: string | null;
  refundLedgerEntryRef?: string | null;
};

export type CreditRecoveryRequest = { id: string; status: "PENDING" | "APPROVED" | "REJECTED"; reason: string; scoreBefore: number; createdAt: string; decidedAt: string | null };
export type CreditPaymentAttempt = Record<string, unknown> & { id: string; requirementId: string; status: string; amountCents: string };
export type CreditRefundAttempt = Record<string, unknown> & { id: string; requirementId: string; paymentId: string; status: string; amountCents: string };
export type CreditTransaction = Record<string, unknown> & { requirementId: string; accountId: string; paymentHistory: CreditPaymentAttempt[]; refundHistory: CreditRefundAttempt[] };
export type CreditOverview = { credit: { userId: string; score: number; revision: string; initializedAt: string; events: CreditEvent[] } | null; recoveryRequests: CreditRecoveryRequest[]; guarantees: CreditGuarantee[]; transactions: CreditTransaction[] };

export class CreditRequestError extends Error {
  constructor(readonly status: number, readonly code: string, readonly unknownResult = false) { super(code); this.name = "CreditRequestError"; }
}

function object(value: unknown): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CreditRequestError(502, "CREDIT_CONTRACT_REQUIRED");
  return value as Record<string, any>;
}
function text(value: unknown, max = 256): string {
  if (typeof value !== "string" || !value || value.length > max) throw new CreditRequestError(502, "CREDIT_CONTRACT_REQUIRED");
  return value;
}
function cents(value: unknown): string {
  const result = text(value, 24);
  if (!/^(0|[1-9]\d{0,23})$/.test(result)) throw new CreditRequestError(502, "CREDIT_CONTRACT_REQUIRED");
  return result;
}
function event(value: unknown): CreditEvent {
  const row = object(value);
  if (!["INITIALIZED", "BREACH_CONFIRMED", "BREACH_REVERSED", "RECOVERY_APPROVED"].includes(row.eventType)) throw new CreditRequestError(502, "CREDIT_CONTRACT_REQUIRED");
  return { id: text(row.id), userId: text(row.userId), eventKey: text(row.eventKey), eventType: row.eventType, sourceType: text(row.sourceType), sourceId: text(row.sourceId), subjectRole: row.subjectRole === null ? null : row.subjectRole, deltaScore: Number(row.deltaScore), appliedDeltaScore: Number(row.appliedDeltaScore), scoreBefore: Number(row.scoreBefore), scoreAfter: Number(row.scoreAfter), visibleReason: text(row.visibleReason, 500), reversalOfId: row.reversalOfId ?? null, reversed: row.reversed === true, createdAt: text(row.createdAt, 40) };
}
function guarantee(value: unknown): CreditGuarantee {
  const row = object(value);
  if (!["NOT_REQUIRED", "REQUIRED", "PAYMENT_PENDING", "SATISFIED", "REFUND_REQUESTED", "REFUND_PROCESSING", "REFUNDED", "FAILED", "UNKNOWN"].includes(row.state)) throw new CreditRequestError(502, "CREDIT_CONTRACT_REQUIRED");
  const optionalText = (value: unknown, max = 256) => value === null || value === undefined ? null : text(value, max);
  return { accountId: text(row.accountId), displayNo: row.displayNo === null ? null : text(row.displayNo), gameId: text(row.gameId), versionId: row.versionId === null ? null : text(row.versionId), priceVersionId: text(row.priceVersionId), releaseId: text(row.releaseId), baseCents: row.baseCents === null ? null : cents(row.baseCents), requiredCents: cents(row.requiredCents), score: row.score === null ? null : Number(row.score), state: row.state, reference: row.reference === null ? null : text(row.reference), reasonCode: row.reasonCode, paymentId: optionalText(row.paymentId), paymentState: optionalText(row.paymentState), paymentProviderState: optionalText(row.paymentProviderState), paymentAmountCents: row.paymentAmountCents === null || row.paymentAmountCents === undefined ? null : cents(row.paymentAmountCents), paymentObservedAmountCents: row.paymentObservedAmountCents === null || row.paymentObservedAmountCents === undefined ? null : cents(row.paymentObservedAmountCents), paymentFinanceEventId: optionalText(row.paymentFinanceEventId), paymentLedgerEntryRef: optionalText(row.paymentLedgerEntryRef), refundId: optionalText(row.refundId), refundState: optionalText(row.refundState), refundProviderState: optionalText(row.refundProviderState), refundAmountCents: row.refundAmountCents === null || row.refundAmountCents === undefined ? null : cents(row.refundAmountCents), refundPolicyState: optionalText(row.refundPolicyState), refundFinanceEventId: optionalText(row.refundFinanceEventId), refundLedgerEntryRef: optionalText(row.refundLedgerEntryRef) };
}
export type CreditWriteIntent = { version: 1; subject: string; path: string; body: Record<string, unknown>; key: string; generation: number; createdAt: number; persisted: boolean; phase: "unknown" | "readback" };
const writeMemory = new Map<string, CreditWriteIntent>();
const writeGenerations = new Map<string, number>();
function writeStorageKey(subject: string) { return `zzsh.credit.write.${encodeURIComponent(subject)}`; }
export function makeCreditWriteIntent(subject: string, path: string, body: Record<string, unknown>): CreditWriteIntent {
  const key = `credit_${(globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random()}`).replaceAll("-", "")}`;
  const generation = (writeGenerations.get(subject) ?? 0) + 1; writeGenerations.set(subject, generation);
  const intent: CreditWriteIntent = { version: 1, subject, path, body, key, generation, createdAt: Date.now(), persisted: false, phase: "unknown" };
  writeMemory.set(subject, intent);
  try { sessionStorage.setItem(writeStorageKey(subject), JSON.stringify({ ...intent, persisted: true })); intent.persisted = true; } catch { /* a non-persisted intent must not reach the business POST */ }
  return intent;
}
export function loadCreditWriteIntent(subject: string): CreditWriteIntent | null {
  const memory = writeMemory.get(subject);
  if (memory) return memory;
  try { const value = JSON.parse(sessionStorage.getItem(writeStorageKey(subject)) ?? "null") as CreditWriteIntent | null; if (value?.version === 1 && value.persisted === true && Number.isSafeInteger(value.generation) && ["unknown", "readback"].includes(value.phase) && value.subject === subject && typeof value.key === "string" && typeof value.path === "string" && value.body && typeof value.body === "object") { writeMemory.set(subject, value); writeGenerations.set(subject, Math.max(writeGenerations.get(subject) ?? 0, value.generation)); return value; } } catch { /* storage is an enhancement, not the authority */ }
  return null;
}
export function clearCreditWriteIntent(intent: CreditWriteIntent | null): void {
  if (!intent) return;
  const current = writeMemory.get(intent.subject);
  if (current && (current.key !== intent.key || current.generation !== intent.generation || JSON.stringify(current.body) !== JSON.stringify(intent.body) || current.path !== intent.path)) return;
  try {
    const stored = JSON.parse(sessionStorage.getItem(writeStorageKey(intent.subject)) ?? "null") as CreditWriteIntent | null;
    if (stored && (stored.key !== intent.key || stored.generation !== intent.generation || stored.path !== intent.path || JSON.stringify(stored.body) !== JSON.stringify(intent.body))) return;
    sessionStorage.removeItem(writeStorageKey(intent.subject));
  } catch { if (intent.persisted && current?.key === intent.key) return; }
  if (!current || current.key === intent.key) writeMemory.delete(intent.subject);
}
export function persistCreditWritePhase(intent: CreditWriteIntent, phase: CreditWriteIntent["phase"]): boolean {
  const current = writeMemory.get(intent.subject);
  if (!current || current.key !== intent.key || current.generation !== intent.generation || current.path !== intent.path || JSON.stringify(current.body) !== JSON.stringify(intent.body)) return false;
  try {
    const stored = JSON.parse(sessionStorage.getItem(writeStorageKey(intent.subject)) ?? "null") as CreditWriteIntent | null;
    if (stored && (stored.key !== intent.key || stored.generation !== intent.generation || stored.path !== intent.path || JSON.stringify(stored.body) !== JSON.stringify(intent.body))) return false;
  } catch { current.phase = phase; intent.phase = phase; return false; }
  current.phase = phase; intent.phase = phase;
  try { sessionStorage.setItem(writeStorageKey(intent.subject), JSON.stringify({ ...current, persisted: true })); return true; } catch { return false; }
}
async function request(path: string, method: "GET" | "POST", body: Record<string, unknown> | undefined, signal?: AbortSignal, idempotencyKey?: string): Promise<any> {
  const headers: Record<string, string> = method === "POST" ? { "content-type": "application/json", "idempotency-key": idempotencyKey ?? `credit_${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}_${Math.random()}`}` } : {};
  let response: Response;
  try { response = await fetch(`/api/account/credit${path}`, { method, headers, credentials: "same-origin", cache: "no-store", body: body ? JSON.stringify(body) : undefined, signal }); } catch (error) { if (signal?.aborted) throw error; throw new CreditRequestError(0, "NETWORK_ERROR", true); }
  const payload = await response.json().catch(() => null);
  if (!response.ok) throw new CreditRequestError(response.status, typeof payload?.error?.code === "string" ? payload.error.code : "INTERNAL_ERROR", response.status >= 500);
  return payload;
}
export async function readMyCredit(signal?: AbortSignal): Promise<CreditOverview> {
  const payload = object(await request("", "GET", undefined, signal));
  const credit = payload.credit === null ? null : (() => { const row = object(payload.credit); return { userId: text(row.userId), score: Number(row.score), revision: text(row.revision), initializedAt: text(row.initializedAt, 40), events: Array.isArray(row.events) ? row.events.map(event) : [] }; })();
  const recoveryRequests = Array.isArray(payload.recoveryRequests) ? payload.recoveryRequests.map((value: unknown) => { const row = object(value); return { id: text(row.id), status: row.status, reason: text(row.reason, 500), scoreBefore: Number(row.scoreBefore), createdAt: text(row.createdAt, 40), decidedAt: row.decidedAt ?? null }; }) : [];
  const guarantees = Array.isArray(payload.guarantees) ? payload.guarantees.map(guarantee) : [];
  const transactions = Array.isArray(payload.transactions) ? payload.transactions.map((value: unknown) => { const row = object(value); const paymentHistory = Array.isArray(row.paymentHistory) ? row.paymentHistory.map((attempt: unknown) => { const item = object(attempt); return { ...item, id: text(item.id), requirementId: text(item.requirementId), status: text(item.status), amountCents: cents(item.amountCents) }; }) : []; const refundHistory = Array.isArray(row.refundHistory) ? row.refundHistory.map((attempt: unknown) => { const item = object(attempt); return { ...item, id: text(item.id), requirementId: text(item.requirementId), paymentId: text(item.paymentId), status: text(item.status), amountCents: cents(item.amountCents) }; }) : []; return { ...row, requirementId: text(row.requirementId), accountId: text(row.accountId), paymentHistory, refundHistory }; }) : [];
  return { credit, recoveryRequests, guarantees, transactions };
}
export async function submitCreditWrite(intent: CreditWriteIntent | null, signal?: AbortSignal) { if (!intent?.persisted) throw new CreditRequestError(0, "WRITE_INTENT_STORAGE_UNAVAILABLE"); return request(intent.path, "POST", intent.body, signal, intent.key); }
function implicitIntent(path: string, body: Record<string, unknown>): CreditWriteIntent | null { const subject = `implicit:${path}:${JSON.stringify(body)}`; return loadCreditWriteIntent(subject) ?? makeCreditWriteIntent(subject, path, body); }
export async function requestCreditRecovery(reason: string, signal?: AbortSignal) { return submitCreditWrite(implicitIntent("/recovery-requests", { reason }), signal); }
export async function requestGuaranteePayment(accountId: string, signal?: AbortSignal) { return submitCreditWrite(implicitIntent(`/accounts/${encodeURIComponent(accountId)}/payment-intents`, {}), signal); }
export async function requestGuaranteeRefund(requirementId: string, signal?: AbortSignal) { return submitCreditWrite(implicitIntent(`/guarantees/${encodeURIComponent(requirementId)}/refund-requests`, {}), signal); }
export function creditMoney(centsValue: string | null): string { if (centsValue === null) return "待核定"; const value = BigInt(centsValue); return `¥${(value / 100n).toString()}.${(value % 100n).toString().padStart(2, "0")}`; }
