// SYNTHETIC_PROTOCOL：无 socket 的事务替身，不替代真实 PG/商户验收。
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../src/config/config";
import { createSyntheticChannelRequestCapability, type ChannelBinding } from "../src/order/channel-payment-store";
import { executeSyntheticJoinpayRequest, receiveSyntheticJoinpayNotification, type SyntheticJoinpayExecution } from "../src/order/channel-payment-executor";
import { JOINPAY_SIGNATURE_ORDER } from "../src/order/joinpay-protocol";

const KEY = "SYNTHETIC_PAY04_KEY", MERCHANT = "888000000000004", ORDER = "ZZPAY04_0001";
const binding: ChannelBinding = { channel: "JOINPAY", merchantIdentityId: "merchant_synthetic", configProfileId: "profile_1", protocolVersion: "2.6", keyVersionRef: "key_1" };
const config = { profile: "test", provider: "fake", testOperationsEnabled: true,
  database: { target: "local-compose", host: "127.0.0.1", port: 55432, name: "zzsh_test_order_joinpay_pay03a", user: "zzsh_order_joinpay_pay03a_r" } } as AppConfig;
const capability = () => createSyntheticChannelRequestCapability({ config, resourceSet: "joinpay_pay03a", evidenceLevel: "SYNTHETIC_PROTOCOL" });
type Row = Record<string, any>;
function harness(failCommit?: number) {
  const s = { now: 1000, commits: 0, calls: [] as string[], observations: [] as unknown[][], anchors: [] as Row[], closed: false,
    db: config.database.name, row: { id: "payreq_1", order_id: "order_1", channel: "JOINPAY", merchant_identity_id: binding.merchantIdentityId,
      config_profile_id: binding.configProfileId, protocol_version: "2.6", key_version_ref: "key_1", platform_order_no: "ZZPAY04-0001", channel_order_no: ORDER,
      amount_cents: "125", currency: "CNY", wire_amount_yuan: "1.25", method: "ALIPAY_NATIVE", evidence_level: "SYNTHETIC_PROTOCOL",
      state: "SUBMITTING", revision: "1", lease_version: "0", lease_owner: null, lease_until: null } as Row };
  const pool = { connect: async () => {
    let before: { row: Row; count: number; anchors: Row[] } | undefined;
    return { release() {}, query: async (sql: string, p: any[] = []) => {
      s.calls.push(sql);
      const one = (r: Row | undefined) => ({ rows: r ? [r] : [], rowCount: r ? 1 : 0 });
      if (sql === "BEGIN") { before = { row: { ...s.row }, count: s.observations.length, anchors: s.anchors.map(a => ({ ...a })) }; return one(undefined); }
      if (sql === "COMMIT") { before = undefined; if (++s.commits === failCommit) throw Error("simulated missing ACK"); return one(undefined); }
      if (sql === "ROLLBACK") { if (before) { s.row = before.row; s.observations.length = before.count; s.anchors = before.anchors; } return one(undefined); }
      if (sql.includes("current_database() AS db")) return one({ db: s.db, actor: config.database.user });
      if (sql.includes("SET lease_version=lease_version+1")) {
        if (p[0] !== s.row.id || !p[3].includes(s.row.state) || (s.row.lease_until !== null && s.row.lease_until > s.now)) return one(undefined);
        Object.assign(s.row, { lease_version: String(BigInt(s.row.lease_version) + 1n), lease_owner: p[1], lease_until: s.now + p[2] * 1000, revision: String(BigInt(s.row.revision) + 1n) });
        return one({ ...s.row });
      }
      if (sql.includes("AS lease_current")) return one({ lease_current: s.row.lease_version === p[1] && s.row.lease_owner === p[2] && s.row.lease_until > s.now });
      if (sql.includes("FROM zzsh_order.payment_request WHERE id=$1")) return one(p[0] === s.row.id ? { ...s.row } : undefined);
      if (sql.startsWith("SELECT status, hold_until")) return one({ status: s.closed ? "CANCELLED" : "PENDING_PAYMENT", open: !s.closed });
      if (sql.includes("WHERE channel='JOINPAY' AND merchant_identity_id")) return one(p[0] === s.row.merchant_identity_id && p[1] === ORDER ? { ...s.row } : undefined);
      if (sql.startsWith("UPDATE zzsh_order.payment_request SET state=")) {
        if (s.row.state !== p[2] || s.row.revision !== p[3] || (p[4] !== null && (s.row.lease_version !== p[4] || s.row.lease_until <= s.now))) return one(undefined);
        Object.assign(s.row, { state: p[1], revision: String(BigInt(s.row.revision) + 1n) }); return { rows: [], rowCount: 1 };
      }
      if (sql.includes("pg_advisory_xact_lock")) return one(undefined);
      if (sql.startsWith("INSERT INTO zzsh_order.payment_channel_transaction")) {
        if (s.anchors.length) return one(undefined);
        s.anchors.push({ id: p[0], native_order_id: p[4], confirmation_id: p[6] }); return one({ id: p[0] });
      }
      if (sql.startsWith("SELECT id, native_order_id, confirmation_id")) return one(s.anchors[0]);
      if (sql.startsWith("INSERT INTO zzsh_order.payment_channel_observation")) { s.observations.push([...p]); return one(undefined); }
      throw Error(`Unmodelled SQL: ${sql}`);
    } } as unknown as PoolClient;
  } } as Pool;
  return { s, pool };
}
function signed(operation: "uniPaySyncResponse" | "queryOrderResponse" | "asyncNotify", values: Record<string, string>): string {
  const hmac = createHash("md5").update(JOINPAY_SIGNATURE_ORDER[operation].map(n => values[n] ?? "").join("") + KEY).digest("hex");
  return operation === "asyncNotify" ? new URLSearchParams({ ...values, hmac }).toString() : JSON.stringify({ ...values, hmac });
}
const sync = () => new TextEncoder().encode(signed("uniPaySyncResponse", { r0_Version: "2.6", r1_MerchantNo: MERCHANT, r2_OrderNo: ORDER,
  r3_Amount: "1.25", r4_Cur: "1", r6_FrpCode: "ALIPAY_NATIVE", r7_TrxNo: "SYNTHETIC_TRX_04", ra_Code: "100", rb_CodeMsg: "OK", rc_Result: "https://qr.example.invalid/pay" }));
