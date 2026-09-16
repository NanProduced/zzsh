import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";

import { createAdministrator } from "../src/auth/admin-directory";
import type { AuthSecurityOptions, AuthSecurityNodeResponse } from "../src/auth/auth-security";
import { assertBusinessMigrationIdentity, assertBusinessRuntimeIdentity } from "../src/database/business";
import { runBusinessMigrations } from "../src/database/business-migrations";
import {
  buildYunxinIdentityMarker,
  deriveYunxinAccountId,
  ImIdentityProvisioner,
  type ImIdentityKey,
  type ImIdentityMapping,
  type ImIdentityProvisioner as ImIdentityProvisionerType,
} from "../src/im/identity-lifecycle";
import { handleYunxinRoute, type YunxinRouteOptions } from "../src/im/yunxin-routes";
import { YunxinIdentityRepository } from "../src/im/yunxin-identity-repository";

const ENABLED = process.env.IM_PG_TEST === "1";
const MAINTENANCE_USER = process.env.IM_PG_TEST_MAINTENANCE_USER?.trim() || "zzsh";
const MAINTENANCE_PASSWORD = process.env.IM_PG_TEST_MAINTENANCE_PASSWORD?.trim() || process.env.DB_PASSWORD?.trim();
if (ENABLED && !MAINTENANCE_PASSWORD) throw new Error("IM_PG_TEST_MAINTENANCE_PASSWORD is required");
if (!/^[a-z][a-z0-9_]{0,62}$/.test(MAINTENANCE_USER)) throw new Error("IM_PG_TEST_MAINTENANCE_USER is invalid");

// Resource set is parameterized for integration candidates; defaults keep the
// original yunxin_wiring isolation. Database/role/marker/lock checks stay intact.
const DATABASE = process.env.IM_PG_TEST_DATABASE?.trim() || "zzsh_test_yunxin_wiring";
const MIGRATION_USER = process.env.IM_PG_TEST_MIGRATION_USER?.trim() || "zzsh_yunxin_wiring_m";
const RUNTIME_USER = process.env.IM_PG_TEST_RUNTIME_USER?.trim() || "zzsh_yunxin_wiring_r";
const DATABASE_MARKER = process.env.IM_PG_TEST_DATABASE_MARKER?.trim() || "zzsh:yunxin-web-foundation-pg:v1";
const RESOURCE_LOCK_KEY = process.env.IM_PG_TEST_RESOURCE_LOCK?.trim() || "710461338232252569";
const APP_ID = "provider-test";
const ORIGINS = {
  api: "http://127.0.0.1:3102",
  user: "http://127.0.0.1:3100",
  admin: "http://127.0.0.1:3101",
} as const;

function identifier(value: string): string {
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(value)) throw new Error("unsafe PostgreSQL identifier");
  return `"${value}"`;
}

