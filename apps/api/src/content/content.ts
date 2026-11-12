import type { PoolClient } from "pg";
import { DEFAULT_RESOURCES, resourceMediaIds, validateResource, validateResourceKey, validateResourceMedia, type ContentResource } from "@zzsh/content";
import { projectLegacyResource } from "@zzsh/content/legacy-plate";
import { extractPlate, type PlateDocumentEnvelope } from "@zzsh/content/plate";
import type { UpdateSettings } from "@zzsh/content/updates";
import { prepareUpdateSettings, checkedUpdateSettings, checkUpdateRelease, checkedUpdateDocument, updateProjection, updateDocumentFromBody, projectStoredUpdate } from "./updates";

import { conflict, ensureOnlyFields, invalid, newSupplyId, notFound } from "../supply/supply-util";

export const CONTENT_TYPES = ["ANNOUNCEMENT", "NEWS"] as const;
export type ContentType = (typeof CONTENT_TYPES)[number];
export const CAROUSEL_SLOTS = ["HOME_HERO"] as const;
export type CarouselSlot = (typeof CAROUSEL_SLOTS)[number];

export const CONTENT_LIMITS = {
  title: 200,
  summary: 500,
  bodyBytes: 20_000,
  carouselTitle: 120,
  carouselDescription: 300,
  imageAlt: 300,
  link: 300,
} as const;

// Only implemented user-web routes may be carousel targets; a carousel entry can
// never point at an external scheme, script URL or an unimplemented order action.
const ALLOWED_LINK_SEGMENTS = new Set(["accounts", "publish", "account", "help"]);
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u0080-\u009F]/;
const RFC3339 = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

export function isContentType(value: string): value is ContentType {
  return (CONTENT_TYPES as readonly string[]).includes(value);
}

export function isCarouselSlot(value: string): value is CarouselSlot {
  return (CAROUSEL_SLOTS as readonly string[]).includes(value);
}

// Minimal plain-text format: NFC + LF only, no control characters and a hard
// UTF-8 byte ceiling. HTML-looking input stays inert text; nothing is executed.
export function normalizeContentText(value: string, field: "title" | "summary" | "body" | "carouselTitle" | "carouselDescription" | "imageAlt"): string {
  const normalized = value.normalize("NFC").replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  if (CONTROL_CHARACTERS.test(normalized)) throw invalid(`${field} contains control characters`);
  const maxBytes = field === "body" ? CONTENT_LIMITS.bodyBytes : field === "summary" ? CONTENT_LIMITS.summary : field === "title" ? CONTENT_LIMITS.title : field === "carouselTitle" ? CONTENT_LIMITS.carouselTitle : field === "carouselDescription" ? CONTENT_LIMITS.carouselDescription : CONTENT_LIMITS.imageAlt;
  if (Buffer.byteLength(normalized, "utf8") > maxBytes) throw invalid(`${field} exceeds the allowed length`);
  if (field !== "body" && field !== "summary" && field !== "carouselDescription" && [...normalized].length > maxBytes) throw invalid(`${field} exceeds the allowed length`);
  return normalized;
}

export function validateInternalLink(value: unknown): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== "string") throw invalid("linkUrl is invalid");
  if (value.length === 0 || value.length > CONTENT_LIMITS.link) throw invalid("linkUrl is invalid");
  if (!value.startsWith("/") || value.startsWith("//") || value.includes("\\") || CONTROL_CHARACTERS.test(value) || /\s/.test(value)) throw invalid("linkUrl must be a same-site relative path");
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw invalid("linkUrl is invalid");
  }
  if (!decoded.startsWith("/") || decoded.startsWith("//")) throw invalid("linkUrl must be a same-site relative path");
  const path = decoded.split(/[?#]/, 1)[0] ?? "";
  const segments = path.split("/").filter((segment) => segment.length > 0);
  if (segments.some((segment) => segment === "." || segment === "..")) throw invalid("linkUrl must not contain relative segments");
  if (segments.length === 0) return decoded === "/" ? decoded : normalizeLink(value);
  if (!ALLOWED_LINK_SEGMENTS.has(segments[0]!)) throw invalid("linkUrl target is not available");
  return normalizeLink(value);
}

function normalizeLink(value: string): string {
  return value.normalize("NFC");
}

export function parseRfc3339Timestamp(value: unknown, field: string): { date: Date; text: string } | null {
  if (value === null) return null;
  if (typeof value !== "string" || !RFC3339.test(value) || value.startsWith("0000-")) throw invalid(`${field} is invalid`);
  const [datePart, timePart] = value.split("T");
  const [year, month, day] = datePart!.split("-").map(Number) as [number, number, number];
  const [hour, minute, second] = timePart!.replace(/(?:Z|[+-]\d{2}:\d{2})$/, "").split(":").map(Number) as [number, number, number];
  // Calendar and clock fields are validated directly: Date.parse normalizes
  // impossible input (e.g. February 30 or 24:00:00) instead of rejecting it.
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() + 1 !== month || calendar.getUTCDate() !== day) throw invalid(`${field} is invalid`);
  if (hour > 23 || minute > 59 || second > 59) throw invalid(`${field} is invalid`);
  const millis = Date.parse(value);
  if (Number.isNaN(millis)) throw invalid(`${field} is invalid`);
  return { date: new Date(millis), text: value };
}

