-- G2-01未编号前向候选：已存在0036/0061/0063及PAY03/G1关系才可编译。
-- 未执行；不是默认迁移，不重装G1，不改历史SQL。正式编号/journal/安装另由Admin归口。
ALTER TABLE zzsh_order.joinpay_collection_binding
 ADD COLUMN formal_admission_ref text,
 ADD COLUMN formal_admission_sha256 text,
 ADD COLUMN formal_admission_canonical text,
 ADD CONSTRAINT joinpay_formal_initial_shape CHECK (
  (formal_admission_ref IS NULL AND formal_admission_sha256 IS NULL AND formal_admission_canonical IS NULL)
  OR (formal_admission_ref IS NOT NULL AND formal_admission_sha256 IS NOT NULL AND formal_admission_canonical IS NOT NULL
   AND formal_admission_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
   AND octet_length(formal_admission_canonical)<=262144
   AND formal_admission_sha256=encode(sha256(convert_to(formal_admission_canonical,'UTF8')),'hex')));
-- 原append-only UPDATE/DELETE触发器继续存在：旧NULL不能后补，也不按OFFICIAL字符串提升。

ALTER TABLE zzsh_order.distribution_order_admission
 ADD COLUMN mode text NOT NULL DEFAULT 'LOCAL_CONTROLLED' CHECK(mode IN('LOCAL_CONTROLLED','NATIVE')),
 ADD COLUMN source_admission_ref text,
 ALTER COLUMN created_by_admin_id DROP NOT NULL,
 DROP CONSTRAINT distribution_order_admission_resource_marker_check,
 ADD CONSTRAINT distribution_admission_mode_shape CHECK (
  (mode='LOCAL_CONTROLLED' AND resource_marker='zzsh:order-reservation-test:v1' AND created_by_admin_id IS NOT NULL AND source_admission_ref IS NULL)
  OR(mode='NATIVE' AND resource_marker='NATIVE_CREATED_ORDER_V1' AND created_by_admin_id IS NULL AND source_admission_ref IS NOT NULL));

ALTER TABLE zzsh_order.distribution_policy_version DROP CONSTRAINT distribution_policy_version_scope_check,
 ADD CONSTRAINT distribution_policy_version_scope_check CHECK(scope IN('LOCAL_CONTROLLED','NATIVE'));
ALTER TABLE zzsh_order.distribution_policy_head DROP CONSTRAINT distribution_policy_head_scope_check,
 ADD CONSTRAINT distribution_policy_head_scope_check CHECK(scope IN('LOCAL_CONTROLLED','NATIVE'));

CREATE TABLE zzsh_order.joinpay_collection_evidence (
 id text PRIMARY KEY CHECK(id ~ '^jpe_[0-9a-f]{32}$'),
 request_id text NOT NULL REFERENCES zzsh_order.payment_request(id),
 operation text NOT NULL CHECK(operation IN('NOTIFY','QUERY')),
 origin_observation_id text REFERENCES zzsh_order.joinpay_collection_observation(id),
 raw_query bytea CHECK(octet_length(raw_query)<=65536),
 raw_sha256 text NOT NULL CHECK(raw_sha256 ~ '^[0-9a-f]{64}$'),
 profile_id text NOT NULL,profile_sha256 text NOT NULL,profile_canonical text NOT NULL CHECK(octet_length(profile_canonical)<=131072),
 key_version_ref text NOT NULL,
 initial_admission_ref text NOT NULL,initial_admission_sha256 text NOT NULL,
 admission_ref text NOT NULL,admission_sha256 text NOT NULL,admission_canonical text NOT NULL CHECK(octet_length(admission_canonical)<=262144),
 event text NOT NULL CHECK(event IN('E4','E5','E6','E6X','E11')),
 result text NOT NULL CHECK(result ~ '^[A-Z0-9_-]{1,64}$'),
 schema_outcome text NOT NULL CHECK(schema_outcome IN('VALID','INVALID')),
 signature_outcome text NOT NULL CHECK(signature_outcome IN('MATCH','MISMATCH','NOT_CHECKED')),
 binding_outcome text NOT NULL CHECK(binding_outcome IN('MATCH','MISMATCH','NOT_CHECKED')),
 channel_trx_no text CHECK(channel_trx_no ~ '^[A-Za-z0-9_-]{1,64}$'),
 provider_paid_at_raw text CHECK(length(provider_paid_at_raw)<=64),provider_paid_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,request_id),UNIQUE(request_id,operation,raw_sha256,profile_sha256,key_version_ref),
 CHECK(profile_sha256=encode(sha256(convert_to(profile_canonical,'UTF8')),'hex')),
 CHECK(admission_sha256=encode(sha256(convert_to(admission_canonical,'UTF8')),'hex')),
 CHECK((operation='NOTIFY' AND raw_query IS NOT NULL AND origin_observation_id IS NULL AND raw_sha256=encode(sha256(raw_query),'hex'))
    OR(operation='QUERY' AND raw_query IS NULL AND origin_observation_id IS NOT NULL)),
 CHECK(event<>'E4' OR(schema_outcome='VALID' AND signature_outcome='MATCH' AND binding_outcome='MATCH'
   AND channel_trx_no IS NOT NULL AND provider_paid_at_raw IS NOT NULL AND provider_paid_at IS NOT NULL))
);
CREATE TRIGGER joinpay_collection_evidence_append_only BEFORE UPDATE OR DELETE ON zzsh_order.joinpay_collection_evidence
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_channel_payment_append_only();

