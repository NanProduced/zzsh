import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { SecurityApiError } from "../auth/security-core";
import { ConfigurationError, type AppConfig } from "../config/config";
import { API_V1_ERROR_CODES, validateIdempotencyKey } from "../contracts/api-v1";
import type { PaymentDistributionStore } from "../finance/distribution-payment-store";
import { conflict, fingerprintRequest, invalid, notFound, withIdempotency, type IdempotentResult } from "../supply/supply-util";
import {
  JoinpayProtocolError, centsToJoinpayYuan, decodeJoinpayQuery, evaluateJoinpayNotify, evaluateJoinpayQueryResponse,
  evaluateJoinpaySyncResponse, evaluateJoinpayTransportFailure, joinpayTransition, type JoinpayOutcome, type JoinpayPersistedRequest, type RequestState,
  type JoinpayTransportFailure,
} from "./joinpay-protocol";
import { confirmOrderPayment, type PaymentResult } from "./payment-confirmation";
import { describeCollectionProfile, type BoundCollectionProfile } from "./joinpay-collection-profile";
import { readVerifiedJoinpayFactScope, type FormalJoinpayPaymentFact } from "./joinpay-collection-source";

/**
 * PAY-03A：持久请求、只追加观察与资金归属锚点（payment_request / payment_channel_observation /
 * payment_channel_transaction）。所有写函数只使用调用者传入的同一个 PoolClient，不开第二事务、不提交。
 * JOINPAY 结果始终是 SYNTHETIC_PROTOCOL 观察，绝不成为可信付款事实或 APPLIED；接纳只走原 confirmOrderPayment。
 *
 * 事务锁序按路径区分：创建请求为幂等 → 请求创建 advisory → 订单行 → 渠道原号 advisory；
 * 记录观察为 request 行 → 资金锚点 advisory；受控接纳为 request 行（可选）→ 资金锚点 advisory
 * → 原 confirmOrderPayment 的 dispatch → 资金 → invitation graph → 用户 → 账号 → 订单。
 * 创建路径持订单行时不再获取接纳路径的锁；实际等待与无死锁结论仍须隔离 PG 验证。
 */

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const JOINPAY_ORDER_NO = /^[A-Za-z0-9_]{1,50}$/;
const METHODS = ["ALIPAY_NATIVE", "WEIXIN_NATIVE"] as const;
const CLAIMABLE: readonly RequestState[] = ["SUBMITTING", "UNKNOWN", "ACTION_READY", "PROCESSING_UNCONFIRMED"];
const TERMINAL: readonly RequestState[] = ["ACCEPTED", "REVIEW_REQUIRED"];
const CSPA: RequestState = "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE";
const sha256 = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const lockKey = (parts: readonly string[]) => BigInt(`0x${sha256(JSON.stringify(parts)).slice(0, 15)}`).toString();
const xactLock = (client: PoolClient, parts: readonly string[]) => client.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [lockKey(parts)]);

export type PaymentChannel = "JOINPAY" | "CONTROLLED";
export type PaymentMethod = (typeof METHODS)[number];
export type ChannelBinding = Readonly<{ channel: PaymentChannel; merchantIdentityId: string; configProfileId: string; protocolVersion: string; keyVersionRef: string }>;
/** 服务端已认证的身份；本包不接 URL/Cookie/认证装配，由后续接线包注入。 */
export type PaymentActor = Readonly<{ userId: string }>;

/** 首次请求时确定渠道原号：JOINPAY 将 display_no 中 '-' 换为 '_' 并校验；CONTROLLED 保持原 display_no。 */
export function mapChannelOrderNo(channel: PaymentChannel, displayNo: string): string {
  if (typeof displayNo !== "string" || displayNo.length < 1 || displayNo.length > 128) throw invalid("Invalid platform order number");
  if (channel === "CONTROLLED") return displayNo;
  const mapped = displayNo.replaceAll("-", "_");
  if (!JOINPAY_ORDER_NO.test(mapped)) throw invalid("Platform order number cannot map to channel order number");
  return mapped;
}

/** 复用 PAY-02 整数分→wire 金额与出站范围校验；协议错误统一转为 400，不用 Number。 */
export function wireAmountForCents(amountCents: string): string {
  try { return centsToJoinpayYuan(amountCents); } catch (error) {
    if (error instanceof JoinpayProtocolError) throw invalid("Payment amount outside channel protocol range");
    throw error;
  }
}

// ---------- 合成请求能力：仅显式 test/fake 隔离资源，进程内对象，无环境开关 ----------
const requestCapabilities = new WeakMap<object, { database: string; runtimeUser: string }>();
export type SyntheticRequestCapability = Readonly<{ evidenceLevel: "SYNTHETIC_PROTOCOL" | "CONTROLLED_TEST" }>;

