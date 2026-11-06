import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { parseFinanceDashboardContributionQuery, parseFinanceDashboardQuery, readFinanceDashboardChannels, readFinanceDashboardContributions, readFinanceDashboardCustomers, readFinanceDashboardTrend } from '../src/finance/admin-finance-dashboard';

test('dashboard accepts only bounded dates, explicit sources, basis and ranking size', () => {
  assert.deepEqual(parseFinanceDashboardQuery(new URLSearchParams()), { range: '7d', from: undefined, to: undefined, basis: 'settled', limit: 20, source: 'all' });
  assert.equal(parseFinanceDashboardQuery(new URLSearchParams('range=custom&from=2026-01-01&to=2026-12-31&basis=paid&limit=50&source=legacy')).limit, 50);
  for (const input of ['range=7d&range=today', 'range=all&from=2026-01-01', 'range=custom&from=2026-02-30&to=2026-03-01',
    'range=custom&from=2020-01-01&to=2022-01-01', 'limit=999', 'source=unknown', 'basis=created', 'q=customer']) {
    assert.throws(() => parseFinanceDashboardQuery(new URLSearchParams(input)));
  }
});

function fixture(legacy = true, continuationReadable = true) {
  const queries: { sql: string; values: unknown[] }[] = [];
  const client = { query: async (sql: string, values: unknown[] = []) => {
    queries.push({ sql, values });
    if (sql.includes(' AS today')) return { rows: [{ today: '2026-11-06', as_of: '2026-11-06T04:00:00.000000Z' }] };
    if (sql.includes('continuation_exists')) return { rows: [{ legacy, continuation_exists: true, continuation_readable: continuationReadable, continuation_evidence: continuationReadable }] };
    if (sql.includes('dashboard paid business trend')) return { rows: [{ day: '2026-11-03', orders: '2', known_amounts: '1', cents: '1050', legacy_orders: '2', estimate_orders:'1',estimate_known:'1',estimate_cents:'100',estimate_discrepancies:'1', settlements: null, known_contributions: null, contribution: null, total_paid:'2',cancelled:'1',completed:'1',active:'0',unknown_state:'0',repeat_renters:'1',native_orders:'0',legacy_total:'2',frequency:[{orders:2,users:'1'}] }] };
    if (sql.includes('dashboard customer gross contribution')) return { rows: [{ user_id: 'u1', name: '客户一', orders: '2', paid: '10000', contribution: '1200', latest: new Date('2026-11-03T01:00:00Z'), omitted: '1', omitted_total: '3', legacy_orders: '1', compensation_records:'0',compensation_cents:null }] };
    if (sql.includes('dashboard contribution evidence')) return { rows: [{ total:'2',known:'2',cents:'1200',items:[{orderId:'o1',number:'ORDER-1',source:'LEGACY',at:'2026-11-03T01:00:00.000000Z',paidCents:'10000',ownerCents:'6000',refundCents:'2800',contributionCents:'1200'}] }] };
    if (sql.includes('dashboard selected contribution components')) return { rows: [{order_id:'o1',source:'LEGACY',owner:'6000',refund:'2800'}] };
    if (sql.includes('bool_and')) return { rows: [{ ready: false }] };
    throw new Error('Unexpected query');
  } } as unknown as PoolClient;
  return { client, queries };
}
const viewer = { adminId: 'admin1', isBoss: false };

