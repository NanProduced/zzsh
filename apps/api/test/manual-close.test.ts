import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { orderHasPaidState } from "../src/order/order";

test("manual close is a paid cancellation, while unpaid cancellations stay unpaid", () => {
  assert.equal(orderHasPaidState("PAID", null), true);
  assert.equal(orderHasPaidState("COMPLETED", null), true);
  assert.equal(orderHasPaidState("CANCELLED", "PRESTART_TERMINATED"), true);
  assert.equal(orderHasPaidState("CANCELLED", "MANUAL_CLOSE"), true);
  assert.equal(orderHasPaidState("CANCELLED", "USER"), false);
  assert.equal(orderHasPaidState("CANCELLED", "TIMEOUT"), false);
});

test("0112 admits only the paid MANUAL_CLOSE transition and keeps the row immutable", () => {
  const sql = readFileSync(resolve("migrations/business/0112_manual_close.sql"), "utf8");
  assert.match(sql, /cancel_reason IN\('USER','TIMEOUT','PRESTART_TERMINATED','MANUAL_CLOSE'\)/);
  assert.match(sql, /cancel_reason IN\('PRESTART_TERMINATED','MANUAL_CLOSE'\) AND paid_confirmation_id IS NOT NULL/);
  assert.match(sql, /OLD\.status='PAID' AND NEW\.status='CANCELLED' AND NEW\.cancel_reason='MANUAL_CLOSE'/);
  assert.match(sql, /manually closed order is immutable/);
  assert.match(sql, /c\.disposition='APPLIED'/);
  assert.match(sql, /prestart_termination t WHERE t\.order_id=NEW\.id AND t\.state<>'REJECTED'/);
  assert.match(sql, /CREATE TRIGGER manual_close_order_guard BEFORE UPDATE ON zzsh_order\.rental_order/);
  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  assert.ok(journal.entries.some((entry: { idx: number; tag: string }) => entry.idx === 112 && entry.tag === "0112_manual_close"));
});
