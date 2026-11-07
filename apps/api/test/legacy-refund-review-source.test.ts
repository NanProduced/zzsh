import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { canonicalize } from "../src/supply/content-hash";
import * as evidence from "../src/order/legacy-continuation-evidence";
import * as dutyBasis from "../src/order/legacy-duty-basis";
import { initialLegacyFacts, type LegacyDutyRow, type LegacyHeadRow } from "../src/order/legacy-continuation-model";
import { readHistoricalOriginalPayment, readLockedLegacyRefundSource } from "../src/order/legacy-refund-review-source";
import { legacyBinding, legacyEvidence, legacySource } from "./legacy-continuation-fixture";

const head:LegacyHeadRow={id:"confirm_1",orderId:legacyBinding.id,revision:"1",inputEvidenceId:"input_1",resultEvidenceId:"result_1",stage:4,isSettle:0,command:"CONFIRM",amounts:{}};
const duty:LegacyDutyRow={id:"legacy_duty_1",orderId:legacyBinding.id,continuationVersionId:"confirm_1",kind:"RENTER_REFUND",sourceRecordId:"confirm_1",
  counterpartyUserId:legacyBinding.renterUserId,amountCents:"5000",currency:"CNY",status:"PENDING",source:"CONTINUATION",sourceStatus:null,
  level:null,ratio:null,maturityAt:null,admissionId:null,revision:"1",settledBy:null,settledRefType:null,settledRefId:null,settledRefDigest:null};

function fixture(t:any, options:{source?:ReturnType<typeof legacySource>; resolved?:Record<string,unknown>; dueAt?:string|null; duplicate?:boolean}={}){
  const row=legacyEvidence(initialLegacyFacts(options.source??legacySource()));
  t.mock.method(evidence,"readLegacyContinuationEvidence",async()=>row);
  t.mock.method(dutyBasis,"readLegacyDutyBasis",async()=>({state:"KNOWN",dutyId:duty.id,orderId:legacyBinding.id,kind:"RENTER_REFUND",
    beneficiaryUserId:legacyBinding.renterUserId,amountCents:duty.amountCents,currency:"CNY",parentSourceDigest:legacyBinding.sourceDigest,effectiveHeadId:head.id,effectiveHeadRevision:head.revision,
    continuationVersionId:duty.continuationVersionId,fundsDisposition:"AVAILABLE",currentNetRefundCents:duty.amountCents,
    effectiveFactsDigest:"d".repeat(64),...options.resolved}) as any);
  return {query:async(sql:string)=>({rows:[sql.includes("jsonb_array_elements")?{found:options.duplicate??false}:{dueAt:options.dueAt===undefined?"2026-11-07T00:00:00.000000Z":options.dueAt}]})} as any;
}

test("legacy review source binds the original payment number and the current confirmed refund duty",async t=>{
  const client=fixture(t), source=await readLockedLegacyRefundSource(client,legacyBinding,head,duty);
  assert.equal(source.paymentRecordId,"9");assert.equal(source.paymentOrderNo,"FIXTURE_P7");
  assert.equal(source.paidCents,"10000");assert.equal(source.dutyCents,"5000");
  assert.equal(source.refundDueAt,"2026-11-07T00:00:00.000000Z");
  assert.equal(source.dutyEvidenceDigest,"d".repeat(64));
});

test("stale or held duties and unresolved final evidence cannot become a refund basis",async t=>{
  const client=fixture(t,{resolved:{fundsDisposition:"HELD"}});
  await assert.rejects(readLockedLegacyRefundSource(client,legacyBinding,head,duty),/LEGACY_REFUND_DUTY_UNAVAILABLE/);
  await assert.rejects(readLockedLegacyRefundSource(client,legacyBinding,{...head,stage:3},duty),/LEGACY_REFUND_DUTY_UNAVAILABLE/);
  await assert.rejects(readLockedLegacyRefundSource(client,legacyBinding,head,{...duty,settledBy:"FINANCE"}),/LEGACY_REFUND_DUTY_UNAVAILABLE/);
});

test("multiple payments or an inconsistent legacy paid amount never select an arbitrary original",async t=>{
  const multiple=fixture(t,{source:legacySource({paidPay:[{id:"9",payOrderSn:"A",payMoney:"100.00"},{id:"10",payOrderSn:"B",payMoney:"100.00"}]})});
  await assert.rejects(readLockedLegacyRefundSource(multiple,legacyBinding,head,duty),/LEGACY_PAYMENT_SOURCE_UNAVAILABLE/);
  const mismatch=fixture(t,{source:legacySource({payMoney:"99.00",paidPay:[{id:"9",payOrderSn:"A",payMoney:"99.00"}]})});
  await assert.rejects(readLockedLegacyRefundSource(mismatch,legacyBinding,head,duty),/LEGACY_PAYMENT_SOURCE_MISMATCH/);
  const duplicate=fixture(t,{duplicate:true});
  await assert.rejects(readLockedLegacyRefundSource(duplicate,legacyBinding,head,duty),/LEGACY_PAYMENT_SOURCE_AMBIGUOUS/);
});

test("completed historical refund binds one paid source, while held or ambiguous records stay blocked",async t=>{
  const binding={...legacyBinding,sourceOrderStatus:4};
  const historic={...duty,source:'LEGACY_IMPORT' as const,sourceStatus:'COMPLETED_UNREFUNDED',continuationVersionId:null};
  const snapshot={kind:'paymentObservation',sourceUserId:Number(binding.legacyRenterId),sourceId:9,sourceStatus:1,channelArrival:'UNKNOWN',
    createdAt:1790000000,amount:'100.00',sourceNumber:'FIXTURE_P7',sourceOrderType:'1',referenceType:'LEGACY_ORDER',referenceId:binding.legacyId,associationState:'SOURCE_VERIFIED'};
  const canonical=canonicalize(snapshot),payment={source_id:'9',source_canonical:canonical,source_digest:createHash('sha256').update(canonical).digest('hex'),snapshot};
  let payments=[payment];
  const client={query:async(sql:string)=>({rows:sql.includes('personal_finance_observation')?payments:[{dueAt:'2026-11-07T00:00:00.000000Z'}]})} as any;
  t.mock.method(dutyBasis,'readLegacyDutyBasis',async()=>({state:'KNOWN',dutyId:historic.id,orderId:binding.id,kind:'RENTER_REFUND',beneficiaryUserId:binding.renterUserId,
    currency:'CNY',effectiveHeadId:null,effectiveHeadRevision:null,continuationVersionId:null,amountCents:historic.amountCents,parentSourceDigest:binding.sourceDigest,
    fundsDisposition:'AVAILABLE',currentNetRefundCents:historic.amountCents,effectiveFactsDigest:'d'.repeat(64)}) as any);
  const result=await readLockedLegacyRefundSource(client,binding,null,historic);
  assert.equal(result.paymentOrderNo,'FIXTURE_P7');assert.equal(result.paymentRecordId,'9');assert.equal(result.refundDueAt,null);
  payments=[payment,payment];await assert.rejects(readHistoricalOriginalPayment(client,binding),/LEGACY_PAYMENT_SOURCE_UNAVAILABLE/);
  payments=[{...payment,source_digest:'a'.repeat(64)}];await assert.rejects(readHistoricalOriginalPayment(client,binding),/LEGACY_PAYMENT_SOURCE_MISMATCH/);
  payments=[payment];await assert.rejects(readLockedLegacyRefundSource(client,binding,null,{...historic,sourceStatus:'DETAINED'}),/LEGACY_REFUND_DUTY_UNAVAILABLE/);
});
