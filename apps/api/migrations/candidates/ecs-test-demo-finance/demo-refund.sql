-- Test-only refund extension. No external provider is called.
DO $guard$
DECLARE d record;
BEGIN
 SELECT pg_get_userbyid(n.nspowner) AS owner,shobj_description(db.oid,'pg_database') AS marker INTO d FROM pg_database db JOIN pg_namespace n ON n.nspname='zzsh_order' WHERE db.datname=current_database();
 IF (current_database() ~ '^zzsh_ecs_test(_[a-z0-9_]{1,32})?$' AND d.marker='zzsh:ecs-test:v1'
   OR current_database()='zzsh_test_r07_delivery_20261108' AND d.marker='zzsh:r07-delivery-clone:v1') IS NOT TRUE OR d.owner<>current_user
  OR to_regclass('zzsh_order.ecs_test_demo_finance_registration') IS NULL OR to_regclass('zzsh_order.controlled_payment_declaration') IS NULL
  OR to_regprocedure('zzsh_order.ecs_test_demo_finance_matches(text)') IS NULL
  OR EXISTS(SELECT 1 FROM (VALUES('finance_entry_guard'),('finance_entry_batch_guard')) r(name) WHERE NOT EXISTS(
   SELECT 1 FROM pg_trigger t WHERE t.tgrelid='zzsh_order.settlement_ledger_entry'::regclass AND t.tgname=r.name AND t.tgenabled IN ('O','A')
    AND position('localRefundIntentId' IN pg_get_triggerdef(t.oid))>0 AND position('legacyRefundCaseId' IN pg_get_triggerdef(t.oid))>0
    AND position('legacyRefundIntentId' IN pg_get_triggerdef(t.oid))>0)) THEN RAISE EXCEPTION 'Exact demo payment and 0174 ledger guards required';END IF;
END $guard$;
ALTER TABLE zzsh_order.channel_refund_intent DROP CONSTRAINT production_real_refund_source;
ALTER TABLE zzsh_order.finance_economic_root DROP CONSTRAINT production_no_local_controlled_root,
 ADD CONSTRAINT production_no_local_controlled_root CHECK (source_kind<>'LOCAL_CONTROLLED_WITHDRAWAL');
ALTER TABLE zzsh_order.channel_refund_intent ADD COLUMN sandbox_registration_ref text REFERENCES zzsh_order.ecs_test_demo_finance_registration(reference),
 ADD CONSTRAINT sandbox_refund_source_reference CHECK(sandbox_registration_ref IS NULL OR(payment_source='CONTROLLED' AND evidence_level='CONTROLLED_TEST' AND basis_kind='POSTING'));
