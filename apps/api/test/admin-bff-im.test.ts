import { strict as assert } from "node:assert";
import { test } from "node:test";
import { handleAdminBff, type AdminBffOptions } from "../src/bff/admin-bff";
import * as orderRoutes from '../src/order/order-routes';
import * as legalRoutes from "../src/legal/legal-routes";
import * as yunxinRoutes from '../src/im/yunxin-routes';
import * as consultation from '../src/im/consultation';
import * as authSecurity from '../src/auth/auth-security';
import * as domainSummary from '../src/auth/admin-domain-summary-routes';
import * as distributionDashboard from "../src/finance/admin-distribution-dashboard-routes";
import * as legacyEvidenceReader from "../src/order/legacy-continuation-evidence";
import { initialLegacyFacts } from "../src/order/legacy-continuation-model";
import { legacyBinding, legacyEvidence, legacyQuantities, legacySource } from "./legacy-continuation-fixture";

const ADMIN_ORIGIN = "http://127.0.0.1:4291";
const API_ORIGIN = "http://127.0.0.1:4292";

test("legal Admin BFF forwards exact routes and keeps method/origin boundaries", async t => {
  const calls: Array<{ path: string; body: unknown }> = [];
  t.mock.method(legalRoutes, "handleLegalAdminRoute", async (request: Parameters<typeof legalRoutes.handleLegalAdminRoute>[0], response: Parameters<typeof legalRoutes.handleLegalAdminRoute>[1]) => {
    calls.push({ path: request.originalUrl!, body: request.body }); response.status(200).json({ versions: [] });
  });
  assert.equal((await route("/legal-documents?docType=PLATFORM_TERMS")).status, 200);
  assert.equal(calls[0]?.path, "/api/v1/admin/legal-documents?docType=PLATFORM_TERMS");
  const output = capture(), body = { title: "测试正文", expectedRevision: "1" };
  await handleAdminBff({ method: "PUT", url: "/legal-documents/drafts/legal_1", headers: { origin: ADMIN_ORIGIN }, body } as never, output.response as never, options());
  assert.equal(calls[1]?.body, body);
  assert.equal(calls[1]?.path, "/api/v1/admin/legal-documents/drafts/legal_1");
  assert.equal((await route("/legal-documents/drafts/legal_1", "DELETE")).status, 404);
  assert.equal((await route("/legal-documents/unknown", "POST")).status, 404);
  assert.equal(calls.length, 2);
});

test("read-copy settings BFF preserves GET/PUT and original configuration payload, rejecting unrelated methods", async t => {
  const forwarded: any[] = [];
  t.mock.method(yunxinRoutes, "handleYunxinRoute", async (request: any, response: any) => { forwarded.push(request); response.status(200).json({ candidate: true }); });
  for (const method of ["GET", "PUT"]) {
    const result = capture(), body = method === "PUT" ? { version: 0, enabled: false, publicOrigin: null, operationId: "original_operation" } : undefined;
    await handleAdminBff({ method, url: "/im/read-copy-settings", originalUrl: "/im/read-copy-settings", headers: { origin: ADMIN_ORIGIN }, body }, result.response as never, options());
    assert.equal(result.result().status, 200); assert.equal(forwarded.at(-1).originalUrl, "/api/v1/im/admin/read-copy-settings");
    assert.equal(forwarded.at(-1).method, method); assert.equal(forwarded.at(-1).body, body);
  }
  for (const method of ["POST", "DELETE"]) assert.equal((await route("/im/read-copy-settings", method)).status, 404);
  assert.equal((await route("/im/read-copy-settings-extra")).status, 404); assert.equal(forwarded.length, 2);
});

