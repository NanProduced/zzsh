import type { INestApplication } from "@nestjs/common";
import type { PoolClient } from "pg";

import { ADMIN_PERMISSION, type EffectiveAdminAccess } from "./admin-authorization";
import { deriveDashboardPreset, type DashboardPreset } from "./admin-dashboard-preset";
import { gameScopeSql, readAdminGameScope, scopeIsEmpty, type AdminGameScope } from "./admin-scope";
import { canonicalize } from "../supply/content-hash";
import {
  assertAdminContextInTransaction,
  readAdminContext,
  type AuthSecurityOptions,
} from "./auth-security";
import { withDirectoryRead, withDirectoryReadTransaction } from "./user-directory-read";
import {
  overviewDays,
  parseOverviewRange,
  readAdminOverview,
  readOverviewClock,
  type AdminOverviewOptions,
  type OverviewClock,
  type OverviewMetric,
  type OverviewRange,
  type OverviewViewer,
} from "./admin-overview";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { requireAdminAccess, safely, type SupplyResponse } from "../supply/supply-routes";
import { forbidden, headerValue, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";

export type DashboardUnit = "COUNT" | "CNY_CENTS";
export type DashboardState = "KNOWN" | "PARTIAL" | "FORBIDDEN" | "NO_GAME_SCOPE" | "UNAVAILABLE";
export type DashboardMetric = {
  id: string;
  label: string;
  value: string | null;
  unit: DashboardUnit;
  state: DashboardState;
  definition: string;
  coverage: { knownCount: number; totalCount: number } | null;
  delta: { value: string; direction: "UP" | "DOWN" | "FLAT"; percent: string | null } | null;
  sparkline: string[];
  drilldown: string | null;
};
export type DashboardQueue = {
  id: string;
  label: string;
  count: number;
  oldestAgeSeconds: number | null;
  severity: "INFO" | "WARN" | "CRITICAL" | "UNKNOWN";
  drilldown: string | null;
};
export type DashboardRecentOrder = {
  id: string;
  displayNo: string;
  status: "PENDING_PAYMENT" | "PAID" | "COMPLETED" | "CANCELLED" | "UNKNOWN";
  paidAt: string | null;
  confirmedCents: string | null;
  contributionCents: string | null;
  contributionState: "SETTLED" | "QUOTED" | "UNAVAILABLE";
  currency: "CNY";
};
export type AdminDashboardPayload = {
  version: "admin.dashboard.v1";
  preset: DashboardPreset;
  observedAt: string;
  period: { range: OverviewRange; from: string; to: string; timeZone: "Asia/Shanghai"; paymentConfirmedTo: string | null };
  comparison: { from: string; to: string };
  scope: { mode: "ALL_GAMES" | "SELECTED_GAMES"; gameIds: string[] };
  metrics: DashboardMetric[];
  trend: Array<{
    date: string;
    confirmedCents: string | null;
    paidOrders: string;
    quotedSpreadCents: string | null;
    settledContributionCents: string | null;
  }>;
  queues: DashboardQueue[];
  recentOrders: DashboardRecentOrder[];
  recentOrdersState: "KNOWN" | "FORBIDDEN" | "NO_GAME_SCOPE";
};

type DashboardViewer = OverviewViewer;

export function parseDashboardRange(query: URLSearchParams): OverviewRange {
  const range = parseOverviewRange(query);
  return query.has("range") ? range : "30d";
}

const MONEY = "CNY_CENTS" as const;
const COUNT = "COUNT" as const;
const DEFINITIONS = {
  confirmed: "本期原生订单的 APPLIED/CNY 付款记录；含押金；未扣退款；不代表渠道或银行到账。",
  quoted: "冻结报价中的 resourceTotal - ownerTotal；仅为报价预估价差，未扣最终消耗、包赔、提前结束补偿或渠道成本。",
  settled: "结算过账的平台分量；仍未扣分销/通道成本，不是净利润。",
  paidOrders: "本期原生订单中，存在 APPLIED/CNY 付款记录的订单数。",
} as const;

function metricById(overview: { metrics: OverviewMetric[] }, id: string): OverviewMetric | undefined {
  return overview.metrics.find((metric) => metric.id === id);
}

function deltaOf(current: string | null, previous: string | null, unit: DashboardUnit) {
  if (current === null || previous === null) return null;
  if (unit === COUNT && (!/^(0|[1-9]\d*)$/.test(current) || !/^(0|[1-9]\d*)$/.test(previous))) return null;
  if (unit === MONEY && (!/^-?(0|[1-9]\d*)$/.test(current) || !/^-?(0|[1-9]\d*)$/.test(previous))) return null;
  const value = BigInt(current) - BigInt(previous);
  const denominator = BigInt(previous), numerator = (value < 0n ? -value : value) * 1000n;
  const scaled = denominator > 0n ? (numerator * 2n + denominator) / (denominator * 2n) : null;
  const percent = scaled === null ? null : `${value < 0n ? "-" : ""}${scaled / 10n}.${scaled % 10n}`;
  return {
    value: value.toString(),
    direction: value > 0n ? "UP" as const : value < 0n ? "DOWN" as const : "FLAT" as const,
    percent,
  };
}

function fromOverview(
  current: { metrics: OverviewMetric[] },
  previous: { metrics: OverviewMetric[] },
  id: string,
  label: string,
  definition: string,
  unit: DashboardUnit = COUNT,
  sparkline: string[] = [],
): DashboardMetric {
  const cur = metricById(current, id);
  const prev = metricById(previous, id);
  const state = cur?.state ?? "UNAVAILABLE";
  if (state !== "KNOWN") {
    return { id, label, value: null, unit, state, definition, coverage: null, delta: null, sparkline: [], drilldown: null };
  }
  return {
    id,
    label,
    value: cur?.value ?? null,
    unit,
    state: "KNOWN",
    definition,
    coverage: null,
    delta: ["confirmedCents", "paymentsConfirmed", "usersCreated"].includes(id)
      ? deltaOf(cur?.value ?? null, prev?.state === "KNOWN" ? prev.value : null, unit) : null,
    sparkline,
    drilldown: cur?.drilldown ?? null,
  };
}

function quoteCentsSql(alias: string): string {
  return `CASE
    WHEN jsonb_typeof(${alias}.quote_snapshot->'platformFullProfit') = 'object'
      AND ${alias}.quote_snapshot->'platformFullProfit'->>'currency' = 'CNY'
      AND ${alias}.quote_snapshot->'platformFullProfit'->>'unit' = 'yuan'
      AND jsonb_typeof(${alias}.quote_snapshot->'platformFullProfit'->'scale') = 'number'
      AND ${alias}.quote_snapshot->'platformFullProfit'->'scale' = '2'::jsonb
      AND jsonb_typeof(${alias}.quote_snapshot->'platformFullProfit'->'amount') = 'string'
      AND ${alias}.quote_snapshot->'platformFullProfit'->>'amount' ~ '^(0|[1-9][0-9]{0,21})(\\.[0-9]{1,2})?$'
    THEN ((${alias}.quote_snapshot->'platformFullProfit'->>'amount')::numeric(24,2) * 100)::numeric(24,0)
    ELSE NULL
  END`;
}

async function readQuotedSpread(
  client: PoolClient,
  viewer: DashboardViewer,
  startsAt: string,
  observedAt: string,
): Promise<{ value: string | null; state: DashboardState; coverage: { knownCount: number; totalCount: number } | null }> {
  const { access, scope, adminId } = viewer;
  if (!access.permissions.has(ADMIN_PERMISSION.financeRead) || !access.permissions.has(ADMIN_PERMISSION.supplyQuoteInternalRead)) {
    return { value: null, state: "FORBIDDEN", coverage: null };
  }
  if (scopeIsEmpty(scope, access.isBoss)) return { value: null, state: "NO_GAME_SCOPE", coverage: null };
  const scopeSql = gameScopeSql("o.game_id", "$1", "$2");
  const row = (await client.query<{ total: string; known: string; cents: string }>(
    `WITH paid AS (
       SELECT o.id, ${quoteCentsSql("o")} AS cents
       FROM zzsh_order.rental_order o
       JOIN zzsh_order.payment_confirmation p ON p.id=o.paid_confirmation_id AND p.order_id=o.id
       WHERE p.disposition='APPLIED' AND p.currency='CNY'
         AND o.paid_at >= $3::timestamptz AND o.paid_at <= $4::timestamptz
         AND ${scopeSql}
     )
     SELECT count(*)::text AS total,
       count(cents)::text AS known,
       COALESCE(sum(cents),0)::text AS cents
     FROM paid`,
    [adminId, access.isBoss, startsAt, observedAt],
  )).rows[0]!;
  const total = Number(row.total), known = Number(row.known);
  if (total === 0) return { value: "0", state: "KNOWN", coverage: { knownCount: 0, totalCount: 0 } };
  if (known < total) return { value: known === 0 ? null : row.cents, state: "PARTIAL", coverage: { knownCount: known, totalCount: total } };
  return { value: row.cents, state: "KNOWN", coverage: { knownCount: known, totalCount: total } };
}

async function readSettledContribution(
  client: PoolClient,
  viewer: DashboardViewer,
  startsAt: string,
  observedAt: string,
): Promise<{ value: string | null; state: DashboardState }> {
  const { access, scope, adminId } = viewer;
  if (!access.permissions.has(ADMIN_PERMISSION.financeRead)) return { value: null, state: "FORBIDDEN" };
  if (scopeIsEmpty(scope, access.isBoss)) return { value: null, state: "NO_GAME_SCOPE" };
  const row = (await client.query<{ cents: string }>(
    `SELECT COALESCE(sum(p.platform_contribution_cents),0)::text AS cents
       FROM zzsh_order.settlement_posting p
       JOIN zzsh_order.rental_order o ON o.id=p.order_id
      WHERE p.posted_at >= $3::timestamptz AND p.posted_at <= $4::timestamptz
        AND ${gameScopeSql("o.game_id", "$1", "$2")}`,
    [adminId, access.isBoss, startsAt, observedAt],
  )).rows[0]!;
  return { value: row.cents, state: "KNOWN" };
}

async function readRecentOrders(
  client: PoolClient,
  viewer: DashboardViewer,
  startsAt: string,
  observedAt: string,
): Promise<DashboardRecentOrder[]> {
  const { access, scope, adminId } = viewer;
  if (!access.permissions.has(ADMIN_PERMISSION.orderRead) || scopeIsEmpty(scope, access.isBoss)) return [];
  const finance = access.permissions.has(ADMIN_PERMISSION.financeRead);
  const quotedVisible = finance && access.permissions.has(ADMIN_PERMISSION.supplyQuoteInternalRead);
  const contributionCents = finance
    ? `CASE WHEN sp.id IS NOT NULL THEN sp.platform_contribution_cents::text
         ${quotedVisible ? `WHEN ${quoteCentsSql("o")} IS NOT NULL THEN ${quoteCentsSql("o")}::text` : ""}
         ELSE NULL END`
    : "NULL::text";
  const contributionState = finance
    ? `CASE WHEN sp.id IS NOT NULL THEN 'SETTLED'
         ${quotedVisible ? `WHEN ${quoteCentsSql("o")} IS NOT NULL THEN 'QUOTED'` : ""}
         ELSE 'UNAVAILABLE' END`
    : "'UNAVAILABLE'";
  const rows = (await client.query<{
    id: string; displayNo: string; status: string; paidAt: string | null; confirmedCents: string;
    contributionCents: string | null; contributionState: "SETTLED" | "QUOTED" | "UNAVAILABLE";
  }>(
    `SELECT o.id,o.display_no AS "displayNo",o.status,
       to_char(o.paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "paidAt",
       p.amount_cents::text AS "confirmedCents",
       ${contributionCents} AS "contributionCents",
       ${contributionState} AS "contributionState"
       FROM zzsh_order.rental_order o
       JOIN zzsh_order.payment_confirmation p ON p.id=o.paid_confirmation_id AND p.order_id=o.id
       LEFT JOIN LATERAL (
         SELECT id, platform_contribution_cents
         FROM zzsh_order.settlement_posting
         WHERE order_id=o.id
         ORDER BY posted_at DESC, id DESC
         LIMIT 1
       ) sp ON true
      WHERE p.disposition='APPLIED' AND p.currency='CNY'
        AND o.paid_at >= $3::timestamptz AND o.paid_at <= $4::timestamptz
        AND ${gameScopeSql("o.game_id", "$1", "$2")}
      ORDER BY o.paid_at DESC, o.id DESC
      LIMIT 8`,
    [adminId, access.isBoss, startsAt, observedAt],
  )).rows;
  return rows.map((row) => ({
    id: row.id,
    displayNo: row.displayNo,
    status: ["PENDING_PAYMENT", "PAID", "COMPLETED", "CANCELLED"].includes(row.status) ? row.status as DashboardRecentOrder["status"] : "UNKNOWN",
    paidAt: row.paidAt,
    confirmedCents: row.confirmedCents,
    contributionCents: row.contributionCents,
    contributionState: row.contributionState,
    currency: "CNY",
  }));
}

async function oldestAge(client: PoolClient, sql: string, values: unknown[]): Promise<number | null> {
  const row = (await client.query<{ age: string | null }>(sql, values)).rows[0];
  if (!row?.age) return null;
  const age = Number(row.age);
  return Number.isFinite(age) && age >= 0 ? age : null;
}

async function readQueues(
  client: PoolClient,
  viewer: DashboardViewer,
  current: { metrics: OverviewMetric[] },
  preset: DashboardPreset,
): Promise<DashboardQueue[]> {
  const { access, scope, adminId, imAppId } = viewer;
  const permission = (code: string) => access.permissions.has(code);
  const emptyScope = scopeIsEmpty(scope, access.isBoss);
  const globalScope = access.isBoss || scope.mode === "ALL_GAMES";
  const scopeSql = gameScopeSql("o.game_id", "$1", "$2");
  const result: DashboardQueue[] = [];
  // The oldest-age queries are tiny; run them before returning so the response is one snapshot.
  const addAsync = async (id: string, label: string, metricId: string, ageSql: string | null, ageValues: unknown[], severity: DashboardQueue["severity"], drilldown: string | null) => {
    const metric = metricById(current, metricId);
    if (!metric || metric.state !== "KNOWN") return;
    result.push({ id, label, count: Number(metric.value ?? 0), oldestAgeSeconds: ageSql ? await oldestAge(client, ageSql, ageValues) : null, severity, drilldown });
  };

  if (preset === "BOSS") {
    await addAsync("paid-awaiting", "已付款待完单", "ordersPaid",
      emptyScope ? null : `SELECT EXTRACT(EPOCH FROM (clock_timestamp()-min(paid_at)))::bigint::text AS age FROM zzsh_order.rental_order o WHERE status='PAID' AND ${scopeSql}`,
      [adminId, access.isBoss], "WARN", "/orders?origin=NATIVE&status=PAID");
    if (permission(ADMIN_PERMISSION.approvalRequestApprove)) {
      await addAsync("pending-approvals", "待我审批", "pendingApprovals",
        `SELECT EXTRACT(EPOCH FROM (clock_timestamp()-min(r.created_at)))::bigint::text AS age
           FROM zzsh_iam.approval_request r JOIN zzsh_iam.approval_request_candidate c ON c.request_id=r.id
          WHERE c.admin_user_id=$1 AND r.status='PENDING' AND r.expires_at>clock_timestamp() AND r.requested_by<>$1`,
        [adminId], "INFO", "/approvals");
    }
    return result;
  }

  if (preset === "OPS") {
    await addAsync("pending-payment", "订单待付款", "ordersPendingPayment",
      emptyScope ? null : `SELECT EXTRACT(EPOCH FROM (clock_timestamp()-min(created_at)))::bigint::text AS age FROM zzsh_order.rental_order o WHERE status='PENDING_PAYMENT' AND hold_until>clock_timestamp() AND ${scopeSql}`,
      [adminId, access.isBoss], "INFO", "/orders?origin=NATIVE&status=PENDING_PAYMENT&paymentOpen=true");
    await addAsync("paid-awaiting", "已付款待完单", "ordersPaid",
      emptyScope ? null : `SELECT EXTRACT(EPOCH FROM (clock_timestamp()-min(paid_at)))::bigint::text AS age FROM zzsh_order.rental_order o WHERE status='PAID' AND ${scopeSql}`,
      [adminId, access.isBoss], "WARN", "/orders?origin=NATIVE&status=PAID");
    await addAsync("pending-review", "账号待审核", "listingsPendingReview",
      emptyScope ? null : `SELECT EXTRACT(EPOCH FROM (clock_timestamp()-min(v.submitted_at)))::bigint::text AS age
         FROM zzsh_supply.listing_version v JOIN zzsh_supply.rental_account a ON a.id=v.account_id AND a.current_version_id=v.id
        WHERE v.review_state='SUBMITTED' AND ${gameScopeSql("a.game_id", "$1", "$2")}`,
      [adminId, access.isBoss], "INFO", "/supply/reviews");
    if (permission(ADMIN_PERMISSION.imSupportRead) && imAppId && globalScope) {
      await addAsync("support-waiting", "待接入咨询", "supportWaiting",
        `SELECT EXTRACT(EPOCH FROM (clock_timestamp()-min(created_at)))::bigint::text AS age FROM zzsh_iam.im_consultation WHERE app_id=$1 AND state='WAITING'`,
        [imAppId], "WARN", "/support?section=consultation");
    }
    if (permission(ADMIN_PERMISSION.approvalRequestApprove)) {
      await addAsync("pending-approvals", "待我审批", "pendingApprovals",
        `SELECT EXTRACT(EPOCH FROM (clock_timestamp()-min(r.created_at)))::bigint::text AS age
           FROM zzsh_iam.approval_request r JOIN zzsh_iam.approval_request_candidate c ON c.request_id=r.id
          WHERE c.admin_user_id=$1 AND r.status='PENDING' AND r.expires_at>clock_timestamp() AND r.requested_by<>$1`,
        [adminId], "INFO", "/approvals");
    }
    return result;
  }

  await addAsync("support-waiting", "待接入咨询", "supportWaiting",
    globalScope && imAppId ? `SELECT EXTRACT(EPOCH FROM (clock_timestamp()-min(created_at)))::bigint::text AS age FROM zzsh_iam.im_consultation WHERE app_id=$1 AND state='WAITING'` : null,
    imAppId ? [imAppId] : [], "WARN", "/support?section=consultation");
  await addAsync("support-mine", "我的进行中", "supportMine",
    imAppId ? `SELECT EXTRACT(EPOCH FROM (clock_timestamp()-min(created_at)))::bigint::text AS age FROM zzsh_iam.im_consultation WHERE app_id=$1 AND state='ACTIVE' AND assigned_admin_id=$2` : null,
    imAppId ? [imAppId, adminId] : [], "INFO", "/support/mine");
  await addAsync("paid-awaiting", "待完单", "ordersPaid",
    emptyScope ? null : `SELECT EXTRACT(EPOCH FROM (clock_timestamp()-min(paid_at)))::bigint::text AS age FROM zzsh_order.rental_order o WHERE status='PAID' AND ${scopeSql}`,
    [adminId, access.isBoss], "WARN", "/orders?origin=NATIVE&status=PAID");
  return result;
}

async function readPendingApprovalMetric(client: PoolClient, access: EffectiveAdminAccess, adminId: string): Promise<OverviewMetric> {
  if (!access.permissions.has(ADMIN_PERMISSION.approvalRequestApprove)) {
    return { id: "pendingApprovals", value: null, unit: "COUNT", state: "FORBIDDEN", drilldown: null };
  }
  const row = (await client.query<{ count: string }>(
    `SELECT count(*)::text AS count
       FROM zzsh_iam.approval_request r
       JOIN zzsh_iam.approval_request_candidate c ON c.request_id=r.id
      WHERE c.admin_user_id=$1 AND r.status='PENDING' AND r.expires_at>clock_timestamp() AND r.requested_by<>$1`,
    [adminId],
  )).rows[0]!;
  return { id: "pendingApprovals", value: row.count, unit: "COUNT", state: "KNOWN", drilldown: "/approvals" };
}

export async function readAdminDashboard(
  client: PoolClient,
  viewer: DashboardViewer,
  range: OverviewRange,
): Promise<AdminDashboardPayload> {
  const preset = deriveDashboardPreset(viewer.access);
  const clock: OverviewClock = await readOverviewClock(client, overviewDays(range));
  const current = await readAdminOverview(client, viewer, range, { clock });
  const previousClock: OverviewClock = {
    observed_at: clock.previous_observed_at ?? clock.starts_at,
    starts_at: clock.previous_starts_at ?? clock.starts_at,
    exclusive_end: clock.starts_at,
  };
  const previous = await readAdminOverview(client, viewer, range, { clock: previousClock, ordersOnly: true });
  const pendingApprovals = await readPendingApprovalMetric(client, viewer.access, viewer.adminId);
  const metricsWithApprovals = { metrics: [...current.metrics, pendingApprovals] };
  const previousWithApprovals = { metrics: [...previous.metrics, { ...pendingApprovals, value: null, state: "FORBIDDEN" as const, drilldown: null }] };
  const confirmed = fromOverview(current, previous, "confirmedCents", "确认收款（含押金）", DEFINITIONS.confirmed, MONEY, current.trend.map((day) => day.confirmedCents ?? "0"));
  const paidOrders = { ...fromOverview(current, previous, "paymentsConfirmed", "已付款订单数", DEFINITIONS.paidOrders, COUNT, current.trend.map((day) => day.payments)), id: "paidOrders" };
  const quoted = await readQuotedSpread(client, viewer, clock.starts_at, clock.observed_at);
  const previousQuoted = await readQuotedSpread(client, viewer, previousClock.starts_at, previousClock.observed_at);
  const settled = await readSettledContribution(client, viewer, clock.starts_at, clock.observed_at);
  const previousSettled = await readSettledContribution(client, viewer, previousClock.starts_at, previousClock.observed_at);
  const quotedMetric: DashboardMetric = {
    id: "quotedSpread",
    label: "报价预估价差",
    value: quoted.value,
    unit: MONEY,
    state: quoted.state,
    definition: DEFINITIONS.quoted,
    coverage: quoted.coverage,
    delta: quoted.state === "KNOWN" && previousQuoted.state === "KNOWN" ? deltaOf(quoted.value, previousQuoted.value, MONEY) : null,
    sparkline: [],
    drilldown: quoted.state === "KNOWN" || quoted.state === "PARTIAL"
      ? `/orders?origin=NATIVE&paymentConfirmedFrom=${encodeURIComponent(clock.starts_at)}&paymentConfirmedTo=${encodeURIComponent(clock.exclusive_end)}`
      : null,
  };
  const settledMetric: DashboardMetric = {
    id: "settledContribution",
    label: "已结算平台贡献",
    value: settled.value,
    unit: MONEY,
    state: settled.state,
    definition: DEFINITIONS.settled,
    coverage: null,
    delta: settled.state === "KNOWN" && previousSettled.state === "KNOWN" ? deltaOf(settled.value, previousSettled.value, MONEY) : null,
    sparkline: [],
    drilldown: null,
  };

  let metrics: DashboardMetric[];
  if (preset === "BOSS" || preset === "OPS") {
    metrics = [confirmed, quotedMetric, settledMetric, paidOrders];
  } else if (preset === "SUPPORT") {
    metrics = [
      fromOverview(metricsWithApprovals, previousWithApprovals, "supportWaiting", "待接入咨询", "当前全站排队中的服务类咨询。", COUNT, []),
      fromOverview(metricsWithApprovals, previousWithApprovals, "supportMine", "我的进行中", "当前分配给你的进行中咨询。", COUNT, []),
      fromOverview(current, previous, "ordersPaid", "待完单", "当前状态为 PAID 的原生订单。", COUNT, []),
    ];
  } else metrics = [];

  const recentOrders = await readRecentOrders(client, viewer, clock.starts_at, clock.observed_at);
  const queues = await readQueues(client, viewer, metricsWithApprovals, preset);
  return {
    version: "admin.dashboard.v1",
    preset,
    observedAt: clock.observed_at,
    period: { range, from: clock.starts_at, to: clock.observed_at, timeZone: "Asia/Shanghai",
      paymentConfirmedTo: viewer.access.permissions.has(ADMIN_PERMISSION.orderRead) && !scopeIsEmpty(viewer.scope, viewer.access.isBoss) ? clock.exclusive_end : null },
    comparison: { from: previousClock.starts_at, to: previousClock.observed_at },
    scope: current.scope,
    metrics,
    trend: current.trend.map((day) => ({
      date: day.date,
      confirmedCents: day.confirmedCents,
      paidOrders: day.payments,
      quotedSpreadCents: null,
      settledContributionCents: null,
    })),
    queues,
    recentOrders,
    recentOrdersState: !viewer.access.permissions.has(ADMIN_PERMISSION.orderRead) ? "FORBIDDEN" : scopeIsEmpty(viewer.scope, viewer.access.isBoss) ? "NO_GAME_SCOPE" : "KNOWN",
  };
}

function authorizationKey(context: { userId: string; sessionId: string }, access: EffectiveAdminAccess, scope: AdminGameScope): string {
  const effectiveScope = access.isBoss || scope.mode === "ALL_GAMES" ? { mode: "ALL_GAMES", gameIds: [] } : { mode: scope.mode, gameIds: [...scope.gameIds].sort() };
  return canonicalize([context.userId, context.sessionId, access.isBoss, [...access.permissions].sort(), effectiveScope]);
}

export async function handleAdminDashboard(
  request: SupplyNodeRequest,
  response: SupplyResponse,
  options: AdminOverviewOptions,
): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("Cache-Control", "no-store");
  await safely(response, requestId, async () => {
    const url = new URL(request.originalUrl ?? request.url ?? "/", options.apiOrigin);
    if (request.method !== "GET" || !/^\/api\/(?:v1\/admin|bff\/admin)\/dashboard$/.test(url.pathname)) throw notFound();
    const origin = headerValue(request.headers.origin);
    if (origin && origin !== options.adminOrigin && origin !== options.apiOrigin || headerValue(request.headers["sec-fetch-site"]) === "cross-site") throw forbidden();
    const range = parseDashboardRange(url.searchParams);
    await withDirectoryRead(options.directoryReadPool ?? options.pool, request, response, async signal => {
      const context = await readAdminContext(request, options);
      const result = await withDirectoryReadTransaction(options.directoryReadPool ?? options.pool, signal, async client => {
        await assertAdminContextInTransaction(client, context);
        const access = await requireAdminAccess(client, context.userId);
        const scope = await readAdminGameScope(client, context.userId);
        const body = await readAdminDashboard(client, { adminId: context.userId, access, scope, imAppId: options.imAppId }, range);
        return { body, authorizationKey: authorizationKey(context, access, scope) };
      });
      signal.throwIfAborted();
      const freshKey = await withDirectoryReadTransaction(options.directoryReadPool ?? options.pool, signal, async client => {
        await assertAdminContextInTransaction(client, context);
        const access = await requireAdminAccess(client, context.userId), scope = await readAdminGameScope(client, context.userId);
        return authorizationKey(context, access, scope);
      });
      if (freshKey !== result.authorizationKey) throw forbidden("Dashboard access changed; reload");
      signal.throwIfAborted();
      sendJson(response, 200, result.body, requestId);
    });
  });
}

export function mountAdminDashboard(app: INestApplication, options: AdminOverviewOptions): void {
  app.getHttpAdapter().getInstance().use("/api/v1/admin/dashboard", (request: SupplyNodeRequest, response: SupplyResponse) => handleAdminDashboard(request, response, options));
}
