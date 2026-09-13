import { runSupplyPoolChecks } from "./supply-pool-checks";
import { ISOLATED_BUSINESS_DATA_TRUNCATE } from "./database-test-support";
import { runPublishingChecks } from "./supply-publishing-checks";
import { runMediaOssChecks, type MediaStorageFaults } from "./supply-media-oss-checks";
import type { SupplyGate } from "../src/supply/publishing";
import sharp from "sharp";
import { fingerprintRequest } from "../src/supply/supply-util";
import { strict as assert } from "node:assert";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { Pool, type PoolClient } from "pg";

import { createApp } from "../src/app";
import { loadAuthRuntimeConfig } from "../src/auth/auth-runtime";
import { assertBusinessRuntimeIdentity, createBusinessPool } from "../src/database/business";
import { runBusinessMigrations } from "../src/database/business-migrations";
import { createLocalMediaStorage, MediaStorageError } from "../src/supply/media";
import { loadConfig, type AppConfig } from "../src/config/config";

const RESOURCE_SET = process.env.SUPPLY_TEST_RESOURCE_SET?.trim() || "";
if(RESOURCE_SET && !/^[a-z][a-z0-9_]{0,20}$/.test(RESOURCE_SET)) throw new Error("Invalid supply test resource set");
const DEFAULT_DATABASE = RESOURCE_SET ? "zzsh_test_supply_"+RESOURCE_SET : "zzsh_test_m3b_supply";
const RESOURCE_MARKER = "zzsh:m3b-supply-test:v1";
const LOCK_KEY = RESOURCE_SET ? (BigInt("0x"+createHash("sha256").update("supply-test:"+RESOURCE_SET).digest("hex").slice(0,15))+2000000n).toString() : "805015";
const USER_ORIGIN = "http://127.0.0.1:3100";
const ADMIN_ORIGIN = "http://127.0.0.1:3101";
const API_ORIGIN = "http://127.0.0.1:3102";
const BUSINESS_SCHEMAS = ["zzsh_business_meta", "zzsh_iam", "zzsh_auth_user", "zzsh_auth_admin", "zzsh_supply"] as const;
const HAFF_RULE = {
  schema: "haff-ratio-v1",
  baseBySafeBox: { "box-a": "50", "box-b": "60" },
  vitalityDeltaByLevel: { "0": "0", "6": "0", "7": "-5" },
  bearDeltaByLevel: { "0": "0", "6": "0", "7": "-5" },
  dailyDeltaByTermOption: { "daily-10m": "0", "daily-20m": "10" },
  options: { standard: { delta: "0", enabled: true } },
  spreadDelta: "10",
};

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
  const databaseName = process.env.M3B_SUPPLY_TEST_DB_NAME?.trim() || DEFAULT_DATABASE;
  assert.notEqual(databaseName, "zzsh_dev");
  const migrationUser = safeIdentifier(process.env.M3B_SUPPLY_TEST_MIGRATION_USER?.trim() || (RESOURCE_SET?"zzsh_m3b_"+RESOURCE_SET+"_m":"zzsh_m3b_migration"), "migration user");
  const runtimeUser = safeIdentifier(process.env.M3B_SUPPLY_TEST_RUNTIME_USER?.trim() || (RESOURCE_SET?"zzsh_m3b_"+RESOURCE_SET+"_r":"zzsh_m3b_runtime"), "runtime user");
  assert.notEqual(migrationUser, runtimeUser);
  if(RESOURCE_SET){assert.equal(databaseName,DEFAULT_DATABASE);assert.equal(migrationUser,"zzsh_m3b_"+RESOURCE_SET+"_m");assert.equal(runtimeUser,"zzsh_m3b_"+RESOURCE_SET+"_r");}
  if (!migrationUser.startsWith("zzsh_m3b_") || !runtimeUser.startsWith("zzsh_m3b_")) throw new Error("supply test roles must use the isolated zzsh_m3b_ prefix");
  const maintenanceUser = process.env.M3B_SUPPLY_TEST_MAINTENANCE_USER ?? process.env.DB_USER;
  const baseEnv = {
    ...process.env,
    APP_PROFILE: "test",
    PROVIDER_MODE: "fake",
    DB_TARGET: "local-compose",
    DB_NAME: databaseName,
    ...(maintenanceUser ? { DB_USER: maintenanceUser } : {}),
  };
  const maintenance = loadConfig(baseEnv);
  const migrationPassword = process.env.M3B_SUPPLY_TEST_MIGRATION_PASSWORD?.trim() || randomBytes(32).toString("hex");
  const runtimePassword = process.env.M3B_SUPPLY_TEST_RUNTIME_PASSWORD?.trim() || randomBytes(32).toString("hex");
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
    assert.equal((await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [LOCK_KEY])).rows[0]?.acquired, true, "dedicated supply test target is already in use");
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

let pngFixture = Buffer.alloc(0);
function pngBytes(): Buffer { return pngFixture; }

function jpegBytes(width = 32, height = 32): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, (height >> 8) & 0xff, height & 0xff, (width >> 8) & 0xff, width & 0xff, 3, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof]);
}

function supplyKey(): Record<string, string> {
  return { "idempotency-key": `idem_${randomUUID().replaceAll("-", "")}` };
}

async function uploadBytes(base: string, path: string, jar: CookieJar, origin: string, token: string): Promise<{ status: number; body: Record<string, any> | null }> {
  const response = await fetch(base + path, {
    method: "PUT",
    headers: { origin, "content-type": "image/png", "x-upload-token": token, "idempotency-key": `idem_${randomUUID().replaceAll("-", "")}`, cookie: jar.header() },
    body: new Uint8Array(pngBytes()),
  });
  jar.update(response);
  return { status: response.status, body: await readJson(response) };
}

