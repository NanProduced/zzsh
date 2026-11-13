import type { PoolClient } from "pg";

import { conflict, invalid, newSupplyId, notFound } from "../supply/supply-util";
import { normalizeContentText, parseRfc3339Timestamp, validateInternalLink, type CarouselSlot } from "./content-fields";
import { requireContentMedia, requirePublicContentMedia } from "./content-resource";

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
