import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";

import type { EffectiveAdminAccess } from "../src/auth/admin-authorization";
import { createUserNote, deleteUserNote, listUserNotes, parseUserNoteBody, parseUserNotePage } from "../src/auth/user-directory-notes";

const actor = { adminId: "staff-a", sessionId: "session-a", requestId: "req-notes" };
const at = "2026-10-22T01:00:00.123456Z";
const userId = "user-a";
const access = (...permissions: string[]): EffectiveAdminAccess => ({ status: "ACTIVE", isBoss: false, passwordChangeRequired: false, permissions: new Set(["user.directory.read", ...permissions]) });
const denied = (status: number) => (error: unknown) => (error as { status?: number }).status === status;

function fixture() {
  const calls: { sql: string; values: unknown[] }[] = [];
  const notes = new Map<string, { id: string; text: string; authorId: string; authorName: string; createdAt: string; deletedAt: string | null }>();
  const receipts = new Map<string, { requestFingerprint: unknown; responseStatus: unknown; responseBody: unknown; publishRequired: boolean }>();
  const state = { exists: true, failAudit: false, queryRows: null as unknown[] | null };
  const client = { async query(sql: string, values: unknown[] = []) {
    calls.push({ sql, values });
    if (sql.includes("pg_advisory_xact_lock")) return { rows: [], rowCount: 1 };
    if (sql.includes('FROM "zzsh_supply"."idempotency_record"')) return { rows: receipts.has(`${values[0]}:${values[1]}`) ? [receipts.get(`${values[0]}:${values[1]}`)] : [], rowCount: 1 };
    if (sql.includes('INSERT INTO "zzsh_supply"."idempotency_record"')) {
      receipts.set(`${values[0]}:${values[1]}`, { requestFingerprint: values[2], responseStatus: values[3], responseBody: JSON.parse(values[4] as string), publishRequired: false });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SELECT 1 FROM zzsh_auth_user."user"')) return { rows: state.exists ? [{ ok: 1 }] : [], rowCount: state.exists ? 1 : 0 };
    if (sql.includes("INSERT INTO zzsh_iam.user_note")) {
      notes.set(values[0] as string, { id: values[0] as string, text: values[2] as string, authorId: values[3] as string, authorName: "客服甲", createdAt: at, deletedAt: null });
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO "zzsh_iam"."audit_event"')) {
      if (state.failAudit) throw new Error("audit unavailable");
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SELECT author_admin_id AS "authorId"')) {
      const note = notes.get(values[0] as string);
      return { rows: note ? [note] : [], rowCount: note ? 1 : 0 };
    }
    if (sql.includes("UPDATE zzsh_iam.user_note")) { notes.get(values[0] as string)!.deletedAt = at; return { rows: [], rowCount: 1 }; }
    if (sql.includes("FROM zzsh_iam.user_note n")) return { rows: state.queryRows ?? [...notes.values()].filter(note => !note.deletedAt), rowCount: notes.size };
    throw new Error(`Unexpected query: ${sql}`);
  } } as unknown as PoolClient;
  return { client, calls, notes, receipts, state };
}

test("note text is trimmed, bounded by Unicode characters and rejects extra author fields", () => {
  assert.deepEqual(parseUserNoteBody({ text: "  核对完成\n说明  " }), { text: "核对完成\n说明" });
  assert.equal(parseUserNoteBody({ text: "🙂".repeat(1000) }).text.length, 2000);
  for (const body of [null, [], "备注", {}, { text: " " }, { text: "单" }, { text: "🙂" }, { text: "字".repeat(1001) }, { text: "备注\u0000" }, { text: "备注", authorId: "spoof" }]) {
    assert.throws(() => parseUserNoteBody(body), denied(400));
  }
});

test("note page accepts a bounded decimal limit and rejects duplicates", () => {
  assert.deepEqual(parseUserNotePage(new URLSearchParams()), { limit: 20 });
  assert.deepEqual(parseUserNotePage(new URLSearchParams("limit=100&cursor=cursor")), { limit: 100, cursor: "cursor" });
  for (const query of ["limit=0", "limit=101", "limit=01", "limit=1.5", "limit=20&limit=20", "cursor=a&cursor=b"]) assert.throws(() => parseUserNotePage(new URLSearchParams(query)), denied(400));
});

test("create derives author from actor, locks the user and keeps note text out of audit and receipt", async () => {
  const f = fixture();
  const result = await createUserNote(f.client, actor, access("user.note.write"), { userId, text: "请核对订单明细" }, "note-create-1");
  assert.equal(result.status, 201);
  const note = [...f.notes.values()][0]!;
  assert.equal(note.authorId, actor.adminId);
  assert.equal(note.text, "请核对订单明细");
  assert.ok(f.calls.some(call => call.sql.includes('zzsh_auth_user."user"') && call.sql.includes("FOR UPDATE")));
  const audit = f.calls.find(call => call.sql.includes('INSERT INTO "zzsh_iam"."audit_event"'))!;
  assert.equal(audit.values[4], "user.note.create");
  assert.equal(audit.values[6], userId);
  assert.doesNotMatch(JSON.stringify(audit.values), /请核对订单明细/);
  assert.doesNotMatch(JSON.stringify(result.body), /请核对订单明细/);
  assert.equal(f.receipts.size, 1);
});

test("create replay rechecks current permission and deleted users, never appends a duplicate", async () => {
  const f = fixture(); const input = { userId, text: "用户已联系" };
  const first = await createUserNote(f.client, actor, access("user.note.write"), input, "note-replay-1");
  const replay = await createUserNote(f.client, actor, access("user.note.write"), input, "note-replay-1");
  assert.equal(replay.replayed, true); assert.deepEqual(replay.body, first.body); assert.equal(f.notes.size, 1);
  await assert.rejects(createUserNote(f.client, actor, access(), input, "note-replay-1"), denied(403));
  f.state.exists = false;
  await assert.rejects(createUserNote(f.client, actor, access("user.note.write"), input, "note-replay-1"), denied(404));
});

test("create rejects reused key with different text, missing key and missing subject", async () => {
  const f = fixture();
  await createUserNote(f.client, actor, access("user.note.write"), { userId, text: "第一条备注" }, "same-key");
  await assert.rejects(createUserNote(f.client, actor, access("user.note.write"), { userId, text: "第二条备注" }, "same-key"), denied(409));
  await assert.rejects(createUserNote(f.client, actor, access("user.note.write"), { userId, text: "备注" }, ""));
  await assert.rejects(createUserNote(f.client, actor, access("user.note.write"), { userId, text: "备注" }, "bad key"));
  f.state.exists = false;
  await assert.rejects(createUserNote(f.client, actor, access("user.note.write"), { userId, text: "备注" }, "missing-user"), denied(404));
  assert.equal(f.notes.size, 1);
});

test("audit failure rejects create before recording any successful idempotency receipt", async () => {
  const f = fixture(); f.state.failAudit = true;
  await assert.rejects(createUserNote(f.client, actor, access("user.note.write"), { userId, text: "备注正文" }, "audit-fail"), /audit unavailable/);
  assert.equal(f.receipts.size, 0, "caller transaction must roll back the note insert together with the failed audit");
});

test("staff can delete own notes, cannot delete another author's note or read it through the receipt", async () => {
  const f = fixture();
  const created = await createUserNote(f.client, actor, access("user.note.write"), { userId, text: "内部备注正文" }, "create-delete");
  const noteId = (created.body as { noteId: string }).noteId;
  await assert.rejects(deleteUserNote(f.client, { ...actor, adminId: "staff-b" }, access("user.note.write"), { userId, noteId }, "delete-other"), denied(403));
  assert.equal(f.notes.get(noteId)!.deletedAt, null);
  const result = await deleteUserNote(f.client, actor, access("user.note.write"), { userId, noteId }, "delete-own");
  assert.equal(result.status, 200); assert.ok(f.notes.get(noteId)!.deletedAt);
  assert.doesNotMatch(JSON.stringify(result.body), /内部备注正文/);
  const replay = await deleteUserNote(f.client, actor, access("user.note.write"), { userId, noteId }, "delete-own");
  assert.equal(replay.replayed, true);
  await assert.rejects(deleteUserNote(f.client, actor, access(), { userId, noteId }, "delete-own"), denied(403));
  await assert.rejects(deleteUserNote(f.client, actor, access("user.note.write"), { userId, noteId }, "new-delete-key"), denied(404));
});

test("note managers can delete any note; body cannot be updated by any exported operation", async () => {
  const f = fixture();
  const created = await createUserNote(f.client, actor, access("user.note.write"), { userId, text: "原始备注" }, "create-manager");
  const noteId = (created.body as { noteId: string }).noteId;
  await deleteUserNote(f.client, { ...actor, adminId: "ops" }, access("user.note.manage"), { userId, noteId }, "delete-manager");
  assert.ok(f.notes.get(noteId)!.deletedAt);
  assert.equal(f.notes.get(noteId)!.text, "原始备注");
  assert.ok(f.calls.filter(call => /^UPDATE/.test(call.sql)).every(call => !/SET\s+body/.test(call.sql)));
  await assert.rejects(deleteUserNote(f.client, actor, access("user.note.manage"), { userId, noteId: "absent-note" }, "delete-absent"), denied(404));
});

test("notes return fresh author capabilities, exclude deleted rows and bind keyset cursor to actor/user/limit", async () => {
  const f = fixture();
  f.state.queryRows = [
    { id: "note-b", text: "自己的备注", authorId: actor.adminId, authorName: "客服甲", createdAt: at },
    { id: "note-a", text: "其他备注", authorId: "staff-b", authorName: "客服乙", createdAt: at },
  ];
  const first = await listUserNotes(f.client, actor, access("user.note.write"), userId, { limit: 1 });
  assert.equal(first.items.length, 1); assert.equal(first.items[0]!.canDelete, true); assert.ok(first.nextCursor);
  assert.equal(first.capabilities.canCreate, true);
  const query = f.calls.find(call => call.sql.includes("FROM zzsh_iam.user_note n"))!;
  assert.match(query.sql, /n\.user_id=\$1 AND n\.deleted_at IS NULL/);
  assert.match(query.sql, /n\.created_at DESC, n\.id COLLATE "C" DESC/);
  assert.equal(query.values[3], 2, "limit+1, not total or a full scan");
  await listUserNotes(f.client, actor, access(), userId, { limit: 1, cursor: first.nextCursor! });
  assert.deepEqual(f.calls.at(-1)!.values.slice(1, 3), [at, "note-b"]);
  for (const [who, subject, limit] of [[{ ...actor, adminId: "other" }, userId, 1], [actor, "other-user", 1], [actor, userId, 2]] as const) {
    await assert.rejects(listUserNotes(f.client, who, access(), subject, { limit, cursor: first.nextCursor! }), denied(409));
  }
  await assert.rejects(listUserNotes(f.client, actor, access(), userId, { limit: 20, cursor: "invalid" }), denied(409));
  const all = await listUserNotes(f.client, actor, access("user.note.write"), userId, { limit: 20 });
  assert.equal(all.items[1]!.canDelete, false); assert.equal(all.nextCursor, null);
  const manager = await listUserNotes(f.client, actor, access("user.note.manage"), userId, { limit: 20 });
  assert.ok(manager.items.every(note => note.canDelete));
});

test("note reads reject inactive access, invalid ids/limits and missing users", async () => {
  const f = fixture();
  await assert.rejects(listUserNotes(f.client, actor, { ...access(), status: "FROZEN" }, userId, { limit: 20 }), denied(403));
  assert.equal(f.calls.length, 0);
  await assert.rejects(listUserNotes(f.client, actor, access(), "bad/id", { limit: 20 }), denied(400));
  await assert.rejects(listUserNotes(f.client, actor, access(), userId, { limit: 101 }), denied(400));
  f.state.exists = false;
  await assert.rejects(listUserNotes(f.client, actor, access(), userId, { limit: 20 }), denied(404));
});
