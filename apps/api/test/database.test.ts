import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { test } from "node:test";

import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { integer, numeric, pgSchema, text } from "drizzle-orm/pg-core";
import { Pool, type PoolClient } from "pg";

import { loadConfig } from "../src/config/config";
import {
  closeResource,
  DATABASE_CLEANUP_TIMEOUT_MS,
  settlesWithin,
} from "./database-test-support";

const LOCAL_TARGET = {
  target: "local-compose",
  host: "127.0.0.1",
  port: 55432,
  user: "zzsh",
} as const;
const TEST_DATABASE = "zzsh_test_fnd003";
const TEST_SCHEMA = "fnd003";
const RESOURCE_LOCK_KEY = "803003";

const fnd003 = pgSchema(TEST_SCHEMA);
const probe = fnd003.table("probe", {
  id: integer("id").primaryKey(),
  uniqueKey: text("unique_key").notNull(),
  amount: numeric("amount", { precision: 30, scale: 9 }).notNull(),
  note: text("note").notNull(),
});

type Identity = {
  databaseName: string;
  userName: string;
  serverPort: string;
  serverVersion: string;
};

async function assertIdentity(
  client: Pool | PoolClient,
  expectedDatabase: string,
): Promise<Identity> {
  const result = await client.query<{
    database_name: string;
    user_name: string;
    server_port: string;
    server_version: string;
  }>(
    "SELECT current_database() AS database_name, current_user AS user_name, current_setting('port') AS server_port, current_setting('server_version') AS server_version",
  );
  const row = result.rows[0];
  assert.ok(row, "PostgreSQL identity query returned no row");
  assert.equal(row.database_name, expectedDatabase);
  assert.equal(row.user_name, LOCAL_TARGET.user);
  assert.equal(row.server_port, "5432");
  return {
    databaseName: row.database_name,
    userName: row.user_name,
    serverPort: row.server_port,
    serverVersion: row.server_version,
  };
}

async function waitForBlocked(observer: PoolClient, blockedPid: number): Promise<void> {
  const deadline = Date.now() + DATABASE_CLEANUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const result = await observer.query<{ blocked: boolean }>(
      "SELECT cardinality(pg_blocking_pids($1::integer)) > 0 AS blocked",
      [blockedPid],
    );
    if (result.rows[0]?.blocked) return;
    await new Promise<void>((resolvePromise) => setImmediate(resolvePromise));
  }
  throw new Error("PostgreSQL lock wait was not observed before the cleanup timeout");
}

async function rollbackAndRelease(client: PoolClient | undefined): Promise<void> {
  if (!client) return;
  try {
    await client.query("ROLLBACK");
  } catch {
    // The connection may already have been closed after a failed assertion.
  }
  client.release();
}

type OperationOutcome =
  | { status: "fulfilled" }
  | { status: "rejected"; error: unknown };

async function rollbackAndReleaseAfterPending(
  client: PoolClient | undefined,
  pending: Promise<OperationOutcome> | undefined,
): Promise<boolean> {
  if (!client) return true;
  if (pending && !(await settlesWithin(pending))) {
    client.release(true);
    return settlesWithin(pending);
  }
  await rollbackAndRelease(client);
  return true;
}

function loadTestConfig() {
  const config = loadConfig({
    ...process.env,
    APP_PROFILE: "test",
    PROVIDER_MODE: "fake",
    DB_TARGET: "local-compose",
    DB_NAME: TEST_DATABASE,
  });
  assert.equal(config.profile, "test");
  assert.equal(config.provider, "fake");
  assert.equal(config.database.name, TEST_DATABASE);
  assert.equal(config.database.target, LOCAL_TARGET.target);
  assert.equal(config.database.host, LOCAL_TARGET.host);
  assert.equal(config.database.port, LOCAL_TARGET.port);
  assert.equal(config.database.user, LOCAL_TARGET.user);
  return config;
}

async function schemaOwner(client: PoolClient): Promise<string | undefined> {
  const result = await client.query<{ owner: string }>(
    "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1",
    [TEST_SCHEMA],
  );
  return result.rows[0]?.owner;
}

