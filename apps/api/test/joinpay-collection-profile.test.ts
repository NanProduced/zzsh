// SYNTHETIC_OFFICIAL_CONFIGURATION_MODEL：虚构服务端批准输入/钥/向量；不是官方已知答案或实际渠道准入。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as protocol from "../src/order/joinpay-protocol";
import { bindJoinpayCollectionProfile, assertCollectionProfile, describeCollectionProfile, produceJoinpayCollectionRequest,
  inspectJoinpayCollectionResponse, assertCollectionRequestBinding, readCollectionOutboundRequest, readCollectionProfileEvidence, COLLECTION_REQUIRED_RULES,
  type CollectionOperation, type CollectionServerProfile, type CollectionPersistedBinding, type CollectionKnownAnswer } from "../src/order/joinpay-collection-profile";
const KEY = "SYNTHETIC_KEY_NOT_REAL_0001", MERCHANT = "888000000000001", ORDER = "ZZPAY_G1_MODEL_01";
const refSign = (order: readonly string[], values: Record<string, string>) => createHash("md5").update(order.map(name => values[name] ?? "").join("") + KEY).digest("hex");
function modelProfile(mode: "OFFICIAL" | "SYNTHETIC" = "OFFICIAL"): CollectionServerProfile {
  const source = mode === "OFFICIAL" ? "JOINPAY_OFFICIAL" as const : "SYNTHETIC" as const;
  const evidence = { source, reference: "SYNTHETIC_OFFICIAL_CONFIGURATION_MODEL_NOT_REAL", sha256: "1".repeat(64) };
  const answer = (order: readonly string[]): CollectionKnownAnswer => {
    const values = Object.fromEntries(order.map((name, i) => [name, i === 0 ? "2.6" : "SYNTHETIC_" + i]));
    return { ...evidence, values, vectorKey: KEY, expectedHmac: refSign(order, values) };
  };
  return { profileId: mode === "OFFICIAL" ? "model_profile_1" : "SYNTHETIC_profile_1", merchantIdentityId: "synthetic_stable_merchant_1", wireMerchantNo: MERCHANT,
    tradeMerchantNo: "SYNTHETIC_TRADE_1", notifyUrl: "https://example.invalid/joinpay/notify?a=%26", purpose: "COLLECTION", evidenceMode: mode,
    operations: Object.fromEntries((["SUBMIT", "QUERY"] as const).map(operation => [operation, { keyVersionRef: "model_key_1",
      rules: Object.fromEntries(COLLECTION_REQUIRED_RULES[operation].map(rule => [rule, { ...evidence }])),
      requestKnownAnswer: answer(operation === "SUBMIT" ? protocol.JOINPAY_SIGNATURE_ORDER.uniPayRequest : protocol.JOINPAY_SIGNATURE_ORDER.queryOrderRequest),
      responseKnownAnswer: answer(operation === "SUBMIT" ? protocol.JOINPAY_SIGNATURE_ORDER.uniPaySyncResponse : protocol.JOINPAY_SIGNATURE_ORDER.queryOrderResponse) }])) };
}
function binding(input: CollectionServerProfile): CollectionPersistedBinding {
  return { requestId: "model_request_1", originalOrderNo: ORDER, amountCents: "12345", method: "ALIPAY_NATIVE", wireMerchantNo: MERCHANT,
    merchantIdentityId: input.merchantIdentityId, tradeMerchantNo: input.tradeMerchantNo, productName: "虚构 + %26", notifyUrl: input.notifyUrl,
    profileId: input.profileId, keyVersionRef: input.operations.SUBMIT!.keyVersionRef };
}
const SYNC = { r0_Version: "2.6", r1_MerchantNo: MERCHANT, r2_OrderNo: ORDER, r3_Amount: "123.45", r4_Cur: "1", r6_FrpCode: "ALIPAY_NATIVE",
  r7_TrxNo: "MODEL_TRX_01", ra_Code: "100", rb_CodeMsg: "虚构受理", rc_Result: "https://example.invalid/model-qr" };
