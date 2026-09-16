import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NODE_ENV = "test";
const { GET, POST } = await import("../src/app/api/im/[...path]/route.ts");
const context = (path) => ({ params: Promise.resolve({ path }) });
const request = (path, init = {}) => new Request(`http://127.0.0.1:3100/api/im/${path.join("/")}`, {
  ...init,
  headers: { origin: "http://127.0.0.1:3100", ...init.headers },
});

test("user IM proxy forwards only the user cookie and preserves the short-lived token", async () => {
  const oldFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url: String(url), options };
    return Response.json({ accountId: "zzuopaque", token: "short-lived", expiresAt: "2026-09-15T00:10:00.000Z" });
  };
  try {
    const response = await GET(request(["token"], { headers: { cookie: "zzsh_user.session_token=user; zzsh_admin.session_token=admin" } }), context(["token"]));
    assert.equal(response.status, 200);
    assert.equal(seen.url, "http://127.0.0.1:3102/api/v1/im/user/token");
    assert.equal(seen.options.headers.get("cookie"), "zzsh_user.session_token=user");
    assert.equal((await response.json()).token, "short-lived");
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("user IM proxy rejects cross-origin and unknown paths before forwarding", async () => {
  const oldFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => { calls += 1; return Response.json({}); };
  try {
    assert.equal((await GET(request(["token"], { headers: { origin: "https://other.invalid" } }), context(["token"]))).status, 403);
    assert.equal((await GET(request(["identities"]), context(["identities"]))).status, 404);
    assert.equal(calls, 0);
  } finally {
    globalThis.fetch = oldFetch;
  }
});

test("user IM proxy forwards only the consultation intent body", async () => {
  const oldFetch = globalThis.fetch;
  let seen;
  globalThis.fetch = async (url, options) => {
    seen = { url: String(url), options };
    return Response.json({ consultation: { id: "consultation-1" } });
  };
  try {
    const response = await POST(request(["consultations"], {
      headers: { cookie: "zzsh_user.session_token=user", "content-type": "application/json", authorization: "should-not-forward" },
      body: JSON.stringify({ type: "SERVICE", subjectRef: "listing_1" }),
      method: "POST",
    }), context(["consultations"]));
    assert.equal(response.status, 403);
    assert.equal(seen, undefined);

    const forwarded = await POST(request(["consultations"], {
      headers: { cookie: "zzsh_user.session_token=user", "content-type": "application/json" },
      body: JSON.stringify({ type: "SERVICE", subjectRef: "listing_1" }),
      method: "POST",
    }), context(["consultations"]));
    assert.equal(forwarded.status, 200);
    assert.equal(seen.url, "http://127.0.0.1:3102/api/v1/im/user/consultations");
    assert.equal(seen.options.headers.get("cookie"), "zzsh_user.session_token=user");
    assert.equal(seen.options.headers.get("authorization"), null);
    assert.deepEqual(JSON.parse(seen.options.body), { type: "SERVICE", subjectRef: "listing_1" });
  } finally {
    globalThis.fetch = oldFetch;
  }
});
