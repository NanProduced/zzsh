// 离线路由/回执测试；认证与 PG 各自已有测试，此处不启动服务、不连数据库。
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AuthSecurityOptions } from "../src/auth/auth-security";
import * as identity from "../src/auth/user-identity";
import * as order from "../src/order/order";
import * as read from "../src/order/channel-payment-read";
import * as store from "../src/order/channel-payment-store";
import { SecurityApiError } from "../src/auth/security-core";
import { notFound, type SupplyNodeRequest } from "../src/supply/supply-util";
import type { SupplyResponse } from "../src/supply/supply-routes";
import { channelPaymentCommandReceipt, handleChannelPaymentRoute } from "../src/order/channel-payment-routes";

const ORIGIN = "https://user.example.invalid";
const raw: store.PaymentRequestView = { requestId: "payreq_1", orderId: "order_1", channel: "JOINPAY", channelOrderNo: "ZZPAY04_0001",
  amountCents: "125", wireAmountYuan: "1.25", currency: "CNY", method: "ALIPAY_NATIVE", state: "SUBMITTING", existing: false,
  evidenceLevel: "SYNTHETIC_PROTOCOL", createdAt: "2026-10-23T01:00:00.000000Z", updatedAt: "2026-10-23T01:00:00.000000Z" };

function fixture(t: TestContext) {
  const s = { status: 0, result: null as any, headers: {} as Record<string, unknown>, calls: [] as string[], commandCalls: 0,
    available: true, owned: true, active: true, commandError: null as unknown };
  t.mock.method(identity, "readUserContext", async () => {
    s.calls.push("session"); if (!s.active) throw new SecurityApiError(401, "UNAUTHENTICATED", "Expired session");
    return { userId: "renter", sessionId: "session" };
  });
  t.mock.method(order, "assertReplayAuthorization", async () => { s.calls.push("fresh-authorization"); });
  t.mock.method(read, "readChannelPaymentRequest", async (_c: Parameters<typeof read.readChannelPaymentRequest>[0], input: Parameters<typeof read.readChannelPaymentRequest>[1]) => {
    assert.equal(input.actor.userId, "renter"); s.calls.push("scoped-read");
    if (!s.owned) throw notFound();
    return s.available ? { available: true, view: { contractVersion: "order-payment-request.v1", paymentAction: null } as never }
      : { available: false, reason: "SCHEMA_NOT_DEPLOYED" };
  });
  t.mock.method(store, "createPaymentRequest", async (_c: Parameters<typeof store.createPaymentRequest>[0], input: Parameters<typeof store.createPaymentRequest>[1]) => {
    s.commandCalls++; assert.equal(input.actor.userId, "renter"); assert.equal(input.orderId, "order_1");
    assert.equal(input.binding, undefined); assert.equal(input.capability, undefined);
    if (s.commandError) throw s.commandError;
    return { status: 202, body: raw, replayed: true };
  });
  const pool = { connect: async () => ({ release() {}, query: async (sql: string, p: unknown[] = []) => {
    s.calls.push(sql);
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.includes("FROM zzsh_order.rental_order")) return { rows: s.owned && p[1] === "renter" ? [{ id: "order_1", display_no: "ZZPAY04-0001", status: "PAID", paid_at: null }] : [] };
    if (sql.includes("FROM zzsh_order.payment_confirmation")) {
      assert(sql.includes("disposition IN ('APPLIED','REVIEW_REQUIRED')"));
      return { rows: [{ confirmationId: "payment_1", disposition: "APPLIED", reasonCode: null, amountCents: "125", currency: "CNY", acceptedAt: raw.createdAt }] };
    }
    throw Error("Unexpected SQL");
  } }) };
  const response = { headersSent: false, setHeader(k: string, v: unknown) { s.headers[k] = v; return this; },
    status(code: number) { s.status = code; return this; }, json(v: unknown) { s.result = v; return this; } } as unknown as SupplyResponse;
  const security = { pool, userOrigin: ORIGIN } as unknown as AuthSecurityOptions;
  const invoke = async (patch: Partial<SupplyNodeRequest> = {}) => handleChannelPaymentRoute({ method: "POST", originalUrl: "/api/v1/orders/order_1/channel-payment-requests",
    headers: { origin: ORIGIN, "idempotency-key": "key_1" }, body: { method: "ALIPAY_NATIVE" }, ...patch } as SupplyNodeRequest, response, security, "/api/v1/orders");
  return { s, invoke, response, security };
}

test("POST 只映射原存储回执；重放不把当前状态/原号/签名塞进 v1", async t => {
  const f = fixture(t); await f.invoke();
  assert.equal(f.s.status, 202); assert.equal(f.s.result.contractVersion, "order-payment-request.v1");
  assert.equal(f.s.result.replay, false); assert.equal(f.s.result.request.id, "payreq_1");
  assert.deepEqual(f.s.result.request.amount, { cents: "125", currency: "CNY" });
  assert.equal(f.s.result.request.createdAt, raw.createdAt); assert.equal(f.s.result.paymentAction, null);
  assert.equal(f.s.result.channelOrderNo, undefined); assert.equal(f.s.result.hmac, undefined);
  assert.equal(f.s.commandCalls, 1); assert(f.s.calls.indexOf("fresh-authorization") < f.s.calls.indexOf("scoped-read"));
});

