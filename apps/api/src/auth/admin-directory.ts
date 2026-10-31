import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import {
  ADMIN_PERMISSION,
  ADMIN_PERMISSION_CODES,
  assertDelegable,
  assertRolePermissionSet,
  computeProposedPermissions,
  evaluateAdminDirectoryActions,
  hasPermission,
  isAdminPermissionCode,
  loadEffectiveAdminAccess,
  requirePermission,
  type AdminFieldAccess,
  type EffectiveAdminAccess,
  type ProposedAdminGrants,
} from "./admin-authorization";
import { assertNoNewBossOnlyRoleGrants, isBossOnlyPermission } from "./admin-role-presets";
import { recordAudit, setAuditContext, SecurityApiError, withTransaction } from "./security-core";
import {
  ADMIN_GAME_SCOPE_MODE,
  assertGameScopeDelegable,
  effectiveGameScopeChange,
  parseAdminGameScopeInput,
  publicGameScope,
  readAdminGameScope,
  writeAdminGameScope,
  type AdminGameScope,
} from "./admin-scope";
import type { AuthSecurityOptions } from "./auth-security";
import {
  buildYunxinIdentityMarker,
  deriveYunxinAccountId,
  type ImIdentityIntent,
  type ImIdentityIntentRepository,
  type ImIdentityProvisioner,
  type ImIdentityQueryExecutor,
} from "../im/identity-lifecycle";

const STAFF_ENROLLMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROLE_CODE_PATTERN = /^[a-z][a-z0-9_]{1,62}$/;

type AdminContext = {
  userId: string;
  sessionId: string;
};

type DirectoryOptions = Pick<AuthSecurityOptions, "pool" | "hashPassword"> & {
  imProvisioner?: ImIdentityProvisioner;
  imIdentityRepository?: ImIdentityIntentRepository;
  imAppId?: string;
};

export async function nextAdminLogin(client: PoolClient): Promise<{ username: string; displayUsername: string }> {
  for (;;) {
    const sequence = await client.query<{ value: string }>(
      `SELECT nextval('"zzsh_iam"."admin_login_number_seq"')::text AS value`,
    );
    const value = sequence.rows[0]?.value;
    if (!value) throw new Error("administrator login sequence is unavailable");
    const username = `zz${value.padStart(5, "0")}`;
    const existing = await client.query(`SELECT 1 FROM "zzsh_auth_admin"."user" WHERE "username" = $1`, [username]);
    if (existing.rows.length === 0) return { username, displayUsername: username.toUpperCase() };
  }
}

