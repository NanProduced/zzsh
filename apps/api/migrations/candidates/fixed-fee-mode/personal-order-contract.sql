-- Candidate only. Do not enable v5 inserts until the final-funding and posting guards
-- use this same contract and the complete migration is exercised with runtime ACLs.
-- This v5-only identity/funding verifier mirrors 0078 exactly except for the separately bound listing price.
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_class c ON c.oid=to_regclass('zzsh_order.rental_order')
    WHERE p.oid=to_regprocedure('zzsh_order.assert_personal_growth_order_v4(zzsh_order.rental_order)')
      AND p.proowner=c.relowner AND NOT p.prosecdef
      AND encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')='96c5c3783b5b94db1e3aabf7e7d4a88e74183c06291fc03fe00e550b39f3c8a4')
  THEN RAISE EXCEPTION 'personal quote v4 base contract changed' USING ERRCODE='40001'; END IF;
END $check$;
CREATE FUNCTION zzsh_order.assert_personal_growth_for_fixed_fee_v5(n zzsh_order.rental_order, expected_listing_price_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE p jsonb:=n.quote_snapshot->'personal';g jsonb;b jsonb;f jsonb;r jsonb;d jsonb;v zzsh_supply.listing_version;k int;
BEGIN
 g:=p->'membershipGrowth';b:=g->'binding';f:=p->'funding';r:=p->'ruleRefs';d:=p->'fullPayoutDeclaration';
 IF n.confirmation_id IS NULL OR n.quote_snapshot->>'quoteKind' IS DISTINCT FROM 'ORDER_CONFIRMATION' OR n.quote_snapshot->>'confirmationId' IS DISTINCT FROM n.confirmation_id::text
  OR n.quote_snapshot->>'orderSnapshotSchema' IS DISTINCT FROM '1' OR COALESCE(n.quote_snapshot->>'confirmationDigest','')!~'^[a-f0-9]{64}$'
  OR p->>'schema' IS DISTINCT FROM 'personal-quote-v4' OR n.quote_snapshot?'confirmationToken' OR n.quote_snapshot?'signature'
  OR p?'membership' OR p->>'userId' IS DISTINCT FROM n.renter_user_id OR p->>'ownerUserId' IS DISTINCT FROM n.owner_user_id OR p->>'accountId' IS DISTINCT FROM n.account_id
  OR p->>'listingVersionId' IS DISTINCT FROM n.listing_version_id OR p->>'listingHash' IS DISTINCT FROM n.content_hash OR n.quote_snapshot->>'listingHash' IS DISTINCT FROM n.content_hash
  OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(g) IS DISTINCT FROM 'object' OR jsonb_typeof(b) IS DISTINCT FROM 'object'
  OR jsonb_typeof(f) IS DISTINCT FROM 'object' OR jsonb_typeof(r) IS DISTINCT FROM 'object' OR jsonb_typeof(d) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'personal quote v4 binding invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(p);
 IF k<>11 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE NOT(x=ANY(ARRAY['schema','userId','ownerUserId','accountId','listingVersionId','listingHash','fullPayoutDeclaration','ruleRefs','membershipGrowth','guarantee','funding'])))
  THEN RAISE EXCEPTION 'personal quote v4 shape invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(d);
 IF k<>2 OR d->>'schema' IS DISTINCT FROM 'full-payout-declaration-v1' OR jsonb_typeof(d->'selected') IS DISTINCT FROM 'boolean'
  THEN RAISE EXCEPTION 'personal quote v4 declaration invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(r);
 IF k<>5 OR EXISTS(SELECT 1 FROM jsonb_object_keys(r) x WHERE NOT(x=ANY(ARRAY['releaseId','priceVersionId','termVersionId','agreementVersionId','agreementDigest'])))
  OR EXISTS(SELECT 1 FROM jsonb_each(r) x WHERE jsonb_typeof(x.value)<>'string' OR length(trim(x.value#>>'{}'))=0)
  OR r->>'releaseId' IS DISTINCT FROM n.rule_release_id OR r->>'priceVersionId' IS DISTINCT FROM n.quote_snapshot->>'priceVersionId' OR COALESCE(r->>'agreementDigest','')!~'^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'personal quote v4 rules invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(f);
 IF k<>7 OR EXISTS(SELECT 1 FROM jsonb_object_keys(f) x WHERE NOT(x=ANY(ARRAY['version','sourceRef','baseDepositCents','publisherBailRequirementCents','fullPayoutPolicyRef','fullPayoutPolicyVersion','disclosureVersion'])))
  OR EXISTS(SELECT 1 FROM jsonb_each(f) x WHERE jsonb_typeof(x.value)<>'string' OR length(trim(x.value#>>'{}'))=0)
  OR COALESCE(f->>'baseDepositCents','')!~'^(0|[1-9][0-9]{0,17})$' OR COALESCE(f->>'publisherBailRequirementCents','')!~'^(0|[1-9][0-9]{0,17})$'
  THEN RAISE EXCEPTION 'personal quote v4 funding invalid' USING ERRCODE='40001';END IF;
 IF jsonb_typeof(p->'guarantee') IS DISTINCT FROM 'object' OR COALESCE(p#>>'{guarantee,status}','') NOT IN('SATISFIED','NOT_REQUIRED') OR COALESCE(p#>>'{guarantee,reference}','')=''
  THEN RAISE EXCEPTION 'personal quote v4 guarantee invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(p->'guarantee');IF k<>2 THEN RAISE EXCEPTION 'personal quote v4 guarantee shape invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(g);
 IF k<>16 OR EXISTS(SELECT 1 FROM jsonb_object_keys(g) x WHERE NOT(x=ANY(ARRAY['schema','policyVersion','effectiveTier','policyTier','selectedSource','depositSource','entitlementIds','binding','selectedBenefitVersion','selectedEntitlementId','selectedValidUntil','depositBenefitVersion','depositEntitlementId','depositValidUntil','pricePlanDigest','depositCents'])))
  OR g->>'schema' IS DISTINCT FROM 'membership-growth-v2' OR COALESCE(g->>'policyVersion','')!~'^[1-9][0-9]{0,18}$'
  OR COALESCE(g->>'effectiveTier','') NOT IN('STANDARD','SILVER','GOLD','PLATINUM','DIAMOND','BLACK_GOLD')
  OR g->>'policyTier' IS DISTINCT FROM(CASE WHEN g->>'effectiveTier'='BLACK_GOLD' THEN 'DIAMOND' ELSE g->>'effectiveTier' END)
  OR COALESCE(g->>'selectedSource','') NOT IN('GROWTH','FRIEND','PRESTIGE') OR COALESCE(g->>'depositSource','') NOT IN('GROWTH','FRIEND','PRESTIGE')
  OR COALESCE(g->>'selectedBenefitVersion','')='' OR COALESCE(g->>'depositBenefitVersion','')='' OR COALESCE(g->>'pricePlanDigest','')!~'^[a-f0-9]{64}$'
  OR jsonb_typeof(g->'entitlementIds') IS DISTINCT FROM 'array' OR COALESCE(g->>'depositCents','')!~'^(0|[1-9][0-9]{0,23})$'
  THEN RAISE EXCEPTION 'personal quote v4 growth invalid' USING ERRCODE='40001';END IF;
 IF jsonb_typeof(g->'selectedEntitlementId') NOT IN('null','string') OR jsonb_typeof(g->'depositEntitlementId') NOT IN('null','string') OR jsonb_typeof(g->'selectedValidUntil') NOT IN('null','string') OR jsonb_typeof(g->'depositValidUntil') NOT IN('null','string')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(g->'entitlementIds') e WHERE jsonb_typeof(e)<>'string' OR COALESCE(e#>>'{}','')='')
  OR EXISTS(SELECT 1 FROM (SELECT x.source,x.ref,x.until FROM(VALUES(g->>'selectedSource',g->>'selectedEntitlementId',g->>'selectedValidUntil'),(g->>'depositSource',g->>'depositEntitlementId',g->>'depositValidUntil'))x(source,ref,until))z
    WHERE(z.source='GROWTH' AND(z.ref IS NOT NULL OR z.until IS NOT NULL)) OR(z.source<>'GROWTH' AND(z.ref IS NULL OR z.until IS NULL OR NOT(g->'entitlementIds'?z.ref) OR z.until::timestamptz<=clock_timestamp())))
  THEN RAISE EXCEPTION 'personal quote v4 entitlement invalid or expired' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(b);
 IF k<>6 OR b->>'userId' IS DISTINCT FROM n.renter_user_id OR b->>'ownerUserId' IS DISTINCT FROM n.owner_user_id OR b->>'accountId' IS DISTINCT FROM n.account_id
  OR b->>'listingVersionId' IS DISTINCT FROM n.listing_version_id OR b->>'ruleReleaseId' IS DISTINCT FROM n.rule_release_id OR COALESCE(b->>'quantityDigest','')!~'^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'personal quote v4 offer binding invalid' USING ERRCODE='40001';END IF;
 IF n.quote_snapshot->>'currency' IS DISTINCT FROM 'CNY' OR n.currency IS DISTINCT FROM 'CNY' OR n.quote_snapshot->>'ruleReleaseId' IS DISTINCT FROM n.rule_release_id OR n.quote_snapshot->>'termSeconds' IS DISTINCT FROM n.term_seconds::text
  OR n.quote_snapshot#>>'{tenantDeposit,currency}' IS DISTINCT FROM 'CNY' OR n.quote_snapshot#>>'{tenantDeposit,unit}' IS DISTINCT FROM 'yuan' OR n.quote_snapshot#>>'{tenantDeposit,scale}' IS DISTINCT FROM '2'
  OR COALESCE(n.quote_snapshot#>>'{tenantDeposit,amount}','')!~'^(0|[1-9][0-9]*)\.[0-9]{2}$' OR(n.quote_snapshot#>>'{tenantDeposit,amount}')::numeric*100 IS DISTINCT FROM n.deposit_amount_cents
  OR n.quote_snapshot#>>'{resourceTotal,currency}' IS DISTINCT FROM 'CNY' OR n.quote_snapshot#>>'{resourceTotal,unit}' IS DISTINCT FROM 'yuan' OR n.quote_snapshot#>>'{resourceTotal,scale}' IS DISTINCT FROM '2'
  OR COALESCE(n.quote_snapshot#>>'{resourceTotal,amount}','')!~'^(0|[1-9][0-9]*)\.[0-9]{2}$' OR(g->>'depositCents')::numeric IS DISTINCT FROM n.deposit_amount_cents OR(n.quote_snapshot#>>'{resourceTotal,amount}')::numeric*100 IS DISTINCT FROM n.rental_amount_cents
  THEN RAISE EXCEPTION 'personal quote v4 quote amounts invalid' USING ERRCODE='40001';END IF;
 SELECT * INTO v FROM zzsh_supply.listing_version WHERE id=n.listing_version_id AND account_id=n.account_id AND content_hash=n.content_hash AND rule_release_id=n.rule_release_id;
 IF NOT FOUND OR v.payload->>'accountId' IS DISTINCT FROM n.account_id OR v.payload->>'gameId' IS DISTINCT FROM n.game_id
  OR v.payload#>>'{ruleRefs,releaseId}' IS DISTINCT FROM r->>'releaseId' OR v.payload#>>'{ruleRefs,priceVersionId}' IS DISTINCT FROM r->>'priceVersionId'
  OR v.payload#>>'{ruleRefs,termVersionId}' IS DISTINCT FROM r->>'termVersionId' OR v.payload#>>'{ruleRefs,agreementVersionId}' IS DISTINCT FROM r->>'agreementVersionId'
  OR v.payload#>>'{ruleRefs,agreementDigest}' IS DISTINCT FROM r->>'agreementDigest' OR v.payload#>'{declaration,attributes,full_payout_declaration}' IS DISTINCT FROM d
  OR v.payload#>>'{quoteValues,priceVersionId}' IS DISTINCT FROM expected_listing_price_id OR v.payload#>>'{quoteValues,termSeconds}' IS DISTINCT FROM n.term_seconds::text
  OR b->>'quantityDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(v.payload#>'{quoteValues,lines}'),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'personal quote v4 listing reference invalid' USING ERRCODE='40001';END IF;
 IF COALESCE(n.quote_snapshot->>'confirmationExpiresAt','')!~'^[1-9][0-9]{0,11}$' OR(n.quote_snapshot->>'confirmationExpiresAt')::numeric<=extract(epoch FROM clock_timestamp())
  THEN RAISE EXCEPTION 'personal confirmation expired' USING ERRCODE='40001';END IF;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.assert_personal_growth_for_fixed_fee_v5(zzsh_order.rental_order,text) FROM PUBLIC;
COMMENT ON FUNCTION zzsh_order.assert_personal_growth_for_fixed_fee_v5(zzsh_order.rental_order,text)
  IS '固定手续费复用旧版身份与条款约束，单独核对已验证的上架价格版本。';
--> statement-breakpoint

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

  SELECT lv.* INTO v FROM zzsh_supply.listing_version lv
    JOIN zzsh_supply.listing_publication pub ON pub.version_id=lv.id AND pub.account_id=lv.account_id
      AND pub.owner_user_id=n.owner_user_id AND pub.game_id=n.game_id AND pub.rule_release_id=n.rule_release_id
      AND pub.content_hash=n.content_hash AND pub.source='OWNER_DIRECT'
    WHERE lv.id=n.listing_version_id AND lv.account_id=n.account_id AND lv.content_hash=n.content_hash AND lv.rule_release_id=n.rule_release_id
      AND lv.review_state='PUBLISHED'
      AND (lv.payload#>>'{pricingPolicy,effectiveAt}')::timestamptz<=pub.published_at;
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
   WHERE s.id=old_policy.id AND policy IS NOT DISTINCT FROM v.payload->'pricingPolicy'
     AND pv.game_id=n.game_id AND pv.status='SEALED' AND pv.mode='PERCENT'
     AND zzsh_supply.valid_fixed_fee_rates(pv.fixed_fee_rates) AND zzsh_supply.valid_fixed_fee_haff_rule(pv.haff_rule);
  IF NOT FOUND OR effective.id IS DISTINCT FROM policy->>'scheduleId'
    OR effective.generation::text IS DISTINCT FROM policy->>'generation'
    OR effective.effective_at IS DISTINCT FROM (policy->>'effectiveAt')::timestamptz
    OR effective.price_version_id IS DISTINCT FROM policy->>'priceVersionId'
    OR effective.price_version_id IS DISTINCT FROM n.quote_snapshot->>'priceVersionId'
    OR basis->>'priceVersionId' IS DISTINCT FROM effective.price_version_id
    OR n.quote_snapshot->>'roundingPolicy' IS DISTINCT FROM effective.rounding_policy
  THEN RAISE EXCEPTION 'fixed fee published policy differs' USING ERRCODE='40001'; END IF;

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
  PERFORM zzsh_order.assert_personal_growth_for_fixed_fee_v5(shadow,old_policy.price_version_id);

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

  -- div truncates the exact rational result; numeric / can round before the final cent rounding.
  WITH rows AS (
    SELECT q,q->>'itemId' AS item_id,
      CASE WHEN q->>'pricingKind'='HAFF_RATIO' THEN div((q->>'quantity')::numeric*20000+1000000*ratio_value,2000000*ratio_value)
      ELSE div((q->>'quantity')::numeric*(q#>>'{buyerUnitAmount,amount}')::numeric*200+(q->>'unitQuantity')::numeric,2*(q->>'unitQuantity')::numeric) END AS base,
      (q#>>'{buyerAmount,amount}')::numeric*100 AS buyer,
      (q#>>'{ownerAmount,amount}')::numeric*100 AS owner,
      (q#>>'{platformAmount,amount}')::numeric*100 AS platform
    FROM jsonb_array_elements(quote->'lines') q
  ), totals AS (SELECT *,sum(base) OVER () AS total FROM rows), shares AS (
    SELECT *,round(total*rate) AS fee,CASE WHEN total=0 THEN 0 ELSE div(base*round(total*rate),total) END AS share,
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
        IF capacity[i]>0 THEN take[i]:=LEAST(div(remaining*bases[i],weight),capacity[i]);taken:=taken+take[i]; END IF;
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
  haff_base:=div(raw_num*200+raw_den,raw_den*2);
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

--> statement-breakpoint
-- Scheduled spread retains the accepted listing selection while binding the current price separately.
-- New v6 discounts use the stable item-id tie break; earlier v4/v5 snapshots are unchanged.
CREATE FUNCTION zzsh_order.assert_scheduled_spread_order_v6(n zzsh_order.rental_order)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  p jsonb:=n.quote_snapshot->'personal'; policy jsonb; basis jsonb:=n.quote_snapshot->'settlementPricing';
  quote jsonb; v zzsh_supply.listing_version; shadow zzsh_order.rental_order; published_at timestamptz;
  old_policy record; effective record; choice jsonb; conditions jsonb; mode_value text;
  base_ratio numeric; owner_ratio numeric; buyer_ratio numeric; spread numeric; payable numeric;
  line_count integer; mismatch boolean; parts jsonb; entry jsonb;
  ids text[]:=ARRAY[]::text[]; bases numeric[]:=ARRAY[]::numeric[]; buyers numeric[]:=ARRAY[]::numeric[];
  owners numeric[]:=ARRAY[]::numeric[]; capacity numeric[]:=ARRAY[]::numeric[]; discounts numeric[]:=ARRAY[]::numeric[];
  remaining numeric; weight numeric; taken numeric; remaining_before numeric; take numeric[]; attempts integer;
  gross numeric; owner_total numeric; buyer_total numeric; platform_total numeric; i integer; chosen integer;
  haff_line jsonb; exact jsonb; owner_num numeric; owner_den numeric; buyer_num numeric; buyer_den numeric; base_haff numeric;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->>'schema' IS DISTINCT FROM 'personal-quote-v6'
    OR jsonb_typeof(basis) IS DISTINCT FROM 'object' OR basis->>'schema' IS DISTINCT FROM 'settlement-pricing-v1'
    OR basis-ARRAY['schema','priceVersionId','payableRatio','haff','items'] <> '{}'::jsonb
    OR NOT(basis ?& ARRAY['schema','priceVersionId','payableRatio','haff','items'])
    OR jsonb_typeof(basis->'payableRatio') IS DISTINCT FROM 'string'
    OR n.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '2' OR n.quote_snapshot->>'mode' IS DISTINCT FROM 'SPREAD'
    OR n.quote_snapshot#>>'{pricingInputs,haffRatioSchema}' IS DISTINCT FROM 'haff-ratio-v2'
    OR n.quote_snapshot#>'{pricingInputs,commissionRate}' IS DISTINCT FROM 'null'::jsonb
  THEN RAISE EXCEPTION 'scheduled spread order snapshot invalid' USING ERRCODE='40001'; END IF;

  policy:=p->'pricingPolicy';
  IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
    OR policy-ARRAY['schema','pricingModel','scheduleId','generation','effectiveAt','priceVersionId'] <> '{}'::jsonb
    OR NOT(policy ?& ARRAY['schema','pricingModel','scheduleId','generation','effectiveAt','priceVersionId'])
    OR EXISTS(SELECT 1 FROM jsonb_each(policy) e WHERE jsonb_typeof(e.value)<>'string')
    OR policy->>'schema' IS DISTINCT FROM 'pricing-policy-v1' OR policy->>'pricingModel' IS DISTINCT FROM 'SPREAD'
    OR COALESCE(policy->>'scheduleId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR COALESCE(policy->>'priceVersionId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR COALESCE(policy->>'generation','') !~ '^[1-9][0-9]{0,18}$'
  THEN RAISE EXCEPTION 'scheduled spread policy reference invalid' USING ERRCODE='40001'; END IF;

  SELECT lv.* INTO v FROM zzsh_supply.listing_version lv
    JOIN zzsh_supply.listing_publication pub ON pub.version_id=lv.id AND pub.account_id=lv.account_id
      AND pub.owner_user_id=n.owner_user_id AND pub.game_id=n.game_id AND pub.rule_release_id=n.rule_release_id
      AND pub.content_hash=n.content_hash AND pub.source='OWNER_DIRECT'
   WHERE lv.id=n.listing_version_id AND lv.account_id=n.account_id AND lv.content_hash=n.content_hash
     AND lv.rule_release_id=n.rule_release_id AND lv.origin='NATIVE' AND lv.schema_version=2 AND lv.review_state='PUBLISHED';
  IF NOT FOUND OR v.payload->>'schemaVersion' IS DISTINCT FROM '2' OR v.payload#>>'{quoteValues,schemaVersion}' IS DISTINCT FROM '2'
    OR v.payload#>>'{quoteValues,mode}' IS DISTINCT FROM 'SPREAD'
    OR n.content_hash IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(v.payload),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'scheduled spread listing reference invalid' USING ERRCODE='40001'; END IF;
  SELECT pub.published_at INTO published_at FROM zzsh_supply.listing_publication pub
    WHERE pub.version_id=v.id AND pub.account_id=n.account_id AND pub.owner_user_id=n.owner_user_id AND pub.game_id=n.game_id
      AND pub.rule_release_id=n.rule_release_id AND pub.content_hash=n.content_hash AND pub.source='OWNER_DIRECT' LIMIT 1;

  SELECT s.id,s.generation,s.effective_at,s.price_version_id INTO old_policy FROM zzsh_supply.pricing_policy_schedule s
    WHERE s.id=v.payload#>>'{pricingPolicy,scheduleId}' AND s.game_id=n.game_id AND s.pricing_model='SPREAD';
  IF NOT FOUND OR v.payload#>>'{pricingPolicy,schema}' IS DISTINCT FROM 'pricing-policy-v1'
    OR v.payload#>>'{pricingPolicy,pricingModel}' IS DISTINCT FROM 'SPREAD'
    OR old_policy.generation::text IS DISTINCT FROM v.payload#>>'{pricingPolicy,generation}'
    OR old_policy.effective_at IS DISTINCT FROM (v.payload#>>'{pricingPolicy,effectiveAt}')::timestamptz
    OR old_policy.effective_at>published_at OR old_policy.price_version_id IS DISTINCT FROM v.payload#>>'{pricingPolicy,priceVersionId}'
    OR old_policy.price_version_id IS DISTINCT FROM v.payload#>>'{quoteValues,priceVersionId}'
  THEN RAISE EXCEPTION 'scheduled spread original listing policy invalid' USING ERRCODE='40001'; END IF;

  SELECT s.id,s.generation,s.effective_at,s.price_version_id,pv.haff_rule,pv.rounding_policy INTO effective
    FROM zzsh_supply.pricing_policy_schedule s JOIN zzsh_supply.price_version pv ON pv.id=s.price_version_id AND pv.game_id=s.game_id
   WHERE s.id=old_policy.id AND policy IS NOT DISTINCT FROM v.payload->'pricingPolicy'
     AND pv.status='SEALED' AND pv.mode='SPREAD' AND pv.fixed_fee_rates IS NULL AND zzsh_supply.valid_compat_haff_rule(pv.haff_rule);
  IF NOT FOUND OR effective.id IS DISTINCT FROM policy->>'scheduleId' OR effective.generation::text IS DISTINCT FROM policy->>'generation'
    OR effective.effective_at IS DISTINCT FROM (policy->>'effectiveAt')::timestamptz OR effective.price_version_id IS DISTINCT FROM policy->>'priceVersionId'
    OR effective.price_version_id IS DISTINCT FROM n.quote_snapshot->>'priceVersionId' OR basis->>'priceVersionId' IS DISTINCT FROM effective.price_version_id
    OR effective.rounding_policy IS DISTINCT FROM 'HALF_UP_CENT_V1' OR n.quote_snapshot->>'roundingPolicy' IS DISTINCT FROM effective.rounding_policy
  THEN RAISE EXCEPTION 'scheduled spread published policy differs' USING ERRCODE='40001'; END IF;

  quote:=n.quote_snapshot-ARRAY['quoteKind','orderSnapshotSchema','confirmationId','confirmationDigest','confirmationExpiresAt',
    'listingHash','personal','settlementPricing','agreementAcceptanceSchema','agreementAcceptance','earlySettlementDisclosure','fullPayoutTermsAcceptance'];
  IF quote-ARRAY['schemaVersion','currency','priceVersionId','ruleReleaseId','mode','lines','resourceTotal','ownerTotal','platformFullProfit',
    'tenantDeposit','publisherBailRequirement','termSeconds','expiryDisclosures','unitAmountsInformational','roundingPolicy','pricingInputs'] <> '{}'::jsonb
    OR NOT(quote ?& ARRAY['schemaVersion','currency','priceVersionId','ruleReleaseId','mode','lines','resourceTotal','ownerTotal','platformFullProfit',
      'tenantDeposit','publisherBailRequirement','termSeconds','expiryDisclosures','unitAmountsInformational','roundingPolicy','pricingInputs'])
    OR n.quote_snapshot->>'confirmationDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(
      p||jsonb_build_object('quote',quote,'settlementPricing',basis)),'UTF8')),'hex')
    OR quote->'expiryDisclosures' IS DISTINCT FROM v.payload#>'{quoteValues,expiryDisclosures}'
  THEN RAISE EXCEPTION 'scheduled spread confirmation digest invalid' USING ERRCODE='40001'; END IF;
  shadow:=n;
  shadow.quote_snapshot:=jsonb_set(jsonb_set(n.quote_snapshot,'{personal}',(p-'pricingPolicy')||jsonb_build_object('schema','personal-quote-v4')),
    '{priceVersionId}',to_jsonb(p#>>'{ruleRefs,priceVersionId}'));
  PERFORM zzsh_order.assert_personal_growth_for_fixed_fee_v5(shadow,v.payload#>>'{quoteValues,priceVersionId}');

  choice:=v.payload#>'{declaration,attributes,rentalPricing}';conditions:=quote#>'{pricingInputs,conditions}';mode_value:=choice->>'rentalMode';
  IF mode_value NOT IN ('ordinary','custom','fast') OR mode_value IS NULL
    OR v.payload#>>'{quoteValues,pricingInputs,compatibility,rentalMode}' IS DISTINCT FROM mode_value
    OR v.payload#>>'{quoteValues,pricingInputs,compatibility,customerTier}' IS DISTINCT FROM 'STANDARD'
    OR (mode_value<>'ordinary' AND v.payload#>>'{quoteValues,pricingInputs,compatibility,ownerRatioB}' IS DISTINCT FROM choice->>'ownerRatioB')
    OR v.payload#>>'{quoteValues,pricingInputs,conditions,safeBoxCode}' IS DISTINCT FROM v.payload#>>'{declaration,attributes,safe_box_code}'
    OR v.payload#>>'{quoteValues,pricingInputs,conditions,vitLevel}' IS DISTINCT FROM COALESCE(v.payload#>>'{declaration,attributes,vit_level}',v.payload#>>'{declaration,attributes,vitLevel}')
    OR v.payload#>>'{quoteValues,pricingInputs,conditions,bearLevel}' IS DISTINCT FROM COALESCE(v.payload#>>'{declaration,attributes,bear_level}',v.payload#>>'{declaration,attributes,bearLevel}')
    OR v.payload#>>'{quoteValues,pricingInputs,conditions,termOptionCode}' IS DISTINCT FROM v.payload#>>'{declaration,termOptionCode}'
    OR quote#>>'{pricingInputs,compatibility,rentalMode}' IS DISTINCT FROM mode_value
    OR quote#>>'{pricingInputs,compatibility,customerTier}' IS DISTINCT FROM 'STANDARD'
    OR quote#>>'{pricingInputs,compatibility,memberDelta}' IS DISTINCT FROM '0'
    OR effective.haff_rule#>>ARRAY['compatibility','modes',mode_value,'enabled'] IS DISTINCT FROM 'true'
    OR conditions->>'safeBoxCode' IS DISTINCT FROM v.payload#>>'{declaration,attributes,safe_box_code}'
    OR conditions->>'vitLevel' IS DISTINCT FROM COALESCE(v.payload#>>'{declaration,attributes,vit_level}',v.payload#>>'{declaration,attributes,vitLevel}')
    OR conditions->>'bearLevel' IS DISTINCT FROM COALESCE(v.payload#>>'{declaration,attributes,bear_level}',v.payload#>>'{declaration,attributes,bearLevel}')
    OR conditions->>'termOptionCode' IS DISTINCT FROM v.payload#>>'{declaration,termOptionCode}'
    OR COALESCE(basis->>'payableRatio','') !~ '^(0|1)(\.[0-9]{1,8})?$'
  THEN RAISE EXCEPTION 'scheduled spread rental selection invalid' USING ERRCODE='40001'; END IF;
  base_ratio:=(effective.haff_rule#>>ARRAY['baseBySafeBox',conditions->>'safeBoxCode'])::numeric
    +(effective.haff_rule#>>ARRAY['vitalityDeltaByLevel',conditions->>'vitLevel'])::numeric
    +(effective.haff_rule#>>ARRAY['bearDeltaByLevel',conditions->>'bearLevel'])::numeric
    +(effective.haff_rule#>>ARRAY['dailyDeltaByTermOption',conditions->>'termOptionCode'])::numeric;
  owner_ratio:=CASE WHEN mode_value='ordinary' THEN base_ratio ELSE (choice->>'ownerRatioB')::numeric END;
  spread:=(effective.haff_rule#>>ARRAY['compatibility',CASE WHEN mode_value='fast' THEN 'fast' ELSE 'ordinary' END,'spreadDelta'])::numeric;
  buyer_ratio:=owner_ratio-spread;payable:=(basis->>'payableRatio')::numeric;
  IF base_ratio IS NULL OR base_ratio<=0 OR owner_ratio IS NULL OR owner_ratio<=0 OR buyer_ratio IS NULL OR buyer_ratio<=0
    OR payable IS NULL OR payable<=0 OR payable>1
    OR (quote#>>'{pricingInputs,compatibility,baseRatioC}')::numeric IS DISTINCT FROM base_ratio
    OR (quote#>>'{pricingInputs,compatibility,ownerRatioB}')::numeric IS DISTINCT FROM owner_ratio
    OR (quote#>>'{pricingInputs,denominators,buyer}')::numeric IS DISTINCT FROM buyer_ratio
    OR (quote#>>'{pricingInputs,denominators,owner}')::numeric IS DISTINCT FROM owner_ratio
    OR (quote#>>'{pricingInputs,spreadDelta}')::numeric IS DISTINCT FROM spread
  THEN RAISE EXCEPTION 'scheduled spread ratios invalid' USING ERRCODE='40001'; END IF;

  IF jsonb_typeof(quote->'lines') IS DISTINCT FROM 'array' OR jsonb_typeof(basis->'items') IS DISTINCT FROM 'array'
    OR jsonb_array_length(quote->'lines')<1 OR jsonb_array_length(quote->'lines')>64 OR jsonb_array_length(basis->'items')>63
  THEN RAISE EXCEPTION 'scheduled spread lines invalid' USING ERRCODE='40001'; END IF;
  SELECT count(*),count(*)<>count(DISTINCT line->>'itemId') OR count(*) FILTER (WHERE line->>'pricingKind'='HAFF_RATIO')<>1
    OR bool_or(COALESCE(line->>'itemId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      OR line-ARRAY['itemId','quantity','unit','unitQuantity','pricingKind','buyerUnitAmount','ownerUnitAmount','buyerAmount','ownerAmount','platformAmount'] <> '{}'::jsonb
      OR NOT(line ?& ARRAY['itemId','quantity','unit','unitQuantity','pricingKind','buyerUnitAmount','ownerUnitAmount','buyerAmount','ownerAmount','platformAmount'])
      OR COALESCE(line->>'quantity','') !~ '^(0|[1-9][0-9]{0,23})$' OR COALESCE(line->>'unitQuantity','') !~ '^[1-9][0-9]{0,23}$'
      OR EXISTS(SELECT 1 FROM unnest(ARRAY['buyerAmount','ownerAmount','platformAmount','buyerUnitAmount','ownerUnitAmount']) k
        WHERE jsonb_typeof(line->k) IS DISTINCT FROM 'object' OR line#>>ARRAY[k,'currency'] IS DISTINCT FROM 'CNY'
          OR line#>>ARRAY[k,'unit'] IS DISTINCT FROM 'yuan' OR jsonb_typeof(line#>ARRAY[k,'amount']) IS DISTINCT FROM 'string'
          OR line#>>ARRAY[k,'scale'] IS DISTINCT FROM CASE WHEN k IN ('buyerUnitAmount','ownerUnitAmount') THEN '8' ELSE '2' END
          OR COALESCE(line#>>ARRAY[k,'amount'],'') !~ CASE WHEN k IN ('buyerUnitAmount','ownerUnitAmount') THEN '^(0|[1-9][0-9]*)\.[0-9]{8}$' ELSE '^(0|[1-9][0-9]*)\.[0-9]{2}$' END))
    INTO line_count,mismatch FROM jsonb_array_elements(quote->'lines') line;
  IF mismatch THEN RAISE EXCEPTION 'scheduled spread line shape invalid' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(quote->'lines') q FULL JOIN jsonb_array_elements(v.payload#>'{quoteValues,lines}') original
    ON q->>'itemId'=original->>'itemId' WHERE q IS NULL OR original IS NULL OR q->>'quantity' IS DISTINCT FROM original->>'quantity'
      OR q->>'unit' IS DISTINCT FROM original->>'unit' OR q->>'unitQuantity' IS DISTINCT FROM original->>'unitQuantity'
      OR q->>'pricingKind' IS DISTINCT FROM original->>'pricingKind')
    OR line_count<>jsonb_array_length(v.payload#>'{quoteValues,lines}')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(v.payload#>'{declaration,inventory}') inventory
      FULL JOIN jsonb_array_elements(v.payload#>'{quoteValues,lines}') original ON inventory->>'itemId'=original->>'itemId'
      WHERE inventory IS NULL OR original IS NULL OR inventory->>'quantity' IS DISTINCT FROM original->>'quantity')
  THEN RAISE EXCEPTION 'scheduled spread listing quantities changed' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(quote->'lines') q
    LEFT JOIN zzsh_supply.price_line l ON l.price_version_id=effective.price_version_id AND l.customer_tier='STANDARD' AND l.item_id=q->>'itemId'
    LEFT JOIN zzsh_supply.billable_item item ON item.id=l.item_id AND item.game_id=n.game_id
    WHERE l.id IS NULL OR item.id IS NULL OR l.pricing_kind IS DISTINCT FROM q->>'pricingKind' OR item.unit IS DISTINCT FROM q->>'unit'
      OR (l.pricing_kind='FIXED_UNIT' AND (l.owner_unit_amount IS NULL OR l.buyer_unit_amount IS NULL
        OR l.owner_unit_amount>l.buyer_unit_amount OR l.unit_quantity IS DISTINCT FROM (q->>'unitQuantity')::numeric
        OR l.owner_unit_amount IS DISTINCT FROM (q#>>'{ownerUnitAmount,amount}')::numeric))
      OR (l.pricing_kind='HAFF_RATIO' AND (q->>'unit' IS DISTINCT FROM 'HAFF_BASE' OR q->>'unitQuantity' IS DISTINCT FROM '1000000'
        OR (q->>'quantity')::numeric<=0)))
  THEN RAISE EXCEPTION 'scheduled spread current unit prices invalid' USING ERRCODE='40001'; END IF;

  IF jsonb_typeof(basis->'haff') IS DISTINCT FROM 'object'
    OR (basis->'haff')-ARRAY['itemId','openingQuantity','buyerNumerator','buyerDenominator'] <> '{}'::jsonb
    OR NOT((basis->'haff') ?& ARRAY['itemId','openingQuantity','buyerNumerator','buyerDenominator'])
    OR COALESCE(basis#>>'{haff,buyerNumerator}','') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$'
    OR COALESCE(basis#>>'{haff,buyerDenominator}','') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$'
    OR (basis#>>'{haff,buyerDenominator}')::numeric<=0
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(quote->'lines') q WHERE q->>'pricingKind'='HAFF_RATIO'
      AND q->>'itemId'=basis#>>'{haff,itemId}' AND q->>'quantity'=basis#>>'{haff,openingQuantity}'
      AND (basis#>>'{haff,buyerNumerator}')::numeric*1000000*buyer_ratio=(q->>'quantity')::numeric*100*(basis#>>'{haff,buyerDenominator}')::numeric)
  THEN RAISE EXCEPTION 'scheduled spread original haff price invalid' USING ERRCODE='40001'; END IF;
  IF (SELECT count(*)<>count(DISTINCT item->>'itemId') FROM jsonb_array_elements(basis->'items') item)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'items') item WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR item-ARRAY['itemId','name','unit','unitQuantity','buyerUnitAmount','ownerUnitAmount'] <> '{}'::jsonb
      OR NOT(item ?& ARRAY['itemId','name','unit','unitQuantity','buyerUnitAmount','ownerUnitAmount']))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'items') frozen FULL JOIN (
      SELECT l.item_id,l.unit_quantity,l.buyer_unit_amount,l.owner_unit_amount,item.unit
        FROM zzsh_supply.price_line l JOIN zzsh_supply.billable_item item ON item.id=l.item_id AND item.game_id=n.game_id
       WHERE l.price_version_id=effective.price_version_id AND l.customer_tier='STANDARD' AND l.pricing_kind='FIXED_UNIT'
         AND (item.enabled OR EXISTS(SELECT 1 FROM jsonb_array_elements(quote->'lines') q WHERE q->>'itemId'=l.item_id))
      ) line ON line.item_id=frozen->>'itemId' WHERE frozen IS NULL OR line.item_id IS NULL OR line.owner_unit_amount IS NULL OR line.buyer_unit_amount IS NULL
        OR frozen->>'unit' IS DISTINCT FROM line.unit OR (frozen->>'unitQuantity')::numeric IS DISTINCT FROM line.unit_quantity
        OR (frozen->>'buyerUnitAmount')::numeric IS DISTINCT FROM line.buyer_unit_amount
        OR (frozen->>'ownerUnitAmount')::numeric IS DISTINCT FROM line.owner_unit_amount)
  THEN RAISE EXCEPTION 'scheduled spread original item prices invalid' USING ERRCODE='40001'; END IF;

  WITH rows AS (
    SELECT q,q->>'itemId' AS item_id,
      CASE WHEN q->>'pricingKind'='HAFF_RATIO' THEN div((q->>'quantity')::numeric*20000+1000000*buyer_ratio,2000000*buyer_ratio)
        ELSE div((q->>'quantity')::numeric*l.buyer_unit_amount*200+(q->>'unitQuantity')::numeric,2*(q->>'unitQuantity')::numeric) END AS base,
      CASE WHEN q->>'pricingKind'='HAFF_RATIO' THEN div((q->>'quantity')::numeric*20000+1000000*owner_ratio,2000000*owner_ratio)
        ELSE div((q->>'quantity')::numeric*l.owner_unit_amount*200+(q->>'unitQuantity')::numeric,2*(q->>'unitQuantity')::numeric) END AS expected_owner,
      (q#>>'{buyerAmount,amount}')::numeric*100 AS buyer,(q#>>'{ownerAmount,amount}')::numeric*100 AS owner,
      (q#>>'{platformAmount,amount}')::numeric*100 AS platform
    FROM jsonb_array_elements(quote->'lines') q JOIN zzsh_supply.price_line l
      ON l.price_version_id=effective.price_version_id AND l.customer_tier='STANDARD' AND l.item_id=q->>'itemId'
  )
  SELECT COALESCE(sum(base),0),COALESCE(sum(owner),0),COALESCE(sum(buyer),0),COALESCE(sum(platform),0),
    COALESCE(bool_or(owner IS DISTINCT FROM expected_owner OR buyer<owner OR buyer>base OR platform<>buyer-owner),false),
    jsonb_agg(jsonb_build_object('itemId',item_id,'base',base,'owner',owner,'buyer',buyer) ORDER BY item_id COLLATE "C")
    INTO gross,owner_total,buyer_total,platform_total,mismatch,parts FROM rows;
  IF mismatch OR buyer_total IS DISTINCT FROM round(gross*payable)
    OR buyer_total IS DISTINCT FROM (quote#>>'{resourceTotal,amount}')::numeric*100
    OR owner_total IS DISTINCT FROM (quote#>>'{ownerTotal,amount}')::numeric*100
    OR platform_total IS DISTINCT FROM (quote#>>'{platformFullProfit,amount}')::numeric*100
    OR platform_total IS DISTINCT FROM buyer_total-owner_total
  THEN RAISE EXCEPTION 'scheduled spread quote totals invalid' USING ERRCODE='40001'; END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(parts) LOOP
    ids:=array_append(ids,entry->>'itemId');bases:=array_append(bases,(entry->>'base')::numeric);
    buyers:=array_append(buyers,(entry->>'buyer')::numeric);owners:=array_append(owners,(entry->>'owner')::numeric);
    capacity:=array_append(capacity,(entry->>'base')::numeric-(entry->>'owner')::numeric);discounts:=array_append(discounts,0::numeric);
  END LOOP;
  remaining:=gross-buyer_total;attempts:=line_count+2;
  WHILE remaining>0 LOOP
    attempts:=attempts-1;
    IF attempts<0 THEN RAISE EXCEPTION 'scheduled spread discount allocation invalid' USING ERRCODE='40001'; END IF;
    weight:=0;take:=array_fill(0::numeric,ARRAY[line_count]);
    FOR i IN 1..line_count LOOP IF capacity[i]>0 THEN weight:=weight+bases[i]; END IF; END LOOP;
    taken:=0;
    IF weight>0 THEN
      FOR i IN 1..line_count LOOP
        IF capacity[i]>0 THEN take[i]:=LEAST(div(remaining*bases[i],weight),capacity[i]);taken:=taken+take[i]; END IF;
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
        EXIT WHEN remaining=0;discounts[chosen]:=discounts[chosen]+1;capacity[chosen]:=capacity[chosen]-1;remaining:=remaining-1;
      END LOOP;
      IF remaining=remaining_before THEN RAISE EXCEPTION 'scheduled spread discount allocation unavailable' USING ERRCODE='40001'; END IF;
    END IF;
  END LOOP;
  FOR i IN 1..line_count LOOP
    IF buyers[i] IS DISTINCT FROM bases[i]-discounts[i] THEN RAISE EXCEPTION 'scheduled spread line discount allocation invalid' USING ERRCODE='40001'; END IF;
  END LOOP;

  IF EXISTS (
    WITH lines AS (
      SELECT q,l.buyer_unit_amount,l.owner_unit_amount,(q->>'quantity')::numeric AS quantity,
        (q->>'unitQuantity')::numeric AS unit_quantity,(q#>>'{buyerAmount,amount}')::numeric*100 AS buyer,
        (q#>>'{ownerAmount,amount}')::numeric*100 AS owner,
        CASE WHEN q->>'pricingKind'='HAFF_RATIO' THEN div((q->>'quantity')::numeric*20000+1000000*buyer_ratio,2000000*buyer_ratio)
          ELSE div((q->>'quantity')::numeric*l.buyer_unit_amount*200+(q->>'unitQuantity')::numeric,2*(q->>'unitQuantity')::numeric) END AS base
      FROM jsonb_array_elements(quote->'lines') q JOIN zzsh_supply.price_line l
        ON l.price_version_id=effective.price_version_id AND l.customer_tier='STANDARD' AND l.item_id=q->>'itemId'
    ), expected AS (
      SELECT *,CASE WHEN q->>'pricingKind'='HAFF_RATIO' THEN
          CASE WHEN buyer=base THEN div(20000000000+buyer_ratio,2*buyer_ratio)
            WHEN buyer*1000000*owner_ratio>=100*quantity*100 THEN div(2*buyer*unit_quantity*100000000+quantity*100,2*quantity*100)
            ELSE div(20000000000+owner_ratio,2*owner_ratio) END
        ELSE CASE WHEN buyer=base THEN buyer_unit_amount*100000000
            WHEN buyer=owner THEN owner_unit_amount*100000000
            ELSE div((2*buyer-1)*unit_quantity*1000000+2*quantity-1,2*quantity) END END AS buyer_scaled,
        CASE WHEN q->>'pricingKind'='HAFF_RATIO' THEN div(20000000000+owner_ratio,2*owner_ratio)
          ELSE owner_unit_amount*100000000 END AS owner_scaled
      FROM lines
    ) SELECT 1 FROM expected WHERE (q#>>'{buyerUnitAmount,amount}')::numeric*100000000 IS DISTINCT FROM buyer_scaled
      OR (q#>>'{ownerUnitAmount,amount}')::numeric*100000000 IS DISTINCT FROM owner_scaled
      OR (q->>'pricingKind'='FIXED_UNIT' AND div(quantity*buyer_scaled*200+unit_quantity*100000000,
        2*unit_quantity*100000000) IS DISTINCT FROM buyer)
  ) THEN RAISE EXCEPTION 'scheduled spread quoted unit price invalid' USING ERRCODE='40001'; END IF;

  IF jsonb_typeof(quote#>'{pricingInputs,exactRatios}') IS DISTINCT FROM 'array' OR jsonb_array_length(quote#>'{pricingInputs,exactRatios}')<>1
  THEN RAISE EXCEPTION 'scheduled spread exact ratio invalid' USING ERRCODE='40001'; END IF;
  exact:=quote#>'{pricingInputs,exactRatios,0}';
  SELECT q INTO haff_line FROM jsonb_array_elements(quote->'lines') q WHERE q->>'pricingKind'='HAFF_RATIO';
  IF jsonb_typeof(exact) IS DISTINCT FROM 'object' OR exact->>'itemId' IS DISTINCT FROM haff_line->>'itemId'
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['buyerNumerator','buyerDenominator','ownerNumerator','ownerDenominator']) key
      WHERE jsonb_typeof(exact->key) IS DISTINCT FROM 'string' OR COALESCE(exact->>key,'') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$')
    OR (exact->>'buyerDenominator')::numeric<=0 OR (exact->>'ownerDenominator')::numeric<=0
  THEN RAISE EXCEPTION 'scheduled spread exact ratio invalid' USING ERRCODE='40001'; END IF;
  owner_num:=(haff_line->>'quantity')::numeric*100;owner_den:=1000000*owner_ratio;
  base_haff:=div((haff_line->>'quantity')::numeric*20000+1000000*buyer_ratio,2000000*buyer_ratio);
  IF (haff_line#>>'{buyerAmount,amount}')::numeric*100=base_haff THEN buyer_num:=owner_num;buyer_den:=1000000*buyer_ratio;
  ELSIF (haff_line#>>'{buyerAmount,amount}')::numeric*100*owner_den>=100*owner_num THEN
    buyer_num:=(haff_line#>>'{buyerAmount,amount}')::numeric*100;buyer_den:=100;
  ELSE buyer_num:=owner_num;buyer_den:=owner_den; END IF;
  IF (exact->>'ownerNumerator')::numeric*owner_den IS DISTINCT FROM owner_num*(exact->>'ownerDenominator')::numeric
    OR (exact->>'buyerNumerator')::numeric*buyer_den IS DISTINCT FROM buyer_num*(exact->>'buyerDenominator')::numeric
  THEN RAISE EXCEPTION 'scheduled spread exact ratio changed' USING ERRCODE='40001'; END IF;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.assert_scheduled_spread_order_v6(zzsh_order.rental_order) FROM PUBLIC;
COMMENT ON FUNCTION zzsh_order.assert_scheduled_spread_order_v6(zzsh_order.rental_order)
  IS '校验独立价差订单的原上架、当前价目、金额与版本化确认依据。';
