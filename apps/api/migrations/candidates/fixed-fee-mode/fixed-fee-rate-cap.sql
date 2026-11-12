-- At 92% + 8%, independent half-up on whole cents is complementary: cents*2/25 is never a half.
-- Keep the earlier structure artifact intact; this candidate also validates any existing drafts.
CREATE OR REPLACE FUNCTION zzsh_supply.valid_fixed_fee_rates(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE mode_name text; rate_text text;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR value - ARRAY['ordinary','custom','fast'] <> '{}'::jsonb THEN RETURN false; END IF;
  FOREACH mode_name IN ARRAY ARRAY['ordinary','custom','fast'] LOOP
    IF jsonb_typeof(value->mode_name) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    rate_text := value->>mode_name;
    IF length(rate_text)>10 OR rate_text !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$'
      OR rate_text::numeric > 0.92 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
ALTER TABLE zzsh_supply.price_version ADD CONSTRAINT price_version_fixed_fee_full_payout_cap
 CHECK (fixed_fee_rates IS NULL OR zzsh_supply.valid_fixed_fee_rates(fixed_fee_rates));
COMMENT ON CONSTRAINT price_version_fixed_fee_full_payout_cap ON zzsh_supply.price_version IS '三种手续费率均不得超过 92%，给号主承担的 8% 包赔费留足毛收入。';