CREATE FUNCTION zzsh_order.guard_joinpay_formal_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record; doc jsonb;
BEGIN
 IF NEW.formal_admission_ref IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO r FROM zzsh_order.payment_request WHERE id=NEW.request_id;
 doc:=NEW.formal_admission_canonical::jsonb;
 IF r.id IS NULL OR r.channel<>'JOINPAY' OR r.evidence_level<>'JOINPAY_CANDIDATE' OR r.state<>'SUBMITTING' OR r.revision<>1 OR r.lease_version<>0
  OR NEW.evidence_mode<>'OFFICIAL' OR NEW.wire_merchant_no='888100000002340'
  OR doc->>'kind' IS DISTINCT FROM 'JOINPAY_FORMAL_SERVER_REVIEW' OR doc->>'reference' IS DISTINCT FROM NEW.formal_admission_ref
  OR doc->>'database' IS DISTINCT FROM current_database() OR doc->>'runtimeUser' IS DISTINCT FROM current_user
  OR doc->>'merchantIdentityId' IS DISTINCT FROM r.merchant_identity_id OR doc->>'wireMerchantNo' IS DISTINCT FROM NEW.wire_merchant_no
  OR NEW.formal_admission_canonical ~* 'SYNTHETIC|MODEL|NOT_REAL|NOT_OBTAINED|example\.invalid'
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'='SUBMIT'
   AND p->>'profileId'=r.config_profile_id AND p->>'profileSha256'=NEW.initial_profile_sha256 AND p->>'keyVersionRef'=r.key_version_ref)
  OR EXISTS(SELECT 1 FROM unnest(ARRAY['SUBMIT','QUERY','NOTIFY']) required(operation) WHERE NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'=required.operation))
 THEN RAISE EXCEPTION 'initial formal binding is not admitted' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER joinpay_formal_binding_guard BEFORE INSERT ON zzsh_order.joinpay_collection_binding
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_formal_binding();

CREATE FUNCTION zzsh_order.check_joinpay_native_admission_pair() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b record;a record;r record;order_id_value text;
BEGIN
 IF TG_TABLE_NAME='joinpay_collection_binding' THEN
  IF NEW.formal_admission_ref IS NULL THEN RETURN NULL;END IF;
  SELECT order_id INTO order_id_value FROM zzsh_order.payment_request WHERE id=NEW.request_id;
 ELSE
  IF NEW.mode<>'NATIVE' THEN RETURN NULL;END IF;order_id_value:=NEW.order_id;
 END IF;
 SELECT p.*,x.formal_admission_ref,x.formal_admission_sha256 INTO r FROM zzsh_order.payment_request p
  JOIN zzsh_order.joinpay_collection_binding x ON x.request_id=p.id WHERE p.order_id=order_id_value;
 SELECT * INTO a FROM zzsh_order.distribution_order_admission WHERE order_id=order_id_value;
 IF r.id IS NULL OR r.formal_admission_ref IS NULL OR a.id IS NULL OR a.mode<>'NATIVE'
  OR a.source_admission_ref IS DISTINCT FROM r.formal_admission_ref OR a.approval_digest IS DISTINCT FROM r.formal_admission_sha256
 THEN RAISE EXCEPTION 'formal initial binding and native admission must co-commit' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER joinpay_formal_binding_admission_pair AFTER INSERT ON zzsh_order.joinpay_collection_binding
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_native_admission_pair();
CREATE CONSTRAINT TRIGGER native_admission_formal_binding_pair AFTER INSERT ON zzsh_order.distribution_order_admission
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_native_admission_pair();

CREATE FUNCTION zzsh_order.guard_joinpay_collection_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r record;o record;doc jsonb;pdoc jsonb;offset_text text;offset_minutes integer;
BEGIN
 SELECT p.*,b.formal_admission_ref,b.formal_admission_sha256,b.wire_merchant_no INTO r FROM zzsh_order.payment_request p
  JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=p.id WHERE p.id=NEW.request_id;
 doc:=NEW.admission_canonical::jsonb;pdoc:=NEW.profile_canonical::jsonb;
 IF r.id IS NULL OR r.channel<>'JOINPAY' OR r.evidence_level<>'JOINPAY_CANDIDATE' OR r.formal_admission_ref IS NULL
  OR NEW.initial_admission_ref IS DISTINCT FROM r.formal_admission_ref OR NEW.initial_admission_sha256 IS DISTINCT FROM r.formal_admission_sha256
  OR doc->>'kind' IS DISTINCT FROM 'JOINPAY_FORMAL_SERVER_REVIEW' OR doc->>'reference' IS DISTINCT FROM NEW.admission_ref
  OR doc->>'database' IS DISTINCT FROM current_database() OR doc->>'runtimeUser' IS DISTINCT FROM current_user
  OR doc->>'merchantIdentityId' IS DISTINCT FROM r.merchant_identity_id OR doc->>'wireMerchantNo' IS DISTINCT FROM r.wire_merchant_no
  OR (NEW.admission_sha256<>r.formal_admission_sha256 AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedInitialAdmissions') h
   WHERE h->>'reference'=r.formal_admission_ref AND h->>'sha256'=r.formal_admission_sha256))
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'=NEW.operation
   AND p->>'profileId'=NEW.profile_id AND p->>'profileSha256'=NEW.profile_sha256 AND p->>'keyVersionRef'=NEW.key_version_ref)
  OR pdoc->>'profileId' IS DISTINCT FROM NEW.profile_id OR pdoc->>'merchantIdentityId' IS DISTINCT FROM r.merchant_identity_id
  OR pdoc->>'wireMerchantNo' IS DISTINCT FROM r.wire_merchant_no OR pdoc->>'purpose' IS DISTINCT FROM 'COLLECTION'
  OR pdoc->>'evidenceMode' IS DISTINCT FROM 'OFFICIAL' OR pdoc#>>ARRAY['operations',NEW.operation,'keyVersionRef'] IS DISTINCT FROM NEW.key_version_ref
  OR NEW.admission_canonical ~* 'SYNTHETIC|MODEL|NOT_REAL|NOT_OBTAINED|example\.invalid'
 THEN RAISE EXCEPTION 'collection evidence original admission/profile binding differs' USING ERRCODE='23514';END IF;
 IF NEW.operation='QUERY' THEN
  SELECT x.*,a.operation,a.profile_id,a.profile_sha256,a.key_version_ref INTO o FROM zzsh_order.joinpay_collection_observation x
   JOIN zzsh_order.joinpay_collection_attempt a ON a.id=x.attempt_id AND a.request_id=x.request_id WHERE x.id=NEW.origin_observation_id;
  IF o.id IS NULL OR o.request_id<>NEW.request_id OR o.operation<>'QUERY' OR o.event<>'E4' OR NOT o.response_complete OR o.http_status<>200
   OR o.transport_failure IS NOT NULL OR o.raw_sha256 IS DISTINCT FROM NEW.raw_sha256 OR o.profile_id IS DISTINCT FROM NEW.profile_id
   OR o.profile_sha256 IS DISTINCT FROM NEW.profile_sha256 OR o.key_version_ref IS DISTINCT FROM NEW.key_version_ref
  THEN RAISE EXCEPTION 'query evidence must reference its exact complete attempt' USING ERRCODE='23514';END IF;
 END IF;
 IF NEW.event='E4' THEN
  offset_text:=pdoc#>>ARRAY['operations',NEW.operation,'timeOffsetMinutes'];
  IF offset_text IS NULL OR offset_text!~'^-?[0-9]{1,3}$' THEN RAISE EXCEPTION 'formal provider timezone required' USING ERRCODE='23514';END IF;
  offset_minutes:=offset_text::integer;
  IF abs(offset_minutes)>840 OR NEW.provider_paid_at IS DISTINCT FROM (NEW.provider_paid_at_raw::timestamp AT TIME ZONE 'UTC')-make_interval(mins=>offset_minutes)
  THEN RAISE EXCEPTION 'formal provider time differs from explicit offset' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER joinpay_collection_evidence_guard BEFORE INSERT ON zzsh_order.joinpay_collection_evidence
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_collection_evidence();

