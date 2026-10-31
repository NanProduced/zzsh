// Read-only-to-the-repository PG probe: applies the two unnumbered candidates inside one
// transaction on the registered regression database, asserts, then ROLLBACKs everything.
// Requires the shared maintenance lock 806006 and no other session on the target database.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const MAIN = 'E:/zzsh/zzsh';
const ENV = resolve(MAIN, 'apps/api/.env');
const STATE = resolve(MAIN, 'apps/api/.secrets/local-postgresql/regression_test/resource.json');
const LOCK = '806006';
const DB = 'zzsh_test_regression';
const OUT = [];
const log = (value) => { OUT.push(value); };
const fail = (code) => { throw Object.assign(new Error(code), { code }); };

function envFile(path) {
  const map = {};
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
    if (match) map[match[1]] = match[2].trim();
  }
  return map;
}
function secret(file) {
  if (!file) fail('DB_PASSWORD_FILE_MISSING');
  return readFileSync(resolve(MAIN, 'apps/api', file), 'utf8').trim();
}
function canonical(value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value && typeof value === 'object') return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
  return JSON.stringify(value);
}
function stripTransaction(sql) {
  return sql.replace(/^\s*BEGIN\s*;\s*/i, '').replace(/\s*COMMIT\s*;\s*$/i, '');
}
async function expectError(client, label, sql, args) {
  await client.query('SAVEPOINT expected_error');
  try { await client.query(sql, args); fail(label + '_DID_NOT_FAIL'); }
  catch (error) { if (error.code === label + '_DID_NOT_FAIL') throw error; }
  await client.query('ROLLBACK TO SAVEPOINT expected_error');
  await client.query('RELEASE SAVEPOINT expected_error');
}

const env = envFile(ENV), state = JSON.parse(readFileSync(STATE, 'utf8'));
if (state.pendingReset !== null || state.database !== DB) fail('REGRESSION_STATE_NOT_CLEAN');
const connection = { host: env.DB_HOST ?? '127.0.0.1', port: Number(env.DB_PORT ?? 55432), user: env.DB_USER ?? 'zzsh', password: secret(env.DB_PASSWORD_FILE), connectionTimeoutMillis: 4000, application_name: 'zzsh-distribution-probe' };

