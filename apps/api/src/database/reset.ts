import { Pool, type PoolClient } from "pg";

import {
  ConfigurationError,
  loadConfig,
  type AppConfig,
} from "../config/config";
import { MAINTENANCE_DATABASE, REGRESSION_DATABASE, REGRESSION_RESOURCE_LOCK_KEY } from "../config/test-resource";

export const FND004_TEST_SCHEMA = "fnd004_probe";
export const FND004_TEST_TARGET = "zzsh-rebuild-local";
export const FND004_MARKER_KEY = "fnd004-test-database";

const LOCAL_HOST = "127.0.0.1";
const LOCAL_DB_PORT = 55432;
const POSTGRES_SERVER_PORT = "5432";
const RESET_LOCK_KEY = "804004";

export type Fnd004Lease = {
  client: PoolClient;
  config: AppConfig;
};

function assertApprovedConfig(config: AppConfig): void {
  if (config.profile !== "test" || config.provider !== "fake") {
    throw new ConfigurationError("FND-004 reset requires APP_PROFILE=test and PROVIDER_MODE=fake");
  }
  if (
    config.database.target !== "local-compose" ||
    config.database.host !== LOCAL_HOST ||
    config.database.port !== LOCAL_DB_PORT ||
    config.database.user !== "zzsh" ||
    config.database.name !== REGRESSION_DATABASE
  ) {
    throw new ConfigurationError("FND-004 reset target is not the approved isolated test database");
  }
}

export function loadFnd004TestConfig(
  env: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): AppConfig {
  const config = loadConfig(env, workingDirectory);
  assertApprovedConfig(config);
  return config;
}

async function assertTargetIdentity(client: PoolClient, config: AppConfig): Promise<void> {
  const result = await client.query<{
    database_name: string;
    user_name: string;
    server_port: string;
  }>(
    "SELECT current_database() AS database_name, current_user AS user_name, current_setting('port') AS server_port",
  );
  const row = result.rows[0];
  if (
    !row ||
    row.database_name !== config.database.name ||
    row.user_name !== config.database.user ||
    row.server_port !== POSTGRES_SERVER_PORT
  ) {
    throw new Error("FND-004 database identity verification failed");
  }
}

async function assertDatabaseOwner(client: PoolClient, config: AppConfig): Promise<void> {
  const databaseResult = await client.query<{ owner: string }>(
    "SELECT pg_get_userbyid(datdba) AS owner FROM pg_database WHERE datname = current_database()",
  );
  if (databaseResult.rows[0]?.owner !== config.database.user) {
    throw new Error("FND-004 database owner verification failed");
  }

  const roleResult = await client.query<{ role_name: string; can_login: boolean }>(
    "SELECT rolname AS role_name, rolcanlogin AS can_login FROM pg_roles WHERE rolname = current_user",
  );
  if (roleResult.rows[0]?.role_name !== config.database.user || !roleResult.rows[0]?.can_login) {
    throw new Error("FND-004 database role verification failed");
  }
}

async function assertMarker(client: PoolClient, config: AppConfig): Promise<void> {
  const ownerResult = await client.query<{ owner: string }>(
    "SELECT pg_get_userbyid(c.relowner) AS owner FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'",
    ["zzsh_meta", "database_marker"],
  );
  if (ownerResult.rows[0]?.owner !== config.database.user) {
    throw new Error("FND-004 database marker ownership verification failed");
  }

  const markerResult = await client.query<{
    database_name: string;
    target: string;
    role_name: string;
    marker_version: number;
  }>(
    "SELECT database_name, target, role_name, marker_version FROM \"zzsh_meta\".\"database_marker\" WHERE marker_key = $1",
    [FND004_MARKER_KEY],
  );
  const marker = markerResult.rows[0];
  if (
    !marker ||
    marker.database_name !== config.database.name ||
    marker.target !== FND004_TEST_TARGET ||
    marker.role_name !== config.database.user ||
    marker.marker_version !== 1
  ) {
    throw new Error("FND-004 database marker verification failed");
  }
}

async function schemaOwner(client: PoolClient): Promise<string | undefined> {
  const result = await client.query<{ owner: string }>(
    "SELECT pg_get_userbyid(nspowner) AS owner FROM pg_namespace WHERE nspname = $1",
    [FND004_TEST_SCHEMA],
  );
  return result.rows[0]?.owner;
}

async function acquireLeaseOnClient(
  client: PoolClient,
  config: AppConfig,
  requireMarker = true,
): Promise<Fnd004Lease> {
  assertApprovedConfig(config);
  await assertTargetIdentity(client, config);
  await assertDatabaseOwner(client, config);
  if (requireMarker) await assertMarker(client, config);
  await client.query("SET lock_timeout = '2000ms'");
  await client.query("SET statement_timeout = '5000ms'");

  let acquired = false;
  try {
    const lockResult = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [RESET_LOCK_KEY],
    );
    if (!lockResult.rows[0]?.acquired) {
      throw new Error("FND-004 test schema reset is already running");
    }
    acquired = true;
    await assertTargetIdentity(client, config);
    await assertDatabaseOwner(client, config);
    if (requireMarker) await assertMarker(client, config);
    return { client, config };
  } catch (error) {
    if (acquired) {
      try {
        await client.query("SELECT pg_advisory_unlock($1::bigint)", [RESET_LOCK_KEY]);
      } catch {
        // Closing the client releases the advisory lock if the session is broken.
      }
    }
    throw error;
  }
}

