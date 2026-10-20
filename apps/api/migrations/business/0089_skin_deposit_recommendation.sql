-- Preserve v1 policies; recommendation-v2 separates type, quality and per-skin overrides.
-- Copy 0054's exact v1 validator to preserve frozen-policy replay. No existing policy rows are rewritten.
CREATE OR REPLACE FUNCTION zzsh_supply.valid_funding_policy_legacy_v1(policy jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  recommendation jsonb;
  input_spec jsonb;
  attributes jsonb;
  parameters jsonb;
  rounding jsonb;
  owner_rules jsonb;
  normal_rule jsonb;
  full_rule jsonb;
  guarantee jsonb;
  proof_validity jsonb;
BEGIN
  IF NOT zzsh_supply.jsonb_exact_keys(policy, ARRAY[
    'schema','policyVersion','recommendation','ownerDepositRules','guaranteeRequirement',
    'proofValidity','vipWaiver','svipWaiver','fullPayoutPolicyRef','fullPayoutPolicyVersion','disclosureVersion'
  ]) THEN RETURN false; END IF;
  IF jsonb_typeof(policy->'schema') IS DISTINCT FROM 'string'
     OR policy->>'schema' IS DISTINCT FROM 'funding-policy-v1'
     OR jsonb_typeof(policy->'policyVersion') IS DISTINCT FROM 'string'
     OR COALESCE(NULLIF(policy->>'policyVersion',''),'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
     OR jsonb_typeof(policy->'vipWaiver') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(policy->'svipWaiver') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(policy->'fullPayoutPolicyRef') IS DISTINCT FROM 'string'
     OR jsonb_typeof(policy->'fullPayoutPolicyVersion') IS DISTINCT FROM 'string'
     OR jsonb_typeof(policy->'disclosureVersion') IS DISTINCT FROM 'string'
     OR COALESCE(NULLIF(policy->>'fullPayoutPolicyRef',''),'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
     OR COALESCE(NULLIF(policy->>'fullPayoutPolicyVersion',''),'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
     OR COALESCE(NULLIF(policy->>'disclosureVersion',''),'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$' THEN
    RETURN false;
  END IF;

  recommendation := policy->'recommendation';
  IF NOT zzsh_supply.jsonb_exact_keys(recommendation, ARRAY['schema','algorithm','version','currency','unit','inputSpec','parameters'])
     OR jsonb_typeof(recommendation->'schema') IS DISTINCT FROM 'string'
     OR recommendation->>'schema' IS DISTINCT FROM 'deposit-recommendation-v1'
     OR jsonb_typeof(recommendation->'algorithm') IS DISTINCT FROM 'string'
     OR recommendation->>'algorithm' IS DISTINCT FROM 'delta-deposit-owner-declared-v1'
     OR jsonb_typeof(recommendation->'version') IS DISTINCT FROM 'string'
     OR recommendation->>'version' IS DISTINCT FROM '1'
     OR jsonb_typeof(recommendation->'currency') IS DISTINCT FROM 'string'
     OR recommendation->>'currency' IS DISTINCT FROM 'CNY'
     OR jsonb_typeof(recommendation->'unit') IS DISTINCT FROM 'string'
     OR recommendation->>'unit' IS DISTINCT FROM 'cent' THEN RETURN false; END IF;

  input_spec := recommendation->'inputSpec';
  IF NOT zzsh_supply.jsonb_exact_keys(input_spec, ARRAY['schema','identityFields','attributeFields','currency','unit'])
     OR jsonb_typeof(input_spec->'schema') IS DISTINCT FROM 'string'
     OR input_spec->>'schema' IS DISTINCT FROM 'deposit-recommendation-input-v1'
     OR jsonb_typeof(input_spec->'currency') IS DISTINCT FROM 'string'
     OR input_spec->>'currency' IS DISTINCT FROM 'CNY'
     OR jsonb_typeof(input_spec->'unit') IS DISTINCT FROM 'string'
     OR input_spec->>'unit' IS DISTINCT FROM 'cent'
     OR input_spec->'identityFields' IS DISTINCT FROM '["accountId","gameId","listingVersionId","priceVersionId","ruleReleaseId"]'::jsonb THEN RETURN false; END IF;
  attributes := input_spec->'attributeFields';
  IF NOT zzsh_supply.jsonb_exact_keys(attributes, ARRAY['safeBoxCode','vitality','bear','dive','skinIds'])
     OR jsonb_typeof(attributes->'safeBoxCode') IS DISTINCT FROM 'string'
     OR attributes->>'safeBoxCode' IS DISTINCT FROM 'declaration.attributes.safe_box_code'
     OR jsonb_typeof(attributes->'vitality') IS DISTINCT FROM 'string'
     OR attributes->>'vitality' IS DISTINCT FROM 'declaration.attributes.vit_level'
     OR jsonb_typeof(attributes->'bear') IS DISTINCT FROM 'string'
     OR attributes->>'bear' IS DISTINCT FROM 'declaration.attributes.bear_level'
     OR jsonb_typeof(attributes->'dive') IS DISTINCT FROM 'string'
     OR attributes->>'dive' IS DISTINCT FROM 'declaration.attributes.dive_level'
     OR jsonb_typeof(attributes->'skinIds') IS DISTINCT FROM 'string'
     OR attributes->>'skinIds' IS DISTINCT FROM 'declaration.skins[].skinId' THEN RETURN false; END IF;

  parameters := recommendation->'parameters';
  IF NOT zzsh_supply.jsonb_exact_keys(parameters, ARRAY['safeBoxWeightsByCode','vitalityAtLeast7Cents','bearAtLeast7Cents','diveAtLeast3Cents','skinGroupById','skinWeights','rounding','upperLimitCents'])
     OR jsonb_typeof(parameters->'safeBoxWeightsByCode') IS DISTINCT FROM 'object'
     OR NOT EXISTS (SELECT 1 FROM jsonb_each(parameters->'safeBoxWeightsByCode'))
     OR EXISTS (SELECT 1 FROM jsonb_each(parameters->'safeBoxWeightsByCode') AS policy_entry(key,value)
       WHERE policy_entry.key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
          OR jsonb_typeof(policy_entry.value) IS DISTINCT FROM 'string'
          OR policy_entry.value #>> '{}' !~ '^(0|[1-9][0-9]{0,23})$')
     OR jsonb_typeof(parameters->'vitalityAtLeast7Cents') IS DISTINCT FROM 'string'
     OR COALESCE(parameters->>'vitalityAtLeast7Cents','') !~ '^(0|[1-9][0-9]{0,23})$'
     OR jsonb_typeof(parameters->'bearAtLeast7Cents') IS DISTINCT FROM 'string'
     OR COALESCE(parameters->>'bearAtLeast7Cents','') !~ '^(0|[1-9][0-9]{0,23})$'
     OR jsonb_typeof(parameters->'diveAtLeast3Cents') IS DISTINCT FROM 'string'
     OR COALESCE(parameters->>'diveAtLeast3Cents','') !~ '^(0|[1-9][0-9]{0,23})$'
     OR jsonb_typeof(parameters->'skinGroupById') IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(parameters->'skinGroupById') AS policy_entry(key,value)
       WHERE policy_entry.key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
          OR jsonb_typeof(policy_entry.value) IS DISTINCT FROM 'string'
          OR COALESCE(policy_entry.value #>> '{}','') NOT IN ('LEGACY_GOLD','LEGACY_AGENT','LEGACY_KNIFE','LEGACY_WEAPON','NONE'))
     OR NOT zzsh_supply.jsonb_exact_keys(parameters->'skinWeights', ARRAY['LEGACY_GOLD','LEGACY_AGENT','LEGACY_KNIFE','LEGACY_WEAPON'])
     OR EXISTS (SELECT 1 FROM jsonb_each(parameters->'skinWeights') AS policy_entry(key,value)
       WHERE NOT zzsh_supply.jsonb_exact_keys(policy_entry.value, ARRAY['firstCents','subsequentCents'])
          OR jsonb_typeof(policy_entry.value->'firstCents') IS DISTINCT FROM 'string'
          OR COALESCE(policy_entry.value->>'firstCents','') !~ '^(0|[1-9][0-9]{0,23})$'
          OR jsonb_typeof(policy_entry.value->'subsequentCents') IS DISTINCT FROM 'string'
          OR COALESCE(policy_entry.value->>'subsequentCents','') !~ '^(0|[1-9][0-9]{0,23})$')
     OR NOT zzsh_supply.jsonb_exact_keys(parameters->'rounding', ARRAY['mode','unitCents','zeroFallbackCents'])
     OR jsonb_typeof(parameters->'rounding'->'mode') IS DISTINCT FROM 'string'
     OR parameters->'rounding'->>'mode' IS DISTINCT FROM 'CEIL'
     OR jsonb_typeof(parameters->'rounding'->'unitCents') IS DISTINCT FROM 'string'
     OR parameters->'rounding'->>'unitCents' IS DISTINCT FROM '5000'
     OR jsonb_typeof(parameters->'rounding'->'zeroFallbackCents') IS DISTINCT FROM 'string'
     OR parameters->'rounding'->>'zeroFallbackCents' IS DISTINCT FROM '5000'
     OR jsonb_typeof(parameters->'upperLimitCents') IS DISTINCT FROM 'string'
     OR COALESCE(parameters->>'upperLimitCents','') !~ '^[1-9][0-9]{0,23}$' THEN RETURN false; END IF;

  owner_rules := policy->'ownerDepositRules';
  IF NOT zzsh_supply.jsonb_exact_keys(owner_rules, ARRAY['schema','currency','unit','normal','fullPayoutSelected','capCents'])
     OR jsonb_typeof(owner_rules->'schema') IS DISTINCT FROM 'string'
     OR owner_rules->>'schema' IS DISTINCT FROM 'owner-deposit-rule-v1'
     OR jsonb_typeof(owner_rules->'currency') IS DISTINCT FROM 'string'
     OR owner_rules->>'currency' IS DISTINCT FROM 'CNY'
     OR jsonb_typeof(owner_rules->'unit') IS DISTINCT FROM 'string'
     OR owner_rules->>'unit' IS DISTINCT FROM 'cent'
     OR jsonb_typeof(owner_rules->'capCents') IS DISTINCT FROM 'string'
     OR COALESCE(owner_rules->>'capCents','') !~ '^[1-9][0-9]{0,23}$'
     OR owner_rules->>'capCents' IS DISTINCT FROM parameters->>'upperLimitCents' THEN RETURN false; END IF;
  normal_rule := owner_rules->'normal';
  full_rule := owner_rules->'fullPayoutSelected';
  IF NOT zzsh_supply.jsonb_exact_keys(normal_rule, ARRAY['minCents','zeroAllowed'])
     OR jsonb_typeof(normal_rule->'minCents') IS DISTINCT FROM 'string'
     OR normal_rule->>'minCents' IS DISTINCT FROM '1'
     OR jsonb_typeof(normal_rule->'zeroAllowed') IS DISTINCT FROM 'boolean'
     OR (normal_rule->'zeroAllowed')::text IS DISTINCT FROM 'false'
     OR NOT zzsh_supply.jsonb_exact_keys(full_rule, ARRAY['minCents','zeroAllowed'])
     OR jsonb_typeof(full_rule->'minCents') IS DISTINCT FROM 'string'
     OR full_rule->>'minCents' IS DISTINCT FROM '30000'
     OR jsonb_typeof(full_rule->'zeroAllowed') IS DISTINCT FROM 'boolean'
     OR (full_rule->'zeroAllowed')::text IS DISTINCT FROM 'false'
     OR (owner_rules->>'capCents')::numeric < 30000 THEN RETURN false; END IF;

  guarantee := policy->'guaranteeRequirement';
  IF NOT zzsh_supply.jsonb_exact_keys(guarantee, ARRAY['schema','version','scope','currency','unit','mode','requiredCents'])
     OR jsonb_typeof(guarantee->'schema') IS DISTINCT FROM 'string'
     OR guarantee->>'schema' IS DISTINCT FROM 'account-guarantee-requirement-v1'
     OR jsonb_typeof(guarantee->'version') IS DISTINCT FROM 'string'
     OR guarantee->>'version' IS DISTINCT FROM '1'
     OR jsonb_typeof(guarantee->'scope') IS DISTINCT FROM 'string'
     OR guarantee->>'scope' IS DISTINCT FROM 'GAME_ACCOUNT'
     OR jsonb_typeof(guarantee->'currency') IS DISTINCT FROM 'string'
     OR guarantee->>'currency' IS DISTINCT FROM 'CNY'
     OR jsonb_typeof(guarantee->'unit') IS DISTINCT FROM 'string'
     OR guarantee->>'unit' IS DISTINCT FROM 'cent'
     OR jsonb_typeof(guarantee->'mode') IS DISTINCT FROM 'string'
     OR COALESCE(guarantee->>'mode','') NOT IN ('FIXED_CENTS','NOT_REQUIRED')
     OR jsonb_typeof(guarantee->'requiredCents') IS DISTINCT FROM 'string'
     OR COALESCE(guarantee->>'requiredCents','') !~ '^(0|[1-9][0-9]{0,23})$'
     OR (guarantee->>'mode'='FIXED_CENTS' AND guarantee->>'requiredCents'='0')
     OR (guarantee->>'mode'='NOT_REQUIRED' AND guarantee->>'requiredCents' IS DISTINCT FROM '0') THEN RETURN false; END IF;

  proof_validity := policy->'proofValidity';
  IF NOT zzsh_supply.jsonb_exact_keys(proof_validity, ARRAY['schema','satisfiedMode','satisfiedDays'])
     OR jsonb_typeof(proof_validity->'schema') IS DISTINCT FROM 'string'
     OR proof_validity->>'schema' IS DISTINCT FROM 'guarantee-proof-validity-v1'
     OR jsonb_typeof(proof_validity->'satisfiedMode') IS DISTINCT FROM 'string'
     OR proof_validity->>'satisfiedMode' IS DISTINCT FROM 'FIXED_DAYS'
     OR jsonb_typeof(proof_validity->'satisfiedDays') IS DISTINCT FROM 'string'
     OR COALESCE(proof_validity->>'satisfiedDays','') !~ '^[1-9][0-9]{0,23}$' THEN RETURN false; END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION zzsh_supply.valid_funding_policy_draft(policy jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  recommendation jsonb := policy->'recommendation';
  input_spec jsonb := recommendation->'inputSpec';
  parameters jsonb := recommendation->'parameters';
  item jsonb;
  keys text[] := ARRAY[]::text[];
  ids text[] := ARRAY[]::text[];
  match_key text;
  neutral jsonb;
BEGIN
  IF recommendation->>'schema' IS DISTINCT FROM 'deposit-recommendation-v2' THEN
    RETURN zzsh_supply.valid_funding_policy_legacy_v1(policy);
  END IF;
  IF NOT zzsh_supply.jsonb_exact_keys(recommendation, ARRAY['schema','algorithm','version','currency','unit','inputSpec','parameters'])
    OR recommendation->'schema' IS DISTINCT FROM '"deposit-recommendation-v2"'::jsonb
    OR recommendation->'algorithm' IS DISTINCT FROM '"delta-deposit-type-rarity-v2"'::jsonb
    OR recommendation->'version' IS DISTINCT FROM '"2"'::jsonb
    OR input_spec->'schema' IS DISTINCT FROM '"deposit-recommendation-input-v2"'::jsonb
    OR NOT zzsh_supply.jsonb_exact_keys(input_spec->'attributeFields', ARRAY['safeBoxCode','vitality','bear','dive','skinIds','skinFacts'])
    OR input_spec->'attributeFields'->'skinFacts' IS DISTINCT FROM '"catalog.skinFacts"'::jsonb
    OR NOT zzsh_supply.jsonb_exact_keys(parameters, ARRAY['safeBoxWeightsByCode','vitalityAtLeast7Cents','bearAtLeast7Cents','diveAtLeast3Cents','skinRules','skinOverrides','rounding','upperLimitCents'])
    OR jsonb_typeof(parameters->'skinRules') IS DISTINCT FROM 'array'
    OR jsonb_typeof(parameters->'skinOverrides') IS DISTINCT FROM 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(parameters->'skinRules') > 512 OR jsonb_array_length(parameters->'skinOverrides') > 2000 THEN RETURN false; END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(parameters->'skinRules') LOOP
    IF NOT zzsh_supply.jsonb_exact_keys(item, ARRAY['ownerKind','rarityCode','firstCents','subsequentCents'])
      OR jsonb_typeof(item->'ownerKind') IS DISTINCT FROM 'string'
      OR COALESCE(item->>'ownerKind','') NOT IN ('AGENT','MELEE_TYPE','FIREARM')
      OR NOT (item->'rarityCode' = 'null'::jsonb OR (jsonb_typeof(item->'rarityCode') = 'string' AND item->>'rarityCode' ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'))
      OR NOT (item->'firstCents' = 'null'::jsonb OR (jsonb_typeof(item->'firstCents') = 'string' AND item->>'firstCents' ~ '^(0|[1-9][0-9]{0,23})$'))
      OR NOT (item->'subsequentCents' = 'null'::jsonb OR (jsonb_typeof(item->'subsequentCents') = 'string' AND item->>'subsequentCents' ~ '^(0|[1-9][0-9]{0,23})$')) THEN RETURN false; END IF;
    match_key := jsonb_build_array(item->'ownerKind',item->'rarityCode')::text;
    IF match_key = ANY(keys) THEN RETURN false; END IF;
    keys := array_append(keys,match_key);
  END LOOP;
  FOR item IN SELECT value FROM jsonb_array_elements(parameters->'skinOverrides') LOOP
    IF NOT zzsh_supply.jsonb_exact_keys(item, ARRAY['skinId','amountCents'])
      OR jsonb_typeof(item->'skinId') IS DISTINCT FROM 'string'
      OR COALESCE(item->>'skinId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
      OR NOT (item->'amountCents' = 'null'::jsonb OR (jsonb_typeof(item->'amountCents') = 'string' AND item->>'amountCents' ~ '^(0|[1-9][0-9]{0,23})$'))
      OR item->>'skinId' = ANY(ids) THEN RETURN false; END IF;
    ids := array_append(ids,item->>'skinId');
  END LOOP;
  -- Reuse the strict frozen validator for every non-skin field; these neutral skin values are validation-only.
  neutral := policy || jsonb_build_object('recommendation', recommendation || jsonb_build_object(
    'schema','deposit-recommendation-v1','algorithm','delta-deposit-owner-declared-v1','version','1',
    'inputSpec', input_spec || jsonb_build_object('schema','deposit-recommendation-input-v1','attributeFields',(input_spec->'attributeFields')-'skinFacts'),
    'parameters', (parameters-'skinRules'-'skinOverrides') || '{"skinGroupById":{},"skinWeights":{"LEGACY_GOLD":{"firstCents":"0","subsequentCents":"0"},"LEGACY_AGENT":{"firstCents":"0","subsequentCents":"0"},"LEGACY_KNIFE":{"firstCents":"0","subsequentCents":"0"},"LEGACY_WEAPON":{"firstCents":"0","subsequentCents":"0"}}}'::jsonb
  ));
  RETURN zzsh_supply.valid_funding_policy_legacy_v1(neutral);
END $$;

CREATE OR REPLACE FUNCTION zzsh_supply.valid_funding_policy(policy jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE parameters jsonb := policy->'recommendation'->'parameters';
BEGIN
  IF NOT zzsh_supply.valid_funding_policy_draft(policy) THEN RETURN false; END IF;
  IF policy->'recommendation'->>'schema' IS DISTINCT FROM 'deposit-recommendation-v2' THEN RETURN true; END IF;
  IF EXISTS (SELECT 1 FROM jsonb_array_elements(parameters->'skinRules') AS rule(value) WHERE value->'firstCents' = 'null'::jsonb OR value->'subsequentCents' = 'null'::jsonb)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(parameters->'skinOverrides') AS rule(value) WHERE value->'amountCents' = 'null'::jsonb)
    OR EXISTS (SELECT 1 FROM unnest(ARRAY['AGENT','MELEE_TYPE','FIREARM']) AS kind(value) WHERE NOT EXISTS (SELECT 1 FROM jsonb_array_elements(parameters->'skinRules') AS rule(value) WHERE rule.value->>'ownerKind'=kind.value AND rule.value->'rarityCode'='null'::jsonb)) THEN RETURN false; END IF;
  RETURN true;
END $$;

-- Existing seal/proof triggers keep calling strict valid_funding_policy. Only DRAFT rows may hold null skin amounts.
ALTER TABLE zzsh_supply.price_version DROP CONSTRAINT price_version_funding_policy_shape;
ALTER TABLE zzsh_supply.price_version ADD CONSTRAINT price_version_funding_policy_shape
  CHECK (funding_policy IS NULL OR CASE WHEN status='DRAFT' THEN zzsh_supply.valid_funding_policy_draft(funding_policy) ELSE zzsh_supply.valid_funding_policy(funding_policy) END);
