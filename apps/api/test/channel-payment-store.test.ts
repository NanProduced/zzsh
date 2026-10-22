// PAY-03A 离线测试：用脚本化的内存 PoolClient 验证领域判定、写入顺序与失败传播。
// 这里不连 PG；数据库层约束、真实锁等待与并发只在 channel-payment-postgres.test.ts 中验证（本轮 NOT_RUN）。
import { test } from "node:test";
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../src/config/config";
import { withTransaction } from "../src/auth/security-core";
import { confirmOrderPayment, createControlledPaymentSource } from "../src/order/payment-confirmation";
import { installChannelPaymentFixture } from "./channel-payment-postgres.test";
import type { PaymentDistributionStore } from "../src/finance/distribution-payment-store";
import { JOINPAY_SIGNATURE_ORDER } from "../src/order/joinpay-protocol";
import {
  acceptControlledPayment, bindChannelTransaction, claimPaymentRequestLease, createPaymentRequest, createSyntheticChannelRequestCapability,
  mapChannelOrderNo, readRecoverablePaymentRequest, recordExecutorResult, recordJoinpayNotify, wireAmountForCents, type ChannelBinding,
} from "../src/order/channel-payment-store";

const KEY = "SYNTHETIC_KEY_NOT_REAL_0003";
const MER = "888000000000003";
const config = { profile: "test", provider: "fake", testOperationsEnabled: true,
  database: { target: "local-compose", host: "127.0.0.1", port: 55432, name: "zzsh_test_order_joinpay_pay03a", user: "zzsh_order_joinpay_pay03a_r" } } as AppConfig;
const RESOURCE = "joinpay_pay03a";
const JOINPAY: ChannelBinding = { channel: "JOINPAY", merchantIdentityId: "mid_synth_01", configProfileId: "profile_v1", protocolVersion: "2.6", keyVersionRef: "kv1" };
const CONTROLLED: ChannelBinding = { channel: "CONTROLLED", merchantIdentityId: "merchant_scope", configProfileId: "controlled_v1", protocolVersion: "controlled-1", keyVersionRef: "none" };
const synth = () => createSyntheticChannelRequestCapability({ config, resourceSet: RESOURCE, evidenceLevel: "SYNTHETIC_PROTOCOL" });
const controlledCap = () => createSyntheticChannelRequestCapability({ config, resourceSet: RESOURCE, evidenceLevel: "CONTROLLED_TEST" });

