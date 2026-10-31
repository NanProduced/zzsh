// Sealed acceptance host for the distribution v2/NATIVE forward package.
//
// Modes, named by what they actually touch:
//   PLAN (default)     reads only the sealed config, the registered state file and the candidate SQL
//                      bytes. No credential file is read and zero connections are opened.
//   --verify-identity  one owner connection: proves database identity, registered role names and real
//                      OIDs, no owner impersonation, and no foreign sessions. No DDL, no writes.
//   --execute          applies 01+02+03 in one migration transaction, reads back structure, the version
//                      marker and the EFFECTIVE ACL through a real SET LOCAL ROLE, then always ROLLBACKs.
//   --full-native      additionally drives the compiled application money path (accrue -> SETTLE ->
//                      REVOKE / RECOVERY_REQUIRED -> RECOVER) over the sealed native fixture, in the
//                      application's own transactions, and records every id it created for cleanup.
//   --cleanup-native   deletes exactly the ids recorded by a previous --full-native receipt.
//
// Nothing here enables a policy, calls a channel, or leaves a structural change behind.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from 'pg';

export const CANDIDATES = ['01_uniform_policy_and_payment_basis.sql', '02_native_earning_and_reversal_scope.sql', '03_v2_registration_and_contract.sql'];
export const EXPECTED = { host: '127.0.0.1', port: 55432, database: 'zzsh_test_regression', marker: 'zzsh:regression-test:v1', lockKey: '806006' };
const ROLE = /^[a-z][a-z0-9_]{0,62}$/;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const canonical = (value) => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
export const fail = (code, detail) => { throw Object.assign(new Error(code), { code, ...(detail === undefined ? {} : { detail }) }); };
const incomplete = (code, detail) => { throw Object.assign(new Error(code), { code, incomplete: true, ...(detail === undefined ? {} : { detail }) }); };

/** Static shape and sealing. Runs before any credential read or connection. */
export function sealedPlan(config, state, read) {
  if (config.schema !== 'distribution-pg-acceptance.v2' || config.host !== EXPECTED.host || config.port !== EXPECTED.port || config.database !== EXPECTED.database
    || config.marker !== EXPECTED.marker || String(config.lockKey ?? EXPECTED.lockKey) !== EXPECTED.lockKey || !Number.isSafeInteger(config.resourceOid)
    || typeof config.nonce !== 'string' || !/^[0-9a-f]{8,64}$/.test(config.nonce) || typeof config.statePath !== 'string' || typeof config.candidateDir !== 'string') fail('SEALED_CONFIG_SHAPE_INVALID');
  for (const entry of ['ownerUser', 'migrationUser', 'runtimeUser']) if (!ROLE.test(config[entry] ?? '')) fail('SEALED_ROLE_NAME_INVALID', entry);
  if (new Set([config.ownerUser, config.migrationUser, config.runtimeUser]).size !== 3) fail('SEALED_ROLES_MUST_BE_DISTINCT');
  for (const entry of ['migration', 'runtime']) {
    const registered = state?.roles?.[entry];
    if (!registered || typeof registered.name !== 'string' || !Number.isSafeInteger(Number(registered.oid))) incomplete('REGISTERED_ROLE_MISSING', entry);
    if (registered.name !== config[entry + 'User']) fail('REGISTERED_ROLE_NAME_MISMATCH', { entry, registered: registered.name });
    if (String(registered.oid) !== String(config.roles?.[entry + 'Oid'])) fail('REGISTERED_ROLE_OID_MISMATCH', entry);
  }
  if (state.database !== config.database || state.oid !== String(config.resourceOid) || state.nonce !== config.nonce || state.marker !== config.marker || state.pendingReset !== null) fail('REGISTERED_STATE_MISMATCH');
  if (!config.expectedSqlSha256 || CANDIDATES.some(name => !/^[0-9a-f]{64}$/.test(String(config.expectedSqlSha256[name] ?? '')))) fail('SEALED_SQL_MANIFEST_REQUIRED');
  const sql = CANDIDATES.map(name => {
    const path = resolve(config.candidateDir, name), bytes = read(path), text = bytes.toString('utf8'), digest = sha256(bytes);
    if (/(^|\n)\s*(BEGIN|COMMIT)\s*;/i.test(text)) fail('CANDIDATE_HAS_TRANSACTION_WRAPPER', name);
    if (digest !== config.expectedSqlSha256[name]) fail('CANDIDATE_SQL_SEAL_MISMATCH', { name, expected: config.expectedSqlSha256[name], actual: digest });
    return { name, path, text, digest };
  });
  let native = null;
  if (config.native) {
    const path = resolve(config.candidateDir, config.native.file), bytes = read(path), digest = sha256(bytes);
    if (digest !== config.native.expectedSha256) fail('NATIVE_FIXTURE_SEAL_MISMATCH', { expected: config.native.expectedSha256, actual: digest });
    if (!config.native.collectionDocument || !/^[0-9a-f]{64}$/.test(String(config.native.expectedCollectionSha256))) fail('NATIVE_COLLECTION_ADMISSION_REQUIRED');
    const collectionPath = resolve(config.candidateDir, config.native.collectionDocument), collectionBytes = read(collectionPath);
    if (sha256(collectionBytes) !== config.native.expectedCollectionSha256) fail('NATIVE_COLLECTION_SEAL_MISMATCH');
    const expectations = config.native.expectations;
    if (!Array.isArray(expectations) || !expectations.length) fail('NATIVE_EXPECTATIONS_REQUIRED');
    native = { path, digest, sql: bytes.toString('utf8'), collectionPath, collectionDigest: sha256(collectionBytes), expectations };
  }
  return { sql, native };
}

