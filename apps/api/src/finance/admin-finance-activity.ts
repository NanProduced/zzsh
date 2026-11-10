import type { PoolClient } from 'pg';
import { invalid } from '../supply/supply-util';
import { escapeLike } from '../supply/catalog';
import { gameScopeSql } from '../auth/admin-scope';
import { SecurityApiError } from '../auth/security-core';
import { ADMIN_FINANCE_OBSERVATION_SQL, adminFinanceLedgerSql, displayName, parseAdminFinanceFilters, projectAdminFinanceLedger, projectAdminFinanceObservation, type HistoricalRelationAccess } from './admin-finance-read';
import { readWalletHistoricalPurposes } from './personal-wallet-purpose';
import { loadFinanceOrderFacts } from './admin-finance-order-read';
import { enrichHistoricalObservations } from './legacy-observation-display';
import { readDemoLedgerOrigins } from './demo-ledger-provenance';

type Source = 'ALL' | 'NATIVE' | 'LEGACY';
type ChannelKind = 'ALL' | 'PAYMENT' | 'REFUND' | 'WITHDRAWAL';
type BalanceView = 'LIVE' | 'HISTORY' | 'OPENING';
export type ActivityQuery = { q: string; source: Source; kind: ChannelKind; view: BalanceView; page: number; pageSize: number; asOf: string | null; from?:string; to?:string; balanceType?:string; nonzero?:boolean; subjectUserId?:string };
type Candidate = { family: string; id: string; at: string | null };
type Raw = Record<string, any>;

export function parseActivityQuery(params: URLSearchParams, wallet: boolean): ActivityQuery {
  for (const key of params.keys()) if (!['q', 'source', 'kind', 'view', 'page', 'pageSize', 'asOf','from','to','type','nonzero','subjectUserId'].includes(key) || params.getAll(key).length !== 1) throw invalid('Unsupported or repeated finance activity filter');
  const q = (params.get('q') ?? '').trim();
  parseAdminFinanceFilters(new URLSearchParams({ q }), new Date(), false);
  const source = params.get('source') ?? (wallet?'ALL':'NATIVE'), kind = params.get('kind') ?? 'ALL', view = params.get('view') ?? (wallet && source === 'LEGACY' ? 'HISTORY' : 'LIVE');
  const page = params.get('page') ?? '1', size = params.get('pageSize') ?? '20', asOf = params.get('asOf');
  const from=params.get('from')??'',to=params.get('to')??'',balanceType=params.get('type')??'ALL',nonzero=params.get('nonzero')??'0',subjectUserId=params.get('subjectUserId');
  const validDay=(value:string)=>/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number.isFinite(Date.parse(`${value}T00:00:00Z`))&&new Date(`${value}T00:00:00Z`).toISOString().slice(0,10)===value;
  const liveTypes=['ALL','OWNER_INCOME','COMMISSION_INCOME','COMMISSION_REVERSAL','WITHDRAWAL','WITHDRAWAL_RETURN','DEPOSIT_COMPENSATION','FULL_PAYOUT_COMPENSATION','OTHER'];
  const historyTypes=['ALL','SETTLEMENT','WITHDRAWAL','WITHDRAWAL_RETURN','PLATFORM_ADJUSTMENT','DEPOSIT_COMPENSATION','TASK_SETTLEMENT','OTHER'];
  if (!(wallet?['ALL','NATIVE','LEGACY']:['NATIVE','LEGACY']).includes(source) || !(wallet ? ['ALL'] : ['ALL','PAYMENT','REFUND','WITHDRAWAL']).includes(kind)
    || !['LIVE','HISTORY','OPENING'].includes(view) || !wallet && params.has('view') || wallet && params.has('view') && source !== 'ALL'
    || Boolean(from)!==Boolean(to) || from!=='' && (!validDay(from)||!validDay(to)||from>to)
    || !(wallet&&view==='LIVE'?liveTypes:wallet&&view==='HISTORY'?historyTypes:['ALL']).includes(balanceType)
    || !['0','1'].includes(nonzero) || nonzero==='1'&&(!wallet||view!=='OPENING') || wallet&&view==='OPENING'&&(from!==''||to!=='')
    || subjectUserId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(subjectUserId)
    || !/^[1-9]\d{0,6}$/.test(page) || Number(page) > 1_000_000 || !/^[1-9]\d{0,2}$/.test(size) || Number(size) > 100
    || asOf !== null && (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(asOf) || !Number.isFinite(Date.parse(asOf)))
    || Number(page) > 1 && !asOf) throw invalid('Invalid finance activity filter');
  return { q, source: source as Source, kind: kind as ChannelKind, view:view as BalanceView, page: Number(page), pageSize: Number(size), asOf, from,to,balanceType,nonzero:nonzero==='1',...(subjectUserId?{subjectUserId}:{}) };
}

