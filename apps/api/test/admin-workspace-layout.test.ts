import { ISOLATED_BUSINESS_DATA_TRUNCATE } from "./database-test-support";
import { strict as assert } from "node:assert";
import { createHmac, randomBytes } from "node:crypto";
import { test } from "node:test";

import { Pool, type PoolClient } from "pg";

import { createApp } from "../src/app";
import { loadAuthRuntimeConfig } from "../src/auth/auth-runtime";
import { assertBusinessRuntimeIdentity, createBusinessPool } from "../src/database/business";
import { runBusinessMigrations } from "../src/database/business-migrations";
import { WORKSPACE_LAYOUT_LOCK_PREFIX } from "../src/auth/admin-workspace-layout";
import { loadConfig, type AppConfig } from "../src/config/config";

const DEFAULT_DATABASE = "zzsh_test_m2_workspace_layout";
const RESOURCE_MARKER = "zzsh:m2-workspace-layout-test:v1";
const LOCK_KEY = "805014";
const USER_ORIGIN = "http://127.0.0.1:3100";
const ADMIN_ORIGIN = "http://127.0.0.1:3101";
const API_ORIGIN = "http://127.0.0.1:3102";
const BUSINESS_SCHEMAS = ["zzsh_business_meta", "zzsh_iam", "zzsh_auth_user", "zzsh_auth_admin", "zzsh_supply"] as const;

type CookieJar = { values: Map<string, string>; update: (response: Response) => void; header: () => string };
type Resources = {
  maintenance: AppConfig;
  migration: AppConfig;
  runtime: AppConfig;
  databaseName: string;
  migrationUser: string;
  runtimeUser: string;
  migrationPassword: string;
  runtimePassword: string;
};
type Staff = { id: string; username: string; jar: CookieJar; password: string; secret: string };

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
    header: () => [...values.entries()].map(([name, value]) => name + "=" + value).join("; "),
  };
}

function safeIdentifier(value: string, label: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error(label + " is not a safe identifier");
  return value;
}

function quotedIdentifier(value: string, label: string): string {
  return "\"" + safeIdentifier(value, label) + "\"";
}

function quotedLiteral(value: string): string {
  return "'" + value.replaceAll("'", "''") + "'";
}

function roleMarker(databaseName: string, role: "migration" | "runtime"): string {
  return RESOURCE_MARKER + ":" + databaseName + ":" + role;
}

