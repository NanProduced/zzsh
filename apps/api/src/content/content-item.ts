import type { PoolClient } from "pg";
import type { ContentResource } from "@zzsh/content";
import { extractPlate, type PlateDocumentEnvelope } from "@zzsh/content/plate";
import type { UpdateSettings } from "@zzsh/content/updates";
import { checkedUpdateDocument, checkedUpdateSettings, checkUpdateRelease, prepareUpdateSettings, updateDocumentFromBody, updateProjection } from "./updates";

import { conflict, invalid, newSupplyId, notFound } from "../supply/supply-util";
import { normalizeContentText, type ContentType } from "./content-fields";
import {
  checkedResource,
  fixedCarouselDraft,
  isMediaResource,
  prepareResourceDraft,
  replaceResourceMedia,
  requireContentMedia,
  requirePublicContentMedia,
  requireResourceMedia,
} from "./content-resource";
import {
  ITEM_FIELDS,
  VERSION_FIELDS,
  loadContentItem,
  loadContentVersion,
  projectStoredVersion,
  type ContentItemRow,
  type ContentVersionRow,
} from "./content-records";

export type DraftInput = {
  title?: string;
  summary?: string;
  body?: string;
  coverMediaId?: string | null;
  payload?: ContentResource;
  document?: PlateDocumentEnvelope;
  updateSettings?: UpdateSettings;
};

async function applyDraftFields(client: PoolClient, versionId: string, item: ContentItemRow, input: DraftInput, mediaOnly = false): Promise<void> {
  const sets: string[] = [];
  const parameters: unknown[] = [];
  const push = (fragment: string, value: unknown): void => {
    parameters.push(value);
    sets.push(fragment.replace("?", `$${parameters.length}`));
  };
  if (input.payload !== undefined) {
    if (item.type !== "RESOURCE" || !item.resourceKey) throw invalid("Structured content requires a managed resource");
    const payload = await prepareResourceDraft(item.resourceKey, input.payload);
    if (isMediaResource(payload) && !mediaOnly) throw invalid("Fixed page images require the media-only draft endpoint");
    await requireResourceMedia(client, payload, false);
    push(`"payload" = ?::jsonb`, JSON.stringify(payload));
    push(`"title" = ?`, payload.title);
    push(`"summary" = ?`, payload.kind === "guide" ? payload.summary : "");
  } else if (item.type === "RESOURCE") throw invalid("Managed resources require a complete payload");
  if (item.type === "RESOURCE" && [input.title, input.summary, input.body, input.coverMediaId, input.document].some(value => value !== undefined)) throw invalid("Managed resource text is derived from its payload");
  if (input.title !== undefined) push(`"title" = ?`, normalizeContentText(input.title, "title"));
  if (input.summary !== undefined) push(`"summary" = ?`, normalizeContentText(input.summary, "summary"));
  // 公告/资讯：document 为唯一正文来源，body 写纯文本投影，mediaIds 从 document 重算。
  let updateBody = input.body;
  let updateMediaIds: string[] | undefined;
  if (item.type !== "RESOURCE" && input.document !== undefined) {
    const document = checkedUpdateDocument(input.document, "draft");
    const projection = updateProjection(document);
    push(`"payload" = ?::jsonb`, JSON.stringify(document));
    updateBody = projection.body;
    updateMediaIds = projection.mediaIds;
  }
  if (updateBody !== undefined) push(`"body" = ?`, normalizeContentText(updateBody, "body"));
  if (input.updateSettings !== undefined && item.type === "RESOURCE") throw invalid("Resources cannot carry platform update settings");
  if (item.type !== "RESOURCE" && (updateBody !== undefined || input.updateSettings !== undefined || updateMediaIds !== undefined)) {
    const stored = await loadContentVersion(client, versionId);
    if (!stored) throw notFound();
    const current = projectStoredVersion(stored);
    if (current !== stored && !input.document && current.payload && !("kind" in current.payload)) {
      const document = updateBody === undefined ? current.payload : updateDocumentFromBody(updateBody);
      const projection = updateProjection(document);
      push(`"payload" = ?::jsonb`, JSON.stringify(document));
      if (updateBody === undefined) push(`"body" = ?`, normalizeContentText(projection.body, "body"));
      updateMediaIds = projection.mediaIds;
    }
    const mediaIds = updateMediaIds ?? (current.payload ? extractPlate(current.payload as PlateDocumentEnvelope).mediaIds : []);
    const settings = prepareUpdateSettings(input.updateSettings ?? current.updateSettings ?? {}, mediaIds);
    push(`"update_settings" = ?::jsonb`, JSON.stringify(settings));
  }
  if (input.coverMediaId !== undefined) {
    if (input.coverMediaId !== null) await requireContentMedia(client, input.coverMediaId);
    push(`"cover_media_id" = ?`, input.coverMediaId);
  }
  if (sets.length === 0) throw invalid("No draft fields were provided");
  parameters.push(versionId, item.id);
  await client.query(
    `UPDATE "zzsh_content"."content_version" SET ${sets.join(", ")}, "revision" = "revision" + 1, "updated_at" = clock_timestamp()
      WHERE "id" = $${parameters.length - 1} AND "item_id" = $${parameters.length} AND "state" = 'DRAFT'`,
    parameters,
  );
}

