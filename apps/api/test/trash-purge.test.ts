// Offline recycle-bin 30-day cleanup checks (node:test, no PostgreSQL / OSS).
// Covers: the due decision (injected clock), the cross-version reference check
// that keeps a shared image, slug-tombstone retention, zero-write idempotency,
// restored-batch safety, advisory-lock skip / single-executor concurrency, and
// runtime option clamping. Real schema, triggers, FK blocks and OSS live in the
// PostgreSQL suite owned by the main session.
import { test } from "node:test";
import { strict as assert } from "node:assert";
import type { Pool, PoolClient } from "pg";

import {
  TRASH_PURGE_LOCK_KEY, TRASH_RETENTION_MS, TrashPurgeService, createTrashPurgeStore,
  isPurgeDue, loadTrashPurgeRuntime, purgeDocsBatch, purgeHelpBatch, purgeExpiredPendingImages,
  runTrashPurge, selectDueDocBatches, selectDueHelpBatches,
  type TrashPurgeStore,
} from "../src/content/trash-purge.module";
import type { DocsImageStorage } from "../src/docs/docs-images";

const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-11-11T00:00:00.000Z");
const CUTOFF = new Date(NOW.getTime() - TRASH_RETENTION_MS);

// --- injected-clock due decision --------------------------------------------
test("isPurgeDue: 29 days stays, 30 days is due, restored/null is never due", () => {
  assert.equal(TRASH_RETENTION_MS, 30 * DAY);
  assert.equal(isPurgeDue(new Date(NOW.getTime() - 29 * DAY), CUTOFF), false);
  assert.equal(isPurgeDue(new Date(NOW.getTime() - 30 * DAY), CUTOFF), true); // boundary <=
  assert.equal(isPurgeDue(new Date(NOW.getTime() - 31 * DAY), CUTOFF), true);
  assert.equal(isPurgeDue(null, CUTOFF), false);
  assert.equal(isPurgeDue(undefined, CUTOFF), false);
});

// --- in-memory fake database -------------------------------------------------
type DocNode = { id: string; depth: number; parent_id: string | null; delete_batch_id: string | null; deleted_at: Date | null; current_version_id: string | null };
type HelpNode = { id: string; depth: number; parent_id: string | null; delete_batch_id: string | null; deleted_at: Date | null; kind: "FOLDER" | "ARTICLE"; resource_key: string | null };
type FakeState = {
  docNodes: DocNode[];
  docVersions: { id: string; node_id: string }[];
  docVersionImages: { version_id: string; image_id: string }[];
  docImages: { id: string; uploaded_in_node_id: string; object_key: string; status: string; completed_at?: Date; upload_expires_at: Date }[];
  docDiscussions: { id: string; node_id: string }[];
  docComments: { id: string; discussion_id: string }[];
  helpNodes: HelpNode[];
  contentItems: { id: string; type: string; resource_key: string }[];
  contentVersions: { id: string; item_id: string }[];
  tombstones: { slug: string; resource_key: string; deleted_at: Date | null; purged_at: Date | null }[];
  audits: { action: string; object_id: string; actor_type: string }[];
  writes: string[];
};

function emptyState(): FakeState {
  return {
    docNodes: [], docVersions: [], docVersionImages: [], docImages: [], docDiscussions: [], docComments: [],
    helpNodes: [], contentItems: [], contentVersions: [], tombstones: [], audits: [], writes: [],
  };
}