ALTER TABLE zzsh_order.payment_channel_transaction DROP CONSTRAINT payment_channel_transaction_evidence_level_check,
 ADD CONSTRAINT payment_channel_transaction_evidence_level_check CHECK(evidence_level IN('SYNTHETIC_PROTOCOL','CONTROLLED_TEST','JOINPAY_VERIFIED'));
-- 原列级REFERENCES的精确默认名称；CONTROLLED默认仍IMMEDIATE，正式事务只延迟这一条。
ALTER TABLE zzsh_order.payment_channel_transaction
 ALTER CONSTRAINT payment_channel_transaction_native_order_id_fkey DEFERRABLE INITIALLY IMMEDIATE;
CREATE FUNCTION zzsh_order.guard_joinpay_formal_anchor() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.evidence_level='JOINPAY_VERIFIED' AND (NEW.channel<>'JOINPAY' OR NEW.confirmation_id IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM zzsh_order.payment_request r JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=r.id
   JOIN zzsh_order.joinpay_collection_evidence e ON e.request_id=r.id
  WHERE r.id=NEW.request_id AND r.order_id=NEW.native_order_id AND r.merchant_identity_id=NEW.merchant_identity_id
   AND b.formal_admission_ref IS NOT NULL AND e.event='E4' AND e.channel_trx_no=NEW.channel_trx_no))
 THEN RAISE EXCEPTION 'formal anchor requires admitted original successful evidence' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER joinpay_formal_anchor_guard BEFORE INSERT ON zzsh_order.payment_channel_transaction
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_formal_anchor();

