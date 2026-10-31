import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
import type { Pool, PoolClient } from "pg";

import * as adminAuthorization from "../src/auth/admin-authorization";
import * as adminScope from "../src/auth/admin-scope";
import * as authSecurity from "../src/auth/auth-security";
import { assertOpeningOnBehalfAccess } from "../src/order/settlement-record";
import {
  OPENING_AUTO_CONFIRM_MS,
  openingAutoConfirmDueAt,
  openingConfirmStep,
  isOpeningAutoConfirmDue,
  runOpeningAutoConfirmBatch,
} from "../src/order/opening-auto-confirm";

const MINUTE = 60_000;

test("the auto-confirm rule is 40 minutes from DRAFT creation, inclusive at the boundary", () => {
  assert.equal(OPENING_AUTO_CONFIRM_MS, 40 * MINUTE, "Owner-approved rule is 40 minutes, not 15");
  const created = "2026-10-31T00:00:00.000Z";
  assert.equal(openingAutoConfirmDueAt(created), "2026-10-31T00:40:00.000Z");
  assert.equal(openingAutoConfirmDueAt("not-a-time"), null);
  assert.equal(isOpeningAutoConfirmDue(created, Date.parse(created) + 40 * MINUTE - 1), false, "one millisecond before is not due");
  assert.equal(isOpeningAutoConfirmDue(created, Date.parse(created) + 40 * MINUTE), true, "exactly 40 minutes is due");
  assert.equal(isOpeningAutoConfirmDue(created, Date.parse(created) + 41 * MINUTE), true);
  assert.equal(isOpeningAutoConfirmDue("not-a-time", Date.now()), false);
});

test("confirmation never touches a superseded or stale version", () => {
  const base = { status: "DRAFT", openingVersionNo: 2, requestedVersionNo: 2, latestVersionNo: 2, acks: ["RENTER"] } as const;
  assert.deepEqual(openingConfirmStep({ ...base, mode: "PARTY", party: "OWNER" }), { kind: "ACK", parties: ["OWNER"], completes: true });
  assert.deepEqual(openingConfirmStep({ ...base, acks: [], mode: "PARTY", party: "RENTER" }), { kind: "ACK", parties: ["RENTER"], completes: false });
  assert.deepEqual(openingConfirmStep({ ...base, requestedVersionNo: 1, mode: "PARTY", party: "OWNER" }), { kind: "STALE" });
  assert.deepEqual(openingConfirmStep({ ...base, latestVersionNo: 3, mode: "PARTY", party: "OWNER" }), { kind: "STALE" }, "a newer DRAFT supersedes the card's version");
  assert.deepEqual(openingConfirmStep({ ...base, status: "CONFIRMED", mode: "ON_BEHALF", party: "OWNER" }), { kind: "ALREADY_CONFIRMED" });
  assert.deepEqual(openingConfirmStep({ ...base, acks: ["RENTER", "OWNER"], mode: "ON_BEHALF", party: "OWNER" }), { kind: "ALREADY_ACKED" });
});

test("auto mode fills both missing parties and confirms even when both are missing", () => {
  const base = { status: "DRAFT", openingVersionNo: 1, requestedVersionNo: 1, latestVersionNo: 1, mode: "AUTO" } as const;
  assert.deepEqual(openingConfirmStep({ ...base, acks: [] }), { kind: "ACK", parties: ["RENTER", "OWNER"], completes: true });
  assert.deepEqual(openingConfirmStep({ ...base, acks: ["RENTER"] }), { kind: "ACK", parties: ["OWNER"], completes: true });
  assert.deepEqual(openingConfirmStep({ ...base, acks: ["RENTER", "OWNER"] }), { kind: "ALREADY_ACKED" });
  assert.deepEqual(openingConfirmStep({ ...base, acks: [], latestVersionNo: 2 }), { kind: "STALE" });
});