function fakeClient(state: FakeState): PoolClient {
  const has = (sql: string, ...parts: string[]) => parts.every(part => sql.includes(part));
  return {
    async query(sql: string, args: unknown[] = []) {
      const a = args as any[];
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
      if (has(sql, 'INSERT INTO "zzsh_iam"."audit_event"')) {
        state.audits.push({ action: a[4], object_id: a[6], actor_type: a[1] });
        state.writes.push("audit");
        return { rows: [], rowCount: 1 };
      }
      // --- due batch selection ---
      if (has(sql, 'FROM "zzsh_docs"."doc_node" root', 'AS "batchId"')) {
        const cutoff = a[0] as Date; const limit = a[1] as number;
        const roots = state.docNodes.filter(n => n.deleted_at && n.deleted_at <= cutoff && n.delete_batch_id
          && (n.parent_id === null || !state.docNodes.some(p => p.id === n.parent_id && p.delete_batch_id === n.delete_batch_id)));
        return { rows: roots.slice(0, limit).map(n => ({ batchId: n.delete_batch_id })), rowCount: roots.length };
      }
      if (has(sql, 'FROM "zzsh_content"."help_tree_node" root', 'AS "batchId"')) {
        const cutoff = a[0] as Date; const limit = a[1] as number;
        const roots = state.helpNodes.filter(n => n.deleted_at && n.deleted_at <= cutoff && n.delete_batch_id
          && (n.parent_id === null || !state.helpNodes.some(p => p.id === n.parent_id && p.delete_batch_id === n.delete_batch_id)));
        return { rows: roots.slice(0, limit).map(n => ({ batchId: n.delete_batch_id })), rowCount: roots.length };
      }
      // --- docs batch purge ---
      if (has(sql, 'SELECT "id", "depth" FROM "zzsh_docs"."doc_node"', "FOR UPDATE")) {
        const rows = state.docNodes.filter(n => n.delete_batch_id === a[0] && n.deleted_at && n.deleted_at <= (a[1] as Date))
          .sort((x, y) => y.depth - x.depth).map(n => ({ id: n.id, depth: n.depth }));
        return { rows, rowCount: rows.length };
      }
      if (has(sql, 'SELECT "id" FROM "zzsh_docs"."doc_version" WHERE "node_id" = ANY')) {
        const ids = a[0] as string[]; const rows = state.docVersions.filter(v => ids.includes(v.node_id)).map(v => ({ id: v.id }));
        return { rows, rowCount: rows.length };
      }
      if (has(sql, 'FROM "zzsh_docs"."doc_image" WHERE "uploaded_in_node_id" = ANY')) {
        const ids = a[0] as string[]; const rows = state.docImages.filter(i => ids.includes(i.uploaded_in_node_id)).map(i => ({ id: i.id, objectKey: i.object_key }));
        return { rows, rowCount: rows.length };
      }
      if (has(sql, 'FROM "zzsh_docs"."doc_version_image" vi', 'JOIN "zzsh_docs"."doc_version" v', 'WHERE vi."image_id" = $1')) {
        const refs = state.docVersionImages.filter(vi => vi.image_id === a[0])
          .map(vi => state.docVersions.find(v => v.id === vi.version_id)).filter(Boolean).map(v => ({ nodeId: v!.node_id })).sort((x, y) => x.nodeId.localeCompare(y.nodeId));
        return { rows: refs.slice(0, 1), rowCount: refs.length };
      }
      if (has(sql, 'DELETE FROM "zzsh_docs"."doc_comment"')) {
        const ids = a[0] as string[]; const disc = state.docDiscussions.filter(d => ids.includes(d.node_id)).map(d => d.id);
        const before = state.docComments.length; state.docComments = state.docComments.filter(c => !disc.includes(c.discussion_id));
        state.writes.push("delete:doc_comment"); return { rows: [], rowCount: before - state.docComments.length };
      }
      if (has(sql, 'DELETE FROM "zzsh_docs"."doc_discussion"')) {
        const ids = a[0] as string[]; const before = state.docDiscussions.length;
        state.docDiscussions = state.docDiscussions.filter(d => !ids.includes(d.node_id));
        state.writes.push("delete:doc_discussion"); return { rows: [], rowCount: before - state.docDiscussions.length };
      }
      if (has(sql, 'DELETE FROM "zzsh_docs"."doc_version_image" WHERE "version_id" = ANY')) {
        const ids = a[0] as string[]; const before = state.docVersionImages.length;
        state.docVersionImages = state.docVersionImages.filter(vi => !ids.includes(vi.version_id));
        state.writes.push("delete:doc_version_image"); return { rows: [], rowCount: before - state.docVersionImages.length };
      }
      if (has(sql, 'DELETE FROM "zzsh_docs"."doc_version" WHERE "node_id" = ANY')) {
        const ids = a[0] as string[]; const before = state.docVersions.length;
        assert.ok(state.docNodes.every(node => !ids.includes(node.id) || node.current_version_id === null), "clear the current-version FK before deleting versions");
        state.docVersions = state.docVersions.filter(v => !ids.includes(v.node_id));
        state.writes.push("delete:doc_version"); return { rows: [], rowCount: before - state.docVersions.length };
      }
      if (has(sql, 'UPDATE "zzsh_docs"."doc_node" SET "current_version_id" = NULL')) {
        const ids = a[0] as string[]; state.docNodes.forEach(n => { if (ids.includes(n.id)) n.current_version_id = null; });
        state.writes.push("update:doc_node"); return { rows: [], rowCount: ids.length };
      }
      if (has(sql, 'UPDATE "zzsh_docs"."doc_image" SET "uploaded_in_node_id"')) {
        const img = state.docImages.find(i => i.id === a[0]); if (img) img.uploaded_in_node_id = a[1];
        state.writes.push("update:doc_image:adopt"); return { rows: [], rowCount: 1 };
      }
      if (has(sql, 'UPDATE "zzsh_docs"."doc_image" SET "status"')) {
        const img = state.docImages.find(i => i.id === a[0]); if (img) img.status = "PURGING";
        state.writes.push("update:doc_image:purging"); return { rows: [], rowCount: 1 };
      }
      if (has(sql, 'DELETE FROM "zzsh_docs"."doc_node" n')) {
        const batch = a[0]; const depth = a[1];
        const doomed = state.docNodes.filter(n => n.delete_batch_id === batch && n.depth === depth
          && !state.docImages.some(i => i.uploaded_in_node_id === n.id)
          && !state.docNodes.some(c => c.parent_id === n.id));
        state.docNodes = state.docNodes.filter(n => !doomed.includes(n));
        if (doomed.length) state.writes.push("delete:doc_node");
        return { rows: [], rowCount: doomed.length };
      }
      if (has(sql, 'SELECT count(*)::int AS "count" FROM "zzsh_docs"."doc_node" WHERE "delete_batch_id"')) {
        const count = state.docNodes.filter(n => n.delete_batch_id === a[0]).length; return { rows: [{ count }], rowCount: 1 };
      }
      if (has(sql, 'DELETE FROM "zzsh_docs"."doc_image" WHERE "id" = $1 AND "status"')) {
        const before = state.docImages.length; state.docImages = state.docImages.filter(i => !(i.id === a[0] && i.status === "PURGING"));
        state.writes.push("delete:doc_image"); return { rows: [], rowCount: before - state.docImages.length };
      }
      // --- expired pending images ---
      if (has(sql, 'FROM "zzsh_docs"."doc_image" i', 'WHERE i."status" IN (', "NOT EXISTS")) {
        const cutoff = a[0] as Date;
        const rows = state.docImages.filter(i => ["PENDING", "PURGING"].includes(i.status) && !i.completed_at && i.upload_expires_at <= cutoff
          && !state.docVersionImages.some(vi => vi.image_id === i.id)).map(i => ({ id: i.id, objectKey: i.object_key }));
        return { rows, rowCount: rows.length };
      }
      if (has(sql, 'WHERE i."id" = $1 AND i."status" IN (', "FOR UPDATE")) {
        const cutoff = a[1] as Date;
        const rows = state.docImages.filter(i => i.id === a[0] && ["PENDING", "PURGING"].includes(i.status) && !i.completed_at && i.upload_expires_at <= cutoff
          && !state.docVersionImages.some(vi => vi.image_id === i.id)).map(i => ({ id: i.id }));
        return { rows, rowCount: rows.length };
      }
      // --- help batch purge ---
      if (has(sql, 'SELECT "id", "depth", "kind", "resource_key" AS "resourceKey" FROM "zzsh_content"."help_tree_node"', "FOR UPDATE")) {
        const rows = state.helpNodes.filter(n => n.delete_batch_id === a[0] && n.deleted_at && n.deleted_at <= (a[1] as Date))
          .sort((x, y) => y.depth - x.depth).map(n => ({ id: n.id, depth: n.depth, kind: n.kind, resourceKey: n.resource_key }));
        return { rows, rowCount: rows.length };
      }
      if (has(sql, 'SELECT "id" FROM "zzsh_content"."content_item" WHERE "type" = \'RESOURCE\'')) {
        const keys = a[0] as string[]; const rows = state.contentItems.filter(i => i.type === "RESOURCE" && keys.includes(i.resource_key)).map(i => ({ id: i.id }));
        return { rows, rowCount: rows.length };
      }
      if (has(sql, 'DELETE FROM "zzsh_content"."content_version"')) {
        const ids = a[0] as string[]; const before = state.contentVersions.length;
        state.contentVersions = state.contentVersions.filter(v => !ids.includes(v.item_id));
        state.writes.push("delete:content_version"); return { rows: [], rowCount: before - state.contentVersions.length };
      }
      if (has(sql, 'DELETE FROM "zzsh_content"."content_item"')) {
        const ids = a[0] as string[]; const before = state.contentItems.length;
        state.contentItems = state.contentItems.filter(i => !ids.includes(i.id));
        state.writes.push("delete:content_item"); return { rows: [], rowCount: before - state.contentItems.length };
      }
      if (has(sql, 'UPDATE "zzsh_content"."help_slug_tombstone" SET "purged_at"')) {
        const slugs = a[0] as string[]; let n = 0;
        state.tombstones.forEach(t => { if (slugs.includes(t.slug) && t.purged_at === null) { t.purged_at = NOW; n += 1; } });
        state.writes.push("update:tombstone"); return { rows: [], rowCount: n };
      }
      if (has(sql, 'DELETE FROM "zzsh_content"."help_tree_node" n')) {
        const batch = a[0]; const depth = a[1];
        const doomed = state.helpNodes.filter(n => n.delete_batch_id === batch && n.depth === depth && !state.helpNodes.some(c => c.parent_id === n.id));
        state.helpNodes = state.helpNodes.filter(n => !doomed.includes(n));
        if (doomed.length) state.writes.push("delete:help_tree_node");
        return { rows: [], rowCount: doomed.length };
      }
      if (has(sql, 'SELECT count(*)::int AS "count" FROM "zzsh_content"."help_tree_node" WHERE "delete_batch_id"')) {
        const count = state.helpNodes.filter(n => n.delete_batch_id === a[0]).length; return { rows: [{ count }], rowCount: 1 };
      }
      throw new Error("unexpected query in fakeClient: " + sql.slice(0, 90));
    },
  } as unknown as PoolClient;
}

