import {test} from "node:test";
import assert from "node:assert/strict";
import {canonicalize} from "../src/supply/content-hash";
import {sha256Hex} from "../src/supply/supply-util";
import {contributionFromSettlement} from "../src/auth/membership-growth";
import {planLegacyContinuation} from "../src/order/legacy-continuation-calc";
import {deriveLegacyFacts,initialLegacyFacts} from "../src/order/legacy-continuation-model";
import {projectLegacyGrowthConsumption,projectLegacyGrowthCorrection,closeLegacyGrowthCoverage,type LegacyGrowthConsumptionInput,type LegacyGrowthCoverageReceipt} from "../src/order/legacy-growth-consumption";
import {legacyBinding,legacyEvidence,legacyQuantities,legacySource} from "./legacy-continuation-fixture";
const proof=(x:unknown)=>{const canonical=canonicalize(x);return {canonical,digest:sha256Hex(canonical)};};
function continuation():LegacyGrowthConsumptionInput{
 const source=initialLegacyFacts(legacySource()),p={kind:"propose" as const,caller:{role:"renter" as const,legacyUserId:"11"},quantities:legacyQuantities("1.00")},planned=planLegacyContinuation(source.evidence,p);assert(planned.ok);
 const before={...legacyEvidence(deriveLegacyFacts(source,planned,p,"original","proposed")),id:"proposal_result",sourceKind:"DERIVED" as const,evidenceVersion:"2"},c={kind:"confirm" as const,caller:{role:"owner" as const,legacyUserId:"22"}},plan=planLegacyContinuation(before.facts.evidence,c);assert(plan.ok);
 const result={...legacyEvidence(deriveLegacyFacts(before.facts,plan,c,before.id,"confirmed")),id:"confirmed_result",sourceKind:"DERIVED" as const,evidenceVersion:"3"};
 return {binding:legacyBinding,subjectUserId:legacyBinding.renterUserId,recordedAt:"2026-10-16T02:00:01.000000Z",origin:{kind:"CONTINUATION_CONFIRM",input:before,result,command:{id:"confirmed",revision:"2",createdAt:"2026-10-16T02:00:00.123456Z",inputEvidenceId:before.id,resultEvidenceId:result.id,planFingerprint:plan.fingerprint,actor:{realm:"user",userId:legacyBinding.ownerUserId,sessionId:"fixture",requestId:"req_fixture"}}}};
}
function historical():LegacyGrowthConsumptionInput{
 const completedAt="2026-10-01T01:02:03.000000Z",raw={id:"7",user_id:"11",sale_user_id:"22",accounts_id:"33",order_status:"4",pay_is:"1",pay_money:"100.00",return_order_money:"87.00",confirm_time:String(Date.parse(completedAt)/1000)},parentSourceDigest=sha256Hex(canonicalize(raw)),sourceRecord=proof({...raw,detain_money:"5.00"});
 const components=proof({schema:"legacy-consumption-components.v1",parentSourceDigest,basisDigest:sourceRecord.digest,legacyOrderId:"7",oldRuleEvidenceRef:"FIXTURE_ORIGINAL_CONFIRMED_COMPONENTS",rentalCents:"1000",materialCents:"200",minimumBillingCents:"100",minimumAgreementRef:"FIXTURE_PRIOR_AGREEMENT"});
 return {binding:{...legacyBinding,sourceDigest:parentSourceDigest,sourceOrderStatus:4,completedAt},subjectUserId:legacyBinding.renterUserId,recordedAt:"2026-10-16T02:00:00.000000Z",origin:{kind:"LEGACY_COMPLETED",parentSourceSnapshot:raw,sourceRecord,components}};
}
test("original confirmed resource components feed the existing E adapter; net refund, deposits, owner and commission never add consumption",()=>{
 const input=continuation(),result=projectLegacyGrowthConsumption(input);assert.equal(result.knowledge,"KNOWN",result.reason??"");assert.deepEqual(result.facts.map(f=>[f.component,f.amountCents]),[["RENTAL_SETTLEMENT","1300"],["MATERIAL_CONSUMPTION","0"]]);
 assert.equal(result.observedResourceChargeCents,"1300");assert(result.facts.every(f=>f.userId===legacyBinding.renterUserId && f.effectiveAt==="2026-10-16T02:00:00.123456Z"));assert(result.facts.every(f=>contributionFromSettlement(f).accepted));
 const wrong=structuredClone(input);wrong.subjectUserId=legacyBinding.ownerUserId;assert.equal(projectLegacyGrowthConsumption(wrong).knowledge,"UNKNOWN");
 if(input.origin.kind!=="CONTINUATION_CONFIRM")assert.fail();input.origin.result.facts.amounts.refundNet="0";assert.equal(projectLegacyGrowthConsumption(input).knowledge,"UNKNOWN");
});
test("historical completed input needs admitted old component proof and original time, without current baseBot or new settlement pricing",()=>{
 const input=historical();assert.equal(projectLegacyGrowthConsumption(input).reason,"COMPONENT_EVIDENCE_NOT_ADMITTED");if(input.origin.kind!=="LEGACY_COMPLETED")assert.fail();
 const result=projectLegacyGrowthConsumption(input,new Set([input.origin.components.digest]));assert.equal(result.knowledge,"KNOWN",result.reason??"");assert.deepEqual(result.facts.map(f=>f.amountCents),["1000","200","100"]);assert.equal(result.facts[0]!.effectiveAt,"2026-10-01T01:02:03.000000Z");
 const p=JSON.parse(input.origin.components.canonical);p.minimumAgreementRef=null;input.origin.components=proof(p);assert.equal(projectLegacyGrowthConsumption(input,new Set([input.origin.components.digest])).reason,"MINIMUM_BILLING_AGREEMENT_UNPROVEN");
});
test("a price correction preserves original source/time and known previous amount; refund records cannot double subtract the unused gross refund",()=>{
 const base=projectLegacyGrowthConsumption(continuation()).facts[0]!;
 const value={schema:"legacy-growth-correction.v1",originalSourceKey:`${base.component}:${base.settlementId}`,userId:base.userId,originalEffectiveAt:base.effectiveAt,previousAmountCents:base.amountCents,correctedAmountCents:"1100",classification:"EFFECTIVE_PRICE_CORRECTION",alreadyReflectedInGrossReturn:false,sourceSystem:"legacy_mysql_restore",sourceEntity:"fixture_price_correction",sourceId:"93",recordedAt:"2026-10-17T00:00:00.000000Z",revision:3},p=proof(value);
 assert.throws(()=>projectLegacyGrowthCorrection(base,p,new Set()),/NOT_ADMITTED/);const result=projectLegacyGrowthCorrection(base,p,new Set([p.digest]));assert.equal(result.effectiveAt,base.effectiveAt);assert.equal(result.previousAmountCents,"1300");assert.equal(result.amountCents,"1100");assert.equal(result.correctionMode,"REPLACE");assert(contributionFromSettlement(result).accepted);
 const twice=proof({...value,alreadyReflectedInGrossReturn:true});assert.throws(()=>projectLegacyGrowthCorrection(base,twice,new Set([twice.digest])),/CORRECTION_BINDING_CONFLICT/);
});
test("full scoped source receipt and exact set closure are required; no extraction or zero rows never certify user completeness",()=>{
 const row=projectLegacyGrowthConsumption(continuation()),subject=legacyBinding.renterUserId;assert.equal(closeLegacyGrowthCoverage(subject,[],null).state,"BACKFILL_PENDING");
 const receipt:LegacyGrowthCoverageReceipt={subjectUserId:subject,cutoff:"2026-10-16T03:00:00.000000Z",fromExclusive:null,sourceExtractSha256:"b".repeat(64),sourceSetSha256:"",expectedSourceKeys:[row.sourceKey],refundReviewEvidenceRefs:["FIXTURE_COMPLETE_REFUND_SCAN"]};
 receipt.sourceSetSha256=sha256Hex(canonicalize({subjectUserId:subject,cutoff:receipt.cutoff,fromExclusive:null,expectedSourceKeys:receipt.expectedSourceKeys}));const allowed=new Set([sha256Hex(canonicalize(receipt))]);
 assert.equal(closeLegacyGrowthCoverage(subject,[row],receipt).state,"BACKFILL_PENDING");assert.equal(closeLegacyGrowthCoverage(subject,[row],receipt,allowed).state,"COMPLETE");const missing=closeLegacyGrowthCoverage(subject,[],receipt,allowed);assert.equal(missing.state,"BACKFILL_PENDING");assert.deepEqual(missing.missingSourceKeys,[row.sourceKey]);assert.equal(closeLegacyGrowthCoverage(subject,[row,row],receipt,allowed).state,"SOURCE_CONFLICT");
});

