import { randomUUID } from "node:crypto";
import type { PoolClient } from "pg";
import { projectLegacyResource } from "@zzsh/content/legacy-plate";
import { extractPlate, type PlateDocumentEnvelope } from "@zzsh/content/plate";

import { ADMIN_PERMISSION, hasPermission, requirePermission, type EffectiveAdminAccess } from "../auth/admin-authorization";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { requireAdminAccess, type WriteActor } from "../supply/supply-routes";
import { invalid, notFound } from "../supply/supply-util";
import { checkedResource, createContentDraftFromLatest, createContentItem, loadContentItem, publishContentVersion, restoreContentDraft, withdrawContentVersion } from "./content";
import { loadResourceItem, lockManagedResource } from "./managed-content";

export const HELP_TRASH_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const SORT_WIDTH = 16;
const SORT_GAP = 1_000_000;
const HELP_CATEGORIES = ["rental", "publish", "fees", "account", "after-sale", "membership", "agreement"] as const;
const HELP_ICONS = new Set<string>([...HELP_CATEGORIES, "folder", "book", "shield"]);

export function helpIconKey(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== "string" || !HELP_ICONS.has(value)) throw invalid("帮助分组图标无效", "iconKey");
  return value;
}

export type HelpTreeNodeRow = {
  id: string;
  parentId: string | null;
  depth: number;
  kind: "FOLDER" | "ARTICLE";
  title: string | null;
  description: string | null;
  iconKey: string | null;
  resourceKey: string | null;
  sortKey: string;
  revision: string;
  createdByAdminId: string | null;
  updatedByAdminId: string | null;
  source?: "SYSTEM_INITIAL" | null;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
  deletedByAdminId: string | null;
  deleteBatchId: string | null;
  preDeleteState: "PUBLISHED" | "DRAFT_ONLY" | null;
};

const NODE_FIELDS = `"id", "parent_id" AS "parentId", "depth", "kind", "title", "description", "icon_key" AS "iconKey",
  "resource_key" AS "resourceKey", "sort_key" AS "sortKey", "revision"::text AS "revision",
  CASE WHEN to_jsonb(help_tree_node)->>'system_initial_sha256' IS NULL THEN "created_by_admin_id" END AS "createdByAdminId",
  CASE WHEN to_jsonb(help_tree_node)->>'system_initial_sha256' IS NULL OR revision>1 THEN "updated_by_admin_id" END AS "updatedByAdminId",
  CASE WHEN to_jsonb(help_tree_node)->>'system_initial_sha256' IS NOT NULL THEN 'SYSTEM_INITIAL' END AS source,
  "created_at" AS "createdAt", "updated_at" AS "updatedAt", "deleted_at" AS "deletedAt",
  "deleted_by_admin_id" AS "deletedByAdminId", "delete_batch_id" AS "deleteBatchId", "pre_delete_state" AS "preDeleteState"`;

export function newHelpId(prefix: "htn" | "hbatch"): string {
  return `${prefix}_${randomUUID().replaceAll("-", "")}`;
}

function versionChanged(): SecurityApiError {
  return new SecurityApiError(409, API_V1_ERROR_CODES.VERSION_CHANGED, "别人刚改过，刷新后再改");
}
function moveInvalid(message = "Move is not allowed"): SecurityApiError {
  return new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, message, [{ path: "reason", code: "MOVE_INVALID" }]);
}
function slugRetired(): SecurityApiError {
  return new SecurityApiError(400, API_V1_ERROR_CODES.INVALID_ARGUMENT, "该地址已下线，不可复用", [{ path: "slug", code: "SLUG_RETIRED" }]);
}

export async function authorizeHelp(client: PoolClient, actor: WriteActor, action: "read" | "edit" | "publish"): Promise<EffectiveAdminAccess> {
  const access = await requireAdminAccess(client, actor.id);
  const narrowPermission = action === "read" ? ADMIN_PERMISSION.contentHelpRead : action === "publish" ? ADMIN_PERMISSION.contentHelpPublish : null;
  if (!narrowPermission || !hasPermission(access, narrowPermission)) {
    requirePermission(access, {
      read: ADMIN_PERMISSION.contentPlatformRead,
      edit: ADMIN_PERMISSION.contentPlatformEdit,
      publish: ADMIN_PERMISSION.contentPlatformPublish,
    }[action]);
  }
  return access;
}

