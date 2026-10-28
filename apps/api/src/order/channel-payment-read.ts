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

export type AdminPaymentAnomalySource = "CONFIRMATION" | "EVIDENCE" | "OBSERVATION" | "AUDIT" | "UNKNOWN";
export type AdminPaymentAnomalyKind = "LATE_PAYMENT" | "DUPLICATE_PAYMENT" | "BINDING_MISMATCH"
  | "ANCHOR_OWNED_ELSEWHERE" | "UNKNOWN_REASON";
export type AdminPaymentAnomalyReason = "LATE_PAYMENT" | "DUPLICATE_PAYMENT" | "BINDING_MISMATCH"
  | "ANCHOR_OWNED_ELSEWHERE" | "SIGNATURE_MISMATCH" | "SCHEMA_INVALID" | "UNCONFIRMED_SUCCESS" | "UNKNOWN_REASON";
export type AdminPaymentAnchorOwnership = "MATCH" | "MISSING" | "OTHER_ORDER" | "OTHER_REQUEST"
  | "MISMATCH" | "NOT_APPLICABLE" | "UNKNOWN";
export type AdminPaymentAnomaly = Readonly<{
  kind: AdminPaymentAnomalyKind;
  source: AdminPaymentAnomalySource;
  evidenceLevel: "JOINPAY_CONFIRMATION" | "CONTROLLED_CONFIRMATION" | "JOINPAY_EVIDENCE"
    | "JOINPAY_OBSERVATION" | "AUDIT_ONLY" | "UNKNOWN";
  trusted: boolean;
  observedAt: string | null;
  disposition: "APPLIED" | "REVIEW_REQUIRED" | null;
  reasonCode: AdminPaymentAnomalyReason | null;
  amount: Money | null;
  currency: string | null;
  confirmationId: string | null;
  requestId: string | null;
  merchantIdentityId: string | null;
  merchantOrderNo: string | null;
  providerTransactionId: string | null;
  anchorOwnership: AdminPaymentAnchorOwnership;
  evidenceRef: string | null;
}>;
export type AdminPaymentAnomalySection = Readonly<{
  contractVersion: "admin-order-payment-anomalies.v1";
  status: "AVAILABLE" | "SCHEMA_NOT_DEPLOYED";
  limit: 50;
  truncated: boolean | null;
  items: AdminPaymentAnomaly[] | null;
}>;

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
  anomalies?: AdminPaymentAnomalySection | null;
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

const ANOMALY_LIMIT = 50;
const anomalySchemaSql = `SELECT
  to_regclass('zzsh_order.joinpay_collection_evidence') IS NOT NULL
  AND (SELECT count(*)=11 FROM pg_attribute WHERE attrelid=to_regclass('zzsh_order.joinpay_collection_evidence')
    AND attname IN ('id','request_id','origin_observation_id','event','result','schema_outcome','signature_outcome','binding_outcome','channel_trx_no','raw_sha256','created_at') AND NOT attisdropped)
  AND to_regclass('zzsh_order.joinpay_collection_observation') IS NOT NULL
  AND (SELECT count(*)=9 FROM pg_attribute WHERE attrelid=to_regclass('zzsh_order.joinpay_collection_observation')
    AND attname IN ('id','request_id','event','result','schema_outcome','signature_outcome','binding_outcome','raw_sha256','created_at') AND NOT attisdropped)
  AND (SELECT count(*)=3 FROM pg_attribute WHERE attrelid=to_regclass('zzsh_order.payment_confirmation')
    AND attname IN ('joinpay_request_id','joinpay_evidence_id','joinpay_anchor_id') AND NOT attisdropped)
  AND (SELECT count(*)=6 FROM pg_attribute WHERE attrelid=to_regclass('zzsh_order.payment_channel_transaction')
    AND attname IN ('native_order_id','request_id','merchant_identity_id','channel_trx_no','channel','evidence_level') AND NOT attisdropped)
  AND to_regclass('zzsh_iam.audit_event') IS NOT NULL
  AND (SELECT count(*)=7 FROM pg_attribute WHERE attrelid=to_regclass('zzsh_iam.audit_event')
    AND attname IN ('action','object_type','object_id','request_id','outcome','occurred_at','details') AND NOT attisdropped) AS anomaly_ready`;

