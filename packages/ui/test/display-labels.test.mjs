import assert from "node:assert/strict";
import { test } from "node:test";
import {
  UNRECOGNIZED_STATE_LABEL,
  guaranteeResponsibilityLabel, guaranteePaymentAttemptLabel, guaranteeRefundAttemptLabel,
  creditRecoveryDecisionLabel, creditEventLabel, guaranteeProviderRequestLabel, guaranteeReleasePolicyLabel,
} from "../src/display-credit.ts";
import {
  commissionRecordLabel, commissionDutyLabel, commissionStateLabel, commissionTransitionLabel, commissionRoleLabel,
} from "../src/display-distribution.ts";
import {
  obligationSourceLabel, refundObligationLabel, withdrawalObligationLabel,
} from "../src/display-funds.ts";
import { messageScopeLabel, messageScopeUserLabel } from "../src/display-im.ts";
import { formatExactYuan, formatReferenceYuan, parseYuanToCents, yuanInputHint } from "../src/display-money.ts";

test("legacy settled amounts preserve exact cents while normalizing padding",()=>{
  assert.equal(formatExactYuan("10"),"10.00");assert.equal(formatExactYuan("10.5000"),"10.50");
  assert.equal(formatExactYuan("0.01"),"0.01");assert.equal(formatExactYuan("10.005"),null);
  assert.equal(formatExactYuan("-1.00"),null);assert.equal(formatExactYuan("01.00"),null);
});

test("reference unit money rounds half up to two digits without turning a sub-cent value into free",()=>{
  assert.equal(formatReferenceYuan("1.005"),"约 ¥1.01");
  assert.equal(formatReferenceYuan("0.004"),"< ¥0.01");
  assert.equal(formatReferenceYuan("0.00000000"),"¥0.00");
  assert.equal(formatReferenceYuan("99999999999999.995",{grouped:true}),"约 ¥100,000,000,000,000.00");
  assert.equal(formatReferenceYuan("约¥0.00（不足1分）"),"< ¥0.01");
  assert.equal(formatReferenceYuan("< ¥0.01"),"< ¥0.01");
  assert.equal(formatReferenceYuan("约 ¥1.01"),"约 ¥1.01");
  assert.equal(formatReferenceYuan("not-a-price"),null);
});

/** 与逐字引用的服务端权威值集对照；新增未登记值应改表，不应静默降级。 */
const AUTHORITATIVE = {
  guaranteeResponsibility: ["NOT_REQUIRED", "REQUIRED", "PAYMENT_PENDING", "SATISFIED", "REFUND_REQUESTED", "REFUND_PROCESSING", "REFUNDED", "FAILED", "UNKNOWN"],
  paymentAttempt: ["REQUESTED", "ACCEPTED", "PROCESSING", "CONFIRMED", "FAILED", "UNKNOWN"],
  refundAttempt: ["REQUESTED", "PROCESSING", "SUCCEEDED", "FAILED", "UNKNOWN"],
  recoveryDecision: ["PENDING", "APPROVED", "REJECTED"],
  creditEvent: ["INITIALIZED", "BREACH_CONFIRMED", "BREACH_REVERSED", "RECOVERY_APPROVED", "MANUAL_DEDUCTION", "MANUAL_DEDUCTION_REVERSED"],
  commissionRecord: ["PENDING", "SETTLED", "REVOKED", "RECOVERY_REQUIRED", "EXPIRED", "UNKNOWN"],
  commissionDuty: ["PENDING", "MATURED", "SETTLED", "VOID"],
  commissionRole: ["RENTER_REFERRAL", "OWNER_REFERRAL", "TASK_REFERRAL", "UNKNOWN"],
  commissionTransition: ["ACCRUE", "SETTLE", "REVOKE", "RECOVER"],
  obligationSource: ["POSTING", "PRESTART_TERMINATION", "LEGACY_DUTY", "LOCAL_CONTROLLED", "JOINPAY_FORMAL"],
  refundObligation: ["NO_INTENT", "OUTSTANDING", "REVIEW_REQUIRED", "SOURCE_RESPONSIBILITY_REVIEW", "PROCESSING", "UNKNOWN"],
  localWithdrawal: ["RESERVED", "SUBMITTING", "PROCESSING", "SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED", "UNKNOWN"],
  channelWithdrawal: ["RESERVED", "SUBMITTING", "PROCESSING", "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE", "SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED", "UNKNOWN"],
  messageScope: ["PENDING", "PROVISIONING", "READY", "FAILED", "TRANSFERRING", "REVOKING", "REVOKED"],
};

