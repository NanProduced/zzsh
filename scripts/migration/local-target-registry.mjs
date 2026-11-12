// One seam for "which local migration target am I writing to".
//
// The old path derived the target from a database-name literal duplicated across the scripts, and
// compared that literal with itself, so a wrong instance could never fail before the first write.
// A registered target now carries the PostgreSQL cluster identity (system_identifier) beside the
// database OID, marker and per-resource nonce, and every entry point must prove the live connection
// is that exact target before it opens a transaction.
//
// Legacy registries (no `instance` block) keep working against the fixed local instance so existing
// regression runs are unchanged; a registry that declares an instance must also declare the live
// system_identifier, because that is the only fact that separates two instances carrying the same
// database name, roles, marker and lock number.
import { strict as assert } from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const RESOURCE_FILE = "resource.json";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 55432;
export const DEFAULT_LOCK_KEY = "806006";
export const DEFAULT_MAINTENANCE_DATABASE = "postgres";
export const NEXT_MIGRATION_PROFILE = "LOCAL_MIGRATION_NEXT_V1";
export const NEXT_INITIAL_BASELINE = "release_production_0174";
export const sameMigrationProfile = (a,b) => (a?.migrationProfile ?? null) === (b?.migrationProfile ?? null);
export function assertCaptureTargetProfile(receipt, profile) {
  assert.equal(receipt?.sourceOrigin?.schema === "zzsh.local-source-origin.v2", profile === NEXT_MIGRATION_PROFILE, "TARGET_SOURCE_PROFILE_MISMATCH");
}
export function hasVerifiedNextInitialSchema(schema) {
  return schema?.status === "CLEAN_SCHEMA_INSTALLED" && schema.migrationProfile === NEXT_MIGRATION_PROFILE
    && schema.commitAck === true && schema.migrationAck === true && schema.runtimeAclReadback === true
    && schema.readbackRollbackAck === true && schema.readbackClientClosed === true && schema.unlockAck === true && schema.maintenanceClosed === true
    && schema.targetFence === "HELD_ACROSS_SCHEMA_AND_ACL" && schema.targetFenceReleased === true
    && schema.initialBaseline === NEXT_INITIAL_BASELINE
    && schema.initialSeedReadback?.status === "INITIAL_SEEDS_AND_COMMENTS_VERIFIED"
    && /^[a-f0-9]{64}$/.test(schema.initialBaselineManifestSha256 ?? "")
    && /^[a-f0-9]{64}$/.test(schema.initialTailSeedProofSha256 ?? "")
    && /^[a-f0-9]{40}$/.test(schema.releaseCommit ?? "");
}
const DATABASE = /^[a-z][a-z0-9_]{0,62}$/;
const MARKER = /^[a-z][a-z0-9:_-]{0,127}$/;
const ROLE = /^[a-z][a-z0-9_]{0,62}$/;
const NONCE = /^[a-f0-9]{24}$/;
const DIGITS = /^[0-9]+$/;

function registryPath(credentialsPath) {
  assert.equal(typeof credentialsPath, "string", "TARGET_CREDENTIALS_REQUIRED");
  assert.ok(credentialsPath.trim() !== "", "TARGET_CREDENTIALS_REQUIRED");
  return resolve(dirname(resolve(credentialsPath)), RESOURCE_FILE);
}

/** Read the registry beside `--credentials` without following a link or accepting a directory. */
export function loadRegisteredTarget(credentialsPath) {
  const file = registryPath(credentialsPath);
  const stat = lstatSync(file);
  assert.ok(stat.isFile() && !stat.isSymbolicLink(), "TARGET_RESOURCE_FILE_UNSAFE");
  let raw;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new Error("TARGET_RESOURCE_FILE_UNREADABLE");
  }
  return normalizeRegisteredTarget(raw, file);
}

/**
 * Validate and freeze a registry body. `instance` is optional for the historical fixed local
 * resource; when present it must pin the cluster identity, otherwise the target is ambiguous and
 * must be refused instead of guessed.
 */
