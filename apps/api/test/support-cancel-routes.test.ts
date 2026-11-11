// SYNTHETIC_COMPONENT_MODEL：调用真实 Admin 路由；身份、事务、幂等和域命令为内存替身。
import assert from "node:assert/strict";
import test from "node:test";
import * as auth from "../src/auth/auth-security";
import * as core from "../src/auth/security-core";
import * as routes from "../src/supply/supply-routes";
import * as domain from "../src/order/support-cancel";
import * as manualClose from "../src/order/manual-close";
import { handleSupportCancelAdminRoute } from "../src/order/support-cancel-routes";

function fixture(t: any) {
  const seen: string[] = [];
  let status = 0, body: any, failAfterAction = false;
  const response = { headersSent: false, setHeader() { return this; }, status(n: number) { status = n; return this; }, json(v: any) { body = v; return this; } } as any;
  const client = { query: async () => ({ rows: [] }) } as any;
  const options = { pool: {}, adminOrigin: "https://admin.invalid", apiOrigin: "https://api.invalid" } as any;
  t.mock.method(auth, "readAdminContext", async () => ({ userId: "support_1", sessionId: "session_1" }));
  t.mock.method(core, "withTransaction", async (_p: any, fn: any) => fn(client));
  t.mock.method(routes, "requireOrigin", () => true);
  t.mock.method(manualClose, "assertSupportOrderAccess", async (_c: any, id: string, actor: any) => {
    seen.push("authorize:" + id + ":" + actor.userId);
  });
  t.mock.method(domain, "supportCancelOrder", async (_c: any, actor: any, input: any) => {
    seen.push("action:" + actor.userId + ":" + input.expectedOrderRevision + ":" + input.reason);
    if(actor.ecsTestDemo===options.ecsTestDemo && options.ecsTestDemo)seen.push('demo:write');
    return { status: 200, body: { contractVersion: "admin-support-cancel.v1", orderId: input.orderId, orderRevision: "2",
      eligibility: { allowed: false, reason: "ALREADY_CANCELLED", refundCents: "15908" }, orderStatus: "CANCELLED",
      cancelReason: "SUPPORT_CANCELLED_REFUND", cancelledAt: "2026-10-30T00:00:00.000000Z", supportCancellation: null,
      refund: null, existing: false, channel: { result: "NOT_SUBMITTED", bankArrival: "UNKNOWN" } } };
  });
  t.mock.method(domain, "readSupportCancellation", async (_c: any, actor: any, id: string) => {
    seen.push("read:" + id + ":" + actor.userId);
    if(actor.ecsTestDemo===options.ecsTestDemo && options.ecsTestDemo)seen.push('demo:read');
    return { contractVersion: "admin-support-cancel.v1", orderId: id, orderRevision: "1", eligibility: { allowed: true, reason: null, refundCents: "15908" } };
  });
  t.mock.method(routes, "runIdempotentWrite", async (_o: any, request: any, res: any, requestId: string, scope: any, actor: any, frozen: any, authorize: any, action: any) => {
    seen.push("scope:" + JSON.stringify(scope));
    seen.push("frozen:" + JSON.stringify(frozen));
    seen.push("key:" + request.headers["idempotency-key"]);
    await authorize(client, {});
    const result = await action(client);
    if (failAfterAction) throw Error("SYNTHETIC_COMMIT_UNKNOWN");
    res.status(result.status).json(result.body);
  });
  const request = (method = "POST", path = "order_1", data: any = { expectedOrderRevision: "1", reason: "客服核实后取消" }, query = "") =>
    ({ method, url: `/api/v1/admin/orders/${path}/support-cancel${query}`, originalUrl: `/api/v1/admin/orders/${path}/support-cancel${query}`,
      headers: { origin: options.adminOrigin, "idempotency-key": "support_key_1" }, body: data }) as any;
  return { seen, response, options, request, status: () => status, body: () => body, failAfterAction() { failAfterAction = true; } };
}

test("POST沿用客服订单写权限与幂等key，只提交订单+版本+原因，不接收客户端金额", async (t) => {
  const f = fixture(t);
  await handleSupportCancelAdminRoute(f.request(), f.response, f.options, "order_1", new URLSearchParams(), "POST");
  assert.equal(f.status(), 200);
  assert.equal(f.body().cancelReason, "SUPPORT_CANCELLED_REFUND");
  assert(f.seen.includes("scope:" + JSON.stringify({ principalId: "support_1", operation: "order.support_cancel", resourceId: "order_1" })));
  assert(f.seen.includes('frozen:{"expectedOrderRevision":"1","reason":"客服核实后取消"}'));
  assert(f.seen.includes("key:support_key_1"));
  assert(f.seen.includes("authorize:order_1:support_1"));
  assert(f.seen.some(item => item.startsWith("action:support_1:1:客服核实后取消")));
  await assert.rejects(handleSupportCancelAdminRoute(f.request("POST", "order_1", { expectedOrderRevision: "1", reason: "客服核实后取消", amountCents: "1" }),
    f.response, f.options, "order_1", new URLSearchParams(), "POST"), (e: any) => e.status === 400);
});