// 只读、限 51 行探针；raw/原件/密钥/完整审计 details 均不进入投影。
const anomalySql = `WITH anomaly_confirmation AS (
  SELECT 'CONFIRMATION:'||p.id AS stable_id, ${utc("p.accepted_at")} AS observed_at,
    p.id AS confirmation_id,p.joinpay_request_id AS request_id,p.disposition,p.reason_code,
    p.amount_cents::text AS amount_cents,p.currency,p.merchant_order_no,p.provider_transaction_id,
    p.source,p.merchant_scope_id AS merchant_identity_id,'CONFIRMATION'::text AS source_kind,e.raw_sha256 AS evidence_raw_sha256,NULL::text AS event,NULL::text AS result,
    NULL::text AS schema_outcome,NULL::text AS signature_outcome,NULL::text AS binding_outcome,
    CASE WHEN p.source<>'JOINPAY' THEN 'NOT_APPLICABLE'
      WHEN p.joinpay_anchor_id IS NULL THEN 'MISSING'
      WHEN a.id IS NULL THEN 'MISSING'
      WHEN a.native_order_id IS DISTINCT FROM p.order_id THEN 'OTHER_ORDER'
      WHEN a.request_id IS DISTINCT FROM p.joinpay_request_id THEN 'OTHER_REQUEST'
      WHEN a.channel IS DISTINCT FROM 'JOINPAY' OR a.evidence_level IS DISTINCT FROM 'JOINPAY_VERIFIED'
        OR a.merchant_identity_id IS DISTINCT FROM p.merchant_scope_id OR a.channel_trx_no IS DISTINCT FROM p.provider_transaction_id THEN 'MISMATCH'
      ELSE 'MATCH' END AS anchor_ownership,NULL::text AS audit_action
  FROM zzsh_order.payment_confirmation p
  LEFT JOIN zzsh_order.payment_channel_transaction a ON a.id=p.joinpay_anchor_id
  LEFT JOIN zzsh_order.joinpay_collection_evidence e ON e.id=p.joinpay_evidence_id
  WHERE p.order_id=$1
    AND (p.disposition='REVIEW_REQUIRED' OR p.id IS DISTINCT FROM (SELECT paid_confirmation_id FROM zzsh_order.rental_order WHERE id=$1)
      OR (p.source='JOINPAY' AND (p.joinpay_anchor_id IS NULL OR a.id IS NULL
        OR a.native_order_id IS DISTINCT FROM p.order_id OR a.request_id IS DISTINCT FROM p.joinpay_request_id
        OR a.channel IS DISTINCT FROM 'JOINPAY' OR a.evidence_level IS DISTINCT FROM 'JOINPAY_VERIFIED'
        OR a.merchant_identity_id IS DISTINCT FROM p.merchant_scope_id OR a.channel_trx_no IS DISTINCT FROM p.provider_transaction_id)))
), anomaly_evidence AS (
  SELECT 'EVIDENCE:'||e.id AS stable_id, ${utc("e.created_at")} AS observed_at,
    NULL::text AS confirmation_id,e.request_id,NULL::text AS disposition,NULL::text AS reason_code,
    NULL::text AS amount_cents,NULL::text AS currency,NULL::text AS merchant_order_no,NULL::text AS provider_transaction_id,
    'JOINPAY'::text AS source,r.merchant_identity_id,'EVIDENCE'::text AS source_kind,e.raw_sha256 AS evidence_raw_sha256,e.event,e.result,e.schema_outcome,e.signature_outcome,e.binding_outcome,
    CASE WHEN a.id IS NULL THEN 'MISSING'
      WHEN a.native_order_id IS DISTINCT FROM r.order_id THEN 'OTHER_ORDER'
      WHEN a.request_id IS DISTINCT FROM e.request_id THEN 'OTHER_REQUEST'
      WHEN a.channel IS DISTINCT FROM 'JOINPAY' OR a.evidence_level IS DISTINCT FROM 'JOINPAY_VERIFIED'
        OR a.merchant_identity_id IS DISTINCT FROM r.merchant_identity_id OR a.channel_trx_no IS DISTINCT FROM e.channel_trx_no THEN 'MISMATCH'
      ELSE 'MATCH' END AS anchor_ownership,NULL::text AS audit_action
  FROM zzsh_order.joinpay_collection_evidence e
  JOIN zzsh_order.payment_request r ON r.id=e.request_id
  LEFT JOIN zzsh_order.payment_channel_transaction a ON a.channel='JOINPAY' AND a.merchant_identity_id=r.merchant_identity_id AND a.channel_trx_no=e.channel_trx_no
  WHERE r.order_id=$1
    AND (e.event='E4' OR e.binding_outcome IS DISTINCT FROM 'MATCH' OR e.signature_outcome IS DISTINCT FROM 'MATCH' OR e.schema_outcome IS DISTINCT FROM 'VALID')
    AND (e.binding_outcome IS DISTINCT FROM 'MATCH' OR e.signature_outcome IS DISTINCT FROM 'MATCH' OR e.schema_outcome IS DISTINCT FROM 'VALID'
      OR NOT EXISTS (SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.source='JOINPAY' AND p.joinpay_request_id=e.request_id AND p.provider_transaction_id=e.channel_trx_no))
), anomaly_observation AS (
  SELECT 'OBSERVATION:'||o.id AS stable_id, ${utc("o.created_at")} AS observed_at,
    NULL::text AS confirmation_id,o.request_id,NULL::text AS disposition,NULL::text AS reason_code,
    NULL::text AS amount_cents,NULL::text AS currency,NULL::text AS merchant_order_no,NULL::text AS provider_transaction_id,
    'JOINPAY'::text AS source,r.merchant_identity_id,'OBSERVATION'::text AS source_kind,o.raw_sha256 AS evidence_raw_sha256,o.event,o.result,o.schema_outcome,o.signature_outcome,o.binding_outcome,
    'UNKNOWN'::text AS anchor_ownership,NULL::text AS audit_action
  FROM zzsh_order.joinpay_collection_observation o
  JOIN zzsh_order.payment_request r ON r.id=o.request_id
  WHERE r.order_id=$1
    AND (o.event='E4' OR o.binding_outcome IS DISTINCT FROM 'MATCH' OR o.signature_outcome IS DISTINCT FROM 'MATCH' OR o.schema_outcome IS DISTINCT FROM 'VALID')
    AND NOT EXISTS (SELECT 1 FROM zzsh_order.joinpay_collection_evidence e WHERE e.origin_observation_id=o.id)
), anomaly_audit AS (
  SELECT 'AUDIT:'||a.id AS stable_id, ${utc("a.occurred_at")} AS observed_at,
    NULL::text AS confirmation_id,
    CASE WHEN a.action='order.payment.collection.transaction.conflict' THEN a.object_id ELSE NULL::text END AS request_id,
    NULL::text AS disposition,NULL::text AS reason_code,
    NULL::text AS amount_cents,NULL::text AS currency,NULL::text AS merchant_order_no,NULL::text AS provider_transaction_id,
    NULL::text AS source,NULL::text AS merchant_identity_id,'AUDIT'::text AS source_kind,NULL::text AS evidence_raw_sha256,NULL::text AS event,NULL::text AS result,
    NULL::text AS schema_outcome,NULL::text AS signature_outcome,NULL::text AS binding_outcome,
    CASE WHEN a.action='order.payment.collection.transaction.conflict' THEN 'OTHER_ORDER' ELSE 'UNKNOWN' END AS anchor_ownership,
    a.action AS audit_action
  FROM zzsh_iam.audit_event a
  WHERE a.outcome='FAILURE' AND (
    (a.action='order.payment.collection.transaction.conflict' AND a.object_type='payment_request'
      AND a.object_id IN (SELECT id FROM zzsh_order.payment_request WHERE order_id=$1))
    OR (a.action='order.payment.conflict' AND a.object_type='payment_confirmation'
      AND (a.object_id IN (SELECT id FROM zzsh_order.payment_confirmation WHERE order_id=$1)
        OR a.details->'attempted'->>'orderId'=$1))
  )
)
SELECT COALESCE(jsonb_agg(v ORDER BY v.observed_at DESC,v.stable_id COLLATE "C" DESC),'[]'::jsonb) AS items
FROM (
  SELECT * FROM (
    SELECT * FROM anomaly_confirmation UNION ALL
    SELECT * FROM anomaly_evidence UNION ALL
    SELECT * FROM anomaly_observation UNION ALL
    SELECT * FROM anomaly_audit
  ) all_rows ORDER BY observed_at DESC,stable_id COLLATE "C" DESC LIMIT 51
) v`;

