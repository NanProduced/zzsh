import type { FinanceFilters } from "./admin-finance-read";
import { escapeLike } from "../supply/catalog";
import { financeOrderSql } from "./admin-finance-order-read";

export type FinanceLoadScope = { filters?: FinanceFilters; documentRef?: string; subjectId?: string; page?: number; pageSize?: number; lookup?: { exact: boolean }; documentRefs?: string[]; orderRefs?: string[] };
export const FINANCE_LEDGER_BUCKET_SQL = `CASE WHEN r.account_code IN ('OWNER_AVAILABLE','WALLET_AVAILABLE') THEN 'AVAILABLE' WHEN r.account_code='WALLET_RESERVED' THEN 'RESERVED' WHEN r.account_code='GUARANTEE_HELD' THEN 'GUARANTEE_HELD' WHEN r.account_code='WALLET_PENDING_EARNINGS' THEN 'PENDING_EARNINGS' WHEN r.account_code='RENTER_REFUND_PAYABLE' THEN 'REFUND_PAYABLE' WHEN r.account_code LIKE 'PLATFORM_%' OR r.account_code='WITHDRAW_FEE' THEN 'PLATFORM' ELSE 'CLEARING' END`;
const historyBucket = `CASE WHEN r.observation_origin='LEGACY_GUARANTEE_HISTORY' THEN 'GUARANTEE_HELD' WHEN r.observation_origin='LEGACY_DUTY_ZERO' AND r.action='RENTER_REFUND' THEN 'REFUND_PAYABLE' WHEN r.source_entity='la_distribution_order' OR r.observation_origin='NATIVE_EARNING_ZERO' AND r.source_status='PENDING' THEN 'PENDING_EARNINGS' ELSE 'AVAILABLE' END`;
const ledgerKind = `CASE WHEN r.event_kind='OPENING' THEN 'OPENING' WHEN r.source_entity IN('withdrawal_intent','joinpay_withdrawal_intent') THEN 'WITHDRAWAL' WHEN r.source_kind='NATIVE_RENTAL_REFERRAL' OR r.source_kind='LEGACY_CONTINUATION_DUTY' AND r.beneficiary_role='COMMISSION' THEN 'DISTRIBUTION' WHEN r.source_kind='NATIVE_GUARANTEE' THEN 'GUARANTEE' WHEN r.source_kind='NATIVE_PRESTART_REFUND' OR r.account_code='RENTER_REFUND_PAYABLE' THEN 'REFUND' ELSE 'SETTLEMENT' END`;
const historyKind = `CASE WHEN r.observation_origin='LEGACY_GUARANTEE_HISTORY' THEN 'GUARANTEE' WHEN r.observation_origin='NATIVE_EARNING_ZERO' OR r.observation_origin='LEGACY_DUTY_ZERO' AND r.action='COMMISSION' THEN 'DISTRIBUTION' WHEN r.observation_origin='LEGACY_DUTY_ZERO' THEN CASE WHEN r.action='RENTER_REFUND' THEN 'REFUND' ELSE 'SETTLEMENT' END WHEN r.source_entity='la_log_earnings' THEN CASE WHEN r.extra_evidence->'snapshot'->>'legacyChangeType' IN('1002','1003','1004','1005') THEN 'WITHDRAWAL' ELSE 'EARNINGS' END WHEN r.source_entity='la_distribution_order' THEN 'DISTRIBUTION' ELSE 'WITHDRAWAL' END`;
const historyDocument=`CASE WHEN r.observation_origin='LEGACY_GUARANTEE_HISTORY' THEN 'GUARANTEE_SOURCE:'||r.id WHEN r.observation_origin='NATIVE_EARNING_ZERO' THEN 'DISTRIBUTION:'||r.source_id WHEN r.observation_origin='LEGACY_DUTY_ZERO' THEN 'LEGACY_DUTY:'||r.source_id ELSE (CASE WHEN r.source_entity='la_log_earnings' THEN 'HISTORY_EARNINGS:' WHEN r.source_entity='la_distribution_order' THEN 'HISTORY_DISTRIBUTION:' ELSE 'HISTORY_WITHDRAWAL:' END)||r.id END`;
const ledgerSubject = `COALESCE(r.subject_id,CASE WHEN (${FINANCE_LEDGER_BUCKET_SQL})='PLATFORM' THEN 'PLATFORM' ELSE 'SYSTEM' END)`;
const ledgerDocument = `CASE WHEN r.event_kind='OPENING' THEN 'OPENING:'||r.basis_id WHEN r.source_entity='withdrawal_intent' THEN 'WITHDRAWAL:'||r.source_id WHEN r.source_entity='joinpay_withdrawal_intent' THEN 'JOINPAY_WITHDRAWAL:'||r.source_id WHEN r.source_kind='NATIVE_RENTAL_REFERRAL' THEN 'DISTRIBUTION:'||r.economic_root_id WHEN r.source_kind='LEGACY_CONTINUATION_DUTY' THEN 'LEGACY_DUTY:'||r.source_id WHEN r.source_entity='owner_guarantee_payment' THEN 'GUARANTEE_PAYMENT:'||r.source_id WHEN r.source_entity='owner_guarantee_refund' THEN 'GUARANTEE_REFUND:'||r.source_id WHEN r.order_id IS NOT NULL THEN 'ORDER:'||r.order_id ELSE 'POSTING:'||COALESCE(r.posting_id,r.id) END`;

