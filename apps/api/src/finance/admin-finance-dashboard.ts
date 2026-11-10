import type { PoolClient } from 'pg';
import { gameScopeSql } from '../auth/admin-scope';
import { quoteAmountCentsSql, quoteCentsSql } from '../auth/admin-dashboard';
import { SecurityApiError } from '../auth/security-core';
import { parseRfc3339Timestamp } from '../content/content';
import { invalid } from '../supply/supply-util';
import { displayName } from './admin-finance-read';

export type DashboardRange = 'today' | '7d' | '30d' | 'all' | 'custom';
export type DashboardQuery = { range: DashboardRange; from?: string; to?: string; basis: 'settled' | 'paid'; limit: 20 | 50; source: 'all' | 'new' | 'legacy' };
type Viewer = { adminId: string; isBoss: boolean; quoteRead?: boolean };

function day(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

export function parseFinanceDashboardQuery(query: URLSearchParams): DashboardQuery {
  for (const key of query.keys()) if (!['range', 'from', 'to', 'basis', 'limit', 'source'].includes(key) || query.getAll(key).length !== 1) throw invalid('Unsupported dashboard query', key);
  const range = query.get('range') ?? '7d', basis = query.get('basis') ?? 'settled', limit = query.get('limit') ?? '20', source = query.get('source') ?? 'all';
  if (!['today', '7d', '30d', 'all', 'custom'].includes(range)) throw invalid('Invalid dashboard range', 'range');
  if (!['settled', 'paid'].includes(basis)) throw invalid('Invalid dashboard time basis', 'basis');
  if (!['20', '50'].includes(limit)) throw invalid('Invalid dashboard limit', 'limit');
  if (!['all', 'new', 'legacy'].includes(source)) throw invalid('Invalid dashboard source', 'source');
  const from = query.get('from') ?? undefined, to = query.get('to') ?? undefined;
  if (range === 'custom') {
    if (!from || !to || !day(from) || !day(to) || from > to || Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`) > 366 * 86400000) throw invalid('Invalid dashboard date range', 'from');
  } else if (from || to) throw invalid('Dates require a custom range', 'from');
  return { range: range as DashboardRange, from, to, basis: basis as DashboardQuery['basis'], limit: Number(limit) as 20 | 50, source: source as DashboardQuery['source'] };
}

async function bounds(client: PoolClient, query: DashboardQuery) {
  const clock = (await client.query<{ today: string; as_of: string }>(`SELECT to_char(transaction_timestamp() AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS today,
    to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS as_of`)).rows[0];
  if (!clock || !day(clock.today)) throw new Error('Dashboard clock unavailable');
  if (query.range === 'custom' && query.to! > clock.today) throw invalid('Future dates are unavailable', 'to');
  const to = query.range === 'custom' ? query.to! : clock.today;
  let from = query.range === 'custom' ? query.from! : query.range === 'all' ? null : to;
  if (from && (query.range === '7d' || query.range === '30d')) {
    const date = new Date(`${from}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - (query.range === '7d' ? 6 : 29));
    from = date.toISOString().slice(0, 10);
  }
  const span = from ? (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400000 : Infinity;
  return { from, to, asOf: clock.as_of, granularity: span > 92 ? 'month' as const : 'day' as const };
}

async function sourceAccess(client: PoolClient) {
  const row = (await client.query<{ legacy: boolean; continuation_exists: boolean; continuation_readable: boolean; continuation_evidence: boolean; opening: boolean; demo_exists: boolean; demo_readable: boolean }>(`SELECT
    COALESCE(has_table_privilege(to_regclass('zzsh_order.legacy_order_read_snapshot'),'SELECT'),false) AS legacy,
    to_regclass('zzsh_order.legacy_continuation_version') IS NOT NULL AS continuation_exists,
    COALESCE(has_table_privilege(to_regclass('zzsh_order.legacy_continuation_version'),'SELECT'),false) AS continuation_readable,
    COALESCE(has_table_privilege(to_regclass('zzsh_order.legacy_continuation_evidence'),'SELECT'),false) AS continuation_evidence,
    COALESCE(has_table_privilege(to_regclass('zzsh_order.finance_opening_basis'),'SELECT'),false) AS opening,
    to_regclass('zzsh_order.ecs_test_demo_finance_registration') IS NOT NULL AS demo_exists,
    COALESCE(has_table_privilege(to_regclass('zzsh_order.ecs_test_demo_finance_registration'),'SELECT'),false) AS demo_readable`)).rows[0];
  if (row?.demo_exists === true && row.demo_readable !== true) throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Test data classification is unavailable');
  return { legacy: row?.legacy === true, continuationReadable: row?.continuation_exists !== true || row?.continuation_readable === true,
    continuationExists: row?.continuation_exists === true, continuationEvidence: row?.continuation_evidence === true, opening: row?.opening === true, demo: row?.demo_exists === true };
}

const inPeriod = (column: string) => `($1::date IS NULL OR ${column} >= ($1::date::timestamp AT TIME ZONE 'Asia/Shanghai')) AND ${column} < (($2::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai') AND ${column} <= transaction_timestamp()`;
const historical = `l.source_system='legacy_mysql_restore' AND l.source_entity='la_order' AND l.source_pay_status=1 AND COALESCE(l.source_snapshot->>'is_delete','0')='0'`;
const safeMoney = (field: string) => `CASE WHEN l.source_snapshot->>'${field}' ~ '^-?(0|[1-9][0-9]{0,22})[.][0-9]{2}$' THEN trunc((l.source_snapshot->>'${field}')::numeric*100) END`;
export const legacyGross = () => {
  const owner = safeMoney('sale_earnings'), refund = safeMoney('return_order_money'), fee = safeMoney('full_payout_money');
  return `CASE WHEN l.recorded_paid_amount_cents>=0 AND ${owner}>=0 AND ${refund}>=0 AND ${fee}>=0 AND ${owner}>=${fee}
    THEN l.recorded_paid_amount_cents - ${owner} - ${refund} + ${fee} END`;
};
const continuationMoney = (field: string) => `CASE WHEN h.amounts->>'${field}' ~ '^(0|[1-9][0-9]{0,21})([.][0-9]{1,8})?$'
  THEN CASE WHEN (h.amounts->>'${field}')::numeric*100=trunc((h.amounts->>'${field}')::numeric*100)
    THEN trunc((h.amounts->>'${field}')::numeric*100) END END`;
export const continuationGross = () => {
  const pay = continuationMoney('payMoney'), owner = continuationMoney('ownerNet'), refund = continuationMoney('refundNet');
  return `CASE WHEN ${pay}=l.recorded_paid_amount_cents AND ${owner}>=0 AND ${refund}>=0 AND ${pay}>=${owner}+${refund}
    THEN ${pay}-${owner}-${refund} END`;
};
const nonDemoContinuation = (access: Awaited<ReturnType<typeof sourceAccess>>, alias: string) => access.demo
  ? `AND NOT EXISTS(SELECT 1 FROM zzsh_order.ecs_test_demo_finance_registration demo WHERE ${alias}.created_at>=demo.registered_at)` : '';
const continuationFrom = (access: Awaited<ReturnType<typeof sourceAccess>>) => `FROM zzsh_order.legacy_order_read_snapshot l
  JOIN zzsh_order.legacy_continuation_version h ON h.order_id=l.id AND h.command='CONFIRM' AND h.stage=4
    ${nonDemoContinuation(access,'h')}
    AND h.id=(SELECT h2.id FROM zzsh_order.legacy_continuation_version h2 WHERE h2.order_id=l.id AND h2.command='CONFIRM' ${nonDemoContinuation(access,'h2')} ORDER BY h2.revision DESC LIMIT 1)
  JOIN zzsh_order.legacy_continuation_evidence e ON e.id=h.result_evidence_id AND e.order_id=l.id AND e.source_kind='DERIVED'
    AND e.derived_from_command_version_id=h.id AND e.admission='PARAMETER_COMPLETE' AND e.source_digest=l.source_digest
    AND e.facts_canonical::jsonb=e.facts AND e.facts_digest=encode(sha256(convert_to(e.facts_canonical,'UTF8')),'hex') AND h.amounts=e.facts->'amounts'`;
function settlementFactsSql(query: DashboardQuery, access: Awaited<ReturnType<typeof sourceAccess>>, basis: 'settled' | 'paid', includeEvidence = false, idsParameter?: string) {
  const nativeScope = gameScopeSql('o.game_id', '$3', '$4'), legacyScope = gameScopeSql('l.game_id', '$3', '$4');
  const oldTime = basis === 'settled' ? 'l.source_completed_at' : 'l.source_paid_at';
  const newTime = basis === 'settled' ? 'p.posted_at' : 'o.paid_at';
  const continuationTime = basis === 'settled' ? 'h.created_at' : 'l.source_paid_at';
  const untouched = access.continuationExists ? `AND NOT EXISTS (SELECT 1 FROM zzsh_order.legacy_continuation_version h WHERE h.order_id=l.id AND h.command='CONFIRM' ${nonDemoContinuation(access,'h')})` : '';
  const oldOwner = safeMoney('sale_earnings'), oldFee = safeMoney('full_payout_money'), oldRefund = safeMoney('return_order_money');
  const ids = (alias:string) => idsParameter ? `AND ${alias}.id=ANY(${idsParameter}::text[])` : '';
  return `SELECT o.id AS order_id,o.display_no AS number,o.renter_user_id AS user_id,${newTime} AS at,
    p.captured_cents AS paid,${includeEvidence ? 'p.owner_net_cents' : 'NULL::numeric'} AS owner,${includeEvidence ? 'p.renter_refund_cents' : 'NULL::numeric'} AS refund,p.platform_contribution_cents AS contribution,'NATIVE'::text AS source,NULL::numeric AS compensation
    FROM zzsh_order.settlement_posting p JOIN zzsh_order.rental_order o ON o.id=p.order_id
    ${access.demo ? "JOIN zzsh_order.payment_confirmation actual ON actual.id=p.payment_confirmation_id AND actual.order_id=o.id AND actual.source='JOINPAY' AND actual.disposition='APPLIED'" : ''}
    WHERE ${query.source === 'legacy' ? 'false AND' : ''} ${nativeScope} AND ${inPeriod(newTime)} ${ids('o')}
    ${access.legacy && access.continuationReadable && query.source !== 'new' ? `UNION ALL
      SELECT l.id,l.original_order_no,l.renter_user_id,${oldTime},l.recorded_paid_amount_cents,
        ${includeEvidence ? `CASE WHEN ${oldOwner}>=0 AND ${oldFee}>=0 AND ${oldOwner}>=${oldFee} THEN ${oldOwner}-${oldFee} END` : 'NULL::numeric'},
        ${includeEvidence ? `CASE WHEN ${oldRefund}>=0 THEN ${oldRefund} END` : 'NULL::numeric'},${legacyGross()},'LEGACY',${safeMoney('compensation')}
      FROM zzsh_order.legacy_order_read_snapshot l WHERE ${historical} AND l.source_order_status=4 AND ${legacyScope} AND ${inPeriod(oldTime)} ${untouched} ${ids('l')}` : ''}
    ${access.legacy && access.continuationExists && access.continuationReadable && access.continuationEvidence && query.source !== 'new' ? `UNION ALL
      SELECT l.id,l.original_order_no,l.renter_user_id,${continuationTime},l.recorded_paid_amount_cents,
        ${includeEvidence ? continuationMoney('ownerNet') : 'NULL::numeric'},
        ${includeEvidence ? continuationMoney('refundNet') : 'NULL::numeric'},
        ${continuationGross()},'LEGACY',${safeMoney('compensation')}
      ${continuationFrom(access)} WHERE ${historical} AND ${legacyScope} AND ${inPeriod(continuationTime)} ${ids('l')}` : ''}`;
}

/** Paid orders are business facts; neither old source status nor a local confirmation proves channel arrival. */
export async function readFinanceDashboardTrend(client: PoolClient, query: DashboardQuery, viewer: Viewer) {
  const period = await bounds(client, query), access = await sourceAccess(client);
  const nativeScope = gameScopeSql('o.game_id', '$3', '$4'), legacyScope = gameScopeSql('l.game_id', '$3', '$4');
  const values = [period.from, period.to, viewer.adminId, viewer.isBoss, period.granularity];
  const head = access.continuationExists && access.continuationReadable ? access.demo
    ? `LEFT JOIN zzsh_order.legacy_continuation_version current_head ON current_head.id=(SELECT candidate.id FROM zzsh_order.legacy_continuation_version candidate WHERE candidate.order_id=l.id ${nonDemoContinuation(access,'candidate')} ORDER BY candidate.revision DESC LIMIT 1)`
    : `LEFT JOIN zzsh_order.legacy_continuation_version current_head ON current_head.order_id=l.id AND current_head.superseded_at IS NULL` : '';
  const stage = head ? 'COALESCE(current_head.stage,l.source_order_status)' : 'l.source_order_status';
  const quote = quoteCentsSql('o'), resource = quoteAmountCentsSql('o','resourceTotal'), owner = quoteAmountCentsSql('o','ownerTotal');
  const legacyPaid = access.legacy && query.source !== 'new' ? `SELECT l.source_paid_at AS at,l.recorded_paid_amount_cents AS amount,l.renter_user_id AS user_id,
      ${stage} AS stage,l.source_order_status AS source_status,
      ${viewer.quoteRead ? safeMoney('commission_money') : 'NULL::numeric'} AS estimated,
      ${viewer.quoteRead ? safeMoney('sale_earnings') : 'NULL::numeric'} AS owner,
      ${viewer.quoteRead ? safeMoney('return_order_money') : 'NULL::numeric'} AS refund
      FROM zzsh_order.legacy_order_read_snapshot l ${head} WHERE ${historical} AND ${legacyScope} AND ${inPeriod('l.source_paid_at')}`
    : `SELECT NULL::timestamptz AS at,NULL::numeric AS amount,NULL::text AS user_id,NULL::integer AS stage,NULL::integer AS source_status,
      NULL::numeric AS estimated,NULL::numeric AS owner,NULL::numeric AS refund WHERE false`;
  const rows = (await client.query(`/* dashboard paid business trend */ WITH legacy_paid AS MATERIALIZED (${legacyPaid}), facts AS MATERIALIZED (
    SELECT o.paid_at AS at,p.amount_cents AS amount,'NATIVE'::text AS source,o.renter_user_id AS user_id,
      CASE WHEN o.status='COMPLETED' THEN 'COMPLETED' WHEN o.status='CANCELLED' THEN 'CANCELLED' WHEN o.status='PAID' THEN 'ACTIVE' ELSE 'UNKNOWN' END AS state,
      ${viewer.quoteRead ? `CASE WHEN o.status IN('PAID','COMPLETED') AND ${resource}-${owner}=${quote} THEN ${quote} END` : 'NULL::numeric'} AS estimate,
      false AS estimate_discrepant
      FROM zzsh_order.payment_confirmation p JOIN zzsh_order.rental_order o ON o.id=p.order_id AND o.paid_confirmation_id=p.id
      WHERE p.disposition='APPLIED' AND p.currency='CNY' ${access.demo ? "AND p.source='JOINPAY'" : ''} AND ${query.source === 'legacy' ? 'false AND' : ''} ${nativeScope} AND ${inPeriod('o.paid_at')}
    UNION ALL SELECT at,CASE WHEN amount>=0 THEN amount END,'LEGACY',user_id,
      CASE WHEN stage=4 THEN 'COMPLETED' WHEN stage=5 THEN 'CANCELLED' WHEN stage IN(2,3,6,7,8,9) THEN 'ACTIVE' ELSE 'UNKNOWN' END,
      CASE WHEN stage IN(2,3,4,6,7,8,9) THEN estimated END,
      COALESCE(source_status=4 AND estimated IS NOT NULL AND owner>=0 AND refund>=0 AND amount>=0 AND estimated<>(amount-owner-refund),false)
      FROM legacy_paid
  ), settlements AS (${settlementFactsSql(query,access,'settled')}
  ), paid_days AS (SELECT to_char(date_trunc($5::text,at AT TIME ZONE 'Asia/Shanghai'),'YYYY-MM-DD') AS day,
    count(*)::text AS orders,count(amount)::text AS known_amounts,COALESCE(sum(amount),0)::text AS cents,
    count(*) FILTER(WHERE state<>'CANCELLED')::text AS estimate_orders,count(estimate)::text AS estimate_known,
    sum(estimate)::text AS estimate_cents,count(*) FILTER(WHERE estimate_discrepant)::text AS estimate_discrepancies,
    count(*) FILTER(WHERE source='LEGACY')::text AS legacy_orders FROM facts GROUP BY 1),
  settlement_days AS (SELECT to_char(date_trunc($5::text,at AT TIME ZONE 'Asia/Shanghai'),'YYYY-MM-DD') AS day,
    count(*)::text AS settlements,count(contribution)::text AS known_contributions,COALESCE(sum(contribution),0)::text AS contribution
    FROM settlements GROUP BY 1),
  renter_counts AS (SELECT user_id,count(*) AS orders FROM facts GROUP BY user_id),
  frequency AS (SELECT LEAST(orders,6)::int AS orders,count(*)::text AS users FROM renter_counts GROUP BY 1),
  summary AS (SELECT count(*)::text AS total_paid,count(*) FILTER(WHERE state='CANCELLED')::text AS cancelled,
    count(*) FILTER(WHERE state='COMPLETED')::text AS completed,count(*) FILTER(WHERE state='ACTIVE')::text AS active,
    count(*) FILTER(WHERE state='UNKNOWN')::text AS unknown_state,
    count(*) FILTER(WHERE source='NATIVE')::text AS native_orders,count(*) FILTER(WHERE source='LEGACY')::text AS legacy_total,
    (SELECT count(*)::text FROM renter_counts WHERE orders>=2) AS repeat_renters,
    (SELECT COALESCE(jsonb_agg(jsonb_build_object('orders',orders,'users',users) ORDER BY orders),'[]'::jsonb) FROM frequency) AS frequency
    FROM facts)
  SELECT COALESCE(p.day,s.day) AS day,p.orders,p.known_amounts,p.cents,p.legacy_orders,p.estimate_orders,p.estimate_known,p.estimate_cents,p.estimate_discrepancies,s.settlements,s.known_contributions,s.contribution,summary.*
    FROM paid_days p FULL JOIN settlement_days s ON s.day=p.day CROSS JOIN summary ORDER BY 1`, values)).rows;
  if (rows.length) {
    const headRow = rows[0]!, counts = [headRow.completed,headRow.active,headRow.cancelled,headRow.unknown_state,headRow.total_paid].map(String);
    if (counts.some(value => !/^(0|[1-9]\d*)$/.test(value)) || counts.slice(0,4).reduce((total,value) => total + BigInt(value),0n) !== BigInt(counts[4]!))
      throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Dashboard order status totals do not close');
  }
  const opening = access.opening ? (await client.query<{ cutoff: string | null }>(`/* opening cutoff reference, not an order coverage proof */
    SELECT CASE WHEN count(DISTINCT source_cutoff)=1 THEN to_char(min(source_cutoff) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS cutoff
    FROM zzsh_order.finance_opening_basis WHERE source_kind='LEGACY_OPENING' AND source_cutoff IS NOT NULL`)).rows[0]?.cutoff ?? null : null;
  return { version: 'admin.finance-dashboard-trend.v1' as const, period, legacy: access.legacy ? 'RECORDED_PARTIAL' : 'UNAVAILABLE',
    estimateState: viewer.quoteRead ? 'RECORDED_PARTIAL' : 'FORBIDDEN',
    continuations: !access.continuationExists ? 'NONE' : access.continuationReadable && access.continuationEvidence ? 'RECORDED_PARTIAL' : 'UNAVAILABLE', openingReferenceAt: opening,
    insights: rows.length ? { cancelled: String(rows[0]!.cancelled), completed: String(rows[0]!.completed), active: String(rows[0]!.active),
      unknown: String(rows[0]!.unknown_state), repeatRenters: String(rows[0]!.repeat_renters), nativeOrders: String(rows[0]!.native_orders),
      legacyOrders: String(rows[0]!.legacy_total), frequency: rows[0]!.frequency as { orders: number; users: string }[] } : null,
    points: rows.map(row => ({ date: String(row.day), orders: row.orders === null ? null : String(row.orders), knownAmounts: row.known_amounts === null ? null : String(row.known_amounts),
      cents: row.cents === null ? null : String(row.cents), legacyOrders: row.legacy_orders === null ? null : String(row.legacy_orders),
      estimateOrders: row.estimate_orders === null ? null : String(row.estimate_orders), estimateKnown: row.estimate_known === null ? null : String(row.estimate_known),
      estimateCents: row.estimate_cents === null ? null : String(row.estimate_cents), estimateDiscrepancies: row.estimate_discrepancies === null ? null : String(row.estimate_discrepancies),
      settlements: row.settlements === null ? null : String(row.settlements), knownContributions: row.known_contributions === null ? null : String(row.known_contributions),
      contributionCents: row.contribution === null ? null : String(row.contribution) })) };
}

/** Historical completions, sealed continuation confirmations and native postings share one contribution predicate. */
export async function readFinanceDashboardCustomers(client: PoolClient, query: DashboardQuery, viewer: Viewer) {
  const period = await bounds(client, query), access = await sourceAccess(client);
  const includeLegacy = access.legacy && access.continuationReadable;
  const rows = (await client.query(`/* dashboard customer gross contribution */ WITH facts AS (${settlementFactsSql(query,access,query.basis)}
  ), grouped AS (SELECT user_id,count(*) FILTER(WHERE contribution IS NOT NULL)::text AS orders,
      sum(paid) FILTER(WHERE contribution IS NOT NULL)::text AS paid,
      sum(contribution)::text AS contribution,max(at) FILTER(WHERE contribution IS NOT NULL) AS latest,
      count(*) FILTER(WHERE contribution IS NULL)::text AS omitted,
      count(*) FILTER(WHERE source='LEGACY' AND contribution IS NOT NULL)::text AS legacy_orders,
      count(compensation) FILTER(WHERE contribution IS NOT NULL)::text AS compensation_records,
      sum(compensation) FILTER(WHERE contribution IS NOT NULL)::text AS compensation_cents
    FROM facts GROUP BY user_id),
  ranked AS (SELECT g.*,u.name FROM grouped g JOIN zzsh_auth_user."user" u ON u.id=g.user_id
    WHERE g.contribution IS NOT NULL ORDER BY g.contribution::numeric DESC,g.user_id LIMIT $5),
  coverage AS (SELECT count(*) FILTER(WHERE contribution IS NULL)::text AS omitted_total FROM facts)
  SELECT ranked.*,coverage.omitted_total FROM coverage LEFT JOIN ranked ON true
    ORDER BY ranked.contribution::numeric DESC NULLS LAST,ranked.user_id`,
    [period.from, period.to, viewer.adminId, viewer.isBoss, query.limit])).rows;
  return { version: 'admin.finance-dashboard-customers.v1' as const, period, basis: query.basis, limit: query.limit,
    legacy: includeLegacy ? 'RECORDED_PARTIAL' : 'UNAVAILABLE',
    continuations: !access.continuationExists ? 'NONE' : access.continuationReadable && access.continuationEvidence ? 'RECORDED_PARTIAL' : 'UNAVAILABLE',
    omittedCount: String(rows[0]?.omitted_total ?? '0'),
    items: rows.filter(row => row.user_id !== null).map(row => ({ userId: String(row.user_id), name: displayName(row.name, '用户'), orderCount: String(row.orders),
      paidCents: String(row.paid), contributionCents: String(row.contribution), latestAt: row.latest instanceof Date ? row.latest.toISOString() : String(row.latest),
      omittedCount: String(row.omitted), legacyOrderCount: String(row.legacy_orders), compensationRecordCount: String(row.compensation_records),
      historicalCompensationCents: row.compensation_cents === null ? null : String(row.compensation_cents) })) };
}

export function parseFinanceDashboardContributionQuery(query: URLSearchParams) {
  for (const key of ['page','pageSize','userId','asOf']) if (query.getAll(key).length > 1) throw invalid('Repeated contribution filter',key);
  const page = query.get('page') ?? '1', pageSize=query.get('pageSize') ?? '20', userId = query.get('userId'), asOf = query.get('asOf');
  if (!/^[1-9]\d{0,4}$/.test(page)) throw invalid('Invalid contribution page','page');
  if (!['20','50','100'].includes(pageSize)) throw invalid('Invalid contribution page size','pageSize');
  if (userId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(userId)) throw invalid('Invalid contribution user','userId');
  if (!asOf || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/.test(asOf)) throw invalid('Invalid contribution snapshot','asOf');
  parseRfc3339Timestamp(asOf,'asOf');
  const base = new URLSearchParams(query); base.delete('page'); base.delete('pageSize'); base.delete('userId'); base.delete('asOf');
  return { ...parseFinanceDashboardQuery(base), page:Number(page), pageSize:Number(pageSize), userId, asOf };
}

/** Uses the same facts and formula as the chart/ranking; no channel or ledger write occurs. */
export async function readFinanceDashboardContributions(client: PoolClient, query: ReturnType<typeof parseFinanceDashboardContributionQuery>, viewer: Viewer) {
  const period = await bounds(client,query), access = await sourceAccess(client);
  if (query.asOf > period.asOf) throw invalid('Contribution snapshot is in the future','asOf');
  const rows = (await client.query(`/* dashboard contribution evidence */ WITH facts AS MATERIALIZED (${settlementFactsSql(query,access,query.basis)}),
    filtered AS (SELECT * FROM facts WHERE at<=$5::timestamptz AND ($6::text IS NULL OR user_id=$6)
      ${query.userId ? 'AND contribution IS NOT NULL' : ''}),
    selected AS (SELECT * FROM filtered ORDER BY at DESC,order_id DESC LIMIT $7 OFFSET $8)
    SELECT (SELECT count(*)::text FROM filtered) AS total,(SELECT count(contribution)::text FROM filtered) AS known,
      (SELECT sum(contribution)::text FROM filtered) AS cents,
      COALESCE(jsonb_agg(jsonb_build_object('orderId',order_id,'number',number,'source',source,
        'at',to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),'paidCents',paid::text,'contributionCents',contribution::text)
        ORDER BY at DESC,order_id DESC) FILTER(WHERE order_id IS NOT NULL),'[]'::jsonb) AS items
    FROM selected`,[period.from,period.to,viewer.adminId,viewer.isBoss,query.asOf,query.userId,query.pageSize,(query.page-1)*query.pageSize])).rows[0];
  if (!rows || !Array.isArray(rows.items)) throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Contribution details unavailable');
  const items = rows.items as {orderId:string;source:string;paidCents:string|null;contributionCents:string|null}[], ids = [...new Set(items.map(item=>item.orderId))];
  const evidence = ids.length ? (await client.query(`/* dashboard selected contribution components */
    SELECT order_id,source,owner::text AS owner,refund::text AS refund FROM (${settlementFactsSql(query,access,query.basis,true,'$5')}) selected`,
    [period.from,period.to,viewer.adminId,viewer.isBoss,ids])).rows : [];
  const byKey = new Map(evidence.map(row=>[`${row.source}\0${row.order_id}`,row]));
  const withEvidence = items.map(item=>{const row=byKey.get(`${item.source}\0${item.orderId}`);
    if (!row) throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Selected contribution evidence unavailable');
    const ownerCents=row.owner === null ? null : String(row.owner),refundCents=row.refund === null ? null : String(row.refund);
    if (item.contributionCents !== null) {
      const values=[item.paidCents,ownerCents,refundCents,item.contributionCents];
      if (values.some(value=>typeof value!=='string'||!/^-?(0|[1-9]\d*)$/.test(value))
        || BigInt(item.paidCents!) !== BigInt(ownerCents!) + BigInt(refundCents!) + BigInt(item.contributionCents))
        throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Contribution components do not close');
    }
    return {...item,ownerCents,refundCents};
  });
  return { version:'admin.finance-dashboard-contributions.v1' as const, basis:query.basis, asOf:query.asOf, page:query.page, pageSize:query.pageSize,
    total:String(rows.total), knownCount:String(rows.known), knownCents:rows.cents === null ? null : String(rows.cents), items:withEvidence };
}

/** Only saved formal evidence for explicitly granted merchants; local controlled results are excluded. */
export async function readFinanceDashboardChannels(client: PoolClient, query: DashboardQuery, viewer: Viewer, merchantIds: string[]) {
  const period = await bounds(client, query);
  const required = ['payment_confirmation','payment_channel_transaction','channel_refund_intent','joinpay_refund_evidence','joinpay_withdrawal_intent','joinpay_payout_evidence'];
  const readable = (await client.query<{ ready: boolean }>(`SELECT bool_and(COALESCE(has_table_privilege(to_regclass('zzsh_order.'||name),'SELECT'),false)) AS ready FROM unnest($1::text[]) AS t(name)`, [required])).rows[0]?.ready === true;
  if (!readable) return { version: 'admin.finance-dashboard-channels.v1' as const, period, state: 'UNAVAILABLE' as const, items: [] };
  const scope = gameScopeSql('o.game_id', '$3', '$4');
  const rows = (await client.query(`/* dashboard verified channel facts */ WITH facts AS (
    SELECT 'PAYMENT'::text AS kind,p.amount_cents AS amount,p.provider_paid_at AS at
      FROM zzsh_order.payment_confirmation p JOIN zzsh_order.payment_channel_transaction a ON a.id=p.joinpay_anchor_id
      JOIN zzsh_order.rental_order o ON o.id=p.order_id
      WHERE p.source='JOINPAY' AND p.disposition='APPLIED' AND p.currency='CNY' AND a.channel='JOINPAY' AND a.evidence_level='JOINPAY_VERIFIED'
        AND a.merchant_identity_id=ANY($5::text[]) AND ${scope} AND ${inPeriod('p.provider_paid_at')}
    UNION ALL
    SELECT 'REFUND',i.amount_cents,e.completed_at FROM zzsh_order.channel_refund_intent i
      JOIN zzsh_order.joinpay_refund_evidence e ON e.id=i.terminal_evidence_id AND e.intent_id=i.id
      JOIN zzsh_order.rental_order o ON o.id=i.order_id
      WHERE i.payment_source='JOINPAY' AND i.basis_kind IN ('POSTING','PRESTART_TERMINATION','SUPPORT_CANCELLATION') AND i.state='SUCCEEDED' AND e.terminal='SUCCEEDED'
        AND i.merchant_identity_id=ANY($5::text[]) AND ${scope} AND ${inPeriod('e.completed_at')}
    UNION ALL
    SELECT 'WITHDRAWAL',i.net_cents,e.created_at FROM zzsh_order.joinpay_withdrawal_intent i
      JOIN zzsh_order.joinpay_payout_evidence e ON e.id=i.terminal_evidence_id AND e.intent_id=i.id
      WHERE i.state='SUCCEEDED' AND e.terminal='PAID' AND i.merchant_identity_id=ANY($5::text[]) AND ${inPeriod('e.created_at')}
  ) SELECT kind,count(*)::text AS count,sum(amount)::text AS cents FROM facts GROUP BY kind ORDER BY kind`,
    [period.from, period.to, viewer.adminId, viewer.isBoss, merchantIds])).rows;
  return { version: 'admin.finance-dashboard-channels.v1' as const, period, state: 'RECORDED_PARTIAL' as const,
    items: rows.map(row => ({ kind: String(row.kind), count: String(row.count), cents: String(row.cents) })) };
}
