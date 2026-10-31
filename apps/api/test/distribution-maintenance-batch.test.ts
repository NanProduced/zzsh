import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Pool, PoolClient } from 'pg';
import { createMaintenanceBatchRunner } from '../src/finance/distribution-maintenance-batch';
import { SecurityApiError } from '../src/auth/security-core';
import type { MaintenanceOperator } from '../src/finance/distribution-earning-store';

type Due = { id: string; version: string };
type Store = Map<string, { fingerprint: string; status: number; body: any }>;

/** Serves the exact SQL the batch runner uses, with a bounded number of connections. */
function fakeTarget(options: { due: Due[]; max?: number; games?: readonly string[] | null } = { due: [] }) {
  const records: Store = new Map(), settled = new Set<string>(), calls: string[] = [], moneyClients: string[] = [], control = { authorizeCalls: 0, failId: null as string | null, rejectId: null as string | null, unknownAccrual: false, released: 0, peak: 0 };
  let active = 0, nextId = 0;
  const client = () => {
    const id = 'conn_' + (nextId++);
    return { id, released: false, release() { if ((this as any).released) return; (this as any).released = true; active--; control.released++; }, async query(sql: string, args: any[] = []): Promise<any> {
      const rows = (values: any[] = []) => ({ rows: values, rowCount: values.length });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return rows();
      if (sql.includes('pg_try_advisory_lock')) return rows([{ acquired: true }]);
      if (sql.includes('pg_advisory_unlock')) return rows([{ released: true }]);
      if (sql.startsWith('SELECT request_fingerprint')) { const row = records.get(args[0] + '|' + args[1]); return rows(row ? [{ fingerprint: row.fingerprint, status: row.status, body: row.body }] : []); }
      if (sql.startsWith('SELECT key,response_status')) return rows([...records.entries()].filter(([receiptKey]) => receiptKey.startsWith(args[0] + '|')).map(([receiptKey, row]) => ({ key: receiptKey.split('|')[1], status: row.status, body: row.body })).filter(row => row.status !== 200).slice(-1));
      if (sql.startsWith('INSERT INTO zzsh_supply.idempotency_record')) { const key = String(args[0]) + '|' + String(args[1]); if (records.has(key)) throw new Error('duplicate receipt'); records.set(key, { fingerprint: args[2], status: 202, body: JSON.parse(args[3]) }); return rows(); }
      if (sql.startsWith('UPDATE zzsh_supply.idempotency_record')) { const key = String(args[0]) + '|' + String(args[3]), row = records.get(key); if (!row || row.fingerprint !== args[4]) return rows(); row.status = args[1]; row.body = JSON.parse(args[2]); return { rows: [], rowCount: 1 }; }
      if (sql.includes('FROM zzsh_order.rental_referral_earning e') && sql.includes("e.state='PENDING'")) return rows(options.due.filter(row => !settled.has(row.id)).slice(0, args[2]));
      if (sql.startsWith('SELECT id,game_id FROM zzsh_order.rental_order')) return rows(args[0].map((id: string) => ({ id, game_id: 'delta' })));
      if (sql.includes('FROM zzsh_order.rental_referral_earning e JOIN zzsh_order.rental_order o ON o.id=e.order_id WHERE e.id=ANY')) return rows(args[0].map((id: string) => ({ id, game_id: 'delta' })));
      if (sql.includes('audit_event')) return rows();
      throw new Error('Unexpected batch SQL: ' + sql);
    } } as unknown as PoolClient & { id: string };
  };
  const pool = { async connect() {
    const max = options.max ?? 10;
    if (active >= max) throw new Error('CONNECTION_WAIT_TIMEOUT');
    active++; control.peak = Math.max(control.peak, active);
    return client();
  } } as unknown as Pool;
  const runner = createMaintenanceBatchRunner({
    local: false, allowedOrderIds: [],
    accrue: async (used, orderId) => { moneyClients.push((used as any).id); calls.push(orderId); if (control.failId === orderId) throw Object.assign(new Error('unknown'), { code: 'EVIDENCE_UNAVAILABLE' }); if (control.unknownAccrual) return { knowledge: 'UNKNOWN', reason: 'ORDER_NOT_COMPLETED', baseCents: null, items: [] }; return { knowledge: 'KNOWN', items: [{ root: { id: 'earning_' + orderId, role: 'RENTER_REFERRAL' }, replayed: false }] }; },
    transition: async (used, earningId) => { moneyClients.push((used as any).id); calls.push(earningId); if (control.failId === earningId) throw Object.assign(new Error('unknown'), { code: 'EVIDENCE_UNAVAILABLE' }); if (control.rejectId === earningId) throw new SecurityApiError(409, 'CONFLICT', 'Earning is not due'); settled.add(earningId); return { root: { state: 'SETTLED' }, replayed: false }; },
  });
  const operator = (games?: readonly string[] | null): MaintenanceOperator => ({ userId: 'admin', sessionId: 'session',
    authorize: async () => { control.authorizeCalls++; }, ...(games === undefined ? {} : { games: async () => games }) });
  return { pool, runner, records, control, calls, moneyClients, operator };
}

