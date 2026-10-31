-- 管理员会话「最近活跃」时间（设备与会话页）。由会话快照节流写入（≥5 分钟一次）。
-- 只加可空列、可重复执行；未应用时 API 自动回退为 null，不影响登录与会话列表。
ALTER TABLE "zzsh_auth_admin"."session" ADD COLUMN IF NOT EXISTS "last_active_at" timestamptz;