export async function loadHelpNode(client: PoolClient, id: string, forUpdate = false): Promise<HelpTreeNodeRow | null> {
  const row = (await client.query<HelpTreeNodeRow>(
    `SELECT ${NODE_FIELDS} FROM "zzsh_content"."help_tree_node" WHERE "id" = $1${forUpdate ? " FOR UPDATE" : ""}`, [id],
  )).rows[0];
  return row ?? null;
}

async function requireLiveHelpNode(client: PoolClient, id: string, forUpdate = false): Promise<HelpTreeNodeRow> {
  const node = await loadHelpNode(client, id, forUpdate);
  if (!node || node.deletedAt) throw notFound();
  return node;
}

/** Admin tree: every live node, ordered for display. */
export async function listHelpTree(client: PoolClient): Promise<HelpTreeNodeRow[]> {
  return (await client.query<HelpTreeNodeRow>(
    `SELECT ${NODE_FIELDS} FROM "zzsh_content"."help_tree_node" WHERE "deleted_at" IS NULL ORDER BY "depth", "parent_id", "sort_key", "id"`,
  )).rows;
}

type AdminHelpNode = HelpTreeNodeRow & { published: boolean; hasDraft: boolean; withdrawn: boolean };

export async function listAdminHelpTree(client: PoolClient, publishedOnly: boolean): Promise<AdminHelpNode[]> {
  const nodes = await listHelpTree(client);
  const keys = nodes.flatMap(node => node.resourceKey === null ? [] : [node.resourceKey]);
  const versions = keys.length ? (await client.query<{ resourceKey: string; title: string; state: string }>(
    `SELECT DISTINCT ON (i."resource_key", v."state") i."resource_key" AS "resourceKey", v."title", v."state"
       FROM "zzsh_content"."content_item" i
       JOIN "zzsh_content"."content_version" v ON v."item_id" = i."id"
      WHERE i."type" = 'RESOURCE' AND i."game_id" IS NULL AND i."resource_key" = ANY($1::text[])
        AND (v."state" = 'PUBLISHED' OR NOT $2::boolean)
      ORDER BY i."resource_key", v."state", v."sequence" DESC`, [keys, publishedOnly],
  )).rows : [];
  const titlesByState = (state: string) => new Map(versions.filter(row => row.state === state).map(row => [row.resourceKey, row.title]));
  const published = titlesByState("PUBLISHED");
  const drafts = titlesByState("DRAFT");
  const withdrawn = titlesByState("WITHDRAWN");
  const visible = new Set<string>();
  if (publishedOnly) {
    const byId = new Map(nodes.map(node => [node.id, node]));
    for (const node of nodes) {
      if (!node.resourceKey || !published.has(node.resourceKey)) continue;
      let cursor: HelpTreeNodeRow | undefined = node;
      while (cursor && !visible.has(cursor.id)) {
        visible.add(cursor.id);
        cursor = cursor.parentId ? byId.get(cursor.parentId) : undefined;
      }
    }
  }
  return nodes.filter(node => !publishedOnly || visible.has(node.id)).map(node => {
    const key = node.resourceKey;
    return {
      ...node,
      title: key ? drafts.get(key) ?? published.get(key) ?? withdrawn.get(key) ?? node.title : node.title,
      published: key !== null && published.has(key),
      hasDraft: key !== null && drafts.has(key),
      withdrawn: key !== null && withdrawn.has(key),
    };
  });
}

export type PublicHelpNode = Pick<HelpTreeNodeRow, "id" | "parentId" | "kind" | "depth" | "sortKey" | "iconKey" | "description"> & {
  title: string;
  slug: string | null;
};

