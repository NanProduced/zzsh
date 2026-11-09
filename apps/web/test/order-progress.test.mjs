import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { test } from "node:test";

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const tree = path.resolve(testDirectory, "../../..");
const requireFromTree = createRequire(path.join(tree, "package.json"));
const { orderProgressView, legacyProgressView } = requireFromTree(path.join(tree, "apps/web/src/lib/order-display.ts"));

const order = (over = {}) => ({ status: "PAID", ...over });
const facts = (over = {}) => ({
  rentalStarted: false,
  phase: "RENTING",
  openingVersionNo: null,
  openingConfirmedAt: null,
  myAck: false,
  otherAck: false,
  ...over,
});
const view = (over = {}, options = {}) => orderProgressView({
  order: order(over),
  party: options.party ?? "renter",
  facts: Object.hasOwn(options, "facts") ? options.facts : null,
  readFailed: options.readFailed ?? false,
  payment: Object.hasOwn(options, "payment") ? options.payment : { state: null, displayState: null, blockedReason: null, readFailed: false },
});

const opened = facts({ rentalStarted: true, openingConfirmedAt: "2026-11-09T02:00:00Z", openingVersionNo: "1" });

/** Every state the matrix covers, used by the cross-cutting assertions below. */
function allViews() {
  return [
    view({ status: "PENDING_PAYMENT" }),
    view({ status: "PENDING_PAYMENT" }, { party: "owner" }),
    view({ status: "PENDING_PAYMENT", expiredAwaitingCancel: true }),
    view({}, { readFailed: true }),
    view({}),
    view({}, { facts: facts() }),
    view({}, { facts: facts({ openingVersionNo: "1" }) }),
    view({}, { facts: facts({ openingVersionNo: "1", myAck: true }) }),
    view({}, { facts: opened }),
    view({}, { facts: facts({ ...opened, phase: "INTAKE_PENDING" }) }),
    view({}, { facts: facts({ ...opened, phase: "DECISION_PENDING" }) }),
    view({}, { facts: facts({ ...opened, phase: "DECISION_WAITING" }) }),
    view({}, { facts: facts({ ...opened, phase: "DECISION_REJECTED" }) }),
    view({ status: "COMPLETED" }, { facts: facts({ ...opened, phase: "POSTED" }) }),
    view({ status: "COMPLETED" }, { facts: facts({ ...opened, phase: "DECISION_PENDING" }) }),
    view({ status: "CANCELLED" }),
    view({ status: "CANCELLED", cancelReason: "PRESTART_TERMINATED" }),
    view({ status: "CANCELLED", fundsResolution: { code: "HISTORICAL_MANUAL_CLOSE" } }),
    view({ status: "PAID", readOnly: true, source: { origin: "LEGACY" } }),
    view({ status: "COMPLETED", readOnly: true, source: { origin: "LEGACY" } }),
    view({ status: "FUTURE_STATUS" }),
    view({ status: "PENDING_PAYMENT" }, { payment: { state: "UNKNOWN", displayState: "CONFIRMING", blockedReason: "CHANNEL_RESULT_UNKNOWN", readFailed: false } }),
    view({ status: "PENDING_PAYMENT" }, { payment: { state: null, displayState: null, blockedReason: null, readFailed: true } }),
    view({}, { facts: facts({ ...opened, stageCode: "UNKNOWN" }) }),
  ];
}

const paymentUnknown = { state: "UNKNOWN", displayState: "CONFIRMING", blockedReason: "CHANNEL_RESULT_UNKNOWN", readFailed: false };

test("pending payment: renter gets the one payment action, owner never pays on their behalf", () => {
  const renter = view({ status: "PENDING_PAYMENT" });
  assert.equal(renter.owner, "你");
  assert.equal(renter.primary.label, "去支付");
  assert.equal(renter.primary.target, "trade");
  assert.match(renter.note, /结果未确认时查询原请求/);
  assert.match(renter.note, /模拟付款记录也不代表渠道扣款/);

  const owner = view({ status: "PENDING_PAYMENT" }, { party: "owner" });
  assert.equal(owner.owner, "对方");
  assert.equal(owner.primary.target, "refresh");
  assert.match(owner.note, /号主不能代付/);
  assert.ok(!JSON.stringify(owner).includes("去支付"));
});