test('one due request keeps its original roots, parameters and receipt across retries', async () => {
  const p = fakeTarget({ due: [{ id: 'earning_a', version: '1' }, { id: 'earning_b', version: '1' }] });
  const first = await p.runner.runDueBatch(p.pool, { limit: 1, requestId: 'due_locked', operator: p.operator() });
  assert.equal(first.batch.state, 'COMPLETE'); assert.deepEqual(first.batch.plan.earningIds, [{ earningId: 'earning_a', version: '1' }]); assert.deepEqual(p.calls, ['earning_a']);
  assert.deepEqual(first.batch.command, { limit: 1, games: null });
  const retry = await p.runner.runDueBatch(p.pool, { limit: 1, requestId: 'due_locked', operator: p.operator() });
  assert.equal(retry.replayed, true); assert.equal(retry.batch.state, 'COMPLETE'); assert.deepEqual(p.calls, ['earning_a']);
  await assert.rejects(p.runner.runDueBatch(p.pool, { limit: 2, requestId: 'due_locked', operator: p.operator() }), /different parameters/);
  const next = await p.runner.runDueBatch(p.pool, { limit: 2, requestId: 'due_next', operator: p.operator() });
  assert.deepEqual(next.batch.plan.earningIds, [{ earningId: 'earning_b', version: '1' }]); assert.deepEqual(p.calls, ['earning_a', 'earning_b']);
});

test('UNKNOWN batch resumes only its original plan and does not select the next roots', async () => {
  const p = fakeTarget({ due: [{ id: 'earning_a', version: '1' }, { id: 'earning_b', version: '1' }] });
  p.control.failId = 'earning_a';
  const first = await p.runner.runDueBatch(p.pool, { limit: 1, requestId: 'due_unknown', operator: p.operator() });
  assert.equal(first.batch.state, 'UNKNOWN'); assert.deepEqual(first.batch.plan.earningIds, [{ earningId: 'earning_a', version: '1' }]); assert.equal(first.batch.notAttempted, 0);
  p.control.failId = null;
  const resumed = await p.runner.resumeBatch(p.pool, { requestId: 'due_unknown', operator: p.operator() });
  assert.equal(resumed.replayed, true); assert.equal(resumed.batch.state, 'COMPLETE'); assert.deepEqual(resumed.batch.plan.earningIds, [{ earningId: 'earning_a', version: '1' }]);
  assert.deepEqual(p.calls, ['earning_a', 'earning_a']);
  const read = await p.runner.readBatch(p.pool, { requestId: 'due_unknown', operator: p.operator() });
  assert.equal(read!.batch.state, 'COMPLETE'); assert.equal(read!.batch.results[0]!.status, 'SETTLED');
  assert.ok(p.control.authorizeCalls >= 3);
});

test('replay batch fixes explicit order ids and rejects same-key parameter changes', async () => {
  const p = fakeTarget();
  const result = await p.runner.runReplayBatch(p.pool, { orderIds: ['order_1', 'order_2'], requestId: 'replay_locked', operator: p.operator() });
  assert.equal(result.batch.state, 'COMPLETE'); assert.deepEqual(result.batch.plan.orderIds, ['order_1', 'order_2']); assert.deepEqual(p.calls, ['order_1', 'order_2']);
  await assert.rejects(p.runner.runReplayBatch(p.pool, { orderIds: ['order_2'], requestId: 'replay_locked', operator: p.operator() }), /different parameters/);
  const read = await p.runner.readBatch(p.pool, { requestId: 'replay_locked', operator: p.operator() });
  assert.equal(read!.batch.operation, 'ACCRUALS_REPLAY');
});

