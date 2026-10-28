import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { PoolClient } from 'pg';
import * as identity from '../src/auth/user-identity';
import * as withdrawal from '../src/finance/native-withdrawal-store';
import * as account from '../src/finance/joinpay-account-store';
import { SecurityApiError } from '../src/auth/security-core';
import { mountChannelWithdrawalRoutes } from '../src/finance/controlled-withdrawal-routes';
import { readAdminOrderRefundSummary, readAdminJoinpayMerchantAccounts } from '../src/finance/channel-finance-read';

function harness(t:TestContext,configured=false){
 const state={calls:[] as string[],queries:[] as string[],user:'user_1',active:true,error:null as Error|null,scope:{}},handlers=new Map<string,Function>();
 t.mock.method(identity,'readUserContext',async()=>{state.calls.push('authenticate');if(!state.active)throw new SecurityApiError(401,'UNAUTHENTICATED','Session expired');return{userId:state.user,sessionId:'session_1'};});
 t.mock.method(withdrawal,'readNativeWithdrawalRecovery',async(...[_c,actor,scope,selector]:Parameters<typeof withdrawal.readNativeWithdrawalRecovery>)=>{state.calls.push('read');assert.equal(actor.userId,state.user);assert.equal(scope,state.scope);if(state.error)throw state.error;return{selector,bankArrival:'UNKNOWN'} as any;});
 t.mock.method(withdrawal,'quoteNativeWithdrawalInTransaction',async()=>{state.calls.push('quote');return{} as any;});
 t.mock.method(withdrawal,'createNativeWithdrawal',async(...[_p,actor,body,key]:Parameters<typeof withdrawal.createNativeWithdrawal>)=>{state.calls.push('reserve');assert.equal(actor.userId,state.user);return{status:200,body:{originalKey:key,body,replay:true}} as any;});
 const pool={connect:async()=>({query:async(sql:string)=>{state.queries.push(sql);return{rows:[]};},release(){}})};
 const options:any={pool,apiOrigin:'http://api',userOrigin:'http://user',adminOrigin:'http://admin',...(configured?{joinpayWithdrawal:{scope:state.scope,get initialProfile(){throw Error('GET_MUST_NOT_READ_PROFILE');}}}:{})};
 mountChannelWithdrawalRoutes({getHttpAdapter:()=>({getInstance:()=>({use:(p:string,h:Function)=>handlers.set(p,h)})})} as any,options);
 async function request(method:string,suffix:string,body?:object,extraHeaders:object={},bff=false){const response:any={statusCode:0,body:null,status(n:number){this.statusCode=n;return this;},setHeader(){return this;},json(b:unknown){this.body=b;return this;}};const prefix=bff?'/api/bff/user/channel-withdrawals':'/api/v1/users/me/channel-withdrawals';await handlers.get(prefix)!({method,originalUrl:prefix+suffix,headers:{origin:'http://user','x-request-id':'req_g345',...extraHeaders},body},response);return response;}
 return{state,request};
}
for(const bff of [false,true])test(`channel withdrawal ${bff?'BFF':'API'} default is authenticated unavailable without PG or command`,async t=>{const h=harness(t);const r=await h.request('GET','/receipt?key=original',undefined,{},bff);assert.equal(r.statusCode,503);assert.deepEqual(h.state.calls,['authenticate']);assert.equal(h.state.queries.length,0);});
test('anonymous and cross-origin requests cannot probe new withdrawal availability',async t=>{const h=harness(t);h.state.active=false;assert.equal((await h.request('GET','/intent_1')).statusCode,401);h.state.active=true;assert.equal((await h.request('POST','/quote',{}, {origin:'http://other'})).statusCode,403);assert.equal(h.state.queries.length,0);});
test('quote rejects reserve fields, client authority and duplicated recovery query',async t=>{const h=harness(t,true);assert.equal((await h.request('POST','/quote',{amountCents:'200',destinationId:'d',policyVersion:'p',expectedWalletVersion:'1'})).statusCode,400);assert.equal((await h.request('POST','/quote',{scope:{}})).statusCode,400);assert.equal((await h.request('GET','/receipt?key=a&key=b')).statusCode,400);assert(!h.state.calls.includes('quote'));});
test('new reserve requires one valid original idempotency key',async t=>{const h=harness(t,true),b={amountCents:'200',destinationId:'d',policyVersion:'p',expectedWalletVersion:'original'};for(const key of [undefined,'', 'not allowed'])assert.equal((await h.request('POST','/',b,key===undefined?{}:{'idempotency-key':key})).statusCode,400);assert(!h.state.calls.includes('reserve'));assert.equal((await h.request('POST','/',b,{'idempotency-key':'original_key'})).body.originalKey,'original_key');});
test('original-key local recovery does not read current profile or schedule execution',async t=>{const h=harness(t,true),r=await h.request('GET','/receipt?key=original_key');assert.equal(r.statusCode,200);assert.deepEqual(r.body.selector,{key:'original_key'});assert.equal(r.body.bankArrival,'UNKNOWN');assert.deepEqual(h.state.calls,['authenticate','read']);assert.deepEqual(h.state.queries,['BEGIN','COMMIT']);});
test('intent recovery stays with current user and propagates object denial',async t=>{const h=harness(t,true);h.state.user='other_user';h.state.error=new SecurityApiError(404,'NOT_FOUND','No such intent');assert.equal((await h.request('GET','/intent_1')).statusCode,404);assert.equal((await h.request('GET','/intent_1?merchant=m')).statusCode,404);assert(!h.state.calls.includes('reserve'));});

