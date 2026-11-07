import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import { readLegacyContinuationEvidence } from "./legacy-continuation-evidence";
import { readLegacyDutyBasis } from "./legacy-duty-basis";
import { legacyPlanYuanToCents, readSealedLegacyFacts, type LegacyDutyRow, type LegacyHeadRow, type LegacyOrderBinding } from "./legacy-continuation-model";
import type { LegacyRefundReviewBasis } from "./legacy-refund-review";

const unavailable = (reason: string): never => { throw new SecurityApiError(409, "CONFLICT", reason); };
type Source = Omit<LegacyRefundReviewBasis, "merchantIdentityId" | "originalIntentExists">;

/** Caller holds the ordered user/game prefix and the shared legacy-order/head/duty lock. */
export async function readLockedLegacyRefundSource(client: PoolClient, binding: LegacyOrderBinding,
  head: LegacyHeadRow | null, duty: LegacyDutyRow): Promise<Source> {
  if (!head || head.orderId !== binding.id || String(head.stage) !== "4" || String(head.isSettle) !== "0"
    || binding.sourcePayStatus !== 1 || ![3,8,9].includes(binding.sourceOrderStatus)
    || duty.orderId !== binding.id || duty.kind !== "RENTER_REFUND" || duty.source !== "CONTINUATION"
    || duty.counterpartyUserId !== binding.renterUserId || !duty.continuationVersionId
    || !["PENDING", "MATURED"].includes(duty.status) || duty.settledBy !== null
    || duty.settledRefType !== null || duty.settledRefId !== null || duty.settledRefDigest !== null) return unavailable("LEGACY_REFUND_DUTY_UNAVAILABLE");
  const resolved = await readLegacyDutyBasis(client, binding.id, duty);
  if (resolved.state !== "KNOWN" || resolved.dutyId !== duty.id || resolved.orderId !== binding.id || resolved.kind !== "RENTER_REFUND"
    || resolved.beneficiaryUserId !== binding.renterUserId || resolved.amountCents !== duty.amountCents || resolved.currency !== "CNY"
    || resolved.parentSourceDigest !== binding.sourceDigest || resolved.effectiveHeadId !== head.id || resolved.effectiveHeadRevision !== head.revision
    || resolved.continuationVersionId !== duty.continuationVersionId || resolved.fundsDisposition !== "AVAILABLE"
    || resolved.currentNetRefundCents !== duty.amountCents) return unavailable("LEGACY_REFUND_DUTY_UNAVAILABLE");
  const imported = await readLegacyContinuationEvidence(client, binding.id, null);
  if (!imported || imported.orderId !== binding.id || imported.sourceKind !== "SOURCE_IMPORT" || imported.sourceDigest !== binding.sourceDigest)
    return unavailable("LEGACY_PAYMENT_SOURCE_UNAVAILABLE");
  const facts = readSealedLegacyFacts(imported), source = facts.evidence.source, payment = source.paidPay;
  if (facts.evidence.admission !== "PARAMETER_COMPLETE" || source.legacyOrderId !== binding.legacyId
    || source.renterId !== binding.legacyRenterId || source.ownerId !== binding.legacyOwnerId || source.accountId !== binding.legacyAccountId || !Array.isArray(payment)
    || payment.length !== 1 || payment[0]!.orderId !== undefined && payment[0]!.orderId !== binding.legacyId
    || typeof payment[0]!.id !== "string" || !/^[1-9]\d{0,23}$/.test(payment[0]!.id)
    || typeof payment[0]!.payOrderSn !== "string" || !/^[A-Za-z0-9_-]{1,50}$/.test(payment[0]!.payOrderSn)
    || typeof source.payMoney !== "string" || typeof payment[0]!.payMoney !== "string" || typeof binding.paidCents !== "string")
    return unavailable("LEGACY_PAYMENT_SOURCE_UNAVAILABLE");
  try {
    if (legacyPlanYuanToCents(source.payMoney) !== binding.paidCents || legacyPlanYuanToCents(payment[0]!.payMoney) !== binding.paidCents)
      return unavailable("LEGACY_PAYMENT_SOURCE_MISMATCH");
  } catch { return unavailable("LEGACY_PAYMENT_SOURCE_MISMATCH"); }
  const duplicate=(await client.query<{found:boolean}>(`SELECT EXISTS(
    SELECT 1 FROM zzsh_order.legacy_continuation_evidence e
    CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.facts#>'{evidence,source,paidPay}')='array'
      THEN e.facts#>'{evidence,source,paidPay}' ELSE '[]'::jsonb END) p
    WHERE e.source_kind='SOURCE_IMPORT' AND e.order_id<>$1 AND (p->>'id'=$2 OR p->>'payOrderSn'=$3))
    OR EXISTS(SELECT 1 FROM zzsh_order.personal_finance_observation o WHERE o.source_type='LEGACY_MYSQL' AND o.source_kind='HISTORICAL_PAYMENT'
      AND o.source_system='legacy_mysql_restore' AND o.source_entity='la_pay_order' AND o.snapshot->>'sourceNumber'=$3 AND o.source_id<>$2)
    OR EXISTS(SELECT 1 FROM zzsh_order.personal_finance_observation o WHERE o.source_type='LEGACY_MYSQL' AND o.source_kind='HISTORICAL_PAYMENT'
      AND o.source_system='legacy_mysql_restore' AND o.source_entity='la_pay_order' AND o.source_id=$2 AND o.snapshot->>'sourceNumber' IS DISTINCT FROM $3) AS found`,
  [binding.id,payment[0]!.id,payment[0]!.payOrderSn])).rows[0];
  if (duplicate?.found !== false) return unavailable("LEGACY_PAYMENT_SOURCE_AMBIGUOUS");
  const row=(await client.query<{dueAt:string|null}>(`SELECT to_char(refund_due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "dueAt"
    FROM zzsh_order.legacy_continuation_version WHERE id=$1 AND order_id=$2 AND command='CONFIRM'`,[duty.continuationVersionId,binding.id])).rows[0];
  if (!row) return unavailable("LEGACY_REFUND_CONFIRMATION_UNAVAILABLE");
  return {orderId:binding.id,dutyId:duty.id,dutyRevision:duty.revision,dutyCents:duty.amountCents,sourceDigest:binding.sourceDigest,
    dutyEvidenceDigest:resolved.effectiveFactsDigest,renterUserId:binding.renterUserId,paymentRecordId:payment[0]!.id,
    paymentOrderNo:payment[0]!.payOrderSn,paidCents:binding.paidCents,refundDueAt:row.dueAt,
    fundsDisposition:"AVAILABLE",dutyState:duty.status as "PENDING" | "MATURED"};
}
