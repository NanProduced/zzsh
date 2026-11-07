-- A staff-reviewed historic refund is separate from a new channel result.
CREATE TABLE zzsh_order.legacy_refund_case (
 id text PRIMARY KEY CHECK(id~'^legacy_refund_case_[a-f0-9]{40}$'),
 duty_id text NOT NULL UNIQUE REFERENCES zzsh_order.legacy_order_duty(id),
 order_id text NOT NULL REFERENCES zzsh_order.legacy_order_read_snapshot(id),
 review_audit_id text NOT NULL UNIQUE REFERENCES zzsh_iam.audit_event(id),
 review_digest text NOT NULL CHECK(review_digest~'^[a-f0-9]{64}$'),
 renter_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 merchant_identity_id text NOT NULL CHECK(length(merchant_identity_id) BETWEEN 1 AND 128),
 merchant_no text NOT NULL CHECK(merchant_no~'^[0-9]{1,15}$'),
 original_payment_order_no text NOT NULL CHECK(original_payment_order_no~'^[A-Za-z0-9_-]{1,50}$'),
 original_payment_record_id text NOT NULL CHECK(original_payment_record_id~'^[1-9][0-9]{0,23}$'),
 paid_cents numeric(24,0) NOT NULL CHECK(paid_cents>0 AND paid_cents<=9999999999999999),
 duty_cents numeric(24,0) NOT NULL CHECK(duty_cents>=0),
 previously_refunded_cents numeric(24,0) NOT NULL CHECK(previously_refunded_cents>=0),
 prior_applied_cents numeric(24,0) NOT NULL CHECK(prior_applied_cents>=0),
 new_refund_cents numeric(24,0) NOT NULL CHECK(new_refund_cents>=0),
 source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),
 duty_fact_digest text NOT NULL CHECK(duty_fact_digest~'^[a-f0-9]{64}$'),
 refund_due_at timestamptz NOT NULL,
 history_event_id text UNIQUE REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED,
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(original_payment_order_no),UNIQUE(original_payment_record_id),
 CHECK(previously_refunded_cents<=paid_cents AND prior_applied_cents<=previously_refunded_cents AND prior_applied_cents<=duty_cents
  AND new_refund_cents=duty_cents-prior_applied_cents AND new_refund_cents<=paid_cents-previously_refunded_cents),
 CHECK((prior_applied_cents=0 AND history_event_id IS NULL) OR(prior_applied_cents>0 AND history_event_id IS NOT NULL))
);
CREATE TABLE zzsh_order.legacy_refund_intent (
 id text PRIMARY KEY CHECK(id~'^legacy_refund_intent_[a-f0-9]{40}$'),
 case_id text NOT NULL REFERENCES zzsh_order.legacy_refund_case(id),
 generation integer NOT NULL DEFAULT 1 CHECK(generation>0),retry_of_id text UNIQUE REFERENCES zzsh_order.legacy_refund_intent(id),
 refund_order_no text NOT NULL UNIQUE CHECK(refund_order_no~'^LR[a-f0-9]{28}$'),
 amount_cents numeric(24,0) NOT NULL CHECK(amount_cents>0),
 initial_admission_ref text NOT NULL CHECK(length(initial_admission_ref) BETWEEN 1 AND 128),
 initial_admission_sha256 text NOT NULL CHECK(initial_admission_sha256~'^[a-f0-9]{64}$'),
 initial_admission_canonical text NOT NULL CHECK(octet_length(initial_admission_canonical) BETWEEN 2 AND 262144
  AND initial_admission_sha256=encode(sha256(convert_to(initial_admission_canonical,'UTF8')),'hex')),
 initial_profile_id text NOT NULL CHECK(length(initial_profile_id) BETWEEN 1 AND 128),
 initial_profile_sha256 text NOT NULL CHECK(initial_profile_sha256~'^[a-f0-9]{64}$'),
 initial_profile_canonical text NOT NULL CHECK(octet_length(initial_profile_canonical) BETWEEN 2 AND 262144
  AND initial_profile_sha256=encode(sha256(convert_to(initial_profile_canonical,'UTF8')),'hex')),
 initial_key_version_ref text NOT NULL CHECK(length(initial_key_version_ref) BETWEEN 1 AND 128),
 notify_url text NOT NULL CHECK(octet_length(notify_url) BETWEEN 9 AND 300 AND notify_url LIKE 'https://%'),
 funds_account text CHECK(funds_account IS NULL OR funds_account IN('SETTLED','ADVANCE')),
 state text NOT NULL DEFAULT 'READY' CHECK(state IN('READY','SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED','SUCCEEDED','FAILED')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),lease_version bigint NOT NULL DEFAULT 0 CHECK(lease_version>=0),
 lease_owner text CHECK(lease_owner~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),lease_until timestamptz,claim_xid xid8,
 requires_review boolean NOT NULL DEFAULT false,budget_disposition text NOT NULL DEFAULT 'ALLOCATED' CHECK(budget_disposition IN('ALLOCATED','CONSUMED','RELEASED')),
 terminal_evidence_id text,terminal_event_id text REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED,
 provider_refund_trx_no text,completed_at timestamptz,updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((lease_owner IS NULL)=(lease_until IS NULL)),
 CHECK(state<>'REVIEW_REQUIRED' OR requires_review),
 CHECK((state='READY' AND lease_version=0 AND lease_owner IS NULL AND claim_xid IS NULL)
  OR(state<>'READY' AND lease_version>0 AND lease_owner IS NOT NULL AND claim_xid IS NOT NULL)),
 CHECK((state NOT IN('SUCCEEDED','FAILED') AND budget_disposition='ALLOCATED' AND num_nonnulls(terminal_evidence_id,terminal_event_id,provider_refund_trx_no,completed_at)=0)
  OR(state='SUCCEEDED' AND budget_disposition='CONSUMED' AND num_nonnulls(terminal_evidence_id,terminal_event_id,provider_refund_trx_no,completed_at)=4)
  OR(state='FAILED' AND budget_disposition='RELEASED' AND terminal_evidence_id IS NOT NULL AND terminal_event_id IS NULL)),
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
 ,UNIQUE(case_id,generation),CHECK((generation=1 AND retry_of_id IS NULL) OR(generation>1 AND retry_of_id IS NOT NULL))
);
CREATE UNIQUE INDEX legacy_refund_case_unreleased_once ON zzsh_order.legacy_refund_intent(case_id) WHERE budget_disposition IN('ALLOCATED','CONSUMED');
CREATE TRIGGER legacy_refund_case_immutable BEFORE UPDATE OR DELETE ON zzsh_order.legacy_refund_case FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER legacy_refund_intent_immutable BEFORE DELETE ON zzsh_order.legacy_refund_intent FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TABLE zzsh_order.legacy_refund_attempt (
 id text PRIMARY KEY,intent_id text NOT NULL REFERENCES zzsh_order.legacy_refund_intent(id),
 operation text NOT NULL CHECK(operation IN('SUBMIT','QUERY')),lease_version bigint NOT NULL CHECK(lease_version>0),lease_owner text NOT NULL,
 profile_id text NOT NULL,profile_canonical text NOT NULL,profile_sha256 text NOT NULL CHECK(profile_sha256=encode(sha256(convert_to(profile_canonical,'UTF8')),'hex')),
 key_version_ref text NOT NULL,admission_sha256 text NOT NULL CHECK(admission_sha256~'^[a-f0-9]{64}$'),
 request_body bytea NOT NULL,request_sha256 text NOT NULL CHECK(request_sha256=encode(sha256(request_body),'hex')),
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(intent_id,lease_version),UNIQUE(id,intent_id)
);
CREATE UNIQUE INDEX legacy_refund_one_submit ON zzsh_order.legacy_refund_attempt(intent_id) WHERE operation='SUBMIT';
CREATE TABLE zzsh_order.legacy_refund_observation (
 id text PRIMARY KEY,intent_id text NOT NULL REFERENCES zzsh_order.legacy_refund_intent(id),attempt_id text,
 operation text NOT NULL CHECK(operation IN('SUBMIT','QUERY','NOTIFY')),lease_version bigint,lease_owner text,
 profile_id text NOT NULL,profile_canonical text NOT NULL,profile_sha256 text NOT NULL CHECK(profile_sha256=encode(sha256(convert_to(profile_canonical,'UTF8')),'hex')),
 key_version_ref text NOT NULL,raw_body bytea,raw_sha256 text,response_complete boolean NOT NULL,http_status integer,received_bytes integer NOT NULL CHECK(received_bytes>=0),
 transport_failure text,event text NOT NULL CHECK(event IN('UNKNOWN','PROCESSING','PENDING_TERMINAL','TERMINAL','REVIEW','STALE')),
 schema_status text NOT NULL CHECK(schema_status IN('NOT_CHECKED','INVALID','VALID')),
 signature_status text NOT NULL CHECK(signature_status IN('NOT_CHECKED','MISMATCH','MATCH')),
 binding_status text NOT NULL CHECK(binding_status IN('NOT_CHECKED','MISMATCH','MATCH')),
 channel_code text,
 evidence_level text NOT NULL CHECK(evidence_level IN('SYNTHETIC_PROTOCOL','PROVIDER_RESPONSE')),
 state_before text NOT NULL,state_after text NOT NULL,request_id text NOT NULL,
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(attempt_id,intent_id) REFERENCES zzsh_order.legacy_refund_attempt(id,intent_id),
 CHECK((raw_body IS NULL AND raw_sha256 IS NULL) OR(raw_body IS NOT NULL AND raw_sha256=encode(sha256(raw_body),'hex'))),
 CHECK((operation='NOTIFY' AND attempt_id IS NULL AND lease_version IS NULL AND lease_owner IS NULL)
  OR(operation<>'NOTIFY' AND attempt_id IS NOT NULL AND lease_version IS NOT NULL AND lease_owner IS NOT NULL)),
 UNIQUE(id,intent_id)
);
CREATE INDEX legacy_refund_review_observations_idx ON zzsh_order.legacy_refund_observation(intent_id,created_at,id) WHERE event='REVIEW';
CREATE TABLE zzsh_order.legacy_refund_terminal_evidence (
 id text PRIMARY KEY,intent_id text NOT NULL UNIQUE REFERENCES zzsh_order.legacy_refund_intent(id),observation_id text NOT NULL UNIQUE,
 terminal text NOT NULL CHECK(terminal IN('SUCCEEDED','FAILED_NO_EXECUTION')),merchant_no text NOT NULL,
 refund_transaction_no text,completed_at_raw text,completed_at timestamptz,
 finance_event_id text UNIQUE REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED,
 facts_canonical text NOT NULL,facts_digest text NOT NULL CHECK(facts_digest=encode(sha256(convert_to(facts_canonical,'UTF8')),'hex')),
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(observation_id,intent_id) REFERENCES zzsh_order.legacy_refund_observation(id,intent_id),
 CHECK((terminal='SUCCEEDED' AND refund_transaction_no IS NOT NULL AND completed_at_raw IS NOT NULL AND completed_at IS NOT NULL AND finance_event_id IS NOT NULL)
  OR(terminal='FAILED_NO_EXECUTION' AND finance_event_id IS NULL))
);
CREATE UNIQUE INDEX legacy_refund_terminal_transaction_once ON zzsh_order.legacy_refund_terminal_evidence(merchant_no,refund_transaction_no) WHERE refund_transaction_no IS NOT NULL;
ALTER TABLE zzsh_order.legacy_refund_intent ADD CONSTRAINT legacy_refund_intent_terminal_fk FOREIGN KEY(terminal_evidence_id) REFERENCES zzsh_order.legacy_refund_terminal_evidence(id) DEFERRABLE INITIALLY DEFERRED;
CREATE TRIGGER legacy_refund_attempt_immutable BEFORE UPDATE OR DELETE ON zzsh_order.legacy_refund_attempt FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER legacy_refund_observation_immutable BEFORE UPDATE OR DELETE ON zzsh_order.legacy_refund_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER legacy_refund_terminal_immutable BEFORE UPDATE OR DELETE ON zzsh_order.legacy_refund_terminal_evidence FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TABLE zzsh_order.legacy_refund_review_resolution (
 id text PRIMARY KEY,intent_id text NOT NULL REFERENCES zzsh_order.legacy_refund_intent(id),previous_revision bigint NOT NULL,
 actor_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),session_id text NOT NULL,request_id text NOT NULL,reason text NOT NULL,
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),UNIQUE(intent_id,previous_revision)
);
CREATE TRIGGER legacy_refund_review_resolution_immutable BEFORE UPDATE OR DELETE ON zzsh_order.legacy_refund_review_resolution FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TABLE zzsh_order.legacy_refund_terminal_resolution (
 id text PRIMARY KEY,intent_id text NOT NULL REFERENCES zzsh_order.legacy_refund_intent(id),observation_id text NOT NULL UNIQUE,
 terminal_evidence_id text NOT NULL REFERENCES zzsh_order.legacy_refund_terminal_evidence(id),actor_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
 session_id text NOT NULL,request_id text NOT NULL,reason text NOT NULL,created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(observation_id,intent_id) REFERENCES zzsh_order.legacy_refund_observation(id,intent_id)
);
CREATE TRIGGER legacy_refund_terminal_resolution_immutable BEFORE UPDATE OR DELETE ON zzsh_order.legacy_refund_terminal_resolution FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TABLE zzsh_order.legacy_refund_retry_authorization (
 id text PRIMARY KEY,case_id text NOT NULL REFERENCES zzsh_order.legacy_refund_case(id),previous_intent_id text NOT NULL UNIQUE REFERENCES zzsh_order.legacy_refund_intent(id),
 next_intent_id text NOT NULL UNIQUE,generation integer NOT NULL CHECK(generation>1),previous_evidence_id text NOT NULL REFERENCES zzsh_order.legacy_refund_terminal_evidence(id),
 previous_evidence_digest text NOT NULL CHECK(previous_evidence_digest~'^[a-f0-9]{64}$'),confirmed_refunded_cents numeric(24,0) NOT NULL CHECK(confirmed_refunded_cents>=0),
 actor_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),session_id text NOT NULL,request_id text NOT NULL,reason text NOT NULL,
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TRIGGER legacy_refund_retry_authorization_immutable BEFORE UPDATE OR DELETE ON zzsh_order.legacy_refund_retry_authorization FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
--> statement-breakpoint
ALTER TABLE zzsh_order.finance_event DROP CONSTRAINT finance_event_kind_check,
 ADD CONSTRAINT finance_event_kind_check CHECK(kind IN('OPENING','RESERVE','RELEASE','PAYOUT','EARNING_PENDING','EARNING_SETTLED','EARNING_REVOKED',
  'GUARANTEE_CAPTURE','GUARANTEE_REFUND','LEGACY_DUTY_SETTLED','REFUND_PAID','JOINPAY_WITHDRAWAL_RESERVED','JOINPAY_WITHDRAWAL_PAID',
  'JOINPAY_WITHDRAWAL_RELEASED','REFUND_LIABILITY_RECOGNIZED','LEGACY_REFUND_HISTORY_OFFSET','LEGACY_REFUND_PAID'));