export function normalizeRegisteredTarget(raw, source = RESOURCE_FILE) {
  assert.ok(raw && typeof raw === "object" && !Array.isArray(raw), "TARGET_RESOURCE_BODY_INVALID");
  const instance = raw.instance;
  const hasInstance = instance !== undefined && instance !== null;
  if (hasInstance) assert.ok(typeof instance === "object" && !Array.isArray(instance), "TARGET_INSTANCE_INVALID");
  const host = hasInstance ? (instance.host ?? DEFAULT_HOST) : DEFAULT_HOST;
  const port = hasInstance ? Number(instance.port ?? DEFAULT_PORT) : DEFAULT_PORT;
  const systemIdentifier = hasInstance ? instance.systemIdentifier ?? null : null;
  assert.equal(host, DEFAULT_HOST, "TARGET_HOST_MUST_BE_LOOPBACK");
  assert.ok(Number.isInteger(port) && port > 0 && port < 65536, "TARGET_PORT_INVALID");
  if (hasInstance) {
    assert.equal(typeof systemIdentifier, "string", "TARGET_INSTANCE_SYSTEM_IDENTIFIER_REQUIRED");
    assert.ok(DIGITS.test(systemIdentifier), "TARGET_INSTANCE_SYSTEM_IDENTIFIER_INVALID");
  }
  const database = raw.database;
  assert.ok(typeof database === "string" && DATABASE.test(database), "TARGET_DATABASE_INVALID");
  const marker = raw.marker;
  assert.ok(typeof marker === "string" && MARKER.test(marker), "TARGET_MARKER_INVALID");
  const oid = String(raw.oid ?? "");
  assert.ok(DIGITS.test(oid), "TARGET_OID_INVALID");
  const nonce = raw.nonce;
  assert.ok(typeof nonce === "string" && NONCE.test(nonce), "TARGET_NONCE_INVALID");
  const owner = raw.owner ?? null;
  if (owner !== null) assert.ok(typeof owner === "string" && /^[a-z][a-z0-9_]{0,62}$/.test(owner), "TARGET_OWNER_INVALID");
  const roles = raw.roles ?? {};
  const migrationRole = roles.migration?.name ?? roles.migration ?? raw.migrationRole;
  const runtimeRole = roles.runtime?.name ?? roles.runtime ?? raw.runtimeRole;
  assert.ok(typeof migrationRole === "string" && ROLE.test(migrationRole), "TARGET_MIGRATION_ROLE_INVALID");
  assert.ok(typeof runtimeRole === "string" && ROLE.test(runtimeRole), "TARGET_RUNTIME_ROLE_INVALID");
  assert.notEqual(migrationRole, runtimeRole, "TARGET_ROLES_MUST_DIFFER");
  if (owner !== null) assert.notEqual(migrationRole, owner, "TARGET_MIGRATION_ROLE_MUST_DIFFER_FROM_OWNER");
  // Role OIDs are optional evidence: a registry may record them after creation, and a caller that
  // has them must still compare them with the live connection.
  const roleOid = value => {
    if (value === undefined || value === null) return null;
    assert.ok(typeof value === "string" && DIGITS.test(value), "TARGET_ROLE_OID_INVALID");
    return value;
  };
  const migrationRoleOid = roleOid(roles.migration?.oid);
  const runtimeRoleOid = roleOid(roles.runtime?.oid);
  const lockKey = String(raw.lockKey ?? DEFAULT_LOCK_KEY);
  assert.ok(DIGITS.test(lockKey), "TARGET_LOCK_KEY_INVALID");
  const maintenanceDatabase = raw.maintenanceDatabase ?? DEFAULT_MAINTENANCE_DATABASE;
  assert.ok(typeof maintenanceDatabase === "string" && DATABASE.test(maintenanceDatabase), "TARGET_MAINTENANCE_DATABASE_INVALID");
  const protectedDataset = raw.protectedDataset ?? null;
  if (protectedDataset !== null) assert.ok(typeof protectedDataset === "object", "TARGET_PROTECTED_DATASET_INVALID");
  const pendingReset = raw.pendingReset ?? null;
  if (pendingReset !== null) assert.ok(typeof pendingReset === "object" && !Array.isArray(pendingReset), "TARGET_PENDING_RESET_INVALID");
  const migrationProfile = raw.migrationProfile ?? null;
  assert.ok(migrationProfile === null || migrationProfile === NEXT_MIGRATION_PROFILE && hasInstance, "TARGET_MIGRATION_PROFILE_INVALID");
  return Object.freeze({
    sourceFile: source,
    instance: hasInstance ? Object.freeze({ host, port, systemIdentifier }) : null,
    host,
    port,
    database,
    marker,
    oid,
    nonce,
    owner,
    migrationRole,
    runtimeRole,
    migrationRoleOid,
    runtimeRoleOid,
    lockKey,
    maintenanceDatabase,
    migrationProfile,
    protectedDataset,
    pendingReset,
  });
}

