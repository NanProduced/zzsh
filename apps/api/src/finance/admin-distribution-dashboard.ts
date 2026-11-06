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
import { commissionRecordSummaryProjection, legacyRentalDistributionPredicate, readMyDistributionEarningsInTransaction } from "./distribution-earning-read";
import { unifiedDistributionSourceSql } from "./admin-distribution-unified-read";
import { readLegacyDistributionQualifications } from "./admin-distribution-read";
import { provedNativeHistoryAbsences, readObservationCoverages, type ObservationCoverage } from "./personal-finance-coverage";
import { projectInviteeCount } from "./invitation-store";

export const DASHBOARD_VERSION = "admin-distribution.dashboard.v1";
export type DashboardSource = "ALL" | "NATIVE" | "LEGACY";
export type DashboardState = "ALL" | "PENDING" | "MATURED" | "SETTLED" | "VOID" | "REVOKED" | "RECOVERY_REQUIRED" | "EXPIRED" | "UNKNOWN";
export type DashboardRole = "ALL" | "RENTER_REFERRAL" | "OWNER_REFERRAL" | "TASK_REFERRAL";
export type DashboardRankingBasis = "CURRENT_SETTLED_STOCK" | "PERIOD_SETTLED_FLOW";
export type DashboardParticipantSort = "recordCount" | "settledCents" | "pendingCents";
export type DashboardSortOrder = "asc" | "desc";

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
  sort: DashboardParticipantSort;
  order: DashboardSortOrder;
  /** Exact beneficiary scope for participant detail; empty means all. */
  beneficiary?: string;
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
  if (!["ALL", "NATIVE", "LEGACY"].includes(source) || !["ALL", "PENDING", "MATURED", "SETTLED", "VOID", "REVOKED", "RECOVERY_REQUIRED", "EXPIRED", "UNKNOWN"].includes(state)
    || !["ALL", "RENTER_REFERRAL", "OWNER_REFERRAL", "TASK_REFERRAL"].includes(role) || !["CURRENT_SETTLED_STOCK", "PERIOD_SETTLED_FLOW"].includes(rankingBasis)) throw invalid("Invalid distribution filter");
  const q = (query.get("q") ?? "").trim(), page = query.get("page") ?? "1", pageSize = query.get("pageSize") ?? "20", rankingLimit = Number(query.get("rankingLimit") ?? "10");
  const sort = (query.get("sort") ?? "recordCount") as DashboardParticipantSort, order = (query.get("order") ?? "desc") as DashboardSortOrder;
  if (q.length > 128 || !/^[A-Za-z0-9\u4e00-\u9fff._:@ -]*$/.test(q)) throw invalid("Invalid distribution search");
  if (!/^[1-9]\d{0,5}$/.test(page) || !/^([1-9]|[1-9]\d|100)$/.test(pageSize)) throw invalid("Invalid distribution page");
  if (!Number.isInteger(rankingLimit) || rankingLimit < 10 || rankingLimit > 100) throw invalid("Invalid distribution ranking limit");
  if (!["recordCount", "settledCents", "pendingCents"].includes(sort) || !["asc", "desc"].includes(order)) throw invalid("Invalid distribution sort");
  const beneficiary = (query.get("beneficiary") ?? "").trim();
  if (beneficiary && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(beneficiary)) throw invalid("Invalid distribution beneficiary");
  return { from, to, source, state, role, q, page: Number(page), pageSize: Number(pageSize), rankingBasis, rankingLimit, sort, order, ...(beneficiary ? { beneficiary } : {}) };
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

