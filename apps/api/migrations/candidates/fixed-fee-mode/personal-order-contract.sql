-- Candidate only. Do not enable v5 inserts until the final-funding and posting guards
-- use this same contract and the complete migration is exercised with runtime ACLs.
CREATE FUNCTION zzsh_order.assert_fixed_fee_personal_order_v5(n zzsh_order.rental_order)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  p jsonb:=n.quote_snapshot->'personal';
  policy jsonb; basis jsonb:=n.quote_snapshot->'settlementPricing'; quote jsonb;
  v zzsh_supply.listing_version; shadow zzsh_order.rental_order;
  effective record; old_policy record; choice jsonb; conditions jsonb;
  mode_value text; base_ratio numeric; ratio_value numeric; rate numeric; payable numeric;
  gross numeric; owner_total numeric; buyer_total numeric; platform_total numeric; expected_fee numeric;
  line_count integer; mismatch boolean; parts jsonb; entry jsonb;
  ids text[]:=ARRAY[]::text[]; bases numeric[]:=ARRAY[]::numeric[]; buyers numeric[]:=ARRAY[]::numeric[];
  capacity numeric[]:=ARRAY[]::numeric[]; discounts numeric[]:=ARRAY[]::numeric[]; take numeric[];
  remaining numeric; weight numeric; taken numeric; remaining_before numeric; i integer; chosen integer; attempts integer;
  haff_line jsonb; exact jsonb; raw_num numeric; raw_den numeric; owner_num numeric; owner_den numeric;
  buyer_num numeric; buyer_den numeric; haff_owner numeric; haff_buyer numeric; haff_base numeric;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->>'schema' IS DISTINCT FROM 'personal-quote-v5'
    OR jsonb_typeof(basis) IS DISTINCT FROM 'object' OR basis->>'schema' IS DISTINCT FROM 'settlement-pricing-v3'
    OR basis-ARRAY['schema','priceVersionId','payableRatio','fixedFeeRate','haff','items'] <> '{}'::jsonb
    OR NOT(basis ?& ARRAY['schema','priceVersionId','payableRatio','fixedFeeRate','haff','items'])
    OR jsonb_typeof(basis->'fixedFeeRate') IS DISTINCT FROM 'string' OR jsonb_typeof(basis->'payableRatio') IS DISTINCT FROM 'string'
    OR n.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '4' OR n.quote_snapshot->>'mode' IS DISTINCT FROM 'PERCENT'
    OR n.quote_snapshot#>>'{pricingInputs,fixedFeeAlgorithm}' IS DISTINCT FROM 'FIXED_TOTAL_V1'
    OR n.quote_snapshot#>>'{pricingInputs,haffRatioSchema}' IS DISTINCT FROM 'haff-ratio-v3'
    OR jsonb_typeof(n.quote_snapshot#>'{pricingInputs,fixedFeeGrossCents}') IS DISTINCT FROM 'string'
    OR COALESCE(n.quote_snapshot#>>'{pricingInputs,fixedFeeGrossCents}','') !~ '^(0|[1-9][0-9]{0,23})$'
  THEN RAISE EXCEPTION 'fixed fee order snapshot invalid' USING ERRCODE='40001'; END IF;

  policy:=p->'pricingPolicy';
  IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
    OR policy - ARRAY['schema','pricingModel','scheduleId','generation','effectiveAt','priceVersionId'] <> '{}'::jsonb
    OR NOT(policy ?& ARRAY['schema','pricingModel','scheduleId','generation','effectiveAt','priceVersionId'])
    OR EXISTS(SELECT 1 FROM jsonb_each(policy) entry WHERE jsonb_typeof(entry.value)<>'string')
    OR policy->>'schema' IS DISTINCT FROM 'pricing-policy-v1' OR policy->>'pricingModel' IS DISTINCT FROM 'FIXED_FEE'
    OR COALESCE(policy->>'scheduleId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR COALESCE(policy->>'priceVersionId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR COALESCE(policy->>'generation','') !~ '^[1-9][0-9]{0,18}$'
    OR jsonb_typeof(policy->'effectiveAt') IS DISTINCT FROM 'string'
  THEN RAISE EXCEPTION 'fixed fee policy reference invalid' USING ERRCODE='40001'; END IF;

  SELECT * INTO v FROM zzsh_supply.listing_version
    WHERE id=n.listing_version_id AND account_id=n.account_id AND content_hash=n.content_hash AND rule_release_id=n.rule_release_id;
  IF NOT FOUND OR v.origin IS DISTINCT FROM 'NATIVE' OR v.schema_version IS DISTINCT FROM 4
    OR v.payload->>'schemaVersion' IS DISTINCT FROM '4' OR v.payload#>>'{quoteValues,schemaVersion}' IS DISTINCT FROM '4'
    OR v.payload#>>'{pricingPolicy,schema}' IS DISTINCT FROM 'pricing-policy-v1'
    OR v.payload#>>'{pricingPolicy,pricingModel}' IS DISTINCT FROM 'FIXED_FEE'
  THEN RAISE EXCEPTION 'fixed fee listing reference invalid' USING ERRCODE='40001'; END IF;
  SELECT s.id,s.generation,s.effective_at,s.price_version_id INTO old_policy
    FROM zzsh_supply.pricing_policy_schedule s
   WHERE s.id=v.payload#>>'{pricingPolicy,scheduleId}' AND s.game_id=n.game_id AND s.pricing_model='FIXED_FEE';
  IF NOT FOUND OR old_policy.generation::text IS DISTINCT FROM v.payload#>>'{pricingPolicy,generation}'
    OR old_policy.effective_at IS DISTINCT FROM (v.payload#>>'{pricingPolicy,effectiveAt}')::timestamptz
    OR old_policy.price_version_id IS DISTINCT FROM v.payload#>>'{pricingPolicy,priceVersionId}'
    OR old_policy.price_version_id IS DISTINCT FROM v.payload#>>'{quoteValues,priceVersionId}'
  THEN RAISE EXCEPTION 'fixed fee original listing policy invalid' USING ERRCODE='40001'; END IF;

  SELECT s.id,s.generation,s.effective_at,s.price_version_id,pv.haff_rule,pv.fixed_fee_rates,pv.rounding_policy
    INTO effective
    FROM zzsh_supply.pricing_policy_schedule s JOIN zzsh_supply.price_version pv ON pv.id=s.price_version_id
   WHERE s.id=(SELECT t.id FROM zzsh_supply.pricing_policy_schedule t
      WHERE t.game_id=n.game_id AND t.pricing_model='FIXED_FEE' AND t.effective_at<=clock_timestamp()
      ORDER BY t.effective_at DESC,t.generation DESC LIMIT 1)
     AND pv.game_id=n.game_id AND pv.status='SEALED' AND pv.mode='PERCENT'
     AND zzsh_supply.valid_fixed_fee_rates(pv.fixed_fee_rates) AND zzsh_supply.valid_fixed_fee_haff_rule(pv.haff_rule);
  IF NOT FOUND OR effective.id IS DISTINCT FROM policy->>'scheduleId'
    OR effective.generation::text IS DISTINCT FROM policy->>'generation'
    OR effective.effective_at IS DISTINCT FROM (policy->>'effectiveAt')::timestamptz
    OR effective.price_version_id IS DISTINCT FROM policy->>'priceVersionId'
    OR effective.price_version_id IS DISTINCT FROM n.quote_snapshot->>'priceVersionId'
    OR basis->>'priceVersionId' IS DISTINCT FROM effective.price_version_id
    OR n.quote_snapshot->>'roundingPolicy' IS DISTINCT FROM effective.rounding_policy
  THEN RAISE EXCEPTION 'fixed fee effective policy changed' USING ERRCODE='40001'; END IF;

  choice:=v.payload#>'{declaration,attributes,rentalPricing}';
  conditions:=n.quote_snapshot#>'{pricingInputs,conditions}';
  mode_value:=choice->>'rentalMode';
  IF mode_value NOT IN ('ordinary','custom','fast') OR mode_value IS NULL
    OR n.quote_snapshot#>>'{pricingInputs,compatibility,rentalMode}' IS DISTINCT FROM mode_value
    OR n.quote_snapshot#>>'{pricingInputs,compatibility,customerTier}' IS DISTINCT FROM 'STANDARD'
    OR n.quote_snapshot#>>'{pricingInputs,compatibility,memberDelta}' IS DISTINCT FROM '0'
    OR effective.haff_rule#>>ARRAY['fixedModes',mode_value,'enabled'] IS DISTINCT FROM 'true'
    OR conditions->>'safeBoxCode' IS DISTINCT FROM v.payload#>>'{declaration,attributes,safe_box_code}'
    OR conditions->>'vitLevel' IS DISTINCT FROM COALESCE(v.payload#>>'{declaration,attributes,vit_level}',v.payload#>>'{declaration,attributes,vitLevel}')
    OR conditions->>'bearLevel' IS DISTINCT FROM COALESCE(v.payload#>>'{declaration,attributes,bear_level}',v.payload#>>'{declaration,attributes,bearLevel}')
    OR conditions->>'termOptionCode' IS DISTINCT FROM v.payload#>>'{declaration,termOptionCode}'
  THEN RAISE EXCEPTION 'fixed fee rental selection invalid' USING ERRCODE='40001'; END IF;
  base_ratio:=(effective.haff_rule#>>ARRAY['baseBySafeBox',conditions->>'safeBoxCode'])::numeric
    +(effective.haff_rule#>>ARRAY['vitalityDeltaByLevel',conditions->>'vitLevel'])::numeric
    +(effective.haff_rule#>>ARRAY['bearDeltaByLevel',conditions->>'bearLevel'])::numeric
    +(effective.haff_rule#>>ARRAY['dailyDeltaByTermOption',conditions->>'termOptionCode'])::numeric;
  ratio_value:=CASE WHEN mode_value='ordinary' THEN base_ratio ELSE (choice->>'ownerRatioB')::numeric END;
  rate:=(effective.fixed_fee_rates->>mode_value)::numeric;
  IF COALESCE(basis->>'payableRatio','') !~ '^(0|1)(\.[0-9]{1,8})?$' THEN
    RAISE EXCEPTION 'fixed fee discount invalid' USING ERRCODE='40001';
  END IF;
  payable:=(basis->>'payableRatio')::numeric;
  IF base_ratio IS NULL OR base_ratio<=0 OR ratio_value IS NULL OR ratio_value<=0
    OR (n.quote_snapshot#>>'{pricingInputs,compatibility,baseRatioC}')::numeric IS DISTINCT FROM base_ratio
    OR (n.quote_snapshot#>>'{pricingInputs,compatibility,ownerRatioB}')::numeric IS DISTINCT FROM ratio_value
    OR (n.quote_snapshot#>>'{pricingInputs,denominators,buyer}')::numeric IS DISTINCT FROM ratio_value
    OR (n.quote_snapshot#>>'{pricingInputs,denominators,owner}')::numeric IS DISTINCT FROM ratio_value
    OR (n.quote_snapshot#>>'{pricingInputs,commissionRate}')::numeric IS DISTINCT FROM rate
    OR (basis->>'fixedFeeRate')::numeric IS DISTINCT FROM rate
    OR payable IS NULL OR payable<=0 OR payable>1 OR 1-payable>rate
  THEN RAISE EXCEPTION 'fixed fee ratio or discount invalid' USING ERRCODE='40001'; END IF;

  quote:=n.quote_snapshot-ARRAY['quoteKind','orderSnapshotSchema','confirmationId','confirmationDigest','confirmationExpiresAt',
    'listingHash','personal','settlementPricing','agreementAcceptanceSchema','agreementAcceptance','earlySettlementDisclosure','fullPayoutTermsAcceptance'];
  IF quote-ARRAY['schemaVersion','currency','priceVersionId','ruleReleaseId','mode','lines','resourceTotal','ownerTotal','platformFullProfit',
    'tenantDeposit','publisherBailRequirement','termSeconds','expiryDisclosures','unitAmountsInformational','roundingPolicy','pricingInputs'] <> '{}'::jsonb
    OR NOT(quote ?& ARRAY['schemaVersion','currency','priceVersionId','ruleReleaseId','mode','lines','resourceTotal','ownerTotal','platformFullProfit',
      'tenantDeposit','publisherBailRequirement','termSeconds','expiryDisclosures','unitAmountsInformational','roundingPolicy','pricingInputs'])
    OR n.quote_snapshot->>'confirmationDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(
      p||jsonb_build_object('quote',quote,'settlementPricing',basis)),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'fixed fee confirmation digest invalid' USING ERRCODE='40001'; END IF;

  -- Reuse the existing identity, entitlement, original terms and funding checks;
  -- the temporary value never replaces the v5 snapshot stored on the order.
  shadow:=n;
  shadow.quote_snapshot:=jsonb_set(jsonb_set(n.quote_snapshot,'{personal}',(p-'pricingPolicy')||jsonb_build_object('schema','personal-quote-v4')),
    '{priceVersionId}',to_jsonb(p#>>'{ruleRefs,priceVersionId}'));
  PERFORM zzsh_order.assert_personal_growth_order_v4(shadow);

  IF jsonb_typeof(quote->'lines') IS DISTINCT FROM 'array' OR jsonb_typeof(basis->'items') IS DISTINCT FROM 'array'
    OR jsonb_array_length(quote->'lines')<1 OR jsonb_array_length(quote->'lines')>64 OR jsonb_array_length(basis->'items')>63
  THEN RAISE EXCEPTION 'fixed fee lines invalid' USING ERRCODE='40001'; END IF;
  SELECT count(*),count(*)<>count(DISTINCT line->>'itemId') OR count(*) FILTER (WHERE line->>'pricingKind'='HAFF_RATIO')<>1
    OR bool_or(COALESCE(line->>'itemId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      OR jsonb_typeof(line->'itemId') IS DISTINCT FROM 'string' OR jsonb_typeof(line->'quantity') IS DISTINCT FROM 'string'
      OR jsonb_typeof(line->'unitQuantity') IS DISTINCT FROM 'string' OR jsonb_typeof(line->'unit') IS DISTINCT FROM 'string'
      OR jsonb_typeof(line->'pricingKind') IS DISTINCT FROM 'string'
      OR COALESCE(line->>'quantity','') !~ '^(0|[1-9][0-9]{0,23})$'
      OR COALESCE(line->>'unitQuantity','') !~ '^[1-9][0-9]{0,23}$'
      OR EXISTS(SELECT 1 FROM unnest(ARRAY['buyerAmount','ownerAmount','platformAmount','buyerUnitAmount','ownerUnitAmount']) k
        WHERE jsonb_typeof(line->k) IS DISTINCT FROM 'object' OR line#>>ARRAY[k,'currency'] IS DISTINCT FROM 'CNY'
          OR line#>>ARRAY[k,'unit'] IS DISTINCT FROM 'yuan' OR jsonb_typeof(line#>ARRAY[k,'amount']) IS DISTINCT FROM 'string'
          OR line#>>ARRAY[k,'scale'] IS DISTINCT FROM CASE WHEN k IN ('buyerUnitAmount','ownerUnitAmount') THEN '8' ELSE '2' END)
      OR COALESCE(line#>>'{buyerAmount,amount}','') !~ '^(0|[1-9][0-9]*)\.[0-9]{2}$'
      OR COALESCE(line#>>'{ownerAmount,amount}','') !~ '^(0|[1-9][0-9]*)\.[0-9]{2}$'
      OR COALESCE(line#>>'{platformAmount,amount}','') !~ '^(0|[1-9][0-9]*)\.[0-9]{2}$')
    INTO line_count,mismatch FROM jsonb_array_elements(quote->'lines') line;
  IF mismatch THEN RAISE EXCEPTION 'fixed fee line shape invalid' USING ERRCODE='40001'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(quote->'lines') q FULL JOIN jsonb_array_elements(v.payload#>'{quoteValues,lines}') original
      ON q->>'itemId'=original->>'itemId'
     WHERE q IS NULL OR original IS NULL OR q->>'quantity' IS DISTINCT FROM original->>'quantity'
       OR q->>'unit' IS DISTINCT FROM original->>'unit' OR q->>'pricingKind' IS DISTINCT FROM original->>'pricingKind'
  ) OR line_count<>jsonb_array_length(v.payload#>'{quoteValues,lines}') THEN
    RAISE EXCEPTION 'fixed fee listing quantities changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(quote->'lines') q
    LEFT JOIN zzsh_supply.price_line l ON l.price_version_id=effective.price_version_id AND l.customer_tier='STANDARD' AND l.item_id=q->>'itemId'
    LEFT JOIN zzsh_supply.billable_item i ON i.id=l.item_id AND i.game_id=n.game_id
    WHERE l.id IS NULL OR i.id IS NULL OR l.pricing_kind IS DISTINCT FROM q->>'pricingKind' OR i.unit IS DISTINCT FROM q->>'unit'
      OR (l.pricing_kind='FIXED_UNIT' AND (l.owner_unit_amount IS NOT NULL OR l.buyer_unit_amount IS NULL
        OR l.unit_quantity IS DISTINCT FROM (q->>'unitQuantity')::numeric
        OR l.buyer_unit_amount IS DISTINCT FROM (q#>>'{buyerUnitAmount,amount}')::numeric
        OR l.buyer_unit_amount IS DISTINCT FROM (q#>>'{ownerUnitAmount,amount}')::numeric))
      OR (l.pricing_kind='HAFF_RATIO' AND (q->>'unit' IS DISTINCT FROM 'HAFF_BASE' OR q->>'unitQuantity' IS DISTINCT FROM '1000000'
        OR (q->>'quantity')::numeric<=0))
  ) THEN RAISE EXCEPTION 'fixed fee current unit prices invalid' USING ERRCODE='40001'; END IF;

  IF jsonb_typeof(basis->'haff') IS DISTINCT FROM 'object'
    OR (basis->'haff')-ARRAY['itemId','openingQuantity','buyerNumerator','buyerDenominator'] <> '{}'::jsonb
    OR NOT ((basis->'haff') ?& ARRAY['itemId','openingQuantity','buyerNumerator','buyerDenominator'])
    OR COALESCE(basis#>>'{haff,buyerNumerator}','') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$'
    OR COALESCE(basis#>>'{haff,buyerDenominator}','') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$'
    OR (basis#>>'{haff,buyerDenominator}')::numeric<=0
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(quote->'lines') q
      WHERE q->>'pricingKind'='HAFF_RATIO' AND q->>'itemId'=basis#>>'{haff,itemId}'
        AND q->>'quantity'=basis#>>'{haff,openingQuantity}'
        AND (basis#>>'{haff,buyerNumerator}')::numeric*1000000*ratio_value
          =(q->>'quantity')::numeric*100*(basis#>>'{haff,buyerDenominator}')::numeric)
  THEN RAISE EXCEPTION 'fixed fee original haff price invalid' USING ERRCODE='40001'; END IF;
  IF (SELECT count(*)<>count(DISTINCT item->>'itemId') FROM jsonb_array_elements(basis->'items') item)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(basis->'items') item
      WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
        OR item-ARRAY['itemId','name','unit','unitQuantity','buyerUnitAmount','ownerUnitAmount'] <> '{}'::jsonb
        OR NOT(item ?& ARRAY['itemId','name','unit','unitQuantity','buyerUnitAmount','ownerUnitAmount']))
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(basis->'items') frozen FULL JOIN (
        SELECT l.item_id,l.unit_quantity,l.buyer_unit_amount,l.owner_unit_amount,i.unit
          FROM zzsh_supply.price_line l JOIN zzsh_supply.billable_item i ON i.id=l.item_id AND i.game_id=n.game_id
         WHERE l.price_version_id=effective.price_version_id AND l.customer_tier='STANDARD' AND l.pricing_kind='FIXED_UNIT'
           AND (i.enabled OR EXISTS(SELECT 1 FROM jsonb_array_elements(quote->'lines') q WHERE q->>'itemId'=l.item_id))
      ) line ON line.item_id=frozen->>'itemId'
      WHERE frozen IS NULL OR line.item_id IS NULL OR line.owner_unit_amount IS NOT NULL OR line.buyer_unit_amount IS NULL
        OR frozen->>'unit' IS DISTINCT FROM line.unit OR (frozen->>'unitQuantity')::numeric IS DISTINCT FROM line.unit_quantity
        OR (frozen->>'buyerUnitAmount')::numeric IS DISTINCT FROM line.buyer_unit_amount
        OR (frozen->>'ownerUnitAmount')::numeric IS DISTINCT FROM line.buyer_unit_amount
    )
  THEN RAISE EXCEPTION 'fixed fee original item prices invalid' USING ERRCODE='40001'; END IF;

  WITH rows AS (
    SELECT q,q->>'itemId' AS item_id,
      CASE WHEN q->>'pricingKind'='HAFF_RATIO' THEN round((q->>'quantity')::numeric*10000/(1000000*ratio_value))
      ELSE round((q->>'quantity')::numeric*(q#>>'{buyerUnitAmount,amount}')::numeric*100/(q->>'unitQuantity')::numeric) END AS base,
      (q#>>'{buyerAmount,amount}')::numeric*100 AS buyer,
      (q#>>'{ownerAmount,amount}')::numeric*100 AS owner,
      (q#>>'{platformAmount,amount}')::numeric*100 AS platform
    FROM jsonb_array_elements(quote->'lines') q
  ), totals AS (SELECT *,sum(base) OVER () AS total FROM rows), shares AS (
    SELECT *,round(total*rate) AS fee,CASE WHEN total=0 THEN 0 ELSE floor(base*round(total*rate)/total) END AS share,
      CASE WHEN total=0 THEN 0 ELSE mod(base*round(total*rate),total) END AS remainder FROM totals
  ), ranked AS (
    SELECT *,sum(share) OVER () AS shares,row_number() OVER (ORDER BY remainder DESC,item_id COLLATE "C") AS rank FROM shares
  )
  SELECT COALESCE(sum(base),0),COALESCE(sum(owner),0),COALESCE(sum(buyer),0),COALESCE(sum(platform),0),
    COALESCE(bool_or(buyer<owner OR buyer>base OR platform<>buyer-owner
      OR owner<>base-share-CASE WHEN rank<=fee-shares THEN 1 ELSE 0 END),false),
    jsonb_agg(jsonb_build_object('itemId',item_id,'base',base,'owner',owner,'buyer',buyer) ORDER BY item_id COLLATE "C")
    INTO gross,owner_total,buyer_total,platform_total,mismatch,parts FROM ranked;
  expected_fee:=round(gross*rate);
  IF mismatch OR gross IS DISTINCT FROM (quote#>>'{pricingInputs,fixedFeeGrossCents}')::numeric
    OR owner_total IS DISTINCT FROM gross-expected_fee OR buyer_total IS DISTINCT FROM round(gross*payable)
    OR buyer_total IS DISTINCT FROM (quote#>>'{resourceTotal,amount}')::numeric*100
    OR owner_total IS DISTINCT FROM (quote#>>'{ownerTotal,amount}')::numeric*100
    OR platform_total IS DISTINCT FROM (quote#>>'{platformFullProfit,amount}')::numeric*100
    OR platform_total IS DISTINCT FROM buyer_total-owner_total
  THEN RAISE EXCEPTION 'fixed fee quote totals invalid' USING ERRCODE='40001'; END IF;

  -- Verify the same capped, deterministic per-line allocation used at confirmation.
  FOR entry IN SELECT value FROM jsonb_array_elements(parts) LOOP
    ids:=array_append(ids,entry->>'itemId');bases:=array_append(bases,(entry->>'base')::numeric);
    buyers:=array_append(buyers,(entry->>'buyer')::numeric);
    capacity:=array_append(capacity,(entry->>'base')::numeric-(entry->>'owner')::numeric);
    discounts:=array_append(discounts,0::numeric);
  END LOOP;
  remaining:=gross-buyer_total;attempts:=line_count+2;
  WHILE remaining>0 LOOP
    attempts:=attempts-1;
    IF attempts<0 THEN RAISE EXCEPTION 'fixed fee discount allocation invalid' USING ERRCODE='40001'; END IF;
    weight:=0;take:=array_fill(0::numeric,ARRAY[line_count]);
    FOR i IN 1..line_count LOOP IF capacity[i]>0 THEN weight:=weight+bases[i]; END IF; END LOOP;
    taken:=0;
    IF weight>0 THEN
      FOR i IN 1..line_count LOOP
        IF capacity[i]>0 THEN take[i]:=LEAST(floor(remaining*bases[i]/weight),capacity[i]);taken:=taken+take[i]; END IF;
      END LOOP;
    END IF;
    IF taken>0 THEN
      FOR i IN 1..line_count LOOP discounts[i]:=discounts[i]+take[i];capacity[i]:=capacity[i]-take[i]; END LOOP;
      remaining:=remaining-taken;
    ELSE
      remaining_before:=remaining;
      FOR chosen IN SELECT idx FROM generate_subscripts(capacity,1) idx WHERE capacity[idx]>0
        ORDER BY CASE WHEN weight>0 THEN mod(remaining*bases[idx],weight) ELSE 0 END DESC,bases[idx] DESC,ids[idx] COLLATE "C"
      LOOP
        EXIT WHEN remaining=0;
        discounts[chosen]:=discounts[chosen]+1;capacity[chosen]:=capacity[chosen]-1;remaining:=remaining-1;
      END LOOP;
      IF remaining=remaining_before THEN RAISE EXCEPTION 'fixed fee discount allocation unavailable' USING ERRCODE='40001'; END IF;
    END IF;
  END LOOP;
  FOR i IN 1..line_count LOOP
    IF buyers[i] IS DISTINCT FROM bases[i]-discounts[i] THEN
      RAISE EXCEPTION 'fixed fee line discount allocation invalid' USING ERRCODE='40001';
    END IF;
  END LOOP;
  IF jsonb_typeof(quote#>'{pricingInputs,exactRatios}') IS DISTINCT FROM 'array'
    OR jsonb_array_length(quote#>'{pricingInputs,exactRatios}')<>1
  THEN RAISE EXCEPTION 'fixed fee exact ratio invalid' USING ERRCODE='40001'; END IF;
  exact:=quote#>'{pricingInputs,exactRatios,0}';
  SELECT q INTO haff_line FROM jsonb_array_elements(quote->'lines') q WHERE q->>'pricingKind'='HAFF_RATIO';
  IF jsonb_typeof(exact) IS DISTINCT FROM 'object' OR exact->>'itemId' IS DISTINCT FROM haff_line->>'itemId'
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['buyerNumerator','buyerDenominator','ownerNumerator','ownerDenominator']) key
      WHERE jsonb_typeof(exact->key) IS DISTINCT FROM 'string' OR COALESCE(exact->>key,'') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$')
    OR (exact->>'buyerDenominator')::numeric<=0 OR (exact->>'ownerDenominator')::numeric<=0
  THEN RAISE EXCEPTION 'fixed fee exact ratio invalid' USING ERRCODE='40001'; END IF;
  raw_num:=(haff_line->>'quantity')::numeric*100;raw_den:=1000000*ratio_value;
  haff_owner:=(haff_line#>>'{ownerAmount,amount}')::numeric*100;
  haff_buyer:=(haff_line#>>'{buyerAmount,amount}')::numeric*100;
  haff_base:=round(raw_num*100/raw_den);
  IF raw_num*100<haff_owner*raw_den THEN owner_num:=raw_num;owner_den:=raw_den;
  ELSE owner_num:=haff_owner;owner_den:=100;END IF;
  IF haff_buyer=haff_base THEN buyer_num:=raw_num;buyer_den:=raw_den;
  ELSIF haff_buyer*owner_den>=100*owner_num THEN buyer_num:=haff_buyer;buyer_den:=100;
  ELSE buyer_num:=owner_num;buyer_den:=owner_den;END IF;
  IF (exact->>'ownerNumerator')::numeric*owner_den IS DISTINCT FROM owner_num*(exact->>'ownerDenominator')::numeric
    OR (exact->>'buyerNumerator')::numeric*buyer_den IS DISTINCT FROM buyer_num*(exact->>'buyerDenominator')::numeric
  THEN RAISE EXCEPTION 'fixed fee exact ratio changed' USING ERRCODE='40001'; END IF;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.assert_fixed_fee_personal_order_v5(zzsh_order.rental_order) FROM PUBLIC;
COMMENT ON FUNCTION zzsh_order.assert_fixed_fee_personal_order_v5(zzsh_order.rental_order)
  IS '校验固定手续费订单的生效政策、原上架和确认快照；不单独启用订单写入。';
