import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import { API_V1_ERROR_CODES, validateIdempotencyKey } from "../contracts/api-v1";
import { conflict, fingerprintRequest, invalid, notFound } from "../supply/supply-util";
import { assertSyntheticChannelRequestCapability, wireAmountForCents } from "./channel-payment-store";
import { readFormalRefundAdmission, describeRefundProfile, assertFormalRefundProfile, assertRefundStart, assertInitialRefundAdmission, assertRefundBinding,
  type BoundRefundProfile, type FormalRefundAdmission, type RefundBinding } from "./joinpay-refund-profile";

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

type RefundBasis = {order_id:string;payment_confirmation_id:string;renter_user_id:string;version_hash:string;due_at:string;source:string;merchant_scope_id:string;provider_transaction_id:string;merchant_order_no:string;paid_cents:string;responsibility_cents:string;currency:string};
async function readRefundBasis(client:PoolClient,postingId:string):Promise<RefundBasis|undefined>{
  return (await client.query<{
    order_id: string; payment_confirmation_id: string; renter_user_id: string; version_hash: string; due_at: string;
    source: string; merchant_scope_id: string; provider_transaction_id: string; merchant_order_no: string;
    paid_cents: string; responsibility_cents: string; currency: string;
  }>(`SELECT p.order_id, p.payment_confirmation_id, o.renter_user_id, p.version_hash, p.refund_due_at::text AS due_at,
      c.source, c.merchant_scope_id, c.provider_transaction_id, c.merchant_order_no,
      c.amount_cents::text AS paid_cents, p.renter_refund_cents::text AS responsibility_cents, c.currency
    FROM zzsh_order.settlement_posting p JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id
    JOIN zzsh_order.rental_order o ON o.id=p.order_id AND o.paid_confirmation_id=c.id
    WHERE p.id=$1 AND c.order_id=o.id AND c.disposition='APPLIED' AND o.status='COMPLETED'
      AND p.currency=c.currency AND p.captured_cents=c.amount_cents`, [postingId])).rows[0];

}
export async function lockRefundFunds(client:PoolClient,source:string,merchantIdentityId:string,trx:string){
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
      'zzsh:refund-funds:v1',$1::text,$2::text,$3::text)::text,0))`,
    [source,merchantIdentityId,trx]);

}
async function assertRefundBudget(client:PoolClient,basis:RefundBasis,postingId:string,amountCents:string){
  const totals = (await client.query<{ paid_allocated: string; responsibility_allocated: string }>(
    `SELECT COALESCE(sum(amount_cents),0)::text AS paid_allocated,
      COALESCE(sum(amount_cents) FILTER (WHERE posting_id=$4),0)::text AS responsibility_allocated
    FROM zzsh_order.channel_refund_intent i WHERE payment_source=$1 AND merchant_identity_id=$2 AND original_payment_trx_no=$3 AND COALESCE(to_jsonb(i)->>'budget_disposition','ALLOCATED')<>'RELEASED'`,
    [basis.source, basis.merchant_scope_id, basis.provider_transaction_id, postingId])).rows[0]!;
  if (BigInt(totals.paid_allocated) + BigInt(amountCents) > BigInt(basis.paid_cents)
    || BigInt(totals.responsibility_allocated) + BigInt(amountCents) > BigInt(basis.responsibility_cents)) {
    throw conflict("Refund allocation exceeds original payment or frozen responsibility");
  }

}
function refundNumber(basis:RefundBasis,postingId:string,key:string){
  return `RF${fingerprintRequest("channel.refund.number.v1", postingId,
    [basis.source, basis.merchant_scope_id, basis.provider_transaction_id, key]).slice(0, 28)}`;

}

/** 原责任只从已冻结 posting 和 APPLIED 付款读取；不接客户端退款对象或重算当前会员价格。 */
export async function createNativeRefundIntent(client: PoolClient, input: {
  postingId: string; amountCents: string; idempotencyKey: unknown; requestId: string; capability: unknown;
}): Promise<{ replayed: boolean; intent: RefundIntent }> {
  const key = validateIdempotencyKey(input.idempotencyKey);
  if (!validId(input.postingId) || !validId(input.requestId)) throw invalid();
  wireAmountForCents(input.amountCents);
  await admitted(client, input.capability);
  const basis = await readRefundBasis(client,input.postingId);
  if (!basis) throw notFound();
  if (basis.source !== "CONTROLLED" || basis.currency !== "CNY") {
    throw new SecurityApiError(503, API_V1_ERROR_CODES.EVIDENCE_UNAVAILABLE, "Refund payment source unavailable");
  }
  // 与 SQL 守卫使用同一 jsonb 锁键；等待之后用新语句读取总额，不能在旧快照内先算后锁。
  await lockRefundFunds(client,basis.source,basis.merchant_scope_id,basis.provider_transaction_id);
  const fingerprint = fingerprintRequest("rental.refund.intent", input.postingId, { amountCents: input.amountCents });
  const original = (await client.query<RefundRow>(`SELECT ${COLUMNS} FROM zzsh_order.channel_refund_intent
    WHERE posting_id=$1 AND idempotency_key=$2`, [input.postingId, key])).rows[0];
  if (original) {
    if (original.payment_source!=="CONTROLLED") throw notFound();
    if (original.request_fingerprint !== fingerprint) {
      throw new SecurityApiError(409, API_V1_ERROR_CODES.IDEMPOTENCY_KEY_REUSED, "Refund key reused with different amount");
    }
    return { replayed: true, intent: view(original) };
  }
  await assertRefundBudget(client,basis,input.postingId,input.amountCents);
  const refundNo = refundNumber(basis,input.postingId,key);
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
  const row = (await client.query<RefundRow>(`SELECT ${COLUMNS} FROM zzsh_order.channel_refund_intent WHERE id=$1 AND payment_source='CONTROLLED' FOR UPDATE`, [input.intentId])).rows[0];
  if (!row || row.payment_source!=="CONTROLLED") throw notFound();
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
  const row = (await client.query<RefundRow>(`SELECT ${COLUMNS} FROM zzsh_order.channel_refund_intent WHERE id=$1 AND payment_source='CONTROLLED'`, [intentId])).rows[0];
  return row?.payment_source==="CONTROLLED" ? view(row) : null;
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
  const row = (await client.query<RefundRow>(`SELECT ${COLUMNS} FROM zzsh_order.channel_refund_intent WHERE id=$1 AND payment_source='CONTROLLED' FOR UPDATE`, [input.intentId])).rows[0];
  if (!row || row.payment_source!=="CONTROLLED") throw notFound();
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

export type NativeRefundState = RefundIntentState | "PROCESSING" | "REVIEW_REQUIRED" | "SUCCEEDED" | "FAILED";
export type FormalRefundRow = Omit<RefundRow, "payment_source" | "state"> & {
  payment_source: "JOINPAY"; state: NativeRefundState; evidence_level: string; budget_disposition: "ALLOCATED" | "CONSUMED" | "RELEASED";
  initial_admission_ref: string; initial_admission_sha256: string; initial_admission_canonical: string; wire_merchant_no: string;
  initial_profile_id: string; initial_profile_sha256: string; initial_key_version_ref: string; notify_url: string;
  funds_account: "SETTLED" | "ADVANCE" | null; refund_reason: string | null; terminal_evidence_id: string | null;
  terminal_root_id: string | null; terminal_event_id: string | null; provider_refund_trx_no: string | null; completed_at: string | null; requires_review: boolean;
};
export const FORMAL_REFUND_COLUMNS = `${COLUMNS},evidence_level,budget_disposition,initial_admission_ref,initial_admission_sha256,initial_admission_canonical,
 wire_merchant_no,initial_profile_id,initial_profile_sha256,initial_key_version_ref,notify_url,funds_account,refund_reason,
 terminal_evidence_id,terminal_root_id,terminal_event_id,provider_refund_trx_no,completed_at::text,requires_review`;
export async function assertRefundResource(client: PoolClient, admission: FormalRefundAdmission): Promise<string> {
  const a = readFormalRefundAdmission(admission), r = (await client.query(`SELECT current_database() AS db,current_user AS actor,pg_current_xact_id()::text AS xid,
    current_setting('transaction_isolation') AS isolation`)).rows[0];
  if (r?.db !== a.database || r?.actor !== a.runtimeUser || r?.isolation !== "read committed" || !/^[1-9][0-9]*$/.test(r?.xid ?? "")) throw conflict("Native refund resource or transaction differs"); return r.xid;
}
export function formalRefundBinding(r: FormalRefundRow, admission: FormalRefundAdmission): RefundBinding {
  const a = readFormalRefundAdmission(admission);
  if (r.payment_source !== "JOINPAY" || r.evidence_level !== "JOINPAY_FORMAL" || r.currency !== "CNY" || r.merchant_identity_id !== a.merchantIdentityId
    || r.wire_merchant_no !== a.merchantNo || !r.initial_admission_canonical || createHash("sha256").update(r.initial_admission_canonical).digest("hex") !== r.initial_admission_sha256) throw conflict("Original native refund admission unavailable");
  assertInitialRefundAdmission(admission, r.initial_admission_ref, r.initial_admission_sha256);
  let initial: any; try { initial = JSON.parse(r.initial_admission_canonical); } catch { throw conflict("Original refund admission malformed"); }
  if (initial.kind !== "FORMAL_NATIVE_REFUND_SERVER_REVIEW" || initial.reference !== r.initial_admission_ref || initial.database !== a.database || initial.runtimeUser !== a.runtimeUser
    || initial.merchantIdentityId !== r.merchant_identity_id || initial.merchantNo !== r.wire_merchant_no || !Array.isArray(initial.acceptedProfiles)
    || !initial.acceptedProfiles.some((p: any) => p.operation === "SUBMIT" && p.profileId === r.initial_profile_id && p.profileSha256 === r.initial_profile_sha256 && p.keyVersionRef === r.initial_key_version_ref)) throw conflict("Original refund merchant binding differs");
  return Object.freeze({ intentId: r.id, postingId: r.posting_id, orderId: r.order_id, paymentConfirmationId: r.payment_confirmation_id, renterUserId: r.renter_user_id,
    merchantNo: r.wire_merchant_no, merchantIdentityId: r.merchant_identity_id, originalPaymentTrxNo: r.original_payment_trx_no, originalPaymentOrderNo: r.original_payment_order_no,
    responsibilityVersionHash: r.responsibility_version_hash, refundOrderNo: r.refund_order_no, amountCents: r.amount_cents, currency: "CNY",
    notifyUrl: r.notify_url, ...(r.funds_account === null ? {} : { fundsAccount: r.funds_account }), ...(r.refund_reason === null ? {} : { reason: r.refund_reason }),
    profileId: r.initial_profile_id, initialProfileSha256: r.initial_profile_sha256, keyVersionRef: r.initial_key_version_ref,
    ...(r.provider_refund_trx_no ? { providerRefundTrxNo: r.provider_refund_trx_no } : {}) });
}
export async function readFormalRefundRow(client: PoolClient, admission: FormalRefundAdmission, id: string): Promise<FormalRefundRow> {
  if (!validId(id)) throw invalid(); await assertRefundResource(client, admission);
  const r = (await client.query<FormalRefundRow>(`SELECT ${FORMAL_REFUND_COLUMNS} FROM zzsh_order.channel_refund_intent WHERE id=$1 AND payment_source='JOINPAY'`, [id])).rows[0];
  if (!r) throw notFound(); formalRefundBinding(r, admission); return r;
}
/** 所有native路径共用预算→主体→revision→intent锁；不先持intent再等待同租客资金主体。 */
export async function lockFormalRefundContext(client: PoolClient, admission: FormalRefundAdmission, id: string): Promise<FormalRefundRow> {
  const original = await readFormalRefundRow(client, admission, id);
  await lockRefundFunds(client, "JOINPAY", original.merchant_identity_id, original.original_payment_trx_no);
  if (!(await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`, [original.renter_user_id])).rows[0]) throw notFound();
  if (!(await client.query(`SELECT ledger_revision FROM zzsh_order.wallet_revision WHERE user_id=$1`, [original.renter_user_id])).rows[0]) throw conflict("Original refund wallet revision unavailable");
  const row = (await client.query<FormalRefundRow>(`SELECT ${FORMAL_REFUND_COLUMNS} FROM zzsh_order.channel_refund_intent WHERE id=$1 AND payment_source='JOINPAY' FOR UPDATE`, [id])).rows[0];
  if (!row) throw notFound(); formalRefundBinding(row, admission); return row;
}
export type FormalRefundCreateInput = { postingId: string; renterUserId: string; amountCents: string; idempotencyKey: unknown; requestId: string;
  admission?: FormalRefundAdmission; profile?: BoundRefundProfile; notifyUrl?: string; reason?: string };
