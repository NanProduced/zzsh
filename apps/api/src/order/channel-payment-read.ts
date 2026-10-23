import type { PoolClient } from "pg";
import type { OrderUserContext } from "./order";
import { notFound } from "../supply/supply-util";
import { readFormalPaymentEvidence, type ChannelPaymentReadOptions, type FormalObservation } from "./channel-payment-formal-read";
export type { ChannelPaymentReadOptions } from "./channel-payment-formal-read";

type Client = Pick<PoolClient, "query">;
type Money = { cents: string; currency: string };
type Origin = "NATIVE" | "LEGACY";
type Projection = { displayState: string; actionBlockedReason: string | null };
type DataOrigin = "SYNTHETIC_PROTOCOL" | "LOCAL_CONTROLLED" | "JOINPAY_CANDIDATE" | "JOINPAY_PROVIDER" | "UNKNOWN";
type Request = {
  id: string; order_id: string; channel: string; state: string; method: string; amount_cents: string | null;
  currency: string; merchant_identity_id: string; channel_order_no: string; config_profile_id: string;
  protocol_version: string; key_version_ref: string; evidence_level: string; created_at: string; updated_at: string;
};
type Confirmation = {
  id: string; order_id: string; source: string; disposition: "APPLIED" | "REVIEW_REQUIRED"; reason_code: string | null;
  amount_cents: string | null; currency: string; accepted_at: string;
};
type Observation = {
  id: string; request_id: string; channel: string; merchant_identity_id: string | null; channel_order_no: string | null;
  config_profile_id: string | null; protocol_version: string | null; key_version_ref: string | null;
  operation: string; source: string; evidence_level: string; event: string; result: string; reason: string | null;
  channel_status: string | null; channel_trx_no: string | null; provider_paid_at_raw: string | null;
  raw_sha256: string; observed_at: string; stale: boolean; late: boolean; conflict: boolean;
};
type Snapshot = {
  order: { id: string; display_no: string; status: string; paid_at: string | null; hold_expired: boolean; created_at: string;
    paid_confirmation_id?: string | null; has_confirmation?: boolean };
  request: Request | null; confirmation: Confirmation | null; observations: Observation[]; conflicts: Observation[];
  conflicts_truncated: boolean; latest_observed_at: string | null;
};

export type OrderPaymentRequestView = {
  contractVersion: "order-payment-request.v1";
  dataOrigin: DataOrigin;
  capability: { channelEnabled: boolean; methods: ["ALIPAY_NATIVE", "WEIXIN_NATIVE"]; evidenceProfile: "JOINPAY_AGG_2_6_MD5"; productionPaymentCapability: boolean };
  order: { id: string; displayNo: string; status: string; paidAt: string | null };
  request: { id: string; state: string; method: string; amount: Money | null; updatedAt: string;
    recovery: { mode: "ORIGINAL_NUMBER_QUERY"; nextAttemptAt: null; manualQueryOpen: false } | null } | null;
  projection: Projection;
  paymentAction: null | { kind: "QR_URL"; url: string; expiresAt: null; expiryKnown: false };
  payment: { confirmationId: string; disposition: "APPLIED" | "REVIEW_REQUIRED"; reasonCode: string | null; amount: Money | null; acceptedAt: string } | null;
};

export type AdminOrderPaymentSummary = {
  contractVersion: "admin-order-payment-summary.v1"; integration: "NOT_INTEGRATED" | "CONTROLLED_LOCAL" | "JOINPAY";
  productionPaymentCapability: boolean;
  dataOrigin: DataOrigin;
  originalRequest: { id: string; channelOrderNo: string | null; method: string; amount: Money | null;
    merchantIdentityId: string | null; protocolVersion: string; keyVersionRef: string | null; createdAt: string } | null;
  latestTrustedObservation: FormalObservation | { source: "NOTIFY" | "QUERY" | "SYNC_RESPONSE"; evidenceLevel: "SYNTHETIC_PROTOCOL";
    channelStatus: "SUCCEEDED" | "FAILED" | "CREATED_UNPAID" | null; channelTrxNo: string | null;
    providerPaidAtRaw: string | null; providerTimeZone: "UNCONFIRMED"; evidenceRef: string; observedAt: string } | null;
  acceptance: { state: "APPLIED" | "REVIEW_REQUIRED" | "PENDING" | "NONE"; confirmationId: string | null; reasonCode: string | null } | null;
  conflicts: { kind: "CHANNEL_STATUS_CONFLICT" | "STALE" | "LATE" | "DUPLICATE"; observedAt: string; evidenceRef: string | null }[] | null;
  recovery: { mode: "NONE" | "ORIGINAL_NUMBER_QUERY"; manualQueryOpen: false; lastAttemptAt: null; attempts: null } | null;
  settlement: "NOT_INTEGRATED"; unknowns: string[] | null; updatedAt: string | null;
};

