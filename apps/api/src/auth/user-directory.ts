import type { PoolClient } from "pg";

import { conflict, forbidden, sha256Hex } from "../supply/supply-util";
import { escapeLike } from "../supply/catalog";
import { isEffectivePublicationState } from "../supply/listing-query";

export const USER_DIRECTORY_SOURCE = {
  LOCAL: "LOCAL",
  MIGRATED: "MIGRATED",
  UNKNOWN: "UNKNOWN",
} as const;
export type UserDirectorySource = (typeof USER_DIRECTORY_SOURCE)[keyof typeof USER_DIRECTORY_SOURCE];

export const USER_DIRECTORY_STATUS_FILTER = ["ACTIVE", "RESTRICTED", "DEACTIVATED", "CANCELLED", "UNKNOWN"] as const;
export type UserDirectoryStatusFilter = (typeof USER_DIRECTORY_STATUS_FILTER)[number];

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

type KeysetCursor = { createdAt: string; id: string };

function parseKeysetCursor(cursor: string | undefined, filterKey: string): KeysetCursor | null {
  if (cursor === undefined) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString()) as { f?: unknown; c?: unknown; i?: unknown };
    if (
      parsed.f !== filterKey ||
      typeof parsed.c !== "string" ||
      !CURSOR_TIME_PATTERN.test(parsed.c) ||
      typeof parsed.i !== "string" ||
      !CURSOR_ID_PATTERN.test(parsed.i)
    ) {
      throw new Error("mismatch");
    }
    return { createdAt: parsed.c, id: parsed.i };
  } catch {
    throw conflict("Cursor is invalid");
  }
}

function encodeKeysetCursor(filterKey: string, row: { sortAt: string; id: string }): string {
  return Buffer.from(JSON.stringify({ f: filterKey, c: row.sortAt, i: row.id })).toString("base64url");
}

export type AdminDirectoryViewer = {
  adminId: string;
  isBoss: boolean;
  phoneLookup: boolean;
  resourceRead?: boolean;
  orderRead?: boolean;
  auditRead?: boolean;
  authorizationKey?: string;
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
  limit: number;
  cursor?: string;
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
  accountStatus: string | null;
  identityStatus: string | null;
  provider: string | null;
  providerReference: string | null;
  migrationLegacyId: string | null;
  migrationSourceCreatedAt: string | null;
  resourceAccountCount: number;
  currentOrderCount: number;
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
const SOURCE_SQL = `CASE WHEN s.provider='${LEGACY_PROVIDER}' THEN 'MIGRATED'
  WHEN s.user_id IS NOT NULL AND s.provider='none' AND mig.legacy_id IS NULL THEN 'LOCAL' ELSE 'UNKNOWN' END`;

function projectListItem(row: UserListRow, viewer: AdminDirectoryViewer) {
  const legacyId = row.migrationLegacyId ?? legacyIdFromReference(row.provider, row.providerReference);
  const source = sourceKindOf(row.migrationLegacyId, row.provider, row.accountStatus !== null);
  const registeredAt = row.localCreatedAt;
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
    registeredAtSource: "LOCAL",
    createdAt: row.localCreatedAt,
    updatedAt: row.localUpdatedAt,
    localCreatedAt: row.localCreatedAt,
    resourceSummary: viewer.resourceRead ? { state: "ready", count: row.resourceAccountCount } : { state: "denied", permission: "supply.rental_account.read" },
    orderSummary: viewer.orderRead ? { state: "ready", currentCount: row.currentOrderCount } : { state: "denied", permission: "order.read" },
    lastBusinessActivity: { state: "not_connected", domains: ["ORDER", "SUPPLY"] },
  };
}

const MIGRATION_LATERAL = `
  LEFT JOIN LATERAL (
    SELECT e.details->>'legacyId' AS legacy_id,
           e.details->>'sourceSystem' AS source_system,
           e.details->>'sourceCreatedAt' AS source_created_at
      FROM zzsh_iam.audit_event e
     WHERE e.action = '${LEGACY_MIGRATION_ACTION}' AND e.object_type = 'user' AND e.object_id = u.id
     ORDER BY e.occurred_at DESC, e.id DESC
     LIMIT 1
  ) mig ON true`;