function fakeStorage(): DocsImageStorage & { deleted: string[]; failNext: boolean } {
  const deleted: string[] = [];
  return {
    deleted, failNext: false,
    writeObject: async () => {}, readObject: async () => Buffer.from(""), headObject: async () => true,
    async deleteObject(key: string) { if (this.failNext) { this.failNext = false; throw new Error("OSS unavailable"); } deleted.push(key); },
  };
}

function seedDocBatch(state: FakeState, opts: { sharedImage?: boolean } = {}) {
  const deletedAt = new Date(NOW.getTime() - 31 * DAY);
  state.docNodes.push({ id: "doc_a", depth: 1, parent_id: null, delete_batch_id: "dbatch_1", deleted_at: deletedAt, current_version_id: "docv_a" });
  state.docVersions.push({ id: "docv_a", node_id: "doc_a" });
  state.docImages.push({ id: "dimg_orphan", uploaded_in_node_id: "doc_a", object_key: "internal-docs/doc_a/dimg_orphan.png", status: "READY", upload_expires_at: new Date(NOW.getTime() + DAY) });
  state.docVersionImages.push({ version_id: "docv_a", image_id: "dimg_orphan" });
  if (opts.sharedImage) {
    // A live document B (not in the batch) references an image uploaded in A.
    state.docNodes.push({ id: "doc_b", depth: 1, parent_id: null, delete_batch_id: null, deleted_at: null, current_version_id: "docv_b" });
    state.docVersions.push({ id: "docv_b", node_id: "doc_b" });
    state.docImages.push({ id: "dimg_shared", uploaded_in_node_id: "doc_a", object_key: "internal-docs/doc_a/dimg_shared.png", status: "READY", upload_expires_at: new Date(NOW.getTime() + DAY) });
    state.docVersionImages.push({ version_id: "docv_b", image_id: "dimg_shared" });
  }
}

