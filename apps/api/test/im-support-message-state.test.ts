import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import {
  markUserConsultationRead,
  recordSupportThreadMessage,
  supportManagerIdentityKey,
  supportMessagePreview,
  toView,
} from "../src/im/consultation";
import { buildYunxinIdentityMarker, deriveYunxinAccountId } from "../src/im/identity-lifecycle";
import { handleYunxinRoute, type YunxinRouteOptions } from "../src/im/yunxin-routes";

const APP_ID = "provider-test";
const TRANSACTION_SQL = new Set(["BEGIN", "COMMIT", "ROLLBACK"]);

type QueryResult = { rows: unknown[]; rowCount?: number };
type Call = { sql: string; values: unknown[] };

function fakePool(handler: (sql: string, values: unknown[]) => QueryResult | null) {
  const calls: Call[] = [];
  const query = async (sql: string, values: unknown[] = []) => {
    calls.push({ sql, values });
    const result = handler(sql, values);
    if (result) return { rowCount: result.rowCount ?? result.rows.length, ...result };
    return { rows: [], rowCount: 0 };
  };
  return { calls, pool: { query, connect: async () => ({ query, release() {} }) } };
}

function userAuth() {
  return (sql: string): QueryResult | null => {
    if (TRANSACTION_SQL.has(sql)) return { rows: [] };
    if (sql.includes('FROM "zzsh_auth_user"."session"')) return { rows: [{ locked: false, suspended: false }] };
    if (sql.includes('FROM "zzsh_auth_user"."user"')) return { rows: [{ suspended: false, accountStatus: "ACTIVE" }] };
    if (sql.includes('FROM "zzsh_iam"."user_identity_state"')) return { rows: [] };
    return null;
  };
}

const userContext = { userId: "user_a", sessionId: "session_a", credentials: {}, security: { status: "ACTIVE", isBoss: false, passwordChangeRequired: false }, sessionLocked: false } as never;

function contextRow(overrides: Record<string, unknown> = {}): Parameters<typeof toView>[0] {
  return {
    id: "consult_2", userId: "user_a", kind: "SERVICE", state: "ACTIVE",
    userAccountId: "user_im_1", peerAccountId: "admin_im_1", assignedAdminId: "admin_a",
    subjectRef: null, version: 4, lastMessageAt: new Date("2026-10-30T02:00:00.000Z"),
    lastMessagePreview: "你好，在吗",
    createdAt: new Date("2026-10-30T00:00:00.000Z"), updatedAt: new Date("2026-10-30T02:00:00.000Z"),
    userName: "用户甲", userUsername: "user_a", adminName: "客服甲", appId: APP_ID,
    messageScopeType: "TEAM", messageScopeId: "900001", messageScopeState: "READY", messageScopeVersion: 2,
    threadId: "thread_1", roundSeq: 1, threadState: "ACTIVE", threadScopeId: "900001",
    threadScopeState: "READY", threadPeerAccountId: "admin_im_1",
    userReadAt: new Date("2026-10-30T01:00:00.000Z"), adminReadAt: null,
    ...overrides,
  } as Parameters<typeof toView>[0];
}

test("0132 adds the preview and user read columns and the ACL narrows round updates", () => {  const sql = readFileSync(resolve("migrations/business/0132_im_message_state.sql"), "utf8");
  assert.match(sql, /ALTER TABLE "zzsh_iam"\."im_consultation" ADD COLUMN IF NOT EXISTS "last_message_preview" text/);
  assert.match(sql, /CONSTRAINT "im_consultation_last_message_preview_length" CHECK \(char_length\("last_message_preview"\) <= 160\)/);
  assert.match(sql, /ALTER TABLE "zzsh_iam"\."im_support_thread" ADD COLUMN IF NOT EXISTS "user_read_at" timestamptz/);
  assert.match(sql, /--> statement-breakpoint/);
  assert.doesNotMatch(sql, /CREATE TABLE/);

  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  const entry = journal.entries.find((item: { idx: number }) => item.idx === 132);
  assert.deepEqual(entry && { tag: entry.tag, when: entry.when }, { tag: "0132_im_message_state", when: 1793184013008 });

  const acl = readFileSync(resolve("src/database/business-migrations.ts"), "utf8");
  assert.match(acl, /GRANT UPDATE \("state", "peer_account_id", "assigned_admin_id", "version", "last_message_at", "last_message_preview", "updated_at", "message_scope_id", "message_scope_state", "message_scope_version", "admin_read_at", "first_user_message_at", "no_support_notice_at", "user_unread_count", "admin_unread_count"\) ON TABLE "zzsh_iam"\."im_consultation"/);
});

