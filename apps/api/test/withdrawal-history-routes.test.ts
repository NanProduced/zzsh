import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { INestApplication } from "@nestjs/common";
import * as identity from "../src/auth/user-identity";
import { SecurityApiError } from "../src/auth/security-core";
import { mountPersonalWithdrawalHistory } from "../src/finance/withdrawal-history-routes";
import { actor, cursorKey, fixture, nativeRow } from "./fixtures/withdrawal-history-model";

// SYNTHETIC_ROUTE_ONLY：直接调用中间件，无HTTP监听/浏览器/PG/渠道。
function route(t: TestContext) {
  const f = fixture([nativeRow("a")]), handlers = new Map<string, (...args: any[]) => Promise<void>>();
  t.mock.method(identity, "readUserContext", async () => actor);
  const app = { getHttpAdapter: () => ({ getInstance: () => ({ use: (path: string, handler: any) => handlers.set(path, handler) }) }) } as unknown as INestApplication;
  mountPersonalWithdrawalHistory(app, { pool: f.pool, apiOrigin: "https://api.invalid", userOrigin: "https://user.invalid", adminOrigin: "https://admin.invalid", listingCursorKey: cursorKey } as any);
  async function call(path = "?source=JOINPAY", method = "GET", headers: Record<string, string> = {}, bff = false) {
    const prefix = bff ? "/api/bff/user/withdrawal-history" : "/api/v1/users/me/withdrawal-history", response: any = { code: 0, body: null, headers: {},
      status(code: number) { this.code = code; return this; }, setHeader(name: string, value: unknown) { this.headers[name] = value; return this; }, json(value: unknown) { this.body = value; } };
    await handlers.get(prefix)!({ method, originalUrl: prefix + path, headers: { origin: "https://user.invalid", "x-user-id": "unit_spoofed", ...headers } }, response); return response;
  }
  return { ...f, call };
}
test("新历史GET本人过滤/无渠道配置可用，BFF别名共用合同且no-store", async t => {
  const r = route(t), got = await r.call(); assert.equal(got.code, 200); assert.equal(got.body.subjectId, actor.userId); assert.equal(got.body.contractVersion, "personal-withdrawals.read.v2");
  assert.equal(got.body.sections.joinpay.data.count, "1"); assert.equal(got.headers["Cache-Control"], "no-store");
  assert(r.trace.filter(q => q.sql.startsWith("SELECT count(*)::text AS total_count")).every(q => q.values[0] === actor.userId));
  assert.equal((await r.call("?source=JOINPAY", "GET", {}, true)).code, 200); assert.equal(r.keys(), 0);
});
test("写方法、越权查询与歧义过滤拒绝，不调用执行器", async t => {
  const r = route(t); for (const method of ["POST", "PUT", "DELETE"]) assert.equal((await r.call("", method)).code, 404);
  for (const path of ["?source=JOINPAY&userId=other", "?source=JOINPAY&limit=101", "/receipt?key=a&key=b", "/receipt?key=bad%20key", "/joinpay:jwd_a?source=JOINPAY"]) assert.equal((await r.call(path)).code, 400);
  assert.equal((await r.call("/private")).code, 404); assert.equal(r.keys(), 0);
});
test("Admin Origin不授予用户数据访问，匿名错误使用原嵌套信封", async t => {
  const r = route(t); assert.equal((await r.call(undefined, "GET", { origin: "https://admin.invalid" })).code, 403);
  t.mock.method(identity, "readUserContext", async () => { throw new SecurityApiError(401, "UNAUTHENTICATED", "Authentication required"); });
  const denied = await r.call(); assert.equal(denied.code, 401); assert.equal(denied.body.error.code, "UNAUTHENTICATED"); assert(denied.body.error.requestId);
});
test("原key读当前本地单不冒称原ACK成功，详情只取原目标，不回查当前卡", async t => {
  const r = route(t), row = r.history.rows[0]!; r.history.receipts.set(actor.userId + ":unit_request", row.id);
  const result = await r.call("/receipt?key=unit_request"); assert.equal(result.code, 200); assert.equal(result.body.knowledge, "KNOWN"); assert.equal(result.body.mayResubmit, false);
  assert.equal(result.body.receiptMeaning, "CURRENT_LOCAL_INTENT_ORIGINAL_KEY_NOT_ORIGINAL_ACK");
  const detail = await r.call("/joinpay%3A" + row.id); assert.equal(detail.code, 200); assert.equal(detail.body.data.item.originalDestination.cardMask, "**** **** 0015");
  assert(!JSON.stringify(detail.body).includes("0000000000000015")); assert(r.trace.every(q => !q.sql.includes("FROM zzsh_order.withdrawal_bank_binding")));
});
