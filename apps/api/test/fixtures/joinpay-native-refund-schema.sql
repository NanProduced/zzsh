-- 未编号前向候选；先安装原channel-refund-schema.sql及既有财务链，不修改历史迁移。
-- 真实PG、权限和并发仍需独立窗口；本文件没有执行授权。
ALTER TABLE zzsh_order.channel_refund_intent
 DROP CONSTRAINT channel_refund_intent_payment_source_check,
 DROP CONSTRAINT channel_refund_intent_state_check,
 DROP CONSTRAINT channel_refund_intent_check1,
 ADD COLUMN evidence_level text NOT NULL DEFAULT 'CONTROLLED_TEST',
 ADD COLUMN initial_admission_ref text,
 ADD COLUMN initial_admission_sha256 text,
 ADD COLUMN initial_admission_canonical text,
 ADD COLUMN wire_merchant_no text,
 ADD COLUMN initial_profile_id text,
 ADD COLUMN initial_profile_sha256 text,
 ADD COLUMN initial_key_version_ref text,
 ADD COLUMN notify_url text,
 ADD COLUMN funds_account text,
 ADD COLUMN refund_reason text,
 ADD COLUMN budget_disposition text NOT NULL DEFAULT 'ALLOCATED',
 ADD COLUMN requires_review boolean NOT NULL DEFAULT false,
 ADD COLUMN terminal_evidence_id text,
 ADD COLUMN terminal_root_id text,
 ADD COLUMN terminal_event_id text,
 ADD COLUMN provider_refund_trx_no text,
 ADD COLUMN completed_at timestamptz,
 ADD CONSTRAINT channel_refund_source_shape CHECK((
  (payment_source='CONTROLLED' AND evidence_level='CONTROLLED_TEST' AND state IN('READY','SUBMITTING','UNKNOWN')
   AND budget_disposition='ALLOCATED' AND NOT requires_review AND num_nonnulls(initial_admission_ref,initial_admission_sha256,
    initial_admission_canonical,wire_merchant_no,initial_profile_id,initial_profile_sha256,initial_key_version_ref,notify_url,
    funds_account,refund_reason,terminal_evidence_id,terminal_root_id,terminal_event_id,provider_refund_trx_no,completed_at)=0)
  OR(payment_source='JOINPAY' AND evidence_level='JOINPAY_FORMAL' AND initial_admission_ref IS NOT NULL
   AND length(initial_admission_ref) BETWEEN 1 AND 128 AND initial_admission_sha256~'^[a-f0-9]{64}$'
   AND octet_length(initial_admission_canonical) BETWEEN 2 AND 131072
   AND initial_admission_sha256=encode(sha256(convert_to(initial_admission_canonical,'UTF8')),'hex')
   AND wire_merchant_no~'^[0-9]{1,15}$' AND wire_merchant_no<>'888100000002340'
   AND length(initial_profile_id) BETWEEN 1 AND 128 AND initial_profile_sha256~'^[a-f0-9]{64}$'
   AND length(initial_key_version_ref) BETWEEN 1 AND 128 AND octet_length(notify_url) BETWEEN 9 AND 300
   AND notify_url LIKE 'https://%' AND (funds_account IS NULL OR funds_account IN('SETTLED','ADVANCE'))
   AND (refund_reason IS NULL OR octet_length(refund_reason)<=400)
   AND state IN('READY','SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED','SUCCEEDED','FAILED'))
 ) IS TRUE),
 ADD CONSTRAINT channel_refund_budget_shape CHECK((
  (state NOT IN('SUCCEEDED','FAILED') AND budget_disposition='ALLOCATED'
   AND num_nonnulls(terminal_evidence_id,terminal_root_id,terminal_event_id,provider_refund_trx_no,completed_at)=0)
  OR(state='SUCCEEDED' AND budget_disposition='CONSUMED' AND terminal_evidence_id IS NOT NULL
   AND terminal_root_id IS NOT NULL AND terminal_event_id IS NOT NULL AND provider_refund_trx_no IS NOT NULL AND completed_at IS NOT NULL)
  OR(state='FAILED' AND budget_disposition='RELEASED' AND terminal_evidence_id IS NOT NULL
   AND terminal_root_id IS NULL AND terminal_event_id IS NULL)
 ) IS TRUE),
 ADD CONSTRAINT channel_refund_claim_shape CHECK((state='READY' AND lease_version=0 AND lease_owner IS NULL)
  OR(state<>'READY' AND lease_version>0 AND lease_owner IS NOT NULL));
CREATE UNIQUE INDEX joinpay_refund_transaction_once ON zzsh_order.channel_refund_intent
 (payment_source,merchant_identity_id,provider_refund_trx_no)
 WHERE payment_source='JOINPAY' AND provider_refund_trx_no IS NOT NULL;

