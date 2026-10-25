import { parseBankBinding, type BankBindingRead } from "./withdrawal-bank-binding-client.ts";
import { WithdrawalRequestError, assertCurrent, badWithdrawal, cents, id, key, nullableText, record, recoveryStorage, revision, strings, text, time, underWithdrawalLock, withdrawalRequest, type WithdrawalWriteOptions } from "./withdrawal-client-core.ts";

export type WithdrawalFee = { kind: "FIXED"; cents: string } | { kind: "RATIO"; numerator: string; denominator: string; rounding: "HALF_UP_CENT" };
export type WithdrawalPolicy = { version: string; minCents: string; maxCents: string; fee: WithdrawalFee; maxIntents: number; quotaStart: string; quotaEnd: string };
export type WithdrawalOptions = { contractVersion: "withdrawal-request-context.v1"; bankBinding: BankBindingRead; policy: WithdrawalPolicy | null; canQuote: boolean; reasonCodes: string[]; bankOwnershipVerification: "NOT_VERIFIED"; bankArrival: "UNKNOWN" };
export type ChannelWithdrawalInput = { amountCents: string; destinationId: string; policyVersion: string };
export type ChannelWithdrawalQuote = { contractVersion: "native-withdrawal.v1"; source: "JOINPAY"; grossCents: string; netCents: string; feeCents: string; currency?: "CNY"; policyVersion: string; destination: { id: string; revision: string; mask: string }; expectedWalletVersion: string; ledgerRevision: string; globalWithdrawable: "UNKNOWN" };
export type OriginalWithdrawalDestination = { id: string; revision: string; cardMask: string | null; basis: "ORIGINAL_INTENT"; bankOwnershipVerification: "UNKNOWN" };
export const CHANNEL_WITHDRAWAL_STATES = ["RESERVED", "SUBMITTING", "PROCESSING", "UNKNOWN", "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE", "SUCCEEDED", "FAILED"] as const;
export type ChannelWithdrawalState = typeof CHANNEL_WITHDRAWAL_STATES[number];
export type ChannelWithdrawalIntent = { contractVersion: "native-withdrawal.v1"; id: string; source: "JOINPAY"; userId: string; amountCents: string; netCents: string; feeCents: string; currency: "CNY"; state: ChannelWithdrawalState; operationVersion: string; fundsDisposition: "RESERVED" | "PAYOUT_POSTED" | "RELEASE_POSTED"; requiresReview: boolean; merchantOrderNo: string; policyVersion: string; destinationId: string; acceptedAt: string; bankArrival: "UNKNOWN"; globalWithdrawable: "UNKNOWN"; originalDestination: OriginalWithdrawalDestination | null };
export type ChannelWithdrawalBody = ChannelWithdrawalInput & { expectedWalletVersion: string };
export type PendingChannelWithdrawal = { userId: string; key: string; body: ChannelWithdrawalBody };
export type ChannelWithdrawalRecovery = { source: "JOINPAY"; knowledge: "KNOWN" | "UNKNOWN"; receipt: ChannelWithdrawalIntent | null; mayResubmit: false };
const prefix = "zzsh.channel-withdrawal-recovery.v1:";
export function parseOriginalDestination(value: unknown): OriginalWithdrawalDestination | null {
  if (value === undefined || value === null) return null;
  const d = record(value), cardMask = nullableText(d.cardMask, 32), rev = revision(d.revision);
  if (rev === "0" || cardMask !== null && !/^\*{4} \*{4} \d{4}$/.test(cardMask) || d.basis !== "ORIGINAL_INTENT" || d.bankOwnershipVerification !== "UNKNOWN") throw badWithdrawal();
  return { id: id(d.id), revision: rev, cardMask, basis: "ORIGINAL_INTENT", bankOwnershipVerification: "UNKNOWN" };
}
export function parseWithdrawalAmounts(value: Record<string, unknown>, grossField = "amountCents") {
  const gross = cents(value[grossField]), net = cents(value.netCents), fee = cents(value.feeCents);
  if (value.currency !== "CNY" || BigInt(gross) <= 0n || BigInt(net) <= 0n || BigInt(gross) !== BigInt(net) + BigInt(fee)) throw badWithdrawal();
  return { amountCents: gross, netCents: net, feeCents: fee, currency: "CNY" as const };
}
export function parseWithdrawalOptions(value: unknown): WithdrawalOptions {
  const b = record(value);
  if (b.contractVersion !== "withdrawal-request-context.v1" || typeof b.canQuote !== "boolean" || b.bankOwnershipVerification !== "NOT_VERIFIED" || b.bankArrival !== "UNKNOWN") throw badWithdrawal();
  const bankBinding = parseBankBinding(b.bankBinding), reasonCodes = strings(b.reasonCodes);
  let policy: WithdrawalPolicy | null = null;
  if (b.policy !== null) {
    const p = record(b.policy), f = record(p.fee);
    let fee: WithdrawalFee;
    if (f.kind === "FIXED") fee = { kind: "FIXED", cents: cents(f.cents) };
    else if (f.kind === "RATIO" && f.rounding === "HALF_UP_CENT" && BigInt(cents(f.denominator)) > 0n) fee = { kind: "RATIO", numerator: cents(f.numerator), denominator: cents(f.denominator), rounding: "HALF_UP_CENT" };
    else throw badWithdrawal();
    const minCents = cents(p.minCents), maxCents = cents(p.maxCents);
    if (BigInt(minCents) <= 0n || BigInt(maxCents) < BigInt(minCents) || typeof p.maxIntents !== "number" || !Number.isSafeInteger(p.maxIntents) || p.maxIntents < 1) throw badWithdrawal();
    policy = { version: id(p.version), minCents, maxCents, fee, maxIntents: p.maxIntents, quotaStart: time(p.quotaStart), quotaEnd: time(p.quotaEnd) };
    if (Date.parse(policy.quotaStart) >= Date.parse(policy.quotaEnd)) throw badWithdrawal();
  }
  if (b.canQuote && (!policy || !bankBinding.binding || bankBinding.integration !== "INTEGRATED" || reasonCodes.length)) throw badWithdrawal();
  return { contractVersion: b.contractVersion, bankBinding, policy, canQuote: b.canQuote, reasonCodes, bankOwnershipVerification: "NOT_VERIFIED", bankArrival: "UNKNOWN" };
}
export function parseChannelQuote(value: unknown): ChannelWithdrawalQuote {
  const q = record(value), d = record(q.destination);
  // This quote contract is defined in CNY cents; its original wire shape omits currency.
  const amounts = parseWithdrawalAmounts({ ...q, currency: q.currency === undefined ? "CNY" : q.currency }, "grossCents"), rev = revision(d.revision), mask = text(d.mask, 32), token = text(q.expectedWalletVersion, 512);
  if (q.contractVersion !== "native-withdrawal.v1" || q.source !== "JOINPAY" || q.globalWithdrawable !== "UNKNOWN" || rev === "0" || !/^\*{4} \*{4} \d{4}$/.test(mask) || !/^jwdq1:[a-f0-9]{64}$/.test(token)) throw badWithdrawal();
  return { contractVersion: q.contractVersion, source: "JOINPAY", grossCents: amounts.amountCents, netCents: amounts.netCents, feeCents: amounts.feeCents, ...(q.currency === undefined ? {} : { currency: "CNY" as const }), policyVersion: id(q.policyVersion), destination: { id: id(d.id), revision: rev, mask }, expectedWalletVersion: token, ledgerRevision: revision(q.ledgerRevision), globalWithdrawable: "UNKNOWN" };
}
export function parseChannelIntent(value: unknown, userId: string, expectedId?: string): ChannelWithdrawalIntent {
  const i = record(value), amounts = parseWithdrawalAmounts(i);
  if (i.userId !== userId) throw new WithdrawalRequestError(401, "IDENTITY_CHANGED");
  if (i.contractVersion !== "native-withdrawal.v1" || i.source !== "JOINPAY" || !CHANNEL_WITHDRAWAL_STATES.includes(i.state as ChannelWithdrawalState) || !["RESERVED", "PAYOUT_POSTED", "RELEASE_POSTED"].includes(String(i.fundsDisposition)) || typeof i.requiresReview !== "boolean" || i.bankArrival !== "UNKNOWN" || i.globalWithdrawable !== "UNKNOWN") throw badWithdrawal();
  const intentId = id(i.id);
  if (expectedId && intentId !== expectedId) throw badWithdrawal();
  const destinationId = id(i.destinationId), originalDestination = parseOriginalDestination(i.originalDestination);
  if (originalDestination && originalDestination.id !== destinationId) throw badWithdrawal();
  return { contractVersion: i.contractVersion, id: intentId, source: "JOINPAY", userId, ...amounts, state: i.state as ChannelWithdrawalState, operationVersion: revision(i.operationVersion), fundsDisposition: i.fundsDisposition as ChannelWithdrawalIntent["fundsDisposition"], requiresReview: i.requiresReview, merchantOrderNo: text(i.merchantOrderNo, 128), policyVersion: id(i.policyVersion), destinationId, acceptedAt: time(i.acceptedAt), bankArrival: "UNKNOWN", globalWithdrawable: "UNKNOWN", originalDestination };
}
export function parseChannelRecovery(value: unknown, userId: string): ChannelWithdrawalRecovery {
  const b = record(value);
  if (b.source !== "JOINPAY" || !["KNOWN", "UNKNOWN"].includes(String(b.knowledge)) || (b.knowledge === "KNOWN") !== (b.receipt !== null) || b.mayResubmit !== false) throw badWithdrawal();
  return { source: "JOINPAY", knowledge: b.knowledge as ChannelWithdrawalRecovery["knowledge"], receipt: b.receipt === null ? null : parseChannelIntent(record(b.receipt).intent, userId), mayResubmit: false };
}
export async function readChannelWithdrawalOptions(userId: string, signal?: AbortSignal) { return parseWithdrawalOptions(await withdrawalRequest("channel-withdrawals", "/options", { expectedUserId: userId, signal })); }
function input(value: ChannelWithdrawalInput): ChannelWithdrawalInput { try { const amountCents = cents(value.amountCents); if (BigInt(amountCents) <= 0n) throw Error(); return { amountCents, destinationId: id(value.destinationId), policyVersion: id(value.policyVersion) }; } catch { throw new WithdrawalRequestError(400, "INVALID_ARGUMENT"); } }
export async function quoteChannelWithdrawal(userId: string, value: ChannelWithdrawalInput, signal?: AbortSignal) {
  const body = input(value), q = parseChannelQuote(await withdrawalRequest("channel-withdrawals", "/quote", { expectedUserId: userId, method: "POST", body, signal }));
  if (q.grossCents !== body.amountCents || q.destination.id !== body.destinationId || q.policyVersion !== body.policyVersion) throw badWithdrawal();
  return q;
}
export async function readChannelWithdrawal(userId: string, intentId: string, signal?: AbortSignal) {
  const b = record(await withdrawalRequest("channel-withdrawals", "/" + encodeURIComponent(id(intentId)), { expectedUserId: userId, signal }));
  if (b.source !== "JOINPAY" || b.mayResubmit !== false) throw badWithdrawal();
  return parseChannelIntent(b.intent, userId, intentId);
}
export function pendingChannelWithdrawal(userId: string): PendingChannelWithdrawal | null {
  try {
    const raw = recoveryStorage().getItem(prefix + id(userId)); if (raw === null) return null;
    const p = record(JSON.parse(raw)), b = record(p.body), body = input(b as ChannelWithdrawalInput), token = text(b.expectedWalletVersion, 512);
    if (p.userId !== userId || Object.keys(p).sort().join() !== "body,key,userId" || Object.keys(b).sort().join() !== "amountCents,destinationId,expectedWalletVersion,policyVersion" || !/^jwdq1:[a-f0-9]{64}$/.test(token)) throw badWithdrawal();
    return { userId, key: key(p.key), body: { ...body, expectedWalletVersion: token } };
  } catch { throw new WithdrawalRequestError(0, "RECOVERY_STORAGE_UNAVAILABLE"); }
}
function storePending(p: PendingChannelWithdrawal) {
  try { const s = recoveryStorage(), raw = JSON.stringify(p); s.setItem(prefix + p.userId, raw); if (s.getItem(prefix + p.userId) !== raw) throw Error(); }
  catch { throw new WithdrawalRequestError(0, "RECOVERY_STORAGE_UNAVAILABLE"); }
}
function clearPending(p: PendingChannelWithdrawal) { if (pendingChannelWithdrawal(p.userId)?.key === p.key) recoveryStorage().removeItem(prefix + p.userId); }
export async function submitChannelWithdrawal(userId: string, value: ChannelWithdrawalQuote, options: WithdrawalWriteOptions = {}) {
  const quote = parseChannelQuote(value), current = options.isCurrent ?? (() => true);
  return underWithdrawalLock("channel-withdrawal", userId, async () => {
    assertCurrent(current, options.signal);
    if (pendingChannelWithdrawal(userId)) throw new WithdrawalRequestError(409, "PENDING_REQUEST_EXISTS");
    const pending: PendingChannelWithdrawal = { userId, key: crypto.randomUUID(), body: { amountCents: quote.grossCents, destinationId: quote.destination.id, policyVersion: quote.policyVersion, expectedWalletVersion: quote.expectedWalletVersion } };
    storePending(pending);
    try {
      const b = record(await withdrawalRequest("channel-withdrawals", "", { expectedUserId: userId, method: "POST", body: pending.body, key: pending.key, signal: options.signal }));
      assertCurrent(current, options.signal);
      const intent = parseChannelIntent(b.intent, userId);
      if (intent.amountCents !== pending.body.amountCents || intent.destinationId !== pending.body.destinationId || intent.policyVersion !== pending.body.policyVersion) throw badWithdrawal();
      clearPending(pending); return intent;
    } catch (error) {
      if (error instanceof WithdrawalRequestError && error.status >= 400 && error.status < 500 && error.code !== "IDENTITY_CHANGED") clearPending(pending);
      throw error;
    }
  });
}
export async function recoverChannelWithdrawal(userId: string, options: WithdrawalWriteOptions = {}): Promise<ChannelWithdrawalRecovery & { current: ChannelWithdrawalIntent | null }> {
  const current = options.isCurrent ?? (() => true); assertCurrent(current, options.signal);
  const pending = pendingChannelWithdrawal(userId);
  if (!pending) throw new WithdrawalRequestError(409, "NO_PENDING_REQUEST");
  const recovery = parseChannelRecovery(await withdrawalRequest("channel-withdrawals", `/receipt?key=${encodeURIComponent(pending.key)}`, { expectedUserId: userId, signal: options.signal }), userId);
  assertCurrent(current, options.signal);
  if (recovery.knowledge === "KNOWN") {
    if (recovery.receipt?.amountCents !== pending.body.amountCents || recovery.receipt.destinationId !== pending.body.destinationId || recovery.receipt.policyVersion !== pending.body.policyVersion) throw badWithdrawal();
    clearPending(pending);
    try {
      const latest = await readChannelWithdrawal(userId, recovery.receipt.id, options.signal);
      assertCurrent(current, options.signal);
      return { ...recovery, current: latest };
    } catch (error) { if (!current() || options.signal?.aborted) throw error; return { ...recovery, current: null }; }
  }
  return { ...recovery, current: null };
}
