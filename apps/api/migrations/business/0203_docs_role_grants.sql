-- P1a internal documentation library preset grants (provisional number, Master to finalize).
-- Additive only; mirrors the 0114 shape. Support reads and comments; ops also
-- manages. Boss is an is_boss bypass and is not seeded here. Existing grants are
-- skipped so later Boss edits and personal DENY remain effective.
INSERT INTO "zzsh_iam"."admin_role_permission" ("role_id", "permission_code")
SELECT v."role_id", v."permission_code"
  FROM (VALUES
 ('role_preset_support', 'docs.internal.read'),
 ('role_preset_support', 'docs.internal.comment'),
 ('role_preset_ops', 'docs.internal.read'),
 ('role_preset_ops', 'docs.internal.comment'),
 ('role_preset_ops', 'docs.internal.manage')
  ) AS v(role_id, permission_code)
  JOIN "zzsh_iam"."admin_role" r ON r."id" = v."role_id"
ON CONFLICT ("role_id", "permission_code") DO NOTHING;