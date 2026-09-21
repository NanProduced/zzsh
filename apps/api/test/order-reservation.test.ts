import { ISOLATED_BUSINESS_DATA_TRUNCATE } from "./database-test-support";
import type { SupplyGate } from "../src/supply/publishing";
import sharp from "sharp";
import { strict as assert } from "node:assert";
import { createHash, createHmac, randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";

import { createApp } from "../src/app";
import { loadAuthRuntimeConfig } from "../src/auth/auth-runtime";
import { createFakeRealNameProvider } from "../src/auth/user-identity";
import { withTransaction } from "../src/auth/security-core";
import { loadConfig, type AppConfig } from "../src/config/config";
import { assertBusinessRuntimeIdentity, createBusinessPool } from "../src/database/business";
import { runBusinessMigrations } from "../src/database/business-migrations";
import { computeDeltaQuote } from "../src/supply/pricing";
import { computeContentHash, normalizeContentPayload } from "../src/supply/content-hash";
import { composeSupplyGateWithOrderOccupancy, OrderSweepWorker, sweepExpiredHolds, type SweepResult } from "../src/order/order";
import { runPaymentAcceptance } from "./order-payment-im-postgres.test";
import { runDispatchAcceptance } from "./order-dispatch-postgres.test";
import { runOrderTeamAcceptance } from "./order-team-postgres.test";
import { ORDER_IM_EVENT_APP, ORDER_IM_EVENT_SECRET, preparePartialMigrationsFolder, runOrderFirstResponseAcceptance } from "./order-first-response-postgres.test";

// M4-A order reservation foundation: real PostgreSQL acceptance (V01–V21).
// Deterministic barriers only; no sleeps to guess races.

// PC-1 reuses its one explicitly registered supply resource for legacy order regression.
const PRICING_COMPAT = process.env.SUPPLY_TEST_RESOURCE_SET === "pricing_compat";
if (PRICING_COMPAT && process.env.ORDER_TEST_RESOURCE_SET) throw new Error("Conflicting order/supply resource selection");
const RESOURCE_SET = PRICING_COMPAT ? "pricing_compat" : process.env.ORDER_TEST_RESOURCE_SET?.trim() || "";
const ROLE_PREFIX = PRICING_COMPAT ? "zzsh_m3b_" : "zzsh_order_";
if (RESOURCE_SET && !/^[a-z][a-z0-9_]{0,20}$/.test(RESOURCE_SET)) throw new Error("Invalid order test resource set");
const DEFAULT_DATABASE = PRICING_COMPAT ? "zzsh_test_supply_pricing_compat" : RESOURCE_SET ? "zzsh_test_order_" + RESOURCE_SET : "zzsh_test_order_reservation";
const RESOURCE_MARKER = PRICING_COMPAT ? "zzsh:m3b-supply-test:v1" : "zzsh:order-reservation-test:v1";
const LOCK_KEY = PRICING_COMPAT ? "1001320784187617071" : RESOURCE_SET
  ? (BigInt("0x" + createHash("sha256").update("order-test:" + RESOURCE_SET).digest("hex").slice(0, 15)) + 2000000n).toString()
  : "805021";
const USER_ORIGIN = "http://127.0.0.1:3100";
const ADMIN_ORIGIN = "http://127.0.0.1:3101";
const API_ORIGIN = "http://127.0.0.1:3102";
const BUSINESS_SCHEMAS = ["zzsh_business_meta", "zzsh_iam", "zzsh_auth_user", "zzsh_auth_admin", "zzsh_supply", "zzsh_content", "zzsh_order"] as const;
const HOLD_SECONDS = 3600;
const HAFF_RULE = {
  schema: "haff-ratio-v1",
  baseBySafeBox: { "box-a": "50" },
  vitalityDeltaByLevel: { "6": "0" },
  bearDeltaByLevel: { "6": "0" },
  dailyDeltaByTermOption: { "daily-10m": "0" },
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
  const databaseName = process.env.ORDER_TEST_DB_NAME?.trim() || DEFAULT_DATABASE;
  assert.notEqual(databaseName, "zzsh_dev");
  const migrationUser = safeIdentifier(process.env.ORDER_TEST_MIGRATION_USER?.trim() || (RESOURCE_SET ? ROLE_PREFIX + RESOURCE_SET + "_m" : "zzsh_order_migration"), "migration user");
  const runtimeUser = safeIdentifier(process.env.ORDER_TEST_RUNTIME_USER?.trim() || (RESOURCE_SET ? ROLE_PREFIX + RESOURCE_SET + "_r" : "zzsh_order_runtime"), "runtime user");
  assert.notEqual(migrationUser, runtimeUser);
  if (RESOURCE_SET) {
    assert.equal(databaseName, DEFAULT_DATABASE);
    assert.equal(migrationUser, ROLE_PREFIX + RESOURCE_SET + "_m");
    assert.equal(runtimeUser, ROLE_PREFIX + RESOURCE_SET + "_r");
  }
  if (!migrationUser.startsWith(ROLE_PREFIX) || !runtimeUser.startsWith(ROLE_PREFIX)) throw new Error("order test role prefix mismatch");
  const maintenanceUser = process.env.ORDER_TEST_MAINTENANCE_USER ?? process.env.DB_USER;
  const baseEnv = {
    ...process.env,
    APP_PROFILE: "test",
    PROVIDER_MODE: "fake",
    DB_TARGET: "local-compose",
    DB_NAME: databaseName,
    ...(maintenanceUser ? { DB_USER: maintenanceUser } : {}),
  };
  const maintenance = loadConfig(baseEnv);
  const migrationPassword = process.env.ORDER_TEST_MIGRATION_PASSWORD?.trim() || randomBytes(32).toString("hex");
  const runtimePassword = process.env.ORDER_TEST_RUNTIME_PASSWORD?.trim() || randomBytes(32).toString("hex");
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
    assert.equal((await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [LOCK_KEY])).rows[0]?.acquired, true, "dedicated order test target is already in use");
    // Complete read-only preflight BEFORE either ensureRole can change a password.
    const db = (await client.query(`SELECT pg_get_userbyid(datdba) AS owner,
      shobj_description(oid,'pg_database') AS marker FROM pg_database WHERE datname=$1`, [resources.databaseName])).rows[0];
    if (RESOURCE_SET === "yunxin_main_integrate" || PRICING_COMPAT) {
      assert.equal(resources.maintenance.database.user, "zzsh");
      assert.ok(db, "registered OIM database must already exist");
    }
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
      if (RESOURCE_SET === "yunxin_main_integrate" || PRICING_COMPAT) assert.ok(row, "registered role must already exist");
      if (!row) continue;
      assert.deepEqual(row, { rolcanlogin: true, rolsuper: false, rolcreaterole: false, rolcreatedb: false,
        rolinherit: false, rolreplication: false, rolbypassrls: false, marker: roleMarker(resources.databaseName, kind), membership: false, owns_db: false });
    }
    console.log("order resource preflight PASS", resources.databaseName, LOCK_KEY);
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

/** Truncate the isolated business tables, tolerating a target that predates im_order_event. */
async function truncateIsolatedBusinessData(pool: Pool): Promise<void> {
  const relation = (await pool.query(`SELECT to_regclass('zzsh_order.im_order_event') AS relation`)).rows[0]?.relation;
  const statement = relation ? ISOLATED_BUSINESS_DATA_TRUNCATE : ISOLATED_BUSINESS_DATA_TRUNCATE.replace(/\s*"zzsh_order"\."im_order_event",/, "");
  await pool.query(statement);
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
  return { id: session.body?.adminUserId as string, username, jar, password, secret };
}

function twoPartyBarrier() {
  let arrived = 0;
  let resolveArrived!: () => void;
  let resolveOpen!: () => void;
  const allArrived = new Promise<void>((resolve) => (resolveArrived = resolve));
  const gate = new Promise<void>((resolve) => (resolveOpen = resolve));
  const watchdog = setTimeout(() => {
    resolveArrived();
    resolveOpen();
  }, 15_000);
  return {
    arrive: async () => {
      arrived += 1;
      if (arrived === 2) resolveArrived();
      await gate;
    },
    waitAllArrived: async () => allArrived,
    open: () => {
      clearTimeout(watchdog);
      resolveOpen();
    },
  };
}

/**
 * Single-arrival gate for driver-vs-create races: the create arrives inside its
 * gate read and waits; the test driver waits for that single arrival, performs
 * the competing write, then opens the gate. The watchdog converts a missing
 * arrival into a visible assertion failure instead of an infinite hang.
 */
function singleArrivalGate() {
  let resolveArrived!: () => void;
  let resolveOpen!: () => void;
  const arrived = new Promise<void>((resolve) => (resolveArrived = resolve));
  const gate = new Promise<void>((resolve) => (resolveOpen = resolve));
  const watchdog = setTimeout(() => {
    resolveArrived();
    resolveOpen();
  }, 15_000);
  return {
    arrive: async () => {
      resolveArrived();
      await gate;
    },
    waitArrived: async () => arrived,
    open: () => {
      clearTimeout(watchdog);
      resolveOpen();
    },
  };
}

let pngFixture = Buffer.alloc(0);

