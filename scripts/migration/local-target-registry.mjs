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
import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export const RESOURCE_FILE = "resource.json";
export const DEFAULT_HOST = "127.0.0.1";
export const DEFAULT_PORT = 55432;
export const DEFAULT_LOCK_KEY = "806006";
export const DEFAULT_MAINTENANCE_DATABASE = "postgres";
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
    protectedDataset,
    pendingReset,
  });
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
    && JSON.stringify(binding.instance ?? null) === JSON.stringify(target.instance) && !target.pendingReset
    && credential.migration.name === target.migrationRole && typeof target.migrationRoleOid === "string"
    && credential.migration.oid === target.migrationRoleOid, "RESOURCE_BINDING_CHANGED");
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
