import { strict as assert } from "node:assert";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";

import { Pool, type PoolClient } from "pg";

import { createApp } from "../src/app";
import { loadAuthRuntimeConfig } from "../src/auth/auth-runtime";
import { retryPendingAdminSecurityNotifications, type AdminSecurityNotification } from "../src/auth/auth-security";
import { issueDisasterRecovery } from "../src/auth/disaster-recovery";
import { createFakeRealNameProvider, type FakeRealNameScenario, type RealNameProvider, type UserObligationStatus } from "../src/auth/user-identity";
import { assertBusinessMigrationIdentity, assertBusinessRuntimeIdentity, createBusinessPool } from "../src/database/business";
import { runBusinessMigrations } from "../src/database/business-migrations";
import { loadConfig, type AppConfig } from "../src/config/config";

const DEFAULT_TEST_DATABASE = "zzsh_test_m2_auth";
const RESOURCE_MARKER = "zzsh:m2-auth-test:v1";
const RESOURCE_LOCK_KEY = "805002";
const USER_ORIGIN = "http://127.0.0.1:3100";
const ADMIN_ORIGIN = "http://127.0.0.1:3101";
const API_ORIGIN = "http://127.0.0.1:3102";
const PASSWORD = randomBytes(24).toString("base64url");
const ADMIN_BOOTSTRAP_SECRET = randomBytes(32).toString("hex");
const BOSS_ONE_PASSWORD = randomBytes(24).toString("base64url");
const BOSS_TWO_PASSWORD = randomBytes(24).toString("base64url");
const BOSS_ONE_TEMP_PASSWORD = randomBytes(24).toString("base64url");
const BOSS_TWO_TEMP_PASSWORD = randomBytes(24).toString("base64url");
const RECOVERY_PASSWORD = randomBytes(24).toString("base64url");
const LEGACY_PASSWORD = randomBytes(24).toString("base64url");
const BUSINESS_SCHEMA_NAMES = ["zzsh_business_meta", "zzsh_iam", "zzsh_auth_user", "zzsh_auth_admin"] as const;

type CookieJar = {
  values: Map<string, string>;
  update: (response: Response) => void;
  header: () => string;
};

type TestDatabaseResources = {
  maintenance: AppConfig;
  migration: AppConfig;
  runtime: AppConfig;
  databaseName: string;
  migrationUser: string;
  runtimeUser: string;
  migrationPassword: string;
  runtimePassword: string;
};

function cookieJar(): CookieJar {
  const values = new Map<string, string>();
  return {
    values,
    update(response) {
      for (const raw of response.headers.getSetCookie()) {
        const [pair, ...attributes] = raw.split(";");
        if (!pair) continue;
        const separator = pair.indexOf("=");
        if (separator < 1) continue;
        const name = pair.slice(0, separator).trim();
        const value = pair.slice(separator + 1).trim();
        if (attributes.some((attribute) => attribute.trim().toLowerCase() === "max-age=0")) values.delete(name);
        else values.set(name, value);
      }
    },
    header() {
      return [...values.entries()].map(([name, value]) => `${name}=${value}`).join("; ");
    },
  };
}

function identifier(value: string, label: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error(`${label}=${value} must be a safe identifier`);
  return value;
}

function dedicatedRoleName(value: string, label: string): string {
  const role = identifier(value, label);
  if (!role.startsWith("zzsh_m2_")) throw new Error(`${label} must use the isolated zzsh_m2_ role prefix`);
  return role;
}

function quotedIdentifier(value: string, label: string): string {
  return `"${identifier(value, label)}"`;
}

function quotedRelationIdentifier(value: string, label: string): string {
  if (!/^[A-Za-z][A-Za-z0-9_]{0,62}$/.test(value)) throw new Error(`${label}=${value} must be a safe identifier`);
  return `"${value}"`;
}

function quotedLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function baseTestEnv(databaseName: string): NodeJS.ProcessEnv {
  const maintenanceUser = process.env.M2_AUTH_TEST_MAINTENANCE_USER ?? process.env.DB_USER;
  return {
    ...process.env,
    APP_PROFILE: "test",
    PROVIDER_MODE: "fake",
    DB_TARGET: "local-compose",
    DB_NAME: databaseName,
    ...(maintenanceUser ? { DB_USER: maintenanceUser } : {}),
  };
}

function makeResources(): TestDatabaseResources {
  const databaseName = process.env.M2_AUTH_TEST_DB_NAME?.trim() || DEFAULT_TEST_DATABASE;
  const migrationUser = dedicatedRoleName(process.env.M2_AUTH_TEST_MIGRATION_USER?.trim() || "zzsh_m2_migration", "M2_AUTH_TEST_MIGRATION_USER");
  const runtimeUser = dedicatedRoleName(process.env.M2_AUTH_TEST_RUNTIME_USER?.trim() || "zzsh_m2_runtime", "M2_AUTH_TEST_RUNTIME_USER");
  if (migrationUser === runtimeUser) throw new Error("M2 auth migration/runtime users must be different");
  const maintenanceEnv = baseTestEnv(databaseName);
  const maintenance = loadConfig(maintenanceEnv);
  const runtimePassword = process.env.M2_AUTH_TEST_RUNTIME_PASSWORD?.trim() || randomBytes(32).toString("hex");
  const migrationPassword = process.env.M2_AUTH_TEST_MIGRATION_PASSWORD?.trim() || randomBytes(32).toString("hex");
  const runtime = loadConfig({
    ...maintenanceEnv,
    DB_USER: runtimeUser,
    DB_PASSWORD: runtimePassword,
    DB_PASSWORD_FILE: undefined,
  });
  const migration = loadConfig({
    ...maintenanceEnv,
    APP_PROFILE: "migration",
    DB_USER: undefined,
    DB_PASSWORD: undefined,
    DB_PASSWORD_FILE: undefined,
    MIGRATION_TARGET_PROFILE: "test",
    MIGRATION_TARGET_DB_NAME: databaseName,
    MIGRATION_DB_USER: migrationUser,
    MIGRATION_DB_PASSWORD: migrationPassword,
    MIGRATION_DB_PASSWORD_FILE: undefined,
    MIGRATION_RUNTIME_USER: runtimeUser,
  });
  assert.equal(maintenance.database.name, databaseName);
  assert.equal(runtime.database.name, databaseName);
  assert.equal(migration.database.name, databaseName);
  assert.equal(migration.database.user, migrationUser);
  assert.equal(migration.database.runtimeUser, runtimeUser);
  assert.equal(runtime.database.user, runtimeUser);
  assert.notEqual(runtime.database.user, maintenance.database.user);
  return { maintenance, migration, runtime, databaseName, migrationUser, runtimeUser, migrationPassword, runtimePassword };
}

function poolFor(config: AppConfig, database: string, applicationName: string, max: number): Pool {
  return new Pool({
    host: config.database.host,
    port: config.database.port,
    database,
    user: config.database.user,
    password: config.database.password,
    application_name: applicationName,
    connectionTimeoutMillis: 2_000,
    max,
  });
}

async function acquireResourceGuard(pool: Pool, expectedUser: string): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    const identity = await client.query<{ databaseName: string; currentUser: string; port: string }>(
      "SELECT current_database() AS \"databaseName\", current_user AS \"currentUser\", current_setting('port') AS port",
    );
    assert.equal(identity.rows[0]?.databaseName, "postgres");
    assert.equal(identity.rows[0]?.currentUser, expectedUser);
    assert.equal(identity.rows[0]?.port, "5432");
    const locked = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [RESOURCE_LOCK_KEY],
    );
    assert.equal(locked.rows[0]?.acquired, true, "M2 auth test target is already in use");
    return client;
  } catch (error) {
    client.release(true);
    throw error;
  }
}

async function releaseResourceGuard(client: PoolClient | undefined): Promise<void> {
  if (!client) return;
  try {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [RESOURCE_LOCK_KEY]);
  } finally {
    client.release();
  }
}

async function assertResourceGuardExclusive(pool: Pool): Promise<void> {
  const observer = await pool.connect();
  try {
    const result = await observer.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [RESOURCE_LOCK_KEY],
    );
    assert.equal(result.rows[0]?.acquired, false);
  } finally {
    observer.release();
  }
}

async function ensureTargetDatabase(
  maintenancePool: Pool,
  resources: TestDatabaseResources,
): Promise<void> {
  const target = quotedIdentifier(resources.databaseName, "M2_AUTH_TEST_DB_NAME");
  const existing = await maintenancePool.query<{
    owner: string;
    allowConnections: boolean;
    isTemplate: boolean;
    comment: string | null;
  }>(
    `SELECT pg_get_userbyid(d.datdba) AS owner, d.datallowconn AS "allowConnections", d.datistemplate AS "isTemplate", shobj_description(d.oid, 'pg_database') AS comment FROM pg_database d WHERE d.datname = $1`,
    [resources.databaseName],
  );
  if (existing.rows.length === 0) {
    await maintenancePool.query(`CREATE DATABASE ${target} OWNER ${quotedIdentifier(resources.maintenance.database.user, "DB_USER")}`);
    await maintenancePool.query(`COMMENT ON DATABASE ${target} IS ${quotedLiteral(RESOURCE_MARKER)}`);
  } else {
    const row = existing.rows[0]!;
    assert.equal(row.owner, resources.maintenance.database.user, "M2 auth test database owner changed");
    assert.equal(row.allowConnections, true);
    assert.equal(row.isTemplate, false);
    assert.equal(row.comment, RESOURCE_MARKER, "M2 auth test database marker is missing or mismatched");
  }
}

type TestRoleSnapshot = {
  canLogin: boolean;
  isSuperuser: boolean;
  canCreateRole: boolean;
  canCreateDb: boolean;
  canInherit: boolean;
  canReplicate: boolean;
  canBypassRls: boolean;
  comment: string | null;
  ownsDatabase: boolean;
  memberOfRole: boolean;
  grantedToRole: boolean;
};

const roleMarker = (databaseName: string, role: "migration" | "runtime"): string => `${RESOURCE_MARKER}:${databaseName}:${role}`;

async function readTestRole(pool: Pool, roleName: string): Promise<TestRoleSnapshot | undefined> {
  const result = await pool.query<TestRoleSnapshot>(
    `
      SELECT r.rolcanlogin AS "canLogin", r.rolsuper AS "isSuperuser",
        r.rolcreaterole AS "canCreateRole", r.rolcreatedb AS "canCreateDb",
        r.rolinherit AS "canInherit", r.rolreplication AS "canReplicate",
        r.rolbypassrls AS "canBypassRls", shobj_description(r.oid, 'pg_authid') AS comment,
        EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba = r.oid) AS "ownsDatabase",
        EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS "memberOfRole",
        EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r.oid) AS "grantedToRole"
      FROM pg_roles r
      WHERE r.rolname = $1
    `,
    [roleName],
  );
  return result.rows[0];
}

function assertDedicatedRole(snapshot: TestRoleSnapshot | undefined, roleName: string, expectedMarker: string): void {
  if (!snapshot) return;
  assert.equal(snapshot.comment, expectedMarker, `${roleName} is not marked as this isolated M2 test role`);
  assert.equal(snapshot.canLogin, true, `${roleName} must be a login role`);
  assert.equal(snapshot.isSuperuser, false, `${roleName} must not be superuser`);
  assert.equal(snapshot.canCreateRole, false, `${roleName} must not create roles`);
  assert.equal(snapshot.canCreateDb, false, `${roleName} must not create databases`);
  assert.equal(snapshot.canInherit, false, `${roleName} must not inherit another role`);
  assert.equal(snapshot.canReplicate, false, `${roleName} must not replicate`);
  assert.equal(snapshot.canBypassRls, false, `${roleName} must not bypass row security`);
  assert.equal(snapshot.ownsDatabase, false, `${roleName} must not own a database`);
  assert.equal(snapshot.memberOfRole, false, `${roleName} must not be a member of another role`);
  assert.equal(snapshot.grantedToRole, false, `${roleName} must not be granted to another role`);
}

