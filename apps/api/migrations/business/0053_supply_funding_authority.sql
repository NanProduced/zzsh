-- TR-C1-IMP-1: formal funding policy, owner declaration and account guarantee proof.
-- 0050/0051 personal-order guards remain unchanged; this migration only makes
-- the source facts that the existing confirmation/order path consumes explicit.

ALTER TABLE zzsh_supply.price_version
  ADD COLUMN funding_policy jsonb;

CREATE OR REPLACE FUNCTION zzsh_supply.jsonb_exact_keys(doc jsonb, keys text[])
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF jsonb_typeof(doc) IS DISTINCT FROM 'object' THEN RETURN false; END IF;
  RETURN (SELECT count(*) FROM jsonb_object_keys(doc)) = cardinality(keys)
    AND NOT EXISTS (
      SELECT 1 FROM jsonb_object_keys(doc) AS item(key)
       WHERE NOT (item.key = ANY(keys))
    );
END $$;

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
  IF policy->>'schema' IS DISTINCT FROM 'funding-policy-v1'
     OR jsonb_typeof(policy->'policyVersion') IS DISTINCT FROM 'string'
     OR COALESCE(NULLIF(trim(policy->>'policyVersion'),''),'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
     OR jsonb_typeof(policy->'vipWaiver') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(policy->'svipWaiver') IS DISTINCT FROM 'boolean'
     OR jsonb_typeof(policy->'fullPayoutPolicyRef') IS DISTINCT FROM 'string'
     OR jsonb_typeof(policy->'fullPayoutPolicyVersion') IS DISTINCT FROM 'string'
     OR jsonb_typeof(policy->'disclosureVersion') IS DISTINCT FROM 'string'
     OR COALESCE(NULLIF(trim(policy->>'fullPayoutPolicyRef'),''),'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
     OR COALESCE(NULLIF(trim(policy->>'fullPayoutPolicyVersion'),''),'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
     OR COALESCE(NULLIF(trim(policy->>'disclosureVersion'),''),'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$' THEN
    RETURN false;
  END IF;

  recommendation := policy->'recommendation';
  IF NOT zzsh_supply.jsonb_exact_keys(recommendation, ARRAY['schema','algorithm','version','currency','unit','inputSpec','parameters'])
     OR recommendation->>'schema' IS DISTINCT FROM 'deposit-recommendation-v1'
     OR recommendation->>'algorithm' IS DISTINCT FROM 'delta-deposit-owner-declared-v1'
     OR recommendation->>'version' IS DISTINCT FROM '1'
     OR recommendation->>'currency' IS DISTINCT FROM 'CNY'
     OR recommendation->>'unit' IS DISTINCT FROM 'cent' THEN RETURN false; END IF;

  input_spec := recommendation->'inputSpec';
  IF NOT zzsh_supply.jsonb_exact_keys(input_spec, ARRAY['schema','identityFields','attributeFields','currency','unit'])
     OR input_spec->>'schema' IS DISTINCT FROM 'deposit-recommendation-input-v1'
     OR input_spec->>'currency' IS DISTINCT FROM 'CNY'
     OR input_spec->>'unit' IS DISTINCT FROM 'cent'
     OR input_spec->'identityFields' IS DISTINCT FROM '["accountId","gameId","listingVersionId","priceVersionId","ruleReleaseId"]'::jsonb THEN RETURN false; END IF;
  attributes := input_spec->'attributeFields';
  IF NOT zzsh_supply.jsonb_exact_keys(attributes, ARRAY['safeBoxCode','vitality','bear','dive','skinIds'])
     OR attributes->>'safeBoxCode' IS DISTINCT FROM 'declaration.attributes.safe_box_code'
     OR attributes->>'vitality' IS DISTINCT FROM 'declaration.attributes.vit_level'
     OR attributes->>'bear' IS DISTINCT FROM 'declaration.attributes.bear_level'
     OR attributes->>'dive' IS DISTINCT FROM 'declaration.attributes.dive_level'
     OR attributes->>'skinIds' IS DISTINCT FROM 'declaration.skins[].skinId' THEN RETURN false; END IF;

  parameters := recommendation->'parameters';
  IF NOT zzsh_supply.jsonb_exact_keys(parameters, ARRAY['safeBoxWeightsByCode','vitalityAtLeast7Cents','bearAtLeast7Cents','diveAtLeast3Cents','skinGroupById','skinWeights','rounding','upperLimitCents'])
     OR jsonb_typeof(parameters->'safeBoxWeightsByCode') IS DISTINCT FROM 'object'
     OR NOT EXISTS (SELECT 1 FROM jsonb_each(parameters->'safeBoxWeightsByCode'))
     OR EXISTS (SELECT 1 FROM jsonb_each(parameters->'safeBoxWeightsByCode') AS item(key,value)
       WHERE item.key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
          OR jsonb_typeof(item.value) IS DISTINCT FROM 'string'
          OR item.value #>> '{}' !~ '^(0|[1-9][0-9]{0,23})$')
     OR COALESCE(parameters->>'vitalityAtLeast7Cents','') !~ '^(0|[1-9][0-9]{0,23})$'
     OR COALESCE(parameters->>'bearAtLeast7Cents','') !~ '^(0|[1-9][0-9]{0,23})$'
     OR COALESCE(parameters->>'diveAtLeast3Cents','') !~ '^(0|[1-9][0-9]{0,23})$'
     OR jsonb_typeof(parameters->'skinGroupById') IS DISTINCT FROM 'object'
     OR EXISTS (SELECT 1 FROM jsonb_each(parameters->'skinGroupById') AS item(key,value)
       WHERE item.key !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'
          OR COALESCE(item.value #>> '{}','') NOT IN ('LEGACY_GOLD','LEGACY_AGENT','LEGACY_KNIFE','LEGACY_WEAPON','NONE'))
     OR NOT zzsh_supply.jsonb_exact_keys(parameters->'skinWeights', ARRAY['LEGACY_GOLD','LEGACY_AGENT','LEGACY_KNIFE','LEGACY_WEAPON'])
     OR EXISTS (SELECT 1 FROM jsonb_each(parameters->'skinWeights') AS item(key,value)
       WHERE NOT zzsh_supply.jsonb_exact_keys(item.value, ARRAY['firstCents','subsequentCents'])
          OR COALESCE(item.value->>'firstCents','') !~ '^(0|[1-9][0-9]{0,23})$'
          OR COALESCE(item.value->>'subsequentCents','') !~ '^(0|[1-9][0-9]{0,23})$')
     OR NOT zzsh_supply.jsonb_exact_keys(parameters->'rounding', ARRAY['mode','unitCents','zeroFallbackCents'])
     OR parameters->'rounding'->>'mode' IS DISTINCT FROM 'CEIL'
     OR parameters->'rounding'->>'unitCents' IS DISTINCT FROM '5000'
     OR parameters->'rounding'->>'zeroFallbackCents' IS DISTINCT FROM '5000'
     OR COALESCE(parameters->>'upperLimitCents','') !~ '^[1-9][0-9]{0,23}$' THEN RETURN false; END IF;

  owner_rules := policy->'ownerDepositRules';
  IF NOT zzsh_supply.jsonb_exact_keys(owner_rules, ARRAY['schema','currency','unit','normal','fullPayoutSelected','capCents'])
     OR owner_rules->>'schema' IS DISTINCT FROM 'owner-deposit-rule-v1'
     OR owner_rules->>'currency' IS DISTINCT FROM 'CNY'
     OR owner_rules->>'unit' IS DISTINCT FROM 'cent'
     OR COALESCE(owner_rules->>'capCents','') !~ '^[1-9][0-9]{0,23}$'
     OR owner_rules->>'capCents' IS DISTINCT FROM parameters->>'upperLimitCents' THEN RETURN false; END IF;
  normal_rule := owner_rules->'normal';
  full_rule := owner_rules->'fullPayoutSelected';
  IF NOT zzsh_supply.jsonb_exact_keys(normal_rule, ARRAY['minCents','zeroAllowed'])
     OR normal_rule->>'minCents' IS DISTINCT FROM '1'
     OR jsonb_typeof(normal_rule->'zeroAllowed') IS DISTINCT FROM 'boolean'
     OR (normal_rule->'zeroAllowed')::text IS DISTINCT FROM 'false'
     OR NOT zzsh_supply.jsonb_exact_keys(full_rule, ARRAY['minCents','zeroAllowed'])
     OR full_rule->>'minCents' IS DISTINCT FROM '30000'
     OR jsonb_typeof(full_rule->'zeroAllowed') IS DISTINCT FROM 'boolean'
     OR (full_rule->'zeroAllowed')::text IS DISTINCT FROM 'false'
     OR (owner_rules->>'capCents')::numeric < 30000 THEN RETURN false; END IF;

  guarantee := policy->'guaranteeRequirement';
  IF NOT zzsh_supply.jsonb_exact_keys(guarantee, ARRAY['schema','version','scope','currency','unit','mode','requiredCents'])
     OR guarantee->>'schema' IS DISTINCT FROM 'account-guarantee-requirement-v1'
     OR guarantee->>'version' IS DISTINCT FROM '1'
     OR guarantee->>'scope' IS DISTINCT FROM 'GAME_ACCOUNT'
     OR guarantee->>'currency' IS DISTINCT FROM 'CNY'
     OR guarantee->>'unit' IS DISTINCT FROM 'cent'
     OR COALESCE(guarantee->>'mode','') NOT IN ('FIXED_CENTS','NOT_REQUIRED')
     OR COALESCE(guarantee->>'requiredCents','') !~ '^(0|[1-9][0-9]{0,23})$'
     OR (guarantee->>'mode'='FIXED_CENTS' AND guarantee->>'requiredCents'='0')
     OR (guarantee->>'mode'='NOT_REQUIRED' AND guarantee->>'requiredCents' IS DISTINCT FROM '0') THEN RETURN false; END IF;

  proof_validity := policy->'proofValidity';
  IF NOT zzsh_supply.jsonb_exact_keys(proof_validity, ARRAY['schema','satisfiedMode','satisfiedDays'])
     OR proof_validity->>'schema' IS DISTINCT FROM 'guarantee-proof-validity-v1'
     OR proof_validity->>'satisfiedMode' IS DISTINCT FROM 'FIXED_DAYS'
     OR COALESCE(proof_validity->>'satisfiedDays','') !~ '^[1-9][0-9]{0,23}$' THEN RETURN false; END IF;
  RETURN true;
END $$;

CREATE OR REPLACE FUNCTION zzsh_supply.valid_owner_deposit_declaration(declaration jsonb)
RETURNS boolean LANGUAGE plpgsql IMMUTABLE AS $$
BEGIN
  IF NOT zzsh_supply.jsonb_exact_keys(declaration, ARRAY['schema','amountCents','declarationVersion'])
     OR declaration->>'schema' IS DISTINCT FROM 'owner-deposit-declaration-v1'
     OR COALESCE(declaration->>'amountCents','') !~ '^(0|[1-9][0-9]{0,23})$'
     OR jsonb_typeof(declaration->'declarationVersion') IS DISTINCT FROM 'string'
     OR COALESCE(NULLIF(trim(declaration->>'declarationVersion'),''),'') !~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$' THEN
    RETURN false;
  END IF;
  RETURN true;
END $$;

ALTER TABLE zzsh_supply.price_version
  ADD CONSTRAINT price_version_funding_policy_shape
  CHECK (funding_policy IS NULL OR zzsh_supply.valid_funding_policy(funding_policy));

ALTER TABLE zzsh_supply.listing_version
  ADD CONSTRAINT listing_version_owner_deposit_shape
  CHECK (attributes->'owner_deposit_declaration' IS NULL OR zzsh_supply.valid_owner_deposit_declaration(attributes->'owner_deposit_declaration'));

CREATE OR REPLACE FUNCTION zzsh_supply.guard_price_version_update()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status = 'SEALED' THEN
    IF (NEW.status,NEW.game_id,NEW.mode,NEW.commission_rate,NEW.haff_rule,NEW.rounding_policy,
        NEW.compensation_policy_ref,NEW.funding_policy,NEW.revision,NEW.created_by_admin_id,
        NEW.created_at,NEW.sealed_at,NEW.sealed_by_admin_id)
       IS DISTINCT FROM
       (OLD.status,OLD.game_id,OLD.mode,OLD.commission_rate,OLD.haff_rule,OLD.rounding_policy,
        OLD.compensation_policy_ref,OLD.funding_policy,OLD.revision,OLD.created_by_admin_id,
        OLD.created_at,OLD.sealed_at,OLD.sealed_by_admin_id) THEN
      RAISE EXCEPTION 'sealed price version is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status = 'SEALED' THEN
    IF EXISTS (SELECT 1 FROM zzsh_supply.price_line WHERE price_version_id=NEW.id AND pricing_kind='HAFF_RATIO')
       AND NEW.haff_rule IS NULL THEN RAISE EXCEPTION 'haff rule is required for haff ratio lines'; END IF;
    IF NOT EXISTS (SELECT 1 FROM zzsh_supply.price_line WHERE price_version_id=NEW.id)
       THEN RAISE EXCEPTION 'price version requires at least one line'; END IF;
    IF NEW.funding_policy IS NOT NULL AND NOT zzsh_supply.valid_funding_policy(NEW.funding_policy)
       THEN RAISE EXCEPTION 'funding policy is invalid'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TABLE zzsh_supply.account_guarantee_proof (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  owner_user_id text NOT NULL,
  version_no bigint NOT NULL CHECK (version_no > 0),
  price_version_id text NOT NULL REFERENCES zzsh_supply.price_version(id),
  policy_version text NOT NULL CHECK (policy_version ~ '^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$'),
  status text NOT NULL CHECK (status IN ('SATISFIED','NOT_REQUIRED','REVOKED')),
  required_cents numeric(24,0) NOT NULL CHECK (required_cents >= 0),
  covered_cents numeric(24,0) NOT NULL CHECK (covered_cents >= 0),
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 200),
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[0-9a-f]{64}$'),
  verified_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
  valid_from timestamptz NOT NULL DEFAULT clock_timestamp(),
  valid_until timestamptz,
  supersedes_id text REFERENCES zzsh_supply.account_guarantee_proof(id),
  reason text NOT NULL CHECK (length(reason) BETWEEN 2 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT account_guarantee_proof_account_owner_fk FOREIGN KEY (account_id,owner_user_id)
    REFERENCES zzsh_supply.rental_account(id,owner_user_id),
  CONSTRAINT account_guarantee_proof_version_unique UNIQUE (account_id,version_no),
  CONSTRAINT account_guarantee_proof_valid_time CHECK (valid_until IS NULL OR valid_until >= valid_from)
);

CREATE OR REPLACE FUNCTION zzsh_supply.guard_account_guarantee_proof_insert()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  account_row record;
  current_row record;
  policy jsonb;
  previous record;
  expected_version bigint;
  permission_code text;
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

  permission_code := CASE WHEN NEW.status='REVOKED' THEN 'supply.guarantee.revoke' ELSE 'supply.guarantee.verify' END;
  SELECT EXISTS (
    SELECT 1 FROM zzsh_iam.admin_security s
     WHERE s.admin_user_id=NEW.verified_by_admin_id AND s.status='ACTIVE'
       AND (
         s.is_boss
         OR (
           (
             EXISTS (
               SELECT 1 FROM zzsh_iam.admin_user_role ur
               JOIN zzsh_iam.admin_role r ON r.id=ur.role_id AND r.status='ACTIVE'
               JOIN zzsh_iam.admin_role_permission rp ON rp.role_id=r.id AND rp.permission_code=permission_code
              WHERE ur.admin_user_id=NEW.verified_by_admin_id
             )
             OR EXISTS (
               SELECT 1 FROM zzsh_iam.admin_user_permission up
                WHERE up.admin_user_id=NEW.verified_by_admin_id
                  AND up.permission_code=permission_code AND up.effect='ALLOW'
             )
           )
           AND NOT EXISTS (
             SELECT 1 FROM zzsh_iam.admin_user_permission deny
              WHERE deny.admin_user_id=NEW.verified_by_admin_id
                AND deny.permission_code=permission_code AND deny.effect='DENY'
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

CREATE OR REPLACE FUNCTION zzsh_supply.guard_account_guarantee_proof_immutable()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'account guarantee proof is append-only' USING ERRCODE='40001';
END $$;

CREATE TRIGGER account_guarantee_proof_insert_guard
BEFORE INSERT ON zzsh_supply.account_guarantee_proof
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_account_guarantee_proof_insert();
CREATE TRIGGER account_guarantee_proof_immutable
BEFORE UPDATE OR DELETE ON zzsh_supply.account_guarantee_proof
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_account_guarantee_proof_immutable();

INSERT INTO zzsh_iam.admin_permission(code,name,description) VALUES
 ('supply.guarantee.read','读取账号保证金核定','读取受权账号保证金资格事实与版本'),
 ('supply.guarantee.verify','核定账号保证金','追加账号保证金满足或无需要求的核定事实'),
 ('supply.guarantee.revoke','撤销账号保证金核定','追加账号保证金撤销事实，不改写历史')
ON CONFLICT(code) DO NOTHING;

