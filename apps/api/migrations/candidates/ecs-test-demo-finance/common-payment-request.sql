-- Test database only: reuse the normal request tables without claiming provider evidence.
DO $guard$
DECLARE marker text; schema_owner name;
BEGIN
  SELECT shobj_description(d.oid,'pg_database'),pg_get_userbyid(n.nspowner)
    INTO marker,schema_owner FROM pg_database d JOIN pg_namespace n ON n.nspname='zzsh_order' WHERE d.datname=current_database();
  IF (current_database() ~ '^zzsh_ecs_test(_[a-z0-9_]{1,32})?$' AND marker='zzsh:ecs-test:v1'
    OR current_database()='zzsh_test_r07_delivery_20261108' AND marker='zzsh:r07-delivery-clone:v1') IS NOT TRUE
    OR current_user <> schema_owner OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=current_user
      AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication))
    OR to_regclass('zzsh_order.ecs_test_demo_finance_registration') IS NULL
    OR to_regprocedure('zzsh_order.ecs_test_demo_finance_matches(text)') IS NULL THEN
    RAISE EXCEPTION 'Exact registered test database and schema owner required';
  END IF;
END
$guard$;

ALTER TABLE zzsh_order.payment_request DROP CONSTRAINT production_real_payment_request,
  ADD CONSTRAINT production_real_payment_request CHECK ((channel='JOINPAY' AND evidence_level='JOINPAY_CANDIDATE') OR (channel='CONTROLLED' AND evidence_level='CONTROLLED_TEST'));
ALTER TABLE zzsh_order.payment_channel_observation DROP CONSTRAINT production_real_payment_observation,
  ADD CONSTRAINT production_real_payment_observation CHECK ((channel='JOINPAY' AND evidence_level='UNVERIFIED') OR (channel='CONTROLLED' AND evidence_level='CONTROLLED_TEST'));
ALTER TABLE zzsh_order.payment_channel_transaction DROP CONSTRAINT production_real_payment_transaction,
  ADD CONSTRAINT production_real_payment_transaction CHECK ((channel='JOINPAY' AND evidence_level='JOINPAY_VERIFIED') OR (channel='CONTROLLED' AND evidence_level='CONTROLLED_TEST'));

CREATE FUNCTION zzsh_order.guard_test_channel_operation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,zzsh_order AS $fn$
DECLARE s zzsh_order.ecs_test_demo_finance_registration; r zzsh_order.payment_request;
BEGIN
  IF NEW.channel IS DISTINCT FROM 'CONTROLLED' OR NEW.evidence_level IS DISTINCT FROM 'CONTROLLED_TEST' THEN
    RAISE EXCEPTION 'test runtime cannot create or change provider records' USING ERRCODE='23514';
  END IF;
  SELECT * INTO s FROM zzsh_order.ecs_test_demo_finance_registration
   WHERE active AND NEW.merchant_identity_id=(CASE WHEN canonical_registration::jsonb->>'schema'='ecs-test-demo-finance.v1'
     THEN 'ecs_demo_' ELSE 'local_demo_' END)||substr(registration_digest,1,32);
  IF s.reference IS NULL OR NOT zzsh_order.ecs_test_demo_finance_matches(s.registration_digest) THEN
    RAISE EXCEPTION 'test channel registration not active' USING ERRCODE='23514';
  END IF;
  IF TG_TABLE_NAME='payment_request' THEN
    IF NEW.config_profile_id IS DISTINCT FROM NEW.merchant_identity_id OR NEW.protocol_version<>'TEST_CASHIER_V1'
      OR NEW.key_version_ref<>'NO_REAL_PROVIDER' OR NOT EXISTS(
        SELECT 1 FROM zzsh_order.rental_order o JOIN zzsh_order.distribution_order_admission a ON a.order_id=o.id
         WHERE o.id=NEW.order_id AND o.display_no=NEW.platform_order_no AND o.currency=NEW.currency
           AND o.rental_amount_cents+o.deposit_amount_cents=NEW.amount_cents AND a.mode='LOCAL_CONTROLLED'
           AND a.approval_digest=s.registration_digest AND a.active
           AND (TG_OP<>'INSERT' OR (o.status='PENDING_PAYMENT' AND o.hold_until>clock_timestamp() AND o.paid_confirmation_id IS NULL))) THEN
      RAISE EXCEPTION 'test request differs from admitted order' USING ERRCODE='23514';
    END IF;
  ELSE
    SELECT * INTO r FROM zzsh_order.payment_request WHERE id=NEW.request_id AND channel='CONTROLLED'
      AND evidence_level='CONTROLLED_TEST' AND merchant_identity_id=NEW.merchant_identity_id;
    IF r.id IS NULL THEN RAISE EXCEPTION 'original test request required' USING ERRCODE='23514'; END IF;
    IF TG_TABLE_NAME='payment_channel_observation' THEN
      IF NEW.channel_order_no IS DISTINCT FROM r.channel_order_no OR NEW.config_profile_id IS DISTINCT FROM r.config_profile_id
        OR NEW.protocol_version IS DISTINCT FROM r.protocol_version OR NEW.key_version_ref IS DISTINCT FROM r.key_version_ref
        OR NEW.channel_status IS NOT NULL OR NEW.provider_paid_at_raw IS NOT NULL OR NEW.verify_outcome IS NOT NULL
        OR NOT ((NEW.operation='SYNC_RESPONSE' AND NEW.source='EXECUTOR' AND NEW.event='E1' AND NEW.result='ACTION_READY')
          OR (NEW.operation='ACCEPTANCE' AND NEW.source='ACCEPTANCE_GATE' AND NEW.event IN ('E7','E8'))) THEN
        RAISE EXCEPTION 'test observation differs from request' USING ERRCODE='23514';
      END IF;
    ELSIF TG_TABLE_NAME='payment_channel_transaction' THEN
      IF NEW.native_order_id IS DISTINCT FROM r.order_id OR NEW.confirmation_id IS NULL OR NOT EXISTS(
        SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.id=NEW.confirmation_id AND p.order_id=r.order_id
          AND p.source='CONTROLLED' AND p.merchant_scope_id=r.merchant_identity_id AND p.provider_transaction_id=NEW.channel_trx_no
          AND p.amount_cents=r.amount_cents AND p.currency=r.currency) THEN
        RAISE EXCEPTION 'test transaction requires original confirmed request' USING ERRCODE='23514';
      END IF;
    ELSE RAISE EXCEPTION 'unsupported test channel table'; END IF;
  END IF;
  RETURN NEW;
