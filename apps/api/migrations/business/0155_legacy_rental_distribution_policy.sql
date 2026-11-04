-- Unnumbered candidate. Apply in one forward transaction after the current business journal.
ALTER TABLE zzsh_order.distribution_policy_version
 DROP CONSTRAINT distribution_policy_version_schema_version_check,
 ADD CONSTRAINT distribution_policy_version_schema_version_check
 CHECK(schema_version IN('distribution-policy.v1','distribution-policy.v2','distribution-policy.v3'));

CREATE OR REPLACE FUNCTION zzsh_order.guard_distribution_policy_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc jsonb:=NEW.canonical_config::jsonb;l jsonb;u jsonb;c jsonb;keys integer;defaults integer:=0;max_r numeric:=0;max_o numeric:=0;proof jsonb;
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
 IF NEW.schema_version='distribution-policy.v3' THEN
  proof:=doc->'legacySource';
  IF jsonb_typeof(proof) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'legacy rental policy proof required' USING ERRCODE='23514';END IF;
  IF (SELECT count(*) FROM jsonb_object_keys(proof))<>4 OR EXISTS(
    SELECT 1 FROM unnest(ARRAY['receiptSha256','configurationSha256','levelsSha256']) k
    WHERE jsonb_typeof(proof->k) IS DISTINCT FROM 'string' OR coalesce(proof->>k,'')!~'^[0-9a-f]{64}$')
    OR jsonb_typeof(proof->'levelNames') IS DISTINCT FROM 'object'
   THEN RAISE EXCEPTION 'legacy rental policy proof differs' USING ERRCODE='23514';END IF;
  keys:=keys-1;
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
  IF NEW.schema_version='distribution-policy.v3' AND
   (l->>'code'!~'^legacy_[1-9][0-9]{0,18}$' OR l->'upgrade' IS DISTINCT FROM 'null'::jsonb
    OR jsonb_typeof(proof->'levelNames'->(l->>'code')) IS DISTINCT FROM 'string'
    OR btrim(proof->'levelNames'->>(l->>'code'))='' OR length(proof->'levelNames'->>(l->>'code'))>100)
   THEN RAISE EXCEPTION 'legacy rental policy level metadata differs' USING ERRCODE='23514';END IF;
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
 IF NEW.schema_version='distribution-policy.v3' AND
  (SELECT count(*) FROM jsonb_object_keys(proof->'levelNames'))<>jsonb_array_length(doc->'levels')
  THEN RAISE EXCEPTION 'legacy rental level set differs' USING ERRCODE='23514';END IF;
 IF defaults<>1 OR max_r+max_o>100
  OR (SELECT count(DISTINCT x->>'code') FROM jsonb_array_elements(doc->'levels') x)<>jsonb_array_length(doc->'levels')
  OR (SELECT count(DISTINCT x->>'rank') FROM jsonb_array_elements(doc->'levels') x)<>jsonb_array_length(doc->'levels')
 THEN RAISE EXCEPTION 'distribution defaults, stable levels or cross-level rate bounds invalid' USING ERRCODE='23514';END IF;
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

