-- O-02：租期到期提醒。每条订单每个节点最多一条消息；不发钱、不改单。
CREATE TABLE IF NOT EXISTS "zzsh_order"."im_order_due_reminder" (
  "id" text PRIMARY KEY CHECK (char_length("id") BETWEEN 1 AND 128),
  "order_id" text NOT NULL REFERENCES "zzsh_order"."rental_order"("id") ON DELETE RESTRICT,
  "app_id" text NOT NULL CHECK ("app_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  "bucket" text NOT NULL CHECK ("bucket" IN ('BEFORE_24H', 'DUE', 'AFTER_1D', 'AFTER_2D', 'AFTER_3D')),
  "state" text NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING', 'SENDING', 'SENT', 'SKIPPED')),
  "attempt_count" integer NOT NULL DEFAULT 0 CHECK ("attempt_count" >= 0),
  "next_attempt_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "lease_until" timestamptz,
  "lease_token_hash" text,
  "sent_at" timestamptz,
  "failure_class" text CHECK ("failure_class" IS NULL OR "failure_class" ~ '^[A-Z_]{1,64}$'),
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "im_order_due_reminder_unique" UNIQUE ("order_id", "app_id", "bucket"),
  CONSTRAINT "im_order_due_reminder_sending_shape"
    CHECK (("state" = 'SENDING' AND "lease_until" IS NOT NULL AND "lease_token_hash" IS NOT NULL)
      OR ("state" <> 'SENDING' AND "lease_until" IS NULL AND "lease_token_hash" IS NULL)),
  CONSTRAINT "im_order_due_reminder_sent_shape"
    CHECK (("state" = 'SENT') = ("sent_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "im_order_due_reminder_due_idx"
  ON "zzsh_order"."im_order_due_reminder" ("app_id", "state", "next_attempt_at", "created_at");
CREATE INDEX IF NOT EXISTS "im_order_due_reminder_lease_idx"
  ON "zzsh_order"."im_order_due_reminder" ("app_id", "state", "lease_until")
  WHERE "state" = 'SENDING';
