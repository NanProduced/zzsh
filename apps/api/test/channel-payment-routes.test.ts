// 离线路由/回执测试；认证与 PG 各自已有测试，此处不启动服务、不连数据库。
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { AuthSecurityOptions } from "../src/auth/auth-security";
import * as identity from "../src/auth/user-identity";
import * as order from "../src/order/order";
import * as read from "../src/order/channel-payment-read";
import * as store from "../src/order/channel-payment-store";
import * as collection from "../src/order/joinpay-collection-attempt";
import { SecurityApiError } from "../src/auth/security-core";
import { fingerprintRequest, notFound, type SupplyNodeRequest } from "../src/supply/supply-util";
import type { SupplyResponse } from "../src/supply/supply-routes";
import { channelPaymentCommandReceipt, handleChannelPaymentRoute, mountChannelPayments, type ChannelPaymentCollectionAssembly } from "../src/order/channel-payment-routes";

const ORIGIN = "https://user.example.invalid";
const raw: store.PaymentRequestView = { requestId: "payreq_1", orderId: "order_1", channel: "JOINPAY", channelOrderNo: "ZZPAY04_0001",
  amountCents: "125", wireAmountYuan: "1.25", currency: "CNY", method: "ALIPAY_NATIVE", state: "SUBMITTING", existing: false,
  evidenceLevel: "SYNTHETIC_PROTOCOL", createdAt: "2026-10-23T01:00:00.000000Z", updatedAt: "2026-10-23T01:00:00.000000Z" };

function fixture(t: TestContext) {
  const s = { status: 0, result: null as any, headers: {} as Record<string, unknown>, calls: [] as string[], commandCalls: 0,
    available: true, owned: true, active: true, commandError: null as unknown, authorizationError: null as unknown,
    commitError: null as unknown, priorEvidence: null as string | null,
    queryOverride: null as null | ((sql: string, p: unknown[]) => { rows: any[]; rowCount?: number } | undefined) };
  t.mock.method(identity, "readUserContext", async () => {
    s.calls.push("session"); if (!s.active) throw new SecurityApiError(401, "UNAUTHENTICATED", "Expired session");
    return { userId: "renter", sessionId: "session" };
  });
  t.mock.method(order, "assertReplayAuthorization", async () => {
    s.calls.push("fresh-authorization"); if (s.authorizationError) throw s.authorizationError;
  });
  t.mock.method(read, "readChannelPaymentRequest", async (_c: Parameters<typeof read.readChannelPaymentRequest>[0], input: Parameters<typeof read.readChannelPaymentRequest>[1]) => {
    assert.equal(input.actor.userId, "renter"); s.calls.push("scoped-read");
    if (!s.owned) throw notFound();
    return s.available ? { available: true, view: { contractVersion: "order-payment-request.v1", paymentAction: null } as never }
      : { available: false, reason: "SCHEMA_NOT_DEPLOYED" };
  });
  t.mock.method(store, "createPaymentRequest", async (_c: Parameters<typeof store.createPaymentRequest>[0], input: Parameters<typeof store.createPaymentRequest>[1]) => {
    s.commandCalls++; assert.equal(input.actor.userId, "renter"); assert.equal(input.orderId, "order_1");
    assert.equal(input.binding, undefined); assert.equal(input.capability, undefined);
    if (s.commandError) throw s.commandError;
    return { status: 202, body: raw, replayed: true };
  });
  const pool = { connect: async () => ({ release() {}, query: async (sql: string, p: unknown[] = []) => {
    s.calls.push(sql);
    if (sql === "COMMIT" && s.commitError) throw s.commitError;
    const overridden = s.queryOverride?.(sql, p); if (overridden) return overridden;
    if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
    if (sql.startsWith("SELECT evidence_level FROM zzsh_order.payment_request")) return { rows: s.priorEvidence ? [{ evidence_level: s.priorEvidence }] : [] };
    if (sql.includes("FROM zzsh_order.rental_order")) return { rows: s.owned && p[1] === "renter" ? [{ id: "order_1", display_no: "ZZPAY04-0001", status: "PAID", paid_at: null }] : [] };
    if (sql.includes("FROM zzsh_order.payment_confirmation")) {
      assert(sql.includes("disposition IN ('APPLIED','REVIEW_REQUIRED')"));
      return { rows: [{ confirmationId: "payment_1", disposition: "APPLIED", reasonCode: null, amountCents: "125", currency: "CNY", acceptedAt: raw.createdAt }] };
    }
    throw Error("Unexpected SQL");
  } }) };
  const response = { headersSent: false, setHeader(k: string, v: unknown) { s.headers[k] = v; return this; },
    status(code: number) { s.status = code; return this; }, json(v: unknown) { s.result = v; return this; } } as unknown as SupplyResponse;
  const security = { pool, userOrigin: ORIGIN } as unknown as AuthSecurityOptions;
  const invoke = async (patch: Partial<SupplyNodeRequest> = {}, assembly?: ChannelPaymentCollectionAssembly) => handleChannelPaymentRoute({ method: "POST", originalUrl: "/api/v1/orders/order_1/channel-payment-requests",
    headers: { origin: ORIGIN, "idempotency-key": "key_1" }, body: { method: "ALIPAY_NATIVE" }, ...patch } as SupplyNodeRequest, response, security, "/api/v1/orders", assembly);
  return { s, invoke, response, security };
}

