import type { PoolClient } from 'pg';
import { SecurityApiError } from '../auth/security-core';
import { exactCents } from './finance-money';
import { readJoinpayAccountSummary } from './joinpay-account-store';
import { readPrestartFinanceProjection } from '../order/prestart-termination';

/** Explicit server grants; neither a finance permission nor a URL supplies merchant scope. */
export type JoinpayAccountReadAccess = Readonly<{
  database: string;
  runtimeUser: string;
  merchantIdsByAdmin: ReadonlyMap<string, ReadonlySet<string>>;
}>;

export async function readAdminJoinpayMerchantAccounts(c: PoolClient, input: { adminId: string; merchantIdentityId: string }, access?: JoinpayAccountReadAccess) {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(input.merchantIdentityId)) throw new SecurityApiError(400, 'INVALID_ARGUMENT', 'Invalid merchant identity');
  if (!access) throw new SecurityApiError(503, 'EVIDENCE_UNAVAILABLE', 'Merchant account read scope is not configured');
  if (!access.merchantIdsByAdmin.get(input.adminId)?.has(input.merchantIdentityId)) throw new SecurityApiError(404, 'NOT_FOUND', 'Merchant account not found');
  const resource = (await c.query('SELECT current_database() AS database,current_user AS runtime_user')).rows[0];
  if (resource?.database !== access.database || resource.runtime_user !== access.runtimeUser) throw new SecurityApiError(503, 'EVIDENCE_UNAVAILABLE', 'Merchant account resource differs');
  const available = await readJoinpayAccountSummary(c, input.merchantIdentityId, 'AVAILABLE');
  const collection = await readJoinpayAccountSummary(c, input.merchantIdentityId, 'COLLECTION');
  if (!access.merchantIdsByAdmin.get(input.adminId)?.has(input.merchantIdentityId)) throw new SecurityApiError(409, 'CONFLICT', 'Merchant read access changed');
  return { contractVersion: 'admin-joinpay-accounts.read.v1', merchantIdentityId: input.merchantIdentityId,
    available, collection, aggregateAssets: null, channelAsOf: null, bankArrival: 'UNKNOWN' as const };
}

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const REFUND_NO = /^RF[0-9a-f]{28}$/;
const POSITIVE = /^[1-9][0-9]{0,15}$/;
const COUNT = /^(0|[1-9][0-9]{0,15})$/;
const CENTS_OR_NULL = /^(0|[1-9][0-9]{0,23})$/;
const FIRST_REASONS = ["ORIGINAL_ORDER_NO_AMBIGUOUS", "ABNORMAL_BASIS_REVIEW"] as const;