test('one original key can never name two different maintenance operations', async () => {
  const p = fakeTarget({ due: [{ id: 'earning_a', version: '1' }] });
  await p.runner.runDueBatch(p.pool, { limit: 1, requestId: 'shared_key', operator: p.operator() });
  await assert.rejects(p.runner.runReplayBatch(p.pool, { orderIds: ['order_1'], requestId: 'shared_key', operator: p.operator() }), /different parameters/);
  const read = await p.runner.readBatch(p.pool, { requestId: 'shared_key', operator: p.operator() });
  assert.equal(read!.batch.operation, 'DUE_SETTLE');
});

test('reading an original batch re-checks the current game scope of every planned root', async () => {
  const p = fakeTarget({ due: [{ id: 'earning_a', version: '1' }] });
  await p.runner.runDueBatch(p.pool, { limit: 1, requestId: 'due_scope', operator: p.operator() });
  await assert.rejects(p.runner.readBatch(p.pool, { requestId: 'due_scope', operator: p.operator([]) }), /outside the admin game scope/);
  await assert.rejects(p.runner.resumeBatch(p.pool, { requestId: 'due_scope', operator: p.operator([]) }), /outside the admin game scope/);
  const still = await p.runner.readBatch(p.pool, { requestId: 'due_scope', operator: p.operator(['delta']) });
  assert.equal(still!.batch.requestId, 'due_scope');
});

test('a bounded pool serves concurrent batches without a second nested connection', async () => {
  const p = fakeTarget({ due: [{ id: 'earning_a', version: '1' }, { id: 'earning_b', version: '1' }], max: 2 });
  const [one, two] = await Promise.all([
    p.runner.runDueBatch(p.pool, { limit: 1, requestId: 'due_one', operator: p.operator() }),
    p.runner.runDueBatch(p.pool, { limit: 1, requestId: 'due_two', operator: p.operator() }),
  ]);
  assert.equal(one.batch.state, 'COMPLETE'); assert.equal(two.batch.state, 'COMPLETE');
  assert.equal(p.control.peak, 2);
  assert.equal(p.calls.length, 2);
  assert.equal(p.control.released, 2);
  assert.equal(new Set(p.moneyClients).size, 2);
});

test('one batch carries every root transaction on the connection that holds its lock', async () => {
  const p = fakeTarget({ due: [{ id: 'earning_a', version: '1' }, { id: 'earning_b', version: '1' }] });
  const result = await p.runner.runDueBatch(p.pool, { limit: 2, requestId: 'due_single', operator: p.operator() });
  assert.equal(result.batch.state, 'COMPLETE');
  assert.equal(p.control.peak, 1);
  assert.equal(new Set(p.moneyClients).size, 1);
});

test('a restarted driver resumes the unfinished original batch instead of a new key', async () => {
  const p = fakeTarget({ due: [{ id: 'earning_a', version: '1' }, { id: 'earning_b', version: '1' }] });
  const system: MaintenanceOperator = { userId: 'distribution-due-main', sessionId: 'system', system: true, authorize: async () => {} };
  p.control.failId = 'earning_a';
  await p.runner.runDueBatch(p.pool, { limit: 1, requestId: 'due_main_1700000000000', operator: system });
  p.control.failId = null;
  const found = await p.runner.findUnfinishedBatch(p.pool, { operator: system });
  assert.equal(found!.requestId, 'due_main_1700000000000');
  assert.equal(found!.operation, 'DUE_SETTLE');
  const resumed = await p.runner.resumeBatch(p.pool, { requestId: found!.requestId, operator: system });
  assert.equal(resumed.batch.state, 'COMPLETE');
  assert.deepEqual(p.calls, ['earning_a', 'earning_a']);
  assert.equal(await p.runner.findUnfinishedBatch(p.pool, { operator: system }), null);
});

