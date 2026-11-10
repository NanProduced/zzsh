// SYNTHETIC_COMPONENT_MODEL：调用真实用户路由；身份与域命令为内存替身。
import assert from "node:assert/strict";
import { test } from "node:test";

import * as auth from "../src/auth/user-identity";
import * as consultation from "../src/im/consultation";
import { handleYunxinRoute, type YunxinRouteOptions } from "../src/im/yunxin-routes";

const OP = "support_close_0123456789abcdef";
const USER_ORIGIN = "https://user.invalid";
const NO_BODY = Symbol("no-body");

function responseCapture() {
  const result = {
    headersSent: false,
    statusCode: 200,
    headers: new Map<string, string | string[]>(),
    body: undefined as unknown,
    setHeader(name: string, value: string | string[]) { result.headers.set(name.toLowerCase(), value); return result; },
    status(value: number) { result.statusCode = value; return result; },
    json(value: unknown) { result.body = value; result.headersSent = true; },
  };
  return result;
}

function options(withConsultation = true): YunxinRouteOptions {
  return {
    appId: "provider-test",
    security: {
      apiOrigin: "https://api.invalid",
      userOrigin: USER_ORIGIN,
      adminOrigin: "https://admin.invalid",
    },
    repository: {},
    provisioner: {},
    tokenService: {},
    ...(withConsultation ? { consultation: {} } : {}),
  } as never;
}

function request(method = "POST", body: unknown = { operationId: OP }, headers: Record<string, string> = {}) {
  const url = "/api/v1/im/user/consultations/consult_1/close";
  return {
    method,
    url,
    originalUrl: url,
    headers: { origin: USER_ORIGIN, "x-request-id": "req_route", ...headers },
    ...(body === NO_BODY ? {} : { body }),
  } as never;
}

function mockDomain(t: { mock: { method: (object: object, name: string, value: unknown) => void } }) {
  const calls: Array<Record<string, unknown>> = [];
  t.mock.method(auth, "readUserContext", async () => ({ userId: "user_a", sessionId: "session_a" }));
  t.mock.method(consultation, "closeUserConsultation", async (_options: unknown, context: unknown, id: string, operationId: string, requestId: string) => {
    calls.push({ context, id, operationId, requestId });
    return { consultation: { id } };
  });
  return calls;
}

test("POST user close forwards the stable operationId and returns the domain result", async (t) => {
  const calls = mockDomain(t);
  const response = responseCapture();
  await handleYunxinRoute(request(), response, options());
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.body, { consultation: { id: "consult_1" } });
  assert.equal(response.headers.get("x-request-id"), "req_route");
  assert.deepEqual(calls, [{
    context: { userId: "user_a", sessionId: "session_a" },
    id: "consult_1",
    operationId: OP,
    requestId: "req_route",
  }]);
});

test("user close is POST-only and rejects foreign origins", async (t) => {
  const calls = mockDomain(t);

  const get = responseCapture();
  await handleYunxinRoute(request("GET", undefined), get, options());
  assert.equal(get.statusCode, 404);

  const foreign = responseCapture();
  await handleYunxinRoute(request("POST", { operationId: OP }, { origin: "https://evil.invalid" }), foreign, options());
  assert.equal(foreign.statusCode, 403);

  assert.equal(calls.length, 0);
});

test("user close validates the body and rejects query arguments before closing", async (t) => {
  const calls = mockDomain(t);

  for (const body of [NO_BODY, null, {}, { operationId: "short" }, { operationId: OP, extra: true }]) {
    const response = responseCapture();
    await handleYunxinRoute(request("POST", body), response, options());
    assert.equal(response.statusCode, 400, JSON.stringify(body));
  }

  const query = request("POST");
  (query as { originalUrl: string }).originalUrl += "?unexpected=1";
  (query as { url: string }).url += "?unexpected=1";
  const queryResponse = responseCapture();
  await handleYunxinRoute(query, queryResponse, options());
  assert.equal(queryResponse.statusCode, 400);
  assert.equal(calls.length, 0);
});

test("user close is unavailable when the IM route assembly has no consultation config", async (t) => {
  mockDomain(t);
  const response = responseCapture();
  await handleYunxinRoute(request(), response, options(false));
  assert.equal(response.statusCode, 503);
  assert.equal((response.body as { error: { code: string } }).error.code, "IM_UNAVAILABLE");
});
