import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";

type Requirement = { domain: "refunds" | "withdrawals" | "controlledWithdrawals"; table: string; columns: string[] };
const table = (domain: Requirement["domain"], name: string, columns: string): Requirement => ({ domain, table: `zzsh_order.${name}`, columns: columns.split(" ") });
const common = "id source_kind source_type source_system source_entity source_id subject_user_id beneficiary_role basis_id policy_version source_digest";
const ledger = "id posting_id finance_event_id line_no account_code debit_cents credit_cents counterparty_user_id source_payment_confirmation_id details";
const requirements: Requirement[] = [
  ...(["refunds", "withdrawals"] as const).flatMap(domain => [
    table(domain, "finance_economic_root", common), table(domain, "finance_event", "id economic_root_id kind subject_user_id expected_ledger_revision"),
    table(domain, "settlement_ledger_entry", ledger), table(domain, "wallet_revision", "user_id ledger_revision"),
    { domain, table: "zzsh_iam.audit_event", columns: ["action", "object_type", "object_id", "outcome", "details"] },
  ]),
  table("refunds", "rental_order", "id display_no renter_user_id paid_confirmation_id"),
  table("refunds", "settlement_posting", "id order_id payment_confirmation_id version_hash currency captured_cents renter_refund_cents posted_at refund_due_at"),
  table("refunds", "payment_confirmation", "id order_id source disposition reason_code currency amount_cents merchant_scope_id provider_transaction_id merchant_order_no joinpay_request_id joinpay_evidence_id joinpay_anchor_id accepted_at"),
  table("refunds", "channel_refund_intent", "id posting_id order_id renter_user_id basis_kind payment_confirmation_id liability_root_id liability_event_id responsibility_version_hash payment_source evidence_level merchant_identity_id original_payment_trx_no original_payment_order_no amount_cents currency state budget_disposition requires_review due_at terminal_evidence_id terminal_root_id terminal_event_id created_at"),
  table("refunds", "prestart_termination", "id order_id payment_basis basis_digest requested_by_party state approved_at liability_root_id liability_event_id created_at"),
  table("refunds", "legacy_order_duty", "id order_id kind source_record_id counterparty_user_id amount_cents currency status source source_status source_digest continuation_version_id admission_id maturity_at revision settled_by settled_ref_type settled_ref_id settled_ref_digest created_at"),
  table("refunds", "legacy_order_read_snapshot", "id original_order_no source_system source_entity legacy_id source_digest renter_user_id"),
  ...["joinpay_refund_evidence", "prestart_termination_decision", "rental_opening", "settlement_version", "settlement_intake", "rental_referral_earning"].map(name => table("refunds", name, "id")),
  table("refunds", "rental_opening_ack", "opening_id"),
  table("controlledWithdrawals", "withdrawal_intent", "id user_id mode policy_version input_digest gross_cents net_cents fee_cents economic_root_id expected_ledger_revision state funds_disposition accepted_at"),
  table("withdrawals", "joinpay_withdrawal_intent", "id user_id merchant_order_no gross_cents funds_disposition state requires_review accepted_at"),
  ...["joinpay_payout_evidence", "joinpay_payout_attempt"].map(name => table("withdrawals", name, "id")),
];
const functions = [
  ...["native_refund_terminal_complete", "prestart_liability_complete", "prestart_payment_basis_valid", "support_cancel_payment_basis_valid", "native_prestart_refund_liability_complete", "native_prestart_refund_terminal_complete"].map(name => ({ domain: "refunds", name: `zzsh_order.${name}(${name.endsWith("basis_valid") ? "jsonb" : "text"})` })),
  { domain: "controlledWithdrawals", name: "zzsh_order.withdrawal_expected_lines(text)" },
  ...["joinpay_withdrawal_expected_lines", "joinpay_withdrawal_complete"].map(name => ({ domain: "withdrawals", name: `zzsh_order.${name}(text)` })),
];

