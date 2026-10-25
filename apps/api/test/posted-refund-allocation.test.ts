// SYNTHETIC_COMPONENT_MODEL：虚构行、权限与事务替身，不是PG/官方验签或真实退款。
import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import type { Pool, PoolClient } from "pg";
import * as profiles from "../src/order/joinpay-refund-profile";
import * as store from "../src/order/channel-refund-store";
import { allocatePostedJoinpayRefunds, RefundAllocationCommitUnknown, type RefundExecution } from "../src/order/joinpay-refund-attempt";
import * as attempts from "../src/order/joinpay-refund-attempt";
import { JoinpayFundsRecoveryLifecycle, recoverJoinpayRefundBatch } from "../src/finance/joinpay-funds-recovery";

const never = (): never => { throw Error("UNEXPECTED_COMPONENT_IO"); };
const view = { reference: "component_refund_review", sha256: "a".repeat(64), canonical: "{}", database: "component_database", runtimeUser: "component_runtime",
  merchantIdentityId: "component_merchant", merchantNo: "999900000000001", historicalInitialAdmissions: [], acceptedProfiles: [] };
const descriptor = { notifyUrl: "https://component.invalid/refund", profileId: "component_profile", profileSha256: "b".repeat(64), keyVersionRef: "component_key", merchantNo: view.merchantNo };
function admission(t: TestContext) {
  t.mock.method(profiles, "readFormalRefundAdmission", () => view);
  t.mock.method(profiles, "assertFormalRefundProfile", () => view);
  t.mock.method(profiles, "describeRefundProfile", () => descriptor as never);
  t.mock.method(profiles, "assertRefundStart", () => {});
  t.mock.method(profiles, "assertRefundBinding", () => {});
}
function coreFixture(t: TestContext) {
  admission(t); const intents: any[] = [], trace: { sql: string; args: any[] }[] = []; let audits = 0, blocked = false, auditFailure = false;
  let checkpoint: { rows: any[]; audits: number } | undefined;
  const basis = { order_id: "order_one", payment_confirmation_id: "payment_one", renter_user_id: "renter_one", version_hash: "c".repeat(64),
    due_at: "2026-11-01 00:00:00+00", source: "JOINPAY", merchant_scope_id: view.merchantIdentityId, provider_transaction_id: "provider_one",
    merchant_order_no: "original_order_one", paid_cents: "20000", responsibility_cents: "12345", currency: "CNY" };
  const client = { release() {}, async query(sql: string, args: any[] = []) {
    trace.push({ sql, args });
    if (sql === "BEGIN") { checkpoint = { rows: structuredClone(intents), audits }; return { rows: [] }; }
    if (sql === "COMMIT") return { rows: [] };
    if (sql === "ROLLBACK") { if (checkpoint) { intents.splice(0, intents.length, ...checkpoint.rows); audits = checkpoint.audits; } return { rows: [] }; }
    if (sql.includes("current_setting('transaction_isolation')")) return { rows: [{ db: view.database, actor: view.runtimeUser, xid: "101", isolation: "read committed" }] };
    if (sql.startsWith("SELECT p.order_id")) return { rows: [structuredClone(basis)] };
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [] };
    if (sql.startsWith("SELECT id,idempotency_key")) return { rows: intents.filter(r => r.posting_id === args[0]).map(r => ({ id: r.id, idempotency_key: r.idempotency_key })) };
    if (sql.startsWith("SELECT") && sql.includes("FROM zzsh_order.channel_refund_intent WHERE posting_id=$1 AND idempotency_key=$2")) return { rows: intents.filter(r => r.posting_id === args[0] && r.idempotency_key === args[1]) };
    if (sql.includes('FROM zzsh_auth_user."user"')) return { rows: [{ id: basis.renter_user_id }] };
    if (sql.includes("SELECT ledger_revision")) return { rows: [{ ledger_revision: "1" }] };
    if (sql.startsWith("SELECT EXISTS")) return { rows: [{ blocked }] };
    if (sql.includes(" AS paid_allocated")) {
      const active = intents.filter(r => r.budget_disposition !== "RELEASED");
      return { rows: [{ paid_allocated: active.reduce((n, r) => n + BigInt(r.amount_cents), 0n).toString(),
        responsibility_allocated: active.filter(r => r.posting_id === args[3]).reduce((n, r) => n + BigInt(r.amount_cents), 0n).toString() }] };
    }
    if (sql.startsWith("INSERT INTO zzsh_order.channel_refund_intent")) {
      const row = { id: args[0], posting_id: args[1], order_id: args[2], payment_confirmation_id: args[3], renter_user_id: args[4], payment_source: "JOINPAY",
        merchant_identity_id: args[5], original_payment_trx_no: args[6], original_payment_order_no: args[7], responsibility_version_hash: args[8], refund_order_no: args[9],
        amount_cents: args[10], idempotency_key: args[11], request_fingerprint: args[12], due_at: args[13], initial_admission_ref: args[14],
        evidence_level: "JOINPAY_FORMAL", state: "READY", budget_disposition: "ALLOCATED" };
      intents.push(row); return { rows: [row] };
    }
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) { if (auditFailure) throw Error("SYNTHETIC_AUDIT_FAILURE"); audits++; return { rows: [] }; }
    return never();
  } } as unknown as PoolClient;
  const input = { postingId: "posting_one", requestId: "request_one", admission: {} as profiles.FormalRefundAdmission, profile: {} as profiles.BoundRefundProfile };
  return { client, input, basis, intents, trace, audits: () => audits, block: () => { blocked = true; }, failAudit: () => { auditFailure = true; } };
}