CREATE TABLE zzsh_order.joinpay_refund_attempt (
 id text PRIMARY KEY,intent_id text NOT NULL REFERENCES zzsh_order.channel_refund_intent(id),
 operation text NOT NULL CHECK(operation IN('SUBMIT','QUERY')),lease_version bigint NOT NULL CHECK(lease_version>0),
 lease_owner text NOT NULL CHECK(lease_owner~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
 profile_id text NOT NULL CHECK(length(profile_id) BETWEEN 1 AND 128),
 profile_canonical text NOT NULL CHECK(octet_length(profile_canonical) BETWEEN 2 AND 131072),
 profile_sha256 text NOT NULL CHECK(profile_sha256=encode(sha256(convert_to(profile_canonical,'UTF8')),'hex')),
 key_version_ref text NOT NULL CHECK(length(key_version_ref) BETWEEN 1 AND 128),
 admission_sha256 text NOT NULL CHECK(admission_sha256~'^[a-f0-9]{64}$'),
 request_body bytea NOT NULL CHECK(octet_length(request_body) BETWEEN 1 AND 16384),
 request_sha256 text NOT NULL CHECK(request_sha256=encode(sha256(request_body),'hex')),
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(intent_id,lease_version),UNIQUE(id,intent_id)
);
CREATE UNIQUE INDEX joinpay_refund_submit_once ON zzsh_order.joinpay_refund_attempt(intent_id) WHERE operation='SUBMIT';

CREATE TABLE zzsh_order.joinpay_refund_observation (
 id text PRIMARY KEY,intent_id text NOT NULL REFERENCES zzsh_order.channel_refund_intent(id),
 attempt_id text,operation text NOT NULL CHECK(operation IN('SUBMIT','QUERY','NOTIFY')),
 lease_version bigint,lease_owner text,
 profile_id text NOT NULL CHECK(length(profile_id) BETWEEN 1 AND 128),
 profile_canonical text NOT NULL CHECK(octet_length(profile_canonical) BETWEEN 2 AND 131072),
 profile_sha256 text NOT NULL CHECK(profile_sha256=encode(sha256(convert_to(profile_canonical,'UTF8')),'hex')),
 key_version_ref text NOT NULL CHECK(length(key_version_ref) BETWEEN 1 AND 128),
 raw_body bytea CHECK(octet_length(raw_body)<=65536),raw_sha256 text,
 response_complete boolean NOT NULL,http_status integer CHECK(http_status BETWEEN 100 AND 599),
 received_bytes integer NOT NULL CHECK(received_bytes>=0),transport_failure text,
 event text NOT NULL CHECK(event IN('UNKNOWN','PROCESSING','PENDING_TERMINAL','REVIEW','STALE','TERMINAL')),
 schema_status text NOT NULL,signature_status text NOT NULL,binding_status text NOT NULL,
 evidence_level text NOT NULL CHECK(evidence_level IN('PROVIDER_RESPONSE','SYNTHETIC_PROTOCOL')),
 state_before text NOT NULL,state_after text NOT NULL,
 request_id text NOT NULL CHECK(request_id~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$'),
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(attempt_id,intent_id) REFERENCES zzsh_order.joinpay_refund_attempt(id,intent_id),UNIQUE(id,intent_id),
 CHECK((raw_body IS NOT NULL AND raw_sha256 IS NOT NULL AND raw_sha256=encode(sha256(raw_body),'hex'))
  OR(raw_body IS NULL AND raw_sha256 IS NULL AND NOT response_complete)),
 CHECK(received_bytes>=COALESCE(octet_length(raw_body),0)),
 CHECK(NOT response_complete OR(raw_body IS NOT NULL AND received_bytes=octet_length(raw_body)
  AND((operation='NOTIFY' AND http_status IS NULL) OR(operation<>'NOTIFY' AND http_status IS NOT NULL)))),
 CHECK((operation='NOTIFY' AND attempt_id IS NULL AND lease_version IS NULL AND lease_owner IS NULL)
  OR(operation IN('SUBMIT','QUERY') AND attempt_id IS NOT NULL AND lease_version IS NOT NULL AND lease_version>0 AND lease_owner IS NOT NULL)),
 CHECK(state_before IN('READY','SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED','SUCCEEDED','FAILED')
  AND state_after IN('READY','SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED','SUCCEEDED','FAILED')),
 CHECK(event<>'STALE' OR state_before=state_after)
);

CREATE TABLE zzsh_order.joinpay_refund_evidence (
 id text PRIMARY KEY,intent_id text NOT NULL UNIQUE REFERENCES zzsh_order.channel_refund_intent(id),
 observation_id text NOT NULL UNIQUE,
 operation text NOT NULL CHECK(operation IN('QUERY','NOTIFY')),
 terminal text NOT NULL CHECK(terminal IN('SUCCEEDED','FAILED_NO_EXECUTION')),
 refund_transaction_no text CHECK(length(refund_transaction_no) BETWEEN 1 AND 128),
 completed_at_raw text,completed_at timestamptz,
 facts_canonical text NOT NULL CHECK(octet_length(facts_canonical) BETWEEN 2 AND 16384),
 facts_digest text NOT NULL CHECK(facts_digest=encode(sha256(convert_to(facts_canonical,'UTF8')),'hex')),
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(id,intent_id),FOREIGN KEY(observation_id,intent_id) REFERENCES zzsh_order.joinpay_refund_observation(id,intent_id),
 CHECK(terminal<>'SUCCEEDED' OR(refund_transaction_no IS NOT NULL AND completed_at_raw IS NOT NULL AND completed_at IS NOT NULL))
);
ALTER TABLE zzsh_order.channel_refund_intent
 ADD CONSTRAINT joinpay_refund_terminal_evidence_fk FOREIGN KEY(terminal_evidence_id,id)
  REFERENCES zzsh_order.joinpay_refund_evidence(id,intent_id) DEFERRABLE INITIALLY DEFERRED,
 ADD CONSTRAINT joinpay_refund_terminal_root_fk FOREIGN KEY(terminal_root_id)
  REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED,
 ADD CONSTRAINT joinpay_refund_terminal_event_fk FOREIGN KEY(terminal_event_id)
  REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED;

-- 原CONTROLLED守卫保留原函数正文，通过包装器限定仍只进入旧三态分支。
ALTER FUNCTION zzsh_order.guard_channel_refund_intent() RENAME TO guard_controlled_channel_refund_intent_v1;
DROP TRIGGER channel_refund_intent_guard ON zzsh_order.channel_refund_intent;
CREATE FUNCTION zzsh_order.guard_joinpay_refund_intent() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE b record;paid_allocated numeric;responsibility_allocated numeric;proof zzsh_order.joinpay_refund_evidence;origin zzsh_order.joinpay_refund_observation;doc jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'refund requires READ COMMITTED' USING ERRCODE='25001';END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'refund allocation immutable' USING ERRCODE='40001';END IF;
 IF NEW.payment_source<>'JOINPAY' OR NEW.evidence_level<>'JOINPAY_FORMAL' THEN RAISE EXCEPTION 'formal refund source mismatch' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['state','revision','lease_version','lease_owner','lease_until','updated_at','budget_disposition','requires_review',
    'terminal_evidence_id','terminal_root_id','terminal_event_id','provider_refund_trx_no','completed_at'])
   IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','revision','lease_version','lease_owner','lease_until','updated_at','budget_disposition','requires_review',
    'terminal_evidence_id','terminal_root_id','terminal_event_id','provider_refund_trx_no','completed_at'])
   OR NEW.revision<>OLD.revision+1 OR(OLD.requires_review AND NOT NEW.requires_review)
  THEN RAISE EXCEPTION 'formal refund original binding immutable' USING ERRCODE='40001';END IF;
  IF OLD.state IN('SUCCEEDED','FAILED') THEN
   IF (to_jsonb(NEW)-ARRAY['revision','requires_review','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['revision','requires_review','updated_at'])
    OR OLD.requires_review OR NOT NEW.requires_review
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_observation x WHERE x.intent_id=OLD.id AND x.event='REVIEW'
      AND x.created_xid=pg_current_xact_id() AND x.state_before=OLD.state AND x.state_after=OLD.state)
   THEN RAISE EXCEPTION 'formal refund terminal cannot change' USING ERRCODE='40001';END IF;
  ELSIF NOT OLD.requires_review AND NEW.requires_review THEN
   IF (to_jsonb(NEW)-ARRAY['revision','requires_review','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['revision','requires_review','updated_at'])
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_observation x WHERE x.intent_id=OLD.id AND x.event='REVIEW'
      AND x.created_xid=pg_current_xact_id() AND x.state_before=OLD.state AND x.state_after=OLD.state)
   THEN RAISE EXCEPTION 'refund conflict requires its original review observation' USING ERRCODE='23514';END IF;
  ELSIF NEW.state IN('SUCCEEDED','FAILED') THEN
   SELECT * INTO proof FROM zzsh_order.joinpay_refund_evidence WHERE id=NEW.terminal_evidence_id AND intent_id=OLD.id;
   SELECT * INTO origin FROM zzsh_order.joinpay_refund_observation WHERE id=proof.observation_id;
   IF origin.operation='QUERY' AND(OLD.lease_version IS DISTINCT FROM origin.lease_version OR OLD.lease_owner IS DISTINCT FROM origin.lease_owner
    OR OLD.lease_until IS NULL OR OLD.lease_until<=clock_timestamp())
   THEN RAISE EXCEPTION 'refund terminal lease expired' USING ERRCODE='23514',CONSTRAINT='joinpay_refund_live_lease';END IF;
   IF OLD.state NOT IN('SUBMITTING','UNKNOWN','PROCESSING') OR OLD.requires_review OR NEW.requires_review
    OR proof.id IS NULL OR proof.created_xid<>pg_current_xact_id()
    OR NEW.state IS DISTINCT FROM CASE proof.terminal WHEN 'SUCCEEDED' THEN 'SUCCEEDED' ELSE 'FAILED' END
    OR NEW.budget_disposition IS DISTINCT FROM CASE proof.terminal WHEN 'SUCCEEDED' THEN 'CONSUMED' ELSE 'RELEASED' END
    OR NEW.provider_refund_trx_no IS DISTINCT FROM proof.refund_transaction_no OR NEW.completed_at IS DISTINCT FROM proof.completed_at
    OR NEW.lease_version<>OLD.lease_version OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
   THEN RAISE EXCEPTION 'formal refund terminal lacks same transaction proof' USING ERRCODE='23514';END IF;
  ELSIF NEW.lease_version=OLD.lease_version+1 THEN
   IF (OLD.state='READY' AND OLD.requires_review) OR NEW.requires_review IS DISTINCT FROM OLD.requires_review OR OLD.due_at>clock_timestamp()
    OR(OLD.lease_until IS NOT NULL AND OLD.lease_until>clock_timestamp()) OR NEW.lease_owner IS NULL OR NEW.lease_until<=clock_timestamp()
    OR NEW.lease_until>clock_timestamp()+interval '3600 seconds'
    OR NEW.state IS DISTINCT FROM CASE WHEN OLD.state='READY' THEN 'SUBMITTING' ELSE 'UNKNOWN' END
    OR NEW.budget_disposition<>'ALLOCATED'
   THEN RAISE EXCEPTION 'formal refund lease not claimable' USING ERRCODE='40001';END IF;
   IF OLD.state='READY' AND EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent x WHERE x.payment_source='JOINPAY'
    AND x.merchant_identity_id=OLD.merchant_identity_id AND x.original_payment_trx_no=OLD.original_payment_trx_no AND x.requires_review)
   THEN RAISE EXCEPTION 'original payment refund submit requires review' USING ERRCODE='23514';END IF;
  ELSE
   IF NEW.lease_version<>OLD.lease_version OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
    OR NEW.budget_disposition<>'ALLOCATED' OR NEW.state NOT IN('UNKNOWN','PROCESSING','REVIEW_REQUIRED')
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_observation x WHERE x.intent_id=OLD.id AND x.created_xid=pg_current_xact_id()
      AND x.state_before=OLD.state AND x.state_after=NEW.state AND x.event IN('UNKNOWN','PROCESSING','REVIEW')
      AND(x.operation='NOTIFY' OR(x.lease_version=OLD.lease_version AND x.lease_owner=OLD.lease_owner AND OLD.lease_until>clock_timestamp())))
   THEN RAISE EXCEPTION 'formal refund update lacks live evidence' USING ERRCODE='40001';END IF;
  END IF;
  NEW.updated_at:=clock_timestamp();RETURN NEW;
 END IF;
 doc:=NEW.initial_admission_canonical::jsonb;
 IF (doc->>'kind' IS DISTINCT FROM 'FORMAL_NATIVE_REFUND_SERVER_REVIEW' OR doc->>'reference' IS DISTINCT FROM NEW.initial_admission_ref
  OR doc->>'reviewSha256'!~'^[a-f0-9]{64}$' OR doc->>'database' IS DISTINCT FROM current_database() OR doc->>'runtimeUser' IS DISTINCT FROM current_user
  OR doc->>'merchantIdentityId' IS DISTINCT FROM NEW.merchant_identity_id OR doc->>'merchantNo' IS DISTINCT FROM NEW.wire_merchant_no
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'='SUBMIT'
   AND p->>'profileId'=NEW.initial_profile_id AND p->>'profileSha256'=NEW.initial_profile_sha256 AND p->>'keyVersionRef'=NEW.initial_key_version_ref)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'='QUERY')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'='NOTIFY')) IS NOT FALSE
 THEN RAISE EXCEPTION 'refund initial server admission resource/profile mismatch' USING ERRCODE='23514';END IF;
 SELECT p.order_id,p.payment_confirmation_id,p.version_hash,p.refund_due_at,p.renter_refund_cents,o.renter_user_id,
  c.source,c.merchant_scope_id,c.provider_transaction_id,c.merchant_order_no,c.amount_cents INTO b
  FROM zzsh_order.settlement_posting p JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id
  JOIN zzsh_order.rental_order o ON o.id=p.order_id AND o.paid_confirmation_id=c.id
  WHERE p.id=NEW.posting_id AND o.status='COMPLETED' AND c.order_id=o.id AND c.disposition='APPLIED' AND c.source='JOINPAY'
   AND c.currency='CNY' AND p.currency=c.currency AND p.captured_cents=c.amount_cents
   AND EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.posting_id=p.id AND l.account_code='RENTER_REFUND_PAYABLE'
    AND l.credit_cents=p.renter_refund_cents AND l.debit_cents=0 AND l.counterparty_user_id=o.renter_user_id);
 IF NOT FOUND OR NEW.order_id IS DISTINCT FROM b.order_id OR NEW.payment_confirmation_id IS DISTINCT FROM b.payment_confirmation_id
  OR NEW.renter_user_id IS DISTINCT FROM b.renter_user_id OR NEW.responsibility_version_hash IS DISTINCT FROM b.version_hash
  OR NEW.merchant_identity_id IS DISTINCT FROM b.merchant_scope_id OR NEW.original_payment_trx_no IS DISTINCT FROM b.provider_transaction_id
  OR NEW.original_payment_order_no IS DISTINCT FROM b.merchant_order_no OR NEW.due_at IS DISTINCT FROM b.refund_due_at
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_revision WHERE user_id=NEW.renter_user_id)
 THEN RAISE EXCEPTION 'formal refund frozen posting basis missing' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-funds:v1','JOINPAY',NEW.merchant_identity_id,NEW.original_payment_trx_no)::text,0));
 IF EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.payment_source='JOINPAY' AND i.merchant_identity_id=NEW.merchant_identity_id
  AND i.original_payment_trx_no=NEW.original_payment_trx_no AND i.requires_review)
 THEN RAISE EXCEPTION 'original payment refund requires review' USING ERRCODE='23514';END IF;
 SELECT COALESCE(sum(amount_cents),0),COALESCE(sum(amount_cents) FILTER(WHERE posting_id=NEW.posting_id),0)
  INTO paid_allocated,responsibility_allocated FROM zzsh_order.channel_refund_intent WHERE payment_source='JOINPAY'
  AND merchant_identity_id=NEW.merchant_identity_id AND original_payment_trx_no=NEW.original_payment_trx_no AND budget_disposition<>'RELEASED';
 IF paid_allocated+NEW.amount_cents>b.amount_cents OR responsibility_allocated+NEW.amount_cents>b.renter_refund_cents
  OR NEW.state<>'READY' OR NEW.revision<>1 OR NEW.lease_version<>0 OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL
  OR NEW.budget_disposition<>'ALLOCATED' OR NEW.requires_review
 THEN RAISE EXCEPTION 'formal refund allocation exceeds exact original liability' USING ERRCODE='23514';END IF;
 NEW.created_at:=clock_timestamp();NEW.updated_at:=NEW.created_at;RETURN NEW;