const ABNORMAL_ROWS_SQL = `SELECT i.id AS intent_id,i.refund_order_no,i.amount_cents::text AS amount_cents,i.currency,
    i.state,i.budget_disposition,i.requires_review,i.terminal_evidence_id,i.terminal_root_id,i.terminal_event_id,
    i.provider_refund_trx_no,to_char(i.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS completed_at,
    i.payment_confirmation_id,i.liability_root_id,i.liability_event_id,i.responsibility_version_hash,
    i.original_payment_trx_no,i.original_payment_order_no,i.merchant_identity_id,i.created_at,i.updated_at,
    c.order_id AS confirmation_order_id,c.source AS confirmation_source,c.disposition,c.reason_code,c.currency AS confirmation_currency,
    c.amount_cents::text AS confirmation_amount,c.merchant_scope_id,c.provider_transaction_id,c.merchant_order_no,
    c.joinpay_request_id,c.joinpay_evidence_id,c.joinpay_anchor_id,o.renter_user_id,
    rq.channel AS request_channel,rq.evidence_level AS request_evidence_level,rq.merchant_identity_id AS request_merchant,
    rq.channel_order_no AS request_order_no,rq.amount_cents::text AS request_amount,rq.currency AS request_currency,
    b.formal_admission_ref,b.wire_merchant_no,
    a.channel AS anchor_channel,a.evidence_level AS anchor_evidence_level,a.native_order_id AS anchor_order,a.request_id AS anchor_request,
    a.merchant_identity_id AS anchor_merchant,a.channel_trx_no AS anchor_trx,
    lr.source_kind AS root_kind,lr.source_type AS root_type,lr.source_system AS root_system,lr.source_entity AS root_entity,
    lr.source_id AS root_source_id,lr.subject_user_id AS root_subject,lr.beneficiary_role AS root_role,
    lr.source_digest AS root_digest,lr.policy_version AS root_policy,lr.basis_id AS root_basis,
    le.kind AS event_kind,le.economic_root_id AS event_root,le.subject_user_id AS event_subject,
    tr.source_kind AS terminal_root_kind,tr.source_id AS terminal_root_source,tr.subject_user_id AS terminal_root_subject,
    te.kind AS terminal_event_kind,te.economic_root_id AS terminal_event_root,
    (SELECT count(*)::text FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=le.id) AS liability_lines,
    (SELECT count(*)::text FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=le.id AND l.line_no=1
      AND l.account_code='JOINPAY_UNALLOCATED_RECEIPT' AND l.debit_cents=i.amount_cents AND l.credit_cents=0
      AND l.counterparty_user_id IS NULL AND l.posting_id IS NULL AND l.source_payment_confirmation_id IS NULL
      AND l.details->>'abnormalRefundLiabilityId'=c.id AND l.details->>'paymentConfirmationId'=c.id) AS liability_line1,
    (SELECT count(*)::text FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=le.id AND l.line_no=2
      AND l.account_code='RENTER_REFUND_PAYABLE' AND l.debit_cents=0 AND l.credit_cents=i.amount_cents
      AND l.counterparty_user_id=o.renter_user_id AND l.posting_id IS NULL AND l.source_payment_confirmation_id IS NULL
      AND l.details->>'abnormalRefundLiabilityId'=c.id AND l.details->>'paymentConfirmationId'=c.id) AS liability_line2,
    (SELECT count(*)::text FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=i.terminal_event_id) AS terminal_lines,
    (SELECT count(*)::text FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=i.terminal_event_id
      AND ((l.line_no=1 AND l.account_code='RENTER_REFUND_PAYABLE' AND l.debit_cents=i.amount_cents AND l.credit_cents=0
        AND l.counterparty_user_id=o.renter_user_id)
       OR (l.line_no=2 AND l.account_code='JOINPAY_UNALLOCATED_RECEIPT' AND l.debit_cents=0 AND l.credit_cents=i.amount_cents
        AND l.counterparty_user_id IS NULL))) AS terminal_good,
    ev.terminal AS evidence_terminal,ev.refund_transaction_no AS evidence_trx,
    to_char(ev.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS evidence_completed,
    (SELECT count(*)::int FROM zzsh_order.joinpay_refund_attempt x WHERE x.intent_id=i.id AND x.operation='SUBMIT') AS submit_attempts,
    (SELECT count(*)::int FROM zzsh_iam.audit_event a2 WHERE a2.action='order.refund.abnormal.first_submit.blocked'
      AND a2.object_type='channel_refund_intent' AND a2.object_id=i.id AND a2.outcome='FAILURE') AS blocked_count,
    (SELECT to_char(a2.occurred_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') FROM zzsh_iam.audit_event a2
      WHERE a2.action='order.refund.abnormal.first_submit.blocked' AND a2.object_type='channel_refund_intent'
        AND a2.object_id=i.id AND a2.outcome='FAILURE' ORDER BY a2.occurred_at DESC,a2.id COLLATE "C" DESC LIMIT 1) AS blocked_at,
    (SELECT a2.details->>'gateReason' FROM zzsh_iam.audit_event a2
      WHERE a2.action='order.refund.abnormal.first_submit.blocked' AND a2.object_type='channel_refund_intent'
        AND a2.object_id=i.id AND a2.outcome='FAILURE' ORDER BY a2.occurred_at DESC,a2.id COLLATE "C" DESC LIMIT 1) AS blocked_reason
  FROM zzsh_order.channel_refund_intent i
  LEFT JOIN zzsh_order.payment_confirmation c ON c.id=i.payment_confirmation_id AND c.order_id=i.order_id
  LEFT JOIN zzsh_order.rental_order o ON o.id=i.order_id
  LEFT JOIN zzsh_order.payment_request rq ON rq.id=c.joinpay_request_id AND rq.order_id=c.order_id
  LEFT JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=rq.id
  LEFT JOIN zzsh_order.payment_channel_transaction a ON a.id=c.joinpay_anchor_id
  LEFT JOIN zzsh_order.finance_economic_root lr ON lr.id=i.liability_root_id
  LEFT JOIN zzsh_order.finance_event le ON le.id=i.liability_event_id AND le.economic_root_id=lr.id
  LEFT JOIN zzsh_order.finance_economic_root tr ON tr.id=i.terminal_root_id
  LEFT JOIN zzsh_order.finance_event te ON te.id=i.terminal_event_id
  LEFT JOIN zzsh_order.joinpay_refund_evidence ev ON ev.id=i.terminal_evidence_id AND ev.intent_id=i.id
  WHERE i.order_id=$1 AND i.payment_source='JOINPAY' AND i.basis_kind='REVIEW_CONFIRMATION' AND i.posting_id IS NULL
  ORDER BY i.created_at,i.id COLLATE "C" LIMIT 65`;

