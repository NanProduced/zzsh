// 全部SYNTHETIC：协议和服务端装配假设/内存事务模型；没有官方原件、PG或JOINPAY/APPLIED正例。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { computeJoinpayNotificationDecision, evaluateJoinpayNotify, JOINPAY_SIGNATURE_ORDER } from "../src/order/joinpay-protocol";
import { bindJoinpayCollectionProfile, assertCollectionProfile, bindFormalJoinpayCollectionAdmission, readFormalCollectionAdmission,
  describeCollectionProfile, produceJoinpayCollectionRequest, joinpayProviderTimeToUtc, assertFormalCollectionStart, COLLECTION_REQUIRED_RULES,
  type CollectionServerProfile, type CollectionProfileOperation, type FormalCollectionAdmission } from "../src/order/joinpay-collection-profile";
import { captureJoinpayCollectionEvidence, readVerifiedJoinpayFactScope, readJoinpayCollectionEvidenceRecovery, type FormalCollectionSourceOptions } from "../src/order/joinpay-collection-source";
import { receiveJoinpayCollectionNotification } from "../src/order/joinpay-collection-attempt";
import { confirmOrderPayment } from "../src/order/payment-confirmation";
import { createNativePaymentDistributionStore } from "../src/finance/distribution-payment-store";
import { sendJoinpayNotificationAcknowledgement, handleJoinpayCollectionNotification, JOINPAY_COLLECTION_NOTIFICATION_PATH } from "../src/order/joinpay-collection-notification-routes";
import { validateDistributionPolicy } from "../src/finance/distribution-policy";
import { canonicalize } from "../src/supply/content-hash";
import { freezePaymentDistributionBasis } from "../src/finance/distribution-payment-basis";

const KEY = "SYNTHETIC_PUBLIC_VECTOR_ONLY", MERCHANT = "888000000000001", ORDER = "G2_fixture_1";
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex");
const sign = (names: readonly string[], values: Record<string, string>) => createHash("md5").update(names.map(n => values[n] ?? "").join("") + KEY).digest("hex");
const notification = (patch: Record<string, string> = {}) => ({ r0_Version: "2.6", r1_MerchantNo: MERCHANT, r2_OrderNo: ORDER, r3_Amount: "123.45", r4_Cur: "1",
  r6_Status: "100", r7_TrxNo: "fixture_trx", ra_PayTime: "2026-10-23 10:00:00", rb_DealTime: "2026-10-23 10:00:01",
  rc_BankCode: "ALIPAY", re_DiscountAmount: "0.00", rk_FrpCode: "ALIPAY_NATIVE", ro_SettleAmount: "123.45", ...patch });
const wire = (values: Record<string, string>, extraEncodeTimes = false) => new URLSearchParams({ ...values,
  ...(extraEncodeTimes ? { ra_PayTime: encodeURIComponent(values.ra_PayTime!), rb_DealTime: encodeURIComponent(values.rb_DealTime!) } : {}),
  hmac: sign(JOINPAY_SIGNATURE_ORDER.asyncNotify, values) }).toString();
const request = { state: "SUBMITTING" as const, merchantNo: MERCHANT, orderNo: ORDER, amountCents: "12345", frpCode: "ALIPAY_NATIVE" };

