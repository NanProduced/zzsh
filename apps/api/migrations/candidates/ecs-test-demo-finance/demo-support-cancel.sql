-- Extend the existing support-cancel predicate only in an installed demo copy.
DO $guard$
DECLARE d record; definition text; predicate_owner name;
BEGIN
 SELECT pg_get_userbyid(n.nspowner) AS owner,shobj_description(db.oid,'pg_database') AS marker INTO d
 FROM pg_database db JOIN pg_namespace n ON n.nspname='zzsh_order' WHERE db.datname=current_database();
 IF (current_database() ~ '^zzsh_ecs_test(_[a-z0-9_]{1,32})?$' AND d.marker='zzsh:ecs-test:v1'
   OR current_database()='zzsh_test_r07_delivery_20261108' AND d.marker='zzsh:r07-delivery-clone:v1') IS NOT TRUE
   OR current_user<>d.owner OR to_regprocedure('zzsh_order.ecs_test_demo_finance_matches(text)') IS NULL
 THEN RAISE EXCEPTION 'Exact installed demo resource required'; END IF;
 SELECT pg_get_functiondef(to_regprocedure('zzsh_order.support_cancel_payment_basis_valid(jsonb)')) INTO definition;
 SELECT pg_get_userbyid(p.proowner) INTO predicate_owner FROM pg_proc p
  WHERE p.oid=to_regprocedure('zzsh_order.support_cancel_payment_basis_valid(jsonb)');
 IF encode(sha256(convert_to(definition,'UTF8')),'hex') IS DISTINCT FROM 'd99d63862d968f5b90aa0a9b044f65c61e0af6319a1fdb9eb9a41b3dcb2f2730'
   OR predicate_owner IS DISTINCT FROM d.owner
 THEN RAISE EXCEPTION 'Original support cancellation predicate differs'; END IF;
END $guard$;

