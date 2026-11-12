import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { extractPlate, plateDigest, validatePlateDocument, type PlateDocumentEnvelope, type PlateNode } from "@zzsh/content/plate";

import { ADMIN_PERMISSION, requirePermission, type EffectiveAdminAccess } from "../auth/admin-authorization";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { requireAdminAccess } from "../supply/supply-routes";
import { conflict, forbidden, invalid, notFound } from "../supply/supply-util";
import type { WriteActor } from "../supply/supply-routes";
import { docsImageObjectKey } from "./docs-images";
import { ALLOWED_IMAGE_MIMES, assertImageWithinBounds, type ImageMime } from "../supply/media";

export const DOC_MERGE_WINDOW_MS = 10 * 60 * 1000;
export const DOC_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SORT_WIDTH = 16;
const SORT_GAP = 1_000_000;

export type DocNodeRow = {
  id: string;
  parentId: string | null;
  depth: number;
  sortKey: string;
  title: string;
  currentVersionId: string | null;
  revision: string;
  createdByAdminId: string;
  updatedByAdminId: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  deletedByAdminId: string | null;
  deleteBatchId: string | null;
};

export type DocVersionRow = {
  id: string;
  nodeId: string;
  seq: number;
  document: PlateDocumentEnvelope;
  digest: string;
  kind: "CREATE" | "EDIT" | "RESTORE" | "ANNOTATE";
  authorAdminId: string;
  windowStartedAt: Date;
  savedAt: Date;
  saveCount: number;
  restoredFromVersionId: string | null;
};

export type DocImageRow = {
  id: string;
  uploadedInNodeId: string;
  objectKey: string;
  mime: ImageMime;
  bytes: number;
  width: number;
  height: number;
  status: "PENDING" | "READY" | "PURGING";
  uploadedByAdminId: string;
  createdAt: Date;
  uploadExpiresAt: Date;
  completedAt: Date | null;
};

export type NodeDetail = { node: DocNodeRow; version: DocVersionRow | null; revision: string };

export type DocDiscussionRow = {
  id: string;
  nodeId: string;
  anchorText: string;
  status: "OPEN" | "RESOLVED";
  anchorState: "PRESENT" | "ORPHANED";
  createdByAdminId: string;
  createdAt: Date;
  resolvedByAdminId: string | null;
  resolvedAt: Date | null;
};

export type DocCommentRow = {
  id: string;
  discussionId: string;
  body: string;
  authorAdminId: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
};

export type DiscussionWithComments = DocDiscussionRow & { comments: DocCommentRow[] };

/** ANNOTATE writes (create / resolve) return the marked document so the client
 *  can refresh highlights without a refetch; revision is deliberately unchanged. */
export type DiscussionWriteResult = {
  discussion: DiscussionWithComments;
  versionId: string;
  seq: number;
  document: PlateDocumentEnvelope;
  revision: string;
};

const NODE_FIELDS = `"id", "parent_id" AS "parentId", "depth", "sort_key" AS "sortKey", "title",
  "current_version_id" AS "currentVersionId", "revision"::text AS "revision",
  "created_by_admin_id" AS "createdByAdminId", "updated_by_admin_id" AS "updatedByAdminId",
  "created_at" AS "createdAt", "updated_at" AS "updatedAt", "deleted_at" AS "deletedAt",
  "deleted_by_admin_id" AS "deletedByAdminId", "delete_batch_id" AS "deleteBatchId"`;

const VERSION_METADATA_FIELDS = `"id", "node_id" AS "nodeId", "seq", "digest", "kind",
  "author_admin_id" AS "authorAdminId", "window_started_at" AS "windowStartedAt", "saved_at" AS "savedAt",
  "save_count" AS "saveCount", "restored_from_version_id" AS "restoredFromVersionId"`;
const VERSION_FIELDS = `${VERSION_METADATA_FIELDS}, "document"`;

const IMAGE_FIELDS = `"id", "uploaded_in_node_id" AS "uploadedInNodeId", "object_key" AS "objectKey",
  "mime", "bytes", "width", "height", "status", "uploaded_by_admin_id" AS "uploadedByAdminId",
  "created_at" AS "createdAt", "upload_expires_at" AS "uploadExpiresAt", "completed_at" AS "completedAt"`;

const DISCUSSION_FIELDS = `"id", "node_id" AS "nodeId", "anchor_text" AS "anchorText", "status",
  "anchor_state" AS "anchorState", "created_by_admin_id" AS "createdByAdminId", "created_at" AS "createdAt",
  "resolved_by_admin_id" AS "resolvedByAdminId", "resolved_at" AS "resolvedAt"`;

const COMMENT_FIELDS = `"id", "discussion_id" AS "discussionId", "body", "author_admin_id" AS "authorAdminId",
  "created_at" AS "createdAt", "edited_at" AS "editedAt", "deleted_at" AS "deletedAt"`;

export function newDocId(prefix: "doc" | "docv" | "dimg" | "dbatch" | "dsc" | "dcm"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function versionChanged(): SecurityApiError {
  return new SecurityApiError(409, API_V1_ERROR_CODES.VERSION_CHANGED, "别人刚改过，刷新后再改");
}

function moveInvalid(message = "Move is not allowed"): SecurityApiError {
  return new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, message, [{ path: "reason", code: "MOVE_INVALID" }]);
}

function plateInvalid(errors: { path: string; code: string; message: string }[]): SecurityApiError {
  return new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Document is invalid",
    errors.slice(0, 20).map(error => ({ path: error.path, code: "INVALID_FIELD" })));
}

export async function authorizeDocs(client: PoolClient, actor: WriteActor, action: "read" | "comment" | "manage"): Promise<EffectiveAdminAccess> {
  const access = await requireAdminAccess(client, actor.id);
  // Discussion receipts include text from the document.
  if (action === "comment") requirePermission(access, ADMIN_PERMISSION.docsInternalRead);
  requirePermission(access, {
    read: ADMIN_PERMISSION.docsInternalRead,
    comment: ADMIN_PERMISSION.docsInternalComment,
    manage: ADMIN_PERMISSION.docsInternalManage,
  }[action]);
  return access;
}

export async function loadNode(client: PoolClient, id: string, forUpdate = false): Promise<DocNodeRow | null> {
  const row = (await client.query<DocNodeRow>(
    `SELECT ${NODE_FIELDS} FROM "zzsh_docs"."doc_node" WHERE "id" = $1${forUpdate ? " FOR UPDATE" : ""}`, [id],
  )).rows[0];
  return row ?? null;
}

/** A live node for read/write; deleted or missing nodes are 404. */
export async function requireLiveNode(client: PoolClient, id: string, forUpdate = false): Promise<DocNodeRow> {
  const node = await loadNode(client, id, forUpdate);
  if (!node) throw notFound();
  if (node.deletedAt) throw notFound({ path: "id", code: "DOC_DELETED" });
  return node;
}

