import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import { API_V1_ERROR_CODES, validateIdempotencyKey } from "../contracts/api-v1";
import { conflict, fingerprintRequest, invalid, notFound } from "../supply/supply-util";
import { wireAmountForCents } from "./channel-payment-store";
import { FORMAL_REFUND_COLUMNS, assertRefundResource, lockRefundFunds, type FormalRefundRow } from "./channel-refund-store";
import { assertFormalRefundProfile, assertRefundStart, assertRefundBinding, describeRefundProfile,
  type BoundRefundProfile, type FormalRefundAdmission } from "./joinpay-refund-profile";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SHA = /^[a-f0-9]{64}$/;
const fresh = (prefix: string) => `${prefix}_${randomUUID().replaceAll("-", "")}`;
const sha = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const supportedReasons = new Set(["DUPLICATE_PAYMENT", "LATE_PAYMENT"]);

export type AbnormalRefundReviewReason =
  | "ORIGINAL_NOT_REVIEW_REQUIRED"
  | "ORIGINAL_REASON_NOT_SUPPORTED"
  | "ORIGINAL_NOT_FORMAL_JOINPAY"
  | "ORIGINAL_REQUEST_MISMATCH"
  | "ORIGINAL_EVIDENCE_MISMATCH"
  | "ORIGINAL_ANCHOR_MISMATCH"
  | "ORIGINAL_APPLIED_SAME_TRX"
  | "ORIGINAL_ORDER_NO_AMBIGUOUS"
  | "ORIGINAL_POSTING_EXISTS"
  | "ORIGINAL_AMOUNT_INVALID";

export type AbnormalRefundResult =
  | Readonly<{ kind: "ALLOCATED" | "REPLAYED"; intentId: string; refundOrderNo: string; state: string;
      budgetDisposition: "ALLOCATED" | "CONSUMED" | "RELEASED"; amountCents: string; currency: "CNY";
      confirmationId: string; evidenceId: string; anchorId: string; reasonCode: string;
      liabilityRootId: string; liabilityEventId: string }>
  | Readonly<{ kind: "REVIEW_REQUIRED"; reason: AbnormalRefundReviewReason; confirmationId: string }>;

type PreRow = {
  order_id: string; merchant_identity_id: string; provider_transaction_id: string; merchant_order_no: string;
  amount_cents: string; currency: string; disposition: string; reason_code: string | null; renter_user_id: string;
};
type BasisRow = PreRow & {
  source: string; joinpay_request_id: string | null; joinpay_evidence_id: string | null; joinpay_anchor_id: string | null;
  request_channel: string | null; request_evidence_level: string | null; request_merchant: string | null;
  request_order_no: string | null; request_amount_cents: string | null; request_currency: string | null;
  binding_wire_merchant_no: string | null; formal_admission_ref: string | null;
  evidence_event: string | null; evidence_trx: string | null; evidence_schema: string | null;
  evidence_signature: string | null; evidence_binding: string | null; evidence_raw_sha256: string | null;
  anchor_channel: string | null; anchor_evidence_level: string | null; anchor_order: string | null;
  anchor_request: string | null; anchor_merchant: string | null; anchor_trx: string | null;
  order_no_trx_count: string; has_applied_same_trx: boolean; has_posting: boolean;
};
const review = (reason: AbnormalRefundReviewReason, confirmationId: string): AbnormalRefundResult =>
  Object.freeze({ kind: "REVIEW_REQUIRED", reason, confirmationId });