// 仅模拟受信后端已经审阅配置的输入边界；并没有提供/接受任何真实官方原件，不用于正式事实/APPLIED。
function descriptor(operations: readonly CollectionProfileOperation[] = ["SUBMIT", "QUERY", "NOTIFY"], mode: "OFFICIAL" | "SYNTHETIC" = "OFFICIAL"): CollectionServerProfile {
  const evidence = { source: mode === "OFFICIAL" ? "JOINPAY_OFFICIAL" as const : "SYNTHETIC" as const, reference: "fixture_document_reference", sha256: "1".repeat(64) };
  const answer = (names: readonly string[]) => { const values = Object.fromEntries(names.map((n, i) => [n, "value" + i]));
    return { ...evidence, values, vectorKey: KEY, expectedHmac: sign(names, values) }; };
  return { profileId: mode === "OFFICIAL" ? "fixture_profile" : "SYNTHETIC_fixture", merchantIdentityId: mode === "OFFICIAL" ? "fixture_merchant" : "synthetic_fixture",
    wireMerchantNo: MERCHANT, tradeMerchantNo: "fixture_trade", notifyUrl: "https://merchant.fixture.test/notify", purpose: "COLLECTION", evidenceMode: mode,
    operations: Object.fromEntries(operations.map(op => [op, { keyVersionRef: "fixture_key", rules: Object.fromEntries(COLLECTION_REQUIRED_RULES[op].map(r => [r, evidence])),
      requestKnownAnswer: op === "NOTIFY" ? "NOT_OBTAINED" : answer(JOINPAY_SIGNATURE_ORDER[op === "SUBMIT" ? "uniPayRequest" : "queryOrderRequest"]),
      responseKnownAnswer: answer(JOINPAY_SIGNATURE_ORDER[op === "SUBMIT" ? "uniPaySyncResponse" : op === "QUERY" ? "queryOrderResponse" : "asyncNotify"]),
      ...(op === "SUBMIT" ? {} : { timeOffsetMinutes: 480 }), ...(op === "NOTIFY" ? { notificationDecoding: { ra_PayTime: 0, rb_DealTime: 0 } } : {}) }])) };
}
function assembly(operations?: readonly CollectionProfileOperation[]) {
  const input = descriptor(operations), profile = bindJoinpayCollectionProfile(input);
  const server = { kind: "JOINPAY_FORMAL_SERVER_REVIEW" as const, reference: "fixture_review", reviewSha256: "2".repeat(64), appId: "fixture_app",
    database: "fixture_database", runtimeUser: "fixture_runtime", merchantIdentityId: input.merchantIdentityId, wireMerchantNo: MERCHANT, profiles: [profile] };
  return { input, profile, server };
}

