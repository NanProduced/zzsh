-- Candidate only: after 0212, bind new orders to the original publication guarantee and funding terms.
-- Install only together with the v5 order guard and explicit runtime ACL verification.
-- Refuse installation before the account line's immutable publication snapshot exists.
SELECT credit_guarantee_waived,credit_guarantee_waived_revision FROM zzsh_supply.listing_publication LIMIT 0;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION zzsh_order.guard_supply_final_funding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  personal jsonb;
  binding record;
  proof record;
  terms record;
  credit_revision text;
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
  IF personal->>'schema' NOT IN ('personal-quote-v2','personal-quote-v3','personal-quote-v4','personal-quote-v5','personal-quote-v6') THEN RETURN NEW; END IF;
  SELECT a.game_id,p.id AS price_id,p.funding_policy AS policy,v.payload,
    p.full_payout_terms_version_id,p.full_payout_terms_digest,p.full_payout_disclosure_version,
    pub.id AS publication_id,pub.credit_guarantee_waived,pub.credit_guarantee_waived_revision::text AS waiver_revision INTO binding
    FROM zzsh_supply.rental_account a
    JOIN zzsh_supply.game g ON g.id=a.game_id AND g.enabled
    JOIN zzsh_supply.rule_release r ON r.id=NEW.rule_release_id AND r.game_id=a.game_id
    JOIN zzsh_supply.price_version p ON p.id=r.price_version_id AND p.game_id=a.game_id AND p.status='SEALED'
    JOIN zzsh_supply.listing_version v ON v.id=NEW.listing_version_id AND v.id=a.current_version_id AND v.account_id=a.id
      AND v.rule_release_id=r.id AND v.content_hash=NEW.content_hash
    LEFT JOIN zzsh_supply.listing_publication pub ON pub.version_id=v.id AND pub.account_id=a.id
      AND pub.owner_user_id=a.owner_user_id AND pub.game_id=a.game_id AND pub.rule_release_id=r.id AND pub.content_hash=v.content_hash
   WHERE a.id=NEW.account_id AND a.owner_user_id=NEW.owner_user_id AND a.game_id=NEW.game_id
     AND a.lifecycle='ACTIVE' AND NOT a.staff_restricted AND NOT a.owner_paused AND a.legacy_hold='NONE'
     AND NOT (g.code='delta' AND EXISTS (SELECT 1 FROM zzsh_supply.legacy_supply_map m WHERE m.account_id=a.id
       AND m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts'))
     AND ((v.review_state='PUBLISHED' AND pub.source='OWNER_DIRECT')
       OR (v.review_state='APPROVED' AND pub.source='LEGACY_APPROVED'))
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
    PERFORM 1 FROM zzsh_credit.user_credit_state WHERE user_id=NEW.owner_user_id FOR SHARE;
    IF NOT FOUND OR binding.publication_id IS NULL OR binding.payload#>>'{quoteValues,resourceTotal,currency}' IS DISTINCT FROM 'CNY'
      OR binding.payload#>>'{quoteValues,resourceTotal,unit}' IS DISTINCT FROM 'yuan'
      OR binding.payload#>>'{quoteValues,resourceTotal,scale}' IS DISTINCT FROM '2'
      OR COALESCE(binding.payload#>>'{quoteValues,resourceTotal,amount}','') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$'
      OR (binding.payload#>>'{quoteValues,resourceTotal,amount}')::numeric<=0
      OR round((binding.payload#>>'{quoteValues,resourceTotal,amount}')::numeric*5)<=0
      OR (binding.payload#>'{quoteValues,pricingInputs,compatibility}' IS NOT NULL
        AND binding.payload#>>'{quoteValues,pricingInputs,compatibility,customerTier}' IS DISTINCT FROM 'STANDARD') THEN
      RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
    END IF;
    IF EXISTS (SELECT 1 FROM zzsh_order.owner_guarantee_requirement previous
      JOIN zzsh_order.owner_guarantee_payment paid ON paid.requirement_id=previous.id AND paid.owner_user_id=previous.owner_user_id
      WHERE previous.account_id=NEW.account_id AND previous.owner_user_id=NEW.owner_user_id
        AND (previous.price_version_id IS DISTINCT FROM binding.price_id OR previous.listing_version_id IS DISTINCT FROM NEW.listing_version_id)
        AND paid.status<>'FAILED' AND NOT EXISTS (SELECT 1 FROM zzsh_order.owner_guarantee_refund f
          JOIN zzsh_order.finance_event e ON e.id=f.finance_event_id
          JOIN zzsh_order.finance_economic_root root ON root.id=e.economic_root_id
          JOIN zzsh_order.settlement_ledger_entry cash ON cash.id=f.ledger_entry_ref AND cash.finance_event_id=e.id
          WHERE f.payment_id=paid.id AND f.status='SUCCEEDED' AND f.provider_request_state='SUCCEEDED'
            AND f.amount_cents=COALESCE(paid.observed_amount_cents,paid.amount_cents)
            AND e.kind='GUARANTEE_REFUND' AND e.subject_user_id=previous.owner_user_id
            AND root.source_kind='NATIVE_GUARANTEE' AND root.source_entity='owner_guarantee_refund' AND root.source_id=f.id
            AND root.subject_user_id=previous.owner_user_id AND root.source_digest=f.source_digest
            AND cash.account_code='GUARANTEE_CASH' AND cash.debit_cents=0 AND cash.credit_cents=f.amount_cents)
    ) THEN RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001'; END IF;
    SELECT id,status,score_snapshot,required_cents::text,updated_at::text INTO requirement FROM zzsh_order.owner_guarantee_requirement
      WHERE account_id=NEW.account_id AND owner_user_id=NEW.owner_user_id AND price_version_id=binding.price_id
        AND listing_version_id IS NOT DISTINCT FROM NEW.listing_version_id ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE;
    IF FOUND THEN
      SELECT COALESCE(sum(COALESCE(observed_amount_cents,amount_cents)),0),
        COALESCE(bool_or(provider_request_state<>'CONFIRMED' OR finance_event_id IS NULL OR ledger_entry_ref IS NULL),false)
        INTO confirmed,unrecognized FROM zzsh_order.owner_guarantee_payment WHERE requirement_id=requirement.id AND status='CONFIRMED';
      SELECT COALESCE(sum(CASE WHEN status='SUCCEEDED' THEN amount_cents ELSE 0 END),0),
        COALESCE(bool_or(status IN ('REQUESTED','PROCESSING','UNKNOWN')),false)
        INTO refunded,active_refund FROM zzsh_order.owner_guarantee_refund WHERE requirement_id=requirement.id;
      SELECT status INTO last_payment FROM zzsh_order.owner_guarantee_payment WHERE requirement_id=requirement.id ORDER BY created_at DESC,id DESC LIMIT 1;
      IF requirement.status='RESTRICTED' OR active_refund OR refunded>0
        OR last_payment IN ('REQUESTED','ACCEPTED','PROCESSING','UNKNOWN') OR unrecognized THEN
        RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
      END IF;
    END IF;
    IF binding.credit_guarantee_waived IS TRUE AND binding.waiver_revision ~ '^[1-9][0-9]*$' THEN
      IF COALESCE(confirmed,0)<>0 OR (last_payment IS NOT NULL AND last_payment<>'FAILED') THEN
        RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
      END IF;
      credit_state:='NOT_REQUIRED';required_text:='0';coverage_revision:=NULL;credit_revision:=binding.waiver_revision;
    ELSE
      IF requirement.id IS NULL OR requirement.score_snapshot IS NULL OR requirement.score_snapshot NOT BETWEEN 0 AND 100
        OR requirement.required_cents::numeric<=0 OR confirmed IS NULL OR confirmed<requirement.required_cents::numeric THEN
        RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
      END IF;
      credit_state:='SATISFIED';required_text:=requirement.required_cents;coverage_revision:=requirement.updated_at;credit_revision:=NULL;
    END IF;
    expected_reference:='credit-guarantee-v1:'||encode(sha256(convert_to(zzsh_order.canonical_finance_json(jsonb_build_object(
      'accountId',NEW.account_id,'ownerUserId',NEW.owner_user_id,'gameId',binding.game_id,'versionId',NEW.listing_version_id,
      'priceVersionId',binding.price_id,'releaseId',NEW.rule_release_id,'creditRevision',credit_revision,
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
