INSERT INTO "zzsh_iam"."admin_permission" ("code", "name", "description") VALUES
  ('user.account.restore', '恢复停用用户账号', '仅将 DEACTIVATED 用户恢复为 ACTIVE；不恢复旧会话或验证凭据，不可恢复 CANCELLED')
ON CONFLICT ("code") DO NOTHING;