const refundInput={orderId:'order_1',origin:'NATIVE' as const,financeReadable:true};
const refundRow={id:'intent_1',refund_order_no:'original_no',amount_cents:'9007199254740993',currency:'CNY',state:'SUCCEEDED',budget_disposition:'CONSUMED',requires_review:false,terminal_evidence_id:'evidence_1',terminal_root_id:'root_1',terminal_event_id:'event_1',binding_matches:true};
function refundClient(rows:any[],ready=true,abnormalRows:any[]=[],postingRows:any[]=[{renter_refund_cents:'50',currency:'CNY'}]){const seen:any[]=[];return{seen,client:{query:async(sql:string,args:unknown[])=>{seen.push({sql,args});if(sql.includes('pg_attribute'))return{rows:[{ready}]};if(sql.includes("i.basis_kind='REVIEW_CONFIRMATION'"))return{rows:abnormalRows};if(sql.includes('FROM zzsh_order.settlement_posting p WHERE p.order_id'))return{rows:postingRows};return{rows};}} as unknown as PoolClient};}
test('refund finance and legacy cuts do not query schema or expose identifiers',async()=>{const c:any={query(){throw Error('UNAUTHORIZED_QUERY');}};assert.equal((await readAdminOrderRefundSummary(c,{...refundInput,financeReadable:false})).intents,null);assert.equal((await readAdminOrderRefundSummary(c,{...refundInput,origin:'LEGACY'})).integration,'NOT_APPLICABLE');});
test('missing formal schema remains unknown, not zero or an empty coverage claim',async()=>{const f=refundClient([],false),r=await readAdminOrderRefundSummary(f.client,refundInput);assert.equal(r.integration,'NOT_INTEGRATED');assert.equal(r.intents,null);assert.equal(f.seen.length,1);});
test('one bounded order query keeps exact cents and separates stored terminal from bank arrival',async()=>{const f=refundClient([refundRow]),r=await readAdminOrderRefundSummary(f.client,refundInput);assert.equal(f.seen.length,4);assert.deepEqual(f.seen[1].args,['order_1']);assert.match(f.seen[1].sql,/LIMIT 65/);assert.equal(r.intents![0]!.amount.cents,'9007199254740993');assert.equal(r.intents![0]!.localState,'SUCCEEDED');assert.equal(r.intents![0]!.bankArrival,'UNKNOWN');assert.equal(r.intents![0]!.mayResubmit,false);assert(!JSON.stringify(r).includes('profile'));assert.match(r.reasonCodes[0]!,/NOT_REVALIDATED/);});
for(const bad of [[{...refundRow,binding_matches:false}],Array.from({length:65},()=>refundRow),[{...refundRow,amount_cents:'1.5'}]])test(`inconsistent or excessive refund projection remains unavailable (${bad.length})`,async()=>{const r=await readAdminOrderRefundSummary(refundClient(bad).client,refundInput);assert.equal(r.integration,'UNAVAILABLE');assert.equal(r.intents,null);});
test('refund read keeps responsibility, budget partitions and the explicit 64 bound without a command',async()=>{
 const row={...refundRow,responsibility_cents:'50',merchant_identity_id:'merchant_a',payment_source:'JOINPAY',provider_refund_trx_no:'trx_1'};
 const r=await readAdminOrderRefundSummary(refundClient([row]).client,refundInput);
 assert.equal(r.limit,64);assert.equal(r.truncated,false);assert.equal(r.maySubmit,false);assert.equal(r.coverage,'COMPLETE_WITHIN_LIMIT');
 assert.equal(r.budget!.consumedCents,'9007199254740993');assert.equal(r.budget!.allocatedCents,'0');assert.equal(r.budget!.releasedCents,'0');
 assert.equal(r.intents![0]!.responsibilityCents,'50');assert.equal(r.intents![0]!.safeTarget,'ORIGINAL_CHANNEL');assert.equal(r.intents![0]!.providerRefundTrxNo,'trx_1');assert.equal(r.intents![0]!.maySubmit,false);
 const bounded=await readAdminOrderRefundSummary(refundClient(Array.from({length:65},()=>refundRow)).client,refundInput);
 assert.equal(bounded.integration,'UNAVAILABLE');assert.equal(bounded.truncated,true);assert.equal(bounded.maySubmit,false);assert.equal(bounded.intents,null);
});
test('merchant summary requires explicit merchant scope and exact resource before local reads',async t=>{let reads=0;t.mock.method(account,'readJoinpayAccountSummary',async(...[_c,_m,op]:Parameters<typeof account.readJoinpayAccountSummary>)=>{reads++;return{operation:op,latestVerifiedSnapshot:null,latestObservation:null} as any;});const c:any={query:async()=>({rows:[{database:'source',runtime_user:'runtime'}]})},input={adminId:'admin_1',merchantIdentityId:'merchant_1'},scope={database:'source',runtimeUser:'runtime',merchantIdsByAdmin:new Map([['admin_1',new Set(['merchant_1'])]])};await assert.rejects(readAdminJoinpayMerchantAccounts(c,input),(e:any)=>e.status===503);await assert.rejects(readAdminJoinpayMerchantAccounts(c,{...input,adminId:'other'},scope),(e:any)=>e.status===404);const r=await readAdminJoinpayMerchantAccounts(c,input,scope);assert.equal(reads,2);assert.equal(r.aggregateAssets,null);assert.equal(r.channelAsOf,null);assert.equal(r.bankArrival,'UNKNOWN');await assert.rejects(readAdminJoinpayMerchantAccounts(c,input,{...scope,database:'other'}),(e:any)=>e.status===503);assert.equal(reads,2);});