export type ContentScope = { platform: true; gameId: null } | { platform: false; gameId: string };

export function itemScope(row: { gameId: string | null }): ContentScope {
  return row.gameId === null ? { platform: true, gameId: null } : { platform: false, gameId: row.gameId };
}

export type ContentItemRow = {
  id: string;
  type: string;
  resourceKey: string | null;
  gameId: string | null;
  gameName: string | null;
  sortOrder: number;
  revision: string;
  createdByAdminId: string | null;
  source?: "SYSTEM_INITIAL" | null;
  createdAt: Date;
  updatedAt: Date;
};

export type ContentVersionRow = {
  id: string;
  itemId: string;
  sequence: number;
  state: string;
  title: string;
  summary: string;
  body: string;
  payload: ContentResource | PlateDocumentEnvelope | null;
  updateSettings?: UpdateSettings;
  coverMediaId: string | null;
  revision: string;
  publishedAt: Date | null;
  publishedByAdminId: string | null;
  source?: "SYSTEM_INITIAL" | null;
  createdAt: Date;
  updatedAt: Date;
};

const ITEM_FIELDS = `i."id", i."type", i."resource_key" AS "resourceKey", i."game_id" AS "gameId", g."name" AS "gameName", i."sort_order" AS "sortOrder",
  i."revision"::text AS "revision", CASE WHEN to_jsonb(i)->>'system_initial_sha256' IS NULL THEN i."created_by_admin_id" END AS "createdByAdminId",
  CASE WHEN to_jsonb(i)->>'system_initial_sha256' IS NOT NULL THEN 'SYSTEM_INITIAL' END AS source, i."created_at" AS "createdAt", i."updated_at" AS "updatedAt"`;

const VERSION_FIELDS = `v."id", v."item_id" AS "itemId", v."sequence", v."state", v."title", v."summary", v."body", v."payload", CASE WHEN v."update_settings"->'homePopup' = 'false'::jsonb THEN v."update_settings" - 'homePopup' ELSE v."update_settings" END AS "updateSettings",
  v."cover_media_id" AS "coverMediaId", v."revision"::text AS "revision", v."published_at" AS "publishedAt",
  CASE WHEN to_jsonb(v)->>'system_initial_sha256' IS NULL THEN v."published_by_admin_id" END AS "publishedByAdminId",
  CASE WHEN to_jsonb(v)->>'system_initial_sha256' IS NOT NULL THEN 'SYSTEM_INITIAL' END AS source, v."created_at" AS "createdAt", v."updated_at" AS "updatedAt"`;

export async function loadContentItem(client: PoolClient, itemId: string, forUpdate = false): Promise<ContentItemRow | null> {
  const result = await client.query<ContentItemRow>(
    `SELECT ${ITEM_FIELDS} FROM "zzsh_content"."content_item" i
       LEFT JOIN "zzsh_supply"."game" g ON g."id" = i."game_id"
      WHERE i."id" = $1${forUpdate ? " FOR UPDATE OF i" : ""}`,
    [itemId],
  );
  return result.rows[0] ?? null;
}

