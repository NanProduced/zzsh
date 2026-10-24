import assert from "node:assert/strict";
import { test } from "node:test";
import { loadJoinpayCollectionRuntime, type JoinpayCollectionRuntimeDocument } from "../src/order/joinpay-collection-runtime";
import { COLLECTION_REQUIRED_RULES, describeCollectionProfile, readFormalCollectionAdmission, assertFormalInitialAdmission,
  type CollectionProfileOperation, type CollectionServerProfile, type CollectionPersistedBinding } from "../src/order/joinpay-collection-profile";
import { channelPaymentReadOptions } from "../src/order/channel-payment-routes";
import type { AppConfig } from "../src/config/config";

// 全部为SYNTHETIC_ASSEMBLY_ONLY：OFFICIAL字段只是受信装配假设，不是官方证据、准入或付款事实。
const KEY = "fixture_key_for_runtime_test_only";
const context = { authEnabled: true, provider: "real" as const, database: {
  name: "zzsh_provider_test_runtime_fixture", user: "runtime_fixture_r", runtimeUser: "runtime_fixture_r",
} as AppConfig["database"] };
function profile(operation: CollectionProfileOperation, version = "01"): CollectionServerProfile {
  return { profileId: `unit_${operation.toLowerCase()}_${version}`, merchantIdentityId: "unit_merchant_01", wireMerchantNo: "999900000000001",
    tradeMerchantNo: "unit_trade_01", notifyUrl: "https://callback.invalid/api/v1/payment-notifications/joinpay",
    purpose: "COLLECTION", evidenceMode: "OFFICIAL", operations: { [operation]: {
      keyVersionRef: `key_version_${version}`, requestKnownAnswer: "NOT_OBTAINED", responseKnownAnswer: "NOT_OBTAINED",
      rules: Object.fromEntries(COLLECTION_REQUIRED_RULES[operation].map(k => [k, {
        source: "JOINPAY_OFFICIAL" as const, reference: "unit-fixture-not-vendor-evidence", sha256: "1".repeat(64),
      }])), ...(operation !== "SUBMIT" ? { timeOffsetMinutes: 480 } : {}),
      ...(operation === "NOTIFY" ? { notificationDecoding: { ra_PayTime: 1 as const, rb_DealTime: 0 as const } } : {}),
    } } };
}
function document(): JoinpayCollectionRuntimeDocument {
  return { admission: { kind: "JOINPAY_FORMAL_SERVER_REVIEW", reference: "unit_review_01", reviewSha256: "2".repeat(64),
    appId: "unit_app_01", database: context.database.name, runtimeUser: context.database.user,
    merchantIdentityId: "unit_merchant_01", wireMerchantNo: "999900000000001" },
    profiles: [profile("SUBMIT"), profile("QUERY"), profile("NOTIFY")], submitProfileId: "unit_submit_01", queryProfileId: "unit_query_01",
    notifyProfilesByInitialKey: { key_version_01: "unit_notify_01" }, keyVariables: { key_version_01: "JOINPAY_COLLECTION_KEY_01" },
    productName: "虚构配置校验", qrHostAllowlist: ["qr.invalid"], newRequestsEnabled: false };
}
function environment(doc = document(), changes: NodeJS.ProcessEnv = {}) {
  return { JOINPAY_COLLECTION_ENABLED: "true", JOINPAY_COLLECTION_CONFIG: JSON.stringify(doc), JOINPAY_COLLECTION_KEY_01: KEY, ...changes };
}
function original(doc = document()): CollectionPersistedBinding {
  const p = doc.profiles.find(p => p.profileId === doc.submitProfileId)!;
  return { requestId: "unit_request_01", originalOrderNo: "UNIT_ORDER_01", amountCents: "12345", method: "ALIPAY_NATIVE",
    merchantIdentityId: p.merchantIdentityId, wireMerchantNo: p.wireMerchantNo, tradeMerchantNo: p.tradeMerchantNo,
    productName: doc.productName!, notifyUrl: p.notifyUrl, profileId: p.profileId, keyVersionRef: p.operations.SUBMIT!.keyVersionRef };
}
const rejected = (action: () => unknown, code: string) => assert.throws(action, { name: "ConfigurationError", message: code });

