/**
 * 分销与邀请佣金的展示词表（纯文本）。
 * 值集合来源：`apps/api/migrations/business/0063_distribution_payment_and_earnings.sql:298,302,327`（native earning state/role/transition）、
 * `apps/api/src/finance/distribution-earning-read.ts:15,16,188,203,204`（含旧平台观测态）、
 * `apps/api/migrations/business/0074_legacy_trade_continuation.sql:39`（旧单责任态，仅作为 effectiveState 出现）。
 * 记录态与旧单责任态是两个域，共用一个词表会把 PENDING 说成 MATURED。
 */
import { displayLabel, UNRECOGNIZED_STATE_LABEL } from "./display-credit.ts";

export { UNRECOGNIZED_STATE_LABEL };

export type CommissionRecordState =
  | "PENDING" | "SETTLED" | "REVOKED" | "RECOVERY_REQUIRED" | "EXPIRED" | "UNKNOWN";

/** SETTLED 只说“已结算”；只有确有钱包入账证据才可另行说明已转入余额。 */
const commissionRecordLabels: Record<CommissionRecordState, string> = {
  PENDING: "待结算",
  SETTLED: "已结算",
  REVOKED: "已撤销",
  RECOVERY_REQUIRED: "待追回",
  EXPIRED: "已失效",
  UNKNOWN: "状态待确认",
};

export function commissionRecordLabel(state: string): string {
  return displayLabel(commissionRecordLabels, state);
}

export type CommissionDutyState = "PENDING" | "MATURED" | "SETTLED" | "VOID";

/** 旧单责任多一个 MATURED（已到期未过账）；“待入账”不再同时指两件事。 */
const commissionDutyLabels: Record<CommissionDutyState, string> = {
  PENDING: "待结算",
  MATURED: "已到期待转入余额",
  SETTLED: "已结算",
  VOID: "已取消",
};

export function commissionDutyLabel(state: string): string {
  return displayLabel(commissionDutyLabels, state);
}

/** 筛选器同时列出记录态与旧单责任态，混排词表走这里；单域渲染仍用上面两个函数。 */
export function commissionStateLabel(state: string): string {
  return Object.hasOwn(commissionRecordLabels, state) ? commissionRecordLabel(state) : commissionDutyLabel(state);
}

export type CommissionTransition = "ACCRUE" | "SETTLE" | "REVOKE" | "RECOVER";

/** 账本动作只保留一对叫法：计提 / 转入可用。 */
const commissionTransitionLabels: Record<CommissionTransition, string> = {
  ACCRUE: "计提",
  SETTLE: "转入可用",
  REVOKE: "撤销",
  RECOVER: "追回",
};

export function commissionTransitionLabel(action: string): string {
  return displayLabel(commissionTransitionLabels, action);
}

export function commissionRoleLabel(role: string): string {
  return displayLabel({ RENTER_REFERRAL: "邀请租客下单", OWNER_REFERRAL: "邀请号主出租", TASK_REFERRAL: "任务佣金", ALL: "全部来源" }, role, "来源待核对");
}
