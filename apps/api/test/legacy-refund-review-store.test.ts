// The review stores an operator statement only; provider calls and database locks are tested separately.
import assert from "node:assert/strict";
import test from "node:test";
import {createHash} from "node:crypto";
import * as directory from "../src/auth/admin-directory";
import * as sessions from "../src/auth/admin-auth-session";
import * as authorization from "../src/auth/admin-authorization";
import * as core from "../src/auth/security-core";
import * as refundStore from "../src/order/channel-refund-store";
import * as profile from "../src/order/joinpay-refund-profile";
import * as command from "../src/order/legacy-continuation-command";
import * as evidence from "../src/order/legacy-continuation-evidence";
import * as model from "../src/order/legacy-continuation-model";
import * as source from "../src/order/legacy-refund-review-source";
import { readLegacyRefundReview, recordLegacyRefundReview, type LegacyRefundReviewCommand } from "../src/order/legacy-refund-review-store";
import { legacyBinding } from "./legacy-continuation-fixture";

const actor={realm:"admin" as const,userId:"support_1",sessionId:"session_1",requestId:"req_1"};
const sha=(value:string)=>createHash('sha256').update(value).digest('hex'),profileCanonical='{"kind":"SYNTHETIC_PROFILE"}',admissionCanonical='{"kind":"SYNTHETIC_ADMISSION"}';
const input:LegacyRefundReviewCommand={orderId:legacyBinding.id,dutyId:"duty_1",expectedDutyRevision:"1",expectedHeadRevision:"2",
 paymentOrderNo:"OLDPAY123",confirmedMerchantNo:"12345",paidCents:"10000",previouslyRefundedCents:"2000",priorAppliedToDutyCents:"2000",
 noUnresolvedRefunds:true,evidenceRef:"汇聚原单核对记录"};
const basis={orderId:legacyBinding.id,dutyId:"duty_1",dutyRevision:"1",dutyCents:"5000",sourceDigest:legacyBinding.sourceDigest,
 dutyEvidenceDigest:"b".repeat(64),renterUserId:legacyBinding.renterUserId,paymentRecordId:"9",paymentOrderNo:"OLDPAY123",paidCents:"10000",
 refundDueAt:"2026-11-01T00:00:00.000000Z",fundsDisposition:"AVAILABLE" as const,dutyState:"PENDING" as const};

function fixture(t:any, options:{nativeConflict?:boolean;legacyExists?:boolean;schemaPresent?:boolean;partialSchema?:boolean;dueAt?:string|null;canOperate?:boolean;noSettlement?:boolean}={}){
 const events:string[]=[],audits:any[]=[];
 const client={query:async(sql:string)=>{
  if(sql.includes("pg_advisory_xact_lock")){events.push("payment-lock");return{rows:[]};}
  if(sql.includes("FROM zzsh_supply.rental_account")){events.push("account");return{rows:[{id:"account"}],rowCount:1};}
  if(sql.includes("FROM zzsh_order.payment_confirmation")){events.push("native-check");return{rows:[{found:options.nativeConflict??false}]};}
  if(sql.includes("clock_timestamp()")){events.push("clock");return{rows:[{now:"2026-11-07T00:00:00.000000Z"}]};}
  if(sql.includes("to_regclass('zzsh_order.legacy_refund_case')")){events.push("schema");return{rows:[{casePresent:options.schemaPresent??false,intentPresent:options.partialSchema?false:options.schemaPresent??false}]};}
  if(sql.includes("FROM zzsh_order.legacy_refund_case")){events.push("legacy-check");return{rows:[{found:options.legacyExists??false}]};}
  throw Error("Unexpected SQL "+sql);
 }} as any;
 t.mock.method(profile,"assertFormalRefundProfile",()=>({merchantIdentityId:"merchant_1",reference:"admission_1",sha256:sha(admissionCanonical),canonical:admissionCanonical}) as any);
 t.mock.method(profile,"describeRefundProfile",()=>({merchantIdentityId:"merchant_1",merchantNo:"12345",profileId:"profile_1",profileSha256:sha(profileCanonical),keyVersionRef:"key_ref",notifyUrl:"https://fixture.invalid/refund",fundsAccount:"SETTLED"}) as any);
 t.mock.method(profile,"readRefundProfileEvidence",()=>profileCanonical);
 t.mock.method(refundStore,"assertRefundResource",async()=>"1");
 t.mock.method(evidence,"readLegacyContinuationBinding",async()=>legacyBinding);
 t.mock.method(evidence,"authorizeLegacyContinuation",async()=>({canOperate:options.canOperate??true,canReadCommission:false}));
 t.mock.method(evidence,"readLegacyContinuationEvidence",async()=>({} as any));
 t.mock.method(model,"readSealedLegacyFacts",()=>({evidence:{source:{paidPay:[{payOrderSn:"OLDPAY123"}]}}} as any));
 t.mock.method(directory,"lockActor",async()=>{events.push("admin-lock");return {status:"ACTIVE",isBoss:false,passwordChangeRequired:false,permissions:new Set(options.noSettlement?[]:["order.settlement.write"])} as any;});
 t.mock.method(sessions,"assertAdminCommandAuthorizedInTransaction",async()=>{events.push("session");return {} as any;});
 t.mock.method(authorization,"loadEffectiveAdminAccess",async()=>({status:"ACTIVE",isBoss:false,passwordChangeRequired:false,permissions:new Set(options.noSettlement?[]:["order.settlement.write"])} as any));
 t.mock.method(command,"authorizeLegacyMutation",async()=>{events.push("parties");return {binding:legacyBinding,userIds:[],actor} as any;});
 t.mock.method(evidence,"lockLegacyContinuationOrder",async()=>{events.push("order-lock");return {head:{id:"head_1",revision:"2"},duties:[{id:"duty_1",revision:"1"}]} as any;});
 t.mock.method(source,"readLockedLegacyRefundSource",async()=>{events.push("source");return {...basis,...(options.dueAt===undefined?{}:{refundDueAt:options.dueAt})};});
 t.mock.method(core,"recordAudit",async(_client:any,value:any)=>{events.push("audit");audits.push(value);});
 return {client,events,audits,execution:{admission:{} as any,profile:{} as any}};
}

