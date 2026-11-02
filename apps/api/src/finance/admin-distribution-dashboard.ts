import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { ADMIN_PERMISSION, loadEffectiveAdminAccess } from "../auth/admin-authorization";
import { assertAdminContextInTransaction } from "../auth/auth-security";
import { assertUserContextInTransaction, type UserContext } from "../auth/user-identity";
import { assertGameScopeUsable, gameScopeSql, isAllGamesScope, readAdminGameScope, type AdminGameScope } from "../auth/admin-scope";
import { SecurityApiError } from "../auth/security-core";
import { escapeLike } from "../supply/catalog";
import { canonicalize } from "../supply/content-hash";
import { requireListingCursorKey, type ListingCursorKey } from "../supply/listing-cursor";
import { conflict, invalid } from "../supply/supply-util";
import { readMyDistributionEarningsInTransaction } from "./distribution-earning-read";
import { projectInviteeCount } from "./invitation-store";

export const DASHBOARD_VERSION = "admin-distribution.dashboard.v1";
export type DashboardSource = "ALL" | "NATIVE" | "LEGACY";
export type DashboardState = "ALL" | "PENDING" | "SETTLED" | "REVOKED" | "RECOVERY_REQUIRED" | "EXPIRED";
export type DashboardRole = "ALL" | "RENTER_REFERRAL" | "OWNER_REFERRAL" | "TASK_REFERRAL";
export type DashboardRankingBasis = "CURRENT_SETTLED_STOCK" | "PERIOD_SETTLED_FLOW";

export type DashboardFilters = {
  from: string;
  to: string;
  source: DashboardSource;
  state: DashboardState;
  role: DashboardRole;
  q: string;
  page: number;
  pageSize: number;
  rankingBasis: DashboardRankingBasis;
  rankingLimit: number;
};

export type Metric =
  | { knowledge: "KNOWN"; cents: string; count: string | null; reasonCodes: [] }
  | { knowledge: "UNKNOWN"; cents: null; count: null; reasonCodes: string[] };

export type DashboardEarning = {
  id: string;
  source: "NATIVE" | "LEGACY";
  beneficiaryId: string | null;
  beneficiaryName: string | null;
  role: Exclude<DashboardRole, "ALL"> | "UNKNOWN";
  orderId: string | null;
  orderNumber: string | null;
  amountCents: string;
  recoveryRequiredCents: string | null;
  state: Exclude<DashboardState, "ALL"> | "UNKNOWN";
  occurredAt: string | null;
  settledAt: string | null;
  dueAt: string | null;
  recordedAt: string | null;
  gameId: string | null;
};

