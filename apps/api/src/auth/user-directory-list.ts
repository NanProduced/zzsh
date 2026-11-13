import type { PoolClient } from "pg";

import { gameScopeSql } from "./admin-scope";
import { conflict, forbidden, invalid, sha256Hex } from "../supply/supply-util";
import { escapeLike } from "../supply/catalog";
import { effectivePublicationStateSql } from "../supply/listing-query";
import { orderReadRelation } from "../order/admin-order-read";
import { legacyContinuationReady } from "../order/legacy-order-read";
import { readUserDirectoryBusinessSummaries, directoryCreditScopeSql, directoryCreditNotInitializedSql } from "./user-directory-business-summary";
import { readUserDirectoryWalletSummaries, DIRECTORY_WALLET_PERMISSION, DIRECTORY_WALLET_SORT_JOINS, DIRECTORY_WALLET_SORT_KEY } from "./user-directory-wallet";
import { readKnownMembershipTiers, type DirectoryMembershipTierFilter } from "./user-directory-membership";
import { maskPhoneNumber } from "./user-directory-summary";
import { managedProfileImagePath } from "../profile/profile-avatar";

export const USER_DIRECTORY_SOURCE = {
  LOCAL: "LOCAL",
  MIGRATED: "MIGRATED",
  UNKNOWN: "UNKNOWN",
} as const;
export type UserDirectorySource = (typeof USER_DIRECTORY_SOURCE)[keyof typeof USER_DIRECTORY_SOURCE];

export const USER_DIRECTORY_STATUS_FILTER = ["ACTIVE", "RESTRICTED", "FROZEN", "CANCELLED", "UNKNOWN"] as const;
export type UserDirectoryStatusFilter = (typeof USER_DIRECTORY_STATUS_FILTER)[number];
export const USER_DIRECTORY_MAX_PAGE = 1_000_000;

/** 目录支持的排序。筛选与排序都先在授权集合上执行，再分页。 */
export const USER_DIRECTORY_SORTS = [
  "active_orders_desc",
  "registered_desc", "registered_asc",
  "balance_desc", "balance_asc",
  "credit_desc", "credit_asc",
  "renter_current_desc", "renter_current_asc",
  "owner_current_desc", "owner_current_asc",
  "published_desc", "published_asc",
] as const;
export type UserDirectorySort = (typeof USER_DIRECTORY_SORTS)[number];
export const USER_DIRECTORY_CREDIT_STATES = ["KNOWN", "NOT_INITIALIZED"] as const;
export type UserDirectoryCreditState = (typeof USER_DIRECTORY_CREDIT_STATES)[number];
export const USER_DIRECTORY_ENTITLEMENTS = ["FRIEND", "PRESTIGE", "ANY", "NONE"] as const;
export type UserDirectoryEntitlementFilter = (typeof USER_DIRECTORY_ENTITLEMENTS)[number];
export const USER_DIRECTORY_RISK_STATES = ["FLAGGED", "NOT_FLAGGED"] as const;
export type UserDirectoryRiskState = (typeof USER_DIRECTORY_RISK_STATES)[number];