const query = () => new TextEncoder().encode(signed("queryOrderResponse", { r0_Version: "2.6", r1_MerchantNo: MERCHANT, r2_OrderNo: ORDER,
  r7_Fee: "0.00", ra_Status: "102", rb_Code: "100", rc_CodeMsg: "OK", rd_OpenId: "synthetic", re_DiscountAmount: "0.00", rf_PayTime: "2026-10-23 01:00:00", rj_BankCode: "ALIPAY", ro_SettleAmount: "1.25" }));
const notify = () => signed("asyncNotify", { r0_Version: "2.6", r1_MerchantNo: MERCHANT, r2_OrderNo: ORDER, r3_Amount: "1.25", r4_Cur: "1",
  r6_Status: "100", r7_TrxNo: "SYNTHETIC_TRX_04", ra_PayTime: "2026-10-23 01:00:00", rb_DealTime: "2026-10-23 01:00:01", rc_BankCode: "ALIPAY",
  re_DiscountAmount: "0.00", rk_FrpCode: "ALIPAY_NATIVE", ro_SettleAmount: "1.25" });
function options(db: ReturnType<typeof harness>, exchange: SyntheticJoinpayExecution["exchange"] = async () => ({ status: 200, body: sync() })): SyntheticJoinpayExecution {
  return { pool: db.pool, capability: capability(), binding, merchantNo: MERCHANT, productName: "合成协议", tradeMerchantNo: "SYNTH_TRADE_04",
    notifyUrl: "https://example.invalid/notify", keyFor: k => { assert.equal(k, "key_1"); return KEY; }, exchange };
}
const input = { requestId: "payreq_1", workerId: "worker_1" };

