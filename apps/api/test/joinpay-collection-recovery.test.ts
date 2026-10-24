// SYNTHETIC_COMPONENT_MODEL：编排/时钟/身份替身，不代表真实PG、渠道或并发验收。
import { test, type TestContext } from "node:test";
import assert from "node:assert/strict";
import type { Pool } from "pg";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import * as attempts from "../src/order/joinpay-collection-attempt";
import * as profiles from "../src/order/joinpay-collection-profile";
import { JoinpayCollectionRecoveryLifecycle, recoverJoinpayCollectionBatch, startJoinpayCollectionRecovery } from "../src/order/joinpay-collection-recovery";

const unexpected = (): never => { throw Error("UNEXPECTED_IO"); };
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve(); };
type Row = { request_id: string; state: string; observation_id: string | null };
function fixture(t: TestContext, rows: Row[] = []) {
  const view = { reference: "component_admission", sha256: "1".repeat(64), canonical: JSON.stringify({ acceptedProfiles: [{ operation: "SUBMIT" }, { operation: "QUERY" }, { operation: "NOTIFY" }], acceptedInitialAdmissions: [{ reference: "previous_admission", sha256: "2".repeat(64) }] }),
    appId: "component_app", database: "component_database", runtimeUser: "component_runtime", merchantIdentityId: "component_merchant", wireMerchantNo: "888000000000001" };
  t.mock.method(profiles, "readFormalCollectionAdmission", () => view);
  const trace: { sql: string; values?: readonly unknown[] }[] = []; let releases = 0, connects = 0, identity = true;
  const pool = { connect: async () => { connects++; return { query: async (sql: string, values?: readonly unknown[]) => {
    trace.push({ sql, values }); return { rows: sql.startsWith("SELECT current_database()")
      ? [{ db: identity ? view.database : "other_database", actor: view.runtimeUser }] : rows };
  }, release: () => { releases++; } }; } } as unknown as Pool;
  const options = { execution: { pool, formal: { admission: {} as profiles.FormalCollectionAdmission, profileFor: unexpected, keyFor: unexpected },
    profileFor: unexpected, keyFor: unexpected, fetch: async () => unexpected() }, workerId: "component_worker", batchLimit: 3, minimumIntervalSeconds: 60 };
  return { options, view, trace, releases: () => releases, connects: () => connects, mismatch: () => { identity = false; } };
}

test("无正式品牌即拒绝，参数非法不连接也不启动定时器", async t => {
  const options = { execution: { pool: { connect: unexpected } as unknown as Pool, formal: { admission: {} as profiles.FormalCollectionAdmission, profileFor: unexpected, keyFor: unexpected },
    profileFor: unexpected, keyFor: unexpected }, workerId: "worker", batchLimit: 1, minimumIntervalSeconds: 60 };
  await assert.rejects(recoverJoinpayCollectionBatch(options), { code: "COLLECTION_FORMAL_ADMISSION_NOT_BOUND" });
  assert.throws(() => startJoinpayCollectionRecovery(options), { code: "COLLECTION_FORMAL_ADMISSION_NOT_BOUND" });
  const f = fixture(t);
  for (const patch of [{ batchLimit: 0 }, { batchLimit: 11 }, { batchLimit: NaN }, { minimumIntervalSeconds: 29 }, { minimumIntervalSeconds: 86401 }, { workerId: "bad worker" }]) {
    await assert.rejects(recoverJoinpayCollectionBatch({ ...f.options, ...patch }), { message: "COLLECTION_RECOVERY_OPTIONS_INVALID" });
    assert.throws(() => startJoinpayCollectionRecovery({ ...f.options, ...patch }), { message: "COLLECTION_RECOVERY_OPTIONS_INVALID" });
  }
  assert.equal(f.connects(), 0);
});

test("先核真实连接身份；资源不符不扫描，连接必释放", async t => {
  const f = fixture(t); f.mismatch();
  await assert.rejects(recoverJoinpayCollectionBatch(f.options), { message: "COLLECTION_RECOVERY_RESOURCE_MISMATCH" });
  assert.equal(f.trace.length, 1); assert.equal(f.releases(), 1);
});

