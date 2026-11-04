import { applyOrderUserFacts, readOrderUserFacts } from "./frozen-listing-read";
import type { PoolClient } from "pg";
import { invalid, notFound } from "../supply/supply-util";
import { centsToYuan } from "./order";
import { publicAccountNumber } from "../supply/account-number";
import { declaredTitleOrNull } from "../supply/publishing";
import { legacyContinuationReady, legacyEpochTimestamp, legacyMoneyCents, legacyOrderLifecycleStage, legacyOrderReadState, LEGACY_CONTINUATION_COMPLETED_AT_SQL, LEGACY_ORDER_STATUS_SQL } from "./legacy-order-read";

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

type LegacyOrderResourceRow = {
  expendHaff?: string | null; awmBulletNum?: string | null; level6BulletNum?: string | null;
  level6HelmetNum?: string | null; level6ArmorNum?: string | null; topInsureCardNum?: string | null;
  barrettBulletNum?: string | null; coffeeNum?: string | null; rentalDeadlineSource?: string | null;
};
export type LegacyUserOrderRow = LegacyOrderResourceRow & {
  id: string; displayNo: string; sourceOrderStatus: number; sourcePayStatus: number; continuationStage?: number | null;
  ownerUserId: string; renterUserId: string; gameId: string; title: string | null;
  accountId: string; accountDisplayNo: string | null; accountReadable: boolean;
  createdAt: string | null; paidAt: string | null; cancelledAt: string | null; completedAt: string | null;
  dueCents: string | null; paidCents: string | null; depositCents: string | null;
  goodsYuan: string | null; itemsYuan: string | null; refundYuan: string | null;
  saleEarningsYuan?: string | null; fullPayoutFeeYuan?: string | null;
  sourceDeletedFlag?: string | null;
};
const RESOURCE_FIELDS = [
  ["expendHaff", "df_billable_haff", null],
  ["awmBulletNum", "df_billable_awm_bullet", null],
  ["level6BulletNum", "df_billable_level6_bullet", null],
  ["level6HelmetNum", "df_billable_level6_helmet", null],
  ["level6ArmorNum", "df_billable_level6_armor", null],
  ["topInsureCardNum", "df_billable_top_insure_card", "DAY"],
  ["barrettBulletNum", "df_billable_barrett_bullet", null],
  ["coffeeNum", "df_billable_coffee", null],
] as const;
export function legacyUserOrderResources(row: LegacyOrderResourceRow) {
  return RESOURCE_FIELDS.flatMap(([field, code, unit]) => {
    const quantity = row[field];
    if (quantity === null || quantity === undefined) return [];
    if (field === "expendHaff") legacyMoneyCents(quantity);
    else if (!/^(0|[1-9]\d{0,23})$/.test(quantity)) throw invalid("Legacy order resource quantity is invalid", field);
    return [{ code, quantity, unit }];
  });
}
const money = (value: string | null) => value === null ? null : centsToYuan(value);

/** The refund-channel evidence states a legacy order can truthfully have. */
export type LegacyChannelEvidenceState = "NOT_RECORDED_BY_SOURCE" | "PENDING" | "UNKNOWN";
/**
 * la_order/la_pay_order carry transfer_time only — the legacy source never recorded a settlement-channel
 * receipt (no payment_no/global_no). "The source has no such record" is therefore not "waiting for
 * confirmation": it is NOT_RECORDED_BY_SOURCE. PENDING is reserved for the case where this platform
 * itself holds the order's settlement document and that document is not final yet (an imported
 * continuation head in 待验号/待确认额外消耗/待卖家确认/待买家确认), so a local result is still owed.
 */
function legacyRefundChannelState(row: LegacyUserOrderRow): LegacyChannelEvidenceState {
  const stage = row.continuationStage;
  return stage !== null && stage !== undefined && [6, 7, 8, 9].includes(stage) ? "PENDING" : "NOT_RECORDED_BY_SOURCE";
}
/** Why payment.recordedAmount is or is not a number, so a null amount is never rendered as "pending". */
export type LegacyRecordedAmountState = "RECORDED" | "NOT_RETAINED" | "NOT_VISIBLE_FOR_ROLE" | "NOT_PAID" | "UNKNOWN";
/** The renter-side reading of legacyAmounts.paid. */
export type LegacyPaidState = "RECORDED" | "NOT_RETAINED" | "NOT_PAID" | "UNKNOWN";

