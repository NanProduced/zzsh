import type { FinanceFilters } from "./admin-finance-read";
import { escapeLike } from "../supply/catalog";
import { financeOrderSql } from "./admin-finance-order-read";

export type FinanceLoadScope = { filters?: FinanceFilters; documentRef?: string; subjectId?: string; page?: number; pageSize?: number; lookup?: { exact: boolean }; documentRefs?: string[]; orderRefs?: string[] };
export const FINANCE_LEDGER_BUCKET_SQL = `CASE WHEN r.account_code IN ('OWNER_AVAILABLE','WALLET_AVAILABLE') THEN 'AVAILABLE' WHEN r.account_code='WALLET_RESERVED' THEN 'RESERVED' WHEN r.account_code='GUARANTEE_HELD' THEN 'GUARANTEE_HELD' WHEN r.account_code='WALLET_PENDING_EARNINGS' THEN 'PENDING_EARNINGS' WHEN r.account_code='RENTER_REFUND_PAYABLE' THEN 'REFUND_PAYABLE' WHEN r.account_code LIKE 'PLATFORM_%' OR r.account_code='WITHDRAW_FEE' THEN 'PLATFORM' ELSE 'CLEARING' END`;
const historyBucket = `CASE WHEN r.observation_origin='LEGACY_GUARANTEE_HISTORY' THEN 'GUARANTEE_HELD' WHEN r.observation_origin='LEGACY_DUTY_ZERO' AND r.action='RENTER_REFUND' THEN 'REFUND_PAYABLE' WHEN r.source_entity='la_distribution_order' OR r.observation_origin='NATIVE_EARNING_ZERO' AND r.source_status='PENDING' THEN 'PENDING_EARNINGS' ELSE 'AVAILABLE' END`;
const ledgerKind = `CASE WHEN r.event_kind='OPENING' THEN 'OPENING' WHEN r.source_entity='withdrawal_intent' THEN 'WITHDRAWAL' WHEN r.source_kind='NATIVE_RENTAL_REFERRAL' OR r.source_kind='LEGACY_CONTINUATION_DUTY' AND r.beneficiary_role='COMMISSION' THEN 'DISTRIBUTION' WHEN r.source_kind='NATIVE_GUARANTEE' THEN 'GUARANTEE' WHEN r.account_code='RENTER_REFUND_PAYABLE' THEN 'REFUND' ELSE 'SETTLEMENT' END`;
const historyKind = `CASE WHEN r.observation_origin='LEGACY_GUARANTEE_HISTORY' THEN 'GUARANTEE' WHEN r.observation_origin='NATIVE_EARNING_ZERO' OR r.observation_origin='LEGACY_DUTY_ZERO' AND r.action='COMMISSION' THEN 'DISTRIBUTION' WHEN r.observation_origin='LEGACY_DUTY_ZERO' THEN CASE WHEN r.action='RENTER_REFUND' THEN 'REFUND' ELSE 'SETTLEMENT' END WHEN r.source_entity='la_log_earnings' THEN 'EARNINGS' WHEN r.source_entity='la_distribution_order' THEN 'DISTRIBUTION' ELSE 'WITHDRAWAL' END`;
const historyDocument=`CASE WHEN r.observation_origin='LEGACY_GUARANTEE_HISTORY' THEN 'GUARANTEE_SOURCE:'||r.id WHEN r.observation_origin='NATIVE_EARNING_ZERO' THEN 'DISTRIBUTION:'||r.source_id WHEN r.observation_origin='LEGACY_DUTY_ZERO' THEN 'LEGACY_DUTY:'||r.source_id ELSE 'HISTORY_'||(${historyKind})||':'||r.id END`;
const ledgerSubject = `COALESCE(r.subject_id,CASE WHEN (${FINANCE_LEDGER_BUCKET_SQL})='PLATFORM' THEN 'PLATFORM' ELSE 'SYSTEM' END)`;
const ledgerDocument = `CASE WHEN r.event_kind='OPENING' THEN 'OPENING:'||r.basis_id WHEN r.source_entity='withdrawal_intent' THEN 'WITHDRAWAL:'||r.source_id WHEN r.source_kind='NATIVE_RENTAL_REFERRAL' THEN 'DISTRIBUTION:'||r.economic_root_id WHEN r.source_kind='LEGACY_CONTINUATION_DUTY' THEN 'LEGACY_DUTY:'||r.source_id WHEN r.source_entity='owner_guarantee_payment' THEN 'GUARANTEE_PAYMENT:'||r.source_id WHEN r.source_entity='owner_guarantee_refund' THEN 'GUARANTEE_REFUND:'||r.source_id WHEN r.order_id IS NOT NULL THEN 'ORDER:'||r.order_id ELSE 'POSTING:'||COALESCE(r.posting_id,r.id) END`;

