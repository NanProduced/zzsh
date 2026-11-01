-- 0135_im_conversation_activity: 会话列表的真实未读数与订单群最后消息时间。
-- 客服轮次按用户/客服两侧计数；订单群只记录最后消息时间，未读仍需按成员身份另行建模。

ALTER TABLE "zzsh_iam"."im_consultation"
  ADD COLUMN IF NOT EXISTS "user_unread_count" integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "admin_unread_count" integer NOT NULL DEFAULT 0;
--> statement-breakpoint

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='zzsh_iam.im_consultation'::regclass
    AND conname='im_consultation_unread_nonnegative') THEN
    ALTER TABLE "zzsh_iam"."im_consultation" ADD CONSTRAINT im_consultation_unread_nonnegative
      CHECK ("user_unread_count" >= 0 AND "admin_unread_count" >= 0);
  END IF;
END $$;
--> statement-breakpoint

-- 迁移前的未读只有布尔事实；先落为 1，后续消息再递增，避免把历史未读显示成 0。
UPDATE "zzsh_iam"."im_consultation" c
   SET "user_unread_count" = CASE
         WHEN c."state" <> 'CLOSED' AND c."last_message_at" IS NOT NULL
           AND (t."user_read_at" IS NULL OR c."last_message_at" > t."user_read_at") THEN 1
         ELSE c."user_unread_count" END,
       "admin_unread_count" = CASE
         WHEN c."state" = 'ACTIVE' AND c."last_message_at" IS NOT NULL
           AND (c."admin_read_at" IS NULL OR c."last_message_at" > c."admin_read_at") THEN 1
         ELSE c."admin_unread_count" END
  FROM "zzsh_iam"."im_support_thread" t
 WHERE t."app_id" = c."app_id" AND t."id" = c."thread_id";
--> statement-breakpoint

CREATE TABLE IF NOT EXISTS "zzsh_order"."im_order_activity" (
  "order_id" text PRIMARY KEY,
  "app_id" text NOT NULL CHECK ("app_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  "last_message_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "last_message_preview" text,
  CONSTRAINT "im_order_activity_order_fk" FOREIGN KEY ("order_id")
    REFERENCES "zzsh_order"."rental_order" ("id") ON DELETE CASCADE
);
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "im_order_activity_recent"
  ON "zzsh_order"."im_order_activity" ("last_message_at" DESC);
