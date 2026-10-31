// Sealed acceptance host for the distribution v2/NATIVE forward package.
//
// Modes, named by what they actually touch:
//   PLAN (default)     reads only the sealed config, the registered state file, the candidate SQL bytes
//                      and the native contract fields. No credential file is read, zero connections.
//   --verify-identity  one owner + one target connection: database identity, registered role names and
//                      real OIDs from the catalog, runtime membership, SET ROLE capability, foreign
//                      sessions. No DDL, no writes.
//   --execute          one migration transaction: apply canonical 0121+0122+0123, run the SHARED runtime privilege and
//                      distribution financial-ACL steps, read effective privileges as the registered
//                      runtime role, then the policy guards, then always ROLLBACK and compare the exact
//                      objects this package changes.
//   --full-native      the SAME approved assembly continues without rolling back first: the sealed native
//                      fixture stages, then the compiled application's own money bodies (accrueOn /
//                      transitionOn) on the same session as the registered runtime role, with the owner
//                      declaration taken between stages. Nothing commits; every stage is journalled;
//                      the run ends with SET CONSTRAINTS ALL IMMEDIATE, ROLLBACK and a residue scan.
//   --restore-regression  read-only residue check. It never deletes financial evidence: any residue is
//                      reported with its original keys and referred to the registered controlled reset.
//
// Nothing here enables a policy, calls a channel, or leaves a committed change behind.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from 'pg';

export const CANDIDATES = ['0121_distribution_uniform_policy_basis.sql', '0122_distribution_native_earning_scope.sql', '0123_distribution_participant_contract.sql'];
export const EXPECTED = { host: '127.0.0.1', port: 55432, database: 'zzsh_test_regression', marker: 'zzsh:regression-test:v1', lockKey: '806006' };
/** The chain the host refuses to call "complete" without. Each stage is one sealed expectation phase. */
export const REQUIRED_STAGES = ['fixture', 'policy', 'accrue', 'accrue-replay', 'settle-not-due', 'settle', 'revoke-sufficient', 'revoke-insufficient', 'recover'];
const ROLE = /^[a-z][a-z0-9_]{0,62}$/;
export const sha256 = (value) => createHash('sha256').update(value).digest('hex');
export const canonical = (value) => Array.isArray(value) ? '[' + value.map(canonical).join(',') + ']'
  : value && typeof value === 'object' ? '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}' : JSON.stringify(value);
export const fail = (code, detail) => { throw Object.assign(new Error(code), { code, ...(detail === undefined ? {} : { detail }) }); };
const incomplete = (code, detail) => { throw Object.assign(new Error(code), { code, incomplete: true, ...(detail === undefined ? {} : { detail }) }); };

/**
 * Everything the native chain needs, described once so a missing input is named instead of discovered
 * by a failing connection. `missing` is the exact field list an operator has to supply.
 */
export function nativeContract(config) {
  const native = config?.native ?? {};
  const fields = {
    'native.file': 'candidate-dir-relative sealed SQL path, e.g. native-fixture.sql',
    'native.expectedSha256': '64 hex of that file bytes',
    'native.collectionDocument': 'sealed JoinPay formal collection runtime document path (brands the NATIVE admission)',
    'native.expectedCollectionSha256': '64 hex of that document',
    'native.adminFixtureId': 'ACTIVE administrator id already present in the registered regression resource',
    'native.declarerUserId': 'table-owner administrator id used for the reversal declaration stage',
    'native.expectations': 'ordered stages, one per phase, each {case, phase, ...}',
    'native.expectations.recover.fundingSql': 'sealed synthetic balanced-wallet funding DML, after insufficient REVOKE and before RECOVER of that same root; no change to the debt or original receipts',
    'native.journalPath': 'file under the repository tmp/ where each stage receipt is appended',
    'expectedSqlSha256': '64 hex per candidate file name (01/02/03)',
  };
  const missing = [];
  if (!native.file) missing.push('native.file');
  if (!/^[0-9a-f]{64}$/.test(String(native.expectedSha256 ?? ''))) missing.push('native.expectedSha256');
  if (!native.collectionDocument) missing.push('native.collectionDocument');
  if (!/^[0-9a-f]{64}$/.test(String(native.expectedCollectionSha256 ?? ''))) missing.push('native.expectedCollectionSha256');
  if (typeof native.adminFixtureId !== 'string' || !native.adminFixtureId.trim() || native.adminFixtureId.length > 128) missing.push('native.adminFixtureId');
  if (typeof native.declarerUserId !== 'string' || !native.declarerUserId.trim() || native.declarerUserId.length > 128) missing.push('native.declarerUserId');
  if (!Array.isArray(native.expectations) || !native.expectations.length) missing.push('native.expectations');
  if (typeof native.journalPath !== 'string' || !native.journalPath) missing.push('native.journalPath');
  if (!config?.expectedSqlSha256 || CANDIDATES.some(name => !/^[0-9a-f]{64}$/.test(String(config.expectedSqlSha256[name] ?? '')))) missing.push('expectedSqlSha256');
  const stages = Array.isArray(native.expectations) ? native.expectations.map(item => item?.phase) : [];
  const absentStages = REQUIRED_STAGES.filter(phase => !stages.includes(phase));
  const recovery = Array.isArray(native.expectations) ? native.expectations.find(item => item?.phase === 'recover') : null;
  if (typeof recovery?.fundingSql !== 'string' || !recovery.fundingSql.trim()) missing.push('native.expectations.recover.fundingSql');
  return { complete: !missing.length && !absentStages.length, missing, absentStages, fields, stages };
}