function legacyOwnerRecordedIncome(row: LegacyUserOrderRow) {
  if (row.sourceOrderStatus !== 4 || row.sourcePayStatus !== 1) return null;
  try {
    const gross = legacyMoneyCents(row.saleEarningsYuan), fee = legacyMoneyCents(row.fullPayoutFeeYuan);
    return gross !== null && fee !== null && BigInt(gross) >= BigInt(fee) && BigInt(fee) >= 0n
      ? centsToYuan(BigInt(gross) - BigInt(fee)) : null;
  } catch { return null; }
}
export function projectUserLegacyOrder(row: LegacyUserOrderRow, userId: string, requestedParty?: "renter" | "owner") {
  if (row.sourceDeletedFlag != null && row.sourceDeletedFlag !== "0") throw notFound();
  const party = requestedParty === "owner" ? (row.ownerUserId === userId ? "owner" : null)
    : row.renterUserId === userId ? "renter" : requestedParty !== "renter" && row.ownerUserId === userId ? "owner" : null;
  if (!party) throw notFound();
  const state = legacyOrderReadState(row.continuationStage ?? row.sourceOrderStatus, row.sourcePayStatus);
  const goods = legacyMoneyCents(row.goodsYuan), items = legacyMoneyCents(row.itemsYuan);
  const renter = party === "renter";
  const paid = renter && state.paymentState === "RECORDED_PAID" ? money(row.paidCents) : null;
  // A recorded payment must never leave the amount ambiguous: either it is a number, or the projection
  // says why it is absent instead of letting the reader render null as "待确认".
  const recordedAmountState: LegacyRecordedAmountState = state.paymentState === "RECORDED_UNPAID" ? "NOT_PAID"
    : state.paymentState !== "RECORDED_PAID" ? "UNKNOWN"
      : !renter ? "NOT_VISIBLE_FOR_ROLE"
        : paid === null ? "NOT_RETAINED" : "RECORDED";
  // RECORDED_UNPAID is a source fact ("the source recorded no payment"), not a missing value: expose an
  // explicit zero so 已付金额 cannot be shown as "待确认", and keep paidState for the same distinction.
  const paidYuan = state.paymentState === "RECORDED_UNPAID" ? centsToYuan("0") : paid;
  const paidState: LegacyPaidState = state.paymentState === "RECORDED_UNPAID" ? "NOT_PAID"
    : state.paymentState !== "RECORDED_PAID" ? "UNKNOWN"
      : paidYuan === null ? "NOT_RETAINED" : "RECORDED";
  const ownerRecordedIncome = renter ? null : legacyOwnerRecordedIncome(row);
  return {
    // Only a real current title crosses this boundary. Without one the field stays null, so readers can fall
    // back to the frozen order resource summary instead of being blocked by fabricated placeholder text.
    id: row.id, displayNo: row.displayNo, status: state.status, party, title: row.accountReadable ? declaredTitleOrNull(row.title) : null, gameId: row.gameId,
    stage: legacyOrderLifecycleStage(row.continuationStage ?? row.sourceOrderStatus, row.sourcePayStatus, party),
    source: { origin: "LEGACY" as const, ruleOrigin: "LEGACY_ORDER" as const, originalStatus: row.sourceOrderStatus, originalPayStatus: row.sourcePayStatus, statusLabel: state.statusLabel },
    createdAt: row.createdAt, paidAt: row.paidAt, cancelledAt: row.cancelledAt, completedAt: row.completedAt,
    amounts: { rental: renter && goods !== null && items !== null ? centsToYuan(BigInt(goods) + BigInt(items)) : null,
      deposit: renter ? money(row.depositCents) : null, totalDue: renter ? money(row.dueCents) : null, currency: "CNY" as const,
      ...(!renter ? { ownerExpectedIncome: null, ownerRecordedIncome } : {}) },
    amountsPerspective: renter ? "RENTER" : "OWNER",
    ...(!renter ? { ownerIncomeSource: ownerRecordedIncome === null ? null : { source: "LEGACY_ORDER_SNAPSHOT", sourceLabel: "旧平台原单净收益记录" } } : {}),
    payment: { state: state.paymentState, recordedAt: row.paidAt, recordedAmount: paid, recordedAmountState },
    legacyAmounts: renter ? { required: money(row.dueCents), paid: paidYuan, paidState, deposit: money(row.depositCents), refund: money(legacyMoneyCents(row.refundYuan)), refundChannelState: legacyRefundChannelState(row) } : null,
    account: { id: row.accountReadable ? row.accountId : null, displayNo: row.accountReadable ? publicAccountNumber(row.accountDisplayNo) : null, readable: row.accountReadable },
    orderFacts: { resources: legacyUserOrderResources(row), rentalDeadlineAt: legacyEpochTimestamp(row.rentalDeadlineSource) },
    readOnly: true as const, paymentOpen: false as const, cancelOpen: false as const, continuationCount: 0 as const, actions: [] as never[],
  };
}
const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
// Only selected historical facts enter the user projection. No counterparty/contact/credential/audit JSON is loaded.
export function legacyUserOrderFields(continuationReady: boolean): string { return `l.id,l.original_order_no AS "displayNo",l.source_order_status AS "sourceOrderStatus",l.source_pay_status AS "sourcePayStatus",h.stage AS "continuationStage",l.source_snapshot->>'is_delete' AS "sourceDeletedFlag",
 l.owner_user_id AS "ownerUserId",l.renter_user_id AS "renterUserId",l.game_id AS "gameId",CASE WHEN a.owner_user_id=$1 THEN v.title ELSE NULL END AS title,
 l.account_id AS "accountId",a.display_no AS "accountDisplayNo",COALESCE(a.owner_user_id=$1,false) AS "accountReadable",
 ${utc("l.source_created_at")} AS "createdAt",${utc("l.source_paid_at")} AS "paidAt",${utc("l.source_cancelled_at")} AS "cancelledAt",${utc(continuationReady ? LEGACY_CONTINUATION_COMPLETED_AT_SQL : "l.source_completed_at")} AS "completedAt",
 l.due_amount_cents::text AS "dueCents",l.recorded_paid_amount_cents::text AS "paidCents",l.deposit_amount_cents::text AS "depositCents",
 l.source_snapshot->>'goods_money' AS "goodsYuan",l.source_snapshot->>'expend_pay_money' AS "itemsYuan",l.source_snapshot->>'return_order_money' AS "refundYuan",
 l.source_snapshot->>'sale_earnings' AS "saleEarningsYuan",l.source_snapshot->>'full_payout_money' AS "fullPayoutFeeYuan",
 l.source_snapshot->>'expend_haff' AS "expendHaff",l.source_snapshot->>'awm_bullet_num' AS "awmBulletNum",l.source_snapshot->>'level6_bullet_num' AS "level6BulletNum",
 l.source_snapshot->>'level6_helmet_num' AS "level6HelmetNum",l.source_snapshot->>'level6_armor_num' AS "level6ArmorNum",l.source_snapshot->>'top_insure_card_num' AS "topInsureCardNum",
 l.source_snapshot->>'barrett_bullet_num' AS "barrettBulletNum",l.source_snapshot->>'coffee_num' AS "coffeeNum",l.source_snapshot->>'tenancy_deadline' AS "rentalDeadlineSource"`; }
