/**
 * 客服受控展示词表（面向运营与客服）
 * 单一来源：将服务端枚举、状态码、内部标识映射为人话。
 * 未命中一律不得原样上屏，走业务友好兜底，绝不直接显示原始英文/内部码。
 */

export const VOCABULARY_UNKNOWN_FALLBACK = "暂无法识别，请刷新核对";

export const CONSULTATION_TYPE_VOCABULARY: Readonly<Record<string, string>> = Object.freeze({
  SERVICE: "普通咨询",
  COMPLAINT: "投诉建议",
  ORDER: "订单群",
});

export const CONSULTATION_STATE_VOCABULARY: Readonly<Record<string, string>> = Object.freeze({
  WAITING: "待接入",
  ACTIVE: "处理中",
  CLOSED: "已结束",
});

export const CONSULTATION_EVENT_VOCABULARY: Readonly<Record<string, string>> = Object.freeze({
  CREATED: "发起咨询",
  ASSIGNED: "系统分配",
  CLAIMED: "客服接入",
  TRANSFERRED: "转交",
  CLOSED: "结束咨询",
  REOPENED: "重新开启",
  UNKNOWN: "未知类型",
});

export const AGENT_AVAILABILITY_VOCABULARY: Readonly<Record<string, string>> = Object.freeze({
  AVAILABLE: "正常接单",
  PAUSED: "暂停接单",
  OFF_DUTY: "离线",
});

export const ORDER_PARTY_VOCABULARY: Readonly<Record<string, string>> = Object.freeze({
  RENTER: "租客",
  OWNER: "号主",
  BUYER: "租客",
});

export const ACCOUNT_STATUS_VOCABULARY: Readonly<Record<string, string>> = Object.freeze({
  ACTIVE: "账号正常",
  RESTRICTED: "账号受限",
  FROZEN: "已冻结",
  CANCELLED: "已注销",
});

export const HISTORY_STATE_VOCABULARY: Readonly<Record<string, string>> = Object.freeze({
  AVAILABLE: "已就绪",
  NOT_ESTABLISHED: "尚未建立",
  LEGACY_UNAVAILABLE: "历史暂不可读",
  RECOVERING: "正在同步",
});

/**
 * 安全转换展示词，未命中时统一返回友好兜底，绝不透传原始枚举或代码
 */
export function formatVocabulary(
  dict: Readonly<Record<string, string>>,
  key: unknown,
  fallback = VOCABULARY_UNKNOWN_FALLBACK
): string {
  if (typeof key !== "string" || !key.trim()) {
    return fallback;
  }
  const normalized = key.trim().toUpperCase();
  return dict[normalized] ?? fallback;
}

/**
 * 格式化处理记录中的流转主体（防止 A → A 自环）
 */
export function formatEventMovement(
  fromName: string | null | undefined,
  toName: string | null | undefined
): string | null {
  const f = fromName?.trim();
  const t = toName?.trim();
  if (f && t) {
    return f === t ? f : `${f} → ${t}`;
  }
  return f || t || null;
}

export function formatSubjectRef(ref?: string | null): string {
  if (!ref) return "未关联商品或订单";
  if (ref.startsWith("order:")) {
    return "已关联订单，详见会话详情";
  }
  if (ref.startsWith("listing:") || ref.startsWith("goods:")) {
    return "已关联商品，详见会话详情";
  }
  return "已关联对象，详情待核对";
}
