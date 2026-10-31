import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { CANDIDATES, EXPECTED, sealedPlan, sha256, run, structurePhase, policyPhase, fundsPhase, cleanupPhase, createLedger } from './distribution-pg-native-acceptance.mjs';

const clean = (name) => `-- ${name}\nSELECT 1;\n`;
const sqlBytes = Object.fromEntries(CANDIDATES.map(name => [name, Buffer.from(clean(name))]));
const baseConfig = () => ({ schema: 'distribution-pg-acceptance.v2', host: EXPECTED.host, port: EXPECTED.port, database: EXPECTED.database, marker: EXPECTED.marker, lockKey: EXPECTED.lockKey,
  resourceOid: 987654, nonce: 'a'.repeat(32), statePath: 'state.json', candidateDir: 'candidates',
  ownerUser: 'zzsh_regression_owner', migrationUser: 'zzsh_regression_migration', runtimeUser: 'zzsh_regression_runtime',
  roles: { migrationOid: 111, runtimeOid: 222 }, expectedSqlSha256: Object.fromEntries(CANDIDATES.map(name => [name, sha256(sqlBytes[name])])) });
const baseState = () => ({ database: EXPECTED.database, oid: '987654', nonce: 'a'.repeat(32), marker: EXPECTED.marker, pendingReset: null,
  roles: { migration: { name: 'zzsh_regression_migration', oid: 111 }, runtime: { name: 'zzsh_regression_runtime', oid: 222 } } });
const base = (path) => { const text = String(path); const cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf(String.fromCharCode(92))); return cut >= 0 ? text.slice(cut + 1) : text; };
const read = (path) => sqlBytes[base(path)];
const nativeFixture = (config, expectations = [{ case: 'a', phase: 'accrue', orderId: 'order_1', items: 2, amounts: { RENTER_REFERRAL: '10', OWNER_REFERRAL: '5' } }]) => {
  config.native = { file: 'native-fixture.sql', expectedSha256: sha256(Buffer.from('INSERT SELECT 1;')), collectionDocument: 'collection.json', expectedCollectionSha256: sha256(Buffer.from('{}')), expectations };
  sqlBytes['native-fixture.sql'] = Buffer.from('INSERT SELECT 1;');
  sqlBytes['collection.json'] = Buffer.from('{}');
  return config;
};

function recorder() { const lines = [], codes = []; return { lines, codes, log: { log: value => lines.push(JSON.parse(value)), error: value => lines.push(JSON.parse(value)) }, exit: code => codes.push(code) }; }

test('the default plan is provably offline and carries the sealed candidate bytes', async () => {
  const plan = sealedPlan(baseConfig(), baseState(), read);
  assert.deepEqual(plan.sql.map(file => file.name), CANDIDATES);
  const host = recorder();
  const outcome = await run({ config: baseConfig(), plan, log: host.log, exit: host.exit, connect: () => { throw new Error('PLAN must not connect'); }, loadStore: async () => { throw new Error('PLAN must not load the store'); } });
  assert.equal(host.lines.length, 1);
  assert.equal(host.lines[0].mode, 'PLAN');
  assert.equal(host.lines[0].pass, true);
  assert.equal(host.lines[0].readsSecrets, false);
  assert.equal(host.lines[0].connections, 0);
  assert.equal(host.codes.length, 0);
  assert.deepEqual(host.lines[0].sql.map(entry => entry.sha256), plan.sql.map(file => file.digest));
});

test('sealing rejects drifted SQL, transaction wrappers and an unsealed fixture', () => {
  const drifted = baseConfig(); drifted.expectedSqlSha256[CANDIDATES[1]] = 'f'.repeat(64);
  assert.throws(() => sealedPlan(drifted, baseState(), read), /CANDIDATE_SQL_SEAL_MISMATCH/);
  const wrapped = baseConfig(); sqlBytes[CANDIDATES[0]] = Buffer.from('BEGIN;\nSELECT 1;\n'); wrapped.expectedSqlSha256[CANDIDATES[0]] = sha256(sqlBytes[CANDIDATES[0]]);
  assert.throws(() => sealedPlan(wrapped, baseState(), read), /CANDIDATE_HAS_TRANSACTION_WRAPPER/);
  sqlBytes[CANDIDATES[0]] = Buffer.from(clean(CANDIDATES[0]));
  const unsealed = baseConfig(); nativeFixture(unsealed); unsealed.native.expectedSha256 = '0'.repeat(64);
  assert.throws(() => sealedPlan(unsealed, baseState(), read), /NATIVE_FIXTURE_SEAL_MISMATCH/);
  const noManifest = baseConfig(); delete noManifest.expectedSqlSha256;
  assert.throws(() => sealedPlan(noManifest, baseState(), read), /SEALED_SQL_MANIFEST_REQUIRED/);
});

