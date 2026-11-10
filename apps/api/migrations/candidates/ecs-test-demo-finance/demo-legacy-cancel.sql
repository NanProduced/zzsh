-- TODO(正式上线前): 移除此仅测试环境使用的旧单模拟退款兼容。
DO $upgrade$
DECLARE db record; f text; digest text; updated text;
BEGIN
 SELECT pg_get_userbyid(n.nspowner) AS owner,shobj_description(d.oid,'pg_database') AS marker INTO db
 FROM pg_database d JOIN pg_namespace n ON n.nspname='zzsh_order' WHERE d.datname=current_database();
 IF (current_database() ~ '^zzsh_ecs_test(_[a-z0-9_]{1,32})?$' AND db.marker='zzsh:ecs-test:v1'
   OR current_database()='zzsh_test_r07_delivery_20261108' AND db.marker='zzsh:r07-delivery-clone:v1') IS NOT TRUE
   OR db.owner<>current_user OR to_regclass('zzsh_order.ecs_demo_legacy_refund') IS NULL
   OR NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('zzsh_order.legacy_continuation_version')
     AND conname='legacy_continuation_version_command_check' AND pg_get_constraintdef(oid) LIKE '%SUPPORT_CANCEL%')
 THEN RAISE EXCEPTION 'Exact upgraded demo resource required';END IF;
 SELECT replace(pg_get_functiondef(to_regprocedure('zzsh_order.guard_demo_legacy_refund()')),chr(13)||chr(10),chr(10)) INTO f;
 digest:=encode(sha256(convert_to(f,'UTF8')),'hex');
 IF digest='0307d4cc38a60afcf6ff973f778d4624da256b0c6efb820e5ee3d2aff76d396c' THEN RETURN;END IF;
 IF digest IS DISTINCT FROM '0e28603746a8d62e442abf5a1820450d088c40d192230b0fe5b03bfe9bdf5670'
 THEN RAISE EXCEPTION 'Demo refund guard differs';END IF;
 updated:=replace(f,'AND command=''CONFIRM'';','AND command IN(''CONFIRM'',''SUPPORT_CANCEL'');');
 updated:=replace(updated,'e.admission<>''PARAMETER_COMPLETE''',
   'NOT (e.admission=''PARAMETER_COMPLETE'' OR (e.admission=''ISOLATED'' AND v.command=''SUPPORT_CANCEL''))');
 updated:=replace(updated,'v.stage<>4 OR v.refund_due_at',
   'NOT ((v.command=''CONFIRM'' AND v.stage=4) OR (v.command=''SUPPORT_CANCEL'' AND v.stage=5)) OR v.refund_due_at');
 IF encode(sha256(convert_to(updated,'UTF8')),'hex') IS DISTINCT FROM '0307d4cc38a60afcf6ff973f778d4624da256b0c6efb820e5ee3d2aff76d396c'
 THEN RAISE EXCEPTION 'Demo refund guard upgrade differs';END IF;
 EXECUTE updated;
END
$upgrade$;