function cancelled(prepaid="30.00",patch:Record<string,string|null>={}){
 const at=Date.parse("2026-10-01T01:00:00Z")/1000,t=(n:number)=>String(at+n),subjectUserId=legacyBinding.renterUserId;
 const row:Record<string,string|null>={id:"7",order_sn:"FIXTURE_O7",user_id:"11",sale_user_id:"22",accounts_id:"33",order_status:"5",pay_is:"1",
  pay_money:"100.00",need_pay_money:"100.00",expend_pay_money:prepaid,express_is:"0",is_settle:"0",express_time:"0",confirm_time:"0",expend_haff:null,return_order_money:null,
  pay_time:t(0),cancel_time:t(60),awm_bullet_num:null,level6_bullet_num:null,level6_helmet_num:null,level6_armor_num:null,top_insure_card_num:null,barrett_bullet_num:"0",coffee_num:null,...patch};
 const sourceRecord=proof(row),sourceDigest=sourceRecord.digest;
 const payment=proof({id:"91",order_id:"7",order_type:"1",pay_is:"1",pay_money:"100.00",pay_time:t(0)});
 const refund=proof({id:"92",order_id:"7",order_sn:"FIXTURE_O7",order_type:"order",user_id:"11",refund_type:"1",refund_status:"1",order_amount:"100.00",refund_amount:"100.00",create_time:t(60),update_time:t(61)});
 const log=proof({id:"93",record_id:"92",user_id:"11",refund_status:"1",order_amount:"100.00",refund_amount:"100.00",create_time:t(60),update_time:t(61)});
 const cutoff="2026-10-16T03:00:00.000000Z",components=proof({schema:"legacy-consumption-exclusion.v1",classification:"PAID_CANCELLED_UNCONSUMED",parentSourceDigest:sourceDigest,basisDigest:sourceRecord.digest,
  legacyOrderId:"7",subjectUserId,cutoff,oldRuleEvidenceRef:"FIXTURE_ORIGINAL_UNFULFILLED_CANCEL_AND_FULL_REFUND",
  payment:{sourceSystem:"legacy_mysql_restore",sourceEntity:"la_pay_order",extractSha256:"a".repeat(64),records:[payment]},
  refundRecord:{sourceSystem:"legacy_mysql_restore",sourceEntity:"la_refund_record",extractSha256:"b".repeat(64),records:[refund]},
  refundLog:{sourceSystem:"legacy_mysql_restore",sourceEntity:"la_refund_log",extractSha256:"c".repeat(64),records:[log]}});
 const input:LegacyGrowthConsumptionInput={binding:{...legacyBinding,sourceDigest,sourceOrderStatus:5,completedAt:null},subjectUserId,recordedAt:"2026-10-16T02:00:00.000000Z",
  origin:{kind:"LEGACY_CANCELLED_UNCONSUMED",parentSourceSnapshot:row,sourceRecord,components}};
 const receipt:LegacyGrowthCoverageReceipt={subjectUserId,cutoff,fromExclusive:null,sourceExtractSha256:"d".repeat(64),sourceSetSha256:"",expectedSourceKeys:["legacy_mysql_restore:la_order:7"],
  refundReviewEvidenceRefs:[components.digest,refund.digest,log.digest]};
 receipt.sourceSetSha256=sha256Hex(canonicalize({subjectUserId,cutoff,fromExclusive:null,expectedSourceKeys:receipt.expectedSourceKeys}));
 return{input,receipt};
}
function projectCancelled(x:ReturnType<typeof cancelled>){
 if(x.input.origin.kind!=="LEGACY_CANCELLED_UNCONSUMED")assert.fail();
 return projectLegacyGrowthConsumption(x.input,new Set([x.input.origin.components.digest]),x.receipt);
}
function changeCancelledProof(x:ReturnType<typeof cancelled>,field:"payment"|"refundRecord"|"refundLog",patch:Record<string,string>){
 if(x.input.origin.kind!=="LEGACY_CANCELLED_UNCONSUMED")assert.fail();
 const value=JSON.parse(x.input.origin.components.canonical),row=JSON.parse(value[field].records[0].canonical);value[field].records=[proof({...row,...patch})];
 x.input.origin.components=proof(value);x.receipt.refundReviewEvidenceRefs=[x.input.origin.components.digest,value.refundRecord.records[0].digest,value.refundLog.records[0].digest];
}

