-- 唯一受管理回归库复用LOCAL_CONTROLLED验收，不授予正式商户或资金外调能力。
-- NATIVE分支、原有限订单/创建审计/未付款/金额与资源匹配守卫保持原样。
DO $preflight$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='zzsh_order' AND p.proname='guard_distribution_order_admission' AND p.pronargs=0
     AND encode(sha256(convert_to(p.prosrc,'UTF8')),'hex')='afbb748d40a31936df4e4ae93e6624fb8a7f5bcfa182058a7f80818adb25fa4a')
 THEN RAISE EXCEPTION 'controlled regression guard source drift' USING ERRCODE='23514'; END IF;
END $preflight$;

--> statement-breakpoint
ALTER TABLE zzsh_order.distribution_order_admission DROP CONSTRAINT distribution_admission_mode_shape,
 ADD CONSTRAINT distribution_admission_mode_shape CHECK (
  (mode='LOCAL_CONTROLLED' AND resource_marker IN('zzsh:order-reservation-test:v1','zzsh:regression-test:v1') AND created_by_admin_id IS NOT NULL AND source_admission_ref IS NULL)
  OR(mode='NATIVE' AND resource_marker='NATIVE_CREATED_ORDER_V1' AND created_by_admin_id IS NULL AND source_admission_ref IS NOT NULL));

--> statement-breakpoint
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
 IF NOT ((current_database()~'^zzsh_test_order_[a-z][a-z0-9_]{0,20}$' AND current_user='zzsh_order_'||substr(current_database(),17)||'_m')
  OR (current_database()='zzsh_test_regression' AND current_user='zzsh_regression_migration'
   AND COALESCE(current_setting('zzsh.regression_run',true),'')~'^[a-f0-9]{24}$'
   AND (SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database())='zzsh:regression-test:v1'))
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
