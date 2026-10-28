import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import { readOrderPaymentSummary, type AdminOrderPaymentSummary, type AdminPaymentAnomalySection, type ChannelPaymentReadOptions } from "../order/channel-payment-read";
import { exactCents } from "./finance-money";
import { readAdminOrderRefundSummary } from "./channel-finance-read";
import { nativeProjection } from "./personal-withdrawal-history";

type Client = PoolClient;
type Row = Record<string, unknown>;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const WIDE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const ORDER_NO = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const TRX_NO = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const CODE = /^[A-Z0-9_]{1,64}$/;
const ISO = /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}(?:\d{3})?Z$/;
const DIGEST = /^[a-f0-9]{64}$/;
const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

export const CHANNEL_EVIDENCE_PRODUCTS = ["ALIPAY_NATIVE", "WEIXIN_NATIVE", "REFUND", "PAYOUT"] as const;
export type ChannelProductFamily = (typeof CHANNEL_EVIDENCE_PRODUCTS)[number];
export type ChannelMoney = Readonly<{ cents: string; currency: "CNY" }>;
type PaymentOrigin = "NATIVE" | "LEGACY";

declare const channelEvidenceScopeBrand: unique symbol;
export type ChannelEvidenceReadScope = Readonly<{ readonly [channelEvidenceScopeBrand]: "ChannelEvidenceReadScope" }>;
type ScopeData = Readonly<{ database: string; runtimeUser: string; adminId: string; merchantIds: ReadonlySet<string>;
  financeReadable: boolean; orderReadable: boolean; userReadable: boolean;
  readableOrderIds: ReadonlySet<string>; readableUserIds: ReadonlySet<string> }>;
export type ChannelEvidenceScopeInput = Readonly<{ database: string; runtimeUser: string; adminId: string;
  merchantIds: readonly string[]; financeReadable: boolean; orderReadable: boolean; userReadable: boolean;
  readableOrderIds?: readonly string[]; readableUserIds?: readonly string[] }>;
const scopeRegistry = new WeakMap<object, ScopeData>();

const unavailable = (message: string) => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", message);
const forbidden = (message: string) => new SecurityApiError(403, "FORBIDDEN", message);
const invalid = (message: string) => new SecurityApiError(400, "INVALID_ARGUMENT", message);
const notFound = () => new SecurityApiError(404, "NOT_FOUND", "Channel evidence object not found");

/** 只接受服务端根据真实会话/权限/对象范围铸造的 token；普通对象或浏览器布尔值不放行。 */
export function createChannelEvidenceReadScope(input: ChannelEvidenceScopeInput): ChannelEvidenceReadScope {
  if (!input || typeof input !== "object") throw invalid("Invalid channel evidence scope");
  const { database, runtimeUser, adminId, merchantIds, financeReadable, orderReadable, userReadable } = input;
  if (typeof database !== "string" || !WIDE_ID.test(database) || typeof runtimeUser !== "string" || !WIDE_ID.test(runtimeUser)
    || typeof adminId !== "string" || !WIDE_ID.test(adminId) || !Array.isArray(merchantIds) || merchantIds.length > 256
    || typeof financeReadable !== "boolean" || typeof orderReadable !== "boolean" || typeof userReadable !== "boolean") {
    throw invalid("Invalid channel evidence scope");
  }
  const merchants = new Set<string>();
  for (const merchant of merchantIds) {
    if (typeof merchant !== "string" || !ID.test(merchant)) throw invalid("Invalid channel evidence merchant scope");
    merchants.add(merchant);
  }
  const objectIds = (value: readonly string[] | undefined) => {
    if (value === undefined) return new Set<string>();
    if (!Array.isArray(value) || value.length > 256 || value.some(v => typeof v !== "string" || !WIDE_ID.test(v))) throw invalid("Invalid channel evidence object scope");
    return new Set<string>(value);
  };
  const readableOrderIds = objectIds(input.readableOrderIds), readableUserIds = objectIds(input.readableUserIds);
  const token = Object.freeze({}) as ChannelEvidenceReadScope;
  scopeRegistry.set(token, Object.freeze({ database, runtimeUser, adminId, merchantIds: merchants,
    financeReadable, orderReadable, userReadable, readableOrderIds, readableUserIds }));
  return token;
}

function scopeData(scope: unknown): ScopeData {
  const data = scope && typeof scope === "object" ? scopeRegistry.get(scope) : undefined;
  if (!data) throw forbidden("Channel evidence scope is not server-issued");
  return data;
}

function requireMerchant(data: ScopeData, merchantIdentityId: unknown): string {
  if (typeof merchantIdentityId !== "string" || !ID.test(merchantIdentityId)) throw invalid("Invalid merchant identity");
  if (!data.merchantIds.has(merchantIdentityId)) throw notFound();
  return merchantIdentityId;
}

function requireStoredMerchant(data: ScopeData, value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw unavailable("Channel evidence merchant binding is unavailable");
  return requireMerchant(data, value);
}

/** 真实资源核验只读 current_database/current_user；调用方必须复用同一已有 client/事务。 */
async function assertResource(client: Client, data: ScopeData): Promise<string> {
  const row = (await client.query<Row>(`SELECT current_database() AS database,current_user AS runtime_user,
    ${utc("clock_timestamp()")} AS as_of`)).rows[0];
  if (!row || row.database !== data.database || row.runtime_user !== data.runtimeUser
    || typeof row.as_of !== "string" || !ISO.test(row.as_of)) throw unavailable("Channel evidence resource differs");
  return row.as_of;
}

/** 预检只回答 schema/列权限/资源类型；缺表返回 false，不把查询异常伪装成“无记录”。 */
async function schemaReady(client: Client, table: string, columns: readonly string[]): Promise<boolean> {
  const row = (await client.query<Row>(`SELECT to_regclass($1) IS NOT NULL
    AND (SELECT count(*)=$3::integer FROM pg_attribute a WHERE a.attrelid=to_regclass($1) AND a.attnum>0 AND NOT a.attisdropped
      AND a.attname=ANY($2::text[]) AND has_column_privilege(current_user,a.attrelid,a.attnum,'SELECT'))
    AND EXISTS(SELECT 1 FROM pg_class t JOIN pg_roles p ON p.rolname=current_user WHERE t.oid=to_regclass($1)
      AND t.relkind='r' AND t.relpersistence='p' AND NOT t.relrowsecurity AND NOT p.rolsuper AND NOT p.rolbypassrls) AS ready`,
    [table, columns, columns.length])).rows[0];
  return row?.ready === true;
}

const add = (list: string[], code: string) => { if (!list.includes(code)) list.push(code); };
const code = (value: unknown): string | null => typeof value === "string" && CODE.test(value) ? value : null;
const id = (value: unknown): string | null => typeof value === "string" && WIDE_ID.test(value) ? value : null;
const iso = (value: unknown): string | null => typeof value === "string" && ISO.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value.slice(0, 23) + "Z" ? value : null;
const integer = (value: unknown): number | null => typeof value === "number" && Number.isSafeInteger(value) ? value : null;
const digestRef = (value: unknown): string | null => typeof value === "string" && DIGEST.test(value) ? `sha256:${value}` : null;
const epochMs = (value: string) => {
  const parsed = Date.parse(value.slice(0, 23) + "Z");
  return Number.isFinite(parsed) ? parsed : null;
};
function ageSeconds(asOf: string, observedAt: string | null): number | null {
  if (!observedAt) return null;
  const end = epochMs(asOf), start = epochMs(observedAt);
  return end === null || start === null ? null : Math.max(0, Math.floor((end - start) / 1000));
}
function money(cents: unknown, currency: unknown, reasons: string[], invalidCode: string, currencyCode: string): ChannelMoney | null {
  if (cents === null || cents === undefined) return null;
  if (currency !== "CNY") { add(reasons, currencyCode); return null; }
  try { return { cents: exactCents(cents), currency: "CNY" }; } catch { add(reasons, invalidCode); return null; }
}
const sumCents = (values: readonly string[]) => values.reduce((total, value) => total + BigInt(value), 0n).toString();

// ---------- A. 收款证据投影 ----------

export type ChannelPaymentEvidence = Readonly<{
  contractVersion: "admin-channel-payment-evidence.v1";
  status: "AVAILABLE" | "NOT_INTEGRATED" | "NOT_APPLICABLE";
  integration: AdminOrderPaymentSummary["integration"];
  coverage: "LOCAL_REGISTERED_ONLY";
  orderId: string;
  requestId: string | null;
  merchantIdentityId: string | null;
  merchantOrderNo: string | null;
  productFamily: ChannelProductFamily | "UNKNOWN";
  dataOrigin: AdminOrderPaymentSummary["dataOrigin"];
  request: Readonly<{ state: string | null; amount: ChannelMoney | null; currency: string | null; protocolVersion: string | null;
    createdAt: string | null; updatedAt: string | null }> | null;
  trustedObservation: Readonly<{ source: string; evidenceLevel: string; channelStatus: "SUCCEEDED" | "FAILED" | "CREATED_UNPAID" | null;
    channelTrxNo: string | null; evidenceRef: string | null; observedAt: string; ageSeconds: number | null;
    providerPaidAtRaw: string | null; providerPaidAt: string | null; providerTimeZone: string | null; providerTimeOffsetMinutes: number | null;
    trust: "EXISTING_READER_PROJECTION" }> | null;
  acceptance: Readonly<{ state: "APPLIED" | "REVIEW_REQUIRED" | "PENDING" | "NONE"; confirmationId: string | null;
    reasonCode: string | null; acceptedAmount: ChannelMoney | null; acceptedAt: string | null }>;
  anomalies: AdminPaymentAnomalySection | null;
  lastFailure: Readonly<{ kind: "TRANSPORT_FAILURE" | "REJECTED_BY_CHANNEL" | "CHANNEL_REPORTED_FAILED" | "SCHEMA_INVALID"
    | "SIGNATURE_MISMATCH" | "BINDING_MISMATCH" | "INCOMPLETE_RESPONSE" | "HTTP_ERROR"; observedAt: string; ageSeconds: number | null;
    evidenceRef: string | null; httpStatus: number | null; event: string | null; failureCode: string | null;
    trust: "LOCAL_OBSERVATION_NOT_TRUSTED"; usedForAcceptance: false }> | null;
  lastConflict: Readonly<{ kind: "CHANNEL_STATUS_CONFLICT" | "STALE" | "LATE" | "DUPLICATE"; observedAt: string;
    ageSeconds: number | null; evidenceRef: string | null }> | null;
  conflictCount: number;
  conflictsTruncated: boolean;
  amounts: Readonly<{ requested: ChannelMoney | null; trustedChannel: ChannelMoney | null; accepted: ChannelMoney | null }>;
  fees: Readonly<{ paymentFee: ChannelMoney | null; bankTrxNo: string | null; settleAmount: ChannelMoney | null;
    settleDerivation: "NOT_COMPUTED"; reasons: readonly string[] }>;
  settlementIntegration: "NOT_INTEGRATED";
  providerTimeSeparated: true;
  bankArrival: "UNKNOWN";
  reasonCodes: readonly string[];
  unknowns: readonly string[];
  asOf: string;
}>;