export type NewContentItemInput = {
  type: ContentType | "RESOURCE";
  resourceKey?: string;
  payload?: ContentResource;
  gameId: string | null;
  title?: string;
  summary?: string;
  body?: string;
  document?: PlateDocumentEnvelope;
  coverMediaId?: string | null;
  updateSettings?: UpdateSettings;
  // Offline seed writers only: deterministic ids make seed re-runs idempotent.
  // HTTP routes never populate this, so untrusted callers cannot mint ids.
  ids?: { itemId: string; versionId: string };
};

export async function createContentItem(client: PoolClient, adminUserId: string, input: NewContentItemInput): Promise<{ item: ContentItemRow; version: ContentVersionRow }> {
  const payload = input.type === "RESOURCE" && input.resourceKey ? await prepareResourceDraft(input.resourceKey, input.payload) : null;
  if (input.type === "RESOURCE" && !payload) throw invalid("A resource key and payload are required");
  if (input.type !== "RESOURCE" && (input.resourceKey !== undefined || input.payload !== undefined)) throw invalid("Legacy content does not accept a resource payload");
  if (input.type === "RESOURCE" && input.updateSettings !== undefined) throw invalid("Resources cannot carry platform update settings");
  // 公告/资讯正文唯一格式 plate：document 优先，纯文本 body 仅按段落 shaping（离线 seed）。
  let updateDocument: PlateDocumentEnvelope | null = null;
  let updateBody = "";
  let updateMediaIds: string[] = [];
  if (input.type !== "RESOURCE") {
    updateDocument = input.document !== undefined ? checkedUpdateDocument(input.document, "draft") : updateDocumentFromBody(input.body ?? "");
    const projection = updateProjection(updateDocument);
    updateBody = projection.body;
    updateMediaIds = projection.mediaIds;
  }
  const updateConfig = input.type === "RESOURCE" ? {} : prepareUpdateSettings(input.updateSettings ?? {}, updateMediaIds);
  if (payload) await requireResourceMedia(client, payload, false);
  if (input.type === "ANNOUNCEMENT" && input.gameId !== null) throw invalid("Platform announcements cannot belong to a game");
  if (input.gameId !== null) {
    const game = await client.query(`SELECT 1 FROM "zzsh_supply"."game" WHERE "id" = $1`, [input.gameId]);
    if (game.rows.length === 0) throw notFound();
  }
  if (input.coverMediaId) await requireContentMedia(client, input.coverMediaId);
  if (input.ids !== undefined) {
    if (!/^cnt_[0-9a-f]{32}$/.test(input.ids.itemId) || !/^cntv_[0-9a-f]{32}$/.test(input.ids.versionId)) throw invalid("Content ids are invalid");
  }
  const itemId = input.ids?.itemId ?? newSupplyId("cnt");
  const versionId = input.ids?.versionId ?? newSupplyId("cntv");
  await client.query(
    `INSERT INTO "zzsh_content"."content_item" ("id", "type", "game_id", "created_by_admin_id", "resource_key") VALUES ($1, $2, $3, $4, $5)`,
    [itemId, input.type, input.gameId, adminUserId, input.resourceKey ?? null],
  );
  await client.query(
    `INSERT INTO "zzsh_content"."content_version" ("id", "item_id", "sequence", "title", "summary", "body", "cover_media_id", "created_by_admin_id", "payload", "update_settings")
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7, $8::jsonb, $9::jsonb)`,
    [
      versionId,
      itemId,
      payload?.title ?? normalizeContentText(input.title ?? "", "title"),
      payload?.kind === "guide" ? payload.summary : normalizeContentText(input.summary ?? "", "summary"),
      normalizeContentText(updateBody, "body"),
      input.coverMediaId ?? null,
      adminUserId,
      payload ? JSON.stringify(payload) : updateDocument ? JSON.stringify(updateDocument) : null,
      JSON.stringify(updateConfig),
    ],
  );
  return { item: (await loadContentItem(client, itemId))!, version: (await loadContentVersion(client, versionId))! };
}

