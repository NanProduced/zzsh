-- 独立的助手文案配置；不复用内容发布、资金策略或个人设置存储。
CREATE TABLE "zzsh_iam"."im_support_settings" (
  "app_id" text PRIMARY KEY,
  "version" integer NOT NULL CHECK ("version" > 0),
  "service_message" text NOT NULL CHECK (length("service_message") BETWEEN 1 AND 1000 AND octet_length("service_message") <= 3000),
  "complaint_message" text NOT NULL CHECK (length("complaint_message") BETWEEN 1 AND 1000 AND octet_length("complaint_message") <= 3000),
  "updated_by" text NOT NULL REFERENCES "zzsh_iam"."admin_security"("admin_user_id"),
  "operation_id" text NOT NULL,
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
INSERT INTO "zzsh_iam"."admin_permission" ("code","name","description") VALUES
 ('im.support.configure','配置洲洲助手','修改新咨询轮次的欢迎消息；不含分销策略、返利计算或到账确认')
ON CONFLICT ("code") DO NOTHING;
