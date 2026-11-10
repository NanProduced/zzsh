import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { lockActor } from "../auth/admin-directory";
import { assertAdminCommandAuthorizedInTransaction } from "../auth/admin-auth-session";
import { loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import { recordAudit, SecurityApiError, setAuditContext } from "../auth/security-core";
import { readLegacyDutyFundingProof } from "../finance/legacy-duty-funding";
import { legacyDutyBasisFromTrade, planLegacyDutyFinalization } from "../finance/legacy-duty-finance";
import { readAdminLegacyDutyFinances } from "../finance/legacy-duty-finance-store";
import { canonicalize } from "../supply/content-hash";
import { conflict, notFound } from "../supply/supply-util";
import { authorizeLegacyMutation, type LegacyMutationAuthority } from "./legacy-continuation-command";
import { lockLegacyContinuationOrder, readLegacyContinuationBinding, readLegacyContinuationUserIds } from "./legacy-continuation-evidence";
import { readLegacyDutyBasis } from "./legacy-duty-basis";
import { hasLegacyRecordedRefunds } from "./legacy-refund-review-source";
import type { LegacyContinuationActor, LegacyDutyRow } from "./legacy-continuation-model";

export type LegacyFinanceDutyKind="OWNER_CREDIT"|"COMMISSION"|"RENTER_REFUND";
export type LegacyFinanceDutyAuthority=LegacyMutationAuthority & {financeDutyKind:LegacyFinanceDutyKind};
export async function authorizeLegacyFinanceDuty(client:PoolClient,actor:LegacyContinuationActor,orderId:string,kind:LegacyFinanceDutyKind,replay=false) {
  if(actor.realm!=="admin" || !["OWNER_CREDIT","COMMISSION","RENTER_REFUND"].includes(kind))throw notFound();
  const admin=await lockActor(client,actor.userId);
  if(admin.passwordChangeRequired)throw new SecurityApiError(403,"FORBIDDEN","Password change required");
  await assertAdminCommandAuthorizedInTransaction(client,actor);
  const access=await loadEffectiveAdminAccess(client,actor.userId);
  requirePermission(access,"order.settlement.write");
  if(kind==="COMMISSION")requirePermission(access,"finance.document.read");
  return {...await authorizeLegacyMutation(client,actor,orderId,replay),financeDutyKind:kind};
}

async function verifiedReceipt(client:PoolClient,orderId:string,sourceDigest:string,duty:LegacyDutyRow,kind:LegacyFinanceDutyKind) {
  const stored=(await readAdminLegacyDutyFinances(client,{dutyId:duty.id})).get(duty.id);
  if(!stored || stored.orderId!==orderId || stored.kind!==kind || stored.subjectId!==duty.counterpartyUserId
    || stored.knowledge!=="KNOWN" || !["POSTED","FINALIZED_ZERO"].includes(stored.finalization)
    || stored.amountCents!==duty.amountCents || stored.parentSourceDigest!==sourceDigest || !stored.reference)throw conflict("OWNER_CREDIT_RECORD_UNAVAILABLE");
  return {orderId,dutyId:duty.id,revision:duty.revision,status:"SETTLED" as const,settledBy:"FINANCE" as const,
    amountCents:duty.amountCents,reference:stored.reference,channelArrival:"UNKNOWN" as const};
}

async function postDuty(client:PoolClient,actor:LegacyContinuationActor,orderId:string,kind:LegacyFinanceDutyKind,
  input:{dutyId:string;expectedRevision:string;reason:string;originalPaymentChecked?:true},authority:LegacyFinanceDutyAuthority,userConfirmation:boolean) {
  if(!["OWNER_CREDIT","COMMISSION","RENTER_REFUND"].includes(kind) || authority.financeDutyKind!==kind
    || (userConfirmation ? actor.realm!=="user" || kind!=="OWNER_CREDIT" : actor.realm!=="admin")
    || authority.actor.realm!==actor.realm || authority.binding.id!==orderId || authority.actor.userId!==actor.userId
    || authority.actor.sessionId!==actor.sessionId || authority.actor.requestId!==actor.requestId || typeof input.reason!=="string" || [...input.reason.trim()].length<3 || input.reason.length>500)
    throw conflict("OWNER_CREDIT_AUTHORITY_CHANGED");
  if(!(await client.query(`SELECT id FROM zzsh_supply.rental_account WHERE id=$1 FOR SHARE`,[authority.binding.accountId])).rowCount)throw conflict("OWNER_CREDIT_ACCOUNT_UNAVAILABLE");
  const locked=await lockLegacyContinuationOrder(client,orderId),duty=locked.duties.find(item=>item.id===input.dutyId);
  if(canonicalize(await readLegacyContinuationUserIds(client,authority.binding))!==canonicalize(authority.userIds))throw conflict("CONTINUATION_BENEFICIARIES_CHANGED");
  if(!duty || duty.kind!==kind || !duty.counterpartyUserId || kind==="OWNER_CREDIT" && duty.counterpartyUserId!==authority.binding.ownerUserId
    || kind==="RENTER_REFUND" && duty.counterpartyUserId!==authority.binding.renterUserId)throw notFound();
  if(!authority.userIds.includes(duty.counterpartyUserId))throw conflict("CONTINUATION_BENEFICIARIES_CHANGED");
  return postLockedDuty(client,orderId,kind,input,authority.binding,duty,actor);
}

async function postLockedDuty(client:PoolClient,orderId:string,kind:LegacyFinanceDutyKind,
  input:{expectedRevision:string;reason:string;originalPaymentChecked?:true},binding:LegacyMutationAuthority["binding"],duty:LegacyDutyRow,actor?:LegacyContinuationActor) {
  if(duty.status==="SETTLED" && duty.settledBy==="FINANCE")return {status:200,body:await verifiedReceipt(client,orderId,binding.sourceDigest,duty,kind)};
  if(duty.status!==(kind==="COMMISSION"?"MATURED":"PENDING") || duty.revision!==input.expectedRevision)throw conflict("DUTY_REVISION_CONFLICT");
  const available=(await client.query<{ready:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_class c
    ON c.oid=to_regclass('zzsh_order.legacy_duty_finance_fact') WHERE p.oid=to_regprocedure('zzsh_order.post_legacy_finance_duty(text,text,text)')
      AND p.proowner=c.relowner AND p.prosecdef AND p.proconfig=ARRAY['search_path=pg_catalog']
      AND has_function_privilege(current_user,p.oid,'EXECUTE')) AS ready`)).rows[0]?.ready;
  if(available!==true)throw new SecurityApiError(503,"EVIDENCE_UNAVAILABLE","Legacy owner credit is unavailable");
  const raw=await readLegacyDutyBasis(client,orderId,duty),adapted=legacyDutyBasisFromTrade(duty,raw);
  if(kind==="OWNER_CREDIT" && adapted.knowledge==="KNOWN" && adapted.basis.kind==="SUPPORT_CANCELLED_CONTINUATION") {
    let recorded=true, manuallyRechecked=false;
    try {
      const scopes=(await client.query<{scope:string;marker:string|null}>(`SELECT a.details->>'paymentReviewScope' AS scope,
        shobj_description((SELECT oid FROM pg_database WHERE datname=current_database()),'pg_database') AS marker
        FROM zzsh_iam.audit_event a WHERE a.action='order.legacy.continuation.support_cancel' AND a.object_type='rental_order' AND a.object_id=$1
          AND a.actor_type='admin' AND a.outcome='SUCCESS' AND a.details->>'versionId'=$2 AND a.details->>'originalPaymentChecked'='true' LIMIT 2`,[orderId,adapted.basis.continuationVersionId])).rows;
      const scope=scopes.length===1?scopes[0]:null;
      manuallyRechecked=scope?.scope==="UNAVAILABLE" && actor?.realm==="admin" && input.originalPaymentChecked===true;
      if(scope && (scope.scope==="OPERATOR" || scope.scope==="SIMULATED" && ["zzsh:r07-delivery-clone:v1","zzsh:ecs-test:v1"].includes(scope.marker??"") || manuallyRechecked))
        recorded=await hasLegacyRecordedRefunds(client,binding,adapted.basis.continuationVersionId);
    } catch { /* Unknown is handled as an offline case. */ }
    if(recorded)throw conflict("REFUND_HISTORY_REQUIRES_OFFLINE");
    if(manuallyRechecked && actor)await recordAudit(client,{actorType:"admin",actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,
      action:"order.legacy.owner_credit.payment_rechecked",objectType:"legacy_order_duty",objectId:duty.id,outcome:"SUCCESS",reason:input.reason.trim(),
      details:{orderId,continuationVersionId:adapted.basis.continuationVersionId,channelResult:"UNKNOWN"}});
  }
  if(adapted.knowledge!=="KNOWN")throw conflict("WALLET_CREDIT_BASIS_UNAVAILABLE");
  const funding=await readLegacyDutyFundingProof(client,duty,adapted.basis);
  if(funding.knowledge!=="KNOWN")throw conflict("WALLET_CREDIT_HISTORY_UNPROVEN");
  const now=(await client.query<{now:string}>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`)).rows[0]?.now;
  if(!now)throw conflict("OWNER_CREDIT_CLOCK_UNAVAILABLE");
  const plan=planLegacyDutyFinalization(duty,adapted.basis,funding.proof,{dutyId:duty.id,expectedRevision:duty.revision,
    expectedEvidenceDigest:adapted.basis.evidenceDigest,expectedAmountCents:duty.amountCents},now);
  const posted=(await client.query<{result:{dutyId:string;orderId:string;amountCents:string;reference:{digest:string}}}>(
    `SELECT zzsh_order.post_legacy_finance_duty($1,$2,$3) AS result`,[plan.canonical,canonicalize(funding.proof),input.reason.trim()])).rows[0]?.result;
  if(!posted || posted.dutyId!==duty.id || posted.orderId!==orderId || posted.amountCents!==duty.amountCents || posted.reference?.digest!==plan.factDigest)
    throw conflict("OWNER_CREDIT_RECEIPT_MISMATCH");
  const after=(await lockLegacyContinuationOrder(client,orderId)).duties.find(item=>item.id===duty.id);
  if(!after || after.revision!==(BigInt(duty.revision)+1n).toString())throw conflict("OWNER_CREDIT_RECEIPT_MISMATCH");
  return {status:200,body:await verifiedReceipt(client,orderId,binding.sourceDigest,after,kind)};
}