async function readAcceptedTotal(client: Client, confirmationId: string, orderId: string, reasons: string[]): Promise<Readonly<{
  amount: ChannelMoney | null; acceptedAt: string | null }>> {
  const rows = (await client.query<Row>(`SELECT amount_cents::text AS amount_cents,currency,${utc("accepted_at")} AS accepted_at
    FROM zzsh_order.payment_confirmation WHERE id=$1 AND order_id=$2 AND disposition='APPLIED' LIMIT 2`,
  [confirmationId, orderId])).rows;
  if (rows.length === 0) { add(reasons, "ACCEPTANCE_RECORD_NOT_READ"); return { amount: null, acceptedAt: null }; }
  if (rows.length > 1) { add(reasons, "MULTIPLE_ACCEPTANCE_RECORDS"); return { amount: null, acceptedAt: null }; }
  const row = rows[0]!;
  const acceptedAt = iso(row.accepted_at);
  if (!acceptedAt) add(reasons, "ACCEPTANCE_TIME_UNREADABLE");
  const amount = money(row.amount_cents, row.currency, reasons, "ACCEPTANCE_AMOUNT_INVALID", "ACCEPTANCE_CURRENCY_NOT_CNY");
  if (amount === null) add(reasons, "ACCEPTANCE_AMOUNT_UNAVAILABLE");
  return { amount, acceptedAt };
}

async function readLocalRequestState(client: Client, requestId: string, orderId: string,
  reasons: string[]): Promise<Readonly<{ state: string; updatedAt: string }> | null> {
  const rows = (await client.query<Row>(`SELECT state,${utc("updated_at")} AS updated_at
    FROM zzsh_order.payment_request WHERE id=$1 AND order_id=$2 LIMIT 2`, [requestId, orderId])).rows;
  if (rows.length === 0) { add(reasons, "PAYMENT_REQUEST_STATE_NOT_READ"); return null; }
  if (rows.length > 1) { add(reasons, "MULTIPLE_PAYMENT_REQUESTS"); return null; }
  const state = code(rows[0]!.state), updatedAt = iso(rows[0]!.updated_at);
  if (!state || !updatedAt) { add(reasons, "PAYMENT_REQUEST_STATE_UNREADABLE"); return null; }
  return { state, updatedAt };
}

async function lastCollectionFailure(client: Client, requestId: string, asOf: string, reasons: string[]) {
  if (!await schemaReady(client, "zzsh_order.joinpay_collection_observation",
    ["id", "request_id", "operation", "event", "http_status", "response_complete", "transport_failure", "schema_outcome",
      "signature_outcome", "binding_outcome", "raw_sha256", "created_at"])) {
    add(reasons, "COLLECTION_OBSERVATION_SCHEMA_UNAVAILABLE");
    return null;
  }
  const row = (await client.query<Row>(`SELECT o.event,o.http_status,o.transport_failure,o.response_complete,o.schema_outcome,
      o.signature_outcome,o.binding_outcome,o.raw_sha256,${utc("o.created_at")} AS observed_at
    FROM zzsh_order.joinpay_collection_observation o
    WHERE o.request_id=$1 AND (o.transport_failure IS NOT NULL OR o.event IN('E2','E5')
      OR (o.operation<>'NOTIFY' AND (o.response_complete IS NOT TRUE OR o.http_status IS DISTINCT FROM 200))
      OR o.schema_outcome<>'VALID' OR o.signature_outcome<>'MATCH' OR o.binding_outcome<>'MATCH')
    ORDER BY o.created_at DESC,o.id COLLATE "C" DESC LIMIT 1`, [requestId])).rows[0];
  if (!row) { add(reasons, "NO_FAILURE_OBSERVATION_RECORDED"); return null; }
  const observedAt = iso(row.observed_at);
  if (!observedAt) { add(reasons, "FAILURE_OBSERVATION_TIME_UNREADABLE"); return null; }
  const transportRecorded = row.transport_failure !== null && row.transport_failure !== undefined;
  const transport = typeof row.transport_failure === "string" && CODE.test(row.transport_failure) ? row.transport_failure : null;
  const kind: NonNullable<ChannelPaymentEvidence["lastFailure"]>["kind"] = transportRecorded ? "TRANSPORT_FAILURE"
    : row.event === "E2" ? "REJECTED_BY_CHANNEL" : row.event === "E5" ? "CHANNEL_REPORTED_FAILED"
    : row.schema_outcome !== "VALID" ? "SCHEMA_INVALID" : row.signature_outcome !== "MATCH" ? "SIGNATURE_MISMATCH"
    : row.binding_outcome !== "MATCH" ? "BINDING_MISMATCH" : row.response_complete === false ? "INCOMPLETE_RESPONSE" : "HTTP_ERROR";
  return { kind, observedAt, ageSeconds: ageSeconds(asOf, observedAt), evidenceRef: digestRef(row.raw_sha256),
    httpStatus: integer(row.http_status), event: code(row.event), failureCode: transport,
    trust: "LOCAL_OBSERVATION_NOT_TRUSTED" as const, usedForAcceptance: false as const };
}

function notIntegratedPayment(orderId: string, asOf: string, status: "NOT_INTEGRATED" | "NOT_APPLICABLE",
  reasonCode: string): ChannelPaymentEvidence {
  return { contractVersion: "admin-channel-payment-evidence.v1", status, integration: "NOT_INTEGRATED", coverage: "LOCAL_REGISTERED_ONLY",
    orderId, requestId: null, merchantIdentityId: null, merchantOrderNo: null, productFamily: "UNKNOWN", dataOrigin: "UNKNOWN",
    request: null, trustedObservation: null,
    acceptance: { state: "NONE", confirmationId: null, reasonCode: null, acceptedAmount: null, acceptedAt: null },
    anomalies: null, lastFailure: null, lastConflict: null, conflictCount: 0, conflictsTruncated: false,
    amounts: { requested: null, trustedChannel: null, accepted: null },
    fees: { paymentFee: null, bankTrxNo: null, settleAmount: null, settleDerivation: "NOT_COMPUTED", reasons: [reasonCode] },
    settlementIntegration: "NOT_INTEGRATED", providerTimeSeparated: true, bankArrival: "UNKNOWN",
    reasonCodes: [reasonCode, "LOCAL_REGISTERED_ONLY"], unknowns: [], asOf };
}