const preflightSql = `/* finance obligation queues effective schema and ACL */
WITH required AS (SELECT x->>'domain' AS domain,x->>'table' AS tbl,ARRAY(SELECT jsonb_array_elements_text(x->'columns')) AS cols
 FROM jsonb_array_elements($1::jsonb) x), checked AS (
 SELECT domain,COALESCE(c.oid IS NOT NULL AND c.relkind='r' AND c.relpersistence='p' AND NOT c.relrowsecurity
  AND has_schema_privilege(current_user,c.relnamespace,'USAGE') AND has_table_privilege(current_user,c.oid,'SELECT')
  AND (SELECT count(*)=cardinality(r.cols) FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped AND a.attname=ANY(r.cols)),false) AS ready
 FROM required r LEFT JOIN pg_class c ON c.oid=to_regclass(r.tbl)
 UNION ALL SELECT x->>'domain',COALESCE(has_function_privilege(current_user,to_regprocedure(x->>'name'),'EXECUTE'),false)
 FROM jsonb_array_elements($2::jsonb) x)
SELECT COALESCE(bool_and(ready) FILTER(WHERE domain='refunds'),false) AS refunds,
 COALESCE(bool_and(ready) FILTER(WHERE domain='withdrawals'),false)
  AND (COALESCE(bool_and(ready) FILTER(WHERE domain='controlledWithdrawals'),false) OR production) AS withdrawals,
 production FROM checked CROSS JOIN (SELECT (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('zzsh_order.finance_economic_root')
      AND conname='production_no_local_controlled_root' AND contype='c' AND convalidated)
    AND to_regclass('zzsh_order.withdrawal_intent') IS NULL
    AND to_regclass('zzsh_order.withdrawal_admission') IS NULL
    AND to_regclass('zzsh_order.withdrawal_destination') IS NULL
    AND to_regclass('zzsh_order.withdrawal_provider_fact') IS NULL
    AND to_regclass('zzsh_order.controlled_payout_operation') IS NULL
    AND to_regclass('zzsh_order.controlled_payout_notice') IS NULL
    AND to_regprocedure('zzsh_order.withdrawal_expected_lines(text)') IS NULL) AS production) p GROUP BY production`;

const utc = (field: string) => `to_char(${field} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// Only the bounded preview crosses the API boundary; all money and counts are aggregated in PostgreSQL.
const queueSelect = (refund: boolean, includeControlled = true) => `,
 pending AS MATERIALIZED (SELECT * FROM classified WHERE amount IS NULL OR amount>0),
 preview AS (SELECT * FROM pending ORDER BY CASE WHEN source='LEGACY_DUTY' THEN 1 ELSE 0 END,
  due_at NULLS LAST,id COLLATE "C" LIMIT 5)
SELECT count(*)::text AS count,COALESCE(sum(amount),0)::text AS amount,
 count(*) FILTER(WHERE amount IS NULL)::text AS unknown_count,
 ${refund ? "count(*) FILTER(WHERE due_at<$1::timestamptz)::text" : "NULL::text"} AS overdue_count,
 ${refund ? "COALESCE(sum(amount) FILTER(WHERE due_at<$1::timestamptz),0)::text" : "NULL::text"} AS overdue_amount,
 count(*) FILTER(WHERE due_at IS NULL)::text AS unknown_due_count,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'number',number,'source',source,'status',status,'amountCents',amount::text,
  'recordedAmountCents',recorded_amount::text,'dueAt',${utc("due_at")},'overdue',CASE WHEN due_at IS NULL THEN NULL ELSE due_at<$1::timestamptz END,
  'documentRef',document_ref,'reasonCodes',reasons) ORDER BY CASE WHEN source='LEGACY_DUTY' THEN 1 ELSE 0 END,due_at NULLS LAST,id COLLATE "C") FROM preview),'[]'::jsonb) AS items,
 COALESCE((SELECT jsonb_agg(jsonb_build_object('source',source,'count',n::text,'unknownCount',unknown::text,'amountCents',amount::text) ORDER BY source)
  FROM (SELECT f.source,count(p.id) AS n,count(p.id) FILTER(WHERE p.amount IS NULL) AS unknown,COALESCE(sum(p.amount),0) AS amount
   FROM (VALUES ${refund ? "('POSTING'),('PRESTART_TERMINATION'),('LEGACY_DUTY')" : includeControlled ? "('LOCAL_CONTROLLED'),('JOINPAY_FORMAL')" : "('JOINPAY_FORMAL')"}) f(source)
   LEFT JOIN pending p ON p.source=f.source GROUP BY f.source) s),'[]'::jsonb) AS sources