async function readable(client: PoolClient): Promise<boolean> {
  const row = (await client.query<{ readable: boolean }>(`SELECT
    to_regclass('zzsh_order.channel_refund_intent') IS NOT NULL
    AND to_regclass('zzsh_order.payment_confirmation') IS NOT NULL
    AND to_regclass('zzsh_order.payment_channel_transaction') IS NOT NULL
    AND to_regclass('zzsh_order.joinpay_collection_evidence') IS NOT NULL
    AND to_regclass('zzsh_order.finance_economic_root') IS NOT NULL
    AND to_regclass('zzsh_order.finance_event') IS NOT NULL
    AND to_regprocedure('zzsh_order.native_abnormal_refund_terminal_complete(text)') IS NOT NULL
    AND to_regprocedure('zzsh_order.native_abnormal_refund_liability_complete(text)') IS NOT NULL
    AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('zzsh_order.channel_refund_intent')
      AND t.tgname='channel_refund_joinpay_write_guard' AND NOT t.tgisinternal AND t.tgenabled='O')
    AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('zzsh_order.finance_economic_root')
      AND t.tgname='abnormal_refund_liability_root_guard' AND NOT t.tgisinternal AND t.tgenabled='O')
    AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('zzsh_order.finance_event')
      AND t.tgname='abnormal_refund_liability_event_guard' AND NOT t.tgisinternal AND t.tgenabled='O')
    AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('zzsh_order.finance_event')
      AND t.tgname='abnormal_refund_liability_event_batch_guard' AND NOT t.tgisinternal AND t.tgenabled='O')
    AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('zzsh_order.settlement_ledger_entry')
      AND t.tgname='abnormal_refund_liability_entry_guard' AND NOT t.tgisinternal AND t.tgenabled='O')
    AND EXISTS(SELECT 1 FROM pg_trigger t WHERE t.tgrelid=to_regclass('zzsh_order.settlement_ledger_entry')
      AND t.tgname='abnormal_refund_liability_entry_batch_guard' AND NOT t.tgisinternal AND t.tgenabled='O')
    AND (SELECT count(*)=3 FROM pg_attribute a WHERE a.attrelid=to_regclass('zzsh_order.channel_refund_intent')
      AND a.attname IN('basis_kind','liability_root_id','liability_event_id') AND NOT a.attisdropped
      AND has_column_privilege(a.attrelid,a.attname,'SELECT')) AS readable`)).rows[0];
  return row?.readable === true;
}
async function writable(client: PoolClient): Promise<boolean> {
  const row = (await client.query<{ writable: boolean }>(`SELECT
    to_regclass('zzsh_order.channel_refund_intent') IS NOT NULL
    AND (SELECT count(*)=3 FROM pg_attribute a WHERE a.attrelid=to_regclass('zzsh_order.channel_refund_intent')
      AND a.attname IN('basis_kind','liability_root_id','liability_event_id') AND NOT a.attisdropped
      AND has_column_privilege(a.attrelid,a.attname,'INSERT'))
    AND has_function_privilege('zzsh_order.native_abnormal_refund_terminal_complete(text)','EXECUTE')
    AND has_function_privilege('zzsh_order.native_abnormal_refund_liability_complete(text)','EXECUTE') AS writable`)).rows[0];
  return row?.writable === true;
}
const unavailable = (message: string) => new SecurityApiError(503, API_V1_ERROR_CODES.EVIDENCE_UNAVAILABLE, message);
/** 旧键恢复不要求新SUBMIT准入，但必须仍以当前数据库身份并重验持久原准入/商户/profile绑定。 */
async function assertOriginalResource(client: PoolClient, row: FormalRefundRow): Promise<void> {
  const r = (await client.query(`SELECT current_database() AS db,current_user AS actor,pg_current_xact_id()::text AS xid,
    current_setting('transaction_isolation') AS isolation`)).rows[0];
  let initial: any;
  try { initial = JSON.parse(row.initial_admission_canonical ?? ""); } catch { throw conflict("Original refund admission malformed"); }
  if (r?.db !== initial.database || r?.actor !== initial.runtimeUser || r?.isolation !== "read committed"
    || !/^[1-9][0-9]*$/.test(r?.xid ?? "") || sha(row.initial_admission_canonical ?? "") !== row.initial_admission_sha256
    || initial.kind !== "FORMAL_NATIVE_REFUND_SERVER_REVIEW" || initial.reference !== row.initial_admission_ref
    || typeof initial.reviewSha256 !== "string" || !SHA.test(initial.reviewSha256)
    || initial.merchantIdentityId !== row.merchant_identity_id || initial.merchantNo !== row.wire_merchant_no
    || !Array.isArray(initial.acceptedProfiles)
    || !initial.acceptedProfiles.some((p: any) => p.operation === "SUBMIT" && p.profileId === row.initial_profile_id
      && p.profileSha256 === row.initial_profile_sha256 && p.keyVersionRef === row.initial_key_version_ref)) {
    throw conflict("Original native refund admission unavailable");
  }
}
async function assertLiabilityClosure(client: PoolClient, confirmationId: string, rootId: string, eventId: string,
  renterUserId: string, amountCents: string, digest: string): Promise<void> {
  const row = (await client.query<{ valid: boolean }>(`SELECT (
      r.source_kind='NATIVE_ABNORMAL_REFUND' AND r.source_type='NATIVE' AND r.source_system='zzsh'
      AND r.source_entity='joinpay_abnormal_refund_liability' AND r.beneficiary_role='RENTER' AND r.policy_version IS NULL
      AND r.source_id=$3 AND r.subject_user_id=$4 AND r.source_digest=$5 AND r.basis_id IS NULL
      AND c.currency='CNY' AND c.amount_cents=$6::numeric
      AND ev.kind='REFUND_LIABILITY_RECOGNIZED' AND ev.economic_root_id=r.id AND ev.subject_user_id=$4
      AND ev.id=r.id||'_recognized' AND (SELECT count(*) FROM zzsh_order.finance_event WHERE economic_root_id=r.id)=1
      AND (SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=ev.id)=2
      AND EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=ev.id AND l.line_no=1
        AND l.account_code='JOINPAY_UNALLOCATED_RECEIPT' AND l.debit_cents=$6::numeric AND l.credit_cents=0 AND l.counterparty_user_id IS NULL
        AND l.posting_id IS NULL AND l.source_payment_confirmation_id IS NULL
        AND l.details=jsonb_build_object('abnormalRefundLiabilityId',$3::text,'paymentConfirmationId',$3::text,
          'evidenceId',c.joinpay_evidence_id,'anchorId',c.joinpay_anchor_id,'amountCents',$6::text))
      AND EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=ev.id AND l.line_no=2
        AND l.account_code='RENTER_REFUND_PAYABLE' AND l.debit_cents=0 AND l.credit_cents=$6::numeric AND l.counterparty_user_id=$4
        AND l.posting_id IS NULL AND l.source_payment_confirmation_id IS NULL
        AND l.details=jsonb_build_object('abnormalRefundLiabilityId',$3::text,'paymentConfirmationId',$3::text,
          'evidenceId',c.joinpay_evidence_id,'anchorId',c.joinpay_anchor_id,'amountCents',$6::text))
    ) AS valid FROM zzsh_order.finance_economic_root r
    JOIN zzsh_order.finance_event ev ON ev.id=$2 AND ev.economic_root_id=r.id
    JOIN zzsh_order.payment_confirmation c ON c.id=$3 AND c.id=r.source_id WHERE r.id=$1`, [rootId, eventId, confirmationId, renterUserId, digest, amountCents])).rows[0];
  if (row?.valid !== true) throw unavailable("Abnormal refund liability closure differs");
}