test("manual review binds the original payment and frozen duty while only writing an audit",async t=>{
 const f=fixture(t), result=await recordLegacyRefundReview(f.client,actor,input,f.execution);
 assert.equal(result.refundCents,"3000");assert.equal(result.channelResult,"NOT_SUBMITTED");
 assert.deepEqual(f.events,["admin-lock","session","payment-lock","payment-lock","payment-lock","payment-lock","parties","account","order-lock","source","native-check","clock","schema","audit"]);
 assert.equal(f.audits.length,1);assert.equal(f.audits[0].actorId,actor.userId);
 assert.equal(f.audits[0].details.source,"STAFF_REVIEW");assert.equal(f.audits[0].details.priorAppliedToDutyCents,"2000");
 assert.equal(f.audits[0].details.refundCents,"3000");
 assert.equal(f.audits[0].details.profileId,"profile_1");assert.equal(f.audits[0].details.admissionRef,"admission_1");
 assert.match(result.reviewDigest,/^[a-f0-9]{64}$/);assert.equal(f.audits[0].details.reviewDigest,result.reviewDigest);
});

test("native or legacy payment conflicts block the review without recording an attestation",async t=>{
 for(const options of [{nativeConflict:true},{schemaPresent:true,legacyExists:true},{schemaPresent:true,partialSchema:true}]){
  const f=fixture(t,options);await assert.rejects(recordLegacyRefundReview(f.client,actor,input,f.execution));
  assert.equal(f.audits.length,0);t.mock.restoreAll();
 }
});

test("a staff member without settlement permission cannot attest to a refund",async t=>{
 const f=fixture(t,{noSettlement:true});
 await assert.rejects(recordLegacyRefundReview(f.client,actor,input,f.execution));
 assert.deepEqual(f.events,["admin-lock","session"]);assert.equal(f.audits.length,0);
});

test("changed merchant, order, deadline or unverifiable prior refunds fail closed",async t=>{
 const cases:Array<Partial<LegacyRefundReviewCommand>>=[{confirmedMerchantNo:"12346"},{paymentOrderNo:"OTHER"},
  {expectedDutyRevision:"2"},{noUnresolvedRefunds:false},{previouslyRefundedCents:"9000",priorAppliedToDutyCents:"0"},{evidenceRef:""}];
 for(const change of cases){const f=fixture(t);await assert.rejects(recordLegacyRefundReview(f.client,actor,{...input,...change},f.execution));assert.equal(f.audits.length,0);t.mock.restoreAll();}
 for(const dueAt of [null,"2026-11-08T00:00:00.000000Z"]){const f=fixture(t,{dueAt});await assert.rejects(recordLegacyRefundReview(f.client,actor,input,f.execution));assert.equal(f.audits.length,0);t.mock.restoreAll();}
});

test("reading an audit rejects changed facts, actor and object references",async t=>{
 const f=fixture(t),result=await recordLegacyRefundReview(f.client,actor,input,f.execution),audit=f.audits[0];
 const original={actor_type:audit.actorType,actor_id:audit.actorId,session_id:audit.sessionId,
  request_id:audit.requestId,reason:audit.reason,outcome:audit.outcome,details:audit.details};
 let row:any=structuredClone(original), count=1;
 const query=f.client.query;
 f.client.query=async(sql:string,...args:any[])=>sql.includes("FROM zzsh_iam.audit_event")?{rows:Array.from({length:count},()=>row)}:query(sql,...args);
 const read=()=>readLegacyRefundReview(f.client,actor,input.orderId,input.dutyId,result.reviewId);
 assert.equal((await read()).reviewDigest,result.reviewDigest);
 for(const mutate of [
  (r:any)=>{r.details.refundCents="3001";}, (r:any)=>{r.details.dutyId="other";},
  (r:any)=>{r.details.orderId="other";}, (r:any)=>{r.details.profileSha256="a".repeat(64);},
  (r:any)=>{r.actor_id="other";}, (r:any)=>{r.session_id="other";},
  (r:any)=>{r.request_id="other";}, (r:any)=>{r.reason="other";}, (r:any)=>{r.outcome="FAILURE";},
 ]){row=structuredClone(original);mutate(row);await assert.rejects(read());}
 row=structuredClone(original);
 for(const n of [0,2]){count=n;await assert.rejects(read());}
 t.mock.restoreAll();
 const denied=fixture(t,{canOperate:false});
 await assert.rejects(readLegacyRefundReview(denied.client,actor,input.orderId,input.dutyId,result.reviewId));
 t.mock.restoreAll();
 const noSettlement=fixture(t,{noSettlement:true});
 await assert.rejects(readLegacyRefundReview(noSettlement.client,actor,input.orderId,input.dutyId,result.reviewId));
});