test("reference check keeps a cross-document image (row + OSS) and purges the orphan", async () => {
  const state = emptyState(); seedDocBatch(state, { sharedImage: true });
  const storage = fakeStorage();
  const outcome = await purgeDocsBatch(fakeClient(state), "dbatch_1", CUTOFF, storage, "req_1");
  assert.equal(outcome.purged, true);
  assert.equal(outcome.imagesKept, 1);
  assert.equal(outcome.imagesDeleted, 1);
  // The shared image survives, is adopted by the live referencing node, never OSS-deleted.
  const shared = state.docImages.find(i => i.id === "dimg_shared")!;
  assert.equal(shared.status, "READY");
  assert.equal(shared.uploaded_in_node_id, "doc_b");
  assert.deepEqual(storage.deleted, ["internal-docs/doc_a/dimg_orphan.png"]);
  // The orphan row is gone; the batch node is gone; B and its version are untouched.
  assert.equal(state.docImages.some(i => i.id === "dimg_orphan"), false);
  assert.equal(state.docNodes.some(n => n.id === "doc_a"), false);
  assert.ok(state.docNodes.some(n => n.id === "doc_b"));
  assert.ok(state.docVersions.some(v => v.id === "docv_b"));
  assert.deepEqual(state.audits.map(x => x.action), ["DOC_PURGED"]);
  assert.equal(state.audits[0]!.actor_type, "system");
});