const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// 与既有 legacyContinuationReady 相同：先查部署状态，不用缺表异常伪装空事实。
async function ready(client: Client): Promise<boolean> {
  return (await client.query<{ ready: boolean }>(`SELECT to_regclass('zzsh_order.payment_request') IS NOT NULL
    AND to_regclass('zzsh_order.payment_channel_observation') IS NOT NULL
    AND to_regclass('zzsh_order.payment_channel_transaction') IS NOT NULL AS ready`)).rows[0]?.ready === true;
}

const observationColumns = `x.id,x.request_id,x.channel,x.merchant_identity_id,x.channel_order_no,x.config_profile_id,
  x.protocol_version,x.key_version_ref,x.operation,x.source,x.evidence_level,x.event,x.result,x.reason,x.channel_status,
  x.channel_trx_no,x.provider_paid_at_raw,x.raw_sha256,${utc("x.observed_at")} AS observed_at,x.stale,x.late,x.conflict`;

// 订单、请求、确认和观察只用这一条语句的快照；金额先转 text，永不经 JSON number。
const snapshotSql = `WITH scoped AS (
  SELECT id,display_no,status,paid_at,paid_confirmation_id,hold_until,created_at FROM zzsh_order.rental_order
  WHERE id=$1 AND ($2::text IS NULL OR renter_user_id=$2)
), req AS (SELECT p.* FROM zzsh_order.payment_request p JOIN scoped o ON o.id=p.order_id),
observed AS (SELECT x.* FROM zzsh_order.payment_channel_observation x JOIN req r ON r.id=x.request_id)
SELECT jsonb_build_object('id',o.id,'display_no',o.display_no,'status',o.status,'paid_at',${utc("o.paid_at")},
    'hold_expired',o.hold_until<=statement_timestamp(),'created_at',${utc("o.created_at")},'paid_confirmation_id',o.paid_confirmation_id,
    'has_confirmation',EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.order_id=o.id)) AS "order",
  (SELECT jsonb_build_object('id',r.id,'order_id',r.order_id,'channel',r.channel,'state',r.state,'method',r.method,
    'amount_cents',r.amount_cents::text,'currency',r.currency,'merchant_identity_id',r.merchant_identity_id,
    'channel_order_no',r.channel_order_no,'config_profile_id',r.config_profile_id,'protocol_version',r.protocol_version,
    'key_version_ref',r.key_version_ref,'evidence_level',r.evidence_level,'created_at',${utc("r.created_at")},
    'updated_at',${utc("r.updated_at")}) FROM req r) AS request,
  (SELECT jsonb_build_object('id',p.id,'order_id',p.order_id,'source',p.source,'disposition',p.disposition,'reason_code',p.reason_code,
    'amount_cents',p.amount_cents::text,'currency',p.currency,'accepted_at',${utc("p.accepted_at")})
   FROM zzsh_order.payment_confirmation p WHERE p.order_id=o.id AND
     ((p.disposition='APPLIED' AND p.id=o.paid_confirmation_id AND p.currency='CNY') OR p.disposition='REVIEW_REQUIRED')
   ORDER BY (p.disposition='APPLIED') DESC,p.accepted_at DESC,p.id DESC LIMIT 1) AS confirmation,
  COALESCE((SELECT jsonb_agg(v ORDER BY v.observed_at DESC,v.id DESC) FROM (
    SELECT ${observationColumns} FROM observed x JOIN req r ON r.id=x.request_id
    WHERE x.channel=r.channel AND x.merchant_identity_id=r.merchant_identity_id AND x.channel_order_no=r.channel_order_no
      AND x.config_profile_id=r.config_profile_id AND x.protocol_version=r.protocol_version AND x.key_version_ref=r.key_version_ref
      AND x.evidence_level='SYNTHETIC_PROTOCOL' AND r.evidence_level='SYNTHETIC_PROTOCOL' AND x.channel='JOINPAY'
      AND NOT x.stale AND NOT x.conflict AND x.raw_sha256 ~ '^[a-f0-9]{64}$'
      AND ((x.operation='SYNC_RESPONSE' AND x.source='EXECUTOR' AND
          ((x.event='E1' AND x.result='ACTION_READY') OR (x.event='E1P' AND x.result='PROCESSING_UNCONFIRMED') OR (x.event='E2' AND x.result='REJECTED_BY_CHANNEL')))
        OR (x.operation='ASYNC_NOTIFY' AND x.source='PROVIDER_INBOUND' AND
          ((x.event='E4' AND x.result='CHANNEL_SIGNED_SYNTHETIC') OR (x.event='E5' AND x.result='CHANNEL_REPORTED_FAILED')))
        OR (x.operation='QUERY_RESPONSE' AND x.source='EXECUTOR' AND
          ((x.event='E4' AND x.result='QUERY_SUCCEEDED') OR (x.event='E5' AND x.result='CHANNEL_REPORTED_FAILED') OR (x.event='E6' AND x.result='CHANNEL_CREATED_UNPAID'))))
    ORDER BY x.observed_at DESC,x.id DESC LIMIT 1) v),'[]'::jsonb) AS observations,
  COALESCE((SELECT jsonb_agg(v ORDER BY v.observed_at DESC,v.id DESC) FROM (
    SELECT ${observationColumns} FROM observed x WHERE x.stale OR x.late OR x.conflict
    ORDER BY x.observed_at DESC,x.id DESC LIMIT 100) v),'[]'::jsonb) AS conflicts,
  (SELECT count(*)>100 FROM observed x WHERE x.stale OR x.late OR x.conflict) AS conflicts_truncated,
  (SELECT ${utc("max(x.observed_at)")} FROM observed x) AS latest_observed_at
FROM scoped o`;