type Query = { sql: string; params?: unknown[] };
function fakeWorkerPool(state: {
  candidates: Array<{ id: string; orderId: string; versionNo: number }>;
  orderStatus?: string;
  latestVersionNo?: number;
  acks?: string[];
  updateRowCount?: number;
  lockError?: { code: string };
}) {
  const queries: Query[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK" || sql.includes("set_config")) return { rows: [], rowCount: 0 };
      if (sql.includes("FROM zzsh_order.rental_order WHERE id = $1 FOR UPDATE")) {
        return { rows: [{ status: state.orderStatus ?? "PAID", renterUserId: "user_renter", ownerUserId: "user_owner" }], rowCount: 1 };
      }
      if (sql.includes("FROM zzsh_order.rental_opening op") && sql.includes("FOR UPDATE")) {
        return { rows: [{
          id: "opening_1", versionNo: 1, status: "DRAFT",
          latestVersionNo: state.latestVersionNo ?? 1, due: true,
        }], rowCount: 1 };
      }
      if (sql.includes("FROM zzsh_order.rental_opening_ack")) return { rows: (state.acks ?? []).map((party) => ({ party })), rowCount: state.acks?.length ?? 0 };
      if (sql.includes("INSERT INTO zzsh_order.rental_opening_ack")) return { rows: [], rowCount: 1 };
      if (sql.startsWith("UPDATE zzsh_order.rental_opening")) return { rows: [], rowCount: state.updateRowCount ?? 1 };
      if (sql.includes("INSERT INTO \"zzsh_iam\".\"audit_event\"")) return { rows: [], rowCount: 1 };
      throw new Error(`UNEXPECTED_SQL ${sql}`);
    },
    release() {},
  } as unknown as PoolClient;
  const pool = {
    async query(sql: string) {
      queries.push({ sql });
      if (sql.includes("FROM zzsh_order.rental_opening op") && sql.includes("auto_confirm_due_at")) return { rows: state.candidates, rowCount: state.candidates.length };
      throw new Error(`UNEXPECTED_POOL_SQL ${sql}`);
    },
    async connect() {
      if (state.lockError) throw state.lockError;
      return client;
    },
  } as unknown as Pool;
  return { pool, queries };
}

test("auto-confirm is idempotent at the row level and confirms both missing parties", async () => {
  const { pool, queries } = fakeWorkerPool({
    candidates: [{ id: "opening_1", orderId: "order_1", versionNo: 1 }],
    acks: [],
  });
  const first = await runOpeningAutoConfirmBatch(pool, { batchLimit: 10, lockTimeoutMs: 1000, requestId: () => "req_test" });
  assert.deepEqual(first.confirmed, ["order_1"]);
  assert.equal(queries.filter((entry) => entry.sql.includes("INSERT INTO zzsh_order.rental_opening_ack")).length, 2, "both missing parties are acknowledged");
  const update = queries.find((entry) => entry.sql.startsWith("UPDATE zzsh_order.rental_opening"));
  assert.ok(update, "opening status is confirmed");
  assert.match(update!.sql, /status = 'DRAFT'/);
  assert.match(update!.sql, /auto_confirm_due_at <= clock_timestamp\(\)/, "the due rule is re-checked in the update");
  assert.match(update!.sql, /confirm_source = 'AUTO'/);
  const audits = queries.filter((entry) => entry.sql.includes('INSERT INTO "zzsh_iam"."audit_event"') && JSON.stringify(entry.params ?? []).includes("order.opening.auto_confirmed"));
  assert.equal(audits.length, 1, "one audit event per confirmation");
});

test("only one party is filled when the other already acknowledged", async () => {
  const { pool, queries } = fakeWorkerPool({
    candidates: [{ id: "opening_1", orderId: "order_1", versionNo: 1 }],
    acks: ["RENTER"],
  });
  const result = await runOpeningAutoConfirmBatch(pool, { batchLimit: 10, lockTimeoutMs: 1000, requestId: () => "req_test" });
  assert.deepEqual(result.confirmed, ["order_1"]);
  const inserts = queries.filter((entry) => entry.sql.includes("INSERT INTO zzsh_order.rental_opening_ack"));
  assert.equal(inserts.length, 1);
  assert.equal((inserts[0]!.params as unknown[])[1], "OWNER");
});

