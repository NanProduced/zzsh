import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.NODE_ENV = "test";
const { GET, POST } = await import("../src/app/api/auth/user/[...path]/route.ts");

const WEB_ORIGIN = "http://127.0.0.1:3100";
const routeContext = (path) => ({ params: Promise.resolve({ path }) });

test("username/email and legacy SDK change bypasses are rejected by the BFF without forwarding", async () => {
  const original = globalThis.fetch; let calls = 0;
  globalThis.fetch = async () => { calls++; return Response.json({ status: true }); };
  try {
    for (const path of [["sign-in", "username"], ["sign-in", "email"], ["sign-up", "email"], ["phone-number", "verify"], ["phone-number", "reset-password"]]) {
      assert.equal((await POST(request(path, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), routeContext(path))).status, 404);
    }
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; }
});

test("an accepted upstream write with an unreadable body keeps its filtered user Cookie and accepted fact", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error("lost body")); } }), { status: 200, headers: { "set-cookie": "zzsh_user.session_token=fixture; HttpOnly; Path=/", "content-type": "application/json" } });
  try {
    const path = ["security", "password"];
    const response = await POST(request(path, { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), routeContext(path));
    assert.equal(response.status, 502); assert.equal((await response.json()).error.accepted, true);
    assert.ok(response.headers.getSetCookie().some(value => value.startsWith("zzsh_user.session_token=")));
  } finally { globalThis.fetch = original; }
});

function request(path, init = {}) {
  return new Request(`http://localhost/api/auth/user/${path.join("/")}`, {
    ...init,
    headers: { origin: WEB_ORIGIN, ...init.headers },
  });
}

async function readError(response) {
  return response.json();
}

