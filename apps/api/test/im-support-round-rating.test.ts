import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

import { parseSupportRatingBody, toView } from "../src/im/consultation";

const APP_ID = "provider-test";

function contextRow(overrides: Record<string, unknown> = {}): Parameters<typeof toView>[0] {
  return {
    id: "consult_2", userId: "user_a", kind: "SERVICE", state: "CLOSED",
    userAccountId: "user_im_1", peerAccountId: "staff_im_1", assignedAdminId: "admin_a",
    subjectRef: null, version: 4, lastMessageAt: null,
    createdAt: new Date("2026-10-20T00:00:00.000Z"), updatedAt: new Date("2026-10-21T00:00:00.000Z"),
    userName: "用户甲", userUsername: "user_a", adminName: "客服甲", appId: APP_ID,
    messageScopeType: "TEAM", messageScopeId: "900001", messageScopeState: "READY", messageScopeVersion: 2,
    threadId: "thread_1", roundSeq: 2, threadState: "IDLE", threadScopeId: "900001",
    threadScopeState: "READY", threadPeerAccountId: null,
    adminReadAt: new Date("2026-10-29T08:00:00.000Z"),
    ...overrides,
  } as Parameters<typeof toView>[0];
}

test("0118 adds the round read marker and an immutable one-per-round rating row", () => {
  const sql = readFileSync(resolve("migrations/business/0118_im_round_rating.sql"), "utf8");
  assert.match(sql, /ALTER TABLE "zzsh_iam"\."im_consultation" ADD COLUMN IF NOT EXISTS "admin_read_at" timestamptz/);
  assert.match(sql, /CREATE TABLE IF NOT EXISTS "zzsh_iam"\."im_support_round_rating"/);
  assert.match(sql, /"round_id" text NOT NULL UNIQUE REFERENCES "zzsh_iam"\."im_consultation"\("id"\) ON DELETE RESTRICT/);
  assert.match(sql, /"thread_id" text NOT NULL REFERENCES "zzsh_iam"\."im_support_thread"\("id"\)/);
  assert.match(sql, /"user_id" text NOT NULL REFERENCES "zzsh_auth_user"\."user"\("id"\)/);
  assert.match(sql, /"assigned_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"\."user"\("id"\)/);
  assert.match(sql, /"score" smallint CONSTRAINT "im_support_round_rating_score" CHECK \("score" BETWEEN 1 AND 5\)/);
  assert.match(sql, /CONSTRAINT "im_support_round_rating_comment" CHECK \(char_length\("comment"\) <= 200\)/);
  assert.match(sql, /"score" IS NOT NULL AND "submitted_at" IS NOT NULL AND "dismissed_at" IS NULL/);
  assert.match(sql, /"score" IS NULL AND "submitted_at" IS NULL AND "dismissed_at" IS NOT NULL/);
  assert.match(sql, /CHECK \(char_length\(btrim\("comment"\)\) > 0 OR "comment" IS NULL\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "im_support_round_rating_agent_idx"[\s\S]*?\("app_id", "assigned_admin_id", "submitted_at"\)/);
  assert.match(sql, /CREATE INDEX IF NOT EXISTS "im_support_round_rating_day_idx"[\s\S]*?\("app_id", "submitted_at"\)/);
  assert.match(sql, /RAISE EXCEPTION 'IM support round rating is append-only'/);
  assert.match(sql, /NEW\."score" IS DISTINCT FROM OLD\."score"/);
  assert.match(sql, /NEW\."dismissed_at" IS NOT NULL AND OLD\."score" IS NOT NULL/);
  assert.match(sql, /BEFORE UPDATE OR DELETE ON "zzsh_iam"\."im_support_round_rating"/);
  assert.match(sql, /--> statement-breakpoint/);

  const journal = JSON.parse(readFileSync(resolve("migrations/business/meta/_journal.json"), "utf8"));
  const entry = journal.entries.find((item: { idx: number }) => item.idx === 118);
  assert.deepEqual(entry && { tag: entry.tag, when: entry.when }, { tag: "0118_im_round_rating", when: 1793184007000 });

  const acl = readFileSync(resolve("src/database/business-migrations.ts"), "utf8");
  assert.match(acl, /GRANT UPDATE \("state", "peer_account_id", "assigned_admin_id", "version", "last_message_at", "last_message_preview", "updated_at", "message_scope_id", "message_scope_state", "message_scope_version", "admin_read_at", "first_user_message_at", "no_support_notice_at", "user_unread_count", "admin_unread_count"\) ON TABLE "zzsh_iam"\."im_consultation"/);
  assert.match(acl, /GRANT SELECT, INSERT ON TABLE "zzsh_iam"\."im_support_round_rating"/);
  assert.match(acl, /REVOKE UPDATE, DELETE, TRUNCATE ON TABLE "zzsh_iam"\."im_support_round_rating"/);
  assert.match(acl, /GRANT UPDATE \("dismissed_at", "updated_at"\) ON TABLE "zzsh_iam"\."im_support_round_rating"/);
});

test("views expose the platform read marker and default to an unavailable rating", () => {
  const view = toView(contextRow(), "user_im_1");
  assert.equal(view.adminReadAt, "2026-10-29T08:00:00.000Z");
  assert.deepEqual(view.rating, { available: false, submitted: false, dismissed: false, score: null });
  assert.equal(toView(contextRow({ adminReadAt: null }), "user_im_1").adminReadAt, null);

  const source = readFileSync(resolve("src/im/consultation.ts"), "utf8");
  assert.match(source, /adminReadAt: iso\(row\.adminReadAt\)/);
  assert.match(source, /rating: \{ available: false, submitted: false, dismissed: false, score: null \}/);
  // 只有用户列表按 CLOSED 轮次计算可用性；已有评价行（提交或暂不评价）一律不可再评。
  assert.match(source, /ratingView\(ratings\.get\(row\.id\), row\.state === "CLOSED" && Boolean\(row\.assignedAdminId\)\)/);
  assert.match(source, /return \{ available: false, submitted: false, dismissed: true, score: null \}/);
});

test("read marking and rating writes stay server-authorized and transactional", () => {
  const source = readFileSync(resolve("src/im/consultation.ts"), "utf8");
  assert.match(source, /export async function markConsultationRead/);
  assert.match(source, /SET "admin_read_at" = clock_timestamp\(\)/);
  assert.match(source, /"state" = 'ACTIVE' AND "assigned_admin_id" = \$3/);
  assert.match(source, /export async function submitSupportRating/);
  assert.match(source, /export async function dismissSupportRating/);
  assert.match(source, /ON CONFLICT \("round_id"\) DO NOTHING/);
  assert.match(source, /"app_id" = \$1 AND "thread_id" = \$2 AND "state" <> 'CLOSED' LIMIT 1/);
  assert.match(source, /assertUserContextInTransaction\(client, context\)/);
  // 评级与开轮共用 thread -> round 的加锁顺序，破坏顺序会引入并发死锁。
  assert.match(source, /async function lockRatableRound\(client: PoolClient, appId: string, id: string, userId: string\)/);
  assert.match(source, /await readThreadById\(client, appId, initial\.threadId, true\);\s*\n\s*const row = await readConsultation\(client, appId, id, true\);/);
});

test("rating and admin-read routes stay POST-only and the BFF/proxy forward them", () => {
  const routes = readFileSync(resolve("src/im/yunxin-routes.ts"), "utf8");
  assert.ok(routes.includes("(claim|transfer|close|reconcile|read)"));
  assert.ok(routes.includes("\\/user\\/consultations\\/"));
  assert.ok(routes.includes("\\/rating$"));
  assert.ok(routes.includes("\\/rating\\/dismiss$"));
  assert.ok(routes.includes("markConsultationRead(options.consultation, context, action.id)"));
  assert.ok(routes.includes("handleUserConsultationRating("));
  assert.ok(routes.includes("handleUserConsultationRatingDismiss("));

  const bff = readFileSync(resolve("src/bff/admin-bff.ts"), "utf8");
  assert.ok(bff.includes("(claim|transfer|close|reconcile|read)"));

  const proxy = readFileSync(resolve("../web/src/app/api/im/[...path]/route.ts"), "utf8");
  assert.ok(proxy.includes("\\/consultations\\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\\/rating(?:\\/dismiss)?"));
  assert.ok(proxy.includes("const ratingPath = /^\\/consultations\\/"));
  assert.ok(proxy.includes("ratingPath || orderReadPath ? `/api/v1/im/user${path}`"));
});

test("support overview adds submitted ratings on the Beijing day without fake zeros", () => {
  const source = readFileSync(resolve("src/im/support-management.ts"), "utf8");
  assert.match(source, /ratings: SupportRatingOverview;/);
  assert.match(source, /"submitted_at" IS NOT NULL/);
  assert.match(source, /\("submitted_at" AT TIME ZONE 'Asia\/Shanghai'\)::date = COALESCE\(\$2::date, \(now\(\) AT TIME ZONE 'Asia\/Shanghai'\)::date\)/);
  assert.match(source, /COUNT\(\*\) FILTER \(WHERE "score" = 1\)/);
  assert.match(source, /ORDER BY "average" DESC, "count" DESC/);
  assert.match(source, /average: nullableAverage\(ratingRow\?\.average\)/);
});

test("rating input accepts only an integer 1..5 with a bounded optional comment", () => {
  assert.deepEqual(parseSupportRatingBody({ score: 5 }), { score: 5, comment: null });
  assert.deepEqual(parseSupportRatingBody({ score: 2, comment: "  还行  " }), { score: 2, comment: "还行" });
  assert.deepEqual(parseSupportRatingBody({ score: 4, comment: "   " }), { score: 4, comment: null });
  assert.doesNotThrow(() => parseSupportRatingBody({ score: 5, comment: "😀".repeat(200) }));
  for (const bad of [
    {}, { score: 0 }, { score: 6 }, { score: 3.5 }, { score: "5" }, { score: 5, extra: true },
    { score: 5, comment: "a".repeat(201) }, { score: 5, comment: 7 },
  ]) {
    assert.throws(() => parseSupportRatingBody(bad));
  }
});
