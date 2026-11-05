-- A source-listed legacy quote uses an explicit v3 payload; existing v1/v2 hashes and acceptances stay unchanged.
ALTER TABLE zzsh_supply.listing_version DROP CONSTRAINT listing_version_schema_version_check;
ALTER TABLE zzsh_supply.listing_version ADD CONSTRAINT listing_version_schema_version_check CHECK(schema_version IN (1,2,3));

-- Minimal sealed facts, not a path back to the machine that performed the import.
CREATE TABLE zzsh_supply.legacy_listed_policy_evidence (
 policy_digest text PRIMARY KEY CHECK(policy_digest ~ '^[0-9a-f]{64}$'),
 policy_canonical text NOT NULL CHECK(octet_length(policy_canonical)<=32768),
 policy jsonb NOT NULL CHECK(jsonb_typeof(policy)='object'),
 created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(policy_canonical::jsonb=policy),
 CHECK(policy_digest=encode(sha256(convert_to(policy_canonical,'UTF8')),'hex'))
);
CREATE TABLE zzsh_supply.legacy_listed_quote_evidence (
 listing_version_id text PRIMARY KEY REFERENCES zzsh_supply.listing_version(id),
 account_id text NOT NULL REFERENCES zzsh_supply.rental_account(id),
 policy_digest text NOT NULL REFERENCES zzsh_supply.legacy_listed_policy_evidence(policy_digest),
 quote_digest text NOT NULL CHECK(quote_digest ~ '^[0-9a-f]{64}$'),
 quote_canonical text NOT NULL CHECK(octet_length(quote_canonical)<=32768),
 quote jsonb NOT NULL CHECK(jsonb_typeof(quote)='object'),
 created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(quote_canonical::jsonb=quote),
 CHECK(quote_digest=encode(sha256(convert_to(quote_canonical,'UTF8')),'hex'))
);
REVOKE ALL ON zzsh_supply.legacy_listed_policy_evidence,zzsh_supply.legacy_listed_quote_evidence FROM PUBLIC;

CREATE FUNCTION zzsh_supply.guard_legacy_listed_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'legacy quote evidence is immutable' USING ERRCODE='40001'; END IF;
 IF current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin'
   OR current_setting('zzsh.actor_id',true) IS DISTINCT FROM NEW.created_by_admin_id
 THEN RAISE EXCEPTION 'legacy quote evidence requires an identified admin' USING ERRCODE='23514'; END IF;
 IF TG_TABLE_NAME='legacy_listed_policy_evidence' THEN
  IF NEW.policy->>'schema' IS DISTINCT FROM 'legacy-listed-policy-frozen-v1'
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
CREATE TRIGGER legacy_listed_policy_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_supply.legacy_listed_policy_evidence
 FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_legacy_listed_evidence();
CREATE TRIGGER legacy_listed_quote_evidence_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_supply.legacy_listed_quote_evidence
 FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_legacy_listed_evidence();

