// SYNTHETIC_COMPONENT_MODEL：身份、时钟和PG替身；不代表真实并发、渠道授权或到账。
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Pool, PoolClient } from "pg";
import * as refunds from "../src/order/joinpay-refund-attempt";
import * as payouts from "../src/finance/joinpay-payout-attempt";
import * as refundProfiles from "../src/order/joinpay-refund-profile";
import * as payoutProfiles from "../src/finance/joinpay-payout-profile";
import * as refundStore from "../src/order/channel-refund-store";
import * as payoutStore from "../src/finance/native-withdrawal-store";
import { JoinpayFundsRecoveryLifecycle, recoverJoinpayRefundBatch, recoverJoinpayPayoutBatch } from "../src/finance/joinpay-funds-recovery";
import { Module } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";

const never = (): never => { throw Error("UNEXPECTED_COMPONENT_IO"); };
const flush = async () => { for (let i = 0; i < 32; i++) await Promise.resolve(); };
type Row = { id: string; state: string };
function fixture(t: TestContext, rows: Row[] = []) {
  const history = [{ reference: "unit_old_admission", sha256: "2".repeat(64) }];
  const view = { reference: "unit_current_admission", sha256: "1".repeat(64), database: "unit_database", runtimeUser: "unit_runtime",
    merchantIdentityId: "unit_merchant", merchantNo: "999900000000001", userNo: "999900000000001", tradeMerchantNo: undefined,
    historicalInitialAdmissions: history, historicalScopes: history, canonical: "{}", acceptedProfiles: [] };
  t.mock.method(refundProfiles, "readFormalRefundAdmission", () => view);
  t.mock.method(payoutProfiles, "readPayoutScope", () => view);
  const trace: { sql: string; values?: unknown[] }[] = []; let connects = 0, releases = 0, matching = true;
  const pool = { connect: async () => { connects++; return { query: async (sql: string, values?: unknown[]) => {
    trace.push({ sql, values }); return { rows: sql.startsWith("SELECT current_database()")
      ? [{ db: matching ? view.database : "other_database", actor: view.runtimeUser }] : rows };
  }, release: () => { releases++; } }; } } as unknown as Pool;
  const settings = { workerId: "unit_worker", batchLimit: 3, minimumIntervalSeconds: 60 };
  const refund = { ...settings, execution: { pool, admission: {} as refundProfiles.FormalRefundAdmission, profileFor: never, keyFor: never, fetch: never } };
  const payout = { ...settings, execution: { pool, scope: {} as payoutProfiles.PayoutScope, profileFor: never, keyFor: never, fetch: never } };
  return { view, rows, refund, payout, trace, connects: () => connects, releases: () => releases, mismatch: () => { matching = false; } };
}

test("缺正式品牌/非法调度参数在连接与定时器之前拒绝", async t => {
  const f = fixture(t); t.mock.method(refundProfiles, "readFormalRefundAdmission", never); t.mock.method(payoutProfiles, "readPayoutScope", never);
  await assert.rejects(recoverJoinpayRefundBatch(f.refund), /UNEXPECTED_COMPONENT_IO/);
  await assert.rejects(recoverJoinpayPayoutBatch(f.payout), /UNEXPECTED_COMPONENT_IO/);
  for (const patch of [{ batchLimit: 0 }, { batchLimit: 11 }, { batchLimit: NaN }, { minimumIntervalSeconds: 29 }, { minimumIntervalSeconds: 86401 }, { workerId: "bad worker" }, { workerId: undefined as never }, { workerId: null as never }, { workerId: 42 as never }]) {
    await assert.rejects(recoverJoinpayRefundBatch({ ...f.refund, ...patch }), /FUNDS_RECOVERY_OPTIONS_INVALID/);
    await assert.rejects(recoverJoinpayPayoutBatch({ ...f.payout, ...patch }), /FUNDS_RECOVERY_OPTIONS_INVALID/);
  }
  assert.equal(f.connects(), 0);
});

test("两个域均先核准确数据库/runtime身份；不符不扫描且释放连接", async t => {
  const f = fixture(t); f.mismatch();
  await assert.rejects(recoverJoinpayRefundBatch(f.refund), /FUNDS_RECOVERY_RESOURCE_MISMATCH/);
  await assert.rejects(recoverJoinpayPayoutBatch(f.payout), /FUNDS_RECOVERY_RESOURCE_MISMATCH/);
  assert.equal(f.trace.length, 2); assert.equal(f.releases(), 2);
});

