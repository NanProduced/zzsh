import { test } from "node:test";
import assert from "node:assert/strict";
import type { PoolClient } from "pg";
import { readSettlementRefundPolicy, updateSettlementRefundPolicy, validateSettlementRefundPolicy } from "../src/order/settlement-refund-policy";

const actor = { id: "admin", sessionId: "session" };

test("refund policy rejects invalid days and reports an uninstalled policy as unavailable", async () => {
  for (const input of [
    { normalDays: -1, earlyDays: 7, expectedRevision: "1" },
    { normalDays: 0, earlyDays: 366, expectedRevision: "1" },
    { normalDays: 0.5, earlyDays: 7, expectedRevision: "1" },
    { normalDays: 0, earlyDays: 7, expectedRevision: "0" },
  ]) assert.throws(() => validateSettlementRefundPolicy(input));
  const client = { query: async () => ({ rows: [{ available: false }] }) } as unknown as PoolClient;
  assert.deepEqual(await readSettlementRefundPolicy(client), { normalDays: 0, earlyDays: 7, revision: "0", available: false });
  await assert.rejects(updateSettlementRefundPolicy(client, actor, { normalDays: 0, earlyDays: 7, expectedRevision: "1" }, "req"));
});

test("refund policy uses a locked revision and audits an actual change", async () => {
  const audit: unknown[][] = [];
  const client = { query: async (sql: string, values: unknown[] = []) => {
    if (sql.includes("to_regclass")) return { rows: [{ available: true }] };
    if (sql.startsWith("SELECT")) { assert.match(sql, /FOR UPDATE/); return { rows: [{ normalDays: 0, earlyDays: 7, revision: "1" }] }; }
    if (sql.startsWith("UPDATE")) { assert.deepEqual(values, [1, 4, "admin"]); return { rows: [{ normalDays: 1, earlyDays: 4, revision: "2" }] }; }
    if (sql.includes('"audit_event"')) { audit.push(values); return { rows: [] }; }
    throw new Error("unexpected SQL");
  } } as unknown as PoolClient;
  await assert.rejects(updateSettlementRefundPolicy(client, actor, { normalDays: 1, earlyDays: 4, expectedRevision: "2" }, "req"));
  assert.equal(audit.length, 0);
  const result = await updateSettlementRefundPolicy(client, actor, { normalDays: 1, earlyDays: 4, expectedRevision: "1" }, "req");
  assert.deepEqual(result, { policy: { normalDays: 1, earlyDays: 4, revision: "2", available: true }, changed: true });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]![4], "order.settlement.refund_policy.updated");
  assert.equal(JSON.parse(audit[0]![10] as string).appliesTo, "FUTURE_SETTLEMENTS");
});
