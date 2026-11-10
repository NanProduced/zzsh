import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, rmdirSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { executeGrowthEntry, inlineGrowthIntent, syncInlineGrowthLog, verifyInlineGrowthLog } from './local-growth-packages.mjs';
import { assertMaintenanceLockHeld } from './local-target-registry.mjs';

const require = createRequire(new URL('../../apps/api/package.json', import.meta.url));
const enabled = Boolean(process.env.ZZSH_SYNTH_GROWTH_TX_PORT || process.env.ZZSH_SYNTH_GROWTH_TX_SYSTEM);
const sha = value => createHash('sha256').update(value).digest('hex');

test('growth transaction preserves committed and rolled-back outcomes on isolated PostgreSQL', { skip: !enabled }, async t => {
  const port = Number(process.env.ZZSH_SYNTH_GROWTH_TX_PORT), system = process.env.ZZSH_SYNTH_GROWTH_TX_SYSTEM;
  assert.equal(port, 61683); assert.match(system ?? '', /^[0-9]+$/);
  const { Pool } = require('pg'), pool = new Pool({ host: '127.0.0.1', port, database: 'zzsh_synth_growth_tx',
    user: 'postgres', password: 'synthetic-only-password', max: 2, connectionTimeoutMillis: 3000 });
  t.after(async () => pool.end());
  const identity = (await pool.query(`SELECT current_database() AS database, d.oid::text AS oid,
    shobj_description(d.oid, 'pg_database') AS marker, (SELECT system_identifier::text FROM pg_control_system()) AS system
    FROM pg_database d WHERE d.datname = current_database()`)).rows[0];
  assert.equal(identity.database, 'zzsh_synth_growth_tx'); assert.equal(identity.marker, 'zzsh:synthetic:growth-tx:v1');
  assert.equal(identity.system, system);
  await pool.query('CREATE TABLE IF NOT EXISTS synthetic_growth_events (id text PRIMARY KEY)');

  const cli = require('../../apps/api/dist/src/auth/membership-growth-legacy-cli.js');
  const maintenance = require('../../apps/api/dist/src/auth/membership-growth-legacy-maintenance.js');
  const { canonicalize } = require('../../apps/api/dist/src/supply/content-hash.js');
  const source = { subjectUserId: 'synthetic-subject', cutoff: '2026-10-18T00:00:00.000000Z', fromExclusive: null,
    sourceExtractSha256: 'b'.repeat(64), sourceSetSha256: sha(canonicalize({ subjectUserId: 'synthetic-subject',
      cutoff: '2026-10-18T00:00:00.000000Z', fromExclusive: null, expectedSourceKeys: [] })),
    expectedSourceKeys: [], refundReviewEvidenceRefs: ['SYNTHETIC_NONE'] };
  const business = Buffer.from(JSON.stringify({ schema: 'legacy-growth-maintenance-package-v1', reason: 'Synthetic transaction test',
    source: { receipt: source, inputs: [], corrections: [], admitted: { receiptDigests: [sha(canonicalize(source))], componentDigests: [], correctionDigests: [] }, gameIdBySettlementId: {} } }));
  const key = 'legacy-growth:synthetic-transaction-0001', now = Date.now();
  const directory = mkdtempSync(join(tmpdir(), 'zzsh-growth-tx-inline-')), paths = [];
  t.after(() => { for (const file of paths) if (existsSync(file)) { assert(lstatSync(file).isFile() && !lstatSync(file).isSymbolicLink()); unlinkSync(file); } rmdirSync(directory); });
  const approval = Buffer.from(JSON.stringify({ schema: 'legacy-growth-maintenance-approval-v2', status: 'APPROVED',
    approvalRef: 'SYNTHETIC-GROWTH-TRANSACTION', attempt: 1, mode: 'APPLY', businessPackageSha256: sha(business), executionKey: key,
    actor: { adminId: 'synthetic-admin', sessionId: 'synthetic-session' }, windowStartUtc: new Date(now - 60000).toISOString(),
    windowEndUtc: new Date(now + 600000).toISOString(), resource: { databaseName: identity.database, databaseOid: identity.oid,
      owner: 'postgres', runtimeRole: 'postgres', bindingKind: 'DATABASE_COMMENT', databaseComment: identity.marker } }));
  const input = cli.readLegacyGrowthMaintenanceRun({ LEGACY_GROWTH_ENABLED: 'true', LEGACY_GROWTH_PACKAGE_FILE: 'business',
    LEGACY_GROWTH_PACKAGE_SHA256: sha(business), LEGACY_GROWTH_APPROVAL_FILE: 'approval', LEGACY_GROWTH_APPROVAL_SHA256: sha(approval),
    LEGACY_GROWTH_MODE: 'APPLY' }, file => file === 'business' ? business : approval, now,
  { databaseName: identity.database, databaseUser: 'postgres' }).input;

  for (const mode of ['COMMIT', 'ROLLBACK', 'LOST_COMMIT_ACK', 'WRONG_COMMIT_TAG', 'WRONG_ROLLBACK_TAG', 'LOCK_RELEASED_BEFORE_COMMIT']) await t.test(mode, async s => {
    const id = randomUUID(), file = join(directory, mode + '.jsonl'); paths.push(file);
    const item = { userId: source.subjectUserId, executionKey: key, sha256: sha(business), coverageFingerprint: 'c'.repeat(64), coverageState: 'COMPLETE', contributionCount: 0 };
    const pending = { index: 1, executionKey: key, businessPackageSha256: item.sha256, approvalSha256: sha(approval), businessFingerprint: input.businessFingerprint };
    s.mock.method(maintenance, 'applyLegacyGrowthMaintenance', async client => {
      await client.query('INSERT INTO synthetic_growth_events(id) VALUES ($1)', [id]);
      if (mode === 'ROLLBACK' || mode === 'WRONG_ROLLBACK_TAG') throw Error('synthetic apply failure');
      return { replayed: false, receipt: { subjectUserId: item.userId, executionKey: key, businessFingerprint: pending.businessFingerprint,
        businessPackageSha256: item.sha256, coverageFingerprint: item.coverageFingerprint, coverageState: item.coverageState,
        sourceReceiptDigest: 'd'.repeat(64), inserted: 0, replayed: 0, execution: { approvalRef: 'SYNTHETIC-GROWTH-TRANSACTION', attempt: 1 } } };
    });
    const wrapper = { async connect() {
      const client = await pool.connect();
      return { async query(sql, ...args) {
        if (sql === 'COMMIT' && mode === 'LOST_COMMIT_ACK') { await client.query(sql); throw Error('synthetic lost commit response'); }
        if (sql === 'COMMIT' && mode === 'WRONG_COMMIT_TAG') return client.query('ROLLBACK');
        if (sql === 'ROLLBACK' && mode === 'WRONG_ROLLBACK_TAG') { const result = await client.query(sql); return { ...result, command: 'UNKNOWN' }; }
        return client.query(sql, ...args);
      }, release: discard => client.release(discard) };
    } };
    let lock, beforeCommit;
    if (mode === 'LOCK_RELEASED_BEFORE_COMMIT') {
      const { Client } = require('pg'); lock = new Client({ host: '127.0.0.1', port, database: 'postgres', user: 'postgres', password: 'synthetic-only-password' });
      await lock.connect(); s.after(async () => lock.end());
      assert.equal((await lock.query('SELECT pg_try_advisory_lock(806006::bigint) AS ok')).rows[0].ok, true);
      const target = { lockKey: '806006', maintenanceDatabase: 'postgres', instance: { systemIdentifier: system } };
      await assertMaintenanceLockHeld(lock, target);
      beforeCommit = async () => { assert.equal((await lock.query('SELECT pg_advisory_unlock(806006::bigint) AS ok')).rows[0].ok, true); await assertMaintenanceLockHeld(lock, target); };
    }
    const run = () => executeGrowthEntry({ pending, recovery: false,
      writeIntent: () => appendFileSync(file, JSON.stringify(inlineGrowthIntent(pending, approval)) + '\n', { flush: true }),
      execute: () => cli.runLegacyGrowthMaintenanceApply(wrapper, input, {}, beforeCommit),
      writeResult: reply => appendFileSync(file, JSON.stringify({ event: 'COMMIT_ACK', ...pending, reply }) + '\n') });
    if (mode === 'COMMIT') {
      await run(); syncInlineGrowthLog(file);
      assert.equal((await verifyInlineGrowthLog(file, { packages: [item], startIndex: 0, approvalBytesFor: () => approval })).completed, 1);
    } else await assert.rejects(run(), error => {
      assert(error instanceof cli.LegacyGrowthMaintenanceOutcomeError);
      assert.equal(error.outcome, ['LOST_COMMIT_ACK', 'WRONG_COMMIT_TAG'].includes(mode) ? 'COMMIT_UNKNOWN' : 'NOT_COMMITTED');
      assert.equal(error.rollbackAcknowledged, ['ROLLBACK', 'LOCK_RELEASED_BEFORE_COMMIT'].includes(mode)); assert.equal(error.preserved.executionKey, key);
      return true;
    });
    const count = (await pool.query('SELECT count(*)::int AS n FROM synthetic_growth_events WHERE id=$1', [id])).rows[0].n;
    assert.equal(count, ['COMMIT', 'LOST_COMMIT_ACK'].includes(mode) ? 1 : 0);
    const original = JSON.parse(readFileSync(file, 'utf8').split('\n')[0]);
    assert.equal(original.event, 'INTENT'); assert.equal(original.executionKey, key);
    assert(Buffer.from(original.approvalBytesBase64, 'base64').equals(approval));
    if (mode !== 'COMMIT') await assert.rejects(verifyInlineGrowthLog(file, { packages: [item], startIndex: 0, approvalBytesFor: () => approval }), /GROWTH_INLINE_LOG_INCOMPLETE/);
  });
});