DROP TRIGGER finance_entry_guard ON zzsh_order.settlement_ledger_entry;
CREATE TRIGGER finance_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId') AND NOT(NEW.details?'earningId') AND NOT(NEW.details?'guaranteeId')
  AND NOT(NEW.details?'legacyDutyId') AND NOT(NEW.details?'nativeRefundIntentId') AND NOT(NEW.details?'joinpayWithdrawalIntentId')
  AND NOT(NEW.details?'abnormalRefundLiabilityId') AND NOT(NEW.details?'prestartTerminationId') AND NOT(NEW.details?'localRefundIntentId')
  AND NOT(NEW.details?'legacyRefundCaseId') AND NOT(NEW.details?'legacyRefundIntentId')) EXECUTE FUNCTION zzsh_order.guard_finance_entry();
DROP TRIGGER finance_entry_batch_guard ON zzsh_order.settlement_ledger_entry;
CREATE CONSTRAINT TRIGGER finance_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId') AND NOT(NEW.details?'earningId') AND NOT(NEW.details?'guaranteeId')
  AND NOT(NEW.details?'legacyDutyId') AND NOT(NEW.details?'nativeRefundIntentId') AND NOT(NEW.details?'joinpayWithdrawalIntentId')
  AND NOT(NEW.details?'abnormalRefundLiabilityId') AND NOT(NEW.details?'prestartTerminationId') AND NOT(NEW.details?'localRefundIntentId')
  AND NOT(NEW.details?'legacyRefundCaseId') AND NOT(NEW.details?'legacyRefundIntentId')) EXECUTE FUNCTION zzsh_order.check_finance_batch();