export async function saveContentDraft(
  client: PoolClient,
  itemId: string,
  versionId: string,
  expectedRevision: string,
  input: DraftInput,
): Promise<{ item: ContentItemRow; version: ContentVersionRow }> {
  return saveDraft(client, itemId, versionId, expectedRevision, input);
}

async function saveDraft(
  client: PoolClient, itemId: string, versionId: string, expectedRevision: string, input: DraftInput, mediaOnly = false,
): Promise<{ item: ContentItemRow; version: ContentVersionRow }> {
  const item = await loadContentItem(client, itemId, true);
  if (!item) throw notFound();
  const version = await loadContentVersion(client, versionId, true);
  if (!version || version.itemId !== itemId) throw notFound();
  if (version.state !== "DRAFT") throw conflict("Only the current draft can be edited");
  if ((item.type === "RESOURCE" ? item.revision : version.revision) !== expectedRevision) throw conflict("Content changed; reload and retry");
  await applyDraftFields(client, versionId, item, input, mediaOnly);
  await client.query(`UPDATE "zzsh_content"."content_item" SET "revision" = "revision" + CASE WHEN "type" = 'RESOURCE' THEN 1 ELSE 0 END, "updated_at" = clock_timestamp() WHERE "id" = $1`, [itemId]);
  return { item: (await loadContentItem(client, itemId))!, version: (await loadContentVersion(client, versionId))! };
}

export async function saveContentMediaDraft(
  client: PoolClient, itemId: string, versionId: string, expectedRevision: string, media: unknown,
): Promise<{ item: ContentItemRow; version: ContentVersionRow }> {
  const item = await loadContentItem(client, itemId, true);
  if (!item || item.type !== "RESOURCE" || !item.resourceKey) throw notFound();
  const version = await loadContentVersion(client, versionId, true);
  if (!version || version.itemId !== itemId) throw notFound();
  if (version.state !== "DRAFT" || item.revision !== expectedRevision) throw conflict("Content changed; reload and retry");
  const payload = replaceResourceMedia(item.resourceKey, checkedResource(item.resourceKey, version.payload), media);
  return saveDraft(client, itemId, versionId, expectedRevision, { payload }, true);
}

