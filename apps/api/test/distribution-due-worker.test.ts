import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import type { Pool, PoolClient } from 'pg';
import { DistributionDueService, loadDistributionDueRuntime } from '../src/finance/distribution-due.module';

type Drive = { kind: 'new' | 'resume' | 'find'; requestId?: string; limit?: number; client: string | null };
let sessionSequence = 0;

/** One fake server shared by both instances: exactly one session may hold advisory key 806007. */
function harness(options: { batchLimit?: number; workerId?: string; server?: { holder: string | null } } = { batchLimit: 20 }) {
  const locks = options.server ?? { holder: null as string | null };
  const driven: Drive[] = [];
  const control = { unfinished: null as null | { requestId: string }, state: 'COMPLETE' as 'COMPLETE' | 'UNKNOWN', failNew: false, failResume: false };
  let sequence = sessionSequence;
  sessionSequence += 100;
  const clients: Array<PoolClient & { id: string; alive: boolean; dropped: boolean }> = [];
  const makeClient = () => {
    const id = 'sess_' + (sequence++);
    const entry = { id, alive: true, dropped: false, once() { /* the real client is an EventEmitter; loss is simulated by dropped */ }, release() { if (!entry.alive) return; entry.alive = false; if (locks.holder === id) locks.holder = null; clients.splice(clients.indexOf(entry as any), 1); },
      async query(sql: string, args: any[] = []) {
        if (!entry.alive || entry.dropped) throw Object.assign(new Error('CONNECTION_CLOSED'), { code: '57P01' });
        if (sql.includes('pg_try_advisory_lock')) {
          if (String(args[0]) !== '806007') return { rows: [{ acquired: true }], rowCount: 1 };
          if (locks.holder !== null && locks.holder !== id) return { rows: [{ acquired: false }], rowCount: 1 };
          locks.holder = id; return { rows: [{ acquired: true }], rowCount: 1 };
        }
        if (sql.includes('pg_advisory_unlock')) { if (String(args[0]) === '806007' && locks.holder === id) locks.holder = null; return { rows: [], rowCount: 0 }; }
        if (sql.includes('FROM pg_locks')) return { rows: [{ held: locks.holder === id ? 1 : 0 }], rowCount: 1 };
        return { rows: [], rowCount: 0 };
      } } as unknown as PoolClient & { id: string; alive: boolean; dropped: boolean };
    clients.push(entry);
    return entry;
  };
  const pool = { async connect() { return makeClient(); } } as unknown as Pool;
  let newKey: string | null = null;
  const store = {
    async findUnfinishedBatch(_p: Pool, input: { client?: PoolClient }) { driven.push({ kind: 'find', client: (input.client as any)?.id ?? null }); return control.unfinished; },
    async resumeBatch(_p: Pool, input: { requestId: string; client?: PoolClient }) {
      driven.push({ kind: 'resume', requestId: input.requestId, client: (input.client as any)?.id ?? null });
      if (control.failResume) throw new Error('original receipt read failed');
      control.unfinished = null;
      return { httpStatus: 200, batch: { state: control.state, requestId: input.requestId, results: [{ id: 'earning_a' }], notAttempted: 0 }, replayed: true };
    },
    async runDueBatch(_p: Pool, input: { requestId: string; limit: number; client?: PoolClient }) {
      driven.push({ kind: 'new', requestId: input.requestId, limit: input.limit, client: (input.client as any)?.id ?? null });
      newKey = input.requestId;
      if (control.failNew) throw new Error('progress receipt commit unknown');
      control.unfinished = control.state === 'UNKNOWN' ? { requestId: input.requestId } : null;
      return { httpStatus: control.state === 'UNKNOWN' ? 503 : 200, batch: { state: control.state, requestId: input.requestId, results: [{ id: 'earning_a' }], notAttempted: 0 }, replayed: false };
    },
  };
  const service = new DistributionDueService({ pool, store: store as any, intervalMs: 60000, batchLimit: options.batchLimit ?? 20, workerId: options.workerId ?? 'main' });
  return { service, driven, control, locks, clients, keys: () => driven.filter(d => d.kind !== 'find').map(d => d.requestId), newKey: () => newKey };
}

test('the driver only runs while its own session still holds the due lock', async () => {
  const h = harness();
  await h.service.tick();
  assert.equal(h.driven.filter(d => d.kind === 'new').length, 1);
  assert.equal(h.locks.holder, h.driven[1]!.client);
  assert.equal(h.clients.filter(c => c.alive).length, 1);
  await h.service.tick();
  assert.equal(h.driven.filter(d => d.kind === 'new').length, 2);
  assert.equal(h.clients.filter(c => c.alive).length, 1, 'the same session keeps driving');
  await h.service.onApplicationShutdown();
  assert.equal(h.locks.holder, null);
  assert.equal(h.clients.filter(c => c.alive).length, 0);
});

