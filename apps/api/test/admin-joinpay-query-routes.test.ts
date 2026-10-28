// 离线：Admin QUERY-only路由；不连PG、不出网，渠道函数全部mock。
import assert from "node:assert/strict";
import { test } from "node:test";
import * as authSecurity from "../src/auth/auth-security";
import * as command from "../src/order/native-refund-command";
import * as refundAttempt from "../src/order/joinpay-refund-attempt";
import * as collectionAttempt from "../src/order/joinpay-collection-attempt";
import * as payoutAttempt from "../src/finance/joinpay-payout-attempt";
import * as payoutProfile from "../src/finance/joinpay-payout-profile";
import * as adminSession from "../src/auth/admin-auth-session";
import * as adminAuthz from "../src/auth/admin-authorization";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { authorizeAdminWithdrawalQuery } from "../src/order/admin-joinpay-query-routes";
import { SecurityApiError } from "../src/auth/security-core";
import * as securityCore from "../src/auth/security-core";
import { handleAdminJoinpayQueryRoute, projectWorkerStatus } from "../src/order/admin-joinpay-query-routes";

const ADMIN = "https://admin.example.invalid", API = "https://api.example.invalid";
function fixture(t: any) {
  const s = { status: 0, result: null as any, authorized: [] as string[], queries: 0, sql: [] as string[] };
  t.mock.method(authSecurity, "readAdminContext", async () => ({ userId: "admin_1", sessionId: "sess_1" }));
  t.mock.method(command, "authorizeAdminNativeRefund", async (_c: unknown, _a: unknown, orderId: string) => { s.authorized.push(orderId); });
  const client = { query: async (sql: string) => { s.sql.push(sql); return { rows: [{ order_id: "order_1" }] }; } };
  t.mock.method(refundAttempt, "queryJoinpayRefund", async (_o: unknown, id: string, owner: string, opts: any) => {
    s.queries++; assert.match(owner, /^adminq_[0-9a-f-]{36}$/); assert.equal(opts.minimumIntervalSeconds, 30);
    await opts.authorize(client, id); return { kind: "SKIPPED", intentId: id, state: "SUBMITTED", reason: "THROTTLED" };
  });
  t.mock.method(collectionAttempt, "executeJoinpayCollectionAttempt", async (_o: unknown, input: any) => {
    s.queries++; assert.equal(input.allowFirstDispatch, false); assert.equal(input.recoveryMinimumIntervalSeconds, 30);
    await input.authorize(client, input.requestId); throw new collectionAttempt.CollectionAttemptCommitUnknown(input.requestId, "RESULT");
  });
  const response = { headersSent: false, setHeader() { return this; }, status(code: number) { s.status = code; return this; }, json(v: unknown) { s.result = v; return this; } } as any;
  const security = { pool: {} as never, adminOrigin: ADMIN, apiOrigin: API, userOrigin: "https://u.invalid" } as any;
  const invoke = (path: string, patch: any = {}, options: any = { refund: {}, collection: {} }) =>
    handleAdminJoinpayQueryRoute({ method: "POST", originalUrl: "/api/v1/admin/joinpay" + path, headers: { origin: ADMIN }, body: {}, ...patch } as any,
      response, security, "/api/v1/admin/joinpay", options);
  return { s, invoke, security };
}

test("非query-only路径交后续中间件；GET/多余字段/跨源先拒绝且不出网", async t => {
  const f = fixture(t);
  assert.equal(await f.invoke("/refunds/r1"), false);
  await f.invoke("/refunds/r1/query-only", { method: "GET" }); assert.equal(f.s.status, 404);
  await f.invoke("/refunds/r1/query-only", { body: { force: true } }); assert.equal(f.s.status, 400);
  await f.invoke("/refunds/r1/query-only", { headers: { origin: "https://evil.invalid" } }); assert.equal(f.s.status, 403);
  assert.equal(f.s.queries, 0);
});

test("退款补查在claim内按订单授权；SKIPPED原因透出，渠道到账恒UNKNOWN", async t => {
  const f = fixture(t);
  await f.invoke("/refunds/refund_1/query-only");
  assert.equal(f.s.status, 200); assert.deepEqual(f.s.authorized, ["order_1"]);
  assert.match(f.s.sql[0]!, /channel_refund_intent/);
  assert.equal(f.s.result.contractVersion, "admin-joinpay-query.v1");
  assert.deepEqual(f.s.result.outcome, { kind: "SKIPPED", reason: "THROTTLED", state: "SUBMITTED" });
  assert.equal(f.s.result.channelArrival, "UNKNOWN");
});

