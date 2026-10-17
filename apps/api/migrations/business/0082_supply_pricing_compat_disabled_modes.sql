-- G3-ext Part1 companion. Existing price_version CHECK stays untouched; this only replaces the
-- validator it calls, relaxing lanes/bounds for DISABLED compatibility modes exactly like the API.
-- Ordinary lane remains mandatory. A fast lane is mandatory only while modes.fast.enabled is true;
-- whenever a fast lane is present it is still validated. min/max of custom/fast are validated only
-- when that mode is enabled (a disabled mode may omit them or carry partial legacy content).
CREATE OR REPLACE FUNCTION zzsh_supply.valid_compat_haff_rule(rule jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE lane text; tier text; mode_name text; map_name text; entry record; cfg jsonb; bound jsonb; p numeric; v numeric; fast_enabled boolean;
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
  -- Relaxed shape: compatibility may carry any subset of the lanes plus the required modes map.
  IF jsonb_typeof(cfg) IS DISTINCT FROM 'object' OR cfg-ARRAY['ordinary','fast','modes']<>'{}'::jsonb
    OR NOT (cfg ? 'modes') OR jsonb_typeof(cfg->'modes') IS DISTINCT FROM 'object'
    OR (cfg->'modes')-ARRAY['ordinary','custom','fast']<>'{}'::jsonb THEN RETURN false; END IF;
  FOREACH mode_name IN ARRAY ARRAY['ordinary','custom','fast'] LOOP
    IF jsonb_typeof(cfg->'modes'->mode_name) IS DISTINCT FROM 'object' OR jsonb_typeof(cfg->'modes'->mode_name->'enabled') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
    IF mode_name='ordinary' THEN
      IF (cfg->'modes'->mode_name)-'enabled'<>'{}'::jsonb THEN RETURN false; END IF;
    ELSE
      -- Disabled modes still limit their configuration keys to enabled/min/max, but their
      -- min/max content is only validated while the mode is enabled.
      IF (cfg->'modes'->mode_name)-ARRAY['enabled','min','max']<>'{}'::jsonb THEN RETURN false; END IF;
      IF (cfg->'modes'->mode_name->>'enabled')::boolean THEN
        FOREACH map_name IN ARRAY ARRAY['min','max'] LOOP
          bound:=cfg->'modes'->mode_name->map_name;
          IF jsonb_typeof(bound) IS DISTINCT FROM 'object' OR bound-ARRAY['base','value']<>'{}'::jsonb
            OR COALESCE(bound->>'base','') NOT IN ('C','ABSOLUTE') OR jsonb_typeof(bound->'value') IS DISTINCT FROM 'string'
            OR (bound->>'value') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,8})?$' THEN RETURN false; END IF;
        END LOOP;
      END IF;
    END IF;
  END LOOP;
  IF NOT EXISTS(SELECT 1 FROM jsonb_each(cfg->'modes') m WHERE m.value->>'enabled'='true') THEN RETURN false; END IF;
  fast_enabled:=(cfg->'modes'->'fast'->>'enabled')::boolean;
  -- Lanes: ordinary is always required; fast is required only while enabled, and is validated
  -- whenever present so a stale lane can never bypass spreadDelta/discount rules.
  IF NOT (cfg ? 'fast') AND fast_enabled THEN RETURN false; END IF;
  FOREACH lane IN ARRAY ARRAY['ordinary','fast'] LOOP
    IF lane='fast' AND NOT (cfg ? 'fast') THEN CONTINUE; END IF;
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
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
