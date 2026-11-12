import type { INestApplication } from "@nestjs/common";
import type { PoolClient } from "pg";

import { ADMIN_PERMISSION, type EffectiveAdminAccess } from "./admin-authorization";
import { gameScopeSql, readAdminGameScope, scopeIsEmpty, type AdminGameScope } from "./admin-scope";
import { assertAdminContextInTransaction, readAdminContext, type AuthSecurityOptions } from "./auth-security";
import { withDirectoryRead, withDirectoryReadTransaction } from "./user-directory-read";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { requireAdminAccess, safely, type SupplyResponse } from "../supply/supply-routes";
import { forbidden, headerValue, invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { LEGACY_ORDER_STATUS_SQL } from "../order/legacy-order-read";

export type OverviewRange = "today" | "7d" | "30d";
export type OverviewMetric = {
  id: string;
  value: string | null;
  unit: "COUNT" | "CNY_CENTS";
  state: "KNOWN" | "PARTIAL" | "FORBIDDEN" | "NO_GAME_SCOPE" | "UNAVAILABLE";
  coverage?: { knownCount: number; totalCount: number };
  drilldown: string | null;
};
export type AdminOverviewOptions = AuthSecurityOptions & { imAppId?: string };
export type OverviewViewer = { adminId: string; access: EffectiveAdminAccess; scope: AdminGameScope; imAppId?: string };
export type Trend = { date: string; orders: string; payments: string; confirmedCents: string | null };
export const LEGACY_BUSINESS_ORDER_SQL = "l.source_entity='la_order' AND COALESCE(l.source_snapshot->>'is_delete','0')='0'";
export const LEGACY_BUSINESS_PAYMENT_SQL = `${LEGACY_BUSINESS_ORDER_SQL} AND l.source_pay_status=1`;
export function legacyBusinessOrderHeadSql(ready: boolean): string {
  return ready
    ? "LEFT JOIN zzsh_order.legacy_continuation_version h ON h.order_id=l.id AND h.superseded_at IS NULL"
    : "LEFT JOIN (SELECT NULL::integer AS stage) h ON true";
}
export type OverviewClock = {
  observed_at: string;
  starts_at: string;
  exclusive_end: string;
  previous_starts_at?: string;
  previous_observed_at?: string;
  previous_exclusive_end?: string;
};

export function overviewDays(range: OverviewRange): number {
  return range === "today" ? 1 : range === "7d" ? 7 : 30;
}

export function parseOverviewRange(query: URLSearchParams): OverviewRange {
  for (const key of query.keys()) if (key !== "range" || query.getAll(key).length !== 1) throw invalid("Unsupported overview query", key);
  const range = query.get("range") ?? "7d";
  if (range !== "today" && range !== "7d" && range !== "30d") throw invalid("Overview range is invalid", "range");
  return range;
}

/** One database clock for the current and comparable previous equal-duration window. */
export async function readOverviewClock(client: PoolClient, days: number): Promise<OverviewClock> {
  return (await client.query<OverviewClock>(
    `WITH clock AS (
       SELECT transaction_timestamp() AS observed_at,
         (date_trunc('day',transaction_timestamp() AT TIME ZONE 'Asia/Shanghai') - ($1::int-1)*interval '1 day') AT TIME ZONE 'Asia/Shanghai' AS starts_at
     )
     SELECT to_char(observed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS observed_at,
       to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS starts_at,
       to_char((observed_at+interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS exclusive_end,
       to_char((starts_at-(observed_at-starts_at)) AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS previous_starts_at,
       to_char((starts_at-interval '1 microsecond') AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS previous_observed_at,
       to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS previous_exclusive_end
     FROM clock`, [days],
  )).rows[0]!;
}

/** All metrics describe this read snapshot; no provider query, ensure or command is run. */
export async function readAdminOverview(
  client: PoolClient,
  viewer: OverviewViewer,
  range: OverviewRange,
  options?: { clock?: OverviewClock; ordersOnly?: boolean; legacyHeadReady?: boolean },
) {
  const { adminId, access, scope } = viewer;
  const permission = (code: string) => access.permissions.has(code);
  const emptyScope = scopeIsEmpty(scope, access.isBoss);
  const globalScope = access.isBoss || scope.mode === "ALL_GAMES";
  const metric = (id: string, value: unknown, state: OverviewMetric["state"] = "KNOWN", unit: OverviewMetric["unit"] = "COUNT"): OverviewMetric => {
    if (state !== "KNOWN") return { id, value: null, unit, state, drilldown: null };
    if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value)) throw new Error("Overview aggregate is invalid");
    return { id, value, unit, state, drilldown: null };
  };
  const metrics: OverviewMetric[] = [];
  const clock = options?.clock ?? await readOverviewClock(client, overviewDays(range));
  const parameters = [adminId, access.isBoss, clock.starts_at, clock.observed_at];
  const scopeSql = (column: string) => gameScopeSql(column, "$1", "$2");

  if (!options?.ordersOnly) {
    if (permission(ADMIN_PERMISSION.userDirectoryRead) && globalScope) {
      const row = (await client.query<{ total: string; recent: string }>(
        `SELECT count(*)::text AS total,count(*) FILTER(WHERE "createdAt">=$1::timestamptz AND "createdAt"<=$2::timestamptz)::text AS recent FROM zzsh_auth_user."user"`,
        [clock.starts_at, clock.observed_at],
      )).rows[0]!;
      metrics.push(metric("usersTotal", row.total), metric("usersNew", row.recent));
    } else {
      const state = permission(ADMIN_PERMISSION.userDirectoryRead) ? "NO_GAME_SCOPE" : "FORBIDDEN";
      metrics.push(metric("usersTotal", null, state), metric("usersNew", null, state));
    }

    if (permission(ADMIN_PERMISSION.supplyRentalAccountRead) && !emptyScope) {
      const row = (await client.query<{ total: string; published: string }>(
        `SELECT count(*)::text AS total,count(*) FILTER(WHERE v.review_state='PUBLISHED' AND a.lifecycle='ACTIVE'
          AND NOT EXISTS(SELECT 1 FROM zzsh_supply.game g JOIN zzsh_supply.legacy_supply_map m ON m.account_id=a.id
            WHERE g.id=a.game_id AND g.code='delta' AND m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts'))::text AS published
           FROM zzsh_supply.rental_account a LEFT JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id AND v.account_id=a.id
          WHERE ${scopeSql("a.game_id")}`, parameters.slice(0, 2),
      )).rows[0]!;
      metrics.push(metric("accountsTotal", row.total), metric("accountsPublished", row.published));
    } else {
      const state = permission(ADMIN_PERMISSION.supplyRentalAccountRead) ? "NO_GAME_SCOPE" : "FORBIDDEN";
      metrics.push(metric("accountsTotal", null, state), metric("accountsPublished", null, state));
    }
    if (permission(ADMIN_PERMISSION.supplyReviewRead) && !emptyScope) {
      const row = (await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM zzsh_supply.listing_version v JOIN zzsh_supply.rental_account a ON a.id=v.account_id AND a.current_version_id=v.id
          WHERE v.review_state='SUBMITTED' AND ${scopeSql("a.game_id")}`, parameters.slice(0, 2),
      )).rows[0]!;
      metrics.push(metric("listingsPendingReview", row.count));
    } else metrics.push(metric("listingsPendingReview", null, permission(ADMIN_PERMISSION.supplyReviewRead) ? "NO_GAME_SCOPE" : "FORBIDDEN"));
  }

  let trend: Trend[] = [];
  const finance = permission(ADMIN_PERMISSION.financeRead);
  if (permission(ADMIN_PERMISSION.orderRead) && !emptyScope) {
    const unified = options?.legacyHeadReady !== undefined;
    const paidRows = `SELECT o.paid_at,${finance ? "p.amount_cents" : "NULL::numeric"} AS amount_cents
      FROM zzsh_order.payment_confirmation p JOIN orders o ON o.id=p.order_id AND o.paid_confirmation_id=p.id
      WHERE p.disposition='APPLIED' AND p.currency='CNY' AND o.paid_at >= $3::timestamptz AND o.paid_at <= $4::timestamptz
      ${unified ? `UNION ALL SELECT l.source_paid_at,${finance ? "CASE WHEN l.recorded_paid_amount_cents>=0 THEN l.recorded_paid_amount_cents END" : "NULL::numeric"}
      FROM zzsh_order.legacy_order_read_snapshot l WHERE ${LEGACY_BUSINESS_PAYMENT_SQL} AND ${scopeSql("l.game_id")}
        AND l.source_paid_at >= $3::timestamptz AND l.source_paid_at <= $4::timestamptz` : ""}`;
    const row = (await client.query<{ created: string; pending: string; paid: string; legacy: string; payments: string; cents: string; known_payments?: string }>(
      `WITH orders AS (SELECT o.* FROM zzsh_order.rental_order o WHERE ${scopeSql("o.game_id")}),
        paid AS (${paidRows})
       SELECT count(*) FILTER(WHERE created_at >= $3::timestamptz AND created_at <= $4::timestamptz)::text AS created,
         count(*) FILTER(WHERE status='PENDING_PAYMENT' AND hold_until > $4::timestamptz)::text AS pending,
         (count(*) FILTER(WHERE status='PAID') ${unified ? `+ (SELECT count(*) FROM zzsh_order.legacy_order_read_snapshot l
           ${legacyBusinessOrderHeadSql(options.legacyHeadReady!)} WHERE ${LEGACY_BUSINESS_ORDER_SQL}
           AND ${scopeSql("l.game_id")} AND (${LEGACY_ORDER_STATUS_SQL})='PAID')` : ""})::text AS paid,
         (SELECT count(*)::text FROM zzsh_order.legacy_order_read_snapshot l WHERE ${scopeSql("l.game_id")}) AS legacy,
         (SELECT count(*)::text FROM paid) AS payments,
         ${finance ? "(SELECT COALESCE(sum(amount_cents),0)::text FROM paid)" : "NULL::text"} AS cents
         ${finance && unified ? ",(SELECT count(amount_cents)::text FROM paid) AS known_payments" : ""} FROM orders`, parameters,
    )).rows[0]!;
    metrics.push(metric("ordersCreated", row.created), metric("ordersPendingPayment", row.pending), metric("ordersPaid", row.paid),
      metric("legacyOrdersTotal", row.legacy), metric("paymentsConfirmed", row.payments), metric("confirmedCents", row.cents, finance ? "KNOWN" : "FORBIDDEN", "CNY_CENTS"));
    if (finance && row.known_payments !== undefined && row.known_payments !== row.payments) {
      Object.assign(metrics.at(-1)!, { state: "PARTIAL", value: row.known_payments === "0" ? null : row.cents,
        coverage: { knownCount: Number(row.known_payments), totalCount: Number(row.payments) } });
    }
    trend = (await client.query<Trend>(
      `WITH days AS (SELECT generate_series(($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date,interval '1 day')::date AS day),
       orders AS (SELECT o.* FROM zzsh_order.rental_order o WHERE ${scopeSql("o.game_id")}),
       created AS (SELECT (created_at AT TIME ZONE 'Asia/Shanghai')::date AS day,count(*)::text AS count FROM orders
         WHERE created_at >= $3::timestamptz AND created_at <= $4::timestamptz GROUP BY 1),
       paid AS (SELECT (paid_at AT TIME ZONE 'Asia/Shanghai')::date AS day,count(*)::text AS count,
           ${finance ? (unified ? "CASE WHEN count(amount_cents)=count(*) THEN sum(amount_cents)::text END" : "sum(amount_cents)::text") : "NULL::text"} AS cents
         FROM (${paidRows}) facts GROUP BY 1)
       SELECT to_char(d.day,'YYYY-MM-DD') AS date,COALESCE(c.count,'0') AS orders,COALESCE(p.count,'0') AS payments,
         ${finance ? "CASE WHEN p.count IS NULL THEN '0' ELSE p.cents END" : "NULL::text"} AS "confirmedCents" FROM days d LEFT JOIN created c USING(day) LEFT JOIN paid p USING(day) ORDER BY d.day`, parameters,
    )).rows;
    for (const day of trend) {
      metric("trendOrders", day.orders); metric("trendPayments", day.payments);
      if (finance && day.confirmedCents !== null) metric("trendCents", day.confirmedCents, "KNOWN", "CNY_CENTS");
    }
  } else {
    const state = permission(ADMIN_PERMISSION.orderRead) ? "NO_GAME_SCOPE" : "FORBIDDEN";
    for (const id of ["ordersCreated", "ordersPendingPayment", "ordersPaid", "legacyOrdersTotal", "paymentsConfirmed"]) metrics.push(metric(id, null, state));
    metrics.push(metric("confirmedCents", null, state, "CNY_CENTS"));
  }

  if (!options?.ordersOnly) {
    const support = permission(ADMIN_PERMISSION.imSupportRead);
    if (support && viewer.imAppId) {
      const row = (await client.query<{ waiting: string; mine: string }>(
        `SELECT ${globalScope ? "count(*) FILTER(WHERE state='WAITING')::text" : "NULL::text"} AS waiting,
           count(*) FILTER(WHERE state='ACTIVE' AND assigned_admin_id=$2)::text AS mine
         FROM zzsh_iam.im_consultation WHERE app_id=$1 AND (assigned_admin_id=$2 ${globalScope ? "OR state='WAITING'" : ""})`, [viewer.imAppId, adminId],
      )).rows[0]!;
      metrics.push(metric("supportWaiting", row.waiting, globalScope ? "KNOWN" : "NO_GAME_SCOPE"), metric("supportMine", row.mine));
    } else {
      const state = support ? "UNAVAILABLE" : "FORBIDDEN";
      metrics.push(metric("supportWaiting", null, state), metric("supportMine", null, state));
    }
  }

  const path = (route: string, query: Record<string, string> = {}) => route + (Object.keys(query).length ? "?" + new URLSearchParams(query).toString() : "");
  // List upper bounds are exclusive; preserve PG microseconds instead of rounding through JS Date.
  const links: Record<string, string> = {
    usersTotal: "/users", usersNew: path("/users", { registrationTime: "LOCAL", registeredFrom: clock.starts_at, registeredTo: clock.observed_at }),
    ordersCreated: path("/orders", { origin: "NATIVE", createdFrom: clock.starts_at, createdTo: clock.exclusive_end }),
    ordersPendingPayment: path("/orders", { origin: "NATIVE", status: "PENDING_PAYMENT", paymentOpen: "true" }),
    ordersPaid: path("/orders", { origin: "NATIVE", status: "PAID" }), legacyOrdersTotal: path("/orders", { origin: "LEGACY" }),
    paymentsConfirmed: path("/orders", { origin: "NATIVE", paymentConfirmedFrom: clock.starts_at, paymentConfirmedTo: clock.exclusive_end }),
    confirmedCents: path("/orders", { origin: "NATIVE", paymentConfirmedFrom: clock.starts_at, paymentConfirmedTo: clock.exclusive_end }),
  };
  if (options?.legacyHeadReady !== undefined) {
    links.ordersPaid = path("/orders", { status: "PAID" });
    links.paymentsConfirmed = links.confirmedCents = path("/orders", { paidFrom: clock.starts_at, paidTo: clock.exclusive_end });
  }
  for (const item of metrics) if (item.state === "KNOWN" || item.state === "PARTIAL") item.drilldown = links[item.id] ?? null;
  return { version: "admin.overview.v1" as const, observedAt: clock.observed_at,
    period: { range, from: clock.starts_at, to: clock.observed_at, timeZone: "Asia/Shanghai" },
    scope: { mode: globalScope ? "ALL_GAMES" : scope.mode, gameIds: globalScope ? [] : scope.gameIds }, metrics, trend };
}

export async function handleAdminOverview(request: SupplyNodeRequest, response: SupplyResponse, options: AdminOverviewOptions): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("Cache-Control", "no-store");
  await safely(response, requestId, async () => {
    const url = new URL(request.originalUrl ?? request.url ?? "/", options.apiOrigin);
    if (request.method !== "GET" || !/^\/api\/(?:v1\/admin|bff\/admin)\/workspace\/overview$/.test(url.pathname)) throw notFound();
    const origin = headerValue(request.headers.origin);
    if (origin && origin !== options.adminOrigin && origin !== options.apiOrigin || headerValue(request.headers["sec-fetch-site"]) === "cross-site") throw forbidden();
    const range = parseOverviewRange(url.searchParams);
    await withDirectoryRead(options.directoryReadPool ?? options.pool, request, response, async signal => {
      const context = await readAdminContext(request, options);
      const result = await withDirectoryReadTransaction(options.directoryReadPool ?? options.pool, signal, async client => {
        await assertAdminContextInTransaction(client, context);
        const access = await requireAdminAccess(client, context.userId);
        const scope = await readAdminGameScope(client, context.userId);
        return readAdminOverview(client, { adminId: context.userId, access, scope, imAppId: options.imAppId }, range);
      });
      signal.throwIfAborted(); sendJson(response, 200, result, requestId);
    });
  });
}

export function mountAdminOverview(app: INestApplication, options: AdminOverviewOptions): void {
  app.getHttpAdapter().getInstance().use("/api/v1/admin/workspace/overview", (request: SupplyNodeRequest, response: SupplyResponse) => handleAdminOverview(request, response, options));
}