const QUERY = { r0_Version: "2.6", r1_MerchantNo: MERCHANT, r2_OrderNo: ORDER, r3_Amount: "123.45", r5_TrxNo: "MODEL_TRX_01", r7_Fee: "0.00",
  r8_FrpCode: "ALIPAY_NATIVE", ra_Status: "100", rb_Code: "100", rc_CodeMsg: "", rd_OpenId: "model", re_DiscountAmount: "0.00",
  rf_PayTime: "2026-10-23 10:00:00", rj_BankCode: "ALIPAY", ro_SettleAmount: "123.45" };
const signed = (operation: CollectionOperation, values: Record<string, string>) => JSON.stringify({ ...values,
  hmac: refSign(operation === "SUBMIT" ? protocol.JOINPAY_SIGNATURE_ORDER.uniPaySyncResponse : protocol.JOINPAY_SIGNATURE_ORDER.queryOrderResponse, values) });

test("profile运行时品牌不能经JSON或对象复制伪造，outbound同样不可伪造", () => {
  const input = modelProfile(), profile = bindJoinpayCollectionProfile(input);
  for (const fake of [{ profileId: input.profileId }, JSON.parse(JSON.stringify(profile))]) assert.throws(() => assertCollectionProfile(fake as never, "SUBMIT"), { code: "COLLECTION_PROFILE_NOT_BOUND" });
  const request = produceJoinpayCollectionRequest(profile, "SUBMIT", binding(input), KEY);
  assert.throws(() => readCollectionOutboundRequest({ ...request }), { code: "COLLECTION_OUTBOUND_NOT_BOUND" });
  assert.equal(Object.isFrozen(request), true); assert.equal(Object.isFrozen(readCollectionOutboundRequest(request)), true);
});
test("逐操作任一官方规则尚未取得就拒绝，不从另一操作继承", () => {
  for (const operation of ["SUBMIT", "QUERY"] as const) for (const rule of COLLECTION_REQUIRED_RULES[operation]) {
    const input = modelProfile(); input.operations[operation]!.rules = { ...input.operations[operation]!.rules, [rule]: "NOT_OBTAINED" };
    const profile = bindJoinpayCollectionProfile(input); assert.throws(() => assertCollectionProfile(profile, operation), { code: "COLLECTION_RULE_NOT_CONFIRMED" });
    assert.doesNotThrow(() => assertCollectionProfile(profile, operation === "SUBMIT" ? "QUERY" : "SUBMIT"));
  }
  const missing = modelProfile(); delete missing.operations.QUERY;
  assert.throws(() => assertCollectionProfile(bindJoinpayCollectionProfile(missing), "QUERY"), { code: "COLLECTION_OPERATION_NOT_CONFIRMED" });
});
test("request/response官方向量任一未取得、来源错误或签名不符均关闭操作", () => {
  for (const operation of ["SUBMIT", "QUERY"] as const) for (const field of ["requestKnownAnswer", "responseKnownAnswer"] as const) {
    const absent = modelProfile(); absent.operations[operation]![field] = "NOT_OBTAINED";
    assert.throws(() => assertCollectionProfile(bindJoinpayCollectionProfile(absent), operation), { code: "COLLECTION_KNOWN_ANSWER_NOT_OBTAINED" });
    const bad = modelProfile(); (bad.operations[operation]![field] as CollectionKnownAnswer).expectedHmac = "0".repeat(32);
    assert.throws(() => assertCollectionProfile(bindJoinpayCollectionProfile(bad), operation), { code: "COLLECTION_KNOWN_ANSWER_MISMATCH" });
    const source = modelProfile(); (source.operations[operation]![field] as CollectionKnownAnswer).source = "SYNTHETIC";
    assert.throws(() => assertCollectionProfile(bindJoinpayCollectionProfile(source), operation), { code: "COLLECTION_RULE_NOT_CONFIRMED" });
  }
});
test("A2用途及已知A2账号都禁止正式SUBMIT/QUERY，不因完整模型配置放行", () => {
  for (const operation of ["SUBMIT", "QUERY"] as const) for (const kind of ["purpose", "merchant"] as const) {
    const input = modelProfile(); if (kind === "purpose") input.purpose = "A2_SIGNATURE_ONLY"; else input.wireMerchantNo = "888100000002340";
    assert.throws(() => assertCollectionProfile(bindJoinpayCollectionProfile(input), operation), { code: "COLLECTION_A2_PURPOSE_FORBIDDEN" });
  }
});
test("绑定配置是独立不可变快照；无secret摘要不随原对象修改变化", () => {
  const input = modelProfile(), profile = bindJoinpayCollectionProfile(input), first = describeCollectionProfile(profile, "SUBMIT");
  input.profileId = "mutated"; input.operations.SUBMIT!.keyVersionRef = "mutated"; input.operations.SUBMIT!.rules = {};
  assert.deepEqual(describeCollectionProfile(profile, "SUBMIT"), first); assert.equal(Object.isFrozen(first), true);
  assert.match(first.profileSha256, /^[a-f0-9]{64}$/); assert.equal(JSON.stringify(first).includes(KEY), false); assert.equal(first.protocolVersion, "2.6");
});
test("正式生产者独立使用中性构造，URLSearchParams只编码一次并固定原件SHA", () => {
  const input = modelProfile(), profile = bindJoinpayCollectionProfile(input), original = binding(input), request = produceJoinpayCollectionRequest(profile, "SUBMIT", original, KEY);
  const params = new URLSearchParams(request.encodedBody); assert.equal(params.get("p5_ProductName"), original.productName); assert.equal(params.get("p9_NotifyUrl"), original.notifyUrl);
  assert.equal(params.get("p2_OrderNo"), ORDER); assert.equal(params.get("p3_Amount"), "123.45"); assert.equal(params.get("qa_TradeMerchantNo"), original.tradeMerchantNo);
  assert.equal(request.requestSha256, createHash("sha256").update(request.encodedBody).digest("hex"));
  assert.equal(readCollectionOutboundRequest(request).encodedBody, request.encodedBody); assert.equal(readCollectionOutboundRequest(request).endpoint, "https://trade.joinpay.com/tradeRt/uniPay");
  assert.equal(JSON.stringify(request).includes(KEY), false);
});
test("SUBMIT固定初始profile/key；QUERY轮换当前profile/key但稳定商户和原单不变", () => {
  const first = modelProfile(), original = binding(first), changed = modelProfile(); changed.profileId = "model_profile_2"; changed.operations.QUERY!.keyVersionRef = "model_key_2";
  changed.tradeMerchantNo = "MODEL_NEW_TRADE"; changed.notifyUrl = "https://example.invalid/new-notify";
  const profile = bindJoinpayCollectionProfile(changed); assert.throws(() => produceJoinpayCollectionRequest(profile, "SUBMIT", original, KEY), { code: "COLLECTION_PERSISTED_BINDING_MISMATCH" });
  const query = produceJoinpayCollectionRequest(profile, "QUERY", original, KEY); assert.equal(query.profileId, changed.profileId); assert.equal(query.keyVersionRef, "model_key_2");
  assert.equal(new URLSearchParams(query.encodedBody).get("p2_OrderNo"), original.originalOrderNo); assert.equal(readCollectionOutboundRequest(query).endpoint, "https://trade.joinpay.com/tradeRt/queryOrder");
  for (const patch of [{ merchantIdentityId: "another_merchant" }, { wireMerchantNo: "888000000000002" }]) {
    assert.throws(() => produceJoinpayCollectionRequest(profile, "QUERY", { ...original, ...patch }, KEY), { code: "COLLECTION_PERSISTED_BINDING_MISMATCH" });
  }
});
test("金额/原号/方法/密钥错误不输出原值，QUERY也验证原金额", () => {
  const input = modelProfile(), profile = bindJoinpayCollectionProfile(input), original = binding(input);
  for (const operation of ["SUBMIT", "QUERY"] as const) for (const patch of [{ amountCents: "0" }, { amountCents: "1.5" }, { originalOrderNo: "bad-order" }, { method: "OTHER" }]) {
    assert.throws(() => produceJoinpayCollectionRequest(profile, operation, { ...original, ...patch } as CollectionPersistedBinding, KEY), error => !String(error).includes(KEY));
  }
  assert.throws(() => produceJoinpayCollectionRequest(profile, "QUERY", original, ""), { code: "KEY_REQUIRED" });
});
test("中性SYNC/QUERY检查分别报告schema/签名/绑定，只保留原始时间，不形成APPLIED", () => {
  const input = modelProfile(), profile = bindJoinpayCollectionProfile(input), original = binding(input);
  const sync = inspectJoinpayCollectionResponse(profile, "SUBMIT", signed("SUBMIT", SYNC), original, KEY);
  assert.equal(sync.verified, true); assert.equal(sync.event, "E1"); assert.equal(sync.result, "ACTION_READY"); assert.equal("paymentAction" in sync, false);
  const query = inspectJoinpayCollectionResponse(profile, "QUERY", signed("QUERY", QUERY), original, KEY);
  assert.equal(query.verified, true); assert.equal(query.event, "E4"); assert.equal(query.providerPaidAtRaw, QUERY.rf_PayTime);
  assert.equal("providerPaidAt" in query, false); assert.equal("formalAcceptance" in query, false); assert.equal(Object.values(query).includes("APPLIED" as never), false);
});
test("schema/签名/金额绑定失败与成功依据不全均不是verified", () => {
  const input = modelProfile(), profile = bindJoinpayCollectionProfile(input), original = binding(input);
  const schema = inspectJoinpayCollectionResponse(profile, "SUBMIT", "{}", original, KEY); assert.equal(schema.schema, "INVALID"); assert.equal(schema.verified, false);
  const signature = inspectJoinpayCollectionResponse(profile, "SUBMIT", JSON.stringify({ ...SYNC, hmac: "0".repeat(32) }), original, KEY); assert.equal(signature.signature, "MISMATCH"); assert.equal(signature.verified, false);
  const mismatch = inspectJoinpayCollectionResponse(profile, "SUBMIT", signed("SUBMIT", { ...SYNC, r3_Amount: "0.01" }), original, KEY); assert.equal(mismatch.binding, "MISMATCH"); assert.equal(mismatch.verified, false);
  const incomplete: Record<string, string> = { ...QUERY }; delete incomplete.r3_Amount;
  const missing = inspectJoinpayCollectionResponse(profile, "QUERY", signed("QUERY", incomplete), original, KEY); assert.equal(missing.result, "QUERY_EVIDENCE_INCOMPLETE"); assert.equal(missing.verified, false);
});
test("旧合成builder/判断API/商户准入语义保持原值", () => {
  const form = protocol.buildJoinpayQueryRequest({ merchantNo: MERCHANT, orderNo: ORDER }, KEY); assert.equal(form.sendable, false); assert.equal(form.evidenceLevel, "SYNTHETIC_PROTOCOL");
  assert.throws(() => protocol.assertJoinpayMerchantUsable(), { code: "PROFILE_NOT_VERIFIED" });
  const ctx = { request: { state: "SUBMITTING" as const, merchantNo: MERCHANT, orderNo: ORDER, amountCents: "12345", frpCode: "ALIPAY_NATIVE" }, key: KEY, leaseCurrent: true };
  const result = protocol.evaluateJoinpaySyncResponse(signed("SUBMIT", SYNC), ctx); assert.equal(result.evidenceLevel, "SYNTHETIC_PROTOCOL"); assert.equal(result.formalAcceptance, false); assert.equal(result.officialVerified, false);
  const rejected = protocol.evaluateJoinpayQueryResponse(signed("QUERY", { ...QUERY, rb_Code: "101" }), ctx); assert.equal(rejected.signature, "NOT_CHECKED");
});

