-- Candidate only: do not install as a business migration.
-- Dry-run: count the empty-avatar subjects that would receive a persisted default.
SELECT 'user' AS realm, count(*) AS candidates
  FROM "zzsh_auth_user"."user" u
 WHERE u."image" IS NULL
   AND NOT EXISTS (SELECT 1 FROM "zzsh_supply"."profile_avatar" p WHERE p."realm" = 'user' AND p."subject_id" = u."id")
UNION ALL
SELECT 'admin' AS realm, count(*) AS candidates
  FROM "zzsh_auth_admin"."user" a
 WHERE a."image" IS NULL
   AND NOT EXISTS (SELECT 1 FROM "zzsh_supply"."profile_avatar" p WHERE p."realm" = 'admin' AND p."subject_id" = a."id");

-- Dry-run: show the deterministic default each candidate would receive.
SELECT 'user' AS realm, u."id" AS subject_id,
       (ARRAY['avatar-strike','avatar-night','avatar-frost','avatar-aurora'])[1 + get_byte(decode(md5('user:' || u."id"), 'hex'), 0) % 4] AS preset_id
  FROM "zzsh_auth_user"."user" u
 WHERE u."image" IS NULL
   AND NOT EXISTS (SELECT 1 FROM "zzsh_supply"."profile_avatar" p WHERE p."realm" = 'user' AND p."subject_id" = u."id")
UNION ALL
SELECT 'admin' AS realm, a."id" AS subject_id,
       (ARRAY['avatar-strike','avatar-night','avatar-frost','avatar-aurora'])[1 + get_byte(decode(md5('admin:' || a."id"), 'hex'), 0) % 4] AS preset_id
  FROM "zzsh_auth_admin"."user" a
 WHERE a."image" IS NULL
   AND NOT EXISTS (SELECT 1 FROM "zzsh_supply"."profile_avatar" p WHERE p."realm" = 'admin' AND p."subject_id" = a."id")
 ORDER BY realm, subject_id;