END $$;
CREATE TRIGGER channel_refund_controlled_write_guard BEFORE INSERT OR UPDATE ON zzsh_order.channel_refund_intent
 FOR EACH ROW WHEN(NEW.payment_source='CONTROLLED') EXECUTE FUNCTION zzsh_order.guard_controlled_channel_refund_intent_v1();
CREATE TRIGGER channel_refund_controlled_delete_guard BEFORE DELETE ON zzsh_order.channel_refund_intent
 FOR EACH ROW WHEN(OLD.payment_source='CONTROLLED') EXECUTE FUNCTION zzsh_order.guard_controlled_channel_refund_intent_v1();
CREATE TRIGGER channel_refund_joinpay_write_guard BEFORE INSERT OR UPDATE ON zzsh_order.channel_refund_intent
 FOR EACH ROW WHEN(NEW.payment_source='JOINPAY') EXECUTE FUNCTION zzsh_order.guard_joinpay_refund_intent();
CREATE TRIGGER channel_refund_joinpay_delete_guard BEFORE DELETE ON zzsh_order.channel_refund_intent
 FOR EACH ROW WHEN(OLD.payment_source='JOINPAY') EXECUTE FUNCTION zzsh_order.guard_joinpay_refund_intent();

CREATE FUNCTION zzsh_order.assert_joinpay_refund_profile(canonical text,op text,pid text,key_ref text,i zzsh_order.channel_refund_intent)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE p jsonb;r jsonb;
BEGIN
 p:=canonical::jsonb;r:=p->'rules';
 IF (p->>'kind' IS DISTINCT FROM 'JOINPAY_REFUND_PROFILE_V1' OR p->>'operation' IS DISTINCT FROM op
  OR p->>'purpose' IS DISTINCT FROM 'MERCHANT_REFUND' OR p->>'profileId' IS DISTINCT FROM pid
  OR p->>'merchantIdentityId' IS DISTINCT FROM i.merchant_identity_id OR p->>'merchantNo' IS DISTINCT FROM i.wire_merchant_no
  OR p->>'database' IS DISTINCT FROM current_database() OR p->>'runtimeUser' IS DISTINCT FROM current_user
  OR p->>'keyVersionRef' IS DISTINCT FROM key_ref OR p->>'permission' IS DISTINCT FROM 'REVIEWED_NATIVE_RENTAL_REFUND'
  OR p->>'reviewSha256'!~'^[a-f0-9]{64}$' OR r->>'sha256'!~'^[a-f0-9]{64}$'
  OR p#>>'{knownAnswer,rawSha256}'!~'^[a-f0-9]{64}$' OR r->>'signing' IS DISTINCT FROM 'MD5_UTF8_RAW_VALUES'
  OR r->>'rawQueryDecode' IS DISTINCT FROM 'ONCE' OR r->>'numberTokens' IS DISTINCT FROM 'RAW_JSON_TOKEN'
  OR r->>'fieldPolicy' IS DISTINCT FROM 'STRICT_TABLE_EMPTY_OPTIONAL' OR r->>'refundIdentifier' IS DISTINCT FROM 'EXACT_TEXT'
  OR r->>'notify102' IS DISTINCT FROM 'REVIEW' OR r->>'utcOffsetMinutes'!~'^-?[0-9]{1,3}$'
  OR abs((r->>'utcOffsetMinutes')::integer)>840 OR NOT COALESCE(r->>'refundWay' IN('ORIGINAL_REQUIRED','ORIGINAL_OR_MISSING_REVIEWED'),false)
  OR(op='SUBMIT' AND(p->>'notifyUrl' IS DISTINCT FROM i.notify_url OR p->>'fundsAccount' IS DISTINCT FROM i.funds_account))) IS NOT FALSE
 THEN RAISE EXCEPTION 'refund profile differs from exact merchant/resource/rules' USING ERRCODE='23514';END IF;