CREATE FUNCTION zzsh_supply.legacy_listed_quote_source_valid(account_value text, owner_value text, version_value text, doc jsonb)
RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT COALESCE(doc->>'schemaVersion'='3' AND doc->>'quoteSource'='LEGACY_QUOTED'
   AND doc#>>'{legacyQuote,schema}'='legacy-listed-quote-v1'
   AND doc#>>'{legacyQuote,sourceSystem}'='legacy_mysql_restore'
   AND doc#>>'{legacyQuote,sourceEntity}'='la_rental_accounts'
   AND COALESCE(doc#>>'{legacyQuote,sourcePolicyDigest}','') ~ '^[0-9a-f]{64}$'
   AND doc#>>'{quoteValues,schemaVersion}'='3'
   AND doc#>>'{quoteValues,quoteSource}'='LEGACY_QUOTED'
   AND doc#>'{quoteValues,legacyQuote}'=doc->'legacyQuote'
   AND EXISTS (SELECT 1 FROM zzsh_supply.legacy_supply_map m
     JOIN zzsh_supply.rental_account a ON a.id=m.account_id
     JOIN zzsh_supply.legacy_listed_quote_evidence e ON e.account_id=a.id AND e.listing_version_id=version_value
       AND e.policy_digest=doc#>>'{legacyQuote,sourcePolicyDigest}' AND e.quote=doc->'quoteValues'
     JOIN zzsh_supply.legacy_listed_policy_evidence policy ON policy.policy_digest=e.policy_digest
     JOIN zzsh_supply.legacy_listing_read_snapshot h ON h.account_id=m.account_id AND h.observation_version_id=m.version_id
       AND h.source_system=m.source_system AND h.source_entity=m.source_entity AND h.legacy_id=m.legacy_id AND h.source_digest=m.source_digest
     WHERE a.id=account_value AND a.owner_user_id=owner_value AND h.source_status=3
       AND m.source_system=doc#>>'{legacyQuote,sourceSystem}' AND m.source_entity=doc#>>'{legacyQuote,sourceEntity}'
       AND m.legacy_id=doc#>>'{legacyQuote,legacyId}' AND m.source_digest=doc#>>'{legacyQuote,sourceDigest}'
       AND m.version_id=doc#>>'{legacyQuote,observationVersionId}'
       AND policy.policy->'accountSourceDigests' @> jsonb_build_array(jsonb_build_object('id',m.legacy_id,'sha256',m.source_digest))
       AND doc#>>'{legacyQuote,spread}'=CASE WHEN doc#>>'{legacyQuote,rentalMode}'='fast' THEN policy.policy->>'fastSpread' ELSE policy.policy->>'ordinarySpread' END), false)
$$;

CREATE FUNCTION zzsh_supply.guard_legacy_listed_quote_v3() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_value text;
BEGIN
 IF NEW.schema_version=3 OR NEW.payload->>'schemaVersion'='3' OR NEW.payload#>>'{quoteValues,schemaVersion}'='3'
   OR NEW.payload->>'quoteSource'='LEGACY_QUOTED' OR NEW.payload#>>'{quoteValues,quoteSource}'='LEGACY_QUOTED' THEN
  SELECT owner_user_id INTO owner_value FROM zzsh_supply.rental_account WHERE id=NEW.account_id;
  IF NEW.schema_version IS DISTINCT FROM 3 OR NOT zzsh_supply.legacy_listed_quote_source_valid(NEW.account_id,owner_value,NEW.id,NEW.payload)
    OR NEW.attributes#>'{full_payout_declaration,selected}' IS DISTINCT FROM NEW.payload#>'{legacyQuote,fullPayoutSelected}'
    OR NEW.payload#>'{declaration,attributes,full_payout_declaration,selected}' IS DISTINCT FROM NEW.payload#>'{legacyQuote,fullPayoutSelected}'
  THEN RAISE EXCEPTION 'legacy quote source is not bound to the original listing' USING ERRCODE='23514'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER legacy_listed_quote_v3_guard BEFORE INSERT OR UPDATE ON zzsh_supply.listing_version
 FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_legacy_listed_quote_v3();

CREATE OR REPLACE FUNCTION zzsh_supply.guard_legacy_takeover_authorization() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.acceptance_kind='LEGACY_TAKEOVER_AUTHORIZED' AND NOT EXISTS(
   SELECT 1 FROM zzsh_supply.legacy_supply_map m JOIN zzsh_supply.rental_account a ON a.id=m.account_id
    JOIN zzsh_supply.listing_version v ON v.account_id=a.id AND v.id=NEW.listing_version_id
   WHERE a.id=NEW.account_id AND a.owner_user_id=NEW.owner_user_id AND a.legacy_hold='NONE' AND v.origin='NATIVE'
    AND v.content_hash=NEW.accepted_content_hash AND v.rule_release_id=NEW.rule_release_id
    AND (v.attributes#>>'{full_payout_declaration,selected}'='false' OR
      (v.attributes#>>'{full_payout_declaration,selected}'='true' AND v.schema_version=3
       AND NEW.authorization_evidence->>'legacyFullPayout'='1'
       AND NEW.authorization_evidence->>'basis'='ADMIN_AUTHORIZED_LEGACY_ELECTION'
       AND zzsh_supply.legacy_listed_quote_source_valid(a.id,a.owner_user_id,v.id,v.payload)))
    AND m.source_system=NEW.authorization_evidence->>'sourceSystem' AND m.source_entity=NEW.authorization_evidence->>'sourceEntity'
    AND m.legacy_id=NEW.authorization_evidence->>'legacyId' AND m.source_digest=NEW.authorization_evidence->>'sourceDigest'
    AND m.version_id=NEW.authorization_evidence->>'observationVersionId'
    AND NEW.authorization_evidence->>'authorizingAdminId'=current_setting('zzsh.actor_id',true)
    AND current_setting('zzsh.actor_type',true)='admin')
 THEN RAISE EXCEPTION 'Legacy takeover authorization lacks exact source/version/admin or owner terms required' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_supply.guard_full_payout_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE binding record;
BEGIN
 SELECT a.game_id,v.id AS version_id,v.payload,p.funding_policy AS policy INTO binding
   FROM zzsh_supply.rental_account a
   JOIN zzsh_supply.listing_version v ON v.id=NEW.listing_version_id AND v.account_id=a.id
   JOIN zzsh_supply.rule_release r ON r.id=NEW.rule_release_id AND v.rule_release_id=r.id
   JOIN zzsh_supply.price_version p ON p.id=r.price_version_id AND p.status='SEALED'
  WHERE a.id=NEW.account_id AND a.owner_user_id=NEW.owner_user_id AND v.content_hash=NEW.accepted_content_hash;
 IF binding.payload#>>'{declaration,attributes,full_payout_declaration,selected}'='true' THEN
  IF NEW.acceptance_kind='LEGACY_TAKEOVER_AUTHORIZED' AND zzsh_supply.legacy_listed_quote_source_valid(NEW.account_id,NEW.owner_user_id,binding.version_id,binding.payload) THEN
   IF NEW.full_payout_terms_version_id IS NOT NULL OR NEW.full_payout_terms_digest IS NOT NULL OR NEW.full_payout_disclosure_version IS NOT NULL
   THEN RAISE EXCEPTION 'legacy takeover cannot claim owner terms acceptance' USING ERRCODE='23514'; END IF;
  ELSIF NOT EXISTS (SELECT 1 FROM zzsh_supply.full_payout_terms_version t
      WHERE t.id=NEW.full_payout_terms_version_id AND t.game_id=binding.game_id AND t.status='SEALED'
        AND t.policy_ref=binding.policy->>'fullPayoutPolicyRef' AND t.policy_version=binding.policy->>'fullPayoutPolicyVersion'
        AND t.disclosure_version=binding.policy->>'disclosureVersion'
        AND t.digest=NEW.full_payout_terms_digest AND t.disclosure_version=NEW.full_payout_disclosure_version
        AND EXISTS(SELECT 1 FROM zzsh_supply.price_version p JOIN zzsh_supply.rule_release r ON r.price_version_id=p.id
          WHERE r.id=NEW.rule_release_id AND p.full_payout_terms_version_id=t.id
            AND p.full_payout_terms_digest=t.digest AND p.full_payout_disclosure_version=t.disclosure_version)) THEN
   RAISE EXCEPTION 'full-payout terms acceptance is missing or changed' USING ERRCODE='23514';
  END IF;
 ELSIF NEW.full_payout_terms_version_id IS NOT NULL THEN
  RAISE EXCEPTION 'full-payout terms acceptance does not apply' USING ERRCODE='23514';
 END IF;
 RETURN NEW;
END $$;

CREATE FUNCTION zzsh_order.guard_legacy_listed_personal_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v zzsh_supply.listing_version;
BEGIN
 SELECT * INTO v FROM zzsh_supply.listing_version WHERE id=NEW.listing_version_id AND account_id=NEW.account_id;
 IF NEW.quote_snapshot->>'schemaVersion'='3' OR NEW.quote_snapshot->>'quoteSource'='LEGACY_QUOTED' OR v.schema_version=3 THEN
  IF v.schema_version IS DISTINCT FROM 3 OR NEW.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '3'
    OR NEW.quote_snapshot->>'quoteKind' IS DISTINCT FROM 'ORDER_CONFIRMATION' OR NEW.confirmation_id IS NULL
    OR NEW.quote_snapshot#>>'{personal,schema}' IS DISTINCT FROM 'personal-quote-v4'
    OR NEW.quote_snapshot->>'quoteSource' IS DISTINCT FROM 'LEGACY_QUOTED'
    OR NEW.quote_snapshot->'legacyQuote' IS DISTINCT FROM v.payload->'legacyQuote'
    OR NOT zzsh_supply.legacy_listed_quote_source_valid(NEW.account_id,NEW.owner_user_id,v.id,v.payload)
  THEN RAISE EXCEPTION 'legacy quote requires a source-bound personal confirmation' USING ERRCODE='40001'; END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER legacy_listed_personal_order_guard BEFORE INSERT ON zzsh_order.rental_order
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_listed_personal_order();

CREATE OR REPLACE FUNCTION zzsh_order.derive_payment_referral_inputs(order_id_value text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE o zzsh_order.rental_order;v zzsh_order.distribution_policy_version;cfg jsonb;mode text;base numeric;minimum numeric;
 role_name text;party text;own zzsh_order.distribution_participant;relation zzsh_order.invitation_relation;
 parent_row record;graph_closed boolean;level jsonb;status text;pct text;n numeric;d numeric;scale integer;
 item jsonb;items jsonb[]:=ARRAY[]::jsonb[];raw_amounts numeric[]:=ARRAY[0::numeric,0::numeric];i integer;
 uncertain boolean;total numeric;uniform boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0));
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=order_id_value;
 IF o.id IS NULL OR o.currency<>'CNY' THEN RAISE EXCEPTION 'original native CNY order required' USING ERRCODE='23514';END IF;
 SELECT p.* INTO v FROM zzsh_order.distribution_policy_head h JOIN zzsh_order.distribution_policy_version p
  ON p.id=h.current_version_id AND p.scope=h.scope AND p.revision=h.revision
  WHERE h.scope=CASE WHEN EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.id=o.paid_confirmation_id AND p.order_id=o.id AND p.source='JOINPAY') THEN 'NATIVE' ELSE 'LOCAL_CONTROLLED' END FOR SHARE OF h;
 cfg:=v.canonical_config::jsonb;uniform:=cfg->>'schema'='distribution-policy.v2';
 IF o.quote_snapshot->'schemaVersion'='2'::jsonb OR (o.quote_snapshot->'schemaVersion'='3'::jsonb
   AND o.quote_snapshot->>'quoteSource'='LEGACY_QUOTED'
   AND o.quote_snapshot#>>'{legacyQuote,schema}'='legacy-listed-quote-v1'
   AND o.quote_snapshot#>>'{legacyQuote,sourceSystem}'='legacy_mysql_restore'
   AND o.quote_snapshot#>>'{legacyQuote,sourceEntity}'='la_rental_accounts')
 THEN mode:=o.quote_snapshot#>>'{pricingInputs,compatibility,rentalMode}';END IF;
 IF mode IS NULL OR mode NOT IN('ordinary','custom','fast') THEN mode:=NULL;END IF;
 IF cfg->>'schema'='distribution-policy.v3' THEN
  IF jsonb_typeof(o.quote_snapshot->'lines')='array' THEN
   SELECT CASE WHEN count(*)>0 AND bool_and(coalesce((
    line#>>'{platformAmount,currency}'='CNY' AND line#>>'{platformAmount,unit}'='yuan'
    AND line#>'{platformAmount,scale}'='2'::jsonb
    AND jsonb_typeof(line#>'{platformAmount,amount}')='string'
    AND line#>>'{platformAmount,amount}'<>'-0.00'
    AND coalesce(line#>>'{platformAmount,amount}','')~'^-?(0|[1-9][0-9]{0,21})[.][0-9]{2}$'),false))
    AND count(*)=count(line#>>'{platformAmount,amount}')
    THEN greatest(0,sum(CASE WHEN coalesce(line#>>'{platformAmount,amount}','')~'^-?(0|[1-9][0-9]{0,21})[.][0-9]{2}$'
     THEN (line#>>'{platformAmount,amount}')::numeric*100 END)) END INTO base
   FROM jsonb_array_elements(o.quote_snapshot->'lines') line WHERE line->>'pricingKind'='HAFF_RATIO' AND line->>'unit'='HAFF_BASE';
   IF base>=10::numeric^24 THEN base:=NULL;END IF;
  END IF;
 ELSIF o.quote_snapshot#>>'{platformFullProfit,currency}'='CNY'
  AND o.quote_snapshot#>>'{platformFullProfit,unit}'='yuan'
  AND o.quote_snapshot#>'{platformFullProfit,scale}'='2'::jsonb
  AND jsonb_typeof(o.quote_snapshot#>'{platformFullProfit,amount}')='string'
  AND COALESCE(o.quote_snapshot#>>'{platformFullProfit,amount}','')~'^(0|[1-9][0-9]{0,21})\.[0-9]{2}$'
 THEN base:=(o.quote_snapshot#>>'{platformFullProfit,amount}')::numeric*100;END IF;
 FOREACH role_name IN ARRAY ARRAY['OWNER_REFERRAL','RENTER_REFERRAL'] LOOP
  party:=CASE WHEN role_name='OWNER_REFERRAL' THEN o.owner_user_id ELSE o.renter_user_id END;
  SELECT * INTO own FROM zzsh_order.distribution_participant WHERE user_id=party;
  SELECT * INTO relation FROM zzsh_order.invitation_relation WHERE child_user_id=party AND type='DISTRIBUTION_LEADER';
  SELECT p.*,CASE WHEN s.account_status IS NULL THEN NULL ELSE NOT u.suspended AND s.account_status='ACTIVE' END AS owner_active
   INTO parent_row FROM zzsh_order.distribution_participant p JOIN zzsh_auth_user."user" u ON u.id=p.user_id
   LEFT JOIN zzsh_iam.user_identity_state s ON s.user_id=p.user_id WHERE p.user_id=relation.parent_user_id;
  graph_closed:=false;
  IF relation.parent_user_id IS NOT NULL THEN
   WITH RECURSIVE chain(user_id,path,cyclic) AS (
    SELECT relation.parent_user_id,ARRAY[relation.parent_user_id],false UNION ALL
    SELECT r.parent_user_id,c.path||r.parent_user_id,r.parent_user_id=ANY(c.path)
     FROM chain c JOIN zzsh_order.invitation_relation r ON r.child_user_id=c.user_id AND r.type='DISTRIBUTION_LEADER' WHERE NOT c.cyclic
   ) SELECT COALESCE(bool_and(NOT c.cyclic AND COALESCE(
      p.leader_knowledge='KNOWN_NONE' AND r.parent_user_id IS NULL
      OR p.leader_knowledge='KNOWN_PARENT' AND r.parent_user_id IS NOT NULL,false)),false)
    INTO graph_closed FROM chain c LEFT JOIN zzsh_order.distribution_participant p ON p.user_id=c.user_id
    LEFT JOIN zzsh_order.invitation_relation r ON r.child_user_id=c.user_id AND r.type='DISTRIBUTION_LEADER';
  END IF;
  pct:=NULL;n:=NULL;d:=NULL;level:=NULL;
  IF v.id IS NULL THEN status:='UNKNOWN_POLICY';
  ELSIF cfg->'enabled'<>'true'::jsonb THEN status:='SKIPPED_DISABLED';
  ELSIF mode IS NULL THEN status:='UNKNOWN_MODE';
  ELSIF mode='fast' THEN status:='SKIPPED_FAST';
  ELSIF NOT(cfg->'accountModes' ? mode) THEN status:='SKIPPED_MODE';
  ELSIF own.leader_knowledge='KNOWN_NONE' AND relation.id IS NULL THEN status:='SKIPPED_NO_PARENT';
  ELSIF own.leader_knowledge IS DISTINCT FROM 'KNOWN_PARENT' OR relation.id IS NULL OR NOT graph_closed
    OR relation.parent_user_id=party OR relation.source_digest IS NULL THEN status:='UNKNOWN_RELATION';
  ELSIF parent_row.user_id IS NULL OR parent_row.owner_active IS NULL OR parent_row.eligibility='UNKNOWN'
    OR parent_row.commission_frozen IS NULL THEN status:='UNKNOWN_PARTICIPANT';
  ELSIF NOT parent_row.owner_active OR parent_row.eligibility='INELIGIBLE' OR parent_row.commission_frozen THEN status:='SKIPPED_INELIGIBLE';
  ELSIF uniform THEN
   pct:=CASE WHEN role_name='OWNER_REFERRAL' THEN cfg->>'ownerPercent' ELSE cfg->>'renterPercent' END;
   scale:=CASE WHEN strpos(pct,'.')=0 THEN 0 ELSE length(split_part(pct,'.',2)) END;
   n:=pct::numeric*power(10::numeric,scale);d:=100*power(10::numeric,scale);
   status:=CASE WHEN base IS NULL THEN 'UNKNOWN_ESTIMATE' ELSE 'ELIGIBLE' END;
  ELSE
   SELECT value INTO level FROM jsonb_array_elements(cfg->'levels') WHERE value->>'code'=parent_row.level_code;
   IF level IS NULL THEN status:='UNKNOWN_LEVEL';
   ELSE
    pct:=CASE WHEN role_name='OWNER_REFERRAL' THEN level->>'ownerPercent' ELSE level->>'renterPercent' END;
    scale:=CASE WHEN strpos(pct,'.')=0 THEN 0 ELSE length(split_part(pct,'.',2)) END;
    n:=pct::numeric*power(10::numeric,scale);d:=100*power(10::numeric,scale);
    status:=CASE WHEN base IS NULL THEN 'UNKNOWN_ESTIMATE' ELSE 'ELIGIBLE' END;
   END IF;
  END IF;
  item:=jsonb_build_object('role',role_name,'partyUserId',party,'status',status,
   'beneficiaryUserId',parent_row.user_id,'relationId',relation.id,'relationDigest',relation.source_digest,
   'levelCode',CASE WHEN uniform THEN NULL ELSE parent_row.level_code END,'percent',pct,
   'ratio',CASE WHEN pct IS NULL THEN NULL ELSE jsonb_build_object('numerator',n::numeric(24,0)::text,'denominator',d::numeric(24,0)::text) END,'estimatedCents',NULL);
  items:=array_append(items,item);
 END LOOP;
 IF v.id IS NOT NULL AND base IS NOT NULL THEN
  SELECT EXISTS(SELECT 1 FROM unnest(items) r WHERE r->>'status' LIKE 'UNKNOWN%') INTO uncertain;
  IF NOT uncertain THEN
   FOR i IN 1..2 LOOP
    IF items[i]->>'status'='ELIGIBLE' THEN raw_amounts[i]:=floor(base*(items[i]#>>'{ratio,numerator}')::numeric/(items[i]#>>'{ratio,denominator}')::numeric+0.5);END IF;
   END LOOP;
  END IF;
  total:=raw_amounts[1]+raw_amounts[2];minimum:=(cfg->>'minimumAccrualCents')::numeric;
  FOR i IN 1..2 LOOP
   IF items[i]->>'status'='ELIGIBLE' THEN
    IF uncertain OR total>base THEN items[i]:=jsonb_set(items[i],'{status}','"UNKNOWN_ESTIMATE_CONSERVATION"'::jsonb);
    ELSIF raw_amounts[i]=0 OR raw_amounts[i]<minimum THEN items[i]:=jsonb_set(items[i],'{status}','"SKIPPED_BELOW_MIN"'::jsonb);
    ELSE items[i]:=jsonb_set(items[i],'{estimatedCents}',to_jsonb(raw_amounts[i]::numeric(24,0)::text));END IF;
   END IF;
  END LOOP;
 END IF;
 RETURN jsonb_build_object('policyVersion',v.id,'policyDigest',v.config_digest,'policyConfig',cfg,'accountMode',mode,
  'estimateBaseCents',CASE WHEN base IS NULL THEN NULL ELSE base::numeric(24,0)::text END,'roles',to_jsonb(items));
END $$;