type Row = Record<string, any>;
/** 内存 PoolClient：仅实现本模块与原 confirmOrderPayment 会发出的语句；未知写语句直接失败，防止静默通过。 */
function fakeDb(opts: { auditFailure?: boolean; expireAfterOrderLock?: boolean; confirmationAfterOrderLock?: boolean } = {}) {
  const s = {
    now: 1_000_000,
    orders: new Map<string, Row>([["order_1", { id: "order_1", renter_user_id: "renter", owner_user_id: "owner", account_id: "acct", status: "PENDING_PAYMENT", display_no: "ZZ261022-000123", currency: "CNY", total: "12345", holdOpen: true }]]),
    idem: new Map<string, Row>(), requests: new Map<string, Row>(), anchors: new Map<string, Row>(), observations: [] as Row[], confirmations: [] as Row[],
    seen: [] as string[],
  };
  const reqView = (r: Row) => ({ ...r, lease_current: undefined });
  const query = async (sql: string, p: any[] = []) => {
    s.seen.push(sql);
    const one = (row: Row | undefined) => ({ rows: row ? [row] : [], rowCount: row ? 1 : 0 });
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql)) return one(undefined);
    if (sql.includes("pg_advisory_xact_lock")) return one(undefined);
    if (sql.includes("current_database() AS db")) return one({ db: config.database.name, actor: config.database.user });
    if (sql.includes(`FROM "zzsh_supply"."idempotency_record"`)) { const r = s.idem.get(p[0] + "|" + p[1]); return one(r && { requestFingerprint: r.fp, responseStatus: r.status, responseBody: r.body, publishRequired: false }); }
    if (sql.includes(`INSERT INTO "zzsh_supply"."idempotency_record"`)) { s.idem.set(p[0] + "|" + p[1], { fp: p[2], status: p[3], body: JSON.parse(p[4]) }); return one(undefined); }
    if (sql.startsWith("SELECT renter_user_id FROM zzsh_order.rental_order")) { const o = s.orders.get(p[0]); return one(o && { renter_user_id: o.renter_user_id }); }
    if (sql.startsWith("SELECT renter_user_id, status, display_no")) {
      const o = s.orders.get(p[0]);
      const result = one(o && { renter_user_id: o.renter_user_id, status: o.status, display_no: o.display_no, currency: o.currency, total: o.total });
      if (o && opts.expireAfterOrderLock) o.holdOpen = false;
      if (o && opts.confirmationAfterOrderLock) s.confirmations.push({ view: { orderId: p[0], disposition: "REVIEW_REQUIRED" } });
      return result;
    }
    if (sql.startsWith("SELECT hold_until > clock_timestamp()")) return one({ open: s.orders.get(p[0])?.holdOpen === true, has_confirmation: s.confirmations.some((payment) => payment.view.orderId === p[0]) });
    if (sql.includes("FROM zzsh_order.payment_request WHERE order_id=$1")) return one([...s.requests.values()].find((r) => r.order_id === p[0]));
    if (sql.startsWith("SELECT 1 FROM zzsh_order.payment_request WHERE channel=")) return one([...s.requests.values()].find((r) => r.channel === p[0] && r.merchant_identity_id === p[1] && r.channel_order_no === p[2]));
    if (sql.startsWith("INSERT INTO zzsh_order.payment_request")) {
      const r = { id: p[0], order_id: p[1], channel: p[2], merchant_identity_id: p[3], config_profile_id: p[4], protocol_version: p[5], key_version_ref: p[6], platform_order_no: p[7], channel_order_no: p[8], amount_cents: p[9], currency: "CNY", wire_amount_yuan: p[10], method: p[11], evidence_level: p[12], state: "SUBMITTING", revision: "1", lease_version: "0", lease_owner: null, lease_until: null };
      s.requests.set(r.id, r); return one({ ...r });
    }
    if (sql.startsWith("UPDATE zzsh_order.payment_request\n      SET lease_version")) {
      const r = s.requests.get(p[0]);
      if (!r || !p[3].includes(r.state) || (r.lease_until !== null && r.lease_until > s.now)) return one(undefined);
      Object.assign(r, { lease_version: String(BigInt(r.lease_version) + 1n), lease_owner: p[1], lease_until: s.now + p[2] * 1000, revision: String(BigInt(r.revision) + 1n) });
      return one({ id: r.id, lease_version: r.lease_version, channel_order_no: r.channel_order_no, state: r.state });
    }
    if (sql.includes("AS lease_current")) { const r = s.requests.get(p[0]); return one(r && { ...reqView(r), lease_current: r.lease_version === p[1] && r.lease_owner === p[2] && r.lease_until > s.now }); }
    if (sql.includes("FROM zzsh_order.payment_request WHERE id=$1")) return one(s.requests.get(p[0]) && { ...s.requests.get(p[0]) });
    if (sql.includes("WHERE channel='JOINPAY' AND merchant_identity_id=$1 AND channel_order_no=$2 FOR UPDATE")) return one([...s.requests.values()].find((r) => r.channel === "JOINPAY" && r.merchant_identity_id === p[0] && r.channel_order_no === p[1]));
    if (sql.startsWith("UPDATE zzsh_order.payment_request SET state=")) {
      const r = s.requests.get(p[0]);
      const leaseOk = p[4] === null || (r?.lease_version === p[4] && r?.lease_until > s.now);
      if (!r || r.state !== p[2] || r.revision !== p[3] || !leaseOk) return one(undefined);
      Object.assign(r, { state: p[1], revision: String(BigInt(r.revision) + 1n) }); return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith("INSERT INTO zzsh_order.payment_channel_transaction")) {
      assert.ok(sql.includes("DO NOTHING") && !sql.includes("DO UPDATE"), "归属不得被 ON CONFLICT 覆盖");
      const k = [p[1], p[2], p[3]].join("|"); if (s.anchors.has(k)) return one(undefined);
      s.anchors.set(k, { id: p[0], native_order_id: p[4], request_id: p[5], confirmation_id: p[6], evidence_level: p[7] }); return one({ id: p[0] });
    }
    if (sql.startsWith("SELECT id, native_order_id, confirmation_id FROM zzsh_order.payment_channel_transaction")) return one(s.anchors.get(p.join("|")));
    if (sql.startsWith("INSERT INTO zzsh_order.payment_channel_observation")) {
      const cols = ["id", "request_id", "channel", "merchant_identity_id", "channel_order_no", "channel_trx_no", "config_profile_id", "protocol_version", "key_version_ref", "operation", "source", "evidence_level", "event", "result", "reason", "channel_status", "provider_paid_at_raw", "raw_sha256", "raw_ref", "verify_outcome", "lease_version", "state_before", "state_after", "stale", "late", "conflict"];
      s.observations.push(Object.fromEntries(cols.map((c, i) => [c, p[i]]))); return one(undefined);
    }
    // ---- 原 confirmOrderPayment 语句（与 distribution-payment-integration.test.ts 同口径）----
    if (sql.includes("FROM zzsh_order.payment_confirmation")) return one(s.confirmations.find((c) => c.source === p[0] && c.merchant_scope_id === p[1] && c.provider_transaction_id === p[2])?.view);
    if (sql.startsWith("SELECT account_id")) { const o = s.orders.get(p[0]); return one(o && { account_id: o.account_id, renter_user_id: o.renter_user_id, owner_user_id: o.owner_user_id }); }
    if (sql.includes("WHERE id = ANY")) return { rows: [{ id: "owner" }, { id: "renter" }], rowCount: 2 };
    if (sql.startsWith("SELECT id FROM zzsh_supply.rental_account")) return one({ id: "acct" });
    if (sql.startsWith("SELECT status, display_no")) { const o = s.orders.get(p[0])!; return one({ status: o.status, display_no: o.display_no, currency: o.currency, total: o.total, hold: "2026-10-23T00:00:00.000000Z" }); }
    if (sql.includes(" AS accepted,")) return one({ accepted: "2026-10-22T04:00:00.000000Z", open: s.orders.get("order_1")!.holdOpen });
    if (sql.startsWith("INSERT INTO zzsh_order.payment_confirmation")) {
      s.confirmations.push({ source: p[1], merchant_scope_id: p[2], provider_transaction_id: p[3], view: { id: p[0], orderId: p[5], merchantOrderNo: p[4], amountCents: p[6], currency: p[7], providerPaidAt: p[8], disposition: p[10], reasonCode: p[11] } });
      return one(undefined);
    }
    if (sql.startsWith("UPDATE zzsh_order.rental_order SET status='PAID'")) { s.orders.get(p[0])!.status = "PAID"; return { rows: [], rowCount: 1 }; }
    if (sql.startsWith("INSERT INTO zzsh_order.im_order_group")) return one(undefined);
    if (sql.includes(`INSERT INTO "zzsh_iam"."audit_event"`)) { if (opts.auditFailure) throw Object.assign(new Error("audit unavailable"), { code: "42501" }); return one(undefined); }
    throw new Error(`unexpected SQL in fake: ${sql.slice(0, 80)}`);
  };
  const client = { query, release() {} } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  const writes = () => s.seen.filter((q) => /^(INSERT|UPDATE|DELETE)/.test(q));
  return { s, client, pool, writes };
}

