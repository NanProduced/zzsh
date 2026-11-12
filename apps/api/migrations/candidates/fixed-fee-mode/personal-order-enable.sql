-- Candidate only. Apply together with the v5 evidence and final-funding guards;
-- publication and settlement remain closed until their own contracts are ready.
ALTER TABLE zzsh_supply.listing_version DROP CONSTRAINT listing_version_schema_version_check;
ALTER TABLE zzsh_supply.listing_version ADD CONSTRAINT listing_version_schema_version_check CHECK(schema_version IN (1,2,3,4));

-- Retain the existing trigger and original v1-v4 body for every earlier snapshot.
DROP TRIGGER rental_order_personal_guard ON zzsh_order.rental_order;
CREATE TRIGGER rental_order_personal_guard BEFORE INSERT OR UPDATE ON zzsh_order.rental_order
  FOR EACH ROW WHEN (NEW.quote_snapshot#>>'{personal,schema}' IS DISTINCT FROM 'personal-quote-v5')
  EXECUTE FUNCTION zzsh_order.guard_personal_order();

CREATE FUNCTION zzsh_order.guard_fixed_fee_personal_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE listing_schema integer;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT schema_version INTO listing_schema FROM zzsh_supply.listing_version
      WHERE id=NEW.listing_version_id AND account_id=NEW.account_id;
    IF listing_schema=4 OR NEW.quote_snapshot->>'schemaVersion'='4'
      OR NEW.quote_snapshot#>>'{personal,schema}'='personal-quote-v5'
      OR NEW.quote_snapshot#>>'{settlementPricing,schema}'='settlement-pricing-v3' THEN
      IF listing_schema IS DISTINCT FROM 4 OR NEW.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '4'
        OR NEW.quote_snapshot#>>'{personal,schema}' IS DISTINCT FROM 'personal-quote-v5'
        OR NEW.quote_snapshot#>>'{settlementPricing,schema}' IS DISTINCT FROM 'settlement-pricing-v3'
      THEN RAISE EXCEPTION 'fixed fee order contract mismatch' USING ERRCODE='40001'; END IF;
      PERFORM zzsh_order.assert_fixed_fee_personal_order_v5(NEW);
    END IF;
  ELSIF NEW.confirmation_id IS DISTINCT FROM OLD.confirmation_id THEN
    RAISE EXCEPTION 'confirmation consumption is immutable' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_order_fixed_fee_personal_guard BEFORE INSERT OR UPDATE ON zzsh_order.rental_order
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_fixed_fee_personal_order();
REVOKE ALL ON FUNCTION zzsh_order.guard_fixed_fee_personal_order() FROM PUBLIC;
COMMENT ON FUNCTION zzsh_order.guard_fixed_fee_personal_order()
  IS '对固定手续费订单执行版本化确认依据校验；不改变历史订单校验。';

--> statement-breakpoint
-- Candidate only: do not attach this trigger or exempt v6 from the old guard until
-- settlement, cancellation, compensation and runtime ACLs are verified together.
CREATE FUNCTION zzsh_order.guard_scheduled_spread_personal_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE listing_schema integer;
BEGIN
  IF TG_OP='INSERT' AND NEW.quote_snapshot#>>'{personal,schema}'='personal-quote-v6' THEN
    SELECT schema_version INTO listing_schema FROM zzsh_supply.listing_version WHERE id=NEW.listing_version_id AND account_id=NEW.account_id;
    IF listing_schema IS DISTINCT FROM 2 OR NEW.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '2'
      OR NEW.quote_snapshot#>>'{settlementPricing,schema}' IS DISTINCT FROM 'settlement-pricing-v1'
    THEN RAISE EXCEPTION 'scheduled spread order contract mismatch' USING ERRCODE='40001'; END IF;
    PERFORM zzsh_order.assert_scheduled_spread_order_v6(NEW);
  ELSIF TG_OP='UPDATE' AND NEW.confirmation_id IS DISTINCT FROM OLD.confirmation_id THEN
    RAISE EXCEPTION 'confirmation consumption is immutable' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.guard_scheduled_spread_personal_order() FROM PUBLIC;
COMMENT ON FUNCTION zzsh_order.guard_scheduled_spread_personal_order()
  IS '候选价差订单确认守卫；下游与授权完成前不得绑定触发器。';