test("公开profile原件与摘要同字节且禁止夹带未知商户密钥属性", () => {
  const input = modelProfile(), profile = bindJoinpayCollectionProfile(input), canonical = readCollectionProfileEvidence(profile, "SUBMIT");
  assert.equal(createHash("sha256").update(canonical).digest("hex"), describeCollectionProfile(profile, "SUBMIT").profileSha256);
  assert.notEqual(canonical, readCollectionProfileEvidence(profile, "QUERY"));
  assert.deepEqual(Object.keys(JSON.parse(canonical).operations), ["SUBMIT"]);
  assert.equal(createHash("sha256").update(readCollectionProfileEvidence(profile, "QUERY")).digest("hex"), describeCollectionProfile(profile, "QUERY").profileSha256);
  // 此处KAT验证钥故意等于本次操作签名钥；序列化仍不得包含它或vectorKey字段。
  assert.equal(canonical.includes(KEY), false); assert.equal(canonical.includes("vectorKey"), false); assert.equal(JSON.stringify(profile).includes(KEY), false);
  assert.throws(() => bindJoinpayCollectionProfile({ ...input, merchantKey: "NEVER_CAPTURE" } as CollectionServerProfile), { code: "COLLECTION_PROFILE_INVALID" });
  const nested = modelProfile(); nested.operations.SUBMIT!.rules = { ...nested.operations.SUBMIT!.rules,
    [COLLECTION_REQUIRED_RULES.SUBMIT[0]!]: { source: "JOINPAY_OFFICIAL", reference: "MODEL", sha256: "1".repeat(64), merchantKey: "NEVER_CAPTURE" } as never };
  assert.throws(() => readCollectionProfileEvidence(bindJoinpayCollectionProfile(nested), "SUBMIT"), { code: "COLLECTION_RULE_NOT_CONFIRMED" });
});
test("SUBMIT拒初始报备/通知错配，QUERY配置更新不改原号金额方法", () => {
  const input = modelProfile(), original = binding(input), profile = bindJoinpayCollectionProfile(input);
  for (const patch of [{ tradeMerchantNo: "MODEL_OTHER_TRADE" }, { notifyUrl: "https://example.invalid/other" }]) {
    assert.throws(() => produceJoinpayCollectionRequest(profile, "SUBMIT", { ...original, ...patch }, KEY), { code: "COLLECTION_PERSISTED_BINDING_MISMATCH" });
    const query = produceJoinpayCollectionRequest(profile, "QUERY", { ...original, ...patch }, KEY); assert.equal(new URLSearchParams(query.encodedBody).get("p2_OrderNo"), ORDER);
  }
});