ALTER TABLE zzsh_order.payment_confirmation DROP CONSTRAINT payment_confirmation_source_check,
 ADD CONSTRAINT payment_confirmation_source_check CHECK(source IN('CONTROLLED','JOINPAY')),
 ADD COLUMN joinpay_request_id text,ADD COLUMN joinpay_evidence_id text,ADD COLUMN joinpay_anchor_id text REFERENCES zzsh_order.payment_channel_transaction(id),
 ADD CONSTRAINT payment_confirmation_joinpay_request_fk FOREIGN KEY(joinpay_request_id,order_id) REFERENCES zzsh_order.payment_request(id,order_id),
 ADD CONSTRAINT payment_confirmation_joinpay_evidence_fk FOREIGN KEY(joinpay_evidence_id,joinpay_request_id) REFERENCES zzsh_order.joinpay_collection_evidence(id,request_id),
 ADD CONSTRAINT payment_confirmation_source_shape CHECK(
  (source='CONTROLLED' AND joinpay_request_id IS NULL AND joinpay_evidence_id IS NULL AND joinpay_anchor_id IS NULL)
  OR(source='JOINPAY' AND currency='CNY' AND joinpay_request_id IS NOT NULL AND joinpay_evidence_id IS NOT NULL AND joinpay_anchor_id IS NOT NULL));