export async function loadVersion(client: PoolClient, versionId: string, forUpdate = false): Promise<DocVersionRow | null> {
  const row = (await client.query<DocVersionRow>(
    `SELECT ${VERSION_FIELDS} FROM "zzsh_docs"."doc_version" WHERE "id" = $1${forUpdate ? " FOR UPDATE" : ""}`, [versionId],
  )).rows[0];
  return row ?? null;
}

async function latestVersion(client: PoolClient, nodeId: string): Promise<DocVersionRow | null> {
  const row = (await client.query<DocVersionRow>(
    `SELECT ${VERSION_FIELDS} FROM "zzsh_docs"."doc_version" WHERE "node_id" = $1 ORDER BY "seq" DESC LIMIT 1`, [nodeId],
  )).rows[0];
  return row ?? null;
}

export async function readNodeDetail(client: PoolClient, id: string): Promise<NodeDetail> {
  const node = await requireLiveNode(client, id);
  const version = node.currentVersionId ? await loadVersion(client, node.currentVersionId) : null;
  return { node, version, revision: node.revision };
}

export async function listTree(client: PoolClient): Promise<DocNodeRow[]> {
  return (await client.query<DocNodeRow>(
    `SELECT ${NODE_FIELDS} FROM "zzsh_docs"."doc_node" WHERE "deleted_at" IS NULL ORDER BY "depth", "parent_id", "sort_key", "id"`,
  )).rows;
}

// --- sort keys -------------------------------------------------------------
// Zero-padded numeric keys (COLLATE "C" keeps byte order == numeric order). A
// large gap allows midpoint inserts; when a gap is exhausted the sibling list is
// renumbered in two phases (temporary unique keys, then final keys) so the partial
// unique index never sees a transient duplicate.
function padKey(value: number): string {
  return String(value).padStart(SORT_WIDTH, "0");
}

type Sibling = { id: string; sortKey: string };

async function allocateSortKey(
  client: PoolClient, parentId: string | null, afterId: string | null, movingId: string,
): Promise<{ key: string; reassign: Sibling[] }> {
  const siblings = (await client.query<Sibling>(
    `SELECT "id", "sort_key" AS "sortKey" FROM "zzsh_docs"."doc_node"
      WHERE "parent_id" IS NOT DISTINCT FROM $1 AND "deleted_at" IS NULL AND "id" <> $2
      ORDER BY "sort_key", "id"`, [parentId, movingId],
  )).rows;
  let index = siblings.length;
  if (afterId !== null) {
    const at = siblings.findIndex(sibling => sibling.id === afterId);
    if (at < 0) throw moveInvalid("afterId is not a sibling of the target parent");
    index = at + 1;
  }
  const prev = index > 0 ? Number(siblings[index - 1]!.sortKey) : null;
  const next = index < siblings.length ? Number(siblings[index]!.sortKey) : null;
  let candidate: number;
  if (prev === null && next === null) candidate = SORT_GAP;
  else if (prev === null) candidate = Math.floor(next! / 2);
  else if (next === null) candidate = prev + SORT_GAP;
  else candidate = Math.floor((prev + next) / 2);
  const fits = prev === null ? candidate >= 1 && candidate < next! : next === null ? true : candidate > prev && candidate < next;
  if (fits) return { key: padKey(candidate), reassign: [] };
  const ordered: Sibling[] = [...siblings.slice(0, index), { id: movingId, sortKey: "" }, ...siblings.slice(index)];
  const reassign: Sibling[] = [];
  let key = "";
  ordered.forEach((sibling, position) => {
    const assigned = padKey((position + 1) * SORT_GAP);
    if (sibling.id === movingId) key = assigned;
    else reassign.push({ id: sibling.id, sortKey: assigned });
  });
  return { key, reassign };
}

async function applyReassign(client: PoolClient, reassign: Sibling[]): Promise<void> {
  if (reassign.length === 0) return;
  for (const sibling of reassign) {
    await client.query(`UPDATE "zzsh_docs"."doc_node" SET "sort_key" = 'tmp_' || "id" WHERE "id" = $1`, [sibling.id]);
  }
  for (const sibling of reassign) {
    await client.query(`UPDATE "zzsh_docs"."doc_node" SET "sort_key" = $2 WHERE "id" = $1`, [sibling.id, sibling.sortKey]);
  }
}

// --- subtree helpers -------------------------------------------------------
async function subtreeIds(client: PoolClient, rootId: string): Promise<string[]> {
  const rows = (await client.query<{ id: string }>(
    `WITH RECURSIVE subtree AS (
       SELECT "id" FROM "zzsh_docs"."doc_node" WHERE "id" = $1
       UNION ALL
       SELECT n."id" FROM "zzsh_docs"."doc_node" n JOIN subtree s ON n."parent_id" = s."id"
     ) SELECT "id" FROM subtree`, [rootId],
  )).rows;
  return rows.map(row => row.id);
}

async function subtreeMaxDepth(client: PoolClient, rootId: string): Promise<number> {
  const row = (await client.query<{ maxDepth: number }>(
    `WITH RECURSIVE subtree AS (
       SELECT "id", "depth" FROM "zzsh_docs"."doc_node" WHERE "id" = $1
       UNION ALL
       SELECT n."id", n."depth" FROM "zzsh_docs"."doc_node" n JOIN subtree s ON n."parent_id" = s."id"
     ) SELECT max("depth") AS "maxDepth" FROM subtree`, [rootId],
  )).rows[0];
  return row?.maxDepth ?? 1;
}

/** Recompute descendant depths top-down after a re-parent (the guard trigger
 *  derives each depth from its already-updated parent). */
async function refreshSubtreeDepths(client: PoolClient, rootId: string): Promise<void> {
  let level = [rootId];
  while (level.length > 0) {
    const children = (await client.query<{ id: string }>(
      `SELECT "id" FROM "zzsh_docs"."doc_node" WHERE "parent_id" = ANY($1::text[])`, [level],
    )).rows.map(row => row.id);
    if (children.length === 0) break;
    await client.query(
      `UPDATE "zzsh_docs"."doc_node" SET "parent_id" = "parent_id" WHERE "id" = ANY($1::text[])`, [children],
    );
    level = children;
  }
}