function makeResources(): Resources {
  const databaseName = process.env.M2_WORKSPACE_LAYOUT_TEST_DB_NAME?.trim() || DEFAULT_DATABASE;
  assert.notEqual(databaseName, "zzsh_dev");
  const migrationUser = safeIdentifier(process.env.M2_WORKSPACE_LAYOUT_TEST_MIGRATION_USER?.trim() || "zzsh_m2_layout_migration", "migration user");
  const runtimeUser = safeIdentifier(process.env.M2_WORKSPACE_LAYOUT_TEST_RUNTIME_USER?.trim() || "zzsh_m2_layout_runtime", "runtime user");
  assert.notEqual(migrationUser, runtimeUser);
  if (!migrationUser.startsWith("zzsh_m2_") || !runtimeUser.startsWith("zzsh_m2_")) throw new Error("workspace layout test roles must use the isolated zzsh_m2_ prefix");
  const maintenanceUser = process.env.M2_WORKSPACE_LAYOUT_TEST_MAINTENANCE_USER ?? process.env.DB_USER;
  const baseEnv = {
    ...process.env,
    APP_PROFILE: "test",
    PROVIDER_MODE: "fake",
    DB_TARGET: "local-compose",
    DB_NAME: databaseName,
    ...(maintenanceUser ? { DB_USER: maintenanceUser } : {}),
  };
  const maintenance = loadConfig(baseEnv);
  const migrationPassword = process.env.M2_WORKSPACE_LAYOUT_TEST_MIGRATION_PASSWORD?.trim() || randomBytes(32).toString("hex");
  const runtimePassword = process.env.M2_WORKSPACE_LAYOUT_TEST_RUNTIME_PASSWORD?.trim() || randomBytes(32).toString("hex");
  const runtime = loadConfig({ ...baseEnv, DB_USER: runtimeUser, DB_PASSWORD: runtimePassword, DB_PASSWORD_FILE: undefined });
  const migration = loadConfig({
    ...baseEnv,
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

async function resourceGuard(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    const identity = await client.query<{ databaseName: string; currentUser: string; port: string }>("SELECT current_database() AS \"databaseName\", current_user AS \"currentUser\", current_setting('port') AS port");
    assert.equal(identity.rows[0]?.databaseName, "postgres");
    assert.equal(identity.rows[0]?.currentUser, pool.options.user);
    assert.equal(identity.rows[0]?.port, "5432");
    assert.equal((await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [LOCK_KEY])).rows[0]?.acquired, true, "dedicated workspace layout test target is already in use");
    return client;
  } catch (error) {
    client.release(true);
    throw error;
  }
}

async function ensureDatabase(pool: Pool, resources: Resources): Promise<void> {
  const existing = await pool.query<{ owner: string; allowConnections: boolean; isTemplate: boolean; comment: string | null }>(
    "SELECT pg_get_userbyid(d.datdba) AS owner, d.datallowconn AS \"allowConnections\", d.datistemplate AS \"isTemplate\", shobj_description(d.oid, 'pg_database') AS comment FROM pg_database d WHERE d.datname = $1",
    [resources.databaseName],
  );
  if (existing.rows.length === 0) {
    await pool.query("CREATE DATABASE " + quotedIdentifier(resources.databaseName, "test database") + " OWNER " + quotedIdentifier(resources.maintenance.database.user, "maintenance user"));
    await pool.query("COMMENT ON DATABASE " + quotedIdentifier(resources.databaseName, "test database") + " IS " + quotedLiteral(RESOURCE_MARKER));
    return;
  }
  assert.equal(existing.rows[0]?.owner, resources.maintenance.database.user, "dedicated test database owner changed");
  assert.equal(existing.rows[0]?.allowConnections, true);
  assert.equal(existing.rows[0]?.isTemplate, false);
  assert.equal(existing.rows[0]?.comment, RESOURCE_MARKER, "dedicated test database marker is missing or mismatched");
}

async function ensureRole(pool: Pool, roleName: string, password: string, marker: string): Promise<void> {
  const current = await pool.query<{ comment: string | null; canLogin: boolean; isSuperuser: boolean; canCreateRole: boolean; canCreateDb: boolean; canInherit: boolean; canReplicate: boolean; canBypassRls: boolean }>(
    "SELECT shobj_description(r.oid, 'pg_authid') AS comment, r.rolcanlogin AS \"canLogin\", r.rolsuper AS \"isSuperuser\", r.rolcreaterole AS \"canCreateRole\", r.rolcreatedb AS \"canCreateDb\", r.rolinherit AS \"canInherit\", r.rolreplication AS \"canReplicate\", r.rolbypassrls AS \"canBypassRls\" FROM pg_roles r WHERE r.rolname = $1",
    [roleName],
  );
  const role = quotedIdentifier(roleName, "test role");
  if (current.rows.length > 0) {
    const row = current.rows[0]!;
    assert.equal(row.comment, marker, roleName + " marker is missing or mismatched");
    assert.deepEqual([row.canLogin, row.isSuperuser, row.canCreateRole, row.canCreateDb, row.canInherit, row.canReplicate, row.canBypassRls], [true, false, false, false, false, false, false], roleName + " is not a least-privilege login role");
    await pool.query("ALTER ROLE " + role + " PASSWORD " + quotedLiteral(password));
    return;
  }
  await pool.query("CREATE ROLE " + role + " LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS PASSWORD " + quotedLiteral(password));
  await pool.query("COMMENT ON ROLE " + role + " IS " + quotedLiteral(marker));
}

async function grantDatabaseAccess(pool: Pool, resources: Resources): Promise<void> {
  const database = quotedIdentifier(resources.databaseName, "test database");
  await pool.query("GRANT CONNECT ON DATABASE " + database + " TO " + quotedIdentifier(resources.migrationUser, "migration user") + ", " + quotedIdentifier(resources.runtimeUser, "runtime user"));
  await pool.query("GRANT CREATE ON DATABASE " + database + " TO " + quotedIdentifier(resources.migrationUser, "migration user"));
}

async function prepareOwnership(pool: Pool, resources: Resources): Promise<void> {
  const migrationRole = quotedIdentifier(resources.migrationUser, "migration user");
  for (const schemaName of BUSINESS_SCHEMAS) {
    const schema = quotedIdentifier(schemaName, "business schema");
    const ownerResult = await pool.query<{ owner: string }>("SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1", [schemaName]);
    if (ownerResult.rows.length === 0) await pool.query("CREATE SCHEMA " + schema);
    else assert.ok([resources.maintenance.database.user, resources.migrationUser].includes(ownerResult.rows[0]!.owner), "business schema owner is outside the dedicated test target");
    const owner = ownerResult.rows.length === 0 ? resources.maintenance.database.user : ownerResult.rows[0]!.owner;
    if (owner !== resources.migrationUser) await pool.query("ALTER SCHEMA " + schema + " OWNER TO " + migrationRole);
  }
  const relations = await pool.query<{ schemaName: string; relationName: string; kind: string; owner: string }>(
    "SELECT n.nspname AS \"schemaName\", c.relname AS \"relationName\", c.relkind AS kind, pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = ANY($1::text[]) AND c.relkind IN ('r', 'p', 'S')",
    [BUSINESS_SCHEMAS],
  );
  for (const row of relations.rows) {
    assert.ok([resources.maintenance.database.user, resources.migrationUser].includes(row.owner), "business relation owner is outside the dedicated test target");
    if (row.owner !== resources.migrationUser) {
      const relation = quotedIdentifier(row.schemaName, "business schema") + "." + "\"" + row.relationName.replaceAll("\"", "\"\"") + "\"";
      await pool.query((row.kind === "S" ? "ALTER SEQUENCE " : "ALTER TABLE ") + relation + " OWNER TO " + migrationRole);
    }
  }
}

async function resetIsolatedData(pool: Pool): Promise<void> {
  await pool.query(ISOLATED_BUSINESS_DATA_TRUNCATE);
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
  const value = ((digest[offset]! & 0x7f) << 24) | ((digest[offset + 1]! & 0xff) << 16) | ((digest[offset + 2]! & 0xff) << 8) | (digest[offset + 3]! & 0xff);
  return String(value % 1_000_000).padStart(6, "0");
}

async function readJson(response: Response): Promise<Record<string, any> | null> {
  const text = await response.text();
  return text ? JSON.parse(text) as Record<string, any> : null;
}

async function request(base: string, path: string, body: Record<string, unknown> | undefined, jar: CookieJar, origin: string, method?: string): Promise<{ response: Response; body: Record<string, any> | null }> {
  const verb = method ?? (body === undefined ? "GET" : "POST");
  const response = await fetch(base + path, {
    method: verb,
    headers: { origin, ...(verb === "GET" ? {} : { "content-type": "application/json" }), ...(jar.header() ? { cookie: jar.header() } : {}) },
    body: verb === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  jar.update(response);
  return { response, body: await readJson(response) };
}

async function activate(base: string, username: string, temporaryPassword: string): Promise<Staff> {
  const jar = cookieJar();
  assert.equal((await request(base, "/api/auth/admin/sign-in/username", { username, password: temporaryPassword }, jar, ADMIN_ORIGIN)).response.status, 200);
  const password = randomBytes(24).toString("base64url");
  assert.equal((await request(base, "/api/auth/admin/change-password", { currentPassword: temporaryPassword, newPassword: password }, jar, ADMIN_ORIGIN)).response.status, 200);
  const enabled = await request(base, "/api/auth/admin/two-factor/enable", { password }, jar, ADMIN_ORIGIN);
  assert.equal(enabled.response.status, 200);
  const secret = new URL(enabled.body?.totpURI as string).searchParams.get("secret");
  assert.ok(secret);
  assert.equal((await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(secret) }, jar, ADMIN_ORIGIN)).response.status, 200);
  assert.equal((await request(base, "/api/v1/admin/security/enrollment/activate", {}, jar, ADMIN_ORIGIN)).response.status, 200);
  const session = await request(base, "/api/bff/admin/session", undefined, jar, ADMIN_ORIGIN);
  assert.equal(session.body?.authenticated, true);
  return { id: session.body?.adminUserId as string, username, jar, password, secret };
}

test("admin workspace layout is personal, versioned, and rejected when locked or unauthenticated", async () => {
  let resources: Resources | undefined;
  let maintenancePool: Pool | undefined;
  let maintenanceDataPool: Pool | undefined;
  let migrationPool: Pool | undefined;
  let runtimePool: Pool | undefined;
  let guard: PoolClient | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let runtimeClosedByApp = false;
  try {
    resources = makeResources();
    maintenancePool = poolFor(resources.maintenance, "postgres", "zzsh-m2-layout-maintenance", 2);
    guard = await resourceGuard(maintenancePool);
    await ensureDatabase(maintenancePool, resources);
    await ensureRole(maintenancePool, resources.migrationUser, resources.migrationPassword, roleMarker(resources.databaseName, "migration"));
    await ensureRole(maintenancePool, resources.runtimeUser, resources.runtimePassword, roleMarker(resources.databaseName, "runtime"));
    await grantDatabaseAccess(maintenancePool, resources);
    maintenanceDataPool = poolFor(resources.maintenance, resources.databaseName, "zzsh-m2-layout-owner", 2);
    await prepareOwnership(maintenanceDataPool, resources);
    migrationPool = createBusinessPool(resources.migration);
    await runBusinessMigrations(migrationPool, { runtimeUser: resources.runtimeUser });
    runtimePool = createBusinessPool(resources.runtime);
    await assertBusinessRuntimeIdentity(runtimePool, resources.runtime);
    await resetIsolatedData(maintenanceDataPool);

    const table = await runtimePool.query<{ exists: boolean }>("SELECT to_regclass('zzsh_iam.admin_workspace_layout') IS NOT NULL AS exists");
    assert.equal(table.rows[0]?.exists, true);

    const bootstrapSecret = randomBytes(32).toString("hex");
    const authOptions = {
      ...loadAuthRuntimeConfig({
        AUTH_API_ORIGIN: API_ORIGIN,
        AUTH_USER_ORIGIN: USER_ORIGIN,
        AUTH_ADMIN_ORIGIN: ADMIN_ORIGIN,
        AUTH_USER_SECRET: randomBytes(32).toString("hex"),
        AUTH_ADMIN_SECRET: randomBytes(32).toString("hex"),
        AUTH_ADMIN_BOOTSTRAP_SECRET: bootstrapSecret,
      }, undefined, { testOperationsEnabled: true }),
      pool: runtimePool,
    };
    app = await createApp({
      health: {
        dependencies: {
          postgres: { check: async () => undefined, close: async () => undefined },
          redis: { check: async () => undefined, close: async () => undefined },
        },
      },
      database: { pool: runtimePool },
      auth: authOptions,
    });
    await app.listen(0, "127.0.0.1");
    const base = await app.getUrl();

    const unauthenticated = await request(base, "/api/bff/admin/workspace/layout", undefined, cookieJar(), ADMIN_ORIGIN);
    assert.equal(unauthenticated.response.status, 401);

    const bossInitialPassword = randomBytes(24).toString("base64url");
    const bootstrap = await request(base, "/api/v1/admin/security/bootstrap", { bootstrapSecret, name: "布局 Boss", password: bossInitialPassword }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(bootstrap.response.status, 200);
    const boss = await activate(base, bootstrap.body?.username as string, bossInitialPassword);

    const created = await request(base, "/api/v1/admin/security/admins/create", { name: "低权限布局员", allowPermissions: [] }, boss.jar, ADMIN_ORIGIN);
    assert.equal(created.response.status, 200);
    const staff = await activate(base, created.body?.username as string, created.body?.temporaryPassword as string);

    const empty = await request(base, "/api/bff/admin/workspace/layout", undefined, boss.jar, ADMIN_ORIGIN);
    assert.equal(empty.response.status, 200);
    assert.equal(empty.body?.version, 0);
    assert.equal(empty.body?.layoutVersion, 2);
    assert.ok(Array.isArray(empty.body?.widgets));
    assert.ok(empty.body.widgets.some((item: { id: string }) => item.id === "shortcuts"));
    assert.ok(empty.body.widgets.every((item: { x: number; y: number; w: number; h: number }) =>
      Number.isInteger(item.x) && Number.isInteger(item.y) && Number.isInteger(item.w) && Number.isInteger(item.h) && item.w > 0 && item.h > 0 && item.x + item.w <= 12));

    const widgets = [
      { id: "shortcuts", x: 0, y: 0, w: 6, h: 4, timeRange: "today" },
      { id: "account-security", x: 6, y: 0, w: 5, h: 4, timeRange: "today" },
    ];
    const invalidInitialVersion = await request(base, "/api/bff/admin/workspace/layout", { layoutVersion: 2, version: 5, widgets }, boss.jar, ADMIN_ORIGIN, "PUT");
    assert.equal(invalidInitialVersion.response.status, 409);
    const saved = await request(base, "/api/bff/admin/workspace/layout", { layoutKind: "admin.workspace.layout", layoutVersion: 2, version: 0, widgets }, boss.jar, ADMIN_ORIGIN, "PUT");
    assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body?.version, 1);
    assert.equal(saved.body?.layoutVersion, 2);
    assert.deepEqual(saved.body?.widgets, widgets);

    const reread = await request(base, "/api/bff/admin/workspace/layout", undefined, boss.jar, ADMIN_ORIGIN);
    assert.equal(reread.body?.version, 1);
    assert.deepEqual(reread.body?.widgets, widgets);

    const staffRead = await request(base, "/api/bff/admin/workspace/layout", undefined, staff.jar, ADMIN_ORIGIN);
    assert.equal(staffRead.response.status, 200);
    assert.equal(staffRead.body?.version, 0);
    assert.equal(staffRead.body?.widgets.some((item: { id: string }) => item.id === "pending-approvals"), false);

    const forbidden = await request(base, "/api/bff/admin/workspace/layout", { layoutKind: "admin.workspace.layout", layoutVersion: 2, version: 0, widgets: [{ id: "pending-approvals", x: 0, y: 0, w: 6, h: 6, timeRange: "today" }] }, staff.jar, ADMIN_ORIGIN, "PUT");
    assert.equal(forbidden.response.status, 403);

    // 旧格式（order + sm/md/lg）写入被接受并按确定规则转换：lg→6 列、md→5 列、sm→4 列，高度取组件默认，按 order 依次排布换行。
    const legacySave = await request(base, "/api/bff/admin/workspace/layout", {
      layoutKind: "admin.workspace.layout",
      version: 0,
      widgets: [
        { id: "shortcuts", size: "lg", order: 0, timeRange: "7d" },
        { id: "account-security", size: "md", order: 1 },
        { id: "permission-guide", size: "sm", order: 2 },
      ],
    }, staff.jar, ADMIN_ORIGIN, "PUT");
    assert.equal(legacySave.response.status, 200, JSON.stringify(legacySave.body));
    assert.equal(legacySave.body?.layoutVersion, 2);
    assert.deepEqual(legacySave.body?.widgets, [
      { id: "shortcuts", x: 0, y: 0, w: 6, h: 4, timeRange: "7d" },
      { id: "account-security", x: 6, y: 0, w: 5, h: 4 },
      { id: "permission-guide", x: 0, y: 4, w: 4, h: 3 },
    ]);
    const legacyReread = await request(base, "/api/bff/admin/workspace/layout", undefined, staff.jar, ADMIN_ORIGIN);
    assert.deepEqual(legacyReread.body?.widgets, legacySave.body?.widgets);

    // 旧版本代码遗留的 v1 JSONB 行（如既有环境）：读取时按同一确定规则转换，并发 version 保持不变。
    await runtimePool.query(
      `UPDATE "zzsh_iam"."admin_workspace_layout" SET "widgets" = $1::jsonb WHERE "admin_user_id" = $2`,
      [JSON.stringify([
        { id: "shortcuts", size: "lg", order: 0 },
        { id: "account-security", size: "sm", order: 1, timeRange: "30d" },
      ]), staff.id],
    );
    const legacyRowRead = await request(base, "/api/bff/admin/workspace/layout", undefined, staff.jar, ADMIN_ORIGIN);
    assert.equal(legacyRowRead.body?.version, 1);
    assert.equal(legacyRowRead.body?.layoutVersion, 2);
    assert.deepEqual(legacyRowRead.body?.widgets, [
      { id: "shortcuts", x: 0, y: 0, w: 6, h: 4 },
      { id: "account-security", x: 6, y: 0, w: 4, h: 4, timeRange: "30d" },
    ]);

    const staffTwo = cookieJar();
    assert.equal((await request(base, "/api/auth/admin/sign-in/username", { username: staff.username, password: staff.password }, staffTwo, ADMIN_ORIGIN)).response.status, 200);
    assert.equal((await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(staff.secret) }, staffTwo, ADMIN_ORIGIN)).response.status, 200);
    const lockRow = await runtimePool.query<{ k: string }>("SELECT hashtextextended($1, 0)::text AS k", [`${WORKSPACE_LAYOUT_LOCK_PREFIX}${staff.id}`]);
    const lockKey = lockRow.rows[0]?.k;
    assert.ok(lockKey);
    const barrier = await runtimePool.connect();
    try {
      await barrier.query("SELECT pg_advisory_lock($1::bigint)", [lockKey]);
      const firstWidgets = [{ id: "shortcuts", x: 0, y: 0, w: 6, h: 4 }];
      const secondWidgets = [{ id: "account-security", x: 0, y: 0, w: 5, h: 4 }];
      const racing = Promise.all([
        request(base, "/api/bff/admin/workspace/layout", { layoutKind: "admin.workspace.layout", layoutVersion: 2, version: 1, widgets: firstWidgets }, staff.jar, ADMIN_ORIGIN, "PUT"),
        request(base, "/api/bff/admin/workspace/layout", { layoutKind: "admin.workspace.layout", layoutVersion: 2, version: 1, widgets: secondWidgets }, staffTwo, ADMIN_ORIGIN, "PUT"),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 250));
      await barrier.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey]);
      const [left, right] = await racing;
      const statuses = [left.response.status, right.response.status].sort((a, b) => a - b);
      assert.deepEqual(statuses, [200, 409], JSON.stringify({ left: left.body, right: right.body }));
      const winner = left.response.status === 200 ? left : right;
      assert.equal(winner.body?.version, 2);
      const afterRace = await request(base, "/api/bff/admin/workspace/layout", undefined, staff.jar, ADMIN_ORIGIN);
      assert.equal(afterRace.body?.version, 2);
      assert.equal(afterRace.body?.widgets.length, 1);
      assert.equal(afterRace.body?.widgets[0]?.id, winner.body?.widgets[0]?.id);
    } finally {
      try { await barrier.query("SELECT pg_advisory_unlock($1::bigint)", [lockKey]); } catch { /* already unlocked */ }
      barrier.release();
    }

    const invalidWidget = await request(base, "/api/bff/admin/workspace/layout", { layoutKind: "admin.workspace.layout", layoutVersion: 2, version: 1, widgets: [{ id: "not-a-widget", x: 0, y: 0, w: 4, h: 3 }] }, boss.jar, ADMIN_ORIGIN, "PUT");
    assert.equal(invalidWidget.response.status, 400);

    const badCoordinates = [
      [{ id: "shortcuts", x: -1, y: 0, w: 6, h: 4 }],
      [{ id: "shortcuts", x: 0, y: 0, w: 0, h: 4 }],
      [{ id: "shortcuts", x: 7, y: 0, w: 6, h: 4 }],
      [{ id: "shortcuts", x: 0, y: 0, w: 3, h: 4 }],
      [{ id: "account-security", x: 0, y: 0, w: 5, h: 2 }],
      [{ id: "shortcuts", x: 0, y: 0, w: 6, h: 4.5 }],
      [{ id: "shortcuts", x: 0, y: 49, w: 6, h: 4 }],
    ];
    for (const bad of badCoordinates) {
      const rejected = await request(base, "/api/bff/admin/workspace/layout", { layoutKind: "admin.workspace.layout", layoutVersion: 2, version: 1, widgets: bad }, boss.jar, ADMIN_ORIGIN, "PUT");
      assert.equal(rejected.response.status, 400, JSON.stringify(bad));
    }
    const badVersion = await request(base, "/api/bff/admin/workspace/layout", { layoutKind: "admin.workspace.layout", layoutVersion: 3, version: 1, widgets }, boss.jar, ADMIN_ORIGIN, "PUT");
    assert.equal(badVersion.response.status, 400);
    const mixedFormats = await request(base, "/api/bff/admin/workspace/layout", { layoutKind: "admin.workspace.layout", version: 1, widgets: [widgets[0], { id: "permission-guide", size: "sm", order: 1 }] }, boss.jar, ADMIN_ORIGIN, "PUT");
    assert.equal(mixedFormats.response.status, 400);

    const stale = await request(base, "/api/bff/admin/workspace/layout", { layoutKind: "admin.workspace.layout", layoutVersion: 2, version: 0, widgets }, boss.jar, ADMIN_ORIGIN, "PUT");
    assert.equal(stale.response.status, 409);

    const secondDevice = cookieJar();
    assert.equal((await request(base, "/api/auth/admin/sign-in/username", { username: boss.username, password: boss.password }, secondDevice, ADMIN_ORIGIN)).response.status, 200);
    assert.equal((await request(base, "/api/auth/admin/two-factor/verify-totp", { code: totpCode(boss.secret) }, secondDevice, ADMIN_ORIGIN)).response.status, 200);
    const otherDevice = await request(base, "/api/bff/admin/workspace/layout", undefined, secondDevice, ADMIN_ORIGIN);
    assert.equal(otherDevice.body?.version, 1);
    assert.deepEqual(otherDevice.body?.widgets.map((item: { id: string }) => item.id), ["shortcuts", "account-security"]);

    await request(base, "/api/bff/admin/security/pin/set", { pin: "246810" }, boss.jar, ADMIN_ORIGIN);
    assert.equal((await request(base, "/api/bff/admin/security/pin/lock", {}, boss.jar, ADMIN_ORIGIN)).response.status, 200);
    const locked = await request(base, "/api/bff/admin/workspace/layout", { layoutKind: "admin.workspace.layout", version: 1, widgets }, boss.jar, ADMIN_ORIGIN, "PUT");
    assert.equal(locked.response.status, 423);
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
      try { await runtimePool.end(); } catch (error) { cleanupErrors.push(error); }
    }
    if (guard) {
      try {
        await guard.query("SELECT pg_advisory_unlock($1::bigint)", [LOCK_KEY]);
        guard.release();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const pool of [migrationPool, maintenanceDataPool, maintenancePool]) {
      if (!pool) continue;
      try { await pool.end(); } catch (error) { cleanupErrors.push(error); }
    }
    if (cleanupErrors.length > 0) throw cleanupErrors[0];
  }
});
