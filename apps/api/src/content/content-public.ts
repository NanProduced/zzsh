import type { PoolClient } from "pg";
import type { CarouselSlot } from "./content-fields";

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