export function legacyUserOrderFrom(continuationReady: boolean): string { return `FROM (SELECT * FROM zzsh_order.legacy_order_read_snapshot WHERE COALESCE(source_snapshot->>'is_delete','0')='0') l LEFT JOIN zzsh_supply.rental_account a ON a.id=l.account_id
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
  return { items: result.items.map(row => projectUserLegacyOrder(row, userId, filter.party)), page: filter.page, pageSize: filter.pageSize, total: Number(result.total) };
}
export async function getUserLegacyOrder(client: PoolClient, userId: string, id: string) {
  const continuationReady = await legacyContinuationReady(client);
  const row = (await client.query<LegacyUserOrderRow>(`SELECT ${legacyUserOrderFields(continuationReady)} ${legacyUserOrderFrom(continuationReady)} WHERE l.id=$2 AND (l.owner_user_id=$1 OR l.renter_user_id=$1)`, [userId, id])).rows[0];
  if (!row) throw notFound();
  const order: Record<string, unknown> = projectUserLegacyOrder(row, userId);
  const facts = await readOrderUserFacts(client, userId, [{ origin: "LEGACY", orderId: row.id, accountId: row.accountId ?? null, ownerUserId: row.ownerUserId }]);
  applyOrderUserFacts(order, facts.get(`LEGACY:${row.id}`));
  return { order };
}
