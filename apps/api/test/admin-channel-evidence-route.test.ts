import assert from "node:assert/strict";
// MODEL/SYNTHETIC fixtures only: no production row, key or channel response.
import test from "node:test";
import type { PoolClient } from "pg";
import { readAdminChannelEvidenceRoute } from "../src/finance/admin-channel-evidence-read";

type Row = Record<string, unknown>;
const DB = "zzsh_test_evidence", USER = "zzsh_evidence_reader", ADMIN = "admin_ev_1", MERCHANT = "mi_ev_1";
const AS_OF = "2026-10-26T09:00:00.000000Z";
class FakeClient { calls: { sql: string; values: readonly unknown[] }[] = [];
  constructor(private readonly respond: (sql: string, values: readonly unknown[]) => Row[]) {}
  async query(sql: string, values: readonly unknown[] = []) { this.calls.push({ sql, values }); return { rows: this.respond(sql, values), rowCount: 0 }; } }
const access = (merchants: string[] = [MERCHANT]) => ({ database: DB, runtimeUser: USER, merchantIdsByAdmin: new Map([[ADMIN, new Set(merchants)]]) });
const actor = (o: { finance?: boolean; order?: boolean; boss?: boolean; directory?: boolean } = {}) => ({ userId: ADMIN, complete: o.finance ?? true,
  relations: { adminId: ADMIN, isBoss: o.boss ?? false, orderRead: o.order ?? true, userDirectoryRead: o.directory ?? false } });
const respond = (orders: Row[]) => (sql: string): Row[] => sql.includes("current_database() AS database") ? [{ database: DB, runtime_user: USER, as_of: AS_OF }]
  : sql.includes("to_regclass") && !sql.includes("all_orders") ? [{ ready: false }] : sql.includes("all_orders") ? orders : [];
const rejects = (p: Promise<unknown>, status: number, code: string) => assert.rejects(p, (e: Error & { status?: number; code?: string }) => e.status === status && e.code === code);
const q = (s = "") => new URLSearchParams(s);
const pool = (c: FakeClient) => c as unknown as PoolClient;

test("channel evidence routes default-deny when server scope is not configured", async () => {
  const c = new FakeClient(respond([]));
  await rejects(readAdminChannelEvidenceRoute(pool(c), actor(), "channel-evidence/orders/ord_1", q(), undefined), 503, "EVIDENCE_UNAVAILABLE");
  assert.equal(c.calls.length, 0);
});
test("order evidence requires order read and a game-scoped visible order", async () => {
  const c = new FakeClient(respond([]));
  await rejects(readAdminChannelEvidenceRoute(pool(c), actor({ order: false }), "channel-evidence/orders/ord_1", q(), access()), 403, "FORBIDDEN");
  assert.equal(c.calls.length, 0);
  await rejects(readAdminChannelEvidenceRoute(pool(c), actor(), "channel-evidence/orders/ord_1", q(), access()), 404, "NOT_FOUND");
  const scoped = c.calls.find(x => x.sql.includes("all_orders"))!;
  assert.deepEqual(scoped.values, [["ord_1"], false, ADMIN]);
  await rejects(readAdminChannelEvidenceRoute(pool(c), actor(), "channel-evidence/orders/ord_1", q("origin=NATIVE"), access()), 400, "INVALID_ARGUMENT");
});
test("order origin is derived from the server row, not the request", async () => {
  const c = new FakeClient(respond([{ id: "ord_1", origin: "LEGACY" }]));
  const body = await readAdminChannelEvidenceRoute(pool(c), actor(), "channel-evidence/orders/ord_1", q(), access()).catch(e => e);
  if (body instanceof Error) assert.equal((body as { status?: number }).status, 503);
  else { assert.equal(body.origin, "LEGACY"); assert.equal((body as any).payment.status, "NOT_APPLICABLE"); assert.equal(body.bankArrival, "UNKNOWN"); }
  assert.ok(c.calls.every(x => !/\b(INSERT|UPDATE|DELETE)\b|FOR UPDATE/i.test(x.sql)));
});
test("withdrawal and original reads only accept server-granted merchants", async () => {
  const c = new FakeClient(respond([]));
  await rejects(readAdminChannelEvidenceRoute(pool(c), actor(), "channel-evidence/withdrawals/mi_other/wi_1", q(), access()), 404, "NOT_FOUND");
  await rejects(readAdminChannelEvidenceRoute(pool(c), actor(), "channel-evidence/originals/mi_other", q("productFamily=PAYOUT"), access()), 404, "NOT_FOUND");
  await rejects(readAdminChannelEvidenceRoute(pool(c), actor({ finance: false }), `channel-evidence/originals/${MERCHANT}`, q("productFamily=PAYOUT&merchantOrderNo=W1"), access()), 403, "FORBIDDEN");
  await rejects(readAdminChannelEvidenceRoute(pool(c), actor(), `channel-evidence/originals/${MERCHANT}`, q("productFamily=CARD"), access()), 400, "INVALID_ARGUMENT");
  await rejects(readAdminChannelEvidenceRoute(pool(c), actor(), `channel-evidence/originals/${MERCHANT}`, q("productFamily=PAYOUT&merchantIdentityId=mi_x"), access()), 400, "INVALID_ARGUMENT");
  assert.equal(c.calls.length, 0);
});