/** 首次SUBMIT前在同一事务内重核；只读、不取钥、不建lease/attempt。 */
export async function readAbnormalRefundGate(client: PoolClient, intentId: string): Promise<{ valid: boolean; reason: string; orderNoTrxCount: string }> {
  if (!ID.test(intentId)) throw invalid();
  const row = (await client.query<{ valid: boolean; order_no_trx_count: string }>(`/* abnormal refund first submit gate */
    SELECT (SELECT count(DISTINCT p.provider_transaction_id)::text FROM zzsh_order.payment_confirmation p
        JOIN zzsh_order.channel_refund_intent i ON i.id=$1
        WHERE p.source='JOINPAY' AND p.merchant_scope_id=i.merchant_identity_id
          AND p.merchant_order_no=i.original_payment_order_no AND p.disposition IN('APPLIED','REVIEW_REQUIRED')) AS order_no_trx_count,
      EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i
        JOIN zzsh_order.payment_confirmation c ON c.id=i.payment_confirmation_id AND c.order_id=i.order_id
        JOIN zzsh_order.rental_order o ON o.id=i.order_id
        JOIN zzsh_order.payment_request r ON r.id=c.joinpay_request_id AND r.order_id=c.order_id
        JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=r.id
        JOIN zzsh_order.joinpay_collection_evidence e ON e.id=c.joinpay_evidence_id AND e.request_id=c.joinpay_request_id
        JOIN zzsh_order.payment_channel_transaction a ON a.id=c.joinpay_anchor_id
        JOIN zzsh_order.finance_economic_root lr ON lr.id=i.liability_root_id
        JOIN zzsh_order.finance_event le ON le.id=i.liability_event_id AND le.economic_root_id=lr.id
        WHERE i.id=$1 AND i.basis_kind='REVIEW_CONFIRMATION' AND i.posting_id IS NULL
          AND c.source='JOINPAY' AND c.disposition='REVIEW_REQUIRED' AND c.reason_code IN('DUPLICATE_PAYMENT','LATE_PAYMENT')
          AND c.currency='CNY' AND c.amount_cents=i.amount_cents AND o.renter_user_id=i.renter_user_id
          AND c.merchant_scope_id=i.merchant_identity_id AND c.provider_transaction_id=i.original_payment_trx_no
          AND c.merchant_order_no=i.original_payment_order_no
          AND r.channel='JOINPAY' AND r.evidence_level='JOINPAY_CANDIDATE' AND b.formal_admission_ref IS NOT NULL
          AND r.merchant_identity_id=c.merchant_scope_id AND r.channel_order_no=c.merchant_order_no
          AND r.amount_cents=c.amount_cents AND r.currency='CNY'
          AND e.event='E4' AND e.channel_trx_no=c.provider_transaction_id AND e.schema_outcome='VALID'
          AND e.signature_outcome='MATCH' AND e.binding_outcome='MATCH'
          AND a.channel='JOINPAY' AND a.evidence_level='JOINPAY_VERIFIED' AND a.native_order_id=c.order_id
          AND a.request_id=c.joinpay_request_id AND a.merchant_identity_id=c.merchant_scope_id AND a.channel_trx_no=c.provider_transaction_id
          AND NOT EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.source='JOINPAY'
            AND p.merchant_scope_id=c.merchant_scope_id AND p.provider_transaction_id=c.provider_transaction_id AND p.disposition='APPLIED')
          AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.payment_confirmation_id=c.id)
          AND (SELECT count(DISTINCT p.provider_transaction_id) FROM zzsh_order.payment_confirmation p
            WHERE p.source='JOINPAY' AND p.merchant_scope_id=c.merchant_scope_id
              AND p.merchant_order_no=c.merchant_order_no AND p.disposition IN('APPLIED','REVIEW_REQUIRED'))=1
          AND lr.source_kind='NATIVE_ABNORMAL_REFUND' AND lr.source_entity='joinpay_abnormal_refund_liability'
          AND lr.source_id=i.payment_confirmation_id AND lr.subject_user_id=i.renter_user_id AND lr.source_digest=i.responsibility_version_hash
          AND le.kind='REFUND_LIABILITY_RECOGNIZED' AND le.subject_user_id=i.renter_user_id
          AND (SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=le.id)=2
          AND EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=le.id AND l.line_no=1
            AND l.account_code='JOINPAY_UNALLOCATED_RECEIPT' AND l.debit_cents=i.amount_cents AND l.credit_cents=0 AND l.counterparty_user_id IS NULL)
          AND EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=le.id AND l.line_no=2
            AND l.account_code='RENTER_REFUND_PAYABLE' AND l.debit_cents=0 AND l.credit_cents=i.amount_cents AND l.counterparty_user_id=i.renter_user_id)
      ) AS valid`, [intentId])).rows[0];
  const count = row?.order_no_trx_count;
  if (typeof count !== "string" || !/^\d+$/.test(count)) throw unavailable("Abnormal refund gate count unavailable");
  return { valid: row?.valid === true, orderNoTrxCount: count,
    reason: row?.valid === true ? "" : BigInt(count) > 1n ? "ORIGINAL_ORDER_NO_AMBIGUOUS" : "ABNORMAL_BASIS_REVIEW" };
}