const utc = (value: string) => `to_char(${value} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;
const nameSearch = `(u.id ILIKE $1 ESCAPE '\\' OR COALESCE(u.name,'') ILIKE $1 ESCAPE '\\')`;
const oldSearch = `(o.source_id ILIKE $1 ESCAPE '\\' OR COALESCE(o.snapshot->>'sourceNumber','') ILIKE $1 ESCAPE '\\' OR COALESCE(o.snapshot->>'legacyLogNumber','') ILIKE $1 ESCAPE '\\' OR ${nameSearch}
 OR ($7::boolean AND EXISTS (SELECT 1 FROM zzsh_order.legacy_order_read_snapshot lo WHERE lo.source_system=o.source_system AND lo.source_entity='la_order'
   AND lo.legacy_id=o.snapshot->>'referenceId' AND o.snapshot->>'associationState'='SOURCE_VERIFIED' AND lo.renter_user_id=o.user_id
   AND ${gameScopeSql('lo.game_id','$5','$6')} AND lo.original_order_no ILIKE $1 ESCAPE '\\'))) `;
const exactOldSearch = `(o.id=$1 OR o.source_id=$1 OR COALESCE(o.snapshot->>'sourceNumber','')=$1 OR COALESCE(o.snapshot->>'legacyLogNumber','')=$1)`;
const match = (fields: string[],exact = false) => exact
  ? `($1<>'' AND (${fields.map(field=>`COALESCE(${field},'')=$1`).join(' OR ')}))`
  : `($1='' OR ${[nameSearch, ...fields.map(field => `COALESCE(${field},'') ILIKE $1 ESCAPE '\\'`)].join(' OR ')})`;
const valuesFor = (q: ActivityQuery, asOf: string, access: HistoricalRelationAccess, exact = false) => [q.q ? exact ? q.q : `%${escapeLike(q.q)}%` : '', asOf, q.pageSize, (q.page - 1) * q.pageSize, access.adminId, access.isBoss, access.isBoss || access.orderRead,
  q.from?`${q.from}T00:00:00+08:00`:null,q.to?new Date(Date.parse(`${q.to}T00:00:00+08:00`)+86400_000).toISOString():null,q.balanceType??'ALL',q.nonzero===true,...(q.subjectUserId?[q.subjectUserId]:[])];
const orderVisible = (alias: string) => `($7::boolean AND ${gameScopeSql(`${alias}.game_id`, '$5', '$6')})`;
const orderTerm = (alias: string, number: string) => `(CASE WHEN ${orderVisible(alias)} THEN ${number} ELSE NULL END)`;
const during = (value:string) => `($8::timestamptz IS NULL OR (${value}>=$8::timestamptz AND ${value}<$9::timestamptz))`;
const liveType = `CASE WHEN root.source_kind='NATIVE_RENTAL_REFERRAL' OR root.source_kind='LEGACY_CONTINUATION_DUTY' AND root.beneficiary_role='COMMISSION' THEN CASE WHEN l.credit_cents-l.debit_cents<0 THEN 'COMMISSION_REVERSAL' ELSE 'COMMISSION_INCOME' END
 WHEN root.source_kind='ORDER_COMPENSATION' THEN 'FULL_PAYOUT_COMPENSATION'
 WHEN root.source_entity IN('withdrawal_intent','joinpay_withdrawal_intent') THEN CASE WHEN e.kind IN('RELEASE','JOINPAY_WITHDRAWAL_RELEASED') THEN 'WITHDRAWAL_RETURN' ELSE 'WITHDRAWAL' END
 WHEN root.source_kind='LEGACY_CONTINUATION_DUTY' AND root.beneficiary_role='DEPOSIT_COMPENSATION' THEN 'DEPOSIT_COMPENSATION'
 WHEN l.posting_id IS NOT NULL OR root.source_kind='LEGACY_CONTINUATION_DUTY' AND root.beneficiary_role='OWNER_CREDIT' THEN 'OWNER_INCOME' ELSE 'OTHER' END`;
const historyType = `CASE o.snapshot->>'legacyChangeType' WHEN '1001' THEN 'SETTLEMENT' WHEN '1002' THEN 'WITHDRAWAL' WHEN '1003' THEN 'WITHDRAWAL_RETURN' WHEN '1004' THEN 'WITHDRAWAL_RETURN' WHEN '1005' THEN 'WITHDRAWAL_RETURN' WHEN '1006' THEN 'PLATFORM_ADJUSTMENT' WHEN '1007' THEN 'PLATFORM_ADJUSTMENT' WHEN '1008' THEN 'DEPOSIT_COMPENSATION' WHEN '1009' THEN 'TASK_SETTLEMENT' ELSE 'OTHER' END`;

// The owner can see another user's old payment only when its typed source and order bind to that owner.
const legacyOwnerProof = `$7::boolean AND ${gameScopeSql('lo.game_id','$5','$6')} AND lo.owner_user_id=$12 AND lo.renter_user_id=o.user_id AND o.user_id<>$12
    AND lo.source_system=o.source_system AND lo.source_entity='la_order' AND lo.legacy_id=o.snapshot->>'referenceId'
    AND lo.legacy_renter_id=o.legacy_user_id AND lo.source_snapshot->>'id'=lo.legacy_id AND lo.source_snapshot->>'order_sn'=lo.original_order_no
    AND lo.source_snapshot->>'user_id'=o.legacy_user_id AND COALESCE(lo.source_snapshot->>'is_delete','0')='0'
    AND o.snapshot->>'referenceType'='LEGACY_ORDER' AND o.snapshot->>'associationState'='SOURCE_VERIFIED'
    AND o.snapshot#>>'{rawSource,entity}'=o.source_entity AND proof.raw->>'id'=o.source_id AND proof.raw->>'order_id'=lo.legacy_id
    AND encode(sha256(convert_to(o.source_canonical,'UTF8')),'hex')=o.source_digest
    AND CASE WHEN pg_input_is_valid(o.source_canonical,'jsonb') THEN o.source_canonical::jsonb=o.snapshot ELSE false END
    AND o.source_canonical=zzsh_order.canonical_finance_json(o.snapshot)
    AND encode(sha256(convert_to(o.snapshot#>>'{rawSource,canonical}','UTF8')),'hex')=o.snapshot#>>'{rawSource,digest}'
    AND o.snapshot#>>'{rawSource,canonical}'=zzsh_order.canonical_finance_json(proof.raw)
    AND encode(sha256(convert_to(zzsh_order.canonical_finance_json(lo.source_snapshot),'UTF8')),'hex')=lo.source_digest
    AND ((o.source_entity='la_pay_order' AND o.snapshot->>'sourceOrderType'='1' AND proof.raw->>'order_type'='1'
      AND o.snapshot->>'sourceNumber'=proof.raw->>'pay_order_sn' AND o.snapshot->>'amount'=proof.raw->>'pay_money' AND o.snapshot->>'sourceStatus'=proof.raw->>'pay_is')
      OR (o.source_entity='la_refund_record' AND o.snapshot->>'sourceOrderType'='order' AND proof.raw->>'order_type'='order'
        AND proof.raw->>'user_id'=o.legacy_user_id AND proof.raw->>'order_sn'=lo.original_order_no AND o.snapshot->>'referenceSn'=lo.original_order_no
        AND o.snapshot->>'sourceNumber'=proof.raw->>'sn' AND o.snapshot->>'amount'=proof.raw->>'refund_amount' AND o.snapshot->>'sourceStatus'=proof.raw->>'refund_status'))`;

async function pageCandidates(client: PoolClient, parts: string[], q: ActivityQuery, access: HistoricalRelationAccess, exact = false) {
  const asOf = q.asOf ?? new Date().toISOString();
  const result = (await client.query<Candidate & { total:string }>(`WITH activity_candidates AS MATERIALIZED (
    SELECT family,id,at FROM (${parts.join(' UNION ALL ')}) candidates WHERE $5::text IS NOT NULL AND $6::boolean IS NOT NULL AND $7::boolean IS NOT NULL AND ($8::timestamptz IS NULL OR $9::timestamptz IS NOT NULL) AND $10::text IS NOT NULL AND $11::boolean IS NOT NULL
  ), activity_page AS (SELECT family,id,at FROM activity_candidates ORDER BY at DESC NULLS LAST,family COLLATE "C" DESC,id COLLATE "C" DESC LIMIT $3 OFFSET $4),
  activity_total AS (SELECT count(*)::text AS total FROM activity_candidates)
  SELECT activity_page.family,activity_page.id,activity_page.at,activity_total.total FROM activity_total LEFT JOIN activity_page ON TRUE
  ORDER BY activity_page.at DESC NULLS LAST,activity_page.family COLLATE "C" DESC,activity_page.id COLLATE "C" DESC`, valuesFor(q, asOf, access, exact))).rows;
  const rawTotal = result[0]?.total, total = Number(rawTotal);
  if (typeof rawTotal !== 'string' || !/^(0|[1-9]\d*)$/.test(rawTotal) || !Number.isSafeInteger(total)) throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Finance activity total unavailable');
  const rows = result.filter(row=>row.family !== null && row.id !== null);
  return { asOf, rows, total, hasMore:(q.page-1)*q.pageSize+rows.length<total };
}

async function historyRows(client: PoolClient, ids: string[]) {
  if (!ids.length) return [];
  const sql = ADMIN_FINANCE_OBSERVATION_SQL.replace(/\s+ORDER BY o\.id COLLATE "C" LIMIT \$1\s*$/, ' WHERE o.id=ANY($1::text[])');
  return (await client.query(sql, [ids])).rows as Raw[];
}

const purposeLabels: Record<string,string> = { OWNER_RENTAL_INCOME:'号主租赁收入', DISTRIBUTION_INCOME:'分销收入', WITHDRAWAL_DEBIT:'提现扣除', WITHDRAWAL_REJECTED_RETURN:'提现拒绝退回', TRANSFER_FAILED_RETURN:'提现失败退回', WECHAT_WITHDRAWAL_FAILED_RETURN:'提现失败退回', PLATFORM_CREDIT:'平台加款', PLATFORM_DEBIT:'平台扣款', DEPOSIT_COMPENSATION:'押金补偿', TASK_SETTLEMENT:'任务结算' };

/** Lists the user's available-balance leg only; historical rows never enter the new balance. */
export async function readAdminBalanceActivity(client: PoolClient, q: ActivityQuery, access: HistoricalRelationAccess) {
  const parts: string[] = [];
  if (q.view === 'LIVE') parts.push(`SELECT 'ledger' AS family,l.id,${utc('COALESCE(e.created_at,p.posted_at,l.created_at)')} AS at
    FROM zzsh_order.settlement_ledger_entry l LEFT JOIN zzsh_order.finance_event e ON e.id=l.finance_event_id
    LEFT JOIN zzsh_order.finance_economic_root root ON root.id=e.economic_root_id
    LEFT JOIN zzsh_order.settlement_posting p ON p.id=l.posting_id LEFT JOIN zzsh_order.rental_order ord ON ord.id=p.order_id
    LEFT JOIN zzsh_auth_user."user" u ON u.id=l.counterparty_user_id
    WHERE l.account_code IN ('OWNER_AVAILABLE','WALLET_AVAILABLE') AND l.counterparty_user_id IS NOT NULL AND l.created_at <= $2::timestamptz AND (e.id IS NULL OR e.kind<>'OPENING')
    AND ${during('CASE WHEN l.finance_event_id IS NOT NULL THEN e.created_at ELSE p.posted_at END')} AND ($10='ALL' OR (${liveType})=$10) ${q.subjectUserId?'AND l.counterparty_user_id=$12':''}
    AND ${match(['l.id','root.source_id',orderTerm('ord','ord.display_no')])}`);
  if (q.view === 'OPENING') parts.push(`SELECT 'opening' AS family,b.id,${utc('b.source_cutoff')} AS at
    FROM zzsh_order.finance_opening_basis b JOIN zzsh_order.wallet_coverage c ON c.basis_id=b.id AND c.user_id=b.user_id
    JOIN zzsh_order.finance_event e ON e.id=c.opening_event_id AND e.subject_user_id=b.user_id AND e.kind='OPENING'
    JOIN zzsh_order.finance_economic_root root ON root.id=e.economic_root_id AND root.basis_id=b.id
    LEFT JOIN zzsh_auth_user."user" u ON u.id=b.user_id
    WHERE b.source_kind='LEGACY_OPENING' AND e.created_at <= $2::timestamptz AND (NOT $11::boolean OR b.available_cents<>0) ${q.subjectUserId?'AND b.user_id=$12':''}
    AND ${match(['b.source_id'])}`);
  if (q.view === 'HISTORY') parts.push(`SELECT 'history' AS family,o.id,${utc('COALESCE(o.source_event_at,o.imported_at)')} AS at
    FROM zzsh_order.personal_finance_observation o LEFT JOIN zzsh_auth_user."user" u ON u.id=o.user_id
    WHERE o.source_kind='HISTORICAL_EARNINGS_LOG' AND o.source_entity='la_log_earnings' AND o.imported_at <= $2::timestamptz AND ${during('o.source_event_at')} AND ($10='ALL' OR (${historyType})=$10) ${q.subjectUserId?'AND o.user_id=$12':''} AND ($1='' OR ${oldSearch})`);
  const page = await pageCandidates(client, parts, q, access);
  const ledgerIds = page.rows.filter(row => row.family === 'ledger').map(row => row.id);
  const openingIds = page.rows.filter(row => row.family === 'opening').map(row => row.id);
  const historyIds = page.rows.filter(row => row.family === 'history').map(row => row.id);
  const ledgerSql = adminFinanceLedgerSql(true, true).replace(/\s+ORDER BY l\.id COLLATE "C" LIMIT \$1\s*$/, ' AND l.id=ANY($1::text[])');
  const ledgerRows = ledgerIds.length ? (await client.query(ledgerSql, [ledgerIds])).rows as Raw[] : [];
  const demoOrigins=await readDemoLedgerOrigins(client,ledgerRows.map(row=>row.id));
  const historicalRows = await historyRows(client, historyIds);
  const byUser = new Map<string,Raw[]>();
  for (const row of historicalRows) {
    const projected = projectAdminFinanceObservation(row);
    const evidence = { id: `history:${row.id}`, kind:'HISTORICAL', source_kind:row.source_kind, source_type:row.source_type, source_system:row.source_system, source_id:row.source_id, business_id:row.reference_id, at:row.at, delta:projected.deltaCents };
    const rows = byUser.get(row.subject_id) ?? []; rows.push(evidence); byUser.set(row.subject_id, rows);
  }
  const purposes = new Map<string,Awaited<ReturnType<typeof readWalletHistoricalPurposes>> extends Map<string,infer T> ? T : never>();
  for (const [user, rows] of byUser) for (const [id, value] of await readWalletHistoricalPurposes(client,user,rows)) purposes.set(id,value);
  const mapped = new Map<string,unknown>();
  if (openingIds.length) for (const row of (await client.query(`SELECT b.id,b.user_id,u.name,b.available_cents::text AS amount,${utc('b.source_cutoff')} AS at,${utc('e.created_at')} AS recorded_at FROM zzsh_order.finance_opening_basis b
    JOIN zzsh_order.wallet_coverage c ON c.basis_id=b.id AND c.user_id=b.user_id JOIN zzsh_order.finance_event e ON e.id=c.opening_event_id
    LEFT JOIN zzsh_auth_user."user" u ON u.id=b.user_id WHERE b.id=ANY($1::text[])`,[openingIds])).rows) {
    mapped.set(`opening:${row.id}`, { id:`opening:${row.id}`, source:'OPENING', subjectId:row.user_id, subjectName:displayName(row.name,row.user_id), label:'迁移期初', amountCents:row.amount, occurredAt:row.at, recordedAt:row.recorded_at, documentRef:null });
  }
  for (const row of ledgerRows) {
    const entry = projectAdminFinanceLedger(row);
    const commission = row.source_kind === 'NATIVE_RENTAL_REFERRAL' || row.source_kind === 'LEGACY_CONTINUATION_DUTY' && row.beneficiary_role === 'COMMISSION';
    const label = commission ? entry.direction === 'OUT' ? '分销收益冲回' : '分销收入' : row.source_kind === 'ORDER_COMPENSATION' ? '包赔赔偿' : ['withdrawal_intent','joinpay_withdrawal_intent'].includes(row.source_entity) ? (['RELEASE','JOINPAY_WITHDRAWAL_RELEASED'].includes(row.event_kind) ? '提现退回' : '提现扣除') : row.source_kind === 'LEGACY_CONTINUATION_DUTY' && row.beneficiary_role === 'DEPOSIT_COMPENSATION' ? '押金补偿' : row.posting_id || row.source_kind === 'LEGACY_CONTINUATION_DUTY' && row.beneficiary_role === 'OWNER_CREDIT' ? '号主租赁收入' : '余额变动';
    const dataOrigin=demoOrigins.get(row.id);
    mapped.set(`ledger:${row.id}`, { id:entry.id, source:'NATIVE', subjectId:entry.subjectId, subjectName:entry.subjectName, label, amountCents:entry.deltaCents, occurredAt:entry.occurredAt, documentRef:row.source_kind==='ORDER_COMPENSATION'?null:entry.documentRef,
      ...(dataOrigin?{dataOrigin,bankArrival:'UNKNOWN' as const}:{}) });
  }
  for (const row of historicalRows) {
    const entry = projectAdminFinanceObservation(row), evidence = purposes.get(entry.id), verified = evidence?.amountSemantics === 'BALANCE_RECORD';
    mapped.set(`history:${row.id}`, { id:entry.id, source:'LEGACY', subjectId:entry.subjectId, subjectName:entry.subjectName, label:verified ? purposeLabels[evidence.purpose] ?? entry.historical?.purposeLabel ?? '用途待核' : '用途待核', amountCents:verified?entry.deltaCents:null, occurredAt:verified?entry.occurredAt:null, balanceAfterCents:verified?entry.historical?.balanceAfterCents??null:null, documentRef:entry.documentRef });
  }
  return { version:'admin.finance-balance-activity.v1', view:q.view, asOf:page.asOf, page:q.page, pageSize:q.pageSize, total:page.total, hasMore:page.hasMore, items:page.rows.map(row => mapped.get(`${row.family}:${row.id}`)).filter(Boolean) };
}

/** A submission record is not proof that the channel received or completed it. */
export async function readAdminChannelActivity(client: PoolClient, q: ActivityQuery, access: HistoricalRelationAccess, exact = false) {
  if (q.source==='ALL') throw invalid('Channel source must be selected');
  if (exact && !q.q) throw invalid('A document lookup reference is required');
  const parts: string[] = [];
  const demoState = q.source === 'NATIVE'
    ? (await client.query<{ exists:boolean; readable:boolean; refundReady:boolean; legacyRefundReady:boolean; withdrawalReady:boolean }>(`SELECT to_regclass('zzsh_order.ecs_test_demo_finance_registration') IS NOT NULL AS exists,
      COALESCE(has_table_privilege(to_regclass('zzsh_order.ecs_test_demo_finance_registration'),'SELECT'),false) AS readable,
      COALESCE(has_table_privilege(to_regclass('zzsh_order.local_controlled_refund_operation'),'SELECT'),false) AS "refundReady",
      COALESCE(has_table_privilege(to_regclass('zzsh_order.ecs_demo_legacy_refund'),'SELECT'),false) AS "legacyRefundReady",
      COALESCE(has_table_privilege(to_regclass('zzsh_order.controlled_payout_operation'),'SELECT'),false)
        AND COALESCE(has_table_privilege(to_regclass('zzsh_order.withdrawal_intent'),'SELECT'),false) AS "withdrawalReady"`)).rows[0] : undefined;
  if (demoState?.exists && !demoState.readable) throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Test payment classification is unavailable');
  if (demoState?.exists && ((q.kind==='ALL'||q.kind==='REFUND') && (!demoState.refundReady||!demoState.legacyRefundReady)
    || (q.kind==='ALL'||q.kind==='WITHDRAWAL') && !demoState.withdrawalReady))
    throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Test finance classification is unavailable');
  if (q.source !== 'NATIVE') {
    const kinds = q.kind === 'ALL' ? "'HISTORICAL_PAYMENT','HISTORICAL_REFUND','HISTORICAL_WITHDRAWAL'" : `'HISTORICAL_${q.kind}'`;
    parts.push(`SELECT 'history' AS family,o.id,${utc('COALESCE(o.source_event_at,o.imported_at)')} AS at
      FROM zzsh_order.personal_finance_observation o LEFT JOIN zzsh_auth_user."user" u ON u.id=o.user_id
      WHERE o.source_kind IN (${kinds}) AND o.imported_at <= $2::timestamptz AND ${during('o.source_event_at')}
      ${q.subjectUserId?'AND o.user_id=$12':''} AND ${exact ? exactOldSearch : `($1='' OR ${oldSearch})`}`);
    if(q.subjectUserId && q.kind!=='WITHDRAWAL') parts.push(`SELECT 'history' AS family,o.id,${utc('COALESCE(o.source_event_at,o.imported_at)')} AS at
      FROM zzsh_order.legacy_order_read_snapshot lo JOIN zzsh_order.personal_finance_observation o ON o.user_id=lo.renter_user_id AND o.source_system=lo.source_system AND o.snapshot->>'referenceId'=lo.legacy_id
      LEFT JOIN zzsh_auth_user."user" u ON u.id=o.user_id
      CROSS JOIN LATERAL (SELECT CASE WHEN pg_input_is_valid(o.snapshot#>>'{rawSource,canonical}','jsonb') THEN (o.snapshot#>>'{rawSource,canonical}')::jsonb ELSE '{}'::jsonb END AS raw) proof
      WHERE o.source_kind IN (${kinds}) AND o.imported_at <= $2::timestamptz AND ${during('o.source_event_at')} AND ${legacyOwnerProof} AND ($1='' OR ${oldSearch})`);
  }
  if (q.source !== 'LEGACY') {
    if (q.kind === 'ALL' || q.kind === 'PAYMENT') parts.push(`SELECT 'payment' AS family,a.id,${utc('a.created_at')} AS at
      FROM zzsh_order.joinpay_collection_attempt a JOIN zzsh_order.payment_request p ON p.id=a.request_id
      JOIN zzsh_order.rental_order ord ON ord.id=p.order_id LEFT JOIN zzsh_auth_user."user" u ON u.id=ord.renter_user_id
      WHERE p.channel='JOINPAY' AND a.operation='SUBMIT' AND a.created_at <= $2::timestamptz AND ${during('a.created_at')}
      ${q.subjectUserId?`AND (ord.renter_user_id=$12 OR (ord.owner_user_id=$12 AND ${orderVisible('ord')}))`:''} AND ${match(['p.channel_order_no','p.platform_order_no',orderTerm('ord','ord.display_no')],exact)}`);
    if ((q.kind === 'ALL' || q.kind === 'PAYMENT') && demoState?.exists) parts.push(`SELECT 'demo_payment' AS family,p.id,${utc('p.accepted_at')} AS at
      FROM zzsh_order.payment_confirmation p JOIN zzsh_order.rental_order ord ON ord.id=p.order_id AND ord.paid_confirmation_id=p.id
      JOIN zzsh_order.controlled_payment_declaration d ON d.order_id=p.order_id AND d.merchant_scope_id=p.merchant_scope_id
        AND d.provider_transaction_id=p.provider_transaction_id AND d.merchant_order_no=p.merchant_order_no
      JOIN zzsh_order.ecs_test_demo_finance_registration s ON s.registration_digest=d.approval_digest
      LEFT JOIN zzsh_auth_user."user" u ON u.id=ord.renter_user_id
      WHERE p.source='CONTROLLED' AND p.disposition='APPLIED' AND d.mode='LOCAL_CONTROLLED_DECLARED_PAYMENT'
        AND d.payment_digest=encode(sha256(convert_to(d.canonical_payment,'UTF8')),'hex')
        AND d.canonical_payment::jsonb->>'orderId'=p.order_id AND d.canonical_payment::jsonb->>'amountCents'=p.amount_cents::text
        AND d.canonical_payment::jsonb->>'currency'=p.currency AND d.canonical_payment::jsonb->>'providerTransactionId'=p.provider_transaction_id
        AND s.registration_digest=encode(sha256(convert_to(s.canonical_registration,'UTF8')),'hex')
        AND s.canonical_registration::jsonb->>'schema' IN ('ecs-test-demo-finance.v1','local-demo-clone-finance.v1')
        AND d.resource_oid::text=(s.canonical_registration::jsonb #>> '{resource,databaseOid}')
        AND p.accepted_at <= $2::timestamptz AND ${during('p.accepted_at')}
      ${q.subjectUserId?`AND (ord.renter_user_id=$12 OR (ord.owner_user_id=$12 AND ${orderVisible('ord')}))`:''}
      AND ${match(['d.id','p.merchant_order_no',orderTerm('ord','ord.display_no')],exact)}`);
    if (q.kind === 'ALL' || q.kind === 'REFUND') parts.push(`SELECT 'refund' AS family,a.id,${utc('a.created_at')} AS at
      FROM zzsh_order.joinpay_refund_attempt a JOIN zzsh_order.channel_refund_intent i ON i.id=a.intent_id
      LEFT JOIN zzsh_order.rental_order ord ON ord.id=i.order_id LEFT JOIN zzsh_auth_user."user" u ON u.id=i.renter_user_id
      WHERE a.operation='SUBMIT' AND i.basis_kind IN ('POSTING','PRESTART_TERMINATION') AND a.created_at <= $2::timestamptz AND ${during('a.created_at')}
      ${q.subjectUserId?`AND (i.renter_user_id=$12 OR (ord.owner_user_id=$12 AND ord.renter_user_id=i.renter_user_id AND ${orderVisible('ord')}))`:''} AND ${match(['i.refund_order_no','i.provider_refund_trx_no','i.original_payment_order_no',orderTerm('ord','ord.display_no')],exact)}`);
    if ((q.kind==='ALL'||q.kind==='REFUND') && demoState?.exists) parts.push(`SELECT 'demo_refund' AS family,a.id,${utc('a.created_at')} AS at
      FROM zzsh_order.local_controlled_refund_operation a JOIN zzsh_order.channel_refund_intent i ON i.id=a.intent_id AND i.payment_source='CONTROLLED'
      JOIN zzsh_order.rental_order ord ON ord.id=i.order_id AND ord.renter_user_id=i.renter_user_id
      JOIN zzsh_order.ecs_test_demo_finance_registration s ON s.reference=a.sandbox_registration_ref AND s.reference=i.sandbox_registration_ref
      LEFT JOIN zzsh_auth_user."user" u ON u.id=i.renter_user_id
      WHERE i.basis_kind IN ('POSTING','PRESTART_TERMINATION') AND a.refund_order_no=i.refund_order_no AND a.original_payment_trx_no=i.original_payment_trx_no AND a.amount_cents=i.amount_cents
        AND a.final_digest=encode(sha256(convert_to(a.final_canonical,'UTF8')),'hex')
        AND s.registration_digest=encode(sha256(convert_to(s.canonical_registration,'UTF8')),'hex')
        AND s.canonical_registration::jsonb->>'schema' IN ('ecs-test-demo-finance.v1','local-demo-clone-finance.v1')
        AND a.created_at<=$2::timestamptz AND ${during('a.created_at')}
      ${q.subjectUserId?`AND (i.renter_user_id=$12 OR (ord.owner_user_id=$12 AND ${orderVisible('ord')}))`:''}
      AND ${match(['a.id','i.refund_order_no',orderTerm('ord','ord.display_no')],exact)}`);
    if ((q.kind==='ALL'||q.kind==='REFUND') && demoState?.exists) parts.push(`SELECT 'demo_legacy_refund' AS family,x.id,${utc('x.created_at')} AS at
      FROM zzsh_order.ecs_demo_legacy_refund x JOIN zzsh_order.legacy_order_read_snapshot lo ON lo.id=x.order_id AND lo.renter_user_id=x.renter_user_id
      JOIN zzsh_order.ecs_test_demo_finance_registration s ON s.reference=x.registration_ref
      LEFT JOIN zzsh_auth_user."user" u ON u.id=x.renter_user_id
      WHERE s.registration_digest=encode(sha256(convert_to(s.canonical_registration,'UTF8')),'hex')
        AND s.canonical_registration::jsonb->>'schema' IN ('ecs-test-demo-finance.v1','local-demo-clone-finance.v1')
        AND x.created_at<=$2::timestamptz AND ${during('x.created_at')}
      ${q.subjectUserId?`AND (x.renter_user_id=$12 OR (lo.owner_user_id=$12 AND ${orderVisible('lo')}))`:''}
      AND ${match(['x.id',orderTerm('lo','lo.original_order_no')],exact)}`);
    if (q.kind === 'ALL' || q.kind === 'WITHDRAWAL') parts.push(`SELECT 'withdrawal' AS family,a.id,${utc('a.created_at')} AS at
      FROM zzsh_order.joinpay_payout_attempt a JOIN zzsh_order.joinpay_withdrawal_intent w ON w.id=a.intent_id LEFT JOIN zzsh_auth_user."user" u ON u.id=w.user_id
      WHERE a.operation='SUBMIT' AND a.created_at <= $2::timestamptz AND ${during('a.created_at')} ${q.subjectUserId?'AND w.user_id=$12':''} AND ${match(['w.merchant_order_no','w.platform_serial_no'],exact)}`);
    if ((q.kind==='ALL'||q.kind==='WITHDRAWAL') && demoState?.exists) parts.push(`SELECT 'demo_withdrawal' AS family,a.id,${utc('a.recorded_at')} AS at
      FROM zzsh_order.controlled_payout_operation a JOIN zzsh_order.withdrawal_intent w ON w.id=a.intent_id AND w.payout_key=a.payout_key
      JOIN zzsh_order.withdrawal_admission d ON d.id=w.admission_id AND d.user_id=w.user_id AND d.sandbox_registration_ref=w.sandbox_registration_ref
      JOIN zzsh_order.ecs_test_demo_finance_registration s ON s.reference=w.sandbox_registration_ref
      LEFT JOIN zzsh_auth_user."user" u ON u.id=w.user_id
      WHERE a.mode='LOCAL_CONTROLLED' AND a.final_evidence_digest=encode(sha256(convert_to(a.final_evidence_canonical,'UTF8')),'hex')
        AND s.registration_digest=encode(sha256(convert_to(s.canonical_registration,'UTF8')),'hex')
        AND s.canonical_registration::jsonb->>'schema' IN ('ecs-test-demo-finance.v1','local-demo-clone-finance.v1')
        AND d.resource_oid::text=(s.canonical_registration::jsonb #>> '{resource,databaseOid}')
        AND a.recorded_at<=$2::timestamptz AND ${during('a.recorded_at')}
      ${q.subjectUserId?'AND w.user_id=$12':''} AND ${match(['a.id','w.id'],exact)}`);
  }
  const page = await pageCandidates(client, parts, q, access, exact), mapped = new Map<string,unknown>();
  const oldRows=await historyRows(client,page.rows.filter(row=>row.family==='history').map(row=>row.id));
  const oldEntries=oldRows.map(projectAdminFinanceObservation);
  const linkedOrders=q.subjectUserId&&(access.isBoss||access.orderRead)&&oldRows.some(row=>['la_pay_order','la_refund_record'].includes(row.source_entity))
    ?await loadFinanceOrderFacts(client,{legacy_orders:true},{orderRefs:[]},oldRows,access):[];
  if(linkedOrders.length)enrichHistoricalObservations(oldEntries,oldRows,linkedOrders,access);
  for (const entry of oldEntries) {
    const valid=entry.historical?.amountSemantics==='BUSINESS_RECORD', association=entry.historical?.association;
    const order=association?.state==='MATCHED'&&association.kind==='ORDER'?linkedOrders.find(candidate=>candidate.ref===association.documentRef&&candidate.objectReadable):undefined;
    if(q.subjectUserId&&entry.subjectId!==q.subjectUserId&&(!order||order.ownerId!==q.subjectUserId))throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Historical owner association unavailable');
    const subjectRole=entry.kind==='WITHDRAWAL'?'WITHDRAWER':entry.subjectId!==q.subjectUserId?'OWNER':order?.renterId===q.subjectUserId?'RENTER':'RELATED_USER';
    mapped.set(`history:${entry.id.slice('history:'.length)}`, { id:entry.id, source:'LEGACY', kind:entry.kind, subjectId:entry.subjectId, subjectName:entry.subjectName, ...(q.subjectUserId?{subjectRole}:{}), number:entry.documentNumber, amountCents:valid?entry.historical?.recordedAmountCents:null, amountLabel:entry.kind==='WITHDRAWAL'?'旧平台申请金额':'旧平台记录金额', occurredAt:valid?entry.occurredAt:null, state:valid?entry.historical?.originalStatusLabel??'旧平台状态未记录':'来源待核', operation:null, documentRef:entry.documentRef });
  }
  const families = [
    { key:'payment', sql:`SELECT a.id,${utc('a.created_at')} AS at,p.id AS business_id,p.channel_order_no AS number,p.platform_order_no AS related_number,p.method,p.state,p.amount_cents::text AS amount,ord.renter_user_id AS user_id,u.name FROM zzsh_order.joinpay_collection_attempt a JOIN zzsh_order.payment_request p ON p.id=a.request_id JOIN zzsh_order.rental_order ord ON ord.id=p.order_id LEFT JOIN zzsh_auth_user."user" u ON u.id=ord.renter_user_id WHERE a.id=ANY($1::text[])`, kind:'PAYMENT', prefix:'PAYMENT_REQUEST' },
    { key:'refund', sql:`SELECT a.id,${utc('a.created_at')} AS at,i.id AS business_id,i.refund_order_no AS number,i.original_payment_order_no AS related_number,i.state,i.amount_cents::text AS amount,i.renter_user_id AS user_id,u.name FROM zzsh_order.joinpay_refund_attempt a JOIN zzsh_order.channel_refund_intent i ON i.id=a.intent_id LEFT JOIN zzsh_auth_user."user" u ON u.id=i.renter_user_id WHERE a.id=ANY($1::text[])`, kind:'REFUND', prefix:'REFUND_INTENT' },
    { key:'withdrawal', sql:`SELECT a.id,${utc('a.created_at')} AS at,w.id AS business_id,w.merchant_order_no AS number,w.state,w.net_cents::text AS amount,w.gross_cents::text AS gross_cents,w.fee_cents::text AS fee_cents,w.user_id,u.name FROM zzsh_order.joinpay_payout_attempt a JOIN zzsh_order.joinpay_withdrawal_intent w ON w.id=a.intent_id LEFT JOIN zzsh_auth_user."user" u ON u.id=w.user_id WHERE a.id=ANY($1::text[])`, kind:'WITHDRAWAL', prefix:'JOINPAY_WITHDRAWAL' },
  ];
  for (const family of families) {
    const ids = page.rows.filter(row=>row.family===family.key).map(row=>row.id); if (!ids.length) continue;
    for (const row of (await client.query(family.sql,[ids])).rows) mapped.set(`${family.key}:${row.id}`, { id:`${family.key}:${row.id}`, source:'NATIVE', kind:family.kind, subjectId:row.user_id, subjectName:displayName(row.name,row.user_id), ...(q.subjectUserId?{subjectRole:family.kind==='WITHDRAWAL'?'WITHDRAWER':row.user_id===q.subjectUserId?'RENTER':'OWNER'}:{}), number:row.number, relatedNumber:row.related_number??null, relatedNumberLabel:family.kind==='PAYMENT'?'平台订单号':family.kind==='REFUND'?'原支付单号':null, method:row.method??null, grossCents:row.gross_cents??null, feeCents:row.fee_cents??null, amountCents:row.amount, amountLabel:family.kind==='WITHDRAWAL'?'渠道出款金额':family.kind==='REFUND'?'退款申请金额':'收款申请金额', occurredAt:row.at, state:row.state, documentRef:`${family.prefix}:${row.business_id}` });
  }
  const demoIds = page.rows.filter(row=>row.family==='demo_payment').map(row=>row.id);
  if (demoIds.length) {
    const records = await client.query(`SELECT p.id,${utc('p.accepted_at')} AS at,d.id AS number,ord.display_no AS order_number,
      CASE s.canonical_registration::jsonb->>'schema' WHEN 'ecs-test-demo-finance.v1' THEN 'ECS_TEST_SIMULATED'
        WHEN 'local-demo-clone-finance.v1' THEN 'LOCAL_DEMO_SIMULATED' END AS demo_origin,
      p.amount_cents::text AS amount,ord.renter_user_id AS user_id,u.name FROM zzsh_order.payment_confirmation p
      JOIN zzsh_order.rental_order ord ON ord.id=p.order_id AND ord.paid_confirmation_id=p.id
      JOIN zzsh_order.controlled_payment_declaration d ON d.order_id=p.order_id AND d.merchant_scope_id=p.merchant_scope_id
        AND d.provider_transaction_id=p.provider_transaction_id
      JOIN zzsh_order.ecs_test_demo_finance_registration s ON s.registration_digest=d.approval_digest
      LEFT JOIN zzsh_auth_user."user" u ON u.id=ord.renter_user_id WHERE p.id=ANY($1::text[]) AND p.source='CONTROLLED'`,[demoIds]);
    for (const row of records.rows) mapped.set(`demo_payment:${row.id}`, { id:`demo_payment:${row.id}`, source:'NATIVE', kind:'PAYMENT',
      dataOrigin:row.demo_origin, bankArrival:'UNKNOWN', subjectId:row.user_id, subjectName:displayName(row.name,row.user_id),
      ...(q.subjectUserId?{subjectRole:row.user_id===q.subjectUserId?'RENTER':'OWNER'}:{}), number:row.number, relatedNumber:row.order_number,
      relatedNumberLabel:'订单号', amountCents:row.amount, amountLabel:'模拟金额（未发生汇聚收款）', occurredAt:row.at,
      state:'SIMULATED', documentRef:null });
  }
  const demoRefundIds=page.rows.filter(row=>row.family==='demo_refund').map(row=>row.id);
  if(demoRefundIds.length){
    const records=await client.query(`SELECT a.id,${utc('a.created_at')} AS at,i.refund_order_no AS number,ord.display_no AS order_number,
      i.amount_cents::text AS amount,i.renter_user_id AS user_id,u.name,
      CASE s.canonical_registration::jsonb->>'schema' WHEN 'ecs-test-demo-finance.v1' THEN 'ECS_TEST_SIMULATED' ELSE 'LOCAL_DEMO_SIMULATED' END AS demo_origin,
      (i.state='SUCCEEDED' AND e.id IS NOT NULL AND e.operation_id=a.id AND e.facts_digest=encode(sha256(convert_to(e.facts_canonical,'UTF8')),'hex')) AS completed
      FROM zzsh_order.local_controlled_refund_operation a JOIN zzsh_order.channel_refund_intent i ON i.id=a.intent_id
      JOIN zzsh_order.rental_order ord ON ord.id=i.order_id JOIN zzsh_order.ecs_test_demo_finance_registration s ON s.reference=a.sandbox_registration_ref
      LEFT JOIN zzsh_order.local_controlled_refund_evidence e ON e.id=i.demo_terminal_evidence_id
      LEFT JOIN zzsh_auth_user."user" u ON u.id=i.renter_user_id WHERE a.id=ANY($1::text[])`,[demoRefundIds]);
    for(const row of records.rows)mapped.set(`demo_refund:${row.id}`,{id:`demo_refund:${row.id}`,source:'NATIVE',kind:'REFUND',dataOrigin:row.demo_origin,
      bankArrival:'UNKNOWN',subjectId:row.user_id,subjectName:displayName(row.name,row.user_id),...(q.subjectUserId?{subjectRole:row.user_id===q.subjectUserId?'RENTER':'OWNER'}:{}),
      number:row.number,relatedNumber:row.order_number,relatedNumberLabel:'订单号',amountCents:row.amount,amountLabel:'模拟金额（未发生汇聚退款）',
      occurredAt:row.at,state:row.completed?'SIMULATED':'UNKNOWN',documentRef:null});
  }
  const demoLegacyRefundIds=page.rows.filter(row=>row.family==='demo_legacy_refund').map(row=>row.id);
  if(demoLegacyRefundIds.length){
    const records=(await client.query(`SELECT x.id,${utc('x.created_at')} AS at,x.amount_cents::text AS amount,x.renter_user_id AS user_id,u.name,
      CASE WHEN $4::boolean AND ${gameScopeSql('lo.game_id','$2','$3')} THEN lo.original_order_no END AS order_number,l.id AS ledger_id
      FROM zzsh_order.ecs_demo_legacy_refund x JOIN zzsh_order.legacy_order_read_snapshot lo ON lo.id=x.order_id
      LEFT JOIN zzsh_order.settlement_ledger_entry l ON l.finance_event_id=x.event_id AND l.line_no=1
      LEFT JOIN zzsh_auth_user."user" u ON u.id=x.renter_user_id WHERE x.id=ANY($1::text[])
        AND $2::text IS NOT NULL AND $3::boolean IS NOT NULL AND $4::boolean IS NOT NULL`,[demoLegacyRefundIds,access.adminId,access.isBoss,access.isBoss||access.orderRead])).rows;
    const origins=await readDemoLedgerOrigins(client,records.flatMap(row=>typeof row.ledger_id==='string'?[row.ledger_id]:[]));
    for(const row of records){const dataOrigin=origins.get(row.ledger_id)??'UNKNOWN';
      mapped.set(`demo_legacy_refund:${row.id}`,{id:`demo_legacy_refund:${row.id}`,source:'NATIVE',kind:'REFUND',dataOrigin,
        bankArrival:'UNKNOWN',subjectId:row.user_id,subjectName:displayName(row.name,row.user_id),...(q.subjectUserId?{subjectRole:row.user_id===q.subjectUserId?'RENTER':'OWNER'}:{}),
        number:row.id,relatedNumber:row.order_number,relatedNumberLabel:'旧订单号',amountCents:row.amount,amountLabel:'模拟金额（未发生汇聚退款）',
        occurredAt:row.at,state:dataOrigin==='UNKNOWN'?'UNKNOWN':'SIMULATED',documentRef:null});
    }
  }
  const demoWithdrawalIds=page.rows.filter(row=>row.family==='demo_withdrawal').map(row=>row.id);
  if(demoWithdrawalIds.length){
    const records=await client.query(`SELECT a.id,${utc('a.recorded_at')} AS at,w.id AS number,w.gross_cents::text AS gross_cents,
      w.net_cents::text AS amount,w.fee_cents::text AS fee_cents,w.user_id,u.name,
      CASE s.canonical_registration::jsonb->>'schema' WHEN 'ecs-test-demo-finance.v1' THEN 'ECS_TEST_SIMULATED' ELSE 'LOCAL_DEMO_SIMULATED' END AS demo_origin,
      (w.state='SUCCEEDED' AND w.funds_disposition='PAYOUT_POSTED' AND w.terminal->>'reference'=a.id) AS completed
      FROM zzsh_order.controlled_payout_operation a JOIN zzsh_order.withdrawal_intent w ON w.id=a.intent_id AND w.payout_key=a.payout_key
      JOIN zzsh_order.ecs_test_demo_finance_registration s ON s.reference=w.sandbox_registration_ref
      LEFT JOIN zzsh_auth_user."user" u ON u.id=w.user_id WHERE a.id=ANY($1::text[])`,[demoWithdrawalIds]);
    for(const row of records.rows)mapped.set(`demo_withdrawal:${row.id}`,{id:`demo_withdrawal:${row.id}`,source:'NATIVE',kind:'WITHDRAWAL',dataOrigin:row.demo_origin,
      bankArrival:'UNKNOWN',subjectId:row.user_id,subjectName:displayName(row.name,row.user_id),...(q.subjectUserId?{subjectRole:'WITHDRAWER'}:{}),
      number:row.number,relatedNumber:null,amountCents:row.amount,grossCents:row.gross_cents,feeCents:row.fee_cents,
      amountLabel:'模拟金额（未发生汇聚出款）',occurredAt:row.at,state:row.completed?'SIMULATED':'UNKNOWN',documentRef:null});
  }
  return { version:'admin.finance-channel-activity.v1', asOf:page.asOf, page:q.page, pageSize:q.pageSize, total:page.total, hasMore:page.hasMore, items:page.rows.map(row=>mapped.get(`${row.family}:${row.id}`)).filter(Boolean) };
}