test("POST 只映射原存储回执；重放不把当前状态/原号/签名塞进 v1", async t => {
  const f = fixture(t); await f.invoke();
  assert.equal(f.s.status, 202); assert.equal(f.s.result.contractVersion, "order-payment-request.v1");
  assert.equal(f.s.result.replay, false); assert.equal(f.s.result.request.id, "payreq_1");
  assert.deepEqual(f.s.result.request.amount, { cents: "125", currency: "CNY" });
  assert.equal(f.s.result.request.createdAt, raw.createdAt); assert.equal(f.s.result.paymentAction, null);
  assert.equal(f.s.result.channelOrderNo, undefined); assert.equal(f.s.result.hmac, undefined);
  assert.equal(f.s.commandCalls, 1); assert(f.s.calls.indexOf("fresh-authorization") < f.s.calls.indexOf("scoped-read"));
});

test("缺少旧回执元数据明确不可用，不用当前 GET 重新构造成功回执", () => {
  assert.throws(() => channelPaymentCommandReceipt({ ...raw, createdAt: undefined } as never), { code: "EVIDENCE_UNAVAILABLE" });
  assert.throws(() => channelPaymentCommandReceipt({ ...raw, evidenceLevel: "REAL_JOINPAY" }), { code: "EVIDENCE_UNAVAILABLE" });
  assert.equal(channelPaymentCommandReceipt({ ...raw, existing: true }).replay, true);
});

test("Origin、Authorization、会话、对象归属分别拒绝；重复 Origin 不取第一项放行", async t => {
  const f = fixture(t);
  for (const headers of [{ origin: "https://other.invalid" }, { origin: ORIGIN, authorization: "Bearer synthetic" }, { origin: [ORIGIN, "https://other.invalid"] }]) {
    await f.invoke({ headers }); assert.equal(f.s.status, 403);
  }
  assert.equal(f.s.calls.length, 0);
  f.s.active = false; await f.invoke(); assert.equal(f.s.status, 401);
  f.s.active = true; f.s.owned = false; await f.invoke(); assert.equal(f.s.status, 404); assert.equal(f.s.commandCalls, 0);
});

test("路径/方法/query 优先拒绝；无关路由不处理", async t => {
  const f = fixture(t);
  assert.equal(await f.invoke({ originalUrl: "/api/v1/orders/order_1/other" }), false);
  await f.invoke({ originalUrl: "/api/v1/orders/order_1/channel-payment-requests?unexpected=1" }); assert.equal(f.s.status, 404);
  await f.invoke({ method: "DELETE" }); assert.equal(f.s.status, 404);
  assert.equal(f.s.calls.length, 0);
});

