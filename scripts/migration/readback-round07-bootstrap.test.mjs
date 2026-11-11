import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { normalizeRegisteredTarget } from './local-target-registry.mjs';
import { validateR07BootstrapProofInputs, verifyR07BootstrapRows } from './readback-round07-bootstrap.mjs';

const instance={host:'127.0.0.1',port:55433,systemIdentifier:'12345'},nonce='a'.repeat(24),hash='b'.repeat(64);
const target={database:'zzsh_test_regression',oid:'123',nonce,instance,migrationRoleOid:'790',bootstrapReservation:'ROUND07_BOOTSTRAP_RESERVED'};
const registered=normalizeRegisteredTarget({database:target.database,marker:'zzsh:regression-test:v1',oid:target.oid,nonce,instance,
 roles:{migration:{name:'migration',oid:'790'},runtime:{name:'runtime',oid:'789'}}});
const actors=Object.fromEntries(['boss-one','boss-two','operations','support'].map((n,i)=>[n,{realm:'admin',origin:'http://127.0.0.1:4241',userId:'user'+i,
 username:i===0?'zz00001':i===1?'zz00002':'zz0000'+(i+1),password:'fixture',totp:{encoding:'base32',secret:'JBSWY3DPEHPK3PXP'}}]));
const profile={version:1,localTest:true,resource:'r07',actors},input={schema:'zzsh.round07-bootstrap-readback-request.v1',target,runtimeBinding:{sha256:hash}};
const admin=stage=>({stage,status:'FORMAL_INITIALIZATION_COMPLETED',target,serverBindingSha256:hash,finalReadbackRollbackAck:true,maintenanceClosed:true,unlock:true,oldAdminRowsImported:false});
const policy={status:'FORMAL_LOCAL_POLICY_INITIALIZED',executionStatus:'SUCCEEDED',oldApprovalsCopied:false,target,provenance:{runtimeBindingSha256:hash},approvalRequestId:'approval1',policyId:'policy1',effectiveAtUtc:'2026-11-05T00:00:00.341Z'};
const receipts={bosses:admin('bosses'),staff:admin('staff'),policy};
const rows=Object.values(actors).map((a,i)=>({id:a.userId,username:a.username,suspended:false,two_factor:true,status:'ACTIVE',password_change_required:false,is_boss:i<2}));
const p={id:'policy1',status:'APPROVED',effective_at:new Date(policy.effectiveAtUtc),effective_now:true,current_policy:true,approval_request_id:'approval1',request_status:'EXECUTED',decision:'APPROVED',execution_status:'SUCCEEDED',operation_code:'membership.benefit.policy.publish',result_code:'MEMBERSHIP_POLICY_PUBLISHED',result_detail:'policy1',requested_by:'user0',approver:'user1',executed_by:'user0',approved_by:'user0'};

test('R07 proof inputs reject old instance, changed server and incomplete admin receipts',()=>{
 assert.doesNotThrow(()=>validateR07BootstrapProofInputs(input,registered,profile,receipts));
 const wrong=structuredClone(input);wrong.target.instance.systemIdentifier='9';assert.throws(()=>validateR07BootstrapProofInputs(wrong,registered,profile,receipts));
 const old=structuredClone(receipts);old.staff.serverBindingSha256='c'.repeat(64);assert.throws(()=>validateR07BootstrapProofInputs(input,registered,profile,old));
 const partial=structuredClone(receipts);partial.bosses.unlock=false;assert.throws(()=>validateR07BootstrapProofInputs(input,registered,profile,partial));
});
test('bootstrap readback checks next-round profile and all target instances',()=>{
 const nextInstance={...instance,port:55435},migrationProfile='LOCAL_MIGRATION_NEXT_V1';
 const nextTarget={...target,instance:nextInstance,migrationProfile},nextRegistry=normalizeRegisteredTarget({database:target.database,marker:'zzsh:regression-test:v1',oid:target.oid,nonce,instance:nextInstance,migrationProfile,
  roles:{migration:{name:'migration',oid:'790'},runtime:{name:'runtime',oid:'789'}}});
 const nextInput={...input,target:nextTarget},nextReceipts={bosses:{...receipts.bosses,target:nextTarget},staff:{...receipts.staff,target:nextTarget},policy:{...receipts.policy,target:nextTarget}};
 assert.doesNotThrow(()=>validateR07BootstrapProofInputs(nextInput,nextRegistry,profile,nextReceipts));
 assert.throws(()=>validateR07BootstrapProofInputs({...nextInput,target:{...nextTarget,migrationProfile:undefined}},nextRegistry,profile,nextReceipts));
 assert.throws(()=>validateR07BootstrapProofInputs(nextInput,nextRegistry,profile,{...nextReceipts,staff:receipts.staff}));
});
test('readback requires exact new administrators, no old sessions, and actual approved policy relations',()=>{
 const result=verifyR07BootstrapRows(profile,policy,rows,0,[p]);assert.equal(result.admins.count,4);assert.equal(result.policy.onlyNewBossRelations,true);
 assert.doesNotThrow(()=>verifyR07BootstrapRows(profile,policy,rows,0,[{...p,effective_at:policy.effectiveAtUtc}]));
 const altered=structuredClone(rows);altered[2].id='old-admin';assert.throws(()=>verifyR07BootstrapRows(profile,policy,altered,0,[p]));
 assert.throws(()=>verifyR07BootstrapRows(profile,policy,rows,1,[p]));
 for(const change of [x=>{x.effective_now=false;},x=>{x.current_policy=false;},x=>{x.approver='user0';},x=>{x.result_detail='other';},x=>{x.execution_status='FAILED';}]){
  const alteredPolicy=structuredClone(p);change(alteredPolicy);assert.throws(()=>verifyR07BootstrapRows(profile,policy,rows,0,[alteredPolicy]));
 }
 assert.throws(()=>verifyR07BootstrapRows(profile,policy,rows,0,[]));
});
test('bootstrap readback defaults to no connections',()=>{
 const result=spawnSync(process.execPath,[fileURLToPath(new URL('./readback-round07-bootstrap.mjs',import.meta.url))],{encoding:'utf8'});
 assert.equal(result.status,0);assert.equal(JSON.parse(result.stdout).connections,0);
});
