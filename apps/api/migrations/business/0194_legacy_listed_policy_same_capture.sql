-- V2 records retain the same-snapshot limitation without changing existing V1 evidence.
CREATE OR REPLACE FUNCTION zzsh_supply.guard_legacy_listed_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'legacy quote evidence is immutable' USING ERRCODE='40001'; END IF;
 IF current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin'
   OR current_setting('zzsh.actor_id',true) IS DISTINCT FROM NEW.created_by_admin_id
 THEN RAISE EXCEPTION 'legacy quote evidence requires an identified admin' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='legacy_listed_policy_evidence' THEN
  IF (NEW.policy->>'schema' IS DISTINCT FROM 'legacy-listed-policy-frozen-v1'
    AND (NEW.policy->>'schema' IS DISTINCT FROM 'legacy-listed-policy-frozen-v2'
      OR NEW.policy->>'temporalLimit' IS DISTINCT FROM 'SAME_MYSQL_SNAPSHOT_RUNTIME_REDIS_NOT_CAPTURED'
      OR NEW.policy ? 'supplementStartedAt' OR NEW.policy ? 'supplementFinishedAt'
      OR COALESCE(NEW.policy->>'baseCaptureStartedAt','') = '' OR COALESCE(NEW.policy->>'baseCaptureFinishedAt','') = ''
      OR COALESCE(NEW.policy->>'sourceBindingSha256','') !~ '^[0-9a-f]{64}$'
      OR COALESCE(NEW.policy->>'verifierSha256','') !~ '^[0-9a-f]{64}$'
      OR CASE WHEN jsonb_typeof(NEW.policy->'accountSourceDigests')='array'
        THEN EXISTS (SELECT 1 FROM jsonb_array_elements(NEW.policy->'accountSourceDigests') item
          WHERE COALESCE(item->>'id','') !~ '^[1-9][0-9]{0,23}$' OR COALESCE(item->>'sha256','') !~ '^[0-9a-f]{64}$')
        ELSE true END))
    OR NEW.policy->>'sourceSystem' IS DISTINCT FROM 'legacy_mysql_restore'
    OR NEW.policy->>'sourceEntity' IS DISTINCT FROM 'la_rental_accounts'
    OR jsonb_typeof(NEW.policy->'accountSourceDigests') IS DISTINCT FROM 'array'
    OR COALESCE(NEW.policy->>'sourceAccountCount','') !~ '^[1-9][0-9]{0,4}$'
    OR jsonb_array_length(NEW.policy->'accountSourceDigests')<>(NEW.policy->>'sourceAccountCount')::integer
    OR (SELECT count(DISTINCT item->>'id') FROM jsonb_array_elements(NEW.policy->'accountSourceDigests') item)<>jsonb_array_length(NEW.policy->'accountSourceDigests')
    OR COALESCE(NEW.policy->>'evidenceBundleSha256','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(NEW.policy->>'sourceReceiptSha256','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(NEW.policy->>'dumpSha256','') !~ '^[0-9a-f]{64}$'
    OR NEW.policy#>>'{policyAuthority,decision}' IS DISTINCT FROM 'OWNER_APPROVED_MYSQL_SNAPSHOT_TEST_ONLY'
    OR NEW.policy#>>'{policyAuthority,scope}' IS DISTINCT FROM 'LOCAL_AND_TEST_SERVER'
    OR NEW.policy#>>'{policyAuthority,runtimeCacheKnowledge}' IS DISTINCT FROM 'UNKNOWN'
    OR NEW.policy#>>'{policyAuthority,productionCutover}' IS DISTINCT FROM 'REVERIFY_SOURCE_RUNTIME_POLICY'
    OR COALESCE(NEW.policy#>>'{policyAuthority,authoritySha256}','') !~ '^[0-9a-f]{64}$'
  THEN RAISE EXCEPTION 'legacy quote policy evidence shape invalid' USING ERRCODE='23514'; END IF;
 ELSIF NOT EXISTS(SELECT 1 FROM zzsh_supply.listing_version v JOIN zzsh_supply.legacy_supply_map m ON m.account_id=v.account_id
    JOIN zzsh_supply.legacy_listing_read_snapshot h ON h.account_id=m.account_id AND h.observation_version_id=m.version_id
      AND h.source_system=m.source_system AND h.source_entity=m.source_entity AND h.legacy_id=m.legacy_id AND h.source_digest=m.source_digest
    JOIN zzsh_supply.legacy_listed_policy_evidence e ON e.policy_digest=NEW.policy_digest
    WHERE v.id=NEW.listing_version_id AND v.account_id=NEW.account_id AND v.origin='NATIVE' AND v.review_state='DRAFT'
      AND h.source_status=3 AND m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts'
      AND NEW.quote->>'schemaVersion'='3' AND NEW.quote->>'quoteSource'='LEGACY_QUOTED'
      AND NEW.quote#>>'{legacyQuote,sourceSystem}'=m.source_system AND NEW.quote#>>'{legacyQuote,sourceEntity}'=m.source_entity
      AND NEW.quote#>>'{legacyQuote,legacyId}'=m.legacy_id AND NEW.quote#>>'{legacyQuote,sourceDigest}'=m.source_digest
      AND NEW.quote#>>'{legacyQuote,observationVersionId}'=m.version_id AND NEW.quote#>>'{legacyQuote,sourcePolicyDigest}'=NEW.policy_digest
      AND e.policy->'accountSourceDigests' @> jsonb_build_array(jsonb_build_object('id',m.legacy_id,'sha256',m.source_digest))
      AND NEW.quote#>>'{legacyQuote,spread}'=CASE WHEN NEW.quote#>>'{legacyQuote,rentalMode}'='fast' THEN e.policy->>'fastSpread' ELSE e.policy->>'ordinarySpread' END)
 THEN RAISE EXCEPTION 'legacy quote evidence source or policy differs' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
--> statement-breakpoint
COMMENT ON FUNCTION zzsh_supply.guard_legacy_listed_evidence() IS '约束旧在架来源政策和报价证据；V2 仅承认同快照且 Redis 未采集的范围。';
