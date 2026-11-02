-- 分销看板使用独立读取权限，不授予资金账本、政策维护或全局关系的额外权限。
-- 仅登记权限目录；既有角色和个人授权保持，由具备授权管理权限的管理员另行配置。
INSERT INTO "zzsh_iam"."admin_permission" ("code", "name", "description")
VALUES ('distribution.dashboard.read', '读取分销看板', '按游戏范围读取分销汇总、佣金明细、分销商及排行；不包含内部计佣基数或资金操作')
ON CONFLICT ("code") DO NOTHING;