test("expired payment hold: platform releases the account, no new payment is offered", () => {
  const expired = view({ status: "PENDING_PAYMENT", expiredAwaitingCancel: true });
  assert.equal(expired.owner, "平台");
  assert.equal(expired.primary.target, "refresh");
  assert.match(expired.note, /不再接受新的支付/);
  assert.ok(!JSON.stringify(expired).includes("去支付"));
});

test("a failed settlement read states known facts and retry, without inferring success or arrival", () => {
  const failed = view({}, { readFailed: true });
  assert.equal(failed.tone, "unknown");
  assert.equal(failed.pendingRead, true);
  assert.equal(failed.primary.label, "重试读取");
  assert.equal(failed.primary.target, "refresh");
  assert.ok(failed.known.some(line => line.includes("读取未成功")));
  assert.doesNotMatch(failed.note, /已开租|租用中|结算已生效|退款成功|结算未确认/);
  assert.doesNotMatch(failed.title, /已开租|结算已生效/);
});

test("an in-flight settlement read states no stage conclusion", () => {
  const pending = view({});
  assert.equal(pending.title, "正在核对当前进度");
  assert.equal(pending.pendingRead, true);
  assert.doesNotMatch(pending.note, /已开租|租用中|结算已生效/);
  assert.equal(pending.primary.target, "refresh");
});

test("no generated opening: support guidance, group readiness is never an opening", () => {
  const missing = view({}, { facts: facts() });
  assert.equal(missing.owner, "客服");
  assert.equal(missing.primary.target, "support");
  assert.match(missing.note, /不等于已经开租/);
  assert.match(missing.note, /不会自动生成清单或交付/);
  assert.equal(missing.primary.label, "联系客服");
});

test("opening checklist: each party confirms independently; due time is the frozen order value", () => {
  const mine = view({}, { facts: facts({ openingVersionNo: "1" }) });
  assert.equal(mine.owner, "你");
  assert.equal(mine.primary.label, "确认期初并开租");
  assert.equal(mine.primary.target, "trade");
  assert.match(mine.note, /截止时间取本单冻结值/);
  assert.match(mine.note, /本人、客服代操作与系统自动确认/);

  const waiting = view({}, { facts: facts({ openingVersionNo: "1", myAck: true, autoConfirmDueAt: "2026-11-09T03:00:00Z" }) });
  assert.equal(waiting.owner, "对方");
  assert.equal(waiting.primary.target, "refresh");
  assert.match(waiting.note, /冻结的截止时间由系统自动确认/);
  assert.ok(waiting.known.some(line => line.includes("本单冻结的自动确认截止时间")));

  // A historical DRAFT can legitimately have no frozen deadline; never promise an auto-confirm.
  const noDue = view({}, { facts: facts({ openingVersionNo: "1", myAck: true, autoConfirmDueAt: null }) });
  assert.doesNotMatch(noDue.note, /按本单冻结的截止时间由系统自动确认/);
  assert.match(noDue.note, /不会承诺系统会自动确认/);
  assert.ok(noDue.known.some(line => line.includes("本单未记录自动确认截止时间")));
});

test("renting: the end-rental form uses server pricing, never a browser calculation", () => {
  const renting = view({}, { facts: opened });
  assert.equal(renting.owner, "你");
  assert.equal(renting.primary.label, "发起结束租用");
  assert.match(renting.note, /最终金额不在浏览器计算/);
  assert.match(renting.note, /客服复核/);
});

test("intake pending: support owns the next step and no write action is offered", () => {
  const intake = view({}, { facts: facts({ ...opened, phase: "INTAKE_PENDING" }) });
  assert.equal(intake.owner, "客服");
  assert.match(intake.note, /当前没有需要你提交的写操作/);
  assert.equal(intake.primary.target, "refresh");
  assert.notEqual(intake.primary.target, "trade");
});

