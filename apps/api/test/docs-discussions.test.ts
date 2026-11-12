// Offline P1b selection-comment checks: mark helpers, the three-state anchor
// reconciliation on save, ANNOTATE versions that never bump doc_node.revision,
// author-only reply edits/deletes, resolve/reopen state machine and permission
// negatives. Real schema constraints live in the docs PostgreSQL suite.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { extractPlate, type PlateDocumentEnvelope, type PlateNode } from "@zzsh/content/plate";

import { ADMIN_PERMISSION } from "../src/auth/admin-authorization";
import { SecurityApiError } from "../src/auth/security-core";
import {
  addComment,
  applyCommentMark,
  createDiscussion,
  deleteComment,
  editComment,
  listDiscussions,
  newDocId,
  removeCommentMarks,
  reopenDiscussion,
  resolveDiscussion,
  saveContent,
} from "../src/docs/docs-store";
import type { WriteActor } from "../src/supply/supply-routes";

const ACTOR: WriteActor = { realm: "admin", id: "admin_1", sessionId: "session_1" };
const OTHER: WriteActor = { realm: "admin", id: "admin_2", sessionId: "session_2" };
const READ = ADMIN_PERMISSION.docsInternalRead;
const COMMENT = ADMIN_PERMISSION.docsInternalComment;
const MANAGE = ADMIN_PERMISSION.docsInternalManage;
const NOW = new Date("2026-11-12T02:00:00Z");

const envelope = (value: PlateNode[]): PlateDocumentEnvelope => ({ format: "plate", schemaVersion: 1, preset: "internal", value });
const para = (text: string, marks: Record<string, unknown> = {}): PlateNode => ({ type: "p", id: "n1", children: [{ text, ...marks }] });
const doc = (text = "客服值班手册正文") => envelope([para(text)]);
const discussionId = () => newDocId("dsc");

type FakeDiscussion = {
  id: string; nodeId: string; anchorText: string; status: "OPEN" | "RESOLVED"; anchorState: "PRESENT" | "ORPHANED";
  createdByAdminId: string; createdAt: Date; resolvedByAdminId: string | null; resolvedAt: Date | null;
};
type FakeComment = { id: string; discussionId: string; body: string; authorAdminId: string; createdAt: Date; editedAt: Date | null; deletedAt: Date | null };
type FakeVersion = { id: string; nodeId: string; seq: number; kind: string; authorAdminId: string; windowStartedAt: Date; document: PlateDocumentEnvelope; digest: string };

