import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
const { GET, POST } = await import("../src/app/api/account/rental-membership/route.ts");

function request(init = {}) {
  return new Request("http://127.0.0.1:3100/api/account/rental-membership", init);
}

test("membership route reads the existing self endpoint and keeps only tier and version", async () => {
  const previous = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url: String(url), options };
    return Response.json({ membership: { tier: "VIP", version: "4", sourceRef: "admin-secret", source: "hidden" } });
  };
  try {
    const response = await GET(request({ headers: { cookie: "zzsh_user.session_token=user; zzsh_admin.session_token=admin; other=x", "x-request-id": "req_member_1" } }));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { membership: { tier: "VIP", version: "4" } });
    assert.equal(seen.url, "http://127.0.0.1:3102/api/v1/users/me/rental-membership");
    assert.equal(seen.options.method, "GET");
    assert.equal(seen.options.headers.get("cookie"), "zzsh_user.session_token=user");
    assert.equal(seen.options.headers.get("x-request-id"), "req_member_1");
  } finally {
    globalThis.fetch = previous;
  }
});

test("membership route rejects writes, authorization headers and forwards upstream errors", async () => {
  const previous = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return Response.json({
      error: { code: "UNAUTHENTICATED", message: "login", requestId: "req_upstream_9", sourceRef: "secret-ref", details: { stack: "secret-stack" } },
      sourceRef: "outer-ref",
      debug: "trace",
    }, { status: 401 });
  };
  try {
    assert.equal((await POST()).status, 404);
    assert.equal((await GET(request({ headers: { authorization: "Bearer forbidden" } }))).status, 403);
    assert.equal(calls, 0);
    const denied = await GET(request({ headers: { "x-request-id": "req_member_err" } }));
    assert.equal(denied.status, 401);
    assert.equal(denied.headers.get("x-request-id"), "req_member_err");
    assert.deepEqual(await denied.json(), { error: { code: "UNAUTHENTICATED", message: "login", requestId: "req_upstream_9" } });
    globalThis.fetch = async () => Response.json({ error: { requestId: "not safe/id", sourceRef: "secret-ref", details: ["raw"] } }, { status: 500 });
    const bare = await GET(request({ headers: { "x-request-id": "req_member_bare" } }));
    assert.equal(bare.status, 500);
    assert.deepEqual(await bare.json(), { error: { code: "INTERNAL_ERROR", message: "会员等级暂时无法读取", requestId: "req_member_bare" } });
    globalThis.fetch = async () => { throw new Error("down"); };
    assert.equal((await GET(request())).status, 503);
  } finally {
    globalThis.fetch = previous;
  }
});