test("an OSS delete failure leaves the image PURGING for the next pass and succeeds on retry", async () => {
  const state = emptyState(); seedDocBatch(state);
  const storage = fakeStorage(); storage.failNext = true;
  const first = await purgeDocsBatch(fakeClient(state), "dbatch_1", CUTOFF, storage, "req_1");
  assert.equal(first.imagesDeleted, 0);
  assert.equal(state.docImages.find(i => i.id === "dimg_orphan")!.status, "PURGING");
  // The node still owns a PURGING image, so it waits; no audit yet.
  assert.ok(state.docNodes.some(n => n.id === "doc_a"));
  assert.equal(state.audits.length, 0);
  const second = await purgeDocsBatch(fakeClient(state), "dbatch_1", CUTOFF, storage, "req_2");
  assert.equal(second.imagesDeleted, 1);
  assert.equal(second.purged, true);
  assert.equal(state.docNodes.some(n => n.id === "doc_a"), false);
  assert.deepEqual(state.audits.map(x => x.action), ["DOC_PURGED"]); // audited exactly once
});

test("re-purging a cleared batch is a zero-write no-op (idempotent, no duplicate audit)", async () => {
  const state = emptyState(); seedDocBatch(state);
  const client = fakeClient(state);
  await purgeDocsBatch(client, "dbatch_1", CUTOFF, fakeStorage(), "req_1");
  const writesBefore = state.writes.length; const auditsBefore = state.audits.length;
  const again = await purgeDocsBatch(client, "dbatch_1", CUTOFF, fakeStorage(), "req_2");
  assert.equal(again.purged, false);
  assert.equal(again.nodes, 0);
  assert.equal(state.writes.length, writesBefore, "no writes on a repeated cleared batch");
  assert.equal(state.audits.length, auditsBefore, "no duplicate audit");
});

test("a restored batch (deleted_at cleared) is never selected nor purged", async () => {
  const state = emptyState(); seedDocBatch(state);
  state.docNodes.forEach(n => { if (n.delete_batch_id === "dbatch_1") { n.deleted_at = null; n.delete_batch_id = null; } });
  const client = fakeClient(state);
  assert.deepEqual(await selectDueDocBatches(client, CUTOFF, 20), []);
  const outcome = await purgeDocsBatch(client, "dbatch_1", CUTOFF, fakeStorage(), "req_1");
  assert.equal(outcome.purged, false);
  assert.equal(state.writes.length, 0);
  assert.ok(state.docNodes.some(n => n.id === "doc_a"));
});

test("a 29-day-old batch is not due; a 30-day-old batch is due", async () => {
  const state = emptyState(); seedDocBatch(state);
  state.docNodes.find(n => n.id === "doc_a")!.deleted_at = new Date(NOW.getTime() - 29 * DAY);
  assert.deepEqual(await selectDueDocBatches(fakeClient(state), CUTOFF, 20), []);
  state.docNodes.find(n => n.id === "doc_a")!.deleted_at = new Date(NOW.getTime() - 30 * DAY);
  assert.deepEqual(await selectDueDocBatches(fakeClient(state), CUTOFF, 20), ["dbatch_1"]);
});

