import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";

import {
  readOpeningAutoConfirmPolicy, updateOpeningAutoConfirmPolicy, validateOpeningAutoConfirmPolicy,
} from "../src/order/opening-auto-confirm-policy";

const actor = { id: "admin", sessionId: "session" };

test("opening auto-confirm policy accepts 1-10080 integer minutes and rejects 0 or out-of-range", async () => {
  for (const input of [
    { waitMinutes: 0, expectedRevision: "1" },
    { waitMinutes: 10081, expectedRevision: "1" },
    { waitMinutes: 1.5, expectedRevision: "1" },
    { waitMinutes: 40, expectedRevision: "0" },
  ]) assert.throws(() => validateOpeningAutoConfirmPolicy(input));
  for (const waitMinutes of [1, 40, 10080]) assert.doesNotThrow(() => validateOpeningAutoConfirmPolicy({ waitMinutes, expectedRevision: "1" }));
  const missing = { query: async () => ({ rows: [{ available: false }] }) } as unknown as PoolClient;
  assert.deepEqual(await readOpeningAutoConfirmPolicy(missing), { waitMinutes: 40, revision: "0", available: false });
  await assert.rejects(updateOpeningAutoConfirmPolicy(missing, actor, { waitMinutes: 40, expectedRevision: "1" }, "req"));
});

test("opening auto-confirm policy uses a locked revision and audits future-only changes", async () => {
  const audit: unknown[][] = [];
  const client = { query: async (sql: string, values: unknown[] = []) => {
    if (sql.includes("to_regclass")) return { rows: [{ available: true }] };
    if (sql.startsWith("SELECT")) { assert.match(sql, /FOR UPDATE/); return { rows: [{ waitMinutes: 40, revision: "1" }] }; }
    if (sql.startsWith("UPDATE")) { assert.deepEqual(values, [75, "admin"]); return { rows: [{ waitMinutes: 75, revision: "2" }] }; }
    if (sql.includes('"audit_event"')) { audit.push(values); return { rows: [] }; }
    throw new Error("unexpected SQL");
  } } as unknown as PoolClient;
  await assert.rejects(updateOpeningAutoConfirmPolicy(client, actor, { waitMinutes: 75, expectedRevision: "2" }, "req"));
  assert.equal(audit.length, 0);
  const result = await updateOpeningAutoConfirmPolicy(client, actor, { waitMinutes: 75, expectedRevision: "1" }, "req");
  assert.deepEqual(result, { policy: { waitMinutes: 75, revision: "2", available: true }, changed: true });
  assert.equal(audit.length, 1);
  assert.equal(audit[0]![4], "order.opening.auto_confirm.policy.updated");
  assert.equal(JSON.parse(audit[0]![10] as string).appliesTo, "FUTURE_OPENINGS");
});