test('a sealed config cannot smuggle one role as another or disagree with the registry', () => {
  for (const [label, mutate, expected] of [
    ['same user twice', config => { config.runtimeUser = config.ownerUser; }, /SEALED_ROLES_MUST_BE_DISTINCT/],
    ['injected identifier', config => { config.runtimeUser = 'zzsh; DROP TABLE'; }, /SEALED_ROLE_NAME_INVALID/],
    ['registry name drift', (config, state) => { state.roles.runtime.name = 'zzsh_other'; }, /REGISTERED_ROLE_NAME_MISMATCH/],
    ['registry oid drift', (config, state) => { state.roles.runtime.oid = 999; }, /REGISTERED_ROLE_OID_MISMATCH/],
    ['pending reset', (config, state) => { state.pendingReset = 'reset'; }, /REGISTERED_STATE_MISMATCH/]]) {
    const config = baseConfig(), state = baseState(); mutate(config, state);
    assert.throws(() => sealedPlan(config, state, read), expected, label);
  }
});

/** A pg-shaped fake that answers by statement fragment and records the executed order. */
function fakeSessions(rules = {}) {
  const seen = [];
  const session = (name, database) => ({ name, database, async connect() { this.connected = true; }, async query(sql, params = []) {
    seen.push({ name, sql, params });
    for (const [fragment, value] of Object.entries(rules)) if (sql.includes(fragment)) {
      const answer = typeof value === 'function' ? value(sql, params) : value;
      if (answer instanceof Error) throw answer;
      return answer;
    }
    return { rows: [], rowCount: 0 };
  }, async end() { this.ended = true; } });
  return { seen, session };
}
const ok = (rows) => ({ rows, rowCount: rows.length });

test('identity verification binds catalog facts and refuses owner impersonation or foreign sessions', async () => {
  const config = baseConfig(), plan = sealedPlan(config, baseState(), read);
  const build = (roles, extras = {}) => fakeSessions({
    'FROM pg_database': ok([{ oid: '987654', marker: EXPECTED.marker, owner: config.ownerUser, allow: true, template: false }]),
    'FROM pg_roles': ok(roles),
    'pg_has_role': ok([{ member: extras.impersonate === true }]),
    'FROM pg_class': ok([{ n: extras.owns ?? 0 }]),
    'pg_stat_activity': ok([{ n: extras.others ?? 1 }]),
    'pg_try_advisory_lock': ok([{ acquired: true }]), 'pg_advisory_unlock': ok([{ released: true }]),
    "current_setting('zzsh.regression_run'": ok([{ database: config.database, role: config.migrationUser, nonce: config.nonce }]),
    'SELECT 1 AS one': ok([{ one: 1 }]), ...extras.queries });
  const goodRoles = [{ name: config.ownerUser, oid: '100', super: false, bypass: false, login: true, createdb: false, inherit: true },
    { name: config.migrationUser, oid: '111', super: false, bypass: false, login: true, createdb: false, inherit: true },
    { name: config.runtimeUser, oid: '222', super: false, bypass: false, login: true, createdb: false, inherit: true }];
  const host = recorder();
  await run({ config, plan, log: host.log, exit: host.exit, identity: true, loadStore: async () => null, connect: (user, database) => build(goodRoles).session(user, database) });
  assert.equal(host.lines.at(-1).pass, true, JSON.stringify(host.lines));
  assert.equal(host.codes.length, 0);
  const impersonated = recorder();
  await run({ config, plan, log: impersonated.log, exit: impersonated.exit, identity: true, loadStore: async () => null,
    connect: (user, database) => build(goodRoles, { impersonate: true }).session(user, database) });
  assert.equal(impersonated.lines.find(line => line.pass === false).code, 'RUNTIME_IMPERSONATES_OWNER');
  assert.deepEqual(impersonated.codes, [1]);
  const crowded = recorder();
  await run({ config, plan, log: crowded.log, exit: crowded.exit, identity: true, loadStore: async () => null,
    connect: (user, database) => build(goodRoles, { others: 4 }).session(user, database) });
  assert.equal(crowded.lines.find(line => line.pass === false).code, 'FOREIGN_SESSION_PRESENT');
  const privileged = recorder();
  await run({ config, plan, log: privileged.log, exit: privileged.exit, identity: true, loadStore: async () => null,
    connect: (user, database) => build(goodRoles, { owns: 12 }).session(user, database) });
  assert.equal(privileged.lines.find(line => line.pass === false).code, 'ROLE_OWNS_BUSINESS_RELATIONS');
});