test("help purge removes nodes + snapshots but keeps the slug tombstone retired forever", async () => {
  const state = emptyState();
  const deletedAt = new Date(NOW.getTime() - 31 * DAY);
  state.helpNodes.push({ id: "htn_folder", depth: 1, parent_id: null, delete_batch_id: "hbatch_1", deleted_at: deletedAt, kind: "FOLDER", resource_key: null });
  state.helpNodes.push({ id: "htn_article", depth: 2, parent_id: "htn_folder", delete_batch_id: "hbatch_1", deleted_at: deletedAt, kind: "ARTICLE", resource_key: "guide:old-slug" });
  state.contentItems.push({ id: "ci_1", type: "RESOURCE", resource_key: "guide:old-slug" });
  state.contentVersions.push({ id: "cv_1", item_id: "ci_1" });
  state.tombstones.push({ slug: "old-slug", resource_key: "guide:old-slug", deleted_at: deletedAt, purged_at: null });
  const outcome = await purgeHelpBatch(fakeClient(state), "hbatch_1", CUTOFF, "req_1");
  assert.equal(outcome.purged, true);
  assert.equal(outcome.articles, 1);
  assert.equal(state.helpNodes.length, 0);
  assert.equal(state.contentItems.length, 0);
  assert.equal(state.contentVersions.length, 0);
  // Tombstone row is kept, deleted_at stays set (slug retired), purged_at stamped.
  const tomb = state.tombstones.find(t => t.slug === "old-slug")!;
  assert.ok(tomb, "tombstone must never be deleted");
  assert.ok(tomb.deleted_at, "deleted_at stays set so the slug is never reused");
  assert.ok(tomb.purged_at, "purged_at is stamped");
  assert.equal(state.writes.some(w => w === "delete:tombstone"), false);
  assert.deepEqual(state.audits.map(x => x.action), ["HELP_PURGED"]);
  // Re-running the cleared help batch is a zero-write no-op.
  const writesBefore = state.writes.length;
  const again = await purgeHelpBatch(fakeClient(state), "hbatch_1", CUTOFF, "req_2");
  assert.equal(again.purged, false);
  assert.equal(state.writes.length, writesBefore);
  assert.equal(state.audits.length, 1);
});

test("expired unreferenced PENDING uploads are swept; referenced ones are kept", async () => {
  const state = emptyState();
  const expired = new Date(NOW.getTime() - 2 * DAY);
  state.docImages.push({ id: "dimg_pending", uploaded_in_node_id: "doc_live", object_key: "internal-docs/doc_live/dimg_pending.png", status: "PENDING", upload_expires_at: expired });
  state.docImages.push({ id: "dimg_referenced", uploaded_in_node_id: "doc_live", object_key: "internal-docs/doc_live/dimg_referenced.png", status: "PENDING", upload_expires_at: expired });
  state.docVersionImages.push({ version_id: "docv_live", image_id: "dimg_referenced" });
  state.docImages.push({ id: "dimg_fresh", uploaded_in_node_id: "doc_live", object_key: "internal-docs/doc_live/dimg_fresh.png", status: "PENDING", upload_expires_at: new Date(NOW.getTime() - 12 * 60 * 60 * 1000) });
  const storage = fakeStorage();
  const deleted = await purgeExpiredPendingImages(fakeClient(state), NOW, storage);
  assert.equal(deleted, 1);
  assert.deepEqual(storage.deleted, ["internal-docs/doc_live/dimg_pending.png"]);
  assert.equal(state.docImages.some(i => i.id === "dimg_pending"), false);
  assert.ok(state.docImages.some(i => i.id === "dimg_referenced"));
  assert.ok(state.docImages.some(i => i.id === "dimg_fresh"));
});

test("missing storage retains documents and pending keys; failed expired deletes are retried", async () => {
  const state = emptyState();
  seedDocBatch(state);
  const image = state.docImages[0]!;
  const client = fakeClient(state);
  const batchId = state.docNodes[0]!.delete_batch_id!;
  const result = await purgeDocsBatch(client, batchId, CUTOFF, undefined, "req_disabled");
  assert.equal(result.purged, false);
  assert.ok(state.docImages.includes(image));
  assert.equal(state.writes.length, 0);

  const pending = emptyState();
  pending.docImages.push({ ...image, status: "PENDING", upload_expires_at: new Date(NOW.getTime() - 2 * DAY) });
  const expiredClient = fakeClient(pending);
  assert.equal(await purgeExpiredPendingImages(expiredClient, NOW, undefined), 0);
  assert.equal(pending.docImages[0]!.status, "PENDING");
  const storage = fakeStorage();
  storage.failNext = true;
  assert.equal(await purgeExpiredPendingImages(expiredClient, NOW, storage), 0);
  assert.equal(pending.docImages[0]!.status, "PURGING");
  assert.equal(await purgeExpiredPendingImages(expiredClient, NOW, storage), 1);
  assert.deepEqual(storage.deleted, [image.object_key]);
  assert.equal(pending.docImages.length, 0);
});