/** Older R07 artifacts keep their original port; new isolated targets require a distinct profile. */
export function isRegisteredMigrationInstance(target) {
  const instance = target?.instance, port = target?.port, profile = target?.migrationProfile ?? null;
  return Boolean(instance && target.host === DEFAULT_HOST && instance.host === target.host && instance.port === port
    && typeof instance.systemIdentifier === "string" && DIGITS.test(instance.systemIdentifier)
    && (profile === null ? port === 55433 : profile === NEXT_MIGRATION_PROFILE && Number.isInteger(port)
      && port >= 1024 && port <= 65535 && ![55432, 55433, 55434].includes(port)));
}

// shortcut: block next-profile writes until every finance, bank and recovery adapter is verified.
export function assertNextMigrationWriteReady(target) {
  assert.notEqual(target?.migrationProfile, NEXT_MIGRATION_PROFILE, "NEXT_MIGRATION_ADMISSION_INCOMPLETE");
}

/** Live identity as read from the target connection; no registry value is echoed back. */
export function targetIdentityQuery() {
  return `SELECT current_database() AS database,
    d.oid::text AS oid,
    pg_get_userbyid(d.datdba) AS owner,
d.datdba::int AS owner_oid,
    shobj_description(d.oid,'pg_database') AS marker,
    current_setting('zzsh.regression_run', true) AS nonce,
    current_setting('transaction_read_only') AS read_only,
    current_user AS role,
    r.oid::text AS role_oid,
    r.rolsuper::text AS is_super,
    r.rolcreatedb::text AS can_create_db,
    r.rolcreaterole::text AS can_create_role,
    r.rolinherit::text AS can_inherit,
    r.rolbypassrls::text AS can_bypass_rls,
    (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier
    FROM pg_database d JOIN pg_roles r ON r.rolname = current_user
    WHERE d.datname = current_database()`;
}

/**
 * Compare a live identity with the registered target. Every mismatch is a distinct code so a wrong
 * instance can never be reported as a wrong database name.
 */