/** 只从持久 REVIEW confirmation + formal anchor/evidence/request 读取；不再接受外部事实对象或布尔品牌。 */
export async function createAbnormalFormalRefundIntent(client: PoolClient, input: {
  orderId: string; confirmationId: string; idempotencyKey: unknown; requestId: string;
  admission?: FormalRefundAdmission; profile?: BoundRefundProfile;
}): Promise<AbnormalRefundResult> {
  if (!ID.test(input.orderId) || !ID.test(input.confirmationId) || !ID.test(input.requestId)) throw invalid();
  const key = validateIdempotencyKey(input.idempotencyKey);
  if (!await readable(client)) throw unavailable("Abnormal refund basis schema is not readable");
  const pre = (await client.query<PreRow>(`SELECT c.order_id,c.merchant_scope_id AS merchant_identity_id,c.provider_transaction_id,
      c.merchant_order_no,c.amount_cents::text AS amount_cents,c.currency,c.disposition,c.reason_code,o.renter_user_id
    FROM zzsh_order.payment_confirmation c JOIN zzsh_order.rental_order o ON o.id=c.order_id
    WHERE c.id=$1 AND c.order_id=$2`, [input.confirmationId, input.orderId])).rows[0];
  if (!pre) throw notFound();
  await lockRefundFunds(client, "JOINPAY", pre.merchant_identity_id, pre.provider_transaction_id);
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array(
    'zzsh:refund-order-no:v1',$1::text,$2::text)::text,0))`, [pre.merchant_identity_id, pre.merchant_order_no]);
  if ((await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`, [pre.renter_user_id])).rowCount !== 1) throw notFound();
  const fingerprint = fingerprintRequest("rental.refund.abnormal.intent", input.confirmationId,
    { amountCents: pre.amount_cents, reason: pre.reason_code });
  const oldRows = (await client.query<FormalRefundRow>(`SELECT ${FORMAL_REFUND_COLUMNS} FROM zzsh_order.channel_refund_intent
    WHERE payment_confirmation_id=$1 AND basis_kind='REVIEW_CONFIRMATION' ORDER BY created_at,id`, [input.confirmationId])).rows;
  const same = oldRows.find(row => row.idempotency_key === key);
  const active = oldRows.find(row => row.budget_disposition !== "RELEASED");
  if (same) {
    if (same.request_fingerprint !== fingerprint) {
      throw new SecurityApiError(409, API_V1_ERROR_CODES.IDEMPOTENCY_KEY_REUSED, "Abnormal refund key reused with different original");
    }
    await assertOriginalResource(client, same);
    const source = (await client.query<{ evidence_id: string | null; anchor_id: string | null }>(`SELECT
      joinpay_evidence_id AS evidence_id,joinpay_anchor_id AS anchor_id FROM zzsh_order.payment_confirmation WHERE id=$1`,
    [input.confirmationId])).rows[0];
    return Object.freeze({ kind: "REPLAYED", intentId: same.id, refundOrderNo: same.refund_order_no, state: same.state,
      budgetDisposition: same.budget_disposition, amountCents: same.amount_cents, currency: "CNY",
      confirmationId: same.payment_confirmation_id, evidenceId: source?.evidence_id ?? "", anchorId: source?.anchor_id ?? "",
      reasonCode: same.refund_reason ?? "", liabilityRootId: same.liability_root_id ?? "", liabilityEventId: same.liability_event_id ?? "" });
  }
  if (active) throw new SecurityApiError(409, API_V1_ERROR_CODES.IDEMPOTENCY_KEY_REUSED, "Abnormal refund already active under another key");
  // 没有原receipt的新请求先关闭；旧key重放已在上面返回，不受新profile/INSERT准入影响。
  if (!input.admission || !input.profile) throw unavailable("Abnormal refund admission unavailable");
  if (!await writable(client)) throw unavailable("Abnormal refund basis is not writable");
  await assertRefundResource(client, input.admission);
  const b = (await client.query<BasisRow>(`SELECT c.order_id,c.merchant_scope_id AS merchant_identity_id,c.provider_transaction_id,
      c.merchant_order_no,c.amount_cents::text AS amount_cents,c.currency,c.disposition,c.reason_code,o.renter_user_id,c.source,
      c.joinpay_request_id,c.joinpay_evidence_id,c.joinpay_anchor_id,
      r.channel AS request_channel,r.evidence_level AS request_evidence_level,r.merchant_identity_id AS request_merchant,
      r.channel_order_no AS request_order_no,r.amount_cents::text AS request_amount_cents,r.currency AS request_currency,
      b.wire_merchant_no AS binding_wire_merchant_no,b.formal_admission_ref,
      e.event AS evidence_event,e.channel_trx_no AS evidence_trx,e.schema_outcome AS evidence_schema,
      e.signature_outcome AS evidence_signature,e.binding_outcome AS evidence_binding,e.raw_sha256 AS evidence_raw_sha256,
      a.channel AS anchor_channel,a.evidence_level AS anchor_evidence_level,a.native_order_id AS anchor_order,
      a.request_id AS anchor_request,a.merchant_identity_id AS anchor_merchant,a.channel_trx_no AS anchor_trx,
      (SELECT count(DISTINCT p.provider_transaction_id)::text FROM zzsh_order.payment_confirmation p
        WHERE p.source='JOINPAY' AND p.merchant_scope_id=c.merchant_scope_id AND p.merchant_order_no=c.merchant_order_no
          AND p.disposition IN('APPLIED','REVIEW_REQUIRED')) AS order_no_trx_count,
      EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.source='JOINPAY' AND p.merchant_scope_id=c.merchant_scope_id
        AND p.provider_transaction_id=c.provider_transaction_id AND p.disposition='APPLIED') AS has_applied_same_trx,
      EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.payment_confirmation_id=c.id) AS has_posting
    FROM zzsh_order.payment_confirmation c JOIN zzsh_order.rental_order o ON o.id=c.order_id
    LEFT JOIN zzsh_order.payment_request r ON r.id=c.joinpay_request_id AND r.order_id=c.order_id
    LEFT JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=r.id
    LEFT JOIN zzsh_order.joinpay_collection_evidence e ON e.id=c.joinpay_evidence_id AND e.request_id=c.joinpay_request_id
    LEFT JOIN zzsh_order.payment_channel_transaction a ON a.id=c.joinpay_anchor_id
    WHERE c.id=$1 AND c.order_id=$2 FOR SHARE OF c,o`, [input.confirmationId, input.orderId])).rows[0];
  if (!b) throw notFound();
  if (b.source !== "JOINPAY" || b.disposition !== "REVIEW_REQUIRED" || !b.reason_code || !supportedReasons.has(b.reason_code)) {
    return review(b.source !== "JOINPAY" ? "ORIGINAL_NOT_FORMAL_JOINPAY" : b.disposition !== "REVIEW_REQUIRED" ? "ORIGINAL_NOT_REVIEW_REQUIRED" : "ORIGINAL_REASON_NOT_SUPPORTED", input.confirmationId);
  }
  if (b.currency !== "CNY" || !/^[1-9]\d{0,15}$/.test(b.amount_cents) || BigInt(b.amount_cents) > 9999999999999999n) return review("ORIGINAL_AMOUNT_INVALID", input.confirmationId);
  if (b.request_channel !== "JOINPAY" || b.request_evidence_level !== "JOINPAY_CANDIDATE" || !b.formal_admission_ref
    || b.request_merchant !== b.merchant_identity_id || b.request_order_no !== b.merchant_order_no
    || b.request_amount_cents !== b.amount_cents || b.request_currency !== "CNY") return review("ORIGINAL_REQUEST_MISMATCH", input.confirmationId);
  if (!b.joinpay_request_id || !b.joinpay_evidence_id || !b.joinpay_anchor_id || b.evidence_event !== "E4"
    || b.evidence_schema !== "VALID" || b.evidence_signature !== "MATCH" || b.evidence_binding !== "MATCH"
    || b.evidence_trx !== b.provider_transaction_id || !b.evidence_raw_sha256 || !SHA.test(b.evidence_raw_sha256)) return review("ORIGINAL_EVIDENCE_MISMATCH", input.confirmationId);
  if (b.anchor_channel !== "JOINPAY" || b.anchor_evidence_level !== "JOINPAY_VERIFIED" || b.anchor_order !== b.order_id
    || b.anchor_request !== b.joinpay_request_id || b.anchor_merchant !== b.merchant_identity_id || b.anchor_trx !== b.provider_transaction_id) {
    return review("ORIGINAL_ANCHOR_MISMATCH", input.confirmationId);
  }
  if (b.has_applied_same_trx) return review("ORIGINAL_APPLIED_SAME_TRX", input.confirmationId);
  if (b.has_posting) return review("ORIGINAL_POSTING_EXISTS", input.confirmationId);
  if (b.order_no_trx_count !== "1") return review("ORIGINAL_ORDER_NO_AMBIGUOUS", input.confirmationId);
  const a = assertFormalRefundProfile(input.admission, input.profile, "SUBMIT"), p = describeRefundProfile(input.profile, "SUBMIT");
  assertRefundStart(input.admission);
  if (a.merchantIdentityId !== b.merchant_identity_id || p.merchantNo !== b.binding_wire_merchant_no) return review("ORIGINAL_REQUEST_MISMATCH", input.confirmationId);
  const revision = (await client.query<{ ledger_revision: string }>(`SELECT ledger_revision::text FROM zzsh_order.wallet_revision WHERE user_id=$1`, [b.renter_user_id])).rows[0];
  if (!revision || !/^[0-9]+$/.test(revision.ledger_revision)) throw conflict("Abnormal refund wallet revision unavailable");
  const allocated = (await client.query<{ allocated: string }>(`SELECT COALESCE(sum(amount_cents),0)::text AS allocated
    FROM zzsh_order.channel_refund_intent WHERE payment_source='JOINPAY' AND merchant_identity_id=$1
      AND original_payment_trx_no=$2 AND budget_disposition<>'RELEASED'`, [b.merchant_identity_id, b.provider_transaction_id])).rows[0]?.allocated;
  if (!allocated || !/^[0-9]+$/.test(allocated) || BigInt(allocated) + BigInt(b.amount_cents) > BigInt(b.amount_cents)) throw conflict("Refund allocation exceeds original payment");
  wireAmountForCents(b.amount_cents);
  const intentId = fresh("refund"), liabilityKey = sha(input.confirmationId).slice(0, 40);
  const liabilityRootId = `native_abnormal_refund_liability_${liabilityKey}`;
  const liabilityEventId = `native_abnormal_refund_liability_${liabilityKey}_recognized`;
  const refundOrderNo = `RF${fingerprintRequest("channel.refund.number.v1", input.confirmationId,
    ["JOINPAY", b.merchant_identity_id, b.provider_transaction_id, key]).slice(0, 28)}`;
  assertRefundBinding(input.profile, "SUBMIT", { intentId, postingId: null, basisKind: "REVIEW_CONFIRMATION",
    abnormalConfirmationId: input.confirmationId, orderId: b.order_id, paymentConfirmationId: input.confirmationId,
    renterUserId: b.renter_user_id, merchantNo: p.merchantNo, merchantIdentityId: b.merchant_identity_id,
    originalPaymentTrxNo: b.provider_transaction_id, originalPaymentOrderNo: b.merchant_order_no,
    responsibilityVersionHash: b.evidence_raw_sha256, refundOrderNo, amountCents: b.amount_cents, currency: "CNY",
    notifyUrl: p.notifyUrl, reason: b.reason_code, fundsAccount: p.fundsAccount, profileId: p.profileId,
    initialProfileSha256: p.profileSha256, keyVersionRef: p.keyVersionRef });
  // 负债按原 confirmation 唯一；失败未执行后的新 key 只新 intent，不重复确认负债。
  const existing = (await client.query<{ roots: number; events: number; entries: number }>(`SELECT
    (SELECT count(*)::int FROM zzsh_order.finance_economic_root WHERE id=$1) AS roots,
    (SELECT count(*)::int FROM zzsh_order.finance_event WHERE id=$2) AS events,
    (SELECT count(*)::int FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=$2) AS entries`,
  [liabilityRootId, liabilityEventId])).rows[0];
  if (!existing || !Number.isInteger(existing.roots) || !Number.isInteger(existing.events) || !Number.isInteger(existing.entries)) {
    throw unavailable("Abnormal refund liability batch is unreadable");
  }
  if (existing.roots !== 0 || existing.events !== 0 || existing.entries !== 0) {
    if (existing.roots !== 1 || existing.events !== 1 || existing.entries !== 2) {
      throw unavailable("Abnormal refund liability batch is partial");
    }
    await assertLiabilityClosure(client, input.confirmationId, liabilityRootId, liabilityEventId,
      b.renter_user_id, b.amount_cents, b.evidence_raw_sha256);
  }
  // 完整旧批次只读复用；再次INSERT会在ON CONFLICT前触发同事务新建守卫。
  if (existing.roots === 0) {
  await client.query(`INSERT INTO zzsh_order.finance_economic_root
    (id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,policy_version,source_digest)
    VALUES($1,NULL,'NATIVE_ABNORMAL_REFUND','NATIVE','zzsh','joinpay_abnormal_refund_liability',$2,$3,'RENTER',NULL,$4)
    ON CONFLICT(id) DO NOTHING`, [liabilityRootId, input.confirmationId, b.renter_user_id, b.evidence_raw_sha256]);
  await client.query(`INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision)
    VALUES($1,$2,'REFUND_LIABILITY_RECOGNIZED',$3,$4) ON CONFLICT(id) DO NOTHING`,
  [liabilityEventId, liabilityRootId, b.renter_user_id, revision.ledger_revision]);
  const details = { abnormalRefundLiabilityId: input.confirmationId, paymentConfirmationId: input.confirmationId,
    evidenceId: b.joinpay_evidence_id, anchorId: b.joinpay_anchor_id, amountCents: b.amount_cents };
  await client.query(`INSERT INTO zzsh_order.settlement_ledger_entry
    (id,posting_id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,source_payment_confirmation_id,details)
    VALUES($1,NULL,$2,1,'JOINPAY_UNALLOCATED_RECEIPT',$3,0,NULL,NULL,$4::jsonb),
          ($5,NULL,$2,2,'RENTER_REFUND_PAYABLE',0,$3,$6,NULL,$4::jsonb)
    ON CONFLICT(id) DO NOTHING`,
  [`${liabilityEventId}_1`, liabilityEventId, b.amount_cents, JSON.stringify(details), `${liabilityEventId}_2`, b.renter_user_id]);
  }
  await assertLiabilityClosure(client, input.confirmationId, liabilityRootId, liabilityEventId, b.renter_user_id,
    b.amount_cents, b.evidence_raw_sha256);
  const row = (await client.query<FormalRefundRow>(`INSERT INTO zzsh_order.channel_refund_intent
    (id,posting_id,order_id,payment_confirmation_id,renter_user_id,payment_source,merchant_identity_id,original_payment_trx_no,original_payment_order_no,
     responsibility_version_hash,refund_order_no,amount_cents,currency,idempotency_key,request_fingerprint,due_at,evidence_level,
     initial_admission_ref,initial_admission_sha256,initial_admission_canonical,wire_merchant_no,initial_profile_id,initial_profile_sha256,
     initial_key_version_ref,notify_url,funds_account,refund_reason,basis_kind,liability_root_id,liability_event_id)
    VALUES($1,NULL,$2,$3,$4,'JOINPAY',$5,$6,$7,$8,$9,$10,'CNY',$11,$12,clock_timestamp(),'JOINPAY_FORMAL',
      $13,$14,$15,$16,$17,$18,$19,$20,$21,$22,'REVIEW_CONFIRMATION',$23,$24) RETURNING ${FORMAL_REFUND_COLUMNS}`,
  [intentId, b.order_id, input.confirmationId, b.renter_user_id, b.merchant_identity_id, b.provider_transaction_id, b.merchant_order_no,
    b.evidence_raw_sha256, refundOrderNo, b.amount_cents, key, fingerprint, a.reference, a.sha256, a.canonical, p.merchantNo,
    p.profileId, p.profileSha256, p.keyVersionRef, p.notifyUrl, p.fundsAccount ?? null, b.reason_code, liabilityRootId, liabilityEventId])).rows[0]!;
  await recordAudit(client, { actorType: "system", action: "order.refund.abnormal.allocated", objectType: "channel_refund_intent",
    objectId: row.id, outcome: "SUCCESS", requestId: input.requestId, details: { confirmationId: input.confirmationId,
      evidenceId: b.joinpay_evidence_id, anchorId: b.joinpay_anchor_id, merchantIdentityId: b.merchant_identity_id,
      originalPaymentTrxNo: b.provider_transaction_id, amountCents: b.amount_cents, currency: "CNY", reasonCode: b.reason_code,
      liabilityRootId, liabilityEventId, formalRefundComplete: false, channelResult: "NOT_SUBMITTED" } });
  return Object.freeze({ kind: "ALLOCATED", intentId: row.id, refundOrderNo: row.refund_order_no, state: row.state,
    budgetDisposition: row.budget_disposition, amountCents: row.amount_cents, currency: "CNY", confirmationId: input.confirmationId,
    evidenceId: b.joinpay_evidence_id ?? "", anchorId: b.joinpay_anchor_id ?? "", reasonCode: b.reason_code,
    liabilityRootId, liabilityEventId });
}
