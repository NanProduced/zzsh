-- TR-GUARD-2: formal corrective migration for the already-applied 0050 guard.
-- The normalized quote remains at the order snapshot root; personal-quote-v2
-- keeps its real persisted 11-key personal object without a nested quote.
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
  key_count integer;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.confirmation_id IS DISTINCT FROM OLD.confirmation_id THEN
      RAISE EXCEPTION 'confirmation consumption is immutable' USING ERRCODE='40001';
    END IF;
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
      OR (personal_schema IS DISTINCT FROM 'personal-quote-v1' AND personal_schema IS DISTINCT FROM 'personal-quote-v2')
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

    IF personal_schema='personal-quote-v2' THEN
      personal_doc := NEW.quote_snapshot->'personal';
      IF jsonb_typeof(personal_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'invalid personal order snapshot' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(personal_doc) AS object_key(key);
      IF key_count <> 11 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(personal_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY[
          'schema','userId','ownerUserId','accountId','listingVersionId','listingHash',
          'fullPayoutDeclaration','ruleRefs','membership','guarantee','funding'
        ]::text[]))
      ) THEN
        RAISE EXCEPTION 'invalid personal quote v2 shape' USING ERRCODE='40001';
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
        OR personal_doc->>'schema' IS DISTINCT FROM 'personal-quote-v2'
        OR NEW.quote_snapshot ? 'fullPayoutSelected'
        OR NEW.quote_snapshot ? 'fullPayoutFeeCents' THEN
        RAISE EXCEPTION 'personal quote v2 binding is invalid' USING ERRCODE='40001';
      END IF;

      declaration_doc := personal_doc->'fullPayoutDeclaration';
      IF jsonb_typeof(declaration_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2 declaration is invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(declaration_doc) AS object_key(key);
      IF key_count <> 2 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(declaration_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY['schema','selected']::text[]))
      ) OR declaration_doc->>'schema' IS DISTINCT FROM 'full-payout-declaration-v1'
        OR jsonb_typeof(declaration_doc->'selected') IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'personal quote v2 declaration is invalid' USING ERRCODE='40001';
      END IF;

      rule_refs_doc := personal_doc->'ruleRefs';
      IF jsonb_typeof(rule_refs_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2 rule references are invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(rule_refs_doc) AS object_key(key);
      IF key_count <> 5 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(rule_refs_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY['releaseId','priceVersionId','termVersionId','agreementVersionId','agreementDigest']::text[]))
      ) THEN
        RAISE EXCEPTION 'personal quote v2 rule references are invalid' USING ERRCODE='40001';
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
        RAISE EXCEPTION 'personal quote v2 rule references are invalid' USING ERRCODE='40001';
      END IF;

      membership_doc := personal_doc->'membership';
      IF jsonb_typeof(membership_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2 membership is invalid' USING ERRCODE='40001';
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
        RAISE EXCEPTION 'personal quote v2 membership is invalid' USING ERRCODE='40001';
      END IF;

      guarantee_doc := personal_doc->'guarantee';
      IF jsonb_typeof(guarantee_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2 guarantee is invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(guarantee_doc) AS object_key(key);
      IF key_count <> 2 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(guarantee_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY['status','reference']::text[]))
      ) OR jsonb_typeof(guarantee_doc->'status') IS DISTINCT FROM 'string'
        OR jsonb_typeof(guarantee_doc->'reference') IS DISTINCT FROM 'string'
        OR COALESCE(guarantee_doc->>'status','') NOT IN ('SATISFIED','NOT_REQUIRED')
        OR COALESCE(NULLIF(trim(guarantee_doc->>'reference'),''),'') = '' THEN
        RAISE EXCEPTION 'personal quote v2 guarantee is invalid' USING ERRCODE='40001';
      END IF;

      funding_doc := personal_doc->'funding';
      IF jsonb_typeof(funding_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2 funding is invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(funding_doc) AS object_key(key);
      IF key_count <> 9 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(funding_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY[
          'version','sourceRef','baseDepositCents','publisherBailRequirementCents',
          'fullPayoutPolicyRef','fullPayoutPolicyVersion','disclosureVersion','vipWaiver','svipWaiver'
        ]::text[]))
      ) THEN
        RAISE EXCEPTION 'personal quote v2 funding is invalid' USING ERRCODE='40001';
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
        RAISE EXCEPTION 'personal quote v2 funding is invalid' USING ERRCODE='40001';
      END IF;

      -- The normalized quote is at quote_snapshot root in the real producer.
      -- Do not reintroduce personal.quote just to satisfy the old 0050 shape.
      IF NEW.quote_snapshot->>'priceVersionId' IS DISTINCT FROM rule_refs_doc->>'priceVersionId'
        OR NEW.quote_snapshot->>'ruleReleaseId' IS DISTINCT FROM NEW.rule_release_id
        OR NEW.quote_snapshot->>'termSeconds' IS DISTINCT FROM NEW.term_seconds::text THEN
        RAISE EXCEPTION 'personal quote v2 quote binding is invalid' USING ERRCODE='40001';
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