test("SYNTHETIC装配：默认/显式关闭不读配置或钥，不触发连接和后台任务", () => {
  for (const enabled of [undefined, "false"]) {
    const reads: string[] = [];
    const env = new Proxy({ JOINPAY_COLLECTION_ENABLED: enabled }, { get(target, key) {
      reads.push(String(key)); if (key !== "JOINPAY_COLLECTION_ENABLED") throw Error("unexpected private read");
      return Reflect.get(target, key);
    } });
    assert.equal(loadJoinpayCollectionRuntime(context, env), undefined);
    assert.deepEqual(reads, ["JOINPAY_COLLECTION_ENABLED"]);
  }
});

test("启用值及身份/provider/runtime角色不符时，在配置/密钥读取之前拒绝", () => {
  for (const value of ["1", "TRUE", " true", "false ", ""]) rejected(() => loadJoinpayCollectionRuntime(context, { JOINPAY_COLLECTION_ENABLED: value }), "JOINPAY_COLLECTION_ENABLED_INVALID");
  for (const ctx of [{ ...context, authEnabled: false }, { ...context, provider: "fake" as const },
    { ...context, database: { ...context.database, user: "migration_role" } }]) {
    const env = new Proxy({ JOINPAY_COLLECTION_ENABLED: "true" }, { get(target, key) {
      if (key !== "JOINPAY_COLLECTION_ENABLED") throw Error("configuration was read too early"); return Reflect.get(target, key);
    } });
    rejected(() => loadJoinpayCollectionRuntime(ctx, env), "JOINPAY_COLLECTION_RUNTIME_CONTEXT_INVALID");
  }
});

test("配置错误只返回固定码，不回显JSON、路径或secret内容", () => {
  for (const raw of ["private_fixture_marker", "[", "[]", "null", JSON.stringify({ ...document(), password: "private_fixture_marker" }),
    JSON.stringify({ ...document(), productName: "x".repeat(262145) })]) {
    rejected(() => loadJoinpayCollectionRuntime(context, environment(document(), { JOINPAY_COLLECTION_CONFIG: raw })), "JOINPAY_COLLECTION_CONFIG_UNAVAILABLE");
  }
});

test("错资源、A2用途/商户及合成profile不能从启动装配获得正式品牌", () => {
  for (const field of ["database", "runtimeUser"] as const) { const d = document(); d.admission[field] = "other_resource";
    rejected(() => loadJoinpayCollectionRuntime(context, environment(d)), "JOINPAY_COLLECTION_RESOURCE_MISMATCH"); }
  for (const mutate of [(d: JoinpayCollectionRuntimeDocument) => { d.profiles[0]!.purpose = "A2_SIGNATURE_ONLY"; },
    (d: JoinpayCollectionRuntimeDocument) => { d.admission.wireMerchantNo = "888100000002340"; d.profiles.forEach(p => { p.wireMerchantNo = "888100000002340"; }); },
    (d: JoinpayCollectionRuntimeDocument) => { d.profiles[0]!.evidenceMode = "SYNTHETIC"; }]) {
    const d = document(); mutate(d); rejected(() => loadJoinpayCollectionRuntime(context, environment(d)), "JOINPAY_COLLECTION_ASSEMBLY_REJECTED");
  }
});

test("关闭新请求仍保留原键恢复、读取与通知装配，三处共用同一准入和钥解析器", () => {
  const a = loadJoinpayCollectionRuntime(context, environment())!;
  assert.equal(a.routes!.initial, undefined); assert.equal(a.recovery, undefined);
  assert.equal(a.routes!.execution!.formal, a.notifications);
  assert.equal(a.routes!.read!.formalAdmission, a.notifications!.admission);
  assert.equal(a.routes!.execution!.keyFor, a.notifications!.keyFor);
  assert.equal(channelPaymentReadOptions(a.routes, true).formalWriteRouteReady, false);
  assert.equal(readFormalCollectionAdmission(a.notifications!.admission).database, context.database.name);
});

test("显式开启新请求复用原初始wire；装配就绪不等于PG/schema/渠道可用", () => {
  const d = document(); d.newRequestsEnabled = true;
  const a = loadJoinpayCollectionRuntime(context, environment(d))!;
  assert.deepEqual(a.routes!.initial!.wire, { tradeMerchantNo: d.profiles[0]!.tradeMerchantNo, productName: d.productName, notifyUrl: d.profiles[0]!.notifyUrl });
  assert.equal(a.routes!.initial!.admission, a.notifications!.admission);
  assert.equal(channelPaymentReadOptions(a.routes, true).formalWriteRouteReady, true);
  assert.equal(a.routes!.execution!.profileFor("SUBMIT", original(d)), a.routes!.initial!.profile);
});

