import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import { Pool, type PoolClient } from "pg";

import { assertBusinessMigrationIdentity, assertBusinessRuntimeIdentity } from "../src/database/business";
import { runBusinessMigrations } from "../src/database/business-migrations";
import {
  buildYunxinIdentityMarker,
  deriveYunxinAccountId,
  type ImIdentityKey,
} from "../src/im/identity-lifecycle";
import {
  claimConsultation,
  closeConsultation,
  createOrResumeUserConsultation,
  listAdminConsultations,
  listUserConsultations,
  reconcileMessageScopes,
  readAdminMessageAccess,
  readOwnPresence,
  retryMessageScopeOperation,
  supportManagerIdentityKey,
  transferConsultation,
  updateOwnPresence,
} from "../src/im/consultation";
import { YunxinApiError, YunxinTransportError, type YunxinSupportScopeApi, type YunxinSupportTeamCreateInput, type YunxinSupportTeamLookup, type YunxinSupportTeamState } from "../src/im/yunxin-provider";
import type { ImProvisionResult } from "../src/im/identity-lifecycle";
import { loadEffectiveAdminAccess } from "../src/auth/admin-authorization";
import type { AdminContext } from "../src/auth/auth-security";

const ENABLED = process.env.IM_CONSULTATION_PG_TEST === "1";
const MAINTENANCE_USER = process.env.IM_CONSULTATION_PG_TEST_MAINTENANCE_USER?.trim() || "zzsh";
const MAINTENANCE_PASSWORD = process.env.IM_CONSULTATION_PG_TEST_MAINTENANCE_PASSWORD?.trim() || process.env.DB_PASSWORD?.trim();
if (ENABLED && !MAINTENANCE_PASSWORD) throw new Error("IM_CONSULTATION_PG_TEST_MAINTENANCE_PASSWORD is required");

// Resource set is parameterized for integration candidates; defaults keep the
// original yunxin_wiring isolation. Database/role/marker/lock checks stay intact.
const DATABASE = process.env.IM_PG_TEST_DATABASE?.trim() || "zzsh_test_yunxin_wiring";
const MIGRATION_USER = process.env.IM_PG_TEST_MIGRATION_USER?.trim() || "zzsh_yunxin_wiring_m";
const RUNTIME_USER = process.env.IM_PG_TEST_RUNTIME_USER?.trim() || "zzsh_yunxin_wiring_r";
const DATABASE_MARKER = process.env.IM_PG_TEST_DATABASE_MARKER?.trim() || "zzsh:yunxin-web-foundation-pg:v1";
const RESOURCE_LOCK_KEY = process.env.IM_PG_TEST_RESOURCE_LOCK?.trim() || "710461338232252569";
const APP_ID = "provider-test";

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