test("全额只读冻结责任/租客，原号稳定，未来截止保留，重放不新分配或改成已退", async t => {
  const f = coreFixture(t), input = { ...f.input, amountCents: "999999", renterUserId: "attacker" };
  const first = await store.createPostedNativeRefundIntent(f.client, input);
  assert.equal(first.outcome, "ALLOCATED"); assert.equal(f.intents.length, 1); assert.equal(f.audits(), 1);
  const row = f.intents[0]; assert.equal(row.amount_cents, "12345"); assert.equal(row.renter_user_id, "renter_one"); assert.equal(row.due_at, f.basis.due_at);
  assert.equal(row.budget_disposition, "ALLOCATED"); assert.equal(row.state, "READY");
  const replay = await store.createPostedNativeRefundIntent(f.client, input); assert.equal(replay.outcome, "REPLAYED");
  assert.equal(f.intents.length, 1); assert.equal(f.audits(), 1); assert.equal(row.idempotency_key, store.postedRefundAllocationKey("posting_one"));
  assert(f.trace.findIndex(r => r.sql.includes("pg_advisory_xact_lock")) < f.trace.findIndex(r => r.sql.startsWith("SELECT id,idempotency_key")));
});

test("CONTROLLED/币种/商户不符与零责任不升级；其他键或失败原意图不换号退款", async t => {
  const f = coreFixture(t);
  for (const patch of [{ source: "CONTROLLED" }, { currency: "USD" }, { merchant_scope_id: "another_merchant" }, { responsibility_cents: "0" }]) {
    const old = { ...f.basis }; Object.assign(f.basis, patch);
    assert.equal((await store.createPostedNativeRefundIntent(f.client, f.input)).outcome, "SKIPPED"); Object.assign(f.basis, old);
  }
  const amount = f.basis.responsibility_cents; f.basis.responsibility_cents = null as never;
  await assert.rejects(store.createPostedNativeRefundIntent(f.client, f.input)); f.basis.responsibility_cents = amount;
  f.intents.push({ id: "manual_intent", posting_id: "posting_one", idempotency_key: "manual_key", amount_cents: "1", budget_disposition: "RELEASED", state: "FAILED" });
  const skipped = await store.createPostedNativeRefundIntent(f.client, f.input); assert.equal(skipped.outcome, "SKIPPED");
  assert.equal(f.intents.length, 1); assert.equal(f.audits(), 0);
});