test("M3-B foundations and M3-C publication, authorization and review behave under real PostgreSQL", async (testContext) => {
  let resources: Resources | undefined;
  let maintenancePool: Pool | undefined;
  let maintenanceDataPool: Pool | undefined;
  let migrationPool: Pool | undefined;
  let runtimePool: Pool | undefined;
  let guard: PoolClient | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let runtimeClosedByApp = false;
  const mediaDir = await mkdtemp(join(tmpdir(), "zzsh-m3b-media-"));
  const baseStorage = createLocalMediaStorage(mediaDir);
  const publicationGates=new Map<string,SupplyGate>();
  const readProbe:{run?:(client:PoolClient,account:{id:string})=>Promise<void>}={};
  let storageAvailable = true;
  const storageFaults: MediaStorageFaults = { writeOutcomes: [], writeCalls: 0 };
  const mediaStorage = {
    get available() { return storageAvailable; },
    get kind() { return baseStorage.kind; },
    async write(bytes: Buffer, contentHash: string) {
      storageFaults.writeCalls += 1;
      // Capture the sequence number at increment time: reading it later would
      // let two concurrent writes observe the same value and break barriers.
      const call = storageFaults.writeCalls;
      const outcome = storageFaults.writeOutcomes.shift();
      if (outcome === "fail") throw new MediaStorageError("media storage operation failed");
      if (outcome === "slow-fail") {
        await new Promise((resolve) => setTimeout(resolve, 50));
        throw new MediaStorageError("media storage operation failed");
      }
      if (outcome === "land-then-timeout") {
        // The object lands in storage, then the transport reports a timeout:
        // the outcome of this write is unknown to the caller.
        await baseStorage.write(bytes, contentHash);
        await storageFaults.afterWrite?.(call);
        throw new MediaStorageError("media storage operation failed");
      }
      const result = await baseStorage.write(bytes, contentHash);
      await storageFaults.afterWrite?.(call);
      return result;
    },
    read: (key: string) => baseStorage.read(key),
  };
  try {
    resources = makeResources();
    pngFixture = await sharp({ create: { width: 64, height: 64, channels: 3, background: "red" } }).withExif({ IFD0: { Artist: "private original" } }).png().toBuffer();
    maintenancePool = poolFor(resources.maintenance, "postgres", "zzsh-m3b-maintenance", 2);
    guard = await resourceGuard(maintenancePool);
    await ensureDatabase(maintenancePool, resources);
    await ensureRole(maintenancePool, resources.migrationUser, resources.migrationPassword, roleMarker(resources.databaseName, "migration"));
    await ensureRole(maintenancePool, resources.runtimeUser, resources.runtimePassword, roleMarker(resources.databaseName, "runtime"));
    await grantDatabaseAccess(maintenancePool, resources);
    maintenanceDataPool = poolFor(resources.maintenance, resources.databaseName, "zzsh-m3b-owner", 2);
    await prepareOwnership(maintenanceDataPool, resources);
    migrationPool = createBusinessPool(resources.migration);
    await runBusinessMigrations(migrationPool, { runtimeUser: resources.runtimeUser });
    await runBusinessMigrations(migrationPool, { runtimeUser: resources.runtimeUser });
    runtimePool = createBusinessPool(resources.runtime);
    await assertBusinessRuntimeIdentity(runtimePool, resources.runtime);
    await resetIsolatedData(maintenanceDataPool);

    const tables = await runtimePool.query<{ exists: boolean }>(
      "SELECT to_regclass('zzsh_supply.media_asset') IS NOT NULL AND to_regclass('zzsh_supply.price_version') IS NOT NULL AND to_regclass('zzsh_supply.idempotency_record') IS NOT NULL AS exists",
    );
    assert.equal(tables.rows[0]?.exists, true);
    const createdAt = await runtimePool.query<{ created: string }>("SELECT created_at::text AS created FROM zzsh_supply.game LIMIT 1");
    assert.equal(createdAt.rows.length, 0);

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
      mediaStorage,
      testSupplyGateReader: async (client:PoolClient,a:{id:string}) => {await readProbe.run?.(client,a);return publicationGates.get(a.id) ?? {publisherBail:"UNKNOWN" as const,occupancy:"UNKNOWN" as const,reference:null};},
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
    const bootstrap = await request(base, "/api/v1/admin/security/bootstrap", { bootstrapSecret, name: "供给 Boss", password: bossPassword }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(bootstrap.response.status, 200);
    const boss = await activate(base, bootstrap.body?.username as string, bossPassword);

    const createStaff = async (name: string, allowPermissions: string[]): Promise<Staff> => {
      const created = await request(base, "/api/v1/admin/security/admins/create", { name, allowPermissions }, boss.jar, ADMIN_ORIGIN);
      assert.equal(created.response.status, 200, JSON.stringify(created.body));
      return activate(base, created.body?.username as string, created.body?.temporaryPassword as string);
    };
    const unscoped = await createStaff("无范围目录员", ["supply.catalog.manage"]);
    const operator = await createStaff("供给运营", [
      "supply.catalog.manage",
      "supply.rules.edit",
      "supply.rules.activate",
      "supply.quote.internal.read",
      "supply.review.read",
      "supply.review.decide",
    ]);

    // ---------- 目录 ----------
    const createdGame = await request(base, "/api/bff/admin/supply/games", { code: "delta", name: "三角洲行动", description: "合成测试游戏" }, boss.jar, ADMIN_ORIGIN, "POST", supplyKey());
    assert.equal(createdGame.response.status, 200, JSON.stringify(createdGame.body));
    const gameId = createdGame.body?.game?.id as string;
    assert.ok(gameId);

    const unscopedGames = await request(base, "/api/bff/admin/supply/games", undefined, unscoped.jar, ADMIN_ORIGIN);
    assert.equal(unscopedGames.response.status, 200);
    assert.deepEqual(unscopedGames.body?.games, []);
    const unscopedCatalog = await request(base, `/api/bff/admin/supply/games/${gameId}/catalog`, undefined, unscoped.jar, ADMIN_ORIGIN);
    assert.equal(unscopedCatalog.response.status, 404);

    await runtimePool.query(
      `INSERT INTO "zzsh_supply"."admin_supply_scope" ("admin_user_id", "game_id", "granted_by_admin_id") VALUES ($1, $2, $3)`,
      [operator.id, gameId, boss.id],
    );

    const createEntry = async (kind: string, body: Record<string, unknown>): Promise<string> => {
      const created = await request(base, `/api/bff/admin/supply/games/${gameId}/${kind}`, body, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
      assert.equal(created.response.status, 200, JSON.stringify(created.body));
      return created.body?.id as string;
    };
    const haffItem = await createEntry("items", { code: "haff_base", name: "哈夫币", unit: "HAFF_BASE", required: true });
    const roundItem = await createEntry("items", { code: "round_item", name: "子弹", unit: "ROUND" });
    await createEntry("rarities", { code: "gold", name: "金色" });
    const weaponRoot = await createEntry("categories", { code: "weapon", name: "武器" });
    const rifle = await createEntry("categories", { code: "rifle", name: "步枪", parentId: weaponRoot });
    const model = await createEntry("categories", { code: "m4a1", name: "M4A1", parentId: rifle });
    const tooDeep = await request(base, `/api/bff/admin/supply/games/${gameId}/categories`, { code: "too_deep", name: "第四级", parentId: model }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
    assert.equal(tooDeep.response.status, 400, JSON.stringify(tooDeep.body));
    const cycle = await request(base, `/api/bff/admin/supply/categories/${weaponRoot}`, { parentId: model }, operator.jar, ADMIN_ORIGIN, "PUT", supplyKey());
    assert.equal(cycle.response.status, 400, JSON.stringify(cycle.body));
    const selfParent = await request(base, `/api/bff/admin/supply/categories/${weaponRoot}`, { parentId: weaponRoot }, operator.jar, ADMIN_ORIGIN, "PUT", supplyKey());
    assert.equal(selfParent.response.status, 400);

    const skin = await createEntry("skins", { code: "skin_m4_gold", name: "M4A1 金色", categoryId: model, rarityCode: "gold", sourceField: "knifeSkin", sourceToken: "legacy-unknown-token" });
    const rarityCount = await runtimePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_supply"."skin_rarity" WHERE "game_id" = $1 AND "code" = 'legacy-unknown-token'`, [gameId]);
    assert.equal(rarityCount.rows[0]?.count, "0", "unknown legacy tokens must not be auto-created as valid catalog entries");

    const renamed = await request(base, `/api/bff/admin/supply/skins/${skin}`, { name: "M4A1 金色（改名）" }, operator.jar, ADMIN_ORIGIN, "PUT", supplyKey());
    assert.equal(renamed.response.status, 200, JSON.stringify(renamed.body));
    const skinRow = await runtimePool.query<{ code: string; name: string; rarityCode: string | null; sourceToken: string | null }>(
      `SELECT "code", "name", "rarity_code" AS "rarityCode", "source_token" AS "sourceToken" FROM "zzsh_supply"."skin" WHERE "id" = $1`,
      [skin],
    );
    assert.equal(skinRow.rows[0]?.code, "skin_m4_gold");
    assert.equal(skinRow.rows[0]?.name, "M4A1 金色（改名）");
    assert.equal(skinRow.rows[0]?.sourceToken, "legacy-unknown-token");

    const bareSkin = await createEntry("skins", { code: "skin_no_rarity", name: "无稀有度皮肤", categoryId: model });
    const bareRow = await runtimePool.query<{ rarityCode: string | null }>(`SELECT "rarity_code" AS "rarityCode" FROM "zzsh_supply"."skin" WHERE "id" = $1`, [bareSkin]);
    assert.equal(bareRow.rows[0]?.rarityCode, null, "missing rarity must stay null instead of defaulting to a value");
    await createEntry("skins", { code: "skin_m4_red", name: "M4A1 红色", categoryId: model });

    await request(base, `/api/bff/admin/supply/skins/${bareSkin}`, { enabled: false }, operator.jar, ADMIN_ORIGIN, "PUT", supplyKey());

    const publicCatalog = await request(base, `/api/v1/supply/games/${gameId}/catalog`, undefined, cookieJar(), API_ORIGIN);
    assert.equal(publicCatalog.response.status, 200, JSON.stringify(publicCatalog.body));
    const publicJson = JSON.stringify(publicCatalog.body);
    for (const forbidden of ["\"sourceField\":", "\"sourceToken\":", "\"sourceNote\":", "\"enabled\":", "\"formVisible\":"]) {
      assert.equal(publicJson.includes(forbidden), false, `public catalog leaked ${forbidden}`);
    }
    assert.equal(publicCatalog.body?.skins.some((entry: { id: string }) => entry.id === bareSkin), false);
    assert.equal(publicCatalog.body?.skins.some((entry: { id: string; rarityCode?: string }) => entry.id === skin && entry.rarityCode === "gold"), true);

    const pagedCatalog = await request(base, `/api/v1/supply/games/${gameId}/catalog?limit=1`, undefined, cookieJar(), API_ORIGIN);
    assert.ok(pagedCatalog.body?.nextCursor);

    const rarityFiltered = await request(base, `/api/v1/supply/games/${gameId}/catalog?rarityCode=gold`, undefined, cookieJar(), API_ORIGIN);
    assert.equal(rarityFiltered.body?.skins.length, 1);
    const categoryFiltered = await request(base, `/api/v1/supply/games/${gameId}/catalog?categoryId=${weaponRoot}`, undefined, cookieJar(), API_ORIGIN);
    assert.equal(categoryFiltered.body?.skins.length, 2);

    const deleteDenied = await runtimePool.query(`DELETE FROM "zzsh_supply"."billable_item" WHERE "id" = $1`, [roundItem]).then(() => null, (error: unknown) => error);
    assert.ok(deleteDenied, "runtime role must not be able to delete catalog entries");

    // ---------- 价目、租期与协议版本 ----------
    const drafts = async (): Promise<{ priceId: string; termId: string; agreementId: string }> => {
      const price = await request(base, "/api/bff/admin/supply/price-drafts", { gameId, mode: "SPREAD" }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
      assert.equal(price.response.status, 200, JSON.stringify(price.body));
      const term = await request(base, "/api/bff/admin/supply/term-drafts", { gameId }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
      assert.equal(term.response.status, 200, JSON.stringify(term.body));
      const agreement = await request(base, "/api/bff/admin/supply/agreement-drafts", { gameId, title: "三角洲出租协议", body: "合成协议正文，仅用于隔离测试。" }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
      assert.equal(agreement.response.status, 200, JSON.stringify(agreement.body));
      return { priceId: price.body?.id as string, termId: term.body?.id as string, agreementId: agreement.body?.id as string };
    };

    const { priceId, termId, agreementId } = await drafts();
    const priceUpdate = await request(
      base,
      `/api/bff/admin/supply/price-drafts/${priceId}`,
      {
        expectedRevision: "1",
        haffRule: HAFF_RULE,
        roundingPolicy: "HALF_UP_CENT_V1",
        lines: [
          { itemId: haffItem, pricingKind: "HAFF_RATIO" },
          { itemId: roundItem, pricingKind: "FIXED_UNIT", unitQuantity: "1", buyerUnitAmount: "2.5", ownerUnitAmount: "2" },
        ],
      },
      operator.jar,
      ADMIN_ORIGIN,
      "PUT",
      supplyKey(),
    );
    assert.equal(priceUpdate.response.status, 200, JSON.stringify(priceUpdate.body));
    const termUpdate = await request(
      base,
      `/api/bff/admin/supply/term-drafts/${termId}`,
      {
        expectedRevision: "1",
        options: [
          { code: "daily-10m", name: "日消耗 10M", dailyConsumption: "10000000" },
          { code: "daily-20m", name: "日消耗 20M", dailyConsumption: "20000000" },
        ],
      },
      operator.jar,
      ADMIN_ORIGIN,
      "PUT",
      supplyKey(),
    );
    assert.equal(termUpdate.response.status, 200, JSON.stringify(termUpdate.body));

    const preview = async (body: Record<string, unknown>): Promise<Record<string, any> | null> => {
      const result = await request(base, "/api/bff/admin/supply/quote-preview", body, operator.jar, ADMIN_ORIGIN, "POST");
      assert.equal(result.response.status, 200, JSON.stringify(result.body));
      return result.body;
    };
    const quoteInput = (account: "A" | "B", extra: Record<string, unknown> = {}): Record<string, unknown> => ({
      priceVersionId: priceId,
      termVersionId: termId,
      accountId: "preview_account_A",
      conditions:
        account === "A"
          ? { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m", pricingOptionCode: "standard" }
          : { safeBoxCode: "box-b", vitLevel: 7, bearLevel: 7, termOptionCode: "daily-20m", pricingOptionCode: "standard" },
      inventory: [{ itemId: haffItem, quantity: "60000000" }],
      ...extra,
    });

    const quoteA = await preview(quoteInput("A"));
    assert.equal(quoteA?.quotable, true, JSON.stringify(quoteA));
    assert.equal(quoteA?.quote.lines[0].buyerAmount.amount, "150.00");
    assert.equal(quoteA?.quote.lines[0].ownerAmount.amount, "120.00");
    assert.equal(quoteA?.quote.lines[0].platformAmount.amount, "30.00");
    assert.equal(quoteA?.quote.termSeconds, String(6 * 86400));
    assert.equal(quoteA?.quote.tenantDeposit, null, "unconfigured deposits must not be reported as 0.00");
    assert.equal(quoteA?.quote.pricingInputs.depositPolicy, "UNCONFIGURED");
    assert.equal(typeof quoteA?.contentHash, "string");

    const quoteB = await preview(quoteInput("B"));
    assert.equal(quoteB?.quote.lines[0].buyerAmount.amount, "120.00");
    assert.equal(quoteB?.quote.lines[0].ownerAmount.amount, "100.00");
    assert.equal(quoteB?.quote.termSeconds, String(3 * 86400));

    const skinsDoNotPrice = await preview(quoteInput("A", { skins: ["skin_m4_gold"] }));
    const skinsDoNotPrice2 = await preview(quoteInput("A", { skins: ["skin_no_rarity", "skin_m4_gold"] }));
    const stripHash = (value: Record<string, any> | null): string =>
      JSON.stringify({ ...value, contentHash: undefined, contentPayload: undefined, quote: { ...value?.quote, contentHash: undefined } });
    assert.equal(stripHash(skinsDoNotPrice), stripHash(skinsDoNotPrice2), "skins must not change the quote values");

    const repeated = await preview(quoteInput("A"));
    assert.equal(repeated?.contentHash, quoteA?.contentHash, "same content must produce a stable content hash");
    const changed = await preview(quoteInput("A", { inventory: [{ itemId: haffItem, quantity: "50000000" }] }));
    assert.notEqual(changed?.contentHash, quoteA?.contentHash, "quantity changes must invalidate the previous content hash");
    const changedMedia = await preview(quoteInput("A", { mediaBindings: [{ assetId: "asset_x", byteHash: "a".repeat(64), purpose: "ACCOUNT_EVIDENCE", position: 1 }] }));
    assert.notEqual(changedMedia?.contentHash, quoteA?.contentHash);

    const missingCondition = await preview({
      priceVersionId: priceId,
      termVersionId: termId,
      conditions: { termOptionCode: "daily-10m" },
      inventory: [{ itemId: haffItem, quantity: "1000000" }],
    });
    assert.equal(missingCondition?.quotable, false);
    assert.ok((missingCondition?.reasonCodes ?? []).includes("RULE_INPUT_MISSING"));
    const unknownTermOption = await request(base, "/api/bff/admin/supply/quote-preview", { priceVersionId: priceId, termVersionId: termId, conditions: { termOptionCode: "daily-99m" }, inventory: [{ itemId: haffItem, quantity: "1000000" }] }, operator.jar, ADMIN_ORIGIN, "POST");
    assert.equal(unknownTermOption.response.status, 400);

    const invalidRule = await request(base, `/api/bff/admin/supply/price-drafts/${priceId}`, { expectedRevision: "2", haffRule: { ...HAFF_RULE, spreadDelta: "50" } }, operator.jar, ADMIN_ORIGIN, "PUT", supplyKey());
    assert.equal(invalidRule.response.status, 200, JSON.stringify(invalidRule.body));
    const invalidDenominator = await preview(quoteInput("A"));
    assert.equal(invalidDenominator?.quotable, false);
    assert.ok((invalidDenominator?.reasonCodes ?? []).includes("INVALID_DENOMINATOR"));
    const restoredRule = await request(base, `/api/bff/admin/supply/price-drafts/${priceId}`, { expectedRevision: "3", haffRule: HAFF_RULE }, operator.jar, ADMIN_ORIGIN, "PUT", supplyKey());
    assert.equal(restoredRule.response.status, 200, JSON.stringify(restoredRule.body));

    // 封存：重放同一 key 与异体同 key
    const replayKey = `idem_${randomUUID().replaceAll("-", "")}`;
    const seededRound = await request(base, `/api/bff/admin/supply/games/${gameId}/items`, { code: "seed_item", name: "种子物品", unit: "PIECE" }, operator.jar, ADMIN_ORIGIN, "POST", { "idempotency-key": replayKey });
    assert.equal(seededRound.response.status, 200);
    const replaySame = await request(base, `/api/bff/admin/supply/games/${gameId}/items`, { code: "seed_item", name: "种子物品", unit: "PIECE" }, operator.jar, ADMIN_ORIGIN, "POST", { "idempotency-key": replayKey });
    assert.equal(replaySame.response.status, 200);
    assert.equal(replaySame.body?.id, seededRound.body?.id, "idempotent replay must return the original result");
    await maintenanceDataPool.query(`UPDATE zzsh_supply.idempotency_record SET scope_key = $1 WHERE key = $2`, [JSON.stringify([operator.id, "supply.catalog.items.create", gameId]), replayKey]);
    await migrationPool.query(await readFile(join(__dirname, "../../migrations/business/0017_m3b_idempotency_realm.sql"), "utf8"));
    const migratedReplay = await request(base, `/api/bff/admin/supply/games/${gameId}/items`, { code: "seed_item", name: "种子物品", unit: "PIECE" }, operator.jar, ADMIN_ORIGIN, "POST", { "idempotency-key": replayKey });
    assert.deepEqual(migratedReplay.body, seededRound.body, "upgrading the realm scope must preserve old successful keys");
    const replayDifferent = await request(base, `/api/bff/admin/supply/games/${gameId}/items`, { code: "seed_item_2", name: "另一个物品", unit: "PIECE" }, operator.jar, ADMIN_ORIGIN, "POST", { "idempotency-key": replayKey });
    assert.equal(replayDifferent.response.status, 409);
    assert.equal(replayDifferent.body?.error?.code, "IDEMPOTENCY_KEY_REUSED");
    const seedCount = await runtimePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_supply"."billable_item" WHERE "game_id" = $1 AND "code" LIKE 'seed_item%'`, [gameId]);
    assert.equal(seedCount.rows[0]?.count, "1");

    await maintenanceDataPool.query(`DELETE FROM zzsh_supply.admin_supply_scope WHERE admin_user_id = $1 AND game_id = $2`, [operator.id, gameId]);
    const replayRevoked = await request(base, `/api/bff/admin/supply/games/${gameId}/items`, { code: "seed_item", name: "种子物品", unit: "PIECE" }, operator.jar, ADMIN_ORIGIN, "POST", { "idempotency-key": replayKey });
    assert.equal(replayRevoked.response.status, 404, "R3 cached success must honor current scope");
    await runtimePool.query(`INSERT INTO zzsh_supply.admin_supply_scope (admin_user_id, game_id, granted_by_admin_id) VALUES ($1,$2,$3)`, [operator.id, gameId, boss.id]);
    const realmScope = (await runtimePool.query(`SELECT scope_key FROM zzsh_supply.idempotency_record WHERE key = $1`, [replayKey])).rows[0].scope_key;
    assert.equal(JSON.parse(realmScope)[0], "admin");

    // A non-cooperating writer commits the same key while this request is in flight.
    // The resulting 23505 recovery must reauthorize before reading its success body.
    const recoveryKey = `idem_${randomUUID().replaceAll("-", "")}`;
    const recoveryBody = { code: "recovery_race", name: "竞争回读", unit: "PIECE" };
    const gate = await runtimePool.connect();
    try {
      await gate.query("BEGIN");
      await gate.query(`SELECT id FROM zzsh_supply.game WHERE id = $1 FOR UPDATE`, [gameId]);
      const gatePid = (await gate.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
      const pending = request(base, `/api/bff/admin/supply/games/${gameId}/items`, recoveryBody, operator.jar, ADMIN_ORIGIN, "POST", { "idempotency-key": recoveryKey });
      let blocked = false; const deadline = Date.now() + 5000;
      while (!blocked && Date.now() < deadline) { await gate.query("SELECT pg_stat_clear_snapshot()"); blocked = (await gate.query(`SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))) AS blocked`, [gatePid])).rows[0].blocked; }
      assert.equal(blocked, true);
      await maintenanceDataPool.query(`INSERT INTO zzsh_supply.idempotency_record (scope_key,key,request_fingerprint,response_status,response_body) VALUES ($1,$2,$3,200,$4)`, [JSON.stringify(["admin", operator.id, "supply.catalog.items.create", gameId]), recoveryKey, fingerprintRequest("supply.catalog.items.create", gameId, recoveryBody), {id:"restricted-race-result"}]);
      await maintenanceDataPool.query(`DELETE FROM zzsh_supply.admin_supply_scope WHERE admin_user_id = $1 AND game_id = $2`, [operator.id, gameId]);
      await gate.query("COMMIT");
      assert.equal((await pending).response.status, 404, "23505 recovery must reject revoked scope");
      assert.equal((await runtimePool.query(`SELECT count(*)::text AS count FROM zzsh_supply.billable_item WHERE code = 'recovery_race'`)).rows[0].count, "0", "losing business write rolled back");
    } finally { await gate.query("ROLLBACK"); gate.release(); }
    await runtimePool.query(`INSERT INTO zzsh_supply.admin_supply_scope (admin_user_id, game_id, granted_by_admin_id) VALUES ($1,$2,$3)`, [operator.id, gameId, boss.id]);

    const concurrentKey = `idem_${randomUUID().replaceAll("-", "")}`;
    const concurrentResults = await Promise.all([
      request(base, `/api/bff/admin/supply/games/${gameId}/items`, { code: "parallel_item", name: "并发物品", unit: "PIECE" }, operator.jar, ADMIN_ORIGIN, "POST", { "idempotency-key": concurrentKey }),
      request(base, `/api/bff/admin/supply/games/${gameId}/items`, { code: "parallel_item", name: "并发物品", unit: "PIECE" }, operator.jar, ADMIN_ORIGIN, "POST", { "idempotency-key": concurrentKey }),
    ]);
    const concurrentStatuses = concurrentResults.map((result) => result.response.status).sort((left, right) => left - right);
    assert.deepEqual(concurrentStatuses, [200, 200], JSON.stringify(concurrentResults.map((result) => result.body)));
    assert.equal(concurrentResults[0]!.body?.id, concurrentResults[1]!.body?.id);
    const parallelCount = await runtimePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_supply"."billable_item" WHERE "game_id" = $1 AND "code" = 'parallel_item'`, [gameId]);
    assert.equal(parallelCount.rows[0]?.count, "1");

    // 审计失败必须回滚业务写入
    const auditFailKey = `idem_${randomUUID().replaceAll("-", "")}`;
    await migrationPool.query(`REVOKE INSERT ON TABLE "zzsh_iam"."audit_event" FROM ${quotedIdentifier(resources.runtimeUser, "runtime user")}`);
    const auditFailed = await request(base, `/api/bff/admin/supply/games/${gameId}/items`, { code: "audit_rollback_item", name: "审计回滚物品", unit: "PIECE" }, operator.jar, ADMIN_ORIGIN, "POST", { "idempotency-key": auditFailKey });
    assert.equal(auditFailed.response.status, 500);
    const rolledBack = await runtimePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_supply"."billable_item" WHERE "game_id" = $1 AND "code" = 'audit_rollback_item'`, [gameId]);
    assert.equal(rolledBack.rows[0]?.count, "0");
    const idempotencyRolledBack = await runtimePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_supply"."idempotency_record" WHERE "key" = $1`, [auditFailKey]);
    assert.equal(idempotencyRolledBack.rows[0]?.count, "0");
    await migrationPool.query(`GRANT INSERT ON TABLE "zzsh_iam"."audit_event" TO ${quotedIdentifier(resources.runtimeUser, "runtime user")}`);

    // 封存后不可改
    const sealTerm = await request(base, `/api/bff/admin/supply/term-drafts/${termId}/seal`, { expectedRevision: "2" }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
    assert.equal(sealTerm.response.status, 200, JSON.stringify(sealTerm.body));
    const sealAgreement = await request(base, `/api/bff/admin/supply/agreement-drafts/${agreementId}/seal`, { expectedRevision: "1" }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
    assert.equal(sealAgreement.response.status, 200, JSON.stringify(sealAgreement.body));
    const sealPrice = await request(base, `/api/bff/admin/supply/price-drafts/${priceId}/seal`, { expectedRevision: "4" }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
    assert.equal(sealPrice.response.status, 200, JSON.stringify(sealPrice.body));
    const sealedEdit = await request(base, `/api/bff/admin/supply/price-drafts/${priceId}`, { expectedRevision: "5", haffRule: HAFF_RULE }, operator.jar, ADMIN_ORIGIN, "PUT", supplyKey());
    assert.equal(sealedEdit.response.status, 409, "sealed versions must reject edits");
    const sealedSql = await runtimePool.query(`UPDATE "zzsh_supply"."price_version" SET "haff_rule" = '{}'::jsonb WHERE "id" = $1`, [priceId]).then(() => null, (error: unknown) => error);
    assert.ok(sealedSql, "database trigger must keep sealed price versions immutable");
    const sealedLine = await runtimePool.query(`DELETE FROM "zzsh_supply"."price_line" WHERE "price_version_id" = $1`, [priceId]).then(() => null, (error: unknown) => error);
    assert.ok(sealedLine, "database trigger must keep sealed price version lines immutable");

    const repairDrafts = await drafts();
    await assert.rejects(() => runtimePool!.query(`UPDATE zzsh_supply.price_line SET price_version_id = $1 WHERE price_version_id = $2`, [repairDrafts.priceId, priceId]), { code: "40001" });
    await assert.rejects(() => runtimePool!.query(`UPDATE zzsh_supply.term_option SET version_id = $1 WHERE version_id = $2`, [repairDrafts.termId, termId]), { code: "40001" });
    const semantics = await request(base, `/api/bff/admin/supply/items/${haffItem}`, { unit: "PIECE" }, operator.jar, ADMIN_ORIGIN, "PUT", supplyKey());
    assert.equal(semantics.response.status, 409);
    await assert.rejects(() => runtimePool!.query(`UPDATE zzsh_supply.billable_item SET quantity_scale = 2 WHERE id = $1`, [haffItem]), { code: "40001" });
    const otherGame = await request(base, "/api/bff/admin/supply/games", { code: "other-game", name: "其他游戏" }, boss.jar, ADMIN_ORIGIN, "POST", supplyKey());
    await assert.rejects(() => runtimePool!.query(`UPDATE zzsh_supply.price_version SET game_id = $1 WHERE id = $2`, [otherGame.body?.game.id, repairDrafts.priceId]), { code: "40001" });
    const foreignItem = await request(base, `/api/bff/admin/supply/games/${otherGame.body?.game.id}/items`, {code:"foreign",name:"异游戏物品",unit:"PIECE"}, boss.jar, ADMIN_ORIGIN, "POST", supplyKey());
    await assert.rejects(() => runtimePool!.query(`INSERT INTO zzsh_supply.price_line (id,price_version_id,item_id,customer_tier,pricing_kind) VALUES ($1,$2,$3,'STANDARD','HAFF_RATIO')`, ["foreign_line",repairDrafts.priceId,foreignItem.body?.id]), /another game/);

    // Wait for the child to block on its parent, then seal before releasing the lock.
    assert.equal((await request(base, `/api/bff/admin/supply/term-drafts/${repairDrafts.termId}`, {expectedRevision:"1",options:[{code:"race",name:"race",dailyConsumption:"1"}]}, operator.jar, ADMIN_ORIGIN, "PUT", supplyKey())).response.status, 200);
    assert.equal((await request(base, `/api/bff/admin/supply/price-drafts/${repairDrafts.priceId}`, {expectedRevision:"1",haffRule:HAFF_RULE,roundingPolicy:"HALF_UP_CENT_V1",lines:[{itemId:haffItem,pricingKind:"HAFF_RATIO"}]}, operator.jar, ADMIN_ORIGIN, "PUT", supplyKey())).response.status, 200);
    for (const scenario of [
      {parent:"term_version",child:"term_option",fk:"version_id",id:repairDrafts.termId,column:"daily_consumption",next:"2",previous:"1"},
      {parent:"price_version",child:"price_line",fk:"price_version_id",id:repairDrafts.priceId,column:"item_id",next:roundItem,previous:haffItem},
    ]) {
      const sealer: PoolClient = await runtimePool.connect(); const mutator: PoolClient = await runtimePool.connect();
      try {
        await sealer.query("BEGIN");
        await sealer.query(`SELECT id FROM zzsh_supply.${scenario.parent} WHERE id = $1 FOR UPDATE`, [scenario.id]);
        const pid: number = (await mutator.query(`SELECT pg_backend_pid() AS pid`)).rows[0].pid;
        const mutation = mutator.query(`UPDATE zzsh_supply.${scenario.child} SET ${scenario.column} = $2 WHERE ${scenario.fk} = $1`, [scenario.id,scenario.next]).then(() => null, (error: unknown) => error);
        const deadline = Date.now() + 5000; let blocked = false;
        while (Date.now() < deadline && !blocked) blocked = (await sealer.query(`SELECT cardinality(pg_blocking_pids($1)) > 0 AS blocked`, [pid])).rows[0].blocked;
        assert.equal(blocked, true, "child mutation must lock the parent before checking seal state");
        await sealer.query(`UPDATE zzsh_supply.${scenario.parent} SET status = 'SEALED', sealed_at = clock_timestamp(), sealed_by_admin_id = $1 WHERE id = $2`, [boss.id, scenario.id]);
        await sealer.query("COMMIT");
        assert.equal((await mutation as {code:string}).code, "40001");
        assert.equal((await runtimePool.query(`SELECT ${scenario.column}::text AS value FROM zzsh_supply.${scenario.child} WHERE ${scenario.fk} = $1`, [scenario.id])).rows[0].value, scenario.previous);
      } finally { await sealer.query("ROLLBACK"); sealer.release(); mutator.release(); }
    }

    // Boss 原子生效与并发生效
    const activateViaBff = (jar: CookieJar, expectedGeneration = "0", targetAgreement = agreementId, key = supplyKey()): Promise<{ response: Response; body: Record<string, any> | null }> =>
      request(base, "/api/bff/admin/supply/releases", { gameId, priceVersionId: priceId, termVersionId: termId, agreementVersionId: targetAgreement, expectedGeneration }, jar, ADMIN_ORIGIN, "POST", key);
    const operatorActivate = await activateViaBff(operator.jar);
    assert.equal(operatorActivate.response.status, 403, "non-boss activation must be rejected");
    const firstActivation = await activateViaBff(boss.jar);
    assert.equal(firstActivation.response.status, 200, JSON.stringify(firstActivation.body));
    assert.equal(firstActivation.body?.generation, "1");
    await assert.rejects(() => runtimePool!.query(`UPDATE zzsh_supply.rule_release SET generation = 9 WHERE id = $1`, [firstActivation.body?.releaseId]), {code:"42501"});
    await assert.rejects(() => migrationPool!.query(`UPDATE zzsh_supply.rule_release SET generation = 9 WHERE id = $1`, [firstActivation.body?.releaseId]), {code:"40001"});
    const currentAfterFirst = await request(base, `/api/bff/admin/supply/games/${gameId}/rules`, undefined, operator.jar, ADMIN_ORIGIN);
    assert.equal(currentAfterFirst.body?.game.currentReleaseId, firstActivation.body?.releaseId, "activation must switch the current release in the same transaction");

    const otherAgreement = await request(base, "/api/bff/admin/supply/agreement-drafts", {gameId, title:"另一协议", body:"另一份合成协议"}, boss.jar, ADMIN_ORIGIN, "POST", supplyKey());
    assert.equal((await request(base, "/api/bff/admin/supply/agreement-drafts/" + otherAgreement.body?.id + "/seal", {expectedRevision:"1"}, boss.jar, ADMIN_ORIGIN, "POST", supplyKey())).response.status, 200);
    const racingKeys = [supplyKey(), supplyKey()];
    const racing = await Promise.all([activateViaBff(boss.jar, "1", agreementId, racingKeys[0]), activateViaBff(boss.jar, "1", otherAgreement.body?.id, racingKeys[1])]);
    const racingStatuses = racing.map((result) => result.response.status).sort((left, right) => left - right);
    assert.deepEqual(racingStatuses, [200, 409], JSON.stringify(racing.map((result) => result.body)));
    const generations = racing.filter((result) => result.response.status === 200).map((result) => result.body?.generation).sort();
    assert.deepEqual(generations, ["2"], "same generation must have one winner");
    const winner = racing.findIndex((r) => r.response.status === 200);
    const releaseReplay = await activateViaBff(boss.jar, "1", winner === 0 ? agreementId : otherAgreement.body?.id, racingKeys[winner]);
    assert.deepEqual(releaseReplay.body, racing[winner]!.body);
    assert.equal((await runtimePool.query('SELECT count(*)::text AS count FROM zzsh_supply.rule_release WHERE game_id = $1', [gameId])).rows[0].count, "2");
    const currentAfterRace = await request(base, `/api/bff/admin/supply/games/${gameId}/rules`, undefined, operator.jar, ADMIN_ORIGIN);
    assert.ok(racing.some((result) => result.body?.releaseId === currentAfterRace.body?.game.currentReleaseId));
    const sameActivationKey = supplyKey();
    const sameActivation = await Promise.all([activateViaBff(boss.jar, "2", agreementId, sameActivationKey), activateViaBff(boss.jar, "2", agreementId, sameActivationKey)]);
    assert.deepEqual(sameActivation.map((r) => r.response.status), [200,200]);
    assert.deepEqual(sameActivation[0]!.body, sameActivation[1]!.body);
    assert.equal(sameActivation[0]!.body?.generation, "3");

    // ---------- 媒体上传、审核、受权读取 ----------
    const intent = await request(base, "/api/bff/admin/supply/media/upload-intents", { gameId, purpose: "GAME_COVER", mime: "image/png", size: pngBytes().length }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
    assert.equal(intent.response.status, 200, JSON.stringify(intent.body));
    const coverAsset = await uploadBytes(base, `/api/bff/admin/supply/media/uploads/${intent.body?.intentId}`, operator.jar, ADMIN_ORIGIN, intent.body?.uploadToken as string);
    assert.equal(coverAsset.status, 200, JSON.stringify(coverAsset.body));
    const coverAssetId = coverAsset.body?.assetId as string;
    const unapprovedPublic = await request(base, `/api/v1/supply/media/${coverAssetId}/content`, undefined, cookieJar(), API_ORIGIN);
    assert.equal(unapprovedPublic.response.status, 404, "unapproved media must not be public");

    const rejectedReview = await request(base, `/api/bff/admin/supply/media/${coverAssetId}/review`, { decision: "REJECT", reason: "合成驳回" }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
    assert.equal(rejectedReview.response.status, 200);
    assert.equal(rejectedReview.body?.reviewState, "REJECTED");
    const bindRejected = await request(base, `/api/bff/admin/supply/games/${gameId}/cover`, { mediaId: coverAssetId }, operator.jar, ADMIN_ORIGIN, "PUT", supplyKey());
    assert.equal(bindRejected.response.status, 400, "rejected media must not be bindable");

    const approvedReview = await request(base, `/api/bff/admin/supply/media/${coverAssetId}/review`, { decision: "APPROVE", visibility: "PUBLIC_DISPLAY" }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
    assert.equal(approvedReview.response.status, 200, JSON.stringify(approvedReview.body));
    assert.equal(approvedReview.body?.accessClass, "PUBLIC_DISPLAY");
    const publicCover = await fetch(`${base}/api/v1/supply/media/${coverAssetId}/content`);
    assert.equal(publicCover.status, 200);
    assert.match(publicCover.headers.get("cache-control") ?? "", /public/);
    const publicBytes = Buffer.from(await publicCover.arrayBuffer());
    assert.equal((await sharp(publicBytes).metadata()).exif, undefined);
    assert.notDeepEqual(publicBytes, pngBytes());

    const revoked = await request(base, `/api/bff/admin/supply/media/${coverAssetId}/visibility`, { visibility: "PRIVATE_REVIEW", reason: "撤销公开" }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
    assert.equal(revoked.response.status, 200);
    const revokedPublic = await request(base, `/api/v1/supply/media/${coverAssetId}/content`, undefined, cookieJar(), API_ORIGIN);
    assert.equal(revokedPublic.response.status, 404, "revoked public access must fail immediately");
    const publicAgain = await request(base, `/api/bff/admin/supply/media/${coverAssetId}/visibility`, { visibility: "PUBLIC_DISPLAY" }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
    assert.equal(publicAgain.response.status, 200);

    const coverBound = await request(base, `/api/bff/admin/supply/games/${gameId}/cover`, { mediaId: coverAssetId }, operator.jar, ADMIN_ORIGIN, "PUT", supplyKey());
    assert.equal(coverBound.response.status, 200, JSON.stringify(coverBound.body));
    const coverOnSkin = await request(base, `/api/bff/admin/supply/skins/${skin}`, { mediaId: coverAssetId }, operator.jar, ADMIN_ORIGIN, "PUT", supplyKey());
    assert.equal(coverOnSkin.response.status, 400, "media purpose must match the binding");

    const mismatchedIntent = await request(base, "/api/bff/admin/supply/media/upload-intents", { gameId, purpose: "GAME_COVER", mime: "image/png", size: pngBytes().length }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
    const mismatched = await fetch(`${base}/api/bff/admin/supply/media/uploads/${mismatchedIntent.body?.intentId}`, {
      method: "PUT",
      headers: { origin: ADMIN_ORIGIN, "content-type": "image/jpeg", "x-upload-token": mismatchedIntent.body?.uploadToken as string, "idempotency-key": `idem_${randomUUID().replaceAll("-", "")}`, cookie: operator.jar.header() },
      body: new Uint8Array(jpegBytes()),
    });
    assert.equal(mismatched.status, 400, "declared MIME must match actual image bytes");

    const sizeIntent = await request(base, "/api/bff/admin/supply/media/upload-intents", { gameId, purpose: "GAME_COVER", mime: "image/png", size: pngBytes().length + 10 }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
    const sizeMismatch = await fetch(`${base}/api/bff/admin/supply/media/uploads/${sizeIntent.body?.intentId}`, {
      method: "PUT",
      headers: { origin: ADMIN_ORIGIN, "content-type": "image/png", "x-upload-token": sizeIntent.body?.uploadToken as string, "idempotency-key": `idem_${randomUUID().replaceAll("-", "")}`, cookie: operator.jar.header() },
      body: new Uint8Array(pngBytes()),
    });
    assert.equal(sizeMismatch.status, 400);

    storageAvailable = false;
    const unavailableIntent = await request(base, "/api/bff/admin/supply/media/upload-intents", { gameId, purpose: "GAME_COVER", mime: "image/png", size: pngBytes().length }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
    assert.equal(unavailableIntent.response.status, 503, "unconfigured storage must be explicitly unavailable");
    storageAvailable = true;

    // ---------- 用户供给材料与跨用户/跨 realm 拒绝 ----------
    const userOne = cookieJar();
    const signupOne = await request(base, "/api/auth/user/sign-up/email", { email: "m3b-user-1@example.invalid", password: "Sup3rSecret#One", name: "供给用户一", username: "m3b_user_1" }, userOne, USER_ORIGIN);
    assert.equal(signupOne.response.status, 200, JSON.stringify(signupOne.body));
    const accountCreated = await request(base, "/api/v1/supply/accounts", { gameId }, userOne, USER_ORIGIN, "POST", supplyKey());
    assert.equal(accountCreated.response.status, 200, JSON.stringify(accountCreated.body));
    const accountId = accountCreated.body?.accountId as string;

    const userTwo = cookieJar();
    const signupTwo = await request(base, "/api/auth/user/sign-up/email", { email: "m3b-user-2@example.invalid", password: "Sup3rSecret#Two", name: "供给用户二", username: "m3b_user_2" }, userTwo, USER_ORIGIN);
    assert.equal(signupTwo.response.status, 200);

    const foreignAccount = await request(base, "/api/v1/supply/media/upload-intents", { gameId, accountId, mime: "image/png", size: pngBytes().length }, userTwo, USER_ORIGIN, "POST", supplyKey());
    assert.equal(foreignAccount.response.status, 404, "users must not upload against another user's account");

    const legacyIntentKey=supplyKey();
    const userIntent = await request(base, "/api/v1/supply/media/upload-intents", { gameId, accountId, mime: "image/png", size: pngBytes().length }, userOne, USER_ORIGIN, "POST", legacyIntentKey);
    assert.equal((await runtimePool.query(`SELECT request_fingerprint FROM zzsh_supply.idempotency_record WHERE key=$1`,[legacyIntentKey["idempotency-key"]])).rows[0].request_fingerprint,fingerprintRequest("supply.media.upload_intent.create",undefined,{gameId,accountId,mime:"image/png",size:pngBytes().length}),"default evidence intent preserves the M3-B fingerprint");
    assert.equal(userIntent.response.status, 200, JSON.stringify(userIntent.body));
    const userAsset = await uploadBytes(base, `/api/v1/supply/media/uploads/${userIntent.body?.intentId}`, userOne, USER_ORIGIN, userIntent.body?.uploadToken as string);
    assert.equal(userAsset.status, 200, JSON.stringify(userAsset.body));
    assert.equal(userAsset.body?.ownershipKind, "USER_SUPPLY");
    const userAssetId = userAsset.body?.assetId as string;

    const ownerAccess = await fetch(`${base}/api/v1/supply/media/${userAssetId}/access`, { headers: { cookie: userOne.header() } });
    assert.equal(ownerAccess.status, 200, "the owner must be able to read their private material");
    assert.deepEqual(Buffer.from(await ownerAccess.arrayBuffer()), pngBytes());
    assert.match(ownerAccess.headers.get("cache-control") ?? "", /no-store/);
    const strangerAccess = await request(base, `/api/v1/supply/media/${userAssetId}/access`, undefined, userTwo, USER_ORIGIN);
    assert.equal(strangerAccess.response.status, 404, "another user must not read private material");
    const anonymousAccess = await request(base, `/api/v1/supply/media/${userAssetId}/access`, undefined, cookieJar(), USER_ORIGIN);
    assert.equal(anonymousAccess.response.status, 401);
    const adminContent = await fetch(`${base}/api/bff/admin/supply/media/${userAssetId}/content`, { headers: { origin: ADMIN_ORIGIN, cookie: operator.jar.header() } });
    assert.equal(adminContent.status, 200, "reviewers with object scope can read private material");
    const unscopedContent = await request(base, `/api/bff/admin/supply/media/${userAssetId}/content`, undefined, unscoped.jar, ADMIN_ORIGIN);
    assert.equal(unscopedContent.response.status, 403, "catalog permission alone must not read private evidence");
    const userAdminRoute = await request(base, "/api/v1/admin/supply/media/reviews", undefined, userOne, USER_ORIGIN);
    assert.equal(userAdminRoute.response.status, 401, "the admin realm must not accept user sessions");
    const adminUserRoute = await request(base, "/api/v1/supply/media/upload-intents", { gameId, accountId, mime: "image/png", size: pngBytes().length }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
    assert.equal(adminUserRoute.response.status, 401, "the user realm must not accept admin sessions");
    const bindUserAsset = await request(base, `/api/bff/admin/supply/games/${gameId}/cover`, { mediaId: userAssetId }, operator.jar, ADMIN_ORIGIN, "PUT", supplyKey());
    assert.equal(bindUserAsset.response.status, 400, "user evidence must not be bound as a platform cover");
    const userApproved = await request(base, `/api/bff/admin/supply/media/${userAssetId}/review`, { decision: "APPROVE", visibility: "PUBLIC_DISPLAY" }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
    assert.equal(userApproved.response.status, 400, "user evidence must not become public display media");
    const userApprovedPrivate = await request(base, `/api/bff/admin/supply/media/${userAssetId}/review`, { decision: "APPROVE" }, operator.jar, ADMIN_ORIGIN, "POST", supplyKey());
    assert.equal(userApprovedPrivate.response.status, 200);

    // 目录游标绑定 catalogRevision：目录变化后旧游标拒绝
    const staleCursor = pagedCatalog.body?.nextCursor as string;
    const catalogChanged = await request(base, `/api/bff/admin/supply/games/${gameId}`, { expectedRevision: (await request(base, `/api/bff/admin/supply/games/${gameId}/catalog`, undefined, operator.jar, ADMIN_ORIGIN)).body?.game.catalogRevision, name: "三角洲行动（更名）" }, operator.jar, ADMIN_ORIGIN, "PUT", supplyKey());
    assert.equal(catalogChanged.response.status, 200, JSON.stringify(catalogChanged.body));
    const staleRead = await request(base, `/api/v1/supply/games/${gameId}/catalog?cursor=${encodeURIComponent(staleCursor)}&limit=1`, undefined, cookieJar(), API_ORIGIN);
    assert.equal(staleRead.response.status, 409, "cursors must be invalidated when the catalog revision changes");

    await runPublishingChecks({testContext,readProbe,userOrigin:USER_ORIGIN,adminOrigin:ADMIN_ORIGIN,evidenceAssetId:userAssetId,base,pool:runtimePool,maintenance:maintenanceDataPool,migration:migrationPool,runtimeUser:resources.runtimeUser,gameId,accountId,itemId:haffItem,user:userOne,stranger:userTwo,boss:boss.jar,bossId:boss.id,operator:operator.jar,operatorId:operator.id,bytes:pngBytes(),gates:publicationGates});
    await runSupplyPoolChecks({testContext,pool:runtimePool,maintenance:maintenanceDataPool,auth:authOptions,user:userOne,boss:boss.jar,bossId:boss.id,accountId,gameId,bytes:pngBytes()});
    await runMediaOssChecks({base,pool:runtimePool,maintenance:maintenanceDataPool,operator:{jar:operator.jar,id:operator.id},boss:{jar:boss.jar,id:boss.id},gameId,itemId:haffItem,mediaDir,faults:storageFaults});
    const auditCount = await runtimePool.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_iam"."audit_event" WHERE "action" LIKE 'supply.%'`);
    assert.ok(Number(auditCount.rows[0]?.count ?? "0") >= 20, "supply writes must be audited");
    const audits = (await runtimePool.query(`SELECT object_type, object_id, action, reason, details FROM zzsh_iam.audit_event WHERE action LIKE 'supply.%'`)).rows;
    assert.ok(audits.every((a) => a.object_id && a.object_type !== "supply_object" && a.reason && a.details.after && a.details.result));
    const renamedAudit = audits.find((a) => a.object_id === skin && a.action === "supply.catalog.entry_updated" && a.details.after.name === "M4A1 金色（改名）");
    assert.equal(renamedAudit?.details.before.name, "M4A1 金色");
    const priceAudit = audits.find((a) => a.object_id === priceId && a.details.after?.revision === "2");
    assert.equal(priceAudit?.details.before.revision, "1");
    assert.equal(priceAudit?.details.after.lines.find((l: any) => l.item_id === roundItem).buyer_unit_amount, "2.50000000");
    const rejectedAudit = audits.find((a) => a.object_id === coverAssetId && a.details.after?.review_state === "REJECTED");
    assert.equal(rejectedAudit?.details.before.review_state, "PENDING");
    assert.equal(rejectedAudit?.reason, "合成驳回");
    assert.equal(audits.some((a) => a.object_id === firstActivation.body?.releaseId && a.details.before.current_release_id === null && a.details.after.generation === "1"), true);
    assert.equal(JSON.stringify(audits).includes("uploadToken"), false);
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
    try { await rm(mediaDir, { recursive: true, force: true }); } catch (error) { cleanupErrors.push(error); }
    if (cleanupErrors.length > 0) throw cleanupErrors[0];
  }
});