/** The same scope is applied in SQL before the matched-result ceiling. Values never become SQL. */
export function scopedFinanceSql(source: string, family: "ledger" | "history", scope: FinanceLoadScope, limit: number | null, withdrawalsReady: boolean, joinpayReady = false) {
  const values: unknown[] = [], conditions: string[] = [], bind = (value: unknown) => `$${values.push(value)}`;
  const bucket = family === "ledger" ? FINANCE_LEDGER_BUCKET_SQL : historyBucket;
  const kind = family === "ledger" ? ledgerKind : historyKind;
  const subject = family === "ledger" ? ledgerSubject : "r.subject_id";
  const document = family === "ledger" ? ledgerDocument : historyDocument;
  const number = family === "ledger" ? "COALESCE(r.display_no,CASE WHEN r.event_kind='OPENING' THEN r.basis_id ELSE r.source_id END,r.posting_id,r.id)" : "COALESCE(CASE WHEN r.source_entity='la_log_earnings' THEN NULLIF(r.extra_evidence->'snapshot'->>'legacyLogNumber','') END,r.reference_no,r.source_id)";
  const state = family === "history" ? "CASE WHEN r.observation_origin IN('NATIVE_EARNING_ZERO','LEGACY_DUTY_ZERO') THEN r.source_status ELSE 'HISTORICAL_OBSERVED' END" : `CASE${withdrawalsReady ? " WHEN r.source_entity='withdrawal_intent' AND i.id IS NOT NULL THEN i.state" : ""}${joinpayReady ? " WHEN r.source_entity='joinpay_withdrawal_intent' AND j.id IS NOT NULL THEN j.state" : ""} WHEN r.source_kind='NATIVE_RENTAL_REFERRAL' THEN COALESCE(r.earning_state,'UNKNOWN') WHEN r.source_kind='NATIVE_PRESTART_REFUND' OR r.account_code='RENTER_REFUND_PAYABLE' THEN 'REFUND_PAYABLE_RECORDED' ELSE 'POSTED' END`;
  if (scope.documentRefs) conditions.push(`(${document})=ANY(${bind(scope.documentRefs)}::text[])`);
  if (scope.documentRef) conditions.push(`(${document})=${bind(scope.documentRef)}`);
  else if (scope.subjectId) conditions.push(`(${subject})=${bind(scope.subjectId)}`);
  if (!scope.documentRef && scope.filters) {
    const f = scope.filters;
    if (f.scope !== "ALL") conditions.push(`(${subject})=${bind(f.scope)}`);
    if (f.bucket !== "ALL") conditions.push(`(${bucket})=${bind(f.bucket)}`);
    if (f.kind !== "ALL") conditions.push(`(${kind})=${bind(f.kind)}`);
    if (f.state !== "ALL") conditions.push(`(${state})=${bind(f.state)}`);
    if (f.period) { const start = bind(`${f.from}T00:00:00+08:00`), end = bind(new Date(Date.parse(`${f.to}T00:00:00+08:00`) + 86400_000).toISOString()); conditions.push(`(r.at IS NULL OR (r.at::timestamptz>=${start}::timestamptz AND r.at::timestamptz<${end}::timestamptz))`); }
    if (f.q.startsWith("ORDER_LINK:")) conditions.push(family==='ledger'?`r.order_id=${bind(f.q.slice(11))}`:'FALSE');
    else if (f.q) {
      const masked = `CASE WHEN r.subject_name ~ '^1[3-9][0-9]{9}$' THEN left(r.subject_name,3)||'****'||right(r.subject_name,4) ELSE COALESCE(r.subject_name,${subject}) END`;
      const name = family === "ledger" ? `CASE WHEN r.subject_id IS NULL THEN CASE WHEN (${bucket})='PLATFORM' THEN '骞冲彴' ELSE '瀵圭収绉戠洰' END ELSE ${masked} END` : masked;
      const fields = [subject, name, document, number, family === "ledger" ? "COALESCE(r.source_id,r.posting_id,r.id)" : "r.source_id", `'${family}:'||r.id`,...(family==='history'?['r.reference_no']:[])];
      const exact = scope.lookup?.exact, p = bind(exact ? f.q : `%${escapeLike(f.q.toLocaleLowerCase("zh-CN"))}%`);
      conditions.push(`(${fields.map(field => exact ? `(${field})=${p}` : `lower(${field}) LIKE ${p} ESCAPE '\\'`).join(" OR ")})`);
    }
  }
  const base = source.replace(/\s+ORDER BY [lo]\.id COLLATE "C" LIMIT \$1\s*$/, "");
  const join = family === "ledger" ? `${withdrawalsReady ? " LEFT JOIN zzsh_order.withdrawal_intent i ON i.id=r.source_id AND r.source_entity='withdrawal_intent'" : ""}${joinpayReady ? " LEFT JOIN zzsh_order.joinpay_withdrawal_intent j ON j.id=r.source_id AND r.source_entity='joinpay_withdrawal_intent'" : ""}` : "";
  return { text: `WITH finance_scoped_rows AS (${base}) SELECT r.* FROM finance_scoped_rows r${join} WHERE ${conditions.length ? conditions.join(" AND ") : "TRUE"}${limit === null ? "" : ` ORDER BY r.id COLLATE "C" LIMIT ${bind(limit)}`}`, values };
}

