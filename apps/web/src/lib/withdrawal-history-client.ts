import { localWithdrawalScope, parseWithdrawalDetail, parseWithdrawalRead, type HistoricalWithdrawal, type HistoricalWithdrawalPage, type LocalWithdrawal, type LocalWithdrawalScope } from "./controlled-withdrawal-client.ts";
import { WalletRequestError } from "./personal-wallet-client.ts";
import { CHANNEL_WITHDRAWAL_STATES, parseOriginalDestination, parseWithdrawalAmounts, type ChannelWithdrawalState, type OriginalWithdrawalDestination } from "./channel-withdrawal-client.ts";
import { WithdrawalRequestError, badWithdrawal, cents, id, nullableText, record, revision, strings, text, time, withdrawalRequest } from "./withdrawal-client-core.ts";

export type WithdrawalHistorySource = "ALL" | "HISTORICAL" | "LOCAL_CONTROLLED" | "JOINPAY";
export type WithdrawalHistoryFilter = { source?: WithdrawalHistorySource; state?: string; limit?: number; cursor?: string | null };
export type WithdrawalHistoryAvailability = "AVAILABLE" | "NOT_REQUESTED" | "NOT_INTEGRATED" | "UNAVAILABLE" | "NOT_IMPORTED" | "NOT_INSTALLED" | "NOT_ADMITTED" | "NOT_CONFIGURED" | "NOT_IN_SCOPE";
export type WithdrawalHistorySection<T> = { availability: WithdrawalHistoryAvailability; reasonCodes: string[]; data: T | null };
export type JoinpayWithdrawalHistoryItem = { id: string; source: "JOINPAY"; sourceReference: { type: "NATIVE"; system: "zzsh"; entity: "joinpay_withdrawal_intent"; id: string }; intentId: string; amountCents: string; netCents: string; feeCents: string; currency: "CNY"; state: ChannelWithdrawalState; operationVersion: string; fundsDisposition: "RESERVED" | "PAYOUT_POSTED" | "RELEASE_POSTED" | "UNKNOWN"; requiresReview: boolean; merchantOrderNo: string; platformSerialNo: string | null; policyVersion: string; occurredAt: string; originalDestination: OriginalWithdrawalDestination | null; evidenceLevel: "LOCAL_RECORDS_NOT_REVALIDATED"; bankArrival: "UNKNOWN"; mayResubmit: false; reasonCodes: string[] };
export type JoinpayWithdrawalHistoryPage = { items: JoinpayWithdrawalHistoryItem[]; count: string; scope: "LOCAL_NATIVE_INTENTS_ONLY"; asOf: string; snapshotVersion: string; nextCursor: string | null };
export type WithdrawalHistoryRead = { contractVersion: "personal-withdrawals.read.v2"; subjectId: string; source: WithdrawalHistorySource; state: string; sections: { historical: WithdrawalHistorySection<HistoricalWithdrawalPage>; controlled: WithdrawalHistorySection<LocalWithdrawalScope>; joinpay: WithdrawalHistorySection<JoinpayWithdrawalHistoryPage> } };
export type WithdrawalHistoryDetail = { contractVersion: "personal-withdrawals.read.v2"; subjectId: string; source: "HISTORICAL_WITHDRAWAL"; item: HistoricalWithdrawal } | { contractVersion: "personal-withdrawals.read.v2"; subjectId: string; source: "LOCAL_CONTROLLED"; item: { id: string; source: "LOCAL_CONTROLLED"; intent: LocalWithdrawal } } | { contractVersion: "personal-withdrawals.read.v2"; subjectId: string; source: "JOINPAY"; availability: "AVAILABLE"; reasonCodes: string[]; data: { item: JoinpayWithdrawalHistoryItem; scope: "LOCAL_NATIVE_INTENTS_ONLY" } };
export type WithdrawalHistoryRecovery = { contractVersion: "personal-withdrawals.read.v2"; subjectId: string; source: "JOINPAY"; knowledge: "KNOWN" | "UNKNOWN"; item: JoinpayWithdrawalHistoryItem | null; mayResubmit: false; receiptMeaning: "CURRENT_LOCAL_INTENT_ORIGINAL_KEY_NOT_ORIGINAL_ACK" };

