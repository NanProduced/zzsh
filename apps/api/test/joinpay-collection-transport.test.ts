// SYNTHETIC_OFFICIAL_CONFIGURATION_MODEL：所有fetch都是无网络替身；正式配置/KAT/商户API均NOT_RUN。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { JOINPAY_SIGNATURE_ORDER, buildJoinpayQueryRequest } from "../src/order/joinpay-protocol";
import { bindJoinpayCollectionProfile, produceJoinpayCollectionRequest, COLLECTION_REQUIRED_RULES,
  type CollectionServerProfile, type CollectionOperation, type CollectionOutboundRequest } from "../src/order/joinpay-collection-profile";
import { exchangeJoinpayCollection, JOINPAY_COLLECTION_TRANSPORT_LIMITS } from "../src/order/joinpay-collection-transport";
const KEY = "SYNTHETIC_KEY_NOT_REAL_0001";
function modelRequest(mode: "OFFICIAL" | "SYNTHETIC" = "OFFICIAL", operation: CollectionOperation = "SUBMIT"): CollectionOutboundRequest {
  const source = mode === "OFFICIAL" ? "JOINPAY_OFFICIAL" as const : "SYNTHETIC" as const;
  const receipt = { source, reference: "SYNTHETIC_OFFICIAL_CONFIGURATION_MODEL_NOT_REAL", sha256: "2".repeat(64) };
  const vector = (order: readonly string[]) => { const values = Object.fromEntries(order.map((name, i) => [name, "SYNTHETIC_" + i]));
    return { ...receipt, values, vectorKey: KEY, expectedHmac: createHash("md5").update(order.map(name => values[name]).join("") + KEY).digest("hex") }; };
  const input: CollectionServerProfile = { profileId: mode === "OFFICIAL" ? "model_profile" : "SYNTHETIC_profile", merchantIdentityId: "synthetic_merchant", wireMerchantNo: "888000000000001",
    tradeMerchantNo: "SYNTHETIC_TRADE", notifyUrl: "https://example.invalid/model-notify", purpose: "COLLECTION", evidenceMode: mode,
    operations: Object.fromEntries((["SUBMIT", "QUERY"] as const).map(op => [op, { keyVersionRef: "model_key", rules: Object.fromEntries(COLLECTION_REQUIRED_RULES[op].map(rule => [rule, { ...receipt }])),
      requestKnownAnswer: vector(op === "SUBMIT" ? JOINPAY_SIGNATURE_ORDER.uniPayRequest : JOINPAY_SIGNATURE_ORDER.queryOrderRequest),
      responseKnownAnswer: vector(op === "SUBMIT" ? JOINPAY_SIGNATURE_ORDER.uniPaySyncResponse : JOINPAY_SIGNATURE_ORDER.queryOrderResponse) }])) };
  return produceJoinpayCollectionRequest(bindJoinpayCollectionProfile(input), operation, { requestId: "model_request", originalOrderNo: "ZZ_MODEL_ORDER", amountCents: "12345", method: "ALIPAY_NATIVE",
    wireMerchantNo: input.wireMerchantNo, merchantIdentityId: input.merchantIdentityId, tradeMerchantNo: input.tradeMerchantNo, notifyUrl: input.notifyUrl,
    productName: "虚构 + %26", profileId: input.profileId, keyVersionRef: "model_key" }, KEY);
}
test("固定8秒/64KiB；只一次POST、官方固定URL、精确持久原件、禁止重定向/凭据", async () => {
  assert.deepEqual(JOINPAY_COLLECTION_TRANSPORT_LIMITS, { timeoutMilliseconds: 8000, maximumBodyBytes: 65536 });
  for (const operation of ["SUBMIT", "QUERY"] as const) {
    const request = modelRequest("OFFICIAL", operation); let calls = 0;
    const fake: typeof fetch = async (url, init) => { calls++; assert.equal(url, operation === "SUBMIT" ? "https://trade.joinpay.com/tradeRt/uniPay" : "https://trade.joinpay.com/tradeRt/queryOrder");
      assert.equal(init?.method, "POST"); assert.equal(init?.body, request.encodedBody); assert.equal(init?.redirect, "error"); assert.equal(init?.credentials, "omit"); assert.equal(init?.referrerPolicy, "no-referrer");
      assert.equal(new Headers(init?.headers).get("content-type"), "application/x-www-form-urlencoded; charset=UTF-8"); assert.ok(init?.signal instanceof AbortSignal);
      return new Response(new Uint8Array([123, 125]), { status: 200 }); };
    const result = await exchangeJoinpayCollection(request, { fetch: fake }); assert.equal(result.kind, "RESPONSE"); assert.equal(result.requestSha256, request.requestSha256); assert.equal(calls, 1);
    if (result.kind === "RESPONSE") assert.deepEqual([...result.body], [123, 125]);
  }
});
test("旧synthetic form、复制请求和所有SYNTHETIC profile，即使注入fetch也永不发出", async () => {
  let calls = 0; const fake: typeof fetch = async () => { calls++; throw Error("SHOULD_NOT_RUN"); };
  const request = modelRequest(), synthetic = modelRequest("SYNTHETIC"), old = buildJoinpayQueryRequest({ merchantNo: "888000000000001", orderNo: "ZZ_MODEL_ORDER" }, KEY);
  for (const forged of [{ ...request }, old, JSON.parse(JSON.stringify(request))]) await assert.rejects(exchangeJoinpayCollection(forged as never, { fetch: fake }), { code: "COLLECTION_OUTBOUND_NOT_BOUND" });
  await assert.rejects(exchangeJoinpayCollection(synthetic, { fetch: fake }), { code: "COLLECTION_SYNTHETIC_TRANSPORT_FORBIDDEN" });
  await assert.rejects(exchangeJoinpayCollection(synthetic), { code: "COLLECTION_SYNTHETIC_TRANSPORT_FORBIDDEN" }); assert.equal(calls, 0);
});
test("声明超长时取消body，未知长度则逐块硬限制，不能先取完整body再判断", async () => {
  const request = modelRequest(); let cancelled = 0, reads = 0;
  const declared: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({ cancel() { cancelled++; } }), { headers: { "content-length": "65537" } });
  const first = await exchangeJoinpayCollection(request, { fetch: declared }); assert.equal(first.kind, "UNKNOWN"); if (first.kind === "UNKNOWN") assert.equal(first.reason, "BODY_TOO_LARGE"); assert.equal(cancelled, 1);
  const chunks: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({ pull(controller) { reads++; controller.enqueue(new Uint8Array(32769)); }, cancel() { cancelled++; } }));
  const second = await exchangeJoinpayCollection(request, { fetch: chunks }); assert.equal(second.kind, "UNKNOWN"); if (second.kind === "UNKNOWN") assert.equal(second.reason, "BODY_TOO_LARGE");
  assert.equal(second.body?.length, 65536); assert.equal(second.receivedBytes, 65538); assert.equal(second.responseComplete, false); assert.equal(cancelled, 2); assert.ok(reads < 5);
});
test("恰好64KiB完整流可返回，按复制字节保存", async () => {
  const expected = new Uint8Array(65536).fill(7), request = modelRequest();
  const fake: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(expected); controller.close(); } }));
  const result = await exchangeJoinpayCollection(request, { fetch: fake }); assert.equal(result.kind, "RESPONSE");
  if (result.kind === "RESPONSE") { assert.equal(result.body.length, 65536); expected.fill(8); assert.equal(result.body[0], 7); }
});
test("HTTP非200也只读有界完整原件，完整标记不能代表付款成功", async () => {
  let calls = 0; const fake: typeof fetch = async () => { calls++; return new Response("SYNTHETIC_PROVIDER_ERROR", { status: 503 }); };
  const result = await exchangeJoinpayCollection(modelRequest(), { fetch: fake }); assert.equal(result.kind, "UNKNOWN");
  if (result.kind === "UNKNOWN" && result.reason === "HTTP_STATUS") { assert.equal(result.status, 503); assert.equal(result.responseComplete, true); assert.equal(new TextDecoder().decode(result.body), "SYNTHETIC_PROVIDER_ERROR"); }
  else assert.fail("expected complete HTTP_STATUS body"); assert.equal(calls, 1);
});
test("流读取中断保留有界前缀并标不完整，不泄露错误描述/钥且不重试", async () => {
  let calls = 0; const fake: typeof fetch = async () => { calls++; let count = 0; return new Response(new ReadableStream<Uint8Array>({ pull(controller) {
    if (count++ === 0) controller.enqueue(new Uint8Array([1, 2])); else controller.error(Error(KEY + " private path")); } })); };
  const result = await exchangeJoinpayCollection(modelRequest(), { fetch: fake }); assert.equal(result.kind, "UNKNOWN");
  if (result.kind === "UNKNOWN") assert.equal(result.reason, "NETWORK_ERROR"); assert.equal(result.body?.length, 2); assert.equal(result.receivedBytes, 2); assert.equal(result.responseComplete, false); assert.equal(JSON.stringify(result).includes(KEY), false); assert.equal(calls, 1);
});
test("fetch失败仅固定NETWORK_ERROR，不将外部message/stack/URL带回", async () => {
  let calls = 0; const fake: typeof fetch = async () => { calls++; throw Error(KEY + " https://private.invalid/secret"); };
  const result = await exchangeJoinpayCollection(modelRequest(), { fetch: fake }); assert.deepEqual(result, { kind: "UNKNOWN", reason: "NETWORK_ERROR", responseComplete: false, receivedBytes: 0, requestSha256: modelRequest().requestSha256 }); assert.equal(calls, 1);
});
test("预先取消不调用fetch；取消覆盖等待body并实际取消自有reader", async () => {
  const prior = new AbortController(); prior.abort(); let calls = 0;
  const never: typeof fetch = async () => { calls++; return new Promise<Response>(() => {}); };
  const before = await exchangeJoinpayCollection(modelRequest(), { fetch: never, signal: prior.signal }); assert.equal(before.kind, "UNKNOWN"); if (before.kind === "UNKNOWN") assert.equal(before.reason, "ABORTED"); assert.equal(calls, 0);
  const active = new AbortController(); let cancelled = false;
  const stream: typeof fetch = async () => new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } }));
  const pending = exchangeJoinpayCollection(modelRequest(), { fetch: stream, signal: active.signal }); await Promise.resolve(); await Promise.resolve(); active.abort();
  const result = await pending; assert.equal(result.kind, "UNKNOWN"); if (result.kind === "UNKNOWN") assert.equal(result.reason, "ABORTED"); assert.ok((result.body?.length ?? 0) <= 65536); assert.equal(result.responseComplete, false); assert.equal(cancelled, true);
});
test("8秒总截止包括不响应fetch与流读取，不自动重试", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let calls = 0;
  for (const stage of ["FETCH", "BODY"] as const) {
    let cancelled = false;
    const fake: typeof fetch = async () => { calls++; return stage === "FETCH" ? new Promise<Response>(() => {})
      : new Response(new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } })); };
    const pending = exchangeJoinpayCollection(modelRequest(), { fetch: fake });
    for (let i = 0; i < 4; i++) await Promise.resolve();
    t.mock.timers.tick(8000); const result = await pending;
    assert.equal(result.kind, "UNKNOWN"); if (result.kind === "UNKNOWN") assert.equal(result.reason, "TIMEOUT"); assert.equal(result.responseComplete, false);
    if (stage === "FETCH") assert.equal("body" in result, false); else { assert.equal(result.body?.length, 1); assert.equal(cancelled, true); }
  }
  assert.equal(calls, 2);
});