test("无key创建校验与produce共用全部字段规则，禁止持久化不可发送的新请求", () => {
  const input = modelProfile(), profile = bindJoinpayCollectionProfile(input), original = binding(input);
  assert.doesNotThrow(() => assertCollectionRequestBinding(profile, "SUBMIT", original));
  for (const patch of [{ productName: "x".repeat(31) }, { notifyUrl: "https://example.invalid/wrong" }, { tradeMerchantNo: "wrong" },
    { originalOrderNo: "bad-order" }, { amountCents: "1.5" }, { productName: "\ud800" }, { productName: " padded " }]) {
    let first: unknown, second: unknown;
    try { assertCollectionRequestBinding(profile, "SUBMIT", { ...original, ...patch }); } catch (error) { first = error; }
    try { produceJoinpayCollectionRequest(profile, "SUBMIT", { ...original, ...patch }, KEY); } catch (error) { second = error; }
    assert.ok(first); assert.equal((first as { code: string }).code, (second as { code: string }).code);
  }
  // 仍沿用既有code-point上限：30个补充平面字符有效，31个拒绝，不暗改旧协议。
  assert.doesNotThrow(() => assertCollectionRequestBinding(profile, "SUBMIT", { ...original, productName: "😀".repeat(30) }));
  assert.throws(() => assertCollectionRequestBinding(profile, "SUBMIT", { ...original, productName: "😀".repeat(31) }), { code: "PROTOCOL_FIELD_TOO_LONG" });
});

test("本次profile证据不持久未使用操作的未知属性或秘密，使用该操作时仍拒绝", () => {
  const input = modelProfile();
  Object.assign(input.operations.QUERY!, { merchantKey: "SYNTHETIC_INACTIVE_SECRET" });
  const profile = bindJoinpayCollectionProfile(input), canonical = readCollectionProfileEvidence(profile, "SUBMIT");
  assert.equal(canonical.includes("SYNTHETIC_INACTIVE_SECRET"), false);
  assert.deepEqual(Object.keys(JSON.parse(canonical).operations), ["SUBMIT"]);
  assert.throws(() => readCollectionProfileEvidence(profile, "QUERY"), { code: "COLLECTION_PROFILE_INVALID" });
});
test("wire商户号拒绝数值隐式转字符串", () => {
  assert.throws(() => bindJoinpayCollectionProfile({ ...modelProfile(), wireMerchantNo: 888000000000001 } as unknown as CollectionServerProfile), { code: "COLLECTION_PROFILE_INVALID" });
});