// C04B-02 abnormal REVIEW_CONFIRMATION admin summary
const ABN_ROOT = "native_abnormal_refund_liability_" + "d".repeat(40);
const ABN_EVENT = ABN_ROOT + "_recognized";
const ABN_CONFIRMATION = "pc_abn_01";
const abnormalRow = (overrides: Record<string, unknown> = {}) => ({
  intent_id: "rfi_abn_01", refund_order_no: "RF" + "a".repeat(28), amount_cents: "5000", currency: "CNY",
  state: "READY", budget_disposition: "ALLOCATED", requires_review: false,
  terminal_evidence_id: null, terminal_root_id: null, terminal_event_id: null, provider_refund_trx_no: null, completed_at: null,
  payment_confirmation_id: ABN_CONFIRMATION, liability_root_id: ABN_ROOT, liability_event_id: ABN_EVENT,
  responsibility_version_hash: "c".repeat(64), original_payment_trx_no: "trx_abn", original_payment_order_no: "ORDER_NO_1",
  merchant_identity_id: "merchant_a", created_at: "2026-10-26T11:00:00.000000Z", updated_at: "2026-10-26T11:00:00.000000Z",
  confirmation_order_id: "order_1", confirmation_source: "JOINPAY", disposition: "REVIEW_REQUIRED",
  reason_code: "LATE_PAYMENT", confirmation_currency: "CNY", confirmation_amount: "5000",
  merchant_scope_id: "merchant_a", provider_transaction_id: "trx_abn", merchant_order_no: "ORDER_NO_1",
  joinpay_request_id: "payreq_1", joinpay_evidence_id: "jpe_1", joinpay_anchor_id: "paytrx_1", renter_user_id: "user_1",
  request_channel: "JOINPAY", request_evidence_level: "JOINPAY_CANDIDATE", request_merchant: "merchant_a",
  request_order_no: "ORDER_NO_1", request_amount: "5000", request_currency: "CNY", formal_admission_ref: "ref_1",
  wire_merchant_no: "999900000000001", anchor_channel: "JOINPAY", anchor_evidence_level: "JOINPAY_VERIFIED",
  anchor_order: "order_1", anchor_request: "payreq_1", anchor_merchant: "merchant_a", anchor_trx: "trx_abn",
  root_kind: "NATIVE_ABNORMAL_REFUND", root_type: "NATIVE", root_system: "zzsh",
  root_entity: "joinpay_abnormal_refund_liability", root_source_id: ABN_CONFIRMATION, root_subject: "user_1",
  root_role: "RENTER", root_digest: "c".repeat(64), root_policy: null, root_basis: null,
  event_kind: "REFUND_LIABILITY_RECOGNIZED", event_root: ABN_ROOT, event_subject: "user_1",
  terminal_root_kind: null, terminal_root_source: null, terminal_root_subject: null,
  terminal_event_kind: null, terminal_event_root: null,
  liability_lines: "2", liability_line1: "1", liability_line2: "1", terminal_lines: "0", terminal_good: "0",
  evidence_terminal: null, evidence_trx: null, evidence_completed: null, submit_attempts: 0, blocked_count: 1,
  blocked_at: "2026-10-26T10:00:00.000000Z", blocked_reason: "ORIGINAL_ORDER_NO_AMBIGUOUS", ...overrides,
});

