// Offline behaviour of the two-resource entry: one registered regression group with a mandatory OID
// binding, named reuse-only exceptions, the maintenance-database outer lock, an FK-closed shared
// cleanup list, and the FND fixture marker preparation for the shared target.
import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import type { Pool, PoolClient } from "pg";

import { loadConfig } from "../src/config/config";
import {
  assertNotProtectedTarget,
  MAINTENANCE_DATABASE,
  REGISTERED_HISTORICAL_EXCEPTIONS,
  REGRESSION_ALLOW_NEW_RESOURCE,
  REGRESSION_DATABASE,
  REGRESSION_MARKER,
  REGRESSION_MIGRATION_USER,
  REGRESSION_RESOURCE_LOCK_KEY,
  REGRESSION_ROLE_PREFIX,
  REGRESSION_RUNTIME_USER,
  registeredException,
  regressionOidBinding,
} from "../src/config/test-resource";
import {
  acquireSharedResourceLock,
  admitTestDatabase,
  assertFreshRegressionRun,
  type TestDatabaseAdmission,
} from "./database-test-support";
import { loadFnd004TestConfig, prepareFndFixtureMarker } from "../src/database/reset";

const SUITES = [
  "database.test.ts",
  "database-reset.test.ts",
  "auth.test.ts",
  "approval-audit.test.ts",
  "admin-workspace-layout.test.ts",
  "supply-m3b.test.ts",
  "content-foundation.test.ts",
  "order-reservation.test.ts",
  "user-directory.test.ts",
];

const admission: TestDatabaseAdmission = {
  exists: false,
  owner: "zzsh",
  marker: REGRESSION_MARKER,
  allowConnections: true,
  isTemplate: false,
  databaseOid: "700100",
  expectedOwner: "zzsh",
  expectedMarker: REGRESSION_MARKER,
  expectedOid: "700100",
  databaseName: REGRESSION_DATABASE,
  allowFlag: REGRESSION_ALLOW_NEW_RESOURCE,
  requireOidOnReuse: true,
};

const dailyEnv = {
  APP_PROFILE: "dev",
  PROVIDER_MODE: "fake",
  DB_TARGET: "local-compose",
  DB_HOST: "127.0.0.1",
  DB_PORT: "55432",
  DB_NAME: "zzsh_dev",
  DB_USER: "zzsh",
  DB_PASSWORD: "offline-only",
  REDIS_HOST: "127.0.0.1",
  REDIS_PORT: "56379",
  REDIS_PASSWORD: "offline-only",
};

test("the regression group is one name, marker, role pair and maintenance-database lock", () => {
  assert.equal(REGRESSION_DATABASE, "zzsh_test_regression");
  assert.equal(REGRESSION_MARKER, "zzsh:regression-test:v1");
  assert.ok(REGRESSION_MIGRATION_USER.startsWith(REGRESSION_ROLE_PREFIX));
  assert.ok(REGRESSION_RUNTIME_USER.startsWith(REGRESSION_ROLE_PREFIX));
  assert.notEqual(REGRESSION_MIGRATION_USER, REGRESSION_RUNTIME_USER);
  assert.match(REGRESSION_RESOURCE_LOCK_KEY, /^[0-9]+$/);
  assert.equal(MAINTENANCE_DATABASE, "postgres");
  assert.equal(loadConfig(dailyEnv, process.cwd()).database.name, "zzsh_dev");
  assert.throws(() => assertNotProtectedTarget(loadConfig(dailyEnv, process.cwd()).database.name), /daily development database/);
});

test("daily, maintenance, IM, historical and UNKNOWN databases are refused as targets", () => {
  for (const name of [
    "zzsh_dev",
    "zzsh_dev_daily",
    "postgres",
    "zzsh_test_order_milestone_real_1",
    "zzsh_test_order_im_paid_1",
    "zzsh_test_im_sync_review_20261029",
    "zzsh_test_order_milestone_rehearsal_1",
    "zzsh_test_order_payfin_mig3_clean",
    "zzsh_test_order_ui_legacy_rehearsal",
    "zzsh_test_order_perf_dir_ab2",
    "zzsh_test_order_user_maint_perf_20",
    "zzsh_test_order_user_maint_r_21",
    "zzsh_fnd003_test",
    "zzsh_test_better_auth",
    "zzsh_test_m2_qa_0910185919827",
  ]) {
    assert.throws(() => assertNotProtectedTarget(name), /must never target it/, `${name} must be refused`);
  }
  assert.equal(assertNotProtectedTarget(REGRESSION_DATABASE), undefined);
});