END $$;

CREATE FUNCTION zzsh_order.guard_joinpay_refund_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.channel_refund_intent;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=NEW.intent_id;
 IF i.id IS NULL OR i.payment_source<>'JOINPAY' OR i.evidence_level<>'JOINPAY_FORMAL' OR(NEW.operation='SUBMIT' AND i.requires_review)
  OR i.state NOT IN('SUBMITTING','UNKNOWN') OR i.budget_disposition<>'ALLOCATED'
  OR(NEW.operation='SUBMIT' AND NEW.admission_sha256<>i.initial_admission_sha256)
  OR NEW.operation IS DISTINCT FROM CASE WHEN i.lease_version=1 AND i.state='SUBMITTING' THEN 'SUBMIT' ELSE 'QUERY' END
 THEN RAISE EXCEPTION 'refund attempt original binding missing' USING ERRCODE='23514';END IF;
 IF NEW.lease_version<>i.lease_version OR NEW.lease_owner<>i.lease_owner OR i.lease_until IS NULL OR i.lease_until<=clock_timestamp()
 THEN RAISE EXCEPTION 'refund attempt lease is stale' USING ERRCODE='23514',CONSTRAINT='joinpay_refund_live_lease';END IF;
 IF NEW.operation='SUBMIT' AND(NEW.profile_id<>i.initial_profile_id OR NEW.profile_sha256<>i.initial_profile_sha256
  OR NEW.key_version_ref<>i.initial_key_version_ref)
 THEN RAISE EXCEPTION 'first refund submit must use original profile' USING ERRCODE='23514';END IF;
 PERFORM zzsh_order.assert_joinpay_refund_profile(NEW.profile_canonical,NEW.operation,NEW.profile_id,NEW.key_version_ref,i);
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER joinpay_refund_attempt_guard BEFORE INSERT ON zzsh_order.joinpay_refund_attempt
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_refund_attempt();