test("退款query-only准入的扫描首派门禁关闭，完整准入保持既有READY派发资格", async t => {
  const f = fixture(t); await recoverJoinpayRefundBatch(f.refund);
  assert.equal(f.trace[1]!.values!.at(-1), false); assert.match(f.trace[1]!.sql, /i\.lease_version>0 OR \$8::boolean/);
  f.view.acceptedProfiles.push({ operation: "SUBMIT" } as never); await recoverJoinpayRefundBatch(f.refund);
  assert.equal(f.trace[3]!.values!.at(-1), true);
});

test("只消费原退款/提现意图，按商户及已接受历史绑定扫描；外呼前释放扫描连接", async t => {
  const f = fixture(t, [{ id: "unit_one", state: "UNKNOWN" }, { id: "unit_two", state: "PROCESSING" }]);
  const calls: string[] = [];
  t.mock.method(refunds, "executeJoinpayRefund", async (...[_o, id, worker, interval]: Parameters<typeof refunds.executeJoinpayRefund>) => {
    assert.equal(f.releases(), 1); assert.equal(worker, "unit_worker"); assert.equal(interval, 60); calls.push("refund:" + id); return id === "unit_one" ? {} as never : null;
  });
  t.mock.method(payouts, "executeJoinpayPayout", async (...[_o, id, worker, interval]: Parameters<typeof payouts.executeJoinpayPayout>) => {
    assert.equal(f.releases(), 2); assert.equal(worker, "unit_worker"); assert.equal(interval, 60); calls.push("payout:" + id); return {} as never;
  });
  assert.deepEqual(await recoverJoinpayRefundBatch(f.refund), { selected: 2, recorded: 1, skipped: 1 });
  assert.deepEqual(await recoverJoinpayPayoutBatch(f.payout), { selected: 2, recorded: 2, skipped: 0 });
  assert.deepEqual(calls, ["refund:unit_one", "refund:unit_two", "payout:unit_one", "payout:unit_two"]);
  const refundScan = f.trace[1]!, payoutScan = f.trace[3]!;
  assert.deepEqual(refundScan.values!.slice(0, 2), [f.view.merchantIdentityId, f.view.merchantNo]);
  assert.deepEqual(JSON.parse(refundScan.values![2] as string), [{ reference: f.view.reference, sha256: f.view.sha256 }, ...f.view.historicalInitialAdmissions]);
  assert.equal(refundScan.values![6], refunds.JOINPAY_REFUND_MAX_AUTOMATIC_QUERIES); assert.equal(refundScan.values!.at(-1), false);
  assert.deepEqual(payoutScan.values!.slice(0, 3), [f.view.merchantIdentityId, f.view.userNo, null]);
  assert.deepEqual(JSON.parse(payoutScan.values![3] as string), [{ reference: f.view.reference, sha256: f.view.sha256 }, ...f.view.historicalScopes]);
  assert.equal(payoutScan.values![7], payouts.JOINPAY_PAYOUT_MAX_AUTOMATIC_QUERIES); assert.equal(payoutScan.values!.at(-1), false);
});

test("坏枚举/重复ID/超批量/终态不交执行器；不把本地查询结果补成到账", async t => {
  const f = fixture(t); let called = 0;
  t.mock.method(refunds, "executeJoinpayRefund", async () => { called++; return null; });
  t.mock.method(payouts, "executeJoinpayPayout", async () => { called++; return null; });
  for (const rows of [[{ id: "one", state: "SUCCEEDED" }], [{ id: "one", state: "NEW_ENUM" }], [{ id: "bad id", state: "UNKNOWN" }], [{ id: 42 as never, state: "UNKNOWN" }],
    [{ id: "one", state: "UNKNOWN" }, { id: "one", state: "UNKNOWN" }], Array.from({ length: 4 }, (_, i) => ({ id: "id_" + i, state: "UNKNOWN" }))]) {
    f.rows.splice(0, f.rows.length, ...rows);
    await assert.rejects(recoverJoinpayRefundBatch(f.refund), /FUNDS_RECOVERY_CANDIDATES_INVALID/);
    await assert.rejects(recoverJoinpayPayoutBatch(f.payout), /FUNDS_RECOVERY_CANDIDATES_INVALID/);
  }
  assert.equal(called, 0);
});

test("C04B-02 仅未首派READY异常按阻断小时退避，其他原单保持到期顺序", async t => {
  const f = fixture(t); await recoverJoinpayRefundBatch(f.refund);
  const scan = f.trace[1]!;
  assert.match(scan.sql, /order\.refund\.abnormal\.first_submit\.blocked/);
  assert.match(scan.sql, /occurred_at>clock_timestamp\(\)-make_interval\(secs=>3600\)/);
  assert.match(scan.sql, /NOT \(i\.basis_kind='REVIEW_CONFIRMATION' AND i\.state='READY'\) OR NOT EXISTS/);
  assert.match(scan.sql, /ORDER BY i\.due_at,i\.id LIMIT/);
  assert.equal(scan.values!.at(-1), false);
});