async function snapshot(client: Client, orderId: string, renterUserId: string | null): Promise<Snapshot> {
  const row = (await client.query<Snapshot>(snapshotSql, [orderId, renterUserId])).rows[0];
  if (!row) throw notFound();
  if (row.confirmation && (row.confirmation.order_id !== row.order.id || (row.confirmation.disposition === "APPLIED"
    && (row.confirmation.id !== row.order.paid_confirmation_id || row.confirmation.currency !== "CNY")))) row.confirmation = null;
  return row;
}

const stateProjection: Record<string, readonly [string, string]> = {
  NONE: ["NOT_STARTED", "NO_REQUEST"], SUBMITTING: ["SUBMITTING", "REQUEST_SUBMITTING"],
  UNKNOWN: ["CONFIRMING", "CHANNEL_RESULT_UNKNOWN"], ACTION_READY: ["AWAITING_PAYMENT", "ACTION_PARAMS_UNAVAILABLE"],
  PROCESSING_UNCONFIRMED: ["PROCESSING", "ACTION_PARAMS_UNAVAILABLE"], REJECTED_BY_CHANNEL: ["REJECTED", "CHANNEL_REJECTED"],
  CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE: ["CONFIRMING_PAYMENT", "CHANNEL_RESULT_PENDING"],
  ACCEPTED: ["PAID", "PAYMENT_ACCEPTED"], REVIEW_REQUIRED: ["UNDER_REVIEW", "PAYMENT_REVIEW"],
};

