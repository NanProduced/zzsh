-- 管理员认证防爆破（仅管理员 realm）：多实例共享的失败滑动窗口、渐进锁定与 ALTCHA 防重放。
-- subject 仅保存 sha256 摘要（account:/ip:/challenge: 前缀），不落库原始用户名或 IP。
CREATE TABLE IF NOT EXISTS zzsh_iam.admin_auth_failure (
  id bigserial PRIMARY KEY,
  scope text NOT NULL CHECK (scope IN ('sign-in', 'two-factor', 'step-up', 'recovery')),
  subject text NOT NULL CHECK (length(subject) <= 64),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS admin_auth_failure_lookup_idx
  ON zzsh_iam.admin_auth_failure (scope, subject, occurred_at);

CREATE TABLE IF NOT EXISTS zzsh_iam.admin_auth_lockout (
  scope text NOT NULL CHECK (scope IN ('sign-in', 'two-factor', 'step-up', 'recovery')),
  subject text NOT NULL CHECK (length(subject) <= 64),
  level integer NOT NULL CHECK (level BETWEEN 1 AND 16),
  locked_until timestamptz NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope, subject)
);

CREATE TABLE IF NOT EXISTS zzsh_iam.admin_auth_captcha_used (
  signature text PRIMARY KEY CHECK (length(signature) <= 256),
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS admin_auth_captcha_used_expiry_idx
  ON zzsh_iam.admin_auth_captcha_used (expires_at);

REVOKE ALL ON zzsh_iam.admin_auth_failure, zzsh_iam.admin_auth_lockout, zzsh_iam.admin_auth_captcha_used FROM PUBLIC;
