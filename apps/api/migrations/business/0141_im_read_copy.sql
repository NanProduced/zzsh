-- 供应商会话阅读位置独立于平台打开页面的时间；默认关闭，不保存 AppSecret。
CREATE TABLE "zzsh_iam"."im_read_copy_settings" (
  "app_id" text PRIMARY KEY,
  "version" integer NOT NULL CHECK (version > 0),
  "enabled" boolean NOT NULL DEFAULT false,
  "public_origin" text,
  "updated_by" text NOT NULL REFERENCES "zzsh_iam"."admin_security"("admin_user_id"),
  "operation_id" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "last_verified_at" timestamptz,
  "last_event_at" timestamptz,
  CHECK (NOT enabled OR public_origin IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE "zzsh_iam"."im_read_copy_position" (
  "app_id" text NOT NULL,
  "team_id" text NOT NULL,
  "account_id" text NOT NULL,
  "scope_kind" text NOT NULL CHECK (scope_kind IN ('SUPPORT','ORDER')),
  "scope_id" text NOT NULL,
  "read_message_time" bigint NOT NULL CHECK (read_message_time > 0),
  "received_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (app_id,team_id,account_id)
);
--> statement-breakpoint
INSERT INTO "zzsh_iam"."admin_permission" ("code","name","description") VALUES
  ('im.support.integration.configure','配置客服消息接入','配置会话阅读同步的接收开关和公网域名；不含密钥读取或云信控制台开通')
ON CONFLICT ("code") DO NOTHING;
