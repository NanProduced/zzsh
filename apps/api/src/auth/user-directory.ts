import type { PoolClient } from "pg";

import { gameScopeSql } from "./admin-scope";
import { conflict, forbidden, invalid, sha256Hex } from "../supply/supply-util";
import { escapeLike } from "../supply/catalog";
import { effectivePublicationStateSql, isEffectivePublicationState } from "../supply/listing-query";
import { notFound } from "../supply/supply-util";
import { orderReadRelation, projectAdminReadOrder } from "../order/admin-order-read";
import { legacyContinuationReady } from "../order/legacy-order-read";
import { loadLegacyHistoricalRead, loadLegacyHistoricalReads } from "../supply/legacy-listing-read";
import { readUserDirectoryBusinessSummaries } from "./user-directory-business-summary";

export const USER_DIRECTORY_SOURCE = {
  LOCAL: "LOCAL",
  MIGRATED: "MIGRATED",
  UNKNOWN: "UNKNOWN",
} as const;
export type UserDirectorySource = (typeof USER_DIRECTORY_SOURCE)[keyof typeof USER_DIRECTORY_SOURCE];

export const USER_DIRECTORY_STATUS_FILTER = ["ACTIVE", "RESTRICTED", "DEACTIVATED", "CANCELLED", "UNKNOWN"] as const;
export type UserDirectoryStatusFilter = (typeof USER_DIRECTORY_STATUS_FILTER)[number];
export const USER_DIRECTORY_MAX_PAGE = 1_000_000;

