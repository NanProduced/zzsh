import type { Pool } from "pg";
import { createHash } from "node:crypto";
import { normalizeMainlandPhone } from "./phone-number";
import { legacyOwnerUserId } from "../supply/legacy-user-migration";

export type PasswordSetupQueryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

export type UserPasswordState = "set" | "not-set" | "unavailable";

export type LegacyNumberLoginTarget = Readonly<{ userId: string; username: string; throttleSubject: string }>;

// The system marker is owner-written; old databases and administrator imports retain their original path.
const TRUSTED_LEGACY_USER_SOURCE = `(e.actor_type='admin' OR (e.actor_type='system' AND e.session_id IS NULL
  AND e.action='user.legacy_owner.migrated'
  AND to_jsonb(e)->>'legacy_migration_manifest_sha256' ~ '^[a-f0-9]{64}$'
  AND e.details->>'sourceDatasetSha256'=to_jsonb(e)->>'legacy_migration_manifest_sha256'
  AND e.details->>'migrationRunDigest' ~ '^[a-f0-9]{64}$'
  AND e.actor_id='legacy-user-migration:'||(e.details->>'migrationRunDigest')))`;

/** Only a source-bound public legacy SN. Internal legacy IDs, names and email are never lookup fallbacks. */
export async function resolveLegacyNumberLogin(db: PasswordSetupQueryable | Pool, identifier: string): Promise<LegacyNumberLoginTarget | null> {
  if (typeof identifier !== "string" || identifier !== identifier.trim() || !identifier || identifier.length > 128 || /[\x00-\x1f\x7f]/.test(identifier)) return null;
  const result = await (db as PasswordSetupQueryable).query(`SELECT u.id,u.username,u."phoneNumber" AS phone,
    a.details->>'sourceSystem' AS source_system,a.details->>'sourceEntity' AS source_entity,a.details->>'legacyId' AS legacy_id,
    a.details->>'sourceDigest' AS source_digest,a.details->>'evidenceDigest' AS evidence_digest,
    p.source_sn,p.source_digest AS projection_digest,p.source_system AS projection_system,p.source_entity AS projection_entity,p.legacy_id AS projection_id
    FROM zzsh_auth_user."user" u
    JOIN LATERAL (SELECT e.details FROM zzsh_iam.audit_event e
      WHERE e.object_id=u.id AND e.object_type='user' AND ${TRUSTED_LEGACY_USER_SOURCE} AND e.action='user.legacy_owner.migrated' AND e.outcome='SUCCESS'
        AND e.details->>'sourceSystem'='legacy_mysql_restore' AND e.details->>'sourceEntity'='la_user'
      ORDER BY e.occurred_at,e.id LIMIT 1) a ON true
    JOIN LATERAL (SELECT COALESCE(e.details#>>'{contactProjection,sourceSn}',e.details->>'sourceSn') AS source_sn,
      e.details->>'sourceDigest' AS source_digest,e.details->>'sourceSystem' AS source_system,e.details->>'sourceEntity' AS source_entity,e.details->>'legacyId' AS legacy_id
      FROM zzsh_iam.audit_event e WHERE e.object_id=u.id AND e.object_type='user' AND ${TRUSTED_LEGACY_USER_SOURCE} AND e.outcome='SUCCESS'
        AND e.details->>'sourceDigest'=a.details->>'sourceDigest' AND e.details->>'sourceSystem'=a.details->>'sourceSystem'
        AND e.details->>'sourceEntity'=a.details->>'sourceEntity' AND e.details->>'legacyId'=a.details->>'legacyId'
        AND (e.action='user.legacy_owner.migrated' AND e.details#>>'{contactProjection,sourceSn}'=u.username
          OR e.action IN('user.legacy_contact.projected','user.legacy_number.bound') AND e.details->>'sourceSn'=u.username)
      ORDER BY e.occurred_at DESC,e.id DESC LIMIT 1) p ON true
    WHERE u.username=$1 LIMIT 2`, [identifier]);
  if (result.rows.length !== 1) return null;
  const row=result.rows[0]!;
  if (typeof row.id !== "string" || !row.id || row.username !== identifier || row.source_sn !== identifier
    || row.source_system !== "legacy_mysql_restore" || row.source_entity !== "la_user" || typeof row.legacy_id !== "string" || !/^[1-9][0-9]{0,23}$/.test(row.legacy_id)
    || row.id !== legacyOwnerUserId(row.source_system,row.source_entity,row.legacy_id)
    || !/^[a-f0-9]{64}$/.test(String(row.source_digest)) || !/^[a-f0-9]{64}$/.test(String(row.evidence_digest))
    || row.projection_digest !== row.source_digest || row.projection_system !== row.source_system || row.projection_entity !== row.source_entity || row.projection_id !== row.legacy_id) return null;
  // Existing phone buckets survive this compatibility addition; phone-less aliases share the stable subject.
  const phone=normalizeMainlandPhone(row.phone);
  return Object.freeze({userId:row.id,username:identifier,throttleSubject:phone??`legacy-subject:${row.id}`});
}

/** Migration quarantine is an existing audit fact, never permission to create another subject. */
export async function hasLegacyPhoneConflict(db: PasswordSetupQueryable | Pool, phoneNumber: string): Promise<boolean> {
  const digest = createHash("sha256").update(phoneNumber).digest("hex");
  const result = await (db as PasswordSetupQueryable).query(`SELECT EXISTS (SELECT 1 FROM zzsh_iam.audit_event WHERE object_type='legacy_phone' AND object_id=$1 AND action='user.legacy_phone.quarantined' AND outcome='SUCCESS') AS blocked`, [digest]);
  return result.rows[0]?.blocked === true;
}

/** Capability from stored facts, without requiring a migrated user to replace their password. */
export async function readUserPasswordState(db: PasswordSetupQueryable | Pool, userId: string): Promise<UserPasswordState> {
  const result = await (db as PasswordSetupQueryable).query(
    `SELECT password IS NOT NULL AND password <> '' AS modern,
            "legacyPasswordMd5" IS NOT NULL AND "legacyPasswordMd5" ~ '^[a-f0-9]{32}$'
              AND ("legacyPasswordVersion"='legacy-md5-v0' OR
                   "legacyPasswordVersion"='legacy-md5-v1' AND "legacyPasswordSalt" IS NOT NULL) AS legacy
       FROM zzsh_auth_user.account WHERE "userId"=$1 AND "providerId"='credential'`,
    [userId],
  );
  const row = result.rows[0];
  if (!row) return "not-set";
  return row.modern === true || row.legacy === true ? "set" : "unavailable";
}
