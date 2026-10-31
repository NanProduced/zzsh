-- 管理员可自助选择「登录时是否验证 2FA」。默认 true（与现状一致）。
-- 只影响登录挑战；敏感操作的当场再验证（密码 + 动态码）不受此列影响。
ALTER TABLE zzsh_iam.admin_security
  ADD COLUMN IF NOT EXISTS login_two_factor_required boolean NOT NULL DEFAULT true;