type AnomalyRow = {
  stable_id: string; observed_at: string | null; confirmation_id: string | null; request_id: string | null;
  disposition: string | null; reason_code: string | null; amount_cents: string | null; currency: string | null;
  merchant_order_no: string | null; provider_transaction_id: string | null; merchant_identity_id?: string | null; source: string | null; source_kind: string | null;
  evidence_raw_sha256: string | null; event: string | null; result: string | null;
  schema_outcome: string | null; signature_outcome: string | null; binding_outcome: string | null;
  anchor_ownership: string | null; audit_action: string | null;
};
const anomalySources = ["CONFIRMATION", "EVIDENCE", "OBSERVATION", "AUDIT"] as const;
const anchorOwnerships = ["MATCH", "MISSING", "OTHER_ORDER", "OTHER_REQUEST", "MISMATCH", "NOT_APPLICABLE", "UNKNOWN"] as const;
const anomalySource = (value: unknown): AdminPaymentAnomalySource =>
  typeof value === "string" && (anomalySources as readonly string[]).includes(value) ? value as AdminPaymentAnomalySource : "UNKNOWN";
const anomalyOwnership = (value: unknown): AdminPaymentAnchorOwnership =>
  typeof value === "string" && (anchorOwnerships as readonly string[]).includes(value) ? value as AdminPaymentAnchorOwnership : "UNKNOWN";