CREATE FUNCTION zzsh_order.guard_joinpay_refund_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.channel_refund_intent;a zzsh_order.joinpay_refund_attempt;current_lease boolean;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=NEW.intent_id;
 IF i.id IS NULL OR i.payment_source<>'JOINPAY' OR i.evidence_level<>'JOINPAY_FORMAL' OR NEW.state_before<>i.state
 THEN RAISE EXCEPTION 'refund observation original intent mismatch' USING ERRCODE='23514';END IF;
 PERFORM zzsh_order.assert_joinpay_refund_profile(NEW.profile_canonical,NEW.operation,NEW.profile_id,NEW.key_version_ref,i);
 IF NEW.operation<>'NOTIFY' THEN
  SELECT * INTO a FROM zzsh_order.joinpay_refund_attempt WHERE id=NEW.attempt_id AND intent_id=i.id;
  IF a.id IS NULL OR (a.operation,a.lease_version,a.lease_owner) IS DISTINCT FROM (NEW.operation,NEW.lease_version,NEW.lease_owner)
   OR a.profile_id<>NEW.profile_id OR a.profile_sha256<>NEW.profile_sha256 OR a.profile_canonical<>NEW.profile_canonical
   OR a.key_version_ref<>NEW.key_version_ref
  THEN RAISE EXCEPTION 'refund observation attempt mismatch' USING ERRCODE='23514';END IF;
  current_lease:=i.lease_version=a.lease_version AND i.lease_owner=a.lease_owner AND i.lease_until>clock_timestamp();
  IF NEW.event='STALE' THEN
   IF current_lease OR NEW.state_after<>i.state THEN RAISE EXCEPTION 'refund stale observation cannot change state' USING ERRCODE='23514';END IF;
  ELSIF NOT current_lease THEN
   RAISE EXCEPTION 'refund result lease is stale' USING ERRCODE='23514',CONSTRAINT='joinpay_refund_live_lease';
  END IF;
 ELSIF NEW.event='STALE' THEN RAISE EXCEPTION 'notification has no worker lease' USING ERRCODE='23514';END IF;
 IF NEW.event IN('PENDING_TERMINAL','TERMINAL') AND(NEW.state_before<>NEW.state_after OR NEW.operation='SUBMIT'
  OR NEW.evidence_level<>'PROVIDER_RESPONSE' OR NOT NEW.response_complete
  OR(NEW.operation='QUERY' AND NEW.http_status IS DISTINCT FROM 200) OR(NEW.operation='NOTIFY' AND NEW.http_status IS NOT NULL) OR NEW.transport_failure IS NOT NULL
  OR NEW.schema_status<>'VALID' OR NEW.signature_status<>'MATCH' OR NEW.binding_status<>'MATCH')
 THEN RAISE EXCEPTION 'refund terminal observation must remain a verified raw observation' USING ERRCODE='23514';END IF;
 IF i.state IN('SUCCEEDED','FAILED') AND NEW.state_after<>i.state
 THEN RAISE EXCEPTION 'late refund observation cannot change terminal' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER joinpay_refund_observation_guard BEFORE INSERT ON zzsh_order.joinpay_refund_observation
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_refund_observation();

