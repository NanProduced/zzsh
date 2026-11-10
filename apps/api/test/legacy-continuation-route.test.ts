import {test} from "node:test";
import assert from "node:assert/strict";
import type {Pool} from "pg";
import {mountOrderHandlers,type OrderRuntimeOptions} from "../src/order/order-routes";
import {handleLegacyContinuationRoute,parseLegacyContinuationPath} from "../src/order/legacy-continuation-routes";
import {legacyBinding,legacyEvidence,legacySource,legacyQuantities} from "./legacy-continuation-fixture";
import {conflict,notFound,type SupplyNodeRequest} from "../src/supply/supply-util";
import {initialLegacyFacts,projectLegacyContinuation} from "../src/order/legacy-continuation-model";
import type {SupplyResponse} from "../src/supply/supply-routes";
const e: typeof import("../src/order/legacy-continuation-evidence")=require("../src/order/legacy-continuation-evidence"),c: typeof import("../src/order/legacy-continuation-command")=require("../src/order/legacy-continuation-command");
const walletCredit: typeof import("../src/order/legacy-finance-duty")=require("../src/order/legacy-finance-duty");
function response(){return {headersSent:false,statusCode:0,payload:undefined as unknown,status(n:number){this.statusCode=n;return this;},setHeader(){return this;},json(body:unknown){this.payload=body;this.headersSent=true;return this;}};}
test("real mounted legacy GET/receipt and POST preserve actor/key/body; no test-operation switch is required",async t=>{
 const user:typeof import("../src/auth/user-identity")=require("../src/auth/user-identity");t.mock.method(user,"readUserContext",async()=>({userId:legacyBinding.ownerUserId,sessionId:"session_fixture"}));
 const seen:unknown[][]=[],records=new Map<string,{requestFingerprint:string;responseStatus:number;responseBody:unknown;publishRequired:boolean}>();
 const pool={connect:async()=>({release(){},query:async(sql:string,v:unknown[]=[])=>{
  if(sql.includes('"request_fingerprint" AS'))return {rows:records.has(String(v[1]))?[records.get(String(v[1]))]:[],rowCount:records.has(String(v[1]))?1:0};
  if(sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"')){records.set(String(v[1]),{requestFingerprint:String(v[2]),responseStatus:Number(v[3]),responseBody:JSON.parse(String(v[4])),publishRequired:false});}
  if(sql.includes("response_status AS status")){const r=records.get(String(v[1]));return {rows:r?[{status:r.responseStatus,body:r.responseBody,fingerprint:r.requestFingerprint}]:[],rowCount:r?1:0};}return {rows:[],rowCount:0};
 }})} as unknown as Pool;
 let allowed=true,authorizationCount=0;
 t.mock.method(c,"authorizeLegacyMutation",async(...[_client,actor,id]:Parameters<typeof c.authorizeLegacyMutation>)=>{authorizationCount++;if(!allowed)throw conflict("REVOKED");seen.push(["authorize",actor,id]);return {binding:legacyBinding,userIds:[legacyBinding.ownerUserId,legacyBinding.renterUserId].sort(),actor};});
 t.mock.method(c,"applyLegacyContinuationCommand",async(...[_client,actor,id,input,_finance,_authority,autoCredit]:Parameters<typeof c.applyLegacyContinuationCommand>)=>{seen.push(["apply",actor,id,input,autoCredit]);return {status:200,body:{orderId:id,command:input.kind,revision:"1",versionId:"version_fixture",inputEvidenceId:input.inputEvidenceId,resultEvidenceId:"result_fixture",stage:"4",channelState:"UNKNOWN"}};});
 t.mock.method(e,"readLegacyContinuation",async(...[_client,actor,id]:Parameters<typeof e.readLegacyContinuation>)=>{seen.push(["read",actor,id]);return {continuation:{schema:"legacy-continuation.v1",duties:[]}} as unknown as Awaited<ReturnType<typeof e.readLegacyContinuation>>;});
 const handlers=new Map<string,(q:SupplyNodeRequest,r:SupplyResponse)=>Promise<void>>(),app={getHttpAdapter:()=>({getInstance:()=>({use:(p:string,h:(q:SupplyNodeRequest,r:SupplyResponse)=>Promise<void>)=>handlers.set(p,h)})})};
 mountOrderHandlers(app as Parameters<typeof mountOrderHandlers>[0],{pool,apiOrigin:"http://api.invalid",userOrigin:"http://user.invalid"} as OrderRuntimeOptions);
 const handler=handlers.get("/api/v1/orders");assert(handler);
 const call=async(method:string,suffix:string,body:Record<string,unknown>={},origin="http://user.invalid")=>{const r=response();await handler({method,originalUrl:"/api/v1/orders/legacy/"+legacyBinding.id+"/continuation"+suffix,headers:{origin,"idempotency-key":"ORIGINAL_KEY","x-request-id":"req_fixture"},body},r);return r;};
 assert.equal((await call("GET","")).statusCode,200);
 const body={expectedRevision:null,inputEvidenceId:"fixture_evidence",planFingerprint:"f".repeat(64)};
 assert.equal((await call("POST","/confirm",body)).statusCode,200);assert.equal((await call("POST","/confirm",body)).statusCode,200);
 assert.equal(seen.filter(x=>x[0]==="apply").length,1);assert.equal(authorizationCount,2);assert.deepEqual(seen.find(x=>x[0]==="apply")?.[3],{kind:"confirm",...body});
 assert.equal(seen.find(x=>x[0]==="apply")?.[4],walletCredit.postLegacyOwnerCreditOnConfirmation);
 const receipt=await call("GET","/receipt?command=confirm&key=ORIGINAL_KEY");assert.equal(receipt.statusCode,200);assert.equal((receipt.payload as {state:string}).state,"KNOWN_SUCCESS");
 allowed=false;assert.equal((await call("POST","/confirm",body)).statusCode,409);assert.equal(seen.filter(x=>x[0]==="apply").length,1);
 assert.equal((await call("POST","/confirm",body,"http://foreign.invalid")).statusCode,403);
 assert.equal((await call("GET","/receipt?command=confirm&command=confirm&key=ORIGINAL_KEY")).statusCode,400);
 assert.equal((await call("GET","/confirm")).statusCode,404);
});
test("mapped source-qualified route rejects native IDs, path traversal, double encoding and encoded slash",()=>{
 assert.equal(parseLegacyContinuationPath("/legacy/"+legacyBinding.id+"/continuation")?.orderId,legacyBinding.id);
 assert.equal(parseLegacyContinuationPath("/legacy/"+legacyBinding.id+"/continuation/duties/duty_1/owner-credit")?.dutyCommand,"owner-credit");
 for(const id of ["7","order_native","history%3Aid","legacy_order_%252f","legacy_order_%2F","legacy_order_"+"f".repeat(40)+"%2Fextra"]){assert.throws(()=>parseLegacyContinuationPath("/legacy/"+id+"/continuation"));}
 assert.equal(parseLegacyContinuationPath("/legacy/"+legacyBinding.id+"/continuation/confirm/extra"),null);
});
test("legacy support cancellation allocates its refund before commit and preserves the original key on replay",async t=>{
 const auth:typeof import('../src/auth/auth-security')=require('../src/auth/auth-security');
 const allocation:typeof import('../src/order/legacy-support-cancel-refund')=require('../src/order/legacy-support-cancel-refund');
 t.mock.method(auth,'readAdminContext',async()=>({userId:'staff_1',sessionId:'session_1'}));
 t.mock.method(walletCredit,'authorizeLegacyFinanceDuty',async(...[_client,actor]:Parameters<typeof walletCredit.authorizeLegacyFinanceDuty>)=>({binding:legacyBinding,userIds:[],actor,financeDutyKind:'OWNER_CREDIT'}));
 let applied=0;const events:string[]=[],records=new Map<string,any>();
 t.mock.method(c,'applyLegacyContinuationCommand',async(...[_client,_actor,id,input]:Parameters<typeof c.applyLegacyContinuationCommand>)=>{applied++;return {status:200,body:{orderId:id,command:input.kind,stage:'5',versionId:'version_1'}};});
 t.mock.method(allocation,'allocateLegacySupportCancelRefundInTransaction',async(...[_client,_actor,id,key]:Parameters<typeof allocation.allocateLegacySupportCancelRefundInTransaction>)=>{
  assert.equal(id,legacyBinding.id);assert.equal(key,'original_cancel_key');assert.ok(records.has(key),'original receipt must exist before allocation');
  events.push('allocation');return {state:'CREATED',replayed:false};
 });
 const pool={connect:async()=>({release(){},query:async(sql:string,v:unknown[]=[])=>{
  if(sql==='COMMIT')events.push('commit');
  if(sql.includes('"request_fingerprint" AS')){const row=records.get(String(v[1]));return {rows:row?[row]:[],rowCount:row?1:0};}
  if(sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"'))records.set(String(v[1]),{requestFingerprint:v[2],responseStatus:v[3],responseBody:JSON.parse(String(v[4])),publishRequired:false});
  return {rows:[],rowCount:0};
 }})} as unknown as Pool;
 const request={method:'POST',originalUrl:`/api/v1/admin/orders/legacy/${legacyBinding.id}/continuation/support-cancel`,headers:{origin:'http://admin.invalid','idempotency-key':'original_cancel_key'},body:{expectedRevision:null,inputEvidenceId:'evidence_1',refundCents:'5000',ownerCents:'3000',reason:'双方协商取消',originalPaymentChecked:true}};
 const options={pool,apiOrigin:'http://api.invalid',adminOrigin:'http://admin.invalid',legacyRefund:{legacyRefundsEnabled:true,legacyInitialProfile:{},admission:{}}} as never;
 assert.equal(await handleLegacyContinuationRoute(request as never,response() as never,options,'admin'),true);
 assert.deepEqual(events.slice(-2),['allocation','commit']);
 assert.equal(await handleLegacyContinuationRoute(request as never,response() as never,options,'admin'),true);
 assert.equal(applied,1);assert.deepEqual(events,['allocation','commit','allocation','commit']);
});
test("demo legacy cancellation completes only its test refund before commit and keeps cancellation on retry",async t=>{
 const auth:typeof import('../src/auth/auth-security')=require('../src/auth/auth-security');
 const demo:typeof import('../src/order/ecs-demo-legacy-refund')=require('../src/order/ecs-demo-legacy-refund');
 t.mock.method(auth,'readAdminContext',async()=>({userId:'staff_1',sessionId:'session_1'}));
 t.mock.method(walletCredit,'authorizeLegacyFinanceDuty',async(...[_client,actor]:Parameters<typeof walletCredit.authorizeLegacyFinanceDuty>)=>({binding:legacyBinding,userIds:[],actor,financeDutyKind:'OWNER_CREDIT'}));
 let applied=0,simulations=0;const events:string[]=[],records=new Map<string,any>();
 t.mock.method(c,'applyLegacyContinuationCommand',async(...[_client,_actor,id,input]:Parameters<typeof c.applyLegacyContinuationCommand>)=>{applied++;return {status:200,body:{orderId:id,command:input.kind,stage:'5',versionId:'version_1'}};});
 t.mock.method(demo,'simulateLegacyCancellationRefund',async()=>{simulations++;events.push('demo');return simulations===1?'SIMULATED':'ALREADY_SIMULATED';});
 const pool={connect:async()=>({release(){},query:async(sql:string,v:unknown[]=[])=>{
  if(sql==='COMMIT')events.push('commit');
  if(sql.includes('"request_fingerprint" AS')){const r=records.get(String(v[1]));return{rows:r?[r]:[],rowCount:r?1:0};}
  if(sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"'))records.set(String(v[1]),{requestFingerprint:v[2],responseStatus:v[3],responseBody:JSON.parse(String(v[4])),publishRequired:false});
  return {rows:[],rowCount:0};
 }})} as unknown as Pool;
 const request={method:'POST',originalUrl:`/api/v1/admin/orders/legacy/${legacyBinding.id}/continuation/support-cancel`,headers:{origin:'http://admin.invalid','idempotency-key':'original_demo_key'},body:{expectedRevision:null,inputEvidenceId:'evidence_1',refundCents:'5000',ownerCents:'3000',reason:'双方协商取消',originalPaymentChecked:true}};
 const options={pool,apiOrigin:'http://api.invalid',adminOrigin:'http://admin.invalid',ecsTestDemo:{}} as never;
 await handleLegacyContinuationRoute(request as never,response() as never,options,'admin');
 await handleLegacyContinuationRoute(request as never,response() as never,options,'admin');
 assert.equal(applied,1);assert.deepEqual(events,['demo','commit','demo','commit']);
});
test("staff owner-credit route rechecks authorization and recovers the original idempotent receipt",async t=>{
 const auth:typeof import("../src/auth/auth-security")=require("../src/auth/auth-security");t.mock.method(auth,"readAdminContext",async()=>({userId:"staff_1",sessionId:"session_1"}));
 const records=new Map<string,any>(),kinds:string[]=[];let writes=0,authorized=0;
 const pool={connect:async()=>({release(){},query:async(sql:string,v:unknown[]=[])=>{
  if(sql.includes('"request_fingerprint" AS')){const r=records.get(String(v[1]));return{rows:r?[r]:[],rowCount:r?1:0};}
  if(sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"'))records.set(String(v[1]),{requestFingerprint:v[2],responseStatus:v[3],responseBody:JSON.parse(String(v[4])),publishRequired:false});
  if(sql.includes("response_status AS status")){const r=records.get(String(v[1]));return{rows:r?[{status:r.responseStatus,body:r.responseBody,fingerprint:r.requestFingerprint}]:[]};}
  if(sql.includes("FROM zzsh_order.legacy_order_duty WHERE id="))return{rows:[{id:"duty_1"}],rowCount:1};
  return{rows:[],rowCount:0};
 }})} as unknown as Pool;
 t.mock.method(walletCredit,"authorizeLegacyFinanceDuty",async(...[_client,actor,_order,kind]:Parameters<typeof walletCredit.authorizeLegacyFinanceDuty>)=>{authorized++;kinds.push(kind);return{binding:legacyBinding,userIds:[],actor,financeDutyKind:kind};});
 const receipt={orderId:legacyBinding.id,dutyId:"duty_1",revision:"2",status:"SETTLED",settledBy:"FINANCE",amountCents:"1000",reference:{type:"LEDGER_ENTRY",id:"line_1",digest:"a".repeat(64)},channelArrival:"UNKNOWN"};
 t.mock.method(walletCredit,"postLegacyFinanceDuty",async(...[_client,_actor,_order,_kind,input]:Parameters<typeof walletCredit.postLegacyFinanceDuty>)=>{writes++;return{status:200,body:{...receipt,dutyId:input.dutyId}} as any;});
 t.mock.method(walletCredit,"projectLegacyFinanceDutyReceipt",async(...[_client,_order,_kind,body]:Parameters<typeof walletCredit.projectLegacyFinanceDutyReceipt>)=>body as any);
 let confirmCallback:unknown;
 t.mock.method(c,"applyLegacyContinuationCommand",async(...[_client,actor,id,input,_finance,_authority,autoCredit]:Parameters<typeof c.applyLegacyContinuationCommand>)=>{confirmCallback=autoCredit;return{status:200,body:{orderId:id,command:input.kind,revision:'1',versionId:'version_1',inputEvidenceId:input.inputEvidenceId,resultEvidenceId:'result_1',stage:'4',channelState:'UNKNOWN'}};});
 const handlers=new Map<string,any>(),app={getHttpAdapter:()=>({getInstance:()=>({use:(p:string,h:any)=>handlers.set(p,h)})})};
 mountOrderHandlers(app as never,{pool,apiOrigin:"http://api.invalid",adminOrigin:"http://admin.invalid"} as OrderRuntimeOptions);
 const handler=handlers.get("/api/v1/admin/orders"),body={expectedRevision:"1",reason:"双方订单已核对"};
 const call=async(method:string,suffix:string,payload:Record<string,unknown>=body,key="original_key")=>{const r=response();await handler({method,originalUrl:`/api/v1/admin/orders/legacy/${legacyBinding.id}/continuation${suffix}`,headers:{origin:"http://admin.invalid","idempotency-key":key,"x-request-id":"request_1"},body:payload},r);return r;};
 assert.equal((await call("POST","/duties/duty_1/owner-credit")).statusCode,200);
 assert.equal((await call("POST","/duties/duty_1/owner-credit")).statusCode,200);assert.equal(writes,1);assert.equal(authorized,2);
 const recovered=await call("GET","/receipt?command=owner-credit&dutyId=duty_1&key=original_key");assert.equal(recovered.statusCode,200);assert.equal((recovered.payload as any).state,"KNOWN_SUCCESS");
 assert.equal((await call("POST","/duties/duty_1/owner-credit",{...body,reason:"另一段处理原因"})).statusCode,409);assert.equal(writes,1);
 assert.equal((await call("POST","/duties/duty_2/commission-credit",body,"commission_key")).statusCode,200);
 assert.equal(writes,2);assert.equal(kinds.at(-1),"COMMISSION");
 const confirm={expectedRevision:null,inputEvidenceId:'evidence_1',planFingerprint:'f'.repeat(64),reason:'双方已核实'};
 assert.equal((await call('POST','/confirm',confirm,'confirm_key')).statusCode,200);assert.equal(kinds.at(-1),'OWNER_CREDIT');assert.equal(confirmCallback,walletCredit.postLegacyOwnerCreditOnConfirmation);
 assert.equal((await call('GET','/receipt?command=confirm&key=confirm_key')).statusCode,200);assert.equal(kinds.at(-1),'OWNER_CREDIT');
});
test("legacy refund review is authorized, idempotent and remains recoverable after new refunds are disabled",async t=>{
 const auth:typeof import('../src/auth/auth-security')=require('../src/auth/auth-security');t.mock.method(auth,'readAdminContext',async()=>({userId:'staff_1',sessionId:'session_1'}));
 const review:typeof import('../src/order/legacy-refund-review-store')=require('../src/order/legacy-refund-review-store');
 const cases:typeof import('../src/order/legacy-refund-case-command')=require('../src/order/legacy-refund-case-command');
 let authorized=true,writes=0;const records=new Map<string,any>();
 const pool={connect:async()=>({release(){},query:async(sql:string,v:unknown[]=[])=>{
  if(sql.includes('"request_fingerprint" AS')){const r=records.get(String(v[1]));return{rows:r?[r]:[],rowCount:r?1:0};}
  if(sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"'))records.set(String(v[1]),{requestFingerprint:v[2],responseStatus:v[3],responseBody:JSON.parse(String(v[4])),publishRequired:false});
  if(sql.includes('response_status AS status')){const r=records.get(String(v[1]));return{rows:r?[{status:r.responseStatus,body:r.responseBody,fingerprint:r.requestFingerprint}]:[]};}
  if(sql.includes('FROM zzsh_order.legacy_order_duty WHERE id='))return{rows:[{id:'duty_1'}],rowCount:1};return{rows:[],rowCount:0};
 }})} as unknown as Pool;
 t.mock.method(review,'authorizeLegacyRefundReviewAccess',async()=>{if(!authorized)throw notFound();return legacyBinding;});
 const receipt={caseId:'case_1',orderId:legacyBinding.id,dutyId:'duty_1',intentId:'intent_1',refundOrderNo:'LR'+'a'.repeat(28),dutyCents:'5000',priorAppliedCents:'2000',amountCents:'3000',channelResultAtCreation:'NOT_SUBMITTED' as const};
 t.mock.method(cases,'createLegacyRefundCase',async(...[_client,_actor,input]:Parameters<typeof cases.createLegacyRefundCase>)=>{writes++;assert.equal(input.paymentOrderNo,'OLDPAY123');return{status:200,body:receipt};});
 t.mock.method(cases,'readLegacyRefundCaseReceipt',async()=>receipt);
 const handlers=new Map<string,any>(),app={getHttpAdapter:()=>({getInstance:()=>({use:(p:string,h:any)=>handlers.set(p,h)})})};
 const execution={admission:{} as never,legacyRefundsEnabled:true,legacyInitialProfile:{} as never};
 mountOrderHandlers(app as never,{pool,apiOrigin:'http://api.invalid',adminOrigin:'http://admin.invalid',legacyRefund:execution} as unknown as OrderRuntimeOptions);
 const handler=handlers.get('/api/v1/admin/orders'),body={expectedDutyRevision:'1',expectedHeadRevision:'2',paymentOrderNo:'OLDPAY123',confirmedMerchantNo:'12345',
  paidCents:'10000',previouslyRefundedCents:'2000',priorAppliedToDutyCents:'2000',noUnresolvedRefunds:true,evidenceRef:'已核对原渠道记录'};
 const call=async(method:string,suffix:string,payload:Record<string,unknown>=body,key='original_refund_key')=>{const r=response();
  await handler({method,originalUrl:`/api/v1/admin/orders/legacy/${legacyBinding.id}/continuation${suffix}`,headers:{origin:'http://admin.invalid','idempotency-key':key},body:payload},r);return r;};
 assert.equal((await call('POST','/duties/duty_1/refund-case')).statusCode,200);assert.equal(writes,1);
 execution.legacyRefundsEnabled=false;assert.equal((await call('POST','/duties/duty_1/refund-case')).statusCode,200);assert.equal(writes,1);
 const recovered=await call('GET','/receipt?command=refund-case&dutyId=duty_1&key=original_refund_key');assert.equal(recovered.statusCode,200);assert.equal((recovered.payload as any).state,'KNOWN_SUCCESS');
 assert.equal((await call('POST','/duties/duty_1/refund-case',body,'new_key')).statusCode,503);assert.equal(writes,1);
 authorized=false;assert.equal((await call('GET','/receipt?command=refund-case&dutyId=duty_1&key=original_refund_key')).statusCode,404);
});
test("legacy refund basis only exposes the authorized order and never invents unknown payment facts",async t=>{
 const auth:typeof import('../src/auth/auth-security')=require('../src/auth/auth-security');t.mock.method(auth,'readAdminContext',async()=>({userId:'staff_1',sessionId:'session_1'}));
 const review:typeof import('../src/order/legacy-refund-review-store')=require('../src/order/legacy-refund-review-store');
 const profile:typeof import('../src/order/joinpay-refund-profile')=require('../src/order/joinpay-refund-profile');
 const model:typeof import('../src/order/legacy-continuation-model')=require('../src/order/legacy-continuation-model');
 let authorized=true,complete=true;
 t.mock.method(review,'authorizeLegacyRefundReviewAccess',async()=>{if(!authorized)throw notFound();return {...legacyBinding,paidCents:'10000'};});
 t.mock.method(e,'readLegacyContinuationHead',async()=>({id:'head_1',revision:'2',stage:'4',refundDueAt:'2026-11-01T00:00:00Z'} as never));
 t.mock.method(e,'readLegacyContinuationDuties',async()=>[{id:'duty_1',kind:'RENTER_REFUND',revision:'1',amountCents:'5000',status:'PENDING'}] as never);
 t.mock.method(e,'readLegacyContinuationEvidence',async()=>({} as never));
 t.mock.method(model,'readSealedLegacyFacts',()=>({evidence:{admission:'PARAMETER_COMPLETE',source:{paidPay:complete?[{payOrderSn:'OLDPAY123',payMoney:'100.00'}]:[]}}} as never));
 t.mock.method(profile,'describeRefundProfile',()=>({merchantNo:'12345'} as never));
 const pool={connect:async()=>({release(){},query:async(sql:string)=>{
  if(sql.includes('to_regclass'))return{rows:[{available:true}]};if(sql.includes('FROM zzsh_order.legacy_refund_case'))return{rows:[]};
  if(sql.includes('timestamptz<=clock_timestamp()'))return{rows:[{due:true}]};return{rows:[]};}})} as unknown as Pool;
 const r=response(),request={method:'GET',originalUrl:`/api/v1/admin/orders/legacy/${legacyBinding.id}/continuation/duties/duty_1/refund-case`,headers:{}};
 const opts={pool,legacyRefund:{admission:{} as never,legacyRefundsEnabled:true,legacyInitialProfile:{} as never}} as never;
 assert.equal(await handleLegacyContinuationRoute(request as never,r as never,opts,'admin'),true);
 assert.equal((r.payload as any).paymentOrderNo,'OLDPAY123');assert.equal((r.payload as any).canStart,true);
 complete=false;const missing=response();await handleLegacyContinuationRoute(request as never,missing as never,opts,'admin');
 assert.equal((missing.payload as any).paymentOrderNo,null);assert.equal((missing.payload as any).canStart,false);
 authorized=false;await assert.rejects(handleLegacyContinuationRoute(request as never,response() as never,opts,'admin'));
});
test('renter refund status is scoped to visible duty and requires verified channel progress',async t=>{
 const user:typeof import('../src/auth/user-identity')=require('../src/auth/user-identity');let party=legacyBinding.renterUserId;
 t.mock.method(user,'readUserContext',async()=>({userId:party,sessionId:'session_1'}));
 const cases:typeof import('../src/order/legacy-refund-case-command')=require('../src/order/legacy-refund-case-command');
 const refund:typeof import('../src/order/legacy-refund-attempt')=require('../src/order/legacy-refund-attempt');
 const duty={id:'duty_1',kind:'RENTER_REFUND',status:'SETTLED',settledBy:'FINANCE'};let progress='SUCCEEDED',reads=0;
 t.mock.method(e,'readLegacyContinuation',async()=>({continuation:{duties:party===legacyBinding.renterUserId?[duty]:[]}} as never));
 t.mock.method(cases,'readLegacyRefundCaseForStatus',async()=>({intentId:'intent_1',amountCents:'4000',dutyCents:'5000',priorAppliedCents:'1000'}));
 t.mock.method(refund,'readLegacyRefundProgress',async()=>{reads++;return {state:progress,terminal:'SUCCEEDED',privateField:'must-not-leak'} as never;});
 const pool={connect:async()=>({release(){},query:async(sql:string)=>{
  if(sql.includes('to_regclass'))return{rows:[{ready:true}]};if(sql.includes('FROM zzsh_order.legacy_refund_case'))return{rows:[{id:'case_1'}]};return{rows:[]};}})} as unknown as Pool;
 const request={method:'GET',originalUrl:`/api/v1/orders/legacy/${legacyBinding.id}/continuation`,headers:{}},opts={pool,legacyRefund:{admission:{},legacyRefundsEnabled:false}} as never;
 const first=response();await handleLegacyContinuationRoute(request as never,first as never,opts,'user');
 assert.equal((first.payload as any).continuation.duties[0].refundProgress,'CHANNEL_SUCCEEDED');assert.doesNotMatch(JSON.stringify(first.payload),/must-not-leak/);
 progress='REVIEW_REQUIRED';const review=response();await handleLegacyContinuationRoute(request as never,review as never,opts,'user');
 assert.equal((review.payload as any).continuation.duties[0].refundProgress,'REVIEW_REQUIRED');
 party=legacyBinding.ownerUserId;const owner=response();await handleLegacyContinuationRoute(request as never,owner as never,opts,'user');
 assert.equal((owner.payload as any).continuation.duties.length,0);assert.equal(reads,2);
});
test("legacy support preview exposes deposit shortage as a safe actionable reason",async t=>{
 const admin:typeof import("../src/auth/auth-security")=require("../src/auth/auth-security");
 t.mock.method(admin,"readAdminContext",async()=>({userId:"fixture_admin",sessionId:"fixture_session"}));
 t.mock.method(e,"readLegacyContinuationBinding",async()=>legacyBinding);t.mock.method(e,"authorizeLegacyContinuation",async()=>({canOperate:true,canReadCommission:false}));
 t.mock.method(e,"readLegacyContinuationHead",async()=>null);t.mock.method(e,"readLegacyContinuationEvidence",async()=>legacyEvidence(initialLegacyFacts(legacySource())));
 const pool={connect:async()=>({release(){},query:async()=>({rows:[],rowCount:0})})} as unknown as Pool;
 const out=response(),request={method:"POST",originalUrl:`/api/v1/admin/orders/legacy/${legacyBinding.id}/continuation/preview`,headers:{origin:"http://admin.invalid"},body:{quantities:legacyQuantities("999999"),onBehalf:"renter"}};
 assert.equal(await handleLegacyContinuationRoute(request as never,out as never,{pool,apiOrigin:"http://api.invalid",adminOrigin:"http://admin.invalid"} as never,"admin"),true);
 assert.equal(out.statusCode,409);assert.equal((out.payload as any).error.reason,"DEPOSIT_SHORT");
});

test("legacy preview refuses an unproven used price before exposing a quote",async t=>{
 const admin:typeof import("../src/auth/auth-security")=require("../src/auth/auth-security");
 t.mock.method(admin,"readAdminContext",async()=>({userId:"fixture_admin",sessionId:"fixture_session"}));
 t.mock.method(e,"readLegacyContinuationBinding",async()=>legacyBinding);t.mock.method(e,"authorizeLegacyContinuation",async()=>({canOperate:true,canReadCommission:false}));
 const source=legacySource();source.orderPrices.awm=null;
 t.mock.method(e,"readLegacyContinuationHead",async()=>null);t.mock.method(e,"readLegacyContinuationEvidence",async()=>legacyEvidence(initialLegacyFacts(source)));
 const pool={connect:async()=>({release(){},query:async()=>({rows:[],rowCount:0})})} as unknown as Pool;
 const out=response(),request={method:"POST",originalUrl:`/api/v1/admin/orders/legacy/${legacyBinding.id}/continuation/preview`,headers:{origin:"http://admin.invalid"},body:{quantities:{...legacyQuantities("1"),awm:"1"},onBehalf:"renter"}};
 assert.equal(await handleLegacyContinuationRoute(request as never,out as never,{pool,apiOrigin:"http://api.invalid",adminOrigin:"http://admin.invalid"} as never,"admin"),true);
 assert.equal(out.statusCode,409);assert.equal((out.payload as any).error.reason,"EVIDENCE_ISOLATED");assert.equal((out.payload as any).proposalAmounts,undefined);
});

test("mounted legacy parties receive filtered fresh/replay/race/receipt output without changing original stored bodies",async parent=>{
 for(const who of ["owner","renter"] as const)await parent.test(who,async t=>{
  const user:typeof import("../src/auth/user-identity")=require("../src/auth/user-identity");let currentUser=who==="owner"?legacyBinding.ownerUserId:legacyBinding.renterUserId;
  t.mock.method(user,"readUserContext",async()=>({userId:currentUser,sessionId:"fixture_session"}));
  const amounts={payMoney:"901.23",saleEarnings:"163.27",ownerNet:"150.21",returnOrderMoney:"517.89",refundNet:"506.82",fullPayoutMoney:"13.06",commissionPool:"220.07"};
  const raw={orderId:legacyBinding.id,revision:"7",stage:"4",outcome:"ACCEPTED",amounts,previewAmounts:amounts,proposalAmounts:amounts,source:{accountPrices:{coffee:"77.31"}},facts:{privatePrice:"99.17"}};
  const rawBefore=JSON.stringify(raw),records=new Map<string,any>();let applies=0,raceInserted=false,allowed=true;
  const pool={connect:async()=>({release(){},query:async(sql:string,v:unknown[]=[])=>{
   if(sql.includes('"request_fingerprint" AS')){const row=records.get(String(v[1]));return{rows:row?[row]:[],rowCount:row?1:0};}
   if(sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"')){
    const key=String(v[1]);records.set(key,{requestFingerprint:v[2],responseStatus:v[3],responseBody:JSON.parse(String(v[4])),publishRequired:false});
    if(key==="RACE_KEY"&&!raceInserted){raceInserted=true;throw Object.assign(new Error("other transaction won"),{code:"23505"});}
   }
   if(sql.includes("response_status AS status")){const row=records.get(String(v[1]));return{rows:row?[{status:row.responseStatus,body:row.responseBody,fingerprint:row.requestFingerprint}]:[]};}
   return{rows:[],rowCount:0};
  }})} as unknown as Pool;
  t.mock.method(c,"authorizeLegacyMutation",async(...[_client,actor]:Parameters<typeof c.authorizeLegacyMutation>)=>{if(!allowed||![legacyBinding.ownerUserId,legacyBinding.renterUserId].includes(actor.userId))throw notFound();return{binding:legacyBinding,userIds:[],actor};});
  t.mock.method(c,"applyLegacyContinuationCommand",async()=>{applies++;return{status:200,body:structuredClone(raw)};});
  const facts=initialLegacyFacts(legacySource({saleEarnings:"13.27",returnOrderMoney:"73.19"})),row=legacyEvidence(facts);
  t.mock.method(e,"readLegacyContinuation",async(...[_client,actor]:Parameters<typeof e.readLegacyContinuation>)=>({continuation:projectLegacyContinuation(legacyBinding,actor,row,null,[])}));
  t.mock.method(e,"readLegacyContinuationBinding",async()=>legacyBinding);t.mock.method(e,"authorizeLegacyContinuation",async()=>({canOperate:false,canReadCommission:false}));
  t.mock.method(e,"readLegacyContinuationHead",async()=>null);t.mock.method(e,"readLegacyContinuationEvidence",async()=>row);
  const handlers=new Map<string,any>(),app={getHttpAdapter:()=>({getInstance:()=>({use:(p:string,h:any)=>handlers.set(p,h)})})};
  mountOrderHandlers(app as Parameters<typeof mountOrderHandlers>[0],{pool,apiOrigin:"http://api.invalid",userOrigin:"http://user.invalid"} as OrderRuntimeOptions);
  const handler=handlers.get("/api/v1/orders"),body={expectedRevision:null,inputEvidenceId:"fixture_evidence",planFingerprint:"f".repeat(64)};
  const call=async(method:string,suffix:string,payload:Record<string,unknown>=body,key="ORIGINAL_KEY")=>{const r=response();await handler({method,originalUrl:`/api/v1/orders/legacy/${legacyBinding.id}/continuation${suffix}`,headers:{origin:"http://user.invalid","idempotency-key":key},body:payload},r);return r;};
  const assertBag=(bag:any)=>{assert.equal(Object.hasOwn(bag,who==="owner"?"payMoney":"saleEarnings"),false);assert.equal(Object.hasOwn(bag,who==="owner"?"saleEarnings":"payMoney"),true);assert.equal(Object.hasOwn(bag,"commissionPool"),false);};
  const first=await call("POST","/confirm");assert.equal(first.statusCode,200);assertBag((first.payload as any).amounts);assert.equal(Object.hasOwn(first.payload as object,"source"),false);
  const storedBefore=JSON.stringify(records.get("ORIGINAL_KEY"));assert.equal(records.get("ORIGINAL_KEY").responseBody.amounts.payMoney,"901.23");assert.equal(records.get("ORIGINAL_KEY").responseBody.amounts.saleEarnings,"163.27");
  const replay=await call("POST","/confirm");assert.equal(replay.statusCode,200);assertBag((replay.payload as any).amounts);assert.equal(applies,1);
  const receipt=await call("GET","/receipt?command=confirm&key=ORIGINAL_KEY");assert.equal(receipt.statusCode,200);assert.equal((receipt.payload as any).state,"KNOWN_SUCCESS");assertBag((receipt.payload as any).receipt.amounts);assert.equal(Object.hasOwn((receipt.payload as any).receipt,"facts"),false);
  const race=await call("POST","/confirm",body,"RACE_KEY");assert.equal(race.statusCode,200);assert.equal(raceInserted,true);assertBag((race.payload as any).amounts);assert.equal(applies,2);
  const get=await call("GET","");assert.equal(get.statusCode,200);assertBag((get.payload as any).continuation.amounts);
  const preview=await call("POST","/preview",{quantities:legacyQuantities("1.00")});assert.equal(preview.statusCode,200);assertBag((preview.payload as any).previewAmounts);assertBag((preview.payload as any).proposalAmounts);
  const absent=await call("GET","/receipt?command=confirm&key=ABSENT_KEY");assert.equal((absent.payload as any).state,"UNKNOWN");assert.equal(applies,2);
  currentUser="non_party";assert.equal((await call("GET","")).statusCode,404);assert.equal((await call("GET","/receipt?command=confirm&key=ORIGINAL_KEY")).statusCode,404);
  currentUser=who==="owner"?legacyBinding.ownerUserId:legacyBinding.renterUserId;allowed=false;assert.equal((await call("POST","/confirm")).statusCode,404);assert.equal(applies,2);
  assert.equal(JSON.stringify(records.get("ORIGINAL_KEY")),storedBefore);assert.equal(JSON.stringify(raw),rawBefore);
 });
});