test('an exception after planning keeps the original key and the next cycle resumes it', async () => {
  const h = harness();
  h.control.failNew = true;
  await h.service.tick();
  assert.equal(h.driven.filter(d => d.kind === 'new').length, 1);
  const original = h.newKey()!;
  h.control.failNew = false;
  h.control.unfinished = { requestId: original };
  await h.service.tick();
  assert.deepEqual(h.keys(), [original, original]);
  assert.equal(h.driven.filter(d => d.kind === 'new').length, 1, 'no new key after an unknown commit');
});

test('an UNKNOWN batch is resumed under its original key instead of selecting the next roots', async () => {
  const h = harness();
  h.control.state = 'UNKNOWN';
  await h.service.tick();
  const original = h.newKey()!;
  h.control.state = 'COMPLETE';
  await h.service.tick();
  assert.deepEqual(h.keys(), [original, original]);
  assert.equal(h.driven.filter(d => d.kind === 'resume').length, 1);
});

test('a restarted driver resumes the persisted original batch before planning a new one', async () => {
  const first = harness();
  await first.service.tick();
  const original = first.newKey()!;
  first.control.unfinished = { requestId: original };
  // Simulate a process rebuild that loses every in-memory flag but keeps the persisted batch.
  const second = harness();
  second.control.unfinished = { requestId: original };
  await second.service.tick();
  assert.equal(second.driven.filter(d => d.kind === 'resume').length, 1);
  assert.equal(second.driven.filter(d => d.kind === 'new').length, 0, 'a rebuilt worker must not pick the next batch');
  assert.equal(second.driven.find(d => d.kind === 'resume')!.requestId, original);
});

test('changing the interval or batch limit cannot change the original batch input', async () => {
  const small = harness({ batchLimit: 5 });
  await small.service.tick();
  const original = small.newKey()!;
  const later = harness({ batchLimit: 100 });
  later.control.unfinished = { requestId: original };
  await later.service.tick();
  const resumed = later.driven.find(d => d.kind === 'resume')!;
  assert.equal(resumed.requestId, original);
  assert.equal((resumed as any).limit, undefined, 'resume carries the original key only, never the current limit');
});

test('a session that lost its lock stops driving and a waiting instance takes over', async () => {
  const server = { holder: null as string | null };
  const a = harness({ workerId: 'a', server }), b = harness({ workerId: 'b', server });
  await a.service.tick();
  const held = a.driven.find(d => d.kind === 'new')!.client;
  assert.equal(server.holder, held);
  await b.service.tick();
  assert.equal(b.driven.length, 0, 'a lock-starved instance performs no money work');
  assert.equal(server.holder, held, 'a waiting instance cannot steal a live lock');
  // A's database session dies: PG drops the lock and A must notice before starting more work.
  a.clients.forEach(client => { client.dropped = true; });
  const drivenBefore = a.driven.length;
  await a.service.tick();
  assert.equal(a.driven.length, drivenBefore, 'the stale instance stops before touching money');
  assert.equal(server.holder, null, 'a dead session cannot keep the execution right');
  await b.service.tick();
  assert.equal(b.driven.filter(d => d.kind === 'new').length, 1, 'the waiting instance takes over without a restart');
});

test('the worker runtime stays opt-in and refuses an assembly without an earning store', () => {
  assert.equal(loadDistributionDueRuntime(undefined, undefined, { DISTRIBUTION_DUE_WORKER_ENABLED: 'false' }), undefined);
  assert.throws(() => loadDistributionDueRuntime({} as Pool, undefined, { DISTRIBUTION_DUE_WORKER_ENABLED: 'true' }), /requires explicit NATIVE distribution assembly/);
  assert.throws(() => loadDistributionDueRuntime({} as Pool, {} as any, { DISTRIBUTION_DUE_WORKER_ENABLED: 'true', DISTRIBUTION_DUE_INTERVAL_MS: '1000' }), /60000-3600000/);
  assert.throws(() => loadDistributionDueRuntime({} as Pool, {} as any, { DISTRIBUTION_DUE_WORKER_ENABLED: 'true', DISTRIBUTION_DUE_BATCH_LIMIT: '500' }), /BATCH_LIMIT must be 1-100/);
});
