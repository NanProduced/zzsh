-- Candidate only: preserve 0078 final-funding checks and extend them to validated v5 orders.
-- Install only together with the v5 order guard and explicit runtime ACL verification.
CREATE OR REPLACE FUNCTION zzsh_order.guard_supply_final_funding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  personal jsonb;
  binding record;
  proof record;
  terms record;
  credit record;
  requirement record;
  last_payment text;
  confirmed numeric;
  refunded numeric;
  active_refund boolean;
  unrecognized boolean;
  reference text;
  required_text text;
  credit_state text;
  coverage_revision text;
  expected_reference text;
BEGIN
  IF NEW.confirmation_id IS NULL THEN RETURN NEW; END IF;
  personal:=NEW.quote_snapshot->'personal';
  IF personal->>'schema' NOT IN ('personal-quote-v2','personal-quote-v3','personal-quote-v4','personal-quote-v5') THEN RETURN NEW; END IF;
  SELECT a.game_id,p.id AS price_id,p.funding_policy AS policy,v.payload,
    p.full_payout_terms_version_id,p.full_payout_terms_digest,p.full_payout_disclosure_version INTO binding
    FROM zzsh_supply.rental_account a
    JOIN zzsh_supply.game g ON g.id=a.game_id AND g.current_release_id=NEW.rule_release_id
    JOIN zzsh_supply.rule_release r ON r.id=NEW.rule_release_id
    JOIN zzsh_supply.price_version p ON p.id=r.price_version_id AND p.status='SEALED'
    JOIN zzsh_supply.listing_version v ON v.id=NEW.listing_version_id AND v.account_id=a.id
   WHERE a.id=NEW.account_id AND a.owner_user_id=NEW.owner_user_id
     AND p.id=personal#>>'{ruleRefs,priceVersionId}' AND p.funding_policy->>'policyVersion'=personal#>>'{funding,version}';
  IF NOT FOUND THEN RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001'; END IF;
  IF personal#>>'{fullPayoutDeclaration,selected}'='true' THEN
    SELECT * INTO terms FROM zzsh_supply.full_payout_terms_version t
      WHERE t.id=binding.full_payout_terms_version_id AND t.game_id=binding.game_id AND t.status='SEALED'
        AND t.digest=binding.full_payout_terms_digest AND t.disclosure_version=binding.full_payout_disclosure_version
        AND t.policy_ref=personal#>>'{funding,fullPayoutPolicyRef}'
        AND t.policy_version=personal#>>'{funding,fullPayoutPolicyVersion}'
        AND t.disclosure_version=personal#>>'{funding,disclosureVersion}'
        AND t.policy_ref=binding.policy->>'fullPayoutPolicyRef'
        AND t.policy_version=binding.policy->>'fullPayoutPolicyVersion'
        AND t.disclosure_version=binding.policy->>'disclosureVersion';
    IF NOT FOUND OR right(personal#>>'{funding,sourceRef}',length(':full-payout-terms:'||terms.id||':'||terms.digest))
      IS DISTINCT FROM ':full-payout-terms:'||terms.id||':'||terms.digest THEN
      RAISE EXCEPTION 'full-payout terms binding changed' USING ERRCODE='40001';
    END IF;
  END IF;
  reference:=personal#>>'{guarantee,reference}';
  IF reference ~ '^credit-guarantee-v1:[0-9a-f]{64}$' THEN
    SELECT score,revision::text INTO credit FROM zzsh_credit.user_credit_state WHERE user_id=NEW.owner_user_id FOR SHARE;
    IF NOT FOUND OR binding.payload#>>'{quoteValues,resourceTotal,currency}' IS DISTINCT FROM 'CNY'
      OR binding.payload#>>'{quoteValues,resourceTotal,unit}' IS DISTINCT FROM 'yuan'
      OR binding.payload#>>'{quoteValues,resourceTotal,scale}' IS DISTINCT FROM '2'
      OR COALESCE(binding.payload#>>'{quoteValues,resourceTotal,amount}','') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$'
      OR (binding.payload#>>'{quoteValues,resourceTotal,amount}')::numeric<=0
      OR round((binding.payload#>>'{quoteValues,resourceTotal,amount}')::numeric*5)<=0
      OR (binding.payload#>'{quoteValues,pricingInputs,compatibility}' IS NOT NULL
        AND binding.payload#>>'{quoteValues,pricingInputs,compatibility,customerTier}' IS DISTINCT FROM 'STANDARD') THEN
      RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
    END IF;
    SELECT id,required_cents::text,updated_at::text INTO requirement FROM zzsh_order.owner_guarantee_requirement
      WHERE account_id=NEW.account_id AND owner_user_id=NEW.owner_user_id AND price_version_id=binding.price_id
        AND listing_version_id IS NOT DISTINCT FROM NEW.listing_version_id ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE;
    IF NOT FOUND THEN
      IF credit.score<80 THEN RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001'; END IF;
      credit_state:='NOT_REQUIRED';required_text:='0';coverage_revision:=NULL;
    ELSE
      SELECT COALESCE(sum(COALESCE(observed_amount_cents,amount_cents)),0),
        COALESCE(bool_or(provider_request_state<>'CONFIRMED' OR finance_event_id IS NULL OR ledger_entry_ref IS NULL),false)
        INTO confirmed,unrecognized FROM zzsh_order.owner_guarantee_payment WHERE requirement_id=requirement.id AND status='CONFIRMED';
      SELECT COALESCE(sum(CASE WHEN status='SUCCEEDED' THEN amount_cents ELSE 0 END),0),
        COALESCE(bool_or(status IN ('REQUESTED','PROCESSING','UNKNOWN')),false)
        INTO refunded,active_refund FROM zzsh_order.owner_guarantee_refund WHERE requirement_id=requirement.id;
      SELECT status INTO last_payment FROM zzsh_order.owner_guarantee_payment WHERE requirement_id=requirement.id ORDER BY created_at DESC,id DESC LIMIT 1;
      IF active_refund OR refunded>0 OR last_payment IN ('REQUESTED','ACCEPTED','PROCESSING','UNKNOWN') OR unrecognized THEN
        RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
      END IF;
      IF confirmed<requirement.required_cents::numeric THEN
        IF credit.score<80 OR confirmed<>0 OR (last_payment IS NOT NULL AND last_payment<>'FAILED') THEN
          RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
        END IF;
        credit_state:='NOT_REQUIRED';required_text:='0';coverage_revision:=NULL;
      ELSE
        credit_state:='SATISFIED';required_text:=requirement.required_cents;coverage_revision:=requirement.updated_at;
      END IF;
    END IF;
    expected_reference:='credit-guarantee-v1:'||encode(sha256(convert_to(zzsh_order.canonical_finance_json(jsonb_build_object(
      'accountId',NEW.account_id,'ownerUserId',NEW.owner_user_id,'gameId',binding.game_id,'versionId',NEW.listing_version_id,
      'priceVersionId',binding.price_id,'releaseId',NEW.rule_release_id,'creditRevision',credit.revision,
      'coverageRevision',coverage_revision,'state',credit_state,'requiredCents',required_text)), 'UTF8')),'hex');
    IF reference IS DISTINCT FROM expected_reference OR personal#>>'{guarantee,status}' IS DISTINCT FROM credit_state
      OR personal#>>'{funding,publisherBailRequirementCents}' IS DISTINCT FROM required_text THEN
      RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT id,owner_user_id,account_id,price_version_id,policy_version,status,required_cents,covered_cents,valid_from,valid_until
    INTO proof FROM zzsh_supply.account_guarantee_proof WHERE account_id=NEW.account_id ORDER BY version_no DESC LIMIT 1;
  IF binding.policy#>>'{guaranteeRequirement,mode}'='NOT_REQUIRED' THEN
    IF binding.policy#>>'{guaranteeRequirement,requiredCents}' IS DISTINCT FROM '0'
      OR reference IS DISTINCT FROM 'policy:'||binding.price_id||':'||(binding.policy->>'policyVersion')||':NOT_REQUIRED'
      OR personal#>>'{guarantee,status}' IS DISTINCT FROM 'NOT_REQUIRED'
      OR personal#>>'{funding,publisherBailRequirementCents}' IS DISTINCT FROM '0' OR proof.status='REVOKED' THEN
      RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
    END IF;
  ELSE
    IF proof.id IS DISTINCT FROM reference OR proof.status IS DISTINCT FROM 'SATISFIED'
      OR proof.owner_user_id IS DISTINCT FROM NEW.owner_user_id OR proof.price_version_id IS DISTINCT FROM binding.price_id
      OR proof.policy_version IS DISTINCT FROM binding.policy->>'policyVersion'
      OR proof.required_cents::text IS DISTINCT FROM binding.policy#>>'{guaranteeRequirement,requiredCents}'
      OR proof.covered_cents<proof.required_cents OR personal#>>'{guarantee,status}' IS DISTINCT FROM 'SATISFIED'
      OR personal#>>'{funding,publisherBailRequirementCents}' IS DISTINCT FROM proof.required_cents::text THEN
      RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
    END IF;
    IF proof.valid_from IS NULL OR proof.valid_until IS NULL OR proof.valid_from>clock_timestamp()
      OR clock_timestamp()>=proof.valid_until THEN
      RAISE EXCEPTION 'formal guarantee expired at order write' USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION zzsh_order.guard_supply_final_funding() IS '验证新旧订单的原资金政策、保证金和包赔条款。';
