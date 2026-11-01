-- Candidate only. Review dry-run.sql first, then run this in an explicitly
-- approved window. It ends with ROLLBACK so an accidental execution changes
-- nothing; replace the final ROLLBACK with COMMIT only after verifying counts.
BEGIN;
CREATE TEMP TABLE profile_avatar_backfill_candidates ON COMMIT DROP AS
SELECT 'user'::text AS realm, u."id" AS subject_id,
       (ARRAY['avatar-strike','avatar-night','avatar-frost','avatar-aurora'])[1 + get_byte(sha256(convert_to('user:' || u."id", 'UTF8')), 3) % 4] AS preset_id
  FROM "zzsh_auth_user"."user" u
 WHERE u."image" IS NULL
   AND NOT EXISTS (SELECT 1 FROM "zzsh_supply"."profile_avatar" p WHERE p."realm" = 'user' AND p."subject_id" = u."id")
UNION ALL
SELECT 'admin'::text AS realm, a."id" AS subject_id,
       (ARRAY['avatar-strike','avatar-night','avatar-frost','avatar-aurora'])[1 + get_byte(sha256(convert_to('admin:' || a."id", 'UTF8')), 3) % 4] AS preset_id
  FROM "zzsh_auth_admin"."user" a
 WHERE a."image" IS NULL
   AND NOT EXISTS (SELECT 1 FROM "zzsh_supply"."profile_avatar" p WHERE p."realm" = 'admin' AND p."subject_id" = a."id");

INSERT INTO "zzsh_supply"."profile_avatar"
  ("realm", "subject_id", "default_preset_id", "current_kind", "current_preset_id", "revision", "current_version")
SELECT "realm", "subject_id", "preset_id", 'DEFAULT', "preset_id", 1, 1
  FROM profile_avatar_backfill_candidates
ON CONFLICT ("realm", "subject_id") DO NOTHING;

UPDATE "zzsh_auth_user"."user" u
   SET "image" = '/api/v1/profile/avatars/user/' || u."id" || '/1', "updatedAt" = clock_timestamp()
  FROM profile_avatar_backfill_candidates c
 WHERE c."realm" = 'user' AND c."subject_id" = u."id" AND u."image" IS NULL;

UPDATE "zzsh_auth_admin"."user" a
   SET "image" = '/api/v1/profile/avatars/admin/' || a."id" || '/1', "updatedAt" = clock_timestamp()
  FROM profile_avatar_backfill_candidates c
 WHERE c."realm" = 'admin' AND c."subject_id" = a."id" AND a."image" IS NULL;

SELECT c."realm", count(*) AS backfilled
  FROM profile_avatar_backfill_candidates c
  JOIN "zzsh_supply"."profile_avatar" p ON p."realm" = c."realm" AND p."subject_id" = c."subject_id"
 GROUP BY c."realm" ORDER BY c."realm";

ROLLBACK;
