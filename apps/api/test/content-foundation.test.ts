import { admitTestDatabase, ISOLATED_BUSINESS_DATA_TRUNCATE } from "./database-test-support";
import sharp from "sharp";
import { strict as assert } from "node:assert";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { cp, lstat, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { test } from "node:test";
import { execFileSync } from "node:child_process";

import { Pool, type PoolClient } from "pg";

import { createApp } from "../src/app";
import { loadAuthRuntimeConfig } from "../src/auth/auth-runtime";
import { assertBusinessRuntimeIdentity, createBusinessPool } from "../src/database/business";
import { runBusinessMigrations } from "../src/database/business-migrations";
import { createLocalMediaStorage } from "../src/supply/media";
import { loadConfig, type AppConfig } from "../src/config/config";
import { DEFAULT_GUIDES, DEFAULT_RESOURCES, validateResource, type ContentResource } from "@zzsh/content";
import { fingerprintRequest } from "../src/supply/supply-util";

const RESOURCE_SET = process.env.CONTENT_TEST_RESOURCE_SET?.trim() || "";
if (RESOURCE_SET && !/^[a-z][a-z0-9_]{0,20}$/.test(RESOURCE_SET)) throw new Error("Invalid content test resource set");
const DEFAULT_DATABASE = RESOURCE_SET ? "zzsh_test_content_" + RESOURCE_SET : "zzsh_test_content";
const RESOURCE_MARKER = "zzsh:m3-content-test:v1";
const LOCK_KEY = RESOURCE_SET ? (BigInt("0x" + createHash("sha256").update("content-test:" + RESOURCE_SET).digest("hex").slice(0, 15)) + 3000000n).toString() : "805016";
function testOrigin(name: string, fallback: string): string {
  const value = process.env[name]?.trim() || fallback;
  const url = new URL(value);
  assert.ok(["http:", "https:"].includes(url.protocol) && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), `${name} must use a loopback origin`);
  assert.ok(!url.username && !url.password && url.pathname === "/" && !url.search && !url.hash, `${name} must be an origin without credentials, path or query`);
  return url.origin;
}

const USER_ORIGIN = testOrigin("CONTENT_TEST_USER_ORIGIN", "http://127.0.0.1:3100");
const ADMIN_ORIGIN = testOrigin("CONTENT_TEST_ADMIN_ORIGIN", "http://127.0.0.1:3101");
const API_ORIGIN = testOrigin("CONTENT_TEST_API_ORIGIN", "http://127.0.0.1:3102");
const BUSINESS_SCHEMAS = ["zzsh_business_meta", "zzsh_iam", "zzsh_auth_user", "zzsh_auth_admin", "zzsh_supply", "zzsh_content"] as const;

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
type FixtureExport = {
  schema: "zzsh-content-local-fixture.v1";
  resourceSet: "cms_formal";
  database: { name: string; migrationUser: string; runtimeUser: string; marker: string };
  origins: { user: string; admin: string; api: string };
  boss: Pick<Staff, "id" | "username" | "password" | "secret">;
  authRuntimeEnv: Record<"AUTH_API_ORIGIN" | "AUTH_USER_ORIGIN" | "AUTH_ADMIN_ORIGIN" | "AUTH_USER_SECRET" | "AUTH_ADMIN_SECRET" | "AUTH_ADMIN_BOOTSTRAP_SECRET", string>;
  mediaDirectory: string;
  createdAt: string;
};

let fixturePrivateRoot: string | undefined;
function fixturePrivateDirectory(): string {
  if (!fixturePrivateRoot) {
    const common = execFileSync("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8" }).trim();
    fixturePrivateRoot = join(dirname(common), "apps", "api", ".secrets", "content-management-fullstack");
  }
  return fixturePrivateRoot;
}

