-- Run after owner enrollment and the ordinary runtime ACL grant. The runtime can
-- lock an active enrollment but the invoker trigger forbids runtime updates.
DO $guard$
DECLARE s zzsh_order.ecs_test_demo_finance_registration; runtime_role text; d record;
BEGIN
 SELECT db.oid::text AS oid,pg_get_userbyid(n.nspowner) AS owner,shobj_description(db.oid,'pg_database') AS marker
   INTO d FROM pg_database db JOIN pg_namespace n ON n.nspname='zzsh_order' WHERE db.datname=current_database();
 IF (current_database() ~ '^zzsh_ecs_test(_[a-z0-9_]{1,32})?$' AND d.marker='zzsh:ecs-test-demo-finance:v1'
   OR current_database()='zzsh_test_r07_delivery_20261108' AND d.marker='zzsh:r07-delivery-clone:v1') IS NOT TRUE OR current_user <> d.owner THEN
   RAISE EXCEPTION 'Exact demo database owner required';
 END IF;
 SELECT * INTO s FROM zzsh_order.ecs_test_demo_finance_registration WHERE active;
 IF s.reference IS NULL OR s.canonical_registration::jsonb #>> '{resource,databaseOid}' IS DISTINCT FROM d.oid
   OR s.registration_digest IS DISTINCT FROM encode(sha256(convert_to(s.canonical_registration,'UTF8')),'hex') THEN
   RAISE EXCEPTION 'One active matching demo enrollment required';
 END IF;
 runtime_role:=s.canonical_registration::jsonb #>> '{resource,runtimeRole}';
 IF runtime_role !~ '^[a-z][a-z0-9_]{0,62}$' OR runtime_role=current_user THEN
   RAISE EXCEPTION 'Distinct demo runtime role required';
 END IF;
 EXECUTE format('REVOKE ALL ON TABLE zzsh_order.ecs_test_demo_finance_registration FROM %I',runtime_role);
 EXECUTE format('GRANT SELECT, UPDATE(active) ON TABLE zzsh_order.ecs_test_demo_finance_registration TO %I',runtime_role);
 EXECUTE format('GRANT EXECUTE ON FUNCTION zzsh_order.ecs_test_demo_finance_matches(text) TO %I',runtime_role);
 EXECUTE format('REVOKE ALL ON TABLE zzsh_order.controlled_payment_declaration FROM %I',runtime_role);
 EXECUTE format('GRANT SELECT ON TABLE zzsh_order.controlled_payment_declaration TO %I',runtime_role);
 EXECUTE format('GRANT INSERT(id,mode,source_event_key,resource_oid,app_id,merchant_scope_id,admission_id,admission_revision,order_id,merchant_order_no,provider_transaction_id,canonical_payment,payment_digest,approval_digest,created_by_admin_id,reason) ON TABLE zzsh_order.controlled_payment_declaration TO %I',runtime_role);
 IF to_regclass('zzsh_order.local_controlled_refund_operation') IS NOT NULL AND to_regclass('zzsh_order.local_controlled_refund_evidence') IS NOT NULL THEN
   EXECUTE format('REVOKE ALL ON TABLE zzsh_order.local_controlled_refund_operation,zzsh_order.local_controlled_refund_evidence FROM %I',runtime_role);
   EXECUTE format('GRANT SELECT ON TABLE zzsh_order.local_controlled_refund_operation,zzsh_order.local_controlled_refund_evidence TO %I',runtime_role);
   EXECUTE format('GRANT INSERT(id,intent_id,sandbox_registration_ref,scenario,refund_order_no,original_payment_trx_no,amount_cents,currency,final_canonical,final_digest,original_lease_version,original_lease_owner) ON TABLE zzsh_order.local_controlled_refund_operation TO %I',runtime_role);
   EXECUTE format('GRANT INSERT(id,intent_id,operation_id,sandbox_registration_ref,terminal,refund_transaction_no,completed_at,facts_canonical,facts_digest,lease_version,lease_owner) ON TABLE zzsh_order.local_controlled_refund_evidence TO %I',runtime_role);
   EXECUTE format('GRANT INSERT(sandbox_registration_ref) ON TABLE zzsh_order.channel_refund_intent TO %I',runtime_role);
   EXECUTE format('GRANT UPDATE(demo_terminal_evidence_id) ON TABLE zzsh_order.channel_refund_intent TO %I',runtime_role);
   EXECUTE format('GRANT EXECUTE ON FUNCTION zzsh_order.local_controlled_refund_liability_complete(text),zzsh_order.local_controlled_refund_terminal_complete(text) TO %I',runtime_role);
 END IF;
 IF to_regclass('zzsh_order.withdrawal_intent') IS NOT NULL THEN
   IF to_regclass('zzsh_order.withdrawal_admission') IS NULL OR to_regclass('zzsh_order.withdrawal_destination') IS NULL
     OR to_regclass('zzsh_order.withdrawal_provider_fact') IS NULL OR to_regclass('zzsh_order.controlled_payout_operation') IS NULL
     OR to_regclass('zzsh_order.controlled_payout_notice') IS NOT NULL OR to_regprocedure('zzsh_order.withdrawal_expected_lines(text)') IS NULL THEN
     RAISE EXCEPTION 'Incomplete demo withdrawal schema';
   END IF;
   EXECUTE format('REVOKE ALL ON TABLE zzsh_order.withdrawal_admission,zzsh_order.withdrawal_destination,zzsh_order.withdrawal_intent,zzsh_order.withdrawal_provider_fact,zzsh_order.controlled_payout_operation FROM %I',runtime_role);
   EXECUTE 'REVOKE ALL ON TABLE zzsh_order.withdrawal_admission,zzsh_order.withdrawal_destination,zzsh_order.withdrawal_intent,zzsh_order.withdrawal_provider_fact,zzsh_order.controlled_payout_operation FROM PUBLIC';
   EXECUTE format('GRANT SELECT ON TABLE zzsh_order.withdrawal_admission,zzsh_order.withdrawal_destination,zzsh_order.withdrawal_intent,zzsh_order.withdrawal_provider_fact,zzsh_order.controlled_payout_operation TO %I',runtime_role);
   EXECUTE format('GRANT INSERT(id,user_id,scope,resource_oid,resource_name,resource_marker,revision,active,per_intent_cents,max_intents,max_gross_cents,admitted_at,expires_at,created_by_admin_id,reason,sandbox_registration_ref) ON TABLE zzsh_order.withdrawal_admission TO %I',runtime_role);
   EXECUTE format('GRANT INSERT(id,user_id,admission_id,mode,kind,scenario,display_mask,revision,active,sandbox_registration_ref,bank_binding_id,bank_binding_revision,valid_until) ON TABLE zzsh_order.withdrawal_destination TO %I',runtime_role);
   EXECUTE format('GRANT INSERT(id,user_id,admission_id,destination_id,destination_revision,mode,policy_version,input_digest,gross_cents,net_cents,fee_cents,expected_ledger_revision,accepted_at,payout_key,economic_root_id,state,operation_version,funds_disposition,sandbox_registration_ref) ON TABLE zzsh_order.withdrawal_intent TO %I',runtime_role);
   EXECUTE format('GRANT UPDATE(state,operation_version,lease_token_hash,lease_until,last_provider_fact_id,terminal,conflict_digest,funds_disposition) ON TABLE zzsh_order.withdrawal_intent TO %I',runtime_role);
   EXECUTE format('GRANT INSERT(id,intent_id,payout_key,mode,result_key,evidence_canonical,evidence_digest,producer_lease_hash) ON TABLE zzsh_order.withdrawal_provider_fact TO %I',runtime_role);
   EXECUTE format('GRANT INSERT(id,intent_id,payout_key,mode,scenario,final_evidence_canonical,final_evidence_digest,original_lease_hash) ON TABLE zzsh_order.controlled_payout_operation TO %I',runtime_role);
   EXECUTE format('GRANT EXECUTE ON FUNCTION zzsh_order.withdrawal_expected_lines(text) TO %I',runtime_role);
 END IF;
 IF to_regclass('zzsh_order.ecs_demo_legacy_refund') IS NOT NULL THEN
   EXECUTE format('REVOKE ALL ON TABLE zzsh_order.ecs_demo_legacy_refund FROM %I',runtime_role);
   EXECUTE format('GRANT SELECT ON TABLE zzsh_order.ecs_demo_legacy_refund TO %I',runtime_role);
   EXECUTE format('GRANT INSERT(id,registration_ref,order_id,duty_id,renter_user_id,payment_record_id,payment_order_no,source_digest,duty_fact_digest,amount_cents,paid_cents,event_id,assumption,actor_id,session_id,request_id,reason) ON TABLE zzsh_order.ecs_demo_legacy_refund TO %I',runtime_role);
 END IF;
END
$guard$;
