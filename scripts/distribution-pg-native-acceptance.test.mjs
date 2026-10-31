import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { CANDIDATES, EXPECTED, REQUIRED_STAGES, nativeContract, sealedPlan, sha256, run, structurePhase, policyPhase, fundsPhase, residuePhase, verifyIdentity, createLedger } from './distribution-pg-native-acceptance.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const clean = (name) => `-- ${name}\nSELECT 1;\n`;
const bytes = new Map(CANDIDATES.map(name => [name, Buffer.from(clean(name))]));
const STAGE = (phase, extra = {}) => ({ case: phase, phase, ...extra });
const fullExpectations = () => [
  STAGE('fixture'), STAGE('policy'),
  STAGE('accrue', { orderId: 'order_native_1', items: 2, amounts: { RENTER_REFERRAL: '10', OWNER_REFERRAL: '5' }, earningIds: ['earning_a', 'earning_b'] }),
  STAGE('accrue-replay', { orderId: 'order_native_1', items: 2 }),
  STAGE('settle-not-due', { earningId: 'earning_a' }),
  STAGE('settle', { earningId: 'earning_b' }),
  STAGE('revoke-sufficient', { earningId: 'earning_a', admissionDigest: 'a'.repeat(64), reason: '客服核实的错发佣金' }),
  STAGE('revoke-insufficient', { earningId: 'earning_b', admissionDigest: 'a'.repeat(64), reason: '客服核实的错发佣金' }),
  STAGE('recover', { earningId: 'earning_b', amountCents: '5', reversalSourceId: 'reversal_generated' }),
];
function baseConfig(extra = {}) {
  bytes.set('native-fixture.sql', Buffer.from('INSERT SELECT 1;'));
  bytes.set('collection.json', Buffer.from('{}'));
  const config = { schema: 'distribution-pg-acceptance.v3', host: EXPECTED.host, port: EXPECTED.port, database: EXPECTED.database, marker: EXPECTED.marker, lockKey: EXPECTED.lockKey,
    resourceOid: 987654, nonce: 'a'.repeat(32), statePath: 'state.json', candidateDir: 'candidates',
    ownerUser: 'zzsh_regression_owner', migrationUser: 'zzsh_regression_migration', runtimeUser: 'zzsh_regression_runtime',
    roles: { migrationOid: 111, runtimeOid: 222 }, expectedSqlSha256: Object.fromEntries(CANDIDATES.map(name => [name, sha256(bytes.get(name))])),
    native: { file: 'native-fixture.sql', expectedSha256: sha256(Buffer.from('INSERT SELECT 1;')), collectionDocument: 'collection.json', expectedCollectionSha256: sha256(Buffer.from('{}')),
      adminFixtureId: 'admin_boss', declarerUserId: 'admin_boss', expectations: fullExpectations(), journalPath: 'journal.log' } };
  return { ...config, ...extra, ...(extra.native ? { native: { ...config.native, ...extra.native } } : {}) };
}
const baseState = () => ({ database: EXPECTED.database, oid: '987654', nonce: 'a'.repeat(32), marker: EXPECTED.marker, pendingReset: null,
  roles: { migration: { name: 'zzsh_regression_migration', oid: 111 }, runtime: { name: 'zzsh_regression_runtime', oid: 222 } } });
const read = (path) => { const text = String(path), cut = Math.max(text.lastIndexOf('/'), text.lastIndexOf(String.fromCharCode(92))); return bytes.get(cut >= 0 ? text.slice(cut + 1) : text); };
const planOf = (config = baseConfig()) => sealedPlan(config, baseState(), read);