/** Plain fixture DML only. This prevents transaction escape; it is not an arbitrary-SQL sandbox. */
export function assertNativeFixtureSql(text) {
  if (typeof text !== 'string' || !text.trim()) fail('NATIVE_FIXTURE_SQL_REQUIRED');
  const allowed = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH']);
  let i = 0, first = '', content = false, statements = 0;
  const finish = () => { if (!content) return; if (!allowed.has(first)) fail('NATIVE_FIXTURE_DML_ONLY'); statements++; first = ''; content = false; };
  while (i < text.length) {
    if (/\s/.test(text[i])) { i++; continue; }
    if (text.startsWith('--', i)) { const end = text.indexOf('\n', i + 2); i = end < 0 ? text.length : end + 1; continue; }
    if (text.startsWith('/*', i)) {
      let depth = 1; i += 2;
      while (i < text.length && depth) { if (text.startsWith('/*', i)) { depth++; i += 2; } else if (text.startsWith('*/', i)) { depth--; i += 2; } else i++; }
      if (depth) fail('NATIVE_FIXTURE_SQL_UNTERMINATED');
      continue;
    }
    if (text[i] === ';') { finish(); i++; continue; }
    content = true;
    if (text[i] === "'" || text[i] === '"') {
      const quote = text[i], escaped = quote === "'" && /[eE]/.test(text[i - 1] ?? '') && !/[\w$]/.test(text[i - 2] ?? '');
      let closed = false; i++;
      while (i < text.length) {
        if (escaped && text[i] === '\\') { i += 2; continue; }
        if (text[i] === quote) { if (text[i + 1] === quote) { i += 2; continue; } i++; closed = true; break; }
        i++;
      }
      if (!closed) fail('NATIVE_FIXTURE_SQL_UNTERMINATED');
      continue;
    }
    if (text[i] === '$') {
      const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(text.slice(i))?.[0];
      if (tag) { const end = text.indexOf(tag, i + tag.length); if (end < 0) fail('NATIVE_FIXTURE_SQL_UNTERMINATED'); i = end + tag.length; continue; }
    }
    const word = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(i))?.[0];
    if (word) { if (!first) first = word.toUpperCase(); i += word.length; } else i++;
  }
  finish();
  if (!statements) fail('NATIVE_FIXTURE_SQL_REQUIRED');
  return statements;
}

export function resolveJournalPath(value) {
  const base = resolve(dirname(fileURLToPath(import.meta.url)), '../tmp');
  const output = resolve(value), child = relative(base, output);
  if (!child || child === '..' || child.startsWith('..' + (process.platform === 'win32' ? '\\' : '/')) || isAbsolute(child) || !/\.(jsonl|log)$/i.test(output)) fail('JOURNAL_PATH_OUTSIDE_TMP');
  for (let cursor = output; ; cursor = dirname(cursor)) {
    if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) fail('JOURNAL_PATH_REPARSE');
    if (relative(base, cursor) === '') break;
    if (dirname(cursor) === cursor) fail('JOURNAL_PATH_OUTSIDE_TMP');
  }
  return output;
}
export function nativeEarningKeys(plan) {
  return [...new Set([...(plan.native.stages.accrue.earningIds ?? []), ...plan.native.expectations.map(item => item.earningId).filter(Boolean)])].sort();
}
/** Static shape and sealing. Runs before any credential read or connection. */
export function sealedPlan(config, state, read) {
  if (config.schema !== 'distribution-pg-acceptance.v3' || config.host !== EXPECTED.host || config.port !== EXPECTED.port || config.database !== EXPECTED.database
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
  const contract = nativeContract(config);
  if (contract.absentStages.length) fail('NATIVE_STAGES_INCOMPLETE', { absent: contract.absentStages, required: REQUIRED_STAGES });
  if (contract.missing.length) fail('SEALED_INPUT_INCOMPLETE', { missing: contract.missing, format: contract.fields });
  const sql = CANDIDATES.map(name => {
    const path = resolve(config.candidateDir, name), bytes = read(path), text = bytes.toString('utf8'), digest = sha256(bytes);
    if (/(^|\n)\s*(BEGIN|COMMIT)\s*;/i.test(text)) fail('CANDIDATE_HAS_TRANSACTION_WRAPPER', name);
    if (digest !== config.expectedSqlSha256[name]) fail('CANDIDATE_SQL_SEAL_MISMATCH', { name, expected: config.expectedSqlSha256[name], actual: digest });
    return { name, path, text, digest };
  });
  const path = resolve(config.candidateDir, config.native.file), bytes = read(path), digest = sha256(bytes);
  if (digest !== config.native.expectedSha256) fail('NATIVE_FIXTURE_SEAL_MISMATCH', { expected: config.native.expectedSha256, actual: digest });
  assertNativeFixtureSql(bytes.toString('utf8'));
  const collectionPath = resolve(config.candidateDir, config.native.collectionDocument), collectionBytes = read(collectionPath);
  if (sha256(collectionBytes) !== config.native.expectedCollectionSha256) fail('NATIVE_COLLECTION_SEAL_MISMATCH');
  const stages = {};
  for (const item of config.native.expectations) {
    if (!item?.phase || !item.case) fail('NATIVE_STAGE_SHAPE_INVALID', item);
    if (stages[item.phase]) fail('NATIVE_STAGE_DUPLICATED', item.phase);
    stages[item.phase] = item;
  }
  const absentStages = REQUIRED_STAGES.filter(phase => !stages[phase]);
  if (absentStages.length) fail('NATIVE_STAGES_INCOMPLETE', { absent: absentStages, required: REQUIRED_STAGES });
  assertNativeFixtureSql(stages.recover.fundingSql);
  if (!Array.isArray(stages.accrue.earningIds) || stages.accrue.earningIds.length !== stages.accrue.items || new Set(stages.accrue.earningIds).size !== stages.accrue.items || stages.accrue.earningIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(id))) fail('NATIVE_EARNING_KEYS_REQUIRED');
  if (stages.recover.earningId !== stages['revoke-insufficient'].earningId) fail('RECOVERY_ORIGINAL_ROOT_MISMATCH');
  const native = { path, digest, sql: bytes.toString('utf8'), collectionPath, collectionDocument: collectionBytes.toString('utf8'), collectionDigest: sha256(collectionBytes),
    adminFixtureId: config.native.adminFixtureId, declarerUserId: config.native.declarerUserId, journalPath: resolveJournalPath(config.native.journalPath), expectations: config.native.expectations, stages };
  return { sql, native, contract };
}

