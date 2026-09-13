import type { Pool, PoolClient } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { SecurityApiError } from "./security-core";

export const ADMIN_PERMISSION = {
  accountRead: "admin.account.read",
  accountCreate: "admin.account.create",
  accountUpdate: "admin.account.update",
  accountFreeze: "admin.account.freeze",
  accountUnfreeze: "admin.account.unfreeze",
  userAccountRestore: "user.account.restore",
  auditRead: "admin.audit.read",
  roleRead: "admin.role.read",
  roleConfigure: "admin.role.configure",
  permissionRead: "admin.permission.read",
  permissionGrant: "admin.permission.grant",
  approvalTemplateRead: "approval.template.read",
  approvalTemplateConfigure: "approval.template.configure",
  approvalRequestCreate: "approval.request.create",
  approvalRequestRead: "approval.request.read",
  approvalRequestApprove: "approval.request.approve",
  approvalRequestExecute: "approval.request.execute",
  approvalRequestAddApprover: "approval.request.add_approver",
  approvalAuditRead: "approval.audit.read",
  supplyCatalogManage: "supply.catalog.manage",
  supplyRulesEdit: "supply.rules.edit",
  supplyRulesActivate: "supply.rules.activate",
  supplyReviewRead: "supply.review.read",
  supplyReviewDecide: "supply.review.decide",
  supplyQuoteInternalRead: "supply.quote.internal.read",
  supplyRestrict: "supply.restrict",
  supplyDuplicateReview: "supply.duplicate.review",
  contentRead: "content.read",
  contentEdit: "content.edit",
  contentPublish: "content.publish",
  contentPlatformRead: "content.platform.read",
  contentPlatformEdit: "content.platform.edit",
  contentPlatformPublish: "content.platform.publish",
} as const;

export const ADMIN_PERMISSION_CODES = Object.values(ADMIN_PERMISSION);

export type AdminPermissionCode = (typeof ADMIN_PERMISSION_CODES)[number];
export type AdminSecurityStatus = "PENDING_ENROLLMENT" | "ACTIVE" | "FROZEN";

export type EffectiveAdminAccess = {
  status: AdminSecurityStatus;
  isBoss: boolean;
  passwordChangeRequired: boolean;
  permissions: Set<string>;
};

export type ProposedAdminGrants = {
  roleIds: string[];
  allowPermissions: string[];
  denyPermissions: string[];
};

const PERMISSION_CODE_SET = new Set<string>(ADMIN_PERMISSION_CODES);

export function isAdminPermissionCode(value: string): value is AdminPermissionCode {
  return PERMISSION_CODE_SET.has(value);
}

export function hasPermission(access: EffectiveAdminAccess | null, code: string): boolean {
  return access?.status === "ACTIVE" && access.permissions.has(code);
}

export function requirePermission(access: EffectiveAdminAccess | null, code: string): void {
  if (!hasPermission(access, code)) {
    throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Permission required");
  }
}

export async function loadEffectiveAdminAccess(
  pool: Pool | PoolClient,
  userId: string,
): Promise<EffectiveAdminAccess | null> {
  const security = await pool.query<{
    status: AdminSecurityStatus;
    isBoss: boolean;
    passwordChangeRequired: boolean;
  }>(
    `SELECT "status", "is_boss" AS "isBoss", "password_change_required" AS "passwordChangeRequired"
       FROM "zzsh_iam"."admin_security"
      WHERE "admin_user_id" = $1`,
    [userId],
  );
  const row = security.rows[0];
  if (!row) return null;
  if (row.status !== "ACTIVE") {
    return { ...row, permissions: new Set() };
  }
  if (row.isBoss) {
    return { ...row, permissions: new Set(ADMIN_PERMISSION_CODES) };
  }
  const granted = await pool.query<{ permissionCode: string }>(
    `WITH role_permissions AS (
       SELECT rp."permission_code" AS "permissionCode"
         FROM "zzsh_iam"."admin_user_role" ur
         JOIN "zzsh_iam"."admin_role" r ON r."id" = ur."role_id" AND r."status" = 'ACTIVE'
         JOIN "zzsh_iam"."admin_role_permission" rp ON rp."role_id" = r."id"
        WHERE ur."admin_user_id" = $1
     ),
     personal AS (
       SELECT "permission_code" AS "permissionCode", "effect"
         FROM "zzsh_iam"."admin_user_permission"
        WHERE "admin_user_id" = $1
     )
     SELECT granted."permissionCode"
       FROM (
         SELECT "permissionCode" FROM role_permissions
         UNION
         SELECT "permissionCode" FROM personal WHERE "effect" = 'ALLOW'
       ) granted
      WHERE granted."permissionCode" NOT IN (
        SELECT "permissionCode" FROM personal WHERE "effect" = 'DENY'
      )`,
    [userId],
  );
  return { ...row, permissions: new Set(granted.rows.map((item) => item.permissionCode)) };
}