export function withdrawalHistoryQuery(filter: WithdrawalHistoryFilter = {}) {
  const source = filter.source ?? "ALL", state = filter.state ?? "ALL", limit = filter.limit ?? 20, cursor = filter.cursor ?? null;
  if (!["ALL", "HISTORICAL", "LOCAL_CONTROLLED", "JOINPAY"].includes(source) || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || cursor !== null && (typeof cursor !== "string" || !cursor || cursor.length > 4096) || source === "ALL" && (state !== "ALL" || cursor !== null)) throw new WithdrawalRequestError(400, "INVALID_ARGUMENT");
  if (state !== "ALL" && (source === "HISTORICAL" ? !/^[1-5]$/.test(state) : source === "LOCAL_CONTROLLED" ? !["RESERVED", "SUBMITTING", "PROCESSING", "UNKNOWN", "SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED"].includes(state) : source === "JOINPAY" ? !CHANNEL_WITHDRAWAL_STATES.includes(state as ChannelWithdrawalState) : true)) throw new WithdrawalRequestError(400, "INVALID_ARGUMENT");
  const query = new URLSearchParams({ source, limit: String(limit) });
  if (state !== "ALL") query.set("state", state);
  if (cursor !== null) query.set("cursor", cursor);
  return { source, state, limit, cursor, query };
}
function subject(b: Record<string, unknown>, userId: string) {
  if (b.contractVersion !== "personal-withdrawals.read.v2") throw badWithdrawal();
  if (b.subjectId !== id(userId)) throw new WithdrawalRequestError(401, "IDENTITY_CHANGED");
}
function legacyRead<T>(read: () => T): T {
  try { return read(); }
  catch (error) { if (error instanceof WalletRequestError) throw new WithdrawalRequestError(error.status, error.code); throw error; }
}
function section<T>(value: unknown, parser: (data: unknown) => T): WithdrawalHistorySection<T> {
  const s = record(value), availability = s.availability;
  if (!["AVAILABLE", "NOT_REQUESTED", "NOT_INTEGRATED", "UNAVAILABLE", "NOT_IMPORTED", "NOT_INSTALLED", "NOT_ADMITTED", "NOT_CONFIGURED", "NOT_IN_SCOPE"].includes(String(availability))) throw badWithdrawal();
  const reasonCodes = strings(s.reasonCodes);
  if (availability === "AVAILABLE" && s.data === null || ["NOT_REQUESTED", "NOT_INTEGRATED", "UNAVAILABLE", "NOT_ADMITTED", "NOT_CONFIGURED", "NOT_IN_SCOPE"].includes(String(availability)) && s.data !== null) throw badWithdrawal();
  return { availability: availability as WithdrawalHistoryAvailability, reasonCodes, data: s.data === null ? null : parser(s.data) };
}
export function parseJoinpayHistoryItem(value: unknown): JoinpayWithdrawalHistoryItem {
  const i = record(value), ref = record(i.sourceReference), intentId = id(i.intentId), amounts = parseWithdrawalAmounts(i);
  if (i.id !== `joinpay:${intentId}` || i.source !== "JOINPAY" || ref.type !== "NATIVE" || ref.system !== "zzsh" || ref.entity !== "joinpay_withdrawal_intent" || ref.id !== intentId || !CHANNEL_WITHDRAWAL_STATES.includes(i.state as ChannelWithdrawalState) || !["RESERVED", "PAYOUT_POSTED", "RELEASE_POSTED", "UNKNOWN"].includes(String(i.fundsDisposition)) || typeof i.requiresReview !== "boolean" || i.evidenceLevel !== "LOCAL_RECORDS_NOT_REVALIDATED" || i.bankArrival !== "UNKNOWN" || i.mayResubmit !== false) throw badWithdrawal();
  return { id: `joinpay:${intentId}`, source: "JOINPAY", sourceReference: { type: "NATIVE", system: "zzsh", entity: "joinpay_withdrawal_intent", id: intentId }, intentId, ...amounts, state: i.state as ChannelWithdrawalState, operationVersion: revision(i.operationVersion), fundsDisposition: i.fundsDisposition as JoinpayWithdrawalHistoryItem["fundsDisposition"], requiresReview: i.requiresReview, merchantOrderNo: text(i.merchantOrderNo, 128), platformSerialNo: nullableText(i.platformSerialNo, 180), policyVersion: id(i.policyVersion), occurredAt: time(i.occurredAt), originalDestination: parseOriginalDestination(i.originalDestination), evidenceLevel: "LOCAL_RECORDS_NOT_REVALIDATED", bankArrival: "UNKNOWN", mayResubmit: false, reasonCodes: strings(i.reasonCodes) };
}
function joinpayPage(value: unknown): JoinpayWithdrawalHistoryPage {
  const p = record(value);
  if (p.scope !== "LOCAL_NATIVE_INTENTS_ONLY" || !Array.isArray(p.items) || p.items.length > 100) throw badWithdrawal();
  const items = p.items.map(parseJoinpayHistoryItem), count = cents(p.count);
  if (new Set(items.map(i => i.id)).size !== items.length || BigInt(count) < BigInt(items.length)) throw badWithdrawal();
  return { items, count, scope: "LOCAL_NATIVE_INTENTS_ONLY", asOf: time(p.asOf), snapshotVersion: text(p.snapshotVersion, 256), nextCursor: nullableText(p.nextCursor, 4096) };
}
export function parseWithdrawalHistory(value: unknown, userId: string): WithdrawalHistoryRead {
  const b = record(value); subject(b, userId);
  if (typeof b.source !== "string" || typeof b.state !== "string") throw badWithdrawal();
  let query: ReturnType<typeof withdrawalHistoryQuery>;
  try { query = withdrawalHistoryQuery({ source: b.source as WithdrawalHistorySource, state: b.state as string }); } catch { throw badWithdrawal(); }
  const parts = record(b.sections);
  const historical = section(parts.historical, data => {
    const parsed = legacyRead(() => parseWithdrawalRead({ contractVersion: "personal-withdrawals.read.v1", subjectId: userId, source: "HISTORICAL", state: query.source === "HISTORICAL" ? query.state : "ALL", historical: data, controlled: { availability: "NOT_REQUESTED", reason: null, data: null } }, userId));
    if (!parsed.historical) throw badWithdrawal(); return parsed.historical;
  });
  const controlled = section(parts.controlled, data => legacyRead(() => localWithdrawalScope(data, userId)));
  const joinpay = section(parts.joinpay, joinpayPage);
  const requested = { HISTORICAL: historical, LOCAL_CONTROLLED: controlled, JOINPAY: joinpay };
  for (const [name, part] of Object.entries(requested)) {
    if ((query.source === "ALL" || query.source === name) === (part.availability === "NOT_REQUESTED")) throw badWithdrawal();
  }
  return { contractVersion: "personal-withdrawals.read.v2", subjectId: userId, source: query.source, state: query.state, sections: { historical, controlled, joinpay } };
}
export function parseWithdrawalHistoryDetail(value: unknown, userId: string, expectedId?: string): WithdrawalHistoryDetail {
  const b = record(value); subject(b, userId);
  if (b.source === "JOINPAY") {
    const data = record(b.data), item = parseJoinpayHistoryItem(data.item);
    if (b.availability !== "AVAILABLE" || data.scope !== "LOCAL_NATIVE_INTENTS_ONLY" || expectedId && item.id !== expectedId) throw badWithdrawal();
    return { contractVersion: "personal-withdrawals.read.v2", subjectId: userId, source: "JOINPAY", availability: "AVAILABLE", reasonCodes: strings(b.reasonCodes), data: { item, scope: "LOCAL_NATIVE_INTENTS_ONLY" } };
  }
  // These two v2 sections deliberately preserve their original v1 item contracts.
  const old = legacyRead(() => parseWithdrawalDetail({ ...b, contractVersion: "personal-withdrawals.read.v1" }, userId, expectedId));
  return { ...old, contractVersion: "personal-withdrawals.read.v2" };
}
/** Preserve the v1 LOCAL_CONTROLLED wire envelope while projecting only validated fields. */
export function projectWithdrawalHistory(value: unknown, userId: string) {
  const parsed = parseWithdrawalHistory(value, userId), data = parsed.sections.controlled.data;
  if (!data) return parsed;
  const wireData = { scope: "LOCAL_CONTROLLED", subjectId: userId,
    coverage: { knowledge: "KNOWN", meaning: "EXPLICIT_LOCAL_INTENTS_ONLY_NOT_TOTAL_HISTORICAL_WALLET", cohorts: data.cohorts },
    items: data.items, destinations: data.destinations, totals: data.totals, globalReserved: "UNKNOWN",
    ...(data.nativeWithdrawal ? { nativeWithdrawal: data.nativeWithdrawal } : {}), ...(data.pagination ? { pagination: data.pagination } : {}) };
  return { ...parsed, sections: { ...parsed.sections, controlled: { ...parsed.sections.controlled, data: wireData } } };
}
export function parseWithdrawalHistoryRecovery(value: unknown, userId: string): WithdrawalHistoryRecovery {
  const b = record(value); subject(b, userId);
  if (b.source !== "JOINPAY" || !["KNOWN", "UNKNOWN"].includes(String(b.knowledge)) || (b.knowledge === "KNOWN") !== (b.item !== null) || b.mayResubmit !== false || b.receiptMeaning !== "CURRENT_LOCAL_INTENT_ORIGINAL_KEY_NOT_ORIGINAL_ACK") throw badWithdrawal();
  return { contractVersion: "personal-withdrawals.read.v2", subjectId: userId, source: "JOINPAY", knowledge: b.knowledge as WithdrawalHistoryRecovery["knowledge"], item: b.item === null ? null : parseJoinpayHistoryItem(b.item), mayResubmit: false, receiptMeaning: "CURRENT_LOCAL_INTENT_ORIGINAL_KEY_NOT_ORIGINAL_ACK" };
}
export async function readWithdrawalHistory(userId: string, filter: WithdrawalHistoryFilter = {}, signal?: AbortSignal) {
  const expected = withdrawalHistoryQuery(filter), result = parseWithdrawalHistory(await withdrawalRequest("withdrawal-history", `?${expected.query}`, { expectedUserId: userId, signal }), userId);
  if (result.source !== expected.source || result.state !== expected.state) throw badWithdrawal();
  const part = expected.source === "JOINPAY" ? result.sections.joinpay.data : expected.source === "HISTORICAL" ? result.sections.historical.data : expected.source === "LOCAL_CONTROLLED" ? result.sections.controlled.data : null;
  if (part && part.items.length > expected.limit) throw badWithdrawal();
  return result;
}
export async function readWithdrawalHistoryItem(userId: string, recordId: string, signal?: AbortSignal) {
  if (!/^(history|controlled|joinpay):[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(recordId)) throw new WithdrawalRequestError(400, "INVALID_ARGUMENT");
  return parseWithdrawalHistoryDetail(await withdrawalRequest("withdrawal-history", "/" + encodeURIComponent(recordId), { expectedUserId: userId, signal }), userId, recordId);
}
export async function recoverWithdrawalFromHistory(userId: string, originalKey: string, signal?: AbortSignal) {
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(originalKey)) throw new WithdrawalRequestError(400, "INVALID_ARGUMENT");
  return parseWithdrawalHistoryRecovery(await withdrawalRequest("withdrawal-history", "/receipt?key=" + encodeURIComponent(originalKey), { expectedUserId: userId, signal }), userId);
}
