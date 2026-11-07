-- Test-only extension. Run as the exact registered demo database owner after
-- registration.sql and the controlled payment base objects have been installed.
-- No JOINPAY observation, request, or channel transaction is created here.
DO $guard$
DECLARE marker text; db_owner name;
BEGIN
  SELECT shobj_description(d.oid,'pg_database'),pg_get_userbyid(n.nspowner) INTO marker,db_owner
    FROM pg_database d JOIN pg_namespace n ON n.nspname='zzsh_order' WHERE d.datname=current_database();
  IF (current_database() ~ '^zzsh_ecs_test(_[a-z0-9_]{1,32})?$' AND marker='zzsh:ecs-test-demo-finance:v1'
    OR current_database()='zzsh_test_r07_delivery_20261108' AND marker='zzsh:r07-delivery-clone:v1') IS NOT TRUE OR current_user <> db_owner
    OR to_regclass('zzsh_order.ecs_test_demo_finance_registration') IS NULL
    OR to_regclass('zzsh_order.controlled_payment_declaration') IS NULL THEN
    RAISE EXCEPTION 'Exact registered demo database and controlled payment schema required';
  END IF;
END
$guard$;

-- Existing real-source restrictions remain for all non-demo rows in this copied database.
ALTER TABLE zzsh_order.distribution_order_admission DROP CONSTRAINT production_native_order_admission,
 ADD CONSTRAINT production_native_order_admission CHECK (mode='NATIVE' OR
   (mode='LOCAL_CONTROLLED' AND resource_marker IN ('zzsh:ecs-test-demo-finance:v1','zzsh:r07-delivery-clone:v1')));
ALTER TABLE zzsh_order.distribution_order_admission DROP CONSTRAINT distribution_admission_mode_shape,
 ADD CONSTRAINT distribution_admission_mode_shape CHECK (
   (mode='LOCAL_CONTROLLED' AND resource_marker IN ('zzsh:ecs-test-demo-finance:v1','zzsh:r07-delivery-clone:v1') AND created_by_admin_id IS NOT NULL AND source_admission_ref IS NULL)
   OR (mode='NATIVE' AND resource_marker='NATIVE_CREATED_ORDER_V1' AND created_by_admin_id IS NULL AND source_admission_ref IS NOT NULL));
ALTER TABLE zzsh_order.payment_confirmation DROP CONSTRAINT production_real_payment_source,
 ADD CONSTRAINT production_real_payment_source CHECK (source IN('JOINPAY','CONTROLLED'));

CREATE FUNCTION zzsh_order.ecs_test_demo_finance_matches(digest_value text) RETURNS boolean
LANGUAGE sql STABLE SET search_path=pg_catalog,zzsh_order AS $fn$
 SELECT EXISTS(SELECT 1 FROM zzsh_order.ecs_test_demo_finance_registration s
  JOIN pg_database d ON d.datname=current_database() JOIN pg_roles r ON r.rolname=current_user
  JOIN pg_roles own ON own.oid=d.datdba JOIN pg_namespace ns ON ns.nspname='zzsh_order' JOIN pg_roles migration ON migration.oid=ns.nspowner
  WHERE s.registration_digest=digest_value AND s.active
   AND ((current_database() ~ '^zzsh_ecs_test(_[a-z0-9_]{1,32})?$' AND shobj_description(d.oid,'pg_database')='zzsh:ecs-test-demo-finance:v1'
      AND s.canonical_registration::jsonb->>'schema'='ecs-test-demo-finance.v1') OR
     (current_database()='zzsh_test_r07_delivery_20261108' AND shobj_description(d.oid,'pg_database')='zzsh:r07-delivery-clone:v1'
      AND s.canonical_registration::jsonb->>'schema'='local-demo-clone-finance.v1'
      AND s.canonical_registration::jsonb->>'nonce'=current_setting('zzsh.regression_run',true)
      AND s.canonical_registration::jsonb #>> '{resource,migrationRoleOid}'=(SELECT oid::text FROM pg_roles WHERE rolname=s.canonical_registration::jsonb #>> '{resource,migrationRole}')))
   AND s.registration_digest=encode(sha256(convert_to(s.canonical_registration,'UTF8')),'hex')
   AND s.canonical_registration::jsonb #>> '{resource,database}'=current_database()
   AND s.canonical_registration::jsonb #>> '{resource,databaseOid}'=d.oid::text
   AND s.canonical_registration::jsonb #>> '{resource,marker}'=shobj_description(d.oid,'pg_database')
   AND s.canonical_registration::jsonb #>> '{resource,ownerOid}'=d.datdba::text
   AND s.canonical_registration::jsonb #>> '{resource,migrationRole}'=(SELECT pg_get_userbyid(nspowner) FROM pg_namespace WHERE nspname='zzsh_order')::text
   AND s.canonical_registration::jsonb #>> '{resource,migrationRoleOid}'=(SELECT nspowner::text FROM pg_namespace WHERE nspname='zzsh_order')
   AND s.canonical_registration::jsonb #>> '{resource,runtimeRole}'=current_user
   AND s.canonical_registration::jsonb #>> '{resource,runtimeRoleOid}'=r.oid::text
   AND s.canonical_registration::jsonb #>> '{resource,systemIdentifier}'=(SELECT system_identifier::text FROM pg_control_system())
   AND NOT(r.rolsuper OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication OR r.rolbypassrls)
   AND NOT(own.rolsuper OR own.rolcreaterole OR own.rolcreatedb OR own.rolreplication OR own.rolbypassrls OR own.rolcanlogin)
   AND NOT(migration.rolsuper OR migration.rolcreaterole OR migration.rolcreatedb OR migration.rolreplication OR migration.rolbypassrls)
   AND (s.canonical_registration::jsonb->>'schema'<>'ecs-test-demo-finance.v1' OR NOT migration.rolcanlogin)
   AND NOT EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member=r.oid)
   AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proowner=r.oid
     AND n.nspname IN ('zzsh_business_meta','zzsh_iam','zzsh_auth_user','zzsh_auth_admin','zzsh_supply','zzsh_content','zzsh_order','zzsh_credit')))