function literal(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function pool(database: string, user: string, password: string, applicationName: string, max: number): Pool {
  return new Pool({
    host: "127.0.0.1",
    port: 55432,
    database,
    user,
    password,
    application_name: applicationName,
    connectionTimeoutMillis: 2_000,
    idleTimeoutMillis: 30_000,
    max,
  });
}

async function ensureDatabase(maintenance: Pool): Promise<void> {
  const result = await maintenance.query<{ owner: string; allowConnections: boolean; isTemplate: boolean; marker: string | null }>(
    `SELECT pg_get_userbyid(datdba) AS owner, datallowconn AS "allowConnections", datistemplate AS "isTemplate",
            shobj_description(oid, 'pg_database') AS marker
       FROM pg_database WHERE datname = $1`,
    [DATABASE],
  );
  if (result.rows.length === 0) {
    await maintenance.query(`CREATE DATABASE ${identifier(DATABASE)} OWNER ${identifier(MAINTENANCE_USER)}`);
    await maintenance.query(`COMMENT ON DATABASE ${identifier(DATABASE)} IS ${literal(DATABASE_MARKER)}`);
    return;
  }
  const row = result.rows[0]!;
  assert.equal(row.owner, MAINTENANCE_USER);
  assert.equal(row.allowConnections, true);
  assert.equal(row.isTemplate, false);
  assert.equal(row.marker, DATABASE_MARKER);
}

async function ensureRole(maintenance: Pool, roleName: string, password: string, marker: string): Promise<void> {
  const result = await maintenance.query<{
    canLogin: boolean;
    isSuperuser: boolean;
    canCreateRole: boolean;
    canCreateDb: boolean;
    canInherit: boolean;
    canReplicate: boolean;
    canBypassRls: boolean;
    marker: string | null;
    ownsDatabase: boolean;
    memberOfRole: boolean;
    grantedToRole: boolean;
  }>(
    `SELECT r.rolcanlogin AS "canLogin", r.rolsuper AS "isSuperuser", r.rolcreaterole AS "canCreateRole",
            r.rolcreatedb AS "canCreateDb", r.rolinherit AS "canInherit", r.rolreplication AS "canReplicate",
            r.rolbypassrls AS "canBypassRls", shobj_description(r.oid, 'pg_authid') AS marker,
            EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba = r.oid) AS "ownsDatabase",
            EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS "memberOfRole",
            EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r.oid) AS "grantedToRole"
       FROM pg_roles r WHERE r.rolname = $1`,
    [roleName],
  );
  const current = result.rows[0];
  if (!current) {
    await maintenance.query(
      `CREATE ROLE ${identifier(roleName)} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT PASSWORD ${literal(password)}`,
    );
    await maintenance.query(`COMMENT ON ROLE ${identifier(roleName)} IS ${literal(marker)}`);
    return;
  }
  assert.deepEqual(current, {
    canLogin: true,
    isSuperuser: false,
    canCreateRole: false,
    canCreateDb: false,
    canInherit: false,
    canReplicate: false,
    canBypassRls: false,
    marker,
    ownsDatabase: false,
    memberOfRole: false,
    grantedToRole: false,
  });
  await maintenance.query(`ALTER ROLE ${identifier(roleName)} PASSWORD ${literal(password)}`);
}

async function acquireGuard(maintenance: Pool): Promise<PoolClient> {
  const guard = await maintenance.connect();
  try {
    const identity = await guard.query<{ databaseName: string; currentUser: string; port: string }>(
      "SELECT current_database() AS \"databaseName\", current_user AS \"currentUser\", current_setting('port') AS port",
    );
    assert.deepEqual(identity.rows[0], { databaseName: "postgres", currentUser: MAINTENANCE_USER, port: "5432" });
    const lock = await guard.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1::bigint) AS acquired",
      [RESOURCE_LOCK_KEY],
    );
    assert.equal(lock.rows[0]?.acquired, true, "yunxin PG resource is already in use");
    return guard;
  } catch (error) {
    guard.release(true);
    throw error;
  }
}

async function releaseGuard(guard: PoolClient | undefined): Promise<void> {
  if (!guard) return;
  try {
    await guard.query("SELECT pg_advisory_unlock($1::bigint)", [RESOURCE_LOCK_KEY]);
  } finally {
    guard.release();
  }
}

async function prepareResource(maintenance: Pool, migrationPassword: string, runtimePassword: string): Promise<PoolClient> {
  const guard = await acquireGuard(maintenance);
  try {
    await ensureDatabase(maintenance);
    await ensureRole(maintenance, MIGRATION_USER, migrationPassword, `${DATABASE_MARKER}:${DATABASE}:migration`);
    await ensureRole(maintenance, RUNTIME_USER, runtimePassword, `${DATABASE_MARKER}:${DATABASE}:runtime`);
    await maintenance.query(`GRANT CONNECT ON DATABASE ${identifier(DATABASE)} TO ${identifier(MIGRATION_USER)}, ${identifier(RUNTIME_USER)}`);
    await maintenance.query(`GRANT CREATE ON DATABASE ${identifier(DATABASE)} TO ${identifier(MIGRATION_USER)}`);
    return guard;
  } catch (error) {
    try {
      await releaseGuard(guard);
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "yunxin PG preparation and guard release failed");
    }
    throw error;
  }
}