export function assertLiveTarget(target, identity, roleKind = "migration") {
  assert.ok(identity && typeof identity === "object", "TARGET_IDENTITY_UNAVAILABLE");
  assert.ok(roleKind === "migration" || roleKind === "runtime", "TARGET_ROLE_KIND_INVALID");
  assert.equal(identity.database, target.database, "TARGET_DATABASE_MISMATCH");
  assert.equal(String(identity.oid), target.oid, "TARGET_OID_MISMATCH");
  // A registry that names the database owner must match it; one that does not still may not let the
  // migration role own the database it writes.
  if (target.owner === null) assert.notEqual(identity.owner, target.migrationRole, "TARGET_OWNER_MUST_NOT_BE_MIGRATION_ROLE");
  else assert.equal(identity.owner, target.owner, "TARGET_OWNER_MISMATCH");
  assert.equal(identity.marker, target.marker, "TARGET_MARKER_MISMATCH");
  assert.equal(identity.nonce, target.nonce, "TARGET_NONCE_MISMATCH");
  const roleName = roleKind === "migration" ? target.migrationRole : target.runtimeRole;
  const roleOid = roleKind === "migration" ? target.migrationRoleOid : target.runtimeRoleOid;
  assert.equal(identity.role, roleName, "TARGET_ROLE_MISMATCH");
  if (roleOid !== null) assert.equal(String(identity.role_oid), roleOid, "TARGET_ROLE_OID_MISMATCH");
  if (target.instance !== null) {
    assert.ok(identity.system_identifier !== undefined && identity.system_identifier !== null, "TARGET_SYSTEM_IDENTIFIER_UNAVAILABLE");
    assert.equal(String(identity.system_identifier), target.instance.systemIdentifier, "TARGET_INSTANCE_SYSTEM_IDENTIFIER_MISMATCH");
  }
  assert.equal(identity.is_super, "false", "TARGET_MIGRATION_ROLE_MUST_NOT_BE_SUPERUSER");
  assert.equal(identity.can_create_db, "false", "TARGET_MIGRATION_ROLE_MUST_NOT_CREATE_DB");
  assert.equal(identity.can_create_role, "false", "TARGET_MIGRATION_ROLE_MUST_NOT_CREATE_ROLE");
  assert.equal(identity.can_inherit, "false", "TARGET_MIGRATION_ROLE_MUST_NOT_INHERIT");
  assert.equal(identity.can_bypass_rls, "false", "TARGET_MIGRATION_ROLE_MUST_NOT_BYPASS_RLS");
  return Object.freeze({
    database: target.database,
    oid: target.oid,
    marker: target.marker,
    role: roleName,
    instance: target.instance === null ? null : { host: target.host, port: target.port, systemIdentifier: target.instance.systemIdentifier },
  });
}

/** The runtime role must be a different, non-superuser login inside the same registered database. */
export function assertRuntimeRoleCompanion(target, row) {
  assert.ok(row && typeof row === "object", "TARGET_RUNTIME_ROLE_UNAVAILABLE");
  assert.equal(row.rolname, target.runtimeRole, "TARGET_RUNTIME_ROLE_MISMATCH");
  assert.equal(row.rolcanlogin, "true", "TARGET_RUNTIME_ROLE_MUST_LOGIN");
  assert.equal(row.rolsuper, "false", "TARGET_RUNTIME_ROLE_MUST_NOT_BE_SUPERUSER");
  assert.equal(row.rolcreatedb, "false", "TARGET_RUNTIME_ROLE_MUST_NOT_CREATE_DB");
  assert.equal(row.rolcreaterole, "false", "TARGET_RUNTIME_ROLE_MUST_NOT_CREATE_ROLE");
  assert.equal(row.rolbypassrls, "false", "TARGET_RUNTIME_ROLE_MUST_NOT_BYPASS_RLS");
  return true;
}

/** Readback must use the same cluster, database epoch and registered migration role as its checkpoint. */
export function assertReadbackTarget(target, binding, credential) {
  assert.ok(binding && credential?.migration, "RESOURCE_BINDING_CHANGED");
  assert.ok(target.oid === binding.oid && target.nonce === binding.nonce && target.database === binding.database
    && JSON.stringify(binding.instance ?? null) === JSON.stringify(target.instance) && (binding.migrationProfile ?? null) === target.migrationProfile && !target.pendingReset
    && credential.migration.name === target.migrationRole && typeof target.migrationRoleOid === "string"
    && credential.migration.oid === target.migrationRoleOid, "RESOURCE_BINDING_CHANGED");
}

