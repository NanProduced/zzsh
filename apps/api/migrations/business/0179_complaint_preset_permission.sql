-- 投诉反馈使用独立持久线程；默认只授予运营预设角色。
-- 客服预设角色不再默认包含投诉权限，运营可在管理平台单独配置给指定客服。
INSERT INTO zzsh_iam.admin_permission (code, name, description)
VALUES ('im.support.complaint', '处理投诉反馈', '查看并处理投诉反馈类咨询')
ON CONFLICT (code) DO NOTHING;

DELETE FROM zzsh_iam.admin_role_permission
 WHERE role_id = 'role_preset_support' AND permission_code = 'im.support.complaint';

INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code)
SELECT 'role_preset_ops', 'im.support.complaint'
 WHERE EXISTS (SELECT 1 FROM zzsh_iam.admin_role WHERE id = 'role_preset_ops')
ON CONFLICT (role_id, permission_code) DO NOTHING;