export function createSyntheticChannelRequestCapability(options: { config: AppConfig; resourceSet: string; evidenceLevel: SyntheticRequestCapability["evidenceLevel"] }): SyntheticRequestCapability {
  const { config, resourceSet } = options;
  if (config.profile !== "test" || config.provider !== "fake" || !config.testOperationsEnabled
    || config.database.target !== "local-compose" || config.database.host !== "127.0.0.1" || config.database.port !== 55432
    || !/^[a-z][a-z0-9_]{0,20}$/.test(resourceSet)
    || config.database.name !== `zzsh_test_order_${resourceSet}` || config.database.user !== `zzsh_order_${resourceSet}_r`
    || (options.evidenceLevel !== "SYNTHETIC_PROTOCOL" && options.evidenceLevel !== "CONTROLLED_TEST")) {
    throw new ConfigurationError("Synthetic channel request requires an explicit isolated test/fake resource");
  }
  const capability = Object.freeze({ evidenceLevel: options.evidenceLevel });
  requestCapabilities.set(capability, { database: config.database.name, runtimeUser: config.database.user });
  return capability;
}

export type PaymentRequestFailureReason = "PAYMENT_CHANNEL_NOT_ENABLED" | "PAYMENT_REQUEST_EXISTS" | "ORDER_NOT_PAYABLE";
function requestFailure(paymentReason: PaymentRequestFailureReason, message: string): SecurityApiError & { paymentReason: PaymentRequestFailureReason } {
  const disabled = paymentReason === "PAYMENT_CHANNEL_NOT_ENABLED";
  // 公共错误码由管理线统一登记；保留机器可读的领域原因，接线时无需匹配文案。
  return Object.assign(new SecurityApiError(disabled ? 503 : 409, disabled ? API_V1_ERROR_CODES.EVIDENCE_UNAVAILABLE : API_V1_ERROR_CODES.CONFLICT, message), { paymentReason });
}
const closed = () => requestFailure("PAYMENT_CHANNEL_NOT_ENABLED", "Channel payment capability is closed");

export async function assertSyntheticChannelRequestCapability(client: PoolClient, capability: unknown): Promise<SyntheticRequestCapability["evidenceLevel"]> {
  const scope = capability && typeof capability === "object" ? requestCapabilities.get(capability) : undefined;
  if (!scope) throw closed();
  const identity = (await client.query(`SELECT current_database() AS db, current_user AS actor`)).rows[0];
  if (identity?.db !== scope.database || identity?.actor !== scope.runtimeUser) throw closed();
  return (capability as SyntheticRequestCapability).evidenceLevel;
}

// ---------- 持久请求 ----------
type RequestRow = {
  id: string; order_id: string; channel: PaymentChannel; merchant_identity_id: string; config_profile_id: string;
  protocol_version: string; key_version_ref: string; platform_order_no: string; channel_order_no: string;
  amount_cents: string; currency: string; wire_amount_yuan: string; method: PaymentMethod; evidence_level: string;
  state: RequestState; revision: string; lease_version: string; lease_owner: string | null; created_at: string; updated_at: string;
};
const REQUEST_COLUMNS = `id, order_id, channel, merchant_identity_id, config_profile_id, protocol_version, key_version_ref,
  platform_order_no, channel_order_no, amount_cents::text AS amount_cents, currency, wire_amount_yuan, method, evidence_level,
  state, revision::text AS revision, lease_version::text AS lease_version, lease_owner,
  to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at,
  to_char(updated_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at`;

export type PaymentRequestView = Readonly<{
  requestId: string; orderId: string; channel: PaymentChannel; channelOrderNo: string; amountCents: string; wireAmountYuan: string;
  method: PaymentMethod; state: RequestState; existing: boolean;
  currency: string; evidenceLevel: string; createdAt: string; updatedAt: string;
}>;
const view = (row: RequestRow, existing: boolean): PaymentRequestView => ({
  requestId: row.id, orderId: row.order_id, channel: row.channel, channelOrderNo: row.channel_order_no, amountCents: row.amount_cents,
  wireAmountYuan: row.wire_amount_yuan, method: row.method, state: row.state, existing,
  currency: row.currency, evidenceLevel: row.evidence_level, createdAt: row.created_at, updatedAt: row.updated_at,
});

function checkBinding(binding: ChannelBinding | undefined): asserts binding is ChannelBinding {
  if (!binding || (binding.channel !== "JOINPAY" && binding.channel !== "CONTROLLED")
    || ![binding.merchantIdentityId, binding.configProfileId, binding.keyVersionRef].every((v) => typeof v === "string" && ID.test(v))
    || typeof binding.protocolVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,31}$/.test(binding.protocolVersion)) {
    throw invalid("Invalid channel binding");
  }
}

/**
 * 创建/重放订单唯一支付请求。withIdempotency 每次先核对象授权，再处理原回执/指纹；
 * 不同 key 先恢复同 method 原请求，再检查能力和可付款状态，不能因后续状态变化丢失原意图。
 */
export async function createPaymentRequest(client: PoolClient, input: {
  actor: PaymentActor; orderId: string; idempotencyKey: unknown; method: string; binding?: ChannelBinding; capability?: unknown;
}): Promise<IdempotentResult> {
  return createRequest(client, input, ["SYNTHETIC_PROTOCOL", "CONTROLLED_TEST"], async () => {
    const evidenceLevel = await assertSyntheticChannelRequestCapability(client, input.capability);
    checkBinding(input.binding);
    if ((input.binding.channel === "JOINPAY") !== (evidenceLevel === "SYNTHETIC_PROTOCOL")) throw closed();
    return { binding: input.binding, evidenceLevel };
  });
}

