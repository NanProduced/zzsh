import type { Pool } from "pg";

export type PasswordSetupQueryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

/**
 * Server-side state for the migrated-user first login: only a user who really
 * had a legacy password (preserved as an unusable md5 credential) is prompted to
 * set a new one. Users without a legacy password keep signing in by OTP and are
 * never told they have a password they do not have. Derived from stored facts only.
 */
export async function readPasswordSetupRequired(db: PasswordSetupQueryable | Pool, userId: string): Promise<boolean> {
  const result = await (db as PasswordSetupQueryable).query(
    `SELECT EXISTS (SELECT 1 FROM "zzsh_iam"."audit_event" m
                    WHERE m."object_type"='user' AND m."object_id"=u."id"
                      AND m."action"='user.legacy_owner.migrated' AND m."outcome"='SUCCESS'
                      AND m."details"->>'sourceSystem'='legacy_mysql_restore'
                      AND m."details"->>'sourceEntity'='la_user') AS "migrated",
            EXISTS (SELECT 1 FROM "zzsh_auth_user"."account" a
                     WHERE a."userId" = $1 AND a."providerId" = 'credential'
                       AND a."password" IS NULL AND a."legacyPasswordMd5" IS NOT NULL) AS "legacyCredential"
       FROM "zzsh_auth_user"."user" u
      WHERE u."id" = $1`,
    [userId],
  );
  const row = result.rows[0];
  if (!row || row.migrated !== true) return false;
  return row.legacyCredential === true;
}