/** Public directory includes live platform branches and the existing game guides. */
export async function publicHelpTree(client: PoolClient): Promise<PublicHelpNode[]> {
  const nodes = await listAdminHelpTree(client, true);
  const gameGuides = (await client.query<{ id: string; slug: string; title: string; category: string }>(
    `SELECT i."id", substr(i."resource_key", 7) AS "slug", v."title", v."payload"->>'category' AS "category"
       FROM "zzsh_content"."content_item" i
       JOIN "zzsh_content"."content_version" v ON v."item_id" = i."id" AND v."state" = 'PUBLISHED'
      WHERE i."type" = 'RESOURCE' AND i."game_id" IS NOT NULL AND i."resource_key" LIKE 'guide:%'
      ORDER BY i."resource_key"`,
  )).rows;
  const visibleFolders = new Map(nodes.filter(node => node.kind === "FOLDER" && node.depth < 3).map(node => [node.id, node]));
  return [
    ...nodes.map(({ id, parentId, kind, depth, sortKey, iconKey, description, title, resourceKey }) => ({
      id, parentId, kind, depth, sortKey, iconKey, description, title: title ?? "", slug: resourceKey?.slice(6) ?? null,
    })),
    ...gameGuides.map(({ id, slug, title, category }, index): PublicHelpNode => {
      const folder = visibleFolders.get(category);
      return { id, slug, title, parentId: folder?.id ?? null, kind: "ARTICLE", depth: (folder?.depth ?? 0) + 1, sortKey: `game_${padKey(index)}`, iconKey: null, description: null };
    }),
  ];
}

/** Slug status for the offline page: AVAILABLE / RETIRED / UNKNOWN. */
export async function readHelpSlugStatus(client: PoolClient, slug: string): Promise<{ state: "AVAILABLE" | "RETIRED"; title: string | null } | null> {
  const tombstone = (await client.query<{ lastTitle: string | null }>(
    `SELECT "last_title" AS "lastTitle" FROM "zzsh_content"."help_slug_tombstone" WHERE "slug" = $1 AND "deleted_at" IS NOT NULL`, [slug],
  )).rows[0];
  if (tombstone) return { state: "RETIRED", title: tombstone.lastTitle };
  const item = await loadResourceItem(client, `guide:${slug}`);
  if (item) {
    const version = (await client.query<{ title: string; state: string }>(
      `SELECT "title", "state" FROM "zzsh_content"."content_version"
        WHERE "item_id" = $1 AND ("state" = 'PUBLISHED' OR "published_at" IS NOT NULL)
        ORDER BY ("state" = 'PUBLISHED') DESC, "sequence" DESC LIMIT 1`, [item.id],
    )).rows[0];
    if (version) return { state: version.state === "PUBLISHED" ? "AVAILABLE" : "RETIRED", title: version.title };
  }
  return null;
}

/** A slug is never reused: refuse creation while a tombstone exists. */
export async function assertSlugNotRetired(client: PoolClient, slug: string): Promise<void> {
  const row = (await client.query(`SELECT 1 FROM "zzsh_content"."help_slug_tombstone" WHERE "slug" = $1 AND "deleted_at" IS NOT NULL`, [slug])).rows[0];
  if (row) throw slugRetired();
}

// --- sort keys (same scheme as the internal docs tree) ----------------------
function padKey(value: number): string {
  return String(value).padStart(SORT_WIDTH, "0");
}
type Sibling = { id: string; sortKey: string };