FROM pending`;

const refundsSql = `/* finance obligation queues refund responsibilities and exact original writeoffs */
WITH basis AS MATERIALIZED (
 SELECT 'POSTING'::text AS source,p.id AS basis_id,p.order_id,o.display_no AS number,o.renter_user_id AS subject,
  p.payment_confirmation_id,p.version_hash AS digest,p.id AS posting_id,NULL::text AS liability_root,NULL::text AS liability_event,
  c.source AS payment_source,c.merchant_scope_id AS merchant,c.provider_transaction_id AS trx,c.merchant_order_no AS original_no,
  p.renter_refund_cents AS original,p.refund_due_at AS due_at,p.posted_at AS at,
  COALESCE(p.currency='CNY' AND c.currency='CNY' AND c.disposition='APPLIED' AND c.order_id=p.order_id
   AND o.paid_confirmation_id=c.id AND c.amount_cents=p.captured_cents
   AND (SELECT count(*)=1 AND COALESCE(sum(l.credit_cents-l.debit_cents),0)=p.renter_refund_cents
    AND bool_and(l.counterparty_user_id=o.renter_user_id AND l.source_payment_confirmation_id IS NULL AND l.debit_cents=0)
    FROM zzsh_order.settlement_ledger_entry l WHERE l.posting_id=p.id AND l.account_code='RENTER_REFUND_PAYABLE')
   AND (SELECT count(*)=1 AND bool_and(l.source_payment_confirmation_id=c.id AND l.counterparty_user_id IS NULL
    AND l.debit_cents=p.captured_cents AND l.credit_cents=0) FROM zzsh_order.settlement_ledger_entry l
    WHERE l.posting_id=p.id AND l.account_code='CAPTURED_PAYMENT_SOURCE'),false) AS valid
 FROM zzsh_order.settlement_posting p LEFT JOIN zzsh_order.rental_order o ON o.id=p.order_id
 LEFT JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id
 WHERE p.posted_at<=$1::timestamptz AND p.renter_refund_cents>0
 UNION ALL
 SELECT 'PRESTART_TERMINATION',t.id,t.order_id,o.display_no,o.renter_user_id,c.id,t.basis_digest,NULL,t.liability_root_id,t.liability_event_id,
  c.source,c.merchant_scope_id,c.provider_transaction_id,c.merchant_order_no,c.amount_cents,t.approved_at,t.created_at,
  CASE WHEN t.payment_basis->>'amountCents'~'^[1-9][0-9]{0,15}$' THEN zzsh_order.prestart_liability_complete(t.id) ELSE false END
 FROM zzsh_order.prestart_termination t LEFT JOIN zzsh_order.rental_order o ON o.id=t.order_id
 LEFT JOIN zzsh_order.payment_confirmation c ON c.id=t.payment_basis->>'paymentConfirmationId' AND c.order_id=t.order_id
 WHERE t.state='APPROVED' AND t.approved_at<=$1::timestamptz
), matched AS MATERIALIZED (
 SELECT b.*,i.id AS intent_id,i.amount_cents AS intent_amount,i.state,i.budget_disposition,i.requires_review,i.due_at AS intent_due_at,
  COALESCE(i.basis_kind=b.source AND i.order_id=b.order_id AND i.renter_user_id=b.subject AND i.payment_confirmation_id=b.payment_confirmation_id
   AND i.payment_source=b.payment_source AND i.currency='CNY' AND i.responsibility_version_hash=b.digest
   AND i.posting_id IS NOT DISTINCT FROM b.posting_id AND i.liability_root_id IS NOT DISTINCT FROM b.liability_root
   AND i.liability_event_id IS NOT DISTINCT FROM b.liability_event AND i.merchant_identity_id=b.merchant
   AND i.original_payment_trx_no=b.trx AND i.original_payment_order_no=b.original_no
   AND i.due_at=b.due_at,false) AS bound,
  CASE WHEN i.state IN('SUCCEEDED','FAILED') AND i.payment_source='JOINPAY' AND i.evidence_level='JOINPAY_FORMAL' THEN
   CASE i.basis_kind WHEN 'POSTING' THEN zzsh_order.native_refund_terminal_complete(i.id)
    WHEN 'PRESTART_TERMINATION' THEN zzsh_order.native_prestart_refund_terminal_complete(i.id) ELSE false END ELSE false END AS terminal_complete
 FROM basis b LEFT JOIN zzsh_order.channel_refund_intent i ON i.created_at<=$1::timestamptz AND
  ((b.source='POSTING' AND i.posting_id=b.basis_id)
   OR(b.source='PRESTART_TERMINATION' AND i.basis_kind='PRESTART_TERMINATION' AND i.payment_confirmation_id=b.payment_confirmation_id))
), native AS (
 SELECT source||':'||basis_id AS id,source,max(order_id) AS order_id,max(number) AS number,
  min(due_at) AS due_at,max(original) AS recorded_amount,
  CASE WHEN bool_and(valid) AND count(*)=count(DISTINCT intent_id)+count(*) FILTER(WHERE intent_id IS NULL)
   AND bool_and(intent_id IS NULL OR(bound AND NOT requires_review AND
    ((state IN('READY','SUBMITTING','PROCESSING','UNKNOWN','REVIEW_REQUIRED') AND budget_disposition='ALLOCATED')
      OR(state='SUCCEEDED' AND budget_disposition='CONSUMED' AND terminal_complete)
      OR(state='FAILED' AND budget_disposition='RELEASED' AND terminal_complete))))
   AND COALESCE(sum(intent_amount) FILTER(WHERE budget_disposition IN('ALLOCATED','CONSUMED')),0)<=max(original)
   THEN max(original)-COALESCE(sum(intent_amount) FILTER(WHERE state='SUCCEEDED' AND budget_disposition='CONSUMED' AND bound AND terminal_complete),0) END AS amount,
  count(intent_id) AS intent_count,
  bool_or(state='UNKNOWN') AS provider_unknown,bool_or(state IN('SUBMITTING','PROCESSING')) AS processing,
  bool_or(intent_id IS NOT NULL AND (NOT bound OR requires_review OR (state IN('SUCCEEDED','FAILED') AND NOT terminal_complete))) AS conflict
 FROM matched GROUP BY source,basis_id
), legacy AS (
 -- The original canonical verifier is not a set-based SQL contract; a FINANCE label alone proves no current subtotal.
 SELECT d.id,d.order_id,d.status,d.amount_cents AS recorded_amount,o.original_order_no,NULL::numeric AS amount
 FROM zzsh_order.legacy_order_duty d LEFT JOIN zzsh_order.legacy_order_read_snapshot o ON o.id=d.order_id
 WHERE d.kind='RENTER_REFUND' AND d.status<>'VOID' AND d.created_at<=$1::timestamptz
), classified AS (
 SELECT id,number,source,CASE WHEN amount IS NULL THEN 'REVIEW_REQUIRED' WHEN intent_count=0 THEN 'NO_INTENT'
   WHEN provider_unknown THEN 'UNKNOWN' WHEN processing THEN 'PROCESSING' ELSE 'OUTSTANDING' END AS status,
  amount,recorded_amount,due_at,'ORDER:'||order_id AS document_ref,
  ARRAY['LOCAL_RESPONSIBILITY_ONLY','BANK_ARRIVAL_UNKNOWN']||CASE WHEN amount IS NULL THEN ARRAY['RESPONSIBILITY_OR_WRITE_OFF_UNPROVED'] ELSE ARRAY[]::text[] END
   ||CASE WHEN provider_unknown THEN ARRAY['ORIGINAL_PROVIDER_RESULT_UNKNOWN'] ELSE ARRAY[]::text[] END
   ||CASE WHEN intent_count=0 THEN ARRAY['NO_LOCAL_INTENT_DOES_NOT_PROVE_NO_BANK_REFUND'] ELSE ARRAY[]::text[] END AS reasons FROM native
 UNION ALL SELECT 'LEGACY_DUTY:'||id,original_order_no,'LEGACY_DUTY','SOURCE_RESPONSIBILITY_REVIEW',
  amount,recorded_amount,NULL::timestamptz,'LEGACY_ORDER:'||order_id,
  ARRAY['LEGACY_FINAL_CANONICAL_NOT_REVALIDATED','RECORDED_AMOUNT_IS_NOT_CURRENT_PAYABLE_PROOF','DUE_AT_UNKNOWN','BANK_ARRIVAL_UNKNOWN'] FROM legacy
)${queueSelect(true)}`;

const withdrawalsSql = (includeControlled: boolean) => `/* finance obligation queues withdrawal original reserve debit and release */
WITH ${includeControlled ? `local AS MATERIALIZED (
 SELECT i.id,i.state,i.funds_disposition,i.gross_cents,i.accepted_at,
  COALESCE(i.mode='LOCAL_CONTROLLED' AND i.gross_cents=i.net_cents+i.fee_cents
   AND r.source_kind='LOCAL_CONTROLLED_WITHDRAWAL' AND r.source_type='NATIVE' AND r.source_system='zzsh-local-controlled'
   AND r.source_entity='withdrawal_intent' AND r.source_id=i.id AND r.subject_user_id=i.user_id
   AND r.beneficiary_role='WALLET_HOLDER' AND r.basis_id IS NULL AND r.policy_version=i.policy_version AND r.source_digest=i.input_digest
   AND (SELECT count(*) FILTER(WHERE e.kind='RESERVE')=1
     AND count(*) FILTER(WHERE e.kind='PAYOUT')=CASE WHEN i.funds_disposition='PAYOUT_POSTED' THEN 1 ELSE 0 END
     AND count(*) FILTER(WHERE e.kind='RELEASE')=CASE WHEN i.funds_disposition='RELEASE_POSTED' THEN 1 ELSE 0 END
     AND bool_and(e.kind IN('RESERVE','PAYOUT','RELEASE') AND e.subject_user_id=i.user_id
      AND (e.kind<>'RESERVE' OR e.expected_ledger_revision=i.expected_ledger_revision)
      AND EXISTS(SELECT 1 FROM zzsh_order.wallet_revision w WHERE w.user_id=i.user_id AND w.ledger_revision>=e.expected_ledger_revision+1))
    FROM zzsh_order.finance_event e WHERE e.economic_root_id=r.id)
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.finance_event e WHERE e.economic_root_id=r.id AND (
    (SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)<>
      (SELECT count(*) FROM zzsh_order.withdrawal_expected_lines(e.id))
    OR EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id
     AND (l.posting_id IS NOT NULL OR l.source_payment_confirmation_id IS NOT NULL OR l.details IS DISTINCT FROM
      jsonb_build_object('intentId',i.id,'economicRootId',i.economic_root_id,'policyVersion',i.policy_version,'inputDigest',i.input_digest)))
    OR EXISTS((SELECT l.line_no,l.account_code,l.debit_cents,l.credit_cents,l.counterparty_user_id FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)
      EXCEPT (SELECT * FROM zzsh_order.withdrawal_expected_lines(e.id)))
    OR EXISTS((SELECT * FROM zzsh_order.withdrawal_expected_lines(e.id)) EXCEPT
      (SELECT l.line_no,l.account_code,l.debit_cents,l.credit_cents,l.counterparty_user_id FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id))))
   AND ((i.funds_disposition='RESERVED' AND i.state IN('RESERVED','SUBMITTING','PROCESSING','UNKNOWN','RECONCILIATION_REQUIRED'))
     OR(i.funds_disposition='PAYOUT_POSTED' AND i.state='SUCCEEDED') OR(i.funds_disposition='RELEASE_POSTED' AND i.state='FAILED')),false) AS complete
 FROM zzsh_order.withdrawal_intent i LEFT JOIN zzsh_order.finance_economic_root r ON r.id=i.economic_root_id WHERE i.accepted_at<=$1::timestamptz
), ` : ""}formal AS MATERIALIZED (
 SELECT id,merchant_order_no,state,funds_disposition,gross_cents,accepted_at,requires_review,zzsh_order.joinpay_withdrawal_complete(id) AS complete
 FROM zzsh_order.joinpay_withdrawal_intent WHERE accepted_at<=$1::timestamptz
), classified AS (
 ${includeControlled ? `SELECT 'WITHDRAWAL:'||id AS id,NULL::text AS number,'LOCAL_CONTROLLED'::text AS source,state AS status,
  CASE WHEN complete AND funds_disposition='RESERVED' THEN gross_cents END AS amount,gross_cents AS recorded_amount,NULL::timestamptz AS due_at,
  'WITHDRAWAL:'||id AS document_ref,ARRAY['LOCAL_CONTROLLED_NOT_BANK_PAYOUT','WITHDRAWAL_DUE_AT_NOT_DEFINED']
   ||CASE WHEN NOT complete THEN ARRAY['ORIGINAL_RESERVE_OR_TERMINAL_UNPROVED'] ELSE ARRAY[]::text[] END AS reasons
 FROM local WHERE NOT complete OR funds_disposition='RESERVED'
 UNION ALL ` : ""}SELECT 'JOINPAY_WITHDRAWAL:'||id AS id,merchant_order_no AS number,'JOINPAY_FORMAL'::text AS source,state AS status,
  CASE WHEN complete AND NOT requires_review AND funds_disposition='RESERVED' THEN gross_cents END AS amount,gross_cents AS recorded_amount,NULL::timestamptz AS due_at,'JOINPAY_WITHDRAWAL:'||id AS document_ref,
  ARRAY['FORMAL_LOCAL_ACCEPTANCE_NOT_BANK_ARRIVAL','WITHDRAWAL_DUE_AT_NOT_DEFINED']
   ||CASE WHEN NOT complete OR requires_review THEN ARRAY['ORIGINAL_RESERVE_OR_TERMINAL_UNPROVED'] ELSE ARRAY[]::text[] END AS reasons
 FROM formal WHERE NOT complete OR requires_review OR funds_disposition='RESERVED'
)${queueSelect(false,includeControlled)}`;

type QueueRow = { count: unknown; amount: unknown; unknown_count: unknown; overdue_count: unknown; overdue_amount: unknown; unknown_due_count: unknown; items: unknown; sources: unknown };
const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Finance obligation queue aggregate is inconsistent");
function integer(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw unavailable();
  return value;
}
const notAvailable = () => ({ knowledge: "UNAVAILABLE" as const, count: null, amountCents: null, unknownCount: null, overdueCount: null,
  overdueAmountCents: null, unknownDueCount: null, items: [], hasMore: false, sources: [], amountBasis: "PROVED_LOCAL_OUTSTANDING_SUBTOTAL" as const,
  reasonCodes: ["QUEUE_SCHEMA_OR_EFFECTIVE_ACL_UNAVAILABLE"], bankArrival: "UNKNOWN" as const });

function project(row: QueueRow | undefined, documentReadable: boolean, refund: boolean) {
  if (!row || !Array.isArray(row.items) || row.items.length > 5 || !Array.isArray(row.sources)) throw unavailable();
  const n = integer(row.count), unknown = integer(row.unknown_count), unknownDue = integer(row.unknown_due_count);
  if (BigInt(unknown)>BigInt(n) || BigInt(unknownDue)>BigInt(n) || BigInt(n)<BigInt(row.items.length)) throw unavailable();
  const amount = integer(row.amount), overdueCount = refund ? integer(row.overdue_count) : null, overdueAmount = refund ? integer(row.overdue_amount) : null;
  if (overdueCount !== null && (BigInt(overdueCount)>BigInt(n) || BigInt(overdueAmount!)>BigInt(amount))) throw unavailable();
  const items = row.items.map((item: unknown) => {
    if (!item || typeof item !== "object") throw unavailable();
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || !(r.number === null || typeof r.number === "string" && r.number.length>0 && r.number.length<=255 && !/[\u0000-\u001f\u007f]/.test(r.number))
      || typeof r.source !== "string" || typeof r.status !== "string" || !Array.isArray(r.reasonCodes)
      || !r.reasonCodes.every(x => typeof x === "string") || typeof r.documentRef !== "string"
      || !/^(ORDER|LEGACY_ORDER|WITHDRAWAL|JOINPAY_WITHDRAWAL):[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(r.documentRef)
      || !(r.dueAt === null || typeof r.dueAt === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(r.dueAt))
      || !(r.overdue === null || typeof r.overdue === "boolean")) throw unavailable();
    return { id: r.id, number: r.number as string | null, source: r.source, status: r.status, amountCents: r.amountCents === null ? null : integer(r.amountCents),
      recordedAmountCents: r.recordedAmountCents === null ? null : integer(r.recordedAmountCents), dueAt: r.dueAt as string | null,
      overdue: r.overdue as boolean | null, documentRef: documentReadable ? r.documentRef : null, reasonCodes: r.reasonCodes as string[], bankArrival: "UNKNOWN" as const };
  });
  const sources = row.sources.map((source: unknown) => {
    if (!source || typeof source !== "object" || typeof (source as Record<string, unknown>).source !== "string") throw unavailable();
    const r = source as Record<string, unknown>, count = integer(r.count), unknownCount = integer(r.unknownCount);
    if (BigInt(unknownCount)>BigInt(count)) throw unavailable();
    return { source: r.source as string, count, unknownCount, amountCents: integer(r.amountCents) };
  });
  if (sources.reduce((total, s) => total+BigInt(s.count),0n)!==BigInt(n)
    || sources.reduce((total, s) => total+BigInt(s.unknownCount),0n)!==BigInt(unknown)
    || sources.reduce((total, s) => total+BigInt(s.amountCents),0n)!==BigInt(amount)) throw unavailable();
  return { knowledge: unknown === "0" ? "KNOWN" as const : "PARTIAL" as const, count: n, amountCents: amount, unknownCount: unknown,
    overdueCount, overdueAmountCents: overdueAmount, unknownDueCount: unknownDue, items, hasMore: BigInt(n)>BigInt(items.length), sources,
    amountBasis: "PROVED_LOCAL_OUTSTANDING_SUBTOTAL" as const, reasonCodes: ["LOCAL_REGISTERED_RESPONSIBILITIES_ONLY", "BANK_ARRIVAL_UNKNOWN",
      ...(unknown !== "0" ? ["UNKNOWN_ITEMS_EXCLUDED_FROM_AMOUNT_SUBTOTAL"] : []),
      ...(!refund ? ["WITHDRAWAL_DUE_AT_NOT_DEFINED"] : unknownDue !== "0" ? ["OVERDUE_COVERAGE_INCOMPLETE"] : [])], bankArrival: "UNKNOWN" as const };
}

/** finance.read authorization and one consistent read-only snapshot belong to the caller; refs add no detail authority. */
export async function readAdminFinanceObligationQueues(client: PoolClient, asOf: string, documentReadable: boolean) {
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(asOf) || !Number.isFinite(Date.parse(asOf))) throw unavailable();
  const ready = (await client.query<{ refunds: boolean; withdrawals: boolean; production?: boolean }>(preflightSql, [JSON.stringify(requirements), JSON.stringify(functions)])).rows[0];
  return {
    refunds: ready?.refunds === true ? project((await client.query<QueueRow>(refundsSql, [asOf])).rows[0], documentReadable, true) : notAvailable(),
    withdrawals: ready?.withdrawals === true ? project((await client.query<QueueRow>(withdrawalsSql(ready.production!==true), [asOf])).rows[0], documentReadable, false) : notAvailable(),
  };
}