test(PRICING_COMPAT ? "PC1 legacy V01–V21 order regression (no payment/IM workers)" : "M4-A V01–V21 and OIM-2A payment acceptance", async (t) => {
  let resources: Resources | undefined;
  let maintenancePool: Pool | undefined;
  let maintenanceDataPool: Pool | undefined;
  let migrationPool: Pool | undefined;
  let runtimePool: Pool | undefined;
  let guard: PoolClient | undefined;
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  let smallApp: Awaited<ReturnType<typeof createApp>> | undefined;
  let smallPool: Pool | undefined;
  let runtimeClosedByApp = false;
  let smallClosedByApp = false;
  let fixturesStarted = false;
  const publicationGates = new Map<string, SupplyGate>();
  const probeWatched = new Set<string>();
  const probe: { run?: (accountId: string) => Promise<void> } = {};
  try {
    resources = makeResources();
    pngFixture = await sharp({ create: { width: 64, height: 64, channels: 3, background: "blue" } }).png().toBuffer();
    maintenancePool = poolFor(resources.maintenance, "postgres", "zzsh-order-maintenance", 2);
    guard = await resourceGuard(maintenancePool, resources);
    await ensureDatabase(maintenancePool, resources);
    await ensureRole(maintenancePool, resources.migrationUser, resources.migrationPassword, roleMarker(resources.databaseName, "migration"));
    await ensureRole(maintenancePool, resources.runtimeUser, resources.runtimePassword, roleMarker(resources.databaseName, "runtime"));
    await grantDatabaseAccess(maintenancePool, resources);
    maintenanceDataPool = poolFor(resources.maintenance, resources.databaseName, "zzsh-order-owner", 2);
    await prepareOwnership(maintenanceDataPool, resources);
    migrationPool = createBusinessPool(resources.migration);
    const hasJournal = (await migrationPool.query(`SELECT to_regclass('zzsh_business_meta.migrations') AS name`)).rows[0].name;
    const migrationBefore = hasJournal ? (await migrationPool.query(`SELECT count(*)::int AS n, max(created_at)::text AS latest FROM zzsh_business_meta.migrations`)).rows[0] : { n: 0, latest: null };
    // The OIM-4B resource stages its pending tail on a lower baseline so the suite can seed
    // legacy rows first and then apply each migration as a real increment. An already-migrated
    // resource is reused as-is: no drop, no replay from zero, no false staged claim.
    const stagedFirstResponse = RESOURCE_SET === "oim_first_response";
    const baselineCount = Number(migrationBefore.n ?? 0);
    // A fresh resource stages up to 0042 before legacy fixtures; an existing one only refreshes
    // grants (its journal tail is already applied), so the suite never drops or replays from zero.
    const stageUpTo = baselineCount < 43 ? 42 : baselineCount - 1;
    const partialMigrationsFolder = stagedFirstResponse ? preparePartialMigrationsFolder(stageUpTo) : undefined;
    await runBusinessMigrations(migrationPool, { runtimeUser: resources.runtimeUser, ...(partialMigrationsFolder ? { migrationsFolder: partialMigrationsFolder } : {}) });
    const migrated = (await migrationPool.query(`SELECT hash,created_at::text FROM zzsh_business_meta.migrations ORDER BY created_at`)).rows;
    if (!stagedFirstResponse) {
      await runBusinessMigrations(migrationPool, { runtimeUser: resources.runtimeUser });
      assert.deepEqual((await migrationPool.query(`SELECT hash,created_at::text FROM zzsh_business_meta.migrations ORDER BY created_at`)).rows, migrated);
    }
    console.log("order migration evidence", JSON.stringify({ before: migrationBefore, afterCount: migrated.length, stagedFirstResponse, baselineCount, tail: migrated.slice(-2), replayUnchanged: !stagedFirstResponse }));
    runtimePool = createBusinessPool(resources.runtime);
    await assertBusinessRuntimeIdentity(runtimePool, resources.runtime);
    // The staged OIM-4B run reaches this point before 0043 creates im_order_event.
    await truncateIsolatedBusinessData(maintenanceDataPool);
    fixturesStarted = true;
    // B6 deliberately jumps this sequence to 999998 later. Reset the isolated
    // fixture sequence first so a repeat run cannot collide with that range.
    await maintenanceDataPool.query(`SELECT setval('zzsh_order.display_no_seq', 1, false)`);
    assert.equal(
      (await runtimePool.query(`SELECT to_regclass('zzsh_order.rental_order') IS NOT NULL AS exists`)).rows[0]?.exists,
      true,
      "order schema must be migrated",
    );
    const deadlocksBefore = Number(
      (await maintenanceDataPool.query(`SELECT deadlocks FROM pg_stat_database WHERE datname = $1`, [resources.databaseName])).rows[0]?.deadlocks ?? "0",
    );

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
      // Explicit synthetic supplier-event ingress for OIM-4B; never reads a real AppSecret.
      // No approval/freshness windows are passed: the mounted default path is what runs.
      // The periodic sweep is pushed out so deterministic recovery tests own their own calls.
      orderImEvents: { appKey: ORDER_IM_EVENT_APP, appSecret: ORDER_IM_EVENT_SECRET, recoveryIntervalMs: 3_600_000 },
      realNameProvider: createFakeRealNameProvider("VERIFIED_ADULT"),
      orderHoldSeconds: HOLD_SECONDS,
      // Fixture: no further obligations beyond the composed supply/order checks.
      userObligationReader: async () => "NONE" as const,
      testSupplyGateReader: async (_client: PoolClient, account: { id: string }): Promise<SupplyGate> => {
        if (probeWatched.has(account.id)) await probe.run?.(account.id);
        return publicationGates.get(account.id) ?? { publisherBail: "SATISFIED", occupancy: "FREE", reference: "fixture:order-bail" };
      },
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
    const bootstrap = await request(base, "/api/v1/admin/security/bootstrap", { bootstrapSecret, name: "订单 Boss", password: bossPassword }, cookieJar(), ADMIN_ORIGIN);
    assert.equal(bootstrap.response.status, 200);
    const boss = await activateStaff(base, bootstrap.body?.username as string, bossPassword);
    const createStaff = async (name: string, allowPermissions: string[]): Promise<Staff> => {
      const created = await request(base, "/api/v1/admin/security/admins/create", { name, allowPermissions }, boss.jar, ADMIN_ORIGIN);
      assert.equal(created.response.status, 200, JSON.stringify(created.body));
      return activateStaff(base, created.body?.username as string, created.body?.temporaryPassword as string);
    };
    const operator = await createStaff("订单供给运营", [
      "supply.catalog.manage",
      "supply.rules.edit",
      "supply.rules.activate",
      "supply.review.read",
      "supply.review.decide",
      "supply.quote.internal.read",
    ]);
    const orderViewer = await createStaff("受权订单查询员", ["order.read"]);
    const noScopeViewer = await createStaff("无范围订单查询员", ["order.read"]);
    const noPermStaff = await createStaff("无权限管理员", []);

    const signupUser = async (name: string, username: string): Promise<CookieJar> => {
      const jar = cookieJar();
      const signup = await request(base, "/api/auth/user/sign-up/email", { email: `${username}@example.invalid`, password: "Sup3rSecret#Order", name, username }, jar, USER_ORIGIN);
      assert.equal(signup.response.status, 200, JSON.stringify(signup.body));
      const verify = await request(base, "/api/auth/user/identity/verify", { fullName: name, documentNumber: "110101199001010000" }, jar, USER_ORIGIN);
      assert.equal(verify.response.status, 200, JSON.stringify(verify.body));
      return jar;
    };

    // ---------- 游戏目录与规则 release gen1 ----------
    const createdGame = await request(base, "/api/bff/admin/supply/games", { code: "delta", name: "三角洲行动", description: "合成测试游戏" }, boss.jar, ADMIN_ORIGIN, "POST", orderKey());
    assert.equal(createdGame.response.status, 200, JSON.stringify(createdGame.body));
    const gameId = createdGame.body?.game?.id as string;
    await runtimePool.query(`INSERT INTO zzsh_supply.admin_supply_scope (admin_user_id, game_id, granted_by_admin_id) VALUES ($1, $2, $3)`, [operator.id, gameId, boss.id]);
    await runtimePool.query(`INSERT INTO zzsh_supply.admin_supply_scope (admin_user_id, game_id, granted_by_admin_id) VALUES ($1, $2, $3)`, [orderViewer.id, gameId, boss.id]);
    const createEntry = async (kind: string, body: Record<string, unknown>): Promise<string> => {
      const created = await request(base, `/api/bff/admin/supply/games/${gameId}/${kind}`, body, operator.jar, ADMIN_ORIGIN, "POST", orderKey());
      assert.equal(created.response.status, 200, JSON.stringify(created.body));
      return created.body?.id as string;
    };
    const haffItem = await createEntry("items", { code: "haff_base", name: "哈夫币", unit: "HAFF_BASE", required: true });

    const makeRuleSet = async (generation: string): Promise<{ releaseId: string; generation: string }> => {
      const price = await request(base, "/api/bff/admin/supply/price-drafts", { gameId, mode: "SPREAD" }, operator.jar, ADMIN_ORIGIN, "POST", orderKey());
      assert.equal(price.response.status, 200, JSON.stringify(price.body));
      const priceId = price.body?.id as string;
      const term = await request(base, "/api/bff/admin/supply/term-drafts", { gameId }, operator.jar, ADMIN_ORIGIN, "POST", orderKey());
      const termId = term.body?.id as string;
      const agreement = await request(base, "/api/bff/admin/supply/agreement-drafts", { gameId, title: "三角洲出租协议", body: "合成协议正文，仅用于隔离测试。" }, operator.jar, ADMIN_ORIGIN, "POST", orderKey());
      const agreementId = agreement.body?.id as string;
      assert.equal((await request(base, `/api/bff/admin/supply/price-drafts/${priceId}`, {
        expectedRevision: "1",
        haffRule: HAFF_RULE,
        roundingPolicy: "HALF_UP_CENT_V1",
        lines: [{ itemId: haffItem, pricingKind: "HAFF_RATIO" }],
      }, operator.jar, ADMIN_ORIGIN, "PUT", orderKey())).response.status, 200);
      assert.equal((await request(base, `/api/bff/admin/supply/term-drafts/${termId}`, {
        expectedRevision: "1",
        options: [{ code: "daily-10m", name: "日消耗 10M", dailyConsumption: "10000000" }],
      }, operator.jar, ADMIN_ORIGIN, "PUT", orderKey())).response.status, 200);
      assert.equal((await request(base, `/api/bff/admin/supply/price-drafts/${priceId}/seal`, { expectedRevision: "2" }, operator.jar, ADMIN_ORIGIN, "POST", orderKey())).response.status, 200);
      assert.equal((await request(base, `/api/bff/admin/supply/term-drafts/${termId}/seal`, { expectedRevision: "2" }, operator.jar, ADMIN_ORIGIN, "POST", orderKey())).response.status, 200);
      assert.equal((await request(base, `/api/bff/admin/supply/agreement-drafts/${agreementId}/seal`, { expectedRevision: "1" }, operator.jar, ADMIN_ORIGIN, "POST", orderKey())).response.status, 200);
      const activation = await request(base, "/api/bff/admin/supply/releases", { gameId, priceVersionId: priceId, termVersionId: termId, agreementVersionId: agreementId, expectedGeneration: generation }, boss.jar, ADMIN_ORIGIN, "POST", orderKey());
      assert.equal(activation.response.status, 200, JSON.stringify(activation.body));
      return { releaseId: activation.body?.releaseId as string, generation: activation.body?.generation as string };
    };
    await makeRuleSet("0");

    // ---------- 发布一个已审核公开账号（可注入明确押金 fixture） ----------
    const publishApproved = async (
      owner: CookieJar,
      label: string,
      depositCents: string | null,
    ): Promise<{ accountId: string; versionId: string; releaseId: string }> => {
      const created = await request(base, "/api/v1/supply/accounts", { gameId }, owner, USER_ORIGIN, "POST", orderKey());
      assert.equal(created.response.status, 200, JSON.stringify(created.body));
      const accountId = created.body?.accountId as string;
      const prefix = `/api/v1/supply/accounts/${accountId}`;
      let d = await request(base, `${prefix}/drafts`, { expectedRevision: "1" }, owner, USER_ORIGIN, "POST", orderKey());
      assert.equal(d.response.status, 200, JSON.stringify(d.body));
      const intent = await request(base, "/api/v1/supply/media/upload-intents", { gameId, accountId, mime: "image/png", size: pngFixture.length, purpose: "ACCOUNT_DISPLAY" }, owner, USER_ORIGIN, "POST", orderKey());
      assert.equal(intent.response.status, 200, JSON.stringify(intent.body));
      const upload = await fetch(`${base}/api/v1/supply/media/uploads/${intent.body?.intentId}`, {
        method: "PUT",
        headers: { origin: USER_ORIGIN, cookie: owner.header(), "content-type": "image/png", "x-upload-token": intent.body?.uploadToken as string, "idempotency-key": `up_${randomUUID()}` },
        body: new Uint8Array(pngFixture),
      });
      assert.equal(upload.status, 200);
      const asset = (await upload.json()) as { assetId: string };
      assert.equal((await request(base, `/api/bff/admin/supply/media/${asset.assetId}/review`, { decision: "APPROVE", visibility: "PUBLIC_DISPLAY" }, operator.jar, ADMIN_ORIGIN, "POST", orderKey())).response.status, 200);
      d = await request(base, `${prefix}/draft`, {
        expectedRevision: d.body?.account.revision,
        title: `三角洲 · ${label}`,
        description: "合成申报，不代表平台已登录验号",
        attributes: { safe_box_code: "box-a", vit_level: 6, bear_level: 6 },
        termOptionCode: "daily-10m",
        pricingOptionCode: "standard",
        inventory: [{ itemId: haffItem, quantity: "60000000" }],
        skins: [],
        entitlements: [],
        mediaBindings: [{ assetId: asset.assetId, position: 0 }],
      }, owner, USER_ORIGIN, "PUT", orderKey());
      assert.equal(d.response.status, 200, JSON.stringify(d.body));
      d = await request(base, `${prefix}/quote`, { expectedRevision: d.body?.account.revision }, owner, USER_ORIGIN, "POST", orderKey());
      assert.equal(d.response.status, 200, JSON.stringify(d.body));
      const versionId = d.body?.version.id as string;
      let contentHash = d.body?.version.contentHash as string;
      const releaseId = d.body?.version.releaseId as string;
      if (depositCents !== null) {
        // Isolated fixture: rebuild the persisted quote with an explicit deposit
        // using the production compute/normalize/hash functions, then re-accept.
        const stored = (await runtimePool!.query<{ payload: any }>(`SELECT payload FROM zzsh_supply.listing_version WHERE id = $1`, [versionId])).rows[0]!.payload;
        const recomputed = computeDeltaQuote({
          priceVersionId: stored.quoteValues.priceVersionId,
          mode: "SPREAD",
          roundingPolicy: "HALF_UP_CENT_V1",
          haffRule: HAFF_RULE,
          lines: [{ itemId: haffItem, quantity: "60000000", pricingKind: "HAFF_RATIO" }],
          conditions: { safeBoxCode: "box-a", vitLevel: 6, bearLevel: 6, termOptionCode: "daily-10m", pricingOptionCode: "standard" },
          termOption: { code: "daily-10m", dailyConsumption: "10000000", durationRounding: "CEIL_DAY" },
          entitlements: [],
          deposits: { tenantDepositCents: depositCents, publisherBailRequirementCents: "0" },
        });
        assert.equal(recomputed.quotable, true, JSON.stringify(recomputed));
        if (!recomputed.quotable) throw new Error("fixture quote failed");
        recomputed.quote.ruleReleaseId = releaseId;
        const payload = normalizeContentPayload({
          schemaVersion: 1,
          accountId,
          gameId,
          declaration: stored.declaration,
          ruleRefs: stored.ruleRefs,
          quoteValues: recomputed.quote as unknown as Record<string, unknown>,
        });
        contentHash = computeContentHash(payload);
        await runtimePool!.query(`UPDATE zzsh_supply.listing_version SET payload = $2, content_hash = $3 WHERE id = $1`, [versionId, payload, contentHash]);
      }
      d = await request(base, `${prefix}/accept-rules`, { expectedRevision: d.body?.account.revision, versionId, releaseId, contentHash }, owner, USER_ORIGIN, "POST", orderKey());
      assert.equal(d.response.status, 200, JSON.stringify(d.body));
      d = await request(base, `${prefix}/submit`, { expectedRevision: d.body?.account.revision, versionId, releaseId, contentHash }, owner, USER_ORIGIN, "POST", orderKey());
      assert.equal(d.response.status, 200, JSON.stringify(d.body));
      const decided = await request(base, `/api/bff/admin/supply/listing-reviews/${accountId}/decide`, { expectedRevision: d.body?.account.revision, versionId, releaseId, contentHash, decision: "APPROVE", reason: "合成通过" }, operator.jar, ADMIN_ORIGIN, "POST", orderKey());
      assert.equal(decided.response.status, 200, JSON.stringify(decided.body));
      const publicDetail = await request(base, `/api/v1/supply/listings/${accountId}`, undefined, cookieJar(), API_ORIGIN);
      assert.equal(publicDetail.response.status, 200, `listing ${accountId} must be public: ${JSON.stringify(publicDetail.body)}`);
      return { accountId, versionId, releaseId };
    };

    const createOrder = async (
      jar: CookieJar,
      target: { accountId: string; versionId: string; releaseId: string },
      key = orderKey(),
    ) => request(base, "/api/v1/orders", { accountId: target.accountId, versionId: target.versionId, releaseId: target.releaseId }, jar, USER_ORIGIN, "POST", key);

    const cloneOrderOnAccount = async (sourceOrderId: string, offsetSeconds: number): Promise<string> => {
      const newId = `order_${randomUUID().replaceAll("-", "")}`;
      const cloned = await runtimePool!.query(
        `INSERT INTO zzsh_order.rental_order (
           id, display_no, account_id, listing_version_id, owner_user_id, renter_user_id, game_id,
           rule_release_id, content_hash, term_option_code, status,
           rental_amount_cents, deposit_amount_cents, currency, term_seconds,
           quote_snapshot, title, hold_until)
         SELECT $1,
                zzsh_order.next_display_no(),
                account_id, listing_version_id, owner_user_id, renter_user_id, game_id,
                rule_release_id, content_hash, term_option_code, 'PENDING_PAYMENT',
                rental_amount_cents, deposit_amount_cents, currency, term_seconds,
                quote_snapshot, title,
                clock_timestamp() + make_interval(secs => $2)
         FROM zzsh_order.rental_order WHERE id = $3`,
        [newId, offsetSeconds, sourceOrderId],
      );
      assert.equal(cloned.rowCount, 1);
      return newId;
    };

    /** publish -> create -> cancel the original -> clone one expired pending order back. */
    const makeExpiredOrder = async (
      owner: CookieJar,
      renter: CookieJar,
      label: string,
      offsetSeconds = -60,
    ): Promise<{ accountId: string; orderId: string }> => {
      const target = await publishApproved(owner, label, "2500");
      const created = await createOrder(renter, target);
      assert.equal(created.response.status, 200, JSON.stringify(created.body));
      const sourceId = created.body?.order?.id as string;
      assert.equal((await request(base, `/api/v1/orders/${sourceId}/cancel`, {}, renter, USER_ORIGIN, "POST", orderKey())).response.status, 200);
      return { accountId: target.accountId, orderId: await cloneOrderOnAccount(sourceId, offsetSeconds) };
    };

    // ---------- 用户与账号 ----------
    const owner1 = await signupUser("订单号主一", "m4_owner_1");
    const owner2 = await signupUser("订单号主二", "m4_owner_2");
    const renter1 = await signupUser("订单租客一", "m4_renter_1");
    const renter2 = await signupUser("订单租客二", "m4_renter_2");
    const renter3 = await signupUser("订单租客三", "m4_renter_3");
    const owner3 = await signupUser("订单号主三", "m4_owner_3");

    // ---------- S1: 正向建单与金额口径（V17 全押金/零押金/未配置/保证金 UNKNOWN） ----------
    const accFull = await publishApproved(owner1, "全押金账号", "2500");
    const createdFull = await createOrder(renter1, accFull);
    assert.equal(createdFull.response.status, 200, JSON.stringify(createdFull.body));
    const fullOrder = createdFull.body?.order;
    assert.equal(fullOrder.status, "PENDING_PAYMENT");
    assert.equal(fullOrder.amounts.rental.amount, "150.00");
    assert.equal(fullOrder.amounts.deposit.amount, "25.00");
    assert.equal(fullOrder.amounts.totalDue.amount, "175.00");
    assert.equal(fullOrder.amounts.rental.scale, 2);
    assert.equal(fullOrder.paymentOpen, true);
    assert.equal(fullOrder.expiredAwaitingCancel, false);
    assert.match(fullOrder.displayNo, /^ZZ\d{6}-\d{6,}$/);
    assert.ok(fullOrder.holdUntil > fullOrder.createdAt);
    const fullQuoteJson = JSON.stringify(fullOrder.quote);
    for (const forbiddenField of ["ownerTotal", "platformFullProfit", "pricingInputs", "ownerAmount", "ownerUnitAmount", "publisherBailRequirement", "contentHash"]) {
      assert.equal(fullQuoteJson.includes(`"${forbiddenField}"`), false, `renter quote leaked ${forbiddenField}`);
    }
    const renterList = await request(base, "/api/v1/orders", undefined, renter1, USER_ORIGIN);
    assert.equal(renterList.response.status, 200);
    assert.equal(renterList.body?.items.some((item: any) => item.id === fullOrder.id), true);
    const ownerList = await request(base, "/api/v1/orders?party=owner", undefined, owner1, USER_ORIGIN);
    assert.equal(ownerList.response.status, 200);
    const ownerView = ownerList.body?.items.find((item: any) => item.id === fullOrder.id);
    assert.equal(ownerView?.renterName, "订单租客一");
    assert.equal(ownerView?.quote?.ownerTotal?.amount, "120.00");
    assert.equal(JSON.stringify(ownerView?.quote).includes("platformFullProfit"), false, "owner quote must not include platform fields");
    const strangerList = await request(base, "/api/v1/orders", undefined, renter2, USER_ORIGIN);
    assert.equal(strangerList.body?.items.some((item: any) => item.id === fullOrder.id), false, "orders of others must not leak into my list");

    const accZero = await publishApproved(owner1, "零押金账号", "0");
    const createdZero = await createOrder(renter2, accZero);
    assert.equal(createdZero.response.status, 200, JSON.stringify(createdZero.body));
    assert.equal(createdZero.body?.order?.amounts.deposit.amount, "0.00", "explicit zero deposit is a configured value");
    assert.equal(createdZero.body?.order?.amounts.totalDue.amount, "150.00");

    const accUnconfigured = await publishApproved(owner1, "未配置押金账号", null);
    const unconfigured = await createOrder(renter1, accUnconfigured);
    assert.equal(unconfigured.response.status, 409, JSON.stringify(unconfigured.body));
    assert.equal(unconfigured.body?.error?.code, "DEPOSIT_UNCONFIGURED");
    assert.equal((await runtimePool.query(`SELECT count(*)::text AS count FROM zzsh_order.rental_order WHERE account_id = $1`, [accUnconfigured.accountId])).rows[0]?.count, "0");

    const accBailUnknown = await publishApproved(owner1, "保证金未知账号", "2500");
    publicationGates.set(accBailUnknown.accountId, { publisherBail: "UNKNOWN", occupancy: "FREE", reference: null });
    const bailUnknown = await createOrder(renter1, accBailUnknown);
    assert.equal(bailUnknown.response.status, 404, "UNKNOWN bail must fail closed without claiming occupancy");
    publicationGates.delete(accBailUnknown.accountId);

    // B5：占用事实完全由订单表派生；保证金 UNKNOWN 独立失败关闭
    const gateProbe = composeSupplyGateWithOrderOccupancy(async () => ({
      publisherBail: "UNKNOWN" as const,
      occupancy: "UNKNOWN" as const,
      reference: null,
    }));
    const accGateTruth = await publishApproved(owner1, "占用真值账号", "2500");
    await withTransaction(runtimePool, async (client) => {
      const before = await gateProbe(client, { id: accGateTruth.accountId } as never);
      assert.equal(before.occupancy, "FREE", "no order means FREE even when the base says UNKNOWN");
      assert.equal(before.publisherBail, "UNKNOWN", "the bail seam is independent and unchanged");
    });
    const gateTruthCreate = await createOrder(renter1, accGateTruth);
    assert.equal(gateTruthCreate.response.status, 200, JSON.stringify(gateTruthCreate.body));
    await withTransaction(runtimePool, async (client) => {
      const occupied = await gateProbe(client, { id: accGateTruth.accountId } as never);
      assert.equal(occupied.occupancy, "OCCUPIED");
    });
    assert.equal((await request(base, `/api/v1/orders/${gateTruthCreate.body?.order?.id}/cancel`, {}, renter1, USER_ORIGIN, "POST", orderKey())).response.status, 200);
    await withTransaction(runtimePool, async (client) => {
      const released = await gateProbe(client, { id: accGateTruth.accountId } as never);
      assert.equal(released.occupancy, "FREE", "cancelling the order derives FREE again");
    });

    // ---------- S2/V01: 两人同时抢同一账号 ----------
    const accRace = await publishApproved(owner1, "竞态账号", "2500");
    const raceBarrier = twoPartyBarrier();
    probeWatched.add(accRace.accountId);
    probe.run = async () => { await raceBarrier.arrive(); };
    const raceOne = createOrder(renter1, accRace);
    const raceTwo = createOrder(renter2, accRace);
    await raceBarrier.waitAllArrived();
    raceBarrier.open();
    const raceResults = await Promise.all([raceOne, raceTwo]);
    probeWatched.clear();
    const raceStatuses = raceResults.map((result) => result.response.status).sort();
    assert.deepEqual(raceStatuses, [200, 409], JSON.stringify(raceResults.map((result) => result.body)));
    const raceLoser = raceResults.find((result) => result.response.status === 409);
    assert.equal(raceLoser?.body?.error?.code, "OCCUPIED");
    assert.equal((await runtimePool.query(`SELECT count(*)::text AS count FROM zzsh_order.rental_order WHERE account_id = $1 AND status = 'PENDING_PAYMENT'`, [accRace.accountId])).rows[0]?.count, "1", "exactly one occupying order");

    // ---------- S3/V02+V03: 重复下单、响应丢失重放、异体同 key、跨身份 ----------
    const accIdem = await publishApproved(owner1, "幂等账号", "2500");
    const idemKey = orderKey();
    const firstIdem = await createOrder(renter1, accIdem, idemKey);
    assert.equal(firstIdem.response.status, 200, JSON.stringify(firstIdem.body));
    const idemOrderId = firstIdem.body?.order?.id as string;
    const replaySame = await createOrder(renter1, accIdem, idemKey);
    assert.equal(replaySame.response.status, 200);
    assert.equal(replaySame.body?.order?.id, idemOrderId, "same key same body must replay the original order");
    const replayDifferent = await request(base, "/api/v1/orders", { accountId: accIdem.accountId, versionId: accIdem.versionId, releaseId: "release_other" }, renter1, USER_ORIGIN, "POST", idemKey);
    assert.equal(replayDifferent.response.status, 409);
    assert.equal(replayDifferent.body?.error?.code, "IDEMPOTENCY_KEY_REUSED");
    const crossIdentity = await createOrder(renter2, accIdem, idemKey);
    assert.equal(crossIdentity.response.status, 409, "another user's key must not replay my record");
    assert.equal(crossIdentity.body?.error?.code, "OCCUPIED");
    const secondKey = await createOrder(renter1, accIdem);
    assert.equal(secondKey.response.status, 409);
    assert.equal(secondKey.body?.error?.code, "OCCUPIED", "same user double-submit with a new key meets the occupancy guard");
    const missingKey = await request(base, "/api/v1/orders", { accountId: accIdem.accountId, versionId: accIdem.versionId, releaseId: accIdem.releaseId }, renter1, USER_ORIGIN, "POST");
    assert.equal(missingKey.response.status, 400);
    assert.equal(missingKey.body?.error?.code, "MISSING_IDEMPOTENCY_KEY");
    const cancelKey = orderKey();
    const cancelFirst = await request(base, `/api/v1/orders/${idemOrderId}/cancel`, { reason: "重放取消" }, renter1, USER_ORIGIN, "POST", cancelKey);
    assert.equal(cancelFirst.response.status, 200);
    const cancelReplay = await request(base, `/api/v1/orders/${idemOrderId}/cancel`, { reason: "重放取消" }, renter1, USER_ORIGIN, "POST", cancelKey);
    assert.equal(cancelReplay.response.status, 200, "cancel replay returns the original receipt");
    assert.equal(cancelReplay.body?.order?.id, idemOrderId);

    // ---------- S4/V04+V08: 规则变更竞争与快照不可变 ----------
    const accRuleRace = await publishApproved(owner1, "规则竞态账号", "2500");
    await makeRuleSet("1");
    const staleRuleCreate = await createOrder(renter1, accRuleRace);
    assert.equal(staleRuleCreate.response.status, 409, JSON.stringify(staleRuleCreate.body));
    assert.equal(staleRuleCreate.body?.error?.code, "RULE_CHANGED", "activation committed first must reject the stale create");
    assert.equal((await runtimePool.query(`SELECT count(*)::text AS count FROM zzsh_order.rental_order WHERE account_id = $1`, [accRuleRace.accountId])).rows[0]?.count, "0");

    // 下单在途时激活并发发起：create 先提交则订单钉住旧 release，激活排队后完成
    const accRuleWin = await publishApproved(owner1, "规则并发账号", "2500");
    const ruleGate = singleArrivalGate();
    probeWatched.add(accRuleWin.accountId);
    probe.run = async () => { await ruleGate.arrive(); };
    const ruleWinCreate = createOrder(renter1, accRuleWin);
    const gen3 = await (async () => {
      await ruleGate.waitArrived();
      probeWatched.delete(accRuleWin.accountId);
      ruleGate.open();
      return makeRuleSet("2");
    })();
    const ruleWinResult = await ruleWinCreate;
    probeWatched.clear();
    assert.equal(ruleWinResult.response.status, 200, JSON.stringify(ruleWinResult.body));
    const ruleWinDetail = await request(base, `/api/v1/orders/${ruleWinResult.body?.order?.id}`, undefined, renter1, USER_ORIGIN);
    assert.equal(ruleWinDetail.body?.order?.quote?.ruleReleaseId, accRuleWin.releaseId, "the committed order keeps the release pinned at creation");
    assert.notEqual(ruleWinDetail.body?.order?.quote?.ruleReleaseId, gen3.releaseId);
    assert.equal(ruleWinDetail.body?.order?.status, "PENDING_PAYMENT", "later rule activation must not rewrite or cancel the pending order");

    const accSnapshot = await publishApproved(owner1, "快照账号", "2500");
    const snapshotCreate = await createOrder(renter1, accSnapshot);
    assert.equal(snapshotCreate.response.status, 200, JSON.stringify(snapshotCreate.body));
    const snapshotOrderId = snapshotCreate.body?.order?.id as string;
    const gen4 = await makeRuleSet("3");
    await createEntry("items", { code: "round_item", name: "子弹", unit: "ROUND" });
    const snapshotDetail = await request(base, `/api/v1/orders/${snapshotOrderId}`, undefined, renter1, USER_ORIGIN);
    assert.equal(snapshotDetail.response.status, 200);
    assert.equal(snapshotDetail.body?.order?.quote?.ruleReleaseId, accSnapshot.releaseId, "order keeps the release pinned at creation");
    assert.notEqual(snapshotDetail.body?.order?.quote?.ruleReleaseId, gen4.releaseId);
    assert.equal(snapshotDetail.body?.order?.amounts.rental.amount, "150.00");
    assert.equal(snapshotDetail.body?.order?.amounts.deposit.amount, "25.00");
    assert.equal(snapshotDetail.body?.order?.quote?.termSeconds, String(6 * 86400));
    assert.equal(snapshotDetail.body?.order?.status, "PENDING_PAYMENT", "later rule activation must not rewrite or cancel the pending order");

    // ---------- S5/V16+V16b+V14: 编辑/暂停/恢复与占用的关系 ----------
    const accEditRace = await publishApproved(owner2, "编辑竞态账号", "2500");
    const editGate = singleArrivalGate();
    probeWatched.add(accEditRace.accountId);
    probe.run = async () => { await editGate.arrive(); };
    const editRaceCreate = createOrder(renter1, accEditRace);
    const editRaceDraft = (async () => {
      await editGate.waitArrived();
      probeWatched.delete(accEditRace.accountId);
      editGate.open();
      const revision = (await request(base, `/api/v1/supply/accounts/${accEditRace.accountId}`, undefined, owner2, USER_ORIGIN)).body?.account.revision;
      return request(base, `/api/v1/supply/accounts/${accEditRace.accountId}/drafts`, { expectedRevision: revision }, owner2, USER_ORIGIN, "POST", orderKey());
    })();
    const [editCreateResult, editDraftResult] = await Promise.all([editRaceCreate, editRaceDraft]);
    probeWatched.clear();
    assert.equal(editCreateResult.response.status, 200, JSON.stringify(editCreateResult.body));
    assert.equal(editDraftResult.response.status, 409, "draft creation must be rejected while the account is occupied");

    const accDraftFirst = await publishApproved(owner2, "先草稿账号", "2500");
    const draftFirstRevision = (await request(base, `/api/v1/supply/accounts/${accDraftFirst.accountId}`, undefined, owner2, USER_ORIGIN)).body?.account.revision;
    const draftFirst = await request(base, `/api/v1/supply/accounts/${accDraftFirst.accountId}/drafts`, { expectedRevision: draftFirstRevision }, owner2, USER_ORIGIN, "POST", orderKey());
    assert.equal(draftFirst.response.status, 200, JSON.stringify(draftFirst.body));
    const staleVersionCreate = await createOrder(renter1, accDraftFirst);
    assert.equal(staleVersionCreate.response.status, 409);
    assert.equal(staleVersionCreate.body?.error?.code, "VERSION_CHANGED", "a newer draft invalidates the confirmed version token");

    const accPauseRace = await publishApproved(owner2, "暂停竞态账号", "2500");
    const pauseGate = singleArrivalGate();
    probeWatched.add(accPauseRace.accountId);
    probe.run = async () => { await pauseGate.arrive(); };
    const pauseRaceCreate = createOrder(renter1, accPauseRace);
    const pauseRaceResult = (async () => {
      await pauseGate.waitArrived();
      probeWatched.delete(accPauseRace.accountId);
      pauseGate.open();
      const revision = (await request(base, `/api/v1/supply/accounts/${accPauseRace.accountId}`, undefined, owner2, USER_ORIGIN)).body?.account.revision;
      return request(base, `/api/v1/supply/accounts/${accPauseRace.accountId}/pause`, { expectedRevision: revision, reason: "号主暂停" }, owner2, USER_ORIGIN, "POST", orderKey());
    })();
    const [pauseCreateResult, pauseResult] = await Promise.all([pauseRaceCreate, pauseRaceResult]);
    probeWatched.clear();
    assert.equal(pauseCreateResult.response.status, 200, JSON.stringify(pauseCreateResult.body));
    assert.equal(pauseResult.response.status, 200, "pause does not check occupancy and must succeed after the create commits");
    const pauseRaceOrderId = pauseCreateResult.body?.order?.id as string;
    const pauseOrderDetail = await request(base, `/api/v1/orders/${pauseRaceOrderId}`, undefined, renter1, USER_ORIGIN);
    assert.equal(pauseOrderDetail.body?.order?.status, "PENDING_PAYMENT", "pause must not change the existing order");
    const pausedPublic = await request(base, `/api/v1/supply/listings/${accPauseRace.accountId}`, undefined, cookieJar(), API_ORIGIN);
    assert.equal(pausedPublic.response.status, 404, "occupied accounts are not publicly listed");
    const resumeOccupiedRevision = (await request(base, `/api/v1/supply/accounts/${accPauseRace.accountId}`, undefined, owner2, USER_ORIGIN)).body?.account.revision;
    const resumeOccupied = await request(base, `/api/v1/supply/accounts/${accPauseRace.accountId}/resume`, { expectedRevision: resumeOccupiedRevision }, owner2, USER_ORIGIN, "POST", orderKey());
    assert.equal(resumeOccupied.response.status, 409, "resume requires the occupancy gate to be FREE");

    const accPauseFirst = await publishApproved(owner2, "先暂停账号", "2500");
    const pauseFirstRevision = (await request(base, `/api/v1/supply/accounts/${accPauseFirst.accountId}`, undefined, owner2, USER_ORIGIN)).body?.account.revision;
    const pauseFirst = await request(base, `/api/v1/supply/accounts/${accPauseFirst.accountId}/pause`, { expectedRevision: pauseFirstRevision, reason: "先暂停" }, owner2, USER_ORIGIN, "POST", orderKey());
    assert.equal(pauseFirst.response.status, 200, JSON.stringify(pauseFirst.body));
    const pausedCreate = await createOrder(renter1, accPauseFirst);
    assert.equal(pausedCreate.response.status, 404, "paused accounts are not orderable");

    // 取消后占用释放，恢复/草稿按既有门禁重新评估（V14）
    const cancelPauseRace = await request(base, `/api/v1/orders/${pauseRaceOrderId}/cancel`, { reason: "租客反悔" }, renter1, USER_ORIGIN, "POST", orderKey());
    assert.equal(cancelPauseRace.response.status, 200, JSON.stringify(cancelPauseRace.body));
    assert.equal(cancelPauseRace.body?.order?.status, "CANCELLED");
    assert.equal(cancelPauseRace.body?.order?.cancelReason, "USER");
    const resumeAfterCancelRevision = (await request(base, `/api/v1/supply/accounts/${accPauseRace.accountId}`, undefined, owner2, USER_ORIGIN)).body?.account.revision;
    const resumeAfterCancel = await request(base, `/api/v1/supply/accounts/${accPauseRace.accountId}/resume`, { expectedRevision: resumeAfterCancelRevision }, owner2, USER_ORIGIN, "POST", orderKey());
    assert.equal(resumeAfterCancel.response.status, 200, "occupancy release re-enables the existing gates");

    // ---------- S6/V05+V06+V12+V18+V21: 取消、超时、清扫边界 ----------
    const accSweep = await publishApproved(owner2, "清扫账号", "2500");
    const sweepCreate = await createOrder(renter1, accSweep);
    assert.equal(sweepCreate.response.status, 200);
    const sweepOrderId = sweepCreate.body?.order?.id as string;
    const future = new Date(Date.now() + 2 * 3600 * 1000);
    const sweepResult = await sweepExpiredHolds(runtimePool, { asOf: future, batchLimit: 50, lockTimeoutMs: 2_000 });
    assert.ok(sweepResult.cancelled.includes(sweepOrderId), JSON.stringify(sweepResult));
    const sweptDetail = await request(base, `/api/v1/orders/${sweepOrderId}`, undefined, renter1, USER_ORIGIN);
    assert.equal(sweptDetail.body?.order?.status, "CANCELLED");
    assert.equal(sweptDetail.body?.order?.cancelReason, "TIMEOUT");
    const timeoutAudit = await runtimePool.query(`SELECT count(*)::text AS count FROM zzsh_iam.audit_event WHERE object_id = $1 AND action = 'order.reservation.cancelled' AND outcome = 'SUCCESS' AND actor_type = 'system'`, [sweepOrderId]);
    assert.equal(timeoutAudit.rows[0]?.count, "1", "timeout cancel must write exactly one system audit");

    // V05：取消与超时同时执行——只允许一次状态转换
    const accCancelRace = await publishApproved(owner2, "取消竞态账号", "2500");
    const cancelRaceCreate = await createOrder(renter1, accCancelRace);
    assert.equal(cancelRaceCreate.response.status, 200);
    const cancelRaceOrderId = cancelRaceCreate.body?.order?.id as string;
    const lockTx = await runtimePool.connect();
    try {
      await lockTx.query("BEGIN");
      await lockTx.query(`SELECT id FROM zzsh_supply.rental_account WHERE id = $1 FOR UPDATE`, [accCancelRace.accountId]);
      const concurrentSweep = sweepExpiredHolds(runtimePool, { asOf: future, batchLimit: 50, lockTimeoutMs: 10_000 });
      const concurrentCancel = request(base, `/api/v1/orders/${cancelRaceOrderId}/cancel`, {}, renter1, USER_ORIGIN, "POST", orderKey());
      let blocked = 0;
      let blockedDetail = "";
      const deadline = Date.now() + 10_000;
      while (blocked < 2 && Date.now() < deadline) {
        await lockTx.query("SELECT pg_stat_clear_snapshot()");
        // Row-lock waiters queue behind the first waiter, so pg_blocking_pids
        // only attributes one of them to the lock holder. Count lock waits on
        // the account FOR UPDATE query directly instead.
        const observed = await lockTx.query<{ count: string; queries: string }>(
          `SELECT count(*)::text AS count, COALESCE(string_agg(DISTINCT left(query, 60), ' | '), '') AS queries
             FROM pg_stat_activity
            WHERE datname = current_database() AND wait_event_type = 'Lock'
              AND query LIKE '%rental_account%FOR UPDATE%'`,
        );
        blocked = Number(observed.rows[0]?.count ?? "0");
        blockedDetail = observed.rows[0]?.queries ?? "";
      }
      assert.equal(blocked, 2, `both the sweep and the cancel must be queued on the account lock; observed: ${blockedDetail}`);
      await lockTx.query("COMMIT");
      const [raceSweep, raceCancel] = await Promise.all([concurrentSweep, concurrentCancel]);
      const finalOrder = (await runtimePool.query(`SELECT status, cancel_reason FROM zzsh_order.rental_order WHERE id = $1`, [cancelRaceOrderId])).rows[0];
      assert.equal(finalOrder?.status, "CANCELLED");
      const successAudits = await runtimePool.query(`SELECT count(*)::text AS count FROM zzsh_iam.audit_event WHERE object_id = $1 AND action = 'order.reservation.cancelled' AND outcome = 'SUCCESS'`, [cancelRaceOrderId]);
      assert.equal(successAudits.rows[0]?.count, "1", "exactly one successful cancel transition");
      if (raceSweep.cancelled.includes(cancelRaceOrderId)) {
        assert.equal(raceCancel.response.status, 409, "the losing cancel must see the terminal state");
        assert.equal(finalOrder?.cancel_reason, "TIMEOUT");
      } else {
        assert.ok(raceSweep.skippedChanged.includes(cancelRaceOrderId), JSON.stringify(raceSweep));
        assert.equal(raceCancel.response.status, 200);
        assert.equal(finalOrder?.cancel_reason, "USER");
      }
    } finally {
      await lockTx.query("ROLLBACK").catch(() => undefined);
      lockTx.release();
    }

    // V06：旧超时任务不能释放新订单占用
    const recreateSweep = await createOrder(renter2, accSweep);
    assert.equal(recreateSweep.response.status, 200, "occupancy released by the timeout allows a new order");
    const recreatedOrderId = recreateSweep.body?.order?.id as string;
    const staleCas = await runtimePool.query(
      `UPDATE zzsh_order.rental_order SET status = 'CANCELLED', cancel_reason = 'TIMEOUT', cancelled_at = clock_timestamp(), updated_at = clock_timestamp(), revision = revision + 1 WHERE id = $1 AND status = 'PENDING_PAYMENT' AND hold_until = $2`,
      [sweepOrderId, (await runtimePool.query(`SELECT hold_until FROM zzsh_order.rental_order WHERE id = $1`, [sweepOrderId])).rows[0]?.hold_until],
    );
    assert.equal(staleCas.rowCount, 0, "a stale worker's CAS must not touch an already-cancelled order");
    const notCandidate = await sweepExpiredHolds(runtimePool, { asOf: new Date(Date.now() + 30 * 60 * 1000), batchLimit: 50, lockTimeoutMs: 2_000 });
    assert.equal(notCandidate.cancelled.includes(recreatedOrderId), false, "the new order's hold is in the future of this sweep");
    const recreatedState = await runtimePool.query(`SELECT status FROM zzsh_order.rental_order WHERE id = $1`, [recreatedOrderId]);
    assert.equal(recreatedState.rows[0]?.status, "PENDING_PAYMENT", "stale sweeps must not release the new occupancy");

    // V12：普通预订路径不产生 PAID；不能直接插入已付或复活已取消单。
    const paidInsert = await maintenanceDataPool.query(
      `INSERT INTO zzsh_order.rental_order (id, display_no, account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, status, rental_amount_cents, deposit_amount_cents, currency, term_seconds, quote_snapshot, title, hold_until)
       SELECT 'order_paid_probe', 'ZZPROBE-1', account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, 'PAID', rental_amount_cents, deposit_amount_cents, currency, term_seconds, quote_snapshot, title, hold_until FROM zzsh_order.rental_order WHERE id = $1`,
      [sweepOrderId],
    ).then(
      () => {
        throw new Error("expected the probe to be rejected");
      },
      (error: unknown) => error as { code?: string },
    );
    assert.equal(paidInsert.code, "40001", "orders must start pending even after the payment seam is installed");
    const paidUpdate = await maintenanceDataPool.query(`UPDATE zzsh_order.rental_order SET status = 'PAID' WHERE id = $1`, [sweepOrderId]).then(
      () => {
        throw new Error("expected the probe to be rejected");
      },
      (error: unknown) => error as { code?: string },
    );
    assert.equal(paidUpdate.code, "40001", "cancelled orders cannot be revived as paid");
    const casLive = await runtimePool.query(`SELECT count(*)::text AS count FROM zzsh_order.rental_order WHERE id = $1 AND status = 'PENDING_PAYMENT' AND hold_until > clock_timestamp()`, [recreatedOrderId]);
    assert.equal(casLive.rows[0]?.count, "1", "the M5 CAS predicate is satisfiable only for a live pending order");
    const casDead = await runtimePool.query(`SELECT count(*)::text AS count FROM zzsh_order.rental_order WHERE id = $1 AND status = 'PENDING_PAYMENT' AND hold_until > clock_timestamp()`, [sweepOrderId]);
    assert.equal(casDead.rows[0]?.count, "0", "the CAS predicate never matches a cancelled order");
    assert.equal((await runtimePool.query(`SELECT count(*)::text AS count FROM zzsh_order.rental_order WHERE status NOT IN ('PENDING_PAYMENT','CANCELLED')`)).rows[0]?.count, "0", "reservation-only paths do not create payment facts");

    // V18+V21：已过期未清扫订单——可取消、可展示“已过期，取消处理中”，不回写状态
    const expiredCase = await makeExpiredOrder(owner2, renter1, "过期账号");
    const expiredDetail = await request(base, `/api/v1/orders/${expiredCase.orderId}`, undefined, renter1, USER_ORIGIN);
    assert.equal(expiredDetail.response.status, 200);
    assert.equal(expiredDetail.body?.order?.status, "PENDING_PAYMENT", "expiry alone does not rewrite the stored status");
    assert.equal(expiredDetail.body?.order?.expiredAwaitingCancel, true);
    assert.equal(expiredDetail.body?.order?.paymentOpen, false, "an expired hold must never display as payable");
    const cancelExpired = await request(base, `/api/v1/orders/${expiredCase.orderId}/cancel`, { reason: "过期不租了" }, renter1, USER_ORIGIN, "POST", orderKey());
    assert.equal(cancelExpired.response.status, 200, "an expired-but-unswept order can still be cancelled by its renter");
    assert.equal(cancelExpired.body?.order?.cancelReason, "USER");
    const cancelReasonAudit = await runtimePool.query(`SELECT details FROM zzsh_iam.audit_event WHERE object_id = $1 AND action = 'order.reservation.cancelled' AND outcome = 'SUCCESS' AND actor_type = 'user'`, [expiredCase.orderId]);
    assert.equal(cancelReasonAudit.rows[0]?.details?.userReason, "过期不租了", "free-text reason lives only in audit details");
    assert.equal((await runtimePool.query(`SELECT cancel_reason FROM zzsh_order.rental_order WHERE id = $1`, [expiredCase.orderId])).rows[0]?.cancel_reason, "USER", "the order column stores only the enum");

    // ---------- S7/V07: 审计失败全部回滚 ----------
    const accAudit = await publishApproved(owner2, "审计回滚账号", "2500");
    const auditFailKey = orderKey();
    await migrationPool.query(`REVOKE INSERT ON TABLE "zzsh_iam"."audit_event" FROM ${quotedIdentifier(resources.runtimeUser, "runtime user")}`);
    const auditFailed = await createOrder(renter1, accAudit, auditFailKey);
    assert.equal(auditFailed.response.status, 500, "audit failure must fail the whole creation");
    assert.equal((await runtimePool.query(`SELECT count(*)::text AS count FROM zzsh_order.rental_order WHERE account_id = $1`, [accAudit.accountId])).rows[0]?.count, "0", "no order row may survive the audit failure");
    assert.equal((await runtimePool.query(`SELECT count(*)::text AS count FROM zzsh_supply.idempotency_record WHERE "key" = $1`, [auditFailKey["idempotency-key"]])).rows[0]?.count, "0", "no idempotency record may survive the audit failure");
    await migrationPool.query(`GRANT INSERT ON TABLE "zzsh_iam"."audit_event" TO ${quotedIdentifier(resources.runtimeUser, "runtime user")}`);
    const auditRecovered = await createOrder(renter1, accAudit);
    assert.equal(auditRecovered.response.status, 200, "creation recovers after the grant is restored");

    // ---------- S8/V09: 越权读取、取消与管理查询 ----------
    const strangerDetail = await request(base, `/api/v1/orders/${snapshotOrderId}`, undefined, renter2, USER_ORIGIN);
    assert.equal(strangerDetail.response.status, 404, "other users must not read the order");
    const strangerCancel = await request(base, `/api/v1/orders/${snapshotOrderId}/cancel`, {}, renter2, USER_ORIGIN, "POST", orderKey());
    assert.equal(strangerCancel.response.status, 404, "other users must not cancel the order");
    const userOnAdmin = await request(base, "/api/v1/admin/orders", undefined, renter1, ADMIN_ORIGIN);
    assert.equal(userOnAdmin.response.status, 401, "the admin realm must not accept user sessions");
    const adminOnUser = await request(base, "/api/v1/orders", { accountId: accSnapshot.accountId, versionId: accSnapshot.versionId, releaseId: accSnapshot.releaseId }, boss.jar, ADMIN_ORIGIN, "POST", orderKey());
    assert.equal(adminOnUser.response.status, 401, "the user realm must not accept admin sessions");
    const noPermList = await request(base, "/api/v1/admin/orders", undefined, noPermStaff.jar, ADMIN_ORIGIN);
    assert.equal(noPermList.response.status, 403, "order.read is required");
    const noScopeDetail = await request(base, `/api/v1/admin/orders/${snapshotOrderId}`, undefined, noScopeViewer.jar, ADMIN_ORIGIN);
    assert.equal(noScopeDetail.response.status, 404, "no game scope must be indistinguishable from missing");
    const noScopeList = await request(base, "/api/v1/admin/orders", undefined, noScopeViewer.jar, ADMIN_ORIGIN);
    assert.equal(noScopeList.response.status, 200);
    assert.equal(noScopeList.body?.items?.length ?? -1, 0, "a scoped-out viewer sees an empty list");
    const scopedDetail = await request(base, `/api/v1/admin/orders/${snapshotOrderId}`, undefined, orderViewer.jar, ADMIN_ORIGIN);
    assert.equal(scopedDetail.response.status, 200, JSON.stringify(scopedDetail.body));
    assert.equal(scopedDetail.body?.order?.id, snapshotOrderId);
    assert.equal(scopedDetail.body?.order?.renterName, "订单租客一");
    assert.equal(JSON.stringify(scopedDetail.body?.order?.quote).includes("platformFullProfit"), false, "order.read alone must not project platform amounts");
    const scopedList = await request(base, `/api/v1/admin/orders?accountId=${accSnapshot.accountId}`, undefined, orderViewer.jar, ADMIN_ORIGIN);
    assert.equal(scopedList.response.status, 200);
    assert.equal(scopedList.body?.items.some((item: any) => item.id === snapshotOrderId), true);
    const bossDetail = await request(base, `/api/v1/admin/orders/${snapshotOrderId}`, undefined, boss.jar, ADMIN_ORIGIN);
    assert.equal(bossDetail.response.status, 200, "boss holds every registered permission");
    assert.equal(JSON.stringify(bossDetail.body?.order?.quote).includes("platformFullProfit"), true, "boss also holds the internal-quote permission");
    const cursorPage = await request(base, "/api/v1/orders?limit=1", undefined, renter1, USER_ORIGIN);
    assert.equal(cursorPage.response.status, 200);
    if (cursorPage.body?.nextCursor) {
      const cursorMisuse = await request(base, `/api/v1/orders?limit=1&status=CANCELLED&cursor=${encodeURIComponent(cursorPage.body.nextCursor)}`, undefined, renter1, USER_ORIGIN);
      assert.equal(cursorMisuse.response.status, 409, "a cursor bound to other filters must be rejected");
    }
    const garbageCursor = await request(base, "/api/v1/orders?cursor=" + encodeURIComponent("@@@not-a-cursor@@@"), undefined, renter1, USER_ORIGIN);
    assert.equal(garbageCursor.response.status, 409, "garbage cursors must be a stable 409, not a database type error");
    const badDateCursor = await request(base, "/api/v1/orders?cursor=" + Buffer.from(JSON.stringify({ f: "x", c: "not-a-date", i: "y" })).toString("base64url"), undefined, renter1, USER_ORIGIN);
    assert.equal(badDateCursor.response.status, 409, "a cursor with a malformed timestamp must be a stable 409");

    // ---------- S9/V10: 数据库约束真实生效（维护/迁移角色直接 SQL，精确 SQLSTATE） ----------
    const freeSource = (await runtimePool.query(`SELECT id FROM zzsh_order.rental_order WHERE account_id = $1 ORDER BY created_at LIMIT 1`, [accCancelRace.accountId])).rows[0];
    assert.ok(freeSource, "accCancelRace keeps its cancelled orders as constraint probes on a free account");
    const sqlError = (promise: Promise<unknown>): Promise<{ code?: string }> =>
      promise.then(
        () => {
          throw new Error("expected the probe to be rejected");
        },
        (error: unknown) => error as { code?: string },
      );
    const cloneOccupancy = await sqlError(maintenanceDataPool.query(
      `INSERT INTO zzsh_order.rental_order (id, display_no, account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, status, rental_amount_cents, deposit_amount_cents, currency, term_seconds, quote_snapshot, title, hold_until)
       SELECT 'order_dup_probe', 'ZZPROBE-2', account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, 'PENDING_PAYMENT', rental_amount_cents, deposit_amount_cents, currency, term_seconds, quote_snapshot, title, hold_until FROM zzsh_order.rental_order WHERE id = $1`,
      [recreatedOrderId],
    ));
    assert.equal(cloneOccupancy.code, "23505", "the partial unique index must reject a second occupancy");
    const cancelledInsert = await sqlError(maintenanceDataPool.query(
      `INSERT INTO zzsh_order.rental_order (id, display_no, account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, status, rental_amount_cents, deposit_amount_cents, currency, term_seconds, quote_snapshot, title, hold_until, cancel_reason, cancelled_at)
       SELECT 'order_cancel_probe', 'ZZPROBE-3', account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, 'CANCELLED', rental_amount_cents, deposit_amount_cents, currency, term_seconds, quote_snapshot, title, hold_until, 'USER', clock_timestamp() FROM zzsh_order.rental_order WHERE id = $1`,
      [freeSource.id],
    ));
    assert.equal(cancelledInsert.code, "40001", "inserting a non-PENDING initial state must hit the transition guard");
    const titleUpdate = await sqlError(maintenanceDataPool.query(`UPDATE zzsh_order.rental_order SET title = '被改标题' WHERE id = $1`, [recreatedOrderId]));
    assert.equal(titleUpdate.code, "40001", "snapshot fields must be immutable");
    const holdUpdate = await sqlError(maintenanceDataPool.query(`UPDATE zzsh_order.rental_order SET hold_until = clock_timestamp() + interval '9 days' WHERE id = $1`, [recreatedOrderId]));
    assert.equal(holdUpdate.code, "40001", "hold_until must not be extendable");
    const negativeDeposit = await sqlError(maintenanceDataPool.query(
      `INSERT INTO zzsh_order.rental_order (id, display_no, account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, status, rental_amount_cents, deposit_amount_cents, currency, term_seconds, quote_snapshot, title, hold_until)
       SELECT 'order_neg_probe', 'ZZPROBE-4', account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, 'PENDING_PAYMENT', rental_amount_cents, -1, currency, term_seconds, quote_snapshot, title, hold_until FROM zzsh_order.rental_order WHERE id = $1`,
      [freeSource.id],
    ));
    assert.equal(negativeDeposit.code, "40001", "negative amounts are rejected by the snapshot-consistency guard");
    const mismatchedAmount = await sqlError(maintenanceDataPool.query(
      `INSERT INTO zzsh_order.rental_order (id, display_no, account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, status, rental_amount_cents, deposit_amount_cents, currency, term_seconds, quote_snapshot, title, hold_until)
       SELECT 'order_mismatch_probe', 'ZZPROBE-5', account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, 'PENDING_PAYMENT', 999, deposit_amount_cents, currency, term_seconds, quote_snapshot, title, hold_until FROM zzsh_order.rental_order WHERE id = $1`,
      [freeSource.id],
    ));
    assert.equal(mismatchedAmount.code, "40001", "amount columns inconsistent with the snapshot must be rejected");
    const wrongAssociation = await sqlError(maintenanceDataPool.query(
      `INSERT INTO zzsh_order.rental_order (id, display_no, account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, status, rental_amount_cents, deposit_amount_cents, currency, term_seconds, quote_snapshot, title, hold_until)
       SELECT 'order_fk_probe', 'ZZPROBE-6', $2, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, 'PENDING_PAYMENT', rental_amount_cents, deposit_amount_cents, currency, term_seconds, quote_snapshot, title, hold_until FROM zzsh_order.rental_order WHERE id = $1`,
      [freeSource.id, accSnapshot.accountId],
    ));
    assert.equal(wrongAssociation.code, "23503", "version/account association changes must hit the composite FK");
    const badCurrency = await sqlError(maintenanceDataPool.query(
      `INSERT INTO zzsh_order.rental_order (id, display_no, account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, status, rental_amount_cents, deposit_amount_cents, currency, term_seconds, quote_snapshot, title, hold_until)
       SELECT 'order_currency_probe', 'ZZPROBE-7', account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, 'PENDING_PAYMENT', rental_amount_cents, deposit_amount_cents, currency, term_seconds, jsonb_set(quote_snapshot, '{currency}', '"USD"'), title, hold_until FROM zzsh_order.rental_order WHERE id = $1`,
      [freeSource.id],
    ));
    assert.equal(badCurrency.code, "40001", "snapshot currency must be CNY");
    const unconfiguredSnapshot = await sqlError(maintenanceDataPool.query(
      `INSERT INTO zzsh_order.rental_order (id, display_no, account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, status, rental_amount_cents, deposit_amount_cents, currency, term_seconds, quote_snapshot, title, hold_until)
       SELECT 'order_unconfigured_probe', 'ZZPROBE-8', account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, 'PENDING_PAYMENT', rental_amount_cents, deposit_amount_cents, currency, term_seconds, jsonb_set(quote_snapshot, '{pricingInputs,depositPolicy}', '"UNCONFIGURED"'), title, hold_until FROM zzsh_order.rental_order WHERE id = $1`,
      [freeSource.id],
    ));
    assert.equal(unconfiguredSnapshot.code, "40001", "UNCONFIGURED deposit snapshots must be rejected at the database boundary");
    const badPrecision = await sqlError(maintenanceDataPool.query(
      `INSERT INTO zzsh_order.rental_order (id, display_no, account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, status, rental_amount_cents, deposit_amount_cents, currency, term_seconds, quote_snapshot, title, hold_until)
       SELECT 'order_precision_probe', 'ZZPROBE-9', account_id, listing_version_id, owner_user_id, renter_user_id, game_id, rule_release_id, content_hash, term_option_code, 'PENDING_PAYMENT', 150005, deposit_amount_cents, currency, term_seconds, jsonb_set(quote_snapshot, '{resourceTotal,amount}', '"1500.005"'), title, hold_until FROM zzsh_order.rental_order WHERE id = $1`,
      [freeSource.id],
    ));
    assert.equal(badPrecision.code, "40001", "amounts with wrong scale must be rejected");

    // ---------- S10/V15: 双方互租 ----------
    const accMutualA = await publishApproved(owner1, "互租账号A", "2500");
    const accMutualB = await publishApproved(owner2, "互租账号B", "2500");
    const mutualBarrier = twoPartyBarrier();
    probeWatched.add(accMutualA.accountId);
    probeWatched.add(accMutualB.accountId);
    probe.run = async () => { await mutualBarrier.arrive(); };
    const mutualOne = createOrder(owner2, accMutualA);
    const mutualTwo = createOrder(owner1, accMutualB);
    await mutualBarrier.waitAllArrived();
    mutualBarrier.open();
    const [mutualResultOne, mutualResultTwo] = await Promise.all([mutualOne, mutualTwo]);
    probeWatched.clear();
    assert.equal(mutualResultOne.response.status, 200, JSON.stringify(mutualResultOne.body));
    assert.equal(mutualResultTwo.response.status, 200, JSON.stringify(mutualResultTwo.body));
    assert.notEqual(mutualResultOne.body?.order?.id, mutualResultTwo.body?.order?.id);

    // ---------- S11/V13: 双方身份竞争（注销= /account/cancel，停用= /account/deactivate） ----------
    const accObligation = await publishApproved(owner3, "注销竞态账号", "2500");
    const obligationGate = singleArrivalGate();
    probeWatched.add(accObligation.accountId);
    probe.run = async () => { await obligationGate.arrive(); };
    const obligationCreate = createOrder(renter3, accObligation);
    const cancelDuring = (async () => {
      await obligationGate.waitArrived();
      probeWatched.delete(accObligation.accountId);
      obligationGate.open();
      return request(base, "/api/auth/user/account/cancel", {}, renter3, USER_ORIGIN, "POST");
    })();
    const [obligationCreateResult, cancelAccountResult] = await Promise.all([obligationCreate, cancelDuring]);
    probeWatched.clear();
    assert.equal(obligationCreateResult.response.status, 200, JSON.stringify(obligationCreateResult.body));
    assert.equal(cancelAccountResult.response.status, 409, "an occupying order must block account cancellation");
    const renter3State = await runtimePool.query(`SELECT suspended FROM zzsh_auth_user."user" WHERE id = (SELECT renter_user_id FROM zzsh_order.rental_order WHERE id = $1)`, [obligationCreateResult.body?.order?.id]);
    assert.equal(renter3State.rows[0]?.suspended, false, "the rejected cancellation leaves the account active");

    const cancelledFirstCreate = await (async () => {
      const jar = await signupUser("先注销租客", "m4_renter_gone");
      assert.equal((await request(base, "/api/auth/user/account/cancel", {}, jar, USER_ORIGIN, "POST")).response.status, 200);
      return createOrder(jar, accMutualA);
    })();
    assert.equal(cancelledFirstCreate.response.status, 401, "cancelled users cannot create orders");

    const ownerGoneAccount = await publishApproved(owner3, "号主停用账号", "2500");
    assert.equal((await request(base, "/api/auth/user/account/deactivate", {}, owner3, USER_ORIGIN, "POST")).response.status, 200);
    const ownerGoneCreate = await createOrder(renter1, ownerGoneAccount);
    assert.equal(ownerGoneCreate.response.status, 404, "a deactivated owner fails the publication blockers");

    // ---------- S12/V20: 重放范围——后续变化不撤销原响应 ----------
    const accReplay = await publishApproved(owner1, "重放账号", "2500");
    const replayKey2 = orderKey();
    const replayFirst = await createOrder(renter1, accReplay, replayKey2);
    assert.equal(replayFirst.response.status, 200);
    const replayOrderId = replayFirst.body?.order?.id as string;
    const pausedReplayRevision = (await request(base, `/api/v1/supply/accounts/${accReplay.accountId}`, undefined, owner1, USER_ORIGIN)).body?.account.revision;
    const pausedReplay = await request(base, `/api/v1/supply/accounts/${accReplay.accountId}/pause`, { expectedRevision: pausedReplayRevision, reason: "重放测试暂停" }, owner1, USER_ORIGIN, "POST", orderKey());
    assert.equal(pausedReplay.response.status, 200);
    await makeRuleSet("4");
    await runtimePool.query(`UPDATE zzsh_iam.user_identity_state SET identity_status = 'UNVERIFIED' WHERE user_id = (SELECT renter_user_id FROM zzsh_order.rental_order WHERE id = $1)`, [replayOrderId]);
    const replayAfterChanges = await createOrder(renter1, accReplay, replayKey2);
    assert.equal(replayAfterChanges.response.status, 200, "replay must return the original receipt without re-running creation gates");
    assert.equal(replayAfterChanges.body?.order?.id, replayOrderId);
    const freshAfterDowngrade = await createOrder(renter1, accReplay);
    assert.equal(freshAfterDowngrade.response.status, 403, "a fresh execution still enforces trade eligibility");
    await runtimePool.query(`UPDATE zzsh_iam.user_identity_state SET identity_status = 'VERIFIED' WHERE user_id = (SELECT renter_user_id FROM zzsh_order.rental_order WHERE id = $1)`, [replayOrderId]);

    // ---------- S13/V19: 清扫 worker 生命周期 ----------
    let sweepCalls = 0;
    let releaseSweep!: () => void;
    const sweepGate = new Promise<void>((resolve) => (releaseSweep = resolve));
    const worker = new OrderSweepWorker(runtimePool, {
      intervalMs: 5,
      batchLimit: 50,
      lockTimeoutMs: 100,
      sweep: async () => {
        sweepCalls += 1;
        await sweepGate;
        return { candidates: 0, cancelled: [], skippedChanged: [], skippedLocked: [], failed: [], nextCursor: null } satisfies SweepResult;
      },
    });
    worker.start();
    const started = Date.now();
    while (sweepCalls === 0 && Date.now() - started < 5_000) await new Promise((resolve) => setImmediate(resolve));
    assert.equal(sweepCalls, 1, "the first batch is in flight");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sweepCalls, 1, "interval ticks must not overlap an in-flight batch");
    releaseSweep();
    await worker.stop();
    const callsAfterStop = sweepCalls;
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sweepCalls, callsAfterStop, "no batch starts after stop()");

    // 锁阻塞跳过与下一轮恢复
    const lockVictim = await makeExpiredOrder(owner1, renter1, "锁阻塞账号");
    const freeVictim = await makeExpiredOrder(owner2, renter1, "未锁账号");
    const holdLock = await runtimePool.connect();
    try {
      await holdLock.query("BEGIN");
      await holdLock.query(`SELECT id FROM zzsh_supply.rental_account WHERE id = $1 FOR UPDATE`, [lockVictim.accountId]);
      const lockRun = await sweepExpiredHolds(runtimePool, { batchLimit: 50, lockTimeoutMs: 300 });
      assert.ok(lockRun.skippedLocked.includes(lockVictim.orderId), JSON.stringify(lockRun));
      assert.ok(lockRun.cancelled.includes(freeVictim.orderId), "other expired orders are still cancelled");
      assert.equal((await runtimePool.query(`SELECT status FROM zzsh_order.rental_order WHERE id = $1`, [lockVictim.orderId])).rows[0]?.status, "PENDING_PAYMENT", "a locked row is left for the next round");
    } finally {
      await holdLock.query("COMMIT");
      holdLock.release();
    }
    const afterUnlock = await sweepExpiredHolds(runtimePool, { batchLimit: 50, lockTimeoutMs: 2_000 });
    assert.ok(afterUnlock.cancelled.includes(lockVictim.orderId), "the skipped row is picked up after the lock is released");

    // 积压逐批消化
    const backlogIds: string[] = [];
    for (let index = 0; index < 5; index += 1) {
      backlogIds.push((await makeExpiredOrder(index % 2 === 0 ? owner1 : owner2, renter1, `积压账号${index}`)).orderId);
    }
    const drained = new Set<string>();
    for (let round = 0; round < 3; round += 1) {
      const run = await sweepExpiredHolds(runtimePool, { batchLimit: 2, lockTimeoutMs: 2_000 });
      if (round < 2) assert.equal(run.cancelled.length, 2, "batch limit caps each run");
      for (const id of run.cancelled) drained.add(id);
    }
    for (const id of backlogIds) assert.ok(drained.has(id), `backlog order ${id} must drain across bounded batches`);

    // 失败隔离与恢复
    const failingVictim = await makeExpiredOrder(owner1, renter1, "失败恢复账号");
    await migrationPool.query(`REVOKE INSERT ON TABLE "zzsh_iam"."audit_event" FROM ${quotedIdentifier(resources.runtimeUser, "runtime user")}`);
    const failingRun = await sweepExpiredHolds(runtimePool, { batchLimit: 50, lockTimeoutMs: 2_000 });
    assert.ok(failingRun.failed.includes(failingVictim.orderId), JSON.stringify(failingRun));
    assert.equal((await runtimePool.query(`SELECT status FROM zzsh_order.rental_order WHERE id = $1`, [failingVictim.orderId])).rows[0]?.status, "PENDING_PAYMENT", "a failed cancel leaves the row pending for the next round");
    await migrationPool.query(`GRANT INSERT ON TABLE "zzsh_iam"."audit_event" TO ${quotedIdentifier(resources.runtimeUser, "runtime user")}`);
    const recoveredRun = await sweepExpiredHolds(runtimePool, { batchLimit: 50, lockTimeoutMs: 2_000 });
    assert.ok(recoveredRun.cancelled.includes(failingVictim.orderId), "the failed row is cancelled after recovery");

    // 公平推进：最早记录持续被锁时，后续订单仍能推进
    const starvedFront = await makeExpiredOrder(owner1, renter1, "队首锁账号", -120);
    const starvedBehind = await makeExpiredOrder(owner2, renter1, "队后账号", -60);
    const starveLock = await runtimePool.connect();
    try {
      await starveLock.query("BEGIN");
      await starveLock.query(`SELECT id FROM zzsh_supply.rental_account WHERE id = $1 FOR UPDATE`, [starvedFront.accountId]);
      const fairnessRun = await sweepExpiredHolds(runtimePool, { batchLimit: 1, lockTimeoutMs: 300 });
      assert.ok(fairnessRun.skippedLocked.includes(starvedFront.orderId), JSON.stringify(fairnessRun));
      assert.ok(fairnessRun.cancelled.includes(starvedBehind.orderId), "a persistently locked front row must not starve rows behind it");
      assert.equal((await runtimePool.query(`SELECT status FROM zzsh_order.rental_order WHERE id = $1`, [starvedFront.orderId])).rows[0]?.status, "PENDING_PAYMENT");
    } finally {
      await starveLock.query("COMMIT");
      starveLock.release();
    }
    const fairnessRecovery = await sweepExpiredHolds(runtimePool, { batchLimit: 50, lockTimeoutMs: 2_000 });
    assert.ok(fairnessRecovery.cancelled.includes(starvedFront.orderId));

    // B2续：持续锁住的整个扫描窗口 + 窗口后可处理订单的跨批次推进与回绕重试
    const fairFrontA = await makeExpiredOrder(owner1, renter1, "公平队首A", -300);
    const fairFrontB = await makeExpiredOrder(owner1, renter1, "公平队首B", -240);
    const fairBehindA = await makeExpiredOrder(owner2, renter1, "公平队后A", -180);
    const fairBehindB = await makeExpiredOrder(owner2, renter1, "公平队后B", -120);
    const fairLock = await runtimePool.connect();
    let fairCursor: { holdUntil: string; id: string } | null = null;
    try {
      await fairLock.query("BEGIN");
      await fairLock.query(`SELECT id FROM zzsh_supply.rental_account WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE`, [[fairFrontA.accountId, fairFrontB.accountId]]);
      const fairRun1 = await sweepExpiredHolds(runtimePool, { batchLimit: 50, lockTimeoutMs: 300, scanLimit: 2, after: fairCursor });
      assert.deepEqual([...fairRun1.skippedLocked].sort(), [fairFrontA.orderId, fairFrontB.orderId].sort(), "the whole locked window is skipped");
      assert.equal(fairRun1.cancelled.length, 0);
      assert.ok(fairRun1.nextCursor, "a full locked window still advances the scan position");
      fairCursor = fairRun1.nextCursor;
      const fairRun2 = await sweepExpiredHolds(runtimePool, { batchLimit: 50, lockTimeoutMs: 300, scanLimit: 2, after: fairCursor });
      assert.ok(fairRun2.cancelled.includes(fairBehindA.orderId) && fairRun2.cancelled.includes(fairBehindB.orderId), "rows behind the persistently locked window must be cancelled: " + JSON.stringify(fairRun2));
      fairCursor = fairRun2.nextCursor;
      const frontStill = await runtimePool.query(`SELECT count(*)::text AS count FROM zzsh_order.rental_order WHERE id = ANY($1::text[]) AND status='PENDING_PAYMENT'`, [[fairFrontA.orderId, fairFrontB.orderId]]);
      assert.equal(frontStill.rows[0]?.count, "2", "locked front rows stay pending");
      let wrapGuard = 0;
      while (fairCursor !== null && wrapGuard < 10) {
        const wrapStep = await sweepExpiredHolds(runtimePool, { batchLimit: 50, lockTimeoutMs: 300, scanLimit: 2, after: fairCursor });
        fairCursor = wrapStep.nextCursor;
        wrapGuard += 1;
      }
      assert.ok(wrapGuard > 0 && fairCursor === null, "the scan wraps back to the start after the tail");
      const wrappedRun = await sweepExpiredHolds(runtimePool, { batchLimit: 50, lockTimeoutMs: 300, scanLimit: 2, after: null });
      assert.ok(wrappedRun.skippedLocked.includes(fairFrontA.orderId) && wrappedRun.skippedLocked.includes(fairFrontB.orderId), "the wrapped scan retries the locked front rows");
    } finally {
      await fairLock.query("COMMIT");
      fairLock.release();
    }
    // 释放锁后队首最终被处理
    let releasedCursor: { holdUntil: string; id: string } | null = null;
    const releasedSeen = new Set<string>();
    for (let round = 0; round < 10 && releasedSeen.size < 2; round += 1) {
      const releasedRun = await sweepExpiredHolds(runtimePool, { batchLimit: 50, lockTimeoutMs: 2_000, scanLimit: 2, after: releasedCursor });
      releasedCursor = releasedRun.nextCursor;
      for (const id of releasedRun.cancelled) releasedSeen.add(id);
    }
    assert.ok(releasedSeen.has(fairFrontA.orderId) && releasedSeen.has(fairFrontB.orderId), "front rows are processed once the lock is released");

    // B2续：队首永久行级失败时后项仍推进
    const failFront = await makeExpiredOrder(owner1, renter1, "失败队首", -200);
    const failBehind = await makeExpiredOrder(owner2, renter1, "失败后项", -100);
    await migrationPool.query(`CREATE OR REPLACE FUNCTION zzsh_iam.fail_test_audit_marker() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.object_id = '${failFront.orderId}' THEN RAISE EXCEPTION 'synthetic audit failure for order sweep test' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$`);
    await migrationPool.query(`CREATE TRIGGER fail_test_audit_marker BEFORE INSERT ON zzsh_iam.audit_event FOR EACH ROW EXECUTE FUNCTION zzsh_iam.fail_test_audit_marker()`);
    try {
      const failRun1 = await sweepExpiredHolds(runtimePool, { batchLimit: 1, lockTimeoutMs: 2_000, scanLimit: 1, after: null });
      assert.deepEqual(failRun1.failed, [failFront.orderId], "the failing front row is observable and keeps its row pending");
      assert.ok(failRun1.nextCursor, "a full window with a permanent failure still advances the scan position");
      const failRun2 = await sweepExpiredHolds(runtimePool, { batchLimit: 1, lockTimeoutMs: 2_000, scanLimit: 1, after: failRun1.nextCursor });
      assert.deepEqual(failRun2.cancelled, [failBehind.orderId], "the row behind the permanently failing front still advances");
      assert.equal((await runtimePool.query(`SELECT status FROM zzsh_order.rental_order WHERE id=$1`, [failFront.orderId])).rows[0]?.status, "PENDING_PAYMENT", "a permanently failing row is left pending for later handling");
    } finally {
      await migrationPool.query(`DROP TRIGGER IF EXISTS fail_test_audit_marker ON zzsh_iam.audit_event`);
      await migrationPool.query(`DROP FUNCTION IF EXISTS zzsh_iam.fail_test_audit_marker()`);
    }

    // B2观测：标准装配的默认回调下，行级失败与整批失败均可观察（无自定义回调）
    const obsVictim = await makeExpiredOrder(owner1, renter1, "观测账号");
    await migrationPool.query(`CREATE OR REPLACE FUNCTION zzsh_iam.fail_test_audit_marker() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.object_id = '${obsVictim.orderId}' THEN RAISE EXCEPTION 'synthetic audit failure for order sweep observability' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$`);
    await migrationPool.query(`CREATE TRIGGER fail_test_audit_marker BEFORE INSERT ON zzsh_iam.audit_event FOR EACH ROW EXECUTE FUNCTION zzsh_iam.fail_test_audit_marker()`);
    const consoleErrors: string[] = [];
    const originalConsoleError = console.error;
    console.error = (...args: unknown[]) => { consoleErrors.push(args.map(String).join(" ")); };
    let obsApp: Awaited<ReturnType<typeof createApp>> | undefined;
    let obsPool: Pool | undefined;
    try {
      obsPool = new Pool({
        host: resources.runtime.database.host,
        port: resources.runtime.database.port,
        database: resources.runtime.database.name,
        user: resources.runtimeUser,
        password: resources.runtimePassword,
        application_name: "zzsh-order-obsapp",
        connectionTimeoutMillis: 2_000,
        max: 4,
      });
      obsApp = await createApp({
        health: {
          dependencies: {
            postgres: { check: async () => undefined, close: async () => undefined },
            redis: { check: async () => undefined, close: async () => undefined },
          },
        },
        database: { pool: obsPool },
        auth: { ...authOptions, pool: obsPool },
        orderSweep: { pool: obsPool, intervalMs: 5, batchLimit: 50, lockTimeoutMs: 2_000 },
      });
      await obsApp.listen(0, "127.0.0.1");
      const rowDeadline = Date.now() + 10_000;
      while (!consoleErrors.some((m) => m.includes("order.sweep.incomplete") && m.includes(obsVictim.orderId)) && Date.now() < rowDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(
        consoleErrors.some((m) => m.includes("order.sweep.incomplete") && m.includes(obsVictim.orderId)),
        "the default onResult logs the row-level failure with the order id",
      );
      await migrationPool.query(`REVOKE SELECT ON TABLE zzsh_order.rental_order FROM ${quotedIdentifier(resources.runtimeUser, "runtime user")}`);
      const batchDeadline = Date.now() + 10_000;
      while (!consoleErrors.some((m) => m.includes("order.sweep.failed")) && Date.now() < batchDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      assert.ok(
        consoleErrors.some((m) => m.includes("order.sweep.failed")),
        "the default onError logs a batch-level failure",
      );
      for (const m of consoleErrors) {
        assert.equal(/postgres_password|dev_runtime|secret|token|quote_snapshot/i.test(m), false, "sweep logs must not contain secrets or snapshots");
      }
    } finally {
      console.error = originalConsoleError;
      if (obsApp) await obsApp.close();
      await migrationPool.query(`DROP TRIGGER IF EXISTS fail_test_audit_marker ON zzsh_iam.audit_event`);
      await migrationPool.query(`DROP FUNCTION IF EXISTS zzsh_iam.fail_test_audit_marker()`);
      await migrationPool.query(`GRANT SELECT ON TABLE zzsh_order.rental_order TO ${quotedIdentifier(resources.runtimeUser, "runtime user")}`).catch(() => undefined);
    }

    // 拆除观测触发器后归位失败遗留行，避免污染后续场景
    await sweepExpiredHolds(runtimePool, { batchLimit: 50, lockTimeoutMs: 2_000 });

    // B2组合边界1（真实PG）：不足一窗且队首永久失败不占取消预算，后项本轮即处理
    const comboFailFront = await makeExpiredOrder(owner1, renter1, "组合失败队首", -200);
    const comboBehind = await makeExpiredOrder(owner2, renter1, "组合后项", -100);
    await migrationPool.query(`CREATE OR REPLACE FUNCTION zzsh_iam.fail_test_audit_marker() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.object_id = '${comboFailFront.orderId}' THEN RAISE EXCEPTION 'synthetic audit failure for combo test' USING ERRCODE='P0001'; END IF; RETURN NEW; END $$`);
    await migrationPool.query(`CREATE TRIGGER fail_test_audit_marker BEFORE INSERT ON zzsh_iam.audit_event FOR EACH ROW EXECUTE FUNCTION zzsh_iam.fail_test_audit_marker()`);
    try {
      const comboRun1 = await sweepExpiredHolds(runtimePool, { batchLimit: 1, lockTimeoutMs: 2_000, scanLimit: 10 });
      assert.deepEqual(comboRun1.failed, [comboFailFront.orderId], "row failure is observable and does not consume the cancel budget");
      assert.deepEqual(comboRun1.cancelled, [comboBehind.orderId], "the row behind the failing front is processed in the same run");
      assert.equal(comboRun1.nextCursor, null, "the tail window was fully attempted, so the scan wraps");
    } finally {
      await migrationPool.query(`DROP TRIGGER IF EXISTS fail_test_audit_marker ON zzsh_iam.audit_event`);
      await migrationPool.query(`DROP FUNCTION IF EXISTS zzsh_iam.fail_test_audit_marker()`);
    }
    const comboWrapRetry = await sweepExpiredHolds(runtimePool, { batchLimit: 50, lockTimeoutMs: 2_000, scanLimit: 10 });
    assert.ok(comboWrapRetry.cancelled.includes(comboFailFront.orderId), "the wrapped run retries and cancels the previously failing front row");

    // B2组合边界2：不足一窗因取消预算提前停——游标保留继续扫描，不回绕
    const comboBudgetFront = await makeExpiredOrder(owner1, renter1, "预算队首", -200);
    const comboBudgetMiddle = await makeExpiredOrder(owner2, renter1, "预算中间", -100);
    const comboBudgetTail = await makeExpiredOrder(owner1, renter1, "预算尾部", -50);
    const budgetRun1 = await sweepExpiredHolds(runtimePool, { batchLimit: 1, lockTimeoutMs: 2_000, scanLimit: 10 });
    assert.ok(budgetRun1.cancelled.includes(comboBudgetFront.orderId), JSON.stringify(budgetRun1));
    assert.equal(budgetRun1.cancelled.includes(comboBudgetMiddle.orderId), false, "the cancel budget stops the run early");
    assert.equal(budgetRun1.nextCursor?.id, comboBudgetFront.orderId, "an early budget stop with unattempted candidates keeps the position instead of wrapping");
    const budgetRun2 = await sweepExpiredHolds(runtimePool, { batchLimit: 1, lockTimeoutMs: 2_000, scanLimit: 10, after: budgetRun1.nextCursor });
    assert.ok(budgetRun2.cancelled.includes(comboBudgetMiddle.orderId), "the next run continues after the kept position");
    assert.equal(budgetRun2.nextCursor?.id, comboBudgetMiddle.orderId);
    const budgetRun3 = await sweepExpiredHolds(runtimePool, { batchLimit: 1, lockTimeoutMs: 2_000, scanLimit: 10, after: budgetRun2.nextCursor });
    assert.ok(budgetRun3.cancelled.includes(comboBudgetTail.orderId));

    // B2组合边界3：完整处理尾窗后回绕并重试锁项
    const tailLocked = await makeExpiredOrder(owner1, renter1, "尾窗锁项", -200);
    const tailOk = await makeExpiredOrder(owner2, renter1, "尾窗可处理", -100);
    const tailHold = await runtimePool.connect();
    try {
      await tailHold.query("BEGIN");
      await tailHold.query(`SELECT id FROM zzsh_supply.rental_account WHERE id = $1 FOR UPDATE`, [tailLocked.accountId]);
      const tailRun1 = await sweepExpiredHolds(runtimePool, { batchLimit: 50, lockTimeoutMs: 300, scanLimit: 10 });
      assert.ok(tailRun1.skippedLocked.includes(tailLocked.orderId), JSON.stringify(tailRun1));
      assert.ok(tailRun1.cancelled.includes(tailOk.orderId));
      assert.equal(tailRun1.nextCursor, null, "a fully processed tail window wraps to the start");
      const tailRun2 = await sweepExpiredHolds(runtimePool, { batchLimit: 50, lockTimeoutMs: 300, scanLimit: 10 });
      assert.ok(tailRun2.skippedLocked.includes(tailLocked.orderId), "the wrapped run retries the locked row");
    } finally {
      await tailHold.query("COMMIT");
      tailHold.release();
    }
    const tailRun3 = await sweepExpiredHolds(runtimePool, { batchLimit: 50, lockTimeoutMs: 2_000, scanLimit: 10 });
    assert.ok(tailRun3.cancelled.includes(tailLocked.orderId), "the retried row is cancelled once the lock is released");

    // worker 跨轮传递游标
    const probeCursor = { holdUntil: "2026-01-01T00:00:00.000000Z", id: "order_probe" };
    const seenAfter: Array<{ holdUntil: string; id: string } | null | undefined> = [];
    const cursorWorker = new OrderSweepWorker(runtimePool, {
      intervalMs: 5,
      batchLimit: 10,
      lockTimeoutMs: 100,
      sweep: async (_pool, options) => {
        seenAfter.push(options.after);
        return {
          candidates: 0,
          cancelled: [],
          skippedChanged: [],
          skippedLocked: [],
          failed: [],
          nextCursor: seenAfter.length === 1 ? probeCursor : null,
        } satisfies SweepResult;
      },
    });
    cursorWorker.start();
    const cursorDeadline = Date.now() + 5_000;
    while (seenAfter.length < 2 && Date.now() < cursorDeadline) await new Promise((resolve) => setImmediate(resolve));
    await cursorWorker.stop();
    assert.equal(seenAfter.length >= 2, true, "the worker ran at least two ticks");
    assert.equal(seenAfter[0], null, "the first tick scans from the start");
    assert.deepEqual(seenAfter[1], probeCursor, "the second tick receives the previous tick's nextCursor");

    // B3：真实 app.close 必须等待在途清扫批次完成，再结束 pool
    const closeVictim = await makeExpiredOrder(owner1, renter1, "关闭等待账号");
    const closeHold = await runtimePool.connect();
    let sweepApp: Awaited<ReturnType<typeof createApp>> | undefined;
    let sweepPool: Pool | undefined;
    const closeResults: SweepResult[] = [];
    try {
      await closeHold.query("BEGIN");
      await closeHold.query(`SELECT id FROM zzsh_supply.rental_account WHERE id = $1 FOR UPDATE`, [closeVictim.accountId]);
      sweepPool = new Pool({
        host: resources.runtime.database.host,
        port: resources.runtime.database.port,
        database: resources.runtime.database.name,
        user: resources.runtimeUser,
        password: resources.runtimePassword,
        application_name: "zzsh-order-sweepapp",
        connectionTimeoutMillis: 2_000,
        max: 4,
      });
      sweepApp = await createApp({
        health: {
          dependencies: {
            postgres: { check: async () => undefined, close: async () => undefined },
            redis: { check: async () => undefined, close: async () => undefined },
          },
        },
        database: { pool: sweepPool },
        auth: { ...authOptions, pool: sweepPool },
        orderSweep: {
          pool: sweepPool,
          intervalMs: 5,
          batchLimit: 50,
          lockTimeoutMs: 10_000,
          onResult: (result) => closeResults.push(result),
        },
      });
      await sweepApp.listen(0, "127.0.0.1");
      let sweepWaiting = false;
      const waitDeadline = Date.now() + 10_000;
      while (!sweepWaiting && Date.now() < waitDeadline) {
        await closeHold.query("SELECT pg_stat_clear_snapshot()");
        sweepWaiting = (await closeHold.query<{ waiting: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'
                AND query LIKE '%rental_account%FOR UPDATE%') AS waiting`,
        )).rows[0]!.waiting;
      }
      assert.equal(sweepWaiting, true, "the sweeper batch must be in flight and blocked on the account lock");
      const closing = sweepApp.close();
      const earlyResolve = await Promise.race([
        closing.then(() => "closed" as const),
        new Promise<"pending">((resolve) => setTimeout(() => resolve("pending"), 150)),
      ]);
      assert.equal(earlyResolve, "pending", "app.close must wait for the in-flight sweep batch");
      await closeHold.query("COMMIT");
      await closing;
      assert.ok(
        closeResults.some((result) => result.cancelled.includes(closeVictim.orderId)),
        "the blocked batch completes observably once the lock is released",
      );
      assert.equal(
        (await runtimePool.query(`SELECT status FROM zzsh_order.rental_order WHERE id = $1`, [closeVictim.orderId])).rows[0]?.status,
        "CANCELLED",
        "the in-flight batch finished its CAS before the pool ended",
      );
    } finally {
      await closeHold.query("ROLLBACK").catch(() => undefined);
      closeHold.release();
      if (sweepApp) {
        try {
          await sweepApp.close();
        } catch {
          // already closed by the ordering assertion above
        }
      }
    }

    // B4：hold 配置缺失后，命中既有结果的幂等重放仍安全返回
    let noHoldApp: Awaited<ReturnType<typeof createApp>> | undefined;
    let noHoldPool: Pool | undefined;
    try {
      noHoldPool = new Pool({
        host: resources.runtime.database.host,
        port: resources.runtime.database.port,
        database: resources.runtime.database.name,
        user: resources.runtimeUser,
        password: resources.runtimePassword,
        application_name: "zzsh-order-nohold",
        connectionTimeoutMillis: 2_000,
        max: 4,
      });
      noHoldApp = await createApp({
        health: {
          dependencies: {
            postgres: { check: async () => undefined, close: async () => undefined },
            redis: { check: async () => undefined, close: async () => undefined },
          },
        },
        database: { pool: noHoldPool },
        auth: { ...authOptions, pool: noHoldPool, orderHoldSeconds: undefined },
      });
      await noHoldApp.listen(0, "127.0.0.1");
      const noHoldBase = await noHoldApp.getUrl();
      const replayWithoutHold = await request(noHoldBase, "/api/v1/orders", { accountId: accReplay.accountId, versionId: accReplay.versionId, releaseId: accReplay.releaseId }, renter1, USER_ORIGIN, "POST", replayKey2);
      assert.equal(replayWithoutHold.response.status, 200, "a recorded replay must not be blocked by the missing hold config");
      assert.equal(replayWithoutHold.body?.order?.id, replayOrderId);
      const conflictWithoutHold = await request(noHoldBase, "/api/v1/orders", { accountId: accReplay.accountId, versionId: accReplay.versionId, releaseId: "release_other" }, renter1, USER_ORIGIN, "POST", replayKey2);
      assert.equal(conflictWithoutHold.response.status, 409);
      assert.equal(conflictWithoutHold.body?.error?.code, "IDEMPOTENCY_KEY_REUSED");
      const accNoHold = await publishApproved(owner1, "无hold配置账号", "2500");
      const freshWithoutHold = await request(noHoldBase, "/api/v1/orders", { accountId: accNoHold.accountId, versionId: accNoHold.versionId, releaseId: accNoHold.releaseId }, renter1, USER_ORIGIN, "POST", orderKey());
      assert.equal(freshWithoutHold.response.status, 503, "fresh creation stays disabled without hold configuration");
    } finally {
      if (noHoldApp) await noHoldApp.close();
    }

    // B6：展示单号至少六位，超过 999999 不截断（setval 需序列 UPDATE 权限，由维护连接执行）
    await maintenanceDataPool.query(`SELECT setval('zzsh_order.display_no_seq', 999998)`);
    const accNumA = await publishApproved(owner1, "单号边界A", "2500");
    const accNumB = await publishApproved(owner1, "单号边界B", "2500");
    const numA = await createOrder(renter1, accNumA);
    const numB = await createOrder(renter2, accNumB);
    assert.equal(numA.response.status, 200, JSON.stringify(numA.body));
    assert.equal(numB.response.status, 200, JSON.stringify(numB.body));
    assert.match(numA.body?.order?.displayNo, /^ZZ\d{6}-999999$/, "the 999999th display number keeps six digits");
    assert.match(numB.body?.order?.displayNo, /^ZZ\d{6}-1000000$/, "the 1000000th display number is NOT truncated to 100000");
    assert.notEqual(numA.body?.order?.displayNo, numB.body?.order?.displayNo);

    // ---------- S14/V11: 小连接池并发 ----------
    smallPool = new Pool({
      host: resources.runtime.database.host,
      port: resources.runtime.database.port,
      database: resources.runtime.database.name,
      user: resources.runtimeUser,
      password: resources.runtimePassword,
      application_name: "zzsh-order-smallpool",
      connectionTimeoutMillis: 2_000,
      max: 2,
    });
    const accPoolA = await publishApproved(owner1, "小池账号A", "2500");
    const accPoolB = await publishApproved(owner1, "小池账号B", "2500");
    smallApp = await createApp({
      health: {
        dependencies: {
          postgres: { check: async () => undefined, close: async () => undefined },
          redis: { check: async () => undefined, close: async () => undefined },
        },
      },
      database: { pool: smallPool },
      auth: { ...authOptions, pool: smallPool },
    });
    await smallApp.listen(0, "127.0.0.1");
    const smallBase = await smallApp.getUrl();
    const smallResults = await Promise.all([
      request(smallBase, "/api/v1/orders", { accountId: accPoolA.accountId, versionId: accPoolA.versionId, releaseId: accPoolA.releaseId }, renter1, USER_ORIGIN, "POST", orderKey()),
      request(smallBase, "/api/v1/orders", { accountId: accPoolB.accountId, versionId: accPoolB.versionId, releaseId: accPoolB.releaseId }, renter2, USER_ORIGIN, "POST", orderKey()),
      request(smallBase, `/api/v1/orders/${recreatedOrderId}/cancel`, {}, renter2, USER_ORIGIN, "POST", orderKey()),
      request(smallBase, "/api/v1/orders?limit=5", undefined, renter1, USER_ORIGIN),
      sweepExpiredHolds(smallPool, { batchLimit: 10, lockTimeoutMs: 2_000 }),
    ]);
    assert.equal(smallResults[0].response.status, 200, JSON.stringify(smallResults[0].body));
    assert.equal(smallResults[1].response.status, 200, JSON.stringify(smallResults[1].body));
    assert.equal(smallResults[2].response.status, 200, JSON.stringify(smallResults[2].body));
    assert.equal(smallResults[3].response.status, 200, JSON.stringify(smallResults[3].body));

    const deadlocksAfter = Number(
      (await maintenanceDataPool.query(`SELECT deadlocks FROM pg_stat_database WHERE datname = $1`, [resources.databaseName])).rows[0]?.deadlocks ?? "0",
    );
    assert.equal(deadlocksAfter, deadlocksBefore, "no deadlock may occur anywhere in the suite (V11)");

    const orderAudits = await runtimePool.query(`SELECT count(*)::text AS count FROM zzsh_iam.audit_event WHERE action LIKE 'order.reservation.%'`);
    assert.ok(Number(orderAudits.rows[0]?.count ?? "0") >= 8, "order writes must be audited");
    const paymentOwner = await signupUser("付款号主", "oim_owner");
    const paymentBuyer = await signupUser("付款买家", "oim_buyer");
    const acceptance: Parameters<typeof runPaymentAcceptance>[1] = {
      pool: runtimePool, migrationPool, ownerPool: maintenanceDataPool, config: { ...resources.runtime, testOperationsEnabled: true },
      resourceSet: RESOURCE_SET,
      fixture: async (label, offset) => {
        const account = await publishApproved(paymentOwner, label, "2500");
        const created = await createOrder(paymentBuyer, account);
        assert.equal(created.response.status, 200, JSON.stringify(created.body));
        let orderId = created.body!.order.id as string;
        if (offset !== undefined) {
          assert.equal((await request(base, `/api/v1/orders/${orderId}/cancel`, {}, paymentBuyer, USER_ORIGIN, "POST", orderKey())).response.status, 200);
          orderId = await cloneOrderOnAccount(orderId, offset);
        }
        return { ...account, orderId };
      },
      api: (path, body, method) => request(base, path, body, paymentBuyer, USER_ORIGIN, method, orderKey()),
      clone: cloneOrderOnAccount,
    };
    if (RESOURCE_SET && !PRICING_COMPAT) {
      await runPaymentAcceptance(t, acceptance);
      await runDispatchAcceptance(t, acceptance);
      await runOrderTeamAcceptance(t, acceptance);
      if (stagedFirstResponse) {
        await runOrderFirstResponseAcceptance(t, acceptance, {
          base,
          baselineCount,
          upgrade: async (upToIndex) => {
            await runBusinessMigrations(migrationPool!, {
              runtimeUser: resources!.runtimeUser,
              migrationsFolder: preparePartialMigrationsFolder(upToIndex),
            });
          },
        });
      }
    }
  } finally {
    const cleanupErrors: unknown[] = [];
    probeWatched.clear();
    if (smallApp) {
      try {
        await smallApp.close();
        smallClosedByApp = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (app) {
      try {
        await app.close();
        runtimeClosedByApp = true;
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (fixturesStarted && maintenanceDataPool && guard) {
      try { await truncateIsolatedBusinessData(maintenanceDataPool); } catch (error) { cleanupErrors.push(error); }
    }
    for (const pool of [smallClosedByApp ? undefined : smallPool, runtimePool && !runtimeClosedByApp ? runtimePool : undefined, migrationPool, maintenanceDataPool]) {
      if (!pool) continue;
      try {
        await pool.end();
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (guard) {
      try {
        assert.equal((await guard.query("SELECT pg_advisory_unlock($1::bigint) AS released", [LOCK_KEY])).rows[0].released, true);
      } catch (error) { cleanupErrors.push(error); } finally { guard.release(); }
    }
    if (maintenancePool) { try { await maintenancePool.end(); } catch (error) { cleanupErrors.push(error); } }
    console.log("order cleanup", JSON.stringify({ failures: cleanupErrors.length }));
    if (cleanupErrors.length > 0) throw cleanupErrors[0];
  }
});