export async function loadContentVersions(client: PoolClient, itemId: string, activePayloadsOnly = false): Promise<ContentVersionRow[]> {
  return (
    await client.query<ContentVersionRow>(
      `SELECT ${activePayloadsOnly ? VERSION_FIELDS.replace('v."payload"', `CASE WHEN v."state" IN ('DRAFT', 'PUBLISHED') THEN v."payload" ELSE NULL END AS "payload"`) : VERSION_FIELDS} FROM "zzsh_content"."content_version" v WHERE v."item_id" = $1 ORDER BY v."sequence" DESC, v."id" DESC`,
      [itemId],
    )
  ).rows;
}

export async function loadContentVersion(client: PoolClient, versionId: string, forUpdate = false): Promise<ContentVersionRow | null> {
  const result = await client.query<ContentVersionRow>(
    `SELECT ${VERSION_FIELDS} FROM "zzsh_content"."content_version" v WHERE v."id" = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [versionId],
  );
  return result.rows[0] ?? null;
}

/** Project persisted pre-Plate versions. Request payloads still use the strict Plate validators. */
export function projectStoredVersion(version: ContentVersionRow): ContentVersionRow {
  const payload = projectLegacyResource(version.payload);
  if (payload) return { ...version, payload };
  if (!version.payload && (version.updateSettings as { format?: string } | undefined)?.format !== "plate"
    && (version.body || Object.keys(version.updateSettings ?? {}).length > 0)) {
    const projected = projectStoredUpdate(version.body, version.updateSettings);
    return { ...version, payload: projected.document ?? null, updateSettings: projected.settings };
  }
  return version;
}

async function requireContentMedia(client: PoolClient, mediaId: string): Promise<void> {
  const row = await client.query(`SELECT 1 FROM "zzsh_supply"."media_asset" WHERE "id" = $1 AND "purpose" = 'CONTENT_MEDIA'`, [mediaId]);
  if (row.rows.length === 0) throw invalid("Cover media must be an existing content media asset");
}

async function requirePublicContentMedia(client: PoolClient, mediaId: string, label: string): Promise<void> {
  const row = await client.query(
    `SELECT 1 FROM "zzsh_supply"."media_asset"
      WHERE "id" = $1 AND "purpose" = 'CONTENT_MEDIA' AND "review_state" = 'APPROVED'
        AND "access_class" = 'PUBLIC_DISPLAY' AND "public_storage_key" IS NOT NULL`,
    [mediaId],
  );
  if (row.rows.length === 0) throw conflict(`${label} must be approved and publicly displayable`);
}

export function checkedResource(key: string, value: unknown): ContentResource {
  try {
    validateResourceKey(key);
    return validateResource(key, value);
  } catch (error) {
    throw invalid(error instanceof Error ? error.message : "Content resource is invalid");
  }
}

export function isMediaResource(payload: ContentResource): boolean {
  return payload.kind === "contact" || payload.kind === "banner" || payload.kind === "carousel";
}

export function fixedCarouselDraft(source: ContentResource): ContentResource {
  const template = DEFAULT_RESOURCES["placement:HOME_HERO"];
  if (source.kind !== "carousel" || template?.kind !== "carousel") throw invalid("Carousel template is unavailable");
  return checkedResource("placement:HOME_HERO", {
    ...template,
    slides: template.slides.map(slot => {
      const previous = source.slides.find(slide => slide.id === slot.id);
      return { ...slot, mediaId: previous?.mediaId ?? null, mobileMediaId: previous?.mobileMediaId ?? null };
    }),
  });
}

/** guide / notice 正文为 plate；mediaIds 由共享校验从 document 重算，不信任调用方清单。 */
export async function prepareResourceDraft(key: string, value: unknown): Promise<ContentResource> {
  return checkedResource(key, value);
}

/** Fixed-page resources keep their original metadata; this boundary accepts images only. */
export function replaceResourceMedia(key: string, payload: ContentResource, input: unknown): ContentResource {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("Media fields are required");
  const media = input as Record<string, unknown>;
  if (payload.kind === "contact") {
    ensureOnlyFields(media, ["qrMediaId"]);
    if (!("qrMediaId" in media)) throw invalid("qrMediaId is required");
    return checkedResource(key, { ...payload, qrMediaId: media.qrMediaId });
  }
  if (payload.kind === "banner") {
    ensureOnlyFields(media, ["mediaId", "mobileMediaId"]);
    if (!("mediaId" in media) || !("mobileMediaId" in media)) throw invalid("Both image references are required");
    return checkedResource(key, { ...payload, mediaId: media.mediaId, mobileMediaId: media.mobileMediaId });
  }
  if (payload.kind === "carousel") {
    const template = DEFAULT_RESOURCES["placement:HOME_HERO"];
    if (template?.kind !== "carousel" || JSON.stringify(payload.slides.map(slide => slide.id)) !== JSON.stringify(template.slides.map(slide => slide.id))) {
      throw conflict("Legacy carousel positions are not automatically mapped; explicitly restore a version to create the fixed-position draft first");
    }
    ensureOnlyFields(media, ["slides"]);
    if (!Array.isArray(media.slides) || media.slides.length !== payload.slides.length) throw invalid("Existing carousel positions cannot be added or removed");
    const inputSlides = media.slides;
    const slides = payload.slides.map((slide, index) => {
      const entry = inputSlides[index];
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid("Carousel image fields are invalid");
      const fields = entry as Record<string, unknown>;
      ensureOnlyFields(fields, ["id", "mediaId", "mobileMediaId"]);
      if (fields.id !== slide.id || !("mediaId" in fields) || !("mobileMediaId" in fields)) throw invalid("Carousel positions and order cannot change");
      return { ...slide, mediaId: fields.mediaId, mobileMediaId: fields.mobileMediaId };
    });
    return checkedResource(key, { ...payload, slides });
  }
  throw invalid("Only fixed image resources accept media replacement");
}

export async function requireResourceMedia(client: PoolClient, payload: ContentResource, publishing: boolean, resourceKey?: string): Promise<void> {
  const ids = resourceMediaIds(payload);
  const isArticle = payload.kind === "guide" || payload.kind === "notice";
  // Unchecked draft text is inert and must be recoverable, including unresolved image references.
  if (isArticle && !publishing) return;
  if (!ids.length) return;
  const result = await client.query<{ id: string; reviewState: string; accessClass: string; publicStorageKey: string | null; width: number; height: number }>(
    `SELECT "id", "width", "height", "review_state" AS "reviewState", "access_class" AS "accessClass", "public_storage_key" AS "publicStorageKey"
       FROM "zzsh_supply"."media_asset" WHERE "id" = ANY($1::text[])
        AND "purpose" = 'CONTENT_MEDIA' AND "ownership_kind" = 'PLATFORM_CONTENT'${publishing ? " FOR SHARE" : ""}`,
    [ids],
  );
  if (result.rows.length !== ids.length) throw invalid("Only platform content media can be referenced");
  if (publishing && result.rows.some(row => row.reviewState !== "APPROVED" || row.accessClass !== "PUBLIC_DISPLAY" || !row.publicStorageKey)) {
    throw conflict("Every referenced media asset must be approved and publicly displayable");
  }
  if (publishing) { try { validateResourceMedia(payload, result.rows); } catch (error) { throw invalid(error instanceof Error ? error.message : "Resource image dimensions are invalid"); } }
}

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

export type CarouselRow = {
  id: string;
  slotCode: string;
  mediaId: string;
  imageAlt: string;
  title: string;
  description: string;
  linkUrl: string | null;
  enabled: boolean;
  sortOrder: number;
  startsAt: Date | null;
  endsAt: Date | null;
  revision: string;
  createdAt: Date;
  updatedAt: Date;
};

const CAROUSEL_FIELDS = `c."id", c."slot_code" AS "slotCode", c."media_id" AS "mediaId", c."image_alt" AS "imageAlt",
  c."title", c."description", c."link_url" AS "linkUrl", c."enabled", c."sort_order" AS "sortOrder",
  c."starts_at" AS "startsAt", c."ends_at" AS "endsAt", c."revision"::text AS "revision",
  c."created_at" AS "createdAt", c."updated_at" AS "updatedAt"`;

export async function loadCarouselItem(client: PoolClient, id: string, forUpdate = false): Promise<CarouselRow | null> {
  const result = await client.query<CarouselRow>(
    `SELECT ${CAROUSEL_FIELDS} FROM "zzsh_content"."carousel_item" c WHERE c."id" = $1${forUpdate ? " FOR UPDATE" : ""}`,
    [id],
  );
  return result.rows[0] ?? null;
}

export type CarouselInput = {
  mediaId?: string;
  imageAlt?: string;
  title?: string;
  description?: string;
  linkUrl?: string | null;
  enabled?: boolean;
  sortOrder?: number;
  startsAt?: string | null;
  endsAt?: string | null;
};

function carouselTimestamp(value: unknown, field: string): Date | null | undefined {
  if (value === undefined) return undefined;
  const parsed = parseRfc3339Timestamp(value, field);
  return parsed ? parsed.date : null;
}

// Fields whose change is visible to the public carousel (ordering included).
const CAROUSEL_PUBLIC_FIELDS: readonly (keyof CarouselInput)[] = [
  "mediaId", "imageAlt", "title", "description", "linkUrl", "sortOrder", "startsAt", "endsAt",
];

// Creating an already-enabled entry is a publish action.
export function carouselCreateRequiresPublish(input: CarouselInput): boolean {
  return input.enabled === true;
}

// Decision is made from the locked row: asserting enabled=true is always a
// publish intent (even as a no-op replay), disabling a live entry is a publish
// action, and any public-field change while the entry is (or becomes) enabled
// needs the content publish permission. Field edits on a disabled draft stay
// edit-only, including the UI's explicit enabled=false.
export function carouselUpdateRequiresPublish(current: CarouselRow, input: CarouselInput): boolean {
  if (input.enabled === true) return true;
  if (input.enabled === false && current.enabled) return true;
  const wouldBeEnabled = input.enabled ?? current.enabled;
  if (!wouldBeEnabled) return false;
  return CAROUSEL_PUBLIC_FIELDS.some((field) => input[field] !== undefined);
}

export async function createCarouselItem(client: PoolClient, adminUserId: string, slot: CarouselSlot, input: CarouselInput, idOverride?: string): Promise<CarouselRow> {
  await assertLegacyCarouselEditable(client);
  if (idOverride !== undefined && !/^crl_[0-9a-f]{32}$/.test(idOverride)) throw invalid("Carousel id is invalid");
  if (!input.mediaId) throw invalid("mediaId is required");
  if (!input.title) throw invalid("title is required");
  if (!input.imageAlt) throw invalid("imageAlt is required");
  const title = normalizeContentText(input.title, "carouselTitle");
  const imageAlt = normalizeContentText(input.imageAlt, "imageAlt");
  const description = normalizeContentText(input.description ?? "", "carouselDescription");
  if (title.length === 0) throw invalid("title is required");
  if (imageAlt.length === 0) throw invalid("imageAlt is required");
  const linkUrl = validateInternalLink(input.linkUrl ?? null) ?? null;
  const startsAt = carouselTimestamp(input.startsAt ?? null, "startsAt") ?? null;
  const endsAt = carouselTimestamp(input.endsAt ?? null, "endsAt") ?? null;
  if (startsAt && endsAt && startsAt.getTime() >= endsAt.getTime()) throw invalid("startsAt must be before endsAt");
  await requireContentMedia(client, input.mediaId);
  const enabled = input.enabled ?? false;
  // Disabled entries may reference pending media; enabling is the publish act.
  if (enabled) await requirePublicContentMedia(client, input.mediaId, "Carousel media");
  const id = idOverride ?? newSupplyId("crl");
  await client.query(
    `INSERT INTO "zzsh_content"."carousel_item"
      ("id", "slot_code", "media_id", "image_alt", "title", "description", "link_url", "enabled", "sort_order", "starts_at", "ends_at", "created_by_admin_id")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, slot, input.mediaId, imageAlt, title, description, linkUrl, enabled, input.sortOrder ?? 0, startsAt, endsAt, adminUserId],
  );
  return (await loadCarouselItem(client, id))!;
}