test("user-scoped channel evidence requires both user-directory and finance access", async () => {
  const c = new FakeClient(respond([]));
  const search = `channel-evidence/originals/${MERCHANT}`, query = q("productFamily=PAYOUT&merchantOrderNo=W1&subjectUserId=user_1");
  await rejects(readAdminChannelEvidenceRoute(pool(c), actor(), search, query, access()), 403, "FORBIDDEN");
  await rejects(readAdminChannelEvidenceRoute(pool(c), actor({ finance: false, directory: true }), search, query, access()), 403, "FORBIDDEN");
  assert.equal(c.calls.length, 0);
  const allowed = await readAdminChannelEvidenceRoute(pool(c), actor({ directory: true }), search, query, access());
  assert.equal(allowed.kind, "ORIGINAL_SEARCH");
  await rejects(readAdminChannelEvidenceRoute(pool(c), actor({ directory: true }), search, q("productFamily=PAYOUT&merchantOrderNo=W1&subjectUserId=user_1&subjectUserId=user_2"), access()), 400, "INVALID_ARGUMENT");
});

for (const family of ["ALIPAY_NATIVE", "REFUND"] as const) {
  test(`${family} search returns only game-scoped order links for actors with order read`, async () => {
    const makeClient = () => new FakeClient(sql => {
      if (sql.includes("all_orders")) return [{ id: "ord_1", origin: "NATIVE" }, { id: "ord_3", origin: "LEGACY" }];
      if (sql.includes("to_regclass")) return [{ ready: true }];
      if (sql.includes("current_database() AS database")) return [{ database: DB, runtime_user: USER, as_of: AS_OF }];
      return [1, 2, 3].map(n => ({ merchant_identity_id: MERCHANT, order_id: `ord_${n}`, amount_cents: "10000", currency: "CNY",
        recorded_at: AS_OF, state: "UNKNOWN", ...(family === "REFUND"
          ? { intent_id: `refund_${n}`, refund_order_no: `RF${n}`, original_payment_order_no: "ORDER_1", original_payment_trx_no: null,
              provider_refund_trx_no: null, posting_id: null, terminal_evidence_id: null, budget_disposition: "ALLOCATED", requires_review: false }
          : { request_id: "preq_1", method: family, merchant_order_no: "ORDER_1", channel_trx_no: `TRX_${n}` }) }));
    });
    const run = (c: FakeClient, order: boolean) => readAdminChannelEvidenceRoute(pool(c), actor({ order }), `channel-evidence/originals/${MERCHANT}`,
      q(`productFamily=${family}&merchantOrderNo=ORDER_1`), access());
    const c = makeClient();
    const linked = await run(c, true);
    assert.equal(linked.kind, "ORIGINAL_SEARCH");
    assert.equal(linked.bankArrival, "UNKNOWN");
    assert.ok(linked.search);
    assert.equal(linked.search.status, "AMBIGUOUS");
    assert.deepEqual(linked.search.candidates.map(candidate => candidate.orderId), ["ord_1", null, null]);
    assert.ok(linked.search.reasonCodes.includes("ORDER_LINK_REDACTED"));
    const scopes = c.calls.filter(call => call.sql.includes("all_orders"));
    assert.equal(scopes.length, 1);
    assert.deepEqual(scopes[0]!.values, [["ord_1", "ord_2", "ord_3"], false, ADMIN]);
    assert.match(scopes[0]!.sql, /sgame\."game_id" = x\.game_id/);

    const withoutOrder = makeClient();
    const redacted = await run(withoutOrder, false);
    assert.equal(redacted.kind, "ORIGINAL_SEARCH");
    assert.ok(redacted.search);
    assert.deepEqual(redacted.search.candidates.map(candidate => candidate.orderId), [null, null, null]);
    assert.ok(!withoutOrder.calls.some(call => call.sql.includes("all_orders")));
  });
}
