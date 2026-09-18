// Runs serially inside the existing order suite, sharing its registered resource,
// real API fixtures, preflight, migration and cleanup. No second database runner.
import { strict as assert } from "node:assert";
import { randomUUID } from "node:crypto";
import type { TestContext } from "node:test";
import { Pool } from "pg";
import type { AppConfig } from "../src/config/config";
import { withTransaction } from "../src/auth/security-core";
import { confirmOrderPayment, createControlledPaymentSource, type PaymentInput } from "../src/order/payment-confirmation";
import { cancelExpiredReservation, composeSupplyGateWithOrderOccupancy, readOrderOccupancy, sweepExpiredHolds } from "../src/order/order";

type Fixture = { orderId: string; accountId: string; versionId: string; releaseId: string };
type Options = {
  pool: Pool; migrationPool: Pool; ownerPool: Pool; config: AppConfig; resourceSet: string;
  fixture: (label: string, offset?: number) => Promise<Fixture>;
  clone: (orderId: string, offset: number) => Promise<string>;
  api: (path: string, body?: Record<string, unknown>, method?: string) => Promise<{ response: Response; body: Record<string, any> | null }>;
};

export async function runPaymentAcceptance(t: TestContext, o: Options): Promise<void> {
  const { pool, ownerPool, migrationPool } = o;
  // Existing default order suite remains runnable without changing its resource names.
  // Controlled injection deliberately requires a named/registered isolated resource.
  if (!o.resourceSet) throw new Error("Payment acceptance requires ORDER_TEST_RESOURCE_SET");
  const rows = async (id: string) => (await pool.query(`SELECT *,
    to_char(hold_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS hold_text
    FROM zzsh_order.rental_order WHERE id=$1`, [id])).rows[0];
  const input = async (id: string): Promise<PaymentInput> => {
    const row = await rows(id);
    return { orderId: id, merchantOrderNo: row.display_no, providerTransactionId: `fixture_${randomUUID()}`,
      amountCents: (BigInt(row.rental_amount_cents) + BigInt(row.deposit_amount_cents)).toString(), currency: row.currency,
      providerPaidAt: new Date().toISOString(), requestId: `req_${randomUUID()}` };
  };
  const source = (ids: string[]) => createControlledPaymentSource({ config: o.config, resourceSet: o.resourceSet,
    appId: "oim-controlled-app", merchantScopeId: "oim-fixture-merchant", allowedOrderIds: ids });
  const pay = (p: PaymentInput) => withTransaction(pool, (c) => confirmOrderPayment(c, source([p.orderId])(p)));
  const counts = async (id: string) => (await pool.query(`SELECT
    (SELECT count(*)::int FROM zzsh_order.payment_confirmation WHERE order_id=$1 AND disposition='APPLIED') AS applied,
    (SELECT count(*)::int FROM zzsh_order.im_order_group WHERE order_id=$1) AS waiting,
    (SELECT count(*)::int FROM zzsh_iam.audit_event WHERE object_id=$1 AND action='order.payment.confirmed' AND reason='APPLIED') AS audits`, [id])).rows[0];
  const waitBlocked = async (count: number) => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      await ownerPool.query("SELECT pg_stat_clear_snapshot()");
      const n = (await ownerPool.query(`SELECT count(*)::int AS n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'`)).rows[0].n;
      if (n >= count) return;
    }
    assert.fail(`expected ${count} actual PG lock waiters`);
  };

  let paid!: Fixture;
  let paidInput!: PaymentInput;
  await t.test("P01 same transaction concurrent/serial replay and immutable binding conflicts", async () => {
    paid = await o.fixture("付款幂等");
    paidInput = await input(paid.orderId);
    const before = await rows(paid.orderId);
    const accepted = await Promise.all([pay(paidInput), pay(paidInput)]);
    assert.deepEqual(accepted.map((v) => v.replay).sort(), [false, true]);
    assert.equal(accepted[0]!.confirmationId, accepted[1]!.confirmationId);
    assert.equal((await pay({ ...paidInput, requestId: `req_${randomUUID()}` })).replay, true);
    assert.deepEqual(await counts(paid.orderId), { applied: 1, waiting: 1, audits: 1 });
    const after = await rows(paid.orderId);
    assert.equal(after.status, "PAID");
    assert.equal(BigInt(after.revision), BigInt(before.revision) + 1n);
    for (const field of ["quote_snapshot", "hold_text", "rental_amount_cents", "deposit_amount_cents", "content_hash", "listing_version_id"]) assert.deepEqual(after[field], before[field]);
    for (const patch of [{ amountCents: "1" }, { currency: "USD" }, { merchantOrderNo: "wrong_order" }, { providerPaidAt: "2026-01-01T00:00:00.000Z" }]) {
      assert.equal((await pay({ ...paidInput, ...patch, requestId: `req_${randomUUID()}` })).disposition, "CONFLICT");
    }
    const other = await o.fixture("流水跨单");
    assert.equal((await pay({ ...paidInput, orderId: other.orderId })).disposition, "CONFLICT");
    assert.equal((await rows(other.orderId)).status, "PENDING_PAYMENT");
    assert.deepEqual(await counts(other.orderId), { applied: 0, waiting: 0, audits: 0 });
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_iam.audit_event WHERE object_id=$1 AND action='order.payment.conflict'`, [accepted[0]!.confirmationId])).rows[0].n, 5);
    assert.deepEqual(await counts(paid.orderId), { applied: 1, waiting: 1, audits: 1 });
  });

  await t.test("P02 duplicate receipts retained; amount/currency/order mismatches cannot pay", async () => {
    const otherReceipt = await pay({ ...paidInput, providerTransactionId: `fixture_${randomUUID()}` });
    assert.equal(otherReceipt.reasonCode, "DUPLICATE_PAYMENT");
    assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.payment_confirmation WHERE order_id=$1`, [paid.orderId])).rows[0].n, 2);
    const f = await o.fixture("付款金额边界");
    const p = await input(f.orderId);
    for (const patch of [{ amountCents: "17501" }, { currency: "USD" }, { merchantOrderNo: "wrong_order" }]) {
      const result = await pay({ ...p, ...patch, providerTransactionId: `fixture_${randomUUID()}` });
      assert.equal(result.disposition, "REVIEW_REQUIRED");
      assert.equal(result.reasonCode, "BINDING_MISMATCH");
    }
    assert.equal((await rows(f.orderId)).status, "PENDING_PAYMENT");
    assert.deepEqual(await counts(f.orderId), { applied: 0, waiting: 0, audits: 0 });
    const twoReceipts = await Promise.all([pay(p), pay({ ...p, providerTransactionId: `fixture_${randomUUID()}` })]);
    assert.deepEqual(twoReceipts.map((r) => r.disposition).sort(), ["APPLIED", "REVIEW_REQUIRED"]);
    assert.deepEqual(await counts(f.orderId), { applied: 1, waiting: 1, audits: 1 });
  });

  await t.test("P03 payment wins cancel and stale sweep with real lock barriers", async () => {
    const f = await o.fixture("付款先赢");
    const p = await input(f.orderId);
    const c = await pool.connect();
    let competing: Promise<unknown>[] = [];
    try {
      await c.query("BEGIN");
      assert.equal((await confirmOrderPayment(c, source([f.orderId])(p))).disposition, "APPLIED");
      const cancel = o.api(`/api/v1/orders/${f.orderId}/cancel`, {}, "POST");
      const sweep = sweepExpiredHolds(pool, { asOf: new Date(Date.now() + 86400000), batchLimit: 1000, scanLimit: 1000, lockTimeoutMs: 15000 });
      competing = [cancel, sweep];
      await waitBlocked(2);
      await c.query("COMMIT");
      assert.equal((await cancel).response.status, 409);
      assert.ok((await sweep).skippedChanged.includes(f.orderId), "stale candidate must not cancel PAID");
      assert.equal((await rows(f.orderId)).status, "PAID");
      assert.deepEqual(await counts(f.orderId), { applied: 1, waiting: 1, audits: 1 });
    } finally {
      await c.query("ROLLBACK"); c.release(); await Promise.allSettled(competing);
    }
  });

  await t.test("P04 cancel/sweep wins; late receipts cannot reclaim a new tenant", async () => {
    for (const winner of ["cancel", "sweep"] as const) {
      const f = await o.fixture(`付款晚于${winner}`, winner === "sweep" ? -60 : undefined);
      const p = await input(f.orderId);
      const c = await pool.connect();
      let pending: ReturnType<typeof pay> | undefined;
      try {
        await c.query("BEGIN");
        if (winner === "cancel") {
          const row = await rows(f.orderId);
          await c.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`, [row.renter_user_id]);
        }
        await c.query(`SELECT id FROM zzsh_supply.rental_account WHERE id=$1 FOR UPDATE`, [f.accountId]);
        if (winner === "sweep") {
          assert.equal(await cancelExpiredReservation(c, f.orderId, (await rows(f.orderId)).hold_text, p.requestId), true);
        } else {
          // Exercise the same domain function as the authenticated cancel route.
          const { cancelReservation } = await import("../src/order/order");
          const row = await rows(f.orderId);
          await cancelReservation(c, { orderId: f.orderId, context: { userId: row.renter_user_id, sessionId: "fixture" }, requestId: p.requestId });
        }
        pending = pay(p);
        await waitBlocked(1);
        await c.query("COMMIT");
        assert.equal((await pending).reasonCode, "LATE_PAYMENT");
      } finally { await c.query("ROLLBACK"); c.release(); if (pending) await pending.catch(() => undefined); }
      const nextId = await o.clone(f.orderId, 3600);
      assert.equal((await pay({ ...p, providerTransactionId: `fixture_${randomUUID()}` })).reasonCode, "LATE_PAYMENT");
      assert.equal((await rows(nextId)).status, "PENDING_PAYMENT");
      assert.equal((await rows(f.orderId)).status, "CANCELLED");
      assert.deepEqual(await counts(f.orderId), { applied: 0, waiting: 0, audits: 0 });
    }
  });

  await t.test("P05 DB clock boundary: before/equal/after; audit failure is atomic", async () => {
    for (const boundary of ["before", "equal", "after"] as const) {
      const f = await o.fixture(`付款截止${boundary}`, boundary === "after" ? -1 : undefined);
      const p = await input(f.orderId);
      const result = await withTransaction(pool, async (c) => {
        // At equality, run the production comparison in real PG with its clock
        // expression replaced by the locked hold value; no production clock hook.
        const raw = c.query.bind(c);
        if (boundary === "equal") c.query = ((sql: string, params: unknown[]) => raw(
          sql.includes("FROM (SELECT clock_timestamp() AS t) clock") ? sql.replace("clock_timestamp() AS t", "$1::timestamptz AS t") : sql, params)) as typeof c.query;
        try { return await confirmOrderPayment(c, source([f.orderId])(p)); } finally { c.query = raw; }
      });
      assert.equal(result.disposition, boundary === "before" ? "APPLIED" : "REVIEW_REQUIRED");
      const row = await rows(f.orderId);
      assert.equal(row.status, boundary === "before" ? "PAID" : "CANCELLED");
      if (boundary !== "before") assert.equal(row.cancel_reason, "TIMEOUT");
    }
    const f = await o.fixture("付款审计原子性");
    const p = await input(f.orderId);
    const before = await rows(f.orderId);
    const expired = await o.fixture("到期付款审计原子性", -60);
    const expiredInput = await input(expired.orderId);
    await migrationPool.query(`REVOKE INSERT ON zzsh_iam.audit_event FROM "${o.config.database.user}"`);
    try {
      await assert.rejects(pay(p), { code: "42501" });
      assert.deepEqual(await rows(f.orderId), before);
      assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_order.payment_confirmation WHERE order_id=$1`, [f.orderId])).rows[0].n, 0);
      assert.deepEqual(await counts(f.orderId), { applied: 0, waiting: 0, audits: 0 });
      await assert.rejects(pay(expiredInput), { code: "42501" });
      assert.equal((await rows(expired.orderId)).status, "PENDING_PAYMENT");
      await assert.rejects(pay({ ...paidInput, amountCents: "1" }), { code: "42501" });
    } finally { await migrationPool.query(`GRANT INSERT ON zzsh_iam.audit_event TO "${o.config.database.user}"`); }
    assert.equal((await pay(p)).disposition, "APPLIED");
  });

  await t.test("P06 DB reference/amount/snapshot/immutability constraints and runtime grants", async () => {
    const f = await o.fixture("付款数据库约束");
    const paidRow = await rows(paid.orderId);
    await assert.rejects(pool.query(`UPDATE zzsh_order.rental_order SET status='PAID' WHERE id=$1`, [f.orderId]), { code: "23514" });
    await assert.rejects(pool.query(`UPDATE zzsh_order.rental_order SET status='PAID',paid_confirmation_id=$2,paid_at=$3 WHERE id=$1`, [f.orderId, paidRow.paid_confirmation_id, paidRow.paid_at]), { code: "23503" });
    await assert.rejects(pool.query(`UPDATE zzsh_order.rental_order SET rental_amount_cents=rental_amount_cents+1 WHERE id=$1`, [paid.orderId]), { code: "40001" });
    await assert.rejects(pool.query(`UPDATE zzsh_order.rental_order SET paid_at=clock_timestamp() WHERE id=$1`, [paid.orderId]), { code: "40001" });
    await assert.rejects(pool.query(`UPDATE zzsh_order.payment_confirmation SET amount_cents=1 WHERE id=$1`, [paidRow.paid_confirmation_id]), { code: "42501" });
    await assert.rejects(ownerPool.query(`UPDATE zzsh_order.payment_confirmation SET amount_cents=1 WHERE id=$1`, [paidRow.paid_confirmation_id]), { code: "40001" });
    await assert.rejects(ownerPool.query(`UPDATE zzsh_order.im_order_group SET app_id='another' WHERE order_id=$1`, [paid.orderId]), { code: "40001" });
    await assert.rejects(pool.query(`UPDATE zzsh_order.im_order_group SET app_id='another' WHERE order_id=$1`, [paid.orderId]), { code: "42501" });
    await assert.rejects(o.clone(paid.orderId, 3600), { code: "23505" });
    await assert.rejects(withTransaction(pool, async (c) => {
      await c.query(`INSERT INTO zzsh_order.payment_confirmation(id,source,merchant_scope_id,provider_transaction_id,merchant_order_no,order_id,amount_cents,currency,provider_paid_at,disposition,request_id)
        VALUES ('orphan_applied','CONTROLLED','fixture','orphan','wrong',$1,1,'CNY',clock_timestamp(),'APPLIED','req_orphan')`, [f.orderId]);
    }), { code: "23514" });
    const rejected = await pay({ ...(await input(f.orderId)), amountCents: "1" });
    await assert.rejects(pool.query(`UPDATE zzsh_order.rental_order SET status='PAID',paid_confirmation_id=$2,paid_at=clock_timestamp() WHERE id=$1`, [f.orderId, rejected.confirmationId]), { code: "23503" });
    const permissions = (await pool.query(`SELECT has_table_privilege(current_user,'zzsh_order.payment_confirmation','INSERT') AS ins,
      has_table_privilege(current_user,'zzsh_order.payment_confirmation','UPDATE') AS upd,
      has_table_privilege(current_user,'zzsh_order.im_order_group','DELETE') AS del,
      has_table_privilege(current_user,'zzsh_order.im_order_group','TRUNCATE') AS trunc`)).rows[0];
    assert.deepEqual(permissions, { ins: true, upd: false, del: false, trunc: false });
    console.log("payment runtime grants", JSON.stringify(permissions));
  });

  await t.test("P07 PAID API/occupancy/deactivation boundary; no HTTP injection or forged facts", async () => {
    assert.equal(await withTransaction(pool, (c) => readOrderOccupancy(c, paid.accountId)), true);
    const gate = composeSupplyGateWithOrderOccupancy(async () => ({ occupancy: "FREE", publisherBail: "CONFIRMED" }) as never);
    assert.equal((await withTransaction(pool, (c) => gate(c, { id: paid.accountId } as never))).occupancy, "OCCUPIED");
    const detail = await o.api(`/api/v1/orders/${paid.orderId}`);
    assert.equal(detail.body?.order.status, "PAID");
    assert.equal(detail.body?.order.paymentOpen, false);
    assert.equal(detail.body?.order.cancelOpen, false);
    assert.ok(detail.body?.order.paidAt);
    const list = await o.api("/api/v1/orders?status=PAID");
    assert.equal(list.response.status, 200);
    assert.ok(list.body?.items.some((r: any) => r.id === paid.orderId));
    assert.equal((await o.api(`/api/v1/orders/${paid.orderId}/cancel`, {}, "POST")).response.status, 409);
    assert.equal((await o.api(`/api/v1/supply/listings/${paid.accountId}`)).response.status, 404);
    const repeat = await o.api("/api/v1/orders", { accountId: paid.accountId, versionId: paid.versionId, releaseId: paid.releaseId }, "POST");
    assert.equal(repeat.response.status, 409);
    assert.equal((await o.api("/api/auth/user/account/cancel", {}, "POST")).response.status, 409);
    for (const path of [`/api/v1/orders/${paid.orderId}/paid`, "/api/v1/orders/payment-confirmation", `/api/bff/user/orders/${paid.orderId}/paid`]) {
      assert.equal((await o.api(path, { ...paidInput, source: "CONTROLLED" }, "POST")).response.status, 404);
    }
    await assert.rejects(withTransaction(pool, (c) => confirmOrderPayment(c, { ...paidInput, source: "CONTROLLED", merchantScopeId: "oim-fixture-merchant" })), /not verified/);
    for (const config of [{ ...o.config, profile: "dev" }, { ...o.config, profile: "provider-test" }, { ...o.config, provider: "real" }, { ...o.config, testOperationsEnabled: false }, { ...o.config, database: { ...o.config.database, name: "zzsh_dev" } }]) {
      assert.throws(() => createControlledPaymentSource({ config: config as AppConfig, resourceSet: o.resourceSet, appId: "app", merchantScopeId: "merchant", allowedOrderIds: [paid.orderId] }));
    }
    assert.throws(() => source([paid.orderId])({ ...paidInput, source: "CONTROLLED" } as PaymentInput));
    assert.throws(() => source([paid.orderId])({ ...paidInput, orderId: "not_allowlisted" }));
  });
  await t.test("P08 payment with one-connection pool and no IM identity", async () => {
    const first = await o.fixture("付款单连接A");
    const second = await o.fixture("付款单连接B");
    const facts = [source([first.orderId])(await input(first.orderId)), source([second.orderId])(await input(second.orderId))];
    const db = o.config.database;
    const single = new Pool({ host: db.host, port: db.port, database: db.name, user: db.user, password: db.password,
      max: 1, connectionTimeoutMillis: 2000, application_name: "zzsh-oim-payment-single" });
    try {
      const results = await Promise.all(facts.map((fact) => withTransaction(single, (c) => confirmOrderPayment(c, fact))));
      assert.ok(results.every((r) => r.disposition === "APPLIED"));
      for (const id of [first.orderId, second.orderId]) {
        const row = await rows(id);
        assert.equal((await pool.query(`SELECT count(*)::int AS n FROM zzsh_iam.im_identity_mapping WHERE platform_subject_id=ANY($1::text[])`, [[row.owner_user_id, row.renter_user_id]])).rows[0].n, 0);
        assert.equal((await pool.query(`SELECT provision_state,app_id FROM zzsh_order.im_order_group WHERE order_id=$1`, [id])).rows[0].provision_state, "WAITING");
      }
    } finally { await single.end(); }
  });
}