type AbnormalRow = Record<string, unknown>;
type AdminFirstSubmit = Readonly<{ dispatch: "NEVER_DISPATCHED" | "DISPATCHED" | "UNKNOWN";
  blockedReason: "ORIGINAL_ORDER_NO_AMBIGUOUS" | "ABNORMAL_BASIS_REVIEW" | null; blockedAt: string | null;
  blockedAuditCount: number | null; trust: "LOCAL_AUDIT_AND_ATTEMPT" }>;
type AdminAbnormalResponsibility = Readonly<{
  confirmationId: string; reasonCode: "DUPLICATE_PAYMENT" | "LATE_PAYMENT" | "UNKNOWN_REASON";
  originalCents: string | null; currency: "CNY" | null; merchantIdentityId: string | null;
  liabilityRootId: string | null; liabilityEventId: string | null;
  intentIds: readonly string[]; allocatedCents: string | null; consumedCents: string | null;
  releasedCents: string | null; remainingCents: string | null;
  totalsComplete: boolean; state: "READY" | "PROCESSING" | "UNKNOWN" | "CONSUMED" | "RELEASED" | "REVIEW_REQUIRED" | "CONFLICT";
  firstSubmit: AdminFirstSubmit | null; reasonCodes: readonly string[];
}>;

function firstSubmit(row: AbnormalRow): AdminFirstSubmit | null {
  const attempts = row.submit_attempts, blocked = row.blocked_count;
  if (!Number.isSafeInteger(attempts) || !Number.isSafeInteger(blocked)) return null;
  const blockedAt = typeof row.blocked_at === "string" ? row.blocked_at : null;
  const reason = typeof row.blocked_reason === "string" && (FIRST_REASONS as readonly string[]).includes(row.blocked_reason)
    ? row.blocked_reason as AdminFirstSubmit["blockedReason"] : null;
  if ((attempts as number) > 0) return { dispatch: "DISPATCHED", blockedReason: null, blockedAt: null,
    blockedAuditCount: blocked as number, trust: "LOCAL_AUDIT_AND_ATTEMPT" };
  if (blockedAt) return { dispatch: "NEVER_DISPATCHED", blockedReason: reason, blockedAt,
    blockedAuditCount: blocked as number, trust: "LOCAL_AUDIT_AND_ATTEMPT" };
  return { dispatch: "NEVER_DISPATCHED", blockedReason: null, blockedAt: null,
    blockedAuditCount: blocked as number, trust: "LOCAL_AUDIT_AND_ATTEMPT" };
}