/** PostgreSQL-shaped session: an error aborts the transaction until a savepoint rollback recovers it. */
function pgSession(name, handlers = {}) {
  const seen = [], state = { role: name, aborted: false, inTransaction: false, connected: false, ended: false };
  const session = { name, state, seen, async connect() { state.connected = true; }, async end() { if (state.destroyed) throw new Error('end failed'); state.ended = true; },
    async query(sql, params = []) {
      seen.push({ sql, params, role: state.role, aborted: state.aborted });
      if (/^BEGIN/.test(sql)) { if (state.inTransaction) throw Object.assign(new Error('nested transaction'), { code: '25001' }); state.inTransaction = true; return { rows: [], rowCount: 0 }; }
      if (/^ROLLBACK TO SAVEPOINT/.test(sql)) { state.aborted = false; return { rows: [], rowCount: 0 }; }
      if (/^(COMMIT|ROLLBACK)$/.test(sql)) { state.inTransaction = false; state.aborted = false; return { rows: [], rowCount: 0 }; }
      if (/^SAVEPOINT|^RELEASE SAVEPOINT|^SET CONSTRAINTS/.test(sql)) return { rows: [], rowCount: 0 };
      if (state.aborted) throw Object.assign(new Error('current transaction is aborted, commands ignored until end of transaction block'), { code: '25P02' });
      if (/^SET LOCAL ROLE/.test(sql)) { state.role = sql.split('ROLE')[1].trim(); return { rows: [], rowCount: 0 }; }
      if (/^RESET ROLE/.test(sql)) { state.role = name; return { rows: [], rowCount: 0 }; }
      if (sql.includes('pg_try_advisory_lock')) return { rows: [{ acquired: state.held !== false }], rowCount: 1 };
      if (sql.includes('pg_advisory_unlock')) return { rows: [{ released: state.unlockResult !== false }], rowCount: 1 };
      for (const [fragment, value] of Object.entries(handlers)) if (sql.includes(fragment)) {
        const answer = typeof value === 'function' ? value(sql, params, state) : value;
        if (answer instanceof Error) { state.aborted = true; throw answer; }
        return answer;
      }
      return { rows: [], rowCount: 0 };
    } };
  return session;
}
const ok = (rows) => ({ rows, rowCount: rows.length });
const error = (code, message = 'rejected') => Object.assign(new Error(message), { code });
const recorder = () => { const lines = [], codes = []; return { lines, codes, log: { log: value => lines.push(JSON.parse(value)), error: value => lines.push(JSON.parse(value)) }, exit: code => codes.push(code) }; };

test('the native contract names every missing external input instead of failing later', () => {
  assert.deepEqual(nativeContract(baseConfig()).missing, []);
  assert.deepEqual(nativeContract(baseConfig()).absentStages, []);
  const stripped = baseConfig({ native: { expectations: [STAGE('accrue', { orderId: 'order_native_1', items: 1, amounts: {} })] } });
  assert.deepEqual(nativeContract(stripped).missing.sort(), ['expectedSqlSha256', 'native.adminFixtureId', 'native.collectionDocument', 'native.declarerUserId', 'native.expectedCollectionSha256', 'native.expectedSha256', 'native.file'].filter(item => nativeContract(stripped).missing.includes(item)).sort());
  const short = baseConfig(); short.native.expectations = short.native.expectations.filter(item => item.phase !== 'recover');
  assert.deepEqual(nativeContract(short).absentStages, ['recover']);
  for (const field of ['native.file', 'native.journalPath', 'native.adminFixtureId', 'native.declarerUserId']) assert.ok(Object.keys(nativeContract(baseConfig()).fields).includes(field), field + ' has a documented format');
  assert.deepEqual(REQUIRED_STAGES.filter(phase => !nativeContract(baseConfig()).stages.includes(phase)), []);
});

test('sealing rejects drifted bytes, wrappers, duplicated and absent stages', () => {
  assert.equal(planOf().sql.length, CANDIDATES.length);
  const drifted = baseConfig(); drifted.expectedSqlSha256[CANDIDATES[1]] = 'f'.repeat(64);
  assert.throws(() => sealedPlan(drifted, baseState(), read), /CANDIDATE_SQL_SEAL_MISMATCH/);
  const wrapped = baseConfig(); bytes.set(CANDIDATES[0], Buffer.from('BEGIN;' + String.fromCharCode(10) + 'SELECT 1;')); wrapped.expectedSqlSha256[CANDIDATES[0]] = sha256(bytes.get(CANDIDATES[0]));
  assert.throws(() => sealedPlan(wrapped, baseState(), read), /CANDIDATE_HAS_TRANSACTION_WRAPPER/);
  bytes.set(CANDIDATES[0], Buffer.from(clean(CANDIDATES[0])));
  assert.throws(() => sealedPlan(baseConfig({ schema: 'distribution-pg-acceptance.v2' }), baseState(), read), /SEALED_CONFIG_SHAPE_INVALID/);
  const duplicated = baseConfig(); duplicated.native.expectations.push(STAGE('accrue', { orderId: 'order_native_1', items: 2, amounts: {} }));
  assert.throws(() => sealedPlan(duplicated, baseState(), read), /NATIVE_STAGE_DUPLICATED/);
  const absent = baseConfig(); absent.native.expectations = absent.native.expectations.filter(item => item.phase !== 'settle');
  assert.throws(() => sealedPlan(absent, baseState(), read), /NATIVE_STAGES_INCOMPLETE/);
  assert.throws(() => sealedPlan(baseConfig(), { ...baseState(), pendingReset: 'reset' }, read), /REGISTERED_STATE_MISMATCH/);
  assert.throws(() => sealedPlan(baseConfig({ runtimeUser: 'zzsh_regression_owner' }), baseState(), read), /SEALED_ROLES_MUST_BE_DISTINCT/);
  const unsealedFixture = baseConfig(); unsealedFixture.native.expectedSha256 = '0'.repeat(64);
  assert.throws(() => sealedPlan(unsealedFixture, baseState(), read), /SEALED_INPUT_INCOMPLETE|NATIVE_FIXTURE_SEAL_MISMATCH/);
});

