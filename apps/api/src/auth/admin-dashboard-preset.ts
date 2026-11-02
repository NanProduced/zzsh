import { ADMIN_PERMISSION, type EffectiveAdminAccess } from "./admin-authorization";

export type DashboardPreset = "BOSS" | "OPS" | "SUPPORT";

/**
 * Presentation-only preset. It never grants access; every dashboard block is
 * still filtered by the effective permission and game scope.
 */
const OPS_CAPABILITIES = [
  ADMIN_PERMISSION.financeRead,
  ADMIN_PERMISSION.financeDocumentRead,
  ADMIN_PERMISSION.supplyReviewDecide,
  ADMIN_PERMISSION.supplyCatalogManage,
  ADMIN_PERMISSION.supplyRulesEdit,
  ADMIN_PERMISSION.supplyGunsmithManage,
  ADMIN_PERMISSION.accountRead,
  ADMIN_PERMISSION.accountUpdate,
  ADMIN_PERMISSION.accountFreeze,
  ADMIN_PERMISSION.approvalRequestApprove,
  ADMIN_PERMISSION.orderLegacyContinue,
  ADMIN_PERMISSION.userRiskManage,
  ADMIN_PERMISSION.userRentalMembershipManage,
  ADMIN_PERMISSION.contentPublish,
  ADMIN_PERMISSION.membershipPolicyDraft,
  ADMIN_PERMISSION.distributionPolicyManage,
  ADMIN_PERMISSION.creditDecide,
  ADMIN_PERMISSION.creditGuaranteeManage,
  ADMIN_PERMISSION.financeWithdrawalQuery,
] as const;

export function deriveDashboardPreset(access: EffectiveAdminAccess): DashboardPreset {
  if (access.isBoss) return "BOSS";
  const permissions = access.permissions;
  if (OPS_CAPABILITIES.some((code) => permissions.has(code))) return "OPS";
  if (permissions.has(ADMIN_PERMISSION.imSupportRead) || permissions.has(ADMIN_PERMISSION.imSupportAccept)) return "SUPPORT";
  return "OPS";
}
