// Synthetic domain test: lock order and outcomes are asserted; real PostgreSQL concurrency is tested separately.
import assert from "node:assert/strict";
import test from "node:test";
import * as directory from "../src/auth/admin-directory";
import * as adminSession from "../src/auth/admin-auth-session";
import * as security from "../src/auth/security-core";
import * as manualClose from "../src/order/manual-close";
import * as order from "../src/order/order";
import * as auth from "../src/auth/auth-security";
import * as supplyRoutes from "../src/supply/supply-routes";
import * as domain from "../src/order/support-unpaid-cancel";
import { supportCancelUnpaidOrder } from "../src/order/support-unpaid-cancel";
import { handleSupportUnpaidCancelRoute } from "../src/order/support-unpaid-cancel-routes";

const original = { id: "order_1", accountId: "account_1", renterUserId: "renter_1", ownerUserId: "owner_1", gameId: "game_1",
  status: "PENDING_PAYMENT", revision: "1", cancelReason: null, hasPayment: false, hasRequest: false, hasTransaction: false, hasGroup: false };
const actor = { userId: "support_1", sessionId: "session_1" };
const input = { orderId: "order_1", expectedOrderRevision: "1", reason: "客服核对后取消", requestId: "req_1" };

function fixture(t: any, final: Partial<typeof original> = {}) {
  const events: string[] = [], audits: any[] = [];
  let reads = 0;
  const client = { async query(sql: string) {
    if (sql === "SHOW transaction_isolation") { events.push("isolation"); return { rows: [{ transaction_isolation: "read committed" }], rowCount: 1 }; }
    if (sql.includes("FROM pg_constraint")) { events.push("schema"); return { rows: [{ count: 2 }], rowCount: 1 }; }
    if (sql.startsWith("SELECT o.id,o.account_id")) { events.push("facts"); return { rows: [{ ...original, ...(reads++ ? final : {}) }], rowCount: 1 }; }
    if (sql.includes("zzsh_supply.game")) { events.push("game"); return { rows: [{ id: "game_1" }], rowCount: 1 }; }
    if (sql.includes("zzsh_supply.rental_account")) { events.push("account"); return { rows: [{ id: "account_1" }], rowCount: 1 }; }
    if (sql.startsWith("SELECT id FROM zzsh_order.rental_order")) { events.push("order"); return { rows: [{ id: "order_1" }], rowCount: 1 }; }
    if (sql.startsWith("UPDATE zzsh_order.rental_order")) { events.push("update"); assert.match(sql, /cancel_reason='SUPPORT_UNPAID'/); return { rows: [], rowCount: 1 }; }
    throw Error(`Unexpected SQL: ${sql}`);
  } } as any;
  t.mock.method(directory, "lockActor", async () => { events.push("admin"); return {} as any; });
  t.mock.method(adminSession, "assertAdminCommandAuthorizedInTransaction", async () => { events.push("session"); return {} as any; });
  t.mock.method(manualClose, "assertSupportOrderAccess", async () => { events.push("access"); });
  t.mock.method(order, "lockOrderPartiesInOrder", async () => { events.push("parties"); });
  t.mock.method(security, "recordAudit", async (_client: unknown, audit: any) => { events.push("audit"); audits.push(audit); });
  return { client, events, audits };
}

test("客服取消无付款请求的待付单：锁后重新查付款证据并保留真实操作者", async t => {
  const f = fixture(t), result = await supportCancelUnpaidOrder(f.client, actor, input);
  assert.equal(result.status, 200);
  assert.equal(result.body.cancelReason, "SUPPORT_UNPAID");
  assert.equal(result.body.channelClosed, false);
  assert.deepEqual(f.events, ["isolation", "admin", "session", "access", "schema", "facts", "parties", "game", "account", "order", "facts", "update", "audit"]);
  assert.equal(f.audits[0].actorId, actor.userId);
  assert.equal(f.audits[0].reason, input.reason);
});

test("等待锁期间产生付款请求或确认、版本变化与已付款都不会被取消", async t => {
  for (const patch of [{ hasRequest: true }, { hasPayment: true }, { hasTransaction: true }, { hasGroup: true }, { revision: "2" }, { status: "PAID" }]) {
    const f = fixture(t, patch), result = await supportCancelUnpaidOrder(f.client, actor, input);
    assert.equal(result.status, 409);
    assert.equal(f.events.includes("update"), false);
    assert.equal(f.events.includes("audit"), false);
  }
});