test('identity verification binds catalog facts and the real SET ROLE capability', async () => {
  const config = baseConfig();
  const roles = [{ name: config.ownerUser, oid: '100', super: false, bypass: false, login: true, createdb: false, inherit: false },
    { name: config.migrationUser, oid: '111', super: false, bypass: false, login: true, createdb: false, inherit: false },
    { name: config.runtimeUser, oid: '222', super: false, bypass: false, login: true, createdb: false, inherit: false }];
  const catalog = (extra = {}) => ({ 'FROM pg_database': ok([{ oid: '987654', marker: EXPECTED.marker, owner: config.ownerUser, allow: true, template: false }]),
    'FROM pg_roles': ok(extra.roles ?? roles), 'pg_has_role(current_user': ok([{ member: extra.canSetRole !== false }]), pg_has_role: ok([{ member: extra.member === true }]), 'FROM pg_class': ok([{ n: extra.runtimeOwns ?? 0 }]),
    'pg_stat_activity': ok([{ n: extra.others ?? 1 }]), ...(extra.queries ?? {}) });
  await verifyIdentity(pgSession(config.ownerUser, catalog()), pgSession(config.migrationUser, catalog()), config);
  const target = pgSession(config.migrationUser, catalog());
  await verifyIdentity(pgSession(config.ownerUser, catalog()), target, config);
  assert.ok(target.seen.some(entry => entry.sql.includes('FROM pg_class')), 'business ownership is answered by the target database only');
  assert.ok(!pgSession(config.ownerUser, catalog()).seen.some(entry => entry.sql.includes('FROM pg_class')));
  await assert.rejects(verifyIdentity(pgSession(config.ownerUser, catalog()), pgSession(config.migrationUser, catalog({ canSetRole: false })), config), /RUNTIME_SET_ROLE_UNAVAILABLE/);
  await assert.rejects(verifyIdentity(pgSession(config.ownerUser, catalog({ member: true })), pgSession(config.migrationUser, catalog({ member: true })), config), /RUNTIME_IMPERSONATES_OWNER/);
  await assert.rejects(verifyIdentity(pgSession(config.ownerUser, catalog()), pgSession(config.migrationUser, catalog({ runtimeOwns: 7 })), config), /RUNTIME_OWNS_BUSINESS_RELATIONS/);
  await assert.rejects(verifyIdentity(pgSession(config.ownerUser, catalog({ others: 3 })), pgSession(config.migrationUser, catalog()), config), /FOREIGN_SESSION_PRESENT/);
  await assert.rejects(verifyIdentity(pgSession(config.ownerUser, catalog({ roles: [roles[0], roles[1], { ...roles[2], inherit: true }] })), pgSession(config.migrationUser, catalog()), config), /ROLE_PRIVILEGE_ESCALATION/);
  await assert.rejects(verifyIdentity(pgSession(config.ownerUser, catalog({ roles: roles.map(role => role.name === config.runtimeUser ? { ...role, oid: '999' } : role) })), pgSession(config.migrationUser, catalog()), config), /REGISTERED_ROLE_OID_DRIFT/);
});

