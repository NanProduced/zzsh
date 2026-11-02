/**
 * 资金义务队列（退款责任、提现）的展示词表（纯文本）。
 * 值集合来源：`apps/api/src/finance/admin-finance-obligation-queues.ts:65,148-150,163-171,205-214`、
 * `apps/api/migrations/business/0059_controlled_withdrawal.sql:26`（本地受控提现 state）、
 * `0099_joinpay_native_payout.sql:131`（渠道提现 state）、`0098_joinpay_rental_refund.sql:178,199`（退款意图与 budget_disposition）。
 * 边界：本站记录、渠道结果、银行到账三件事分别命名；站内模拟出款不得读起来像已打款。
 */
import { displayLabel, UNRECOGNIZED_STATE_LABEL } from "./display-credit.ts";

export { UNRECOGNIZED_STATE_LABEL };

export type ObligationSource =
  | "POSTING" | "REVIEW_CONFIRMATION" | "PRESTART_TERMINATION" | "LEGACY_DUTY"
  | "LOCAL_CONTROLLED" | "JOINPAY_FORMAL";

const obligationSourceLabels: Record<ObligationSource, string> = {
  POSTING: "本平台结算责任",
  REVIEW_CONFIRMATION: "异常收款记录",
  PRESTART_TERMINATION: "未开租终止责任",
  LEGACY_DUTY: "旧平台责任",
  LOCAL_CONTROLLED: "站内模拟提现（未实际打款）",
  JOINPAY_FORMAL: "渠道提现",
};

export function obligationSourceLabel(source: string): string {
  return displayLabel(obligationSourceLabels, source);
}

export type RefundObligationState =
  | "NO_INTENT" | "OUTSTANDING" | "REVIEW_REQUIRED"
  | "SOURCE_RESPONSIBILITY_REVIEW" | "PROCESSING" | "UNKNOWN";

/** OUTSTANDING＝已过账但退款责任尚未被退款消费（budget_disposition 未 CONSUMED），与“未结算”不同事实。 */
const refundObligationLabels: Record<RefundObligationState, string> = {
  NO_INTENT: "未查到本站退款申请",
  OUTSTANDING: "退款责任未核销",
  REVIEW_REQUIRED: "退款责任或核销结果需人工核对",
  SOURCE_RESPONSIBILITY_REVIEW: "原收款责任依据需人工核对",
  PROCESSING: "退款处理中",
  UNKNOWN: "退款结果待确认",
};

export function refundObligationLabel(status: string): string {
  return displayLabel(refundObligationLabels, status);
}

const localWithdrawalLabels: Record<string, string> = {
  RESERVED: "站内提现处理中，资金已占用",
  SUBMITTING: "提现提交中",
  PROCESSING: "站内提现处理中",
  SUCCEEDED: "成功状态已记录，资金处理待核对（未实际打款）",
  FAILED: "站内提现失败，资金处理待核对",
  RECONCILIATION_REQUIRED: "提现结果冲突，需人工核对",
  UNKNOWN: "提现结果待确认",
};

const channelWithdrawalLabels: Record<string, string> = {
  RESERVED: "已受理，等待渠道出款",
  SUBMITTING: "正在提交渠道",
  PROCESSING: "渠道处理中",
  CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE: "渠道报告成功，本站处理待确认",
  SUCCEEDED: "成功状态已记录，资金处理待核对（银行到账另核）",
  FAILED: "渠道出款失败，资金处理待核对",
  RECONCILIATION_REQUIRED: "渠道结果与本站记录不一致，需核对",
  UNKNOWN: "渠道结果待确认",
};

/** 同一个 SUCCEEDED 在站内与渠道含义不同，必须带来源判定，不能合成同一成功态。 */
export function withdrawalObligationLabel(source: string, status: string): string {
  const table = source === "JOINPAY_FORMAL" ? channelWithdrawalLabels
    : source === "LOCAL_CONTROLLED" ? localWithdrawalLabels : null;
  return table ? displayLabel(table, status) : UNRECOGNIZED_STATE_LABEL;
}
