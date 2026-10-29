-- 0113_im_support_thread: A 模型持久线程。
-- 一个 app+user+kind 只有一条线程并只承载一个 NIM Team；im_consultation 变为轮次（round）。
-- 结束一轮只结束 round（线程回 IDLE），不 dismiss Team、不删除历史；历史行迁移为线程+已结束轮次。
-- 旧 Team 已销毁的线程不伪造可恢复：线程不保留 scope id，下次使用建新 Team。

CREATE TABLE IF NOT EXISTS "zzsh_iam"."im_support_thread" (
  "id" text PRIMARY KEY CHECK (char_length("id") BETWEEN 1 AND 128),
  "app_id" text NOT NULL CHECK ("app_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  "user_id" text NOT NULL REFERENCES "zzsh_auth_user"."user"("id") ON DELETE RESTRICT,
  "kind" text NOT NULL CHECK ("kind" IN ('SERVICE', 'COMPLAINT')),
  "state" text NOT NULL DEFAULT 'IDLE' CHECK ("state" IN ('IDLE', 'WAITING', 'ACTIVE')),
  "user_account_id" text NOT NULL CHECK ("user_account_id" ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'),
  "peer_account_id" text CHECK ("peer_account_id" IS NULL OR "peer_account_id" ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'),
  "message_scope_type" text NOT NULL DEFAULT 'TEAM' CHECK ("message_scope_type" = 'TEAM'),
  "message_scope_id" text CHECK ("message_scope_id" IS NULL OR "message_scope_id" ~ '^[0-9]{1,19}$'),
  "message_scope_state" text NOT NULL DEFAULT 'PENDING'
    CHECK ("message_scope_state" IN ('PENDING', 'PROVISIONING', 'READY', 'FAILED')),
  "last_round_seq" integer NOT NULL DEFAULT 0 CHECK ("last_round_seq" >= 0),
  "version" bigint NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "im_support_thread_scope_ready_shape"
    CHECK (("message_scope_state" <> 'READY') OR ("message_scope_id" IS NOT NULL)),
  CONSTRAINT "im_support_thread_responsible_shape"
    CHECK (("state" <> 'ACTIVE') OR ("peer_account_id" IS NOT NULL))
);

CREATE UNIQUE INDEX IF NOT EXISTS "im_support_thread_user_kind_unique"
  ON "zzsh_iam"."im_support_thread" ("app_id", "user_id", "kind");
-- 一个 Team 只能属于一条线程；同一 Team 不能同时作为订单群。
CREATE UNIQUE INDEX IF NOT EXISTS "im_support_thread_scope_unique"
  ON "zzsh_iam"."im_support_thread" ("app_id", "message_scope_id")
  WHERE "message_scope_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "im_support_thread_scope_state_idx"
  ON "zzsh_iam"."im_support_thread" ("app_id", "message_scope_state", "updated_at");
ALTER TABLE "zzsh_iam"."im_support_thread"
  ADD CONSTRAINT "im_support_thread_round_identity" UNIQUE ("id", "app_id", "user_id", "kind");

--> statement-breakpoint

-- 每条历史线程取一条代表轮次：优先未结束轮，否则取最近一轮。
INSERT INTO "zzsh_iam"."im_support_thread"
  ("id", "app_id", "user_id", "kind", "state", "user_account_id", "peer_account_id",
   "message_scope_id", "message_scope_state", "created_at", "updated_at")
SELECT 'im_thread_' || replace(gen_random_uuid()::text, '-', ''),
       x."app_id", x."user_id", x."kind",
       CASE x."state" WHEN 'ACTIVE' THEN 'ACTIVE' WHEN 'WAITING' THEN 'WAITING' ELSE 'IDLE' END,
       x."user_account_id",
       CASE WHEN x."state" = 'CLOSED' THEN NULL ELSE x."peer_account_id" END,
       CASE WHEN x."state" = 'CLOSED' THEN NULL ELSE x."message_scope_id" END,
       CASE
         WHEN x."state" = 'CLOSED' OR x."message_scope_id" IS NULL THEN 'PENDING'
         WHEN x."message_scope_state" IN ('READY', 'TRANSFERRING', 'REVOKING') THEN 'READY'
         WHEN x."message_scope_state" = 'PROVISIONING' THEN 'PROVISIONING'
         WHEN x."message_scope_state" = 'FAILED' THEN 'FAILED'
         ELSE 'PENDING'
       END,
       x."created_at", x."updated_at"
  FROM (
    SELECT DISTINCT ON (c."app_id", c."user_id", c."kind") c.*
      FROM "zzsh_iam"."im_consultation" c
     ORDER BY c."app_id", c."user_id", c."kind", (c."state" <> 'CLOSED') DESC, c."created_at" DESC, c."id" DESC
  ) x
ON CONFLICT DO NOTHING;

--> statement-breakpoint

ALTER TABLE "zzsh_iam"."im_consultation" ADD COLUMN "thread_id" text;
ALTER TABLE "zzsh_iam"."im_consultation" ADD COLUMN "round_seq" integer;

UPDATE "zzsh_iam"."im_consultation" c
   SET "thread_id" = t."id"
  FROM "zzsh_iam"."im_support_thread" t
 WHERE t."app_id" = c."app_id" AND t."user_id" = c."user_id" AND t."kind" = c."kind";

WITH ranked AS (
  SELECT c."id", row_number() OVER (PARTITION BY c."thread_id" ORDER BY c."created_at", c."id") AS rn
    FROM "zzsh_iam"."im_consultation" c
)
UPDATE "zzsh_iam"."im_consultation" c
   SET "round_seq" = r.rn
  FROM ranked r
 WHERE r."id" = c."id";

UPDATE "zzsh_iam"."im_support_thread" t
   SET "last_round_seq" = COALESCE((SELECT max(c."round_seq") FROM "zzsh_iam"."im_consultation" c WHERE c."thread_id" = t."id"), 0);

ALTER TABLE "zzsh_iam"."im_consultation" ALTER COLUMN "thread_id" SET NOT NULL;
ALTER TABLE "zzsh_iam"."im_consultation" ALTER COLUMN "round_seq" SET NOT NULL;
ALTER TABLE "zzsh_iam"."im_consultation"
  ADD CONSTRAINT "im_consultation_round_seq_check" CHECK ("round_seq" > 0);
ALTER TABLE "zzsh_iam"."im_consultation"
  ADD CONSTRAINT "im_consultation_thread_round_unique" UNIQUE ("thread_id", "round_seq");
ALTER TABLE "zzsh_iam"."im_consultation"
  ADD CONSTRAINT "im_consultation_thread_scope"
  FOREIGN KEY ("thread_id", "app_id", "user_id", "kind")
  REFERENCES "zzsh_iam"."im_support_thread" ("id", "app_id", "user_id", "kind")
  ON DELETE RESTRICT;

-- 一条线程同一时刻最多一个未结束轮次；CLOSED 历史轮次保留。
CREATE UNIQUE INDEX IF NOT EXISTS "im_consultation_thread_open_unique"
  ON "zzsh_iam"."im_consultation" ("thread_id")
  WHERE "state" <> 'CLOSED';
DROP INDEX IF EXISTS "zzsh_iam"."im_consultation_user_kind_active_unique_idx";
DROP INDEX IF EXISTS "zzsh_iam"."im_consultation_app_user_kind_active_unique_idx";

--> statement-breakpoint

CREATE OR REPLACE FUNCTION "zzsh_iam"."guard_im_support_thread_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."app_id" IS DISTINCT FROM OLD."app_id"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."user_account_id" IS DISTINCT FROM OLD."user_account_id"
     OR NEW."message_scope_type" IS DISTINCT FROM OLD."message_scope_type"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'IM support thread identity is immutable';
  END IF;
  IF NEW."last_round_seq" < OLD."last_round_seq" THEN
    RAISE EXCEPTION 'IM support thread round sequence cannot decrease';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    (OLD."state" = 'IDLE' AND NEW."state" IN ('WAITING', 'ACTIVE'))
    OR (OLD."state" = 'WAITING' AND NEW."state" IN ('ACTIVE', 'IDLE'))
    OR (OLD."state" = 'ACTIVE' AND NEW."state" = 'IDLE')
  ) THEN
    RAISE EXCEPTION 'IM support thread state transition is invalid';
  END IF;
  IF NEW."message_scope_state" IS DISTINCT FROM OLD."message_scope_state" AND NOT (
    (OLD."message_scope_state" = 'PENDING' AND NEW."message_scope_state" IN ('PROVISIONING', 'READY', 'FAILED'))
    OR (OLD."message_scope_state" = 'PROVISIONING' AND NEW."message_scope_state" IN ('READY', 'FAILED'))
    OR (OLD."message_scope_state" = 'FAILED' AND NEW."message_scope_state" IN ('PROVISIONING', 'READY'))
    OR (OLD."message_scope_state" = 'READY' AND NEW."message_scope_state" = 'PENDING')
  ) THEN
    RAISE EXCEPTION 'IM support thread message scope transition is invalid';
  END IF;
  IF OLD."message_scope_id" IS NOT NULL
     AND NEW."message_scope_id" IS DISTINCT FROM OLD."message_scope_id"
     AND NEW."message_scope_id" IS NOT NULL THEN
    RAISE EXCEPTION 'IM support thread message scope identity is immutable';
  END IF;
  IF OLD."message_scope_id" IS NOT NULL AND NEW."message_scope_id" IS NULL
     AND NEW."message_scope_state" <> 'PENDING' THEN
    RAISE EXCEPTION 'Cleared IM support thread scope must be PENDING';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "im_support_thread_mutation_guard" ON "zzsh_iam"."im_support_thread";
CREATE TRIGGER "im_support_thread_mutation_guard"
BEFORE UPDATE ON "zzsh_iam"."im_support_thread"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."guard_im_support_thread_mutation"();

--> statement-breakpoint

CREATE OR REPLACE FUNCTION "zzsh_iam"."guard_im_consultation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."app_id" IS DISTINCT FROM OLD."app_id"
     OR NEW."user_account_id" IS DISTINCT FROM OLD."user_account_id"
     OR NEW."subject_ref" IS DISTINCT FROM OLD."subject_ref"
     OR NEW."thread_id" IS DISTINCT FROM OLD."thread_id"
     OR NEW."round_seq" IS DISTINCT FROM OLD."round_seq"
     OR NEW."message_scope_type" IS DISTINCT FROM OLD."message_scope_type"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'IM consultation identity and message scope type are immutable';
  END IF;
  IF OLD."message_scope_id" IS NOT NULL AND NEW."message_scope_id" IS DISTINCT FROM OLD."message_scope_id" THEN
    RAISE EXCEPTION 'IM consultation message scope identity is immutable';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    (OLD."state" = 'WAITING' AND NEW."state" IN ('ACTIVE', 'CLOSED'))
    OR (OLD."state" = 'ACTIVE' AND NEW."state" = 'CLOSED')
  ) THEN
    RAISE EXCEPTION 'IM consultation state transition is invalid';
  END IF;
  IF NEW."message_scope_state" IS DISTINCT FROM OLD."message_scope_state" AND NOT (
    (OLD."message_scope_state" = 'PENDING' AND NEW."message_scope_state" IN ('PROVISIONING', 'REVOKED'))
    OR (OLD."message_scope_state" = 'PROVISIONING' AND NEW."message_scope_state" IN ('READY', 'FAILED', 'REVOKED'))
    OR (OLD."message_scope_state" = 'READY' AND NEW."message_scope_state" IN ('TRANSFERRING', 'REVOKING', 'REVOKED'))
    OR (OLD."message_scope_state" = 'FAILED' AND NEW."message_scope_state" IN ('PROVISIONING', 'TRANSFERRING', 'REVOKING', 'REVOKED'))
    OR (OLD."message_scope_state" = 'TRANSFERRING' AND NEW."message_scope_state" IN ('READY', 'FAILED', 'REVOKED'))
    OR (OLD."message_scope_state" = 'REVOKING' AND NEW."message_scope_state" IN ('READY', 'FAILED', 'REVOKED'))
  ) THEN
    RAISE EXCEPTION 'IM consultation message scope transition is invalid';
  END IF;
  IF OLD."state" = 'CLOSED' AND (
    NEW."assigned_admin_id" IS DISTINCT FROM OLD."assigned_admin_id"
    OR NEW."peer_account_id" IS DISTINCT FROM OLD."peer_account_id"
  ) THEN
    RAISE EXCEPTION 'Closed IM consultation assignment is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "im_consultation_mutation_guard" ON "zzsh_iam"."im_consultation";
CREATE TRIGGER "im_consultation_mutation_guard"
BEFORE UPDATE ON "zzsh_iam"."im_consultation"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."guard_im_consultation_mutation"();

--> statement-breakpoint

-- CREATE 不再要求目标客服（线程建 Team 只有客服管理身份+用户）；
-- ADD_MEMBER 把接入客服加入既有线程 Team；ROUND_CLOSE 只移除本轮客服、不 dismiss Team。
ALTER TABLE "zzsh_iam"."im_consultation_scope_operation"
  DROP CONSTRAINT "im_consultation_scope_operation_type_check",
  ADD CONSTRAINT "im_consultation_scope_operation_type_check"
    CHECK (
      ("operation_type" = 'CREATE'
        AND "previous_admin_id" IS NULL AND "previous_admin_account_id" IS NULL
        AND (("target_admin_id" IS NULL AND "target_admin_account_id" IS NULL)
          OR ("target_admin_id" IS NOT NULL AND "target_admin_account_id" IS NOT NULL)))
      OR ("operation_type" = 'ADD_MEMBER'
        AND "previous_admin_id" IS NULL AND "previous_admin_account_id" IS NULL
        AND "target_admin_id" IS NOT NULL AND "target_admin_account_id" IS NOT NULL)
      OR ("operation_type" = 'TRANSFER' AND "previous_admin_id" IS NOT NULL AND "target_admin_id" IS NOT NULL
          AND "previous_admin_account_id" IS NOT NULL AND "target_admin_account_id" IS NOT NULL
          AND "previous_admin_account_id" <> "target_admin_account_id")
      OR ("operation_type" = 'CLOSE' AND "previous_admin_id" IS NULL AND "target_admin_id" IS NULL
          AND "previous_admin_account_id" IS NULL AND "target_admin_account_id" IS NULL)
      OR ("operation_type" = 'ROUND_CLOSE'
        AND "previous_admin_id" IS NOT NULL AND "previous_admin_account_id" IS NOT NULL
        AND "target_admin_id" IS NULL AND "target_admin_account_id" IS NULL)
    );
