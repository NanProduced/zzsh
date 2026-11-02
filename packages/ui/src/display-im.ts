/**
 * 咨询消息通道（messageScopeState）的展示词表（纯文本）。
 * 值集合来源：`apps/api/src/im/consultation.ts:152` MessageScopeState、
 * `apps/api/migrations/business/0033_yunxin_consultation_message_scope.sql:40` CHECK，
 * `0034_yunxin_consultation_recovery.sql:142` 允许 FAILED 重新拉起，
 * `apps/api/src/im/yunxin-routes.ts:125` 非 READY 时拒发（503 IM_UNAVAILABLE）。
 * FAILED 只说明出站回复暂不可用，不表示入站消息被禁止，也不是普通待办。
 */

import { displayLabel, UNRECOGNIZED_STATE_LABEL } from "./display-credit.ts";

export { UNRECOGNIZED_STATE_LABEL };

export type MessageScopeState =
  | "PENDING" | "PROVISIONING" | "READY" | "FAILED" | "TRANSFERRING" | "REVOKING" | "REVOKED";

const messageScopeLabels: Record<MessageScopeState, string> = {
  PENDING: "消息通道待开通",
  PROVISIONING: "消息通道开通中",
  READY: "消息通道正常",
  FAILED: "消息通道异常，暂不可回复",
  TRANSFERRING: "消息通道迁移中",
  REVOKING: "消息通道回收中",
  REVOKED: "消息通道已关闭，需重新接入",
};

export function messageScopeLabel(state: string): string {
  return displayLabel(messageScopeLabels, state);
}

/**
 * 同一事实对客服与对用户的说法不同：客服要知道是通道故障需要处理，
 * 用户只需要知道自己暂时发不出消息，不能读成“平台收不到我的话”。
 */
const messageScopeUserLabels: Record<MessageScopeState, string> = {
  PENDING: "消息通道还没开通，暂时发不出消息",
  READY: "消息通道正常",
  PROVISIONING: "消息通道正在开通，稍后可再试",
  FAILED: "消息通道异常，暂时发不出消息",
  TRANSFERRING: "消息通道切换中，稍后可再试",
  REVOKING: "消息通道正在关闭，稍后可再试",
  REVOKED: "消息通道已关闭，请联系平台重新接入",
};

export function messageScopeUserLabel(state: string): string {
  return displayLabel(messageScopeUserLabels, state);
}