async function allocateSortKey(client: PoolClient, parentId: string | null, afterId: string | null | undefined, movingId: string): Promise<{ key: string; reassign: Sibling[] }> {
  const siblings = (await client.query<Sibling>(
    `SELECT "id", "sort_key" AS "sortKey" FROM "zzsh_content"."help_tree_node"
      WHERE "parent_id" IS NOT DISTINCT FROM $1 AND "deleted_at" IS NULL AND "id" <> $2
      ORDER BY "sort_key", "id"`, [parentId, movingId],
  )).rows;
  let index = afterId === null ? 0 : siblings.length;
  if (typeof afterId === "string") {
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
  const fits = (prev === null || candidate > prev) && (next === null || candidate < next) && candidate > 0;
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
  for (const sibling of reassign) await client.query(`UPDATE "zzsh_content"."help_tree_node" SET "sort_key" = 'tmp_' || "id" WHERE "id" = $1`, [sibling.id]);
  for (const sibling of reassign) await client.query(`UPDATE "zzsh_content"."help_tree_node" SET "sort_key" = $2 WHERE "id" = $1`, [sibling.id, sibling.sortKey]);
}

async function subtreeIds(client: PoolClient, rootId: string): Promise<string[]> {
  const rows = (await client.query<{ id: string }>(
    `WITH RECURSIVE subtree AS (
       SELECT "id" FROM "zzsh_content"."help_tree_node" WHERE "id" = $1
       UNION ALL
       SELECT n."id" FROM "zzsh_content"."help_tree_node" n JOIN subtree s ON n."parent_id" = s."id"
     ) SELECT "id" FROM subtree`, [rootId],
  )).rows;
  return rows.map(row => row.id);
}

async function subtreeMaxDepth(client: PoolClient, rootId: string): Promise<number> {
  const row = (await client.query<{ maxDepth: number }>(
    `WITH RECURSIVE subtree AS (
       SELECT "id", "depth" FROM "zzsh_content"."help_tree_node" WHERE "id" = $1
       UNION ALL
       SELECT n."id", n."depth" FROM "zzsh_content"."help_tree_node" n JOIN subtree s ON n."parent_id" = s."id"
     ) SELECT max("depth") AS "maxDepth" FROM subtree`, [rootId],
  )).rows[0];
  return row?.maxDepth ?? 1;
}

async function refreshSubtreeDepths(client: PoolClient, rootId: string): Promise<void> {
  let level = [rootId];
  while (level.length > 0) {
    const children = (await client.query<{ id: string }>(
      `SELECT "id" FROM "zzsh_content"."help_tree_node" WHERE "parent_id" = ANY($1::text[])`, [level],
    )).rows.map(row => row.id);
    if (children.length === 0) break;
    await client.query(`UPDATE "zzsh_content"."help_tree_node" SET "parent_id" = "parent_id" WHERE "id" = ANY($1::text[])`, [children]);
    level = children;
  }
}

async function assertParentUsable(client: PoolClient, parentId: string | null, movingId: string, subtreeHeight: number): Promise<number> {
  if (parentId === null) {
    if (subtreeHeight > 3) throw moveInvalid("Help tree exceeds three levels");
    return 1;
  }
  if (parentId === movingId) throw moveInvalid("A node cannot be its own parent");
  const parent = await loadHelpNode(client, parentId);
  if (!parent || parent.deletedAt) throw moveInvalid("Target parent does not exist");
  if (parent.kind !== "FOLDER") throw moveInvalid("An article cannot have children");
  const descendants = await subtreeIds(client, movingId);
  if (descendants.includes(parentId)) throw moveInvalid("A node cannot move into its own subtree");
  const newDepth = parent.depth + 1;
  if (newDepth + subtreeHeight - 1 > 3) throw moveInvalid("Help tree exceeds three levels");
  return newDepth;
}

// --- folder / node writes ---------------------------------------------------
export async function lockHelpTree(client: PoolClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ["content-help-tree"]);
}

export async function attachHelpArticle(client: PoolClient, actorId: string, resourceKey: string, parentId: string | null): Promise<HelpTreeNodeRow> {
  const id = newHelpId("htn");
  await assertParentUsable(client, parentId, id, 1);
  const { key, reassign } = await allocateSortKey(client, parentId, undefined, id);
  await applyReassign(client, reassign);
  return (await client.query<HelpTreeNodeRow>(
    `INSERT INTO "zzsh_content"."help_tree_node" ("id", "parent_id", "kind", "resource_key", "sort_key", "created_by_admin_id", "updated_by_admin_id")
     VALUES ($1, $2, 'ARTICLE', $3, $4, $5, $5) RETURNING ${NODE_FIELDS}`,
    [id, parentId, resourceKey, key, actorId],
  )).rows[0]!;
}

