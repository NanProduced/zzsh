-- 0124_opening_confirmation: 开租确认来源与 40 分钟自动确认到期事实。
-- DRAFT 期初在创建 40 分钟后到期；到期后由服务端任务补齐未确认方并确认开租。
-- 租期从 confirmed_at（确认时刻）起算，不回溯；确认来源只由服务端写入。

ALTER TABLE "zzsh_order"."rental_opening"
  ADD COLUMN IF NOT EXISTS "confirm_source" text,
  ADD COLUMN IF NOT EXISTS "auto_confirm_due_at" timestamptz;
--> statement-breakpoint

-- A generated column cannot use timestamptz + interval (not immutable), so the
-- due fact is set by a small INSERT trigger. The old guard rejects any update of
-- a DRAFT row except DRAFT→CONFIRMED; disable it only for this derived backfill.
ALTER TABLE "zzsh_order"."rental_opening" DISABLE TRIGGER "rental_opening_guard";
--> statement-breakpoint

UPDATE "zzsh_order"."rental_opening"
   SET "auto_confirm_due_at" = "created_at" + interval '40 minutes'
 WHERE "auto_confirm_due_at" IS NULL AND "status" = 'DRAFT';
--> statement-breakpoint

ALTER TABLE "zzsh_order"."rental_opening" ENABLE TRIGGER "rental_opening_guard";
--> statement-breakpoint

CREATE OR REPLACE FUNCTION "zzsh_order"."set_rental_opening_auto_confirm_due"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW."auto_confirm_due_at" := NEW."created_at" + interval '40 minutes';
  RETURN NEW;
END $$;
--> statement-breakpoint

DROP TRIGGER IF EXISTS "rental_opening_auto_confirm_due_set" ON "zzsh_order"."rental_opening";
--> statement-breakpoint

CREATE TRIGGER "rental_opening_auto_confirm_due_set"
  BEFORE INSERT ON "zzsh_order"."rental_opening"
  FOR EACH ROW EXECUTE FUNCTION "zzsh_order"."set_rental_opening_auto_confirm_due"();

ALTER TABLE "zzsh_order"."rental_opening"
  ADD CONSTRAINT "rental_opening_confirm_source_check"
    CHECK ("confirm_source" IS NULL OR "confirm_source" IN ('PARTY', 'ON_BEHALF', 'AUTO'));
--> statement-breakpoint

ALTER TABLE "zzsh_order"."rental_opening_ack"
  ADD COLUMN IF NOT EXISTS "source" text NOT NULL DEFAULT 'PARTY';

ALTER TABLE "zzsh_order"."rental_opening_ack"
  ADD CONSTRAINT "rental_opening_ack_source_check"
    CHECK ("source" IN ('PARTY', 'ON_BEHALF', 'AUTO'));
--> statement-breakpoint

CREATE INDEX IF NOT EXISTS "rental_opening_auto_confirm_due_idx"
  ON "zzsh_order"."rental_opening" ("auto_confirm_due_at", "id")
  WHERE "status" = 'DRAFT';