export async function listAdministrators(
  pool: Pool,
  fields: AdminFieldAccess,
  actor?: { id: string; status: string; isBoss: boolean; permissions: ReadonlySet<string> },
): Promise<{ admins: Record<string, unknown>[]; createScopeRequired: true }> {
  const result = await pool.query<{
    adminId: string;
    username: string | null;
    displayName: string;
    twoFactorEnabled: boolean | null;
    status: string;
    isBoss: boolean;
    passwordChangeRequired: boolean;
    bootstrapExpiresAt: Date | null;
    firstActivatedAt: Date | null;
    scopeMode: string | null;
    image: string | null;
    createdAt: Date;
    lastFullAuthenticatedAt: Date | null;
    roles: unknown;
  }>(
    `SELECT u."id" AS "adminId",
        COALESCE(NULLIF(u."displayUsername", ''), UPPER(u."username")) AS "username",
        u."name" AS "displayName",
        u."twoFactorEnabled" AS "twoFactorEnabled",
        u."image" AS "image",
        s."status",
        s."is_boss" AS "isBoss",
        s."password_change_required" AS "passwordChangeRequired",
        s."bootstrap_expires_at" AS "bootstrapExpiresAt",
        s."first_activated_at" AS "firstActivatedAt",
        s."game_scope_mode" AS "scopeMode",
        u."createdAt" AS "createdAt",
        s."last_full_authenticated_at" AS "lastFullAuthenticatedAt",
        COALESCE(
          json_agg(json_build_object('id', r."id", 'code', r."code", 'name', r."name", 'status', r."status") ORDER BY r."code")
          FILTER (WHERE r."id" IS NOT NULL),
          '[]'::json
        ) AS "roles"
       FROM "zzsh_auth_admin"."user" u
       JOIN "zzsh_iam"."admin_security" s ON s."admin_user_id" = u."id"
       LEFT JOIN "zzsh_iam"."admin_user_role" ur ON ur."admin_user_id" = u."id"
       LEFT JOIN "zzsh_iam"."admin_role" r ON r."id" = ur."role_id"
      GROUP BY u."id", u."displayUsername", u."username", u."name", u."twoFactorEnabled", s."status",
               s."is_boss", s."password_change_required", s."bootstrap_expires_at", s."first_activated_at",
               s."game_scope_mode", u."createdAt", s."last_full_authenticated_at"
      ORDER BY s."is_boss" DESC, u."username"`,
  );
  // 两条按管理员分组的聚合，查询条数与行数无关；个人例外只在持有读取能力时才查。
  const [grantRows, scopeRows, sessionRows] = await Promise.all([
    fields.permissionRead
      ? pool.query<{ adminId: string; allows: string; denies: string }>(
          `SELECT "admin_user_id" AS "adminId",
                  COUNT(*) FILTER (WHERE "effect" = 'ALLOW')::text AS "allows",
                  COUNT(*) FILTER (WHERE "effect" = 'DENY')::text AS "denies"
             FROM "zzsh_iam"."admin_user_permission"
            GROUP BY "admin_user_id"`,
        )
      : null,
    pool.query<{ adminId: string; gameCount: string }>(
      `SELECT "admin_user_id" AS "adminId", COUNT(*)::text AS "gameCount"
         FROM "zzsh_supply"."admin_supply_scope"
        GROUP BY "admin_user_id"`,
    ),
    // 会话事实只出计数与时间：不返回 session id、token、IP、userAgent。
    pool.query<{ adminId: string; activeCount: string; lockedCount: string; latestSessionAt: Date | null }>(
      `SELECT "userId" AS "adminId",
              COUNT(*) FILTER (WHERE "expiresAt" > now())::text AS "activeCount",
              COUNT(*) FILTER (WHERE "locked" AND "expiresAt" > now())::text AS "lockedCount",
              MAX("createdAt") FILTER (WHERE "expiresAt" > now()) AS "latestSessionAt"
         FROM "zzsh_auth_admin"."session"
        GROUP BY "userId"`,
    ),
  ]);
  const grantsByAdmin = new Map((grantRows?.rows ?? []).map((row) => [row.adminId, row]));
  const scopeByAdmin = new Map(scopeRows.rows.map((row) => [row.adminId, Number(row.gameCount)]));
  const sessionByAdmin = new Map(sessionRows.rows.map((row) => [row.adminId, row]));
  return {
    createScopeRequired: true,
    admins: result.rows.map((row) => {
      const entry: Record<string, unknown> = {
        id: row.adminId,
        username: row.username ?? "未分配账号",
        name: row.displayName,
        status: row.status,
        isBoss: row.isBoss,
        createdAt: row.createdAt.toISOString(),
        lastFullAuthenticatedAt: row.lastFullAuthenticatedAt?.toISOString() ?? null,
        image: row.image,
        // 列表只出会话事实：未过期会话数、其中锁定数、最近一条未过期会话的建立时间。
        sessionSummary: {
          activeCount: Number(sessionByAdmin.get(row.adminId)?.activeCount ?? 0),
          lockedCount: Number(sessionByAdmin.get(row.adminId)?.lockedCount ?? 0),
          lastSessionCreatedAt: sessionByAdmin.get(row.adminId)?.latestSessionAt?.toISOString() ?? null,
        },
        // 列表只出摘要事实；完整认证时间不等于"最近活跃"，会话数不等于"在线"，所以这里都不出。
        securitySummary: {
          passwordChangeRequired: row.passwordChangeRequired,
          twoFactorEnabled: row.twoFactorEnabled,
          bootstrapExpiresAt: row.bootstrapExpiresAt?.toISOString() ?? null,
          firstActivatedAt: row.firstActivatedAt?.toISOString() ?? null,
        },
        scopeSummary:
          row.scopeMode === ADMIN_GAME_SCOPE_MODE.ALL_GAMES
            ? { mode: ADMIN_GAME_SCOPE_MODE.ALL_GAMES }
            : { mode: ADMIN_GAME_SCOPE_MODE.SELECTED_GAMES, gameCount: scopeByAdmin.get(row.adminId) ?? 0 },
      };
      if (fields.roleRead) entry.roles = row.roles;
      if (fields.permissionRead) {
        const grants = grantsByAdmin.get(row.adminId);
        entry.personalGrantSummary = { allows: Number(grants?.allows ?? 0), denies: Number(grants?.denies ?? 0) };
      }
      if (actor) {
        entry.actions = evaluateAdminDirectoryActions({
          actorId: actor.id,
          actorStatus: actor.status,
          actorIsBoss: actor.isBoss,
          actorPermissions: actor.permissions,
          targetId: row.adminId,
          targetIsBoss: row.isBoss,
          targetStatus: row.status,
        });
      }
      return entry;
    }),
  };
}

