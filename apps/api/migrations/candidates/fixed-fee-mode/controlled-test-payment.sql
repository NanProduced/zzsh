-- Apply only to the registered fixed-fee synthetic database, inside the verification transaction.
DO $fixed_fee_test$
DECLARE
  existing_check text;
  guard_source text;
  anchor text := 'OR (current_database()=''zzsh_test_regression''';
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_database d JOIN pg_roles r ON r.rolname=current_user
    WHERE d.datname=current_database() AND d.datname='zzsh_test_supply_fixed_fee' AND d.oid=3513966
      AND shobj_description(d.oid,'pg_database')='zzsh:synthetic:fixed-fee:v1'
      AND r.rolname='zzsh_m3b_fixed_fee_m' AND r.oid=3513964
      AND shobj_description(r.oid,'pg_authid')='zzsh:synthetic:fixed-fee:v1:zzsh_test_supply_fixed_fee:migration'
      AND NOT r.rolsuper AND NOT r.rolbypassrls
  ) THEN RAISE EXCEPTION 'fixed-fee test migration resource differs' USING ERRCODE='42501'; END IF;

  SELECT pg_get_expr(conbin,conrelid) INTO STRICT existing_check FROM pg_constraint
    WHERE conrelid='zzsh_order.distribution_order_admission'::regclass AND conname='distribution_admission_mode_shape'
      AND contype='c' AND convalidated;
  SELECT pg_get_functiondef('zzsh_order.guard_distribution_order_admission()'::regprocedure) INTO STRICT guard_source;
  IF array_length(string_to_array(guard_source,anchor),1) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'controlled distribution admission contract changed' USING ERRCODE='40001';
  END IF;

  ALTER TABLE zzsh_order.distribution_order_admission DROP CONSTRAINT distribution_admission_mode_shape;
  EXECUTE format($constraint$ALTER TABLE zzsh_order.distribution_order_admission ADD CONSTRAINT distribution_admission_mode_shape
    CHECK ((%s) OR (mode='LOCAL_CONTROLLED' AND resource_name='zzsh_test_supply_fixed_fee' AND resource_oid=3513966
      AND resource_marker='zzsh:synthetic:fixed-fee:v1' AND created_by_admin_id IS NOT NULL AND source_admission_ref IS NULL))$constraint$, existing_check);

  EXECUTE replace(guard_source, anchor, $branch$OR (current_database()='zzsh_test_supply_fixed_fee' AND current_user='zzsh_m3b_fixed_fee_m'
    AND NEW.mode='LOCAL_CONTROLLED' AND NEW.resource_oid=3513966 AND NEW.resource_marker='zzsh:synthetic:fixed-fee:v1'
    AND NEW.revision=1 AND NEW.active AND NEW.admitted_at<=clock_timestamp()
    AND NEW.expires_at>clock_timestamp() AND NEW.expires_at<=clock_timestamp()+interval '1 day'
    AND EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=current_user AND r.oid=3513964
      AND shobj_description(r.oid,'pg_authid')='zzsh:synthetic:fixed-fee:v1:zzsh_test_supply_fixed_fee:migration')
    AND EXISTS(SELECT 1 FROM zzsh_order.rental_order o JOIN zzsh_iam.audit_event a ON a.id=NEW.native_creation_audit_id
      WHERE o.id=NEW.order_id AND o.quote_snapshot#>>'{personal,schema}'='personal-quote-v5'
        AND a.actor_type='user' AND a.actor_id=o.renter_user_id AND a.action='order.reservation.created'
        AND a.object_type='rental_order' AND a.object_id=o.id AND a.outcome='SUCCESS'))
  $branch$ || anchor);

  ALTER TABLE zzsh_order.distribution_order_admission DROP CONSTRAINT production_native_order_admission,
    ADD CONSTRAINT production_native_order_admission CHECK (mode='NATIVE' OR
      (mode='LOCAL_CONTROLLED' AND resource_name='zzsh_test_supply_fixed_fee' AND resource_oid=3513966
       AND resource_marker='zzsh:synthetic:fixed-fee:v1'));
  ALTER TABLE zzsh_order.payment_confirmation DROP CONSTRAINT production_real_payment_source,
    ADD CONSTRAINT production_real_payment_source CHECK (source='JOINPAY' OR
      (source='CONTROLLED' AND merchant_scope_id='fixed-fee-isolated'));
  ALTER TABLE zzsh_order.payment_channel_transaction DROP CONSTRAINT production_real_payment_transaction,
    ADD CONSTRAINT production_real_payment_transaction CHECK ((channel='JOINPAY' AND evidence_level='JOINPAY_VERIFIED') OR
      (channel='CONTROLLED' AND evidence_level='CONTROLLED_TEST' AND merchant_identity_id='fixed-fee-isolated'));
  ALTER TABLE zzsh_order.channel_refund_intent DROP CONSTRAINT production_real_refund_source,
    ADD CONSTRAINT production_real_refund_source CHECK (payment_source='JOINPAY' OR
      (payment_source='CONTROLLED' AND evidence_level='CONTROLLED_TEST' AND merchant_identity_id='fixed-fee-isolated'));
END $fixed_fee_test$;
