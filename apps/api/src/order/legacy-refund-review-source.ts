import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import { prepareHistoricalObservation } from "../finance/personal-finance-read";
import { canonicalize } from "../supply/content-hash";
import { readLegacyContinuationEvidence } from "./legacy-continuation-evidence";
import { readLegacyDutyBasis } from "./legacy-duty-basis";
import { legacyPlanYuanToCents, readSealedLegacyFacts, type LegacyDutyRow, type LegacyHeadRow, type LegacyOrderBinding } from "./legacy-continuation-model";
import type { LegacyRefundReviewBasis } from "./legacy-refund-review";

const unavailable = (reason: string): never => { throw new SecurityApiError(409, "CONFLICT", reason); };
type Source = Omit<LegacyRefundReviewBasis, "merchantIdentityId" | "originalIntentExists">;

/** A recorded old refund needs separate handling; absence is not a channel receipt. */
export async function hasLegacyRecordedRefunds(client:PoolClient,binding:LegacyOrderBinding,excludeVersionId:string|null=null):Promise<boolean> {
  const row=(await client.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM zzsh_order.personal_finance_observation o
    JOIN zzsh_order.legacy_order_read_snapshot l ON l.id=$1 AND l.renter_user_id=o.user_id
    WHERE o.source_system='legacy_mysql_restore' AND o.source_entity='la_refund_record' AND o.source_kind='HISTORICAL_REFUND'
      AND (o.snapshot->>'referenceId'=l.legacy_id OR o.snapshot->>'referenceSn'=l.original_order_no))
    OR EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_case x LEFT JOIN zzsh_order.legacy_order_duty d ON d.id=x.duty_id
      WHERE x.order_id=$1 AND ($2::text IS NULL OR d.continuation_version_id IS DISTINCT FROM $2)) AS found`,[binding.id,excludeVersionId])).rows[0];
  if(typeof row?.found!=="boolean")return unavailable("LEGACY_REFUND_HISTORY_UNKNOWN");
  return row.found;
}

/** An old completed order has no continuation head; its imported payment observation is its source. */
export async function readHistoricalOriginalPayment(client:PoolClient,binding:LegacyOrderBinding) {
  const rows=(await client.query<{source_id:string;source_digest:string;source_canonical:string;snapshot:Record<string,unknown>}>(`SELECT source_id,source_digest,source_canonical,snapshot
    FROM zzsh_order.personal_finance_observation WHERE user_id=$1 AND legacy_user_id=$2 AND source_type='LEGACY_MYSQL'
      AND source_system='legacy_mysql_restore' AND source_entity='la_pay_order' AND source_kind='HISTORICAL_PAYMENT'
      AND snapshot->>'referenceType'='LEGACY_ORDER' AND snapshot->>'referenceId'=$3 AND snapshot->>'sourceOrderType'='1'
      AND snapshot->>'sourceStatus'='1' ORDER BY source_id LIMIT 2`,[binding.renterUserId,binding.legacyRenterId,binding.legacyId])).rows;
  if(rows.length!==1)return unavailable("LEGACY_PAYMENT_SOURCE_UNAVAILABLE");
  const row=rows[0]!;let payment:ReturnType<typeof prepareHistoricalObservation>;
  try{
    const snapshot=JSON.parse(row.source_canonical) as Record<string,unknown>;
    payment=prepareHistoricalObservation(snapshot,{userId:binding.renterUserId,legacyUserId:binding.legacyRenterId,sourceSystem:'legacy_mysql_restore',basisId:null});
    if(canonicalize(row.snapshot)!==row.source_canonical || payment.sourceCanonical!==row.source_canonical || payment.sourceDigest!==row.source_digest
      || payment.sourceId!==row.source_id || snapshot.associationState!=='SOURCE_VERIFIED' || snapshot.referenceType!=='LEGACY_ORDER'
      || String(snapshot.referenceId)!==binding.legacyId || String(snapshot.sourceOrderType)!=='1' || snapshot.sourceStatus!==1
      || typeof snapshot.sourceNumber!=='string' || !/^[A-Za-z0-9_-]{1,50}$/.test(snapshot.sourceNumber)
      || typeof snapshot.amount!=='string' || legacyPlanYuanToCents(snapshot.amount)!==binding.paidCents)return unavailable('LEGACY_PAYMENT_SOURCE_MISMATCH');
    return {id:row.source_id,paymentOrderNo:snapshot.sourceNumber};
  }catch{return unavailable('LEGACY_PAYMENT_SOURCE_MISMATCH');}
}

/** Caller holds the ordered user/game prefix and the shared legacy-order/head/duty lock. */
export async function readLockedLegacyRefundSource(client: PoolClient, binding: LegacyOrderBinding,
  head: LegacyHeadRow | null, duty: LegacyDutyRow, allowHistoricalHeld=false): Promise<Source> {
  const historical=!head && binding.sourceOrderStatus===4 && duty.source==='LEGACY_IMPORT' && ['COMPLETED_UNREFUNDED','DETAINED'].includes(duty.sourceStatus??'');
  if(historical){
    if(duty.sourceStatus==='DETAINED' && !allowHistoricalHeld || binding.sourcePayStatus!==1 || duty.orderId!==binding.id || duty.kind!=='RENTER_REFUND' || duty.counterpartyUserId!==binding.renterUserId
      || duty.continuationVersionId!==null || !['PENDING','MATURED'].includes(duty.status) || duty.settledBy!==null
      || duty.settledRefType!==null || duty.settledRefId!==null || duty.settledRefDigest!==null)return unavailable('LEGACY_REFUND_DUTY_UNAVAILABLE');
    const resolved=await readLegacyDutyBasis(client,binding.id,duty);
    if(resolved.state!=='KNOWN' || resolved.dutyId!==duty.id || resolved.orderId!==binding.id || resolved.kind!=='RENTER_REFUND'
      || resolved.beneficiaryUserId!==binding.renterUserId || resolved.currency!=='CNY' || resolved.effectiveHeadId!==null
      || resolved.effectiveHeadRevision!==null || resolved.continuationVersionId!==null
      || resolved.parentSourceDigest!==binding.sourceDigest || resolved.amountCents!==duty.amountCents
      || !(resolved.fundsDisposition==='AVAILABLE' || allowHistoricalHeld && duty.sourceStatus==='DETAINED' && resolved.fundsDisposition==='HELD')
      || resolved.currentNetRefundCents!==duty.amountCents)return unavailable('LEGACY_REFUND_DUTY_UNAVAILABLE');
    const payment=await readHistoricalOriginalPayment(client,binding);
    return {orderId:binding.id,dutyId:duty.id,dutyRevision:duty.revision,dutyCents:duty.amountCents,sourceDigest:binding.sourceDigest,
      dutyEvidenceDigest:resolved.effectiveFactsDigest,renterUserId:binding.renterUserId,paymentRecordId:payment.id,paymentOrderNo:payment.paymentOrderNo,
      paidCents:binding.paidCents!,refundDueAt:null,fundsDisposition:resolved.fundsDisposition,dutyState:duty.status as 'PENDING'|'MATURED'};
  }
  if (!head || head.orderId !== binding.id || !(String(head.stage)==="4" || String(head.stage)==="5" && head.command==="SUPPORT_CANCEL") || String(head.isSettle) !== "0"
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
  if (facts.evidence.admission !== "PARAMETER_COMPLETE" && head.command!=="SUPPORT_CANCEL" || source.legacyOrderId !== binding.legacyId
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
    FROM zzsh_order.legacy_continuation_version WHERE id=$1 AND order_id=$2 AND command IN('CONFIRM','SUPPORT_CANCEL')`,[duty.continuationVersionId,binding.id])).rows[0];
  if (!row) return unavailable("LEGACY_REFUND_CONFIRMATION_UNAVAILABLE");
  return {orderId:binding.id,dutyId:duty.id,dutyRevision:duty.revision,dutyCents:duty.amountCents,sourceDigest:binding.sourceDigest,
    dutyEvidenceDigest:resolved.effectiveFactsDigest,renterUserId:binding.renterUserId,paymentRecordId:payment[0]!.id,
    paymentOrderNo:payment[0]!.payOrderSn,paidCents:binding.paidCents,refundDueAt:row.dueAt,
    fundsDisposition:"AVAILABLE",dutyState:duty.status as "PENDING" | "MATURED"};
}
