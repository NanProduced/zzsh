import {test} from "node:test";
import assert from "node:assert/strict";
import type {PoolClient} from "pg";
import * as directory from "../src/auth/admin-directory";
import * as sessions from "../src/auth/admin-auth-session";
import * as access from "../src/auth/admin-authorization";
import * as command from "../src/order/legacy-continuation-command";
import * as evidence from "../src/order/legacy-continuation-evidence";
import * as basis from "../src/order/legacy-duty-basis";
import * as finance from "../src/finance/legacy-duty-finance";
import * as funding from "../src/finance/legacy-duty-funding";
import * as financeStore from "../src/finance/legacy-duty-finance-store";
import * as refundSource from "../src/order/legacy-refund-review-source";
import {authorizeLegacyFinanceDuty,postLegacyFinanceDuty,projectLegacyFinanceDutyReceipt} from "../src/order/legacy-finance-duty";
import {legacyBinding} from "./legacy-continuation-fixture";

const actor={realm:"admin" as const,userId:"support_1",sessionId:"session_1",requestId:"request_1"},digest="a".repeat(64);
const ref={type:"LEDGER_ENTRY",id:"ledger_1",digest},input={dutyId:"duty_1",expectedRevision:"1",reason:"核对旧单结算"};
function fixture(t:any,options:{historyUnknown?:boolean;changedBeneficiary?:boolean;noPermission?:boolean;noFinance?:boolean;commission?:boolean;pending?:boolean;cancelScope?:string;recordedRefund?:boolean}={}){
 const calls:string[]=[],userIds=[legacyBinding.ownerUserId,legacyBinding.renterUserId].sort(),authority={binding:legacyBinding,userIds,actor,financeDutyKind:options.commission?"COMMISSION" as const:"OWNER_CREDIT" as const};
 let posted=false;
 const duty={id:"duty_1",orderId:legacyBinding.id,kind:options.commission?"COMMISSION":"OWNER_CREDIT",counterpartyUserId:options.commission?legacyBinding.renterUserId:legacyBinding.ownerUserId,amountCents:"1000",currency:"CNY",
  status:options.commission&&!options.pending?"MATURED":"PENDING",revision:"1",settledBy:null,source:"CONTINUATION",sourceStatus:null,sourceRecordId:"version_1",continuationVersionId:"version_1",admissionId:null,
  maturityAt:null,settledRefType:null,settledRefId:null,settledRefDigest:null} as any;
 const client={query:async(sql:string)=>{
  if(sql.includes("rental_account"))return{rows:[{id:legacyBinding.accountId}],rowCount:1};
  if(sql.includes("FROM pg_proc"))return{rows:[{ready:true}]};
  if(sql.includes("paymentReviewScope"))return{rows:[{scope:options.cancelScope,marker:null}]};
  if(sql.includes('INSERT INTO "zzsh_iam"."audit_event"')){calls.push("audit");return{rows:[],rowCount:1};}
  if(sql.includes("clock_timestamp()"))return{rows:[{now:"2026-11-07T00:00:00.000000Z"}]};
  if(sql.includes("post_legacy_finance_duty")){calls.push("post");posted=true;return{rows:[{result:{dutyId:duty.id,orderId:duty.orderId,amountCents:duty.amountCents,reference:{digest}}}]};}
  throw Error("Unexpected SQL "+sql);
 }} as unknown as PoolClient;
 t.mock.method(directory,"lockActor",async()=>({passwordChangeRequired:false}) as any);
 t.mock.method(sessions,"assertAdminCommandAuthorizedInTransaction",async()=>({}) as any);
 t.mock.method(access,"loadEffectiveAdminAccess",async()=>({status:"ACTIVE",isBoss:false,passwordChangeRequired:false,permissions:new Set(options.noPermission?[]:options.noFinance?["order.settlement.write"]:["order.settlement.write","finance.document.read"])}) as any);
 t.mock.method(command,"authorizeLegacyMutation",async()=>authority as any);
 t.mock.method(evidence,"readLegacyContinuationUserIds",async()=>options.changedBeneficiary?[...userIds,"changed"]:userIds);
 t.mock.method(evidence,"readLegacyContinuationBinding",async()=>legacyBinding);
 t.mock.method(evidence,"lockLegacyContinuationOrder",async()=>({head:null,duties:[posted?{...duty,status:"SETTLED",settledBy:"FINANCE",revision:"2"}:duty]}));
 t.mock.method(basis,"readLegacyDutyBasis",async()=>({state:"KNOWN"}) as any);
 t.mock.method(finance,"legacyDutyBasisFromTrade",()=>({knowledge:"KNOWN",basis:{evidenceDigest:digest,...(options.cancelScope?{kind:"SUPPORT_CANCELLED_CONTINUATION",continuationVersionId:"version_1"}:{})}}) as any);
 t.mock.method(refundSource,"hasLegacyRecordedRefunds",async()=>options.recordedRefund===true);
 t.mock.method(funding,"readLegacyDutyFundingProof",async()=>options.historyUnknown?{knowledge:"UNKNOWN",reason:"SOURCE_UNCLEAR"}:{knowledge:"KNOWN",proof:{fixture:true}} as any);
 t.mock.method(finance,"planLegacyDutyFinalization",()=>({canonical:"{}",factDigest:digest}) as any);
 t.mock.method(financeStore,"readAdminLegacyDutyFinances",async()=>new Map([[duty.id,{dutyId:duty.id,orderId:duty.orderId,kind:duty.kind,subjectId:duty.counterpartyUserId,
  knowledge:"KNOWN",finalization:"POSTED",amountCents:duty.amountCents,parentSourceDigest:legacyBinding.sourceDigest,reference:ref} as any]]));
 return{client,calls,authority};
}

