// ADM-USER-DIRECTORY-READ-1: admin user directory read API acceptance on real PostgreSQL.
// Covers list projection (legacy/local/unknown sources, masked identifiers), permission and
// game-scope boundaries, phone-lookup gating, cursor binding, detail/accounts/orders/audit
// sub-resources and BFF parity. All fixture users are synthetic for this isolated resource.

import { strict as assert } from "node:assert";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";

import { createApp } from "../src/app";
import { loadAuthRuntimeConfig } from "../src/auth/auth-runtime";
import { legacyOwnerEvidenceDigest, migrateLegacyOwner, type LegacyOwnerEvidence } from "../src/supply/legacy-user-migration";
import { createFakeRealNameProvider } from "../src/auth/user-identity";
import { withTransaction } from "../src/auth/security-core";
import { loadConfig, type AppConfig } from "../src/config/config";
import { assertBusinessRuntimeIdentity, createBusinessPool } from "../src/database/business";
import { runBusinessMigrations } from "../src/database/business-migrations";
import { ISOLATED_BUSINESS_DATA_TRUNCATE } from "./database-test-support";

const RESOURCE_SET = process.env.USER_DIRECTORY_TEST_RESOURCE_SET?.trim() || "";
if (RESOURCE_SET && !/^[a-z][a-z0-9_]{0,20}$/.test(RESOURCE_SET)) throw new Error("Invalid user directory test resource set");
const DEFAULT_DATABASE = RESOURCE_SET ? "zzsh_test_admin_" + RESOURCE_SET : "zzsh_test_admin_user_directory";
const ROLE_PREFIX = "zzsh_admin_";
const RESOURCE_MARKER = "zzsh:user-directory-test:v1";
const LOCK_KEY = RESOURCE_SET
  ? (BigInt("0x" + createHash("sha256").update("user-directory-test:" + RESOURCE_SET).digest("hex").slice(0, 15)) + 2000000n).toString()
  : "930101";
const USER_ORIGIN = "http://127.0.0.1:3100";
const ADMIN_ORIGIN = "http://127.0.0.1:3101";
const API_ORIGIN = "http://127.0.0.1:3102";
const BUSINESS_SCHEMAS = ["zzsh_business_meta", "zzsh_iam", "zzsh_auth_user", "zzsh_auth_admin", "zzsh_supply", "zzsh_content", "zzsh_order"] as const;

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
type Staff = { id: string; sessionId: string; username: string; jar: CookieJar; password: string; secret: string };

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
  const databaseName = process.env.USER_DIRECTORY_TEST_DB_NAME?.trim() || DEFAULT_DATABASE;
  assert.notEqual(databaseName, "zzsh_dev");
  const migrationUser = safeIdentifier(process.env.USER_DIRECTORY_TEST_MIGRATION_USER?.trim() || (RESOURCE_SET ? ROLE_PREFIX + RESOURCE_SET + "_m" : "zzsh_admin_user_directory_m"), "migration user");
  const runtimeUser = safeIdentifier(process.env.USER_DIRECTORY_TEST_RUNTIME_USER?.trim() || (RESOURCE_SET ? ROLE_PREFIX + RESOURCE_SET + "_r" : "zzsh_admin_user_directory_r"), "runtime user");
  assert.notEqual(migrationUser, runtimeUser);
  if (RESOURCE_SET) {
    assert.equal(databaseName, DEFAULT_DATABASE);
    assert.equal(migrationUser, ROLE_PREFIX + RESOURCE_SET + "_m");
    assert.equal(runtimeUser, ROLE_PREFIX + RESOURCE_SET + "_r");
  }
  if (!migrationUser.startsWith(ROLE_PREFIX) || !runtimeUser.startsWith(ROLE_PREFIX)) throw new Error("user directory test role prefix mismatch");
  const maintenanceUser = process.env.USER_DIRECTORY_TEST_MAINTENANCE_USER ?? process.env.DB_USER;
  const baseEnv = {
    ...process.env,
    APP_PROFILE: "test",
    PROVIDER_MODE: "fake",
    DB_TARGET: "local-compose",
    DB_NAME: databaseName,
    ...(maintenanceUser ? { DB_USER: maintenanceUser } : {}),
  };
  const maintenance = loadConfig(baseEnv);
  const migrationPassword = process.env.USER_DIRECTORY_TEST_MIGRATION_PASSWORD?.trim() || randomBytes(32).toString("hex");
  const runtimePassword = process.env.USER_DIRECTORY_TEST_RUNTIME_PASSWORD?.trim() || randomBytes(32).toString("hex");
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