--> statement-breakpoint
CREATE FUNCTION zzsh_order.guard_legacy_refund_case() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d zzsh_order.legacy_order_duty; f zzsh_order.legacy_duty_finance_fact; a zzsh_iam.audit_event; o zzsh_order.legacy_order_read_snapshot; key_value bigint; global_key bigint;
BEGIN
 SELECT * INTO d FROM zzsh_order.legacy_order_duty WHERE id=NEW.duty_id;
 SELECT * INTO f FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=NEW.duty_id;
 SELECT * INTO a FROM zzsh_iam.audit_event WHERE id=NEW.review_audit_id;
 SELECT * INTO o FROM zzsh_order.legacy_order_read_snapshot WHERE id=NEW.order_id;
 key_value:=hashtextextended(jsonb_build_array('zzsh:refund-order-no:v1',NEW.merchant_identity_id,NEW.original_payment_order_no)::text,0);
 global_key:=hashtextextended(jsonb_build_array('zzsh:legacy-original-order-no:v1',NEW.original_payment_order_no)::text,0);
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin'
  OR NEW.id IS DISTINCT FROM 'legacy_refund_case_'||substr(encode(sha256(convert_to(NEW.duty_id,'UTF8')),'hex'),1,40)
  OR NEW.history_event_id IS DISTINCT FROM (CASE WHEN NEW.prior_applied_cents=0 THEN NULL ELSE 'legacy_refund_history_'||substr(encode(sha256(convert_to(NEW.id,'UTF8')),'hex'),1,40) END)
  OR o.id IS NULL OR o.source_pay_status<>1 OR o.source_order_status NOT IN(3,8,9) OR o.renter_user_id IS DISTINCT FROM NEW.renter_user_id
  OR o.recorded_paid_amount_cents IS DISTINCT FROM NEW.paid_cents OR o.source_digest IS DISTINCT FROM NEW.source_digest
  OR f.duty_id IS NULL OR f.created_xid<>pg_current_xact_id() OR f.kind<>'RENTER_REFUND' OR f.actor_realm<>'admin'
  OR f.actor_id IS DISTINCT FROM current_setting('zzsh.actor_id',true) OR f.session_id IS DISTINCT FROM current_setting('zzsh.session_id',true)
  OR f.request_id IS DISTINCT FROM current_setting('zzsh.request_id',true) OR f.order_id IS DISTINCT FROM NEW.order_id
  OR f.subject_user_id IS DISTINCT FROM NEW.renter_user_id OR f.amount_cents IS DISTINCT FROM NEW.duty_cents
  OR f.parent_source_digest IS DISTINCT FROM NEW.source_digest OR f.facts_digest IS DISTINCT FROM NEW.duty_fact_digest
  OR d.status<>'SETTLED' OR d.settled_by<>'FINANCE' OR d.settled_ref_digest IS DISTINCT FROM f.facts_digest
  OR a.id IS NULL OR a.action<>'order.legacy.refund.reviewed' OR a.object_type<>'legacy_order_duty' OR a.object_id<>NEW.duty_id
  OR a.actor_type<>'admin' OR a.actor_id IS DISTINCT FROM f.actor_id OR a.session_id IS DISTINCT FROM f.session_id
  OR a.request_id IS DISTINCT FROM f.request_id OR a.outcome<>'SUCCESS'
  OR a.details->>'reviewDigest' IS DISTINCT FROM NEW.review_digest
  OR encode(sha256(convert_to(zzsh_order.canonical_finance_json(a.details-'reviewDigest'),'UTF8')),'hex') IS DISTINCT FROM NEW.review_digest
  OR a.details->>'orderId' IS DISTINCT FROM NEW.order_id OR a.details->>'dutyId' IS DISTINCT FROM NEW.duty_id
  OR a.details->>'dutyRevision' IS DISTINCT FROM f.duty_revision::text OR a.details->>'sourceDigest' IS DISTINCT FROM NEW.source_digest
  OR a.details->>'dutyEvidenceDigest' IS DISTINCT FROM f.effective_facts_digest
  OR a.details->>'headId' IS DISTINCT FROM f.effective_head_id OR a.details->>'headRevision' IS DISTINCT FROM f.effective_head_revision::text
  OR a.details->>'paymentRecordId' IS DISTINCT FROM NEW.original_payment_record_id OR a.details->>'paymentOrderNo' IS DISTINCT FROM NEW.original_payment_order_no
  OR a.details->>'merchantIdentityId' IS DISTINCT FROM NEW.merchant_identity_id OR a.details->>'merchantNo' IS DISTINCT FROM NEW.merchant_no
  OR a.details->>'paidCents' IS DISTINCT FROM NEW.paid_cents::text OR a.details->>'dutyCents' IS DISTINCT FROM NEW.duty_cents::text
  OR a.details->>'previouslyRefundedCents' IS DISTINCT FROM NEW.previously_refunded_cents::text
  OR a.details->>'priorAppliedToDutyCents' IS DISTINCT FROM NEW.prior_applied_cents::text OR a.details->>'refundCents' IS DISTINCT FROM NEW.new_refund_cents::text
  OR a.details->>'noUnresolvedRefunds' IS DISTINCT FROM 'true' OR a.details->>'source' IS DISTINCT FROM 'STAFF_REVIEW'
  OR a.details->>'channelResult' IS DISTINCT FROM 'NOT_SUBMITTED' OR a.reason IS DISTINCT FROM a.details->>'evidenceRef'
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_continuation_version v WHERE v.id=d.continuation_version_id AND v.order_id=d.order_id
    AND v.command='CONFIRM' AND v.refund_due_at=NEW.refund_due_at AND v.refund_due_at<=clock_timestamp())
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_continuation_evidence e WHERE e.order_id=NEW.order_id AND e.source_kind='SOURCE_IMPORT'
    AND e.source_digest=NEW.source_digest AND e.admission='PARAMETER_COMPLETE' AND jsonb_typeof(e.facts#>'{evidence,source,paidPay}')='array'
    AND jsonb_array_length(e.facts#>'{evidence,source,paidPay}')=1
    AND e.facts#>>'{evidence,source,paidPay,0,id}'=NEW.original_payment_record_id
    AND e.facts#>>'{evidence,source,paidPay,0,payOrderSn}'=NEW.original_payment_order_no
    AND (e.facts#>>'{evidence,source,paidPay,0,payMoney}')::numeric*100=NEW.paid_cents
    AND (e.facts#>>'{evidence,source,payMoney}')::numeric*100=NEW.paid_cents)
  OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND mode='ExclusiveLock'
    AND classid=((key_value>>32)&4294967295)::oid AND objid=(key_value&4294967295)::oid AND objsubid=1)
  OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND mode='ExclusiveLock'
    AND classid=((global_key>>32)&4294967295)::oid AND objid=(global_key&4294967295)::oid AND objsubid=1)
 THEN RAISE EXCEPTION 'legacy refund case requires the reviewed original duty and payment lock' USING ERRCODE='23514';END IF;
 IF EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation WHERE source='JOINPAY' AND merchant_order_no=NEW.original_payment_order_no)
  OR EXISTS(SELECT 1 FROM zzsh_order.payment_request WHERE channel='JOINPAY' AND channel_order_no=NEW.original_payment_order_no)
  OR EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent WHERE payment_source='JOINPAY' AND original_payment_order_no=NEW.original_payment_order_no)
  OR EXISTS(SELECT 1 FROM zzsh_order.legacy_continuation_evidence e CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(e.facts#>'{evidence,source,paidPay}')='array'
    THEN e.facts#>'{evidence,source,paidPay}' ELSE '[]'::jsonb END) p WHERE e.source_kind='SOURCE_IMPORT' AND e.order_id<>NEW.order_id
    AND (p->>'id'=NEW.original_payment_record_id OR p->>'payOrderSn'=NEW.original_payment_order_no))
  OR EXISTS(SELECT 1 FROM zzsh_order.personal_finance_observation p WHERE p.source_type='LEGACY_MYSQL' AND p.source_system='legacy_mysql_restore'
    AND p.source_entity='la_pay_order' AND p.source_kind='HISTORICAL_PAYMENT'
    AND (p.snapshot->>'sourceNumber'=NEW.original_payment_order_no AND p.source_id<>NEW.original_payment_record_id
      OR p.source_id=NEW.original_payment_record_id AND p.snapshot->>'sourceNumber' IS DISTINCT FROM NEW.original_payment_order_no))
 THEN RAISE EXCEPTION 'legacy refund original collides with native payment' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER legacy_refund_case_guard BEFORE INSERT ON zzsh_order.legacy_refund_case FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_refund_case();

CREATE FUNCTION zzsh_order.guard_legacy_refund_intent() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x zzsh_order.legacy_refund_case; a zzsh_iam.audit_event; p jsonb; admission jsonb; suffix text; proof zzsh_order.legacy_refund_terminal_evidence; origin zzsh_order.legacy_refund_observation; refund_key bigint; refund_global bigint; previous_intent zzsh_order.legacy_refund_intent; retry_auth zzsh_order.legacy_refund_retry_authorization;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'legacy refund requires READ COMMITTED' USING ERRCODE='25001';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['state','revision','lease_version','lease_owner','lease_until','claim_xid','updated_at','requires_review','budget_disposition',
    'terminal_evidence_id','terminal_event_id','provider_refund_trx_no','completed_at']) IS DISTINCT FROM
   (to_jsonb(OLD)-ARRAY['state','revision','lease_version','lease_owner','lease_until','claim_xid','updated_at','requires_review','budget_disposition',
    'terminal_evidence_id','terminal_event_id','provider_refund_trx_no','completed_at']) OR NEW.revision<>OLD.revision+1
  THEN RAISE EXCEPTION 'legacy refund original binding immutable' USING ERRCODE='40001';END IF;
  IF OLD.state IN('SUCCEEDED','FAILED') THEN
   IF OLD.requires_review AND NOT NEW.requires_review THEN
    IF (to_jsonb(NEW)-ARRAY['revision','requires_review','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['revision','requires_review','updated_at'])
     OR NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_terminal_resolution z WHERE z.intent_id=OLD.id AND z.terminal_evidence_id=OLD.terminal_evidence_id
      AND z.created_xid=pg_current_xact_id() AND z.actor_id=current_setting('zzsh.actor_id',true)
      AND z.session_id=current_setting('zzsh.session_id',true) AND z.request_id=current_setting('zzsh.request_id',true))
    THEN RAISE EXCEPTION 'legacy refund terminal resolution requires same-transaction evidence' USING ERRCODE='23514';END IF;
   ELSIF NEW.lease_version=OLD.lease_version+1 THEN
    IF NOT OLD.requires_review OR(to_jsonb(NEW)-ARRAY['revision','lease_version','lease_owner','lease_until','claim_xid','updated_at']) IS DISTINCT FROM
      (to_jsonb(OLD)-ARRAY['revision','lease_version','lease_owner','lease_until','claim_xid','updated_at'])
     OR (OLD.lease_until IS NOT NULL AND OLD.lease_until>clock_timestamp()) OR NEW.lease_owner IS NULL
     OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '3600 seconds' OR NEW.claim_xid IS DISTINCT FROM pg_current_xact_id()
    THEN RAISE EXCEPTION 'legacy refund terminal query lease unavailable' USING ERRCODE='40001';END IF;
   ELSE
    IF (to_jsonb(NEW)-ARRAY['revision','requires_review','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['revision','requires_review','updated_at'])
     OR OLD.requires_review OR NOT NEW.requires_review OR NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_observation z
       WHERE z.intent_id=OLD.id AND z.event='REVIEW' AND z.created_xid=pg_current_xact_id() AND z.state_before=OLD.state AND z.state_after=OLD.state)
    THEN RAISE EXCEPTION 'legacy refund terminal cannot change' USING ERRCODE='40001';END IF;
   END IF;
  ELSIF OLD.requires_review AND NOT NEW.requires_review THEN
   IF (to_jsonb(NEW)-ARRAY['state','revision','requires_review','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','revision','requires_review','updated_at'])
    OR NEW.state<>'UNKNOWN' OR OLD.terminal_evidence_id IS NOT NULL OR OLD.lease_until>clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_review_resolution z WHERE z.intent_id=OLD.id AND z.previous_revision=OLD.revision
      AND z.created_xid=pg_current_xact_id() AND z.actor_id=current_setting('zzsh.actor_id',true)
      AND z.session_id=current_setting('zzsh.session_id',true) AND z.request_id=current_setting('zzsh.request_id',true))
   THEN RAISE EXCEPTION 'legacy refund review requires authorized original-query recovery' USING ERRCODE='23514';END IF;
  ELSIF NOT OLD.requires_review AND NEW.requires_review THEN
   IF (to_jsonb(NEW)-ARRAY['revision','requires_review','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['revision','requires_review','updated_at'])
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_observation z WHERE z.intent_id=OLD.id AND z.event='REVIEW'
      AND z.created_xid=pg_current_xact_id() AND z.state_before=OLD.state AND z.state_after=OLD.state)
   THEN RAISE EXCEPTION 'legacy refund review needs a bound observation' USING ERRCODE='23514';END IF;
  ELSIF NEW.state IN('SUCCEEDED','FAILED') THEN
   SELECT * INTO proof FROM zzsh_order.legacy_refund_terminal_evidence WHERE id=NEW.terminal_evidence_id AND intent_id=OLD.id;
   SELECT * INTO origin FROM zzsh_order.legacy_refund_observation WHERE id=proof.observation_id;
   IF origin.operation='QUERY' AND(OLD.lease_version IS DISTINCT FROM origin.lease_version OR OLD.lease_owner IS DISTINCT FROM origin.lease_owner
    OR OLD.lease_until IS NULL OR OLD.lease_until<=clock_timestamp()) THEN
    RAISE EXCEPTION 'legacy refund terminal lease expired' USING ERRCODE='23514',CONSTRAINT='legacy_refund_live_lease';
   END IF;
   IF OLD.state NOT IN('SUBMITTING','UNKNOWN','PROCESSING') OR OLD.requires_review OR NEW.requires_review OR proof.id IS NULL
    OR proof.created_xid<>pg_current_xact_id() OR NEW.state IS DISTINCT FROM (CASE proof.terminal WHEN 'SUCCEEDED' THEN 'SUCCEEDED' ELSE 'FAILED' END)
    OR NEW.budget_disposition IS DISTINCT FROM (CASE proof.terminal WHEN 'SUCCEEDED' THEN 'CONSUMED' ELSE 'RELEASED' END)
    OR NEW.terminal_event_id IS DISTINCT FROM proof.finance_event_id
    OR NEW.provider_refund_trx_no IS DISTINCT FROM proof.refund_transaction_no OR NEW.completed_at IS DISTINCT FROM proof.completed_at
    OR NEW.lease_version<>OLD.lease_version OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
    OR NEW.claim_xid IS DISTINCT FROM OLD.claim_xid
   THEN RAISE EXCEPTION 'legacy refund terminal requires same-transaction channel evidence' USING ERRCODE='23514';END IF;
  ELSIF NEW.lease_version=OLD.lease_version+1 THEN
   SELECT * INTO x FROM zzsh_order.legacy_refund_case WHERE id=OLD.case_id;
   IF x.id IS NULL OR x.refund_due_at>clock_timestamp() OR(OLD.state='READY' AND OLD.requires_review)
    OR NEW.requires_review IS DISTINCT FROM OLD.requires_review OR(OLD.lease_until IS NOT NULL AND OLD.lease_until>clock_timestamp())
    OR NEW.lease_owner IS NULL OR NEW.lease_until<=clock_timestamp() OR NEW.lease_until>clock_timestamp()+interval '3600 seconds'
    OR NEW.state IS DISTINCT FROM (CASE WHEN OLD.state='READY' THEN 'SUBMITTING' ELSE 'UNKNOWN' END)
    OR NEW.claim_xid IS DISTINCT FROM pg_current_xact_id() OR NEW.budget_disposition<>'ALLOCATED'
   THEN RAISE EXCEPTION 'legacy refund lease not claimable' USING ERRCODE='40001';END IF;
  ELSE
   IF NEW.lease_version<>OLD.lease_version OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
    OR NEW.claim_xid IS DISTINCT FROM OLD.claim_xid OR NEW.requires_review IS DISTINCT FROM OLD.requires_review OR NEW.budget_disposition<>'ALLOCATED'
    OR NEW.state NOT IN('UNKNOWN','PROCESSING') OR NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_observation z WHERE z.intent_id=OLD.id
      AND z.created_xid=pg_current_xact_id() AND z.state_before=OLD.state AND z.state_after=NEW.state AND z.event IN('UNKNOWN','PROCESSING')
      AND(z.operation='NOTIFY' OR(z.lease_version=OLD.lease_version AND z.lease_owner=OLD.lease_owner AND OLD.lease_until>clock_timestamp())))
   THEN RAISE EXCEPTION 'legacy refund update lacks live evidence' USING ERRCODE='40001';END IF;
  END IF;
  NEW.updated_at:=clock_timestamp();RETURN NEW;
 END IF;
 SELECT * INTO x FROM zzsh_order.legacy_refund_case WHERE id=NEW.case_id;
 SELECT * INTO a FROM zzsh_iam.audit_event WHERE id=x.review_audit_id;
 p:=NEW.initial_profile_canonical::jsonb;admission:=NEW.initial_admission_canonical::jsonb;
 suffix:=encode(sha256(convert_to(NEW.case_id||CASE WHEN NEW.generation=1 THEN '' ELSE ':retry:'||NEW.generation::text END,'UTF8')),'hex');
 IF NEW.generation>1 THEN
  SELECT * INTO previous_intent FROM zzsh_order.legacy_refund_intent WHERE id=NEW.retry_of_id AND case_id=NEW.case_id;
  SELECT * INTO proof FROM zzsh_order.legacy_refund_terminal_evidence WHERE id=previous_intent.terminal_evidence_id AND intent_id=previous_intent.id;
  SELECT * INTO retry_auth FROM zzsh_order.legacy_refund_retry_authorization WHERE previous_intent_id=previous_intent.id AND next_intent_id=NEW.id;
 END IF;
 refund_key:=hashtextextended(jsonb_build_array('zzsh:refund-order-no:v1',x.merchant_identity_id,NEW.refund_order_no)::text,0);
 refund_global:=hashtextextended(jsonb_build_array('zzsh:legacy-original-order-no:v1',NEW.refund_order_no)::text,0);
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  OR x.id IS NULL OR x.new_refund_cents<=0 OR NEW.amount_cents<>x.new_refund_cents
  OR (NEW.generation=1 AND(x.created_xid<>pg_current_xact_id() OR NEW.retry_of_id IS NOT NULL))
  OR (NEW.generation>1 AND(previous_intent.id IS NULL OR previous_intent.generation<>NEW.generation-1 OR previous_intent.state<>'FAILED'
    OR previous_intent.budget_disposition<>'RELEASED' OR previous_intent.requires_review OR proof.terminal IS DISTINCT FROM 'FAILED_NO_EXECUTION'
    OR retry_auth.id IS NULL OR retry_auth.created_xid<>pg_current_xact_id() OR retry_auth.case_id IS DISTINCT FROM x.id
    OR retry_auth.generation<>NEW.generation OR retry_auth.previous_evidence_id IS DISTINCT FROM proof.id
    OR retry_auth.previous_evidence_digest IS DISTINCT FROM proof.facts_digest OR retry_auth.confirmed_refunded_cents IS DISTINCT FROM x.previously_refunded_cents
    OR retry_auth.actor_id IS DISTINCT FROM current_setting('zzsh.actor_id',true) OR retry_auth.session_id IS DISTINCT FROM current_setting('zzsh.session_id',true)
    OR retry_auth.request_id IS DISTINCT FROM current_setting('zzsh.request_id',true)))
  OR NEW.id IS DISTINCT FROM 'legacy_refund_intent_'||substr(suffix,1,40) OR NEW.refund_order_no IS DISTINCT FROM 'LR'||substr(suffix,1,28)
  OR NEW.initial_admission_ref IS DISTINCT FROM a.details->>'admissionRef' OR NEW.initial_admission_sha256 IS DISTINCT FROM a.details->>'admissionSha256'
  OR NEW.initial_admission_canonical IS DISTINCT FROM a.details->>'admissionCanonical' OR NEW.initial_profile_id IS DISTINCT FROM a.details->>'profileId'
  OR NEW.initial_profile_sha256 IS DISTINCT FROM a.details->>'profileSha256' OR NEW.initial_profile_canonical IS DISTINCT FROM a.details->>'profileCanonical'
  OR NEW.initial_key_version_ref IS DISTINCT FROM a.details->>'keyVersionRef' OR NEW.notify_url IS DISTINCT FROM a.details->>'notifyUrl'
  OR NEW.funds_account IS DISTINCT FROM a.details->>'fundsAccount'
  OR p->>'kind' IS DISTINCT FROM 'JOINPAY_REFUND_PROFILE_V1' OR p->>'operation' IS DISTINCT FROM 'SUBMIT' OR p->>'purpose' IS DISTINCT FROM 'MERCHANT_REFUND'
  OR p->>'merchantIdentityId' IS DISTINCT FROM x.merchant_identity_id OR p->>'merchantNo' IS DISTINCT FROM x.merchant_no
  OR p->>'profileId' IS DISTINCT FROM NEW.initial_profile_id OR p->>'keyVersionRef' IS DISTINCT FROM NEW.initial_key_version_ref
  OR p->>'notifyUrl' IS DISTINCT FROM NEW.notify_url OR p->>'fundsAccount' IS DISTINCT FROM NEW.funds_account
  OR admission->>'kind' IS DISTINCT FROM 'FORMAL_NATIVE_REFUND_SERVER_REVIEW' OR admission->>'reference' IS DISTINCT FROM NEW.initial_admission_ref
  OR admission->>'merchantIdentityId' IS DISTINCT FROM x.merchant_identity_id OR admission->>'merchantNo' IS DISTINCT FROM x.merchant_no
  OR admission->>'database' IS DISTINCT FROM current_database() OR p->>'database' IS DISTINCT FROM current_database()
  OR admission->>'runtimeUser' IS DISTINCT FROM COALESCE(NULLIF(current_setting('role',true),'none'),session_user)
  OR p->>'runtimeUser' IS DISTINCT FROM COALESCE(NULLIF(current_setting('role',true),'none'),session_user)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(admission->'acceptedProfiles') item WHERE item->>'operation'='SUBMIT'
    AND item->>'profileId'=NEW.initial_profile_id AND item->>'profileSha256'=NEW.initial_profile_sha256 AND item->>'keyVersionRef'=NEW.initial_key_version_ref)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(admission->'acceptedProfiles') item WHERE item->>'operation'='QUERY')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(admission->'acceptedProfiles') item WHERE item->>'operation'='NOTIFY')
  OR NEW.state<>'READY' OR NEW.revision<>1 OR NEW.lease_version<>0 OR NEW.lease_owner IS NOT NULL OR NEW.claim_xid IS NOT NULL OR NEW.requires_review OR NEW.budget_disposition<>'ALLOCATED'
  OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND mode='ExclusiveLock'
    AND classid=((refund_key>>32)&4294967295)::oid AND objid=(refund_key&4294967295)::oid AND objsubid=1)
  OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND mode='ExclusiveLock'
    AND classid=((refund_global>>32)&4294967295)::oid AND objid=(refund_global&4294967295)::oid AND objsubid=1)
  OR EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent WHERE payment_source='JOINPAY'
    AND refund_order_no=NEW.refund_order_no)
  OR EXISTS(SELECT 1 FROM zzsh_order.payment_request WHERE channel='JOINPAY' AND channel_order_no=NEW.refund_order_no)
  OR EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation WHERE source='JOINPAY' AND merchant_order_no=NEW.refund_order_no)
  OR EXISTS(SELECT 1 FROM zzsh_order.legacy_continuation_evidence e WHERE e.source_kind='SOURCE_IMPORT'
    AND e.facts #> '{evidence,source,paidPay}' @> jsonb_build_array(jsonb_build_object('payOrderSn',NEW.refund_order_no)))
  OR EXISTS(SELECT 1 FROM zzsh_order.personal_finance_observation WHERE source_kind='HISTORICAL_PAYMENT' AND source_system='legacy_mysql_restore'
    AND source_entity='la_pay_order' AND snapshot->>'sourceNumber'=NEW.refund_order_no)
  OR EXISTS(SELECT 1 FROM zzsh_order.personal_finance_observation WHERE source_kind='HISTORICAL_REFUND' AND source_system='legacy_mysql_restore'
    AND source_entity='la_refund_record' AND snapshot->>'sourceNumber'=NEW.refund_order_no)
 THEN RAISE EXCEPTION 'legacy refund original intent is not uniquely bound' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER legacy_refund_intent_guard BEFORE INSERT OR UPDATE ON zzsh_order.legacy_refund_intent FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_refund_intent();

--> statement-breakpoint
CREATE FUNCTION zzsh_order.assert_legacy_refund_operator(order_value text) RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE o zzsh_order.legacy_order_read_snapshot;actor_value text:=current_setting('zzsh.actor_id',true);
 session_value text:=current_setting('zzsh.session_id',true);boss boolean;
BEGIN
 SELECT * INTO o FROM zzsh_order.legacy_order_read_snapshot WHERE id=order_value;
 IF o.id IS NULL OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin' THEN RAISE EXCEPTION 'legacy refund operator unavailable' USING ERRCODE='42501';END IF;
 SELECT sec.is_boss INTO boss FROM zzsh_iam.admin_security sec JOIN zzsh_auth_admin."user" u ON u.id=sec.admin_user_id
  JOIN zzsh_auth_admin."session" s ON s."userId"=u.id AND s.id=session_value
  WHERE sec.admin_user_id=actor_value AND sec.status='ACTIVE' AND NOT sec.password_change_required AND NOT u.suspended
   AND u."twoFactorEnabled" IS TRUE AND NOT s.locked AND s."expiresAt">clock_timestamp() FOR SHARE OF sec,u,s;
 IF boss IS NULL THEN RAISE EXCEPTION 'legacy refund review session unavailable' USING ERRCODE='42501';END IF;
 IF NOT boss AND (EXISTS(SELECT 1 FROM (VALUES('order.read'),('order.legacy.continue'),('order.settlement.write')) required(code)
   WHERE EXISTS(SELECT 1 FROM zzsh_iam.admin_user_permission deny WHERE deny.admin_user_id=actor_value AND deny.permission_code=required.code AND deny.effect='DENY')
    OR NOT(EXISTS(SELECT 1 FROM zzsh_iam.admin_user_permission allow WHERE allow.admin_user_id=actor_value AND allow.permission_code=required.code AND allow.effect='ALLOW')
      OR EXISTS(SELECT 1 FROM zzsh_iam.admin_user_role ur JOIN zzsh_iam.admin_role role ON role.id=ur.role_id AND role.status='ACTIVE'
       JOIN zzsh_iam.admin_role_permission rp ON rp.role_id=role.id WHERE ur.admin_user_id=actor_value AND rp.permission_code=required.code)))
   OR NOT EXISTS(SELECT 1 FROM zzsh_iam.admin_security sec WHERE sec.admin_user_id=actor_value AND (sec.game_scope_mode='ALL_GAMES'
    OR EXISTS(SELECT 1 FROM zzsh_supply.admin_supply_scope scope WHERE scope.admin_user_id=actor_value AND scope.game_id=o.game_id))))
 THEN RAISE EXCEPTION 'legacy refund review permission unavailable' USING ERRCODE='42501';END IF;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.assert_legacy_refund_operator(text) FROM PUBLIC;

--> statement-breakpoint
CREATE FUNCTION zzsh_order.resume_legacy_refund_review(intent_value text,reason_text text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i zzsh_order.legacy_refund_intent; x zzsh_order.legacy_refund_case;
 actor_value text:=current_setting('zzsh.actor_id',true);session_value text:=current_setting('zzsh.session_id',true);
 request_value text:=current_setting('zzsh.request_id',true);resolution_value text;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin'
  OR COALESCE(length(actor_value),0)=0 OR COALESCE(length(session_value),0)=0 OR COALESCE(length(request_value),0)=0
  OR length(request_value)>128 OR reason_text IS NULL OR length(trim(reason_text)) NOT BETWEEN 3 AND 200 OR reason_text~'[[:cntrl:]]'
 THEN RAISE EXCEPTION 'legacy refund review identity or reason unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO i FROM zzsh_order.legacy_refund_intent WHERE id=intent_value;
 SELECT * INTO x FROM zzsh_order.legacy_refund_case WHERE id=i.case_id;
 IF i.id IS NULL OR x.id IS NULL THEN RAISE EXCEPTION 'legacy refund review unavailable' USING ERRCODE='23514';END IF;
 PERFORM zzsh_order.assert_legacy_refund_operator(x.order_id);
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-order-no:v1',x.merchant_identity_id,x.original_payment_order_no)::text,0));
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:legacy-original-order-no:v1',x.original_payment_order_no)::text,0));
 PERFORM id FROM zzsh_auth_user."user" WHERE id=x.renter_user_id FOR UPDATE;
 SELECT * INTO i FROM zzsh_order.legacy_refund_intent WHERE id=intent_value FOR UPDATE;
 IF NOT i.requires_review THEN
  SELECT id INTO resolution_value FROM zzsh_order.legacy_refund_review_resolution WHERE intent_id=i.id ORDER BY created_at DESC,id DESC LIMIT 1;
  IF resolution_value IS NULL THEN RAISE EXCEPTION 'legacy refund has no review to resume' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('intentId',i.id,'resumed',false,'state',i.state,'resolutionId',resolution_value);
 END IF;
 IF i.terminal_evidence_id IS NOT NULL OR i.state IN('SUCCEEDED','FAILED') OR i.budget_disposition<>'ALLOCATED'
  OR i.lease_until IS NULL OR i.lease_until>clock_timestamp() OR NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_attempt WHERE intent_id=i.id AND operation='SUBMIT')
 THEN RAISE EXCEPTION 'legacy refund original query cannot resume' USING ERRCODE='23514';END IF;
 resolution_value:='legacy_refund_review_'||replace(gen_random_uuid()::text,'-','');
 INSERT INTO zzsh_order.legacy_refund_review_resolution(id,intent_id,previous_revision,actor_id,session_id,request_id,reason)
  VALUES(resolution_value,i.id,i.revision,actor_value,session_value,request_value,trim(reason_text));
 UPDATE zzsh_order.legacy_refund_intent SET state='UNKNOWN',requires_review=false,revision=revision+1 WHERE id=i.id AND revision=i.revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'legacy refund review changed' USING ERRCODE='40001';END IF;
 INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,reason,occurred_at,details)
  VALUES('audit_'||replace(gen_random_uuid()::text,'-',''),'admin',actor_value,session_value,'order.legacy.refund.review_resumed',
   'legacy_refund_intent',i.id,'SUCCESS',request_value,trim(reason_text),clock_timestamp(),
   jsonb_build_object('orderId',x.order_id,'resolutionId',resolution_value,'refundOrderNo',i.refund_order_no,'firstDispatchAllowed',false));
 RETURN jsonb_build_object('intentId',i.id,'resumed',true,'state','UNKNOWN','resolutionId',resolution_value);
