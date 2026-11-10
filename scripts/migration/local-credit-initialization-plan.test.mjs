import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {resolve} from 'node:path';
import {assertCreditAuthority,assertCreditCohort,assertCreditPlanReady,creditCategoryCounts,creditRetainedDigest,creditRowsDigest,executeCreditBatchSequence,guardCreditPoolClient} from './local-credit-initialization-plan.mjs';

const row=(userId,category='ACTIVE',hasCreditState=false,hasInitializedEvent=false,hasOtherCreditEvent=false)=>({userId,category,hasCreditState,hasInitializedEvent,hasOtherCreditEvent});
const digest='a'.repeat(64),actor={actorId:'boss',sessionId:'session'},binding={epoch:{oid:'42',nonce:'b'.repeat(24)},datasetSha256:digest};
const plan=()=>({schema:'zzsh.local-credit-initialization-receipt.v1',status:'PREPARED_NOT_APPROVED',binding,reconciliation:{balanced:true,unknown:0,eventWithoutState:0,batched:2},otherEventWithoutState:0,batches:[{userCount:2}],unlockAck:true,poolClosed:true,lockClosed:true});
const authority=()=>({schema:'zzsh.local-credit-authority.v1',status:'APPROVED',approvedBy:'Root',approvalRef:'round06-credit-approved',attempt:1,planManifestSha256:digest,binding,actor:{adminId:'boss',sessionId:'session'},eligibleCount:2,batchCount:1,modes:['PREVIEW','APPLY'],windowStartUtc:'2026-11-05T00:00:00.000Z',windowEndUtc:'2026-11-05T01:00:00.000Z'});

test('credit entry without a mode is a zero-connection plan',()=>{
 const p=spawnSync(process.execPath,[resolve('scripts/migration/run-local-credit-initialization.mjs')],{encoding:'utf8'});
 assert.equal(p.status,0);assert.deepEqual(JSON.parse(p.stdout),{status:'PLAN_ONLY',modes:['validate','prepare','authorize','execute'],connections:0,credentialReads:0,financialWrites:0});
});

test('credit target guard runs after BEGIN and immediately before COMMIT',async()=>{
 const events=[];let lost=false;
 const client=guardCreditPoolClient({async query(sql){events.push(sql);return {command:sql.startsWith('BEGIN')?'BEGIN':sql};}},
  {afterBegin:async(_client,readOnly)=>events.push(readOnly?'READ_FENCE':'WRITE_FENCE'),beforeCommit:async()=>{events.push('COMMIT_FENCE');if(lost)throw Error('TARGET_FENCE_EPOCH_LOST');}});
 await client.query('BEGIN');await client.query('COMMIT');assert.deepEqual(events,['BEGIN','WRITE_FENCE','COMMIT_FENCE','COMMIT']);
 events.length=0;lost=true;await client.query('BEGIN');await assert.rejects(client.query('COMMIT'),/TARGET_FENCE_EPOCH_LOST/);await client.query('ROLLBACK');
 assert.deepEqual(events,['BEGIN','WRITE_FENCE','COMMIT_FENCE','ROLLBACK']);
});

test('ordered subject cohort detects duplicate, invalid or changed category and evidence',()=>{
 const rows=[row('a'),row('b','FROZEN'),row('c','CANCELLED'),row('d','ACTIVE',true,true)];
 assert.deepEqual(creditCategoryCounts(rows),{ACTIVE:2,RESTRICTED:0,CANCELLED:1,FROZEN:1,UNKNOWN:0});
 assert.doesNotThrow(()=>assertCreditCohort(rows,['a','b','c','d']));
 assert.throws(()=>assertCreditCohort(rows,['a','b','c','e']),/CREDIT_LEGACY_COHORT_CHANGED/);
 assert.equal(creditRowsDigest(rows),creditRowsDigest(structuredClone(rows)));
 assert.notEqual(creditRowsDigest(rows),creditRowsDigest([row('a'),row('b','ACTIVE'),...rows.slice(2)]));
 assert.throws(()=>creditRowsDigest([row('a'),row('a')]),/CREDIT_COHORT_ORDER_OR_ID_INVALID/);
 assert.throws(()=>creditRowsDigest([row('b'),row('a')]),/CREDIT_COHORT_ORDER_OR_ID_INVALID/);
 assert.throws(()=>creditRowsDigest([{...row('a'),category:'OTHER'}]),/CREDIT_COHORT_ROW_INVALID/);
});

test('only balanced, reviewed plans without orphan events and with closed resources can be approved',()=>{
 assert.doesNotThrow(()=>assertCreditPlanReady(plan()));
 for(const changed of [{...plan(),otherEventWithoutState:1},{...plan(),reconciliation:{...plan().reconciliation,unknown:1}},{...plan(),reconciliation:{...plan().reconciliation,eventWithoutState:1}},{...plan(),unlockAck:false},{...plan(),poolClosed:false},{...plan(),batches:[{userCount:1}]}])
  assert.throws(()=>assertCreditPlanReady(changed),/CREDIT_PLAN_REQUIRES_REVIEW/);
 const next={...plan(),binding:{...binding,epoch:{...binding.epoch,migrationProfile:'LOCAL_MIGRATION_NEXT_V1'}}};
 assert.throws(()=>assertCreditPlanReady(next),/CREDIT_PLAN_REQUIRES_REVIEW/);
 assert.doesNotThrow(()=>assertCreditPlanReady({...next,targetFence:'HELD_DURING_CREDIT_STAGE',targetFenceReleased:true}));
});