test("GET只读预检；query字段与非GET/POST拒绝", async (t) => {
  const f = fixture(t);
  await handleSupportCancelAdminRoute(f.request("GET", "order_1", undefined), f.response, f.options, "order_1", new URLSearchParams(), "GET");
  assert.equal(f.status(), 200);
  assert(f.seen.some(item => item.startsWith("read:order_1:support_1")));
  assert.equal(f.seen.some(item => item.startsWith("scope:")), false);
  await assert.rejects(handleSupportCancelAdminRoute(f.request("GET", "order_1", undefined, "?amountCents=1"), f.response,
    f.options, "order_1", new URLSearchParams("amountCents=1"), "GET"), (e: any) => e.status === 400);
  await assert.rejects(handleSupportCancelAdminRoute(f.request("PUT"), f.response, f.options, "order_1", new URLSearchParams(), "PUT"),
    (e: any) => e.status === 404);
});

test("测试资源只由服务端装配并原样交给预检和命令",async t=>{
 const f=fixture(t);f.options.ecsTestDemo={kind:'SYNTHETIC_ONLY'};
 await handleSupportCancelAdminRoute(f.request('GET'),f.response,f.options,'order_1',new URLSearchParams(),'GET');
 await handleSupportCancelAdminRoute(f.request('POST'),f.response,f.options,'order_1',new URLSearchParams(),'POST');
 assert(f.seen.includes('demo:read'));assert(f.seen.includes('demo:write'));
});

test("领域提交后commit响应未知返回202原键恢复，不伪造成取消成功", async (t) => {
  const f = fixture(t); f.failAfterAction();
  await handleSupportCancelAdminRoute(f.request(), f.response, f.options, "order_1", new URLSearchParams(), "POST");
  assert.equal(f.status(), 202);
  assert.equal(f.body().outcome, "UNKNOWN");
  assert.equal(f.body().originalKeyRequired, true);
  assert.equal(f.body().bankArrival, "UNKNOWN");
});

test("开租后取消绑定当前管理员并冻结双方金额，身份漂移不得执行",async t=>{
 const f=fixture(t),input={expectedOrderRevision:"1",reason:"双方协商取消",refundCents:"5000",ownerCents:"3000",ownerAmountBasis:"GROSS_BEFORE_FEE_V1",expectedAdminId:"support_1"};
 await assert.rejects(handleSupportCancelAdminRoute(f.request("POST","order_1",{...input,expectedAdminId:"other"}),f.response,f.options,"order_1",new URLSearchParams(),"POST"),(e:any)=>e.status===401);
 assert.equal(f.seen.some(v=>v.startsWith("scope:")),false);
 t.mock.method(domain,"supportCancelAfterOpening",async(_c:any,actor:any,payload:any)=>{
  assert.equal(actor.userId,"support_1");assert.equal(payload.refundCents,"5000");assert.equal(payload.ownerCents,"3000");
  return {status:200,body:{orderId:"order_1"}};
 });
 await handleSupportCancelAdminRoute(f.request("POST","order_1",input),f.response,f.options,"order_1",new URLSearchParams(),"POST");
 assert(f.seen.includes("scope:"+JSON.stringify({principalId:"support_1",operation:"order.support_cancel_after_opening",resourceId:"order_1"})));
 assert(f.seen.some(v=>v.includes('"expectedAdminId":"support_1"')));
});

test("旧金额口径的新请求在原键下记录确定拒绝，不执行取消",async t=>{
 const f=fixture(t);let called=false;
 t.mock.method(domain,"supportCancelAfterOpening",async()=>{called=true;throw Error("must not execute");});
 const old={expectedOrderRevision:"1",reason:"双方协商取消",refundCents:"5000",ownerCents:"3000",expectedAdminId:"support_1"};
 await handleSupportCancelAdminRoute(f.request("POST","order_1",old),f.response,f.options,"order_1",new URLSearchParams(),"POST");
 assert.equal(f.status(),409);assert.deepEqual(f.body().reasons,["OWNER_AMOUNT_CONTRACT_REFRESH_REQUIRED"]);assert.equal(called,false);
});