/** 前置：Admin 已按 order/game/object 范围选中该订单；此函数只消费既有 summary/formal-read，不重验渠道原件。 */
export async function readAdminChannelPaymentEvidence(client: Client, scope: ChannelEvidenceReadScope, input: {
  orderId: string; origin: PaymentOrigin; readOptions?: ChannelPaymentReadOptions;
}): Promise<ChannelPaymentEvidence> {
  const data = scopeData(scope);
  if (!data.orderReadable) throw notFound();
  if (!input || typeof input.orderId !== "string" || !ID.test(input.orderId)
    || (input.origin !== "NATIVE" && input.origin !== "LEGACY")) throw invalid("Invalid payment evidence request");
  if (!data.readableOrderIds.has(input.orderId)) throw notFound();
  const asOf = await assertResource(client, data);
  if (input.origin !== "NATIVE") return notIntegratedPayment(input.orderId, asOf, "NOT_APPLICABLE", "LEGACY_PAYMENT_SOURCE_NOT_INTEGRATED");
  const summary = await readOrderPaymentSummary(client,
    { orderId: input.orderId, origin: "NATIVE", financeReadable: data.financeReadable }, input.readOptions ?? {});
  if (summary.integration === "NOT_INTEGRATED") {
    return notIntegratedPayment(input.orderId, asOf, "NOT_INTEGRATED", "PAYMENT_EVIDENCE_NOT_INTEGRATED_OR_NOT_RECORDED");
  }
  const finance = data.financeReadable, reasons: string[] = [];
  const request = summary.originalRequest;
  let authorizedMerchant = request?.merchantIdentityId ?? null;
  if (finance && summary.integration === "JOINPAY") {
    if (!authorizedMerchant && summary.dataOrigin === "JOINPAY_PROVIDER" && summary.acceptance?.confirmationId) {
      const rows = (await client.query<Row>(`SELECT merchant_scope_id FROM zzsh_order.payment_confirmation
        WHERE id=$1 AND order_id=$2 AND source='JOINPAY' AND disposition='APPLIED' LIMIT 2`,
      [summary.acceptance.confirmationId, input.orderId])).rows;
      authorizedMerchant = rows.length === 1 && typeof rows[0]!.merchant_scope_id === "string" ? rows[0]!.merchant_scope_id : null;
    }
    requireStoredMerchant(data, authorizedMerchant);
  }
  const anomalies = summary.anomalies ?? null;
  if (finance) for (const item of anomalies?.items ?? []) {
    if (item.source === "CONFIRMATION" && item.evidenceLevel === "JOINPAY_CONFIRMATION") requireStoredMerchant(data, item.merchantIdentityId);
  }
  const method = request?.method ?? null;
  const productFamily: ChannelProductFamily | "UNKNOWN" = method === "ALIPAY_NATIVE" || method === "WEIXIN_NATIVE" ? method : "UNKNOWN";
  if (method !== null && productFamily === "UNKNOWN") add(reasons, "UNKNOWN_PAYMENT_PRODUCT_FAMILY");
  if (summary.dataOrigin === "UNKNOWN") add(reasons, "UNKNOWN_PAYMENT_SOURCE");
  if (!finance) add(reasons, "FINANCE_PERMISSION_REDACTED");
  if (finance && !request) add(reasons, "PAYMENT_REQUEST_NOT_RECORDED");
  if (finance && request && request.merchantIdentityId === null) add(reasons, "MERCHANT_IDENTITY_NOT_RECORDED");
  if (finance && request && request.channelOrderNo === null) add(reasons, "MERCHANT_ORDER_NUMBER_NOT_RECORDED");
  const requestAmount = request && finance
    ? money(request.amount?.cents, request.amount?.currency, reasons, "PAYMENT_REQUEST_AMOUNT_INVALID", "PAYMENT_REQUEST_CURRENCY_NOT_CNY")
    : null;
  if (finance && request && request.amount === null) add(reasons, "PAYMENT_REQUEST_AMOUNT_NOT_RECORDED");
  let acceptedAmount: ChannelMoney | null = null, acceptedAt: string | null = null;
  const acceptance = summary.acceptance;
  if (finance && acceptance?.state === "APPLIED" && acceptance.confirmationId) {
    const accepted = await readAcceptedTotal(client, acceptance.confirmationId, input.orderId, reasons);
    acceptedAmount = accepted.amount; acceptedAt = accepted.acceptedAt;
  } else if (finance && acceptance?.state === "REVIEW_REQUIRED") add(reasons, "PAYMENT_UNDER_REVIEW");
  else if (finance) add(reasons, "PAYMENT_NOT_ACCEPTED");
  const localRequest = request ? await readLocalRequestState(client, request.id, input.orderId, reasons) : null;

  let trustedObservation: ChannelPaymentEvidence["trustedObservation"] = null;
  const obs = summary.latestTrustedObservation;
  if (obs) {
    const observedAt = iso(obs.observedAt);
    const evidenceRef = typeof obs.evidenceRef === "string" && /^sha256:[a-f0-9]{64}$/.test(obs.evidenceRef) ? obs.evidenceRef : null;
    if (!observedAt) add(reasons, "TRUSTED_OBSERVATION_TIME_UNREADABLE");
    else {
      if (evidenceRef === null) add(reasons, "TRUSTED_OBSERVATION_EVIDENCE_REF_UNREADABLE");
      const status = obs.channelStatus === "SUCCEEDED" || obs.channelStatus === "FAILED" || obs.channelStatus === "CREATED_UNPAID"
        ? obs.channelStatus : null;
      const trx = finance && typeof obs.channelTrxNo === "string" && TRX_NO.test(obs.channelTrxNo) ? obs.channelTrxNo : null;
      const formal = "providerPaidAt" in obs;
      trustedObservation = { source: code(obs.source) ?? "UNKNOWN", evidenceLevel: code(obs.evidenceLevel) ?? "UNKNOWN",
        channelStatus: status, channelTrxNo: trx, evidenceRef, observedAt, ageSeconds: ageSeconds(asOf, observedAt),
        providerPaidAtRaw: formal && typeof obs.providerPaidAtRaw === "string" ? obs.providerPaidAtRaw : null,
        providerPaidAt: formal ? iso(obs.providerPaidAt) : null,
        providerTimeZone: formal ? (obs.providerTimeZone === "EXPLICIT_OFFSET" ? "EXPLICIT_OFFSET" : "UNCONFIRMED")
          : (obs.providerTimeZone === "UNCONFIRMED" ? "UNCONFIRMED" : null),
        providerTimeOffsetMinutes: formal && Number.isInteger(obs.providerTimeOffsetMinutes) ? obs.providerTimeOffsetMinutes : null,
        trust: "EXISTING_READER_PROJECTION" };
    }
  } else add(reasons, "NO_TRUSTED_OBSERVATION_RECORDED");

  let lastFailure: ChannelPaymentEvidence["lastFailure"] = null;
  if (request && summary.integration === "JOINPAY") lastFailure = await lastCollectionFailure(client, request.id, asOf, reasons);

  let lastConflict: ChannelPaymentEvidence["lastConflict"] = null;
  const conflicts = summary.conflicts ?? [];
  if (conflicts.length > 0) {
    const first = conflicts[0]!;
    const observedAt = iso(first.observedAt);
    const kind = first.kind;
    if (!observedAt) add(reasons, "CONFLICT_TIME_UNREADABLE");
    else if (!["CHANNEL_STATUS_CONFLICT", "STALE", "LATE", "DUPLICATE"].includes(kind)) add(reasons, "CONFLICT_KIND_UNREADABLE");
    else lastConflict = { kind, observedAt, ageSeconds: ageSeconds(asOf, observedAt),
      evidenceRef: typeof first.evidenceRef === "string" && /^sha256:[a-f0-9]{64}$/.test(first.evidenceRef) ? first.evidenceRef : null };
  }
  const conflictsTruncated = (summary.unknowns ?? []).includes("CONFLICTS_TRUNCATED_TO_LATEST_100");
  if (conflictsTruncated) add(reasons, "CONFLICTS_TRUNCATED_TO_LATEST_100");
  if (finance) {
    add(reasons, "PAYMENT_FEE_NOT_RECORDED");
    add(reasons, "BANK_TRANSACTION_NOT_RECORDED");
    add(reasons, "SETTLE_AMOUNT_NOT_VERIFIED");
    add(reasons, "SETTLE_NOT_DERIVED_FROM_PAYMENT_MINUS_FEE");
  }
  if (summary.dataOrigin === "SYNTHETIC_PROTOCOL") add(reasons, "SYNTHETIC_OBSERVATION_NOT_CHANNEL_TRUTH");
  if (trustedObservation !== null) add(reasons, "TRUSTED_CHANNEL_AMOUNT_NOT_STORED");
  const unknowns = (summary.unknowns ?? []).filter((value): value is string => typeof value === "string" && CODE.test(value));
  return { contractVersion: "admin-channel-payment-evidence.v1", status: "AVAILABLE", integration: summary.integration,
    coverage: "LOCAL_REGISTERED_ONLY", orderId: input.orderId, requestId: request?.id ?? null,
    merchantIdentityId: finance ? authorizedMerchant : null,
    merchantOrderNo: finance ? request?.channelOrderNo ?? null : null,
    productFamily, dataOrigin: summary.dataOrigin,
    request: request ? { state: localRequest?.state ?? null, amount: requestAmount,
      currency: finance ? (typeof request.amount?.currency === "string" ? request.amount.currency : null) : null,
      protocolVersion: typeof request.protocolVersion === "string" ? request.protocolVersion : null,
      createdAt: iso(request.createdAt), updatedAt: localRequest?.updatedAt ?? null } : null,
    trustedObservation, acceptance: { state: acceptance?.state ?? "NONE", confirmationId: acceptance?.confirmationId ?? null,
      reasonCode: acceptance?.reasonCode ?? null, acceptedAmount, acceptedAt },
    anomalies,
    lastFailure, lastConflict, conflictCount: conflicts.length, conflictsTruncated,
    amounts: { requested: requestAmount, trustedChannel: null, accepted: acceptedAmount },
    fees: { paymentFee: null, bankTrxNo: null, settleAmount: null, settleDerivation: "NOT_COMPUTED",
      reasons: finance ? ["PAYMENT_FEE_NOT_RECORDED", "BANK_TRANSACTION_NOT_RECORDED", "SETTLE_AMOUNT_NOT_VERIFIED",
        "SETTLE_NOT_DERIVED_FROM_PAYMENT_MINUS_FEE"] : ["FINANCE_PERMISSION_REDACTED"] },
    settlementIntegration: "NOT_INTEGRATED", providerTimeSeparated: true, bankArrival: "UNKNOWN",
    reasonCodes: reasons, unknowns, asOf };
}

// ---------- B. 退款责任、意图与结果 ----------

export type ChannelRefundIntentEvidence = Readonly<{
  intentId: string; refundOrderNo: string; amount: ChannelMoney; localState: string; budgetDisposition: string;
  requiresReview: boolean; basisKind: "POSTING" | "REVIEW_CONFIRMATION" | "PRESTART_TERMINATION"; paymentConfirmationId: string | null;
  liabilityRootId: string | null; liabilityEventId: string | null;
  firstSubmit: Readonly<{ dispatch: "NEVER_DISPATCHED" | "DISPATCHED" | "UNKNOWN";
    blockedReason: "ORIGINAL_ORDER_NO_AMBIGUOUS" | "ABNORMAL_BASIS_REVIEW" | null; blockedAt: string | null;
    blockedAuditCount: number | null; trust: "LOCAL_AUDIT_AND_ATTEMPT" }> | null;
  localTerminal: Readonly<{ evidenceId: string | null; rootId: string | null; eventId: string | null }> | null;
  trustedActualCents: null; trustedRefundTrxNo: null; trustedCompletedAt: null; mayResubmit: false; bankArrival: "UNKNOWN";
}>;
export type ChannelAbnormalResponsibilityEvidence = Readonly<{
  confirmationId: string; reasonCode: string; originalCents: string | null; allocatedCents: string | null;
  consumedCents: string | null; releasedCents: string | null; remainingCents: string | null;
  totalsComplete: boolean; state: string; intentIds: readonly string[];
  liabilityRootId: string | null; liabilityEventId: string | null;
  firstSubmit: ChannelRefundIntentEvidence["firstSubmit"];
  reasonCodes: readonly string[];
}>;
export type ChannelRefundEvidence = Readonly<{
  contractVersion: "admin-channel-refund-evidence.v1";
  status: "INTEGRATED" | "NOT_INTEGRATED" | "NOT_APPLICABLE" | "FORBIDDEN" | "UNAVAILABLE";
  coverage: "LOCAL_REGISTERED_ONLY" | "TRUNCATED" | "INTENTS_UNAVAILABLE";
  orderId: string;
  refundSourceFamily: "JOINPAY";
  posting: Readonly<{ postingId: string; paymentConfirmationId: string; paymentSource: string;
    captured: ChannelMoney | null; responsibility: ChannelMoney | null; systemResponsibility: ChannelMoney | null;
    versionHash: string; dueAt: string | null; postedAt: string }> | null;
  totals: Readonly<{ requestedCents: string | null; allocatedCents: string | null; consumedCents: string | null; releasedCents: string | null }>;
  residualCents: null;
  trustedActualRefundCents: null;
  trustedRefundTrxNo: null;
  trustedCompletedAt: null;
  intents: readonly ChannelRefundIntentEvidence[] | null;
  abnormalResponsibilities: readonly ChannelAbnormalResponsibilityEvidence[] | null;
  intentTotals: Readonly<{ requestedCents: string | null; allocatedCents: string | null; consumedCents: string | null; releasedCents: string | null }>;
  intentTotalsComplete: boolean | null;
  responsibilityTotals: Readonly<{ originalCents: string | null; allocatedCents: string | null; consumedCents: string | null;
    releasedCents: string | null; remainingCents: string | null; totalsComplete: boolean }> | null;
  bankArrival: "UNKNOWN";
  safeTarget: null;
  reasonCodes: readonly string[];
  asOf: string;
}>;

function emptyRefund(orderId: string, asOf: string, status: ChannelRefundEvidence["status"],
  reasonCode: string): ChannelRefundEvidence {
  return { contractVersion: "admin-channel-refund-evidence.v1", status, coverage: "INTENTS_UNAVAILABLE", orderId,
    refundSourceFamily: "JOINPAY", posting: null,
    totals: { requestedCents: null, allocatedCents: null, consumedCents: null, releasedCents: null },
    residualCents: null, trustedActualRefundCents: null, trustedRefundTrxNo: null, trustedCompletedAt: null, intents: null,
    abnormalResponsibilities: null,
    intentTotals: { requestedCents: null, allocatedCents: null, consumedCents: null, releasedCents: null },
    responsibilityTotals: null, intentTotalsComplete: null,
    bankArrival: "UNKNOWN", safeTarget: null,
    reasonCodes: [reasonCode, "BANK_ARRIVAL_UNKNOWN"], asOf };
}