export async function acquireFnd004Lease(
  pool: Pool,
  config: AppConfig,
  requireMarker = true,
): Promise<Fnd004Lease> {
  const client = await pool.connect();
  try {
    return await acquireLeaseOnClient(client, config, requireMarker);
  } catch (error) {
    client.release(true);
    throw error;
  }
}

export async function releaseFnd004Lease(lease: Fnd004Lease): Promise<void> {
  try {
    await lease.client.query("SELECT pg_advisory_unlock($1::bigint)", [RESET_LOCK_KEY]);
    lease.client.release();
  } catch {
    lease.client.release(true);
  }
}

export async function resetWithFnd004Lease(lease: Fnd004Lease): Promise<void> {
  assertApprovedConfig(lease.config);
  await assertTargetIdentity(lease.client, lease.config);
  await assertDatabaseOwner(lease.client, lease.config);
  await assertMarker(lease.client, lease.config);

  const existingOwner = await schemaOwner(lease.client);
  if (existingOwner !== undefined && existingOwner !== lease.config.database.user) {
    throw new Error("FND-004 test schema ownership verification failed");
  }

  await lease.client.query("BEGIN");
  try {
    await lease.client.query(`DROP SCHEMA IF EXISTS "${FND004_TEST_SCHEMA}" CASCADE`);
    await lease.client.query(`CREATE SCHEMA "${FND004_TEST_SCHEMA}" AUTHORIZATION "zzsh"`);
    if (await schemaOwner(lease.client) !== lease.config.database.user) {
      throw new Error("FND-004 recreated schema ownership verification failed");
    }
    await lease.client.query("COMMIT");
  } catch (error) {
    try {
      await lease.client.query("ROLLBACK");
    } catch {
      // Closing the verified connection also rolls back an open transaction.
    }
    throw error;
  }
}

export async function resetVerifiedTestSchema(
  client: PoolClient,
  config: AppConfig,
): Promise<void> {
  const lease = await acquireLeaseOnClient(client, config);
  try {
    await resetWithFnd004Lease(lease);
  } finally {
    await releaseFnd004Lease(lease);
  }
}

// The formal 0000 SQL still inserts the original database name, so the shared regression target gets
// its marker row prepared here and then verified by the reset entry - the SQL bytes stay untouched.
// Only the known legacy name may be retargeted, once; anything else is refused rather than rewritten.
export async function prepareFndFixtureMarker(client: PoolClient, config: AppConfig): Promise<void> {
  assertApprovedConfig(config);
  await assertTargetIdentity(client, config);
  const existing = await client.query<{ database_name: string }>(
    `SELECT database_name FROM "zzsh_meta"."database_marker" WHERE marker_key = $1`,
    [FND004_MARKER_KEY],
  );
  if (existing.rows.length === 0) throw new Error("FND-004 formal marker row is absent; run the formal migrations first");
  const current = existing.rows[0]!.database_name;
  if (current === config.database.name) return;
  if (current !== "zzsh_test_fnd004") throw new Error(`FND-004 marker points at ${current}; refusing to retarget a foreign marker`);
  await client.query(
    `UPDATE "zzsh_meta"."database_marker" SET database_name = $1, target = $2, role_name = $3, marker_version = 1 WHERE marker_key = $4`,
    [config.database.name, FND004_TEST_TARGET, config.database.user, FND004_MARKER_KEY],
  );
}

// Maintenance-database session lock shared with every compiled suite: an advisory lock is scoped to its
// database, so the in-database FND lease below is an inner lock only.
export async function acquireRegressionResourceLock(pool: Pool, label = "FND-004"): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    const identity = await client.query<{ database_name: string }>("SELECT current_database() AS database_name");
    if (identity.rows[0]?.database_name !== MAINTENANCE_DATABASE) throw new Error(`${label} must take the shared resource lock on the maintenance database`);
    const acquired = (await client.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [REGRESSION_RESOURCE_LOCK_KEY])).rows[0]?.acquired;
    if (acquired !== true) throw new Error(`${label}: the local test resource is already in use by another process`);
    return client;
  } catch (error) {
    client.release(true);
    throw error;
  }
}

export async function releaseRegressionResourceLock(client: PoolClient): Promise<void> {
  try {
    await client.query("SELECT pg_advisory_unlock($1::bigint)", [REGRESSION_RESOURCE_LOCK_KEY]);
    client.release();
  } catch {
    client.release(true);
  }
}

export async function resetTestDatabase(
  env: NodeJS.ProcessEnv = process.env,
  workingDirectory = process.cwd(),
): Promise<void> {
  const config = loadFnd004TestConfig(env, workingDirectory);
  const maintenancePool = new Pool({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: MAINTENANCE_DATABASE,
    application_name: "zzsh-fnd004-reset-lock",
    connectionTimeoutMillis: 2_000,
    max: 1,
  });
  const pool = new Pool({
    host: config.database.host,
    port: config.database.port,
    user: config.database.user,
    password: config.database.password,
    database: config.database.name,
    application_name: "zzsh-fnd004-reset",
    connectionTimeoutMillis: 2_000,
    max: 1,
  });
  let lockClient: PoolClient | undefined;
  let client: PoolClient | undefined;
  let lease: Fnd004Lease | undefined;
  try {
    lockClient = await acquireRegressionResourceLock(maintenancePool);
    client = await pool.connect();
    lease = await acquireLeaseOnClient(client, config);
    await resetWithFnd004Lease(lease);
  } finally {
    if (lease) {
      await releaseFnd004Lease(lease);
    } else if (client) {
      client.release(true);
    }
    if (lockClient) await releaseRegressionResourceLock(lockClient);
    await pool.end();
    await maintenancePool.end();
  }
}