// 独立参考签名器（不从模块导入签名函数）
const md5 = (order: readonly string[], v: Record<string, string | undefined>, key = KEY) => createHash("md5").update(order.map((n) => v[n] ?? "").join("") + key, "utf8").digest("hex");
const keyFor = (ref: string) => (ref === "kv1" ? KEY : "OTHER_SYNTHETIC_KEY");
function syncBody(orderNo: string, patch: Record<string, string | undefined> = {}) {
  const v: Record<string, string | undefined> = { r0_Version: "2.6", r1_MerchantNo: MER, r2_OrderNo: orderNo, r3_Amount: "123.45", r4_Cur: "1", r6_FrpCode: "ALIPAY_NATIVE", r7_TrxNo: "TRX_SYNC_1", ra_Code: "102", rb_CodeMsg: "处理中", rc_Result: "https://qr.example.invalid/p", ...patch };
  const clean = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined));
  return JSON.stringify({ ...clean, hmac: md5(JOINPAY_SIGNATURE_ORDER.uniPaySyncResponse, v) });
}
function queryBody(orderNo: string, patch: Record<string, string | undefined> = {}) {
  const v: Record<string, string | undefined> = { r0_Version: "2.6", r1_MerchantNo: MER, r2_OrderNo: orderNo, r3_Amount: "123.45", r5_TrxNo: "TRX_Q_1", r7_Fee: "0.00", r8_FrpCode: "ALIPAY_NATIVE", ra_Status: "100", rb_Code: "100", rc_CodeMsg: "", rd_OpenId: "o_synth", re_DiscountAmount: "0.00", rf_PayTime: "2026-10-22 10:00:00", rj_BankCode: "ALIPAY", ro_SettleAmount: "123.45", ...patch };
  const clean = Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined));
  return JSON.stringify({ ...clean, hmac: md5(JOINPAY_SIGNATURE_ORDER.queryOrderResponse, v) });
}
function notifyQs(orderNo: string, patch: Record<string, string | undefined> = {}, key = KEY) {
  const v: Record<string, string | undefined> = { r0_Version: "2.6", r1_MerchantNo: MER, r2_OrderNo: orderNo, r3_Amount: "123.45", r4_Cur: "1", r6_Status: "100", r7_TrxNo: "TRX_N_1", ra_PayTime: "2026-10-22 10:00:00", rb_DealTime: "2026-10-22 10:00:05", rc_BankCode: "ALIPAY", re_DiscountAmount: "0.00", rk_FrpCode: "ALIPAY_NATIVE", ro_SettleAmount: "123.45", ...patch };
  const pairs = Object.entries(v).filter((e): e is [string, string] => e[1] !== undefined);
  pairs.push(["hmac", md5(JOINPAY_SIGNATURE_ORDER.asyncNotify, v, key)]);
  return new URLSearchParams(pairs).toString();
}
const resolveMerchant = (no: string) => (no === MER ? "mid_synth_01" : null);

async function newRequest(db: ReturnType<typeof fakeDb>, binding = JOINPAY, cap: unknown = synth()) {
  const r = await createPaymentRequest(db.client, { actor: { userId: "renter" }, orderId: "order_1", idempotencyKey: "idem-1", method: "ALIPAY_NATIVE", binding, capability: cap });
  return r.body as { requestId: string; channelOrderNo: string; state: string };
}

test("原号映射与金额：'-'→'_' 仅首次确定；CONTROLLED 保持 display_no；金额复用 PAY-02 整数分范围", () => {
  assert.equal(mapChannelOrderNo("JOINPAY", "ZZ261022-000123"), "ZZ261022_000123");
  assert.equal(mapChannelOrderNo("CONTROLLED", "ZZ261022-000123"), "ZZ261022-000123");
  for (const bad of ["ZZ.1", "单号-1", "A".repeat(51), ""]) assert.throws(() => mapChannelOrderNo("JOINPAY", bad), { code: "INVALID_ARGUMENT" }, bad);
  assert.equal(wireAmountForCents("12345"), "123.45");
  assert.equal(wireAmountForCents("9999999999999999"), "99999999999999.99");
  for (const bad of ["0", "10000000000000000", "1.5", "-1", "1e3"]) assert.throws(() => wireAmountForCents(bad), { code: "INVALID_ARGUMENT" }, bad);
});