/** Older receipts have no system identities; new ones must bind all core domains to this target. */
export function assertCoreSystemMigrationBinding(target, binding, identities) {
  const keys = ["systemUserId", "systemAccountId", "systemOrderId"];
  if (keys.every(key => binding?.[key] === undefined)) return false;
  assert.equal(target?.migrationProfile, NEXT_MIGRATION_PROFILE, "SYSTEM_MIGRATION_PROFILE_MISMATCH");
  assert.ok(keys.every(key => typeof binding?.[key] === "string") && /^[a-f0-9]{64}$/.test(binding.datasetSha256 ?? ""),
    "SYSTEM_MIGRATION_BINDING_INCOMPLETE");
  const source = {systemIdentifier:target.instance?.systemIdentifier,databaseOid:target.oid,marker:target.marker,
    nonce:target.nonce,roleOid:target.migrationRoleOid};
  for (const [key,method] of [["systemUserId","systemUserMigrationId"],["systemAccountId","systemAccountMigrationId"],["systemOrderId","systemOrderMigrationId"]]) {
    assert.equal(typeof identities?.[method], "function", "SYSTEM_MIGRATION_BUILD_REQUIRED");
    assert.equal(binding[key],identities[method](binding.datasetSha256,source),"SYSTEM_MIGRATION_BINDING_CHANGED:"+key);
  }
  return true;
}

/**
 * Connection settings for the registered target, so no entry point has to repeat the host, port,
 * database or lock literal. Passwords stay with the caller: the registry never holds them.
 */
export function targetConnection(target, { user, password, applicationName, ...rest }) {
  assert.ok(target && typeof target === "object", "TARGET_NOT_RESOLVED");
  return Object.freeze({
    ...withoutConnectionTarget(rest),
    host: target.host,
    port: target.port,
    database: target.database,
    user,
    password,
    ...(applicationName === undefined ? {} : { application_name: applicationName }),
  });
}

/** Maintenance session settings: the advisory lock is taken on the maintenance database. */
export function maintenanceConnection(target, { user, password, applicationName, ...rest }) {
  assert.ok(target && typeof target === "object", "TARGET_NOT_RESOLVED");
  return Object.freeze({
    ...withoutConnectionTarget(rest),
    host: target.host,
    port: target.port,
    database: target.maintenanceDatabase,
    user,
    password,
    ...(applicationName === undefined ? {} : { application_name: applicationName }),
  });
}

/** A caller may tune timeouts but must never redirect the connection away from the registry. */
function withoutConnectionTarget(options) {
  const { host, port, database, user, password, ...rest } = options ?? {};
  return rest;
}

/** Lock statements are built from the registered key, never from a literal in the caller. */
export function advisoryLockSql(target, action) {
  assert.ok(/^[0-9]+$/.test(target.lockKey), "TARGET_LOCK_KEY_INVALID");
  assert.ok(action === "try" || action === "unlock", "TARGET_LOCK_ACTION_INVALID");
  return action === "try"
    ? `SELECT pg_try_advisory_lock(${target.lockKey}::bigint) ok`
    : `SELECT pg_advisory_unlock(${target.lockKey}::bigint) ok`;
}

/** Check the original maintenance session still holds the registered single-bigint lock. */
export async function assertMaintenanceLockHeld(client, target) {
  assert.ok(/^[0-9]+$/.test(target?.lockKey ?? '') && BigInt(target.lockKey) <= 9223372036854775807n, 'TARGET_LOCK_KEY_INVALID');
  const row = (await client.query(`SELECT current_database() AS database,
    (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
    EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()
      AND database=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND classid=(($1::bigint >> 32) & 4294967295::bigint)::oid AND objid=($1::bigint & 4294967295::bigint)::oid
      AND objsubid=1 AND mode='ExclusiveLock' AND granted) AS held`, [target.lockKey])).rows[0];
  assert.ok(row && row.database === target.maintenanceDatabase && row.held === true
    && (!target.instance || row.system_identifier === target.instance.systemIdentifier), 'TARGET_MAINTENANCE_LOCK_LOST');
}

// The target-database fence uses the two-integer advisory namespace, separate from the maintenance lock.
const MIGRATION_FENCE_NAMESPACE = 1515873096;

/** A borrowed client must still be the session that owns the target lock. */
export function guardedMigrationTargetPool(pool, verify) {
  assert(typeof pool?.connect === 'function' && typeof verify === 'function', 'TARGET_FENCED_POOL_INVALID');
  return { async connect() {
    const client = await pool.connect();
    try { await verify(client); return client; }
    catch (error) { try { client.release(true); } catch {} throw error; }
  } };
}

