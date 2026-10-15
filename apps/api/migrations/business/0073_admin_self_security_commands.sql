-- 管理员本人安全命令身份与备份码代次；原始命令身份保留用于防重放。
CREATE TABLE "zzsh_iam"."admin_security_command" (
  "admin_user_id"   text        NOT NULL,
  "command_id"      text        NOT NULL,          -- Idempotency-Key，格式同 API_V1_TOKEN_PATTERN
  "action"          text        NOT NULL,
  "target_kind"     text        NOT NULL,          -- session（PIN）| credential（改密/备份码）
  "target_id"       text        NOT NULL,
  "fingerprint"     text        NOT NULL,          -- HKDF+HMAC 输出；不含可离线枚举的低熵明文
  "status"          text        NOT NULL,          -- completed | rejected
  "reason"          text,                          -- 受控原因枚举
  "result"          jsonb,                         -- 非敏感结果（无密码/PIN/备份码明文/token）
  "rejection"       jsonb,                         -- {status, code, message, reason} 供重放原样复现
  "request_id"      text,
  "created_at"      timestamptz NOT NULL DEFAULT clock_timestamp(),
  "retention_until" timestamptz NOT NULL,          -- created_at + 7 天；只驱动读取投影
  CONSTRAINT "admin_security_command_pkey" PRIMARY KEY ("admin_user_id", "command_id"),
  CONSTRAINT "admin_security_command_status_ck" CHECK ("status" IN ('completed', 'rejected')),
  CONSTRAINT "admin_security_command_action_ck"
    CHECK ("action" IN ('password.change', 'pin.set', 'pin.change', 'backup-codes.generate')),
  CONSTRAINT "admin_security_command_target_kind_ck" CHECK ("target_kind" IN ('session', 'credential')),
  CONSTRAINT "admin_security_command_fingerprint_ck" CHECK ("fingerprint" ~ '^[0-9a-f]{64}$')
);
--> statement-breakpoint
CREATE TABLE "zzsh_iam"."admin_backup_code_generation" (
  "admin_user_id" text PRIMARY KEY,
  "generation" integer NOT NULL CHECK ("generation" > 0),
  "generation_id" text NOT NULL,
  "generated_at" timestamptz NOT NULL
);