test("冻结绑定：首次请求持久原号/金额/商户/profile/钥版本；重启后只读回原号", async () => {
  const db = fakeDb();
  const r = await newRequest(db);
  assert.equal(r.channelOrderNo, "ZZ261022_000123");
  assert.equal(r.state, "SUBMITTING");
  const row = db.s.requests.get(r.requestId)!;
  assert.deepEqual([row.merchant_identity_id, row.config_profile_id, row.protocol_version, row.key_version_ref, row.amount_cents, row.wire_amount_yuan, row.platform_order_no],
    ["mid_synth_01", "profile_v1", "2.6", "kv1", "12345", "123.45", "ZZ261022-000123"]);
  db.s.orders.get("order_1")!.display_no = "ZZ261022-999999"; // 即使外部值变化，恢复也只读持久原号
  const rec = await readRecoverablePaymentRequest(db.client, r.requestId);
  assert.equal(rec?.channelOrderNo, "ZZ261022_000123");
  assert.equal(rec?.binding.keyVersionRef, "kv1");
  assert.equal(db.writes().filter((q) => q.startsWith("INSERT INTO zzsh_order.payment_request")).length, 1);
});

test("幂等：同 key 重放、同 key 异 method 409、异 key 返回原请求不建第二个；重放仍重新授权", async () => {
  const db = fakeDb();
  const first = await newRequest(db);
  const replay = await createPaymentRequest(db.client, { actor: { userId: "renter" }, orderId: "order_1", idempotencyKey: "idem-1", method: "ALIPAY_NATIVE", binding: JOINPAY, capability: synth() });
  assert.equal(replay.replayed, true);
  assert.equal((replay.body as { requestId: string }).requestId, first.requestId);
  await assert.rejects(createPaymentRequest(db.client, { actor: { userId: "renter" }, orderId: "order_1", idempotencyKey: "idem-1", method: "WEIXIN_NATIVE", binding: JOINPAY, capability: synth() }), { code: "IDEMPOTENCY_KEY_REUSED" });
  const other = await createPaymentRequest(db.client, { actor: { userId: "renter" }, orderId: "order_1", idempotencyKey: "idem-2", method: "ALIPAY_NATIVE", binding: JOINPAY, capability: synth() });
  assert.equal((other.body as { requestId: string; existing: boolean }).requestId, first.requestId);
  assert.equal((other.body as { existing: boolean }).existing, true);
  assert.equal(db.s.requests.size, 1);
  await assert.rejects(createPaymentRequest(db.client, { actor: { userId: "renter" }, orderId: "order_1", idempotencyKey: "idem-3", method: "WEIXIN_NATIVE", binding: JOINPAY, capability: synth() }), { code: "CONFLICT" });
  assert.equal(db.s.idem.size, 2);
  // 他人用同 key 重放：授权在重放前执行，返回 404 而不是原回执
  await assert.rejects(createPaymentRequest(db.client, { actor: { userId: "intruder" }, orderId: "order_1", idempotencyKey: "idem-1", method: "ALIPAY_NATIVE", binding: JOINPAY, capability: synth() }), { code: "NOT_FOUND" });
  // 订单换主后原 renter 重放同样被拒（按当前对象授权）
  db.s.orders.get("order_1")!.renter_user_id = "someone_else";
  await assert.rejects(createPaymentRequest(db.client, { actor: { userId: "renter" }, orderId: "order_1", idempotencyKey: "idem-1", method: "ALIPAY_NATIVE", binding: JOINPAY, capability: synth() }), { code: "NOT_FOUND" });
  await assert.rejects(createPaymentRequest(db.client, { actor: { userId: "renter" }, orderId: "order_1", idempotencyKey: "", method: "ALIPAY_NATIVE", binding: JOINPAY, capability: synth() }), { code: "MISSING_IDEMPOTENCY_KEY" });
});

test("能力关闭/伪造能力/不可付款：抛错且不留成功幂等回执、不写请求", async () => {
  for (const cap of [null, {}, Object.freeze({ evidenceLevel: "SYNTHETIC_PROTOCOL" }), controlledCap()]) {
    const db = fakeDb();
    await assert.rejects(newRequest(db, JOINPAY, cap), { code: "EVIDENCE_UNAVAILABLE" });
    assert.equal(db.s.idem.size, 0);
    assert.equal(db.s.requests.size, 0);
  }
  for (const [patch, code] of [[{ status: "CANCELLED" }, "CONFLICT"], [{ holdOpen: false }, "CONFLICT"], [{ display_no: "ZZ.bad" }, "INVALID_ARGUMENT"], [{ total: "10000000000000000" }, "CONFLICT"]] as const) {
    const db = fakeDb();
    Object.assign(db.s.orders.get("order_1")!, patch);
    await assert.rejects(newRequest(db), { code }, JSON.stringify(patch));
    assert.equal(db.s.idem.size, 0);
    assert.equal(db.s.requests.size, 0);
  }
  for (const c of [{ ...config, profile: "prod" }, { ...config, provider: "real" }, { ...config, testOperationsEnabled: false }, { ...config, database: { ...config.database, name: "zzsh_dev" } }])
    assert.throws(() => createSyntheticChannelRequestCapability({ config: c as AppConfig, resourceSet: RESOURCE, evidenceLevel: "SYNTHETIC_PROTOCOL" }));
});