export async function readAdministratorDetail(
  pool: Pool,
  username: string,
  fields: AdminFieldAccess,
  actor?: { id: string; status: string; isBoss: boolean; permissions: ReadonlySet<string> },
): Promise<Record<string, unknown>> {
  const login = normalizeUsername(username);
  const result = await pool.query<{
    adminId: string;
    username: string | null;
    displayName: string;
    status: string;
    image: string | null;
    isBoss: boolean;
    passwordChangeRequired: boolean;
    twoFactorEnabled: boolean | null;
    bootstrapExpiresAt: Date | null;
    bootstrapUsedAt: Date | null;
    firstActivatedAt: Date | null;
    createdAt: Date;
    lastFullAuthenticatedAt: Date | null;
  }>(
    `SELECT u."id" AS "adminId",
        COALESCE(NULLIF(u."displayUsername", ''), UPPER(u."username")) AS "username",
        u."name" AS "displayName",
        u."twoFactorEnabled" AS "twoFactorEnabled",
        s."status",
        s."is_boss" AS "isBoss",
        s."password_change_required" AS "passwordChangeRequired",
        s."bootstrap_expires_at" AS "bootstrapExpiresAt",
        s."bootstrap_used_at" AS "bootstrapUsedAt",
        s."first_activated_at" AS "firstActivatedAt",
        u."createdAt" AS "createdAt",
        s."last_full_authenticated_at" AS "lastFullAuthenticatedAt",
        u."image" AS "image"
       FROM "zzsh_auth_admin"."user" u
       JOIN "zzsh_iam"."admin_security" s ON s."admin_user_id" = u."id"
      WHERE LOWER(u."username") = $1
      LIMIT 1`,
    [login],
  );
  const row = result.rows[0];
  if (!row) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Administrator not found");
  // 会话只数未过期的，且只出计数：不返回 session id、token、IP、userAgent、PIN。
  const sessions = await pool.query<{ activeCount: string; lockedCount: string; latestSessionAt: Date | null }>(
    `SELECT COUNT(*)::text AS "activeCount",
            COUNT(*) FILTER (WHERE "locked")::text AS "lockedCount",
            MAX("createdAt") AS "latestSessionAt"
       FROM "zzsh_auth_admin"."session"
      WHERE "userId" = $1 AND "expiresAt" > now()`,
    [row.adminId],
  );
  const sessionRow = sessions.rows[0];
  const at = (value: Date | null | undefined): string | null => (value ? value.toISOString() : null);
  const detail: Record<string, unknown> = {
    id: row.adminId,
    username: row.username ?? "未分配账号",
    name: row.displayName,
    status: row.status,
    isBoss: row.isBoss,
    createdAt: row.createdAt.toISOString(),
    lastFullAuthenticatedAt: at(row.lastFullAuthenticatedAt),
    image: row.image,
    // twoFactorEnabled 列可空：NULL 表示未知，不折算成 false。
    security: {
      status: row.status,
      isBoss: row.isBoss,
      passwordChangeRequired: row.passwordChangeRequired,
      twoFactorEnabled: row.twoFactorEnabled,
      bootstrapExpiresAt: at(row.bootstrapExpiresAt),
      bootstrapUsedAt: at(row.bootstrapUsedAt),
      firstActivatedAt: at(row.firstActivatedAt),
    },
    sessionSummary: {
      activeCount: Number(sessionRow?.activeCount ?? 0),
      lockedCount: Number(sessionRow?.lockedCount ?? 0),
      lastSessionCreatedAt: at(sessionRow?.latestSessionAt),
    },
  };
  if (fields.roleRead || fields.permissionRead) {
    const grants = await readGrants(pool, row.adminId);
    if (fields.roleRead) detail.roles = grants.roles;
    if (fields.permissionRead) {
      const access = await loadEffectiveAdminAccess(pool, row.adminId);
      detail.allowPermissions = grants.allowPermissions;
      detail.denyPermissions = grants.denyPermissions;
      detail.effectivePermissions = access ? [...access.permissions].sort() : [];
    }
  }
  detail.scope = publicGameScope(await readAdminGameScope(pool, row.adminId));
  if (actor) {
    detail.actions = evaluateAdminDirectoryActions({
      actorId: actor.id,
      actorStatus: actor.status,
      actorIsBoss: actor.isBoss,
      actorPermissions: actor.permissions,
      targetId: row.adminId,
      targetIsBoss: row.isBoss,
      targetStatus: row.status,
    });
  }
  return detail;
}

/** Account-level game scope read for the administrator page; no grants are changed. */
export async function readAdministratorGameScope(pool: Pool, username: string): Promise<{ username: string; scope: AdminGameScope }> {
  const login = normalizeUsername(username);
  const result = await pool.query<{ adminId: string; username: string | null }>(
    `SELECT u."id" AS "adminId", COALESCE(NULLIF(u."displayUsername", ''), UPPER(u."username")) AS "username"
       FROM "zzsh_auth_admin"."user" u
       JOIN "zzsh_iam"."admin_security" s ON s."admin_user_id" = u."id"
      WHERE LOWER(u."username") = $1
      LIMIT 1`,
    [login],
  );
  const row = result.rows[0];
  if (!row) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Administrator not found");
  return { username: row.username ?? login.toUpperCase(), scope: publicGameScope(await readAdminGameScope(pool, row.adminId)) };
}