async function prepareSchema(client: PoolClient): Promise<void> {
  const existingOwner = await schemaOwner(client);
  if (existingOwner !== undefined && existingOwner !== LOCAL_TARGET.user) {
    throw new Error("FND-003 schema ownership is outside the verified test target");
  }
  await client.query("BEGIN");
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${TEST_SCHEMA}" CASCADE`);
    await client.query(`CREATE SCHEMA "${TEST_SCHEMA}"`);
    assert.equal(await schemaOwner(client), LOCAL_TARGET.user);
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Destroying the guard connection below also rolls back its transaction.
    }
    throw error;
  }
}

async function cleanupSchema(client: PoolClient): Promise<void> {
  await assertIdentity(client, TEST_DATABASE);
  const owner = await schemaOwner(client);
  if (owner === undefined) return;
  assert.equal(owner, LOCAL_TARGET.user);
  await client.query("BEGIN");
  try {
    const ownerInTransaction = await schemaOwner(client);
    if (ownerInTransaction !== undefined) {
      assert.equal(ownerInTransaction, LOCAL_TARGET.user);
      await client.query(`DROP SCHEMA "${TEST_SCHEMA}" CASCADE`);
    }
    await client.query("COMMIT");
  } catch (error) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // The guard is closed by the caller even if rollback itself fails.
    }
    throw error;
  }
}

async function acquireResourceGuard(pool: Pool): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    await assertIdentity(client, TEST_DATABASE);
    const result = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [RESOURCE_LOCK_KEY],
    );
    if (!result.rows[0]?.acquired) {
      throw new Error("FND-003 test schema is already being verified");
    }
    return client;
  } catch (error) {
    client.release(true);
    throw error;
  }
}