export async function createContentDraftFromLatest(client: PoolClient, adminUserId: string, itemId: string, sourceVersionId?: string): Promise<{ version: ContentVersionRow }> {
  const item = await loadContentItem(client, itemId, true);
  if (!item) throw notFound();
  const existingDraft = await client.query(`SELECT 1 FROM "zzsh_content"."content_version" WHERE "item_id" = $1 AND "state" = 'DRAFT'`, [itemId]);
  if ((existingDraft.rowCount ?? 0) > 0) throw conflict("A draft already exists for this content");
  const latest = (
    await client.query<ContentVersionRow>(
      `SELECT ${VERSION_FIELDS} FROM "zzsh_content"."content_version" v WHERE v."item_id" = $1 AND v."state" <> 'DRAFT' ORDER BY v."sequence" DESC, v."id" DESC LIMIT 1`,
      [itemId],
    )
  ).rows[0];
  if (!latest) throw conflict("There is no version to copy into a draft");
  // An abandoned historical draft must not become the default base for a guide.
  const latestPublication = !sourceVersionId && item.resourceKey?.startsWith("guide:") && !latest.publishedAt
    ? (await client.query<ContentVersionRow>(
      `SELECT ${VERSION_FIELDS} FROM "zzsh_content"."content_version" v WHERE v."item_id" = $1 AND v."published_at" IS NOT NULL ORDER BY v."sequence" DESC LIMIT 1`,
      [itemId],
    )).rows[0]
    : undefined;
  const stored = sourceVersionId ? await loadContentVersion(client, sourceVersionId) : latestPublication ?? latest;
  if (!stored || stored.itemId !== itemId || stored.state === "DRAFT") throw notFound();
  const source = projectStoredVersion(stored);
  const versionId = newSupplyId("cntv");
  // RESOURCE payloads carry a kind; update payloads are plate envelopes without one.
  const sourceResource = source.payload && "kind" in source.payload ? source.payload : null;
  const payload = item.resourceKey === "placement:HOME_HERO" && sourceResource ? fixedCarouselDraft(sourceResource) : source.payload;
  const payloadTitle = payload && "kind" in payload ? payload.title : source.title;
  const body = source !== stored && payload && !("kind" in payload) ? updateProjection(payload).body : source.body;
  await client.query(
    `INSERT INTO "zzsh_content"."content_version" ("id", "item_id", "sequence", "title", "summary", "body", "cover_media_id", "created_by_admin_id", "payload", "update_settings")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10::jsonb)`,
    [versionId, itemId, latest.sequence + 1, payloadTitle, source.summary, body, source.coverMediaId, adminUserId, payload ? JSON.stringify(payload) : null, JSON.stringify(source.updateSettings ?? {})],
  );
  await client.query(`UPDATE "zzsh_content"."content_item" SET "revision" = "revision" + CASE WHEN "type" = 'RESOURCE' THEN 1 ELSE 0 END, "updated_at" = clock_timestamp() WHERE "id" = $1`, [itemId]);
  return { version: (await loadContentVersion(client, versionId))! };
}

/** A saved draft becomes immutable history before its replacement; the selected source is copied unchanged. */
export async function restoreContentDraft(
  client: PoolClient, adminUserId: string, itemId: string, sourceVersionId: string, expectedRevision: string,
): Promise<{ version: ContentVersionRow }> {
  const item = await loadContentItem(client, itemId, true);
  if (!item || item.type !== "RESOURCE") throw notFound();
  if (item.revision !== expectedRevision) throw conflict("Content changed; reload before restoring");
  const source = await loadContentVersion(client, sourceVersionId, true);
  if (!source || source.itemId !== item.id) throw notFound();
  await client.query(`UPDATE "zzsh_content"."content_version" SET "state" = 'SUPERSEDED', "updated_at" = clock_timestamp()
    WHERE "item_id" = $1 AND "state" = 'DRAFT'`, [item.id]);
  return createContentDraftFromLatest(client, adminUserId, item.id, source.id);
}

