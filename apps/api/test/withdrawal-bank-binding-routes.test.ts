import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { INestApplication } from "@nestjs/common";
import { mountWithdrawalBankBinding } from "../src/finance/withdrawal-bank-binding-routes";
import * as identity from "../src/auth/user-identity";
import { SecurityApiError } from "../src/auth/security-core";
import { actor, fixture, input } from "./fixtures/withdrawal-bank-binding-model";

// SYNTHETIC_ROUTE_COMPONENT：直接中间件，无HTTP监听、真实登录或商户调用。
function route(t: TestContext, enabled = true) {
  const f = fixture(), handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  const app = { getHttpAdapter: () => ({ getInstance: () => ({ use: (path: string, handle: (...args: any[]) => Promise<unknown>) => handlers.set(path, handle) }) }) } as unknown as INestApplication;
  t.mock.method(identity, "readUserContext", async () => actor);
  mountWithdrawalBankBinding(app, { pool: f.pool, apiOrigin: "https://api.invalid", userOrigin: "https://user.invalid", adminOrigin: "https://admin.invalid",
    ...(enabled ? { withdrawalBankBinding: f.options } : {}) } as any);
  async function call(method = "GET", path = "", body?: unknown, headers: Record<string, string> = {}, bff = false) {
    const prefix = bff ? "/api/bff/user/withdrawal-bank-binding" : "/api/v1/users/me/withdrawal-bank-binding";
    const response: any = { code: 0, body: null, headers: {}, status(code: number) { this.code = code; return this; }, setHeader(k: string, v: unknown) { this.headers[k] = v; return this; }, json(value: unknown) { this.body = value; return this; } };
    await handlers.get(prefix)!({ method, originalUrl: prefix + path, url: prefix + path, headers: { origin: "https://user.invalid", ...headers }, body }, response);
    return response;
  }
  return { f, call, handlers };
}
test("GET本人资料不读钥；POST必须原幂等键；错误使用既有嵌套信封", async t => {
  const r = route(t), get = await r.call(); assert.equal(get.code, 200); assert.equal(get.body.binding, null); assert.equal(r.f.keys(), 0);
  const missing = await r.call("POST", "", input); assert.equal(missing.code, 400); assert.equal(missing.body.error.code, "MISSING_IDEMPOTENCY_KEY"); assert(missing.body.error.requestId);
  const saved = await r.call("POST", "", input, { "idempotency-key": "unit_save" }); assert.equal(saved.code, 200); assert.equal(saved.body.binding.revision, "1");
  assert(!JSON.stringify(saved.body).includes(input.cardNo)); assert.equal(saved.headers["Cache-Control"], "no-store");
});
test("越权字段、重复恢复key、意外query和未定义路径拒绝", async t => {
  const r = route(t);
  assert.equal((await r.call("POST", "", { ...input, userId: "another" }, { "idempotency-key": "unit_bad" })).code, 400);
  assert.equal((await r.call("GET", "/receipt?key=a&key=b")).code, 400);
  assert.equal((await r.call("GET", "?userId=another")).code, 400);
  for (const [method, path] of [["POST", "/receipt"], ["GET", "/private"], ["DELETE", ""]]) assert.equal((await r.call(method, path)).code, 404);
  assert.equal(r.f.keys(), 0); assert.equal(r.f.data().banks.size, 0);
});
test("Admin Origin不能变成用户入口授权；匿名请求失败", async t => {
  const r = route(t); assert.equal((await r.call("GET", "", undefined, { origin: "https://admin.invalid" })).code, 403);
  t.mock.method(identity, "readUserContext", async () => { throw new SecurityApiError(401, "UNAUTHENTICATED", "Authentication required"); });
  const denied = await r.call(); assert.equal(denied.code, 401); assert.equal(denied.body.error.code, "UNAUTHENTICATED"); assert.equal(r.f.keys(), 0);
});
test("未配置返回503；BFF别名复用相同业务和脱敏回执恢复", async t => {
  const off = route(t, false); assert.equal((await off.call()).code, 503);
  const r = route(t); const saved = await r.call("POST", "", input, { "idempotency-key": "unit_bff" }, true); assert.equal(saved.code, 200);
  const recovery = await r.call("GET", "/receipt?key=unit_bff", undefined, {}, true); assert.equal(recovery.code, 200); assert.equal(recovery.body.knowledge, "KNOWN");
  assert.deepEqual(recovery.body.receipt, saved.body); assert(!JSON.stringify(recovery.body).includes(input.cardNo));
});
test("提交结果未知返回可恢复错误，不能显示保存失败或再次修改", async t => {
  const r = route(t); r.f.state.commitUnknown = true;
  const result = await r.call("POST", "", input, { "idempotency-key": "unit_unknown" }); assert.equal(result.code, 503); assert.equal(result.body.error.code, "EVIDENCE_UNAVAILABLE");
  r.f.state.commitUnknown = false; const recovery = await r.call("GET", "/receipt?key=unit_unknown"); assert.equal(recovery.body.knowledge, "KNOWN"); assert.equal(r.f.data().banks.get(actor.userId)!.revision, "1");
});