test("幂等头先于 body 校验；缺失/非法/重复头全部明确拒绝", async t => {
  const f = fixture(t);
  await f.invoke({ headers: { origin: ORIGIN }, body: {} }); assert.equal(f.s.result.error.code, "MISSING_IDEMPOTENCY_KEY");
  await f.invoke({ headers: { origin: ORIGIN, "idempotency-key": "" } }); assert.equal(f.s.status, 400); assert.equal(f.s.result.error.code, "MISSING_IDEMPOTENCY_KEY");
  for (const value of ["invalid key", ["key_1", "key_2"]]) {
    await f.invoke({ headers: { origin: ORIGIN, "idempotency-key": value } }); assert.equal(f.s.status, 400); assert.equal(f.s.result.error.code, "INVALID_ARGUMENT");
  }
  assert.equal(f.s.commandCalls, 0);
});

test("body 只收 method；不接受客户端金额、订单归属或商户配置", async t => {
  const f = fixture(t);
  for (const body of [{ method: "CARD" }, { method: "ALIPAY_NATIVE", amountCents: "1" }, { method: "ALIPAY_NATIVE", userId: "other" }, { method: "ALIPAY_NATIVE", merchantNo: "other" }]) {
    await f.invoke({ body }); assert.equal(f.s.status, 400);
  }
  assert.equal(f.s.commandCalls, 0);
});

test("未部署：GET 明确不可用，首次 POST 返回能力关闭，不触及缺表或外呼", async t => {
  const f = fixture(t); f.s.available = false;
  await f.invoke(); assert.equal(f.s.status, 503); assert.equal(f.s.result.error.code, "PAYMENT_CHANNEL_NOT_ENABLED");
  assert.equal(f.s.result.error.requestId, f.s.headers["X-Request-Id"]);
  await f.invoke({ method: "GET" }); assert.equal(f.s.status, 503); assert.equal(f.s.result.error.code, "EVIDENCE_UNAVAILABLE");
  assert.equal(f.s.commandCalls, 0);
});

test("领域支付拒绝只按机器原因映射嵌套 error，不匹配文案", async t => {
  const f = fixture(t);
  for (const code of ["PAYMENT_CHANNEL_NOT_ENABLED", "PAYMENT_REQUEST_EXISTS", "ORDER_NOT_PAYABLE"]) {
    f.s.commandError = Object.assign(new SecurityApiError(code === "PAYMENT_CHANNEL_NOT_ENABLED" ? 503 : 409, "CONFLICT", "Domain refusal"), { paymentReason: code });
    await f.invoke(); assert.equal(f.s.result.error.code, code); assert.equal(f.s.result.code, undefined);
  }
});

test("JOINPAY 装配下旧 POST 明确升级要求；旧 GET 维持本地事实形状", async t => {
  const f = fixture(t), url = "/api/v1/orders/order_1/payment-requests";
  await f.invoke({ originalUrl: url }); assert.equal(f.s.status, 409); assert.equal(f.s.result.error.code, "PAYMENT_CLIENT_UPGRADE_REQUIRED");
  await f.invoke({ method: "GET", originalUrl: url }); assert.equal(f.s.status, 200);
  assert.deepEqual(Object.keys(f.s.result), ["order", "payment"]); assert.equal(f.s.result.payment.disposition, "APPLIED");
  assert.equal(f.s.result.paymentAction, undefined); assert.equal(f.s.commandCalls, 0);
  f.s.owned = false; await f.invoke({ originalUrl: url }); assert.equal(f.s.status, 404);
});

test("BFF 同一 handler 返回相同语言无关 v1；普通 GET 不调用命令", async t => {
  const f = fixture(t);
  await handleChannelPaymentRoute({ method: "GET", originalUrl: "/api/bff/user/orders/order_1/channel-payment-requests", headers: { origin: ORIGIN } } as SupplyNodeRequest,
    f.response, f.security, "/api/bff/user/orders");
  assert.equal(f.s.status, 200); assert.equal(f.s.result.contractVersion, "order-payment-request.v1"); assert.equal(f.s.commandCalls, 0);
});