/** Bind a next-round write to the exact backend that owns the maintenance lock. */
export async function captureMaintenanceLockEpoch(client, target) {
  assert.equal(target?.migrationProfile, NEXT_MIGRATION_PROFILE, 'TARGET_FENCE_PROFILE_INVALID');
  assert.equal(target.lockKey, DEFAULT_LOCK_KEY, 'TARGET_FENCE_LOCK_INVALID');
  assert.equal(target.maintenanceDatabase, 'postgres', 'TARGET_FENCE_MAINTENANCE_DATABASE_INVALID');
  assert.ok(isRegisteredMigrationInstance(target), 'TARGET_FENCE_INSTANCE_INVALID');
  await assertMaintenanceLockHeld(client, target);
  const random = randomBytes(16), keys = [0, 4, 8, 12].map(offset => random.readInt32BE(offset));
  assert.ok(keys[0] !== keys[2] || keys[1] !== keys[3], 'TARGET_MAINTENANCE_EPOCH_COLLISION');
  const acquired = [];
  try {
    for (const offset of [0, 2]) {
      const pair = keys.slice(offset, offset + 2);
      assert.equal((await client.query('SELECT pg_try_advisory_lock($1::integer,$2::integer) AS acquired', pair)).rows[0]?.acquired,
        true, 'TARGET_MAINTENANCE_EPOCH_BUSY');
      acquired.push(pair);
    }
    const row = (await client.query('SELECT pg_backend_pid() AS pid')).rows[0];
    assert.ok(Number.isInteger(row?.pid) && row.pid > 0, 'TARGET_MAINTENANCE_EPOCH_UNAVAILABLE');
    await assertMaintenanceLockHeld(client, target);
    return Object.freeze({ pid: row.pid, keys: Object.freeze(keys), systemIdentifier: target.instance.systemIdentifier });
  } catch (error) {
    for (const pair of acquired) try { await client.query('SELECT pg_advisory_unlock($1::integer,$2::integer)', pair); } catch { /* connection loss releases its session locks */ }
    throw error;
  }
}

function assertFenceBinding(target, epoch) {
  assert.equal(target?.migrationProfile, NEXT_MIGRATION_PROFILE, 'TARGET_FENCE_PROFILE_INVALID');
  assert.equal(target.lockKey, DEFAULT_LOCK_KEY, 'TARGET_FENCE_LOCK_INVALID');
  assert.equal(target.maintenanceDatabase, 'postgres', 'TARGET_FENCE_MAINTENANCE_DATABASE_INVALID');
  assert.ok(isRegisteredMigrationInstance(target) && /^[1-9][0-9]*$/.test(target.oid ?? '')
    && /^[a-f0-9]{24}$/.test(target.nonce ?? '') && Number.isInteger(epoch?.pid) && epoch.pid > 0
    && Array.isArray(epoch.keys) && epoch.keys.length === 4 && epoch.keys.every(value => Number.isInteger(value) && value >= -2147483648 && value <= 2147483647)
    && (epoch.keys[0] !== epoch.keys[2] || epoch.keys[1] !== epoch.keys[3]) && epoch.systemIdentifier === target.instance.systemIdentifier,
  'TARGET_FENCE_BINDING_INVALID');
}