test('structure phase runs the shared ACL steps before switching to the runtime role', async () => {
  const plan = planOf(), config = baseConfig(), calls = [];
  const session = pgSession(config.migrationUser, {
    'to_regprocedure': ok([{ present: true }]),
    'has_function_privilege': ok([{ runtime_exec: true, public_closed: true }]),
    'current_user AS role': (sql, params, state) => ok([{ role: state.role, version: 2 }]),
    "relname='rental_referral_reversal_source'": ok([{ n: 1 }]),
    'INSERT INTO zzsh_order.rental_referral_reversal_source': error('42501', 'permission denied for table'),
    'UPDATE zzsh_order.rental_referral_earning': error('42501', 'permission denied for table'),
  });
  const assembly = { applyRuntimePrivileges: async () => calls.push('applyRuntimePrivileges'), configureDistributionFinancialPrivileges: async () => calls.push('configureDistributionFinancialPrivileges') };
  const ledger = createLedger();
  await structurePhase(session, plan, config, ledger, assembly);
  assert.deepEqual(calls, ['applyRuntimePrivileges', 'configureDistributionFinancialPrivileges'], 'the host reuses the application ACL steps instead of inventing grants');
  const switchAt = session.seen.findIndex(entry => entry.sql.includes('SET LOCAL ROLE'));
  assert.ok(switchAt > session.seen.findIndex(entry => entry.sql.includes('has_function_privilege')), 'the effective grant is read before the role switch');
  const firstNegative = session.seen.findIndex(entry => entry.sql.startsWith('INSERT INTO zzsh_order.rental_referral_reversal_source'));
  assert.ok(firstNegative > 0);
  assert.equal(session.seen[firstNegative + 1].sql, 'ROLLBACK TO SAVEPOINT runtime_declaration', 'a permission error must not leave the transaction aborted');
  assert.deepEqual(session.seen.filter(entry => entry.aborted === true).map(entry => entry.sql).filter(sql => !/^(SAVEPOINT|ROLLBACK TO SAVEPOINT|RELEASE SAVEPOINT)/.test(sql)), [], 'no business statement runs while the transaction is aborted');
  const resetAt = session.seen.findIndex(entry => entry.sql === 'RESET ROLE');
  assert.ok(resetAt > session.seen.findIndex(entry => entry.sql === 'RELEASE SAVEPOINT runtime_seed'));
  assert.deepEqual(ledger.checks.map(item => item.code), ['CANDIDATES_APPLIED_IN_ONE_TRANSACTION', 'CONTRACT_FUNCTION_PRESENT', 'SHARED_RUNTIME_PRIVILEGES_APPLIED', 'CONTRACT_ACL_EFFECTIVE', 'RUNTIME_CONTRACT_EXECUTE_READBACK', 'DECLARATION_OWNER_IS_MIGRATION_SESSION', 'RUNTIME_REVERSAL_DECLARATION_DENIED', 'RUNTIME_PROTECTED_EARNING_SOURCE_DENIED']);
  await assert.rejects(structurePhase(pgSession(config.migrationUser, { 'to_regprocedure': ok([{ present: true }]) }), plan, config, createLedger(), {}), /ACL_ASSEMBLY_UNAVAILABLE/);
  await assert.rejects(structurePhase(pgSession(config.migrationUser, { 'to_regprocedure': ok([{ present: true }]), 'has_function_privilege': ok([{ runtime_exec: false, public_closed: true }]) }), plan, config, createLedger(), assembly), /CONTRACT_ACL_EFFECTIVE_FAILED/);
  await assert.rejects(structurePhase(pgSession(config.migrationUser, { 'to_regprocedure': ok([{ present: true }]), 'has_function_privilege': ok([{ runtime_exec: true, public_closed: true }]),
    'current_user AS role': (sql, params, state) => ok([{ role: state.role, version: 1 }]) }), plan, config, createLedger(), assembly), /RUNTIME_CONTRACT_EXECUTE_READBACK_FAILED/);
  await assert.rejects(structurePhase(pgSession(config.migrationUser, { 'to_regprocedure': ok([{ present: true }]), 'has_function_privilege': ok([{ runtime_exec: true, public_closed: true }]),
    'current_user AS role': (sql, params, state) => ok([{ role: state.role, version: 2 }]), "relname='rental_referral_reversal_source'": ok([{ n: 0 }]) }), plan, config, createLedger(), assembly), /DECLARATION_OWNER_IS_MIGRATION_SESSION_FAILED/);
});

test('policy guards use the sealed administrator and synthetic probe rates only', async () => {
  const plan = planOf(), config = baseConfig();
  const session = pgSession(config.migrationUser, { 'FROM zzsh_iam.admin_security': ok([{ id: 'admin_boss', status: 'ACTIVE', isBoss: true }]),
    'INSERT INTO zzsh_order.distribution_policy_version': (sql, params) => params[0] === 'probe_v2' ? ok([]) : error('23514', 'uniform distribution policy guard'),
    "FROM zzsh_order.distribution_policy_head WHERE scope='NATIVE'": (sql) => sql.startsWith('SELECT count') ? ok([{ n: 0 }]) : ok([{ current_version_id: 'probe_v2' }]) });
  const ledger = createLedger();
  await policyPhase(session, config, plan, ledger);
  assert.deepEqual(ledger.checks.map(item => item.code), ['UNIFORM_RATE_GUARD', 'V2_SCHEMA_REJECTS_V1_CONFIG', 'POLICY_SYNTHETIC_RATES_ONLY', 'V2_NATIVE_POLICY_ACCEPTED']);
  await assert.rejects(policyPhase(pgSession(config.migrationUser, { 'FROM zzsh_iam.admin_security': ok([{ id: 'admin_boss', status: 'FROZEN' }]) }), config, plan, createLedger()), /ADMIN_FIXTURE_NOT_ACTIVE/);
  await assert.rejects(policyPhase(pgSession(config.migrationUser, { 'FROM zzsh_iam.admin_security': ok([{ id: 'admin_boss', status: 'ACTIVE', isBoss: true }]), 'INSERT INTO zzsh_order.distribution_policy_version': ok([]) }), config, plan, createLedger()), /UNIFORM_RATE_GUARD_FAILED/);
});