test("real PostgreSQL with Drizzle satisfies FND-003 criteria", async () => {
  const appConfig = loadTestConfig();
  assert.notEqual(TEST_DATABASE, "zzsh_dev");
  const connection = {
    host: appConfig.database.host,
    port: appConfig.database.port,
    user: appConfig.database.user,
    password: appConfig.database.password,
    application_name: "zzsh-fnd003-test",
    connectionTimeoutMillis: 2_000,
  };
  const adminPool = new Pool({ ...connection, database: "postgres", max: 1 });
  let testPool: Pool | undefined;
  let resourceGuard: PoolClient | undefined;
  let cleanupAuthorized = false;

  try {
    await assertIdentity(adminPool, "postgres");
    const databaseResult = await adminPool.query<{ owner: string }>(
      "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1",
      [TEST_DATABASE],
    );
    if (databaseResult.rows.length === 0) {
      await adminPool.query(`CREATE DATABASE "${TEST_DATABASE}" OWNER "${LOCAL_TARGET.user}"`);
    } else {
      assert.equal(databaseResult.rows[0]?.owner, LOCAL_TARGET.user);
    }

    testPool = new Pool({ ...connection, database: TEST_DATABASE, max: 6 });
    await assertIdentity(testPool, TEST_DATABASE);
    resourceGuard = await acquireResourceGuard(testPool);
    await prepareSchema(resourceGuard);
    cleanupAuthorized = true;
    const concurrentGuard = await testPool.connect();
    try {
      const guardResult = await concurrentGuard.query<{ acquired: boolean }>(
        "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
        [RESOURCE_LOCK_KEY],
      );
      assert.equal(guardResult.rows[0]?.acquired, false);
    } finally {
      await rollbackAndRelease(concurrentGuard);
    }

    const db = drizzle(testPool);
    const migrationsFolder = resolve(__dirname, "../../test/fixtures/drizzle-migrations");
    const migrationConfig = {
      migrationsFolder,
      migrationsSchema: TEST_SCHEMA,
      migrationsTable: "migrations",
    };

    await migrate(db, migrationConfig);
    const firstMigration = await testPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "${TEST_SCHEMA}"."migrations"`,
    );
    assert.equal(firstMigration.rows[0]?.count, "1");
    await migrate(db, migrationConfig);
    const repeatedMigration = await testPool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM "${TEST_SCHEMA}"."migrations"`,
    );
    assert.equal(repeatedMigration.rows[0]?.count, "1");

    await db.delete(probe);
    await db.transaction(async (tx) => {
      await tx.insert(probe).values({
        id: 101,
        uniqueKey: "transaction-commit",
        amount: "10.000000000",
        note: "committed",
      });
    });
    const committedRows = await db
      .select({ id: probe.id })
      .from(probe)
      .where(eq(probe.id, 101));
    assert.deepEqual(committedRows.map((row) => row.id), [101]);

    const rollbackError = new Error("fnd003 controlled rollback");
    await assert.rejects(
      db.transaction(async (tx) => {
        await tx.insert(probe).values({
          id: 102,
          uniqueKey: "transaction-rollback",
          amount: "11.000000000",
          note: "rolled back",
        });
        throw rollbackError;
      }),
      (error: unknown) => error === rollbackError,
    );
    const rolledBackRows = await db
      .select({ id: probe.id })
      .from(probe)
      .where(eq(probe.id, 102));
    assert.equal(rolledBackRows.length, 0);

    await db.delete(probe);
    const uniqueA = await testPool.connect();
    const uniqueB = await testPool.connect();
    const uniqueObserver = await testPool.connect();
    let uniqueAttempt: Promise<OperationOutcome> | undefined;
    try {
      const uniqueBDatabase = drizzle(uniqueB);
      await uniqueA.query("BEGIN");
      await drizzle(uniqueA).insert(probe).values({
        id: 201,
        uniqueKey: "concurrent-unique",
        amount: "20.000000000",
        note: "winner",
      });
      const pidResult = await uniqueB.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const blockedPid = pidResult.rows[0]?.pid;
      assert.ok(blockedPid);
      await uniqueB.query("BEGIN");
      await uniqueB.query("SET LOCAL statement_timeout = '2000ms'");
      let uniqueSettled = false;
      uniqueAttempt = uniqueBDatabase
        .insert(probe)
        .values({
          id: 202,
          uniqueKey: "concurrent-unique",
          amount: "21.000000000",
          note: "loser",
        })
        .then(
          () => ({ status: "fulfilled" as const }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        )
        .finally(() => {
          uniqueSettled = true;
        });
      await waitForBlocked(uniqueObserver, blockedPid);
      assert.equal(uniqueSettled, false);
      await uniqueA.query("COMMIT");
      assert.ok(uniqueAttempt);
      const uniqueOutcome = await uniqueAttempt;
      assert.equal(uniqueOutcome.status, "rejected");
      if (uniqueOutcome.status === "rejected") {
        const uniqueError = uniqueOutcome.error as {
          code?: string;
          cause?: { code?: string };
        };
        assert.equal(uniqueError.code ?? uniqueError.cause?.code, "23505");
      }
      await uniqueB.query("ROLLBACK");
      const uniqueRows = await db
        .select({ id: probe.id })
        .from(probe)
        .where(eq(probe.uniqueKey, "concurrent-unique"));
      assert.deepEqual(uniqueRows.map((row) => row.id), [201]);
    } finally {
      await rollbackAndRelease(uniqueA);
      await rollbackAndReleaseAfterPending(uniqueB, uniqueAttempt);
      await rollbackAndRelease(uniqueObserver);
    }

    await db.delete(probe);
    await db.insert(probe).values({
      id: 301,
      uniqueKey: "row-lock",
      amount: "30.000000000",
      note: "before-lock",
    });
    const lockA = await testPool.connect();
    const lockB = await testPool.connect();
    const lockObserver = await testPool.connect();
    let lockAttempt: Promise<OperationOutcome> | undefined;
    try {
      const lockADatabase = drizzle(lockA);
      const lockBDatabase = drizzle(lockB);
      await lockA.query("BEGIN");
      await lockADatabase.execute(
        sql`SELECT ${probe.id} FROM ${probe} WHERE ${probe.id} = ${301} FOR UPDATE`,
      );
      const pidResult = await lockB.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const blockedPid = pidResult.rows[0]?.pid;
      assert.ok(blockedPid);
      await lockB.query("BEGIN");
      await lockB.query("SET LOCAL statement_timeout = '2000ms'");
      let lockSettled = false;
      lockAttempt = lockBDatabase
        .update(probe)
        .set({ note: "after-lock" })
        .where(eq(probe.id, 301))
        .then(
          () => ({ status: "fulfilled" as const }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        )
        .finally(() => {
          lockSettled = true;
        });
      await waitForBlocked(lockObserver, blockedPid);
      assert.equal(lockSettled, false);
      await lockA.query("COMMIT");
      assert.ok(lockAttempt);
      const lockOutcome = await lockAttempt;
      assert.equal(lockOutcome.status, "fulfilled");
      await lockB.query("COMMIT");
      const lockedRows = await db
        .select({ note: probe.note })
        .from(probe)
        .where(eq(probe.id, 301));
      assert.equal(lockedRows[0]?.note, "after-lock");
    } finally {
      await rollbackAndRelease(lockA);
      await rollbackAndReleaseAfterPending(lockB, lockAttempt);
      await rollbackAndRelease(lockObserver);
    }

    await db.delete(probe);
    await db.insert(probe).values({
      id: 302,
      uniqueKey: "row-lock-failure",
      amount: "31.000000000",
      note: "failure-cleanup",
    });
    const failureA = await testPool.connect();
    const failureB = await testPool.connect();
    const failureObserver = await testPool.connect();
    let failureAttempt: Promise<OperationOutcome> | undefined;
    const injectedFailure = new Error("fnd003 injected lock cleanup failure");
    try {
      await failureA.query("BEGIN");
      await drizzle(failureA).execute(
        sql`SELECT ${probe.id} FROM ${probe} WHERE ${probe.id} = ${302} FOR UPDATE`,
      );
      const pidResult = await failureB.query<{ pid: number }>(
        "SELECT pg_backend_pid() AS pid",
      );
      const blockedPid = pidResult.rows[0]?.pid;
      assert.ok(blockedPid);
      await failureB.query("BEGIN");
      await failureB.query("SET LOCAL statement_timeout = '2000ms'");
      failureAttempt = drizzle(failureB)
        .update(probe)
        .set({ note: "should-not-commit" })
        .where(eq(probe.id, 302))
        .then(
          () => ({ status: "fulfilled" as const }),
          (error: unknown) => ({ status: "rejected" as const, error }),
        );
      await waitForBlocked(failureObserver, blockedPid);
      throw injectedFailure;
    } catch (error) {
      assert.equal(error, injectedFailure);
    } finally {
      await rollbackAndRelease(failureA);
      const failureSettled = await rollbackAndReleaseAfterPending(failureB, failureAttempt);
      try {
        assert.equal(failureSettled, true);
      } finally {
        await rollbackAndRelease(failureObserver);
      }
    }
    const postFailure = await testPool.connect();
    try {
      await postFailure.query(
        `SELECT id FROM "${TEST_SCHEMA}"."probe" WHERE id = $1 FOR UPDATE NOWAIT`,
        [302],
      );
    } finally {
      await rollbackAndRelease(postFailure);
    }
    const failedUpdateRows = await db
      .select({ note: probe.note })
      .from(probe)
      .where(eq(probe.id, 302));
    assert.equal(failedUpdateRows[0]?.note, "failure-cleanup");

    await db.delete(probe);
    const exactAmount = "12345678901234567890.123456789";
    await db.insert(probe).values({
      id: 401,
      uniqueKey: "exact-money",
      amount: exactAmount,
      note: "numeric-string",
    });
    const amountRows = await db
      .select({ amount: probe.amount })
      .from(probe)
      .where(eq(probe.id, 401));
    assert.equal(typeof amountRows[0]?.amount, "string");
    assert.equal(amountRows[0]?.amount, exactAmount);
  } finally {
    let cleanupError: unknown;
    if (resourceGuard) {
      try {
        await closeResource(cleanupAuthorized, resourceGuard, () => cleanupSchema(resourceGuard!));
      } catch (error) {
        cleanupError = error;
      }
    }
    try {
      if (testPool) await testPool.end();
    } finally {
      await adminPool.end();
    }
    if (cleanupError) throw cleanupError;
  }
});
