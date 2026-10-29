import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { dueReminderBucket, dueReminderText } from "../src/im/order-due-reminders";
import { InMemoryMessageTransport } from "./im-local-fixtures";

const HOUR = 60 * 60 * 1_000;
const DUE = "2026-10-30T03:30:00.000Z";
const DUE_MS = Date.parse(DUE);

test("due reminder buckets cover pre-24h, due, three daily follows and stop", () => {
  assert.equal(dueReminderBucket(DUE, DUE_MS - 25 * HOUR), null);
  assert.equal(dueReminderBucket(DUE, DUE_MS - 24 * HOUR), "BEFORE_24H");
  assert.equal(dueReminderBucket(DUE, DUE_MS - 1), "BEFORE_24H");
  assert.equal(dueReminderBucket(DUE, DUE_MS), "DUE");
  assert.equal(dueReminderBucket(DUE, DUE_MS + 24 * HOUR), "AFTER_1D");
  assert.equal(dueReminderBucket(DUE, DUE_MS + 48 * HOUR), "AFTER_2D");
  assert.equal(dueReminderBucket(DUE, DUE_MS + 72 * HOUR), "AFTER_3D");
  assert.equal(dueReminderBucket(DUE, DUE_MS + 96 * HOUR), null);
  assert.equal(dueReminderBucket(null, DUE_MS), null);
  assert.equal(dueReminderBucket("not-a-time", DUE_MS), null);
});

test("due reminder text names the Beijing due time and the bucket, without amounts", () => {
  assert.match(dueReminderText("BEFORE_24H", DUE), /24 小时内到期/);
  assert.match(dueReminderText("BEFORE_24H", DUE), /2026-10-30 11:30/);
  assert.match(dueReminderText("DUE", DUE), /已到期（/);
  assert.match(dueReminderText("AFTER_1D", DUE), /已到期 1 天/);
  assert.match(dueReminderText("AFTER_3D", DUE), /已到期 3 天/);
  for (const bucket of ["BEFORE_24H", "DUE", "AFTER_1D", "AFTER_2D", "AFTER_3D"] as const) {
    assert.doesNotMatch(dueReminderText(bucket, DUE), /¥\d/);
  }
});

test("fixture transport keys a system text retry by messageClientId", async () => {
  const transport = new InMemoryMessageTransport(() => DUE_MS);
  const conversationId = "zzSYSTEM123|2|900001";
  const input = { conversationId, senderAccountId: "zzSYSTEM123", receiverAccountId: "900001", text: "本单已到期", messageClientId: "im_due_event_1" };
  const first = await transport.sendText(input);
  const replay = await transport.sendText(input);
  assert.equal(replay.messageServerId, first.messageServerId);
  assert.equal((await transport.history({ conversationId, viewerAccountId: "zzUSER1", limit: 10 })).length, 1);
  const next = await transport.sendText({ ...input, messageClientId: "im_due_event_2" });
  assert.notEqual(next.messageServerId, first.messageServerId);
  assert.equal((await transport.history({ conversationId, viewerAccountId: "zzUSER1", limit: 10 })).length, 2);
});

test("0111 records one reminder per bucket with a narrow runtime update grant", () => {
  const sql = readFileSync(resolve("migrations/business/0111_im_order_due_reminder.sql"), "utf8");
  assert.match(sql, /UNIQUE \("order_id", "app_id", "bucket"\)/);
  assert.match(sql, /"bucket" IN \('BEFORE_24H', 'DUE', 'AFTER_1D', 'AFTER_2D', 'AFTER_3D'\)/);
  assert.match(sql, /"state" IN \('PENDING', 'SENDING', 'SENT', 'SKIPPED'\)/);
  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  assert.ok(journal.entries.some((entry: { idx: number; tag: string }) => entry.idx === 111 && entry.tag === "0111_im_order_due_reminder"));
  const acl = readFileSync(resolve("src/database/business-migrations.ts"), "utf8");
  assert.match(acl, /REVOKE UPDATE ON TABLE zzsh_order\.im_order_due_reminder FROM \$\{runtimeUser\}/);
  assert.match(acl, /GRANT UPDATE \(state,attempt_count,next_attempt_at,lease_until,lease_token_hash,sent_at,failure_class,updated_at\)\s+ON TABLE zzsh_order\.im_order_due_reminder/);
});