function projection(row: Snapshot): Projection {
  let pair: readonly [string, string];
  if (row.confirmation?.disposition === "APPLIED") pair = ["PAID", "PAYMENT_ACCEPTED"];
  else if (row.confirmation?.disposition === "REVIEW_REQUIRED") pair = ["UNDER_REVIEW", "PAYMENT_REVIEW"];
  else if (row.request?.state === "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE") pair = stateProjection.CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE!;
  else if (row.order.status !== "PENDING_PAYMENT") pair = ["ORDER_CLOSED", "ORDER_NOT_PAYABLE"];
  else if (row.order.hold_expired) pair = ["ORDER_CLOSED", "HOLD_EXPIRED"];
  else {
    const state = row.request?.state ?? "NONE";
    pair = Object.hasOwn(stateProjection, state) ? stateProjection[state]! : ["STATUS_PENDING_CONFIRMATION", "UNKNOWN_STATE"];
  }
  return { displayState: pair[0], actionBlockedReason: pair[1] };
}

const money = (cents: string | null, currency: string): Money | null =>
  typeof cents === "string" && /^(0|[1-9][0-9]*)$/.test(cents) ? { cents, currency } : null;

function dataOrigin(row: Snapshot): DataOrigin {
  const p = row.confirmation, r = row.request;
  if (p && (!["CONTROLLED", "JOINPAY"].includes(p.source) || !["APPLIED", "REVIEW_REQUIRED"].includes(p.disposition))) return "UNKNOWN";
  if (p?.source === "CONTROLLED") return "LOCAL_CONTROLLED";
  if (p?.source === "JOINPAY") return p.disposition === "APPLIED" && p.currency === "CNY" ? "JOINPAY_PROVIDER" : "JOINPAY_CANDIDATE";
  if (p) return "UNKNOWN";
  if (r?.evidence_level === "CONTROLLED_TEST") return "LOCAL_CONTROLLED";
  if (r && r.channel !== "JOINPAY") return "UNKNOWN";
  if (r?.evidence_level === "JOINPAY_CANDIDATE") return "JOINPAY_CANDIDATE";
  return !r || r.evidence_level === "SYNTHETIC_PROTOCOL" ? "SYNTHETIC_PROTOCOL" : "UNKNOWN";
}

/** actor 必须来自 readUserContext；此入口只读原生 renter 自己的订单，不接受客户端声明的用户身份。 */
export async function readChannelPaymentRequest(client: Client, input: {
  orderId: string; origin: Origin; actor: OrderUserContext;
}, options: ChannelPaymentReadOptions = {}): Promise<{ available: false; reason: "SCHEMA_NOT_DEPLOYED" } | { available: true; view: OrderPaymentRequestView }> {
  if (input.origin !== "NATIVE" || !input.actor?.userId || !input.actor.sessionId) throw notFound();
  if (!await ready(client)) {
    const owns = (await client.query(`SELECT id FROM zzsh_order.rental_order WHERE id=$1 AND renter_user_id=$2`, [input.orderId, input.actor.userId])).rows[0];
    if (!owns) throw notFound();
    return { available: false, reason: "SCHEMA_NOT_DEPLOYED" };
  }
  const row = await snapshot(client, input.orderId, input.actor.userId), r = row.request, p = row.confirmation;
  const origin = dataOrigin(row), formal = await readFormalPaymentEvidence(client,
    { ...row.order, has_confirmation: row.order.has_confirmation === true || !!p }, r, options);
  const projected = origin === "UNKNOWN" ? { displayState: "STATUS_PENDING_CONFIRMATION", actionBlockedReason: "UNKNOWN_SOURCE" } : projection(row);
  const qrUrl = origin === "JOINPAY_CANDIDATE" ? formal.qrUrl : null;
  return { available: true, view: {
    // 旧受控入口可独立接纳同一订单；付款事实的来源不能被请求渠道掩盖。
    contractVersion: "order-payment-request.v1", dataOrigin: origin,
    capability: { channelEnabled: formal.capability, methods: ["ALIPAY_NATIVE", "WEIXIN_NATIVE"], evidenceProfile: "JOINPAY_AGG_2_6_MD5", productionPaymentCapability: formal.capability },
    order: { id: row.order.id, displayNo: row.order.display_no, status: row.order.status, paidAt: row.order.paid_at },
    request: r ? { id: r.id, state: r.state, method: r.method, amount: money(r.amount_cents, r.currency), updatedAt: r.updated_at,
      recovery: r.state === "UNKNOWN" ? { mode: "ORIGINAL_NUMBER_QUERY", nextAttemptAt: null, manualQueryOpen: false } : null } : null,
    projection: qrUrl ? { ...projected, actionBlockedReason: null } : projected,
    paymentAction: qrUrl ? { kind: "QR_URL", url: qrUrl, expiresAt: null, expiryKnown: false } : null,
    payment: p && origin !== "UNKNOWN" ? { confirmationId: p.id, disposition: p.disposition, reasonCode: p.reason_code, amount: money(p.amount_cents, p.currency), acceptedAt: p.accepted_at } : null,
  } };
}