/** Catalog facts, not self-declared config: role names, real OIDs, privilege shape, foreign sessions. */
export async function verifyIdentity(owner, target, config) {
  const database = (await owner.query(`SELECT d.oid::text AS oid,shobj_description(d.oid,'pg_database') AS marker,pg_get_userbyid(d.datdba) AS owner,d.datallowconn AS allow,d.datistemplate AS template
    FROM pg_database d WHERE d.datname=$1`, [config.database])).rows[0];
  if (!database || database.oid !== String(config.resourceOid) || database.marker !== config.marker || database.owner !== config.ownerUser
    || database.allow !== true || database.template !== false) fail('DATABASE_IDENTITY_MISMATCH', database);
  const names = [config.ownerUser, config.migrationUser, config.runtimeUser];
  const rows = (await owner.query(`SELECT rolname AS name,oid::text AS oid,rolsuper AS super,rolbypassrls AS bypass,rolcanlogin AS login,rolcreatedb AS createdb,rolinherit AS inherit,rolcreaterole AS createrole,rolreplication AS replication
    FROM pg_roles WHERE rolname=ANY($1::text[])`, [names])).rows;
  if (rows.length !== names.length) fail('REGISTERED_ROLE_ABSENT', { expected: names, found: rows.map(row => row.name) });
  const byName = new Map(rows.map(row => [row.name, row]));
  for (const entry of ['migrationUser', 'runtimeUser']) {
    const role = byName.get(config[entry]);
    if (role.super === true || role.bypass === true || role.createdb === true || role.inherit === true || role.createrole === true || role.replication === true) fail('ROLE_PRIVILEGE_ESCALATION', entry);
    if (role.login !== true) fail('ROLE_CANNOT_LOGIN', entry);
  }
  if (byName.get(config.migrationUser).oid !== String(config.roles.migrationOid) || byName.get(config.runtimeUser).oid !== String(config.roles.runtimeOid)) fail('REGISTERED_ROLE_OID_DRIFT');
  // The runtime identity must not be able to become the owner or the migration maintenance role.
  const impersonates = (await owner.query('SELECT (pg_has_role($1,$2,$5) OR pg_has_role($1,$3,$5) OR pg_has_role($1,$4,$5)) AS member',
    [config.runtimeUser, config.ownerUser, config.migrationUser, database.owner, 'MEMBER'])).rows[0].member;
  if (impersonates === true) fail('RUNTIME_IMPERSONATES_OWNER');
  const memberships = (await owner.query('SELECT count(*)::int AS n FROM pg_auth_members WHERE member=$1', [byName.get(config.runtimeUser).oid])).rows[0]?.n;
  if (Number(memberships) !== 0) fail('RUNTIME_MEMBERSHIP_CONTRACT_MISMATCH');
  // Business relations are catalog objects of the TARGET database, never of the maintenance database.
  const runtimeOwns = (await target.query('SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relowner=$1 AND n.nspname=$2',
    [byName.get(config.runtimeUser).oid, 'zzsh_order'])).rows[0].n;
  if (Number(runtimeOwns) > 0) fail('RUNTIME_OWNS_BUSINESS_RELATIONS', { runtimeOwns: Number(runtimeOwns) });
  // SET LOCAL ROLE is only usable when the migration session is actually a member of runtime.
  const canSetRole = (await target.query('SELECT pg_has_role(current_user,$1,$2) AS member', [config.runtimeUser, 'MEMBER'])).rows[0].member;
  if (canSetRole !== true) fail('RUNTIME_SET_ROLE_UNAVAILABLE', 'the registered migration session is not a member of the runtime role');
  const others = (await owner.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1 AND backend_type='client backend' AND pid<>pg_backend_pid()", [config.database])).rows[0].n;
  if (Number(others) !== 1) fail('FOREIGN_SESSION_PRESENT', { others: Number(others), expected: 1 });
  await target.query('BEGIN READ ONLY');
  try {
    await target.query(`SET LOCAL ROLE ${config.runtimeUser}`);
    if ((await target.query('SELECT current_user AS role')).rows[0]?.role !== config.runtimeUser) fail('RUNTIME_SET_ROLE_READBACK_MISMATCH');
  } finally { await target.query('ROLLBACK'); }
  return { database, roles: Object.fromEntries([...byName].map(([name, row]) => [name, { oid: row.oid, super: row.super, bypass: row.bypass }])), canSetRole: true };
}

/** The exact objects this package redefines, so the rollback comparison is not a row count. */
export async function snapshot(client) {
  return {
    counts: (await client.query(`SELECT (SELECT count(*)::int FROM zzsh_order.distribution_policy_version) AS versions,
      (SELECT count(*)::int FROM zzsh_order.distribution_policy_head) AS heads,(SELECT count(*)::int FROM zzsh_order.distribution_participant) AS participants,
      (SELECT count(*)::int FROM zzsh_order.invitation_relation) AS relations,(SELECT count(*)::int FROM zzsh_order.rental_referral_earning) AS earnings,
      (SELECT count(*)::int FROM zzsh_order.rental_referral_reversal_source) AS declarations,(SELECT count(*)::int FROM zzsh_supply.idempotency_record) AS receipts`)).rows[0],
    definitions: (await client.query(`SELECT p.oid::regprocedure::text AS signature,pg_get_functiondef(p.oid) AS body,coalesce((SELECT array_agg(DISTINCT a.*)::text FROM aclexplode(p.proacl) a),'(default)') AS acl
      FROM pg_proc p WHERE p.pronamespace='zzsh_order'::regnamespace
        AND p.proname IN ('distribution_policy_contract_version','guard_distribution_participant','guard_distribution_policy_version','guard_distribution_policy_head','guard_referral_reversal_declaration','derive_payment_referral_inputs','guard_payment_distribution_basis','guard_earning_entry')
      ORDER BY 1`)).rows,
    constraints: (await client.query(`SELECT conname AS name,pg_get_constraintdef(oid) AS definition FROM pg_constraint
      WHERE connamespace='zzsh_order'::regnamespace AND conrelid IN ('zzsh_order.distribution_policy_version'::regclass,'zzsh_order.distribution_policy_head'::regclass,'zzsh_order.distribution_participant'::regclass,'zzsh_order.invitation_relation'::regclass,'zzsh_order.rental_referral_reversal_source'::regclass,'zzsh_order.rental_referral_earning'::regclass) ORDER BY conrelid::regclass::text,conname`)).rows,
    heads: (await client.query('SELECT scope,revision,current_version_id FROM zzsh_order.distribution_policy_head ORDER BY scope')).rows,
  };
}

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
/** Every statement is bounded; a stage that cannot finish cannot hold the maintenance session open. */
async function inTxn(client, run) {
  await client.query('BEGIN');
  await client.query("SET LOCAL statement_timeout='15s'");
  await client.query("SET LOCAL lock_timeout='2s'");
  await client.query("SET LOCAL standard_conforming_strings=on");
  return run();
}
const journal = (path, entry) => {
  try { mkdirSync(dirname(path), { recursive: true }); appendFileSync(path, JSON.stringify(entry) + '\n', { flush: true }); }
  catch { fail('JOURNAL_WRITE_FAILED'); }
};

/**
 * Structure, then the SHARED privilege steps, then the effective runtime ACL - all inside the one
 * migration transaction that will be rolled back. The runtime readback has to see this uncommitted DDL,
 * which is why no second connection is opened.
 */
export async function structurePhase(client, plan, config, ledger, assembly) {
  for (const file of plan.sql) await client.query(file.text);
  ledger.pass('CANDIDATES_APPLIED_IN_ONE_TRANSACTION', plan.sql.map(file => file.digest));
  ledger.require((await client.query("SELECT to_regprocedure('zzsh_order.distribution_policy_contract_version()') IS NOT NULL AS present")).rows[0].present === true, 'CONTRACT_FUNCTION_PRESENT');
  // The marker is created with REVOKE PUBLIC; only the application's own shared ACL steps grant runtime.
  if (typeof assembly?.applyRuntimePrivileges !== 'function' || typeof assembly?.configureDistributionFinancialPrivileges !== 'function') {
    ledger.incomplete('ACL_ASSEMBLY_UNAVAILABLE', 'load the shared runtime privilege and distribution financial ACL steps from the built API');
  }
  const session = { query: (sql, params) => client.query(sql, params) };
  await assembly.applyRuntimePrivileges(session, config.runtimeUser);
  await assembly.configureDistributionFinancialPrivileges(session, config.runtimeUser);
  ledger.pass('SHARED_RUNTIME_PRIVILEGES_APPLIED', { runtimeUser: config.runtimeUser });
  const granted = (await client.query(`SELECT has_function_privilege($1,'zzsh_order.distribution_policy_contract_version()','EXECUTE') AS runtime_exec,
    NOT EXISTS(SELECT 1 FROM pg_proc p, aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE p.oid='zzsh_order.distribution_policy_contract_version()'::regprocedure AND a.grantee=0 AND a.privilege_type='EXECUTE') AS public_closed`,
    [config.runtimeUser])).rows[0];
  ledger.require(granted?.runtime_exec === true && granted?.public_closed === true, 'CONTRACT_ACL_EFFECTIVE', granted);
  await client.query('SAVEPOINT runtime_acl_role');
  await client.query(`SET LOCAL ROLE ${config.runtimeUser}`);
  try {
    const read = await client.query('SELECT current_user AS role, zzsh_order.distribution_policy_contract_version() AS version');
    ledger.require(read.rows[0].role === config.runtimeUser && Number(read.rows[0].version) === 2, 'RUNTIME_CONTRACT_EXECUTE_READBACK', read.rows[0]);
    const declared = await client.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='zzsh_order' AND c.relname='rental_referral_reversal_source' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=$1)`, [config.migrationUser]).then(result => result.rows[0]).catch(error => error);
    ledger.require(Number(declared?.n) === 1, 'DECLARATION_OWNER_IS_MIGRATION_SESSION', declared);
    await rejected(client, 'runtime_declaration', "INSERT INTO zzsh_order.rental_referral_reversal_source(id,earning_id,scope,basis_digest,amount_cents,canonical_source,source_digest,approval_digest,created_by_admin_id,reason) VALUES('p','p','NATIVE',repeat('b',64),'1','{}',repeat('c',64),repeat('a',64),'p','p')", [], { sqlstate: '42501' }, ledger, 'RUNTIME_REVERSAL_DECLARATION_DENIED');
    await rejected(client, 'runtime_seed', "UPDATE zzsh_order.rental_referral_earning SET canonical_seed='{}' WHERE id='probe'", [], { sqlstate: '42501' }, ledger, 'RUNTIME_PROTECTED_EARNING_SOURCE_DENIED');
    await client.query('RESET ROLE'); await client.query('RELEASE SAVEPOINT runtime_acl_role');
  } catch (error) {
    try { await client.query('ROLLBACK TO SAVEPOINT runtime_acl_role'); await client.query('RESET ROLE'); await client.query('RELEASE SAVEPOINT runtime_acl_role'); } catch { /* outer rollback owns an unusable transaction */ }
    throw error;
  }
}

export async function policyPhase(client, config, plan, ledger) {
  const adminId = plan.native.adminFixtureId;
  const security = (await client.query('SELECT admin_user_id AS id, status, is_boss AS isBoss FROM zzsh_iam.admin_security WHERE admin_user_id=$1', [adminId])).rows[0];
  if (!security || security.status !== 'ACTIVE') ledger.incomplete('ADMIN_FIXTURE_NOT_ACTIVE', { adminId, status: security?.status ?? 'absent' });
  const version = (patch) => canonical({ schema: 'distribution-policy.v2', scope: 'NATIVE', enabled: false, participation: 'AUTO_AT_REGISTRATION', depth: 1, selfRebate: false,
    accountModes: ['ordinary', 'custom'], minimumAccrualCents: '0', settlementDelayDays: 7, rateMode: 'UNIFORM', renterPercent: '5', ownerPercent: '5', levels: [], ...patch });
  const insert = `INSERT INTO zzsh_order.distribution_policy_version(id,revision,scope,schema_version,canonical_config,config_digest,created_by_admin_id) VALUES($1,1,'NATIVE','distribution-policy.v2',$2,$3,$4)`;
  const over = version({ renterPercent: '60', ownerPercent: '60' });
  await rejected(client, 'rate_cap', insert, ['probe_rate_cap', over, sha256(over), adminId], { sqlstate: '23514', constraint: 'uniform' }, ledger, 'UNIFORM_RATE_GUARD');
  await rejected(client, 'shape', insert, ['probe_shape', version({ schema: 'distribution-policy.v1', levels: [] }), sha256(version({ schema: 'distribution-policy.v1', levels: [] })), adminId], { sqlstate: '23514' }, ledger, 'V2_SCHEMA_REJECTS_V1_CONFIG');
  ledger.pass('POLICY_SYNTHETIC_RATES_ONLY', { note: '5/5 and 0/60+60 are structural probes, not an operating decision' });
  const heads = (await client.query("SELECT count(*)::int AS n FROM zzsh_order.distribution_policy_head WHERE scope='NATIVE'")).rows[0].n;
  if (Number(heads) > 0) return ledger.pass('V2_NATIVE_HEAD_PREEXISTING', { heads });
  const good = version({});
  await client.query(insert, ['probe_v2', good, sha256(good), adminId]);
  await client.query("INSERT INTO zzsh_order.distribution_policy_head(scope,revision,current_version_id) VALUES('NATIVE',1,'probe_v2')");
  ledger.require((await client.query("SELECT current_version_id FROM zzsh_order.distribution_policy_head WHERE scope='NATIVE'")).rows[0]?.current_version_id === 'probe_v2', 'V2_NATIVE_POLICY_ACCEPTED');
  return 'installed';
}

/**
 * The native funds chain on the application's own code path, inside the same rolled-back assembly.
 * Money bodies run as the registered runtime role; the reversal declaration runs as the table owner.
 * Each stage appends a journal entry before the next one starts, so a mid-chain failure still shows
 * which original keys were applied and which never ran. Nothing commits, so no committed object can be
 * lost - the receipt says assembly:'rollback-only' rather than pretending a durable cleanup.
 */
export async function fundsPhase(client, config, plan, ledger, store) {
  const stages = plan.native.stages, created = { orders: [], earnings: [], declarations: [] }, journalPath = plan.native.journalPath;
  if (!store || typeof store.accrueOn !== 'function' || typeof store.transitionOn !== 'function') ledger.incomplete('API_STORE_UNAVAILABLE', 'build the API workspace and brand the sealed collection admission');
  const requestId = 'acceptance_' + plan.native.digest.slice(0, 16);
  const pool = { connect: async () => ({ query: (sql, params) => client.query(sql, params), release() { /* one session for the whole assembly */ } }) };
  journal(journalPath, { assembly: 'rollback-only', request: requestId, fixture: plan.native.digest, startedAt: new Date().toISOString() });
  const stage = async (phase, run) => {
    const expectation = stages[phase];
    try { const value = await run(expectation); journal(journalPath, { phase, case: expectation.case, status: 'APPLIED', detail: value ?? null }); ledger.pass('STAGE_' + phase.toUpperCase().replace(/-/g, '_'), value ?? true); return value; }
    catch (error) {
      try { journal(journalPath, { phase, case: expectation.case, status: 'UNKNOWN', errorCode: error?.code ?? 'FAILED' }); } catch { ledger.checks.push({check:'FAIL',code:'STAGE_JOURNAL_UNAVAILABLE'}); }
      throw error;
    }
  };
  const asRuntime = async (body) => {
    await client.query('SAVEPOINT native_money');
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await client.query(`SET LOCAL ROLE ${config.runtimeUser}`);
    try { const value = await body(); await client.query('RESET ROLE'); await client.query('RELEASE SAVEPOINT native_money'); return value; }
    catch (error) {
      // Recover the transaction and its previous role before rethrowing the original SQL error.
      try { await client.query('ROLLBACK TO SAVEPOINT native_money'); await client.query('RESET ROLE'); await client.query('RELEASE SAVEPOINT native_money'); } catch { /* outer rollback owns an unusable transaction */ }
      throw error;
    }
  };
  await stage('fixture', async () => {
    await asRuntime(async () => { await client.query(plan.native.sql); await client.query('SET CONSTRAINTS ALL IMMEDIATE'); });
    return { sqlSha256: plan.native.digest };
  });
  const accrue = stages.accrue;
  await stage('accrue', async () => {
    const result = await asRuntime(() => store.accrueOn(client, accrue.orderId, requestId));
    const items = result?.items ?? [];
    ledger.require(result.knowledge === 'KNOWN' && items.length === accrue.items && items.length > 0 && items.every(item => item.replayed !== true), 'NATIVE_ACCRUAL_ITEMS', { case: accrue.case, items: items.length });
    ledger.require(canonical(items.map(item => item.root.id).sort()) === canonical([...accrue.earningIds].sort()), 'NATIVE_ORIGINAL_EARNING_KEYS');
    for (const item of items) { created.earnings.push(item.root.id);
      ledger.require(String(item.root.amountCents) === accrue.amounts[item.root.role] && item.root.state === 'PENDING', 'NATIVE_ACCRUAL_FACTS', { case: accrue.case, role: item.root.role, amount: item.root.amountCents }); }
    return { earningIds: items.map(item => item.root.id) };
  });
  const replay = stages['accrue-replay'];
  await stage('accrue-replay', async () => {
    const again = await asRuntime(() => store.accrueOn(client, replay.orderId, requestId + '_replay'));
    const rows = (await client.query('SELECT count(*)::int AS n FROM zzsh_order.rental_referral_earning WHERE order_id=$1', [replay.orderId])).rows[0].n;
    ledger.require(again.knowledge === 'KNOWN' && again.items.every(item => item.replayed === true) && Number(rows) === replay.items, 'NATIVE_ACCRUAL_IDEMPOTENT', { case: replay.case, rows: Number(rows) });
    return { rows: Number(rows) };
  });
  const notDue = stages['settle-not-due'];
  await stage('settle-not-due', async () => {
    const earning = (await client.query('SELECT id,version::text AS version,state FROM zzsh_order.rental_referral_earning WHERE id=$1', [notDue.earningId])).rows[0];
    ledger.require(earning?.state === 'PENDING', 'NATIVE_SETTLE_NEGATIVE_ROOT_PENDING', { case: notDue.case, state: earning?.state });
    const error = await asRuntime(() => store.transitionOn(client, earning.id, 'SETTLE', earning.version, requestId)).catch(caught => caught);
    ledger.require(error?.code === 'CONFLICT' && /not due/i.test(String(error?.message)), 'NATIVE_SETTLE_BEFORE_DUE_REJECTED', { case: notDue.case, code: error?.code ?? 'accepted', message: error?.message ?? null });
    return { code: error.code };
  });
  const settle = stages.settle;
  await stage('settle', async () => {
    const earning = (await client.query('SELECT id,version::text AS version FROM zzsh_order.rental_referral_earning WHERE id=$1', [settle.earningId])).rows[0];
    const result = await asRuntime(() => store.transitionOn(client, earning.id, 'SETTLE', earning.version, requestId));
    const credit = (await client.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_ledger_entry e JOIN zzsh_order.finance_event f ON f.id=e.finance_event_id
      WHERE f.economic_root_id=$1 AND e.account_code='WALLET_AVAILABLE' AND e.credit_cents>0`, [earning.id])).rows[0].n;
    const replayed = await asRuntime(() => store.transitionOn(client, earning.id, 'SETTLE', String(BigInt(earning.version) + 1n), requestId + '_replay'));
    ledger.require(result.root.state === 'SETTLED' && Number(credit) === 1 && replayed.replayed === true, 'NATIVE_SETTLE_CREDITS_AVAILABLE_ONCE', { case: settle.case, credit: Number(credit), replayed: replayed.replayed });
    return { credit: Number(credit) };
  });
  const declaration = async (phase) => {
    const expectation = stages[phase];
    const earning = (await client.query('SELECT e.id,e.order_id,e.amount_cents::text,e.basis_digest,e.state,o.game_id FROM zzsh_order.rental_referral_earning e JOIN zzsh_order.rental_order o ON o.id=e.order_id WHERE e.id=$1', [expectation.earningId])).rows[0];
    ledger.require(!!earning && ['SETTLED', 'PENDING'].includes(earning.state), 'NATIVE_DECLARATION_REQUIRES_ORIGINAL_ROOT', { case: expectation.case, state: earning?.state ?? 'absent' });
    const admission = (await client.query('SELECT mode,approval_digest FROM zzsh_order.distribution_order_admission WHERE order_id=$1', [earning.order_id])).rows[0];
    ledger.require(admission?.mode === 'NATIVE' && /^[0-9a-f]{64}$/.test(admission.approval_digest ?? ''), 'NATIVE_ORIGINAL_ADMISSION_REQUIRED');
    const source = canonical({ schema: 'rental-referral-reversal.v1', scope: 'NATIVE', earningId: earning.id, basisDigest: earning.basis_digest, amountCents: String(earning.amount_cents) });
    const id = 'reversal_' + sha256(canonical(['NATIVE', earning.id])).slice(0, 40);
    await client.query(`INSERT INTO zzsh_order.rental_referral_reversal_source(id,earning_id,scope,basis_digest,amount_cents,canonical_source,source_digest,approval_digest,created_by_admin_id,reason)
      VALUES($1,$2,'NATIVE',$3,$4,$5,$6,$7,$8,$9)`, [id, earning.id, earning.basis_digest, String(earning.amount_cents), source, sha256(source), admission.approval_digest, plan.native.declarerUserId, expectation.reason]);
    created.declarations.push(id);
    return { id, earning };
  };
  const revokeSufficient = stages['revoke-sufficient'];
  await stage('revoke-sufficient', async () => {
    const { id, earning } = await declaration('revoke-sufficient');
    const version = (await client.query('SELECT version::text AS version FROM zzsh_order.rental_referral_earning WHERE id=$1', [earning.id])).rows[0].version;
    const result = await asRuntime(() => store.transitionOn(client, earning.id, 'REVOKE', version, requestId, id));
    ledger.require(result.root.state === 'REVOKED', 'NATIVE_REVOKE_SUFFICIENT_STATE', { case: revokeSufficient.case, state: result.root.state });
    return { sourceId: id };
  });
  const revokeInsufficient = stages['revoke-insufficient'];
  await stage('revoke-insufficient', async () => {
    const { id, earning } = await declaration('revoke-insufficient');
    const version = (await client.query('SELECT version::text AS version FROM zzsh_order.rental_referral_earning WHERE id=$1', [earning.id])).rows[0].version;
    const result = await asRuntime(() => store.transitionOn(client, earning.id, 'REVOKE', version, requestId, id));
    const fakeDebit = (await client.query(`SELECT count(*)::int AS n FROM zzsh_order.settlement_ledger_entry e JOIN zzsh_order.finance_event f ON f.id=e.finance_event_id
      WHERE f.economic_root_id=$1 AND e.account_code='WALLET_AVAILABLE' AND e.debit_cents>0`, [earning.id])).rows[0].n;
    ledger.require(result.root.state === 'RECOVERY_REQUIRED' && result.root.recoveryRequiredCents === result.root.amountCents && Number(fakeDebit) === 0, 'NATIVE_INSUFFICIENT_OBLIGATION_WITHOUT_FAKE_DEBIT',
      { case: revokeInsufficient.case, state: result.root.state, fakeDebit: Number(fakeDebit) });
    return { sourceId: id };
  });
  const recover = stages.recover;
  await stage('recover', async () => {
    const expectation = recover;
    if (expectation.earningId !== stages['revoke-insufficient'].earningId) fail('RECOVERY_ORIGINAL_ROOT_MISMATCH');
    const sourceId = created.declarations.at(-1);
    if (expectation.reversalSourceId && expectation.reversalSourceId !== sourceId) fail('RECOVERY_ORIGINAL_SOURCE_MISMATCH');
    const row = (await client.query('SELECT id,version::text AS version,state,recovery_required_cents::text AS obligation FROM zzsh_order.rental_referral_earning WHERE id=$1', [expectation.earningId])).rows[0];
    ledger.require(row?.state === 'RECOVERY_REQUIRED' && row.obligation === expectation.amountCents, 'NATIVE_RECOVER_REQUIRES_ORIGINAL_OBLIGATION', { case: expectation.case, state: row?.state });
    assertNativeFixtureSql(expectation.fundingSql);
    await client.query('SET CONSTRAINTS ALL DEFERRED');
    await asRuntime(async () => { await client.query(expectation.fundingSql); await client.query('SET CONSTRAINTS ALL IMMEDIATE'); });
    const funded = (await client.query('SELECT id,version::text AS version,state,recovery_required_cents::text AS obligation FROM zzsh_order.rental_referral_earning WHERE id=$1', [expectation.earningId])).rows[0];
    ledger.require(funded?.state === 'RECOVERY_REQUIRED' && funded.version === row.version && funded.obligation === row.obligation, 'RECOVERY_FUNDING_CANNOT_CHANGE_ORIGINAL_DEBT');
    journal(journalPath, { phase: 'recover-funding', case: expectation.case, status: 'APPLIED', earningId: row.id, sourceId, sqlSha256: sha256(expectation.fundingSql) });
    const result = await asRuntime(() => store.transitionOn(client, row.id, 'RECOVER', row.version, requestId, sourceId));
    ledger.require(result.replayed !== true && result.root.state === 'REVOKED' && result.root.recoveryRequiredCents === null, 'NATIVE_RECOVER_CLOSES_OBLIGATION', { case: expectation.case });
    return { state: result.root.state };
  });
  for (const expectation of plan.native.expectations) if (expectation.orderId) created.orders.push(expectation.orderId);
  return created;
}

