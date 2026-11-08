-- Test databases only. Apply in one transaction after the registered demo finance installation.
DO $upgrade$
DECLARE marker text; schema_owner name; item record; definition text;
BEGIN
  SELECT shobj_description(d.oid,'pg_database'),pg_get_userbyid(n.nspowner)
    INTO marker,schema_owner FROM pg_database d JOIN pg_namespace n ON n.nspname='zzsh_order' WHERE d.datname=current_database();
  IF (current_database() ~ '^zzsh_ecs_test(_[a-z0-9_]{1,32})?$' AND marker='zzsh:ecs-test:v1'
    OR current_database()='zzsh_test_r07_delivery_20261108' AND marker='zzsh:r07-delivery-clone:v1') IS NOT TRUE
    OR current_user <> schema_owner OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=current_user
      AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication))
    OR to_regclass('zzsh_order.ecs_test_demo_finance_registration') IS NULL
    OR to_regprocedure('zzsh_order.ecs_test_demo_finance_matches(text)') IS NULL THEN
    RAISE EXCEPTION 'Exact registered test database and schema owner required';
  END IF;
  FOR item IN SELECT * FROM (VALUES
    ('zzsh_order.guard_controlled_operation()','2110d40f95ecf35f01fc1836a9c91337ea9d0432732169aaf66300f397c3d5df'),
    ('zzsh_order.guard_sandbox_withdrawal_destination()','361809167b88123409b92cc80feb0f942226f1e22d0a6ac064602b102b055016'),
    ('zzsh_order.guard_sandbox_withdrawal_intent()','48ba919efd477d3fcddd4961ffe2efe09b3c11e9191d43df9ce421b62d8c26dd')
  ) AS expected(signature,digest) LOOP
    SELECT replace(pg_get_functiondef(p.oid),E'\r\n',E'\n') INTO definition FROM pg_proc p
      WHERE p.oid=to_regprocedure(item.signature) AND pg_get_userbyid(p.proowner)=current_user;
    IF definition IS NULL OR encode(sha256(convert_to(definition,'UTF8')),'hex')<>item.digest THEN
      RAISE EXCEPTION 'Unexpected payout guard: %',item.signature;
    END IF;
  END LOOP;
  FOR item IN SELECT * FROM (VALUES
    ('zzsh_order.withdrawal_destination','withdrawal_destination_scenario_check'),
    ('zzsh_order.controlled_payout_operation','controlled_payout_operation_scenario_check')
  ) AS expected(relation_name,constraint_name) LOOP
    IF NOT EXISTS(SELECT 1 FROM pg_constraint c WHERE c.conrelid=to_regclass(item.relation_name)
      AND c.conname=item.constraint_name AND c.convalidated
      AND pg_get_constraintdef(c.oid)=$check$CHECK ((scenario = ANY (ARRAY['FAIL_UNPAID'::text, 'TIMEOUT_THEN_SUCCEED'::text])))$check$) THEN
      RAISE EXCEPTION 'Unexpected payout scenario constraint: %',item.constraint_name;
    END IF;
  END LOOP;
  EXECUTE $ddl$ALTER TABLE zzsh_order.withdrawal_destination DROP CONSTRAINT withdrawal_destination_scenario_check,
    ADD CONSTRAINT withdrawal_destination_scenario_check CHECK (scenario IN ('FAIL_UNPAID','TIMEOUT_THEN_SUCCEED','IMMEDIATE_SUCCESS'))$ddl$;
  EXECUTE $ddl$ALTER TABLE zzsh_order.controlled_payout_operation DROP CONSTRAINT controlled_payout_operation_scenario_check,
    ADD CONSTRAINT controlled_payout_operation_scenario_check CHECK (scenario IN ('FAIL_UNPAID','TIMEOUT_THEN_SUCCEED','IMMEDIATE_SUCCESS'))$ddl$;
  EXECUTE $ddl$COMMENT ON CONSTRAINT withdrawal_destination_scenario_check ON zzsh_order.withdrawal_destination IS '限定受控提现测试场景，首次成功仅用于已登记的演示环境。'$ddl$;
  EXECUTE $ddl$COMMENT ON CONSTRAINT controlled_payout_operation_scenario_check ON zzsh_order.controlled_payout_operation IS '限定受控出款测试场景，模拟结果不代表真实渠道到账。'$ddl$;

  FOR item IN SELECT * FROM (VALUES
    ('zzsh_order.guard_controlled_operation()',
      $old$NEW.scenario='TIMEOUT_THEN_SUCCEED' AND doc IS DISTINCT FROM$old$,
      $new$NEW.scenario IN ('TIMEOUT_THEN_SUCCEED','IMMEDIATE_SUCCESS') AND doc IS DISTINCT FROM$new$),
    ('zzsh_order.guard_sandbox_withdrawal_destination()',
      $old$NEW.scenario<>'TIMEOUT_THEN_SUCCEED'$old$,
      $new$NEW.scenario NOT IN ('TIMEOUT_THEN_SUCCEED','IMMEDIATE_SUCCESS')$new$),
    ('zzsh_order.guard_sandbox_withdrawal_intent()',
      $old$d.scenario<>'TIMEOUT_THEN_SUCCEED'$old$,
      $new$d.scenario NOT IN ('TIMEOUT_THEN_SUCCEED','IMMEDIATE_SUCCESS')$new$)
  ) AS changes(signature,old_text,new_text) LOOP
    SELECT pg_get_functiondef(to_regprocedure(item.signature)) INTO definition;
    IF position(item.old_text IN definition)=0 OR position(item.old_text IN replace(definition,item.old_text,''))<>0 THEN
      RAISE EXCEPTION 'Payout guard replacement is not unique: %',item.signature;
    END IF;
    EXECUTE replace(definition,item.old_text,item.new_text);
  END LOOP;
END
$upgrade$;