export async function updateCarouselItem(client: PoolClient, id: string, expectedRevision: string, input: CarouselInput): Promise<CarouselRow> {
  await assertLegacyCarouselEditable(client);
  const current = await loadCarouselItem(client, id, true);
  if (!current) throw notFound();
  if (current.revision !== expectedRevision) throw conflict("Carousel item changed; reload and retry");
  const sets: string[] = [];
  const parameters: unknown[] = [];
  const push = (fragment: string, value: unknown): void => {
    parameters.push(value);
    sets.push(fragment.replace("?", `$${parameters.length}`));
  };
  if (input.title !== undefined) {
    const title = normalizeContentText(input.title, "carouselTitle");
    if (title.length === 0) throw invalid("title is required");
    push(`"title" = ?`, title);
  }
  if (input.imageAlt !== undefined) {
    const imageAlt = normalizeContentText(input.imageAlt, "imageAlt");
    if (imageAlt.length === 0) throw invalid("imageAlt is required");
    push(`"image_alt" = ?`, imageAlt);
  }
  if (input.description !== undefined) push(`"description" = ?`, normalizeContentText(input.description, "carouselDescription"));
  if (input.linkUrl !== undefined) push(`"link_url" = ?`, validateInternalLink(input.linkUrl) ?? null);
  if (input.sortOrder !== undefined) push(`"sort_order" = ?`, input.sortOrder);
  if (input.startsAt !== undefined) push(`"starts_at" = ?`, carouselTimestamp(input.startsAt, "startsAt") ?? null);
  if (input.endsAt !== undefined) push(`"ends_at" = ?`, carouselTimestamp(input.endsAt, "endsAt") ?? null);
  if (input.mediaId !== undefined) {
    await requireContentMedia(client, input.mediaId);
    push(`"media_id" = ?`, input.mediaId);
  }
  const nextMediaId = input.mediaId ?? current.mediaId;
  const nextEnabled = input.enabled ?? current.enabled;
  if (nextEnabled) await requirePublicContentMedia(client, nextMediaId, "Carousel media");
  if (input.enabled !== undefined) push(`"enabled" = ?`, input.enabled);
  const nextStartsAt = input.startsAt !== undefined ? carouselTimestamp(input.startsAt, "startsAt") ?? null : current.startsAt;
  const nextEndsAt = input.endsAt !== undefined ? carouselTimestamp(input.endsAt, "endsAt") ?? null : current.endsAt;
  if (nextStartsAt && nextEndsAt && nextStartsAt.getTime() >= nextEndsAt.getTime()) throw invalid("startsAt must be before endsAt");
  if (sets.length === 0) throw invalid("No carousel fields were provided");
  parameters.push(id);
  await client.query(
    `UPDATE "zzsh_content"."carousel_item" SET ${sets.join(", ")}, "revision" = "revision" + 1, "updated_at" = clock_timestamp() WHERE "id" = $${parameters.length}`,
    parameters,
  );
  return (await loadCarouselItem(client, id))!;
}