test("复用跨原付款预算与人工复核守卫，超额/复核均不留下新意图", async t => {
  const f = coreFixture(t); f.intents.push({ id: "other", posting_id: "other_posting", idempotency_key: "other_key", amount_cents: "10000", budget_disposition: "CONSUMED" });
  await assert.rejects(store.createPostedNativeRefundIntent(f.client, f.input), /exceeds original payment/);
  assert.equal(f.intents.length, 1); f.intents.splice(0); f.block();
  await assert.rejects(store.createPostedNativeRefundIntent(f.client, f.input), /requires review/); assert.equal(f.intents.length, 0);
});

function batchFixture(t: TestContext) {
  admission(t); const trace: string[] = [], allocated: string[] = []; let scans = 0, scanReleased = false, failCommit = false;
  const rows = [{ posting_id: "posting_one" }, { posting_id: "posting_two" }];
  const client = { release() { trace.push("TX_RELEASE"); }, async query(sql: string) {
    trace.push(sql); if (sql === "COMMIT" && failCommit) throw Error("SIMULATED_COMMIT_ACK_LOSS"); return { rows: [] };
  } } as unknown as PoolClient;
  const pool = { connect: async () => { scans++; if (scans === 1) return {
    release() { scanReleased = true; trace.push("SCAN_RELEASE"); }, async query(sql: string) {
      trace.push(sql); return { rows: sql.startsWith("SELECT current_database()") ? [{ db: view.database, actor: view.runtimeUser }] : rows };
    } }; return client; } } as unknown as Pool;
  t.mock.method(store, "createPostedNativeRefundIntent", async (...[_c, input]: Parameters<typeof store.createPostedNativeRefundIntent>) => {
    assert.equal(scanReleased, true); assert.equal(trace.at(-1), "BEGIN"); allocated.push(input.postingId); return { outcome: "ALLOCATED", receipt: {} } as never;
  });
  const options = { pool, admission: {} as profiles.FormalRefundAdmission, initialProfile: {} as profiles.BoundRefundProfile, profileFor: never, keyFor: never, fetch: never } as RefundExecution;
  return { options, trace, rows, allocated, fail: () => { failCommit = true; }, connects: () => scans };
}

test("缺初始profile默认关闭；扫描释放后逐单原事务分配，不读钥或外呼", async t => {
  const f = batchFixture(t), noInitial = { ...f.options, initialProfile: undefined };
  assert.deepEqual(await allocatePostedJoinpayRefunds(noInitial, 2), { selected: 0, allocated: 0, replayed: 0, skipped: 0 }); assert.equal(f.connects(), 0);
  const result = await allocatePostedJoinpayRefunds(f.options, 2); assert.deepEqual(result, { selected: 2, allocated: 2, replayed: 0, skipped: 0 });
  assert.deepEqual(f.allocated, ["posting_one", "posting_two"]); assert.equal(f.trace.filter(x => x === "COMMIT").length, 2);
});

test("分配COMMIT回执丢失保留posting及同一幂等键并停批，不冒充已分配/已退款", async t => {
  const f = batchFixture(t); f.fail();
  await assert.rejects(allocatePostedJoinpayRefunds(f.options, 2), error => error instanceof RefundAllocationCommitUnknown
    && error.postingId === "posting_one" && error.idempotencyKey === store.postedRefundAllocationKey("posting_one"));
  assert.deepEqual(f.allocated, ["posting_one"]); assert(!f.trace.slice(f.trace.indexOf("COMMIT") + 1).includes("BEGIN"));
});

test("异常候选或取消不开始分配，缺能力在连接前失败", async t => {
  const f = batchFixture(t); f.rows[0]!.posting_id = "bad id";
  await assert.rejects(allocatePostedJoinpayRefunds(f.options, 2), /candidates invalid/); assert.equal(f.allocated.length, 0);
  const cancelled = new AbortController(); cancelled.abort(); const count = f.connects();
  assert.deepEqual(await allocatePostedJoinpayRefunds(f.options, 2, cancelled.signal), { selected: 0, allocated: 0, replayed: 0, skipped: 0 }); assert.equal(f.connects(), count);
  for (const n of [0, 11, NaN, Infinity, 1.5]) await assert.rejects(allocatePostedJoinpayRefunds(f.options, n)); assert.equal(f.connects(), count);
});