function abnormalInvalidReason(row: AbnormalRow, orderId: string): string | null {
  const amount = typeof row.amount_cents === "string" && POSITIVE.test(row.amount_cents) ? row.amount_cents : null;
  const confirmationAmount = typeof row.confirmation_amount === "string" && POSITIVE.test(row.confirmation_amount) ? row.confirmation_amount : null;
  if (row.confirmation_order_id !== orderId || row.confirmation_source !== "JOINPAY" || row.disposition !== "REVIEW_REQUIRED"
    || !["DUPLICATE_PAYMENT", "LATE_PAYMENT"].includes(row.reason_code as string)
    || row.confirmation_currency !== "CNY" || amount === null || confirmationAmount !== amount
    || row.currency !== "CNY" || row.merchant_identity_id !== row.merchant_scope_id
    || row.original_payment_trx_no !== row.provider_transaction_id || row.original_payment_order_no !== row.merchant_order_no
    || !ID.test(String(row.payment_confirmation_id ?? ""))) return "ABNORMAL_CONFIRMATION_MISMATCH";
  if (row.request_channel !== "JOINPAY" || row.request_evidence_level !== "JOINPAY_CANDIDATE"
    || row.request_merchant !== row.merchant_scope_id || row.request_order_no !== row.merchant_order_no
    || row.request_amount !== row.confirmation_amount || row.request_currency !== "CNY"
    || typeof row.formal_admission_ref !== "string" || row.formal_admission_ref.length < 1) return "ABNORMAL_REQUEST_MISMATCH";
  if (row.anchor_channel !== "JOINPAY" || row.anchor_evidence_level !== "JOINPAY_VERIFIED"
    || row.anchor_order !== row.confirmation_order_id || row.anchor_request !== row.joinpay_request_id
    || row.anchor_merchant !== row.merchant_scope_id || row.anchor_trx !== row.provider_transaction_id) return "ABNORMAL_ANCHOR_MISMATCH";
  if (row.root_kind !== "NATIVE_ABNORMAL_REFUND" || row.root_type !== "NATIVE" || row.root_system !== "zzsh"
    || row.root_entity !== "joinpay_abnormal_refund_liability" || row.root_source_id !== row.payment_confirmation_id
    || row.root_subject !== row.renter_user_id || row.root_role !== "RENTER" || row.root_policy !== null || row.root_basis !== null
    || row.root_digest !== row.responsibility_version_hash
    || row.event_kind !== "REFUND_LIABILITY_RECOGNIZED" || row.event_root !== row.liability_root_id
    || row.event_subject !== row.renter_user_id) return "ABNORMAL_LIABILITY_MISMATCH";
  if (row.liability_lines !== "2" || row.liability_line1 !== "1" || row.liability_line2 !== "1") return "ABNORMAL_LIABILITY_LINES_MISMATCH";
  if (row.state === "SUCCEEDED") {
    if (row.budget_disposition !== "CONSUMED" || row.evidence_terminal !== "SUCCEEDED"
      || row.provider_refund_trx_no !== row.evidence_trx || row.completed_at !== row.evidence_completed
      || row.terminal_root_kind !== "NATIVE_RENTAL_REFUND" || row.terminal_root_source !== row.intent_id
      || row.terminal_root_subject !== row.renter_user_id || row.terminal_event_kind !== "REFUND_PAID"
      || row.terminal_event_root !== row.terminal_root_id || row.terminal_lines !== "2" || row.terminal_good !== "2") return "ABNORMAL_TERMINAL_MISMATCH";
  } else if (row.state === "FAILED") {
    if (row.budget_disposition !== "RELEASED" || row.evidence_terminal !== "FAILED_NO_EXECUTION"
      || row.terminal_root_id !== null || row.terminal_event_id !== null || row.terminal_lines !== "0") return "ABNORMAL_RELEASE_MISMATCH";
  } else if (!["READY", "SUBMITTING", "UNKNOWN", "PROCESSING", "REVIEW_REQUIRED"].includes(row.state as string)
    || row.budget_disposition !== "ALLOCATED" || row.terminal_evidence_id !== null || row.terminal_root_id !== null
    || row.terminal_event_id !== null || row.terminal_lines !== "0" || row.evidence_terminal !== null) return "ABNORMAL_NON_TERMINAL_MISMATCH";
  if (typeof row.requires_review !== "boolean" || typeof row.refund_order_no !== "string" || !REFUND_NO.test(row.refund_order_no)) return "ABNORMAL_INTENT_MISMATCH";
  if (!Number.isSafeInteger(row.submit_attempts) || !Number.isSafeInteger(row.blocked_count)) return "FIRST_SUBMIT_FACTS_UNREADABLE";
  if (row.blocked_at !== null && (typeof row.blocked_at !== "string" || !Number.isFinite(Date.parse(row.blocked_at)))) return "FIRST_SUBMIT_BLOCK_TIME_UNREADABLE";
  if ((row.blocked_count as number) > 0 && row.blocked_at === null) return "FIRST_SUBMIT_BLOCK_TIME_MISSING";
  if (row.blocked_at !== null && (typeof row.blocked_reason !== "string" || !(FIRST_REASONS as readonly string[]).includes(row.blocked_reason))) return "FIRST_SUBMIT_BLOCK_REASON_UNKNOWN";
  return null;
}