async function assertLegacyCarouselEditable(client: PoolClient): Promise<void> {
  await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, ["content-resource:placement:HOME_HERO"]);
  const row = await client.query(`SELECT 1 FROM "zzsh_content"."content_item" WHERE "type" = 'RESOURCE' AND "resource_key" = 'placement:HOME_HERO'`);
  if (row.rows.length) throw conflict("Home carousel is managed through content resources; edit its draft there");
}

export async function listAdminCarousel(
  client: PoolClient,
  slot: CarouselSlot,
  limit: number,
  cursor: { sortOrder: number; id: string } | null,
): Promise<{ items: (CarouselRow & { mediaReviewState: string | null; mediaAccessClass: string | null })[]; nextCursor: string | null }> {
  const parameters: unknown[] = [slot];
  const conditions = [`c."slot_code" = $1`];
  if (cursor) {
    parameters.push(cursor.sortOrder, cursor.id);
    conditions.push(`(c."sort_order", c."id") < ($${parameters.length - 1}, $${parameters.length})`);
  }
  parameters.push(limit + 1);
  const rows = (
    await client.query<CarouselRow & { mediaReviewState: string | null; mediaAccessClass: string | null }>(
      `SELECT ${CAROUSEL_FIELDS}, m."review_state" AS "mediaReviewState", m."access_class" AS "mediaAccessClass"
         FROM "zzsh_content"."carousel_item" c
         LEFT JOIN "zzsh_supply"."media_asset" m ON m."id" = c."media_id"
        WHERE ${conditions.join(" AND ")}
        ORDER BY c."sort_order" DESC, c."id" DESC
        LIMIT $${parameters.length}`,
      parameters,
    )
  ).rows;
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({ v: 1, slot, limit, sortOrder: last.sortOrder, id: last.id })).toString("base64url")
    : null;
  return { items, nextCursor };
}