function notIntegrated(): AdminOrderPaymentSummary {
  return { contractVersion: "admin-order-payment-summary.v1", integration: "NOT_INTEGRATED", productionPaymentCapability: false, dataOrigin: "UNKNOWN",
    originalRequest: null, latestTrustedObservation: null, acceptance: null, conflicts: null, recovery: null,
    settlement: "NOT_INTEGRATED", unknowns: null, updatedAt: null };
}

const digest = (value: string): string | null => /^[a-f0-9]{64}$/.test(value) ? `sha256:${value}` : null;
function qualified(o: Observation, r: Request): boolean {
  if (r.channel !== "JOINPAY" || r.evidence_level !== "SYNTHETIC_PROTOCOL" || o.evidence_level !== "SYNTHETIC_PROTOCOL" || o.stale || o.conflict || !digest(o.raw_sha256)) return false;
  if (o.request_id !== r.id || ["channel", "merchant_identity_id", "channel_order_no", "config_profile_id", "protocol_version", "key_version_ref"].some(k =>
    !o[k as keyof Observation] || o[k as keyof Observation] !== r[k as keyof Request])) return false;
  if (o.operation === "SYNC_RESPONSE" && o.source === "EXECUTOR") return (
    (o.event === "E1" && o.result === "ACTION_READY") || (o.event === "E1P" && o.result === "PROCESSING_UNCONFIRMED") || (o.event === "E2" && o.result === "REJECTED_BY_CHANNEL"));
  if (o.operation === "ASYNC_NOTIFY" && o.source === "PROVIDER_INBOUND") return (
    (o.event === "E4" && o.result === "CHANNEL_SIGNED_SYNTHETIC") || (o.event === "E5" && o.result === "CHANNEL_REPORTED_FAILED"));
  return o.operation === "QUERY_RESPONSE" && o.source === "EXECUTOR" &&
    ((o.event === "E4" && o.result === "QUERY_SUCCEEDED") || (o.event === "E5" && o.result === "CHANNEL_REPORTED_FAILED") || (o.event === "E6" && o.result === "CHANNEL_CREATED_UNPAID"));
}