function abnormalSummary(rows: AbnormalRow[], orderId: string): { error: string } | { intents: any[]; responsibilities: AdminAbnormalResponsibility[] } {
  if (rows.length > 64) return { error: "REFUND_BINDING_OR_READ_BOUND_EXCEEDED" as const };
  const intents: any[] = [];
  const byConfirmation = new Map<string, AbnormalRow[]>();
  for (const row of rows) {
    const confirmationId = typeof row.payment_confirmation_id === "string" && ID.test(row.payment_confirmation_id)
      ? row.payment_confirmation_id : "UNMATCHED_ABNORMAL_INTENT";
    byConfirmation.set(confirmationId, [...(byConfirmation.get(confirmationId) ?? []), row]);
  }
  const responsibilities: AdminAbnormalResponsibility[] = [];
  for (const [confirmationId, group] of byConfirmation) {
    const reasons = new Set<string>();
    let invalid = false;
    for (const row of group) {
      const reason = abnormalInvalidReason(row, orderId);
      if (reason) { reasons.add(reason); invalid = true; }
    }
    const first = group[0]!;
    const amount = typeof first.confirmation_amount === "string" && POSITIVE.test(first.confirmation_amount) ? first.confirmation_amount : null;
    const active = group.filter(row => row.state !== "FAILED");
    if (active.length > 1) { reasons.add("ABNORMAL_MULTIPLE_ACTIVE_INTENTS"); invalid = true; }
    let allocated = 0n, consumed = 0n, released = 0n, totalsComplete = !invalid && amount !== null;
    if (!invalid && amount !== null) {
      for (const row of group) {
        if (typeof row.amount_cents !== "string" || !POSITIVE.test(row.amount_cents)) { invalid = true; totalsComplete = false; reasons.add("ABNORMAL_INTENT_AMOUNT_INVALID"); break; }
        const cents = BigInt(row.amount_cents);
        if (row.state === "FAILED") released += cents;
        else { allocated += cents; if (row.state === "SUCCEEDED") consumed += cents; }
      }
      if (!invalid && allocated > BigInt(amount)) { invalid = true; totalsComplete = false; reasons.add("ABNORMAL_ALLOCATION_EXCEEDS_RESPONSIBILITY"); }
    }
    const latest = [...group].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at))
      || String(a.intent_id).localeCompare(String(b.intent_id))).at(-1)!;
    const firstSubmitValue = firstSubmit(latest);
    const anyReview = group.some(row => row.requires_review === true || row.state === "REVIEW_REQUIRED");
    const state: AdminAbnormalResponsibility["state"] = invalid ? "CONFLICT"
      : anyReview || (firstSubmitValue?.dispatch === "NEVER_DISPATCHED" && firstSubmitValue.blockedReason) ? "REVIEW_REQUIRED"
      : group.some(row => row.state === "UNKNOWN") ? "UNKNOWN"
      : group.some(row => row.state === "SUBMITTING" || row.state === "PROCESSING") ? "PROCESSING"
      : amount !== null && consumed === BigInt(amount) ? "CONSUMED"
      : allocated === 0n && released > 0n ? "RELEASED" : "READY";
    responsibilities.push({ confirmationId,
      reasonCode: ["DUPLICATE_PAYMENT", "LATE_PAYMENT"].includes(first.reason_code as string)
        ? first.reason_code as AdminAbnormalResponsibility["reasonCode"] : "UNKNOWN_REASON",
      originalCents: totalsComplete ? amount : null, currency: totalsComplete ? "CNY" : null,
      merchantIdentityId: totalsComplete && typeof first.merchant_scope_id === "string" ? first.merchant_scope_id : null,
      liabilityRootId: totalsComplete && typeof first.liability_root_id === "string" ? first.liability_root_id : null,
      liabilityEventId: totalsComplete && typeof first.liability_event_id === "string" ? first.liability_event_id : null,
      intentIds: group.map(row => typeof row.intent_id === "string" ? row.intent_id : "").filter(Boolean),
      allocatedCents: totalsComplete ? allocated.toString() : null, consumedCents: totalsComplete ? consumed.toString() : null,
      releasedCents: totalsComplete ? released.toString() : null,
      remainingCents: totalsComplete && amount !== null ? (BigInt(amount) - allocated).toString() : null,
      totalsComplete, state, firstSubmit: firstSubmitValue, reasonCodes: uniqueReasonCodes(reasons) });
    if (!invalid) for (const row of group) intents.push({ intentId: row.intent_id, refundOrderNo: row.refund_order_no,
      amount: { cents: row.amount_cents, currency: "CNY" as const }, localState: row.state, budgetDisposition: row.budget_disposition,
      requiresReview: row.requires_review, evidenceId: row.terminal_evidence_id ?? null, rootId: row.terminal_root_id ?? null,
      eventId: row.terminal_event_id ?? null, responsibilityCents: amount, merchantIdentityId: row.merchant_scope_id,
      basisKind: "REVIEW_CONFIRMATION" as const, paymentConfirmationId: confirmationId,
      liabilityRootId: row.liability_root_id, liabilityEventId: row.liability_event_id, firstSubmit: firstSubmit(row),
      productFamily: "JOINPAY" as const, providerRefundTrxNo: row.provider_refund_trx_no ?? null,
      safeTarget: "ORIGINAL_CHANNEL" as const, mayResubmit: false, maySubmit: false as const, bankArrival: "UNKNOWN" as const });
  }
  return { intents, responsibilities };
}
function uniqueReasonCodes(values: Iterable<string>): string[] { return [...new Set(values)]; }