test("unfulfilled fully refunded orders exclude the original prepaid material fee without inventing a refund channel result",()=>{
 for(const amount of ["0.00","30.00","100.00"]){const x=cancelled(amount),before=structuredClone(x),p=projectCancelled(x);assert.equal(p.knowledge,"EXCLUDED",p.reason??"");assert.equal(p.reason,"CANCELLED_UNCONSUMED");assert.deepEqual(p.facts,[]);assert.equal(p.observedResourceChargeCents,null);assert.deepEqual(x,before);
  const closed=closeLegacyGrowthCoverage(x.input.subjectUserId,[p],x.receipt,new Set([sha256Hex(canonicalize(x.receipt))]));assert.equal(closed.state,"COMPLETE");assert.deepEqual(closed.facts,[]);}
});

test("cancellation cannot erase positive material consumption, fulfilled sources or existing measured settlement fields",()=>{
 for(const field of ["awm_bullet_num","level6_bullet_num","level6_helmet_num","level6_armor_num","top_insure_card_num","barrett_bullet_num","coffee_num"]){
  assert.equal(projectCancelled(cancelled("0.00",{[field]:"1"})).reason,"CANCELLATION_NOT_UNCONSUMED",field);
  assert.equal(projectCancelled(cancelled("30.00",{[field]:"0"})).knowledge,"EXCLUDED",field);
 }
 const measured:Array<Record<string,string|null>>=[{expend_haff:"0.00"},{expend_haff:"1.00"},{return_order_money:"0.00"},{return_order_money:"100.00"},{express_is:"1"},{express_time:"1790816460"},{is_settle:"1"}];
 for(const patch of measured)assert.equal(projectCancelled(cancelled("30.00",patch)).reason,"CANCELLATION_NOT_UNCONSUMED");
});