const candidate: store.PaymentRequestView = { ...raw, evidenceLevel: "JOINPAY_CANDIDATE" };
// Opaque server configuration for route spies only; these objects are never admitted by the real profile/source gate.
function collectionAssembly(): ChannelPaymentCollectionAssembly {
  return { initial: { profile: {} as never, wire: { tradeMerchantNo: "route_fixture", productName: "route fixture", notifyUrl: "https://merchant.example.invalid/notify" }, admission: {} as never },
    execution: { profileFor() { throw Error("Unexpected profile access"); }, keyFor() { throw Error("Unexpected key access"); } } };
}

test("G2 原创建回执仅称候选，状态/金额/时间来自原回执，不伪装正式付款", () => {
  const receipt = channelPaymentCommandReceipt(candidate);
  assert.equal(receipt.dataOrigin, "JOINPAY_CANDIDATE");
  assert.equal(receipt.request.state, "SUBMITTING"); assert.equal(receipt.request.amount.cents, "125");
  assert.equal(receipt.request.createdAt, raw.createdAt); assert.equal(receipt.payment, null); assert.equal(receipt.paymentAction, null);
});

test("G2 会话/新鲜授权/对象检查失败时，当前能力和动作均不读取", async t => {
  const f = fixture(t); let configurationReads = 0, commands = 0, executions = 0;
  const assembly = Object.defineProperty({}, "initial", { get() { configurationReads++; throw Error("Capability must follow authorization"); } }) as ChannelPaymentCollectionAssembly;
  t.mock.method(collection, "createJoinpayCollectionRequestInTransaction", async () => { commands++; throw Error("Unexpected command"); });
  t.mock.method(collection, "executeJoinpayCollectionAttempt", async () => { executions++; return { kind: "SKIPPED" as const }; });
  f.s.active = false; await f.invoke({}, assembly); assert.equal(f.s.status, 401);
  f.s.active = true; f.s.authorizationError = new SecurityApiError(403, "FORBIDDEN", "Authorization revoked");
  await f.invoke({}, assembly); assert.equal(f.s.status, 403);
  f.s.authorizationError = null; f.s.owned = false; await f.invoke({}, assembly); assert.equal(f.s.status, 404);
  assert.equal(configurationReads, 0); assert.equal(commands, 0); assert.equal(executions, 0);
});

test("G2 真实原键重放先核归属，当前能力缺失或订单已不可付款均不阻断；异体仍409", async t => {
  const f = fixture(t); f.s.priorEvidence = "JOINPAY_CANDIDATE";
  let owner = "renter", ownershipChecks = 0, payableChecks = 0, configurationReads = 0;
  const assembly = Object.defineProperties({}, {
    initial: { get() { configurationReads++; throw Error("No current initial configuration"); } },
    execution: { get() { configurationReads++; throw Error("Replay must not execute"); } },
  }) as ChannelPaymentCollectionAssembly;
  f.s.queryOverride = (sql) => {
    if (sql.startsWith("SELECT pg_advisory_xact_lock")) return { rows: [] };
    if (sql.includes('FROM "zzsh_supply"."idempotency_record"')) return { rows: [{
      requestFingerprint: fingerprintRequest("order.payment.channel-request", "order_1", { method: "ALIPAY_NATIVE" }),
      responseStatus: 202, responseBody: candidate, publishRequired: false,
    }] };
    if (sql.startsWith("SELECT renter_user_id")) { ownershipChecks++; return { rows: [{ renter_user_id: owner }] }; }
    if (sql.startsWith("SELECT request_id,to_jsonb")) return { rows: [{ request_id: candidate.requestId, formal_admission_ref: "original_admission", formal_admission_sha256: "1".repeat(64) }] };
    if (sql.includes("FOR UPDATE OF o") || sql.includes("hold_until")) { payableChecks++; throw Error("Replayed order is no longer payable"); }
    return undefined;
  };
  // No create-command mock: exercise the actual collection store and shared withIdempotency replay.
  await f.invoke({}, assembly); assert.equal(f.s.status, 202);
  assert.deepEqual(structuredClone(f.s.result), channelPaymentCommandReceipt(candidate)); assert.equal(ownershipChecks, 1);
  assert(f.s.calls.indexOf("fresh-authorization") < f.s.calls.findIndex(sql => sql.includes('FROM "zzsh_supply"."idempotency_record"')));
  await f.invoke({ body: { method: "WEIXIN_NATIVE" } }, assembly); assert.equal(f.s.status, 409);
  assert.equal(f.s.result.error.code, "IDEMPOTENCY_KEY_REUSED");
  owner = "another_renter"; await f.invoke({}, assembly); assert.equal(f.s.status, 404);
  assert.equal(ownershipChecks, 3); assert.equal(payableChecks, 0); assert.equal(configurationReads, 0); assert.equal(f.s.commandCalls, 0);
});