export async function listRolesAndCatalog(pool: Pool, fields: AdminFieldAccess): Promise<Record<string, unknown>> {
  const [roles, permissions] = await Promise.all([
    pool.query<{
      id: string;
      code: string;
      name: string;
      description: string | null;
      status: string;
      permissionCodes: string[] | null;
    }>(
      `SELECT r."id", r."code", r."name", r."description", r."status",
          COALESCE(array_agg(rp."permission_code" ORDER BY rp."permission_code") FILTER (WHERE rp."permission_code" IS NOT NULL), '{}') AS "permissionCodes"
         FROM "zzsh_iam"."admin_role" r
         LEFT JOIN "zzsh_iam"."admin_role_permission" rp ON rp."role_id" = r."id"
        GROUP BY r."id"
        ORDER BY r."code"`,
    ),
    pool.query<{ code: string; name: string; description: string | null }>(
      `SELECT "code", "name", "description" FROM "zzsh_iam"."admin_permission" ORDER BY "code"`,
    ),
  ]);
  return {
    roles: fields.roleRead
      ? roles.rows.map((role) => ({
          id: role.id,
          code: role.code,
          name: role.name,
          description: role.description,
          status: role.status,
          // 已退役的权限码（如 user.account.restore）仍在库里，但不再展示
          permissionCodes: (role.permissionCodes ?? []).filter(isAdminPermissionCode),
        }))
      : [],
    permissions: fields.permissionRead ? permissions.rows.filter((row) => isAdminPermissionCode(row.code)).map((row) => ({ ...row, bossOnly: isBossOnlyPermission(row.code) })) : [],
  };
}

export async function createAdministrator(
  context: AdminContext,
  body: Record<string, unknown>,
  requestId: string,
  options: DirectoryOptions,
): Promise<Record<string, unknown>> {
  if (body.username !== undefined || body.isBoss !== undefined || body.password !== undefined) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Administrator login is generated by the server");
  }
  const name = requiredName(body);
  const grants = grantsFromBody(body);
  const scopeChange = parseAdminGameScopeInput(body);
  if (scopeChange.mode === "SELECTED_GAMES" && !scopeChange.replaceSelected) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "An explicit selected game set is required");
  }
  const imAppId = options.imAppId;
  const imProvisioner = options.imProvisioner;
  const imIdentityRepository = options.imIdentityRepository;
  const imConfigured = imAppId !== undefined || imProvisioner !== undefined || imIdentityRepository !== undefined;
  if (imConfigured && (!imAppId || !imProvisioner || !imIdentityRepository)) {
    throw new Error("IM identity binding is incompletely configured");
  }
  const temporaryPassword = randomBytes(18).toString("base64url");
  const passwordHash = await options.hashPassword(temporaryPassword);
  const { result, imIntent, imMapping } = await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    const actor = await lockActor(client, context.userId, grants.roleIds);
    requirePermission(actor, ADMIN_PERMISSION.accountCreate);
    assertGameScopeDelegable(await readAdminGameScope(client, context.userId), actor.isBoss, scopeChange);
    if (scopeChange.gameIds.length > 0) {
      const games = await client.query(`SELECT "id" FROM "zzsh_supply"."game" WHERE "id" = ANY($1::text[])`, [scopeChange.gameIds]);
      if (games.rows.length !== scopeChange.gameIds.length) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Selected game does not exist");
    }
    const proposed = await computeProposedPermissions(client, grants);
    if (grants.roleIds.length > 0 || grants.allowPermissions.length > 0 || grants.denyPermissions.length > 0) {
      requirePermission(actor, ADMIN_PERMISSION.permissionGrant);
    }
    assertDelegable(actor, union(proposed, grants.denyPermissions));
    const now = new Date();
    const login = await nextAdminLogin(client);
    const loginEmail = `${login.username}@admin.zzsh.invalid`;
    const id = `admin_${randomUUID().replaceAll("-", "")}`;
    const imKey = imAppId
      ? { provider: "yunxin" as const, appId: imAppId, realm: "admin", kind: "ADMIN" as const, platformSubjectId: id }
      : undefined;
    const imIntent: ImIdentityIntent | undefined = imKey
      ? { key: imKey, accountId: deriveYunxinAccountId(imKey), identityMarker: buildYunxinIdentityMarker(imKey) }
      : undefined;
    await client.query(
      `INSERT INTO "zzsh_auth_admin"."user" ("id", "name", "email", "createdAt", "updatedAt", "username", "displayUsername", "twoFactorEnabled", "suspended")
       VALUES ($1, $2, $3, $4, $4, $5, $6, false, false)`,
      [id, name, loginEmail, now, login.username, login.displayUsername],
    );
    await client.query(
      `INSERT INTO "zzsh_auth_admin"."account" ("id", "accountId", "providerId", "userId", "password", "createdAt", "updatedAt")
       VALUES ($1, $2, 'credential', $2, $3, $4, $4)`,
      [`account_${randomUUID().replaceAll("-", "")}`, id, passwordHash, now],
    );
    await client.query(
      `INSERT INTO "zzsh_iam"."admin_security" ("admin_user_id", "status", "is_boss", "password_change_required", "bootstrap_expires_at")
       VALUES ($1, 'PENDING_ENROLLMENT', false, true, $2)`,
      [id, new Date(now.getTime() + STAFF_ENROLLMENT_TTL_MS)],
    );
    await replaceGrants(client, id, grants);
    await writeAdminGameScope(client, id, scopeChange, context.userId);
    const imMapping = imIntent && imIdentityRepository
      ? await imIdentityRepository.ensureIntentInTransaction({
          query: <T extends Record<string, any> = Record<string, any>>(text: string, values?: unknown[]) => client.query<T>(text, values),
        } satisfies ImIdentityQueryExecutor, imIntent)
      : null;
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "admin.account.created",
      objectType: "admin_user",
      objectId: id,
      outcome: "SUCCESS",
      requestId,
      details: {
        username: login.displayUsername,
        name,
        isBoss: false,
        roleIds: grants.roleIds,
        allowPermissions: grants.allowPermissions,
        denyPermissions: grants.denyPermissions,
        effectivePermissions: [...proposed].sort(),
        scope: publicGameScope(scopeChange),
      },
    });
    const result = {
      id,
      username: login.displayUsername,
      name,
      status: "PENDING_ENROLLMENT",
      isBoss: false,
    };
    return { result, imIntent, imMapping };
  });
  if (!imProvisioner || !imIntent || !imMapping) return { ...result, temporaryPassword };
  let imIdentity = imMapping;
  try {
    imIdentity = (await imProvisioner.ensure({ key: imIntent.key, displayName: result.name })).mapping;
  } catch {
    // The PENDING intent is committed already; keep administrator creation successful and let recovery retry IM.
  }
  return {
    ...result,
    temporaryPassword,
    imIdentity: { accountId: imIdentity.accountId, status: imIdentity.status },
  };
}

