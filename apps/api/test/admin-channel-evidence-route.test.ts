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
const actor = (o: { finance?: boolean; order?: boolean; boss?: boolean } = {}) => ({ userId: ADMIN, complete: o.finance ?? true,
  relations: { adminId: ADMIN, isBoss: o.boss ?? false, orderRead: o.order ?? true } });
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
  const c = new FakeClient(respond([{ origin: "LEGACY" }]));
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