test("0133 adds the waiting-assignment facts without backfilling old rounds", () => {
  const sql = readFileSync(resolve("migrations/business/0133_im_waiting_assignment.sql"), "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "first_user_message_at" timestamptz/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "entry_intent" text NOT NULL DEFAULT 'SERVICE'/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "no_support_notice_at" timestamptz/);
  assert.match(sql, /CONSTRAINT "im_consultation_entry_intent_check"\s*CHECK \("entry_intent" IN \('SERVICE', 'COMPLAINT'\)\)/);
  assert.match(sql, /FROM pg_constraint/);
  assert.doesNotMatch(sql, /UPDATE "zzsh_iam"\."im_consultation"/, "old rounds are never backfilled heuristically");
  assert.match(sql, /--> statement-breakpoint/);

  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  const entry = journal.entries.find((item: { idx: number }) => item.idx === 133);
  assert.deepEqual(entry && { tag: entry.tag, when: entry.when }, { tag: "0133_im_waiting_assignment", when: 1793184013009 });
  assert.ok(journal.entries.length >= 142, "the accepted IM migration prefix is retained");
  assert.equal(new Set(journal.entries.map((item: { tag: string }) => item.tag)).size, journal.entries.length, "each formal migration is registered once");
  const supportCancel = journal.entries.find((item: { idx: number }) => item.idx === 134);
  assert.deepEqual(supportCancel && { tag: supportCancel.tag, when: supportCancel.when }, { tag: "0134_support_cancel", when: 1793184013010 });
  const activity = journal.entries.find((item: { idx: number }) => item.idx === 135);
  assert.deepEqual(activity && { tag: activity.tag, when: activity.when }, { tag: "0135_im_conversation_activity", when: 1793184013011 });
  const orderUnread = journal.entries.find((item: { idx: number }) => item.idx === 136);
  assert.deepEqual(orderUnread && { tag: orderUnread.tag, when: orderUnread.when }, { tag: "0136_im_order_unread", when: 1793184013012 });
});

test("0135 counts support unread per side and records order-group last activity", () => {
  const sql = readFileSync(resolve("migrations/business/0135_im_conversation_activity.sql"), "utf8");
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "user_unread_count" integer NOT NULL DEFAULT 0/);
  assert.match(sql, /ADD COLUMN IF NOT EXISTS "admin_unread_count" integer NOT NULL DEFAULT 0/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "zzsh_order"\."im_order_activity"/);
  assert.match(sql, /"last_message_at" timestamptz NOT NULL DEFAULT clock_timestamp\(\)/);
  assert.match(sql, /--> statement-breakpoint/);

  const source = readFileSync(resolve("src/im/consultation.ts"), "utf8");
  assert.match(source, /"user_unread_count" = CASE WHEN \$4::boolean THEN c\."user_unread_count" ELSE LEAST\(c\."user_unread_count" \+ 1, 999\) END/);
  assert.match(source, /"admin_unread_count" = CASE WHEN \$4::boolean THEN LEAST\(c\."admin_unread_count" \+ 1, 999\) ELSE c\."admin_unread_count" END/);
  assert.match(source, /SET "admin_read_at" = clock_timestamp\(\), "admin_unread_count" = 0/);
  assert.match(source, /SET "user_unread_count" = 0/);

  const order = readFileSync(resolve("src/im/order-team-access.ts"), "utf8");
  assert.match(order, /INSERT INTO zzsh_order\.im_order_activity/);
  assert.match(order, /ON CONFLICT\(order_id\) DO UPDATE/);
});