test('structure phase switches to the real runtime role before reading effective privileges', async () => {
  const config = baseConfig(), plan = sealedPlan(config, baseState(), read);
  const db = fakeSessions({
    'SELECT zzsh_order.distribution_policy_contract_version() AS version': ok([{ version: 2 }]),
    'to_regprocedure': ok([{ present: true }]),
    'aclexplode(coalesce(p.proacl': ok([{ closed: true }]),
    'current_user AS role, zzsh_order.distribution_policy_contract_version() AS version': ok([{ role: config.runtimeUser, version: 2 }]),
    'INSERT INTO zzsh_order.rental_referral_reversal_source': Object.assign(new Error('permission denied'), { code: '42501' }),
    'UPDATE zzsh_order.rental_referral_earning SET canonical_seed': Object.assign(new Error('permission denied'), { code: '42501' }) });
  const ledger = createLedger();
  await structurePhase(db.session(config.migrationUser, config.database), plan, config, ledger);
  const order = db.seen.map(entry => entry.sql);
  assert.ok(order.findIndex(sql => sql.includes('SET LOCAL ROLE ' + config.runtimeUser)) < order.findIndex(sql => sql.includes("current_user AS role, zzsh_order")));
  assert.ok(order.some(sql => sql.includes('RESET ROLE')));
  assert.deepEqual(ledger.checks.map(check => check.code), ['CANDIDATES_APPLIED_IN_ONE_TRANSACTION', 'CONTRACT_FUNCTION_PRESENT', 'CONTRACT_VERSION_TWO', 'CONTRACT_PUBLIC_EXECUTE_REVOKED', 'RUNTIME_CONTRACT_EXECUTE_READBACK', 'RUNTIME_REVERSAL_DECLARATION_DENIED', 'RUNTIME_PROTECTED_EARNING_SOURCE_DENIED']);
  assert.equal(ledger.checks.every(check => check.check === 'PASS'), true);
});

test('a runtime that can write a declaration or read nothing fails instead of passing', async () => {
  const config = baseConfig(), plan = sealedPlan(config, baseState(), read);
  const permissive = fakeSessions({ 'to_regprocedure': ok([{ present: true }]), 'SELECT zzsh_order.distribution_policy_contract_version() AS version': ok([{ version: 2 }]),
    'aclexplode(coalesce(p.proacl': ok([{ closed: true }]), 'current_user AS role': ok([{ role: config.runtimeUser, version: 2 }]),
    'INSERT INTO zzsh_order.rental_referral_reversal_source': ok([{ inserted: 1 }]), 'UPDATE zzsh_order.rental_referral_earning': ok([{ updated: 1 }]) });
  await assert.rejects(structurePhase(permissive.session(config.migrationUser, config.database), plan, config, createLedger()), /RUNTIME_REVERSAL_DECLARATION_DENIED_FAILED/);
  const stale = fakeSessions({ 'to_regprocedure': ok([{ present: true }]), 'SELECT zzsh_order.distribution_policy_contract_version() AS version': ok([{ version: 1 }]) });
  await assert.rejects(structurePhase(stale.session(config.migrationUser, config.database), plan, config, createLedger()), /CONTRACT_VERSION_TWO_FAILED/);
  const openToPublic = fakeSessions({ 'to_regprocedure': ok([{ present: true }]), 'SELECT zzsh_order.distribution_policy_contract_version() AS version': ok([{ version: 2 }]),
    'aclexplode(coalesce(p.proacl': ok([{ closed: false }]) });
  await assert.rejects(structurePhase(openToPublic.session(config.migrationUser, config.database), plan, config, createLedger()), /CONTRACT_PUBLIC_EXECUTE_REVOKED_FAILED/);
});