async function assertParentUsable(client: PoolClient, parentId: string | null, movingId: string, subtreeHeight: number): Promise<number> {
  if (parentId === null) {
    if (subtreeHeight > 3) throw moveInvalid("Document tree exceeds three levels");
    return 1;
  }
  if (parentId === movingId) throw moveInvalid("A document cannot be its own parent");
  const parent = await loadNode(client, parentId);
  if (!parent || parent.deletedAt) throw moveInvalid("Target parent does not exist");
  const descendants = await subtreeIds(client, movingId);
  if (descendants.includes(parentId)) throw moveInvalid("A document cannot move into its own subtree");
  const newDepth = parent.depth + 1;
  if (newDepth + subtreeHeight - 1 > 3) throw moveInvalid("Document tree exceeds three levels");
  return newDepth;
}

// --- node writes -----------------------------------------------------------
export async function createNode(
  client: PoolClient, actor: WriteActor, requestId: string,
  input: { parentId: string | null; title: string; afterId?: string | null },
): Promise<NodeDetail> {
  await authorizeDocs(client, actor, "manage");
  const id = newDocId("doc");
  const newDepth = await assertParentUsable(client, input.parentId, id, 1);
  const { key, reassign } = await allocateSortKey(client, input.parentId, input.afterId ?? null, id);
  await applyReassign(client, reassign);
  const document: PlateDocumentEnvelope = { format: "plate", schemaVersion: 1, preset: "internal", value: [{ type: "p", children: [{ text: "" }] }] };
  const digest = await plateDigest(document);
  const versionId = newDocId("docv");
  await client.query(
    `INSERT INTO "zzsh_docs"."doc_node" ("id", "parent_id", "sort_key", "title", "revision", "created_by_admin_id", "updated_by_admin_id")
     VALUES ($1, $2, $3, $4, 1, $5, $5)`, [id, input.parentId, key, input.title, actor.id],
  );
  await client.query(
    `INSERT INTO "zzsh_docs"."doc_version" ("id", "node_id", "seq", "document", "digest", "kind", "author_admin_id", "window_started_at", "saved_at", "save_count")
     VALUES ($1, $2, 1, $3::jsonb, $4, 'CREATE', $5, now(), now(), 1)`, [versionId, id, JSON.stringify(document), digest, actor.id],
  );
  await client.query(`UPDATE "zzsh_docs"."doc_node" SET "current_version_id" = $2 WHERE "id" = $1`, [id, versionId]);
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "DOC_CREATED",
    objectType: "doc_node", objectId: id, outcome: "SUCCESS", requestId, reason: "docs.internal.manage",
    details: { before: null, after: { id, parentId: input.parentId, depth: newDepth, title: input.title }, result: "CREATED" },
  });
  return readNodeDetail(client, id);
}

export async function renameNode(
  client: PoolClient, actor: WriteActor, requestId: string, id: string, expectedRevision: string, title: string,
): Promise<NodeDetail> {
  await authorizeDocs(client, actor, "manage");
  const node = await requireLiveNode(client, id, true);
  if (node.revision !== expectedRevision) throw versionChanged();
  await client.query(
    `UPDATE "zzsh_docs"."doc_node" SET "title" = $2, "revision" = "revision" + 1, "updated_by_admin_id" = $3, "updated_at" = clock_timestamp() WHERE "id" = $1`,
    [id, title, actor.id],
  );
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "DOC_RENAMED",
    objectType: "doc_node", objectId: id, outcome: "SUCCESS", requestId, reason: "docs.internal.manage",
    details: { before: { title: node.title }, after: { title }, result: "APPLIED" },
  });
  return readNodeDetail(client, id);
}

export async function moveNode(
  client: PoolClient, actor: WriteActor, requestId: string, id: string, expectedRevision: string,
  parentId: string | null, afterId: string | null,
): Promise<{ node: DocNodeRow }> {
  await authorizeDocs(client, actor, "manage");
  const node = await requireLiveNode(client, id, true);
  if (node.revision !== expectedRevision) throw versionChanged();
  const height = await subtreeMaxDepth(client, id) - node.depth + 1;
  await assertParentUsable(client, parentId, id, height);
  // Move into the target partition under a temporary unique key first, so a
  // sibling renumber never collides with this row's old key.
  await client.query(
    `UPDATE "zzsh_docs"."doc_node" SET "parent_id" = $2, "sort_key" = 'tmp_' || "id", "revision" = "revision" + 1, "updated_by_admin_id" = $3, "updated_at" = clock_timestamp() WHERE "id" = $1`,
    [id, parentId, actor.id],
  );
  await refreshSubtreeDepths(client, id);
  const { key, reassign } = await allocateSortKey(client, parentId, afterId, id);
  await applyReassign(client, reassign);
  await client.query(`UPDATE "zzsh_docs"."doc_node" SET "sort_key" = $2 WHERE "id" = $1`, [id, key]);
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "DOC_MOVED",
    objectType: "doc_node", objectId: id, outcome: "SUCCESS", requestId, reason: "docs.internal.manage",
    details: { before: { parentId: node.parentId, sortKey: node.sortKey }, after: { parentId, sortKey: key }, result: "APPLIED" },
  });
  const moved = await requireLiveNode(client, id);
  return { node: moved };
}

export async function deleteNode(
  client: PoolClient, actor: WriteActor, requestId: string, id: string, expectedRevision: string,
): Promise<{ deletedCount: number; batchId: string; purgeAt: Date }> {
  await authorizeDocs(client, actor, "manage");
  const node = await requireLiveNode(client, id, true);
  if (node.revision !== expectedRevision) throw versionChanged();
  const batchId = newDocId("dbatch");
  const ids = await subtreeIds(client, id);
  const deleted = await client.query(
    `UPDATE "zzsh_docs"."doc_node" SET "deleted_at" = clock_timestamp(), "deleted_by_admin_id" = $2, "delete_batch_id" = $3
      WHERE "id" = ANY($1::text[]) AND "deleted_at" IS NULL`, [ids, actor.id, batchId],
  );
  await client.query(
    `UPDATE "zzsh_docs"."doc_node" SET "revision" = "revision" + 1, "updated_by_admin_id" = $2, "updated_at" = clock_timestamp() WHERE "id" = $1`,
    [id, actor.id],
  );
  const purgeAt = new Date(Date.now() + DOC_TRASH_RETENTION_MS);
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "DOC_DELETED",
    objectType: "doc_node", objectId: id, outcome: "SUCCESS", requestId, reason: "docs.internal.manage",
    details: { before: { deletedAt: null }, after: { batchId, deletedCount: deleted.rowCount ?? ids.length, purgeAt: purgeAt.toISOString() }, result: "DELETED" },
  });
  return { deletedCount: deleted.rowCount ?? ids.length, batchId, purgeAt };
}

export type TrashItem = { batchId: string; rootNodeId: string; title: string; deletedAt: Date; deletedBy: string; count: number; purgeAt: Date };

