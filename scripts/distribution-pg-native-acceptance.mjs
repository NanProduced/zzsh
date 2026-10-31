// Sealed acceptance probe for the distribution v2/NATIVE forward package.
// Default: PLAN only. --execute applies 01+02+03 inside one migration transaction and ROLLBACKs.
// --full-native requires a sealed fixture manifest; without it the probe exits INCOMPLETE, never PASS.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Client } from 'pg';

const args = process.argv.slice(2), opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const execute = args.includes('--execute'), fullNative = args.includes('--full-native');
const fail = (code, detail) => { throw Object.assign(new Error(code), { code, detail }); };
const configPath = opt('--config'), expectedSha = opt('--sha256'), fixturePath = opt('--fixture'), fixtureSha = opt('--fixture-sha256');
if (!configPath || !expectedSha) fail('SEALED_CONFIG_REQUIRED');
const bytes = readFileSync(resolve(configPath));
if (createHash('sha256').update(bytes).digest('hex') !== expectedSha) fail('CONFIG_SHA_MISMATCH');
const config = JSON.parse(bytes.toString('utf8'));
const sha = (value) => createHash('sha256').update(value).digest('hex');
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
if (config.schema !== 'distribution-pg-acceptance.v1' || config.host !== '127.0.0.1' || config.port !== 55432 || config.database !== 'zzsh_test_regression'
  || config.marker !== 'zzsh:regression-test:v1' || !Number.isSafeInteger(config.resourceOid) || typeof config.nonce !== 'string'
  || !ID.test(config.ownerUser) || !ID.test(config.migrationUser) || !ID.test(config.runtimeUser)
  || !Number.isSafeInteger(config.roles?.migrationOid) || !Number.isSafeInteger(config.roles?.runtimeOid) || String(config.lockKey ?? '806006') !== '806006'
  || typeof config.statePath !== 'string' || typeof config.candidateDir !== 'string') fail('SEALED_CONFIG_SHAPE_INVALID');
const state = JSON.parse(readFileSync(resolve(config.statePath), 'utf8'));
if (state.database !== config.database || state.oid !== String(config.resourceOid) || state.nonce !== config.nonce || state.marker !== config.marker
  || state.pendingReset !== null || state.roles?.migration?.oid !== String(config.roles.migrationOid) || state.roles?.runtime?.oid !== String(config.roles.runtimeOid)) fail('REGISTERED_STATE_MISMATCH');