test("runTrashPurge drives docs + help + pending sweeps and honours cancellation between batches", async () => {
  const state = emptyState(); seedDocBatch(state);
  const deletedAt = new Date(NOW.getTime() - 31 * DAY);
  state.helpNodes.push({ id: "htn_a", depth: 1, parent_id: null, delete_batch_id: "hbatch_1", deleted_at: deletedAt, kind: "ARTICLE", resource_key: "guide:x" });
  state.tombstones.push({ slug: "x", resource_key: "guide:x", deleted_at: deletedAt, purged_at: null });
  const result = await runTrashPurge({ client: fakeClient(state), batchLimit: 20, now: NOW, requestId: "req", storage: fakeStorage(), isCancelled: () => false });
  assert.equal(result.docBatches, 1);
  assert.equal(result.helpBatches, 1);
  assert.deepEqual(state.audits.map(x => x.action).sort(), ["DOC_PURGED", "HELP_PURGED"]);
  // Cancellation before any batch -> no work at all.
  const fresh = emptyState(); seedDocBatch(fresh);
  const cancelled = await runTrashPurge({ client: fakeClient(fresh), batchLimit: 20, now: NOW, requestId: "req", storage: fakeStorage(), isCancelled: () => true });
  assert.equal(cancelled.docBatches, 0);
  assert.equal(fresh.writes.length, 0);
});

