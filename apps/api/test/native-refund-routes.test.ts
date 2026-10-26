// 离线路由测试；Admin认证与PG分别有专项，此处不启动服务、不连数据库。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { AuthSecurityOptions } from "../src/auth/auth-security";
import * as authSecurity from "../src/auth/auth-security";
import * as command from "../src/order/native-refund-command";
import { SecurityApiError } from "../src/auth/security-core";
import { handleAdminNativeRefundRoute } from "../src/order/native-refund-routes";
import type { SupplyNodeRequest } from "../src/supply/supply-util";
import type { SupplyResponse } from "../src/supply/supply-routes";

const ADMIN = "https://admin.example.invalid", API = "https://api.example.invalid", USER = "https://user.example.invalid";
function fixture(t: any) {
  const s = { status: 0, result: null as any, calls: [] as string[], reads: 0, writes: 0, writeInput: null as any };
  t.mock.method(authSecurity, "readAdminContext", async () => { s.calls.push("admin-session"); return { userId: "admin_1", sessionId: "admin_session" }; });
  t.mock.method(command, "readAdminNativeRefunds", async (_p: unknown, input: any) => { s.reads++; s.calls.push("read:" + input.orderId); return { contractVersion: "admin-native-refunds.v1", orderId: input.orderId, items: [] }; });
  t.mock.method(command, "requestAdminNativeRefund", async (_p: unknown, _e: unknown, input: any) => {
    s.writes++; s.writeInput = input; s.calls.push("write:" + input.orderId);
    return { contractVersion: "admin-native-refund.v1", replayed: false, intentId: "refund_1", refundOrderNo: "RF" + "a".repeat(28),
      amountCents: input.amountCents, currency: "CNY", state: "READY", budgetDisposition: "ALLOCATED",
      responsibility: { postingId: "posting_1", frozenCents: "5000", dueAt: "2026-10-25T00:00:00+00:00" },
      channel: { result: "NOT_SUBMITTED", bankArrival: "UNKNOWN" } };
  });
  const response = { headersSent: false, setHeader() { return this; }, status(code: number) { s.status = code; return this; }, json(v: unknown) { s.result = v; return this; } } as unknown as SupplyResponse;
  const security = { pool: {} as never, adminOrigin: ADMIN, apiOrigin: API, userOrigin: USER } as unknown as AuthSecurityOptions;
  const invoke = (patch: Partial<SupplyNodeRequest> = {}, refund: boolean | { initialProfile: unknown } = true, prefix = "/api/v1/admin/orders") =>
    handleAdminNativeRefundRoute({ method: "POST", originalUrl: prefix + "/order_1/refunds", headers: { origin: ADMIN, "idempotency-key": "refund_key_1" },
      body: { amountCents: "1200", reason: "部分退款" }, ...patch } as SupplyNodeRequest, response, security, prefix as never,
      { pool: {} as never, ...(refund === true ? { refund: { admission: {} as never, initialProfile: {} as never } } : refund === false ? {} : { refund: { admission: {} as never, ...refund } }) } as never);
  return { s, invoke, response, security };
}

test("Admin退款路由只处理本订单refunds路径，其他路径交后续中间件", async t => {
  const f = fixture(t);
  assert.equal(await f.invoke({ originalUrl: "/api/v1/admin/orders/order_1/other" }), false);
  assert.equal(f.s.calls.length, 0);
});

test("GET可读已有退款；关闭装配后POST仍进入原键恢复，首次准入由命令核查", async t => {
  const f = fixture(t);
  await f.invoke({ method: "GET", body: {} }); assert.equal(f.s.status, 200); assert.equal(f.s.reads, 1);
  await f.invoke({ method: "GET", body: {} }, true, "/api/bff/admin/orders"); assert.equal(f.s.status, 200); assert.equal(f.s.reads, 2);
  t.mock.method(command, "requestAdminNativeRefund", async (_p: unknown, execution: any) => {
    assert.deepEqual(execution, {});
    return { replayed: true, intentId: "refund_1", channel: { result: "UNKNOWN", bankArrival: "UNKNOWN" } };
  });
  await f.invoke({}, false); assert.equal(f.s.status, 200); assert.equal(f.s.result.replayed, true);
  t.mock.method(command, "requestAdminNativeRefund", async () => { throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "New refund unavailable"); });
  await f.invoke({}, false); assert.equal(f.s.status, 503); assert.equal(f.s.result.error.code, "EVIDENCE_UNAVAILABLE");
});

test("POST Origin、字段、幂等键先拒绝；成功回执不称渠道已提交", async t => {
  const f = fixture(t);
  await f.invoke({ headers: { origin: "https://other.invalid" } }); assert.equal(f.s.status, 403);
  await f.invoke({ body: { amountCents: "1200", unexpected: "x" } }); assert.equal(f.s.status, 400);
  await f.invoke({ headers: { origin: ADMIN } }); assert.equal(f.s.status, 400);
  assert.equal(f.s.writes, 0);
  await f.invoke();
  assert.equal(f.s.status, 200); assert.equal(f.s.writes, 1); assert.equal(f.s.writeInput.idempotencyKey, "refund_key_1");
  assert.equal(f.s.writeInput.reason, "部分退款"); assert.equal(f.s.result.channel.result, "NOT_SUBMITTED");
  assert.equal(f.s.result.channel.bankArrival, "UNKNOWN"); assert.equal(f.s.result.payment, undefined);
  assert(f.s.calls.indexOf("admin-session") === 0);
});