test("settlement decisions: confirm is mine, waiting is theirs, rejection is not a confirmation", () => {
  const pending = view({}, { facts: facts({ ...opened, phase: "DECISION_PENDING" }) });
  assert.equal(pending.owner, "你");
  assert.equal(pending.primary.label, "确认结算");
  assert.match(pending.note, /拒绝不会使这一版生效/);

  const waiting = view({}, { facts: facts({ ...opened, phase: "DECISION_WAITING" }) });
  assert.equal(waiting.owner, "对方");
  assert.equal(waiting.primary.target, "refresh");

  const rejected = view({}, { facts: facts({ ...opened, phase: "DECISION_REJECTED" }) });
  assert.equal(rejected.owner, "客服");
  assert.match(rejected.note, /拒绝不会使它生效/);
  assert.ok(!JSON.stringify(rejected).includes("确认结算"));
});

test("posted: terminal state keeps refund/aftersale, separates three independent money facts", () => {
  const posted = view({ status: "COMPLETED" }, { facts: facts({ ...opened, phase: "POSTED" }) });
  assert.equal(posted.terminal, true);
  assert.equal(posted.noNewTransaction, true);
  assert.equal(posted.primary.target, "refund");
  assert.match(posted.note, /应退金额、平台退款处理状态与渠道到账是三件独立的事/);
  assert.match(posted.note, /不会再次上架/);
  assert.ok(!JSON.stringify(posted).includes("确认结算"));
});

test("a completed status with a stale in-flight settlement read never offers a new write", () => {
  const mismatched = view({ status: "COMPLETED" }, { facts: facts({ ...opened, phase: "DECISION_PENDING" }) });
  assert.equal(mismatched.terminal, true);
  assert.equal(mismatched.noNewTransaction, true);
  assert.equal(mismatched.pendingRead, true);
  assert.equal(mismatched.primary.target, "refund");
  assert.ok(mismatched.known.some(line => line.includes("结算阶段与订单主状态不一致")));
  assert.ok(!JSON.stringify(mismatched).includes("确认结算"));
});

test("cancelled: terminal but not empty — refund, aftersale, support and role-specific next step", () => {
  const renter = view({ status: "CANCELLED" });
  assert.equal(renter.terminal, true);
  assert.equal(renter.noNewTransaction, true);
  assert.equal(renter.primary.target, "refund");
  assert.ok(renter.secondary.some(a => a.target === "support"));
  assert.match(renter.note, /不再提供开租或结算操作/);
  assert.match(renter.note, /不会因完单而再次上架/);

  // The existing attention band owns the single role-specific browse/manage link; the progress
  // card must not duplicate it into a second competing exit.
  for (const party of ["renter", "owner"]) {
    const state = view({ status: "CANCELLED" }, { party });
    assert.ok(!state.secondary.some(a => a.href === "/accounts" || a.href === "/account?view=accounts"), `${party} progress card duplicates the attention-band link`);
    assert.equal(state.primary.target, "refund");
  }
});

test("prestart termination: refund progress is shown, arrival is never claimed", () => {
  const prestart = view({ status: "CANCELLED", cancelReason: "PRESTART_TERMINATED" });
  assert.equal(prestart.primary.target, "refund");
  assert.match(prestart.note, /本地受理与核销都不等于渠道退款到账/);
});

test("historical manual close: funds stay unconfirmed and support owns the follow-up", () => {
  const closed = view({ status: "CANCELLED", fundsResolution: { code: "HISTORICAL_MANUAL_CLOSE" } });
  assert.equal(closed.owner, "客服");
  assert.equal(closed.primary.target, "support");
  assert.equal(closed.terminal, true);
  assert.match(closed.note, /不代表资金已处理或退款已到账/);
});

test("legacy in-flight: continuation capability is preserved, old price and old payment facts only", () => {
  const legacy = view({ status: "PAID", readOnly: true, source: { origin: "LEGACY" } });
  assert.equal(legacy.primary.label, "查看订单续办");
  assert.equal(legacy.primary.target, "legacy");
  assert.equal(legacy.terminal, false);
  assert.match(legacy.note, /不套用当前会员价格/);
  assert.match(legacy.note, /不是下单时的冻结快照/);
  assert.match(legacy.note, /资料缺失请联系客服/);
});

