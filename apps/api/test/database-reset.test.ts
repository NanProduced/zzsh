import { strict as assert } from "node:assert";
import { resolve } from "node:path";
import { test } from "node:test";

import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { Pool, type PoolClient } from "pg";

import { runFormalMigrations } from "../src/database/migrations";
import {
  acquireFnd004Lease,
  FND004_MARKER_KEY,
  FND004_TEST_DATABASE,
  FND004_TEST_SCHEMA,
  type Fnd004Lease,
  loadFnd004TestConfig,
  releaseFnd004Lease,
  resetTestDatabase,
  resetWithFnd004Lease,
  resetVerifiedTestSchema,
} from "../src/database/reset";
import { finishDatabaseTest } from "./database-test-support";

async function assertIdentity(
  client: Pool | PoolClient,
  expectedDatabase: string,
): Promise<void> {
  const result = await client.query<{
    database_name: string;
    user_name: string;
    server_port: string;
  }>(
    "SELECT current_database() AS database_name, current_user AS user_name, current_setting('port') AS server_port",
  );
  assert.equal(result.rows[0]?.database_name, expectedDatabase);
  assert.equal(result.rows[0]?.user_name, "zzsh");
  assert.equal(result.rows[0]?.server_port, "5432");
}

async function ensureTestDatabase(adminPool: Pool): Promise<void> {
  const result = await adminPool.query<{ owner: string }>(
    "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = $1",
    [FND004_TEST_DATABASE],
  );
  if (result.rows.length === 0) {
    await adminPool.query(`CREATE DATABASE "${FND004_TEST_DATABASE}" OWNER "zzsh"`);
  } else {
    assert.equal(result.rows[0]?.owner, "zzsh");
  }
}

async function relationName(pool: Pool, qualifiedName: string): Promise<string | null> {
  const result = await pool.query<{ relation: string | null }>(
    "SELECT to_regclass($1) AS relation",
    [qualifiedName],
  );
  return result.rows[0]?.relation ?? null;
}

async function sentinelValue(pool: Pool): Promise<string | null> {
  const result = await pool.query<{ value: string }>(
    `SELECT value FROM "${FND004_TEST_SCHEMA}"."sentinel" WHERE id = $1`,
    [1],
  );
  return result.rows[0]?.value ?? null;
}

async function runProbeMigrations(pool: Pool): Promise<void> {
  await migrate(drizzle(pool), {
    migrationsFolder: resolve(__dirname, "../../test/fixtures/fnd004-migrations"),
    migrationsSchema: FND004_TEST_SCHEMA,
    migrationsTable: "migrations",
  });
}

