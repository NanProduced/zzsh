import { createHash } from "node:crypto";
import { canonicalize } from "../supply/content-hash";
import { legacyTimeMicros } from "./legacy-continuation-model";
import { JOINPAY_MAX_OUTBOUND_CENTS } from "./joinpay-protocol";
export const LEGACY_REFUND_REASON='订单结算退款';

/** Facts resolved from the locked old-order source, current duty and server merchant profile. */
export type LegacyRefundReviewBasis = Readonly<{
  orderId: string; dutyId: string; dutyRevision: string; dutyCents: string; sourceDigest: string; dutyEvidenceDigest: string;
  renterUserId: string; paymentRecordId: string; paymentOrderNo: string; paidCents: string; merchantIdentityId: string;
  refundDueAt: string | null; fundsDisposition: "AVAILABLE" | "HELD" | "CONFISCATED" | "UNKNOWN";
  dutyState: "PENDING" | "MATURED" | "SETTLED" | "VOID"; originalIntentExists: boolean;
}>;
/** A staff observation of the merchant record, not a provider-verified receipt. */
export type LegacyRefundReviewInput = Readonly<{
  paymentOrderNo: string; merchantIdentityId: string; paidCents: string; previouslyRefundedCents: string;
  priorAppliedToDutyCents: string; noUnresolvedRefunds: boolean; evidenceRef: string;
}>;
export type LegacyRefundReviewResult =
  | { ok: false; reason: string }
  | { ok: true; kind: "REFUND" | "NO_NEW_REFUND"; refundCents: string; remainingPaymentCents: string; fingerprint: string };

const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const digest = /^[a-f0-9]{64}$/;
const cents = /^(0|[1-9]\d{0,23})$/;
const refuse = (reason: string): LegacyRefundReviewResult => ({ ok: false, reason });

/** Compare a single verified baseline to a frozen responsibility before allocating one original-key refund. */
export function reviewLegacyRefund(basis: LegacyRefundReviewBasis, review: LegacyRefundReviewInput, now: string): LegacyRefundReviewResult {
  if (!basis || !review || ![basis.orderId,basis.dutyId,basis.renterUserId,basis.paymentRecordId,basis.merchantIdentityId].every(v => typeof v === "string" && id.test(v))
    || !/^[1-9]\d{0,18}$/.test(basis.dutyRevision) || ![basis.sourceDigest,basis.dutyEvidenceDigest].every(v => typeof v === "string" && digest.test(v))
    || typeof basis.paymentOrderNo !== "string" || !/^[A-Za-z0-9_-]{1,50}$/.test(basis.paymentOrderNo)
    || ![basis.dutyCents,basis.paidCents,review.paidCents,review.previouslyRefundedCents,review.priorAppliedToDutyCents]
      .every(v => typeof v === "string" && cents.test(v))) return refuse("REVIEW_INPUT_INVALID");
  if (basis.dutyState !== "PENDING" && basis.dutyState !== "MATURED") return refuse("DUTY_NOT_PAYABLE");
  if (basis.fundsDisposition !== "AVAILABLE") return refuse("DUTY_NOT_AVAILABLE");
  if (basis.originalIntentExists !== false) return refuse("ORIGINAL_ALREADY_HAS_INTENT");
  if (!basis.refundDueAt) return refuse("REFUND_DUE_UNKNOWN");
  try { if (legacyTimeMicros(basis.refundDueAt) > legacyTimeMicros(now)) return refuse("REFUND_NOT_DUE"); }
  catch { return refuse("REFUND_DUE_UNKNOWN"); }
  if (review.merchantIdentityId !== basis.merchantIdentityId || review.paymentOrderNo !== basis.paymentOrderNo || review.paidCents !== basis.paidCents)
    return refuse("ORIGINAL_PAYMENT_MISMATCH");
  if (review.noUnresolvedRefunds !== true) return refuse("REFUND_STATUS_UNCONFIRMED");
  if (typeof review.evidenceRef !== "string" || review.evidenceRef.trim().length < 3 || Buffer.byteLength(review.evidenceRef, "utf8") > 600
    || /[\u0000-\u001f\u007f]/.test(review.evidenceRef)) return refuse("REVIEW_EVIDENCE_REQUIRED");
  const paid=BigInt(basis.paidCents), duty=BigInt(basis.dutyCents), prior=BigInt(review.previouslyRefundedCents), applied=BigInt(review.priorAppliedToDutyCents);
  if (paid <= 0n || paid > JOINPAY_MAX_OUTBOUND_CENTS || duty > paid || prior > paid || applied > prior || applied > duty)
    return refuse("REVIEW_AMOUNT_INCONSISTENT");
  const refund=duty-applied, remaining=paid-prior;
  if (refund > remaining) return refuse("ORIGINAL_PAYMENT_BUDGET_INSUFFICIENT");
  const frozen={basis,review:{...review,evidenceRef:review.evidenceRef.trim()},refundCents:refund.toString(),remainingPaymentCents:remaining.toString()};
  return {ok:true,kind:refund===0n?"NO_NEW_REFUND":"REFUND",refundCents:frozen.refundCents,remainingPaymentCents:frozen.remainingPaymentCents,
    fingerprint:createHash("sha256").update(canonicalize(frozen)).digest("hex")};
}
