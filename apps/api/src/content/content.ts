import type { PoolClient } from "pg";

import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { SecurityApiError } from "../auth/security-core";
import { conflict, invalid, newSupplyId, notFound } from "../supply/supply-util";

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
  gameId: string | null;
  gameName: string | null;
  sortOrder: number;
  revision: string;
  createdByAdminId: string;
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
  coverMediaId: string | null;
  revision: string;
  publishedAt: Date | null;
  publishedByAdminId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

const ITEM_FIELDS = `i."id", i."type", i."game_id" AS "gameId", g."name" AS "gameName", i."sort_order" AS "sortOrder",
  i."revision"::text AS "revision", i."created_by_admin_id" AS "createdByAdminId", i."created_at" AS "createdAt", i."updated_at" AS "updatedAt"`;

const VERSION_FIELDS = `v."id", v."item_id" AS "itemId", v."sequence", v."state", v."title", v."summary", v."body",
  v."cover_media_id" AS "coverMediaId", v."revision"::text AS "revision", v."published_at" AS "publishedAt",
  v."published_by_admin_id" AS "publishedByAdminId", v."created_at" AS "createdAt", v."updated_at" AS "updatedAt"`;

export async function loadContentItem(client: PoolClient, itemId: string, forUpdate = false): Promise<ContentItemRow | null> {
  const result = await client.query<ContentItemRow>(
    `SELECT ${ITEM_FIELDS} FROM "zzsh_content"."content_item" i
       LEFT JOIN "zzsh_supply"."game" g ON g."id" = i."game_id"
      WHERE i."id" = $1${forUpdate ? " FOR UPDATE OF i" : ""}`,
    [itemId],
  );
  return result.rows[0] ?? null;
}