export async function listPublicContentItems(
  client: PoolClient,
  filter: { type?: string; gameId?: string },
  limit: number,
  cursor: { sortOrder: number; publishedAt: string; id: string } | null,
): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
  const parameters: unknown[] = [];
  const conditions = [`v."state" = 'PUBLISHED'`, `i."type" IN ('ANNOUNCEMENT', 'NEWS')`];
  if (filter.type) {
    parameters.push(filter.type);
    conditions.push(`i."type" = $${parameters.length}`);
  }
  if (filter.gameId) {
    parameters.push(filter.gameId);
    conditions.push(`i."game_id" = $${parameters.length}`);
  }
  if (cursor) {
    parameters.push(cursor.sortOrder, cursor.publishedAt, cursor.id);
    conditions.push(`(i."sort_order", v."published_at", i."id") < ($${parameters.length - 2}, $${parameters.length - 1}::timestamptz, $${parameters.length})`);
  }
  parameters.push(limit + 1);
  const rows = await client.query<Record<string, unknown>>(
    `SELECT i."id", i."type", i."game_id" AS "gameId", g."name" AS "gameName", i."sort_order" AS "sortOrder",
            v."title", v."summary", v."published_at" AS "publishedAt",
            CASE WHEN m."id" IS NOT NULL THEN m."id" ELSE NULL END AS "coverMediaId",
            to_char(v."published_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "publishedAtCursor"
       FROM "zzsh_content"."content_item" i
       JOIN "zzsh_content"."content_version" v ON v."item_id" = i."id" AND v."state" = 'PUBLISHED'
       LEFT JOIN "zzsh_supply"."game" g ON g."id" = i."game_id"
       LEFT JOIN "zzsh_supply"."media_asset" m ON m."id" = v."cover_media_id" AND m."purpose" = 'CONTENT_MEDIA'
              AND m."review_state" = 'APPROVED' AND m."access_class" = 'PUBLIC_DISPLAY' AND m."public_storage_key" IS NOT NULL
      WHERE ${conditions.join(" AND ")}
      ORDER BY i."sort_order" DESC, v."published_at" DESC, i."id" DESC
      LIMIT $${parameters.length}`,
    parameters,
  );
  const hasMore = rows.rows.length > limit;
  const items = hasMore ? rows.rows.slice(0, limit) : rows.rows;
  const last = items[items.length - 1] as { sortOrder: number; publishedAtCursor: string; id: string } | undefined;
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({ v: 1, type: filter.type ?? null, gameId: filter.gameId ?? null, limit, sortOrder: last.sortOrder, publishedAt: last.publishedAtCursor, id: last.id })).toString("base64url")
    : null;
  return { items: items.map(({ publishedAtCursor: _cursor, ...item }) => item), nextCursor };
}