test("a superseded version is skipped without any write", async () => {
  const { pool, queries } = fakeWorkerPool({
    candidates: [{ id: "opening_1", orderId: "order_1", versionNo: 1 }],
    latestVersionNo: 2,
  });
  const result = await runOpeningAutoConfirmBatch(pool, { batchLimit: 10, lockTimeoutMs: 1000, requestId: () => "req_test" });
  assert.deepEqual(result.confirmed, []);
  assert.deepEqual(result.skipped, ["order_1"]);
  assert.equal(queries.some((entry) => entry.sql.startsWith("UPDATE zzsh_order.rental_opening")), false);
  assert.equal(queries.some((entry) => entry.sql.includes("INSERT INTO zzsh_order.rental_opening_ack")), false);
});

test("cancelled or non-PAID orders are never auto-confirmed", async () => {
  const { pool, queries } = fakeWorkerPool({
    candidates: [{ id: "opening_1", orderId: "order_1", versionNo: 1 }],
    orderStatus: "CANCELLED",
  });
  const result = await runOpeningAutoConfirmBatch(pool, { batchLimit: 10, lockTimeoutMs: 1000, requestId: () => "req_test" });
  assert.deepEqual(result.confirmed, []);
  assert.equal(queries.some((entry) => entry.sql.startsWith("UPDATE zzsh_order.rental_opening")), false);
});

test("row lock contention is reported without claiming success", async () => {
  const { pool } = fakeWorkerPool({
    candidates: [{ id: "opening_1", orderId: "order_1", versionNo: 1 }],
    lockError: { code: "55P03" },
  });
  const result = await runOpeningAutoConfirmBatch(pool, { batchLimit: 10, lockTimeoutMs: 1000, requestId: () => "req_test" });
  assert.deepEqual(result.confirmed, []);
  assert.deepEqual(result.skippedLocked, ["order_1"]);
});

function mockAdminAccess(t: TestContext, permissions: string[], isBoss = false) {
  t.mock.method(authSecurity, "assertAdminContextInTransaction", async () => {});
  t.mock.method(adminScope, "readAdminGameScope", async () => ({ mode: "ALL_GAMES" as const, gameIds: [] }));
  t.mock.method(adminAuthorization, "loadEffectiveAdminAccess", async () => ({
    status: "ACTIVE" as const, isBoss, passwordChangeRequired: false, permissions: new Set(permissions),
  }));
}
function accessClient(responsibleAdminId: string | null): PoolClient {
  return {
    async query(sql: string) {
      if (sql.includes("SELECT game_id AS \"gameId\" FROM zzsh_order.rental_order")) return { rows: [{ gameId: "game_1" }], rowCount: 1 };
      if (sql.includes("FROM zzsh_order.im_order_member mm")) return { rows: [{ one: 1 }], rowCount: 1 };
      if (sql.includes("responsible_admin_id")) return { rows: [{ responsibleAdminId }], rowCount: 1 };
      throw new Error(`UNEXPECTED_SQL ${sql}`);
    },
  } as unknown as PoolClient;
}
const denied = (error: unknown) => (error as { status?: number }).status === 403;

test("CS confirmation on behalf requires order.settlement.write", async (t) => {
  mockAdminAccess(t, []);
  await assert.rejects(assertOpeningOnBehalfAccess(accessClient("admin_1"), "order_1", { userId: "admin_1", sessionId: "session_1" }), denied);
});

test("a non-responsible admin cannot confirm for a missing party", async (t) => {
  mockAdminAccess(t, ["order.settlement.write"]);
  await assert.rejects(assertOpeningOnBehalfAccess(accessClient("admin_other"), "order_1", { userId: "admin_1", sessionId: "session_1" }), denied);
  await assert.rejects(assertOpeningOnBehalfAccess(accessClient(null), "order_1", { userId: "admin_1", sessionId: "session_1" }), denied);
});

test("the responsible admin passes the CS on-behalf boundary", async (t) => {
  mockAdminAccess(t, ["order.settlement.write"]);
  await assert.doesNotReject(assertOpeningOnBehalfAccess(accessClient("admin_1"), "order_1", { userId: "admin_1", sessionId: "session_1" }));
});
