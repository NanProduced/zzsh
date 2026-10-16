-- Q integration source candidate 0078_personal_quote_v4. No DDL/ACL/financial execution authorized.
-- Derived from tmp/business-continuity-milestone-20261016/t-trade/implementation/migration-proposals/personal-quote-v4.sql
-- Source SHA256 68988e705186b66adbfe66f97dee26c51c4ab4237dfd323168a026841e276991; old0000-0073/proposals/UNKNOWN/claim/NO_MERGE remain unchanged.
CREATE FUNCTION zzsh_order.assert_personal_growth_order_v4(n zzsh_order.rental_order) RETURNS void LANGUAGE plpgsql AS $$
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
  OR v.payload#>>'{quoteValues,priceVersionId}' IS DISTINCT FROM n.quote_snapshot->>'priceVersionId' OR v.payload#>>'{quoteValues,termSeconds}' IS DISTINCT FROM n.term_seconds::text
  OR b->>'quantityDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(v.payload#>'{quoteValues,lines}'),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'personal quote v4 listing reference invalid' USING ERRCODE='40001';END IF;
 IF COALESCE(n.quote_snapshot->>'confirmationExpiresAt','')!~'^[1-9][0-9]{0,11}$' OR(n.quote_snapshot->>'confirmationExpiresAt')::numeric<=extract(epoch FROM clock_timestamp())
  THEN RAISE EXCEPTION 'personal confirmation expired' USING ERRCODE='40001';END IF;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.guard_personal_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expires_text text;
  personal_schema text;
  personal_doc jsonb;
  declaration_doc jsonb;
  rule_refs_doc jsonb;
  membership_doc jsonb;
  guarantee_doc jsonb;
  funding_doc jsonb;
  growth_doc jsonb;
  binding_doc jsonb;
  key_count integer;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.confirmation_id IS DISTINCT FROM OLD.confirmation_id THEN
      RAISE EXCEPTION 'confirmation consumption is immutable' USING ERRCODE='40001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.quote_snapshot#>>'{personal,schema}'='personal-quote-v4' THEN
    PERFORM zzsh_order.assert_personal_growth_order_v4(NEW);
    RETURN NEW;
  END IF;

  IF NEW.quote_snapshot->>'quoteKind'='ORDER_CONFIRMATION' THEN
    personal_schema := NEW.quote_snapshot#>>'{personal,schema}';
    IF NEW.confirmation_id IS NULL
      OR NEW.quote_snapshot->>'confirmationId' IS DISTINCT FROM NEW.confirmation_id::text
      OR NEW.quote_snapshot->>'orderSnapshotSchema' IS DISTINCT FROM '1'
      OR COALESCE(NEW.quote_snapshot->>'confirmationDigest','') !~ '^[0-9a-f]{64}$'
      OR NEW.quote_snapshot->>'listingHash' IS DISTINCT FROM NEW.content_hash
      OR NEW.quote_snapshot#>>'{personal,listingHash}' IS DISTINCT FROM NEW.content_hash
      OR NEW.quote_snapshot#>>'{personal,userId}' IS DISTINCT FROM NEW.renter_user_id
      OR (personal_schema IS DISTINCT FROM 'personal-quote-v1' AND personal_schema IS DISTINCT FROM 'personal-quote-v2' AND personal_schema IS DISTINCT FROM 'personal-quote-v3')
      OR jsonb_typeof(NEW.quote_snapshot->'priceVersionId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(NEW.quote_snapshot->'ruleReleaseId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(NEW.quote_snapshot->'termSeconds') IS DISTINCT FROM 'string'
      OR NEW.quote_snapshot->>'priceVersionId' IS DISTINCT FROM NEW.quote_snapshot#>>'{personal,ruleRefs,priceVersionId}'
      OR NEW.quote_snapshot->>'ruleReleaseId' IS DISTINCT FROM NEW.rule_release_id
      OR NEW.quote_snapshot#>>'{personal,ruleRefs,releaseId}' IS DISTINCT FROM NEW.rule_release_id
      OR NEW.quote_snapshot#>>'{personal,ruleRefs,priceVersionId}' IS DISTINCT FROM NEW.quote_snapshot->>'priceVersionId'
      OR NEW.quote_snapshot->>'termSeconds' IS DISTINCT FROM NEW.term_seconds::text
      OR COALESCE(NEW.quote_snapshot#>>'{personal,membership,tier}','') NOT IN ('STANDARD','VIP','SVIP','DISCOUNT_USER')
      OR COALESCE(NEW.quote_snapshot#>>'{personal,membership,version}','') !~ '^[1-9][0-9]{0,18}$'
      OR NEW.quote_snapshot ? 'confirmationToken' OR NEW.quote_snapshot ? 'signature' THEN
      RAISE EXCEPTION 'invalid personal order snapshot' USING ERRCODE='40001';
    END IF;

    IF personal_schema IN ('personal-quote-v2','personal-quote-v3') THEN
      personal_doc := NEW.quote_snapshot->'personal';
      IF jsonb_typeof(personal_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'invalid personal order snapshot' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(personal_doc) AS object_key(key);
      IF (personal_schema='personal-quote-v2' AND key_count <> 11)
        OR (personal_schema='personal-quote-v3' AND key_count <> 12)
        OR EXISTS (
          SELECT 1 FROM jsonb_object_keys(personal_doc) AS object_key(key)
          WHERE NOT (object_key.key = ANY (ARRAY[
            'schema','userId','ownerUserId','accountId','listingVersionId','listingHash',
            'fullPayoutDeclaration','ruleRefs','membership','guarantee','funding','membershipGrowth'
          ]::text[]))
          OR (personal_schema='personal-quote-v2' AND object_key.key='membershipGrowth')
        ) THEN
        RAISE EXCEPTION 'invalid personal quote v2/v3 shape' USING ERRCODE='40001';
      END IF;
      IF jsonb_typeof(personal_doc->'schema') IS DISTINCT FROM 'string'
        OR jsonb_typeof(personal_doc->'userId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(personal_doc->'ownerUserId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(personal_doc->'accountId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(personal_doc->'listingVersionId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(personal_doc->'listingHash') IS DISTINCT FROM 'string'
        OR personal_doc->>'ownerUserId' IS DISTINCT FROM NEW.owner_user_id
        OR personal_doc->>'accountId' IS DISTINCT FROM NEW.account_id
        OR personal_doc->>'listingVersionId' IS DISTINCT FROM NEW.listing_version_id
        OR personal_doc->>'listingHash' IS DISTINCT FROM NEW.content_hash
        OR personal_doc->>'schema' IS DISTINCT FROM personal_schema
        OR NEW.quote_snapshot ? 'fullPayoutSelected'
        OR NEW.quote_snapshot ? 'fullPayoutFeeCents' THEN
        RAISE EXCEPTION 'personal quote v2/v3 binding is invalid' USING ERRCODE='40001';
      END IF;

      declaration_doc := personal_doc->'fullPayoutDeclaration';
      IF jsonb_typeof(declaration_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2/v3 declaration is invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(declaration_doc) AS object_key(key);
      IF key_count <> 2 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(declaration_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY['schema','selected']::text[]))
      ) OR declaration_doc->>'schema' IS DISTINCT FROM 'full-payout-declaration-v1'
        OR jsonb_typeof(declaration_doc->'selected') IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'personal quote v2/v3 declaration is invalid' USING ERRCODE='40001';
      END IF;

      rule_refs_doc := personal_doc->'ruleRefs';
      IF jsonb_typeof(rule_refs_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2/v3 rule references are invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(rule_refs_doc) AS object_key(key);
      IF key_count <> 5 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(rule_refs_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY['releaseId','priceVersionId','termVersionId','agreementVersionId','agreementDigest']::text[]))
      ) THEN
        RAISE EXCEPTION 'personal quote v2/v3 rule references are invalid' USING ERRCODE='40001';
      END IF;
      IF jsonb_typeof(rule_refs_doc->'releaseId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(rule_refs_doc->'priceVersionId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(rule_refs_doc->'termVersionId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(rule_refs_doc->'agreementVersionId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(rule_refs_doc->'agreementDigest') IS DISTINCT FROM 'string'
        OR COALESCE(NULLIF(trim(rule_refs_doc->>'releaseId'),''),'') = ''
        OR COALESCE(NULLIF(trim(rule_refs_doc->>'priceVersionId'),''),'') = ''
        OR COALESCE(NULLIF(trim(rule_refs_doc->>'termVersionId'),''),'') = ''
        OR COALESCE(NULLIF(trim(rule_refs_doc->>'agreementVersionId'),''),'') = ''
        OR COALESCE(rule_refs_doc->>'agreementDigest','') !~ '^[0-9a-f]{64}$'
        OR rule_refs_doc->>'releaseId' IS DISTINCT FROM NEW.rule_release_id
        OR rule_refs_doc->>'priceVersionId' IS DISTINCT FROM NEW.quote_snapshot->>'priceVersionId' THEN
        RAISE EXCEPTION 'personal quote v2/v3 rule references are invalid' USING ERRCODE='40001';
      END IF;

      membership_doc := personal_doc->'membership';
      IF jsonb_typeof(membership_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2/v3 membership is invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(membership_doc) AS object_key(key);
      IF key_count <> 3 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(membership_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY['tier','version','sourceRef']::text[]))
      ) OR jsonb_typeof(membership_doc->'tier') IS DISTINCT FROM 'string'
        OR jsonb_typeof(membership_doc->'version') IS DISTINCT FROM 'string'
        OR jsonb_typeof(membership_doc->'sourceRef') IS DISTINCT FROM 'string'
        OR COALESCE(membership_doc->>'tier','') NOT IN ('STANDARD','VIP','SVIP','DISCOUNT_USER')
        OR COALESCE(membership_doc->>'version','') !~ '^[1-9][0-9]{0,18}$'
        OR COALESCE(NULLIF(trim(membership_doc->>'sourceRef'),''),'') = '' THEN
        RAISE EXCEPTION 'personal quote v2/v3 membership is invalid' USING ERRCODE='40001';
      END IF;

      guarantee_doc := personal_doc->'guarantee';
      IF jsonb_typeof(guarantee_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2/v3 guarantee is invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(guarantee_doc) AS object_key(key);
      IF key_count <> 2 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(guarantee_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY['status','reference']::text[]))
      ) OR jsonb_typeof(guarantee_doc->'status') IS DISTINCT FROM 'string'
        OR jsonb_typeof(guarantee_doc->'reference') IS DISTINCT FROM 'string'
        OR COALESCE(guarantee_doc->>'status','') NOT IN ('SATISFIED','NOT_REQUIRED')
        OR COALESCE(NULLIF(trim(guarantee_doc->>'reference'),''),'') = '' THEN
        RAISE EXCEPTION 'personal quote v2/v3 guarantee is invalid' USING ERRCODE='40001';
      END IF;

      funding_doc := personal_doc->'funding';
      IF jsonb_typeof(funding_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2/v3 funding is invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(funding_doc) AS object_key(key);
      IF key_count <> 9 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(funding_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY[
          'version','sourceRef','baseDepositCents','publisherBailRequirementCents',
          'fullPayoutPolicyRef','fullPayoutPolicyVersion','disclosureVersion','vipWaiver','svipWaiver'
        ]::text[]))
      ) THEN
        RAISE EXCEPTION 'personal quote v2/v3 funding is invalid' USING ERRCODE='40001';
      END IF;
      IF jsonb_typeof(funding_doc->'version') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'sourceRef') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'baseDepositCents') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'publisherBailRequirementCents') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'fullPayoutPolicyRef') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'fullPayoutPolicyVersion') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'disclosureVersion') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'vipWaiver') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(funding_doc->'svipWaiver') IS DISTINCT FROM 'boolean'
        OR COALESCE(NULLIF(trim(funding_doc->>'version'),''),'') = ''
        OR COALESCE(NULLIF(trim(funding_doc->>'sourceRef'),''),'') = ''
        OR COALESCE(funding_doc->>'baseDepositCents','') !~ '^(0|[1-9][0-9]{0,17})$'
        OR COALESCE(funding_doc->>'publisherBailRequirementCents','') !~ '^(0|[1-9][0-9]{0,17})$'
        OR COALESCE(NULLIF(trim(funding_doc->>'fullPayoutPolicyRef'),''),'') = ''
        OR COALESCE(NULLIF(trim(funding_doc->>'fullPayoutPolicyVersion'),''),'') = ''
        OR COALESCE(NULLIF(trim(funding_doc->>'disclosureVersion'),''),'') = '' THEN
        RAISE EXCEPTION 'personal quote v2/v3 funding is invalid' USING ERRCODE='40001';
      END IF;

      IF personal_schema='personal-quote-v3' THEN
        growth_doc := personal_doc->'membershipGrowth';
        IF jsonb_typeof(growth_doc) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'personal quote v3 growth extension is invalid' USING ERRCODE='40001';
        END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(growth_doc) AS object_key(key);
        IF key_count <> 6 OR EXISTS (
          SELECT 1 FROM jsonb_object_keys(growth_doc) AS object_key(key)
          WHERE NOT (object_key.key = ANY (ARRAY['schema','policyVersion','selectedSource','entitlementIds','binding','depositSource']::text[]))
        ) OR growth_doc->>'schema' IS DISTINCT FROM 'membership-growth-v1'
          OR COALESCE(NULLIF(trim(growth_doc->>'policyVersion'),''),'') = ''
          OR COALESCE(growth_doc->>'selectedSource','') NOT IN ('GROWTH','FRIEND','PRESTIGE')
          OR COALESCE(growth_doc->>'depositSource','') NOT IN ('GROWTH','FRIEND','PRESTIGE','UNKNOWN')
          OR jsonb_typeof(growth_doc->'entitlementIds') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'personal quote v3 growth extension is invalid' USING ERRCODE='40001';
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(growth_doc->'entitlementIds') AS entitlement(value) WHERE jsonb_typeof(entitlement.value) IS DISTINCT FROM 'string') THEN
          RAISE EXCEPTION 'personal quote v3 entitlement references are invalid' USING ERRCODE='40001';
        END IF;
        binding_doc := growth_doc->'binding';
        IF jsonb_typeof(binding_doc) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'personal quote v3 offer binding is invalid' USING ERRCODE='40001';
        END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(binding_doc) AS object_key(key);
        IF key_count <> 6
          OR EXISTS (SELECT 1 FROM jsonb_object_keys(binding_doc) AS object_key(key)
                     WHERE NOT (object_key.key = ANY (ARRAY['userId','accountId','ownerUserId','listingVersionId','ruleReleaseId','quantityDigest']::text[])))
          OR binding_doc->>'userId' IS DISTINCT FROM NEW.renter_user_id
          OR binding_doc->>'accountId' IS DISTINCT FROM NEW.account_id
          OR binding_doc->>'ownerUserId' IS DISTINCT FROM NEW.owner_user_id
          OR binding_doc->>'listingVersionId' IS DISTINCT FROM NEW.listing_version_id
          OR binding_doc->>'ruleReleaseId' IS DISTINCT FROM NEW.rule_release_id
          OR COALESCE(binding_doc->>'quantityDigest','') !~ '^[0-9a-f]{64}$' THEN
          RAISE EXCEPTION 'personal quote v3 offer binding is invalid' USING ERRCODE='40001';
        END IF;
      END IF;

      -- The normalized quote is at quote_snapshot root in the real producer.
      IF NEW.quote_snapshot->>'priceVersionId' IS DISTINCT FROM rule_refs_doc->>'priceVersionId'
        OR NEW.quote_snapshot->>'ruleReleaseId' IS DISTINCT FROM NEW.rule_release_id
        OR NEW.quote_snapshot->>'termSeconds' IS DISTINCT FROM NEW.term_seconds::text THEN
        RAISE EXCEPTION 'personal quote v2/v3 quote binding is invalid' USING ERRCODE='40001';
      END IF;

      IF NOT EXISTS (
        SELECT 1
          FROM zzsh_supply.listing_version v
         WHERE v.id=NEW.listing_version_id
           AND v.account_id=NEW.account_id
           AND v.content_hash=NEW.content_hash
           AND v.rule_release_id=NEW.rule_release_id
           AND v.payload->>'accountId' IS NOT DISTINCT FROM NEW.account_id
           AND v.payload->>'gameId' IS NOT DISTINCT FROM NEW.game_id
           AND v.payload#>>'{ruleRefs,releaseId}' IS NOT DISTINCT FROM rule_refs_doc->>'releaseId'
           AND v.payload#>>'{ruleRefs,priceVersionId}' IS NOT DISTINCT FROM rule_refs_doc->>'priceVersionId'
           AND v.payload#>>'{ruleRefs,termVersionId}' IS NOT DISTINCT FROM rule_refs_doc->>'termVersionId'
           AND v.payload#>>'{ruleRefs,agreementVersionId}' IS NOT DISTINCT FROM rule_refs_doc->>'agreementVersionId'
           AND v.payload#>>'{ruleRefs,agreementDigest}' IS NOT DISTINCT FROM rule_refs_doc->>'agreementDigest'
           AND v.payload#>>'{quoteValues,priceVersionId}' IS NOT DISTINCT FROM NEW.quote_snapshot->>'priceVersionId'
           AND v.payload#>>'{quoteValues,termSeconds}' IS NOT DISTINCT FROM NEW.quote_snapshot->>'termSeconds'
           AND v.payload#>'{declaration,attributes,full_payout_declaration}' IS NOT DISTINCT FROM declaration_doc
      ) THEN
        RAISE EXCEPTION 'personal listing reference mismatch' USING ERRCODE='40001';
      END IF;
    ELSIF personal_schema='personal-quote-v1' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'invalid personal order snapshot' USING ERRCODE='40001';
    END IF;

    IF personal_schema='personal-quote-v1' AND NOT EXISTS(
      SELECT 1 FROM zzsh_supply.listing_version v
       WHERE v.id=NEW.listing_version_id AND v.account_id=NEW.account_id
         AND v.content_hash=NEW.content_hash AND v.rule_release_id=NEW.rule_release_id
    ) THEN
      RAISE EXCEPTION 'personal listing reference mismatch' USING ERRCODE='40001';
    END IF;
    expires_text:=NEW.quote_snapshot->>'confirmationExpiresAt';
    IF expires_text IS NULL OR expires_text !~ '^[1-9][0-9]{0,11}$' THEN
      RAISE EXCEPTION 'invalid confirmation expiry' USING ERRCODE='40001';
    END IF;
    IF extract(epoch FROM clock_timestamp()) >= expires_text::numeric THEN
      RAISE EXCEPTION 'personal confirmation expired' USING ERRCODE='40001';
    END IF;
  ELSIF NEW.confirmation_id IS NOT NULL OR NEW.quote_snapshot ? 'quoteKind' OR NEW.quote_snapshot->>'schemaVersion'='2' THEN
    RAISE EXCEPTION 'personal quote requires confirmation consumption' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;

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
  IF personal->>'schema' NOT IN ('personal-quote-v2','personal-quote-v3','personal-quote-v4') THEN RETURN NEW; END IF;
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

-- New helper/trigger functions do not retain implicit PUBLIC EXECUTE.
REVOKE ALL ON FUNCTION zzsh_order.assert_personal_growth_order_v4(zzsh_order.rental_order) FROM PUBLIC;
