import assert from 'node:assert/strict';
import test from 'node:test';
import { approvalRegistration, membershipBusinessPermission, membershipDecisionRequiresBoss, membershipOperationRequiresGameScope, projectApprovalBusinesses } from '../src/auth/approval-business';
import * as auth from '../src/auth/auth-security';
import * as core from '../src/auth/security-core';
import * as reader from '../src/finance/admin-distribution-read';
import { handleAdminDistributionRead } from '../src/finance/admin-distribution-routes';
import { parseEarningsDetailQuery } from '../src/finance/distribution-earning-read';

test('shared operation uses existing request/manage gate and Boss review without artificial game scope',()=>{
 const op='distribution.policy.publish',registration=approvalRegistration(op);
 assert.equal(registration?.businessType,'distribution');assert.equal(registration?.testOnly,false);assert.equal(registration?.executionMode,'GENERIC_TRANSACTION');
 for(const stage of ['REQUEST','DECIDE','EXECUTE'] as const)assert.equal(membershipBusinessPermission(op,stage),'personal.distribution.policy.manage');
 assert.equal(membershipDecisionRequiresBoss(op),true);assert.equal(membershipOperationRequiresGameScope(op),false);
 assert.equal(membershipDecisionRequiresBoss('membership.benefit.policy.publish'),true);
});
test('approval business summary only projects real frozen policy change and actual execution receipt',async()=>{
 const payload={schema:'distribution-policy-change.v1',expectedPolicyId:'policy_1',expectedRevision:'4',expectedPolicyDigest:'a'.repeat(64),changes:{enabled:false},reason:'暂停新计佣'};
 const row:any={id:'request_1',operationCode:'distribution.policy.publish',payloadVersion:1,operationPayload:payload,operationPayloadHash:'b'.repeat(64),summary:'暂停新计佣',requestedBy:'ops_1',status:'PENDING',decidedBy:null,expiresAt:'2026-10-29T00:00:00.000Z'};
 const client:any={query:async(sql:string)=>{assert(sql.includes('approval_execution'));return{rows:[]};}};
 const viewer:any={userId:'ops_1',access:{status:'ACTIVE',passwordChangeRequired:false,isBoss:false,permissions:new Set(['personal.distribution.policy.read'])},gameScope:{kind:'ALL'}};
 const result=await projectApprovalBusinesses(client,[row],viewer),view=result.views.get(row.id)!;
 assert.equal(view.businessType,'distribution');assert.deepEqual((view.policyChange as any).changes,{enabled:false});assert.deepEqual(view.result,{knowledge:'UNKNOWN'});assert.equal('targetUser' in view,false);
 const denied=await projectApprovalBusinesses(client,[row],{...viewer,access:{...viewer.access,permissions:new Set()}});assert.equal(denied.views.get(row.id)!.detailsAvailable,false);assert.equal('policyChange' in denied.views.get(row.id)!,false);
});
test('Admin read leaf keeps current authenticated actor, one read-only snapshot and no write command',async()=>{
 const a=auth as any,c=core as any,r=reader as any,previous=[a.readAdminContext,c.withTransaction,r.readAdminDistributionOrder];const sql:string[]=[];let reads=0;
 a.readAdminContext=async()=>({userId:'support_1',sessionId:'session_1'});c.withTransaction=async(_pool:any,work:any)=>work({query:async(q:string)=>{sql.push(q);return{rows:[]};}});
 r.readAdminDistributionOrder=async(_client:any,actor:any,input:any)=>{assert.equal(actor.userId,'support_1');assert.deepEqual(input,{orderId:'order_1',origin:'NATIVE'});reads++;return{schema:'admin-distribution-order.v1',knowledge:'UNAVAILABLE',items:[]};};
 const response=()=>({statusCode:0,headers:{} as Record<string,string>,body:null as any,status(code:number){this.statusCode=code;return this;},setHeader(k:string,v:string|string[]){this.headers[k]=Array.isArray(v)?v.join(","):v;return this;},json(body:any){this.body=body;return this;}});
 const request=(method:string,url:string)=>({method,url,headers:{origin:'http://127.0.0.1:4221'}} as any),options:any={pool:{},adminOrigin:'http://127.0.0.1:4221',apiOrigin:'http://127.0.0.1:4222'};
 try{const success=response();await handleAdminDistributionRead(request('GET','/api/v1/admin/distribution/orders/NATIVE/order_1'),success,options);assert.equal(success.statusCode,200);assert.equal(reads,1);assert(sql[0]!.includes('REPEATABLE READ READ ONLY'));assert.equal(sql.length,2);assert(Object.values(success.headers).some(v=>v.includes('no-store')));
 const wrong=response();await handleAdminDistributionRead(request('POST','/api/v1/admin/distribution/orders/NATIVE/order_1'),wrong,options);assert.equal(wrong.statusCode,404);const extra=response();await handleAdminDistributionRead(request('GET','/api/v1/admin/distribution/orders/NATIVE/order_1?userId=other'),extra,options);assert.equal(extra.statusCode,400);assert.equal(reads,1);
 }finally{[a.readAdminContext,c.withTransaction,r.readAdminDistributionOrder]=previous;}
});
test('calculation version is explicit and cannot silently alter existing earnings list requests',()=>{
 assert.equal(parseEarningsDetailQuery(new URLSearchParams('projectionVersion=2&calculationVersion=2')).calculationVersion,2);
 assert.equal(parseEarningsDetailQuery(new URLSearchParams('projectionVersion=2')).calculationVersion,undefined);
 for(const q of ['calculationVersion=1','calculationVersion=2&calculationVersion=2','calculationVersion=2&userId=other'])assert.throws(()=>parseEarningsDetailQuery(new URLSearchParams(q)));
});
const reversalPayload={schema:'distribution-reversal-request.v1',earningId:'earning_1',orderId:'order_1',amountCents:'2500',full:true,reason:'错发佣金全额冲回'};
const reversalRow:any={id:'request_rev',operationCode:'distribution.earning.reverse',payloadVersion:1,operationPayload:reversalPayload,operationPayloadHash:'c'.repeat(64),summary:'错发佣金全额冲回',requestedBy:'ops_1',status:'APPROVED',decidedBy:'boss_1',expiresAt:'2099-10-29T00:00:00.000Z'};
const earningRow={id:'earning_1',orderId:'order_1',state:'SETTLED',amountCents:'2500',role:'OWNER_REFERRAL',beneficiaryUserId:'user_owner',postingId:'post_1',paymentConfirmationId:'pay_1',basisDigest:'b'.repeat(64),policyVersion:'policy_1',version:'2',reversals:0};
function reversalClient(executions:any[],earning:any=earningRow){const sql:string[]=[];return{sql,query:async(query:string)=>{sql.push(query);
 if(query.includes('approval_execution'))return{rows:executions};
 if(query.includes('rental_referral_earning'))return{rows:earning?[earning]:[]};
 return{rows:[]};}};}