export async function getPublicContentItem(client: PoolClient, itemId: string): Promise<Record<string, unknown> | null> {
  const row = await client.query<Record<string, unknown>>(
    `SELECT i."id", i."type", i."game_id" AS "gameId", g."name" AS "gameName", i."sort_order" AS "sortOrder",
            v."title", v."summary", v."body", v."published_at" AS "publishedAt",
            CASE WHEN m."id" IS NOT NULL THEN m."id" ELSE NULL END AS "coverMediaId"
       FROM "zzsh_content"."content_item" i
       JOIN "zzsh_content"."content_version" v ON v."item_id" = i."id" AND v."state" = 'PUBLISHED'
       LEFT JOIN "zzsh_supply"."game" g ON g."id" = i."game_id"
       LEFT JOIN "zzsh_supply"."media_asset" m ON m."id" = v."cover_media_id" AND m."purpose" = 'CONTENT_MEDIA'
              AND m."review_state" = 'APPROVED' AND m."access_class" = 'PUBLIC_DISPLAY' AND m."public_storage_key" IS NOT NULL
      WHERE i."id" = $1 AND i."type" IN ('ANNOUNCEMENT', 'NEWS')`,
    [itemId],
  );
  return row.rows[0] ?? null;
}

export async function listPublicCarousel(client: PoolClient, slot: CarouselSlot, limit: number): Promise<Record<string, unknown>[]> {
  const rows = await client.query<Record<string, unknown>>(
    `SELECT c."id", c."slot_code" AS "slotCode", c."media_id" AS "mediaId", c."image_alt" AS "imageAlt",
            c."title", c."description", c."link_url" AS "linkUrl", c."sort_order" AS "sortOrder",
            c."starts_at" AS "startsAt", c."ends_at" AS "endsAt"
       FROM "zzsh_content"."carousel_item" c
      WHERE c."slot_code" = $1 AND c."enabled"
        AND (c."starts_at" IS NULL OR c."starts_at" <= clock_timestamp())
        AND (c."ends_at" IS NULL OR clock_timestamp() < c."ends_at")
        AND EXISTS (SELECT 1 FROM "zzsh_supply"."media_asset" m WHERE m."id" = c."media_id"
              AND m."purpose" = 'CONTENT_MEDIA' AND m."review_state" = 'APPROVED' AND m."access_class" = 'PUBLIC_DISPLAY'
              AND m."public_storage_key" IS NOT NULL)
      ORDER BY c."sort_order" DESC, c."id" DESC
      LIMIT $2`,
    [slot, limit],
  );
  return rows.rows;
}