CREATE FUNCTION zzsh_order.guard_joinpay_formal_confirmation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source='JOINPAY' AND NOT EXISTS(
  SELECT 1 FROM zzsh_order.payment_request r JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=r.id
   JOIN zzsh_order.joinpay_collection_evidence e ON e.request_id=r.id AND e.id=NEW.joinpay_evidence_id
   JOIN zzsh_order.payment_channel_transaction a ON a.id=NEW.joinpay_anchor_id
  WHERE r.id=NEW.joinpay_request_id AND r.order_id=NEW.order_id AND r.channel='JOINPAY' AND b.formal_admission_ref IS NOT NULL
   AND r.channel_order_no=NEW.merchant_order_no AND r.amount_cents=NEW.amount_cents AND r.currency=NEW.currency
   AND r.merchant_identity_id=NEW.merchant_scope_id AND e.event='E4' AND e.channel_trx_no=NEW.provider_transaction_id
   AND e.provider_paid_at=NEW.provider_paid_at AND a.channel='JOINPAY' AND a.evidence_level='JOINPAY_VERIFIED'
   AND a.native_order_id=r.order_id AND a.request_id=r.id AND a.merchant_identity_id=NEW.merchant_scope_id AND a.channel_trx_no=NEW.provider_transaction_id)
 THEN RAISE EXCEPTION 'formal confirmation original evidence/funds mapping differs' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER joinpay_formal_confirmation_guard BEFORE INSERT ON zzsh_order.payment_confirmation
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_formal_confirmation();

ALTER TABLE zzsh_order.joinpay_collection_observation DROP CONSTRAINT joinpay_collection_observation_state_after_check,
 ADD CONSTRAINT joinpay_collection_observation_state_after_check CHECK(state_after IN('SUBMITTING','UNKNOWN','ACTION_READY','PROCESSING_UNCONFIRMED',
  'REJECTED_BY_CHANNEL','CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE','ACCEPTED','REVIEW_REQUIRED'));

CREATE FUNCTION zzsh_order.joinpay_formal_request_effect(request_id_value text,state_value text) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM zzsh_order.payment_request r JOIN zzsh_order.joinpay_collection_binding b ON b.request_id=r.id
  JOIN zzsh_order.joinpay_collection_evidence e ON e.request_id=r.id AND e.event='E4'
  WHERE r.id=request_id_value AND b.formal_admission_ref IS NOT NULL AND (
   state_value='ACCEPTED' AND EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.joinpay_request_id=r.id AND p.source='JOINPAY' AND p.disposition='APPLIED')
   OR state_value='REVIEW_REQUIRED' AND (EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.joinpay_request_id=r.id AND p.source='JOINPAY' AND p.disposition='REVIEW_REQUIRED')
    OR EXISTS(SELECT 1 FROM zzsh_order.payment_channel_transaction a WHERE a.channel='JOINPAY' AND a.merchant_identity_id=r.merchant_identity_id
      AND a.channel_trx_no=e.channel_trx_no AND (a.native_order_id<>r.order_id OR a.request_id IS DISTINCT FROM r.id)))))
$$;
REVOKE ALL ON FUNCTION zzsh_order.joinpay_formal_request_effect(text,text) FROM PUBLIC;

