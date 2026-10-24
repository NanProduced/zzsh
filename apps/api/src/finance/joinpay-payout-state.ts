import { JoinpayPayoutProtocolError, type PayoutCalculation } from "./joinpay-payout-protocol";
export type PayoutRequestPhase = "SUBMITTING" | "PROCESSING" | "UNKNOWN" | "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE" | "SUCCEEDED" | "FAILED";
export type PayoutObservationState = Readonly<{ phase: PayoutRequestPhase; requiresReview: boolean; platformSerialNo: string | null }>;
/** 状态建议没有资金能力；正式终态只允许后续私有事实+同事务账务适配创建。 */
export function reduceJoinpayPayoutObservation(previous: PayoutObservationState, result: PayoutCalculation) {
  if (!previous || !["SUBMITTING", "PROCESSING", "UNKNOWN", "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE", "SUCCEEDED", "FAILED"].includes(previous.phase)
    || typeof previous.requiresReview !== "boolean" || previous.platformSerialNo !== null && typeof previous.platformSerialNo !== "string") throw new JoinpayPayoutProtocolError("PAYOUT_STATE_INVALID");
  let phase = previous.phase, requiresReview = previous.requiresReview, platformSerialNo = previous.platformSerialNo;
  const verified = result.signature === "MATCH" && result.binding === "MATCH", terminal = phase === "SUCCEEDED" || phase === "FAILED";
  if (result.decision !== "STALE") {
    if (terminal) {
      if (verified && ((result.decision === "CHANNEL_REPORTED_SUCCEEDED" && phase === "FAILED") || (result.decision === "CHANNEL_REPORTED_FAILED" && phase === "SUCCEEDED")
        || result.platformSerialNo !== null && previous.platformSerialNo !== result.platformSerialNo)) requiresReview = true;
      if (result.signature === "MATCH" && result.decision === "REVIEW_REQUIRED") requiresReview = true;
    } else if (previous.requiresReview) { /* 保留查询观察，隔离期间不建立新的待接纳绑定。 */ }
    else if (verified && platformSerialNo !== null && result.platformSerialNo !== null && platformSerialNo !== result.platformSerialNo) requiresReview = true;
    else if (result.decision === "REVIEW_REQUIRED") requiresReview = true;
    else if (phase === "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE") {
      if (verified && ["CHANNEL_REPORTED_FAILED", "PROVIDER_REPORTED_NOT_FOUND"].includes(result.decision)) requiresReview = true;
    }
    else if (verified) {
      if (result.decision === "CHANNEL_REPORTED_SUCCEEDED") { phase = "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE"; platformSerialNo = result.platformSerialNo; }
      else if (result.decision === "PROCESSING" || result.decision === "APPLICATION_ACCEPTED") phase = "PROCESSING";
      else phase = "UNKNOWN";
    } else if (result.operation === "SYNC" && phase === "SUBMITTING") phase = "UNKNOWN";
  }
  return Object.freeze({ phase, requiresReview, platformSerialNo,
    nextOperation: terminal ? null : "QUERY_ORIGINAL" as const, reservationEffect: "UNCHANGED" as const,
    requiresNoExecutionProof: result.decision === "CHANNEL_REPORTED_FAILED" || result.decision === "PROVIDER_REPORTED_NOT_FOUND",
    evidenceLevel: "PROTOCOL_STATE_PLAN" as const, mayAffectFunds: false as const });
}
