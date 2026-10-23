import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import { API_V1_ERROR_CODES, validateIdempotencyKey } from "../contracts/api-v1";
import { conflict, fingerprintRequest, invalid, notFound } from "../supply/supply-util";
import { assertSyntheticChannelRequestCapability, wireAmountForCents } from "./channel-payment-store";

/** 同一显式事务内占用已过账应退额度；无外呼、无退款终态、无资金释放，不开启独立事务。 */
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export type RefundIntentState = "READY" | "SUBMITTING" | "UNKNOWN";
type RefundRow = {
  id: string; posting_id: string; order_id: string; payment_confirmation_id: string; renter_user_id: string;
  payment_source: "CONTROLLED"; merchant_identity_id: string; original_payment_trx_no: string; original_payment_order_no: string;
  responsibility_version_hash: string; refund_order_no: string; amount_cents: string; currency: "CNY";
  idempotency_key: string; request_fingerprint: string; state: RefundIntentState; revision: string;
  lease_version: string; lease_owner: string | null; due_at: string;
};
const COLUMNS = `id, posting_id, order_id, payment_confirmation_id, renter_user_id, payment_source, merchant_identity_id,
  original_payment_trx_no, original_payment_order_no, responsibility_version_hash, refund_order_no,
  amount_cents::text AS amount_cents, currency, idempotency_key, request_fingerprint, state,
  revision::text AS revision, lease_version::text AS lease_version, lease_owner,
  to_char(due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS due_at`;

export type RefundIntent = Readonly<{
  intentId: string; postingId: string; orderId: string; paymentConfirmationId: string; renterUserId: string;
  originalPayment: { source: "CONTROLLED"; merchantIdentityId: string; transactionNo: string; orderNo: string };
  responsibilityVersionHash: string; refundOrderNo: string; amountCents: string; currency: "CNY"; dueAt: string;
  state: RefundIntentState; revision: string; leaseVersion: string; evidenceLevel: "CONTROLLED_TEST";
  budgetDisposition: "ALLOCATED"; formalRefund: false; sendable: false;
}>;
const view = (r: RefundRow): RefundIntent => ({
  intentId: r.id, postingId: r.posting_id, orderId: r.order_id, paymentConfirmationId: r.payment_confirmation_id,
  renterUserId: r.renter_user_id, originalPayment: { source: r.payment_source, merchantIdentityId: r.merchant_identity_id,
    transactionNo: r.original_payment_trx_no, orderNo: r.original_payment_order_no }, responsibilityVersionHash: r.responsibility_version_hash,
  refundOrderNo: r.refund_order_no, amountCents: r.amount_cents, currency: r.currency, dueAt: r.due_at, state: r.state,
  revision: r.revision, leaseVersion: r.lease_version, evidenceLevel: "CONTROLLED_TEST", budgetDisposition: "ALLOCATED",
  formalRefund: false, sendable: false,
});

async function admitted(client: PoolClient, capability: unknown): Promise<void> {
  if (await assertSyntheticChannelRequestCapability(client, capability) !== "CONTROLLED_TEST") {
    throw new SecurityApiError(503, API_V1_ERROR_CODES.EVIDENCE_UNAVAILABLE, "Controlled refund admission unavailable");
  }
  const row = (await client.query(`SELECT current_setting('transaction_isolation') AS isolation`)).rows[0];
  if (row?.isolation !== "read committed") throw conflict("Refund allocation requires READ COMMITTED");
}
const validId = (value: unknown): value is string => typeof value === "string" && ID.test(value);
const freshId = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
async function audit(client: PoolClient, id: string, action: string, requestId: string, details: Record<string, unknown>) {
  await recordAudit(client, { actorType: "system", action, objectType: "channel_refund_intent", objectId: id,
    outcome: "SUCCESS", requestId, details: { evidenceLevel: "CONTROLLED_TEST", formalRefund: false, ...details } });
}