test("批量限定稳定商户和已接受准入，释放扫描连接后顺序查原号/接纳，不持扫描锁外呼", async t => {
  const f = fixture(t, [{ request_id: "payreq_one", state: "UNKNOWN", observation_id: null },
    { request_id: "payreq_two", state: "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE", observation_id: "jpobs_two" },
    { request_id: "payreq_three", state: "ACTION_READY", observation_id: null }]);
  const calls: string[] = [];
  t.mock.method(attempts, "executeJoinpayCollectionAttempt", async (...[_options, input]: Parameters<typeof attempts.executeJoinpayCollectionAttempt>) => {
    assert.equal(f.releases(), 1); assert.equal(input.recoveryMinimumIntervalSeconds, 60); assert.equal(input.allowFirstDispatch, true); calls.push(input.requestId);
    return (input.requestId === "payreq_three" ? { kind: "SKIPPED" } : { kind: "OBSERVED", operation: "QUERY", observation: {} }) as never;
  });
  t.mock.method(attempts, "acceptJoinpayCollectionEvidence", async (...[_pool, _source, input]: Parameters<typeof attempts.acceptJoinpayCollectionEvidence>) => {
    if (input.operation !== "QUERY") assert.fail("recovery must use persisted query evidence");
    assert.equal(f.releases(), 1); assert.deepEqual(input, { operation: "QUERY", requestId: "payreq_two", observationId: "jpobs_two" });
    calls.push("accept:" + input.requestId); return {} as never;
  });
  assert.deepEqual(await recoverJoinpayCollectionBatch(f.options), { selected: 3, firstDispatched: 0, queried: 1, acceptanceRecovered: 1, skipped: 1 });
  assert.deepEqual(calls, ["payreq_one", "accept:payreq_two", "payreq_three"]);
  const scan = f.trace[1]!; assert.equal(scan.values![0], f.view.merchantIdentityId); assert.equal(scan.values![1], f.view.wireMerchantNo);
  assert.deepEqual(JSON.parse(scan.values![2] as string), [{ reference: f.view.reference, sha256: f.view.sha256 }, { reference: "previous_admission", sha256: "2".repeat(64) }]);
  assert.equal(scan.values![4], 60); assert.equal(scan.values![5], 3); assert.equal(scan.values![6], 10);
});

test("首次派发单独计数，只交已持久请求给原执行器，不创建另一张订单", async t => {
  const f = fixture(t, [{ request_id: "payreq_first", state: "SUBMITTING", observation_id: null }]);
  t.mock.method(attempts, "executeJoinpayCollectionAttempt", async (...[_options, input]: Parameters<typeof attempts.executeJoinpayCollectionAttempt>) => {
    assert.equal(input.requestId, "payreq_first"); assert.equal(input.allowFirstDispatch, true);
    return { kind: "OBSERVED", operation: "SUBMIT", observation: {} } as never;
  });
  assert.deepEqual(await recoverJoinpayCollectionBatch(f.options), { selected: 1, firstDispatched: 1, queried: 0, acceptanceRecovered: 0, skipped: 0 });
});

test("仅查单/通知准入过滤未首次派发原单，并以allowFirstDispatch=false调用原执行器", async t => {
  const f = fixture(t, [{ request_id: "payreq_existing", state: "UNKNOWN", observation_id: null }]);
  const canonical = JSON.parse(f.view.canonical); canonical.acceptedProfiles = [{ operation: "QUERY" }, { operation: "NOTIFY" }];
  f.view.canonical = JSON.stringify(canonical);
  t.mock.method(attempts, "executeJoinpayCollectionAttempt", async (...[_options, input]: Parameters<typeof attempts.executeJoinpayCollectionAttempt>) => {
    assert.equal(input.allowFirstDispatch, false); return { kind: "OBSERVED", operation: "QUERY", observation: {} } as never;
  });
  assert.deepEqual(await recoverJoinpayCollectionBatch(f.options), { selected: 1, firstDispatched: 0, queried: 1, acceptanceRecovered: 0, skipped: 0 });
  assert.equal(f.trace[1]!.values!.at(-1), false); assert.match(f.trace[1]!.sql, /\$8::boolean/);
});

test("查单型准入即使执行替身误回SUBMIT也拒绝，不把首次派发记成恢复通过", async t => {
  const f = fixture(t, [{ request_id: "payreq_existing", state: "SUBMITTING", observation_id: null }]);
  const canonical = JSON.parse(f.view.canonical); canonical.acceptedProfiles = [{ operation: "QUERY" }, { operation: "NOTIFY" }];
  f.view.canonical = JSON.stringify(canonical);
  t.mock.method(attempts, "executeJoinpayCollectionAttempt", async () => ({ kind: "OBSERVED", operation: "SUBMIT", observation: {} }) as never);
  await assert.rejects(recoverJoinpayCollectionBatch(f.options), /COLLECTION_RECOVERY_SUBMIT_FORBIDDEN/);
});

test("缺付款观察或终态/坏枚举/超预算候选拒绝，不能从缺失依据补出成功", async t => {
  const selected: Row[] = [], f = fixture(t, selected); let calls = 0;
  t.mock.method(attempts, "executeJoinpayCollectionAttempt", async () => { calls++; return { kind: "SKIPPED" } as never; });
  t.mock.method(attempts, "acceptJoinpayCollectionEvidence", async () => { calls++; return {} as never; });
  const cases = [[{ request_id: "payreq_one", state: "ACCEPTED", observation_id: null }],
    [{ request_id: "payreq_one", state: "UNRECOGNIZED", observation_id: null }],
    [{ request_id: "payreq_one", state: "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE", observation_id: null }],
    Array.from({ length: 4 }, (_, i) => ({ request_id: "payreq_" + i, state: "UNKNOWN", observation_id: null }))];
  for (const rows of cases) {
    selected.splice(0, selected.length, ...rows);
    await assert.rejects(recoverJoinpayCollectionBatch(f.options), { message: "COLLECTION_RECOVERY_CANDIDATES_INVALID" });
  }
  assert.equal(calls, 0);
});