CREATE FUNCTION zzsh_order.guard_joinpay_refund_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.channel_refund_intent;o zzsh_order.joinpay_refund_observation;f jsonb;p jsonb;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=NEW.intent_id;
 IF i.id IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-funds:v1','JOINPAY',i.merchant_identity_id,i.original_payment_trx_no)::text,0));
  PERFORM id FROM zzsh_auth_user."user" WHERE id=i.renter_user_id FOR UPDATE;
  PERFORM user_id FROM zzsh_order.wallet_revision WHERE user_id=i.renter_user_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'native refund original revision absent' USING ERRCODE='23514';END IF;
  SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=NEW.intent_id FOR UPDATE;
 END IF;
 SELECT * INTO o FROM zzsh_order.joinpay_refund_observation WHERE id=NEW.observation_id AND intent_id=i.id;
 f:=NEW.facts_canonical::jsonb;
 p:=o.profile_canonical::jsonb;
 IF i.id IS NULL OR i.payment_source<>'JOINPAY' OR i.evidence_level<>'JOINPAY_FORMAL' OR i.initial_admission_ref IS NULL
  OR i.state NOT IN('SUBMITTING','UNKNOWN','PROCESSING') OR i.requires_review OR i.budget_disposition<>'ALLOCATED'
  OR o.id IS NULL OR o.created_xid<>pg_current_xact_id() OR o.operation<>NEW.operation OR o.operation='SUBMIT'
  OR o.event<>'PENDING_TERMINAL' OR o.evidence_level<>'PROVIDER_RESPONSE' OR NOT o.response_complete
  OR(o.operation='QUERY' AND o.http_status IS DISTINCT FROM 200) OR(o.operation='NOTIFY' AND o.http_status IS NOT NULL)
  OR o.transport_failure IS NOT NULL OR o.schema_status<>'VALID' OR o.signature_status<>'MATCH' OR o.binding_status<>'MATCH'
  OR f->>'evidenceId' IS DISTINCT FROM NEW.id OR f->>'intentId' IS DISTINCT FROM i.id OR f->>'postingId' IS DISTINCT FROM i.posting_id
  OR f->>'orderId' IS DISTINCT FROM i.order_id OR f->>'paymentConfirmationId' IS DISTINCT FROM i.payment_confirmation_id
  OR f->>'renterUserId' IS DISTINCT FROM i.renter_user_id OR f->>'merchantIdentityId' IS DISTINCT FROM i.merchant_identity_id
  OR f->>'originalPaymentTrxNo' IS DISTINCT FROM i.original_payment_trx_no OR f->>'originalPaymentOrderNo' IS DISTINCT FROM i.original_payment_order_no
  OR f->>'responsibilityVersionHash' IS DISTINCT FROM i.responsibility_version_hash OR f->>'refundOrderNo' IS DISTINCT FROM i.refund_order_no
  OR f->>'amountCents' IS DISTINCT FROM i.amount_cents::text OR f->>'currency' IS DISTINCT FROM 'CNY'
  OR f->>'terminal' IS DISTINCT FROM NEW.terminal OR f->>'refundTransactionNo' IS DISTINCT FROM NEW.refund_transaction_no
  OR(f->>'completedAt')::timestamptz IS DISTINCT FROM NEW.completed_at OR f->>'sourceObservationId' IS DISTINCT FROM o.id
 THEN RAISE EXCEPTION 'refund terminal evidence differs from immutable raw binding' USING ERRCODE='23514';END IF;
 IF NEW.terminal='SUCCEEDED' AND(NEW.completed_at_raw!~'^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
  OR NEW.completed_at IS DISTINCT FROM(NEW.completed_at_raw::timestamp AT TIME ZONE 'UTC')-make_interval(mins=>(p#>>'{rules,utcOffsetMinutes}')::integer))
 THEN RAISE EXCEPTION 'refund completion time differs from reviewed timezone' USING ERRCODE='23514';END IF;
 IF NEW.terminal='FAILED_NO_EXECUTION' AND((p#>>'{rules,failureNoExecution,accepted}' IS DISTINCT FROM 'true'
  OR p#>>'{rules,failureNoExecution,reference}' IS NULL OR p#>>'{rules,failureNoExecution,sha256}'!~'^[a-f0-9]{64}$'
  OR jsonb_array_length(p#>'{rules,failureNoExecution,codes}')=0) IS NOT FALSE)
 THEN RAISE EXCEPTION 'refund failure has no reviewed no-execution semantics' USING ERRCODE='23514';END IF;
 IF o.operation='QUERY' AND(i.lease_version IS DISTINCT FROM o.lease_version OR i.lease_owner IS DISTINCT FROM o.lease_owner
  OR i.lease_until IS NULL OR i.lease_until<=clock_timestamp())
 THEN RAISE EXCEPTION 'refund terminal evidence lease expired' USING ERRCODE='23514',CONSTRAINT='joinpay_refund_live_lease';END IF;
 IF NEW.refund_transaction_no IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-transaction:v1','JOINPAY',i.merchant_identity_id,NEW.refund_transaction_no)::text,0));
  IF EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent other WHERE other.payment_source='JOINPAY' AND other.id<>i.id
    AND other.merchant_identity_id=i.merchant_identity_id AND other.provider_refund_trx_no=NEW.refund_transaction_no)
  THEN RAISE EXCEPTION 'refund transaction already consumed by another intent' USING ERRCODE='23514';END IF;
 END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER joinpay_refund_evidence_guard BEFORE INSERT ON zzsh_order.joinpay_refund_evidence
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_joinpay_refund_evidence();

CREATE TRIGGER joinpay_refund_attempt_immutable BEFORE UPDATE OR DELETE ON zzsh_order.joinpay_refund_attempt
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER joinpay_refund_observation_immutable BEFORE UPDATE OR DELETE ON zzsh_order.joinpay_refund_observation
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER joinpay_refund_evidence_immutable BEFORE UPDATE OR DELETE ON zzsh_order.joinpay_refund_evidence
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();

ALTER TABLE zzsh_order.finance_economic_root DROP CONSTRAINT finance_root_enabled_source_shape,
 ADD CONSTRAINT finance_root_enabled_source_shape CHECK((source_kind IN('LEGACY_OPENING','NATIVE_GENESIS') AND basis_id IS NOT NULL)
  OR(source_kind IN('LOCAL_CONTROLLED_WITHDRAWAL','NATIVE_RENTAL_REFERRAL','NATIVE_GUARANTEE','LEGACY_CONTINUATION_DUTY','NATIVE_RENTAL_REFUND') AND basis_id IS NULL));
ALTER TABLE zzsh_order.finance_event DROP CONSTRAINT finance_event_kind_check,
 ADD CONSTRAINT finance_event_kind_check CHECK(kind IN('OPENING','RESERVE','RELEASE','PAYOUT','EARNING_PENDING','EARNING_SETTLED',
  'EARNING_REVOKED','GUARANTEE_CAPTURE','GUARANTEE_REFUND','LEGACY_DUTY_SETTLED','REFUND_PAID'));

CREATE FUNCTION zzsh_order.guard_native_refund_root() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.channel_refund_intent;e zzsh_order.joinpay_refund_evidence;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=NEW.source_id;
 SELECT * INTO e FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=i.id;
 IF i.id IS NULL OR e.id IS NULL OR e.created_xid<>pg_current_xact_id() OR e.terminal<>'SUCCEEDED'
  OR NEW.id IS DISTINCT FROM 'native_refund_root_'||substr(encode(sha256(convert_to(i.id,'UTF8')),'hex'),1,40)
  OR NEW.basis_id IS NOT NULL OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh' OR NEW.source_entity<>'channel_refund_intent'
  OR NEW.subject_user_id<>i.renter_user_id OR NEW.beneficiary_role<>'RENTER' OR NEW.policy_version IS NOT NULL OR NEW.source_digest<>e.facts_digest
 THEN RAISE EXCEPTION 'native refund root requires exact same-transaction terminal evidence' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER native_refund_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root
 FOR EACH ROW WHEN(NEW.source_kind='NATIVE_RENTAL_REFUND') EXECUTE FUNCTION zzsh_order.guard_native_refund_root();

CREATE FUNCTION zzsh_order.guard_native_refund_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.channel_refund_intent;e zzsh_order.joinpay_refund_evidence;r zzsh_order.finance_economic_root;rev bigint;
BEGIN
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=r.source_id;
 SELECT * INTO e FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=i.id;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=i.renter_user_id FOR UPDATE;
 SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=NEW.subject_user_id;
 IF r.id IS NULL OR r.source_kind<>'NATIVE_RENTAL_REFUND' OR r.created_xid<>pg_current_xact_id() OR e.id IS NULL
  OR e.created_xid<>pg_current_xact_id() OR e.terminal<>'SUCCEEDED' OR i.id IS NULL OR rev IS NULL
  OR NEW.id IS DISTINCT FROM 'native_refund_paid_'||substr(encode(sha256(convert_to(i.id,'UTF8')),'hex'),1,40)
  OR NEW.subject_user_id<>i.renter_user_id OR NEW.expected_ledger_revision IS DISTINCT FROM rev
 THEN RAISE EXCEPTION 'native refund event requires original liability revision' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER native_refund_event_guard BEFORE INSERT ON zzsh_order.finance_event
 FOR EACH ROW WHEN(NEW.kind='REFUND_PAID') EXECUTE FUNCTION zzsh_order.guard_native_refund_event();

CREATE FUNCTION zzsh_order.guard_native_refund_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.channel_refund_intent;e zzsh_order.joinpay_refund_evidence;ev zzsh_order.finance_event;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=NEW.details->>'nativeRefundIntentId';
 SELECT * INTO e FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=i.id;
 SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 IF i.id IS NULL OR e.id IS NULL OR e.created_xid<>pg_current_xact_id() OR e.terminal<>'SUCCEEDED'
  OR ev.id IS NULL OR ev.kind<>'REFUND_PAID' OR ev.created_xid<>pg_current_xact_id()
  OR ev.economic_root_id IS DISTINCT FROM 'native_refund_root_'||substr(encode(sha256(convert_to(i.id,'UTF8')),'hex'),1,40)
  OR ev.subject_user_id<>i.renter_user_id OR NEW.source_payment_confirmation_id IS NOT NULL
  OR NEW.details IS DISTINCT FROM jsonb_build_object('nativeRefundIntentId',i.id,'postingId',i.posting_id,
   'paymentConfirmationId',i.payment_confirmation_id,'refundOrderNo',i.refund_order_no,'factsDigest',e.facts_digest)
  OR NOT((NEW.line_no=1 AND NEW.account_code='RENTER_REFUND_PAYABLE' AND NEW.debit_cents=i.amount_cents AND NEW.credit_cents=0
    AND NEW.counterparty_user_id=i.renter_user_id)
   OR(NEW.line_no=2 AND NEW.account_code='PAYOUT_CLEARING' AND NEW.debit_cents=0 AND NEW.credit_cents=i.amount_cents
    AND NEW.counterparty_user_id IS NULL))
 THEN RAISE EXCEPTION 'native refund entry differs from original responsibility consumption' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER native_refund_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry
 FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'nativeRefundIntentId') EXECUTE FUNCTION zzsh_order.guard_native_refund_entry();
DROP TRIGGER finance_entry_guard ON zzsh_order.settlement_ledger_entry;
CREATE TRIGGER finance_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId') AND NOT(NEW.details?'earningId')
  AND NOT(NEW.details?'guaranteeId') AND NOT(NEW.details?'legacyDutyId') AND NOT(NEW.details?'nativeRefundIntentId'))
 EXECUTE FUNCTION zzsh_order.guard_finance_entry();
DROP TRIGGER finance_entry_batch_guard ON zzsh_order.settlement_ledger_entry;
CREATE CONSTRAINT TRIGGER finance_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId') AND NOT(NEW.details?'earningId')
  AND NOT(NEW.details?'guaranteeId') AND NOT(NEW.details?'legacyDutyId') AND NOT(NEW.details?'nativeRefundIntentId'))
 EXECUTE FUNCTION zzsh_order.check_finance_batch();

/** 不创造期初、coverage或钱包贷项，只推动既有应退科目对应的共同revision。 */
CREATE TRIGGER native_refund_wallet_revision AFTER INSERT ON zzsh_order.finance_event
 FOR EACH ROW WHEN(NEW.kind='REFUND_PAID') EXECUTE FUNCTION zzsh_order.withdrawal_wallet_revision();

CREATE FUNCTION zzsh_order.native_refund_terminal_complete(intent_id_value text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.channel_refund_intent;e zzsh_order.joinpay_refund_evidence;r zzsh_order.finance_economic_root;
 ev zzsh_order.finance_event;lines bigint;good bigint;dr numeric;cr numeric;rev bigint;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=intent_id_value;
 SELECT * INTO e FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=i.id;
 IF i.id IS NULL OR i.payment_source<>'JOINPAY' OR i.evidence_level<>'JOINPAY_FORMAL' OR e.id IS NULL
  OR i.terminal_evidence_id IS DISTINCT FROM e.id OR i.provider_refund_trx_no IS DISTINCT FROM e.refund_transaction_no
  OR i.completed_at IS DISTINCT FROM e.completed_at
 THEN RETURN false;END IF;
 IF e.terminal='FAILED_NO_EXECUTION' THEN
  RETURN i.state='FAILED' AND i.budget_disposition='RELEASED' AND i.terminal_root_id IS NULL AND i.terminal_event_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.finance_economic_root WHERE source_kind='NATIVE_RENTAL_REFUND' AND source_id=i.id)
   AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.refund.allocation.released' AND a.object_type='channel_refund_intent'
    AND a.object_id=i.id AND a.outcome='SUCCESS' AND a.details->>'evidenceId'=e.id AND a.details->>'factsDigest'=e.facts_digest
    AND a.details->>'budgetDisposition'='RELEASED' AND a.details->>'postingId'=i.posting_id
    AND a.details->>'paymentConfirmationId'=i.payment_confirmation_id AND a.details->>'amountCents'=i.amount_cents::text
    AND a.details->>'currency'='CNY' AND a.details->>'channelArrival'='UNKNOWN');
 END IF;
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=i.terminal_root_id;
 SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=i.terminal_event_id;
 SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=i.renter_user_id;
 IF i.state<>'SUCCEEDED' OR i.budget_disposition<>'CONSUMED' OR r.id IS NULL OR ev.id IS NULL OR rev IS NULL
  OR r.source_kind<>'NATIVE_RENTAL_REFUND' OR r.source_type<>'NATIVE' OR r.source_system<>'zzsh' OR r.source_entity<>'channel_refund_intent'
  OR r.source_id<>i.id OR r.subject_user_id<>i.renter_user_id OR r.source_digest<>e.facts_digest OR r.beneficiary_role<>'RENTER'
  OR r.basis_id IS NOT NULL OR r.policy_version IS NOT NULL OR ev.kind<>'REFUND_PAID' OR ev.economic_root_id<>r.id
  OR ev.subject_user_id<>i.renter_user_id OR rev<ev.expected_ledger_revision+1
  OR(SELECT count(*) FROM zzsh_order.finance_event WHERE economic_root_id=r.id)<>1
 THEN RETURN false;END IF;
 SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0),count(*) FILTER(WHERE
  source_payment_confirmation_id IS NULL AND details=jsonb_build_object('nativeRefundIntentId',i.id,'postingId',i.posting_id,
   'paymentConfirmationId',i.payment_confirmation_id,'refundOrderNo',i.refund_order_no,'factsDigest',e.facts_digest)
  AND((line_no=1 AND account_code='RENTER_REFUND_PAYABLE' AND debit_cents=i.amount_cents AND credit_cents=0 AND counterparty_user_id=i.renter_user_id)
   OR(line_no=2 AND account_code='PAYOUT_CLEARING' AND debit_cents=0 AND credit_cents=i.amount_cents AND counterparty_user_id IS NULL)))
  INTO lines,dr,cr,good FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=ev.id;
 RETURN lines=2 AND good=2 AND dr=i.amount_cents AND cr=i.amount_cents
  AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.refund.liability.consumed' AND a.object_type='channel_refund_intent'
   AND a.object_id=i.id AND a.outcome='SUCCESS' AND a.details->>'evidenceId'=e.id AND a.details->>'factsDigest'=e.facts_digest
   AND a.details->>'budgetDisposition'='CONSUMED' AND a.details->>'postingId'=i.posting_id
   AND a.details->>'paymentConfirmationId'=i.payment_confirmation_id AND a.details->>'amountCents'=i.amount_cents::text
   AND a.details->>'currency'='CNY' AND a.details->>'channelArrival'='UNKNOWN');