test('policy phase without an administrator fixture is INCOMPLETE and exits 2', async () => {
  const config = baseConfig(); nativeFixture(config);
  const plan = { ...sealedPlan(config, baseState(), read), native: null };
  const db = fakeSessions({ 'FROM zzsh_auth_admin': ok([]) });
  const host = recorder();
  await assert.rejects(policyPhase(db.session(config.migrationUser, config.database), config, plan, createLedger()), /ADMIN_FIXTURE_REQUIRED/);
  await run({ config, plan, log: host.log, exit: host.exit, execute: true, loadStore: async () => null,
    connect: () => { throw new Error('unreachable in this assertion'); } }).catch(() => {});
  const ledger = createLedger();
  await assert.rejects(policyPhase(db.session(config.migrationUser, config.database), config, plan, ledger), /ADMIN_FIXTURE_REQUIRED/);
  assert.deepEqual(ledger.checks.map(check => check.check), ['INCOMPLETE']);
});

test('the native funds chain runs the application store in order and records what it created', async () => {
  const config = baseConfig();
  nativeFixture(config, [
    { case: 'dual_role', phase: 'accrue', orderId: 'order_1', items: 2, amounts: { RENTER_REFERRAL: '10', OWNER_REFERRAL: '5' } },
    { case: 'not_due', phase: 'settle', earningId: 'earning_1', due: false },
    { case: 'settled', phase: 'settle', earningId: 'earning_1', due: true },
    { case: 'insufficient', phase: 'revoke', earningId: 'earning_2', reversalSourceId: 'reversal_2', funds: 'insufficient' },
    { case: 'recovered', phase: 'recover', earningId: 'earning_3', reversalSourceId: 'reversal_3' }]);
  const plan = sealedPlan(config, baseState(), read);
  let settle = 0;
  const earnings = new Map([['earning_1', { id: 'earning_1', version: '1', state: 'PENDING' }], ['earning_2', { id: 'earning_2', version: '2', state: 'SETTLED' }], ['earning_3', { id: 'earning_3', version: '3', state: 'RECOVERY_REQUIRED' }]]);
  const store = { async accrue(_pool, orderId, requestId) { return requestId.endsWith('_replay')
      ? { knowledge: 'KNOWN', items: [{ root: { id: 'earning_1', amountCents: '10', role: 'RENTER_REFERRAL', state: 'PENDING' }, replayed: true }, { root: { id: 'earning_2', amountCents: '5', role: 'OWNER_REFERRAL', state: 'PENDING' }, replayed: true }] }
      : { knowledge: 'KNOWN', items: [{ root: { id: 'earning_1', amountCents: '10', role: 'RENTER_REFERRAL', state: 'PENDING' }, replayed: false }, { root: { id: 'earning_2', amountCents: '5', role: 'OWNER_REFERRAL', state: 'PENDING' }, replayed: false }] }; },
    async transition(_pool, earningId, action, version, requestId, sourceId) {
      // The first SETTLE models an earning whose original due moment has not arrived: the application rejects it.
      if (action === 'SETTLE' && ++settle === 1) throw Object.assign(new Error('Earning is not due'), { code: 'CONFLICT' });
      if (action === 'SETTLE' && requestId.endsWith('_replay')) return { replayed: true, root: { state: 'SETTLED' } };
      if (action === 'SETTLE') return { replayed: false, root: { state: 'SETTLED' } };
      if (action === 'REVOKE') return { replayed: false, root: { state: 'RECOVERY_REQUIRED', amountCents: '5', recoveryRequiredCents: '5' } };
      return { replayed: false, root: { state: 'REVOKED', recoveryRequiredCents: null } }; } };
  const db = fakeSessions({
    'FROM zzsh_order.rental_referral_earning WHERE id=$1': (_sql, params) => ok([earnings.get(params[0]) ?? { id: 'earning_1', version: '1', state: 'PENDING' }]),
    'rental_referral_earning WHERE order_id=$1': ok([{ n: 2 }]),
    "account_code='WALLET_AVAILABLE' AND e.credit_cents>0": ok([{ n: 1 }]),
    "account_code='WALLET_AVAILABLE' AND e.debit_cents>0": ok([{ n: 0 }]) });
  const ledger = createLedger();
  const created = await fundsPhase(db.session(config.migrationUser, config.database), config, plan, ledger, store);
  assert.deepEqual(created.orders, ['order_1']);
  assert.deepEqual(created.earnings, ['earning_1', 'earning_2']);
  assert.deepEqual(created.declarations, ['reversal_2', 'reversal_3']);
  assert.deepEqual(ledger.checks.filter(check => check.check === 'PASS').map(check => check.code), ['NATIVE_FIXTURE_APPLIED', 'NATIVE_ACCRUAL_ITEMS', 'NATIVE_ACCRUAL_FACTS', 'NATIVE_ACCRUAL_FACTS', 'NATIVE_ACCRUAL_IDEMPOTENT', 'NATIVE_NO_DUPLICATE_ROOT', 'NATIVE_SETTLE_BEFORE_DUE_REJECTED', 'NATIVE_SETTLE_STATE', 'NATIVE_SETTLE_CREDITS_AVAILABLE', 'NATIVE_SETTLE_RECEIPT_REPLAY', 'NATIVE_REVOKE_STATE', 'NATIVE_RECOVERY_OBLIGATION', 'NATIVE_INSUFFICIENT_HAS_NO_FAKE_DEBIT', 'NATIVE_RECOVER_CLOSES_OBLIGATION', 'NATIVE_FUNDS_CHAIN_COMPLETED']);
  assert.equal(db.seen.filter(entry => entry.sql === 'INSERT SELECT 1;').length, 1, 'the sealed fixture SQL runs once');
});

