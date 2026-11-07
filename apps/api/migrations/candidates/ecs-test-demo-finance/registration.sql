-- Candidate for an isolated ECS demo database only. It is not a business migration.
-- Installation and enrollment require the database owner after the copied dataset is verified.
DO $guard$
DECLARE marker text; schema_owner name;
BEGIN
  SELECT shobj_description(d.oid,'pg_database'),pg_get_userbyid(n.nspowner)
    INTO marker,schema_owner FROM pg_database d JOIN pg_namespace n ON n.nspname='zzsh_order' WHERE d.datname=current_database();
  IF (current_database() ~ '^zzsh_ecs_test(_[a-z0-9_]{1,32})?$' AND marker='zzsh:ecs-test:v1'
    OR current_database()='zzsh_test_r07_delivery_20261108' AND marker='zzsh:r07-delivery-clone:v1') IS NOT TRUE
    OR current_user <> schema_owner OR EXISTS(SELECT 1 FROM pg_roles r WHERE r.rolname=current_user
      AND (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)) THEN
    RAISE EXCEPTION 'Exact schema owner and registered demo database required';
  END IF;
END
$guard$;

CREATE TABLE zzsh_order.ecs_test_demo_finance_registration (
  reference text PRIMARY KEY CHECK (reference ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  canonical_registration text NOT NULL CHECK (length(canonical_registration) BETWEEN 2 AND 8192),
  registration_digest text NOT NULL CHECK (registration_digest ~ '^[a-f0-9]{64}$'),
  active boolean NOT NULL DEFAULT true,
  registered_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
COMMENT ON TABLE zzsh_order.ecs_test_demo_finance_registration IS '测试服务器模拟资金环境登记，不是第三方渠道到账凭据。';
COMMENT ON COLUMN zzsh_order.ecs_test_demo_finance_registration.reference IS '本次测试资金环境登记标识。';
COMMENT ON COLUMN zzsh_order.ecs_test_demo_finance_registration.canonical_registration IS '受限测试库、身份与访问来源的规范化登记内容，不含凭据。';
COMMENT ON COLUMN zzsh_order.ecs_test_demo_finance_registration.registration_digest IS '规范化登记内容的 SHA-256 摘要。';
COMMENT ON COLUMN zzsh_order.ecs_test_demo_finance_registration.active IS '登记是否仍允许测试资金写入。';
COMMENT ON COLUMN zzsh_order.ecs_test_demo_finance_registration.registered_at IS '数据库接受此登记的时间。';

CREATE UNIQUE INDEX ecs_test_demo_finance_one_active ON zzsh_order.ecs_test_demo_finance_registration(active) WHERE active;
REVOKE ALL ON zzsh_order.ecs_test_demo_finance_registration FROM PUBLIC;

CREATE FUNCTION zzsh_order.guard_ecs_test_demo_finance_registration() RETURNS trigger
LANGUAGE plpgsql SET search_path = pg_catalog, zzsh_order AS $guard$
DECLARE d record; doc jsonb; actual_runtime record; actual_migration record;
BEGIN
  SELECT db.oid::text AS oid,shobj_description(db.oid,'pg_database') AS marker,
    pg_get_userbyid(db.datdba) AS owner,db.datdba::text AS owner_oid
    INTO d FROM pg_database db WHERE db.datname=current_database();
  IF (current_database() ~ '^zzsh_ecs_test(_[a-z0-9_]{1,32})?$' AND d.marker='zzsh:ecs-test:v1'
    OR current_database()='zzsh_test_r07_delivery_20261108' AND d.marker='zzsh:r07-delivery-clone:v1') IS NOT TRUE
    OR current_user <> pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid='zzsh_order.ecs_test_demo_finance_registration'::regclass)) THEN
    RAISE EXCEPTION 'Only the registered demo schema owner may change enrollment';
  END IF;
  IF TG_OP = 'DELETE' THEN RAISE EXCEPTION 'Demo enrollment cannot be deleted'; END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.active IS NOT TRUE OR NEW.active IS NOT FALSE OR
       (NEW.reference,NEW.canonical_registration,NEW.registration_digest,NEW.registered_at)
        IS DISTINCT FROM (OLD.reference,OLD.canonical_registration,OLD.registration_digest,OLD.registered_at) THEN
      RAISE EXCEPTION 'Demo enrollment can only be deactivated';
    END IF;
    RETURN NEW;
  END IF;
  BEGIN doc := NEW.canonical_registration::jsonb;
  EXCEPTION WHEN others THEN RAISE EXCEPTION 'Invalid demo enrollment document'; END;
  SELECT r.oid::text AS oid,r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolbypassrls
    INTO actual_runtime FROM pg_roles r WHERE r.rolname=doc #>> '{resource,runtimeRole}';
  SELECT r.oid::text AS oid,r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolbypassrls
    INTO actual_migration FROM pg_roles r WHERE r.rolname=doc #>> '{resource,migrationRole}';
  IF doc->>'schema' IS DISTINCT FROM (CASE WHEN d.marker='zzsh:ecs-test:v1' THEN 'ecs-test-demo-finance.v1' ELSE 'local-demo-clone-finance.v1' END)
    OR doc->>'reference' IS DISTINCT FROM NEW.reference
    OR coalesce(doc->>'administratorId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR encode(sha256(convert_to(NEW.canonical_registration,'UTF8')),'hex') IS DISTINCT FROM NEW.registration_digest
    OR doc #>> '{resource,database}' IS DISTINCT FROM current_database()
    OR doc #>> '{resource,databaseOid}' IS DISTINCT FROM d.oid
    OR doc #>> '{resource,owner}' IS DISTINCT FROM d.owner::text
    OR doc #>> '{resource,ownerOid}' IS DISTINCT FROM d.owner_oid
    OR doc #>> '{resource,migrationRole}' IS DISTINCT FROM current_user::text
    OR doc #>> '{resource,migrationRoleOid}' IS DISTINCT FROM actual_migration.oid
    OR actual_migration.oid IS NULL OR actual_migration.rolsuper OR actual_migration.rolcreaterole OR actual_migration.rolcreatedb
    OR actual_migration.rolreplication OR actual_migration.rolbypassrls
    OR EXISTS(SELECT 1 FROM pg_auth_members m WHERE m.member::text IN (d.owner_oid,actual_migration.oid,actual_runtime.oid))
    OR doc #>> '{resource,marker}' IS DISTINCT FROM d.marker
    OR doc #>> '{resource,systemIdentifier}' IS DISTINCT FROM (SELECT system_identifier::text FROM pg_control_system())
    OR (d.marker='zzsh:r07-delivery-clone:v1' AND (coalesce(doc->>'nonce','') !~ '^[a-z0-9_]{12,64}$'
      OR doc->>'nonce' IS DISTINCT FROM current_setting('zzsh.regression_run',true)
      OR doc #>> '{origins,apiOrigin}' IS DISTINCT FROM 'http://127.0.0.1:4232'
      OR doc #>> '{origins,userOrigin}' IS DISTINCT FROM 'http://127.0.0.1:4230'
      OR doc #>> '{origins,adminOrigin}' IS DISTINCT FROM 'http://127.0.0.1:4231'
      OR doc #> '{origins,secureCookies}' IS DISTINCT FROM 'false'::jsonb))
    OR actual_runtime.oid IS NULL OR actual_runtime.oid IS DISTINCT FROM doc #>> '{resource,runtimeRoleOid}'
    OR doc #>> '{resource,runtimeRole}' = d.owner::text
    OR actual_runtime.rolsuper OR actual_runtime.rolcreaterole OR actual_runtime.rolcreatedb
    OR actual_runtime.rolreplication OR actual_runtime.rolbypassrls
    OR NEW.active IS NOT TRUE THEN
    RAISE EXCEPTION 'Demo enrollment does not match the live isolated database';
  END IF;
  NEW.registered_at := clock_timestamp();
  RETURN NEW;
END
$guard$;
COMMENT ON FUNCTION zzsh_order.guard_ecs_test_demo_finance_registration() IS '限制测试资金环境登记仅由对应数据库所有者创建或停用。';
REVOKE ALL ON FUNCTION zzsh_order.guard_ecs_test_demo_finance_registration() FROM PUBLIC;
CREATE TRIGGER guard_ecs_test_demo_finance_registration BEFORE INSERT OR UPDATE OR DELETE
  ON zzsh_order.ecs_test_demo_finance_registration FOR EACH ROW
  EXECUTE FUNCTION zzsh_order.guard_ecs_test_demo_finance_registration();