/** Recheck both the maintenance epoch and this connection's target lock. */
export async function assertMigrationFenceHeld(client, target, epoch) {
  assertFenceBinding(target, epoch);
  const row = (await client.query(`SELECT current_database() AS database,d.oid::text AS oid,
    current_setting('zzsh.regression_run',true) AS nonce,(SELECT system_identifier::text FROM pg_control_system()) AS system_identifier,
    EXISTS(SELECT 1 FROM pg_locks l WHERE l.locktype='advisory' AND l.pid=$1
      AND l.database=(SELECT oid FROM pg_database WHERE datname=$2)
      AND l.classid=(($3::bigint >> 32) & 4294967295::bigint)::oid AND l.objid=($3::bigint & 4294967295::bigint)::oid
      AND l.objsubid=1 AND l.mode='ExclusiveLock' AND l.granted
      AND EXISTS(SELECT 1 FROM pg_locks e WHERE e.locktype='advisory' AND e.pid=l.pid AND e.database=l.database AND e.objsubid=2
        AND e.classid=($4::bigint & 4294967295::bigint)::oid AND e.objid=($5::bigint & 4294967295::bigint)::oid AND e.mode='ExclusiveLock' AND e.granted)
      AND EXISTS(SELECT 1 FROM pg_locks e WHERE e.locktype='advisory' AND e.pid=l.pid AND e.database=l.database AND e.objsubid=2
        AND e.classid=($6::bigint & 4294967295::bigint)::oid AND e.objid=($7::bigint & 4294967295::bigint)::oid AND e.mode='ExclusiveLock' AND e.granted))
      AND EXISTS(SELECT 1 FROM pg_locks f WHERE f.locktype='advisory' AND f.pid=pg_backend_pid() AND f.database=d.oid AND f.objsubid=2
        AND f.classid=$8::oid AND f.objid=$9::oid AND f.mode='ExclusiveLock' AND f.granted) AS held
    FROM pg_database d WHERE d.datname=current_database()`, [epoch.pid, target.maintenanceDatabase, target.lockKey, ...epoch.keys,
    MIGRATION_FENCE_NAMESPACE, Number(target.lockKey)])).rows[0];
  assert.ok(row?.database === target.database && row.oid === target.oid && row.nonce === target.nonce
    && row.system_identifier === epoch.systemIdentifier && row.held === true, 'TARGET_FENCE_EPOCH_LOST');
}

/** Hold the fence until this transaction ends; a successor must acquire it before writing. */
export async function acquireMigrationTransactionFence(client, target, epoch) {
  assertFenceBinding(target, epoch);
  assert.equal(client.getTransactionStatus?.(), 'T', 'TARGET_FENCE_TRANSACTION_REQUIRED');
  const lock = (await client.query('SELECT pg_try_advisory_xact_lock($1::integer,$2::integer) AS acquired',
    [MIGRATION_FENCE_NAMESPACE, Number(target.lockKey)])).rows[0];
  assert.equal(lock?.acquired, true, 'TARGET_FENCE_BUSY');
  await assertMigrationFenceHeld(client, target, epoch);
}

/** Hold the same fence across batches and checkpoint updates on a single target connection. */
export async function acquireMigrationSessionFence(client, target, epoch) {
  assertFenceBinding(target, epoch);
  assert.equal(client.getTransactionStatus?.(), 'I', 'TARGET_FENCE_IDLE_CONNECTION_REQUIRED');
  const args = [MIGRATION_FENCE_NAMESPACE, Number(target.lockKey)];
  assert.equal((await client.query('SELECT pg_try_advisory_lock($1::integer,$2::integer) AS acquired', args)).rows[0]?.acquired,
    true, 'TARGET_FENCE_BUSY');
  try { await assertMigrationFenceHeld(client, target, epoch); }
  catch (error) { try { await client.query('SELECT pg_advisory_unlock($1::integer,$2::integer)', args); } catch { /* closing the connection releases the lock */ } throw error; }
}

export async function releaseMigrationSessionFence(client, target) {
  assert.equal(target?.migrationProfile, NEXT_MIGRATION_PROFILE, 'TARGET_FENCE_PROFILE_INVALID');
  assert.equal(target.lockKey, DEFAULT_LOCK_KEY, 'TARGET_FENCE_LOCK_INVALID');
  assert.equal(client.getTransactionStatus?.(), 'I', 'TARGET_FENCE_IDLE_CONNECTION_REQUIRED');
  const row = (await client.query('SELECT pg_advisory_unlock($1::integer,$2::integer) AS released',
    [MIGRATION_FENCE_NAMESPACE, Number(target.lockKey)])).rows[0];
  assert.equal(row?.released, true, 'TARGET_FENCE_RELEASE_UNCONFIRMED');
}
