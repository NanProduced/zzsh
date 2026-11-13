-- Candidate: tenant-only STANDARD market price. The caller binds the effective schedule once per read snapshot.
CREATE FUNCTION zzsh_supply.public_market_price(payload jsonb, game_id_value text, price_id_value text)
RETURNS jsonb LANGUAGE plpgsql STABLE STRICT AS $$
DECLARE
  q jsonb:=payload->'quoteValues'; attrs jsonb:=payload#>'{declaration,attributes}';
  c jsonb:=q#>'{pricingInputs,conditions}'; pv zzsh_supply.price_version; fixed boolean;
  rental text:=attrs#>>'{rentalPricing,rentalMode}'; lane text; base numeric; ratio numeric; owner_ratio numeric;
  total numeric; line_count bigint; haff_count bigint; calculated jsonb;
BEGIN
  SELECT * INTO pv FROM zzsh_supply.price_version WHERE id=price_id_value AND game_id=game_id_value
    AND status='SEALED' AND rounding_policy='HALF_UP_CENT_V1';
  IF NOT FOUND OR payload->>'gameId' IS DISTINCT FROM game_id_value
    OR rental IS NULL OR rental NOT IN ('ordinary','custom','fast')
    OR q#>>'{pricingInputs,compatibility,customerTier}' IS DISTINCT FROM 'STANDARD'
    OR q#>>'{pricingInputs,compatibility,rentalMode}' IS DISTINCT FROM rental
    OR c->>'safeBoxCode' IS DISTINCT FROM attrs->>'safe_box_code'
    OR c->>'vitLevel' IS DISTINCT FROM COALESCE(attrs->>'vit_level',attrs->>'vitLevel')
    OR c->>'bearLevel' IS DISTINCT FROM COALESCE(attrs->>'bear_level',attrs->>'bearLevel')
    OR c->>'termOptionCode' IS DISTINCT FROM payload#>>'{declaration,termOptionCode}'
    OR jsonb_typeof(q->'lines') IS DISTINCT FROM 'array'
  THEN RETURN NULL; END IF;
  IF jsonb_array_length(q->'lines') NOT BETWEEN 1 AND 64 THEN RETURN NULL; END IF;
  fixed:=payload->>'schemaVersion'='4';
  IF fixed THEN
    IF pv.mode<>'PERCENT' OR q->>'mode' IS DISTINCT FROM 'PERCENT' OR q->>'schemaVersion' IS DISTINCT FROM '4' OR payload#>>'{pricingPolicy,pricingModel}' IS DISTINCT FROM 'FIXED_FEE'
      OR NOT zzsh_supply.valid_fixed_fee_haff_rule(pv.haff_rule)
      OR NOT zzsh_supply.valid_fixed_fee_rates(pv.fixed_fee_rates)
      OR pv.haff_rule#>>ARRAY['fixedModes',rental,'enabled'] IS DISTINCT FROM 'true'
    THEN RETURN NULL; END IF;
  ELSE
    IF payload->>'schemaVersion' IS DISTINCT FROM '2' OR q->>'mode' IS DISTINCT FROM 'SPREAD'
      OR pv.mode<>'SPREAD' OR pv.fixed_fee_rates IS NOT NULL
      OR NOT zzsh_supply.valid_compat_haff_rule(pv.haff_rule)
      OR pv.haff_rule#>>ARRAY['compatibility','modes',rental,'enabled'] IS DISTINCT FROM 'true'
    THEN RETURN NULL; END IF;
  END IF;
  base:=(pv.haff_rule#>>ARRAY['baseBySafeBox',c->>'safeBoxCode'])::numeric
    +(pv.haff_rule#>>ARRAY['vitalityDeltaByLevel',c->>'vitLevel'])::numeric
    +(pv.haff_rule#>>ARRAY['bearDeltaByLevel',c->>'bearLevel'])::numeric
    +(pv.haff_rule#>>ARRAY['dailyDeltaByTermOption',c->>'termOptionCode'])::numeric;
  owner_ratio:=CASE WHEN rental='ordinary' THEN base ELSE (attrs#>>'{rentalPricing,ownerRatioB}')::numeric END;
  lane:=CASE WHEN rental='fast' THEN 'fast' ELSE 'ordinary' END;
  ratio:=CASE WHEN fixed THEN owner_ratio ELSE owner_ratio
    -(pv.haff_rule#>>ARRAY['compatibility',lane,'spreadDelta'])::numeric
    +(pv.haff_rule#>>ARRAY['compatibility',lane,'discounts','STANDARD'])::numeric END;
  IF base IS NULL OR base<=0 OR ratio IS NULL OR ratio<=0 OR owner_ratio IS NULL OR owner_ratio<ratio THEN RETURN NULL; END IF;

  WITH lines AS (
    SELECT j->>'itemId' AS id, ord,
      CASE WHEN l.pricing_kind='HAFF_RATIO' AND i.unit='HAFF_BASE' AND j->>'unitQuantity'='1000000' AND (j->>'quantity')::numeric>0
        THEN div((j->>'quantity')::numeric*20000+1000000*ratio,2000000*ratio)
        WHEN l.pricing_kind='FIXED_UNIT' AND i.unit IN ('PIECE','DAY','ROUND')
          AND l.buyer_unit_amount>=0 AND (fixed OR l.owner_unit_amount BETWEEN 0 AND l.buyer_unit_amount)
          AND l.unit_quantity=(j->>'unitQuantity')::numeric AND l.unit_quantity>0
        THEN div((j->>'quantity')::numeric*l.buyer_unit_amount*200+l.unit_quantity,2*l.unit_quantity) END AS cents,
      l.pricing_kind='HAFF_RATIO' AS haff,
      CASE WHEN l.pricing_kind='HAFF_RATIO' THEN div(20000000000+ratio,2*ratio)*0.00000001
        ELSE l.buyer_unit_amount END::numeric(72,8) AS unit_yuan
    FROM jsonb_array_elements(q->'lines') WITH ORDINALITY x(j,ord)
    JOIN zzsh_supply.price_line l ON l.price_version_id=pv.id AND l.item_id=j->>'itemId' AND l.customer_tier='STANDARD'
      AND l.pricing_kind=j->>'pricingKind'
    JOIN zzsh_supply.billable_item i ON i.id=l.item_id AND i.game_id=game_id_value AND i.unit=j->>'unit'
    WHERE j->>'quantity' ~ '^(0|[1-9][0-9]{0,23})$'
  )
  SELECT count(DISTINCT id) FILTER (WHERE cents IS NOT NULL AND unit_yuan IS NOT NULL),
    count(*) FILTER (WHERE haff),sum(cents),
    jsonb_agg(jsonb_build_object('itemId',id,'amount',(cents*0.01)::numeric(66,2)::text,'unitAmount',unit_yuan::text) ORDER BY ord)
    INTO line_count,haff_count,total,calculated FROM lines;
  IF line_count<>jsonb_array_length(q->'lines') OR haff_count<>1 OR total IS NULL THEN RETURN NULL; END IF;
  RETURN jsonb_build_object('amount',(total*0.01)::numeric(66,2)::text,
    'ratio',trim_scale(ratio)::text,'lines',calculated);
EXCEPTION WHEN data_exception THEN
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION zzsh_supply.public_market_price(jsonb,text,text) FROM PUBLIC;
COMMENT ON FUNCTION zzsh_supply.public_market_price(jsonb,text,text) IS '同一生效价计算市场公开租金与排序值；押金、会员、号主收入及手续费不进入公开结果。';
