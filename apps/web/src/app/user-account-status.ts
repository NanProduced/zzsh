export type UserIdentitySnapshot = {
  accountStatus: "ACTIVE" | "FROZEN" | "DEACTIVATED" | "CANCELLED";
  identityStatus: "UNVERIFIED" | "VERIFIED" | "REJECTED" | "UNKNOWN";
  ageStatus: "UNKNOWN" | "ADULT" | "MINOR";
  provider: string;
  eligibleForProtectedTrade: boolean;
  /** Masked display fields are optional for older APIs; never log or cache these values. */
  identityDisplay?: { realNameMasked: string; idCardMasked: string; maskingVersion: string } | null;
  identityDisplaySource?: "NATIVE_PROVIDER" | "RECORDED_SOURCE";
  verificationCapability?: {
    available: boolean; real: boolean; idempotencyRequired: boolean;
    privacy?: { versionId: string; digest: string; title: string; bodyPath: string } | null;
    disclosure?: { versionId: string; digest: string; body: string };
  };
  identityDisplayReason?: "NOT_RECORDED" | "NOT_VERIFIED" | "STORE_UNAVAILABLE" | null;
  realNameMasked?: string | null;
  idCardMasked?: string | null;
};

export function accountStatusLabel(status: UserIdentitySnapshot["accountStatus"]): string {
  return { ACTIVE: "账号正常", FROZEN: "账号已冻结", DEACTIVATED: "账号已停用", CANCELLED: "账号已注销" }[status] ?? "账号状态待确认";
}

export function identityStatusLabel(status: UserIdentitySnapshot["identityStatus"]): string {
  return { UNVERIFIED: "尚未验证", VERIFIED: "实名已验证", REJECTED: "实名未通过", UNKNOWN: "暂无法确认" }[status] ?? "实名状态待确认";
}

export function ageStatusLabel(status: UserIdentitySnapshot["ageStatus"]): string {
  return { UNKNOWN: "年龄未确认", ADULT: "已确认成年人", MINOR: "未满足年龄要求" }[status] ?? "年龄状态待确认";
}

export function providerAvailability(snapshot: Pick<UserIdentitySnapshot, "provider" | "identityStatus">): string {
  if (snapshot.provider === "none") return "实名状态暂未确认，暂不能进行需要实名的操作。";
  if (snapshot.provider === "fake") return "当前结果仅供测试，不代表真实实名通过。";
  if (snapshot.identityStatus === "UNKNOWN") return "实名服务暂时无法确认；当前不会开放受保护操作。";
  return "实名状态以核验结果为准。";
}

export function protectedActionReason(snapshot: Pick<UserIdentitySnapshot, "identityStatus" | "ageStatus" | "eligibleForProtectedTrade">): string {
  if (snapshot.eligibleForProtectedTrade) return "当前满足身份与年龄要求；具体交易仍需确认。";
  if (snapshot.identityStatus === "UNKNOWN") return "实名服务暂时无法确认，需要实名的操作暂不可用。";
  if (snapshot.identityStatus === "UNVERIFIED") return "尚未完成实名校验，受保护操作暂不可用。";
  if (snapshot.identityStatus === "REJECTED") return "实名校验未通过，受保护操作暂不可用。";
  if (snapshot.ageStatus === "MINOR") return "实名已通过，但当前年龄不满足受保护操作要求。";
  return "年龄状态尚未确认，受保护操作暂不可用。";
}

export function cancellationFailureMessage(status: number, code: string): string {
  if (status === 409 && code === "CONFLICT") return "注销暂不能办理：仍有未完成事项，请先处理后重试。";
  if (status >= 500) return "注销暂不能办理：当前无法确认未完成事项，请稍后重试。";
  if (code === "UNAUTHENTICATED") return "会话已失效，请重新登录后再试。";
  return "注销未完成，请稍后重试。";
}
