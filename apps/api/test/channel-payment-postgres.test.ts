// PAY-03A 隔离 PG 用例（可执行，非占位）。本模块无顶层连库、无默认资源、不读环境变量；
// 仅由已签窗口的 harness 以显式 Options 调用 runChannelPaymentPostgres（接线见 integration-hunks.md）。
// 本轮未取得窗口：全部 NOT_RUN / READY_FOR_SIGNED_WINDOW。
import { strict as assert } from "node:assert";
import { createHash, randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import type { Pool, PoolClient } from "pg";
import type { AppConfig } from "../src/config/config";
import { withTransaction } from "../src/auth/security-core";
import { createPaymentDistributionStore } from "../src/finance/distribution-payment-store";
import { JOINPAY_SIGNATURE_ORDER } from "../src/order/joinpay-protocol";
import { confirmOrderPayment, createControlledPaymentSource, type PaymentInput } from "../src/order/payment-confirmation";
import {
  acceptControlledPayment, bindChannelTransaction, claimPaymentRequestLease, createPaymentRequest, createSyntheticChannelRequestCapability,
  readRecoverablePaymentRequest, recordExecutorResult, recordJoinpayNotify, type ChannelBinding,
} from "../src/order/channel-payment-store";

type Fixture = { orderId: string; accountId: string };
export type ChannelPaymentPgOptions = {
  /** 运行角色池（max≥2）与第二独立池，用于真实双连接竞争 */
  pool: Pool; secondPool: Pool;
  /** 只读观察锁等待（pg_stat_activity），不终止任何 backend */
  ownerPool: Pool;
  /** 迁移角色：安装 fixture、注入审计失败、构造过期 lease */
  migrationPool: Pool;
  config: AppConfig; resourceSet: string; resourceOid: number;
  /** 届时真实批准原件摘要；不得用任意 64 位串冒充 */
  approvalDigest: string;
  fixture: (label: string, offset?: number) => Promise<Fixture>;
  admit: (orderId: string) => Promise<void>;
  /** 重建运行池（新连接）；用于连接恢复/应用 ACK 丢失后的重放 */
  reconnect: () => Pool;
  /** PG-only harness 在独立 Node 子进程中建新连接、只读原请求；必须返回子进程实际 PID。 */
  restartRead: (requestId: string) => Promise<{ pid: number; request: Awaited<ReturnType<typeof readRecoverablePaymentRequest>> }>;
};

const KEY = "SYNTHETIC_KEY_NOT_REAL_PG03";
const MER = "888000000000003";
const keyFor = () => KEY;
const resolveMerchant = (no: string) => (no === MER ? "mid_synth_pg" : null);
const md5 = (order: readonly string[], v: Record<string, string | undefined>) => createHash("md5").update(order.map((n) => v[n] ?? "").join("") + KEY, "utf8").digest("hex");

/** 由迁移角色在同一事务内安装三关系 fixture；先核对隔离库名与 marker。 */
export async function installChannelPaymentFixture(migrationPool: Pool, expected: { database: string; runtimeRole: string; schemaSql: string }): Promise<void> {
  // 窗口执行器校验源码 fixture 的 SHA 后显式传入；不假设 tsc 会复制 SQL 资源。
  if (typeof expected.schemaSql !== "string" || !expected.schemaSql.trim()) throw new Error("Explicit reviewed channel payment fixture SQL required");
  await withTransaction(migrationPool, async (c) => {
    const id = (await c.query(`SELECT current_database() AS db, shobj_description(d.oid,'pg_database') AS marker FROM pg_database d WHERE datname=current_database()`)).rows[0];
    if (id?.db !== expected.database || id?.marker !== "zzsh:order-reservation-test:v1") throw new Error("channel payment fixture requires the exact isolated resource");
    await c.query(`SELECT set_config('zzsh.pay03a_runtime_role', $1, true)`, [expected.runtimeRole]);
    await c.query(expected.schemaSql);
  });
}

export async function runChannelPaymentPostgres(t: TestContext, o: ChannelPaymentPgOptions): Promise<void> {
  const { pool, secondPool, ownerPool, migrationPool, config } = o;
  if (o.resourceSet !== "joinpay_pay03a" || !/^[0-9a-f]{64}$/.test(o.approvalDigest)) throw new Error("PAY-03A PG cases require the signed joinpay_pay03a window");
  const JOINPAY: ChannelBinding = { channel: "JOINPAY", merchantIdentityId: "mid_synth_pg", configProfileId: "profile_v1", protocolVersion: "2.6", keyVersionRef: "kv1" };
  const CONTROLLED: ChannelBinding = { channel: "CONTROLLED", merchantIdentityId: "pay03a-merchant", configProfileId: "controlled_v1", protocolVersion: "controlled-1", keyVersionRef: "none" };
  const synthCap = createSyntheticChannelRequestCapability({ config, resourceSet: o.resourceSet, evidenceLevel: "SYNTHETIC_PROTOCOL" });
  const ctrlCap = createSyntheticChannelRequestCapability({ config, resourceSet: o.resourceSet, evidenceLevel: "CONTROLLED_TEST" });
  const order = async (id: string) => (await pool.query(`SELECT *, (rental_amount_cents+deposit_amount_cents)::text AS total FROM zzsh_order.rental_order WHERE id=$1`, [id])).rows[0];
  const n = async (sql: string, params: unknown[]) => (await pool.query(sql, params)).rows[0].n as number;
  const counts = async (orderId: string) => ({
    applied: await n(`SELECT count(*)::int AS n FROM zzsh_order.payment_confirmation WHERE order_id=$1 AND disposition='APPLIED'`, [orderId]),
    basis: await n(`SELECT count(*)::int AS n FROM zzsh_order.payment_distribution_basis WHERE order_id=$1`, [orderId]),
    confirmedAudit: await n(`SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE action='order.payment.confirmed' AND object_type='rental_order' AND object_id=$1 AND reason='APPLIED'`, [orderId]),
    basisAudit: await n(`SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE action='distribution.payment.basis.frozen' AND object_type='payment_distribution_basis' AND object_id=$1`, [orderId]),
    waiting: await n(`SELECT count(*)::int AS n FROM zzsh_order.im_order_group WHERE order_id=$1`, [orderId]),
    requests: await n(`SELECT count(*)::int AS n FROM zzsh_order.payment_request WHERE order_id=$1`, [orderId]),
    anchors: await n(`SELECT count(*)::int AS n FROM zzsh_order.payment_channel_transaction WHERE native_order_id=$1`, [orderId]),
  });
  const observations = (requestId: string) => n(`SELECT count(*)::int AS n FROM zzsh_order.payment_channel_observation WHERE request_id=$1`, [requestId]);
  /** 确定性 barrier：等到真实 PG 锁等待者出现，不用 sleep 猜竞争。 */
  const waitBlocked = async (count: number) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await ownerPool.query("SELECT pg_stat_clear_snapshot()");
      if ((await ownerPool.query(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'`)).rows[0].n >= count) return;
    }
    assert.fail(`expected ${count} actual PG lock waiters`);
  };
  const input = async (f: Fixture, trx = `pay03a_${randomUUID()}`): Promise<PaymentInput> => {
    const row = await order(f.orderId);
    return { orderId: f.orderId, merchantOrderNo: row.display_no, providerTransactionId: trx, amountCents: row.total, currency: row.currency, providerPaidAt: new Date().toISOString(), requestId: `req_${randomUUID()}` };
  };
  const source = (ids: string[], resourceSet = o.resourceSet, cfg = config) => createControlledPaymentSource({ config: cfg, resourceSet, appId: "pay03a-app", merchantScopeId: CONTROLLED.merchantIdentityId, allowedOrderIds: ids });
  const store = (ids: string[], patch: Partial<Parameters<typeof createPaymentDistributionStore>[0]> = {}) =>
    createPaymentDistributionStore({ resourceSet: o.resourceSet, resourceOid: o.resourceOid, approvalDigest: o.approvalDigest, allowedOrderIds: ids, ...patch });
  // 建单后缓存 display_no/金额；受控接纳的正反例都保留完整分佣准入。
  const cache = new Map<string, { display_no: string; total: string }>();
  const mk = async (label: string, offset?: number) => { const f = await o.fixture(label, offset); const r = await order(f.orderId); cache.set(f.orderId, { display_no: r.display_no, total: r.total }); return f; };
  const inputSync = (f: Fixture): PaymentInput => ({ orderId: f.orderId, merchantOrderNo: cache.get(f.orderId)!.display_no, providerTransactionId: `pay03a_${randomUUID()}`,
    amountCents: cache.get(f.orderId)!.total, currency: "CNY", providerPaidAt: new Date().toISOString(), requestId: `req_${randomUUID()}` });
  const renter = async (orderId: string) => (await order(orderId)).renter_user_id as string;
  const request = async (c: PoolClient, orderId: string, binding: ChannelBinding, key = `idem-${randomUUID()}`, method = "ALIPAY_NATIVE") =>
    (await createPaymentRequest(c, { actor: { userId: await renter(orderId) }, orderId, idempotencyKey: key, method, binding, capability: binding.channel === "JOINPAY" ? synthCap : ctrlCap })).body as { requestId: string; channelOrderNo: string; existing: boolean };
  const accept = (p: Pool, f: Fixture, inp: PaymentInput, requestId?: string) =>
    withTransaction(p, (c) => acceptControlledPayment(c, { fact: source([f.orderId])(inp), distribution: store([f.orderId]), requestId }));
  const notify = (orderNo: string, patch: Record<string, string> = {}) => {
    const v: Record<string, string> = { r0_Version: "2.6", r1_MerchantNo: MER, r2_OrderNo: orderNo, r3_Amount: "", r4_Cur: "1", r6_Status: "100", r7_TrxNo: "PG_TRX_1", ra_PayTime: "2026-10-22 10:00:00", rb_DealTime: "2026-10-22 10:00:05", rc_BankCode: "ALIPAY", re_DiscountAmount: "0.00", rk_FrpCode: "ALIPAY_NATIVE", ro_SettleAmount: "", ...patch };
    return new URLSearchParams([...Object.entries(v).filter(([, x]) => x !== ""), ["hmac", md5(JOINPAY_SIGNATURE_ORDER.asyncNotify, v)]]).toString();
  };
  const yuan = (cents: string) => `${cents.slice(0, -2) || "0"}.${cents.padStart(3, "0").slice(-2)}`;
  const syncBody = (orderNo: string, amount: string, patch: Record<string, string | undefined> = {}) => {
    const v: Record<string, string | undefined> = { r0_Version: "2.6", r1_MerchantNo: MER, r2_OrderNo: orderNo, r3_Amount: amount, r4_Cur: "1", r6_FrpCode: "ALIPAY_NATIVE", r7_TrxNo: "PG_SYNC_TRX", ra_Code: "102", rb_CodeMsg: "处理中", rc_Result: "https://qr.example.invalid/p", ...patch };
    return JSON.stringify({ ...Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)), hmac: md5(JOINPAY_SIGNATURE_ORDER.uniPaySyncResponse, v) });
  };

  await t.test("C01 #1 同一流水双连接竞争：一笔 APPLIED、一份 basis、各审计一次、WAITING 一次、revision 一次", async () => {
    const f = await mk("PAY03A同流水"); await o.admit(f.orderId);
    const before = await order(f.orderId);
    const req = await withTransaction(pool, (c) => request(c, f.orderId, CONTROLLED));
    const inp = await input(f);
    const holder = await pool.connect();
    let second: ReturnType<typeof accept> | undefined;
    try {
      await holder.query("BEGIN");
      const first = await acceptControlledPayment(holder, { fact: source([f.orderId])(inp), distribution: store([f.orderId]), requestId: req.requestId });
      assert.equal(first.payment.disposition, "APPLIED");
      second = accept(secondPool, f, inp, req.requestId);
      await waitBlocked(1);
      await holder.query("COMMIT");
      const r2 = await second;
      assert.equal(r2.payment.replay, true);
      assert.equal(r2.payment.confirmationId, first.payment.confirmationId);
    } finally { await holder.query("ROLLBACK").catch(() => undefined); holder.release(); if (second) await second.catch(() => undefined); }
    assert.deepEqual(await counts(f.orderId), { applied: 1, basis: 1, confirmedAudit: 1, basisAudit: 1, waiting: 1, requests: 1, anchors: 1 });
    const after = await order(f.orderId);
    assert.equal(BigInt(after.revision), BigInt(before.revision) + 1n);
    assert.equal((await pool.query(`SELECT state FROM zzsh_order.payment_request WHERE id=$1`, [req.requestId])).rows[0].state, "ACCEPTED");
  });

  await t.test("C02 #2/#20 同单不同流水：REVIEW_REQUIRED/DUPLICATE_PAYMENT；ACCEPTED 不变、原 confirmation 与 revision 不变", async () => {
    const f = await mk("PAY03A异流水"); await o.admit(f.orderId);
    const req = await withTransaction(pool, (c) => request(c, f.orderId, CONTROLLED));
    const first = await accept(pool, f, await input(f), req.requestId);
    const snapshot = await order(f.orderId);
    const obs = await observations(req.requestId);
    const dup = await accept(secondPool, f, await input(f), req.requestId);
    assert.equal(dup.payment.reasonCode, "DUPLICATE_PAYMENT");
    assert.equal(dup.requestState, "ACCEPTED");
    const after = await order(f.orderId);
    assert.equal(after.paid_confirmation_id, first.payment.confirmationId);
    assert.equal(after.revision, snapshot.revision);
    assert.equal(await observations(req.requestId), obs + 1);
    assert.equal((await counts(f.orderId)).applied, 1);
    assert.equal((await counts(f.orderId)).anchors, 2);
  });

  await t.test("C03 #3 付款与取消真实锁竞争：取消先得锁 → LATE_PAYMENT 且订单 CANCELLED；hold 已过 → LATE_PAYMENT", async () => {
    const f = await mk("PAY03A取消竞争"); await o.admit(f.orderId);
    const inp = await input(f);
    const c = await pool.connect();
    let pending: ReturnType<typeof accept> | undefined;
    try {
      await c.query("BEGIN");
      const { cancelReservation } = await import("../src/order/order");
      await cancelReservation(c, { orderId: f.orderId, context: { userId: await renter(f.orderId), sessionId: "pay03a" }, requestId: inp.requestId });
      pending = accept(secondPool, f, inp);
      await waitBlocked(1);
      await c.query("COMMIT");
      assert.equal((await pending).payment.reasonCode, "LATE_PAYMENT");
    } finally { await c.query("ROLLBACK").catch(() => undefined); c.release(); if (pending) await pending.catch(() => undefined); }
    assert.equal((await order(f.orderId)).status, "CANCELLED");
    assert.deepEqual([(await counts(f.orderId)).applied, (await counts(f.orderId)).basis], [0, 0]);
    const paid = await mk("PAY03A付款先赢"); await o.admit(paid.orderId);
    const paidInput = await input(paid);
    const payer = await pool.connect();
    let cancellation: Promise<unknown> | undefined;
    try {
      await payer.query("BEGIN");
      assert.equal((await acceptControlledPayment(payer, { fact: source([paid.orderId])(paidInput), distribution: store([paid.orderId]) })).payment.disposition, "APPLIED");
      const { cancelReservation } = await import("../src/order/order");
      const context = { userId: await renter(paid.orderId), sessionId: "pay03a" };
      cancellation = withTransaction(secondPool, (cl) => cancelReservation(cl, { orderId: paid.orderId, context, requestId: paidInput.requestId }));
      void cancellation.catch(() => undefined);
      await waitBlocked(1);
      await payer.query("COMMIT");
      await assert.rejects(cancellation, (e: { status?: number }) => e.status === 409);
    } finally { await payer.query("ROLLBACK").catch(() => undefined); payer.release(); if (cancellation) await cancellation.catch(() => undefined); }
    assert.equal((await order(paid.orderId)).status, "PAID");
    const paidCounts = await counts(paid.orderId);
    assert.deepEqual([paidCounts.applied, paidCounts.basis, paidCounts.confirmedAudit, paidCounts.basisAudit, paidCounts.waiting], [1, 1, 1, 1, 1]);
    const expired = await mk("PAY03Ahold过期", -60); await o.admit(expired.orderId);
    const late = await accept(pool, expired, inputSync(expired));
    assert.equal(late.payment.reasonCode, "LATE_PAYMENT");
    assert.equal((await order(expired.orderId)).status, "CANCELLED");
  });

  await t.test("C04 #4 流水重放到另一订单：CONFLICT + FAILURE 审计；锚点归属不变", async () => {
    const a = await mk("PAY03A流水A"); await o.admit(a.orderId);
    const b = await mk("PAY03A流水B"); await o.admit(b.orderId);
    const inp = await input(a);
    await accept(pool, a, inp);
    const bad = await accept(pool, b, { ...(await input(b)), providerTransactionId: inp.providerTransactionId });
    assert.equal(bad.payment.disposition, "CONFLICT");
    assert.equal(await n(`SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE action='order.payment.conflict' AND object_id=$1 AND outcome='FAILURE'`, [bad.payment.confirmationId]), 1);
    assert.equal(await n(`SELECT count(*)::int AS n FROM zzsh_order.payment_channel_transaction WHERE channel_trx_no=$1 AND native_order_id=$2`, [inp.providerTransactionId, a.orderId]), 1);
    assert.equal((await counts(b.orderId)).anchors, 0);
  });

  await t.test("C05 #5 子进程与新连接恢复：只读持久原号，request 1 行，不换号", async () => {
    const f = await mk("PAY03A重启");
    const req = await withTransaction(pool, (c) => request(c, f.orderId, JOINPAY));
    const lease = await withTransaction(pool, (c) => claimPaymentRequestLease(c, { requestId: req.requestId, owner: "worker-a", ttlSeconds: 600 }));
    assert.ok(lease);
    const restarted = await o.restartRead(req.requestId);
    assert.ok(Number.isSafeInteger(restarted.pid) && restarted.pid > 0 && restarted.pid !== process.pid, "恢复必须来自独立进程，不能只换同进程 Pool");
    assert.equal(restarted.request?.requestId, req.requestId);
    assert.equal(restarted.request?.channelOrderNo, req.channelOrderNo);
    assert.equal(restarted.request?.leaseVersion, lease.leaseVersion);
    const fresh = o.reconnect();
    try {
      const rec = await withTransaction(fresh, (c) => readRecoverablePaymentRequest(c, req.requestId));
      assert.equal(rec?.channelOrderNo, req.channelOrderNo);
      assert.equal(rec?.channelOrderNo, (await order(f.orderId)).display_no.replaceAll("-", "_"));
      assert.equal(await withTransaction(fresh, (c) => claimPaymentRequestLease(c, { requestId: req.requestId, owner: "worker-b", ttlSeconds: 600 })), null);
      assert.equal((await withTransaction(fresh, (c) => request(c, f.orderId, JOINPAY))).requestId, req.requestId);
    } finally { await fresh.end(); }
    assert.equal((await counts(f.orderId)).requests, 1);
  });

  await t.test("C06 #6 SIMULATED_APP_ACK_LOSS：COMMIT 后应用丢失结果，新连接按原号重放 replay:true，无第二 APPLIED/basis", async () => {
    const f = await mk("PAY03A提交未知"); await o.admit(f.orderId);
    const req = await withTransaction(pool, (c) => request(c, f.orderId, CONTROLLED));
    const inp = await input(f);
    await assert.rejects(accept(pool, f, inp, req.requestId).then(() => { throw new Error("SIMULATED_APP_ACK_LOSS"); }), /SIMULATED_APP_ACK_LOSS/);
    const fresh = o.reconnect();
    try {
      const again = await accept(fresh, f, inp, req.requestId);
      assert.equal(again.payment.replay, true);
    } finally { await fresh.end(); }
    assert.deepEqual(await counts(f.orderId), { applied: 1, basis: 1, confirmedAudit: 1, basisAudit: 1, waiting: 1, requests: 1, anchors: 1 });
  });

  await t.test("C07 #7 审计/分佣落盘失败注入：新三关系与既有表整笔回滚", async () => {
    for (const target of ["zzsh_iam.audit_event", "zzsh_order.payment_distribution_basis"]) {
    const f = await mk("PAY03A依赖失败" + target); await o.admit(f.orderId);
    const req = await withTransaction(pool, (c) => request(c, f.orderId, CONTROLLED));
    const before = await order(f.orderId);
    const obs = await observations(req.requestId);
    await migrationPool.query(`REVOKE INSERT ON ${target} FROM "${config.database.user}"`);
    try {
      await assert.rejects(accept(pool, f, await input(f), req.requestId), { code: "42501" });
    } finally { await migrationPool.query(`GRANT INSERT ON ${target} TO "${config.database.user}"`); }
    assert.deepEqual(await order(f.orderId), before);
    assert.equal(await observations(req.requestId), obs);
    assert.deepEqual(await counts(f.orderId), { applied: 0, basis: 0, confirmedAudit: 0, basisAudit: 0, waiting: 0, requests: 1, anchors: 0 });
    assert.equal((await pool.query(`SELECT state FROM zzsh_order.payment_request WHERE id=$1`, [req.requestId])).rows[0].state, "SUBMITTING");
    }
  });

  await t.test("C08 #8/#19 旧 lease 只追加 STALE；当前 lease 可信同步 102 → PROCESSING_UNCONFIRMED", async () => {
    const f = await mk("PAY03A旧lease");
    const req = await withTransaction(pool, (c) => request(c, f.orderId, JOINPAY));
    const a = (await withTransaction(pool, (c) => claimPaymentRequestLease(c, { requestId: req.requestId, owner: "worker-a", ttlSeconds: 600 })))!;
    // 确定性过期：迁移角色把 lease_until 拨到 PG 时钟之前（触发器仍要求 revision 递增）
    await migrationPool.query(`UPDATE zzsh_order.payment_request SET lease_until=clock_timestamp()-interval '1 second', revision=revision+1 WHERE id=$1`, [req.requestId]);
    const b = (await withTransaction(pool, (c) => claimPaymentRequestLease(c, { requestId: req.requestId, owner: "worker-b", ttlSeconds: 600 })))!;
    const amount = yuan((await order(f.orderId)).total);
    const stale = await withTransaction(pool, (c) => recordExecutorResult(c, { requestId: req.requestId, leaseVersion: a.leaseVersion, leaseOwner: "worker-a", operation: "SYNC_RESPONSE", body: syncBody(req.channelOrderNo, amount, { ra_Code: "100" }), rawRef: "raw://pg/a", merchantNo: MER, keyFor: () => { throw Error("stale lease must not read a retired key"); } }));
    assert.equal(stale.outcome.event, "E9");
    let row = (await pool.query(`SELECT state, lease_owner, lease_version::text AS v FROM zzsh_order.payment_request WHERE id=$1`, [req.requestId])).rows[0];
    assert.deepEqual(row, { state: "SUBMITTING", lease_owner: "worker-b", v: b.leaseVersion });
    const ok = await withTransaction(pool, (c) => recordExecutorResult(c, { requestId: req.requestId, leaseVersion: b.leaseVersion, leaseOwner: "worker-b", operation: "SYNC_RESPONSE", body: syncBody(req.channelOrderNo, amount), rawRef: "raw://pg/b", merchantNo: MER, keyFor }));
    assert.equal(ok.stateAfter, "PROCESSING_UNCONFIRMED");
    row = (await pool.query(`SELECT state FROM zzsh_order.payment_request WHERE id=$1`, [req.requestId])).rows[0];
    assert.equal(row.state, "PROCESSING_UNCONFIRMED");
    assert.equal(await n(`SELECT count(*)::int AS n FROM zzsh_order.payment_channel_observation WHERE request_id=$1 AND operation='SYNC_RESPONSE'`, [req.requestId]), 2);
    assert.equal(await n(`SELECT count(*)::int AS n FROM zzsh_order.payment_channel_observation WHERE request_id=$1 AND stale`, [req.requestId]), 1);
    assert.equal((await counts(f.orderId)).requests, 1);
  });

  await t.test("C09 #9 源伪造/CHECK/只追加/不可变绑定由数据库层保护", async () => {
    const f = await mk("PAY03A伪造");
    await assert.rejects(withTransaction(pool, (c) => confirmOrderPayment(c, { ...(inputSync(f)), source: "CONTROLLED", merchantScopeId: "x" } as never)), /not verified/);
    await assert.rejects(pool.query(`INSERT INTO zzsh_order.payment_confirmation(id,source,merchant_scope_id,provider_transaction_id,merchant_order_no,order_id,amount_cents,currency,provider_paid_at,disposition,reason_code,request_id)
      VALUES ('forged','JOINPAY','m','t','n',$1,1,'CNY',clock_timestamp(),'REVIEW_REQUIRED','LATE_PAYMENT','r')`, [f.orderId]), { code: "23514" });
    const req = await withTransaction(pool, (c) => request(c, f.orderId, JOINPAY));
    await assert.rejects(pool.query(`UPDATE zzsh_order.payment_request SET channel_order_no='OTHER', revision=revision+1 WHERE id=$1`, [req.requestId]), { code: "40001" });
    await assert.rejects(pool.query(`UPDATE zzsh_order.payment_request SET key_version_ref='kv2', revision=revision+1 WHERE id=$1`, [req.requestId]), { code: "40001" });
    await assert.rejects(pool.query(`INSERT INTO zzsh_order.payment_request(id,order_id,channel,merchant_identity_id,config_profile_id,protocol_version,key_version_ref,platform_order_no,channel_order_no,amount_cents,currency,wire_amount_yuan,method,evidence_level,idempotency_scope_key,idempotency_key,request_fingerprint)
      SELECT 'payreq_'||md5('bad-evidence'),id,'JOINPAY','m','p','2.6','k',display_no,replace(display_no,'-','_'),1,'CNY','0.01','ALIPAY_NATIVE','CONTROLLED_TEST','s','k',repeat('a',64) FROM zzsh_order.rental_order WHERE id=$1`, [f.orderId]), { code: "23514" });
    await assert.rejects(pool.query(`DELETE FROM zzsh_order.payment_request WHERE id=$1`, [req.requestId]), { code: "42501" });
    await assert.rejects(pool.query(`INSERT INTO zzsh_order.payment_request(id,order_id,channel,merchant_identity_id,config_profile_id,protocol_version,key_version_ref,platform_order_no,channel_order_no,amount_cents,currency,wire_amount_yuan,method,evidence_level,idempotency_scope_key,idempotency_key,request_fingerprint)
      SELECT 'payreq_'||md5('x'),id,'JOINPAY','m','p','2.6','k',display_no,replace(display_no,'-','_'),1,'CNY','0.01','ALIPAY_NATIVE','SYNTHETIC_PROTOCOL','s','k',repeat('a',64) FROM zzsh_order.rental_order WHERE id=$1`, [f.orderId]), { code: "23505" });
    await withTransaction(pool, (c) => recordJoinpayNotify(c, { rawQuery: notify("ZZ_ORPHAN"), rawRef: "raw://pg/orphan", resolveMerchant, keyFor }));
    const obs = (await pool.query(`SELECT id FROM zzsh_order.payment_channel_observation WHERE raw_ref='raw://pg/orphan'`)).rows[0].id;
    await assert.rejects(pool.query(`UPDATE zzsh_order.payment_channel_observation SET result='X' WHERE id=$1`, [obs]), { code: "42501" });
    await assert.rejects(migrationPool.query(`UPDATE zzsh_order.payment_channel_observation SET result='X' WHERE id=$1`, [obs]), { code: "40001" });
    for (const [channel, origin, confirmation] of [["JOINPAY", "NATIVE", "payment_x"], ["CONTROLLED", "LEGACY", null]] as const) {
      await assert.rejects(pool.query(`INSERT INTO zzsh_order.payment_channel_transaction(id,channel,merchant_identity_id,channel_trx_no,order_origin,native_order_id,confirmation_id,evidence_level)
        VALUES ('paytrx_'||md5($4),$1,'m',$4,$2,$5,$3,CASE WHEN $1='CONTROLLED' THEN 'CONTROLLED_TEST' ELSE 'SYNTHETIC_PROTOCOL' END)`, [channel, origin, confirmation, randomUUID(), f.orderId]), (e: { code?: string }) => e.code === "23514" || e.code === "23503");
    }
    const grants = (await pool.query(`SELECT has_table_privilege(current_user,'zzsh_order.payment_channel_observation','UPDATE') AS obs_upd,
      has_table_privilege(current_user,'zzsh_order.payment_channel_transaction','DELETE') AS trx_del,
      has_table_privilege(current_user,'zzsh_order.payment_request','DELETE') AS req_del`)).rows[0];
    assert.deepEqual(grants, { obs_upd: false, trx_del: false, req_del: false });
  });

  await t.test("C11 #11 资源错配：数据库/角色与 scope 不符 → Payment resource mismatch", async () => {
    const f = await mk("PAY03A资源错配");
    const other = { ...config, database: { ...config.database, name: "zzsh_test_order_pay03a_other", user: "zzsh_order_pay03a_other_r" } } as AppConfig;
    await assert.rejects(withTransaction(pool, (c) => acceptControlledPayment(c, { fact: source([f.orderId], "pay03a_other", other)(inputSync(f)), distribution: store([f.orderId]) })), /Payment resource mismatch/);
    assert.equal((await counts(f.orderId)).anchors, 0);
  });

  await t.test("C12 #12/#13 跨 profile 与钥版本同一流水：资金键唯一，后到方 OWNED_ELSEWHERE 冲突观察", async () => {
    const a = await mk("PAY03A跨profileA");
    const b = await mk("PAY03A跨profileB");
    const ra = await withTransaction(pool, (c) => request(c, a.orderId, JOINPAY));
    const rb = await withTransaction(pool, (c) => request(c, b.orderId, { ...JOINPAY, configProfileId: "profile_v2", keyVersionRef: "kv2" }));
    const amountA = yuan((await order(a.orderId)).total), amountB = yuan((await order(b.orderId)).total);
    const first = await withTransaction(pool, (c) => recordJoinpayNotify(c, { rawQuery: notify(ra.channelOrderNo, { r3_Amount: amountA, ro_SettleAmount: amountA, r7_TrxNo: "PG_SHARED_TRX" }), rawRef: "raw://pg/a", resolveMerchant, keyFor }));
    assert.equal(first.anchor?.binding, "NEW");
    const second = await withTransaction(pool, (c) => recordJoinpayNotify(c, { rawQuery: notify(rb.channelOrderNo, { r3_Amount: amountB, ro_SettleAmount: amountB, r7_TrxNo: "PG_SHARED_TRX" }), rawRef: "raw://pg/b", resolveMerchant, keyFor }));
    assert.equal(second.anchor?.binding, "OWNED_ELSEWHERE");
    assert.equal(second.stateAfter, "SUBMITTING");
    assert.equal(await n(`SELECT count(*)::int AS n FROM zzsh_order.payment_channel_transaction WHERE channel='JOINPAY' AND channel_trx_no='PG_SHARED_TRX'`, []), 1);
    // #13 钥轮换后同一资金键仅 SAME，不产生第二笔
    const rotated = await withTransaction(pool, (c) => bindChannelTransaction(c, { channel: "JOINPAY", merchantIdentityId: "mid_synth_pg", channelTrxNo: "PG_SHARED_TRX", orderId: a.orderId, requestId: ra.requestId, confirmationId: null, evidenceLevel: "SYNTHETIC_PROTOCOL" }));
    assert.equal(rotated.binding, "SAME");
    // 双连接同资金键竞争：advisory 锁串行化，无 23505 泄漏
    const results = await Promise.all([pool, secondPool].map((p, i) => withTransaction(p, (c) => bindChannelTransaction(c, { channel: "JOINPAY", merchantIdentityId: "mid_synth_pg", channelTrxNo: "PG_RACE_TRX", orderId: i ? b.orderId : a.orderId, requestId: null, confirmationId: null, evidenceLevel: "SYNTHETIC_PROTOCOL" }))));
    assert.deepEqual(results.map((r) => r.binding).sort(), ["NEW", "OWNED_ELSEWHERE"]);
  });

  await t.test("C15 #15 ACCEPTED 后迟到成功通知：状态不变，追加 late 观察", async () => {
    const f = await mk("PAY03A迟到");
    const req = await withTransaction(pool, (c) => request(c, f.orderId, JOINPAY));
    // fixture 设定：迁移角色把合成请求置为终态（仅测试终态守卫，不代表 JOINPAY 可接纳）
    await migrationPool.query(`UPDATE zzsh_order.payment_request SET state='ACCEPTED', revision=revision+1 WHERE id=$1`, [req.requestId]);
    const amount = yuan((await order(f.orderId)).total);
    const late = await withTransaction(pool, (c) => recordJoinpayNotify(c, { rawQuery: notify(req.channelOrderNo, { r3_Amount: amount, ro_SettleAmount: amount, r7_TrxNo: "PG_LATE_TRX" }), rawRef: "raw://pg/late", resolveMerchant, keyFor }));
    assert.equal(late.stateAfter, "ACCEPTED");
    assert.equal((await pool.query(`SELECT late FROM zzsh_order.payment_channel_observation WHERE raw_ref='raw://pg/late'`)).rows[0].late, true);
    await assert.rejects(migrationPool.query(`UPDATE zzsh_order.payment_request SET state='UNKNOWN', revision=revision+1 WHERE id=$1`, [req.requestId]), { code: "40001" });
  });

  await t.test("C16 #16 分佣准入缺失/资源不符：503 或 409，不降级", async () => {
    const f = await mk("PAY03A准入");
    await assert.rejects(withTransaction(pool, (c) => acceptControlledPayment(c, { fact: source([f.orderId])(inputSync(f)), distribution: store([f.orderId]) })), (e: { status?: number }) => e.status === 503);
    await assert.rejects(withTransaction(pool, (c) => acceptControlledPayment(c, { fact: source([f.orderId])(inputSync(f)), distribution: store(["not_this_order"]) })), (e: { status?: number }) => e.status === 503);
    await o.admit(f.orderId);
    await assert.rejects(withTransaction(pool, (c) => acceptControlledPayment(c, { fact: source([f.orderId])(inputSync(f)), distribution: store([f.orderId], { resourceOid: o.resourceOid + 1 }) })), /Distribution payment resource differs/);
    assert.deepEqual(await counts(f.orderId), { applied: 0, basis: 0, confirmedAudit: 0, basisAudit: 0, waiting: 0, requests: 0, anchors: 0 });
  });

  await t.test("C17 #17 渠道原始时间不能成为 providerPaidAt", async () => {
    const f = await mk("PAY03A原始时间");
    assert.throws(() => source([f.orderId])({ ...inputSync(f), providerPaidAt: "2026-10-22 10:00:00" }), /Invalid controlled payment fact/);
  });

  await t.test("C18 #18 同 key 异 method：IDEMPOTENCY_KEY_REUSED，不写库；异 key 双连接竞争仍只有一个请求", async () => {
    const f = await mk("PAY03A幂等");
    const key = `idem-${randomUUID()}`;
    const first = await withTransaction(pool, (c) => request(c, f.orderId, JOINPAY, key));
    const idem = await n(`SELECT count(*)::int AS n FROM zzsh_supply.idempotency_record WHERE key=$1`, [key]);
    await assert.rejects(withTransaction(pool, (c) => request(c, f.orderId, JOINPAY, key, "WEIXIN_NATIVE")), { code: "IDEMPOTENCY_KEY_REUSED" });
    await assert.rejects(withTransaction(pool, (c) => request(c, f.orderId, JOINPAY, "different-method-key", "WEIXIN_NATIVE")), (e: { code?: string; paymentReason?: string }) => e.code === "CONFLICT" && e.paymentReason === "PAYMENT_REQUEST_EXISTS");
    assert.equal(await n(`SELECT count(*)::int AS n FROM zzsh_supply.idempotency_record WHERE key=$1`, [key]), idem);
    const g = await mk("PAY03A异key竞争");
    const holder = await pool.connect();
    let other: Promise<{ requestId: string; existing: boolean }> | undefined;
    try {
      await holder.query("BEGIN");
      const a = await request(holder, g.orderId, JOINPAY);
      other = withTransaction(secondPool, (c) => request(c, g.orderId, JOINPAY));
      await waitBlocked(1);
      await holder.query("COMMIT");
      const b = await other;
      assert.equal(b.requestId, a.requestId);
      assert.equal(b.existing, true);
    } finally { await holder.query("ROLLBACK").catch(() => undefined); holder.release(); if (other) await other.catch(() => undefined); }
    assert.equal((await counts(g.orderId)).requests, 1);
    assert.equal((await counts(f.orderId)).requests, 1);
    assert.ok(first.requestId);
    // 旧受控入口已取得订单行时，新支付意图必须等待并重新判可付性。
    for (const reviewOnly of [false, true]) {
    const paid = await mk(reviewOnly ? "PAY03A待核与新意图" : "PAY03A付款与新意图"); await o.admit(paid.orderId);
    const paymentClient = await pool.connect();
    let creating: Promise<unknown> | undefined;
    try {
      await paymentClient.query("BEGIN");
      const paymentInput = await input(paid);
      const declared = reviewOnly ? { ...paymentInput, amountCents: (BigInt(paymentInput.amountCents) + 1n).toString() } : paymentInput;
      const accepted = await acceptControlledPayment(paymentClient, { fact: source([paid.orderId])(declared), distribution: store([paid.orderId]) });
      assert.equal(accepted.payment.disposition, reviewOnly ? "REVIEW_REQUIRED" : "APPLIED");
      creating = withTransaction(secondPool, (cl) => request(cl, paid.orderId, JOINPAY));
      void creating.catch(() => undefined);
      await waitBlocked(1);
      await paymentClient.query("COMMIT");
      await assert.rejects(creating, (e: { status?: number; paymentReason?: string }) => e.status === 409 && e.paymentReason === "ORDER_NOT_PAYABLE");
    } finally {
      await paymentClient.query("ROLLBACK").catch(() => undefined); paymentClient.release();
      if (creating) await creating.catch(() => undefined);
    }
    assert.equal((await counts(paid.orderId)).requests, 0);
    assert.equal((await counts(paid.orderId)).applied, reviewOnly ? 0 : 1);
    }
  });
}