test("密钥按固定引用惰性读取并缓存，未知引用不访问env，错误不泄漏钥内容", () => {
  let reads = 0;
  const env = environment(); Object.defineProperty(env, "JOINPAY_COLLECTION_KEY_01", { get() { reads++; return KEY; } });
  const a = loadJoinpayCollectionRuntime(context, env)!; assert.equal(reads, 0);
  rejected(() => a.notifications!.keyFor("unknown_ref"), "JOINPAY_COLLECTION_KEY_REFERENCE_MISSING"); assert.equal(reads, 0);
  assert.equal(a.notifications!.keyFor("key_version_01"), KEY); const firstReads = reads; assert(firstReads > 0);
  assert.equal(a.notifications!.keyFor("key_version_01"), KEY); assert.equal(reads, firstReads);
  const bad = environment(); Object.defineProperty(bad, "JOINPAY_COLLECTION_KEY_01_FILE", { get() { throw Error("private_fixture_marker"); } });
  rejected(() => loadJoinpayCollectionRuntime(context, bad)!.notifications!.keyFor("key_version_01"), "JOINPAY_COLLECTION_KEY_UNAVAILABLE");
});

test("profile轮换：当前QUERY与持久三元组分别选择；通知只选显式映射的一份钥配置", () => {
  const d = document(); d.profiles.push(profile("QUERY", "02"), profile("NOTIFY", "02"));
  d.queryProfileId = "unit_query_02"; d.notifyProfilesByInitialKey.key_version_01 = "unit_notify_02";
  d.keyVariables.key_version_02 = "JOINPAY_COLLECTION_KEY_02";
  const a = loadJoinpayCollectionRuntime(context, environment(d))!, source = a.notifications!, old = original(d);
  const current = describeCollectionProfile(source.profileFor("QUERY", old), "QUERY"); assert.equal(current.profileId, "unit_query_02");
  const oldQuery = describeCollectionProfile(source.profileFor("QUERY", old, { profileId: "unit_query_01", profileSha256:
    describeCollectionProfile(loadJoinpayCollectionRuntime(context, environment())!.notifications!.profileFor("QUERY", old), "QUERY").profileSha256,
    keyVersionRef: "key_version_01" }), "QUERY"); assert.equal(oldQuery.profileId, "unit_query_01");
  assert.equal(describeCollectionProfile(source.profileFor("NOTIFY", old), "NOTIFY").keyVersionRef, "key_version_02");
  rejected(() => source.profileFor("QUERY", old, { ...current, profileSha256: "0".repeat(64) }), "JOINPAY_COLLECTION_PINNED_PROFILE_MISMATCH");
  rejected(() => source.profileFor("NOTIFY", { ...old, keyVersionRef: "unmapped_old_key" }), "JOINPAY_COLLECTION_PROFILE_UNAVAILABLE");
  rejected(() => source.profileFor("NOTIFY", { ...old, merchantIdentityId: "different_merchant" }), "JOINPAY_COLLECTION_ORIGINAL_MERCHANT_MISMATCH");
});

test("配置缺少历史通知/key映射、重复profile或不支持的操作时拒绝，不猜协议", () => {
  for (const [mutate, code] of [
    [(d: JoinpayCollectionRuntimeDocument) => { delete d.keyVariables.key_version_01; }, "JOINPAY_COLLECTION_KEY_REFERENCE_MISSING"],
    [(d: JoinpayCollectionRuntimeDocument) => { delete d.notifyProfilesByInitialKey.key_version_01; }, "JOINPAY_COLLECTION_NOTIFY_SELECTION_MISSING"],
    [(d: JoinpayCollectionRuntimeDocument) => { d.profiles.push(d.profiles[0]!); }, "JOINPAY_COLLECTION_DUPLICATE_PROFILE"],
    [(d: JoinpayCollectionRuntimeDocument) => { d.queryProfileId = d.submitProfileId!; }, "JOINPAY_COLLECTION_ASSEMBLY_REJECTED"],
    [(d: JoinpayCollectionRuntimeDocument) => { d.keyVariables.key_version_01 = "AUTH_ADMIN_SECRET"; }, "JOINPAY_COLLECTION_KEY_REFERENCE_INVALID"],
  ] as const) { const d = document(); mutate(d); rejected(() => loadJoinpayCollectionRuntime(context, environment(d)), code); }
});

