import assert from "node:assert/strict";
import test from "node:test";
import { reviewLegacyRefund, type LegacyRefundReviewBasis, type LegacyRefundReviewInput } from "../src/order/legacy-refund-review";

const basis:LegacyRefundReviewBasis={orderId:"legacy_order_1",dutyId:"legacy_duty_1",dutyRevision:"1",dutyCents:"5000",
  sourceDigest:"a".repeat(64),dutyEvidenceDigest:"b".repeat(64),renterUserId:"renter_1",paymentRecordId:"123",
  paymentOrderNo:"OLDPAY123",paidCents:"10000",merchantIdentityId:"merchant_1",refundDueAt:"2026-11-01T00:00:00.000000Z",
  fundsDisposition:"AVAILABLE",dutyState:"PENDING",originalIntentExists:false};
const review:LegacyRefundReviewInput={paymentOrderNo:"OLDPAY123",merchantIdentityId:"merchant_1",paidCents:"10000",
  previouslyRefundedCents:"2000",priorAppliedToDutyCents:"2000",noUnresolvedRefunds:true,evidenceRef:"汇聚原单核对记录 123"};
const now="2026-11-01T00:00:00.000000Z";

test("old payment reviewed as partially refunded deducts the portion already fulfilling the duty",()=>{
  const result=reviewLegacyRefund(basis,review,now);
  assert.equal(result.ok,true);if(!result.ok)return;
  assert.equal(result.kind,"REFUND");assert.equal(result.refundCents,"3000");assert.equal(result.remainingPaymentCents,"8000");
  assert.match(result.fingerprint,/^[a-f0-9]{64}$/);
  assert.notEqual(result.fingerprint,(reviewLegacyRefund(basis,{...review,evidenceRef:"另一条核验记录"},now) as any).fingerprint);
});

test("prior refunds unrelated to this duty reduce payment capacity but do not automatically erase the duty",()=>{
  const result=reviewLegacyRefund(basis,{...review,priorAppliedToDutyCents:"0"},now);
  assert.equal(result.ok,true);if(result.ok){assert.equal(result.refundCents,"5000");assert.equal(result.remainingPaymentCents,"8000");}
  const short=reviewLegacyRefund(basis,{...review,previouslyRefundedCents:"7000",priorAppliedToDutyCents:"0"},now);
  assert.deepEqual(short,{ok:false,reason:"ORIGINAL_PAYMENT_BUDGET_INSUFFICIENT"});
});

test("a fully covered duty creates no new outbound refund",()=>{
  const result=reviewLegacyRefund(basis,{...review,previouslyRefundedCents:"5000",priorAppliedToDutyCents:"5000"},now);
  assert.equal(result.ok,true);if(result.ok){assert.equal(result.kind,"NO_NEW_REFUND");assert.equal(result.refundCents,"0");}
});

test("unknown or mismatched source, pending refunds, changed duty and not-yet-due refunds fail closed",()=>{
  const cases:Array<[Partial<LegacyRefundReviewBasis>,Partial<LegacyRefundReviewInput>,string]>=[
    [{refundDueAt:null},{},"REFUND_DUE_UNKNOWN"],[{refundDueAt:"2026-11-01T00:00:00.000001Z"},{},"REFUND_NOT_DUE"],
    [{fundsDisposition:"HELD"},{},"DUTY_NOT_AVAILABLE"],[{dutyState:"SETTLED"},{},"DUTY_NOT_PAYABLE"],
    [{originalIntentExists:true},{},"ORIGINAL_ALREADY_HAS_INTENT"],[{},{noUnresolvedRefunds:false},"REFUND_STATUS_UNCONFIRMED"],
    [{},{paymentOrderNo:"OTHER"},"ORIGINAL_PAYMENT_MISMATCH"],[{},{merchantIdentityId:"OTHER"},"ORIGINAL_PAYMENT_MISMATCH"],
    [{},{paidCents:"9999"},"ORIGINAL_PAYMENT_MISMATCH"],[{},{evidenceRef:"  "},"REVIEW_EVIDENCE_REQUIRED"],
    [{},{priorAppliedToDutyCents:"2001"},"REVIEW_AMOUNT_INCONSISTENT"],[{},{previouslyRefundedCents:"10001"},"REVIEW_AMOUNT_INCONSISTENT"],
    [{},{previouslyRefundedCents:"2.00"},"REVIEW_INPUT_INVALID"],
  ];
  for(const [b,r,reason] of cases)assert.deepEqual(reviewLegacyRefund({...basis,...b},{...review,...r},now),{ok:false,reason});
});
