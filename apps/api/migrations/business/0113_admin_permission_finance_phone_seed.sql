-- 补种代码已定义、此前未入库的 3 个权限码。只增不改；不授予任何角色或个人。
INSERT INTO zzsh_iam.admin_permission (code, name, description) VALUES
 ('finance.read', '查看资金汇总与账务', '资金查找、期间核对、单用户资金等只读视图；不含任何资金写操作'),
 ('finance.document.read', '查看资金单据', '按单据查看资金凭证与佣金明细；只读'),
 ('user.phone.lookup', '手机号精确查找用户', '在用户目录中按完整手机号精确查找；不展示他人完整手机号列表')
ON CONFLICT (code) DO NOTHING;