test("授权失败不进入渠道；提交后未知返回202 UNKNOWN", async t => {
  const f = fixture(t);
  t.mock.method(command, "authorizeAdminNativeRefund", async () => { throw new SecurityApiError(403, "FORBIDDEN", "no"); });
  await f.invoke("/refunds/refund_1/query-only"); assert.equal(f.s.status, 403);
  const g = fixture(t);
  await g.invoke("/collection-requests/req_1/query-only");
  assert.equal(g.s.status, 202); assert.deepEqual(g.s.result.outcome, { kind: "UNKNOWN", phase: "RESULT" });
  assert.match(g.s.sql[0]!, /payment_request/); assert.equal(g.s.result.localFundsEffect, "UNKNOWN");
});

test("提现/退款/收款未装配执行器均503 EVIDENCE_UNAVAILABLE，不出网", async t => {
  const f = fixture(t);
  await f.invoke("/withdrawals/w1/query-only", {}, {}); assert.equal(f.s.status, 503);
  await f.invoke("/refunds/r1/query-only", {}, {}); assert.equal(f.s.status, 503);
  await f.invoke("/collection-requests/q1/query-only", {}, {}); assert.equal(f.s.status, 503);
  assert.equal(f.s.queries, 0);
});
test("worker状态只投影白名单字段，不泄漏对象标识或幂等键", () => {
  const out = projectWorkerStatus({ refund: { stopped: false, failure: { code: "REFUND_EXECUTION_UNKNOWN", phase: "RESULT", intentId: "i1", idempotencyKey: "k" } as any },
    payout: { stopped: true, failure: null }, collection: { stopped: false, failure: { code: "bad code!" } } });
  assert.deepEqual(out.refund, { configured: true, running: true, failureCode: "REFUND_EXECUTION_UNKNOWN", failurePhase: "RESULT", lastSuccessfulQueryAt: null });
  assert.equal(out.collection.failureCode, "UNKNOWN"); assert.equal(out.payout.running, false);
  assert.doesNotMatch(JSON.stringify(out), /i1|"k"/);
  assert.equal(projectWorkerStatus(undefined).refund.configured, false);
  assert.equal(projectWorkerStatus({}).payout.configured, false);
});
// ---- 提现QUERY-only：finance.withdrawal.query ----
function payoutFixture(t: any, access: any, intent: any = { merchant_identity_id: "m1" }) {
  const s = { authSession: 0, lockedSql: [] as string[], queries: 0, executes: 0 };
  t.mock.method(adminSession, "assertAdminCommandAuthorizedInTransaction", async () => { s.authSession++; return { locked: false, pinHash: null, pinFailures: 0 }; });
  t.mock.method(adminAuthz, "loadEffectiveAdminAccess", async () => access);
  t.mock.method(payoutProfile, "readPayoutScope", () => ({ merchantIdentityId: "m1" }));
  t.mock.method(payoutAttempt, "executeJoinpayPayout", async () => { s.executes++; throw new Error("AUTO forbidden"); });
  const client = { query: async (sql: string) => { s.lockedSql.push(sql); return { rows: intent ? [intent] : [] }; } };
  return { s, client };
}
const perms = (...codes: string[]) => ({ status: "ACTIVE", isBoss: false, permissions: new Set(codes) });

test("目录：新码可识别、不进baseline、迁移目录记录准确且仅一条", () => {
  assert.equal(adminAuthz.ADMIN_PERMISSION.financeWithdrawalQuery, "finance.withdrawal.query");
  assert.ok(adminAuthz.isAdminPermissionCode("finance.withdrawal.query"));
  assert.ok(!(adminAuthz.ADMIN_BASELINE_PERMISSION_CODES as readonly string[]).includes("finance.withdrawal.query"));
  const sql = readFileSync(join(__dirname, "../../migrations/business/0104_finance_withdrawal_query_permission.sql"), "utf8");
  assert.match(sql, /'finance\.withdrawal\.query', '同步提现渠道结果'/); assert.match(sql, /ON CONFLICT \(code\) DO NOTHING/);
  assert.doesNotMatch(sql, /GRANT|admin_role_permission|admin_user_permission|DELETE|UPDATE/i);
});

