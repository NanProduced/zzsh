\set ON_ERROR_STOP on
BEGIN;
SET LOCAL session_replication_role='replica';
INSERT INTO zzsh_auth_user."user"(id,name,email,"createdAt","updatedAt") VALUES
 ('synthetic_owner','owner','synthetic-owner@example.invalid',now(),now()),('synthetic_renter','renter','synthetic-renter@example.invalid',now(),now());
-- 包赔批准仅 Boss：主审批账号必须是 Boss；另建一个非 Boss 运营用于验证硬拦。
INSERT INTO zzsh_auth_admin."user"(id,name,email,"twoFactorEnabled","createdAt","updatedAt") VALUES
 ('synthetic_ops','ops','synthetic-ops@example.invalid',true,now(),now()),
 ('synthetic_ops_denied','ops-denied','synthetic-ops-denied@example.invalid',true,now(),now());
INSERT INTO zzsh_iam.admin_security(admin_user_id,status,is_boss,first_activated_at) VALUES
 ('synthetic_ops','ACTIVE',true,now()),
 ('synthetic_ops_denied','ACTIVE',false,now());
INSERT INTO zzsh_auth_admin.session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES
 ('synthetic_session','synthetic_ops','synthetic-session-token',now()+interval '2 hours',now(),now()),
 ('synthetic_session_ops','synthetic_ops_denied','synthetic-ops-session-token',now()+interval '2 hours',now(),now());
INSERT INTO zzsh_iam.admin_user_role(admin_user_id,role_id) VALUES('synthetic_ops','role_preset_ops'),('synthetic_ops_denied','role_preset_ops');
INSERT INTO zzsh_supply.game(id,code,name) VALUES('synthetic_game','synthetic','synthetic');
INSERT INTO zzsh_supply.rental_account(id,owner_user_id,game_id) VALUES('synthetic_account','synthetic_owner','synthetic_game');
WITH s AS (SELECT '{"id":"1","pay_is":"1","sale_user_id":"11","user_id":"22","order_status":"3"}'::jsonb AS v)
 INSERT INTO zzsh_order.legacy_order_read_snapshot(id,source_system,source_entity,legacy_id,source_digest,evidence_ref,original_order_no,account_id,game_id,owner_user_id,renter_user_id,legacy_account_id,legacy_account_entity,legacy_account_source_digest,legacy_owner_id,owner_source_digest,legacy_renter_id,renter_source_digest,source_order_status,source_pay_status,recorded_paid_amount_cents,source_snapshot,snapshot_schema_version,binding_digest,created_by_admin_id)
 SELECT 'legacy_order_synthetic','legacy_mysql_restore','la_order','1',encode(sha256(convert_to(zzsh_order.canonical_finance_json(v),'UTF8')),'hex'),'fixture','OLD-SYNTHETIC','synthetic_account','synthetic_game','synthetic_owner','synthetic_renter','1','la_rental_accounts',repeat('a',64),'11',repeat('a',64),'22',repeat('a',64),3,1,10000,v,1,repeat('a',64),'synthetic_ops' FROM s;
INSERT INTO zzsh_order.finance_opening_basis(id,user_id,source_kind,source_system,source_entity,source_id,identity_source_digest,source_digest,available_cents,source_cutoff,covered_count,covered_set_digest)
 VALUES('synthetic_basis','synthetic_owner','LEGACY_OPENING','legacy_mysql_restore','la_user','11',repeat('a',64),repeat('a',64),0,now(),0,encode(sha256(convert_to('','UTF8')),'hex'));
INSERT INTO zzsh_order.wallet_coverage(user_id,origin,basis_id,opening_event_id) VALUES('synthetic_owner','RECONCILED_OPENING','synthetic_basis','synthetic_opening');
INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision) VALUES('synthetic_owner',0,0);
WITH basis AS (SELECT encode(sha256(convert_to(zzsh_order.canonical_finance_json(jsonb_build_object('origin','LEGACY','orderId',id,'gameId',game_id,'ownerUserId',owner_user_id,'sourceDigest',source_digest)),'UTF8')),'hex') AS d FROM zzsh_order.legacy_order_read_snapshot WHERE id='legacy_order_synthetic'),
 payload AS (SELECT jsonb_build_object('schema','order-compensation.v1','origin','LEGACY','orderId','legacy_order_synthetic','gameId','synthetic_game','ownerUserId','synthetic_owner','sourceDigest',d,'amountCents','1200','caseRef','synth-incident-1','reason','synthetic reason','evidenceRef','synthetic evidence') AS v FROM basis)
 INSERT INTO zzsh_iam.approval_request(id,template_id,template_version,operation_code,trigger_condition,payload_version,operation_payload,operation_payload_hash,summary,requested_by,status,expires_at)
 SELECT 'synthetic_request','approval_tpl_order_compensation',1,'order.compensation.grant','order.compensation.requested',1,v,encode(sha256(convert_to(zzsh_order.canonical_finance_json(v),'UTF8')),'hex'),'synthetic compensation','synthetic_ops','PENDING','infinity'::timestamptz FROM payload;
INSERT INTO zzsh_iam.approval_request_candidate(request_id,admin_user_id,source,template_version) VALUES('synthetic_request','synthetic_ops','TEMPLATE',1);
COMMIT;
CREATE ROLE synth_comp_runtime NOLOGIN;
GRANT USAGE ON SCHEMA zzsh_order,zzsh_iam TO synth_comp_runtime;
GRANT SELECT ON zzsh_order.order_compensation_posting,zzsh_iam.approval_request TO synth_comp_runtime;
GRANT SELECT ON zzsh_iam.approval_decision,zzsh_iam.approval_execution,zzsh_order.finance_economic_root,zzsh_order.finance_event,zzsh_order.wallet_revision,zzsh_order.settlement_ledger_entry,zzsh_order.settlement_posting TO synth_comp_runtime;
GRANT SELECT ON zzsh_order.legacy_order_read_snapshot TO synth_comp_runtime;
GRANT INSERT ON zzsh_iam.approval_decision,zzsh_iam.approval_execution,zzsh_iam.audit_event TO synth_comp_runtime;
GRANT UPDATE(status,status_reason,decided_at,decided_by,decision_reason) ON zzsh_iam.approval_request TO synth_comp_runtime;
GRANT EXECUTE ON FUNCTION zzsh_order.post_order_compensation(text),zzsh_order.order_compensation_posting_complete(text) TO synth_comp_runtime;