test('a deterministic rejection terminalizes its root and never looks like a lost commit', async () => {
  const p = fakeTarget({ due: [{ id: 'earning_a', version: '1' }, { id: 'earning_b', version: '1' }] });
  p.control.rejectId = 'earning_a';
  const rejected = await p.runner.runDueBatch(p.pool, { limit: 1, requestId: 'due_rejected', operator: p.operator() });
  assert.equal(rejected.httpStatus, 200);
  assert.equal(rejected.batch.state, 'COMPLETE');
  assert.deepEqual(rejected.batch.results[0], { id: 'earning_a', earningId: 'earning_a', status: 'REJECTED', errorCode: 'CONFLICT' });
  assert.equal(await p.runner.findUnfinishedBatch(p.pool, { operator: p.operator() }), null, 'a terminal rejection is not an unfinished batch');
  const unknown = fakeTarget({ due: [{ id: 'earning_a', version: '1' }] });
  unknown.control.failId = 'earning_a';
  const lost = await unknown.runner.runDueBatch(unknown.pool, { limit: 1, requestId: 'due_lost', operator: unknown.operator() });
  assert.equal(lost.httpStatus, 503);
  assert.equal(lost.batch.state, 'UNKNOWN');
  assert.equal(lost.batch.results[0]!.status, 'UNKNOWN');
  assert.equal(lost.batch.results[0]!.recoveryRequired, true);
  assert.notEqual(await unknown.runner.findUnfinishedBatch(unknown.pool, { operator: unknown.operator() }), null);
  const skipped = fakeTarget();
  skipped.control.unknownAccrual = true;
  const noBasis = await skipped.runner.runReplayBatch(skipped.pool, { orderIds: ['order_1'], requestId: 'replay_no_basis', operator: skipped.operator() });
  assert.equal(noBasis.batch.state, 'COMPLETE');
  assert.deepEqual(noBasis.batch.results[0], { id: 'order_1', orderId: 'order_1', status: 'REJECTED', reason: 'ORDER_NOT_COMPLETED', baseCents: null });
});


test('Root: unknown rollback destroys the session and never saves or commits a receipt on it', async () => {
  const p = fakeTarget({ due:[{id:'earning_a',version:'1'}] });
  const originalConnect=p.pool.connect.bind(p.pool), wire:string[]=[], releases:any[]=[];
  (p.pool as any).connect=async()=>{const client=await originalConnect();const query=client.query.bind(client),release=client.release.bind(client);
    (client as any).query=async(sql:string,args:any[])=>{wire.push(sql);if(sql==='ROLLBACK')throw Error('ROLLBACK_ACK_UNKNOWN');return query(sql,args);};
    (client as any).release=(destroy?:boolean)=>{releases.push(destroy);release(destroy);};return client;};
  p.control.failId='earning_a';
  await assert.rejects(p.runner.runDueBatch(p.pool,{limit:1,requestId:'rollback_unknown',operator:p.operator()}),/unknown/);
  const rollback=wire.indexOf('ROLLBACK');assert.ok(rollback>=0);
  assert.deepEqual(wire.slice(rollback+1),[],'no BEGIN/save/COMMIT/unlock on the unconfirmed transaction');
  assert.deepEqual(releases,[true]);
  assert.equal([...p.records.values()][0]!.status,202,'original plan is retained for a fresh-connection read');
});


test('Root: an unknown advisory-lock acknowledgement destroys the session before any plan or money',async()=>{
  const p=fakeTarget({due:[{id:'earning_a',version:'1'}]});const releases:any[]=[],wire:string[]=[];
  const connect=p.pool.connect.bind(p.pool);
  (p.pool as any).connect=async()=>{const client=await connect(),query=client.query.bind(client),release=client.release.bind(client);
    (client as any).query=async(sql:string,args:any[])=>{wire.push(sql);if(sql.includes('pg_try_advisory_lock'))throw Error('LOCK_ACK_UNKNOWN');return query(sql,args);};
    (client as any).release=(destroy?:boolean)=>{releases.push(destroy);release(destroy);};return client;};
  await assert.rejects(p.runner.runDueBatch(p.pool,{limit:1,requestId:'lock_unknown',operator:p.operator()}),/LOCK_ACK_UNKNOWN/);
  assert.equal(wire.length,1);assert.deepEqual(releases,[true]);assert.equal(p.calls.length,0);assert.equal(p.records.size,0);
});