test("0136 keeps order-group unread per member identity and clears only the reader", () => {
  const sql = readFileSync(resolve("migrations/business/0136_im_order_unread.sql"), "utf8");
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "zzsh_order"\."im_order_unread"/);
  assert.match(sql, /PRIMARY KEY \("order_id", "identity_id"\)/);
  assert.match(sql, /CHECK \("unread_count" >= 0\)/);
  assert.match(sql, /--> statement-breakpoint/);

  const access = readFileSync(resolve("src/im/order-team-access.ts"), "utf8");
  assert.match(access, /INSERT INTO zzsh_order\.im_order_unread\(order_id,identity_id,unread_count\)/);
  assert.match(access, /WHERE g\.app_id=\$1 AND g\.team_id=\$2 AND m\.account_id<>\$3/);
  assert.match(access, /export async function markOrderGroupRead/);
  assert.match(access, /mm\.order_id=\$5 AND mm\.state='JOINED' AND m\.status='READY'/);
  assert.match(access, /SET unread_count=0,last_read_at=clock_timestamp\(\)/);

  const acl = readFileSync(resolve("src/database/business-migrations.ts"), "utf8");
  assert.match(acl, /GRANT SELECT, INSERT, UPDATE ON TABLE zzsh_order\.im_order_unread TO \$\{runtimeUser\}/);
  const bff = readFileSync(resolve("src/bff/admin-bff.ts"), "utf8");
  assert.match(bff, /im\\\/order-teams\\\/\[A-Za-z0-9\]\[A-Za-z0-9\._:\-\]\{0,127\}\\\/read/);
});

test("preview sanitizer collapses whitespace, drops emptiness and truncates by codepoint", () => {
  assert.equal(supportMessagePreview(null), null);
  assert.equal(supportMessagePreview(" \n\t "), null);
  assert.equal(supportMessagePreview("  你好\n\n  world  "), "你好 world");
  assert.equal(supportMessagePreview("😀".repeat(100)), "😀".repeat(80));
  assert.equal([...supportMessagePreview("😀".repeat(100))!].length, 80);
});

test("recordSupportThreadMessage updates only the open round of the matching thread Team", async () => {
  const calls: Call[] = [];
  let rowCount = 0;
  const pool = { query: async (sql: string, values: unknown[] = []) => { calls.push({ sql, values }); return { rows: [], rowCount }; } };
  assert.equal(await recordSupportThreadMessage({ pool: pool as never, appId: APP_ID }, "single_user_im", "你好"), false);
  assert.equal(calls.length, 0, "non-Team conversations must not touch the support queue");

  rowCount = 1;
  assert.equal(await recordSupportThreadMessage({ pool: pool as never, appId: APP_ID }, "user_im_1|2|900001", "  你好\n world  "), true);
  assert.equal(calls.length, 1);
  assert.match(calls[0]!.sql, /SET "last_message_at" = clock_timestamp\(\), "last_message_preview" = \$3/);
  assert.match(calls[0]!.sql, /"first_user_message_at" = CASE WHEN \$4::boolean\s*THEN COALESCE\(c\."first_user_message_at", clock_timestamp\(\)\)/);
  assert.match(calls[0]!.sql, /t\."message_scope_id" = \$2 AND c\."state" <> 'CLOSED'/);
  assert.match(calls[0]!.sql, /RETURNING c\."id"/);
  assert.deepEqual(calls[0]!.values, [APP_ID, "900001", "你好 world", false], "platform/agent messages never mark the first user message");

  calls.length = 0;
  rowCount = 1;
  await recordSupportThreadMessage({ pool: pool as never, appId: APP_ID }, "user_im_1|2|900001", "你好", true);
  assert.equal(calls[0]!.values[3], true, "a user message advances first_user_message_at exactly once via COALESCE");

  const source = readFileSync(resolve("src/im/consultation.ts"), "utf8");
  assert.match(source, /export async function recordSupportThreadMessage/);
  assert.ok(source.includes("const TEAM_CONVERSATION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}\\|2\\|([0-9]{1,19})$/"), "preview must reuse the strict Team conversation shape");
});