function chainHandler(roles) {
  return {
    'FROM zzsh_order.rental_referral_earning e JOIN zzsh_order.rental_order o': (sql, params, state) => { roles.push(state.role); return ok([{ id: params[0], order_id: 'order_native_1', amount_cents: '5', basis_digest: 'b'.repeat(64), state: 'SETTLED', game_id: 'delta', version: '2' }]); },
    'SELECT id,version::text AS version,state FROM zzsh_order.rental_referral_earning': (sql, params) => ok([{ id: params[0], version: '2', state: params[0] === 'earning_a' ? 'PENDING' : 'SETTLED' }]),
    'SELECT id,version::text AS version FROM zzsh_order.rental_referral_earning': (sql, params) => ok([{ id: params[0], version: '2' }]),
    'SELECT version::text AS version FROM zzsh_order.rental_referral_earning': ok([{ version: '2' }]),
    'SELECT id,version::text AS version,state,recovery_required_cents': ok([{ id: 'earning_b', version: '3', state: 'RECOVERY_REQUIRED', obligation: '5' }]),
    'WHERE order_id=$1': ok([{ n: 2 }]),
    "account_code='WALLET_AVAILABLE' AND e.credit_cents>0": ok([{ n: 1 }]),
    "account_code='WALLET_AVAILABLE' AND e.debit_cents>0": ok([{ n: 0 }]),
    'INSERT INTO zzsh_order.rental_referral_reversal_source': ok([]),
  };
}
const freshStore = { async accrueOn(client, orderId, requestId) { const replayed = /_replay$/.test(String(requestId ?? ''));
    return { knowledge: 'KNOWN', items: [{ root: { id: 'earning_a', role: 'RENTER_REFERRAL', amountCents: '10', state: 'PENDING' }, replayed }, { root: { id: 'earning_b', role: 'OWNER_REFERRAL', amountCents: '5', state: 'PENDING' }, replayed }] }; },
  async transitionOn(client, earningId, action, version, requestId) {
    if (action === 'SETTLE' && earningId === 'earning_a') throw error('CONFLICT', 'Earning is not due');
    if (action === 'SETTLE' && requestId.endsWith('_replay')) return { replayed: true, root: { state: 'SETTLED' } };
    if (action === 'SETTLE') return { replayed: false, root: { state: 'SETTLED' } };
    if (action === 'REVOKE' && earningId === 'earning_a') return { replayed: false, root: { state: 'REVOKED', amountCents: '10', recoveryRequiredCents: null } };
    if (action === 'REVOKE') return { replayed: false, root: { state: 'RECOVERY_REQUIRED', amountCents: '5', recoveryRequiredCents: '5' } };
    return { replayed: false, root: { state: 'REVOKED', amountCents: '5', recoveryRequiredCents: null } };
  } };

test('the native chain runs each stage on the application path and journals every step', async () => {
  const plan = planOf(), config = baseConfig(), directory = mkdtempSync(join(tmpdir(), 'zzsh-native-journal-')), journalPath = join(directory, 'journal.log');
  plan.native.journalPath = journalPath;
  const roles = [], moneyCalls = [];
  const session = pgSession(config.migrationUser, chainHandler(roles));
  const store = { accrueOn: async (client, orderId, requestId) => { moneyCalls.push(['accrue', requestId]); return freshStore.accrueOn(client, orderId, requestId); },
    transitionOn: async (client, earningId, action, version, requestId, sourceId) => { moneyCalls.push([action, requestId, sourceId ?? null]); return freshStore.transitionOn(client, earningId, action, version, requestId, sourceId); } };
  const created = await fundsPhase(session, config, plan, createLedger(), store);
  const lines = readFileSync(journalPath, 'utf8').trim().split(String.fromCharCode(10)).map(line => JSON.parse(line));
  assert.deepEqual(lines.filter(line => line.status === 'APPLIED').map(line => line.phase), ['accrue', 'accrue-replay', 'settle-not-due', 'settle', 'revoke-sufficient', 'revoke-insufficient', 'recover']);
  assert.deepEqual(created.earnings, ['earning_a', 'earning_b']);
  assert.equal(created.declarations.length, 2, 'each revocation declares its own original source');
  assert.deepEqual(moneyCalls.map(call => call[0]), ['accrue', 'accrue', 'SETTLE', 'SETTLE', 'SETTLE', 'REVOKE', 'REVOKE', 'RECOVER'], 'not-due, settle and the settle replay are three distinct SETTLE calls on the application path');
  assert.ok(moneyCalls.every(call => call[1].startsWith('acceptance_')), 'every money call keeps the original acceptance request key');
  assert.deepEqual([...new Set(roles)], [config.migrationUser], 'the reversal declaration is taken by the table owner, never by runtime');
  assert.equal(session.seen.filter(entry => entry.sql.includes('SET LOCAL ROLE ' + config.runtimeUser)).length, 8, 'one role switch per money transaction: seven stages, and the settle stage also replays its own receipt');
  assert.ok(!session.seen.some(entry => /^COMMIT$/.test(entry.sql)), 'the chain never commits inside the assembly');
  assert.ok(session.seen.filter(entry => entry.sql === 'RESET ROLE').length >= 7);
  rmSync(directory, { recursive: true, force: true });
});

