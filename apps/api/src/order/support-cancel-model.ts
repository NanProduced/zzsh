import { SecurityApiError } from "../auth/security-core";

const CENTS = /^[1-9][0-9]{0,15}$/;

/** 客服取消的稳定中止原因；订单取消原因仍用独立值 SUPPORT_CANCELLED_REFUND。 */
export const SUPPORT_CANCEL_REASONS = [
  "ORDER_COMPLETED",
  "ORDER_NOT_PAID",
  "PAYMENT_BASIS_UNAVAILABLE",
  "OPENING_ALREADY_CONFIRMED",
  "SETTLEMENT_ALREADY_POSTED",
  "SETTLEMENT_DRAFT_EXISTS",
  "MANUAL_ADJUSTMENT_REVIEW",
  "DISTRIBUTION_RECONCILIATION_REQUIRED",
  "REFUND_PENDING",
  "TERMINATION_PENDING",
  "ALREADY_CANCELLED",
  "ORDER_CHANGED",
] as const;
export type SupportCancelReason = (typeof SUPPORT_CANCEL_REASONS)[number];

export type SupportCancelFacts = Readonly<{
  orderState: string;
  paymentSource: string | null;
  paymentDisposition: string | null;
  currency: string | null;
  paidCents: string | null;
  orderCents: string | null;
  paymentBound: boolean;
  openingConfirmed: boolean;
  hasPosting: boolean;
  pendingSettlement: boolean;
  pendingAdjustment: boolean;
  monetaryEarningCount: string;
  activeRefundCount: string;
  otherTermination: boolean;
}>;

export type SupportCancelEligibility = Readonly<{
  allowed: boolean;
  reason: SupportCancelReason | null;
  refundCents: string | null;
  openingConfirmed: boolean;
}>;

/** 客服特殊取消按原款剩余额分配；金额均为整分，不产生分销佣金。 */
export function supportPoststartCancellationAllocation(input: {
 paidCents:unknown;previouslyAllocatedCents:unknown;refundCents:unknown;ownerCents:unknown;
}) {
 const values=[input.paidCents,input.previouslyAllocatedCents,input.refundCents,input.ownerCents];
 if(values.some(value=>typeof value!=="string"||!/^(0|[1-9][0-9]{0,15})$/.test(value)))
  throw new SecurityApiError(400,"INVALID_ARGUMENT","取消金额必须为非负整数分");
 const [paid,allocated,refund,owner]=values.map(value=>BigInt(value as string)) as [bigint,bigint,bigint,bigint];
 if(allocated>0n)throw new SecurityApiError(409,"CONFLICT","原付款已有退款记录，请先线下核对");
 if(paid===0n||refund+owner>paid)
  throw new SecurityApiError(409,"CONFLICT","退款和号主收益合计不能超过原付款剩余金额");
 return {paidCents:paid.toString(),previouslyAllocatedCents:allocated.toString(),refundCents:refund.toString(),
  ownerCents:owner.toString(),platformContributionCents:(paid-allocated-refund-owner).toString(),commissionCents:"0"};
}

export function assertSupportPoststartCancelInput(input:Record<string,unknown>) {
 const revision=input.expectedOrderRevision,reason=input.reason,refund=input.refundCents,owner=input.ownerCents;
 if(typeof revision!=="string"||!/^[1-9][0-9]{0,18}$/.test(revision)
  ||typeof reason!=="string"||[...reason.trim()].length<3||Buffer.byteLength(reason.trim(),"utf8")>600
  ||/[\u0000-\u001f\u007f]/.test(reason)
  ||typeof refund!=="string"||!/^(0|[1-9][0-9]{0,15})$/.test(refund)
  ||typeof owner!=="string"||!/^(0|[1-9][0-9]{0,15})$/.test(owner))
  throw new SecurityApiError(400,"INVALID_ARGUMENT","请填写取消原因、退款金额和号主收益");
 return {expectedOrderRevision:revision,reason:reason.trim(),refundCents:refund,ownerCents:owner};
}

/** 已开租客服取消不要求结算草稿先关闭，但不能覆盖已记账或已分配退款。 */
export function supportPoststartCancellationEligibility(facts:SupportCancelFacts,allowControlled=false):SupportCancelEligibility {
 const blocked=(reason:SupportCancelReason):SupportCancelEligibility=>({allowed:false,reason,refundCents:null,openingConfirmed:facts?.openingConfirmed===true});
 if(!facts||!["paymentBound","openingConfirmed","hasPosting","pendingSettlement","pendingAdjustment","otherTermination"]
  .every(key=>typeof(facts as unknown as Record<string,unknown>)[key]==="boolean")
  ||typeof facts.monetaryEarningCount!=="string"||typeof facts.activeRefundCount!=="string")return blocked("PAYMENT_BASIS_UNAVAILABLE");
 if(facts.orderState!=="PAID")return blocked(facts.orderState==="COMPLETED"?"ORDER_COMPLETED":"ORDER_NOT_PAID");
 if(!facts.paymentBound||!(facts.paymentSource==="JOINPAY"||allowControlled&&facts.paymentSource==="CONTROLLED")
  ||facts.paymentDisposition!=="APPLIED"||facts.currency!=="CNY"||typeof facts.paidCents!=="string"||!CENTS.test(facts.paidCents)
  ||facts.paidCents!==facts.orderCents)return blocked("PAYMENT_BASIS_UNAVAILABLE");
 if(!facts.openingConfirmed)return blocked("ORDER_CHANGED");
 if(facts.hasPosting)return blocked("SETTLEMENT_ALREADY_POSTED");
 if(facts.monetaryEarningCount!=="0")return blocked("DISTRIBUTION_RECONCILIATION_REQUIRED");
 if(facts.activeRefundCount!=="0")return blocked("REFUND_PENDING");
 if(facts.otherTermination)return blocked("TERMINATION_PENDING");
 return {allowed:true,reason:null,refundCents:facts.paidCents,openingConfirmed:true};
}

