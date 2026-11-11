import type { Pool, PoolClient } from "pg";

import { ADMIN_PERMISSION, hasPermission } from "./admin-authorization";
import { gameScopeSignature, readAdminGameScope, scopeIsEmpty } from "./admin-scope";
import { assertAdminContextInTransaction } from "./auth-security";
import { withDirectoryReadTransaction } from "./user-directory-read";
import { SecurityApiError } from "./security-core";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { USER_DIRECTORY_STATUS_FILTER, userDirectoryStatusCountQuery, type AdminDirectoryViewer, type UserDirectoryFilter } from "./user-directory";
import { adminOrderReadPredicatePlan, orderReadKeyRelation, type OrderReadFilters, type OrderReadViewer } from "../order/admin-order-read";
import { legacyContinuationReady } from "../order/legacy-order-read";
import { requireAdminAccess } from "../supply/supply-routes";
import { sha256Hex } from "../supply/supply-util";

export type AdminDomainSummaryState = "KNOWN" | "PARTIAL" | "UNKNOWN" | "FORBIDDEN" | "NO_GAME_SCOPE";
export type AdminDomainSummaryRequest =
  | { domain: "USERS"; filter: UserDirectoryFilter }
  | { domain: "ORDERS"; filter: OrderReadFilters };
export type AdminDomainSummaryDrilldown = { filters: Record<string, string> };
export type AdminDomainSummary = {
  schema: "admin.domain-summary.v1";
  domain: AdminDomainSummaryRequest["domain"];
  state: AdminDomainSummaryState;
  reason: string | null;
  asOf: string;
  total: string | null;
  coverage: "FULL_AUTHORIZED_FILTER_SET" | null;
  drilldown: AdminDomainSummaryDrilldown | null;
  statuses: Array<{ status: string; count: string; drilldown: AdminDomainSummaryDrilldown | null }> | null;
  membership: { state: "UNKNOWN" | "FORBIDDEN"; reason: string; counts: null } | null;
};

const ORDER_STATUSES = ["PENDING_PAYMENT", "PAID", "COMPLETED", "CANCELLED"] as const;
const COUNT = /^(0|[1-9][0-9]*)$/;
const UTC_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

// Inputs are the existing list parser's output; do not accept an independent summary filter language.
function userDrilldown(filter: UserDirectoryFilter, status?: string): AdminDomainSummaryDrilldown | null {
  // The phone lookup contract is POST-only. Never echo its sensitive predicate into a GET URL.
  if (filter.phone !== undefined || filter.accountStatus !== undefined && status !== undefined && filter.accountStatus !== status) return null;
  const filters: Record<string, string> = { page: "1", pageSize: String(filter.limit) };
  for (const key of ["userId", "legacyId", "identifier", "accountStatus", "source", "identityStatus", "identityVerified", "ageStatus", "membershipTier", "entitlement", "creditState", "creditMin", "creditMax", "riskState", "registeredFrom", "registeredTo", "registeredBefore", "registrationTime", "sort"] as const) {
    if (filter[key] !== undefined) filters[key] = String(filter[key]);
  }
  if (filter.search !== undefined) filters.q = filter.search;
  if (status !== undefined) filters.accountStatus = status;
  return { filters };
}

function orderDrilldown(filter: OrderReadFilters, status?: string): AdminDomainSummaryDrilldown | null {
  // UNKNOWN and the older cursor-only identity filters have no numbered-list parser representation.
  if (status === "UNKNOWN" || filter.status === "UNKNOWN" || filter.qValue !== undefined && filter.qKind === undefined
    || filter.displayNo !== undefined || filter.accountId !== undefined || filter.renterUserId !== undefined || filter.ownerUserId !== undefined
    || filter.status !== undefined && status !== undefined && filter.status !== status) return null;
  const filters: Record<string, string> = { page: "1", pageSize: String(filter.pageSize), view: "list" };
  for (const key of ["status", "origin", "createdFrom", "createdTo", "paymentConfirmedFrom", "paymentConfirmedTo", "paymentOpen", "qKind", "qValue", "fundsResolution"] as const) {
    if (filter[key] !== undefined) filters[key] = String(filter[key]);
  }
  if (status !== undefined) filters.status = status;
  return { filters };
}