test("SYNTHETIC通知：完整签名及绑定通过，卡类型/手续费可缺，任一官网必填缺失均拒绝", () => {
  const values = notification(), good = computeJoinpayNotificationDecision(wire(values), request, KEY);
  assert.equal(good.event, "E4"); assert.equal(good.signature, "MATCH"); assert.equal(good.ack, "success");
  for (const name of ["rb_DealTime", "rc_BankCode", "re_DiscountAmount", "ro_SettleAmount"]) {
    const missing: Record<string, string> = { ...values }; delete missing[name]; assert.equal(computeJoinpayNotificationDecision(wire(missing), request, KEY).event, "E11");
  }
  assert.equal(computeJoinpayNotificationDecision(wire(values), { ...request, amountCents: "12346" }, KEY).binding, "MISMATCH");
  assert.equal(computeJoinpayNotificationDecision(wire(values), request, KEY + "wrong").signature, "MISMATCH");
  assert.equal(computeJoinpayNotificationDecision(wire(values) + "&r1_MerchantNo=" + MERCHANT, request, KEY).event, "E11");
  assert.equal(evaluateJoinpayNotify(wire(values), { request, key: KEY }).result, "CHANNEL_SIGNED_SYNTHETIC");
});
test("SYNTHETIC raw URI只按明确时间字段次数解码，旧合成API不偷偷多解码", () => {
  const raw = wire(notification(), true);
  assert.equal(computeJoinpayNotificationDecision(raw, request, KEY).event, "E11");
  assert.equal(computeJoinpayNotificationDecision(raw, request, KEY, { ra_PayTime: 1, rb_DealTime: 1 }).event, "E4");
  assert.equal(evaluateJoinpayNotify(raw, { request, key: KEY }).event, "E11");
  assert.equal(computeJoinpayNotificationDecision(raw, request, KEY, { ra_PayTime: 2, rb_DealTime: 0 } as never).event, "E11");
});
test("SYNTHETIC独立NOTIFY profile不借QUERY KAT/钥，outbound运行时拒NOTIFY", () => {
  const profile = bindJoinpayCollectionProfile(descriptor(["NOTIFY"], "SYNTHETIC"));
  assert.doesNotThrow(() => assertCollectionProfile(profile, "NOTIFY"));
  assert.throws(() => assertCollectionProfile(profile, "QUERY"), { code: "COLLECTION_OPERATION_NOT_CONFIRMED" });
  assert.throws(() => produceJoinpayCollectionRequest(profile, "NOTIFY" as never, {} as never, KEY), { code: "COLLECTION_OUTBOUND_OPERATION_INVALID" });
  assert.equal(joinpayProviderTimeToUtc(profile, "NOTIFY", "2026-10-23 10:00:00"), "2026-10-23T02:00:00.000Z");
  assert.throws(() => joinpayProviderTimeToUtc(profile, "NOTIFY", "2026-02-30 10:00:00"), { code: "COLLECTION_PROVIDER_TIME_INVALID" });
  const noZone = descriptor(["NOTIFY"], "SYNTHETIC"); delete noZone.operations.NOTIFY!.timeOffsetMinutes;
  assert.throws(() => joinpayProviderTimeToUtc(bindJoinpayCollectionProfile(noZone), "NOTIFY", "2026-10-23 10:00:00"), { code: "COLLECTION_TIMEZONE_NOT_CONFIRMED" });
});
test("受信装配假设模型只验证op-only与native方法冻结，不是官方准入或JOINPAY/APPLIED", () => {
  const a = assembly(["NOTIFY"]), admission = bindFormalJoinpayCollectionAdmission(a.server), store = createNativePaymentDistributionStore(admission);
  assert.equal(Object.isFrozen(store), true); assert.throws(() => Object.assign(store, { record: () => ({}) }), TypeError);
  assert.equal(JSON.parse(readFormalCollectionAdmission(admission).canonical).acceptedProfiles.length, 1);
  assert.throws(() => assertFormalCollectionStart(admission), { code: "COLLECTION_FORMAL_START_INCOMPLETE" });
  assert.throws(() => readFormalCollectionAdmission({ ...admission }), { code: "COLLECTION_FORMAL_ADMISSION_NOT_BOUND" });
});
test("裸OFFICIAL/G1虚构引用/A2/拷贝品牌/访问器和自定义迭代器均不能安装正式准入", () => {
  const a = assembly(); let reads = 0;
  const getter = { ...a.server }; Object.defineProperty(getter, "profiles", { enumerable: true, get: () => { reads++; return a.server.profiles; } });
  assert.throws(() => bindFormalJoinpayCollectionAdmission(getter), { code: "COLLECTION_FORMAL_ADMISSION_INVALID" }); assert.equal(reads, 0);
  const list = [...a.server.profiles]; Object.defineProperty(list, Symbol.iterator, { value: function* () { return; } });
  assert.throws(() => bindFormalJoinpayCollectionAdmission({ ...a.server, profiles: list }), { code: "COLLECTION_FORMAL_ADMISSION_INVALID" });
  for (const changed of [{ reviewSha256: { toString: () => "2".repeat(64) } }, { reference: "SYNTHETIC_REVIEW" }, { wireMerchantNo: "888100000002340" }, { profiles: [] }, { profiles: [{ ...a.profile }] }])
    assert.throws(() => bindFormalJoinpayCollectionAdmission({ ...a.server, ...changed } as never));
  const g1 = descriptor(); g1.operations.SUBMIT!.rules = Object.fromEntries(COLLECTION_REQUIRED_RULES.SUBMIT.map(r => [r, { source: "JOINPAY_OFFICIAL", reference: "SYNTHETIC_OFFICIAL_CONFIGURATION_MODEL_NOT_REAL", sha256: "1".repeat(64) }]));
  assert.throws(() => bindFormalJoinpayCollectionAdmission({ ...a.server, profiles: [bindJoinpayCollectionProfile(g1)] }), { code: "COLLECTION_FORMAL_PROFILE_NOT_ACCEPTED" });
});
test("任意JOINPAY JSON和其他client没有事实品牌，SQL前即拒绝", async () => {
  let queries = 0; const client = { query: async () => { queries++; return { rows: [] }; } } as unknown as PoolClient;
  await assert.rejects(readVerifiedJoinpayFactScope(client, { source: "JOINPAY" }));
  await assert.rejects(confirmOrderPayment(client, { source: "JOINPAY" } as never)); assert.equal(queries, 0);
});