/** Caller owns an idempotent transaction and has locked/rechecked the real administrator. */
export async function postLegacyFinanceDuty(client:PoolClient,actor:LegacyContinuationActor,orderId:string,kind:LegacyFinanceDutyKind,
  input:{dutyId:string;expectedRevision:string;reason:string;originalPaymentChecked?:true},authority:LegacyFinanceDutyAuthority) {
  return postDuty(client,actor,orderId,kind,input,authority,false);
}

/** Called only from the same transaction as a party or authorized support confirmation. */
export async function postLegacyOwnerCreditOnConfirmation(client:PoolClient,actor:LegacyContinuationActor,orderId:string,
  input:{dutyId:string;expectedRevision:string},authority:LegacyMutationAuthority) {
  return postDuty(client,actor,orderId,"OWNER_CREDIT",{...input,reason:actor.realm==="user"?"双方确认后自动入账":"客服确认后自动入账"},{...authority,financeDutyKind:"OWNER_CREDIT"},actor.realm==="user");
}

async function assertCommissionWorkerLock(client:PoolClient){
  const held=(await client.query<{held:boolean}>(`SELECT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
    AND mode='ExclusiveLock' AND granted AND objsubid=1 AND classid='0'::oid AND objid='806007'::oid) AS held`)).rows[0]?.held;
  if(held!==true)throw new SecurityApiError(503,"EVIDENCE_UNAVAILABLE","Distribution worker lock unavailable");
}