/** 前置：同一服务端上下文已核会话、order.read 和该来源的对象/game scope；financeReadable 也来自该上下文。 */
export async function readOrderPaymentSummary(client: Client, input: {
  orderId: string; origin: Origin; financeReadable: boolean;
}, options: ChannelPaymentReadOptions = {}): Promise<AdminOrderPaymentSummary> {
  if (input.origin !== "NATIVE" || !await ready(client)) return notIntegrated();
  const row = await snapshot(client, input.orderId, null), r = row.request, p = row.confirmation;
  const financeReadable = input.financeReadable === true;
  if (!r && !p) return notIntegrated();
  const origin = dataOrigin(row), formal = await readFormalPaymentEvidence(client,
    { ...row.order, has_confirmation: row.order.has_confirmation === true || !!p }, r, options);
  const unknowns = ["PROVIDER_TIMEZONE", "OFFICIAL_SIGN_VECTOR", "RECOVERY_ATTEMPTS_NOT_RECORDED"];
  const sorted = [...row.observations].sort((a, b) => a.observed_at === b.observed_at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.observed_at < b.observed_at ? 1 : -1);
  const o = r ? sorted.find(value => qualified(value, r)) : undefined;
  if (r?.channel === "JOINPAY") unknowns.push("BINDING_EVIDENCE_NOT_REVERIFIED", "OBSERVATION_AMOUNT_CURRENCY_METHOD_NOT_STORED");
  if (r && p && p.source !== r.channel) unknowns.push("PAYMENT_SOURCE_DIFFERS_FROM_REQUEST");
  unknowns.push(...formal.unknowns);
  if (origin === "UNKNOWN") unknowns.push("UNKNOWN_PAYMENT_SOURCE");
  if (!p && (r?.state === "ACCEPTED" || r?.state === "REVIEW_REQUIRED")) unknowns.push("REQUEST_TERMINAL_WITHOUT_CONFIRMATION");
  if (row.conflicts_truncated) unknowns.push("CONFLICTS_TRUNCATED_TO_LATEST_100");
  const conflicts: NonNullable<AdminOrderPaymentSummary["conflicts"]> = [];
  for (const x of [...row.conflicts].sort((a, b) => a.observed_at === b.observed_at ? (a.id < b.id ? 1 : a.id > b.id ? -1 : 0) : a.observed_at < b.observed_at ? 1 : -1)) {
    const kinds: (typeof conflicts)[number]["kind"][] = [];
    if (x.stale) kinds.push("STALE");
    if (x.late) kinds.push("LATE");
    if (x.conflict) kinds.push(x.reason === "DUPLICATE_PAYMENT" || x.result === "DUPLICATE" ? "DUPLICATE" : "CHANNEL_STATUS_CONFLICT");
    for (const kind of kinds) conflicts.push({ kind, observedAt: x.observed_at, evidenceRef: digest(x.raw_sha256) });
  }
  const formalObservation = formal.observation ? { ...formal.observation, channelTrxNo: financeReadable ? formal.observation.channelTrxNo : null } : null;
  if (formalObservation) {
    for (const code of ["PROVIDER_TIMEZONE", "OFFICIAL_SIGN_VECTOR", "BINDING_EVIDENCE_NOT_REVERIFIED", "OBSERVATION_AMOUNT_CURRENCY_METHOD_NOT_STORED"]) {
      const index = unknowns.indexOf(code); if (index >= 0) unknowns.splice(index, 1);
    }
  }
  const updatedAt = [row.order.created_at, row.order.paid_at, r?.updated_at, p?.accepted_at, row.latest_observed_at, formalObservation?.observedAt].filter((v): v is string => typeof v === "string").sort().at(-1) ?? null;
  return { contractVersion: "admin-order-payment-summary.v1", integration: r?.channel === "JOINPAY" || origin === "JOINPAY_PROVIDER" ? "JOINPAY" : origin === "LOCAL_CONTROLLED" ? "CONTROLLED_LOCAL" : "NOT_INTEGRATED", productionPaymentCapability: formal.capability, dataOrigin: origin,
    originalRequest: r ? { id: r.id, channelOrderNo: financeReadable ? r.channel_order_no : null, method: r.method,
      amount: financeReadable ? money(r.amount_cents, r.currency) : null, merchantIdentityId: financeReadable ? r.merchant_identity_id : null,
      protocolVersion: r.protocol_version, keyVersionRef: financeReadable ? r.key_version_ref : null, createdAt: r.created_at } : null,
    latestTrustedObservation: formalObservation ?? (o ? { source: o.operation === "ASYNC_NOTIFY" ? "NOTIFY" : o.operation === "QUERY_RESPONSE" ? "QUERY" : "SYNC_RESPONSE",
      evidenceLevel: "SYNTHETIC_PROTOCOL", channelStatus: o.event === "E4" ? "SUCCEEDED" : o.event === "E5" ? "FAILED" : o.event === "E6" ? "CREATED_UNPAID" : null,
      channelTrxNo: financeReadable ? o.channel_trx_no : null, providerPaidAtRaw: o.provider_paid_at_raw,
      providerTimeZone: "UNCONFIRMED", evidenceRef: digest(o.raw_sha256)!, observedAt: o.observed_at } : null),
    acceptance: { state: origin === "UNKNOWN" ? "NONE" : p?.disposition ?? (r?.state === "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE" ? "PENDING" : "NONE"), confirmationId: origin === "UNKNOWN" ? null : p?.id ?? null, reasonCode: p?.reason_code ?? null },
    conflicts, recovery: { mode: r?.state === "UNKNOWN" ? "ORIGINAL_NUMBER_QUERY" : "NONE", manualQueryOpen: false, lastAttemptAt: null, attempts: null },
    settlement: "NOT_INTEGRATED", unknowns, updatedAt };
}