export async function createHelpArticle(
  client: PoolClient, actor: WriteActor, requestId: string,
  input: { parentId: string | null; title: string; slug?: string },
): Promise<AdminHelpNode> {
  await lockHelpTree(client);
  const slug = input.slug ?? `article-${randomUUID().replaceAll("-", "")}`;
  const resourceKey = `guide:${slug}`;
  const category = HELP_CATEGORIES.find(value => value === input.parentId) ?? "rental";
  const payload = checkedResource(resourceKey, {
    kind: "guide", id: slug, slug, title: input.title, summary: "", category, audience: ["all"], keywords: [], related: [],
    updatedAt: new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10), format: "plate", schemaVersion: 1, mediaIds: [],
    document: { format: "plate", schemaVersion: 1, preset: "help", value: [{ type: "p", children: [{ text: "" }] }] },
  });
  await lockManagedResource(client, resourceKey);
  await assertSlugNotRetired(client, slug);
  if (await loadResourceItem(client, resourceKey)) throw invalid("该地址已被使用", "slug");
  const { item, version } = await createContentItem(client, actor.id, { type: "RESOURCE", resourceKey, gameId: null, payload });
  const node = await attachHelpArticle(client, actor.id, resourceKey, input.parentId);
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "HELP_ARTICLE_CREATED",
    objectType: "help_tree_node", objectId: node.id, outcome: "SUCCESS", requestId, reason: "content.platform.edit",
    details: { before: null, after: { itemId: item.id, versionId: version.id, resourceKey, parentId: node.parentId }, result: "CREATED" },
  });
  return { ...node, title: version.title, published: false, hasDraft: true, withdrawn: false };
}
export async function createFolder(
  client: PoolClient, actor: WriteActor, requestId: string,
  input: { parentId: string | null; title: string; description?: string | null; afterId?: string | null; iconKey?: string | null },
): Promise<HelpTreeNodeRow> {
  await authorizeHelp(client, actor, "edit");
  await lockHelpTree(client);
  const id = newHelpId("htn");
  await assertParentUsable(client, input.parentId, id, 1);
  if (input.parentId !== null && input.iconKey) throw invalid("只有顶层分组可以设置图标", "iconKey");
  const { key, reassign } = await allocateSortKey(client, input.parentId, input.afterId, id);
  await applyReassign(client, reassign);
  await client.query(
    `INSERT INTO "zzsh_content"."help_tree_node" ("id", "parent_id", "kind", "title", "description", "icon_key", "sort_key", "created_by_admin_id", "updated_by_admin_id")
     VALUES ($1, $2, 'FOLDER', $3, $4, $5, $6, $7, $7)`,
    [id, input.parentId, input.title, input.description ?? null, input.iconKey ?? null, key, actor.id],
  );
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "HELP_FOLDER_CREATED",
    objectType: "help_tree_node", objectId: id, outcome: "SUCCESS", requestId, reason: "content.platform.edit",
    details: { before: null, after: { id, parentId: input.parentId, title: input.title, iconKey: input.iconKey ?? null }, result: "CREATED" },
  });
  return (await loadHelpNode(client, id))!;
}

export async function updateFolder(
  client: PoolClient, actor: WriteActor, requestId: string, id: string, expectedRevision: string,
  input: { title?: string; description?: string | null; iconKey?: string | null },
): Promise<HelpTreeNodeRow> {
  await authorizeHelp(client, actor, "edit");
  const node = await requireLiveHelpNode(client, id, true);
  if (node.kind !== "FOLDER") throw invalid("只有分组可修改名称、说明和图标");
  if (node.parentId !== null && input.iconKey) throw invalid("只有顶层分组可以设置图标", "iconKey");
  if (node.revision !== expectedRevision) throw versionChanged();
  const title = input.title ?? node.title;
  const description = input.description === undefined ? node.description : input.description;
  const iconKey = input.iconKey === undefined ? node.iconKey : input.iconKey;
  await client.query(
    `UPDATE "zzsh_content"."help_tree_node" SET "title" = $2, "description" = $3, "icon_key" = $4, "revision" = "revision" + 1, "updated_by_admin_id" = $5, "updated_at" = clock_timestamp() WHERE "id" = $1`,
    [id, title, description, iconKey, actor.id],
  );
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "HELP_NODE_RENAMED",
    objectType: "help_tree_node", objectId: id, outcome: "SUCCESS", requestId, reason: "content.platform.edit",
    details: { before: { title: node.title, iconKey: node.iconKey }, after: { title, iconKey }, result: "APPLIED" },
  });
  return (await loadHelpNode(client, id))!;
}