async function assertRoleCanReconnect(roleName: string, password: string, applicationName: string): Promise<void> {
  const connection = pool(DATABASE, roleName, password, applicationName, 1);
  try {
    const result = await connection.query<{ currentUser: string }>(`SELECT current_user AS "currentUser"`);
    assert.equal(result.rows[0]?.currentUser, roleName);
  } finally {
    await connection.end();
  }
}

async function seedAdmin(runtime: Pool, id: string, name: string, isBoss: boolean, permission?: string): Promise<void> {
  const now = new Date();
  await runtime.query(
    `INSERT INTO "zzsh_auth_admin"."user"
      ("id", "name", "email", "createdAt", "updatedAt", "username", "displayUsername", "twoFactorEnabled", "suspended")
     VALUES ($1, $2, $3, $4, $4, $5, $5, true, false)`,
    [id, name, `${id}@admin.zzsh.invalid`, now, id.toUpperCase()],
  );
  await runtime.query(
    `INSERT INTO "zzsh_iam"."admin_security"
      ("admin_user_id", "status", "is_boss", "password_change_required")
     VALUES ($1, 'PENDING_ENROLLMENT', $2, true)`,
    [id, isBoss],
  );
  await runtime.query(
    `UPDATE "zzsh_iam"."admin_security"
        SET "status" = 'ACTIVE', "password_change_required" = false, "first_activated_at" = $2
      WHERE "admin_user_id" = $1`,
    [id, now],
  );
  if (permission) {
    await runtime.query(
      `INSERT INTO "zzsh_iam"."admin_user_permission" ("admin_user_id", "permission_code", "effect")
       VALUES ($1, $2, 'ALLOW')`,
      [id, permission],
    );
  }
}

function identityKey(kind: ImIdentityKey["kind"], subject: string, appId = APP_ID): ImIdentityKey {
  return {
    provider: "yunxin",
    appId,
    realm: kind === "ADMIN" ? "admin" : kind === "USER" ? "user" : "system",
    kind,
    platformSubjectId: subject,
  };
}

function intent(key: ImIdentityKey) {
  return { key, accountId: deriveYunxinAccountId(key), identityMarker: buildYunxinIdentityMarker(key) };
}

function capture(): AuthSecurityNodeResponse & { statusCode: number; body: unknown; headers: Map<string, string | string[]> } {
  const result = {
    headersSent: false,
    statusCode: 200,
    body: undefined as unknown,
    headers: new Map<string, string | string[]>(),
    setHeader(name: string, value: string | string[]) { result.headers.set(name.toLowerCase(), value); return result; },
    status(status: number) { result.statusCode = status; return result; },
    json(body: unknown) { result.body = body; result.headersSent = true; },
  };
  return result as AuthSecurityNodeResponse & { statusCode: number; body: unknown; headers: Map<string, string | string[]> };
}

