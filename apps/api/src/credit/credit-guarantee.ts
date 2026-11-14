/**
 * 信用与保证金门面。实现已按信用分、投影、支付、退款拆开，调用方路径不变。
 * 函数用可写绑定再导出：`export { fn } from` 会编成只读 getter，既有 t.mock.method 无法替换。
 */
import * as context from "./credit-guarantee-context";
import * as payment from "./credit-guarantee-payment";
import * as refund from "./credit-guarantee-refund";
import * as score from "./credit-guarantee-score";

export {
  CREDIT_BREACH_DELTA,
  CREDIT_GUARANTEE_CAP_CENTS,
  CREDIT_GUARANTEE_THRESHOLD,
  CREDIT_INITIAL_SCORE,
  CREDIT_RECOVERY_DAYS,
  CREDIT_RECOVERY_DELTA,
} from "./credit-guarantee-internals";

export type {
  CreditEvent,
  CreditEventType,
  CreditReadScope,
  CreditSnapshot,
  CreditSubjectRole,
  RecoveryEligibility,
} from "./credit-guarantee-score";
export type { GuaranteeContext, GuaranteeState } from "./credit-guarantee-context";
export type { GuaranteePaymentOutcome } from "./credit-guarantee-payment";
export type { DelistedGuaranteeRefund, GuaranteeRefundOutcome } from "./credit-guarantee-refund";

export { AUTOMATIC_GUARANTEE_REFUND_HAS_ISSUE } from "./credit-guarantee-refund";

export let initializeCreditStateIfMissing = score.initializeCreditStateIfMissing;
export let ensureCreditAccount = score.ensureCreditAccount;
export let readCreditSnapshot = score.readCreditSnapshot;
export let writeManualCreditAdjustment = score.writeManualCreditAdjustment;
export let confirmBreach = score.confirmBreach;
export let reverseBreach = score.reverseBreach;
export let recoveryEligibility = score.recoveryEligibility;
export let requestRecovery = score.requestRecovery;
export let decideRecovery = score.decideRecovery;
export let requiredGuaranteeCents = context.requiredGuaranteeCents;
export let readGuaranteeContext = context.readGuaranteeContext;
export let readGuaranteeContextsBatch = context.readGuaranteeContextsBatch;
export let isGuaranteeRequirementFact = context.isGuaranteeRequirementFact;
export let readGuaranteeContextForGate = context.readGuaranteeContextForGate;
export let readGuaranteeTransactions = payment.readGuaranteeTransactions;
export let createGuaranteePaymentIntent = payment.createGuaranteePaymentIntent;
export let automaticGuaranteeRefundIssue = refund.automaticGuaranteeRefundIssue;
export let enqueueDelistedGuaranteeRefund = refund.enqueueDelistedGuaranteeRefund;
export let enqueueCompletedGuaranteeRefund = refund.enqueueCompletedGuaranteeRefund;
export let requestGuaranteeRefund = refund.requestGuaranteeRefund;
export let lockGuaranteeSubject = refund.lockGuaranteeSubject;
export let safelyEnqueueDelistedGuaranteeRefund = refund.safelyEnqueueDelistedGuaranteeRefund;
export let safelyEnqueueCompletedGuaranteeRefund = refund.safelyEnqueueCompletedGuaranteeRefund;
export let recordGuaranteePaymentResult = payment.recordGuaranteePaymentResult;
export let recordGuaranteeRefundResult = refund.recordGuaranteeRefundResult;
export let decideGuaranteeRefund = refund.decideGuaranteeRefund;