/** Read-only residue check. Financial evidence is immutable; the registered reset owns any rebuild. */
export async function residuePhase(client, keys, ledger) {
  const rows = (await client.query(`SELECT $1::text[] AS earning_ids, (SELECT count(*)::int FROM zzsh_order.rental_referral_earning WHERE id=ANY($1::text[])) AS earnings,
    (SELECT count(*)::int FROM zzsh_order.rental_referral_reversal_source WHERE earning_id=ANY($1::text[])) AS declarations,
    (SELECT count(*)::int FROM zzsh_order.settlement_ledger_entry WHERE details->>'earningId' = ANY($1::text[])) AS entries`, [keys.earnings ?? []])).rows[0];
  const residual = { earnings: Number(rows.earnings), declarations: Number(rows.declarations), entries: Number(rows.entries) };
  if (residual.earnings || residual.declarations || residual.entries) {
    ledger.checks.push({ check: 'INCOMPLETE', code: 'RESIDUE_REQUIRES_REGISTERED_RESET', detail: { ...residual, keys } });
    fail('RESIDUE_REQUIRES_REGISTERED_RESET', { residual, keys, sanctioned: 'npm run test:db:reset -w @zzsh/api (apps/api/scripts/regression-reset.mjs)' });
  }
  ledger.pass('NO_NATIVE_RESIDUE', residual);
  return residual;
}