const TIMESTAMP_TEXT = `AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const LEGACY_MIGRATION_ACTION = "user.legacy_owner.migrated";
const LEGACY_PROVIDER = "legacy_mysql_restore";

/** Synthetic addresses produced by phone registration / migration / anonymization are not contact facts. */
const SYNTHETIC_EMAIL = /@(phone\.zzsh\.invalid|anonymized\.invalid)$/i;

export function maskPhoneNumber(phone: string | null): string | null {
  if (!phone) return null;
  const compact = phone.trim();
  if (compact.length === 0) return null;
  if (compact.length <= 4) return "****";
  const head = compact.startsWith("+86") ? compact.slice(0, 6) : compact.slice(0, 3);
  const tail = compact.slice(-4);
  return `${head}****${tail}`;
}

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

function parseKeysetCursor(cursor: string | undefined, filterKey: string, allowUnknownTime = false): KeysetCursor | null {
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

function encodeKeysetCursor(filterKey: string, row: { sortAt: string | null; id: string }): string {
  return Buffer.from(JSON.stringify({ f: filterKey, c: row.sortAt, i: row.id })).toString("base64url");
}

export type AdminDirectoryViewer = {
  adminId: string;
  isBoss: boolean;
  phoneLookup: boolean;
  resourceRead?: boolean;
  orderRead?: boolean;
  auditRead?: boolean;
  membershipSummaryRead?: boolean;
  creditRead?: boolean;
  businessScopeUsable?: boolean;
  authorizationKey?: string;
  legacyRead?: boolean;
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
  ageStatus?: string;
  registeredFrom?: string;
  registeredTo?: string;
  registeredBefore?: string;
  registrationTime?: "ORIGINAL";
  sort?: "registered_desc" | "registered_asc";
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
};

function legacyIdFromReference(provider: string | null, reference: string | null): string | null {
  if (provider !== LEGACY_PROVIDER || !reference) return null;
  const separator = reference.indexOf(":");
  if (separator <= 0 || separator === reference.length - 1) return null;
  return reference.slice(separator + 1);
}

function sourceKindOf(migrationLegacyId: string | null, provider: string | null, identityPresent: boolean): UserDirectorySource {
  if (provider === LEGACY_PROVIDER) return USER_DIRECTORY_SOURCE.MIGRATED;
  if (identityPresent && provider === "none" && migrationLegacyId === null) return USER_DIRECTORY_SOURCE.LOCAL;
  return USER_DIRECTORY_SOURCE.UNKNOWN;
}

export function projectUserAccountStatus(status: string | null, suspended: boolean): UserDirectoryStatusFilter {
  if (status === null) return "UNKNOWN";
  if (status === "CANCELLED" || status === "DEACTIVATED") return status;
  if (suspended) return "RESTRICTED";
  return status === "ACTIVE" ? "ACTIVE" : "UNKNOWN";
}

const ACCOUNT_STATUS_SQL = `CASE WHEN s.user_id IS NULL THEN 'UNKNOWN'
  WHEN s.account_status='CANCELLED' THEN 'CANCELLED'
  WHEN s.account_status='DEACTIVATED' THEN 'DEACTIVATED'
  WHEN u.suspended THEN 'RESTRICTED'
  WHEN s.account_status='ACTIVE' THEN 'ACTIVE' ELSE 'UNKNOWN' END`;
/**
 * Three-state source classification. `mig.legacy_id` is the *latest* migration audit's legacy id and is
 * nullable, so `IS NULL` distinguishes "no legacy id on the newest migration fact" from "has one". This
 * predicate therefore always reads the latest-fact relation and is never re-expressed as an existence test:
 * an existence test over all audit rows would treat any historical row as the newest one.
 */
const SOURCE_SQL = `CASE WHEN s.provider='${LEGACY_PROVIDER}' THEN 'MIGRATED'
  WHEN s.user_id IS NOT NULL AND s.provider='none' AND mig.legacy_id IS NULL THEN 'LOCAL' ELSE 'UNKNOWN' END`;

// Validate the newest fact after selection; invalid or empty facts must never revive an older date.
function originalRegistrationSql(migration = "mig"): string {
  return `CASE WHEN s.user_id IS NOT NULL AND s.provider='none' AND ${migration}.object_id IS NULL THEN u."createdAt"
    WHEN s.provider='${LEGACY_PROVIDER}' AND ${migration}.source_system='${LEGACY_PROVIDER}'
      AND ${migration}.source_entity='la_user' AND NULLIF(${migration}.legacy_id,'') IS NOT NULL
      AND s.provider_reference='la_user:' || ${migration}.legacy_id
      AND ${migration}.source_digest ~ '^[0-9a-f]{64}$' AND NULLIF(${migration}.evidence_ref,'') IS NOT NULL
      AND ${migration}.source_created_at ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,6})?Z$'
      AND pg_input_is_valid(${migration}.source_created_at,'timestamp with time zone')
    THEN ${migration}.source_created_at::timestamptz ELSE NULL END`;
}

function publishedAccountSql(account: string): string {
  return `${account}.lifecycle='ACTIVE' AND EXISTS (
    SELECT 1 FROM zzsh_supply.listing_version pv
    JOIN zzsh_supply.listing_publication pp ON pp.version_id=pv.id AND pp.account_id=pv.account_id
      AND pp.owner_user_id=${account}.owner_user_id AND pp.game_id=${account}.game_id
      AND pp.rule_release_id=pv.rule_release_id AND pp.content_hash=pv.content_hash
    WHERE pv.id=${account}.current_version_id AND pv.account_id=${account}.id
      AND ${effectivePublicationStateSql("pv", "pp")})`;
}

function resourceCountsSql(read: string, boss: string, admin: string): string {
  return `LEFT JOIN LATERAL (
    SELECT count(*)::int AS account_count,
      count(*) FILTER (WHERE ${publishedAccountSql("ra")})::int AS published_count
    FROM zzsh_supply.rental_account ra
    WHERE ${read}::boolean AND ra.owner_user_id=u.id AND ${gameScopeSql("ra.game_id", admin, boss)}
  ) resource_counts ON true`;
}

function projectRelationshipSummaries(
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
    image: row.image,
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

export async function listUserDirectory(
  client: PoolClient,
  viewer: AdminDirectoryViewer,
  filter: UserDirectoryFilter,
): Promise<Record<string, unknown>> {
  const original = filter.registrationTime === "ORIGINAL";
  const materializeDates = original;
  if ((filter.registrationTime !== undefined && !original) || (filter.sort !== undefined && (!original || !["registered_desc", "registered_asc"].includes(filter.sort)))) throw invalid("Registration time mode or sort is invalid");
  if (filter.registeredBefore !== undefined && (!original || filter.registeredTo !== undefined)) throw invalid("Registered before requires original time and no inclusive upper bound");
  const direction = filter.sort === "registered_asc" ? "ASC" : "DESC";
  const timeColumn = original ? "registration.registered_at" : 'u."createdAt"';
  const order = original ? `${timeColumn} ${direction} NULLS LAST, u.id COLLATE "C" DESC` : 'u."createdAt" DESC, u.id DESC';
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
      businessScopeUsable: viewer.businessScopeUsable !== false,
      userId: filter.userId ?? null,
      legacyId: filter.legacyId ?? null,
      identifier: filter.identifier ?? null,
      search: filter.search ?? null,
      identityStatus: filter.identityStatus ?? null,
      ageStatus: filter.ageStatus ?? null,
      phone: filter.phone ? sha256Hex(filter.phone) : null,
      accountStatus: filter.accountStatus ?? null,
      source: filter.source ?? null,
      registeredFrom: filter.registeredFrom ?? null,
      registeredTo: filter.registeredTo ?? null,
      limit: filter.limit,
      ...(original ? { registrationTime: "ORIGINAL", sort: filter.sort ?? "registered_desc", registeredBefore: filter.registeredBefore ?? null } : {}),
    }),
  );
  if (filter.contextKey !== undefined && filter.contextKey !== filterKey) throw conflict("Directory query or authorisation changed; return to the first page");
  const cursor = parseKeysetCursor(filter.cursor, filterKey, original);

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
  if (filter.ageStatus) conditions.push(`COALESCE(s.age_status,'UNKNOWN')=$${values.push(filter.ageStatus)}`);
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
  // Count uses the identical filter predicates, without the four projection-only parameters or cursor.
  const countValues = values.slice(4);
  const countConditions = conditions.map(condition => condition.replace(/\$(\d+)/g, (_, index: string) => `$${Number(index) - 4}`));
  values.push(cursor?.createdAt ?? null, cursor?.id ?? null, numbered ? filter.limit : filter.limit + 1);
  const cursorTime = values.length - 2;
  const cursorId = values.length - 1;
  const limitParameter = values.length;
  const offsetParameter = filter.page === undefined ? undefined : values.push((filter.page - 1) * filter.limit);
  const cursorCondition = original
    ? `(($${cursorTime}::timestamptz IS NULL AND $${cursorId}::text IS NULL) OR ($${cursorId}::text IS NOT NULL AND (
        ($${cursorTime}::timestamptz IS NULL AND ${timeColumn} IS NULL AND u.id COLLATE "C" < $${cursorId}) OR
        ($${cursorTime}::timestamptz IS NOT NULL AND (${timeColumn} IS NULL OR ${timeColumn} ${direction === "ASC" ? ">" : "<"} $${cursorTime}::timestamptz
          OR (${timeColumn}=$${cursorTime}::timestamptz AND u.id COLLATE "C" < $${cursorId}))))))`
    : `($${cursorTime}::timestamptz IS NULL OR u."createdAt" < $${cursorTime}::timestamptz OR (u."createdAt" = $${cursorTime}::timestamptz AND u.id < $${cursorId}))`;

  const orderCountRelation = orderRead && viewer.legacyRead ? orderReadRelation(await legacyContinuationReady(client), true) : null;
  const selectColumns = (accountStatusExpr: string, identityStatusExpr: string, ageStatusExpr: string, providerExpr: string, providerReferenceExpr: string) => `u.id, u.name, u.image, u.username, u."displayUsername", u."phoneNumber", u.suspended,
              to_char(u."createdAt" ${TIMESTAMP_TEXT}) AS "localCreatedAt",
              ${original ? `to_char(selected.registered_at ${TIMESTAMP_TEXT}) AS "originalRegisteredAt",` : ""}
              to_char(u."updatedAt" ${TIMESTAMP_TEXT}) AS "localUpdatedAt", ${ageStatusExpr} AS "ageStatus",
              ${accountStatusExpr} AS "accountStatus", ${identityStatusExpr} AS "identityStatus",
              ${providerExpr} AS provider, ${providerReferenceExpr} AS "providerReference",
              ${original ? "selected.migration_legacy_id" : "mig.legacy_id"} AS "migrationLegacyId",
              CASE WHEN $3::boolean THEN resource_counts.account_count ELSE NULL END AS "resourceAccountCount",
              CASE WHEN $3::boolean THEN resource_counts.published_count ELSE NULL END AS "resourcePublishedCount",
              CASE WHEN $4::boolean THEN current_orders.current_count ELSE NULL END AS "currentOrderCount",
              CASE WHEN $4::boolean THEN current_orders.renter_count ELSE NULL END AS "renterCurrentOrderCount",
              CASE WHEN $4::boolean THEN current_orders.owner_count ELSE NULL END AS "ownerCurrentOrderCount"`;

  const consultsMigration = filterConsultsMigrationAudit(filter);
  const countUsesOriginalTime = original && Boolean(filter.registeredFrom || filter.registeredTo || filter.registeredBefore);
  const countConsultsMigration = Boolean(filter.legacyId || filter.search
    || (filter.source !== undefined && filter.source !== USER_DIRECTORY_SOURCE.MIGRATED) || countUsesOriginalTime);
  const migrationQuery = `SELECT DISTINCT ON (e.object_id) e.object_id,
           e.details->>'legacyId' AS legacy_id
           ${original ? `,e.details->>'sourceCreatedAt' AS source_created_at,
             e.details->>'sourceSystem' AS source_system,e.details->>'sourceEntity' AS source_entity,
             e.details->>'sourceDigest' AS source_digest,e.details->>'evidenceRef' AS evidence_ref` : ""}
      FROM zzsh_iam.audit_event e
      ${consultsMigration ? "" : "JOIN page candidate ON candidate.id = e.object_id"}
     WHERE e.action = '${LEGACY_MIGRATION_ACTION}' AND e.object_type = 'user'
       ${original ? "AND e.outcome='SUCCESS'" : ""}
     ORDER BY e.object_id, e.occurred_at DESC, e.id DESC`;
  // The validated timestamp is expensive; materialise narrow facts once before applying both bounds and sorting.
  // The count only reads the validated date; page projection needs the remaining display columns.
  const registrationFactsSql = (countOnly: boolean) => `SELECT ${countOnly ? "" : `u.id,u."createdAt" AS created_at,`}${originalRegistrationSql()} AS registered_at${countOnly ? "" : ",mig.legacy_id AS migration_legacy_id"}
    FROM zzsh_auth_user."user" u
    LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id
    LEFT JOIN migration mig ON mig.object_id=u.id
    WHERE ${membershipConditions.join(" AND ") || "TRUE"}`;
  const pageQuery = materializeDates
    ? `SELECT registration.id,registration.created_at AS "createdAt",registration.registered_at,
        registration.migration_legacy_id
       FROM registration_dates registration
       WHERE ${[...dateConditions,cursorCondition.replaceAll("u.id", "registration.id")].join(" AND ")}
       ORDER BY ${order.replaceAll("u.id", "registration.id")}
       LIMIT $${limitParameter}${offsetParameter === undefined ? "" : ` OFFSET $${offsetParameter}`}`
    : `SELECT u.id
           FROM zzsh_auth_user."user" u
           ${needsIdentity ? `LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id = u.id` : ""}
           ${consultsMigration ? "LEFT JOIN migration mig ON mig.object_id = u.id" : ""}
          WHERE ${[...conditions, cursorCondition].join(" AND ")}
          ORDER BY ${order}
           LIMIT $${limitParameter}${offsetParameter === undefined ? "" : ` OFFSET $${offsetParameter}`}`;
  const countSql = countUsesOriginalTime
    ? `WITH migration AS NOT MATERIALIZED (${migrationQuery}),registration_dates AS MATERIALIZED (${registrationFactsSql(true)})
       SELECT count(*)::int AS total FROM registration_dates registration
       WHERE ${dateConditions.join(" AND ")}`.replace(/\$(\d+)/g,(_, index: string)=>`$${Number(index)-4}`)
    : `${countConsultsMigration ? `WITH migration AS ${original ? "NOT MATERIALIZED" : "MATERIALIZED"} (${migrationQuery})` : ""}
       SELECT count(*)::int AS total FROM zzsh_auth_user."user" u
       ${needsIdentity ? `LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id = u.id` : ""}
       ${countConsultsMigration ? "LEFT JOIN migration mig ON mig.object_id = u.id" : ""}
       WHERE ${countConditions.join(" AND ") || "TRUE"}`;
  const total = (await client.query<{ total: number }>(
    countSql,
    countValues,
  )).rows[0]!.total;
  // Narrow keys avoid materialising full user/identity rows before the top-N operation.
  const sql = `WITH ${consultsMigration
      ? `migration AS ${original ? "NOT MATERIALIZED" : "MATERIALIZED"} (${migrationQuery}), ${materializeDates ? `registration_dates AS MATERIALIZED (${registrationFactsSql(false)}),` : ""} page AS MATERIALIZED (${pageQuery})`
      : `page AS MATERIALIZED (${pageQuery}), migration AS MATERIALIZED (${migrationQuery})`}
       SELECT ${selectColumns("s.account_status", "s.identity_status", "s.age_status", "s.provider", "s.provider_reference")}
         FROM page selected
         JOIN zzsh_auth_user."user" u ON u.id = selected.id
         LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id = u.id
         ${original ? "" : "LEFT JOIN migration mig ON mig.object_id = u.id"}
         ${resourceCountsSql("$3", "$1", "$2")}
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS current_count,
                  count(*) FILTER (WHERE o.renter_user_id=u.id)::int AS renter_count,
                  count(*) FILTER (WHERE o.owner_user_id=u.id)::int AS owner_count
             FROM ${orderCountRelation ? "("+orderCountRelation+")" : "zzsh_order.rental_order"} o
            WHERE $4::boolean AND (o.renter_user_id=u.id OR o.owner_user_id=u.id)
              AND o.status IN ('PENDING_PAYMENT','PAID') AND ${gameScopeSql("o.game_id","$2","$1")}
         ) current_orders ON true
        ORDER BY ${original ? `selected.registered_at ${direction} NULLS LAST, u.id COLLATE "C" DESC` : order}`;

  const rows = (await client.query<UserListRow>(sql, values)).rows;
  const items = rows.slice(0, filter.limit);
  const hasMore = rows.length > filter.limit;
  const last = items.at(-1);
  const summaries = await readUserDirectoryBusinessSummaries(client, viewer, items.map(row => row.id));
  return {
    items: items.map(row => ({ ...projectListItem(row, viewer, original), ...summaries.get(row.id) })),
    total,
    nextCursor: !numbered && hasMore && last ? encodeKeysetCursor(filterKey, { sortAt: original ? last.originalRegisteredAt ?? null : last.localCreatedAt, id: last.id }) : null,
    limit: filter.limit,
    ...(numbered ? { paginationMode: "page", page: filter.page, pageSize: filter.limit, contextKey: filterKey } : {}),
  };
}

export type UserDetailRow = {
  id: string;
  name: string;
  image: string | null;
  username: string | null;
  displayUsername: string | null;
  phoneNumber: string | null;
  phoneNumberVerified: boolean | null;
  email: string | null;
  suspended: boolean;
  localCreatedAt: string;
  originalRegisteredAt?: string | null;
  localUpdatedAt: string;
  accountStatus: string | null;
  identityStatus: string | null;
  ageStatus: string | null;
  provider: string | null;
  providerReference: string | null;
  identityVerifiedAt: string | null;
  migrationLegacyId: string | null;
  migrationSourceSystem: string | null;
  migrationSourceEntity: string | null;
  migrationSourceCreatedAt: string | null;
  migrationSourceUpdatedAt: string | null;
  migrationSourceDigest: string | null;
  migrationEvidenceRef: string | null;
  migratedAt: string | null;
  resourceAccountCount: number;
  resourcePublishedCount: number;
  currentOrderCount: number;
  renterCurrentOrderCount: number;
  ownerCurrentOrderCount: number;
};

export async function readUserDirectoryDetail(
  client: PoolClient,
  viewer: AdminDirectoryViewer,
  userId: string,
  registrationTime?: "ORIGINAL",
): Promise<Record<string, unknown> | null> {
  if (registrationTime !== undefined && registrationTime !== "ORIGINAL") throw invalid("Registration time mode is invalid");
  const original = registrationTime === "ORIGINAL";
  const resourceRead = viewer.resourceRead === true && viewer.businessScopeUsable !== false;
  const orderRead = viewer.orderRead === true && viewer.businessScopeUsable !== false;
  const detailOrderRelation = orderRead && viewer.legacyRead ? orderReadRelation(await legacyContinuationReady(client), true) : null;
  const row = (
    await client.query<UserDetailRow>(
      `SELECT u.id, u.name, u.image, u.username, u."displayUsername", u."phoneNumber", u."phoneNumberVerified",
              u.email, u.suspended,
              to_char(u."createdAt" ${TIMESTAMP_TEXT}) AS "localCreatedAt",
              ${original ? `to_char(registration.registered_at ${TIMESTAMP_TEXT}) AS "originalRegisteredAt",` : ""}
              to_char(u."updatedAt" ${TIMESTAMP_TEXT}) AS "localUpdatedAt",
              s.account_status AS "accountStatus", s.identity_status AS "identityStatus", s.age_status AS "ageStatus",
              s.provider, s.provider_reference AS "providerReference",
              to_char(s.verified_at ${TIMESTAMP_TEXT}) AS "identityVerifiedAt",
              mig.legacy_id AS "migrationLegacyId", mig.source_system AS "migrationSourceSystem",
              mig.source_entity AS "migrationSourceEntity", mig.source_created_at AS "migrationSourceCreatedAt",
              mig.source_updated_at AS "migrationSourceUpdatedAt", mig.source_digest AS "migrationSourceDigest",
              mig.evidence_ref AS "migrationEvidenceRef", mig.migrated_at AS "migratedAt",
              CASE WHEN $4::boolean THEN resource_counts.account_count ELSE NULL END AS "resourceAccountCount",
              CASE WHEN $4::boolean THEN resource_counts.published_count ELSE NULL END AS "resourcePublishedCount",
              CASE WHEN $5::boolean THEN current_orders.current_count ELSE NULL END AS "currentOrderCount",
              CASE WHEN $5::boolean THEN current_orders.renter_count ELSE NULL END AS "renterCurrentOrderCount",
              CASE WHEN $5::boolean THEN current_orders.owner_count ELSE NULL END AS "ownerCurrentOrderCount"
         FROM zzsh_auth_user."user" u
         LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id = u.id
         LEFT JOIN LATERAL (
           SELECT e.details->>'legacyId' AS legacy_id,
                  e.details->>'sourceSystem' AS source_system,
                  e.details->>'sourceEntity' AS source_entity,
                  e.details->>'sourceCreatedAt' AS source_created_at,
                  e.details->>'sourceUpdatedAt' AS source_updated_at,
                  e.details->>'sourceDigest' AS source_digest,
                  e.details->>'evidenceRef' AS evidence_ref,
                  to_char(e.occurred_at ${TIMESTAMP_TEXT}) AS migrated_at
             FROM zzsh_iam.audit_event e
            WHERE e.action = '${LEGACY_MIGRATION_ACTION}' AND e.object_type = 'user' AND e.object_id = u.id
              AND ($2::boolean OR (e.actor_type='admin' AND e.actor_id=$3))
            ORDER BY e.occurred_at DESC, e.id DESC
            LIMIT 1
         ) mig ON true
         ${original ? `LEFT JOIN LATERAL (
           SELECT e.object_id,e.details->>'legacyId' AS legacy_id,e.details->>'sourceCreatedAt' AS source_created_at,
             e.details->>'sourceSystem' AS source_system,e.details->>'sourceEntity' AS source_entity,
             e.details->>'sourceDigest' AS source_digest,e.details->>'evidenceRef' AS evidence_ref
           FROM zzsh_iam.audit_event e
           WHERE e.action='${LEGACY_MIGRATION_ACTION}' AND e.object_type='user' AND e.object_id=u.id AND e.outcome='SUCCESS'
           ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1
         ) registration_mig ON true
         LEFT JOIN LATERAL (SELECT ${originalRegistrationSql("registration_mig")} AS registered_at) registration ON true` : ""}
         ${resourceCountsSql("$4", "$2", "$3")}
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS current_count,
                  count(*) FILTER (WHERE o.renter_user_id=u.id)::int AS renter_count,
                  count(*) FILTER (WHERE o.owner_user_id=u.id)::int AS owner_count
             FROM ${detailOrderRelation ? "("+detailOrderRelation+")" : "zzsh_order.rental_order"} o
            WHERE $5::boolean AND (o.renter_user_id=u.id OR o.owner_user_id=u.id)
              AND o.status IN ('PENDING_PAYMENT','PAID') AND ${gameScopeSql("o.game_id","$3","$2")}
         ) current_orders ON true
        WHERE u.id = $1`,
      [userId, viewer.isBoss, viewer.adminId, resourceRead, orderRead],
    )
  ).rows[0];
  if (!row) return null;
  const legacyId = row.migrationLegacyId ?? legacyIdFromReference(row.provider, row.providerReference);
  const source = sourceKindOf(row.migrationLegacyId, row.provider, row.accountStatus !== null);
  const registeredAt = original ? row.originalRegisteredAt ?? null : row.localCreatedAt;
  const summaries = await readUserDirectoryBusinessSummaries(client, viewer, [userId]);
  return {
    userId: row.id,
    name: row.name,
    image: row.image,
    username: row.username,
    displayUsername: row.displayUsername,
    maskedPhone: maskPhoneNumber(row.phoneNumber),
    phoneNumberVerified: row.phoneNumber === null ? null : row.phoneNumberVerified === true,
    maskedEmail: maskEmail(row.email),
    accountStatus: projectUserAccountStatus(row.accountStatus, row.suspended),
    suspended: row.suspended,
    identity: {
      status: row.identityStatus ?? "UNKNOWN",
      ageStatus: row.ageStatus ?? "UNKNOWN",
      provider: row.provider ?? null,
      verifiedAt: row.identityVerifiedAt,
    },
    identityStatus: row.identityStatus ?? "UNKNOWN",
    ageStatus: row.ageStatus ?? "UNKNOWN",
    source: {
      kind: source,
      ...(legacyId ? { legacyId } : {}),
      ...(source === USER_DIRECTORY_SOURCE.MIGRATED && viewer.auditRead
        ? {
            sourceSystem: row.migrationSourceSystem ?? (row.provider === LEGACY_PROVIDER ? LEGACY_PROVIDER : null),
            sourceEntity: row.migrationSourceEntity ?? null,
            sourceCreatedAt: row.migrationSourceCreatedAt,
            sourceUpdatedAt: row.migrationSourceUpdatedAt,
            sourceDigest: row.migrationSourceDigest,
            evidenceRef: row.migrationEvidenceRef,
            migratedAt: row.migratedAt,
          }
        : {}),
    },
    registeredAt,
    registeredAtSource: original ? registeredAt === null ? "UNKNOWN" : row.provider === LEGACY_PROVIDER ? "LEGACY" : "LOCAL" : "LOCAL",
    createdAt: row.localCreatedAt,
    updatedAt: row.localUpdatedAt,
    localCreatedAt: row.localCreatedAt,
    localUpdatedAt: row.localUpdatedAt,
    ...projectRelationshipSummaries(row, viewer),
    ...summaries.get(userId),
    lastBusinessActivity: { state: "not_connected", domains: ["ORDER", "SUPPLY"] },
  };
}

export type UserRentalAccountRow = {
  id: string;
  displayNo: string | null;
  lifecycle: string;
  ownerPaused: boolean;
  staffRestricted: boolean;
  restrictionReason: string | null;
  legacyHold: string;
  currentVersionId: string | null;
  createdAt: string;
  gameId: string;
  gameCode: string;
  gameName: string;
  versionState: string | null;
  publicationSource: string | null;
};

export async function listUserRentalAccounts(
  client: PoolClient,
  viewer: AdminDirectoryViewer,
  userId: string,
  page: { limit: number; cursor?: string; publication?: "published" },
): Promise<Record<string, unknown>> {
  if (!viewer.resourceRead) throw forbidden("Resource reading requires supply.rental_account.read");
  if (page.publication !== undefined && page.publication !== "published") throw invalid("Publication filter is invalid");
  const filterKey = sha256Hex(
    JSON.stringify({ scope: "admin-user-rental-accounts", principal: viewer.adminId, isBoss: viewer.isBoss, authorizationKey: viewer.authorizationKey ?? null, userId, limit: page.limit, ...(page.publication ? { publication: page.publication } : {}) }),
  );
  const cursor = parseKeysetCursor(page.cursor, filterKey);
  const rows = (
    await client.query<UserRentalAccountRow>(
      `SELECT a.id, ${viewer.legacyRead ? "COALESCE(a.display_no,(SELECT l.legacy_account_no FROM zzsh_order.legacy_order_read_snapshot l WHERE l.account_id=a.id ORDER BY l.imported_at DESC LIMIT 1))" : "a.display_no"} AS "displayNo", a.lifecycle, a.owner_paused AS "ownerPaused",
              a.staff_restricted AS "staffRestricted",
              CASE WHEN a.staff_restricted THEN a.restriction_reason ELSE NULL END AS "restrictionReason",
              a.legacy_hold AS "legacyHold", a.current_version_id AS "currentVersionId",
              v.review_state AS "versionState", p.source AS "publicationSource",
              to_char(a.created_at ${TIMESTAMP_TEXT}) AS "createdAt",
              g.id AS "gameId", g.code AS "gameCode", g.name AS "gameName"
         FROM zzsh_supply.rental_account a
         JOIN zzsh_supply.game g ON g.id = a.game_id
         LEFT JOIN zzsh_supply.listing_version v ON v.id = a.current_version_id AND v.account_id = a.id
         LEFT JOIN zzsh_supply.listing_publication p ON p.version_id = v.id AND p.account_id = a.id
           AND p.owner_user_id=a.owner_user_id AND p.game_id=a.game_id AND p.rule_release_id=v.rule_release_id AND p.content_hash=v.content_hash
        WHERE a.owner_user_id = $1
          AND ${gameScopeSql("a.game_id","$3","$2")}
          ${page.publication ? `AND ${publishedAccountSql("a")}` : ""}
          AND ($4::timestamptz IS NULL OR a.created_at < $4::timestamptz OR (a.created_at = $4::timestamptz AND a.id < $5))
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $6`,
      [userId, viewer.isBoss, viewer.adminId, cursor?.createdAt ?? null, cursor?.id ?? null, page.limit + 1],
    )
  ).rows;
  const items = rows.slice(0, page.limit);
  const hasMore = rows.length > page.limit;
  const last = items.at(-1);
  const historical = await loadLegacyHistoricalReads(client, items.map(row => row.id));
  return {
    items: items.map((row) => ({
      accountId: row.id,
      displayNo: row.displayNo,
      game: { id: row.gameId, code: row.gameCode, name: row.gameName },
      lifecycle: row.lifecycle,
      ownerPaused: row.ownerPaused,
      staffRestricted: row.staffRestricted,
      restrictionReason: row.restrictionReason,
      legacyHold: row.legacyHold,
      currentVersionId: row.currentVersionId,
      publication: { versionState: row.versionState ?? null, source: row.publicationSource ?? null,
        versionPublished: isEffectivePublicationState(row.versionState, row.publicationSource),
        currentlyPublished: row.lifecycle === "ACTIVE" && isEffectivePublicationState(row.versionState, row.publicationSource) },
      createdAt: row.createdAt,
      historicalRead: historical.get(row.id) ?? null,
    })),
    nextCursor: hasMore && last ? encodeKeysetCursor(filterKey, { sortAt: last.createdAt, id: last.id }) : null,
    limit: page.limit,
  };
}

export async function readDirectoryRentalAccount(client:PoolClient,viewer:AdminDirectoryViewer,accountId:string) {
  if(!viewer.resourceRead)throw forbidden("Resource reading requires supply.rental_account.read");
  const account=(await client.query(`SELECT a.id AS "accountId",COALESCE(a.display_no,(SELECT l.legacy_account_no FROM zzsh_order.legacy_order_read_snapshot l WHERE l.account_id=a.id AND l.legacy_account_no IS NOT NULL ORDER BY l.imported_at DESC LIMIT 1)) AS "displayNo",
    a.owner_user_id AS "ownerUserId",u.name AS "ownerName",a.lifecycle,a.owner_paused AS "ownerPaused",a.staff_restricted AS "staffRestricted",a.legacy_hold AS "legacyHold",v.title,v.id AS "versionId",v.review_state AS "versionState",g.name AS "gameName",g.id AS "gameId"
    FROM zzsh_supply.rental_account a JOIN zzsh_auth_user."user" u ON u.id=a.owner_user_id JOIN zzsh_supply.game g ON g.id=a.game_id LEFT JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id AND v.account_id=a.id
    WHERE a.id=$1 AND ${gameScopeSql("a.game_id","$3","$2")}`,[accountId,viewer.isBoss,viewer.adminId])).rows[0];
  if(!account)throw notFound();
  return {account:{...account,historicalRead:await loadLegacyHistoricalRead(client,accountId)},contextKey:viewer.authorizationKey};
}

const USER_ORDER_ROLES = ["renter", "owner", "any"] as const;
export type UserOrderRole = (typeof USER_ORDER_ROLES)[number];

export type UserOrderFilter = {
  role?: UserOrderRole;
  status?: "PENDING_PAYMENT" | "PAID" | "COMPLETED" | "CANCELLED" | "current";
  limit: number;
  cursor?: string;
};

type UserOrderRow = {
  id: string;
  displayNo: string;
  status: string;
  role: "renter" | "owner";
  accountId: string;
  accountDisplayNo: string | null;
  title: string;
  gameId: string;
  rentalAmountCents: string;
  depositAmountCents: string;
  currency: string;
  counterpartyName: string;
  createdAt: string;
  holdUntil: string;
  paidAt: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  expiredAwaitingCancel: boolean;
};

export async function listUserOrders(
  client: PoolClient,
  viewer: AdminDirectoryViewer,
  userId: string,
  filter: UserOrderFilter,
): Promise<Record<string, unknown>> {
  if (!viewer.orderRead) throw forbidden("Order reading requires order.read");
  if (viewer.legacyRead) return listUserReadOrders(client,viewer,userId,filter);
  const filterKey = sha256Hex(
    JSON.stringify({
      scope: "admin-user-orders",
      principal: viewer.adminId,
      isBoss: viewer.isBoss,
      authorizationKey: viewer.authorizationKey ?? null,
      userId,
      role: filter.role ?? "any",
      status: filter.status ?? null,
      limit: filter.limit,
    }),
  );
  const cursor = parseKeysetCursor(filter.cursor, filterKey);
  const values: unknown[] = [userId, viewer.isBoss, viewer.adminId];
  const conditions = [
    `(o.renter_user_id = $1 OR o.owner_user_id = $1)`,
    gameScopeSql("o.game_id","$3","$2"),
  ];
  if (filter.role === "renter") conditions.push(`o.renter_user_id = $1`);
  if (filter.role === "owner") conditions.push(`o.owner_user_id = $1`);
  if (filter.status === "current") conditions.push(`o.status IN ('PENDING_PAYMENT','PAID')`);
  else if (filter.status) conditions.push(`o.status = $${values.push(filter.status)}`);
  values.push(cursor?.createdAt ?? null, cursor?.id ?? null, filter.limit + 1);
  const cursorTime = values.length - 2;
  const cursorId = values.length - 1;
  const limitParameter = values.length;
  conditions.push(`($${cursorTime}::timestamptz IS NULL OR o.created_at < $${cursorTime}::timestamptz OR (o.created_at = $${cursorTime}::timestamptz AND o.id < $${cursorId}))`);
  const rows = (
    await client.query<UserOrderRow>(
      `SELECT o.id, o.display_no AS "displayNo", o.status,
              CASE WHEN o.renter_user_id = $1 THEN 'renter' ELSE 'owner' END AS role,
              o.account_id AS "accountId", a.display_no AS "accountDisplayNo", o.title, o.game_id AS "gameId",
              o.rental_amount_cents::text AS "rentalAmountCents", o.deposit_amount_cents::text AS "depositAmountCents",
              o.currency,
              cp.name AS "counterpartyName",
              to_char(o.created_at ${TIMESTAMP_TEXT}) AS "createdAt",
              to_char(o.hold_until ${TIMESTAMP_TEXT}) AS "holdUntil",
              to_char(o.paid_at ${TIMESTAMP_TEXT}) AS "paidAt",
              CASE WHEN o.cancelled_at IS NULL THEN NULL ELSE to_char(o.cancelled_at ${TIMESTAMP_TEXT}) END AS "cancelledAt",
              o.cancel_reason AS "cancelReason",
              (o.status = 'PENDING_PAYMENT' AND o.hold_until <= clock_timestamp()) AS "expiredAwaitingCancel"
         FROM zzsh_order.rental_order o
         LEFT JOIN zzsh_supply.rental_account a ON a.id = o.account_id
         JOIN zzsh_auth_user."user" cp ON cp.id = CASE WHEN o.renter_user_id = $1 THEN o.owner_user_id ELSE o.renter_user_id END
        WHERE ${conditions.join(" AND ")}
        ORDER BY o.created_at DESC, o.id DESC
        LIMIT $${limitParameter}`,
      values,
    )
  ).rows;
  const items = rows.slice(0, filter.limit);
  const hasMore = rows.length > filter.limit;
  const last = items.at(-1);
  const toYuan = (cents: string) => {
    const value = BigInt(cents);
    const sign = value < 0n ? "-" : "";
    const absolute = value < 0n ? -value : value;
    return `${sign}${absolute / 100n}.${String(absolute % 100n).padStart(2, "0")}`;
  };
  return {
    items: items.map((row) => ({
      orderId: row.id,
      displayNo: row.displayNo,
      status: row.status,
      role: row.role,
      ...(viewer.resourceRead ? { accountId: row.accountId, accountDisplayNo: row.accountDisplayNo } : {}),
      title: row.title,
      gameId: row.gameId,
      counterpartyName: row.counterpartyName,
      amounts: {
        rental: { currency: row.currency, unit: "yuan", amount: toYuan(row.rentalAmountCents), scale: 2 },
        deposit: { currency: row.currency, unit: "yuan", amount: toYuan(row.depositAmountCents), scale: 2 },
        totalDue: {
          currency: row.currency,
          unit: "yuan",
          amount: toYuan((BigInt(row.rentalAmountCents) + BigInt(row.depositAmountCents)).toString()),
          scale: 2,
        },
      },
      createdAt: row.createdAt,
      holdUntil: row.holdUntil,
      paidAt: row.paidAt,
      cancelledAt: row.cancelledAt,
      cancelReason: row.cancelReason,
      expiredAwaitingCancel: row.expiredAwaitingCancel,
    })),
    nextCursor: hasMore && last ? encodeKeysetCursor(filterKey, { sortAt: last.createdAt, id: last.id }) : null,
    limit: filter.limit,
  };
}

async function listUserReadOrders(client:PoolClient,viewer:AdminDirectoryViewer,userId:string,filter:UserOrderFilter) {
  const key=sha256Hex(JSON.stringify({scope:'admin-user-read-orders',principal:viewer.adminId,authorizationKey:viewer.authorizationKey??null,userId,role:filter.role??'any',status:filter.status??null,limit:filter.limit}));
  const cursor=parseKeysetCursor(filter.cursor,key),values:unknown[]=[userId,viewer.isBoss,viewer.adminId],where=[`(x.owner_user_id=$1 OR x.renter_user_id=$1)`,gameScopeSql("x.game_id","$3","$2")];
  if(filter.role==='owner')where.push('x.owner_user_id=$1');if(filter.role==='renter')where.push('x.renter_user_id=$1');
  if(filter.status==='current')where.push("x.status IN ('PENDING_PAYMENT','PAID')");else if(filter.status)where.push('x.status=$'+values.push(filter.status));
  const time='$'+values.push(cursor?.createdAt??null),id='$'+values.push(cursor?.id??null),limit='$'+values.push(filter.limit+1);
  where.push(`(${time}::timestamptz IS NULL OR COALESCE(x.created_at,'0001-01-01'::timestamptz)<${time}::timestamptz OR (COALESCE(x.created_at,'0001-01-01'::timestamptz)=${time}::timestamptz AND x.id<${id}))`);
  const relation=orderReadRelation(await legacyContinuationReady(client));
  const rows=(await client.query(`WITH all_orders AS(${relation}) SELECT x.origin,x.record,x.id,CASE WHEN x.renter_user_id=$1 THEN 'renter' ELSE 'owner' END AS role,to_char(COALESCE(x.created_at,'0001-01-01'::timestamptz) ${TIMESTAMP_TEXT}) AS "sortAt" FROM all_orders x WHERE ${where.join(' AND ')} ORDER BY x.created_at DESC NULLS LAST,x.id DESC LIMIT ${limit}`,values)).rows;
  const items=rows.slice(0,filter.limit),last=items.at(-1);
  return {items:items.map(row=>{const order=projectAdminReadOrder(row.origin,row.record,{adminId:viewer.adminId,isBoss:viewer.isBoss,internalQuote:false,authorizationKey:viewer.authorizationKey??''});return {orderId:order.id,displayNo:order.displayNo,status:order.status,role:row.role,...(viewer.resourceRead?{accountId:order.accountId,accountDisplayNo:order.accountDisplayNo}:{}),title:order.title,gameId:order.gameId,counterpartyName:row.role==='renter'?order.ownerName:order.renterName,amounts:order.amounts,createdAt:order.createdAt,paidAt:order.paidAt,cancelledAt:order.cancelledAt,holdUntil:order.holdUntil,expiredAwaitingCancel:order.expiredAwaitingCancel,payment:order.payment,source:order.source};}),nextCursor:rows.length>filter.limit&&last?encodeKeysetCursor(key,{sortAt:last.sortAt,id:last.id}):null,limit:filter.limit};
}

/** User-object audit history for the directory takeover: operations and migration facts on one user. */
export const USER_AUDIT_OBJECT_TYPES = ["user", "user_account", "user_identity_state", "user_rental_membership"] as const;

type UserAuditRow = {
  id: string;
  actorType: string;
  actorAdminUsername: string | null;
  actorAdminDisplayUsername: string | null;
  actorAdminName: string | null;
  actorUserName: string | null;
  action: string;
  objectType: string;
  objectId: string | null;
  outcome: string;
  reason: string | null;
  requestId: string | null;
  occurredAt: string;
  details: Record<string, unknown>;
};

export async function listUserAuditEvents(
  client: PoolClient,
  viewer: AdminDirectoryViewer,
  userId: string,
  page: { limit: number; cursor?: string },
  sanitizeDetail: (value: unknown) => unknown,
): Promise<Record<string, unknown>> {
  if (!viewer.auditRead) throw forbidden("Audit reading requires admin.audit.read");
  const filterKey = sha256Hex(
    JSON.stringify({ scope: "admin-user-audit", principal: viewer.adminId, isBoss: viewer.isBoss, authorizationKey: viewer.authorizationKey ?? null, userId, limit: page.limit }),
  );
  const cursor = parseKeysetCursor(page.cursor, filterKey);
  const values: unknown[] = [userId, [...USER_AUDIT_OBJECT_TYPES]];
  const conditions = [`e.object_id = $1`, `e.object_type = ANY($2::text[])`, `e.actor_type IN ('admin', 'user', 'system')`];
  if (!viewer.isBoss) {
    conditions.push(`e.actor_type = 'admin' AND e.actor_id = $${values.push(viewer.adminId)}`);
  }
  values.push(cursor?.createdAt ?? null, cursor?.id ?? null, page.limit + 1);
  const cursorTime = values.length - 2;
  const cursorId = values.length - 1;
  const limitParameter = values.length;
  conditions.push(`($${cursorTime}::timestamptz IS NULL OR e.occurred_at < $${cursorTime}::timestamptz OR (e.occurred_at = $${cursorTime}::timestamptz AND e.id < $${cursorId}))`);
  const rows = (
    await client.query<UserAuditRow>(
      `SELECT e.id, e.actor_type AS "actorType",
              admin_u.username AS "actorAdminUsername", admin_u."displayUsername" AS "actorAdminDisplayUsername", admin_u.name AS "actorAdminName",
              user_u.name AS "actorUserName",
              e.action, e.object_type AS "objectType", e.object_id AS "objectId", e.outcome, e.reason,
              e.request_id AS "requestId",
              to_char(e.occurred_at ${TIMESTAMP_TEXT}) AS "occurredAt",
              e.details
         FROM zzsh_iam.audit_event e
         LEFT JOIN zzsh_auth_admin."user" admin_u ON e.actor_type = 'admin' AND admin_u.id = e.actor_id
         LEFT JOIN zzsh_auth_user."user" user_u ON e.actor_type = 'user' AND user_u.id = e.actor_id
        WHERE ${conditions.join(" AND ")}
        ORDER BY e.occurred_at DESC, e.id DESC
        LIMIT $${limitParameter}`,
      values,
    )
  ).rows;
  const items = rows.slice(0, page.limit);
  const hasMore = rows.length > page.limit;
  const last = items.at(-1);
  return {
    items: items.map((row) => ({
      eventId: row.id,
      actorType: row.actorType,
      actor: row.actorType === "admin"
        ? { username: row.actorAdminUsername ?? "未知管理员", displayUsername: row.actorAdminDisplayUsername ?? row.actorAdminUsername ?? "未知管理员", name: row.actorAdminName ?? "未知管理员" }
        : row.actorType === "user"
          ? { username: null, displayUsername: null, name: row.actorUserName ?? "用户本人" }
          : { username: null, displayUsername: null, name: "系统" },
      action: row.action,
      objectType: row.objectType,
      objectId: row.objectId,
      outcome: row.outcome,
      reason: row.reason,
      requestId: row.requestId,
      occurredAt: row.occurredAt,
      details: sanitizeDetail(row.details),
    })),
    nextCursor: hasMore && last ? encodeKeysetCursor(filterKey, { sortAt: last.occurredAt, id: last.id }) : null,
    limit: page.limit,
  };
}
