import type { AuthSecurityOptions } from "../auth/auth-security";
import { readAdminContext } from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { SecurityApiError, withTransaction } from "../auth/security-core";
import { ensureApiV1RequestId, validateIdempotencyKey } from "../contracts/api-v1";
import { bodyOf, ensureOnlyFields, fingerprintRequest, headerValue, invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { decodeId, requireOrigin, requestPath, runIdempotentWrite, type SupplyResponse } from "../supply/supply-routes";
import { authorizeLegacyContinuation, readLegacyContinuation, readLegacyContinuationBinding, readLegacyContinuationDuties, readLegacyContinuationEvidence, readLegacyContinuationHead } from "./legacy-continuation-evidence";
import { applyLegacyContinuationCommand, applyLegacyDutyCommand, authorizeLegacyMutation, legacyCommandOutcome, parseLegacyMutation, parseLegacyQuantities, type LegacyMutationKind,type LegacyMutationAuthority } from "./legacy-continuation-command";
import { legacyOrderAdvisoryKey, legacyPlanYuanToCents, previewLegacyContinuation, projectLegacyCommandReceipt, readSealedLegacyFacts, visibleLegacyReason, type LegacyContinuationActor, type LegacyDutyFinalizationReader } from "./legacy-continuation-model";
import { authorizeLegacyFinanceDuty, postLegacyFinanceDuty, postLegacyOwnerCreditOnConfirmation, projectLegacyFinanceDutyReceipt, type LegacyFinanceDutyAuthority, type LegacyFinanceDutyKind } from "./legacy-finance-duty";
import {authorizeLegacyRefundReviewAccess} from './legacy-refund-review-store';
import {hasLegacyRecordedRefunds,readHistoricalOriginalPayment} from './legacy-refund-review-source';
import {createLegacyRefundCase,readLegacyRefundCaseForStatus,readLegacyRefundCaseReceipt} from './legacy-refund-case-command';
import {describeRefundProfile,RefundProfileError,type BoundRefundProfile} from './joinpay-refund-profile';
import type {RefundSourceOptions} from './joinpay-refund-source';
import {readLegacyRefundProgress} from './legacy-refund-attempt';
import {readDemoLegacyRefund,readDemoLegacyRefundReadiness,simulateLegacyRefund} from './ecs-demo-legacy-refund';
import {allocateLegacySupportCancelRefundInTransaction} from './legacy-support-cancel-refund';
import type {DemoFinanceResource} from '../finance/ecs-test-demo-resource';

export type LegacyContinuationRouteOptions = AuthSecurityOptions & { legacyDutyFinalizationReader?: LegacyDutyFinalizationReader;
  legacyRefund?:RefundSourceOptions & {legacyRefundsEnabled?:boolean;legacyInitialProfile?:BoundRefundProfile};ecsTestDemo?:DemoFinanceResource;localFinancialSandbox?:unknown };
export function parseLegacyContinuationPath(path: string) {
  const match = /^\/legacy\/([^/]+)\/continuation(?:\/(receipt|preview|propose|confirm|reject|hold|release|confiscate|support-cancel)|\/duties\/([^/]+)\/(mature|void|owner-credit|commission-credit|refund-case|demo-refund))?$/.exec(path);
  if (!match) return null;
  const orderId = decodeId(match[1]!); legacyOrderAdvisoryKey(orderId);
  const dutyId = match[3] ? decodeId(match[3]) : null;
  return { orderId, command: match[2] ?? null, dutyId, dutyCommand: match[4] as "mature" | "void" | "owner-credit" | "commission-credit" | "refund-case" | "demo-refund" | undefined };
}
export async function handleLegacyContinuationRoute(request: SupplyNodeRequest, response: SupplyResponse, options: LegacyContinuationRouteOptions, realm: "user" | "admin"): Promise<boolean> {
  const prefix = realm === "user" ? "/api/v1/orders" : "/api/v1/admin/orders";
  const { path, query } = requestPath(request, prefix), parsed = parseLegacyContinuationPath(path);
  if (!parsed) return false;
  const method = (request.method ?? "GET").toUpperCase(), requestId = ensureApiV1RequestId(request);
  if ((parsed.command !== "receipt" && query.size) || (parsed.dutyCommand==='refund-case'||parsed.dutyCommand==='demo-refund'
    ? !['GET','POST'].includes(method) : method !== (parsed.command && parsed.command !== "receipt" || parsed.dutyId ? "POST" : "GET"))) throw notFound();
  if (method !== "GET" && !requireOrigin(request, response, options, requestId)) return true;
  const context = realm === "user" ? await readUserContext(request, options) : await readAdminContext(request, options);
  const actor: LegacyContinuationActor = { realm, ...context, requestId };
  if(method==='GET' && parsed.dutyId && parsed.dutyCommand==='demo-refund'){
    if(realm!=='admin'||!options.ecsTestDemo)throw notFound();
    const demo=options.ecsTestDemo;
    const result=await withTransaction(options.pool,client=>readDemoLegacyRefundReadiness(client,actor,parsed.orderId,parsed.dutyId!,demo));
    sendJson(response,200,result,requestId);return true;
  }
  if(method==='GET' && parsed.dutyId && parsed.dutyCommand==='refund-case'){
    if(realm!=='admin')throw notFound();
    const data=await withTransaction(options.pool,async client=>{
      const binding=await authorizeLegacyRefundReviewAccess(client,actor,parsed.orderId);
      const head=await readLegacyContinuationHead(client,parsed.orderId),duty=(await readLegacyContinuationDuties(client,parsed.orderId)).find(item=>item.id===parsed.dutyId);
      if(!duty||duty.kind!=='RENTER_REFUND')throw notFound();
      const imported=await readLegacyContinuationEvidence(client,parsed.orderId,null),facts=imported?readSealedLegacyFacts(imported):null;
      const source=facts?.evidence.source,payments=source?.paidPay;
      let paymentOrderNo:string|null=null;
      if((facts?.evidence.admission==='PARAMETER_COMPLETE' || head?.command==='SUPPORT_CANCEL') && Array.isArray(payments) && payments.length===1 && typeof payments[0]?.payOrderSn==='string'
        && /^[A-Za-z0-9_-]{1,50}$/.test(payments[0].payOrderSn) && typeof payments[0].payMoney==='string' && typeof binding.paidCents==='string'){
        try{if(legacyPlanYuanToCents(payments[0].payMoney)===binding.paidCents)paymentOrderNo=payments[0].payOrderSn;}catch{/* Missing original must stay unknown. */}
      }
      const historical=!head && binding.sourceOrderStatus===4 && duty.source==='LEGACY_IMPORT' && ['COMPLETED_UNREFUNDED','DETAINED'].includes(duty.sourceStatus??'');
      if(historical){try{paymentOrderNo=(await readHistoricalOriginalPayment(client,binding)).paymentOrderNo;}catch(error){if(!(error instanceof SecurityApiError) || error.status!==409)throw error;}}
      const table=(await client.query<{available:boolean}>(`SELECT to_regclass('zzsh_order.legacy_refund_case') IS NOT NULL AS available`)).rows[0];
      if(typeof table?.available!=='boolean')throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Legacy refund unavailable');
      const cases=table.available?(await client.query<{id:string}>(`SELECT id FROM zzsh_order.legacy_refund_case WHERE order_id=$1 AND duty_id=$2 LIMIT 2`,[parsed.orderId,parsed.dutyId])).rows:[];
      if(cases.length>1)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Legacy refund unavailable');
      const receipt=cases[0]?await readLegacyRefundCaseReceipt(client,actor,parsed.orderId,parsed.dutyId!,cases[0].id):null;
      const current=cases[0]?await readLegacyRefundCaseForStatus(client,parsed.orderId,parsed.dutyId!,cases[0].id):null;
      const execution=options.legacyRefund;
      const progress=current?.intentId && execution ? await readLegacyRefundProgress(client,{...execution,pool:options.pool,legacyRefundsEnabled:execution.legacyRefundsEnabled===true},current.intentId) : null;
      const configured=!!execution?.legacyRefundsEnabled && !!execution.legacyInitialProfile;
      const merchantNo=configured?describeRefundProfile(execution!.legacyInitialProfile!,'SUBMIT').merchantNo:null;
      const refundRows=(await client.query<{number:string|null;amount:string|null;at:Date|null}>(`SELECT snapshot->>'sourceNumber' AS number,
        snapshot->>'amount' AS amount,source_event_at AS at FROM zzsh_order.personal_finance_observation
        WHERE user_id=$1 AND source_kind='HISTORICAL_REFUND' AND source_system='legacy_mysql_restore' AND source_entity='la_refund_record'
          AND snapshot->>'referenceType'='LEGACY_ORDER' AND snapshot->>'referenceId'=$2
        ORDER BY source_event_at DESC NULLS LAST,id DESC LIMIT 21`,[binding.renterUserId,binding.legacyId])).rows;
      const historicalRefunds=refundRows.slice(0,20).map(row=>{
        let amountCents:string|null=null;try{if(row.amount!==null)amountCents=legacyPlanYuanToCents(row.amount);}catch{/* Keep an unreadable source amount unknown. */}
        return {number:typeof row.number==='string'&&row.number.length<=128?row.number:null,amountCents,
          at:row.at instanceof Date && Number.isFinite(row.at.getTime())?row.at.toISOString():null};
      });
      const refundDueAt=historical?null:head?.refundDueAt??null;
      const due=refundDueAt ? (await client.query<{due:boolean}>('SELECT $1::timestamptz<=clock_timestamp() AS due',[refundDueAt])).rows[0]?.due===true:false;
      return {orderId:parsed.orderId,dutyId:parsed.dutyId,headRevision:head?.revision??(historical?'0':null),dutyRevision:duty.revision,dutyCents:duty.amountCents,
        paidCents:binding.paidCents,paymentOrderNo,merchantNo,refundDueAt,historicalWaitUncertain:historical,historicalHeld:historical && duty.sourceStatus==='DETAINED',
        historicalRefunds,historicalRefundsMore:refundRows.length>20,receipt,current,progress,
        canStart:table.available && configured && !!paymentOrderNo && !!binding.paidCents && !receipt
          && (historical?!!binding.completedAt:due && (String(head?.stage)==='4' || String(head?.stage)==='5' && head?.command==='SUPPORT_CANCEL')) && ['PENDING','MATURED'].includes(duty.status)};
    });
    sendJson(response,200,data,requestId);return true;
  }
  if (parsed.command === "receipt") {
    for (const key of query.keys()) if (!["key", "command", "dutyId"].includes(key) || query.getAll(key).length !== 1) throw invalid("Invalid receipt query");
    const key = validateIdempotencyKey(query.get("key") ?? undefined), command = query.get("command") ?? "", dutyId = query.get("dutyId");
    if (!["propose", "confirm", "reject", "hold", "release", "confiscate", "support_cancel", "mature", "void", "owner-credit", "commission-credit", "refund-case","demo-refund"].includes(command)) throw invalid("Invalid original command");
    if (realm === "user" && ["hold", "release", "confiscate", "support_cancel", "mature", "void", "owner-credit", "commission-credit", "refund-case","demo-refund"].includes(command)) throw notFound();
    const refundCase=command==='refund-case',demoRefund=command==='demo-refund';
    if(demoRefund&&!options.ecsTestDemo)throw notFound();
    const walletKind:LegacyFinanceDutyKind|null=command==="owner-credit"?"OWNER_CREDIT":command==="commission-credit"?"COMMISSION":null;
    const duty = command === "mature" || command === "void" || walletKind!==null || refundCase || demoRefund;
    if (duty ? realm !== "admin" || !dutyId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(dutyId) : dutyId !== null) throw invalid("Invalid original duty");
    const data = await withTransaction(options.pool, async client => {
      const authority = refundCase ? null : walletKind || demoRefund || realm==="admin" && ["confirm","support_cancel"].includes(command) ? await authorizeLegacyFinanceDuty(client,actor,parsed.orderId,demoRefund?'RENTER_REFUND':walletKind??"OWNER_CREDIT",true) : await authorizeLegacyMutation(client, actor, parsed.orderId,true);
      if(refundCase)await authorizeLegacyRefundReviewAccess(client,actor,parsed.orderId);
      if (duty && !(await client.query(`SELECT 1 FROM zzsh_order.legacy_order_duty WHERE id=$1 AND order_id=$2`, [dutyId, parsed.orderId])).rowCount) throw notFound();
      const operation = duty ? "order.legacy.duty." + command : "order.legacy.continuation." + command;
      const row = (await client.query<{ status: number; body: unknown; fingerprint: string }>(`SELECT response_status AS status,response_body AS body,request_fingerprint AS fingerprint FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2`, [JSON.stringify([realm, actor.userId, operation, duty ? dutyId : parsed.orderId]), key])).rows[0];
      let receipt:unknown=null;
      if(row && demoRefund && row.status>=200 && row.status<300){
        if(!dutyId||!options.ecsTestDemo)throw invalid('Demo refund receipt unavailable');
        receipt=await readDemoLegacyRefund(client,parsed.orderId,dutyId,options.ecsTestDemo);if(!receipt)throw invalid('Demo refund receipt unavailable');
      }else if(row && refundCase && row.status>=200 && row.status<300){
        const caseId=(row.body as {caseId?:unknown})?.caseId;
        if(typeof caseId!=='string' || !dutyId)throw invalid('Legacy refund receipt unavailable');
        receipt=await readLegacyRefundCaseReceipt(client,actor,parsed.orderId,dutyId,caseId);
      }else if(row && walletKind && row.status>=200 && row.status<300)receipt=await projectLegacyFinanceDutyReceipt(client,parsed.orderId,walletKind,row.body);
      else if(row && authority)receipt=projectLegacyCommandReceipt(authority.binding,actor,row.body);
      else if(row)receipt=row.body;
      return row ? { state: row.status >= 200 && row.status < 300 ? "KNOWN_SUCCESS" : "KNOWN_REJECTED", status: row.status, receipt, fingerprint: row.fingerprint } : { state: "UNKNOWN" };
    });
    sendJson(response, 200, data, requestId); return true;
  }
  if (method === "GET") {
    const data = await withTransaction(options.pool, async client => {
      const data=await readLegacyContinuation(client,actor,parsed.orderId,options.legacyDutyFinalizationReader);
      if(data.continuation.stage==='5' && data.continuation.duties.some(d=>['RENTER_REFUND','OWNER_CREDIT'].includes(d.kind) && d.status==='PENDING')){
        await client.query('SAVEPOINT legacy_cancel_history_read');let needsReview=true;
        try { const binding=await readLegacyContinuationBinding(client,parsed.orderId),head=await readLegacyContinuationHead(client,parsed.orderId);
          needsReview=await hasLegacyRecordedRefunds(client,binding,head?.id??null);await client.query('RELEASE SAVEPOINT legacy_cancel_history_read');
        } catch { await client.query('ROLLBACK TO SAVEPOINT legacy_cancel_history_read');await client.query('RELEASE SAVEPOINT legacy_cancel_history_read'); }
        if(needsReview && !data.continuation.reasons.includes('REFUND_HISTORY_REQUIRES_OFFLINE'))data.continuation.reasons.push('REFUND_HISTORY_REQUIRES_OFFLINE');
      }
      if(realm!=='user')return data;
      const duties=data.continuation.duties.filter(d=>d.kind==='RENTER_REFUND' && d.status==='SETTLED' && d.settledBy==='FINANCE');
      if(!duties.length)return data;
      const ready=(await client.query<{ready:boolean}>(`SELECT to_regclass('zzsh_order.legacy_refund_case') IS NOT NULL AS ready`)).rows[0]?.ready;
      if(ready!==true)return data;
      const mapped=new Map<string,{status:string;simulationScope?:string}>();
      for(const duty of duties){
        if(options.ecsTestDemo){
          const demo=await readDemoLegacyRefund(client,parsed.orderId,duty.id,options.ecsTestDemo);
          if(demo){mapped.set(duty.id,{status:'SIMULATED',simulationScope:demo.scope});continue;}
        }
        const cases=(await client.query<{id:string}>(`SELECT id FROM zzsh_order.legacy_refund_case WHERE order_id=$1 AND duty_id=$2 LIMIT 2`,[parsed.orderId,duty.id])).rows;
        if(cases.length!==1)continue;
        await client.query('SAVEPOINT legacy_refund_user_read');
        try{
          const record=await readLegacyRefundCaseForStatus(client,parsed.orderId,duty.id,cases[0]!.id);
          let status='UNKNOWN';
          if(!record.intentId && record.amountCents==='0')status=record.dutyCents==='0'?'NO_REFUND_DUE':'NO_NEW_REFUND';
          else if(record.intentId && options.legacyRefund){
            const progress=await readLegacyRefundProgress(client,{...options.legacyRefund,pool:options.pool,legacyRefundsEnabled:options.legacyRefund.legacyRefundsEnabled===true},record.intentId);
            status=progress.state==='REVIEW_REQUIRED'?'REVIEW_REQUIRED':progress.terminal==='SUCCEEDED'?'CHANNEL_SUCCEEDED'
              :progress.terminal==='FAILED_NO_EXECUTION'?'FAILED':['READY','SUBMITTING','PROCESSING'].includes(progress.state)?'PROCESSING':'UNKNOWN';
          }
          mapped.set(duty.id,{status});await client.query('RELEASE SAVEPOINT legacy_refund_user_read');
        }catch(error){
          await client.query('ROLLBACK TO SAVEPOINT legacy_refund_user_read');await client.query('RELEASE SAVEPOINT legacy_refund_user_read');
          if(!(error instanceof RefundProfileError) && (!(error instanceof SecurityApiError) || ![404,409,503].includes(error.status)))throw error;
        }
      }
      return {...data,continuation:{...data.continuation,duties:data.continuation.duties.map(d=>{
        const status=mapped.get(d.id);return status?{...d,refundProgress:status.status,...(status.simulationScope?{refundSimulationScope:status.simulationScope}:{})}:d;
      })}};
    });
    sendJson(response, 200, data, requestId); return true;
  }
  const body = bodyOf(request);
  if (parsed.command === "preview") {
    ensureOnlyFields(body, ["quantities", "onBehalf"]);
    if (body.onBehalf !== undefined && body.onBehalf !== "renter" && body.onBehalf !== "owner") throw invalid("STAFF_ROLE_INVALID");
    const quantities = parseLegacyQuantities(body.quantities);
    let data;
    try { data = await withTransaction(options.pool, async client => {
      const binding = await readLegacyContinuationBinding(client, parsed.orderId);
      const access = await authorizeLegacyContinuation(client, actor, binding);
      if (realm === "admin" && !access.canOperate) throw notFound();
      const head = await readLegacyContinuationHead(client, parsed.orderId), row = await readLegacyContinuationEvidence(client, parsed.orderId, head);
      if (!row) throw invalid("NOT_IMPORTED");
      return { ...previewLegacyContinuation(readSealedLegacyFacts(row), binding, actor, quantities, body.onBehalf as "renter" | "owner" | undefined), revision: head?.revision ?? null, inputEvidenceId: row.id };
    }); } catch (error) {
      const reason = error instanceof SecurityApiError && error.status === 409 ? visibleLegacyReason(error.message) : undefined;
      if (!reason || !(error instanceof SecurityApiError)) throw error;
      sendJson(response, error.status, { error: { code: error.code, message: reason, reason, requestId } }, requestId); return true;
    }
    sendJson(response, 200, data, requestId); return true;
  }
  if (parsed.dutyId && parsed.dutyCommand) {
    if (realm !== "admin") throw notFound();
    if(parsed.dutyCommand==='demo-refund'){
      if(!options.ecsTestDemo)throw notFound();
      ensureOnlyFields(body,['expectedDutyRevision','expectedHeadRevision','assumption','reason']);
      if(typeof body.expectedDutyRevision!=='string'||!/^[1-9]\d{0,17}$/.test(body.expectedDutyRevision)
        || typeof body.expectedHeadRevision!=='string'||!/^[1-9]\d{0,17}$/.test(body.expectedHeadRevision)
        || body.assumption!=='SIMULATION_ASSUME_NO_PRIOR_REFUND'||typeof body.reason!=='string')throw invalid('Invalid demo refund request');
      const input={dutyId:parsed.dutyId,expectedDutyRevision:body.expectedDutyRevision,expectedHeadRevision:body.expectedHeadRevision,
        assumption:'SIMULATION_ASSUME_NO_PRIOR_REFUND' as const,reason:body.reason};
      const demo=options.ecsTestDemo;let authority:LegacyFinanceDutyAuthority|undefined;
      await runIdempotentWrite(options,request,response,requestId,{principalId:actor.userId,operation:'order.legacy.duty.demo-refund',resourceId:input.dutyId},
        {realm,id:actor.userId,sessionId:actor.sessionId},input,
        async(client,replay)=>{authority=await authorizeLegacyFinanceDuty(client,actor,parsed.orderId,'RENTER_REFUND',!!replay);},
        client=>legacyCommandOutcome(client,actor,parsed.orderId,()=>simulateLegacyRefund(client,actor,parsed.orderId,input,authority!,demo)),
        async(client,result)=>{if(result.status<200||result.status>=300)return result;const receipt=await readDemoLegacyRefund(client,parsed.orderId,input.dutyId,demo);
          if(!receipt)throw invalid('Demo refund receipt unavailable');return {...result,body:receipt};});
      return true;
    }
    if(parsed.dutyCommand==='refund-case'){
      ensureOnlyFields(body,['expectedDutyRevision','expectedHeadRevision','paymentOrderNo','confirmedMerchantNo','paidCents','previouslyRefundedCents','priorAppliedToDutyCents','noUnresolvedRefunds','evidenceRef','historicalDueVerified','historicalReleaseVerified']);
      const names=['expectedDutyRevision','expectedHeadRevision','paymentOrderNo','confirmedMerchantNo','paidCents','previouslyRefundedCents','priorAppliedToDutyCents','evidenceRef'] as const;
      if(names.some(name=>typeof body[name]!=='string') || typeof body.noUnresolvedRefunds!=='boolean'
        || body.historicalDueVerified!==undefined && typeof body.historicalDueVerified!=='boolean'
        || body.historicalReleaseVerified!==undefined && typeof body.historicalReleaseVerified!=='boolean')throw invalid('Invalid legacy refund review');
      const input={orderId:parsed.orderId,dutyId:parsed.dutyId,expectedDutyRevision:body.expectedDutyRevision as string,expectedHeadRevision:body.expectedHeadRevision as string,
        paymentOrderNo:body.paymentOrderNo as string,confirmedMerchantNo:body.confirmedMerchantNo as string,paidCents:body.paidCents as string,
        previouslyRefundedCents:body.previouslyRefundedCents as string,priorAppliedToDutyCents:body.priorAppliedToDutyCents as string,
        noUnresolvedRefunds:body.noUnresolvedRefunds as boolean,evidenceRef:body.evidenceRef as string,
        ...(typeof body.historicalDueVerified==='boolean'?{historicalDueVerified:body.historicalDueVerified}:{}),
        ...(typeof body.historicalReleaseVerified==='boolean'?{historicalReleaseVerified:body.historicalReleaseVerified}:{})};
      await runIdempotentWrite(options,request,response,requestId,{principalId:actor.userId,operation:'order.legacy.duty.refund-case',resourceId:parsed.dutyId},
        {realm,id:actor.userId,sessionId:actor.sessionId},input,async client=>{await authorizeLegacyRefundReviewAccess(client,actor,parsed.orderId);},
        client=>legacyCommandOutcome(client,actor,parsed.orderId,()=>{
          const execution=options.legacyRefund;
          if(!execution?.legacyRefundsEnabled || !execution.legacyInitialProfile)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Legacy refund unavailable');
          return createLegacyRefundCase(client,actor,input,{admission:execution.admission,profile:execution.legacyInitialProfile});
        }),async(client,result)=>{
          if(result.status<200||result.status>=300)return result;
          const caseId=(result.body as {caseId?:unknown})?.caseId;if(typeof caseId!=='string')throw invalid('Legacy refund receipt unavailable');
          return {...result,body:await readLegacyRefundCaseReceipt(client,actor,parsed.orderId,parsed.dutyId!,caseId)};
        });
      return true;
    }
    if(parsed.dutyCommand==="owner-credit" || parsed.dutyCommand==="commission-credit"){
      ensureOnlyFields(body,["expectedRevision","reason"]);
      if(typeof body.expectedRevision!=="string" || !/^[1-9]\d{0,17}$/.test(body.expectedRevision)
        || typeof body.reason!=="string" || [...body.reason.trim()].length<3 || body.reason.length>500)throw invalid("Invalid owner credit request");
      const input={dutyId:parsed.dutyId,kind:parsed.dutyCommand,expectedRevision:body.expectedRevision,reason:body.reason.trim()};
      const walletKind:LegacyFinanceDutyKind=input.kind==="owner-credit"?"OWNER_CREDIT":"COMMISSION";
      let authority:LegacyFinanceDutyAuthority|undefined;
      await runIdempotentWrite(options,request,response,requestId,{principalId:actor.userId,operation:"order.legacy.duty."+input.kind,resourceId:input.dutyId},
        {realm,id:actor.userId,sessionId:actor.sessionId},input,
        async(client,replay)=>{authority=await authorizeLegacyFinanceDuty(client,actor,parsed.orderId,walletKind,!!replay);},
        client=>legacyCommandOutcome(client,actor,parsed.orderId,()=>postLegacyFinanceDuty(client,actor,parsed.orderId,walletKind,input,authority!)),
        async(client,result)=>result.status>=200&&result.status<300?{...result,body:await projectLegacyFinanceDutyReceipt(client,parsed.orderId,walletKind,result.body)}:result);
      return true;
    }
    ensureOnlyFields(body, ["expectedRevision", "sourceFactAuditId", "reason"]);
    if (typeof body.expectedRevision !== "string" || !/^[1-9]\d{0,17}$/.test(body.expectedRevision)) throw invalid("Invalid duty revision");
    if (body.sourceFactAuditId !== undefined && (typeof body.sourceFactAuditId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.sourceFactAuditId))) throw invalid("Invalid source evidence reference");
    if (body.reason !== undefined && (typeof body.reason !== "string" || !body.reason.trim() || body.reason.length > 500)) throw invalid("Invalid reason");
    const input = { dutyId: parsed.dutyId, kind: parsed.dutyCommand, expectedRevision: body.expectedRevision, sourceFactAuditId: body.sourceFactAuditId as string | undefined, reason: body.reason as string | undefined };
    let authority:LegacyMutationAuthority|undefined;
    await runIdempotentWrite(options, request, response, requestId, { principalId: actor.userId, operation: "order.legacy.duty." + input.kind, resourceId: input.dutyId }, { realm, id: actor.userId, sessionId: actor.sessionId }, input,
      async(client,replay)=>{authority=await authorizeLegacyMutation(client,actor,parsed.orderId,!!replay);}, client => legacyCommandOutcome(client, actor, parsed.orderId, () => applyLegacyDutyCommand(client, actor, parsed.orderId, input,authority)),
      async (_client, result) => { if (!authority) throw invalid("Legacy authorization unavailable"); return { ...result, body: projectLegacyCommandReceipt(authority.binding, actor, result.body) }; });
    return true;
  }
  const input = parseLegacyMutation((parsed.command === "support-cancel" ? "support_cancel" : parsed.command) as LegacyMutationKind, body);
  if(input.kind==="support_cancel" && realm!=="admin")throw notFound();
  const liveRefundReady=options.legacyRefund?.legacyRefundsEnabled===true && !!options.legacyRefund.legacyInitialProfile;
  const cancelScope=options.ecsTestDemo || options.localFinancialSandbox ? "SIMULATED" as const : liveRefundReady ? "OPERATOR" as const : "UNAVAILABLE" as const;
  const execution=input.kind==="support_cancel" && input.refundCents!=="0" && liveRefundReady && options.legacyRefund?.legacyInitialProfile
    ? {admission:options.legacyRefund.admission,profile:options.legacyRefund.legacyInitialProfile} : null;
  const originalKey=execution?validateIdempotencyKey(headerValue(request.headers["idempotency-key"])):null;
  let authority:LegacyMutationAuthority|undefined;
  await runIdempotentWrite(options, request, response, requestId, { principalId: actor.userId, operation: "order.legacy.continuation." + input.kind, resourceId: parsed.orderId }, { realm, id: actor.userId, sessionId: actor.sessionId }, input,
    async(client,replay)=>{authority=realm==="admin" && ["confirm","support_cancel"].includes(input.kind) ? await authorizeLegacyFinanceDuty(client,actor,parsed.orderId,"OWNER_CREDIT",!!replay) : await authorizeLegacyMutation(client,actor,parsed.orderId,!!replay);}, client => legacyCommandOutcome(client, actor, parsed.orderId, () => applyLegacyContinuationCommand(client, actor, parsed.orderId, input, options.legacyDutyFinalizationReader,authority,postLegacyOwnerCreditOnConfirmation,cancelScope)),
    async (client, result) => {
      if (!authority) throw invalid("Legacy authorization unavailable");
      if (result.status>=200 && result.status<300 && execution && originalKey) {
        const allocation=await allocateLegacySupportCancelRefundInTransaction(client,actor,parsed.orderId,originalKey,
          fingerprintRequest("order.legacy.continuation.support_cancel",parsed.orderId,input),execution);
        if(allocation.state==="DEFERRED")console.error("Legacy cancellation refund remains pending; original cancellation is retained");
      }
      return { ...result, body: projectLegacyCommandReceipt(authority.binding, actor, result.body) };
    });
  return true;
}