export async function run(options) {
  const { config, plan, connect, log = console, exit = code => { process.exitCode = code; }, loadAssembly = async () => null, journalWrite = journal } = options;
  const mode = options.restore ? 'RESTORE_CHECK' : options.fullNative ? 'FULL_NATIVE' : options.execute ? 'STRUCTURE_ROLLBACK' : options.identity ? 'VERIFY_IDENTITY' : 'PLAN';
  const ledger = createLedger();
  const receipt = { schema: 'distribution-pg-acceptance-receipt.v2', mode, assembly: 'rollback-only', host: EXPECTED.host, port: EXPECTED.port, database: config.database,
    resourceOid: String(config.resourceOid), sql: plan.sql.map(file => ({ name: file.name, sha256: file.digest })),
    nativeFixture: { sha256: plan.native.digest, collectionDocument: plan.native.collectionDigest, stages: plan.native.expectations.map(item => item.phase), journal: plan.native.journalPath } };
  if (mode === 'PLAN') {
    log.log(JSON.stringify({ ...receipt, pass: true, readsSecrets: false, connections: 0, checksPlanned: ['IDENTITY_AND_SET_ROLE', 'STRUCTURE_AND_SHARED_ACL', 'POLICY_GUARDS', 'NATIVE_FUNDS_STAGES', 'RESIDUE_CHECK'],
      nativeContract: { complete: plan.contract.complete, missing: plan.contract.missing, absentStages: plan.contract.absentStages, format: plan.contract.fields } }));
    return receipt;
  }
  const owner = connect(config.ownerUser, 'postgres', 'DISTRIBUTION_OWNER_PASSWORD_FILE');
  const target = connect(config.migrationUser, config.database, 'DISTRIBUTION_MIGRATION_PASSWORD_FILE');
  let locked = false, unlocked = null, began = false, rolledBack = null, targetEnded = null, ownerEnded = null, primary = null, success = null;
  try {
    const assembly = mode === 'VERIFY_IDENTITY' || mode === 'RESTORE_CHECK' ? null : await loadAssembly(config, plan);
    await owner.connect();
    locked = (await owner.query('SELECT pg_try_advisory_lock($1::bigint) AS acquired', [Number(EXPECTED.lockKey)])).rows[0].acquired === true;
    if (!locked) fail('MAINTENANCE_LOCK_BUSY');
    await target.connect();
    const nonce = (await target.query("SELECT current_database() AS database,current_user AS role,current_setting('zzsh.regression_run',true) AS nonce")).rows[0];
    if (nonce.database !== config.database || nonce.role !== config.migrationUser || nonce.nonce !== config.nonce) fail('TARGET_NONCE_AND_ROLE_MISMATCH', nonce);
    ledger.pass('TARGET_SESSION_REGISTERED', nonce);
    await verifyIdentity(owner, target, config);
    ledger.pass('REGISTERED_IDENTITY_ROLES_AND_SET_ROLE');
    if (mode === 'VERIFY_IDENTITY') {
      success = { ...receipt, pass: true, checks: ledger.checks };
      return receipt;
    }
    if (mode === 'RESTORE_CHECK') {
      const keys = nativeEarningKeys(plan);
      if (!keys.length || options.residueKeys && canonical([...(options.residueKeys.earnings ?? [])].sort()) !== canonical(keys)) fail('RESTORE_ORIGINAL_KEYS_REQUIRED');
      await residuePhase(target, { earnings: keys }, ledger);
      success = { ...receipt, pass: true, checks: ledger.checks };
      return receipt;
    }
    began = true;
    const before = await snapshot(target);
    await inTxn(target, async () => {
      await structurePhase(target, plan, config, ledger, assembly);
      await policyPhase(target, config, plan, ledger);
      if (mode === 'FULL_NATIVE') journalWrite(plan.native.journalPath, { phase: 'policy', case: plan.native.stages.policy.case, status: 'APPLIED', assembly: 'rollback-only' });
      if (mode === 'FULL_NATIVE') {
        const store = assembly?.earnings;
        if (!store) ledger.incomplete('API_STORE_UNAVAILABLE', 'the sealed collection admission or the built API is missing');
        journalWrite(plan.native.journalPath, { mode: 'FULL_NATIVE', identity: 'registered', nonce: config.nonce });
        const created = await fundsPhase(target, config, plan, ledger, store);
        ledger.pass('NATIVE_CHAIN_APPLIED_WITHOUT_COMMIT', { created });
      }
      await target.query('SET CONSTRAINTS ALL IMMEDIATE');
      await target.query('ROLLBACK'); began = false; rolledBack = true;
    });
    const after = await snapshot(target);
    if (JSON.stringify(before) !== JSON.stringify(after)) fail('ROLLBACK_DID_NOT_RESTORE_DEFINITIONS_CONSTRAINTS_HEADS_OR_ROWS', { before, after });
    ledger.pass('ROLLBACK_RESTORED_DEFINITIONS_CONSTRAINTS_HEADS_AND_ROWS');
    await residuePhase(target, { earnings: mode === 'FULL_NATIVE' ? nativeEarningKeys(plan) : [] }, ledger);
    success = { ...receipt, pass: true, checks: ledger.checks, cleanup: { began, rolledBack } };
    return receipt;
  } catch (error) {
    primary = error;
    if (began) { try { await target.query('ROLLBACK'); rolledBack = true; } catch { rolledBack = false; } }
    try { journalWrite?.(plan.native.journalPath, { status: 'FAILED', code: error.code ?? 'FAILED', incomplete: error.incomplete === true, rolledBack, at: new Date().toISOString() }); } catch { ledger.checks.push({ check: 'FAIL', code: 'FAILURE_JOURNAL_UNAVAILABLE' }); }
    log.error(JSON.stringify({ ...receipt, pass: false, code: error.code ?? 'FAILED', incomplete: error.incomplete === true, message: error.message, detail: error.detail ?? null, checks: ledger.checks, cleanup: { began, rolledBack } }));
    exit(error.incomplete === true ? 2 : 1);
    return receipt;
  } finally {
    try { await target.end(); targetEnded = true; } catch { targetEnded = false; }
    if (locked) { try { unlocked = (await owner.query('SELECT pg_advisory_unlock($1::bigint) AS released', [Number(EXPECTED.lockKey)])).rows[0].released === true; } catch { unlocked = false; } }
    try { await owner.end(); ownerEnded = true; } catch { ownerEnded = false; }
    const cleanupBad = targetEnded !== true || ownerEnded !== true || (locked && unlocked !== true);
    if (!primary && success) {
      if (cleanupBad) log.error(JSON.stringify({ ...success, pass: false, code: 'CLEANUP_UNKNOWN', cleanup: { locked, unlocked, began, rolledBack, targetEnded, ownerEnded } }));
      else log.log(JSON.stringify({ ...success, cleanup: { locked, unlocked, began, rolledBack, targetEnded, ownerEnded } }));
      if (cleanupBad) exit(1);
    } else if (primary) log.error(JSON.stringify({ code: 'CLEANUP_REPORT', locked, unlocked, began, rolledBack, targetEnded, ownerEnded, primary: primary.code ?? primary.message }));
  }
}