/** List, period and export stay on this domain. Document and subject reads do not. */
export const FINANCE_GLOBAL_VERSION_DOMAIN = "admin-finance-proof.r2";
export const FINANCE_DOCUMENT_VERSION_DOMAIN = "admin-finance-proof.r3.document";
export const FINANCE_SUBJECT_VERSION_DOMAIN = "admin-finance-proof.r3.subject";
export type FinanceVersionReady = { withdrawals?: boolean; native_orders?: boolean; legacy_orders?: boolean; native_distribution?: boolean; earning_basis?: boolean; earning_transitions?: boolean; history_coverage?: boolean; legacy_duty_finance?: boolean; guarantee_history?: boolean; payment_requests?: boolean; refund_intents?: boolean; refund_read_dependencies?: boolean; joinpay_withdrawals?: boolean };
export type FinanceVersionScope = { mode: "document"; documentRef: string } | { mode: "subject"; subjectId: string };
const VERSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,200}$/;

function versionRelations(ready: FinanceVersionReady): { name: string; sql: string }[] {
  const relations: { name: string; sql: string }[] = [
    { name: "marker", sql: `SELECT '${FINANCE_GLOBAL_VERSION_DOMAIN}' AS id` },
    { name: "user", sql: `SELECT id,name FROM zzsh_auth_user."user"` },
    { name: "ledger", sql: `SELECT id,account_code,counterparty_user_id,credit_cents::text,debit_cents::text,posting_id,finance_event_id,details,created_at FROM zzsh_order.settlement_ledger_entry` },
    { name: "observation", sql: `SELECT id,user_id,basis_id,source_system,source_entity,source_id,source_digest,source_canonical,snapshot,included_in_opening,source_event_at,imported_at FROM zzsh_order.personal_finance_observation` },
    { name: "wallet_revision", sql: `SELECT user_id AS id,ledger_revision::text,read_revision::text FROM zzsh_order.wallet_revision` },
    { name: "wallet_coverage", sql: `SELECT user_id AS id,origin,basis_id,opening_event_id,coverage_version::text FROM zzsh_order.wallet_coverage` },
    { name: "opening", sql: `SELECT id,user_id,source_kind,source_system,source_entity,source_id,source_digest,identity_source_digest,covered_set_digest,source_cutoff,available_cents::text,covered_count,native_origin_canonical FROM zzsh_order.finance_opening_basis` },
    { name: "root", sql: `SELECT id,basis_id,subject_user_id,source_kind,source_type,source_system,source_entity,source_id,beneficiary_role,source_digest,policy_version FROM zzsh_order.finance_economic_root` },
    { name: "event", sql: `SELECT id,economic_root_id,kind,subject_user_id,created_at FROM zzsh_order.finance_event` },
    { name: "posting", sql: `SELECT id,order_id,payment_confirmation_id,settlement_version_id,version_hash,early,manual_reason,captured_cents::text,owner_net_cents::text,renter_refund_cents::text,platform_contribution_cents::text,compensation_fee_cents::text,refund_due_at,posted_at FROM zzsh_order.settlement_posting` },
  ];
  if (ready.native_orders) relations.push({ name: "native_order", sql: `SELECT id,revision::text,status FROM zzsh_order.rental_order` });
  if (ready.legacy_orders) relations.push({ name: "legacy_order", sql: `SELECT id,source_system,source_entity,legacy_id,source_digest,binding_digest,original_order_no,owner_user_id,renter_user_id,account_id,game_id,source_snapshot->>'return_order_money' AS historical_refund FROM zzsh_order.legacy_order_read_snapshot` });
  if (ready.native_distribution) {
    relations.push({ name: "earning", sql: `SELECT id,economic_root_id,version::text,state,funds_disposition,recovery_required_cents::text,canonical_seed,seed_digest,basis_digest,posting_digest,economic_key,posting_id,payment_confirmation_id,beneficiary_user_id,beneficiary_role,amount_cents::text,order_id,created_at,due_at FROM zzsh_order.rental_referral_earning` });
    if (ready.earning_basis !== false) relations.push({ name: "basis", sql: `SELECT id,order_id,payment_confirmation_id,canonical_basis,basis_digest FROM zzsh_order.payment_distribution_basis` });
    if (ready.earning_transitions !== false) relations.push({ name: "transition", sql: `SELECT id,earning_id,action,expected_version::text,result_version::text,finance_event_id,source_digest FROM zzsh_order.rental_referral_transition` });
  }
  if (ready.history_coverage) relations.push({ name: "history_coverage", sql: `SELECT id,body_digest FROM zzsh_order.personal_finance_observation_coverage` });
  if (ready.legacy_duty_finance) relations.push(
    { name: "duty_fact", sql: `SELECT duty_id AS id,order_id,kind,subject_user_id,root_id,event_id,zero_finalization,facts_canonical,facts_digest,ref_type,ref_id,created_at FROM zzsh_order.legacy_duty_finance_fact` },
    { name: "duty", sql: `SELECT id,order_id,kind,source_record_id,counterparty_user_id,amount_cents::text,currency,source,source_status,continuation_version_id,admission_id,revision::text,status,maturity_at,settled_by,settled_ref_type,settled_ref_id,settled_ref_digest FROM zzsh_order.legacy_order_duty` });
  if (ready.guarantee_history) relations.push(
    { name: "guarantee_coverage", sql: `SELECT id,body_digest FROM zzsh_order.legacy_owner_guarantee_coverage` },
    { name: "guarantee_observation", sql: `SELECT id,source_digest,source_cutoff,imported_at FROM zzsh_order.legacy_owner_guarantee_observation` });
  if (ready.withdrawals) relations.push(
    { name: "withdrawal", sql: `SELECT id,operation_version::text,state,funds_disposition,last_provider_fact_id FROM zzsh_order.withdrawal_intent` },
    { name: "withdrawal_fact", sql: `SELECT id,evidence_digest FROM zzsh_order.withdrawal_provider_fact` },
    { name: "payout_operation", sql: `SELECT id,final_evidence_digest FROM zzsh_order.controlled_payout_operation` });
  if (ready.payment_requests) relations.push({ name: "payment_request", sql: `SELECT id,order_id,channel,merchant_identity_id,platform_order_no,channel_order_no,state,amount_cents::text,currency,evidence_level,updated_at FROM zzsh_order.payment_request` });
  if (ready.refund_intents) {
    relations.push({ name: "refund_intent", sql: `SELECT i.id,i.order_id,i.renter_user_id,i.posting_id,i.payment_confirmation_id,i.payment_source,i.state,i.budget_disposition,to_jsonb(i) AS doc FROM zzsh_order.channel_refund_intent i` });
    if (ready.refund_read_dependencies === true) {
      relations.push(
        { name: "refund_confirmation", sql: `SELECT id,order_id,source,disposition,reason_code,currency,amount_cents::text,merchant_scope_id,provider_transaction_id,merchant_order_no,joinpay_request_id,joinpay_evidence_id,joinpay_anchor_id FROM zzsh_order.payment_confirmation WHERE source='JOINPAY'` },
        { name: "refund_attempt", sql: `SELECT a.id,a.intent_id,a.operation,a.lease_version::text,a.created_at FROM zzsh_order.joinpay_refund_attempt a JOIN zzsh_order.channel_refund_intent i ON i.id=a.intent_id WHERE i.posting_id IS NULL` },
        { name: "refund_block", sql: `SELECT a.id,a.action,a.object_id,a.occurred_at,a.details FROM zzsh_iam.audit_event a WHERE a.action='order.refund.abnormal.first_submit.blocked'` });
    }
  }
  if (ready.joinpay_withdrawals) relations.push({ name: "joinpay_withdrawal", sql: `SELECT id,user_id,merchant_identity_id,merchant_order_no,platform_serial_no,state,funds_disposition,gross_cents::text,net_cents::text,fee_cents::text,provider_fee_cents::text,operation_version::text,destination_id,destination_revision FROM zzsh_order.joinpay_withdrawal_intent` });
  return relations;
}
function versionDigest(relations: string[]): string {
  return `SELECT md5(concat_ws('|',${relations.map(relation => `(SELECT md5(COALESCE(string_agg(md5(to_jsonb(v)::text),'' ORDER BY v.id COLLATE "C"),'')) FROM (${relation}) v)`).join(",")})) AS finance_version`;
}
/** A DB-side digest, not a second ledger/version store. New rows outside a page also invalidate it. */
export function financeVersionSql(ready: FinanceVersionReady): string {
  return versionDigest(versionRelations(ready).map(relation => relation.sql));
}
const orderPostings = `SELECT id FROM zzsh_order.settlement_posting WHERE order_id=$1`;
const orderEvents = `SELECT finance_event_id FROM zzsh_order.settlement_ledger_entry WHERE posting_id IN (${orderPostings})`;
/** Exact rows for one document or subject. Null keeps the global digest; list/period/export always do. */
export function financeScopedVersionSql(ready: FinanceVersionReady, scope: FinanceVersionScope): { text: string; values: string[] } | null {
  const parsed = scope.mode === "subject" ? null : /^([A-Z][A-Z0-9_]*):([A-Za-z0-9][A-Za-z0-9._:-]{0,200})$/.exec(scope.documentRef);
  const kind = scope.mode === "subject" ? "SUBJECT" : parsed?.[1];
  const id = scope.mode === "subject" ? scope.subjectId : parsed?.[2];
  if (!kind || !id || !VERSION_ID.test(id)) return null;
  const none = "1=0";
  const orderRefundIntents = `SELECT id FROM zzsh_order.channel_refund_intent WHERE order_id=$1`;
  const relatedRefundIntents = kind === "REFUND_INTENT"
    ? "SELECT id FROM zzsh_order.channel_refund_intent WHERE id=$1"
    : kind === "PAYMENT_REQUEST"
      ? "SELECT id FROM zzsh_order.channel_refund_intent WHERE order_id IN (SELECT order_id FROM zzsh_order.payment_request WHERE id=$1)"
      : orderRefundIntents;
  const relatedRefundConfirmations = `SELECT payment_confirmation_id FROM zzsh_order.channel_refund_intent WHERE id IN (${relatedRefundIntents}) AND payment_confirmation_id IS NOT NULL`;
  const relatedRefundRoots = `SELECT id FROM zzsh_order.finance_economic_root WHERE (source_kind='NATIVE_ABNORMAL_REFUND' AND source_id IN (${relatedRefundConfirmations})) OR (source_kind='NATIVE_RENTAL_REFUND' AND source_id IN (${relatedRefundIntents}))`;
  const relatedRefundEvents = `SELECT id FROM zzsh_order.finance_event WHERE economic_root_id IN (${relatedRefundRoots})`;
  const abnormalRootPart = ready.refund_intents === true ? ` OR id IN (${relatedRefundRoots})` : "";
  const abnormalEventPart = ready.refund_intents === true ? ` OR id IN (${relatedRefundEvents})` : "";
  const abnormalLedgerPart = ready.refund_intents === true ? ` OR finance_event_id IN (${relatedRefundEvents})` : "";
  const orderLedger = `posting_id IN (${orderPostings})${ready.native_distribution ? " OR finance_event_id IN (SELECT e.id FROM zzsh_order.finance_event e JOIN zzsh_order.rental_referral_earning g ON g.economic_root_id=e.economic_root_id WHERE g.order_id=$1)" : ""}${abnormalLedgerPart}`;
  const orderUsers = `id IN (SELECT owner_user_id FROM zzsh_order.rental_order WHERE id=$1 UNION SELECT renter_user_id FROM zzsh_order.rental_order WHERE id=$1 UNION SELECT counterparty_user_id FROM zzsh_order.settlement_ledger_entry WHERE posting_id IN (${orderPostings})${ready.legacy_orders ? " UNION SELECT owner_user_id FROM zzsh_order.legacy_order_read_snapshot WHERE id=$1 UNION SELECT renter_user_id FROM zzsh_order.legacy_order_read_snapshot WHERE id=$1" : ""})`;
  const subjectOrders = `SELECT id FROM zzsh_order.rental_order WHERE owner_user_id=$1 OR renter_user_id=$1`;
  let clause: Record<string, string> | null = null;
  if (kind === "ORDER" && ready.native_orders) clause = {
    user: orderUsers, ledger: orderLedger, observation: none, wallet_revision: none, wallet_coverage: none, opening: none,
    root: `id IN (SELECT e.economic_root_id FROM zzsh_order.finance_event e WHERE e.id IN (${orderEvents}))${ready.native_distribution ? " OR id IN (SELECT economic_root_id FROM zzsh_order.rental_referral_earning WHERE order_id=$1)" : ""}${abnormalRootPart}`,
    event: `id IN (${orderEvents})${ready.native_distribution ? " OR economic_root_id IN (SELECT economic_root_id FROM zzsh_order.rental_referral_earning WHERE order_id=$1)" : ""}${abnormalEventPart}`,
    posting: "order_id=$1", native_order: "id=$1", legacy_order: "id=$1", earning: "order_id=$1", basis: "order_id=$1",
    transition: "earning_id IN (SELECT id FROM zzsh_order.rental_referral_earning WHERE order_id=$1)", history_coverage: none,
    duty_fact: "order_id=$1", duty: "order_id=$1", guarantee_coverage: none, guarantee_observation: none, withdrawal: none, withdrawal_fact: none, payout_operation: none,
    payment_request: "order_id=$1", refund_intent: "order_id=$1", refund_confirmation: "order_id=$1",
    refund_attempt: "intent_id IN (" + orderRefundIntents + ")", refund_block: "object_id IN (" + orderRefundIntents + ")", joinpay_withdrawal: none,
  };
  else if (kind === "SUBJECT") clause = {
    user: "id=$1", ledger: "counterparty_user_id=$1 OR finance_event_id IN (SELECT id FROM zzsh_order.finance_event WHERE subject_user_id=$1)",
    observation: "user_id=$1", wallet_revision: "user_id=$1", wallet_coverage: "user_id=$1", opening: "user_id=$1",
    root: "subject_user_id=$1", event: "subject_user_id=$1", posting: "id IN (SELECT posting_id FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1)",
    native_order: "owner_user_id=$1 OR renter_user_id=$1", legacy_order: "owner_user_id=$1 OR renter_user_id=$1", earning: "beneficiary_user_id=$1",
    basis: `order_id IN (SELECT order_id FROM zzsh_order.rental_referral_earning WHERE beneficiary_user_id=$1)`,
    transition: "earning_id IN (SELECT id FROM zzsh_order.rental_referral_earning WHERE beneficiary_user_id=$1)", history_coverage: none,
    duty_fact: "subject_user_id=$1", duty: "counterparty_user_id=$1", guarantee_coverage: none, guarantee_observation: "user_id=$1",
    withdrawal: "user_id=$1", withdrawal_fact: "id IN (SELECT last_provider_fact_id FROM zzsh_order.withdrawal_intent WHERE user_id=$1)",
    payout_operation: "intent_id IN (SELECT id FROM zzsh_order.withdrawal_intent WHERE user_id=$1)",
    payment_request: ready.native_orders ? `order_id IN (${subjectOrders})` : none, refund_intent: "renter_user_id=$1",
    refund_confirmation: ready.native_orders ? `order_id IN (${subjectOrders})`
      : "id IN (SELECT payment_confirmation_id FROM zzsh_order.channel_refund_intent WHERE renter_user_id=$1)",
    refund_attempt: "intent_id IN (SELECT id FROM zzsh_order.channel_refund_intent WHERE renter_user_id=$1)",
    refund_block: "object_id IN (SELECT id FROM zzsh_order.channel_refund_intent WHERE renter_user_id=$1)", joinpay_withdrawal: "user_id=$1",
  };
  else if (kind === "JOINPAY_WITHDRAWAL" && ready.joinpay_withdrawals) clause = {
    user: "id IN (SELECT user_id FROM zzsh_order.joinpay_withdrawal_intent WHERE id=$1)",
    ledger: "finance_event_id IN (SELECT e.id FROM zzsh_order.finance_event e JOIN zzsh_order.finance_economic_root r ON r.id=e.economic_root_id WHERE r.source_id=$1 AND r.source_entity='joinpay_withdrawal_intent')",
    observation: none, wallet_revision: "user_id IN (SELECT user_id FROM zzsh_order.joinpay_withdrawal_intent WHERE id=$1)", wallet_coverage: "user_id IN (SELECT user_id FROM zzsh_order.joinpay_withdrawal_intent WHERE id=$1)",
    opening: "user_id IN (SELECT user_id FROM zzsh_order.joinpay_withdrawal_intent WHERE id=$1)", root: "source_id=$1 AND source_entity='joinpay_withdrawal_intent'",
    event: "economic_root_id IN (SELECT id FROM zzsh_order.finance_economic_root WHERE source_id=$1 AND source_entity='joinpay_withdrawal_intent')", posting: none, native_order: none, legacy_order: none,
    earning: none, basis: none, transition: none, history_coverage: none, duty_fact: none, duty: none, guarantee_coverage: none, guarantee_observation: none,
    withdrawal: none, withdrawal_fact: none, payout_operation: none, payment_request: none, refund_intent: none,
    refund_confirmation: none, refund_attempt: none, refund_block: none, joinpay_withdrawal: "id=$1",
  };
  else if (kind === "PAYMENT_REQUEST" && ready.payment_requests) clause = {
    user: `id IN (SELECT owner_user_id FROM zzsh_order.rental_order WHERE id IN (SELECT order_id FROM zzsh_order.payment_request WHERE id=$1) UNION SELECT renter_user_id FROM zzsh_order.rental_order WHERE id IN (SELECT order_id FROM zzsh_order.payment_request WHERE id=$1))`,
    ledger: `posting_id IN (SELECT id FROM zzsh_order.settlement_posting WHERE order_id IN (SELECT order_id FROM zzsh_order.payment_request WHERE id=$1))${abnormalLedgerPart}`,
    observation: none, wallet_revision: none, wallet_coverage: none, opening: none, root: ready.refund_intents ? `id IN (${relatedRefundRoots})` : none, event: ready.refund_intents ? `id IN (${relatedRefundEvents})` : none,
    posting: "order_id IN (SELECT order_id FROM zzsh_order.payment_request WHERE id=$1)", native_order: "id IN (SELECT order_id FROM zzsh_order.payment_request WHERE id=$1)", legacy_order: none,
    earning: none, basis: none, transition: none, history_coverage: none, duty_fact: none, duty: none, guarantee_coverage: none, guarantee_observation: none,
    withdrawal: none, withdrawal_fact: none, payout_operation: none, payment_request: "id=$1",
    refund_intent: "order_id IN (SELECT order_id FROM zzsh_order.payment_request WHERE id=$1)",
    refund_confirmation: "order_id IN (SELECT order_id FROM zzsh_order.payment_request WHERE id=$1)",
    refund_attempt: "intent_id IN (SELECT id FROM zzsh_order.channel_refund_intent WHERE order_id IN (SELECT order_id FROM zzsh_order.payment_request WHERE id=$1))",
    refund_block: "object_id IN (SELECT id FROM zzsh_order.channel_refund_intent WHERE order_id IN (SELECT order_id FROM zzsh_order.payment_request WHERE id=$1))",
    joinpay_withdrawal: none,
  };
  else if (kind === "REFUND_INTENT" && ready.refund_intents) clause = {
    user: "id IN (SELECT renter_user_id FROM zzsh_order.channel_refund_intent WHERE id=$1)",
    ledger: `posting_id IN (SELECT posting_id FROM zzsh_order.channel_refund_intent WHERE id=$1)${abnormalLedgerPart}`, observation: none, wallet_revision: none, wallet_coverage: none, opening: none, root: `id IN (${relatedRefundRoots})`, event: `id IN (${relatedRefundEvents})`,
    posting: "id IN (SELECT posting_id FROM zzsh_order.channel_refund_intent WHERE id=$1)", native_order: "id IN (SELECT order_id FROM zzsh_order.channel_refund_intent WHERE id=$1)", legacy_order: none,
    earning: none, basis: none, transition: none, history_coverage: none, duty_fact: none, duty: none, guarantee_coverage: none, guarantee_observation: none,
    withdrawal: none, withdrawal_fact: none, payout_operation: none,
    payment_request: "order_id IN (SELECT order_id FROM zzsh_order.channel_refund_intent WHERE id=$1)", refund_intent: "id=$1",
    refund_confirmation: "id IN (SELECT payment_confirmation_id FROM zzsh_order.channel_refund_intent WHERE id=$1)",
    refund_attempt: "intent_id=$1", refund_block: "object_id=$1", joinpay_withdrawal: none,
  };
  // Legacy history can be admitted by a later opening; keep its complete global proof.
  if (!clause) return null;
  const selected: string[] = [];
  for (const relation of versionRelations(ready)) {
    if (relation.name === "marker") {
      selected.push(`SELECT '${scope.mode === "subject" ? FINANCE_SUBJECT_VERSION_DOMAIN : FINANCE_DOCUMENT_VERSION_DOMAIN + ":" + kind}:' || $1 AS id`);
      continue;
    }
    const where = clause[relation.name];
    if (!where) return null;
    selected.push(/\bWHERE\b/.test(relation.sql)
      ? `SELECT * FROM (${relation.sql}) rel WHERE ${where}`
      : `${relation.sql} WHERE ${where}`);
  }
  return { text: versionDigest(selected), values: [id] };
}