/** Catalog facts, not self-declared config: role names, real OIDs, privilege shape, foreign sessions. */
export async function verifyIdentity(owner, target, config) {
  const database = (await owner.query(`SELECT d.oid::text AS oid,shobj_description(d.oid,'pg_database') AS marker,pg_get_userbyid(d.datdba) AS owner,d.datallowconn AS allow,d.datistemplate AS template
    FROM pg_database d WHERE d.datname=$1`, [config.database])).rows[0];
  if (!database || database.oid !== String(config.resourceOid) || database.marker !== config.marker || database.owner !== config.ownerUser
    || database.allow !== true || database.template !== false) fail('DATABASE_IDENTITY_MISMATCH', database);
  const names = [config.ownerUser, config.migrationUser, config.runtimeUser];
  const rows = (await owner.query(`SELECT rolname AS name,oid::text AS oid,rolsuper AS super,rolbypassrls AS bypass,rolcanlogin AS login,rolcreatedb AS createdb,rolinherit AS inherit
    FROM pg_roles WHERE rolname=ANY($1::text[])`, [names])).rows;
  if (rows.length !== names.length) fail('REGISTERED_ROLE_ABSENT', { expected: names, found: rows.map(row => row.name) });
  const byName = new Map(rows.map(row => [row.name, row]));
  for (const entry of ['migrationUser', 'runtimeUser']) {
    const role = byName.get(config[entry]);
    if (role.super === true || role.bypass === true || role.createdb === true) fail('ROLE_PRIVILEGE_ESCALATION', entry);
    if (role.login !== true) fail('ROLE_CANNOT_LOGIN', entry);
    const owns = (await owner.query('SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relowner=$1 AND n.nspname=$2',
      [role.oid, 'zzsh_order'])).rows[0].n;
    if (Number(owns) > 0) fail('ROLE_OWNS_BUSINESS_RELATIONS', { entry, owns: Number(owns) });
  }
  if (byName.get(config.migrationUser).oid !== String(config.roles.migrationOid) || byName.get(config.runtimeUser).oid !== String(config.roles.runtimeOid)) fail('REGISTERED_ROLE_OID_DRIFT');
  const runtimeIsOwner = (await owner.query('SELECT pg_has_role($1,$2,$3) AS member', [config.runtimeUser, config.ownerUser, 'MEMBER'])).rows[0].member;
  if (runtimeIsOwner === true) fail('RUNTIME_IMPERSONATES_OWNER');
  // Only this host's own target session may be on the registered database while we work.
  const others = (await owner.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend' AND pid<>pg_backend_pid()", [config.database])).rows[0].n;
  if (Number(others) !== 1) fail('FOREIGN_SESSION_PRESENT', { others: Number(others), expected: 1 });
  return { database, roles: Object.fromEntries([...byName].map(([name, row]) => [name, { oid: row.oid, super: row.super, bypass: row.bypass }])) };
}

const snapshot = async (client) => ({
  counts: (await client.query(`SELECT (SELECT count(*)::int FROM zzsh_order.distribution_policy_version) AS versions,
    (SELECT count(*)::int FROM zzsh_order.distribution_policy_head) AS heads,(SELECT count(*)::int FROM zzsh_order.distribution_participant) AS participants,
    (SELECT count(*)::int FROM zzsh_order.invitation_relation) AS relations,(SELECT count(*)::int FROM zzsh_order.rental_referral_earning) AS earnings,
    (SELECT count(*)::int FROM zzsh_order.rental_referral_reversal_source) AS declarations`)).rows[0],
  definitions: (await client.query(`SELECT p.oid::regprocedure::text AS signature,pg_get_functiondef(p.oid) AS body,coalesce((SELECT array_agg(DISTINCT a)::text FROM aclexplode(p.proacl) a),'(default)') AS acl
    FROM pg_proc p WHERE p.pronamespace='zzsh_order'::regnamespace
      AND p.proname IN ('distribution_policy_contract_version','guard_distribution_participant','guard_referral_reversal_declaration','derive_payment_referral_inputs','guard_payment_distribution_basis','guard_earning_entry')
    ORDER BY 1`)).rows,
  constraints: (await client.query(`SELECT c.conname AS name,pg_get_constraintdef(c.oid) AS definition FROM pg_constraint c
    WHERE c.conname IN ('distribution_participant_check','invitation_relation_source_type_check','rental_referral_reversal_source_scope_check','earning_expected_lines') ORDER BY 1`)).rows,
  heads: (await client.query('SELECT scope,revision,current_version_id FROM zzsh_order.distribution_policy_head ORDER BY scope')).rows,
});

export function createLedger() {
  const checks = [];
  return { checks,
    pass: (code, detail) => { checks.push({ check: 'PASS', code, ...(detail === undefined ? {} : { detail }) }); return true; },
    require: (ok, code, detail) => { if (ok) return checks.push({ check: 'PASS', code, ...(detail === undefined ? {} : { detail }) }); checks.push({ check: 'FAIL', code, detail }); fail(`${code}_FAILED`, detail); },
    incomplete: (code, detail) => { checks.push({ check: 'INCOMPLETE', code, ...(detail === undefined ? {} : { detail }) }); incomplete(code, detail); },
  };
}
const rejected = async (client, savepoint, statement, params, expected, ledger, label) => {
  await client.query(`SAVEPOINT ${savepoint}`);
  let error = null;
  try { await client.query(statement, params); } catch (caught) { error = caught; }
  await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
  await client.query(`RELEASE SAVEPOINT ${savepoint}`);
  ledger.require(!!error && error.code === expected.sqlstate && (!expected.constraint || String(error.constraint ?? '').includes(expected.constraint) || String(error.message ?? '').includes(expected.constraint)),
    label, { sqlstate: error?.code ?? 'NOT_REJECTED', constraint: error?.constraint ?? null, expected });
};

async function inTxn(client, run) {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout='15s'");
  await client.query("SET LOCAL lock_timeout='2s'");
  return run();
}

export async function structurePhase(client, plan, config, ledger) {
  for (const file of plan.sql) await client.query(file.text);
  ledger.pass('CANDIDATES_APPLIED_IN_ONE_TRANSACTION', plan.sql.map(file => file.digest));
  ledger.require((await client.query("SELECT to_regprocedure('zzsh_order.distribution_policy_contract_version()') IS NOT NULL AS present")).rows[0].present === true, 'CONTRACT_FUNCTION_PRESENT');
  ledger.require(Number((await client.query('SELECT zzsh_order.distribution_policy_contract_version() AS version')).rows[0].version) === 2, 'CONTRACT_VERSION_TWO');
  ledger.require((await client.query(`SELECT NOT EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
    WHERE p.oid='zzsh_order.distribution_policy_contract_version()'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS closed`)).rows[0].closed === true, 'CONTRACT_PUBLIC_EXECUTE_REVOKED');
  // Effective privileges have to be read as the runtime role inside this same transaction.
  await client.query(`SET LOCAL ROLE ${config.runtimeUser}`);
  try {
    const read = await client.query('SELECT current_user AS role, zzsh_order.distribution_policy_contract_version() AS version');
    ledger.require(read.rows[0].role === config.runtimeUser && Number(read.rows[0].version) === 2, 'RUNTIME_CONTRACT_EXECUTE_READBACK', read.rows[0]);
    const declaration = await client.query("INSERT INTO zzsh_order.rental_referral_reversal_source(id,earning_id,scope,basis_digest,amount_cents,canonical_source,source_digest,approval_digest,created_by_admin_id,reason) VALUES('p','p','NATIVE',repeat('b',64),'1','{}',repeat('c',64),repeat('a',64),'p','p']").catch(error => error);
    ledger.require(declaration.code === '42501', 'RUNTIME_REVERSAL_DECLARATION_DENIED', { sqlstate: declaration.code ?? 'accepted' });
    const seed = await client.query("UPDATE zzsh_order.rental_referral_earning SET canonical_seed='{}' WHERE id='probe'").catch(error => error);
    ledger.require(seed.code === '42501', 'RUNTIME_PROTECTED_EARNING_SOURCE_DENIED', { sqlstate: seed.code ?? 'accepted' });
  } finally { await client.query('RESET ROLE'); }
}

export async function policyPhase(client, config, plan, ledger) {
  const adminId = plan.native ? (await client.query('SELECT id FROM zzsh_auth_admin."user" WHERE status=$1 AND is_boss IS NOT NULL ORDER BY id LIMIT 1', ['ACTIVE'])).rows[0]?.id : null;
  if (!adminId) ledger.incomplete('ADMIN_FIXTURE_REQUIRED', 'the sealed native fixture must create an ACTIVE administrator');
  const version = (patch) => canonical({ schema: 'distribution-policy.v2', scope: 'NATIVE', enabled: false, participation: 'AUTO_AT_REGISTRATION', depth: 1, selfRebate: false,
    accountModes: ['ordinary', 'custom'], minimumAccrualCents: '0', settlementDelayDays: 7, rateMode: 'UNIFORM', renterPercent: '5', ownerPercent: '5', levels: [], ...patch });
  const insert = `INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id) VALUES($1,1,'NATIVE','distribution-policy.v2',$2,$3,$4)`;
  const over = version({ renterPercent: '60', ownerPercent: '60' });
  await rejected(client, 'rate_cap', insert, ['probe_rate_cap', over, sha256(over), adminId], { sqlstate: '23514', constraint: 'uniform' }, ledger, 'UNIFORM_RATE_GUARD');
  const v1 = version({ schema: 'distribution-policy.v1', levels: [] });
  await rejected(client, 'shape', insert, ['probe_shape', v1, sha256(v1), adminId], { sqlstate: '23514' }, ledger, 'V2_SCHEMA_REJECTS_V1_CONFIG');
  const heads = (await client.query("SELECT count(*)::int AS n FROM zzsh_order.distribution_policy_head WHERE scope='NATIVE'")).rows[0].n;
  if (Number(heads) > 0) return ledger.pass('V2_NATIVE_HEAD_PREEXISTING', { heads });
  const good = version({});
  await client.query(insert, ['probe_v2', good, sha256(good), adminId]);
  await client.query("INSERT INTO zzsh_order.distribution_policy_head(scope,revision,current_version_id) VALUES('NATIVE',1,'probe_v2')");
  ledger.require((await client.query("SELECT current_version_id FROM zzsh_order.distribution_policy_head WHERE scope='NATIVE'")).rows[0]?.current_version_id === 'probe_v2', 'V2_NATIVE_POLICY_ACCEPTED');
  return 'installed';
}

/**
 * The money path is driven by the compiled application, not by a second SQL re-implementation:
 * accrue -> duplicate accrue -> SETTLE -> REVOKE (sufficient) -> REVOKE (insufficient) -> RECOVER.
 * Because the application owns its transactions, these rows commit; the receipt lists every id and
 * --cleanup-native removes exactly those rows.
 */
export async function fundsPhase(client, config, plan, ledger, store) {
  if (!plan.native) ledger.incomplete('NATIVE_FIXTURE_REQUIRED', 'sealed native fixture SQL and expectations are missing');
  if (!store) ledger.incomplete('API_DIST_REQUIRED', 'run npm run build -w @zzsh/api before --full-native');
  const requestId = 'acceptance_' + plan.native.digest.slice(0, 16);
  const created = { orders: [], earnings: [], declarations: [] };
  for (const expectation of plan.native.expectations) {
    if (expectation.orderId) created.orders.push(expectation.orderId);
    if (expectation.reversalSourceId) created.declarations.push(expectation.reversalSourceId);
  }
  // One application-shaped connection: the store borrows, we hand it this session and never release it.
  const pool = { connect: async () => ({ query: (sql, params) => client.query(sql, params), release() { /* the acceptance session stays open */ } }) };
  await client.query(plan.native.sql);
  ledger.pass('NATIVE_FIXTURE_APPLIED', { sha256: plan.native.digest, orders: created.orders.length });
  for (const expectation of plan.native.expectations) {
    if (expectation.phase === 'accrue') {
      const result = await store.accrue(pool, expectation.orderId, requestId);
      ledger.require(result.knowledge === 'KNOWN' && result.items.length === expectation.items, 'NATIVE_ACCRUAL_ITEMS', { case: expectation.case, items: result.items.length });
      for (const item of result.items) { created.earnings.push(item.root.id);
        ledger.require(String(item.root.amountCents) === expectation.amounts[item.root.role] && item.root.state === 'PENDING', 'NATIVE_ACCRUAL_FACTS', { case: expectation.case, role: item.root.role, amount: item.root.amountCents }); }
      const again = await store.accrue(pool, expectation.orderId, requestId + '_replay');
      ledger.require(again.knowledge === 'KNOWN' && again.items.every(item => item.replayed), 'NATIVE_ACCRUAL_IDEMPOTENT', { case: expectation.case });
      ledger.require((await client.query('SELECT count(*)::int AS n FROM zzsh_order.rental_referral_earning WHERE order_id=$1', [expectation.orderId])).rows[0].n === expectation.items, 'NATIVE_NO_DUPLICATE_ROOT', { case: expectation.case });
      continue;
    }
    if (expectation.phase === 'settle') {
      const earning = (await client.query('SELECT id,version::text AS version,state FROM zzsh_order.rental_referral_earning WHERE id=$1', [expectation.earningId])).rows[0];
      if (expectation.due === false) { const error = await store.transition(pool, earning.id, 'SETTLE', earning.version, requestId).catch(caught => caught);
        ledger.require(error?.code === 'CONFLICT' || /not due/.test(String(error?.message)), 'NATIVE_SETTLE_BEFORE_DUE_REJECTED', { case: expectation.case, code: error?.code ?? 'accepted' }); continue; }
      const settled = await store.transition(pool, earning.id, 'SETTLE', earning.version, requestId);
      ledger.require(settled.root.state === 'SETTLED', 'NATIVE_SETTLE_STATE', { case: expectation.case });
      ledger.require((await client.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_ledger_entry e JOIN zzsh_order.finance_event f ON f.id=e.finance_event_id
        WHERE f.economic_root_id=$1 AND e.account_code='WALLET_AVAILABLE' AND e.credit_cents>0`, [earning.id])).rows[0].n === 1, 'NATIVE_SETTLE_CREDITS_AVAILABLE', { case: expectation.case });
      const replay = await store.transition(pool, earning.id, 'SETTLE', String(BigInt(earning.version) + 1n), requestId + '_replay');
      ledger.require(replay.replayed === true, 'NATIVE_SETTLE_RECEIPT_REPLAY', { case: expectation.case });
      continue;
    }
    if (expectation.phase === 'revoke') {
      const earning = (await client.query('SELECT id,version::text AS version FROM zzsh_order.rental_referral_earning WHERE id=$1', [expectation.earningId])).rows[0];
      const revoked = await store.transition(pool, earning.id, 'REVOKE', earning.version, requestId, expectation.reversalSourceId);
      const expectedState = expectation.funds === 'sufficient' ? 'REVOKED' : 'RECOVERY_REQUIRED';
      ledger.require(revoked.root.state === expectedState, 'NATIVE_REVOKE_STATE', { case: expectation.case, state: revoked.root.state });
      if (expectedState === 'RECOVERY_REQUIRED') {
        ledger.require(revoked.root.recoveryRequiredCents === revoked.root.amountCents, 'NATIVE_RECOVERY_OBLIGATION', { case: expectation.case });
        ledger.require((await client.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_ledger_entry e JOIN zzsh_order.finance_event f ON f.id=e.finance_event_id
          WHERE f.economic_root_id=$1 AND e.account_code='WALLET_AVAILABLE' AND e.debit_cents>0`, [earning.id])).rows[0].n === 0, 'NATIVE_INSUFFICIENT_HAS_NO_FAKE_DEBIT', { case: expectation.case });
      }
      continue;
    }
    if (expectation.phase === 'recover') {
      const earning = (await client.query('SELECT id,version::text AS version FROM zzsh_order.rental_referral_earning WHERE id=$1', [expectation.earningId])).rows[0];
      const recovered = await store.transition(pool, earning.id, 'RECOVER', earning.version, requestId, expectation.reversalSourceId);
      ledger.require(recovered.root.state === 'REVOKED' && recovered.root.recoveryRequiredCents === null, 'NATIVE_RECOVER_CLOSES_OBLIGATION', { case: expectation.case });
      continue;
    }
    ledger.incomplete('NATIVE_EXPECTATION_PHASE_UNKNOWN', expectation);
  }
  ledger.pass('NATIVE_FUNDS_CHAIN_COMPLETED', { cases: plan.native.expectations.map(item => item.case) });
  return created;
}

