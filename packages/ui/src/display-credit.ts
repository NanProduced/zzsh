/**
 * 信用与号主保证金的展示词表（纯文本，无框架依赖）。
 * 值集合来源：`apps/api/src/credit/credit-guarantee.ts:37` GuaranteeState、
 * `apps/api/migrations/business/0067_credit_guarantee_contract.sql:104,133,153,175` 的 CHECK 约束。
 * 三件事分开命名：责任状态、收款尝试状态、退还尝试状态；不得互相套用。
 */

/** 服务端未登记或新增而本表未跟进时的统一回退：不裸显英文，也不暗示成功。 */
export const UNRECOGNIZED_STATE_LABEL = "状态暂不识别，请刷新后核对";

export function displayLabel(labels: Readonly<Record<string, string>>, value: unknown, fallback = UNRECOGNIZED_STATE_LABEL): string {
  return typeof value === "string" && Object.hasOwn(labels, value) ? labels[value]! : fallback;
}

export type GuaranteeResponsibilityState =
  | "NOT_REQUIRED" | "REQUIRED" | "PAYMENT_PENDING" | "SATISFIED"
  | "REFUND_REQUESTED" | "REFUND_PROCESSING" | "REFUNDED" | "FAILED" | "UNKNOWN";

const guaranteeResponsibilityLabels: Record<GuaranteeResponsibilityState, string> = {
  NOT_REQUIRED: "无需缴纳保证金",
  REQUIRED: "待缴保证金",
  PAYMENT_PENDING: "缴纳结果待确认",
  SATISFIED: "保证金已缴足",
  REFUND_REQUESTED: "已申请退还保证金",
  REFUND_PROCESSING: "保证金退还处理中",
  REFUNDED: "保证金退还已记录",
  FAILED: "保证金处理失败，需核对",
  UNKNOWN: "保证金状态待确认",
};

export function guaranteeResponsibilityLabel(state: string): string {
  return displayLabel(guaranteeResponsibilityLabels, state);
}

export type GuaranteePaymentAttemptState =
  | "REQUESTED" | "ACCEPTED" | "PROCESSING" | "CONFIRMED" | "FAILED" | "UNKNOWN";

const guaranteePaymentAttemptLabels: Record<GuaranteePaymentAttemptState, string> = {
  REQUESTED: "已发起缴纳",
  ACCEPTED: "缴纳已受理",
  PROCESSING: "缴纳处理中",
  CONFIRMED: "缴纳款已记录",
  FAILED: "缴纳失败",
  UNKNOWN: "缴纳结果待确认",
};

export function guaranteePaymentAttemptLabel(status: string): string {
  return displayLabel(guaranteePaymentAttemptLabels, status);
}

export type GuaranteeRefundAttemptState =
  | "REQUESTED" | "PROCESSING" | "SUCCEEDED" | "FAILED" | "UNKNOWN";

/** “退还已记录”只表示本站记录到退还结果，渠道到账另核，不写成已到账。 */
const guaranteeRefundAttemptLabels: Record<GuaranteeRefundAttemptState, string> = {
  REQUESTED: "已申请退还",
  PROCESSING: "退还处理中",
  SUCCEEDED: "退还已记录",
  FAILED: "退还失败，需核对",
  UNKNOWN: "退还结果待确认",
};

export function guaranteeRefundAttemptLabel(status: string): string {
  return displayLabel(guaranteeRefundAttemptLabels, status);
}

export type CreditRecoveryDecisionState = "PENDING" | "APPROVED" | "REJECTED";

const creditRecoveryDecisionLabels: Record<CreditRecoveryDecisionState, string> = {
  PENDING: "恢复申请待审核",
  APPROVED: "恢复申请已通过",
  REJECTED: "恢复申请已驳回",
};

export function creditRecoveryDecisionLabel(status: string): string {
  return displayLabel(creditRecoveryDecisionLabels, status);
}

/**
 * 渠道请求状态（provider_request_state）与本站记录状态分属两轴，必须分别命名：
 * `SUBMITTED` 只说明已提交渠道，`CONFIRMED`/`SUCCEEDED` 才说明渠道给过结果。
 * 值集合来源：`apps/api/migrations/business/0067_credit_guarantee_contract.sql:149,172`。
 */
export type GuaranteeProviderRequestState = "NOT_AUTHORIZED" | "SUBMITTED" | "UNKNOWN" | "CONFIRMED" | "SUCCEEDED" | "FAILED";

const paymentProviderLabels: Record<string, string> = {
  NOT_AUTHORIZED: "未获渠道授权，暂不可提交",
  SUBMITTED: "已提交渠道，等待结果",
  UNKNOWN: "渠道结果待确认",
  CONFIRMED: "渠道已确认收款",
  FAILED: "渠道返回失败，需核对",
};

const refundProviderLabels: Record<string, string> = {
  NOT_AUTHORIZED: "未获渠道授权，暂不可提交退还",
  SUBMITTED: "已提交渠道，等待退款结果",
  UNKNOWN: "渠道退款结果待确认",
  SUCCEEDED: "渠道退款已成功（到账另核）",
  FAILED: "渠道退款失败，需核对",
};

export function guaranteeProviderRequestLabel(kind: "payment" | "refund", state: string): string {
  const table = kind === "refund" ? refundProviderLabels : paymentProviderLabels;
  return displayLabel(table, state);
}

export type CreditEventType =
  | "INITIALIZED" | "BREACH_CONFIRMED" | "BREACH_REVERSED"
  | "RECOVERY_APPROVED" | "MANUAL_DEDUCTION" | "MANUAL_DEDUCTION_REVERSED";

const creditEventLabels: Record<CreditEventType, string> = {
  INITIALIZED: "初始信用分",
  BREACH_CONFIRMED: "确认违约",
  BREACH_REVERSED: "撤销误判",
  RECOVERY_APPROVED: "审核恢复",
  MANUAL_DEDUCTION: "人工扣分",
  MANUAL_DEDUCTION_REVERSED: "扣分更正",
};

/** 事件类型缺值只是“类别不认识”，不等于状态未知，因此允许调用方给更贴切的兜底。 */
export function creditEventLabel(type: string, fallback: string = UNRECOGNIZED_STATE_LABEL): string {
  return displayLabel(creditEventLabels, type, fallback);
}

/**
 * 退还放行决定（release_policy_state）是第三条轴：只说明退还是否被放行，
 * 不代表渠道已退款，也不代表银行已到账。值集来源 `0067_credit_guarantee_contract.sql:176`。
 */
export type GuaranteeReleasePolicyState = "OWNER_DECISION_REQUIRED" | "APPROVED" | "AUTO_APPROVED" | "REJECTED";

const guaranteeReleasePolicyLabels: Record<GuaranteeReleasePolicyState, string> = {
  OWNER_DECISION_REQUIRED: "退还等待处理",
  APPROVED: "退还已放行",
  AUTO_APPROVED: "自动处理",
  REJECTED: "退还未放行",
};

export function guaranteeReleasePolicyLabel(state: string): string {
  return displayLabel(guaranteeReleasePolicyLabels, state);
}
