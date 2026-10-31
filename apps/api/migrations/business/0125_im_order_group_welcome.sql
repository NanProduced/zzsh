-- 建群后的第一条消息由洲洲助手发出，沿用阶段卡的去重/重试账本。
ALTER TABLE "zzsh_order"."im_order_stage_card"
  DROP CONSTRAINT IF EXISTS "im_order_stage_card_kind_check";

ALTER TABLE "zzsh_order"."im_order_stage_card"
  ADD CONSTRAINT "im_order_stage_card_kind_check"
  CHECK ("kind" IN ('ORDER_WELCOME', 'ORDER_OPENING', 'ORDER_ENDING', 'ORDER_SETTLED', 'ORDER_PRICE_CHANGE'));