test("every registered exception carries its own identity and can never be created", () => {
  const oids = new Set<string>();
  for (const [name, entry] of Object.entries(REGISTERED_HISTORICAL_EXCEPTIONS)) {
    assert.match(name, /^zzsh_test_/);
    assert.match(entry.oid, /^[0-9]+$/, `${name} needs a numeric OID`);
    assert.ok(!oids.has(entry.oid), `${name} duplicates OID ${entry.oid}`);
    oids.add(entry.oid);
    assert.ok(entry.marker.startsWith("zzsh:"), `${name} needs a registered marker`);
    assert.notEqual(entry.migrationUser, entry.runtimeUser);
    assert.equal(assertNotProtectedTarget(name), undefined);
  }
  const exception = registeredException("zzsh_test_order_trade_settlement");
  assert.equal(exception.oid, "748138");
  assert.equal(exception.migrationUser, "zzsh_order_trade_settlement_m");
  // A free resource-set suffix is not a registration.
  assert.throws(() => registeredException("zzsh_test_m2_auth_review_unregistered"), /not a registered test resource/);
  assert.throws(() => registeredException("zzsh_test_order_milestone_real_1"), /IM line/);
});

test("an existing regression database must be bound to its recorded OID", () => {
  const existing = { ...admission, exists: true };
  assert.equal(admitTestDatabase(existing, {}), "REUSE");
  assert.throws(() => admitTestDatabase({ ...existing, expectedOid: null }, {}), /bind its registered OID/);
  assert.throws(() => admitTestDatabase({ ...existing, databaseOid: "700101" }, {}), /not OID 700100/);
  assert.throws(() => admitTestDatabase({ ...existing, marker: null }, {}), /marker is missing or mismatched/);
  assert.throws(() => admitTestDatabase({ ...existing, owner: "zzsh_regression_runtime" }, {}), /owner changed/);
  assert.equal(regressionOidBinding({}), null);
  assert.equal(regressionOidBinding({ ZZSH_REGRESSION_DB_OID: " 700100 " }), "700100");
  assert.throws(() => regressionOidBinding({ ZZSH_REGRESSION_DB_OID: "700100; DROP" }), /numeric OID/);
});

test("creation is allowed once, only for the regression group, and never for an exception", () => {
  assert.throws(() => admitTestDatabase(admission, dailyEnv), /REGRESSION_TEST_ALLOW_NEW_RESOURCE=1/);
  assert.equal(admitTestDatabase(admission, { [REGRESSION_ALLOW_NEW_RESOURCE]: "1" }), "CREATE");
  assert.throws(() => admitTestDatabase(admission, { ORDER_TEST_ALLOW_NEW_RESOURCE: "1", FND003_TEST_ALLOW_NEW_RESOURCE: "1" }), /REGRESSION_TEST_ALLOW_NEW_RESOURCE=1/);
  const exception: TestDatabaseAdmission = {
    ...admission,
    databaseName: "zzsh_test_order_trade_settlement",
    expectedOid: "748138",
    allowFlag: REGRESSION_ALLOW_NEW_RESOURCE,
    reuseOnly: true,
  };
  assert.throws(() => admitTestDatabase(exception, { [REGRESSION_ALLOW_NEW_RESOURCE]: "1" }), /reuse-only/);
  assert.equal(admitTestDatabase({ ...exception, exists: true, databaseOid: "748138" }, {}), "REUSE");
  assert.throws(() => admitTestDatabase({ ...exception, exists: true, databaseOid: "748139" }, {}), /not OID 748138/);
});