test("C04B-02 admin abnormal basis visible with one responsibility and blocked first submit", async () => {
  const r = await readAdminOrderRefundSummary(refundClient([], true, [abnormalRow()], []).client, refundInput);
  assert.equal(r.integration, "INTEGRATED");
  assert.equal(r.intents!.length, 1);
  assert.equal(r.intents![0]!.basisKind, "REVIEW_CONFIRMATION");
  assert.equal(r.intents![0]!.responsibilityCents, "5000");
  assert.equal(r.abnormalResponsibilities!.length, 1);
  assert.equal(r.abnormalResponsibilities![0]!.originalCents, "5000");
  assert.equal(r.abnormalResponsibilities![0]!.allocatedCents, "5000");
  assert.equal(r.abnormalResponsibilities![0]!.remainingCents, "0");
  assert.equal(r.abnormalResponsibilities![0]!.firstSubmit!.blockedReason, "ORIGINAL_ORDER_NO_AMBIGUOUS");
  assert.equal(r.responsibilityBudget!.originalCents, "5000");
  assert.equal(r.responsibilityBudget!.totalsComplete, true);
});

test("C04B-02 admin released retry does not double count the original responsibility", async () => {
  const released = abnormalRow({ intent_id: "rfi_released", state: "FAILED", budget_disposition: "RELEASED",
    terminal_evidence_id: "evidence_1", evidence_terminal: "FAILED_NO_EXECUTION", submit_attempts: 1,
    blocked_count: 0, blocked_at: null, blocked_reason: null, created_at: "2026-10-26T11:00:00.000000Z" });
  const active = abnormalRow({ intent_id: "rfi_active", created_at: "2026-10-26T12:00:00.000000Z" });
  const r = await readAdminOrderRefundSummary(refundClient([], true, [released, active], []).client, refundInput);
  assert.equal(r.integration, "INTEGRATED");
  assert.equal(r.abnormalResponsibilities!.length, 1);
  assert.equal(r.abnormalResponsibilities![0]!.allocatedCents, "5000");
  assert.equal(r.abnormalResponsibilities![0]!.releasedCents, "5000");
  assert.equal(r.responsibilityBudget!.originalCents, "5000");
  assert.equal(r.budget!.allocatedCents, "5000");
  assert.equal(r.budget!.releasedCents, "5000");
});

test("C04B-02 admin bad abnormal responsibility is explicit CONFLICT, other receipts stay readable", async () => {
  const good = abnormalRow({ blocked_count: 0, blocked_at: null, blocked_reason: null });
  const bad = abnormalRow({ intent_id: "rfi_bad", payment_confirmation_id: "pc_bad", liability_root_id: "other_root",
    liability_event_id: "other_event" });
  const r = await readAdminOrderRefundSummary(refundClient([], true, [good, bad], []).client, refundInput);
  assert.equal(r.integration, "INTEGRATED");
  assert.equal(r.abnormalResponsibilities!.length, 2);
  const valid = r.abnormalResponsibilities!.find(item => item.confirmationId === ABN_CONFIRMATION)!;
  const conflict = r.abnormalResponsibilities!.find(item => item.confirmationId === "pc_bad")!;
  assert.equal(valid.state, "READY"); assert.equal(valid.totalsComplete, true); assert.equal(valid.allocatedCents, "5000");
  assert.equal(conflict.state, "CONFLICT"); assert.equal(conflict.totalsComplete, false); assert.equal(conflict.allocatedCents, null);
  assert.equal(r.responsibilityBudget!.totalsComplete, false); assert.equal(r.responsibilityBudget!.originalCents, null);
  assert.ok(r.reasonCodes.includes("ABNORMAL_LIABILITY_MISMATCH"));
  assert.equal(r.intents!.length, 1); assert.equal(r.intents![0]!.intentId, "rfi_abn_01");
});