const anomalyRef = (value: unknown): string | null =>
  typeof value === "string" && /^[a-f0-9]{64}$/.test(value) ? `sha256:${value}` : null;
const anomalyMoney = (cents: unknown, currency: string | null): Money | null =>
  currency !== null && typeof cents === "string" && /^(0|[1-9][0-9]*)$/.test(cents) ? { cents, currency } : null;
function anomalyCategory(row: AnomalyRow, source: AdminPaymentAnomalySource) {
  if (source === "CONFIRMATION") {
    const disposition: "APPLIED" | "REVIEW_REQUIRED" | null = row.disposition === "APPLIED" ? "APPLIED"
      : row.disposition === "REVIEW_REQUIRED" ? "REVIEW_REQUIRED" : null;
    const trusted = disposition !== null && (row.source === "JOINPAY" || row.source === "CONTROLLED");
    if (disposition === "REVIEW_REQUIRED") {
      const code = row.reason_code === "LATE_PAYMENT" || row.reason_code === "DUPLICATE_PAYMENT" || row.reason_code === "BINDING_MISMATCH"
        ? row.reason_code : "UNKNOWN_REASON";
      return { kind: code as AdminPaymentAnomalyKind, reasonCode: code as AdminPaymentAnomalyReason, trusted, disposition };
    }
    if (disposition === "APPLIED") {
      if (["OTHER_ORDER", "OTHER_REQUEST", "MISMATCH"].includes(row.anchor_ownership ?? "")) {
        return { kind: "ANCHOR_OWNED_ELSEWHERE" as const, reasonCode: "ANCHOR_OWNED_ELSEWHERE" as const, trusted, disposition };
      }
      if (row.anchor_ownership === "MISSING") {
        return { kind: "UNKNOWN_REASON" as const, reasonCode: "UNKNOWN_REASON" as const, trusted, disposition };
      }
      return { kind: "DUPLICATE_PAYMENT" as const, reasonCode: "DUPLICATE_PAYMENT" as const, trusted, disposition };
    }
    return { kind: "UNKNOWN_REASON" as const, reasonCode: "UNKNOWN_REASON" as const, trusted: false, disposition };
  }
  if (source === "AUDIT") {
    if (row.audit_action === "order.payment.collection.transaction.conflict") {
      return { kind: "ANCHOR_OWNED_ELSEWHERE" as const, reasonCode: "ANCHOR_OWNED_ELSEWHERE" as const, trusted: false, disposition: null };
    }
    if (row.audit_action === "order.payment.conflict") {
      return { kind: "BINDING_MISMATCH" as const, reasonCode: "BINDING_MISMATCH" as const, trusted: false, disposition: null };
    }
    return { kind: "UNKNOWN_REASON" as const, reasonCode: "UNKNOWN_REASON" as const, trusted: false, disposition: null };
  }
  if (source === "EVIDENCE" || source === "OBSERVATION") {
    if (row.schema_outcome === "INVALID") return { kind: "UNKNOWN_REASON" as const, reasonCode: "SCHEMA_INVALID" as const, trusted: false, disposition: null };
    if (row.signature_outcome === "MISMATCH") return { kind: "UNKNOWN_REASON" as const, reasonCode: "SIGNATURE_MISMATCH" as const, trusted: false, disposition: null };
    if (row.schema_outcome !== "VALID" || row.signature_outcome !== "MATCH") return { kind: "UNKNOWN_REASON" as const, reasonCode: "UNKNOWN_REASON" as const, trusted: false, disposition: null };
    if (["OTHER_ORDER", "OTHER_REQUEST", "MISMATCH"].includes(row.anchor_ownership ?? "")) {
      return { kind: "ANCHOR_OWNED_ELSEWHERE" as const, reasonCode: "ANCHOR_OWNED_ELSEWHERE" as const, trusted: false, disposition: null };
    }
    if (row.binding_outcome === "MISMATCH") return { kind: "BINDING_MISMATCH" as const, reasonCode: "BINDING_MISMATCH" as const, trusted: false, disposition: null };
    if (row.binding_outcome !== "MATCH") return { kind: "UNKNOWN_REASON" as const, reasonCode: "UNKNOWN_REASON" as const, trusted: false, disposition: null };
    if (row.event === "E4") return { kind: "UNKNOWN_REASON" as const, reasonCode: "UNCONFIRMED_SUCCESS" as const, trusted: false, disposition: null };
  }
  return { kind: "UNKNOWN_REASON" as const, reasonCode: "UNKNOWN_REASON" as const, trusted: false, disposition: null };
}
function toAnomaly(row: AnomalyRow, financeReadable: boolean): AdminPaymentAnomaly {
  const source = anomalySource(row.source_kind);
  const category = anomalyCategory(row, source);
  const currency = financeReadable && category.trusted && typeof row.currency === "string" && /^[A-Z]{3}$/.test(row.currency) ? row.currency : null;
  const confirmation = source === "CONFIRMATION" && category.trusted;
  const providerTransactionId = financeReadable && confirmation && typeof row.provider_transaction_id === "string"
    && /^[A-Za-z0-9_-]{1,128}$/.test(row.provider_transaction_id) ? row.provider_transaction_id : null;
  const merchantOrderNo = financeReadable && confirmation && typeof row.merchant_order_no === "string"
    && row.merchant_order_no.length >= 1 && row.merchant_order_no.length <= 128 ? row.merchant_order_no : null;
  const observedAt = typeof row.observed_at === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(row.observed_at) ? row.observed_at : null;
  return { kind: category.kind, source,
    evidenceLevel: source === "CONFIRMATION" ? row.source === "JOINPAY" ? "JOINPAY_CONFIRMATION" : row.source === "CONTROLLED" ? "CONTROLLED_CONFIRMATION" : "UNKNOWN"
      : source === "EVIDENCE" ? "JOINPAY_EVIDENCE" : source === "OBSERVATION" ? "JOINPAY_OBSERVATION" : source === "AUDIT" ? "AUDIT_ONLY" : "UNKNOWN",
    trusted: category.trusted, observedAt, disposition: category.disposition, reasonCode: category.reasonCode,
    amount: financeReadable && category.trusted ? anomalyMoney(row.amount_cents, currency) : null, currency,
    confirmationId: financeReadable && source === "CONFIRMATION" ? row.confirmation_id : null,
    requestId: financeReadable ? row.request_id : null,
    merchantIdentityId: financeReadable && confirmation && typeof row.merchant_identity_id === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.merchant_identity_id) ? row.merchant_identity_id : null,
    merchantOrderNo, providerTransactionId,
    anchorOwnership: anomalyOwnership(row.anchor_ownership),
    evidenceRef: financeReadable ? anomalyRef(row.evidence_raw_sha256) : null };
}
async function readAdminPaymentAnomalies(client: Client, orderId: string, financeReadable: boolean): Promise<AdminPaymentAnomalySection> {
  const readyRow = (await client.query<{ anomaly_ready: boolean }>(anomalySchemaSql)).rows[0];
  if (readyRow?.anomaly_ready !== true) {
    return { contractVersion: "admin-order-payment-anomalies.v1", status: "SCHEMA_NOT_DEPLOYED", limit: ANOMALY_LIMIT, truncated: null, items: null };
  }
  const result = (await client.query<{ items: unknown }>(anomalySql, [orderId])).rows[0];
  if (!result || !Array.isArray(result.items) || result.items.some(item => !item || typeof item !== "object")) {
    throw new Error("Anomaly projection is unavailable");
  }
  const rows = (result.items as AnomalyRow[]).slice().sort((a, b) => {
    const left = typeof a.observed_at === "string" ? a.observed_at : "";
    const right = typeof b.observed_at === "string" ? b.observed_at : "";
    if (left === right) return a.stable_id < b.stable_id ? 1 : a.stable_id > b.stable_id ? -1 : 0;
    return left < right ? 1 : -1;
  });
  return { contractVersion: "admin-order-payment-anomalies.v1", status: "AVAILABLE", limit: ANOMALY_LIMIT,
    truncated: rows.length > ANOMALY_LIMIT, items: rows.slice(0, ANOMALY_LIMIT).map(row => toAnomaly(row, financeReadable)) };
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
  const anomalies = await readAdminPaymentAnomalies(client, input.orderId, financeReadable);
  if (anomalies.status === "SCHEMA_NOT_DEPLOYED") unknowns.push("ANOMALY_SCHEMA_NOT_DEPLOYED");
  if (anomalies.truncated === true) unknowns.push("ANOMALIES_TRUNCATED_TO_LATEST_50");
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
    settlement: "NOT_INTEGRATED", unknowns, updatedAt, anomalies };
}
