import type { Pool } from "pg";
import { createHash } from "node:crypto";

export type PasswordSetupQueryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }> };

export type UserPasswordState = "set" | "not-set" | "unavailable";

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