test("仅查询scope以绑定参数排除lease0首派；明确SUBMIT配置才给扫描开关", async t => {
  const f = fixture(t, []);
  await recoverJoinpayPayoutBatch(f.payout);
  assert(f.trace[1]!.sql.includes("AND (i.lease_version>0 OR $9::boolean)")); assert.equal(f.trace[1]!.values![8], false);
  f.view.acceptedProfiles.push({ operation: "SUBMIT" } as never);
  await recoverJoinpayPayoutBatch(f.payout); assert.equal(f.trace[3]!.values![8], true);
});

test("任一域提交未知原样抛出并停止本批，不重发或开始下一单", async t => {
  const f = fixture(t, [{ id: "unit_one", state: "UNKNOWN" }, { id: "unit_two", state: "UNKNOWN" }]); let refundCalls = 0, payoutCalls = 0;
  const refundError = new refunds.RefundAttemptCommitUnknown("unit_one", "CLAIM"), payoutError = new payouts.PayoutCommitUnknown("unit_one", "RESULT");
  t.mock.method(refunds, "executeJoinpayRefund", async () => { refundCalls++; throw refundError; });
  t.mock.method(payouts, "executeJoinpayPayout", async () => { payoutCalls++; throw payoutError; });
  await assert.rejects(recoverJoinpayRefundBatch(f.refund), error => error === refundError);
  await assert.rejects(recoverJoinpayPayoutBatch(f.payout), error => error === payoutError);
  assert.equal(refundCalls, 1); assert.equal(payoutCalls, 1);
});

test("取消后不开始下一单；预取消零连接", async t => {
  const f = fixture(t, [{ id: "unit_one", state: "UNKNOWN" }, { id: "unit_two", state: "UNKNOWN" }]), controller = new AbortController(); let calls = 0;
  t.mock.method(refunds, "executeJoinpayRefund", async () => { calls++; controller.abort(); return null; });
  assert.deepEqual(await recoverJoinpayRefundBatch(f.refund, controller.signal), { selected: 2, recorded: 0, skipped: 1 });
  assert.equal(calls, 1); const before = f.connects();
  assert.deepEqual(await recoverJoinpayPayoutBatch(f.payout, controller.signal), { selected: 0, recorded: 0, skipped: 0 }); assert.equal(f.connects(), before);
});

test("真实执行器原行锁内重核预算/间隔：未到期不读钥、不claim、不发HTTP；正对照继续原链", async t => {
  for (const kind of ["REFUND", "PAYOUT"] as const) {
    await t.test(kind, async child => {
      let allowed: unknown = false, locks = 0, profileReads = 0, connects = 0; const sqls: string[] = [];
      const c = { release() {}, async query(sql: string, values?: unknown[]) {
        sqls.push(sql);
        if (sql.includes("AS allowed")) { assert.equal(locks, 1); assert.deepEqual(values, ["unit_intent", 60, 10]); return { rows: [{ allowed }] }; }
        if (sql.includes("to_regclass")) return { rows: [{ ready: true }] };
        if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [] };
        return never();
      } } as unknown as PoolClient;
      const pool = { connect: async () => { connects++; return c; } } as unknown as Pool;
      const row = { id: "unit_intent", state: "UNKNOWN", lease_version: "1" };
      child.mock.method(refundProfiles, "readFormalRefundAdmission", () => ({}) as never);
      child.mock.method(payoutProfiles, "readPayoutScope", () => ({}) as never);
      child.mock.method(refundStore, "lockFormalRefundContext", async () => { locks++; return row as never; });
      child.mock.method(refundStore, "formalRefundBinding", () => ({}) as never);
      child.mock.method(payoutStore, "lockNativeWithdrawal", async () => { locks++; return { row } as never; });
      child.mock.method(payoutStore, "nativePayoutBinding", () => ({}) as never);
      child.mock.method(payoutStore, "assertNativePayoutExecutionReady", async () => {});
      const o = { pool, admission: {}, scope: {}, keyFor: never, fetch: never,
        profileFor: () => { profileReads++; throw Error("EXPECTED_NEXT_STAGE"); } } as never;
      const execute = kind === "REFUND" ? refunds.executeJoinpayRefund : payouts.executeJoinpayPayout;
      assert.equal(await execute(o, "unit_intent", "unit_worker", 60), null); assert.equal(profileReads, 0);
      assert(!sqls.some(sql => /^INSERT|^UPDATE/.test(sql))); assert.equal(sqls.at(-1), "COMMIT");
      for (const value of [false, null, NaN, 29, 86401, Infinity, 1.5]) await assert.rejects(execute(o, "unit_intent", "unit_worker", value as never));
      assert.equal(connects, 1);
      locks = 0; allowed = undefined; await assert.rejects(execute(o, "unit_intent", "unit_worker", 60), /timing evidence unavailable/); assert.equal(profileReads, 0);
      locks = 0; allowed = true; await assert.rejects(execute(o, "unit_intent", "unit_worker", 60), /EXPECTED_NEXT_STAGE/); assert.equal(profileReads, 1);
    });
  }
});