test('a failing stage keeps the original keys in the journal as UNKNOWN', async () => {
  const plan = planOf(), config = baseConfig(), directory = mkdtempSync(join(tmpdir(), 'zzsh-native-journal-')), journalPath = join(directory, 'journal.log');
  plan.native.journalPath = journalPath;
  const session = pgSession(config.migrationUser, chainHandler([]));
  const store = { accrueOn: (client, orderId, requestId) => freshStore.accrueOn(client, orderId, requestId), async transitionOn(client, earningId, action, version, requestId) { if (action === 'REVOKE' && earningId === 'earning_b') throw error('EVIDENCE_UNAVAILABLE', 'connection lost after the money commit'); return freshStore.transitionOn(client, earningId, action, version, requestId); } };
  await assert.rejects(fundsPhase(session, config, plan, createLedger(), store), /connection lost after the money commit/);
  const lines = readFileSync(journalPath, 'utf8').trim().split(String.fromCharCode(10)).map(line => JSON.parse(line));
  assert.ok(lines.filter(line => line.status === 'APPLIED').length >= 4, 'completed stages stay recorded');
  assert.equal(lines.at(-1).status, 'UNKNOWN');
  assert.equal(lines.at(-1).errorCode, 'EVIDENCE_UNAVAILABLE');
  assert.equal(lines.at(-1).case, 'revoke-insufficient');
  rmSync(directory, { recursive: true, force: true });
});

test('an accrual that only replays, a wrong amount or a missing store is never a fresh chain', async () => {
  const plan = planOf(), config = baseConfig(), session = pgSession(config.migrationUser, chainHandler([]));
  await assert.rejects(fundsPhase(session, config, plan, createLedger(), { accrueOn: async () => ({ knowledge: 'KNOWN', items: [{ root: { id: 'earning_a', role: 'RENTER_REFERRAL', amountCents: '10', state: 'PENDING' }, replayed: true }] }), transitionOn: freshStore.transitionOn }), /NATIVE_ACCRUAL_ITEMS_FAILED/);
  await assert.rejects(fundsPhase(session, config, plan, createLedger(), { accrueOn: async () => ({ knowledge: 'KNOWN', items: [{ root: { id: 'earning_a', role: 'RENTER_REFERRAL', amountCents: '9', state: 'PENDING' }, replayed: false }, { root: { id: 'earning_b', role: 'OWNER_REFERRAL', amountCents: '5', state: 'PENDING' }, replayed: false }] }), transitionOn: freshStore.transitionOn }), /NATIVE_ACCRUAL_FACTS_FAILED/);
  await assert.rejects(fundsPhase(session, config, plan, createLedger(), null), /API_STORE_UNAVAILABLE/);
  const wrongRejection = pgSession(config.migrationUser, chainHandler([]));
  await assert.rejects(fundsPhase(wrongRejection, config, plan, createLedger(), { accrueOn: freshStore.accrueOn, transitionOn: async () => ({ replayed: false, root: { state: 'SETTLED' } }) }), /NATIVE_SETTLE_BEFORE_DUE_REJECTED_FAILED/);
});

test('the residue check stays read-only and defers to the registered controlled reset', async () => {
  const empty = pgSession(EXPECTED.database, { 'rental_referral_earning WHERE id=ANY': ok([{ earning_ids: [], earnings: 0, declarations: 0, entries: 0 }]) });
  assert.deepEqual(await residuePhase(empty, { earnings: ['earning_x'] }, createLedger()), { earnings: 0, declarations: 0, entries: 0 });
  assert.ok(!empty.seen.some(entry => /DELETE|TRUNCATE|ALTER|DROP/i.test(entry.sql)), 'no destructive statement is ever issued');
  await assert.rejects(residuePhase(pgSession(EXPECTED.database, { 'rental_referral_earning WHERE id=ANY': ok([{ earning_ids: [], earnings: 2, declarations: 1, entries: 4 }]) }), { earnings: ['earning_a', 'earning_b'] }, createLedger()), /RESIDUE_REQUIRES_REGISTERED_RESET/);
});

test('the offline plan reports the contract and touches neither credential nor socket', async () => {
  const host = recorder();
  await run({ config: baseConfig(), plan: planOf(), log: host.log, exit: host.exit, connect: () => { throw new Error('PLAN must not connect'); }, loadAssembly: async () => { throw new Error('PLAN must not load modules'); } });
  assert.equal(host.lines.length, 1);
  assert.equal(host.lines[0].mode, 'PLAN');
  assert.equal(host.lines[0].readsSecrets, false);
  assert.equal(host.lines[0].connections, 0);
  assert.equal(host.lines[0].assembly, 'rollback-only');
  assert.deepEqual(host.lines[0].nativeContract.missing, []);
  assert.equal(host.codes.length, 0);
});