-- 其余CREATE OR REPLACE与精确ACL由同目录生成器固定复制原函数并增加明确分支；见文件后半段。
-- GENERATED_FORWARD_FUNCTIONS
CREATE OR REPLACE FUNCTION zzsh_order.guard_distribution_order_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_row zzsh_order.rental_order;
BEGIN
 IF NEW.mode='NATIVE' THEN
  IF NEW.resource_name<>current_database() OR NEW.resource_oid<>(SELECT oid FROM pg_database WHERE datname=current_database())
   OR NEW.resource_marker<>'NATIVE_CREATED_ORDER_V1' OR NEW.created_by_admin_id IS NOT NULL
   OR NEW.source_admission_ref IS NULL OR NEW.revision<>1 OR NOT NEW.active OR NEW.admitted_at>clock_timestamp() OR NEW.expires_at<>'infinity'::timestamptz
   OR NOT EXISTS(SELECT 1 FROM pg_roles r JOIN pg_database d ON d.datname=current_database() WHERE r.rolname=current_user
    AND NOT r.rolsuper AND NOT r.rolbypassrls AND r.oid<>d.datdba AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid))
  THEN RAISE EXCEPTION 'native admission requires exact application runtime source' USING ERRCODE='23514';END IF;
  SELECT * INTO order_row FROM zzsh_order.rental_order WHERE id=NEW.order_id;
  IF order_row.id IS NULL OR order_row.status<>'PENDING_PAYMENT' OR order_row.paid_confirmation_id IS NOT NULL OR NOT EXISTS(
   SELECT 1 FROM zzsh_order.payment_request p WHERE p.order_id=NEW.order_id AND p.channel='JOINPAY' AND p.evidence_level='JOINPAY_CANDIDATE'
    AND p.state='SUBMITTING' AND p.revision=1 AND p.lease_version=0)
   OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.id=NEW.native_creation_audit_id AND a.action='order.reservation.created'
    AND a.object_type='rental_order' AND a.object_id=NEW.order_id AND a.actor_type='user' AND a.actor_id=order_row.renter_user_id AND a.outcome='SUCCESS')
  THEN RAISE EXCEPTION 'native admission requires original unpaid request creation' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 IF current_database()!~'^zzsh_test_order_[a-z][a-z0-9_]{0,20}$' OR current_user<>'zzsh_order_'||substr(current_database(),17)||'_m'
  OR NEW.resource_name<>current_database() OR NEW.resource_oid<>(SELECT oid FROM pg_database WHERE datname=current_database())
  OR NEW.resource_marker IS DISTINCT FROM (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database())
 THEN RAISE EXCEPTION 'order admission requires exact maintained order resource' USING ERRCODE='23514';END IF;
 SELECT * INTO order_row FROM zzsh_order.rental_order WHERE id=NEW.order_id;
 IF order_row.id IS NULL OR order_row.status<>'PENDING_PAYMENT' OR order_row.paid_confirmation_id IS NOT NULL OR NOT EXISTS(
  SELECT 1 FROM zzsh_iam.audit_event WHERE id=NEW.native_creation_audit_id AND action='order.reservation.created'
   AND object_type='rental_order' AND object_id=NEW.order_id AND outcome='SUCCESS')
 THEN RAISE EXCEPTION 'new native order origin/payment state is not proved' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.derive_payment_referral_inputs(order_id_value text) RETURNS jsonb LANGUAGE plpgsql AS $$
DECLARE o zzsh_order.rental_order;v zzsh_order.distribution_policy_version;cfg jsonb;mode text;base numeric;minimum numeric;
 role_name text;party text;own zzsh_order.distribution_participant;relation zzsh_order.invitation_relation;
 parent_row record;graph_closed boolean;level jsonb;status text;pct text;n numeric;d numeric;scale integer;
 item jsonb;items jsonb[]:=ARRAY[]::jsonb[];raw_amounts numeric[]:=ARRAY[0::numeric,0::numeric];i integer;
 uncertain boolean;total numeric;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0));
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=order_id_value;
 IF o.id IS NULL OR o.currency<>'CNY' THEN RAISE EXCEPTION 'original native CNY order required' USING ERRCODE='23514';END IF;
 SELECT p.* INTO v FROM zzsh_order.distribution_policy_head h JOIN zzsh_order.distribution_policy_version p
  ON p.id=h.current_version_id AND p.scope=h.scope AND p.revision=h.revision WHERE h.scope=CASE WHEN EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.id=o.paid_confirmation_id AND p.order_id=o.id AND p.source='JOINPAY') THEN 'NATIVE' ELSE 'LOCAL_CONTROLLED' END FOR SHARE OF h;
 cfg:=v.canonical_config::jsonb;
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
   'levelCode',parent_row.level_code,'percent',pct,'ratio',CASE WHEN pct IS NULL THEN NULL ELSE jsonb_build_object('numerator',n::numeric(24,0)::text,'denominator',d::numeric(24,0)::text) END,'estimatedCents',NULL);
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

