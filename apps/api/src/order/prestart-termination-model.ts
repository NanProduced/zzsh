import { SecurityApiError } from "../auth/security-core";

const CENTS = /^[1-9][0-9]{0,15}$/;
export const PRESTART_TERMINATION_VERSION = "order-prestart-termination.v1";
export const PRESTART_TERMINATION_STATES = ["REQUESTED", "REVIEW_REQUIRED", "REJECTED", "APPROVED"] as const;
export type PrestartTerminationState = typeof PRESTART_TERMINATION_STATES[number];
export type PrestartEligibilityReason = "ORDER_NOT_PAID" | "PAYMENT_BASIS_UNAVAILABLE" | "PRESTART_FACTS_UNAVAILABLE" | "RENTAL_ALREADY_STARTED"
  | "SETTLEMENT_ALREADY_POSTED" | "MANUAL_ADJUSTMENT_REVIEW" | "DISTRIBUTION_RECONCILIATION_REQUIRED";
export type PrestartFacts = Readonly<{
  orderState: string; paymentSource: string | null; paymentDisposition: string | null; currency: string | null;
  paidCents: string | null; orderCents: string | null; paymentBound: boolean;
  openingConfirmed: boolean; hasPosting: boolean; pendingAdjustment: boolean; monetaryEarningCount: string;
}>;

/** 纯业务判断不授予付款或退款能力；事实必须由服务端在原订单锁内读取。 */
export function prestartTerminationEligibility(f: PrestartFacts): Readonly<{ allowed: boolean; reason: PrestartEligibilityReason | null; refundCents: string | null }> {
  const blocked = (reason: PrestartEligibilityReason) => ({ allowed: false, reason, refundCents: null });
  if (!f || ![f.openingConfirmed,f.hasPosting,f.pendingAdjustment,f.paymentBound].every(v=>typeof v==="boolean")) return blocked("PRESTART_FACTS_UNAVAILABLE");
  if (f.orderState !== "PAID") return blocked("ORDER_NOT_PAID");
  if (!f.paymentBound || !["CONTROLLED", "JOINPAY"].includes(f.paymentSource ?? "") || f.paymentDisposition !== "APPLIED"
    || f.currency !== "CNY" || typeof f.paidCents !== "string" || !CENTS.test(f.paidCents) || f.paidCents !== f.orderCents) return blocked("PAYMENT_BASIS_UNAVAILABLE");
  if (f.openingConfirmed) return blocked("RENTAL_ALREADY_STARTED");
  if (f.hasPosting) return blocked("SETTLEMENT_ALREADY_POSTED");
  if (f.pendingAdjustment) return blocked("MANUAL_ADJUSTMENT_REVIEW");
  // 当前佣金仅可由真实结算posting计提；未开租却有资金计提必须核原根，不能按冻结basis盲冲回。
  if (f.monetaryEarningCount !== "0") return blocked("DISTRIBUTION_RECONCILIATION_REQUIRED");
  return { allowed: true, reason: null, refundCents: f.paidCents };
}

export function assertPrestartDecision(input: { decision: unknown; assessment?: unknown; expectedRevision: unknown; reason: unknown }) {
  if (typeof input.decision !== "string" || !["APPROVE", "REJECT", "REVIEW_REQUIRED"].includes(input.decision)
    || typeof input.expectedRevision !== "string" || !/^[1-9][0-9]{0,18}$/.test(input.expectedRevision)
    || typeof input.reason !== "string" || input.reason.trim().length < 3 || Buffer.byteLength(input.reason, "utf8") > 600
    || input.decision === "APPROVE" && input.assessment !== "NO_USE_NO_DISPUTE"
    || input.decision !== "APPROVE" && input.assessment !== undefined) throw new SecurityApiError(400, "INVALID_ARGUMENT", "Invalid prestart termination review");
  return { decision: input.decision as "APPROVE" | "REJECT" | "REVIEW_REQUIRED", expectedRevision: input.expectedRevision,
    reason: input.reason.trim(), ...(input.decision === "APPROVE" ? { assessment: "NO_USE_NO_DISPUTE" as const } : {}) };
}