export async function computeProposedPermissions(
  client: PoolClient,
  grants: ProposedAdminGrants,
): Promise<Set<string>> {
  const uniqueRoleIds = [...new Set(grants.roleIds)];
  const allow = uniqueCodes(grants.allowPermissions, "allowPermissions");
  const deny = uniqueCodes(grants.denyPermissions, "denyPermissions");
  if (uniqueRoleIds.length !== grants.roleIds.length) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Request body is invalid");
  }
  if (uniqueRoleIds.length === 0) {
    return subtract(new Set(allow), deny);
  }
  const roles = await client.query<{ id: string; status: string }>(
    `SELECT "id", "status" FROM "zzsh_iam"."admin_role" WHERE "id" = ANY($1::text[]) FOR UPDATE`,
    [uniqueRoleIds],
  );
  if (roles.rows.length !== uniqueRoleIds.length) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Role is invalid");
  }
  if (roles.rows.some((role) => role.status !== "ACTIVE")) {
    throw new SecurityApiError(409, API_V1_ERROR_CODES.CONFLICT, "Disabled roles cannot be assigned");
  }
  const rolePermissions = await client.query<{ permissionCode: string }>(
    `SELECT DISTINCT "permission_code" AS "permissionCode"
       FROM "zzsh_iam"."admin_role_permission"
      WHERE "role_id" = ANY($1::text[])`,
    [uniqueRoleIds],
  );
  const union = new Set(rolePermissions.rows.map((row) => row.permissionCode));
  for (const code of allow) union.add(code);
  return subtract(union, deny);
}

export function assertDelegable(actor: EffectiveAdminAccess, proposed: Iterable<string>): void {
  if (actor.isBoss && actor.status === "ACTIVE") return;
  for (const code of proposed) {
    if (!actor.permissions.has(code)) {
      throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Cannot delegate permissions beyond the actor scope");
    }
  }
}

export function assertRolePermissionSet(
  actor: EffectiveAdminAccess,
  resultingCodes: Iterable<string>,
  nextStatus: string,
  permissionSetEdited: boolean,
): void {
  if (nextStatus === "ACTIVE" || permissionSetEdited) {
    assertDelegable(actor, resultingCodes);
  }
}

export type AdminFieldAccess = {
  roleRead: boolean;
  permissionRead: boolean;
};

export function fieldAccessFrom(access: EffectiveAdminAccess | null): AdminFieldAccess {
  return {
    roleRead: hasPermission(access, ADMIN_PERMISSION.roleRead),
    permissionRead: hasPermission(access, ADMIN_PERMISSION.permissionRead),
  };
}

export function assertCatalogPermissions(codes: string[]): string[] {
  const unique = uniqueCodes(codes, "permissions");
  for (const code of unique) {
    if (!isAdminPermissionCode(code)) {
      throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Permission is invalid");
    }
  }
  return unique;
}

function uniqueCodes(codes: string[], field: string): string[] {
  const unique = [...new Set(codes)];
  if (unique.length !== codes.length) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, `${field} must not contain duplicates`);
  }
  for (const code of unique) {
    if (!isAdminPermissionCode(code)) {
      throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Permission is invalid");
    }
  }
  return unique;
}

function subtract(source: Set<string>, deny: string[]): Set<string> {
  const result = new Set(source);
  for (const code of deny) result.delete(code);
  return result;
}