export async function loadContentVersions(client: PoolClient, itemId: string): Promise<ContentVersionRow[]> {
  return (
    await client.query<ContentVersionRow>(
      `SELECT ${VERSION_FIELDS} FROM "zzsh_content"."content_version" v WHERE v."item_id" = $1 ORDER BY v."sequence" DESC, v."id" DESC`,
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

export type DraftInput = {
  title?: string;
  summary?: string;
  body?: string;
  coverMediaId?: string | null;
};

async function applyDraftFields(client: PoolClient, versionId: string, itemId: string, input: DraftInput): Promise<void> {
  const sets: string[] = [];
  const parameters: unknown[] = [];
  const push = (fragment: string, value: unknown): void => {
    parameters.push(value);
    sets.push(fragment.replace("?", `$${parameters.length}`));
  };
  if (input.title !== undefined) push(`"title" = ?`, normalizeContentText(input.title, "title"));
  if (input.summary !== undefined) push(`"summary" = ?`, normalizeContentText(input.summary, "summary"));
  if (input.body !== undefined) push(`"body" = ?`, normalizeContentText(input.body, "body"));
  if (input.coverMediaId !== undefined) {
    if (input.coverMediaId !== null) await requireContentMedia(client, input.coverMediaId);
    push(`"cover_media_id" = ?`, input.coverMediaId);
  }
  if (sets.length === 0) throw invalid("No draft fields were provided");
  parameters.push(versionId, itemId);
  await client.query(
    `UPDATE "zzsh_content"."content_version" SET ${sets.join(", ")}, "revision" = "revision" + 1, "updated_at" = clock_timestamp()
      WHERE "id" = $${parameters.length - 1} AND "item_id" = $${parameters.length} AND "state" = 'DRAFT'`,
    parameters,
  );
}

export type NewContentItemInput = {
  type: ContentType;
  gameId: string | null;
  title?: string;
  summary?: string;
  body?: string;
  coverMediaId?: string | null;
};

export async function createContentItem(client: PoolClient, adminUserId: string, input: NewContentItemInput): Promise<{ item: ContentItemRow; version: ContentVersionRow }> {
  if (input.type === "ANNOUNCEMENT" && input.gameId !== null) throw invalid("Platform announcements cannot belong to a game");
  if (input.gameId !== null) {
    const game = await client.query(`SELECT 1 FROM "zzsh_supply"."game" WHERE "id" = $1`, [input.gameId]);
    if (game.rows.length === 0) throw notFound();
  }
  if (input.coverMediaId) await requireContentMedia(client, input.coverMediaId);
  const itemId = newSupplyId("cnt");
  const versionId = newSupplyId("cntv");
  await client.query(
    `INSERT INTO "zzsh_content"."content_item" ("id", "type", "game_id", "created_by_admin_id") VALUES ($1, $2, $3, $4)`,
    [itemId, input.type, input.gameId, adminUserId],
  );
  await client.query(
    `INSERT INTO "zzsh_content"."content_version" ("id", "item_id", "sequence", "title", "summary", "body", "cover_media_id", "created_by_admin_id")
     VALUES ($1, $2, 1, $3, $4, $5, $6, $7)`,
    [
      versionId,
      itemId,
      normalizeContentText(input.title ?? "", "title"),
      normalizeContentText(input.summary ?? "", "summary"),
      normalizeContentText(input.body ?? "", "body"),
      input.coverMediaId ?? null,
      adminUserId,
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
  const item = await loadContentItem(client, itemId, true);
  if (!item) throw notFound();
  const version = await loadContentVersion(client, versionId, true);
  if (!version || version.itemId !== itemId) throw notFound();
  if (version.state !== "DRAFT") throw conflict("Only the current draft can be edited");
  if (version.revision !== expectedRevision) throw conflict("Content changed; reload and retry");
  await applyDraftFields(client, versionId, itemId, input);
  await client.query(`UPDATE "zzsh_content"."content_item" SET "updated_at" = clock_timestamp() WHERE "id" = $1`, [itemId]);
  return { item: (await loadContentItem(client, itemId))!, version: (await loadContentVersion(client, versionId))! };
}

export async function createContentDraftFromLatest(client: PoolClient, adminUserId: string, itemId: string): Promise<{ version: ContentVersionRow }> {
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
  const versionId = newSupplyId("cntv");
  await client.query(
    `INSERT INTO "zzsh_content"."content_version" ("id", "item_id", "sequence", "title", "summary", "body", "cover_media_id", "created_by_admin_id")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [versionId, itemId, latest.sequence + 1, latest.title, latest.summary, latest.body, latest.coverMediaId, adminUserId],
  );
  await client.query(`UPDATE "zzsh_content"."content_item" SET "updated_at" = clock_timestamp() WHERE "id" = $1`, [itemId]);
  return { version: (await loadContentVersion(client, versionId))! };
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
  const version = await loadContentVersion(client, versionId, true);
  if (!version || version.itemId !== itemId) throw notFound();
  if (version.state !== "DRAFT") throw conflict("Only a draft can be published");
  if (version.revision !== expectedRevision) throw conflict("Content changed; reload and retry");
  if ([...version.title].length === 0) throw invalid("A title is required to publish");
  if (version.coverMediaId) await requirePublicContentMedia(client, version.coverMediaId, "Cover media");
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
  const conditions: string[] = [];
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

export async function createCarouselItem(client: PoolClient, adminUserId: string, slot: CarouselSlot, input: CarouselInput): Promise<CarouselRow> {
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
  const id = newSupplyId("crl");
  await client.query(
    `INSERT INTO "zzsh_content"."carousel_item"
      ("id", "slot_code", "media_id", "image_alt", "title", "description", "link_url", "enabled", "sort_order", "starts_at", "ends_at", "created_by_admin_id")
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [id, slot, input.mediaId, imageAlt, title, description, linkUrl, enabled, input.sortOrder ?? 0, startsAt, endsAt, adminUserId],
  );
  return (await loadCarouselItem(client, id))!;
}

export async function updateCarouselItem(client: PoolClient, id: string, expectedRevision: string, input: CarouselInput): Promise<CarouselRow> {
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
  const conditions = [`v."state" = 'PUBLISHED'`];
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
      WHERE i."id" = $1`,
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