/** 独立候选入口；旧合成行只能读回原件，不能经此入口改名提升。原始wire绑定由同事务调用方保存。 */
export async function createCollectionPaymentRequest(client: PoolClient, input: {
  actor: PaymentActor; orderId: string; idempotencyKey: unknown; method: string; profile?: BoundCollectionProfile;
}): Promise<IdempotentResult> {
  return createRequest(client, input, ["JOINPAY_CANDIDATE"], async () => {
    if (!input.profile) throw closed();
    const profile = describeCollectionProfile(input.profile, "SUBMIT");
    if (profile.evidenceMode !== "OFFICIAL") throw closed();
    const binding: ChannelBinding = { channel: "JOINPAY", merchantIdentityId: profile.merchantIdentityId,
      configProfileId: profile.profileId, protocolVersion: profile.protocolVersion, keyVersionRef: profile.keyVersionRef };
    checkBinding(binding);
    return { binding, evidenceLevel: "JOINPAY_CANDIDATE" };
  });
}

async function createRequest(client: PoolClient, input: {
  actor: PaymentActor; orderId: string; idempotencyKey: unknown; method: string;
}, allowedEvidence: readonly string[], admit: () => Promise<{ binding: ChannelBinding; evidenceLevel: string }>): Promise<IdempotentResult> {
  const key = validateIdempotencyKey(input.idempotencyKey);
  if (!input.actor || !ID.test(input.actor.userId) || !ID.test(input.orderId)) throw invalid();
  if (!(METHODS as readonly string[]).includes(input.method)) throw invalid("Unsupported payment method", "method");
  const { actor, orderId } = input;
  const scope = { realm: "user" as const, principalId: actor.userId, operation: "order.payment.channel-request", resourceId: orderId };
  const fingerprint = fingerprintRequest(scope.operation, orderId, { method: input.method });
  const ownsOrder = async () => {
    const row = (await client.query(`SELECT renter_user_id FROM zzsh_order.rental_order WHERE id=$1`, [orderId])).rows[0];
    if (!row || row.renter_user_id !== actor.userId) throw notFound();
  };
  const result = await withIdempotency(client, scope, key, fingerprint, ownsOrder, async () => {
    await xactLock(client, ["zzsh:payment-request:v1", orderId]);
    const existing = (await client.query<RequestRow>(`SELECT ${REQUEST_COLUMNS} FROM zzsh_order.payment_request WHERE order_id=$1`, [orderId])).rows[0];
    if (existing) {
      if (!allowedEvidence.includes(existing.evidence_level)) throw closed();
      if (existing.method !== input.method) throw requestFailure("PAYMENT_REQUEST_EXISTS", "Payment request already exists for a different method");
      return { status: 200, body: view(existing, true) };
    }
    const { binding, evidenceLevel } = await admit();
    const order = (await client.query(`SELECT renter_user_id, status, display_no, currency,
        (rental_amount_cents+deposit_amount_cents)::text AS total
        FROM zzsh_order.rental_order o WHERE id=$1 FOR UPDATE OF o`, [orderId])).rows[0];
    if (!order || order.renter_user_id !== actor.userId) throw notFound();
    // 与原接纳入口相同：等待行锁之后再取 PG 时钟，不能沿用等待前计算的 hold 判定。
    const timing = (await client.query(`SELECT hold_until > clock_timestamp() AS open,
        EXISTS (SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.order_id=o.id) AS has_confirmation
        FROM zzsh_order.rental_order o WHERE id=$1`, [orderId])).rows[0];
    if (order.status !== "PENDING_PAYMENT" || timing?.open !== true || timing.has_confirmation === true) throw requestFailure("ORDER_NOT_PAYABLE", "Order is not payable");
    if (order.currency !== "CNY") throw invalid("Unsupported payment currency");
    const channelOrderNo = mapChannelOrderNo(binding.channel, order.display_no);
    let wire: string;
    try { wire = wireAmountForCents(order.total); } catch (error) {
      if (error instanceof SecurityApiError && error.code === API_V1_ERROR_CODES.INVALID_ARGUMENT) throw requestFailure("ORDER_NOT_PAYABLE", "Payment amount outside channel protocol range");
      throw error;
    }
    await xactLock(client, ["zzsh:payment-channel-order-no:v1", binding.channel, binding.merchantIdentityId, channelOrderNo]);
    const taken = (await client.query(`SELECT 1 FROM zzsh_order.payment_request WHERE channel=$1 AND merchant_identity_id=$2 AND channel_order_no=$3`,
      [binding.channel, binding.merchantIdentityId, channelOrderNo])).rowCount;
    if (taken) throw conflict("Channel order number collision");
    const id = `payreq_${randomUUID().replaceAll("-", "")}`;
    const row = (await client.query<RequestRow>(`INSERT INTO zzsh_order.payment_request
        (id, order_id, channel, merchant_identity_id, config_profile_id, protocol_version, key_version_ref, platform_order_no,
         channel_order_no, amount_cents, currency, wire_amount_yuan, method, evidence_level, idempotency_scope_key, idempotency_key, request_fingerprint)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'CNY',$11,$12,$13,$14,$15,$16) RETURNING ${REQUEST_COLUMNS}`,
    [id, orderId, binding.channel, binding.merchantIdentityId, binding.configProfileId, binding.protocolVersion, binding.keyVersionRef,
      order.display_no, channelOrderNo, order.total, wire, input.method, evidenceLevel,
      JSON.stringify([scope.realm, scope.principalId, scope.operation, orderId]), key, fingerprint])).rows[0]!;
    return { status: 202, body: view(row, false) };
  });
  if (!result.body || typeof result.body !== "object" || !allowedEvidence.includes((result.body as PaymentRequestView).evidenceLevel)) throw closed();
  return result;
}

