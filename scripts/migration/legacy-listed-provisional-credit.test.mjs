import test from 'node:test';import assert from 'node:assert/strict';import {inspectDeferredLegacyCredit,lockDeferredLegacyCreditTables,deferredCreditGateForRow,requiresFullRollbackTrial,rejectUnmarkedObservation} from './legacy-listed-provisional-credit.mjs';
function fixture(){
 const state={score:100,revision:'1',reason:'STANDARD_QUOTE_UNAVAILABLE',creditState:'UNKNOWN',obligations:[],proofs:[],payment:false,refund:false,locks:5};
 const client={query:async(sql)=>{if(sql.includes('FROM pg_locks'))return{rows:[{n:state.locks}]};if(sql.includes('FROM zzsh_credit.user_credit_state'))return{rows:[{score:state.score,revision:state.revision}]};if(sql.includes('SELECT id FROM zzsh_order.owner_guarantee_requirement'))return{rows:state.obligations};if(sql.includes('SELECT id FROM zzsh_supply.account_guarantee_proof'))return{rows:state.proofs};if(sql.includes('payment_exists'))return{rows:[{payment_exists:state.payment,refund_exists:state.refund}]};throw Error('UNEXPECTED_SQL')}};
 const account={id:'account',owner_user_id:'owner',current_version_id:'observation'},version={id:'observation',origin:'LEGACY_OBSERVATION',review_state:'IMPORTED_UNVERIFIED',payload:null,rule_release_id:null},raw={status:'3',is_delete:'0'},gate={occupancy:'FREE',publisherBail:'UNKNOWN',creditGuarantee:{status:'UNKNOWN'}};
 const readGuaranteeContext=async()=>({accountId:'account',ownerUserId:'owner',versionId:null,state:state.creditState,reasonCode:state.reason,score:state.score,creditRevision:state.revision});
 return {state,client,input:{account,version,raw,gate,readGuaranteeContext,threshold:80,lockRows:true}};
}
test('only permits a deferred trial marker; it never asserts guarantee satisfied',async()=>{const x=fixture();assert.deepEqual(await inspectDeferredLegacyCredit(x.client,x.input),{kind:'FROZEN_QUOTE_REQUIRED',creditRevision:'1'});assert.equal(x.input.gate.publisherBail,'UNKNOWN')});
test('low score, incomplete source, other unknowns, occupancy and old liabilities fail closed',async()=>{
 const mutations=[x=>x.state.score=79,x=>x.state.reason='CREDIT_UNINITIALIZED',x=>x.state.creditState='REQUIRED',x=>x.state.obligations=[{id:'old'}],x=>x.state.proofs=[{id:'g0'}],x=>x.state.payment=true,x=>x.state.refund=true,x=>x.input.raw.status='5',x=>x.input.version.origin='NATIVE',x=>x.input.version.payload={},x=>x.input.gate.occupancy='OCCUPIED',x=>x.input.gate.rentalCompleted=true,x=>x.input.gate.publisherBail='PENDING'];
 for(const mutate of mutations){const x=fixture();mutate(x);assert.equal(await inspectDeferredLegacyCredit(x.client,x.input),null)}
});
test('transactional mode requires all maintenance-window SHARE locks',async()=>{const x=fixture();x.state.locks=4;await assert.rejects(()=>inspectDeferredLegacyCredit(x.client,x.input),/TABLE_LOCKS_REQUIRED/);let sql='';await lockDeferredLegacyCreditTables({query:async s=>{sql=s}});assert.match(sql,/LOCK TABLE .* IN SHARE MODE/)});
test('formal gate remains unknown before quote and must really pass afterwards',async()=>{
 const x=fixture(),row={deferredCredit:{creditRevision:'1'},body:{intake:{accountId:'account',source:{expectedObservationVersionId:'observation'},legacyQuoteEvidence:{sourceCanonical:JSON.stringify(x.input.raw)}}}};
 let final={occupancy:'FREE',publisherBail:'NOT_REQUIRED',reference:'proof',creditGuarantee:{status:'NOT_REQUIRED',creditRevision:'1',requiredCents:'0'}};
 const wrap=()=>deferredCreditGateForRow(row,{gate:async(_c,a)=>a.current_version_id==='observation'?x.input.gate:final,readCurrentVersion:async()=>x.input.version,readPublishingAccount:async()=>({...x.input.account,current_version_id:'quote'}),readGuaranteeContext:x.input.readGuaranteeContext,threshold:80});
 const w=wrap();await assert.rejects(()=>w.assertReady(x.client,false),/PRECHECK_NOT_PERFORMED/);
 assert.equal((await w.gate(x.client,x.input.account,'WRITE')).publisherBail,'UNKNOWN');await w.assertReady(x.client,false);
 for(const mutate of [g=>g.occupancy='OCCUPIED',g=>g.publisherBail='PENDING',g=>g.creditGuarantee.status='UNKNOWN',g=>g.creditGuarantee.creditRevision='2',g=>g.creditGuarantee.requiredCents='1',g=>g.reference=null]){
  const w2=wrap();await w2.gate(x.client,x.input.account,'WRITE');const old=structuredClone(final);mutate(final);await assert.rejects(()=>w2.assertReady(x.client,false),/FINAL_CREDIT_GUARANTEE_NOT_READY/);final=old;
 }
 x.state.obligations=[{id:'prior'}];await assert.rejects(()=>w.assertReady(x.client,false),/GUARANTEE_HISTORY_CHANGED/);
});
test('every deferred execution requires the full rollback trial, even without a round binding',()=>{
 assert.equal(requiresFullRollbackTrial('--execute',{},[{deferredCredit:{kind:'FROZEN_QUOTE_REQUIRED'}}]),true);
 assert.equal(requiresFullRollbackTrial('--execute',{roundBinding:{}},[{}]),true);
 assert.equal(requiresFullRollbackTrial('--execute',{},[{}]),false);
 assert.equal(requiresFullRollbackTrial('--trial',{},[{deferredCredit:{}}]),false);
});
test('forging a prior version cannot send the unmarked observation to takeover',async()=>{
 const row={priorVersion:{versionId:'forged'},body:{intake:{source:{expectedObservationVersionId:'observation'}}}},gate=rejectUnmarkedObservation(row,async()=>({publisherBail:'NOT_REQUIRED'}));
 await assert.rejects(()=>gate(null,{current_version_id:'observation'},'WRITE'),/DEFERRED_CREDIT_PLAN_REQUIRED/);
 assert.equal((await gate(null,{current_version_id:'published'},'WRITE')).publisherBail,'NOT_REQUIRED');
});