type FakeClient = PoolClient & { queries: Array<{ text: string; values?: unknown[] }>; destroyed: boolean[] };

function fakePool(handler: (text: string, values?: unknown[]) => unknown): { pool: Pool; client: FakeClient } {
  const client = {
    queries: [] as Array<{ text: string; values?: unknown[] }>,
    destroyed: [] as boolean[],
    query: async (text: string, values?: unknown[]) => {
      client.queries.push({ text, values });
      return { rows: handler(text, values) as unknown[] };
    },
    release: (destroy?: boolean) => { client.destroyed.push(destroy === true); },
  } as unknown as FakeClient;
  return { pool: { connect: async () => client } as unknown as Pool, client };
}

test("the shared lock only exists on the maintenance database and refuses a second holder", async () => {
  const wrongDb = fakePool(() => [{ databaseName: REGRESSION_DATABASE }]);
  await assert.rejects(() => acquireSharedResourceLock(wrongDb.pool, "probe"), /maintenance database/);
  assert.deepEqual(wrongDb.client.destroyed, [true]);

  const contended = fakePool((text) => (/current_database/.test(text) ? [{ databaseName: "postgres" }] : [{ acquired: false }]));
  await assert.rejects(() => acquireSharedResourceLock(contended.pool, "probe"), /already in use by another process/);
  assert.deepEqual(contended.client.destroyed, [true]);

  const acquired = fakePool((text) => (/current_database/.test(text) ? [{ databaseName: "postgres" }] : [{ acquired: true }]));
  const client = await acquireSharedResourceLock(acquired.pool, "probe");
  assert.equal(client, acquired.client);
  assert.ok(acquired.client.queries.some((q) => q.values?.[0] === REGRESSION_RESOURCE_LOCK_KEY));
});

test("suites never wipe the shared target in place; they require a freshly reset run", async () => {
  const previous = process.env.ZZSH_REGRESSION_RUN;
  try {
    process.env.ZZSH_REGRESSION_RUN = "nonce_current_run_0001";
    const matching = { query: async () => ({ rows: [{ run: "nonce_current_run_0001" }] }) };
    await assertFreshRegressionRun(matching as unknown as Pool);
    const stale = { query: async () => ({ rows: [{ run: "nonce_previous_run_0000" }] }) };
    await assert.rejects(() => assertFreshRegressionRun(stale as unknown as Pool), /was not reset for this run/);
    delete process.env.ZZSH_REGRESSION_RUN;
    await assert.rejects(() => assertFreshRegressionRun(matching as unknown as Pool), /ZZSH_REGRESSION_RUN is required/);
  } finally {
    if (previous === undefined) delete process.env.ZZSH_REGRESSION_RUN; else process.env.ZZSH_REGRESSION_RUN = previous;
  }
});

test("the FND fixture marker is prepared once for the shared target and never retargets a foreign row", async () => {
  const env = { ...dailyEnv, APP_PROFILE: "test", DB_NAME: REGRESSION_DATABASE };
  const config = loadFnd004TestConfig(env, process.cwd());
  const identity = { database_name: REGRESSION_DATABASE, user_name: "zzsh", server_port: "5432" };
  const legacy = { ...config, database: { ...config.database, name: "zzsh_test_fnd004" } } as typeof config;

  const prepared = fakePool((text) => {
    if (/current_database/.test(text)) return [identity];
    if (/SELECT database_name FROM/.test(text)) return [{ database_name: "zzsh_test_fnd004" }];
    return [{}];
  });
  await prepareFndFixtureMarker(prepared.client, config);
  assert.ok(prepared.client.queries.some((q) => /UPDATE "zzsh_meta"."database_marker"/.test(q.text)));

  const already = fakePool((text) => (/current_database/.test(text) ? [identity] : [{ database_name: REGRESSION_DATABASE }]));
  await prepareFndFixtureMarker(already.client, config);
  assert.equal(already.client.queries.some((q) => /UPDATE/.test(q.text)), false);

  const foreign = fakePool((text) => (/current_database/.test(text) ? [identity] : [{ database_name: "zzsh_test_other" }]));
  await assert.rejects(() => prepareFndFixtureMarker(foreign.client, config), /refusing to retarget a foreign marker/);

  const absent = fakePool((text) => (/current_database/.test(text) ? [identity] : []));
  await assert.rejects(() => prepareFndFixtureMarker(absent.client, config), /formal marker row is absent/);
  void legacy;
});