test("默认不启动；配置后等Nest启动；任务不重叠，关闭等待在途且不再起下一轮", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t, [{ id: "unit_one", state: "UNKNOWN" }]);
  let finish!: () => void, calls = 0;
  t.mock.method(refunds, "executeJoinpayRefund", async () => { calls++; await new Promise<void>(resolve => { finish = resolve; }); return null; });
  const life = new JoinpayFundsRecoveryLifecycle(); life.start({ refund: f.refund }); t.mock.timers.tick(0); await flush(); assert.equal(f.connects(), 0);
  life.onApplicationBootstrap(); t.mock.timers.tick(0); await flush(); assert.equal(calls, 1);
  t.mock.timers.tick(120000); await flush(); assert.equal(calls, 1);
  let closed = false; const stopping = life.beforeApplicationShutdown().then(() => { closed = true; }); await flush(); assert.equal(closed, false);
  finish(); await stopping; t.mock.timers.tick(120000); await flush(); assert.equal(calls, 1); assert.equal(life.status().refund.stopped, true);
  assert.throws(() => life.start({ refund: f.refund }), /FUNDS_RECOVERY_ALREADY_STARTED/);
});

test("未知停止对应域并保留原引用/阶段；另一域独立运行，失败文本脱敏", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t, [{ id: "unit_one", state: "UNKNOWN" }]); let refundsCalled = 0, payoutsCalled = 0;
  t.mock.method(refunds, "executeJoinpayRefund", async () => { refundsCalled++; throw new refunds.RefundAttemptCommitUnknown("unit_one", "RESULT"); });
  t.mock.method(payouts, "executeJoinpayPayout", async () => { payoutsCalled++; return null; });
  const life = new JoinpayFundsRecoveryLifecycle(); life.start({ refund: f.refund, payout: f.payout }); life.onApplicationBootstrap();
  t.mock.timers.tick(0); await flush(); assert.deepEqual(life.status().refund, { stopped: true, failure: { code: "REFUND_EXECUTION_UNKNOWN", intentId: "unit_one", phase: "RESULT" } });
  t.mock.timers.tick(60000); await flush(); assert.equal(refundsCalled, 1); assert.equal(payoutsCalled, 2);
  await life.beforeApplicationShutdown();
  t.mock.method(payouts, "executeJoinpayPayout", async () => { throw Error("PRIVATE_COMPONENT_VALUE"); });
  const bad = new JoinpayFundsRecoveryLifecycle(); bad.start({ payout: f.payout }); bad.onApplicationBootstrap(); t.mock.timers.tick(0); await flush();
  assert.deepEqual(bad.status().payout.failure, { code: "FUNDS_RECOVERY_FAILED" }); assert(!JSON.stringify(bad.status()).includes("PRIVATE")); await bad.beforeApplicationShutdown();
});

test("真实Nest生命周期：先排空资金任务再结束原池，未配置时零连接", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] }); const f = fixture(t, [{ id: "unit_one", state: "UNKNOWN" }]); let finish!: () => void, poolClosed = false;
  t.mock.method(refunds, "executeJoinpayRefund", async () => { await new Promise<void>(resolve => { finish = resolve; }); return null; });
  class PoolCloser { onApplicationShutdown() { poolClosed = true; } }
  @Module({ providers: [JoinpayFundsRecoveryLifecycle, PoolCloser] }) class ComponentModule {}
  const app = await NestFactory.createApplicationContext(ComponentModule, { logger: false });
  try {
    const life = app.get(JoinpayFundsRecoveryLifecycle); assert.equal(f.connects(), 0); life.start({ refund: f.refund });
    t.mock.timers.tick(0); await flush(); let closed = false; const closing = app.close().then(() => { closed = true; }); await flush();
    assert.equal(poolClosed, false); assert.equal(closed, false); finish(); await closing; assert.equal(poolClosed, true);
  } finally { await app.close(); }
});

test("Master R1: old first-submit blocked audit must not pause an already-dispatched query",async t=>{
 const f=fixture(t);await recoverJoinpayRefundBatch(f.refund);
 assert.match(f.trace[1]!.sql,/NOT \(i\.basis_kind='REVIEW_CONFIRMATION' AND i\.state='READY'\) OR NOT EXISTS/);
});