test("user views expose preview and unread while admin views never claim unread", () => {
  const unread = toView(contextRow(), "user_im_1");
  assert.equal(unread.lastMessagePreview, "你好，在吗");
  assert.equal(unread.hasUnread, true);

  assert.equal(toView(contextRow({ userReadAt: null }), "user_im_1").hasUnread, true);
  assert.equal(toView(contextRow({ userReadAt: new Date("2026-10-30T02:00:00.000Z") }), "user_im_1").hasUnread, false);
  assert.equal(toView(contextRow({ userReadAt: new Date("2026-10-30T03:00:00.000Z") }), "user_im_1").hasUnread, false);
  assert.equal(toView(contextRow({ lastMessageAt: null, lastMessagePreview: null }), "user_im_1").hasUnread, false);
  assert.equal(toView(contextRow(), "user_im_1").lastMessagePreview, "你好，在吗");

  const admin = toView(contextRow(), "admin_im_1", true, "admin_a");
  assert.equal(admin.hasUnread, false);
  assert.equal(admin.lastMessagePreview, "你好，在吗");

  const source = readFileSync(resolve("src/im/consultation.ts"), "utf8");
  assert.equal((source.match(/c\."last_message_preview" AS "lastMessagePreview"/g) ?? []).length, 2);
  assert.equal((source.match(/t\."user_read_at" AS "userReadAt"/g) ?? []).length, 2);
  assert.match(source, /lastMessagePreview: string \| null;/);
  assert.match(source, /hasUnread: boolean;/);
});