END $$;
REVOKE ALL ON FUNCTION zzsh_order.resume_legacy_refund_review(text,text) FROM PUBLIC;

--> statement-breakpoint
CREATE FUNCTION zzsh_order.resolve_legacy_refund_terminal(intent_value text,observation_value text,reason_text text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE i zzsh_order.legacy_refund_intent;x zzsh_order.legacy_refund_case;proof zzsh_order.legacy_refund_terminal_evidence;
 observation zzsh_order.legacy_refund_observation;actor_value text:=current_setting('zzsh.actor_id',true);
 session_value text:=current_setting('zzsh.session_id',true);request_value text:=current_setting('zzsh.request_id',true);resolution_value text;lock_no text;trx_key bigint;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin'
  OR COALESCE(length(actor_value),0)=0 OR COALESCE(length(session_value),0)=0 OR COALESCE(length(request_value),0)=0 OR length(request_value)>128
  OR reason_text IS NULL OR length(trim(reason_text)) NOT BETWEEN 3 AND 200 OR reason_text~'[[:cntrl:]]'
 THEN RAISE EXCEPTION 'legacy refund terminal review identity unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO i FROM zzsh_order.legacy_refund_intent WHERE id=intent_value;
 SELECT * INTO x FROM zzsh_order.legacy_refund_case WHERE id=i.case_id;
 IF i.id IS NULL OR x.id IS NULL THEN RAISE EXCEPTION 'legacy refund terminal unavailable' USING ERRCODE='23514';END IF;
 PERFORM zzsh_order.assert_legacy_refund_operator(x.order_id);
 FOR lock_no IN SELECT DISTINCT n COLLATE "C" FROM unnest(ARRAY[x.original_payment_order_no]||
   ARRAY(SELECT refund_order_no FROM zzsh_order.legacy_refund_intent WHERE case_id=x.id)) n ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-order-no:v1',x.merchant_identity_id,lock_no)::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:legacy-original-order-no:v1',lock_no)::text,0));
 END LOOP;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=x.renter_user_id FOR UPDATE;
 SELECT * INTO i FROM zzsh_order.legacy_refund_intent WHERE id=intent_value FOR UPDATE;
 SELECT * INTO proof FROM zzsh_order.legacy_refund_terminal_evidence WHERE id=i.terminal_evidence_id AND intent_id=i.id;
 SELECT * INTO observation FROM zzsh_order.legacy_refund_observation WHERE id=observation_value AND intent_id=i.id;
 IF i.state NOT IN('SUCCEEDED','FAILED') OR NOT i.requires_review OR proof.id IS NULL OR observation.id IS NULL
  OR observation.created_xid<>pg_current_xact_id() OR observation.operation<>'QUERY' OR observation.event<>'REVIEW'
  OR observation.evidence_level<>'PROVIDER_RESPONSE' OR NOT observation.response_complete OR observation.http_status IS DISTINCT FROM 200
  OR observation.transport_failure IS NOT NULL OR observation.signature_status<>'MATCH' OR observation.binding_status<>'MATCH' OR observation.schema_status<>'VALID'
  OR observation.lease_version IS DISTINCT FROM i.lease_version OR observation.lease_owner IS DISTINCT FROM i.lease_owner
  OR i.lease_until IS NULL OR i.lease_until<=clock_timestamp() OR observation.state_before IS DISTINCT FROM i.state OR observation.state_after IS DISTINCT FROM i.state
 THEN RAISE EXCEPTION 'legacy refund terminal review evidence unavailable' USING ERRCODE='23514';END IF;
 IF proof.refund_transaction_no IS NOT NULL THEN
  trx_key:=hashtextextended(jsonb_build_array('zzsh:refund-merchant-trx:v1',x.merchant_no,proof.refund_transaction_no)::text,0);
  IF NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND mode='ExclusiveLock'
   AND classid=((trx_key>>32)&4294967295)::oid AND objid=(trx_key&4294967295)::oid AND objsubid=1)
  THEN RAISE EXCEPTION 'legacy refund terminal review transaction lock unavailable' USING ERRCODE='23514';END IF;
 END IF;
 resolution_value:='legacy_refund_terminal_review_'||replace(gen_random_uuid()::text,'-','');
 INSERT INTO zzsh_order.legacy_refund_terminal_resolution(id,intent_id,observation_id,terminal_evidence_id,actor_id,session_id,request_id,reason)
  VALUES(resolution_value,i.id,observation.id,proof.id,actor_value,session_value,request_value,trim(reason_text));
 UPDATE zzsh_order.legacy_refund_intent SET requires_review=false,revision=revision+1 WHERE id=i.id AND revision=i.revision AND requires_review;
 IF NOT FOUND THEN RAISE EXCEPTION 'legacy refund terminal review changed' USING ERRCODE='40001';END IF;
 INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,reason,occurred_at,details)
  VALUES('audit_'||replace(gen_random_uuid()::text,'-',''),'admin',actor_value,session_value,'order.legacy.refund.terminal_review_resolved',
   'legacy_refund_intent',i.id,'SUCCESS',request_value,trim(reason_text),clock_timestamp(),
   jsonb_build_object('orderId',x.order_id,'resolutionId',resolution_value,'observationId',observation.id,'terminalEvidenceId',proof.id,'financialChange',false));
 RETURN jsonb_build_object('intentId',i.id,'resolved',true,'state',i.state,'resolutionId',resolution_value);
