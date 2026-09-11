import { strict as assert } from "node:assert";
import { test } from "node:test";

process.env.NODE_ENV = "test";
const { GET, POST } = await import("../src/app/api/auth/user/[...path]/route.ts");

const WEB_ORIGIN = "http://127.0.0.1:3100";
const routeContext = (path) => ({ params: Promise.resolve({ path }) });

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
