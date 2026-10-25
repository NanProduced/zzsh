// SYNTHETIC_ASSEMBLY_ONLY：下列审核、规则、时区均为装配假设，不是官方准入或银行证据。
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AppConfig } from "../src/config/config";
import { loadJoinpayRefundRuntime, type JoinpayRefundRuntimeDocument } from "../src/order/joinpay-refund-runtime";
import { readFormalRefundAdmission, describeRefundProfile, assertInitialRefundAdmission, type RefundOperation,
  type RefundBinding, type RefundServerProfile } from "../src/order/joinpay-refund-profile";

const KEY = "SYNTHETIC_REFUND_RUNTIME_KEY";
const context = { provider: "real" as const, authEnabled: true, database: { name: "unit_refund_database", user: "unit_refund_r", runtimeUser: "unit_refund_r" } as AppConfig["database"] };
function profile(operation: RefundOperation, version = "01"): RefundServerProfile {
  return { operation, purpose: "MERCHANT_REFUND", profileId: "unit_refund_" + version, merchantIdentityId: "unit_merchant", merchantNo: "999900000000001",
    database: context.database.name, runtimeUser: context.database.user, keyVersionRef: "key_" + version, notifyUrl: "https://callback.invalid/api/v1/refunds/joinpay/notifications",
    reviewRef: "unit_review_not_vendor_evidence", reviewSha256: "1".repeat(64), permission: "REVIEWED_NATIVE_RENTAL_REFUND",
    rules: { reference: "unit_rules_not_vendor_evidence", sha256: "2".repeat(64), signing: "MD5_UTF8_RAW_VALUES", rawQueryDecode: "ONCE",
      numberTokens: "RAW_JSON_TOKEN", fieldPolicy: "STRICT_TABLE_EMPTY_OPTIONAL", refundIdentifier: "EXACT_TEXT", notify102: "REVIEW",
      utcOffsetMinutes: 480, refundWay: "ORIGINAL_REQUIRED", failureNoExecution: { accepted: false, codes: [], reference: null, sha256: null } }, knownAnswer: "NOT_OBTAINED" };
}
function document(): JoinpayRefundRuntimeDocument {
  return { admission: { reference: "unit_refund_admission", reviewSha256: "3".repeat(64) }, profiles: [profile("SUBMIT"), profile("QUERY"), profile("NOTIFY")],
    submitProfileId: "unit_refund_01", queryProfileId: "unit_refund_01", notifyProfilesByInitialKey: { key_01: "unit_refund_01" },
    keyVariables: { key_01: "JOINPAY_REFUND_KEY_01" }, newRefundsEnabled: false };
}
function env(d = document(), extra: NodeJS.ProcessEnv = {}) {
  return { JOINPAY_REFUND_ENABLED: "true", JOINPAY_REFUND_CONFIG: JSON.stringify(d), JOINPAY_REFUND_KEY_01: KEY, ...extra };
}
function original(): RefundBinding {
  const d = document(); d.newRefundsEnabled = true; d.recovery = { workerId: "unit_worker", batchLimit: 1, minimumIntervalSeconds: 60 };
  const assembly = loadJoinpayRefundRuntime(context, env(d))!, p = describeRefundProfile(assembly.initialProfile!, "SUBMIT");
  return { intentId: "refund_one", postingId: "posting_one", orderId: "order_one", paymentConfirmationId: "payment_one", renterUserId: "renter_one",
    merchantIdentityId: p.merchantIdentityId, merchantNo: p.merchantNo, originalPaymentTrxNo: "pay_trx_one", originalPaymentOrderNo: "ORDER_ONE",
    responsibilityVersionHash: "4".repeat(64), refundOrderNo: "RF1234567890123456789012345678", amountCents: "12345", currency: "CNY",
    notifyUrl: p.notifyUrl, profileId: p.profileId, initialProfileSha256: p.profileSha256, keyVersionRef: p.keyVersionRef };
}
const rejected = (fn: () => unknown, message: string) => assert.throws(fn, { name: "ConfigurationError", message });

test("默认及显式关闭仅看开关，不取配置/钥/启动任务", () => {
  for (const value of [undefined, "false"]) {
    const reads: string[] = [], e = new Proxy({ JOINPAY_REFUND_ENABLED: value }, { get(t, p) { reads.push(String(p)); assert.equal(p, "JOINPAY_REFUND_ENABLED"); return Reflect.get(t, p); } });
    assert.equal(loadJoinpayRefundRuntime(context, e), undefined); assert.deepEqual(reads, ["JOINPAY_REFUND_ENABLED"]);
  }
});