/**
 * 纯业务判断，不授予退款能力。客服取消沿用未开租全额原款责任，要求：
 * 订单 PAID、原 APPLIED 付款完整、无结算/结算草稿/待处理调整、无未冲销佣金、
 * 无未完成退款、无其他未处理终止申请；金额固定为原支付金额。
 */
export function supportCancelEligibility(facts: SupportCancelFacts, allowControlled = false): SupportCancelEligibility {
  const blocked = (reason: SupportCancelReason): SupportCancelEligibility =>
    ({ allowed: false, reason, refundCents: null, openingConfirmed: facts?.openingConfirmed === true });
  if (!facts || !["paymentBound", "openingConfirmed", "hasPosting", "pendingSettlement", "pendingAdjustment", "otherTermination"]
    .every(key => typeof (facts as unknown as Record<string, unknown>)[key] === "boolean")
    || typeof facts.monetaryEarningCount !== "string" || typeof facts.activeRefundCount !== "string") return blocked("PAYMENT_BASIS_UNAVAILABLE");
  if (facts.orderState !== "PAID") return blocked(facts.orderState === "COMPLETED" ? "ORDER_COMPLETED" : "ORDER_NOT_PAID");
  if (!facts.paymentBound || !(facts.paymentSource === "JOINPAY" || allowControlled && facts.paymentSource === "CONTROLLED") || facts.paymentDisposition !== "APPLIED"
    || facts.currency !== "CNY" || typeof facts.paidCents !== "string" || !CENTS.test(facts.paidCents) || facts.paidCents !== facts.orderCents)
    return blocked("PAYMENT_BASIS_UNAVAILABLE");
  if (facts.openingConfirmed) return blocked("OPENING_ALREADY_CONFIRMED");
  if (facts.hasPosting) return blocked("SETTLEMENT_ALREADY_POSTED");
  if (facts.pendingAdjustment) return blocked("MANUAL_ADJUSTMENT_REVIEW");
  if (facts.pendingSettlement) return blocked("SETTLEMENT_DRAFT_EXISTS");
  if (facts.monetaryEarningCount !== "0") return blocked("DISTRIBUTION_RECONCILIATION_REQUIRED");
  if (facts.activeRefundCount !== "0") return blocked("REFUND_PENDING");
  if (facts.otherTermination) return blocked("TERMINATION_PENDING");
  return { allowed: true, reason: null, refundCents: facts.paidCents, openingConfirmed: facts.openingConfirmed };
}

export function supportCancelConflict(orderId: string, reason: SupportCancelReason): { status: 409; body: Record<string, unknown> } {
  const messages: Record<SupportCancelReason, string> = {
    ORDER_COMPLETED: "Settlement has been posted or the order is completed; use finance/after-sales refund",
    ORDER_NOT_PAID: "Order is not in a cancellable paid state",
    PAYMENT_BASIS_UNAVAILABLE: "Original applied JoinPay payment is unavailable",
    OPENING_ALREADY_CONFIRMED: "Opening is confirmed; use the existing settlement and refund flow",
    SETTLEMENT_ALREADY_POSTED: "Settlement has already been posted; use finance/after-sales refund",
    SETTLEMENT_DRAFT_EXISTS: "A settlement draft or intake is pending; close it before cancelling",
    MANUAL_ADJUSTMENT_REVIEW: "A manual settlement adjustment is pending",
    DISTRIBUTION_RECONCILIATION_REQUIRED: "Owner/distribution earnings must be reconciled by finance first",
    REFUND_PENDING: "An unfinished refund already exists for this order",
    TERMINATION_PENDING: "An unfinished termination request already exists for this order",
    ALREADY_CANCELLED: "Order is already cancelled",
    ORDER_CHANGED: "Order changed; reload before cancelling",
  };
  return { status: 409, body: {
    contractVersion: "admin-support-cancel.v1", orderId, outcome: "BLOCKED",
    reason, reasons: [reason], message: messages[reason],
    channelResult: "NOT_SUBMITTED", bankArrival: "UNKNOWN",
  } };
}

export function assertSupportCancelInput(input: Record<string, unknown>): { expectedOrderRevision: string; reason: string } {
  const revision = input.expectedOrderRevision;
  const reason = input.reason;
  if (typeof revision !== "string" || !/^[1-9][0-9]{0,18}$/.test(revision)
    || typeof reason !== "string" || reason.trim().length < 3 || Buffer.byteLength(reason, "utf8") > 600
    || [...reason].some((ch) => { const code = ch.codePointAt(0)!; return code < 32 && code !== 10 && code !== 13 || code === 127; })) {
    throw new SecurityApiError(400, "INVALID_ARGUMENT", "Invalid support cancellation request");
  }
  return { expectedOrderRevision: revision, reason: reason.trim() };
}