/** Runs one due in-flight commission under its original order and beneficiary locks. */
export async function settleLegacyCommissionDueOn(client:PoolClient,orderId:string,dutyId:string) {
  if(!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(dutyId))throw notFound();
  await assertCommissionWorkerLock(client);
  const requestId="legacy-due-"+createHash("sha256").update(dutyId).digest("hex").slice(0,40);
  await setAuditContext(client,"system","legacy-commission-due","system",requestId);
  const binding=await readLegacyContinuationBinding(client,orderId),userIds=await readLegacyContinuationUserIds(client,binding);
  if((await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`,[userIds])).rowCount!==userIds.length
    || !(await client.query(`SELECT id FROM zzsh_supply.game WHERE id=$1 FOR SHARE`,[binding.gameId])).rowCount
    || !(await client.query(`SELECT id FROM zzsh_supply.rental_account WHERE id=$1 FOR SHARE`,[binding.accountId])).rowCount)throw conflict("CONTINUATION_BENEFICIARIES_CHANGED");
  let locked=await lockLegacyContinuationOrder(client,orderId),duty=locked.duties.find(item=>item.id===dutyId);
  if(canonicalize(await readLegacyContinuationUserIds(client,binding))!==canonicalize(userIds))throw conflict("CONTINUATION_BENEFICIARIES_CHANGED");
  if(!duty || duty.kind!=="COMMISSION" || !duty.counterpartyUserId || !userIds.includes(duty.counterpartyUserId)
    || binding.sourcePayStatus!==1 || !([3,8,9].includes(binding.sourceOrderStatus) && duty.continuationVersionId && !duty.admissionId
      || binding.sourceOrderStatus===4 && duty.admissionId && !duty.continuationVersionId))return {outcome:"SKIPPED" as const};
  if(duty.status==="SETTLED" && duty.settledBy==="FINANCE")return {outcome:"ALREADY_POSTED" as const,receipt:await verifiedReceipt(client,orderId,binding.sourceDigest,duty,"COMMISSION")};
  if(duty.status==="SETTLED" || duty.status==="VOID")return {outcome:"SKIPPED" as const};
  let maturedNow=false;
  if(duty.status==="PENDING"){
    const changed=await client.query(`UPDATE zzsh_order.legacy_order_duty SET status='MATURED',revision=revision+1,decided_at=clock_timestamp(),
      decided_by=$3::jsonb,decision_reason='MATURITY_REACHED',decision_evidence_ref=NULL
      WHERE id=$1 AND revision=$2::bigint AND status='PENDING' AND maturity_at<=clock_timestamp() RETURNING id`,
      [dutyId,duty.revision,JSON.stringify({realm:"system",userId:"legacy-commission-due",sessionId:"system",requestId})]);
    if(changed.rowCount!==1)return {outcome:"NOT_DUE" as const};
    await recordAudit(client,{actorType:"system",actorId:"legacy-commission-due",sessionId:"system",requestId,
      action:"order.legacy.commission.matured",objectType:"legacy_order_duty",objectId:dutyId,outcome:"SUCCESS",details:{orderId}});
    maturedNow=true;locked=await lockLegacyContinuationOrder(client,orderId);duty=locked.duties.find(item=>item.id===dutyId);
  }
  if(!duty || duty.status!=="MATURED" || !duty.maturityAt)return {outcome:"SKIPPED" as const};
  const due=(await client.query<{due:boolean}>(`SELECT maturity_at<=clock_timestamp() AS due FROM zzsh_order.legacy_order_duty WHERE id=$1`,[dutyId])).rows[0]?.due;
  if(due!==true)return {outcome:"NOT_DUE" as const};
  await client.query("SAVEPOINT legacy_commission_due_post");
  try {
    const result=await postLockedDuty(client,orderId,"COMMISSION",{expectedRevision:duty.revision,reason:"佣金到期自动入账"},binding,duty);
    await assertCommissionWorkerLock(client);
    await client.query("RELEASE SAVEPOINT legacy_commission_due_post");return {outcome:"POSTED" as const,receipt:result.body};
  } catch(error) {
    await client.query("ROLLBACK TO SAVEPOINT legacy_commission_due_post");await client.query("RELEASE SAVEPOINT legacy_commission_due_post");
    const deferred=error instanceof SecurityApiError && ["WALLET_CREDIT_BASIS_UNAVAILABLE","WALLET_CREDIT_HISTORY_UNPROVEN","Legacy owner credit is unavailable","Legacy funding immutable source witness is inconsistent"].includes(error.message);
    if(!deferred)throw error;
    if(maturedNow)await recordAudit(client,{actorType:"system",actorId:"legacy-commission-due",sessionId:"system",requestId,
      action:"order.legacy.commission.deferred",objectType:"legacy_order_duty",objectId:dutyId,outcome:"FAILURE",reason:"SOURCE_REVIEW_REQUIRED",details:{orderId}});
    await assertCommissionWorkerLock(client);
    return {outcome:"REVIEW_REQUIRED" as const};
  }
}

/** Same-key replay must still point to the original completed ledger record. */
export async function projectLegacyFinanceDutyReceipt(client:PoolClient,orderId:string,kind:LegacyFinanceDutyKind,body:unknown) {
  if(!body || typeof body!=="object" || Array.isArray(body))throw conflict("OWNER_CREDIT_RECEIPT_MISMATCH");
  const receipt=body as {orderId?:unknown;dutyId?:unknown;revision?:unknown;status?:unknown;settledBy?:unknown;amountCents?:unknown;reference?:unknown;channelArrival?:unknown};
  if(receipt.orderId!==orderId || receipt.status!=="SETTLED" || receipt.settledBy!=="FINANCE" || receipt.channelArrival!=="UNKNOWN"
    || typeof receipt.dutyId!=="string" || typeof receipt.revision!=="string")throw conflict("OWNER_CREDIT_RECEIPT_MISMATCH");
  const binding=await readLegacyContinuationBinding(client,orderId),duty=(await lockLegacyContinuationOrder(client,orderId)).duties.find(item=>item.id===receipt.dutyId);
  if(!duty || duty.revision!==receipt.revision || duty.amountCents!==receipt.amountCents)throw conflict("OWNER_CREDIT_RECEIPT_MISMATCH");
  const verified=await verifiedReceipt(client,orderId,binding.sourceDigest,duty,kind);
  if(canonicalize(verified.reference)!==canonicalize(receipt.reference))throw conflict("OWNER_CREDIT_RECEIPT_MISMATCH");
  return verified;
}