test("the guarded wipe entry accepts only the regression database", () => {
  const approved = { ...dailyEnv, APP_PROFILE: "test", DB_NAME: REGRESSION_DATABASE };
  assert.equal(loadFnd004TestConfig(approved, process.cwd()).database.name, REGRESSION_DATABASE);
  for (const [env, expected] of [
    [{ ...approved, DB_NAME: "zzsh_dev" }, /outside the test target boundary/],
    [{ ...approved, DB_NAME: "zzsh_test_order_milestone_real_1" }, /not the approved isolated test database/],
    [{ ...dailyEnv, DB_NAME: "zzsh_dev" }, /APP_PROFILE=test/],
    [{ ...approved, PROVIDER_MODE: "real" }, /PROVIDER_MODE=fake/],
    [{ ...approved, DB_HOST: "127.0.0.2" }, /must use 127\.0\.0\.1/],
    [{ ...approved, DB_USER: "zzsh_regression_runtime" }, /not the approved isolated test database/],
  ] as Array<[Record<string, string>, RegExp]>) {
    assert.throws(() => loadFnd004TestConfig(env, process.cwd()), expected);
  }
});

test("no daily configuration grants the regression creation permission", () => {
  assert.throws(() => admitTestDatabase(admission, dailyEnv), /REGRESSION_TEST_ALLOW_NEW_RESOURCE=1/);
  assert.equal(admitTestDatabase(admission, { [REGRESSION_ALLOW_NEW_RESOURCE]: "1" }), "CREATE");
});

test("every shared-database suite resolves through the registry and keeps no private default", () => {
  for (const file of SUITES) {
    const source = readFileSync(resolve(__dirname, "../../test", file), "utf8");
    assert.match(source, /REGRESSION_DATABASE/, `${file} must reuse the regression database`);
    assert.match(source, /REGRESSION_ALLOW_NEW_RESOURCE/, `${file} must reuse the regression create permission`);
    assert.match(source, /databaseOid: \S+\.rows\[0\]\?\.databaseOid/, `${file} must read the database OID`);
    assert.doesNotMatch(source, /DEFAULT_(?:TEST_)?DATABASE = "zzsh_test_/, `${file} must not default to a suite-local database`);
    assert.doesNotMatch(source, /RESOURCE_MARKER = "zzsh:/, `${file} must not default to a suite-local marker`);
    assert.doesNotMatch(source, /(?:RESOURCE_)?LOCK_KEY = "\d/, `${file} must not default to a suite-local lock`);
    assert.doesNotMatch(source, /allowFlag: "[A-Z0-9_]*ALLOW_NEW_RESOURCE"/, `${file} must not keep a suite-local create flag`);
    assert.doesNotMatch(source, /_TEST_DB_NAME\?|_TEST_MIGRATION_USER\?|_TEST_RUNTIME_USER\?/, `${file} must not accept a free database or role override`);
  }
  for (const file of ["auth.test.ts", "content-foundation.test.ts", "supply-m3b.test.ts", "order-reservation.test.ts", "user-directory.test.ts"]) {
    assert.match(readFileSync(resolve(__dirname, "../../test", file), "utf8"), /registeredException\(/, `${file} must resolve exceptions through the registry`);
  }
});

test("the regression suites are declared serial because they share one database", () => {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8")) as { scripts: Record<string, string> };
  const script = pkg.scripts["test:db:compiled"] ?? "";
  assert.ok(script.includes("scripts/run-regression-suites.mjs"), "the default database entry must use the controlled serial reset runner");
  assert.ok(script.includes("dist/test/database-safety.test.js"), "keep the original offline safety gate before any PostgreSQL suites");
});