/**
 * Cleanup follows the accounting closure: receipts and entries first, then events, roots, earnings,
 * declarations and finally the fixture orders. Anything the database refuses is reported with its
 * SQLSTATE; a receipt is only marked removed when the rows are provably gone.
 */
export async function cleanupPhase(client, created, ledger) {
  if (!created?.earnings?.length) ledger.incomplete('CLEANUP_RECEIPT_REQUIRED', 'a --full-native receipt with created earnings is required');
  const statement = async (sql, params) => client.query(sql, params).catch(error => { if (error.code !== '23503' && error.code !== '23514') throw error; return { refused: error.code }; });
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout='15s'");
  await statement(`DELETE FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id IN (SELECT id FROM zzsh_order.finance_event WHERE economic_root_id=ANY($1::text[]))`, [created.earnings]);
  await statement('DELETE FROM zzsh_order.rental_referral_transition WHERE earning_id=ANY($1::text[])', [created.earnings]);
  await statement('DELETE FROM zzsh_order.finance_event WHERE economic_root_id=ANY($1::text[])', [created.earnings]);
  await statement('DELETE FROM zzsh_order.rental_referral_reversal_source WHERE id=ANY($1::text[])', [created.declarations]);
  await statement('DELETE FROM zzsh_order.rental_referral_earning WHERE id=ANY($1::text[])', [created.earnings]);
  await statement('DELETE FROM zzsh_order.finance_economic_root WHERE id=ANY($1::text[])', [created.earnings]);
  for (const id of created.orders) await statement('DELETE FROM zzsh_order.rental_order WHERE id=$1', [id]);
  const left = (await client.query('SELECT count(*)::int AS n FROM zzsh_order.rental_referral_earning WHERE id=ANY($1::text[])', [created.earnings])).rows[0].n;
  if (Number(left) === 0) await client.query('COMMIT'); else await client.query('ROLLBACK');
  ledger.require(Number(left) === 0, 'NATIVE_FIXTURE_ROWS_REMOVED', { left: Number(left) });
}

