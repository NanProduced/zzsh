import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import { canonicalize } from "../supply/content-hash";
import { invalid, notFound } from "../supply/supply-util";
import { requireListingCursorKey, type ListingCursorKey } from "../supply/listing-cursor";
import { exactCents, sourceYuanToCents, sourceSignedYuanToCents, readPersonalWallet } from "./personal-finance-read";
import { loadFinanceOrderFacts, matchFinanceOrderReference, type FinanceOrderFact } from "./admin-finance-order-read";
import { scopedFinanceSql, financeVersionSql, type FinanceLoadScope } from "./admin-finance-query";

export const ADMIN_FINANCE_VERSION = "admin-finance.read.v1";
export const FINANCE_BUCKETS = ["AVAILABLE", "RESERVED", "REFUND_PAYABLE", "PENDING_EARNINGS", "PLATFORM", "CLEARING"] as const;
export type FinanceBucket = typeof FINANCE_BUCKETS[number];
export type FinanceFilters = { scope: string; from: string; to: string; period: boolean; bucket: FinanceBucket | "ALL"; kind: string; state: string; q: string };
export type FinanceActor = { userId: string; sessionId: string; authorizationKey: string };
export type FinanceEntry = {
  id: string; documentRef: string; documentNumber: string; subjectId: string; subjectName: string;
  bucket: FinanceBucket; direction: "IN" | "OUT" | "UNKNOWN"; deltaCents: string | null;
  knowledge: "KNOWN" | "UNKNOWN"; kind: string; state: string; classification: string;
  affectsCurrentWallet: boolean; affectsCurrentLedger: boolean; occurredAt: string | null; importedAt: string; sourceType: string;
  sourceEntity: string; sourceSystem: string; sourceId: string; sourceDigest: string | null; basisId: string | null;
  reasonCodes: string[]; accountCode: string | null; evidence: Record<string, string | null>;
  related: { ref: string; label: string; path?: string }[];
};
export type FinanceFacts = { entries: FinanceEntry[]; subjects: { id: string; name: string }[]; revisions: unknown[]; withdrawalsReady: boolean; orders?: FinanceOrderFact[]; subjectCandidates?: {items:{id:string;name:string}[];total:number}; asOf: string; version: string };
const MAX_FACTS = 20_000;
const digest = (value: unknown) => createHash("sha256").update(canonicalize(value)).digest("hex");
const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const stale = () => new SecurityApiError(409, "CONFLICT", "Finance snapshot changed; reload", [{ path: "snapshot", code: "INVALID_FIELD" }]);
const unavailable = (message: string) => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", message);