export async function listTrashForActor(client: PoolClient, actor: WriteActor, cursor?: string, limit = 50): Promise<{ items: TrashItem[]; nextCursor: string | null }> {
  await authorizeDocs(client, actor, "read");
  const rows = (await client.query<TrashItem>(
    `SELECT root."delete_batch_id" AS "batchId", root."id" AS "rootNodeId", root."title",
       root."deleted_at" AS "deletedAt", root."deleted_by_admin_id" AS "deletedBy",
       (SELECT count(*)::int FROM "zzsh_docs"."doc_node" c WHERE c."delete_batch_id" = root."delete_batch_id") AS "count",
       root."deleted_at" + interval '30 days' AS "purgeAt"
      FROM "zzsh_docs"."doc_node" root
      WHERE root."deleted_at" IS NOT NULL
        AND (root."parent_id" IS NULL OR NOT EXISTS (
          SELECT 1 FROM "zzsh_docs"."doc_node" p WHERE p."id" = root."parent_id" AND p."delete_batch_id" = root."delete_batch_id"))
        AND ($1::text IS NULL OR root."delete_batch_id" > $1)
      ORDER BY root."delete_batch_id" LIMIT $2`, [cursor ?? null, limit + 1],
  )).rows;
  const page = rows.slice(0, limit);
  return { items: page, nextCursor: rows.length > limit ? page[page.length - 1]!.batchId : null };
}

export async function restoreBatch(
  client: PoolClient, actor: WriteActor, requestId: string, batchId: string, parentId?: string | null,
): Promise<{ node: DocNodeRow }> {
  await authorizeDocs(client, actor, "manage");
  const members = (await client.query<DocNodeRow>(
    `SELECT ${NODE_FIELDS} FROM "zzsh_docs"."doc_node" WHERE "delete_batch_id" = $1 AND "deleted_at" IS NOT NULL ORDER BY "depth" DESC, "id" FOR UPDATE`, [batchId],
  )).rows;
  if (members.length === 0) throw notFound();
  if (members.some(member => !member.currentVersionId)) throw conflict("该批次已进入永久清理，无法恢复");
  const root = members.find(member => !members.some(other => other.id === member.parentId)) ?? members[0]!;
  const targetParent = parentId === undefined ? root.parentId : parentId;
  const height = members.reduce((max, member) => Math.max(max, member.depth), root.depth) - root.depth + 1;
  await assertParentUsable(client, targetParent, root.id, height);
  const ids = members.map(member => member.id);
  await client.query(
    `UPDATE "zzsh_docs"."doc_node" SET "deleted_at" = NULL, "deleted_by_admin_id" = NULL, "delete_batch_id" = NULL WHERE "id" = ANY($1::text[])`, [ids],
  );
  await client.query(
    `UPDATE "zzsh_docs"."doc_node" SET "parent_id" = $2, "sort_key" = 'tmp_' || "id", "revision" = "revision" + 1, "updated_by_admin_id" = $3, "updated_at" = clock_timestamp() WHERE "id" = $1`,
    [root.id, targetParent, actor.id],
  );
  await refreshSubtreeDepths(client, root.id);
  const { key, reassign } = await allocateSortKey(client, targetParent, null, root.id);
  await applyReassign(client, reassign);
  await client.query(`UPDATE "zzsh_docs"."doc_node" SET "sort_key" = $2 WHERE "id" = $1`, [root.id, key]);
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "DOC_UNDELETED",
    objectType: "doc_node", objectId: root.id, outcome: "SUCCESS", requestId, reason: "docs.internal.manage",
    details: { before: { batchId }, after: { parentId: targetParent, restoredCount: ids.length }, result: "RESTORED" },
  });
  const restored = await requireLiveNode(client, root.id);
  return { node: restored };
}

// --- content versions ------------------------------------------------------
async function rewriteVersionImages(client: PoolClient, versionId: string, imageIds: string[]): Promise<void> {
  await client.query(`DELETE FROM "zzsh_docs"."doc_version_image" WHERE "version_id" = $1`, [versionId]);
  for (const imageId of imageIds) {
    await client.query(`INSERT INTO "zzsh_docs"."doc_version_image" ("version_id", "image_id") VALUES ($1, $2)`, [versionId, imageId]);
  }
}

async function assertImagesReady(client: PoolClient, imageIds: string[]): Promise<void> {
  if (imageIds.length === 0) return;
  const ready = (await client.query<{ id: string }>(
    `SELECT "id" FROM "zzsh_docs"."doc_image" WHERE "id" = ANY($1::text[]) AND "status" = 'READY'`, [imageIds],
  )).rows.map(row => row.id);
  const readySet = new Set(ready);
  if (imageIds.some(imageId => !readySet.has(imageId))) {
    throw new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "Document references an image that is not ready", [{ path: "reason", code: "INVALID_FIELD" }]);
  }
}

export async function saveContent(
  client: PoolClient, actor: WriteActor, id: string, expectedRevision: string, document: unknown, now: Date,
): Promise<{ revision: string; versionId: string; seq: number; merged: boolean; savedAt: Date; orphanedDiscussionIds: string[] }> {
  await authorizeDocs(client, actor, "manage");
  const node = await requireLiveNode(client, id, true);
  if (node.revision !== expectedRevision) throw versionChanged();
  const checked = validatePlateDocument(document, { preset: "internal", mode: "draft" });
  if (!checked.ok) throw plateInvalid(checked.errors);
  const envelope = document as PlateDocumentEnvelope;
  const { imageIds, commentIds } = extractPlate(envelope);
  await assertImagesReady(client, imageIds);
  // P1b reconciliation: OPEN anchors follow the saved text; unregistered marks
  // are stripped (with a warning) and resolved discussions never stay highlighted.
  const reconciled = await reconcileDiscussionMarks(client, id, envelope, commentIds);
  const saved = reconciled.document;
  const digest = await plateDigest(saved);
  const latest = await latestVersion(client, id);
  const mergeable = latest !== null && latest.kind === "EDIT" && latest.authorAdminId === actor.id
    && now.getTime() - latest.windowStartedAt.getTime() <= DOC_MERGE_WINDOW_MS;
  let versionId: string;
  let seq: number;
  if (mergeable && latest) {
    versionId = latest.id;
    seq = latest.seq;
    await client.query(
      `UPDATE "zzsh_docs"."doc_version" SET "document" = $2::jsonb, "digest" = $3, "saved_at" = $4, "save_count" = "save_count" + 1 WHERE "id" = $1`,
      [versionId, JSON.stringify(saved), digest, now],
    );
  } else {
    versionId = newDocId("docv");
    seq = (latest?.seq ?? 0) + 1;
    await client.query(
      `INSERT INTO "zzsh_docs"."doc_version" ("id", "node_id", "seq", "document", "digest", "kind", "author_admin_id", "window_started_at", "saved_at", "save_count")
       VALUES ($1, $2, $3, $4::jsonb, $5, 'EDIT', $6, $7, $7, 1)`,
      [versionId, id, seq, JSON.stringify(saved), digest, actor.id, now],
    );
  }
  await rewriteVersionImages(client, versionId, imageIds);
  const updated = await client.query<{ revision: string }>(
    `UPDATE "zzsh_docs"."doc_node" SET "current_version_id" = $2, "revision" = "revision" + 1, "updated_by_admin_id" = $3, "updated_at" = $4 WHERE "id" = $1 RETURNING "revision"::text AS "revision"`,
    [id, versionId, actor.id, now],
  );
  // Auto-saves are not audited per save (requirements P1 权限与审计).
  return { revision: updated.rows[0]!.revision, versionId, seq, merged: mergeable, savedAt: now, orphanedDiscussionIds: reconciled.orphanedDiscussionIds };
}