export type DashboardScope = {
  isBoss: boolean;
  games: "ALL_GAMES" | "SELECTED_GAMES" | "NO_SCOPE";
  gameIds: string[];
  network: "AVAILABLE" | "UNAVAILABLE";
  reasonCodes: string[];
};

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UNKNOWN = (reason: string): Metric => ({ knowledge: "UNKNOWN", cents: null, count: null, reasonCodes: [reason] });
const KNOWN = (cents: string, count: string | null = null): Metric => ({ knowledge: "KNOWN", cents: cents, count, reasonCodes: [] });
const day = (value: Date) => new Date(value.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
const addDays = (value: string, days: number) => {
  const date = new Date(`${value}T00:00:00Z`);
  return new Date(date.getTime() + days * 86400_000).toISOString().slice(0, 10);
};
const rangeStart = (from: string) => `${from}T00:00:00+08:00`;
const rangeEnd = (to: string) => `${addDays(to, 1)}T00:00:00+08:00`;

export function parseDashboardFilters(query: URLSearchParams, now = new Date()): DashboardFilters {
  const today = day(now), from = query.get("from") ?? addDays(today, -29), to = query.get("to") ?? today;
  if (![from, to].every(value => {
    const date = new Date(`${value}T00:00:00Z`);
    return DATE.test(value) && Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
  }) || from > to) throw invalid("Invalid distribution period");
  const days = (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000 + 1;
  if (!Number.isInteger(days) || days < 1 || days > 367) throw invalid("Distribution period must be within 367 days");
  const source = (query.get("source") ?? "ALL") as DashboardSource, state = (query.get("state") ?? "ALL") as DashboardState,
    role = (query.get("role") ?? "ALL") as DashboardRole, rankingBasis = (query.get("rankingBasis") ?? "CURRENT_SETTLED_STOCK") as DashboardRankingBasis;
  if (!["ALL", "NATIVE", "LEGACY"].includes(source) || !["ALL", "PENDING", "SETTLED", "REVOKED", "RECOVERY_REQUIRED", "EXPIRED"].includes(state)
    || !["ALL", "RENTER_REFERRAL", "OWNER_REFERRAL", "TASK_REFERRAL"].includes(role) || !["CURRENT_SETTLED_STOCK", "PERIOD_SETTLED_FLOW"].includes(rankingBasis)) throw invalid("Invalid distribution filter");
  const q = (query.get("q") ?? "").trim(), page = query.get("page") ?? "1", pageSize = query.get("pageSize") ?? "20", rankingLimit = Number(query.get("rankingLimit") ?? "10");
  if (q.length > 128 || !/^[A-Za-z0-9\u4e00-\u9fff._:@ -]*$/.test(q)) throw invalid("Invalid distribution search");
  if (!/^[1-9]\d{0,5}$/.test(page) || !/^([1-9]|[1-9]\d|100)$/.test(pageSize)) throw invalid("Invalid distribution page");
  if (!Number.isInteger(rankingLimit) || rankingLimit < 10 || rankingLimit > 100) throw invalid("Invalid distribution ranking limit");
  return { from, to, source, state, role, q, page: Number(page), pageSize: Number(pageSize), rankingBasis, rankingLimit };
}

type DashboardAccess = {
  actor: { userId: string; sessionId: string };
  access: NonNullable<Awaited<ReturnType<typeof loadEffectiveAdminAccess>>>;
  gameScope: AdminGameScope;
  filterScope: "ALL" | "SELECTED";
  scope: DashboardScope;
  directoryRead: boolean;
  authorizationKey: string;
};

export async function authorizeDistributionDashboard(c: PoolClient, actor: { userId: string; sessionId: string }): Promise<DashboardAccess> {
  await assertAdminContextInTransaction(c, actor);
  const access = await loadEffectiveAdminAccess(c, actor.userId);
  if (!access || access.status !== "ACTIVE") throw new SecurityApiError(403, "FORBIDDEN", "Active administrator required");
  if (access.passwordChangeRequired) throw new SecurityApiError(403, "FORBIDDEN", "Password change required");
  if (!access.isBoss && !access.permissions.has(ADMIN_PERMISSION.distributionDashboardRead)) throw new SecurityApiError(403, "FORBIDDEN", "Distribution dashboard permission required");
  const gameScope = await readAdminGameScope(c, actor.userId);
  assertGameScopeUsable(gameScope, access.isBoss);
  const network = access.isBoss || isAllGamesScope(gameScope);
  const scope: DashboardScope = {
    isBoss: access.isBoss,
    games: access.isBoss || isAllGamesScope(gameScope) ? "ALL_GAMES" : gameScope.gameIds.length ? "SELECTED_GAMES" : "NO_SCOPE",
    gameIds: access.isBoss || isAllGamesScope(gameScope) ? [] : [...gameScope.gameIds],
    network: network ? "AVAILABLE" : "UNAVAILABLE",
    reasonCodes: network ? [] : ["GLOBAL_RELATION_SCOPE_UNAVAILABLE"],
  };
  const authorizationKey = createHash("sha256").update(canonicalize([actor.userId, actor.sessionId, access.isBoss, [...access.permissions].sort(), scope.games, scope.gameIds])).digest("hex");
  return { actor, access, gameScope, filterScope: network ? "ALL" : "SELECTED", scope, directoryRead: access.isBoss || access.permissions.has(ADMIN_PERMISSION.userDirectoryRead), authorizationKey };
}

function scopeSql(alias: string, values: unknown[], context: DashboardAccess) {
  values.push(context.actor.userId, context.access.isBoss);
  return gameScopeSql(`${alias}.game_id`, `$${values.length - 1}`, `$${values.length}`);
}

export async function dashboardVersion(c: PoolClient, context: DashboardAccess, legacyAvailable: boolean) {
  const values: unknown[] = [], nativeScope = scopeSql("o", values, context);
  const digest = (table: string) => `(SELECT encode(sha256(convert_to(COALESCE(string_agg(encode(sha256(convert_to(payload,'UTF8')),'hex'),'' ORDER BY id),''),'UTF8')),'hex') FROM ${table})`;
  const name = context.directoryRead ? "u.name" : "NULL::text";
  // Hash only visible domain facts: unrelated games, ledger events and hidden names cannot disturb a page.
  const row = (await c.query(`WITH visible_earnings AS (
    SELECT e.id,jsonb_build_array(e.id,e.version,e.state,e.amount_cents::text,e.recovery_required_cents::text,e.due_at,e.created_at,
      e.beneficiary_user_id,e.beneficiary_role,o.id,o.display_no,o.game_id,${name})::text payload
    FROM zzsh_order.rental_referral_earning e JOIN zzsh_order.rental_order o ON o.id=e.order_id
    LEFT JOIN zzsh_auth_user."user" u ON u.id=e.beneficiary_user_id WHERE ${nativeScope}
  ), visible_events AS (
    SELECT t.id,jsonb_build_array(t.id,t.action,t.created_at,f.id,f.kind,f.created_at)::text payload
    FROM zzsh_order.rental_referral_transition t JOIN visible_earnings e ON e.id=t.earning_id
    JOIN zzsh_order.finance_event f ON f.id=t.finance_event_id AND f.economic_root_id=e.id
  ), visible_legacy AS (
    ${legacyAvailable ? `SELECT p.id,jsonb_build_array(p.id,p.user_id,p.source_system,p.snapshot->>'orderId',p.snapshot->>'amount',p.snapshot->>'sourceStatus',p.snapshot->>'level',p.source_event_at,p.imported_at,lo.id,lo.original_order_no,lo.game_id,${name})::text payload
      FROM zzsh_order.personal_finance_observation p LEFT JOIN zzsh_order.legacy_order_read_snapshot lo ON lo.legacy_id=p.snapshot->>'orderId' AND lo.source_system=p.source_system
      LEFT JOIN zzsh_auth_user."user" u ON u.id=p.user_id WHERE p.source_kind='HISTORICAL_DISTRIBUTION' AND ${nativeScope.replaceAll('o.game_id','lo.game_id')}` : "SELECT NULL::text id,NULL::text payload WHERE FALSE"}
  ), visible_participants AS (
    ${context.scope.network === "AVAILABLE" ? `SELECT p.user_id id,jsonb_build_array(p.user_id,p.revision,p.eligibility,p.commission_frozen,p.level_code,p.inviter_knowledge,p.leader_knowledge,p.source_type,${name})::text payload
      FROM zzsh_order.distribution_participant p LEFT JOIN zzsh_auth_user."user" u ON u.id=p.user_id` : "SELECT NULL::text id,NULL::text payload WHERE FALSE"}
  ), visible_relations AS (
    ${context.scope.network === "AVAILABLE" ? "SELECT r.id,jsonb_build_array(r.id,r.type,r.parent_user_id,r.child_user_id,r.source_type,r.policy_version_id)::text payload FROM zzsh_order.invitation_relation r" : "SELECT NULL::text id,NULL::text payload WHERE FALSE"}
  ) SELECT ${digest('visible_earnings')} native,${digest('visible_events')} events,${digest('visible_legacy')} legacy,
    ${digest('visible_participants')} participants,${digest('visible_relations')} relations`, values)).rows[0];
  if (!row) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Distribution version unavailable");
  return createHash("sha256").update(canonicalize({ ...row, legacyAvailable })).digest("hex");
}

type SnapshotPayload = {
  audience: string; keyId: string; actor: string; session: string; access: string; scope: string; filters: string;
  version: string; asOf: string; expiresAt: number;
};
function filterKey(filters: DashboardFilters) { const { page: _page, ...rest } = filters; return createHash("sha256").update(canonicalize(rest)).digest("hex"); }
export function distributionSnapshot(version: string, asOf: string, filters: DashboardFilters, context: DashboardAccess, key: ListingCursorKey | undefined, token?: string | null, now = Date.now()) {
  requireListingCursorKey(key);
  const binding = { audience: DASHBOARD_VERSION, keyId: key.keyId, actor: createHash("sha256").update(context.actor.userId).digest("hex"),
    session: createHash("sha256").update(context.actor.sessionId).digest("hex"), access: context.authorizationKey,
    scope: createHash("sha256").update(canonicalize(context.scope)).digest("hex"), filters: filterKey(filters), version };
  let value: SnapshotPayload;
  if (token) {
    try {
      if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw Error();
      const [body, signature] = token.split(".") as [string, string], expected = createHmac("sha256", key.secret).update(body).digest(), actual = Buffer.from(signature, "base64url");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
      value = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as SnapshotPayload;
      if (value.audience !== binding.audience || value.keyId !== binding.keyId || !Number.isFinite(value.expiresAt) || value.expiresAt <= now
        || typeof value.asOf !== "string" || !Number.isFinite(Date.parse(value.asOf))) throw conflict("Distribution snapshot expired; reload");
      for (const name of ["actor", "session", "access", "scope", "filters", "version"] as const) if ((value as any)[name] !== (binding as any)[name]) throw conflict("Distribution data changed; reload");
    } catch (error) { if (error instanceof SecurityApiError) throw error; throw invalid("Invalid distribution snapshot"); }
  } else value = { ...binding, asOf, expiresAt: now + 600_000 };
  const body = Buffer.from(JSON.stringify(value)).toString("base64url");
  return { token: `${body}.${createHmac("sha256", key.secret).update(body).digest("base64url")}`, asOf: value.asOf, version };
}

async function ready(c: PoolClient) {
  const row = (await c.query(`SELECT to_regclass('zzsh_order.rental_referral_earning') IS NOT NULL AND to_regclass('zzsh_order.rental_referral_transition') IS NOT NULL
    AND to_regclass('zzsh_order.finance_event') IS NOT NULL AND to_regclass('zzsh_order.rental_order') IS NOT NULL
    AND to_regclass('zzsh_order.distribution_participant') IS NOT NULL AND to_regclass('zzsh_order.invitation_relation') IS NOT NULL AS native,
    to_regclass('zzsh_order.personal_finance_observation') IS NOT NULL AND to_regclass('zzsh_order.legacy_order_read_snapshot') IS NOT NULL AS legacy`)).rows[0];
  if (row?.native !== true) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Distribution dashboard sources unavailable");
  return { native: true, legacy: row.legacy === true };
}

export function stockMetrics(rows: any[]) {
  const map = new Map(rows.map((row: any) => [String(row.state), row]));
  const metric = (state: string) => { const row = map.get(state); return row ? KNOWN(String(row.cents), String(row.count)) : KNOWN("0", "0"); };
  return { settled: metric("SETTLED"), pending: metric("PENDING"), recovery: metric("RECOVERY_REQUIRED"), revoked: metric("REVOKED") };
}

export async function nativeStock(c: PoolClient, f: DashboardFilters, context: DashboardAccess) {
  const values: unknown[] = [], scope = scopeSql("o", values, context);
  const rows = (await c.query(`SELECT e.state,count(*)::int AS count,
    COALESCE(sum(CASE WHEN e.state='RECOVERY_REQUIRED' THEN COALESCE(e.recovery_required_cents,0) ELSE e.amount_cents END),0)::text AS cents
    FROM zzsh_order.rental_referral_earning e JOIN zzsh_order.rental_order o ON o.id=e.order_id
    WHERE ${scope} GROUP BY e.state`, values)).rows;
  const orders = (await c.query(`SELECT count(DISTINCT e.order_id)::text AS count FROM zzsh_order.rental_referral_earning e JOIN zzsh_order.rental_order o ON o.id=e.order_id WHERE ${scope}`, values)).rows[0];
  return { ...stockMetrics(rows), orders: KNOWN("0", String(orders?.count ?? "0")) };
}

export async function legacyStock(c: PoolClient, f: DashboardFilters, context: DashboardAccess, available: boolean) {
  if (!available) return { settled: UNKNOWN("LEGACY_SOURCE_NOT_INSTALLED"), pending: UNKNOWN("LEGACY_SOURCE_NOT_INSTALLED"), expired: UNKNOWN("LEGACY_SOURCE_NOT_INSTALLED"), orders: UNKNOWN("LEGACY_SOURCE_NOT_INSTALLED"), coverage: "UNKNOWN" as const };
  const values: unknown[] = [], scope = scopeSql("lo", values, context);
  const rows = (await c.query(`SELECT o.snapshot->>'sourceStatus' AS status,count(*)::int AS count,
    COALESCE(sum(round((o.snapshot->>'amount')::numeric*100)),0)::text AS cents
    FROM zzsh_order.personal_finance_observation o LEFT JOIN zzsh_order.legacy_order_read_snapshot lo ON lo.legacy_id=(o.snapshot->>'orderId') AND lo.source_system=o.source_system
    WHERE o.source_kind='HISTORICAL_DISTRIBUTION' AND (${scope}) GROUP BY 1`, values)).rows;
  const map = new Map(rows.map((row: any) => [String(row.status), row]));
  const metric = (status: string) => { const row = map.get(status); return row ? KNOWN(String(row.cents), String(row.count)) : KNOWN("0", "0"); };
  const orders = (await c.query(`SELECT count(DISTINCT o.snapshot->>'orderId')::text AS count FROM zzsh_order.personal_finance_observation o LEFT JOIN zzsh_order.legacy_order_read_snapshot lo ON lo.legacy_id=(o.snapshot->>'orderId') AND lo.source_system=o.source_system WHERE o.source_kind='HISTORICAL_DISTRIBUTION' AND o.snapshot->>'orderId' IS NOT NULL AND (${scope})`, values)).rows[0];
  return { settled: metric("2"), pending: metric("1"), expired: metric("3"), orders: KNOWN("0", String(orders?.count ?? "0")), coverage: "UNKNOWN" as const };
}

export function bucketFlow(rows: any[]) {
  const map = new Map(rows.map((row: any) => [`${row.kind}:${row.action}`, row]));
  const metric = (kind: string, action: string) => { const row = map.get(`${kind}:${action}`); return row ? KNOWN(String(row.cents), String(row.count)) : KNOWN("0", "0"); };
  return { accrued: metric("EARNING_PENDING", "ACCRUE"), settled: metric("EARNING_SETTLED", "SETTLE"), reversed: metric("EARNING_REVOKED", "REVOKE"), recovered: metric("EARNING_REVOKED", "RECOVER") };
}

async function flow(c: PoolClient, f: DashboardFilters, context: DashboardAccess) {
  const values: unknown[] = [rangeStart(f.from), rangeEnd(f.to)], scope = scopeSql("o", values, context);
  const rows = (await c.query(`SELECT f.kind,t.action,count(*)::int AS count, COALESCE(sum(e.amount_cents),0)::text AS cents
    FROM zzsh_order.finance_event f JOIN zzsh_order.rental_referral_earning e ON e.id=f.economic_root_id
    JOIN zzsh_order.rental_referral_transition t ON t.finance_event_id=f.id AND t.earning_id=e.id
    JOIN zzsh_order.rental_order o ON o.id=e.order_id
    WHERE f.created_at >= $1::timestamptz AND f.created_at < $2::timestamptz AND ${scope}
      AND ((f.kind='EARNING_PENDING' AND t.action='ACCRUE') OR (f.kind='EARNING_SETTLED' AND t.action='SETTLE') OR (f.kind='EARNING_REVOKED' AND t.action IN ('REVOKE','RECOVER')))
    GROUP BY f.kind,t.action`, values)).rows;
  return bucketFlow(rows);
}

async function trend(c: PoolClient, f: DashboardFilters, context: DashboardAccess) {
  const end = f.to, start = addDays(end, -29) < f.from ? f.from : addDays(end, -29), values: unknown[] = [rangeStart(start), rangeEnd(end)], scope = scopeSql("o", values, context);
  const rows = (await c.query(`SELECT to_char(f.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,COALESCE(sum(e.amount_cents),0)::text AS cents
    FROM zzsh_order.finance_event f JOIN zzsh_order.rental_referral_earning e ON e.id=f.economic_root_id
    JOIN zzsh_order.rental_referral_transition t ON t.finance_event_id=f.id AND t.earning_id=e.id
    JOIN zzsh_order.rental_order o ON o.id=e.order_id
    WHERE f.kind='EARNING_SETTLED' AND t.action='SETTLE' AND f.created_at >= $1::timestamptz AND f.created_at < $2::timestamptz AND ${scope}
    GROUP BY 1 ORDER BY 1`, values)).rows;
  const map = new Map(rows.map((row: any) => [String(row.day), String(row.cents)]));
  return Array.from({ length: Math.round((Date.parse(`${end}T00:00:00Z`) - Date.parse(`${start}T00:00:00Z`)) / 86400_000) + 1 }, (_, index) => {
    const date = addDays(start, index); return { date, cents: map.get(date) ?? "0", knowledge: "KNOWN" as const };
  });
}

export function rankingRows(rows: any[], mode: "money" | "count" = "money") {
  let last: string | null = null, rank = 0;
  return rows
    .filter(row => {
      const value = String(mode === "count" ? row.count ?? "0" : row.cents ?? "0");
      return /^-?\d+$/.test(value) && BigInt(value) > 0n;
    })
    .map((row, index) => {
      const value = String(mode === "count" ? row.count ?? "0" : row.cents ?? "0");
      if (value !== last) { rank = index + 1; last = value; }
      return { rank, userId: row.user_id ?? row.userId ?? null, name: row.name ?? null, cents: mode === "count" ? "0" : value, roles: Array.isArray(row.roles) ? row.roles : [], count: row.count == null ? null : String(row.count) };
    });
}

async function nativeRanking(c: PoolClient, f: DashboardFilters, context: DashboardAccess) {
  const period = f.rankingBasis === "PERIOD_SETTLED_FLOW";
  const values: unknown[] = period ? [rangeStart(f.from), rangeEnd(f.to)] : [], scope = scopeSql("o", values, context);
  const rows = (await c.query(`SELECT e.beneficiary_user_id AS user_id,u.name,array_agg(DISTINCT e.beneficiary_role) AS roles,sum(e.amount_cents)::text AS cents
    FROM zzsh_order.rental_referral_earning e JOIN zzsh_order.rental_order o ON o.id=e.order_id LEFT JOIN zzsh_auth_user."user" u ON u.id=e.beneficiary_user_id
    ${period ? "JOIN zzsh_order.rental_referral_transition t ON t.earning_id=e.id AND t.action='SETTLE' JOIN zzsh_order.finance_event f ON f.id=t.finance_event_id" : ""}
    WHERE ${period ? "f.created_at >= $1::timestamptz AND f.created_at < $2::timestamptz" : "e.state='SETTLED'"} AND ${scope}
    GROUP BY e.beneficiary_user_id,u.name ORDER BY sum(e.amount_cents) DESC,e.beneficiary_user_id LIMIT ${f.rankingLimit}`, values)).rows;
  return rankingRows(rows.map((row: any) => ({ ...row, name: context.directoryRead ? row.name : null })));
}

async function legacyRanking(c: PoolClient, context: DashboardAccess, available: boolean, limit: number) {
  if (!available) return [] as ReturnType<typeof rankingRows>;
  const values: unknown[] = [], scope = scopeSql("lo", values, context);
  const rows = (await c.query(`SELECT o.user_id,u.name,sum(round((o.snapshot->>'amount')::numeric*100))::text AS cents
    FROM zzsh_order.personal_finance_observation o LEFT JOIN zzsh_order.legacy_order_read_snapshot lo ON lo.legacy_id=(o.snapshot->>'orderId') AND lo.source_system=o.source_system LEFT JOIN zzsh_auth_user."user" u ON u.id=o.user_id
    WHERE o.source_kind='HISTORICAL_DISTRIBUTION' AND o.snapshot->>'sourceStatus'='2' AND (${scope})
    GROUP BY o.user_id,u.name ORDER BY sum(round((o.snapshot->>'amount')::numeric*100)) DESC,o.user_id LIMIT ${limit}`, values)).rows;
  return rankingRows(rows.map((row: any) => ({ ...row, name: context.directoryRead ? row.name : null })));
}

async function inviteRanking(c: PoolClient, context: DashboardAccess, limit: number) {
  if (context.scope.network !== "AVAILABLE") return { items: [], knowledge: "UNKNOWN" as const, reasonCodes: ["GLOBAL_RELATION_SCOPE_UNAVAILABLE"] };
  const rows = (await c.query(`SELECT r.parent_user_id AS user_id,u.name,count(*)::int AS count FROM zzsh_order.invitation_relation r LEFT JOIN zzsh_auth_user."user" u ON u.id=r.parent_user_id
    WHERE r.type='DISTRIBUTION_LEADER' GROUP BY r.parent_user_id,u.name ORDER BY count(*) DESC,r.parent_user_id LIMIT ${limit}`)).rows;
  return { items: rankingRows(rows.map((row: any) => ({ ...row, name: context.directoryRead ? row.name : null })), "count"), knowledge: "KNOWN" as const, reasonCodes: [] as string[] };
}

async function participantCounts(c: PoolClient, context: DashboardAccess) {
  if (context.scope.network !== "AVAILABLE") return { participants: UNKNOWN("GLOBAL_RELATION_SCOPE_UNAVAILABLE"), eligible: UNKNOWN("GLOBAL_RELATION_SCOPE_UNAVAILABLE"), frozen: UNKNOWN("GLOBAL_RELATION_SCOPE_UNAVAILABLE"), inviter: UNKNOWN("GLOBAL_RELATION_SCOPE_UNAVAILABLE"), leader: UNKNOWN("GLOBAL_RELATION_SCOPE_UNAVAILABLE") };
  const row = (await c.query(`SELECT count(*)::int AS participants,count(*) FILTER(WHERE eligibility='ELIGIBLE')::int AS eligible,count(*) FILTER(WHERE commission_frozen)::int AS frozen FROM zzsh_order.distribution_participant`)).rows[0];
  const relations = (await c.query(`SELECT type,count(*)::int AS count FROM zzsh_order.invitation_relation GROUP BY type`)).rows;
  const relation = (type: string) => { const found = relations.find((item: any) => item.type === type); return found ? KNOWN("0", String(found.count)) : KNOWN("0", "0"); };
  return { participants: KNOWN("0", String(row?.participants ?? 0)), eligible: KNOWN("0", String(row?.eligible ?? 0)), frozen: KNOWN("0", String(row?.frozen ?? 0)), inviter: relation("INVITER"), leader: relation("DISTRIBUTION_LEADER") };
}

export async function readAdminDistributionOverview(c: PoolClient, context: DashboardAccess, f: DashboardFilters) {
  const sources = await ready(c), version = await dashboardVersion(c, context, sources.legacy), asOf = (await c.query(`SELECT clock_timestamp()::text AS at`)).rows[0]!.at;
  const native = await nativeStock(c, f, context), legacy = await legacyStock(c, f, context, sources.legacy),
    flows = await flow(c, f, context), points = await trend(c, f, context), nativeTop = await nativeRanking(c, f, context),
    legacyTop = await legacyRanking(c, context, sources.legacy, f.rankingLimit), invites = await inviteRanking(c, context, f.rankingLimit), participants = await participantCounts(c, context);
  return {
    contractVersion: DASHBOARD_VERSION, asOf, timezone: "Asia/Shanghai", snapshotVersion: version, applied: f, scope: context.scope,
    native, legacy, flow: flows, trend: points, participants,
    rankings: { nativeEarnings: nativeTop, legacyEarnings: legacyTop, directInvites: invites },
    recent: await readAdminDistributionEarnings(c, context, f, undefined, 10, null, { sources, version, asOf }).then(value => value.items),
    reasonCodes: [ ...(sources.legacy ? [] : ["LEGACY_SOURCE_NOT_INSTALLED"]), ...(context.scope.network === "AVAILABLE" ? [] : ["GLOBAL_RELATION_SCOPE_UNAVAILABLE"]) ],
  };
}

function listWhere(f: DashboardFilters, values: unknown[], context: DashboardAccess) {
  const clauses: string[] = [];
  values.push(rangeStart(f.from), rangeEnd(f.to));
  clauses.push(`occurred_at >= $${values.length - 1}::timestamptz AND occurred_at < $${values.length}::timestamptz`);
  if (f.source !== "ALL") { values.push(f.source); clauses.push(`source=$${values.length}`); }
  if (f.state !== "ALL") { values.push(f.state); clauses.push(`state=$${values.length}`); }
  if (f.role !== "ALL") { values.push(f.role); clauses.push(`role=$${values.length}`); }
  if (f.q) { values.push(`%${escapeLike(f.q.toLowerCase())}%`); clauses.push(`lower(coalesce(beneficiary_id,'')||' '||${context.directoryRead ? "coalesce(beneficiary_name,'')||' '||" : ""}coalesce(order_number,'')) LIKE $${values.length}`); }
  return clauses.length ? clauses.join(" AND ") : "TRUE";
}

export function mapEarningRow(row: any, directoryRead: boolean): DashboardEarning {
  return { id: String(row.id), source: row.source, beneficiaryId: row.beneficiary_id ?? null, beneficiaryName: directoryRead ? row.beneficiary_name ?? null : null,
    role: row.role ?? "UNKNOWN", orderId: row.order_id ?? null, orderNumber: row.order_number ?? null, amountCents: String(row.amount_cents ?? "0"),
    recoveryRequiredCents: row.recovery_cents ?? null, state: row.state ?? "UNKNOWN", occurredAt: row.occurred_at ?? null, settledAt: row.settled_at ?? null,
    dueAt: row.due_at ?? null, recordedAt: row.recorded_at ?? null, gameId: row.game_id ?? null };
}

export async function readAdminDistributionEarnings(c: PoolClient, context: DashboardAccess, f: DashboardFilters, key?: ListingCursorKey, limitOverride?: number, token?: string | null, prepared?: { sources: { native: boolean; legacy: boolean }; version: string; asOf: string }) {
  const sources = prepared?.sources ?? await ready(c), version = prepared?.version ?? await dashboardVersion(c, context, sources.legacy), asOf = prepared?.asOf ?? (await c.query(`SELECT clock_timestamp()::text AS at`)).rows[0]!.at;
  if (f.source === "LEGACY" && !sources.legacy) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Legacy distribution source unavailable");
  const values: unknown[] = [], nativeScope = scopeSql("o", values, context);
  const native = `SELECT e.id,'NATIVE' AS source,e.beneficiary_user_id AS beneficiary_id,u.name AS beneficiary_name,e.beneficiary_role AS role,
    e.order_id,o.display_no AS order_number,e.amount_cents::text AS amount_cents,CASE WHEN e.state='RECOVERY_REQUIRED' THEN e.recovery_required_cents::text ELSE NULL END AS recovery_cents,
    e.state,e.created_at AS occurred_at,
    (SELECT f.created_at FROM zzsh_order.rental_referral_transition t JOIN zzsh_order.finance_event f ON f.id=t.finance_event_id WHERE t.earning_id=e.id AND t.action='SETTLE') AS settled_at,
    e.due_at,e.created_at AS recorded_at,o.game_id
    FROM zzsh_order.rental_referral_earning e JOIN zzsh_order.rental_order o ON o.id=e.order_id LEFT JOIN zzsh_auth_user."user" u ON u.id=e.beneficiary_user_id WHERE ${nativeScope}`;
  const legacy = sources.legacy ? `SELECT o.id,'LEGACY' AS source,o.user_id AS beneficiary_id,u.name AS beneficiary_name,
    CASE o.snapshot->>'level' WHEN '2' THEN 'RENTER_REFERRAL' WHEN '3' THEN 'OWNER_REFERRAL' WHEN '1' THEN 'TASK_REFERRAL' ELSE 'UNKNOWN' END AS role,
    lo.id AS order_id,lo.original_order_no AS order_number,round((o.snapshot->>'amount')::numeric*100)::text AS amount_cents,NULL::text AS recovery_cents,
    CASE o.snapshot->>'sourceStatus' WHEN '1' THEN 'PENDING' WHEN '2' THEN 'SETTLED' WHEN '3' THEN 'EXPIRED' ELSE 'UNKNOWN' END AS state,
    o.source_event_at AS occurred_at,NULL::timestamptz AS settled_at,NULL::timestamptz AS due_at,o.imported_at AS recorded_at,lo.game_id
    FROM zzsh_order.personal_finance_observation o LEFT JOIN zzsh_order.legacy_order_read_snapshot lo ON lo.legacy_id=(o.snapshot->>'orderId') AND lo.source_system=o.source_system
    LEFT JOIN zzsh_auth_user."user" u ON u.id=o.user_id WHERE o.source_kind='HISTORICAL_DISTRIBUTION' AND (${nativeScope.replaceAll("o.game_id", "lo.game_id")})` : `SELECT NULL::text AS id,'LEGACY' AS source,NULL::text AS beneficiary_id,NULL::text AS beneficiary_name,NULL::text AS role,NULL::text AS order_id,NULL::text AS order_number,NULL::text AS amount_cents,NULL::text AS recovery_cents,NULL::text AS state,NULL::timestamptz AS occurred_at,NULL::timestamptz AS settled_at,NULL::timestamptz AS due_at,NULL::timestamptz AS recorded_at,NULL::text AS game_id WHERE FALSE`;
  const where = listWhere(f, values, context), offset = (f.page - 1) * (limitOverride ?? f.pageSize), limit = limitOverride ?? f.pageSize;
  values.push(limit, offset);
  const rows = (await c.query(`WITH rows AS (${native} UNION ALL ${legacy}) SELECT *,count(*) OVER()::int AS total FROM rows WHERE ${where} ORDER BY occurred_at DESC NULLS LAST,id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values)).rows;
  const items: DashboardEarning[] = rows.map((row: any) => mapEarningRow(row, context.directoryRead));
  const total = rows.length ? Number(rows[0].total) : Number((await c.query(`WITH rows AS (${native} UNION ALL ${legacy}) SELECT count(*)::text AS total FROM rows WHERE ${where}`,values.slice(0,-2))).rows[0]?.total);
  if(!Number.isSafeInteger(total)||total<0)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Distribution total unavailable');
  const snapshot = key ? distributionSnapshot(version, asOf, f, context, key, token) : null;
  return { contractVersion: DASHBOARD_VERSION, asOf, snapshotVersion: version, applied: f, scope: context.scope, items, total: String(total), page: f.page, pageSize: limit, hasMore: offset + items.length < total, snapshot: snapshot?.token ?? null };
}

export async function readAdminDistributionParticipants(c: PoolClient, context: DashboardAccess, f: DashboardFilters, key?: ListingCursorKey, token?: string | null, exactUserId?: string) {
  if (context.scope.network !== "AVAILABLE") throw new SecurityApiError(403, "FORBIDDEN", "Global distribution network requires Boss or ALL_GAMES scope");
  const sources = await ready(c), version = await dashboardVersion(c, context, sources.legacy), asOf = (await c.query(`SELECT clock_timestamp()::text AS at`)).rows[0]!.at;
  const values: unknown[] = [], where: string[] = [];
  if (exactUserId) { values.push(exactUserId); where.push(`p.user_id=$${values.length}`); }
  if (f.q) { values.push(`%${escapeLike(f.q.toLowerCase())}%`); where.push(`lower(coalesce(p.user_id,'')${context.directoryRead ? "||' '||coalesce(u.name,'')" : ""}) LIKE $${values.length}`); }
  const limit = f.pageSize, offset = (f.page - 1) * limit;
  values.push(limit, offset);
  const rows = (await c.query(`SELECT p.user_id,u.name,p.eligibility,p.commission_frozen,p.level_code,p.inviter_knowledge,p.leader_knowledge,p.source_type,p.revision,
    (SELECT count(*)::int FROM zzsh_order.invitation_relation r WHERE r.parent_user_id=p.user_id AND r.type='DISTRIBUTION_LEADER') AS leader_children,
    (SELECT count(*)::int FROM zzsh_order.invitation_relation r WHERE r.parent_user_id=p.user_id AND r.type='INVITER') AS inviter_children,
    (SELECT COALESCE(sum(e.amount_cents),0)::text FROM zzsh_order.rental_referral_earning e WHERE e.beneficiary_user_id=p.user_id AND e.state='SETTLED') AS settled_cents,
    (SELECT COALESCE(sum(e.amount_cents),0)::text FROM zzsh_order.rental_referral_earning e WHERE e.beneficiary_user_id=p.user_id AND e.state='PENDING') AS pending_cents,
    (SELECT COALESCE(sum(e.recovery_required_cents),0)::text FROM zzsh_order.rental_referral_earning e WHERE e.beneficiary_user_id=p.user_id AND e.state='RECOVERY_REQUIRED') AS recovery_cents,
    count(*) OVER()::int AS total
    FROM zzsh_order.distribution_participant p LEFT JOIN zzsh_auth_user."user" u ON u.id=p.user_id ${where.length ? "WHERE " + where.join(" AND ") : ""}
    ORDER BY p.user_id LIMIT $${values.length - 1} OFFSET $${values.length}` , values)).rows;
  const total = rows.length ? Number(rows[0].total) : Number((await c.query(`SELECT count(*)::text AS total FROM zzsh_order.distribution_participant p LEFT JOIN zzsh_auth_user."user" u ON u.id=p.user_id ${where.length ? "WHERE " + where.join(" AND ") : ""}`,values.slice(0,-2))).rows[0]?.total);
  if(!Number.isSafeInteger(total)||total<0)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Distribution total unavailable');
  const snapshot = key ? distributionSnapshot(version, asOf, f, context, key, token) : null;
  return { contractVersion: DASHBOARD_VERSION, asOf, snapshotVersion: version, scope: context.scope, items: rows.map((row: any) => ({ userId: row.user_id, name: context.directoryRead ? row.name ?? null : null,
    eligibility: row.eligibility, frozen: row.commission_frozen === true, levelCode: row.level_code ?? null, inviter: row.inviter_knowledge, leader: row.leader_knowledge,
    sourceType: row.source_type, revision: String(row.revision ?? "0"), leaderChildren: Number(row.leader_children ?? 0), inviterChildren: Number(row.inviter_children ?? 0),
    settledCents: String(row.settled_cents ?? "0"), pendingCents: String(row.pending_cents ?? "0"), recoveryCents: String(row.recovery_cents ?? "0") })), total: String(total), page: f.page, pageSize: limit, hasMore: offset + rows.length < total, snapshot: snapshot?.token ?? null };
}

export async function readAdminDistributionParticipant(c: PoolClient, context: DashboardAccess, userId: string) {
  if (!ID.test(userId)) throw invalid("Invalid distribution participant");
  if (context.scope.network !== "AVAILABLE") throw new SecurityApiError(403, "FORBIDDEN", "Global distribution network requires Boss or ALL_GAMES scope");
  const rows = await readAdminDistributionParticipants(c, context, { from: "2000-01-01", to: "2099-12-31", source: "ALL", state: "ALL", role: "ALL", q: "", page: 1, pageSize: 20, rankingBasis: "CURRENT_SETTLED_STOCK", rankingLimit: 10 }, undefined, null, userId);
  const participant = rows.items.find(item => item.userId === userId);
  if (!participant) throw new SecurityApiError(404, "NOT_FOUND", "Distribution participant not found");
  const relations = (await c.query(`SELECT r.type,r.parent_user_id,u.name,r.source_type,r.policy_version_id FROM zzsh_order.invitation_relation r LEFT JOIN zzsh_auth_user."user" u ON u.id=r.parent_user_id WHERE r.child_user_id=$1 ORDER BY r.type,r.id`,[userId])).rows;
  return { contractVersion: DASHBOARD_VERSION, scope: context.scope, participant, relations: relations.map((row:any)=>({ type:row.type,parentUserId:row.parent_user_id??null,parentName:context.directoryRead?row.name??null:null,sourceType:row.source_type??null,policyVersion:row.policy_version_id??null })) };
}

export async function readMyDistributionSummary(c: PoolClient, actor: UserContext) {
  await assertUserContextInTransaction(c, actor, "READ");
  const sources = await ready(c), asOf = (await c.query(`SELECT clock_timestamp()::text AS at`)).rows[0]!.at;
  const today=day(new Date(asOf));
  const nativeRows = (await c.query(`SELECT state,count(*)::int AS count,COALESCE(sum(CASE WHEN state='RECOVERY_REQUIRED' THEN COALESCE(recovery_required_cents,0) ELSE amount_cents END),0)::text AS cents
    FROM zzsh_order.rental_referral_earning WHERE beneficiary_user_id=$1 GROUP BY state`,[actor.userId])).rows;
  const map = new Map(nativeRows.map((row:any)=>[String(row.state),row])), metric=(state:string)=>{const row=map.get(state);return row?KNOWN(String(row.cents),String(row.count)):KNOWN("0","0")};
  const legacyRows = sources.legacy ? (await c.query(`SELECT snapshot->>'sourceStatus' AS status,count(*)::int AS count,COALESCE(sum(round((snapshot->>'amount')::numeric*100)),0)::text AS cents FROM zzsh_order.personal_finance_observation WHERE user_id=$1 AND source_kind='HISTORICAL_DISTRIBUTION' GROUP BY 1`,[actor.userId])).rows : [];
  const legacyMap = new Map(legacyRows.map((row:any)=>[String(row.status),row])), legacyMetric=(status:string)=>{if(!sources.legacy)return UNKNOWN("LEGACY_SOURCE_NOT_INSTALLED");const row=legacyMap.get(status);return row?KNOWN(String(row.cents),String(row.count)):KNOWN("0","0")};
  const flowRows = (await c.query(`SELECT f.kind,t.action,COALESCE(sum(e.amount_cents),0)::text AS cents,count(*)::int AS count
    FROM zzsh_order.finance_event f JOIN zzsh_order.rental_referral_earning e ON e.id=f.economic_root_id
    JOIN zzsh_order.rental_referral_transition t ON t.finance_event_id=f.id AND t.earning_id=e.id
    WHERE e.beneficiary_user_id=$1 AND f.created_at >= $2::timestamptz AND f.created_at < $3::timestamptz
      AND ((f.kind='EARNING_PENDING' AND t.action='ACCRUE') OR (f.kind='EARNING_SETTLED' AND t.action='SETTLE') OR (f.kind='EARNING_REVOKED' AND t.action IN ('REVOKE','RECOVER')))
    GROUP BY f.kind,t.action`,[actor.userId,rangeStart(today),rangeEnd(today)])).rows;
  const flow=(kind:string,action:string)=>{const row=flowRows.find((r:any)=>r.kind===kind&&r.action===action);return row?KNOWN(String(row.cents),String(row.count)):KNOWN("0","0")};
  const monthStart = `${today.slice(0, 7)}-01`;
  const monthRows = (await c.query(`SELECT f.kind,t.action,COALESCE(sum(e.amount_cents),0)::text AS cents,count(*)::int AS count
    FROM zzsh_order.finance_event f JOIN zzsh_order.rental_referral_earning e ON e.id=f.economic_root_id
    JOIN zzsh_order.rental_referral_transition t ON t.finance_event_id=f.id AND t.earning_id=e.id
    WHERE e.beneficiary_user_id=$1 AND f.created_at >= $2::timestamptz AND f.created_at < $3::timestamptz
      AND f.kind='EARNING_SETTLED' AND t.action='SETTLE' GROUP BY f.kind,t.action`,[actor.userId,rangeStart(monthStart),rangeEnd(today)])).rows;
  const monthSettled = (()=>{const row=monthRows[0];return row?KNOWN(String(row.cents),String(row.count)):KNOWN("0","0")})();
  const trendRows = (await c.query(`SELECT to_char(f.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS day,COALESCE(sum(e.amount_cents),0)::text AS cents
    FROM zzsh_order.finance_event f JOIN zzsh_order.rental_referral_earning e ON e.id=f.economic_root_id
    JOIN zzsh_order.rental_referral_transition t ON t.finance_event_id=f.id AND t.earning_id=e.id
    WHERE e.beneficiary_user_id=$1 AND f.kind='EARNING_SETTLED' AND t.action='SETTLE' AND f.created_at >= $2::timestamptz AND f.created_at < $3::timestamptz GROUP BY 1`,[actor.userId,rangeStart(addDays(today,-29)),rangeEnd(today)])).rows;
  const trendMap=new Map(trendRows.map((r:any)=>[String(r.day),String(r.cents)]));
  const nativeOrders=(await c.query(`SELECT count(DISTINCT order_id)::text AS count FROM zzsh_order.rental_referral_earning WHERE beneficiary_user_id=$1`,[actor.userId])).rows[0];
  const participant=(await c.query(`SELECT invitees_knowledge FROM zzsh_order.distribution_participant WHERE user_id=$1`,[actor.userId])).rows[0];
  const relations=(await c.query(`SELECT type,count(*)::text AS count FROM zzsh_order.invitation_relation WHERE parent_user_id=$1 GROUP BY type`,[actor.userId])).rows;
  const relation=(type:string)=>{const row=relations.find((r:any)=>r.type===type),value=projectInviteeCount(participant?.invitees_knowledge,String(row?.count??"0"));return value.knowledge==='KNOWN'?KNOWN("0",value.count):UNKNOWN(value.reason!)};
  const recent=(await c.query(`SELECT e.id,'NATIVE' AS source,e.beneficiary_user_id AS beneficiary_id,u.name AS beneficiary_name,e.beneficiary_role AS role,e.amount_cents::text AS amount_cents,e.state,e.created_at AS occurred_at
    FROM zzsh_order.rental_referral_earning e LEFT JOIN zzsh_auth_user."user" u ON u.id=e.beneficiary_user_id WHERE e.beneficiary_user_id=$1 ORDER BY e.created_at DESC LIMIT 5`,[actor.userId])).rows;
  const records=await readMyDistributionEarningsInTransaction(c,actor,{state:'ALL',limit:5,cursor:null,projectionVersion:2},undefined,undefined,true);
  if(!('items' in records)||!records.recordSummary)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Commission record summary unavailable');
  return { contractVersion:"distribution-self-summary.v1", asOf, subjectId:actor.userId,
    native:{ settled:metric("SETTLED"),pending:metric("PENDING"),recovery:metric("RECOVERY_REQUIRED"),revoked:metric("REVOKED"),orders:KNOWN("0",String(nativeOrders?.count??"0")) },
    legacy:{ settled:legacyMetric("2"),pending:legacyMetric("1"),expired:legacyMetric("3"),coverage:"UNKNOWN" },
    flow:{ accrued:flow("EARNING_PENDING","ACCRUE"),settled:flow("EARNING_SETTLED","SETTLE"),monthSettled,reversed:flow("EARNING_REVOKED","REVOKE"),recovered:flow("EARNING_REVOKED","RECOVER") },
    network:{ inviter:relation("INVITER"),leader:relation("DISTRIBUTION_LEADER") },
    trend:Array.from({length:30},(_,index)=>{const date=addDays(today,-29+index);return{date,cents:trendMap.get(date)??"0",knowledge:"KNOWN" as const}}),
    recent:recent.map((row:any)=>({id:row.id,source:row.source,beneficiaryId:row.beneficiary_id,beneficiaryName:row.beneficiary_name,role:row.role,amountCents:String(row.amount_cents),state:row.state,occurredAt:row.occurred_at})),
    unified:records.recordSummary,recentRecords:records.items.map(item=>item.record!),
    reasonCodes:[...(sources.legacy?[]:["LEGACY_SOURCE_NOT_INSTALLED"]),...records.recordSummary.reasonCodes] };
}
