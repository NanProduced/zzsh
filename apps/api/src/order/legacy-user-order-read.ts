import { applyOrderUserFacts, readOrderUserFacts } from "./frozen-listing-read";
import type { PoolClient } from "pg";
import { invalid, notFound, sha256Hex } from "../supply/supply-util";
import { centsToYuan } from "./order";
import { publicAccountNumber } from "../supply/account-number";
import { declaredTitleOrNull } from "../supply/publishing";
import { canonicalize } from "../supply/content-hash";
import { historicalObservationDisplay, typedHistoricalOrderReference } from "../finance/legacy-observation-display";
import { legacyContinuationReady, legacyEpochTimestamp, legacyMoneyCents, legacyOrderLifecycleStage, legacyOrderReadState, LEGACY_CONTINUATION_CANCELLED_AT_SQL, LEGACY_CONTINUATION_COMPLETED_AT_SQL, LEGACY_ORDER_STATUS_SQL } from "./legacy-order-read";

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
    legacyAmounts: renter ? { required: money(row.dueCents), paid: paidYuan, paidState, deposit: money(row.depositCents), goods: money(goods), items: money(items), refund: money(legacyMoneyCents(row.refundYuan)), refundChannelState: legacyRefundChannelState(row) } : null,
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
 ${utc("l.source_created_at")} AS "createdAt",${utc("l.source_paid_at")} AS "paidAt",${utc(continuationReady ? LEGACY_CONTINUATION_CANCELLED_AT_SQL : "l.source_cancelled_at")} AS "cancelledAt",${utc(continuationReady ? LEGACY_CONTINUATION_COMPLETED_AT_SQL : "l.source_completed_at")} AS "completedAt",
 l.due_amount_cents::text AS "dueCents",l.recorded_paid_amount_cents::text AS "paidCents",l.deposit_amount_cents::text AS "depositCents",
 l.source_snapshot->>'goods_money' AS "goodsYuan",l.source_snapshot->>'expend_pay_money' AS "itemsYuan",l.source_snapshot->>'return_order_money' AS "refundYuan",
 l.source_snapshot->>'sale_earnings' AS "saleEarningsYuan",l.source_snapshot->>'full_payout_money' AS "fullPayoutFeeYuan",
 l.source_snapshot->>'expend_haff' AS "expendHaff",l.source_snapshot->>'awm_bullet_num' AS "awmBulletNum",l.source_snapshot->>'level6_bullet_num' AS "level6BulletNum",
 l.source_snapshot->>'level6_helmet_num' AS "level6HelmetNum",l.source_snapshot->>'level6_armor_num' AS "level6ArmorNum",l.source_snapshot->>'top_insure_card_num' AS "topInsureCardNum",
 l.source_snapshot->>'barrett_bullet_num' AS "barrettBulletNum",l.source_snapshot->>'coffee_num' AS "coffeeNum",l.source_snapshot->>'tenancy_deadline' AS "rentalDeadlineSource"`; }
export function legacyUserOrderFrom(continuationReady: boolean): string { return `FROM (SELECT * FROM zzsh_order.legacy_order_read_snapshot WHERE COALESCE(source_snapshot->>'is_delete','0')='0') l LEFT JOIN zzsh_supply.rental_account a ON a.id=l.account_id
 ${continuationReady ? `LEFT JOIN zzsh_order.legacy_continuation_version h ON h.order_id=l.id AND h.superseded_at IS NULL` : `LEFT JOIN (SELECT NULL::text AS order_id,NULL::int AS stage) h ON h.order_id=l.id`}
 LEFT JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id AND v.account_id=a.id`; }

type LegacyFinanceHistoryRow = {
  legacy_id: string; legacy_renter_id: string; renter_user_id: string; observation_user_id: string | null;
  order_no: string; order_digest: string; order_snapshot: Record<string, unknown>;
  source_id: string | null; source_digest: string | null; source_canonical: string | null;
  snapshot: Record<string, any> | null; source_at: string | null;
};

/** Payment attempts are old business records, not proof of a channel or bank outcome. */
export function projectLegacyPaymentHistory(rows: LegacyFinanceHistoryRow[], userId: string) {
  const records: { id: string; amount: ReturnType<typeof centsToYuan>; status: "RECORDED_PAID" | "RECORDED_UNPAID" | "UNKNOWN";
    method: "WECHAT" | "ALIPAY" | "UNKNOWN"; recordedAt: string | null; paidAt: string | null }[] = [];
  let incomplete = rows.length > 50;
  for (const row of rows.slice(0, 50)) {
    if (row.source_id === null) continue;
    try {
      const s = row.snapshot!, raw = { source_type: "LEGACY_MYSQL", source_system: "legacy_mysql_restore", source_entity: "la_pay_order",
        source_id: row.source_id, source_digest: row.source_digest, source_status: s.sourceStatus, amount: s.amount, at: row.source_at,
        extra_evidence: { snapshot: s, canonical: row.source_canonical, legacyUserId: row.legacy_renter_id } };
      const display = historicalObservationDisplay(raw), original = JSON.parse(s.rawSource.canonical);
      if (row.renter_user_id !== userId || row.observation_user_id !== userId
        || sha256Hex(canonicalize(row.order_snapshot)) !== row.order_digest || String(row.order_snapshot.id) !== row.legacy_id
        || String(row.order_snapshot.user_id) !== row.legacy_renter_id || row.order_snapshot.order_sn !== row.order_no
        || typedHistoricalOrderReference(raw) !== row.legacy_id || display.amountSemantics !== "BUSINESS_RECORD" || display.recordedAmountCents === null
        || String(original.order_id) !== row.legacy_id || String(original.order_type) !== "1"
        || String(original.create_time) !== String(s.createdAt)
        || String(s.sourcePaidAt ?? "") !== String(original.pay_time ?? "")
        || !row.source_at || Date.parse(row.source_at) !== Date.parse(legacyEpochTimestamp(String(s.createdAt)) ?? "")) throw new Error("LEGACY_PAYMENT_BINDING_UNAVAILABLE");
      const status = String(s.sourceStatus) === "1" ? "RECORDED_PAID" : String(s.sourceStatus) === "0" ? "RECORDED_UNPAID" : "UNKNOWN";
      const method = display.payWay === "2" ? "WECHAT" : display.payWay === "3" ? "ALIPAY" : "UNKNOWN";
      records.push({ id: row.source_id, amount: centsToYuan(display.recordedAmountCents), status, method,
        recordedAt: row.source_at, paidAt: status === "RECORDED_PAID" ? legacyEpochTimestamp(String(s.sourcePaidAt ?? "")) : null });
    } catch { incomplete = true; }
  }
  return { records, incomplete, coverage: "MATCHED_RECORDS_ONLY" as const, channelArrival: "UNKNOWN" as const };
}

export async function readLegacyPaymentHistory(client: PoolClient, userId: string, orderId: string) {
  const ready = (await client.query(`SELECT c.oid IS NOT NULL AND NOT c.relrowsecurity
    AND has_table_privilege(current_user,c.oid,'SELECT') AS ready FROM (SELECT to_regclass('zzsh_order.personal_finance_observation') AS oid) t
    LEFT JOIN pg_class c ON c.oid=t.oid`)).rows[0]?.ready === true;
  if (!ready) return { records: [], incomplete: true, coverage: "MATCHED_RECORDS_ONLY" as const, channelArrival: "UNKNOWN" as const };
  const result = await client.query<LegacyFinanceHistoryRow>(`SELECT l.legacy_id,l.legacy_renter_id,l.renter_user_id,o.user_id AS observation_user_id,l.original_order_no AS order_no,
      l.source_digest AS order_digest,l.source_snapshot AS order_snapshot,o.source_id,o.source_digest,o.source_canonical,o.snapshot,
      ${utc("o.source_event_at")} AS source_at
    FROM zzsh_order.legacy_order_read_snapshot l
    LEFT JOIN LATERAL (SELECT x.user_id,x.source_id,x.source_digest,x.source_canonical,x.snapshot,x.source_event_at
      FROM zzsh_order.personal_finance_observation x
      WHERE x.user_id=$1 AND x.legacy_user_id=l.legacy_renter_id AND x.source_type='LEGACY_MYSQL'
        AND x.source_system=l.source_system AND x.source_entity='la_pay_order' AND x.source_kind='HISTORICAL_PAYMENT'
        AND x.snapshot->>'referenceId'=l.legacy_id
      ORDER BY x.source_event_at,x.source_id LIMIT 51) o ON true
    WHERE l.id=$2 AND l.renter_user_id=$1 AND l.source_system='legacy_mysql_restore' AND l.source_entity='la_order'`, [userId, orderId]);
  return projectLegacyPaymentHistory(result.rows, userId);
}

/** Original refund observations are display-only and never change the order or the wallet. */
export function projectLegacyRefundHistory(rows: LegacyFinanceHistoryRow[], userId: string) {
  const records: { id: string; amount: ReturnType<typeof centsToYuan>; status: "PROCESSING" | "SUCCEEDED" | "FAILED" | "UNKNOWN"; recordedAt: string | null }[] = [];
  let incomplete = rows.length > 50;
  for (const row of rows.slice(0, 50)) {
    if (row.source_id === null) continue;
    try {
      const s = row.snapshot!, raw = { source_type: "LEGACY_MYSQL", source_system: "legacy_mysql_restore", source_entity: "la_refund_record",
        source_id: row.source_id, source_digest: row.source_digest, source_status: s.sourceStatus, amount: s.amount, at: row.source_at,
        extra_evidence: { snapshot: s, canonical: row.source_canonical, legacyUserId: row.legacy_renter_id } };
      const display = historicalObservationDisplay(raw), original = JSON.parse(s.rawSource.canonical);
      if (row.renter_user_id !== userId || row.observation_user_id !== userId
        || sha256Hex(canonicalize(row.order_snapshot)) !== row.order_digest || String(row.order_snapshot.id) !== row.legacy_id
        || String(row.order_snapshot.user_id) !== row.legacy_renter_id || row.order_snapshot.order_sn !== row.order_no
        || typedHistoricalOrderReference(raw) !== row.legacy_id || display.amountSemantics !== "BUSINESS_RECORD" || display.recordedAmountCents === null
        || s.referenceSn !== row.order_no || String(original.order_id) !== row.legacy_id || original.order_sn !== row.order_no
        || String(original.user_id) !== row.legacy_renter_id || original.order_type !== "order"
        || !row.source_at || Date.parse(row.source_at) !== Date.parse(legacyEpochTimestamp(String(s.createdAt)) ?? "")) throw new Error("LEGACY_REFUND_BINDING_UNAVAILABLE");
      const status = ({ "0": "PROCESSING", "1": "SUCCEEDED", "2": "FAILED" } as const)[String(s.sourceStatus) as "0" | "1" | "2"] ?? "UNKNOWN";
      if (Array.isArray(s.sourceRefundFlags) && s.sourceRefundFlags.length > 0) incomplete = true;
      records.push({ id: row.source_id, amount: centsToYuan(display.recordedAmountCents), status, recordedAt: row.source_at });
    } catch { incomplete = true; }
  }
  return { records, incomplete, coverage: "MATCHED_RECORDS_ONLY" as const, channelArrival: "UNKNOWN" as const };
}

export async function readLegacyRefundHistory(client: PoolClient, userId: string, orderId: string) {
  const ready = (await client.query(`SELECT c.oid IS NOT NULL AND NOT c.relrowsecurity
    AND has_table_privilege(current_user,c.oid,'SELECT') AS ready FROM (SELECT to_regclass('zzsh_order.personal_finance_observation') AS oid) t
    LEFT JOIN pg_class c ON c.oid=t.oid`)).rows[0]?.ready === true;
  if (!ready) return { records: [], incomplete: true, coverage: "MATCHED_RECORDS_ONLY" as const, channelArrival: "UNKNOWN" as const };
  const result = await client.query<LegacyFinanceHistoryRow>(`SELECT l.legacy_id,l.legacy_renter_id,l.renter_user_id,o.user_id AS observation_user_id,l.original_order_no AS order_no,
      l.source_digest AS order_digest,l.source_snapshot AS order_snapshot,o.source_id,o.source_digest,o.source_canonical,o.snapshot,
      ${utc("o.source_event_at")} AS source_at
    FROM zzsh_order.legacy_order_read_snapshot l
    LEFT JOIN LATERAL (SELECT x.user_id,x.source_id,x.source_digest,x.source_canonical,x.snapshot,x.source_event_at
      FROM zzsh_order.personal_finance_observation x
      WHERE x.user_id=$1 AND x.legacy_user_id=l.legacy_renter_id AND x.source_type='LEGACY_MYSQL'
        AND x.source_system=l.source_system AND x.source_entity='la_refund_record' AND x.source_kind='HISTORICAL_REFUND'
        AND (x.snapshot->>'referenceId'=l.legacy_id OR x.snapshot->>'referenceSn'=l.original_order_no)
      ORDER BY x.source_event_at,x.source_id LIMIT 51) o ON true
    WHERE l.id=$2 AND l.renter_user_id=$1 AND l.source_system='legacy_mysql_restore' AND l.source_entity='la_order'`, [userId, orderId]);
  return projectLegacyRefundHistory(result.rows, userId);
}

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
  if (row.renterUserId === userId) {
    order.legacyPaymentHistory = await readLegacyPaymentHistory(client, userId, id);
    order.legacyRefundHistory = await readLegacyRefundHistory(client, userId, id);
  }
  const facts = await readOrderUserFacts(client, userId, [{ origin: "LEGACY", orderId: row.id, accountId: row.accountId ?? null, ownerUserId: row.ownerUserId }]);
  applyOrderUserFacts(order, facts.get(`LEGACY:${row.id}`));
  return { order };
}