END $$;
REVOKE ALL ON FUNCTION zzsh_order.resolve_legacy_refund_terminal(text,text,text) FROM PUBLIC;

--> statement-breakpoint
CREATE FUNCTION zzsh_order.retry_legacy_refund(previous_value text,confirmed_refunded_text text,reason_text text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE old_intent zzsh_order.legacy_refund_intent; next_intent zzsh_order.legacy_refund_intent; x zzsh_order.legacy_refund_case;
 proof zzsh_order.legacy_refund_terminal_evidence; actor_value text:=current_setting('zzsh.actor_id',true);
 session_value text:=current_setting('zzsh.session_id',true);request_value text:=current_setting('zzsh.request_id',true);
 next_generation integer;suffix text;next_id text;refund_no text;auth_value text;lock_no text;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin'
  OR COALESCE(length(actor_value),0)=0 OR COALESCE(length(session_value),0)=0 OR COALESCE(length(request_value),0)=0 OR length(request_value)>128
  OR reason_text IS NULL OR length(trim(reason_text)) NOT BETWEEN 3 AND 200 OR reason_text~'[[:cntrl:]]'
  OR confirmed_refunded_text IS NULL OR confirmed_refunded_text!~'^(0|[1-9][0-9]{0,23})$'
 THEN RAISE EXCEPTION 'legacy refund retry identity or review unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO old_intent FROM zzsh_order.legacy_refund_intent WHERE id=previous_value;
 SELECT * INTO x FROM zzsh_order.legacy_refund_case WHERE id=old_intent.case_id;
 IF old_intent.id IS NULL OR x.id IS NULL OR old_intent.generation=2147483647 THEN RAISE EXCEPTION 'legacy refund retry unavailable' USING ERRCODE='23514';END IF;
 PERFORM zzsh_order.assert_legacy_refund_operator(x.order_id);
 next_generation:=old_intent.generation+1;suffix:=encode(sha256(convert_to(x.id||':retry:'||next_generation::text,'UTF8')),'hex');
 next_id:='legacy_refund_intent_'||substr(suffix,1,40);refund_no:='LR'||substr(suffix,1,28);
 FOR lock_no IN SELECT DISTINCT n COLLATE "C" FROM unnest(ARRAY[x.original_payment_order_no,old_intent.refund_order_no,refund_no]) n ORDER BY 1 LOOP
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-order-no:v1',x.merchant_identity_id,lock_no)::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:legacy-original-order-no:v1',lock_no)::text,0));
 END LOOP;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=x.renter_user_id FOR UPDATE;
 SELECT * INTO old_intent FROM zzsh_order.legacy_refund_intent WHERE id=previous_value FOR UPDATE;
 SELECT * INTO proof FROM zzsh_order.legacy_refund_terminal_evidence WHERE id=old_intent.terminal_evidence_id AND intent_id=old_intent.id;
 IF old_intent.state<>'FAILED' OR old_intent.budget_disposition<>'RELEASED' OR old_intent.requires_review
  OR proof.id IS NULL OR proof.terminal<>'FAILED_NO_EXECUTION' OR confirmed_refunded_text::numeric<>x.previously_refunded_cents
  OR EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_intent WHERE case_id=x.id AND requires_review)
 THEN RAISE EXCEPTION 'legacy refund retry needs confirmed no-execution and unchanged original refund total' USING ERRCODE='23514';END IF;
 SELECT * INTO next_intent FROM zzsh_order.legacy_refund_intent WHERE retry_of_id=old_intent.id;
 IF next_intent.id IS NOT NULL THEN
  IF next_intent.id<>next_id OR next_intent.generation<>next_generation OR next_intent.case_id<>x.id OR next_intent.amount_cents<>x.new_refund_cents
  THEN RAISE EXCEPTION 'legacy refund retry chain changed' USING ERRCODE='23514';END IF;
  RETURN jsonb_build_object('intentId',next_intent.id,'refundOrderNo',next_intent.refund_order_no,'state',next_intent.state,'created',false);
 END IF;
 IF EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_intent WHERE case_id=x.id AND(generation>old_intent.generation OR budget_disposition<>'RELEASED'))
 THEN RAISE EXCEPTION 'legacy refund retry already allocated' USING ERRCODE='23514';END IF;
 auth_value:='legacy_refund_retry_'||replace(gen_random_uuid()::text,'-','');
 INSERT INTO zzsh_order.legacy_refund_retry_authorization(id,case_id,previous_intent_id,next_intent_id,generation,previous_evidence_id,previous_evidence_digest,
  confirmed_refunded_cents,actor_id,session_id,request_id,reason)
 VALUES(auth_value,x.id,old_intent.id,next_id,next_generation,proof.id,proof.facts_digest,confirmed_refunded_text::numeric,actor_value,session_value,request_value,trim(reason_text));
 INSERT INTO zzsh_order.legacy_refund_intent(id,case_id,generation,retry_of_id,refund_order_no,amount_cents,initial_admission_ref,initial_admission_sha256,
  initial_admission_canonical,initial_profile_id,initial_profile_sha256,initial_profile_canonical,initial_key_version_ref,notify_url,funds_account)
 VALUES(next_id,x.id,next_generation,old_intent.id,refund_no,x.new_refund_cents,old_intent.initial_admission_ref,old_intent.initial_admission_sha256,
  old_intent.initial_admission_canonical,old_intent.initial_profile_id,old_intent.initial_profile_sha256,old_intent.initial_profile_canonical,
  old_intent.initial_key_version_ref,old_intent.notify_url,old_intent.funds_account);
 INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,reason,occurred_at,details)
 VALUES('audit_'||replace(gen_random_uuid()::text,'-',''),'admin',actor_value,session_value,'order.legacy.refund.retry_created','legacy_refund_intent',next_id,
  'SUCCESS',request_value,trim(reason_text),clock_timestamp(),jsonb_build_object('orderId',x.order_id,'previousIntentId',old_intent.id,
   'previousEvidenceDigest',proof.facts_digest,'retryAuthorizationId',auth_value,'refundOrderNo',refund_no,'channelResultAtCreation','NOT_SUBMITTED'));
 RETURN jsonb_build_object('intentId',next_id,'refundOrderNo',refund_no,'state','READY','created',true);