CREATE OR REPLACE FUNCTION zzsh_order.guard_payment_distribution_basis() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE payment zzsh_order.payment_confirmation;order_row zzsh_order.rental_order;doc jsonb:=NEW.canonical_basis::jsonb;derived jsonb;payment_source jsonb;estimate_source jsonb;
BEGIN
 SELECT * INTO payment FROM zzsh_order.payment_confirmation WHERE id=NEW.payment_confirmation_id;
 SELECT * INTO order_row FROM zzsh_order.rental_order WHERE id=NEW.order_id;
 payment_source:=jsonb_build_object('id',payment.id,'order_id',payment.order_id,'source',payment.source,
  'merchant_scope_id',payment.merchant_scope_id,'provider_transaction_id',payment.provider_transaction_id,
  'merchant_order_no',payment.merchant_order_no,'amount_cents',payment.amount_cents::text,'currency',payment.currency,
  'provider_paid_at',to_char(payment.provider_paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'accepted_at',to_char(payment.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 IF payment.id IS NULL OR payment.disposition<>'APPLIED' OR payment.order_id<>NEW.order_id OR order_row.paid_confirmation_id IS DISTINCT FROM payment.id
  OR doc->>'schema' IS DISTINCT FROM 'payment-distribution-basis.v1' OR doc->>'orderId' IS DISTINCT FROM NEW.order_id
  OR doc->>'confirmationId' IS DISTINCT FROM NEW.payment_confirmation_id OR doc->>'admissionId' IS DISTINCT FROM NEW.admission_id
  OR doc->>'admissionRevision' IS DISTINCT FROM NEW.admission_revision::text OR doc->>'gameId' IS DISTINCT FROM order_row.game_id
  OR doc->>'currency' IS DISTINCT FROM order_row.currency OR doc->>'acceptedAt' IS DISTINCT FROM to_char(payment.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
 THEN RAISE EXCEPTION 'basis must belong to the same first APPLIED transaction and original order' USING ERRCODE='23514';END IF;
 IF doc->>'paymentDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(payment_source),'UTF8')),'hex')
  OR NEW.canonical_basis IS DISTINCT FROM zzsh_order.canonical_finance_json(doc)
 THEN RAISE EXCEPTION 'basis or payment source canonical digest differs' USING ERRCODE='23514';END IF;
 IF jsonb_typeof(doc->'roles') IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'two frozen roles required' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(doc->'roles')<>2 OR (SELECT count(DISTINCT r->>'role') FROM jsonb_array_elements(doc->'roles') r WHERE r->>'role' IN('RENTER_REFERRAL','OWNER_REFERRAL'))<>2
 THEN RAISE EXCEPTION 'basis rental roles are not complete' USING ERRCODE='23514';END IF;
 derived:=zzsh_order.derive_payment_referral_inputs(NEW.order_id);
 IF doc->'policyVersion' IS DISTINCT FROM derived->'policyVersion' OR doc->'policyDigest' IS DISTINCT FROM derived->'policyDigest'
  OR doc->'policyConfig' IS DISTINCT FROM derived->'policyConfig' OR doc->'accountMode' IS DISTINCT FROM derived->'accountMode'
  OR doc->'estimateBaseCents' IS DISTINCT FROM derived->'estimateBaseCents' OR doc->'roles' IS DISTINCT FROM derived->'roles'
 THEN RAISE EXCEPTION 'payment basis differs from original policy, role, relation or rounded estimate' USING ERRCODE='23514';END IF;
 IF derived->'estimateBaseCents'='null'::jsonb THEN
  IF doc->'estimateDigest' IS DISTINCT FROM 'null'::jsonb THEN RAISE EXCEPTION 'unknown estimate cannot claim a digest' USING ERRCODE='23514';END IF;
 ELSE
  estimate_source:=jsonb_build_object('definition',CASE WHEN doc#>>'{policyConfig,schema}'='distribution-policy.v3' THEN 'LEGACY_RENTAL_QUOTE_HAFF_SPREAD_V1' ELSE 'QUOTE_PLATFORM_FULL_PROFIT_ESTIMATE_V1' END,'quote',order_row.quote_snapshot-'contentHash');
  IF order_row.quote_snapshot?'contentHash' THEN estimate_source:=estimate_source||jsonb_build_object('listingHash',order_row.quote_snapshot->'contentHash');END IF;
  IF doc->>'estimateDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(estimate_source),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'estimate digest differs from immutable original quote' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.guard_rental_referral_earning() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b zzsh_order.payment_distribution_basis;p zzsh_order.settlement_posting;root zzsh_order.finance_economic_root;doc jsonb;role jsonb;seed jsonb;base numeric;expected numeric;n numeric;d numeric;available numeric;pair_total numeric;pair_role jsonb;
 posting_source jsonb;posting_hash text;key_value text;due_value timestamptz;due_text text;items jsonb:='[]'::jsonb;item jsonb;own_item jsonb;allocation_hash text;expected_seed jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'earning obligation cannot be deleted' USING ERRCODE='40001';END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.economic_root_id,NEW.economic_key,NEW.order_id,NEW.payment_confirmation_id,NEW.posting_id,NEW.beneficiary_user_id,NEW.beneficiary_role,NEW.amount_cents,NEW.due_at,NEW.basis_digest,NEW.posting_digest,NEW.canonical_seed,NEW.seed_digest,NEW.created_xid,NEW.created_at)
   IS DISTINCT FROM(OLD.id,OLD.economic_root_id,OLD.economic_key,OLD.order_id,OLD.payment_confirmation_id,OLD.posting_id,OLD.beneficiary_user_id,OLD.beneficiary_role,OLD.amount_cents,OLD.due_at,OLD.basis_digest,OLD.posting_digest,OLD.canonical_seed,OLD.seed_digest,OLD.created_xid,OLD.created_at)
   OR NEW.version<>OLD.version+1
  THEN RAISE EXCEPTION 'original earning source/amount/due immutable and next CAS required' USING ERRCODE='40001';END IF;
  IF NOT(OLD.state='PENDING' AND NEW.state IN('SETTLED','REVOKED') OR OLD.state='SETTLED' AND NEW.state IN('REVOKED','RECOVERY_REQUIRED') OR OLD.state='RECOVERY_REQUIRED' AND NEW.state='REVOKED')
  THEN RAISE EXCEPTION 'earning state transition invalid' USING ERRCODE='23514';END IF;
  IF NEW.state='SETTLED' AND clock_timestamp()<OLD.due_at THEN RAISE EXCEPTION 'earning cannot settle before original due' USING ERRCODE='23514';END IF;
  PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.beneficiary_user_id FOR UPDATE;
  IF NEW.state='RECOVERY_REQUIRED' THEN
   SELECT COALESCE(sum(credit_cents-debit_cents),0) INTO available FROM zzsh_order.settlement_ledger_entry
    WHERE counterparty_user_id=NEW.beneficiary_user_id AND account_code IN('OWNER_AVAILABLE','WALLET_AVAILABLE');
   IF available>=OLD.amount_cents OR NEW.recovery_required_cents IS DISTINCT FROM OLD.amount_cents OR NEW.funds_disposition<>'SETTLED'
   THEN RAISE EXCEPTION 'recovery requires actual shortfall and original settled funds' USING ERRCODE='23514';END IF;
  END IF;RETURN NEW;
 END IF;
 SELECT * INTO b FROM zzsh_order.payment_distribution_basis WHERE order_id=NEW.order_id AND payment_confirmation_id=NEW.payment_confirmation_id;
 SELECT * INTO p FROM zzsh_order.settlement_posting WHERE id=NEW.posting_id AND order_id=NEW.order_id AND payment_confirmation_id=NEW.payment_confirmation_id;
 SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;doc:=b.canonical_basis::jsonb;seed:=NEW.canonical_seed::jsonb;
 SELECT value INTO role FROM jsonb_array_elements(doc->'roles') WHERE value->>'role'=NEW.beneficiary_role AND value->>'beneficiaryUserId'=NEW.beneficiary_user_id;
 IF b.id IS NULL OR p.id IS NULL OR root.id IS NULL OR root.created_xid<>pg_current_xact_id() OR root.source_id<>NEW.order_id
  OR root.subject_user_id<>NEW.beneficiary_user_id OR root.beneficiary_role<>NEW.beneficiary_role OR root.source_digest<>NEW.posting_digest
  OR NEW.basis_digest<>b.basis_digest OR role IS NULL OR role->>'status'<>'ELIGIBLE'
  OR p.platform_contribution_cents<p.compensation_fee_cents
  OR p.manual_reason IS NOT NULL AND(p.approval_request_id IS NULL OR p.approval_requested_by IS NULL
   OR p.approval_approved_by IS NULL OR p.approval_requested_by=p.approval_approved_by
   OR p.approval_payload_hash IS DISTINCT FROM p.version_hash OR p.approval_expires_at IS NULL OR p.approval_expires_at<=p.posted_at)
  OR p.owner_net_cents+p.renter_refund_cents+p.platform_contribution_cents<>p.captured_cents
  OR NEW.state<>'PENDING' OR NEW.version<>1 OR NEW.funds_disposition<>'PENDING' OR NEW.recovery_required_cents IS NOT NULL
 THEN RAISE EXCEPTION 'earning must derive from original closed posting/payment role' USING ERRCODE='23514';END IF;
 n:=(role#>>'{ratio,numerator}')::numeric;d:=(role#>>'{ratio,denominator}')::numeric;base:=CASE WHEN doc#>>'{policyConfig,schema}'='distribution-policy.v3' THEN p.captured_cents-p.owner_net_cents-p.renter_refund_cents ELSE p.platform_contribution_cents-p.compensation_fee_cents END;
 IF n IS NULL OR d IS NULL OR n<0 OR d<=0 OR n>d THEN RAISE EXCEPTION 'original referral ratio invalid' USING ERRCODE='23514';END IF;
 expected:=floor(base*n/d+0.5);
 posting_source:=jsonb_build_object('id',p.id,'order_id',p.order_id,'payment_confirmation_id',p.payment_confirmation_id,
  'version_hash',p.version_hash,'early',p.early,'manual_reason',p.manual_reason,'captured_cents',p.captured_cents::text,
  'owner_net_cents',p.owner_net_cents::text,'renter_refund_cents',p.renter_refund_cents::text,
  'platform_contribution_cents',p.platform_contribution_cents::text,'compensation_fee_cents',p.compensation_fee_cents::text,
  'posted_at',to_char(p.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 posting_hash:=encode(sha256(convert_to(zzsh_order.canonical_finance_json(posting_source),'UTF8')),'hex');
 due_value:=((p.posted_at AT TIME ZONE 'UTC')+((doc#>>'{policyConfig,settlementDelayDays}')::integer*interval '1 day')) AT TIME ZONE 'UTC';
 due_text:=to_char(due_value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
 -- Validate the complete frozen pair even when only one earning is being inserted.
 -- Otherwise direct SQL could mint two individually valid shares exceeding the base.
 pair_total:=0;
 FOR pair_role IN SELECT value FROM jsonb_array_elements(doc->'roles') LOOP
  IF pair_role->>'status' LIKE 'UNKNOWN%' THEN RAISE EXCEPTION 'unknown counterpart cannot authorize partial accrual' USING ERRCODE='23514';END IF;
  IF pair_role->>'status'='ELIGIBLE' THEN
   n:=(pair_role#>>'{ratio,numerator}')::numeric;d:=(pair_role#>>'{ratio,denominator}')::numeric;
   IF n IS NULL OR d IS NULL OR n<0 OR d<=0 OR n>d THEN RAISE EXCEPTION 'counterpart ratio invalid' USING ERRCODE='23514';END IF;
   pair_total:=pair_total+floor(base*n/d+0.5);
   key_value:=zzsh_order.canonical_finance_json(jsonb_build_array('NATIVE_RENTAL_REFERRAL','NATIVE','zzsh','rental_order',NEW.order_id,pair_role->>'beneficiaryUserId',pair_role->>'role'));
   item:=jsonb_build_object('economicKey',key_value,'beneficiaryUserId',pair_role->>'beneficiaryUserId','role',pair_role->>'role',
    'amountCents',floor(base*n/d+0.5)::numeric(24,0)::text,'dueAt',due_text,'policyVersion',doc->>'policyVersion',
    'basisDigest',b.basis_digest,'postingDigest',posting_hash,'relationDigest',pair_role->>'relationDigest');
   items:=items||jsonb_build_array(item);
   IF pair_role->>'role'=NEW.beneficiary_role AND pair_role->>'beneficiaryUserId'=NEW.beneficiary_user_id THEN own_item:=item;END IF;
  END IF;
 END LOOP;
 IF pair_total>base THEN RAISE EXCEPTION 'rounded referral pair exceeds original base without subsidy' USING ERRCODE='23514';END IF;
 allocation_hash:=encode(sha256(convert_to(zzsh_order.canonical_finance_json(jsonb_build_object('orderId',NEW.order_id,
  'confirmationId',NEW.payment_confirmation_id,'basisDigest',b.basis_digest,'postingId',p.id,'postingDigest',posting_hash,
  'base',base::numeric(24,0)::text,'items',items)),'UTF8')),'hex');
 expected_seed:=jsonb_build_object('id',NEW.id,'economicKey',own_item->>'economicKey',
  'source',jsonb_build_object('kind','NATIVE_RENTAL_REFERRAL','type','NATIVE','system','zzsh','entity','rental_order','id',NEW.order_id,
   'digest',posting_hash,'eventAt',to_char(p.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
  'beneficiaryUserId',NEW.beneficiary_user_id,'role',NEW.beneficiary_role,'policyVersion',doc->>'policyVersion',
  'policyDigest',doc->>'policyDigest','baseDigest',allocation_hash,'relationDigest',role->>'relationDigest',
  'amountCents',expected::numeric(24,0)::text,'dueAt',due_text,
  'fingerprint',encode(sha256(convert_to(zzsh_order.canonical_finance_json(own_item),'UTF8')),'hex'),
  'state','PENDING','fundsDisposition','PENDING','recoveryRequiredCents',NULL,'version','1');
 IF NEW.amount_cents<>expected OR NEW.due_at IS DISTINCT FROM due_value OR own_item IS NULL
  OR NEW.posting_digest IS DISTINCT FROM posting_hash OR NEW.economic_key IS DISTINCT FROM own_item->>'economicKey'
  OR NEW.id IS DISTINCT FROM 'earning_'||encode(sha256(convert_to(NEW.economic_key,'UTF8')),'hex')
  OR seed IS DISTINCT FROM expected_seed OR NEW.canonical_seed IS DISTINCT FROM zzsh_order.canonical_finance_json(expected_seed)
 THEN RAISE EXCEPTION 'earning amount/due/seed differs from original frozen derivation' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;

-- Presence-only readiness witness. Runtime policy submission uses to_regprocedure.
CREATE FUNCTION zzsh_order.legacy_rental_referral_contract() RETURNS integer
 LANGUAGE sql IMMUTABLE AS $$ SELECT 1 $$;
