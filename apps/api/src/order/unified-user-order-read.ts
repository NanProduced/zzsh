import { applyOrderUserFacts, readOrderUserFacts } from "./frozen-listing-read";
import type { PoolClient } from "pg";
import { conflict, invalid, sha256Hex } from "../supply/supply-util";
import { ORDER_FIELDS, ORDER_FROM, projectOrder, type OrderRow } from "./order";
import { legacyContinuationReady, LEGACY_ORDER_STATUS_SQL } from "./legacy-order-read";
import { legacyUserOrderFields, legacyUserOrderFrom, projectUserLegacyOrder, type LegacyUserOrderRow } from "./legacy-user-order-read";

type Filter = { party: "renter" | "owner"; status?: string; accountId?: string; limit: number; cursor?: string };
type Cursor = { f: string; c: string | null; o: "NATIVE" | "LEGACY"; i: string };
type Row = { origin: "NATIVE" | "LEGACY"; id: string; createdAt: string | null; record: OrderRow | LegacyUserOrderRow };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

export function parseUnifiedOrderQuery(query: URLSearchParams): Filter {
  for (const key of query.keys()) {
    if (!["party", "status", "accountId", "limit", "cursor"].includes(key) || query.getAll(key).length !== 1) throw invalid("Unsupported order query", key);
  }
  const party = query.get("party") ?? "renter";
  const status = query.get("status"), accountId = query.get("accountId"), cursor = query.get("cursor");
  const rawLimit = query.get("limit") ?? "20", limit = Number(rawLimit);
  if (party !== "renter" && party !== "owner") throw invalid("Party is invalid");
  if (!/^[1-9]\d{0,2}$/.test(rawLimit) || limit > 100) throw invalid("Limit is invalid");
  if (status !== null && !["PENDING_PAYMENT", "PAID", "COMPLETED", "CANCELLED", "UNKNOWN"].includes(status)) throw invalid("Status is invalid");
  if (accountId !== null && !ID.test(accountId)) throw invalid("Account is invalid");
  if (cursor !== null && (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))) throw conflict("Cursor is invalid");
  return { party, limit, ...(status === null ? {} : { status }), ...(accountId === null ? {} : { accountId }), ...(cursor === null ? {} : { cursor }) };
}

function decodeCursor(value: string | undefined, fingerprint: string): Cursor | null {
  if (value === undefined) return null;
  try {
    const c = JSON.parse(Buffer.from(value, "base64url").toString()) as Cursor;
    if (c.f !== fingerprint || (c.c !== null && (typeof c.c !== "string" || !TIME.test(c.c))) ||
      (c.o !== "NATIVE" && c.o !== "LEGACY") || typeof c.i !== "string" || !ID.test(c.i)) throw new Error("Invalid cursor");
    return c;
  } catch { throw conflict("Cursor is invalid"); }
}

/** One statement applies subject, filters and a cross-source total order before pagination. */
export async function listUnifiedUserOrders(client: PoolClient, userId: string, filter: Filter) {
  const fingerprint = sha256Hex(JSON.stringify(["user-orders-v1", userId, filter.party, filter.status ?? null, filter.accountId ?? null, filter.limit]));
  const cursor = decodeCursor(filter.cursor, fingerprint);
  const owner = filter.party === "owner";
  const continuationReady = await legacyContinuationReady(client);
  const rows = (await client.query<Row>(`
    WITH visible_orders AS (
      SELECT 'NATIVE'::text AS origin,n.id,n."createdAt",to_jsonb(n) AS record
      FROM (SELECT ${ORDER_FIELDS} ${ORDER_FROM}
        WHERE ${owner ? "o.owner_user_id" : "o.renter_user_id"}=$1
          AND ($2::text IS NULL OR o.status=$2) AND ($3::text IS NULL OR o.account_id=$3)) n
      UNION ALL
      SELECT 'LEGACY'::text AS origin,l.id,l."createdAt",to_jsonb(l) AS record
      FROM (SELECT ${legacyUserOrderFields(continuationReady)} ${legacyUserOrderFrom(continuationReady)}
        WHERE ${owner ? "l.owner_user_id" : "l.renter_user_id"}=$1
          AND ($2::text IS NULL OR (${LEGACY_ORDER_STATUS_SQL})=$2) AND ($3::text IS NULL OR l.account_id=$3)) l
    )
    SELECT * FROM visible_orders x
    WHERE NOT $4::boolean
      OR ($5::text IS NOT NULL AND (x."createdAt" IS NULL OR x."createdAt"<$5
        OR (x."createdAt"=$5 AND (x.origin COLLATE "C",x.id COLLATE "C")<($6::text COLLATE "C",$7::text COLLATE "C"))))
      OR ($5::text IS NULL AND x."createdAt" IS NULL AND (x.origin COLLATE "C",x.id COLLATE "C")<($6::text COLLATE "C",$7::text COLLATE "C"))
    ORDER BY x."createdAt" DESC NULLS LAST,x.origin COLLATE "C" DESC,x.id COLLATE "C" DESC LIMIT $8
  `, [userId, filter.status ?? null, filter.accountId ?? null, cursor !== null, cursor?.c ?? null, cursor?.o ?? null, cursor?.i ?? null, filter.limit + 1])).rows;
  const page = rows.slice(0, filter.limit);
  const last = page[page.length - 1];
  const items: Record<string, unknown>[] = page.map(row => row.origin === "NATIVE"
    ? { ...projectOrder(row.record as OrderRow, filter.party), source: { origin: "NATIVE" as const }, readOnly: false }
    : projectUserLegacyOrder(row.record as LegacyUserOrderRow, userId));
  // B2: page-batched frozen listing facts (raw rows carry accountId even when the projection hides it).
  const facts = await readOrderUserFacts(client, userId, page.map(row => {
    const r = row.record as { accountId?: string | null; versionId?: string | null; contentHash?: string | null; ownerUserId?: string | null };
    return { origin: row.origin as "NATIVE" | "LEGACY", orderId: row.id, accountId: r.accountId ?? null, versionId: r.versionId ?? null, contentHash: r.contentHash ?? null, ownerUserId: r.ownerUserId ?? null };
  }));
  page.forEach((row, index) => applyOrderUserFacts(items[index]!, facts.get(`${row.origin}:${row.id}`)));
  return {
    items,
    nextCursor: rows.length > filter.limit && last
      ? Buffer.from(JSON.stringify({ f: fingerprint, c: last.createdAt, o: last.origin, i: last.id })).toString("base64url") : null,
    limit: filter.limit,
  };
}