// ---------- lease：PG 时钟 + 条件更新 ----------
export type PaymentLease = Readonly<{ requestId: string; leaseVersion: string; leaseOwner: string; channelOrderNo: string; state: RequestState }>;

/** 仅在无有效 lease 且状态可恢复时领取；返回持久原号，绝不重新生成或换号。null 表示未领取。 */
export async function claimPaymentRequestLease(client: PoolClient, input: { requestId: string; owner: string; ttlSeconds: number }): Promise<PaymentLease | null> {
  return claimRequestLease(client, input, ["SYNTHETIC_PROTOCOL", "CONTROLLED_TEST"]);
}

/** 仅供候选执行器在原请求行锁与profile检查后调用；提交前还须保存对应attempt。 */
export async function claimCollectionPaymentRequestLease(client: PoolClient, input: { requestId: string; owner: string; ttlSeconds: number }): Promise<PaymentLease | null> {
  return claimRequestLease(client, input, ["JOINPAY_CANDIDATE"]);
}

async function claimRequestLease(client: PoolClient, input: { requestId: string; owner: string; ttlSeconds: number }, evidence: readonly string[]): Promise<PaymentLease | null> {
  if (!ID.test(input.requestId) || !ID.test(input.owner) || !Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 3600) throw invalid();
  const row = (await client.query(`UPDATE zzsh_order.payment_request
      SET lease_version=lease_version+1, lease_owner=$2, lease_until=clock_timestamp()+make_interval(secs => $3),
          revision=revision+1, updated_at=clock_timestamp()
      WHERE id=$1 AND state = ANY($4::text[]) AND evidence_level = ANY($5::text[]) AND (lease_until IS NULL OR lease_until <= clock_timestamp())
      RETURNING id, lease_version::text AS lease_version, channel_order_no, state`,
  [input.requestId, input.owner, input.ttlSeconds, CLAIMABLE, evidence])).rows[0];
  return row ? { requestId: row.id, leaseVersion: row.lease_version, leaseOwner: input.owner, channelOrderNo: row.channel_order_no, state: row.state } : null;
}

/** 重启恢复：只读持久记录（原号、金额、绑定）；不自动重下单、换号或补失败。 */
export async function readRecoverablePaymentRequest(client: PoolClient, requestId: string): Promise<PaymentRequestView & { binding: ChannelBinding; leaseVersion: string } | null> {
  const row = (await client.query<RequestRow>(`SELECT ${REQUEST_COLUMNS} FROM zzsh_order.payment_request WHERE id=$1`, [requestId])).rows[0];
  if (!row) return null;
  return { ...view(row, true), leaseVersion: row.lease_version, binding: { channel: row.channel, merchantIdentityId: row.merchant_identity_id,
    configProfileId: row.config_profile_id, protocolVersion: row.protocol_version, keyVersionRef: row.key_version_ref } };
}

// ---------- 资金归属锚点 ----------
export type AnchorResult = Readonly<{ anchorId: string; binding: "NEW" | "SAME" | "OWNED_ELSEWHERE"; ownerOrderId: string; confirmationId: string | null }>;

/**
 * 每个资金键一行（channel, merchant_identity_id, channel_trx_no），不含 profile/钥版本/协议/origin。
 * 先取 advisory 锁再 INSERT … ON CONFLICT DO NOTHING：不捕获 23505（PG 失败事务不可继续写），已有归属永不被覆盖。
 */