test('a funds expectation that does not match the application result fails loudly', async () => {
  const config = baseConfig();
  nativeFixture(config, [{ case: 'wrong_amount', phase: 'accrue', orderId: 'order_1', items: 2, amounts: { RENTER_REFERRAL: '99', OWNER_REFERRAL: '5' } }]);
  const plan = sealedPlan(config, baseState(), read);
  const store = { async accrue() { return { knowledge: 'KNOWN', items: [{ root: { id: 'earning_1', amountCents: '10', role: 'RENTER_REFERRAL', state: 'PENDING' }, replayed: false }] }; } };
  const db = fakeSessions({});
  await assert.rejects(fundsPhase(db.session('x', config.database), config, plan, createLedger(), store), /NATIVE_ACCRUAL_ITEMS_FAILED/);
  const unknown = baseConfig();
  nativeFixture(unknown, [{ case: 'typo', phase: 'settled' }]);
  await assert.rejects(fundsPhase(db.session('x', unknown.database), unknown, sealedPlan(unknown, baseState(), read), createLedger(), store), /NATIVE_EXPECTATION_PHASE_UNKNOWN/);
  await assert.rejects(fundsPhase(db.session('x', config.database), config, plan, createLedger(), null), /API_DIST_REQUIRED/);
});

test('cleanup only claims success when the fixture rows are provably gone', async () => {
  const remaining = fakeSessions({ 'FROM zzsh_order.rental_referral_earning WHERE id=ANY': ok([{ n: 2 }]) });
  const ledger = createLedger();
  await assert.rejects(cleanupPhase(remaining.session('x', EXPECTED.database), { earnings: ['earning_1'], declarations: [], orders: [] }, ledger), /NATIVE_FIXTURE_ROWS_REMOVED_FAILED/);
  assert.ok(remaining.seen.some(entry => entry.sql === 'ROLLBACK'));
  const cleared = fakeSessions({ 'FROM zzsh_order.rental_referral_earning WHERE id=ANY': ok([{ n: 0 }]) });
  const done = createLedger();
  await cleanupPhase(cleared.session('x', EXPECTED.database), { earnings: ['earning_1'], declarations: ['reversal_1'], orders: ['order_1'] }, done);
  assert.ok(cleared.seen.some(entry => entry.sql === 'COMMIT'));
  assert.deepEqual(done.checks.map(check => check.code), ['NATIVE_FIXTURE_ROWS_REMOVED']);
  await assert.rejects(cleanupPhase(cleared.session('x', EXPECTED.database), null, createLedger()), /CLEANUP_RECEIPT_REQUIRED/);
});