test("仅finance.read或user.finance.read无新命令权：403，不读原单", async t => {
  for (const access of [perms("finance.read"), perms("user.finance.read"), perms("order.settlement.write", "finance.read"), { status: "FROZEN", isBoss: true, permissions: new Set(adminAuthz.ADMIN_PERMISSION_CODES) }]) {
    const f = payoutFixture(t, access);
    await assert.rejects(authorizeAdminWithdrawalQuery(f.client as any, { userId: "a", sessionId: "s" }, "w1", "m1"), (e: any) => e.status === 403);
    assert.equal(f.s.authSession, 1); assert.equal(f.s.lockedSql.length, 0);
  }
});

test("有新码但缺平台财务范围或商户不符：拒绝；原单不存在404；Boss全字典通过", async t => {
  let f = payoutFixture(t, perms("finance.withdrawal.query"));
  await assert.rejects(authorizeAdminWithdrawalQuery(f.client as any, { userId: "a", sessionId: "s" }, "w1", "m1"), (e: any) => e.status === 403);
  f = payoutFixture(t, perms("finance.withdrawal.query", "finance.read"), { merchant_identity_id: "other" });
  await assert.rejects(authorizeAdminWithdrawalQuery(f.client as any, { userId: "a", sessionId: "s" }, "w1", "m1"), (e: any) => e.status === 403);
  f = payoutFixture(t, perms("finance.withdrawal.query", "finance.read"), null);
  await assert.rejects(authorizeAdminWithdrawalQuery(f.client as any, { userId: "a", sessionId: "s" }, "w1", "m1"), (e: any) => e.status === 404);
  f = payoutFixture(t, { status: "ACTIVE", isBoss: true, permissions: new Set(adminAuthz.ADMIN_PERMISSION_CODES) });
  await authorizeAdminWithdrawalQuery(f.client as any, { userId: "a", sessionId: "s" }, "w1", "m1");
  assert.match(f.s.lockedSql[0]!, /joinpay_withdrawal_intent/);
});

test("授权者只进入queryJoinpayPayout：NOT_DISPATCHED/SKIPPED/202 UNKNOWN，绝不AUTO", async t => {
  const f = fixture(t), p = payoutFixture(t, perms("finance.withdrawal.query", "finance.read"));
  const outs: any[] = [{ kind: "NOT_DISPATCHED", state: "RESERVED" }, { kind: "SKIPPED", state: "SUBMITTED", reason: "OUTSIDE_QUERY_WINDOW" }, { kind: "SKIPPED", state: "SUBMITTED", reason: "BUDGET_EXHAUSTED" }, "UNKNOWN"];
  t.mock.method(payoutAttempt, "queryJoinpayPayout", async (_o: unknown, id: string, owner: string, opts: any) => {
    p.s.queries++; assert.match(owner, /^adminq_/); assert.equal(opts.minimumIntervalSeconds, 30); assert.deepEqual(Object.keys(opts).sort(), ["authorize", "minimumIntervalSeconds"]);
    await opts.authorize(p.client, id); const o = outs.shift();
    if (o === "UNKNOWN") throw new payoutAttempt.PayoutCommitUnknown(id, "RESULT"); return { intentId: id, ...o };
  });
  const opt = { payout: { scope: {} } };
  await f.invoke("/withdrawals/w1/query-only", {}, opt);
  assert.equal(f.s.status, 200); assert.deepEqual(f.s.result.outcome, { kind: "NOT_DISPATCHED", state: "RESERVED" }); assert.equal(f.s.result.operation, "PAYOUT_QUERY");
  await f.invoke("/withdrawals/w1/query-only", {}, opt); assert.equal(f.s.result.outcome.reason, "OUTSIDE_QUERY_WINDOW");
  await f.invoke("/withdrawals/w1/query-only", {}, opt); assert.equal(f.s.result.outcome.reason, "BUDGET_EXHAUSTED");
  await f.invoke("/withdrawals/w1/query-only", {}, opt); assert.equal(f.s.status, 202); assert.deepEqual(f.s.result.outcome, { kind: "UNKNOWN", phase: "RESULT" });
  assert.equal(f.s.result.channelArrival, "UNKNOWN"); assert.equal(p.s.queries, 4); assert.equal(p.s.executes, 0);
  await f.invoke("/withdrawals/w1/query-only", { body: { queryOnly: true } }, opt); assert.equal(f.s.status, 400);
  await f.invoke("/withdrawals/w1/query-only", { body: { force: true } }, opt); assert.equal(f.s.status, 400);
  assert.equal(p.s.queries, 4);
});