test("lease：PG 时钟条件领取；持有中不可再领；过期后版本递增且原号不变；终态不可领", async () => {
  const db = fakeDb();
  const r = await newRequest(db);
  const a = await claimPaymentRequestLease(db.client, { requestId: r.requestId, owner: "worker-a", ttlSeconds: 30 });
  assert.equal(a?.leaseVersion, "1");
  assert.equal(await claimPaymentRequestLease(db.client, { requestId: r.requestId, owner: "worker-b", ttlSeconds: 30 }), null);
  const sql = db.s.seen.find((q) => q.includes("SET lease_version"))!;
  assert.ok(sql.includes("lease_until <= clock_timestamp()") && sql.includes("clock_timestamp()+make_interval"), "lease 必须使用 PG 时钟");
  db.s.now += 31_000;
  const b = await claimPaymentRequestLease(db.client, { requestId: r.requestId, owner: "worker-b", ttlSeconds: 30 });
  assert.equal(b?.leaseVersion, "2");
  assert.equal(b?.channelOrderNo, a?.channelOrderNo);
  db.s.requests.get(r.requestId)!.state = "ACCEPTED";
  db.s.now += 31_000;
  assert.equal(await claimPaymentRequestLease(db.client, { requestId: r.requestId, owner: "worker-c", ttlSeconds: 30 }), null);
});

test("#19/#8：当前 lease 的可信同步 102 → PROCESSING_UNCONFIRMED；旧 lease 只追加 STALE，不覆盖新 lease 与状态", async () => {
  const db = fakeDb();
  const r = await newRequest(db);
  const a = (await claimPaymentRequestLease(db.client, { requestId: r.requestId, owner: "worker-a", ttlSeconds: 30 }))!;
  db.s.now += 31_000;
  const b = (await claimPaymentRequestLease(db.client, { requestId: r.requestId, owner: "worker-b", ttlSeconds: 30 }))!;
  const stale = await recordExecutorResult(db.client, { requestId: r.requestId, leaseVersion: a.leaseVersion, leaseOwner: "worker-a", operation: "SYNC_RESPONSE", body: syncBody(r.channelOrderNo, { ra_Code: "100" }), rawRef: "raw://a", merchantNo: MER, keyFor });
  assert.equal(stale.outcome.event, "E9");
  assert.equal(db.s.requests.get(r.requestId)!.state, "SUBMITTING");
  assert.equal(db.s.requests.get(r.requestId)!.lease_owner, "worker-b");
  assert.equal(db.s.observations.at(-1)!.stale, true);
  const ok = await recordExecutorResult(db.client, { requestId: r.requestId, leaseVersion: b.leaseVersion, leaseOwner: "worker-b", operation: "SYNC_RESPONSE", body: syncBody(r.channelOrderNo), rawRef: "raw://b", merchantNo: MER, keyFor });
  assert.equal(ok.stateAfter, "PROCESSING_UNCONFIRMED");
  assert.equal(db.s.requests.get(r.requestId)!.state, "PROCESSING_UNCONFIRMED");
  assert.equal(db.s.requests.size, 1);
  assert.equal(db.s.observations.length, 2);
  assert.equal(db.s.observations.at(-1)!.evidence_level, "SYNTHETIC_PROTOCOL");
  assert.equal(ok.formalAcceptance, false);
  // 同 owner 但 lease 已过期也视为旧 lease
  db.s.now += 31_000;
  assert.equal((await recordExecutorResult(db.client, { requestId: r.requestId, leaseVersion: b.leaseVersion, leaseOwner: "worker-b", operation: "QUERY_RESPONSE", body: queryBody(r.channelOrderNo), rawRef: "raw://c", merchantNo: MER, keyFor })).outcome.event, "E9");
  assert.equal(db.s.requests.get(r.requestId)!.state, "PROCESSING_UNCONFIRMED");
  assert.equal(db.s.anchors.size, 0);
});

test("同步 schema 失败 SUBMITTING→UNKNOWN 仅 UNVERIFIED；#22 查单缺 rd_OpenId 不改状态、只追加 UNVERIFIED", async () => {
  const db = fakeDb();
  const r = await newRequest(db);
  const l = (await claimPaymentRequestLease(db.client, { requestId: r.requestId, owner: "w", ttlSeconds: 30 }))!;
  const bad = await recordExecutorResult(db.client, { requestId: r.requestId, leaseVersion: l.leaseVersion, leaseOwner: "w", operation: "SYNC_RESPONSE", body: syncBody(r.channelOrderNo, { r7_TrxNo: undefined }), rawRef: "raw://1", merchantNo: MER, keyFor });
  assert.equal(bad.stateAfter, "UNKNOWN");
  assert.equal(db.s.observations.at(-1)!.evidence_level, "UNVERIFIED");
  const q = await recordExecutorResult(db.client, { requestId: r.requestId, leaseVersion: l.leaseVersion, leaseOwner: "w", operation: "QUERY_RESPONSE", body: queryBody(r.channelOrderNo, { rd_OpenId: undefined }), rawRef: "raw://2", merchantNo: MER, keyFor });
  assert.equal(q.outcome.result, "QUERY_SCHEMA_REJECTED");
  assert.equal(q.outcome.reason, "PROTOCOL_FIELD_MISSING");
  assert.equal(db.s.requests.get(r.requestId)!.state, "UNKNOWN");
  assert.equal(db.s.observations.at(-1)!.evidence_level, "UNVERIFIED");
  assert.equal(db.s.anchors.size, 0);
});