export async function publishContentVersion(
  client: PoolClient,
  adminUserId: string,
  itemId: string,
  versionId: string,
  expectedRevision: string,
): Promise<{ item: ContentItemRow; version: ContentVersionRow }> {
  const item = await loadContentItem(client, itemId, true);
  if (!item) throw notFound();
  const stored = await loadContentVersion(client, versionId, true);
  if (!stored || stored.itemId !== itemId) throw notFound();
  if (stored.state !== "DRAFT") throw conflict("Only a draft can be published");
  const version = projectStoredVersion(stored);
  if ((item.type === "RESOURCE" ? item.revision : version.revision) !== expectedRevision) throw conflict("Content changed; reload and retry");
  if (!version.title.trim()) throw invalid("A title is required to publish");
  if (item.type === "RESOURCE") {
    if (!item.resourceKey) throw invalid("Resource key is missing");
    await requireResourceMedia(client, checkedResource(item.resourceKey, version.payload), true, item.resourceKey);
  } else {
    const settings = checkedUpdateSettings(version.updateSettings ?? {});
    await checkUpdateRelease(client, item, settings);
    // 发布再核 plate 占位词与媒体资格；正文投影与 mediaIds 已由 document 派生。
    const document = checkedUpdateDocument(version.payload, "publish");
    const mediaIds = extractPlate(document).mediaIds;
    if (mediaIds.length) {
      const result = await client.query<{ id: string; reviewState: string; accessClass: string; publicStorageKey: string | null }>(
        `SELECT "id", "review_state" AS "reviewState", "access_class" AS "accessClass", "public_storage_key" AS "publicStorageKey"
           FROM "zzsh_supply"."media_asset" WHERE "id" = ANY($1::text[]) AND "purpose" = 'CONTENT_MEDIA' AND "ownership_kind" = 'PLATFORM_CONTENT' FOR SHARE`,
        [mediaIds],
      );
      if (result.rows.length !== mediaIds.length) throw invalid("Only platform content media can be referenced");
      if (result.rows.some(row => row.reviewState !== "APPROVED" || row.accessClass !== "PUBLIC_DISPLAY" || !row.publicStorageKey)) {
        throw conflict("Every referenced media asset must be approved and publicly displayable");
      }
    }
  }
  if (version.coverMediaId) await requirePublicContentMedia(client, version.coverMediaId, "Cover media");
  if (version !== stored && version.payload) {
    const body = "kind" in version.payload ? version.body : updateProjection(version.payload).body;
    await client.query(
      `UPDATE "zzsh_content"."content_version" SET "payload" = $2::jsonb, "body" = $3, "update_settings" = $4::jsonb WHERE "id" = $1`,
      [versionId, JSON.stringify(version.payload), normalizeContentText(body, "body"), JSON.stringify(version.updateSettings ?? {})],
    );
  }
  await client.query(`UPDATE "zzsh_content"."content_version" SET "state" = 'SUPERSEDED', "updated_at" = clock_timestamp() WHERE "item_id" = $1 AND "state" = 'PUBLISHED'`, [itemId]);
  await client.query(
    `UPDATE "zzsh_content"."content_version" SET "state" = 'PUBLISHED', "published_at" = clock_timestamp(), "published_by_admin_id" = $2, "updated_at" = clock_timestamp() WHERE "id" = $1`,
    [versionId, adminUserId],
  );
  await client.query(`UPDATE "zzsh_content"."content_item" SET "revision" = "revision" + 1, "updated_at" = clock_timestamp() WHERE "id" = $1`, [itemId]);
  return { item: (await loadContentItem(client, itemId))!, version: (await loadContentVersion(client, versionId))! };
}

export async function withdrawContentVersion(
  client: PoolClient,
  itemId: string,
  versionId: string,
  expectedRevision: string,
): Promise<{ item: ContentItemRow; version: ContentVersionRow }> {
  const item = await loadContentItem(client, itemId, true);
  if (!item) throw notFound();
  if (item.revision !== expectedRevision) throw conflict("Content changed; reload and retry");
  const version = await loadContentVersion(client, versionId, true);
  if (!version || version.itemId !== itemId || version.state !== "PUBLISHED") throw conflict("The version is not currently published");
  await client.query(`UPDATE "zzsh_content"."content_version" SET "state" = 'WITHDRAWN', "updated_at" = clock_timestamp() WHERE "id" = $1`, [versionId]);
  await client.query(`UPDATE "zzsh_content"."content_item" SET "revision" = "revision" + 1, "updated_at" = clock_timestamp() WHERE "id" = $1`, [itemId]);
  return { item: (await loadContentItem(client, itemId))!, version: (await loadContentVersion(client, versionId))! };
}