function day(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid("Invalid finance date");
  const date = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw invalid("Invalid finance date");
  return value;
}
export function parseAdminFinanceFilters(query: URLSearchParams, now = new Date(), periodRequired = true): FinanceFilters {
  for (const key of query.keys()) if (!["scope", "from", "to", "period", "bucket", "kind", "state", "q", "snapshot", "page", "pageSize", "entry"].includes(key) || query.getAll(key).length !== 1) throw invalid("Unsupported or repeated finance filter");
  const today = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  const from = day(query.get("from") ?? today), to = day(query.get("to") ?? today);
  if (from > to || Date.parse(to) - Date.parse(from) > 366 * 86400_000) throw invalid("Finance period must be at most 367 days");
  const scope = query.get("scope") ?? "ALL", bucket = query.get("bucket") ?? "ALL";
  if (scope !== "ALL" && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope)) throw invalid("Invalid finance subject");
  if (bucket !== "ALL" && !(FINANCE_BUCKETS as readonly string[]).includes(bucket)) throw invalid("Invalid finance bucket");
  const kind = query.get("kind") ?? "ALL", state = query.get("state") ?? "ALL", q = (query.get("q") ?? "").trim();
  if (!/^(ALL|OPENING|SETTLEMENT|WITHDRAWAL|REFUND|EARNINGS|DISTRIBUTION)$/.test(kind) || !["ALL", "POSTED", "RESERVED", "SUBMITTING", "PROCESSING", "UNKNOWN", "SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED", "HISTORICAL_OBSERVED", "ORDER_RECORDED", "HISTORICAL_ORDER_RECORDED", "REFUND_PAYABLE_RECORDED"].includes(state) || q.length > 512) throw invalid("Invalid finance query");
  const periodValue = query.get("period");
  if (periodValue !== null && !["0", "1"].includes(periodValue) || periodRequired && periodValue === "0") throw invalid("Invalid finance period mode");
  const period = periodRequired || periodValue === "1" || periodValue !== "0" && (query.has("from") || query.has("to"));
  return { scope, from, to, period, bucket: bucket as FinanceFilters["bucket"], kind, state, q };
}
export function resolveFinanceLookup(value: string, origins: readonly string[]): string {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value) || !value.includes("://")) return value;
  let url: URL; try { url = new URL(value); } catch { throw invalid("Invalid station link"); }
  if (!origins.includes(url.origin) || url.username || url.password || url.hash) throw invalid("Only known station links are supported");
  const match = /^\/(users|orders|finance\/users|finance\/documents)\/([^/]+)$/.exec(url.pathname);
  if (!match || url.search) throw invalid("Unsupported station link");
  try { const id = decodeURIComponent(match[2]!); return match[1] === "orders" ? `ORDER_LINK:${id}` : id; } catch { throw invalid("Invalid station reference"); }
}
function cents(value: unknown, yuan = false): string | null {
  try { return yuan ? sourceYuanToCents(value) : exactCents(value); } catch { return null; }
}
function signedSourceCents(value: unknown): string | null { try { return sourceSignedYuanToCents(value); } catch { return null; } }
function displayName(value: unknown, fallback: string): string { return typeof value !== "string" ? fallback : /^1[3-9]\d{9}$/.test(value) ? value.slice(0, 3) + "****" + value.slice(-4) : value; }
function bucketOf(code: string): FinanceBucket {
  if (["OWNER_AVAILABLE", "WALLET_AVAILABLE"].includes(code)) return "AVAILABLE";
  if (code === "WALLET_RESERVED") return "RESERVED";
  if (code === "RENTER_REFUND_PAYABLE") return "REFUND_PAYABLE";
  if (code.startsWith("PLATFORM_") || code === "WITHDRAW_FEE") return "PLATFORM";
  return "CLEARING";
}
export const ADMIN_FINANCE_LEDGER_SQL = `SELECT l.id,l.account_code,l.counterparty_user_id AS subject_id,
  COALESCE(u.name,l.counterparty_user_id,'平台') AS subject_name,(l.credit_cents-l.debit_cents)::text AS delta,
  ${utc("l.created_at")} AS at,l.posting_id,e.kind AS event_kind,r.source_kind,r.source_type,r.source_system,r.source_entity,r.source_id,r.source_digest,
  r.basis_id,p.order_id,o.display_no,o.account_id,b.source_cutoff::text AS opening_cutoff,b.covered_count::text AS covered_count,
  p.payment_confirmation_id,p.settlement_version_id,p.version_hash,p.captured_cents::text,p.renter_refund_cents::text,p.platform_contribution_cents::text,${utc("p.refund_due_at")} AS refund_due_at
  FROM zzsh_order.settlement_ledger_entry l LEFT JOIN zzsh_auth_user."user" u ON u.id=l.counterparty_user_id
  LEFT JOIN zzsh_order.finance_event e ON e.id=l.finance_event_id LEFT JOIN zzsh_order.finance_economic_root r ON r.id=e.economic_root_id
  LEFT JOIN zzsh_order.finance_opening_basis b ON b.id=r.basis_id
  LEFT JOIN zzsh_order.settlement_posting p ON p.id=l.posting_id LEFT JOIN zzsh_order.rental_order o ON o.id=p.order_id
  ORDER BY l.id COLLATE "C" LIMIT $1`;
export const ADMIN_FINANCE_OBSERVATION_SQL = `SELECT o.id,o.user_id AS subject_id,COALESCE(u.name,o.user_id) AS subject_name,o.source_kind,o.source_type,o.source_system,o.source_entity,o.source_id,o.source_digest,o.basis_id,o.included_in_opening,
  ${utc("o.source_event_at")} AS at,${utc("o.imported_at")} AS imported_at,
  o.snapshot->>'amount' AS amount,o.snapshot->>'action' AS action,o.snapshot->>'sourceStatus' AS source_status,
  o.snapshot->>'referenceId' AS reference_id,o.snapshot->>'referenceSn' AS reference_no,
  o.snapshot->>'net' AS net,o.snapshot->>'fee' AS fee,o.snapshot->>'leftAmount' AS balance_after
  FROM zzsh_order.personal_finance_observation o LEFT JOIN zzsh_auth_user."user" u ON u.id=o.user_id ORDER BY o.id COLLATE "C" LIMIT $1`;