test("legacy completed/cancelled: readable facts, refund record and support only", () => {
  const legacy = view({ status: "COMPLETED", readOnly: true, source: { origin: "LEGACY" } });
  assert.equal(legacy.terminal, true);
  assert.equal(legacy.noNewTransaction, true);
  assert.equal(legacy.primary.target, "support");
  assert.match(legacy.note, /历史记录金额不代表渠道到账/);
  assert.ok(!JSON.stringify(legacy).includes("查看订单续办"));
});

test("an unknown server status never invents a stage", () => {
  const unknown = view({ status: "FUTURE_STATUS" });
  assert.equal(unknown.tone, "unknown");
  assert.equal(unknown.pendingRead, true);
  assert.equal(unknown.primary.target, "refresh");
  assert.doesNotMatch(`${unknown.title}${unknown.note}`, /已开租|租用中|结算已生效|退款已到账/);
});

test("every primary/secondary action only points at an existing capability, never a new write", () => {
  const allowed = new Set(["trade", "legacy", "refund", "support", "groups", "refresh", "browse", "manage", "list"]);
  for (const [index, state] of allViews().entries()) {
    const actions = [state.primary, ...state.secondary].filter(Boolean);
    assert.equal(actions.filter(a => a.target === "trade" && state.noNewTransaction).length, 0, `terminal state ${index} must not point at the transaction panel`);
    for (const action of actions) {
      assert.ok(allowed.has(action.target), `state ${index} has an unsupported target ${action.target}`);
      assert.doesNotMatch(`${action.label}${state.note}`, /自动上号|自动交付|即时退款|订单评价|新单续租/);
    }
  }
});

test("known facts never fabricate amounts or claim bank arrival", () => {
  for (const [index, state] of allViews().entries()) {
    for (const line of state.known) {
      assert.doesNotMatch(line, /¥|\d+\.\d{2}|退款成功|已到账/, `state ${index} fabricated a money fact`);
    }
    assert.doesNotMatch(state.title, /退款成功|已到账/);
  }
});

test("an unknown channel payment result never invites another payment", () => {
  const unknown = view({ status: "PENDING_PAYMENT" }, { payment: paymentUnknown });
  assert.equal(unknown.tone, "unknown");
  assert.equal(unknown.title, "支付结果正在确认");
  assert.match(unknown.note, /支付结果正在确认/);
  assert.notEqual(unknown.primary.label, "去支付");
  assert.ok(!JSON.stringify(unknown).includes("完成支付"));
  assert.ok(!JSON.stringify(unknown).includes("去支付"));

  const review = view({ status: "PENDING_PAYMENT" }, { payment: { state: "REVIEW_REQUIRED", displayState: "UNDER_REVIEW", blockedReason: "PAYMENT_REVIEW", readFailed: false } });
  assert.equal(review.title, "支付结果正在确认");
  const unreadable = view({ status: "PENDING_PAYMENT" }, { payment: { state: null, displayState: null, blockedReason: null, readFailed: true } });
  assert.equal(unreadable.primary.label, "重试读取");
  assert.ok(!JSON.stringify(unreadable).includes("去支付"));
  const owner = view({ status: "PENDING_PAYMENT" }, { party: "owner", payment: paymentUnknown });
  assert.equal(owner.title, "支付结果正在确认");
});

test("the server stage is a known fact and an UNKNOWN stage never invents a next step", () => {
  const stage = view({}, { facts: facts({ ...opened, phase: "DECISION_WAITING", stageCode: "DECISION_WAITING", viewerActionRequired: false }) });
  assert.ok(stage.known.some(line => line.includes("服务端结算阶段：DECISION_WAITING")));
  assert.ok(stage.known.some(line => line.includes("当前不需要你操作")));

  const unknown = view({}, { facts: facts({ ...opened, stageCode: "UNKNOWN" }) });
  assert.equal(unknown.tone, "unknown");
  assert.equal(unknown.title, "状态待核实");
  assert.notEqual(unknown.primary.target, "trade");
  assert.doesNotMatch(`${unknown.title}${unknown.note}`, /发起结束租用|确认期初/);
});