END $$;
REVOKE ALL ON FUNCTION zzsh_order.retry_legacy_refund(text,text,text) FROM PUBLIC;

--> statement-breakpoint
CREATE FUNCTION zzsh_order.guard_legacy_refund_attempt() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.legacy_refund_intent; x zzsh_order.legacy_refund_case; p jsonb; key_value bigint; global_key bigint;
BEGIN
 SELECT * INTO i FROM zzsh_order.legacy_refund_intent WHERE id=NEW.intent_id FOR UPDATE;
 SELECT * INTO x FROM zzsh_order.legacy_refund_case WHERE id=i.case_id;
 p:=NEW.profile_canonical::jsonb;
 key_value:=hashtextextended(jsonb_build_array('zzsh:refund-order-no:v1',x.merchant_identity_id,x.original_payment_order_no)::text,0);
 global_key:=hashtextextended(jsonb_build_array('zzsh:legacy-original-order-no:v1',x.original_payment_order_no)::text,0);
 IF i.id IS NULL OR x.id IS NULL OR i.claim_xid<>pg_current_xact_id() OR i.lease_version<>NEW.lease_version OR i.lease_owner IS DISTINCT FROM NEW.lease_owner
  OR EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_intent prior WHERE prior.case_id=i.case_id AND prior.generation<i.generation AND prior.requires_review)
  OR i.lease_until IS NULL OR i.lease_until<=clock_timestamp() OR(i.budget_disposition<>'ALLOCATED'
    AND NOT(NEW.operation='QUERY' AND i.state IN('SUCCEEDED','FAILED') AND i.requires_review))
  OR NEW.operation IS DISTINCT FROM (CASE WHEN i.lease_version=1 AND i.state='SUBMITTING' THEN 'SUBMIT' ELSE 'QUERY' END)
  OR (NEW.operation='SUBMIT' AND(i.requires_review OR NEW.profile_id<>i.initial_profile_id OR NEW.profile_sha256<>i.initial_profile_sha256
    OR NEW.key_version_ref<>i.initial_key_version_ref OR NEW.admission_sha256<>i.initial_admission_sha256))
  OR (NEW.operation='QUERY' AND NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_attempt prior_attempt WHERE prior_attempt.intent_id=i.id AND prior_attempt.operation='SUBMIT'))
  OR p->>'kind' IS DISTINCT FROM 'JOINPAY_REFUND_PROFILE_V1' OR p->>'operation' IS DISTINCT FROM NEW.operation OR p->>'purpose' IS DISTINCT FROM 'MERCHANT_REFUND'
  OR p->>'database' IS DISTINCT FROM current_database() OR p->>'runtimeUser' IS DISTINCT FROM current_user
  OR p->>'profileId' IS DISTINCT FROM NEW.profile_id OR p->>'keyVersionRef' IS DISTINCT FROM NEW.key_version_ref
  OR p->>'merchantIdentityId' IS DISTINCT FROM x.merchant_identity_id OR p->>'merchantNo' IS DISTINCT FROM x.merchant_no
  OR octet_length(NEW.request_body)>65536 OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory'
    AND granted AND mode='ExclusiveLock' AND classid=((key_value>>32)&4294967295)::oid AND objid=(key_value&4294967295)::oid AND objsubid=1)
  OR NOT EXISTS(SELECT 1 FROM pg_locks WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted AND mode='ExclusiveLock'
    AND classid=((global_key>>32)&4294967295)::oid AND objid=(global_key&4294967295)::oid AND objsubid=1)
 THEN RAISE EXCEPTION 'legacy refund attempt is not bound to its live original lease' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER legacy_refund_attempt_guard BEFORE INSERT ON zzsh_order.legacy_refund_attempt FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_refund_attempt();

CREATE FUNCTION zzsh_order.guard_legacy_refund_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.legacy_refund_intent; x zzsh_order.legacy_refund_case; a zzsh_order.legacy_refund_attempt; p jsonb; live boolean;
BEGIN
 SELECT * INTO i FROM zzsh_order.legacy_refund_intent WHERE id=NEW.intent_id FOR UPDATE;
 SELECT * INTO x FROM zzsh_order.legacy_refund_case WHERE id=i.case_id;
 SELECT * INTO a FROM zzsh_order.legacy_refund_attempt WHERE id=NEW.attempt_id AND intent_id=NEW.intent_id;
 p:=NEW.profile_canonical::jsonb;live:=NEW.operation='NOTIFY' OR(i.lease_version=NEW.lease_version AND i.lease_owner=NEW.lease_owner AND i.lease_until>clock_timestamp());
 IF NEW.event<>'STALE' AND live IS NOT TRUE THEN
  RAISE EXCEPTION 'legacy refund observation lease expired' USING ERRCODE='23514',CONSTRAINT='legacy_refund_live_lease';
 END IF;
 IF i.id IS NULL OR x.id IS NULL OR NEW.state_before IS DISTINCT FROM i.state OR NEW.state_after NOT IN('SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED','SUCCEEDED','FAILED')
  OR p->>'kind' IS DISTINCT FROM 'JOINPAY_REFUND_PROFILE_V1' OR p->>'operation' IS DISTINCT FROM NEW.operation OR p->>'purpose' IS DISTINCT FROM 'MERCHANT_REFUND'
  OR p->>'database' IS DISTINCT FROM current_database() OR p->>'runtimeUser' IS DISTINCT FROM current_user
  OR p->>'profileId' IS DISTINCT FROM NEW.profile_id OR p->>'keyVersionRef' IS DISTINCT FROM NEW.key_version_ref
  OR p->>'merchantIdentityId' IS DISTINCT FROM x.merchant_identity_id OR p->>'merchantNo' IS DISTINCT FROM x.merchant_no
  OR NEW.operation<>'NOTIFY' AND(a.id IS NULL OR a.operation IS DISTINCT FROM NEW.operation OR a.lease_version IS DISTINCT FROM NEW.lease_version
    OR a.lease_owner IS DISTINCT FROM NEW.lease_owner OR a.profile_id IS DISTINCT FROM NEW.profile_id OR a.profile_sha256 IS DISTINCT FROM NEW.profile_sha256
    OR a.key_version_ref IS DISTINCT FROM NEW.key_version_ref)
  OR NEW.event='STALE' AND(live OR NEW.state_after IS DISTINCT FROM NEW.state_before)
  OR NEW.event='PENDING_TERMINAL' AND(NEW.operation='SUBMIT' OR NEW.evidence_level<>'PROVIDER_RESPONSE' OR NOT NEW.response_complete
    OR NEW.transport_failure IS NOT NULL OR NEW.schema_status<>'VALID' OR NEW.signature_status<>'MATCH' OR NEW.binding_status<>'MATCH'
    OR NEW.state_after IS DISTINCT FROM NEW.state_before)
  OR NEW.event='REVIEW' AND NEW.state_after IS DISTINCT FROM NEW.state_before
 THEN RAISE EXCEPTION 'legacy refund observation is not bound to its original attempt' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER legacy_refund_observation_guard BEFORE INSERT ON zzsh_order.legacy_refund_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_refund_observation();