type Raw = Record<string, any>;
export function projectAdminFinanceLedger(row: Raw): FinanceEntry {
  const opening = row.event_kind === "OPENING", withdrawal = row.source_entity === "withdrawal_intent";
  const ref = opening ? `OPENING:${row.basis_id}` : withdrawal ? `WITHDRAWAL:${row.source_id}` : row.order_id ? `ORDER:${row.order_id}` : `POSTING:${row.posting_id ?? row.id}`;
  const amount = cents(row.delta), type = opening ? "OPENING" : withdrawal ? "WITHDRAWAL" : bucketOf(row.account_code) === "REFUND_PAYABLE" ? "REFUND" : "SETTLEMENT";
  return { id: `ledger:${row.id}`, documentRef: ref, documentNumber: row.display_no ?? (opening ? row.basis_id : row.source_id) ?? row.posting_id ?? row.id,
    subjectId: row.subject_id ?? (bucketOf(row.account_code) === "PLATFORM" ? "PLATFORM" : "SYSTEM"), subjectName: row.subject_id ? displayName(row.subject_name, row.subject_id) : bucketOf(row.account_code) === "PLATFORM" ? "平台" : "对照科目", bucket: bucketOf(row.account_code), direction: amount === null ? "UNKNOWN" : BigInt(amount) < 0n ? "OUT" : "IN",
    deltaCents: amount, knowledge: amount === null ? "UNKNOWN" : "KNOWN", kind: type, state: type === "REFUND" ? "REFUND_PAYABLE_RECORDED" : "POSTED", classification: opening ? "OPENING" : "CURRENT_POSTED", affectsCurrentWallet: row.subject_id !== null && row.subject_id !== undefined, affectsCurrentLedger: true,
    occurredAt: row.at, importedAt: row.at, sourceType: row.source_type ?? "NATIVE", sourceSystem: row.source_system ?? "zzsh", sourceEntity: row.source_entity ?? "settlement_posting", sourceId: row.source_id ?? row.posting_id ?? row.id,
    sourceDigest: row.source_digest ?? null, basisId: row.basis_id ?? null, reasonCodes: [...(amount === null ? ["INVALID_EXACT_AMOUNT"] : []), ...(type === "REFUND" ? ["REFUND_PAYMENT_SOURCE_NOT_AVAILABLE"] : [])], accountCode: row.account_code,
    evidence: { eventKind: row.event_kind ?? null, openingCutoff: row.opening_cutoff ?? null, coveredCount: row.covered_count ?? null, postingId: row.posting_id ?? null,
      paymentConfirmationId: row.payment_confirmation_id ?? null, settlementVersionId: row.settlement_version_id ?? null, settlementVersionHash: row.version_hash ?? null,
      postingCapturedCents: cents(row.captured_cents),
      refundPayableCents: cents(row.renter_refund_cents), refundDueAt: row.refund_due_at ?? null, ...(type === "REFUND" ? { refundPaidCents: null, refundPaymentReference: null } : {}), postedPlatformContributionCents: cents(row.platform_contribution_cents) },
    related: [...(row.order_id ? [{ ref: `ORDER:${row.order_id}`, label: "原订单", path: `/orders/${encodeURIComponent(row.order_id)}` }] : []), ...(row.account_id ? [{ ref: row.account_id, label: "资源账号", path: `/supply/accounts/${encodeURIComponent(row.account_id)}` }] : [])] };
}
export function projectAdminFinanceObservation(row: Raw): FinanceEntry {
  const earnings = row.source_entity === "la_log_earnings", distribution = row.source_entity === "la_distribution_order";
  const unsigned = cents(row.amount, true), direction = earnings ? row.action === "1" ? "IN" : row.action === "2" ? "OUT" : "UNKNOWN" : distribution ? "IN" : "OUT";
  const amount = unsigned === null || direction === "UNKNOWN" ? null : direction === "OUT" && unsigned !== "0" ? `-${unsigned}` : unsigned;
  const kind = earnings ? "EARNINGS" : distribution ? "DISTRIBUTION" : "WITHDRAWAL";
  return { id: `history:${row.id}`, documentRef: `HISTORY_${kind}:${row.id}`, documentNumber: row.reference_no ?? row.source_id, subjectId: row.subject_id, subjectName: displayName(row.subject_name, row.subject_id),
    bucket: distribution ? "PENDING_EARNINGS" : "AVAILABLE", direction, deltaCents: amount, knowledge: amount === null ? "UNKNOWN" : "KNOWN", kind,
    state: "HISTORICAL_OBSERVED", classification: row.included_in_opening ? "HISTORICAL_COVERED" : "HISTORICAL_UNCOVERED", affectsCurrentWallet: false, affectsCurrentLedger: false,
    occurredAt: row.at, importedAt: row.imported_at, sourceType: row.source_type, sourceSystem: row.source_system ?? "SOURCE_SYSTEM_UNKNOWN", sourceEntity: row.source_entity, sourceId: row.source_id, sourceDigest: row.source_digest, basisId: row.basis_id,
    reasonCodes: [...(row.included_in_opening ? [] : ["HISTORICAL_NOT_ADMITTED"]), ...(!earnings ? ["HISTORICAL_STATUS_NOT_CHANNEL_RESULT"] : []), ...(amount === null ? ["AMOUNT_OR_DIRECTION_UNKNOWN"] : [])], accountCode: null,
    evidence: { originalReference: row.reference_id ?? null, originalNumber: row.reference_no ?? null, originalStatus: row.source_status ?? null,
      originalNetCents: signedSourceCents(row.net), originalFeeCents: signedSourceCents(row.fee), historicalBalanceAfterCents: signedSourceCents(row.balance_after), dueAt: null, policyVersion: null }, related: [] };
}
export async function readFinanceSourceVersion(client: PoolClient) {
  const ready = (await client.query(`SELECT to_regclass('zzsh_order.wallet_coverage') IS NOT NULL AND to_regclass('zzsh_order.personal_finance_observation') IS NOT NULL AND to_regclass('zzsh_order.wallet_revision') IS NOT NULL AND to_regclass('zzsh_order.finance_economic_root') IS NOT NULL AND to_regclass('zzsh_order.finance_event') IS NOT NULL AND to_regclass('zzsh_order.finance_opening_basis') IS NOT NULL AS ready,
    to_regclass('zzsh_order.withdrawal_intent') IS NOT NULL AND to_regclass('zzsh_order.withdrawal_provider_fact') IS NOT NULL AND to_regclass('zzsh_order.controlled_payout_operation') IS NOT NULL AS withdrawals,
    to_regclass('zzsh_order.rental_order') IS NOT NULL AS native_orders,to_regclass('zzsh_order.legacy_order_read_snapshot') IS NOT NULL AS legacy_orders`)).rows[0];
  if (!ready?.ready) throw unavailable("Finance read foundation is not available");
  const version=(await client.query(financeVersionSql(ready))).rows[0]?.finance_version;
  if(typeof version!=="string")throw unavailable("Finance version evidence unavailable");
  const asOf=(await client.query(`SELECT ${utc("clock_timestamp()")} AS at`)).rows[0].at;
  return {ready,version,asOf};
}
export async function loadAdminFinanceFacts(client: PoolClient, scope: FinanceLoadScope = {}): Promise<FinanceFacts> {
  const {ready,version,asOf}=await readFinanceSourceVersion(client);
  const ledgerQuery=scopedFinanceSql(ADMIN_FINANCE_LEDGER_SQL,"ledger",scope,MAX_FACTS+1,ready.withdrawals);
  const historyQuery=scopedFinanceSql(ADMIN_FINANCE_OBSERVATION_SQL,"history",scope,MAX_FACTS+1,ready.withdrawals);
  const ledger=(await client.query(ledgerQuery.text,ledgerQuery.values)).rows,history=(await client.query(historyQuery.text,historyQuery.values)).rows;
  if(ledger.length+history.length>MAX_FACTS)throw new SecurityApiError(503,"EVIDENCE_UNAVAILABLE","Matching finance result exceeds 20000; apply a narrower subject, period or query",[{path:"finance.matchingLimit.20000",code:"INVALID_FIELD"}]);
  const orders=await loadFinanceOrderFacts(client,ready,scope,history);
  const subjectIds=[...new Set([...ledger.map(row=>row.subject_id),...history.map(row=>row.subject_id),...orders.flatMap(order=>[order.ownerId,order.renterId]),scope.subjectId,scope.filters?.scope!=="ALL"?scope.filters?.scope:undefined].filter((id):id is string=>typeof id==="string"))];
  const subjects=(await client.query(`SELECT id,COALESCE(name,id) AS name FROM zzsh_auth_user."user" WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C"`,[subjectIds])).rows.map(row=>({id:String(row.id),name:displayName(row.name,String(row.id))}));
  let subjectCandidates:FinanceFacts["subjectCandidates"];
  if(!scope.documentRef&&!scope.subjectId&&scope.filters?.q&&!scope.filters.q.startsWith("ORDER_LINK:")){
    const search="%"+scope.filters.q.replace(/[\\%_]/g,value=>"\\"+value).toLocaleLowerCase("zh-CN")+"%",limit=scope.pageSize??20,offset=((scope.page??1)-1)*limit;
    const predicate=`lower(id) LIKE $1 ESCAPE '\\' OR lower(COALESCE(name,'')) LIKE $1 ESCAPE '\\'`;
    const count=(await client.query(`SELECT count(*)::text AS total FROM zzsh_auth_user."user" WHERE ${predicate}`,[search])).rows[0]?.total??"0";
    const candidates=(await client.query(`SELECT id,COALESCE(name,id) AS name FROM zzsh_auth_user."user" WHERE ${predicate} ORDER BY id COLLATE "C" LIMIT $2 OFFSET $3`,[search,limit,offset])).rows;
    subjectCandidates={items:candidates.map(row=>({id:String(row.id),name:displayName(row.name,String(row.id))})),total:Number(count)};
  }
  const intentIds=[...new Set(ledger.filter(row=>row.source_entity==="withdrawal_intent").map(row=>row.source_id))];
  const withdrawals:Raw[]=ready.withdrawals&&intentIds.length?(await client.query(`SELECT i.id,i.user_id,i.state,i.operation_version::text,i.funds_disposition,i.gross_cents::text,i.net_cents::text,i.fee_cents::text,i.policy_version,
    ${utc("i.accepted_at")} AS accepted_at,i.terminal->>'state' AS terminal_state,i.terminal->>'reference' AS terminal_reference,
    f.id AS query_ref,${utc("f.observed_at")} AS queried_at FROM zzsh_order.withdrawal_intent i LEFT JOIN zzsh_order.withdrawal_provider_fact f ON f.id=i.last_provider_fact_id WHERE i.id=ANY($1::text[]) ORDER BY i.id COLLATE "C"`,[intentIds])).rows:[];
  const operations=ready.withdrawals&&intentIds.length?(await client.query(`SELECT id,intent_id,final_evidence_digest,${utc("recorded_at")} AS at,final_evidence_canonical::jsonb->>'outcome' AS outcome,final_evidence_canonical::jsonb->>'reference' AS reference FROM zzsh_order.controlled_payout_operation WHERE intent_id=ANY($1::text[]) ORDER BY id COLLATE "C"`,[intentIds])).rows:[];
  const entries=[...ledger.map(projectAdminFinanceLedger),...history.map(projectAdminFinanceObservation)];
  for(const entry of entries.filter(row=>row.sourceType==="LEGACY_MYSQL")){
    const linked=matchFinanceOrderReference(entry,orders);entry.related.push(...linked.map(order=>({ref:order.ref,label:linked.length>1?`${order.number} · ${order.sourceId}`:order.number})));
    if(entry.evidence.originalReference||entry.evidence.originalNumber){if(!linked.length)entry.reasonCodes.push("ORIGINAL_ORDER_REFERENCE_UNRESOLVED");if(linked.length>1)entry.reasonCodes.push("ORIGINAL_ORDER_REFERENCE_AMBIGUOUS");}
  }
  const intentById = new Map(withdrawals.map(row => [row.id, row]));
  const operationByIntent = new Map(operations.map(row => [row.intent_id, row]));
  for (const entry of entries) if (entry.documentRef.startsWith("WITHDRAWAL:")) {
    const intent = intentById.get(entry.documentRef.slice("WITHDRAWAL:".length));
    if (intent) { entry.state = intent.state; entry.evidence = { ...entry.evidence, intentId: intent.id, mode: "LOCAL_CONTROLLED", fundsDisposition: intent.funds_disposition,
      grossCents: cents(intent.gross_cents), netCents: cents(intent.net_cents), feeCents: cents(intent.fee_cents), policyVersion: intent.policy_version,
      acceptedAt: intent.accepted_at, operationVersion: intent.operation_version, channelState: intent.terminal_state ?? null,
      channelReference: intent.terminal_reference ?? null, queryRef: intent.query_ref ?? null, queriedAt: intent.queried_at ?? null };
      entry.reasonCodes.push("LOCAL_CONTROLLED_NOT_BANK_RECEIPT");
      const operation = operationByIntent.get(intent.id);
      if (operation) { entry.evidence.originalOperationRef = operation.id; entry.evidence.originalOperationRecordedAt = operation.at; entry.evidence.originalOperationOutcome = operation.outcome; entry.evidence.originalOperationReference = operation.reference;
        if (intent.state !== operation.outcome) entry.reasonCodes.push("LOCAL_OPERATION_NOT_APPLIED"); }
    } else entry.reasonCodes.push("WITHDRAWAL_SOURCE_UNAVAILABLE");
  }
  return {entries,subjects,revisions:[],orders,subjectCandidates,withdrawalsReady:ready.withdrawals,asOf,version};
}

