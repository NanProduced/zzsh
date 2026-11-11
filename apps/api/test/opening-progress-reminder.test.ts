import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";

import {
  markOpeningProgressReminder, openingReminderText, planOrderProgressReminder, reminderDeliveryDisposition,
  reminderPlanMatchesExisting,
} from "../src/order/opening-progress-reminder";

function planner(state: {
  status?: string; opening?: { id: string; status: string } | null;
  generation?: string | null; acks?: string[]; posted?: boolean;
  intake?: boolean; current?: boolean; decided?: string[]; rejected?: string[]; staleFee?: boolean;
}) {
  return { query: async (sql: string) => {
    if (sql.includes("FROM zzsh_order.rental_order")) return { rows: [{ status: state.status ?? "PAID", displayNo: "ZZ-1", renterUserId: "u-r", ownerUserId: "u-o" }] };
    if (sql.includes("FROM zzsh_order.settlement_posting")) return { rows: state.posted ? [{}] : [], rowCount: state.posted ? 1 : 0 };
    if (sql.includes("FROM zzsh_order.rental_opening WHERE order_id")) return { rows: state.opening ? [state.opening] : [] };
    if (sql.includes("FROM zzsh_order.rental_opening_generation")) return { rows: state.generation ? [{ state: state.generation }] : [] };
    if (sql.includes("FROM zzsh_order.rental_opening_ack")) return { rows: (state.acks ?? []).map((party) => ({ party })) };
    if (sql.includes("FROM zzsh_order.settlement_intake")) return { rows: state.intake ? [{ id: "intake-1" }] : [] };
    if (sql.includes("FROM zzsh_order.settlement_version")) return { rows: state.current ? [{ id: "version-1", inputSnapshot: state.staleFee ? { endReason:"TENANT_VOLUNTARY_EARLY", amounts:{feePayer:"RENTER"} } : null }] : [] };
    if (sql.includes("FROM zzsh_order.settlement_decision")) return { rows: [
      ...(state.decided ?? []).map((party) => ({ party, action: "CONFIRM" })),
      ...(state.rejected ?? []).map((party) => ({ party, action: "REJECT" })),
    ] };
    throw new Error(`unexpected SQL ${sql}`);
  } } as unknown as PoolClient;
}

test("opening reminders target only the missing party and carry no private amounts", async () => {
  const plan = await planOrderProgressReminder(planner({ opening: { id: "opening-1", status: "DRAFT" }, acks: ["RENTER"] }), "order-1");
  assert.equal(plan.kind, "READY");
  if (plan.kind !== "READY") return;
  assert.equal(plan.stage, "OPENING_PENDING");
  assert.deepEqual(plan.targets, ["OWNER"]);
  assert.match(plan.text, /ZZ-1/);
  assert.match(plan.text, /号主/);
  assert.doesNotMatch(plan.text, /元|金额|¥/);
  assert.equal(openingReminderText("ZZ-1", "IN_RENTAL", ["RENTER", "OWNER"]), "【履约提醒】订单 ZZ-1 仍在租期中，如需结束，请到订单页发起结算并核对剩余资源。");
});

test("reminders never replace a missing or reviewed opening, and stay silent after posting", async () => {
  assert.deepEqual(await planOrderProgressReminder(planner({ opening: null, generation: "REVIEW_REQUIRED" }), "order-1"),
    { kind: "NO_ACTION", reason: "OPENING_REVIEW_REQUIRED" });
  assert.deepEqual(await planOrderProgressReminder(planner({ opening: null }), "order-1"),
    { kind: "NO_ACTION", reason: "OPENING_MISSING" });
  assert.deepEqual(await planOrderProgressReminder(planner({ posted: true }), "order-1"),
    { kind: "NO_ACTION", reason: "SETTLEMENT_POSTED" });
  assert.deepEqual(await planOrderProgressReminder(planner({ status: "COMPLETED" }), "order-1"),
    { kind: "NO_ACTION", reason: "ORDER_NOT_ACTIVE" });
  assert.deepEqual(await planOrderProgressReminder(planner({ opening: { id:"opening-1", status:"CONFIRMED" }, current:true, staleFee:true }), "order-1"),
    { kind: "NO_ACTION", reason: "SETTLEMENT_FEE_RECONFIRM_REQUIRED" });
});

