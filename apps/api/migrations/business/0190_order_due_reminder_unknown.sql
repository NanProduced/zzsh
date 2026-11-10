-- 0190_order_due_reminder_unknown: an expired lease or a failed SENT write may mean
-- the provider already accepted the reminder. Freeze it for review instead of resending.
ALTER TABLE "zzsh_order"."im_order_due_reminder" DROP CONSTRAINT IF EXISTS "im_order_due_reminder_state_check";
--> statement-breakpoint
ALTER TABLE "zzsh_order"."im_order_due_reminder"
  ADD CONSTRAINT "im_order_due_reminder_state_check"
  CHECK ("state" IN ('PENDING', 'SENDING', 'SENT', 'SKIPPED', 'UNKNOWN'));
--> statement-breakpoint
UPDATE "zzsh_order"."im_order_due_reminder"
   SET "state" = 'UNKNOWN', "lease_until" = NULL, "lease_token_hash" = NULL,
       "failure_class" = 'LEASE_EXPIRED', "updated_at" = clock_timestamp()
 WHERE "state" = 'SENDING' AND "lease_until" <= clock_timestamp();
--> statement-breakpoint
UPDATE "zzsh_order"."im_order_due_reminder"
   SET "state" = 'UNKNOWN', "updated_at" = clock_timestamp()
 WHERE "state" = 'PENDING' AND "failure_class" IS NOT NULL
   AND "failure_class" <> 'IDENTITY_PENDING';
--> statement-breakpoint
COMMENT ON CONSTRAINT "im_order_due_reminder_state_check" ON "zzsh_order"."im_order_due_reminder"
  IS 'UNKNOWN 表示渠道可能已接受但结果未确认；worker 不自动重发，只供人工核对';