CREATE OR REPLACE FUNCTION zzsh_order.support_cancel_payment_basis_valid(b jsonb) RETURNS boolean
LANGUAGE sql AS $fn$
 SELECT COALESCE(EXISTS(SELECT 1 FROM zzsh_order.rental_order o
  JOIN zzsh_order.payment_confirmation c ON c.id=o.paid_confirmation_id AND c.order_id=o.id
  WHERE o.id=b->>'orderId' AND c.id=b->>'paymentConfirmationId' AND c.disposition='APPLIED'
   AND zzsh_order.prestart_payment_basis_valid(b)
   AND ((c.source='JOINPAY' AND b->>'source'='JOINPAY') OR
     (c.source='CONTROLLED' AND b->>'source'='CONTROLLED' AND EXISTS(
      SELECT 1 FROM zzsh_order.distribution_order_admission a
      JOIN zzsh_order.ecs_test_demo_finance_registration s ON s.registration_digest=a.approval_digest
      JOIN pg_database db ON db.datname=current_database()
      JOIN pg_roles runtime_role ON runtime_role.rolname=session_user
      JOIN pg_roles db_owner ON db_owner.oid=db.datdba
      JOIN pg_namespace ns ON ns.nspname='zzsh_order'
      JOIN pg_roles migration ON migration.oid=ns.nspowner
      WHERE a.order_id=o.id AND a.mode='LOCAL_CONTROLLED' AND a.active AND a.resource_oid=db.oid
       AND a.resource_name=db.datname AND a.resource_marker=shobj_description(db.oid,'pg_database')
       AND s.registration_digest=encode(sha256(convert_to(s.canonical_registration,'UTF8')),'hex')
       AND s.canonical_registration::jsonb #>> '{resource,database}'=db.datname
       AND s.canonical_registration::jsonb #>> '{resource,databaseOid}'=db.oid::text
       AND s.canonical_registration::jsonb #>> '{resource,marker}'=a.resource_marker
       AND s.canonical_registration::jsonb #>> '{resource,owner}'=db_owner.rolname
       AND s.canonical_registration::jsonb #>> '{resource,ownerOid}'=db_owner.oid::text
       AND s.canonical_registration::jsonb #>> '{resource,migrationRole}'=migration.rolname
       AND s.canonical_registration::jsonb #>> '{resource,migrationRoleOid}'=migration.oid::text
       AND s.canonical_registration::jsonb #>> '{resource,runtimeRole}'=runtime_role.rolname
       AND s.canonical_registration::jsonb #>> '{resource,runtimeRoleOid}'=runtime_role.oid::text
       AND s.canonical_registration::jsonb #>> '{resource,systemIdentifier}'=(SELECT system_identifier::text FROM pg_control_system())
       AND (current_user=session_user OR current_user=migration.rolname)
       AND ((db.datname ~ '^zzsh_ecs_test(_[a-z0-9_]{1,32})?$' AND a.resource_marker='zzsh:ecs-test:v1'
          AND s.canonical_registration::jsonb->>'schema'='ecs-test-demo-finance.v1') OR
         (db.datname='zzsh_test_r07_delivery_20261108' AND a.resource_marker='zzsh:r07-delivery-clone:v1'
          AND s.canonical_registration::jsonb->>'schema'='local-demo-clone-finance.v1'
          AND s.canonical_registration::jsonb->>'nonce'=current_setting('zzsh.regression_run',true)))
       AND NOT(runtime_role.rolsuper OR runtime_role.rolcreaterole OR runtime_role.rolcreatedb OR runtime_role.rolreplication OR runtime_role.rolbypassrls)
       AND NOT(db_owner.rolsuper OR db_owner.rolcreaterole OR db_owner.rolcreatedb OR db_owner.rolreplication OR db_owner.rolbypassrls OR db_owner.rolcanlogin)
       AND NOT(migration.rolsuper OR migration.rolcreaterole OR migration.rolcreatedb OR migration.rolreplication OR migration.rolbypassrls)
       AND NOT EXISTS(SELECT 1 FROM pg_auth_members roles WHERE roles.member IN (runtime_role.oid,db_owner.oid,migration.oid))
       AND NOT EXISTS(SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE p.proowner=runtime_role.oid
        AND n.nspname IN ('zzsh_business_meta','zzsh_iam','zzsh_auth_user','zzsh_auth_admin','zzsh_supply','zzsh_content','zzsh_order','zzsh_credit'))
       AND c.merchant_scope_id=(CASE WHEN s.canonical_registration::jsonb->>'schema'='ecs-test-demo-finance.v1' THEN 'ecs_demo_' ELSE 'local_demo_' END)||substr(s.registration_digest,1,32)
       AND c.provider_transaction_id='demo_pay_'||substr(encode(sha256(convert_to(s.registration_digest||':'||o.id,'UTF8')),'hex'),1,40)
       AND (s.active OR
         (NOT s.active AND o.status='CANCELLED' AND o.cancel_reason='SUPPORT_CANCELLED_REFUND'
          AND EXISTS(SELECT 1 FROM zzsh_order.prestart_termination t WHERE t.order_id=o.id
           AND t.requested_by_party='SUPPORT' AND t.state='APPROVED' AND t.payment_basis=b
           AND t.liability_root_id IS NOT NULL AND t.liability_event_id IS NOT NULL))))))
   AND c.currency='CNY' AND b->>'currency'='CNY'
   AND c.amount_cents=o.rental_amount_cents+o.deposit_amount_cents AND c.amount_cents::text=b->>'amountCents' AND c.amount_cents>0
   AND b->>'amountCents'~'^[1-9][0-9]{0,15}$' AND b->>'digest'~'^[a-f0-9]{64}$'
   AND o.renter_user_id=b->>'renterUserId' AND o.owner_user_id=b->>'ownerUserId'
   AND c.merchant_scope_id=b->>'merchantIdentityId' AND c.merchant_order_no=b->>'merchantOrderNo' AND c.provider_transaction_id=b->>'channelTrxNo'
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_version v WHERE v.order_id=o.id AND v.superseded_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_intake i WHERE i.order_id=o.id AND i.status IN('OPEN','CLASSIFIED'))
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_referral_earning e WHERE e.order_id=o.id AND e.amount_cents>0 AND e.state<>'REVOKED')),false)
$fn$;
COMMENT ON FUNCTION zzsh_order.support_cancel_payment_basis_valid(jsonb) IS '客服取消原付款依据校验；测试副本额外允许已登记的模拟付款，不代表渠道到账。';