test("both customer statistics BFF routes preserve the selected date range for domain authorization", async t => {
  const forwarded: any[] = [];
  t.mock.method(yunxinRoutes, "handleYunxinRoute", async (request: any, response: any) => { forwarded.push(request); response.status(200).json({ candidate: true }); });
  for (const endpoint of ["support-overview", "my-support-statistics"]) {
    const result = capture(), path = `/im/${endpoint}?dateFrom=2026-10-01&dateTo=2026-10-31`;
    await handleAdminBff({method:"GET",url:path,originalUrl:path,headers:{origin:ADMIN_ORIGIN}},result.response as never,options());
    assert.equal(result.result().status,200);
    assert.equal(forwarded.at(-1).originalUrl,`/api/v1/im/admin/${endpoint}?dateFrom=2026-10-01&dateTo=2026-10-31`);
  }
});

test('Admin BFF仅放行准确的未开租审核命令，保持原body/key并交订单领域授权',async t=>{
 let forwarded:any;
 t.mock.method(orderRoutes,'handleOrderAdminRoute',async(req:any,res:any)=>{forwarded=req;res.status(200).json({outcome:'LOCAL_REVIEW_ONLY'});});
 const output=capture(),body={decision:'APPROVE',expectedRevision:'1',assessment:'NO_USE_NO_DISPUTE',reason:'核实无交付与争议'};
 await handleAdminBff({method:'POST',url:'/orders/order_1/prestart-termination/term_1/review',originalUrl:'/orders/order_1/prestart-termination/term_1/review',
  headers:{origin:ADMIN_ORIGIN,'idempotency-key':'original_review'},body} as any,output.response as never,options());
 assert.equal(output.result().status,200);assert.equal(forwarded.originalUrl,'/api/v1/admin/orders/order_1/prestart-termination/term_1/review');
 assert.equal(forwarded.body,body);assert.equal(forwarded.headers['idempotency-key'],'original_review');
 const unknown=await route('/orders/order_1/prestart-termination/term_1/auto-refund','POST');assert.equal(unknown.status,404);
});

test('Admin BFF forwards the exact legacy settlement operations and retains their original request',async t=>{
 const calls:any[]=[];t.mock.method(orderRoutes,'handleOrderAdminRoute',async(req:any,res:any)=>{calls.push(req);res.status(200).json({outcome:'DOMAIN_CHECKED'});});
 const orderId='legacy_order_'+'a'.repeat(40),body={expectedRevision:'1',reason:'双方已核对'};
 for(const action of ['preview','propose','confirm','reject','duties/duty_1/owner-credit','duties/duty_1/commission-credit','duties/duty_1/refund-case','duties/duty_1/demo-refund']){
  const path=`/orders/legacy/${orderId}/continuation/${action}`,output=capture();
  await handleAdminBff({method:'POST',url:path,originalUrl:path,headers:{origin:ADMIN_ORIGIN,'idempotency-key':'original_key'},body} as any,output.response as never,options());
  assert.equal(output.result().status,200);assert.equal(calls.at(-1).originalUrl,`/api/v1/admin${path}`);assert.equal(calls.at(-1).body,body);assert.equal(calls.at(-1).headers['idempotency-key'],'original_key');
 }
 assert.equal((await route(`/orders/legacy/${orderId}/continuation/approve-all`,'POST')).status,404);
 assert.equal((await route(`/orders/legacy/${orderId}/continuation/confirm/extra`,'POST')).status,404);
 assert.equal((await route(`/orders/legacy/${orderId}/continuation/confirm`,'DELETE')).status,404);assert.equal(calls.length,8);
});
test('Admin BFF reaches real legacy calculation and returns an actionable shortfall',async t=>{
 t.mock.method(authSecurity,'readAdminContext',async()=>({userId:'fixture_admin',sessionId:'fixture_session'}));
 t.mock.method(legacyEvidenceReader,'readLegacyContinuationBinding',async()=>legacyBinding);
 t.mock.method(legacyEvidenceReader,'authorizeLegacyContinuation',async()=>({canOperate:true,canReadCommission:false}));
 t.mock.method(legacyEvidenceReader,'readLegacyContinuationHead',async()=>null);
 t.mock.method(legacyEvidenceReader,'readLegacyContinuationEvidence',async()=>legacyEvidence(initialLegacyFacts(legacySource())));
 const pool={connect:async()=>({release(){},query:async()=>({rows:[],rowCount:0})})},out=capture();
 const opt=options();opt.order={pool,apiOrigin:API_ORIGIN,adminOrigin:ADMIN_ORIGIN} as never;
 const path=`/orders/legacy/${legacyBinding.id}/continuation/preview`;
 await handleAdminBff({method:'POST',url:path,originalUrl:path,headers:{origin:ADMIN_ORIGIN},body:{onBehalf:'renter',quantities:legacyQuantities('999999')}} as never,out.response as never,opt);
 assert.equal(out.result().status,409);assert.equal((out.result().body as any).error.reason,'DEPOSIT_SHORT');
});