test("identity security paths reject method mismatches before BFF forwarding", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return Response.json({ ok: true });
  };
  try {
    const postStatus = await POST(request(["identity", "status"], { method: "POST", body: "{}", headers: { "content-type": "application/json" } }), routeContext(["identity", "status"]));
    const getCancel = await GET(request(["account", "cancel"]), routeContext(["account", "cancel"]));
    assert.equal(postStatus.status, 404);
    assert.equal(getCancel.status, 404);
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("chunked request bodies are bounded and cancelled without Content-Length", async () => {
  const originalFetch = globalThis.fetch;
  let upstreamCalls = 0;
  let cancelled = false;
  globalThis.fetch = async () => {
    upstreamCalls += 1;
    return Response.json({ ok: true });
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(64 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  try {
    const input = request(["identity", "verify"], {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      duplex: "half",
    });
    assert.equal(input.headers.get("content-length"), null);
    const response = await POST(input, routeContext(["identity", "verify"]));
    assert.equal(response.status, 413);
    assert.equal((await readError(response)).error.code, "INVALID_ARGUMENT");
    assert.equal(cancelled, true);
    assert.equal(upstreamCalls, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a false small Content-Length cannot bypass the stream limit", async () => {
  const originalFetch = globalThis.fetch;
  let cancelled = false;
  globalThis.fetch = async () => Response.json({ ok: true });
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(64 * 1024 + 1));
    },
    cancel() {
      cancelled = true;
    },
  });
  try {
    const response = await POST(request(["identity", "verify"], {
      method: "POST",
      headers: { "content-type": "application/json", "content-length": "1" },
      body,
      duplex: "half",
    }), routeContext(["identity", "verify"]));
    assert.equal(response.status, 413);
    assert.equal(cancelled, true);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a slow upstream response body becomes a controlled 502", async () => {
  const originalFetch = globalThis.fetch;
  const originalTimeout = AbortSignal.timeout;
  globalThis.fetch = async (_input, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'));
      init.signal.addEventListener("abort", () => controller.error(new Error("upstream body timeout")), { once: true });
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
  Object.defineProperty(AbortSignal, "timeout", {
    configurable: true,
    value: () => {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 5);
      return controller.signal;
    },
  });
  try {
    const response = await GET(request(["identity", "status"]), routeContext(["identity", "status"]));
    assert.equal(response.status, 502);
    assert.equal((await readError(response)).error.code, "INTERNAL_ERROR");
  } finally {
    globalThis.fetch = originalFetch;
    Object.defineProperty(AbortSignal, "timeout", { configurable: true, value: originalTimeout });
  }
});

test("an upstream response stream reset becomes a controlled 502", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"partial":'));
      controller.error(new Error("upstream reset"));
    },
  }), { status: 200, headers: { "content-type": "application/json" } });
  try {
    const response = await GET(request(["identity", "status"]), routeContext(["identity", "status"]));
    assert.equal(response.status, 502);
    assert.equal((await readError(response)).error.code, "INTERNAL_ERROR");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("浏览器 User-Agent 有界转发：缺失不伪造、超长截断、其余请求头不转发", async () => {
  const original = globalThis.fetch;
  let seen = null;
  globalThis.fetch = async (_url, init) => { seen = new Headers(init.headers); return Response.json({ status: true }); };
  try {
    await GET(request(["get-session"], { headers: { "user-agent": "Mozilla/5.0 (Test)", "x-custom": "should-not-forward" } }), routeContext(["get-session"]));
    assert.equal(seen.get("User-Agent"), "Mozilla/5.0 (Test)", "有值时有界转发（客户端自报）");
    assert.equal(seen.get("Origin"), WEB_ORIGIN);
    assert.equal(seen.get("x-custom"), null, "不转发其余请求头");
    assert.ok(seen.get("Cookie") === null || !seen.get("Cookie").includes("should-not-forward"));

    const long = "ua-" + "x".repeat(600);
    await GET(request(["get-session"], { headers: { "user-agent": long } }), routeContext(["get-session"]));
    assert.equal(seen.get("User-Agent").length, 512, "超长截断到 512");

    seen = null;
    await GET(request(["get-session"]), routeContext(["get-session"]));
    assert.equal(seen.get("User-Agent"), null, "缺失时不伪造 UA");
  } finally { globalThis.fetch = original; }
});


test("Root R1: captcha GET validates and forwards only one allowed action", async () => {
  const original = globalThis.fetch; const calls = [];
  globalThis.fetch = async (input, init) => { calls.push({ url: new URL(input), init }); return Response.json({ provider: "local-pow", schema: 1, challenge: { parameters: { data: "user:sign-in" } } }); };
  try {
    for (const action of ["sign-in", "sms-send"]) {
      const response = await GET(new Request("http://localhost/api/auth/user/security/captcha/challenge?action=" + action + "&ignored=not-forwarded", { headers: { "x-zzsh-user-client-ip": "203.0.113.9" } }), routeContext(["security", "captcha", "challenge"]));
      assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
      assert.equal(calls.at(-1).url.pathname, "/api/auth/user/security/captcha/challenge");
      assert.equal(calls.at(-1).url.search, "?action=" + action);
      assert.equal(calls.at(-1).init.cache, "no-store");
      assert.notEqual(new Headers(calls.at(-1).init.headers).get("x-zzsh-user-client-ip"), "203.0.113.9");
    }
    const before = calls.length;
    for (const query of ["", "?action=", "?action=other", "?action=sign-in&action=sms-send", "?action=sign-in&action=sign-in"]) {
      const response = await GET(new Request("http://localhost/api/auth/user/security/captcha/challenge" + query), routeContext(["security", "captcha", "challenge"]));
      assert.equal(response.status, 400); assert.equal((await response.json()).error.code, "INVALID_ARGUMENT");
      assert.equal(response.headers.get("cache-control"), "no-store");
    }
    assert.equal(calls.length, before, "invalid or duplicate actions never contact upstream");
    await GET(new Request("http://localhost/api/auth/user/get-session?action=sms-send&ignored=1"), routeContext(["get-session"]));
    assert.equal(calls.at(-1).url.search, "", "unrelated query forwarding stays unchanged");
  } finally { globalThis.fetch = original; }
});
