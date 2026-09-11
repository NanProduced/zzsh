import { randomBytes, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import {
  ADMIN_PERMISSION,
  ADMIN_PERMISSION_CODES,
  assertDelegable,
  assertRolePermissionSet,
  computeProposedPermissions,
  hasPermission,
  loadEffectiveAdminAccess,
  requirePermission,
  type AdminFieldAccess,
  type EffectiveAdminAccess,
  type ProposedAdminGrants,
} from "./admin-authorization";
import { recordAudit, setAuditContext, SecurityApiError, withTransaction } from "./security-core";
import type { AuthSecurityOptions } from "./auth-security";

const STAFF_ENROLLMENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const ROLE_CODE_PATTERN = /^[a-z][a-z0-9_]{1,62}$/;

type AdminContext = {
  userId: string;
  sessionId: string;
};

type DirectoryOptions = Pick<AuthSecurityOptions, "pool" | "hashPassword">;

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

export async function listAdministrators(pool: Pool, fields: AdminFieldAccess): Promise<{ admins: Record<string, unknown>[] }> {
  const result = await pool.query<{
    adminId: string;
    username: string | null;
    displayName: string;
    status: string;
    isBoss: boolean;
    createdAt: Date;
    lastFullAuthenticatedAt: Date | null;
    roleCodes: string[] | null;
    roleNames: string[] | null;
  }>(
    `SELECT u."id" AS "adminId",
        COALESCE(NULLIF(u."displayUsername", ''), UPPER(u."username")) AS "username",
        u."name" AS "displayName",
        s."status",
        s."is_boss" AS "isBoss",
        u."createdAt" AS "createdAt",
        s."last_full_authenticated_at" AS "lastFullAuthenticatedAt",
        COALESCE(array_agg(r."code" ORDER BY r."code") FILTER (WHERE r."id" IS NOT NULL), '{}') AS "roleCodes",
        COALESCE(array_agg(r."name" ORDER BY r."code") FILTER (WHERE r."id" IS NOT NULL), '{}') AS "roleNames"
       FROM "zzsh_auth_admin"."user" u
       JOIN "zzsh_iam"."admin_security" s ON s."admin_user_id" = u."id"
       LEFT JOIN "zzsh_iam"."admin_user_role" ur ON ur."admin_user_id" = u."id"
       LEFT JOIN "zzsh_iam"."admin_role" r ON r."id" = ur."role_id"
      GROUP BY u."id", u."displayUsername", u."username", u."name", s."status", s."is_boss", u."createdAt", s."last_full_authenticated_at"
      ORDER BY s."is_boss" DESC, u."username"`,
  );
  return {
    admins: result.rows.map((row) => {
      const entry: Record<string, unknown> = {
        id: row.adminId,
        username: row.username ?? "未分配账号",
        name: row.displayName,
        status: row.status,
        isBoss: row.isBoss,
        createdAt: row.createdAt.toISOString(),
        lastFullAuthenticatedAt: row.lastFullAuthenticatedAt?.toISOString() ?? null,
      };
      if (fields.roleRead) {
        entry.roles = (row.roleCodes ?? []).map((code, index) => ({ code, name: row.roleNames?.[index] ?? code }));
      }
      return entry;
    }),
  };
}

export async function readAdministratorDetail(pool: Pool, username: string, fields: AdminFieldAccess): Promise<Record<string, unknown>> {
  const login = normalizeUsername(username);
  const result = await pool.query<{
    adminId: string;
    username: string | null;
    displayName: string;
    status: string;
    isBoss: boolean;
    createdAt: Date;
    lastFullAuthenticatedAt: Date | null;
  }>(
    `SELECT u."id" AS "adminId",
        COALESCE(NULLIF(u."displayUsername", ''), UPPER(u."username")) AS "username",
        u."name" AS "displayName",
        s."status",
        s."is_boss" AS "isBoss",
        u."createdAt" AS "createdAt",
        s."last_full_authenticated_at" AS "lastFullAuthenticatedAt"
       FROM "zzsh_auth_admin"."user" u
       JOIN "zzsh_iam"."admin_security" s ON s."admin_user_id" = u."id"
      WHERE LOWER(u."username") = $1
      LIMIT 1`,
    [login],
  );
  const row = result.rows[0];
  if (!row) throw new SecurityApiError(404, API_V1_ERROR_CODES.NOT_FOUND, "Administrator not found");
  const detail: Record<string, unknown> = {
    id: row.adminId,
    username: row.username ?? "未分配账号",
    name: row.displayName,
    status: row.status,
    isBoss: row.isBoss,
    createdAt: row.createdAt.toISOString(),
    lastFullAuthenticatedAt: row.lastFullAuthenticatedAt?.toISOString() ?? null,
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
  return detail;
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
          permissionCodes: role.permissionCodes ?? [],
        }))
      : [],
    permissions: fields.permissionRead ? permissions.rows : [],
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
  const temporaryPassword = randomBytes(18).toString("base64url");
  const passwordHash = await options.hashPassword(temporaryPassword);
  const result = await withTransaction(options.pool, async (client) => {
    await setAuditContext(client, "admin", context.userId, context.sessionId, requestId);
    const actor = await lockActor(client, context.userId, grants.roleIds);
    requirePermission(actor, ADMIN_PERMISSION.accountCreate);
    const proposed = await computeProposedPermissions(client, grants);
    if (grants.roleIds.length > 0 || grants.allowPermissions.length > 0 || grants.denyPermissions.length > 0) {
      requirePermission(actor, ADMIN_PERMISSION.permissionGrant);
    }
    assertDelegable(actor, union(proposed, grants.denyPermissions));
    const now = new Date();
    const login = await nextAdminLogin(client);
    const loginEmail = `${login.username}@admin.zzsh.invalid`;
    const id = `admin_${randomUUID().replaceAll("-", "")}`;
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
      },
    });
    return {
      id,
      username: login.displayUsername,
      name,
      status: "PENDING_ENROLLMENT",
      isBoss: false,
    };
  });
  return { ...result, temporaryPassword };
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
