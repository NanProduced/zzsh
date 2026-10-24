import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { bindJoinpayAccountProfile, describeJoinpayAccountProfile, queryJoinpayAccount, readJoinpayAccountObservation,
  JOINPAY_ACCOUNT_SIGNATURE_ORDER, type JoinpayAccountOperation, type JoinpayAccountServerProfile } from "../src/finance/joinpay-account";

// 全部是SYNTHETIC_OFFICIAL_CONFIGURATION_MODEL；未取得官方余额KAT或商户授权。
const KEY = "fictional_balance_key", USER = "999900000000001";
const md5 = (s: string) => createHash("md5").update(s).digest("hex"), sha = (s: string) => createHash("sha256").update(s).digest("hex");
function response(op: JoinpayAccountOperation, changes: Record<string, string> = {}, encoding: "OBJECT" | "JSON_STRING" = "OBJECT") {
  const v: Record<string, string> = { statusCode: "2001", message: "查询成功", userNo: USER, userName: "虚构商户", currency: "201",
    useAbleSettAmount: "90071992547409.91", availableSettAmountFrozen: "0.00", useAbleAdvanceAmount: "3.01", currentAdvanceAmount: "0.00", usedAdvanceAmount: "0.00", advanceFrozenAmount: "1.00", errorCode: "", errorDesc: "", ...changes };
  const order = JOINPAY_ACCOUNT_SIGNATURE_ORDER[op], signed = md5(order.map(k => v[k]).join("") + KEY);
  const data = "{" + order.slice(2).map(k => JSON.stringify(k) + ":" + (["currency", "useAbleSettAmount", "availableSettAmountFrozen", "useAbleAdvanceAmount", "currentAdvanceAmount", "usedAdvanceAmount", "advanceFrozenAmount"].includes(k) ? v[k] : JSON.stringify(v[k]))).join(",") + ',"hmac":"' + signed + '"}';
  return '{"statusCode":' + v.statusCode + ',"message":' + JSON.stringify(v.message) + ',"data":' + (encoding === "OBJECT" ? data : JSON.stringify(data)) + "}";
}
function config(op: JoinpayAccountOperation = "AVAILABLE", encoding: "OBJECT" | "JSON_STRING" = "OBJECT"): JoinpayAccountServerProfile {
  const raw = response(op, {}, encoding);
  return { purpose: "MERCHANT_READ", resourceDatabase: "synthetic_balance_test", resourceRuntimeUser: "synthetic_balance_r", operation: op, profileId: "SYNTHETIC_OFFICIAL_CONFIGURATION_MODEL", merchantIdentityId: "synthetic_merchant", userNo: USER, keyVersionRef: "synthetic_key_v1",
    reviewRef: "SYNTHETIC_BACKEND_REVIEW_NOT_OFFICIAL", reviewSha256: "a".repeat(64), permission: "REVIEWED_MERCHANT_BALANCE_READ",
    rules: { dataEncoding: encoding, statusCodeToken: "NUMBER", amountToken: "NUMBER", currencyToken: "NUMBER", numericSigning: "RAW_JSON_TOKEN", optionalSigning: "ABSENT_EMPTY_NULL_EQUIVALENT", unknownFields: "REJECT", amount: { unit: "UNKNOWN" } },
    knownAnswer: { reference: "SYNTHETIC_VECTOR_NOT_OFFICIAL", sha256: sha(raw), vectorKey: KEY, requestHmac: md5(USER + KEY), responseBody: raw } };
}
const fake = (raw: string | Uint8Array, status = 200): typeof fetch => async () => new Response(raw as BodyInit, { status });
async function inspect(raw: string | Uint8Array, op: JoinpayAccountOperation = "AVAILABLE") {
  return readJoinpayAccountObservation(await queryJoinpayAccount(bindJoinpayAccountProfile(config(op)), { keyFor: () => KEY, fetch: fake(raw) }));
}