export async function updateAdministrator(
  context: AdminContext,
  body: Record<string, unknown>,
  requestId: string,
  options: DirectoryOptions,
): Promise<Record<string, unknown>> {
  const username = normalizeUsername(requiredString(body, "username", 64));
  const name = requiredName(body);
  return withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    const actor = await lockActor(client, context.userId);
    requirePermission(actor, ADMIN_PERMISSION.accountUpdate);
    const target = await lockTargetByUsername(client, username);
    if (target.isBoss && !actor.isBoss) {
      throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Boss identity cannot be modified by this operation");
    }
    const previousName = target.name;
    await client.query(
      `UPDATE "zzsh_auth_admin"."user" SET "name" = $1, "updatedAt" = clock_timestamp() WHERE "id" = $2`,
      [name, target.id],
    );
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "admin.account.updated",
      objectType: "admin_user",
      objectId: target.id,
      outcome: "SUCCESS",
      requestId,
      details: { username: target.username, before: { name: previousName }, after: { name } },
    });
    return { username: target.username, name };
  });
}

export async function assignAdministratorAccess(
  context: AdminContext,
  body: Record<string, unknown>,
  requestId: string,
  options: DirectoryOptions,
): Promise<Record<string, unknown>> {
  const username = normalizeUsername(requiredString(body, "username", 64));
  const grants = grantsFromBody(body);
  return withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    const actor = await lockActor(client, context.userId, grants.roleIds);
    requirePermission(actor, ADMIN_PERMISSION.permissionGrant);
    const target = await lockTargetByUsername(client, username);
    if (target.isBoss) {
      throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Boss identity cannot be modified by this operation");
    }
    const proposed = await computeProposedPermissions(client, grants);
    assertDelegable(actor, union(proposed, grants.denyPermissions));
    const before = await readGrants(client, target.id);
    await replaceGrants(client, target.id, grants);
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "admin.permission.assigned",
      objectType: "admin_user",
      objectId: target.id,
      outcome: "SUCCESS",
      requestId,
      details: {
        username: target.username,
        before,
        after: {
          roles: grants.roleIds,
          allowPermissions: grants.allowPermissions,
          denyPermissions: grants.denyPermissions,
          effectivePermissions: [...proposed].sort(),
        },
      },
    });
    return {
      username: target.username,
      roleIds: grants.roleIds,
      allowPermissions: grants.allowPermissions,
      denyPermissions: grants.denyPermissions,
      effectivePermissions: [...proposed].sort(),
    };
  });
}