ALTER TABLE zzsh_order.channel_refund_intent ADD CONSTRAINT production_real_refund_source CHECK(payment_source='JOINPAY' OR (payment_source='CONTROLLED' AND evidence_level='CONTROLLED_TEST' AND sandbox_registration_ref IS NOT NULL));
CREATE TABLE zzsh_order.local_controlled_refund_operation(
 id text PRIMARY KEY CHECK(id~'^local_refund_op_[a-f0-9]{40}$'),intent_id text NOT NULL UNIQUE REFERENCES zzsh_order.channel_refund_intent(id),
 sandbox_registration_ref text NOT NULL REFERENCES zzsh_order.ecs_test_demo_finance_registration(reference),
 scenario text NOT NULL CHECK(scenario='TIMEOUT_THEN_SUCCEED'),refund_order_no text NOT NULL,original_payment_trx_no text NOT NULL,
 amount_cents numeric(24,0) NOT NULL CHECK(amount_cents BETWEEN 1 AND 9999999999999999),currency text NOT NULL CHECK(currency='CNY'),
 final_canonical text NOT NULL,final_digest text NOT NULL CHECK(final_digest=encode(sha256(convert_to(final_canonical,'UTF8')),'hex')),
 original_lease_version bigint NOT NULL CHECK(original_lease_version>0),original_lease_owner text NOT NULL,
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE zzsh_order.local_controlled_refund_evidence(
 id text PRIMARY KEY CHECK(id~'^local_rfe_[a-f0-9]{40}$'),intent_id text NOT NULL UNIQUE REFERENCES zzsh_order.channel_refund_intent(id),
 operation_id text NOT NULL UNIQUE REFERENCES zzsh_order.local_controlled_refund_operation(id),
 sandbox_registration_ref text NOT NULL REFERENCES zzsh_order.ecs_test_demo_finance_registration(reference),terminal text NOT NULL CHECK(terminal='SUCCEEDED'),
 refund_transaction_no text NOT NULL,completed_at timestamptz NOT NULL,facts_canonical text NOT NULL,
 facts_digest text NOT NULL CHECK(facts_digest=encode(sha256(convert_to(facts_canonical,'UTF8')),'hex')),
 lease_version bigint NOT NULL CHECK(lease_version>0),lease_owner text NOT NULL,
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE zzsh_order.local_controlled_refund_evidence ADD CONSTRAINT demo_refund_evidence_intent_unique UNIQUE(id,intent_id);
ALTER TABLE zzsh_order.channel_refund_intent ADD COLUMN demo_terminal_evidence_id text,
 ADD CONSTRAINT demo_refund_terminal_evidence_fk FOREIGN KEY(demo_terminal_evidence_id,id)
  REFERENCES zzsh_order.local_controlled_refund_evidence(id,intent_id) DEFERRABLE INITIALLY DEFERRED,
 ADD CONSTRAINT demo_refund_evidence_source_shape CHECK (
  (payment_source='JOINPAY' AND demo_terminal_evidence_id IS NULL) OR
  (payment_source='CONTROLLED' AND terminal_evidence_id IS NULL AND
   ((state='SUCCEEDED' AND demo_terminal_evidence_id IS NOT NULL) OR (state<>'SUCCEEDED' AND demo_terminal_evidence_id IS NULL))));
DO $demo_budget$
DECLARE expression text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='zzsh_order.channel_refund_intent'::regclass AND conname='channel_refund_budget_shape';
 IF expression IS NULL OR position('terminal_evidence_id' IN expression)=0 THEN RAISE EXCEPTION 'Original refund budget shape missing';END IF;
 ALTER TABLE zzsh_order.channel_refund_intent DROP CONSTRAINT channel_refund_budget_shape;
 EXECUTE format('ALTER TABLE zzsh_order.channel_refund_intent ADD CONSTRAINT channel_refund_budget_shape CHECK((%s) OR
  (payment_source=''CONTROLLED'' AND sandbox_registration_ref IS NOT NULL AND state=''SUCCEEDED'' AND budget_disposition=''CONSUMED''
   AND terminal_evidence_id IS NULL AND demo_terminal_evidence_id IS NOT NULL AND terminal_root_id IS NOT NULL AND terminal_event_id IS NOT NULL
   AND provider_refund_trx_no IS NOT NULL AND completed_at IS NOT NULL))',expression);
END $demo_budget$;
CREATE TRIGGER local_refund_operation_immutable BEFORE UPDATE OR DELETE ON zzsh_order.local_controlled_refund_operation FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER local_refund_operation_no_truncate BEFORE TRUNCATE ON zzsh_order.local_controlled_refund_operation EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER local_refund_evidence_immutable BEFORE UPDATE OR DELETE ON zzsh_order.local_controlled_refund_evidence FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER local_refund_evidence_no_truncate BEFORE TRUNCATE ON zzsh_order.local_controlled_refund_evidence EXECUTE FUNCTION zzsh_order.finance_immutable();
REVOKE ALL ON zzsh_order.local_controlled_refund_operation,zzsh_order.local_controlled_refund_evidence FROM PUBLIC;

--> statement-breakpoint
-- Extend only the three named CHECK expressions. Preserve the installed historical/formal expression
-- verbatim as one OR branch; do not replace its function, HTTPS/profile rules or financial semantics.
DO $extend_checks$
DECLARE expression text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='zzsh_order.channel_refund_intent'::regclass AND conname='channel_refund_source_shape';
 IF expression IS NULL OR position('JOINPAY_FORMAL' IN expression)=0 OR position('https' IN expression)=0 THEN RAISE EXCEPTION 'formal refund source contract missing' USING ERRCODE='23514';END IF;
 ALTER TABLE zzsh_order.channel_refund_intent DROP CONSTRAINT channel_refund_source_shape;
 EXECUTE format('ALTER TABLE zzsh_order.channel_refund_intent ADD CONSTRAINT channel_refund_source_shape CHECK((%s) OR
  (payment_source=''CONTROLLED'' AND evidence_level=''CONTROLLED_TEST'' AND sandbox_registration_ref IS NOT NULL
   AND state IN(''READY'',''SUBMITTING'',''UNKNOWN'',''SUCCEEDED'') AND NOT requires_review
   AND num_nonnulls(initial_admission_ref,initial_admission_sha256,initial_admission_canonical,wire_merchant_no,initial_profile_id,
    initial_profile_sha256,initial_key_version_ref,notify_url,funds_account,refund_reason)=0))',expression);
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='zzsh_order.channel_refund_intent'::regclass AND conname='channel_refund_basis_shape';
 IF expression IS NULL OR position('PRESTART_TERMINATION' IN expression)=0 OR position('JOINPAY' IN expression)=0 THEN RAISE EXCEPTION 'formal refund basis contract missing' USING ERRCODE='23514';END IF;
 ALTER TABLE zzsh_order.channel_refund_intent DROP CONSTRAINT channel_refund_basis_shape;
 EXECUTE format('ALTER TABLE zzsh_order.channel_refund_intent ADD CONSTRAINT channel_refund_basis_shape CHECK((%s) OR
  (payment_source=''CONTROLLED'' AND evidence_level=''CONTROLLED_TEST'' AND sandbox_registration_ref IS NOT NULL
   AND basis_kind=''PRESTART_TERMINATION'' AND posting_id IS NULL AND liability_root_id IS NOT NULL AND liability_event_id IS NOT NULL))',expression);
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='zzsh_order.finance_economic_root'::regclass AND conname='finance_root_enabled_source_shape';
 IF expression IS NULL OR position('NATIVE_RENTAL_REFUND' IN expression)=0 THEN RAISE EXCEPTION 'finance enabled source contract missing' USING ERRCODE='23514';END IF;
 ALTER TABLE zzsh_order.finance_economic_root DROP CONSTRAINT finance_root_enabled_source_shape;
 EXECUTE format('ALTER TABLE zzsh_order.finance_economic_root ADD CONSTRAINT finance_root_enabled_source_shape CHECK((%s) OR
  (source_kind=''LOCAL_CONTROLLED_RENTAL_REFUND'' AND basis_id IS NULL))',expression);
END $extend_checks$;
CREATE UNIQUE INDEX sandbox_prestart_refund_original_key ON zzsh_order.channel_refund_intent(payment_confirmation_id,idempotency_key)
 WHERE sandbox_registration_ref IS NOT NULL AND basis_kind='PRESTART_TERMINATION';
CREATE UNIQUE INDEX sandbox_refund_transaction_once ON zzsh_order.channel_refund_intent(merchant_identity_id,provider_refund_trx_no)
 WHERE sandbox_registration_ref IS NOT NULL AND provider_refund_trx_no IS NOT NULL;
CREATE INDEX sandbox_refund_due ON zzsh_order.channel_refund_intent(sandbox_registration_ref,due_at,id)
 WHERE sandbox_registration_ref IS NOT NULL AND state IN('READY','SUBMITTING','UNKNOWN');

--> statement-breakpoint
CREATE FUNCTION zzsh_order.local_controlled_refund_liability_complete(target text) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE i zzsh_order.channel_refund_intent;p zzsh_order.settlement_posting;t zzsh_order.prestart_termination;c zzsh_order.payment_confirmation;o zzsh_order.rental_order;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=target;
 SELECT * INTO c FROM zzsh_order.payment_confirmation WHERE id=i.payment_confirmation_id;
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=i.order_id;
 IF i.id IS NULL OR i.sandbox_registration_ref IS NULL OR i.payment_source<>'CONTROLLED' OR i.evidence_level<>'CONTROLLED_TEST'
  OR c.id IS NULL OR o.id IS NULL OR c.source<>'CONTROLLED' OR c.disposition<>'APPLIED' OR c.order_id<>o.id OR o.paid_confirmation_id<>c.id
  OR o.renter_user_id<>i.renter_user_id OR c.currency<>'CNY' OR i.currency<>'CNY' OR i.amount_cents>c.amount_cents
  OR c.merchant_scope_id<>i.merchant_identity_id OR c.provider_transaction_id<>i.original_payment_trx_no OR c.merchant_order_no<>i.original_payment_order_no
 THEN RETURN false;END IF;
 IF i.basis_kind='POSTING' THEN
  SELECT * INTO p FROM zzsh_order.settlement_posting WHERE id=i.posting_id;
  RETURN p.id IS NOT NULL AND o.status='COMPLETED' AND p.order_id=o.id AND p.payment_confirmation_id=c.id
   AND p.version_hash=i.responsibility_version_hash AND p.currency='CNY' AND p.captured_cents=c.amount_cents
   AND p.renter_refund_cents>=i.amount_cents AND p.refund_due_at=i.due_at AND i.liability_root_id IS NULL AND i.liability_event_id IS NULL
   AND EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.posting_id=p.id AND l.account_code='RENTER_REFUND_PAYABLE'
    AND l.credit_cents=p.renter_refund_cents AND l.debit_cents=0 AND l.counterparty_user_id=i.renter_user_id);
 ELSIF i.basis_kind='PRESTART_TERMINATION' THEN
  SELECT * INTO t FROM zzsh_order.prestart_termination WHERE state='APPROVED' AND order_id=i.order_id
   AND payment_basis->>'paymentConfirmationId'=c.id AND basis_digest=i.responsibility_version_hash
   AND liability_root_id=i.liability_root_id AND liability_event_id=i.liability_event_id;
  RETURN t.id IS NOT NULL AND i.posting_id IS NULL AND t.payment_basis->>'source'='CONTROLLED'
   AND (t.payment_basis->>'amountCents')::numeric=i.amount_cents AND t.approved_at=i.due_at AND zzsh_order.prestart_liability_complete(t.id);
 END IF;
 RETURN false;
END $$;

--> statement-breakpoint
CREATE FUNCTION zzsh_order.guard_sandbox_refund_intent() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE s zzsh_order.ecs_test_demo_finance_registration;c zzsh_order.payment_confirmation;a zzsh_order.distribution_order_admission;
 proof zzsh_order.local_controlled_refund_evidence;paid_allocated numeric;responsibility_allocated numeric;frozen numeric;allowed boolean;
BEGIN
 SELECT * INTO s FROM zzsh_order.ecs_test_demo_finance_registration WHERE reference=NEW.sandbox_registration_ref AND active FOR SHARE;
 IF s.reference IS NULL OR NOT zzsh_order.ecs_test_demo_finance_matches(s.registration_digest)
  OR NEW.payment_source<>'CONTROLLED' OR NEW.evidence_level<>'CONTROLLED_TEST' OR NEW.merchant_identity_id<>(CASE WHEN s.canonical_registration::jsonb->>'schema'='ecs-test-demo-finance.v1' THEN 'ecs_demo_' ELSE 'local_demo_' END)||substr(s.registration_digest,1,32)
 THEN RAISE EXCEPTION 'local refund requires its exact current registered environment' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-funds:v1','CONTROLLED',NEW.merchant_identity_id,NEW.original_payment_trx_no)::text,0));
 IF TG_OP='INSERT' THEN
  SELECT * INTO c FROM zzsh_order.payment_confirmation WHERE id=NEW.payment_confirmation_id;
  SELECT a0.* INTO a FROM zzsh_order.distribution_order_admission a0 JOIN zzsh_order.controlled_payment_declaration d
   ON d.admission_id=a0.id AND d.order_id=a0.order_id AND d.merchant_scope_id=NEW.merchant_identity_id AND d.provider_transaction_id=NEW.original_payment_trx_no
   WHERE a0.order_id=NEW.order_id AND a0.approval_digest=s.registration_digest AND d.approval_digest=s.registration_digest AND a0.resource_oid=((s.canonical_registration::jsonb #>> '{resource,databaseOid}')::oid);
  IF c.id IS NULL OR a.id IS NULL OR c.source<>'CONTROLLED' OR c.disposition<>'APPLIED' OR c.order_id<>NEW.order_id
   OR c.merchant_scope_id<>NEW.merchant_identity_id OR c.provider_transaction_id<>NEW.original_payment_trx_no OR c.merchant_order_no<>NEW.original_payment_order_no
   OR NEW.state<>'READY' OR NEW.revision<>1 OR NEW.lease_version<>0 OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL
   OR NEW.budget_disposition<>'ALLOCATED' OR NEW.requires_review OR NEW.amount_cents<=0 OR NEW.amount_cents>9999999999999999 OR NEW.currency<>'CNY'
  THEN RAISE EXCEPTION 'local refund has no original frozen payment allocation' USING ERRCODE='23514';END IF;
  IF NEW.basis_kind='POSTING' THEN
   SELECT p.renter_refund_cents INTO frozen FROM zzsh_order.settlement_posting p JOIN zzsh_order.rental_order o ON o.id=p.order_id
    WHERE p.id=NEW.posting_id AND p.order_id=NEW.order_id AND p.payment_confirmation_id=c.id AND p.version_hash=NEW.responsibility_version_hash
     AND p.currency='CNY' AND p.captured_cents=c.amount_cents AND p.refund_due_at=NEW.due_at AND o.status='COMPLETED' AND o.renter_user_id=NEW.renter_user_id;
  ELSIF NEW.basis_kind='PRESTART_TERMINATION' THEN
   SELECT c.amount_cents INTO frozen FROM zzsh_order.prestart_termination t WHERE t.order_id=NEW.order_id AND t.state='APPROVED'
    AND t.payment_basis->>'paymentConfirmationId'=c.id AND t.payment_basis->>'source'='CONTROLLED' AND t.basis_digest=NEW.responsibility_version_hash
    AND t.liability_root_id=NEW.liability_root_id AND t.liability_event_id=NEW.liability_event_id AND t.approved_at=NEW.due_at
    AND NEW.amount_cents=c.amount_cents AND zzsh_order.prestart_liability_complete(t.id);
  END IF;
  IF frozen IS NULL THEN RAISE EXCEPTION 'local refund original responsibility incomplete' USING ERRCODE='23514';END IF;
  SELECT COALESCE(sum(amount_cents),0),COALESCE(sum(amount_cents) FILTER(WHERE posting_id IS NOT DISTINCT FROM NEW.posting_id),0)
   INTO paid_allocated,responsibility_allocated FROM zzsh_order.channel_refund_intent
   WHERE payment_source='CONTROLLED' AND merchant_identity_id=NEW.merchant_identity_id AND original_payment_trx_no=NEW.original_payment_trx_no AND budget_disposition<>'RELEASED';
  IF paid_allocated+NEW.amount_cents>c.amount_cents OR responsibility_allocated+NEW.amount_cents>frozen
  THEN RAISE EXCEPTION 'local refund allocation exceeds original funds/responsibility' USING ERRCODE='23514';END IF;
  NEW.created_at:=clock_timestamp();NEW.updated_at:=NEW.created_at;RETURN NEW;
 END IF;
 IF OLD.state IN('SUCCEEDED','FAILED') OR NEW.revision<>OLD.revision+1 OR
  (to_jsonb(NEW)-ARRAY['state','revision','lease_version','lease_owner','lease_until','updated_at','budget_disposition','demo_terminal_evidence_id','terminal_root_id','terminal_event_id','provider_refund_trx_no','completed_at'])
   IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','revision','lease_version','lease_owner','lease_until','updated_at','budget_disposition','demo_terminal_evidence_id','terminal_root_id','terminal_event_id','provider_refund_trx_no','completed_at'])
 THEN RAISE EXCEPTION 'local refund identity/terminal/CAS is immutable' USING ERRCODE='40001';END IF;
 IF NEW.lease_version=OLD.lease_version+1 THEN
  allowed:=OLD.state IN('READY','SUBMITTING','UNKNOWN') AND (OLD.lease_until IS NULL OR OLD.lease_until<=clock_timestamp())
   AND NEW.state=CASE WHEN OLD.state='READY' THEN 'SUBMITTING' ELSE 'UNKNOWN' END AND NEW.lease_owner IS NOT NULL AND NEW.lease_until>clock_timestamp()
   AND NEW.lease_until<=clock_timestamp()+interval '1 hour' AND NEW.budget_disposition='ALLOCATED'
   AND num_nonnulls(NEW.demo_terminal_evidence_id,NEW.terminal_root_id,NEW.terminal_event_id,NEW.provider_refund_trx_no,NEW.completed_at)=0;
 ELSIF NEW.state='SUCCEEDED' THEN
  SELECT * INTO proof FROM zzsh_order.local_controlled_refund_evidence WHERE id=NEW.demo_terminal_evidence_id AND intent_id=OLD.id;
  allowed:=proof.id IS NOT NULL AND proof.created_xid=pg_current_xact_id() AND proof.lease_version=OLD.lease_version AND proof.lease_owner=OLD.lease_owner
   AND OLD.lease_until>clock_timestamp() AND OLD.state IN('SUBMITTING','UNKNOWN') AND OLD.budget_disposition='ALLOCATED' AND NEW.budget_disposition='CONSUMED'
   AND NEW.lease_version=OLD.lease_version AND NEW.lease_owner=OLD.lease_owner AND NEW.lease_until=OLD.lease_until
   AND NEW.provider_refund_trx_no=proof.refund_transaction_no AND NEW.completed_at=proof.completed_at
   AND NEW.terminal_root_id='local_refund_root_'||substr(encode(sha256(convert_to(OLD.id,'UTF8')),'hex'),1,40)
   AND NEW.terminal_event_id='local_refund_paid_'||substr(encode(sha256(convert_to(OLD.id,'UTF8')),'hex'),1,40);
 ELSE
  allowed:=NEW.state='UNKNOWN' AND OLD.state IN('SUBMITTING','UNKNOWN') AND NEW.lease_version=OLD.lease_version
   AND NEW.lease_owner=OLD.lease_owner AND NEW.lease_until=OLD.lease_until AND OLD.lease_until>clock_timestamp()
   AND NEW.budget_disposition='ALLOCATED' AND num_nonnulls(NEW.demo_terminal_evidence_id,NEW.terminal_root_id,NEW.terminal_event_id,NEW.provider_refund_trx_no,NEW.completed_at)=0;
 END IF;
 IF allowed IS DISTINCT FROM true THEN RAISE EXCEPTION 'local refund requires current lease and original source evidence' USING ERRCODE='40001';END IF;
 NEW.updated_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER ecs_demo_refund_write_guard BEFORE INSERT OR UPDATE ON zzsh_order.channel_refund_intent
 FOR EACH ROW WHEN(NEW.payment_source='CONTROLLED' AND NEW.sandbox_registration_ref IS NOT NULL) EXECUTE FUNCTION zzsh_order.guard_sandbox_refund_intent();

--> statement-breakpoint
CREATE FUNCTION zzsh_order.guard_local_refund_source() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE i zzsh_order.channel_refund_intent;s zzsh_order.ecs_test_demo_finance_registration;op zzsh_order.local_controlled_refund_operation;doc jsonb;body jsonb;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=NEW.intent_id;
 SELECT * INTO s FROM zzsh_order.ecs_test_demo_finance_registration WHERE reference=NEW.sandbox_registration_ref AND active FOR SHARE;
 IF i.id IS NULL OR s.reference IS NULL OR i.sandbox_registration_ref IS DISTINCT FROM s.reference
  OR NOT zzsh_order.ecs_test_demo_finance_matches(s.registration_digest)
  OR i.payment_source<>'CONTROLLED' OR i.evidence_level<>'CONTROLLED_TEST' OR i.merchant_identity_id<>(CASE WHEN s.canonical_registration::jsonb->>'schema'='ecs-test-demo-finance.v1' THEN 'ecs_demo_' ELSE 'local_demo_' END)||substr(s.registration_digest,1,32)
 THEN RAISE EXCEPTION 'local refund source outside original registered intent' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-funds:v1','CONTROLLED',i.merchant_identity_id,i.original_payment_trx_no)::text,0));
 PERFORM id FROM zzsh_auth_user."user" WHERE id=i.renter_user_id FOR UPDATE;
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=NEW.intent_id FOR UPDATE;
 IF zzsh_order.local_controlled_refund_liability_complete(i.id) IS DISTINCT FROM true OR i.due_at>clock_timestamp()
  OR i.requires_review OR i.budget_disposition<>'ALLOCATED' OR i.lease_until IS NULL OR i.lease_until<=clock_timestamp()
 THEN RAISE EXCEPTION 'local refund source requires current frozen responsibility and live lease' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='local_controlled_refund_operation' THEN
  doc:=NEW.final_canonical::jsonb;
  IF i.state<>'SUBMITTING' OR NEW.original_lease_version<>i.lease_version OR NEW.original_lease_owner<>i.lease_owner
   OR NEW.id IS DISTINCT FROM 'local_refund_op_'||substr(encode(sha256(convert_to(i.id,'UTF8')),'hex'),1,40)
   OR NEW.refund_order_no<>i.refund_order_no OR NEW.original_payment_trx_no<>i.original_payment_trx_no OR NEW.amount_cents<>i.amount_cents
   OR NEW.currency<>'CNY' OR NEW.scenario<>'TIMEOUT_THEN_SUCCEED' OR zzsh_order.canonical_finance_json(doc)<>NEW.final_canonical
   OR jsonb_typeof(doc->'completedAt') IS DISTINCT FROM 'string' OR COALESCE(doc->>'completedAt','')!~'^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.][0-9]{3}Z$'
  THEN RAISE EXCEPTION 'local refund operation is not the original server-only simulated submit' USING ERRCODE='23514';END IF;
  body:=jsonb_build_object('mode','LOCAL_CONTROLLED','intentId',i.id,'refundOrderNo',i.refund_order_no,
   'originalPaymentTrxNo',i.original_payment_trx_no,'amountCents',i.amount_cents::text,'currency','CNY','terminal','SUCCEEDED',
   'refundTransactionNo','local_refund_trx_'||substr(encode(sha256(convert_to(i.id,'UTF8')),'hex'),1,40),'completedAt',doc->>'completedAt');
  IF doc IS DISTINCT FROM body OR (doc->>'completedAt')::timestamptz>clock_timestamp() OR (doc->>'completedAt')::timestamptz<i.created_at
   OR to_char((doc->>'completedAt')::timestamptz AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')<>doc->>'completedAt'
  THEN RAISE EXCEPTION 'local refund terminal truth cannot be selected by a client' USING ERRCODE='23514';END IF;
 ELSE
  SELECT * INTO op FROM zzsh_order.local_controlled_refund_operation WHERE id=NEW.operation_id AND intent_id=i.id;
  IF op.id IS NULL OR op.sandbox_registration_ref<>s.reference OR i.state NOT IN('SUBMITTING','UNKNOWN')
   OR NEW.lease_version<>i.lease_version OR NEW.lease_owner<>i.lease_owner OR NEW.terminal<>'SUCCEEDED'
   OR NEW.id IS DISTINCT FROM 'local_rfe_'||substr(encode(sha256(convert_to(i.id||':'||op.id,'UTF8')),'hex'),1,40)
   OR NEW.refund_transaction_no IS DISTINCT FROM op.final_canonical::jsonb->>'refundTransactionNo'
   OR NEW.completed_at IS DISTINCT FROM (op.final_canonical::jsonb->>'completedAt')::timestamptz
  THEN RAISE EXCEPTION 'local refund evidence requires the exact original operation and current query lease' USING ERRCODE='23514';END IF;
  body:=jsonb_build_object('evidenceId',NEW.id,'intentId',i.id,'postingId',i.posting_id,'orderId',i.order_id,
   'paymentConfirmationId',i.payment_confirmation_id,'renterUserId',i.renter_user_id,'merchantIdentityId',i.merchant_identity_id,
   'originalPaymentTrxNo',i.original_payment_trx_no,'originalPaymentOrderNo',i.original_payment_order_no,'responsibilityVersionHash',i.responsibility_version_hash,
   'refundOrderNo',i.refund_order_no,'amountCents',i.amount_cents::text,'currency','CNY','terminal','SUCCEEDED','refundTransactionNo',NEW.refund_transaction_no,
   'completedAt',to_char(NEW.completed_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'sourceObservationId',op.id)
   ||CASE WHEN i.basis_kind='PRESTART_TERMINATION' THEN jsonb_build_object('basisKind','PRESTART_TERMINATION') ELSE '{}'::jsonb END;
  IF zzsh_order.canonical_finance_json(body) IS DISTINCT FROM NEW.facts_canonical
  THEN RAISE EXCEPTION 'local refund evidence body differs from original frozen money' USING ERRCODE='23514';END IF;
 END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER local_refund_operation_guard BEFORE INSERT ON zzsh_order.local_controlled_refund_operation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_local_refund_source();
CREATE TRIGGER local_refund_evidence_guard BEFORE INSERT ON zzsh_order.local_controlled_refund_evidence FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_local_refund_source();

--> statement-breakpoint
CREATE FUNCTION zzsh_order.guard_local_refund_money() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE i zzsh_order.channel_refund_intent;e zzsh_order.local_controlled_refund_evidence;r zzsh_order.finance_economic_root;ev zzsh_order.finance_event;target text;revision_value bigint;expected_details jsonb;
BEGIN
 IF TG_TABLE_NAME='finance_economic_root' THEN target:=NEW.source_id;
 ELSIF TG_TABLE_NAME='finance_event' THEN SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;target:=r.source_id;
 ELSE target:=NEW.details->>'localRefundIntentId';SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=ev.economic_root_id;END IF;
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=target;
 SELECT * INTO e FROM zzsh_order.local_controlled_refund_evidence WHERE intent_id=target;
 IF i.id IS NULL OR e.id IS NULL OR e.created_xid<>pg_current_xact_id() OR e.terminal<>'SUCCEEDED'
  OR i.sandbox_registration_ref IS DISTINCT FROM e.sandbox_registration_ref OR zzsh_order.local_controlled_refund_liability_complete(target) IS DISTINCT FROM true
 THEN RAISE EXCEPTION 'local refund money requires same transaction original local evidence' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='finance_economic_root' THEN
  IF NEW.id IS DISTINCT FROM 'local_refund_root_'||substr(encode(sha256(convert_to(i.id,'UTF8')),'hex'),1,40)
   OR NEW.source_kind<>'LOCAL_CONTROLLED_RENTAL_REFUND' OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh-local-controlled'
   OR NEW.source_entity<>'channel_refund_intent' OR NEW.source_id<>i.id OR NEW.subject_user_id<>i.renter_user_id OR NEW.beneficiary_role<>'RENTER'
   OR NEW.basis_id IS NOT NULL OR NEW.policy_version IS NOT NULL OR NEW.source_digest<>e.facts_digest
  THEN RAISE EXCEPTION 'local refund root source differs' USING ERRCODE='23514';END IF;
  NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();
 ELSIF TG_TABLE_NAME='finance_event' THEN
  PERFORM id FROM zzsh_auth_user."user" WHERE id=i.renter_user_id FOR UPDATE;
  SELECT ledger_revision INTO revision_value FROM zzsh_order.wallet_revision WHERE user_id=i.renter_user_id;
  IF r.id IS NULL OR r.source_kind<>'LOCAL_CONTROLLED_RENTAL_REFUND' OR r.created_xid<>pg_current_xact_id()
   OR NEW.id IS DISTINCT FROM 'local_refund_paid_'||substr(encode(sha256(convert_to(i.id,'UTF8')),'hex'),1,40)
   OR NEW.kind<>'REFUND_PAID' OR NEW.subject_user_id<>i.renter_user_id OR NEW.expected_ledger_revision IS DISTINCT FROM revision_value
  THEN RAISE EXCEPTION 'local refund event differs from original liability revision' USING ERRCODE='23514';END IF;
  NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();
 ELSE
  expected_details:=jsonb_build_object('localRefundIntentId',i.id,'postingId',i.posting_id,'paymentConfirmationId',i.payment_confirmation_id,
   'refundOrderNo',i.refund_order_no,'factsDigest',e.facts_digest,'dataOrigin','LOCAL_CONTROLLED','orderId',i.order_id);
  IF r.id IS NULL OR r.source_kind<>'LOCAL_CONTROLLED_RENTAL_REFUND' OR ev.id IS NULL OR ev.kind<>'REFUND_PAID'
   OR ev.created_xid<>pg_current_xact_id() OR r.created_xid<>pg_current_xact_id() OR ev.subject_user_id<>i.renter_user_id
   OR NEW.posting_id IS NOT NULL OR NEW.source_payment_confirmation_id IS NOT NULL OR NEW.details IS DISTINCT FROM expected_details
   OR NOT((NEW.line_no=1 AND NEW.account_code='RENTER_REFUND_PAYABLE' AND NEW.debit_cents=i.amount_cents AND NEW.credit_cents=0 AND NEW.counterparty_user_id=i.renter_user_id)
    OR(NEW.line_no=2 AND NEW.account_code='PAYOUT_CLEARING' AND NEW.debit_cents=0 AND NEW.credit_cents=i.amount_cents AND NEW.counterparty_user_id IS NULL))
  THEN RAISE EXCEPTION 'local refund entries differ from frozen responsibility consumption' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER local_refund_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root
 FOR EACH ROW WHEN(NEW.source_kind='LOCAL_CONTROLLED_RENTAL_REFUND') EXECUTE FUNCTION zzsh_order.guard_local_refund_money();
-- Route only the new deterministic local prefix; an unknown/non-local root under that prefix fails the local guard.
DROP TRIGGER native_refund_event_guard ON zzsh_order.finance_event;
CREATE TRIGGER native_refund_event_guard BEFORE INSERT ON zzsh_order.finance_event
 FOR EACH ROW WHEN(NEW.kind='REFUND_PAID' AND left(NEW.id,18)<>'local_refund_paid_') EXECUTE FUNCTION zzsh_order.guard_native_refund_event();
CREATE TRIGGER local_refund_event_guard BEFORE INSERT ON zzsh_order.finance_event
 FOR EACH ROW WHEN(NEW.kind='REFUND_PAID' AND left(NEW.id,18)='local_refund_paid_') EXECUTE FUNCTION zzsh_order.guard_local_refund_money();
CREATE TRIGGER local_refund_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry
 FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'localRefundIntentId') EXECUTE FUNCTION zzsh_order.guard_local_refund_money();
-- The one existing native_refund_wallet_revision trigger still runs on REFUND_PAID. Never install a second revision trigger.
-- The 0174 generic entry guards already exclude localRefundIntentId and legacy refund IDs.

--> statement-breakpoint
CREATE FUNCTION zzsh_order.local_controlled_refund_terminal_complete(target text) RETURNS boolean LANGUAGE plpgsql VOLATILE AS $$
DECLARE i zzsh_order.channel_refund_intent;e zzsh_order.local_controlled_refund_evidence;r zzsh_order.finance_economic_root;ev zzsh_order.finance_event;
 lines bigint;good bigint;dr numeric;cr numeric;revision_value bigint;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=target;
 SELECT * INTO e FROM zzsh_order.local_controlled_refund_evidence WHERE intent_id=target;
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=i.terminal_root_id;
 SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=i.terminal_event_id;
 SELECT ledger_revision INTO revision_value FROM zzsh_order.wallet_revision WHERE user_id=i.renter_user_id;
 IF i.id IS NULL OR e.id IS NULL OR r.id IS NULL OR ev.id IS NULL OR revision_value IS NULL
  OR i.state<>'SUCCEEDED' OR i.budget_disposition<>'CONSUMED' OR i.demo_terminal_evidence_id IS DISTINCT FROM e.id
  OR i.provider_refund_trx_no IS DISTINCT FROM e.refund_transaction_no OR i.completed_at IS DISTINCT FROM e.completed_at
  OR i.sandbox_registration_ref IS DISTINCT FROM e.sandbox_registration_ref OR e.terminal<>'SUCCEEDED'
  OR r.source_kind<>'LOCAL_CONTROLLED_RENTAL_REFUND' OR r.source_type<>'NATIVE' OR r.source_system<>'zzsh-local-controlled'
  OR r.source_entity<>'channel_refund_intent' OR r.source_id<>i.id OR r.subject_user_id<>i.renter_user_id OR r.source_digest<>e.facts_digest
  OR r.beneficiary_role<>'RENTER' OR r.basis_id IS NOT NULL OR r.policy_version IS NOT NULL OR r.created_xid<>e.created_xid
  OR ev.kind<>'REFUND_PAID' OR ev.economic_root_id<>r.id OR ev.subject_user_id<>i.renter_user_id OR ev.created_xid<>e.created_xid
  OR revision_value<ev.expected_ledger_revision+1 OR(SELECT count(*) FROM zzsh_order.finance_event WHERE economic_root_id=r.id)<>1
  OR zzsh_order.local_controlled_refund_liability_complete(target) IS DISTINCT FROM true
 THEN RETURN false;END IF;
 SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0),count(*) FILTER(WHERE posting_id IS NULL AND source_payment_confirmation_id IS NULL
  AND details=jsonb_build_object('localRefundIntentId',i.id,'postingId',i.posting_id,'paymentConfirmationId',i.payment_confirmation_id,
   'refundOrderNo',i.refund_order_no,'factsDigest',e.facts_digest,'dataOrigin','LOCAL_CONTROLLED','orderId',i.order_id)
  AND((line_no=1 AND account_code='RENTER_REFUND_PAYABLE' AND debit_cents=i.amount_cents AND credit_cents=0 AND counterparty_user_id=i.renter_user_id)
   OR(line_no=2 AND account_code='PAYOUT_CLEARING' AND debit_cents=0 AND credit_cents=i.amount_cents AND counterparty_user_id IS NULL)))
  INTO lines,dr,cr,good FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=ev.id;
 RETURN lines=2 AND good=2 AND dr=i.amount_cents AND cr=i.amount_cents
  AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.refund.liability.consumed' AND a.object_type='channel_refund_intent' AND a.object_id=i.id AND a.outcome='SUCCESS'
   AND a.details->>'evidenceId'=e.id AND a.details->>'factsDigest'=e.facts_digest AND a.details->>'budgetDisposition'='CONSUMED'
   AND a.details->>'paymentConfirmationId'=i.payment_confirmation_id AND a.details->>'amountCents'=i.amount_cents::text AND a.details->>'currency'='CNY'
   AND a.details->>'channelArrival'='UNKNOWN' AND a.details->>'dataOrigin'='LOCAL_CONTROLLED');
END $$;

--> statement-breakpoint
CREATE FUNCTION zzsh_order.check_local_refund_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text;i zzsh_order.channel_refund_intent;r zzsh_order.finance_economic_root;
BEGIN
 IF TG_TABLE_NAME='channel_refund_intent' THEN target:=NEW.id;
 ELSIF TG_TABLE_NAME IN('local_controlled_refund_operation','local_controlled_refund_evidence') THEN target:=NEW.intent_id;
 ELSIF TG_TABLE_NAME='finance_economic_root' THEN target:=NEW.source_id;
 ELSIF TG_TABLE_NAME='finance_event' THEN SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;target:=r.source_id;
 ELSE target:=NEW.details->>'localRefundIntentId';END IF;
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=target;
 IF i.id IS NULL OR i.sandbox_registration_ref IS NULL OR i.payment_source<>'CONTROLLED' THEN RAISE EXCEPTION 'local refund closure source missing' USING ERRCODE='23514';END IF;
 IF i.state='SUCCEEDED' THEN
  IF zzsh_order.local_controlled_refund_terminal_complete(target) IS DISTINCT FROM true THEN RAISE EXCEPTION 'local refund terminal batch incomplete' USING ERRCODE='23514';END IF;
 ELSIF i.state NOT IN('READY','SUBMITTING','UNKNOWN') OR i.budget_disposition<>'ALLOCATED'
  OR EXISTS(SELECT 1 FROM zzsh_order.local_controlled_refund_evidence WHERE intent_id=target)
  OR EXISTS(SELECT 1 FROM zzsh_order.finance_economic_root WHERE source_kind='LOCAL_CONTROLLED_RENTAL_REFUND' AND source_id=target)
 THEN RAISE EXCEPTION 'uncertain local refund cannot release or consume responsibility' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER local_refund_intent_closure AFTER INSERT OR UPDATE ON zzsh_order.channel_refund_intent DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN(NEW.sandbox_registration_ref IS NOT NULL) EXECUTE FUNCTION zzsh_order.check_local_refund_closure();
CREATE CONSTRAINT TRIGGER local_refund_operation_closure AFTER INSERT ON zzsh_order.local_controlled_refund_operation DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_local_refund_closure();
CREATE CONSTRAINT TRIGGER local_refund_evidence_closure AFTER INSERT ON zzsh_order.local_controlled_refund_evidence DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_local_refund_closure();
CREATE CONSTRAINT TRIGGER local_refund_root_closure AFTER INSERT ON zzsh_order.finance_economic_root DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN(NEW.source_kind='LOCAL_CONTROLLED_RENTAL_REFUND') EXECUTE FUNCTION zzsh_order.check_local_refund_closure();
DROP TRIGGER native_refund_event_closure ON zzsh_order.finance_event;
CREATE CONSTRAINT TRIGGER native_refund_event_closure AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN(NEW.kind='REFUND_PAID' AND left(NEW.id,18)<>'local_refund_paid_') EXECUTE FUNCTION zzsh_order.check_native_refund_closure();
CREATE CONSTRAINT TRIGGER local_refund_event_closure AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN(NEW.kind='REFUND_PAID' AND left(NEW.id,18)='local_refund_paid_') EXECUTE FUNCTION zzsh_order.check_local_refund_closure();
CREATE CONSTRAINT TRIGGER local_refund_entry_closure AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED
 FOR EACH ROW WHEN(NEW.details?'localRefundIntentId') EXECUTE FUNCTION zzsh_order.check_local_refund_closure();
REVOKE ALL ON FUNCTION zzsh_order.local_controlled_refund_liability_complete(text),zzsh_order.guard_sandbox_refund_intent(),
 zzsh_order.guard_local_refund_source(),zzsh_order.guard_local_refund_money(),zzsh_order.local_controlled_refund_terminal_complete(text),zzsh_order.check_local_refund_closure() FROM PUBLIC;


COMMENT ON COLUMN zzsh_order.channel_refund_intent.sandbox_registration_ref IS '模拟退款对应的测试环境登记标识；不表示汇聚到账。';
COMMENT ON COLUMN zzsh_order.channel_refund_intent.demo_terminal_evidence_id IS '模拟退款结果标识，独立于真实汇聚退款凭据。';
COMMENT ON TABLE zzsh_order.local_controlled_refund_operation IS '测试环境模拟退款操作，不是汇聚退款或银行到账凭据。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_operation.id IS '模拟退款操作标识。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_operation.intent_id IS '关联的原退款责任申请标识。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_operation.sandbox_registration_ref IS '对应测试环境登记标识。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_operation.scenario IS '模拟执行场景。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_operation.refund_order_no IS '原退款申请编号。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_operation.original_payment_trx_no IS '原模拟付款事件编号。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_operation.amount_cents IS '模拟退款金额，单位为分。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_operation.currency IS '模拟退款币种。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_operation.final_canonical IS '冻结的模拟结果规范化内容。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_operation.final_digest IS '模拟结果规范化内容的 SHA-256 摘要。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_operation.original_lease_version IS '执行该模拟操作的原租约版本。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_operation.original_lease_owner IS '执行该模拟操作的原租约持有者。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_operation.created_xid IS '写入该操作的数据库事务标识。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_operation.created_at IS '数据库记录该模拟操作的时间。';
COMMENT ON TABLE zzsh_order.local_controlled_refund_evidence IS '测试环境模拟退款结果证据，不代表真实渠道退款到账。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_evidence.id IS '模拟退款结果标识。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_evidence.intent_id IS '关联的原退款责任申请标识。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_evidence.operation_id IS '对应的原模拟退款操作标识。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_evidence.sandbox_registration_ref IS '对应测试环境登记标识。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_evidence.terminal IS '模拟操作的终态。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_evidence.refund_transaction_no IS '模拟退款事件编号，不是渠道流水号。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_evidence.completed_at IS '模拟操作完成时间。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_evidence.facts_canonical IS '冻结的模拟结果事实规范化内容。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_evidence.facts_digest IS '模拟结果事实的 SHA-256 摘要。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_evidence.lease_version IS '消费该结果使用的租约版本。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_evidence.lease_owner IS '消费该结果使用的租约持有者。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_evidence.created_xid IS '写入该结果的数据库事务标识。';
COMMENT ON COLUMN zzsh_order.local_controlled_refund_evidence.created_at IS '数据库记录该模拟结果的时间。';