CREATE FUNCTION zzsh_order.guard_legacy_refund_terminal() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.legacy_refund_intent; x zzsh_order.legacy_refund_case; o zzsh_order.legacy_refund_observation; f jsonb; p jsonb;
BEGIN
 SELECT * INTO i FROM zzsh_order.legacy_refund_intent WHERE id=NEW.intent_id FOR UPDATE;
 SELECT * INTO x FROM zzsh_order.legacy_refund_case WHERE id=i.case_id;
 SELECT * INTO o FROM zzsh_order.legacy_refund_observation WHERE id=NEW.observation_id AND intent_id=NEW.intent_id;
 f:=NEW.facts_canonical::jsonb;p:=o.profile_canonical::jsonb;
 IF i.id IS NULL OR x.id IS NULL OR i.state NOT IN('SUBMITTING','UNKNOWN','PROCESSING') OR i.requires_review OR i.budget_disposition<>'ALLOCATED'
  OR EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_intent prior WHERE prior.case_id=i.case_id AND prior.generation<i.generation AND prior.requires_review)
  OR o.id IS NULL OR o.created_xid<>pg_current_xact_id() OR o.operation NOT IN('QUERY','NOTIFY') OR o.event<>'PENDING_TERMINAL'
  OR o.evidence_level<>'PROVIDER_RESPONSE' OR NOT o.response_complete OR o.transport_failure IS NOT NULL
  OR(o.operation='QUERY' AND o.http_status IS DISTINCT FROM 200) OR(o.operation='NOTIFY' AND o.http_status IS NOT NULL)
  OR o.schema_status<>'VALID' OR o.signature_status<>'MATCH' OR o.binding_status<>'MATCH'
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_attempt a WHERE a.intent_id=i.id AND a.operation='SUBMIT')
  OR f->>'evidenceId' IS DISTINCT FROM NEW.id OR f->>'intentId' IS DISTINCT FROM i.id OR f->>'caseId' IS DISTINCT FROM x.id
  OR f->>'orderId' IS DISTINCT FROM x.order_id OR f->>'dutyId' IS DISTINCT FROM x.duty_id OR f->>'renterUserId' IS DISTINCT FROM x.renter_user_id
  OR f->>'merchantIdentityId' IS DISTINCT FROM x.merchant_identity_id OR f->>'merchantNo' IS DISTINCT FROM x.merchant_no
  OR f->>'originalPaymentOrderNo' IS DISTINCT FROM x.original_payment_order_no OR f->>'refundOrderNo' IS DISTINCT FROM i.refund_order_no
  OR f->>'amountCents' IS DISTINCT FROM i.amount_cents::text OR f->>'currency' IS DISTINCT FROM 'CNY'
  OR f->>'terminal' IS DISTINCT FROM NEW.terminal OR f->>'refundTransactionNo' IS DISTINCT FROM NEW.refund_transaction_no
  OR f->>'financeEventId' IS DISTINCT FROM NEW.finance_event_id
  OR (f->>'completedAt')::timestamptz IS DISTINCT FROM NEW.completed_at OR f->>'sourceObservationId' IS DISTINCT FROM o.id
  OR NEW.merchant_no IS DISTINCT FROM x.merchant_no
 THEN RAISE EXCEPTION 'legacy refund terminal differs from original channel evidence' USING ERRCODE='23514';END IF;
 IF NEW.terminal='SUCCEEDED' AND(NEW.completed_at_raw!~'^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$'
  OR NEW.completed_at IS DISTINCT FROM(NEW.completed_at_raw::timestamp AT TIME ZONE 'UTC')-make_interval(mins=>(p#>>'{rules,utcOffsetMinutes}')::integer)
  OR NEW.finance_event_id IS DISTINCT FROM 'legacy_refund_paid_'||substr(encode(sha256(convert_to(i.id,'UTF8')),'hex'),1,40))
 THEN RAISE EXCEPTION 'legacy refund completion time differs' USING ERRCODE='23514';END IF;
 IF NEW.terminal='FAILED_NO_EXECUTION' AND((p#>>'{rules,failureNoExecution,accepted}' IS DISTINCT FROM 'true'
  OR p#>>'{rules,failureNoExecution,reference}' IS NULL OR p#>>'{rules,failureNoExecution,sha256}'!~'^[a-f0-9]{64}$'
  OR NOT COALESCE((p#>'{rules,failureNoExecution,codes}')?o.channel_code,false)) IS NOT FALSE)
 THEN RAISE EXCEPTION 'legacy refund failure has no reviewed no-execution evidence' USING ERRCODE='23514';END IF;
 IF o.operation='QUERY' AND(i.lease_version IS DISTINCT FROM o.lease_version OR i.lease_owner IS DISTINCT FROM o.lease_owner
  OR i.lease_until IS NULL OR i.lease_until<=clock_timestamp()) THEN RAISE EXCEPTION 'legacy refund evidence lease expired' USING ERRCODE='23514',CONSTRAINT='legacy_refund_live_lease';END IF;
 IF NEW.refund_transaction_no IS NOT NULL THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-transaction:v1','JOINPAY',x.merchant_identity_id,NEW.refund_transaction_no)::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-merchant-trx:v1',x.merchant_no,NEW.refund_transaction_no)::text,0));
  IF EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent n WHERE n.payment_source='JOINPAY' AND n.wire_merchant_no=x.merchant_no AND n.provider_refund_trx_no=NEW.refund_transaction_no)
  THEN RAISE EXCEPTION 'refund transaction belongs to another intent' USING ERRCODE='23514';END IF;
 END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER legacy_refund_terminal_guard BEFORE INSERT ON zzsh_order.legacy_refund_terminal_evidence FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_refund_terminal();

CREATE FUNCTION zzsh_order.guard_native_refund_against_legacy_transaction() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE merchant_value text;
BEGIN
 IF NEW.refund_transaction_no IS NULL THEN RETURN NEW;END IF;
 SELECT wire_merchant_no INTO merchant_value FROM zzsh_order.channel_refund_intent WHERE id=NEW.intent_id AND payment_source='JOINPAY';
 IF merchant_value IS NULL THEN RAISE EXCEPTION 'native refund merchant unavailable' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-merchant-trx:v1',merchant_value,NEW.refund_transaction_no)::text,0));
 IF EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_terminal_evidence e WHERE e.merchant_no=merchant_value AND e.refund_transaction_no=NEW.refund_transaction_no)
 THEN RAISE EXCEPTION 'refund transaction belongs to a legacy intent' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER zz_legacy_refund_transaction_guard BEFORE INSERT ON zzsh_order.joinpay_refund_evidence FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_native_refund_against_legacy_transaction();

--> statement-breakpoint
CREATE FUNCTION zzsh_order.guard_legacy_refund_history() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x zzsh_order.legacy_refund_case; f zzsh_order.legacy_duty_finance_fact; e zzsh_order.finance_event; revision_value bigint;
BEGIN
 IF TG_TABLE_NAME='finance_event' THEN
  SELECT * INTO x FROM zzsh_order.legacy_refund_case WHERE history_event_id=NEW.id;
  SELECT * INTO f FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=x.duty_id;
  SELECT ledger_revision INTO revision_value FROM zzsh_order.wallet_revision WHERE user_id=x.renter_user_id;
  IF x.id IS NULL OR x.created_xid<>pg_current_xact_id() OR x.prior_applied_cents<=0 OR f.root_id IS DISTINCT FROM NEW.economic_root_id
   OR NEW.kind<>'LEGACY_REFUND_HISTORY_OFFSET' OR NEW.subject_user_id IS DISTINCT FROM x.renter_user_id
   OR NEW.expected_ledger_revision IS DISTINCT FROM revision_value
  THEN RAISE EXCEPTION 'legacy history offset requires the exact reviewed case' USING ERRCODE='23514';END IF;
  NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
 END IF;
 SELECT * INTO x FROM zzsh_order.legacy_refund_case WHERE id=NEW.details->>'legacyRefundCaseId';
 SELECT * INTO e FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 IF x.id IS NULL OR x.created_xid<>pg_current_xact_id() OR e.id IS DISTINCT FROM x.history_event_id
  OR e.kind<>'LEGACY_REFUND_HISTORY_OFFSET' OR NEW.source_payment_confirmation_id IS NOT NULL
  OR NEW.details IS DISTINCT FROM jsonb_build_object('legacyRefundCaseId',x.id,'reviewDigest',x.review_digest)
  OR NOT ((NEW.line_no=1 AND NEW.account_code='RENTER_REFUND_PAYABLE' AND NEW.debit_cents=x.prior_applied_cents AND NEW.credit_cents=0 AND NEW.counterparty_user_id=x.renter_user_id)
    OR (NEW.line_no=2 AND NEW.account_code='LEGACY_LIABILITY_SOURCE' AND NEW.debit_cents=0 AND NEW.credit_cents=x.prior_applied_cents AND NEW.counterparty_user_id IS NULL))
 THEN RAISE EXCEPTION 'legacy history offset entry differs from the reviewed case' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER legacy_refund_history_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN(NEW.kind='LEGACY_REFUND_HISTORY_OFFSET') EXECUTE FUNCTION zzsh_order.guard_legacy_refund_history();
CREATE TRIGGER legacy_refund_history_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'legacyRefundCaseId') EXECUTE FUNCTION zzsh_order.guard_legacy_refund_history();
CREATE TRIGGER legacy_refund_history_revision AFTER INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN(NEW.kind='LEGACY_REFUND_HISTORY_OFFSET') EXECUTE FUNCTION zzsh_order.withdrawal_wallet_revision();

--> statement-breakpoint
CREATE FUNCTION zzsh_order.guard_legacy_refund_paid() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.legacy_refund_intent; x zzsh_order.legacy_refund_case; proof zzsh_order.legacy_refund_terminal_evidence;
 f zzsh_order.legacy_duty_finance_fact; e zzsh_order.finance_event; revision_value bigint;
BEGIN
 IF TG_TABLE_NAME='finance_event' THEN
  SELECT * INTO proof FROM zzsh_order.legacy_refund_terminal_evidence WHERE finance_event_id=NEW.id;
  SELECT * INTO i FROM zzsh_order.legacy_refund_intent WHERE id=proof.intent_id;
  SELECT * INTO x FROM zzsh_order.legacy_refund_case WHERE id=i.case_id;
  SELECT * INTO f FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=x.duty_id;
  SELECT ledger_revision INTO revision_value FROM zzsh_order.wallet_revision WHERE user_id=x.renter_user_id;
  IF proof.id IS NULL OR proof.created_xid<>pg_current_xact_id() OR proof.terminal<>'SUCCEEDED' OR f.root_id IS DISTINCT FROM NEW.economic_root_id
   OR NEW.kind<>'LEGACY_REFUND_PAID' OR NEW.subject_user_id IS DISTINCT FROM x.renter_user_id OR NEW.expected_ledger_revision IS DISTINCT FROM revision_value
  THEN RAISE EXCEPTION 'legacy refund paid event requires verified original evidence' USING ERRCODE='23514';END IF;
  NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
 END IF;
 SELECT * INTO i FROM zzsh_order.legacy_refund_intent WHERE id=NEW.details->>'legacyRefundIntentId';
 SELECT * INTO x FROM zzsh_order.legacy_refund_case WHERE id=i.case_id;
 SELECT * INTO proof FROM zzsh_order.legacy_refund_terminal_evidence WHERE intent_id=i.id;
 SELECT * INTO e FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 IF proof.id IS NULL OR proof.created_xid<>pg_current_xact_id() OR proof.terminal<>'SUCCEEDED' OR e.id IS DISTINCT FROM proof.finance_event_id
  OR e.kind<>'LEGACY_REFUND_PAID' OR NEW.source_payment_confirmation_id IS NOT NULL
  OR NEW.details IS DISTINCT FROM jsonb_build_object('legacyRefundIntentId',i.id,'caseId',x.id,'evidenceDigest',proof.facts_digest)
  OR NOT ((NEW.line_no=1 AND NEW.account_code='RENTER_REFUND_PAYABLE' AND NEW.debit_cents=i.amount_cents AND NEW.credit_cents=0 AND NEW.counterparty_user_id=x.renter_user_id)
    OR(NEW.line_no=2 AND NEW.account_code='PAYOUT_CLEARING' AND NEW.debit_cents=0 AND NEW.credit_cents=i.amount_cents AND NEW.counterparty_user_id IS NULL))
 THEN RAISE EXCEPTION 'legacy refund paid entry differs from channel evidence' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER legacy_refund_paid_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN(NEW.kind='LEGACY_REFUND_PAID') EXECUTE FUNCTION zzsh_order.guard_legacy_refund_paid();
CREATE TRIGGER legacy_refund_paid_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'legacyRefundIntentId') EXECUTE FUNCTION zzsh_order.guard_legacy_refund_paid();
CREATE TRIGGER legacy_refund_paid_revision AFTER INSERT ON zzsh_order.finance_event FOR EACH ROW WHEN(NEW.kind='LEGACY_REFUND_PAID') EXECUTE FUNCTION zzsh_order.withdrawal_wallet_revision();

