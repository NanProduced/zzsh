import type { Pool, PoolClient } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { SecurityApiError } from "./security-core";

export const ADMIN_PERMISSION = {
  accountRead: "admin.account.read",
  accountCreate: "admin.account.create",
  accountUpdate: "admin.account.update",
  accountFreeze: "admin.account.freeze",
  accountUnfreeze: "admin.account.unfreeze",
  userAccountFreeze: "user.account.freeze",
  userAccountUnfreeze: "user.account.unfreeze",
  userRentalMembershipManage: "user.rental_membership.manage",
  membershipGrowthSummaryRead: "membership.growth.read.summary",
  membershipGrowthDetailRead: "membership.growth.read.detail",
  membershipPolicyDraft: "membership.policy.draft",
  membershipPolicyPublish: "membership.policy.publish",
  membershipEntitlementRequest: "membership.entitlement.request",
  membershipEntitlementDecide: "membership.entitlement.decide",
  membershipEntitlementExecute: "membership.entitlement.execute",
  membershipEntitlementRevoke: "membership.entitlement.revoke",
  membershipGrowthAuditRead: "membership.growth.audit.read",
  membershipGrowthBackfill: "membership.growth.backfill",
  distributionPolicyRead: "personal.distribution.policy.read",
  distributionPolicyManage: "personal.distribution.policy.manage",
  userDirectoryRead: "user.directory.read",
  userPhoneLookup: "user.phone.lookup",
  userWalletRead: "user.wallet.read",
  userFinanceRead: "user.finance.read",
  userRiskManage: "user.risk.manage",
  userNoteWrite: "user.note.write",
  userNoteManage: "user.note.manage",
  userIdentitySensitiveRead: "user.identity.sensitive.read",
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
  supplyListingFiltersManage: "supply.listing_filters.manage",
  supplyRulesActivate: "supply.rules.activate",
  supplyReviewRead: "supply.review.read",
  supplyRentalAccountRead: "supply.rental_account.read",
  supplyReviewDecide: "supply.review.decide",
  supplyQuoteInternalRead: "supply.quote.internal.read",
  supplyGuaranteeRead: "supply.guarantee.read",
  supplyGuaranteeVerify: "supply.guarantee.verify",
  supplyGuaranteeRevoke: "supply.guarantee.revoke",
  supplyRestrict: "supply.restrict",
  supplyDuplicateReview: "supply.duplicate.review",
  supplyGunsmithManage: "supply.gunsmith.manage",
  creditRead: "credit.read",
  creditDecide: "credit.decide",
  creditGuaranteeRead: "credit.guarantee.read",
  creditGuaranteeManage: "credit.guarantee.manage",
  contentRead: "content.read",
  contentEdit: "content.edit",
  contentPublish: "content.publish",
  contentPlatformRead: "content.platform.read",
  contentPlatformEdit: "content.platform.edit",
  contentPlatformPublish: "content.platform.publish",
  orderRead: "order.read",
  orderLegacyContinue: "order.legacy.continue",
  orderSettlementWrite: "order.settlement.write",
  financeDocumentRead: "finance.document.read",
  financeRead: "finance.read",
  imSupportRead: "im.support.read",
  imSupportAccept: "im.support.accept",
  imSupportComplaint: "im.support.complaint",
  imSupportTransfer: "im.support.transfer",
  imSupportPresence: "im.support.presence",
} as const;

export const ADMIN_PERMISSION_CODES = Object.values(ADMIN_PERMISSION);

/**
 * Baseline business reads are available to every active administrator. They
 * remain internal capability codes for existing route contracts, but are not
 * role-assigned or individually denied in the effective access result.
 */
export const ADMIN_BASELINE_PERMISSION_CODES = [ADMIN_PERMISSION.orderRead] as const;

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

/**
 * 管理员目录的治理写及其在事务内实际执行的前置条件。
 *
 * 这是**预检**，不是授权凭证：写接口仍在自身事务内 `lockActor` 后重新校验。
 * 抽成纯函数的目的是让目录响应能说明"这个入口为什么不可用"，而不是让前端猜，
 * 也避免 UI 与写规则各写一份判断后漂移。
 */