export async function listVersions(client: PoolClient, id: string, cursor?: string, limit = 50): Promise<{ items: Omit<DocVersionRow, "document">[]; nextCursor: string | null }> {
  await requireLiveNode(client, id);
  const rows = (await client.query<Omit<DocVersionRow, "document">>(
    `SELECT ${VERSION_METADATA_FIELDS} FROM "zzsh_docs"."doc_version"
       WHERE "node_id" = $1 AND ($2::text IS NULL OR "seq" < (
         SELECT "seq" FROM "zzsh_docs"."doc_version" WHERE "node_id" = $1 AND "id" = $2
       )) ORDER BY "seq" DESC LIMIT $3`,
    [id, cursor ?? null, limit + 1],
  )).rows;
  const page = rows.slice(0, limit);
  return { items: page, nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
}

export async function readVersion(client: PoolClient, id: string, versionId: string): Promise<DocVersionRow> {
  await requireLiveNode(client, id);
  const version = await loadVersion(client, versionId);
  if (!version || version.nodeId !== id) throw notFound();
  return version;
}

export async function restoreVersion(
  client: PoolClient, actor: WriteActor, requestId: string, id: string, expectedRevision: string, versionId: string,
): Promise<NodeDetail> {
  await authorizeDocs(client, actor, "manage");
  const node = await requireLiveNode(client, id, true);
  if (node.revision !== expectedRevision) throw versionChanged();
  const source = await loadVersion(client, versionId);
  if (!source || source.nodeId !== id) throw notFound();
  const latest = await latestVersion(client, id);
  const seq = (latest?.seq ?? 0) + 1;
  const newVersionId = newDocId("docv");
  const { imageIds, commentIds } = extractPlate(source.document);
  await assertImagesReady(client, imageIds);
  const { document } = await reconcileDiscussionMarks(client, id, source.document, commentIds);
  const digest = await plateDigest(document);
  await client.query(
    `INSERT INTO "zzsh_docs"."doc_version" ("id", "node_id", "seq", "document", "digest", "kind", "author_admin_id", "window_started_at", "saved_at", "save_count", "restored_from_version_id")
     VALUES ($1, $2, $3, $4::jsonb, $5, 'RESTORE', $6, now(), now(), 1, $7)`,
    [newVersionId, id, seq, JSON.stringify(document), digest, actor.id, versionId],
  );
  await rewriteVersionImages(client, newVersionId, imageIds);
  await client.query(
    `UPDATE "zzsh_docs"."doc_node" SET "current_version_id" = $2, "revision" = "revision" + 1, "updated_by_admin_id" = $3, "updated_at" = clock_timestamp() WHERE "id" = $1`,
    [id, newVersionId, actor.id],
  );
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "DOC_VERSION_RESTORED",
    objectType: "doc_node", objectId: id, outcome: "SUCCESS", requestId, reason: "docs.internal.manage",
    details: { before: { currentVersionId: node.currentVersionId }, after: { currentVersionId: newVersionId, restoredFromVersionId: versionId, seq }, result: "RESTORED" },
  });
  return readNodeDetail(client, id);
}

// --- search ----------------------------------------------------------------
export async function searchNodes(
  client: PoolClient, actor: WriteActor,
  query: { q?: string; parentId?: string | null; updatedBy?: string; updatedFrom?: Date; updatedTo?: Date; cursor?: string; limit?: number },
): Promise<{ items: DocNodeRow[]; nextCursor: string | null }> {
  await authorizeDocs(client, actor, "read");
  const limit = query.limit ?? 50;
  const conditions = [`"deleted_at" IS NULL`];
  const params: unknown[] = [];
  if (query.q !== undefined && query.q !== "") {
    params.push(`%${query.q.toLowerCase()}%`);
    conditions.push(`lower("title") LIKE $${params.length}`);
  }
  if (query.parentId !== undefined) {
    if (query.parentId === null) conditions.push(`"parent_id" IS NULL`);
    else { params.push(query.parentId); conditions.push(`"parent_id" = $${params.length}`); }
  }
  if (query.updatedBy !== undefined) { params.push(query.updatedBy); conditions.push(`"updated_by_admin_id" = $${params.length}`); }
  if (query.updatedFrom !== undefined) { params.push(query.updatedFrom); conditions.push(`"updated_at" >= $${params.length}`); }
  if (query.updatedTo !== undefined) { params.push(query.updatedTo); conditions.push(`"updated_at" <= $${params.length}`); }
  if (query.cursor !== undefined) { params.push(query.cursor); conditions.push(`"id" > $${params.length}`); }
  params.push(limit + 1);
  const rows = (await client.query<DocNodeRow>(
    `SELECT ${NODE_FIELDS} FROM "zzsh_docs"."doc_node" WHERE ${conditions.join(" AND ")} ORDER BY "id" LIMIT $${params.length}`, params,
  )).rows;
  const page = rows.slice(0, limit);
  return { items: page, nextCursor: rows.length > limit ? page[page.length - 1]!.id : null };
}

// --- images ----------------------------------------------------------------
export async function createImageRecord(
  client: PoolClient, actor: WriteActor, requestId: string, nodeId: string,
  input: { mime: ImageMime; bytes: number; width: number; height: number }, now: Date,
): Promise<{ image: DocImageRow; uploadExpiresAt: Date }> {
  await authorizeDocs(client, actor, "manage");
  await requireLiveNode(client, nodeId);
  if (!ALLOWED_IMAGE_MIMES.includes(input.mime)) throw invalid("Image MIME is not allowed");
  try {
    assertImageWithinBounds({ mime: input.mime, width: input.width, height: input.height }, input.bytes);
  } catch {
    throw invalid("Image dimensions or size are outside the allowed range");
  }
  const id = newDocId("dimg");
  const objectKey = docsImageObjectKey(nodeId, id, input.mime);
  const uploadExpiresAt = new Date(now.getTime() + 5 * 60 * 1000);
  const image = (await client.query<DocImageRow>(
    `INSERT INTO "zzsh_docs"."doc_image" ("id", "uploaded_in_node_id", "object_key", "mime", "bytes", "width", "height", "status", "uploaded_by_admin_id", "upload_expires_at")
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'PENDING', $8, $9) RETURNING ${IMAGE_FIELDS}`,
    [id, nodeId, objectKey, input.mime, input.bytes, input.width, input.height, actor.id, uploadExpiresAt],
  )).rows[0]!;
  return { image, uploadExpiresAt };
}

