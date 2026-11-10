import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import test from 'node:test';
import { executeQualification } from './local-distribution-qualification-runner.mjs';
import { guardedApprovalPool } from './local-distribution-policy-runtime.mjs';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const enabled = Boolean(process.env.ZZSH_SYNTH_DIST_TX_PORT || process.env.ZZSH_SYNTH_DIST_TX_SYSTEM);

test('distribution transaction acknowledgements on isolated PostgreSQL', { skip: !enabled }, async t => {
  const port = Number(process.env.ZZSH_SYNTH_DIST_TX_PORT), system = process.env.ZZSH_SYNTH_DIST_TX_SYSTEM;
  assert.equal(port, 61683); assert.match(system ?? '', /^[0-9]+$/);
  const { Client, Pool } = require('pg'), base = { host: '127.0.0.1', port, user: 'postgres', password: 'synthetic-only-password', connectionTimeoutMillis: 3000 };
  const inspect = new Pool({ ...base, database: 'zzsh_synth_growth_tx', max: 1 });
  t.after(() => inspect.end());
  const identity = (await inspect.query(`SELECT current_database() AS database,d.oid::text AS oid,
    shobj_description(d.oid,'pg_database') AS marker,(SELECT system_identifier::text FROM pg_control_system()) AS system
    FROM pg_database d WHERE d.datname=current_database()`)).rows[0];
  assert.equal(identity.database, 'zzsh_synth_growth_tx'); assert.equal(identity.marker, 'zzsh:synthetic:growth-tx:v1'); assert.equal(identity.system, system);
  await inspect.query('CREATE TABLE IF NOT EXISTS synthetic_distribution_events (id text PRIMARY KEY)');

  for (const mode of ['COMMIT', 'ABORTED_COMMIT', 'LOST_COMMIT_ACK', 'WRONG_ROLLBACK_TAG', 'LOCK_RELEASED_BEFORE_COMMIT']) await t.test(mode, async s => {
    const id = randomUUID(), basePool = new Pool({ ...base, database: identity.database, max: 1 }), rawLock = new Client({ ...base, database: 'postgres' });
    let lockChecks = 0;
    const lock = { on: (...args) => rawLock.on(...args), connect: () => rawLock.connect(), end: () => rawLock.end(), async query(sql, ...args) {
      if (sql.includes('pg_locks') && ++lockChecks === 2 && mode === 'LOCK_RELEASED_BEFORE_COMMIT') await rawLock.query('SELECT pg_advisory_unlock(806006::bigint)');
      return rawLock.query(sql, ...args);
    } };
    let poolClosed = false, discarded = false;
    s.after(async () => { if (!poolClosed) await basePool.end(); });
    const pool = { async connect() {
      const client = await basePool.connect(); return { async query(sql, ...args) {
        if (sql === 'SET CONSTRAINTS ALL IMMEDIATE' && mode === 'ABORTED_COMMIT') {
          try { await client.query('SELECT 1/0'); } catch { /* exercise PostgreSQL COMMIT returning ROLLBACK */ }
          return { command: 'SET', rows: [] };
        }
        if (sql === 'COMMIT' && mode === 'LOST_COMMIT_ACK') { await client.query(sql); throw Error('synthetic lost commit response'); }
        if (sql === 'ROLLBACK' && mode === 'WRONG_ROLLBACK_TAG') { const result = await client.query(sql); return { ...result, command: 'UNKNOWN' }; }
        return client.query(sql, ...args);
      }, release(destroy) { discarded = Boolean(destroy); client.release(destroy); } };
    }, async end() { await basePool.end(); poolClosed = true; } };
    const batch = { bodyDigest: 'synthetic-digest', body: { subjects: [{ userId: 'synthetic-subject' }] } }, summary = {};
    const params = { pool, lock, summary, save() {}, verifyBuild() {}, identity: async () => ({ oid: identity.oid, owner: 'postgres', owner_oid: 1, marker: identity.marker, role: 'postgres', role_oid: '1' }),
      plan: { target: { ownerOid: 1 }, batches: [batch] }, authority: { approvalRef: 'synthetic', attempt: '1', notBefore: '2026-01-01T00:00:00.000Z', expiresAt: '2099-01-01T00:00:00.000Z' },
      actor: { userId: 'synthetic-admin', sessionId: 'synthetic-session' }, registry: { database: identity.database }, target: { nonce: 'synthetic' }, sourceDigest: 'synthetic',
      bind: async (_client, _actor, review) => review,
      qualify: async (client, _actor, body, review) => { await client.query('INSERT INTO synthetic_distribution_events(id) VALUES ($1)', [id]);
        if (mode === 'WRONG_ROLLBACK_TAG') throw Error('synthetic rejection');
        return { status: 200, body: { bodyDigest: review.bodyDigest, participants: body.subjects.length, financialEffects: false } }; } };
    if (mode === 'COMMIT') {
      await executeQualification(params); assert.equal(summary.status, 'COMMITTED_ACK_READBACK_REQUIRED');
    } else {
      await assert.rejects(executeQualification(params));
      if (mode === 'WRONG_ROLLBACK_TAG') { assert.equal(summary.transaction.status, 'ROLLBACK_UNKNOWN'); assert.equal(summary.rollbackAck, false); }
      else if (mode === 'LOCK_RELEASED_BEFORE_COMMIT') { assert.equal(summary.status, 'STOPPED'); assert.equal(summary.transaction.status, 'ROLLBACK_ACKNOWLEDGED'); assert.equal(summary.rollbackAck, true); }
      else { assert.equal(summary.status, 'COMMIT_UNKNOWN'); assert.equal(summary.transaction.status, 'COMMIT_UNKNOWN'); }
      assert.equal(discarded, mode !== 'LOCK_RELEASED_BEFORE_COMMIT');
    }
    const count = (await inspect.query('SELECT count(*)::int AS n FROM synthetic_distribution_events WHERE id=$1', [id])).rows[0].n;
    assert.equal(count, ['COMMIT', 'LOST_COMMIT_ACK'].includes(mode) ? 1 : 0);
  });

  await t.test('approval wrapper rejects a real COMMIT that PostgreSQL reports as ROLLBACK', async () => {
    const { withTransaction } = require('../../apps/api/dist/src/auth/security-core.js'), id = randomUUID();
    await assert.rejects(withTransaction(guardedApprovalPool(inspect, () => {}), async client => {
      await client.query('INSERT INTO synthetic_distribution_events(id) VALUES ($1)', [id]);
      try { await client.query('SELECT 1/0'); } catch { /* keep the transaction aborted */ }
    }), /DISTRIBUTION_APPROVAL_COMMIT_ACK_UNCONFIRMED/);
    assert.equal((await inspect.query('SELECT count(*)::int AS n FROM synthetic_distribution_events WHERE id=$1', [id])).rows[0].n, 0);
  });
});