test("缺少旧回执元数据明确不可用，不用当前 GET 重新构造成功回执", () => {
  assert.throws(() => channelPaymentCommandReceipt({ ...raw, createdAt: undefined } as never), { code: "EVIDENCE_UNAVAILABLE" });
  assert.throws(() => channelPaymentCommandReceipt({ ...raw, evidenceLevel: "REAL_JOINPAY" }), { code: "EVIDENCE_UNAVAILABLE" });
  assert.equal(channelPaymentCommandReceipt({ ...raw, existing: true }).replay, true);
});

test("Origin、Authorization、会话、对象归属分别拒绝；重复 Origin 不取第一项放行", async t => {
  const f = fixture(t);
  for (const headers of [{ origin: "https://other.invalid" }, { origin: ORIGIN, authorization: "Bearer synthetic" }, { origin: [ORIGIN, "https://other.invalid"] }]) {
    await f.invoke({ headers }); assert.equal(f.s.status, 403);
  }
  assert.equal(f.s.calls.length, 0);
  f.s.active = false; await f.invoke(); assert.equal(f.s.status, 401);
  f.s.active = true; f.s.owned = false; await f.invoke(); assert.equal(f.s.status, 404); assert.equal(f.s.commandCalls, 0);
});

test("路径/方法/query 优先拒绝；无关路由不处理", async t => {
  const f = fixture(t);
  assert.equal(await f.invoke({ originalUrl: "/api/v1/orders/order_1/other" }), false);
  await f.invoke({ originalUrl: "/api/v1/orders/order_1/channel-payment-requests?unexpected=1" }); assert.equal(f.s.status, 404);
  await f.invoke({ method: "DELETE" }); assert.equal(f.s.status, 404);
  assert.equal(f.s.calls.length, 0);
});

test("幂等头先于 body 校验；缺失/非法/重复头全部明确拒绝", async t => {
  const f = fixture(t);
  await f.invoke({ headers: { origin: ORIGIN }, body: {} }); assert.equal(f.s.result.error.code, "MISSING_IDEMPOTENCY_KEY");
  await f.invoke({ headers: { origin: ORIGIN, "idempotency-key": "" } }); assert.equal(f.s.status, 400); assert.equal(f.s.result.error.code, "MISSING_IDEMPOTENCY_KEY");
  for (const value of ["invalid key", ["key_1", "key_2"]]) {
    await f.invoke({ headers: { origin: ORIGIN, "idempotency-key": value } }); assert.equal(f.s.status, 400); assert.equal(f.s.result.error.code, "INVALID_ARGUMENT");
  }
  assert.equal(f.s.commandCalls, 0);
});

test("body 只收 method；不接受客户端金额、订单归属或商户配置", async t => {
  const f = fixture(t);
  for (const body of [{ method: "CARD" }, { method: "ALIPAY_NATIVE", amountCents: "1" }, { method: "ALIPAY_NATIVE", userId: "other" }, { method: "ALIPAY_NATIVE", merchantNo: "other" }]) {
    await f.invoke({ body }); assert.equal(f.s.status, 400);
  }
  assert.equal(f.s.commandCalls, 0);
});

test("未部署：GET 明确不可用，首次 POST 返回能力关闭，不触及缺表或外呼", async t => {
  const f = fixture(t); f.s.available = false;
  await f.invoke(); assert.equal(f.s.status, 503); assert.equal(f.s.result.error.code, "PAYMENT_CHANNEL_NOT_ENABLED");
  assert.equal(f.s.result.error.requestId, f.s.headers["X-Request-Id"]);
  await f.invoke({ method: "GET" }); assert.equal(f.s.status, 503); assert.equal(f.s.result.error.code, "EVIDENCE_UNAVAILABLE");
  assert.equal(f.s.commandCalls, 0);
});

test("领域支付拒绝只按机器原因映射嵌套 error，不匹配文案", async t => {
  const f = fixture(t);
  for (const code of ["PAYMENT_CHANNEL_NOT_ENABLED", "PAYMENT_REQUEST_EXISTS", "ORDER_NOT_PAYABLE"]) {
    f.s.commandError = Object.assign(new SecurityApiError(code === "PAYMENT_CHANNEL_NOT_ENABLED" ? 503 : 409, "CONFLICT", "Domain refusal"), { paymentReason: code });
    await f.invoke(); assert.equal(f.s.result.error.code, code); assert.equal(f.s.result.code, undefined);
  }
});

test("JOINPAY 装配下旧 POST 明确升级要求；旧 GET 维持本地事实形状", async t => {
  const f = fixture(t), url = "/api/v1/orders/order_1/payment-requests";
  await f.invoke({ originalUrl: url }); assert.equal(f.s.status, 409); assert.equal(f.s.result.error.code, "PAYMENT_CLIENT_UPGRADE_REQUIRED");
  await f.invoke({ method: "GET", originalUrl: url }); assert.equal(f.s.status, 200);
  assert.deepEqual(Object.keys(f.s.result), ["order", "payment"]); assert.equal(f.s.result.payment.disposition, "APPLIED");
  assert.equal(f.s.result.paymentAction, undefined); assert.equal(f.s.commandCalls, 0);
  f.s.owned = false; await f.invoke({ originalUrl: url }); assert.equal(f.s.status, 404);
});

test("BFF 同一 handler 返回相同语言无关 v1；普通 GET 不调用命令", async t => {
  const f = fixture(t);
  await handleChannelPaymentRoute({ method: "GET", originalUrl: "/api/bff/user/orders/order_1/channel-payment-requests", headers: { origin: ORIGIN } } as SupplyNodeRequest,
    f.response, f.security, "/api/bff/user/orders");
  assert.equal(f.s.status, 200); assert.equal(f.s.result.contractVersion, "order-payment-request.v1"); assert.equal(f.s.commandCalls, 0);
});
