-- DAY is a billable unit for time-scoped consumables such as the top insurance card.
-- Existing quantities remain unchanged; only the catalog enum is extended.
ALTER TABLE "zzsh_supply"."billable_item"
  DROP CONSTRAINT "billable_item_unit_check";

ALTER TABLE "zzsh_supply"."billable_item"
  ADD CONSTRAINT "billable_item_unit_check"
  CHECK ("unit" = ANY (ARRAY['HAFF_BASE'::text, 'ROUND'::text, 'PIECE'::text, 'DAY'::text]));
