-- 运营预设角色：客服管理查看、全部会话巡视、咨询接管与必要的接待权限。
-- 不授予订单、资金、用户、管理员写权限。
INSERT INTO "zzsh_iam"."admin_role_permission" ("role_id", "permission_code")
SELECT 'role_preset_ops', permission_code
  FROM (VALUES
    ('im.support.read'),
    ('im.support.accept'),
    ('im.support.complaint'),
    ('im.support.transfer'),
    ('im.support.presence'),
    ('im.support.management.read'),
    ('im.support.audit.takeover')
  ) AS grants(permission_code)
 WHERE EXISTS (SELECT 1 FROM "zzsh_iam"."admin_role" WHERE "id" = 'role_preset_ops')
ON CONFLICT ("role_id", "permission_code") DO NOTHING;