/** Caller has already selected this exact order under order/game/object authorization. */
export async function readAdminOrderRefundSummary(c: PoolClient, input: { orderId: string; origin: 'NATIVE' | 'LEGACY'; financeReadable: boolean }) {
  const absent = (integration: 'FORBIDDEN' | 'NOT_APPLICABLE' | 'NOT_INTEGRATED' | 'UNAVAILABLE', reason: string) => ({
    contractVersion: 'admin-order-refund-summary.v1' as const, integration, intents: null, abnormalResponsibilities: null,
    bankArrival: 'UNKNOWN' as const, reasonCodes: [reason], limit: null as number | null, truncated: false, maySubmit: false as const,
    coverage: null as 'COMPLETE_WITHIN_LIMIT' | 'TRUNCATED' | null,
    budget: null as { allocatedCents: string; consumedCents: string; releasedCents: string } | null,
    responsibilityBudget: null as null | { originalCents: string | null; allocatedCents: string | null; consumedCents: string | null;
      releasedCents: string | null; remainingCents: string | null; totalsComplete: boolean; postingOriginalCents: string | null;
      abnormalOriginalCents: string | null },
  });
  if (!input.financeReadable) return absent('FORBIDDEN', 'FINANCE_PERMISSION_REQUIRED');
  if (input.origin !== 'NATIVE') return absent('NOT_APPLICABLE', 'LEGACY_REFUND_SOURCE_NOT_INTEGRATED');
  const ready = (await c.query(`SELECT to_regclass('zzsh_order.prestart_termination') IS NOT NULL
    AND has_table_privilege(current_user,to_regclass('zzsh_order.prestart_termination'),'SELECT') AS has_prestart,
    to_regclass('zzsh_order.channel_refund_intent') IS NOT NULL
    AND to_regclass('zzsh_order.joinpay_refund_attempt') IS NOT NULL
    AND to_regclass('zzsh_order.joinpay_refund_observation') IS NOT NULL
    AND to_regclass('zzsh_order.joinpay_refund_evidence') IS NOT NULL
    AND (SELECT count(*) FROM pg_attribute WHERE attrelid=to_regclass('zzsh_order.channel_refund_intent')
      AND attname=ANY($1::text[]) AND attnum>0 AND NOT attisdropped)=$2 AS ready`,
    [['id','refund_order_no','amount_cents','currency','state','budget_disposition','requires_review','terminal_evidence_id','terminal_root_id','terminal_event_id','posting_id','order_id','payment_source','renter_user_id','payment_confirmation_id','responsibility_version_hash','basis_kind','liability_root_id','liability_event_id','original_payment_trx_no','original_payment_order_no','merchant_identity_id','created_at','updated_at'],24])).rows[0];
  if (ready?.ready !== true) return absent('NOT_INTEGRATED', 'FORMAL_REFUND_SCHEMA_UNAVAILABLE');
  const rows = (await c.query(`SELECT i.id,i.refund_order_no,i.amount_cents::text AS amount_cents,i.currency,i.state,i.budget_disposition,
    i.requires_review,i.terminal_evidence_id,i.terminal_root_id,i.terminal_event_id,i.merchant_identity_id,i.payment_source,i.provider_refund_trx_no,
    i.basis_kind,i.payment_confirmation_id,i.liability_root_id,i.liability_event_id,
    p.renter_refund_cents::text AS responsibility_cents,
    (i.renter_user_id=o.renter_user_id AND p.order_id=i.order_id AND p.payment_confirmation_id=i.payment_confirmation_id
      AND p.version_hash=i.responsibility_version_hash) AS binding_matches
    FROM zzsh_order.channel_refund_intent i
    LEFT JOIN zzsh_order.settlement_posting p ON p.id=i.posting_id
    LEFT JOIN zzsh_order.rental_order o ON o.id=i.order_id
    WHERE i.order_id=$1 AND i.payment_source='JOINPAY' AND i.basis_kind='POSTING' AND i.posting_id IS NOT NULL
    ORDER BY i.id COLLATE "C" LIMIT 65`, [input.orderId])).rows;
  if (rows.length > 64) return { ...absent('UNAVAILABLE', 'REFUND_BINDING_OR_READ_BOUND_EXCEEDED'), limit: 64, truncated: true, coverage: 'TRUNCATED' as const };
  if (rows.some(r => r.binding_matches !== true)) return absent('UNAVAILABLE', 'REFUND_BINDING_OR_READ_BOUND_EXCEEDED');
  const abnormalRows = (await c.query<AbnormalRow>(ABNORMAL_ROWS_SQL, [input.orderId])).rows;
  const abnormal = abnormalSummary(abnormalRows, input.orderId);
  if ('error' in abnormal) return absent('UNAVAILABLE', abnormal.error);
  if (rows.length + abnormal.intents.length > 64) return { ...absent('UNAVAILABLE', 'REFUND_BINDING_OR_READ_BOUND_EXCEEDED'), limit: 64, truncated: true, coverage: 'TRUNCATED' as const };
  try {
    const postingRows = (await c.query<{ renter_refund_cents: string | null; currency: string }>(`SELECT p.renter_refund_cents::text AS renter_refund_cents,p.currency
    FROM zzsh_order.settlement_posting p WHERE p.order_id=$1 ORDER BY p.posted_at DESC,p.id COLLATE "C" DESC LIMIT 2`, [input.orderId])).rows;
  if (postingRows.length > 1) return absent('UNAVAILABLE', 'MULTIPLE_SETTLEMENT_POSTINGS');
  if (postingRows.some(row => row.currency !== 'CNY')) return absent('UNAVAILABLE', 'RESPONSIBILITY_CURRENCY_NOT_CNY');
  const normalIntents = rows.map(r => {
      const amountCents = exactCents(r.amount_cents);
      if (BigInt(amountCents) <= 0n || r.currency !== 'CNY' || typeof r.requires_review !== 'boolean'
        || typeof r.id !== 'string' || typeof r.refund_order_no !== 'string'
        || [r.terminal_evidence_id,r.terminal_root_id,r.terminal_event_id].some(v=>v!==null&&typeof v!=='string')) throw new Error('Invalid refund projection');
      const responsibilityCents = r.responsibility_cents == null ? null : exactCents(r.responsibility_cents);
      return { intentId: r.id as string, refundOrderNo: r.refund_order_no as string, amount: { cents: amountCents, currency: 'CNY' as const },
        localState: ['READY','SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED','SUCCEEDED','FAILED'].includes(r.state) ? r.state as string : 'UNKNOWN',
        budgetDisposition: ['ALLOCATED','CONSUMED','RELEASED'].includes(r.budget_disposition) ? r.budget_disposition as string : 'UNKNOWN',
        requiresReview: r.requires_review as boolean, evidenceId: r.terminal_evidence_id ?? null, rootId: r.terminal_root_id ?? null,
        eventId: r.terminal_event_id ?? null, responsibilityCents, merchantIdentityId: typeof r.merchant_identity_id === 'string' ? r.merchant_identity_id : null,
        basisKind: 'POSTING' as const, paymentConfirmationId: typeof r.payment_confirmation_id === 'string' ? r.payment_confirmation_id : null,
        liabilityRootId: null, liabilityEventId: null, firstSubmit: null,
        productFamily: r.payment_source === 'JOINPAY' ? 'JOINPAY' as const : null, providerRefundTrxNo: typeof r.provider_refund_trx_no === 'string' ? r.provider_refund_trx_no : null,
        safeTarget: 'ORIGINAL_CHANNEL' as const, mayResubmit: false, maySubmit: false as const, bankArrival: 'UNKNOWN' as const };
    });
    const sum = (disposition: string) => normalIntents.filter(intent => intent.budgetDisposition === disposition)
      .reduce((total, intent) => total + BigInt(intent.amount.cents), 0n);
    const normalActive = sum('ALLOCATED') + sum('CONSUMED'), normalAllocatedPartition = sum('ALLOCATED'),
      normalConsumed = sum('CONSUMED'), normalReleased = sum('RELEASED');
    const abnormalKnown = abnormal.responsibilities.every(r => r.totalsComplete && r.originalCents !== null
      && r.allocatedCents !== null && r.consumedCents !== null && r.releasedCents !== null);
    const abnormalOriginal = abnormalKnown ? abnormal.responsibilities.reduce((total, r) => total + BigInt(r.originalCents!), 0n) : null;
    const abnormalAllocated = abnormalKnown ? abnormal.responsibilities.reduce((total, r) => total + BigInt(r.allocatedCents!), 0n) : null;
    const abnormalConsumed = abnormalKnown ? abnormal.responsibilities.reduce((total, r) => total + BigInt(r.consumedCents!), 0n) : null;
    const abnormalReleased = abnormalKnown ? abnormal.responsibilities.reduce((total, r) => total + BigInt(r.releasedCents!), 0n) : null;
    const postingOriginal = postingRows[0]?.renter_refund_cents ?? null;
    const prestart=ready.has_prestart===true?await readPrestartFinanceProjection(c,input.orderId):null;
    const ps=prestart?.refund.totals;
    const psComplete=!prestart||prestart.refund.integration==='INTEGRATED'&&ps?.totalsComplete===true;
    const psAllocated=psComplete?BigInt(ps?.allocatedCents??'0'):null,psConsumed=psComplete?BigInt(ps?.consumedCents??'0'):null,
      psReleased=psComplete?BigInt(ps?.releasedCents??'0'):null;
    const prestartIntents=prestart?.refund.integration==='INTEGRATED'?(prestart.refund.intents??[]).filter(r=>r.intentId&&r.refundOrderNo&&r.amountCents).map(r=>({
      intentId:r.intentId!,refundOrderNo:r.refundOrderNo!,amount:{cents:r.amountCents!,currency:'CNY' as const},
      localState:r.state,budgetDisposition:r.budgetDisposition,requiresReview:r.requiresReview,merchantIdentityId:prestart.merchantIdentityId,
      basisKind:'PRESTART_TERMINATION' as const,paymentConfirmationId:prestart.paymentConfirmationId,liabilityRootId:prestart.liabilityRootId,
      liabilityEventId:prestart.liabilityEventId,firstSubmit:null,responsibilityCents:prestart.originalCents,
      evidenceId:r.terminalEvidenceId,rootId:r.terminalRootId,eventId:r.terminalEventId,
      productFamily:'JOINPAY' as const,providerRefundTrxNo:r.savedChannelEvidence?.channelRefundTrxNo??null,
      safeTarget:'ORIGINAL_CHANNEL' as const,mayResubmit:false,maySubmit:false as const,bankArrival:'UNKNOWN' as const
    })):[];
    const intents=[...normalIntents,...abnormal.intents,...prestartIntents];
    if(intents.length>64)return {...absent('UNAVAILABLE','REFUND_BINDING_OR_READ_BOUND_EXCEEDED'),limit:64,truncated:true,coverage:'TRUNCATED' as const};
    const originalCents = abnormalOriginal === null ? null
      : (postingOriginal === null ? 0n : BigInt(postingOriginal)) + abnormalOriginal + BigInt(prestart?.originalCents??'0');
    const responsibilityTotalsComplete = originalCents !== null && abnormalAllocated !== null
      && abnormalConsumed !== null && abnormalReleased !== null
      && psAllocated!==null && psConsumed!==null && psReleased!==null && originalCents >= normalActive + abnormalAllocated+psAllocated;
    return { contractVersion: 'admin-order-refund-summary.v1' as const, integration: 'INTEGRATED' as const, intents,
      abnormalResponsibilities: abnormal.responsibilities,...(prestart?{prestartTermination:prestart}:{}), limit: 64, truncated: false, maySubmit: false as const,
      coverage: 'COMPLETE_WITHIN_LIMIT' as const,
      budget: abnormalAllocated !== null && abnormalConsumed !== null && abnormalReleased !== null&&psAllocated!==null&&psConsumed!==null&&psReleased!==null ? {
        allocatedCents: (normalAllocatedPartition + abnormalAllocated - abnormalConsumed+psAllocated-psConsumed).toString(),
        consumedCents: (normalConsumed + abnormalConsumed+psConsumed).toString(), releasedCents: (normalReleased + abnormalReleased+psReleased).toString() } : null,
      responsibilityBudget: { originalCents: originalCents?.toString() ?? null,
        allocatedCents: abnormalAllocated === null||psAllocated===null ? null : (normalActive + abnormalAllocated+psAllocated).toString(),
        consumedCents: abnormalConsumed === null||psConsumed===null ? null : (normalConsumed + abnormalConsumed+psConsumed).toString(),
        releasedCents: abnormalReleased === null||psReleased===null ? null : (normalReleased + abnormalReleased+psReleased).toString(),
        remainingCents: responsibilityTotalsComplete && originalCents !== null && abnormalAllocated !== null
          ? (originalCents - normalActive - abnormalAllocated-psAllocated!).toString() : null,
        totalsComplete: responsibilityTotalsComplete, postingOriginalCents: postingOriginal,
        abnormalOriginalCents: abnormalOriginal?.toString() ?? null,...(prestart?{prestartOriginalCents:prestart.originalCents}:{}) },
      bankArrival: 'UNKNOWN' as const, reasonCodes: ['LOCAL_RECORDS_ONLY_TERMINAL_EVIDENCE_NOT_REVALIDATED',
        ...(abnormal.responsibilities.length > 0 ? ['ABNORMAL_REVIEW_CONFIRMATION_RESPONSIBILITY_PRESENT'] : []),
        ...abnormal.responsibilities.flatMap(r => r.reasonCodes)] };
  } catch { return absent('UNAVAILABLE', 'REFUND_RECORD_PROJECTION_INVALID'); }
}
