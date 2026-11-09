import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";
import type { PoolClient } from "pg";

import { openingRecoveryRequired, recordAutomaticOpening, recordAutomaticOpeningFailure } from "../src/order/settlement-record";
import { isOpeningReminderRequestKey } from "../src/order/opening-progress-reminder";

type Query = { sql: string; params?: unknown[] };
function client(state: {
  payment?: Record<string, unknown> | null;
  opening?: { id: string } | null;
  order?: Record<string, unknown> | null;
}) {
  const queries: Query[] = [];
  const value = {
    async query(sql: string, params?: unknown[]) {
      queries.push({ sql, params });
      if (sql.includes("FROM zzsh_order.payment_confirmation")) return { rows: state.payment === undefined
        ? [{ id: "payment_1", amountCents: "100", currency: "CNY", disposition: "APPLIED" }]
        : state.payment === null ? [] : [state.payment], rowCount: 1 };
      if (sql.includes("FROM zzsh_order.rental_opening WHERE order_id")) return { rows: state.opening ? [state.opening] : [], rowCount: state.opening ? 1 : 0 };
      if (sql.includes("FROM zzsh_order.rental_order o")) return { rows: state.order === undefined ? [{
        id: "order_1", renterUserId: "r", ownerUserId: "o", accountId: "a", listingVersionId: "l", gameId: "g",
        status: "PAID", depositCents: "0", contentHash: "hash", ruleReleaseId: "release", quote: null, revision: "1", appId: "app",
      }] : state.order === null ? [] : [state.order], rowCount: 1 };
      if (sql.includes("INSERT INTO zzsh_order.rental_opening_generation")) return { rows: [], rowCount: 1 };
      if (sql.includes("opening_generation_recovery_required=false")) return { rows: [], rowCount: 1 };
      if (sql.includes('"audit_event"')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected SQL ${sql}`);
    },
  } as unknown as PoolClient;
  return { client: value, queries };
}

test("a missing frozen quote keeps the payment fact and records a recoverable review reason", async () => {
  const { client: c, queries } = client({});
  const result = await recordAutomaticOpening(c, "order_1", "payment_1", "req_1");
  assert.deepEqual(result, { state: "REVIEW_REQUIRED", reason: "QUOTE_BASIS_INVALID" });
  const generation = queries.find((query) => query.sql.includes("INSERT INTO zzsh_order.rental_opening_generation"))!;
  assert.deepEqual(generation.params, ["order_1", "payment_1", "QUOTE_BASIS_INVALID"]);
  const audit = queries.find((query) => query.sql.includes('"audit_event"'))!;
  assert.ok(audit.params!.some((value) => value === "order.opening.auto_review_required"));
  assert.equal(queries.some((query) => query.sql.includes("INSERT INTO zzsh_order.rental_opening\n")), false, "no opening is fabricated");
});

test("an open v1 standard quote is recorded for review without fabricating a basis", async () => {
  const { client: c, queries } = client({
    order: {
      id: "order_1", renterUserId: "r", ownerUserId: "o", accountId: "a", listingVersionId: "l", gameId: "g",
      status: "PAID", depositCents: "0", contentHash: "hash", ruleReleaseId: "release",
      quote: { schemaVersion: 1, lines: [{ itemId: "item_1", quantity: "1" }] }, revision: "1", appId: "app",
    },
  });
  assert.deepEqual(await recordAutomaticOpening(c, "order_1", "payment_1", "req_1"),
    { state: "REVIEW_REQUIRED", reason: "LEGACY_V1_QUOTE_REVIEW" });
  assert.equal(queries.some((query) => query.sql.includes("INSERT INTO zzsh_order.rental_opening\n")), false);
});

test("a paid order without any opening fact is recoverable even when the marker write failed", () => {
  const base = { marker: false, status: "PAID", hasOpening: false, hasGeneration: false, hasAcceptedPayment: true };
  assert.equal(openingRecoveryRequired(base), true);
  assert.equal(openingRecoveryRequired({ ...base, marker: true, hasAcceptedPayment: false }), true, "the durable marker still wins");
  assert.equal(openingRecoveryRequired({ ...base, status: "COMPLETED" }), false, "only a paid order needs opening recovery");
  assert.equal(openingRecoveryRequired({ ...base, hasOpening: true }), false);
  assert.equal(openingRecoveryRequired({ ...base, hasGeneration: true }), false);
  assert.equal(openingRecoveryRequired({ ...base, hasAcceptedPayment: false }), false, "no accepted payment means no recovery claim");
});

test("a review write failure still leaves an order-level recovery marker", async () => {
  const queries: Query[] = [];
  const client = { query: async (sql: string, params?: unknown[]) => {
    queries.push({ sql, params });
    if (sql.includes("INSERT INTO zzsh_order.rental_opening_generation")) throw Object.assign(new Error("missing table"), { code: "42P01" });
    if (sql === "SAVEPOINT automatic_opening_failure_record" || sql === "ROLLBACK TO SAVEPOINT automatic_opening_failure_record"
      || sql === "RELEASE SAVEPOINT automatic_opening_failure_record") return { rows: [], rowCount: 0 };
    if (sql.includes("opening_generation_recovery_required=true")) return { rows: [], rowCount: 1 };
    throw new Error(`unexpected SQL ${sql}`);
  } } as unknown as PoolClient;
  await recordAutomaticOpeningFailure(client, "order_1", "payment_1", "req_1", { code: "42P01" });
  assert.ok(queries.some((query) => query.sql.includes("UPDATE zzsh_order.rental_order SET opening_generation_recovery_required=true")));
});

test("an existing opening is returned without creating a second version", async () => {
  const { client: c, queries } = client({ opening: { id: "opening_1" } });
  assert.deepEqual(await recordAutomaticOpening(c, "order_1", "payment_1", "req_1"), { state: "EXISTS", openingId: "opening_1" });
  assert.equal(queries.some((query) => query.sql.includes("INSERT INTO zzsh_order.rental_opening")), false);
});

test("a non-applied payment is never used as an opening basis", async () => {
  const { client: c, queries } = client({ payment: { id: "payment_1", amountCents: "100", currency: "CNY", disposition: "REVIEW_REQUIRED" } });
  assert.deepEqual(await recordAutomaticOpening(c, "order_1", "payment_1", "req_1"), { state: "REVIEW_REQUIRED", reason: "PAYMENT_BASIS_MISSING" });
  assert.equal(queries.some((query) => query.sql.includes("FROM zzsh_order.rental_order o")), false);
});

test("migration freezes the new policy and leaves existing DRAFT deadlines untouched", () => {
  const sql = readFileSync(resolve("migrations/business/0180_opening_auto_generation.sql"), "utf8");
  assert.match(sql, /ALTER COLUMN "created_by_admin_id" DROP NOT NULL/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "created_by_source" text NOT NULL DEFAULT 'ADMIN'/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "payment_confirmation_id" text/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "zzsh_order"\."opening_auto_confirm_policy"/);
  assert.match(sql, /"wait_minutes" integer NOT NULL DEFAULT 40 CHECK \("wait_minutes" BETWEEN 1 AND 10080\)/);
  assert.match(sql, /SELECT "revision", "wait_minutes" INTO policy/);
  assert.match(sql, /NEW\."auto_confirm_due_at" := NEW\."created_at" \+ policy\."wait_minutes" \* interval '1 minute'/);
  assert.doesNotMatch(sql, /UPDATE "zzsh_order"\."rental_opening"[\s\S]*auto_confirm_due_at/, "the migration never recomputes historical due times");
  assert.match(sql, /COMMENT ON TABLE "zzsh_order"\."opening_auto_confirm_policy"/);
  assert.match(sql, /COMMENT ON TABLE "zzsh_order"\."rental_opening_generation"/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "zzsh_order"\."opening_progress_reminder"/);
  assert.match(sql, /opening_progress_reminder_request_unique/);
});

test("reminder requests keep their own idempotency key and are wired through the guarded admin route", () => {
  assert.equal(isOpeningReminderRequestKey("support_reminder_1234"), true);
  assert.equal(isOpeningReminderRequestKey("short"), false);
  assert.equal(isOpeningReminderRequestKey("bad key with spaces"), false);
  assert.equal(isOpeningReminderRequestKey(""), false);
  const route = readFileSync(resolve("src/order/order-routes.ts"), "utf8");
  assert.match(route, /progress-reminders/);
  assert.match(route, /opening-generation\\\/retry/);
  assert.match(route, /prepareOpeningProgressReminder/);
  assert.match(route, /cardTransport\.card/);
  assert.match(route, /recordOrderGroupMessage/);
  assert.match(route, /ORDER_OPENING/);
  assert.match(route, /messageClientId: prepared\.id/);
  const bff = readFileSync(resolve("src/bff/admin-bff.ts"), "utf8");
  assert.match(bff, /progressReminderPath/);
  assert.match(bff, /openingGenerationRetryPath/);
});
