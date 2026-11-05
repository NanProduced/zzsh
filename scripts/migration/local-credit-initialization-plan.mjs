import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';

const sha=value=>createHash('sha256').update(value).digest('hex');

/** The original target cohort is frozen before any formal credit batch is approved. */
export function creditRowsDigest(rows){
 assert(Array.isArray(rows),'CREDIT_ROWS_REQUIRED');
 const seen=new Set();let previous='';
 for(const row of rows){
  assert(typeof row.userId==='string'&&row.userId>previous&&!seen.has(row.userId),'CREDIT_COHORT_ORDER_OR_ID_INVALID');
  assert(['ACTIVE','RESTRICTED','CANCELLED','FROZEN','UNKNOWN'].includes(row.category)
   &&['hasCreditState','hasInitializedEvent','hasOtherCreditEvent'].every(key=>typeof row[key]==='boolean'),'CREDIT_COHORT_ROW_INVALID');
  previous=row.userId;seen.add(row.userId);
 }
 return sha(JSON.stringify(rows)+'\n');
}

export function creditCategoryCounts(rows){
 creditRowsDigest(rows);const counts={ACTIVE:0,RESTRICTED:0,CANCELLED:0,FROZEN:0,UNKNOWN:0};
 for(const row of rows)counts[row.category]++;
 return counts;
}

export function assertCreditCohort(rows,expectedIds){
 creditRowsDigest(rows);
 assert(Array.isArray(expectedIds)&&rows.length===expectedIds.length&&rows.every((row,i)=>row.userId===expectedIds[i]),'CREDIT_LEGACY_COHORT_CHANGED');
}

export function assertCreditPlanReady(plan){
 const r=plan?.reconciliation;
 assert(plan?.schema==='zzsh.local-credit-initialization-receipt.v1'&&plan.status==='PREPARED_NOT_APPROVED'&&r?.balanced===true&&r.unknown===0&&r.eventWithoutState===0
  &&plan.otherEventWithoutState===0&&Array.isArray(plan.batches)
  &&Number.isSafeInteger(r.batched)&&r.batched>=0&&r.batched===plan.batches.reduce((n,b)=>n+b.userCount,0)
  &&plan.unlockAck===true&&plan.poolClosed===true&&plan.lockClosed===true,'CREDIT_PLAN_REQUIRES_REVIEW');
}

export function assertCreditAuthority(authority,plan,planSha256,actor,now=Date.now()){
 assertCreditPlanReady(plan);
 assert(authority?.schema==='zzsh.local-credit-authority.v1'&&authority.status==='APPROVED'&&authority.approvedBy==='Root'
  &&authority.planManifestSha256===planSha256&&JSON.stringify(authority.binding)===JSON.stringify(plan.binding)
  &&authority.actor?.adminId===actor.actorId&&authority.actor?.sessionId===actor.sessionId
  &&authority.eligibleCount===plan.reconciliation.batched&&authority.batchCount===plan.batches.length
  &&JSON.stringify(authority.modes)===JSON.stringify(['PREVIEW','APPLY'])
  &&/^[A-Za-z0-9][A-Za-z0-9._:-]{2,127}$/.test(authority.approvalRef??'')&&Number.isSafeInteger(authority.attempt)&&authority.attempt>0,
 'CREDIT_AUTHORITY_BINDING_CHANGED');
 const start=Date.parse(authority.windowStartUtc),end=Date.parse(authority.windowEndUtc);
 const utc=/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?Z$/;
 assert(utc.test(authority.windowStartUtc??'')&&utc.test(authority.windowEndUtc??'')&&Number.isFinite(start)&&Number.isFinite(end)&&start<=now&&now<end&&end-start<=24*60*60*1000,'CREDIT_AUTHORITY_WINDOW_INACTIVE');
}

/** Prior state and events of untouched subjects are compared after all new batches commit. */
export function creditRetainedDigest(rows){
 assert(Array.isArray(rows)&&rows.every(row=>typeof row.row==='string'),'CREDIT_RETAINED_ROWS_INVALID');
 return {count:rows.length,sha256:sha(rows.map(row=>row.row).join('\n'))};
}

/** No retry after an uncertain result: preserve the exact pending key before any batch call. */
export async function executeCreditBatchSequence(packages,hooks,summary){
 const runs=[];
 for(const item of packages){
  const started=performance.now(),startedAt=new Date().toISOString();await hooks.beforeBatch(item);
  for(const mode of ['PREVIEW','APPLY']){
   await hooks.beforeMode(item,mode);const {input,fingerprint}=await hooks.createRun(item,mode);
   summary.pending={mode,batchKey:item.body.batchKey,originalPackage:item.file,packageSha256:item.item.sha256,approvalRef:hooks.approvalRef,attempt:hooks.attempt,fingerprint};
   await hooks.saveSummary(summary);
   if(mode==='PREVIEW'){
    const r=await hooks.preview(input);
    assert(r.fingerprint===fingerprint&&r.outsideApprovedCategory.length===0&&r.alreadyInitialized.length===0&&r.wouldApply.length===item.body.userIds.length,'CREDIT_PREVIEW_DRIFT');
   }else{
    const r=await hooks.apply(input);summary.pending.commitAck=true;
    assert(r.receipt.fingerprint===fingerprint&&!r.replayed&&r.receipt.alreadyInitialized.length===0
     &&JSON.stringify([...r.receipt.applied].sort())===JSON.stringify([...item.body.userIds].sort()),'CREDIT_APPLY_RECEIPT_CHANGED');
    await hooks.saveResult(item,r);runs.push(input);
   }
  }
  summary.batches.push({batchKey:item.body.batchKey,applied:item.body.userIds.length,startedAt,elapsedMs:Math.round(performance.now()-started)});
  delete summary.pending;await hooks.saveSummary(summary);
 }
 return runs;
}
