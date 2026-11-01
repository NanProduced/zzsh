-- CS-M1：客服接线区间与简单交接记录。
-- 只新增可验证的少量事实；不建排班、工时汇总、质检或团队层级。
CREATE TABLE IF NOT EXISTS "zzsh_iam"."im_support_presence_session" (
  "id" text PRIMARY KEY CHECK (char_length("id") BETWEEN 1 AND 128),
  "app_id" text NOT NULL CHECK ("app_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  "admin_user_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id") ON DELETE RESTRICT,
  "started_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "ended_at" timestamptz,
  "end_reason" text CHECK ("end_reason" IN ('MANUAL_OFF', 'PAUSED', 'DISCONNECTED', 'STALE', 'FORCED', 'OFF_DUTY')),
  "last_heartbeat_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "im_support_presence_session_end_shape"
    CHECK (("ended_at" IS NULL) = ("end_reason" IS NULL)),
  CONSTRAINT "im_support_presence_session_time_order"
    CHECK ("last_heartbeat_at" >= "started_at" AND ("ended_at" IS NULL OR "ended_at" >= "started_at"))
);
--> statement-breakpoint
-- 同一客服同一时刻最多一条未结束区间；并发开区间由该索引兜底。
CREATE UNIQUE INDEX IF NOT EXISTS "im_support_presence_session_open_unique"
  ON "zzsh_iam"."im_support_presence_session" ("app_id", "admin_user_id")
  WHERE "ended_at" IS NULL;
CREATE INDEX IF NOT EXISTS "im_support_presence_session_owner_idx"
  ON "zzsh_iam"."im_support_presence_session" ("app_id", "admin_user_id", "started_at" DESC);
CREATE INDEX IF NOT EXISTS "im_support_presence_session_window_idx"
  ON "zzsh_iam"."im_support_presence_session" ("app_id", "started_at", "ended_at");
CREATE INDEX IF NOT EXISTS "im_support_presence_session_stale_idx"
  ON "zzsh_iam"."im_support_presence_session" ("app_id", "last_heartbeat_at")
  WHERE "ended_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "zzsh_iam"."im_support_handover" (
  "id" text PRIMARY KEY CHECK (char_length("id") BETWEEN 1 AND 128),
  "app_id" text NOT NULL CHECK ("app_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  "object_type" text NOT NULL CHECK ("object_type" IN ('CONSULTATION', 'ORDER_GROUP')),
  "object_id" text NOT NULL CHECK (char_length("object_id") BETWEEN 1 AND 128),
  "from_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id") ON DELETE RESTRICT,
  "to_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id") ON DELETE RESTRICT,
  "note" text CHECK ("note" IS NULL OR char_length("note") BETWEEN 1 AND 200),
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "im_support_handover_distinct_staff" CHECK ("from_admin_id" <> "to_admin_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "im_support_handover_recent_idx"
  ON "zzsh_iam"."im_support_handover" ("app_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "im_support_handover_from_idx"
  ON "zzsh_iam"."im_support_handover" ("app_id", "from_admin_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "im_support_handover_to_idx"
  ON "zzsh_iam"."im_support_handover" ("app_id", "to_admin_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "im_support_handover_object_idx"
  ON "zzsh_iam"."im_support_handover" ("object_type", "object_id", "created_at" DESC);
--> statement-breakpoint
INSERT INTO "zzsh_iam"."admin_permission" ("code", "name", "description") VALUES
  ('im.support.management.read', '查看客服管理', '查看统计看板、全部咨询/订单群列表、只读巡视任何会话与交接记录；不含发送或订单写权限'),
  ('im.support.audit.takeover', '巡视接管会话', '巡视中把当前咨询责任转给自己；仍复用现有转交与接待资格校验')
ON CONFLICT ("code") DO NOTHING;