/** 已认证主体/授权Admin的本单租客范围由调用者给定；当前能力取得仅在原键恢复之后。 */
export async function createFormalRefundIntent(client: PoolClient, input: FormalRefundCreateInput) {
  const key = validateIdempotencyKey(input.idempotencyKey);
  if (![input.postingId, input.renterUserId, input.requestId].every(validId) || input.reason!==undefined && (typeof input.reason!=="string" || /\p{Cs}/u.test(input.reason) || Buffer.byteLength(input.reason)>400)) throw invalid(); wireAmountForCents(input.amountCents);
  const basis = await readRefundBasis(client, input.postingId);
  if (!basis || basis.renter_user_id !== input.renterUserId) throw notFound();
  if (basis.source !== "JOINPAY" || basis.currency !== "CNY") throw conflict("Native refund original JOINPAY payment unavailable");
  await lockRefundFunds(client, basis.source, basis.merchant_scope_id, basis.provider_transaction_id);
  const fingerprint = fingerprintRequest("rental.refund.intent", input.postingId, { amountCents: input.amountCents, reason:input.reason??null });
  const old = (await client.query<FormalRefundRow>(`SELECT ${FORMAL_REFUND_COLUMNS} FROM zzsh_order.channel_refund_intent WHERE posting_id=$1 AND idempotency_key=$2`, [input.postingId, key])).rows[0];
  if (old) {
    if (old.payment_source !== "JOINPAY" || old.evidence_level !== "JOINPAY_FORMAL" || !old.initial_admission_ref) throw conflict("Original refund cannot be promoted");
    if (old.request_fingerprint !== fingerprint) throw new SecurityApiError(409, API_V1_ERROR_CODES.IDEMPOTENCY_KEY_REUSED, "Refund key reused with different amount");
    return { replayed: true, intentId: old.id, refundOrderNo: old.refund_order_no, state: old.state, budgetDisposition: old.budget_disposition };
  }
  if (!input.admission || !input.profile || !input.notifyUrl) throw new SecurityApiError(503,API_V1_ERROR_CODES.EVIDENCE_UNAVAILABLE,"Native refund initial admission unavailable");
  const a = assertFormalRefundProfile(input.admission, input.profile, "SUBMIT"), p = describeRefundProfile(input.profile, "SUBMIT"); assertRefundStart(input.admission); await assertRefundResource(client, input.admission);
  if (a.merchantIdentityId !== basis.merchant_scope_id || p.notifyUrl !== input.notifyUrl) throw conflict("Native refund original merchant differs");
  if (!(await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`, [basis.renter_user_id])).rows[0]
    || !(await client.query(`SELECT ledger_revision FROM zzsh_order.wallet_revision WHERE user_id=$1`, [basis.renter_user_id])).rows[0]) throw conflict("Native refund original revision unavailable");
  const review = (await client.query(`SELECT EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent WHERE payment_source='JOINPAY' AND merchant_identity_id=$1 AND original_payment_trx_no=$2 AND requires_review) AS blocked`, [basis.merchant_scope_id, basis.provider_transaction_id])).rows[0];
  if (review?.blocked !== false) throw conflict("Original payment refund requires review");
  await assertRefundBudget(client, basis, input.postingId, input.amountCents);
  const id = freshId("refund"), refundNo = refundNumber(basis, input.postingId, key);
  assertRefundBinding(input.profile,"SUBMIT",{intentId:id,postingId:input.postingId,orderId:basis.order_id,paymentConfirmationId:basis.payment_confirmation_id,renterUserId:basis.renter_user_id,
    merchantIdentityId:basis.merchant_scope_id,merchantNo:p.merchantNo,originalPaymentTrxNo:basis.provider_transaction_id,originalPaymentOrderNo:basis.merchant_order_no,
    responsibilityVersionHash:basis.version_hash,refundOrderNo:refundNo,amountCents:input.amountCents,currency:"CNY",notifyUrl:input.notifyUrl,reason:input.reason,
    fundsAccount:p.fundsAccount,profileId:p.profileId,initialProfileSha256:p.profileSha256,keyVersionRef:p.keyVersionRef});
  const row = (await client.query<FormalRefundRow>(`INSERT INTO zzsh_order.channel_refund_intent
    (id,posting_id,order_id,payment_confirmation_id,renter_user_id,payment_source,merchant_identity_id,original_payment_trx_no,original_payment_order_no,responsibility_version_hash,
     refund_order_no,amount_cents,currency,idempotency_key,request_fingerprint,due_at,evidence_level,initial_admission_ref,initial_admission_sha256,initial_admission_canonical,
     wire_merchant_no,initial_profile_id,initial_profile_sha256,initial_key_version_ref,notify_url,funds_account,refund_reason)
    VALUES($1,$2,$3,$4,$5,'JOINPAY',$6,$7,$8,$9,$10,$11,'CNY',$12,$13,$14,'JOINPAY_FORMAL',$15,$16,$17,$18,$19,$20,$21,$22,$23,$24) RETURNING ${FORMAL_REFUND_COLUMNS}`,
    [id, input.postingId, basis.order_id, basis.payment_confirmation_id, basis.renter_user_id, basis.merchant_scope_id, basis.provider_transaction_id, basis.merchant_order_no,
      basis.version_hash, refundNo, input.amountCents, key, fingerprint, basis.due_at, a.reference, a.sha256, a.canonical, p.merchantNo,
      p.profileId, p.profileSha256, p.keyVersionRef, input.notifyUrl, p.fundsAccount ?? null, input.reason ?? null])).rows[0]!;
  await recordAudit(client, { actorType: "system", action: "order.refund.native.allocated", objectType: "channel_refund_intent", objectId: id, outcome: "SUCCESS", requestId: input.requestId,
    details: { postingId: input.postingId, amountCents: input.amountCents, initialAdmissionSha256: a.sha256, formalRefundComplete: false } });
  return { replayed: false, intentId: row.id, refundOrderNo: row.refund_order_no, state: row.state, budgetDisposition: row.budget_disposition };
}