export async function dashboardVersion(c: PoolClient, context: DashboardAccess, legacyAvailable: boolean, dutiesAvailable = false, coverageAvailable = false, beneficiary?: string, nativeOriginAvailable = false) {
  const values: unknown[] = [], nativeScope = scopeSql("o", values, context);
  const beneficiaryParameter = beneficiary ? `$${values.push(beneficiary)}::text` : null;
  const subject = (column: string) => beneficiaryParameter ? ` AND ${column}=${beneficiaryParameter}` : "";
  const digest = (table: string) => `(SELECT encode(sha256(convert_to(COALESCE(string_agg(encode(sha256(convert_to(payload,'UTF8')),'hex'),'' ORDER BY id),''),'UTF8')),'hex') FROM ${table})`;
  const name = context.directoryRead ? "u.name" : "NULL::text";
  // Hash only visible domain facts: unrelated games, ledger events and hidden names cannot disturb a page.
  const row = (await c.query(`WITH visible_earnings AS (
    SELECT e.id,jsonb_build_array(e.id,e.version,e.state,e.amount_cents::text,e.recovery_required_cents::text,e.due_at,e.created_at,
      e.beneficiary_user_id,e.beneficiary_role,o.id,o.display_no,o.game_id,o.renter_user_id,o.owner_user_id,${name})::text payload
    FROM zzsh_order.rental_referral_earning e JOIN zzsh_order.rental_order o ON o.id=e.order_id
    LEFT JOIN zzsh_auth_user."user" u ON u.id=e.beneficiary_user_id WHERE ${nativeScope}${subject("e.beneficiary_user_id")}
  ), visible_events AS (
    SELECT t.id,jsonb_build_array(t.id,t.action,t.created_at,f.id,f.kind,f.created_at)::text payload
    FROM zzsh_order.rental_referral_transition t JOIN visible_earnings e ON e.id=t.earning_id
    JOIN zzsh_order.finance_event f ON f.id=t.finance_event_id AND f.economic_root_id=e.id
  ), visible_legacy AS (
    ${legacyAvailable ? `SELECT p.id,p.user_id,p.source_system,p.source_id,p.source_digest,p.source_canonical,p.snapshot,lo.id order_id,jsonb_build_array(p.id,p.user_id,p.source_system,p.snapshot->>'sourceOrderType',p.snapshot->>'orderId',p.snapshot->>'amount',p.snapshot->>'sourceStatus',p.snapshot->>'level',p.source_event_at,p.imported_at,lo.id,lo.original_order_no,lo.game_id,lo.renter_user_id,lo.owner_user_id,${name})::text payload
      FROM zzsh_order.personal_finance_observation p LEFT JOIN zzsh_order.legacy_order_read_snapshot lo ON lo.legacy_id=p.snapshot->>'orderId' AND lo.source_system=p.source_system AND lo.source_entity='la_order' AND (${legacyRentalDistributionPredicate('p')} )
      LEFT JOIN zzsh_auth_user."user" u ON u.id=p.user_id WHERE p.source_kind='HISTORICAL_DISTRIBUTION' AND ${nativeScope.replaceAll('o.game_id','lo.game_id')}${subject('p.user_id')}` : "SELECT NULL::text id,NULL::text payload WHERE FALSE"}
  ), visible_legacy_logs AS MATERIALIZED (
    ${legacyAvailable ? `SELECT l.source_system,l.user_id,l.snapshot->>'referenceId' source_id,
        encode(sha256(convert_to(string_agg(jsonb_build_array(l.source_digest,l.source_canonical,l.snapshot)::text,',' ORDER BY l.id COLLATE "C")
          FILTER(WHERE l.snapshot->>'legacyChangeType'='1001' AND l.snapshot->>'action'='1'),'UTF8')),'hex') version
      FROM zzsh_order.personal_finance_observation l
      WHERE l.source_kind='HISTORICAL_EARNINGS_LOG' AND l.source_entity='la_log_earnings'
        AND l.snapshot->>'legacyChangeType'='1001' AND l.snapshot->>'action'='1'${subject('l.user_id')}
      GROUP BY l.source_system,l.user_id,l.snapshot->>'referenceId'`
      : "SELECT NULL::text source_system,NULL::text user_id,NULL::text source_id,NULL::text version WHERE FALSE"}
  ), visible_legacy_duties AS (
    ${legacyAvailable && dutiesAvailable ? `SELECT p.id,string_agg(jsonb_build_array(d.id,d.revision,d.status,d.amount_cents::text,d.settled_by,d.maturity_at)::text,',' ORDER BY d.id COLLATE "C") version
      FROM visible_legacy p JOIN zzsh_order.legacy_order_duty d ON d.counterparty_user_id=p.user_id AND d.source_record_id=p.source_id
        AND d.order_id=p.order_id WHERE d.kind='COMMISSION' GROUP BY p.id`
      : "SELECT NULL::text id,NULL::text version WHERE FALSE"}
  ), visible_legacy_effects AS (
    ${legacyAvailable ? `SELECT p.id,jsonb_build_array(p.source_digest,p.source_canonical,p.snapshot,l.version,d.version)::text payload
      FROM visible_legacy p LEFT JOIN visible_legacy_logs l ON l.source_system=p.source_system AND l.user_id=p.user_id AND l.source_id=p.source_id
      LEFT JOIN visible_legacy_duties d ON d.id=p.id`
      : "SELECT NULL::text id,NULL::text payload WHERE FALSE"}
  ), visible_participants AS (
    ${context.scope.network === "AVAILABLE" ? `SELECT p.user_id id,jsonb_build_array(p.user_id,p.revision,p.eligibility,p.commission_frozen,p.level_code,p.policy_version_id,p.inviter_knowledge,p.leader_knowledge,p.invitees_knowledge,p.source_type,p.source_digest,${name})::text payload
      FROM zzsh_order.distribution_participant p LEFT JOIN zzsh_auth_user."user" u ON u.id=p.user_id WHERE TRUE${subject("p.user_id")}` : "SELECT NULL::text id,NULL::text payload WHERE FALSE"}
  ), visible_relations AS (
    ${context.scope.network === "AVAILABLE" ? `SELECT r.id,jsonb_build_array(r.id,r.type,r.parent_user_id,r.child_user_id,r.source_type,r.policy_version_id)::text payload FROM zzsh_order.invitation_relation r${beneficiaryParameter ? ` WHERE r.parent_user_id=${beneficiaryParameter} OR r.child_user_id=${beneficiaryParameter}` : ""}` : "SELECT NULL::text id,NULL::text payload WHERE FALSE"}
  ), visible_coverage AS (
    ${coverageAvailable&&context.scope.network==='AVAILABLE'?`SELECT c.id,jsonb_build_array(c.id,c.user_id,c.source_count,c.imported_count,c.isolated_count,c.imported_set_digest,c.source_cutoff)::text payload FROM zzsh_order.personal_finance_observation_coverage c WHERE c.source_kind='HISTORICAL_DISTRIBUTION'${subject('c.user_id')}`:'SELECT NULL::text id,NULL::text payload WHERE FALSE'}
  ), visible_native_birth AS (
    ${nativeOriginAvailable&&context.scope.network==='AVAILABLE'?`SELECT p.user_id id,EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage c
      JOIN zzsh_order.finance_opening_basis b ON b.id=c.basis_id AND b.user_id=c.user_id
      JOIN zzsh_iam.user_identity_state s ON s.user_id=c.user_id JOIN zzsh_order.native_user_insert_proof n ON n.user_id=c.user_id
      WHERE c.user_id=p.user_id AND c.origin='NATIVE_GENESIS' AND b.source_kind='NATIVE_GENESIS' AND b.available_cents=0 AND b.covered_count=0 AND NULLIF(s.provider,'')<>'legacy_mysql_restore'
        AND NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.object_id=c.user_id AND a.action='user.legacy_owner.migrated' AND a.outcome='SUCCESS')
        AND NOT EXISTS(SELECT 1 FROM zzsh_order.personal_finance_observation h WHERE h.user_id=c.user_id AND h.source_kind='HISTORICAL_DISTRIBUTION'))::text payload
      FROM zzsh_order.distribution_participant p WHERE p.source_type='NATIVE_REGISTRATION'${subject('p.user_id')}`:'SELECT NULL::text id,NULL::text payload WHERE FALSE'}
  ) SELECT ${digest('visible_earnings')} native,${digest('visible_events')} events,${digest('visible_legacy')} legacy,
    ${digest('visible_participants')} participants,${digest('visible_relations')} relations,${digest('visible_legacy_effects')} effects,${digest('visible_coverage')} coverage,${digest('visible_native_birth')} native_birth`, values)).rows[0];
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
    to_regclass('zzsh_order.personal_finance_observation') IS NOT NULL AND to_regclass('zzsh_order.legacy_order_read_snapshot') IS NOT NULL AS legacy,
    to_regclass('zzsh_order.legacy_order_duty') IS NOT NULL AND to_regclass('zzsh_order.legacy_order_duty_admission') IS NOT NULL
      AND to_regclass('zzsh_order.legacy_order_duty_revision') IS NOT NULL AND to_regclass('zzsh_order.legacy_continuation_version') IS NOT NULL AS duties,
    to_regclass('zzsh_order.personal_finance_observation_coverage') IS NOT NULL AS coverage,
    to_regclass('zzsh_order.wallet_coverage') IS NOT NULL AND to_regclass('zzsh_order.finance_opening_basis') IS NOT NULL
      AND to_regclass('zzsh_order.native_user_insert_proof') IS NOT NULL AND to_regclass('zzsh_iam.user_identity_state') IS NOT NULL
      AND to_regclass('zzsh_order.personal_finance_observation') IS NOT NULL AS native_origin`)).rows[0];
  if (row?.native !== true) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Distribution dashboard sources unavailable");
  return { native: true, legacy: row.legacy === true, duties: row.duties === true, coverage:row.coverage===true, nativeOrigin:row.native_origin===true };
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
    FROM zzsh_order.personal_finance_observation o LEFT JOIN zzsh_order.legacy_order_read_snapshot lo ON lo.legacy_id=(o.snapshot->>'orderId') AND lo.source_system=o.source_system AND (${legacyRentalDistributionPredicate('o')} )
    WHERE o.source_kind='HISTORICAL_DISTRIBUTION' AND (${scope}) GROUP BY 1`, values)).rows;
  const map = new Map(rows.map((row: any) => [String(row.status), row]));
  const metric = (status: string) => { const row = map.get(status); return row ? KNOWN(String(row.cents), String(row.count)) : KNOWN("0", "0"); };
  const orders = (await c.query(`SELECT count(DISTINCT (lo.source_system,lo.legacy_id)) FILTER (WHERE lo.id IS NOT NULL)::text AS count FROM zzsh_order.personal_finance_observation o LEFT JOIN zzsh_order.legacy_order_read_snapshot lo ON lo.legacy_id=(o.snapshot->>'orderId') AND lo.source_system=o.source_system AND (${legacyRentalDistributionPredicate('o')} ) WHERE o.source_kind='HISTORICAL_DISTRIBUTION' AND o.snapshot->>'orderId' IS NOT NULL AND (${scope})`, values)).rows[0];
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
    .sort((a,b) => {
      const x=BigInt(String(mode==='count'?a.count:a.cents)),y=BigInt(String(mode==='count'?b.count:b.cents));
      return x===y ? (String(a.user_id??a.userId??'')<String(b.user_id??b.userId??'')?-1:String(a.user_id??a.userId??'')>String(b.user_id??b.userId??'')?1:0) : x>y ? -1 : 1;
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
    FROM zzsh_order.personal_finance_observation o LEFT JOIN zzsh_order.legacy_order_read_snapshot lo ON lo.legacy_id=(o.snapshot->>'orderId') AND lo.source_system=o.source_system AND (${legacyRentalDistributionPredicate('o')} ) LEFT JOIN zzsh_auth_user."user" u ON u.id=o.user_id
    WHERE o.source_kind='HISTORICAL_DISTRIBUTION' AND o.snapshot->>'sourceStatus'='2' AND (${scope})
    GROUP BY o.user_id,u.name ORDER BY sum(round((o.snapshot->>'amount')::numeric*100)) DESC,o.user_id LIMIT ${limit}`, values)).rows;
  return rankingRows(rows.map((row: any) => ({ ...row, name: context.directoryRead ? row.name : null })));
}

async function inviteRanking(c: PoolClient, context: DashboardAccess, limit: number) {
  if (context.scope.network !== "AVAILABLE") return { items: [], knowledge: "UNKNOWN" as const, reasonCodes: ["GLOBAL_RELATION_SCOPE_UNAVAILABLE"] };
  const rows = (await c.query(`SELECT r.parent_user_id AS user_id,u.name,count(DISTINCT r.child_user_id)::int AS count,
    EXISTS(SELECT 1 FROM zzsh_order.distribution_participant p WHERE p.invitees_knowledge<>'KNOWN') AS partial
    FROM zzsh_order.invitation_relation r LEFT JOIN zzsh_auth_user."user" u ON u.id=r.parent_user_id
    WHERE r.type='INVITER' GROUP BY r.parent_user_id,u.name ORDER BY count(DISTINCT r.child_user_id) DESC,r.parent_user_id LIMIT ${limit}`)).rows;
  const partial = rows.length ? rows[0].partial === true : (await c.query(`SELECT EXISTS(SELECT 1 FROM zzsh_order.distribution_participant WHERE invitees_knowledge<>'KNOWN') AS partial`)).rows[0]?.partial === true;
  return { items: rankingRows(rows.map((row: any) => ({ ...row, name: context.directoryRead ? row.name : null })), "count"), knowledge: partial ? "PARTIAL" as const : "KNOWN" as const, reasonCodes: partial ? ["INVITATION_COVERAGE_INCOMPLETE"] : [] as string[] };
}

/** Count people only after matching their registration invitation to an effective earning. */
export function contributorSourceSql(legacy: boolean, duties: boolean, scope: string, beneficiaries: string) {
  return unifiedDistributionSourceSql(legacy, duties, scope, false, undefined, beneficiaries) + `,
    contributor_records AS MATERIALIZED (
      SELECT d.beneficiary_id,d.party_user_id,d.state,d.amount_cents,d.source_valid,d.contributor_confirmed,(r.id IS NOT NULL) invited
      FROM dashboard_records d LEFT JOIN zzsh_order.invitation_relation r ON r.type='INVITER'
        AND r.parent_user_id=d.beneficiary_id AND r.child_user_id=d.party_user_id
    ), contributor_users AS (
      SELECT DISTINCT beneficiary_id,party_user_id AS child_user_id FROM contributor_records
      WHERE source_valid AND contributor_confirmed AND invited AND amount_cents>0 AND state IN('PENDING','MATURED','SETTLED')
    ), contributor_uncertain AS (
      SELECT beneficiary_id FROM contributor_records
      WHERE source_valid IS NOT TRUE OR party_user_id IS NULL OR invited AND (state IN('UNKNOWN','RECOVERY_REQUIRED') OR state IN('PENDING','MATURED','SETTLED') AND contributor_confirmed IS NOT TRUE)
      GROUP BY beneficiary_id
    )`;
}

async function readContributorCounts(c: PoolClient, context: DashboardAccess, sources: {legacy:boolean;duties:boolean}, ids: string[]) {
  if (!ids.length) return new Map<string,{count:number;uncertain:boolean}>();
  const values: unknown[] = [], scope = scopeSql('o', values, context), parameter = `$${values.push(ids)}`;
  const sql = contributorSourceSql(sources.legacy, sources.duties, scope, parameter);
  const rows = (await c.query(sql + ` SELECT u.user_id,count(DISTINCT x.child_user_id)::int AS count,(q.beneficiary_id IS NOT NULL) AS uncertain
    FROM unnest(${parameter}::text[]) u(user_id) LEFT JOIN contributor_users x ON x.beneficiary_id=u.user_id
    LEFT JOIN contributor_uncertain q ON q.beneficiary_id=u.user_id GROUP BY u.user_id,q.beneficiary_id`, values)).rows;
  return new Map<string,{count:number;uncertain:boolean}>(rows.map((row:any)=>[String(row.user_id),{count:Number(row.count),uncertain:row.uncertain===true}]));
}

async function participantCounts(c: PoolClient, context: DashboardAccess) {
  if (context.scope.network !== "AVAILABLE") return { participants: UNKNOWN("GLOBAL_RELATION_SCOPE_UNAVAILABLE"), eligible: UNKNOWN("GLOBAL_RELATION_SCOPE_UNAVAILABLE"), frozen: UNKNOWN("GLOBAL_RELATION_SCOPE_UNAVAILABLE"), inviter: UNKNOWN("GLOBAL_RELATION_SCOPE_UNAVAILABLE"), leader: UNKNOWN("GLOBAL_RELATION_SCOPE_UNAVAILABLE") };
  const row = (await c.query(`SELECT count(*)::int AS participants,count(*) FILTER(WHERE eligibility='ELIGIBLE')::int AS eligible,count(*) FILTER(WHERE commission_frozen)::int AS frozen FROM zzsh_order.distribution_participant`)).rows[0];
  const relations = (await c.query(`SELECT type,count(*)::int AS count FROM zzsh_order.invitation_relation GROUP BY type`)).rows;
  const relation = (type: string) => { const found = relations.find((item: any) => item.type === type); return found ? KNOWN("0", String(found.count)) : KNOWN("0", "0"); };
  return { participants: KNOWN("0", String(row?.participants ?? 0)), eligible: KNOWN("0", String(row?.eligible ?? 0)), frozen: KNOWN("0", String(row?.frozen ?? 0)), inviter: relation("INVITER"), leader: relation("DISTRIBUTION_LEADER") };
}

export async function readAdminDistributionOverview(c: PoolClient, context: DashboardAccess, f: DashboardFilters) {
  const sources = await ready(c), version = await dashboardVersion(c, context, sources.legacy, 'duties' in sources && sources.duties === true), asOf = (await c.query(`SELECT clock_timestamp()::text AS at`)).rows[0]!.at;
  const unified = await readUnifiedDistributionOverview(c, context, f, sources);
  const invites = await inviteRanking(c, context, f.rankingLimit), participants = await participantCounts(c, context);
  return {
    contractVersion: DASHBOARD_VERSION, asOf, timezone: "Asia/Shanghai", snapshotVersion: createHash("sha256").update(version + canonicalize(unified)).digest("hex"), applied: f, scope: context.scope,
    ...unified, participants, rankings: { earnings: unified.earningsRanking, directInvites: invites },
    reasonCodes: [ ...(sources.legacy ? [] : ["LEGACY_SOURCE_NOT_INSTALLED"]), ...(context.scope.network === "AVAILABLE" ? [] : ["GLOBAL_RELATION_SCOPE_UNAVAILABLE"]) ],
  };
}

export async function readUnifiedDistributionOverview(c: PoolClient, context: DashboardAccess, f: DashboardFilters, sources: { legacy: boolean; duties: boolean }) {
  const values: unknown[] = [], scope = scopeSql('o', values, context), source = unifiedDistributionSourceSql(sources.legacy, sources.duties, scope, context.directoryRead);
  values.push(rangeStart(f.from), rangeEnd(f.to));
  const from = `$${values.length - 1}::timestamptz`, to = `$${values.length}::timestamptz`, occurred = `occurred_at>=${from} AND occurred_at<${to}`, credited = `settled_at>=${from} AND settled_at<${to}`;
  const rankingAmount=f.rankingBasis === 'PERIOD_SETTLED_FLOW'?'source_amount_cents':'amount_cents';
  const row = (await c.query(source + `SELECT count(*)::text count,count(*) FILTER(WHERE source='LEGACY')::text legacy_count,COALESCE(sum(amount_cents),0)::text record_amount_cents,
    count(*) FILTER(WHERE state='UNKNOWN')::text unknown_state_count,
    COALESCE(sum(recovery_cents) FILTER(WHERE state='RECOVERY_REQUIRED'),0)::text recovery_cents,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('state',state,'count',n,'amountCents',amount)) FROM
      (SELECT state,count(*)::text n,sum(amount_cents)::text amount FROM dashboard_records GROUP BY state)s),'[]') record_states,
    COALESCE(sum(source_amount_cents) FILTER(WHERE ${occurred}),0)::text accrued_cents,count(*) FILTER(WHERE ${occurred})::text accrued_count,
    COALESCE(sum(source_amount_cents) FILTER(WHERE ${credited}),0)::text settled_cents,count(*) FILTER(WHERE ${credited})::text settled_count,
    count(DISTINCT (source,order_id)) FILTER(WHERE ${occurred} AND order_id IS NOT NULL)::text orders,
    count(*) FILTER(WHERE state='SETTLED' AND settled_at IS NULL)::text unconfirmed_credit_count,
    count(*) FILTER(WHERE occurred_at IS NULL)::text unconfirmed_occurred_count,
    COALESCE((SELECT jsonb_agg(jsonb_build_object('date',date,'cents',cents,'accruedCents',accrued)) FROM
      (SELECT to_char(d.day,'YYYY-MM-DD') date,
        COALESCE((SELECT sum(source_amount_cents) FROM dashboard_records WHERE settled_at>=d.day AT TIME ZONE 'Asia/Shanghai' AND settled_at<(d.day+interval '1 day') AT TIME ZONE 'Asia/Shanghai'),0)::text cents,
        COALESCE((SELECT sum(source_amount_cents) FROM dashboard_records WHERE occurred_at>=d.day AT TIME ZONE 'Asia/Shanghai' AND occurred_at<(d.day+interval '1 day') AT TIME ZONE 'Asia/Shanghai'),0)::text accrued
      FROM generate_series($${values.length - 1}::timestamptz AT TIME ZONE 'Asia/Shanghai',($${values.length}::timestamptz AT TIME ZONE 'Asia/Shanghai')-interval '1 day',interval '1 day')d(day) ORDER BY d.day)t),'[]') trend,
    COALESCE((SELECT jsonb_agg(r) FROM (SELECT beneficiary_id user_id,min(beneficiary_name) name,array_agg(DISTINCT role ORDER BY role) roles,
      sum(${rankingAmount})::text cents,count(*)::text count FROM dashboard_records WHERE ${f.rankingBasis === 'PERIOD_SETTLED_FLOW' ? credited : "state='SETTLED'"}
      GROUP BY beneficiary_id HAVING sum(${rankingAmount})>0 ORDER BY sum(${rankingAmount}) DESC,beneficiary_id COLLATE "C" LIMIT ${f.rankingLimit})r),'[]') ranking,
    COALESCE((SELECT jsonb_agg(to_jsonb(r)||jsonb_build_object('amount_cents',r.amount_cents::text,'recovery_cents',r.recovery_cents::text)) FROM (SELECT * FROM dashboard_records
      ORDER BY occurred_at DESC NULLS LAST,id COLLATE "C" DESC LIMIT 8)r),'[]') recent
    FROM dashboard_records`, values)).rows[0];
  if (!row) throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Commission aggregate unavailable');
  const complete=sources.legacy && row.legacy_count==='0';
  const summary = commissionRecordSummaryProjection(row, complete, null, complete ? [] : [sources.legacy ? 'HISTORICAL_COVERAGE_NOT_CLOSED' : 'LEGACY_SOURCE_NOT_INSTALLED']);
  const metric = (states: string[]) => !sources.legacy ? UNKNOWN('LEGACY_SOURCE_NOT_INSTALLED') : KNOWN(summary.states.filter(s=>states.includes(s.state)).reduce((n,s)=>n+BigInt(s.amountCents),0n).toString(),summary.states.filter(s=>states.includes(s.state)).reduce((n,s)=>n+BigInt(s.count),0n).toString());
  const period = (cents: string, count: string) => sources.legacy ? KNOWN(cents,count) : UNKNOWN('LEGACY_SOURCE_NOT_INSTALLED');
  return { recordSummary: summary,
    current: { settled: metric(['SETTLED']), pending: metric(['PENDING','MATURED']), recovery: sources.legacy ? KNOWN(String(row.recovery_cents),metric(['RECOVERY_REQUIRED']).count) : UNKNOWN('LEGACY_SOURCE_NOT_INSTALLED'), needsReview: metric(['UNKNOWN']) },
    flow: { accrued: period(row.accrued_cents,row.accrued_count), settled: period(row.settled_cents,row.settled_count), orders: period('0',row.orders),
      unconfirmedCreditCount: String(row.unconfirmed_credit_count), unconfirmedOccurredCount: String(row.unconfirmed_occurred_count) },
    trend: row.trend.map((p:any)=>({...p,knowledge:sources.legacy?'KNOWN':'UNKNOWN'})),
    earningsRanking: rankingRows(row.ranking), recent: row.recent.map((r:any)=>mapEarningRow(r,context.directoryRead)) };
}

function listWhere(f: DashboardFilters, values: unknown[], context: DashboardAccess) {
  const clauses: string[] = [];
  values.push(rangeStart(f.from), rangeEnd(f.to));
  clauses.push(`(occurred_at IS NULL OR occurred_at >= $${values.length - 1}::timestamptz AND occurred_at < $${values.length}::timestamptz)`);
  if (f.source !== "ALL") { values.push(f.source); clauses.push(`source=$${values.length}`); }
  if (f.state !== "ALL") { values.push(f.state); clauses.push(`state=$${values.length}`); }
  if (f.role !== "ALL") { values.push(f.role); clauses.push(`role=$${values.length}`); }
  if (f.beneficiary) { values.push(f.beneficiary); clauses.push(`beneficiary_id=$${values.length}::text`); }
  if (f.q) { values.push(`%${escapeLike(f.q.toLowerCase())}%`); clauses.push(`lower(coalesce(beneficiary_id,'')||' '||${context.directoryRead ? "coalesce(beneficiary_name,'')||' '||" : ""}coalesce(order_number,'')) LIKE $${values.length}`); }
  return clauses.length ? clauses.join(" AND ") : "TRUE";
}

export function mapEarningRow(row: any, directoryRead: boolean): DashboardEarning {
  return { id: String(row.id), source: row.source, beneficiaryId: row.beneficiary_id ?? null, beneficiaryName: directoryRead ? row.beneficiary_name ?? null : null,
    role: row.role ?? "UNKNOWN", orderId: row.order_id ?? null, orderNumber: row.order_number ?? null, amountCents: String(row.amount_cents ?? "0"),
    recoveryRequiredCents: row.recovery_cents ?? null, state: row.state ?? "UNKNOWN", occurredAt: row.occurred_at ?? null, settledAt: row.settled_at ?? null,
    dueAt: row.due_at ?? null, recordedAt: row.recorded_at ?? null, gameId: row.game_id ?? null };
}

export async function readAdminDistributionEarnings(c: PoolClient, context: DashboardAccess, f: DashboardFilters, key?: ListingCursorKey, limitOverride?: number, token?: string | null, prepared?: { sources: { native: boolean; legacy: boolean }; version: string; asOf: string; duties?: boolean }) {
  const sources = prepared?.sources ?? await ready(c), version = prepared?.version ?? await dashboardVersion(c, context, sources.legacy, 'duties' in sources && sources.duties === true, false, f.beneficiary), asOf = prepared?.asOf ?? (await c.query(`SELECT clock_timestamp()::text AS at`)).rows[0]!.at;
  if (f.source === "LEGACY" && !sources.legacy) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Legacy distribution source unavailable");
  const values: unknown[] = [], nativeScope = scopeSql("o", values, context);
  const beneficiaryParameter = f.beneficiary ? `$${values.push(f.beneficiary)}` : undefined;
  const source = unifiedDistributionSourceSql(sources.legacy, 'duties' in sources && sources.duties === true, nativeScope, context.directoryRead, beneficiaryParameter);
  const records = source + 'SELECT id,source,beneficiary_id,beneficiary_name,role,order_id,order_number,game_id,amount_cents::text,recovery_cents::text,state,occurred_at,settled_at,due_at,recorded_at FROM dashboard_records';
  const where = listWhere(f, values, context), offset = (f.page - 1) * (limitOverride ?? f.pageSize), limit = limitOverride ?? f.pageSize;
  values.push(limit, offset);
  const rows = (await c.query(`WITH rows AS (${records}) SELECT *,count(*) OVER()::int AS total FROM rows WHERE ${where} ORDER BY occurred_at DESC NULLS LAST,id DESC LIMIT $${values.length - 1} OFFSET $${values.length}`, values)).rows;
  const items: DashboardEarning[] = rows.map((row: any) => mapEarningRow(row, context.directoryRead));
  const total = rows.length ? Number(rows[0].total) : Number((await c.query(`WITH rows AS (${records}) SELECT count(*)::text AS total FROM rows WHERE ${where}`,values.slice(0,-2))).rows[0]?.total);
  if(!Number.isSafeInteger(total)||total<0)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Distribution total unavailable');
  const snapshot = key ? distributionSnapshot(version, asOf, f, context, key, token) : null;
  return { contractVersion: DASHBOARD_VERSION, asOf, snapshotVersion: version, applied: f, scope: context.scope, items, total: String(total), page: f.page, pageSize: limit, hasMore: offset + items.length < total, snapshot: snapshot?.token ?? null };
}

export async function readAdminDistributionParticipants(c: PoolClient, context: DashboardAccess, f: DashboardFilters, key?: ListingCursorKey, token?: string | null, exactUserId?: string) {
  if (context.scope.network !== "AVAILABLE") throw new SecurityApiError(403, "FORBIDDEN", "Global distribution network requires Boss or ALL_GAMES scope");
  // Participant amount CTE scans unified native+legacy stock; keep page reads under a slightly wider budget than overview cards.
  await c.query("SELECT set_config('statement_timeout','8s',true)");
  const sources = await ready(c), version = exactUserId && !key && !token ? null : await dashboardVersion(c, context, sources.legacy, sources.duties, sources.coverage, undefined, sources.nativeOrigin), asOf = (await c.query(`SELECT clock_timestamp()::text AS at`)).rows[0]!.at;
  // Bindings appear in SQL order: game-scope for amount CTE, optional exact user, search, then LIMIT/OFFSET.
  const values: unknown[] = [];
  const amountScope = scopeSql("o", values, context);
  let exactIdx: number | null = null;
  if (exactUserId) { values.push(exactUserId); exactIdx = values.length; }
  const amountFilter = exactIdx ? ` WHERE beneficiary_id=$${exactIdx}::text` : "";
  const where: string[] = [];
  if (exactIdx) where.push(`p.user_id=$${exactIdx}`);
  if (f.q) { values.push(`%${escapeLike(f.q.toLowerCase())}%`); where.push(`lower(coalesce(p.user_id,'')${context.directoryRead ? "||' '||coalesce(u.name,'')" : ""}) LIKE $${values.length}`); }
  const limit = f.pageSize, offset = (f.page - 1) * limit;
  const amountsCte = unifiedDistributionSourceSql(sources.legacy, 'duties' in sources && sources.duties === true, amountScope, context.directoryRead, exactIdx ? `$${exactIdx}` : undefined)
    + `, participant_amounts AS (
    SELECT beneficiary_id,
      count(*)::bigint AS record_count,
      COALESCE(sum(amount_cents) FILTER(WHERE state='SETTLED'),0)::bigint AS settled_cents,
      COALESCE(sum(amount_cents) FILTER(WHERE state IN('PENDING','MATURED')),0)::bigint AS pending_cents,
      COALESCE(sum(recovery_cents) FILTER(WHERE state='RECOVERY_REQUIRED'),0)::bigint AS recovery_cents,
      COALESCE(sum(amount_cents) FILTER(WHERE state='UNKNOWN'),0)::bigint AS review_cents,
      count(*) FILTER(WHERE state='UNKNOWN')::bigint AS review_count
    FROM dashboard_records${amountFilter}
    GROUP BY beneficiary_id)`;
  // Sort metric matches UI mapped 「分销单数 / 已结算 / 待结算」.
  const sortColumn = f.sort === "settledCents" ? "COALESCE(a.settled_cents,0)" : f.sort === "pendingCents" ? "COALESCE(a.pending_cents,0)" : "COALESCE(a.record_count,0)";
  const sortDir = f.order === "asc" ? "ASC" : "DESC";
  values.push(limit, offset);
  const limitIdx = values.length - 1, offsetIdx = values.length;
  const whereSql = where.length ? "WHERE " + where.join(" AND ") : "";
  const rows = (await c.query(`${amountsCte}
    SELECT p.user_id,u.name,p.eligibility,p.commission_frozen,p.level_code,p.inviter_knowledge,p.leader_knowledge,p.invitees_knowledge,p.source_type,p.revision,
    CASE WHEN v.schema_version='distribution-policy.v3' THEN v.canonical_config::jsonb#>>ARRAY['legacySource','levelNames',p.level_code] END level_name,
    COALESCE(ch.leader_children,0)::int AS leader_children,
    COALESCE(ch.inviter_children,0)::int AS inviter_children,
    COALESCE(a.record_count,0)::text AS record_count,
    COALESCE(a.settled_cents,0)::text AS settled_cents,
    COALESCE(a.pending_cents,0)::text AS pending_cents,
    COALESCE(a.recovery_cents,0)::text AS recovery_cents,
    COALESCE(a.review_cents,0)::text AS review_cents,
    COALESCE(a.review_count,0)::text AS review_count,
    count(*) OVER()::int AS total
    FROM zzsh_order.distribution_participant p
    LEFT JOIN zzsh_auth_user."user" u ON u.id=p.user_id
    LEFT JOIN zzsh_order.distribution_policy_version v ON v.id=p.policy_version_id
    LEFT JOIN participant_amounts a ON a.beneficiary_id=p.user_id
    LEFT JOIN (
      SELECT parent_user_id,
        count(DISTINCT child_user_id) FILTER(WHERE type='DISTRIBUTION_LEADER')::int AS leader_children,
        count(DISTINCT child_user_id) FILTER(WHERE type='INVITER')::int AS inviter_children
      FROM zzsh_order.invitation_relation GROUP BY parent_user_id
    ) ch ON ch.parent_user_id=p.user_id
    ${whereSql}
    ORDER BY ${sortColumn} ${sortDir}, p.user_id COLLATE "C" ASC
    LIMIT $${limitIdx} OFFSET $${offsetIdx}`, values)).rows;
  let total = rows.length ? Number(rows[0].total) : NaN;
  if (!rows.length) {
    // Empty-page total skips the heavy amount CTE; rebuild participant-only bindings.
    const countValues: unknown[] = [];
    const countWhere: string[] = [];
    if (exactUserId) { countValues.push(exactUserId); countWhere.push(`p.user_id=$${countValues.length}`); }
    if (f.q) { countValues.push(`%${escapeLike(f.q.toLowerCase())}%`); countWhere.push(`lower(coalesce(p.user_id,'')${context.directoryRead ? "||' '||coalesce(u.name,'')" : ""}) LIKE $${countValues.length}`); }
    total = Number((await c.query(`SELECT count(*)::text AS total FROM zzsh_order.distribution_participant p LEFT JOIN zzsh_auth_user."user" u ON u.id=p.user_id ${countWhere.length ? "WHERE " + countWhere.join(" AND ") : ""}`, countValues)).rows[0]?.total);
  }
  if(!Number.isSafeInteger(total)||total<0)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Distribution total unavailable');
  const userIds=rows.map((r: any)=>String(r.user_id)),qualifications=await readLegacyDistributionQualifications(c,userIds);
  const coverage = sources.coverage ? await readObservationCoverages(c, userIds, 'HISTORICAL_DISTRIBUTION') : new Map<string, ObservationCoverage>();
  const nativeAbsences = await provedNativeHistoryAbsences(c, rows.filter((r:any)=>r.source_type==='NATIVE_REGISTRATION').map((r:any)=>String(r.user_id)), 'HISTORICAL_DISTRIBUTION');
  const contributors = await readContributorCounts(c, context, sources, userIds);
  const snapshot = key && version !== null ? distributionSnapshot(version, asOf, f, context, key, token) : null;
  return { contractVersion: DASHBOARD_VERSION, asOf, snapshotVersion: version, scope: context.scope, items: rows.map((row: any) => {const closed=coverage.get(row.user_id)?.knowledge==='KNOWN';const contributor=contributors.get(row.user_id), contributorComplete=Boolean(contributor)&&row.invitees_knowledge==='KNOWN'&&(Number(row.inviter_children??0)===0||closed||nativeAbsences.has(row.user_id))&&!contributor!.uncertain;const cents=(value:unknown)=>closed||value!==undefined&&value!=='0'?String(value??'0'):null;return({ userId: row.user_id, name: context.directoryRead ? row.name ?? null : null,
    eligibility: row.eligibility, frozen: row.commission_frozen === true, levelCode: row.level_code ?? null, levelName: row.level_name ?? null, inviter: row.inviter_knowledge, leader: row.leader_knowledge,
    sourceType: row.source_type, revision: String(row.revision ?? "0"), leaderChildren:row.invitees_knowledge==='KNOWN'?Number(row.leader_children??0):null,inviterChildren:row.invitees_knowledge==='KNOWN'?Number(row.inviter_children??0):null,
    mappedLeaderChildren:Number(row.leader_children??0),mappedInviterChildren:Number(row.inviter_children??0),
    contributorChildren:contributorComplete?contributor!.count:null,mappedContributorChildren:contributor?.count,
    legacyQualification:qualifications.get(row.user_id)??null,recordCount:closed?String(row.record_count??'0'):null,mappedRecordCount:String(row.record_count??'0'),earningsCoverage:coverage.get(row.user_id)?.knowledge??'UNKNOWN',
    needsReviewCount:sources.legacy?String(row.review_count??'0'):null,needsReviewCents:sources.legacy?String(row.review_cents??'0'):null,
    earningsReasonCodes:closed?[]:[sources.legacy?coverage.get(row.user_id)?.reason??'HISTORICAL_COVERAGE_NOT_CLOSED':'LEGACY_SOURCE_NOT_INSTALLED'],
    settledCents:cents(row.settled_cents),pendingCents:cents(row.pending_cents),recoveryCents:cents(row.recovery_cents) });}), total: String(total), page: f.page, pageSize: limit, hasMore: offset + rows.length < total, snapshot: snapshot?.token ?? null };
}

export async function readAdminDistributionParticipant(c: PoolClient, context: DashboardAccess, userId: string) {
  if (!ID.test(userId)) throw invalid("Invalid distribution participant");
  if (context.scope.network !== "AVAILABLE") throw new SecurityApiError(403, "FORBIDDEN", "Global distribution network requires Boss or ALL_GAMES scope");
  const rows = await readAdminDistributionParticipants(c, context, { from: "2000-01-01", to: "2099-12-31", source: "ALL", state: "ALL", role: "ALL", q: "", page: 1, pageSize: 20, rankingBasis: "CURRENT_SETTLED_STOCK", rankingLimit: 10, sort: "recordCount", order: "desc" }, undefined, null, userId);
  const participant = rows.items.find(item => item.userId === userId);
  if (!participant) throw new SecurityApiError(404, "NOT_FOUND", "Distribution participant not found");
  const relations = (await c.query(`SELECT r.type,r.parent_user_id,u.name,r.source_type,r.policy_version_id FROM zzsh_order.invitation_relation r LEFT JOIN zzsh_auth_user."user" u ON u.id=r.parent_user_id WHERE r.child_user_id=$1 ORDER BY r.type,r.id`,[userId])).rows;
  return { contractVersion: DASHBOARD_VERSION, scope: context.scope, participant, downline: { knowledge: participant.inviterChildren === null ? "PARTIAL" : "KNOWN", leader: participant.mappedLeaderChildren, inviter: participant.mappedInviterChildren, contributors: participant.mappedContributorChildren, contributorKnowledge:participant.contributorChildren===null?'PARTIAL':'KNOWN' }, relations: relations.map((row:any)=>({ type:row.type,parentUserId:row.parent_user_id??null,parentName:context.directoryRead?row.name??null:null,sourceType:row.source_type??null,policyVersion:row.policy_version_id??null })) };
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

export type DownlineType = "INVITER" | "DISTRIBUTION_LEADER" | "COMMISSION_CONTRIBUTOR";
/** Direct children of one participant from invitation_relation; offset pages, bounded size. */
export async function readAdminDistributionDownline(c: PoolClient, context: DashboardAccess, userId: string, query: URLSearchParams) {
  if (!ID.test(userId)) throw invalid("Invalid distribution participant");
  if (context.scope.network !== "AVAILABLE") throw new SecurityApiError(403, "FORBIDDEN", "Global distribution network requires Boss or ALL_GAMES scope");
  const type = (query.get("type") ?? "DISTRIBUTION_LEADER") as DownlineType, page = query.get("page") ?? "1", pageSize = query.get("pageSize") ?? "20";
  if (!["INVITER", "DISTRIBUTION_LEADER", "COMMISSION_CONTRIBUTOR"].includes(type) || !/^[1-9]\d{0,5}$/.test(page) || !/^([1-9]|[1-9]\d|100)$/.test(pageSize)) throw invalid("Invalid distribution downline query");
  const owner = (await c.query(`SELECT invitees_knowledge,source_type FROM zzsh_order.distribution_participant WHERE user_id=$1`, [userId])).rows[0];
  if (!owner) throw new SecurityApiError(404, "NOT_FOUND", "Distribution participant not found");
  const limit = Number(pageSize), offset = (Number(page) - 1) * limit;
  if(type==='COMMISSION_CONTRIBUTOR'){
    const sources=await ready(c),values:unknown[]=[],scope=scopeSql('o',values,context),parameter=`$${values.push([userId])}`;
    const source=contributorSourceSql(sources.legacy,sources.duties,scope,parameter),limitParameter=`$${values.push(limit)}`,offsetParameter=`$${values.push(offset)}`;
    const found=(await c.query(source+`, contributor_page AS (
      SELECT r.child_user_id,u.name,r.source_type,r.bound_at,p.eligibility,p.commission_frozen,p.level_code,p.invitees_knowledge,
        CASE WHEN v.schema_version='distribution-policy.v3' THEN v.canonical_config::jsonb#>>ARRAY['legacySource','levelNames',p.level_code] END level_name,
        (SELECT count(DISTINCT g.child_user_id)::int FROM zzsh_order.invitation_relation g WHERE g.parent_user_id=r.child_user_id AND g.type='INVITER') AS children,r.id
      FROM contributor_users x JOIN zzsh_order.invitation_relation r ON r.type='INVITER' AND r.parent_user_id=x.beneficiary_id AND r.child_user_id=x.child_user_id
      LEFT JOIN zzsh_auth_user."user" u ON u.id=r.child_user_id LEFT JOIN zzsh_order.distribution_participant p ON p.user_id=r.child_user_id
      LEFT JOIN zzsh_order.distribution_policy_version v ON v.id=p.policy_version_id
      ORDER BY r.bound_at DESC,r.id COLLATE "C" DESC LIMIT ${limitParameter} OFFSET ${offsetParameter}
    ) SELECT page.*,s.total,s.uncertain FROM (SELECT (SELECT count(*)::int FROM contributor_users) total,
      EXISTS(SELECT 1 FROM contributor_uncertain) uncertain) s LEFT JOIN contributor_page page ON true
      ORDER BY page.bound_at DESC NULLS LAST,page.id COLLATE "C" DESC`,values)).rows;
    const total=Number(found[0]?.total??0),uncertain=found[0]?.uncertain===true;
    const coverage=sources.coverage?await readObservationCoverages(c,[userId],'HISTORICAL_DISTRIBUTION'):new Map<string,ObservationCoverage>();
    const native=owner.source_type==='NATIVE_REGISTRATION'?await provedNativeHistoryAbsences(c,[userId],'HISTORICAL_DISTRIBUTION'):new Set<string>();
    const inviterCount=Number((await c.query(`SELECT count(DISTINCT child_user_id)::int AS count FROM zzsh_order.invitation_relation WHERE parent_user_id=$1 AND type='INVITER'`,[userId])).rows[0]?.count??0);
    const complete=owner.invitees_knowledge==='KNOWN'&&(inviterCount===0||coverage.get(userId)?.knowledge==='KNOWN'||native.has(userId))&&!uncertain;
    return {contractVersion:DASHBOARD_VERSION,subjectId:userId,type,knowledge:complete?'KNOWN' as const:'PARTIAL' as const,total:String(total),page:Number(page),pageSize:limit,
      items:found.filter((row:any)=>row.child_user_id!=null).map((row:any)=>({userId:row.child_user_id,name:context.directoryRead?row.name??null:null,sourceType:row.source_type??null,boundAt:row.source_type==='LEGACY_MYSQL'?null:row.bound_at?new Date(row.bound_at).toISOString():null,
        participant:row.eligibility?{eligibility:row.eligibility,frozen:row.commission_frozen===true,levelCode:row.level_code??null,levelName:row.level_name??null}:null,children:row.invitees_knowledge==='KNOWN'?Number(row.children??0):null,mappedChildren:Number(row.children??0)}))};
  }
  const rows = (await c.query(`SELECT r.child_user_id,u.name,r.source_type,r.bound_at,p.eligibility,p.commission_frozen,p.level_code,p.invitees_knowledge,
      CASE WHEN v.schema_version='distribution-policy.v3' THEN v.canonical_config::jsonb#>>ARRAY['legacySource','levelNames',p.level_code] END level_name,
      (SELECT count(*)::int FROM zzsh_order.invitation_relation g WHERE g.parent_user_id=r.child_user_id AND g.type=r.type) AS children,
      count(*) OVER()::int AS total
    FROM zzsh_order.invitation_relation r
    LEFT JOIN zzsh_auth_user."user" u ON u.id=r.child_user_id
    LEFT JOIN zzsh_order.distribution_participant p ON p.user_id=r.child_user_id
    LEFT JOIN zzsh_order.distribution_policy_version v ON v.id=p.policy_version_id
    WHERE r.parent_user_id=$1 AND r.type=$2
    ORDER BY r.bound_at DESC, r.id COLLATE "C" DESC LIMIT $3 OFFSET $4`, [userId, type, limit, offset])).rows;
  const total = rows.length ? Number(rows[0].total) : Number((await c.query(`SELECT count(*)::int AS total FROM zzsh_order.invitation_relation WHERE parent_user_id=$1 AND type=$2`, [userId, type])).rows[0]?.total ?? 0);
  return { contractVersion: DASHBOARD_VERSION, subjectId: userId, type, knowledge: owner.invitees_knowledge === "KNOWN" ? "KNOWN" : "PARTIAL", total: String(total), page: Number(page), pageSize: limit,
    items: rows.map((row: any) => ({ userId: row.child_user_id, name: context.directoryRead ? row.name ?? null : null, sourceType: row.source_type ?? null, boundAt: row.source_type === 'LEGACY_MYSQL' ? null : row.bound_at ? new Date(row.bound_at).toISOString() : null,
      participant: row.eligibility ? { eligibility: row.eligibility, frozen: row.commission_frozen === true, levelCode: row.level_code ?? null, levelName: row.level_name ?? null } : null, children: row.invitees_knowledge === 'KNOWN' ? Number(row.children ?? 0) : null, mappedChildren: Number(row.children ?? 0) })) };
}
