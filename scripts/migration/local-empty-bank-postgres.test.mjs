import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { readLegacyBankTargetSet } from './local-legacy-bank-runner.mjs';

const enabled = Boolean(process.env.ZZSH_SYNTH_EMPTY_BANK_PORT || process.env.ZZSH_SYNTH_EMPTY_BANK_SYSTEM);

test('legacy bank target set readback detects extra rows, hidden rows and missing privileges', { skip: !enabled }, async t => {
  const port = Number(process.env.ZZSH_SYNTH_EMPTY_BANK_PORT), system = process.env.ZZSH_SYNTH_EMPTY_BANK_SYSTEM;
  assert.equal(port, 61683); assert.match(system ?? '', /^[0-9]+$/);
  const require = createRequire(new URL('../../apps/api/package.json', import.meta.url)), { Pool } = require('pg');
  const pool = new Pool({ host: '127.0.0.1', port, database: 'zzsh_synth_growth_tx', user: 'postgres',
    password: 'synthetic-only-password', max: 1, connectionTimeoutMillis: 3000 });
  t.after(() => pool.end());
  const identity = (await pool.query(`SELECT current_database() AS database,
    shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') AS marker,
    (SELECT system_identifier::text FROM pg_control_system()) AS system,
    (SELECT count(*)::int FROM pg_namespace WHERE nspname LIKE 'zzsh_%') AS schemas`)).rows[0];
  assert.deepEqual(identity, { database: 'zzsh_synth_growth_tx', marker: 'zzsh:synthetic:growth-tx:v1', system, schemas: 0 });
  await pool.query(`CREATE ROLE zzsh_synth_empty_bank_read NOLOGIN;
    CREATE SCHEMA zzsh_order; CREATE SCHEMA zzsh_iam;
    CREATE TABLE zzsh_order.withdrawal_bank_binding(id text PRIMARY KEY);
    CREATE TABLE zzsh_iam.audit_event(object_type text,action text,outcome text);
    GRANT USAGE ON SCHEMA zzsh_order,zzsh_iam TO zzsh_synth_empty_bank_read;
    GRANT SELECT ON zzsh_order.withdrawal_bank_binding,zzsh_iam.audit_event TO zzsh_synth_empty_bank_read`);
  const read = async (expected = 0) => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      await client.query('SET LOCAL ROLE zzsh_synth_empty_bank_read');
      return await readLegacyBankTargetSet(client, expected);
    } finally { try { await client.query('ROLLBACK'); } finally { client.release(); } }
  };
  assert.deepEqual(await read(), { status: 'BANK_TARGET_SET_READBACK_PASSED', expected: '0', bindings: '0', legacyImportAudits: '0' });
  await pool.query("INSERT INTO zzsh_order.withdrawal_bank_binding(id) VALUES ('synthetic')");
  assert.equal((await read()).status, 'BANK_TARGET_SET_REVIEW_REQUIRED');
  assert.equal((await read(1)).status, 'BANK_TARGET_SET_REVIEW_REQUIRED');
  await pool.query("INSERT INTO zzsh_iam.audit_event VALUES ('withdrawal_bank_binding','withdrawal.bank_binding.legacy_imported','SUCCESS')");
  assert.deepEqual(await read(1), { status: 'BANK_TARGET_SET_READBACK_PASSED', expected: '1', bindings: '1', legacyImportAudits: '1' });
  await pool.query('DELETE FROM zzsh_order.withdrawal_bank_binding');
  assert.deepEqual(await read(), { status: 'BANK_TARGET_SET_REVIEW_REQUIRED', expected: '0', bindings: '0', legacyImportAudits: '1' });
  await pool.query('DELETE FROM zzsh_iam.audit_event');
  await pool.query('ALTER TABLE zzsh_order.withdrawal_bank_binding ENABLE ROW LEVEL SECURITY');
  await pool.query('CREATE POLICY synthetic_hidden ON zzsh_order.withdrawal_bank_binding USING (false)');
  await assert.rejects(read(), error => error.code === '42501');
  await pool.query('ALTER TABLE zzsh_order.withdrawal_bank_binding DISABLE ROW LEVEL SECURITY');
  await pool.query('REVOKE SELECT ON zzsh_iam.audit_event FROM zzsh_synth_empty_bank_read');
  await assert.rejects(read(), error => error.code === '42501');
});