function countedSummary(base: AdminDomainSummary, row: Record<string, unknown> | undefined, statuses: readonly string[], drilldown: (status?: string) => AdminDomainSummaryDrilldown | null): AdminDomainSummary {
  // A driver/parser regression must not turn missing, rounded or inconsistent counts into known zero.
  if (!row || ["total", ...statuses].some(key => typeof row[key] !== "string" || !COUNT.test(row[key] as string))
    || statuses.reduce((sum, status) => sum + BigInt(row[status] as string), 0n) !== BigInt(row.total as string)) {
    return { ...base, state: "UNKNOWN", reason: "AGGREGATE_RESULT_INVALID" };
  }
  return { ...base, state: "KNOWN", reason: null, total: row.total as string, coverage: "FULL_AUTHORIZED_FILTER_SET", drilldown: drilldown(),
    statuses: statuses.map(status => ({ status, count: row[status] as string, drilldown: drilldown(status) })) };
}

/** Pure read producer; the caller owns HTTP parsing, admission/deadline and response delivery. */
export async function readAdminDomainSummaryInTransaction(client: PoolClient, context: { userId: string; sessionId: string }, request: AdminDomainSummaryRequest): Promise<AdminDomainSummary> {
  await assertAdminContextInTransaction(client, context);
  const access = await requireAdminAccess(client, context.userId);
  const clock = (await client.query<{ asOf: string }>(`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "asOf"`)).rows[0];
  if (!clock || typeof clock.asOf !== "string" || !UTC_TIME.test(clock.asOf) || !Number.isFinite(Date.parse(clock.asOf))) {
    throw new SecurityApiError(503, API_V1_ERROR_CODES.INTERNAL_ERROR, "Database summary time is unavailable");
  }
  const membership = request.domain === "USERS" ? {
    state: hasPermission(access, ADMIN_PERMISSION.membershipGrowthSummaryRead) ? "UNKNOWN" as const : "FORBIDDEN" as const,
    reason: hasPermission(access, ADMIN_PERMISSION.membershipGrowthSummaryRead) ? "MEMBERSHIP_DISTRIBUTION_NOT_IMPLEMENTED" : "MEMBERSHIP_PERMISSION_REQUIRED",
    counts: null,
  } : null;
  const base: AdminDomainSummary = { schema: "admin.domain-summary.v1", domain: request.domain, state: "UNKNOWN", reason: null, asOf: clock.asOf,
    total: null, coverage: null, drilldown: null, statuses: null, membership };
  if (!hasPermission(access, request.domain === "USERS" ? ADMIN_PERMISSION.userDirectoryRead : ADMIN_PERMISSION.orderRead)) {
    return { ...base, state: "FORBIDDEN", reason: "DOMAIN_READ_PERMISSION_REQUIRED" };
  }
  const scope = await readAdminGameScope(client, context.userId);
  if (scopeIsEmpty(scope, access.isBoss)) return { ...base, state: "NO_GAME_SCOPE", reason: "NO_GAME_SCOPE" };
  const authorizationKey = sha256Hex(JSON.stringify([context.userId, context.sessionId, access.isBoss, [...access.permissions].sort(), gameScopeSignature(scope)]));
  if (request.domain === "USERS") {
    // No existing directory predicate defines a game's user membership; never substitute all users.
    if (!access.isBoss && scope.mode !== "ALL_GAMES") return { ...base, reason: "USER_GAME_SCOPE_AGGREGATE_NOT_SUPPORTED" };
    const filter = request.filter;
    const viewer: AdminDirectoryViewer = { adminId: context.userId, isBoss: access.isBoss, permissions: access.permissions, authorizationKey,
      phoneLookup: hasPermission(access, ADMIN_PERMISSION.userPhoneLookup),
      resourceRead: hasPermission(access, ADMIN_PERMISSION.supplyRentalAccountRead), orderRead: hasPermission(access, ADMIN_PERMISSION.orderRead),
      membershipSummaryRead: hasPermission(access, ADMIN_PERMISSION.membershipGrowthSummaryRead), creditRead: hasPermission(access, ADMIN_PERMISSION.creditRead),
      walletRead: hasPermission(access, ADMIN_PERMISSION.userWalletRead) || hasPermission(access, ADMIN_PERMISSION.userFinanceRead) || hasPermission(access, ADMIN_PERMISSION.financeRead),
      businessScopeUsable: true };
    if (filter.phone !== undefined && !viewer.phoneLookup || filter.membershipTier !== undefined && !viewer.membershipSummaryRead) {
      return { ...base, state: "FORBIDDEN", reason: "FILTER_FIELD_PERMISSION_REQUIRED" };
    }
    if (filter.membershipTier !== undefined) return { ...base, reason: "MEMBERSHIP_TIER_FILTER_AGGREGATE_NOT_SUPPORTED" };
    // 关键词场景的状态分布要在同一张全表上再做一次 ILIKE + 多列 FILTER 聚合；列表已按相同条件返回命中数，
    // 概览这里直接标记不支持，避免单个搜索触发第二次全表扫描（前端也已跳过该请求，此处是多端兜底）。
    if (filter.search !== undefined || filter.identifier !== undefined) {
      return { ...base, state: "UNKNOWN", reason: "KEYWORD_SEARCH_AGGREGATE_NOT_SUPPORTED" };
    }
    let query: { text: string; values: unknown[] };
    try { query = await userDirectoryStatusCountQuery(client, viewer, filter, clock.asOf); }
    catch (error) {
      if ((error as { status?: number }).status === 403) return { ...base, state: "FORBIDDEN", reason: "FILTER_FIELD_PERMISSION_REQUIRED" };
      throw error;
    }
    const row = (await client.query<Record<string, unknown>>(query.text, query.values)).rows[0];
    return countedSummary(base, row, USER_DIRECTORY_STATUS_FILTER, status => userDrilldown(filter, status));
  }
  const filter = request.filter;
  const viewer: OrderReadViewer = { adminId: context.userId, isBoss: access.isBoss, internalQuote: false, authorizationKey };
  const continuation = await legacyContinuationReady(client);
  const { values, where } = adminOrderReadPredicatePlan(viewer, filter, continuation);
  const statuses = [...ORDER_STATUSES, "UNKNOWN"];
  const counts = ORDER_STATUSES.map(status => `count(*) FILTER (WHERE x.status='${status}')::text AS "${status}"`);
  counts.push(`count(*) FILTER (WHERE x.status IS NULL OR x.status NOT IN ('PENDING_PAYMENT','PAID','COMPLETED','CANCELLED'))::text AS "UNKNOWN"`);
  const row = (await client.query<Record<string, unknown>>(`WITH all_orders AS (${orderReadKeyRelation(continuation)})
    SELECT count(*)::text AS total, ${counts.join(", ")} FROM all_orders x WHERE ${where.map(predicate => `(${predicate})`).join(" AND ")}`, values)).rows[0];
  return countedSummary(base, row, statuses, status => orderDrilldown(filter, status));
}

/** Reuses the existing RR/RO, 3s statement, 500ms lock and abort/rollback lease contract. */
export function readAdminDomainSummary(pool: Pool, signal: AbortSignal, context: { userId: string; sessionId: string }, request: AdminDomainSummaryRequest): Promise<AdminDomainSummary> {
  return withDirectoryReadTransaction(pool, signal, client => readAdminDomainSummaryInTransaction(client, context, request));
}