const files = ['01_uniform_policy_and_payment_basis.sql', '02_native_earning_and_reversal_scope.sql', '03_v2_registration_and_contract.sql'].map(name => resolve(config.candidateDir, name));
const sql = files.map(file => { const text = readFileSync(file, 'utf8'); if (/(^|\n)\s*(BEGIN|COMMIT)\s*;/i.test(text)) fail('CANDIDATE_HAS_TRANSACTION_WRAPPER', file); return { file, text }; });
if (fullNative && (!fixturePath || !fixtureSha || sha(readFileSync(resolve(fixturePath))) !== fixtureSha)) fail('FULL_NATIVE_SEALED_FIXTURE_REQUIRED');
const password = (name) => { const file = process.env[name]?.trim(); if (!file) fail(`${name}_MISSING`); return readFileSync(resolve(file), 'utf8').trim(); };
const client = (user, database, passwordFile) => new Client({ host: config.host, port: config.port, database, user, password: password(passwordFile), connectionTimeoutMillis: 4000, application_name: 'zzsh-distribution-acceptance' });
const results = [], check = (ok, code, detail) => { if (!ok) fail(code, detail); results.push({ check: ok, code, ...(detail ? { detail } : {}) }); };
async function expectState(c, savepoint, statement, params, expected, label) {
  await c.query(`SAVEPOINT ${savepoint}`);
  try { await c.query(statement, params); fail(`${label}_DID_NOT_FAIL`); }
  catch (error) { if (error.code === `${label}_DID_NOT_FAIL`) throw error; check(error.code === expected.code && (!expected.constraint || error.constraint === expected.constraint || String(error.message).includes(expected.constraint)), label, { sqlstate: error.code, constraint: error.constraint ?? null }); }
  await c.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); await c.query(`RELEASE SAVEPOINT ${savepoint}`);
}
const admin = client(config.ownerUser, 'postgres', 'DISTRIBUTION_OWNER_PASSWORD_FILE');
await admin.connect();
let target = null, locked = false, began = false;
try {
  locked = (await admin.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [config.lockKey])).rows[0]?.acquired === true;
  if (!locked) fail('MAINTENANCE_LOCK_BUSY');
  const identity = (await admin.query(`SELECT d.oid::text AS oid,shobj_description(d.oid,'pg_database') AS marker,pg_get_userbyid(d.datdba) AS owner,d.datallowconn AS allow,d.datistemplate AS template
    FROM pg_database d WHERE d.datname=$1`, [config.database])).rows[0];
  check(identity?.oid === String(config.resourceOid) && identity?.marker === config.marker && identity?.owner === config.ownerUser && identity.allow === true && identity.template === false, 'DATABASE_IDENTITY', identity);
  target = client(config.migrationUser, config.database, 'DISTRIBUTION_MIGRATION_PASSWORD_FILE');
  await target.connect();
  const nonce = (await target.query("SELECT current_database() AS database,current_user AS role,current_setting('zzsh.regression_run',true) AS nonce")).rows[0];
  check(nonce.database === config.database && nonce.role === config.migrationUser && nonce.nonce === config.nonce, 'TARGET_NONCE_AND_ROLE', nonce);
  const others = (await target.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND pid<>pg_backend_pid() AND backend_type='client backend'", [config.database])).rows[0].n;
  check(others === 0, 'NO_FOREIGN_SESSIONS', { others });
  if (!execute) {
    results.push({ check: true, code: 'PLAN_ONLY', files: files.map(file => ({ file, sha256: sha(readFileSync(file)) })) });
    console.log(JSON.stringify({ mode: 'PLAN', pass: true, identity: { oid: identity.oid, nonce, marker: identity.marker, owner: identity.owner }, results }, null, 1));
  } else {
    began = true; await target.query('BEGIN'); await target.query("SET LOCAL lock_timeout='2s'");
    const before = (await target.query(`SELECT (SELECT count(*)::int FROM zzsh_order.distribution_policy_version) AS versions,
      (SELECT count(*)::int FROM zzsh_order.distribution_policy_head) AS heads,
      (SELECT count(*)::int FROM zzsh_order.distribution_participant) AS participants,
      (SELECT count(*)::int FROM zzsh_order.invitation_relation) AS relations`)).rows[0];
    for (const file of sql) await target.query(file.text);
    check((await target.query("SELECT to_regprocedure('zzsh_order.distribution_policy_contract_version()') IS NOT NULL AS present")).rows[0].present === true, 'CONTRACT_FUNCTION_PRESENT');
    check((await target.query('SELECT zzsh_order.distribution_policy_contract_version() AS version')).rows[0].version === 2, 'CONTRACT_VERSION_TWO');
    const acl = (await target.query(`SELECT has_function_privilege(current_user,'zzsh_order.distribution_policy_contract_version()','EXECUTE') AS migration_exec,
      NOT EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
        WHERE p.oid='zzsh_order.distribution_policy_contract_version()'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public_exec
      `)).rows[0];
    check(acl.migration_exec === true && acl.public_exec === true, 'CONTRACT_ACL', acl);
    await target.query(`GRANT EXECUTE ON FUNCTION zzsh_order.distribution_policy_contract_version() TO ${config.runtimeUser}`);
    const runtime = client(config.runtimeUser, config.database, 'DISTRIBUTION_RUNTIME_PASSWORD_FILE');
    await runtime.connect();
    try { check((await runtime.query('SELECT zzsh_order.distribution_policy_contract_version() AS version')).rows[0].version === 2, 'RUNTIME_CONTRACT_ACL'); }
    finally { await runtime.end().catch(() => { process.exitCode = 1; }); }
    const adminId = (await target.query('SELECT id FROM zzsh_auth_admin."user" ORDER BY id LIMIT 1')).rows[0]?.id;
    check(Boolean(adminId), 'ADMIN_FIXTURE_REQUIRED');
    const good = { schema: 'distribution-policy.v2', scope: 'NATIVE', enabled: false, participation: 'AUTO_AT_REGISTRATION', depth: 1, selfRebate: false, accountModes: ['ordinary', 'custom'], minimumAccrualCents: '0', settlementDelayDays: 7, rateMode: 'UNIFORM', renterPercent: '5', ownerPercent: '5', levels: [] };
    const canonical = (value) => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']' : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
    const bad = { ...good, renterPercent: '60', ownerPercent: '60' };
    await expectState(target, 'bad_rate', `INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id) VALUES($1,1,'NATIVE','distribution-policy.v2',$2,$3,$4)`, ['probe_bad_v2', canonical(bad), sha(canonical(bad)), adminId], { code: '23514', constraint: 'uniform' }, 'UNIFORM_RATE_GUARD');
    const existingNative = (await target.query("SELECT count(*)::int AS n FROM zzsh_order.distribution_policy_head WHERE scope='NATIVE'")).rows[0].n;
    if (existingNative === 0) {
      await target.query(`INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id) VALUES('probe_v2',1,'NATIVE','distribution-policy.v2',$1,$2,$3)`, [canonical(good), sha(canonical(good)), adminId]);
      await target.query("INSERT INTO zzsh_order.distribution_policy_head(scope,revision,current_version_id) VALUES('NATIVE',1,'probe_v2')");
      check((await target.query("SELECT current_version_id FROM zzsh_order.distribution_policy_head WHERE scope='NATIVE'")).rows[0]?.current_version_id === 'probe_v2', 'V2_NATIVE_POLICY_ACCEPTED');
    } else results.push({ check: true, code: 'V2_NATIVE_POLICY_SKIPPED_EXISTING_HEAD' });
    await target.query('ROLLBACK'); began = false;
    const after = (await target.query(`SELECT (SELECT count(*)::int FROM zzsh_order.distribution_policy_version) AS versions,
      (SELECT count(*)::int FROM zzsh_order.distribution_policy_head) AS heads,
      (SELECT count(*)::int FROM zzsh_order.distribution_participant) AS participants,
      (SELECT count(*)::int FROM zzsh_order.invitation_relation) AS relations,
      (SELECT count(*)::int FROM zzsh_order.distribution_policy_head WHERE scope='NATIVE') AS native_heads`)).rows[0];
    check(after.versions === before.versions && after.heads === before.heads && after.participants === before.participants && after.relations === before.relations, 'ROLLBACK_RESTORED_ORIGINAL', { before, after });
    if (fullNative) {
      console.error(JSON.stringify({ mode: 'FULL_NATIVE', pass: false, code: 'INCOMPLETE_FULL_NATIVE_FIXTURE_NOT_EXECUTED', note: 'structure checks passed; payment→posting→accrual→SETTLE→REVOKE/RECOVER real fixture is not implemented in this probe' }));
      process.exitCode = 2;
    } else console.log(JSON.stringify({ mode: 'STRUCTURE_ROLLBACK', pass: true, identity: { oid: identity.oid, nonce, marker: identity.marker, owner: identity.owner }, results }, null, 1));
  }
} catch (error) {
  if (began && target) await target.query('ROLLBACK').catch(() => {});
  console.error(JSON.stringify({ mode: fullNative ? 'FULL_NATIVE' : 'STRUCTURE_ROLLBACK', pass: false, code: error.code ?? 'FAILED', message: error.message, detail: error.detail ?? null }));
  process.exitCode = 1;
} finally {
  if (target) await target.end().catch(() => { if (!process.exitCode) process.exitCode = 1; });
  if (locked) await admin.query('SELECT pg_advisory_unlock($1::bigint)', [config.lockKey]).catch(() => { if (!process.exitCode) process.exitCode = 1; });
  await admin.end().catch(() => { if (!process.exitCode) process.exitCode = 1; });
}