test("G2 首次事务确认COMMIT后只执行一次；mount把同装配传给BFF，原键重放不再次执行", async t => {
  const f = fixture(t), assembly = collectionAssembly(); let commands = 0, executions = 0;
  t.mock.method(collection, "createJoinpayCollectionRequestInTransaction", async (_client: Parameters<typeof collection.createJoinpayCollectionRequestInTransaction>[0], input: collection.JoinpayCollectionRequestInput) => {
    commands++; f.s.calls.push("collection-create");
    if (f.s.priorEvidence) { assert.equal(input.profile, undefined); return { replayed: true, status: 202, request: candidate }; }
    assert.equal(input.profile, assembly.initial!.profile); assert.equal(input.admission, assembly.initial!.admission);
    return { replayed: false, status: 202, request: candidate };
  });
  t.mock.method(collection, "executeJoinpayCollectionAttempt", async (options: Parameters<typeof collection.executeJoinpayCollectionAttempt>[0], input: Parameters<typeof collection.executeJoinpayCollectionAttempt>[1]) => {
    executions++; assert.equal(options.pool, f.security.pool); assert.equal(input.requestId, candidate.requestId);
    assert.match(input.workerId, /^payhttp_[0-9a-f]{32}$/); assert.equal(f.s.result, null);
    assert.equal(f.s.calls.at(-1), "COMMIT"); f.s.calls.push("collection-execute"); return { kind: "SKIPPED" as const };
  });
  const mounted = new Map<string, (request: SupplyNodeRequest, response: SupplyResponse, next: () => void) => Promise<void>>();
  const app = { getHttpAdapter: () => ({ getInstance: () => ({ use: (prefix: string, handler: (request: SupplyNodeRequest, response: SupplyResponse, next: () => void) => Promise<void>) => mounted.set(prefix, handler) }) }) } as unknown as Parameters<typeof mountChannelPayments>[0];
  mountChannelPayments(app, f.security, assembly);
  await mounted.get("/api/bff/user/orders")!({ method: "POST", originalUrl: "/api/bff/user/orders/order_1/channel-payment-requests",
    headers: { origin: ORIGIN, "idempotency-key": "key_1" }, body: { method: "ALIPAY_NATIVE" } } as SupplyNodeRequest, f.response, () => assert.fail("Matched BFF route must not fall through"));
  assert.equal(f.s.status, 202); assert.equal(commands, 1); assert.equal(executions, 1);
  const originalReceipt = structuredClone(f.s.result); f.s.priorEvidence = "JOINPAY_CANDIDATE";
  await f.invoke(); assert.equal(f.s.status, 202); assert.equal(commands, 2); assert.equal(executions, 1);
  assert.deepEqual(f.s.result, originalReceipt);
});