export function filterAdminFinanceEntries(facts: FinanceFacts, filter: FinanceFilters, period: boolean): FinanceEntry[] {
  const from = Date.parse(filter.from + "T00:00:00+08:00"), end = Date.parse(filter.to + "T00:00:00+08:00") + 86400_000;
  const query = filter.q.toLocaleLowerCase("zh-CN");
  const orderLinks = filter.q.startsWith("ORDER_LINK:") ? new Set((facts.orders ?? []).filter(order => order.id === filter.q.slice(11)).map(order => order.ref)) : null;
  return facts.entries.filter(entry => (filter.scope === "ALL" || entry.subjectId === filter.scope) && (filter.bucket === "ALL" || entry.bucket === filter.bucket) && (filter.kind === "ALL" || entry.kind === filter.kind) && (filter.state === "ALL" || entry.state === filter.state)
    && (orderLinks ? orderLinks.has(entry.documentRef) : !query || [entry.subjectId, entry.subjectName, entry.documentRef, entry.documentNumber, entry.sourceId, entry.id].some(value => value.toLocaleLowerCase("zh-CN").includes(query)))
    && (!period || entry.occurredAt === null || (Date.parse(entry.occurredAt) >= from && Date.parse(entry.occurredAt) < end)))
    .sort((a, b) => (b.occurredAt ?? "").localeCompare(a.occurredAt ?? "") || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}
type Snapshot = { audience: string; keyId: string; actor: string; session: string; access: string; filters: string; version: string; asOf: string; expiresAt: number };
export function financeSnapshot(facts: FinanceFacts, filters: FinanceFilters, actor: FinanceActor, key: ListingCursorKey | undefined, token?: string | null, now = Date.now()): { token: string; asOf: string } {
  requireListingCursorKey(key);
  const binding = { audience: ADMIN_FINANCE_VERSION, keyId: key.keyId, actor: digest(actor.userId), session: digest(actor.sessionId), access: actor.authorizationKey, filters: digest(filters), version: facts.version };
  let snapshot: Snapshot;
  if (token) {
    try {
      if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw Error();
      const [payload, signature] = token.split(".") as [string, string];
      const expected = createHmac("sha256", key.secret).update(payload).digest(), actual = Buffer.from(signature, "base64url");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
      snapshot = JSON.parse(Buffer.from(payload, "base64url").toString()) as Snapshot;
      if (snapshot.audience !== binding.audience || snapshot.keyId !== binding.keyId || !Number.isFinite(snapshot.expiresAt) || snapshot.expiresAt <= now || snapshot.expiresAt > now + 600_000 || typeof snapshot.asOf !== "string" || !Number.isFinite(Date.parse(snapshot.asOf))) throw stale();
      for (const [name, value] of Object.entries(binding)) if (snapshot[name as keyof Snapshot] !== value) throw stale();
    } catch (error) { if (error instanceof SecurityApiError) throw error; throw invalid("Invalid finance snapshot"); }
  } else snapshot = { ...binding, asOf: facts.asOf, expiresAt: now + 600_000 };
  const payload = Buffer.from(JSON.stringify(snapshot)).toString("base64url");
  return { token: payload + "." + createHmac("sha256", key.secret).update(payload).digest("base64url"), asOf: snapshot.asOf };
}
export function financeDocuments(entries: FinanceEntry[]) {
  const groups = new Map<string, FinanceEntry[]>();
  for (const entry of entries) groups.set(entry.documentRef, [...(groups.get(entry.documentRef) ?? []), entry]);
  return [...groups].map(([ref, lines]) => ({ ref, number: lines[0]!.documentNumber, kind: lines[0]!.kind, state: lines[0]!.state, occurredAt: lines[0]!.occurredAt,
    requestedAmountCents: lines.find(entry => entry.evidence.grossCents !== undefined)?.evidence.grossCents ?? null,
    subjects: [...new Map(lines.map(entry => [entry.subjectId, { id: entry.subjectId, name: entry.subjectName }])).values()], entryCount: lines.length,
    amounts: [...new Map(lines.map(entry => [entry.bucket, entry.bucket])).values()].map(bucket => ({ bucket, knownNetCents: lines.filter(entry => entry.bucket === bucket && entry.deltaCents !== null).reduce((sum, entry) => sum + BigInt(entry.deltaCents!), 0n).toString(), unknownCount: lines.filter(entry => entry.bucket === bucket && entry.deltaCents === null).length })) }));
}
export function financeOrderDocuments(facts: FinanceFacts, filter: FinanceFilters) {
  const query = filter.q.toLocaleLowerCase("zh-CN"), from = Date.parse(filter.from + "T00:00:00+08:00"), end = Date.parse(filter.to + "T00:00:00+08:00") + 86400_000;
  return (facts.orders ?? []).filter(order => (filter.scope === "ALL" || [order.ownerId, order.renterId].includes(filter.scope)) && filter.bucket === "ALL" && ["ALL", "SETTLEMENT"].includes(filter.kind) && ["ALL", order.state].includes(filter.state)
    && (!filter.period || !order.occurredAt || Date.parse(order.occurredAt) >= from && Date.parse(order.occurredAt) < end)
    && (filter.q.startsWith("ORDER_LINK:") ? order.id === filter.q.slice(11) : !query || [order.ref, order.number, order.id, order.sourceId, order.ownerId, order.renterId, ...facts.subjects.filter(subject => subject.id === order.ownerId || subject.id === order.renterId).map(subject => subject.name)].some(value => value.toLocaleLowerCase("zh-CN").includes(query))))
    .map(order => ({ ref: order.ref, number: order.number, kind: order.kind, state: order.state, occurredAt: order.occurredAt, requestedAmountCents: null,
      subjects: [order.ownerId, order.renterId].map(id => ({ id, name: facts.subjects.find(subject => subject.id === id)?.name ?? id })), entryCount: 0, amounts: [] }));
}
export function financePeriodProjection(entries: FinanceEntry[]) {
  return FINANCE_BUCKETS.map(bucket => {
    const lines = entries.filter(entry => entry.bucket === bucket), posted = lines.filter(entry => entry.affectsCurrentLedger);
    const known = posted.filter(entry => entry.deltaCents !== null), movements = known.filter(entry => entry.classification !== "OPENING");
    return { bucket, knownInflows: movements.filter(entry => BigInt(entry.deltaCents!) >= 0n).reduce((sum, entry) => sum + BigInt(entry.deltaCents!), 0n).toString(),
      knownOutflows: movements.filter(entry => BigInt(entry.deltaCents!) < 0n).reduce((sum, entry) => sum - BigInt(entry.deltaCents!), 0n).toString(),
      migrationMovement: known.filter(entry => entry.classification === "OPENING").reduce((sum, entry) => sum + BigInt(entry.deltaCents!), 0n).toString(),
      openingBalance: null, closingBalance: null, difference: null, knowledge: "UNKNOWN", reasonCodes: ["PERIOD_BALANCE_PROOF_NOT_AVAILABLE"],
      unknownCount: posted.length - known.length, unknownTimeCount: lines.filter(entry => entry.occurredAt === null).length,
      coveredHistoricalCount: lines.filter(entry => entry.classification === "HISTORICAL_COVERED").length, uncoveredHistoricalCount: lines.filter(entry => entry.classification === "HISTORICAL_UNCOVERED").length };
  });
}
export async function readAdminFinanceSubject(client: PoolClient, facts: FinanceFacts, id: string, asOf: string) {
  const subject = facts.subjects.find(row => row.id === id); if (!subject) throw notFound();
  const wallet = await readPersonalWallet(client, id);
  return { subject, wallet: { ...wallet, asOf }, documents: financeDocuments(facts.entries.filter(entry => entry.subjectId === id)),
    gaps: ["PERIOD_BALANCE_PROOF_NOT_AVAILABLE", "GLOBAL_RESERVED_AND_WITHDRAWABLE_NOT_ADMITTED"], sourcesReady: { withdrawals: facts.withdrawalsReady, nativeDistribution: false } };
}
export function readAdminFinanceDocument(facts: FinanceFacts, ref: string, entryId?: string | null) {
  const entries = facts.entries.filter(entry => entry.documentRef === ref);
  const order = facts.orders?.find(row => row.ref === ref);
  if (!entries.length && !order || entryId && !entries.some(entry => entry.id === entryId)) throw notFound();
  const document = financeDocuments(entries)[0] ?? { ref, number: order!.number, kind: order!.kind, state: order!.state, occurredAt: order!.occurredAt, requestedAmountCents: null, subjects: [order!.ownerId, order!.renterId].map(id => ({ id, name: facts.subjects.find(subject => subject.id === id)?.name ?? id })), entryCount: 0, amounts: [] };
  const evidence = entries.reduce<Record<string, string | null>>((result, entry) => ({ ...result, ...entry.evidence }), {});
  const related = [...new Map(entries.flatMap(entry => entry.related).map(link => [link.ref, link])).values()].filter(link => link.ref !== ref || link.path);
  if (order) {
    Object.assign(evidence, { originalOrderNumber: order.number, originalOrderId: order.sourceId, originalOrderStatus: order.originalOrderStatus, ...(order.sourceType === "LEGACY_MYSQL" ? { originalPaymentStatus: order.originalPaymentStatus, recordedPaidCents: order.recordedPaidCents } : {}), ownerSubjectId: order.ownerId, renterSubjectId: order.renterId, recordedDueCents: order.dueCents, recordedDepositCents: order.depositCents, orderSourceType: order.sourceType, orderSourceSystem: order.sourceSystem, orderSourceDigest: order.sourceDigest });
    related.push({ ref, label: "订单详情", path: `/orders/${encodeURIComponent(order.id)}` }, { ref: order.accountId, label: "资源账号", path: `/supply/accounts/${encodeURIComponent(order.accountId)}` });
    related.push(...facts.entries.filter(entry => entry.related.some(link => link.ref === ref)).map(entry => ({ ref: entry.documentRef, label: entry.documentNumber })));
  }
  return { document, entries, evidence, related: [...new Map(related.map(link => [link.ref + (link.path ?? ""), link])).values()], reasonCodes: [...new Set([...entries.flatMap(entry => entry.reasonCodes), ...(order ? ["ORDER_RECORD_NOT_CHANNEL_RESULT", ...(!entries.length ? ["ORDER_NO_CURRENT_POSTING"] : [])] : [])])],
    platform: { postedComponents: entries.filter(entry => entry.bucket === "PLATFORM").map(entry => ({ accountCode: entry.accountCode, deltaCents: entry.deltaCents })), beforeDistributionCents: null, distributionExpenseCents: null, retainedCents: null, channelCostCents: null, netProfitCents: null, reasonCodes: ["DISTRIBUTION_AND_CHANNEL_COST_NOT_ADMITTED"] } };
}