test("通知不要求 lease；E4 登记合成锚点；无主通知 request_id=null；渠道时间仅原文", async () => {
  const db = fakeDb();
  const r = await newRequest(db);
  const n = await recordJoinpayNotify(db.client, { rawQuery: notifyQs(r.channelOrderNo), rawRef: "raw://n1", resolveMerchant, keyFor });
  assert.equal(n.outcome.event, "E4");
  assert.equal(n.stateAfter, "CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE");
  assert.equal(n.anchor?.binding, "NEW");
  assert.equal([...db.s.anchors.values()][0]!.evidence_level, "SYNTHETIC_PROTOCOL");
  assert.equal([...db.s.anchors.values()][0]!.confirmation_id, null);
  assert.equal(db.s.observations.at(-1)!.provider_paid_at_raw, "2026-10-22 10:00:00");
  assert.equal(db.s.observations.at(-1)!.lease_version, null);
  assert.ok(!db.s.seen.some((q) => q.startsWith("INSERT INTO zzsh_order.payment_confirmation")), "合成观察不得进入 0036");
  const orphan = await recordJoinpayNotify(db.client, { rawQuery: notifyQs("ZZ_NO_SUCH_ORDER"), rawRef: "raw://n2", resolveMerchant, keyFor });
  assert.equal(orphan.outcome.result, "BINDING_NOT_FOUND");
  assert.equal(db.s.observations.at(-1)!.request_id, null);
  assert.equal(db.s.observations.at(-1)!.state_after, null);
  const garbage = await recordJoinpayNotify(db.client, { rawQuery: "%", rawRef: "raw://n3", resolveMerchant, keyFor });
  assert.equal(garbage.outcome.event, "E11");
  assert.equal(db.s.observations.at(-1)!.request_id, null);
  const wrongKey = await recordJoinpayNotify(db.client, { rawQuery: notifyQs(r.channelOrderNo, {}, "OTHER_SYNTHETIC_KEY"), rawRef: "raw://n4", resolveMerchant, keyFor });
  assert.equal(wrongKey.outcome.result, "SIGNATURE_INVALID");
  assert.equal(db.s.observations.at(-1)!.evidence_level, "UNVERIFIED");
});

test("#12/#13 资金键不含 profile/钥版本：同一 trx 二次登记到他单为 OWNED_ELSEWHERE，不迁移、不覆盖", async () => {
  const db = fakeDb();
  const first = await bindChannelTransaction(db.client, { channel: "JOINPAY", merchantIdentityId: "mid_synth_01", channelTrxNo: "TRX_X", orderId: "order_1", requestId: null, confirmationId: null, evidenceLevel: "SYNTHETIC_PROTOCOL" });
  const again = await bindChannelTransaction(db.client, { channel: "JOINPAY", merchantIdentityId: "mid_synth_01", channelTrxNo: "TRX_X", orderId: "order_1", requestId: null, confirmationId: null, evidenceLevel: "SYNTHETIC_PROTOCOL" });
  const other = await bindChannelTransaction(db.client, { channel: "JOINPAY", merchantIdentityId: "mid_synth_01", channelTrxNo: "TRX_X", orderId: "order_2", requestId: null, confirmationId: null, evidenceLevel: "SYNTHETIC_PROTOCOL" });
  assert.deepEqual([first.binding, again.binding, other.binding], ["NEW", "SAME", "OWNED_ELSEWHERE"]);
  assert.equal(other.ownerOrderId, "order_1");
  assert.equal(db.s.anchors.size, 1);
  // 通知层：锚点属他单时不迁移，追加冲突观察
  const r = await newRequest(db);
  await bindChannelTransaction(db.client, { channel: "JOINPAY", merchantIdentityId: "mid_synth_01", channelTrxNo: "TRX_N_1", orderId: "order_9", requestId: null, confirmationId: null, evidenceLevel: "SYNTHETIC_PROTOCOL" });
  const n = await recordJoinpayNotify(db.client, { rawQuery: notifyQs(r.channelOrderNo), rawRef: "raw://x", resolveMerchant, keyFor });
  assert.equal(n.stateAfter, "SUBMITTING");
  assert.equal(db.s.observations.at(-1)!.result, "TRANSACTION_OWNED_ELSEWHERE");
  assert.equal(db.s.observations.at(-1)!.conflict, true);
});

// ---------- 受控接纳 ----------
const source = () => createControlledPaymentSource({ config, resourceSet: RESOURCE, appId: "app", merchantScopeId: "merchant_scope", allowedOrderIds: ["order_1"] });
const factInput = { orderId: "order_1", merchantOrderNo: "ZZ261022-000123", providerTransactionId: "ctrl_trx_1", amountCents: "12345", currency: "CNY", providerPaidAt: "2026-10-22T02:00:00.000Z", requestId: "req_1" };
function store(db: ReturnType<typeof fakeDb>, o: { missing?: boolean; recordFailure?: boolean } = {}) {
  const calls: string[] = [];
  const value = {
    prepare: async (c: PoolClient) => { assert.equal(c, db.client); calls.push("prepare"); return o.missing ? null : { orderId: "order_1" }; },
    record: async (c: PoolClient) => { assert.equal(c, db.client); calls.push("record"); if (o.recordFailure) throw new Error("basis unavailable"); return {}; },
    readOriginal: async () => { calls.push("readOriginal"); return { knowledge: "UNKNOWN", basis: null }; },
  } as unknown as PaymentDistributionStore;
  return { value, calls };
}