test('a full run assembles, rolls back, checks residue and releases the lock last', async () => {
  const config = baseConfig(), plan = planOf(), directory = mkdtempSync(join(tmpdir(), 'zzsh-native-run-')), journalPath = join(directory, 'journal.log');
  plan.native.journalPath = journalPath;
  const catalog = (name) => ({ "relname='rental_referral_reversal_source'": ok([{ n: 1 }]), 'FROM pg_database': ok([{ oid: '987654', marker: EXPECTED.marker, owner: config.ownerUser, allow: true, template: false }]),
    'FROM pg_roles': ok([{ name: config.ownerUser, oid: '100', super: false, bypass: false, login: true, createdb: false, inherit: false }, { name: config.migrationUser, oid: '111', super: false, bypass: false, login: true, createdb: false, inherit: false }, { name: config.runtimeUser, oid: '222', super: false, bypass: false, login: true, createdb: false, inherit: false }]),
    'pg_has_role(current_user': ok([{ member: true }]), pg_has_role: ok([{ member: false }]), 'FROM pg_class': ok([{ n: 0 }]), pg_stat_activity: ok([{ n: 1 }]),
    'SELECT current_database() AS database,current_user AS role': name === config.migrationUser ? ok([{ database: EXPECTED.database, role: config.migrationUser, nonce: config.nonce }]) : ok([]),
    'to_regprocedure': ok([{ present: true }]), 'has_function_privilege': ok([{ runtime_exec: true, public_closed: true }]), 'current_user AS role': (sql, params, state) => ok([{ role: state.role, version: 2 }]),
    "repeat('b',64)": error('42501', 'permission denied for table rental_referral_reversal_source'),
    'UPDATE zzsh_order.rental_referral_earning': error('42501'), 'FROM zzsh_iam.admin_security': ok([{ id: 'admin_boss', status: 'ACTIVE', isBoss: true }]),
    'INSERT INTO zzsh_order.distribution_policy_version': (sql, params) => params[0] === 'probe_v2' ? ok([]) : error('23514', 'uniform'),
    "FROM zzsh_order.distribution_policy_head WHERE scope='NATIVE'": (sql) => sql.startsWith('SELECT count') ? ok([{ n: 1 }]) : ok([{ current_version_id: 'probe_v2' }]),
    'rental_referral_earning WHERE id=ANY': ok([{ earning_ids: [], earnings: 0, declarations: 0, entries: 0 }]),
    'FROM pg_proc': ok([]), 'FROM pg_constraint': ok([]), 'count(*)::int FROM zzsh_order': ok([{ versions: 0, heads: 1, participants: 0, relations: 0, earnings: 0, declarations: 0, receipts: 0 }]),
    'SELECT scope,revision,current_version_id': ok([{ scope: 'NATIVE', revision: 1, current_version_id: 'policy_1' }]), ...chainHandler([]) });
  const owner = pgSession(config.ownerUser, catalog(config.ownerUser)), target = pgSession(config.migrationUser, catalog(config.migrationUser));
  const host = recorder();
  await run({ config, plan, log: host.log, exit: host.exit, fullNative: true, execute: true, connect: user => (user === config.ownerUser ? owner : target),
    loadAssembly: async () => ({ applyRuntimePrivileges: async () => {}, configureDistributionFinancialPrivileges: async () => {}, earnings: freshStore }) });
  const last = host.lines.at(-1);
  assert.equal(last?.pass, true, JSON.stringify(host.lines));
  assert.equal(last.assembly, 'rollback-only');
  assert.equal(last.checks.some(check => check.code === 'NATIVE_CHAIN_APPLIED_WITHOUT_COMMIT'), true);
  assert.equal(last.checks.some(check => check.code === 'NO_NATIVE_RESIDUE'), true);
  assert.equal(last.checks.some(check => check.code === 'ROLLBACK_RESTORED_DEFINITIONS_CONSTRAINTS_HEADS_AND_ROWS'), true);
  assert.equal(last.cleanup.rolledBack, true);
  assert.ok(!target.seen.some(entry => /^COMMIT$/.test(entry.sql)), 'the approved assembly never commits');
  const lastAction = target.seen.concat(owner.seen).filter(entry => /^(COMMIT|ROLLBACK)$/.test(entry.sql) || entry.sql.includes('pg_advisory_unlock')).at(-1);
  assert.ok(lastAction.sql.includes('pg_advisory_unlock'), 'the maintenance lock is released only after the work session finished');
  assert.ok(existsSync(journalPath));
  rmSync(directory, { recursive: true, force: true });
});

