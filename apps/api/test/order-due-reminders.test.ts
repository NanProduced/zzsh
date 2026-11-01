import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { dueReminderBucket, dueReminderText, scanOrderDueReminders } from "../src/im/order-due-reminders";
import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "../src/im/identity-lifecycle";
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
  const sql = readFileSync(resolve("migrations/business/0115_im_order_due_reminder.sql"), "utf8");
  assert.match(sql, /UNIQUE \("order_id", "app_id", "bucket"\)/);
  assert.match(sql, /"bucket" IN \('BEFORE_24H', 'DUE', 'AFTER_1D', 'AFTER_2D', 'AFTER_3D'\)/);
  assert.match(sql, /"state" IN \('PENDING', 'SENDING', 'SENT', 'SKIPPED'\)/);
  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  assert.ok(journal.entries.some((entry: { idx: number; tag: string }) => entry.idx === 115 && entry.tag === "0115_im_order_due_reminder"));
  const acl = readFileSync(resolve("src/database/business-migrations.ts"), "utf8");
  assert.match(acl, /REVOKE UPDATE ON TABLE zzsh_order\.im_order_due_reminder FROM \$\{runtimeUser\}/);
  assert.match(acl, /GRANT UPDATE \(state,attempt_count,next_attempt_at,lease_until,lease_token_hash,sent_at,failure_class,updated_at\)\s+ON TABLE zzsh_order\.im_order_due_reminder/);
});

test("a pending pre-expiry reminder is skipped when retry crosses into the due bucket",async t=>{
  t.mock.method(Date,"now",()=>DUE_MS+60_000);
  const appId="due-reminder-review",key={provider:"yunxin" as const,appId,realm:"system" as const,kind:"SYSTEM" as const,platformSubjectId:"support-manager"};
  const base={order_id:"order-review",team_id:"900001",order_status:"PAID",due_at:DUE,ended_intake:false,ended_settlement:false,ended_posting:false,
    system_account:deriveYunxinAccountId(key),system_status:"READY",system_marker:buildYunxinIdentityMarker(key),system_subject:"support-manager"};
  const rows=[{...base,id:"stale-before",bucket:"BEFORE_24H"},{...base,id:"current-due",bucket:"DUE"}];
  const finished:unknown[][]=[],sent:{text:string;messageClientId?:string}[]=[];
  const query=async(sql:string,values:unknown[]=[])=>{
    if(sql.includes("SELECT r.id, r.order_id"))return {rows};
    if(sql.includes("SET state = 'SENDING'"))return {rows:[],rowCount:1};
    if(sql.includes("SET state = $3")){finished.push(values);return {rows:[],rowCount:1};}
    return {rows:[],rowCount:0};
  };
  await scanOrderDueReminders({pool:{query} as never,appId,transport:{sendText:async input=>{sent.push(input);return {} as never;}}});
  assert.equal(sent.length,1);assert.equal(sent[0]!.messageClientId,"current-due");
  assert.match(sent[0]!.text,/已到期/);assert.doesNotMatch(sent[0]!.text,/24 小时内到期/);
  assert.deepEqual(finished.map(v=>[v[0],v[2],v[3]]),[["stale-before","SKIPPED","STALE_BUCKET"],["current-due","SENT",null]]);
});