test("非法开关及非正式/未认证/非runtime上下文在配置读取之前拒绝", () => {
  for (const value of ["TRUE", " true", "0", ""]) rejected(() => loadJoinpayRefundRuntime(context, { JOINPAY_REFUND_ENABLED: value }), "JOINPAY_REFUND_ENABLED_INVALID");
  for (const c of [{ ...context, provider: "fake" as const }, { ...context, authEnabled: false }, { ...context, database: { ...context.database, user: "migration_user" } }]) {
    const e = new Proxy({ JOINPAY_REFUND_ENABLED: "true" }, { get(t, p) { assert.equal(p, "JOINPAY_REFUND_ENABLED"); return Reflect.get(t, p); } });
    rejected(() => loadJoinpayRefundRuntime(c, e), "JOINPAY_REFUND_RUNTIME_CONTEXT_INVALID");
  }
});

test("JSON、超限、未知字段与坏恢复参数只出固定码，不回显配置", () => {
  for (const raw of ["PRIVATE_FIXTURE_MARKER", "null", "[]", JSON.stringify({ ...document(), secret: "PRIVATE_FIXTURE_MARKER" }),
    JSON.stringify({ ...document(), queryProfileId: "x".repeat(262145) })]) {
    rejected(() => loadJoinpayRefundRuntime(context, env(document(), { JOINPAY_REFUND_CONFIG: raw })), "JOINPAY_REFUND_CONFIG_UNAVAILABLE");
  }
  for (const recovery of [{ workerId: " ", batchLimit: 1, minimumIntervalSeconds: 60 }, { workerId: "worker", batchLimit: 11, minimumIntervalSeconds: 60 },
    { workerId: "worker", batchLimit: 1, minimumIntervalSeconds: 29 }, { workerId: "worker", batchLimit: 1, minimumIntervalSeconds: 86401 }]) {
    const d = document(); d.recovery = recovery; rejected(() => loadJoinpayRefundRuntime(context, env(d)), "JOINPAY_REFUND_RECOVERY_INVALID");
  }
});

test("A2/合成来源/错资源/商户混组均不能取得正式装配", () => {
  for (const change of [(d: JoinpayRefundRuntimeDocument) => { d.profiles.forEach(p => { (p as any).merchantNo = "888100000002340"; }); },
    (d: JoinpayRefundRuntimeDocument) => { (d.profiles[0] as any).purpose = "SYNTHETIC_PROTOCOL"; },
    (d: JoinpayRefundRuntimeDocument) => { (d.profiles[0] as any).merchantIdentityId = "different_merchant"; }]) {
    const d = document(); change(d); rejected(() => loadJoinpayRefundRuntime(context, env(d)), "JOINPAY_REFUND_ASSEMBLY_REJECTED");
  }
  const d = document(); (d.profiles[0] as any).database = "another_database";
  rejected(() => loadJoinpayRefundRuntime(context, env(d)), "JOINPAY_REFUND_RESOURCE_MISMATCH");
});

test("同profileId可分属不同操作；关闭新分配无initial且钥不读取", () => {
  let keys = 0; const e = env(); Object.defineProperty(e, "JOINPAY_REFUND_KEY_01", { get() { keys++; return KEY; } });
  const a = loadJoinpayRefundRuntime(context, e)!; assert.equal(a.initialProfile, undefined); assert.equal(a.recovery, undefined); assert.equal(keys, 0);
  assert.equal(a.profileFor("QUERY", original()).kind, "BOUND_JOINPAY_REFUND_PROFILE");
  assert.equal(a.profileFor("NOTIFY", original()).kind, "BOUND_JOINPAY_REFUND_PROFILE"); assert.equal(keys, 0);
});

test("新分配必须明确初始profile与恢复配置，返回同一准入内的SUBMIT", () => {
  const d = document(); d.newRefundsEnabled = true;
  rejected(() => loadJoinpayRefundRuntime(context, env(d)), "JOINPAY_REFUND_CONFIG_UNAVAILABLE");
  d.recovery = { workerId: "unit_worker", batchLimit: 2, minimumIntervalSeconds: 60 };
  const a = loadJoinpayRefundRuntime(context, env(d))!; assert(a.initialProfile);
  assert.equal(a.profileFor("SUBMIT", original()), a.initialProfile); assert.deepEqual(a.recovery, d.recovery);
  const before = readFormalRefundAdmission(a.admission).sha256; d.newRefundsEnabled = false;
  const closed = loadJoinpayRefundRuntime(context, env(d))!; assert.equal(closed.initialProfile, undefined); assert.equal(readFormalRefundAdmission(closed.admission).sha256, before);
});

