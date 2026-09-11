INSERT INTO "zzsh_iam"."admin_permission" ("code", "name", "description") VALUES
  ('admin.audit.read', '查询账号与权限审计', '读取白名单内的管理员账号、角色、授权与冻结审计')
ON CONFLICT ("code") DO NOTHING;
