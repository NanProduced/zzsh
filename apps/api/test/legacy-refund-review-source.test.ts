import assert from "node:assert/strict";
import test from "node:test";
import * as evidence from "../src/order/legacy-continuation-evidence";
import * as dutyBasis from "../src/order/legacy-duty-basis";
import { initialLegacyFacts, type LegacyDutyRow, type LegacyHeadRow } from "../src/order/legacy-continuation-model";
import { readLockedLegacyRefundSource } from "../src/order/legacy-refund-review-source";
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
