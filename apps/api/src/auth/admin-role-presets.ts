import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { ADMIN_PERMISSION as P } from "./admin-authorization";
import { SecurityApiError } from "./security-core";

/**
 * 两套预设角色的初始授权（Owner 2026-10-31 定稿）。
 *
 * 仅作迁移 0114 的种子来源和测试基准：运行时有效权限一律以库内
 * admin_role_permission 为准，角色名称/编码不触发任何硬编码能力。
 * Boss 走 is_boss 旁路，不在此列。order.read 是全员基线，不进角色。
 */
export const SUPPORT_PRESET_PERMISSIONS = [
  // 订单群与咨询
  P.imSupportRead,
  P.imSupportAccept,
  P.imSupportTransfer,
  P.imSupportComplaint,
  P.imSupportPresence,
  // 订单结算（含代确认收货）；服务端另要求本人是该订单群 STAFF 成员
  P.orderSettlementWrite,
  // 定位用户、写备注
  P.userDirectoryRead,
  P.userPhoneLookup,
  P.userNoteWrite,
  // 只读：答复用户需要
  P.supplyRentalAccountRead,
  P.supplyGuaranteeRead,
  P.creditRead,
  P.creditGuaranteeRead,
  P.contentRead,
  // 会员礼遇：只发起申请（运营审批后生效），不含审批/执行
  P.approvalRequestCreate,
  P.approvalRequestRead,
  P.membershipEntitlementRequest,
  P.membershipGrowthSummaryRead,
] as const;

export const OPS_PRESET_PERMISSIONS = [
  ...SUPPORT_PRESET_PERMISSIONS,
  // 订单
  P.orderLegacyContinue,
  // 用户
  P.userNoteManage,
  P.userWalletRead,
  P.userFinanceRead,
  P.userAccountFreeze,
  P.userAccountUnfreeze,
  P.userRiskManage,
  P.userRentalMembershipManage,
  // 供给与账号
  P.supplyGuaranteeVerify,
  P.supplyGuaranteeRevoke,
  P.supplyReviewRead,
  P.supplyReviewDecide,
  P.supplyRestrict,
  P.supplyDuplicateReview,
  P.supplyCatalogManage,
  P.supplyGunsmithManage,
  P.supplyListingFiltersManage,
  P.supplyQuoteInternalRead,
  P.supplyRulesEdit,
  // 信用
  P.creditDecide,
  P.creditGuaranteeManage,
  // 内容（平台内容发布留 Boss）
  P.contentEdit,
  P.contentPublish,
  P.contentPlatformRead,
  P.contentPlatformEdit,
  // 会员与分销（仅政策发布留 Boss；Boss 只做重要策略审批，日常运营归运营）
  P.membershipGrowthDetailRead,
  P.membershipPolicyDraft,
  P.membershipEntitlementExecute,
  P.membershipEntitlementRevoke,
  P.membershipEntitlementDecide,
  P.membershipGrowthBackfill,
  P.distributionPolicyRead,
  P.distributionPolicyManage,
  // 资金（财务并入运营）
  P.financeRead,
  P.financeDocumentRead,
  P.financeWithdrawalQuery,
  // 审批：发起与查看
  P.approvalAuditRead,
  // 审批/执行（方案 A）：政策类代码强制仅 Boss；结算调整等由 Boss 配置的候选人名单管控
  P.approvalRequestApprove,
  P.approvalRequestExecute,
  // 系统：只读
  P.auditRead,
  P.accountRead,
  P.roleRead,
  P.permissionRead,
] as const;

/** 只留 Boss（is_boss 旁路）的能力：任何预设都不得包含。 */
export const BOSS_ONLY_PERMISSIONS = [
  P.accountCreate,
  P.accountUpdate,
  P.accountFreeze,
  P.accountUnfreeze,
  P.roleConfigure,
  P.permissionGrant,
  P.supplyRulesActivate,
  P.contentPlatformPublish,
  P.userIdentitySensitiveRead,
  P.membershipPolicyPublish,
  P.approvalRequestAddApprover,
  P.approvalTemplateRead,
  P.approvalTemplateConfigure,
] as const;

export const ROLE_PRESET_GRANTS = {
  role_preset_support: SUPPORT_PRESET_PERMISSIONS,
  role_preset_ops: OPS_PRESET_PERMISSIONS,
} as const;
const BOSS_ONLY_SET = new Set<string>(BOSS_ONLY_PERMISSIONS);

export function isBossOnlyPermission(code: string): boolean {
  return BOSS_ONLY_SET.has(code);
}

/**
 * 只留 Boss 的能力不能通过角色授予（Boss 自己也不行）。只拦新增，
 * 已存在的历史授权不阻断其余编辑，由 Boss 在页面上手动移除。
 */
export function assertNoNewBossOnlyRoleGrants(before: Iterable<string>, after: Iterable<string>): void {
  const existing = new Set(before);
  const added = [...new Set(after)].filter((code) => !existing.has(code) && BOSS_ONLY_SET.has(code));
  if (added.length > 0) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, `Boss-only permissions cannot be granted to roles: ${added.sort().join(", ")}`);
  }
}