async function readSettlementPosting(client: Client, orderId: string, reasons: string[]): Promise<ChannelRefundEvidence["posting"]> {
  if (!await schemaReady(client, "zzsh_order.settlement_posting",
    ["id", "order_id", "payment_confirmation_id", "version_hash", "captured_cents", "renter_refund_cents",
      "system_renter_refund_cents", "refund_due_at", "posted_at"])
    || !await schemaReady(client, "zzsh_order.payment_confirmation",
      ["id", "order_id", "amount_cents", "currency", "source", "disposition"])) {
    add(reasons, "SETTLEMENT_POSTING_SCHEMA_UNAVAILABLE");
    return null;
  }
  const rows = (await client.query<Row>(`SELECT p.id,p.payment_confirmation_id,p.version_hash,p.captured_cents::text AS captured_cents,
      p.renter_refund_cents::text AS renter_refund_cents,p.system_renter_refund_cents::text AS system_renter_refund_cents,
      ${utc("p.refund_due_at")} AS refund_due_at,${utc("p.posted_at")} AS posted_at,
      c.currency AS confirmation_currency,c.amount_cents::text AS confirmation_amount_cents,c.source AS payment_source,
      c.disposition AS confirmation_disposition
    FROM zzsh_order.settlement_posting p
    JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id AND c.order_id=p.order_id
    WHERE p.order_id=$1 ORDER BY p.posted_at DESC,p.id COLLATE "C" DESC LIMIT 2`, [orderId])).rows;
  if (rows.length === 0) { add(reasons, "SETTLEMENT_POSTING_NOT_RECORDED"); return null; }
  if (rows.length > 1) { add(reasons, "MULTIPLE_SETTLEMENT_POSTINGS"); return null; }
  const row = rows[0]!, postingId = id(row.id), confirmationId = id(row.payment_confirmation_id);
  if (row.confirmation_disposition !== "APPLIED") { add(reasons, "POSTING_CONFIRMATION_NOT_APPLIED"); return null; }
  const postedAt = iso(row.posted_at), dueAt = row.refund_due_at === null ? null : iso(row.refund_due_at);
  const versionHash = typeof row.version_hash === "string" && /^[A-Za-z0-9._:-]{1,180}$/.test(row.version_hash) ? row.version_hash : null;
  if (!postingId || !confirmationId || !postedAt || !versionHash || (row.refund_due_at !== null && dueAt === null)) {
    add(reasons, "SETTLEMENT_POSTING_FIELDS_UNREADABLE"); return null;
  }
  if (row.confirmation_currency !== "CNY") { add(reasons, "RESPONSIBILITY_CURRENCY_NOT_CNY"); return null; }
  let capturedCents: string, confirmationCents: string;
  try { capturedCents = exactCents(row.captured_cents); confirmationCents = exactCents(row.confirmation_amount_cents); }
  catch { add(reasons, "POSTING_CAPTURED_INVALID"); return null; }
  if (capturedCents !== confirmationCents) { add(reasons, "POSTING_CAPTURE_MISMATCH"); return null; }
  const captured = money(row.captured_cents, row.confirmation_currency, reasons, "POSTING_CAPTURED_INVALID", "RESPONSIBILITY_CURRENCY_NOT_CNY");
  const responsibility = money(row.renter_refund_cents, row.confirmation_currency, reasons, "POSTING_RESPONSIBILITY_INVALID", "RESPONSIBILITY_CURRENCY_NOT_CNY");
  const systemResponsibility = money(row.system_renter_refund_cents, row.confirmation_currency, reasons, "POSTING_SYSTEM_RESPONSIBILITY_INVALID", "RESPONSIBILITY_CURRENCY_NOT_CNY");
  const paymentSource = row.payment_source === "JOINPAY" || row.payment_source === "CONTROLLED" ? row.payment_source : "UNKNOWN";
  if (paymentSource !== "JOINPAY") add(reasons, "PAYMENT_SOURCE_NOT_JOINPAY");
  return { postingId, paymentConfirmationId: confirmationId, paymentSource, captured, responsibility, systemResponsibility,
    versionHash, dueAt, postedAt };
}

async function assertRefundMerchants(client: Client, data: ScopeData, orderId: string,
  intents: readonly { intentId: string; merchantIdentityId?: unknown }[]): Promise<void> {
  const missing: string[] = [];
  for (const intent of intents) {
    if (intent.merchantIdentityId !== undefined && intent.merchantIdentityId !== null) requireStoredMerchant(data, intent.merchantIdentityId);
    else missing.push(intent.intentId);
  }
  if (missing.length === 0) return;
  // 9cd摘要没有商户字段，只补当前有界意图的绑定元数据，不重读原报文。
  const rows = (await client.query<Row>(`SELECT id,merchant_identity_id FROM zzsh_order.channel_refund_intent
    WHERE order_id=$1 AND payment_source='JOINPAY' AND id=ANY($2::text[])
    ORDER BY id COLLATE "C" LIMIT 65`, [orderId, missing])).rows;
  if (rows.length !== missing.length || new Set(rows.map(r => r.id)).size !== missing.length
    || rows.some(r => typeof r.id !== "string" || !missing.includes(r.id))) throw unavailable("Refund merchant binding is unavailable");
  for (const row of rows) requireStoredMerchant(data, row.merchant_identity_id);
}

