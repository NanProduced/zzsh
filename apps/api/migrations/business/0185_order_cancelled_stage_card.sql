-- 0185_order_cancelled_stage_card: cancellation is a first-class group event.
-- Keeps the existing idempotent card ledger; one ORDER_CANCELLED card per order.
ALTER TABLE "zzsh_order"."im_order_stage_card" DROP CONSTRAINT IF EXISTS "im_order_stage_card_kind_check";
--> statement-breakpoint
ALTER TABLE "zzsh_order"."im_order_stage_card"
  ADD CONSTRAINT "im_order_stage_card_kind_check"
  CHECK ("kind" IN ('ORDER_WELCOME', 'ORDER_OPENING', 'ORDER_ENDING', 'ORDER_SETTLED', 'ORDER_CANCELLED', 'ORDER_PRICE_CHANGE'));
--> statement-breakpoint
COMMENT ON CONSTRAINT "im_order_stage_card_kind_check" ON "zzsh_order"."im_order_stage_card"
  IS 'ORDER_CANCELLED 每个订单一张，用于群内取消事件；退款状态由读模型实时投影。';