export async function bindChannelTransaction(client: PoolClient, input: {
  channel: PaymentChannel; merchantIdentityId: string; channelTrxNo: string; orderId: string; requestId: string | null;
  confirmationId: string | null; evidenceLevel: "SYNTHETIC_PROTOCOL" | "CONTROLLED_TEST";
}): Promise<AnchorResult> {
  if (!ID.test(input.merchantIdentityId) || typeof input.channelTrxNo !== "string" || input.channelTrxNo.length < 1 || input.channelTrxNo.length > 128) throw invalid();
  if (input.channel === "JOINPAY") {
    const request = (await client.query(input.requestId === null
      ? `SELECT evidence_level FROM zzsh_order.payment_request WHERE order_id=$1`
      : `SELECT evidence_level FROM zzsh_order.payment_request WHERE id=$1`, [input.requestId ?? input.orderId])).rows[0];
    if (request && request.evidence_level !== "SYNTHETIC_PROTOCOL") throw closed();
  }
  const fundsKey = [input.channel, input.merchantIdentityId, input.channelTrxNo] as const;
  await xactLock(client, ["zzsh:payment-channel-transaction:v1", ...fundsKey]);
  const anchorId = `paytrx_${sha256(JSON.stringify(fundsKey)).slice(0, 32)}`;
  const inserted = (await client.query(`INSERT INTO zzsh_order.payment_channel_transaction
      (id, channel, merchant_identity_id, channel_trx_no, order_origin, native_order_id, request_id, confirmation_id, evidence_level)
      VALUES ($1,$2,$3,$4,'NATIVE',$5,$6,$7,$8) ON CONFLICT (channel, merchant_identity_id, channel_trx_no) DO NOTHING RETURNING id`,
  [anchorId, ...fundsKey, input.orderId, input.requestId, input.confirmationId, input.evidenceLevel])).rows[0];
  if (inserted) return { anchorId, binding: "NEW", ownerOrderId: input.orderId, confirmationId: input.confirmationId };
  const owner = (await client.query(`SELECT id, native_order_id, confirmation_id FROM zzsh_order.payment_channel_transaction
      WHERE channel=$1 AND merchant_identity_id=$2 AND channel_trx_no=$3`, [...fundsKey])).rows[0];
  if (!owner) throw conflict("Channel transaction anchor unavailable");
  return { anchorId: owner.id, binding: owner.native_order_id === input.orderId ? "SAME" : "OWNED_ELSEWHERE",
    ownerOrderId: owner.native_order_id, confirmationId: owner.confirmation_id };
}

/** 只认同事务原件重验的正式品牌；与合成共享稳定资金键，不改旧锚点或补confirmation。 */
export async function bindFormalJoinpayTransaction(client: PoolClient, fact: FormalJoinpayPaymentFact): Promise<AnchorResult> {
  await readVerifiedJoinpayFactScope(client, fact);
  const fundsKey = ["JOINPAY", fact.merchantScopeId, fact.providerTransactionId];
  await xactLock(client, ["zzsh:payment-channel-transaction:v1", ...fundsKey]);
  const inserted = (await client.query(`INSERT INTO zzsh_order.payment_channel_transaction
    (id,channel,merchant_identity_id,channel_trx_no,order_origin,native_order_id,request_id,confirmation_id,evidence_level)
    VALUES($1,'JOINPAY',$2,$3,'NATIVE',$4,$5,NULL,'JOINPAY_VERIFIED') ON CONFLICT(channel,merchant_identity_id,channel_trx_no) DO NOTHING RETURNING id`,
    [fact.anchorId, fact.merchantScopeId, fact.providerTransactionId, fact.orderId, fact.paymentRequestId])).rows[0];
  const owner = inserted ? { id: fact.anchorId, native_order_id: fact.orderId, request_id: fact.paymentRequestId, evidence_level: "JOINPAY_VERIFIED" }
    : (await client.query(`SELECT id,native_order_id,request_id,evidence_level FROM zzsh_order.payment_channel_transaction
      WHERE channel='JOINPAY' AND merchant_identity_id=$1 AND channel_trx_no=$2`, [fact.merchantScopeId, fact.providerTransactionId])).rows[0];
  if (!owner) throw conflict("Formal channel transaction anchor unavailable");
  if (owner.evidence_level !== "JOINPAY_VERIFIED") throw conflict("A synthetic transaction anchor cannot become formal");
  return { anchorId: owner.id, binding: owner.native_order_id === fact.orderId && owner.request_id === fact.paymentRequestId ? inserted ? "NEW" : "SAME" : "OWNED_ELSEWHERE",
    ownerOrderId: owner.native_order_id, confirmationId: null };
}

// ---------- 只追加观察 ----------
type ObservationInput = {
  requestId: string | null; channel: PaymentChannel; merchantIdentityId: string | null; channelOrderNo?: string | null; channelTrxNo?: string | null;
  configProfileId?: string | null; protocolVersion?: string | null; keyVersionRef?: string | null;
  operation: "SYNC_RESPONSE" | "ASYNC_NOTIFY" | "QUERY_RESPONSE" | "ACCEPTANCE"; source: "EXECUTOR" | "PROVIDER_INBOUND" | "ACCEPTANCE_GATE";
  evidenceLevel: "SYNTHETIC_PROTOCOL" | "UNVERIFIED" | "CONTROLLED_TEST"; event: string; result: string; reason?: string | null;
  channelStatus?: string | null; providerPaidAtRaw?: string | null; rawSha256: string; rawRef: string; verifyOutcome?: string | null;
  leaseVersion?: string | null; stateBefore?: RequestState | null; stateAfter?: RequestState | null; stale?: boolean; late?: boolean; conflict?: boolean;
};
const clip = (v: string | null | undefined, n: number) => (v == null ? null : v.length <= n ? v : null);
const token = (v: string | null | undefined) => (v != null && /^[A-Z0-9_-]{1,64}$/.test(v) ? v : null);