async function main() {
  const args = process.argv.slice(2), opt = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const configPath = opt('--config'), configSha = opt('--sha256');
  if (!configPath || !configSha) fail('SEALED_CONFIG_REQUIRED');
  const bytes = readFileSync(resolve(configPath));
  if (sha256(bytes) !== configSha) fail('CONFIG_SHA_MISMATCH');
  const config = JSON.parse(bytes.toString('utf8'));
  const contract = nativeContract(config);
  // An incomplete native contract is refused before a credential file is read or a socket is opened.
  if (!contract.complete && (args.includes('--full-native') || args.includes('--restore-regression'))) {
    console.error(JSON.stringify({ schema: 'distribution-pg-acceptance-receipt.v2', pass: false, incomplete: true, code: 'NATIVE_CONTRACT_INCOMPLETE', readsSecrets: false, connections: 0, missing: contract.missing, absentStages: contract.absentStages, format: contract.fields }));
    process.exitCode = 2;
    return;
  }
  const offlinePlan = !(args.includes('--execute') || args.includes('--verify-identity') || args.includes('--full-native') || args.includes('--restore-regression'));
  if (offlinePlan && !contract.complete) {
    // The pre-flight still has value without a native chain: report exactly what is missing, offline.
    console.log(JSON.stringify({ schema: 'distribution-pg-acceptance-receipt.v2', mode: 'PLAN', pass: true, readsSecrets: false, connections: 0,
      nativeContract: { complete: false, missing: contract.missing, absentStages: contract.absentStages, format: contract.fields },
      note: 'candidate sealing and every online mode need the complete contract above' }));
    return;
  }
  const plan = sealedPlan(config, JSON.parse(readFileSync(resolve(config.statePath), 'utf8')), path => readFileSync(path));
  const password = variable => { const file = process.env[variable]?.trim(); if (!file) fail(`${variable}_MISSING`); return readFileSync(resolve(file), 'utf8').trim(); };
  const distRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../apps/api/dist/src');
  const loadModule = async (relative) => import(pathToFileURL(resolve(distRoot, relative)).href);
  return run({ config, plan, execute: args.includes('--execute'), identity: args.includes('--verify-identity'),
    fullNative: args.includes('--full-native'), restore: args.includes('--restore-regression'),
    residueKeys: opt('--residue-keys') ? JSON.parse(opt('--residue-keys')) : null,
    connect: (user, database, variable) => {
      if (database !== EXPECTED.database && database !== 'postgres') fail('CONNECT_TARGET_UNEXPECTED', database);
      return new Client({ host: EXPECTED.host, port: EXPECTED.port, database, user, password: password(variable),
        connectionTimeoutMillis: 4000, statement_timeout: 15000, application_name: 'zzsh-distribution-acceptance' }); },
    // The shared ACL steps and the money path are the application's own compiled code.
    loadAssembly: async (activeConfig, activePlan) => {
      let migrations, store, runtime;
      try { migrations = await loadModule('database/business-migrations.js'); }
      catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') return null; throw error; }
      if (!activePlan) return { ...migrations, earnings: null };
      try { store = await loadModule('finance/distribution-earning-store.js'); runtime = await loadModule('order/joinpay-collection-runtime.js'); }
      catch (error) { if (error.code === 'ERR_MODULE_NOT_FOUND') return { ...migrations, earnings: null }; throw error; }
      const database = { name: activeConfig.database, user: activeConfig.runtimeUser, runtimeUser: activeConfig.runtimeUser };
      const assembly = runtime.loadJoinpayCollectionRuntime({ provider: 'real', authEnabled: true, database },
        { JOINPAY_COLLECTION_ENABLED: 'true', JOINPAY_COLLECTION_CONFIG: activePlan.native.collectionDocument });
      if (!assembly?.admission) fail('NATIVE_COLLECTION_ADMISSION_UNAVAILABLE');
      const earnings = store.createNativeDistributionEarningStore(assembly.admission);
      // The store checks the resource identity itself; the host records the same view for the receipt.
      return { ...migrations, earnings, admission: runtime.readFormalCollectionAdmission ? runtime.readFormalCollectionAdmission(assembly.admission) : null };
    } });
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) await main();