/** 前置：Admin 已按 order/game/object 范围选中该订单；普通 GET 不调用退款命令路由。 */
export async function readAdminChannelRefundEvidence(client: Client, scope: ChannelEvidenceReadScope, input: {
  orderId: string; origin: PaymentOrigin;
}): Promise<ChannelRefundEvidence> {
  const data = scopeData(scope);
  if (!data.orderReadable) throw notFound();
  if (!input || typeof input.orderId !== "string" || !ID.test(input.orderId)
    || (input.origin !== "NATIVE" && input.origin !== "LEGACY")) throw invalid("Invalid refund evidence request");
  if (!data.readableOrderIds.has(input.orderId)) throw notFound();
  const asOf = await assertResource(client, data);
  if (!data.financeReadable) return emptyRefund(input.orderId, asOf, "FORBIDDEN", "FINANCE_PERMISSION_REQUIRED");
  if (input.origin !== "NATIVE") return emptyRefund(input.orderId, asOf, "NOT_APPLICABLE", "LEGACY_REFUND_SOURCE_NOT_INTEGRATED");
  const summary = await readAdminOrderRefundSummary(client, { orderId: input.orderId, origin: "NATIVE", financeReadable: true });
  const abnormalResponsibilities = (summary as { abnormalResponsibilities?: readonly { intentIds?: readonly string[]; merchantIdentityId?: unknown; totalsComplete?: unknown }[] }).abnormalResponsibilities ?? [];
  if (summary.integration === "INTEGRATED" && summary.intents) await assertRefundMerchants(client, data, input.orderId, summary.intents);
  const prestart=(summary as {prestartTermination?:{merchantIdentityId:string;refund:{integration:string;truncated:boolean}}}).prestartTermination;
  if(prestart)requireStoredMerchant(data,prestart.merchantIdentityId);
  if (summary.integration === "INTEGRATED") {
    for (const responsibility of abnormalResponsibilities) {
      if (responsibility.totalsComplete === true) for (const intentId of responsibility.intentIds ?? []) {
        if (!summary.intents?.some(intent => intent.intentId === intentId)) throw unavailable("Abnormal refund responsibility intent is unavailable");
      }
      if (responsibility.merchantIdentityId !== undefined && responsibility.merchantIdentityId !== null) requireStoredMerchant(data, responsibility.merchantIdentityId);
    }
  }
  const incompleteAbnormal = abnormalResponsibilities.some(row => row.totalsComplete !== true);
  const reasons: string[] = (summary.reasonCodes ?? []).filter((value): value is string => typeof value === "string" && CODE.test(value));
  const posting = await readSettlementPosting(client, input.orderId, reasons);
  const status: ChannelRefundEvidence["status"] = summary.integration === "INTEGRATED" ? "INTEGRATED"
    : summary.integration === "UNAVAILABLE" ? "UNAVAILABLE" : summary.integration === "NOT_APPLICABLE" ? "NOT_APPLICABLE"
    : summary.integration === "FORBIDDEN" ? "FORBIDDEN" : "NOT_INTEGRATED";
  const truncated = (summary as { truncated?: unknown }).truncated === true;
  const sourceIntents = summary.integration === "INTEGRATED" ? summary.intents : null;
  let intents: ChannelRefundIntentEvidence[] | null = null;
  let totals: ChannelRefundEvidence["totals"] = { requestedCents: null, allocatedCents: null, consumedCents: null, releasedCents: null };
  if (sourceIntents) {
    const mapped: ChannelRefundIntentEvidence[] = [];
    const requested: string[] = [], allocated: string[] = [], consumed: string[] = [], released: string[] = [];
    let valid = true;
    for (const intent of sourceIntents) {
      const amount = money(intent.amount.cents, intent.amount.currency, reasons, "REFUND_INTENT_AMOUNT_INVALID", "REFUND_INTENT_CURRENCY_NOT_CNY");
      const intentId = id(intent.intentId);
      const refundOrderNo = typeof intent.refundOrderNo === "string" && ORDER_NO.test(intent.refundOrderNo) ? intent.refundOrderNo : null;
      if (!amount || BigInt(amount.cents) <= 0n || !intentId || !refundOrderNo || typeof intent.requiresReview !== "boolean") { valid = false; break; }
      const disposition = intent.budgetDisposition;
      if (!["ALLOCATED", "CONSUMED", "RELEASED"].includes(disposition)) { valid = false; break; }
      requested.push(amount.cents);
      (disposition === "ALLOCATED" ? allocated : disposition === "CONSUMED" ? consumed : released).push(amount.cents);
      const evidenceId = intent.evidenceId === null ? null : id(intent.evidenceId);
      const rootId = intent.rootId === null ? null : id(intent.rootId);
      const eventId = intent.eventId === null ? null : id(intent.eventId);
      if (intent.evidenceId !== null && evidenceId === null || intent.rootId !== null && rootId === null
        || intent.eventId !== null && eventId === null) add(reasons, "LOCAL_TERMINAL_REFERENCE_UNREADABLE");
      const rawBasis = (intent as { basisKind?: unknown }).basisKind;
      const basisKind = rawBasis === "REVIEW_CONFIRMATION" ? "REVIEW_CONFIRMATION" as const : rawBasis === "PRESTART_TERMINATION"?"PRESTART_TERMINATION" as const:"POSTING" as const;
      const firstSubmit = (intent as { firstSubmit?: ChannelRefundIntentEvidence["firstSubmit"] }).firstSubmit ?? null;
      const liabilityRootId = (intent as { liabilityRootId?: unknown }).liabilityRootId;
      const liabilityEventId = (intent as { liabilityEventId?: unknown }).liabilityEventId;
      mapped.push({ intentId, refundOrderNo, amount, localState: code(intent.localState) ?? "UNKNOWN",
        budgetDisposition: disposition, requiresReview: intent.requiresReview, basisKind,
        paymentConfirmationId: id((intent as { paymentConfirmationId?: unknown }).paymentConfirmationId),
        liabilityRootId: id(liabilityRootId), liabilityEventId: id(liabilityEventId), firstSubmit,
        localTerminal: evidenceId || rootId || eventId ? { evidenceId, rootId, eventId } : null,
        trustedActualCents: null, trustedRefundTrxNo: null, trustedCompletedAt: null, mayResubmit: false, bankArrival: "UNKNOWN" });
    }
    if (valid) {
      intents = mapped;
      if (truncated) add(reasons, "REFUND_COVERAGE_TRUNCATED");
      else if (incompleteAbnormal) add(reasons, "REFUND_INTENT_TOTALS_INCOMPLETE");
      else {
        totals = { requestedCents: sumCents(requested), allocatedCents: sumCents(allocated),
          consumedCents: sumCents(consumed), releasedCents: sumCents(released) };
        if (mapped.length === 0) add(reasons, "NO_LOCAL_REFUND_INTENTS");
        const uniqueBudget = (summary as { responsibilityBudget?: { originalCents?: unknown; allocatedCents?: unknown } }).responsibilityBudget;
        const uniqueOriginal = typeof uniqueBudget?.originalCents === "string" ? uniqueBudget.originalCents
          : posting?.responsibility?.cents ?? null;
        const uniqueAllocated = typeof uniqueBudget?.allocatedCents === "string" ? uniqueBudget.allocatedCents
          : totals.allocatedCents === null || totals.consumedCents === null ? null
            : (BigInt(totals.allocatedCents) + BigInt(totals.consumedCents)).toString();
        if (uniqueOriginal !== null && uniqueAllocated !== null && BigInt(uniqueAllocated) > BigInt(uniqueOriginal)) {
          add(reasons, "LOCAL_REFUND_ALLOCATION_EXCEEDS_RESPONSIBILITY");
        }
      }
    } else add(reasons, "REFUND_INTENT_PROJECTION_INVALID");
  }
  add(reasons, "LOCAL_REGISTERED_ONLY_NOT_GLOBAL_OBLIGATION");
  add(reasons, "LOCAL_SUCCEEDED_NOT_CHANNEL_OR_BANK_SUCCESS");
  add(reasons, "CONSUMED_IS_LOCAL_ACCOUNTING_NOT_CHANNEL_SUCCESS");
  add(reasons, "TERMINAL_EVIDENCE_NOT_REVALIDATED");
  add(reasons, "RESIDUAL_NOT_DERIVED_FROM_REQUESTS");
  add(reasons, "REFUND_TARGET_NOT_REVALIDATED");
  add(reasons, "BANK_ARRIVAL_UNKNOWN");
  add(reasons, "INTENT_TOTALS_ARE_NOT_UNIQUE_RESPONSIBILITY");
  if (status === "NOT_INTEGRATED") add(reasons, "REFUND_SCHEMA_NOT_INTEGRATED");
  if (status === "UNAVAILABLE") add(reasons, "REFUND_READ_UNAVAILABLE");
  if (status === "FORBIDDEN") add(reasons, "FINANCE_PERMISSION_REQUIRED");
  if (status === "INTEGRATED" && sourceIntents === null) add(reasons, "REFUND_INTENTS_UNAVAILABLE");
  const projectedStatus = status === "INTEGRATED" && intents === null ? "UNAVAILABLE" : status;
  const responsibilityBudget = (summary as { responsibilityBudget?: { originalCents: string | null; allocatedCents: string | null;
    consumedCents: string | null; releasedCents: string | null; remainingCents: string | null; totalsComplete: boolean } }).responsibilityBudget;
  const responsibilityEvidence = abnormalResponsibilities.map(responsibility => ({
    confirmationId: id((responsibility as { confirmationId?: unknown }).confirmationId) ?? "",
    reasonCode: code((responsibility as { reasonCode?: unknown }).reasonCode) ?? "UNKNOWN_REASON",
    originalCents: typeof (responsibility as { originalCents?: unknown }).originalCents === "string"
      ? (responsibility as { originalCents: string }).originalCents : null,
    allocatedCents: typeof (responsibility as { allocatedCents?: unknown }).allocatedCents === "string"
      ? (responsibility as { allocatedCents: string }).allocatedCents : null,
    consumedCents: typeof (responsibility as { consumedCents?: unknown }).consumedCents === "string"
      ? (responsibility as { consumedCents: string }).consumedCents : null,
    releasedCents: typeof (responsibility as { releasedCents?: unknown }).releasedCents === "string"
      ? (responsibility as { releasedCents: string }).releasedCents : null,
    remainingCents: typeof (responsibility as { remainingCents?: unknown }).remainingCents === "string"
      ? (responsibility as { remainingCents: string }).remainingCents : null,
    totalsComplete: (responsibility as { totalsComplete?: unknown }).totalsComplete === true,
    state: code((responsibility as { state?: unknown }).state) ?? "UNKNOWN",
    intentIds: ((responsibility as { intentIds?: unknown }).intentIds as readonly string[] | undefined) ?? [],
    liabilityRootId: id((responsibility as { liabilityRootId?: unknown }).liabilityRootId),
    liabilityEventId: id((responsibility as { liabilityEventId?: unknown }).liabilityEventId),
    firstSubmit: (responsibility as { firstSubmit?: ChannelRefundIntentEvidence["firstSubmit"] }).firstSubmit ?? null,
    reasonCodes: Array.isArray((responsibility as { reasonCodes?: unknown }).reasonCodes)
      ? ((responsibility as { reasonCodes: unknown[] }).reasonCodes).filter((value): value is string => typeof value === "string" && CODE.test(value)) : [],
  }));
  return { contractVersion: "admin-channel-refund-evidence.v1", status: projectedStatus,
    coverage: projectedStatus !== "INTEGRATED" || sourceIntents === null ? "INTENTS_UNAVAILABLE" : truncated ? "TRUNCATED" : "LOCAL_REGISTERED_ONLY",
    orderId: input.orderId, refundSourceFamily: "JOINPAY", posting, totals, residualCents: null,
    abnormalResponsibilities: projectedStatus === "INTEGRATED" ? responsibilityEvidence : null,
    intentTotals: totals,
    intentTotalsComplete: projectedStatus === "INTEGRATED" && intents !== null ? !truncated && !incompleteAbnormal : null,
    responsibilityTotals: projectedStatus === "INTEGRATED" && responsibilityBudget ? {
      originalCents: responsibilityBudget.originalCents, allocatedCents: responsibilityBudget.allocatedCents,
      consumedCents: responsibilityBudget.consumedCents, releasedCents: responsibilityBudget.releasedCents,
      remainingCents: responsibilityBudget.remainingCents, totalsComplete: responsibilityBudget.totalsComplete === true,
    } : null,
    trustedActualRefundCents: null, trustedRefundTrxNo: null, trustedCompletedAt: null, intents,
    bankArrival: "UNKNOWN", safeTarget: null, reasonCodes: reasons, asOf };
}

// ---------- C. 原生 JOINPAY 提现安全摘要 ----------

export type ChannelWithdrawalEvidence = Readonly<{
  contractVersion: "admin-channel-withdrawal-evidence.v1";
  status: "FOUND" | "NOT_FOUND_LOCAL" | "NOT_INTEGRATED" | "UNAVAILABLE";
  coverage: "LOCAL_JOINPAY_INTENTS_ONLY";
  intentId: string;
  merchantIdentityId: string;
  userId: string | null;
  sourceFamily: "JOINPAY";
  state: string | null;
  operationVersion: string | null;
  requiresReview: boolean | null;
  localFundsDisposition: string | null;
  acceptedAt: string | null;
  references: Readonly<{ economicRootId: string; reserveEventId: string }> | null;
  merchantOrderNo: string | null;
  platformSerialNo: string | null;
  amounts: Readonly<{ grossDeduction: ChannelMoney | null; netPayout: ChannelMoney | null; userPolicyFee: ChannelMoney | null;
    actualChannelPayout: null; reasons: readonly string[] }>;
  originalDestination: Readonly<{ id: string; revision: string; cardMask: string | null; basis: "ORIGINAL_INTENT";
    bankOwnershipVerification: "UNKNOWN" }> | null;
  channelTerminal: Readonly<{ platformSerialNo: string | null; terminalEvidenceId: string | null;
    trust: "LOCAL_RECORDS_NOT_REVALIDATED" }> | null;
  supplierCost: Readonly<{ providerFee: null; providerFeeRaw: null; reasons: readonly string[] }>;
  bankArrival: "UNKNOWN";
  mayResubmit: false;
  financeRedacted: boolean;
  reasonCodes: readonly string[];
  asOf: string;
}>;

const withdrawalReasons = (reasons: string[]) => {
  for (const value of ["LOCAL_WITHDRAWAL_INTENT_ONLY", "LOCAL_CONTROLLED_NOT_MERGED", "LOCAL_RECORDS_NOT_REVALIDATED",
    "ORIGINAL_TARGET_ONLY", "CURRENT_BINDING_NOT_READ", "BANK_ARRIVAL_UNKNOWN"]) add(reasons, value);
};

function emptyWithdrawal(intentId: string, merchantIdentityId: string, asOf: string,
  status: "NOT_FOUND_LOCAL" | "NOT_INTEGRATED" | "UNAVAILABLE", reasonCode: string): ChannelWithdrawalEvidence {
  const reasons = [reasonCode];
  withdrawalReasons(reasons);
  return { contractVersion: "admin-channel-withdrawal-evidence.v1", status, coverage: "LOCAL_JOINPAY_INTENTS_ONLY",
    intentId, merchantIdentityId, userId: null, sourceFamily: "JOINPAY", state: null, operationVersion: null,
    requiresReview: null, localFundsDisposition: null, acceptedAt: null, references: null, merchantOrderNo: null,
    platformSerialNo: null, amounts: { grossDeduction: null, netPayout: null, userPolicyFee: null, actualChannelPayout: null,
      reasons: [reasonCode] }, originalDestination: null, channelTerminal: null,
    supplierCost: { providerFee: null, providerFeeRaw: null, reasons: [reasonCode] },
    bankArrival: "UNKNOWN", mayResubmit: false, financeRedacted: false, reasonCodes: reasons, asOf };
}

const WITHDRAWAL_COLUMNS = ["id", "user_id", "gross_cents", "net_cents", "fee_cents", "currency", "state", "operation_version",
  "funds_disposition", "requires_review", "merchant_order_no", "platform_serial_no", "policy_version", "destination_id",
  "destination_revision", "admission_canonical", "admission_sha256", "accepted_at", "merchant_identity_id", "economic_root_id",
  "reserve_event_id", "terminal_evidence_id"] as const;
const WITHDRAWAL_REDACTED_COLUMNS = ["id", "state", "requires_review", "accepted_at", "merchant_identity_id"] as const;

