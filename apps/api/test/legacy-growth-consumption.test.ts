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
