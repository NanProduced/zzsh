export type UserIdentitySnapshot = {
  accountStatus: "ACTIVE" | "DEACTIVATED" | "CANCELLED";
  identityStatus: "UNVERIFIED" | "VERIFIED" | "REJECTED" | "UNKNOWN";
  ageStatus: "UNKNOWN" | "ADULT" | "MINOR";
  provider: string;
  eligibleForProtectedTrade: boolean;
};

export function accountStatusLabel(status: UserIdentitySnapshot["accountStatus"]): string {
  return { ACTIVE: "账号正常", DEACTIVATED: "账号已停用", CANCELLED: "账号已注销" }[status];
}

export function identityStatusLabel(status: UserIdentitySnapshot["identityStatus"]): string {
  return { UNVERIFIED: "尚未验证", VERIFIED: "实名已验证", REJECTED: "实名未通过", UNKNOWN: "暂无法确认" }[status];
}

export function ageStatusLabel(status: UserIdentitySnapshot["ageStatus"]): string {
  return { UNKNOWN: "年龄未确认", ADULT: "已确认成年人", MINOR: "未满足年龄要求" }[status];
}

export function providerAvailability(snapshot: Pick<UserIdentitySnapshot, "provider" | "identityStatus">): string {
  if (snapshot.provider === "none") return "实名服务暂未接入或尚未完成确认；当前不会开放受保护操作。";
  if (snapshot.provider === "fake") return "当前为受控测试 provider；结果来自服务端 fixture，不代表真实实名通过。";
  if (snapshot.identityStatus === "UNKNOWN") return "实名服务暂时无法确认；当前不会开放受保护操作。";
  return "实名状态由服务端 provider 返回。";
}

export function protectedActionReason(snapshot: Pick<UserIdentitySnapshot, "identityStatus" | "ageStatus" | "eligibleForProtectedTrade">): string {
  if (snapshot.eligibleForProtectedTrade) return "当前满足服务端身份与年龄门槛；这只是资格检查，不代表任何交易已执行。";
  if (snapshot.identityStatus === "UNKNOWN") return "实名服务暂时无法确认；完成真实 provider 接入前不会开放受保护操作。";
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