/** 只读原 intent 冻结字段；不查当前绑定卡、不解密、不调用用户history入口。 */
export async function readAdminChannelWithdrawalEvidence(client: Client, scope: ChannelEvidenceReadScope, input: {
  intentId: string; merchantIdentityId: string;
}): Promise<ChannelWithdrawalEvidence> {
  const data = scopeData(scope);
  if (!input || typeof input !== "object") throw invalid("Invalid withdrawal evidence request");
  const merchantIdentityId = requireMerchant(data, input.merchantIdentityId);
  if (typeof input.intentId !== "string" || !WIDE_ID.test(input.intentId)) throw invalid("Invalid withdrawal intent");
  const asOf = await assertResource(client, data);
  const finance = data.financeReadable;
  const columns = finance ? WITHDRAWAL_COLUMNS : WITHDRAWAL_REDACTED_COLUMNS;
  if (!await schemaReady(client, "zzsh_order.joinpay_withdrawal_intent", columns)) {
    return emptyWithdrawal(input.intentId, merchantIdentityId, asOf, "NOT_INTEGRATED", "NATIVE_WITHDRAWAL_SCHEMA_UNAVAILABLE");
  }
  const rows = (await client.query<Row>(`SELECT ${finance
    ? `id,user_id,gross_cents::text AS gross_cents,net_cents::text AS net_cents,fee_cents::text AS fee_cents,currency,state,
       operation_version::text AS operation_version,funds_disposition,requires_review,merchant_order_no,platform_serial_no,policy_version,
       destination_id,destination_revision,admission_canonical,admission_sha256,${utc("accepted_at")} AS accepted_at,
       merchant_identity_id,economic_root_id,reserve_event_id,terminal_evidence_id`
    : `id,state,requires_review,${utc("accepted_at")} AS accepted_at,merchant_identity_id`}
    FROM zzsh_order.joinpay_withdrawal_intent WHERE id=$1 AND merchant_identity_id=$2 LIMIT 2`,
  [input.intentId, merchantIdentityId])).rows;
  if (rows.length === 0) return emptyWithdrawal(input.intentId, merchantIdentityId, asOf, "NOT_FOUND_LOCAL",
    "LOCAL_WITHDRAWAL_INTENT_NOT_REGISTERED_OR_NOT_AUTHORIZED");
  if (rows.length > 1) return emptyWithdrawal(input.intentId, merchantIdentityId, asOf, "UNAVAILABLE",
    "MULTIPLE_LOCAL_WITHDRAWAL_INTENTS");
  const row = rows[0]!;
  const rowIntentId = id(row.id), rowMerchant = id(row.merchant_identity_id);
  const acceptedAt = iso(row.accepted_at);
  if (rowIntentId !== input.intentId || rowMerchant !== merchantIdentityId || !acceptedAt) {
    return emptyWithdrawal(input.intentId, merchantIdentityId, asOf, "UNAVAILABLE", "WITHDRAWAL_BINDING_UNREADABLE");
  }
  const reasons: string[] = [];
  withdrawalReasons(reasons);
  if (!finance) {
    add(reasons, "FINANCE_PERMISSION_REDACTED");
    if (typeof row.state !== "string" || typeof row.requires_review !== "boolean") {
      return emptyWithdrawal(input.intentId, merchantIdentityId, asOf, "UNAVAILABLE", "WITHDRAWAL_PROJECTION_INVALID");
    }
    const state = WITHDRAWAL_STATES.includes(row.state) ? row.state : "UNKNOWN";
    if (state === "UNKNOWN") add(reasons, "UNKNOWN_NATIVE_WITHDRAWAL_STATE");
    if (row.requires_review) add(reasons, "REQUIRES_REVIEW");
    return { contractVersion: "admin-channel-withdrawal-evidence.v1", status: "FOUND", coverage: "LOCAL_JOINPAY_INTENTS_ONLY",
      intentId: input.intentId, merchantIdentityId, userId: null, sourceFamily: "JOINPAY", state,
      operationVersion: null, requiresReview: row.requires_review, localFundsDisposition: null, acceptedAt,
      references: null, merchantOrderNo: null, platformSerialNo: null,
      amounts: { grossDeduction: null, netPayout: null, userPolicyFee: null, actualChannelPayout: null,
        reasons: ["FINANCE_PERMISSION_REDACTED"] },
      originalDestination: null, channelTerminal: null,
      supplierCost: { providerFee: null, providerFeeRaw: null, reasons: ["FINANCE_PERMISSION_REDACTED"] },
      bankArrival: "UNKNOWN", mayResubmit: false, financeRedacted: true, reasonCodes: reasons, asOf };
  }
  const rowUserId = id(row.user_id);
  if (!rowUserId) return emptyWithdrawal(input.intentId, merchantIdentityId, asOf, "UNAVAILABLE", "WITHDRAWAL_USER_BINDING_UNREADABLE");
  let projected: ReturnType<typeof nativeProjection>;
  try { projected = nativeProjection(row, rowUserId); }
  catch (error) {
    if (error instanceof SecurityApiError) {
      return emptyWithdrawal(input.intentId, merchantIdentityId, asOf, "UNAVAILABLE", "ORIGINAL_WITHDRAWAL_PROJECTION_INVALID");
    }
    throw error;
  }
  const terminalEvidenceId = row.terminal_evidence_id === null ? null : id(row.terminal_evidence_id);
  if (row.terminal_evidence_id !== null && terminalEvidenceId === null) add(reasons, "LOCAL_TERMINAL_REFERENCE_UNREADABLE");
  const economicRootId = id(row.economic_root_id), reserveEventId = id(row.reserve_event_id);
  const references = economicRootId && reserveEventId ? { economicRootId, reserveEventId } : null;
  if (!references) add(reasons, "WITHDRAWAL_REFERENCE_UNAVAILABLE");
  const originalDestination = projected.originalDestination;
  if (originalDestination.cardMask === null) add(reasons, "ORIGINAL_TARGET_MASK_UNAVAILABLE");
  if (projected.state === "SUCCEEDED") add(reasons, "LOCAL_SUCCESS_NOT_BANK_ARRIVAL");
  if (projected.requiresReview) add(reasons, "REQUIRES_REVIEW");
  for (const value of projected.reasonCodes) add(reasons, value);
  const channelTerminal = terminalEvidenceId !== null
    ? { platformSerialNo: projected.platformSerialNo, terminalEvidenceId, trust: "LOCAL_RECORDS_NOT_REVALIDATED" as const } : null;
  if (!channelTerminal) add(reasons, "NO_LOCAL_CHANNEL_TERMINAL");
  const supplierReasons = terminalEvidenceId !== null ? ["PROVIDER_FEE_NOT_REVALIDATED_IN_READ"] : ["NO_VERIFIED_TERMINAL_EVIDENCE"];
  const amountsReasons = ["CHANNEL_PAYOUT_AMOUNT_NOT_REVALIDATED"];
  return { contractVersion: "admin-channel-withdrawal-evidence.v1", status: "FOUND", coverage: "LOCAL_JOINPAY_INTENTS_ONLY",
    intentId: input.intentId, merchantIdentityId, userId: data.userReadable && data.readableUserIds.has(rowUserId) ? rowUserId : null,
    sourceFamily: "JOINPAY", state: projected.state, operationVersion: projected.operationVersion,
    requiresReview: projected.requiresReview, localFundsDisposition: projected.fundsDisposition, acceptedAt: projected.occurredAt,
    references, merchantOrderNo: projected.merchantOrderNo, platformSerialNo: projected.platformSerialNo,
    amounts: { grossDeduction: { cents: projected.amountCents, currency: "CNY" },
      netPayout: { cents: projected.netCents, currency: "CNY" }, userPolicyFee: { cents: projected.feeCents, currency: "CNY" },
      actualChannelPayout: null, reasons: amountsReasons },
    originalDestination, channelTerminal,
    supplierCost: { providerFee: null, providerFeeRaw: null, reasons: supplierReasons },
    bankArrival: "UNKNOWN", mayResubmit: false, financeRedacted: false, reasonCodes: reasons, asOf };
}

// ---------- D. 本地精确原单检索 ----------

export type ChannelOriginalCandidate = Readonly<{
  sourceFamily: "JOINPAY";
  productFamily: ChannelProductFamily;
  objectKind: "PAYMENT_REQUEST" | "REFUND_INTENT" | "JOINPAY_WITHDRAWAL_INTENT";
  objectId: string;
  requestId: string | null;
  orderId: string | null;
  postingId: string | null;
  userId: string | null;
  merchantIdentityId: string;
  merchantOrderNo: string;
  channelTrxNo: string | null;
  amount: ChannelMoney | null;
  state: string;
  evidenceLevel: string;
  recordedAt: string | null;
  requiresReview: boolean | null;
  matchedNumberRole: "OBJECT_ORDER" | "ORIGINAL_PAYMENT" | "CHANNEL_TRX_ONLY";
  channelTransactionRecorded: boolean;
  budgetDisposition: string | null;
  fundsDisposition: string | null;
  localTerminalEvidenceId: string | null;
  originalPaymentOrderNo: string | null;
  originalPaymentTrxNo: string | null;
  economicRootId: string | null;
  reserveEventId: string | null;
}>;
export type ChannelOriginalSearch = Readonly<{
  contractVersion: "admin-channel-original-search.v1";
  status: "FOUND" | "NOT_FOUND_LOCAL" | "AMBIGUOUS" | "NOT_INTEGRATED" | "UNAVAILABLE";
  coverage: "LOCAL_REGISTERED_ONLY";
  query: Readonly<{ merchantIdentityId: string; productFamily: ChannelProductFamily; merchantOrderNo: string | null;
    channelTrxNo: string | null; limit: number }>;
  candidates: readonly ChannelOriginalCandidate[];
  truncated: boolean;
  financialEffect: "NONE";
  reasonCodes: readonly string[];
  asOf: string;
}>;

const searchResult = (status: ChannelOriginalSearch["status"], input: { merchantIdentityId: string; productFamily: ChannelProductFamily;
  merchantOrderNo: string | null; channelTrxNo: string | null; limit: number }, asOf: string,
  candidates: readonly ChannelOriginalCandidate[], truncated: boolean, reasons: string[]): ChannelOriginalSearch => ({
  contractVersion: "admin-channel-original-search.v1", status, coverage: "LOCAL_REGISTERED_ONLY", query: input, candidates,
  truncated, financialEffect: "NONE", reasonCodes: reasons, asOf });