export async function loadImage(client: PoolClient, imageId: string, forUpdate = false): Promise<DocImageRow | null> {
  const row = (await client.query<DocImageRow>(
    `SELECT ${IMAGE_FIELDS} FROM "zzsh_docs"."doc_image" WHERE "id" = $1${forUpdate ? " FOR UPDATE" : ""}`, [imageId],
  )).rows[0];
  return row ?? null;
}

export async function completeImageRecord(
  client: PoolClient, actor: WriteActor, requestId: string, imageId: string,
): Promise<DocImageRow> {
  await authorizeDocs(client, actor, "manage");
  const image = await loadImage(client, imageId, true);
  if (!image || image.uploadedByAdminId !== actor.id) throw notFound();
  if (image.status !== "PENDING") throw invalid("Image is not pending");
  await requireLiveNode(client, image.uploadedInNodeId);
  const completed = (await client.query<DocImageRow>(
    `UPDATE "zzsh_docs"."doc_image" SET "status" = 'READY', "completed_at" = clock_timestamp() WHERE "id" = $1 RETURNING ${IMAGE_FIELDS}`, [imageId],
  )).rows[0]!;
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "DOC_IMAGE_UPLOADED",
    objectType: "doc_image", objectId: imageId, outcome: "SUCCESS", requestId, reason: "docs.internal.manage",
    details: { before: { status: image.status }, after: { status: "READY", nodeId: image.uploadedInNodeId, bytes: image.bytes, mime: image.mime }, result: "CREATED" },
  });
  return completed;
}

/** Images referenced by the current or any historical version of this node. */
export async function signableImages(client: PoolClient, nodeId: string, imageIds: string[]): Promise<DocImageRow[]> {
  if (imageIds.length === 0) return [];
  return (await client.query<DocImageRow>(
    `SELECT i."id", i."uploaded_in_node_id" AS "uploadedInNodeId", i."object_key" AS "objectKey",
       i."mime", i."bytes", i."width", i."height", i."status", i."uploaded_by_admin_id" AS "uploadedByAdminId",
       i."created_at" AS "createdAt", i."upload_expires_at" AS "uploadExpiresAt", i."completed_at" AS "completedAt"
      FROM "zzsh_docs"."doc_image" i
      WHERE i."id" = ANY($1::text[]) AND i."status" = 'READY'
        AND EXISTS (SELECT 1 FROM "zzsh_docs"."doc_version_image" vi
          JOIN "zzsh_docs"."doc_version" v ON v."id" = vi."version_id"
          WHERE vi."image_id" = i."id" AND v."node_id" = $2)`, [imageIds, nodeId],
  )).rows;
}