export async function updateContentItemMeta(
  client: PoolClient,
  itemId: string,
  expectedRevision: string,
  input: { sortOrder: number },
): Promise<ContentItemRow> {
  const item = await loadContentItem(client, itemId, true);
  if (!item) throw notFound();
  if (item.revision !== expectedRevision) throw conflict("Content changed; reload and retry");
  await client.query(`UPDATE "zzsh_content"."content_item" SET "sort_order" = $2, "revision" = "revision" + 1, "updated_at" = clock_timestamp() WHERE "id" = $1`, [itemId, input.sortOrder]);
  return (await loadContentItem(client, itemId))!;
}

export async function listAdminContentItems(
  client: PoolClient,
  filter: { type?: string; scope: "platform" | "game"; gameId?: string },
  limit: number,
  cursor: { updatedAt: string; id: string } | null,
): Promise<{ items: (ContentItemRow & { draft: Record<string, unknown> | null; published: Record<string, unknown> | null })[]; nextCursor: string | null }> {
  const parameters: unknown[] = [];
  const conditions: string[] = filter.type ? [] : [`i."type" IN ('ANNOUNCEMENT', 'NEWS')`];
  if (filter.type) {
    parameters.push(filter.type);
    conditions.push(`i."type" = $${parameters.length}`);
  }
  if (filter.scope === "platform") conditions.push(`i."game_id" IS NULL`);
  else {
    parameters.push(filter.gameId);
    conditions.push(`i."game_id" = $${parameters.length}`);
  }
  if (cursor) {
    parameters.push(cursor.updatedAt);
    conditions.push(`(i."updated_at", i."id") < ($${parameters.length}::timestamptz, $${parameters.length + 1})`);
    parameters.push(cursor.id);
  }
  parameters.push(limit + 1);
  const rows = (
    await client.query<ContentItemRow & { updatedAtText: string }>(
      `SELECT ${ITEM_FIELDS}, to_char(i."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAtText"
         FROM "zzsh_content"."content_item" i
         LEFT JOIN "zzsh_supply"."game" g ON g."id" = i."game_id"
        WHERE ${conditions.join(" AND ")}
        ORDER BY i."updated_at" DESC, i."id" DESC
        LIMIT $${parameters.length}`,
      parameters,
    )
  ).rows;
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const ids = items.map((row) => row.id);
  const versions = ids.length === 0
    ? []
    : (
        await client.query<ContentVersionRow & { summaryJson: Record<string, unknown> }>(
          `SELECT ${VERSION_FIELDS}, json_build_object('id', v."id", 'sequence', v."sequence", 'state', v."state", 'revision', v."revision"::text,
                    'title', v."title", 'summary', v."summary", 'body', v."body", 'coverMediaId', v."cover_media_id",
                    'publishedAt', v."published_at", 'updatedAt', v."updated_at") AS "summaryJson"
             FROM "zzsh_content"."content_version" v
            WHERE v."item_id" = ANY($1::text[])
            ORDER BY v."sequence" DESC`,
          [ids],
        )
      ).rows;
  const withVersions = items.map((item) => {
    const itemVersions = versions.filter((version) => version.itemId === item.id);
    const draft = itemVersions.find((version) => version.state === "DRAFT");
    const published = itemVersions.find((version) => version.state === "PUBLISHED");
    // Latest any-state version keeps the title visible after withdraw.
    const latest = itemVersions[0];
    return {
      ...item,
      draft: draft?.summaryJson ?? null,
      published: published?.summaryJson ?? null,
      latest: latest?.summaryJson ?? null,
    };
  });
  const last = items[items.length - 1];
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({ v: 1, type: filter.type ?? null, scope: filter.scope, gameId: filter.gameId ?? null, limit, updatedAt: last.updatedAtText, id: last.id })).toString("base64url")
    : null;
  return { items: withVersions, nextCursor };
}