export async function moveHelpNode(
  client: PoolClient, actor: WriteActor, requestId: string, id: string, expectedRevision: string,
  parentId: string | null, afterId: string | null | undefined,
): Promise<HelpTreeNodeRow> {
  await authorizeHelp(client, actor, "edit");
  await lockHelpTree(client);
  const node = await requireLiveHelpNode(client, id, true);
  if (node.revision !== expectedRevision) throw versionChanged();
  const height = await subtreeMaxDepth(client, id) - node.depth + 1;
  await assertParentUsable(client, parentId, id, height);
  await client.query(
    `UPDATE "zzsh_content"."help_tree_node" SET "parent_id" = $2, "sort_key" = 'tmp_' || "id", "revision" = "revision" + 1, "updated_by_admin_id" = $3, "updated_at" = clock_timestamp() WHERE "id" = $1`,
    [id, parentId, actor.id],
  );
  await refreshSubtreeDepths(client, id);
  const { key, reassign } = await allocateSortKey(client, parentId, afterId, id);
  await applyReassign(client, reassign);
  await client.query(`UPDATE "zzsh_content"."help_tree_node" SET "sort_key" = $2 WHERE "id" = $1`, [id, key]);
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "HELP_NODE_MOVED",
    objectType: "help_tree_node", objectId: id, outcome: "SUCCESS", requestId, reason: "content.platform.edit",
    details: { before: { parentId: node.parentId }, after: { parentId, sortKey: key }, result: "APPLIED" },
  });
  return (await loadHelpNode(client, id))!;
}

/** Count public references to the given slugs (related, body links, footer, updates). */
async function countHelpReferences(client: PoolClient, slugs: string[]): Promise<number> {
  if (slugs.length === 0) return 0;
  const targets = slugs.map(slug => `/help/${slug}`);
  const rows = (await client.query<{ payload: unknown }>(
    `SELECT v."payload" FROM "zzsh_content"."content_version" v
       JOIN "zzsh_content"."content_item" i ON i."id" = v."item_id"
      WHERE v."state" = 'PUBLISHED' AND v."payload" IS NOT NULL`,
  )).rows;
  let count = 0;
  const hit = (text: string) => targets.some(target => text.includes(target));
  for (const row of rows) {
    const payload = (projectLegacyResource(row.payload) ?? row.payload) as { kind?: string; format?: string; related?: string[]; document?: PlateDocumentEnvelope; help?: { href: string }[]; support?: { href: string }[] };
    if (!payload || typeof payload !== "object") continue;
    if (payload.kind === "guide") {
      for (const related of payload.related ?? []) if (slugs.includes(related)) count += 1;
      if (payload.document) for (const link of extractPlate(payload.document).links) if (hit(link)) count += 1;
    } else if (payload.kind === "footer") {
      for (const link of [...(payload.help ?? []), ...(payload.support ?? [])]) if (hit(link.href)) count += 1;
    } else if (payload.format === "plate" && payload.document) {
      for (const link of extractPlate(payload.document).links) if (hit(link)) count += 1;
    }
  }
  return count;
}

