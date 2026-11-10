import type {PoolClient} from "pg";
import {recordAudit} from "../auth/security-core";
import {fingerprintRequest,withIdempotency} from "../supply/supply-util";
import {describeRefundProfile,type BoundRefundProfile,type FormalRefundAdmission} from "./joinpay-refund-profile";
import {readLegacyContinuationDuties,readLegacyContinuationEvidence,readLegacyContinuationHead} from "./legacy-continuation-evidence";
import {readSealedLegacyFacts,type LegacyContinuationActor} from "./legacy-continuation-model";
import {authorizeLegacyRefundReviewAccess} from "./legacy-refund-review-store";
import {createLegacyRefundCase} from "./legacy-refund-case-command";
import {hasLegacyRecordedRefunds} from "./legacy-refund-review-source";

/** Prepare an ordinary refund intent from the original cancellation; this never calls the channel. */
export async function allocateLegacySupportCancelRefund(client:PoolClient,actor:LegacyContinuationActor,orderId:string,key:string,
  cancellationFingerprint:string,execution:{admission:FormalRefundAdmission;profile:BoundRefundProfile}) {
  const binding=await authorizeLegacyRefundReviewAccess(client,actor,orderId);
  const scope=JSON.stringify(["admin",actor.userId,"order.legacy.continuation.support_cancel",orderId]);
  const receipt=(await client.query<{status:number;fingerprint:string;body:any}>(`SELECT response_status AS status,request_fingerprint AS fingerprint,response_body AS body
    FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2`,[scope,key])).rows[0];
  if(!receipt || receipt.status<200 || receipt.status>=300 || receipt.fingerprint!==cancellationFingerprint
    || receipt.body?.orderId!==orderId || receipt.body?.command!=="support_cancel" || receipt.body?.stage!=="5" || typeof receipt.body?.versionId!=="string") return {state:"NOT_READY" as const};
  const head=await readLegacyContinuationHead(client,orderId);
  if(!head || head.id!==receipt.body.versionId || head.command!=="SUPPORT_CANCEL" || String(head.stage)!=="5") return {state:"NOT_READY" as const};
  const audited=(await client.query<{n:string}>(`SELECT count(*)::text AS n FROM zzsh_iam.audit_event WHERE action='order.legacy.continuation.support_cancel'
    AND object_type='rental_order' AND object_id=$1 AND actor_type='admin' AND actor_id=$2 AND outcome='SUCCESS'
    AND details->>'versionId'=$3 AND details->>'originalPaymentChecked'='true' AND details->>'paymentReviewScope'='OPERATOR'`,[orderId,actor.userId,head.id])).rows[0]?.n;
  if(audited!=="1")return {state:"NOT_READY" as const};
  if(await hasLegacyRecordedRefunds(client,binding,head.id))return {state:"HISTORY_REQUIRES_OFFLINE" as const};
  const duties=await readLegacyContinuationDuties(client,orderId),refunds=duties.filter(d=>d.kind==="RENTER_REFUND" && d.continuationVersionId===head.id);
  if(refunds.length===0)return {state:"NOT_REQUIRED" as const};
  if(refunds.length!==1)return {state:"NOT_READY" as const};
  const duty=refunds[0]!;
  const existing=(await client.query<{id:string}>(`SELECT id FROM zzsh_order.legacy_refund_case WHERE duty_id=$1`,[duty.id])).rows;
  if(existing.length===1)return {state:"ALREADY_CREATED" as const};
  if(existing.length || duty.status!=="PENDING")return {state:"NOT_READY" as const};
  const source=await readLegacyContinuationEvidence(client,orderId,null),paid=source?readSealedLegacyFacts(source).evidence.source.paidPay:null;
  if(!Array.isArray(paid) || paid.length!==1 || typeof paid[0]?.payOrderSn!=="string" || !binding.paidCents)return {state:"NOT_READY" as const};
  const profile=describeRefundProfile(execution.profile,"SUBMIT"),body={orderId,dutyId:duty.id,expectedDutyRevision:duty.revision,
    expectedHeadRevision:head.revision,paymentOrderNo:paid[0].payOrderSn,confirmedMerchantNo:profile.merchantNo,paidCents:binding.paidCents,
    previouslyRefundedCents:"0",priorAppliedToDutyCents:"0",noUnresolvedRefunds:true,
    evidenceRef:"客服取消时已核对原付款无其他退款；具体原因见取消记录"};
  const operation="order.legacy.support_cancel.refund",requestKey="legacy_cancel_refund_"+head.id;
  const result=await withIdempotency(client,{realm:"admin",principalId:actor.userId,operation,resourceId:duty.id},requestKey,
    fingerprintRequest(operation,duty.id,body),async()=>{await authorizeLegacyRefundReviewAccess(client,actor,orderId);},
    ()=>createLegacyRefundCase(client,actor,body,execution));
  return {state:"CREATED" as const,replayed:result.replayed};
}

/** A failed allocation must not roll back the cancellation or imply that a refund was sent. */
export async function allocateLegacySupportCancelRefundInTransaction(client:PoolClient,actor:LegacyContinuationActor,orderId:string,key:string,
  fingerprint:string,execution:{admission:FormalRefundAdmission;profile:BoundRefundProfile}) {
  await client.query("SAVEPOINT legacy_cancel_refund_allocation");
  let result:Awaited<ReturnType<typeof allocateLegacySupportCancelRefund>>|{state:"DEFERRED"};
  try {
    // Cancellation validates its guards immediately; the refund's linked rows must be built together first.
    await client.query("SET CONSTRAINTS ALL DEFERRED");
    result=await allocateLegacySupportCancelRefund(client,actor,orderId,key,fingerprint,execution);
    await client.query("SET CONSTRAINTS ALL IMMEDIATE");
    await client.query("RELEASE SAVEPOINT legacy_cancel_refund_allocation");
  } catch {
    await client.query("ROLLBACK TO SAVEPOINT legacy_cancel_refund_allocation");
    await client.query("RELEASE SAVEPOINT legacy_cancel_refund_allocation");
    result={state:"DEFERRED"};
  }
  if(["DEFERRED","NOT_READY","HISTORY_REQUIRES_OFFLINE"].includes(result.state)) {
    await client.query("SAVEPOINT legacy_cancel_refund_notice");
    try {
      await recordAudit(client,{actorType:actor.realm,actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,
        action:"order.legacy.refund.allocation_deferred",objectType:"rental_order",objectId:orderId,outcome:"FAILURE",
        reason:result.state,details:{channelResult:"NOT_SUBMITTED"}});
      await client.query("RELEASE SAVEPOINT legacy_cancel_refund_notice");
    } catch {
      await client.query("ROLLBACK TO SAVEPOINT legacy_cancel_refund_notice");
      await client.query("RELEASE SAVEPOINT legacy_cancel_refund_notice");
      console.error("Legacy cancellation refund deferral could not be recorded; refund duty remains pending");
    }
  }
  return result;
}