END $$;

CREATE FUNCTION zzsh_order.check_native_refund_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text;i zzsh_order.channel_refund_intent;
BEGIN
 IF TG_TABLE_NAME='channel_refund_intent' THEN target:=NEW.id;
 ELSIF TG_TABLE_NAME='joinpay_refund_evidence' THEN target:=NEW.intent_id;
 ELSIF TG_TABLE_NAME='joinpay_refund_observation' THEN
  IF NEW.event<>'PENDING_TERMINAL' THEN RETURN NULL;END IF;target:=NEW.intent_id;
  IF NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_evidence WHERE observation_id=NEW.id)
  THEN RAISE EXCEPTION 'pending refund observation lacks terminal evidence' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='finance_economic_root' THEN target:=NEW.source_id;
 ELSIF TG_TABLE_NAME='finance_event' THEN SELECT source_id INTO target FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 ELSE target:=NEW.details->>'nativeRefundIntentId';END IF;
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=target;
 IF i.id IS NULL OR i.payment_source<>'JOINPAY' THEN RAISE EXCEPTION 'native refund closure original missing' USING ERRCODE='23514';END IF;
 IF i.lease_version>0 AND NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_attempt a
  WHERE a.intent_id=i.id AND a.lease_version=i.lease_version AND a.lease_owner=i.lease_owner)
 THEN RAISE EXCEPTION 'native refund claim has no committed original attempt' USING ERRCODE='23514';END IF;
 IF i.state IN('SUCCEEDED','FAILED') THEN
  IF NOT zzsh_order.native_refund_terminal_complete(target)
  THEN RAISE EXCEPTION 'native refund terminal batch incomplete' USING ERRCODE='23514';END IF;
 ELSIF i.budget_disposition<>'ALLOCATED' OR EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=target)
  OR EXISTS(SELECT 1 FROM zzsh_order.finance_economic_root WHERE source_kind='NATIVE_RENTAL_REFUND' AND source_id=target)
 THEN RAISE EXCEPTION 'unresolved native refund cannot release or post money' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER native_refund_intent_closure AFTER INSERT OR UPDATE ON zzsh_order.channel_refund_intent
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.payment_source='JOINPAY') EXECUTE FUNCTION zzsh_order.check_native_refund_closure();
CREATE CONSTRAINT TRIGGER native_refund_evidence_closure AFTER INSERT ON zzsh_order.joinpay_refund_evidence
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_native_refund_closure();
CREATE CONSTRAINT TRIGGER native_refund_observation_closure AFTER INSERT ON zzsh_order.joinpay_refund_observation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_native_refund_closure();
CREATE CONSTRAINT TRIGGER native_refund_root_closure AFTER INSERT ON zzsh_order.finance_economic_root
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.source_kind='NATIVE_RENTAL_REFUND') EXECUTE FUNCTION zzsh_order.check_native_refund_closure();
CREATE CONSTRAINT TRIGGER native_refund_event_closure AFTER INSERT ON zzsh_order.finance_event
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='REFUND_PAID') EXECUTE FUNCTION zzsh_order.check_native_refund_closure();
CREATE CONSTRAINT TRIGGER native_refund_entry_closure AFTER INSERT ON zzsh_order.settlement_ledger_entry
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'nativeRefundIntentId')
 EXECUTE FUNCTION zzsh_order.check_native_refund_closure();

REVOKE ALL ON zzsh_order.joinpay_refund_attempt,zzsh_order.joinpay_refund_observation,zzsh_order.joinpay_refund_evidence FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_controlled_channel_refund_intent_v1(),zzsh_order.guard_joinpay_refund_intent(),
 zzsh_order.guard_joinpay_refund_attempt(),zzsh_order.guard_joinpay_refund_observation(),zzsh_order.guard_joinpay_refund_evidence(),
 zzsh_order.assert_joinpay_refund_profile(text,text,text,text,zzsh_order.channel_refund_intent),
 zzsh_order.guard_native_refund_root(),zzsh_order.guard_native_refund_event(),zzsh_order.guard_native_refund_entry(),
 zzsh_order.native_refund_terminal_complete(text),zzsh_order.check_native_refund_closure() FROM PUBLIC;
-- runtime窄列INSERT/UPDATE/SELECT与上述只读complete/helper EXECUTE由Admin正式迁移装配另交。
-- created_xid/created_at、原绑定/金额/原责任/准入列不授UPDATE；不授新表UPDATE/DELETE。