/** The same scope is applied in SQL before the matched-result ceiling. Values never become SQL. */
export function scopedFinanceSql(source: string, family: "ledger" | "history", scope: FinanceLoadScope, limit: number | null, withdrawalsReady: boolean) {
  const values: unknown[] = [], conditions: string[] = [], bind = (value: unknown) => `$${values.push(value)}`;
  const bucket = family === "ledger" ? FINANCE_LEDGER_BUCKET_SQL : historyBucket;
  const kind = family === "ledger" ? ledgerKind : historyKind;
  const subject = family === "ledger" ? ledgerSubject : "r.subject_id";
  const document = family === "ledger" ? ledgerDocument : historyDocument;
  const number = family === "ledger" ? "COALESCE(r.display_no,CASE WHEN r.event_kind='OPENING' THEN r.basis_id ELSE r.source_id END,r.posting_id,r.id)" : "COALESCE(CASE WHEN r.source_entity='la_log_earnings' THEN NULLIF(r.extra_evidence->'snapshot'->>'legacyLogNumber','') END,r.reference_no,r.source_id)";
  const state = family === "history" ? "CASE WHEN r.observation_origin IN('NATIVE_EARNING_ZERO','LEGACY_DUTY_ZERO') THEN r.source_status ELSE 'HISTORICAL_OBSERVED' END" : withdrawalsReady ? `CASE WHEN r.source_entity='withdrawal_intent' AND i.id IS NOT NULL THEN i.state WHEN r.source_kind='NATIVE_RENTAL_REFERRAL' THEN COALESCE(r.earning_state,'UNKNOWN') WHEN r.account_code='RENTER_REFUND_PAYABLE' THEN 'REFUND_PAYABLE_RECORDED' ELSE 'POSTED' END` : `CASE WHEN r.source_kind='NATIVE_RENTAL_REFERRAL' THEN COALESCE(r.earning_state,'UNKNOWN') WHEN r.account_code='RENTER_REFUND_PAYABLE' THEN 'REFUND_PAYABLE_RECORDED' ELSE 'POSTED' END`;
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
    if (f.q.startsWith("ORDER_LINK:")) conditions.push(family === "ledger" ? `r.order_id=${bind(f.q.slice(11))}` : "FALSE");
    else if (f.q) {
      const masked = `CASE WHEN r.subject_name ~ '^1[3-9][0-9]{9}$' THEN left(r.subject_name,3)||'****'||right(r.subject_name,4) ELSE COALESCE(r.subject_name,${subject}) END`;
      const name = family === "ledger" ? `CASE WHEN r.subject_id IS NULL THEN CASE WHEN (${bucket})='PLATFORM' THEN '平台' ELSE '对照科目' END ELSE ${masked} END` : masked;
      const fields = [subject, name, document, number, family === "ledger" ? "COALESCE(r.source_id,r.posting_id,r.id)" : "r.source_id", `'${family}:'||r.id`];
      const exact = scope.lookup?.exact, p = bind(exact ? f.q : `%${escapeLike(f.q.toLocaleLowerCase("zh-CN"))}%`);
      conditions.push(`(${fields.map(field => exact ? `(${field})=${p}` : `lower(${field}) LIKE ${p} ESCAPE '\\'`).join(" OR ")})`);
    }
  }
  const base = source.replace(/\s+ORDER BY [lo]\.id COLLATE "C" LIMIT \$1\s*$/, "");
  const join = family === "ledger" && withdrawalsReady ? " LEFT JOIN zzsh_order.withdrawal_intent i ON i.id=r.source_id AND r.source_entity='withdrawal_intent'" : "";
  return { text: `WITH finance_scoped_rows AS (${base}) SELECT r.* FROM finance_scoped_rows r${join} WHERE ${conditions.length ? conditions.join(" AND ") : "TRUE"}${limit === null ? "" : ` ORDER BY r.id COLLATE "C" LIMIT ${bind(limit)}`}`, values };
}

