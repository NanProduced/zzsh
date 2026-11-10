import assert from "node:assert/strict";
import { test } from "node:test";
import { parsePersonalRefunds } from "../src/lib/order-client.ts";

const intent = (over = {}) => ({
  intentId: "intent_refund_1", refundOrderNo: "RF" + "a".repeat(28), source: "JOINPAY_FORMAL", evidenceLevel: "JOINPAY_FORMAL",
  amount: { cents: "28000", currency: "CNY" }, state: "SUCCEEDED", budgetDisposition: "CONSUMED", requiresReview: false,
  dueAt: "2026-10-19T04:30:00.000000Z", createdAt: "2026-10-18T04:30:00.000000Z", updatedAt: "2026-10-18T05:30:00.000000Z",
  latestObservation: null, latestFailure: null,
  savedChannelEvidence: { terminal: "SUCCEEDED", evidenceLevel: "JOINPAY_FORMAL", providerRefundTrxNo: "RF-TRX-1", completedAt: "2026-10-18T05:30:00.000000Z", trust: "SAVED_EVIDENCE_NOT_REVALIDATED" },
  localAccounting: { disposition: "CONSUMED", writeOff: { eventId: "event_refund", amountCents: "28000", postedAt: "2026-10-18T05:30:00.000000Z", trust: "LOCAL_LEDGER" }, release: null, reasonCodes: [] },
  channelFacts: { actualAmountCents: null, channelRefundTrxNo: null, completedAt: null, destination: null, bankArrival: "UNKNOWN", reasonCodes: [] },
  reasonCodes: [], ...over,
});

const read = (over = {}) => ({
  contractVersion: "personal-native-refunds.v1", subjectId: "user_A",
  order: { orderId: "order_A", displayNo: "ZZ-1", status: "COMPLETED" },
  status: "AVAILABLE", outcome: "FULLY_CONSUMED",
  coverage: { scope: "LOCAL_REGISTERED_ONLY", intentLimit: 50, intentsComplete: true, channelRecordsChecked: false },
  asOf: "2026-10-27T02:30:17.490161Z",
  responsibility: { state: "POSTED", postingId: "posting_1", originalCents: "28000", allocatedCents: "28000", consumedCents: "28000", releasedCents: "0", remainingCents: "0", totalsComplete: true, dueAt: "2026-10-19T04:30:00.000000Z", dueState: "DUE" },
  intents: [intent()], returnedIntentCount: 1, intentsTruncated: false,
  actualChannelRefund: { amountCents: null, channelRefundTrxNo: null, completedAt: null, destination: null, bankArrival: "UNKNOWN", reasonCodes: [] },
  localFundsEffect: { basis: "LOCAL_REGISTERED_ACCOUNTING", writtenOffCents: "28000", releasedCents: "0", bankArrival: "UNKNOWN" },
  reasonCodes: [], unknowns: ["CHANNEL_REFUND_RECORD_NOT_CHECKED", "BANK_ARRIVAL_UNKNOWN", "REFUND_DESTINATION_NOT_PROJECTED"], ...over,
});

test("accepted projection is parsed with zero and null kept distinct", () => {
  const parsed = parsePersonalRefunds(read(), "user_A", "order_A");
  assert.equal(parsed.outcome, "FULLY_CONSUMED");
  assert.equal(parsed.responsibility.releasedCents, "0");
  assert.equal(parsed.responsibility.originalCents, "28000");
  assert.equal(parsed.actualChannelRefund.bankArrival, "UNKNOWN");
  assert.equal(parsed.intents[0].savedChannelEvidence.trust, "SAVED_EVIDENCE_NOT_REVALIDATED");
  const zero = parsePersonalRefunds(read({ outcome: "ZERO_RESPONSIBILITY", responsibility: { ...read().responsibility, originalCents: "0", allocatedCents: "0", consumedCents: "0", releasedCents: "0", remainingCents: "0" }, intents: [], returnedIntentCount: 0, localFundsEffect: null }), "user_A", "order_A");
  assert.equal(zero.responsibility.originalCents, "0");
  assert.equal(zero.localFundsEffect, null);
});

test("prestart refund is an additive cancelled-order fact and never invents bank arrival",()=>{
 const value=read({order:{orderId:"order_A",displayNo:"ZZ-1",status:"CANCELLED"},
  prestartRefund:{state:"SUCCEEDED",amountCents:"334613",source:"SIMULATED",bankArrival:"UNKNOWN"}});
 assert.deepEqual(parsePersonalRefunds(value,"user_A","order_A").prestartRefund,value.prestartRefund);
 for(const change of [{state:"SUCCEEDED",amountCents:null,source:"JOINPAY",bankArrival:"UNKNOWN"},
  {state:"SUCCEEDED",amountCents:"0",source:"SIMULATED",bankArrival:"UNKNOWN"},
  {state:"SUCCEEDED",amountCents:"1",source:"UNKNOWN",bankArrival:"UNKNOWN"},
  {state:"SUCCEEDED",amountCents:"1",source:"JOINPAY",bankArrival:"ARRIVED"}])
  assert.throws(()=>parsePersonalRefunds({...value,prestartRefund:change},"user_A","order_A"));
 assert.throws(()=>parsePersonalRefunds({...value,order:{...value.order,status:"PAID"}},"user_A","order_A"));
});