export const TIMESTAMP_TEXT = `AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
export const LEGACY_MIGRATION_ACTION = "user.legacy_owner.migrated";
export const LEGACY_PROVIDER = "legacy_mysql_restore";

/** Synthetic addresses produced by phone registration / migration / anonymization are not contact facts. */
const SYNTHETIC_EMAIL = /@(phone\.zzsh\.invalid|anonymized\.invalid)$/i;

export function maskEmail(email: string | null): string | null {
  if (!email) return null;
  const trimmed = email.trim();
  if (!trimmed || SYNTHETIC_EMAIL.test(trimmed)) return null;
  const at = trimmed.indexOf("@");
  if (at <= 0) return "****";
  const local = trimmed.slice(0, at);
  const domain = trimmed.slice(at + 1);
  const head = local.slice(0, Math.min(2, local.length));
  return `${head}***@${domain}`;
}

const CURSOR_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const CURSOR_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

type KeysetCursor = { createdAt: string | null; id: string };

export function parseKeysetCursor(cursor: string | undefined, filterKey: string, allowUnknownTime = false): KeysetCursor | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()) as { f?: unknown; c?: unknown; i?: unknown };
    if (
      parsed.f !== filterKey ||
      (!(allowUnknownTime && parsed.c === null) && (typeof parsed.c !== "string" || !CURSOR_TIME_PATTERN.test(parsed.c))) ||
      typeof parsed.i !== "string" ||
      !CURSOR_ID_PATTERN.test(parsed.i)
    ) {
      throw new Error("mismatch");
    }
    return { createdAt: parsed.c as string | null, id: parsed.i };
  } catch {
    throw conflict("Cursor is invalid");
  }
}

export function encodeKeysetCursor(filterKey: string, row: { sortAt: string | null; id: string }): string {
  return Buffer.from(JSON.stringify({ f: filterKey, c: row.sortAt, i: row.id })).toString("base64url");
}

export type AdminDirectoryViewer = {
  adminId: string;
  isBoss: boolean;
  permissions?: ReadonlySet<string>;
  phoneLookup: boolean;
  resourceRead?: boolean;
  orderRead?: boolean;
  auditRead?: boolean;
  membershipSummaryRead?: boolean;
  creditRead?: boolean;
  /** 目录可见余额：user.wallet.read，或既有 finance.read / Boss 的广读语义。 */
  walletRead?: boolean;
  businessScopeUsable?: boolean;
  authorizationKey?: string;
  legacyRead?: boolean;
  legacyMarketAccountIds?: readonly string[];
};

export type UserDirectoryFilter = {
  userId?: string;
  legacyId?: string;
  identifier?: string;
  search?: string;
  phone?: string;
  accountStatus?: UserDirectoryStatusFilter;
  source?: UserDirectorySource;
  identityStatus?: string;
  identityVerified?: boolean;
  ageStatus?: string;
  membershipTier?: DirectoryMembershipTierFilter;
  entitlement?: UserDirectoryEntitlementFilter;
  creditState?: UserDirectoryCreditState;
  creditMin?: number;
  creditMax?: number;
  riskState?: UserDirectoryRiskState;
  registeredFrom?: string;
  registeredTo?: string;
  registeredBefore?: string;
  registrationTime?: "ORIGINAL";
  sort?: UserDirectorySort;
  limit: number;
  cursor?: string;
  page?: number;
  contextKey?: string;
};

type UserListRow = {
  id: string;
  name: string;
  image: string | null;
  username: string | null;
  displayUsername: string | null;
  phoneNumber: string | null;
  suspended: boolean;
  localCreatedAt: string;
  originalRegisteredAt?: string | null;
  accountStatus: string | null;
  identityStatus: string | null;
  provider: string | null;
  providerReference: string | null;
  migrationLegacyId: string | null;
  resourceAccountCount: number;
  resourcePublishedCount: number;
  currentOrderCount: number;
  renterCurrentOrderCount: number;
  ownerCurrentOrderCount: number;
  ageStatus: string | null;
  localUpdatedAt: string;
  riskFlag: boolean;
};

export function legacyIdFromReference(provider: string | null, reference: string | null): string | null {
  if (provider !== LEGACY_PROVIDER || !reference) return null;
  const separator = reference.indexOf(":");
  if (separator <= 0 || separator === reference.length - 1) return null;
  return reference.slice(separator + 1);
}

export function sourceKindOf(migrationLegacyId: string | null, provider: string | null, identityPresent: boolean): UserDirectorySource {
  if (provider === LEGACY_PROVIDER) return USER_DIRECTORY_SOURCE.MIGRATED;
  // provider also records the real-name provider after verification; only the explicit legacy
  // marker plus a migration fact identify an old-platform user.
  if (identityPresent && provider !== null && provider !== "" && migrationLegacyId === null) return USER_DIRECTORY_SOURCE.LOCAL;
  return USER_DIRECTORY_SOURCE.UNKNOWN;
}

export function projectUserAccountStatus(status: string | null, suspended: boolean): UserDirectoryStatusFilter {
  if (status === null) return "UNKNOWN";
  if (status === "CANCELLED" || status === "FROZEN") return status;
  if (suspended) return "RESTRICTED";
  return status === "ACTIVE" ? "ACTIVE" : "UNKNOWN";
}

const ACCOUNT_STATUS_SQL = `CASE WHEN s.user_id IS NULL THEN 'UNKNOWN'
  WHEN s.account_status='CANCELLED' THEN 'CANCELLED'
  WHEN s.account_status='FROZEN' THEN 'FROZEN'
  WHEN u.suspended THEN 'RESTRICTED'
  WHEN s.account_status='ACTIVE' THEN 'ACTIVE' ELSE 'UNKNOWN' END`;

/** 内部高危标识：固定布尔事实，随目录一起读出；没有记录即未标记。 */
export const RISK_FLAG_JOIN = "LEFT JOIN zzsh_iam.user_risk_flag risk_flag ON risk_flag.user_id = u.id";
/**
 * Three-state source classification. `mig.legacy_id` is the *latest* migration audit's legacy id and is
 * nullable, so `IS NULL` distinguishes "no legacy id on the newest migration fact" from "has one". This
 * predicate therefore always reads the latest-fact relation and is never re-expressed as an existence test:
 * an existence test over all audit rows would treat any historical row as the newest one.
 */
const SOURCE_SQL = `CASE WHEN s.provider='${LEGACY_PROVIDER}' THEN 'MIGRATED'
  WHEN s.user_id IS NOT NULL AND NULLIF(s.provider,'') IS NOT NULL AND mig.legacy_id IS NULL THEN 'LOCAL' ELSE 'UNKNOWN' END`;

// Validate the newest fact after selection; invalid or empty facts must never revive an older date.
export function originalRegistrationSql(migration = "mig", projected = false): string {
  if (projected) return `CASE WHEN s.user_id IS NOT NULL AND NULLIF(s.provider,'')<>'${LEGACY_PROVIDER}' AND ${migration}.object_id IS NULL THEN u."createdAt"
    WHEN s.provider='${LEGACY_PROVIDER}' AND s.provider_reference='la_user:' || ${migration}.legacy_id THEN ${migration}.registered_at ELSE NULL END`;
  return `CASE WHEN s.user_id IS NOT NULL AND NULLIF(s.provider,'')<>'${LEGACY_PROVIDER}' AND ${migration}.object_id IS NULL THEN u."createdAt"
    WHEN s.provider='${LEGACY_PROVIDER}' AND ${migration}.source_system='${LEGACY_PROVIDER}'
      AND ${migration}.source_entity='la_user' AND NULLIF(${migration}.legacy_id,'') IS NOT NULL
      AND s.provider_reference='la_user:' || ${migration}.legacy_id
      AND ${migration}.source_digest ~ '^[0-9a-f]{64}$' AND NULLIF(${migration}.evidence_ref,'') IS NOT NULL
      AND ${migration}.source_created_at ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,6})?Z$'
      AND pg_input_is_valid(${migration}.source_created_at,'timestamp with time zone')
    THEN ${migration}.source_created_at::timestamptz ELSE NULL END`;
}

export function publishedAccountSql(account: string, legacyIds?: string): string {
  const native = `EXISTS (
    SELECT 1 FROM zzsh_supply.listing_version pv
    JOIN zzsh_supply.listing_publication pp ON pp.version_id=pv.id AND pp.account_id=pv.account_id
      AND pp.owner_user_id=${account}.owner_user_id AND pp.game_id=${account}.game_id
      AND pp.rule_release_id=pv.rule_release_id AND pp.content_hash=pv.content_hash
    WHERE pv.id=${account}.current_version_id AND pv.account_id=${account}.id
      AND ${effectivePublicationStateSql("pv", "pp")})`;
  return `${account}.lifecycle='ACTIVE' AND NOT EXISTS (SELECT 1 FROM zzsh_supply.game retired_game
    JOIN zzsh_supply.legacy_supply_map retired_map ON retired_map.account_id=${account}.id
    WHERE retired_game.id=${account}.game_id AND retired_game.code='delta'
      AND retired_map.source_system='legacy_mysql_restore' AND retired_map.source_entity='la_rental_accounts')
    AND ${legacyIds ? `(${native} OR ${account}.id=ANY(${legacyIds}::text[]))` : native}`;
}

export function resourceCountsSql(read: string, boss: string, admin: string, legacyIds?: string): string {
  return `LEFT JOIN LATERAL (
    SELECT count(*)::int AS account_count,
      count(*) FILTER (WHERE ${publishedAccountSql("ra", legacyIds)})::int AS published_count
    FROM zzsh_supply.rental_account ra
    WHERE ${read}::boolean AND ra.owner_user_id=u.id AND ${gameScopeSql("ra.game_id", admin, boss)}
  ) resource_counts ON true`;
}

export function projectRelationshipSummaries(
  row: Pick<UserListRow, "resourceAccountCount" | "resourcePublishedCount" | "currentOrderCount" | "renterCurrentOrderCount" | "ownerCurrentOrderCount">,
  viewer: AdminDirectoryViewer,
) {
  const noScope = viewer.businessScopeUsable === false;
  return {
    resourceSummary: viewer.resourceRead && !noScope
      ? { state: "ready", count: row.resourceAccountCount, publishedCount: row.resourcePublishedCount }
      : { state: "denied", permission: "supply.rental_account.read", ...(viewer.resourceRead && noScope ? { reason: "NO_GAME_SCOPE" } : {}) },
    orderSummary: viewer.orderRead && !noScope
      ? { state: "ready", currentCount: row.currentOrderCount, renterCurrentCount: row.renterCurrentOrderCount, ownerCurrentCount: row.ownerCurrentOrderCount }
      : { state: "denied", permission: "order.read", ...(viewer.orderRead && noScope ? { reason: "NO_GAME_SCOPE" } : {}) },
  };
}

function projectListItem(row: UserListRow, viewer: AdminDirectoryViewer, original = false) {
  const legacyId = row.migrationLegacyId ?? legacyIdFromReference(row.provider, row.providerReference);
  const source = sourceKindOf(row.migrationLegacyId, row.provider, row.accountStatus !== null);
  const registeredAt = original ? row.originalRegisteredAt ?? null : row.localCreatedAt;
  return {
    userId: row.id,
    name: row.name,
    image: managedProfileImagePath(row.image),
    username: row.username,
    displayUsername: row.displayUsername,
    maskedPhone: maskPhoneNumber(row.phoneNumber),
    accountStatus: projectUserAccountStatus(row.accountStatus, row.suspended),
    suspended: row.suspended,
    identityStatus: row.identityStatus ?? "UNKNOWN",
    ageStatus: row.ageStatus ?? "UNKNOWN",
    source: {
      kind: source,
      ...(legacyId ? { legacyId } : {}),
    },
    registeredAt,
    registeredAtSource: original ? registeredAt === null ? "UNKNOWN" : row.provider === LEGACY_PROVIDER ? "LEGACY" : "LOCAL" : "LOCAL",
    createdAt: row.localCreatedAt,
    updatedAt: row.localUpdatedAt,
    localCreatedAt: row.localCreatedAt,
    riskFlag: row.riskFlag === true,
    ...projectRelationshipSummaries(row, viewer),
    lastBusinessActivity: { state: "not_connected", domains: ["ORDER", "SUPPLY"] },
  };
}

// Audit-dependent membership is decided before pagination; other reads batch audits for the page.
// MIGRATED is SOURCE_SQL's first branch and depends only on identity state, so it needs no audit here.
function filterConsultsMigrationAudit(filter: UserDirectoryFilter): boolean {
  return Boolean(filter.legacyId || filter.search
    || (filter.source !== undefined && filter.source !== USER_DIRECTORY_SOURCE.MIGRATED)
    || filter.registrationTime === "ORIGINAL");
}

function directoryFilterPlan(viewer: AdminDirectoryViewer, filter: UserDirectoryFilter) {
  const original = filter.registrationTime === "ORIGINAL";
  if (filter.registrationTime !== undefined && !original) throw invalid("Registration time mode or sort is invalid");
  if (filter.sort !== undefined && (!original || !USER_DIRECTORY_SORTS.includes(filter.sort))) throw invalid("Registration sort is invalid");
  if (filter.registeredBefore !== undefined && (!original || filter.registeredTo !== undefined)) throw invalid("Registered before requires original time and no inclusive upper bound");
  const sort: UserDirectorySort = filter.sort ?? "registered_desc";
  const registeredSort = sort === "registered_desc" || sort === "registered_asc";
  const materializeDates = original && (registeredSort || Boolean(filter.registeredFrom || filter.registeredTo || filter.registeredBefore));
  if (!registeredSort && filter.cursor !== undefined) throw invalid("Cursor is only supported for the registration sort");
  const direction = sort.endsWith("_asc") ? "ASC" : "DESC";
  const timeColumn = original ? "registration.registered_at" : 'u."createdAt"';
  const order = original ? `${timeColumn} ${direction} NULLS LAST, u.id COLLATE "C" DESC` : 'u."createdAt" DESC, u.id DESC';
  // 等级、礼遇、信用与余额的筛选／排序必须先有对应的字段读权限，否则服务端直接拒绝。
  if (filter.membershipTier !== undefined && viewer.membershipSummaryRead !== true) throw forbidden("Membership tier filter requires membership.growth.read.summary");
  if (filter.entitlement !== undefined && viewer.membershipSummaryRead !== true) throw forbidden("Entitlement filter requires membership.growth.read.summary");
  if (filter.creditState !== undefined && viewer.creditRead !== true) throw forbidden("Credit filter requires credit.read");
  if (filter.creditMin !== undefined || filter.creditMax !== undefined) {
    if (viewer.creditRead !== true) throw forbidden("Credit filter requires credit.read");
    if ([filter.creditMin, filter.creditMax].some(value => value !== undefined && (!Number.isInteger(value) || value < 0 || value > 100))
      || filter.creditMin !== undefined && filter.creditMax !== undefined && filter.creditMin > filter.creditMax) throw invalid("Credit range is invalid");
  }
  if ((sort === "active_orders_desc" || sort.startsWith("renter_current_") || sort.startsWith("owner_current_")) && viewer.orderRead !== true) throw forbidden("Order sort requires order.read");
  if (sort.startsWith("published_") && viewer.resourceRead !== true) throw forbidden("Published sort requires supply.rental_account.read");
  if (sort.startsWith("balance_") && viewer.walletRead !== true) throw forbidden("Balance sort requires user.wallet.read");
  if (sort.startsWith("credit_") && viewer.creditRead !== true) throw forbidden("Credit sort requires credit.read");
  return { original, sort, registeredSort, materializeDates, direction, timeColumn, order };
}

async function directoryPredicatePlan(client: PoolClient, viewer: AdminDirectoryViewer, filter: UserDirectoryFilter, asOfUtc: string) {
  const timeColumn = filter.registrationTime === "ORIGINAL" ? "registration.registered_at" : 'u."createdAt"';
  const resourceRead = viewer.resourceRead === true && viewer.businessScopeUsable !== false;
  const orderRead = viewer.orderRead === true && viewer.businessScopeUsable !== false;
  const values: unknown[] = [viewer.isBoss, viewer.adminId, resourceRead, orderRead];
  const conditions: string[] = [];
  if (filter.userId) conditions.push(`u.id = $${values.push(filter.userId)}`);
  if (filter.legacyId) {
    const parameter = `$${values.push(filter.legacyId)}::text`;
    conditions.push(`(mig.legacy_id = ${parameter} OR (s.provider = '${LEGACY_PROVIDER}' AND substring(s.provider_reference from position(':' in s.provider_reference) + 1) = ${parameter}))`);
  }
  if (filter.identifier) {
    const parameter = values.push(`%${escapeLike(filter.identifier)}%`);
    conditions.push(`(u.name ILIKE $${parameter} ESCAPE '\\' OR u.username ILIKE $${parameter} ESCAPE '\\' OR u."displayUsername" ILIKE $${parameter} ESCAPE '\\')`);
  }
  if (filter.search) {
    const exact = values.push(filter.search);
    const like = values.push(`%${escapeLike(filter.search)}%`);
    conditions.push(`(u.id=$${exact} OR mig.legacy_id=$${exact}::text OR (s.provider='${LEGACY_PROVIDER}' AND substring(s.provider_reference from position(':' in s.provider_reference)+1)=$${exact}::text) OR u.name ILIKE $${like} ESCAPE '\\' OR u.username ILIKE $${like} ESCAPE '\\' OR u."displayUsername" ILIKE $${like} ESCAPE '\\')`);
  }
  if (filter.phone) conditions.push(`u."phoneNumber" = $${values.push(filter.phone)}`);
  if (filter.accountStatus) conditions.push(`(${ACCOUNT_STATUS_SQL})=$${values.push(filter.accountStatus)}`);
  if (filter.source === USER_DIRECTORY_SOURCE.MIGRATED) conditions.push(`s.provider='${LEGACY_PROVIDER}'`);
  else if (filter.source) conditions.push(`(${SOURCE_SQL})=$${values.push(filter.source)}`);
  if (filter.identityStatus) conditions.push(`COALESCE(s.identity_status,'UNKNOWN')=$${values.push(filter.identityStatus)}`);
  if (filter.identityVerified !== undefined) conditions.push(`(COALESCE(s.identity_status,'UNKNOWN')='VERIFIED')=$${values.push(filter.identityVerified)}`);
  if (filter.ageStatus) conditions.push(`COALESCE(s.age_status,'UNKNOWN')=$${values.push(filter.ageStatus)}`);
  if (filter.riskState) conditions.push(`COALESCE((SELECT r.flagged FROM zzsh_iam.user_risk_flag r WHERE r.user_id = u.id), false)=$${values.push(filter.riskState === "FLAGGED")}`);
  if (filter.creditState || filter.creditMin !== undefined || filter.creditMax !== undefined) {
    if (!viewer.isBoss && viewer.businessScopeUsable === false) conditions.push("FALSE");
    else {
      const bossParam = `$${values.push(viewer.isBoss)}`;
      const adminParam = `$${values.push(viewer.adminId)}`;
      conditions.push(directoryCreditScopeSql("u.id",adminParam,bossParam));
    }
  }
  if (filter.creditState === "NOT_INITIALIZED") conditions.push(directoryCreditNotInitializedSql("u.id"));
  if (filter.creditState === "KNOWN" || filter.creditMin !== undefined || filter.creditMax !== undefined) {
    const scoreBounds = ["c.revision IS NOT NULL"];
    if (filter.creditMin !== undefined) scoreBounds.push(`c.score >= $${values.push(filter.creditMin)}`);
    if (filter.creditMax !== undefined) scoreBounds.push(`c.score <= $${values.push(filter.creditMax)}`);
    conditions.push(`EXISTS (SELECT 1 FROM zzsh_credit.user_credit_state c WHERE c.user_id=u.id AND ${scoreBounds.join(" AND ")})`);
  }
  if (filter.entitlement) {
    const asOfParameter = `$${values.push(asOfUtc)}`;
    const effective = `(e.status IN ('ACTIVE','EXECUTED_PENDING_START') AND e.ends_at > ${asOfParameter}::timestamptz AND (e.status = 'ACTIVE' OR e.starts_at <= ${asOfParameter}::timestamptz))`;
    if (filter.entitlement === "NONE") {
      conditions.push(`NOT EXISTS (SELECT 1 FROM zzsh_iam.membership_entitlement e WHERE e.user_id = u.id AND ${effective})`);
    } else if (filter.entitlement === "ANY") {
      conditions.push(`EXISTS (SELECT 1 FROM zzsh_iam.membership_entitlement e WHERE e.user_id = u.id AND ${effective})`);
    } else {
      const kind = `$${values.push(filter.entitlement)}`;
      conditions.push(`EXISTS (SELECT 1 FROM zzsh_iam.membership_entitlement e WHERE e.user_id = u.id AND e.kind = ${kind} AND ${effective})`);
    }
  }
  if (filter.membershipTier) {
    const known = await readKnownMembershipTiers(client, asOfUtc, filter.userId);
    if (filter.membershipTier === "PENDING") {
      // 待核 = 投影没有给出可显示等级的用户；已确知等级的用户全部排除，不把缺字段当待核之外的任何事实。
      const graded = [...known.known.entries()].filter(([, tier]) => tier !== "UNKNOWN").map(([id]) => id);
      conditions.push(`u.id <> ALL($${values.push(graded)}::text[])`);
    } else {
      const graded = [...known.known.entries()].filter(([, tier]) => tier === filter.membershipTier).map(([id]) => id);
      conditions.push(`u.id = ANY($${values.push(graded)}::text[])`);
    }
  }
  // Join identity state only when a membership predicate reads it; the page projection joins it after the bound page.
  const needsIdentity = conditions.some(condition => /\bs\./.test(condition));
  const membershipConditions = [...conditions];
  if (filter.registeredFrom) {
    conditions.push(`${timeColumn} >= $${values.push(filter.registeredFrom)}::timestamptz`);
  }
  if (filter.registeredTo) {
    conditions.push(`${timeColumn} <= $${values.push(filter.registeredTo)}::timestamptz`);
  }
  if (filter.registeredBefore) conditions.push(`${timeColumn} < $${values.push(filter.registeredBefore)}::timestamptz`);
  const dateConditions = conditions.slice(membershipConditions.length);
  return { resourceRead, orderRead, values, conditions, needsIdentity, membershipConditions, dateConditions };
}

function directoryMigrationRelation(original: boolean, pageOnly: boolean): string {
  return original ? `SELECT fact.user_id AS object_id,fact.legacy_id,fact.registered_at
      FROM zzsh_iam.user_registration_fact fact ${pageOnly ? "JOIN page candidate ON candidate.id=fact.user_id" : ""}` : `SELECT DISTINCT ON (e.object_id) e.object_id,e.details->>'legacyId' AS legacy_id
      FROM zzsh_iam.audit_event e
      ${pageOnly ? "JOIN page candidate ON candidate.id = e.object_id" : ""}
     WHERE e.action = '${LEGACY_MIGRATION_ACTION}' AND e.object_type = 'user'
     ORDER BY e.object_id, e.occurred_at DESC, e.id DESC`;
}

export async function listUserDirectory(
  client: PoolClient,
  viewer: AdminDirectoryViewer,
  filter: UserDirectoryFilter,
): Promise<Record<string, unknown>> {
  const { original, sort, registeredSort, materializeDates, direction, timeColumn, order } = directoryFilterPlan(viewer, filter);
  // 列表、详情与快速核对共用同一 asOf，筛选结果与展示的会员投影因此同口径。
  const asOfUtc = new Date().toISOString();
  const numbered = filter.page !== undefined;
  if (numbered && (!Number.isSafeInteger(filter.page) || filter.page! < 1 || filter.page! > USER_DIRECTORY_MAX_PAGE
    || !Number.isSafeInteger(filter.limit) || filter.limit < 1 || filter.limit > 100 || filter.cursor !== undefined)) throw invalid("Directory page is invalid");
  if (!numbered && filter.contextKey !== undefined) throw invalid("Page context requires numbered pagination");
  const filterKey = sha256Hex(
    JSON.stringify({
      scope: numbered ? "admin-user-directory-page" : "admin-user-directory",
      principal: viewer.adminId,
      phoneLookup: viewer.phoneLookup,
      isBoss: viewer.isBoss,
      authorizationKey: viewer.authorizationKey ?? null,
      resourceRead: viewer.resourceRead === true,
      orderRead: viewer.orderRead === true,
      membershipSummaryRead: viewer.membershipSummaryRead === true,
      creditRead: viewer.creditRead === true,
      walletRead: viewer.walletRead === true,
      businessScopeUsable: viewer.businessScopeUsable !== false,
      userId: filter.userId ?? null,
      legacyId: filter.legacyId ?? null,
      identifier: filter.identifier ?? null,
      search: filter.search ?? null,
      identityStatus: filter.identityStatus ?? null,
      identityVerified: filter.identityVerified ?? null,
      ageStatus: filter.ageStatus ?? null,
      phone: filter.phone ? sha256Hex(filter.phone) : null,
      accountStatus: filter.accountStatus ?? null,
      source: filter.source ?? null,
      membershipTier: filter.membershipTier ?? null,
      entitlement: filter.entitlement ?? null,
      creditState: filter.creditState ?? null,
      creditMin: filter.creditMin ?? null,
      creditMax: filter.creditMax ?? null,
      riskState: filter.riskState ?? null,
      registeredFrom: filter.registeredFrom ?? null,
      registeredTo: filter.registeredTo ?? null,
      limit: filter.limit,
      ...(original ? { registrationTime: "ORIGINAL", sort: filter.sort ?? "registered_desc", registeredBefore: filter.registeredBefore ?? null } : {}),
    }),
  );
  if (filter.contextKey !== undefined && filter.contextKey !== filterKey) throw conflict("Directory query or authorisation changed; return to the first page");
  const cursor = parseKeysetCursor(filter.cursor, filterKey, original);

  const { resourceRead, orderRead, values, conditions, needsIdentity, membershipConditions, dateConditions } = await directoryPredicatePlan(client, viewer, filter, asOfUtc);
  // Count uses the identical filter predicates, without the four projection-only parameters or cursor.
  const countValues = values.slice(4);
  const countConditions = conditions.map(condition => condition.replace(/\$(\d+)/g, (_, index: string) => `$${Number(index) - 4}`));
  values.push(cursor?.createdAt ?? null, cursor?.id ?? null, numbered ? filter.limit : filter.limit + 1);
  const cursorTime = values.length - 2;
  const cursorId = values.length - 1;
  const limitParameter = values.length;
  const offsetParameter = filter.page === undefined ? undefined : values.push((filter.page - 1) * filter.limit);
  const legacyMarketIds = viewer.legacyMarketAccountIds?.length ? `$${values.push(viewer.legacyMarketAccountIds)}` : undefined;
  const cursorCondition = !registeredSort ? `($${cursorTime}::timestamptz IS NULL AND $${cursorId}::text IS NULL)` : original
    ? `(($${cursorTime}::timestamptz IS NULL AND $${cursorId}::text IS NULL) OR ($${cursorId}::text IS NOT NULL AND (
        ($${cursorTime}::timestamptz IS NULL AND ${timeColumn} IS NULL AND u.id COLLATE "C" < $${cursorId}) OR
        ($${cursorTime}::timestamptz IS NOT NULL AND (${timeColumn} IS NULL OR ${timeColumn} ${direction === "ASC" ? ">" : "<"} $${cursorTime}::timestamptz
          OR (${timeColumn}=$${cursorTime}::timestamptz AND u.id COLLATE "C" < $${cursorId}))))))`
    : `($${cursorTime}::timestamptz IS NULL OR u."createdAt" < $${cursorTime}::timestamptz OR (u."createdAt" = $${cursorTime}::timestamptz AND u.id < $${cursorId}))`;

  const orderCountRelation = orderRead && viewer.legacyRead ? orderReadRelation(await legacyContinuationReady(client), true) : null;
  const orderSource = orderCountRelation ? `(${orderCountRelation})` : "zzsh_order.rental_order";
  // 排序用的候选集聚合：与展示用同一谓词、同一授权范围；未知排后不补 0。
  const resourceAggregateJoin = `LEFT JOIN (
      SELECT owner_user_id AS user_id, count(*)::int AS account_count,
        count(*) FILTER (WHERE ${publishedAccountSql("ra", legacyMarketIds)})::int AS published_count
      FROM zzsh_supply.rental_account ra
      WHERE $3::boolean AND ${gameScopeSql("ra.game_id", "$2", "$1")}
      GROUP BY owner_user_id
    ) resource_aggregate ON resource_aggregate.user_id = u.id`;
  const orderAggregateJoin = `LEFT JOIN (
      SELECT user_id, sum(renter)::int AS renter_count, sum(owner_count)::int AS owner_count, sum(current_count)::int AS current_count FROM (
        SELECT o.renter_user_id AS user_id, 1::int AS renter, 0::int AS owner_count, 1::int AS current_count FROM ${orderSource} o
         WHERE $4::boolean AND o.status IN ('PENDING_PAYMENT','PAID') AND ${gameScopeSql("o.game_id", "$2", "$1")}
        UNION ALL
        SELECT o.owner_user_id AS user_id, 0::int AS renter, 1::int AS owner_count, CASE WHEN o.owner_user_id IS DISTINCT FROM o.renter_user_id THEN 1 ELSE 0 END AS current_count FROM ${orderSource} o
         WHERE $4::boolean AND o.status IN ('PENDING_PAYMENT','PAID') AND ${gameScopeSql("o.game_id", "$2", "$1")}
      ) roles GROUP BY user_id
    ) order_aggregate ON order_aggregate.user_id = u.id`;
  const creditScopeJoin = `LEFT JOIN (
      SELECT owner_user_id AS user_id FROM zzsh_supply.rental_account a WHERE ${gameScopeSql("a.game_id", "$2", "$1")}
      UNION SELECT renter_user_id AS user_id FROM zzsh_order.rental_order o WHERE ${gameScopeSql("o.game_id", "$2", "$1")}
      UNION SELECT owner_user_id AS user_id FROM zzsh_order.rental_order o WHERE ${gameScopeSql("o.game_id", "$2", "$1")}
    ) credit_scope ON credit_scope.user_id = u.id`;
  const creditStateJoin = `LEFT JOIN zzsh_credit.user_credit_state credit_state ON credit_state.user_id = u.id`;
  const sortPlan = (): { joins: string; key: string } => {
    if (sort === "active_orders_desc") return { joins: orderAggregateJoin, key: "COALESCE(order_aggregate.current_count,0)" };
    if (sort === "balance_desc" || sort === "balance_asc") return { joins: DIRECTORY_WALLET_SORT_JOINS, key: DIRECTORY_WALLET_SORT_KEY };
    if (sort === "credit_desc" || sort === "credit_asc") return { joins: `${creditStateJoin} ${creditScopeJoin}`, key: "CASE WHEN ($1::boolean OR credit_scope.user_id IS NOT NULL) AND credit_state.revision IS NOT NULL THEN credit_state.score ELSE NULL END" };
    if (sort === "renter_current_desc" || sort === "renter_current_asc") return { joins: orderAggregateJoin, key: "COALESCE(order_aggregate.renter_count,0)" };
    if (sort === "owner_current_desc" || sort === "owner_current_asc") return { joins: orderAggregateJoin, key: "COALESCE(order_aggregate.owner_count,0)" };
    if (sort === "published_desc" || sort === "published_asc") return { joins: resourceAggregateJoin, key: "COALESCE(resource_aggregate.published_count,0)" };
    return { joins: "", key: "registration.registered_at" };
  };
  const plan = sortPlan();
  const selectColumns = (accountStatusExpr: string, identityStatusExpr: string, ageStatusExpr: string, providerExpr: string, providerReferenceExpr: string) => `u.id, u.name, u.image, u.username, u."displayUsername", u."phoneNumber", u.suspended,
              to_char(u."createdAt" ${TIMESTAMP_TEXT}) AS "localCreatedAt",
              ${original ? `to_char(${materializeDates ? "selected.registered_at" : originalRegistrationSql("mig", true)} ${TIMESTAMP_TEXT}) AS "originalRegisteredAt",` : ""}
              to_char(u."updatedAt" ${TIMESTAMP_TEXT}) AS "localUpdatedAt", ${ageStatusExpr} AS "ageStatus",
              ${accountStatusExpr} AS "accountStatus", ${identityStatusExpr} AS "identityStatus",
              ${providerExpr} AS provider, ${providerReferenceExpr} AS "providerReference",
              ${materializeDates ? "selected.migration_legacy_id" : "mig.legacy_id"} AS "migrationLegacyId",
              selected.risk_flag AS "riskFlag",
              CASE WHEN $3::boolean THEN resource_counts.account_count ELSE NULL END AS "resourceAccountCount",
              CASE WHEN $3::boolean THEN resource_counts.published_count ELSE NULL END AS "resourcePublishedCount",
              CASE WHEN $4::boolean THEN current_orders.current_count ELSE NULL END AS "currentOrderCount",
              CASE WHEN $4::boolean THEN current_orders.renter_count ELSE NULL END AS "renterCurrentOrderCount",
              CASE WHEN $4::boolean THEN current_orders.owner_count ELSE NULL END AS "ownerCurrentOrderCount"`;

  const consultsMigration = materializeDates || filterConsultsMigrationAudit({ ...filter, registrationTime: undefined });
  const countConsultsMigration = Boolean(filter.legacyId || filter.search
    || (filter.source !== undefined && filter.source !== USER_DIRECTORY_SOURCE.MIGRATED));
  const migrationQuery = directoryMigrationRelation(original, !consultsMigration);
  // The validated timestamp is expensive; materialise narrow facts once before applying both bounds and sorting.
  const registrationFactsSql = () => `SELECT u.id,u."createdAt" AS created_at,${originalRegistrationSql("mig", true)} AS registered_at,mig.legacy_id AS migration_legacy_id,
       COALESCE(risk_flag.flagged,false) AS risk_flag${plan.joins ? `,${plan.key} AS sort_value` : ""}
    FROM zzsh_auth_user."user" u
    LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id
    LEFT JOIN migration mig ON mig.object_id=u.id
    ${RISK_FLAG_JOIN} ${plan.joins}
    WHERE ${membershipConditions.join(" AND ") || "TRUE"}`;
  const pageQuery = materializeDates
    ? `SELECT registration.id,registration.created_at AS "createdAt",registration.registered_at,
        registration.migration_legacy_id, registration.risk_flag${plan.joins ? ",registration.sort_value" : ""}
       FROM registration_dates registration
       WHERE ${[...dateConditions,cursorCondition.replaceAll("u.id", "registration.id")].join(" AND ")}
       ORDER BY ${plan.joins ? `registration.sort_value ${direction} NULLS LAST, registration.id COLLATE "C" DESC` : order.replaceAll("u.id", "registration.id")}
       LIMIT $${limitParameter}${offsetParameter === undefined ? "" : ` OFFSET $${offsetParameter}`}`
    : `SELECT u.id, COALESCE(risk_flag.flagged,false) AS risk_flag${plan.joins ? `,${plan.key} AS sort_value` : ""}
           FROM zzsh_auth_user."user" u
           ${needsIdentity ? `LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id = u.id` : ""}
           ${consultsMigration ? "LEFT JOIN migration mig ON mig.object_id = u.id" : ""}
           ${RISK_FLAG_JOIN} ${plan.joins}
          WHERE ${[...conditions, cursorCondition].join(" AND ")}
          ORDER BY ${plan.joins ? `sort_value ${direction} NULLS LAST,u.id COLLATE "C" DESC` : order}
           LIMIT $${limitParameter}${offsetParameter === undefined ? "" : ` OFFSET $${offsetParameter}`}`;
  let total = 0;
  if (!original) {
    const countSql = `${countConsultsMigration ? `WITH migration AS MATERIALIZED (${migrationQuery})` : ""}
       SELECT count(*)::int AS total FROM zzsh_auth_user."user" u
       ${needsIdentity ? `LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id = u.id` : ""}
       ${countConsultsMigration ? "LEFT JOIN migration mig ON mig.object_id = u.id" : ""}
       WHERE ${countConditions.join(" AND ") || "TRUE"}`;
    total = (await client.query<{ total: number }>(countSql, countValues)).rows[0]!.total;
  }
  // Narrow keys avoid materialising full user/identity rows before the top-N operation.
  const ctes = consultsMigration
      ? `migration AS ${original ? "NOT MATERIALIZED" : "MATERIALIZED"} (${migrationQuery}), ${materializeDates ? `registration_dates AS MATERIALIZED (${registrationFactsSql()}),` : ""} page AS MATERIALIZED (${pageQuery})`
      : `page AS MATERIALIZED (${pageQuery}), migration AS MATERIALIZED (${migrationQuery})`;
  const projectionOrder = original ? `${plan.joins ? "selected.sort_value" : "selected.registered_at"} ${direction} NULLS LAST, u.id COLLATE "C" DESC` : order;
  const projection = `SELECT ${selectColumns("s.account_status", "s.identity_status", "s.age_status", "s.provider", "s.provider_reference")}${original ? `,${plan.joins ? "selected.sort_value" : "selected.registered_at"} AS "__directory_sort_at"` : ""}
         FROM page selected
         JOIN zzsh_auth_user."user" u ON u.id = selected.id
         LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id = u.id
         ${materializeDates ? "" : "LEFT JOIN migration mig ON mig.object_id = u.id"}
         ${resourceCountsSql("$3", "$1", "$2", legacyMarketIds)}
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS current_count,
                  count(*) FILTER (WHERE o.renter_user_id=u.id)::int AS renter_count,
                  count(*) FILTER (WHERE o.owner_user_id=u.id)::int AS owner_count
             FROM ${orderCountRelation ? "("+orderCountRelation+")" : "zzsh_order.rental_order"} o
            WHERE $4::boolean AND (o.renter_user_id=u.id OR o.owner_user_id=u.id)
              AND o.status IN ('PENDING_PAYMENT','PAID') AND ${gameScopeSql("o.game_id","$2","$1")}
         ) current_orders ON true
        ORDER BY ${projectionOrder}`;

  let rows: UserListRow[];
  if (original) {
    // One materialisation avoids repeating the expensive date validation on the same backend.
    const result = (await client.query<{ total: number; directory_rows: UserListRow[] }>(`WITH ${ctes}, projected AS (${projection})
      SELECT (${materializeDates ? `SELECT count(*)::int AS total FROM registration_dates registration WHERE ${dateConditions.join(" AND ") || "TRUE"}`
        : `SELECT count(*)::int FROM zzsh_auth_user."user" u ${needsIdentity ? "LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id" : ""}
           ${consultsMigration ? "LEFT JOIN migration mig ON mig.object_id=u.id" : ""} WHERE ${membershipConditions.join(" AND ") || "TRUE"}`}) AS total,
      COALESCE((SELECT json_agg(to_jsonb(p)-'__directory_sort_at' ORDER BY p.__directory_sort_at ${direction} NULLS LAST,p.id COLLATE "C" DESC)
        FROM projected p),'[]'::json) AS directory_rows`, values)).rows[0]!;
    total = result.total;
    rows = result.directory_rows;
  } else {
    rows = (await client.query<UserListRow>(`WITH ${ctes} ${projection}`, values)).rows;
  }
  const items = rows.slice(0, filter.limit);
  const hasMore = rows.length > filter.limit;
  const last = items.at(-1);
  const summaries = await readUserDirectoryBusinessSummaries(client, viewer, items.map(row => row.id), asOfUtc);
  const wallets = await readUserDirectoryWalletSummaries(client, { walletRead: viewer.walletRead === true }, items.map(row => row.id), asOfUtc);
  return {
    items: items.map(row => ({ ...projectListItem(row, viewer, original), ...summaries.get(row.id), walletSummary: wallets.get(row.id) ?? { state: "denied", permission: DIRECTORY_WALLET_PERMISSION } })),
    total,
    nextCursor: !numbered && hasMore && last ? encodeKeysetCursor(filterKey, { sortAt: original ? last.originalRegisteredAt ?? null : last.localCreatedAt, id: last.id }) : null,
    limit: filter.limit,
    ...(numbered ? { paginationMode: "page", page: filter.page, pageSize: filter.limit, contextKey: filterKey } : {}),
  };
}

/** Counts the same directory filter set, with no page, cursor, projection or sensitive columns. */
export async function userDirectoryStatusCountQuery(client: PoolClient, viewer: AdminDirectoryViewer, filter: UserDirectoryFilter, asOfUtc: string): Promise<{ text: string; values: unknown[] }> {
  const { original } = directoryFilterPlan(viewer, filter);
  // shortcut: the existing tier filter materialises all memberships in Node; no aggregate until it has a SQL predicate.
  if (filter.membershipTier !== undefined) throw invalid("Membership tier aggregate is not supported");
  const plan = await directoryPredicatePlan(client, viewer, filter, asOfUtc);
  const migration = filterConsultsMigrationAudit(filter);
  const conditions = plan.conditions.map(condition => condition.replace(/\$(\d+)/g, (_, index: string) => `$${Number(index) - 4}`));
  const statuses = USER_DIRECTORY_STATUS_FILTER.map(status => `count(*) FILTER (WHERE (${ACCOUNT_STATUS_SQL})='${status}')::text AS "${status}"`).join(", ");
  return {
    text: `${migration ? `WITH migration AS MATERIALIZED (${directoryMigrationRelation(original, false)})` : ""}
      SELECT count(*)::text AS total, ${statuses}
      FROM zzsh_auth_user."user" u
      LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id
      ${migration ? "LEFT JOIN migration mig ON mig.object_id=u.id" : ""}
      ${original && plan.dateConditions.length ? `LEFT JOIN LATERAL (SELECT ${originalRegistrationSql("mig", true)} AS registered_at) registration ON true` : ""}
      WHERE ${conditions.join(" AND ") || "TRUE"}`,
    values: plan.values.slice(4),
  };
}