const legacyReport = (over = {}) => ({
  status: "PAID", party: "renter", availability: "KNOWN",
  capabilities: ["preview", "propose", "confirm", "reject"],
  stage: "3", isSettle: "0", reasons: [], refundProgress: [], pending: "NONE", readFailed: false,
  ...over,
});

test("legacy progress only promises capabilities the continuation read returned", () => {
  const active = legacyProgressView(legacyReport());
  assert.equal(active.primary.label, "查看订单续办");
  assert.equal(active.primary.target, "legacy");
  assert.match(active.note, /当前开放：预览金额、提交结算方案、确认结算方案、拒绝结算方案/);
  assert.ok(active.known.some(line => line.includes("服务端开放的续办能力")));

  const noCaps = legacyProgressView(legacyReport({ capabilities: [] }));
  assert.equal(noCaps.primary.target, "support");
  assert.match(noCaps.note, /没有为这笔旧单开放新的续办写操作/);
  assert.ok(!JSON.stringify(noCaps).includes("查看订单续办"));
});

test("legacy terminal orders keep facts, refund records and support, but no continuation promise", () => {
  for (const status of ["COMPLETED", "CANCELLED"]) {
    const terminal = legacyProgressView(legacyReport({ status }));
    assert.equal(terminal.terminal, true);
    assert.equal(terminal.owner, "暂无");
    assert.equal(terminal.primary.target, "support");
    assert.match(terminal.note, /不再提供开租、结算或新的续办写操作/);
    assert.ok(!JSON.stringify(terminal).includes("查看订单续办"));
    assert.ok(!JSON.stringify(terminal).includes("预览、提交、确认、拒绝与结果恢复能力"));
  }
});

test("legacy missing evidence, failed read and a saved original-key intent each get their own next step", () => {
  const isolated = legacyProgressView(legacyReport({ availability: "ISOLATED", reasons: ["EVIDENCE_ISOLATED"] }));
  assert.equal(isolated.title, "资料待客服核对");
  assert.equal(isolated.primary.target, "support");
  assert.match(isolated.note, /不承诺有任何可用的预览/);
  assert.ok(isolated.known.some(line => line.includes("EVIDENCE_ISOLATED")));

  const unread = legacyProgressView(legacyReport({ availability: null }));
  assert.equal(unread.title, "续办状态待核对");
  assert.equal(unread.primary.label, "重试读取");
  assert.ok(!JSON.stringify(unread).includes("查看订单续办"));

  const pending = legacyProgressView(legacyReport({ pending: "VALID" }));
  assert.equal(pending.primary.label, "查询原请求");
  assert.equal(pending.primary.target, "legacy");
  assert.match(pending.note, /不要重复提交/);
});

test("legacy stage owner and pending refund records stay visible", () => {
  assert.equal(legacyProgressView(legacyReport({ stage: "8", party: "renter" })).owner, "对方");
  assert.equal(legacyProgressView(legacyReport({ stage: "9", party: "renter" })).owner, "你");
  const refund = legacyProgressView(legacyReport({ refundProgress: ["PROCESSING"] }));
  assert.ok(refund.known.some(line => line.includes("退款处理中")));
  assert.match(refund.note, /待处理的退款记录/);
});

test("pending renter payment does not invite payment before the channel read settles", () => {
  const loading = view({ status: "PENDING_PAYMENT" }, { party: "renter", payment: null });
  assert.equal(loading.pendingRead, true);
  assert.doesNotMatch(JSON.stringify(loading), /去支付|完成支付/);
  const ready = view({ status: "PENDING_PAYMENT" }, { party: "renter", payment: { state: null, displayState: null, blockedReason: null, readFailed: false } });
  assert.equal(ready.primary.label, "去支付");
});