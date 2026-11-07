-- Enable only the existing controlled prestart refund branch in an installed demo schema.
DO $guard$
DECLARE db record; definition text;
BEGIN
 SELECT pg_get_userbyid(n.nspowner) AS owner,shobj_description(d.oid,'pg_database') AS marker INTO db
  FROM pg_database d JOIN pg_namespace n ON n.nspname='zzsh_order' WHERE d.datname=current_database();
 IF (current_database() ~ '^zzsh_ecs_test(_[a-z0-9_]{1,32})?$' AND db.marker='zzsh:ecs-test:v1'
   OR current_database()='zzsh_test_r07_delivery_20261108' AND db.marker='zzsh:r07-delivery-clone:v1') IS NOT TRUE
   OR db.owner<>current_user OR to_regprocedure('zzsh_order.local_controlled_refund_liability_complete(text)') IS NULL
   OR to_regprocedure('zzsh_order.ecs_test_demo_finance_matches(text)') IS NULL THEN RAISE EXCEPTION 'Exact demo refund resource required';END IF;
 SELECT pg_get_expr(conbin,conrelid) INTO definition FROM pg_constraint
  WHERE conrelid='zzsh_order.channel_refund_intent'::regclass AND conname='sandbox_refund_source_reference' AND convalidated;
 IF definition IS NULL OR position('POSTING' IN definition)=0 OR position('PRESTART_TERMINATION' IN definition)>0
  OR position('CONTROLLED_TEST' IN definition)=0 THEN RAISE EXCEPTION 'Original demo refund constraint differs';END IF;
 ALTER TABLE zzsh_order.channel_refund_intent DROP CONSTRAINT sandbox_refund_source_reference;
 ALTER TABLE zzsh_order.channel_refund_intent ADD CONSTRAINT sandbox_refund_source_reference
  CHECK(sandbox_registration_ref IS NULL OR(payment_source='CONTROLLED' AND evidence_level='CONTROLLED_TEST' AND basis_kind IN('POSTING','PRESTART_TERMINATION')));
END $guard$;
