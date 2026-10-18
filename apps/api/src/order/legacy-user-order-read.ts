import type { PoolClient } from "pg";
import { invalid, notFound } from "../supply/supply-util";
import { centsToYuan } from "./order";
import { publicAccountNumber } from "../supply/account-number";
import { legacyContinuationReady, legacyMoneyCents, legacyOrderReadState, LEGACY_ORDER_STATUS_SQL } from "./legacy-order-read";

export type LegacyUserOrderFilter = {
  party: "renter" | "owner";
  page: number;
  pageSize: number;
  status?: string;
  accountId?: string;
};
export function parseLegacyUserOrderQuery(query: URLSearchParams): LegacyUserOrderFilter {
  for (const key of query.keys()) {
    if (!["party", "page", "pageSize", "status", "accountId"].includes(key) || query.getAll(key).length !== 1) throw invalid("Unsupported historical order query", key);
  }
  const party = query.get("party") ?? "renter";
  if (party !== "renter" && party !== "owner") throw invalid("Party is invalid");
  const number = (key: string, fallback: number) => {
    const raw = query.get(key);
    if (raw !== null && !/^[1-9]\d{0,8}$/.test(raw)) throw invalid("Pagination is invalid", key);
    return raw === null ? fallback : Number(raw);
  };
  const page = number("page", 1), pageSize = number("pageSize", 20);
  if (pageSize > 100) throw invalid("Page size is invalid", "pageSize");
  const status = query.get("status"), accountId = query.get("accountId");
  if (status !== null && !["PENDING_PAYMENT", "PAID", "CANCELLED", "COMPLETED", "UNKNOWN"].includes(status)) throw invalid("Status is invalid");
  if (accountId !== null && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(accountId)) throw invalid("Account is invalid");
  return { party, page, pageSize, ...(status === null ? {} : { status }), ...(accountId === null ? {} : { accountId }) };
}

export type LegacyUserOrderRow = {
  id: string; displayNo: string; sourceOrderStatus: number; sourcePayStatus: number; continuationStage?: number | null;
  ownerUserId: string; renterUserId: string; gameId: string; title: string | null;
  accountId: string; accountDisplayNo: string | null; accountReadable: boolean;
  createdAt: string | null; paidAt: string | null; cancelledAt: string | null; completedAt: string | null;
  dueCents: string | null; paidCents: string | null; depositCents: string | null;
  goodsYuan: string | null; itemsYuan: string | null; refundYuan: string | null;
};
const money = (value: string | null) => value === null ? null : centsToYuan(value);
export function projectUserLegacyOrder(row: LegacyUserOrderRow, userId: string) {
  const party = row.renterUserId === userId ? "renter" : row.ownerUserId === userId ? "owner" : null;
  if (!party) throw notFound();
  const state = legacyOrderReadState(row.continuationStage ?? row.sourceOrderStatus, row.sourcePayStatus);
  const goods = legacyMoneyCents(row.goodsYuan), items = legacyMoneyCents(row.itemsYuan);
  const paid = state.paymentState === "RECORDED_PAID" ? money(row.paidCents) : null;
  return {
    id: row.id, displayNo: row.displayNo, status: state.status, party, title: row.accountReadable ? row.title ?? "账号资料暂未提供" : "账号资料暂未提供", gameId: row.gameId,
    source: { origin: "LEGACY" as const, ruleOrigin: "LEGACY_ORDER" as const, originalStatus: row.sourceOrderStatus, originalPayStatus: row.sourcePayStatus, statusLabel: state.statusLabel },
    createdAt: row.createdAt, paidAt: row.paidAt, cancelledAt: row.cancelledAt, completedAt: row.completedAt,
    amounts: { rental: goods === null || items === null ? null : centsToYuan(BigInt(goods) + BigInt(items)), deposit: money(row.depositCents), totalDue: money(row.dueCents), currency: "CNY" as const },
    payment: { state: state.paymentState, recordedAt: row.paidAt, recordedAmount: paid },
    legacyAmounts: { required: money(row.dueCents), paid, deposit: money(row.depositCents), refund: money(legacyMoneyCents(row.refundYuan)), refundChannelState: "UNKNOWN" as const },
    account: { id: row.accountReadable ? row.accountId : null, displayNo: row.accountReadable ? publicAccountNumber(row.accountDisplayNo) : null, readable: row.accountReadable },
    readOnly: true as const, paymentOpen: false as const, cancelOpen: false as const, continuationCount: 0 as const, actions: [] as never[],
  };
}
const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// Only selected historical facts enter the user projection. No counterparty/contact/credential/audit JSON is loaded.
export function legacyUserOrderFields(continuationReady: boolean): string { return `l.id,l.original_order_no AS "displayNo",l.source_order_status AS "sourceOrderStatus",l.source_pay_status AS "sourcePayStatus",h.stage AS "continuationStage",
 l.owner_user_id AS "ownerUserId",l.renter_user_id AS "renterUserId",l.game_id AS "gameId",CASE WHEN a.owner_user_id=$1 THEN v.title ELSE NULL END AS title,
 l.account_id AS "accountId",a.display_no AS "accountDisplayNo",COALESCE(a.owner_user_id=$1,false) AS "accountReadable",
 ${utc("l.source_created_at")} AS "createdAt",${utc("l.source_paid_at")} AS "paidAt",${utc("l.source_cancelled_at")} AS "cancelledAt",${utc(continuationReady ? `COALESCE((SELECT created_at FROM zzsh_order.legacy_continuation_version WHERE order_id=l.id AND command='CONFIRM' ORDER BY revision DESC LIMIT 1),l.source_completed_at)` : "l.source_completed_at")} AS "completedAt",
 l.due_amount_cents::text AS "dueCents",l.recorded_paid_amount_cents::text AS "paidCents",l.deposit_amount_cents::text AS "depositCents",
 l.source_snapshot->>'goods_money' AS "goodsYuan",l.source_snapshot->>'expend_pay_money' AS "itemsYuan",l.source_snapshot->>'return_order_money' AS "refundYuan"`; }