test("首租约提交后仅下单一次，参数来自持久原号/金额，不产生真实付款", async () => {
  const db = harness(); let calls = 0;
  const result = await executeSyntheticJoinpayRequest(options(db, async request => {
    assert.equal(db.s.commits, 1); assert.equal(request.operation, "SUBMIT"); assert.equal(request.form.sendable, false);
    assert.equal(new Map(request.form.fields).get("p2_OrderNo"), ORDER); assert.equal(new Map(request.form.fields).get("p3_Amount"), "1.25"); calls++;
    return { status: 200, body: sync() };
  }), input);
  assert.equal(calls, 1); assert.equal(result.kind, "OBSERVED"); assert.equal(db.s.row.state, "ACTION_READY");
  if (result.kind === "OBSERVED") assert.equal(result.observation.formalAcceptance, false);
  assert.equal(db.s.anchors.length, 0);
});

test("重启遗留 SUBMITTING 及 UNKNOWN 均只查原号；本地取消不阻断既有原号核查", async () => {
  for (const state of ["SUBMITTING", "UNKNOWN", "ACTION_READY"]) {
    const db = harness(); Object.assign(db.s.row, { state, lease_version: "1", lease_until: 0 }); db.s.closed = true;
    let calls = 0;
    const result = await executeSyntheticJoinpayRequest(options(db, async request => {
      calls++; assert.equal(request.operation, "QUERY"); assert.equal(new Map(request.form.fields).get("p2_OrderNo"), ORDER);
      assert.equal(new Map(request.form.fields).has("p3_Amount"), false); return { status: 200, body: query() };
    }), input);
    assert.equal(result.kind, "OBSERVED"); assert.equal(db.s.row.state, state); assert.equal(calls, 1);
  }
});

test("claim 提交回执丢失时不外呼；原请求接管后查原号", async () => {
  const db = harness(1); let calls = 0;
  const opts = options(db, async r => { calls++; assert.equal(r.operation, "QUERY"); return { status: 200, body: query() }; });
  await assert.rejects(executeSyntheticJoinpayRequest(opts, input), { code: "PAYMENT_EXECUTION_UNKNOWN", phase: "CLAIM", requestId: input.requestId });
  assert.equal(calls, 0); db.s.now += 31_000;
  await executeSyntheticJoinpayRequest(opts, input); assert.equal(calls, 1);
});

test("结果 COMMIT 未确认不重下单；调用方收到原 requestId 和 RESULT 未知", async () => {
  const db = harness(2); let calls = 0;
  const opts = options(db, async r => { calls++; return { status: 200, body: r.operation === "SUBMIT" ? sync() : query() }; });
  await assert.rejects(executeSyntheticJoinpayRequest(opts, input), { code: "PAYMENT_EXECUTION_UNKNOWN", phase: "RESULT" });
  assert.equal(calls, 1); db.s.now += 31_000;
  const recovered = await executeSyntheticJoinpayRequest(opts, input);
  assert.equal(recovered.kind === "OBSERVED" && recovered.operation, "QUERY"); assert.equal(calls, 2);
});

test("网络、HTTP 和过大响应只记 UNKNOWN，单次尝试不自动重试", async () => {
  const responses: SyntheticJoinpayExecution["exchange"][] = [async () => { throw Error("do not log a private message"); },
    async () => ({ status: 500, body: sync() }), async () => ({ status: 200, body: new Uint8Array(65_537) })];
  for (const [i, exchange] of responses.entries()) {
    const db = harness(); let calls = 0;
    await executeSyntheticJoinpayRequest(options(db, async r => { calls++; return exchange(r); }), input);
    assert.equal(calls, 1); assert.equal(db.s.row.state, "UNKNOWN"); assert.equal(db.s.observations[0]![13], "TRANSPORT_UNKNOWN");
    assert.equal(db.s.observations[0]![14], ["NETWORK_ERROR", "HTTP_STATUS", "BODY_TOO_LARGE"][i]); assert.equal(db.s.anchors.length, 0);
  }
});