async function acquireGuard(maintenance: Pool): Promise<PoolClient> {
  const guard = await maintenance.connect();
  try {
    const identity = await guard.query<{ databaseName: string; currentUser: string; port: string }>(
      "SELECT current_database() AS \"databaseName\", current_user AS \"currentUser\", current_setting('port') AS port",
    );
    assert.deepEqual(identity.rows[0], { databaseName: "postgres", currentUser: MAINTENANCE_USER, port: "5432" });
    const lock = await guard.query<{ acquired: boolean }>("SELECT pg_try_advisory_lock($1::bigint) AS acquired", [RESOURCE_LOCK_KEY]);
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

async function ensureRegisteredResource(maintenance: Pool): Promise<PoolClient> {
  const guard = await acquireGuard(maintenance);
  try {
    const database = await maintenance.query<{ owner: string; allowConnections: boolean; isTemplate: boolean; marker: string | null }>(
      `SELECT pg_get_userbyid(datdba) AS owner, datallowconn AS "allowConnections", datistemplate AS "isTemplate",
              shobj_description(oid, 'pg_database') AS marker
         FROM pg_database WHERE datname = $1`,
      [DATABASE],
    );
    assert.deepEqual(database.rows[0], {
      owner: MAINTENANCE_USER,
      allowConnections: true,
      isTemplate: false,
      marker: DATABASE_MARKER,
    });

    for (const [roleName, marker] of [
      [MIGRATION_USER, `${DATABASE_MARKER}:${DATABASE}:migration`],
      [RUNTIME_USER, `${DATABASE_MARKER}:${DATABASE}:runtime`],
    ] as const) {
      const role = await maintenance.query<{ canLogin: boolean; isSuperuser: boolean; canCreateRole: boolean; canCreateDb: boolean; canInherit: boolean; canReplicate: boolean; canBypassRls: boolean; marker: string | null; ownsDatabase: boolean; memberOfRole: boolean; grantedToRole: boolean }>(
        `SELECT r.rolcanlogin AS "canLogin", r.rolsuper AS "isSuperuser", r.rolcreaterole AS "canCreateRole",
                r.rolcreatedb AS "canCreateDb", r.rolinherit AS "canInherit", r.rolreplication AS "canReplicate",
                r.rolbypassrls AS "canBypassRls", shobj_description(r.oid, 'pg_authid') AS marker,
                EXISTS (SELECT 1 FROM pg_database d WHERE d.datdba = r.oid) AS "ownsDatabase",
                EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.member = r.oid) AS "memberOfRole",
                EXISTS (SELECT 1 FROM pg_auth_members m WHERE m.roleid = r.oid) AS "grantedToRole"
           FROM pg_roles r WHERE r.rolname = $1`,
        [roleName],
      );
      assert.deepEqual(role.rows[0], {
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
    }

    const migrationPassword = randomBytes(32).toString("hex");
    const runtimePassword = randomBytes(32).toString("hex");
    await maintenance.query(`ALTER ROLE ${identifier(MIGRATION_USER)} PASSWORD ${literal(migrationPassword)}`);
    await maintenance.query(`ALTER ROLE ${identifier(RUNTIME_USER)} PASSWORD ${literal(runtimePassword)}`);
    await maintenance.query(`GRANT CONNECT ON DATABASE ${identifier(DATABASE)} TO ${identifier(MIGRATION_USER)}, ${identifier(RUNTIME_USER)}`);
    await maintenance.query(`GRANT CREATE ON DATABASE ${identifier(DATABASE)} TO ${identifier(MIGRATION_USER)}`);
    (guard as PoolClient & { migrationPassword?: string; runtimePassword?: string }).migrationPassword = migrationPassword;
    (guard as PoolClient & { migrationPassword?: string; runtimePassword?: string }).runtimePassword = runtimePassword;
    return guard;
  } catch (error) {
    try {
      await releaseGuard(guard);
    } catch (releaseError) {
      throw new AggregateError([error, releaseError], "0034 PG preparation and guard release failed");
    }
    throw error;
  }
}

function identityKey(kind: "USER" | "ADMIN", subject: string): ImIdentityKey {
  return {
    provider: "yunxin",
    appId: APP_ID,
    realm: kind === "ADMIN" ? "admin" : "user",
    kind,
    platformSubjectId: subject,
  };
}

class FakeSupportScopeProvider implements YunxinSupportScopeApi {
  private nextTeamId = 900001;
  readonly created: YunxinSupportTeamCreateInput[] = [];
  readonly dismissed: string[] = [];
  readonly members = new Map<string, Set<string>>();
  readonly teams = new Map<string, YunxinSupportTeamCreateInput>();
  readonly pendingCreates = new Map<string, YunxinSupportTeamCreateInput>();
  readonly pendingLateAdds: Array<{ teamId: string; memberAccountId: string }> = [];
  findCalls = 0;
  failCreateAfterPersist = false;
  failCreateBeforePersist = false;
  failAddAfterPersist = false;
  failAddBeforePersist = false;
  failRemoveAfterPersist = false;
  failDismissAfterPersist = false;
  lastPendingCreateTeamId: string | undefined;
  beforeGet?: (teamId: string) => Promise<void>;
  beforeCreate?: (teamId: string) => Promise<void>;
  afterAdd?: (teamId: string, memberAccountId: string) => Promise<void>;

  async createSupportTeam(input: YunxinSupportTeamCreateInput): Promise<{ teamId: string }> {
    const teamId = String(this.nextTeamId++);
    this.created.push(input);
    const beforeCreate = this.beforeCreate;
    this.beforeCreate = undefined;
    await beforeCreate?.(teamId);
    if (this.failCreateBeforePersist) {
      this.failCreateBeforePersist = false;
      this.pendingCreates.set(teamId, input);
      this.lastPendingCreateTeamId = teamId;
      throw new YunxinTransportError("create-support-team");
    }
    this.teams.set(teamId, input);
    this.members.set(teamId, new Set([input.ownerAccountId, ...input.memberAccountIds]));
    if (this.failCreateAfterPersist) {
      this.failCreateAfterPersist = false;
      throw new YunxinTransportError("create-support-team");
    }
    return { teamId };
  }

  async addSupportTeamMember(teamId: string, operatorAccountId: string, memberAccountId: string): Promise<void> {
    const members = this.members.get(teamId);
    const team = this.teams.get(teamId);
    if (!members?.has(operatorAccountId) || team?.ownerAccountId !== operatorAccountId) throw new Error("fake support team owner is required");
    if (this.failAddBeforePersist) {
      this.failAddBeforePersist = false;
      this.pendingLateAdds.push({ teamId, memberAccountId });
      throw new YunxinTransportError("add-support-team-member");
    }
    members.add(memberAccountId);
    if (this.failAddAfterPersist) {
      this.failAddAfterPersist = false;
      throw new YunxinTransportError("add-support-team-member");
    }
    const afterAdd = this.afterAdd;
    this.afterAdd = undefined;
    await afterAdd?.(teamId, memberAccountId);
  }

  async removeSupportTeamMember(teamId: string, operatorAccountId: string, memberAccountId: string): Promise<void> {
    const members = this.members.get(teamId);
    const team = this.teams.get(teamId);
    if (!members?.has(operatorAccountId) || team?.ownerAccountId !== operatorAccountId) throw new Error("fake support team owner is required");
    members.delete(memberAccountId);
    if (this.failRemoveAfterPersist) {
      this.failRemoveAfterPersist = false;
      throw new YunxinTransportError("remove-support-team-member");
    }
  }

  async dismissSupportTeam(teamId: string, ownerAccountId: string): Promise<void> {
    const members = this.members.get(teamId);
    const team = this.teams.get(teamId);
    if (!members?.has(ownerAccountId) || team?.ownerAccountId !== ownerAccountId) throw new Error("fake support team owner is required");
    this.members.delete(teamId);
    this.dismissed.push(teamId);
    if (this.failDismissAfterPersist) {
      this.failDismissAfterPersist = false;
      throw new YunxinTransportError("dismiss-support-team");
    }
  }

  async getSupportTeam(teamId: string): Promise<YunxinSupportTeamState | null> {
    const beforeGet = this.beforeGet;
    this.beforeGet = undefined;
    await beforeGet?.(teamId);
    const input = this.teams.get(teamId);
    const members = this.members.get(teamId);
    if (!input || !members) return null;
    return {
      teamId,
      ownerAccountId: input.ownerAccountId,
      memberAccountIds: [...members],
      serverExtension: JSON.stringify({ schema: "zzsh.im-consultation.v1", appId: input.appId, consultationId: input.consultationId }),
    };
  }

  async findSupportTeam(input: { appId: string; consultationId: string; ownerAccountId: string }): Promise<YunxinSupportTeamLookup> {
    this.findCalls += 1;
    const matches = [...this.teams.entries()].filter(([teamId, team]) => team.appId === input.appId && team.consultationId === input.consultationId && team.ownerAccountId === input.ownerAccountId && this.members.has(teamId));
    if (matches.length > 1) return { status: "AMBIGUOUS" };
    if (!matches[0]) return { status: "ABSENT" };
    const team = await this.getSupportTeam(matches[0][0]);
    return team ? { status: "FOUND", team } : { status: "ABSENT" };
  }

  applyLateCreate(teamId: string): void {
    const input = this.pendingCreates.get(teamId);
    if (!input) throw new Error("fake late create is not pending");
    this.pendingCreates.delete(teamId);
    this.teams.set(teamId, input);
    this.members.set(teamId, new Set([input.ownerAccountId, ...input.memberAccountIds]));
  }

  applyLateAdd(teamId: string, memberAccountId: string): void {
    const pending = this.pendingLateAdds.findIndex((item) => item.teamId === teamId && item.memberAccountId === memberAccountId);
    if (pending < 0) throw new Error("fake late member add is not pending");
    this.pendingLateAdds.splice(pending, 1);
    this.members.get(teamId)?.add(memberAccountId);
  }
}

async function seedIdentity(runtime: Pool, key: ImIdentityKey, runId: string): Promise<void> {
  await runtime.query(
    `INSERT INTO "zzsh_iam"."im_identity_mapping"
      ("id", "provider", "app_id", "realm", "identity_kind", "platform_subject_id", "account_id", "identity_marker", "status")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'READY')`,
    [
      `im_cpg_mapping_${runId}_${key.kind.toLowerCase()}_${key.platformSubjectId}`,
      key.provider,
      key.appId,
      key.realm,
      key.kind,
      key.platformSubjectId,
      deriveYunxinAccountId(key),
      buildYunxinIdentityMarker(key),
    ],
  );
}

async function seedUser(runtime: Pool, userId: string, sessionId: string, runId: string): Promise<void> {
  const now = new Date();
  await runtime.query(
    `INSERT INTO "zzsh_auth_user"."user"
      ("id", "name", "email", "createdAt", "updatedAt", "username", "displayUsername", "twoFactorEnabled", "suspended")
     VALUES ($1, $2, $3, $4, $4, $5, $5, true, false)`,
    [userId, `PG consultation user ${runId}`, `${userId}@user.zzsh.invalid`, now, userId],
  );
  await runtime.query(
    `INSERT INTO "zzsh_auth_user"."session"
      ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
     VALUES ($1, $2, $3, $4, $4, $5)`,
    [sessionId, new Date(now.getTime() + 3_600_000), `im_cpg_token_${runId}_${sessionId}`, now, userId],
  );
}

async function seedAdmin(runtime: Pool, adminId: string, sessionId: string, runId: string): Promise<void> {
  const now = new Date();
  await runtime.query(
    `INSERT INTO "zzsh_auth_admin"."user"
      ("id", "name", "email", "createdAt", "updatedAt", "username", "displayUsername", "twoFactorEnabled", "suspended")
     VALUES ($1, $2, $3, $4, $4, $5, $5, true, false)`,
    [adminId, `PG consultation admin ${runId}`, `${adminId}@admin.zzsh.invalid`, now, adminId],
  );
  await runtime.query(
    `INSERT INTO "zzsh_iam"."admin_security"
      ("admin_user_id", "status", "is_boss", "password_change_required")
     VALUES ($1, 'PENDING_ENROLLMENT', true, false)`,
    [adminId],
  );
  await runtime.query(
    `UPDATE "zzsh_iam"."admin_security"
        SET "status" = 'ACTIVE', "first_activated_at" = $2, "updated_at" = clock_timestamp()
      WHERE "admin_user_id" = $1`,
    [adminId, now],
  );
  await runtime.query(
    `INSERT INTO "zzsh_auth_admin"."session"
      ("id", "expiresAt", "token", "createdAt", "updatedAt", "userId")
     VALUES ($1, $2, $3, $4, $4, $5)`,
    [sessionId, new Date(now.getTime() + 3_600_000), `im_cpg_admin_token_${runId}_${sessionId}`, now, adminId],
  );
}

function userContext(userId: string, sessionId: string) {
  return { userId, sessionId };
}

function adminContext(adminId: string, sessionId: string): AdminContext {
  return {
    userId: adminId,
    sessionId,
    credentials: { headers: new Headers(), conflict: false, malformed: false },
    security: { status: "ACTIVE", isBoss: true, passwordChangeRequired: false },
    sessionLocked: false,
  };
}

async function waitFor(label: string, check: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`${label} barrier was not reached`);
}

test(
  "0034 consultation scope ownership and persistent recovery preserve reception boundaries in real PostgreSQL",
  { skip: ENABLED ? false : "set IM_CONSULTATION_PG_TEST=1 to run the isolated PostgreSQL check" },
  async () => {
    const runId = randomUUID().replaceAll("-", "").slice(0, 12);
    const prefix = `im_cpg_${runId}_`;
    const userId = `${prefix}user`;
    const boundaryUserId = `${prefix}boundary_user`;
    const identityPendingUserId = `${prefix}identity_pending_user`;
    const adminId = `${prefix}admin`;
    const targetAdminId = `${prefix}target_admin`;
    const identityAdminId = `${prefix}identity_admin`;
    const userSessionId = `${prefix}user_session`;
    const boundaryUserSessionId = `${prefix}boundary_user_session`;
    const identityPendingUserSessionId = `${prefix}identity_pending_user_session`;
    const adminSessionId = `${prefix}admin_session`;
    const targetAdminSessionId = `${prefix}target_admin_session`;
    const identityAdminSessionId = `${prefix}identity_admin_session`;
    const syntheticUserIds = [userId, boundaryUserId, identityPendingUserId];
    const syntheticAdminIds = [adminId, targetAdminId, identityAdminId];
    const allSyntheticIds = [...syntheticUserIds, ...syntheticAdminIds];
    const maintenance = pool("postgres", MAINTENANCE_USER, MAINTENANCE_PASSWORD!, "zzsh-yunxin-consultation-maintenance", 2);
    let guard: (PoolClient & { migrationPassword?: string; runtimePassword?: string }) | undefined;
    let migration: Pool | undefined;
    let runtime: Pool | undefined;
    let primaryFailure: unknown;
    let releaseExpiredGet: (() => void) | undefined;
    let releaseInheritedCreate: (() => void) | undefined;
    let inheritedRetry: Promise<number> | undefined;

    try {
      guard = await ensureRegisteredResource(maintenance) as PoolClient & { migrationPassword?: string; runtimePassword?: string };
      assert.ok(guard.migrationPassword && guard.runtimePassword);
      migration = pool(DATABASE, MIGRATION_USER, guard.migrationPassword, "zzsh-yunxin-consultation-migration", 4);
      await assertBusinessMigrationIdentity(migration, { database: { name: DATABASE, user: MIGRATION_USER, runtimeUser: RUNTIME_USER } });
      await runBusinessMigrations(migration, { runtimeUser: RUNTIME_USER });
      const tables = await migration.query<{ presence: string | null; consultation: string | null; events: string | null; operations: string | null }>(
        `SELECT to_regclass('zzsh_iam.im_support_presence') AS presence,
                to_regclass('zzsh_iam.im_consultation') AS consultation,
                to_regclass('zzsh_iam.im_consultation_event') AS events,
                to_regclass('zzsh_iam.im_consultation_scope_operation') AS operations`,
      );
      assert.deepEqual(tables.rows[0], {
        presence: "zzsh_iam.im_support_presence",
        consultation: "zzsh_iam.im_consultation",
        events: "zzsh_iam.im_consultation_event",
        operations: "zzsh_iam.im_consultation_scope_operation",
      });

      runtime = pool(DATABASE, RUNTIME_USER, guard.runtimePassword, "zzsh-yunxin-consultation-runtime", 8);
      await assertBusinessRuntimeIdentity(runtime, { database: { name: DATABASE, user: RUNTIME_USER, runtimeUser: RUNTIME_USER } });
      const privileges = await runtime.query<{ consultationDelete: boolean; eventDelete: boolean; presenceUpdate: boolean; capacityUpdate: boolean; operationDelete: boolean; operationUpdateOwner: boolean; operationUpdateState: boolean }>(
        `SELECT has_table_privilege(current_user, 'zzsh_iam.im_consultation', 'DELETE') AS "consultationDelete",
                has_table_privilege(current_user, 'zzsh_iam.im_consultation_event', 'DELETE') AS "eventDelete",
                has_column_privilege(current_user, 'zzsh_iam.im_support_presence', 'availability', 'UPDATE') AS "presenceUpdate",
                has_column_privilege(current_user, 'zzsh_iam.im_support_presence', 'capacity', 'UPDATE') AS "capacityUpdate",
                has_table_privilege(current_user, 'zzsh_iam.im_consultation_scope_operation', 'DELETE') AS "operationDelete",
                has_column_privilege(current_user, 'zzsh_iam.im_consultation_scope_operation', 'owner_account_id', 'UPDATE') AS "operationUpdateOwner",
                has_column_privilege(current_user, 'zzsh_iam.im_consultation_scope_operation', 'state', 'UPDATE') AS "operationUpdateState"`,
      );
      assert.deepEqual(privileges.rows[0], { consultationDelete: false, eventDelete: false, presenceUpdate: true, capacityUpdate: false, operationDelete: false, operationUpdateOwner: false, operationUpdateState: true });

      await seedUser(runtime, userId, userSessionId, runId);
      await seedUser(runtime, boundaryUserId, boundaryUserSessionId, runId);
      await seedUser(runtime, identityPendingUserId, identityPendingUserSessionId, runId);
      await seedAdmin(runtime, adminId, adminSessionId, runId);
      await seedAdmin(runtime, targetAdminId, targetAdminSessionId, runId);
      await seedAdmin(runtime, identityAdminId, identityAdminSessionId, runId);
      await seedIdentity(runtime, identityKey("USER", userId), runId);
      await seedIdentity(runtime, identityKey("USER", boundaryUserId), runId);
      await seedIdentity(runtime, identityKey("USER", identityPendingUserId), runId);
      await seedIdentity(runtime, identityKey("ADMIN", adminId), runId);
      await seedIdentity(runtime, identityKey("ADMIN", targetAdminId), runId);
      await seedIdentity(runtime, identityKey("ADMIN", identityAdminId), runId);
      const provider = new FakeSupportScopeProvider();
      const managerKey = supportManagerIdentityKey(APP_ID);
      const managerAccountId = deriveYunxinAccountId(managerKey);
      let supportManagerReady = true;
      const supportManager = {
        key: managerKey,
        provisioner: {
          ensure: async (): Promise<ImProvisionResult> => {
            const outcome = supportManagerReady ? "READY" : "PENDING";
            return {
            outcome,
            mapping: {
              id: `${prefix}manager-mapping`,
              key: managerKey,
              accountId: managerAccountId,
              identityMarker: buildYunxinIdentityMarker(managerKey),
              status: outcome,
              version: 1,
              attemptCount: 0,
              attemptLeaseUntil: null,
              nextRetryAt: null,
              lastFailure: null,
            },
            };
          },
        },
      };
      const options = { pool: runtime, appId: APP_ID, provider, supportManager };
      const user = userContext(userId, userSessionId);
      const boundaryUser = userContext(boundaryUserId, boundaryUserSessionId);
      const admin = adminContext(adminId, adminSessionId);
      const targetAdmin = adminContext(targetAdminId, targetAdminSessionId);
      const identityAdmin = adminContext(identityAdminId, identityAdminSessionId);
      const userAccountId = deriveYunxinAccountId(identityKey("USER", userId));
      const boundaryUserAccountId = deriveYunxinAccountId(identityKey("USER", boundaryUserId));
      const adminAccountId = deriveYunxinAccountId(identityKey("ADMIN", adminId));
      const targetAdminAccountId = deriveYunxinAccountId(identityKey("ADMIN", targetAdminId));

      const online = await updateOwnPresence(options, admin, { availability: "AVAILABLE", connectionState: "CONNECTED" }, `${prefix}presence-online`);
      assert.equal(online.availability, "AVAILABLE");
      assert.equal(online.connectionState, "CONNECTED");
      assert.ok(online.lastConnectedAt);
      assert.equal(online.activeLoad, 0);

      const service = await createOrResumeUserConsultation(options, user, "SERVICE", "listing_demo_01", `${prefix}service-create`);
      assert.equal(service.consultation.state, "ACTIVE");
      assert.equal(service.consultation.assignedAdmin?.id, adminId);
      assert.equal(service.consultation.peerAccountId, adminAccountId);
      assert.equal(service.consultation.conversationId, `${userAccountId}|2|900001`);
      assert.equal(service.consultation.messageScopeState, "READY");
      assert.notEqual(service.consultation.peerAccountId, userAccountId);
      assert.equal(provider.created[0]?.ownerAccountId, managerAccountId);
      assert.deepEqual(provider.created[0]?.memberAccountIds, [userAccountId, adminAccountId]);
      assert.equal(provider.members.get("900001")?.has(managerAccountId), true);
      assert.equal(provider.members.get("900001")?.has(userAccountId), true);
      assert.equal(provider.members.get("900001")?.has(adminAccountId), true);
      await assert.rejects(provider.addSupportTeamMember("900001", userAccountId, targetAdminAccountId), /owner is required/);

      const resumed = await createOrResumeUserConsultation(options, user, "SERVICE", "listing_other", `${prefix}service-resume`);
      assert.equal(resumed.consultation.id, service.consultation.id);
      assert.equal(resumed.consultation.subjectRef, "listing_demo_01");

      const userList = await listUserConsultations(options, user, 10);
      assert.deepEqual(userList.consultations.map(({ id }) => id), [service.consultation.id]);
      const access = await loadEffectiveAdminAccess(runtime, adminId);
      assert.ok(access);
      const adminList = await listAdminConsultations(options, admin, access, 10);
      assert.equal(adminList.consultations[0]?.id, service.consultation.id);
      assert.equal(adminList.consultations[0]?.user?.id, userId);
      assert.equal(adminList.consultations[0]?.peerAccountId, userAccountId);
      assert.equal(adminList.consultations[0]?.conversationId, `${adminAccountId}|2|900001`);
      assert.notEqual(adminList.consultations[0]?.peerAccountId, adminAccountId);

      // Read and send are intentionally separate: an existing conversation may
      // remain readable, but a current type-specific grant is required to send.
      await migration.query(`UPDATE "zzsh_iam"."admin_security" SET "is_boss" = false WHERE "admin_user_id" = $1`, [adminId]);
      await migration.query(
        `INSERT INTO "zzsh_iam"."admin_user_permission" ("admin_user_id", "permission_code", "effect")
         VALUES ($1, 'im.support.read', 'ALLOW'), ($1, 'im.support.accept', 'ALLOW'), ($1, 'im.support.complaint', 'ALLOW')
         ON CONFLICT ("admin_user_id", "permission_code") DO UPDATE SET "effect" = EXCLUDED."effect"`,
        [adminId],
      );
      const serviceMessageAccess = await readAdminMessageAccess(options, admin, `${adminAccountId}|2|900001`, true);
      assert.deepEqual(serviceMessageAccess, { viewerAccountId: adminAccountId, peerAccountId: userAccountId });
      await migration.query(
        `UPDATE "zzsh_iam"."admin_user_permission" SET "effect" = 'DENY' WHERE "admin_user_id" = $1 AND "permission_code" = 'im.support.accept'`,
        [adminId],
      );
      await assert.rejects(
        readAdminMessageAccess(options, admin, `${adminAccountId}|2|900001`, true),
        /Permission required/,
      );
      assert.deepEqual(await readAdminMessageAccess(options, admin, `${adminAccountId}|2|900001`), serviceMessageAccess);
      await migration.query(`DELETE FROM "zzsh_iam"."admin_user_permission" WHERE "admin_user_id" = $1`, [adminId]);
      await migration.query(`UPDATE "zzsh_iam"."admin_security" SET "is_boss" = true WHERE "admin_user_id" = $1`, [adminId]);

      const closedService = await closeConsultation(options, admin, service.consultation.id, `${prefix}service-close`);
      assert.equal(closedService.consultation.state, "CLOSED");
      assert.equal(closedService.consultation.conversationId, null);
      assert.equal(closedService.consultation.messageScopeState, "REVOKED");
      assert.equal(provider.dismissed.at(-1), "900001");
      assert.equal(provider.members.has("900001"), false);
      const closedServiceInUserList = (await listUserConsultations(options, user, 10)).consultations.find(({ id }) => id === service.consultation.id);
      assert.equal(closedServiceInUserList?.conversationId, null);

      await runtime.query(
        `UPDATE "zzsh_iam"."im_support_presence"
            SET "last_connected_at" = clock_timestamp() - interval '2 minutes'
          WHERE "app_id" = $1 AND "admin_user_id" = $2`,
        [APP_ID, adminId],
      );
      const expiredBoundary = await createOrResumeUserConsultation(options, boundaryUser, "SERVICE", "listing_boundary", `${prefix}boundary-expired`);
      assert.equal(expiredBoundary.consultation.state, "WAITING");
      assert.equal(expiredBoundary.consultation.peerAccountId, null);
      assert.equal(expiredBoundary.consultation.conversationId, null);
      assert.equal(expiredBoundary.consultation.messageScopeState, "PENDING");
      assert.equal(provider.created.length, 1);

      const refreshed = await updateOwnPresence(options, admin, { availability: "AVAILABLE", connectionState: "CONNECTED" }, `${prefix}presence-refresh`);
      assert.equal(refreshed.connectionState, "CONNECTED");
      const freshPresence = await runtime.query<{ fresh: boolean }>(
        `SELECT "last_connected_at" > clock_timestamp() - interval '2 minutes' AS fresh
           FROM "zzsh_iam"."im_support_presence"
          WHERE "app_id" = $1 AND "admin_user_id" = $2`,
        [APP_ID, adminId],
      );
      assert.equal(freshPresence.rows[0]?.fresh, true);
      const boundaryComplaint = await createOrResumeUserConsultation(options, boundaryUser, "COMPLAINT", null, `${prefix}boundary-complaint`);
      assert.equal(boundaryComplaint.consultation.state, "ACTIVE");
      assert.equal(boundaryComplaint.consultation.peerAccountId, adminAccountId);
      assert.equal(boundaryComplaint.consultation.conversationId, `${boundaryUserAccountId}|2|900002`);
      assert.equal(boundaryComplaint.consultation.messageScopeState, "READY");
      await migration.query(`UPDATE "zzsh_iam"."admin_security" SET "is_boss" = false WHERE "admin_user_id" = $1`, [adminId]);
      await migration.query(
        `INSERT INTO "zzsh_iam"."admin_user_permission" ("admin_user_id", "permission_code", "effect")
         VALUES ($1, 'im.support.read', 'ALLOW'), ($1, 'im.support.accept', 'ALLOW'), ($1, 'im.support.complaint', 'ALLOW')
         ON CONFLICT ("admin_user_id", "permission_code") DO UPDATE SET "effect" = EXCLUDED."effect"`,
        [adminId],
      );
      const complaintMessageAccess = await readAdminMessageAccess(options, admin, `${adminAccountId}|2|900002`, true);
      await migration.query(
        `UPDATE "zzsh_iam"."admin_user_permission" SET "effect" = 'DENY' WHERE "admin_user_id" = $1 AND "permission_code" = 'im.support.complaint'`,
        [adminId],
      );
      await assert.rejects(
        readAdminMessageAccess(options, admin, `${adminAccountId}|2|900002`, true),
        /Permission required/,
      );
      assert.deepEqual(await readAdminMessageAccess(options, admin, `${adminAccountId}|2|900002`), complaintMessageAccess);
      await migration.query(`DELETE FROM "zzsh_iam"."admin_user_permission" WHERE "admin_user_id" = $1`, [adminId]);
      await migration.query(`UPDATE "zzsh_iam"."admin_security" SET "is_boss" = true WHERE "admin_user_id" = $1`, [adminId]);
      await closeConsultation(options, admin, boundaryComplaint.consultation.id, `${prefix}boundary-complaint-close`);
      assert.equal(provider.dismissed.includes("900002"), true);

      await updateOwnPresence(options, admin, { availability: "OFF_DUTY", connectionState: "DISCONNECTED" }, `${prefix}presence-offline`);
      const complaint = await createOrResumeUserConsultation(options, user, "COMPLAINT", null, `${prefix}complaint-create`);
      assert.equal(complaint.consultation.state, "WAITING");
      assert.equal(complaint.consultation.assignedAdmin, null);
      assert.equal(complaint.consultation.peerAccountId, null);

      await updateOwnPresence(options, admin, { availability: "AVAILABLE", connectionState: "CONNECTED" }, `${prefix}presence-reopen`);
      const waitingQueue = await listAdminConsultations(options, admin, access, 10);
      assert.equal(waitingQueue.consultations.some(({ id }) => id === complaint.consultation.id), true);
      const claimed = await claimConsultation(options, admin, complaint.consultation.id, `${prefix}complaint-claim`);
      assert.equal(claimed.consultation.state, "ACTIVE");
      assert.equal(claimed.consultation.assignedAdmin?.id, adminId);
      assert.equal(claimed.consultation.peerAccountId, userAccountId);
      assert.notEqual(claimed.consultation.peerAccountId, adminAccountId);
      assert.equal(claimed.consultation.conversationId, `${adminAccountId}|2|900003`);
      assert.equal(claimed.consultation.messageScopeState, "READY");
      const userComplaint = (await listUserConsultations(options, user, 10)).consultations.find(({ id }) => id === complaint.consultation.id);
      assert.equal(userComplaint?.peerAccountId, adminAccountId);
      assert.equal(userComplaint?.conversationId, `${userAccountId}|2|900003`);
      const closedComplaint = await closeConsultation(options, admin, complaint.consultation.id, `${prefix}complaint-close`);
      assert.equal(closedComplaint.consultation.state, "CLOSED");
      assert.equal(closedComplaint.consultation.conversationId, null);
      assert.equal(closedComplaint.consultation.messageScopeState, "REVOKED");
      assert.equal(provider.members.has("900003"), false);

      const transferable = await createOrResumeUserConsultation(options, user, "SERVICE", "listing_transfer", `${prefix}transfer-create`);
      assert.equal(transferable.consultation.assignedAdmin?.id, adminId);
      assert.equal(transferable.consultation.conversationId, `${userAccountId}|2|900004`);
      await updateOwnPresence(options, targetAdmin, { availability: "AVAILABLE", connectionState: "CONNECTED" }, `${prefix}target-online`);
      const targetAccess = await loadEffectiveAdminAccess(runtime, targetAdminId);
      assert.ok(targetAccess);
      let addEnteredResolve!: () => void;
      const addEntered = new Promise<void>((resolve) => { addEnteredResolve = resolve; });
      let releaseDelayedAdd!: () => void;
      const delayedAdd = new Promise<void>((resolve) => { releaseDelayedAdd = resolve; });
      provider.afterAdd = async (teamId, memberAccountId) => {
        if (teamId !== "900004" || memberAccountId !== targetAdminAccountId) return;
        addEnteredResolve();
        await delayedAdd;
      };
      const delayedTransfer = transferConsultation(options, admin, transferable.consultation.id, targetAdminId, `${prefix}transfer`);
      await addEntered;
      const inFlightRecovery = reconcileMessageScopes(options);
      assert.equal(await inFlightRecovery, 0, "a live provider action is not reclaimed before its lease expires");
      releaseDelayedAdd();
      await delayedTransfer;
      const transferred = await listAdminConsultations(options, targetAdmin, targetAccess, 10).then(({ consultations }) => consultations.find(({ id }) => id === transferable.consultation.id));
      assert.equal(transferred?.assignedAdmin?.id, targetAdminId);
      assert.equal(transferred?.peerAccountId, userAccountId);
      assert.equal(transferred?.conversationId, `${targetAdminAccountId}|2|900004`);
      assert.equal(transferred?.messageScopeState, "READY");
      assert.equal(provider.members.get("900004")?.has(userAccountId), true);
      assert.equal(provider.members.get("900004")?.has(adminAccountId), false);
      assert.equal(provider.members.get("900004")?.has(targetAdminAccountId), true);
      const primaryAfterTransfer = await listAdminConsultations(options, admin, access, 10);
      assert.equal(primaryAfterTransfer.consultations.some(({ id }) => id === transferable.consultation.id), false);
      const targetQueue = await listAdminConsultations(options, targetAdmin, targetAccess, 10);
      const targetView = targetQueue.consultations.find(({ id }) => id === transferable.consultation.id);
      assert.equal(targetView?.peerAccountId, userAccountId);
      assert.equal(targetView?.conversationId, `${targetAdminAccountId}|2|900004`);
      assert.equal(targetView?.messageScopeState, "READY");
      const reversed = await transferConsultation(options, targetAdmin, transferable.consultation.id, adminId, `${prefix}transfer-back`);
      assert.equal(reversed.consultation.assignedAdmin?.id, adminId);
      assert.equal(reversed.consultation.peerAccountId, userAccountId);
      assert.equal(reversed.consultation.conversationId, null);
      assert.equal(provider.members.get("900004")?.has(userAccountId), true);
      assert.equal(provider.members.get("900004")?.has(adminAccountId), true);
      assert.equal(provider.members.get("900004")?.has(targetAdminAccountId), false);
      const reversedView = (await listAdminConsultations(options, admin, access, 10)).consultations.find(({ id }) => id === transferable.consultation.id);
      assert.equal(reversedView?.conversationId, `${adminAccountId}|2|900004`);
      const closedTransfer = await closeConsultation(options, admin, transferable.consultation.id, `${prefix}transfer-close`);
      assert.equal(closedTransfer.consultation.state, "CLOSED");
      assert.equal(closedTransfer.consultation.conversationId, null);
      assert.equal(provider.members.has("900004"), false);

      await updateOwnPresence(options, targetAdmin, { availability: "OFF_DUTY", connectionState: "DISCONNECTED" }, `${prefix}target-off-duty`);
      const fencedTransfer = await createOrResumeUserConsultation(options, user, "SERVICE", "listing_fenced_transfer", `${prefix}fenced-transfer-create`);
      assert.equal(fencedTransfer.consultation.assignedAdmin?.id, adminId);
      await updateOwnPresence(options, targetAdmin, { availability: "AVAILABLE", connectionState: "CONNECTED" }, `${prefix}target-online-again`);
      let expiredGetEntered!: () => void;
      const expiredGet = new Promise<void>((resolve) => { releaseExpiredGet = resolve; });
      const expiredGetStarted = new Promise<void>((resolve) => { expiredGetEntered = resolve; });
      provider.beforeGet = async () => {
        await runtime!.query(
          `UPDATE "zzsh_iam"."im_consultation_scope_operation"
              SET "lease_until" = clock_timestamp() - interval '1 second'
            WHERE "consultation_id" = $1 AND "state" = 'RUNNING'`,
          [fencedTransfer.consultation.id],
        );
        expiredGetEntered();
        await expiredGet;
      };
      const staleTransfer = transferConsultation(options, admin, fencedTransfer.consultation.id, targetAdminId, `${prefix}fenced-transfer`);
      const staleTransferFailure = assert.rejects(staleTransfer, /scope lease changed/);
      await expiredGetStarted;
      const quarantine = reconcileMessageScopes(options);
      await waitFor("expired scope quarantine", async () => {
        const result = await runtime!.query<{ state: string; messageScopeState: string }>(
          `SELECT o."state", c."message_scope_state" AS "messageScopeState"
             FROM "zzsh_iam"."im_consultation_scope_operation" o
             JOIN "zzsh_iam"."im_consultation" c ON c."id" = o."consultation_id"
            WHERE o."consultation_id" = $1
            ORDER BY o."created_at" DESC, o."id" DESC
            LIMIT 1`,
          [fencedTransfer.consultation.id],
        );
        return result.rows[0]?.state === "NEEDS_REVIEW" && result.rows[0]?.messageScopeState === "FAILED";
      });
      assert.equal(await quarantine, 0, "an expired execution is quarantined, not reclaimed");
      releaseExpiredGet?.();
      await staleTransferFailure;
      assert.equal(provider.members.get("900005")?.has(adminAccountId), true);
      assert.equal(provider.members.get("900005")?.has(targetAdminAccountId), false);
      const fencedTransferQueue = await listAdminConsultations(options, admin, access, 10);
      const fencedTransferView = fencedTransferQueue.consultations.find(({ id }) => id === fencedTransfer.consultation.id);
      assert.equal(fencedTransferView?.peerAccountId, userAccountId);
      assert.equal(fencedTransferView?.conversationId, null);
      assert.equal(fencedTransferView?.messageScopeState, "FAILED");
      await assert.rejects(
        closeConsultation(options, admin, fencedTransfer.consultation.id, `${prefix}fenced-transfer-close`),
        /being recovered/,
      );
      await assert.rejects(
        retryMessageScopeOperation(options, admin, fencedTransfer.consultation.id, `${prefix}fenced-transfer-retry`),
        /远端结果未知/,
      );

      await updateOwnPresence(options, admin, { availability: "OFF_DUTY", connectionState: "DISCONNECTED" }, `${prefix}recovery-create-offline`);
      provider.failCreateBeforePersist = true;
      const recoveryQueue = await createOrResumeUserConsultation(options, boundaryUser, "SERVICE", "listing_recovery_create", `${prefix}recovery-create`);
      assert.equal(recoveryQueue.consultation.state, "WAITING");
      await updateOwnPresence(options, admin, { availability: "AVAILABLE", connectionState: "CONNECTED" }, `${prefix}recovery-create-online`);
      await assert.rejects(
        claimConsultation(options, admin, recoveryQueue.consultation.id, `${prefix}recovery-create-claim`),
        /being recovered/,
      );
      const findCallsAfterFailedCreate = provider.findCalls;
      assert.ok(findCallsAfterFailedCreate > 0, "the initial create attempt checked the marker before calling create");
      await assert.rejects(
        closeConsultation(options, admin, recoveryQueue.consultation.id, `${prefix}recovery-create-close-before-recovery`),
        /being recovered/,
      );
      assert.equal(provider.members.has("900006"), false, "a create that failed before the fake provider applied it has no visible team yet");
      assert.equal(provider.pendingCreates.has("900006"), true);
      const recoveryCreateState = await runtime.query<{ state: string; messageScopeState: string }>(
        `SELECT o."state", c."message_scope_state" AS "messageScopeState"
           FROM "zzsh_iam"."im_consultation_scope_operation" o
           JOIN "zzsh_iam"."im_consultation" c ON c."id" = o."consultation_id"
          WHERE o."consultation_id" = $1`,
        [recoveryQueue.consultation.id],
      );
      assert.deepEqual(recoveryCreateState.rows[0], { state: "NEEDS_REVIEW", messageScopeState: "FAILED" });
      await runtime.query(
        `UPDATE "zzsh_iam"."im_consultation_scope_operation"
            SET "next_retry_at" = clock_timestamp() - interval '1 second'
          WHERE "consultation_id" = $1`,
        [recoveryQueue.consultation.id],
      );
      assert.equal(await reconcileMessageScopes(options), 0);
      assert.equal(provider.findCalls, findCallsAfterFailedCreate, "an UNKNOWN create is fenced instead of treating a temporary ABSENT lookup as permission to create again");
      provider.applyLateCreate("900006");
      assert.equal(provider.members.has("900006"), true, "the old create may apply after the local HTTP failure");
      const quarantinedCreate = (await listAdminConsultations(options, admin, access, 10)).consultations.find(({ id }) => id === recoveryQueue.consultation.id);
      assert.equal(quarantinedCreate?.messageScopeState, "FAILED");
      assert.equal(quarantinedCreate?.conversationId, null);
      assert.equal(provider.created.length, 6, "create response loss must not create a duplicate team");
      await assert.rejects(
        retryMessageScopeOperation(options, admin, recoveryQueue.consultation.id, `${prefix}recovery-create-retry`),
        /远端结果未知/,
      );

      await updateOwnPresence(options, targetAdmin, { availability: "OFF_DUTY", connectionState: "DISCONNECTED" }, `${prefix}target-offline-for-recovery-transfer`);
      const recoveryTransfer = await createOrResumeUserConsultation(options, user, "COMPLAINT", "listing_recovery_transfer", `${prefix}recovery-transfer-create`);
      assert.equal(recoveryTransfer.consultation.assignedAdmin?.id, adminId);
      assert.equal(recoveryTransfer.consultation.messageScopeState, "READY");
      await updateOwnPresence(options, targetAdmin, { availability: "AVAILABLE", connectionState: "CONNECTED" }, `${prefix}target-refresh`);
      provider.failAddBeforePersist = true;
      await assert.rejects(
        transferConsultation(options, admin, recoveryTransfer.consultation.id, targetAdminId, `${prefix}recovery-transfer`),
        /being recovered/,
      );
      assert.equal(await reconcileMessageScopes(options), 0);
      assert.equal(provider.members.get("900007")?.has(managerAccountId), true);
      assert.equal(provider.members.get("900007")?.has(userAccountId), true);
      assert.equal(provider.members.get("900007")?.has(adminAccountId), true);
      assert.equal(provider.members.get("900007")?.has(targetAdminAccountId), false);
      provider.applyLateAdd("900007", targetAdminAccountId);
      assert.equal(provider.members.get("900007")?.has(targetAdminAccountId), true, "the fake provider applies the old add after HTTP failure");
      assert.equal(provider.members.get("900007")?.has(adminAccountId), true, "the late add leaves the old member until remote reconciliation");
      const quarantinedTransfer = (await listAdminConsultations(options, admin, access, 10)).consultations.find(({ id }) => id === recoveryTransfer.consultation.id);
      assert.equal(quarantinedTransfer?.messageScopeState, "FAILED");
      assert.equal(quarantinedTransfer?.conversationId, null);
      await assert.rejects(
        retryMessageScopeOperation(options, admin, recoveryTransfer.consultation.id, `${prefix}recovery-transfer-retry`),
        /远端结果未知/,
      );

      const recoveryClose = await createOrResumeUserConsultation(options, boundaryUser, "COMPLAINT", "listing_recovery_close", `${prefix}recovery-close-create`);
      const recoveryCloseAdmin = recoveryClose.consultation.assignedAdmin?.id === targetAdminId ? targetAdmin : admin;
      provider.failDismissAfterPersist = true;
      await assert.rejects(
        closeConsultation(options, recoveryCloseAdmin, recoveryClose.consultation.id, `${prefix}recovery-close`),
        /being recovered/,
      );
      assert.equal(await reconcileMessageScopes(options), 0);
      const quarantinedClose = (await listUserConsultations(options, boundaryUser, 20)).consultations.find(({ id }) => id === recoveryClose.consultation.id);
      assert.equal(quarantinedClose?.state, "ACTIVE");
      assert.equal(quarantinedClose?.messageScopeState, "FAILED");
      assert.equal(provider.members.has("900008"), false);
      await assert.rejects(
        retryMessageScopeOperation(options, recoveryCloseAdmin, recoveryClose.consultation.id, `${prefix}recovery-close-retry`),
        /远端结果未知/,
      );

      const identityAdminOnline = await updateOwnPresence(options, identityAdmin, { availability: "AVAILABLE", connectionState: "CONNECTED" }, `${prefix}identity-admin-online`);
      assert.equal(identityAdminOnline.activeLoad, 0);
      supportManagerReady = false;
      await assert.rejects(
        createOrResumeUserConsultation(options, userContext(identityPendingUserId, identityPendingUserSessionId), "SERVICE", "listing_inherited_failure", `${prefix}identity-pending-create`),
        /being recovered/,
      );
      const identityPendingConsultation = (await runtime.query<{ id: string; assignedAdminId: string | null }>(
        `SELECT "id", "assigned_admin_id" AS "assignedAdminId" FROM "zzsh_iam"."im_consultation"
          WHERE "app_id" = $1 AND "user_id" = $2 AND "kind" = 'SERVICE'`,
        [APP_ID, identityPendingUserId],
      )).rows[0];
      assert.ok(identityPendingConsultation);
      assert.equal(identityPendingConsultation.assignedAdminId, identityAdminId);
      const identityPendingOperation = (await runtime.query<{ state: string; failureClass: string | null; failureDetail: string | null }>(
        `SELECT "state", "last_failure_class" AS "failureClass", "last_failure_detail" AS "failureDetail"
           FROM "zzsh_iam"."im_consultation_scope_operation"
          WHERE "app_id" = $1 AND "consultation_id" = $2
          ORDER BY "created_at" DESC, "id" DESC LIMIT 1`,
        [APP_ID, identityPendingConsultation.id],
      )).rows[0];
      assert.deepEqual(identityPendingOperation, {
        state: "UNKNOWN",
        failureClass: "IDENTITY_PENDING",
        failureDetail: "IM support manager identity is pending",
      });
      await runtime.query(
        `UPDATE "zzsh_iam"."im_consultation_scope_operation"
            SET "next_retry_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "consultation_id" = $2`,
        [APP_ID, identityPendingConsultation.id],
      );
      assert.equal(await reconcileMessageScopes(options), 1, "identity-pending retry remains safe before any provider action");
      const identityPendingRetry = (await runtime.query<{ state: string; failureClass: string | null }>(
        `SELECT "state", "last_failure_class" AS "failureClass"
           FROM "zzsh_iam"."im_consultation_scope_operation"
          WHERE "app_id" = $1 AND "consultation_id" = $2
          ORDER BY "created_at" DESC, "id" DESC LIMIT 1`,
        [APP_ID, identityPendingConsultation.id],
      )).rows[0];
      assert.deepEqual(identityPendingRetry, { state: "UNKNOWN", failureClass: "IDENTITY_PENDING" });
      await runtime.query(
        `UPDATE "zzsh_iam"."im_consultation_scope_operation"
            SET "next_retry_at" = clock_timestamp()
          WHERE "app_id" = $1 AND "consultation_id" = $2`,
        [APP_ID, identityPendingConsultation.id],
      );

      supportManagerReady = true;
      let inheritedCreateTeamId = "";
      const inheritedCreateRelease = new Promise<void>((resolve) => { releaseInheritedCreate = resolve; });
      provider.beforeCreate = async (teamId) => {
        inheritedCreateTeamId = teamId;
        await inheritedCreateRelease;
      };
      inheritedRetry = reconcileMessageScopes(options);
      await waitFor("inherited create dispatch", async () => inheritedCreateTeamId !== "");
      await runtime.query(
        `UPDATE "zzsh_iam"."im_consultation_scope_operation"
            SET "lease_until" = clock_timestamp() - interval '1 second'
          WHERE "app_id" = $1 AND "consultation_id" = $2 AND "state" = 'RUNNING'`,
        [APP_ID, identityPendingConsultation.id],
      );
      assert.equal(await reconcileMessageScopes(options), 0, "an expired retry is quarantined instead of reclaimed");
      const inheritedQuarantine = (await runtime.query<{ state: string; failureClass: string | null; failureDetail: string | null; messageScopeState: string }>(
        `SELECT o."state", o."last_failure_class" AS "failureClass", o."last_failure_detail" AS "failureDetail",
                c."message_scope_state" AS "messageScopeState"
           FROM "zzsh_iam"."im_consultation_scope_operation" o
           JOIN "zzsh_iam"."im_consultation" c ON c."id" = o."consultation_id"
          WHERE o."app_id" = $1 AND o."consultation_id" = $2
          ORDER BY o."created_at" DESC, o."id" DESC LIMIT 1`,
        [APP_ID, identityPendingConsultation.id],
      )).rows[0];
      assert.equal(inheritedQuarantine?.state, "NEEDS_REVIEW");
      assert.equal(inheritedQuarantine?.failureClass, "PROVIDER_UNKNOWN");
      assert.match(inheritedQuarantine?.failureDetail ?? "", /^remote action may still be in flight;/);
      assert.equal(inheritedQuarantine?.messageScopeState, "FAILED");
      releaseInheritedCreate?.();
      assert.equal(await inheritedRetry, 1);
      inheritedRetry = undefined;
      assert.ok(inheritedCreateTeamId);
      assert.equal(provider.members.has(inheritedCreateTeamId), true, "the old create applies after the local lease was quarantined");
      const identityAdminAccess = await loadEffectiveAdminAccess(runtime, identityAdminId);
      assert.ok(identityAdminAccess);
      const inheritedView = (await listAdminConsultations(options, identityAdmin, identityAdminAccess, 20)).consultations.find(({ id }) => id === identityPendingConsultation.id);
      assert.equal(inheritedView?.messageScopeState, "FAILED");
      assert.equal(inheritedView?.conversationId, null);
      await assert.rejects(
        retryMessageScopeOperation(options, identityAdmin, identityPendingConsultation.id, `${prefix}identity-pending-retry`),
        /远端结果未知/,
      );
      const findCallsBeforeBlockedRecovery = provider.findCalls;
      assert.equal(await reconcileMessageScopes(options), 0);
      assert.equal(provider.findCalls, findCallsBeforeBlockedRecovery, "unknown late create is not auto-rebuilt");

      const primaryPresence = await readOwnPresence(options, admin);
      const targetPresence = await readOwnPresence(options, targetAdmin);
      assert.equal(primaryPresence.activeLoad, 3, "quarantined consultations retain the reserved local capacity until manual reconciliation");
      assert.equal(targetPresence.activeLoad, 3, "quarantined consultations retain the reserved local capacity until manual reconciliation");
      assert.equal((await readOwnPresence(options, identityAdmin)).activeLoad, 1);
      const eventCount = await runtime.query<{ consultationId: string; count: string }>(
        `SELECT "consultation_id" AS "consultationId", count(*)::text AS count
           FROM "zzsh_iam"."im_consultation_event"
          WHERE "consultation_id" IN (SELECT "id" FROM "zzsh_iam"."im_consultation" WHERE "user_id" = ANY($1::text[]))
          GROUP BY "consultation_id" ORDER BY "consultation_id"`,
        [syntheticUserIds],
      );
      assert.deepEqual(new Map(eventCount.rows.map(({ consultationId, count }) => [consultationId, count])), new Map([
        [service.consultation.id, "3"],
        [expiredBoundary.consultation.id, "2"],
        [boundaryComplaint.consultation.id, "3"],
        [complaint.consultation.id, "3"],
        [transferable.consultation.id, "5"],
        [fencedTransfer.consultation.id, "2"],
        [recoveryTransfer.consultation.id, "2"],
        [recoveryClose.consultation.id, "2"],
        [identityPendingConsultation.id, "2"],
      ]));
    } catch (error) {
      primaryFailure = error;
    }

    releaseExpiredGet?.();
    releaseInheritedCreate?.();

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
          `DELETE FROM "zzsh_iam"."im_consultation_event"
            WHERE "consultation_id" IN (SELECT "id" FROM "zzsh_iam"."im_consultation" WHERE "user_id" = ANY($1::text[]))`,
          [syntheticUserIds],
        );
        await migration!.query(
          `DELETE FROM "zzsh_iam"."im_consultation_scope_operation"
            WHERE "consultation_id" IN (SELECT "id" FROM "zzsh_iam"."im_consultation" WHERE "user_id" = ANY($1::text[]))`,
          [syntheticUserIds],
        );
        await migration!.query(`DELETE FROM "zzsh_iam"."im_consultation" WHERE "user_id" = ANY($1::text[])`, [syntheticUserIds]);
        await migration!.query(`DELETE FROM "zzsh_iam"."im_support_presence" WHERE "admin_user_id" = ANY($1::text[])`, [syntheticAdminIds]);
        await migration!.query(`DELETE FROM "zzsh_iam"."im_identity_mapping" WHERE "platform_subject_id" LIKE $1`, [`${prefix}%`]);
        await migration!.query(`DELETE FROM "zzsh_iam"."audit_event" WHERE "actor_id" = ANY($1::text[]) OR "object_id" = ANY($1::text[]) OR "request_id" LIKE $2`, [allSyntheticIds, `${prefix}%`]);
        await migration!.query(`DELETE FROM "zzsh_auth_admin"."session" WHERE "userId" = ANY($1::text[])`, [syntheticAdminIds]);
        await migration!.query(`DELETE FROM "zzsh_auth_user"."session" WHERE "userId" = ANY($1::text[])`, [syntheticUserIds]);
        await migration!.query(`DELETE FROM "zzsh_iam"."admin_security" WHERE "admin_user_id" = ANY($1::text[])`, [syntheticAdminIds]);
        await migration!.query(`DELETE FROM "zzsh_auth_admin"."user" WHERE "id" = ANY($1::text[])`, [syntheticAdminIds]);
        await migration!.query(`DELETE FROM "zzsh_auth_user"."user" WHERE "id" = ANY($1::text[])`, [syntheticUserIds]);
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
      event: "yunxin.pg.consultation.cleanup",
      runId,
      status: cleanupErrors.length === 0 ? "PASS" : "FAIL",
      steps: cleanupSteps,
    }));
    if (primaryFailure && cleanupErrors.length > 0) {
      throw new AggregateError([primaryFailure, ...cleanupErrors.map(({ error }) => error)], "0034 PG test and cleanup failed");
    }
    if (primaryFailure) throw primaryFailure;
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors.map(({ error }) => error), "0034 PG cleanup failed");
  },
);