$fn$;
COMMENT ON FUNCTION zzsh_order.ecs_test_demo_finance_matches(text) IS '核对当前数据库和运行身份是否对应有效测试资金登记。';

CREATE FUNCTION zzsh_order.guard_ecs_demo_order_admission() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,zzsh_order AS $fn$
DECLARE s zzsh_order.ecs_test_demo_finance_registration; o zzsh_order.rental_order;
BEGIN
 SELECT * INTO s FROM zzsh_order.ecs_test_demo_finance_registration WHERE registration_digest=NEW.approval_digest AND active FOR SHARE;
 IF s.reference IS NULL OR NOT zzsh_order.ecs_test_demo_finance_matches(NEW.approval_digest)
  OR NEW.mode<>'LOCAL_CONTROLLED' OR NEW.resource_oid<>(SELECT oid FROM pg_database WHERE datname=current_database())
  OR NEW.resource_name<>current_database() OR NEW.resource_marker IS DISTINCT FROM (s.canonical_registration::jsonb #>> '{resource,marker}')
  OR NEW.created_by_admin_id IS DISTINCT FROM s.canonical_registration::jsonb->>'administratorId'
  OR NEW.source_admission_ref IS NOT NULL OR NEW.revision<>1 OR NOT NEW.active
  OR NEW.admitted_at>clock_timestamp() OR NEW.expires_at<>'infinity'::timestamptz
 THEN RAISE EXCEPTION 'demo order outside registered test environment' USING ERRCODE='23514'; END IF;
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=NEW.order_id;
 IF o.id IS NULL OR o.status<>'PENDING_PAYMENT' OR o.paid_confirmation_id IS NOT NULL OR o.created_at<s.registered_at
  OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.id=NEW.native_creation_audit_id AND a.action='order.reservation.created'
   AND a.object_type='rental_order' AND a.object_id=o.id AND a.actor_type='user' AND a.actor_id=o.renter_user_id
   AND a.outcome='SUCCESS' AND a.occurred_at>=s.registered_at)
 THEN RAISE EXCEPTION 'demo requires original post-enrollment order creation' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END
$fn$;
COMMENT ON FUNCTION zzsh_order.guard_ecs_demo_order_admission() IS '仅允许环境登记之后由租客创建的新订单进入模拟支付。';
DROP TRIGGER distribution_order_admission_guard ON zzsh_order.distribution_order_admission;
CREATE TRIGGER distribution_order_admission_guard BEFORE INSERT ON zzsh_order.distribution_order_admission
 FOR EACH ROW WHEN (NEW.resource_marker NOT IN ('zzsh:ecs-test-demo-finance:v1','zzsh:r07-delivery-clone:v1'))
 EXECUTE FUNCTION zzsh_order.guard_distribution_order_admission();
CREATE TRIGGER ecs_demo_order_admission_guard BEFORE INSERT ON zzsh_order.distribution_order_admission
 FOR EACH ROW WHEN (NEW.resource_marker IN ('zzsh:ecs-test-demo-finance:v1','zzsh:r07-delivery-clone:v1')) EXECUTE FUNCTION zzsh_order.guard_ecs_demo_order_admission();

