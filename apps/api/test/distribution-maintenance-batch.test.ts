import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Pool } from 'pg';
import { createMaintenanceBatchRunner } from '../src/finance/distribution-maintenance-batch';
import type { MaintenanceOperator } from '../src/finance/distribution-earning-store';

type Due = { id: string; version: string };
function fakePool(due: Due[]) {
  const records = new Map<string, { fingerprint: string; status: number; body: any }>(), settled = new Set<string>(), seen: string[] = [], calls: string[] = [];
  const control = { failId: null as string | null, authorizeCalls: 0 };
  const pool = { async connect() {
    return { release() {}, async query(sql: string, args: any[] = []): Promise<any> {
      seen.push(sql); const rows = (values: any[] = []) => ({ rows: values, rowCount: values.length });
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') return rows();
      if (sql.includes('pg_try_advisory_lock')) return rows([{ acquired: true }]);
      if (sql.includes('pg_advisory_unlock')) return rows();
      if (sql.startsWith('SELECT request_fingerprint')) { const key = args[0] + '|' + args[1], row = records.get(key); return rows(row ? [{ fingerprint: row.fingerprint, status: row.status, body: row.body }] : []); }
      if (sql.startsWith('INSERT INTO zzsh_supply.idempotency_record')) { const key = String(args[0]) + '|' + String(args[1]); if (records.has(key)) throw new Error('duplicate receipt'); records.set(key, { fingerprint: args[2], status: 202, body: JSON.parse(args[3]) }); return rows(); }
      if (sql.startsWith('UPDATE zzsh_supply.idempotency_record')) { const key = String(args[0]) + '|' + String(args[3]), row = records.get(key); if (!row || row.fingerprint !== args[4]) return rows(); row.status = args[1]; row.body = JSON.parse(args[2]); return { rows: [], rowCount: 1 }; }
      if (sql.includes('FROM zzsh_order.rental_referral_earning e') && sql.includes("e.state='PENDING'")) return rows(due.filter(row => !settled.has(row.id)).slice(0, args[2]));
      if (sql.startsWith('SELECT id,game_id FROM zzsh_order.rental_order')) return rows(args[0].map((id: string) => ({ id, game_id: 'delta' })));
      if (sql.startsWith('SELECT response_status AS status')) { const row = [...records.entries()].find(([key]) => key.endsWith('|' + args[1]))?.[1]; return rows(row ? [{ status: row.status, body: row.body }] : []); }
      if (sql.includes('audit_event')) return rows();
      throw new Error('Unexpected batch SQL: ' + sql);
    } };
  } } as unknown as Pool;
  const runner = createMaintenanceBatchRunner({
    local: false, allowedOrderIds: [],
    accrue: async (_pool, orderId) => { calls.push(orderId); if (control.failId === orderId) throw Object.assign(new Error('unknown'), { code: 'EVIDENCE_UNAVAILABLE' }); return { knowledge: 'KNOWN', items: [{ root: { id: 'earning_' + orderId }, replayed: false }] }; },
    transition: async (_pool, earningId) => { calls.push(earningId); if (control.failId === earningId) throw Object.assign(new Error('unknown'), { code: 'EVIDENCE_UNAVAILABLE' }); settled.add(earningId); return { root: { state: 'SETTLED' }, replayed: false }; },
  });
  const operator: MaintenanceOperator = { userId: 'admin', sessionId: 'session', authorize: async () => { control.authorizeCalls++; } };
  return { pool, runner, operator, control, calls, seen };
}

test('one due request keeps its original roots, parameters and receipt across retries', async () => {
  const p = fakePool([{ id: 'earning_a', version: '1' }, { id: 'earning_b', version: '1' }]);
  const first = await p.runner.runDueBatch(p.pool, { limit: 1, requestId: 'due_locked', operator: p.operator });
  assert.equal(first.batch.state, 'COMPLETE'); assert.deepEqual(first.batch.plan.earningIds, [{ earningId: 'earning_a', version: '1' }]); assert.deepEqual(p.calls, ['earning_a']);
  const retry = await p.runner.runDueBatch(p.pool, { limit: 1, requestId: 'due_locked', operator: p.operator });
  assert.equal(retry.replayed, true); assert.equal(retry.batch.state, 'COMPLETE'); assert.deepEqual(p.calls, ['earning_a']);
  await assert.rejects(p.runner.runDueBatch(p.pool, { limit: 2, requestId: 'due_locked', operator: p.operator }), /different parameters/);
  const next = await p.runner.runDueBatch(p.pool, { limit: 2, requestId: 'due_next', operator: p.operator });
  assert.deepEqual(next.batch.plan.earningIds, [{ earningId: 'earning_b', version: '1' }]); assert.deepEqual(p.calls, ['earning_a', 'earning_b']);
});

test('UNKNOWN batch resumes only its original plan and does not select the next roots', async () => {
  const p = fakePool([{ id: 'earning_a', version: '1' }, { id: 'earning_b', version: '1' }]);
  p.control.failId = 'earning_a';
  const first = await p.runner.runDueBatch(p.pool, { limit: 1, requestId: 'due_unknown', operator: p.operator });
  assert.equal(first.batch.state, 'UNKNOWN'); assert.deepEqual(first.batch.plan.earningIds, [{ earningId: 'earning_a', version: '1' }]); assert.equal(first.batch.notAttempted, 0);
  p.control.failId = null;
  const resumed = await p.runner.runDueBatch(p.pool, { limit: 1, requestId: 'due_unknown', operator: p.operator });
  assert.equal(resumed.replayed, true); assert.equal(resumed.batch.state, 'COMPLETE'); assert.deepEqual(resumed.batch.plan.earningIds, [{ earningId: 'earning_a', version: '1' }]);
  assert.deepEqual(p.calls, ['earning_a', 'earning_a']);
  const read = await p.runner.readBatch(p.pool, { requestId: 'due_unknown', operator: p.operator });
  assert.equal(read!.batch.state, 'COMPLETE'); assert.equal(read!.batch.results[0]!.status, 'SETTLED');
  assert.ok(p.control.authorizeCalls >= 3);
});

test('replay batch fixes explicit order ids and rejects same-key parameter changes', async () => {
  const p = fakePool([]);
  const result = await p.runner.runReplayBatch(p.pool, { orderIds: ['order_1', 'order_2'], requestId: 'replay_locked', operator: p.operator });
  assert.equal(result.batch.state, 'COMPLETE'); assert.deepEqual(result.batch.plan.orderIds, ['order_1', 'order_2']); assert.deepEqual(p.calls, ['order_1', 'order_2']);
  await assert.rejects(p.runner.runReplayBatch(p.pool, { orderIds: ['order_2'], requestId: 'replay_locked', operator: p.operator }), /different parameters/);
  const read = await p.runner.readBatch(p.pool, { requestId: 'replay_locked', operator: p.operator });
  assert.equal(read!.batch.operation, 'ACCRUALS_REPLAY');
});