export async function deleteHelpNode(
  client: PoolClient, actor: WriteActor, requestId: string, id: string, expectedRevision: string,
): Promise<{ deletedCount: number; batchId: string; purgeAt: Date; referenceCount: number }> {
  await authorizeHelp(client, actor, "edit");
  await lockHelpTree(client);
  const node = await requireLiveHelpNode(client, id, true);
  if (node.revision !== expectedRevision) throw versionChanged();
  const batchId = newHelpId("hbatch");
  const ids = await subtreeIds(client, id);
  const members = (await client.query<HelpTreeNodeRow>(
    `SELECT ${NODE_FIELDS} FROM "zzsh_content"."help_tree_node" WHERE "id" = ANY($1::text[]) AND "deleted_at" IS NULL`, [ids],
  )).rows;
  const articleMembers = members.filter(member => member.kind === "ARTICLE" && member.resourceKey);
  const slugs = articleMembers.map(member => member.resourceKey!.slice(6));
  const referenceCount = await countHelpReferences(client, slugs);
  const publishedIds: string[] = [];
  // Withdraw published articles and record their pre-delete state + tombstone.
  for (const member of articleMembers) {
    const item = await loadResourceItem(client, member.resourceKey!);
    let lastTitle: string | null = null;
    if (item) {
      const published = (await client.query<{ id: string; title: string; revision: string }>(
        `SELECT "id", "title", "revision"::text AS "revision" FROM "zzsh_content"."content_version" WHERE "item_id" = $1 AND "state" = 'PUBLISHED'`, [item.id],
      )).rows[0];
      if (published) {
        publishedIds.push(member.id);
        lastTitle = published.title;
        await withdrawContentVersion(client, item.id, published.id, item.revision);
      } else {
        const latest = (await client.query<{ title: string }>(
          `SELECT "title" FROM "zzsh_content"."content_version" WHERE "item_id" = $1 ORDER BY "sequence" DESC LIMIT 1`, [item.id],
        )).rows[0];
        lastTitle = latest?.title ?? null;
      }
    }
    await client.query(
      `INSERT INTO "zzsh_content"."help_slug_tombstone" ("slug", "resource_key", "last_title", "deleted_at")
       VALUES ($1, $2, $3, clock_timestamp())
       ON CONFLICT ("slug") DO UPDATE SET "resource_key" = EXCLUDED."resource_key", "last_title" = EXCLUDED."last_title", "deleted_at" = EXCLUDED."deleted_at", "purged_at" = NULL`,
      [member.resourceKey!.slice(6), member.resourceKey, lastTitle],
    );
  }
  const deleted = await client.query(
    `UPDATE "zzsh_content"."help_tree_node"
      SET "deleted_at" = clock_timestamp(), "deleted_by_admin_id" = $2, "delete_batch_id" = $3,
          "pre_delete_state" = CASE WHEN "kind" <> 'ARTICLE' THEN NULL
                                   WHEN "id" = ANY($4::text[]) THEN 'PUBLISHED' ELSE 'DRAFT_ONLY' END
      WHERE "id" = ANY($1::text[]) AND "deleted_at" IS NULL`, [ids, actor.id, batchId, publishedIds],
  );
  await client.query(
    `UPDATE "zzsh_content"."help_tree_node" SET "revision" = "revision" + 1, "updated_by_admin_id" = $2, "updated_at" = clock_timestamp() WHERE "id" = $1`, [id, actor.id],
  );
  const purgeAt = new Date(Date.now() + HELP_TRASH_RETENTION_MS);
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "HELP_DELETED",
    objectType: "help_tree_node", objectId: id, outcome: "SUCCESS", requestId, reason: "content.platform.edit",
    details: { before: { deletedAt: null }, after: { batchId, deletedCount: deleted.rowCount ?? ids.length, referenceCount, purgeAt: purgeAt.toISOString() }, result: "DELETED" },
  });
  return { deletedCount: deleted.rowCount ?? ids.length, batchId, purgeAt, referenceCount };
}

export type HelpTrashItem = { batchId: string; rootNodeId: string; title: string | null; deletedAt: Date; deletedBy: string; count: number; purgeAt: Date };

export async function listHelpTrash(client: PoolClient, cursor?: string, limit = 50): Promise<{ items: HelpTrashItem[]; nextCursor: string | null }> {
  const rows = (await client.query<HelpTrashItem>(
    `SELECT root."delete_batch_id" AS "batchId", root."id" AS "rootNodeId", COALESCE(root."title", tombstone."last_title") AS "title",
       root."deleted_at" AS "deletedAt", root."deleted_by_admin_id" AS "deletedBy",
       (SELECT count(*)::int FROM "zzsh_content"."help_tree_node" c WHERE c."delete_batch_id" = root."delete_batch_id") AS "count",
       root."deleted_at" + interval '30 days' AS "purgeAt"
      FROM "zzsh_content"."help_tree_node" root
      LEFT JOIN "zzsh_content"."help_slug_tombstone" tombstone ON tombstone."slug" = substr(root."resource_key", 7)
      WHERE root."deleted_at" IS NOT NULL
        AND (root."parent_id" IS NULL OR NOT EXISTS (
          SELECT 1 FROM "zzsh_content"."help_tree_node" p WHERE p."id" = root."parent_id" AND p."delete_batch_id" = root."delete_batch_id"))
        AND ($1::text IS NULL OR root."delete_batch_id" > $1)
      ORDER BY root."delete_batch_id" LIMIT $2`, [cursor ?? null, limit + 1],
  )).rows;
  const page = rows.slice(0, limit);
  return { items: page, nextCursor: rows.length > limit ? page[page.length - 1]!.batchId : null };
}