export function legacyUserOrderFrom(continuationReady: boolean): string { return `FROM zzsh_order.legacy_order_read_snapshot l LEFT JOIN zzsh_supply.rental_account a ON a.id=l.account_id
 ${continuationReady ? `LEFT JOIN zzsh_order.legacy_continuation_version h ON h.order_id=l.id AND h.superseded_at IS NULL` : `LEFT JOIN (SELECT NULL::text AS order_id,NULL::int AS stage) h ON h.order_id=l.id`}
 LEFT JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id AND v.account_id=a.id`; }

export async function listUserLegacyOrders(client: PoolClient, userId: string, filter: LegacyUserOrderFilter) {
  const continuationReady = await legacyContinuationReady(client);
  const result = (await client.query<{ total: string; items: LegacyUserOrderRow[] }>(
    `WITH filtered AS (SELECT ${legacyUserOrderFields(continuationReady)} ${legacyUserOrderFrom(continuationReady)}
      WHERE ${filter.party === "renter" ? "l.renter_user_id" : "l.owner_user_id"}=$1
       AND ($2::text IS NULL OR (${LEGACY_ORDER_STATUS_SQL})=$2) AND ($3::text IS NULL OR l.account_id=$3)),
    paged AS (SELECT * FROM filtered ORDER BY "createdAt" DESC NULLS LAST,id DESC LIMIT $4 OFFSET $5)
    SELECT (SELECT count(*)::text FROM filtered) AS total,
      COALESCE((SELECT jsonb_agg(p ORDER BY p."createdAt" DESC NULLS LAST,p.id DESC) FROM paged p),'[]'::jsonb) AS items`,
    [userId, filter.status ?? null, filter.accountId ?? null, filter.pageSize, (filter.page - 1) * filter.pageSize],
  )).rows[0]!;
  return { items: result.items.map(row => projectUserLegacyOrder(row, userId)), page: filter.page, pageSize: filter.pageSize, total: Number(result.total) };
}
export async function getUserLegacyOrder(client: PoolClient, userId: string, id: string) {
  const continuationReady = await legacyContinuationReady(client);
  const row = (await client.query<LegacyUserOrderRow>(`SELECT ${legacyUserOrderFields(continuationReady)} ${legacyUserOrderFrom(continuationReady)} WHERE l.id=$2 AND (l.owner_user_id=$1 OR l.renter_user_id=$1)`, [userId, id])).rows[0];
  if (!row) throw notFound();
  return { order: projectUserLegacyOrder(row, userId) };
}