async function appendObservation(client: PoolClient, o: ObservationInput): Promise<string> {
  if (typeof o.rawRef !== "string" || o.rawRef.length < 1 || o.rawRef.length > 256) throw invalid("Opaque raw reference required");
  const id = `payobs_${randomUUID().replaceAll("-", "")}`;
  await client.query(`INSERT INTO zzsh_order.payment_channel_observation
      (id, request_id, channel, merchant_identity_id, channel_order_no, channel_trx_no, config_profile_id, protocol_version, key_version_ref,
       operation, source, evidence_level, event, result, reason, channel_status, provider_paid_at_raw, raw_sha256, raw_ref, verify_outcome,
       lease_version, state_before, state_after, stale, late, conflict)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,
  [id, o.requestId, o.channel, o.merchantIdentityId, clip(o.channelOrderNo, 128), clip(o.channelTrxNo, 128), o.configProfileId ?? null,
    o.protocolVersion ?? null, o.keyVersionRef ?? null, o.operation, o.source, o.evidenceLevel, o.event, o.result, token(o.reason),
    clip(o.channelStatus, 32), clip(o.providerPaidAtRaw, 64), o.rawSha256, o.rawRef, clip(o.verifyOutcome, 64), o.leaseVersion ?? null,
    o.stateBefore ?? null, o.stateAfter ?? null, o.stale === true, o.late === true, o.conflict === true]);
  return id;
}

async function writeState(client: PoolClient, row: RequestRow, next: RequestState, leaseVersion?: string): Promise<void> {
  const updated = await client.query(`UPDATE zzsh_order.payment_request SET state=$2, revision=revision+1, updated_at=clock_timestamp()
      WHERE id=$1 AND state=$3 AND revision=$4::bigint
        AND ($5::bigint IS NULL OR (lease_version=$5::bigint AND lease_until > clock_timestamp()))`,
  [row.id, next, row.state, row.revision, leaseVersion ?? null]);
  // 行锁已持有，0 行意味着并发不变式被破坏：抛给事务所有者回滚，不静默覆盖
  if (updated.rowCount !== 1) throw conflict("Payment request changed concurrently");
}

const lockRequest = async (client: PoolClient, sql: string, params: unknown[]) =>
  (await client.query<RequestRow & { lease_current?: boolean }>(sql, params)).rows[0];

export type ChannelObservationResult = Readonly<{
  observationId: string; outcome: JoinpayOutcome; stateBefore: RequestState | "NONE"; stateAfter: RequestState | "NONE";
  anchor: AnchorResult | null; formalAcceptance: false;
}>;

/** 合成判定落库：仅 E4 时登记资金锚点；锚点属他单则不迁移、追加冲突观察。终态只追加迟到/冲突观察。 */
async function persistOutcome(client: PoolClient, row: RequestRow | null, outcome: JoinpayOutcome, meta: {
  operation: ObservationInput["operation"]; source: ObservationInput["source"]; rawSha256: string; rawRef: string; leaseVersion?: string;
  merchantIdentityId: string | null;
}): Promise<ChannelObservationResult> {
  const values = outcome.values ?? {};
  const trx = values.r7_TrxNo ?? values.r5_TrxNo ?? null;
  let next: RequestState | "NONE" = row ? outcome.nextState : "NONE";
  let result = outcome.result;
  let conflictFlag = outcome.conflict;
  let anchor: AnchorResult | null = null;
  if (row && outcome.event === "E4" && trx && !TERMINAL.includes(row.state)) {
    anchor = await bindChannelTransaction(client, { channel: "JOINPAY", merchantIdentityId: row.merchant_identity_id, channelTrxNo: trx,
      orderId: row.order_id, requestId: row.id, confirmationId: null, evidenceLevel: "SYNTHETIC_PROTOCOL" });
    if (anchor.binding === "OWNED_ELSEWHERE") { next = row.state; result = "TRANSACTION_OWNED_ELSEWHERE"; conflictFlag = true; }
  }
  if (row && next !== "NONE" && next !== row.state) await writeState(client, row, next, meta.leaseVersion);
  const trusted = outcome.observation === "SYNTHETIC_SIGNED";
  const observationId = await appendObservation(client, {
    requestId: row?.id ?? null, channel: "JOINPAY", merchantIdentityId: meta.merchantIdentityId, channelOrderNo: values.r2_OrderNo ?? row?.channel_order_no ?? null,
    channelTrxNo: trx, configProfileId: row?.config_profile_id, protocolVersion: row?.protocol_version, keyVersionRef: row?.key_version_ref,
    operation: meta.operation, source: meta.source, evidenceLevel: trusted ? "SYNTHETIC_PROTOCOL" : "UNVERIFIED", event: outcome.event, result,
    reason: outcome.reason ?? null, channelStatus: outcome.rawStatus ?? values.r6_Status ?? values.ra_Status ?? values.ra_Code ?? null,
    providerPaidAtRaw: outcome.providerPaidAtRaw ?? null, rawSha256: meta.rawSha256, rawRef: meta.rawRef, verifyOutcome: outcome.signature,
    leaseVersion: meta.leaseVersion ?? null, stateBefore: row?.state ?? null, stateAfter: row ? (next as RequestState) : null,
    stale: outcome.event === "E9", late: !!row && TERMINAL.includes(row.state) && trusted, conflict: conflictFlag,
  });
  return { observationId, outcome, stateBefore: row?.state ?? "NONE", stateAfter: next, anchor, formalAcceptance: false };
}

const persisted = (row: RequestRow, merchantNo: string): JoinpayPersistedRequest =>
  ({ state: row.state, merchantNo, orderNo: row.channel_order_no, amountCents: row.amount_cents, frpCode: row.method });

type ExecutorIdentity = { requestId: string; leaseVersion: string; leaseOwner: string };
async function lockExecutorRequest(client: PoolClient, input: ExecutorIdentity): Promise<{ row: RequestRow; current: boolean }> {
  if (!ID.test(input.requestId) || !/^[1-9]\d{0,18}$/.test(input.leaseVersion) || !ID.test(input.leaseOwner)) throw invalid();
  const row = await lockRequest(client, `SELECT ${REQUEST_COLUMNS} FROM zzsh_order.payment_request WHERE id=$1 FOR UPDATE`, [input.requestId]);
  if (!row) throw notFound();
  if (row.channel !== "JOINPAY" || row.evidence_level !== "SYNTHETIC_PROTOCOL") throw invalid("Executor results are JOINPAY synthetic observations only");
  // 行锁可能等待到租约过期，必须在取得锁之后另取 PG 时钟。
  const current = (await client.query(`SELECT (lease_version=$2::bigint AND lease_owner=$3 AND lease_until > clock_timestamp()) AS lease_current
      FROM zzsh_order.payment_request WHERE id=$1`, [input.requestId, input.leaseVersion, input.leaseOwner])).rows[0]?.lease_current === true;
  return { row, current };
}

/** 传输失败不读取钥、不伪装为坏 JSON；事务失败交调用方保留未知并按原请求恢复。 */
export async function recordExecutorFailure(client: PoolClient, input: ExecutorIdentity & {
  operation: "SYNC_RESPONSE" | "QUERY_RESPONSE"; reason: JoinpayTransportFailure; rawRef: string;
}): Promise<ChannelObservationResult> {
  const { row, current } = await lockExecutorRequest(client, input);
  const outcome = evaluateJoinpayTransportFailure(input.operation, row.state, current, input.reason);
  return persistOutcome(client, row, outcome, { operation: input.operation, source: "EXECUTOR",
    rawSha256: sha256(JSON.stringify({ operation: input.operation, transportFailure: input.reason })), rawRef: input.rawRef,
    leaseVersion: input.leaseVersion, merchantIdentityId: row.merchant_identity_id });
}

/**
 * 执行者带回的同步响应/查单结果。必须比较当前 lease（版本、持有者、PG 时钟有效期）；
 * 旧 lease 只追加 STALE（E9），不改请求状态、不覆盖新 lease 或原付款。
 * keyFor 按持久 key_version_ref 解析测试钥；钥值不落库、不输出。
 */
export async function recordExecutorResult(client: PoolClient, input: {
  requestId: string; leaseVersion: string; leaseOwner: string; operation: "SYNC_RESPONSE" | "QUERY_RESPONSE"; body: string | Uint8Array; rawRef: string;
  merchantNo: string; keyFor: (keyVersionRef: string) => string;
}): Promise<ChannelObservationResult> {
  const { row, current } = await lockExecutorRequest(client, input);
  // E9 在协议入口优先返回，无需读取已退役或不可用的旧版本钥。
  const ctx = { key: current ? input.keyFor(row.key_version_ref) : "", request: persisted(row, input.merchantNo), leaseCurrent: current };
  const outcome = input.operation === "SYNC_RESPONSE" ? evaluateJoinpaySyncResponse(input.body, ctx) : evaluateJoinpayQueryResponse(input.body, ctx);
  return persistOutcome(client, row, outcome, { operation: input.operation, source: "EXECUTOR", rawSha256: sha256(input.body), rawRef: input.rawRef,
    leaseVersion: input.leaseVersion, merchantIdentityId: row.merchant_identity_id });
}

/**
 * GET 异步通知：不要求 lease，旧 lease 判断不适用。绑定不到时 request_id=null 留无主观察。
 * 本包不回 HTTP success；ACK 是否发出留 PAY-04（outcome.ack 仅为判定）。
 */
export async function recordJoinpayNotify(client: PoolClient, input: {
  rawQuery: string; rawRef: string; resolveMerchant: (merchantNo: string) => string | null; keyFor: (keyVersionRef: string) => string;
}): Promise<ChannelObservationResult> {
  const decoded = decodeJoinpayQuery(input.rawQuery);
  const merchantNo = decoded.ok ? decoded.raw.get("r1_MerchantNo")?.value ?? null : null;
  const orderNo = decoded.ok ? decoded.raw.get("r2_OrderNo")?.value ?? null : null;
  const identity = merchantNo ? input.resolveMerchant(merchantNo) : null;
  const row = identity && orderNo ? await lockRequest(client, `SELECT ${REQUEST_COLUMNS} FROM zzsh_order.payment_request
      WHERE channel='JOINPAY' AND merchant_identity_id=$1 AND channel_order_no=$2 FOR UPDATE`, [identity, orderNo]) ?? null : null;
  if (row && row.evidence_level !== "SYNTHETIC_PROTOCOL") throw closed();
  // 无绑定时协议层在验签前即返回 BINDING_NOT_FOUND，不使用钥
  const outcome = row && merchantNo
    ? evaluateJoinpayNotify(input.rawQuery, { key: input.keyFor(row.key_version_ref), request: persisted(row, merchantNo) })
    : evaluateJoinpayNotify(input.rawQuery, { key: "UNBOUND", request: null });
  return persistOutcome(client, row, outcome, { operation: "ASYNC_NOTIFY", source: "PROVIDER_INBOUND", rawSha256: sha256(input.rawQuery),
    rawRef: input.rawRef, merchantIdentityId: identity && ID.test(identity) ? identity : null });
}

// ---------- 受控接纳：只走原 confirmOrderPayment ----------
type VerifiedFact = Parameters<typeof confirmOrderPayment>[1];
export type ControlledAcceptance = Readonly<{ payment: PaymentResult; anchor: AnchorResult | null; requestState: RequestState | null }>;

/**
 * 仅接受 createControlledPaymentSource 真实生成的 capability，且必须带完整 createPaymentDistributionStore；
 * 缺分佣准入不降级为无 distribution 的成功。新关系、confirmation、PAID/WAITING、basis 与审计同事务，失败抛给事务所有者。
 */
export async function acceptControlledPayment(client: PoolClient, input: { fact: VerifiedFact; distribution: PaymentDistributionStore; requestId?: string }): Promise<ControlledAcceptance> {
  const { fact, distribution } = input;
  if (!distribution || typeof distribution.prepare !== "function" || typeof distribution.record !== "function" || typeof distribution.readOriginal !== "function") {
    throw new SecurityApiError(503, API_V1_ERROR_CODES.EVIDENCE_UNAVAILABLE, "Explicit distribution payment admission unavailable");
  }
  let row: RequestRow | undefined;
  if (input.requestId !== undefined) {
    row = await lockRequest(client, `SELECT ${REQUEST_COLUMNS} FROM zzsh_order.payment_request WHERE id=$1 FOR UPDATE`, [input.requestId]);
    if (!row) throw notFound();
    if (row.channel !== "CONTROLLED" || row.order_id !== fact.orderId || row.merchant_identity_id !== fact.merchantScopeId
      || row.channel_order_no !== fact.merchantOrderNo || row.amount_cents !== fact.amountCents || row.currency !== fact.currency) {
      throw conflict("Controlled fact does not match the persisted payment request");
    }
  }
  await xactLock(client, ["zzsh:payment-channel-transaction:v1", "CONTROLLED", fact.merchantScopeId, fact.providerTransactionId]);
  const payment = await confirmOrderPayment(client, fact, distribution);
  const raw = sha256(JSON.stringify([fact.source, fact.merchantScopeId, fact.providerTransactionId, fact.orderId, fact.amountCents]));
  const observe = (event: string, result: string, before: RequestState, after: RequestState, flags: { late?: boolean; conflict?: boolean }) =>
    appendObservation(client, { requestId: row!.id, channel: "CONTROLLED", merchantIdentityId: row!.merchant_identity_id, channelOrderNo: row!.channel_order_no,
      channelTrxNo: fact.providerTransactionId, configProfileId: row!.config_profile_id, protocolVersion: row!.protocol_version, keyVersionRef: row!.key_version_ref,
      operation: "ACCEPTANCE", source: "ACCEPTANCE_GATE", evidenceLevel: "CONTROLLED_TEST", event, result, reason: payment.reasonCode,
      rawSha256: raw, rawRef: `controlled-fact:${fact.requestId}`, stateBefore: before, stateAfter: after, ...flags });
  if (payment.disposition === "CONFLICT") {
    if (row) await observe("E8", "TRANSACTION_BINDING_CONFLICT", row.state, row.state, { conflict: true });
    return { payment, anchor: null, requestState: row?.state ?? null };
  }
  const anchor = await bindChannelTransaction(client, { channel: "CONTROLLED", merchantIdentityId: fact.merchantScopeId, channelTrxNo: fact.providerTransactionId,
    orderId: fact.orderId, requestId: row?.id ?? null, confirmationId: payment.confirmationId, evidenceLevel: "CONTROLLED_TEST" });
  // 0036 已对 (source, scope, trx) 唯一；锚点与之不一致说明归属被篡改，整笔回滚
  if (anchor.binding === "OWNED_ELSEWHERE" || anchor.confirmationId !== payment.confirmationId) throw conflict("Channel transaction anchor differs from confirmation");
  if (!row || (payment.replay && TERMINAL.includes(row.state))) return { payment, anchor, requestState: row?.state ?? null };
  // 原付款可能经旧受控入口接纳；重放只修复尚未终结的请求，不重复接纳或冻结分佣。
  // 受控事实视为测试内可信渠道成功（E4），随后按 disposition 走 E7/E8；终态只追加迟到观察
  const afterE4 = joinpayTransition("E4", row.state).nextState;
  const next: RequestState = afterE4 === CSPA ? (payment.disposition === "APPLIED" ? "ACCEPTED" : "REVIEW_REQUIRED") : afterE4;
  if (next !== row.state) await writeState(client, row, next);
  await observe(payment.disposition === "APPLIED" ? "E7" : "E8", payment.disposition, row.state, next,
    { late: TERMINAL.includes(row.state), conflict: TERMINAL.includes(row.state) || row.state === "REJECTED_BY_CHANNEL" });
  return { payment, anchor, requestState: next };
}