test("G2 创建COMMIT失败只回失败并收尾，绝不调用执行器", async t => {
  const f = fixture(t); let executions = 0;
  f.s.commitError = Object.assign(Error("Synthetic commit response lost"), { code: "ECONNRESET" });
  t.mock.method(collection, "createJoinpayCollectionRequestInTransaction", async () => ({ replayed: false, status: 202, request: candidate }));
  t.mock.method(collection, "executeJoinpayCollectionAttempt", async () => { executions++; return { kind: "SKIPPED" as const }; });
  await f.invoke({}, collectionAssembly()); assert.equal(f.s.status, 500); assert.equal(executions, 0);
  assert(f.s.calls.includes("COMMIT")); assert(f.s.calls.includes("ROLLBACK")); assert.equal(f.s.result.request, undefined);
});

test("G2 schema缺失时null结果安全503，零创建、零执行、零当前配置读取", async t => {
  const f = fixture(t); f.s.available = false; let commands = 0, executions = 0, configurationReads = 0;
  const assembly = Object.defineProperty({}, "initial", { get() { configurationReads++; throw Error("Schema missing"); } }) as ChannelPaymentCollectionAssembly;
  t.mock.method(collection, "createJoinpayCollectionRequestInTransaction", async () => { commands++; throw Error("Unexpected command"); });
  t.mock.method(collection, "executeJoinpayCollectionAttempt", async () => { executions++; return { kind: "SKIPPED" as const }; });
  await f.invoke({}, assembly); assert.equal(f.s.status, 503); assert.equal(f.s.result.error.code, "PAYMENT_CHANNEL_NOT_ENABLED");
  assert.equal(commands, 0); assert.equal(executions, 0); assert.equal(configurationReads, 0);
});

test("G2 执行后状态/金额变化以及执行UNKNOWN都不改已提交的原始创建回执", async t => {
  const f = fixture(t), mutable = { ...candidate }; let executions = 0;
  t.mock.method(collection, "createJoinpayCollectionRequestInTransaction", async () => ({ replayed: false, status: 202, request: mutable }));
  t.mock.method(collection, "executeJoinpayCollectionAttempt", async () => {
    executions++; assert.equal(f.s.calls.at(-1), "COMMIT");
    mutable.state = "ACCEPTED"; mutable.amountCents = "99999"; mutable.updatedAt = "2026-10-24T00:00:00.000000Z";
    throw Object.assign(Error("Synthetic execution commit response lost"), { code: "PAYMENT_EXECUTION_UNKNOWN" });
  });
  await f.invoke({}, collectionAssembly()); assert.equal(f.s.status, 202); assert.equal(executions, 1);
  assert.deepEqual(f.s.result, channelPaymentCommandReceipt(candidate));
});

test("默认四参仍走既有存储，CONTROLLED原回执不会转成正式JOINPAY或调用执行器", async t => {
  const f = fixture(t); let collectionCommands = 0, executions = 0;
  t.mock.method(store, "createPaymentRequest", async () => ({ replayed: true, status: 202, body: { ...raw, channel: "CONTROLLED", evidenceLevel: "CONTROLLED_TEST" } }));
  t.mock.method(collection, "createJoinpayCollectionRequestInTransaction", async () => { collectionCommands++; throw Error("Unexpected collection command"); });
  t.mock.method(collection, "executeJoinpayCollectionAttempt", async () => { executions++; return { kind: "SKIPPED" as const }; });
  await handleChannelPaymentRoute({ method: "POST", originalUrl: "/api/v1/orders/order_1/channel-payment-requests",
    headers: { origin: ORIGIN, "idempotency-key": "key_1" }, body: { method: "ALIPAY_NATIVE" } } as SupplyNodeRequest, f.response, f.security, "/api/v1/orders");
  assert.equal(f.s.status, 202); assert.equal(f.s.result.dataOrigin, "LOCAL_CONTROLLED");
  assert.equal(f.s.result.payment, null); assert.equal(collectionCommands, 0); assert.equal(executions, 0);
});
