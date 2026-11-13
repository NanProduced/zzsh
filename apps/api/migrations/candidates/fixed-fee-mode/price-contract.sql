-- Candidate only: assign a journal number after integration; do not apply by itself to an existing environment.
CREATE FUNCTION zzsh_supply.valid_fixed_fee_rates(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE mode_name text; rate_text text;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR value - ARRAY['ordinary','custom','fast'] <> '{}'::jsonb THEN RETURN false; END IF;
  FOREACH mode_name IN ARRAY ARRAY['ordinary','custom','fast'] LOOP
    IF jsonb_typeof(value->mode_name) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    rate_text := value->>mode_name;
    IF length(rate_text)>10 OR rate_text !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$'
      OR rate_text::numeric >= 1 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION zzsh_supply.valid_fixed_fee_haff_rule(rule jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE map_name text; mode_name text; bound_name text; entry record; modes jsonb; config jsonb; bound jsonb;
BEGIN
  IF jsonb_typeof(rule) IS DISTINCT FROM 'object' OR rule->>'schema' IS DISTINCT FROM 'haff-ratio-v3'
    OR rule - ARRAY['schema','baseBySafeBox','vitalityDeltaByLevel','bearDeltaByLevel','dailyDeltaByTermOption','fixedModes'] <> '{}'::jsonb THEN RETURN false; END IF;
  FOREACH map_name IN ARRAY ARRAY['baseBySafeBox','vitalityDeltaByLevel','bearDeltaByLevel','dailyDeltaByTermOption'] LOOP
    IF jsonb_typeof(rule->map_name) IS DISTINCT FROM 'object' OR rule->map_name='{}'::jsonb THEN RETURN false; END IF;
    FOR entry IN SELECT * FROM jsonb_each(rule->map_name) LOOP
      IF map_name IN ('vitalityDeltaByLevel','bearDeltaByLevel') AND entry.key !~ '^(0|[1-9][0-9]*)$' THEN RETURN false; END IF;
      IF map_name IN ('baseBySafeBox','dailyDeltaByTermOption') AND entry.key !~ '^[a-z][a-z0-9_:-]{1,63}$' THEN RETURN false; END IF;
      IF jsonb_typeof(entry.value) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      IF map_name='baseBySafeBox' THEN
        IF (entry.value#>>'{}') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$' OR (entry.value#>>'{}')::numeric<=0 THEN RETURN false; END IF;
      ELSIF (entry.value#>>'{}') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,8})?$' THEN RETURN false;
      END IF;
    END LOOP;
  END LOOP;
  modes := rule->'fixedModes';
  IF jsonb_typeof(modes) IS DISTINCT FROM 'object' OR modes - ARRAY['ordinary','custom','fast'] <> '{}'::jsonb THEN RETURN false; END IF;
  FOREACH mode_name IN ARRAY ARRAY['ordinary','custom','fast'] LOOP
    config := modes->mode_name;
    IF jsonb_typeof(config) IS DISTINCT FROM 'object' OR jsonb_typeof(config->'enabled') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
    IF mode_name='ordinary' THEN
      IF config-'enabled'<>'{}'::jsonb THEN RETURN false; END IF;
    ELSE
      IF config-ARRAY['enabled','min','max']<>'{}'::jsonb THEN RETURN false; END IF;
      IF (config->>'enabled')::boolean THEN
        IF NOT (config ? 'min') THEN RETURN false; END IF;
        FOREACH bound_name IN ARRAY ARRAY['min','max'] LOOP
          IF bound_name='max' AND NOT (config ? 'max') THEN CONTINUE; END IF;
          bound := config->bound_name;
          IF jsonb_typeof(bound) IS DISTINCT FROM 'object' OR bound-ARRAY['base','value']<>'{}'::jsonb
            OR COALESCE(bound->>'base','') NOT IN ('C','ABSOLUTE') OR jsonb_typeof(bound->'value') IS DISTINCT FROM 'string'
            OR length(bound->>'value')>33 OR (bound->>'value') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,8})?$' THEN RETURN false; END IF;
        END LOOP;
      END IF;
    END IF;
  END LOOP;
  RETURN EXISTS (SELECT 1 FROM jsonb_each(modes) mode WHERE mode.value->>'enabled'='true');
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
ALTER TABLE zzsh_supply.price_version ADD COLUMN fixed_fee_rates jsonb;
COMMENT ON COLUMN zzsh_supply.price_version.fixed_fee_rates IS '固定手续费模式下普通、自定义和极速出租方式的费率；封存后不可更改。';
ALTER TABLE zzsh_supply.price_version DROP CONSTRAINT price_version_mode_amounts;
ALTER TABLE zzsh_supply.price_version ADD CONSTRAINT price_version_mode_amounts CHECK (COALESCE(
  (mode='SPREAD' AND commission_rate IS NULL AND fixed_fee_rates IS NULL)
  OR (mode='PERCENT' AND fixed_fee_rates IS NULL AND commission_rate IS NOT NULL AND commission_rate>=0 AND commission_rate<1)
  OR (mode='PERCENT' AND commission_rate IS NULL AND zzsh_supply.valid_fixed_fee_rates(fixed_fee_rates)
      AND (haff_rule IS NULL OR haff_rule->>'schema'='haff-ratio-v3')
      AND (status='DRAFT' OR haff_rule IS NOT NULL)), false));
ALTER TABLE zzsh_supply.price_version DROP CONSTRAINT price_version_haff_rule_shape;
ALTER TABLE zzsh_supply.price_version ADD CONSTRAINT price_version_haff_rule_shape CHECK (COALESCE(
  haff_rule IS NULL
  OR (fixed_fee_rates IS NULL AND jsonb_typeof(haff_rule)='object' AND haff_rule->>'schema'='haff-ratio-v1')
  OR (fixed_fee_rates IS NULL AND mode='SPREAD' AND zzsh_supply.valid_compat_haff_rule(haff_rule))
  OR (mode='PERCENT' AND fixed_fee_rates IS NOT NULL AND zzsh_supply.valid_fixed_fee_haff_rule(haff_rule)), false));
--> statement-breakpoint
CREATE FUNCTION zzsh_supply.guard_fixed_fee_price_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fixed_fee_rates IS NOT NULL AND NEW.status='SEALED' THEN RAISE EXCEPTION 'fixed fee price version must be sealed from a draft'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER price_version_fixed_fee_guard BEFORE INSERT ON zzsh_supply.price_version
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_fixed_fee_price_version();
COMMENT ON FUNCTION zzsh_supply.valid_fixed_fee_rates(jsonb) IS '校验三种出租方式的固定手续费率。';
COMMENT ON FUNCTION zzsh_supply.valid_fixed_fee_haff_rule(jsonb) IS '校验固定手续费模式的哈夫币比例规则。';
COMMENT ON FUNCTION zzsh_supply.guard_fixed_fee_price_version() IS '固定手续费价格版本必须先建草稿再封存。';
