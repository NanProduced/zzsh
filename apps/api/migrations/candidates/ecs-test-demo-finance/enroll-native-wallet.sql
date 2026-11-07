-- Enroll this test database only; the existing wallet function still requires
-- a new native user INSERT proof in the same transaction. No user balance is seeded here.
DO $enroll$
DECLARE s zzsh_order.ecs_test_demo_finance_registration; doc jsonb; actual record; added integer;
BEGIN
 SELECT db.oid::text AS oid,db.datname,shobj_description(db.oid,'pg_database') AS marker,
   pg_get_userbyid(db.datdba) AS db_owner,pg_get_userbyid(n.nspowner) AS schema_owner,
   (SELECT system_identifier::text FROM pg_control_system()) AS system_id
  INTO actual FROM pg_database db JOIN pg_namespace n ON n.nspname='zzsh_order' WHERE db.datname=current_database();
 IF current_user<>actual.schema_owner OR (current_database() ~ '^zzsh_ecs_test(_[a-z0-9_]{1,32})?$' AND actual.marker='zzsh:ecs-test:v1'
   OR current_database()='zzsh_test_r07_delivery_20261108' AND actual.marker='zzsh:r07-delivery-clone:v1') IS NOT TRUE THEN
   RAISE EXCEPTION 'Exact test schema owner required';
 END IF;
 SELECT * INTO s FROM zzsh_order.ecs_test_demo_finance_registration WHERE active FOR SHARE;
 IF s.reference IS NULL OR s.registration_digest<>encode(sha256(convert_to(s.canonical_registration,'UTF8')),'hex') THEN
   RAISE EXCEPTION 'Active test registration required';
 END IF;
 doc:=s.canonical_registration::jsonb;
 IF doc #>> '{resource,database}' IS DISTINCT FROM actual.datname OR doc #>> '{resource,databaseOid}' IS DISTINCT FROM actual.oid
   OR doc #>> '{resource,marker}' IS DISTINCT FROM actual.marker OR doc #>> '{resource,owner}' IS DISTINCT FROM actual.db_owner
   OR doc #>> '{resource,migrationRole}' IS DISTINCT FROM current_user::text OR doc #>> '{resource,systemIdentifier}' IS DISTINCT FROM actual.system_id
   OR (actual.marker='zzsh:r07-delivery-clone:v1' AND doc->>'nonce' IS DISTINCT FROM current_setting('zzsh.regression_run',true)) THEN
   RAISE EXCEPTION 'Test wallet resource differs from enrolled database';
 END IF;
 INSERT INTO zzsh_order.native_origin_resource_admission(resource_oid,database_name,runtime_role,resource_marker)
  VALUES(actual.oid::oid,actual.datname,doc #>> '{resource,runtimeRole}',actual.marker) ON CONFLICT(resource_oid) DO NOTHING;
 GET DIAGNOSTICS added=ROW_COUNT;
 IF NOT EXISTS(SELECT 1 FROM zzsh_order.native_origin_resource_admission a WHERE a.resource_oid=actual.oid::oid
   AND a.database_name=actual.datname AND a.runtime_role=doc #>> '{resource,runtimeRole}' AND a.resource_marker=actual.marker) THEN
   RAISE EXCEPTION 'Existing native wallet admission differs';
 END IF;
 IF added=1 THEN
  INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,action,object_type,object_id,outcome,request_id,occurred_at,details)
   VALUES('audit_demo_wallet_origin_'||replace(gen_random_uuid()::text,'-',''),'system',current_user,'demo.wallet_origin.enrolled',
    'native_origin_resource_admission',actual.oid,'SUCCESS','demo_wallet_origin_enroll',clock_timestamp(),
    jsonb_build_object('registration',s.reference,'registrationDigest',s.registration_digest,'databaseOid',actual.oid,'bankArrival','UNKNOWN'));
 END IF;
END
$enroll$;