test("QUERY scope未绑定：503，不进入执行器", async t => {
  const f = fixture(t); let called = 0;
  t.mock.method(payoutProfile, "readPayoutScope", () => { throw new Error("PAYOUT_SCOPE_NOT_BOUND"); });
  t.mock.method(payoutAttempt, "queryJoinpayPayout", async () => { called++; return null as any; });
  await f.invoke("/withdrawals/w1/query-only", {}, { payout: { scope: {} } }); assert.equal(f.s.status, 503); assert.equal(called, 0);
});

test("Master: E4收款查询不能声称无本地资金影响", async t => {
  const f = fixture(t);
  t.mock.method(collectionAttempt, "executeJoinpayCollectionAttempt", async (_o: unknown, input: any) => ({
    kind: "OBSERVED", operation: "QUERY", observation: { event: "E4" } } as any));
  await f.invoke("/collection-requests/req_1/query-only");
  assert.equal(f.s.status, 200);
  assert.equal(f.s.result.localFundsEffect, "ACCEPTANCE_MAY_HAVE_APPLIED");
  assert.equal(f.s.result.channelArrival, "UNKNOWN");
});

test("Master: 领取事务记录当前管理员、会话、原对象和执行owner，拒绝不写审计", async t => {
  const f = fixture(t), audits: any[] = [];
  t.mock.method(securityCore, "recordAudit", async (client: Parameters<typeof securityCore.recordAudit>[0], values: Parameters<typeof securityCore.recordAudit>[1]) => { assert.ok(client); audits.push(values); });
  await f.invoke("/refunds/refund_1/query-only");
  assert.equal(audits.length, 1);
  assert.equal(audits[0].actorType, "admin"); assert.equal(audits[0].actorId, "admin_1"); assert.equal(audits[0].sessionId, "sess_1");
  assert.equal(audits[0].objectId, "refund_1"); assert.equal(audits[0].details.operation, "REFUND_QUERY");
  assert.match(audits[0].details.executionOwner, /^adminq_/);
  t.mock.method(command, "authorizeAdminNativeRefund", async () => { throw new SecurityApiError(403, "FORBIDDEN", "no"); });
  await f.invoke("/refunds/refund_2/query-only"); assert.equal(f.s.status, 403); assert.equal(audits.length, 1);
});

test("Master: 管理查询审计失败必须阻断领取", async t => {
  const f = fixture(t);
  t.mock.method(securityCore, "recordAudit", async () => { throw new Error("SYNTHETIC_AUDIT_FAILURE"); });
  await f.invoke("/refunds/refund_1/query-only");
  assert.equal(f.s.status, 500);
});

test("Master: worker只读状态在同一事务复核会话并拒绝跨源", async t => {
  const f = fixture(t), client = { query: async () => ({ rows: [] }), release() {} };
  f.security.pool = { connect: async () => client };
  let checked = 0;
  t.mock.method(authSecurity, "assertAdminContextInTransaction", async (c: unknown) => { assert.equal(c, client); checked++; });
  t.mock.method(adminAuthz, "loadEffectiveAdminAccess", async () => perms("finance.read"));
  await f.invoke("/worker-status", { method: "GET" }, {});
  assert.equal(f.s.status, 200); assert.equal(checked, 1); assert.equal(f.s.result.payout.configured, false);
  t.mock.method(authSecurity, "assertAdminContextInTransaction", async () => { throw new SecurityApiError(401, "UNAUTHENTICATED", "revoked"); });
  await f.invoke("/worker-status", { method: "GET" }, {}); assert.equal(f.s.status, 401);
  await f.invoke("/worker-status", { method: "GET", headers: { origin: "https://evil.invalid" } }, {}); assert.equal(f.s.status, 403);
});
