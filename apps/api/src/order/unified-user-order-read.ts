import { applyOrderUserFacts, readOrderUserFacts } from "./frozen-listing-read";
import { readSettlementStages } from "./settlement-record";
import type { PoolClient } from "pg";
import { conflict, invalid, sha256Hex } from "../supply/supply-util";
import { ORDER_FIELDS, ORDER_FROM, projectOrder, type OrderRow } from "./order";
import { legacyContinuationReady, legacyOrderLifecycleStage, LEGACY_ORDER_STATUS_SQL } from "./legacy-order-read";
import { legacyUserOrderFields, legacyUserOrderFrom, projectUserLegacyOrder, type LegacyUserOrderRow } from "./legacy-user-order-read";

type Filter = { party: "renter" | "owner"; status?: string; accountId?: string; orderNo?: string; createdFrom?: string; createdTo?: string; stage?: string; limit: number; cursor?: string };
type Cursor = { f: string; c: string | null; o: "NATIVE" | "LEGACY"; i: string };
type Row = { origin: "NATIVE" | "LEGACY"; id: string; createdAt: string | null; record: OrderRow | LegacyUserOrderRow };
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const STAGES = ["NONE", "OPENING_PENDING", "RENTING", "INTAKE_PENDING", "DECISION_PENDING", "DECISION_WAITING", "DECISION_REJECTED", "POSTED", "UNKNOWN"];
const SCAN_LIMIT = 500;
function day(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

export function parseUnifiedOrderQuery(query: URLSearchParams): Filter {
  for (const key of query.keys()) {
    if (!["party", "status", "accountId", "orderNo", "createdFrom", "createdTo", "stage", "limit", "cursor"].includes(key) || query.getAll(key).length !== 1) throw invalid("Unsupported order query", key);
  }
  const party = query.get("party") ?? "renter";
  const status = query.get("status"), accountId = query.get("accountId"), cursor = query.get("cursor");
  const orderNo = query.get("orderNo"), createdFrom = query.get("createdFrom"), createdTo = query.get("createdTo"), stage = query.get("stage");
  const rawLimit = query.get("limit") ?? "20", limit = Number(rawLimit);
  if (party !== "renter" && party !== "owner") throw invalid("Party is invalid");
  if (!/^[1-9]\d{0,2}$/.test(rawLimit) || limit > 100) throw invalid("Limit is invalid");
  if (status !== null && !["PENDING_PAYMENT", "PAID", "COMPLETED", "CANCELLED", "UNKNOWN"].includes(status)) throw invalid("Status is invalid");
  if (accountId !== null && !ID.test(accountId)) throw invalid("Account is invalid");
  if (orderNo !== null && (!orderNo || orderNo.length > 255 || orderNo.trim() !== orderNo || /[\u0000-\u001f\u007f]/.test(orderNo))) throw invalid("Order number is invalid");
  if (createdFrom !== null && !day(createdFrom) || createdTo !== null && !day(createdTo) || createdFrom !== null && createdTo !== null && createdFrom > createdTo) throw invalid("Order date range is invalid");
  if (stage !== null && !STAGES.includes(stage)) throw invalid("Order stage is invalid");
  if (cursor !== null && (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor))) throw conflict("Cursor is invalid");
  return { party, limit, ...(status === null ? {} : { status }), ...(accountId === null ? {} : { accountId }), ...(orderNo === null ? {} : { orderNo }), ...(createdFrom === null ? {} : { createdFrom }), ...(createdTo === null ? {} : { createdTo }), ...(stage === null ? {} : { stage }), ...(cursor === null ? {} : { cursor }) };
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
  const binding: unknown[] = ["user-orders-v1", userId, filter.party, filter.status ?? null, filter.accountId ?? null, filter.limit];
  if (filter.orderNo || filter.createdFrom || filter.createdTo || filter.stage) binding.push(filter.orderNo ?? null, filter.createdFrom ?? null, filter.createdTo ?? null, filter.stage ?? null);
  const fingerprint = sha256Hex(JSON.stringify(binding));
  let cursor = decodeCursor(filter.cursor, fingerprint);
  const owner = filter.party === "owner";
  const continuationReady = await legacyContinuationReady(client);
  const readRows = async (position: Cursor | null, limit: number) => (await client.query<Row>(`
    WITH visible_orders AS (
      SELECT 'NATIVE'::text AS origin,n.id,n."createdAt",to_jsonb(n) AS record
      FROM (SELECT ${ORDER_FIELDS} ${ORDER_FROM}
        WHERE ${owner ? "o.owner_user_id" : "o.renter_user_id"}=$1
          AND ($2::text IS NULL OR o.status=$2) AND ($3::text IS NULL OR o.account_id=$3)
          AND ($9::text IS NULL OR strpos(lower(o.display_no),lower($9))>0)
          AND ($10::date IS NULL OR o.created_at>=($10::date::timestamp AT TIME ZONE 'Asia/Shanghai'))
          AND ($11::date IS NULL OR o.created_at<(($11::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))) n
      UNION ALL
      SELECT 'LEGACY'::text AS origin,l.id,l."createdAt",to_jsonb(l) AS record
      FROM (SELECT ${legacyUserOrderFields(continuationReady)} ${legacyUserOrderFrom(continuationReady)}
        WHERE ${owner ? "l.owner_user_id" : "l.renter_user_id"}=$1
          AND ($2::text IS NULL OR (${LEGACY_ORDER_STATUS_SQL})=$2) AND ($3::text IS NULL OR l.account_id=$3)
          AND ($9::text IS NULL OR strpos(lower(l.original_order_no),lower($9))>0)
          AND ($10::date IS NULL OR l.source_created_at>=($10::date::timestamp AT TIME ZONE 'Asia/Shanghai'))
          AND ($11::date IS NULL OR l.source_created_at<(($11::date+1)::timestamp AT TIME ZONE 'Asia/Shanghai'))) l
    )
    SELECT * FROM visible_orders x
    WHERE NOT $4::boolean
      OR ($5::text IS NOT NULL AND (x."createdAt" IS NULL OR x."createdAt"<$5
        OR (x."createdAt"=$5 AND (x.origin COLLATE "C",x.id COLLATE "C")<($6::text COLLATE "C",$7::text COLLATE "C"))))
      OR ($5::text IS NULL AND x."createdAt" IS NULL AND (x.origin COLLATE "C",x.id COLLATE "C")<($6::text COLLATE "C",$7::text COLLATE "C"))
    ORDER BY x."createdAt" DESC NULLS LAST,x.origin COLLATE "C" DESC,x.id COLLATE "C" DESC LIMIT $8
  `, [userId, filter.status ?? null, filter.accountId ?? null, position !== null, position?.c ?? null, position?.o ?? null, position?.i ?? null, limit, filter.orderNo ?? null, filter.createdFrom ?? null, filter.createdTo ?? null])).rows;
  const matched: Row[] = [], stageById = new Map<string, Awaited<ReturnType<typeof readSettlementStages>> extends Map<string, infer T> ? T : never>();
  let scanned = 0, exhausted = false, stageUnknown = false, lastScanned: Row | undefined;
  do {
    const batchSize = filter.stage ? Math.min(100, SCAN_LIMIT - scanned) : filter.limit + 1;
    const rows = await readRows(cursor, batchSize);
    if (!rows.length) { exhausted = true; break; }
    const stages = filter.stage ? await readSettlementStages(client, rows.filter(row => row.origin === "NATIVE").map(row => row.id), userId) : null;
    for (const row of rows) {
      scanned++; lastScanned = row;
      const legacy = row.record as LegacyUserOrderRow;
      const stage = row.origin === "NATIVE" ? stages?.get(row.id) : filter.stage ? legacyOrderLifecycleStage(legacy.continuationStage ?? legacy.sourceOrderStatus, legacy.sourcePayStatus, filter.party) : undefined;
      if (stage && row.origin === "NATIVE") stageById.set(row.id, stage);
      if (filter.stage && (stage?.code ?? "UNKNOWN") === "UNKNOWN") stageUnknown = true;
      if (!filter.stage || (stage?.code ?? "UNKNOWN") === filter.stage) matched.push(row);
      if (matched.length > filter.limit) break;
    }
    if (matched.length > filter.limit) break;
    if (rows.length < batchSize) { exhausted = true; break; }
    if (lastScanned) cursor = { f: fingerprint, c: lastScanned.createdAt, o: lastScanned.origin, i: lastScanned.id };
  } while (filter.stage && scanned < SCAN_LIMIT);
  const page = matched.slice(0, filter.limit);
  const last = page[page.length - 1];
  const items: Record<string, unknown>[] = page.map(row => row.origin === "NATIVE"
    ? { ...projectOrder(row.record as OrderRow, filter.party), source: { origin: "NATIVE" as const }, readOnly: false }
    : projectUserLegacyOrder(row.record as LegacyUserOrderRow, userId, filter.party));
  // B2: page-batched frozen listing facts (raw rows carry accountId even when the projection hides it).
  const facts = await readOrderUserFacts(client, userId, page.map(row => {
    const r = row.record as { accountId?: string | null; versionId?: string | null; contentHash?: string | null; ownerUserId?: string | null };
    return { origin: row.origin as "NATIVE" | "LEGACY", orderId: row.id, accountId: r.accountId ?? null, versionId: r.versionId ?? null, contentHash: r.contentHash ?? null, ownerUserId: r.ownerUserId ?? null };
  }));
  page.forEach((row, index) => applyOrderUserFacts(items[index]!, facts.get(`${row.origin}:${row.id}`)));
  const stages = filter.stage ? stageById : await readSettlementStages(client, page.filter(row => row.origin === "NATIVE").map(row => row.id), userId);
  page.forEach((row, index) => { if (row.origin === "NATIVE") items[index]!.stage = stages.get(row.id) ?? null; });
  const next = matched.length > filter.limit ? last : !exhausted ? lastScanned : undefined;
  return {
    subjectId: userId,
    items,
    nextCursor: next ? Buffer.from(JSON.stringify({ f: fingerprint, c: next.createdAt, o: next.origin, i: next.id })).toString("base64url") : null,
    ...(filter.stage && !exhausted && matched.length <= filter.limit ? { scanIncomplete: true } : {}),
    ...(filter.stage && stageUnknown ? { stageUnknownObserved: true } : {}),
    limit: filter.limit,
  };
}