test("owner credit requires live admin permission and exact source proof before posting",async t=>{
 const f=fixture(t,{noPermission:true});await assert.rejects(authorizeLegacyFinanceDuty(f.client,actor,legacyBinding.id,"OWNER_CREDIT"));assert.deepEqual(f.calls,[]);t.mock.restoreAll();
 const wrongRequest=fixture(t);await assert.rejects(postLegacyFinanceDuty(wrongRequest.client,{...actor,requestId:"other-request"},legacyBinding.id,"OWNER_CREDIT",input,wrongRequest.authority));assert.deepEqual(wrongRequest.calls,[]);
 t.mock.restoreAll();
 for(const options of [{historyUnknown:true},{changedBeneficiary:true}]){
  const x=fixture(t,options);await assert.rejects(postLegacyFinanceDuty(x.client,actor,legacyBinding.id,"OWNER_CREDIT",input,x.authority));assert.deepEqual(x.calls,[]);t.mock.restoreAll();
 }
});
test("previously unavailable cancellation can credit only after an explicit recorded recheck",async t=>{
 const f=fixture(t,{cancelScope:"UNAVAILABLE"});
 await assert.rejects(postLegacyFinanceDuty(f.client,actor,legacyBinding.id,"OWNER_CREDIT",input,f.authority),/REFUND_HISTORY_REQUIRES_OFFLINE/);
 const result=await postLegacyFinanceDuty(f.client,actor,legacyBinding.id,"OWNER_CREDIT",{...input,originalPaymentChecked:true},f.authority);
 assert.equal(result.body.status,"SETTLED");assert.deepEqual(f.calls,["audit","post"]);t.mock.restoreAll();
 const blocked=fixture(t,{cancelScope:"UNAVAILABLE",recordedRefund:true});
 await assert.rejects(postLegacyFinanceDuty(blocked.client,actor,legacyBinding.id,"OWNER_CREDIT",{...input,originalPaymentChecked:true},blocked.authority),/REFUND_HISTORY_REQUIRES_OFFLINE/);
 assert.deepEqual(blocked.calls,[]);
});
test("owner credit posts only the frozen duty and verifies the resulting receipt",async t=>{
 const f=fixture(t),authority=await authorizeLegacyFinanceDuty(f.client,actor,legacyBinding.id,"OWNER_CREDIT");
 const result=await postLegacyFinanceDuty(f.client,actor,legacyBinding.id,"OWNER_CREDIT",input,authority);
 assert.deepEqual(f.calls,["post"]);assert.equal(result.body.status,"SETTLED");assert.equal(result.body.amountCents,"1000");
 assert.equal(result.body.channelArrival,"UNKNOWN");assert.deepEqual(await projectLegacyFinanceDutyReceipt(f.client,legacyBinding.id,"OWNER_CREDIT",result.body),result.body);
 await assert.rejects(projectLegacyFinanceDutyReceipt(f.client,legacyBinding.id,"OWNER_CREDIT",{...result.body,amountCents:"1001"}));
 await assert.rejects(projectLegacyFinanceDutyReceipt(f.client,legacyBinding.id,"OWNER_CREDIT",{...result.body,reference:{...ref,digest:"b".repeat(64)}}));
});
test("commission credit requires finance access and a matured original duty",async t=>{
 const denied=fixture(t,{commission:true,noFinance:true});await assert.rejects(authorizeLegacyFinanceDuty(denied.client,actor,legacyBinding.id,"COMMISSION"));assert.deepEqual(denied.calls,[]);t.mock.restoreAll();
 const wrongKind=fixture(t);await assert.rejects(postLegacyFinanceDuty(wrongKind.client,actor,legacyBinding.id,"COMMISSION",input,wrongKind.authority));assert.deepEqual(wrongKind.calls,[]);t.mock.restoreAll();
 const pending=fixture(t,{commission:true,pending:true});await assert.rejects(postLegacyFinanceDuty(pending.client,actor,legacyBinding.id,"COMMISSION",input,pending.authority));assert.deepEqual(pending.calls,[]);t.mock.restoreAll();
 const matured=fixture(t,{commission:true}),authority=await authorizeLegacyFinanceDuty(matured.client,actor,legacyBinding.id,"COMMISSION");
 const result=await postLegacyFinanceDuty(matured.client,actor,legacyBinding.id,"COMMISSION",input,authority);assert.equal(result.body.status,"SETTLED");assert.deepEqual(matured.calls,["post"]);
});