test("8 秒上限会中止忽略 signal 的交换，迟到响应不再写库", async t => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const db = harness(); let finish!: (v: { status: number; body: Uint8Array }) => void, start!: () => void, signal!: AbortSignal;
  const started = new Promise<void>(resolve => { start = resolve; });
  const running = executeSyntheticJoinpayRequest(options(db, async r => { signal = r.signal; start(); return new Promise(resolve => { finish = resolve; }); }), input);
  await started; t.mock.timers.tick(8_000); await running;
  assert.equal(signal.aborted, true); assert.equal(db.s.row.state, "UNKNOWN"); assert.equal(db.s.observations[0]![14], "TIMEOUT");
  finish({ status: 200, body: sync() }); await Promise.resolve(); await Promise.resolve(); assert.equal(db.s.observations.length, 1);
});

test("旧 worker 的迟到响应只记 STALE，不读取旧钥或推进新租约", async () => {
  const db = harness(); let keys = 0;
  const opts = options(db, async () => { Object.assign(db.s.row, { lease_version: "2", lease_owner: "worker_2" }); return { status: 200, body: sync() }; });
  opts.keyFor = () => { assert.equal(++keys, 1); return KEY; };
  const result = await executeSyntheticJoinpayRequest(opts, input);
  assert.equal(result.kind === "OBSERVED" && result.observation.outcome.event, "E9"); assert.equal(db.s.row.state, "SUBMITTING"); assert.equal(keys, 1);
});

test("终态、有效租约、首次请求本地已关闭、错资源/伪能力/profile 都不交换", async () => {
  for (const mode of ["terminal", "busy", "closed", "wrong-db", "forged-cap", "wrong-profile"] as const) {
    const db = harness(); const opts = options(db, async () => { throw Error("must not exchange"); });
    if (mode === "terminal") db.s.row.state = "ACCEPTED";
    if (mode === "busy") db.s.row.lease_until = 100_000;
    if (mode === "closed") db.s.closed = true;
    if (mode === "wrong-db") db.s.db = "other_database";
    if (mode === "forged-cap") opts.capability = { evidenceLevel: "SYNTHETIC_PROTOCOL" };
    if (mode === "wrong-profile") opts.binding = { ...binding, keyVersionRef: "other_key" };
    if (["wrong-db", "forged-cap", "wrong-profile"].includes(mode)) await assert.rejects(executeSyntheticJoinpayRequest(opts, input));
    else assert.deepEqual(await executeSyntheticJoinpayRequest(opts, input), { kind: "SKIPPED" });
    assert.equal(db.s.observations.length, 0);
  }
});

test("合成通知 ACK 等待 COMMIT；重复通知保留一个资金锚点，不形成 APPLIED", async () => {
  const db = harness(); const opts = { ...options(db), resolveMerchant: (m: string) => m === MERCHANT ? binding.merchantIdentityId : null };
  const r = await receiveSyntheticJoinpayNotification(opts, { rawQuery: notify(), rawRef: "synthetic:notify:1" });
  assert.equal(db.s.commits, 1); assert.equal(r.body, "success"); assert.equal(r.evidenceLevel, "SYNTHETIC_PROTOCOL");
  await receiveSyntheticJoinpayNotification(opts, { rawQuery: notify(), rawRef: "synthetic:notify:2" });
  assert.equal(db.s.row.state, "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE"); assert.equal(db.s.anchors.length, 1); assert.equal(db.s.anchors[0]!.confirmation_id, null);
  assert.equal(db.s.observations.length, 2);
});

test("通知 COMMIT 未确认、签名失败和无绑定均不能发 success", async () => {
  const db = harness(1); const opts = { ...options(db), resolveMerchant: () => binding.merchantIdentityId };
  assert.deepEqual(await receiveSyntheticJoinpayNotification(opts, { rawQuery: notify(), rawRef: "synthetic:notify:unknown" }),
    { status: 503, body: "fail", evidenceLevel: "SYNTHETIC_PROTOCOL" });
  const bad = harness();
  assert.equal((await receiveSyntheticJoinpayNotification({ ...options(bad), resolveMerchant: () => null }, { rawQuery: notify(), rawRef: "synthetic:unbound" })).body, "fail");
  assert.equal((await receiveSyntheticJoinpayNotification({ ...options(bad), resolveMerchant: () => binding.merchantIdentityId }, { rawQuery: notify().replace(/hmac=[^&]+/, "hmac=00000000000000000000000000000000"), rawRef: "synthetic:bad-signature" })).body, "fail");
});