/** Exact merchant number, not a prefix and not the first array element. Each binding stays its own document. */
function exactFinanceSourceKeys(ready: FinanceVersionReady, scope: FinanceLoadScope, bind: (value: unknown) => string): string[] {
  const q = scope.filters?.q;
  if (!q || q.startsWith("ORDER_LINK:") || scope.documentRef) return [];
  if ((scope.filters?.state ?? "ALL") !== "ALL" || (scope.filters?.bucket ?? "ALL") !== "ALL") return [];
  const kind = scope.filters?.kind ?? "ALL";
  const wantsPayment = !!ready.payment_requests && kind === "ALL", wantsRefund = !!ready.refund_intents && (kind === "ALL" || kind === "REFUND"), wantsWithdrawal = !!ready.joinpay_withdrawals && (kind === "ALL" || kind === "WITHDRAWAL");
  if (!wantsPayment && !wantsRefund && !wantsWithdrawal) return [];
  const number = bind(q);
  const subject = scope.subjectId ?? (scope.filters?.scope && scope.filters.scope !== "ALL" ? scope.filters.scope : null);
  const subjectParam = subject ? bind(subject) : null;
  const party = (orderColumn: string) => subjectParam && ready.native_orders ? ` AND EXISTS (SELECT 1 FROM zzsh_order.rental_order o WHERE o.id=${orderColumn} AND (o.owner_user_id=${subjectParam} OR o.renter_user_id=${subjectParam}))` : subjectParam ? " AND 1=0" : "";
  const from = scope.filters?.period ? bind(scope.filters.from + "T00:00:00+08:00") : null;
  const until = scope.filters?.period ? bind(new Date(Date.parse(scope.filters.to + "T00:00:00+08:00") + 86400_000).toISOString()) : null;
  const during = (column: string) => from && until ? ` AND ${column}>=${from}::timestamptz AND ${column}<${until}::timestamptz` : "";
  const utcAt = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  const keys: string[] = [];
  if (wantsPayment) keys.push(`SELECT 'payment:'||p.id AS id,'PAYMENT_REQUEST:'||p.id AS ref,${utcAt("p.created_at")} AS at,2 AS priority FROM zzsh_order.payment_request p WHERE (p.channel_order_no=${number} OR p.platform_order_no=${number})${party("p.order_id")}${during("p.created_at")}`);
  if (wantsRefund) keys.push(`SELECT 'refund:'||i.id,'REFUND_INTENT:'||i.id,${utcAt("i.created_at")},2 FROM zzsh_order.channel_refund_intent i WHERE (i.refund_order_no=${number} OR i.provider_refund_trx_no=${number} OR i.original_payment_order_no=${number})${subjectParam ? ` AND i.renter_user_id=${subjectParam}` : ""}${during("i.created_at")}`);
  if (wantsWithdrawal) keys.push(`SELECT 'joinpay:'||w.id,'JOINPAY_WITHDRAWAL:'||w.id,${utcAt("w.accepted_at")},2 FROM zzsh_order.joinpay_withdrawal_intent w WHERE (w.merchant_order_no=${number} OR w.platform_serial_no=${number})${subjectParam ? ` AND w.user_id=${subjectParam}` : ""}${during("w.accepted_at")}`);
  return keys;
}
/** Select document keys before loading payloads; ledger documents override their order-only counterpart. */
export function financeLookupPageSql(ledger: string, history: string, ready: FinanceVersionReady, scope: FinanceLoadScope) {
  const values: unknown[] = [], include = (query: {text: string; values: unknown[]}) => {
    const offset = values.length; values.push(...query.values);
    return query.text.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) + offset}`);
  }, bind = (value: unknown) => `$${values.push(value)}`;
  const ledgerSql = include(scopedFinanceSql(ledger, "ledger", scope, null, !!ready.withdrawals, !!ready.joinpay_withdrawals));
  const historySql = include(scopedFinanceSql(history, "history", scope, null, !!ready.withdrawals));
  const exactSourceKeys = exactFinanceSourceKeys(ready, scope, bind);
  const orderKeys = [false, true].filter(legacy => legacy ? ready.legacy_orders : ready.native_orders).map(legacy => {
    const sql = include(financeOrderSql(legacy, scope, [], null));
    return `SELECT id,'${legacy ? "LEGACY_ORDER:" : "ORDER:"}'||id AS ref,at,1 AS priority FROM (${sql}) orders`;
  });
  const pageSize = scope.pageSize ?? 20, limit = bind(pageSize), offset = bind(((scope.page ?? 1) - 1) * pageSize);
  return { text: `WITH finance_lookup_ledger AS (${ledgerSql}),finance_lookup_history AS (${historySql}),
    finance_lookup_entries AS (
      SELECT 'ledger:'||r.id AS id,${ledgerDocument} AS ref,r.at FROM finance_lookup_ledger r
      UNION ALL SELECT 'history:'||r.id,${historyDocument},r.at FROM finance_lookup_history r
    ),finance_lookup_ranked AS (
      SELECT ref,at,row_number() OVER(PARTITION BY ref COLLATE "C" ORDER BY priority,at DESC NULLS LAST,id COLLATE "C" DESC) AS rank FROM (
        SELECT id,ref,at,0 AS priority FROM finance_lookup_entries
        ${orderKeys.length ? "UNION ALL " + orderKeys.join(" UNION ALL ") : ""}
        ${exactSourceKeys.length ? "UNION ALL " + exactSourceKeys.join(" UNION ALL ") : ""}
      ) candidates
    ),finance_lookup_documents AS (
      SELECT ref,at FROM finance_lookup_ranked WHERE rank=1
    ),finance_lookup_page AS (
      SELECT ref,at FROM finance_lookup_documents ORDER BY at DESC NULLS LAST,ref COLLATE "C" DESC LIMIT ${limit} OFFSET ${offset}
    ) SELECT page.ref,documents.total AS document_count,entries.total AS entry_count
      FROM (SELECT count(*)::text AS total FROM finance_lookup_documents) documents
      CROSS JOIN (SELECT count(*)::text AS total FROM finance_lookup_entries) entries
      LEFT JOIN finance_lookup_page page ON TRUE ORDER BY page.at DESC NULLS LAST,page.ref COLLATE "C" DESC`, values };
}
