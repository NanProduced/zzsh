// SYNTHETIC_COMPONENT_MODEL：只验证业务判断，不证明真实原款、PG锁或退款到账。
import assert from "node:assert/strict";
import test from "node:test";
import { assertPrestartDecision, prestartTerminationEligibility, type PrestartFacts } from "../src/order/prestart-termination-model";

const facts: PrestartFacts = { orderState: "PAID", paymentSource: "JOINPAY", paymentDisposition: "APPLIED", currency: "CNY",
  paidCents: "15908", orderCents: "15908", paymentBound: true, openingConfirmed: false, hasPosting: false,
  pendingAdjustment: false, monetaryEarningCount: "0" };
test("未正式开租的原APPLIED款全额应退，不生成费用或正常结算", () => {
  assert.deepEqual(prestartTerminationEligibility(facts), { allowed: true, reason: null, refundCents: "15908" });
  assert.equal(prestartTerminationEligibility({ ...facts, paymentSource: "CONTROLLED" }).refundCents, "15908");
});
test("正式开租、过账、争议调整或实际分佣均阻止直接全退", () => {
  for (const [change, reason] of [
    [{ openingConfirmed: true }, "RENTAL_ALREADY_STARTED"], [{ hasPosting: true }, "SETTLEMENT_ALREADY_POSTED"],
    [{ pendingAdjustment: true }, "MANUAL_ADJUSTMENT_REVIEW"], [{ monetaryEarningCount: "1" }, "DISTRIBUTION_RECONCILIATION_REQUIRED"],
    [{ monetaryEarningCount: "UNKNOWN" }, "DISTRIBUTION_RECONCILIATION_REQUIRED"],
  ] as const) assert.deepEqual(prestartTerminationEligibility({ ...facts, ...change }), { allowed: false, reason, refundCents: null });
});
test("未付款、取消、已完成不借终止分支退款", () => {
  for (const orderState of ["PENDING_PAYMENT", "CANCELLED", "COMPLETED", "FUTURE"])
    assert.equal(prestartTerminationEligibility({ ...facts, orderState }).reason, "ORDER_NOT_PAID");
});
test("REVIEW原款、金额差异、未知币种/来源及非整数分不升级成全退依据", () => {
  for (const change of [{ paymentDisposition: "REVIEW_REQUIRED" }, { paymentBound: false }, { paidCents: "15907" }, { currency: "USD" },
    { paidCents: "15908.00" }, { paidCents: "0" }, { paidCents: "-1" }, { paidCents: "10000000000000000" }, { paymentSource: "SYNTHETIC_PROTOCOL" }])
    assert.equal(prestartTerminationEligibility({ ...facts, ...change }).reason, "PAYMENT_BASIS_UNAVAILABLE");
});
test("客服审核必须显式核实无使用/争议，客户端不能提交金额或替代核实", () => {
  const base = { decision: "APPROVE", expectedRevision: "1", reason: "已核实未交付且无争议" };
  assert.throws(() => assertPrestartDecision({ ...base, assessment: true }));
  assert.throws(() => assertPrestartDecision({ ...base, assessment: undefined }));
  assert.throws(() => assertPrestartDecision({ ...base, decision: ["APPROVE"], assessment: undefined }));
  assert.equal(assertPrestartDecision({ ...base, assessment: "NO_USE_NO_DISPUTE" }).decision, "APPROVE");
  for (const expectedRevision of ["0", "01", "1.0", 1, null]) assert.throws(() => assertPrestartDecision({ ...base, expectedRevision, assessment: "NO_USE_NO_DISPUTE" }));
  assert.equal(assertPrestartDecision({ decision: "REVIEW_REQUIRED", expectedRevision: "2", reason: "使用情况存在争议", assessment: undefined }).decision, "REVIEW_REQUIRED");
});

test("未知的开租/过账事实不按false放行",()=>{
  assert.equal(prestartTerminationEligibility({...facts,openingConfirmed:null as never}).reason,"PRESTART_FACTS_UNAVAILABLE");
  assert.equal(prestartTerminationEligibility({...facts,hasPosting:undefined as never}).allowed,false);
});