test('an unlocked or unended session is reported as CLEANUP_UNKNOWN and never as pass', async () => {
  const config = baseConfig(), plan = sealedPlan(config, baseState(), read);
  const host = recorder();
  await run({ config, plan, log: host.log, exit: host.exit, identity: true, loadStore: async () => null, connect: () => ({
    async connect() {},
    async query(sql) {
      if (sql.includes('pg_try_advisory_lock')) return ok([{ acquired: true }]);
      if (sql.includes('pg_advisory_unlock')) return ok([{ released: false }]);
      if (sql.includes('FROM pg_database')) return ok([{ oid: '987654', marker: EXPECTED.marker, owner: config.ownerUser, allow: true, template: false }]);
      if (sql.includes('FROM pg_roles')) return ok([{ name: config.ownerUser, oid: '100', super: false, bypass: false, login: true, createdb: false }, { name: config.migrationUser, oid: '111', super: false, bypass: false, login: true, createdb: false }, { name: config.runtimeUser, oid: '222', super: false, bypass: false, login: true, createdb: false }]);
      if (sql.includes('pg_has_role')) return ok([{ member: false }]);
      if (sql.includes('FROM pg_class')) return ok([{ n: 0 }]);
      if (sql.includes('pg_stat_activity')) return ok([{ n: 1 }]);
      if (sql.includes("current_setting('zzsh.regression_run'")) return ok([{ database: config.database, role: config.migrationUser, nonce: config.nonce }]);
      return ok([]);
    }, async end() { throw new Error('end failed'); } }) });
  assert.equal(host.codes.includes(1), true);
  assert.ok(host.lines.some(line => line.code === 'CLEANUP_UNKNOWN' && line.cleanup.unlocked === false && line.cleanup.ended === false));
  assert.equal(host.lines.some(line => line.pass === true), false);
});

test('createHash and sha256 agree so the seal cannot be satisfied by a different digest', () => {
  assert.equal(sha256(Buffer.from('abc')), createHash('sha256').update('abc').digest('hex'));
});


test('Root: incomplete committing fixture/cleanup modes stop before credentials and connections', async () => {
  for (const mode of ['fullNative','cleanup']) {
    const host = recorder();
    await run({config:baseConfig(),plan:sealedPlan(baseConfig(),baseState(),read),[mode]:true,log:host.log,exit:host.exit,connect:()=>{throw Error('must not connect');},loadStore:()=>{throw Error('must not load a store');}});
    assert.deepEqual(host.codes,[2]);
    assert.equal(host.lines.at(-1).pass,false);
    assert.equal(host.lines.at(-1).code,'NATIVE_FIXTURE_RECOVERY_CONTRACT_UNAVAILABLE');
    assert.equal(host.lines.at(-1).connections,0);
  }
});

// Append to scripts/distribution-pg-native-acceptance.test.mjs after Root's bounded fix.
// Reuses this file's test/assert/baseConfig/sealedPlan/baseState/read/ok helpers.
// Models the PG aborted-transaction rule without connecting to PostgreSQL.
test('structure permission probes recover each SQL error before issuing more SQL or RESET ROLE', async () => {
  const config = baseConfig(), plan = sealedPlan(config, baseState(), read), statements = [];
  let aborted = false;
  const error = (code, message) => Object.assign(new Error(message), { code });
  const client = { async query(sql) {
    statements.push(sql);
    if (/^ROLLBACK TO SAVEPOINT\b/.test(sql) || sql === 'ROLLBACK') { aborted = false; return ok([]); }
    if (aborted) throw error('25P02', 'current transaction is aborted');
    if (sql.includes('to_regprocedure')) return ok([{ present: true }]);
    if (sql.includes('current_user AS role, zzsh_order.distribution_policy_contract_version')) return ok([{ role: config.runtimeUser, version: 2 }]);
    if (sql.includes('SELECT zzsh_order.distribution_policy_contract_version() AS version')) return ok([{ version: 2 }]);
    if (sql.includes('aclexplode(coalesce(p.proacl')) return ok([{ closed: true }]);
    if (sql.includes('INSERT INTO zzsh_order.rental_referral_reversal_source')) {
      aborted = true;
      if (/\]\s*$/.test(sql)) throw error('42601', 'syntax error at or near ]');
      throw error('42501', 'permission denied for table rental_referral_reversal_source');
    }
    if (sql.includes('UPDATE zzsh_order.rental_referral_earning SET canonical_seed')) {
      aborted = true; throw error('42501', 'permission denied for table rental_referral_earning');
    }
    return ok([]);
  } };
  const ledger = createLedger();
  await structurePhase(client, plan, config, ledger);
  assert.equal(aborted, false, 'RESET ROLE must run after recovery, not in aborted transaction');
  assert.equal(statements.filter(sql => /^ROLLBACK TO SAVEPOINT\b/.test(sql)).length, 2);
  assert.ok(statements.includes('RESET ROLE'));
  for (const code of ['RUNTIME_REVERSAL_DECLARATION_DENIED', 'RUNTIME_PROTECTED_EARNING_SOURCE_DENIED']) {
    const check = ledger.checks.find(item => item.code === code);
    assert.equal(check?.check, 'PASS');
    assert.equal(check?.detail?.sqlstate, '42501');
  }
});