/**
 * Account-level game scope assignment. Scope binds to the administrator
 * account, not to roles; a non-Boss actor cannot widen another account beyond
 * their own effective scope and Boss scope is immutable (always ALL_GAMES).
 */
export async function assignAdministratorGameScope(
  context: AdminContext,
  body: Record<string, unknown>,
  requestId: string,
  options: DirectoryOptions,
): Promise<Record<string, unknown>> {
  const username = normalizeUsername(requiredString(body, "username", 64));
  const change = parseAdminGameScopeInput(body);
  return withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    const actor = await lockActor(client, context.userId);
    requirePermission(actor, ADMIN_PERMISSION.permissionGrant);
    const target = await lockTargetByUsername(client, username);
    if (target.isBoss) {
      throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Boss identity cannot be modified by this operation");
    }
    const before = await readAdminGameScope(client, target.id);
    const effective = effectiveGameScopeChange(before, change);
    assertGameScopeDelegable(await readAdminGameScope(client, context.userId), actor.isBoss, effective);
    if (change.replaceSelected && change.gameIds.length > 0) {
      const known = await client.query<{ id: string }>(`SELECT "id" FROM "zzsh_supply"."game" WHERE "id" = ANY($1::text[])`, [change.gameIds]);
      if (known.rows.length !== change.gameIds.length) {
        throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid", [{ path: "gameIds", code: "INVALID_FIELD" }]);
      }
    }
    await writeAdminGameScope(client, target.id, change, context.userId);
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "admin.game_scope.assigned",
      objectType: "admin_user",
      objectId: target.id,
      outcome: "SUCCESS",
      requestId,
      details: { username: target.username, before, after: effective },
    });
    return { username: target.username, scope: publicGameScope(effective) };
  });
}

export async function createRole(
  context: AdminContext,
  body: Record<string, unknown>,
  requestId: string,
  options: DirectoryOptions,
): Promise<Record<string, unknown>> {
  const code = requiredString(body, "code", 64).trim().toLowerCase();
  if (!ROLE_CODE_PATTERN.test(code)) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Role code is invalid");
  }
  const name = requiredName(body);
  const description = optionalDescription(body);
  const permissionCodes = permissionCodesFromBody(body);
  return withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    const actor = await lockActor(client, context.userId);
    requirePermission(actor, ADMIN_PERMISSION.roleConfigure);
    assertDelegable(actor, permissionCodes);
    assertNoNewBossOnlyRoleGrants([], permissionCodes);
    const id = `role_${randomUUID().replaceAll("-", "")}`;
    try {
      await client.query(
        `INSERT INTO "zzsh_iam"."admin_role" ("id", "code", "name", "description", "status")
         VALUES ($1, $2, $3, $4, 'ACTIVE')`,
        [id, code, name, description],
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Role code already exists");
      throw error;
    }
    await replaceRolePermissions(client, id, permissionCodes);
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "admin.role.created",
      objectType: "admin_role",
      objectId: id,
      outcome: "SUCCESS",
      requestId,
      details: { code, name, description, permissionCodes },
    });
    return { id, code, name, description, status: "ACTIVE", permissionCodes };
  });
}