CREATE FUNCTION zzsh_order.check_legacy_refund_terminal_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.legacy_refund_intent; x zzsh_order.legacy_refund_case; proof zzsh_order.legacy_refund_terminal_evidence; intent_value text;n bigint;good bigint;
BEGIN
 IF TG_TABLE_NAME='legacy_refund_intent' THEN intent_value:=NEW.id;
 ELSIF TG_TABLE_NAME='finance_event' THEN SELECT intent_id INTO intent_value FROM zzsh_order.legacy_refund_terminal_evidence WHERE finance_event_id=NEW.id;
 ELSE intent_value:=NEW.details->>'legacyRefundIntentId';END IF;
 SELECT * INTO i FROM zzsh_order.legacy_refund_intent WHERE id=intent_value;
 SELECT * INTO x FROM zzsh_order.legacy_refund_case WHERE id=i.case_id;
 SELECT * INTO proof FROM zzsh_order.legacy_refund_terminal_evidence WHERE id=i.terminal_evidence_id AND intent_id=i.id;
 IF i.id IS NULL OR x.id IS NULL OR proof.id IS NULL OR i.state NOT IN('SUCCEEDED','FAILED')
  OR i.state IS DISTINCT FROM (CASE proof.terminal WHEN 'SUCCEEDED' THEN 'SUCCEEDED' ELSE 'FAILED' END)
  OR i.terminal_event_id IS DISTINCT FROM proof.finance_event_id OR i.provider_refund_trx_no IS DISTINCT FROM proof.refund_transaction_no
  OR i.completed_at IS DISTINCT FROM proof.completed_at
 THEN RAISE EXCEPTION 'legacy refund terminal closure missing' USING ERRCODE='23514';END IF;
 SELECT count(*),count(*) FILTER(WHERE (line_no=1 AND account_code='RENTER_REFUND_PAYABLE' AND debit_cents=i.amount_cents AND credit_cents=0 AND counterparty_user_id=x.renter_user_id)
  OR(line_no=2 AND account_code='PAYOUT_CLEARING' AND debit_cents=0 AND credit_cents=i.amount_cents AND counterparty_user_id IS NULL)) INTO n,good
  FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=proof.finance_event_id;
 IF (i.state='SUCCEEDED' AND(n<>2 OR good<>2 OR NOT EXISTS(SELECT 1 FROM zzsh_order.finance_event WHERE id=proof.finance_event_id AND kind='LEGACY_REFUND_PAID')))
  OR(i.state='FAILED' AND(n<>0 OR proof.finance_event_id IS NOT NULL))
 THEN RAISE EXCEPTION 'legacy refund terminal ledger incomplete' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER legacy_refund_terminal_intent_complete AFTER UPDATE ON zzsh_order.legacy_refund_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.state IN('SUCCEEDED','FAILED')) EXECUTE FUNCTION zzsh_order.check_legacy_refund_terminal_complete();
CREATE CONSTRAINT TRIGGER legacy_refund_paid_event_complete AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='LEGACY_REFUND_PAID') EXECUTE FUNCTION zzsh_order.check_legacy_refund_terminal_complete();
CREATE CONSTRAINT TRIGGER legacy_refund_paid_entry_complete AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'legacyRefundIntentId') EXECUTE FUNCTION zzsh_order.check_legacy_refund_terminal_complete();

--> statement-breakpoint
CREATE FUNCTION zzsh_order.check_legacy_refund_case_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x zzsh_order.legacy_refund_case; case_value text; n bigint;good bigint; i zzsh_order.legacy_refund_intent;
BEGIN
 IF TG_TABLE_NAME='legacy_refund_case' THEN case_value:=NEW.id;
 ELSIF TG_TABLE_NAME='legacy_refund_intent' THEN case_value:=NEW.case_id;
 ELSIF TG_TABLE_NAME='finance_event' THEN SELECT id INTO case_value FROM zzsh_order.legacy_refund_case WHERE history_event_id=NEW.id;
 ELSE case_value:=NEW.details->>'legacyRefundCaseId';END IF;
 SELECT * INTO x FROM zzsh_order.legacy_refund_case WHERE id=case_value;
 SELECT * INTO i FROM zzsh_order.legacy_refund_intent WHERE case_id=case_value AND generation=1;
 IF x.id IS NULL OR (x.new_refund_cents=0 AND i.id IS NOT NULL) OR(x.new_refund_cents>0 AND(i.id IS NULL OR i.amount_cents<>x.new_refund_cents OR i.created_xid<>x.created_xid))
 THEN RAISE EXCEPTION 'legacy refund case and original intent must close together' USING ERRCODE='23514';END IF;
 SELECT count(*),count(*) FILTER(WHERE (line_no=1 AND account_code='RENTER_REFUND_PAYABLE' AND debit_cents=x.prior_applied_cents AND credit_cents=0 AND counterparty_user_id=x.renter_user_id)
  OR(line_no=2 AND account_code='LEGACY_LIABILITY_SOURCE' AND debit_cents=0 AND credit_cents=x.prior_applied_cents AND counterparty_user_id IS NULL)) INTO n,good
  FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=x.history_event_id;
 IF (x.prior_applied_cents=0 AND(n<>0 OR x.history_event_id IS NOT NULL))
  OR(x.prior_applied_cents>0 AND(n<>2 OR good<>2 OR NOT EXISTS(SELECT 1 FROM zzsh_order.finance_event WHERE id=x.history_event_id AND kind='LEGACY_REFUND_HISTORY_OFFSET')))
 THEN RAISE EXCEPTION 'legacy historical refund offset is incomplete' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER legacy_refund_case_complete AFTER INSERT ON zzsh_order.legacy_refund_case DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_legacy_refund_case_complete();
CREATE CONSTRAINT TRIGGER legacy_refund_intent_complete AFTER INSERT ON zzsh_order.legacy_refund_intent DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_legacy_refund_case_complete();
CREATE CONSTRAINT TRIGGER legacy_refund_history_event_complete AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='LEGACY_REFUND_HISTORY_OFFSET') EXECUTE FUNCTION zzsh_order.check_legacy_refund_case_complete();
CREATE CONSTRAINT TRIGGER legacy_refund_history_entry_complete AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'legacyRefundCaseId') EXECUTE FUNCTION zzsh_order.check_legacy_refund_case_complete();

--> statement-breakpoint
CREATE FUNCTION zzsh_order.create_legacy_refund_case(review_audit_value text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a zzsh_iam.audit_event; f zzsh_order.legacy_duty_finance_fact; d zzsh_order.legacy_order_duty;
 case_value text;intent_value text;refund_no text;history_value text;revision_value bigint;suffix text;
 applied numeric;new_amount numeric;paid numeric;prior_total numeric;due_value timestamptz;
BEGIN
 SELECT * INTO a FROM zzsh_iam.audit_event WHERE id=review_audit_value AND action='order.legacy.refund.reviewed' AND outcome='SUCCESS';
 SELECT * INTO d FROM zzsh_order.legacy_order_duty WHERE id=a.object_id;
 SELECT * INTO f FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=d.id;
 IF a.id IS NULL OR d.id IS NULL OR f.duty_id IS NULL THEN RAISE EXCEPTION 'legacy refund review unavailable' USING ERRCODE='23514';END IF;
 PERFORM zzsh_order.assert_legacy_finance_order_lock(d.order_id);
 paid:=(a.details->>'paidCents')::numeric;prior_total:=(a.details->>'previouslyRefundedCents')::numeric;
 applied:=(a.details->>'priorAppliedToDutyCents')::numeric;new_amount:=(a.details->>'refundCents')::numeric;
 SELECT refund_due_at INTO due_value FROM zzsh_order.legacy_continuation_version WHERE id=d.continuation_version_id AND order_id=d.order_id AND command='CONFIRM';
 case_value:='legacy_refund_case_'||substr(encode(sha256(convert_to(d.id,'UTF8')),'hex'),1,40);
 suffix:=encode(sha256(convert_to(case_value,'UTF8')),'hex');
 intent_value:='legacy_refund_intent_'||substr(suffix,1,40);refund_no:='LR'||substr(suffix,1,28);
 history_value:=CASE WHEN applied>0 THEN 'legacy_refund_history_'||substr(suffix,1,40) ELSE NULL END;
 SET CONSTRAINTS zzsh_order.legacy_refund_case_complete,zzsh_order.legacy_refund_intent_complete,
  zzsh_order.legacy_refund_history_event_complete,zzsh_order.legacy_refund_history_entry_complete DEFERRED;
 INSERT INTO zzsh_order.legacy_refund_case(id,duty_id,order_id,review_audit_id,review_digest,renter_user_id,merchant_identity_id,merchant_no,
  original_payment_order_no,original_payment_record_id,paid_cents,duty_cents,previously_refunded_cents,prior_applied_cents,new_refund_cents,
  source_digest,duty_fact_digest,refund_due_at,history_event_id)
 VALUES(case_value,d.id,d.order_id,a.id,a.details->>'reviewDigest',d.counterparty_user_id,a.details->>'merchantIdentityId',a.details->>'merchantNo',
  a.details->>'paymentOrderNo',a.details->>'paymentRecordId',paid,d.amount_cents,prior_total,applied,new_amount,
  f.parent_source_digest,f.facts_digest,due_value,history_value);
 IF new_amount>0 THEN INSERT INTO zzsh_order.legacy_refund_intent(id,case_id,refund_order_no,amount_cents,
   initial_admission_ref,initial_admission_sha256,initial_admission_canonical,initial_profile_id,initial_profile_sha256,initial_profile_canonical,initial_key_version_ref,notify_url,funds_account)
  VALUES(intent_value,case_value,refund_no,new_amount,a.details->>'admissionRef',a.details->>'admissionSha256',a.details->>'admissionCanonical',
   a.details->>'profileId',a.details->>'profileSha256',a.details->>'profileCanonical',a.details->>'keyVersionRef',a.details->>'notifyUrl',a.details->>'fundsAccount');END IF;
 IF applied>0 THEN
  SELECT ledger_revision INTO revision_value FROM zzsh_order.wallet_revision WHERE user_id=d.counterparty_user_id;
  IF revision_value IS NULL THEN RAISE EXCEPTION 'legacy refund wallet revision unavailable' USING ERRCODE='23514';END IF;
  INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision)
   VALUES(history_value,f.root_id,'LEGACY_REFUND_HISTORY_OFFSET',d.counterparty_user_id,revision_value);
  INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
   VALUES(history_value||'_1',history_value,1,'RENTER_REFUND_PAYABLE',applied,0,d.counterparty_user_id,jsonb_build_object('legacyRefundCaseId',case_value,'reviewDigest',a.details->>'reviewDigest')),
    (history_value||'_2',history_value,2,'LEGACY_LIABILITY_SOURCE',0,applied,NULL,jsonb_build_object('legacyRefundCaseId',case_value,'reviewDigest',a.details->>'reviewDigest'));
 END IF;
 SET CONSTRAINTS zzsh_order.legacy_refund_case_complete,zzsh_order.legacy_refund_intent_complete,
  zzsh_order.legacy_refund_history_event_complete,zzsh_order.legacy_refund_history_entry_complete IMMEDIATE;
 RETURN jsonb_build_object('caseId',case_value,'dutyId',d.id,'intentId',CASE WHEN new_amount>0 THEN intent_value ELSE NULL END,
  'refundOrderNo',CASE WHEN new_amount>0 THEN refund_no ELSE NULL END,'amountCents',new_amount::text,
  'priorAppliedCents',applied::text,'channelResult','NOT_SUBMITTED');
END $$;
REVOKE ALL ON FUNCTION zzsh_order.create_legacy_refund_case(text) FROM PUBLIC;

--> statement-breakpoint
REVOKE ALL ON zzsh_order.legacy_refund_case,zzsh_order.legacy_refund_intent,zzsh_order.legacy_refund_attempt,
 zzsh_order.legacy_refund_observation,zzsh_order.legacy_refund_terminal_evidence,zzsh_order.legacy_refund_review_resolution,
 zzsh_order.legacy_refund_terminal_resolution,zzsh_order.legacy_refund_retry_authorization FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_legacy_refund_case(),zzsh_order.guard_legacy_refund_intent(),zzsh_order.guard_legacy_refund_history(),
 zzsh_order.check_legacy_refund_case_complete(),zzsh_order.guard_legacy_refund_attempt(),zzsh_order.guard_legacy_refund_observation(),
 zzsh_order.guard_legacy_refund_terminal(),zzsh_order.guard_native_refund_against_legacy_transaction(),zzsh_order.guard_legacy_refund_paid(),
 zzsh_order.check_legacy_refund_terminal_complete() FROM PUBLIC;