const CASES = [
  ["保证金责任", AUTHORITATIVE.guaranteeResponsibility, guaranteeResponsibilityLabel],
  ["缴纳尝试", AUTHORITATIVE.paymentAttempt, guaranteePaymentAttemptLabel],
  ["退还尝试", AUTHORITATIVE.refundAttempt, guaranteeRefundAttemptLabel],
  ["信用恢复决定", AUTHORITATIVE.recoveryDecision, creditRecoveryDecisionLabel],
  ["信用事件", AUTHORITATIVE.creditEvent, creditEventLabel],
  ["佣金记录态", AUTHORITATIVE.commissionRecord, commissionRecordLabel],
  ["旧单责任态", AUTHORITATIVE.commissionDuty, commissionDutyLabel],
  ["佣金账本动作", AUTHORITATIVE.commissionTransition, commissionTransitionLabel],
  ["义务来源", AUTHORITATIVE.obligationSource, obligationSourceLabel],
  ["退款责任态", AUTHORITATIVE.refundObligation, refundObligationLabel],
  ["消息通道态", AUTHORITATIVE.messageScope, messageScopeLabel],
];

test("每张表覆盖权威值集，且中文不是裸枚举", () => {
  for (const [name, values, label] of CASES) {
    for (const value of values) {
      const text = label(value);
      assert.notEqual(text, UNRECOGNIZED_STATE_LABEL, `${name} 缺 ${value} 的标签`);
      assert.match(text, /[一-鿿]/, `${name}.${value} 必须含中文`);
      assert.doesNotMatch(text, /^[A-Z][A-Z0-9_]+$/, `${name}.${value} 不得裸显枚举`);
      assert.ok(!/待核$|^未知$/.test(text), `${name}.${value} 兜底词不得裸用“待核/未知”`);
    }
  }
});

test("未登记值一律落到不暗示成功的统一回退", () => {
  for (const [, , label] of CASES) {
    assert.equal(label("SOMETHING_NEW"), UNRECOGNIZED_STATE_LABEL);
    assert.equal(label(""), UNRECOGNIZED_STATE_LABEL);
  }
  assert.equal(withdrawalObligationLabel("JOINPAY_FORMAL", "MYSTERY"), UNRECOGNIZED_STATE_LABEL);
  assert.equal(withdrawalObligationLabel("FUTURE_SOURCE", "SUCCEEDED"), UNRECOGNIZED_STATE_LABEL);
  assert.equal(commissionRoleLabel("SOMETHING_NEW"), "来源待核对");
});

test("同值跨域不同事实不被合成一句话", () => {
  assert.notEqual(guaranteeResponsibilityLabel("FAILED"), guaranteeRefundAttemptLabel("FAILED"));
  assert.notEqual(commissionRecordLabel("PENDING"), commissionDutyLabel("MATURED"));
  assert.equal(commissionDutyLabel("PENDING"), commissionRecordLabel("PENDING"), "同为待结算应保持同词");
  assert.equal(commissionDutyLabel("SETTLED"), commissionRecordLabel("SETTLED"), "同为已结算应保持同词");
  assert.equal(commissionStateLabel("MATURED"), commissionDutyLabel("MATURED"), "混排筛选词表要能读到旧单责任态");
  assert.equal(commissionStateLabel("SOMETHING_NEW"), UNRECOGNIZED_STATE_LABEL);
  assert.equal(commissionRecordLabel("MATURED"), UNRECOGNIZED_STATE_LABEL, "记录态不该吞掉旧单责任态");
  // 站内 SUCCEEDED 未实际打款；渠道 SUCCEEDED 不等于银行到账。
  const local = withdrawalObligationLabel("LOCAL_CONTROLLED", "SUCCEEDED");
  const channel = withdrawalObligationLabel("JOINPAY_FORMAL", "SUCCEEDED");
  assert.notEqual(local, channel);
  assert.match(local, /未实际打款/);
  assert.match(channel, /银行到账另核/);
  assert.match(withdrawalObligationLabel("JOINPAY_FORMAL", "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE"), /本站处理待确认/);
});

test("客服视角与用户视角各有一套消息通道说法，且都覆盖全部状态", () => {
  const states = AUTHORITATIVE.messageScope;
  for (const state of states) {
    assert.notEqual(messageScopeLabel(state), UNRECOGNIZED_STATE_LABEL, `客服侧缺 ${state}`);
    assert.notEqual(messageScopeUserLabel(state), UNRECOGNIZED_STATE_LABEL, `用户侧缺 ${state}`);
  }
  assert.equal(messageScopeUserLabel("READY"), "消息通道正常");
  assert.equal(messageScopeUserLabel("FUTURE"), UNRECOGNIZED_STATE_LABEL);
  // 用户侧不得被读成“平台收不到我的消息”，也不得借用客服岗位词。
  for (const state of states) {
    assert.doesNotMatch(messageScopeUserLabel(state), /禁止|收不到|客服会话|人工核验/);
  }
});

test("结算与到账分述：佣金 SETTLED 只说已结算，不宣称已入余额", () => {
  assert.equal(commissionRecordLabel("SETTLED"), "已结算");
  assert.doesNotMatch(commissionRecordLabel("SETTLED"), /余额|到账/);
  assert.match(commissionDutyLabel("MATURED"), /待转入余额/);
  assert.doesNotMatch(guaranteeRefundAttemptLabel("SUCCEEDED"), /已到账/);
  assert.equal(obligationSourceLabel("LOCAL_CONTROLLED"), "站内模拟提现（未实际打款）");
});