test("contract, subject, order and enum anchors are enforced", () => {
  for (const bad of [
    read({ contractVersion: "personal-native-refunds.v0" }),
    read({ subjectId: "user_B" }),
    read({ order: { orderId: "order_B", displayNo: "ZZ-2", status: "COMPLETED" } }),
    read({ outcome: "ORDER_NOT_PAID" }),
    read({ responsibility: { ...read().responsibility, dueState: "SOON" } }),
    read({ actualChannelRefund: { ...read().actualChannelRefund, amountCents: "28000" } }),
    read({ actualChannelRefund: { ...read().actualChannelRefund, bankArrival: "ARRIVED" } }),
    read({ intents: [intent({ amount: { cents: "28000", currency: "USD" } })], returnedIntentCount: 1 }),
  ]) assert.throws(() => parsePersonalRefunds(bad, "user_A", "order_A"), (error) => error.status === 502);
});

test("truncated or conflicting reads cannot claim complete totals", () => {
  const truncated = read({ outcome: "TRUNCATED", intentsTruncated: true, coverage: { ...read().coverage, intentsComplete: false }, responsibility: { ...read().responsibility, totalsComplete: false } });
  assert.throws(() => parsePersonalRefunds(truncated, "user_A", "order_A"), (error) => error.status === 502);
  const intents = Array.from({ length: 50 }, (_, index) => intent({ intentId: `intent_${index}` }));
  const truncatedOk = read({
    outcome: "TRUNCATED", intents, returnedIntentCount: 50, intentsTruncated: true,
    coverage: { ...read().coverage, intentsComplete: false },
    responsibility: { ...read().responsibility, originalCents: null, allocatedCents: null, consumedCents: null, releasedCents: null, remainingCents: null, totalsComplete: false },
    localFundsEffect: { basis: "LOCAL_REGISTERED_ACCOUNTING", writtenOffCents: null, releasedCents: null, bankArrival: "UNKNOWN" },
  });
  assert.equal(parsePersonalRefunds(truncatedOk, "user_A", "order_A").intents.length, 50);
  assert.equal(parsePersonalRefunds({ ...truncatedOk, intents: intents.slice(0, 49), returnedIntentCount: 49 }, "user_A", "order_A").returnedIntentCount, 49);
  assert.throws(() => parsePersonalRefunds(read({ outcome: "CONFLICT" }), "user_A", "order_A"), (error) => error.status === 502);
  assert.throws(() => parsePersonalRefunds(read({ returnedIntentCount: 2 }), "user_A", "order_A"), (error) => error.status === 502);
  assert.throws(() => parsePersonalRefunds(read({ intents: Array.from({ length: 51 }, (_, index) => intent({ intentId: `intent_${index}` })), returnedIntentCount: 51 }), "user_A", "order_A"), (error) => error.status === 502);
});

test("saved evidence, write-off and channel facts stay within their verified shapes", () => {
  const wrongTrust = intent({ savedChannelEvidence: { ...intent().savedChannelEvidence, trust: "VERIFIED" } });
  assert.throws(() => parsePersonalRefunds(read({ intents: [wrongTrust] }), "user_A", "order_A"), (error) => error.status === 502);
  const nullWriteOff = intent({ localAccounting: { ...intent().localAccounting, writeOff: { ...intent().localAccounting.writeOff, amountCents: null } } });
  assert.throws(() => parsePersonalRefunds(read({ intents: [nullWriteOff] }), "user_A", "order_A"), (error) => error.status === 502);
  const observed = intent({ latestFailure: { source: "JOINPAY", event: "REFUND_QUERY", failureReason: "RESULT_UNKNOWN", evidenceLevel: "JOINPAY_FORMAL", observedAt: "2026-10-18T05:30:00.000000Z", ageSeconds: 60, trust: "LOCAL_OBSERVATION_NOT_REVALIDATED" } });
  assert.equal(parsePersonalRefunds(read({ intents: [observed] }), "user_A", "order_A").intents[0].latestFailure.failureReason, "RESULT_UNKNOWN");
});

test("legacy C02 keeps a known original amount while derived totals remain unknown", () => {
  for (const outcome of ["CONFLICT", "TRUNCATED"]) {
    const intents = Array.from({ length: 49 }, (_, index) => intent({ intentId: "filtered_intent_" + index }));
    const actual = read({
      outcome, intents, returnedIntentCount: 49, intentsTruncated: true,
      coverage: { ...read().coverage, intentsComplete: false },
      responsibility: { ...read().responsibility, originalCents: "28000", allocatedCents: null, consumedCents: null, releasedCents: null, remainingCents: null, totalsComplete: false },
      localFundsEffect: { basis: "LOCAL_REGISTERED_ACCOUNTING", writtenOffCents: null, releasedCents: null, bankArrival: "UNKNOWN" },
    });
    const parsed = parsePersonalRefunds(actual, "user_A", "order_A");
    assert.equal(parsed.outcome, outcome);
    assert.equal(parsed.responsibility.originalCents, "28000");
    assert.equal(parsed.responsibility.allocatedCents, null);
    assert.equal(parsed.coverage.intentsComplete, false);
    assert.equal(parsed.localFundsEffect.writtenOffCents, null);
    assert.throws(() => parsePersonalRefunds({ ...actual, responsibility: { ...actual.responsibility, consumedCents: "28000" } }, "user_A", "order_A"), (error) => error.status === 502);
  }
});


test("retired abnormal refund fields are not exposed by the reader",()=>{
 const parsed=parsePersonalRefunds({...read(),abnormalResponsibilities:[{unused:true}],responsibilityTotals:{unused:true}},"user_A","order_A");
 assert.equal("abnormalResponsibilities" in parsed,false);assert.equal("responsibilityTotals" in parsed,false);
 assert.throws(()=>parsePersonalRefunds(read({intents:[intent({basisKind:"REVIEW_CONFIRMATION"})]}),"user_A","order_A"),error=>error.status===502);
});
