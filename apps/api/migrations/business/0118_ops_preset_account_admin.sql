-- 运营预设追加管理员账号日常维护与敏感身份查看（Owner 2026-10-31；来源 OPS_PRESET_0118_ADDITIONS）。
-- 服务端护栏：非 Boss 不能以 Boss 账号或自己为目标；创建受 assertDelegable 约束，附带授权仍需 admin.permission.grant（仅 Boss）。
-- 只增不删、可重复执行；角色不存在则跳过。
INSERT INTO zzsh_iam.admin_role_permission (role_id, permission_code)
SELECT v.role_id, v.permission_code
  FROM (VALUES
 ('role_preset_ops', 'admin.account.create'),
 ('role_preset_ops', 'admin.account.update'),
 ('role_preset_ops', 'admin.account.freeze'),
 ('role_preset_ops', 'admin.account.unfreeze'),
 ('role_preset_ops', 'user.identity.sensitive.read')
  ) AS v(role_id, permission_code)
  JOIN zzsh_iam.admin_role r ON r.id = v.role_id
ON CONFLICT (role_id, permission_code) DO NOTHING;