test("C04B-02 admin existing abnormal intent with unreadable confirmation is not hidden", async () => {
  const hidden = abnormalRow({ confirmation_order_id: "other_order", confirmation_source: null });
  const r = await readAdminOrderRefundSummary(refundClient([], true, [hidden], []).client, refundInput);
  assert.equal(r.integration, "INTEGRATED");
  assert.equal(r.abnormalResponsibilities!.length, 1);
  assert.equal(r.abnormalResponsibilities![0]!.state, "CONFLICT");
  assert.equal(r.responsibilityBudget!.totalsComplete, false);
  assert.ok(r.reasonCodes.includes("ABNORMAL_CONFIRMATION_MISMATCH"));
});


test("C04B-02 admin abnormal released retry and succeeded terminal stay separate", async () => {
  const released = abnormalRow({ intent_id: "rfi_released", state: "FAILED", budget_disposition: "RELEASED",
    terminal_evidence_id: "evidence_rel", evidence_terminal: "FAILED_NO_EXECUTION", submit_attempts: 1,
    blocked_count: 0, blocked_at: null, blocked_reason: null });
  const releasedResult = await readAdminOrderRefundSummary(refundClient([], true, [released], []).client, refundInput);
  assert.equal(releasedResult.integration, "INTEGRATED");
  assert.equal(releasedResult.abnormalResponsibilities![0]!.state, "RELEASED");
  assert.equal(releasedResult.abnormalResponsibilities![0]!.allocatedCents, "0");
  assert.equal(releasedResult.abnormalResponsibilities![0]!.releasedCents, "5000");
  assert.equal(releasedResult.budget!.releasedCents, "5000");
  const succeeded = abnormalRow({ intent_id: "rfi_succeeded", state: "SUCCEEDED", budget_disposition: "CONSUMED",
    terminal_evidence_id: "evidence_ok", terminal_root_id: "terminal_root", terminal_event_id: "terminal_event",
    provider_refund_trx_no: "CHTRX1", completed_at: "2026-10-26T12:00:00.000000Z",
    evidence_terminal: "SUCCEEDED", evidence_trx: "CHTRX1", evidence_completed: "2026-10-26T12:00:00.000000Z",
    terminal_root_kind: "NATIVE_RENTAL_REFUND", terminal_root_source: "rfi_succeeded", terminal_root_subject: "user_1",
    terminal_event_kind: "REFUND_PAID", terminal_event_root: "terminal_root", terminal_lines: "2", terminal_good: "2",
    submit_attempts: 1, blocked_count: 0, blocked_at: null, blocked_reason: null });
  const succeededResult = await readAdminOrderRefundSummary(refundClient([], true, [succeeded], []).client, refundInput);
  assert.equal(succeededResult.integration, "INTEGRATED");
  assert.equal(succeededResult.abnormalResponsibilities![0]!.state, "CONSUMED");
  assert.equal(succeededResult.abnormalResponsibilities![0]!.consumedCents, "5000");
  assert.equal(succeededResult.abnormalResponsibilities![0]!.remainingCents, "0");
  assert.equal(succeededResult.budget!.consumedCents, "5000");
  assert.equal(succeededResult.budget!.allocatedCents, "0");
});

test("Master R1: one bad receipt keeps the independently valid receipt readable",async()=>{
 const good=abnormalRow();
 const bad=abnormalRow({intent_id:"rfi_bad",payment_confirmation_id:"pc_bad",root_source_id:"pc_bad",liability_line2:"0"});
 const result=await readAdminOrderRefundSummary(refundClient([],true,[good,bad],[]).client,refundInput);
 assert.equal(result.integration,"INTEGRATED");
 assert.equal(result.abnormalResponsibilities!.length,2);
 const valid=result.abnormalResponsibilities!.find(r=>r.totalsComplete)!;
 const conflict=result.abnormalResponsibilities!.find(r=>!r.totalsComplete)!;
 assert.equal(valid.originalCents,"5000");assert.equal(valid.state,"REVIEW_REQUIRED");
 assert.equal(conflict.state,"CONFLICT");assert.equal(conflict.originalCents,null);
 assert.equal(result.responsibilityBudget!.totalsComplete,false);
 assert.equal(result.intents!.length,1);
});