/** 原责任只从已冻结 posting 和 APPLIED 付款读取；不接客户端退款对象或重算当前会员价格。 */
export async function createNativeRefundIntent(client: PoolClient, input: {
  postingId: string; amountCents: string; idempotencyKey: unknown; requestId: string; capability: unknown;
}): Promise<{ replayed: boolean; intent: RefundIntent }> {
  const key = validateIdempotencyKey(input.idempotencyKey);
  if (!validId(input.postingId) || !validId(input.requestId)) throw invalid();
  wireAmountForCents(input.amountCents);
  await admitted(client, input.capability);
  const basis = (await client.query<{
    order_id: string; payment_confirmation_id: string; renter_user_id: string; version_hash: string; due_at: string;
    source: string; merchant_scope_id: string; provider_transaction_id: string; merchant_order_no: string;
    paid_cents: string; responsibility_cents: string; currency: string;
  }>(`SELECT p.order_id, p.payment_confirmation_id, o.renter_user_id, p.version_hash, p.refund_due_at::text AS due_at,
      c.source, c.merchant_scope_id, c.provider_transaction_id, c.merchant_order_no,
      c.amount_cents::text AS paid_cents, p.renter_refund_cents::text AS responsibility_cents, c.currency
    FROM zzsh_order.settlement_posting p JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id
    JOIN zzsh_order.rental_order o ON o.id=p.order_id AND o.paid_confirmation_id=c.id
    WHERE p.id=$1 AND c.order_id=o.id AND c.disposition='APPLIED' AND o.status='COMPLETED'
      AND p.currency=c.currency AND p.captured_cents=c.amount_cents`, [input.postingId])).rows[0];
  if (!basis) throw notFound();
  if (basis.source !== "CONTROLLED" || basis.currency !== "CNY") {
    throw new SecurityApiError(503, API_V1_ERROR_CODES.EVIDENCE_UNAVAILABLE, "Refund payment source unavailable");
  }
  // 与 SQL 守卫使用同一 jsonb 锁键；等待之后用新语句读取总额，不能在旧快照内先算后锁。
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
      'zzsh:refund-funds:v1',$1::text,$2::text,$3::text)::text,0))`,
    [basis.source, basis.merchant_scope_id, basis.provider_transaction_id]);
  const fingerprint = fingerprintRequest("rental.refund.intent", input.postingId, { amountCents: input.amountCents });
  const original = (await client.query<RefundRow>(`SELECT ${COLUMNS} FROM zzsh_order.channel_refund_intent
    WHERE posting_id=$1 AND idempotency_key=$2`, [input.postingId, key])).rows[0];
  if (original) {
    if (original.request_fingerprint !== fingerprint) {
      throw new SecurityApiError(409, API_V1_ERROR_CODES.IDEMPOTENCY_KEY_REUSED, "Refund key reused with different amount");
    }
    return { replayed: true, intent: view(original) };
  }
  const totals = (await client.query<{ paid_allocated: string; responsibility_allocated: string }>(
    `SELECT COALESCE(sum(amount_cents),0)::text AS paid_allocated,
      COALESCE(sum(amount_cents) FILTER (WHERE posting_id=$4),0)::text AS responsibility_allocated
    FROM zzsh_order.channel_refund_intent WHERE payment_source=$1 AND merchant_identity_id=$2 AND original_payment_trx_no=$3`,
    [basis.source, basis.merchant_scope_id, basis.provider_transaction_id, input.postingId])).rows[0]!;
  if (BigInt(totals.paid_allocated) + BigInt(input.amountCents) > BigInt(basis.paid_cents)
    || BigInt(totals.responsibility_allocated) + BigInt(input.amountCents) > BigInt(basis.responsibility_cents)) {
    throw conflict("Refund allocation exceeds original payment or frozen responsibility");
  }
  const refundNo = `RF${fingerprintRequest("channel.refund.number.v1", input.postingId,
    [basis.source, basis.merchant_scope_id, basis.provider_transaction_id, key]).slice(0, 28)}`;
  const row = (await client.query<RefundRow>(`INSERT INTO zzsh_order.channel_refund_intent
    (id,posting_id,order_id,payment_confirmation_id,renter_user_id,payment_source,merchant_identity_id,
     original_payment_trx_no,original_payment_order_no,responsibility_version_hash,refund_order_no,
     amount_cents,currency,idempotency_key,request_fingerprint,due_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'CNY',$13,$14,$15) RETURNING ${COLUMNS}`,
    [freshId("refund"), input.postingId, basis.order_id, basis.payment_confirmation_id, basis.renter_user_id, basis.source,
      basis.merchant_scope_id, basis.provider_transaction_id, basis.merchant_order_no, basis.version_hash, refundNo,
      input.amountCents, key, fingerprint, basis.due_at])).rows[0]!;
  await audit(client, row.id, "order.refund.intent.allocated", input.requestId, { postingId: row.posting_id, amountCents: row.amount_cents });
  return { replayed: false, intent: view(row) };
}

export type RefundLease = Readonly<{ intent: RefundIntent; owner: string; version: string; operation: "SUBMIT" | "QUERY" }>;
/** 领取事务提交成功后方可执行；首次领取之后一律按原退款号查，不因重启或超时再生成退款。 */
export async function claimRefundIntent(client: PoolClient, input: {
  intentId: string; owner: string; ttlSeconds: number; requestId: string; capability: unknown;
}): Promise<RefundLease | null> {
  if (!validId(input.intentId) || !validId(input.owner) || !validId(input.requestId)
    || !Number.isSafeInteger(input.ttlSeconds) || input.ttlSeconds < 1 || input.ttlSeconds > 3600) throw invalid();
  await admitted(client, input.capability);
  const row = (await client.query<RefundRow>(`SELECT ${COLUMNS} FROM zzsh_order.channel_refund_intent WHERE id=$1 FOR UPDATE`, [input.intentId])).rows[0];
  if (!row) throw notFound();
  const next = (await client.query<RefundRow>(`UPDATE zzsh_order.channel_refund_intent SET
      state=CASE WHEN state='READY' THEN 'SUBMITTING' ELSE 'UNKNOWN' END,
      lease_version=lease_version+1,lease_owner=$2,lease_until=clock_timestamp()+make_interval(secs=>$3),revision=revision+1
    WHERE id=$1 AND state IN ('READY','SUBMITTING','UNKNOWN') AND due_at<=clock_timestamp()
      AND (lease_until IS NULL OR lease_until<=clock_timestamp()) RETURNING ${COLUMNS}`,
    [row.id, input.owner, input.ttlSeconds])).rows[0];
  if (!next) return null;
  const operation = row.state === "READY" ? "SUBMIT" : "QUERY";
  await audit(client, row.id, "order.refund.lease.claimed", input.requestId, { operation, leaseVersion: next.lease_version });
  return { intent: view(next), owner: input.owner, version: next.lease_version, operation };
}

/** 内部恢复 reader，无状态推进；对象授权与对外字段裁剪由后续路由负责，本包不提供 HTTP。 */
export async function readRecoverableRefundIntent(client: PoolClient, intentId: string, capability: unknown): Promise<RefundIntent | null> {
  if (!validId(intentId)) throw invalid();
  await admitted(client, capability);
  const row = (await client.query<RefundRow>(`SELECT ${COLUMNS} FROM zzsh_order.channel_refund_intent WHERE id=$1`, [intentId])).rows[0];
  return row ? view(row) : null;
}

export type RefundTransportFailure = "TIMEOUT" | "HTTP_NON_200" | "CONNECTION_LOST" | "RESPONSE_TRUNCATED" | "LOCAL_FAILURE";
/** 传输失败仅保留 UNKNOWN；过期执行者只能追加 STALE，所有意图仍占用累计额度。 */
export async function recordRefundTransportFailure(client: PoolClient, input: {
  intentId: string; owner: string; version: string; reason: RefundTransportFailure; requestId: string; capability: unknown;
}): Promise<{ event: "UNKNOWN" | "STALE"; intent: RefundIntent; formalRefund: false }> {
  if (!validId(input.intentId) || !validId(input.owner) || !validId(input.requestId) || typeof input.version !== "string"
    || !/^[1-9]\d{0,18}$/.test(input.version) || BigInt(input.version) > 9223372036854775807n
    || !["TIMEOUT", "HTTP_NON_200", "CONNECTION_LOST", "RESPONSE_TRUNCATED", "LOCAL_FAILURE"].includes(input.reason)) throw invalid();
  await admitted(client, input.capability);
  const row = (await client.query<RefundRow>(`SELECT ${COLUMNS} FROM zzsh_order.channel_refund_intent WHERE id=$1 FOR UPDATE`, [input.intentId])).rows[0];
  if (!row) throw notFound();
  // 取得行锁后另发 UPDATE，以此时 PG 时钟检查租约，等待期间过期也只能记 STALE。
  const changed = (await client.query<RefundRow>(`UPDATE zzsh_order.channel_refund_intent SET state='UNKNOWN',revision=revision+1
    WHERE id=$1 AND state IN ('SUBMITTING','UNKNOWN') AND lease_version=$2::bigint AND lease_owner=$3
      AND lease_until>clock_timestamp() RETURNING ${COLUMNS}`, [row.id, input.version, input.owner])).rows[0];
  const event = changed ? "UNKNOWN" : "STALE";
  await client.query(`INSERT INTO zzsh_order.channel_refund_observation
    (id,intent_id,event,failure_reason,lease_version,lease_owner,state_before,state_after,request_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [freshId("refundobs"), row.id, event, input.reason, input.version, input.owner, row.state, changed?.state ?? row.state, input.requestId]);
  await audit(client, row.id, "order.refund.transport.observed", input.requestId, { event, reason: input.reason, leaseVersion: input.version });
  return { event, intent: view(changed ?? row), formalRefund: false };
}
