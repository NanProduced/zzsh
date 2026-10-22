INSERT INTO zzsh_iam.admin_permission (code, name, description) VALUES
 ('user.finance.read', '查看单用户资金', '只读查看授权用户的余额与按游戏范围裁剪的结算消费明细；不授予平台财务、内价或任何资金命令')
ON CONFLICT (code) DO NOTHING;