CREATE OR REPLACE FUNCTION zzsh_order.check_applied_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.disposition = 'APPLIED' AND NOT EXISTS (
    SELECT 1 FROM zzsh_order.rental_order o
      JOIN zzsh_order.im_order_group g ON g.order_id=o.id AND g.payment_confirmation_id=NEW.id
     WHERE o.id=NEW.order_id AND o.paid_confirmation_id=NEW.id AND o.status='PAID'
       AND ((NEW.source='CONTROLLED' AND o.display_no=NEW.merchant_order_no)
        OR(NEW.source='JOINPAY' AND EXISTS(SELECT 1 FROM zzsh_order.payment_request r WHERE r.id=NEW.joinpay_request_id AND r.order_id=o.id AND r.channel_order_no=NEW.merchant_order_no))) AND o.currency=NEW.currency
       AND o.rental_amount_cents+o.deposit_amount_cents=NEW.amount_cents
       AND o.paid_at=NEW.accepted_at AND o.paid_at < o.hold_until
  ) THEN
    RAISE EXCEPTION 'applied payment must match paid order and waiting intent' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.guard_joinpay_collection_request() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state IS DISTINCT FROM OLD.state AND NEW.state IN('ACCEPTED','REVIEW_REQUIRED')
  AND EXISTS(SELECT 1 FROM zzsh_order.joinpay_collection_evidence e WHERE e.id=current_setting('zzsh.joinpay_evidence',true) AND e.request_id=NEW.id AND e.event='E4')
  AND zzsh_order.joinpay_formal_request_effect(NEW.id,NEW.state) THEN
  IF NEW.lease_version<>OLD.lease_version OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
   THEN RAISE EXCEPTION 'formal acceptance cannot change worker lease' USING ERRCODE='40001';END IF;
  RETURN NEW;
 END IF;
 IF NEW.state='ACCEPTED' THEN RAISE EXCEPTION 'collection evidence cannot accept payment' USING ERRCODE='23514'; END IF;
 IF NEW.lease_version=OLD.lease_version+1 THEN
  IF NEW.state<>OLD.state OR (OLD.lease_until IS NOT NULL AND OLD.lease_until>clock_timestamp())
   OR OLD.state NOT IN ('SUBMITTING','UNKNOWN','ACTION_READY','PROCESSING_UNCONFIRMED')
   OR NEW.lease_owner IS NULL OR NEW.lease_until IS NULL OR NEW.lease_until<=clock_timestamp()
   OR NEW.lease_until>clock_timestamp()+interval '3600 seconds' THEN
   RAISE EXCEPTION 'collection lease is not claimable' USING ERRCODE='40001';
  END IF;
 ELSIF NEW.lease_version=OLD.lease_version THEN
  IF NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
   OR OLD.lease_until IS NULL THEN
   RAISE EXCEPTION 'collection result lease binding changed' USING ERRCODE='40001';
  END IF;
  IF OLD.lease_until<=clock_timestamp() THEN
   RAISE EXCEPTION 'collection result lease expired' USING ERRCODE='40001',CONSTRAINT='joinpay_collection_lease_current';
  END IF;
 ELSE RAISE EXCEPTION 'collection lease must advance once' USING ERRCODE='40001'; END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.check_joinpay_collection_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.evidence_level='JOINPAY_CANDIDATE' AND NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_collection_binding WHERE request_id=NEW.id) THEN
  RAISE EXCEPTION 'collection request requires immutable wire evidence' USING ERRCODE='23514';
 END IF;
 IF TG_OP='UPDATE' AND NEW.evidence_level='JOINPAY_CANDIDATE' THEN
  IF NEW.lease_version>OLD.lease_version AND NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_collection_attempt WHERE request_id=NEW.id AND lease_version=NEW.lease_version AND lease_owner=NEW.lease_owner) THEN
   RAISE EXCEPTION 'collection lease requires a committed attempt' USING ERRCODE='23514';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state AND NOT zzsh_order.joinpay_formal_request_effect(NEW.id,NEW.state) AND NOT EXISTS(
   SELECT 1 FROM zzsh_order.joinpay_collection_observation o JOIN zzsh_order.joinpay_collection_attempt a ON a.id=o.attempt_id
   WHERE o.request_id=NEW.id AND a.lease_version=NEW.lease_version AND o.state_before=OLD.state AND o.state_after=NEW.state AND o.event<>'E9') THEN
   RAISE EXCEPTION 'collection transition requires its raw observation' USING ERRCODE='23514';
  END IF;
 END IF;
 RETURN NULL;