function validateSearchInput(input: {
  merchantIdentityId: string; productFamily: ChannelProductFamily; merchantOrderNo?: string | null; channelTrxNo?: string | null; limit?: number;
}): { merchantOrderNo: string | null; channelTrxNo: string | null; limit: number } {
  const merchantOrderNo = input.merchantOrderNo ?? null, channelTrxNo = input.channelTrxNo ?? null;
  if (merchantOrderNo !== null && (typeof merchantOrderNo !== "string" || !ORDER_NO.test(merchantOrderNo))) throw invalid("Invalid merchant order number");
  if (channelTrxNo !== null && (typeof channelTrxNo !== "string" || !TRX_NO.test(channelTrxNo))) throw invalid("Invalid channel transaction number");
  if (merchantOrderNo === null && channelTrxNo === null) throw invalid("An exact merchant order number or channel transaction number is required");
  const limit = input.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 20) throw invalid("Invalid search limit");
  return { merchantOrderNo, channelTrxNo, limit };
}

function searchFailure(status: ChannelOriginalSearch["status"], input: { merchantIdentityId: string; productFamily: ChannelProductFamily;
  merchantOrderNo: string | null; channelTrxNo: string | null; limit: number }, asOf: string, reasonCode: string): ChannelOriginalSearch {
  const reasons = [reasonCode, "LOCAL_REGISTERED_ONLY"];
  return searchResult(status, input, asOf, [], false, reasons);
}

/** 产品族白名单 + 稳定商户 + 精确原号；同号跨商户/跨产品不会串单，两线索必须同时命中。 */
export async function searchAdminChannelOriginals(client: Client, scope: ChannelEvidenceReadScope, input: {
  merchantIdentityId: string; productFamily: ChannelProductFamily; merchantOrderNo?: string | null;
  channelTrxNo?: string | null; limit?: number;
}): Promise<ChannelOriginalSearch> {
  const data = scopeData(scope);
  if (!input || typeof input !== "object") throw invalid("Invalid original search request");
  const merchantIdentityId = requireMerchant(data, input.merchantIdentityId);
  if (!CHANNEL_EVIDENCE_PRODUCTS.includes(input.productFamily)) throw invalid("Unsupported channel product family");
  if (!data.financeReadable) throw forbidden("Finance read permission is required for exact original search");
  const query = validateSearchInput(input);
  const asOf = await assertResource(client, data);
  const reasons: string[] = [];
  const echo = { merchantIdentityId, productFamily: input.productFamily, ...query };

  if (input.productFamily === "ALIPAY_NATIVE" || input.productFamily === "WEIXIN_NATIVE") {
    add(reasons, "PAYMENT_TRANSACTION_LOOKUP_ANCHORS_ONLY");
    if (!await schemaReady(client, "zzsh_order.payment_request",
      ["id", "order_id", "channel", "merchant_identity_id", "channel_order_no", "method", "state", "amount_cents", "currency",
        "evidence_level", "created_at"])
      || !await schemaReady(client, "zzsh_order.payment_channel_transaction",
        ["id", "request_id", "channel", "merchant_identity_id", "channel_trx_no", "evidence_level", "created_at"])) {
      return searchFailure("NOT_INTEGRATED", echo, asOf, "COLLECTION_SCHEMA_UNAVAILABLE");
    }
    const rows = (await client.query<Row>(`SELECT r.id AS request_id,r.order_id,r.merchant_identity_id,
        r.channel_order_no AS merchant_order_no,r.method,r.state,r.amount_cents::text AS amount_cents,r.currency,
        r.evidence_level,${utc("r.created_at")} AS recorded_at,t.channel_trx_no
      FROM zzsh_order.payment_request r
      LEFT JOIN LATERAL (SELECT x.id,x.created_at,x.channel_trx_no
        FROM zzsh_order.payment_channel_transaction x
        WHERE x.request_id=r.id AND x.channel='JOINPAY' AND x.merchant_identity_id=$1
          AND ($4::text IS NULL OR x.channel_trx_no=$4)
        ORDER BY x.created_at DESC,x.id COLLATE "C" DESC) t ON TRUE
      WHERE r.channel='JOINPAY' AND r.merchant_identity_id=$1 AND r.method=$2
        AND ($3::text IS NULL OR r.channel_order_no=$3) AND ($4::text IS NULL OR t.channel_trx_no IS NOT NULL)
      ORDER BY r.created_at DESC,r.id COLLATE "C" DESC,t.created_at DESC,t.id COLLATE "C" DESC LIMIT $5`,
    [merchantIdentityId, input.productFamily, query.merchantOrderNo, query.channelTrxNo, query.limit + 1])).rows;
    return mapSearchRows("COLLECTION", rows, echo, asOf, query, data, reasons);
  }
  if (input.productFamily === "REFUND") {
    if (!await schemaReady(client, "zzsh_order.channel_refund_intent",
      ["id", "order_id", "posting_id", "payment_source", "merchant_identity_id", "original_payment_trx_no",
        "original_payment_order_no", "refund_order_no", "provider_refund_trx_no", "amount_cents", "currency", "state",
        "budget_disposition", "requires_review", "terminal_evidence_id", "evidence_level", "created_at"])) {
      return searchFailure("NOT_INTEGRATED", echo, asOf, "REFUND_SCHEMA_UNAVAILABLE");
    }
    const rows = (await client.query<Row>(`SELECT i.id AS intent_id,i.order_id,i.merchant_identity_id,i.posting_id,
        i.refund_order_no,i.original_payment_order_no,i.provider_refund_trx_no,i.original_payment_trx_no,i.state,
        i.budget_disposition,i.amount_cents::text AS amount_cents,i.currency,i.evidence_level,i.requires_review,
        i.terminal_evidence_id,${utc("i.created_at")} AS recorded_at
      FROM zzsh_order.channel_refund_intent i
      WHERE i.payment_source='JOINPAY' AND i.merchant_identity_id=$1 AND (
        ($2::text IS NOT NULL AND i.refund_order_no=$2 AND ($3::text IS NULL OR i.provider_refund_trx_no=$3))
        OR ($2::text IS NOT NULL AND i.original_payment_order_no=$2 AND ($3::text IS NULL OR i.original_payment_trx_no=$3))
        OR ($2::text IS NULL AND $3::text IS NOT NULL AND (i.provider_refund_trx_no=$3 OR i.original_payment_trx_no=$3)))
      ORDER BY i.created_at DESC,i.id COLLATE "C" DESC LIMIT $4`,
    [merchantIdentityId, query.merchantOrderNo, query.channelTrxNo, query.limit + 1])).rows;
    return mapSearchRows("REFUND", rows, echo, asOf, query, data, reasons);
  }
  if (!await schemaReady(client, "zzsh_order.joinpay_withdrawal_intent",
    ["id", "user_id", "merchant_identity_id", "merchant_order_no", "platform_serial_no", "state", "funds_disposition",
      "gross_cents", "net_cents", "fee_cents", "currency", "requires_review", "economic_root_id", "reserve_event_id",
      "terminal_evidence_id", "accepted_at"])) {
    return searchFailure("NOT_INTEGRATED", echo, asOf, "PAYOUT_SCHEMA_UNAVAILABLE");
  }
  const rows = (await client.query<Row>(`SELECT i.id AS intent_id,i.user_id,i.merchant_identity_id,i.merchant_order_no,
      i.platform_serial_no,i.state,i.funds_disposition,i.gross_cents::text AS gross_cents,i.net_cents::text AS net_cents,
      i.fee_cents::text AS fee_cents,i.currency,i.requires_review,i.economic_root_id,i.reserve_event_id,
      i.terminal_evidence_id,${utc("i.accepted_at")} AS recorded_at
    FROM zzsh_order.joinpay_withdrawal_intent i
    WHERE i.merchant_identity_id=$1 AND ($2::text IS NULL OR i.merchant_order_no=$2)
      AND ($3::text IS NULL OR i.platform_serial_no=$3)
    ORDER BY i.accepted_at DESC,i.id COLLATE "C" DESC LIMIT $4`,
  [merchantIdentityId, query.merchantOrderNo, query.channelTrxNo, query.limit + 1])).rows;
  return mapSearchRows("PAYOUT", rows, echo, asOf, query, data, reasons);
}

const REQUEST_STATES = ["NONE", "SUBMITTING", "UNKNOWN", "ACTION_READY", "PROCESSING_UNCONFIRMED", "REJECTED_BY_CHANNEL",
  "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE", "ACCEPTED", "REVIEW_REQUIRED"];
const REFUND_STATES = ["READY", "SUBMITTING", "UNKNOWN", "PROCESSING", "REVIEW_REQUIRED", "SUCCEEDED", "FAILED"];
const WITHDRAWAL_STATES = ["RESERVED", "SUBMITTING", "PROCESSING", "UNKNOWN", "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE", "SUCCEEDED", "FAILED"];
const BUDGET = ["ALLOCATED", "CONSUMED", "RELEASED"];
const FUNDS = ["RESERVED", "PAYOUT_POSTED", "RELEASE_POSTED"];

