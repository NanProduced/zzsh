import type { PoolClient } from "pg";

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