async function requireAbsent(file: string, message: string): Promise<void> {
  try { await lstat(file); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
  throw new Error(message);
}

async function fixtureExportPaths(): Promise<{ output: string; media: string } | null> {
  const targetDatabase = process.env.CONTENT_TEST_DB_NAME?.trim() || DEFAULT_DATABASE;
  if (targetDatabase === "zzsh_test_content_cms_formal") {
    await requireAbsent(join(fixturePrivateDirectory(), "fixture-ui-retained.json"), "cms_formal is UI_RETAINED; regression reset is blocked");
    await requireAbsent(join(fixturePrivateDirectory(), "formal-ui-fixture.json"), "cms_formal already has a retained fixture; regression reset is blocked");
    await requireAbsent(join(fixturePrivateDirectory(), "formal-ui-media"), "cms_formal already has retained media; regression reset is blocked");
  }
  const requested = process.env.CONTENT_TEST_FIXTURE_OUTPUT;
  if (!requested) return null;
  assert.equal(RESOURCE_SET, "cms_formal", "fixture export is limited to the cms_formal resource");
  assert.ok(isAbsolute(requested) && basename(requested) === "formal-ui-fixture.json", "fixture export requires the approved absolute private file");
  const approved = await realpath(fixturePrivateDirectory());
  const parent = await realpath(dirname(requested));
  assert.equal(relative(approved, parent), "", "fixture output must remain in the approved private directory");
  const output = join(approved, "formal-ui-fixture.json");
  const media = join(approved, "formal-ui-media");
  await requireAbsent(output, "private fixture already exists; refusing to reset or overwrite it");
  await requireAbsent(media, "private fixture media already exists; refusing to reset or overwrite it");
  return { output, media };
}

async function copyOwnedFixtureMedia(source: string, expectedSource: string, destination: string): Promise<void> {
  const sourceRoot = await realpath(source);
  assert.equal(relative(expectedSource, sourceRoot), "", "fixture media source cannot be a reparse redirect");
  assert.equal(relative(await realpath(fixturePrivateDirectory()), await realpath(dirname(destination))), "", "fixture media destination must remain in the approved private directory");
  assert.equal(basename(destination), "formal-ui-media");
  await requireAbsent(destination, "private fixture media already exists; refusing to overwrite it");
  await cp(sourceRoot, destination, {
    recursive: true, force: false, errorOnExist: true,
    filter: async file => {
      assert.equal((await lstat(file)).isSymbolicLink(), false, "fixture media cannot contain symbolic links or junctions");
      const location = relative(sourceRoot, await realpath(file));
      assert.ok(!isAbsolute(location) && location !== ".." && !location.startsWith(`..${sep}`), "fixture media cannot escape its owned source directory");
      return true;
    },
  });
}

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
  const databaseName = process.env.CONTENT_TEST_DB_NAME?.trim() || DEFAULT_DATABASE;
  assert.notEqual(databaseName, "zzsh_dev");
  const migrationUser = safeIdentifier(process.env.CONTENT_TEST_MIGRATION_USER?.trim() || (RESOURCE_SET ? "zzsh_content_" + RESOURCE_SET + "_m" : "zzsh_content_migration"), "migration user");
  const runtimeUser = safeIdentifier(process.env.CONTENT_TEST_RUNTIME_USER?.trim() || (RESOURCE_SET ? "zzsh_content_" + RESOURCE_SET + "_r" : "zzsh_content_runtime"), "runtime user");
  assert.notEqual(migrationUser, runtimeUser);
  if (!migrationUser.startsWith("zzsh_content_") || !runtimeUser.startsWith("zzsh_content_")) throw new Error("content test roles must use the isolated zzsh_content_ prefix");
  const maintenanceUser = process.env.CONTENT_TEST_MAINTENANCE_USER ?? process.env.DB_USER;
  const baseEnv = {
    ...process.env,
    APP_PROFILE: "test",
    PROVIDER_MODE: "fake",
    DB_TARGET: "local-compose",
    DB_NAME: databaseName,
    ...(maintenanceUser ? { DB_USER: maintenanceUser } : {}),
  };
  const maintenance = loadConfig(baseEnv);
  const migrationPassword = process.env.CONTENT_TEST_MIGRATION_PASSWORD?.trim() || randomBytes(32).toString("hex");
  const runtimePassword = process.env.CONTENT_TEST_RUNTIME_PASSWORD?.trim() || randomBytes(32).toString("hex");
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
    assert.equal((await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [LOCK_KEY])).rows[0]?.acquired, true, "dedicated content test target is already in use");
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
  const admission = admitTestDatabase({
    exists: existing.rows.length > 0,
    owner: existing.rows[0]?.owner,
    marker: existing.rows[0]?.comment,
    allowConnections: existing.rows[0]?.allowConnections,
    isTemplate: existing.rows[0]?.isTemplate,
    expectedOwner: resources.maintenance.database.user,
    expectedMarker: RESOURCE_MARKER,
    databaseName: resources.databaseName,
    allowFlag: "CONTENT_TEST_ALLOW_NEW_RESOURCE",
  });
  if (admission === "CREATE") {
    await pool.query("CREATE DATABASE " + quotedIdentifier(resources.databaseName, "test database") + " OWNER " + quotedIdentifier(resources.maintenance.database.user, "maintenance user"));
    await pool.query("COMMENT ON DATABASE " + quotedIdentifier(resources.databaseName, "test database") + " IS " + quotedLiteral(RESOURCE_MARKER));
  }
  if (existing.rows.length > 0) {
    assert.equal(existing.rows[0]?.allowConnections, true);
    assert.equal(existing.rows[0]?.isTemplate, false);
  }
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
  // The content fixture never writes immutable finance/growth tables; DELETE leaves them protected.
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query('TRUNCATE "zzsh_content"."document_acceptance", "zzsh_content"."legal_document_version"');
    let pending = ISOLATED_BUSINESS_DATA_TRUNCATE.replace(/^TRUNCATE\s+/, "").split(",").map(table => table.trim()).filter(table => !table.includes('"document_acceptance"') && !table.includes('"legal_document_version"'));
    while (pending.length) {
      const blocked: string[] = [];
      for (const table of pending) {
        await client.query("SAVEPOINT content_fixture_clear");
        try { await client.query(`DELETE FROM ${table}`); }
        catch (error) {
          await client.query("ROLLBACK TO SAVEPOINT content_fixture_clear");
          if ((error as { code?: string }).code !== "23503") throw error;
          blocked.push(table);
        }
        await client.query("RELEASE SAVEPOINT content_fixture_clear");
      }
      if (blocked.length === pending.length) throw new Error("Content fixture has retained references outside its explicit cleanup list");
      pending = blocked;
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
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

function key(): Record<string, string> {
  return { "idempotency-key": `idem_${randomUUID().replaceAll("-", "")}` };
}

async function uploadBytes(base: string, path: string, jar: CookieJar, token: string, bytes: Buffer): Promise<{ status: number; body: Record<string, any> | null }> {
  const response = await fetch(base + path, {
    method: "PUT",
    headers: { origin: ADMIN_ORIGIN, "content-type": "image/png", "x-upload-token": token, "idempotency-key": `idem_${randomUUID().replaceAll("-", "")}`, cookie: jar.header() },
    body: new Uint8Array(bytes),
  });
  jar.update(response);
  return { status: response.status, body: await readJson(response) };
}

test("M3 content foundation: announcements, news, carousel and platform media under real PostgreSQL", async (testContext) => {
  const exportPaths = await fixtureExportPaths();
  let exportedFixture: FixtureExport | undefined;
  let resources: Resources | undefined;
  let maintenancePool: Pool | undefined;
  let maintenanceDataPool: Pool | undefined;
  let migrationPool: Pool | undefined;
  let runtimePool: Pool | undefined;
  let guard: PoolClient | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let runtimeClosedByApp = false;
  const mediaDir = await mkdtemp(join(tmpdir(), "zzsh-m3-content-media-"));
  const mediaDirReal = await realpath(mediaDir);
  const mediaStorage = createLocalMediaStorage(mediaDir);
  let pngFixture = Buffer.alloc(0);
  try {
    resources = makeResources();
    if (exportPaths) assert.equal(resources.databaseName, "zzsh_test_content_cms_formal", "fixture export cannot target another database");
    pngFixture = await sharp({ create: { width: 64, height: 64, channels: 3, background: "red" } }).withExif({ IFD0: { Artist: "private original" } }).png().toBuffer();
    maintenancePool = poolFor(resources.maintenance, "postgres", "zzsh-m3-content-maintenance", 2);
    guard = await resourceGuard(maintenancePool);
    await ensureDatabase(maintenancePool, resources);
    await ensureRole(maintenancePool, resources.migrationUser, resources.migrationPassword, roleMarker(resources.databaseName, "migration"));
    await ensureRole(maintenancePool, resources.runtimeUser, resources.runtimePassword, roleMarker(resources.databaseName, "runtime"));
    await grantDatabaseAccess(maintenancePool, resources);
    maintenanceDataPool = poolFor(resources.maintenance, resources.databaseName, "zzsh-m3-content-owner", 2);
    await prepareOwnership(maintenanceDataPool, resources);
    migrationPool = createBusinessPool(resources.migration);
    await runBusinessMigrations(migrationPool, { runtimeUser: resources.runtimeUser });
    await runBusinessMigrations(migrationPool, { runtimeUser: resources.runtimeUser });
    runtimePool = createBusinessPool(resources.runtime);
    await assertBusinessRuntimeIdentity(runtimePool, resources.runtime);
    await resetIsolatedData(maintenanceDataPool);

    const tables = await runtimePool.query<{ exists: boolean }>(
      "SELECT to_regclass('zzsh_content.content_item') IS NOT NULL AND to_regclass('zzsh_content.content_version') IS NOT NULL AND to_regclass('zzsh_content.carousel_item') IS NOT NULL AS exists",
    );
    assert.equal(tables.rows[0]?.exists, true);
    const nullableGame = await runtimePool.query<{ tableName: string; isNullable: string }>(
      `SELECT table_name AS "tableName", is_nullable AS "isNullable" FROM information_schema.columns
        WHERE table_schema = 'zzsh_supply' AND column_name = 'game_id' AND table_name IN ('media_asset', 'media_upload_intent') ORDER BY table_name`,
    );
    assert.deepEqual(nullableGame.rows.map((row) => row.isNullable), ["YES", "YES"]);

    const authRuntimeEnv = {
      AUTH_API_ORIGIN: API_ORIGIN,
      AUTH_USER_ORIGIN: USER_ORIGIN,
      AUTH_ADMIN_ORIGIN: ADMIN_ORIGIN,
      AUTH_USER_SECRET: randomBytes(32).toString("hex"),
      AUTH_ADMIN_SECRET: randomBytes(32).toString("hex"),
      AUTH_ADMIN_BOOTSTRAP_SECRET: randomBytes(32).toString("hex"),
    };
    const authOptions = {
      ...loadAuthRuntimeConfig(authRuntimeEnv, undefined, {}),
      pool: runtimePool,
      mediaStorage,
    };
    const bootstrapSecret = authRuntimeEnv.AUTH_ADMIN_BOOTSTRAP_SECRET;
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
    const bootstrap = await request(base, "/api/v1/admin/security/bootstrap", { bootstrapSecret, name: "内容 Boss", password: bossPassword }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(bootstrap.response.status, 200, JSON.stringify(bootstrap.body));
    const boss = await activate(base, bootstrap.body?.username as string, bossPassword);

    const createStaff = async (name: string, allowPermissions: string[]): Promise<Staff> => {
      const created = await request(base, "/api/v1/admin/security/admins/create", { mode: "ALL_GAMES", name, allowPermissions }, boss.jar, ADMIN_ORIGIN);
      assert.equal(created.response.status, 200, JSON.stringify(created.body));
      return activate(base, created.body?.username as string, created.body?.temporaryPassword as string);
    };
    const platform = await createStaff("平台内容编辑", ["content.platform.read", "content.platform.edit", "content.platform.publish"]);
    const gameEditor = await createStaff("游戏内容编辑", ["content.read", "content.edit", "content.publish"]);
    const unscopedEditor = await createStaff("无范围内容编辑", ["content.read", "content.edit", "content.publish"]);
    const reader = await createStaff("内容读取", ["content.platform.read"]);
    const carouselEditor = await createStaff("轮播编辑", ["content.platform.read", "content.platform.edit"]);
    const supplyOperator = await createStaff("供给审核员", ["supply.review.read", "supply.review.decide", "supply.catalog.manage"]);

    const gameA = "game_content_a";
    const gameB = "game_content_b";
    await runtimePool.query(
      `INSERT INTO "zzsh_supply"."game" ("id", "code", "name") VALUES ($1, 'content_a', '内容测试游戏A'), ($2, 'content_b', '内容测试游戏B')`,
      [gameA, gameB],
    );
    await runtimePool.query(
      `INSERT INTO "zzsh_supply"."admin_supply_scope" ("admin_user_id", "game_id", "granted_by_admin_id") VALUES ($1, $2, $3), ($4, $5, $3)`,
      [gameEditor.id, gameA, boss.id, supplyOperator.id, gameA],
    );
    await runtimePool.query(
      `UPDATE "zzsh_iam"."admin_security" SET "game_scope_mode" = 'SELECTED_GAMES' WHERE "admin_user_id" = ANY($1::text[])`,
      [[gameEditor.id, supplyOperator.id, unscopedEditor.id]],
    );

    // ---------- 权限与范围 ----------
    const announcementWithGame = await request(base, "/api/bff/admin/content/items", { type: "ANNOUNCEMENT", gameId: gameA, title: "非法归属" }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(announcementWithGame.response.status, 400, "platform announcements cannot belong to a game");
    const gameEditorAnnouncement = await request(base, "/api/bff/admin/content/items", { type: "ANNOUNCEMENT", title: "越权公告" }, gameEditor.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(gameEditorAnnouncement.response.status, 403, "game content permission must not manage platform announcements");
    const unscopedNews = await request(base, "/api/bff/admin/content/items", { type: "NEWS", gameId: gameA, title: "无范围资讯" }, unscopedEditor.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(unscopedNews.response.status, 403, "content permission without game scope must not create game news");
    assert.equal(unscopedNews.body?.error?.code, "NO_GAME_SCOPE");
    const crossGameNews = await request(base, "/api/bff/admin/content/items", { type: "NEWS", gameId: gameB, title: "跨游戏资讯" }, gameEditor.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(crossGameNews.response.status, 404, "scope for one game must not manage another game");
    const platformGameNews = await request(base, "/api/bff/admin/content/items", { type: "NEWS", gameId: gameA, title: "平台无游戏范围" }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(platformGameNews.response.status, 403, "platform content permission must not manage game-scoped news");
    const gameEditorCarousel = await request(base, "/api/bff/admin/content/carousel", { slotCode: "HOME_HERO", mediaId: "asset_missing", title: "越权轮播", imageAlt: "x" }, gameEditor.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(gameEditorCarousel.response.status, 403, "game content permission must not manage platform carousel");
    const gameEditorCarouselList = await request(base, "/api/bff/admin/content/carousel", undefined, gameEditor.jar, ADMIN_ORIGIN);
    assert.equal(gameEditorCarouselList.response.status, 403);
    const unscopedList = await request(base, `/api/bff/admin/content/items?scope=game&gameId=${gameA}`, undefined, unscopedEditor.jar, ADMIN_ORIGIN);
    assert.equal(unscopedList.response.status, 403, "content list must check game scope");
    assert.equal(unscopedList.body?.error?.code, "NO_GAME_SCOPE");
    const platformOnlyGameList = await request(base, "/api/bff/admin/content/games", undefined, platform.jar, ADMIN_ORIGIN);
    assert.equal(platformOnlyGameList.response.status, 200, "game metadata is readable; game content operations still require their scope");

    // ---------- 平台公告生命周期 ----------
    const created = await request(base, "/api/bff/admin/content/items", { type: "ANNOUNCEMENT", title: "首次公告", summary: "摘要", body: "第一版正文" }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(created.response.status, 200, JSON.stringify(created.body));
    const itemId = created.body?.item.id as string;
    const draftId = created.body?.version.id as string;
    assert.equal(created.body?.version.revision, "1");
    await assert.rejects(
      () => runtimePool!.query(`UPDATE "zzsh_content"."content_version" SET "state" = 'SUPERSEDED' WHERE "id" = $1`, [draftId]),
      (error: unknown) => (error as { code?: string }).code === "23514",
      "unpublished ANNOUNCEMENT cannot use the RESOURCE-only draft archive exception",
    );
    const draftNotPublicList = await request(base, "/api/v1/content/items?type=ANNOUNCEMENT", undefined, cookieJar(), API_ORIGIN);
    assert.equal(draftNotPublicList.response.status, 200);
    assert.deepEqual(draftNotPublicList.body?.items, [], "drafts must not be public");
    const draftNotPublicDetail = await request(base, `/api/v1/content/items/${itemId}`, undefined, cookieJar(), API_ORIGIN);
    assert.equal(draftNotPublicDetail.response.status, 404, "draft detail must not be public");
    const platformList = await request(base, "/api/bff/admin/content/items?scope=platform", undefined, platform.jar, ADMIN_ORIGIN);
    assert.equal(platformList.response.status, 200);
    assert.equal(platformList.body?.items.some((entry: { id: string; draft?: { id: string } }) => entry.id === itemId && entry.draft?.id === draftId), true);

    const controlChar = await request(base, `/api/bff/admin/content/items/${itemId}/draft`, { versionId: draftId, expectedRevision: "1", body: "bad\u0000body" }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(controlChar.response.status, 400, "control characters must be rejected");
    const badRevision = await request(base, `/api/bff/admin/content/items/${itemId}/draft`, { versionId: draftId, expectedRevision: "9", body: "不应保存" }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(badRevision.response.status, 409, "stale revisions must conflict");
    const saved = await request(base, `/api/bff/admin/content/items/${itemId}/draft`, { versionId: draftId, expectedRevision: "1", title: "首次公告（改）", summary: "摘要改", body: "第一版正文\r\n第二行" }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(saved.response.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body?.version.revision, "2");
    assert.equal(saved.body?.version.body, "第一版正文\n第二行", "CRLF must be normalized to LF");

    const publishWrongRevision = await request(base, `/api/bff/admin/content/items/${itemId}/publish`, { versionId: draftId, expectedRevision: "1" }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(publishWrongRevision.response.status, 409, "publish must verify the draft revision");
    const published = await request(base, `/api/bff/admin/content/items/${itemId}/publish`, { versionId: draftId, expectedRevision: "2" }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(published.response.status, 200, JSON.stringify(published.body));
    const publishedItemRevision = published.body?.item.revision as string;

    const publicList = await request(base, "/api/v1/content/items?type=ANNOUNCEMENT", undefined, cookieJar(), API_ORIGIN);
    assert.equal(publicList.response.status, 200);
    assert.equal(publicList.body?.items.length, 1);
    assert.equal(publicList.body?.items[0].id, itemId);
    assert.equal(publicList.body?.items[0].title, "首次公告（改）");
    assert.equal(publicList.body?.items[0].gameId, null);
    assert.equal("revision" in publicList.body.items[0], false, "public DTO must not expose revisions");
    assert.equal("createdByAdminId" in publicList.body.items[0], false, "public DTO must not expose operator identity");
    assert.equal("body" in publicList.body.items[0], false, "public list must not include the body");
    const publicDetail = await request(base, `/api/v1/content/items/${itemId}`, undefined, cookieJar(), API_ORIGIN);
    assert.equal(publicDetail.response.status, 200);
    assert.equal(publicDetail.body?.body, "第一版正文\n第二行");
    assert.equal("publishedByAdminId" in publicDetail.body, false);

    // 编辑已发布内容必须走新草稿，线上正文不变
    const editWithoutDraft = await request(base, `/api/bff/admin/content/items/${itemId}/draft`, { versionId: draftId, expectedRevision: "1", body: "偷改正文" }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(editWithoutDraft.response.status, 409, "published versions cannot be edited in place");
    const secondDraft = await request(base, `/api/bff/admin/content/items/${itemId}/draft`, {}, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(secondDraft.response.status, 200, JSON.stringify(secondDraft.body));
    const secondDraftId = secondDraft.body?.version.id as string;
    assert.equal(secondDraft.body?.version.sequence, 2);
    const stillOld = await request(base, `/api/v1/content/items/${itemId}`, undefined, cookieJar(), API_ORIGIN);
    assert.equal(stillOld.body?.body, "第一版正文\n第二行", "saving a new draft must not change the live body");
    const duplicateDraft = await request(base, `/api/bff/admin/content/items/${itemId}/draft`, {}, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(duplicateDraft.response.status, 409, "only one draft may exist per item");
    assert.equal((await request(base, `/api/bff/admin/content/items/${itemId}/draft`, { versionId: secondDraftId, expectedRevision: "1", body: "第二版正文" }, platform.jar, ADMIN_ORIGIN, "PUT", key())).response.status, 200);
    const republished = await request(base, `/api/bff/admin/content/items/${itemId}/publish`, { versionId: secondDraftId, expectedRevision: "2" }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(republished.response.status, 200, JSON.stringify(republished.body));
    const liveDetail = await request(base, `/api/v1/content/items/${itemId}`, undefined, cookieJar(), API_ORIGIN);
    assert.equal(liveDetail.body?.body, "第二版正文");
    const adminDetail = await request(base, `/api/bff/admin/content/items/${itemId}`, undefined, platform.jar, ADMIN_ORIGIN);
    const oldVersion = adminDetail.body?.versions.find((version: { id: string }) => version.id === draftId);
    assert.equal(oldVersion?.state, "SUPERSEDED");

    // 撤回后新请求不可读，可再次起草并发布
    const withdrawn = await request(base, `/api/bff/admin/content/items/${itemId}/withdraw`, { versionId: secondDraftId, expectedRevision: republished.body?.item.revision as string }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(withdrawn.response.status, 200, JSON.stringify(withdrawn.body));
    assert.equal((await request(base, `/api/v1/content/items/${itemId}`, undefined, cookieJar(), API_ORIGIN)).response.status, 404, "withdrawn content must not be public");
    const staleWithdraw = await request(base, `/api/bff/admin/content/items/${itemId}/withdraw`, { versionId: secondDraftId, expectedRevision: publishedItemRevision }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(staleWithdraw.response.status, 409, "withdraw must verify the item revision");
    const afterWithdrawList = await request(base, "/api/bff/admin/content/items?scope=platform&type=ANNOUNCEMENT", undefined, platform.jar, ADMIN_ORIGIN);
    const withdrawnRow = afterWithdrawList.body?.items.find((entry: { id: string }) => entry.id === itemId);
    assert.equal(withdrawnRow?.latest?.state, "WITHDRAWN", "withdrawn items must keep their latest version for the admin list");
    assert.equal(withdrawnRow?.latest?.title, "首次公告（改）");
    const redraft = await request(base, `/api/bff/admin/content/items/${itemId}/draft`, {}, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(redraft.response.status, 200, "withdrawn content must be re-draftable");
    assert.equal((await request(base, `/api/bff/admin/content/items/${itemId}/publish`, { versionId: redraft.body?.version.id, expectedRevision: "1" }, platform.jar, ADMIN_ORIGIN, "POST", key())).response.status, 200);

    // 幂等与并发
    const idempotentKey = key();
    const idempotentBody = { type: "ANNOUNCEMENT", title: "幂等公告", body: "内容" };
    const idemFirst = await request(base, "/api/bff/admin/content/items", idempotentBody, platform.jar, ADMIN_ORIGIN, "POST", idempotentKey);
    const idemSecond = await request(base, "/api/bff/admin/content/items", idempotentBody, platform.jar, ADMIN_ORIGIN, "POST", idempotentKey);
    assert.equal(idemFirst.response.status, 200);
    assert.deepEqual(idemSecond.body, idemFirst.body, "same key and body must replay the original result");
    const idemDifferent = await request(base, "/api/bff/admin/content/items", { ...idempotentBody, title: "异体公告" }, platform.jar, ADMIN_ORIGIN, "POST", idempotentKey);
    assert.equal(idemDifferent.response.status, 409, "same key with a different body must conflict");

    const raceItem = await request(base, "/api/bff/admin/content/items", { type: "ANNOUNCEMENT", title: "并发公告", body: "base" }, platform.jar, ADMIN_ORIGIN, "POST", key());
    const raceItemId = raceItem.body?.item.id as string;
    const raceDraftId = raceItem.body?.version.id as string;
    const race = await Promise.all([
      request(base, `/api/bff/admin/content/items/${raceItemId}/draft`, { versionId: raceDraftId, expectedRevision: "1", body: "A" }, platform.jar, ADMIN_ORIGIN, "PUT", key()),
      request(base, `/api/bff/admin/content/items/${raceItemId}/draft`, { versionId: raceDraftId, expectedRevision: "1", body: "B" }, platform.jar, ADMIN_ORIGIN, "PUT", key()),
    ]);
    assert.deepEqual(race.map((result) => result.response.status).sort(), [200, 409], "concurrent draft saves must have one winner");
    const racePublish = await Promise.all([
      request(base, `/api/bff/admin/content/items/${raceItemId}/publish`, { versionId: raceDraftId, expectedRevision: "2" }, platform.jar, ADMIN_ORIGIN, "POST", key()),
      request(base, `/api/bff/admin/content/items/${raceItemId}/publish`, { versionId: raceDraftId, expectedRevision: "2" }, platform.jar, ADMIN_ORIGIN, "POST", key()),
    ]);
    assert.deepEqual(racePublish.map((result) => result.response.status).sort(), [200, 409], "concurrent publishes must have one winner");

    // ---------- R2：草稿保存绑定版本身份 ----------
    const missingVersionId = await request(base, `/api/bff/admin/content/items/${raceItemId}/draft`, { expectedRevision: "3", body: "无身份" }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(missingVersionId.response.status, 400, "draft saves must carry the version identity");

    const staleItem = await request(base, "/api/bff/admin/content/items", { type: "ANNOUNCEMENT", title: "旧编辑器", body: "v1" }, platform.jar, ADMIN_ORIGIN, "POST", key());
    const staleItemId = staleItem.body?.item.id as string;
    const staleV1 = staleItem.body?.version.id as string;
    assert.equal((await request(base, `/api/bff/admin/content/items/${staleItemId}/draft`, { versionId: staleV1, expectedRevision: "1", body: "v1 已保存" }, platform.jar, ADMIN_ORIGIN, "PUT", key())).response.status, 200);
    assert.equal((await request(base, `/api/bff/admin/content/items/${staleItemId}/publish`, { versionId: staleV1, expectedRevision: "2" }, platform.jar, ADMIN_ORIGIN, "POST", key())).response.status, 200);
    const replacementDraft = await request(base, `/api/bff/admin/content/items/${staleItemId}/draft`, {}, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(replacementDraft.response.status, 200, JSON.stringify(replacementDraft.body));
    assert.equal(replacementDraft.body?.version.revision, "1", "the replacement draft restarts at revision 1");
    const replacementVersionId = replacementDraft.body?.version.id as string;
    // A stale editor holding v1/rev1 used to overwrite this replacement draft
    // because the server auto-picked the current DRAFT; the version identity
    // makes the save conflict instead.
    const staleKey = key();
    const staleSave = await request(base, `/api/bff/admin/content/items/${staleItemId}/draft`, { versionId: staleV1, expectedRevision: "1", body: "旧编辑器迟到覆盖" }, platform.jar, ADMIN_ORIGIN, "PUT", staleKey);
    assert.equal(staleSave.response.status, 409, "a stale version identity must conflict");
    const staleDetail = await request(base, `/api/bff/admin/content/items/${staleItemId}`, undefined, platform.jar, ADMIN_ORIGIN);
    assert.equal(staleDetail.body?.item.draft?.id, replacementVersionId, "the replacement draft must stay the current draft");
    assert.equal(staleDetail.body?.item.draft?.body, "v1 已保存", "the replacement draft must not be overwritten");
    assert.equal(staleDetail.body?.item.published?.body, "v1 已保存", "the live version must not change");
    assert.equal((await runtimePool.query(`SELECT count(*)::text AS count FROM "zzsh_iam"."audit_event" WHERE "action" = 'content.draft.saved' AND "object_id" = $1`, [replacementVersionId])).rows[0]?.count, "0", "a rejected stale save must not leave a success audit");
    assert.equal((await runtimePool.query(`SELECT count(*)::text AS count FROM "zzsh_supply"."idempotency_record" WHERE "key" = $1`, [staleKey["idempotency-key"]])).rows[0]?.count, "0", "a rejected stale save must not leave a success receipt");
    const replacementSaved = await request(base, `/api/bff/admin/content/items/${staleItemId}/draft`, { versionId: replacementVersionId, expectedRevision: "1", body: "v2 正常保存" }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(replacementSaved.response.status, 200, JSON.stringify(replacementSaved.body));
    assert.equal(replacementSaved.body?.version.id, replacementVersionId);
    assert.equal(replacementSaved.body?.version.revision, "2");
    const crossItem = await request(base, `/api/bff/admin/content/items/${staleItemId}/draft`, { versionId: raceDraftId, expectedRevision: "2", body: "跨条目" }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(crossItem.response.status, 404, "a version from another item must not be accepted");
    const versionKey = key();
    const versionKeyFirst = await request(base, `/api/bff/admin/content/items/${staleItemId}/draft`, { versionId: replacementVersionId, expectedRevision: "2", body: "v2 再保存" }, platform.jar, ADMIN_ORIGIN, "PUT", versionKey);
    assert.equal(versionKeyFirst.response.status, 200, JSON.stringify(versionKeyFirst.body));
    const reusedWithOtherVersion = await request(base, `/api/bff/admin/content/items/${staleItemId}/draft`, { versionId: staleV1, expectedRevision: "2", body: "v2 再保存" }, platform.jar, ADMIN_ORIGIN, "PUT", versionKey);
    assert.equal(reusedWithOtherVersion.response.status, 409, "reusing a key with another version identity must conflict");
    assert.equal(reusedWithOtherVersion.body?.error?.code, "IDEMPOTENCY_KEY_REUSED");
    const versionAuditFailKey = key();
    await migrationPool.query(`REVOKE INSERT ON TABLE "zzsh_iam"."audit_event" FROM ${quotedIdentifier(resources.runtimeUser, "runtime user")}`);
    const versionAuditFailed = await request(base, `/api/bff/admin/content/items/${staleItemId}/draft`, { versionId: replacementVersionId, expectedRevision: "3", body: "审计失败" }, platform.jar, ADMIN_ORIGIN, "PUT", versionAuditFailKey);
    assert.equal(versionAuditFailed.response.status, 500);
    await migrationPool.query(`GRANT INSERT ON TABLE "zzsh_iam"."audit_event" TO ${quotedIdentifier(resources.runtimeUser, "runtime user")}`);
    const versionAfterAuditFailure = await request(base, `/api/bff/admin/content/items/${staleItemId}`, undefined, platform.jar, ADMIN_ORIGIN);
    assert.equal(versionAfterAuditFailure.body?.item.draft?.revision, "3", "audit failure must roll back the draft save");
    assert.equal(versionAfterAuditFailure.body?.item.draft?.body, "v2 再保存");

    // 审计失败回滚
    const auditFailKey = key();
    await migrationPool.query(`REVOKE INSERT ON TABLE "zzsh_iam"."audit_event" FROM ${quotedIdentifier(resources.runtimeUser, "runtime user")}`);
    const auditFailed = await request(base, "/api/bff/admin/content/items", { type: "ANNOUNCEMENT", title: "审计回滚公告" }, platform.jar, ADMIN_ORIGIN, "POST", auditFailKey);
    assert.equal(auditFailed.response.status, 500);
    assert.equal((await runtimePool.query(`SELECT count(*)::text AS count FROM "zzsh_content"."content_item" WHERE "created_by_admin_id" = $1 AND "id" IN (SELECT "item_id" FROM "zzsh_content"."content_version" WHERE "title" = '审计回滚公告')`, [platform.id])).rows[0]?.count, "0", "audit failure must roll back the content write");
    assert.equal((await runtimePool.query(`SELECT count(*)::text AS count FROM "zzsh_supply"."idempotency_record" WHERE "key" = $1`, [auditFailKey["idempotency-key"]])).rows[0]?.count, "0");
    await migrationPool.query(`GRANT INSERT ON TABLE "zzsh_iam"."audit_event" TO ${quotedIdentifier(resources.runtimeUser, "runtime user")}`);

    // 仅允许追加：运行角色不能删除内容
    const deleteDenied = await runtimePool.query(`DELETE FROM "zzsh_content"."content_item" WHERE "id" = $1`, [itemId]).then(() => null, (error: unknown) => error);
    assert.ok(deleteDenied, "runtime role must not delete content rows");

    // ---------- 游戏资讯 ----------
    const gameNews = await request(base, "/api/bff/admin/content/items", { type: "NEWS", gameId: gameA, title: "游戏A资讯", body: "游戏A玩法说明" }, gameEditor.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(gameNews.response.status, 200, JSON.stringify(gameNews.body));
    await assert.rejects(
      () => runtimePool!.query(`UPDATE "zzsh_content"."content_version" SET "state" = 'SUPERSEDED' WHERE "id" = $1`, [gameNews.body?.version.id]),
      (error: unknown) => (error as { code?: string }).code === "23514",
      "unpublished NEWS still requires its original publication shape",
    );
    assert.equal((await request(base, `/api/bff/admin/content/items/${gameNews.body?.item.id}/publish`, { versionId: gameNews.body?.version.id, expectedRevision: "1" }, gameEditor.jar, ADMIN_ORIGIN, "POST", key())).response.status, 200);
    const gameListA = await request(base, `/api/v1/content/items?gameId=${gameA}`, undefined, cookieJar(), API_ORIGIN);
    assert.equal(gameListA.body?.items.some((entry: { title: string }) => entry.title === "游戏A资讯"), true);
    assert.equal(gameListA.body?.items.some((entry: { type: string }) => entry.type === "ANNOUNCEMENT"), false, "game filter must not include platform announcements");
    const gameListB = await request(base, `/api/v1/content/items?gameId=${gameB}`, undefined, cookieJar(), API_ORIGIN);
    assert.deepEqual(gameListB.body?.items, []);
    const allNews = await request(base, "/api/v1/content/items?type=NEWS", undefined, cookieJar(), API_ORIGIN);
    assert.equal(allNews.body?.items.length, 1);
    assert.equal(allNews.body?.items[0].gameName, "内容测试游戏A");

    // ---------- 平台素材 ----------
    const intent = await request(base, "/api/bff/admin/content/media/upload-intents", { purpose: "CONTENT_MEDIA", mime: "image/png", size: pngFixture.length }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(intent.response.status, 200, JSON.stringify(intent.body));
    const intentWithGame = await request(base, "/api/bff/admin/content/media/upload-intents", { purpose: "CONTENT_MEDIA", gameId: gameA, mime: "image/png", size: pngFixture.length }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(intentWithGame.response.status, 400, "content media cannot target a game");
    const gameIntent = await request(base, "/api/bff/admin/content/media/upload-intents", { purpose: "CONTENT_MEDIA", mime: "image/png", size: pngFixture.length }, gameEditor.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(gameIntent.response.status, 403, "game content permission must not upload platform media");
    const uploaded = await uploadBytes(base, `/api/bff/admin/content/media/uploads/${intent.body?.intentId}`, platform.jar, intent.body?.uploadToken as string, pngFixture);
    assert.equal(uploaded.status, 200, JSON.stringify(uploaded.body));
    const assetId = uploaded.body?.assetId as string;
    assert.equal(uploaded.body?.gameId, null);
    assert.equal(uploaded.body?.ownershipKind, "PLATFORM_CONTENT");
    const intentRow = await runtimePool.query<{ gameId: string | null; ownershipKind: string }>(`SELECT "game_id" AS "gameId", "ownership_kind" AS "ownershipKind" FROM "zzsh_supply"."media_upload_intent" WHERE "id" = $1`, [intent.body?.intentId]);
    assert.equal(intentRow.rows[0]?.gameId, null);
    assert.equal(intentRow.rows[0]?.ownershipKind, "PLATFORM_CONTENT");

    const pendingPublic = await request(base, `/api/v1/content/media/${assetId}/content`, undefined, cookieJar(), API_ORIGIN);
    assert.equal(pendingPublic.response.status, 404, "pending media must not be public");
    const privateRead = await fetch(`${base}/api/bff/admin/content/media/${assetId}/content`, { headers: { origin: ADMIN_ORIGIN, cookie: platform.jar.header() } });
    assert.equal(privateRead.status, 200);
    assert.deepEqual(Buffer.from(await privateRead.arrayBuffer()), pngFixture, "authorized readers may see the private original");
    assert.match(privateRead.headers.get("cache-control") ?? "", /no-store/);
    const strangerRead = await request(base, `/api/bff/admin/content/media/${assetId}/content`, undefined, gameEditor.jar, ADMIN_ORIGIN);
    assert.equal(strangerRead.response.status, 403, "game content permission must not read platform media");
    const supplyRead = await request(base, `/api/bff/admin/supply/media/${assetId}/content`, undefined, supplyOperator.jar, ADMIN_ORIGIN);
    assert.equal(supplyRead.response.status, 404, "supply review must not read platform content media");
    const supplyReview = await request(base, `/api/bff/admin/supply/media/${assetId}/review`, { decision: "APPROVE", visibility: "PUBLIC_DISPLAY" }, supplyOperator.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(supplyReview.response.status, 404, "supply review must not decide platform content media");
    const readerReview = await request(base, `/api/bff/admin/content/media/${assetId}/review`, { decision: "APPROVE", visibility: "PUBLIC_DISPLAY" }, reader.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(readerReview.response.status, 403, "read permission must not approve media");
    const approved = await request(base, `/api/bff/admin/content/media/${assetId}/review`, { decision: "APPROVE", visibility: "PUBLIC_DISPLAY" }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(approved.response.status, 200, JSON.stringify(approved.body));
    assert.equal(approved.body?.accessClass, "PUBLIC_DISPLAY");
    const publicMedia = await fetch(`${base}/api/v1/content/media/${assetId}/content`);
    assert.equal(publicMedia.status, 200);
    assert.match(publicMedia.headers.get("cache-control") ?? "", /public/);
    const publicBytes = Buffer.from(await publicMedia.arrayBuffer());
    assert.equal((await sharp(publicBytes).metadata()).exif, undefined, "public derivatives must strip metadata");
    assert.notDeepEqual(publicBytes, pngFixture);

    // 用途不符与未审核素材不能发布使用
    const supplyIntent = await request(base, "/api/bff/admin/supply/media/upload-intents", { gameId: gameA, purpose: "GAME_COVER", mime: "image/png", size: pngFixture.length }, boss.jar, ADMIN_ORIGIN, "POST", key());
    const supplyAsset = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${supplyIntent.body?.intentId}`, boss.jar, supplyIntent.body?.uploadToken as string, pngFixture);
    assert.equal(supplyAsset.status, 200);
    const wrongPurpose = await request(base, "/api/bff/admin/content/items", { type: "ANNOUNCEMENT", title: "用途不符封面", coverMediaId: supplyAsset.body?.assetId }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(wrongPurpose.response.status, 400, "catalog media must not be used as content cover");

    const pendingCoverItem = await request(base, "/api/bff/admin/content/items", { type: "ANNOUNCEMENT", title: "未审封面公告", body: "正文", coverMediaId: "asset_missing" }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(pendingCoverItem.response.status, 400, "cover must exist");

    // ---------- 轮播 ----------
    const badLinks = ["javascript:alert(1)", "//evil.example", "https://evil.example", "/../admin", "/orders/1", "/supply"];
    for (const linkUrl of badLinks) {
      const rejected = await request(base, "/api/bff/admin/content/carousel", { slotCode: "HOME_HERO", mediaId: assetId, title: "危险链接", imageAlt: "说明", linkUrl, enabled: false }, platform.jar, ADMIN_ORIGIN, "POST", key());
      assert.equal(rejected.response.status, 400, `linkUrl ${linkUrl} must be rejected`);
    }
    const carouselCreated = await request(base, "/api/bff/admin/content/carousel", { slotCode: "HOME_HERO", mediaId: assetId, title: "首页轮播一", imageAlt: "轮播图一", description: "说明", linkUrl: "/accounts?tab=new", sortOrder: 1 }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(carouselCreated.response.status, 200, JSON.stringify(carouselCreated.body));
    const carouselId = carouselCreated.body?.item.id as string;
    assert.equal(carouselCreated.body?.item.enabled, false, "new carousel entries start disabled");
    const hiddenDisabled = await request(base, "/api/v1/content/carousel?slot=HOME_HERO", undefined, cookieJar(), API_ORIGIN);
    assert.deepEqual(hiddenDisabled.body?.items, [], "disabled carousel entries must not be public");

    // ---------- R1：编辑权限只能维护未启用草稿 ----------
    const editorDraft = await request(base, "/api/bff/admin/content/carousel", { slotCode: "HOME_HERO", mediaId: assetId, title: "编辑草稿轮播", imageAlt: "说明" }, carouselEditor.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(editorDraft.response.status, 200, JSON.stringify(editorDraft.body));
    assert.equal(editorDraft.body?.item.enabled, false, "edit-only may create a disabled draft");
    const editedDraft = await request(base, `/api/bff/admin/content/carousel/${carouselId}`, { expectedRevision: "1", title: "首页轮播一（草稿改名）" }, carouselEditor.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(editedDraft.response.status, 200, JSON.stringify(editedDraft.body));
    const draftRevision = editedDraft.body?.item.revision as string;
    const createAuditCount = async (): Promise<string> =>
      (await runtimePool!.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_iam"."audit_event" WHERE "action" = 'content.carousel.created'`)).rows[0]!.count;
    const createdAuditsBefore = await createAuditCount();
    const enabledCreateKey = key();
    const enabledCreate = await request(base, "/api/bff/admin/content/carousel", { slotCode: "HOME_HERO", mediaId: assetId, title: "越权启用创建", imageAlt: "说明", enabled: true }, carouselEditor.jar, ADMIN_ORIGIN, "POST", enabledCreateKey);
    assert.equal(enabledCreate.response.status, 403, "edit-only must not create an enabled carousel entry");
    assert.equal((await runtimePool.query(`SELECT count(*)::text AS count FROM "zzsh_content"."carousel_item" WHERE "title" = '越权启用创建'`)).rows[0]?.count, "0");
    assert.equal(await createAuditCount(), createdAuditsBefore, "a rejected create must not leave a success audit");
    assert.equal((await runtimePool.query(`SELECT count(*)::text AS count FROM "zzsh_supply"."idempotency_record" WHERE "key" = $1`, [enabledCreateKey["idempotency-key"]])).rows[0]?.count, "0", "a rejected create must not leave a receipt");
    const enableDeniedKey = key();
    const enableDenied = await request(base, `/api/bff/admin/content/carousel/${carouselId}`, { expectedRevision: draftRevision, enabled: true }, carouselEditor.jar, ADMIN_ORIGIN, "PUT", enableDeniedKey);
    assert.equal(enableDenied.response.status, 403, "edit-only must not enable a carousel entry");
    assert.equal((await runtimePool.query(`SELECT "enabled" FROM "zzsh_content"."carousel_item" WHERE "id" = $1`, [carouselId])).rows[0]?.enabled, false);
    assert.equal((await runtimePool.query(`SELECT count(*)::text AS count FROM "zzsh_content"."carousel_item" WHERE "id" = $1 AND "revision" = $2`, [carouselId, draftRevision])).rows[0]?.count, "1", "a rejected enable must not bump the revision");
    assert.equal((await runtimePool.query(`SELECT count(*)::text AS count FROM "zzsh_supply"."idempotency_record" WHERE "key" = $1`, [enableDeniedKey["idempotency-key"]])).rows[0]?.count, "0");
    const enabled = await request(base, `/api/bff/admin/content/carousel/${carouselId}`, { expectedRevision: draftRevision, enabled: true }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(enabled.response.status, 200, JSON.stringify(enabled.body));
    const publicCarousel = await request(base, "/api/v1/content/carousel?slot=HOME_HERO", undefined, cookieJar(), API_ORIGIN);
    assert.equal(publicCarousel.body?.items.length, 1);
    assert.equal(publicCarousel.body?.items[0].id, carouselId);
    assert.equal(publicCarousel.body?.items[0].linkUrl, "/accounts?tab=new");
    assert.equal(publicCarousel.body?.items[0].mediaUrl, `/api/v1/content/media/${assetId}/content`);
    const raceUpdate = await Promise.all([
      request(base, `/api/bff/admin/content/carousel/${carouselId}`, { expectedRevision: "3", description: "A" }, platform.jar, ADMIN_ORIGIN, "PUT", key()),
      request(base, `/api/bff/admin/content/carousel/${carouselId}`, { expectedRevision: "3", description: "B" }, platform.jar, ADMIN_ORIGIN, "PUT", key()),
    ]);
    assert.deepEqual(raceUpdate.map((result) => result.response.status).sort(), [200, 409], "concurrent carousel updates must have one winner");

    // R1：已启用条目的公开字段与启停同样需要发布权限
    const afterRaceList = await request(base, "/api/bff/admin/content/carousel?slot=HOME_HERO", undefined, platform.jar, ADMIN_ORIGIN);
    const liveRevision = afterRaceList.body?.items.find((entry: { id: string }) => entry.id === carouselId)?.revision as string;
    const updateAuditCount = async (): Promise<string> =>
      (await runtimePool!.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_iam"."audit_event" WHERE "action" = 'content.carousel.updated' AND "object_id" = $1`, [carouselId])).rows[0]!.count;
    const updateAuditsBefore = await updateAuditCount();
    const liveFieldKey = key();
    const liveFieldDenied = await request(base, `/api/bff/admin/content/carousel/${carouselId}`, { expectedRevision: liveRevision, title: "越权改线上文案" }, carouselEditor.jar, ADMIN_ORIGIN, "PUT", liveFieldKey);
    assert.equal(liveFieldDenied.response.status, 403, "edit-only must not change a live carousel field");
    assert.equal((await request(base, `/api/bff/admin/content/carousel/${carouselId}`, { expectedRevision: liveRevision, startsAt: "2020-01-01T00:00:00Z" }, carouselEditor.jar, ADMIN_ORIGIN, "PUT", key())).response.status, 403, "edit-only must not adjust a live carousel window");
    assert.equal((await request(base, `/api/bff/admin/content/carousel/${carouselId}`, { expectedRevision: liveRevision, enabled: false }, carouselEditor.jar, ADMIN_ORIGIN, "PUT", key())).response.status, 403, "edit-only must not disable a live carousel entry");
    assert.equal(await updateAuditCount(), updateAuditsBefore, "rejected live edits must not leave success audits");
    assert.equal((await runtimePool.query(`SELECT count(*)::text AS count FROM "zzsh_supply"."idempotency_record" WHERE "key" = $1`, [liveFieldKey["idempotency-key"]])).rows[0]?.count, "0");
    const publicAfterDenied = await request(base, "/api/v1/content/carousel?slot=HOME_HERO", undefined, cookieJar(), API_ORIGIN);
    assert.equal(publicAfterDenied.body?.items.some((entry: { id: string; title: string }) => entry.id === carouselId && entry.title === "首页轮播一（草稿改名）"), true, "rejected edits must not change the public projection");
    const publisherLiveEdit = await request(base, `/api/bff/admin/content/carousel/${carouselId}`, { expectedRevision: liveRevision, description: "发布者更新说明" }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(publisherLiveEdit.response.status, 200, JSON.stringify(publisherLiveEdit.body));

    const secondCarousel = await request(base, "/api/bff/admin/content/carousel", { slotCode: "HOME_HERO", mediaId: assetId, title: "首页轮播二", imageAlt: "轮播图二", sortOrder: 5, enabled: true }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(secondCarousel.response.status, 200, JSON.stringify(secondCarousel.body));
    const ordered = await request(base, "/api/v1/content/carousel?slot=HOME_HERO", undefined, cookieJar(), API_ORIGIN);
    assert.deepEqual(ordered.body?.items.map((entry: { title: string }) => entry.title), ["首页轮播二", "首页轮播一（草稿改名）"], "carousel order must follow sort_order DESC");

    // R1：并发编辑不能绕过权限判断（锁定后按实际状态决策）
    const guardedDraft = await request(base, "/api/bff/admin/content/carousel", { slotCode: "HOME_HERO", mediaId: assetId, title: "并发守门草稿", imageAlt: "说明" }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(guardedDraft.response.status, 200, JSON.stringify(guardedDraft.body));
    const guardedId = guardedDraft.body?.item.id as string;
    const guardedGate = await runtimePool!.connect();
    const guardedKey = key();
    try {
      await guardedGate.query("BEGIN");
      // The publisher commits the enable while the edit-only request waits.
      await guardedGate.query(`UPDATE "zzsh_content"."carousel_item" SET "enabled" = true, "revision" = "revision" + 1, "updated_at" = clock_timestamp() WHERE "id" = $1`, [guardedId]);
      const gatePid = (await guardedGate.query<{ pid: number }>(`SELECT pg_backend_pid() AS pid`)).rows[0]!.pid;
      const pending = request(base, `/api/bff/admin/content/carousel/${guardedId}`, { expectedRevision: "2", title: "并发绕过尝试" }, carouselEditor.jar, ADMIN_ORIGIN, "PUT", guardedKey);
      let blocked = false; const deadline = Date.now() + 5000;
      while (!blocked && Date.now() < deadline) {
        await guardedGate.query("SELECT pg_stat_clear_snapshot()");
        blocked = (await guardedGate.query<{ blocked: boolean }>(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked`, [gatePid])).rows[0]!.blocked;
      }
      assert.equal(blocked, true, "the edit-only update must wait for the locked row");
      await guardedGate.query("COMMIT");
      assert.equal((await pending).response.status, 403, "the locked row state must decide the permission, not a stale read");
    } finally {
      await guardedGate.query("ROLLBACK").catch(() => undefined);
      guardedGate.release();
    }
    const guardedRow = await runtimePool.query<{ enabled: boolean; title: string }>(`SELECT "enabled", "title" FROM "zzsh_content"."carousel_item" WHERE "id" = $1`, [guardedId]);
    assert.equal(guardedRow.rows[0]?.enabled, true);
    assert.equal(guardedRow.rows[0]?.title, "并发守门草稿", "the blocked edit must not modify the row");
    assert.equal((await runtimePool.query(`SELECT count(*)::text AS count FROM "zzsh_supply"."idempotency_record" WHERE "key" = $1`, [guardedKey["idempotency-key"]])).rows[0]?.count, "0");

    // R1：审计失败回滚与撤权后重放复核
    const auditDraft = await request(base, "/api/bff/admin/content/carousel", { slotCode: "HOME_HERO", mediaId: assetId, title: "审计回滚轮播", imageAlt: "说明" }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(auditDraft.response.status, 200, JSON.stringify(auditDraft.body));
    const auditDraftId = auditDraft.body?.item.id as string;
    await migrationPool.query(`REVOKE INSERT ON TABLE "zzsh_iam"."audit_event" FROM ${quotedIdentifier(resources.runtimeUser, "runtime user")}`);
    const auditEnableFailed = await request(base, `/api/bff/admin/content/carousel/${auditDraftId}`, { expectedRevision: "1", enabled: true }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(auditEnableFailed.response.status, 500);
    await migrationPool.query(`GRANT INSERT ON TABLE "zzsh_iam"."audit_event" TO ${quotedIdentifier(resources.runtimeUser, "runtime user")}`);
    assert.equal((await runtimePool.query(`SELECT "enabled" FROM "zzsh_content"."carousel_item" WHERE "id" = $1`, [auditDraftId])).rows[0]?.enabled, false, "audit failure must roll back the enable");

    const replayDraft = await request(base, "/api/bff/admin/content/carousel", { slotCode: "HOME_HERO", mediaId: assetId, title: "重放权限复核", imageAlt: "说明" }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(replayDraft.response.status, 200, JSON.stringify(replayDraft.body));
    const replayDraftId = replayDraft.body?.item.id as string;
    const replayKey = key();
    assert.equal((await request(base, `/api/bff/admin/content/carousel/${replayDraftId}`, { expectedRevision: "1", enabled: true }, platform.jar, ADMIN_ORIGIN, "PUT", replayKey)).response.status, 200);
    const originalPublishEffect = (await runtimePool.query<{ effect: string }>(`SELECT "effect" FROM "zzsh_iam"."admin_user_permission" WHERE "admin_user_id" = $1 AND "permission_code" = 'content.platform.publish'`, [platform.id])).rows[0]?.effect ?? null;
    await runtimePool.query(`INSERT INTO "zzsh_iam"."admin_user_permission" ("admin_user_id", "permission_code", "effect") VALUES ($1, 'content.platform.publish', 'DENY') ON CONFLICT ("admin_user_id", "permission_code") DO UPDATE SET "effect" = 'DENY'`, [platform.id]);
    const replayDenied = await request(base, `/api/bff/admin/content/carousel/${replayDraftId}`, { expectedRevision: "1", enabled: true }, platform.jar, ADMIN_ORIGIN, "PUT", replayKey);
    assert.equal(replayDenied.response.status, 403, "replays must re-check the current authorization");
    if (originalPublishEffect) {
      await runtimePool.query(`UPDATE "zzsh_iam"."admin_user_permission" SET "effect" = $2 WHERE "admin_user_id" = $1 AND "permission_code" = 'content.platform.publish'`, [platform.id, originalPublishEffect]);
    } else {
      await runtimePool.query(`DELETE FROM "zzsh_iam"."admin_user_permission" WHERE "admin_user_id" = $1 AND "permission_code" = 'content.platform.publish'`, [platform.id]);
    }

    // R1：成功改变状态后的重放不得降级发布授权
    const permissionSnapshot = async (adminUserId: string, code: string): Promise<string | null> =>
      (await runtimePool!.query<{ effect: string }>(`SELECT "effect" FROM "zzsh_iam"."admin_user_permission" WHERE "admin_user_id" = $1 AND "permission_code" = $2`, [adminUserId, code])).rows[0]?.effect ?? null;
    const setPermission = async (adminUserId: string, code: string, effect: "ALLOW" | "DENY"): Promise<() => Promise<void>> => {
      const original = await permissionSnapshot(adminUserId, code);
      await runtimePool!.query(`INSERT INTO "zzsh_iam"."admin_user_permission" ("admin_user_id", "permission_code", "effect") VALUES ($1, $2, $3) ON CONFLICT ("admin_user_id", "permission_code") DO UPDATE SET "effect" = EXCLUDED."effect"`, [adminUserId, code, effect]);
      return async () => {
        if (original) {
          await runtimePool!.query(`UPDATE "zzsh_iam"."admin_user_permission" SET "effect" = $3 WHERE "admin_user_id" = $1 AND "permission_code" = $2`, [adminUserId, code, original]);
        } else {
          await runtimePool!.query(`DELETE FROM "zzsh_iam"."admin_user_permission" WHERE "admin_user_id" = $1 AND "permission_code" = $2`, [adminUserId, code]);
        }
      };
    };

    // 停用动作本身是发布语义：成功后行已 disabled，重放不能降级为普通编辑
    const disableReplayDraft = await request(base, "/api/bff/admin/content/carousel", { slotCode: "HOME_HERO", mediaId: assetId, title: "停用重放轮播", imageAlt: "说明", enabled: true }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(disableReplayDraft.response.status, 200, JSON.stringify(disableReplayDraft.body));
    const disableReplayId = disableReplayDraft.body?.item.id as string;
    const disableKey = key();
    const disableResult = await request(base, `/api/bff/admin/content/carousel/${disableReplayId}`, { expectedRevision: "1", enabled: false }, platform.jar, ADMIN_ORIGIN, "PUT", disableKey);
    assert.equal(disableResult.response.status, 200, JSON.stringify(disableResult.body));
    assert.equal(disableResult.body?.item.enabled, false);
    assert.equal((await runtimePool.query(`SELECT "publish_required" AS "publishRequired" FROM "zzsh_supply"."idempotency_record" WHERE "key" = $1`, [disableKey["idempotency-key"]])).rows[0]?.publishRequired, true, "a disable must be recorded as a publish operation");
    const disableAudits = (await runtimePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_iam"."audit_event" WHERE "action" = 'content.carousel.updated' AND "object_id" = $1`, [disableReplayId])).rows[0]!.count;
    const restoreDisablePublish = await setPermission(platform.id, "content.platform.publish", "DENY");
    const disableReplay = await request(base, `/api/bff/admin/content/carousel/${disableReplayId}`, { expectedRevision: "1", enabled: false }, platform.jar, ADMIN_ORIGIN, "PUT", disableKey);
    assert.equal(disableReplay.response.status, 403, "a disable replay must keep its publish requirement after the row is disabled");
    await restoreDisablePublish();
    assert.equal((await runtimePool.query(`SELECT "enabled" FROM "zzsh_content"."carousel_item" WHERE "id" = $1`, [disableReplayId])).rows[0]?.enabled, false);
    assert.equal((await runtimePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_iam"."audit_event" WHERE "action" = 'content.carousel.updated' AND "object_id" = $1`, [disableReplayId])).rows[0]!.count, disableAudits, "a denied replay must not add a success audit");

    // 线上字段修改的旧请求在条目停用后重放，同样保持发布要求
    const fieldReplayDraft = await request(base, "/api/bff/admin/content/carousel", { slotCode: "HOME_HERO", mediaId: assetId, title: "字段重放轮播", imageAlt: "说明", enabled: true }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(fieldReplayDraft.response.status, 200, JSON.stringify(fieldReplayDraft.body));
    const fieldReplayId = fieldReplayDraft.body?.item.id as string;
    const fieldKey = key();
    assert.equal((await request(base, `/api/bff/admin/content/carousel/${fieldReplayId}`, { expectedRevision: "1", title: "字段重放轮播（线上改名）" }, platform.jar, ADMIN_ORIGIN, "PUT", fieldKey)).response.status, 200);
    const fieldDisable = await request(base, `/api/bff/admin/content/carousel/${fieldReplayId}`, { expectedRevision: "2", enabled: false }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(fieldDisable.response.status, 200, JSON.stringify(fieldDisable.body));
    const restoreFieldPublish = await setPermission(platform.id, "content.platform.publish", "DENY");
    const fieldReplayDenied = await request(base, `/api/bff/admin/content/carousel/${fieldReplayId}`, { expectedRevision: "1", title: "字段重放轮播（线上改名）" }, platform.jar, ADMIN_ORIGIN, "PUT", fieldKey);
    assert.equal(fieldReplayDenied.response.status, 403, "a live-field edit replay must keep its publish requirement after the row is disabled");
    await restoreFieldPublish();

    // edit-only 的正常草稿重放保持可用，撤掉编辑权限后重放被拒
    const editorReplayKey = key();
    const editorReplayBody = { expectedRevision: "1", title: "编辑草稿轮播（重放）" };
    const editorSave = await request(base, `/api/bff/admin/content/carousel/${editorDraft.body?.item.id}`, editorReplayBody, carouselEditor.jar, ADMIN_ORIGIN, "PUT", editorReplayKey);
    assert.equal(editorSave.response.status, 200, JSON.stringify(editorSave.body));
    assert.equal((await runtimePool.query(`SELECT "publish_required" AS "publishRequired" FROM "zzsh_supply"."idempotency_record" WHERE "key" = $1`, [editorReplayKey["idempotency-key"]])).rows[0]?.publishRequired, false, "a draft edit must not be recorded as a publish operation");
    const editorReplay = await request(base, `/api/bff/admin/content/carousel/${editorDraft.body?.item.id}`, editorReplayBody, carouselEditor.jar, ADMIN_ORIGIN, "PUT", editorReplayKey);
    assert.equal(editorReplay.response.status, 200, "an edit-only draft replay must stay available");
    assert.deepEqual(editorReplay.body, editorSave.body);
    const restoreEditPermission = await setPermission(carouselEditor.id, "content.platform.edit", "DENY");
    const editorReplayDenied = await request(base, `/api/bff/admin/content/carousel/${editorDraft.body?.item.id}`, editorReplayBody, carouselEditor.jar, ADMIN_ORIGIN, "PUT", editorReplayKey);
    assert.equal(editorReplayDenied.response.status, 403, "replays must re-check the current edit authorization");
    await restoreEditPermission();

    const adminCarouselList = await request(base, "/api/bff/admin/content/carousel?slot=HOME_HERO", undefined, platform.jar, ADMIN_ORIGIN);
    const currentRevision = adminCarouselList.body?.items.find((entry: { id: string; revision: string }) => entry.id === carouselId)?.revision as string;
    const invalidWindow = await request(base, `/api/bff/admin/content/carousel/${carouselId}`, { expectedRevision: currentRevision, startsAt: "2026-02-30T00:00:00Z" }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(invalidWindow.response.status, 400, "impossible dates must be rejected");
    const future = await request(base, `/api/bff/admin/content/carousel/${carouselId}`, { expectedRevision: currentRevision, startsAt: "2030-01-01T00:00:00Z" }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(future.response.status, 200, JSON.stringify(future.body));
    assert.equal((await request(base, "/api/v1/content/carousel?slot=HOME_HERO", undefined, cookieJar(), API_ORIGIN)).body?.items.some((entry: { id: string }) => entry.id === carouselId), false, "future carousel entries must not be public");
    const reopened = await request(base, `/api/bff/admin/content/carousel/${carouselId}`, { expectedRevision: future.body?.item.revision, startsAt: "2020-01-01T00:00:00Z", endsAt: "2030-01-01T00:00:00Z" }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(reopened.response.status, 200, JSON.stringify(reopened.body));
    assert.equal((await request(base, "/api/v1/content/carousel?slot=HOME_HERO", undefined, cookieJar(), API_ORIGIN)).body?.items.some((entry: { id: string }) => entry.id === carouselId), true);
    const expired = await request(base, `/api/bff/admin/content/carousel/${carouselId}`, { expectedRevision: reopened.body?.item.revision, startsAt: "2020-01-01T00:00:00Z", endsAt: "2020-01-02T00:00:00Z" }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(expired.response.status, 200, JSON.stringify(expired.body));
    assert.equal((await request(base, "/api/v1/content/carousel?slot=HOME_HERO", undefined, cookieJar(), API_ORIGIN)).body?.items.some((entry: { id: string }) => entry.id === carouselId), false, "expired carousel entries must not be public");
    const invalidOrder = await request(base, `/api/bff/admin/content/carousel/${carouselId}`, { expectedRevision: expired.body?.item.revision, startsAt: "2030-01-01T00:00:00Z", endsAt: "2029-01-01T00:00:00Z" }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(invalidOrder.response.status, 400, "start must be before end");

    // 撤权素材不得继续投影：轮播隐藏、封面降级
    await request(base, `/api/bff/admin/content/carousel/${carouselId}`, { expectedRevision: expired.body?.item.revision, enabled: true, startsAt: null, endsAt: null }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    const withCover = await request(base, "/api/bff/admin/content/items", { type: "NEWS", title: "带封面平台资讯", body: "正文", coverMediaId: assetId }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(withCover.response.status, 200, JSON.stringify(withCover.body));
    assert.equal((await request(base, `/api/bff/admin/content/items/${withCover.body?.item.id}/publish`, { versionId: withCover.body?.version.id, expectedRevision: "1" }, platform.jar, ADMIN_ORIGIN, "POST", key())).response.status, 200);
    const coverVisible = await request(base, `/api/v1/content/items/${withCover.body?.item.id}`, undefined, cookieJar(), API_ORIGIN);
    assert.equal(coverVisible.body?.coverMediaId, assetId);
    const revoked = await request(base, `/api/bff/admin/content/media/${assetId}/visibility`, { visibility: "PRIVATE_REVIEW", reason: "撤销公开" }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(revoked.response.status, 200, JSON.stringify(revoked.body));
    assert.equal((await request(base, `/api/v1/content/media/${assetId}/content`, undefined, cookieJar(), API_ORIGIN)).response.status, 404, "revoked media must not be served");
    const coverDegraded = await request(base, `/api/v1/content/items/${withCover.body?.item.id}`, undefined, cookieJar(), API_ORIGIN);
    assert.equal(coverDegraded.response.status, 200, "content stays readable without its cover");
    assert.equal(coverDegraded.body?.coverMediaId, null, "revoked cover must be omitted");
    assert.equal(coverDegraded.body?.body, "正文");
    assert.equal((await request(base, "/api/v1/content/carousel?slot=HOME_HERO", undefined, cookieJar(), API_ORIGIN)).body?.items.length, 0, "carousel with revoked media must be hidden");
    const carouselAdminAfterRevoke = await request(base, "/api/bff/admin/content/carousel?slot=HOME_HERO", undefined, platform.jar, ADMIN_ORIGIN);
    assert.equal(carouselAdminAfterRevoke.body?.items.some((entry: { id: string; mediaReviewState: string; mediaAccessClass: string }) => entry.id === carouselId && entry.mediaReviewState === "APPROVED" && entry.mediaAccessClass === "PRIVATE_REVIEW"), true, "admin list must keep showing the entry with its revoked media state");

    // ---------- 公共分页与游标精度 ----------
    const publishSimple = async (title: string, sortOrder: number): Promise<string> => {
      const created = await request(base, "/api/bff/admin/content/items", { type: "ANNOUNCEMENT", title, body: "分页正文" }, platform.jar, ADMIN_ORIGIN, "POST", key());
      const id = created.body?.item.id as string;
      const published = await request(base, `/api/bff/admin/content/items/${id}/publish`, { versionId: created.body?.version.id, expectedRevision: "1" }, platform.jar, ADMIN_ORIGIN, "POST", key());
      assert.equal(published.response.status, 200, JSON.stringify(published.body));
      assert.equal((await request(base, `/api/bff/admin/content/items/${id}`, { expectedRevision: published.body?.item.revision, sortOrder }, platform.jar, ADMIN_ORIGIN, "PUT", key())).response.status, 200);
      return id;
    };
    const pageA = await publishSimple("分页A", 1);
    const pageB = await publishSimple("分页B", 2);
    // 同一微秒发布时间：游标必须保留数据库精度并使用 id 作为稳定次级键
    await runtimePool.query(
      `UPDATE "zzsh_content"."content_version" SET "published_at" = '2026-09-13T00:00:00.123456Z' WHERE "item_id" IN ($1, $2) AND "state" = 'PUBLISHED'`,
      [pageA, pageB],
    );
    const pagedIds: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 30; page += 1) {
      const suffix = cursor ? `&cursor=${encodeURIComponent(cursor)}` : "";
      const result = await request(base, `/api/v1/content/items?limit=1${suffix}`, undefined, cookieJar(), API_ORIGIN);
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      for (const entry of result.body?.items ?? []) pagedIds.push(entry.id as string);
      cursor = result.body?.nextCursor ?? null;
      if (!cursor) break;
    }
    assert.equal(cursor, null, "pagination must terminate");
    assert.equal(new Set(pagedIds).size, pagedIds.length, "pagination must not repeat items");
    const publicIds = (await request(base, "/api/v1/content/items?limit=100", undefined, cookieJar(), API_ORIGIN)).body?.items.map((entry: { id: string }) => entry.id) as string[];
    assert.deepEqual([...new Set(pagedIds)].sort(), [...new Set(publicIds)].sort(), "pagination must not drop items");
    const cursorForAnnouncements = Buffer.from(JSON.stringify({ v: 1, type: "ANNOUNCEMENT", gameId: null, limit: 1, sortOrder: 1, publishedAt: "2026-09-13T00:00:00.123456Z", id: pageA })).toString("base64url");
    const mismatchedCursor = await request(base, `/api/v1/content/items?type=NEWS&cursor=${encodeURIComponent(cursorForAnnouncements)}`, undefined, cookieJar(), API_ORIGIN);
    assert.equal(mismatchedCursor.response.status, 409, "cursor must be bound to its filters");
    const malformedCursor = await request(base, "/api/v1/content/items?cursor=not-base64", undefined, cookieJar(), API_ORIGIN);
    assert.equal(malformedCursor.response.status, 400, "malformed cursors must be controlled errors");

    // 素材列表与选择器
    const mediaList = await request(base, "/api/bff/admin/content/media", undefined, platform.jar, ADMIN_ORIGIN);
    assert.equal(mediaList.response.status, 200);
    assert.equal(mediaList.body?.items.some((entry: { id: string; reviewState: string }) => entry.id === assetId && entry.reviewState === "APPROVED"), true);
    const mediaOptions = await request(base, "/api/bff/admin/content/media-options", undefined, platform.jar, ADMIN_ORIGIN);
    assert.equal(mediaOptions.response.status, 200);
    assert.equal(mediaOptions.body?.items.some((entry: { id: string }) => entry.id === assetId), false, "revoked media must leave the options list");
    const mediaOptionsDenied = await request(base, "/api/bff/admin/content/media-options", undefined, gameEditor.jar, ADMIN_ORIGIN);
    assert.equal(mediaOptionsDenied.response.status, 403);

    // ---------- 受控资源：草稿、发布、回执、撤回与范围 ----------
    const resourceRoot = "/api/bff/admin/content/resources/";
    const resourceKey = `guide:${DEFAULT_GUIDES[0]!.slug}`;
    const resourceUrl = resourceRoot + encodeURIComponent(resourceKey);
    const publicResourceUrl = "/api/v1/content/resources/" + encodeURIComponent(resourceKey);
    const readResource = () => request(base, resourceUrl, undefined, platform.jar, ADMIN_ORIGIN);
    const resourceWrite = (suffix: string, body: Record<string, unknown>, verb = "POST", headers = key(), jar = platform.jar) => request(base, `${resourceUrl}/${suffix}`, body, jar, ADMIN_ORIGIN, verb, headers);
    const builtin = await request(base, publicResourceUrl, undefined, cookieJar(), API_ORIGIN);
    assert.equal(builtin.response.status, 200); assert.equal(builtin.body?.source, "BUILTIN");
    assert.deepEqual(builtin.body?.payload, validateResource(resourceKey, DEFAULT_GUIDES[0]), "the current built-in document survives the ownership switch");
    assert.equal((await resourceWrite("draft", {}, "POST", key(), reader.jar)).response.status, 403);
    assert.equal((await resourceWrite("draft", {}, "POST", { "idempotency-key": "bad key with spaces" })).response.status, 400);
    const originalBody = {}, originalKey = key();
    const adopted = await resourceWrite("draft", originalBody, "POST", originalKey);
    assert.equal(adopted.response.status, 200, JSON.stringify(adopted.body));
    assert.equal(adopted.body?.draft.state, "DRAFT");
    assert.equal((await resourceWrite("draft", originalBody, "POST", originalKey)).body?.draft.id, adopted.body?.draft.id, "same key replays the original draft");
    assert.equal((await resourceWrite("draft", { payload: DEFAULT_GUIDES[0] }, "POST", originalKey)).response.status, 409, "original key cannot change its payload");
    const recoveryQuery = new URLSearchParams({ operation: "content.resource.draft.create", resourceId: resourceKey, fingerprint: fingerprintRequest("content.resource.draft.create", resourceKey, originalBody) });
    const recovery = await request(base, `/api/bff/admin/content/operation-result?${recoveryQuery}`, undefined, platform.jar, ADMIN_ORIGIN, "GET", originalKey);
    assert.equal(recovery.body?.receipt, "RECORDED", JSON.stringify(recovery.body));
    assert.equal(recovery.body?.result.itemId, adopted.body?.item.id); assert.equal("payload" in recovery.body!, false);
    assert.equal((await request(base, `/api/bff/admin/content/operation-result?${recoveryQuery}`, undefined, reader.jar, ADMIN_ORIGIN, "GET", originalKey)).response.status, 403);
    assert.equal((await request(base, `/api/bff/admin/content/operation-result?${recoveryQuery}`, undefined, carouselEditor.jar, ADMIN_ORIGIN, "GET", originalKey)).body?.receipt, "UNRESOLVED", "another principal cannot read an original receipt");
    const { format: _oldFormat, schemaVersion: _oldSchema, markdown: _oldMarkdown, mediaIds: _oldMedia, anchorAliases: _oldAliases, sections: _oldSections, ...legacyMetadata } = adopted.body?.draft.payload;
    const changed = { ...legacyMetadata, title: "内容发布后可读的手册", sections: [{ id: "check", title: "核对", blocks: [{ type: "paragraph", text: "<script>只会作为文字展示</script>" }, { type: "link", text: "帮助中心", href: "/help" }] }] };
    const savedResource = await resourceWrite("draft", { versionId: adopted.body?.draft.id, expectedRevision: adopted.body?.item.revision, payload: changed }, "PUT");
    assert.equal(savedResource.response.status, 200, JSON.stringify(savedResource.body));
    assert.equal((await request(base, publicResourceUrl, undefined, cookieJar(), API_ORIGIN)).body?.payload.title, DEFAULT_GUIDES[0]!.title, "saving a draft must not replace public content");
    const publishBody = { versionId: savedResource.body?.draft.id, expectedRevision: savedResource.body?.item.revision };
    const concurrent = await Promise.all([resourceWrite("publish", publishBody), resourceWrite("publish", publishBody)]);
    assert.deepEqual(concurrent.map(result => result.response.status).sort(), [200, 409], "one current revision may publish only once");
    const online = await request(base, publicResourceUrl, undefined, cookieJar(), API_ORIGIN);
    assert.equal(online.body?.payload.title, changed.title); assert.equal(online.body?.source, "MANAGED");
    assert.equal(online.body?.version.id, savedResource.body?.draft.id);
    assert.equal(online.body?.version.sequence, 1);
    for (const name of ["draft", "versions", "createdByAdminId", "storageKey", "publishedByAdminId"]) assert.equal(JSON.stringify(online.body).includes(`\"${name}\"`), false, name);
    const state = (await readResource()).body!;
    await assert.rejects(() => runtimePool!.query(`UPDATE zzsh_content.content_version SET payload = payload || '{"title":"illegal"}'::jsonb WHERE id = $1`, [state.published.id]), /immutable/, "published versions are immutable in PostgreSQL");
    const withdrawnResource = await resourceWrite("withdraw", { versionId: state.published.id, expectedRevision: state.item.revision });
    assert.equal(withdrawnResource.response.status, 200);
    const afterWithdraw = await request(base, publicResourceUrl, undefined, cookieJar(), API_ORIGIN);
    assert.equal(afterWithdraw.body?.state, "withdrawn"); assert.equal(afterWithdraw.body?.payload, null, "withdraw must not revive stale builtins");
    const restored = await resourceWrite("draft", { sourceVersionId: state.published.id });
    assert.equal(restored.response.status, 200); assert.equal(restored.body?.draft.sequence, 2); assert.equal(restored.body?.draft.payload.title, changed.title);
    const sourceDetail = await request(base, `${resourceUrl}/versions/${state.published.id}`, undefined, platform.jar, ADMIN_ORIGIN);
    assert.deepEqual(sourceDetail.body?.version.payload, changed);
    const explicitRestore = await resourceWrite("restore", { sourceVersionId: restored.body?.draft.id, expectedRevision: restored.body?.item.revision });
    assert.equal(explicitRestore.response.status, 200, JSON.stringify(explicitRestore.body));
    assert.deepEqual(explicitRestore.body?.draft.payload, changed, "blocks restore preserves the selected payload without conversion");
    assert.equal(explicitRestore.body?.versions.find((row: { id: string }) => row.id === restored.body?.draft.id)?.state, "SUPERSEDED", "replaced draft remains recoverable history");
    const archivedResourceDraft = explicitRestore.body?.versions.find((row: { id: string }) => row.id === restored.body?.draft.id);
    assert.equal(archivedResourceDraft?.publishedAt, null, "archiving a draft must not invent a publication time");
    assert.equal(archivedResourceDraft?.publishedByAdminId, null, "archiving a draft must not invent a publisher");
    const { sections: _sections, format: _format, schemaVersion: _schemaVersion, markdown: _markdown, mediaIds: _mediaIds, anchorAliases: _aliases, ...guideMetadata } = DEFAULT_GUIDES[0]!;
    const markdownPayload = { ...guideMetadata, format: "markdown", schemaVersion: 1, markdown: "<div>保留原文，不能发布</div>", mediaIds: [] };
    const markdownDraft = await resourceWrite("draft", { versionId: explicitRestore.body?.draft.id, expectedRevision: explicitRestore.body?.item.revision, payload: markdownPayload }, "PUT");
    assert.equal(markdownDraft.response.status, 200, JSON.stringify(markdownDraft.body));
    assert.equal(markdownDraft.body?.draft.payload.markdown, markdownPayload.markdown);
    assert.equal((await resourceWrite("publish", { versionId: markdownDraft.body?.draft.id, expectedRevision: markdownDraft.body?.item.revision })).response.status, 400, "HTML can be saved verbatim but not published");
    const validMarkdown = { ...markdownPayload, markdown: "## 新正文\n\n这一版已通过正文校验。", mediaIds: [] };
    const validDraft = await resourceWrite("draft", { versionId: markdownDraft.body?.draft.id, expectedRevision: markdownDraft.body?.item.revision, payload: validMarkdown }, "PUT");
    assert.equal(validDraft.response.status, 200);
    assert.equal((await resourceWrite("publish", { versionId: validDraft.body?.draft.id, expectedRevision: validDraft.body?.item.revision })).response.status, 200);
    const markdownPublic = await request(base, publicResourceUrl, undefined, cookieJar(), API_ORIGIN);
    assert.equal(markdownPublic.body?.payload.markdown, validMarkdown.markdown);
    assert.equal(markdownPublic.body?.version.id, validDraft.body?.draft.id);
    const unknownKey = "guide:custom-content-test";
    const custom = { ...DEFAULT_GUIDES[0]!, id: "custom-content-test", slug: "custom-content-test" };
    const customCreated = await request(base, resourceRoot + encodeURIComponent(unknownKey) + "/draft", { payload: custom, gameId: gameA }, gameEditor.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(customCreated.response.status, 200, JSON.stringify(customCreated.body));
    assert.equal((await request(base, `${resourceUrl}/versions/${customCreated.body?.draft.id}`, undefined, platform.jar, ADMIN_ORIGIN)).response.status, 404, "history detail cannot cross resource ownership");
    const customAdminList = await request(base, `/api/bff/admin/content/resources?scope=game&gameId=${gameA}&limit=5`, undefined, gameEditor.jar, ADMIN_ORIGIN);
    assert.equal(customAdminList.body?.items.find((row: { current: { key: string } }) => row.current.key === unknownKey)?.metadata.title, custom.title, "admin lists name draft-only articles without exposing them publicly");
    assert.equal((await request(base, "/api/v1/content/resources/" + encodeURIComponent(unknownKey), undefined, cookieJar(), API_ORIGIN)).response.status, 404);
    assert.equal((await request(base, resourceRoot + encodeURIComponent(unknownKey), undefined, platform.jar, ADMIN_ORIGIN)).response.status, 403);
    assert.equal((await request(base, resourceRoot + encodeURIComponent(unknownKey), undefined, unscopedEditor.jar, ADMIN_ORIGIN)).response.status, 403);
    const allPublicKeys: string[] = []; let resourcesCursor: string | null = null;
    do {
      const query = new URLSearchParams({ kind: "guide", limit: "5", ...(resourcesCursor ? { cursor: resourcesCursor } : {}) });
      const list = await request(base, `/api/v1/content/resources?${query}`, undefined, cookieJar(), API_ORIGIN);
      assert.equal(list.response.status, 200, JSON.stringify(list.body));
      allPublicKeys.push(...list.body!.items.map((row: { key: string }) => row.key)); resourcesCursor = list.body!.nextCursor;
    } while (resourcesCursor);
    assert.equal(allPublicKeys.length, 24); assert.equal(new Set(allPublicKeys).size, 24); assert.equal(allPublicKeys.includes(unknownKey), false);
    for (const limit of [6, 10]) {
      assert.equal((await request(base, `/api/v1/content/resources?limit=${limit}`, undefined, cookieJar(), API_ORIGIN)).response.status, 400);
      assert.equal((await request(base, `/api/bff/admin/content/resources?scope=platform&limit=${limit}`, undefined, platform.jar, ADMIN_ORIGIN)).response.status, 400);
    }
    const largeKey = "guide:resource-size-contract", largeUrl = resourceRoot + encodeURIComponent(largeKey);
    const largePrefix = "## 合成容量校验\n\n";
    const largeMarkdown = largePrefix + "x".repeat(195_000 - Buffer.byteLength(largePrefix, "utf8"));
    const largePayload = { ...guideMetadata, id: "resource-size-contract", slug: "resource-size-contract", title: "本地合成容量测试", format: "markdown", schemaVersion: 1, markdown: largeMarkdown, mediaIds: [] };
    const largeCreateBody = { payload: largePayload }, largeCreateKey = key();
    const largeCreated = await request(base, `${largeUrl}/draft`, largeCreateBody, platform.jar, ADMIN_ORIGIN, "POST", largeCreateKey);
    assert.equal(largeCreated.response.status, 200, JSON.stringify(largeCreated.body));
    assert.equal(largeCreated.body?.draft.body, "", "RESOURCE canonical text belongs to payload, not the legacy 20000-byte body column");
    assert.equal((await request(base, `${largeUrl}/draft`, largeCreateBody, platform.jar, ADMIN_ORIGIN, "POST", largeCreateKey)).body?.draft.id, largeCreated.body?.draft.id);
    const largeSaved = await request(base, `${largeUrl}/draft`, { versionId: largeCreated.body?.draft.id, expectedRevision: largeCreated.body?.item.revision, payload: largePayload }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(largeSaved.response.status, 200, JSON.stringify(largeSaved.body)); assert.equal(largeSaved.body?.draft.body, "");
    const largePublishBody = { versionId: largeSaved.body?.draft.id, expectedRevision: largeSaved.body?.item.revision }, largePublishKey = key();
    const largePublished = await request(base, `${largeUrl}/publish`, largePublishBody, platform.jar, ADMIN_ORIGIN, "POST", largePublishKey);
    assert.equal(largePublished.response.status, 200, JSON.stringify(largePublished.body));
    const largeReplay = await request(base, `${largeUrl}/publish`, largePublishBody, platform.jar, ADMIN_ORIGIN, "POST", largePublishKey);
    assert.equal(largeReplay.response.status, 200); assert.equal(largeReplay.body?.published.id, largeSaved.body?.draft.id);
    const largePublic = await request(base, "/api/v1/content/resources/" + encodeURIComponent(largeKey), undefined, cookieJar(), API_ORIGIN);
    assert.equal(largePublic.response.status, 200); assert.equal(largePublic.body?.payload.markdown, largeMarkdown);
    assert.equal(largePublic.body?.version.id, largeSaved.body?.draft.id);
    const largeStored = (await runtimePool.query(`SELECT "body", octet_length("payload"->>'markdown') AS "markdownBytes" FROM "zzsh_content"."content_version" WHERE "id" = $1`, [largeSaved.body?.draft.id])).rows[0];
    assert.equal(largeStored.body, ""); assert.equal(largeStored.markdownBytes, 195_000, "large Markdown must not be truncated to the legacy body limit");
    const largeReceiptQuery = new URLSearchParams({ operation: "content.resource.publish", resourceId: largeKey, fingerprint: fingerprintRequest("content.resource.publish", largeKey, largePublishBody) });
    const largeReceipt = await request(base, `/api/bff/admin/content/operation-result?${largeReceiptQuery}`, undefined, platform.jar, ADMIN_ORIGIN, "GET", largePublishKey);
    assert.equal(largeReceipt.response.status, 200); assert.equal(largeReceipt.body?.receipt, "RECORDED"); assert.equal(largeReceipt.body?.result.publishedVersionId, largeSaved.body?.draft.id);
    const largeRestored = await request(base, `${largeUrl}/restore`, { sourceVersionId: largeSaved.body?.draft.id, expectedRevision: largePublished.body?.item.revision }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(largeRestored.response.status, 200, JSON.stringify(largeRestored.body)); assert.equal(largeRestored.body?.draft.body, "");
    assert.equal(largeRestored.body?.draft.payload.markdown, largeMarkdown);
    const contactKey = "placement:FOLLOW", contactUrl = resourceRoot + encodeURIComponent(contactKey);
    assert.equal((await request(base, `${contactUrl}/draft`, { payload: DEFAULT_RESOURCES[contactKey] }, platform.jar, ADMIN_ORIGIN, "POST", key())).response.status, 400, "fixed resource metadata cannot be injected at creation");
    const createdContact = await request(base, `${contactUrl}/draft`, {}, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(createdContact.response.status, 200);
    assert.equal((await request(base, `${contactUrl}/draft`, { versionId: createdContact.body?.draft.id, expectedRevision: createdContact.body?.item.revision, payload: createdContact.body?.draft.payload }, platform.jar, ADMIN_ORIGIN, "PUT", key())).response.status, 400, "fixed images cannot use the generic complete-payload writer");
    assert.equal((await request(base, `${contactUrl}/media-draft`, { versionId: createdContact.body?.draft.id, expectedRevision: createdContact.body?.item.revision, media: { qrMediaId: assetId, title: "不能改文案" } }, platform.jar, ADMIN_ORIGIN, "PUT", key())).response.status, 400);
    const contactDraft = await request(base, `${contactUrl}/media-draft`, { versionId: createdContact.body?.draft.id, expectedRevision: createdContact.body?.item.revision, media: { qrMediaId: assetId } }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(contactDraft.response.status, 200, JSON.stringify(contactDraft.body));
    assert.deepEqual(contactDraft.body?.draft.payload, { ...createdContact.body?.draft.payload, qrMediaId: assetId }, "only the media reference changes");
    const contactPublish = { versionId: contactDraft.body?.draft.id, expectedRevision: contactDraft.body?.item.revision };
    assert.equal((await request(base, `${contactUrl}/publish`, contactPublish, platform.jar, ADMIN_ORIGIN, "POST", key())).response.status, 409, "revoked media cannot be published");
    assert.equal((await request(base, `/api/bff/admin/content/media/${assetId}/visibility`, { visibility: "PUBLIC_DISPLAY" }, platform.jar, ADMIN_ORIGIN, "POST", key())).response.status, 200);
    assert.equal((await request(base, `${contactUrl}/publish`, contactPublish, platform.jar, ADMIN_ORIGIN, "POST", key())).response.status, 400, "undersized QR is rejected at publishing");
    const uploadResourceImage = async (width: number, height: number, color: string): Promise<string> => {
      const bytes = await sharp({ create: { width, height, channels: 3, background: color } }).png().toBuffer();
      const intent = await request(base, "/api/bff/admin/content/media/upload-intents", { purpose: "CONTENT_MEDIA", mime: "image/png", size: bytes.length }, platform.jar, ADMIN_ORIGIN, "POST", key());
      assert.equal(intent.response.status, 200);
      const uploaded = await uploadBytes(base, `/api/bff/admin/content/media/uploads/${intent.body?.intentId}`, platform.jar, intent.body?.uploadToken, bytes);
      assert.equal(uploaded.status, 200);
      const id = uploaded.body?.assetId as string;
      assert.equal((await request(base, `/api/bff/admin/content/media/${id}/review`, { decision: "APPROVE", visibility: "PUBLIC_DISPLAY" }, platform.jar, ADMIN_ORIGIN, "POST", key())).response.status, 200);
      return id;
    };
    const qrFixtureId = await uploadResourceImage(512, 512, "green");
    const correctedContact = await request(base, `${contactUrl}/media-draft`, { versionId: contactDraft.body?.draft.id, expectedRevision: contactDraft.body?.item.revision, media: { qrMediaId: qrFixtureId } }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(correctedContact.response.status, 200);
    assert.equal((await request(base, `${contactUrl}/publish`, { versionId: correctedContact.body?.draft.id, expectedRevision: correctedContact.body?.item.revision }, platform.jar, ADMIN_ORIGIN, "POST", key())).response.status, 200);
    assert.equal((await request(base, `/api/bff/admin/content/media/${qrFixtureId}/visibility`, { visibility: "PRIVATE_REVIEW" }, platform.jar, ADMIN_ORIGIN, "POST", key())).response.status, 200);
    const revokedContact = await request(base, "/api/v1/content/resources/" + encodeURIComponent(contactKey), undefined, cookieJar(), API_ORIGIN);
    assert.equal(revokedContact.body?.media[0].url, null, "resource projection checks current media visibility");
    assert.equal((await request(base, "/api/bff/admin/content/storage", undefined, reader.jar, ADMIN_ORIGIN)).body?.backend, "local");
    assert.equal((await request(base, "/api/bff/admin/content/storage", undefined, gameEditor.jar, ADMIN_ORIGIN)).response.status, 403);
    const heroUrl = resourceRoot + encodeURIComponent("placement:HOME_HERO");
    let heroDraft = await request(base, `${heroUrl}/draft`, {}, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(heroDraft.response.status, 200, JSON.stringify(heroDraft.body));
    assert.equal(heroDraft.body?.draft.payload.kind, "carousel");
    const neverPublishedHeroDraftId = heroDraft.body?.draft.id;
    heroDraft = await request(base, `${heroUrl}/restore`, { sourceVersionId: neverPublishedHeroDraftId, expectedRevision: heroDraft.body?.item.revision }, platform.jar, ADMIN_ORIGIN, "POST", key());
    assert.equal(heroDraft.response.status, 200, JSON.stringify(heroDraft.body));
    const archivedHero = heroDraft.body?.versions.find((row: { id: string }) => row.id === neverPublishedHeroDraftId);
    assert.equal(archivedHero?.state, "SUPERSEDED"); assert.equal(archivedHero?.publishedAt, null); assert.equal(archivedHero?.publishedByAdminId, null);
    const pendingHeroPublic = await request(base, "/api/v1/content/resources/" + encodeURIComponent("placement:HOME_HERO"), undefined, cookieJar(), API_ORIGIN);
    assert.equal(pendingHeroPublic.body?.state, "available", "unpublished archived drafts must not be mistaken for withdrawn content");
    assert.equal(pendingHeroPublic.body?.version, null);
    assert.equal((await request(base, `/api/bff/admin/content/carousel/${carouselId}`, { expectedRevision: "1", title: "旧入口不能再写" }, platform.jar, ADMIN_ORIGIN, "PUT", key())).response.status, 409, "legacy carousel writes stop once adopted");
    const heroDesktop = await uploadResourceImage(920, 400, "blue"), heroMobile = await uploadResourceImage(920, 400, "orange");
    assert.deepEqual(heroDraft.body?.draft.payload.slides.map((row: { id: string }) => row.id), ["delta", "protection", "accounts"]);
    const heroMedia = { slides: heroDraft.body?.draft.payload.slides.map((slide: { id: string }) => ({ id: slide.id, mediaId: slide.id === "delta" ? heroDesktop : null, mobileMediaId: slide.id === "delta" ? heroMobile : null })) };
    const heroSaved = await request(base, `${heroUrl}/media-draft`, { versionId: heroDraft.body?.draft.id, expectedRevision: heroDraft.body?.item.revision, media: heroMedia }, platform.jar, ADMIN_ORIGIN, "PUT", key());
    assert.equal(heroSaved.response.status, 200, JSON.stringify(heroSaved.body));
    assert.equal((await request(base, `${heroUrl}/publish`, { versionId: heroSaved.body?.draft.id, expectedRevision: heroSaved.body?.item.revision }, platform.jar, ADMIN_ORIGIN, "POST", key())).response.status, 200);
    const heroPublic = await request(base, "/api/v1/content/carousel?slot=HOME_HERO", undefined, cookieJar(), API_ORIGIN);
    assert.deepEqual(heroPublic.body?.items.map((row: { id: string }) => row.id), ["delta"]);
    assert.equal(heroPublic.body?.items[0].mobileMediaUrl, `/api/v1/content/media/${heroMobile}/content`);
    assert.equal((await request(base, `/api/bff/admin/content/media/${heroMobile}/visibility`, { visibility: "PRIVATE_REVIEW" }, platform.jar, ADMIN_ORIGIN, "POST", key())).response.status, 200);
    const heroRevokedMobile = await request(base, "/api/v1/content/carousel?slot=HOME_HERO", undefined, cookieJar(), API_ORIGIN);
    assert.equal(heroRevokedMobile.body?.items[0].mobileMediaUrl, null); assert.ok(heroRevokedMobile.body?.items[0].mediaUrl);

    // ---------- 审计 ----------
    const auditCount = await runtimePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_iam"."audit_event" WHERE "action" LIKE 'content.%'`);
    assert.ok(Number(auditCount.rows[0]?.count ?? "0") >= 15, "content writes must be audited");
    const audits = (await runtimePool.query(`SELECT object_type, object_id, action, details FROM zzsh_iam.audit_event WHERE action LIKE 'content.%'`)).rows;
    assert.equal(JSON.stringify(audits).includes("uploadToken"), false, "audit details must not copy upload tokens");
    assert.equal(audits.some((row) => row.action === "content.version.published" && row.object_id === secondDraftId && row.details.after?.state === "PUBLISHED" && row.details.before?.state === "DRAFT"), true, "publish audit must keep before/after state");
    assert.equal(audits.some((row) => row.action === "content.version.withdrawn" && row.object_id === secondDraftId && row.details.after?.state === "WITHDRAWN"), true);
    assert.equal(audits.some((row) => row.action === "content.media.reviewed" && row.object_id === assetId && row.details.after?.review_state === "APPROVED"), true);
    assert.equal(audits.some((row) => row.object_id === carouselId && row.action === "content.carousel.created" && row.details.after?.enabled === false), true);
    assert.equal(audits.every((row) => row.object_id && row.details.before !== undefined && row.details.after !== undefined && typeof row.details.result === "string"), true);

    // 公告/资讯列表的后台分页与 scope 校验
    const platformPage = await request(base, "/api/bff/admin/content/items?scope=platform&limit=1", undefined, platform.jar, ADMIN_ORIGIN);
    assert.ok(platformPage.body?.nextCursor, "admin list must page with a cursor");
    const staleScopeCursor = await request(base, `/api/bff/admin/content/items?scope=game&gameId=${gameA}&cursor=${encodeURIComponent(platformPage.body?.nextCursor)}`, undefined, gameEditor.jar, ADMIN_ORIGIN);
    assert.equal(staleScopeCursor.response.status, 409, "admin cursor must be bound to scope filters");
    if (exportPaths) {
      await copyOwnedFixtureMedia(mediaDir, mediaDirReal, exportPaths.media);
      exportedFixture = {
        schema: "zzsh-content-local-fixture.v1", resourceSet: "cms_formal",
        database: { name: resources.databaseName, migrationUser: resources.migrationUser, runtimeUser: resources.runtimeUser, marker: RESOURCE_MARKER },
        origins: { user: USER_ORIGIN, admin: ADMIN_ORIGIN, api: API_ORIGIN },
        boss: { id: boss.id, username: boss.username, password: boss.password, secret: boss.secret },
        authRuntimeEnv,
        mediaDirectory: exportPaths.media,
        createdAt: new Date().toISOString(),
      };
    }
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
    try {
      assert.equal((await lstat(mediaDir)).isSymbolicLink(), false, "owned fixture directory cannot become a symbolic link");
      assert.equal(relative(mediaDirReal, await realpath(mediaDir)), "", "owned fixture directory cannot be redirected before cleanup");
      await rm(mediaDirReal, { recursive: true, force: true });
    } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length > 0) throw cleanupErrors[0];
  }
  if (exportPaths && exportedFixture) {
    await writeFile(exportPaths.output, JSON.stringify(exportedFixture, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  }
});