test("消息通道异常用统一措辞，不当普通待办", () => {
  assert.equal(messageScopeLabel("FAILED"), "消息通道异常，暂不可回复");
  assert.doesNotMatch(messageScopeLabel("FAILED"), /待核|稍后|正常/);
});

test("unregistered prototype keys never become label objects or functions", () => {
  const readers = [guaranteeResponsibilityLabel, guaranteePaymentAttemptLabel, guaranteeRefundAttemptLabel,
    creditRecoveryDecisionLabel, creditEventLabel, guaranteeReleasePolicyLabel, commissionRecordLabel,
    commissionDutyLabel, commissionStateLabel, commissionTransitionLabel, obligationSourceLabel,
    refundObligationLabel, messageScopeLabel, messageScopeUserLabel,
    value => guaranteeProviderRequestLabel('payment', value), value => guaranteeProviderRequestLabel('refund', value),
    value => withdrawalObligationLabel('LOCAL_CONTROLLED', value), value => withdrawalObligationLabel('JOINPAY_FORMAL', value)];
  for (const read of readers) for (const key of ['constructor', '__proto__', 'toString']) assert.equal(read(key), UNRECOGNIZED_STATE_LABEL);
  assert.equal(commissionRoleLabel('constructor'), '来源待核对');
});

test("obligation queues keep successful states distinct from completed funds and dispatch", () => {
  assert.equal(refundObligationLabel('NO_INTENT'), '未查到本站退款申请');
  assert.equal(withdrawalObligationLabel('JOINPAY_FORMAL', 'SUBMITTING'), '正在提交渠道');
  for (const source of ['LOCAL_CONTROLLED', 'JOINPAY_FORMAL']) {
    const label = withdrawalObligationLabel(source, 'SUCCEEDED');
    assert.match(label, /资金处理待核对/);assert.doesNotMatch(label, /已到账|已记账|已提交渠道|出款已记录/);
  }
});

test("渠道请求状态与本站记录状态分轴，且未提交不谎报", () => {
  const payment = ["NOT_AUTHORIZED", "SUBMITTED", "UNKNOWN", "CONFIRMED", "FAILED"];
  const refund = ["NOT_AUTHORIZED", "SUBMITTED", "UNKNOWN", "SUCCEEDED", "FAILED"];
  for (const state of payment) {
    const text = guaranteeProviderRequestLabel("payment", state);
    assert.notEqual(text, UNRECOGNIZED_STATE_LABEL, `payment 缺 ${state}`);
    assert.match(text, /[一-鿿]/);
  }
  for (const state of refund) {
    const text = guaranteeProviderRequestLabel("refund", state);
    assert.notEqual(text, UNRECOGNIZED_STATE_LABEL, `refund 缺 ${state}`);
  }
  assert.equal(guaranteeProviderRequestLabel("payment", "SOMETHING_NEW"), UNRECOGNIZED_STATE_LABEL);
  assert.equal(guaranteeProviderRequestLabel("refund", "CONFIRMED"), UNRECOGNIZED_STATE_LABEL, "退款轴没有 CONFIRMED，不得借支付轴标签");
  assert.doesNotMatch(guaranteeProviderRequestLabel("payment", "SUBMITTED"), /已确认|成功/);
  assert.match(guaranteeProviderRequestLabel("refund", "SUCCEEDED"), /到账另核/);
});

test("元→分精确解析，拒绝猜测与浮点漂移", () => {
  assert.equal(parseYuanToCents("200"), "20000");
  assert.equal(parseYuanToCents(" 12.30 "), "1230");
  assert.equal(parseYuanToCents("0.05"), "5");
  assert.equal(parseYuanToCents("0"), "0");
  assert.equal(parseYuanToCents("99999999999999999999.99"), "9999999999999999999999");
  for (const bad of ["", "  ", "1.234", "-1", "1e3", "0.000", "abc", "1.", ".5", "１２", "12,3", undefined]) {
    assert.equal(parseYuanToCents(bad), null, `应拒绝 ${JSON.stringify(bad)}`);
  }
  assert.match(yuanInputHint("88.5"), /上限 88\.5 元/);
  assert.equal(yuanInputHint(), "按元填写，最多两位小数");
});

test("退还放行决定是第三条轴，不宣称渠道结果或到账", () => {
  for (const state of ["OWNER_DECISION_REQUIRED", "APPROVED", "REJECTED"]) {
    const text = guaranteeReleasePolicyLabel(state);
    assert.notEqual(text, UNRECOGNIZED_STATE_LABEL, `缺 ${state}`);
    assert.doesNotMatch(text, /已到账|渠道已退/);
  }
  assert.equal(guaranteeReleasePolicyLabel("SOMETHING"), UNRECOGNIZED_STATE_LABEL);
  assert.notEqual(guaranteeReleasePolicyLabel("APPROVED"), creditRecoveryDecisionLabel("APPROVED"), "退还放行与信用恢复决定不得同词");
});