function memoryNotice() {
  const a = assembly(), admission = bindFormalJoinpayCollectionAdmission(a.server), view = readFormalCollectionAdmission(admission);
  const state = { evidence: new Set<string>(), audit: 0 }, trace: string[] = []; let loseCommit = false, failAudit = false, isOldModel = false;
  const original = { request_id: "payreq_" + "a".repeat(32), order_id: "fixture_order", state: "SUBMITTING", merchant_identity_id: a.input.merchantIdentityId,
    channel_order_no: ORDER, amount_cents: "12345", method: "ALIPAY_NATIVE", config_profile_id: a.input.profileId, key_version_ref: "fixture_key", channel: "JOINPAY",
    evidence_level: "JOINPAY_CANDIDATE", wire_merchant_no: MERCHANT, trade_merchant_no: a.input.tradeMerchantNo, product_name: "fixture_product", notify_url: a.input.notifyUrl,
    initial_profile_sha256: describeCollectionProfile(a.profile, "SUBMIT").profileSha256, formal_admission_ref: view.reference, formal_admission_sha256: view.sha256, formal_admission_canonical: view.canonical };
  const pool = { connect: async () => { let local = structuredClone(state); return { release() {}, query: async (q: string, p: unknown[] = []) => {
    trace.push(q);
    if (q === "BEGIN") { local = structuredClone(state); return { rows: [] }; }
    if (q === "ROLLBACK") return { rows: [] };
    if (q === "COMMIT") { Object.assign(state, local); if (loseCommit) throw Object.assign(Error("SYNTHETIC_ACK_LOSS"), { code: "ECONNRESET" }); return { rows: [] }; }
    if (q.includes("pg_current_xact_id()")) return { rows: [{ db: view.database, actor: view.runtimeUser, xid: "123" }] };
    if (q.startsWith("SELECT r.id AS request_id")) return { rows: [{ ...original, ...(isOldModel ? { formal_admission_ref: null, formal_admission_sha256: null, formal_admission_canonical: null } : {}) }] };
    if (q.startsWith("INSERT INTO zzsh_order.joinpay_collection_evidence")) { const id = String(p[0]), present = local.evidence.has(id); local.evidence.add(id); return { rows: [], rowCount: present ? 0 : 1 }; }
    if (q.includes('INSERT INTO "zzsh_iam"."audit_event"')) { if (failAudit) throw Object.assign(Error("SYNTHETIC_AUDIT_DENIED"), { code: "42501" }); local.audit++; return { rows: [] }; }
    throw Error("Unexpected SYNTHETIC SQL: " + q);
  } }; } } as unknown as Pool;
  const options: FormalCollectionSourceOptions = { admission, profileFor: () => a.profile, keyFor: () => KEY };
  return { pool, options, state, trace, lose: () => { loseCommit = true; }, denyAudit: () => { failAudit = true; }, old: () => { isOldModel = true; } };
}
test("SYNTHETIC非付款通知模型：同原件重复不建第二行，ACK在COMMIT后；不产生正式付款事实", async () => {
  const h = memoryNotice(), raw = wire(notification({ r6_Status: "101" }));
  assert.deepEqual(await receiveJoinpayCollectionNotification(h.pool, h.options, raw), { status: 200, body: "success" });
  assert.equal(h.trace.at(-1), "COMMIT"); assert.equal(h.state.evidence.size, 1);
  assert.deepEqual(await receiveJoinpayCollectionNotification(h.pool, h.options, raw), { status: 200, body: "success" }); assert.equal(h.state.evidence.size, 1);
  assert(!h.trace.some(q => q.includes("INSERT INTO zzsh_order.payment_confirmation")));
});
test("SYNTHETIC审计真实错误形状及COMMIT ACK丢失模型都回fail，不发送或重放下单", async () => {
  for (const mode of ["audit", "commit"] as const) { const h = memoryNotice(); mode === "audit" ? h.denyAudit() : h.lose();
    assert.deepEqual(await receiveJoinpayCollectionNotification(h.pool, h.options, wire(notification({ r6_Status: "101" }))), { status: 503, body: "fail" });
    assert.equal(h.state.evidence.size, mode === "audit" ? 0 : 1); assert.equal(h.trace.filter(q => q === "COMMIT").length, mode === "audit" ? 0 : 1);
  }
});
test("旧G1初始准入NULL即拒，不能靠当前OFFICIAL配置回填；未绑定品牌不读库/钥", async () => {
  const h = memoryNotice(); h.old(); assert.deepEqual(await receiveJoinpayCollectionNotification(h.pool, h.options, wire(notification())), { status: 503, body: "fail" });
  assert.equal(h.state.evidence.size, 0); assert(!h.trace.some(q => /^INSERT|^UPDATE/.test(q)));
  let connected = 0; const pool = { connect: async () => { connected++; throw Error(); } } as unknown as Pool;
  assert.deepEqual(await receiveJoinpayCollectionNotification(pool, { ...h.options, admission: {} as FormalCollectionAdmission }, "x=y"), { status: 503, body: "fail" }); assert.equal(connected, 0);
});
test("通知adapter精确原URI/上限/方法及纯文本，不使用登录/BFF成功依据", async () => {
  const h = memoryNotice(), sent: { status: number; headers: Record<string, string>; body: string } = { status: 0, headers: {}, body: "" };
  const response = { status(n: number) { sent.status = n; return this; }, setHeader(k: string, v: string) { sent.headers[k] = v; return this; }, send(body: string) { sent.body = body; } } as never;
  sendJoinpayNotificationAcknowledgement(response, { status: 200, body: "success" }); assert.equal(sent.body, "success"); assert.equal(Buffer.byteLength(sent.body), 7);
  assert.equal(await handleJoinpayCollectionNotification({ method: "POST", originalUrl: JOINPAY_COLLECTION_NOTIFICATION_PATH, headers: {} } as never, response, { pool: h.pool, source: h.options }), true);
  assert.equal(sent.status, 405); assert.equal(sent.body, "fail");
  await handleJoinpayCollectionNotification({ method: "GET", originalUrl: JOINPAY_COLLECTION_NOTIFICATION_PATH + "?x=" + "x".repeat(65537), headers: {} } as never, response, { pool: h.pool, source: h.options });
  assert.equal(sent.body, "fail"); assert.equal(h.trace.length, 0);
});
test("原证据恢复只读且不补basis；NATIVE政策必须显式scope，旧默认LOCAL不放宽", async () => {
  const trace: string[] = []; const c = { query: async (q: string) => { trace.push(q); return { rows: [] }; } } as unknown as PoolClient;
  assert.equal(await readJoinpayCollectionEvidenceRecovery(c, "jpe_" + "a".repeat(32)), null); assert(trace.every(q => q.startsWith("SELECT")));
  const policy = { schema: "distribution-policy.v1", scope: "NATIVE", enabled: false, participation: "AUTO_AT_REGISTRATION", depth: 1, selfRebate: false,
    accountModes: ["ordinary"], minimumAccrualCents: "0", settlementDelayDays: 0, levels: [{ code: "BASE", rank: 1, default: true, renterPercent: "0", ownerPercent: "0", upgrade: null }] };
  assert.throws(() => validateDistributionPolicy(policy)); assert.throws(() => validateDistributionPolicy({ ...policy, scope: "OTHER" }, "OTHER" as never));
  const config = validateDistributionPolicy(policy, "NATIVE"); assert.equal(config.scope, "NATIVE");
  const facts = (["RENTER_REFERRAL", "OWNER_REFERRAL"] as const).map((role, i) => ({ role, partyUserId: "fixture_party" + i,
    relation: { knowledge: "UNKNOWN" as const, id: null, childUserId: "fixture_party" + i, parentUserId: null, sourceDigest: null }, beneficiary: null }));
  const basis = freezePaymentDistributionBasis({ orderId: "fixture_order", gameId: "fixture_game", currency: "CNY", confirmationId: "fixture_confirmation",
    acceptedAt: "2026-10-23T00:00:00.000Z", paymentDigest: "3".repeat(64), admissionId: "fixture_admission", admissionRevision: "1", origin: "NATIVE", accountMode: "ordinary", estimate: null,
    policy: { versionId: "fixture_policy", digest: hash(canonicalize(config)), config }, facts });
  assert.equal(basis.roles.length, 2); assert(basis.roles.every(r => r.estimatedCents === null)); assert.equal(basis.policyConfig?.scope, "NATIVE");
});
