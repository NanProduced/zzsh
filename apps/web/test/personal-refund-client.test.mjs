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

// SYNTHETIC_READER_COMPONENT: accepted C04B DTO shape only; no real PG, channel or bank fact.
const firstSubmit = (over = {}) => ({
  dispatch: "NEVER_DISPATCHED", blockedReason: "ABNORMAL_BASIS_REVIEW",
  blockedAt: "2026-10-27T02:00:00.000000Z", blockedAuditCount: 1, trust: "LOCAL_AUDIT_AND_ATTEMPT", ...over,
});
const abnormal = (over = {}) => ({
  confirmationId: "confirm_1", reasonCode: "LATE_PAYMENT", originalCents: "5000", currency: "CNY",
  liabilityRootId: "root_1", liabilityEventId: "event_1", intentIds: ["intent_1"],
  allocatedCents: "5000", consumedCents: "0", releasedCents: "0", remainingCents: "0", totalsComplete: true,
  state: "READY", firstSubmit: firstSubmit(), reasonCodes: [], ...over,
});
const totals = (over = {}) => ({
  originalCents: "33000", allocatedCents: "33000", consumedCents: "28000", releasedCents: "0", remainingCents: "0",
  totalsComplete: true, postingOriginalCents: "28000", abnormalOriginalCents: "5000", abnormalConfirmationCount: 1, ...over,
});
const newRead = (over = {}) => read({
  outcome: "REVIEW_REQUIRED", abnormalResponsibilities: [abnormal()], responsibilitiesTruncated: false,
  responsibilityTotals: totals(),
  intents: [intent({ basisKind: "REVIEW_CONFIRMATION", paymentConfirmationId: "confirm_1", firstSubmit: firstSubmit() })],
  returnedIntentCount: 1, ...over,
});

test("new abnormal responsibilities and first-submit facts parse additively; old C02 stays readable", () => {
  const old = parsePersonalRefunds(read(), "user_A", "order_A");
  assert.equal(old.abnormalResponsibilities, undefined);
  assert.equal(old.responsibilitiesTruncated, undefined);
  assert.equal(old.responsibilityTotals, undefined);
  assert.equal(old.intents[0].basisKind, undefined);
  const parsed = parsePersonalRefunds(newRead(), "user_A", "order_A");
  assert.equal(parsed.abnormalResponsibilities.length, 1);
  assert.equal(parsed.abnormalResponsibilities[0].originalCents, "5000");
  assert.equal(parsed.abnormalResponsibilities[0].firstSubmit.dispatch, "NEVER_DISPATCHED");
  assert.equal(parsed.responsibilityTotals.totalsComplete, true);
  assert.equal(parsed.responsibilityTotals.abnormalConfirmationCount, 1);
  assert.equal(parsed.intents[0].basisKind, "REVIEW_CONFIRMATION");
  assert.equal(parsed.intents[0].paymentConfirmationId, "confirm_1");
});

test("new global conflict keeps known posting responsibility while rejecting partial totals", () => {
  const conflict = newRead({
    outcome: "CONFLICT",
    responsibility: { ...read().responsibility, originalCents: "28000", allocatedCents: null, consumedCents: null, releasedCents: null, remainingCents: null, totalsComplete: false },
    abnormalResponsibilities: [abnormal({ state: "CONFLICT", originalCents: null, currency: null, liabilityRootId: null, liabilityEventId: null, allocatedCents: null, consumedCents: null, releasedCents: null, remainingCents: null, totalsComplete: false, firstSubmit: null })],
    responsibilityTotals: totals({ originalCents: null, allocatedCents: null, consumedCents: null, releasedCents: null, remainingCents: null, totalsComplete: false, abnormalOriginalCents: null }),
  });
  const parsed = parsePersonalRefunds(conflict, "user_A", "order_A");
  assert.equal(parsed.responsibility.originalCents, "28000");
  assert.equal(parsed.abnormalResponsibilities[0].state, "CONFLICT");
  assert.equal(parsed.responsibilityTotals.totalsComplete, false);
  for (const bad of [
    newRead({ abnormalResponsibilities: [abnormal({ state: "CONFLICT", originalCents: "5000" })] }),
    newRead({ abnormalResponsibilities: [abnormal({ currency: "USD" })] }),
    newRead({ abnormalResponsibilities: [abnormal({ firstSubmit: { ...firstSubmit(), trust: "VERIFIED" } })] }),
    newRead({ subjectId: "user_B" }),
    newRead({ responsibilitiesTruncated: true }),
    newRead({ responsibilityTotals: null }),
    newRead({ abnormalResponsibilities: Array.from({ length: 51 }, (_, index) => abnormal({ confirmationId: `confirm_${index}` })) }),
    newRead({ intents: [intent({ basisKind: "UNKNOWN_BASIS" })], returnedIntentCount: 1 }),
  ]) assert.throws(() => parsePersonalRefunds(bad, "user_A", "order_A"), (error) => error.status === 502);
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

test("complete abnormal-only responsibility does not require a posted normal basis",()=>{
 const absent={state:"NOT_POSTED",postingId:null,originalCents:null,allocatedCents:null,consumedCents:null,releasedCents:null,remainingCents:null,totalsComplete:false,dueAt:null,dueState:"UNKNOWN"};
 const dto=newRead({order:{...read().order,status:"CANCELLED"},responsibility:absent,
  responsibilityTotals:totals({originalCents:"5000",allocatedCents:"5000",consumedCents:"0",postingOriginalCents:null}),
  localFundsEffect:{basis:"LOCAL_REGISTERED_ACCOUNTING",writtenOffCents:"0",releasedCents:"0",bankArrival:"UNKNOWN"}});
 const parsed=parsePersonalRefunds(dto,"user_A","order_A");
 assert.equal(parsed.responsibility.totalsComplete,false);assert.equal(parsed.responsibilityTotals.totalsComplete,true);
 assert.equal(parsed.abnormalResponsibilities[0].originalCents,"5000");
 assert.throws(()=>parsePersonalRefunds({...dto,responsibility:{...absent,totalsComplete:true}},"user_A","order_A"),e=>e.status===502);
 assert.throws(()=>parsePersonalRefunds({...dto,responsibilityTotals:{...dto.responsibilityTotals,originalCents:null}},"user_A","order_A"),e=>e.status===502);
});
test("one conflicting abnormal responsibility may retain its known original amount",()=>{
 const dto=newRead({outcome:"CONFLICT",
  abnormalResponsibilities:[abnormal({state:"CONFLICT",originalCents:"5000",allocatedCents:null,consumedCents:null,releasedCents:null,remainingCents:null,totalsComplete:false})],
  responsibilityTotals:totals({originalCents:null,allocatedCents:null,consumedCents:null,releasedCents:null,remainingCents:null,totalsComplete:false,abnormalOriginalCents:null}),
  coverage:{...read().coverage,intentsComplete:false}});
 const parsed=parsePersonalRefunds(dto,"user_A","order_A");
 assert.equal(parsed.abnormalResponsibilities[0].state,"CONFLICT");assert.equal(parsed.abnormalResponsibilities[0].originalCents,"5000");
 assert.equal(parsed.responsibility.originalCents,"28000");assert.equal(parsed.responsibility.totalsComplete,true);
 assert.throws(()=>parsePersonalRefunds({...dto,abnormalResponsibilities:[abnormal({totalsComplete:true,allocatedCents:null})]},"user_A","order_A"),e=>e.status===502);
});