CREATE FUNCTION zzsh_order.guard_ecs_demo_payment_declaration() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,zzsh_order AS $fn$
DECLARE s zzsh_order.ecs_test_demo_finance_registration; a zzsh_order.distribution_order_admission;
 o zzsh_order.rental_order; doc jsonb:=NEW.canonical_payment::jsonb; k text; anchor text;
BEGIN
 SELECT * INTO s FROM zzsh_order.ecs_test_demo_finance_registration WHERE registration_digest=NEW.approval_digest AND active FOR SHARE;
 IF s.reference IS NULL OR NOT zzsh_order.ecs_test_demo_finance_matches(NEW.approval_digest)
  OR NEW.resource_oid<>(SELECT oid FROM pg_database WHERE datname=current_database())
  OR NEW.created_by_admin_id IS DISTINCT FROM s.canonical_registration::jsonb->>'administratorId'
  OR NEW.source_event_key<>'ecs-demo-payment:'||NEW.id OR NEW.merchant_scope_id<>(CASE WHEN s.canonical_registration::jsonb->>'schema'='ecs-test-demo-finance.v1' THEN 'ecs_demo_' ELSE 'local_demo_' END)||substr(s.registration_digest,1,32)
 THEN RAISE EXCEPTION 'demo declaration outside registered source' USING ERRCODE='23514'; END IF;
 SELECT * INTO a FROM zzsh_order.distribution_order_admission WHERE id=NEW.admission_id AND order_id=NEW.order_id;
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=NEW.order_id;
 IF a.id IS NULL OR o.id IS NULL OR a.resource_oid<>NEW.resource_oid OR a.approval_digest<>s.registration_digest
  OR a.mode<>'LOCAL_CONTROLLED' OR a.resource_marker IS DISTINCT FROM (s.canonical_registration::jsonb #>> '{resource,marker}') OR a.revision<>NEW.admission_revision OR NOT a.active
  OR NEW.merchant_order_no<>o.display_no OR (SELECT count(*) FROM jsonb_object_keys(doc))<>7
  OR zzsh_order.canonical_finance_json(doc)<>NEW.canonical_payment
 THEN RAISE EXCEPTION 'demo declaration differs from original order' USING ERRCODE='23514'; END IF;
 FOREACH k IN ARRAY ARRAY['orderId','merchantOrderNo','providerTransactionId','amountCents','currency','providerPaidAt','requestId'] LOOP
  IF jsonb_typeof(doc->k) IS DISTINCT FROM 'string' THEN RAISE EXCEPTION 'demo payment requires exact strings' USING ERRCODE='23514'; END IF;
 END LOOP;
 anchor:=substr(encode(sha256(convert_to(s.registration_digest||':'||o.id,'UTF8')),'hex'),1,40);
 IF NEW.id<>'demo_decl_'||anchor OR doc->>'orderId'<>o.id OR doc->>'merchantOrderNo'<>o.display_no OR doc->>'currency'<>'CNY' OR o.currency<>'CNY'
  OR doc->>'amountCents'<>(o.rental_amount_cents+o.deposit_amount_cents)::text
  OR doc->>'providerTransactionId'<>'demo_pay_'||anchor OR NEW.provider_transaction_id<>doc->>'providerTransactionId'
  OR doc->>'requestId'<>'demo_payment_'||anchor
  OR NOT (CASE WHEN doc->>'providerPaidAt' ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$'
    THEN (doc->>'providerPaidAt')::timestamptz BETWEEN date_trunc('milliseconds',transaction_timestamp()) AND date_trunc('milliseconds',clock_timestamp())
    ELSE false END)
 THEN RAISE EXCEPTION 'demo payment amount or original order differs' USING ERRCODE='23514'; END IF;
 NEW.declared_at:=clock_timestamp(); RETURN NEW;
END
$fn$;
COMMENT ON FUNCTION zzsh_order.guard_ecs_demo_payment_declaration() IS '验证测试支付声明与原订单、金额和测试来源一致。';
CREATE TRIGGER ecs_demo_payment_declaration_guard BEFORE INSERT ON zzsh_order.controlled_payment_declaration
 FOR EACH ROW WHEN (current_database() ~ '^zzsh_ecs_test(_[a-z0-9_]{1,32})?$' OR current_database()='zzsh_test_r07_delivery_20261108') EXECUTE FUNCTION zzsh_order.guard_ecs_demo_payment_declaration();

CREATE FUNCTION zzsh_order.guard_ecs_demo_payment_confirmation() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,zzsh_order AS $fn$
DECLARE d zzsh_order.controlled_payment_declaration; s zzsh_order.ecs_test_demo_finance_registration; doc jsonb;
BEGIN
 SELECT * INTO d FROM zzsh_order.controlled_payment_declaration WHERE order_id=NEW.order_id
  AND merchant_scope_id=NEW.merchant_scope_id AND provider_transaction_id=NEW.provider_transaction_id;
 SELECT * INTO s FROM zzsh_order.ecs_test_demo_finance_registration WHERE registration_digest=d.approval_digest AND active FOR SHARE;
 IF d.id IS NULL OR s.reference IS NULL OR NOT zzsh_order.ecs_test_demo_finance_matches(d.approval_digest)
  OR d.resource_oid<>(SELECT oid FROM pg_database WHERE datname=current_database()) OR d.mode<>'LOCAL_CONTROLLED_DECLARED_PAYMENT'
  OR d.payment_digest<>encode(sha256(convert_to(d.canonical_payment,'UTF8')),'hex')
 THEN RAISE EXCEPTION 'demo confirmation requires original test declaration' USING ERRCODE='23514'; END IF;
 doc:=d.canonical_payment::jsonb;
 IF NEW.order_id IS DISTINCT FROM doc->>'orderId' OR NEW.merchant_order_no IS DISTINCT FROM doc->>'merchantOrderNo'
  OR NEW.provider_transaction_id IS DISTINCT FROM doc->>'providerTransactionId' OR NEW.amount_cents::text IS DISTINCT FROM doc->>'amountCents'
  OR NEW.currency<>'CNY' OR NEW.currency IS DISTINCT FROM doc->>'currency'
  OR to_char(NEW.provider_paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') IS DISTINCT FROM doc->>'providerPaidAt'
  OR NEW.request_id IS DISTINCT FROM doc->>'requestId'
 THEN RAISE EXCEPTION 'demo confirmation differs from original test declaration' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END
$fn$;
COMMENT ON FUNCTION zzsh_order.guard_ecs_demo_payment_confirmation() IS '仅允许依据已登记的模拟声明确认测试付款，不代表渠道到账。';
CREATE TRIGGER ecs_demo_payment_confirmation_guard BEFORE INSERT ON zzsh_order.payment_confirmation
 FOR EACH ROW WHEN (NEW.source='CONTROLLED') EXECUTE FUNCTION zzsh_order.guard_ecs_demo_payment_confirmation();

-- Use the current NATIVE policy for a proven demo order, just like a new real order.
-- Existing frozen bases remain unchanged; ordinary local-controlled orders keep their original policy scope.
DO $rewrite$
DECLARE original text;
 old_clause text := $old$WHERE h.scope=CASE WHEN EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.id=o.paid_confirmation_id AND p.order_id=o.id AND p.source='JOINPAY') THEN 'NATIVE' ELSE 'LOCAL_CONTROLLED' END FOR SHARE OF h;$old$;
 new_clause text := $new$WHERE h.scope=CASE WHEN EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.id=o.paid_confirmation_id AND p.order_id=o.id AND
  (p.source='JOINPAY' OR (p.source='CONTROLLED' AND EXISTS(SELECT 1 FROM zzsh_order.controlled_payment_declaration d
    JOIN zzsh_order.ecs_test_demo_finance_registration s ON s.registration_digest=d.approval_digest
    WHERE d.order_id=o.id AND d.merchant_scope_id=p.merchant_scope_id AND d.provider_transaction_id=p.provider_transaction_id
      AND d.resource_oid=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND zzsh_order.ecs_test_demo_finance_matches(s.registration_digest))))) THEN 'NATIVE' ELSE 'LOCAL_CONTROLLED' END FOR SHARE OF h;$new$;
BEGIN
 SELECT pg_get_functiondef(p.oid) INTO original FROM pg_proc p
  WHERE p.oid=to_regprocedure('zzsh_order.derive_payment_referral_inputs(text)') AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND NOT p.prosecdef;
 IF original IS NULL OR position(old_clause IN original)=0 OR position(old_clause IN replace(original,old_clause,''))<>0
  THEN RAISE EXCEPTION 'Exact installed distribution policy derivation is required'; END IF;
 EXECUTE replace(original,old_clause,new_clause);
END
$rewrite$;
REVOKE ALL ON FUNCTION zzsh_order.ecs_test_demo_finance_matches(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_ecs_demo_order_admission() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_ecs_demo_payment_declaration() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_ecs_demo_payment_confirmation() FROM PUBLIC;
