-- TR-C1-IMP-1-R2-R1: formal corrective migration.
-- 0054_supply_funding_guard_correction / idx=54 / version=7 / when=1789490023000.
-- Replaces only the three approved 0053 functions; 0053 and migrations 0-53 remain frozen.
-- Approved correction draft SHA256: e0502837d7bacc2ac4c728ffb3759835123a56f0e8c3a9aba2e4dc2a08b69b40.
-- Frozen 0053 SHA256: 396ae76a1352ba1f6cb9e7b83ace658263ac9ddcdb6203ba181cde4ce80aea1a.

CREATE OR REPLACE FUNCTION zzsh_supply.valid_funding_policy(policy jsonb)
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

CREATE OR REPLACE FUNCTION zzsh_supply.valid_owner_deposit_declaration(declaration jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF NOT zzsh_supply.jsonb_exact_keys(declaration, ARRAY['schema','amountCents','declarationVersion'])
     OR jsonb_typeof(declaration->'schema') IS DISTINCT FROM 'string'
     OR declaration->>'schema' IS DISTINCT FROM 'owner-deposit-declaration-v1'
     OR jsonb_typeof(declaration->'amountCents') IS DISTINCT FROM 'string'
     OR COALESCE(declaration->>'amountCents','') !~ '^(0|[1-9][0-9]{0,23})$'
     OR jsonb_typeof(declaration->'declarationVersion') IS DISTINCT FROM 'string'
     OR COALESCE(NULLIF(declaration->>'declarationVersion',''),'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$' THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION zzsh_supply.guard_account_guarantee_proof_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account_row record;
  current_row record;
  policy jsonb;
  previous record;
  expected_version bigint;
  required_permission_code text;
  has_permission boolean;
BEGIN
  SELECT id,owner_user_id,game_id INTO account_row
    FROM zzsh_supply.rental_account WHERE id=NEW.account_id FOR UPDATE;
  IF NOT FOUND OR account_row.owner_user_id IS DISTINCT FROM NEW.owner_user_id THEN
    RAISE EXCEPTION 'guarantee proof account owner mismatch' USING ERRCODE='40001';
  END IF;
  SELECT g.current_release_id AS release_id,r.price_version_id,p.funding_policy AS funding_policy
    INTO current_row
    FROM zzsh_supply.game g
    JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id AND r.game_id=g.id
    JOIN zzsh_supply.price_version p ON p.id=r.price_version_id
   WHERE g.id=account_row.game_id AND g.enabled;
  IF NOT FOUND OR current_row.funding_policy IS NULL OR NOT zzsh_supply.valid_funding_policy(current_row.funding_policy)
     OR current_row.price_version_id IS DISTINCT FROM NEW.price_version_id THEN
    RAISE EXCEPTION 'guarantee proof is not bound to the current funding policy' USING ERRCODE='40001';
  END IF;
  policy := current_row.funding_policy;
  IF NEW.policy_version IS DISTINCT FROM policy->>'policyVersion' THEN
    RAISE EXCEPTION 'guarantee proof policy version mismatch' USING ERRCODE='40001';
  END IF;

  SELECT id,version_no,status,required_cents,covered_cents INTO previous
    FROM zzsh_supply.account_guarantee_proof
   WHERE account_id=NEW.account_id ORDER BY version_no DESC LIMIT 1;
  expected_version := COALESCE(previous.version_no,0)+1;
  IF NEW.version_no IS DISTINCT FROM expected_version
     OR NEW.supersedes_id IS DISTINCT FROM previous.id THEN
    RAISE EXCEPTION 'guarantee proof append version is stale' USING ERRCODE='40001';
  END IF;

  required_permission_code := CASE WHEN NEW.status='REVOKED' THEN 'supply.guarantee.revoke' ELSE 'supply.guarantee.verify' END;
  SELECT EXISTS (
    SELECT 1 FROM zzsh_iam.admin_security s
     WHERE s.admin_user_id=NEW.verified_by_admin_id AND s.status='ACTIVE'
       AND (
         s.is_boss
         OR (
           (
             EXISTS (
               SELECT 1 FROM zzsh_iam.admin_user_role AS ur
               JOIN zzsh_iam.admin_role AS r ON r.id=ur.role_id AND r.status='ACTIVE'
               JOIN zzsh_iam.admin_role_permission AS rp ON rp.role_id=r.id AND rp.permission_code=required_permission_code
              WHERE ur.admin_user_id=NEW.verified_by_admin_id
             )
             OR EXISTS (
               SELECT 1 FROM zzsh_iam.admin_user_permission AS up
                WHERE up.admin_user_id=NEW.verified_by_admin_id
                  AND up.permission_code=required_permission_code AND up.effect='ALLOW'
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM zzsh_iam.admin_user_permission AS deny
              WHERE deny.admin_user_id=NEW.verified_by_admin_id
                AND deny.permission_code=required_permission_code AND deny.effect='DENY'
           )
         )
       )
  ) INTO has_permission;
  IF NOT has_permission THEN RAISE EXCEPTION 'guarantee proof verifier is not authorized' USING ERRCODE='42501'; END IF;

  NEW.valid_from := clock_timestamp();
  NEW.created_at := NEW.valid_from;
  IF NEW.status='SATISFIED' THEN
    IF policy->'guaranteeRequirement'->>'mode' IS DISTINCT FROM 'FIXED_CENTS'
       OR NEW.required_cents IS DISTINCT FROM (policy->'guaranteeRequirement'->>'requiredCents')::numeric
       OR NEW.covered_cents < NEW.required_cents THEN
      RAISE EXCEPTION 'guarantee proof coverage is insufficient' USING ERRCODE='40001';
    END IF;
    NEW.valid_until := NEW.valid_from + ((policy->'proofValidity'->>'satisfiedDays')::numeric * interval '1 day');
  ELSIF NEW.status='NOT_REQUIRED' THEN
    IF policy->'guaranteeRequirement'->>'mode' IS DISTINCT FROM 'NOT_REQUIRED'
       OR NEW.required_cents <> 0 OR NEW.covered_cents <> 0 THEN
      RAISE EXCEPTION 'guarantee proof cannot waive the current requirement' USING ERRCODE='40001';
    END IF;
    NEW.valid_until := NULL;
  ELSE
    IF previous.id IS NULL OR previous.status='REVOKED'
       OR NEW.required_cents IS DISTINCT FROM previous.required_cents
       OR NEW.covered_cents IS DISTINCT FROM previous.covered_cents THEN
      RAISE EXCEPTION 'guarantee proof revoke is invalid' USING ERRCODE='40001';
    END IF;
    NEW.valid_until := NEW.valid_from;
  END IF;
  RETURN NEW;
END $$;

