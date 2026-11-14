import type { AuditMessage } from "./im-support-management-model";

export const CARD_LABELS: Record<string, string> = {
  ORDER_OPENING: "开租确认",
  ORDER_ENDING: "结束确认",
  ORDER_SETTLED: "结算完成",
  ORDER_CANCELLED: "订单已取消",
  ORDER_PRICE_CHANGE: "价格调整",
};

/** Server fallbacks and provider account ids are not a person's name. */
const GENERIC_IDENTITIES = new Set(["平台用户", "平台客服", "平台助手", "用户", "客服", "会话成员"]);
const PROVIDER_ACCOUNT = /^(zzu|zza|zzs)[A-Za-z0-9_-]{3,}$/i;

export function safeIdentityName(value: string | null | undefined, senderId?: string): string | null {
  const name = value?.trim();
  if (!name || name === senderId || GENERIC_IDENTITIES.has(name) || PROVIDER_ACCOUNT.test(name)) return null;
  return name;
}


export function roleLabel(role: NonNullable<AuditMessage["sender"]>["role"] | undefined): string | null {
  if (role === "ADMIN") return "平台客服";
  if (role === "SYSTEM") return "机器人";
  if (role === "USER") return "平台用户";
  return null;
}
