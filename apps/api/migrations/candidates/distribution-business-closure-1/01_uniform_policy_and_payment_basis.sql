-- UNNUMBERED CANDIDATE. Root owns numbering/journal/rollback. NOT APPLIED to any database.
-- Makes distribution-policy.v2 UNIFORM valid for both LOCAL_CONTROLLED and NATIVE scopes and
-- aligns the immutable payment-basis derivation with the application freeze.
BEGIN;

ALTER TABLE zzsh_order.distribution_policy_version
  DROP CONSTRAINT distribution_policy_version_schema_version_check,
  ADD CONSTRAINT distribution_policy_version_schema_version_check
    CHECK(schema_version IN('distribution-policy.v1','distribution-policy.v2'));

CREATE OR REPLACE FUNCTION zzsh_order.guard_distribution_policy_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc jsonb:=NEW.canonical_config::jsonb;l jsonb;u jsonb;c jsonb;keys integer;defaults integer:=0;max_r numeric:=0;max_o numeric:=0;
BEGIN
 SELECT count(*) INTO keys FROM jsonb_object_keys(doc);
 IF NEW.schema_version='distribution-policy.v2' THEN
  IF keys<>13 OR doc->>'schema' IS DISTINCT FROM 'distribution-policy.v2' OR doc->>'scope' IS DISTINCT FROM NEW.scope
   OR jsonb_typeof(doc->'enabled') IS DISTINCT FROM 'boolean' OR doc->>'participation' IS DISTINCT FROM 'AUTO_AT_REGISTRATION'
   OR doc->'depth' IS DISTINCT FROM '1'::jsonb OR doc->'selfRebate' IS DISTINCT FROM 'false'::jsonb
   OR doc->>'rateMode' IS DISTINCT FROM 'UNIFORM'
   OR jsonb_typeof(doc->'minimumAccrualCents') IS DISTINCT FROM 'string' OR COALESCE(doc->>'minimumAccrualCents','')!~'^(0|[1-9][0-9]{0,23})$'
   OR jsonb_typeof(doc->'settlementDelayDays') IS DISTINCT FROM 'number' OR COALESCE(doc->>'settlementDelayDays','')!~'^(0|[1-9][0-9]{0,5})$'
   OR jsonb_typeof(doc->'accountModes') IS DISTINCT FROM 'array' OR jsonb_typeof(doc->'levels') IS DISTINCT FROM 'array'
   OR jsonb_array_length(doc->'levels')<>0
   OR jsonb_typeof(doc->'renterPercent') IS DISTINCT FROM 'string' OR COALESCE(doc->>'renterPercent','')!~'^(0|[1-9][0-9]{0,2})(\.[0-9]{1,8})?$'
   OR jsonb_typeof(doc->'ownerPercent') IS DISTINCT FROM 'string' OR COALESCE(doc->>'ownerPercent','')!~'^(0|[1-9][0-9]{0,2})(\.[0-9]{1,8})?$'
  THEN RAISE EXCEPTION 'typed uniform policy shape invalid' USING ERRCODE='23514';END IF;
  IF jsonb_array_length(doc->'accountModes') NOT BETWEEN 1 AND 2 OR EXISTS(
   SELECT 1 FROM jsonb_array_elements(doc->'accountModes') m WHERE m NOT IN('"ordinary"'::jsonb,'"custom"'::jsonb))
   OR (SELECT count(DISTINCT m) FROM jsonb_array_elements(doc->'accountModes') m)<>jsonb_array_length(doc->'accountModes')
   OR (doc->>'renterPercent')::numeric+(doc->>'ownerPercent')::numeric>100
  THEN RAISE EXCEPTION 'uniform modes or role rate bounds invalid' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF keys<>10 OR doc->>'schema' IS DISTINCT FROM NEW.schema_version OR doc->>'scope' IS DISTINCT FROM NEW.scope
  OR jsonb_typeof(doc->'enabled') IS DISTINCT FROM 'boolean' OR doc->>'participation' IS DISTINCT FROM 'AUTO_AT_REGISTRATION'
  OR doc->'depth' IS DISTINCT FROM '1'::jsonb OR doc->'selfRebate' IS DISTINCT FROM 'false'::jsonb
  OR jsonb_typeof(doc->'minimumAccrualCents') IS DISTINCT FROM 'string' OR COALESCE(doc->>'minimumAccrualCents','')!~'^(0|[1-9][0-9]{0,23})$'
  OR jsonb_typeof(doc->'settlementDelayDays') IS DISTINCT FROM 'number' OR COALESCE(doc->>'settlementDelayDays','')!~'^(0|[1-9][0-9]{0,5})$'
  OR jsonb_typeof(doc->'accountModes') IS DISTINCT FROM 'array' OR jsonb_typeof(doc->'levels') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'typed distribution policy shape invalid' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(doc->'accountModes') NOT BETWEEN 1 AND 2 OR EXISTS(
  SELECT 1 FROM jsonb_array_elements(doc->'accountModes') m WHERE m NOT IN('"ordinary"'::jsonb,'"custom"'::jsonb))
  OR (SELECT count(DISTINCT m) FROM jsonb_array_elements(doc->'accountModes') m)<>jsonb_array_length(doc->'accountModes')
  OR jsonb_array_length(doc->'levels') NOT BETWEEN 1 AND 999
 THEN RAISE EXCEPTION 'distribution modes or levels invalid' USING ERRCODE='23514';END IF;
 FOR l IN SELECT value FROM jsonb_array_elements(doc->'levels') LOOP
  IF jsonb_typeof(l) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'typed level object required' USING ERRCODE='23514';END IF;
  SELECT count(*) INTO keys FROM jsonb_object_keys(l);
  IF keys<>6 OR jsonb_typeof(l->'code') IS DISTINCT FROM 'string' OR COALESCE(l->>'code','')!~'^[A-Za-z][A-Za-z0-9_-]{0,63}$'
   OR jsonb_typeof(l->'rank') IS DISTINCT FROM 'number' OR COALESCE(l->>'rank','')!~'^[1-9][0-9]{0,2}$'
   OR jsonb_typeof(l->'default') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(l->'renterPercent') IS DISTINCT FROM 'string' OR COALESCE(l->>'renterPercent','')!~'^(0|[1-9][0-9]{0,2})(\.[0-9]{1,8})?$'
   OR jsonb_typeof(l->'ownerPercent') IS DISTINCT FROM 'string' OR COALESCE(l->>'ownerPercent','')!~'^(0|[1-9][0-9]{0,2})(\.[0-9]{1,8})?$'
  THEN RAISE EXCEPTION 'typed level fields invalid' USING ERRCODE='23514';END IF;
  max_r:=greatest(max_r,(l->>'renterPercent')::numeric);max_o:=greatest(max_o,(l->>'ownerPercent')::numeric);
  IF l->'default'='true'::jsonb THEN defaults:=defaults+1;END IF;
  u:=l->'upgrade';IF u IS DISTINCT FROM 'null'::jsonb THEN
   IF jsonb_typeof(u) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'typed upgrade required' USING ERRCODE='23514';END IF;
   SELECT count(*) INTO keys FROM jsonb_object_keys(u);
   IF keys<>2 OR COALESCE(u->>'match','') NOT IN('ANY','ALL') OR jsonb_typeof(u->'conditions') IS DISTINCT FROM 'array' OR l->'default'='true'::jsonb
   THEN RAISE EXCEPTION 'typed upgrade shape invalid' USING ERRCODE='23514';END IF;
   IF jsonb_array_length(u->'conditions') NOT BETWEEN 1 AND 4 THEN RAISE EXCEPTION 'empty upgrade is not automatic eligibility' USING ERRCODE='23514';END IF;
   FOR c IN SELECT value FROM jsonb_array_elements(u->'conditions') LOOP
    IF jsonb_typeof(c) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'typed upgrade condition required' USING ERRCODE='23514';END IF;
    SELECT count(*) INTO keys FROM jsonb_object_keys(c);
    IF keys<>2 OR COALESCE(c->>'metric','') NOT IN('LAST_PAID_AMOUNT','TOTAL_PAID_AMOUNT','PAID_COUNT','SETTLED_REFERRAL')
     OR jsonb_typeof(c->'value') IS DISTINCT FROM 'string' OR COALESCE(c->>'value','')!~'^(0|[1-9][0-9]{0,23})$'
    THEN RAISE EXCEPTION 'typed upgrade condition invalid' USING ERRCODE='23514';END IF;
   END LOOP;
   IF (SELECT count(DISTINCT x->>'metric') FROM jsonb_array_elements(u->'conditions') x)<>jsonb_array_length(u->'conditions')
   THEN RAISE EXCEPTION 'duplicate upgrade metric' USING ERRCODE='23514';END IF;
  END IF;
 END LOOP;
 IF defaults<>1 OR max_r+max_o>100
  OR (SELECT count(DISTINCT x->>'code') FROM jsonb_array_elements(doc->'levels') x)<>jsonb_array_length(doc->'levels')
  OR (SELECT count(DISTINCT x->>'rank') FROM jsonb_array_elements(doc->'levels') x)<>jsonb_array_length(doc->'levels')
 THEN RAISE EXCEPTION 'distribution defaults, stable levels or cross-level rate bounds invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

-- The previous head guard serialized every scope on the LOCAL advisory key.
CREATE OR REPLACE FUNCTION zzsh_order.guard_distribution_policy_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('zzsh:distribution-policy:'||NEW.scope,0));
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'policy head cannot be deleted' USING ERRCODE='40001';END IF;
 IF TG_OP='INSERT' AND NEW.revision<>1 OR TG_OP='UPDATE' AND(NEW.scope IS DISTINCT FROM OLD.scope OR NEW.revision<>OLD.revision+1 OR NEW.current_version_id=OLD.current_version_id)
  THEN RAISE EXCEPTION 'policy head requires exact next immutable version' USING ERRCODE='40001';END IF;
 RETURN NEW;
END $$;

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
 IF o.quote_snapshot->'schemaVersion'='2'::jsonb THEN mode:=o.quote_snapshot#>>'{pricingInputs,compatibility,rentalMode}';END IF;
 IF mode IS NULL OR mode NOT IN('ordinary','custom','fast') THEN mode:=NULL;END IF;
 IF o.quote_snapshot#>>'{platformFullProfit,currency}'='CNY'
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

COMMIT;
