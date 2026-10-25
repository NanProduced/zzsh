import assert from "node:assert/strict";
import { test } from "node:test";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import type { Pool } from "pg";
import { bindJoinpayAccountProfile, type JoinpayAccountOperation, type JoinpayAccountServerProfile } from "../src/finance/joinpay-account";
import * as store from "../src/finance/joinpay-account-store";
import { observeJoinpayAccountBatch, JoinpayAccountObservationLifecycle, type JoinpayAccountObservationOptions } from "../src/finance/joinpay-account-observer";

// SYNTHETIC_COMPONENT_ONLY：无socket、无商户API；mock存储只验证调度和关闭控制。
function profile(operation: JoinpayAccountOperation, changes: Partial<JoinpayAccountServerProfile> = {}) {
  return bindJoinpayAccountProfile({ purpose: "MERCHANT_READ", resourceDatabase: "observer_fixture", resourceRuntimeUser: "observer_r", operation,
    profileId: "fixture_" + operation, merchantIdentityId: "fixture_merchant", userNo: "999900000000005", keyVersionRef: "fixture_key",
    reviewRef: "SYNTHETIC_NOT_OFFICIAL", reviewSha256: "b".repeat(64), permission: "REVIEWED_MERCHANT_BALANCE_READ", knownAnswer: "NOT_OBTAINED",
    rules: { dataEncoding: "OBJECT", statusCodeToken: "NUMBER", amountToken: "NUMBER", currencyToken: "NUMBER", numericSigning: "RAW_JSON_TOKEN",
      optionalSigning: "ABSENT_EMPTY_NULL_EQUIVALENT", unknownFields: "REJECT", amount: { unit: "UNKNOWN" } }, ...changes });
}
function fixture(): JoinpayAccountObservationOptions {
  return { pool: { connect() { throw Error("component must not open socket"); } } as unknown as Pool,
    profiles: [profile("AVAILABLE"), profile("COLLECTION")], dependencies: { keyFor: () => { throw Error("component must not read key"); } }, intervalSeconds: 60 };
}
const flush = () => new Promise<void>(resolve => setImmediate(resolve));
const result = (operation: JoinpayAccountOperation = "AVAILABLE") => ({ integration: "INTEGRATED" as const,
  result: { attemptId: "unit_observation", operation, decision: "UNKNOWN" as const, evidenceLevel: "SYNTHETIC_PROTOCOL" as const }, recordedAt: "2026-10-25T00:00:00Z" });

