import type { PoolClient } from "pg";

import { gameScopeSql } from "./admin-scope";
import { invalid } from "../supply/supply-util";
import { orderReadRelation } from "../order/admin-order-read";
import { legacyContinuationReady } from "../order/legacy-order-read";
import { readUserDirectoryBusinessSummaries } from "./user-directory-business-summary";
import { DIRECTORY_WALLET_PERMISSION, readUserDirectoryWalletSummaries } from "./user-directory-wallet";
import { maskPhoneNumber } from "./user-directory-summary";
import { managedProfileImagePath } from "../profile/profile-avatar";
import { pgIdentityDisplayStore, readIdentityDisplay } from "./identity-display";
import {
  LEGACY_MIGRATION_ACTION,
  LEGACY_PROVIDER,
  RISK_FLAG_JOIN,
  TIMESTAMP_TEXT,
  USER_DIRECTORY_SOURCE,
  legacyIdFromReference,
  maskEmail,
  originalRegistrationSql,
  projectRelationshipSummaries,
  projectUserAccountStatus,
  resourceCountsSql,
  sourceKindOf,
  type AdminDirectoryViewer,
} from "./user-directory-list";

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
  riskFlag: boolean;
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
  const detailOrderRelation = orderRead && viewer.legacyRead ? orderReadRelation(await legacyContinuationReady(client), true, { participantUserId: '$1' }) : null;
  const legacyMarketIds = viewer.legacyMarketAccountIds?.length ? viewer.legacyMarketAccountIds : undefined;
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
              CASE WHEN $5::boolean THEN current_orders.owner_count ELSE NULL END AS "ownerCurrentOrderCount",
              COALESCE(risk_flag.flagged,false) AS "riskFlag", COALESCE(risk_flag.revision,0) AS "riskRevision"
         FROM zzsh_auth_user."user" u
         LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id = u.id
         ${RISK_FLAG_JOIN}
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
           SELECT fact.user_id AS object_id,fact.legacy_id,fact.registered_at
           FROM zzsh_iam.user_registration_fact fact WHERE fact.user_id=u.id
         ) registration_mig ON true
         LEFT JOIN LATERAL (SELECT ${originalRegistrationSql("registration_mig", true)} AS registered_at) registration ON true` : ""}
         ${resourceCountsSql("$4", "$2", "$3", legacyMarketIds ? "$6" : undefined)}
         LEFT JOIN LATERAL (
           SELECT count(*)::int AS current_count,
                  count(*) FILTER (WHERE o.renter_user_id=u.id)::int AS renter_count,
                  count(*) FILTER (WHERE o.owner_user_id=u.id)::int AS owner_count
             FROM ${detailOrderRelation ? "("+detailOrderRelation+")" : "zzsh_order.rental_order"} o
            WHERE $5::boolean AND (o.renter_user_id=u.id OR o.owner_user_id=u.id)
              AND o.status IN ('PENDING_PAYMENT','PAID') AND ${gameScopeSql("o.game_id","$3","$2")}
         ) current_orders ON true
        WHERE u.id = $1`,
      [userId, viewer.isBoss, viewer.adminId, resourceRead, orderRead, ...(legacyMarketIds ? [legacyMarketIds] : [])],
    )
  ).rows[0];
  if (!row) return null;
  const legacyId = row.migrationLegacyId ?? legacyIdFromReference(row.provider, row.providerReference);
  const source = sourceKindOf(row.migrationLegacyId, row.provider, row.accountStatus !== null);
  const registeredAt = original ? row.originalRegisteredAt ?? null : row.localCreatedAt;
  const summaries = await readUserDirectoryBusinessSummaries(client, viewer, [userId]);
  const wallets = await readUserDirectoryWalletSummaries(client, { walletRead: viewer.walletRead === true }, [userId]);
  const identityDisplay = await readIdentityDisplay(pgIdentityDisplayStore(client), userId, row.identityStatus);
  return {
    userId: row.id,
    name: row.name,
    image: managedProfileImagePath(row.image),
    username: row.username,
    displayUsername: row.displayUsername,
    // 客服接待要回拨租客/号主：持有 im.support.read 的岗位在详情里拿明文，
    // 其余读者仍是脱敏值（用户目录列表、财务、监管不变）。
    // 详情路由在只读快照结束后重验权限并提交披露审计，成功后才返回明文。
    maskedPhone: (viewer as { permissions?: ReadonlySet<string> }).permissions?.has("im.support.read")
      ? (row.phoneNumber ?? null)
      : maskPhoneNumber(row.phoneNumber),
    phoneRevealed: (viewer as { permissions?: ReadonlySet<string> }).permissions?.has("im.support.read") === true,
    phoneNumberVerified: row.phoneNumber === null ? null : row.phoneNumberVerified === true,
    maskedEmail: maskEmail(row.email),
    accountStatus: projectUserAccountStatus(row.accountStatus, row.suspended),
    suspended: row.suspended,
    identity: {
      status: row.identityStatus ?? "UNKNOWN",
      ageStatus: row.ageStatus ?? "UNKNOWN",
      provider: row.provider ?? null,
      verifiedAt: row.identityVerifiedAt,
      display: identityDisplay.identityDisplay,
      displayReason: identityDisplay.identityDisplayReason,
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
    riskFlag: row.riskFlag === true,
    riskRevision: (row as UserDetailRow & {riskRevision:number}).riskRevision,
    walletSummary: wallets.get(userId) ?? { state: "denied", permission: DIRECTORY_WALLET_PERMISSION },
    ...projectRelationshipSummaries(row, viewer),
    ...summaries.get(userId),
    lastBusinessActivity: { state: "not_connected", domains: ["ORDER", "SUPPLY"] },
  };
}
