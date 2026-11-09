-- 0183_order_stage_card_unknown: transport failures and post-send record failures must not auto-resend.
-- An expired SENDING lease or a failed SENT write may mean the provider already accepted the message.
-- Existing queued rows that were left for blind retry are frozen as UNKNOWN for operator review.
ALTER TABLE "zzsh_order"."im_order_stage_card" DROP CONSTRAINT IF EXISTS "im_order_stage_card_state_check";
--> statement-breakpoint
ALTER TABLE "zzsh_order"."im_order_stage_card"
  ADD CONSTRAINT "im_order_stage_card_state_check"
  CHECK ("state" IN ('PENDING', 'SENDING', 'SENT', 'SKIPPED', 'UNKNOWN'));
--> statement-breakpoint
UPDATE "zzsh_order"."im_order_stage_card"
   SET "state" = 'UNKNOWN', "lease_until" = NULL, "lease_token_hash" = NULL,
       "failure_class" = 'LEASE_EXPIRED', "updated_at" = clock_timestamp()
 WHERE "state" = 'SENDING' AND "lease_until" <= clock_timestamp();
--> statement-breakpoint
UPDATE "zzsh_order"."im_order_stage_card"
   SET "state" = 'UNKNOWN', "failure_class" = 'SEND_FAILED', "updated_at" = clock_timestamp()
 WHERE "state" = 'PENDING' AND "failure_class" IS NOT NULL
   AND "failure_class" NOT IN ('IDENTITY_PENDING', 'TEXT_TRANSPORT_UNAVAILABLE');
--> statement-breakpoint
COMMENT ON CONSTRAINT "im_order_stage_card_state_check" ON "zzsh_order"."im_order_stage_card"
  IS 'UNKNOWN 表示渠道可能已接受但结果未确认；worker 不自动重发，只供人工核对';