function mapSearchRows(kind: "COLLECTION" | "REFUND" | "PAYOUT", rows: Row[],
  echo: { merchantIdentityId: string; productFamily: ChannelProductFamily; merchantOrderNo: string | null; channelTrxNo: string | null; limit: number },
  asOf: string, query: { merchantOrderNo: string | null; channelTrxNo: string | null; limit: number }, data: ScopeData,
  reasons: string[]): ChannelOriginalSearch {
  const candidates: ChannelOriginalCandidate[] = [];
  for (const row of rows.slice(0, query.limit)) {
    const merchantIdentityId = id(row.merchant_identity_id);
    const recordedAt = iso(row.recorded_at);
    if (!recordedAt) add(reasons, "RECORD_TIME_UNREADABLE");
    if (kind === "COLLECTION") {
      const objectId = id(row.request_id), orderIdRaw = id(row.order_id), method = row.method;
      const merchantOrderNo = typeof row.merchant_order_no === "string" && ORDER_NO.test(row.merchant_order_no) ? row.merchant_order_no : null;
      const channelTrxNo = row.channel_trx_no === null ? null : (typeof row.channel_trx_no === "string" && TRX_NO.test(row.channel_trx_no) ? row.channel_trx_no : null);
      if (!objectId || !merchantIdentityId || !merchantOrderNo || method !== echo.productFamily
        || merchantIdentityId !== echo.merchantIdentityId
        || query.merchantOrderNo !== null && merchantOrderNo !== query.merchantOrderNo
        || query.channelTrxNo !== null && channelTrxNo !== query.channelTrxNo
        || row.channel_trx_no !== null && channelTrxNo === null) { return searchFailure("UNAVAILABLE", echo, asOf, "SEARCH_CANDIDATE_BINDING_MISMATCH"); }
      const amount = money(row.amount_cents, row.currency, reasons, "SEARCH_AMOUNT_INVALID", "SEARCH_CURRENCY_NOT_CNY");
      if (!amount) return searchFailure("UNAVAILABLE", echo, asOf, "SEARCH_AMOUNT_UNAVAILABLE");
      const state = typeof row.state === "string" && REQUEST_STATES.includes(row.state) ? row.state : "UNKNOWN";
      if (state === "UNKNOWN") add(reasons, "UNKNOWN_LOCAL_STATE");
      candidates.push({ sourceFamily: "JOINPAY", productFamily: echo.productFamily, objectKind: "PAYMENT_REQUEST", objectId,
        requestId: objectId, orderId: data.orderReadable && orderIdRaw && data.readableOrderIds.has(orderIdRaw) ? orderIdRaw : null, postingId: null, userId: null,
        merchantIdentityId, merchantOrderNo, channelTrxNo, amount, state,
        evidenceLevel: code(row.evidence_level) ?? "UNKNOWN", recordedAt,
        requiresReview: null, matchedNumberRole: query.merchantOrderNo !== null ? "OBJECT_ORDER" : "CHANNEL_TRX_ONLY",
        channelTransactionRecorded: channelTrxNo !== null, budgetDisposition: null, fundsDisposition: null,
        localTerminalEvidenceId: null, originalPaymentOrderNo: null, originalPaymentTrxNo: null,
        economicRootId: null, reserveEventId: null });
      if (data.orderReadable && orderIdRaw === null) add(reasons, "ORDER_LINK_UNAVAILABLE");
      continue;
    }
    if (kind === "REFUND") {
      const objectId = id(row.intent_id), orderIdRaw = id(row.order_id);
      const merchantOrderNo = typeof row.refund_order_no === "string" && ORDER_NO.test(row.refund_order_no) ? row.refund_order_no : null;
      const originalOrderNo = typeof row.original_payment_order_no === "string" && ORDER_NO.test(row.original_payment_order_no) ? row.original_payment_order_no : null;
      const providerTrx = row.provider_refund_trx_no === null ? null : (typeof row.provider_refund_trx_no === "string" && TRX_NO.test(row.provider_refund_trx_no) ? row.provider_refund_trx_no : null);
      const originalTrx = row.original_payment_trx_no === null ? null : (typeof row.original_payment_trx_no === "string" && TRX_NO.test(row.original_payment_trx_no) ? row.original_payment_trx_no : null);
      if (!objectId || !merchantIdentityId || !merchantOrderNo
        || row.provider_refund_trx_no !== null && providerTrx === null || row.original_payment_trx_no !== null && originalTrx === null) {
        return searchFailure("UNAVAILABLE", echo, asOf, "SEARCH_CANDIDATE_BINDING_MISMATCH");
      }
      if (merchantIdentityId !== echo.merchantIdentityId) return searchFailure("UNAVAILABLE", echo, asOf, "SEARCH_CANDIDATE_BINDING_MISMATCH");
      let role: ChannelOriginalCandidate["matchedNumberRole"];
      if (query.merchantOrderNo !== null) {
        if (merchantOrderNo === query.merchantOrderNo) {
          role = "OBJECT_ORDER";
          if (query.channelTrxNo !== null && providerTrx !== query.channelTrxNo) return searchFailure("UNAVAILABLE", echo, asOf, "SEARCH_CLUE_MISMATCH");
        } else if (originalOrderNo === query.merchantOrderNo) {
          role = "ORIGINAL_PAYMENT";
          if (query.channelTrxNo !== null && originalTrx !== query.channelTrxNo) return searchFailure("UNAVAILABLE", echo, asOf, "SEARCH_CLUE_MISMATCH");
        } else return searchFailure("UNAVAILABLE", echo, asOf, "SEARCH_CLUE_MISMATCH");
      } else {
        role = "CHANNEL_TRX_ONLY";
        if (query.channelTrxNo !== providerTrx && query.channelTrxNo !== originalTrx) return searchFailure("UNAVAILABLE", echo, asOf, "SEARCH_CLUE_MISMATCH");
      }
      const amount = money(row.amount_cents, row.currency, reasons, "SEARCH_AMOUNT_INVALID", "SEARCH_CURRENCY_NOT_CNY");
      if (!amount) return searchFailure("UNAVAILABLE", echo, asOf, "SEARCH_AMOUNT_UNAVAILABLE");
      const state = typeof row.state === "string" && REFUND_STATES.includes(row.state) ? row.state : "UNKNOWN";
      if (state === "UNKNOWN") add(reasons, "UNKNOWN_LOCAL_STATE");
      const disposition = typeof row.budget_disposition === "string" && BUDGET.includes(row.budget_disposition) ? row.budget_disposition : "UNKNOWN";
      if (disposition === "UNKNOWN") add(reasons, "UNKNOWN_LOCAL_BUDGET_DISPOSITION");
      const terminal = row.terminal_evidence_id === null ? null : id(row.terminal_evidence_id);
      if (row.terminal_evidence_id !== null && terminal === null) add(reasons, "LOCAL_TERMINAL_REFERENCE_UNREADABLE");
      const postingId = row.posting_id === null ? null : id(row.posting_id);
      if (row.posting_id !== null && postingId === null) add(reasons, "LOCAL_POSTING_REFERENCE_UNREADABLE");
      const requiresReview = typeof row.requires_review === "boolean" ? row.requires_review : null;
      if (requiresReview === null) add(reasons, "LOCAL_REVIEW_FLAG_UNREADABLE");
      candidates.push({ sourceFamily: "JOINPAY", productFamily: "REFUND", objectKind: "REFUND_INTENT", objectId,
        requestId: null, orderId: data.orderReadable && orderIdRaw && data.readableOrderIds.has(orderIdRaw) ? orderIdRaw : null, postingId, userId: null,
        merchantIdentityId, merchantOrderNo, channelTrxNo: providerTrx, amount, state,
        evidenceLevel: code(row.evidence_level) ?? "UNKNOWN", recordedAt,
        requiresReview, matchedNumberRole: role,
        channelTransactionRecorded: providerTrx !== null, budgetDisposition: disposition, fundsDisposition: null,
        localTerminalEvidenceId: terminal, originalPaymentOrderNo: originalOrderNo, originalPaymentTrxNo: originalTrx,
        economicRootId: null, reserveEventId: null });
      if (data.orderReadable && orderIdRaw === null) add(reasons, "ORDER_LINK_UNAVAILABLE");
      continue;
    }
    const objectId = id(row.intent_id), userIdRaw = id(row.user_id);
    const merchantOrderNo = typeof row.merchant_order_no === "string" && ORDER_NO.test(row.merchant_order_no) ? row.merchant_order_no : null;
    const platformSerial = row.platform_serial_no === null ? null : (typeof row.platform_serial_no === "string" && TRX_NO.test(row.platform_serial_no) ? row.platform_serial_no : null);
    if (!objectId || !merchantIdentityId || !merchantOrderNo
      || query.merchantOrderNo !== null && merchantOrderNo !== query.merchantOrderNo
      || query.channelTrxNo !== null && platformSerial !== query.channelTrxNo
      || row.platform_serial_no !== null && platformSerial === null) {
      return searchFailure("UNAVAILABLE", echo, asOf, "SEARCH_CANDIDATE_BINDING_MISMATCH");
    }
    if (merchantIdentityId !== echo.merchantIdentityId) return searchFailure("UNAVAILABLE", echo, asOf, "SEARCH_CANDIDATE_BINDING_MISMATCH");
    const amount = money(row.gross_cents, row.currency, reasons, "SEARCH_AMOUNT_INVALID", "SEARCH_CURRENCY_NOT_CNY");
    if (!amount) return searchFailure("UNAVAILABLE", echo, asOf, "SEARCH_AMOUNT_UNAVAILABLE");
    const state = typeof row.state === "string" && WITHDRAWAL_STATES.includes(row.state) ? row.state : "UNKNOWN";
    if (state === "UNKNOWN") add(reasons, "UNKNOWN_LOCAL_STATE");
    const disposition = typeof row.funds_disposition === "string" && FUNDS.includes(row.funds_disposition) ? row.funds_disposition : "UNKNOWN";
    if (disposition === "UNKNOWN") add(reasons, "UNKNOWN_LOCAL_FUNDS_DISPOSITION");
    const terminal = row.terminal_evidence_id === null ? null : id(row.terminal_evidence_id);
    if (row.terminal_evidence_id !== null && terminal === null) add(reasons, "LOCAL_TERMINAL_REFERENCE_UNREADABLE");
    const economicRootId = row.economic_root_id === null ? null : id(row.economic_root_id);
    const reserveEventId = row.reserve_event_id === null ? null : id(row.reserve_event_id);
    if (!economicRootId || !reserveEventId) add(reasons, "WITHDRAWAL_REFERENCE_UNREADABLE");
    const userId = data.userReadable && userIdRaw && data.readableUserIds.has(userIdRaw) ? userIdRaw : null;
    if (data.userReadable && userIdRaw === null) add(reasons, "USER_LINK_UNAVAILABLE");
    const requiresReview = typeof row.requires_review === "boolean" ? row.requires_review : null;
    if (requiresReview === null) add(reasons, "LOCAL_REVIEW_FLAG_UNREADABLE");
    candidates.push({ sourceFamily: "JOINPAY", productFamily: "PAYOUT", objectKind: "JOINPAY_WITHDRAWAL_INTENT", objectId,
      requestId: null, orderId: null, postingId: null, userId,
      merchantIdentityId, merchantOrderNo, channelTrxNo: platformSerial, amount, state,
      evidenceLevel: "LOCAL_RECORDS_NOT_REVALIDATED", recordedAt,
      requiresReview,
      matchedNumberRole: query.merchantOrderNo !== null ? "OBJECT_ORDER" : "CHANNEL_TRX_ONLY",
      channelTransactionRecorded: platformSerial !== null, budgetDisposition: null, fundsDisposition: disposition,
      localTerminalEvidenceId: terminal, originalPaymentOrderNo: null, originalPaymentTrxNo: null,
      economicRootId, reserveEventId });
  }
  const truncated = rows.length > query.limit;
  const status: ChannelOriginalSearch["status"] = candidates.length === 0 ? "NOT_FOUND_LOCAL"
    : candidates.length === 1 && !truncated ? "FOUND" : "AMBIGUOUS";
  add(reasons, "LOCAL_REGISTERED_ONLY");
  if (status === "NOT_FOUND_LOCAL") add(reasons, "NOT_FOUND_LOCAL_MEANS_NOT_REGISTERED_OR_NOT_AUTHORIZED");
  if (status === "AMBIGUOUS") add(reasons, "AMBIGUOUS_MORE_THAN_ONE_LOCAL_MATCH");
  if (truncated) add(reasons, "CANDIDATES_TRUNCATED");
  if (!data.orderReadable || candidates.some(c => c.objectKind !== "JOINPAY_WITHDRAWAL_INTENT" && c.orderId === null)) add(reasons, "ORDER_LINK_REDACTED");
  if (!data.userReadable || candidates.some(c => c.objectKind === "JOINPAY_WITHDRAWAL_INTENT" && c.userId === null)) add(reasons, "USER_LINK_REDACTED");
  return searchResult(status, echo, asOf, candidates, truncated, reasons);
}