function capture() {
  let status = 200;
  let body: unknown;
  const headers: Record<string, unknown> = {};
  const response = {
    setHeader(name: string, value: unknown) { headers[name] = value; return response; },
    status(value: number) { status = value; return response; },
    json(value: unknown) { body = value; return response; },
    send(value: unknown) { body = value; return response; },
  };
  return { response, result: () => ({ status, body, headers }) };
}

function options(): AdminBffOptions {
  return {
    adminOrigin: ADMIN_ORIGIN,
    apiOrigin: API_ORIGIN,
    adminSecurityOptions: {} as never,
    adminAuthHandler: (() => undefined) as never,
    supply: {} as never,
    order: {} as never,
    yunxin: {
      security: { apiOrigin: API_ORIGIN, adminOrigin: ADMIN_ORIGIN },
      appId: "fixture-app",
      repository: {} as never,
      provisioner: {} as never,
      tokenService: {} as never,
      consultation: undefined,
    },
  } as unknown as AdminBffOptions;
}

async function route(path: string, method = "GET") {
  const output = capture();
  await handleAdminBff(
    { method, url: path, originalUrl: path, headers: { origin: ADMIN_ORIGIN } },
    output.response as never,
    options(),
  );
  return output.result();
}

test("admin BFF forwards the transfer-targets route and still rejects unknown or wrong-method paths", async () => {
  // Whitelisted: the route reaches the IM handler; without a consultation seam
  // it fails closed with 503, which proves forwarding rather than a 404.
  const forwarded = await route("/im/transfer-targets?consultationId=consultation-a");
  assert.equal(forwarded.status, 503);

  const wrongMethod = await route("/im/transfer-targets?consultationId=consultation-a", "POST");
  assert.equal(wrongMethod.status, 404);

  const unknown = await route("/im/not-a-route");
  assert.equal(unknown.status, 404);

  const unrelated = await route("/im/transfer-targets-extra");
  assert.equal(unrelated.status, 404);
});

test("admin BFF only forwards exact legacy consultation order reads", async t => {
  const calls: string[] = [];
  t.mock.method(yunxinRoutes, "handleYunxinRoute", async (request: any, response: any) => { calls.push(request.originalUrl); response.status(200).json({ ok: true }); });
  const id=`legacy_order_${"a".repeat(40)}`,path=`/im/consultations/consult_1/legacy-orders/${id}`;
  assert.equal((await route(path)).status,200);
  assert.deepEqual(calls,[`/api/v1/im/admin/consultations/consult_1/legacy-orders/${id}`]);
  assert.equal((await route(path,"POST")).status,404);
  assert.equal((await route('/im/consultations/consult_1/legacy-orders/legacy_order_bad')).status,404);
  assert.equal((await route(path+'/extra')).status,404);
  assert.equal(calls.length,1);
});