export async function run(options) {
  const { config, plan, connect, log = console, exit = code => { process.exitCode = code; }, loadStore = async () => null } = options;
  const mode = options.cleanup ? 'CLEANUP_NATIVE' : options.fullNative ? 'FULL_NATIVE' : options.execute ? 'STRUCTURE_ROLLBACK' : options.identity ? 'VERIFY_IDENTITY' : 'PLAN';
  const ledger = createLedger();
  const receipt = { schema: 'distribution-pg-acceptance-receipt.v1', mode, host: EXPECTED.host, port: EXPECTED.port, database: config.database,
    resourceOid: String(config.resourceOid), sql: plan.sql.map(file => ({ name: file.name, sha256: file.digest })),
    ...(plan.native ? { nativeFixture: { sha256: plan.native.digest, collectionDocument: plan.native.collectionDigest } } : {}) };
  if (mode === 'PLAN') {
    log.log(JSON.stringify({ ...receipt, pass: true, readsSecrets: false, connections: 0, checksPlanned: ['IDENTITY', 'STRUCTURE_AND_ACL', 'POLICY_GUARDS', ...(plan.native ? ['NATIVE_FUNDS'] : ['NATIVE_FUNDS:INCOMPLETE'])] }));
    return receipt;
  }
  const owner = connect(config.ownerUser, 'postgres', 'DISTRIBUTION_OWNER_PASSWORD_FILE');
  const target = connect(config.migrationUser, config.database, 'DISTRIBUTION_MIGRATION_PASSWORD_FILE');
  let locked = false, unlocked = null, began = false, rolledBack = null, ended = null, primary = null, committed = false, success = null;
  try {
    await owner.connect();
    locked = (await owner.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [Number(EXPECTED.lockKey)])).rows[0].acquired === true;
    if (!locked) fail('MAINTENANCE_LOCK_BUSY');
    await target.connect();
    const nonce = (await target.query("SELECT current_database() AS database,current_user AS role,current_setting('zzsh.regression_run',true) AS nonce")).rows[0];
    if (nonce.database !== config.database || nonce.role !== config.migrationUser || nonce.nonce !== config.nonce) fail('TARGET_NONCE_AND_ROLE_MISMATCH', nonce);
    ledger.pass('TARGET_SESSION_REGISTERED', nonce);
    await verifyIdentity(owner, target, config);
    ledger.pass('REGISTERED_IDENTITY_AND_ROLES');
    if (mode === 'CLEANUP_NATIVE') {
      await cleanupPhase(target, options.created, ledger);
      committed = true;
      success = { ...receipt, pass: true, checks: ledger.checks, cleanup: { rolledBack, unlocked, ended } };
    } else if (mode === 'FULL_NATIVE') {
      const earnings = await loadStore(config, plan);
      await inTxn(target, async () => { await structurePhase(target, plan, config, ledger); await policyPhase(target, config, plan, ledger); await target.query('SET CONSTRAINTS ALL IMMEDIATE'); await target.query('ROLLBACK'); began = false; rolledBack = true; });
      ledger.pass('STRUCTURE_ROLLED_BACK_BEFORE_FUNDS');
      const created = await fundsPhase(target, config, plan, ledger, earnings);
      committed = true;
      success = { ...receipt, pass: true, checks: ledger.checks, created, cleanupCommand: `node scripts/distribution-pg-native-acceptance.mjs --config <same sealed config> --sha256 <same> --cleanup-native --created '<this created block>'` };
    } else {
      const before = await snapshot(target);
      began = true;
      await inTxn(target, async () => {
        if (mode === 'STRUCTURE_ROLLBACK') { await structurePhase(target, plan, config, ledger); await policyPhase(target, config, plan, ledger); }
        await target.query('SET CONSTRAINTS ALL IMMEDIATE');
        await target.query('ROLLBACK'); began = false; rolledBack = true;
      });
      const after = await snapshot(target);
      if (JSON.stringify(before) !== JSON.stringify(after)) fail('ROLLBACK_DID_NOT_RESTORE_DEFINITIONS_CONSTRAINTS_HEADS_OR_ROWS', { before, after });
      ledger.pass('ROLLBACK_RESTORED_DEFINITIONS_CONSTRAINTS_HEADS_AND_ROWS');
      success = { ...receipt, pass: true, checks: ledger.checks, cleanup: { began, rolledBack, unlocked, ended } };
    }
    return receipt;
  } catch (error) {
    primary = error;
    if (began) { try { await target.query('ROLLBACK'); rolledBack = true; } catch { rolledBack = false; } }
    log.error(JSON.stringify({ ...receipt, pass: false, code: error.code ?? 'FAILED', incomplete: error.incomplete === true, message: error.message, detail: error.detail ?? null, checks: ledger.checks, committed }));
    exit(error.incomplete === true ? 2 : 1);
    return receipt;
  } finally {
    if (locked) { try { unlocked = (await owner.query('SELECT pg_advisory_unlock($1::bigint) AS released', [Number(EXPECTED.lockKey)])).rows[0].released === true; } catch { unlocked = false; } }
    try { await target.end(); await owner.end(); ended = true; } catch { ended = false; }
    const cleanupBad = (locked && unlocked !== true) || ended !== true;
    if (!primary && success) {
      if (cleanupBad) log.error(JSON.stringify({ ...success, pass: false, code: 'CLEANUP_UNKNOWN', cleanup: { locked, unlocked, rolledBack, ended, committed } }));
      else log.log(JSON.stringify({ ...success, cleanup: { locked, unlocked, rolledBack, ended, committed } }));
      if (cleanupBad) exit(1);
    } else if (primary) log.error(JSON.stringify({ code: 'CLEANUP_REPORT', locked, unlocked, rolledBack, ended, committed, primary: primary.code ?? primary.message }));
  }
}