test("无配置不派任务，配置错误及不同商户/操作在调用存储前拒绝", async () => {
  const life = new JoinpayAccountObservationLifecycle(); life.onApplicationBootstrap(); assert.deepEqual(life.status(), { stopped: true, failure: null }); await life.beforeApplicationShutdown();
  for (const o of [{ ...fixture(), intervalSeconds: 59 }, { ...fixture(), profiles: [] }]) assert.throws(() => new JoinpayAccountObservationLifecycle().start(o), /ACCOUNT_OBSERVER_OPTIONS_INVALID/);
  for (const changes of [{ merchantIdentityId: "another" }, { userNo: "999900000000006" }, { resourceDatabase: "other_db" }, { resourceRuntimeUser: "other_r" }])
    await assert.rejects(observeJoinpayAccountBatch({ ...fixture(), profiles: [profile("AVAILABLE"), profile("COLLECTION", changes)] }), /ACCOUNT_OBSERVER_SCOPE_MISMATCH/);
  await assert.rejects(observeJoinpayAccountBatch({ ...fixture(), profiles: [profile("AVAILABLE"), profile("AVAILABLE")] }), /ACCOUNT_OBSERVER_SCOPE_MISMATCH/);
  await assert.rejects(observeJoinpayAccountBatch({ ...fixture(), profiles: [profile("AVAILABLE", { purpose: "SYNTHETIC_PROTOCOL" })] }), /SYNTHETIC_NETWORK_FORBIDDEN/);
});
test("每轮只逐个执行配置操作，使用独立系统requestId，不生成管理员session", async t => {
  const calls: string[] = [], ids: string[] = [];
  t.mock.method(store, "refreshJoinpayAccountBySystem", async (...[_pool, _profile, deps, requestId]: Parameters<typeof store.refreshJoinpayAccountBySystem>) => {
    const op = calls.length === 0 ? "AVAILABLE" : "COLLECTION"; calls.push(op); ids.push(requestId); assert(deps.signal === undefined); return result(op);
  });
  assert.deepEqual(await observeJoinpayAccountBatch(fixture()), { recorded: 2 }); assert.deepEqual(calls, ["AVAILABLE", "COLLECTION"]); assert.equal(new Set(ids).size, 2);
});
test("schema缺失即停，不读取下一账户，也不补0", async t => {
  let calls = 0; t.mock.method(store, "refreshJoinpayAccountBySystem", async () => { calls++; return { integration: "NOT_INTEGRATED" as const, result: null }; });
  await assert.rejects(observeJoinpayAccountBatch(fixture()), /ACCOUNT_SCHEMA_NOT_DEPLOYED/); assert.equal(calls, 1);
});
test("等Nest启动才派发；一次任务不重叠，关闭等待在途并禁止下一账户", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let calls = 0, finish!: () => void;
  t.mock.method(store, "refreshJoinpayAccountBySystem", async () => { calls++; await new Promise<void>(resolve => { finish = resolve; }); return result(); });
  const life = new JoinpayAccountObservationLifecycle(); life.start(fixture()); t.mock.timers.tick(0); await flush(); assert.equal(calls, 0);
  life.onApplicationBootstrap(); t.mock.timers.tick(0); await flush(); assert.equal(calls, 1); t.mock.timers.tick(120000); await flush(); assert.equal(calls, 1);
  let closed = false; const stopping = life.beforeApplicationShutdown().then(() => { closed = true; }); await flush(); assert.equal(closed, false);
  finish(); await stopping; t.mock.timers.tick(120000); await flush(); assert.equal(calls, 1); assert.equal(life.status().stopped, true);
  assert.throws(() => life.start(fixture()), /ALREADY_STARTED/);
});
test("渠道未知可保留观察后按配置再查；不立即重试", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let calls = 0;
  t.mock.method(store, "refreshJoinpayAccountBySystem", async () => { calls++; return result(); });
  const life = new JoinpayAccountObservationLifecycle(); life.start({ ...fixture(), profiles: [profile("AVAILABLE")] }); life.onApplicationBootstrap();
  t.mock.timers.tick(0); await flush(); assert.equal(calls, 1); t.mock.timers.tick(59999); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(1); await flush(); assert.equal(calls, 2); assert.equal(life.status().failure, null); await life.beforeApplicationShutdown();
});
test("观察COMMIT未知保留attempt并停刷新；不靠下一次查询代替原事务恢复", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let calls = 0;
  t.mock.method(store, "refreshJoinpayAccountBySystem", async () => { calls++; throw new store.AccountObservationWriteError("ACCOUNT_OBSERVATION_COMMIT_UNKNOWN", "unit_original_attempt", result().result); });
  const life = new JoinpayAccountObservationLifecycle(); life.start(fixture()); life.onApplicationBootstrap(); t.mock.timers.tick(0); await flush();
  assert.deepEqual(life.status(), { stopped: true, failure: { code: "ACCOUNT_OBSERVATION_COMMIT_UNKNOWN", attemptId: "unit_original_attempt" } });
  t.mock.timers.tick(120000); await flush(); assert.equal(calls, 1); await life.beforeApplicationShutdown();
});
test("未知异常只保留固定错误码，不记录私有文本", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); t.mock.method(store, "refreshJoinpayAccountBySystem", async () => { throw Error("PRIVATE_KEY_PATH_AND_VALUE"); });
  const life = new JoinpayAccountObservationLifecycle(); life.start(fixture()); life.onApplicationBootstrap(); t.mock.timers.tick(0); await flush();
  assert.deepEqual(life.status().failure, { code: "ACCOUNT_OBSERVER_FAILED" }); assert(!JSON.stringify(life.status()).includes("PRIVATE")); await life.beforeApplicationShutdown();
});
test("真实Nest组件关闭先排空账户任务，后结束原池；组件无外部连接", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); let finish!: () => void, poolClosed = false;
  t.mock.method(store, "refreshJoinpayAccountBySystem", async () => { await new Promise<void>(resolve => { finish = resolve; }); return result(); });
  class PoolCloser { onApplicationShutdown() { poolClosed = true; } }
  @Module({ providers: [JoinpayAccountObservationLifecycle, PoolCloser] }) class Component {}
  const app = await NestFactory.createApplicationContext(Component, { logger: false });
  try {
    const life = app.get(JoinpayAccountObservationLifecycle); life.start(fixture()); t.mock.timers.tick(0); await flush();
    let closed = false; const closing = app.close().then(() => { closed = true; }); await flush(); assert.equal(poolClosed, false); assert.equal(closed, false);
    finish(); await closing; assert.equal(poolClosed, true);
  } finally { if (!poolClosed) await app.close(); }
});