test("prepaid material amount must remain a proven nonnegative portion of the original paid amount",()=>{
 for(const value of [null,"-0.01","not-money","100.01"]){const p=projectCancelled(cancelled("30.00",{expend_pay_money:value}));assert.equal(p.knowledge,"UNKNOWN",String(value));}
 assert.equal(projectCancelled(cancelled("30.00",{pay_money:"99.00"})).knowledge,"UNKNOWN");
});

test("full refund exclusion keeps exact typed payment, source party, order number, amount, status and time lineage",()=>{
 for(const [field,patch]of [
  ["payment",{order_type:"2"}],["payment",{pay_money:"99.00"}],
  ["refundRecord",{order_id:"8"}],["refundRecord",{order_sn:"ANOTHER_ORDER"}],["refundRecord",{user_id:"22"}],
  ["refundRecord",{refund_amount:"99.00"}],["refundRecord",{refund_status:"0"}],["refundRecord",{update_time:"0"}],
  ["refundLog",{record_id:"99"}],["refundLog",{user_id:"22"}],["refundLog",{refund_amount:"99.00"}],["refundLog",{refund_status:"0"}],["refundLog",{update_time:"9999999999"}],
 ] as const){const x=cancelled();changeCancelledProof(x,field,patch);assert.equal(projectCancelled(x).knowledge,"UNKNOWN",JSON.stringify([field,patch]));}
});

test("refund flags or a proof alone cannot replace scoped source receipt, admitted components or original parent binding",()=>{
 const x=cancelled();if(x.input.origin.kind!=="LEGACY_CANCELLED_UNCONSUMED")assert.fail();
 assert.equal(projectLegacyGrowthConsumption(x.input,new Set([x.input.origin.components.digest])).reason,"CANCELLATION_SCOPE_UNPROVEN");
 assert.equal(projectLegacyGrowthConsumption(x.input,new Set(),x.receipt).reason,"COMPONENT_EVIDENCE_NOT_ADMITTED");
 x.receipt.refundReviewEvidenceRefs=[];assert.equal(projectCancelled(x).reason,"CANCELLATION_NOT_IN_RECEIPT_LINEAGE");
 const wrong=cancelled();wrong.input.binding.sourceDigest="e".repeat(64);assert.equal(projectCancelled(wrong).knowledge,"UNKNOWN");
});