export async function updateRole(
  context: AdminContext,
  body: Record<string, unknown>,
  requestId: string,
  options: DirectoryOptions,
): Promise<Record<string, unknown>> {
  const roleKey = typeof body.code === "string" && body.code.length > 0
    ? requiredString(body, "code", 64).trim().toLowerCase()
    : requiredString(body, "roleId", 128);
  const name = body.name === undefined ? undefined : requiredName(body);
  const description = body.description === undefined ? undefined : optionalDescription(body);
  const status = body.status === undefined ? undefined : requiredRoleStatus(body);
  const permissionCodes = body.permissionCodes === undefined ? undefined : permissionCodesFromBody(body);
  if (name === undefined && description === undefined && status === undefined && permissionCodes === undefined) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid");
  }
  return withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    const identified = await client.query<{ id: string }>(
      `SELECT "id" FROM "zzsh_iam"."admin_role" WHERE "id" = $1 OR "code" = $1`,
      [roleKey],
    );
    if (!identified.rows[0]) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Role not found");
    const actor = await lockActor(client, context.userId, [identified.rows[0].id]);
    requirePermission(actor, ADMIN_PERMISSION.roleConfigure);
    const role = await client.query<{ id: string; code: string; name: string; description: string | null; status: string }>(
      `SELECT "id", "code", "name", "description", "status"
         FROM "zzsh_iam"."admin_role"
        WHERE "id" = $1
        FOR UPDATE`,
      [identified.rows[0].id],
    );
    const current = role.rows[0];
    if (!current) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Role not found");
    const existingPermissions = await client.query<{ permissionCode: string }>(
      `SELECT "permission_code" AS "permissionCode" FROM "zzsh_iam"."admin_role_permission" WHERE "role_id" = $1`,
      [current.id],
    );
    const beforeCodes = existingPermissions.rows.map((row) => row.permissionCode).sort();
    const nextStatus = status ?? current.status;
    const afterCodes = permissionCodes ?? beforeCodes;
    assertRolePermissionSet(actor, afterCodes, nextStatus, permissionCodes !== undefined);
    assertNoNewBossOnlyRoleGrants(beforeCodes, afterCodes);
    if (permissionCodes) {
      await replaceRolePermissions(client, current.id, permissionCodes);
    }
    const nextName = name ?? current.name;
    const nextDescription = description === undefined ? current.description : description;
    await client.query(
      `UPDATE "zzsh_iam"."admin_role"
          SET "name" = $1, "description" = $2, "status" = $3, "updated_at" = clock_timestamp()
        WHERE "id" = $4`,
      [nextName, nextDescription, nextStatus, current.id],
    );
    await recordAudit(client, {
      actorType: "admin",
      actorId: context.userId,
      sessionId: context.sessionId,
      action: "admin.role.updated",
      objectType: "admin_role",
      objectId: current.id,
      outcome: "SUCCESS",
      requestId,
      details: {
        code: current.code,
        before: { name: current.name, description: current.description, status: current.status, permissionCodes: beforeCodes },
        after: { name: nextName, description: nextDescription, status: nextStatus, permissionCodes: afterCodes },
      },
    });
    return {
      id: current.id,
      code: current.code,
      name: nextName,
      description: nextDescription,
      status: nextStatus,
      permissionCodes: afterCodes,
    };
  });
}

export async function requireDirectoryPermission(
  pool: Pool | PoolClient,
  userId: string,
  permission: string,
): Promise<EffectiveAdminAccess> {
  const access = await loadEffectiveAdminAccess(pool, userId);
  requirePermission(access, permission);
  return access!;
}

function grantsFromBody(body: Record<string, unknown>): ProposedAdminGrants {
  return {
    roleIds: stringArrayField(body, "roleIds", 32, 128),
    allowPermissions: stringArrayField(body, "allowPermissions", ADMIN_PERMISSION_CODES.length, 128),
    denyPermissions: stringArrayField(body, "denyPermissions", ADMIN_PERMISSION_CODES.length, 128),
  };
}

function permissionCodesFromBody(body: Record<string, unknown>): string[] {
  return stringArrayField(body, "permissionCodes", ADMIN_PERMISSION_CODES.length, 128);
}

async function replaceGrants(client: PoolClient, adminUserId: string, grants: ProposedAdminGrants): Promise<void> {
  await client.query(`DELETE FROM "zzsh_iam"."admin_user_role" WHERE "admin_user_id" = $1`, [adminUserId]);
  await client.query(`DELETE FROM "zzsh_iam"."admin_user_permission" WHERE "admin_user_id" = $1`, [adminUserId]);
  for (const roleId of grants.roleIds) {
    await client.query(
      `INSERT INTO "zzsh_iam"."admin_user_role" ("admin_user_id", "role_id") VALUES ($1, $2)`,
      [adminUserId, roleId],
    );
  }
  const effects = new Map<string, "ALLOW" | "DENY">();
  for (const code of grants.allowPermissions) effects.set(code, "ALLOW");
  for (const code of grants.denyPermissions) effects.set(code, "DENY");
  for (const [code, effect] of effects) {
    await client.query(
      `INSERT INTO "zzsh_iam"."admin_user_permission" ("admin_user_id", "permission_code", "effect")
       VALUES ($1, $2, $3)`,
      [adminUserId, code, effect],
    );
  }
}

async function replaceRolePermissions(client: PoolClient, roleId: string, permissionCodes: string[]): Promise<void> {
  await client.query(`DELETE FROM "zzsh_iam"."admin_role_permission" WHERE "role_id" = $1`, [roleId]);
  for (const code of permissionCodes) {
    await client.query(
      `INSERT INTO "zzsh_iam"."admin_role_permission" ("role_id", "permission_code") VALUES ($1, $2)`,
      [roleId, code],
    );
  }
}