test("the admin queue hides only empty unassigned WAITING rounds", () => {
  const source = readFileSync(resolve("src/im/consultation.ts"), "utf8");
  assert.match(source, /AND NOT \(c\."state" = 'WAITING' AND c\."assigned_admin_id" IS NULL AND c\."first_user_message_at" IS NULL\)/);
  assert.match(source, /c\."id" = \(\s*SELECT c2\."id"/, "the queue keeps one row per persistent thread");
  assert.match(source, /c2\."state" <> 'CLOSED' OR NOT EXISTS/, "a closed round is returned only when the thread has no open round");
  // 自动分配同样只命中已经有过用户消息的轮次。
  assert.match(source, /AND c\."first_user_message_at" IS NOT NULL/);
});

test("a user read marks only their own thread and stays idempotent", async () => {
  const f = fakePool((sql) => {
    const auth = userAuth()(sql);
    if (auth) return auth;
    if (sql.includes('SELECT "user_id" AS "userId", "thread_id" AS "threadId"')) {
      return { rows: [{ userId: "user_a", threadId: "thread_1" }] };
    }
    if (sql.includes('UPDATE "zzsh_iam"."im_support_thread"')) {
      return { rows: [{ userReadAt: new Date("2026-10-30T04:00:00.000Z") }], rowCount: 1 };
    }
    return null;
  });
  const options = { pool: f.pool, appId: APP_ID } as never;
  const first = await markUserConsultationRead(options, userContext, "consult_2");
  const second = await markUserConsultationRead(options, userContext, "consult_2");
  assert.equal(first.userReadAt, "2026-10-30T04:00:00.000Z");
  assert.deepEqual(second, first);
  const updates = f.calls.filter(({ sql }) => sql.includes('UPDATE "zzsh_iam"."im_support_thread"'));
  assert.equal(updates.length, 2, "repeated reads refresh the same thread marker instead of failing");
  assert.deepEqual(updates[0]!.values, [APP_ID, "thread_1"]);

  const other = fakePool((sql) => userAuth()(sql) ?? (sql.includes('SELECT "user_id" AS "userId"') ? { rows: [{ userId: "user_b", threadId: "thread_1" }] } : null));
  await assert.rejects(markUserConsultationRead({ pool: other.pool, appId: APP_ID } as never, userContext, "consult_2"), (error: { status?: number }) => error.status === 403);
  assert.ok(!other.calls.some(({ sql }) => sql.includes('UPDATE "zzsh_iam"."im_support_thread"')));

  const missing = fakePool((sql) => userAuth()(sql));
  await assert.rejects(markUserConsultationRead({ pool: missing.pool, appId: APP_ID } as never, userContext, "consult_2"), (error: { status?: number }) => error.status === 404);

  const source = readFileSync(resolve("src/im/consultation.ts"), "utf8");
  assert.match(source, /export async function markUserConsultationRead/);
  assert.match(source, /"user_read_at" = clock_timestamp\(\)/);
  assert.match(source, /Consultation is not owned by the current user/);
  assert.match(source, /RETURNING "user_read_at" AS "userReadAt"/);
});

test("read routes are POST-only and forwarded by the web proxy", () => {
  const routes = readFileSync(resolve("src/im/yunxin-routes.ts"), "utf8");
  assert.ok(routes.includes("\\/user\\/consultations\\/([A-Za-z0-9][A-Za-z0-9._:-]{0,127})\\/read$"));
  assert.ok(routes.includes("handleUserConsultationRead("));
  assert.ok(routes.includes("markUserConsultationRead(options.consultation, context, consultationId)"));
  assert.ok(routes.includes('"Read body must be empty"'));
  assert.ok(routes.indexOf("if (userRead)") < routes.indexOf('if (path === "/user/consultations")'), "read must dispatch before the generic consultations matcher");
  assert.match(routes, /if \(userRead\) \{\s*if \(!originAllowed[\s\S]*?method !== "POST"/);

  const proxy = readFileSync(resolve("../web/src/app/api/im/[...path]/route.ts"), "utf8");
  assert.ok(proxy.includes("\\/consultations\\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\\/read"));
  assert.ok(proxy.includes("(?:rating(?:\\/dismiss)?|read|close)"));
  assert.ok(proxy.includes('path.endsWith("/read")'));
  assert.ok(proxy.includes('path === "/messages" ? 14_100_000 : 16_384'));
  assert.ok(proxy.includes("userActionPath || orderReadPath ? `/api/v1/im/user${path}`"));
  assert.ok(proxy.includes("order-teams\\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\\/read"));
});

test("user and admin sends record best-effort previews only after transport success", () => {
  const routes = readFileSync(resolve("src/im/yunxin-routes.ts"), "utf8");
  assert.equal((routes.match(/recordSupportPreview\(options, input\.conversationId, input\.text/g) ?? []).length, 3, "text and reply on both ends");
  assert.equal((routes.match(/MEDIA_MESSAGE_PREVIEW\[media\.kind\]/g) ?? []).length, 2);
  assert.equal((routes.match(/recordSupportPreview\(options, input\.conversationId, "\[图片\]"/g) ?? []).length, 2);
  assert.match(routes, /video: "\[视频\]",\s*\n\s*file: "\[文件\]",\s*\n\s*audio: "\[语音\]"/);
  assert.match(routes, /const message = await transport\.sendText[\s\S]*?await recordSupportPreview[\s\S]*?sendJson/);
  assert.match(routes, /catch \{\s*\n\s*\/\/ Message already sent; a failed preview is overwritten by the next message\./);
});

test("a user message marks the first user message and wakes auto-assign exactly once", async () => {
  const routes = readFileSync(resolve("src/im/yunxin-routes.ts"), "utf8");
  const userSection = routes.slice(routes.indexOf("async function handleUserMessages"), routes.indexOf("async function handleAdminMessages"));
  const adminSection = routes.slice(routes.indexOf("async function handleAdminMessages"), routes.indexOf("async function handleImage"));
  assert.equal((userSection.match(/wakeConsultationAutoAssign\(options\)/g) ?? []).length, 4, "text, media, image and verified real receipt each trigger one wake");
  assert.doesNotMatch(adminSection, /wakeConsultationAutoAssign|autoAssignWaitingConsultations/, "agent messages never start assignment");
  assert.match(userSection, /recordSupportPreview\(options, input\.conversationId, input\.text, true\)/);
  assert.match(userSection, /MEDIA_MESSAGE_PREVIEW\[media\.kind\], true\)/);
  assert.match(userSection, /"\[图片\]", true\)/);
  assert.match(routes, /if \(!consultation\?\.autoAssignConsultations\) return;\s*\n\s*void autoAssignWaitingConsultations\(consultation, 5\)\.catch\(\(\) => undefined\);/);
  // 只有真实咨询线程命中摘要才唤醒分配；订单群消息改记最后活动时间，不触发分配。
  assert.match(routes, /if \(await recordSupportThreadMessage\(options\.consultation, conversationId, preview, fromUser\)\) \{ if\(actor\)await recordLocalAdminMessageSuccess/);
  assert.match(routes, /recordOrderGroupMessage\(options\.consultation\.pool, options\.consultation\.appId, conversationId, preview\)/);

  // 行为断言：真实的用户发送路由把 fromUser=true 写入摘要，并唤醒一次自动分配。
  const userKey = { provider: "yunxin" as const, appId: APP_ID, realm: "user" as const, kind: "USER" as const, platformSubjectId: "user_a" };
  const userAccountId = deriveYunxinAccountId(userKey);
  const conversationId = `${userAccountId}|2|900001`;
  const updates: Call[] = [];
  const scans: string[] = [];
  const message = {
    messageClientId: "m1", messageServerId: "s1", conversationId,
    senderId: userAccountId, receiverId: "support-1", createTime: 1, text: "你好", messageType: 0 as const,
  };
  const query = async (sql: string, values: unknown[] = []): Promise<QueryResult> => {
    if (TRANSACTION_SQL.has(sql.trim())) return { rows: [] };
    if (sql.includes('"zzsh_auth_user"."session"')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('"zzsh_auth_user"."user"')) return { rows: [{ suspended: false, accountStatus: "ACTIVE" }], rowCount: 1 };
    if (sql.includes('"zzsh_iam"."user_identity_state"')) return { rows: [], rowCount: 0 };
    if (sql.includes("zzsh_order.im_order_group")) return { rows: [], rowCount: 0 };
    if (sql.includes('FROM "zzsh_iam"."im_identity_mapping"')) {
      return { rows: [{ accountId: userAccountId, identityMarker: buildYunxinIdentityMarker(userKey), status: "READY" }], rowCount: 1 };
    }
    if (sql.includes('UPDATE "zzsh_iam"."im_consultation" c') && sql.includes("last_message_preview")) {
      updates.push({ sql, values });
      return { rows: [{ id: "consult_2" }], rowCount: 1 };
    }
    if (sql.includes('FROM "zzsh_iam"."im_support_thread"')) {
      return { rows: [{
        id: "thread_1", appId: APP_ID, userId: "user_a", kind: "SERVICE", state: "ACTIVE",
        userAccountId, peerAccountId: null, messageScopeId: "900001", messageScopeState: "READY",
        lastRoundSeq: "1", version: "1",
      }], rowCount: 1 };
    }
    if (sql.includes("NOT EXISTS") && sql.includes("im_consultation_scope_operation")) {
      scans.push(sql);
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('FROM "zzsh_iam"."im_consultation"') && sql.includes('"state" <> \'CLOSED\'')) {
      return { rows: [{ id: "consult_2", state: "ACTIVE" }], rowCount: 1 };
    }
    throw new Error("Unexpected SQL in user message route test: " + sql);
  };
  const pool = { query, connect: async () => ({ query, release() {} }) };
  const options = {
    security: {
      pool,
      apiOrigin: "http://127.0.0.1:3102",
      userOrigin: "http://127.0.0.1:3100",
      adminOrigin: "http://127.0.0.1:3101",
      userAuth: { api: { getSession: async () => ({ user: { id: "user_a" }, session: { id: "session_a" } }) } },
      adminAuth: { api: { getSession: async () => null } },
    },
    appId: APP_ID,
    repository: {},
    provisioner: {},
    tokenService: {},
    consultation: {
      pool,
      appId: APP_ID,
      messageTransport: { sendText: async () => message },
      autoAssignConsultations: true,
      provider: {},
      supportManager: { key: supportManagerIdentityKey(APP_ID), provisioner: { ensure: async () => { throw new Error("unused"); } } },
    },
  } as unknown as YunxinRouteOptions;
  let status = 0;
  const response = {
    setHeader() { return response; },
    status(code: number) { status = code; return response; },
    json() { return response; },
  };
  await handleYunxinRoute({
    method: "POST",
    url: "/api/v1/im/user/messages",
    originalUrl: "/api/v1/im/user/messages",
    headers: { origin: "http://127.0.0.1:3100", cookie: "zzsh_user.session_token=opaque" },
    body: { conversationId, text: "你好" },
  } as never, response as never, options);
  assert.equal(status, 200);
  assert.equal(updates.length, 1, "the user message writes the thread summary exactly once");
  assert.equal(updates[0]!.values[3], true, "the route tells the record that this message came from the user");
  assert.equal(scans.length, 1, "the user message wakes auto-assignment once");
  assert.match(scans[0]!, /c\."first_user_message_at" IS NOT NULL/);
});