async function ensureLoginRole(pool: Pool, roleName: string, password: string, expectedMarker: string): Promise<void> {
  const role = quotedIdentifier(roleName, "test database role");
  const current = await readTestRole(pool, roleName);
  assertDedicatedRole(current, roleName, expectedMarker);
  if (!current) {
    await pool.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${quotedLiteral(password)}`);
    await pool.query(`COMMENT ON ROLE ${role} IS ${quotedLiteral(expectedMarker)}`);
    return;
  }
  await pool.query(`ALTER ROLE ${role} PASSWORD ${quotedLiteral(password)}`);
}

async function assertUnknownRoleIsUntouched(pool: Pool, databaseName: string): Promise<void> {
  const roleName = `zzsh_m2_unknown_${randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const role = quotedIdentifier(roleName, "unknown M2 test role");
  const password = randomBytes(32).toString("hex");
  await pool.query(`CREATE ROLE ${role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${quotedLiteral(password)}`);
  await pool.query(`COMMENT ON ROLE ${role} IS ${quotedLiteral(`${RESOURCE_MARKER}:${databaseName}:unknown`)}`);
  try {
    const before = await readTestRole(pool, roleName);
    await assert.rejects(
      () => ensureLoginRole(pool, roleName, randomBytes(32).toString("hex"), roleMarker(databaseName, "runtime")),
      /isolated M2 test role/,
    );
    assert.deepEqual(await readTestRole(pool, roleName), before);
  } finally {
    await pool.query(`DROP ROLE ${role}`);
  }
}

async function grantTestRoleAccess(pool: Pool, resources: TestDatabaseResources): Promise<void> {
  const target = quotedIdentifier(resources.databaseName, "M2_AUTH_TEST_DB_NAME");
  await pool.query(`GRANT CONNECT ON DATABASE ${target} TO ${quotedIdentifier(resources.migrationUser, "M2_AUTH_TEST_MIGRATION_USER")}, ${quotedIdentifier(resources.runtimeUser, "M2_AUTH_TEST_RUNTIME_USER")}`);
  await pool.query(`GRANT CREATE ON DATABASE ${target} TO ${quotedIdentifier(resources.migrationUser, "M2_AUTH_TEST_MIGRATION_USER")}`);
}

async function prepareMigrationOwnership(pool: Pool, resources: TestDatabaseResources): Promise<void> {
  const migrationRole = quotedIdentifier(resources.migrationUser, "M2_AUTH_TEST_MIGRATION_USER");
  for (const schemaName of BUSINESS_SCHEMA_NAMES) {
    const schema = quotedIdentifier(schemaName, "business schema");
    const schemaOwner = await pool.query<{ owner: string }>(
      `SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1`,
      [schemaName],
    );
    if (schemaOwner.rows.length === 0) {
      await pool.query(`CREATE SCHEMA ${schema}`);
    } else {
      assert.ok(
        schemaOwner.rows[0]?.owner === resources.maintenance.database.user || schemaOwner.rows[0]?.owner === resources.migrationUser,
        `business schema owner is outside the test target: ${schemaName}`,
      );
    }
    const owner = schemaOwner.rows.length === 0
      ? resources.maintenance.database.user
      : schemaOwner.rows[0]!.owner;
    if (owner !== resources.migrationUser) await pool.query(`ALTER SCHEMA ${schema} OWNER TO ${migrationRole}`);
  }
  const relations = await pool.query<{ schemaName: string; relationName: string; kind: string; owner: string }>(`
    SELECT n.nspname AS "schemaName", c.relname AS "relationName", c.relkind AS kind,
      pg_get_userbyid(c.relowner) AS owner
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p', 'S')
  `, [BUSINESS_SCHEMA_NAMES]);
  for (const row of [...relations.rows].sort((left, right) => Number(left.kind === "S") - Number(right.kind === "S"))) {
    assert.ok(row.owner === resources.maintenance.database.user || row.owner === resources.migrationUser, `business relation owner is outside the test target: ${row.schemaName}.${row.relationName}`);
    if (row.owner !== resources.migrationUser) {
      const relation = `${quotedIdentifier(row.schemaName, "business schema")}.${quotedRelationIdentifier(row.relationName, "business relation")}`;
      await pool.query(`${row.kind === "S" ? "ALTER SEQUENCE" : "ALTER TABLE"} ${relation} OWNER TO ${migrationRole}`);
    }
  }
}

async function resetBusinessData(pool: Pool): Promise<void> {
  await pool.query(`
    TRUNCATE
      "zzsh_iam"."admin_workspace_layout",
      "zzsh_iam"."approval_execution",
      "zzsh_iam"."approval_decision",
      "zzsh_iam"."approval_request_candidate",
      "zzsh_iam"."approval_request",
      "zzsh_iam"."approval_template_candidate",
      "zzsh_iam"."approval_template",
      "zzsh_iam"."admin_user_permission",
      "zzsh_iam"."admin_user_role",
      "zzsh_iam"."admin_role_permission",
      "zzsh_iam"."admin_recovery_request",
      "zzsh_iam"."admin_recovery_notification_target",
      "zzsh_iam"."admin_security_notification_outbox",
      "zzsh_auth_admin"."twoFactor",
      "zzsh_auth_admin"."verification",
      "zzsh_auth_admin"."session",
      "zzsh_auth_admin"."account",
      "zzsh_auth_admin"."user",
      "zzsh_auth_user"."twoFactor",
      "zzsh_auth_user"."verification",
      "zzsh_auth_user"."session",
      "zzsh_auth_user"."account",
      "zzsh_auth_user"."user",
      "zzsh_iam"."user_identity_state",
      "zzsh_iam"."admin_security",
      "zzsh_iam"."audit_event"
  `);
  await pool.query(`DELETE FROM "zzsh_iam"."admin_role" WHERE "code" NOT IN ('ops', 'support')`);
  await pool.query(`DELETE FROM "zzsh_iam"."admin_role_permission"`);
}

async function json(response: Response): Promise<Record<string, any> | null> {
  const text = await response.text();
  return text ? JSON.parse(text) as Record<string, any> : null;
}

async function request(
  base: string,
  path: string,
  body: Record<string, unknown> | undefined,
  jar: CookieJar,
  origin: string,
  bearer?: string,
  extraHeaders?: Record<string, string>,
): Promise<{ response: Response; body: Record<string, any> | null }> {
  const response = await fetch(`${base}${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      origin,
      ...(body ? { "content-type": "application/json" } : {}),
      ...(jar.header() ? { cookie: jar.header() } : {}),
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...extraHeaders,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  jar.update(response);
  return { response, body: await json(response) };
}

function assertNoTokenHeaders(response: Response): void {
  for (const [name] of response.headers) assert.equal(/token|authorization/i.test(name), false, `unexpected authentication header: ${name}`);
}

async function completeStaffEnrollment(
  base: string,
  username: string,
  temporaryPassword: string,
): Promise<{ jar: CookieJar; password: string; secret: string }> {
  const jar = cookieJar();
  const login = await request(base, "/api/auth/admin/sign-in/username", { username, password: temporaryPassword }, jar, ADMIN_ORIGIN);
  assert.equal(login.response.status, 200);
  const password = randomBytes(24).toString("base64url");
  assert.equal((await request(base, "/api/auth/admin/change-password", {
    currentPassword: temporaryPassword,
    newPassword: password,
    revokeOtherSessions: true,
  }, jar, ADMIN_ORIGIN)).response.status, 200);
  const enable = await request(base, "/api/auth/admin/two-factor/enable", { password }, jar, ADMIN_ORIGIN);
  assert.equal(enable.response.status, 200);
  const secret = new URL(enable.body?.totpURI as string).searchParams.get("secret");
  assert.ok(secret);
  assert.equal((await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(secret) }, jar, ADMIN_ORIGIN)).response.status, 200);
  assert.equal((await request(base, "/api/v1/admin/security/enrollment/activate", {}, jar, ADMIN_ORIGIN)).response.status, 200);
  return { jar, password, secret };
}

async function waitForRoleLockWait(pool: Pool, timeoutMs = 5_000): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const waiting = await pool.query<{ waiting: string }>(`
      SELECT count(*)::text AS waiting
        FROM pg_stat_activity
       WHERE datname = current_database()
         AND wait_event_type = 'Lock'
         AND pid <> pg_backend_pid()
    `);
    if (Number(waiting.rows[0]?.waiting ?? 0) > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("did not observe a backend waiting on Lock");
}

async function withHeldRoleLock<T>(
  pool: Pool,
  roleId: string,
  blocked: () => Promise<T>,
  mutate: (client: PoolClient) => Promise<void>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`SELECT "id" FROM "zzsh_iam"."admin_role" WHERE "id" = $1 FOR UPDATE`, [roleId]);
    const pending = blocked();
    await waitForRoleLockWait(pool);
    await mutate(client);
    await client.query("COMMIT");
    return await pending;
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { /* preserve the primary error */ }
    throw error;
  } finally {
    client.release();
  }
}

function base32Decode(value: string): Buffer {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of value.toUpperCase().replace(/=+$/, "")) {
    const index = alphabet.indexOf(char);
    if (index < 0) throw new Error("invalid TOTP fixture");
    bits += index.toString(2).padStart(5, "0");
  }
  const bytes: number[] = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  return Buffer.from(bytes);
}

function totpCode(secret: string, timestamp = Date.now()): string {
  const counter = Math.floor(timestamp / 1000 / 30);
  const counterBuffer = Buffer.alloc(8);
  counterBuffer.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secret)).update(counterBuffer).digest();
  const offset = digest[digest.length - 1]! & 0x0f;
  const value = ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);
  return String(value % 1_000_000).padStart(6, "0");
}

test("M2 business migration and Better Auth realms enforce the basic boundary", async () => {
  let resources: TestDatabaseResources | undefined;
  let maintenancePool: Pool | undefined;
  let migrationPool: Pool | undefined;
  let runtimePool: Pool | undefined;
  let maintenanceDataPool: Pool | undefined;
  let resourceGuard: PoolClient | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let runtimeClosedByApp = false;

  try {
    resources = makeResources();
    assert.notEqual(resources.databaseName, "zzsh_dev");
    maintenancePool = poolFor(resources.maintenance, "postgres", "zzsh-m2-auth-maintenance", 2);
    resourceGuard = await acquireResourceGuard(maintenancePool, resources.maintenance.database.user);
    await assertResourceGuardExclusive(maintenancePool);
    await ensureTargetDatabase(maintenancePool, resources);
    assertDedicatedRole(
      await readTestRole(maintenancePool, resources.migrationUser),
      resources.migrationUser,
      roleMarker(resources.databaseName, "migration"),
    );
    assertDedicatedRole(
      await readTestRole(maintenancePool, resources.runtimeUser),
      resources.runtimeUser,
      roleMarker(resources.databaseName, "runtime"),
    );
    await assertUnknownRoleIsUntouched(maintenancePool, resources.databaseName);
    await ensureLoginRole(maintenancePool, resources.migrationUser, resources.migrationPassword, roleMarker(resources.databaseName, "migration"));
    await ensureLoginRole(maintenancePool, resources.runtimeUser, resources.runtimePassword, roleMarker(resources.databaseName, "runtime"));
    await grantTestRoleAccess(maintenancePool, resources);
    maintenanceDataPool = poolFor(resources.maintenance, resources.databaseName, "zzsh-m2-auth-owner", 2);
    await prepareMigrationOwnership(maintenanceDataPool, resources);

    migrationPool = createBusinessPool(resources.migration);
    await assertBusinessMigrationIdentity(migrationPool, resources.migration);
    await runBusinessMigrations(migrationPool, { runtimeUser: resources.runtimeUser });
    runtimePool = createBusinessPool(resources.runtime);
    await assertBusinessRuntimeIdentity(runtimePool, resources.runtime);
    await assert.rejects(() => assertBusinessMigrationIdentity(runtimePool!, resources!.migration), /separate DDL role/);
    await assert.rejects(() => assertBusinessRuntimeIdentity(migrationPool!, resources!.runtime), /non-owner runtime role/);
    const misconfiguredRuntime = {
      ...resources.runtime,
      database: {
        ...resources.runtime.database,
        user: resources.migrationUser,
        password: resources.migrationPassword,
        runtimeUser: resources.migrationUser,
      },
    };
    const misconfiguredRuntimePool = createBusinessPool(misconfiguredRuntime);
    try {
      await assert.rejects(
        () => assertBusinessRuntimeIdentity(misconfiguredRuntimePool, misconfiguredRuntime),
        /non-owner runtime role/,
      );
    } finally {
      await misconfiguredRuntimePool.end();
    }
    await resetBusinessData(migrationPool);

    const fakeSmsOutbox = new Map<string, { code: string; sentAt: string; purpose: "phone-verification" | "password-reset" }>();
    const fakeAdminNotificationOutbox: AdminSecurityNotification[] = [];
    const rateLimitState = new Map<string, { failures: number; resetAt: number }>();
    const securityVerificationBudget = { inFlight: 0 };
    const identityScenarios = new Map<string, FakeRealNameScenario>();
    const realNameProvider: RealNameProvider = {
      verify: (input) => createFakeRealNameProvider(identityScenarios.get(input.userId) ?? "UNKNOWN").verify(input),
    };
    const obligationStatuses = new Map<string, UserObligationStatus | "INVALID">();
    const obligationFailures = new Set<string>();
    const obligationBarriers = new Map<string, { started: () => void; release: Promise<void> }>();
    app = await createApp({
      health: {
        dependencies: {
          postgres: { check: async () => undefined, close: async () => undefined },
          redis: { check: async () => undefined, close: async () => undefined },
        },
      },
      database: { pool: runtimePool },
      auth: {
        ...loadAuthRuntimeConfig({
          AUTH_API_ORIGIN: API_ORIGIN,
          AUTH_USER_ORIGIN: USER_ORIGIN,
          AUTH_ADMIN_ORIGIN: ADMIN_ORIGIN,
          AUTH_USER_SECRET: randomBytes(32).toString("hex"),
          AUTH_ADMIN_SECRET: randomBytes(32).toString("hex"),
          AUTH_ADMIN_BOOTSTRAP_SECRET: ADMIN_BOOTSTRAP_SECRET,
        }),
        pool: runtimePool,
        fakeSmsOutbox,
        fakeAdminNotificationOutbox,
        rateLimitState,
        securityVerificationBudget,
        realNameProvider,
        userObligationReader: async (userId, client) => {
          const barrier = obligationBarriers.get(userId);
          if (barrier) {
            barrier.started();
            await barrier.release;
          }
          if (obligationFailures.has(userId)) throw new Error("obligation reader fixture failure");
          await client.query(`SELECT "id" FROM "zzsh_auth_user"."user" WHERE "id" = $1 FOR SHARE`, [userId]);
          return (obligationStatuses.get(userId) ?? "UNKNOWN") as UserObligationStatus;
        },
      },
    });
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();

    await migrationPool.query(`REVOKE INSERT ON TABLE "zzsh_iam"."audit_event" FROM ${quotedIdentifier(resources.runtimeUser, "M2_AUTH_TEST_RUNTIME_USER")}`);
    const failedSignup = await request(base, "/api/auth/user/sign-up/email", {
      email: "m2-audit-rollback@example.invalid",
      password: PASSWORD,
      name: "Audit Rollback",
      username: "m2_audit_rollback",
    }, cookieJar(), USER_ORIGIN);
    assert.equal(failedSignup.response.status, 422);
    assert.equal(failedSignup.body?.error?.code, "INVALID_ARGUMENT");
    assert.equal(failedSignup.response.headers.get("x-request-id")?.startsWith("req_"), true);
    assert.equal(failedSignup.body?.error?.requestId, failedSignup.response.headers.get("x-request-id"));
    const failedRows = await runtimePool.query<{ users: string; audits: string }>(`
      SELECT
        (SELECT count(*)::text FROM "zzsh_auth_user"."user") AS users,
        (SELECT count(*)::text FROM "zzsh_iam"."audit_event") AS audits
    `);
    assert.deepEqual(failedRows.rows[0], { users: "0", audits: "0" });
    await migrationPool.query(`GRANT INSERT ON TABLE "zzsh_iam"."audit_event" TO ${quotedIdentifier(resources.runtimeUser, "M2_AUTH_TEST_RUNTIME_USER")}`);

    const user = cookieJar();
    const signup = await request(base, "/api/auth/user/sign-up/email", {
      email: "m2-user@example.invalid",
      password: PASSWORD,
      name: "M2 User",
      username: "m2_user",
    }, user, USER_ORIGIN);
    assert.equal(signup.response.status, 200);
    assert.equal(signup.body?.user?.username, "m2_user");
    const userId = signup.body?.user?.id as string;
    assert.ok(userId);
    assert.notEqual(user.header(), "");
    const userSession = await request(base, "/api/auth/user/get-session", undefined, user, USER_ORIGIN);
    assert.equal(userSession.response.status, 200);
    const userLifetime = new Date(userSession.body?.session?.expiresAt).getTime() - new Date(userSession.body?.session?.createdAt).getTime();
    assert.ok(Math.abs(userLifetime - 30 * 24 * 60 * 60 * 1000) < 2_000);
    const userAudit = await runtimePool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "zzsh_iam"."audit_event" WHERE "action" = 'user.account.created'`,
    );
    assert.equal(userAudit.rows[0]?.count, "1");

    const unverifiedEligibility = await request(base, "/api/auth/user/trade-eligibility/check", { action: "protected_trade_eligibility_check", ageStatus: "ADULT" }, user, USER_ORIGIN);
    assert.equal(unverifiedEligibility.response.status, 403);
    assert.match(unverifiedEligibility.body?.error?.message, /实名/);
    identityScenarios.set(userId, "VERIFIED_ADULT");
    const verifiedIdentity = await request(base, "/api/auth/user/identity/verify", { fullName: "Fixture Adult", documentNumber: "fixture-adult" }, user, USER_ORIGIN);
    assert.equal(verifiedIdentity.response.status, 200);
    assert.deepEqual({ status: verifiedIdentity.body?.status, ageStatus: verifiedIdentity.body?.ageStatus }, { status: "VERIFIED", ageStatus: "ADULT" });
    const forgedIdentityInput = await request(base, "/api/auth/user/identity/verify", { fullName: "Fixture Adult", documentNumber: "fixture-adult", scenario: "VERIFIED_ADULT", ageStatus: "ADULT" }, user, USER_ORIGIN);
    assert.equal(forgedIdentityInput.response.status, 400);
    const identityAfterForgedInput = await request(base, "/api/auth/user/identity/status", undefined, user, USER_ORIGIN);
    assert.deepEqual(
      { identityStatus: identityAfterForgedInput.body?.identityStatus, ageStatus: identityAfterForgedInput.body?.ageStatus },
      { identityStatus: "VERIFIED", ageStatus: "ADULT" },
    );
    const forgedAge = await request(base, "/api/auth/user/trade-eligibility/check", { action: "protected_trade_eligibility_check", ageStatus: "MINOR" }, user, USER_ORIGIN);
    assert.equal(forgedAge.response.status, 200);
    assert.equal(forgedAge.body?.eligible, true);
    assert.equal(forgedAge.body?.execution, "NOT_PERFORMED");

    obligationStatuses.set(userId, "NONE");
    const invalidMethodBefore = await runtimePool.query<{ sessions: string; verifications: string; audits: string; accountStatus: string; suspended: boolean }>(`
      SELECT
        (SELECT count(*)::text FROM "zzsh_auth_user"."session" WHERE "userId" = $1) AS sessions,
        (SELECT count(*)::text FROM "zzsh_auth_user"."verification" WHERE "identifier" = 'm2-user@example.invalid') AS verifications,
        (SELECT count(*)::text FROM "zzsh_iam"."audit_event" WHERE "object_id" = $1) AS audits,
        (SELECT COALESCE("account_status", 'ACTIVE') FROM "zzsh_iam"."user_identity_state" WHERE "user_id" = $1) AS "accountStatus",
        (SELECT "suspended" FROM "zzsh_auth_user"."user" WHERE "id" = $1) AS suspended
    `, [userId]);
    const postStatus = await request(base, "/api/auth/user/identity/status", {}, user, USER_ORIGIN);
    assert.equal(postStatus.response.status, 404);
    const getCancel = await fetch(`${base}/api/auth/user/account/cancel`, { headers: { origin: USER_ORIGIN, cookie: user.header() } });
    assert.equal(getCancel.status, 404);
    assert.deepEqual(
      (await runtimePool.query(`
        SELECT
          (SELECT count(*)::text FROM "zzsh_auth_user"."session" WHERE "userId" = $1) AS sessions,
          (SELECT count(*)::text FROM "zzsh_auth_user"."verification" WHERE "identifier" = 'm2-user@example.invalid') AS verifications,
          (SELECT count(*)::text FROM "zzsh_iam"."audit_event" WHERE "object_id" = $1) AS audits,
          (SELECT COALESCE("account_status", 'ACTIVE') FROM "zzsh_iam"."user_identity_state" WHERE "user_id" = $1) AS "accountStatus",
          (SELECT "suspended" FROM "zzsh_auth_user"."user" WHERE "id" = $1) AS suspended
      `, [userId])).rows[0],
      invalidMethodBefore.rows[0],
    );

    const minorUser = cookieJar();
    const minorSignup = await request(base, "/api/auth/user/sign-up/email", {
      email: "m2-minor@example.invalid",
      password: PASSWORD,
      name: "Fixture Minor",
      username: "m2_minor",
    }, minorUser, USER_ORIGIN);
    assert.equal(minorSignup.response.status, 200);
    const minorUserId = minorSignup.body?.user?.id as string;
    identityScenarios.set(minorUserId, "VERIFIED_MINOR");
    assert.equal((await request(base, "/api/auth/user/identity/verify", { fullName: "Fixture Minor", documentNumber: "fixture-minor" }, minorUser, USER_ORIGIN)).response.status, 200);
    const minorForgedAdult = await request(base, "/api/auth/user/trade-eligibility/check", { action: "protected_trade_eligibility_check", ageStatus: "ADULT" }, minorUser, USER_ORIGIN);
    assert.equal(minorForgedAdult.response.status, 403);
    assert.match(minorForgedAdult.body?.error?.message, /年龄/);

    const auditRollbackUser = cookieJar();
    const auditRollbackSignup = await request(base, "/api/auth/user/sign-up/email", {
      email: "m2-identity-rollback@example.invalid",
      password: PASSWORD,
      name: "Identity Rollback",
      username: "m2_identity_rollback",
    }, auditRollbackUser, USER_ORIGIN);
    assert.equal(auditRollbackSignup.response.status, 200);
    const auditRollbackUserId = auditRollbackSignup.body?.user?.id as string;
    identityScenarios.set(auditRollbackUserId, "VERIFIED_ADULT");
    await migrationPool.query(`REVOKE INSERT ON TABLE "zzsh_iam"."audit_event" FROM ${quotedIdentifier(resources.runtimeUser, "M2_AUTH_TEST_RUNTIME_USER")}`);
    const failedIdentityAudit = await request(base, "/api/auth/user/identity/verify", { fullName: "Fixture Adult", documentNumber: "fixture-audit-rollback" }, auditRollbackUser, USER_ORIGIN);
    assert.equal(failedIdentityAudit.response.status, 500);
    const failedIdentityState = await runtimePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_iam"."user_identity_state" WHERE "user_id" = $1`, [auditRollbackUserId]);
    assert.equal(failedIdentityState.rows[0]?.count, "0");
    await migrationPool.query(`GRANT INSERT ON TABLE "zzsh_iam"."audit_event" TO ${quotedIdentifier(resources.runtimeUser, "M2_AUTH_TEST_RUNTIME_USER")}`);

    const pendingCancelUser = cookieJar();
    const pendingCancelSignup = await request(base, "/api/auth/user/sign-up/email", {
      email: "m2-cancel-pending@example.invalid",
      password: PASSWORD,
      name: "Pending Cancellation",
      username: "m2_cancel_pending",
    }, pendingCancelUser, USER_ORIGIN);
    assert.equal(pendingCancelSignup.response.status, 200);
    const pendingCancelUserId = pendingCancelSignup.body?.user?.id as string;
    obligationStatuses.set(pendingCancelUserId, "PENDING");
    const pendingCancel = await request(base, "/api/auth/user/account/cancel", { reason: "need to close" }, pendingCancelUser, USER_ORIGIN);
    assert.equal(pendingCancel.response.status, 409);
    assert.match(pendingCancel.body?.error?.message, /未完成/);
    const pendingStillSession = await request(base, "/api/auth/user/get-session", undefined, pendingCancelUser, USER_ORIGIN);
    assert.equal(pendingStillSession.response.status, 200);
    assert.ok(pendingStillSession.body?.user?.id);

    const unknownCancelUser = cookieJar();
    const unknownCancelSignup = await request(base, "/api/auth/user/sign-up/email", {
      email: "m2-cancel-unknown@example.invalid",
      password: PASSWORD,
      name: "Unknown Cancellation",
      username: "m2_cancel_unknown",
    }, unknownCancelUser, USER_ORIGIN);
    assert.equal(unknownCancelSignup.response.status, 200);
    const unknownCancel = await request(base, "/api/auth/user/account/cancel", { reason: "need to close" }, unknownCancelUser, USER_ORIGIN);
    assert.equal(unknownCancel.response.status, 503);
    assert.match(unknownCancel.body?.error?.message, /无法确认/);

    const invalidObligationUser = cookieJar();
    const invalidObligationSignup = await request(base, "/api/auth/user/sign-up/email", {
      email: "m2-cancel-invalid-obligation@example.invalid",
      password: PASSWORD,
      name: "Invalid Obligation",
      username: "m2_cancel_invalid_obligation",
    }, invalidObligationUser, USER_ORIGIN);
    assert.equal(invalidObligationSignup.response.status, 200);
    const invalidObligationUserId = invalidObligationSignup.body?.user?.id as string;
    obligationStatuses.set(invalidObligationUserId, "INVALID");
    const invalidObligationCancel = await request(base, "/api/auth/user/account/cancel", { reason: "need to close" }, invalidObligationUser, USER_ORIGIN);
    assert.equal(invalidObligationCancel.response.status, 503);
    assert.match(invalidObligationCancel.body?.error?.message, /无法确认/);
    assert.ok((await request(base, "/api/auth/user/get-session", undefined, invalidObligationUser, USER_ORIGIN)).body?.user?.id);

    const failedObligationUser = cookieJar();
    const failedObligationSignup = await request(base, "/api/auth/user/sign-up/email", {
      email: "m2-cancel-obligation-fault@example.invalid",
      password: PASSWORD,
      name: "Obligation Fault",
      username: "m2_cancel_obligation_fault",
    }, failedObligationUser, USER_ORIGIN);
    assert.equal(failedObligationSignup.response.status, 200);
    const failedObligationUserId = failedObligationSignup.body?.user?.id as string;
    obligationFailures.add(failedObligationUserId);
    const failedObligationCancel = await request(base, "/api/auth/user/account/cancel", { reason: "need to close" }, failedObligationUser, USER_ORIGIN);
    assert.equal(failedObligationCancel.response.status, 503);
    assert.match(failedObligationCancel.body?.error?.message, /无法确认/);
    assert.ok((await request(base, "/api/auth/user/get-session", undefined, failedObligationUser, USER_ORIGIN)).body?.user?.id);

    const barrierCancelUser = cookieJar();
    const barrierCancelSignup = await request(base, "/api/auth/user/sign-up/email", {
      email: "m2-cancel-barrier@example.invalid",
      password: PASSWORD,
      name: "Barrier Cancellation",
      username: "m2_cancel_barrier",
    }, barrierCancelUser, USER_ORIGIN);
    assert.equal(barrierCancelSignup.response.status, 200);
    const barrierCancelUserId = barrierCancelSignup.body?.user?.id as string;
    obligationStatuses.set(barrierCancelUserId, "NONE");
    let obligationReaderStarted!: () => void;
    const obligationReaderStartedPromise = new Promise<void>((resolve) => { obligationReaderStarted = resolve; });
    let releaseObligationReader!: () => void;
    const releaseObligationReaderPromise = new Promise<void>((resolve) => { releaseObligationReader = resolve; });
    obligationBarriers.set(barrierCancelUserId, { started: obligationReaderStarted, release: releaseObligationReaderPromise });
    const barrierCancelPromise = request(base, "/api/auth/user/account/cancel", { reason: "close after check" }, barrierCancelUser, USER_ORIGIN);
    let barrierTimeoutId: ReturnType<typeof setTimeout> | undefined;
    const barrierTimeout = new Promise<never>((_, reject) => {
      barrierTimeoutId = setTimeout(() => reject(new Error("obligation reader barrier did not open")), 5_000);
    });
    try {
      await Promise.race([obligationReaderStartedPromise, barrierTimeout]);
    } finally {
      if (barrierTimeoutId) clearTimeout(barrierTimeoutId);
    }
    const competingClient = await migrationPool!.connect();
    try {
      await competingClient.query("SET lock_timeout = '100ms'");
      let competitionError: unknown;
      try {
        await competingClient.query(`UPDATE "zzsh_auth_user"."user" SET "updatedAt" = "updatedAt" WHERE "id" = $1`, [barrierCancelUserId]);
      } catch (error) {
        competitionError = error;
      }
      assert.equal((competitionError as { code?: string } | undefined)?.code, "55P03", "obligation check must share the locked account boundary");
    } finally {
      try { await competingClient.query("ROLLBACK"); } catch { /* preserve the primary assertion */ }
      releaseObligationReader();
      const barrierCancelled = await barrierCancelPromise;
      assert.equal(barrierCancelled.response.status, 200);
      obligationBarriers.delete(barrierCancelUserId);
      competingClient.release();
    }

    const deactivateUser = cookieJar();
    const deactivateSignup = await request(base, "/api/auth/user/sign-up/email", {
      email: "m2-deactivate@example.invalid",
      password: PASSWORD,
      name: "Deactivate Me",
      username: "m2_deactivate",
    }, deactivateUser, USER_ORIGIN);
    assert.equal(deactivateSignup.response.status, 200);
    const deactivateUserId = deactivateSignup.body?.user?.id as string;
    await migrationPool.query(
      `INSERT INTO "zzsh_auth_user"."verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES ($1, $2, 'fixture', clock_timestamp() + interval '10 minutes', clock_timestamp(), clock_timestamp())`,
      [`verification_${randomUUID().replaceAll("-", "")}`, "m2-deactivate@example.invalid"],
    );
    const deactivated = await request(base, "/api/auth/user/account/deactivate", { reason: "no longer needed" }, deactivateUser, USER_ORIGIN);
    assert.equal(deactivated.response.status, 200);
    assert.equal(deactivated.body?.status, "DEACTIVATED");
    assert.equal((await request(base, "/api/auth/user/get-session", undefined, deactivateUser, USER_ORIGIN)).body, null);
    const deactivatedRows = await runtimePool.query<{ accountStatus: string; suspended: boolean; verifications: string }>(`
      SELECT s."account_status" AS "accountStatus", u."suspended",
        (SELECT count(*)::text FROM "zzsh_auth_user"."verification" WHERE "identifier" = 'm2-deactivate@example.invalid') AS verifications
      FROM "zzsh_iam"."user_identity_state" s JOIN "zzsh_auth_user"."user" u ON u."id" = s."user_id" WHERE s."user_id" = $1`, [deactivateUserId]);
    assert.deepEqual(deactivatedRows.rows[0], { accountStatus: "DEACTIVATED", suspended: true, verifications: "0" });

    const cancelUser = cookieJar();
    const cancelSignup = await request(base, "/api/auth/user/sign-up/email", {
      email: "m2-cancel@example.invalid",
      password: PASSWORD,
      name: "Cancel Me",
      username: "m2_cancel",
    }, cancelUser, USER_ORIGIN);
    assert.equal(cancelSignup.response.status, 200);
    const cancelUserId = cancelSignup.body?.user?.id as string;
    obligationStatuses.set(cancelUserId, "NONE");
    await migrationPool.query(
      `INSERT INTO "zzsh_auth_user"."verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES ($1, $2, 'fixture', clock_timestamp() + interval '10 minutes', clock_timestamp(), clock_timestamp())`,
      [`verification_${randomUUID().replaceAll("-", "")}`, "m2-cancel@example.invalid"],
    );
    const cancelled = await request(base, "/api/auth/user/account/cancel", { reason: "close account" }, cancelUser, USER_ORIGIN);
    assert.equal(cancelled.response.status, 200);
    assert.equal(cancelled.body?.status, "CANCELLED");
    assert.equal((await request(base, "/api/auth/user/get-session", undefined, cancelUser, USER_ORIGIN)).body, null);
    const cancelledRows = await runtimePool.query<{ name: string; email: string; username: string | null; phone: string | null; accountStatus: string; verifications: string; auditCount: string }>(`
      SELECT u."name", u."email", u."username", u."phoneNumber" AS phone, s."account_status" AS "accountStatus",
        (SELECT count(*)::text FROM "zzsh_auth_user"."verification" WHERE "identifier" = 'm2-cancel@example.invalid') AS verifications,
        (SELECT count(*)::text FROM "zzsh_iam"."audit_event" WHERE "action" = 'user.account.cancelled' AND "object_id" = $1) AS "auditCount"
      FROM "zzsh_iam"."user_identity_state" s JOIN "zzsh_auth_user"."user" u ON u."id" = s."user_id" WHERE s."user_id" = $1`, [cancelUserId]);
    assert.equal(cancelledRows.rows[0]?.accountStatus, "CANCELLED");
    assert.match(cancelledRows.rows[0]?.name ?? "", /^已注销用户-/);
    assert.match(cancelledRows.rows[0]?.email ?? "", /@anonymized\.invalid$/);
    assert.equal(cancelledRows.rows[0]?.username, null);
    assert.equal(cancelledRows.rows[0]?.phone, null);
    assert.equal(cancelledRows.rows[0]?.verifications, "0");
    assert.equal(cancelledRows.rows[0]?.auditCount, "1");

    const auditUpdate = runtimePool.query(`UPDATE "zzsh_iam"."audit_event" SET "reason" = 'tamper'`);
    const auditDelete = runtimePool.query(`DELETE FROM "zzsh_iam"."audit_event"`);
    await assert.rejects(auditUpdate, /permission denied/);
    await assert.rejects(auditDelete, /permission denied/);

    const crossRealm = await request(base, "/api/auth/admin/get-session", undefined, user, ADMIN_ORIGIN);
    assert.equal(crossRealm.response.status, 200);
    assert.equal(crossRealm.body, null);
    const hostile = await request(base, "/api/auth/user/sign-in/username", {
      username: "m2_user",
      password: PASSWORD,
    }, cookieJar(), "https://untrusted.invalid");
    assert.equal(hostile.response.status, 403);
    assert.equal(hostile.body?.error?.requestId, hostile.response.headers.get("x-request-id"));

    const phone = "+8613800000000";
    const otpSent = await request(base, "/api/auth/user/phone-number/send-otp", { phoneNumber: phone }, cookieJar(), USER_ORIGIN);
    assert.equal(otpSent.response.status, 200);
    const delivery = fakeSmsOutbox.get(phone);
    assert.ok(delivery);
    assert.equal(delivery.purpose, "phone-verification");
    assert.match(delivery.code, /^\d{6}$/);
    const phoneSession = cookieJar();
    const phoneVerified = await request(base, "/api/auth/user/phone-number/verify", {
      phoneNumber: phone,
      code: delivery.code,
    }, phoneSession, USER_ORIGIN);
    assert.equal(phoneVerified.response.status, 200);
    assert.equal(phoneVerified.body?.status, true);
    const consumedOtp = await runtimePool.query<{ count: string; verified: boolean }>(`
      SELECT
        (SELECT count(*)::text FROM "zzsh_auth_user"."verification" WHERE "identifier" = $1) AS count,
        (SELECT "phoneNumberVerified" FROM "zzsh_auth_user"."user" WHERE "phoneNumber" = $1) AS verified
    `, [phone]);
    assert.deepEqual(consumedOtp.rows[0], { count: "0", verified: true });

    const resetRequested = await request(base, "/api/auth/user/phone-number/request-password-reset", { phoneNumber: phone }, cookieJar(), USER_ORIGIN);
    assert.equal(resetRequested.response.status, 200);
    const resetDelivery = fakeSmsOutbox.get(`${phone}-request-password-reset`);
    assert.ok(resetDelivery);
    assert.equal(resetDelivery.purpose, "password-reset");
    const wrongPurposeReset = await request(base, "/api/auth/user/phone-number/reset-password", {
      phoneNumber: phone,
      otp: resetDelivery.code === delivery.code ? "000000" : delivery.code,
      newPassword: PASSWORD,
    }, cookieJar(), USER_ORIGIN);
    assert.ok(wrongPurposeReset.response.status >= 400);
    const phoneReset = await request(base, "/api/auth/user/phone-number/reset-password", {
      phoneNumber: phone,
      otp: resetDelivery.code,
      newPassword: PASSWORD,
    }, cookieJar(), USER_ORIGIN);
    assert.equal(phoneReset.response.status, 200);
    const resetReplay = await request(base, "/api/auth/user/phone-number/reset-password", {
      phoneNumber: phone,
      otp: resetDelivery.code,
      newPassword: PASSWORD,
    }, cookieJar(), USER_ORIGIN);
    assert.ok(resetReplay.response.status >= 400);
    const resetVerification = await runtimePool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "zzsh_auth_user"."verification" WHERE "identifier" = $1`,
      [`${phone}-request-password-reset`],
    );
    assert.equal(resetVerification.rows[0]?.count, "0");
    const revokedPhoneSession = await request(base, "/api/auth/user/get-session", undefined, phoneSession, USER_ORIGIN);
    assert.equal(revokedPhoneSession.response.status, 200);
    assert.equal(revokedPhoneSession.body, null);
    const phoneLogin = await request(base, "/api/auth/user/sign-in/phone-number", { phoneNumber: phone, password: PASSWORD }, cookieJar(), USER_ORIGIN);
    assert.equal(phoneLogin.response.status, 200);

    const legacyUserId = `user_${randomUUID().replaceAll("-", "")}`;
    const legacyNow = new Date();
    await migrationPool.query(
      `INSERT INTO "zzsh_auth_user"."user" ("id", "name", "email", "createdAt", "updatedAt", "username") VALUES ($1, $2, $3, $4, $4, $5)`,
      [legacyUserId, "Legacy User", "legacy-user@example.invalid", legacyNow, "legacy_user"],
    );
    await migrationPool.query(
      `INSERT INTO "zzsh_auth_user"."account" ("id", "accountId", "providerId", "userId", "password", "legacyPasswordMd5", "legacyPasswordVersion", "createdAt", "updatedAt") VALUES ($1, $2, 'credential', $2, NULL, $3, 'legacy-md5-v0', $4, $4)`,
      [`account_${randomUUID().replaceAll("-", "")}`, legacyUserId, createHash("md5").update(LEGACY_PASSWORD).digest("hex"), legacyNow],
    );
    const legacyWrong = await request(base, "/api/v1/auth/user/legacy-sign-in", { username: "legacy_user", password: "wrong-legacy-password" }, cookieJar(), USER_ORIGIN);
    assert.equal(legacyWrong.response.status, 401);
    const legacyAttempts = await Promise.all([
      request(base, "/api/v1/auth/user/legacy-sign-in", { username: "legacy_user", password: LEGACY_PASSWORD }, cookieJar(), USER_ORIGIN),
      request(base, "/api/v1/auth/user/legacy-sign-in", { username: "legacy_user", password: LEGACY_PASSWORD }, cookieJar(), USER_ORIGIN),
    ]);
    assert.equal(legacyAttempts.filter((attempt) => attempt.response.status === 200).length, 1);
    assert.equal(legacyAttempts.filter((attempt) => attempt.response.status >= 400).length, 1);
    const legacyAccount = await runtimePool.query<{ legacy: string | null; password: string | null }>(
      `SELECT "legacyPasswordMd5" AS legacy, "password" FROM "zzsh_auth_user"."account" WHERE "userId" = $1`,
      [legacyUserId],
    );
    assert.equal(legacyAccount.rows[0]?.legacy, null);
    assert.notEqual(legacyAccount.rows[0]?.password, null);
    const legacyAudit = await runtimePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_iam"."audit_event" WHERE "action" = 'user.legacy_password.upgraded'`);
    assert.equal(legacyAudit.rows[0]?.count, "1");
    const legacySuccess = legacyAttempts.find((attempt) => attempt.response.status === 200)!;
    assert.equal(typeof legacySuccess.body?.token, "string");
    const legacySession = await request(base, "/api/auth/user/get-session", undefined, cookieJar(), USER_ORIGIN, legacySuccess.body?.token as string);
    assert.equal(legacySession.response.status, 200);
    assert.equal(legacySession.body?.user?.username, "legacy_user");

    const saltedLegacyUserId = `user_${randomUUID().replaceAll("-", "")}`;
    const saltedLegacySalt = "aB3dE";
    const saltedLegacyPassword = randomBytes(24).toString("base64url");
    await migrationPool.query(
      `INSERT INTO "zzsh_auth_user"."user" ("id", "name", "email", "createdAt", "updatedAt", "username") VALUES ($1, $2, $3, $4, $4, $5)`,
      [saltedLegacyUserId, "Salted Legacy User", "salted-legacy@example.invalid", legacyNow, "salted_legacy_user"],
    );
    await migrationPool.query(
      `INSERT INTO "zzsh_auth_user"."account" ("id", "accountId", "providerId", "userId", "password", "legacyPasswordMd5", "legacyPasswordVersion", "legacyPasswordSalt", "createdAt", "updatedAt") VALUES ($1, $2, 'credential', $2, NULL, $3, 'legacy-md5-v1', $4, $5, $5)`,
      [`account_${randomUUID().replaceAll("-", "")}`, saltedLegacyUserId, createHash("md5").update(saltedLegacyPassword + saltedLegacySalt).digest("hex"), saltedLegacySalt, legacyNow],
    );
    const saltedWrong = await request(base, "/api/v1/auth/user/legacy-sign-in", { username: "salted_legacy_user", password: saltedLegacyPassword + "wrong" }, cookieJar(), USER_ORIGIN);
    assert.equal(saltedWrong.response.status, 401);
    const saltedSuccess = await request(base, "/api/v1/auth/user/legacy-sign-in", { username: "salted_legacy_user", password: saltedLegacyPassword }, cookieJar(), USER_ORIGIN);
    assert.equal(saltedSuccess.response.status, 200);
    const saltedLegacyAccount = await runtimePool.query<{ legacy: string | null; version: string | null; salt: string | null; password: string | null }>(
      `SELECT "legacyPasswordMd5" AS legacy, "legacyPasswordVersion" AS version, "legacyPasswordSalt" AS salt, "password" FROM "zzsh_auth_user"."account" WHERE "userId" = $1`,
      [saltedLegacyUserId],
    );
    assert.deepEqual(saltedLegacyAccount.rows[0], { legacy: null, version: null, salt: null, password: saltedLegacyAccount.rows[0]?.password });

    const legacyRollbackUserId = `user_${randomUUID().replaceAll("-", "")}`;
    const legacyRollbackPassword = randomBytes(24).toString("base64url");
    const legacyRollbackHash = createHash("md5").update(legacyRollbackPassword).digest("hex");
    await migrationPool.query(
      `INSERT INTO "zzsh_auth_user"."user" ("id", "name", "email", "createdAt", "updatedAt", "username") VALUES ($1, $2, $3, $4, $4, $5)`,
      [legacyRollbackUserId, "Legacy Rollback", "legacy-rollback@example.invalid", legacyNow, "legacy_rollback"],
    );
    await migrationPool.query(
      `INSERT INTO "zzsh_auth_user"."account" ("id", "accountId", "providerId", "userId", "password", "legacyPasswordMd5", "legacyPasswordVersion", "createdAt", "updatedAt") VALUES ($1, $2, 'credential', $2, NULL, $3, 'legacy-md5-v0', $4, $4)`,
      [`account_${randomUUID().replaceAll("-", "")}`, legacyRollbackUserId, legacyRollbackHash, legacyNow],
    );
    await migrationPool.query(`REVOKE INSERT ON TABLE "zzsh_iam"."audit_event" FROM ${quotedIdentifier(resources.runtimeUser, "M2_AUTH_TEST_RUNTIME_USER")}`);
    const failedLegacyUpgrade = await request(base, "/api/v1/auth/user/legacy-sign-in", { username: "legacy_rollback", password: legacyRollbackPassword }, cookieJar(), USER_ORIGIN);
    assert.equal(failedLegacyUpgrade.response.status, 500);
    const rollbackLegacyAccount = await runtimePool.query<{ legacy: string | null; version: string | null; password: string | null }>(
      `SELECT "legacyPasswordMd5" AS legacy, "legacyPasswordVersion" AS version, "password" FROM "zzsh_auth_user"."account" WHERE "userId" = $1`,
      [legacyRollbackUserId],
    );
    assert.deepEqual(rollbackLegacyAccount.rows[0], { legacy: legacyRollbackHash, version: "legacy-md5-v0", password: null });
    await migrationPool.query(`GRANT INSERT ON TABLE "zzsh_iam"."audit_event" TO ${quotedIdentifier(resources.runtimeUser, "M2_AUTH_TEST_RUNTIME_USER")}`);

    const firstBootstrap = await request(base, "/api/v1/admin/security/bootstrap", {
      bootstrapSecret: ADMIN_BOOTSTRAP_SECRET,
      name: "Boss One",
      password: BOSS_ONE_TEMP_PASSWORD,
    }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(firstBootstrap.response.status, 200);
    const initialAdminId = firstBootstrap.body?.adminUserId as string;
    const initialAdminUsername = firstBootstrap.body?.username as string;
    assert.match(initialAdminUsername, /^zz\d{5,}$/);
    assert.equal(firstBootstrap.body?.displayUsername, initialAdminUsername.toUpperCase());
    assert.equal(firstBootstrap.body?.passwordChangeRequired, true);
    const secondBootstrap = await request(base, "/api/v1/admin/security/bootstrap", {
      bootstrapSecret: ADMIN_BOOTSTRAP_SECRET,
      email: "boss-two@example.invalid",
      name: "Boss Two",
      password: BOSS_TWO_TEMP_PASSWORD,
    }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(secondBootstrap.response.status, 200);
    const adminTwoId = secondBootstrap.body?.adminUserId as string;
    assert.notEqual(initialAdminId, adminTwoId);
    await runtimePool.query(`UPDATE "zzsh_iam"."admin_security" SET "bootstrap_expires_at" = clock_timestamp() - interval '1 second' WHERE "admin_user_id" = $1`, [initialAdminId]);
    const expiredBootstrapAdmin = cookieJar();
    assert.equal((await request(base, "/api/auth/admin/sign-in/username", { username: initialAdminUsername.toUpperCase(), password: BOSS_ONE_TEMP_PASSWORD }, expiredBootstrapAdmin, ADMIN_ORIGIN)).response.status, 200);
    const expiredBootstrapEnabled = await request(base, "/api/auth/admin/two-factor/enable", { password: BOSS_ONE_TEMP_PASSWORD }, expiredBootstrapAdmin, ADMIN_ORIGIN);
    assert.equal(expiredBootstrapEnabled.response.status, 403);
    const expiredBootstrapActivation = await request(base, "/api/v1/admin/security/enrollment/activate", {}, expiredBootstrapAdmin, ADMIN_ORIGIN);
    assert.equal(expiredBootstrapActivation.response.status, 403);
    const reinitializedBootstrap = await request(base, "/api/v1/admin/security/bootstrap", {
      bootstrapSecret: ADMIN_BOOTSTRAP_SECRET,
      name: "Boss One Reinitialized",
      password: BOSS_ONE_TEMP_PASSWORD,
    }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(reinitializedBootstrap.response.status, 200);
    const adminId = reinitializedBootstrap.body?.adminUserId as string;
    assert.notEqual(adminId, initialAdminId);
    const adminUsername = reinitializedBootstrap.body?.username as string;
    assert.match(adminUsername, /^zz\d{5,}$/);
    assert.notEqual(adminUsername, initialAdminUsername);
    assert.equal(reinitializedBootstrap.body?.passwordChangeRequired, true);
    const thirdBootstrap = await request(base, "/api/v1/admin/security/bootstrap", {
      bootstrapSecret: ADMIN_BOOTSTRAP_SECRET,
      email: "boss-three@example.invalid",
      name: "Boss Three",
      password: randomBytes(24).toString("base64url"),
    }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(thirdBootstrap.response.status, 409);

    const admin = cookieJar();
    const adminLogin = await request(base, "/api/auth/admin/sign-in/username", { username: adminUsername.toUpperCase(), password: BOSS_ONE_TEMP_PASSWORD }, admin, ADMIN_ORIGIN);
    assert.equal(adminLogin.response.status, 200);
    assert.equal(typeof adminLogin.body?.token, "string");
    const sameAdminPassword = await request(base, "/api/auth/admin/change-password", {
      currentPassword: BOSS_ONE_TEMP_PASSWORD,
      newPassword: BOSS_ONE_TEMP_PASSWORD,
    }, admin, ADMIN_ORIGIN);
    assert.equal(sameAdminPassword.response.status, 400);
    const unchangedPasswordGate = await runtimePool.query<{ passwordChangeRequired: boolean }>(
      `SELECT "password_change_required" AS "passwordChangeRequired" FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1`,
      [adminId],
    );
    assert.equal(unchangedPasswordGate.rows[0]?.passwordChangeRequired, true);
    assert.equal((await request(base, "/api/auth/admin/two-factor/enable", { password: BOSS_ONE_TEMP_PASSWORD }, admin, ADMIN_ORIGIN)).response.status, 403);
    const adminOther = cookieJar();
    assert.equal((await request(base, "/api/auth/admin/sign-in/username", { username: adminUsername, password: BOSS_ONE_TEMP_PASSWORD }, adminOther, ADMIN_ORIGIN)).response.status, 200);
    const passwordChanged = await request(base, "/api/auth/admin/change-password", {
      currentPassword: BOSS_ONE_TEMP_PASSWORD,
      newPassword: BOSS_ONE_PASSWORD,
      revokeOtherSessions: false,
    }, admin, ADMIN_ORIGIN);
    assert.equal(passwordChanged.response.status, 200);
    assert.equal(typeof passwordChanged.body?.token, "string");
    const revokedAdminOther = await request(base, "/api/auth/admin/get-session", undefined, adminOther, ADMIN_ORIGIN);
    assert.equal(revokedAdminOther.response.status, 200);
    assert.equal(revokedAdminOther.body, null);
    const adminBearer = passwordChanged.body?.token as string;
    const oldPasswordRejected = await request(base, "/api/auth/admin/sign-in/username", { username: adminUsername, password: BOSS_ONE_TEMP_PASSWORD }, cookieJar(), ADMIN_ORIGIN);
    assert.ok([401, 403].includes(oldPasswordRejected.response.status));
    const bearerSession = await request(base, "/api/auth/admin/get-session", undefined, cookieJar(), ADMIN_ORIGIN, adminBearer);
    assert.equal(bearerSession.response.status, 200);
    const conflictingCredentials = await request(base, "/api/auth/admin/get-session", undefined, admin, ADMIN_ORIGIN, adminBearer);
    assert.equal(conflictingCredentials.response.status, 400);
    assert.equal(conflictingCredentials.body?.error?.code, "INVALID_ARGUMENT");
    const restrictedBeforeTwoFactor = await request(base, "/api/auth/admin/two-factor/generate-backup-codes", undefined, admin, ADMIN_ORIGIN);
    assert.equal(restrictedBeforeTwoFactor.response.status, 403);
    const enabled = await request(base, "/api/auth/admin/two-factor/enable", { password: BOSS_ONE_PASSWORD }, admin, ADMIN_ORIGIN);
    assert.equal(enabled.response.status, 200);
    const totpUri = enabled.body?.totpURI as string;
    const secret = new URL(totpUri).searchParams.get("secret");
    assert.ok(secret);
    const enrolled = await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(secret) }, admin, ADMIN_ORIGIN);
    assert.equal(enrolled.response.status, 200);
    const activateOne = await request(base, "/api/v1/admin/security/enrollment/activate", {}, admin, ADMIN_ORIGIN);
    assert.equal(activateOne.response.status, 200);

    const adminTwo = cookieJar();
    const adminTwoUsername = secondBootstrap.body?.username as string;
    assert.match(adminTwoUsername, /^zz\d{5,}$/);
    const adminTwoLogin = await request(base, "/api/auth/admin/sign-in/username", { username: adminTwoUsername.toUpperCase(), password: BOSS_TWO_TEMP_PASSWORD }, adminTwo, ADMIN_ORIGIN);
    assert.equal(adminTwoLogin.response.status, 200);
    const adminTwoPasswordChanged = await request(base, "/api/auth/admin/change-password", {
      currentPassword: BOSS_TWO_TEMP_PASSWORD,
      newPassword: BOSS_TWO_PASSWORD,
      revokeOtherSessions: true,
    }, adminTwo, ADMIN_ORIGIN);
    assert.equal(adminTwoPasswordChanged.response.status, 200);
    const enabledTwo = await request(base, "/api/auth/admin/two-factor/enable", { password: BOSS_TWO_PASSWORD }, adminTwo, ADMIN_ORIGIN);
    assert.equal(enabledTwo.response.status, 200);
    const secretTwo = new URL(enabledTwo.body?.totpURI as string).searchParams.get("secret");
    assert.ok(secretTwo);
    const adminTwoVerified = await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(secretTwo) }, adminTwo, ADMIN_ORIGIN);
    assert.equal(adminTwoVerified.response.status, 200);
    const adminTwoBearer = adminTwoVerified.body?.token as string;
    assert.equal((await request(base, "/api/v1/admin/security/enrollment/activate", {}, adminTwo, ADMIN_ORIGIN)).response.status, 200);
    const bossCount = await runtimePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_iam"."admin_security" WHERE "is_boss" = true`);
    assert.equal(bossCount.rows[0]?.count, "2");
    await runtimePool.query(`UPDATE "zzsh_iam"."admin_security" SET "bootstrap_expires_at" = clock_timestamp() - interval '1 second' WHERE "admin_user_id" = $1`, [adminId]);
    const activeBossReplacement = await request(base, "/api/v1/admin/security/bootstrap", {
      bootstrapSecret: ADMIN_BOOTSTRAP_SECRET,
      email: "boss-three@example.invalid",
      name: "Boss Three",
      password: randomBytes(24).toString("base64url"),
    }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(activeBossReplacement.response.status, 409);

    const freshAdmin = cookieJar();
    const secondLogin = await request(base, "/api/auth/admin/sign-in/username", { username: adminUsername, password: BOSS_ONE_PASSWORD }, freshAdmin, ADMIN_ORIGIN);
    assert.equal(secondLogin.response.status, 200);
    assert.equal(secondLogin.body?.twoFactorRedirect, true);
    const recovered = await request(base, "/api/auth/admin/two-factor/verify-backup-code", { code: enabled.body?.backupCodes?.[0] }, freshAdmin, ADMIN_ORIGIN);
    assert.equal(recovered.response.status, 200);
    assert.equal(typeof recovered.body?.token, "string");
    const verifiedBearer = recovered.body?.token as string;
    const backupCodeReplay = await request(base, "/api/auth/admin/two-factor/verify-backup-code", { code: enabled.body?.backupCodes?.[0] }, freshAdmin, ADMIN_ORIGIN);
    assert.ok(backupCodeReplay.response.status >= 400);
    const adminSession = await request(base, "/api/auth/admin/get-session", undefined, freshAdmin, ADMIN_ORIGIN);
    assert.equal(adminSession.response.status, 200);
    assert.ok(adminSession.body);
    const adminLifetime = new Date(adminSession.body.session.expiresAt).getTime() - new Date(adminSession.body.session.createdAt).getTime();
    assert.ok(Math.abs(adminLifetime - 7 * 24 * 60 * 60 * 1000) < 2_000);

    const bffAdmin = cookieJar();
    const bffLogin = await request(base, "/api/bff/admin/auth/sign-in/username", { username: adminUsername.toUpperCase(), password: BOSS_ONE_PASSWORD }, bffAdmin, ADMIN_ORIGIN);
    assert.equal(bffLogin.response.status, 200);
    assert.equal(bffLogin.body?.twoFactorRedirect, true);
    assert.equal(bffLogin.body?.token, undefined, "Admin BFF must not expose a bearer token to the browser");
    assertNoTokenHeaders(bffLogin.response);
    const bffVerified = await request(base, "/api/bff/admin/auth/two-factor/verify-totp", { code: totpCode(secret) }, bffAdmin, ADMIN_ORIGIN);
    assert.equal(bffVerified.response.status, 200);
    assert.equal(bffVerified.body?.token, undefined, "Admin BFF must not expose a bearer token after 2FA");
    assertNoTokenHeaders(bffVerified.response);
    const bffSession = await request(base, "/api/bff/admin/session", undefined, bffAdmin, ADMIN_ORIGIN);
    assert.equal(bffSession.response.status, 200);
    assert.equal(bffSession.body?.authenticated, true);
    assert.equal(bffSession.body?.session?.pinConfigured, false);
    assert.equal(bffSession.body?.security?.passwordChangeRequired, false);
    assert.equal(bffSession.body?.session?.token, undefined);
    const bffDirectory = await request(base, "/api/bff/admin/security/admins", undefined, bffAdmin, ADMIN_ORIGIN);
    assert.equal(bffDirectory.response.status, 200);
    assert.ok(bffDirectory.body?.admins?.some((entry: { username?: string }) => entry.username === adminUsername.toUpperCase()));
    assert.equal(bffDirectory.body?.admins?.some((entry: Record<string, unknown>) => "email" in entry || "phoneNumber" in entry), false);
    const bffBackupCodes = await request(base, "/api/bff/admin/auth/two-factor/generate-backup-codes", { password: BOSS_ONE_PASSWORD }, bffAdmin, ADMIN_ORIGIN);
    assert.equal(bffBackupCodes.response.status, 200);
    assertNoTokenHeaders(bffBackupCodes.response);
    assert.equal((await request(base, "/api/bff/admin/security/pin/set", { pin: "246810" }, bffAdmin, ADMIN_ORIGIN)).response.status, 200);
    assert.equal((await request(base, "/api/bff/admin/security/pin/lock", {}, bffAdmin, ADMIN_ORIGIN)).response.status, 200);
    const bffLockedSession = await request(base, "/api/bff/admin/session", undefined, bffAdmin, ADMIN_ORIGIN);
    assert.equal(bffLockedSession.body?.session?.locked, true);
    assert.equal((await request(base, "/api/bff/admin/auth/two-factor/enable", { password: BOSS_ONE_PASSWORD }, bffAdmin, ADMIN_ORIGIN)).response.status, 423);
    assert.equal((await request(base, "/api/bff/admin/auth/two-factor/generate-backup-codes", { password: BOSS_ONE_PASSWORD }, bffAdmin, ADMIN_ORIGIN)).response.status, 423);
    const bffBearerRejected = await request(base, "/api/bff/admin/session", undefined, cookieJar(), ADMIN_ORIGIN, verifiedBearer);
    assert.equal(bffBearerRejected.response.status, 400);
    assert.equal((await request(base, "/api/bff/admin/security/pin/unlock", { pin: "246810" }, bffAdmin, ADMIN_ORIGIN)).response.status, 200);
    assert.equal((await request(base, "/api/bff/admin/security/pin/lock", {}, bffAdmin, ADMIN_ORIGIN)).response.status, 200);
    const bffReauthenticated = await request(base, "/api/bff/admin/security/pin/unlock", { password: BOSS_ONE_PASSWORD, totpCode: totpCode(secret) }, bffAdmin, ADMIN_ORIGIN);
    assert.equal(bffReauthenticated.response.status, 200);
    assert.equal(bffReauthenticated.body?.pinReset, false);

    const bffFrozenChallenge = cookieJar();
    const bffFrozenLogin = await request(base, "/api/bff/admin/auth/sign-in", { email: "boss-two@example.invalid", password: BOSS_TWO_PASSWORD }, bffFrozenChallenge, ADMIN_ORIGIN);
    assert.equal(bffFrozenLogin.response.status, 200);
    assert.equal(bffFrozenLogin.body?.twoFactorRedirect, true);
    assertNoTokenHeaders(bffFrozenLogin.response);
    assert.equal((await request(base, "/api/v1/admin/security/freeze", { targetAdminId: adminTwoId, password: BOSS_ONE_PASSWORD, totpCode: totpCode(secret), reason: "BFF challenge 冻结验证" }, freshAdmin, ADMIN_ORIGIN)).response.status, 200);
    const bffFrozenVerify = await request(base, "/api/bff/admin/auth/two-factor/verify-totp", { code: totpCode(secretTwo) }, bffFrozenChallenge, ADMIN_ORIGIN);
    assert.ok([401, 403].includes(bffFrozenVerify.response.status));
    assert.equal((await request(base, "/api/v1/admin/security/unfreeze", { targetAdminId: adminTwoId, password: BOSS_ONE_PASSWORD, totpCode: totpCode(secret), reason: "BFF challenge 冻结验证结束" }, freshAdmin, ADMIN_ORIGIN)).response.status, 200);

    assert.equal((await request(base, "/api/v1/admin/security/pin/set", { pin: "123456" }, freshAdmin, ADMIN_ORIGIN)).response.status, 200);
    assert.equal((await request(base, "/api/v1/admin/security/pin/change", { currentPin: "123456", newPin: "654321" }, freshAdmin, ADMIN_ORIGIN)).response.status, 200);
    await migrationPool.query(`REVOKE INSERT ON TABLE "zzsh_iam"."audit_event" FROM ${quotedIdentifier(resources.runtimeUser, "M2_AUTH_TEST_RUNTIME_USER")}`);
    const failedManualLock = await request(base, "/api/v1/admin/security/pin/lock", {}, freshAdmin, ADMIN_ORIGIN);
    assert.equal(failedManualLock.response.status, 500);
    await migrationPool.query(`GRANT INSERT ON TABLE "zzsh_iam"."audit_event" TO ${quotedIdentifier(resources.runtimeUser, "M2_AUTH_TEST_RUNTIME_USER")}`);
    assert.equal((await request(base, "/api/v1/admin/security/pin/lock", {}, freshAdmin, ADMIN_ORIGIN)).response.status, 200);
    assert.equal((await request(base, "/api/auth/admin/two-factor/generate-backup-codes", undefined, freshAdmin, ADMIN_ORIGIN)).response.status, 423);
    assert.equal((await request(base, "/api/v1/admin/security/pin/unlock", { pin: "654321" }, freshAdmin, ADMIN_ORIGIN)).response.status, 200);
    assert.equal((await request(base, "/api/v1/admin/security/pin/lock", {}, freshAdmin, ADMIN_ORIGIN)).response.status, 200);
    const pinFailures: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      pinFailures.push((await request(base, "/api/v1/admin/security/pin/unlock", { pin: "000000" }, freshAdmin, ADMIN_ORIGIN)).response.status);
    }
    assert.deepEqual(pinFailures.slice(0, 4), [401, 401, 401, 401]);
    assert.equal(pinFailures[4], 423);
    const lockedCookie = await request(base, "/api/auth/admin/two-factor/generate-backup-codes", undefined, freshAdmin, ADMIN_ORIGIN);
    assert.equal(lockedCookie.response.status, 423);
    const lockedMobile = await request(base, "/api/auth/admin/two-factor/generate-backup-codes", undefined, freshAdmin, ADMIN_ORIGIN, undefined, {
      "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)",
    });
    assert.equal(lockedMobile.response.status, 423);
    const lockedBearer = await request(base, "/api/auth/admin/two-factor/generate-backup-codes", undefined, cookieJar(), ADMIN_ORIGIN, verifiedBearer);
    assert.equal(lockedBearer.response.status, 423);
    assert.equal((await request(base, "/api/v1/admin/security/pin/unlock", { pin: "654321" }, freshAdmin, ADMIN_ORIGIN)).response.status, 423);
    assert.equal((await request(base, "/api/v1/admin/security/pin/unlock", { password: BOSS_ONE_PASSWORD, totpCode: totpCode(secret), newPin: "112233" }, freshAdmin, ADMIN_ORIGIN)).response.status, 200);
    assert.equal((await request(base, "/api/auth/admin/two-factor/generate-backup-codes", { password: BOSS_ONE_PASSWORD }, freshAdmin, ADMIN_ORIGIN)).response.status, 200);
    const regenerateChallenge = cookieJar();
    assert.equal((await request(base, "/api/auth/admin/sign-in/username", { username: adminUsername, password: BOSS_ONE_PASSWORD }, regenerateChallenge, ADMIN_ORIGIN)).body?.twoFactorRedirect, true);
    const oldUnusedBackupCode = enabled.body?.backupCodes?.[1] as string;
    const regenerated = await request(base, "/api/auth/admin/two-factor/generate-backup-codes", { password: BOSS_ONE_PASSWORD }, freshAdmin, ADMIN_ORIGIN);
    assert.equal(regenerated.response.status, 200);
    const oldCodeAfterRegenerate = await request(base, "/api/auth/admin/two-factor/verify-backup-code", { code: oldUnusedBackupCode }, regenerateChallenge, ADMIN_ORIGIN);
    assert.ok(oldCodeAfterRegenerate.response.status >= 400);
    assert.equal((await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(secret) }, regenerateChallenge, ADMIN_ORIGIN)).response.status, 200);
    assert.equal((await request(base, "/api/v1/admin/security/pin/lock", {}, freshAdmin, ADMIN_ORIGIN)).response.status, 200);
    assert.equal((await request(base, "/api/v1/admin/security/pin/unlock", { pin: "112233" }, freshAdmin, ADMIN_ORIGIN)).response.status, 200);

    const challengeTwo = cookieJar();
    const challengeLoginTwo = await request(base, "/api/auth/admin/sign-in/email", { email: "boss-two@example.invalid", password: BOSS_TWO_PASSWORD }, challengeTwo, ADMIN_ORIGIN);
    assert.equal(challengeLoginTwo.response.status, 200);
    assert.equal(challengeLoginTwo.body?.twoFactorRedirect, true);
    const failedFreeze = await request(base, "/api/v1/admin/security/freeze", { targetAdminId: adminTwoId, password: "wrong-password", totpCode: totpCode(secret), reason: "测试冻结二次认证失败" }, freshAdmin, ADMIN_ORIGIN);
    assert.equal(failedFreeze.response.status, 401);
    assert.equal((await request(base, "/api/v1/admin/security/freeze", { targetAdminId: adminTwoId, password: BOSS_ONE_PASSWORD, totpCode: totpCode(secret), reason: "岗位调整临时冻结" }, freshAdmin, ADMIN_ORIGIN)).response.status, 200);
    const revokedAdminTwo = await request(base, "/api/auth/admin/get-session", undefined, adminTwo, ADMIN_ORIGIN);
    assert.equal(revokedAdminTwo.response.status, 200);
    assert.equal(revokedAdminTwo.body, null);
    const revokedAdminTwoBearer = await request(base, "/api/auth/admin/two-factor/generate-backup-codes", { password: BOSS_TWO_PASSWORD }, cookieJar(), ADMIN_ORIGIN, adminTwoBearer);
    assert.ok([401, 403].includes(revokedAdminTwoBearer.response.status));
    const frozenFreshAdminTwo = await request(base, "/api/auth/admin/sign-in/email", { email: "boss-two@example.invalid", password: BOSS_TWO_PASSWORD }, cookieJar(), ADMIN_ORIGIN);
    assert.ok([401, 403].includes(frozenFreshAdminTwo.response.status));
    const frozenChallengeTwo = await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(secretTwo) }, challengeTwo, ADMIN_ORIGIN);
    assert.ok([401, 403].includes(frozenChallengeTwo.response.status));
    assert.equal((await request(base, "/api/v1/admin/security/unfreeze", { targetAdminId: adminTwoId, password: BOSS_ONE_PASSWORD, totpCode: totpCode(secret), reason: "复核后恢复登录" }, freshAdmin, ADMIN_ORIGIN)).response.status, 200);
    const adminTwoActive = cookieJar();
    assert.equal((await request(base, "/api/auth/admin/sign-in/email", { email: "boss-two@example.invalid", password: BOSS_TWO_PASSWORD }, adminTwoActive, ADMIN_ORIGIN)).body?.twoFactorRedirect, true);
    assert.equal((await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(secretTwo) }, adminTwoActive, ADMIN_ORIGIN)).response.status, 200);

    assert.equal((await request(base, "/api/v1/admin/security/freeze", { targetAdminId: adminId, password: BOSS_TWO_PASSWORD, totpCode: totpCode(secretTwo), reason: "同级 boss 互冻演练" }, adminTwoActive, ADMIN_ORIGIN)).response.status, 200);
    const revokedAdminOne = await request(base, "/api/auth/admin/get-session", undefined, freshAdmin, ADMIN_ORIGIN);
    assert.equal(revokedAdminOne.response.status, 200);
    assert.equal(revokedAdminOne.body, null);
    assert.equal((await request(base, "/api/v1/admin/security/unfreeze", { targetAdminId: adminId, password: BOSS_TWO_PASSWORD, totpCode: totpCode(secretTwo), reason: "同级 boss 互冻演练结束" }, adminTwoActive, ADMIN_ORIGIN)).response.status, 200);
    const adminOneActive = cookieJar();
    assert.equal((await request(base, "/api/auth/admin/sign-in/username", { username: adminUsername, password: BOSS_ONE_PASSWORD }, adminOneActive, ADMIN_ORIGIN)).body?.twoFactorRedirect, true);
    assert.equal((await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(secret) }, adminOneActive, ADMIN_ORIGIN)).response.status, 200);

    const bossSession = await request(base, "/api/bff/admin/session", undefined, adminOneActive, ADMIN_ORIGIN);
    assert.equal(bossSession.body?.authenticated, true);
    assert.equal(bossSession.body?.permissions?.includes("admin.account.create"), true);
    const roleCatalog = await request(base, "/api/bff/admin/security/roles", undefined, adminOneActive, ADMIN_ORIGIN);
    assert.equal(roleCatalog.response.status, 200);
    const opsRole = roleCatalog.body?.roles?.find((role: { code?: string }) => role.code === "ops");
    const supportRole = roleCatalog.body?.roles?.find((role: { code?: string }) => role.code === "support");
    assert.ok(opsRole?.id);
    assert.ok(supportRole?.id);
    const configuredOps = await request(base, "/api/v1/admin/security/roles/update", {
      code: "ops",
      permissionCodes: ["admin.account.read", "admin.account.freeze", "admin.account.unfreeze"],
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(configuredOps.response.status, 200);
    const readerRole = await request(base, "/api/v1/admin/security/roles/create", {
      code: "directory_reader",
      name: "目录只读",
      permissionCodes: ["admin.account.read"],
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(readerRole.response.status, 200);

    const occupiedSequence = await runtimePool.query<{ value: string }>(`SELECT nextval('"zzsh_iam"."admin_login_number_seq"')::text AS value`);
    const occupiedUsername = `zz${occupiedSequence.rows[0]!.value.padStart(5, "0")}`;
    const occupiedNow = new Date();
    await runtimePool.query(
      `INSERT INTO "zzsh_auth_admin"."user" ("id", "name", "email", "createdAt", "updatedAt", "username", "displayUsername", "twoFactorEnabled", "suspended")
       VALUES ($1, $2, $3, $4, $4, $5, $6, false, false)`,
      [`admin_${randomUUID().replaceAll("-", "")}`, "Occupied Login", `${occupiedUsername}@admin.zzsh.invalid`, occupiedNow, occupiedUsername, occupiedUsername.toUpperCase()],
    );
    const skippedCreate = await request(base, "/api/v1/admin/security/admins/create", { name: "跳号员工" }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(skippedCreate.response.status, 200);
    assert.notEqual(skippedCreate.body?.username?.toLowerCase(), occupiedUsername);
    assert.match(skippedCreate.body?.username ?? "", /^ZZ\d{5,}$/);
    assert.equal(typeof skippedCreate.body?.temporaryPassword, "string");
    assert.equal((skippedCreate.body?.temporaryPassword as string).length >= 12, true);

    const beforeCreateCount = await runtimePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_auth_admin"."user"`);
    await migrationPool.query(`REVOKE INSERT ON TABLE "zzsh_iam"."audit_event" FROM ${quotedIdentifier(resources.runtimeUser, "M2_AUTH_TEST_RUNTIME_USER")}`);
    const failedCreate = await request(base, "/api/v1/admin/security/admins/create", { name: "审计失败员工" }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(failedCreate.response.status, 500);
    await migrationPool.query(`GRANT INSERT ON TABLE "zzsh_iam"."audit_event" TO ${quotedIdentifier(resources.runtimeUser, "M2_AUTH_TEST_RUNTIME_USER")}`);
    const afterFailedCreate = await runtimePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_auth_admin"."user"`);
    assert.equal(afterFailedCreate.rows[0]?.count, beforeCreateCount.rows[0]?.count);

    const concurrentCreates = await Promise.all([
      request(base, "/api/v1/admin/security/admins/create", { name: "并发员工甲" }, adminOneActive, ADMIN_ORIGIN),
      request(base, "/api/v1/admin/security/admins/create", { name: "并发员工乙" }, adminOneActive, ADMIN_ORIGIN),
      request(base, "/api/v1/admin/security/admins/create", { name: "并发员工丙" }, adminOneActive, ADMIN_ORIGIN),
    ]);
    assert.deepEqual(concurrentCreates.map((item) => item.response.status), [200, 200, 200]);
    const concurrentUsernames = concurrentCreates.map((item) => item.body?.username as string);
    assert.equal(new Set(concurrentUsernames).size, 3);

    const readerCreate = await request(base, "/api/v1/admin/security/admins/create", {
      name: "只读员工",
      roleIds: [readerRole.body?.id],
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(readerCreate.response.status, 200);
    const freezerCreate = await request(base, "/api/v1/admin/security/admins/create", {
      name: "冻结员工",
      roleIds: [opsRole.id],
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(freezerCreate.response.status, 200);
    const deniedCreate = await request(base, "/api/v1/admin/security/admins/create", {
      name: "禁止冻结员工",
      roleIds: [opsRole.id],
      denyPermissions: ["admin.account.freeze"],
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(deniedCreate.response.status, 200);
    const targetCreate = await request(base, "/api/v1/admin/security/admins/create", { name: "被冻结目标" }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(targetCreate.response.status, 200);
    const createdList = await request(base, "/api/bff/admin/security/admins", undefined, adminOneActive, ADMIN_ORIGIN);
    assert.equal(createdList.body?.admins?.some((entry: Record<string, unknown>) => "temporaryPassword" in entry || "password" in entry || "email" in entry), false);
    const createdAudit = await runtimePool.query<{ details: Record<string, unknown> }>(
      `SELECT "details" FROM "zzsh_iam"."audit_event" WHERE "action" = 'admin.account.created' AND "details"->>'username' = $1`,
      [freezerCreate.body?.username],
    );
    assert.equal(JSON.stringify(createdAudit.rows[0]?.details ?? {}).includes(freezerCreate.body?.temporaryPassword as string), false);

    const reader = await completeStaffEnrollment(base, readerCreate.body?.username as string, readerCreate.body?.temporaryPassword as string);
    const freezer = await completeStaffEnrollment(base, freezerCreate.body?.username as string, freezerCreate.body?.temporaryPassword as string);
    const denied = await completeStaffEnrollment(base, deniedCreate.body?.username as string, deniedCreate.body?.temporaryPassword as string);

    const restoreOperatorCreate = await request(base, "/api/v1/admin/security/admins/create", {
      name: "用户恢复操作员",
      allowPermissions: ["user.account.restore"],
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(restoreOperatorCreate.response.status, 200);
    const restoreOperator = await completeStaffEnrollment(base, restoreOperatorCreate.body?.username as string, restoreOperatorCreate.body?.temporaryPassword as string);
    const restoreOperatorSession = await request(base, "/api/bff/admin/session", undefined, restoreOperator.jar, ADMIN_ORIGIN);
    assert.equal(restoreOperatorSession.body?.permissions?.includes("user.account.restore"), true);

    const restorePhone = "+8613800000001";
    await migrationPool.query(
      `UPDATE "zzsh_auth_user"."user" SET "phoneNumber" = $2, "phoneNumberVerified" = true WHERE "id" = $1`,
      [userId, restorePhone],
    );
    const deactivatedForRestore = await request(base, "/api/auth/user/account/deactivate", { reason: "恢复流程 fixture" }, user, USER_ORIGIN);
    assert.equal(deactivatedForRestore.response.status, 200);
    assert.equal((await request(base, "/api/auth/user/get-session", undefined, user, USER_ORIGIN)).body, null);
    const restoreOtpRequested = await request(base, "/api/auth/user/phone-number/request-password-reset", { phoneNumber: restorePhone }, cookieJar(), USER_ORIGIN);
    assert.equal(restoreOtpRequested.response.status, 200);
    const restoreOtp = fakeSmsOutbox.get(`${restorePhone}-request-password-reset`);
    assert.ok(restoreOtp);
    assert.equal(restoreOtp.purpose, "password-reset");
    const restoreOtpBefore = await runtimePool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "zzsh_auth_user"."verification" WHERE "identifier" = $1`,
      [`${restorePhone}-request-password-reset`],
    );
    assert.equal(restoreOtpBefore.rows[0]?.count, "1");
    const identityBeforeRestore = await runtimePool.query<{ accountStatus: string; identityStatus: string; ageStatus: string; provider: string; version: number; suspended: boolean }>(
      `SELECT s."account_status" AS "accountStatus", s."identity_status" AS "identityStatus", s."age_status" AS "ageStatus", s."provider", s."version", u."suspended"
         FROM "zzsh_iam"."user_identity_state" s JOIN "zzsh_auth_user"."user" u ON u."id" = s."user_id"
        WHERE s."user_id" = $1`,
      [userId],
    );
    assert.deepEqual(identityBeforeRestore.rows[0], { accountStatus: "DEACTIVATED", identityStatus: "VERIFIED", ageStatus: "ADULT", provider: "fake", version: 2, suspended: true });

    const restoreUnauthenticated = await request(base, "/api/v1/admin/security/users/restore-candidates?query=m2_user", undefined, cookieJar(), ADMIN_ORIGIN);
    assert.equal(restoreUnauthenticated.response.status, 401);
    const restoreCandidates = await request(base, "/api/bff/admin/security/users/restore-candidates?query=m2_user", undefined, restoreOperator.jar, ADMIN_ORIGIN);
    assert.equal(restoreCandidates.response.status, 200);
    assert.equal(restoreCandidates.body?.users?.length, 1);
    assert.deepEqual(Object.keys(restoreCandidates.body?.users?.[0] ?? {}).sort(), ["accountStatus", "id", "name", "username"]);
    assert.equal(restoreCandidates.body?.users?.[0]?.accountStatus, "DEACTIVATED");

    const restoreDenied = await request(base, "/api/v1/admin/security/admins/assign", {
      username: restoreOperatorCreate.body?.username,
      roleIds: [],
      allowPermissions: ["user.account.restore"],
      denyPermissions: ["user.account.restore"],
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(restoreDenied.response.status, 200);
    assert.equal((await request(base, "/api/v1/admin/security/users/restore-candidates?query=m2_user", undefined, restoreOperator.jar, ADMIN_ORIGIN)).response.status, 403);
    const restoreReallowed = await request(base, "/api/v1/admin/security/admins/assign", {
      username: restoreOperatorCreate.body?.username,
      roleIds: [],
      allowPermissions: ["user.account.restore"],
      denyPermissions: [],
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(restoreReallowed.response.status, 200);
    assert.equal((await request(base, "/api/v1/admin/security/users/restore-candidates?query=m2_user", undefined, restoreOperator.jar, ADMIN_ORIGIN)).response.status, 200);
    const restoreRevoked = await request(base, "/api/v1/admin/security/admins/assign", {
      username: restoreOperatorCreate.body?.username,
      roleIds: [],
      allowPermissions: [],
      denyPermissions: [],
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(restoreRevoked.response.status, 200);
    const restoreAfterRevoke = await request(base, "/api/v1/admin/security/users/restore", {
      targetUserId: userId,
      password: restoreOperator.password,
      totpCode: totpCode(restoreOperator.secret),
      reason: "撤权后不得恢复",
    }, restoreOperator.jar, ADMIN_ORIGIN);
    assert.equal(restoreAfterRevoke.response.status, 403);
    const restoreReinstated = await request(base, "/api/v1/admin/security/admins/assign", {
      username: restoreOperatorCreate.body?.username,
      roleIds: [],
      allowPermissions: ["user.account.restore"],
      denyPermissions: [],
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(restoreReinstated.response.status, 200);

    const restored = await request(base, "/api/bff/admin/security/users/restore", {
      targetUserId: userId,
      password: restoreOperator.password,
      totpCode: totpCode(restoreOperator.secret),
      reason: "用户重新使用账号",
    }, restoreOperator.jar, ADMIN_ORIGIN);
    assert.equal(restored.response.status, 200);
    assert.equal(restored.body?.status, "ACTIVE");
    assert.match(restored.body?.message ?? "", /旧会话和验证凭据不会复活/);
    const restoredState = await runtimePool.query<{ accountStatus: string; identityStatus: string; ageStatus: string; provider: string; version: number; suspended: boolean }>(
      `SELECT s."account_status" AS "accountStatus", s."identity_status" AS "identityStatus", s."age_status" AS "ageStatus", s."provider", s."version", u."suspended"
         FROM "zzsh_iam"."user_identity_state" s JOIN "zzsh_auth_user"."user" u ON u."id" = s."user_id"
        WHERE s."user_id" = $1`,
      [userId],
    );
    assert.deepEqual(restoredState.rows[0], { accountStatus: "ACTIVE", identityStatus: "VERIFIED", ageStatus: "ADULT", provider: "fake", version: 3, suspended: false });
    const restoreOtpAfter = await runtimePool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "zzsh_auth_user"."verification" WHERE "identifier" = $1`,
      [`${restorePhone}-request-password-reset`],
    );
    assert.equal(restoreOtpAfter.rows[0]?.count, "0");
    const revokedRestoreOtp = await request(base, "/api/auth/user/phone-number/reset-password", {
      phoneNumber: restorePhone,
      otp: restoreOtp.code,
      newPassword: `${PASSWORD}-old-otp`,
    }, cookieJar(), USER_ORIGIN);
    assert.ok(revokedRestoreOtp.response.status >= 400);
    const repeatRestore = await request(base, "/api/v1/admin/security/users/restore", {
      targetUserId: userId,
      password: restoreOperator.password,
      totpCode: totpCode(restoreOperator.secret),
      reason: "重复恢复应被拒绝",
    }, restoreOperator.jar, ADMIN_ORIGIN);
    assert.equal(repeatRestore.response.status, 409);
    const cancelledRestore = await request(base, "/api/v1/admin/security/users/restore", {
      targetUserId: cancelUserId,
      password: restoreOperator.password,
      totpCode: totpCode(restoreOperator.secret),
      reason: "注销主体不得复活",
    }, restoreOperator.jar, ADMIN_ORIGIN);
    assert.equal(cancelledRestore.response.status, 409);
    const cancelledAfterRestoreAttempt = await runtimePool.query<{ accountStatus: string; suspended: boolean }>(
      `SELECT s."account_status" AS "accountStatus", u."suspended"
         FROM "zzsh_iam"."user_identity_state" s JOIN "zzsh_auth_user"."user" u ON u."id" = s."user_id"
        WHERE s."user_id" = $1`,
      [cancelUserId],
    );
    assert.deepEqual(cancelledAfterRestoreAttempt.rows[0], { accountStatus: "CANCELLED", suspended: true });
    const restoredUserLogin = cookieJar();
    const restoredUserSignIn = await request(base, "/api/auth/user/sign-in/username", { username: "m2_user", password: PASSWORD }, restoredUserLogin, USER_ORIGIN);
    assert.equal(restoredUserSignIn.response.status, 200);
    assert.ok((await request(base, "/api/auth/user/get-session", undefined, restoredUserLogin, USER_ORIGIN)).body?.user?.id);

    await migrationPool.query(`REVOKE INSERT ON TABLE "zzsh_iam"."audit_event" FROM ${quotedIdentifier(resources.runtimeUser, "M2_AUTH_TEST_RUNTIME_USER")}`);
    const failedRestore = await request(base, "/api/v1/admin/security/users/restore", {
      targetUserId: deactivateUserId,
      password: restoreOperator.password,
      totpCode: totpCode(restoreOperator.secret),
      reason: "审计失败回滚恢复",
    }, restoreOperator.jar, ADMIN_ORIGIN);
    assert.equal(failedRestore.response.status, 500);
    const failedRestoreState = await runtimePool.query<{ accountStatus: string; suspended: boolean }>(
      `SELECT s."account_status" AS "accountStatus", u."suspended"
         FROM "zzsh_iam"."user_identity_state" s JOIN "zzsh_auth_user"."user" u ON u."id" = s."user_id"
        WHERE s."user_id" = $1`,
      [deactivateUserId],
    );
    assert.deepEqual(failedRestoreState.rows[0], { accountStatus: "DEACTIVATED", suspended: true });
    await migrationPool.query(`GRANT INSERT ON TABLE "zzsh_iam"."audit_event" TO ${quotedIdentifier(resources.runtimeUser, "M2_AUTH_TEST_RUNTIME_USER")}`);

    const forceTargetCreate = await request(base, "/api/v1/admin/security/admins/create", { name: "强制登出目标" }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(forceTargetCreate.response.status, 200);
    const forceTarget = await completeStaffEnrollment(base, forceTargetCreate.body?.username as string, forceTargetCreate.body?.temporaryPassword as string);
    const forceTargetSessionBefore = await request(base, "/api/bff/admin/session", undefined, forceTarget.jar, ADMIN_ORIGIN);
    assert.equal(forceTargetSessionBefore.body?.authenticated, true);
    const forceTargetLifetime = new Date(forceTargetSessionBefore.body?.session?.expiresAt).getTime() - new Date(forceTargetSessionBefore.body?.session?.createdAt).getTime();
    assert.ok(Math.abs(forceTargetLifetime - 7 * 24 * 60 * 60 * 1000) < 2_000);
    const rememberMeFalseLogin = cookieJar();
    const rememberMeFalseSignIn = await request(base, "/api/auth/admin/sign-in/username", { username: forceTargetCreate.body?.username, password: forceTarget.password, rememberMe: false }, rememberMeFalseLogin, ADMIN_ORIGIN);
    assert.equal(rememberMeFalseSignIn.body?.twoFactorRedirect, true);
    assert.equal((await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(forceTarget.secret) }, rememberMeFalseLogin, ADMIN_ORIGIN)).response.status, 200);
    const rememberMeFalseSession = await request(base, "/api/bff/admin/session", undefined, rememberMeFalseLogin, ADMIN_ORIGIN);
    const rememberMeFalseLifetime = new Date(rememberMeFalseSession.body?.session?.expiresAt).getTime() - new Date(rememberMeFalseSession.body?.session?.createdAt).getTime();
    assert.ok(Math.abs(rememberMeFalseLifetime - 7 * 24 * 60 * 60 * 1000) < 2_000);
    assert.equal((await request(base, "/api/auth/admin/sign-out", {}, rememberMeFalseLogin, ADMIN_ORIGIN)).response.status, 200);
    const forceExpiresBeforeLock = forceTargetSessionBefore.body?.session?.expiresAt;
    assert.equal((await request(base, "/api/bff/admin/security/pin/set", { pin: "135790" }, forceTarget.jar, ADMIN_ORIGIN)).response.status, 200);
    assert.equal((await request(base, "/api/bff/admin/security/pin/lock", {}, forceTarget.jar, ADMIN_ORIGIN)).response.status, 200);
    const forceTargetSessionAfterLock = await request(base, "/api/bff/admin/session", undefined, forceTarget.jar, ADMIN_ORIGIN);
    assert.equal(forceTargetSessionAfterLock.body?.session?.expiresAt, forceExpiresBeforeLock);

    const forceTargetId = forceTargetCreate.body?.id as string;
    const forceTargetEmail = await runtimePool.query<{ email: string }>(`SELECT "email" FROM "zzsh_auth_admin"."user" WHERE "id" = $1`, [forceTargetId]);
    const forceIdentifiers = [forceTargetId, forceTargetEmail.rows[0]!.email];
    const forceOther = cookieJar();
    const forceOtherLogin = await request(base, "/api/auth/admin/sign-in/username", { username: forceTargetCreate.body?.username, password: forceTarget.password }, forceOther, ADMIN_ORIGIN);
    assert.equal(forceOtherLogin.body?.twoFactorRedirect, true);
    const forceOtherVerify = await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(forceTarget.secret) }, forceOther, ADMIN_ORIGIN);
    assert.equal(forceOtherVerify.response.status, 200);
    const forceOtherBearer = forceOtherVerify.body?.token as string;
    assert.equal(typeof forceOtherBearer, "string");
    const forceChallenge = cookieJar();
    assert.equal((await request(base, "/api/auth/admin/sign-in/username", { username: forceTargetCreate.body?.username, password: forceTarget.password }, forceChallenge, ADMIN_ORIGIN)).body?.twoFactorRedirect, true);
    const forceBefore = await runtimePool.query<{ sessions: string; challenges: string }>(
      `SELECT
         (SELECT count(*)::text FROM "zzsh_auth_admin"."session" WHERE "userId" = $1) AS sessions,
          (SELECT count(*)::text FROM "zzsh_auth_admin"."verification" WHERE "value" = $1 OR "identifier" = ANY($2::text[])) AS challenges`,
      [forceTargetId, forceIdentifiers],
    );
    assert.equal(forceBefore.rows[0]?.sessions, "2");
    assert.equal(Number(forceBefore.rows[0]?.challenges), 1);
    assert.equal((await request(base, "/api/v1/admin/security/admins/force-logout", { targetAdminId: forceTargetId, password: freezer.password, totpCode: totpCode(freezer.secret), reason: "普通管理员不得强制登出" }, freezer.jar, ADMIN_ORIGIN)).response.status, 403);
    assert.equal((await request(base, "/api/v1/admin/security/admins/force-logout", { targetAdminId: adminId, password: freezer.password, totpCode: totpCode(freezer.secret), reason: "普通管理员不得控制 Boss" }, freezer.jar, ADMIN_ORIGIN)).response.status, 403);
    const forceLogout = await request(base, "/api/bff/admin/security/admins/force-logout", {
      targetAdminId: forceTargetId,
      password: BOSS_ONE_PASSWORD,
      totpCode: totpCode(secret),
      reason: "撤销遗失设备与未完成登录",
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(forceLogout.response.status, 200);
    assert.equal(forceLogout.body?.status, "SESSIONS_REVOKED");
    assert.equal(forceLogout.body?.target?.accountStatus, "ACTIVE");
    const forceAfter = await runtimePool.query<{ status: string; suspended: boolean; sessions: string; challenges: string; audits: string }>(
      `SELECT s."status", u."suspended",
         (SELECT count(*)::text FROM "zzsh_auth_admin"."session" WHERE "userId" = $1) AS sessions,
          (SELECT count(*)::text FROM "zzsh_auth_admin"."verification" WHERE "value" = $1 OR "identifier" = ANY($2::text[])) AS challenges,
         (SELECT count(*)::text FROM "zzsh_iam"."audit_event" WHERE "action" = 'admin.session.force_logged_out' AND "object_id" = $1) AS audits
       FROM "zzsh_iam"."admin_security" s JOIN "zzsh_auth_admin"."user" u ON u."id" = s."admin_user_id"
      WHERE s."admin_user_id" = $1`,
      [forceTargetId, forceIdentifiers],
    );
    assert.deepEqual(forceAfter.rows[0], { status: "ACTIVE", suspended: false, sessions: "0", challenges: "0", audits: "1" });
    assert.equal((await request(base, "/api/auth/admin/get-session", undefined, forceTarget.jar, ADMIN_ORIGIN)).body, null);
    assert.equal((await request(base, "/api/auth/admin/get-session", undefined, cookieJar(), ADMIN_ORIGIN, forceOtherBearer)).body, null);
    assert.ok((await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(forceTarget.secret) }, forceChallenge, ADMIN_ORIGIN)).response.status >= 400);
    const forceNewLogin = cookieJar();
    assert.equal((await request(base, "/api/auth/admin/sign-in/username", { username: forceTargetCreate.body?.username, password: forceTarget.password }, forceNewLogin, ADMIN_ORIGIN)).body?.twoFactorRedirect, true);
    assert.equal((await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(forceTarget.secret) }, forceNewLogin, ADMIN_ORIGIN)).response.status, 200);
    assert.ok((await request(base, "/api/auth/admin/get-session", undefined, forceNewLogin, ADMIN_ORIGIN)).body?.user?.id);

    const forceRollbackChallenge = cookieJar();
    assert.equal((await request(base, "/api/auth/admin/sign-in/username", { username: forceTargetCreate.body?.username, password: forceTarget.password }, forceRollbackChallenge, ADMIN_ORIGIN)).body?.twoFactorRedirect, true);
    const forceRollbackBefore = await runtimePool.query<{ sessions: string; challenges: string }>(
      `SELECT
         (SELECT count(*)::text FROM "zzsh_auth_admin"."session" WHERE "userId" = $1) AS sessions,
          (SELECT count(*)::text FROM "zzsh_auth_admin"."verification" WHERE "value" = $1 OR "identifier" = ANY($2::text[])) AS challenges`,
      [forceTargetId, forceIdentifiers],
    );
    await migrationPool.query(`REVOKE INSERT ON TABLE "zzsh_iam"."audit_event" FROM ${quotedIdentifier(resources.runtimeUser, "M2_AUTH_TEST_RUNTIME_USER")}`);
    const failedForceLogout = await request(base, "/api/bff/admin/security/admins/force-logout", {
      targetAdminId: forceTargetId,
      password: BOSS_ONE_PASSWORD,
      totpCode: totpCode(secret),
      reason: "审计失败时不得半执行登出",
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(failedForceLogout.response.status, 500);
    await migrationPool.query(`GRANT INSERT ON TABLE "zzsh_iam"."audit_event" TO ${quotedIdentifier(resources.runtimeUser, "M2_AUTH_TEST_RUNTIME_USER")}`);
    const forceRollbackAfter = await runtimePool.query<{ sessions: string; challenges: string }>(
      `SELECT
         (SELECT count(*)::text FROM "zzsh_auth_admin"."session" WHERE "userId" = $1) AS sessions,
          (SELECT count(*)::text FROM "zzsh_auth_admin"."verification" WHERE "value" = $1 OR "identifier" = ANY($2::text[])) AS challenges`,
      [forceTargetId, forceIdentifiers],
    );
    assert.deepEqual(forceRollbackAfter.rows[0], forceRollbackBefore.rows[0]);
    assert.ok((await request(base, "/api/auth/admin/get-session", undefined, forceNewLogin, ADMIN_ORIGIN)).body?.user?.id);

    const readerSnapshot = await request(base, "/api/bff/admin/session", undefined, reader.jar, ADMIN_ORIGIN);
    assert.equal(readerSnapshot.body?.permissions?.includes("admin.account.read"), true);
    assert.equal(readerSnapshot.body?.permissions?.includes("admin.account.create"), false);
    const readerCreateDenied = await request(base, "/api/v1/admin/security/admins/create", { name: "越权创建" }, reader.jar, ADMIN_ORIGIN);
    assert.equal(readerCreateDenied.response.status, 403);
    const readerUpdateDenied = await request(base, "/api/v1/admin/security/admins/update", {
      username: targetCreate.body?.username,
      name: "横向改名",
    }, reader.jar, ADMIN_ORIGIN);
    assert.equal(readerUpdateDenied.response.status, 403);
    const readerGrantDenied = await request(base, "/api/v1/admin/security/admins/assign", {
      username: targetCreate.body?.username,
      allowPermissions: ["admin.account.freeze"],
    }, reader.jar, ADMIN_ORIGIN);
    assert.equal(readerGrantDenied.response.status, 403);
    const overGrant = await request(base, "/api/v1/admin/security/admins/create", {
      name: "越权委派",
      allowPermissions: ["admin.account.freeze"],
    }, reader.jar, ADMIN_ORIGIN);
    assert.equal(overGrant.response.status, 403);
    const overRole = await request(base, "/api/v1/admin/security/roles/update", {
      code: "directory_reader",
      permissionCodes: ["admin.account.read", "admin.account.freeze"],
    }, reader.jar, ADMIN_ORIGIN);
    assert.equal(overRole.response.status, 403);

    const deniedFreeze = await request(base, "/api/v1/admin/security/freeze", {
      targetAdminId: targetCreate.body?.id,
      password: denied.password,
      totpCode: totpCode(denied.secret),
      reason: "个人禁止应优先于角色授权",
    }, denied.jar, ADMIN_ORIGIN);
    assert.equal(deniedFreeze.response.status, 403);
    const staffFreeze = await request(base, "/api/v1/admin/security/freeze", {
      targetAdminId: targetCreate.body?.id,
      password: freezer.password,
      totpCode: totpCode(freezer.secret),
      reason: "获授权员工冻结普通账号",
    }, freezer.jar, ADMIN_ORIGIN);
    assert.equal(staffFreeze.response.status, 200);
    const staffFreezeBoss = await request(base, "/api/v1/admin/security/freeze", {
      targetAdminId: adminId,
      password: freezer.password,
      totpCode: totpCode(freezer.secret),
      reason: "普通冻结权限不能控制 Boss",
    }, freezer.jar, ADMIN_ORIGIN);
    assert.equal(staffFreezeBoss.response.status, 403);
    assert.equal((await request(base, "/api/v1/admin/security/unfreeze", {
      targetAdminId: targetCreate.body?.id,
      password: freezer.password,
      totpCode: totpCode(freezer.secret),
      reason: "获授权员工解冻普通账号",
    }, freezer.jar, ADMIN_ORIGIN)).response.status, 200);

    const createBossRejected = await request(base, "/api/v1/admin/security/admins/create", {
      name: "伪 Boss",
      isBoss: true,
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(createBossRejected.response.status, 400);
    const assignBossRejected = await request(base, "/api/v1/admin/security/admins/assign", {
      username: adminUsername,
      roleIds: [opsRole.id],
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(assignBossRejected.response.status, 403);

    const revokedRole = await request(base, "/api/v1/admin/security/roles/update", {
      code: "ops",
      permissionCodes: ["admin.account.read"],
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(revokedRole.response.status, 200);
    const freezerAfterRevoke = await request(base, "/api/bff/admin/session", undefined, freezer.jar, ADMIN_ORIGIN);
    assert.equal(freezerAfterRevoke.body?.permissions?.includes("admin.account.freeze"), false);
    const freezeAfterRevoke = await request(base, "/api/v1/admin/security/freeze", {
      targetAdminId: targetCreate.body?.id,
      password: freezer.password,
      totpCode: totpCode(freezer.secret),
      reason: "撤权后应立即失效",
    }, freezer.jar, ADMIN_ORIGIN);
    assert.equal(freezeAfterRevoke.response.status, 403);

    const renamed = await request(base, "/api/v1/admin/security/admins/update", {
      username: readerCreate.body?.username,
      name: "只读员工已改名",
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(renamed.response.status, 200);
    const detail = await request(base, `/api/bff/admin/security/admins/detail?username=${readerCreate.body?.username}`, undefined, adminOneActive, ADMIN_ORIGIN);
    assert.equal(detail.response.status, 200);
    assert.equal(detail.body?.name, "只读员工已改名");
    assert.equal(detail.body?.id === readerCreate.body?.id, true);
    assert.equal("temporaryPassword" in (detail.body ?? {}), false);

    const privilegedRole = await request(base, "/api/v1/admin/security/roles/create", {
      code: "privileged_ops",
      name: "高权限运营",
      permissionCodes: ["admin.account.read", "admin.account.freeze", "admin.account.unfreeze"],
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(privilegedRole.response.status, 200);
    assert.equal((await request(base, "/api/v1/admin/security/roles/update", {
      code: "privileged_ops",
      status: "DISABLED",
    }, adminOneActive, ADMIN_ORIGIN)).response.status, 200);
    const configurerCreate = await request(base, "/api/v1/admin/security/admins/create", {
      name: "角色配置员",
      allowPermissions: ["admin.account.read", "admin.role.read", "admin.role.configure"],
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(configurerCreate.response.status, 200);
    const configurer = await completeStaffEnrollment(base, configurerCreate.body?.username as string, configurerCreate.body?.temporaryPassword as string);
    const enableStatusOnly = await request(base, "/api/v1/admin/security/roles/update", {
      code: "privileged_ops",
      status: "ACTIVE",
    }, configurer.jar, ADMIN_ORIGIN);
    assert.equal(enableStatusOnly.response.status, 403);
    const enableSameCodes = await request(base, "/api/v1/admin/security/roles/update", {
      code: "privileged_ops",
      status: "ACTIVE",
      permissionCodes: ["admin.account.read", "admin.account.freeze", "admin.account.unfreeze"],
    }, configurer.jar, ADMIN_ORIGIN);
    assert.equal(enableSameCodes.response.status, 403);
    const bossEnable = await request(base, "/api/v1/admin/security/roles/update", {
      code: "privileged_ops",
      status: "ACTIVE",
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(bossEnable.response.status, 200);

    const deniedReaderCreate = await request(base, "/api/v1/admin/security/admins/create", {
      name: "目录只读并禁止权限字段",
      allowPermissions: ["admin.account.read", "admin.role.read", "admin.permission.read"],
      denyPermissions: ["admin.role.read", "admin.permission.read"],
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(deniedReaderCreate.response.status, 200);
    const deniedReader = await completeStaffEnrollment(base, deniedReaderCreate.body?.username as string, deniedReaderCreate.body?.temporaryPassword as string);
    const deniedRoles = await request(base, "/api/v1/admin/security/roles", undefined, deniedReader.jar, ADMIN_ORIGIN);
    assert.equal(deniedRoles.response.status, 403);
    const deniedBffRoles = await request(base, "/api/bff/admin/security/roles", undefined, deniedReader.jar, ADMIN_ORIGIN);
    assert.equal(deniedBffRoles.response.status, 403);
    const deniedList = await request(base, "/api/v1/admin/security/admins", undefined, deniedReader.jar, ADMIN_ORIGIN);
    assert.equal(deniedList.response.status, 200);
    assert.equal(deniedList.body?.admins?.some((entry: Record<string, unknown>) => "roles" in entry), false);
    const deniedDetail = await request(base, `/api/v1/admin/security/admins/detail?username=${readerCreate.body?.username}`, undefined, deniedReader.jar, ADMIN_ORIGIN);
    assert.equal(deniedDetail.response.status, 200);
    assert.equal("roles" in (deniedDetail.body ?? {}), false);
    assert.equal("allowPermissions" in (deniedDetail.body ?? {}), false);
    assert.equal("denyPermissions" in (deniedDetail.body ?? {}), false);
    assert.equal("effectivePermissions" in (deniedDetail.body ?? {}), false);
    const deniedBffDetail = await request(base, `/api/bff/admin/security/admins/detail?username=${readerCreate.body?.username}`, undefined, deniedReader.jar, ADMIN_ORIGIN);
    assert.equal(deniedBffDetail.response.status, 200);
    assert.equal("roles" in (deniedBffDetail.body ?? {}), false);
    assert.equal("allowPermissions" in (deniedBffDetail.body ?? {}), false);
    const permissionOnlyCreate = await request(base, "/api/v1/admin/security/admins/create", {
      name: "仅权限目录",
      allowPermissions: ["admin.account.read", "admin.role.read", "admin.permission.read"],
      denyPermissions: ["admin.role.read"],
    }, adminOneActive, ADMIN_ORIGIN);
    const permissionOnly = await completeStaffEnrollment(base, permissionOnlyCreate.body?.username as string, permissionOnlyCreate.body?.temporaryPassword as string);
    const permissionOnlyRoles = await request(base, "/api/bff/admin/security/roles", undefined, permissionOnly.jar, ADMIN_ORIGIN);
    assert.equal(permissionOnlyRoles.response.status, 200);
    assert.equal(permissionOnlyRoles.body?.roles?.length, 0);
    assert.ok((permissionOnlyRoles.body?.permissions?.length ?? 0) > 0);
    const roleOnlyCreate = await request(base, "/api/v1/admin/security/admins/create", {
      name: "仅角色目录",
      allowPermissions: ["admin.account.read", "admin.role.read", "admin.permission.read"],
      denyPermissions: ["admin.permission.read"],
    }, adminOneActive, ADMIN_ORIGIN);
    const roleOnly = await completeStaffEnrollment(base, roleOnlyCreate.body?.username as string, roleOnlyCreate.body?.temporaryPassword as string);
    const roleOnlyRoles = await request(base, "/api/v1/admin/security/roles", undefined, roleOnly.jar, ADMIN_ORIGIN);
    assert.equal(roleOnlyRoles.response.status, 200);
    assert.ok((roleOnlyRoles.body?.roles?.length ?? 0) > 0);
    assert.equal(roleOnlyRoles.body?.permissions?.length, 0);

    const raceRole = await request(base, "/api/v1/admin/security/roles/create", {
      code: "race_ops",
      name: "并发撤权角色",
      permissionCodes: ["admin.account.read", "admin.account.freeze"],
    }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(raceRole.response.status, 200);
    const racerCreate = await request(base, "/api/v1/admin/security/admins/create", {
      name: "并发写操作员工",
      roleIds: [raceRole.body?.id],
      allowPermissions: ["admin.account.create", "admin.permission.grant", "admin.role.configure", "admin.role.read"],
    }, adminOneActive, ADMIN_ORIGIN);
    const racer = await completeStaffEnrollment(base, racerCreate.body?.username as string, racerCreate.body?.temporaryPassword as string);
    const raceCreate = await withHeldRoleLock(
      runtimePool,
      raceRole.body?.id as string,
      () => request(base, "/api/v1/admin/security/admins/create", {
        name: "并发创建目标",
        allowPermissions: ["admin.account.freeze"],
      }, racer.jar, ADMIN_ORIGIN),
      async (client) => {
        await client.query(
          `DELETE FROM "zzsh_iam"."admin_role_permission" WHERE "role_id" = $1 AND "permission_code" = 'admin.account.freeze'`,
          [raceRole.body?.id],
        );
      },
    );
    assert.equal(raceCreate.response.status, 403);
    await request(base, "/api/v1/admin/security/roles/update", {
      code: "race_ops",
      permissionCodes: ["admin.account.read", "admin.account.freeze"],
    }, adminOneActive, ADMIN_ORIGIN);
    const raceAssign = await withHeldRoleLock(
      runtimePool,
      raceRole.body?.id as string,
      () => request(base, "/api/v1/admin/security/admins/assign", {
        username: targetCreate.body?.username,
        allowPermissions: ["admin.account.freeze"],
      }, racer.jar, ADMIN_ORIGIN),
      async (client) => {
        await client.query(
          `DELETE FROM "zzsh_iam"."admin_role_permission" WHERE "role_id" = $1 AND "permission_code" = 'admin.account.freeze'`,
          [raceRole.body?.id],
        );
      },
    );
    assert.equal(raceAssign.response.status, 403);
    await request(base, "/api/v1/admin/security/roles/update", {
      code: "privileged_ops",
      status: "DISABLED",
      permissionCodes: ["admin.account.read", "admin.account.freeze", "admin.account.unfreeze"],
    }, adminOneActive, ADMIN_ORIGIN);
    const raceEnable = await withHeldRoleLock(
      runtimePool,
      privilegedRole.body?.id as string,
      () => request(base, "/api/v1/admin/security/roles/update", {
        code: "privileged_ops",
        status: "ACTIVE",
      }, configurer.jar, ADMIN_ORIGIN),
      async () => undefined,
    );
    assert.equal(raceEnable.response.status, 403);

    const recoveryTargetChallenge = cookieJar();
    const recoveryTargetLogin = await request(base, "/api/auth/admin/sign-in/username", { username: adminUsername, password: BOSS_ONE_PASSWORD }, recoveryTargetChallenge, ADMIN_ORIGIN);
    assert.equal(recoveryTargetLogin.response.status, 200);
    assert.equal(recoveryTargetLogin.body?.twoFactorRedirect, true);
    const targetCannotUseAdminApi = await request(base, "/api/auth/admin/two-factor/generate-backup-codes", undefined, recoveryTargetChallenge, ADMIN_ORIGIN);
    assert.equal(targetCannotUseAdminApi.response.status, 404);

    const expiredRecoveryCredential = randomBytes(32).toString("base64url");
    const expiredRecoveryRequested = await request(base, "/api/v1/admin/security/recovery/request", { targetAdminId: adminId, password: BOSS_ONE_PASSWORD, targetRecoveryCredential: expiredRecoveryCredential }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(expiredRecoveryRequested.response.status, 200);
    await runtimePool.query(`UPDATE "zzsh_iam"."admin_recovery_request" SET "expires_at" = clock_timestamp() - interval '1 second' WHERE "id" = $1`, [expiredRecoveryRequested.body?.recoveryRequestId]);
    const expiredRecoveryConfirmed = await request(base, "/api/v1/admin/security/recovery/confirm", { recoveryRequestId: expiredRecoveryRequested.body?.recoveryRequestId }, adminTwoActive, ADMIN_ORIGIN);
    assert.equal(expiredRecoveryConfirmed.response.status, 409);
    const expiredRecoveryRow = await runtimePool.query<{ status: string }>(`SELECT "status" FROM "zzsh_iam"."admin_recovery_request" WHERE "id" = $1`, [expiredRecoveryRequested.body?.recoveryRequestId]);
    assert.equal(expiredRecoveryRow.rows[0]?.status, "PENDING");

    const recoveryCredentialOne = randomBytes(32).toString("base64url");
    const recoveryCredentialTwo = randomBytes(32).toString("base64url");
    const recoveryRequested = await request(base, "/api/v1/admin/security/recovery/request", { username: adminUsername.toUpperCase(), password: BOSS_ONE_PASSWORD, targetRecoveryCredential: recoveryCredentialOne }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(recoveryRequested.response.status, 200);
    assert.equal(recoveryRequested.body?.target?.username, adminUsername.toUpperCase());
    const pendingRecoveryDirectory = await request(base, "/api/bff/admin/security/recovery/pending", undefined, adminTwoActive, ADMIN_ORIGIN);
    assert.equal(pendingRecoveryDirectory.response.status, 200);
    assert.ok(pendingRecoveryDirectory.body?.requests?.some((entry: { username?: string }) => entry.username === adminUsername.toUpperCase()));
    assert.equal(pendingRecoveryDirectory.body?.requests?.some((entry: Record<string, unknown>) => "targetRecoveryCredential" in entry || "recoveryTokenHash" in entry), false);
    const secondRecoveryRequested = await request(base, "/api/v1/admin/security/recovery/request", { targetAdminId: adminId, password: BOSS_ONE_PASSWORD, targetRecoveryCredential: recoveryCredentialTwo }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(secondRecoveryRequested.response.status, 200);
    const selfConfirmedRecovery = await request(base, "/api/v1/admin/security/recovery/confirm", { recoveryRequestId: recoveryRequested.body?.recoveryRequestId }, adminOneActive, ADMIN_ORIGIN);
    assert.equal(selfConfirmedRecovery.response.status, 403);
    const recoveryConfirmed = await request(base, "/api/v1/admin/security/recovery/confirm", { recoveryRequestId: recoveryRequested.body?.recoveryRequestId }, adminTwoActive, ADMIN_ORIGIN);
    assert.equal(recoveryConfirmed.response.status, 200);
    assert.equal(recoveryConfirmed.body?.recoveryToken, undefined);
    assert.equal(recoveryConfirmed.body?.targetRecoveryCredential, undefined);
    assert.equal(recoveryConfirmed.body?.newPassword, undefined);
    const secondRecoveryConfirmed = await request(base, "/api/v1/admin/security/recovery/confirm", { recoveryRequestId: secondRecoveryRequested.body?.recoveryRequestId }, adminTwoActive, ADMIN_ORIGIN);
    assert.equal(secondRecoveryConfirmed.response.status, 200);
    assert.equal(secondRecoveryConfirmed.body?.recoveryToken, undefined);
    const helperOnlyRecovery = await request(base, "/api/v1/admin/security/recovery/complete", { targetRecoveryCredential: recoveryRequested.body?.recoveryRequestId, newPassword: RECOVERY_PASSWORD }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(helperOnlyRecovery.response.status, 409);
    assert.equal((await request(base, "/api/auth/admin/get-session", undefined, recoveryTargetChallenge, ADMIN_ORIGIN)).body, null);
    assert.equal((await request(base, "/api/auth/admin/get-session", undefined, adminOneActive, ADMIN_ORIGIN)).body, null);
    const recoveryCompletions = await Promise.all([
      request(base, "/api/v1/admin/security/recovery/complete", { targetRecoveryCredential: recoveryCredentialOne, newPassword: RECOVERY_PASSWORD }, cookieJar(), ADMIN_ORIGIN),
      request(base, "/api/v1/admin/security/recovery/complete", { targetRecoveryCredential: recoveryCredentialTwo, newPassword: RECOVERY_PASSWORD }, cookieJar(), ADMIN_ORIGIN),
    ]);
    assert.deepEqual(recoveryCompletions.map((result) => result.response.status).sort((left, right) => left - right), [200, 409]);
    const recoveredSecurity = await runtimePool.query<{ status: string; passwordChangeRequired: boolean }>(
      `SELECT "status", "password_change_required" AS "passwordChangeRequired" FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1`,
      [adminId],
    );
    assert.equal(recoveredSecurity.rows[0]?.status, "PENDING_ENROLLMENT");
    assert.equal(recoveredSecurity.rows[0]?.passwordChangeRequired, false);
    const adminRecoveryReplay = await request(base, "/api/v1/admin/security/recovery/complete", { targetRecoveryCredential: recoveryCredentialTwo, newPassword: RECOVERY_PASSWORD }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(adminRecoveryReplay.response.status, 409);
    const recoveredAdmin = cookieJar();
    assert.equal((await request(base, "/api/auth/admin/sign-in/username", { username: adminUsername, password: RECOVERY_PASSWORD }, recoveredAdmin, ADMIN_ORIGIN)).response.status, 200);
    const recoveredEnable = await request(base, "/api/auth/admin/two-factor/enable", { password: RECOVERY_PASSWORD }, recoveredAdmin, ADMIN_ORIGIN);
    assert.equal(recoveredEnable.response.status, 200);
    const recoveredSecret = new URL(recoveredEnable.body?.totpURI as string).searchParams.get("secret");
    assert.ok(recoveredSecret);
    assert.equal((await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(recoveredSecret) }, recoveredAdmin, ADMIN_ORIGIN)).response.status, 200);
    assert.equal((await request(base, "/api/v1/admin/security/enrollment/activate", {}, recoveredAdmin, ADMIN_ORIGIN)).response.status, 200);

    const frozenRecoveryCredential = randomBytes(32).toString("base64url");
    const frozenRecoveryRequested = await request(base, "/api/v1/admin/security/recovery/request", { targetAdminId: adminId, password: RECOVERY_PASSWORD, targetRecoveryCredential: frozenRecoveryCredential }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(frozenRecoveryRequested.response.status, 200);
    const frozenRecoveryConfirmed = await request(base, "/api/v1/admin/security/recovery/confirm", { recoveryRequestId: frozenRecoveryRequested.body?.recoveryRequestId }, adminTwoActive, ADMIN_ORIGIN);
    assert.equal(frozenRecoveryConfirmed.response.status, 200);
    assert.equal(frozenRecoveryConfirmed.body?.recoveryToken, undefined);
    assert.equal((await request(base, "/api/v1/admin/security/freeze", { targetAdminId: adminId, password: BOSS_TWO_PASSWORD, totpCode: totpCode(secretTwo), reason: "恢复签发后冻结验证" }, adminTwoActive, ADMIN_ORIGIN)).response.status, 200);
    const frozenRecoveryComplete = await request(base, "/api/v1/admin/security/recovery/complete", { targetRecoveryCredential: frozenRecoveryCredential, newPassword: RECOVERY_PASSWORD }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(frozenRecoveryComplete.response.status, 409);
    const frozenRecoveryRow = await runtimePool.query<{ status: string; recoveryTokenHash: string | null }>(`SELECT "status", "recovery_token_hash" AS "recoveryTokenHash" FROM "zzsh_iam"."admin_recovery_request" WHERE "id" = $1`, [frozenRecoveryRequested.body?.recoveryRequestId]);
    assert.equal(frozenRecoveryRow.rows[0]?.status, "EXPIRED");
    assert.equal(frozenRecoveryRow.rows[0]?.recoveryTokenHash, null);
    assert.equal((await request(base, "/api/v1/admin/security/unfreeze", { targetAdminId: adminId, password: BOSS_TWO_PASSWORD, totpCode: totpCode(secretTwo), reason: "恢复签发后冻结验证结束" }, adminTwoActive, ADMIN_ORIGIN)).response.status, 200);
    const recoveredAdminAfterFreeze = cookieJar();
    assert.equal((await request(base, "/api/auth/admin/sign-in/username", { username: adminUsername, password: RECOVERY_PASSWORD }, recoveredAdminAfterFreeze, ADMIN_ORIGIN)).body?.twoFactorRedirect, true);
    assert.equal((await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(recoveredSecret) }, recoveredAdminAfterFreeze, ADMIN_ORIGIN)).response.status, 200);

    const { hashPassword } = await import("better-auth/crypto");
    const ordinaryAdminId = `admin_${randomUUID().replaceAll("-", "")}`;
    const ordinaryPassword = randomBytes(24).toString("base64url");
    const ordinaryRecoveryPassword = randomBytes(24).toString("base64url");
    const ordinaryNow = new Date();
    await runtimePool.query(
      `INSERT INTO "zzsh_auth_admin"."user" ("id", "name", "email", "createdAt", "updatedAt", "username", "twoFactorEnabled", "suspended") VALUES ($1, $2, $3, $4, $4, $5, false, false)`,
      [ordinaryAdminId, "Ordinary Administrator", "ordinary-m2@example.invalid", ordinaryNow, "ordinary_m2"],
    );
    await runtimePool.query(
      `INSERT INTO "zzsh_auth_admin"."account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt") VALUES ($1, $2, 'credential', $2, $3, $4, $4)`,
      [`account_${randomUUID().replaceAll("-", "")}`, ordinaryAdminId, await hashPassword(ordinaryPassword), ordinaryNow],
    );
    await runtimePool.query(
      `INSERT INTO "zzsh_iam"."admin_security" ("admin_user_id", "status", "is_boss", "bootstrap_expires_at") VALUES ($1, 'PENDING_ENROLLMENT', false, $2)`,
      [ordinaryAdminId, new Date(ordinaryNow.getTime() + 15 * 60 * 1000)],
    );
    const ordinary = cookieJar();
    assert.equal((await request(base, "/api/auth/admin/sign-in/email", { email: "ordinary-m2@example.invalid", password: ordinaryPassword }, ordinary, ADMIN_ORIGIN)).response.status, 200);
    const ordinaryEnabled = await request(base, "/api/auth/admin/two-factor/enable", { password: ordinaryPassword }, ordinary, ADMIN_ORIGIN);
    assert.equal(ordinaryEnabled.response.status, 200);
    const ordinarySecret = new URL(ordinaryEnabled.body?.totpURI as string).searchParams.get("secret");
    assert.ok(ordinarySecret);
    assert.equal((await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(ordinarySecret) }, ordinary, ADMIN_ORIGIN)).response.status, 200);
    assert.equal((await request(base, "/api/v1/admin/security/enrollment/activate", {}, ordinary, ADMIN_ORIGIN)).response.status, 200);
    const ordinaryRecoveryCredential = randomBytes(32).toString("base64url");
    const ordinaryRecoveryRequested = await request(base, "/api/v1/admin/security/recovery/request", {
      targetAdminId: ordinaryAdminId,
      password: ordinaryPassword,
      targetRecoveryCredential: ordinaryRecoveryCredential,
    }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(ordinaryRecoveryRequested.response.status, 200);
    const ordinarySelfConfirm = await request(base, "/api/v1/admin/security/recovery/confirm", { recoveryRequestId: ordinaryRecoveryRequested.body?.recoveryRequestId }, ordinary, ADMIN_ORIGIN);
    assert.equal(ordinarySelfConfirm.response.status, 403);
    const ordinaryRecoveryConfirmed = await request(base, "/api/v1/admin/security/recovery/confirm", { recoveryRequestId: ordinaryRecoveryRequested.body?.recoveryRequestId }, adminTwoActive, ADMIN_ORIGIN);
    assert.equal(ordinaryRecoveryConfirmed.response.status, 200);
    assert.equal(ordinaryRecoveryConfirmed.body?.targetRecoveryCredential, undefined);
    const ordinaryRecoveryCompleted = await request(base, "/api/v1/admin/security/recovery/complete", {
      targetRecoveryCredential: ordinaryRecoveryCredential,
      newPassword: ordinaryRecoveryPassword,
    }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(ordinaryRecoveryCompleted.response.status, 200);
    const ordinaryRecovered = cookieJar();
    assert.equal((await request(base, "/api/auth/admin/sign-in/email", { email: "ordinary-m2@example.invalid", password: ordinaryRecoveryPassword }, ordinaryRecovered, ADMIN_ORIGIN)).response.status, 200);
    const ordinaryRecoveredEnabled = await request(base, "/api/auth/admin/two-factor/enable", { password: ordinaryRecoveryPassword }, ordinaryRecovered, ADMIN_ORIGIN);
    assert.equal(ordinaryRecoveredEnabled.response.status, 200);
    const ordinaryRecoveredSecret = new URL(ordinaryRecoveredEnabled.body?.totpURI as string).searchParams.get("secret");
    assert.ok(ordinaryRecoveredSecret);
    assert.equal((await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(ordinaryRecoveredSecret) }, ordinaryRecovered, ADMIN_ORIGIN)).response.status, 200);
    assert.equal((await request(base, "/api/v1/admin/security/enrollment/activate", {}, ordinaryRecovered, ADMIN_ORIGIN)).response.status, 200);

    const pendingFreezeAdminId = `admin_${randomUUID().replaceAll("-", "")}`;
    const pendingFreezePassword = randomBytes(24).toString("base64url");
    const pendingFreezeNow = new Date();
    await runtimePool.query(
      `INSERT INTO "zzsh_auth_admin"."user" ("id", "name", "email", "createdAt", "updatedAt", "username", "twoFactorEnabled", "suspended") VALUES ($1, $2, $3, $4, $4, $5, false, false)`,
      [pendingFreezeAdminId, "Pending Freeze Administrator", "pending-freeze-m2@example.invalid", pendingFreezeNow, "pending_freeze_m2"],
    );
    await runtimePool.query(
      `INSERT INTO "zzsh_auth_admin"."account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt") VALUES ($1, $2, 'credential', $2, $3, $4, $4)`,
      [`account_${randomUUID().replaceAll("-", "")}`, pendingFreezeAdminId, await hashPassword(pendingFreezePassword), pendingFreezeNow],
    );
    await runtimePool.query(
      `INSERT INTO "zzsh_iam"."admin_security" ("admin_user_id", "status", "is_boss", "bootstrap_expires_at") VALUES ($1, 'PENDING_ENROLLMENT', false, $2)`,
      [pendingFreezeAdminId, new Date(pendingFreezeNow.getTime() + 15 * 60 * 1000)],
    );
    const pendingFreeze = await request(base, "/api/v1/admin/security/freeze", {
      targetAdminId: pendingFreezeAdminId,
      password: BOSS_TWO_PASSWORD,
      totpCode: totpCode(secretTwo),
      reason: "未激活账号冻结验证",
    }, adminTwoActive, ADMIN_ORIGIN);
    assert.equal(pendingFreeze.response.status, 200);
    const frozenPendingState = await runtimePool.query<{ status: string; firstActivatedAt: Date | null }>(
      `SELECT "status", "first_activated_at" AS "firstActivatedAt" FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1`,
      [pendingFreezeAdminId],
    );
    assert.equal(frozenPendingState.rows[0]?.status, "FROZEN");
    assert.equal(frozenPendingState.rows[0]?.firstActivatedAt, null);
    const frozenPendingLogin = await request(base, "/api/auth/admin/sign-in/email", {
      email: "pending-freeze-m2@example.invalid",
      password: pendingFreezePassword,
    }, cookieJar(), ADMIN_ORIGIN);
    assert.ok([401, 403].includes(frozenPendingLogin.response.status));
    const unfrozenPending = await request(base, "/api/v1/admin/security/unfreeze", {
      targetAdminId: pendingFreezeAdminId,
      password: BOSS_TWO_PASSWORD,
      totpCode: totpCode(secretTwo),
      reason: "未激活账号解冻验证",
    }, adminTwoActive, ADMIN_ORIGIN);
    assert.equal(unfrozenPending.response.status, 200);
    assert.equal(unfrozenPending.body?.status, "PENDING_ENROLLMENT");
    const unfrozenPendingState = await runtimePool.query<{ status: string; firstActivatedAt: Date | null }>(
      `SELECT "status", "first_activated_at" AS "firstActivatedAt" FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1`,
      [pendingFreezeAdminId],
    );
    assert.equal(unfrozenPendingState.rows[0]?.status, "PENDING_ENROLLMENT");
    assert.equal(unfrozenPendingState.rows[0]?.firstActivatedAt, null);
    const pendingBff = cookieJar();
    const pendingBffLogin = await request(base, "/api/bff/admin/auth/sign-in", { email: "pending-freeze-m2@example.invalid", password: pendingFreezePassword }, pendingBff, ADMIN_ORIGIN);
    assert.equal(pendingBffLogin.response.status, 200);
    assert.equal(pendingBffLogin.body?.token, undefined);
    assertNoTokenHeaders(pendingBffLogin.response);
    assert.equal((await request(base, "/api/bff/admin/auth/two-factor/generate-backup-codes", { password: pendingFreezePassword }, pendingBff, ADMIN_ORIGIN)).response.status, 403);
    assert.equal((await request(base, "/api/bff/admin/security/pin/set", { pin: "246810" }, pendingBff, ADMIN_ORIGIN)).response.status, 403);

    const requestFreezeCredential = randomBytes(32).toString("base64url");
    const [requestRace, requestRaceFreeze] = await Promise.all([
      request(base, "/api/v1/admin/security/recovery/request", { targetAdminId: ordinaryAdminId, password: ordinaryRecoveryPassword, targetRecoveryCredential: requestFreezeCredential }, cookieJar(), ADMIN_ORIGIN),
      request(base, "/api/v1/admin/security/freeze", { targetAdminId: ordinaryAdminId, password: BOSS_TWO_PASSWORD, totpCode: totpCode(secretTwo), reason: "并发请求冻结核验" }, adminTwoActive, ADMIN_ORIGIN),
    ]);
    assert.ok([200, 401].includes(requestRace.response.status));
    assert.equal(requestRaceFreeze.response.status, 200);
    if (requestRace.response.status === 200) {
      const requestRaceRow = await runtimePool.query<{ status: string; recoveryTokenHash: string | null }>(`SELECT "status", "recovery_token_hash" AS "recoveryTokenHash" FROM "zzsh_iam"."admin_recovery_request" WHERE "id" = $1`, [requestRace.body?.recoveryRequestId]);
      assert.equal(requestRaceRow.rows[0]?.status, "EXPIRED");
      assert.equal(requestRaceRow.rows[0]?.recoveryTokenHash, null);
    }
    assert.equal((await request(base, "/api/v1/admin/security/unfreeze", { targetAdminId: ordinaryAdminId, password: BOSS_TWO_PASSWORD, totpCode: totpCode(secretTwo), reason: "并发请求冻结核验结束" }, adminTwoActive, ADMIN_ORIGIN)).response.status, 200);

    const confirmFreezeCredential = randomBytes(32).toString("base64url");
    const confirmFreezeRequested = await request(base, "/api/v1/admin/security/recovery/request", { targetAdminId: ordinaryAdminId, password: ordinaryRecoveryPassword, targetRecoveryCredential: confirmFreezeCredential }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(confirmFreezeRequested.response.status, 200);
    const [confirmRace, confirmRaceFreeze] = await Promise.all([
      request(base, "/api/v1/admin/security/recovery/confirm", { recoveryRequestId: confirmFreezeRequested.body?.recoveryRequestId }, adminTwoActive, ADMIN_ORIGIN),
      request(base, "/api/v1/admin/security/freeze", { targetAdminId: ordinaryAdminId, password: BOSS_TWO_PASSWORD, totpCode: totpCode(secretTwo), reason: "并发签发冻结核验" }, adminTwoActive, ADMIN_ORIGIN),
    ]);
    assert.ok([200, 409].includes(confirmRace.response.status));
    assert.equal(confirmRaceFreeze.response.status, 200);
    const confirmRaceRow = await runtimePool.query<{ status: string; recoveryTokenHash: string | null }>(`SELECT "status", "recovery_token_hash" AS "recoveryTokenHash" FROM "zzsh_iam"."admin_recovery_request" WHERE "id" = $1`, [confirmFreezeRequested.body?.recoveryRequestId]);
    assert.equal(confirmRaceRow.rows[0]?.status, "EXPIRED");
    assert.equal(confirmRaceRow.rows[0]?.recoveryTokenHash, null);

    const recoveryPasswordFailures: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      recoveryPasswordFailures.push((await request(base, "/api/v1/admin/security/recovery/request", { targetAdminId: ordinaryAdminId, password: "wrong-password", targetRecoveryCredential: randomBytes(32).toString("base64url") }, cookieJar(), ADMIN_ORIGIN)).response.status);
    }
    assert.deepEqual(recoveryPasswordFailures, [401, 401, 401, 401, 401]);
    const rateLimitedRecoveryPassword = await request(base, "/api/v1/admin/security/recovery/request", { targetAdminId: ordinaryAdminId, password: "wrong-password", targetRecoveryCredential: randomBytes(32).toString("base64url") }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(rateLimitedRecoveryPassword.response.status, 429);
    assert.equal(rateLimitedRecoveryPassword.body?.error?.code, "RATE_LIMITED");

    const reauthenticationFailures: number[] = [];
    for (let index = 0; index < 5; index += 1) {
      reauthenticationFailures.push((await request(base, "/api/v1/admin/security/freeze", { targetAdminId: ordinaryAdminId, password: "wrong-password", totpCode: totpCode(secretTwo), reason: "限流断言" }, adminTwoActive, ADMIN_ORIGIN)).response.status);
    }
    assert.deepEqual(reauthenticationFailures, [401, 401, 401, 401, 401]);
    const rateLimitedReauthentication = await request(base, "/api/v1/admin/security/freeze", { targetAdminId: ordinaryAdminId, password: "wrong-password", totpCode: totpCode(secretTwo), reason: "限流断言" }, adminTwoActive, ADMIN_ORIGIN);
    assert.equal(rateLimitedReauthentication.response.status, 429);
    assert.equal(rateLimitedReauthentication.body?.error?.code, "RATE_LIMITED");

    const recoveredBossCredential = randomBytes(32).toString("base64url");
    const recoveredBossRequested = await request(base, "/api/v1/admin/security/recovery/request", {
      targetAdminId: adminId,
      password: RECOVERY_PASSWORD,
      targetRecoveryCredential: recoveredBossCredential,
    }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(recoveredBossRequested.response.status, 200);
    const recoveredBossConfirmed = await request(base, "/api/v1/admin/security/recovery/confirm", {
      recoveryRequestId: recoveredBossRequested.body?.recoveryRequestId,
    }, adminTwoActive, ADMIN_ORIGIN);
    assert.equal(recoveredBossConfirmed.response.status, 200);
    const recoveredBossPassword = randomBytes(24).toString("base64url");
    const recoveredBossCompleted = await request(base, "/api/v1/admin/security/recovery/complete", {
      targetRecoveryCredential: recoveredBossCredential,
      newPassword: recoveredBossPassword,
    }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(recoveredBossCompleted.response.status, 200);
    await runtimePool.query(`UPDATE "zzsh_iam"."admin_security" SET "bootstrap_expires_at" = clock_timestamp() - interval '1 second' WHERE "admin_user_id" = $1`, [adminId]);
    const expiredRecoveredBossBootstrap = await request(base, "/api/v1/admin/security/bootstrap", {
      bootstrapSecret: ADMIN_BOOTSTRAP_SECRET,
      email: "boss-three-after-recovery@example.invalid",
      name: "Boss Three After Recovery",
      password: randomBytes(24).toString("base64url"),
    }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(expiredRecoveredBossBootstrap.response.status, 409);
    const preservedBossSecurity = await runtimePool.query<{ isBoss: boolean; status: string; firstActivatedAt: Date | null }>(
      `SELECT "is_boss" AS "isBoss", "status", "first_activated_at" AS "firstActivatedAt" FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1`,
      [adminId],
    );
    assert.equal(preservedBossSecurity.rows.length, 1);
    assert.equal(preservedBossSecurity.rows[0]?.isBoss, true);
    assert.equal(preservedBossSecurity.rows[0]?.status, "PENDING_ENROLLMENT");
    assert.ok(preservedBossSecurity.rows[0]?.firstActivatedAt);
    const preservedBossUser = await runtimePool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "zzsh_auth_admin"."user" WHERE "id" = $1`,
      [adminId],
    );
    assert.equal(preservedBossUser.rows[0]?.count, "1");
    const preservedBossAccount = await runtimePool.query<{ password: string | null }>(
      `SELECT "password" FROM "zzsh_auth_admin"."account" WHERE "userId" = $1 AND "providerId" = 'credential'`,
      [adminId],
    );
    assert.equal(preservedBossAccount.rows.length, 1);
    assert.ok(preservedBossAccount.rows[0]?.password);
    const preservedBossLogin = await request(base, "/api/auth/admin/sign-in/username", {
      username: adminUsername,
      password: recoveredBossPassword,
    }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(preservedBossLogin.response.status, 200);
    const preservedBossAudit = await runtimePool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "zzsh_iam"."audit_event" WHERE "object_id" = $1 AND "action" IN ('admin.recovery.completed', 'admin.security.update')`,
      [adminId],
    );
    assert.ok(Number(preservedBossAudit.rows[0]?.count) > 0);

    assert.equal(securityVerificationBudget.inFlight, 0);
    rateLimitState.clear();
    securityVerificationBudget.inFlight = 128;
    const inFlightVerificationRejected = await request(base, "/api/v1/admin/security/recovery/request", {
      targetAdminId: "admin_missing_in_flight",
      password: "wrong-password",
      targetRecoveryCredential: randomBytes(32).toString("base64url"),
    }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(inFlightVerificationRejected.response.status, 429);
    assert.equal(inFlightVerificationRejected.body?.error?.code, "RATE_LIMITED");
    assert.equal(rateLimitState.size, 0);
    securityVerificationBudget.inFlight = 0;

    rateLimitState.clear();
    const expiredRateBucketAt = Date.now() - 1;
    for (let index = 0; index < 1024; index += 1) {
      rateLimitState.set(`expired-${index}`, { failures: 1, resetAt: expiredRateBucketAt });
    }
    const pruneFailure = await request(base, "/api/v1/admin/security/recovery/request", {
      targetAdminId: "admin_missing_prune",
      password: "wrong-password",
      targetRecoveryCredential: randomBytes(32).toString("base64url"),
    }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(pruneFailure.response.status, 401);
    assert.equal(rateLimitState.size, 1);
    const concurrentBudgetFailures = await Promise.all(Array.from({ length: 64 }, (_, index) => request(base, "/api/v1/admin/security/recovery/request", {
      targetAdminId: `admin_missing_budget_${index}`,
      password: "wrong-password",
      targetRecoveryCredential: randomBytes(32).toString("base64url"),
    }, cookieJar(), ADMIN_ORIGIN)));
    assert.ok(concurrentBudgetFailures.every((failure) => failure.response.status === 401));
    assert.ok(rateLimitState.size <= 1024);
    rateLimitState.clear();
    const activeRateBucketAt = Date.now() + 60_000;
    for (let index = 0; index < 1024; index += 1) {
      rateLimitState.set(`active-${index}`, { failures: 1, resetAt: activeRateBucketAt });
    }
    const boundedRateLimit = await request(base, "/api/v1/admin/security/recovery/request", {
      targetAdminId: "admin_missing_capacity",
      password: "wrong-password",
      targetRecoveryCredential: randomBytes(32).toString("base64url"),
    }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(boundedRateLimit.response.status, 429);
    assert.equal(boundedRateLimit.body?.error?.code, "RATE_LIMITED");
    assert.ok(rateLimitState.size <= 1024);
    assert.equal(securityVerificationBudget.inFlight, 0);

    const disasterCredential = randomBytes(32).toString("base64url");
    const disasterCredentialHash = createHash("sha256").update(disasterCredential, "utf8").digest("hex");
    await assert.rejects(
      () => issueDisasterRecovery(runtimePool!, {
        targetAdminId: adminTwoId,
        operatorId: "deployment-maintainer:test-001",
        offlineConfirmationId: "offline-confirmation:test-raw-rejected",
        targetRecoveryCredentialHash: disasterCredential,
      }),
      /credential hash is invalid/,
    );
    const disasterTargetRowsBefore = await runtimePool.query<{ status: string; password: string | null; twoFactorEnabled: boolean; sessions: string }>(
      `SELECT s."status", a."password", u."twoFactorEnabled", count(session."id")::text AS sessions
         FROM "zzsh_iam"."admin_security" s
         JOIN "zzsh_auth_admin"."account" a ON a."userId" = s."admin_user_id" AND a."providerId" = 'credential'
         JOIN "zzsh_auth_admin"."user" u ON u."id" = s."admin_user_id"
         LEFT JOIN "zzsh_auth_admin"."session" session ON session."userId" = s."admin_user_id"
        WHERE s."admin_user_id" = $1
        GROUP BY s."status", a."password", u."twoFactorEnabled"`,
      [adminTwoId],
    );
    await assert.rejects(
      () => issueDisasterRecovery(runtimePool!, {
        targetAdminId: adminTwoId,
        operatorId: "deployment-maintainer:test-001",
        offlineConfirmationId: "offline-confirmation:test-001",
        targetRecoveryCredentialHash: disasterCredentialHash,
      }),
      /pre-registered recovery notification target/,
    );
    assert.ok(Number(disasterTargetRowsBefore.rows[0]?.sessions) > 0);
    const disasterTargetRowsAfterFailedIssue = await runtimePool.query<{ status: string; password: string | null; twoFactorEnabled: boolean; sessions: string }>(
      `SELECT s."status", a."password", u."twoFactorEnabled", count(session."id")::text AS sessions
         FROM "zzsh_iam"."admin_security" s
         JOIN "zzsh_auth_admin"."account" a ON a."userId" = s."admin_user_id" AND a."providerId" = 'credential'
         JOIN "zzsh_auth_admin"."user" u ON u."id" = s."admin_user_id"
         LEFT JOIN "zzsh_auth_admin"."session" session ON session."userId" = s."admin_user_id"
        WHERE s."admin_user_id" = $1
        GROUP BY s."status", a."password", u."twoFactorEnabled"`,
      [adminTwoId],
    );
    assert.deepEqual(disasterTargetRowsAfterFailedIssue.rows[0], {
      status: disasterTargetRowsBefore.rows[0]?.status,
      password: disasterTargetRowsBefore.rows[0]?.password,
      twoFactorEnabled: disasterTargetRowsBefore.rows[0]?.twoFactorEnabled,
      sessions: disasterTargetRowsBefore.rows[0]?.sessions,
    });
    // A target device may be unusable while its session row remains; issuance must revoke it after the gates pass.
    const staleSessionNow = new Date();
    const staleSessionId = `session_stale_disaster_${randomUUID().replaceAll("-", "")}`;
    await migrationPool.query(
      `INSERT INTO "zzsh_auth_admin"."session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [staleSessionId, new Date(staleSessionNow.getTime() - 60_000), `stale-token-${randomUUID()}`, staleSessionNow, adminId],
    );
    const expiredResidualSession = await runtimePool.query<{ expiresAt: Date }>(
      `SELECT "expiresAt" FROM "zzsh_auth_admin"."session" WHERE "id" = $1`,
      [staleSessionId],
    );
    assert.ok(expiredResidualSession.rows[0]!.expiresAt.getTime() <= Date.now());
    await migrationPool.query(
      `INSERT INTO "zzsh_iam"."admin_recovery_notification_target" ("id", "admin_user_id", "channel", "target_ref")
       VALUES ($1, $2, 'SECURE_STORE', $3), ($4, $5, 'SECURE_STORE', $6)`,
      [
        `recovery_target_${randomUUID().replaceAll("-", "")}`,
        adminId,
        "test-secure-store:boss-one",
        `recovery_target_${randomUUID().replaceAll("-", "")}`,
        adminTwoId,
        "test-secure-store:boss-two",
      ],
    );
    const oldDisasterRecoveryCredential = randomBytes(32).toString("base64url");
    await migrationPool.query(
      `INSERT INTO "zzsh_iam"."admin_recovery_request" ("id", "target_admin_user_id", "requested_by", "status", "recovery_token_hash", "expires_at")
       VALUES ($1, $2, $2, 'PENDING', $3, clock_timestamp() + interval '10 minutes')`,
      [`recovery_old_disaster_${randomUUID().replaceAll("-", "")}`, adminTwoId, createHash("sha256").update(oldDisasterRecoveryCredential, "utf8").digest("hex")],
    );
    await migrationPool.query(
      `INSERT INTO "zzsh_auth_admin"."verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt")
       VALUES ($1, $2, 'test-old-challenge', clock_timestamp() + interval '10 minutes', clock_timestamp(), clock_timestamp())`,
      [`verification_old_disaster_${randomUUID().replaceAll("-", "")}`, adminTwoId],
    );
    const disaster = await issueDisasterRecovery(runtimePool!, {
      targetAdminId: adminTwoId,
      operatorId: "deployment-maintainer:test-001",
      offlineConfirmationId: "offline-confirmation:test-001",
      targetRecoveryCredentialHash: disasterCredentialHash,
    });
    assert.equal(disaster.targetAdminId, adminTwoId);
    assert.equal((disaster as unknown as { targetRecoveryCredential?: string }).targetRecoveryCredential, undefined);
    const disasterState = await runtimePool.query<{ status: string; password: string | null; twoFactorEnabled: boolean; twoFactorRows: string; verificationRows: string; sessions: string; recoveryMethod: string; offlineConfirmationId: string | null; recoveryStatus: string; recoveryTokenHash: string | null }>(
      `SELECT s."status", a."password", u."twoFactorEnabled",
          (SELECT count(*)::text FROM "zzsh_auth_admin"."twoFactor" WHERE "userId" = s."admin_user_id") AS "twoFactorRows",
          (SELECT count(*)::text FROM "zzsh_auth_admin"."verification" WHERE "identifier" = s."admin_user_id") AS "verificationRows",
          (SELECT count(*)::text FROM "zzsh_auth_admin"."session" WHERE "userId" = s."admin_user_id") AS sessions,
          r."recovery_method" AS "recoveryMethod", r."offline_confirmation_id" AS "offlineConfirmationId",
          r."status" AS "recoveryStatus", r."recovery_token_hash" AS "recoveryTokenHash"
         FROM "zzsh_iam"."admin_security" s
         JOIN "zzsh_auth_admin"."account" a ON a."userId" = s."admin_user_id" AND a."providerId" = 'credential'
         JOIN "zzsh_auth_admin"."user" u ON u."id" = s."admin_user_id"
         JOIN "zzsh_iam"."admin_recovery_request" r ON r."target_admin_user_id" = s."admin_user_id"
        WHERE s."admin_user_id" = $1 AND r."id" = $2`,
      [adminTwoId, disaster.recoveryRequestId],
    );
    assert.equal(disasterState.rows[0]?.status, "PENDING_ENROLLMENT");
    assert.equal(disasterState.rows[0]?.password, null);
    assert.equal(disasterState.rows[0]?.twoFactorEnabled, false);
    assert.equal(disasterState.rows[0]?.twoFactorRows, "0");
    assert.equal(disasterState.rows[0]?.verificationRows, "0");
    assert.equal(disasterState.rows[0]?.sessions, "0");
    assert.equal(disasterState.rows[0]?.recoveryMethod, "DISASTER_CLI");
    assert.equal(disasterState.rows[0]?.offlineConfirmationId, "offline-confirmation:test-001");
    assert.equal(disasterState.rows[0]?.recoveryStatus, "ISSUED");
    assert.notEqual(disasterState.rows[0]?.recoveryTokenHash, disasterCredential);
    assert.equal(disasterState.rows[0]?.recoveryTokenHash, createHash("sha256").update(disasterCredential, "utf8").digest("hex"));
    const oldDisasterRecovery = await runtimePool.query<{ status: string; recoveryTokenHash: string | null }>(
      `SELECT "status", "recovery_token_hash" AS "recoveryTokenHash"
         FROM "zzsh_iam"."admin_recovery_request"
        WHERE "target_admin_user_id" = $1 AND "recovery_token_hash" IS NULL
          AND "id" <> $2 AND "status" = 'EXPIRED'
        ORDER BY "created_at" DESC LIMIT 1`,
      [adminTwoId, disaster.recoveryRequestId],
    );
    assert.equal(oldDisasterRecovery.rows[0]?.status, "EXPIRED");
    assert.equal(oldDisasterRecovery.rows[0]?.recoveryTokenHash, null);

    await migrationPool.query(`UPDATE "zzsh_iam"."admin_recovery_request" SET "expires_at" = clock_timestamp() - interval '1 second' WHERE "id" = $1`, [disaster.recoveryRequestId]);
    const expiredDisasterComplete = await request(base, "/api/v1/admin/security/recovery/complete", { targetRecoveryCredential: disasterCredential, newPassword: randomBytes(24).toString("base64url") }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(expiredDisasterComplete.response.status, 409);
    const expiredDisasterRow = await runtimePool.query<{ status: string; expiresAt: Date }>(
      `SELECT "status", "expires_at" AS "expiresAt" FROM "zzsh_iam"."admin_recovery_request" WHERE "id" = $1`,
      [disaster.recoveryRequestId],
    );
    assert.equal(expiredDisasterRow.rows[0]?.status, "ISSUED");
    assert.ok(expiredDisasterRow.rows[0]!.expiresAt.getTime() <= Date.now());

    const disasterDelivery: AdminSecurityNotification[] = [];
    const disasterRetry = await retryPendingAdminSecurityNotifications(runtimePool, async (notification) => {
      disasterDelivery.push(notification);
    });
    assert.equal(disasterRetry.claimed, 2);
    assert.equal(disasterRetry.delivered, 2);
    assert.equal(disasterRetry.failed, 0);
    assert.deepEqual(new Set(disasterDelivery.map((notification) => notification.targetAdminId)), new Set([adminId, adminTwoId]));
    assert.equal(disasterDelivery.every((notification) => notification.event === "admin.recovery.disaster.issued" && notification.eventId && !("targetRecoveryCredential" in notification)), true);

    const reissuedDisasterCredential = randomBytes(32).toString("base64url");
    const reissuedDisaster = await issueDisasterRecovery(runtimePool!, {
      targetAdminId: adminTwoId,
      operatorId: "deployment-maintainer:test-001",
      offlineConfirmationId: "offline-confirmation:test-003",
      targetRecoveryCredentialHash: createHash("sha256").update(reissuedDisasterCredential, "utf8").digest("hex"),
    });
    assert.equal(reissuedDisaster.reissued, true);
    assert.notEqual(reissuedDisaster.recoveryRequestId, disaster.recoveryRequestId);
    const oldCredentialAfterReissue = await request(base, "/api/v1/admin/security/recovery/complete", { targetRecoveryCredential: disasterCredential, newPassword: randomBytes(24).toString("base64url") }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(oldCredentialAfterReissue.response.status, 409);

    const reissuedDisasterDelivery: AdminSecurityNotification[] = [];
    const reissuedDisasterRetry = await retryPendingAdminSecurityNotifications(runtimePool, async (notification) => {
      reissuedDisasterDelivery.push(notification);
    });
    assert.equal(reissuedDisasterRetry.claimed, 2);
    assert.equal(reissuedDisasterRetry.delivered, 2);
    assert.equal(reissuedDisasterDelivery.every((notification) => notification.event === "admin.recovery.disaster.issued" && notification.eventId), true);

    const slowFirstNotificationId = `notification_${randomUUID().replaceAll("-", "")}`;
    const slowFollowingNotificationId = `notification_${randomUUID().replaceAll("-", "")}`;
    await migrationPool.query(
      `INSERT INTO "zzsh_iam"."admin_security_notification_outbox" ("id", "event", "actor_id", "target_admin_id", "request_id")
       VALUES ($1, 'admin.recovery.disaster.issued', $3, $4, $5), ($2, 'admin.recovery.disaster.issued', $3, $4, $5)`,
      [slowFirstNotificationId, slowFollowingNotificationId, "deployment-maintainer:test-001", adminId, "req_outbox_barrier_first_test"],
    );
    let signalSlowFirstStarted: (() => void) | undefined;
    const slowFirstStarted = new Promise<void>((resolve) => {
      signalSlowFirstStarted = resolve;
    });
    let releaseSlowFirst: (() => void) | undefined;
    const slowFirstRelease = new Promise<void>((resolve) => {
      releaseSlowFirst = resolve;
    });
    const slowFirstDeliveries: string[] = [];
    const slowFirstRetryPromise = retryPendingAdminSecurityNotifications(runtimePool, async (notification) => {
      slowFirstDeliveries.push(notification.eventId!);
      if (notification.eventId === slowFirstNotificationId) {
        signalSlowFirstStarted!();
        await slowFirstRelease;
      }
    }, { batchSize: 2, leaseMs: 1_000, outboxIds: [slowFirstNotificationId, slowFollowingNotificationId] });
    let slowFirstBarrierTimeout: ReturnType<typeof setTimeout> | undefined;
    const slowFirstBarrier = new Promise<never>((_, reject) => {
      slowFirstBarrierTimeout = setTimeout(() => reject(new Error("slow-first barrier did not open")), 5_000);
    });
    try {
      await Promise.race([slowFirstStarted, slowFirstBarrier]);
    } finally {
      if (slowFirstBarrierTimeout) clearTimeout(slowFirstBarrierTimeout);
    }
    await migrationPool.query(
      `UPDATE "zzsh_iam"."admin_security_notification_outbox"
          SET "claimed_at" = clock_timestamp() - interval '1 minute'
        WHERE "id" IN ($1, $2)`,
      [slowFirstNotificationId, slowFollowingNotificationId],
    );
    const slowFollowingTakeoverDeliveries: string[] = [];
    const slowFollowingTakeover = await retryPendingAdminSecurityNotifications(runtimePool, async (notification) => {
      slowFollowingTakeoverDeliveries.push(notification.eventId!);
    }, { batchSize: 1, leaseMs: 1_000, outboxIds: [slowFollowingNotificationId] });
    assert.equal(slowFollowingTakeover.delivered, 1);
    releaseSlowFirst!();
    const slowFirstRetry = await slowFirstRetryPromise;
    assert.deepEqual(slowFirstDeliveries, [slowFirstNotificationId]);
    assert.equal(slowFirstRetry.claimed, 2);
    assert.equal(slowFirstRetry.delivered, 0);
    assert.equal(slowFirstRetry.lostClaim, 2);
    assert.deepEqual(slowFollowingTakeoverDeliveries, [slowFollowingNotificationId]);
    const slowFirstExpiredWriteback = await runtimePool.query<{ status: string; attempts: number; claimToken: string | null }>(
      `SELECT "status", "attempts", "claim_token" AS "claimToken"
         FROM "zzsh_iam"."admin_security_notification_outbox" WHERE "id" = $1`,
      [slowFirstNotificationId],
    );
    assert.equal(slowFirstExpiredWriteback.rows[0]?.status, "PENDING");
    assert.equal(slowFirstExpiredWriteback.rows[0]?.attempts, 1);
    assert.ok(slowFirstExpiredWriteback.rows[0]?.claimToken);
    const slowFirstRecovery = await retryPendingAdminSecurityNotifications(runtimePool, async (notification) => {
      assert.equal(notification.eventId, slowFirstNotificationId);
    }, { batchSize: 1, leaseMs: 1_000, outboxIds: [slowFirstNotificationId] });
    assert.equal(slowFirstRecovery.delivered, 1);
    const slowFirstOutboxRows = await runtimePool.query<{ id: string; status: string; attempts: number }>(
      `SELECT "id", "status", "attempts"
         FROM "zzsh_iam"."admin_security_notification_outbox"
        WHERE "id" IN ($1, $2)
        ORDER BY "id"`,
      [slowFirstNotificationId, slowFollowingNotificationId],
    );
    assert.deepEqual(slowFirstOutboxRows.rows.map((row) => row.status), ["DELIVERED", "DELIVERED"]);
    assert.deepEqual(slowFirstOutboxRows.rows.map((row) => row.attempts), [2, 2]);

    const fastFirstNotificationId = `notification_${randomUUID().replaceAll("-", "")}`;
    const slowLaterNotificationId = `notification_${randomUUID().replaceAll("-", "")}`;
    await migrationPool.query(
      `INSERT INTO "zzsh_iam"."admin_security_notification_outbox" ("id", "event", "actor_id", "target_admin_id", "request_id")
       VALUES ($1, 'admin.recovery.disaster.issued', $3, $4, $5), ($2, 'admin.recovery.disaster.issued', $3, $4, $5)`,
      [fastFirstNotificationId, slowLaterNotificationId, "deployment-maintainer:test-001", adminId, "req_outbox_barrier_later_test"],
    );
    let signalSlowLaterStarted: (() => void) | undefined;
    const slowLaterStarted = new Promise<void>((resolve) => {
      signalSlowLaterStarted = resolve;
    });
    let releaseSlowLater: (() => void) | undefined;
    const slowLaterRelease = new Promise<void>((resolve) => {
      releaseSlowLater = resolve;
    });
    const slowLaterOldDeliveries: string[] = [];
    const slowLaterOldRetryPromise = retryPendingAdminSecurityNotifications(runtimePool, async (notification) => {
      slowLaterOldDeliveries.push(notification.eventId!);
      if (notification.eventId === slowLaterNotificationId) {
        signalSlowLaterStarted!();
        await slowLaterRelease;
      }
    }, { batchSize: 2, leaseMs: 1_000, outboxIds: [fastFirstNotificationId, slowLaterNotificationId] });
    let slowLaterBarrierTimeout: ReturnType<typeof setTimeout> | undefined;
    const slowLaterBarrier = new Promise<never>((_, reject) => {
      slowLaterBarrierTimeout = setTimeout(() => reject(new Error("slow-later barrier did not open")), 5_000);
    });
    try {
      await Promise.race([slowLaterStarted, slowLaterBarrier]);
    } finally {
      if (slowLaterBarrierTimeout) clearTimeout(slowLaterBarrierTimeout);
    }
    await migrationPool.query(
      `UPDATE "zzsh_iam"."admin_security_notification_outbox"
          SET "claimed_at" = clock_timestamp() - interval '1 minute'
        WHERE "id" = $1`,
      [slowLaterNotificationId],
    );
    const slowLaterTakeoverDeliveries: string[] = [];
    const slowLaterTakeover = await retryPendingAdminSecurityNotifications(runtimePool, async (notification) => {
      slowLaterTakeoverDeliveries.push(notification.eventId!);
    }, { batchSize: 1, leaseMs: 1_000, outboxIds: [slowLaterNotificationId] });
    assert.equal(slowLaterTakeover.delivered, 1);
    releaseSlowLater!();
    const slowLaterOldRetry = await slowLaterOldRetryPromise;
    assert.deepEqual(slowLaterOldDeliveries, [fastFirstNotificationId, slowLaterNotificationId]);
    assert.equal(slowLaterOldRetry.claimed, 2);
    assert.equal(slowLaterOldRetry.delivered, 1);
    assert.equal(slowLaterOldRetry.lostClaim, 1);
    assert.deepEqual(slowLaterTakeoverDeliveries, [slowLaterNotificationId]);
    const slowLaterOutboxRow = await runtimePool.query<{ status: string; attempts: number; claimToken: string | null }>(
      `SELECT "status", "attempts", "claim_token" AS "claimToken"
         FROM "zzsh_iam"."admin_security_notification_outbox" WHERE "id" = $1`,
      [slowLaterNotificationId],
    );
    assert.deepEqual(slowLaterOutboxRow.rows[0], { status: "DELIVERED", attempts: 2, claimToken: null });

    const concurrentNotificationId = `notification_${randomUUID().replaceAll("-", "")}`;
    await migrationPool.query(
      `INSERT INTO "zzsh_iam"."admin_security_notification_outbox" ("id", "event", "actor_id", "target_admin_id", "request_id")
       VALUES ($1, 'admin.recovery.disaster.issued', $2, $3, $4)`,
      [concurrentNotificationId, "deployment-maintainer:test-001", adminId, "req_outbox_concurrent_test"],
    );
    const concurrentDeliveryIds: string[] = [];
    const concurrentRetries = await Promise.all([
      retryPendingAdminSecurityNotifications(runtimePool, async (notification) => { concurrentDeliveryIds.push(notification.eventId!); }),
      retryPendingAdminSecurityNotifications(runtimePool, async (notification) => { concurrentDeliveryIds.push(notification.eventId!); }),
    ]);
    assert.deepEqual(concurrentDeliveryIds, [concurrentNotificationId]);
    assert.equal(concurrentRetries[0].delivered + concurrentRetries[1].delivered, 1);

    const failedNotificationId = `notification_${randomUUID().replaceAll("-", "")}`;
    await migrationPool.query(
      `INSERT INTO "zzsh_iam"."admin_security_notification_outbox" ("id", "event", "actor_id", "target_admin_id", "request_id")
       VALUES ($1, 'admin.recovery.disaster.issued', $2, $3, $4)`,
      [failedNotificationId, "deployment-maintainer:test-001", adminId, "req_outbox_failure_test"],
    );
    const failedRetry = await retryPendingAdminSecurityNotifications(runtimePool, async () => { throw new Error("fake delivery failure"); });
    assert.equal(failedRetry.failed, 1);
    const failedOutboxRow = await runtimePool.query<{ status: string; attempts: number; lastError: string | null; nextAttemptAt: Date; claimToken: string | null }>(
      `SELECT "status", "attempts", "last_error" AS "lastError", "next_attempt_at" AS "nextAttemptAt", "claim_token" AS "claimToken"
         FROM "zzsh_iam"."admin_security_notification_outbox" WHERE "id" = $1`,
      [failedNotificationId],
    );
    assert.equal(failedOutboxRow.rows[0]?.status, "PENDING");
    assert.equal(failedOutboxRow.rows[0]?.attempts, 1);
    assert.equal(failedOutboxRow.rows[0]?.lastError, "delivery_failed");
    assert.ok(failedOutboxRow.rows[0]!.nextAttemptAt.getTime() > Date.now());
    assert.equal(failedOutboxRow.rows[0]?.claimToken, null);
    const notDueRetry = await retryPendingAdminSecurityNotifications(runtimePool, async () => undefined);
    assert.equal(notDueRetry.claimed, 0);
    await migrationPool.query(`UPDATE "zzsh_iam"."admin_security_notification_outbox" SET "next_attempt_at" = clock_timestamp() WHERE "id" = $1`, [failedNotificationId]);
    const recoveredRetry = await retryPendingAdminSecurityNotifications(runtimePool, async (notification) => {
      assert.equal(notification.eventId, failedNotificationId);
    });
    assert.equal(recoveredRetry.delivered, 1);
    const recoveredOutboxRow = await runtimePool.query<{ status: string; attempts: number; lastError: string | null }>(
      `SELECT "status", "attempts", "last_error" AS "lastError" FROM "zzsh_iam"."admin_security_notification_outbox" WHERE "id" = $1`,
      [failedNotificationId],
    );
    assert.deepEqual(recoveredOutboxRow.rows[0], { status: "DELIVERED", attempts: 2, lastError: null });

    const crashedNotificationId = `notification_${randomUUID().replaceAll("-", "")}`;
    await migrationPool.query(
      `INSERT INTO "zzsh_iam"."admin_security_notification_outbox" ("id", "event", "actor_id", "target_admin_id", "request_id", "claimed_at", "claim_token")
       VALUES ($1, 'admin.recovery.disaster.issued', $2, $3, $4, clock_timestamp() - interval '1 minute', 'stale-claim')`,
      [crashedNotificationId, "deployment-maintainer:test-001", adminId, "req_outbox_crash_test"],
    );
    const crashRecoveryRetry = await retryPendingAdminSecurityNotifications(runtimePool, async (notification) => {
      assert.equal(notification.eventId, crashedNotificationId);
    });
    assert.equal(crashRecoveryRetry.claimed, 1);
    assert.equal(crashRecoveryRetry.delivered, 1);

    const disasterPassword = randomBytes(24).toString("base64url");
    const disasterComplete = await request(base, "/api/v1/admin/security/recovery/complete", { targetRecoveryCredential: reissuedDisasterCredential, newPassword: disasterPassword }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(disasterComplete.response.status, 200);
    assert.equal(disasterComplete.body?.status, "PENDING_ENROLLMENT");
    await migrationPool.query(
      `UPDATE "zzsh_iam"."admin_security" SET "bootstrap_expires_at" = clock_timestamp() - interval '1 second' WHERE "admin_user_id" = $1`,
      [adminTwoId],
    );
    const expiredEnrollmentWindow = await runtimePool.query<{ bootstrapExpiresAt: Date }>(
      `SELECT "bootstrap_expires_at" AS "bootstrapExpiresAt" FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = $1`,
      [adminTwoId],
    );
    assert.ok(expiredEnrollmentWindow.rows[0]!.bootstrapExpiresAt.getTime() <= Date.now());
    const postCompleteSessionNow = new Date();
    const postCompleteSessionId = `session_post_complete_disaster_${randomUUID().replaceAll("-", "")}`;
    await migrationPool.query(
      `INSERT INTO "zzsh_auth_admin"."session" ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [postCompleteSessionId, new Date(postCompleteSessionNow.getTime() + 60 * 60 * 1000), `post-complete-token-${randomUUID()}`, postCompleteSessionNow, adminTwoId],
    );
    const postEnrollmentCredential = randomBytes(32).toString("base64url");
    const postEnrollmentDisaster = await issueDisasterRecovery(runtimePool!, {
      targetAdminId: adminTwoId,
      operatorId: "deployment-maintainer:test-001",
      offlineConfirmationId: "offline-confirmation:test-004",
      targetRecoveryCredentialHash: createHash("sha256").update(postEnrollmentCredential, "utf8").digest("hex"),
    });
    assert.equal(postEnrollmentDisaster.reissued, true);
    assert.notEqual(postEnrollmentDisaster.recoveryRequestId, reissuedDisaster.recoveryRequestId);
    const postCompleteSessionAfterRestart = await runtimePool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "zzsh_auth_admin"."session" WHERE "userId" = $1`,
      [adminTwoId],
    );
    assert.equal(postCompleteSessionAfterRestart.rows[0]?.count, "0");
    const oldCompletedCredential = await request(base, "/api/v1/admin/security/recovery/complete", { targetRecoveryCredential: reissuedDisasterCredential, newPassword: randomBytes(24).toString("base64url") }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(oldCompletedCredential.response.status, 409);
    const postEnrollmentPassword = randomBytes(24).toString("base64url");
    const postEnrollmentComplete = await request(base, "/api/v1/admin/security/recovery/complete", { targetRecoveryCredential: postEnrollmentCredential, newPassword: postEnrollmentPassword }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(postEnrollmentComplete.response.status, 200);
    const postEnrollmentDisasterDelivery: AdminSecurityNotification[] = [];
    const postEnrollmentDisasterRetry = await retryPendingAdminSecurityNotifications(runtimePool, async (notification) => {
      postEnrollmentDisasterDelivery.push(notification);
    });
    assert.equal(postEnrollmentDisasterRetry.claimed, 2);
    assert.equal(postEnrollmentDisasterRetry.delivered, 2);
    assert.equal(postEnrollmentDisasterDelivery.every((notification) => notification.event === "admin.recovery.disaster.issued" && notification.eventId), true);
    const disasterTarget = cookieJar();
    assert.equal((await request(base, "/api/auth/admin/sign-in/email", { email: "boss-two@example.invalid", password: postEnrollmentPassword }, disasterTarget, ADMIN_ORIGIN)).response.status, 200);
    const disasterTotpEnable = await request(base, "/api/auth/admin/two-factor/enable", { password: postEnrollmentPassword }, disasterTarget, ADMIN_ORIGIN);
    assert.equal(disasterTotpEnable.response.status, 200);
    const disasterTotpSecret = new URL(disasterTotpEnable.body?.totpURI as string).searchParams.get("secret");
    assert.ok(disasterTotpSecret);
    assert.equal((await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(disasterTotpSecret) }, disasterTarget, ADMIN_ORIGIN)).response.status, 200);
    assert.equal((await request(base, "/api/v1/admin/security/enrollment/activate", {}, disasterTarget, ADMIN_ORIGIN)).response.status, 200);
    const disasterAudit = await runtimePool.query<{ actorType: string; actorId: string | null; action: string; details: Record<string, unknown> }>(
      `SELECT "actor_type" AS "actorType", "actor_id" AS "actorId", "action", "details"
         FROM "zzsh_iam"."audit_event"
        WHERE "object_id" IN ($1, $2) AND "action" IN ('admin.recovery.disaster.issued', 'admin.recovery.completed')
        ORDER BY "occurred_at"`,
      [disaster.recoveryRequestId, adminTwoId],
    );
    const disasterIssuedAudit = disasterAudit.rows.find((row) => row.action === "admin.recovery.disaster.issued");
    assert.equal(disasterIssuedAudit?.actorType, "maintenance");
    assert.equal(disasterIssuedAudit?.actorId, "deployment-maintainer:test-001");
    assert.equal(disasterIssuedAudit?.details.offlineConfirmationId, "offline-confirmation:test-001");
    assert.equal(disasterIssuedAudit?.details.targetRecoveryCredential, "hash_only");
    assert.equal(JSON.stringify(disasterIssuedAudit?.details).includes(disasterCredential), false);
    const disasterCompletedAudit = disasterAudit.rows.find((row) => row.action === "admin.recovery.completed");
    assert.equal(disasterCompletedAudit?.actorType, "admin_recovery_target");
    assert.equal(disasterCompletedAudit?.details.recoveryMethod, "DISASTER_CLI");

    const securityAudit = await runtimePool.query<{ action: string; count: string }>(
      `SELECT "action", count(*)::text AS count FROM "zzsh_iam"."audit_event" WHERE "action" IN ('admin.bootstrap.created', 'admin.enrollment.activated', 'admin.pin.set', 'admin.pin.change', 'admin.pin.locked', 'admin.pin.unlock', 'admin.frozen', 'admin.unfrozen', 'admin.recovery.requested', 'admin.recovery.issued', 'admin.recovery.completed', 'admin.recovery.disaster.issued') GROUP BY "action"`,
    );
    const securityAuditCounts = new Map(securityAudit.rows.map((row) => [row.action, row.count]));
    for (const action of ["admin.bootstrap.created", "admin.enrollment.activated", "admin.pin.set", "admin.pin.change", "admin.pin.locked", "admin.pin.unlock", "admin.frozen", "admin.unfrozen", "admin.recovery.requested", "admin.recovery.issued", "admin.recovery.completed", "admin.recovery.disaster.issued"]) {
      assert.notEqual(securityAuditCounts.get(action), undefined, `missing audit action ${action}`);
    }
    assert.ok(fakeAdminNotificationOutbox.some((notification) => notification.event === "admin.frozen" && notification.targetAdminId === adminTwoId && notification.reason === "岗位调整临时冻结"));
    assert.ok(fakeAdminNotificationOutbox.some((notification) => notification.event === "admin.unfrozen" && notification.targetAdminId === adminTwoId && notification.reason === "复核后恢复登录"));
    assert.ok(fakeAdminNotificationOutbox.some((notification) => notification.event === "admin.frozen" && notification.targetAdminId === adminId && notification.reason === "同级 boss 互冻演练"));
    assert.ok(fakeAdminNotificationOutbox.some((notification) => notification.event === "admin.unfrozen" && notification.targetAdminId === adminId && notification.reason === "同级 boss 互冻演练结束"));
    assert.ok(fakeAdminNotificationOutbox.some((notification) => notification.event === "admin.recovery.issued" && notification.targetAdminId === adminId));
    assert.ok(fakeAdminNotificationOutbox.some((notification) => notification.event === "admin.recovery.completed" && notification.targetAdminId === adminId));
    const bffPasswordRotation = cookieJar();
    const bffPasswordRotationLogin = await request(base, "/api/bff/admin/auth/sign-in", {
      email: "boss-two@example.invalid",
      password: postEnrollmentPassword,
    }, bffPasswordRotation, ADMIN_ORIGIN);
    assert.equal(bffPasswordRotationLogin.response.status, 200);
    assert.equal(bffPasswordRotationLogin.body?.twoFactorRedirect, true);
    assertNoTokenHeaders(bffPasswordRotationLogin.response);
    assert.equal((await request(base, "/api/bff/admin/auth/two-factor/verify-totp", { code: totpCode(disasterTotpSecret) }, bffPasswordRotation, ADMIN_ORIGIN)).response.status, 200);
    const bffPasswordRotationOther = cookieJar();
    const bffPasswordRotationOtherLogin = await request(base, "/api/auth/admin/sign-in/email", {
      email: "boss-two@example.invalid",
      password: postEnrollmentPassword,
    }, bffPasswordRotationOther, ADMIN_ORIGIN);
    assert.equal(bffPasswordRotationOtherLogin.response.status, 200);
    assert.equal((await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(disasterTotpSecret) }, bffPasswordRotationOther, ADMIN_ORIGIN)).response.status, 200);
    const sameBffPassword = await request(base, "/api/bff/admin/auth/change-password", {
      currentPassword: postEnrollmentPassword,
      newPassword: postEnrollmentPassword,
    }, bffPasswordRotation, ADMIN_ORIGIN);
    assert.equal(sameBffPassword.response.status, 400);
    assert.equal((await request(base, "/api/bff/admin/session", undefined, bffPasswordRotation, ADMIN_ORIGIN)).body?.authenticated, true);
    const rotatedBffPassword = randomBytes(24).toString("base64url");
    const rotatedBff = await request(base, "/api/bff/admin/auth/change-password", {
      currentPassword: postEnrollmentPassword,
      newPassword: rotatedBffPassword,
    }, bffPasswordRotation, ADMIN_ORIGIN);
    assert.equal(rotatedBff.response.status, 200);
    assert.equal(rotatedBff.body?.token, undefined);
    assertNoTokenHeaders(rotatedBff.response);
    const revokedBffPasswordRotationOther = await request(base, "/api/auth/admin/get-session", undefined, bffPasswordRotationOther, ADMIN_ORIGIN);
    assert.equal(revokedBffPasswordRotationOther.response.status, 200);
    assert.equal(revokedBffPasswordRotationOther.body, null);
    assert.equal((await request(base, "/api/bff/admin/session", undefined, bffPasswordRotation, ADMIN_ORIGIN)).body?.authenticated, true);
    const notificationOutbox = await runtimePool.query<{ status: string; count: string }>(`SELECT "status", count(*)::text AS count FROM "zzsh_iam"."admin_security_notification_outbox" GROUP BY "status"`);
    assert.equal(notificationOutbox.rows.length, 1);
    assert.equal(notificationOutbox.rows[0]?.status, "DELIVERED");
    assert.ok(Number(notificationOutbox.rows[0]?.count) > 0);
  } finally {
    const cleanupErrors: unknown[] = [];
    if (app) {
      try {
        await app.close();
        runtimeClosedByApp = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (runtimePool && !runtimeClosedByApp) {
      try {
        await runtimePool.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      await releaseResourceGuard(resourceGuard);
    } catch (error) {
      cleanupErrors.push(error);
    }
    for (const pool of [migrationPool, maintenanceDataPool, maintenancePool]) {
      if (!pool) continue;
      try {
        await pool.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) throw cleanupErrors[0];
  }
});
