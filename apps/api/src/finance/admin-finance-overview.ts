import type { PoolClient } from "pg";
import { invalid } from "../supply/supply-util";
import { SecurityApiError } from "../auth/security-core";
import { exactCents } from "./personal-finance-read";
import { FINANCE_BUCKETS, displayName } from "./admin-finance-read";
import { FINANCE_LEDGER_BUCKET_SQL } from "./admin-finance-query";
import { readAdminFinanceObligationQueues } from "./admin-finance-obligation-queues";

export function parseFinanceOverviewRange(query: URLSearchParams): "today" | "7d" | "30d" {
  for (const key of query.keys()) if (key !== "range" || query.getAll(key).length !== 1) throw invalid("Unsupported finance overview query", key);
  const range = query.get("range") ?? "7d";
  if (range !== "today" && range !== "7d" && range !== "30d") throw invalid("Invalid finance overview range", "range");
  return range;
}
const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Finance overview facts unavailable");
function count(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw unavailable();
  return value;
}
function nonnegative(value: unknown): string { const amount = exactCents(value); if (BigInt(amount) < 0n) throw unavailable(); return amount; }

/** Authorized finance.read only. The caller supplies one read-only repeatable-read snapshot. */
export async function readAdminFinanceOverview(client: PoolClient, range: "today" | "7d" | "30d", documentReadable: boolean, channelConfigured: boolean) {
  const clock = (await client.query<{as_of:string;starts_at:string}>(
    `SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS as_of,
      to_char(((date_trunc('day',transaction_timestamp() AT TIME ZONE 'Asia/Shanghai')-($1::int-1)*interval '1 day') AT TIME ZONE 'Asia/Shanghai') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at`,
    [range === "today" ? 1 : range === "7d" ? 7 : 30])).rows[0];
  if (!clock?.as_of || !clock.starts_at) throw unavailable();
  const period = [clock.starts_at, clock.as_of];
  const paid = (await client.query(`/* finance overview original accepted payments */
    SELECT count(*)::text AS count,COALESCE(sum(p.amount_cents),0)::text AS amount,
      COALESCE(sum(p.amount_cents) FILTER(WHERE p.source='CONTROLLED'),0)::text AS controlled,
      COALESCE(sum(p.amount_cents) FILTER(WHERE p.source='JOINPAY'),0)::text AS channel
    FROM zzsh_order.payment_confirmation p JOIN zzsh_order.rental_order o ON o.id=p.order_id AND o.paid_confirmation_id=p.id
    WHERE p.disposition='APPLIED' AND p.currency='CNY' AND o.paid_at>=$1::timestamptz AND o.paid_at<=$2::timestamptz`, period)).rows[0];
  const legacyAvailable = (await client.query<{ readable: boolean }>(`/* finance overview legacy paid order access */
    SELECT COALESCE(has_table_privilege(to_regclass('zzsh_order.legacy_order_read_snapshot'),'SELECT'),false) AS readable`)).rows[0]?.readable === true;
  const legacyPaid = legacyAvailable ? (await client.query(`/* finance overview legacy paid order facts */
    SELECT count(*) FILTER (WHERE in_period AND amount IS NOT NULL)::text AS count,
      COALESCE(sum(amount) FILTER (WHERE in_period),0)::text AS amount,
      count(*) FILTER (WHERE in_period AND amount IS NULL)::text AS missing_amount_count,
      count(*) FILTER (WHERE source_paid_at IS NULL)::text AS undated_count
    FROM (SELECT source_paid_at,source_paid_at >= $1::timestamptz AND source_paid_at <= $2::timestamptz AS in_period,
      CASE WHEN recorded_paid_amount_cents >= 0 THEN recorded_paid_amount_cents END AS amount
      FROM zzsh_order.legacy_order_read_snapshot
      WHERE source_system='legacy_mysql_restore' AND source_entity='la_order' AND source_pay_status=1
        AND COALESCE(source_snapshot->>'is_delete','0')='0') paid_orders`, period)).rows[0] : null;
  const settled = (await client.query(`/* finance overview period settlement allocation */
    SELECT count(*)::text AS count,COALESCE(sum(captured_cents),0)::text AS captured,
      COALESCE(sum(owner_net_cents),0)::text AS owner,COALESCE(sum(renter_refund_cents),0)::text AS refund,
      COALESCE(sum(platform_contribution_cents),0)::text AS platform FROM zzsh_order.settlement_posting
    WHERE posted_at>=$1::timestamptz AND posted_at<=$2::timestamptz`, period)).rows[0];
  const pending = (await client.query(`/* finance overview current paid unallocated */
    SELECT count(*)::text AS count,COALESCE(sum(p.amount_cents),0)::text AS amount
    FROM zzsh_order.rental_order o JOIN zzsh_order.payment_confirmation p ON p.id=o.paid_confirmation_id AND p.order_id=o.id
    WHERE o.status='PAID' AND p.disposition='APPLIED' AND p.currency='CNY'`)).rows[0];
  const preview = (await client.query<{id:string;number:string;amount:string;paid_at:string}>(`/* finance overview current paid preview */
    SELECT o.id,o.display_no AS number,p.amount_cents::text AS amount,
      to_char(o.paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS paid_at
    FROM zzsh_order.rental_order o JOIN zzsh_order.payment_confirmation p ON p.id=o.paid_confirmation_id AND p.order_id=o.id
    WHERE o.status='PAID' AND p.disposition='APPLIED' AND p.currency='CNY' ORDER BY o.paid_at,o.id LIMIT 5`)).rows;
  const review = (await client.query(`/* finance overview current review payments */
    SELECT count(*)::text AS count,COALESCE(sum(amount_cents) FILTER(WHERE currency='CNY'),0)::text AS amount,
      count(*) FILTER(WHERE currency IS DISTINCT FROM 'CNY')::text AS unknown_count
    FROM zzsh_order.payment_confirmation WHERE disposition='REVIEW_REQUIRED' AND accepted_at<=$1::timestamptz`,[clock.as_of])).rows[0];
  const reviewPreview = (await client.query(`/* finance overview current review preview */
    SELECT p.id,o.id AS order_id,o.display_no AS number,p.amount_cents::text AS amount,p.currency,p.source,p.reason_code,
      to_char(p.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS confirmed_at
    FROM zzsh_order.payment_confirmation p LEFT JOIN zzsh_order.rental_order o ON o.id=p.order_id
    WHERE p.disposition='REVIEW_REQUIRED' AND p.accepted_at<=$1::timestamptz ORDER BY p.accepted_at,p.id LIMIT 5`,[clock.as_of])).rows;
  const recent = (await client.query(`/* finance overview recent verified allocations */
    SELECT p.order_id AS id,o.display_no AS number,o.owner_user_id,o.renter_user_id,owner.name AS owner_name,renter.name AS renter_name,
      p.captured_cents::text AS captured,p.owner_net_cents::text AS owner,p.renter_refund_cents::text AS refund,p.platform_contribution_cents::text AS platform,
      to_char(p.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS posted_at
    FROM zzsh_order.settlement_posting p JOIN zzsh_order.rental_order o ON o.id=p.order_id
    LEFT JOIN zzsh_auth_user."user" owner ON owner.id=o.owner_user_id LEFT JOIN zzsh_auth_user."user" renter ON renter.id=o.renter_user_id
    WHERE p.posted_at>=$1::timestamptz AND p.posted_at<=$2::timestamptz ORDER BY p.posted_at DESC,p.id DESC LIMIT 5`,period)).rows;
  const balances = (await client.query<{bucket:string;balance:string}>(`/* finance overview current ledger balances, not cash */
    SELECT ${FINANCE_LEDGER_BUCKET_SQL} AS bucket,COALESCE(sum(r.credit_cents-r.debit_cents),0)::text AS balance
    FROM zzsh_order.settlement_ledger_entry r WHERE r.created_at<=$1::timestamptz GROUP BY ${FINANCE_LEDGER_BUCKET_SQL}`, [clock.as_of])).rows;
  const coverage = (await client.query(`/* finance overview registered subject coverage, not global proof */
    SELECT (SELECT count(*)::text FROM zzsh_order.wallet_coverage) AS registered,
      (SELECT count(*)::text FROM zzsh_auth_user."user") AS subjects`)).rows[0];
  if (!paid || !settled || !pending || !coverage || !review) throw unavailable();
  const captured = nonnegative(settled.captured), owner = nonnegative(settled.owner), refund = nonnegative(settled.refund), platform = nonnegative(settled.platform);
  if (BigInt(captured) !== BigInt(owner) + BigInt(refund) + BigInt(platform)) throw unavailable();
  const seen = new Set<string>();
  for (const row of balances) {
    if (!(FINANCE_BUCKETS as readonly string[]).includes(row.bucket) || seen.has(row.bucket)) throw unavailable();
    exactCents(row.balance); seen.add(row.bucket);
  }
  const paidCents=nonnegative(paid.amount),controlledCents=nonnegative(paid.controlled),channelCents=nonnegative(paid.channel);
  if(BigInt(paidCents)!==BigInt(controlledCents)+BigInt(channelCents)||BigInt(count(review.unknown_count))>BigInt(count(review.count)))throw unavailable();
  if (legacyAvailable && !legacyPaid) throw unavailable();
  const legacyOrderPayments = legacyPaid ? {
    state: "RECORDED" as const, count: count(legacyPaid.count), knownAmountCents: nonnegative(legacyPaid.amount),
    missingAmountCount: count(legacyPaid.missing_amount_count), sourceUndatedCount: count(legacyPaid.undated_count),
    timeBasis: "source_paid_at" as const,
  } : { state: "UNAVAILABLE" as const, count: null, knownAmountCents: null, missingAmountCount: null, sourceUndatedCount: null, timeBasis: "source_paid_at" as const };
  const recentSettlements=recent.map(row=>{
    const capturedCents=nonnegative(row.captured),ownerNetCents=nonnegative(row.owner),refundPayableCents=nonnegative(row.refund),platformContributionCents=nonnegative(row.platform);
    if(BigInt(capturedCents)!==BigInt(ownerNetCents)+BigInt(refundPayableCents)+BigInt(platformContributionCents))throw unavailable();
    return{id:row.id as string,number:row.number as string,owner:{id:row.owner_user_id as string,name:displayName(row.owner_name,'号主')},renter:{id:row.renter_user_id as string,name:displayName(row.renter_name,'租客')},
      capturedCents,ownerNetCents,refundPayableCents,platformContributionCents,postedAt:row.posted_at as string,documentRef:documentReadable?'ORDER:'+row.id:null};
  });
  const queues=await readAdminFinanceObligationQueues(client,clock.as_of,documentReadable);
  return {
    version:"admin.finance-overview.v1" as const,asOf:clock.as_of,period:{range,from:clock.starts_at,to:clock.as_of,timeZone:"Asia/Shanghai"},
    confirmedPayments:{count:count(paid.count),amountCents:paidCents,controlledAmountCents:controlledCents,channelAmountCents:channelCents,
      source:"CURRENT_APPLIED_ORIGINAL" as const,timeBasis:"paid_at",scope:"NATIVE_ORDER_ORIGINAL_ONLY",reasonCodes:["EXCLUDES_HANDOFF_TOPUPS_GUARANTEE_AND_LEGACY_OBSERVATIONS","CHANNEL_CLEARING_NOT_PROVED"]},
    legacyOrderPayments,
    settlements:{count:count(settled.count),capturedCents:captured,ownerNetCents:owner,refundPayableCents:refund,platformContributionCents:platform,timeBasis:"posted_at",reasonCodes:["ALLOCATION_NOT_PAYMENT_PERIOD","PLATFORM_CONTRIBUTION_IS_NOT_NET_PROFIT"]},
    pendingSettlement:{count:count(pending.count),amountCents:nonnegative(pending.amount),hasMore:BigInt(count(pending.count))>BigInt(preview.length),
      items:preview.map(row=>({id:row.id,number:row.number,status:"PAID",amountCents:nonnegative(row.amount),paidAt:row.paid_at,documentRef:documentReadable?"ORDER:"+row.id:null})),reasonCodes:["CURRENT_CONFIRMED_PAYMENT_AWAITING_ALLOCATION_NOT_OVERDUE"]},
    reviewPayments:{count:count(review.count),amountCents:nonnegative(review.amount),unknownCount:count(review.unknown_count),hasMore:BigInt(count(review.count))>BigInt(reviewPreview.length),
      sourceScope:'ORIGINAL_REVIEW_RECORDS',currentOutstandingOnly:false,
      items:reviewPreview.map(row=>({id:row.id as string,number:row.number as string|null,amountCents:row.currency==='CNY'?nonnegative(row.amount):null,confirmedAt:row.confirmed_at as string,
        reasonCode:row.reason_code as string,source:row.source as string,documentRef:documentReadable&&row.order_id?'ORDER:'+row.order_id:null})),reasonCodes:['REVIEW_RECORD_MAY_HAVE_BEEN_WRITTEN_OFF','CURRENT_RESPONSIBILITY_IN_REFUND_QUEUE','BANK_ARRIVAL_NOT_PROVED']},
    recentSettlements,
    ledgerBalances:FINANCE_BUCKETS.map(bucket=>({bucket,balanceCents:balances.find(row=>row.bucket===bucket)?.balance??"0",state:"KNOWN" as const,source:"POSTED_LEDGER_ONLY" as const})),
    coverage:{registeredSubjects:count(coverage.registered),totalCurrentSubjects:count(coverage.subjects),globalProof:"UNPROVEN",reasonCodes:["CURRENT_DATABASE_MEMBERSHIP_IS_NOT_COMPLETE_LEGACY_SOURCE_PROOF","BOOK_BALANCE_IS_NOT_CHANNEL_CASH"]},
    queues,
    costs:{netContributionCents:null,channelCostState:"NOT_ADMITTED",reasonCodes:["ORDER_COST_COVERAGE_NOT_COMPLETE"]},
    channels:{state:channelConfigured?"CONFIGURED_NOT_OBSERVED":"NOT_CONFIGURED"},
  };
}