async function resourceGuard(pool: Pool, resources: Resources): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    const identity = await client.query<{ databaseName: string; currentUser: string; port: string }>("SELECT current_database() AS \"databaseName\", current_user AS \"currentUser\", current_setting('port') AS port");
    assert.equal(identity.rows[0]?.databaseName, "postgres");
    assert.equal(identity.rows[0]?.currentUser, pool.options.user);
    assert.equal(identity.rows[0]?.port, "5432");
    assert.equal((await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [LOCK_KEY])).rows[0]?.acquired, true, "dedicated user directory test target is already in use");
    const db = (await client.query(`SELECT pg_get_userbyid(datdba) AS owner,
      shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1`, [resources.databaseName])).rows[0];
    if (db) {
      assert.equal(db.owner, resources.maintenance.database.user);
      assert.equal(db.marker, RESOURCE_MARKER);
      assert.equal((await client.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=$1`, [resources.databaseName])).rows[0].n, 0, "another connection owns this database");
    }
    for (const [name, kind] of [[resources.migrationUser, "migration"], [resources.runtimeUser, "runtime"]] as const) {
      const row = (await client.query(`SELECT rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolinherit,rolreplication,rolbypassrls,
        shobj_description(oid,'pg_authid') AS marker,
        EXISTS(SELECT 1 FROM pg_auth_members WHERE member=r.oid OR roleid=r.oid) AS membership,
        EXISTS(SELECT 1 FROM pg_database WHERE datdba=r.oid) AS owns_db FROM pg_roles r WHERE rolname=$1`, [name])).rows[0];
      if (!row) continue;
      assert.deepEqual(row, { rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false,
        rolinherit: false, rolreplication: false, rolbypassrls: false, marker: roleMarker(resources.databaseName, kind), membership: false, owns_db: false });
    }
    console.log("user directory resource preflight PASS", resources.databaseName, LOCK_KEY);
    return client;
  } catch (error) {
    client.release(true);
    throw error;
  }
}

async function ensureDatabase(pool: Pool, resources: Resources): Promise<void> {
  const existing = await pool.query<{ owner: string; comment: string | null }>(
    "SELECT pg_get_userbyid(d.datdba) AS owner, shobj_description(d.oid, 'pg_database') AS comment FROM pg_database d WHERE d.datname = $1",
    [resources.databaseName],
  );
  if (existing.rows.length === 0) {
    await pool.query("CREATE DATABASE " + quotedIdentifier(resources.databaseName, "test database") + " OWNER " + quotedIdentifier(resources.maintenance.database.user, "maintenance user"));
    await pool.query("COMMENT ON DATABASE " + quotedIdentifier(resources.databaseName, "test database") + " IS " + quotedLiteral(RESOURCE_MARKER));
    return;
  }
  assert.equal(existing.rows[0]?.owner, resources.maintenance.database.user, "dedicated test database owner changed");
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
  return text ? (JSON.parse(text) as Record<string, any>) : null;
}

async function request(
  base: string,
  path: string,
  body: Record<string, unknown> | undefined,
  jar: CookieJar,
  origin: string,
  method?: string,
  extraHeaders: Record<string, string> = {},
): Promise<{ response: Response; body: Record<string, any> | null }> {
  const verb = method ?? (body === undefined ? "GET" : "POST");
  const response = await fetch(base + path, {
    method: verb,
    headers: {
      origin,
      ...(verb === "GET" ? {} : { "content-type": "application/json" }),
      ...(jar.header() ? { cookie: jar.header() } : {}),
      ...extraHeaders,
    },
    body: verb === "GET" ? undefined : JSON.stringify(body ?? {}),
  });
  jar.update(response);
  return { response, body: await readJson(response) };
}

function orderKey(): Record<string, string> {
  return { "idempotency-key": `idem_${randomUUID().replaceAll("-", "")}` };
}

async function activateStaff(base: string, username: string, temporaryPassword: string): Promise<Staff> {
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
  return { id: session.body?.adminUserId as string, sessionId: session.body?.session?.id as string, username, jar, password, secret };
}

const LEGACY_EVIDENCE: LegacyOwnerEvidence = {
  sourceSystem: "legacy_mysql_restore",
  sourceEntity: "la_user",
  legacyId: "99001",
  sourceDigest: createHash("sha256").update("user-directory-test-legacy-99001").digest("hex"),
  evidenceRef: "user-directory-test/legacy-evidence.jsonl",
  nickname: "旧号主甲",
  mobile: "13812345678",
  sourceCreatedAt: "2019-05-01T08:00:00.000Z",
  sourceUpdatedAt: "2020-06-01T08:00:00.000Z",
  status: { realNameBound: true, ageAdult: true, disabled: false, deleted: false },
  legacyPassword: null,
};

test("ADM-USER-DIRECTORY-READ-1 admin user directory read API", async (t) => {
  let resources: Resources | undefined;
  let maintenancePool: Pool | undefined;
  let maintenanceDataPool: Pool | undefined;
  let migrationPool: Pool | undefined;
  let runtimePool: Pool | undefined;
  let guard: PoolClient | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let runtimeClosedByApp = false;
  let fixturesStarted = false;
  try {
    resources = makeResources();
    maintenancePool = poolFor(resources.maintenance, "postgres", "zzsh-user-directory-maintenance", 2);
    guard = await resourceGuard(maintenancePool, resources);
    await ensureDatabase(maintenancePool, resources);
    await ensureRole(maintenancePool, resources.migrationUser, resources.migrationPassword, roleMarker(resources.databaseName, "migration"));
    await ensureRole(maintenancePool, resources.runtimeUser, resources.runtimePassword, roleMarker(resources.databaseName, "runtime"));
    await grantDatabaseAccess(maintenancePool, resources);
    maintenanceDataPool = poolFor(resources.maintenance, resources.databaseName, "zzsh-user-directory-owner", 2);
    await prepareOwnership(maintenanceDataPool, resources);
    migrationPool = createBusinessPool(resources.migration);
    await runBusinessMigrations(migrationPool, { runtimeUser: resources.runtimeUser });
    await runBusinessMigrations(migrationPool, { runtimeUser: resources.runtimeUser });
    runtimePool = createBusinessPool(resources.runtime);
    await assertBusinessRuntimeIdentity(runtimePool, resources.runtime);
    if ((await maintenanceDataPool.query(`SELECT count(*)::int AS n FROM zzsh_auth_user."user"`)).rows[0].n > 0) {
      await maintenanceDataPool.query(ISOLATED_BUSINESS_DATA_TRUNCATE);
    }
    // Fixture: the two new directory permission codes are registered here directly only
    // because this package must not add a product migration; production registration is a
    // follow-up migration assigned by Master. The code-level constant already grants them
    // to Boss; the rows let the suite exercise non-Boss allow/deny evaluation.
    for (const [code, name] of [
      ["user.directory.read", "读取用户目录"],
      ["user.phone.lookup", "按手机号查询用户"],
      ["supply.rental_account.read", "读取关联资源账号"],
    ] as const) {
      await maintenanceDataPool.query(`INSERT INTO zzsh_iam.admin_permission (code, name, description) VALUES ($1, $2, $3) ON CONFLICT (code) DO NOTHING`, [code, name, "user directory test fixture"]);
    }
    fixturesStarted = true;

    const fakeSmsOutbox = new Map<string, { code: string; sentAt: string; purpose: "phone-verification" | "password-reset" | "phone-registration" }>();
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
      fakeSmsOutbox,
      realNameProvider: createFakeRealNameProvider("VERIFIED_ADULT"),
      orderHoldSeconds: 3600,
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

    const bossPassword = randomBytes(24).toString("base64url");
    const bootstrap = await request(base, "/api/v1/admin/security/bootstrap", { bootstrapSecret, name: "目录 Boss", password: bossPassword }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(bootstrap.response.status, 200);
    const boss = await activateStaff(base, bootstrap.body?.username as string, bossPassword);
    const createStaff = async (name: string, allowPermissions: string[]): Promise<Staff> => {
      const created = await request(base, "/api/v1/admin/security/admins/create", { name, allowPermissions }, boss.jar, ADMIN_ORIGIN);
      assert.equal(created.response.status, 200, JSON.stringify(created.body));
      return activateStaff(base, created.body?.username as string, created.body?.temporaryPassword as string);
    };
    const viewer = await createStaff("目录只读员", ["user.directory.read"]);
    const phoneViewer = await createStaff("手机号查询员", ["user.directory.read", "user.phone.lookup"]);
    const scopedViewer = await createStaff("范围目录员", ["user.directory.read", "supply.rental_account.read"]);
    const resourceViewer = await createStaff("供给只读员", ["user.directory.read", "supply.rental_account.read"]);
    const noPermStaff = await createStaff("无权限管理员", []);

    // Users: one local email user with an account, one phone user, one migrated legacy user,
    // one deactivated user.
    const localJar = cookieJar();
    const localSignup = await request(base, "/api/auth/user/sign-up/email", { email: "dir_local01@example.invalid", password: "Sup3rSecret#Dir", name: "本地新用户", username: "dir_local01" }, localJar, USER_ORIGIN);
    assert.equal(localSignup.response.status, 200, JSON.stringify(localSignup.body));
    const localUserId = localSignup.body?.user?.id as string;
    assert.ok(localUserId);
    assert.equal((await request(base, "/api/auth/user/identity/verify", { fullName: "本地新用户", documentNumber: "110101199001010000" }, localJar, USER_ORIGIN)).response.status, 200);

    const phoneJar = cookieJar();
    const phoneNumber = "+8613900001111";
    assert.equal((await request(base, "/api/auth/user/phone-registration/send-otp", { phoneNumber }, cookieJar(), USER_ORIGIN)).response.status, 200);
    const delivery = fakeSmsOutbox.get(`phone-registration:${phoneNumber}`);
    assert.ok(delivery, "phone registration OTP fixture delivered");
    const phoneSignup = await request(base, "/api/auth/user/phone-registration/complete", { phoneNumber, code: delivery.code, password: "Sup3rSecret#Dir", acceptedTerms: true }, phoneJar, USER_ORIGIN);
    assert.equal(phoneSignup.response.status, 200, JSON.stringify(phoneSignup.body));
    const phoneSession = await request(base, "/api/auth/user/get-session", undefined, phoneJar, USER_ORIGIN);
    const phoneUserId = phoneSession.body?.user?.id as string;
    assert.ok(phoneUserId);

    let legacyUserId = "";
    await withTransaction(runtimePool, async (client) => {
      const migrated = await migrateLegacyOwner(client, { evidence: LEGACY_EVIDENCE, evidenceDigest: legacyOwnerEvidenceDigest(LEGACY_EVIDENCE) }, { id: boss.id, sessionId: boss.sessionId, requestId: `req_user_directory_test_${randomUUID().replaceAll("-", "")}` });
      legacyUserId = migrated.userId;
    });
    assert.ok(legacyUserId);

    const deactivatedJar = cookieJar();
    const deactivatedSignup = await request(base, "/api/auth/user/sign-up/email", { email: "dir_gone01@example.invalid", password: "Sup3rSecret#Dir", name: "停用用户", username: "dir_gone01" }, deactivatedJar, USER_ORIGIN);
    assert.equal(deactivatedSignup.response.status, 200);
    const deactivatedUserId = deactivatedSignup.body?.user?.id as string;
    const deactivated = await request(base, "/api/auth/user/account/deactivate", { reason: "用户目录测试停用样本" }, deactivatedJar, USER_ORIGIN);
    assert.equal(deactivated.response.status, 200, JSON.stringify(deactivated.body));

    // A game plus one rental account owned by the local user.
    const createdGame = await request(base, "/api/bff/admin/supply/games", { code: "delta", name: "三角洲行动", description: "用户目录测试游戏" }, boss.jar, ADMIN_ORIGIN, "POST", orderKey());
    assert.equal(createdGame.response.status, 200, JSON.stringify(createdGame.body));
    const gameId = createdGame.body?.game?.id as string;
    await runtimePool.query(`INSERT INTO zzsh_supply.admin_supply_scope (admin_user_id, game_id, granted_by_admin_id) VALUES ($1, $2, $3)`, [scopedViewer.id, gameId, boss.id]);
    const createdAccount = await request(base, "/api/v1/supply/accounts", { gameId }, localJar, USER_ORIGIN, "POST", orderKey());
    assert.equal(createdAccount.response.status, 200, JSON.stringify(createdAccount.body));
    const accountId = createdAccount.body?.accountId as string;
    assert.ok(accountId);

    const listUsers = async (jar: CookieJar, params: Record<string, string> = {}, prefix = "/api/v1/admin/users") => {
      if (params.phone) return request(base, `${prefix}/lookup`, params, jar, ADMIN_ORIGIN);
      const query = new URLSearchParams(params).toString();
      return request(base, query ? `${prefix}?${query}` : prefix, undefined, jar, ADMIN_ORIGIN);
    };

    await t.test("unauthenticated and unauthorized reads are refused", async () => {
      const anonymous = await listUsers(cookieJar());
      assert.equal(anonymous.response.status, 401);
      const denied = await listUsers(noPermStaff.jar);
      assert.equal(denied.response.status, 403);
      assert.equal(denied.body?.error?.code, "FORBIDDEN");
    });

    await t.test("boss list projects source, status and masked identifiers per user kind", async () => {
      const result = await listUsers(boss.jar, { limit: "50" });
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      const items = result.body?.items as Record<string, any>[];
      assert.ok(Array.isArray(items));
      const byId = new Map(items.map((item) => [item.userId, item]));
      const legacy = byId.get(legacyUserId);
      assert.ok(legacy, "migrated user listed");
      assert.equal(legacy.source.kind, "MIGRATED");
      assert.equal(legacy.source.legacyId, "99001");
      assert.equal(legacy.registeredAtSource, "LOCAL");
      assert.equal(legacy.registeredAt, legacy.createdAt, "operations use canonical creation time");
      assert.equal(legacy.maskedPhone, "+86138****5678");
      assert.equal(legacy.username, null);
      assert.equal(legacy.accountStatus, "ACTIVE");
      assert.equal(legacy.identityStatus, "VERIFIED");
      const local = byId.get(localUserId);
      assert.ok(local, "local user listed");
      assert.equal(local.source.kind, "LOCAL");
      assert.equal(local.registeredAtSource, "LOCAL");
      assert.equal(local.username, "dir_local01");
      assert.equal(local.maskedPhone, null);
      assert.equal(local.resourceSummary.count, 1);
      const phoneUser = byId.get(phoneUserId);
      assert.ok(phoneUser, "phone user listed");
      assert.equal(phoneUser.maskedPhone, "+86139****1111");
      const gone = byId.get(deactivatedUserId);
      assert.ok(gone, "deactivated user listed");
      assert.equal(gone.accountStatus, "DEACTIVATED");
    });

    await t.test("filters select precisely and bind the cursor to identity and filters", async () => {
      const byUserId = await listUsers(boss.jar, { userId: localUserId });
      assert.deepEqual((byUserId.body?.items as any[]).map((item) => item.userId), [localUserId]);
      const byLegacy = await listUsers(boss.jar, { legacyId: "99001" });
      assert.deepEqual((byLegacy.body?.items as any[]).map((item) => item.userId), [legacyUserId]);
      const byIdentifier = await listUsers(boss.jar, { identifier: "dir_local" });
      assert.deepEqual((byIdentifier.body?.items as any[]).map((item) => item.userId), [localUserId]);
      const byStatus = await listUsers(boss.jar, { accountStatus: "DEACTIVATED" });
      assert.deepEqual((byStatus.body?.items as any[]).map((item) => item.userId), [deactivatedUserId]);
      const migratedOnly = await listUsers(boss.jar, { source: "MIGRATED" });
      assert.deepEqual((migratedOnly.body?.items as any[]).map((item) => item.userId), [legacyUserId]);
      const localOnly = await listUsers(boss.jar, { source: "LOCAL" });
      assert.ok((localOnly.body?.items as any[]).every((item) => item.userId !== legacyUserId));
      const afterLegacy = await listUsers(boss.jar, { registeredFrom: "2020-01-01T00:00:00Z" });
      assert.ok((afterLegacy.body?.items as any[]).some((item) => item.userId === legacyUserId), "canonical creation is inside the window");
      const includingLegacy = await listUsers(boss.jar, { registeredFrom: "2018-01-01T00:00:00Z", registeredTo: "2020-01-01T00:00:00Z" });
      assert.deepEqual(includingLegacy.body?.items, [], "old source dates never drive operations filtering");
      const invalidStatus = await listUsers(boss.jar, { accountStatus: "SOME" });
      assert.equal(invalidStatus.response.status, 400);
      const invalidTime = await listUsers(boss.jar, { registeredFrom: "2020-13-40" });
      assert.equal(invalidTime.response.status, 400);
      const page1 = await listUsers(boss.jar, { limit: "2" });
      assert.equal((page1.body?.items as any[]).length, 2);
      assert.ok(page1.body?.nextCursor);
      const page2 = await listUsers(boss.jar, { limit: "2", cursor: page1.body?.nextCursor as string });
      assert.equal(page2.response.status, 200);
      const page1Ids = (page1.body?.items as any[]).map((item) => item.userId);
      assert.ok((page2.body?.items as any[]).every((item) => !page1Ids.includes(item.userId)), "pages do not overlap");
      const mismatched = await listUsers(boss.jar, { limit: "2", source: "LOCAL", cursor: page1.body?.nextCursor as string });
      assert.equal(mismatched.response.status, 409, "cursor bound to filters rejects reuse across filters");
      const foreignCursor = await listUsers(viewer.jar, { limit: "2", cursor: page1.body?.nextCursor as string });
      assert.equal(foreignCursor.response.status, 409, "cursor bound to the admin identity rejects reuse by another admin");
    });

    await t.test("phone lookup requires its own permission and never leaks the value", async () => {
      const denied = await listUsers(viewer.jar, { phone: phoneNumber });
      assert.equal(denied.response.status, 403);
      assert.equal(denied.body?.error?.code, "FORBIDDEN");
      const allowed = await listUsers(phoneViewer.jar, { phone: phoneNumber });
      assert.equal(allowed.response.status, 200, JSON.stringify(allowed.body));
      assert.deepEqual((allowed.body?.items as any[]).map((item) => item.userId), [phoneUserId]);
      const invalid = await listUsers(phoneViewer.jar, { phone: "abc" });
      assert.equal(invalid.response.status, 400);
      const bossLookup = await listUsers(boss.jar, { phone: "13812345678" });
      assert.deepEqual((bossLookup.body?.items as any[]).map((item) => item.userId), [legacyUserId]);
    });

    await t.test("detail projects migration provenance, membership and masked contact", async () => {
      const detail = await request(base, `/api/v1/admin/users/${legacyUserId}`, undefined, viewer.jar, ADMIN_ORIGIN);
      assert.equal(detail.response.status, 200, JSON.stringify(detail.body));
      const user = detail.body?.user as Record<string, any>;
      assert.equal(user.source.kind, "MIGRATED");
      assert.equal(user.source.legacyId, "99001");
      assert.equal(user.source.sourceSystem, undefined);
      assert.equal(user.source.sourceDigest, undefined);
      assert.equal(user.source.evidenceRef, undefined);
      assert.equal(user.source.migratedAt, undefined);
      assert.equal(user.identity.provider, "legacy_mysql_restore");
      assert.equal(user.identity.status, "VERIFIED");
      assert.equal(user.identity.ageStatus, "ADULT");
      assert.equal(user.maskedEmail, null, "synthetic phone email is not a contact fact");
      assert.equal(user.membership, undefined);
      assert.deepEqual(user.resourceSummary, { state: "denied", permission: "supply.rental_account.read" });
      const missing = await request(base, `/api/v1/admin/users/user_${"0".repeat(40)}`, undefined, boss.jar, ADMIN_ORIGIN);
      assert.equal(missing.response.status, 404);
      const denied = await request(base, `/api/v1/admin/users/${localUserId}`, undefined, noPermStaff.jar, ADMIN_ORIGIN);
      assert.equal(denied.response.status, 403);
    });

    await t.test("rental accounts follow the game scope boundary", async () => {
      const bossList = await request(base, `/api/v1/admin/users/${localUserId}/rental-accounts`, undefined, boss.jar, ADMIN_ORIGIN);
      assert.equal(bossList.response.status, 200);
      assert.deepEqual((bossList.body?.items as any[]).map((item) => item.accountId), [accountId]);
      assert.equal((bossList.body?.items as any[])[0].game.name, "三角洲行动");
      const noScope = await request(base, `/api/v1/admin/users/${localUserId}/rental-accounts`, undefined, resourceViewer.jar, ADMIN_ORIGIN);
      assert.equal(noScope.response.status, 200);
      assert.deepEqual(noScope.body?.items, [], "non-Boss without the game scope sees no accounts");
      const scoped = await request(base, `/api/v1/admin/users/${localUserId}/rental-accounts`, undefined, scopedViewer.jar, ADMIN_ORIGIN);
      assert.deepEqual((scoped.body?.items as any[]).map((item) => item.accountId), [accountId]);
      const legacyAccounts = await request(base, `/api/v1/admin/users/${legacyUserId}/rental-accounts`, undefined, boss.jar, ADMIN_ORIGIN);
      assert.deepEqual(legacyAccounts.body?.items, []);
      const denied = await request(base, `/api/v1/admin/users/${localUserId}/rental-accounts`, undefined, noPermStaff.jar, ADMIN_ORIGIN);
      assert.equal(denied.response.status, 403);
    });

    await t.test("orders read requires order.read and stays empty without order facts", async () => {
      const denied = await request(base, `/api/v1/admin/users/${localUserId}/orders`, undefined, viewer.jar, ADMIN_ORIGIN);
      assert.equal(denied.response.status, 403);
      const empty = await request(base, `/api/v1/admin/users/${localUserId}/orders`, undefined, boss.jar, ADMIN_ORIGIN);
      assert.equal(empty.response.status, 200, JSON.stringify(empty.body));
      assert.deepEqual(empty.body?.items, []);
      const invalidRole = await request(base, `/api/v1/admin/users/${localUserId}/orders?role=buddy`, undefined, boss.jar, ADMIN_ORIGIN);
      assert.equal(invalidRole.response.status, 400);
    });

    await t.test("audit events expose migration facts with sanitized details and scope rules", async () => {
      const bossAudit = await request(base, `/api/v1/admin/users/${legacyUserId}/audit-events`, undefined, boss.jar, ADMIN_ORIGIN);
      assert.equal(bossAudit.response.status, 200, JSON.stringify(bossAudit.body));
      assert.equal(bossAudit.body?.scope, undefined);
      const migration = (bossAudit.body?.items as any[]).find((item) => item.action === "user.legacy_owner.migrated");
      assert.ok(migration, "migration event visible to Boss");
      assert.equal(migration.details.sourceDigest, LEGACY_EVIDENCE.sourceDigest);
      assert.equal(migration.details.phoneNumberVerified, undefined, "phone-keyed details are stripped by the audit sanitizer");
      const deactivatedAudit = await request(base, `/api/v1/admin/users/${deactivatedUserId}/audit-events`, undefined, boss.jar, ADMIN_ORIGIN);
      assert.ok((deactivatedAudit.body?.items as any[]).some((item) => item.action === "user.account.deactivated"));
      const auditor = await createStaff("审计读取员", ["user.directory.read", "admin.audit.read"]);
      const scopedAudit = await request(base, `/api/v1/admin/users/${legacyUserId}/audit-events`, undefined, auditor.jar, ADMIN_ORIGIN);
      assert.equal(scopedAudit.response.status, 200);
      assert.equal(scopedAudit.body?.scope, undefined);
      assert.deepEqual(scopedAudit.body?.items, [], "non-Boss auditor only sees own actions on the user");
      const denied = await request(base, `/api/v1/admin/users/${legacyUserId}/audit-events`, undefined, viewer.jar, ADMIN_ORIGIN);
      assert.equal(denied.response.status, 403);
    });

    await t.test("BFF mirrors the read routes and rejects writes", async () => {
      const viaBff = await listUsers(boss.jar, { legacyId: "99001" }, "/api/bff/admin/users");
      if (viaBff.response.status !== 200) console.log("BFF list probe", viaBff.response.status, JSON.stringify(viaBff.body));
      assert.equal(viaBff.response.status, 200, JSON.stringify(viaBff.body));
      assert.deepEqual((viaBff.body?.items as any[]).map((item) => item.userId), [legacyUserId]);
      const detail = await request(base, `/api/bff/admin/users/${legacyUserId}`, undefined, boss.jar, ADMIN_ORIGIN);
      if (detail.response.status !== 200) console.log("BFF detail probe", detail.response.status, JSON.stringify(detail.body));
      assert.equal(detail.response.status, 200);
      const accounts = await request(base, `/api/bff/admin/users/${localUserId}/rental-accounts`, undefined, boss.jar, ADMIN_ORIGIN);
      if (accounts.response.status !== 200) console.log("BFF accounts probe", accounts.response.status, JSON.stringify(accounts.body));
      assert.equal(accounts.response.status, 200);
      const write = await request(base, "/api/bff/admin/users", {}, boss.jar, ADMIN_ORIGIN, "POST", orderKey());
      assert.equal(write.response.status, 404);
      const wrongOrigin = await fetch(base + "/api/bff/admin/users", { headers: { origin: "http://evil.example", cookie: boss.jar.header() } });
      assert.equal(wrongOrigin.status, 403);
    });

    console.log("user directory acceptance complete", JSON.stringify({ users: [localUserId, phoneUserId, legacyUserId, deactivatedUserId], accountId }));
  } finally {
    if (guard) guard.release();
    if (app) await app.close().catch(() => undefined);
    if (runtimePool && !runtimeClosedByApp) await runtimePool.end().catch(() => undefined);
    if (migrationPool) await migrationPool.end().catch(() => undefined);
    if (maintenanceDataPool) await maintenanceDataPool.end().catch(() => undefined);
    if (maintenancePool) await maintenancePool.end().catch(() => undefined);
    if (resources && fixturesStarted) console.log("user directory fixtures retained in", resources.databaseName);
  }
});