/** A DB-side digest, not a second ledger/version store. New rows outside a page also invalidate it. */
export function financeVersionSql(ready: { withdrawals?: boolean; native_orders?: boolean; legacy_orders?: boolean;native_distribution?:boolean;history_coverage?:boolean;legacy_duty_finance?:boolean;guarantee_history?:boolean }): string {
  const relations = [
    `SELECT id,name FROM zzsh_auth_user."user"`,
    `SELECT id,account_code,counterparty_user_id,credit_cents::text,debit_cents::text,posting_id,finance_event_id,created_at FROM zzsh_order.settlement_ledger_entry`,
    `SELECT id,user_id,basis_id,source_digest,included_in_opening,source_event_at,imported_at FROM zzsh_order.personal_finance_observation`,
    `SELECT user_id AS id,ledger_revision::text,read_revision::text FROM zzsh_order.wallet_revision`,
    `SELECT user_id AS id,basis_id,coverage_version::text FROM zzsh_order.wallet_coverage`,
    `SELECT id,source_digest,covered_set_digest,source_cutoff FROM zzsh_order.finance_opening_basis`,
    `SELECT id,source_digest,policy_version FROM zzsh_order.finance_economic_root`,
    `SELECT id,version_hash FROM zzsh_order.settlement_posting`,
  ];
  if (ready.native_orders) relations.push(`SELECT id,revision::text,status FROM zzsh_order.rental_order`);
  if (ready.legacy_orders) relations.push(`SELECT id,source_digest,binding_digest FROM zzsh_order.legacy_order_read_snapshot`);
  if (ready.native_distribution) relations.push(`SELECT id,version::text,state,funds_disposition,recovery_required_cents::text,seed_digest,beneficiary_user_id,beneficiary_role,amount_cents::text,order_id,created_at,due_at FROM zzsh_order.rental_referral_earning`);
  if (ready.history_coverage) relations.push(`SELECT id,body_digest FROM zzsh_order.personal_finance_observation_coverage`);
  if(ready.legacy_duty_finance)relations.push(`SELECT duty_id AS id,facts_digest,event_id,ref_type,ref_id FROM zzsh_order.legacy_duty_finance_fact`,`SELECT id,revision::text,status,settled_by,settled_ref_type,settled_ref_id,settled_ref_digest FROM zzsh_order.legacy_order_duty`);
  if(ready.guarantee_history)relations.push(`SELECT id,body_digest FROM zzsh_order.legacy_owner_guarantee_coverage`,`SELECT id,source_digest,source_cutoff,imported_at FROM zzsh_order.legacy_owner_guarantee_observation`);
  if (ready.withdrawals) relations.push(`SELECT id,operation_version::text,state,funds_disposition,last_provider_fact_id FROM zzsh_order.withdrawal_intent`, `SELECT id,evidence_digest FROM zzsh_order.withdrawal_provider_fact`, `SELECT id,final_evidence_digest FROM zzsh_order.controlled_payout_operation`);
  return `SELECT md5(concat_ws('|',${relations.map(relation => `(SELECT md5(COALESCE(string_agg(md5(to_jsonb(v)::text),'' ORDER BY v.id COLLATE "C"),'')) FROM (${relation}) v)`).join(",")})) AS finance_version`;
}

/** Select document keys before loading payloads; ledger documents override their order-only counterpart. */
export function financeLookupPageSql(ledger: string, history: string, ready: { withdrawals?: boolean; native_orders?: boolean; legacy_orders?: boolean }, scope: FinanceLoadScope) {
  const values: unknown[] = [], include = (query: {text: string; values: unknown[]}) => {
    const offset = values.length; values.push(...query.values);
    return query.text.replace(/\$(\d+)/g, (_, n: string) => `$${Number(n) + offset}`);
  }, bind = (value: unknown) => `$${values.push(value)}`;
  const ledgerSql = include(scopedFinanceSql(ledger, "ledger", scope, null, !!ready.withdrawals));
  const historySql = include(scopedFinanceSql(history, "history", scope, null, !!ready.withdrawals));
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