test("fetch返回已超过总截止，即使body为空且timer未调度也只记录TIMEOUT", async t => {
  let now = 0, calls = 0; t.mock.method(performance, "now", () => now);
  const result = await exchangeJoinpayCollection(modelRequest(), { fetch: async () => { calls++; now = 9001; return new Response(null, { status: 200 }); } });
  assert.equal(calls, 1); assert.equal(result.kind, "UNKNOWN");
  if (result.kind === "UNKNOWN") assert.equal(result.reason, "TIMEOUT");
  assert.equal(result.responseComplete, false);
});
test("逐块保留Buffer副本，下一次read复用底层内存不改前一块原件", async () => {
  const reused = Buffer.from("ab"); let reads = 0;
  const fake = (async () => ({ status: 200, headers: new Headers(), body: { getReader: () => ({
    read: async () => { if (reads++ === 0) return { done: false, value: reused };
      if (reads === 2) { reused.set(Buffer.from("cd")); return { done: false, value: Buffer.from("e") }; }
      return { done: true }; }, cancel: async () => {}
  }) } }) as Response) as typeof fetch;
  const result = await exchangeJoinpayCollection(modelRequest(), { fetch: fake });
  assert.equal(result.kind, "RESPONSE"); assert.equal(Buffer.from(result.body!).toString(), "abe");
});
