import { strict as assert } from "node:assert";
import { test } from "node:test";
import { handleAdminBff, type AdminBffOptions } from "../src/bff/admin-bff";

const ADMIN_ORIGIN = "http://127.0.0.1:4291";
const API_ORIGIN = "http://127.0.0.1:4292";

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