test("QR允许名单须为精确host；关闭新请求可保持空名单安全降级", () => {
  for (const host of ["*.invalid", "https://qr.invalid", "qr.invalid:8443", "QR.invalid", "a.invalid/path", "user@qr.invalid", "qr.invalid#x"]) {
    const d = document(); d.qrHostAllowlist = [host]; rejected(() => loadJoinpayCollectionRuntime(context, environment(d)), "JOINPAY_COLLECTION_CONFIG_UNAVAILABLE");
  }
  const d = document(); d.qrHostAllowlist = []; assert(loadJoinpayCollectionRuntime(context, environment(d)));
  d.newRequestsEnabled = true; rejected(() => loadJoinpayCollectionRuntime(context, environment(d)), "JOINPAY_COLLECTION_CONFIG_UNAVAILABLE");
});

test("恢复参数显式且有界；无恢复参数时不擅自启动后台补查", () => {
  const d = document(); d.recovery = { workerId: "unit_worker", batchLimit: 2, minimumIntervalSeconds: 60 };
  assert.deepEqual(loadJoinpayCollectionRuntime(context, environment(d))!.recovery, d.recovery);
  for (const invalid of [{ ...d.recovery, batchLimit: 0 }, { ...d.recovery, batchLimit: 11 }, { ...d.recovery, minimumIntervalSeconds: 29 },
    { ...d.recovery, minimumIntervalSeconds: 86401 }, { ...d.recovery, workerId: " " }, { ...d.recovery, extra: true }]) {
    d.recovery = invalid; rejected(() => loadJoinpayCollectionRuntime(context, environment(d)), "JOINPAY_COLLECTION_RECOVERY_INVALID");
  }
});

test("关闭新请求允许仅QUERY/NOTIFY配置，旧准入需显式接受且不借用SUBMIT资格", () => {
  const originalDoc = document(); originalDoc.newRequestsEnabled = true;
  const previous = readFormalCollectionAdmission(loadJoinpayCollectionRuntime(context, environment(originalDoc))!.notifications!.admission);
  const d = document(); d.profiles = d.profiles.filter(p => p.operations.SUBMIT === undefined);
  delete d.submitProfileId; delete d.productName;
  d.admission.acceptedInitialAdmissions = [{ reference: previous.reference, sha256: previous.sha256 }];
  const a = loadJoinpayCollectionRuntime(context, environment(d))!, source = a.notifications!;
  assert.equal(a.routes!.initial, undefined); assert.equal(channelPaymentReadOptions(a.routes, true).formalWriteRouteReady, false);
  assertFormalInitialAdmission(source.admission, previous.reference, previous.sha256);
  const operations = JSON.parse(readFormalCollectionAdmission(source.admission).canonical).acceptedProfiles.map((p: { operation: string }) => p.operation).sort();
  assert.deepEqual(operations, ["NOTIFY", "QUERY"]);
  assert.equal(describeCollectionProfile(source.profileFor("QUERY", original(originalDoc)), "QUERY").profileId, "unit_query_01");
  assert.equal(describeCollectionProfile(source.profileFor("NOTIFY", original(originalDoc)), "NOTIFY").profileId, "unit_notify_01");
  rejected(() => source.profileFor("SUBMIT", original(originalDoc)), "JOINPAY_COLLECTION_PROFILE_UNAVAILABLE");
  d.newRequestsEnabled = true;
  rejected(() => loadJoinpayCollectionRuntime(context, environment(d)), "JOINPAY_COLLECTION_CONFIG_UNAVAILABLE");
});

test("仅切新请求开关不改已接纳准入摘要；显式历史通知映射无需保留退役SUBMIT或旧钥", () => {
  const d = document(); d.newRequestsEnabled = true;
  const first = readFormalCollectionAdmission(loadJoinpayCollectionRuntime(context, environment(d))!.notifications!.admission);
  d.newRequestsEnabled = false;
  const closed = loadJoinpayCollectionRuntime(context, environment(d))!;
  assert.equal(readFormalCollectionAdmission(closed.notifications!.admission).sha256, first.sha256);
  d.notifyProfilesByInitialKey.retired_initial_key = "unit_notify_01";
  const history = loadJoinpayCollectionRuntime(context, environment(d))!;
  assert.equal(describeCollectionProfile(history.notifications!.profileFor("NOTIFY", { ...original(d), keyVersionRef: "retired_initial_key" }), "NOTIFY").profileId, "unit_notify_01");
  rejected(() => history.notifications!.keyFor("retired_initial_key"), "JOINPAY_COLLECTION_KEY_REFERENCE_MISSING");
});