test("FND-004 formal migration and guarded reset are deterministic", async () => {
  const testEnv = {
    ...process.env,
    APP_PROFILE: "test",
    PROVIDER_MODE: "fake",
    DB_TARGET: "local-compose",
    DB_NAME: FND004_TEST_DATABASE,
  };
  const config = loadFnd004TestConfig(testEnv);
  const connection = {
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    application_name: "zzsh-fnd004-test",
    connectionTimeoutMillis: 2_000,
  };
  const adminPool = new Pool({ ...connection, database: "postgres", max: 1 });
  let testPool: Pool | undefined;
  let markerReady = false;
  let lease: Fnd004Lease | undefined;
  let primaryError: unknown;

  try {
    try {
      await assertIdentity(adminPool, "postgres");
      await ensureTestDatabase(adminPool);
      testPool = new Pool({ ...connection, database: FND004_TEST_DATABASE, max: 4 });
      await assertIdentity(testPool, FND004_TEST_DATABASE);

      const activeLease = await acquireFnd004Lease(testPool, config, false);
      lease = activeLease;
      await runFormalMigrations(activeLease.client);
      await runFormalMigrations(activeLease.client);
      const formalMigrations = await activeLease.client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "zzsh_meta"."migrations"`,
      );
      assert.equal(formalMigrations.rows[0]?.count, "1");

      await resetWithFnd004Lease(activeLease);
      markerReady = true;
      assert.equal(await relationName(testPool, `${FND004_TEST_SCHEMA}.probe`), null);
      await runProbeMigrations(testPool);
      await testPool.query(
        `INSERT INTO "${FND004_TEST_SCHEMA}"."sentinel" (id, value) VALUES ($1, $2)`,
        [1, "keep-me"],
      );
      await testPool.query(
        `INSERT INTO "${FND004_TEST_SCHEMA}"."probe" (id, value) VALUES ($1, $2)`,
        [1, "before-reset"],
      );

      await assert.rejects(
        () => resetTestDatabase(testEnv),
        /test schema reset is already running/,
      );
      assert.equal(await sentinelValue(testPool), "keep-me");

      await adminPool.query(`ALTER DATABASE "${FND004_TEST_DATABASE}" OWNER TO "pg_monitor"`);
      try {
        await assert.rejects(
          () => resetTestDatabase(testEnv),
          /database owner verification failed/,
        );
        assert.equal(await sentinelValue(testPool), "keep-me");
      } finally {
        await adminPool.query(`ALTER DATABASE "${FND004_TEST_DATABASE}" OWNER TO "zzsh"`);
      }

      const wrongRoleClient = await testPool.connect();
      try {
        await wrongRoleClient.query(`SET ROLE "pg_monitor"`);
        await assert.rejects(
          () => resetVerifiedTestSchema(wrongRoleClient, config),
          /database identity verification failed/,
        );
        assert.equal(await sentinelValue(testPool), "keep-me");
      } finally {
        await wrongRoleClient.query("RESET ROLE").catch(() => undefined);
        wrongRoleClient.release();
      }

      await assert.rejects(
        () => resetTestDatabase({ ...testEnv, DB_NAME: "zzsh_dev" }),
        /test target boundary|approved isolated test database/,
      );
      assert.equal(await sentinelValue(testPool), "keep-me");

      await assert.rejects(
        () => resetTestDatabase({ ...testEnv, DB_HOST: "127.0.0.2" }),
        /local-compose databases must use 127\.0\.0\.1|approved isolated test database/,
      );
      assert.equal(await sentinelValue(testPool), "keep-me");

      const wrongIdentityClient = await adminPool.connect();
      try {
        await assert.rejects(
          () => resetVerifiedTestSchema(wrongIdentityClient, config),
          /database identity verification failed/,
        );
      } finally {
        wrongIdentityClient.release();
      }
      assert.equal(await sentinelValue(testPool), "keep-me");

      await testPool.query(
        `UPDATE "zzsh_meta"."database_marker" SET database_name = $1 WHERE marker_key = $2`,
        ["wrong-target", FND004_MARKER_KEY],
      );
      try {
        await assert.rejects(
          () => resetTestDatabase(testEnv),
          /database marker verification failed/,
        );
        assert.equal(await sentinelValue(testPool), "keep-me");
      } finally {
        await testPool.query(
          `UPDATE "zzsh_meta"."database_marker" SET database_name = $1 WHERE marker_key = $2`,
          [FND004_TEST_DATABASE, FND004_MARKER_KEY],
        );
      }

      await resetWithFnd004Lease(activeLease);
      assert.equal(await relationName(testPool, `${FND004_TEST_SCHEMA}.probe`), null);

      await runProbeMigrations(testPool);
      const repeatedProbeMigrations = await testPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "${FND004_TEST_SCHEMA}"."migrations"`,
      );
      assert.equal(repeatedProbeMigrations.rows[0]?.count, "1");

      await assert.rejects(
        () =>
          migrate(drizzle(testPool!), {
            migrationsFolder: resolve(__dirname, "../../test/fixtures/fnd004-failing-migrations"),
            migrationsSchema: FND004_TEST_SCHEMA,
            migrationsTable: "failed_migrations",
          }),
        /syntax error|not valid|failed/i,
      );
      assert.equal(await relationName(testPool, `${FND004_TEST_SCHEMA}.rollback_probe`), null);
      const failedMigrationRows = await testPool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM "${FND004_TEST_SCHEMA}"."failed_migrations"`,
      );
      assert.equal(failedMigrationRows.rows[0]?.count, "0");
      await resetWithFnd004Lease(activeLease);
      assert.equal(await relationName(testPool, `${FND004_TEST_SCHEMA}.rollback_probe`), null);
      await releaseFnd004Lease(activeLease);
      lease = undefined;
      // This is a separate, final independent-reset check; no later cleanup follows it.
      await resetTestDatabase(testEnv);
    } catch (error) {
      primaryError = error;
    }
  } finally {
    await finishDatabaseTest(
      primaryError,
      async () => {
        let cleanupError: unknown;
        if (lease) {
          try {
            if (markerReady) await resetWithFnd004Lease(lease);
          } catch (error) {
            cleanupError = error;
          }
          try {
            await releaseFnd004Lease(lease);
          } catch (error) {
            cleanupError ??= error;
          } finally {
            lease = undefined;
          }
        }
        if (cleanupError) throw cleanupError;
      },
      async () => {
        if (testPool) await testPool.end();
      },
      async () => {
        await adminPool.end();
      },
    );
  }
});