test('an unconfirmed cleanup is reported as CLEANUP_UNKNOWN and never as a pass', async () => {
  const config = baseConfig(), plan = planOf();
  const owner = pgSession(config.ownerUser, { 'FROM pg_database': ok([{ oid: '987654', marker: EXPECTED.marker, owner: config.ownerUser, allow: true, template: false }]),
    'FROM pg_roles': ok([{ name: config.ownerUser, oid: '100', super: false, bypass: false, login: true, createdb: false, inherit: false }, { name: config.migrationUser, oid: '111', super: false, bypass: false, login: true, createdb: false, inherit: false }, { name: config.runtimeUser, oid: '222', super: false, bypass: false, login: true, createdb: false, inherit: false }]),
    pg_has_role: ok([{ member: false }]), pg_stat_activity: ok([{ n: 1 }]) });
  owner.state.unlockResult = false;
  const target = pgSession(config.migrationUser, { 'zzsh.regression_run': ok([{ database: EXPECTED.database, role: config.migrationUser, nonce: config.nonce }]), 'FROM pg_class': ok([{ n: 0 }]),
    'pg_has_role(current_user': ok([{ member: true }]), 'FROM pg_database': ok([{ oid: '987654', marker: EXPECTED.marker, owner: config.ownerUser, allow: true, template: false }]),
    'FROM pg_roles': ok([{ name: config.ownerUser, oid: '100', super: false, bypass: false, login: true, createdb: false, inherit: false }, { name: config.migrationUser, oid: '111', super: false, bypass: false, login: true, createdb: false, inherit: false }, { name: config.runtimeUser, oid: '222', super: false, bypass: false, login: true, createdb: false, inherit: false }]),
    pg_has_role: ok([{ member: false }]), pg_stat_activity: ok([{ n: 1 }]), 'to_regprocedure': ok([{ present: false }]) });
  const host = recorder();
  await run({ config, plan, log: host.log, exit: host.exit, execute: true, connect: user => (user === config.ownerUser ? owner : target),
    loadAssembly: async () => ({ applyRuntimePrivileges: async () => {}, configureDistributionFinancialPrivileges: async () => {} }) });
  assert.equal(host.codes.includes(1), true);
  assert.ok(host.lines.some(line => line.code === 'CONTRACT_FUNCTION_PRESENT_FAILED'));
  assert.equal(host.lines.some(line => line.pass === true), false);
});

test('the real CLI keeps an incomplete native contract away from credentials and sockets', () => {
  const directory = mkdtempSync(join(tmpdir(), 'zzsh-native-cli-'));
  try {
    const config = baseConfig({ statePath: join(directory, 'state.json'), candidateDir: directory, native: { journalPath: join(directory, 'journal.log'), expectations: [STAGE('accrue', { orderId: 'order_native_1', items: 2, amounts: {} })] } });
    delete config.native.file; delete config.native.collectionDocument; delete config.native.adminFixtureId; delete config.native.declarerUserId;
    writeFileSync(join(directory, 'state.json'), JSON.stringify(baseState()));
    for (const name of CANDIDATES) writeFileSync(join(directory, name), clean(name));
    const file = join(directory, 'config.json');
    writeFileSync(file, JSON.stringify(config));
    const sealed = sha256(Buffer.from(JSON.stringify(config)));
    const script = resolve(here, 'distribution-pg-native-acceptance.mjs');
    const env = { ...process.env, DISTRIBUTION_OWNER_PASSWORD_FILE: '', DISTRIBUTION_MIGRATION_PASSWORD_FILE: '' };
    const plan = spawnSync(process.execPath, [script, '--config', file, '--sha256', sealed], { encoding: 'utf8', env });
    assert.equal(plan.status, 0, plan.stderr);
    const parsed = JSON.parse(plan.stdout);
    assert.equal(parsed.mode, 'PLAN');
    assert.equal(parsed.readsSecrets, false);
    assert.deepEqual(parsed.nativeContract.missing.sort(), ['native.adminFixtureId', 'native.collectionDocument', 'native.declarerUserId', 'native.file'].sort());
    assert.ok(parsed.nativeContract.absentStages.includes('recover'));
    const full = spawnSync(process.execPath, [script, '--config', file, '--sha256', sealed, '--full-native'], { encoding: 'utf8', env });
    assert.equal(full.status, 2, full.stderr);
    const refused = JSON.parse(full.stderr.split(String.fromCharCode(10)).filter(Boolean).at(-1));
    assert.equal(refused.code, 'NATIVE_CONTRACT_INCOMPLETE');
    assert.equal(refused.connections, 0);
    assert.equal(refused.readsSecrets, false);
    assert.ok(refused.missing.includes('native.file'));
    const restore = spawnSync(process.execPath, [script, '--config', file, '--sha256', sealed, '--restore-regression'], { encoding: 'utf8', env });
    assert.equal(restore.status, 2);
    const badSeal = spawnSync(process.execPath, [script, '--config', file, '--sha256', '0'.repeat(64)], { encoding: 'utf8', env });
    assert.notEqual(badSeal.status, 0);
    assert.match(badSeal.stderr, /CONFIG_SHA_MISMATCH/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
