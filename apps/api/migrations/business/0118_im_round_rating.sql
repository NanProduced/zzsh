-- 0118_im_round_rating: 轮次级已读与评价。
-- admin_read_at 仅由当前负责客服在 ACTIVE 轮次推进（平台读取事件）；评价每轮最多一条，
-- 提交后分数与文字不可改，暂不评价只记录 dismissed_at，客服不可代评。

ALTER TABLE "zzsh_iam"."im_consultation" ADD COLUMN IF NOT EXISTS "admin_read_at" timestamptz;

--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "zzsh_iam"."im_support_round_rating" (
  "id" text PRIMARY KEY CHECK (char_length("id") BETWEEN 1 AND 128),
  "app_id" text NOT NULL CHECK ("app_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  "thread_id" text NOT NULL REFERENCES "zzsh_iam"."im_support_thread"("id") ON DELETE RESTRICT,
  "round_id" text NOT NULL UNIQUE REFERENCES "zzsh_iam"."im_consultation"("id") ON DELETE RESTRICT,
  "user_id" text NOT NULL REFERENCES "zzsh_auth_user"."user"("id") ON DELETE RESTRICT,
  "assigned_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id") ON DELETE RESTRICT,
  "score" smallint CONSTRAINT "im_support_round_rating_score" CHECK ("score" BETWEEN 1 AND 5),
  "comment" text CONSTRAINT "im_support_round_rating_comment" CHECK (char_length("comment") <= 200),
  "submitted_at" timestamptz,
  "dismissed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "im_support_round_rating_shape" CHECK (
    ("score" IS NOT NULL AND "submitted_at" IS NOT NULL AND "dismissed_at" IS NULL)
    OR ("score" IS NULL AND "submitted_at" IS NULL AND "dismissed_at" IS NOT NULL)
  ),
  CONSTRAINT "im_support_round_rating_comment_shape" CHECK (char_length(btrim("comment")) > 0 OR "comment" IS NULL)
);

CREATE INDEX IF NOT EXISTS "im_support_round_rating_agent_idx"
  ON "zzsh_iam"."im_support_round_rating" ("app_id", "assigned_admin_id", "submitted_at");
CREATE INDEX IF NOT EXISTS "im_support_round_rating_day_idx"
  ON "zzsh_iam"."im_support_round_rating" ("app_id", "submitted_at");

--> statement-breakpoint

CREATE OR REPLACE FUNCTION "zzsh_iam"."guard_im_support_round_rating_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'IM support round rating is append-only';
  END IF;
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."app_id" IS DISTINCT FROM OLD."app_id"
     OR NEW."thread_id" IS DISTINCT FROM OLD."thread_id"
     OR NEW."round_id" IS DISTINCT FROM OLD."round_id"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."assigned_admin_id" IS DISTINCT FROM OLD."assigned_admin_id"
     OR NEW."score" IS DISTINCT FROM OLD."score"
     OR NEW."comment" IS DISTINCT FROM OLD."comment"
     OR NEW."submitted_at" IS DISTINCT FROM OLD."submitted_at"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'IM support round rating identity, score and comment are immutable';
  END IF;
  -- 暂不评价只能从 NULL 推进一次 dismissed_at；已提交的评价不可再 dismiss。
  IF OLD."dismissed_at" IS NOT NULL AND NEW."dismissed_at" IS DISTINCT FROM OLD."dismissed_at" THEN
    RAISE EXCEPTION 'IM support round rating dismissal is immutable';
  END IF;
  IF OLD."dismissed_at" IS NULL AND NEW."dismissed_at" IS NOT NULL AND OLD."score" IS NOT NULL THEN
    RAISE EXCEPTION 'A submitted IM support round rating cannot be dismissed';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "im_support_round_rating_mutation_guard" ON "zzsh_iam"."im_support_round_rating";
CREATE TRIGGER "im_support_round_rating_mutation_guard"
BEFORE UPDATE OR DELETE ON "zzsh_iam"."im_support_round_rating"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."guard_im_support_round_rating_mutation"();