END
$fn$;
COMMENT ON FUNCTION zzsh_order.guard_test_channel_operation() IS '限定测试渠道请求、观察和交易锚点属于当前隔离测试环境，不代表汇聚渠道事实。';
CREATE TRIGGER test_channel_request_guard BEFORE INSERT OR UPDATE ON zzsh_order.payment_request FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_test_channel_operation();
CREATE TRIGGER test_channel_observation_guard BEFORE INSERT ON zzsh_order.payment_channel_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_test_channel_operation();
CREATE TRIGGER test_channel_transaction_guard BEFORE INSERT ON zzsh_order.payment_channel_transaction FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_test_channel_operation();

CREATE FUNCTION zzsh_order.check_test_channel_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,zzsh_order AS $fn$
BEGIN
  IF NEW.channel='CONTROLLED' AND NEW.state IS DISTINCT FROM OLD.state THEN
    IF NOT ((OLD.state='SUBMITTING' AND NEW.state='ACTION_READY') OR
      (OLD.state='ACTION_READY' AND NEW.state IN ('ACCEPTED','REVIEW_REQUIRED'))) OR NOT EXISTS(
        SELECT 1 FROM zzsh_order.payment_channel_observation o WHERE o.request_id=NEW.id AND o.channel='CONTROLLED'
          AND o.evidence_level='CONTROLLED_TEST' AND o.state_before=OLD.state AND o.state_after=NEW.state
          AND ((NEW.state='ACTION_READY' AND o.event='E1' AND o.result='ACTION_READY') OR
            (NEW.state='ACCEPTED' AND o.event='E7' AND o.result='APPLIED') OR
            (NEW.state='REVIEW_REQUIRED' AND o.event='E8' AND o.result='REVIEW_REQUIRED'))) THEN
      RAISE EXCEPTION 'test request transition requires its original observation' USING ERRCODE='23514';
    END IF;
    IF NEW.state IN ('ACCEPTED','REVIEW_REQUIRED') AND NOT EXISTS(
      SELECT 1 FROM zzsh_order.payment_channel_transaction t JOIN zzsh_order.payment_confirmation p ON p.id=t.confirmation_id
       WHERE t.request_id=NEW.id AND t.channel='CONTROLLED' AND t.evidence_level='CONTROLLED_TEST'
         AND p.order_id=NEW.order_id AND p.source='CONTROLLED'
         AND p.disposition=CASE WHEN NEW.state='ACCEPTED' THEN 'APPLIED' ELSE 'REVIEW_REQUIRED' END) THEN
      RAISE EXCEPTION 'test terminal transition requires its original confirmation' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NULL;
END
$fn$;
COMMENT ON FUNCTION zzsh_order.check_test_channel_transition() IS '测试支付请求状态变化须绑定对应模拟观察；终态还须绑定原付款确认。';
CREATE CONSTRAINT TRIGGER test_channel_transition_guard AFTER UPDATE ON zzsh_order.payment_request
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_test_channel_transition();

DO $grant$
DECLARE runtime_role text;
BEGIN
  SELECT canonical_registration::jsonb #>> '{resource,runtimeRole}' INTO runtime_role
    FROM zzsh_order.ecs_test_demo_finance_registration WHERE active;
  IF runtime_role !~ '^[a-z][a-z0-9_]{0,62}$' OR runtime_role=current_user THEN RAISE EXCEPTION 'Distinct active test runtime required'; END IF;
  EXECUTE format('GRANT INSERT(id,order_id,channel,merchant_identity_id,config_profile_id,protocol_version,key_version_ref,platform_order_no,channel_order_no,amount_cents,currency,wire_amount_yuan,method,evidence_level,idempotency_scope_key,idempotency_key,request_fingerprint) ON zzsh_order.payment_request TO %I',runtime_role);
  EXECUTE format('GRANT UPDATE(state,revision,updated_at) ON zzsh_order.payment_request TO %I',runtime_role);
  EXECUTE format('GRANT INSERT(id,request_id,channel,merchant_identity_id,channel_order_no,channel_trx_no,config_profile_id,protocol_version,key_version_ref,operation,source,evidence_level,event,result,reason,channel_status,provider_paid_at_raw,raw_sha256,raw_ref,verify_outcome,lease_version,state_before,state_after,stale,late,conflict) ON zzsh_order.payment_channel_observation TO %I',runtime_role);
  EXECUTE format('GRANT INSERT(id,channel,merchant_identity_id,channel_trx_no,order_origin,native_order_id,request_id,confirmation_id,evidence_level) ON zzsh_order.payment_channel_transaction TO %I',runtime_role);
END
$grant$;