test("提交未知原样上抛并停止本批，后续请求不开始", async t => {
  const f = fixture(t, [{ request_id: "payreq_one", state: "UNKNOWN", observation_id: null }, { request_id: "payreq_two", state: "UNKNOWN", observation_id: null }]);
  const unknown = new attempts.CollectionAttemptCommitUnknown("payreq_one", "RESULT"); let calls = 0;
  t.mock.method(attempts, "executeJoinpayCollectionAttempt", async () => { calls++; throw unknown; });
  await assert.rejects(recoverJoinpayCollectionBatch(f.options), error => error === unknown);
  assert.equal(calls, 1);
});

test("取消不再开始下一条；预先取消不连接", async t => {
  const f = fixture(t, [{ request_id: "payreq_one", state: "UNKNOWN", observation_id: null }, { request_id: "payreq_two", state: "UNKNOWN", observation_id: null }]);
  const controller = new AbortController(); let calls = 0;
  t.mock.method(attempts, "executeJoinpayCollectionAttempt", async () => { calls++; controller.abort(); return { kind: "SKIPPED" } as never; });
  const result = await recoverJoinpayCollectionBatch(f.options, controller.signal); assert.equal(result.skipped, 1); assert.equal(calls, 1);
  const before = f.connects(); await recoverJoinpayCollectionBatch(f.options, controller.signal); assert.equal(f.connects(), before);
});

test("单进程任务不重叠，stop等待在途并清除后续定时器", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, [{ request_id: "payreq_one", state: "UNKNOWN", observation_id: null }]);
  let release!: () => void, calls = 0; const pending = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(attempts, "executeJoinpayCollectionAttempt", async () => { calls++; await pending; return { kind: "SKIPPED" } as never; });
  const worker = startJoinpayCollectionRecovery(f.options);
  t.mock.timers.tick(0); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(600000); await flush(); assert.equal(calls, 1);
  let stopped = false; const closing = worker.stop().then(() => { stopped = true; }); await flush(); assert.equal(stopped, false);
  release(); await closing; assert.equal(worker.status().stopped, true);
  t.mock.timers.tick(600000); await flush(); assert.equal(calls, 1);
});

test("后台遇提交未知即停并保留原引用和阶段，不自动重试或泄露原错误文本", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, [{ request_id: "payreq_one", state: "UNKNOWN", observation_id: null }]); let calls = 0;
  const unknown = new attempts.CollectionAttemptCommitUnknown("payreq_one", "CLAIM");
  t.mock.method(attempts, "executeJoinpayCollectionAttempt", async () => { calls++; throw unknown; });
  const worker = startJoinpayCollectionRecovery(f.options); t.mock.timers.tick(0); await flush();
  assert.deepEqual(worker.status(), { stopped: true, failure: { code: "PAYMENT_EXECUTION_UNKNOWN", requestId: "payreq_one", phase: "CLAIM" } });
  t.mock.timers.tick(600000); await flush(); assert.equal(calls, 1); await worker.stop();
});

test("真实Nest关闭顺序：恢复任务排空后才进入连接池关闭钩子，默认不启动且禁止重复启动", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const f = fixture(t, [{ request_id: "payreq_one", state: "UNKNOWN", observation_id: null }]);
  let release!: () => void, closed = false, calls = 0;
  const pending = new Promise<void>(resolve => { release = resolve; });
  t.mock.method(attempts, "executeJoinpayCollectionAttempt", async () => { calls++; await pending; return { kind: "SKIPPED" } as never; });
  @Module({ providers: [JoinpayCollectionRecoveryLifecycle, { provide: "COMPONENT_POOL", useValue: { onApplicationShutdown: () => { closed = true; } } }] })
  class ComponentModule {}
  const app = await NestFactory.createApplicationContext(ComponentModule, { logger: false });
  const lifecycle = app.get(JoinpayCollectionRecoveryLifecycle);
  assert.deepEqual(lifecycle.status(), { stopped: true, failure: null }); assert.equal(f.connects(), 0);
  lifecycle.start(f.options); assert.throws(() => lifecycle.start(f.options), { message: "COLLECTION_RECOVERY_ALREADY_STARTED" });
  t.mock.timers.tick(0); await flush(); assert.equal(calls, 1);
  const closing = app.close(); await flush(); assert.equal(closed, false);
  release(); await closing; assert.equal(closed, true); assert.equal(lifecycle.status().stopped, true);
});

test("共享装配可以先配置，Nest启动完成前不连接，提前关闭后也不启动", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t);
  const lifecycle = new JoinpayCollectionRecoveryLifecycle(); lifecycle.start(f.options);
  t.mock.timers.tick(0); await flush(); assert.equal(f.connects(), 0);
  await lifecycle.beforeApplicationShutdown(); lifecycle.onApplicationBootstrap();
  t.mock.timers.tick(600000); await flush(); assert.equal(f.connects(), 0);
  assert.deepEqual(lifecycle.status(), { stopped: true, failure: null });
});