test("受控正例：请求 SUBMITTING→ACCEPTED，锚点关联 confirmation，同事务；重放不增记账/分佣/观察", async () => {
  const db = fakeDb();
  const r = await newRequest(db, CONTROLLED, controlledCap());
  assert.equal(r.channelOrderNo, "ZZ261022-000123");
  const st = store(db);
  const fact = source()(factInput);
  const a = await acceptControlledPayment(db.client, { fact, distribution: st.value, requestId: r.requestId });
  assert.equal(a.payment.disposition, "APPLIED");
  assert.equal(a.requestState, "ACCEPTED");
  assert.equal(a.anchor?.confirmationId, a.payment.confirmationId);
  assert.deepEqual(st.calls, ["prepare", "record"]);
  const anchorSql = db.s.seen.findIndex((q) => q.startsWith("INSERT INTO zzsh_order.payment_channel_transaction"));
  const confirmSql = db.s.seen.findIndex((q) => q.startsWith("INSERT INTO zzsh_order.payment_confirmation"));
  const requestLock = db.s.seen.findIndex((q) => q.includes("FROM zzsh_order.payment_request WHERE id=$1 FOR UPDATE"));
  const dispatch = db.s.seen.findIndex((q, i) => i > requestLock && q.includes("pg_advisory_xact_lock"));
  assert.ok(requestLock >= 0 && requestLock < dispatch && confirmSql < anchorSql, "新锁先于原锁；锚点在 confirmation 之后同事务写入");
  const observations = db.s.observations.length;
  const replay = await acceptControlledPayment(db.client, { fact: source()(factInput), distribution: st.value, requestId: r.requestId });
  assert.equal(replay.payment.replay, true);
  assert.deepEqual(st.calls, ["prepare", "record", "readOriginal"]);
  assert.equal(db.s.confirmations.length, 1);
  assert.equal(db.s.anchors.size, 1);
  assert.equal(db.s.observations.length, observations);
  // #20：ACCEPTED 后另一笔流水 → 原 confirmation 不变、请求仍 ACCEPTED、只追加迟到/冲突观察
  const late = await acceptControlledPayment(db.client, { fact: source()({ ...factInput, providerTransactionId: "ctrl_trx_2", requestId: "req_2" }), distribution: st.value, requestId: r.requestId });
  assert.equal(late.payment.reasonCode, "DUPLICATE_PAYMENT");
  assert.equal(late.requestState, "ACCEPTED");
  assert.equal(db.s.observations.at(-1)!.late, true);
  assert.equal(db.s.observations.at(-1)!.conflict, true);
});

test("伪造 capability、缺分佣 store、准入缺失：拒绝且不降级为无 distribution 的成功", async () => {
  const db = fakeDb();
  await assert.rejects(acceptControlledPayment(db.client, { fact: { ...source()(factInput) }, distribution: store(db).value }), /not verified/);
  await assert.rejects(acceptControlledPayment(db.client, { fact: source()(factInput), distribution: undefined as unknown as PaymentDistributionStore }), { code: "EVIDENCE_UNAVAILABLE" });
  const missing = store(db, { missing: true });
  await assert.rejects(acceptControlledPayment(db.client, { fact: source()(factInput), distribution: missing.value }), { code: "EVIDENCE_UNAVAILABLE" });
  assert.equal(db.s.confirmations.length, 0);
  assert.equal(db.s.anchors.size, 0);
  assert.ok(!db.writes().length, db.writes().join("\n"));
  // 合成 JOINPAY 请求不能被包成受控事实接纳
  const j = fakeDb();
  const r = await newRequest(j);
  await assert.rejects(acceptControlledPayment(j.client, { fact: source()({ ...factInput, merchantOrderNo: r.channelOrderNo }), distribution: store(j).value, requestId: r.requestId }), { code: "CONFLICT" });
  assert.equal(j.s.confirmations.length, 0);
});

test("分佣/审计失败传播给事务所有者：ROLLBACK，从不 COMMIT", async () => {
  for (const auditFailure of [false, true]) {
    const db = fakeDb({ auditFailure });
    const r = await newRequest(db, CONTROLLED, controlledCap());
    db.s.seen.length = 0;
    const st = store(db, { recordFailure: !auditFailure });
    await assert.rejects(withTransaction(db.pool, (c) => acceptControlledPayment(c, { fact: source()(factInput), distribution: st.value, requestId: r.requestId })), /unavailable/);
    assert.equal(db.s.seen.at(-1), "ROLLBACK");
    assert.ok(!db.s.seen.includes("COMMIT"));
  }
});

test("模块源码：无环境变量/网络/文件/顶层连库；PG 测试模块无顶层连库或默认资源", () => {
  const src = readFileSync(join(__dirname, "../src/order/channel-payment-store.js"), "utf8");
  for (const bad of ["process.env", "fetch(", "new Pool", "require(\"http", "require(\"node:http", "require(\"node:fs", "require(\"fs"]) assert.ok(!src.includes(bad), bad);
  const pg = readFileSync(join(__dirname, "channel-payment-postgres.test.js"), "utf8");
  for (const bad of ["process.env", "new Pool", "pool.connect()", "55432"]) assert.ok(!pg.split("\n").some((l) => l.startsWith(bad)), bad);
  assert.ok(!pg.includes("process.env"), "PG 用例不得读取环境回退");
  assert.ok(!pg.includes("order-reservation.test"), "不得导入会自动建库/启动 HTTP 的根 suite");
});

test("Master：新请求按合同返回 202，持久幂等 scope 与 method 指纹稳定", async () => {
  const db = fakeDb();
  const result = await createPaymentRequest(db.client, { actor: { userId: "renter" }, orderId: "order_1", idempotencyKey: "first", method: "ALIPAY_NATIVE", binding: JOINPAY, capability: synth() });
  assert.equal(result.status, 202);
  const operation = "order.payment.channel-request";
  const key = JSON.stringify(["user", "renter", operation, "order_1"]) + "|first";
  assert.equal(db.s.idem.get(key)?.fp, createHash("sha256").update(JSON.stringify([operation, "order_1", { method: "ALIPAY_NATIVE" }])).digest("hex"));
});