test('trend preserves missing facts and constrains every source to the authorized game scope', async () => {
  const f = fixture(), result = await readFinanceDashboardTrend(f.client, parseFinanceDashboardQuery(new URLSearchParams()), viewer);
  assert.equal(result.points[0]?.cents, '1050');
  assert.equal(result.points[0]?.knownAmounts, '1');
  assert.equal(result.points[0]?.settlements, null);
  assert.equal(result.legacy, 'RECORDED_PARTIAL');
  assert.equal(result.continuations, 'RECORDED_PARTIAL');
  assert.equal(result.estimateState, 'FORBIDDEN');
  assert.equal(result.insights?.cancelled, '1');
  assert.equal(result.insights?.repeatRenters, '1');
  assert.deepEqual(result.insights?.frequency, [{orders:2,users:'1'}]);
  const query = f.queries.find(item => item.sql.includes('dashboard paid business trend'))!;
  assert.match(query.sql, /sgame\."game_id" = o\.game_id/);
  assert.match(query.sql, /sgame\."game_id" = l\.game_id/);
  assert.match(query.sql, /p\.disposition='APPLIED'/);
  assert.match(query.sql, /source_pay_status=1/);
  assert.doesNotMatch(query.sql, /platformFullProfit|commission_money/);
  assert.match(query.sql, /NOT EXISTS.*legacy_continuation_version/);
  assert.match(query.sql, /legacy_continuation_evidence e/);
  assert.match(query.sql, /h\.amounts=e\.facts->'amounts'/);
  assert.deepEqual(query.values.slice(0, 2), ['2026-10-31', '2026-11-06']);
  assert.ok(f.queries.every(item => !/^\s*(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(item.sql)));
});

test('quoted estimate requires its own capability and excludes cancelled orders', async () => {
  const f = fixture(), query = parseFinanceDashboardQuery(new URLSearchParams());
  const result = await readFinanceDashboardTrend(f.client, query, { ...viewer, quoteRead:true });
  assert.equal(result.estimateState, 'RECORDED_PARTIAL');
  assert.equal(result.points[0]?.estimateDiscrepancies,'1');
  const sql=f.queries.find(item=>item.sql.includes('dashboard paid business trend'))!.sql;
  assert.match(sql,/platformFullProfit/);assert.match(sql,/commission_money/);assert.match(sql,/state<>'CANCELLED'/);
});

test('ranking uses paid less refund and actual owner net, omits unknown facts, and supports both clocks', async () => {
  for (const basis of ['paid', 'settled'] as const) {
    const f = fixture(), query = parseFinanceDashboardQuery(new URLSearchParams({ range: 'all', basis, limit: '50' }));
    const result = await readFinanceDashboardCustomers(f.client, query, viewer), sql = f.queries.at(-1)!.sql;
    assert.equal(result.items[0]?.contributionCents, '1200');
    assert.equal(result.omittedCount, '3');
    assert.equal(result.continuations, 'RECORDED_PARTIAL');
    assert.equal(result.limit, 50);
    assert.equal(result.items[0]?.historicalCompensationCents, null);
    assert.match(sql, /sale_earnings/); assert.match(sql, /return_order_money/); assert.match(sql, /full_payout_money/);
    assert.match(sql, /ownerNet/); assert.match(sql, /refundNet/);
    assert.match(sql, /recorded_paid_amount_cents - CASE/);
    assert.match(sql, basis === 'paid' ? /o\.paid_at AS at/ : /p\.posted_at AS at/);
  }
  const blocked = fixture(true, false);
  const result = await readFinanceDashboardCustomers(blocked.client, parseFinanceDashboardQuery(new URLSearchParams()), viewer);
  assert.equal(result.legacy, 'UNAVAILABLE');
  assert.doesNotMatch(blocked.queries.at(-1)!.sql, /FROM zzsh_order\.legacy_order_read_snapshot l/);
});

test('contribution detail shares the settlement predicate, bounds snapshot, and narrows a customer to known rows', async () => {
  const params = new URLSearchParams({range:'all',basis:'settled',asOf:'2026-11-06T03:00:00.000000Z',userId:'u1',page:'1',pageSize:'20'});
  const f=fixture(), result=await readFinanceDashboardContributions(f.client,parseFinanceDashboardContributionQuery(params),viewer);
  assert.equal(result.total,'2');assert.equal(result.knownCents,'1200');assert.equal(result.items[0]?.orderId,'o1');
  const query=f.queries.find(item=>item.sql.includes('dashboard contribution evidence'))!;
  assert.match(query.sql,/legacy_continuation_evidence e/);assert.match(query.sql,/at<=\$5::timestamptz/);assert.match(query.sql,/contribution IS NOT NULL/);
  assert.deepEqual(query.values.slice(-4),['2026-11-06T03:00:00.000000Z','u1',20,0]);
  for (const suffix of ['&page=0','&pageSize=999','&asOf=2026-11-06T03:00:00.000000Z']) assert.throws(()=>parseFinanceDashboardContributionQuery(new URLSearchParams(params.toString()+suffix)));
  assert.throws(()=>parseFinanceDashboardContributionQuery(new URLSearchParams('range=all&asOf=2026-02-30T00:00:00.000000Z')));
});
test('contribution detail rejects components that do not add back to captured money',async()=>{
  const f=fixture(), original=f.client.query.bind(f.client);
  f.client.query=(async(sql:string,values:unknown[])=>sql.includes('dashboard selected contribution components')
    ? {rows:[{order_id:'o1',source:'LEGACY',owner:'6001',refund:'2800'}]}
    : original(sql,values)) as typeof f.client.query;
  const query=parseFinanceDashboardContributionQuery(new URLSearchParams({range:'all',asOf:'2026-11-06T03:00:00.000000Z'}));
  await assert.rejects(readFinanceDashboardContributions(f.client,query,viewer),(error:unknown)=>(error as {status?:number}).status===503);
});

test('channel evidence unavailable stays unavailable and never becomes zero', async () => {
  const f = fixture(), result = await readFinanceDashboardChannels(f.client, parseFinanceDashboardQuery(new URLSearchParams()), viewer, ['merchant1']);
  assert.equal(result.state, 'UNAVAILABLE');
  assert.deepEqual(result.items, []);
  assert.ok(f.queries.every(item => !item.sql.includes('dashboard verified channel facts')));
});