export async function restoreHelpBatch(
  client: PoolClient, actor: WriteActor, requestId: string, batchId: string, parentId?: string | null,
): Promise<{ node: HelpTreeNodeRow }> {
  await authorizeHelp(client, actor, "publish");
  await lockHelpTree(client);
  const members = (await client.query<HelpTreeNodeRow>(
    `SELECT ${NODE_FIELDS} FROM "zzsh_content"."help_tree_node" WHERE "delete_batch_id" = $1 AND "deleted_at" IS NOT NULL ORDER BY "depth", "id"`, [batchId],
  )).rows;
  if (members.length === 0) throw notFound();
  const root = members.find(member => !members.some(other => other.id === member.parentId)) ?? members[0]!;
  const targetParent = parentId === undefined ? root.parentId : parentId;
  const height = members.reduce((max, member) => Math.max(max, member.depth), root.depth) - root.depth + 1;
  await assertParentUsable(client, targetParent, root.id, height);
  const ids = members.map(member => member.id);
  await client.query(
    `UPDATE "zzsh_content"."help_tree_node"
     SET "deleted_at" = NULL, "deleted_by_admin_id" = NULL, "delete_batch_id" = NULL, "pre_delete_state" = NULL,
         "sort_key" = CASE WHEN "id" = $2 THEN 'tmp_' || "id" ELSE "sort_key" END
     WHERE "id" = ANY($1::text[])`, [ids, root.id],
  );
  await client.query(
    `UPDATE "zzsh_content"."help_tree_node" SET "parent_id" = $2, "sort_key" = 'tmp_' || "id", "revision" = "revision" + 1, "updated_by_admin_id" = $3, "updated_at" = clock_timestamp() WHERE "id" = $1`,
    [root.id, targetParent, actor.id],
  );
  await refreshSubtreeDepths(client, root.id);
  const { key, reassign } = await allocateSortKey(client, targetParent, undefined, root.id);
  await applyReassign(client, reassign);
  await client.query(`UPDATE "zzsh_content"."help_tree_node" SET "sort_key" = $2 WHERE "id" = $1`, [root.id, key]);
  // Republish articles that were published before deletion; drafts stay drafts.
  for (const member of members) {
    if (member.kind !== "ARTICLE" || !member.resourceKey) continue;
    await client.query(`UPDATE "zzsh_content"."help_slug_tombstone" SET "deleted_at" = NULL WHERE "slug" = $1`, [member.resourceKey.slice(6)]);
    if (member.preDeleteState !== "PUBLISHED") continue;
    const item = await loadResourceItem(client, member.resourceKey);
    if (!item) continue;
    const withdrawn = (await client.query<{ id: string }>(
      `SELECT "id" FROM "zzsh_content"."content_version" WHERE "item_id" = $1 AND "state" = 'WITHDRAWN' ORDER BY "sequence" DESC LIMIT 1`, [item.id],
    )).rows[0];
    if (!withdrawn) continue;
    const existingDraft = (await client.query<{ id: string }>(
      `SELECT "id" FROM "zzsh_content"."content_version" WHERE "item_id" = $1 AND "state" = 'DRAFT'`, [item.id],
    )).rows[0];
    const draft = await restoreContentDraft(client, actor.id, item.id, withdrawn.id, item.revision);
    const freshItem = await loadContentItem(client, item.id);
    await publishContentVersion(client, actor.id, item.id, draft.version.id, freshItem!.revision);
    if (existingDraft) await createContentDraftFromLatest(client, actor.id, item.id, existingDraft.id);
  }
  await recordAudit(client, {
    actorType: "admin", actorId: actor.id, sessionId: actor.sessionId, action: "HELP_RESTORED",
    objectType: "help_tree_node", objectId: root.id, outcome: "SUCCESS", requestId, reason: "help.restore",
    details: { before: { batchId }, after: { parentId: targetParent, restoredCount: ids.length }, result: "RESTORED" },
  });
  return { node: (await loadHelpNode(client, root.id))! };
}