test("Master：异 key 同 method 先恢复原请求，不受能力关闭或订单已付影响", async () => {
  const db = fakeDb();
  const original = await newRequest(db);
  Object.assign(db.s.orders.get("order_1")!, { status: "PAID", holdOpen: false });
  const restored = await createPaymentRequest(db.client, { actor: { userId: "renter" }, orderId: "order_1", idempotencyKey: "restore", method: "ALIPAY_NATIVE", binding: JOINPAY, capability: null });
  assert.equal(restored.status, 200);
  assert.equal((restored.body as { requestId: string }).requestId, original.requestId);
  assert.equal(db.s.requests.size, 1);
});

test("Master：同 key 重放使用原回执，不把当前配置 channel 放进 body 指纹", async () => {
  const db = fakeDb();
  const original = await newRequest(db);
  const restored = await createPaymentRequest(db.client, { actor: { userId: "renter" }, orderId: "order_1", idempotencyKey: "idem-1", method: "ALIPAY_NATIVE", binding: CONTROLLED, capability: null });
  assert.equal(restored.replayed, true);
  assert.equal((restored.body as { requestId: string }).requestId, original.requestId);
  assert.equal(db.s.requests.get(original.requestId)!.channel, "JOINPAY");
});

test("Master：旧 lease 不依赖已退役的钥，只追加 STALE", async () => {
  const db = fakeDb();
  const r = await newRequest(db);
  const a = (await claimPaymentRequestLease(db.client, { requestId: r.requestId, owner: "old", ttlSeconds: 1 }))!;
  db.s.now += 2000;
  const b = (await claimPaymentRequestLease(db.client, { requestId: r.requestId, owner: "new", ttlSeconds: 30 }))!;
  const result = await recordExecutorResult(db.client, { requestId: r.requestId, leaseVersion: a.leaseVersion, leaseOwner: "old", operation: "QUERY_RESPONSE", body: "not JSON", rawRef: "synthetic:stale", merchantNo: MER, keyFor: () => { throw Error("retired key must not be read"); } });
  assert.equal(result.outcome.event, "E9");
  assert.equal(db.s.requests.get(r.requestId)!.lease_version, b.leaseVersion);
  assert.equal(db.s.observations.length, 1);
  assert.equal(db.s.anchors.size, 0);
});

test("Master：原受控付款已接纳但请求未回写时，重放修复请求且不重复分佣", async () => {
  const db = fakeDb();
  const r = await newRequest(db, CONTROLLED, controlledCap());
  const st = store(db);
  const original = await confirmOrderPayment(db.client, source()(factInput), st.value);
  assert.equal(original.disposition, "APPLIED");
  assert.equal(db.s.requests.get(r.requestId)!.state, "SUBMITTING");
  const restored = await acceptControlledPayment(db.client, { fact: source()(factInput), distribution: st.value, requestId: r.requestId });
  assert.equal(restored.payment.replay, true);
  assert.equal(restored.requestState, "ACCEPTED");
  assert.equal(db.s.observations.length, 1);
  const again = await acceptControlledPayment(db.client, { fact: source()(factInput), distribution: st.value, requestId: r.requestId });
  assert.equal(again.payment.replay, true);
  assert.equal(db.s.observations.length, 1);
  assert.equal(st.calls.filter((call) => call === "record").length, 1);
});

test("Master：首次请求拒绝已有待核 confirmation，不形成第二支付意图", async () => {
  const db = fakeDb();
  const reviewed = await confirmOrderPayment(db.client, source()({ ...factInput, amountCents: "12346" }), store(db).value);
  assert.equal(reviewed.disposition, "REVIEW_REQUIRED");
  await assert.rejects(newRequest(db), { code: "CONFLICT" });
  assert.equal(db.s.requests.size, 0);
  assert.equal(db.s.idem.size, 0);
});

test("Master：创建支付请求在订单行锁之后重查 hold 与确认，不留过期或待核意图", async () => {
  for (const options of [{ expireAfterOrderLock: true }, { confirmationAfterOrderLock: true }]) {
  const db = fakeDb(options);
  await assert.rejects(newRequest(db), (error: { status?: number; paymentReason?: string }) => error.status === 409 && error.paymentReason === "ORDER_NOT_PAYABLE");
  assert.equal(db.s.requests.size, 0);
  assert.equal(db.s.idem.size, 0);
  assert.ok(db.s.seen.some((sql) => sql.includes("FOR UPDATE OF o")));
  }
});

test("Master：fixture SQL 由已绑定调用者显式传入，编译目录无需复制 SQL 资源", async () => {
  const seen: string[] = [];
  const client = { release() {}, async query(sql: string) {
    seen.push(sql);
    return { rows: sql.includes("AS db") ? [{ db: config.database.name, marker: "zzsh:order-reservation-test:v1" }] : [], rowCount: 0 };
  } } as unknown as PoolClient;
  const pool = { connect: async () => client } as unknown as Pool;
  const sql = "-- SYNTHETIC_INSTALLER_PROBE_NO_DATABASE";
  await installChannelPaymentFixture(pool, { database: config.database.name, runtimeRole: config.database.user, schemaSql: sql });
  assert.ok(seen.includes(sql));
  assert.equal(seen.at(-1), "COMMIT");
});