test("两种余额独立请求/签名/原数字token，fake证据永为合成", async () => {
  for (const op of ["AVAILABLE", "COLLECTION"] as const) {
    let calls = 0;
    const result = await queryJoinpayAccount(bindJoinpayAccountProfile(config(op)), { keyFor: ref => { assert.equal(ref, "synthetic_key_v1"); return KEY; }, fetch: async (url, init) => {
      calls++; assert.equal(String(url), op === "AVAILABLE" ? "https://www.joinpay.com/payment/pay/accountBalanceQuery" : "https://www.joinpay.com/payment/pay/advanceAccountBalanceResultQuery");
      assert.equal(init?.method, "POST"); assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit");
      assert.deepEqual(JSON.parse(String(init?.body)), { userNo: USER, hmac: md5(USER + KEY) }); return new Response(response(op));
    } });
    const observed = readJoinpayAccountObservation(result); assert.equal(calls, 1); assert.equal(result.decision, "SUCCESS"); assert.equal(result.evidenceLevel, "SYNTHETIC_PROTOCOL");
    assert.equal(observed.rawSha256, sha(response(op))); assert.equal(observed.responseComplete, true);
    for (const value of Object.values(observed.inspection.amounts!)) { assert.equal(value.cents, null); assert.equal(value.unitKnowledge, "UNKNOWN"); }
    assert.equal(observed.profile.rulesSha256.length, 64);
  }
});
test("单一data配置不尝试另一形态；重复/错层/额外嵌套/数组/BOM/UTF8拒绝", async () => {
  const raw = response("AVAILABLE");
  for (const bad of [response("AVAILABLE", {}, "JSON_STRING"), raw.replace('"data":', '"data":{},"data":'), raw.replace('"userNo":', '"userNo":"dup","userNo":'),
    raw.replace('"userName":"虚构商户"', '"userName":{}'), raw.replace('"userName":"虚构商户"', '"userName":[]'), "\uFEFF" + raw,
    raw.replace('"userName":"虚构商户"', '"userName":"\\ud800"'), new Uint8Array([255]), raw.replace('"data":', '"other":')]) {
    assert.equal((await inspect(bad)).inspection.decision, "UNKNOWN");
  }
  const configured = bindJoinpayAccountProfile(config("AVAILABLE", "JSON_STRING"));
  assert.equal((await queryJoinpayAccount(configured, { keyFor: () => KEY, fetch: fake(response("AVAILABLE", {}, "JSON_STRING")) })).decision, "SUCCESS");
});
test("hmac/商户/币种/字段/未知code分开失败，签名不重渲染数字", async () => {
  const raw = response("AVAILABLE");
  assert.equal((await inspect(raw.replace("90071992547409.91", "90071992547409.90"))).inspection.signature, "MISMATCH");
  assert.equal((await inspect(response("AVAILABLE", { userNo: "999900000000002" }))).inspection.binding, "MISMATCH");
  assert.equal((await inspect(response("AVAILABLE", { currency: "202" }))).inspection.binding, "MISMATCH");
  assert.equal((await inspect(raw.replace('"currency":201', '"currency":"201"'))).inspection.schema, "INVALID");
  assert.equal((await inspect(raw.replace('"statusCode":2001', '"statusCode":"2001"'))).inspection.schema, "INVALID");
  assert.equal((await inspect(raw.replace('"data":{', '"extra":null,"data":{'))).inspection.schema, "INVALID");
  assert.equal((await inspect(response("AVAILABLE", { statusCode: "9999" }))).inspection.decision, "UNKNOWN");
  assert.equal((await inspect(response("AVAILABLE", { statusCode: "2002", errorCode: "SYNTHETIC_FAILURE" }))).inspection.decision, "SIGNED_PROVIDER_ERROR");
  assert.equal((await inspect(response("AVAILABLE", { useAbleSettAmount: "1e2" }))).inspection.reason, "AMOUNT_RULE_REJECTED");
});
test("明确金额规则才转换BigInt，超scale/范围/负数拒绝", async () => {
  const initial = config(), c: JoinpayAccountServerProfile = { ...initial, rules: { ...initial.rules, amount: { unit: "CNY_YUAN", maximumScale: 2, allowNegative: false, maximumAbsoluteCents: "99999999999999999" } } };
  const p = bindJoinpayAccountProfile(c);
  const run = async (raw: string) => readJoinpayAccountObservation(await queryJoinpayAccount(p, { keyFor: () => KEY, fetch: fake(raw) }));
  assert.equal((await run(response("AVAILABLE"))).inspection.amounts?.useAbleSettAmount?.cents, "9007199254740991");
  for (const value of ["-1.00", "1.001", "999999999999999999999.00"]) assert.equal((await run(response("AVAILABLE", { useAbleSettAmount: value }))).inspection.reason, "AMOUNT_RULE_REJECTED");
});
test("配置KAT/权限/A2/复制对象/getter拒绝，配置原件不可变且异常不泄钥", async () => {
  const c = config(), p = bindJoinpayAccountProfile(c), d = describeJoinpayAccountProfile(p); (c as { userNo: string }).userNo = "111";
  assert.equal(describeJoinpayAccountProfile(p).profileSha256, d.profileSha256);
  assert.throws(() => describeJoinpayAccountProfile({ ...p }), /NOT_BOUND/);
  const synthetic = bindJoinpayAccountProfile({ ...config(), purpose: "SYNTHETIC_PROTOCOL" });
  for (const fetch of [undefined, globalThis.fetch, fake(response("AVAILABLE"))]) await assert.rejects(queryJoinpayAccount(synthetic, { keyFor: () => { throw Error("must not read key"); }, fetch }), /SYNTHETIC_NETWORK_FORBIDDEN/);
  for (const bad of [{ ...config(), userNo: "888100000002340" }, { ...config(), permission: "NOT_OBTAINED" }, { ...config(), knownAnswer: { ...config().knownAnswer, requestHmac: "0".repeat(32) } }, Object.defineProperty({ ...config() }, "profileId", { get() { return "bad"; } })]) assert.throws(() => bindJoinpayAccountProfile(bad as JoinpayAccountServerProfile));
  const replacementKat = response("AVAILABLE", { userName: "\ufffd" });
  assert.throws(() => bindJoinpayAccountProfile({ ...config(), knownAnswer: { ...config().knownAnswer,
    sha256: sha(replacementKat), responseBody: replacementKat.replace("\ufffd", "\ud800") } }));
  await assert.rejects(queryJoinpayAccount(p, { keyFor: () => { throw Error(KEY); }, fetch: fake(response("AVAILABLE")) }), e => String(e) === "Error: ACCOUNT_KEY_UNAVAILABLE");
});
test("HTTP错误完整raw保留；大响应前缀有界，网络/取消不补空完整", async () => {
  const signed = response("AVAILABLE"); const http = readJoinpayAccountObservation(await queryJoinpayAccount(bindJoinpayAccountProfile(config()), { keyFor: () => KEY, fetch: fake(signed, 503) }));
  assert.equal(http.transportFailure, "HTTP_STATUS"); assert.equal(http.responseComplete, true); assert.equal(http.rawSha256, sha(signed)); assert.equal(http.inspection.signature, "NOT_CHECKED");
  const huge = await inspect("x".repeat(70000)); assert.equal(huge.transportFailure, "BODY_TOO_LARGE"); assert.equal(huge.body?.length, 65536); assert.equal(huge.receivedBytes, 70000); assert.equal(huge.responseComplete, false);
  const p = bindJoinpayAccountProfile(config()); let calls = 0;
  const no = readJoinpayAccountObservation(await queryJoinpayAccount(p, { keyFor: () => KEY, fetch: async () => { calls++; throw Error(KEY); } }));
  assert.equal(calls, 1); assert.equal(no.transportFailure, "NETWORK_ERROR"); assert.equal(no.body, null); assert.equal(no.rawSha256, null);
  const controller = new AbortController(); controller.abort();
  const canceled = readJoinpayAccountObservation(await queryJoinpayAccount(p, { keyFor: () => KEY, signal: controller.signal, fetch: async () => { throw Error("must not send"); } }));
  assert.equal(canceled.transportFailure, "ABORTED"); assert.equal(canceled.responseComplete, false);
});
test("timeout即终止，即使fake不处理AbortSignal也不悬挂", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = queryJoinpayAccount(bindJoinpayAccountProfile(config()), { keyFor: () => KEY, fetch: () => new Promise(() => {}) });
  await Promise.resolve(); t.mock.timers.tick(8001);
  assert.equal(readJoinpayAccountObservation(await pending).transportFailure, "TIMEOUT");
});
test("fetch完成已过deadline而timer未调度，也只能UNKNOWN/TIMEOUT", async t => {
  let now = 0, sends = 0; t.mock.method(performance, "now", () => now);
  const result = await queryJoinpayAccount(bindJoinpayAccountProfile(config()), { keyFor: () => KEY, fetch: async () => { sends++; now = 9001; return new Response(response("AVAILABLE")); } });
  assert.equal(sends, 1); const observation = readJoinpayAccountObservation(result);
  assert.equal(result.decision, "UNKNOWN"); assert.equal(observation.transportFailure, "TIMEOUT"); assert.equal(observation.responseComplete, false);
});
test("公开结果不含原件/钥/merchant，读取raw得到副本", async () => {
  const result = await queryJoinpayAccount(bindJoinpayAccountProfile(config()), { keyFor: () => KEY, fetch: fake(response("AVAILABLE")) });
  const text = JSON.stringify(result); for (const secret of [KEY, USER, "虚构商户", "hmac", "raw"]) assert.equal(text.includes(secret), false);
  const a = readJoinpayAccountObservation(result); const before = a.body![0]; a.body![0] = 0;
  assert.equal(readJoinpayAccountObservation(result).body![0], before); assert.throws(() => readJoinpayAccountObservation({ ...result }), /NOT_BOUND/);
});
test("fetch accessor只能读取一次，虚构transport不能因二次取值变真实证据", async () => {
  let reads = 0;
  const deps = { keyFor: () => KEY, get fetch() { reads++; return reads === 1 ? fake(response("AVAILABLE")) : undefined; } };
  const result = await queryJoinpayAccount(bindJoinpayAccountProfile(config()), deps);
  assert.equal(reads, 1); assert.equal(result.decision, "SUCCESS"); assert.equal(result.evidenceLevel, "SYNTHETIC_PROTOCOL");
});