test("真实Core调用模型：审计失败向上传播并ROLLBACK，不留意图或误报COMMIT未知", async t => {
  const f = coreFixture(t); f.failAudit(); let borrowed = 0;
  const pool = { connect: async () => { borrowed++; return borrowed === 1 ? {
    release() {}, query: async (sql: string) => ({ rows: sql.startsWith("SELECT current_database()")
      ? [{ db: view.database, actor: view.runtimeUser }] : [{ posting_id: "posting_one" }] }),
  } : f.client; } } as unknown as Pool;
  const o = { pool, admission: f.input.admission, initialProfile: f.input.profile, profileFor: never, keyFor: never, fetch: never } as RefundExecution;
  await assert.rejects(allocatePostedJoinpayRefunds(o, 1), error => error instanceof Error && error.message === "SYNTHETIC_AUDIT_FAILURE" && !(error instanceof RefundAllocationCommitUnknown));
  assert.equal(f.intents.length, 0); assert.equal(f.audits(), 0); assert(f.trace.some(x => x.sql === "ROLLBACK")); assert(!f.trace.some(x => x.sql === "COMMIT"));
});

test("错资源在扫描前退出并释放；无正式初始资格在连接前拒绝", async t => {
  admission(t); let queries = 0, released = 0, connects = 0;
  const o = { pool: { connect: async () => { connects++; return { release() { released++; }, query: async () => { queries++; return { rows: [{ db: "wrong_database", actor: view.runtimeUser }] }; } }; } },
    admission: {}, initialProfile: {}, profileFor: never, keyFor: never, fetch: never } as unknown as RefundExecution;
  await assert.rejects(allocatePostedJoinpayRefunds(o, 1), /resource differs/); assert.equal(queries, 1); assert.equal(released, 1);
  t.mock.method(profiles, "assertFormalRefundProfile", () => { throw Error("NO_INITIAL_ADMISSION"); });
  await assert.rejects(allocatePostedJoinpayRefunds(o, 1), /NO_INITIAL_ADMISSION/); assert.equal(connects, 1);
});

test("恢复编排先确认分配再消费原意图；ALLOCATION未知不查单/外呼且后台状态保留正确对象", async t => {
  admission(t); let allocated = 0, scans = 0;
  const pool = { connect: async () => { scans++; return { release() {}, query: async (sql: string) => ({ rows: sql.startsWith("SELECT current_database()")
    ? [{ db: view.database, actor: view.runtimeUser }] : [] }) }; } } as unknown as Pool;
  const execution = { pool, admission: {} as profiles.FormalRefundAdmission, initialProfile: {} as profiles.BoundRefundProfile, profileFor: never, keyFor: never, fetch: never } as RefundExecution;
  const options = { execution, workerId: "worker_one", batchLimit: 2, minimumIntervalSeconds: 60 };
  t.mock.method(attempts, "allocatePostedJoinpayRefunds", async () => { allocated++; return { selected: 1, allocated: 1, replayed: 0, skipped: 0 }; });
  const result = await recoverJoinpayRefundBatch(options); assert.equal(allocated, 1); assert.equal(result.allocation?.allocated, 1); assert.equal(scans, 1);
  const unknown = new RefundAllocationCommitUnknown("posting_one", store.postedRefundAllocationKey("posting_one"));
  t.mock.method(attempts, "allocatePostedJoinpayRefunds", async () => { throw unknown; });
  await assert.rejects(recoverJoinpayRefundBatch(options), error => error === unknown); assert.equal(scans, 1);
  t.mock.timers.enable({ apis: ["setTimeout"] }); const life = new JoinpayFundsRecoveryLifecycle(); life.start({ refund: options }); life.onApplicationBootstrap();
  t.mock.timers.tick(0); for (let i = 0; i < 30; i++) await Promise.resolve();
  assert.deepEqual(life.status().refund.failure, { code: "REFUND_ALLOCATION_UNKNOWN", postingId: "posting_one", idempotencyKey: unknown.idempotencyKey, phase: "ALLOCATION" });
  await life.beforeApplicationShutdown();
});
