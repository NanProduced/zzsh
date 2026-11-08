\set ON_ERROR_STOP on
BEGIN;
SET LOCAL session_replication_role='replica';
INSERT INTO zzsh_auth_admin."user"(id,name,email,"twoFactorEnabled","createdAt","updatedAt") VALUES('synthetic_denied','denied','synthetic-denied@example.invalid',true,now(),now());
INSERT INTO zzsh_iam.admin_security(admin_user_id,status,is_boss,first_activated_at) VALUES('synthetic_denied','ACTIVE',false,now());
INSERT INTO zzsh_auth_admin.session(id,"userId",token,"expiresAt","createdAt","updatedAt") VALUES('synthetic_denied_session','synthetic_denied','synthetic-denied-token',now()+interval '1 hour',now(),now());
INSERT INTO zzsh_iam.admin_user_permission(admin_user_id,permission_code,effect) VALUES('synthetic_denied','approval.request.approve','ALLOW');
WITH p AS (SELECT operation_payload||jsonb_build_object('caseRef','synth-denied-incident') AS v FROM zzsh_iam.approval_request WHERE id='synthetic_request')
 INSERT INTO zzsh_iam.approval_request(id,template_id,template_version,operation_code,trigger_condition,payload_version,operation_payload,operation_payload_hash,summary,requested_by,status,expires_at)
 SELECT 'synthetic_denied_request','approval_tpl_order_compensation',1,'order.compensation.grant','order.compensation.requested',1,v,encode(sha256(convert_to(zzsh_order.canonical_finance_json(v),'UTF8')),'hex'),'synthetic denied','synthetic_ops','PENDING',now()+interval '1 hour' FROM p;
INSERT INTO zzsh_iam.approval_request_candidate(request_id,admin_user_id,source,template_version) VALUES('synthetic_denied_request','synthetic_denied','TEMPLATE',1);
COMMIT;
BEGIN;
SET LOCAL ROLE synth_comp_runtime;
SELECT set_config('zzsh.actor_type','admin',true),set_config('zzsh.actor_id','synthetic_denied',true),set_config('zzsh.session_id','synthetic_denied_session',true),set_config('zzsh.request_id','synthetic_denied_trace',true);
INSERT INTO zzsh_iam.approval_decision(id,request_id,approver_admin_id,decision) VALUES('synthetic_denied_decision','synthetic_denied_request','synthetic_denied','APPROVED');
UPDATE zzsh_iam.approval_request SET status='APPROVED',decided_by='synthetic_denied',decided_at=clock_timestamp() WHERE id='synthetic_denied_request';
INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,occurred_at)
 VALUES('synthetic_denied_audit','admin','synthetic_denied','synthetic_denied_session','approval.request.approved','approval_request','synthetic_denied_request','SUCCESS','synthetic_denied_trace',clock_timestamp());
SELECT zzsh_order.post_order_compensation('synthetic_denied_request');
COMMIT;