function fakeClient(options: {
  permissions: string[];
  node?: { id: string; revision: string; deletedAt: Date | null; currentVersionId: string | null } | null;
  latest?: FakeVersion | null;
  discussions?: FakeDiscussion[];
  comments?: FakeComment[];
}) {
  const node = options.node === undefined ? { id: "doc_node_1", revision: "5", deletedAt: null, currentVersionId: "docv_current" } : options.node;
  const latest: FakeVersion | null = options.latest === undefined
    ? { id: "docv_current", nodeId: node?.id ?? "doc_node_1", seq: 3, kind: "EDIT", authorAdminId: ACTOR.id, windowStartedAt: NOW, document: doc(), digest: "a".repeat(64) }
    : options.latest;
  const discussions = options.discussions ?? [];
  const comments = options.comments ?? [];
  const calls: { sql: string; params?: unknown[] }[] = [];
  const client = {
    calls,
    discussions,
    comments,
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      const head = sql.trimStart();
      if (sql.includes("admin_security")) return { rows: [{ status: "ACTIVE", isBoss: false, passwordChangeRequired: false }] };
      if (sql.includes("admin_user_role")) return { rows: options.permissions.map(permissionCode => ({ permissionCode })) };
      if (sql.includes("audit_event")) return { rows: [] };
      if (head.startsWith("SELECT") && sql.includes('FROM "zzsh_docs"."doc_node"')) {
        return { rows: node && node.id === params?.[0] ? [node] : [] };
      }
      if (head.startsWith("SELECT") && sql.includes('FROM "zzsh_docs"."doc_version"')) {
        if (sql.includes("ORDER BY")) return { rows: latest ? [latest] : [] };
        return { rows: latest && latest.id === params?.[0] ? [latest] : [] };
      }
      if (head.startsWith("SELECT") && sql.includes('FROM "zzsh_docs"."doc_discussion"')) {
        if (sql.includes('"node_id" = $1')) {
          const status = params?.[1] as string | null;
          return { rows: discussions.filter(row => row.nodeId === params?.[0] && (status == null || row.status === status)) };
        }
        return { rows: discussions.filter(row => row.id === params?.[0]) };
      }
      if (head.startsWith("INSERT INTO \"zzsh_docs\".\"doc_discussion\"")) {
        if (discussions.some(row => row.id === params?.[0])) return { rows: [], rowCount: 0 };
        discussions.push({
          id: params![0] as string, nodeId: params![1] as string, anchorText: params![2] as string,
          status: "OPEN", anchorState: "PRESENT", createdByAdminId: params![3] as string, createdAt: NOW,
          resolvedByAdminId: null, resolvedAt: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (head.startsWith('UPDATE "zzsh_docs"."doc_discussion"')) {
        const row = discussions.find(item => item.id === params?.[0]);
        if (!row) return { rows: [] };
        if (sql.includes('SET "anchor_state"')) row.anchorState = params![1] as "PRESENT" | "ORPHANED";
        if (sql.includes("SET \"status\" = 'RESOLVED'")) { row.status = "RESOLVED"; row.resolvedByAdminId = params![1] as string; row.resolvedAt = params![2] as Date; }
        if (sql.includes("SET \"status\" = 'OPEN'")) { row.status = "OPEN"; row.resolvedByAdminId = null; row.resolvedAt = null; row.anchorState = "ORPHANED"; }
        return { rows: [row] };
      }
      if (head.startsWith("SELECT") && sql.includes('FROM "zzsh_docs"."doc_comment"')) {
        if (sql.includes("ANY($1::text[])")) {
          const ids = params?.[0] as string[];
          return { rows: comments.filter(row => ids.includes(row.discussionId)) };
        }
        return { rows: comments.filter(row => row.id === params?.[0]) };
      }
      if (head.startsWith('INSERT INTO "zzsh_docs"."doc_comment"')) {
        const row: FakeComment = { id: params![0] as string, discussionId: params![1] as string, body: params![2] as string, authorAdminId: params![3] as string, createdAt: NOW, editedAt: null, deletedAt: null };
        comments.push(row);
        return { rows: [row] };
      }
      if (head.startsWith('UPDATE "zzsh_docs"."doc_comment"')) {
        const row = comments.find(item => item.id === params?.[0]);
        if (!row) return { rows: [] };
        if (sql.includes('SET "body"')) { row.body = params![1] as string; row.editedAt = params![2] as Date; }
        if (sql.includes('SET "deleted_at"')) row.deletedAt = params![1] as Date;
        return { rows: [row] };
      }
      if (head.startsWith('INSERT INTO "zzsh_docs"."doc_version"')) return { rows: [] };
      if (head.startsWith('UPDATE "zzsh_docs"."doc_version"')) return { rows: [] };
      if (sql.includes("doc_version_image")) return { rows: [] };
      if (head.startsWith('UPDATE "zzsh_docs"."doc_node"') && sql.includes("RETURNING")) {
        return { rows: [{ revision: String(BigInt(node!.revision) + 1n) }] };
      }
      if (head.startsWith('UPDATE "zzsh_docs"."doc_node"')) return { rows: [] };
      throw new Error("unexpected discussion query: " + sql.slice(0, 90));
    },
  } as unknown as PoolClient & { calls: { sql: string; params?: unknown[] }[]; discussions: FakeDiscussion[]; comments: FakeComment[] };
  return client;
}

const isStatus = (status: number) => (error: unknown) => error instanceof SecurityApiError && error.status === status;
const versionWrites = (client: ReturnType<typeof fakeClient>) =>
  client.calls.filter(call => call.sql.trimStart().startsWith('INSERT INTO "zzsh_docs"."doc_version"') || call.sql.trimStart().startsWith('UPDATE "zzsh_docs"."doc_version"'));
const savedDocument = (client: ReturnType<typeof fakeClient>): PlateDocumentEnvelope => {
  const write = versionWrites(client).at(-1);
  assert.ok(write, "expected a version write");
  return JSON.parse(write!.params![write!.sql.trimStart().startsWith("INSERT") ? 3 : 1] as string) as PlateDocumentEnvelope;
};
const openDiscussion = (over: Partial<FakeDiscussion> = {}): FakeDiscussion => ({
  id: discussionId(), nodeId: "doc_node_1", anchorText: "正文", status: "OPEN", anchorState: "PRESENT",
  createdByAdminId: ACTOR.id, createdAt: NOW, resolvedByAdminId: null, resolvedAt: null, ...over,
});

// --- pure mark helpers -------------------------------------------------------
test("applyCommentMark splits leaves, keeps other marks and matches the extractPlate projection", () => {
  const document = envelope([para("前缀目标后缀", { bold: true })]);
  const marked = applyCommentMark(document, "dsc_x", "目标");
  assert.ok(marked);
  const leaves = marked!.value[0]!.children!;
  assert.deepEqual(leaves.map(leaf => leaf.text), ["前缀", "目标", "后缀"]);
  assert.equal(leaves[1]!.comment_dsc_x, true);
  assert.equal(leaves[0]!.comment_dsc_x, undefined);
  assert.ok(leaves.every(leaf => leaf.bold === true), "其它 mark 保留");
  assert.equal(extractPlate(marked!).plainText, "前缀目标后缀", "投影文字不变");
  assert.deepEqual(extractPlate(marked!).commentIds, ["dsc_x"]);
  // 跨块选区：投影与 extractPlate 一致（块间 \n、列表、表格、代码块）。
  const multi = envelope([
    { type: "h2", id: "h", children: [{ text: "标题" }] },
    { type: "p", id: "p", listStyleType: "disc", indent: 1, children: [{ text: "甲" }, { text: "乙" }] },
    { type: "code_block", children: [{ type: "code_line", children: [{ text: "行一" }] }, { type: "code_line", children: [{ text: "行二" }] }] },
  ]);
  const plain = extractPlate(multi).plainText;
  const cross = applyCommentMark(multi, "dsc_y", "标题\n甲乙");
  assert.ok(cross, "跨块锚点可定位");
  assert.equal(extractPlate(cross!).plainText, plain);
  assert.deepEqual(extractPlate(cross!).commentIds, ["dsc_y"]);
  const codeAnchor = applyCommentMark(multi, "dsc_z", "行一\n行二");
  assert.ok(codeAnchor, "代码块内跨行锚点可定位");
  // 未命中 / 空锚点 / 仅图片 alt → null。
  assert.equal(applyCommentMark(document, "dsc_x", "不存在"), null);
  assert.equal(applyCommentMark(document, "dsc_x", ""), null);
  const imageOnly = envelope([{ type: "img", imageId: "dimg_a", alt: "图注", children: [{ text: "" }] }]);
  assert.equal(applyCommentMark(imageOnly, "dsc_x", "图注"), null);
});

test("removeCommentMarks strips only the requested ids", () => {
  const value: PlateNode[] = [{ type: "p", children: [{ text: "a", comment_dsc_a: true, comment_dsc_b: true, bold: true }, { text: "b", comment_dsc_a: true }] }];
  const cleaned = removeCommentMarks(value, new Set(["dsc_a"]));
  const leaves = cleaned[0]!.children!;
  assert.equal(leaves[0]!.comment_dsc_a, undefined);
  assert.equal(leaves[0]!.comment_dsc_b, true);
  assert.equal(leaves[0]!.bold, true);
  assert.equal(leaves[1]!.comment_dsc_a, undefined);
  assert.deepEqual(removeCommentMarks(value, new Set()), value, "空集合原样返回");
});

// --- reconciliation three states ---------------------------------------------
test("saveContent reconciles OPEN anchors: PRESENT -> ORPHANED -> PRESENT", async () => {
  const discussion = openDiscussion();
  const marked = applyCommentMark(doc(), discussion.id, "正文")!;
  const client = fakeClient({ permissions: [READ, MANAGE], discussions: [discussion] });
  // 锚点在 -> PRESENT（无状态变化则不写）。
  const first = await saveContent(client, ACTOR, "doc_node_1", "5", marked, NOW);
  assert.deepEqual(first.orphanedDiscussionIds, []);
  assert.equal(discussion.anchorState, "PRESENT");
  // 锚点消失 -> ORPHANED，且出参列出。
  const second = await saveContent(client, ACTOR, "doc_node_1", "5", doc("整句已删除"), NOW);
  assert.deepEqual(second.orphanedDiscussionIds, [discussion.id]);
  assert.equal(discussion.anchorState, "ORPHANED");
  assert.ok(client.calls.some(call => call.sql.includes('"anchor_state"') && call.params?.[1] === "ORPHANED"));
  // 锚点重现（如回滚后再保存）-> PRESENT。
  const third = await saveContent(client, ACTOR, "doc_node_1", "5", marked, NOW);
  assert.deepEqual(third.orphanedDiscussionIds, []);
  assert.equal(discussion.anchorState, "PRESENT");
});

test("saveContent strips unregistered marks with a warning and resolved-discussion marks silently", async () => {
  const resolved = openDiscussion({ status: "RESOLVED", resolvedByAdminId: ACTOR.id, resolvedAt: NOW });
  const registered = openDiscussion();
  const client = fakeClient({ permissions: [READ, MANAGE], discussions: [resolved, registered] });
  const value: PlateNode[] = [{ type: "p", children: [{ text: "正文", [`comment_${registered.id}`]: true, [`comment_${resolved.id}`]: true, comment_dsc_ghost: true }] }];
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (message: unknown) => { warnings.push(String(message)); };
  try {
    const result = await saveContent(client, ACTOR, "doc_node_1", "5", envelope(value), NOW);
    assert.deepEqual(result.orphanedDiscussionIds, []);
    const saved = savedDocument(client);
    const ids = extractPlate(saved).commentIds;
    assert.deepEqual(ids, [registered.id], "未登记与已解决的 mark 均被移除，登记的保留");
    assert.equal(warnings.length, 1);
    const event = JSON.parse(warnings[0]!) as { event: string; discussionIds: string[] };
    assert.equal(event.event, "docs.discussion.unregistered_mark");
    assert.deepEqual(event.discussionIds, ["dsc_ghost"]);
  } finally {
    console.warn = originalWarn;
  }
});

// --- ANNOTATE never bumps revision --------------------------------------------
test("createDiscussion marks the selection, writes ANNOTATE and keeps revision", async () => {
  const client = fakeClient({ permissions: [READ, COMMENT] });
  const id = discussionId();
  const result = await createDiscussion(client, ACTOR, "doc_node_1", { discussionId: id, anchorText: "正文", body: "这里要改" }, NOW);
  assert.equal(result.revision, "5", "revision 不变");
  assert.equal(result.discussion.status, "OPEN");
  assert.equal(result.discussion.anchorState, "PRESENT");
  assert.equal(result.discussion.comments.length, 1);
  assert.deepEqual(extractPlate(result.document).commentIds, [id]);
  const insert = versionWrites(client).at(-1)!;
  assert.ok(insert.sql.trimStart().startsWith("INSERT"));
  assert.ok(insert.sql.includes("'ANNOTATE'"), "kind=ANNOTATE");
  assert.equal(client.calls.some(call => call.sql.includes('"revision" + 1')), false, "不得递增 revision");
  assert.ok(client.calls.some(call => call.sql.trimStart().startsWith('UPDATE "zzsh_docs"."doc_node"') && call.sql.includes('"current_version_id"')), "current_version_id 指向 ANNOTATE 版本");
  // 客服（read+comment）即可建讨论；只读角色 403。
  await createDiscussion(fakeClient({ permissions: [READ, COMMENT] }), OTHER, "doc_node_1", { discussionId: discussionId(), anchorText: "正文", body: "客服评论" }, NOW);
  await assert.rejects(() => createDiscussion(fakeClient({ permissions: [READ] }), ACTOR, "doc_node_1", { discussionId: discussionId(), anchorText: "正文", body: "x" }, NOW), isStatus(403));
  await assert.rejects(() => createDiscussion(fakeClient({ permissions: [COMMENT] }), ACTOR, "doc_node_1", { discussionId: discussionId(), anchorText: "正文", body: "x" }, NOW), isStatus(403));
});

test("createDiscussion anchors the selected repeat and rejects a stale document revision", async () => {
  const latest = {
    id: "docv_current", nodeId: "doc_node_1", seq: 3, kind: "EDIT",
    authorAdminId: ACTOR.id, windowStartedAt: NOW, document: doc("值班与值班"), digest: "a".repeat(64),
  };
  const client = fakeClient({ permissions: [READ, COMMENT], latest });
  const id = discussionId();
  const input = { discussionId: id, anchorText: "值班", anchorOffset: 3, body: "核对第二处" };
  await assert.rejects(() => createDiscussion(client, ACTOR, "doc_node_1", { ...input, expectedRevision: "4" }, NOW),
    (error: unknown) => error instanceof SecurityApiError && error.status === 409);
  assert.equal(client.discussions.length, 0);
  const result = await createDiscussion(client, ACTOR, "doc_node_1", { ...input, expectedRevision: "5" }, NOW);
  assert.deepEqual(result.document.value[0]!.children, [{ text: "值班与" }, { text: "值班", [`comment_${id}`]: true }]);
});

test("createDiscussion rejects bad ids, missing anchors and duplicates", async () => {
  const client = fakeClient({ permissions: [READ, COMMENT] });
  await assert.rejects(() => createDiscussion(client, ACTOR, "doc_node_1", { discussionId: "dsc_bad", anchorText: "正文", body: "x" }, NOW), isStatus(400));
  await assert.rejects(() => createDiscussion(client, ACTOR, "doc_node_1", { discussionId: discussionId(), anchorText: "不存在的选区", body: "x" }, NOW), isStatus(400));
  const id = discussionId();
  await createDiscussion(client, ACTOR, "doc_node_1", { discussionId: id, anchorText: "正文", body: "x" }, NOW);
  await assert.rejects(() => createDiscussion(client, ACTOR, "doc_node_1", { discussionId: id, anchorText: "正文", body: "y" }, NOW), isStatus(409));
  // 已删除节点 404。
  const deleted = fakeClient({ permissions: [READ, COMMENT], node: { id: "doc_node_1", revision: "5", deletedAt: NOW, currentVersionId: "docv_current" } });
  await assert.rejects(() => createDiscussion(deleted, ACTOR, "doc_node_1", { discussionId: discussionId(), anchorText: "正文", body: "x" }, NOW), isStatus(404));
});

test("resolveDiscussion removes the mark, writes ANNOTATE, requires resolver and time", async () => {
  const discussion = openDiscussion();
  const marked = applyCommentMark(doc(), discussion.id, "正文")!;
  const client = fakeClient({
    permissions: [READ, COMMENT],
    latest: { id: "docv_current", nodeId: "doc_node_1", seq: 3, kind: "EDIT", authorAdminId: ACTOR.id, windowStartedAt: NOW, document: marked, digest: "a".repeat(64) },
    discussions: [discussion],
  });
  const result = await resolveDiscussion(client, ACTOR, "req", discussion.id, NOW);
  assert.equal(result.discussion.status, "RESOLVED");
  assert.equal(result.discussion.resolvedByAdminId, ACTOR.id, "resolved_by 必填");
  assert.ok(result.discussion.resolvedAt instanceof Date, "resolved_at 必填");
  assert.equal(result.revision, "5", "解决不递增 revision");
  assert.deepEqual(extractPlate(result.document).commentIds, [], "解决即移除 mark");
  const insert = versionWrites(client).at(-1)!;
  assert.ok(insert.sql.includes("'ANNOTATE'"), "kind=ANNOTATE");
  assert.equal(client.calls.some(call => call.sql.includes('"revision" + 1')), false);
  const update = client.calls.find(call => call.sql.includes("'RESOLVED'") && call.sql.trimStart().startsWith('UPDATE "zzsh_docs"."doc_discussion"'))!;
  assert.equal(update.params![1], ACTOR.id);
  assert.ok(update.params![2] instanceof Date);
  assert.ok(client.calls.some(call => call.sql.includes("audit_event") && call.params?.[4] === "DOC_DISCUSSION_RESOLVED"));
  // 已解决再解决 -> 409。
  await assert.rejects(() => resolveDiscussion(client, ACTOR, "req", discussion.id, NOW), isStatus(409));
});

test("reopenDiscussion clears resolver, never restores the highlight and audits", async () => {
  const discussion = openDiscussion({ status: "RESOLVED", resolvedByAdminId: ACTOR.id, resolvedAt: NOW, anchorState: "ORPHANED" });
  const client = fakeClient({ permissions: [READ, COMMENT], discussions: [discussion] });
  const reopened = await reopenDiscussion(client, ACTOR, "req", discussion.id);
  assert.equal(reopened.status, "OPEN");
  assert.equal(reopened.resolvedByAdminId, null);
  assert.equal(reopened.resolvedAt, null);
  assert.equal(reopened.anchorState, "ORPHANED", "重开不恢复高亮，锚点按缺失处理");
  assert.equal(versionWrites(client).length, 0, "重开不写版本");
  assert.equal(client.calls.some(call => call.sql.includes('"revision" + 1')), false);
  assert.ok(client.calls.some(call => call.sql.includes("audit_event") && call.params?.[4] === "DOC_DISCUSSION_REOPENED"));
  await assert.rejects(() => reopenDiscussion(client, ACTOR, "req", discussion.id), isStatus(409));
});

// --- replies: author-only ------------------------------------------------------
test("editComment / deleteComment are author-only; others get 403", async () => {
  const discussion = openDiscussion();
  const comment: FakeComment = { id: newDocId("dcm"), discussionId: discussion.id, body: "原文", authorAdminId: ACTOR.id, createdAt: NOW, editedAt: null, deletedAt: null };
  const client = fakeClient({ permissions: [READ, COMMENT], discussions: [discussion], comments: [comment] });
  await assert.rejects(() => editComment(client, OTHER, comment.id, "改别人的", NOW), isStatus(403));
  await assert.rejects(() => deleteComment(client, OTHER, "req", comment.id, NOW), isStatus(403));
  const edited = await editComment(client, ACTOR, comment.id, "改自己的", NOW);
  assert.equal(edited.body, "改自己的");
  assert.ok(edited.editedAt instanceof Date);
  const deleted = await deleteComment(client, ACTOR, "req", comment.id, NOW);
  assert.ok(deleted.deletedAt instanceof Date, "软删除");
  assert.ok(client.calls.some(call => call.sql.includes("audit_event") && call.params?.[4] === "DOC_COMMENT_DELETED"));
  // 已删除的回复不能再改删。
  await assert.rejects(() => editComment(client, ACTOR, comment.id, "再改", NOW), isStatus(404));
  await assert.rejects(() => deleteComment(client, ACTOR, "req", comment.id, NOW), isStatus(404));
});

test("addComment and listDiscussions gate on read/comment and node liveness", async () => {
  const discussion = openDiscussion();
  const client = fakeClient({ permissions: [READ, COMMENT], discussions: [discussion] });
  const comment = await addComment(client, OTHER, discussion.id, "回复");
  assert.equal(comment.authorAdminId, OTHER.id);
  const listed = await listDiscussions(client, ACTOR, "doc_node_1");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.comments.length, 1);
  const openOnly = await listDiscussions(client, ACTOR, "doc_node_1", "OPEN");
  assert.equal(openOnly.length, 1);
  const resolvedOnly = await listDiscussions(client, ACTOR, "doc_node_1", "RESOLVED");
  assert.equal(resolvedOnly.length, 0);
  // 只读角色可列讨论但不能回复；无 read 403。
  await assert.rejects(() => addComment(fakeClient({ permissions: [READ], discussions: [discussion] }), ACTOR, discussion.id, "x"), isStatus(403));
  await assert.rejects(() => listDiscussions(fakeClient({ permissions: [COMMENT] }), ACTOR, "doc_node_1"), isStatus(403));
  // 节点已删除 -> 404。
  const deleted = fakeClient({ permissions: [READ, COMMENT], node: { id: "doc_node_1", revision: "5", deletedAt: NOW, currentVersionId: null }, discussions: [discussion] });
  await assert.rejects(() => addComment(deleted, ACTOR, discussion.id, "x"), isStatus(404));
  await assert.rejects(() => listDiscussions(deleted, ACTOR, "doc_node_1"), isStatus(404));
});