export async function listUserDirectory(
  client: PoolClient,
  viewer: AdminDirectoryViewer,
  filter: UserDirectoryFilter,
): Promise<Record<string, unknown>> {
  const filterKey = sha256Hex(
    JSON.stringify({
      scope: "admin-user-directory",
      principal: viewer.adminId,
      phoneLookup: viewer.phoneLookup,
      isBoss: viewer.isBoss,
      authorizationKey: viewer.authorizationKey ?? null,
      resourceRead: viewer.resourceRead === true,
      orderRead: viewer.orderRead === true,
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
    }),
  );
  const cursor = parseKeysetCursor(filter.cursor, filterKey);

  const values: unknown[] = [viewer.isBoss, viewer.adminId, viewer.resourceRead === true, viewer.orderRead === true];
  const conditions: string[] = [];
  if (filter.userId) conditions.push(`u.id = $${values.push(filter.userId)}`);
  if (filter.legacyId) {
    const parameter = values.push(filter.legacyId);
    conditions.push(`(mig.legacy_id = $${parameter} OR (s.provider = '${LEGACY_PROVIDER}' AND substring(s.provider_reference from position(':' in s.provider_reference) + 1) = $${parameter}))`);
  }
  if (filter.identifier) {
    const parameter = values.push(`%${escapeLike(filter.identifier)}%`);
    conditions.push(`(u.name ILIKE $${parameter} ESCAPE '\\' OR u.username ILIKE $${parameter} ESCAPE '\\' OR u."displayUsername" ILIKE $${parameter} ESCAPE '\\')`);
  }
  if (filter.search) {
    const exact = values.push(filter.search);
    const like = values.push(`%${escapeLike(filter.search)}%`);
    conditions.push(`(u.id=$${exact} OR mig.legacy_id=$${exact} OR (s.provider='${LEGACY_PROVIDER}' AND substring(s.provider_reference from position(':' in s.provider_reference)+1)=$${exact}) OR u.name ILIKE $${like} ESCAPE '\\' OR u.username ILIKE $${like} ESCAPE '\\' OR u."displayUsername" ILIKE $${like} ESCAPE '\\')`);
  }
  if (filter.phone) conditions.push(`u."phoneNumber" = $${values.push(filter.phone)}`);
  if (filter.accountStatus) conditions.push(`(${ACCOUNT_STATUS_SQL})=$${values.push(filter.accountStatus)}`);
  if (filter.source) conditions.push(`(${SOURCE_SQL})=$${values.push(filter.source)}`);
  if (filter.identityStatus) conditions.push(`COALESCE(s.identity_status,'UNKNOWN')=$${values.push(filter.identityStatus)}`);
  if (filter.ageStatus) conditions.push(`COALESCE(s.age_status,'UNKNOWN')=$${values.push(filter.ageStatus)}`);
  if (filter.registeredFrom) {
    conditions.push(`u."createdAt" >= $${values.push(filter.registeredFrom)}::timestamptz`);
  }
  if (filter.registeredTo) {
    conditions.push(`u."createdAt" <= $${values.push(filter.registeredTo)}::timestamptz`);
  }
  values.push(cursor?.createdAt ?? null, cursor?.id ?? null, filter.limit + 1);
  const cursorTime = values.length - 2;
  const cursorId = values.length - 1;
  const limitParameter = values.length;
  conditions.push(`($${cursorTime}::timestamptz IS NULL OR u."createdAt" < $${cursorTime}::timestamptz OR (u."createdAt" = $${cursorTime}::timestamptz AND u.id < $${cursorId}))`);

  const rows = (
    await client.query<UserListRow>(
      `SELECT u.id, u.name, u.image, u.username, u."displayUsername", u."phoneNumber", u.suspended,
              to_char(u."createdAt" ${TIMESTAMP_TEXT}) AS "localCreatedAt",
              to_char(u."updatedAt" ${TIMESTAMP_TEXT}) AS "localUpdatedAt", s.age_status AS "ageStatus",
              s.account_status AS "accountStatus", s.identity_status AS "identityStatus",
              s.provider, s.provider_reference AS "providerReference",
              mig.legacy_id AS "migrationLegacyId", mig.source_created_at AS "migrationSourceCreatedAt",
              CASE WHEN $3::boolean THEN (SELECT count(*)::int FROM zzsh_supply.rental_account ra
                WHERE ra.owner_user_id = u.id
                  AND ($1::boolean OR EXISTS (
                    SELECT 1 FROM zzsh_supply.admin_supply_scope sc
                     WHERE sc.admin_user_id = $2 AND sc.game_id = ra.game_id))) ELSE NULL END AS "resourceAccountCount",
              CASE WHEN $4::boolean THEN (SELECT count(*)::int FROM zzsh_order.rental_order o
                WHERE (o.renter_user_id=u.id OR o.owner_user_id=u.id) AND o.status IN ('PENDING_PAYMENT','PAID')
                  AND ($1::boolean OR EXISTS (SELECT 1 FROM zzsh_supply.admin_supply_scope sc WHERE sc.admin_user_id=$2 AND sc.game_id=o.game_id))) ELSE NULL END AS "currentOrderCount"
         FROM zzsh_auth_user."user" u
         LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id = u.id
         ${MIGRATION_LATERAL}
        WHERE ${conditions.join(" AND ")}
        ORDER BY u."createdAt" DESC, u.id DESC
        LIMIT $${limitParameter}`,
      values,
    )
  ).rows;
  const items = rows.slice(0, filter.limit);
  const hasMore = rows.length > filter.limit;
  const last = items.at(-1);
  return {
    items: items.map(row => projectListItem(row, viewer)),
    nextCursor: hasMore && last ? encodeKeysetCursor(filterKey, { sortAt: last.localCreatedAt, id: last.id }) : null,
    limit: filter.limit,
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
  currentOrderCount: number;
};

export async function readUserDirectoryDetail(
  client: PoolClient,
  viewer: AdminDirectoryViewer,
  userId: string,
): Promise<Record<string, unknown> | null> {
  const row = (
    await client.query<UserDetailRow>(
      `SELECT u.id, u.name, u.image, u.username, u."displayUsername", u."phoneNumber", u."phoneNumberVerified",
              u.email, u.suspended,
              to_char(u."createdAt" ${TIMESTAMP_TEXT}) AS "localCreatedAt",
              to_char(u."updatedAt" ${TIMESTAMP_TEXT}) AS "localUpdatedAt",
              s.account_status AS "accountStatus", s.identity_status AS "identityStatus", s.age_status AS "ageStatus",
              s.provider, s.provider_reference AS "providerReference",
              to_char(s.verified_at ${TIMESTAMP_TEXT}) AS "identityVerifiedAt",
              mig.legacy_id AS "migrationLegacyId", mig.source_system AS "migrationSourceSystem",
              mig.source_entity AS "migrationSourceEntity", mig.source_created_at AS "migrationSourceCreatedAt",
              mig.source_updated_at AS "migrationSourceUpdatedAt", mig.source_digest AS "migrationSourceDigest",
              mig.evidence_ref AS "migrationEvidenceRef", mig.migrated_at AS "migratedAt",
              CASE WHEN $4::boolean THEN (SELECT count(*)::int FROM zzsh_supply.rental_account ra
                WHERE ra.owner_user_id = u.id
                  AND ($2::boolean OR EXISTS (
                    SELECT 1 FROM zzsh_supply.admin_supply_scope sc
                     WHERE sc.admin_user_id = $3 AND sc.game_id = ra.game_id))) ELSE NULL END AS "resourceAccountCount",
              CASE WHEN $5::boolean THEN (SELECT count(*)::int FROM zzsh_order.rental_order o
                WHERE (o.renter_user_id=u.id OR o.owner_user_id=u.id) AND o.status IN ('PENDING_PAYMENT','PAID')
                  AND ($2::boolean OR EXISTS (SELECT 1 FROM zzsh_supply.admin_supply_scope sc WHERE sc.admin_user_id=$3 AND sc.game_id=o.game_id))) ELSE NULL END AS "currentOrderCount"
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
        WHERE u.id = $1`,
      [userId, viewer.isBoss, viewer.adminId, viewer.resourceRead === true, viewer.orderRead === true],
    )
  ).rows[0];
  if (!row) return null;
  const legacyId = row.migrationLegacyId ?? legacyIdFromReference(row.provider, row.providerReference);
  const source = sourceKindOf(row.migrationLegacyId, row.provider, row.accountStatus !== null);
  const registeredAt = row.localCreatedAt;
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
    registeredAtSource: "LOCAL",
    createdAt: row.localCreatedAt,
    updatedAt: row.localUpdatedAt,
    localCreatedAt: row.localCreatedAt,
    localUpdatedAt: row.localUpdatedAt,
    resourceSummary: viewer.resourceRead ? { state: "ready", count: row.resourceAccountCount } : { state: "denied", permission: "supply.rental_account.read" },
    orderSummary: viewer.orderRead ? { state: "ready", currentCount: row.currentOrderCount } : { state: "denied", permission: "order.read" },
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
  page: { limit: number; cursor?: string },
): Promise<Record<string, unknown>> {
  if (!viewer.resourceRead) throw forbidden("Resource reading requires supply.rental_account.read");
  const filterKey = sha256Hex(
    JSON.stringify({ scope: "admin-user-rental-accounts", principal: viewer.adminId, isBoss: viewer.isBoss, authorizationKey: viewer.authorizationKey ?? null, userId, limit: page.limit }),
  );
  const cursor = parseKeysetCursor(page.cursor, filterKey);
  const rows = (
    await client.query<UserRentalAccountRow>(
      `SELECT a.id, a.display_no AS "displayNo", a.lifecycle, a.owner_paused AS "ownerPaused",
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
          AND ($2::boolean OR EXISTS (
            SELECT 1 FROM zzsh_supply.admin_supply_scope sc
             WHERE sc.admin_user_id = $3 AND sc.game_id = a.game_id))
          AND ($4::timestamptz IS NULL OR a.created_at < $4::timestamptz OR (a.created_at = $4::timestamptz AND a.id < $5))
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT $6`,
      [userId, viewer.isBoss, viewer.adminId, cursor?.createdAt ?? null, cursor?.id ?? null, page.limit + 1],
    )
  ).rows;
  const items = rows.slice(0, page.limit);
  const hasMore = rows.length > page.limit;
  const last = items.at(-1);
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
        versionPublished: isEffectivePublicationState(row.versionState, row.publicationSource) },
      createdAt: row.createdAt,
    })),
    nextCursor: hasMore && last ? encodeKeysetCursor(filterKey, { sortAt: last.createdAt, id: last.id }) : null,
    limit: page.limit,
  };
}

const USER_ORDER_ROLES = ["renter", "owner", "any"] as const;
export type UserOrderRole = (typeof USER_ORDER_ROLES)[number];

export type UserOrderFilter = {
  role?: UserOrderRole;
  status?: "PENDING_PAYMENT" | "PAID" | "COMPLETED" | "CANCELLED";
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
    `($2::boolean OR EXISTS (
       SELECT 1 FROM zzsh_supply.admin_supply_scope sc
        WHERE sc.admin_user_id = $3 AND sc.game_id = o.game_id))`,
  ];
  if (filter.role === "renter") conditions.push(`o.renter_user_id = $1`);
  if (filter.role === "owner") conditions.push(`o.owner_user_id = $1`);
  if (filter.status) conditions.push(`o.status = $${values.push(filter.status)}`);
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