async function readGrants(pool: Pool | PoolClient, adminUserId: string): Promise<{
  roles: { id: string; code: string; name: string; status: string }[];
  allowPermissions: string[];
  denyPermissions: string[];
}> {
  const [roles, personal] = await Promise.all([
    pool.query<{ id: string; code: string; name: string; status: string }>(
      `SELECT r."id", r."code", r."name", r."status"
         FROM "zzsh_iam"."admin_user_role" ur
         JOIN "zzsh_iam"."admin_role" r ON r."id" = ur."role_id"
        WHERE ur."admin_user_id" = $1
        ORDER BY r."code"`,
      [adminUserId],
    ),
    pool.query<{ permissionCode: string; effect: "ALLOW" | "DENY" }>(
      `SELECT "permission_code" AS "permissionCode", "effect"
         FROM "zzsh_iam"."admin_user_permission"
        WHERE "admin_user_id" = $1
        ORDER BY "permission_code"`,
      [adminUserId],
    ),
  ]);
  return {
    roles: roles.rows,
    allowPermissions: personal.rows.filter((row) => row.effect === "ALLOW").map((row) => row.permissionCode),
    denyPermissions: personal.rows.filter((row) => row.effect === "DENY").map((row) => row.permissionCode),
  };
}

async function lockActor(client: PoolClient, userId: string, extraRoleIds: string[] = []): Promise<EffectiveAdminAccess> {
  const locked = await client.query<{ status: EffectiveAdminAccess["status"]; isBoss: boolean; passwordChangeRequired: boolean }>(
    `SELECT "status", "is_boss" AS "isBoss", "password_change_required" AS "passwordChangeRequired"
       FROM "zzsh_iam"."admin_security"
      WHERE "admin_user_id" = $1
      FOR UPDATE`,
    [userId],
  );
  const row = locked.rows[0];
  if (!row || row.status !== "ACTIVE") {
    throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Permission required");
  }
  const assigned = await client.query<{ roleId: string }>(
    `SELECT "role_id" AS "roleId" FROM "zzsh_iam"."admin_user_role" WHERE "admin_user_id" = $1`,
    [userId],
  );
  const roleIds = [...new Set([...assigned.rows.map((item) => item.roleId), ...extraRoleIds])].sort();
  if (roleIds.length > 0) {
    await client.query(
      `SELECT "id" FROM "zzsh_iam"."admin_role" WHERE "id" = ANY($1::text[]) ORDER BY "id" FOR UPDATE`,
      [roleIds],
    );
  }
  const access = await loadEffectiveAdminAccess(client, userId);
  if (!access || access.status !== "ACTIVE") {
    throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Permission required");
  }
  return access;
}

export { lockActor };

async function lockTargetByUsername(client: PoolClient, username: string): Promise<{
  id: string;
  username: string;
  name: string;
  isBoss: boolean;
  status: string;
}> {
  const target = await client.query<{
    id: string;
    username: string | null;
    name: string;
    isBoss: boolean;
    status: string;
  }>(
    `SELECT u."id",
        COALESCE(NULLIF(u."displayUsername", ''), UPPER(u."username")) AS "username",
        u."name",
        s."is_boss" AS "isBoss",
        s."status"
       FROM "zzsh_auth_admin"."user" u
       JOIN "zzsh_iam"."admin_security" s ON s."admin_user_id" = u."id"
      WHERE LOWER(u."username") = $1
      FOR UPDATE OF s, u`,
    [username],
  );
  const row = target.rows[0];
  if (!row) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Administrator not found");
  return {
    id: row.id,
    username: row.username ?? username.toUpperCase(),
    name: row.name,
    isBoss: row.isBoss,
    status: row.status,
  };
}

function requiredName(body: Record<string, unknown>): string {
  const name = requiredString(body, "name", 120).trim();
  if (!name) throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid");
  return name;
}

function optionalDescription(body: Record<string, unknown>): string | null {
  if (body.description === undefined || body.description === null) return null;
  const value = requiredString(body, "description", 240).trim();
  return value.length > 0 ? value : null;
}

function requiredRoleStatus(body: Record<string, unknown>): "ACTIVE" | "DISABLED" {
  const value = requiredString(body, "status", 16);
  if (value !== "ACTIVE" && value !== "DISABLED") {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid");
  }
  return value;
}

function requiredString(body: Record<string, unknown>, field: string, maxLength: number): string {
  const value = body[field];
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid");
  }
  return value;
}

function stringArrayField(body: Record<string, unknown>, field: string, maxItems: number, maxLength: number): string[] {
  const value = body[field];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maxItems) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid");
  }
  const result: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0 || item.length > maxLength) {
      throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid");
    }
    result.push(item);
  }
  return result;
}

function normalizeUsername(value: string): string {
  return value.trim().toLowerCase();
}

function union(left: Set<string>, right: string[]): Set<string> {
  const result = new Set(left);
  for (const code of right) result.add(code);
  return result;
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && (error as { code?: string }).code === "23505";
}

export { hasPermission, ADMIN_PERMISSION };