END $$;


CREATE FUNCTION zzsh_order.check_joinpay_formal_confirmation_closure() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source='JOINPAY' AND NEW.disposition='APPLIED' AND NOT EXISTS(
  SELECT 1 FROM zzsh_order.payment_request r JOIN zzsh_order.payment_distribution_basis b ON b.order_id=r.order_id AND b.payment_confirmation_id=NEW.id
   JOIN zzsh_order.distribution_order_admission a ON a.id=b.admission_id AND a.order_id=b.order_id AND a.revision=b.admission_revision
  WHERE r.id=NEW.joinpay_request_id AND r.state='ACCEPTED' AND a.mode='NATIVE' AND a.active)
 THEN RAISE EXCEPTION 'formal APPLIED requires same-transaction accepted request and complete native basis' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER joinpay_formal_confirmation_closure AFTER INSERT ON zzsh_order.payment_confirmation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_joinpay_formal_confirmation_closure();

-- 正式迁移的共享宽GRANT之后也必须复用这一窄ACL；不授PUBLIC/owner/成员旁路。
DO $$
DECLARE runtime_role text:=current_setting('zzsh.collection_runtime_role',false); table_name text; columns text;
BEGIN
 IF runtime_role !~ '^[a-z][a-z0-9_]{0,62}$' THEN RAISE EXCEPTION 'explicit collection runtime role required' USING ERRCODE='22023';END IF;
 FOREACH table_name IN ARRAY ARRAY['joinpay_collection_binding','joinpay_collection_evidence','distribution_order_admission'] LOOP
  SELECT string_agg(quote_ident(attname),',' ORDER BY attnum) INTO columns FROM pg_attribute WHERE attrelid=('zzsh_order.'||table_name)::regclass AND attnum>0 AND NOT attisdropped;
  EXECUTE format('REVOKE ALL ON TABLE zzsh_order.%I FROM %I',table_name,runtime_role);
  EXECUTE format('REVOKE ALL (%s) ON TABLE zzsh_order.%I FROM %I',columns,table_name,runtime_role);
  EXECUTE format('REVOKE ALL ON TABLE zzsh_order.%I FROM PUBLIC',table_name);
  EXECUTE format('REVOKE ALL (%s) ON TABLE zzsh_order.%I FROM PUBLIC',columns,table_name);
  EXECUTE format('GRANT SELECT ON TABLE zzsh_order.%I TO %I',table_name,runtime_role);
 END LOOP;
 EXECUTE format('GRANT INSERT(request_id,wire_merchant_no,trade_merchant_no,product_name,notify_url,initial_profile_sha256,evidence_mode,formal_admission_ref,formal_admission_sha256,formal_admission_canonical) ON zzsh_order.joinpay_collection_binding TO %I',runtime_role);
 EXECUTE format('GRANT INSERT(id,request_id,operation,origin_observation_id,raw_query,raw_sha256,profile_id,profile_sha256,profile_canonical,key_version_ref,initial_admission_ref,initial_admission_sha256,admission_ref,admission_sha256,admission_canonical,event,result,schema_outcome,signature_outcome,binding_outcome,channel_trx_no,provider_paid_at_raw,provider_paid_at) ON zzsh_order.joinpay_collection_evidence TO %I',runtime_role);
 EXECUTE format('GRANT INSERT(id,order_id,mode,resource_oid,resource_name,resource_marker,approval_digest,source_admission_ref,native_creation_audit_id,revision,active,admitted_at,expires_at,created_by_admin_id,reason) ON zzsh_order.distribution_order_admission TO %I',runtime_role);
 EXECUTE format('GRANT EXECUTE ON FUNCTION zzsh_order.joinpay_formal_request_effect(text,text) TO %I',runtime_role);
END $$;