const admin = new Client({ ...connection, database: 'postgres', statement_timeout: 5000, lock_timeout: 1000 });
await admin.connect();
let client = null, locked = false;
try {
  locked = (await admin.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [LOCK])).rows[0]?.acquired === true;
  if (!locked) fail('MAINTENANCE_LOCK_BUSY');
  const actual = (await admin.query('SELECT oid::text AS oid, shobj_description(oid,\'pg_database\') AS marker, datallowconn AS allowconn FROM pg_database WHERE datname=$1', [DB])).rows[0];
  if (!actual || actual.oid !== state.oid || actual.marker !== state.marker || actual.allowconn !== true) fail('REGRESSION_OID_MARKER_MISMATCH');
  const superuser = (await admin.query('SELECT rolsuper FROM pg_roles WHERE rolname=current_user')).rows[0]?.rolsuper;
  log({ stage: 'identity', oid: actual.oid, nonce: state.nonce, marker: actual.marker, superuser: superuser === true });

  client = new Client({ ...connection, database: DB, statement_timeout: 15000, lock_timeout: 2000 });
  await client.connect();
  const others = (await client.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid() AND backend_type='client backend'", [DB])).rows[0].n;
  if (others !== 0) fail('REGRESSION_IN_USE_BY_OTHER_SESSION');

  await client.query('BEGIN');
  await client.query("SET LOCAL lock_timeout='2s'");
  const before = (await client.query("SELECT (SELECT count(*)::int FROM zzsh_order.distribution_policy_version) AS versions,(SELECT count(*)::int FROM zzsh_order.distribution_policy_head) AS heads")).rows[0];
  const sql1 = stripTransaction(readFileSync(resolve('apps/api/migrations/candidates/distribution-business-closure-1/01_uniform_policy_and_payment_basis.sql'), 'utf8'));
  const sql2 = stripTransaction(readFileSync(resolve('apps/api/migrations/candidates/distribution-business-closure-1/02_native_earning_and_reversal_scope.sql'), 'utf8'));
  await client.query(sql1);
  await client.query(sql2);
  log({ stage: 'ddl_applied' });

  const defs = (await client.query(`SELECT pg_get_functiondef('zzsh_order.guard_distribution_policy_version()'::regprocedure) AS policy,
    pg_get_functiondef('zzsh_order.derive_payment_referral_inputs(text)'::regprocedure) AS derive,
    pg_get_functiondef('zzsh_order.guard_earning_entry()'::regprocedure) AS entry,
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='distribution_policy_version_schema_version_check') AS schema_check,
    (SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='rental_referral_reversal_source_scope_check') AS reversal_check`)).rows[0];
  const assert = (ok, code) => { if (!ok) fail(code); };
  assert(defs.policy.includes('distribution-policy.v2') && defs.policy.includes('rateMode'), 'POLICY_GUARD_NOT_UPDATED');
  assert(defs.derive.includes('uniform') && defs.derive.includes('renterPercent'), 'DERIVE_NOT_UPDATED');
  assert(defs.entry.includes("mode='NATIVE'") && defs.entry.includes('expected_scope'), 'ENTRY_SCOPE_NOT_UPDATED');
  assert(defs.schema_check.includes('distribution-policy.v2'), 'SCHEMA_CHECK_NOT_UPDATED');
  assert(defs.reversal_check.includes('NATIVE'), 'REVERSAL_SCOPE_NOT_UPDATED');
  log({ stage: 'function_constraint_assertions', pass: true });

  const adminId = (await client.query('SELECT id FROM zzsh_auth_admin."user" ORDER BY id LIMIT 1')).rows[0]?.id;
  if (!adminId) { log({ stage: 'policy_guard', skipped: 'NO_ADMIN_USER' }); }
  else {
    const existing = (await client.query("SELECT scope FROM zzsh_order.distribution_policy_head WHERE scope='NATIVE'")).rowCount;
    if (existing) log({ stage: 'policy_guard', skipped: 'NATIVE_HEAD_EXISTS' });
    else {
      const good = { schema: 'distribution-policy.v2', scope: 'NATIVE', enabled: true, participation: 'AUTO_AT_REGISTRATION', depth: 1, selfRebate: false, accountModes: ['ordinary', 'custom'], minimumAccrualCents: '0', settlementDelayDays: 7, rateMode: 'UNIFORM', renterPercent: '5', ownerPercent: '5', levels: [] };
      const bad = { ...good, renterPercent: '60', ownerPercent: '60' };
      const id = 'probe_v2_' + state.nonce.slice(0, 12), sha = (text) => createHash('sha256').update(text).digest('hex');
      await expectError(client, 'UNIFORM_RATE_CAP', `INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id)
        VALUES($1,1,'NATIVE','distribution-policy.v2',$2,$3,$4)`, ['probe_bad_' + id, canonical(bad), sha(canonical(bad)), adminId]);
      await client.query(`INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id)
        VALUES($1,1,'NATIVE','distribution-policy.v2',$2,$3,$4)`, [id, canonical(good), sha(canonical(good)), adminId]);
      await client.query(`INSERT INTO zzsh_order.distribution_policy_head(scope,revision,current_version_id) VALUES('NATIVE',1,$1)`, [id]);
      const read = (await client.query("SELECT h.scope,h.revision::text,v.schema_version FROM zzsh_order.distribution_policy_head h JOIN zzsh_order.distribution_policy_version v ON v.id=h.current_version_id WHERE h.scope='NATIVE'")).rows[0];
      assert(read?.schema_version === 'distribution-policy.v2' && read.revision === '1', 'V2_POLICY_NOT_READABLE');
      log({ stage: 'policy_guard', pass: true, rejected: 'UNIFORM_RATE_CAP', accepted: 'distribution-policy.v2' });
    }
  }

  const order = (await client.query('SELECT id FROM zzsh_order.rental_order WHERE currency=\'CNY\' LIMIT 1')).rows[0]?.id;
  if (order) {
    const derived = (await client.query('SELECT zzsh_order.derive_payment_referral_inputs($1) AS v', [order])).rows[0].v;
    assert(derived && Array.isArray(derived.roles) && derived.roles.length === 2, 'DERIVE_EXECUTION_FAILED');
    log({ stage: 'derive_execution', pass: true, order: order, roles: derived.roles.length });
  } else log({ stage: 'derive_execution', skipped: 'NO_CNY_ORDER' });

  await client.query('ROLLBACK');
  const after = (await client.query("SELECT (SELECT count(*)::int FROM zzsh_order.distribution_policy_version) AS versions,(SELECT count(*)::int FROM zzsh_order.distribution_policy_head) AS heads")).rows[0];
  assert(JSON.stringify(before) === JSON.stringify(after), 'ROLLBACK_LEFT_POLICY_RESIDUE');
  const nativeHead = (await client.query("SELECT count(*)::int AS n FROM zzsh_order.distribution_policy_head WHERE scope='NATIVE'")).rows[0].n;
  assert(nativeHead === 0, 'NATIVE_HEAD_RESIDUE');
  log({ stage: 'rollback_verified', before, after, nativeHead });
} finally {
  if (client) await client.end().catch(() => {});
  if (locked) await admin.query('SELECT pg_advisory_unlock($1::bigint)', [LOCK]).catch(() => {});
  await admin.end().catch(() => {});
}
console.log(JSON.stringify({ pass: true, database: DB, lock: LOCK, results: OUT }, null, 1));
