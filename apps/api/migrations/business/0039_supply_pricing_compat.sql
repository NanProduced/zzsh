-- Parameterized compatibility only. No production prices or historical rewrites.
CREATE FUNCTION zzsh_supply.valid_compat_haff_rule(rule jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE lane text; tier text; mode_name text; map_name text; entry record; cfg jsonb; bound jsonb; p numeric; v numeric;
BEGIN
  IF jsonb_typeof(rule) IS DISTINCT FROM 'object' OR rule->>'schema' IS DISTINCT FROM 'haff-ratio-v2'
    OR (rule - ARRAY['schema','baseBySafeBox','vitalityDeltaByLevel','bearDeltaByLevel','dailyDeltaByTermOption','compatibility']) <> '{}'::jsonb THEN RETURN false; END IF;
  FOREACH map_name IN ARRAY ARRAY['baseBySafeBox','vitalityDeltaByLevel','bearDeltaByLevel','dailyDeltaByTermOption'] LOOP
    IF jsonb_typeof(rule->map_name) IS DISTINCT FROM 'object' OR rule->map_name='{}'::jsonb THEN RETURN false; END IF;
    FOR entry IN SELECT * FROM jsonb_each(rule->map_name) LOOP
      IF jsonb_typeof(entry.value) IS DISTINCT FROM 'string' OR (entry.value#>>'{}') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,8})?$' THEN RETURN false; END IF;
      IF map_name='baseBySafeBox' AND (entry.value#>>'{}')::numeric<=0 THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  cfg:=rule->'compatibility';
  IF jsonb_typeof(cfg) IS DISTINCT FROM 'object' OR cfg-ARRAY['ordinary','fast','modes']<>'{}'::jsonb THEN RETURN false; END IF;
  FOREACH lane IN ARRAY ARRAY['ordinary','fast'] LOOP
    IF jsonb_typeof(cfg->lane) IS DISTINCT FROM 'object' OR (cfg->lane)-ARRAY['spreadDelta','discounts']<>'{}'::jsonb
      OR jsonb_typeof(cfg->lane->'spreadDelta') IS DISTINCT FROM 'string' OR (cfg->lane->>'spreadDelta') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$'
      OR jsonb_typeof(cfg->lane->'discounts') IS DISTINCT FROM 'object' OR (cfg->lane->'discounts')-ARRAY['STANDARD','VIP','SVIP','DISCOUNT_USER']<>'{}'::jsonb THEN RETURN false; END IF;
    p:=(cfg->lane->>'spreadDelta')::numeric;
    FOREACH tier IN ARRAY ARRAY['STANDARD','VIP','SVIP','DISCOUNT_USER'] LOOP
      IF jsonb_typeof(cfg->lane->'discounts'->tier) IS DISTINCT FROM 'string' OR (cfg->lane->'discounts'->>tier) !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$' THEN RETURN false; END IF;
      v:=(cfg->lane->'discounts'->>tier)::numeric;
      IF v>p OR (tier='STANDARD' AND v<>0) THEN RETURN false; END IF;
    END LOOP;
  END LOOP;
  IF jsonb_typeof(cfg->'modes') IS DISTINCT FROM 'object' OR (cfg->'modes')-ARRAY['ordinary','custom','fast']<>'{}'::jsonb THEN RETURN false; END IF;
  FOREACH mode_name IN ARRAY ARRAY['ordinary','custom','fast'] LOOP
    IF jsonb_typeof(cfg->'modes'->mode_name) IS DISTINCT FROM 'object' OR jsonb_typeof(cfg->'modes'->mode_name->'enabled') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
    IF mode_name='ordinary' THEN
      IF (cfg->'modes'->mode_name)-'enabled'<>'{}'::jsonb THEN RETURN false; END IF;
    ELSE
      IF (cfg->'modes'->mode_name)-ARRAY['enabled','min','max']<>'{}'::jsonb THEN RETURN false; END IF;
      FOREACH map_name IN ARRAY ARRAY['min','max'] LOOP
        bound:=cfg->'modes'->mode_name->map_name;
        IF jsonb_typeof(bound) IS DISTINCT FROM 'object' OR bound-ARRAY['base','value']<>'{}'::jsonb
          OR COALESCE(bound->>'base','') NOT IN ('C','ABSOLUTE') OR jsonb_typeof(bound->'value') IS DISTINCT FROM 'string'
          OR (bound->>'value') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,8})?$' THEN RETURN false; END IF;
      END LOOP;
    END IF;
  END LOOP;
  RETURN EXISTS(SELECT 1 FROM jsonb_each(cfg->'modes') m WHERE m.value->>'enabled'='true');
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
ALTER TABLE zzsh_supply.price_version DROP CONSTRAINT price_version_haff_rule_shape;
ALTER TABLE zzsh_supply.price_version ADD CONSTRAINT price_version_haff_rule_shape CHECK (COALESCE(
  haff_rule IS NULL OR (jsonb_typeof(haff_rule)='object' AND haff_rule->>'schema'='haff-ratio-v1')
  OR (mode='SPREAD' AND zzsh_supply.valid_compat_haff_rule(haff_rule)), false)
);
ALTER TABLE zzsh_supply.price_line DROP CONSTRAINT price_line_customer_tier_check;
ALTER TABLE zzsh_supply.price_line ADD CONSTRAINT price_line_customer_tier_check CHECK(customer_tier IN ('STANDARD','VIP','SVIP','DISCOUNT_USER'));
ALTER TABLE zzsh_supply.listing_version DROP CONSTRAINT listing_version_schema_version_check;
ALTER TABLE zzsh_supply.listing_version ADD CONSTRAINT listing_version_schema_version_check CHECK(schema_version IN (1,2));
--> statement-breakpoint
CREATE FUNCTION zzsh_supply.guard_compat_price_line() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent record;
BEGIN
  IF TG_OP='UPDATE' AND (NEW.price_version_id,NEW.item_id,NEW.customer_tier) IS DISTINCT FROM (OLD.price_version_id,OLD.item_id,OLD.customer_tier) THEN RAISE EXCEPTION 'price line identity is immutable' USING ERRCODE='40001'; END IF;
  SELECT * INTO parent FROM zzsh_supply.price_version WHERE id=NEW.price_version_id FOR UPDATE;
  IF NEW.customer_tier<>'STANDARD' AND (parent.mode<>'SPREAD' OR parent.haff_rule->>'schema' IS DISTINCT FROM 'haff-ratio-v2') THEN RAISE EXCEPTION 'tier pricing requires compatibility SPREAD'; END IF;
  IF EXISTS(SELECT 1 FROM zzsh_supply.price_line l WHERE l.price_version_id=NEW.price_version_id AND l.item_id=NEW.item_id AND l.id<>NEW.id
    AND (l.pricing_kind,l.unit_quantity,l.owner_unit_amount) IS DISTINCT FROM (NEW.pricing_kind,NEW.unit_quantity,NEW.owner_unit_amount)) THEN RAISE EXCEPTION 'owner price and unit must agree across tiers'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER price_line_compat_guard BEFORE INSERT OR UPDATE ON zzsh_supply.price_line FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_compat_price_line();
CREATE FUNCTION zzsh_supply.guard_compat_price_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS(SELECT 1 FROM zzsh_supply.price_line WHERE price_version_id=NEW.id AND customer_tier<>'STANDARD')
    AND (NEW.mode<>'SPREAD' OR NEW.haff_rule->>'schema' IS DISTINCT FROM 'haff-ratio-v2') THEN RAISE EXCEPTION 'tier lines require compatible rule'; END IF;
  IF NEW.status='SEALED' AND NEW.haff_rule->>'schema'='haff-ratio-v2' AND EXISTS(
    SELECT 1 FROM zzsh_supply.price_line l WHERE l.price_version_id=NEW.id AND NOT EXISTS(
      SELECT 1 FROM zzsh_supply.price_line s WHERE s.price_version_id=l.price_version_id AND s.item_id=l.item_id AND s.customer_tier='STANDARD')) THEN RAISE EXCEPTION 'STANDARD price required'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER price_version_compat_guard BEFORE UPDATE ON zzsh_supply.price_version FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_compat_price_version();