test("无法在锁后获得新快照的隔离级别拒绝取消", async t => {
  const f = fixture(t), query = f.client.query;
  f.client.query = async (sql: string) => sql === "SHOW transaction_isolation" ? { rows: [{ transaction_isolation: "repeatable read" }] } : query(sql);
  await assert.rejects(supportCancelUnpaidOrder(f.client, actor, input), (error: any) => error.status === 503);
  assert.equal(f.events.includes("update"), false);
});

test("待付款取消约束尚未安装时不显示成功或修改订单", async t => {
  const f = fixture(t), query = f.client.query;
  f.client.query = async (sql: string) => sql.includes("FROM pg_constraint") ? { rows: [{ count: 0 }] } : query(sql);
  await assert.rejects(supportCancelUnpaidOrder(f.client, actor, input), (error: any) => error.status === 503);
  assert.equal(f.events.includes("update"), false);
});

test("权限不足或管理员必须改密时不进入取消流程", async t => {
  const f = fixture(t);
  t.mock.method(directory, "lockActor", async () => ({ passwordChangeRequired: true }) as any);
  await assert.rejects(supportCancelUnpaidOrder(f.client, actor, input), (error: any) => error.status === 403);
  t.mock.method(directory, "lockActor", async () => ({ passwordChangeRequired: false }) as any);
  t.mock.method(manualClose, "assertSupportOrderAccess", async () => { throw new security.SecurityApiError(403, "FORBIDDEN", "Permission required"); });
  await assert.rejects(supportCancelUnpaidOrder(f.client, actor, input), (error: any) => error.status === 403);
  assert.equal(f.events.includes("update"), false);
});

test("客服接口校验输入、权限与原幂等键；提交结果不确定时不伪装成功", async t => {
  let code = 0, result: any, unknown = false, frozen: any;
  const response = { headersSent: false, setHeader() { return this; }, status(n: number) { code = n; return this; }, json(body: any) { result = body; return this; } } as any;
  const request = { method: "POST", headers: { origin: "https://admin.invalid", "idempotency-key": "key_1" }, body: input } as any;
  t.mock.method(auth, "readAdminContext", async () => actor as any);
  t.mock.method(supplyRoutes, "requireOrigin", () => true);
  t.mock.method(manualClose, "assertSupportOrderAccess", async () => {});
  t.mock.method(domain, "supportCancelUnpaidOrder", async () => ({ status: 200, body: { outcome: "CANCELLED" } }) as any);
  t.mock.method(supplyRoutes, "runIdempotentWrite", async (_options: any, _request: any, res: any, _requestId: any, scope: any, _actor: any, body: any, authorize: any, action: any) => {
    assert.equal(scope.operation, "order.support_cancel_unpaid"); frozen = body; await authorize({}); const reply = await action({});
    if (unknown) throw Error("synthetic unknown commit"); res.status(reply.status).json(reply.body);
  });
  request.body = { expectedOrderRevision: "1", reason: input.reason };
  await handleSupportUnpaidCancelRoute(request, response, {} as any, "order_1", new URLSearchParams(), "POST");
  assert.equal(code, 200); assert.deepEqual(frozen, request.body);
  request.body = { ...request.body, amountCents: "1" };
  await assert.rejects(handleSupportUnpaidCancelRoute(request, response, {} as any, "order_1", new URLSearchParams(), "POST"), (e: any) => e.status === 400);
  request.body = { expectedOrderRevision: "9999999999999999999", reason: input.reason };
  await assert.rejects(handleSupportUnpaidCancelRoute(request, response, {} as any, "order_1", new URLSearchParams(), "POST"), (e: any) => e.status === 400);
  request.body = frozen; unknown = true;
  await handleSupportUnpaidCancelRoute(request, response, {} as any, "order_1", new URLSearchParams(), "POST");
  assert.equal(code, 202); assert.equal(result.outcome, "UNKNOWN"); assert.equal(result.originalKeyRequired, true);
});