test("legacy consultation order route preserves authorization boundary and rejects query or wrong method", async t => {
  const id=`legacy_order_${"a".repeat(40)}`,path=`/api/v1/im/admin/consultations/consult_1/legacy-orders/${id}`, calls: string[] = [];
  t.mock.method(authSecurity, "readAdminContext", async () => ({ userId:"staff_1", sessionId:"session_1" } as never));
  t.mock.method(consultation, "readConsultationLegacyOrderReference", async (_options: any, actor: any, consultationId: string, orderId: string) => {
    calls.push(`${actor.userId}:${consultationId}:${orderId}`);
    return {contractVersion:"im-legacy-order-reference.v1" as const,subject:{status:"resolved" as const,kind:"ORDER" as const,origin:"LEGACY" as const,displayNo:"OLD-1",title:null,target:{kind:"ORDER" as const,id:orderId},party:"OWNER" as const}};
  });
  const opts={...options().yunxin!,consultation:{} as never};
  const invoke=async(url:string,method="GET",origin=ADMIN_ORIGIN)=>{const out=capture();await yunxinRoutes.handleYunxinRoute({method,url,originalUrl:url,headers:{origin}} as never,out.response as never,opts);return out.result();};
  assert.equal((await invoke(path)).status,200);assert.deepEqual(calls,[`staff_1:consult_1:${id}`]);
  assert.equal((await invoke(path,"POST")).status,404);
  assert.equal((await invoke(path+"?untrusted=1")).status,400);
  assert.equal((await invoke(path,"GET","https://other.invalid")).status,403);
  assert.equal(calls.length,1);
});

test("admin BFF keeps rejecting cross-origin and bearer requests before any IM forwarding", async () => {
  const crossOrigin = capture();
  await handleAdminBff(
    { method: "GET", url: "/im/transfer-targets", originalUrl: "/im/transfer-targets", headers: { origin: "http://127.0.0.1:9999" } },
    crossOrigin.response as never,
    options(),
  );
  assert.equal(crossOrigin.result().status, 403);

  const bearer = capture();
  await handleAdminBff(
    { method: "GET", url: "/im/transfer-targets", originalUrl: "/im/transfer-targets", headers: { origin: ADMIN_ORIGIN, authorization: "Bearer token" } },
    bearer.response as never,
    options(),
  );
  assert.equal(bearer.result().status, 400);
});

 test('domain summary BFF admits only the two exact GET leaves and preserves list filters',async t=>{
 const calls:string[]=[];t.mock.method(domainSummary,'handleAdminDomainSummary',async(request:any,response:any)=>{calls.push(request.originalUrl);response.status(200).json({state:'KNOWN'});});
 for(const domain of ['users','orders'])assert.equal((await route('/'+domain+'/overview-stats?accountStatus=ACTIVE')).status,200);
 assert.deepEqual(calls,['/api/v1/admin/users/overview-stats?accountStatus=ACTIVE','/api/v1/admin/orders/overview-stats?accountStatus=ACTIVE']);
 assert.equal((await route('/users/overview-stats','POST')).status,404);assert.equal((await route('/orders/overview-stats','DELETE')).status,404);assert.equal(calls.length,2);
 });


test("admin BFF forwards exact paginated downline reads and keeps method boundaries",async t=>{
 const forwarded:string[]=[];
 t.mock.method(distributionDashboard,"handleAdminDistributionDashboard",async(request:any,response:any)=>{
  forwarded.push(request.originalUrl);response.status(200).json({items:[]});
 });
 const path="/distribution/participants/user-1/downline?type=INVITER&page=2&pageSize=10";
 assert.equal((await route(path)).status,200);
 assert.deepEqual(forwarded,["/api/v1/admin/distribution/participants/user-1/downline?type=INVITER&page=2&pageSize=10"]);
 assert.equal((await route(path,"POST")).status,404);
 assert.equal((await route("/distribution/participants/user-1/downline/extra")).status,404);
 assert.equal(forwarded.length,1);
});

test("admin BFF forwards the exact support unpaid cancellation path", async t => {
 const calls:string[]=[];
 t.mock.method(orderRoutes,"handleOrderAdminRoute",async(request:any,response:any)=>{calls.push(request.originalUrl);response.status(200).json({ok:true});});
 const path="/orders/order_1/support-unpaid-cancel";
 assert.equal((await route(path,"POST")).status,200);
 assert.equal((await route(path,"DELETE")).status,404);
 assert.equal((await route(path+"/extra","POST")).status,404);
 assert.deepEqual(calls,["/api/v1/admin/orders/order_1/support-unpaid-cancel"]);
});