// --- advisory-lock harness (single executor / skip / takeover) ----------------
let sessionSequence = 0;
function lockHarness(options: { workerId?: string; server?: { holder: string | null }; store?: TrashPurgeStore } = {}) {
  const locks = options.server ?? { holder: null as string | null };
  let sequence = sessionSequence; sessionSequence += 100;
  const clients: Array<PoolClient & { id: string; alive: boolean; dropped: boolean }> = [];
  const makeClient = () => {
    const id = "sess_" + (sequence++);
    const listeners = new Map<string, () => void>();
    const entry = {
      id, alive: true, dropped: false,
      once(event: string, listener: () => void) { listeners.set(event, listener); },
      removeListener(event: string, listener: () => void) { if (listeners.get(event) === listener) listeners.delete(event); },
      emit(event: string) { const listener = listeners.get(event); listeners.delete(event); listener?.(); },
      release() { if (!entry.alive) return; entry.alive = false; if (locks.holder === id) locks.holder = null; clients.splice(clients.indexOf(entry as any), 1); },
      async query(sql: string, args: unknown[] = []) {
        if (!entry.alive || entry.dropped) throw Object.assign(new Error("CONNECTION_CLOSED"), { code: "57P01" });
        if (sql.includes("pg_try_advisory_lock")) {
          if (String(args[0]) !== TRASH_PURGE_LOCK_KEY) return { rows: [{ acquired: true }], rowCount: 1 };
          if (locks.holder !== null && locks.holder !== id) return { rows: [{ acquired: false }], rowCount: 1 };
          locks.holder = id; return { rows: [{ acquired: true }], rowCount: 1 };
        }
        if (sql.includes("pg_advisory_unlock")) { if (String(args[0]) === TRASH_PURGE_LOCK_KEY && locks.holder === id) locks.holder = null; return { rows: [{ released: true }], rowCount: 1 }; }
        if (sql.includes("FROM pg_locks")) {
          assert.match(sql, /\bobjid\s*=/); assert.match(sql, /objsubid=1/); assert.match(sql, /\bgranted\b/);
          assert.match(sql, /classid=/);
          return { rows: [{ held: locks.holder === id ? 1 : 0 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    } as unknown as PoolClient & { id: string; alive: boolean; dropped: boolean };
    clients.push(entry); return entry;
  };
  const pool = { async connect() { return makeClient(); } } as unknown as Pool;
  let runs = 0;
  const store: TrashPurgeStore = options.store ?? { async runOnce() { runs += 1; return { docBatches: 0, helpBatches: 0, docNodes: 0, helpNodes: 0, imagesDeleted: 0, imagesKept: 0, pendingImages: 0, skipped: 0 }; } };
  const service = new TrashPurgeService({ pool, intervalMs: 60000, batchLimit: 20, workerId: options.workerId ?? "main", store });
  return { service, locks, clients, runs: () => runs };
}

test("the worker only drives while its own session holds lock 806009; a starved instance skips", async () => {
  const server = { holder: null as string | null };
  const a = lockHarness({ workerId: "a", server });
  const b = lockHarness({ workerId: "b", server });
  await a.service.tick();
  assert.equal(a.runs(), 1);
  assert.equal(server.holder, a.clients[0]!.id);
  await b.service.tick();
  assert.equal(b.runs(), 0, "a lock-starved instance performs no cleanup");
  assert.equal(server.holder, a.clients[0]!.id);
  // A's session dies: PG drops the lock; A notices and B takes over without a restart.
  a.clients.forEach(c => { c.dropped = true; });
  await a.service.tick();
  assert.equal(a.runs(), 1, "the stale instance stops before doing more work");
  assert.equal(server.holder, null);
  await b.service.tick();
  assert.equal(b.runs(), 1, "the waiting instance takes over");
  await a.service.onApplicationShutdown();
  await b.service.onApplicationShutdown();
  assert.equal(server.holder, null);
  assert.equal(b.clients.filter(c => c.alive).length, 0);
});

test("the same session keeps driving across ticks and shutdown releases the lease", async () => {
  const h = lockHarness();
  await h.service.tick();
  await h.service.tick();
  assert.equal(h.runs(), 2);
  assert.equal(h.clients.filter(c => c.alive).length, 1, "one session keeps driving");
  await h.service.onApplicationShutdown();
  assert.equal(h.locks.holder, null);
  assert.equal(h.clients.length, 0);
});

test("session error/end releases the checked-out pool client exactly once", async () => {
  for (const event of ["error", "end"]) {
    const h = lockHarness();
    await h.service.tick();
    const client = h.clients[0] as any;
    client.dropped = true; client.emit(event);
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(h.clients.length, 0, event + " must return the broken pool lease");
    await h.service.tick();
    assert.equal(h.runs(), 2);
    await h.service.onApplicationShutdown();
    assert.equal(h.clients.length, 0);
  }
});

// --- runtime option clamping / opt-in ----------------------------------------
test("loadTrashPurgeRuntime is opt-in, requires a pool, and clamps interval/batch", () => {
  assert.equal(loadTrashPurgeRuntime(undefined, undefined, { CONTENT_TRASH_PURGE_ENABLED: "false" }), undefined);
  assert.equal(loadTrashPurgeRuntime({} as Pool, undefined, {}), undefined);
  assert.throws(() => loadTrashPurgeRuntime(undefined, undefined, { CONTENT_TRASH_PURGE_ENABLED: "true" }), /requires a business database pool/);
  assert.throws(() => loadTrashPurgeRuntime({} as Pool, undefined, { CONTENT_TRASH_PURGE_ENABLED: "true", CONTENT_TRASH_PURGE_INTERVAL_MS: "1000" }), /60000-3600000/);
  assert.throws(() => loadTrashPurgeRuntime({} as Pool, undefined, { CONTENT_TRASH_PURGE_ENABLED: "true", CONTENT_TRASH_PURGE_INTERVAL_MS: "9999999" }), /60000-3600000/);
  assert.throws(() => loadTrashPurgeRuntime({} as Pool, undefined, { CONTENT_TRASH_PURGE_ENABLED: "true", CONTENT_TRASH_PURGE_BATCH_LIMIT: "0" }), /1-100/);
  assert.throws(() => loadTrashPurgeRuntime({} as Pool, undefined, { CONTENT_TRASH_PURGE_ENABLED: "true", CONTENT_TRASH_PURGE_BATCH_LIMIT: "500" }), /1-100/);
  const ok = loadTrashPurgeRuntime({} as Pool, undefined, { CONTENT_TRASH_PURGE_ENABLED: "true" })!;
  assert.equal(ok.intervalMs, 3600000);
  assert.equal(ok.batchLimit, 20);
  assert.equal(ok.workerId, "main");
  assert.ok(ok.store, "a real store is assembled by default");
  assert.equal(createTrashPurgeStore().runOnce, runTrashPurge);
});