test('authority binds the exact source, target, actor, batch count and open window',()=>{
 const now=Date.parse('2026-11-05T00:30:00Z');assert.doesNotThrow(()=>assertCreditAuthority(authority(),plan(),digest,actor,now));
 for(const changed of [{...authority(),binding:{...binding,epoch:{...binding.epoch,oid:'43'}}},{...authority(),actor:{adminId:'boss',sessionId:'other'}},{...authority(),eligibleCount:3},{...authority(),modes:['APPLY']},{...authority(),planManifestSha256:'b'.repeat(64)},{...authority(),approvalRef:'a'.repeat(129)}])
  assert.throws(()=>assertCreditAuthority(changed,plan(),digest,actor,now),/CREDIT_AUTHORITY_BINDING_CHANGED/);
 assert.throws(()=>assertCreditAuthority(authority(),plan(),digest,actor,Date.parse('2026-11-05T01:00:00Z')),/CREDIT_AUTHORITY_WINDOW_INACTIVE/);
 assert.throws(()=>assertCreditAuthority({...authority(),windowStartUtc:'2026-11-05 00:00:00Z'},plan(),digest,actor,now),/CREDIT_AUTHORITY_WINDOW_INACTIVE/);
});

test('existing credit states and events are compared without exposing rows',()=>{
 const before=[{row:'{"user_id":"synthetic","score":72}'}],after=structuredClone(before);
 assert.deepEqual(creditRetainedDigest(before),creditRetainedDigest(after));
 assert.notDeepEqual(creditRetainedDigest(before),creditRetainedDigest([{row:'{"user_id":"synthetic","score":100}'}]));
 assert.throws(()=>creditRetainedDigest([{row:null}]),/CREDIT_RETAINED_ROWS_INVALID/);
});

function batch(key){return{file:key+'.json',item:{sha256:digest},body:{batchKey:key,userIds:['synthetic']}};}
function hooks(overrides={}){
 const checkpoints=[],calls=[];
 return{checkpoints,calls,approvalRef:'round06-credit-approved',attempt:1,
  beforeBatch:async item=>calls.push('batch:'+item.body.batchKey),beforeMode:async()=>{},
  createRun:async(item,mode)=>({input:{key:item.body.batchKey,mode},fingerprint:digest}),
  saveSummary:async s=>checkpoints.push(structuredClone(s)),
  preview:async()=>({fingerprint:digest,outsideApprovedCategory:[],alreadyInitialized:[],wouldApply:['synthetic']}),
  apply:async input=>{calls.push('apply:'+input.key);return{replayed:false,receipt:{fingerprint:digest,applied:['synthetic'],alreadyInitialized:[]}};},
  saveResult:async()=>{},...overrides};
}

test('batch sequence records original keys before preview/apply and processes each batch once',async()=>{
 const h=hooks(),summary={batches:[]};const result=await executeCreditBatchSequence([batch('first'),batch('second')],h,summary);
 assert.equal(result.length,2);assert.equal(summary.batches.length,2);assert.equal(summary.pending,undefined);
 assert.deepEqual(h.calls,['batch:first','apply:first','batch:second','apply:second']);
 assert(h.checkpoints.some(s=>s.pending?.mode==='APPLY'&&s.pending.batchKey==='first'&&s.pending.packageSha256===digest));
});

test('unknown COMMIT stops before later batches and retains the original key',async()=>{
 const h=hooks({apply:async()=>{throw Object.assign(new Error('lost commit acknowledgement'),{outcome:'COMMIT_UNKNOWN'});}}),summary={batches:[]};
 await assert.rejects(executeCreditBatchSequence([batch('first'),batch('second')],h,summary),/lost commit acknowledgement/);
 assert.deepEqual(h.calls,['batch:first']);assert.equal(summary.pending.mode,'APPLY');assert.equal(summary.pending.batchKey,'first');assert.equal(summary.pending.packageSha256,digest);assert.equal(summary.pending.commitAck,undefined);
});

test('an acknowledged commit with failed local receipt remains distinguishable and stops',async()=>{
 const h=hooks({saveResult:async()=>{throw new Error('receipt storage failed');}}),summary={batches:[]};
 await assert.rejects(executeCreditBatchSequence([batch('first'),batch('second')],h,summary),/receipt storage failed/);
 assert.equal(summary.pending.batchKey,'first');assert.equal(summary.pending.commitAck,true);assert.equal(summary.batches.length,0);
});

test('an acknowledged receipt for different subjects cannot pass by matching only the count',async()=>{
 const h=hooks({apply:async()=>({replayed:false,receipt:{fingerprint:digest,applied:['different'],alreadyInitialized:[]}})}),summary={batches:[]};
 await assert.rejects(executeCreditBatchSequence([batch('first')],h,summary),/CREDIT_APPLY_RECEIPT_CHANGED/);
 assert.equal(summary.pending.commitAck,true);assert.equal(summary.batches.length,0);
});

test('preview drift or a lost lock stops before the following write',async()=>{
 const drift=hooks({preview:async()=>({fingerprint:digest,outsideApprovedCategory:['changed'],alreadyInitialized:[],wouldApply:[]})}),s1={batches:[]};
 await assert.rejects(executeCreditBatchSequence([batch('first')],drift,s1),/CREDIT_PREVIEW_DRIFT/);assert(!drift.calls.some(x=>x.startsWith('apply:')));
 const busy=hooks({beforeBatch:async()=>{throw new Error('CREDIT_RESOURCE_BUSY');}}),s2={batches:[]};
 await assert.rejects(executeCreditBatchSequence([batch('first')],busy,s2),/CREDIT_RESOURCE_BUSY/);assert.equal(s2.pending,undefined);
});
