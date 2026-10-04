import type { FinanceFilters } from "./admin-finance-read";
import { escapeLike } from "../supply/catalog";

export type FinanceLoadScope = { filters?: FinanceFilters; documentRef?: string; subjectId?: string; page?: number; pageSize?: number };
export const FINANCE_LEDGER_BUCKET_SQL = `CASE WHEN r.account_code IN ('OWNER_AVAILABLE','WALLET_AVAILABLE') THEN 'AVAILABLE' WHEN r.account_code='WALLET_RESERVED' THEN 'RESERVED' WHEN r.account_code='RENTER_REFUND_PAYABLE' THEN 'REFUND_PAYABLE' WHEN r.account_code LIKE 'PLATFORM_%' OR r.account_code='WITHDRAW_FEE' THEN 'PLATFORM' ELSE 'CLEARING' END`;
const historyBucket = `CASE WHEN r.source_entity='la_distribution_order' THEN 'PENDING_EARNINGS' ELSE 'AVAILABLE' END`;
const ledgerKind = `CASE WHEN r.event_kind='OPENING' THEN 'OPENING' WHEN r.source_entity='withdrawal_intent' THEN 'WITHDRAWAL' WHEN r.account_code='RENTER_REFUND_PAYABLE' THEN 'REFUND' ELSE 'SETTLEMENT' END`;
const historyKind = `CASE WHEN r.source_entity='la_log_earnings' THEN 'EARNINGS' WHEN r.source_entity='la_distribution_order' THEN 'DISTRIBUTION' ELSE 'WITHDRAWAL' END`;
const ledgerSubject = `COALESCE(r.subject_id,CASE WHEN (${FINANCE_LEDGER_BUCKET_SQL})='PLATFORM' THEN 'PLATFORM' ELSE 'SYSTEM' END)`;
const ledgerDocument = `CASE WHEN r.event_kind='OPENING' THEN 'OPENING:'||r.basis_id WHEN r.source_entity='withdrawal_intent' THEN 'WITHDRAWAL:'||r.source_id WHEN r.order_id IS NOT NULL THEN 'ORDER:'||r.order_id ELSE 'POSTING:'||COALESCE(r.posting_id,r.id) END`;

/** The same scope is applied in SQL before the matched-result ceiling. Values never become SQL. */
export function scopedFinanceSql(source: string, family: "ledger" | "history", scope: FinanceLoadScope, limit: number, withdrawalsReady: boolean) {
  const values: unknown[] = [], conditions: string[] = [], bind = (value: unknown) => `$${values.push(value)}`;
  const bucket = family === "ledger" ? FINANCE_LEDGER_BUCKET_SQL : historyBucket;
  const kind = family === "ledger" ? ledgerKind : historyKind;
  const subject = family === "ledger" ? ledgerSubject : "r.subject_id";
  const document = family === "ledger" ? ledgerDocument : `'HISTORY_'||(${historyKind})||':'||r.id`;
  const number = family === "ledger" ? "COALESCE(r.display_no,r.basis_id,r.source_id,r.posting_id,r.id)" : "COALESCE(r.reference_no,r.source_id)";
  const state = family === "history" ? "'HISTORICAL_OBSERVED'" : withdrawalsReady ? `CASE WHEN r.source_entity='withdrawal_intent' AND i.id IS NOT NULL THEN i.state WHEN r.account_code='RENTER_REFUND_PAYABLE' THEN 'REFUND_PAYABLE_RECORDED' ELSE 'POSTED' END` : `CASE WHEN r.account_code='RENTER_REFUND_PAYABLE' THEN 'REFUND_PAYABLE_RECORDED' ELSE 'POSTED' END`;
  if (scope.documentRef) conditions.push(`(${document})=${bind(scope.documentRef)}`);
  else if (scope.subjectId) conditions.push(`(${subject})=${bind(scope.subjectId)}`);
  else if (scope.filters) {
    const f = scope.filters;
    if (f.scope !== "ALL") conditions.push(`(${subject})=${bind(f.scope)}`);
    if (f.bucket !== "ALL") conditions.push(`(${bucket})=${bind(f.bucket)}`);
    if (f.kind !== "ALL") conditions.push(`(${kind})=${bind(f.kind)}`);
    if (f.state !== "ALL") conditions.push(`(${state})=${bind(f.state)}`);
    if (f.period) { const start = bind(`${f.from}T00:00:00+08:00`), end = bind(new Date(Date.parse(`${f.to}T00:00:00+08:00`) + 86400_000).toISOString()); conditions.push(`(r.at IS NULL OR (r.at::timestamptz>=${start}::timestamptz AND r.at::timestamptz<${end}::timestamptz))`); }
    if (f.q.startsWith("ORDER_LINK:")) conditions.push(family === "ledger" ? `r.order_id=${bind(f.q.slice(11))}` : "FALSE");
    else if (f.q) { const p = bind(`%${escapeLike(f.q.toLocaleLowerCase("zh-CN"))}%`); conditions.push(`(lower(${subject}) LIKE ${p} ESCAPE '\\' OR lower(COALESCE(r.subject_name,'')) LIKE ${p} ESCAPE '\\' OR lower(${document}) LIKE ${p} ESCAPE '\\' OR lower(${number}) LIKE ${p} ESCAPE '\\' OR lower(${family==="ledger"?"COALESCE(r.source_id,r.posting_id,r.id)":"r.source_id"}) LIKE ${p} ESCAPE '\\' OR lower('${family}:'||r.id) LIKE ${p} ESCAPE '\\')`); }
  }
  const base = source.replace(/\s+ORDER BY [lo]\.id COLLATE "C" LIMIT \$1\s*$/, "");
  const join = family === "ledger" && withdrawalsReady ? " LEFT JOIN zzsh_order.withdrawal_intent i ON i.id=r.source_id AND r.source_entity='withdrawal_intent'" : "";
  return { text: `WITH finance_scoped_rows AS (${base}) SELECT r.* FROM finance_scoped_rows r${join} WHERE ${conditions.length ? conditions.join(" AND ") : "TRUE"} ORDER BY r.id COLLATE "C" LIMIT ${bind(limit)}`, values };
}

/** A DB-side digest, not a second ledger/version store. New rows outside a page also invalidate it. */
export function financeVersionSql(ready: { withdrawals?: boolean; native_orders?: boolean; legacy_orders?: boolean }): string {
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
  if (ready.withdrawals) relations.push(`SELECT id,operation_version::text,state,funds_disposition,last_provider_fact_id FROM zzsh_order.withdrawal_intent`, `SELECT id,evidence_digest FROM zzsh_order.withdrawal_provider_fact`, `SELECT id,final_evidence_digest FROM zzsh_order.controlled_payout_operation`);
  return `SELECT md5(concat_ws('|',${relations.map(relation => `(SELECT md5(COALESCE(string_agg(md5(to_jsonb(v)::text),'' ORDER BY v.id COLLATE "C"),'')) FROM (${relation}) v)`).join(",")})) AS finance_version`;
}