/** The view gate: an image referenced by at least one document version. */
export async function imageReferenced(client: PoolClient, imageId: string): Promise<boolean> {
  const row = (await client.query<{ present: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM "zzsh_docs"."doc_version_image" WHERE "image_id" = $1) AS "present"`, [imageId],
  )).rows[0];
  return row?.present === true;
}

// --- P1b selection comments --------------------------------------------------
// Marks are comment_<discussionId> boolean leaves (internal preset only). The
// projection below mirrors extractPlate().plainText exactly so a client selection
// can be located server-side; ANNOTATE versions carry mark changes and never bump
// doc_node.revision (0197 reserves the kind for this purpose).

/** Leaf offsets in the extractPlate plain-text projection. */
function commentLeafPositions(value: PlateNode[]): { path: string; start: number; end: number }[] {
  const positions: { path: string; start: number; end: number }[] = [];
  let cursor = 0;
  const walk = (node: PlateNode, path: number[]): void => {
    if (typeof node.text === "string") {
      positions.push({ path: path.join(","), start: cursor, end: cursor + node.text.length });
      cursor += node.text.length;
      return;
    }
    if (node.type === "img") { cursor += typeof node.alt === "string" ? node.alt.length : 0; return; }
    if (node.type === "hr" || node.type === "toc") return;
    const separator = node.type === "tr" ? "\t"
      : node.type === "p" || node.type === "h2" || node.type === "h3" || node.type === "h4" || node.type === "code_line" || node.type === "a" ? ""
      : "\n";
    (node.children ?? []).forEach((child, index) => {
      if (index > 0) cursor += separator.length;
      walk(child, [...path, index]);
    });
  };
  value.forEach((node, index) => {
    if (index > 0) cursor += 1; // top-level blocks join with "\n"
    walk(node, [index]);
  });
  return positions;
}

/** Mark the selected occurrence, or the first match for older callers. */
export function applyCommentMark(document: PlateDocumentEnvelope, discussionId: string, anchorText: string, anchorOffset?: number): PlateDocumentEnvelope | null {
  if (anchorText.length === 0) return null;
  const plain = extractPlate(document).plainText;
  const at = anchorOffset ?? plain.indexOf(anchorText);
  if (at < 0 || plain.slice(at, at + anchorText.length) !== anchorText) return null;
  const start = at;
  const end = at + anchorText.length;
  const byPath = new Map(commentLeafPositions(document.value).map(position => [position.path, position]));
  const key = `comment_${discussionId}`;
  let marked = false;
  const mapLeaves = (nodes: PlateNode[], path: number[]): PlateNode[] => nodes.flatMap((node, index) => {
    const childPath = [...path, index];
    if (typeof node.text === "string") {
      const position = byPath.get(childPath.join(","));
      if (!position) return [node];
      const from = Math.max(position.start, start);
      const to = Math.min(position.end, end);
      if (from >= to) return [node];
      marked = true;
      const localFrom = from - position.start;
      const localTo = to - position.start;
      const { text, ...marks } = node;
      const out: PlateNode[] = [];
      if (localFrom > 0) out.push({ ...marks, text: text.slice(0, localFrom) });
      out.push({ ...marks, [key]: true, text: text.slice(localFrom, localTo) });
      if (localTo < text.length) out.push({ ...marks, text: text.slice(localTo) });
      return out;
    }
    if (!node.children) return [node];
    return [{ ...node, children: mapLeaves(node.children, childPath) }];
  });
  const value = mapLeaves(document.value, []);
  return marked ? { ...document, value } : null;
}

/** Strip the given comment_<id> marks, keeping every other mark and the text. */
export function removeCommentMarks(value: PlateNode[], ids: ReadonlySet<string>): PlateNode[] {
  if (ids.size === 0) return value;
  const keys = new Set([...ids].map(id => `comment_${id}`));
  const walk = (node: PlateNode): PlateNode => {
    if (typeof node.text === "string") {
      if (!Object.keys(node).some(key => keys.has(key))) return node;
      const out: PlateNode = { ...node };
      for (const key of keys) delete out[key];
      return out;
    }
    if (!node.children) return node;
    return { ...node, children: node.children.map(walk) };
  };
  return value.map(walk);
}

async function reconcileDiscussionMarks(
  client: PoolClient, nodeId: string, envelope: PlateDocumentEnvelope, commentIds: string[],
): Promise<{ document: PlateDocumentEnvelope; orphanedDiscussionIds: string[] }> {
  const rows = (await client.query<DocDiscussionRow>(
    `SELECT ${DISCUSSION_FIELDS} FROM "zzsh_docs"."doc_discussion" WHERE "node_id" = $1 ORDER BY "created_at", "id"`, [nodeId],
  )).rows;
  const byId = new Map(rows.map(row => [row.id, row]));
  const present = new Set(commentIds);
  const unregistered = [...present].filter(id => !byId.has(id));
  const resolvedMarks = [...present].filter(id => byId.get(id)?.status === "RESOLVED");
  const strip = new Set([...unregistered, ...resolvedMarks]);
  let document = envelope;
  if (strip.size > 0) {
    document = { ...envelope, value: removeCommentMarks(envelope.value, strip) };
    if (unregistered.length > 0) {
      try { console.warn(JSON.stringify({ event: "docs.discussion.unregistered_mark", nodeId, discussionIds: unregistered })); } catch { /* logging must not block a save */ }
    }
  }
  const orphanedDiscussionIds: string[] = [];
  for (const row of rows) {
    if (row.status !== "OPEN") continue;
    const state = present.has(row.id) ? "PRESENT" : "ORPHANED";
    if (state === "ORPHANED") orphanedDiscussionIds.push(row.id);
    if (state !== row.anchorState) {
      await client.query(`UPDATE "zzsh_docs"."doc_discussion" SET "anchor_state" = $2 WHERE "id" = $1`, [row.id, state]);
    }
  }
  return { document, orphanedDiscussionIds };
}

async function loadDiscussion(client: PoolClient, id: string, forUpdate = false): Promise<DocDiscussionRow | null> {
  const row = (await client.query<DocDiscussionRow>(
    `SELECT ${DISCUSSION_FIELDS} FROM "zzsh_docs"."doc_discussion" WHERE "id" = $1${forUpdate ? " FOR UPDATE" : ""}`, [id],
  )).rows[0];
  return row ?? null;
}

async function loadComment(client: PoolClient, id: string, forUpdate = false): Promise<DocCommentRow | null> {
  const row = (await client.query<DocCommentRow>(
    `SELECT ${COMMENT_FIELDS} FROM "zzsh_docs"."doc_comment" WHERE "id" = $1${forUpdate ? " FOR UPDATE" : ""}`, [id],
  )).rows[0];
  return row ?? null;
}

async function listCommentsFor(client: PoolClient, discussionIds: string[]): Promise<DocCommentRow[]> {
  if (discussionIds.length === 0) return [];
  return (await client.query<DocCommentRow>(
    `SELECT ${COMMENT_FIELDS} FROM "zzsh_docs"."doc_comment" WHERE "discussion_id" = ANY($1::text[]) ORDER BY "created_at", "id"`, [discussionIds],
  )).rows;
}

async function insertComment(client: PoolClient, discussionId: string, body: string, authorAdminId: string): Promise<DocCommentRow> {
  const id = newDocId("dcm");
  return (await client.query<DocCommentRow>(
    `INSERT INTO "zzsh_docs"."doc_comment" ("id", "discussion_id", "body", "author_admin_id") VALUES ($1, $2, $3, $4) RETURNING ${COMMENT_FIELDS}`,
    [id, discussionId, body, authorAdminId],
  )).rows[0]!;
}

/** Append an ANNOTATE version and point the node at it WITHOUT bumping revision. */
async function appendAnnotateVersion(
  client: PoolClient, node: DocNodeRow, document: PlateDocumentEnvelope, authorAdminId: string, now: Date,
): Promise<{ id: string; seq: number }> {
  const latest = await latestVersion(client, node.id);
  const seq = (latest?.seq ?? 0) + 1;
  const id = newDocId("docv");
  const digest = await plateDigest(document);
  await client.query(
    `INSERT INTO "zzsh_docs"."doc_version" ("id", "node_id", "seq", "document", "digest", "kind", "author_admin_id", "window_started_at", "saved_at", "save_count")
     VALUES ($1, $2, $3, $4::jsonb, $5, 'ANNOTATE', $6, $7, $7, 1)`,
    [id, node.id, seq, JSON.stringify(document), digest, authorAdminId, now],
  );
  await rewriteVersionImages(client, id, extractPlate(document).imageIds);
  await client.query(`UPDATE "zzsh_docs"."doc_node" SET "current_version_id" = $2 WHERE "id" = $1`, [node.id, id]);
  return { id, seq };
}

async function currentDocument(client: PoolClient, node: DocNodeRow): Promise<PlateDocumentEnvelope> {
  const version = node.currentVersionId ? await loadVersion(client, node.currentVersionId) : null;
  if (!version) throw notFound();
  return version.document;
}

export async function listDiscussions(
  client: PoolClient, actor: WriteActor, nodeId: string, status?: "OPEN" | "RESOLVED",
): Promise<DiscussionWithComments[]> {
  await authorizeDocs(client, actor, "read");
  await requireLiveNode(client, nodeId);
  const rows = (await client.query<DocDiscussionRow>(
    `SELECT ${DISCUSSION_FIELDS} FROM "zzsh_docs"."doc_discussion" WHERE "node_id" = $1 AND ($2::text IS NULL OR "status" = $2) ORDER BY "created_at", "id"`,
    [nodeId, status ?? null],
  )).rows;
  const comments = await listCommentsFor(client, rows.map(row => row.id));
  return rows.map(row => ({ ...row, comments: comments.filter(comment => comment.discussionId === row.id) }));
}

export async function createDiscussion(
  client: PoolClient, actor: WriteActor, nodeId: string,
  input: { discussionId: string; anchorText: string; anchorOffset?: number; expectedRevision?: string; body: string }, now: Date,
): Promise<DiscussionWriteResult> {
  await authorizeDocs(client, actor, "comment");
  const node = await requireLiveNode(client, nodeId, true);
  if (!/^dsc_[0-9a-f]{32}$/.test(input.discussionId)) throw invalid("discussionId must be dsc_ followed by a uuid", "discussionId");
  if (input.expectedRevision !== undefined && input.expectedRevision !== node.revision) throw versionChanged();
  const document = await currentDocument(client, node);
  const marked = applyCommentMark(document, input.discussionId, input.anchorText, input.anchorOffset);
  if (!marked) throw invalid("Anchor text was not found in the current document", "anchorText");
  const inserted = await client.query(
    `INSERT INTO "zzsh_docs"."doc_discussion" ("id", "node_id", "anchor_text", "status", "anchor_state", "created_by_admin_id")
     VALUES ($1, $2, $3, 'OPEN', 'PRESENT', $4) ON CONFLICT ("id") DO NOTHING`,
    [input.discussionId, nodeId, input.anchorText, actor.id],
  );
  if (inserted.rowCount === 0) throw conflict("Discussion already exists");
  const comment = await insertComment(client, input.discussionId, input.body, actor.id);
  const annotated = await appendAnnotateVersion(client, node, marked, actor.id, now);
  const discussion: DiscussionWithComments = {
    id: input.discussionId, nodeId, anchorText: input.anchorText, status: "OPEN", anchorState: "PRESENT",
    createdByAdminId: actor.id, createdAt: now, resolvedByAdminId: null, resolvedAt: null, comments: [comment],
  };
  return { discussion, versionId: annotated.id, seq: annotated.seq, document: marked, revision: node.revision };
}

export async function addComment(
  client: PoolClient, actor: WriteActor, discussionId: string, body: string,
): Promise<DocCommentRow> {
  await authorizeDocs(client, actor, "comment");
  const discussion = await loadDiscussion(client, discussionId);
  if (!discussion) throw notFound();
  await requireLiveNode(client, discussion.nodeId);
  return insertComment(client, discussionId, body, actor.id);
}

async function requireOwnComment(client: PoolClient, actor: WriteActor, commentId: string): Promise<{ comment: DocCommentRow; discussion: DocDiscussionRow }> {
  const comment = await loadComment(client, commentId, true);
  if (!comment || comment.deletedAt) throw notFound();
  if (comment.authorAdminId !== actor.id) throw forbidden("Only the author may change this reply");
  const discussion = await loadDiscussion(client, comment.discussionId);
  if (!discussion) throw notFound();
  await requireLiveNode(client, discussion.nodeId);
  return { comment, discussion };
}

export async function editComment(
  client: PoolClient, actor: WriteActor, commentId: string, body: string, now: Date,
): Promise<DocCommentRow> {
  await authorizeDocs(client, actor, "comment");
  await requireOwnComment(client, actor, commentId);
  return (await client.query<DocCommentRow>(
    `UPDATE "zzsh_docs"."doc_comment" SET "body" = $2, "edited_at" = $3 WHERE "id" = $1 RETURNING ${COMMENT_FIELDS}`,
    [commentId, body, now],
  )).rows[0]!;
}

export async function deleteComment(
  client: PoolClient, actor: WriteActor, requestId: string, commentId: string, now: Date,
): Promise<DocCommentRow> {
  await authorizeDocs(client, actor, "comment");
  const { comment } = await requireOwnComment(client, actor, commentId);
  const deleted = (await client.query<DocCommentRow>(
    `UPDATE "zzsh_docs"."doc_comment" SET "deleted_at" = $2 WHERE "id" = $1 RETURNING ${COMMENT_FIELDS}`,
    [commentId, now],
  )).rows[0]!;
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "DOC_COMMENT_DELETED",
    objectType: "doc_comment", objectId: commentId, outcome: "SUCCESS", requestId, reason: "docs.internal.comment",
    details: { before: { deletedAt: null }, after: { deletedAt: now.toISOString(), discussionId: comment.discussionId }, result: "DELETED" },
  });
  return deleted;
}

export async function resolveDiscussion(
  client: PoolClient, actor: WriteActor, requestId: string, discussionId: string, now: Date,
): Promise<DiscussionWriteResult> {
  await authorizeDocs(client, actor, "comment");
  const discussion = await loadDiscussion(client, discussionId, true);
  if (!discussion) throw notFound();
  if (discussion.status === "RESOLVED") throw conflict("Discussion is already resolved");
  const node = await requireLiveNode(client, discussion.nodeId, true);
  const current = await currentDocument(client, node);
  const document: PlateDocumentEnvelope = { ...current, value: removeCommentMarks(current.value, new Set([discussionId])) };
  const resolved = (await client.query<DocDiscussionRow>(
    `UPDATE "zzsh_docs"."doc_discussion" SET "status" = 'RESOLVED', "resolved_by_admin_id" = $2, "resolved_at" = $3 WHERE "id" = $1 RETURNING ${DISCUSSION_FIELDS}`,
    [discussionId, actor.id, now],
  )).rows[0]!;
  const annotated = await appendAnnotateVersion(client, node, document, actor.id, now);
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "DOC_DISCUSSION_RESOLVED",
    objectType: "doc_discussion", objectId: discussionId, outcome: "SUCCESS", requestId, reason: "docs.internal.comment",
    details: { before: { status: discussion.status }, after: { status: "RESOLVED", nodeId: node.id, versionId: annotated.id }, result: "APPLIED" },
  });
  const comments = await listCommentsFor(client, [discussionId]);
  return { discussion: { ...resolved, comments }, versionId: annotated.id, seq: annotated.seq, document, revision: node.revision };
}

export async function reopenDiscussion(
  client: PoolClient, actor: WriteActor, requestId: string, discussionId: string,
): Promise<DiscussionWithComments> {
  await authorizeDocs(client, actor, "comment");
  const discussion = await loadDiscussion(client, discussionId, true);
  if (!discussion) throw notFound();
  if (discussion.status === "OPEN") throw conflict("Discussion is already open");
  await requireLiveNode(client, discussion.nodeId);
  // Reopening never restores the highlight: the mark stays removed, so the anchor
  // is ORPHANED until a later save finds it again (e.g. after a rollback).
  const reopened = (await client.query<DocDiscussionRow>(
    `UPDATE "zzsh_docs"."doc_discussion" SET "status" = 'OPEN', "resolved_by_admin_id" = NULL, "resolved_at" = NULL, "anchor_state" = 'ORPHANED' WHERE "id" = $1 RETURNING ${DISCUSSION_FIELDS}`,
    [discussionId],
  )).rows[0]!;
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "DOC_DISCUSSION_REOPENED",
    objectType: "doc_discussion", objectId: discussionId, outcome: "SUCCESS", requestId, reason: "docs.internal.comment",
    details: { before: { status: discussion.status }, after: { status: "OPEN", nodeId: discussion.nodeId }, result: "APPLIED" },
  });
  const comments = await listCommentsFor(client, [discussionId]);
  return { ...reopened, comments };
}