const reversalViewer:any={userId:'ops_1',access:{status:'ACTIVE',passwordChangeRequired:false,isBoss:false,permissions:new Set(['personal.distribution.policy.read'])},gameScope:{kind:'ALL'}};
test('full reversal approval shows the original earning and never claims authority without a consumed receipt',async()=>{
 const unauthorized=await projectApprovalBusinesses(reversalClient([]) as any,[reversalRow],reversalViewer);
 const first=unauthorized.views.get(reversalRow.id)! as any;
 assert.equal(first.businessType,'distribution');assert.equal(first.reversal.authorization.knowledge,'NOT_EXECUTED');assert.deepEqual(first.result,{knowledge:'UNKNOWN'});
 assert.equal(first.reversal.original.amountCents,'2500');assert.equal(first.reversal.original.role,'OWNER_REFERRAL');assert.equal(first.reversal.original.postingId,'post_1');
 assert.equal(first.reversal.requestPayloadHash,'c'.repeat(64));assert.equal(first.reversal.originalFactsKnowledge,'KNOWN');
 const failed=await projectApprovalBusinesses(reversalClient([{requestId:reversalRow.id,receiptId:'exec_1',status:'FAILED',resultCode:'X',resultDetail:null,executedBy:'ops_1'}]) as any,[reversalRow],reversalViewer);
 assert.equal((failed.views.get(reversalRow.id) as any).reversal.authorization.knowledge,'REJECTED');
 const succeeded=await projectApprovalBusinesses(reversalClient([{requestId:reversalRow.id,receiptId:'exec_1',status:'SUCCEEDED',resultCode:'DISTRIBUTION_REVERSAL_AUTHORIZED',resultDetail:'earning_1',executedBy:'ops_1'}]) as any,[reversalRow],reversalViewer);
 const done=succeeded.views.get(reversalRow.id)! as any;
 assert.equal(done.reversal.authorization.knowledge,'KNOWN');assert.equal(done.reversal.authorization.executionReceiptId,'exec_1');assert.deepEqual(done.result,{knowledge:'KNOWN',earningId:'earning_1'});
 const drifted=await projectApprovalBusinesses(reversalClient([],{...earningRow,amountCents:'2400'}) as any,[reversalRow],reversalViewer);
 assert.equal((drifted.views.get(reversalRow.id) as any).reversal.originalFactsKnowledge,'MISMATCH');
 const missing=await projectApprovalBusinesses(reversalClient([],null) as any,[reversalRow],reversalViewer);
 assert.equal((missing.views.get(reversalRow.id) as any).reversal.original,null);
 assert.equal((missing.views.get(reversalRow.id) as any).reversal.originalFactsKnowledge,'UNKNOWN');
 const denied=await projectApprovalBusinesses(reversalClient([]) as any,[reversalRow],{...reversalViewer,access:{...reversalViewer.access,permissions:new Set()}});
 assert.equal((denied.views.get(reversalRow.id) as any).detailsAvailable,false);assert.equal('reversal' in (denied.views.get(reversalRow.id) as any),false);
});