test("a late failure cannot overwrite a sent reminder and transport errors stay unknown", async () => {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  let updates = 0;
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      if (["BEGIN", "COMMIT", "ROLLBACK"].includes(sql)) return { rows: [], rowCount: 0 };
      if (sql.startsWith("UPDATE zzsh_order.opening_progress_reminder")) {
        updates += 1;
        return { rows: [], rowCount: updates === 1 ? 1 : 0 };
      }
      if (sql.startsWith("SELECT state FROM zzsh_order.opening_progress_reminder")) return { rows: [{ state: "SENT" }], rowCount: 1 };
      if (sql.includes('"audit_event"')) return { rows: [], rowCount: 1 };
      throw new Error(`unexpected SQL ${sql}`);
    },
    release() {},
  };
  const pool = { connect: async () => client } as never;
  const reminder = { kind: "SEND" as const, id: "reminder_1", orderId: "order_1", stage: "OPENING_PENDING" as const,
    targets: ["RENTER" as const], text: "", appId: "app", teamId: "9001", systemAccount: "sys", leaseToken: "token-1" };
  const actor = { userId: "admin_a", sessionId: "session_a" };
  assert.equal(await markOpeningProgressReminder(pool, reminder, actor, "SENT", "req", null, "server-1"), true);
  assert.equal(await markOpeningProgressReminder(pool, reminder, actor, "FAILED", "req", "SEND_FAILED"), true, "a later failure observes the already-sent terminal state");
  const updateSql = statements.filter((entry) => entry.sql.startsWith("UPDATE")).map((entry) => entry.sql).join("\n");
  assert.match(updateSql, /state = 'SENDING' AND lease_token_hash = \$3/);
  assert.equal(statements.filter((entry) => entry.sql.includes('"audit_event"')).length, 1, "only the successful transition audits");
  assert.equal(reminderDeliveryDisposition(Object.assign(new Error(), { name: "YunxinTransportError" })), "UNKNOWN");
  assert.equal(reminderDeliveryDisposition(Object.assign(new Error(), { name: "YunxinApiError", providerCode: 403 })), "FAILED");
  for (const failure of [
    { providerCode: 500, retryable: true, httpStatus: 500 },
    { providerCode: 429, retryable: true, httpStatus: 429 },
    { providerCode: 503, retryable: false, httpStatus: 503 },
  ]) assert.equal(reminderDeliveryDisposition(Object.assign(new Error(), { name: "YunxinApiError", ...failure })), "UNKNOWN");
  for (const code of ["ECONNRESET", "ETIMEDOUT", "SEND_FAILED"]) {
    assert.equal(reminderDeliveryDisposition(Object.assign(new Error(), { code })), "UNKNOWN",
      `a generic ${code} never proves the message was unsent`);
  }
});

test("a retried reminder key cannot replay a stage that has already moved on", () => {
  assert.equal(reminderPlanMatchesExisting(
    { stage: "OPENING_PENDING", targets: ["RENTER", "OWNER"] },
    { kind: "READY", stage: "IN_RENTAL", targets: ["RENTER", "OWNER"], text: "" },
  ), false);
  assert.equal(reminderPlanMatchesExisting(
    { stage: "OPENING_PENDING", targets: ["RENTER", "OWNER"] },
    { kind: "NO_ACTION", reason: "SETTLEMENT_POSTED" },
  ), false);
  assert.equal(reminderPlanMatchesExisting(
    { stage: "OPENING_PENDING", targets: ["OWNER", "RENTER"] },
    { kind: "READY", stage: "OPENING_PENDING", targets: ["RENTER", "OWNER"], text: "" },
  ), true, "the same stage and recipients keep the original request");
});

test("confirmed openings remind only the settlement parties who have not decided", async () => {
  const waiting = await planOrderProgressReminder(planner({
    opening: { id: "opening-1", status: "CONFIRMED" }, current: true, decided: ["RENTER"],
  }), "order-1");
  assert.equal(waiting.kind, "READY");
  if (waiting.kind === "READY") {
    assert.equal(waiting.stage, "SETTLEMENT_DECISION");
    assert.deepEqual(waiting.targets, ["OWNER"]);
  }
  assert.deepEqual(await planOrderProgressReminder(planner({
    opening: { id: "opening-1", status: "CONFIRMED" }, current: true, decided: ["RENTER", "OWNER"],
  }), "order-1"), { kind: "NO_ACTION", reason: "PARTIES_CONFIRMED" });
  assert.deepEqual(await planOrderProgressReminder(planner({
    opening: { id: "opening-1", status: "CONFIRMED" }, current: true, rejected: ["RENTER"],
  }), "order-1"), { kind: "NO_ACTION", reason: "DECISION_REJECTED" });
  assert.deepEqual(await planOrderProgressReminder(planner({
    opening: { id: "opening-1", status: "CONFIRMED" }, intake: true,
  }), "order-1"), { kind: "NO_ACTION", reason: "INTAKE_PENDING" });
  const renting = await planOrderProgressReminder(planner({ opening: { id: "opening-1", status: "CONFIRMED" } }), "order-1");
  assert.equal(renting.kind, "READY");
  if (renting.kind === "READY") assert.equal(renting.stage, "IN_RENTAL");
});
