import { strict as assert } from "node:assert";
import { test } from "node:test";
import { handleAdminBff, type AdminBffOptions } from "../src/bff/admin-bff";
import * as orderRoutes from '../src/order/order-routes';

const ADMIN_ORIGIN = "http://127.0.0.1:4291";
const API_ORIGIN = "http://127.0.0.1:4292";

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
