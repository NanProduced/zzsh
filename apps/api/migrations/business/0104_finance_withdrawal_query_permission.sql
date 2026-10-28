INSERT INTO zzsh_iam.admin_permission (code, name, description) VALUES
 ('finance.withdrawal.query', '同步提现渠道结果', '只查询已派发原提现的渠道结果，可按可信终态推进本站扣账或释放；不含新发提现/代付、重发、换收款目标或强制成功')
ON CONFLICT (code) DO NOTHING;