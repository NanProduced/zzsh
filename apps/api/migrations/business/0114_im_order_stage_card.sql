-- O-01：开租确认/发起结束/结算过账的阶段卡消息。
-- 卡片只是普通聊天消息，事实仍由 order-team 读取；本表只保证一条阶段一条消息。
CREATE TABLE IF NOT EXISTS "zzsh_order"."im_order_stage_card" (
  "id" text PRIMARY KEY CHECK (char_length("id") BETWEEN 1 AND 128),
  "order_id" text NOT NULL REFERENCES "zzsh_order"."rental_order"("id") ON DELETE RESTRICT,
  "app_id" text NOT NULL CHECK ("app_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  "kind" text NOT NULL CHECK ("kind" IN ('ORDER_OPENING', 'ORDER_ENDING', 'ORDER_SETTLED', 'ORDER_PRICE_CHANGE')),
  "card_id" text NOT NULL CHECK ("card_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  "state" text NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING', 'SENDING', 'SENT', 'SKIPPED')),
  "attempt_count" integer NOT NULL DEFAULT 0 CHECK ("attempt_count" >= 0),
  "next_attempt_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "lease_until" timestamptz,
  "lease_token_hash" text,
  "sent_at" timestamptz,
  "failure_class" text CHECK ("failure_class" IS NULL OR "failure_class" ~ '^[A-Z_]{1,64}$'),
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "im_order_stage_card_unique" UNIQUE ("order_id", "app_id", "kind"),
  CONSTRAINT "im_order_stage_card_card_id_unique" UNIQUE ("card_id"),
  CONSTRAINT "im_order_stage_card_sending_shape"
    CHECK (("state" = 'SENDING' AND "lease_until" IS NOT NULL AND "lease_token_hash" IS NOT NULL)
      OR ("state" <> 'SENDING' AND "lease_until" IS NULL AND "lease_token_hash" IS NULL)),
  CONSTRAINT "im_order_stage_card_sent_shape"
    CHECK (("state" = 'SENT') = ("sent_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "im_order_stage_card_due_idx"
  ON "zzsh_order"."im_order_stage_card" ("app_id", "state", "next_attempt_at", "created_at");
CREATE INDEX IF NOT EXISTS "im_order_stage_card_lease_idx"
  ON "zzsh_order"."im_order_stage_card" ("app_id", "state", "lease_until")
  WHERE "state" = 'SENDING';