function routeOptions(runtime: Pool, supportId: string, repository: YunxinIdentityRepository): YunxinRouteOptions {
  const security = {
    pool: runtime,
    apiOrigin: ORIGINS.api,
    userOrigin: ORIGINS.user,
    adminOrigin: ORIGINS.admin,
    adminAuth: {
      api: {
        getSession: async () => ({ user: { id: supportId, twoFactorEnabled: true }, session: { id: "im-pg-session", locked: false } }),
      },
    },
    userAuth: { api: { getSession: async () => null } },
  } as unknown as AuthSecurityOptions;
  return {
    security,
    appId: APP_ID,
    repository,
    provisioner: undefined as unknown as YunxinRouteOptions["provisioner"],
    tokenService: undefined as unknown as YunxinRouteOptions["tokenService"],
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("0031 identity lifecycle and authorization pass real PostgreSQL boundaries", { skip: ENABLED ? false : "set IM_PG_TEST=1 to run the isolated PostgreSQL check" }, async () => {
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const subjectPrefix = `im_pg_${runId}_`;
  const bossId = `${subjectPrefix}boss`;
  const supportId = `${subjectPrefix}support`;
  const foreignAdminId = `${subjectPrefix}foreign`;
  const userId = `${subjectPrefix}user`;
  const systemId = `${subjectPrefix}system`;
  const otherAppId = `${subjectPrefix}otherapp`;
  const createdAdminNames: string[] = [];
  const createdAdminIds: string[] = [bossId, supportId, foreignAdminId];
  const migrationPassword = randomBytes(32).toString("hex");
  const runtimePassword = randomBytes(32).toString("hex");
  const maintenance = pool("postgres", MAINTENANCE_USER, MAINTENANCE_PASSWORD!, "zzsh-yunxin-maintenance", 2);
  let guard: PoolClient | undefined;
  let migration: Pool | undefined;
  let runtime: Pool | undefined;

  let primaryFailure: unknown;
  let testFailed = false;
  try {
    guard = await prepareResource(maintenance, migrationPassword, runtimePassword);

    migration = pool(DATABASE, MIGRATION_USER, migrationPassword, "zzsh-yunxin-migration", 4);
    await assertBusinessMigrationIdentity(migration, { database: { name: DATABASE, user: MIGRATION_USER, runtimeUser: RUNTIME_USER } });
    await runBusinessMigrations(migration, { runtimeUser: RUNTIME_USER });
    runtime = pool(DATABASE, RUNTIME_USER, runtimePassword, "zzsh-yunxin-runtime", 8);
    await assertBusinessRuntimeIdentity(runtime, { database: { name: DATABASE, user: RUNTIME_USER, runtimeUser: RUNTIME_USER } });

    const privileges = await runtime.query<{
      canSelect: boolean;
      canInsert: boolean;
      canUpdateStatus: boolean;
      canUpdateAccount: boolean;
      canDelete: boolean;
      canTruncate: boolean;
    }>(
      `SELECT has_table_privilege(current_user, 'zzsh_iam.im_identity_mapping', 'SELECT') AS "canSelect",
              has_table_privilege(current_user, 'zzsh_iam.im_identity_mapping', 'INSERT') AS "canInsert",
              has_column_privilege(current_user, 'zzsh_iam.im_identity_mapping', 'status', 'UPDATE') AS "canUpdateStatus",
              has_column_privilege(current_user, 'zzsh_iam.im_identity_mapping', 'account_id', 'UPDATE') AS "canUpdateAccount",
              has_table_privilege(current_user, 'zzsh_iam.im_identity_mapping', 'DELETE') AS "canDelete",
              has_table_privilege(current_user, 'zzsh_iam.im_identity_mapping', 'TRUNCATE') AS "canTruncate"`,
    );
    assert.deepEqual(privileges.rows[0], {
      canSelect: true,
      canInsert: true,
      canUpdateStatus: true,
      canUpdateAccount: false,
      canDelete: false,
      canTruncate: false,
    });

    const competingMaintenance = pool("postgres", MAINTENANCE_USER, MAINTENANCE_PASSWORD!, "zzsh-yunxin-competing-maintenance", 2);
    const competingMigrationPassword = randomBytes(32).toString("hex");
    const competingRuntimePassword = randomBytes(32).toString("hex");
    let competingGuard: PoolClient | undefined;
    try {
      await assert.rejects(
        (async () => {
          competingGuard = await prepareResource(competingMaintenance, competingMigrationPassword, competingRuntimePassword);
        })(),
        /yunxin PG resource is already in use/,
      );
    } finally {
      try {
        if (competingGuard) await releaseGuard(competingGuard);
      } finally {
        await competingMaintenance.end();
      }
    }
    await assertRoleCanReconnect(MIGRATION_USER, migrationPassword, "zzsh-yunxin-migration-reconnect");
    await assertRoleCanReconnect(RUNTIME_USER, runtimePassword, "zzsh-yunxin-runtime-reconnect");

    await seedAdmin(runtime, bossId, `${subjectPrefix} Boss`, true);
    await seedAdmin(runtime, supportId, `${subjectPrefix} Support`, false, "im.support.read");
    const repository = new YunxinIdentityRepository(runtime);

    const createdName = `${subjectPrefix} Created`;
    createdAdminNames.push(createdName);
    const failingProvisioner = {
      ensure: async ({ key }: { key: ImIdentityKey }) => {
        const current = await repository.findByKey(key);
        assert.ok(current);
        const claim = await repository.claimProvisionAttempt({ mappingId: current.id, expectedVersion: current.version, now: new Date(), leaseMs: 1_000 });
        assert.ok(claim);
        throw new Error("simulated post-commit IM CAS failure");
      },
    } as unknown as ImIdentityProvisionerType;
    const created = await createAdministrator(
      { userId: bossId, sessionId: "im-pg-boss-session" },
      { name: createdName },
      `${subjectPrefix}create`,
      { pool: runtime, hashPassword: async () => "hash", imAppId: APP_ID, imIdentityRepository: repository, imProvisioner: failingProvisioner },
    );
    const createdId = created.id as string;
    createdAdminIds.push(createdId);
    assert.equal(typeof created.temporaryPassword, "string");
    assert.deepEqual(created.imIdentity && { status: (created.imIdentity as { status: string }).status }, { status: "PENDING" });
    const createdKey = identityKey("ADMIN", createdId);
    let createdMapping = await repository.findByKey(createdKey);
    assert.ok(createdMapping);
    assert.equal(createdMapping.status, "PENDING");
    assert.equal(createdMapping.attemptCount, 1);
    assert.ok(createdMapping.attemptLeaseUntil);
    assert.equal((await runtime.query("SELECT count(*)::text AS count FROM \"zzsh_auth_admin\".\"user\" WHERE \"id\" = $1", [createdId])).rows[0]?.count, "1");

    await migration.query(`UPDATE "zzsh_iam"."im_identity_mapping" SET "attempt_lease_until" = clock_timestamp() - interval '1 millisecond' WHERE "id" = $1`, [createdMapping.id]);
    let recoveryCreates = 0;
    const recovering = new ImIdentityProvisioner(repository, {
      createAccount: async () => { recoveryCreates += 1; throw new Error("recovery must query before create"); },
      getProfile: async (accountId: string) => ({ accountId, extension: createdMapping!.identityMarker }),
    } as never, { leaseMs: 1_000 });
    const recovered = await recovering.ensure({ key: createdKey });
    assert.equal(recovered.outcome, "READY");
    assert.equal(recoveryCreates, 0);
    assert.equal((await runtime.query("SELECT count(*)::text AS count FROM \"zzsh_auth_admin\".\"user\" WHERE \"name\" = $1", [createdName])).rows[0]?.count, "1");

    const rollbackName = `${subjectPrefix} Rollback`;
    createdAdminNames.push(rollbackName);
    const beforeMappings = (await runtime.query<{ count: string }>(`SELECT count(*)::text AS count FROM "zzsh_iam"."im_identity_mapping"`)).rows[0]?.count;
    await migration.query(`REVOKE INSERT ON TABLE "zzsh_iam"."im_identity_mapping" FROM ${identifier(RUNTIME_USER)}`);
    try {
      await assert.rejects(
        createAdministrator(
          { userId: bossId, sessionId: "im-pg-boss-session" },
          { name: rollbackName },
          `${subjectPrefix}rollback`,
          { pool: runtime, hashPassword: async () => "hash", imAppId: APP_ID, imIdentityRepository: repository, imProvisioner: failingProvisioner },
        ),
      );
    } finally {
      await migration.query(`GRANT INSERT ON TABLE "zzsh_iam"."im_identity_mapping" TO ${identifier(RUNTIME_USER)}`);
    }
    assert.equal((await runtime.query("SELECT count(*)::text AS count FROM \"zzsh_auth_admin\".\"user\" WHERE \"name\" = $1", [rollbackName])).rows[0]?.count, "0");
    assert.equal((await runtime.query(`SELECT count(*)::text AS count FROM "zzsh_iam"."im_identity_mapping"`)).rows[0]?.count, beforeMappings);

    const ownKey = identityKey("ADMIN", supportId);
    const foreignKey = identityKey("ADMIN", foreignAdminId);
    const userKey = identityKey("USER", userId);
    const systemKey = identityKey("SYSTEM", systemId);
    const otherAppKey = identityKey("ADMIN", otherAppId, "other-provider-test");
    for (const key of [ownKey, foreignKey, userKey, systemKey, otherAppKey]) await repository.ensureIntent(intent(key));
    const routeResponse = capture();
    await handleYunxinRoute(
      { method: "GET", url: "/api/v1/im/admin/identities", headers: { origin: ORIGINS.admin, cookie: "zzsh_admin.session_token=opaque" } },
      routeResponse,
      routeOptions(runtime, supportId, repository),
    );
    assert.equal(routeResponse.statusCode, 200, JSON.stringify(routeResponse.body));
    const identities = (routeResponse.body as { identities: Array<{ platformSubjectId: string; accountId: string }> }).identities;
    assert.deepEqual(identities.map((identity) => identity.platformSubjectId), [supportId]);
    assert.equal(identities.some((identity) => identity.accountId === deriveYunxinAccountId(foreignKey)), false);
    assert.equal(identities.some((identity) => identity.accountId === deriveYunxinAccountId(userKey)), false);
    assert.equal(identities.some((identity) => identity.accountId === deriveYunxinAccountId(systemKey)), false);
    assert.equal(identities.some((identity) => identity.accountId === deriveYunxinAccountId(otherAppKey)), false);

    await assert.rejects(
      runtime.query(`UPDATE "zzsh_iam"."im_identity_mapping" SET "account_id" = 'tampered' WHERE "platform_subject_id" = $1`, [supportId]),
      /permission denied/,
    );
    await assert.rejects(
      runtime.query(`TRUNCATE "zzsh_iam"."im_identity_mapping"`),
      /must be owner|permission denied/,
    );
    const readyMapping = await repository.findByKey(createdKey);
    assert.ok(readyMapping);
    await assert.rejects(
      migration.query(`UPDATE "zzsh_iam"."im_identity_mapping" SET "account_id" = 'tampered' WHERE "id" = $1`, [readyMapping.id]),
      /immutable/,
    );
    await assert.rejects(
      migration.query(`UPDATE "zzsh_iam"."im_identity_mapping" SET "status" = 'PENDING' WHERE "id" = $1`, [readyMapping.id]),
      /transition is invalid/,
    );

    const concurrent = await repository.ensureIntent(intent(identityKey("USER", `${subjectPrefix}concurrent`)));
    const claims = await Promise.all([
      repository.claimProvisionAttempt({ mappingId: concurrent.id, expectedVersion: concurrent.version, now: new Date(0), leaseMs: 30_000 }),
      repository.claimProvisionAttempt({ mappingId: concurrent.id, expectedVersion: concurrent.version, now: new Date(0), leaseMs: 30_000 }),
    ]);
    assert.equal(claims.filter(Boolean).length, 1);

    const expired = await repository.ensureIntent(intent(identityKey("USER", `${subjectPrefix}expired`)));
    const expiredClaim = await repository.claimProvisionAttempt({ mappingId: expired.id, expectedVersion: expired.version, now: new Date(0), leaseMs: 1_000 });
    assert.ok(expiredClaim);
    await delay(1_300);
    assert.equal((await repository.markReady({ mappingId: expiredClaim.mapping.id, expectedVersion: expiredClaim.mapping.version, leaseToken: expiredClaim.leaseToken })).applied, true);

    const stale = await repository.ensureIntent(intent(identityKey("USER", `${subjectPrefix}stale`)));
    const firstClaim = await repository.claimProvisionAttempt({ mappingId: stale.id, expectedVersion: stale.version, now: new Date(0), leaseMs: 1_000 });
    assert.ok(firstClaim);
    await delay(1_300);
    const secondClaim = await repository.claimProvisionAttempt({ mappingId: stale.id, expectedVersion: firstClaim.mapping.version, now: new Date(0), leaseMs: 1_000 });
    assert.ok(secondClaim);
    const staleCompletion = await repository.markReady({ mappingId: firstClaim.mapping.id, expectedVersion: firstClaim.mapping.version, leaseToken: firstClaim.leaseToken });
    assert.equal(staleCompletion.applied, false);
    assert.equal((await repository.markReady({ mappingId: secondClaim.mapping.id, expectedVersion: secondClaim.mapping.version, leaseToken: secondClaim.leaseToken })).applied, true);
  } catch (error) {
    testFailed = true;
    primaryFailure = error;
  }

  const cleanupSteps: string[] = [];
  const cleanupErrors: Array<{ step: string; error: unknown }> = [];
  const cleanupStep = async (step: string, action: () => Promise<void>): Promise<void> => {
    try {
      await action();
      cleanupSteps.push(`${step}:PASS`);
    } catch (error) {
      cleanupSteps.push(`${step}:FAIL`);
      cleanupErrors.push({ step, error });
    }
  };

  if (migration) {
    await cleanupStep("synthetic rows", async () => {
      await migration!.query(
        `DELETE FROM "zzsh_iam"."audit_event" WHERE "object_id" = ANY($1::text[]) OR "actor_id" = ANY($1::text[])`,
        [createdAdminIds],
      );
      await migration!.query(
        `DELETE FROM "zzsh_iam"."im_identity_mapping" WHERE "platform_subject_id" LIKE $1 OR "platform_subject_id" = ANY($2::text[])`,
        [`${subjectPrefix}%`, createdAdminIds],
      );
      await migration!.query(`DELETE FROM "zzsh_iam"."admin_user_permission" WHERE "admin_user_id" = ANY($1::text[])`, [createdAdminIds]);
      await migration!.query(`DELETE FROM "zzsh_iam"."admin_user_role" WHERE "admin_user_id" = ANY($1::text[])`, [createdAdminIds]);
      await migration!.query(`DELETE FROM "zzsh_auth_admin"."user" WHERE "id" = ANY($1::text[]) OR "name" = ANY($2::text[])`, [createdAdminIds, createdAdminNames]);
    });
  } else {
    cleanupSteps.push("synthetic rows:SKIP");
  }
  const activeRuntime = runtime;
  runtime = undefined;
  await cleanupStep("runtime pool", async () => { await activeRuntime?.end(); });
  const activeMigration = migration;
  migration = undefined;
  await cleanupStep("migration pool", async () => { await activeMigration?.end(); });
  const activeGuard = guard;
  guard = undefined;
  await cleanupStep("advisory lock", async () => { await releaseGuard(activeGuard); });
  await cleanupStep("maintenance pool", async () => { await maintenance.end(); });

  console.log(JSON.stringify({
    event: "yunxin.pg.cleanup",
    runId,
    status: cleanupErrors.length === 0 ? "PASS" : "FAIL",
    steps: cleanupSteps,
  }));
  if (testFailed && cleanupErrors.length > 0) {
    throw new AggregateError([primaryFailure, ...cleanupErrors.map(({ error }) => error)], "0031 PG test and cleanup failed");
  }
  if (testFailed) throw primaryFailure;
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors.map(({ error }) => error), "0031 PG cleanup failed");
  }
});
