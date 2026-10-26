// SYNTHETIC_COMPONENT_MODEL：内存事务替身；验证手动查询不首次下单，不代表PG或渠道通过。
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { CollectionAttemptCommitUnknown, queryJoinpayCollectionForUser, type JoinpayCollectionExecution } from "../src/order/joinpay-collection-attempt";
import type { FormalCollectionSourceOptions } from "../src/order/joinpay-collection-source";
import type { RequestState } from "../src/order/joinpay-protocol";

type Row = { state: RequestState; lease_version: string };
function model(row: Row | null, options: { skippedState?: RequestState; observed?: boolean } = {}) {
  const calls = { connects: 0, reads: 0, executes: 0, lastInput: null as any };
  const client = { release() {}, async query(sql: string, values: unknown[] = []) {
    if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") return { rows: [], rowCount: 0 };
    if (sql.includes("SELECT r.id AS request_id,r.state,r.lease_version::text") && sql.includes("zzsh_order.rental_order")) {
      calls.reads++; assert.deepEqual(values, ["order_1", "renter"]);
      return { rows: row ? [{ request_id: "payreq_1", ...row }] : [], rowCount: row ? 1 : 0 };
    }
    throw Error("UNEXPECTED_SQL " + sql);
  } } as unknown as PoolClient;
  const pool = { connect: async () => { calls.connects++; return client; },
    query: async (_sql: string, _values: unknown[] = []) => ({ rows: [{ state: options.skippedState ?? "UNKNOWN" }] }) } as unknown as Pool;
  const formal = {} as FormalCollectionSourceOptions;
  const execution = { pool, formal, profileFor: () => { throw Error("no profile"); }, keyFor: () => "k" } as unknown as JoinpayCollectionExecution & { formal: FormalCollectionSourceOptions };
  const execute = (async (_o: unknown, input: { allowFirstDispatch?: boolean }) => {
    calls.executes++; calls.lastInput = input;
    return options.observed
      ? { requestId: "payreq_1", kind: "OBSERVED", operation: "QUERY", observation: { attemptId: "a", observationId: "o", event: "E4", result: "QUERY_SUCCEEDED",
        state: "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE", formalAcceptance: false } }
      : { requestId: "payreq_1", kind: "SKIPPED" };
  }) as typeof import("../src/order/joinpay-collection-attempt").executeJoinpayCollectionAttempt;
  return { pool, execution, execute, calls };
}
const input = { actorUserId: "renter", orderId: "order_1", workerId: "worker_1", minimumIntervalSeconds: 30 };

test("手动查询不能跨用户；未归属请求不读执行器", async () => {
  const m = model(null);
  assert.equal(await queryJoinpayCollectionForUser(m.pool, m.execution, input, m.execute), null);
  assert.equal(m.calls.executes, 0);
});

test("终态请求只读回状态；未派发请求不首次下单", async () => {
  for (const state of ["ACCEPTED", "REVIEW_REQUIRED"] as const) {
    const m = model({ state, lease_version: "3" });
    assert.deepEqual(await queryJoinpayCollectionForUser(m.pool, m.execution, input, m.execute), { requestId: "payreq_1", kind: "TERMINAL", state });
    assert.equal(m.calls.executes, 0);
  }
  const notDispatched = model({ state: "SUBMITTING", lease_version: "0" });
  assert.deepEqual(await queryJoinpayCollectionForUser(notDispatched.pool, notDispatched.execution, input, notDispatched.execute),
    { requestId: "payreq_1", kind: "NOT_DISPATCHED", state: "SUBMITTING" });
  assert.equal(notDispatched.calls.executes, 0);
});

test("已派发请求只以原号查询：禁止首次下单且沿用最小间隔", async () => {
  const m = model({ state: "UNKNOWN", lease_version: "2" }, { observed: true });
  const result = await queryJoinpayCollectionForUser(m.pool, m.execution, input, m.execute);
  assert.deepEqual(result, { requestId: "payreq_1", kind: "OBSERVED", state: "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE", event: "E4", result: "QUERY_SUCCEEDED" });
  assert.equal(m.calls.executes, 1);
  assert.equal(m.calls.lastInput.allowFirstDispatch, false);
  assert.equal(m.calls.lastInput.recoveryMinimumIntervalSeconds, 30);
  assert.equal(m.calls.lastInput.requestId, "payreq_1");
});

test("待接纳状态不重复查询，明确交给既有接纳恢复", async () => {
  const m = model({ state: "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE", lease_version: "0" }, { observed: true });
  const result = await queryJoinpayCollectionForUser(m.pool, m.execution, input, m.execute);
  assert.deepEqual(result, { requestId: "payreq_1", kind: "PENDING_ACCEPTANCE", state: "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE" });
  assert.equal(m.calls.executes, 0);
});

test("执行器因间隔/租约跳过时返回节流后的真实状态，不补成功", async () => {
  const m = model({ state: "PROCESSING_UNCONFIRMED", lease_version: "2" }, { skippedState: "ACTION_READY" });
  assert.deepEqual(await queryJoinpayCollectionForUser(m.pool, m.execution, input, m.execute), { requestId: "payreq_1", kind: "THROTTLED", state: "ACTION_READY" });
  assert.equal(m.calls.executes, 1);
});

test("非法间隔/身份在连接前拒绝", async () => {
  const m = model({ state: "UNKNOWN", lease_version: "1" });
  await assert.rejects(queryJoinpayCollectionForUser(m.pool, m.execution, { ...input, minimumIntervalSeconds: 29 }, m.execute));
  await assert.rejects(queryJoinpayCollectionForUser(m.pool, m.execution, { ...input, actorUserId: "bad user" }, m.execute));
  assert.equal(m.calls.connects, 0);
});

test("接纳事务以观察ID报提交未知时，仍按原payreq归一回执", async () => {
  const m = model({ state: "UNKNOWN", lease_version: "2" });
  const original = new CollectionAttemptCommitUnknown("observation_1", "RESULT");
  await assert.rejects(queryJoinpayCollectionForUser(m.pool, m.execution, input, async () => { throw original; }), error =>
    error instanceof CollectionAttemptCommitUnknown && error.requestId === "payreq_1" && error.cause === original);
});
