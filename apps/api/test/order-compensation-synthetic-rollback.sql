\set ON_ERROR_STOP on
WITH p AS (SELECT operation_payload||jsonb_build_object('caseRef','synth-incident-abort') AS v FROM zzsh_iam.approval_request WHERE id='synthetic_request')
INSERT INTO zzsh_iam.approval_request(id,template_id,template_version,operation_code,trigger_condition,payload_version,operation_payload,operation_payload_hash,summary,requested_by,status,expires_at)
 SELECT 'synthetic_abort','approval_tpl_order_compensation',1,'order.compensation.grant','order.compensation.requested',1,v,encode(sha256(convert_to(zzsh_order.canonical_finance_json(v),'UTF8')),'hex'),'synthetic rollback','synthetic_ops','PENDING',now()+interval '1 hour' FROM p;
INSERT INTO zzsh_iam.approval_request_candidate(request_id,admin_user_id,source,template_version) VALUES('synthetic_abort','synthetic_ops','TEMPLATE',1);
BEGIN;
SET LOCAL ROLE synth_comp_runtime;
SELECT set_config('zzsh.actor_type','admin',true),set_config('zzsh.actor_id','synthetic_ops',true),set_config('zzsh.session_id','synthetic_session',true),set_config('zzsh.request_id','synthetic_abort_trace',true);
INSERT INTO zzsh_iam.approval_decision(id,request_id,approver_admin_id,decision) VALUES('synthetic_abort_decision','synthetic_abort','synthetic_ops','APPROVED');
UPDATE zzsh_iam.approval_request SET status='APPROVED',decided_by='synthetic_ops',decided_at=clock_timestamp() WHERE id='synthetic_abort';
INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,occurred_at)
 VALUES('synthetic_abort_audit','admin','synthetic_ops','synthetic_session','approval.request.approved','approval_request','synthetic_abort','SUCCESS','synthetic_abort_trace',clock_timestamp());
SELECT zzsh_order.post_order_compensation('synthetic_abort');
COMMIT;