export const ADMIN_DIRECTORY_ACTIONS = ["update", "assign", "scope", "freeze", "unfreeze", "force-logout"] as const;
export type AdminDirectoryAction = (typeof ADMIN_DIRECTORY_ACTIONS)[number];

export type AdminActionEligibility = {
  action: AdminDirectoryAction;
  allowed: boolean;
  reasonCode:
    | "OK"
    | "ACTOR_INACTIVE"
    | "PERMISSION_REQUIRED"
    | "BOSS_ACTOR_REQUIRED"
    | "BOSS_TARGET_NOT_CONFIGURABLE"
    | "SELF_TARGET"
    | "ALREADY_FROZEN"
    | "NOT_FROZEN";
  /** 该写要求发起方当场再验证本人密码与动态码。 */
  needsReauthentication: boolean;
  /** 该写是全量替换，必须先完整读到当前集合才能安全提交。 */
  needsFullGrantBaseline: boolean;
};

export function evaluateAdminDirectoryActions(input: {
  actorId: string;
  actorStatus: string;
  actorIsBoss: boolean;
  actorPermissions: ReadonlySet<string>;
  targetId: string;
  targetIsBoss: boolean;
  targetStatus: string;
}): AdminActionEligibility[] {
  const active = input.actorStatus === "ACTIVE";
  const self = input.actorId === input.targetId;
  const build = (
    action: AdminDirectoryAction,
    permission: string | null,
    options: { reauth?: boolean; fullBaseline?: boolean; bossMayNotTarget?: boolean; selfForbidden?: boolean } = {},
  ): AdminActionEligibility => {
    const eligibility: AdminActionEligibility = {
      action,
      allowed: false,
      reasonCode: "OK",
      needsReauthentication: options.reauth === true,
      needsFullGrantBaseline: options.fullBaseline === true,
    };
    if (!active) eligibility.reasonCode = "ACTOR_INACTIVE";
    else if (permission && !input.actorPermissions.has(permission)) eligibility.reasonCode = "PERMISSION_REQUIRED";
    else if (action === "force-logout" && !input.actorIsBoss) eligibility.reasonCode = "BOSS_ACTOR_REQUIRED";
    else if (options.bossMayNotTarget && input.targetIsBoss && !input.actorIsBoss) eligibility.reasonCode = "BOSS_ACTOR_REQUIRED";
    else if (input.targetIsBoss && options.bossMayNotTarget === false) eligibility.reasonCode = "BOSS_TARGET_NOT_CONFIGURABLE";
    else if (self && options.selfForbidden) eligibility.reasonCode = "SELF_TARGET";
    else if (action === "freeze" && input.targetStatus === "FROZEN") eligibility.reasonCode = "ALREADY_FROZEN";
    else if (action === "unfreeze" && input.targetStatus !== "FROZEN") eligibility.reasonCode = "NOT_FROZEN";
    else eligibility.reasonCode = "OK";
    eligibility.allowed = eligibility.reasonCode === "OK";
    return eligibility;
  };

  return [
    build("update", ADMIN_PERMISSION.accountUpdate, { bossMayNotTarget: true }),
    build("assign", ADMIN_PERMISSION.permissionGrant, { fullBaseline: true, bossMayNotTarget: false }),
    build("scope", ADMIN_PERMISSION.permissionGrant, { bossMayNotTarget: false }),
    build("freeze", ADMIN_PERMISSION.accountFreeze, { reauth: true, bossMayNotTarget: true, selfForbidden: true }),
    build("unfreeze", ADMIN_PERMISSION.accountUnfreeze, { reauth: true, bossMayNotTarget: true, selfForbidden: true }),
    build("force-logout", null, { reauth: true, selfForbidden: true }),
  ];
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
  const permissions = new Set(granted.rows.map((item) => item.permissionCode));
  for (const code of ADMIN_BASELINE_PERMISSION_CODES) permissions.add(code);
  return { ...row, permissions };
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