export async function listContentMedia(
  client: PoolClient,
  limit: number,
  cursor: { updatedAt: string; id: string } | null,
): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
  const parameters: unknown[] = [];
  const conditions = [`a."purpose" = 'CONTENT_MEDIA'`];
  if (cursor) {
    parameters.push(cursor.updatedAt);
    conditions.push(`(a."updated_at", a."id") < ($${parameters.length}::timestamptz, $${parameters.length + 1})`);
    parameters.push(cursor.id);
  }
  parameters.push(limit + 1);
  const rows = await client.query<Record<string, unknown>>(
    `SELECT a."id", a."mime", a."byte_size"::text AS "byteSize", a."width", a."height",
            a."review_state" AS "reviewState", a."access_class" AS "accessClass", a."review_reason" AS "reviewReason",
            to_char(a."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
       FROM "zzsh_supply"."media_asset" a
      WHERE ${conditions.join(" AND ")}
      ORDER BY a."updated_at" DESC, a."id" DESC
      LIMIT $${parameters.length}`,
    parameters,
  );
  const hasMore = rows.rows.length > limit;
  const items = hasMore ? rows.rows.slice(0, limit) : rows.rows;
  const last = items[items.length - 1] as { updatedAt: string; id: string } | undefined;
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({ v: 1, limit, updatedAt: last.updatedAt, id: last.id })).toString("base64url")
    : null;
  return { items, nextCursor };
}

export async function listContentMediaOptions(
  client: PoolClient,
  limit: number,
  cursor: { updatedAt: string; id: string } | null,
): Promise<{ items: Record<string, unknown>[]; nextCursor: string | null }> {
  const parameters: unknown[] = [];
  const conditions = [
    `a."purpose" = 'CONTENT_MEDIA'`,
    `a."review_state" = 'APPROVED' AND a."access_class" = 'PUBLIC_DISPLAY' AND a."public_storage_key" IS NOT NULL`,
  ];
  if (cursor) {
    parameters.push(cursor.updatedAt);
    conditions.push(`(a."updated_at", a."id") < ($${parameters.length}::timestamptz, $${parameters.length + 1})`);
    parameters.push(cursor.id);
  }
  parameters.push(limit + 1);
  const rows = await client.query<Record<string, unknown>>(
    `SELECT a."id", a."mime", a."width", a."height", a."byte_size"::text AS "byteSize",
            to_char(a."updated_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "updatedAt"
       FROM "zzsh_supply"."media_asset" a
      WHERE ${conditions.join(" AND ")}
      ORDER BY a."updated_at" DESC, a."id" DESC
      LIMIT $${parameters.length}`,
    parameters,
  );
  const hasMore = rows.rows.length > limit;
  const items = hasMore ? rows.rows.slice(0, limit) : rows.rows;
  const last = items[items.length - 1] as { updatedAt: string; id: string } | undefined;
  const nextCursor = hasMore && last
    ? Buffer.from(JSON.stringify({ v: 1, limit, updatedAt: last.updatedAt, id: last.id })).toString("base64url")
    : null;
  return { items: items.map(({ updatedAt: _updatedAt, ...item }) => item), nextCursor };
}