async function main() {
  const args = process.argv.slice(2), opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const configPath = opt('--config'), configSha = opt('--sha256');
  if (!configPath || !configSha) fail('SEALED_CONFIG_REQUIRED');
  const bytes = readFileSync(resolve(configPath));
  if (sha256(bytes) !== configSha) fail('CONFIG_SHA_MISMATCH');
  const config = JSON.parse(bytes.toString('utf8'));
  const plan = sealedPlan(config, JSON.parse(readFileSync(resolve(config.statePath), 'utf8')), path => readFileSync(path));
  const password = variable => { const file = process.env[variable]?.trim(); if (!file) fail(`${variable}_MISSING`); return readFileSync(resolve(file), 'utf8').trim(); };
  const created = opt('--created') ? JSON.parse(opt('--created')) : null;
  return run({ config, plan, created, execute: args.includes('--execute'), identity: args.includes('--verify-identity'),
    fullNative: args.includes('--full-native'), cleanup: args.includes('--cleanup-native'),
    connect: (user, database, variable) => {
      if (database !== EXPECTED.database && database !== 'postgres') fail('CONNECT_TARGET_UNEXPECTED', database);
      const client = new Client({ host: EXPECTED.host, port: EXPECTED.port, database, user, password: password(variable),
        connectionTimeoutMillis: 4000, statement_timeout: 15000, application_name: 'zzsh-distribution-acceptance' });
      return client; },
    // The money path is the application's own code, loaded from the compiled workspace build.
    loadStore: async (activeConfig, activePlan) => {
      if (!activePlan.native) return null;
      const dist = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/api/dist/src').replace(/\\/g, '/');
      let store, runtime;
      try { store = await import(dist + '/finance/distribution-earning-store.js'); runtime = await import(dist + '/order/joinpay-collection-runtime.js'); }
      catch { return null; }
      const assembly = runtime.loadJoinpayCollectionRuntime({ provider: 'real', authEnabled: true, database: { name: activeConfig.database, user: activeConfig.runtimeUser, runtimeUser: activeConfig.runtimeUser } },
        { JOINPAY_COLLECTION_ENABLED: 'true', JOINPAY_COLLECTION_CONFIG_FILE: activePlan.native.collectionPath });
      if (!assembly?.admission) fail('NATIVE_COLLECTION_ADMISSION_UNAVAILABLE');
      return store.createNativeDistributionEarningStore(assembly.admission);
    } });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