test("QUERY/NOTIFY型恢复无需SUBMIT selector，历史准入仍显式接受，不能首次SUBMIT", () => {
  const full = loadJoinpayRefundRuntime(context, env())!, prior = readFormalRefundAdmission(full.admission), d = document();
  d.profiles = d.profiles.filter(p => p.operation !== "SUBMIT"); delete d.submitProfileId;
  d.admission.historicalInitialAdmissions = [{ reference: prior.reference, sha256: prior.sha256 }];
  d.recovery = { workerId: "unit_worker", batchLimit: 2, minimumIntervalSeconds: 60 };
  const a = loadJoinpayRefundRuntime(context, env(d))!; assert.equal(a.initialProfile, undefined); assertInitialRefundAdmission(a.admission, prior.reference, prior.sha256);
  assert.equal(a.profileFor("QUERY", original()).kind, "BOUND_JOINPAY_REFUND_PROFILE");
  assert.equal(a.profileFor("NOTIFY", original()).kind, "BOUND_JOINPAY_REFUND_PROFILE");
  rejected(() => a.profileFor("SUBMIT", original()), "JOINPAY_REFUND_PROFILE_UNAVAILABLE");
});

test("QUERY轮换、历史三元复验及通知单一映射不改原退款号/金额", () => {
  const initial = original(), d = document(); d.profiles.push(profile("QUERY", "02"), profile("NOTIFY", "02"));
  d.queryProfileId = "unit_refund_02"; d.notifyProfilesByInitialKey.key_01 = "unit_refund_02"; d.keyVariables.key_02 = "JOINPAY_REFUND_KEY_02";
  const a = loadJoinpayRefundRuntime(context, env(d))!, oldQuery = loadJoinpayRefundRuntime(context, env())!.profileFor("QUERY", initial), old = describeRefundProfile(oldQuery, "QUERY");
  assert.equal(describeRefundProfile(a.profileFor("QUERY", initial), "QUERY").keyVersionRef, "key_02");
  assert.equal(describeRefundProfile(a.profileFor("QUERY", initial, old), "QUERY").profileSha256, old.profileSha256);
  assert.equal(describeRefundProfile(a.profileFor("NOTIFY", initial), "NOTIFY").keyVersionRef, "key_02");
  rejected(() => a.profileFor("QUERY", initial, { ...old, profileSha256: "0".repeat(64) }), "JOINPAY_REFUND_PINNED_PROFILE_MISMATCH");
  assert.equal(initial.refundOrderNo, "RF1234567890123456789012345678"); assert.equal(initial.amountCents, "12345");
  assert.throws(() => a.profileFor("NOTIFY", { ...initial, merchantIdentityId: "other_merchant" }), /REFUND_BINDING_MISMATCH/);
});

test("退役初始钥只作通知selector；未知钥不读env，正常钥惰性缓存且异常脱敏", () => {
  const d = document(); d.notifyProfilesByInitialKey.retired_key = "unit_refund_01"; let reads = 0;
  const e = env(d); Object.defineProperty(e, "JOINPAY_REFUND_KEY_01", { get() { reads++; return KEY; } });
  const a = loadJoinpayRefundRuntime(context, e)!; assert.equal(reads, 0);
  assert.equal(a.profileFor("NOTIFY", { ...original(), keyVersionRef: "retired_key" }).kind, "BOUND_JOINPAY_REFUND_PROFILE");
  rejected(() => a.keyFor("retired_key"), "JOINPAY_REFUND_KEY_REFERENCE_MISSING"); assert.equal(reads, 0);
  assert.equal(a.keyFor("key_01"), KEY); const first = reads; assert(first > 0); assert.equal(a.keyFor("key_01"), KEY); assert.equal(reads, first);
  const bad = env(d); Object.defineProperty(bad, "JOINPAY_REFUND_KEY_01_FILE", { get() { throw Error("PRIVATE_FIXTURE_MARKER"); } });
  rejected(() => loadJoinpayRefundRuntime(context, bad)!.keyFor("key_01"), "JOINPAY_REFUND_KEY_UNAVAILABLE");
});

test("缺/错映射、重复操作profile、不允许的key命名在装配时拒绝", () => {
  for (const [change, code] of [
    [(d: JoinpayRefundRuntimeDocument) => { d.profiles.push(d.profiles[0]!); }, "JOINPAY_REFUND_DUPLICATE_PROFILE"],
    [(d: JoinpayRefundRuntimeDocument) => { delete d.keyVariables.key_01; }, "JOINPAY_REFUND_KEY_REFERENCE_MISSING"],
    [(d: JoinpayRefundRuntimeDocument) => { d.keyVariables.key_01 = "AUTH_ADMIN_SECRET"; }, "JOINPAY_REFUND_KEY_REFERENCE_INVALID"],
    [(d: JoinpayRefundRuntimeDocument) => { d.notifyProfilesByInitialKey = {}; }, "JOINPAY_REFUND_NOTIFY_SELECTION_INVALID"],
    [(d: JoinpayRefundRuntimeDocument) => { d.notifyProfilesByInitialKey.key_01 = "missing_profile"; }, "JOINPAY_REFUND_PROFILE_UNAVAILABLE"],
  ] as const) { const d = document(); change(d); rejected(() => loadJoinpayRefundRuntime(context, env(d)), code); }
});
