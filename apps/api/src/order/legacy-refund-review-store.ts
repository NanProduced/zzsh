import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { lockActor } from "../auth/admin-directory";
import { assertAdminCommandAuthorizedInTransaction } from "../auth/admin-auth-session";
import { loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import { conflict, invalid, notFound } from "../supply/supply-util";
import { canonicalize } from "../supply/content-hash";
import { assertRefundResource } from "./channel-refund-store";
import { hasNativeOriginalOrderNo, lockRefundOrderNos } from "./payment-original-lock";
import { assertFormalRefundProfile, describeRefundProfile, readRefundProfileEvidence, type BoundRefundProfile, type FormalRefundAdmission } from "./joinpay-refund-profile";
import { authorizeLegacyMutation } from "./legacy-continuation-command";
import { authorizeLegacyContinuation, lockLegacyContinuationOrder, readLegacyContinuationBinding, readLegacyContinuationEvidence } from "./legacy-continuation-evidence";
import { readSealedLegacyFacts, type LegacyContinuationActor } from "./legacy-continuation-model";
import { reviewLegacyRefund } from "./legacy-refund-review";
import { readLockedLegacyRefundSource } from "./legacy-refund-review-source";

export type LegacyRefundReviewCommand = Readonly<{
  orderId:string; dutyId:string; expectedDutyRevision:string; expectedHeadRevision:string;
  paymentOrderNo:string; confirmedMerchantNo:string; paidCents:string; previouslyRefundedCents:string;
  priorAppliedToDutyCents:string; noUnresolvedRefunds:boolean; evidenceRef:string;
}>;
const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Check the operator and game without taking user locks before the original-payment lock. */
export async function authorizeLegacyRefundReviewAccess(client:PoolClient,actor:LegacyContinuationActor,orderId:string){
  if(!actor||actor.realm!=="admin"||!id.test(orderId))throw notFound();
  const binding=await readLegacyContinuationBinding(client,orderId);
  const readAccess=await authorizeLegacyContinuation(client,actor,binding);
  if(!readAccess.canOperate)throw notFound();
  const admin=await lockActor(client,actor.userId);
  if(admin.passwordChangeRequired)throw new SecurityApiError(403,"FORBIDDEN","Password change required");
  await assertAdminCommandAuthorizedInTransaction(client,actor);
  requirePermission(admin,"order.settlement.write");
  return binding;
}

/** Caller provides an idempotent transaction. This records an attestation, not a refund or channel fact. */
export async function recordLegacyRefundReview(client:PoolClient,actor:LegacyContinuationActor,
  command:LegacyRefundReviewCommand,execution:{admission:FormalRefundAdmission;profile:BoundRefundProfile}) {
  if(!actor||actor.realm!=="admin"||!command||![command.orderId,command.dutyId,actor.requestId].every(value=>typeof value==="string"&&id.test(value))
    || typeof command.expectedDutyRevision!=="string"||!/^[1-9]\d{0,18}$/.test(command.expectedDutyRevision)
    || typeof command.expectedHeadRevision!=="string"||!/^[1-9]\d{0,18}$/.test(command.expectedHeadRevision)
    || typeof command.paymentOrderNo!=="string"||!/^[A-Za-z0-9_-]{1,50}$/.test(command.paymentOrderNo)
    || typeof command.confirmedMerchantNo!=="string"||!/^\d{1,15}$/.test(command.confirmedMerchantNo))throw invalid("Invalid legacy refund review");
  const admission=assertFormalRefundProfile(execution.admission,execution.profile,"SUBMIT"),profile=describeRefundProfile(execution.profile,"SUBMIT");
  await assertRefundResource(client,execution.admission);
  if(command.confirmedMerchantNo!==profile.merchantNo || admission.merchantIdentityId!==profile.merchantIdentityId) throw conflict("ORIGINAL_PAYMENT_MISMATCH");
  await authorizeLegacyRefundReviewAccess(client,actor,command.orderId);
  const preEvidence=await readLegacyContinuationEvidence(client,command.orderId,null);
  if(!preEvidence)throw conflict("LEGACY_PAYMENT_SOURCE_UNAVAILABLE");
  const paid=readSealedLegacyFacts(preEvidence).evidence.source.paidPay;
  if(!Array.isArray(paid)||paid.length!==1||typeof paid[0]?.payOrderSn!=="string"||paid[0].payOrderSn!==command.paymentOrderNo)
    throw conflict("LEGACY_PAYMENT_SOURCE_UNAVAILABLE");
  // Match admin refund commands: lock the administrator before the shared payment key.
  const caseId='legacy_refund_case_'+createHash('sha256').update(command.dutyId).digest('hex').slice(0,40);
  const refundNo='LR'+createHash('sha256').update(caseId).digest('hex').slice(0,28);
  await lockRefundOrderNos(client,profile.merchantIdentityId,[command.paymentOrderNo,refundNo]);
  const authority=await authorizeLegacyMutation(client,actor,command.orderId);
  if(!(await client.query(`SELECT id FROM zzsh_supply.rental_account WHERE id=$1 FOR SHARE`,[authority.binding.accountId])).rowCount)throw conflict("LEGACY_REFUND_ACCOUNT_UNAVAILABLE");
  const locked=await lockLegacyContinuationOrder(client,command.orderId);
  const duty=locked.duties.find(value=>value.id===command.dutyId);
  if(!duty || locked.head?.revision!==command.expectedHeadRevision || duty.revision!==command.expectedDutyRevision)throw conflict("LEGACY_REFUND_REVIEW_CHANGED");
  const source=await readLockedLegacyRefundSource(client,authority.binding,locked.head,duty);
  if(source.paymentOrderNo!==command.paymentOrderNo)throw conflict("LEGACY_PAYMENT_SOURCE_MISMATCH");
  if(await hasNativeOriginalOrderNo(client,source.paymentOrderNo))throw conflict("ORIGINAL_PAYMENT_CONFLICT");
  const clock=(await client.query<{now:string}>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`)).rows[0];
  if(!clock?.now)throw conflict("LEGACY_REFUND_CLOCK_UNAVAILABLE");
  const schema=(await client.query<{casePresent:boolean;intentPresent:boolean}>(`SELECT to_regclass('zzsh_order.legacy_refund_case') IS NOT NULL AS "casePresent",
    to_regclass('zzsh_order.legacy_refund_intent') IS NOT NULL AS "intentPresent"`)).rows[0];
  if(typeof schema?.casePresent!=="boolean" || typeof schema.intentPresent!=="boolean" || schema.casePresent!==schema.intentPresent)throw conflict("LEGACY_REFUND_INTENT_STATE_UNKNOWN");
  const legacyIntentExists=schema.casePresent?(await client.query<{found:boolean}>(`SELECT EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_case
    WHERE original_payment_order_no=$1) AS found`,[source.paymentOrderNo])).rows[0]?.found:false;
  if(typeof legacyIntentExists!=="boolean")throw conflict("LEGACY_REFUND_INTENT_STATE_UNKNOWN");
  const assessment=reviewLegacyRefund({...source,merchantIdentityId:profile.merchantIdentityId,originalIntentExists:legacyIntentExists},
    {paymentOrderNo:command.paymentOrderNo,merchantIdentityId:profile.merchantIdentityId,paidCents:command.paidCents,
      previouslyRefundedCents:command.previouslyRefundedCents,priorAppliedToDutyCents:command.priorAppliedToDutyCents,
      noUnresolvedRefunds:command.noUnresolvedRefunds,evidenceRef:command.evidenceRef},clock.now);
  if(!assessment.ok)throw conflict(assessment.reason);
  const reviewId=`legacy_refund_review_${randomUUID().replaceAll("-","")}`;
  const facts={schema:"legacy-refund-review.v1",reviewId,orderId:source.orderId,dutyId:duty.id,headId:locked.head!.id,headRevision:locked.head!.revision,dutyRevision:duty.revision,
    sourceDigest:source.sourceDigest,dutyEvidenceDigest:source.dutyEvidenceDigest,paymentRecordId:source.paymentRecordId,paymentOrderNo:source.paymentOrderNo,
    merchantIdentityId:profile.merchantIdentityId,merchantNo:profile.merchantNo,profileId:profile.profileId,profileSha256:profile.profileSha256,
    keyVersionRef:profile.keyVersionRef,notifyUrl:profile.notifyUrl,fundsAccount:profile.fundsAccount??null,profileCanonical:readRefundProfileEvidence(execution.profile),
    admissionRef:admission.reference,admissionSha256:admission.sha256,admissionCanonical:admission.canonical,
    paidCents:source.paidCents,dutyCents:source.dutyCents,previouslyRefundedCents:command.previouslyRefundedCents,
    priorAppliedToDutyCents:command.priorAppliedToDutyCents,noUnresolvedRefunds:true,refundCents:assessment.refundCents,
    remainingPaymentCents:assessment.remainingPaymentCents,reviewFingerprint:assessment.fingerprint,reviewedAt:clock.now,
    reviewerId:actor.userId,reviewerSessionId:actor.sessionId,requestId:actor.requestId,evidenceRef:command.evidenceRef.trim(),
    source:"STAFF_REVIEW",merchantProfileUse:"IDENTITY_ONLY",channelResult:"NOT_SUBMITTED"};
  const reviewDigest=createHash("sha256").update(canonicalize(facts)).digest("hex");
  await recordAudit(client,{actorType:"admin",actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,
    action:"order.legacy.refund.reviewed",objectType:"legacy_order_duty",objectId:duty.id,outcome:"SUCCESS",reason:command.evidenceRef.trim(),
    details:{...facts,reviewDigest}});
  return {reviewId,orderId:source.orderId,dutyId:duty.id,refundCents:assessment.refundCents,remainingPaymentCents:assessment.remainingPaymentCents,
    kind:assessment.kind,reviewDigest,reviewedAt:clock.now,channelResult:"NOT_SUBMITTED" as const};
}

/** The audit read is an attestation only; a refund executor must recheck the live source and budget. */
export async function readLegacyRefundReview(client:PoolClient,actor:LegacyContinuationActor,orderId:string,dutyId:string,reviewId:string):Promise<Record<string,unknown>&{reviewDigest:string}> {
  if(!actor||actor.realm!=="admin"||![orderId,dutyId,reviewId].every(value=>typeof value==="string"&&id.test(value)))throw invalid("Invalid legacy refund review reference");
  const binding=await readLegacyContinuationBinding(client,orderId),access=await authorizeLegacyContinuation(client,actor,binding);
  if(!access.canOperate)throw notFound();
  requirePermission(await loadEffectiveAdminAccess(client,actor.userId),"order.settlement.write");
  return readLegacyRefundReviewEvidence(client,orderId,dutyId,reviewId);
}

/** Internal worker read; the public administrator read must authorize before calling it. */
export async function readLegacyRefundReviewEvidence(client:PoolClient,orderId:string,dutyId:string,reviewId:string):Promise<Record<string,unknown>&{reviewDigest:string}> {
  if(![orderId,dutyId,reviewId].every(value=>typeof value==="string"&&id.test(value)))throw invalid("Invalid legacy refund review reference");
  const rows=(await client.query<{actor_type:string;actor_id:string;session_id:string;request_id:string;reason:string;outcome:string;details:unknown}>(`SELECT actor_type,actor_id,session_id,request_id,reason,outcome,details
    FROM zzsh_iam.audit_event WHERE action='order.legacy.refund.reviewed' AND object_type='legacy_order_duty'
      AND object_id=$1 AND outcome='SUCCESS' AND details->>'reviewId'=$2 AND details->>'orderId'=$3 ORDER BY occurred_at,id LIMIT 2`,[dutyId,reviewId,orderId])).rows;
  if(rows.length!==1)throw notFound();
  const row=rows[0]!,data=row.details;
  if(!data||typeof data!=="object"||Array.isArray(data))throw conflict("LEGACY_REFUND_REVIEW_INVALID");
  const {reviewDigest,...facts}=data as Record<string,unknown>;
  if(typeof reviewDigest!=="string"||!/^[a-f0-9]{64}$/.test(reviewDigest)||createHash("sha256").update(canonicalize(facts)).digest("hex")!==reviewDigest
    ||facts.schema!=="legacy-refund-review.v1"||facts.reviewId!==reviewId||facts.orderId!==orderId||facts.dutyId!==dutyId
    ||facts.reviewerId!==row.actor_id||facts.reviewerSessionId!==row.session_id||facts.requestId!==row.request_id
    ||facts.evidenceRef!==row.reason||row.actor_type!=="admin"||row.outcome!=="SUCCESS"||facts.source!=="STAFF_REVIEW"||facts.merchantProfileUse!=="IDENTITY_ONLY"||facts.channelResult!=="NOT_SUBMITTED")
    throw conflict("LEGACY_REFUND_REVIEW_INVALID");
  return {...facts,reviewDigest};
}
