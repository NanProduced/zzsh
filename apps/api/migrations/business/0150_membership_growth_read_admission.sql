-- 历史成长读取准入：仅维护身份可声明已完整验证的无来源零基底，不改写既有事实。
-- 已逐键验证过的无单零基底准入；它不是会员档位或权益缓存。
CREATE TABLE zzsh_iam.membership_growth_legacy_read_admission (
 coverage_id text PRIMARY KEY REFERENCES zzsh_iam.membership_growth_legacy_coverage(id),
 subject_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 record_digest text NOT NULL CHECK(record_digest~'^[a-f0-9]{64}$'),
 coverage_fingerprint text NOT NULL CHECK(coverage_fingerprint~'^[a-f0-9]{64}$'),
 source_receipt_digest text NOT NULL CHECK(source_receipt_digest~'^[a-f0-9]{64}$'),
 cutoff timestamptz NOT NULL,
 validation_contract text NOT NULL CHECK(validation_contract='LEGACY_NO_SOURCE_ZERO_V1'),
 actor_admin_id text NOT NULL,
 scope_key text NOT NULL,
 execution_key text NOT NULL,
 business_fingerprint text NOT NULL CHECK(business_fingerprint~'^[a-f0-9]{64}$'),
 business_package_sha256 text NOT NULL CHECK(business_package_sha256~'^[a-f0-9]{64}$'),
 success_audit_id text NOT NULL REFERENCES zzsh_iam.audit_event(id),
 approval_ref text NOT NULL CHECK(length(approval_ref)>0),
 approval_attempt integer NOT NULL CHECK(approval_attempt>0),
 admission_batch_digest text NOT NULL CHECK(admission_batch_digest~'^[a-f0-9]{64}$'),
 admitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(success_audit_id), UNIQUE(scope_key,execution_key),
 FOREIGN KEY(scope_key,execution_key) REFERENCES zzsh_supply.idempotency_record(scope_key,key)
);

COMMENT ON TABLE zzsh_iam.membership_growth_legacy_read_admission IS '正式维护已完整核验的无单零成长基底准入；不是会员等级、价格或权益缓存。';
COMMENT ON COLUMN zzsh_iam.membership_growth_legacy_read_admission.record_digest IS '原不可变覆盖canonical全文摘要，防止替换其它版本。';

CREATE FUNCTION zzsh_iam.guard_legacy_growth_read_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE c zzsh_iam.membership_growth_legacy_coverage;i zzsh_supply.idempotency_record;e zzsh_iam.audit_event;doc jsonb;expected_scope text;expected_fingerprint text;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'legacy growth read admission is immutable' USING ERRCODE='23514'; END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  OR current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid='zzsh_iam.membership_growth_legacy_coverage'::regclass)
 THEN RAISE EXCEPTION 'legacy growth read admission owner required' USING ERRCODE='42501';END IF;
 SELECT * INTO c FROM zzsh_iam.membership_growth_legacy_coverage WHERE id=NEW.coverage_id;
 IF c.id IS NULL OR c.subject_user_id IS DISTINCT FROM NEW.subject_user_id OR c.record_digest IS DISTINCT FROM NEW.record_digest
  OR c.fingerprint IS DISTINCT FROM NEW.coverage_fingerprint OR c.receipt_digest IS DISTINCT FROM NEW.source_receipt_digest
  OR c.cutoff IS DISTINCT FROM NEW.cutoff OR c.from_exclusive IS NOT NULL OR c.coverage_state<>'COMPLETE'
 THEN RAISE EXCEPTION 'legacy growth zero base binding mismatch' USING ERRCODE='23514';END IF;
 doc:=c.record;
 IF doc->>'packageDigest' IS DISTINCT FROM NEW.business_package_sha256
  OR doc->'expectedSourceKeys' IS DISTINCT FROM '[]'::jsonb OR doc->'factKeys' IS DISTINCT FROM '[]'::jsonb
  OR doc->'presentSourceKeys' IS DISTINCT FROM '[]'::jsonb OR doc->'missingSourceKeys' IS DISTINCT FROM '[]'::jsonb
  OR doc->'unknownSourceKeys' IS DISTINCT FROM '[]'::jsonb OR doc->'correctionProofDigests' IS DISTINCT FROM '[]'::jsonb
 THEN RAISE EXCEPTION 'legacy growth read admission only accepts verified no-source zero' USING ERRCODE='23514';END IF;
 expected_scope:=zzsh_order.canonical_finance_json(jsonb_build_array('admin',NEW.actor_admin_id,'membership.growth.legacy.backfill',NULL));
 IF NEW.scope_key IS DISTINCT FROM expected_scope THEN RAISE EXCEPTION 'legacy growth original scope mismatch' USING ERRCODE='23514';END IF;
 SELECT * INTO i FROM zzsh_supply.idempotency_record WHERE scope_key=NEW.scope_key AND key=NEW.execution_key;
 SELECT * INTO e FROM zzsh_iam.audit_event WHERE id=NEW.success_audit_id;
 IF i.scope_key IS NULL OR e.id IS NULL OR i.response_status<>200 OR i.publish_required
  OR i.request_fingerprint IS DISTINCT FROM NEW.business_fingerprint
  OR i.response_body->>'schema' IS DISTINCT FROM 'legacy-growth-maintenance-receipt-v1'
  OR i.response_body->>'operation' IS DISTINCT FROM 'membership.growth.legacy.backfill'
  OR i.response_body->>'executionKey' IS DISTINCT FROM NEW.execution_key
  OR i.response_body->>'subjectUserId' IS DISTINCT FROM NEW.subject_user_id
  OR i.response_body->>'businessFingerprint' IS DISTINCT FROM NEW.business_fingerprint
  OR i.response_body->>'businessPackageSha256' IS DISTINCT FROM NEW.business_package_sha256
  OR i.response_body->>'coverageFingerprint' IS DISTINCT FROM NEW.coverage_fingerprint
  OR i.response_body->>'coverageExecutionKey' IS DISTINCT FROM c.execution_key
  OR i.response_body->>'sourceReceiptDigest' IS DISTINCT FROM NEW.source_receipt_digest
  OR i.response_body->>'coverageState' IS DISTINCT FROM 'COMPLETE'
  OR i.response_body->'inserted' IS DISTINCT FROM '0'::jsonb OR i.response_body->'replayed' IS DISTINCT FROM '0'::jsonb
  OR i.response_body#>>'{execution,approvalRef}' IS DISTINCT FROM NEW.approval_ref
  OR jsonb_typeof(i.response_body#>'{execution,attempt}') IS DISTINCT FROM 'number'
  OR i.response_body#>>'{execution,attempt}' IS DISTINCT FROM NEW.approval_attempt::text
  OR e.actor_type IS DISTINCT FROM 'admin' OR e.actor_id IS DISTINCT FROM NEW.actor_admin_id
  OR e.action IS DISTINCT FROM 'membership.growth.legacy.backfill' OR e.object_type IS DISTINCT FROM 'legacy_growth_maintenance'
  OR e.object_id IS DISTINCT FROM NEW.subject_user_id OR e.outcome IS DISTINCT FROM 'SUCCESS'
  OR e.details->>'executionKey' IS DISTINCT FROM NEW.execution_key
  OR e.details->>'businessFingerprint' IS DISTINCT FROM NEW.business_fingerprint
  OR e.details->>'businessPackageSha256' IS DISTINCT FROM NEW.business_package_sha256
  OR e.details->>'coverageFingerprint' IS DISTINCT FROM NEW.coverage_fingerprint
  OR e.details->>'coverageExecutionKey' IS DISTINCT FROM c.execution_key
  OR e.details->>'sourceReceiptDigest' IS DISTINCT FROM NEW.source_receipt_digest
  OR e.details->>'coverageState' IS DISTINCT FROM 'COMPLETE'
  OR e.details->'inserted' IS DISTINCT FROM '0'::jsonb OR e.details->'replayed' IS DISTINCT FROM '0'::jsonb
  OR e.details->>'approvalRef' IS DISTINCT FROM NEW.approval_ref OR e.details->>'attempt' IS DISTINCT FROM NEW.approval_attempt::text
 THEN RAISE EXCEPTION 'legacy growth original success evidence mismatch' USING ERRCODE='23514';END IF;
 expected_fingerprint:=encode(sha256(convert_to(zzsh_order.canonical_finance_json(jsonb_build_object(
  'operation','membership.growth.legacy.backfill','schema','legacy-growth-maintenance-intent-v1','subjectUserId',NEW.subject_user_id,
  'businessPackageSha256',NEW.business_package_sha256,'reason',e.reason)),'UTF8')),'hex');
 IF expected_fingerprint IS DISTINCT FROM NEW.business_fingerprint THEN RAISE EXCEPTION 'legacy growth original business body mismatch' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER legacy_growth_read_admission_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_iam.membership_growth_legacy_read_admission
 FOR EACH ROW EXECUTE FUNCTION zzsh_iam.guard_legacy_growth_read_admission();
CREATE TRIGGER legacy_growth_read_admission_no_truncate BEFORE TRUNCATE ON zzsh_iam.membership_growth_legacy_read_admission
 FOR EACH STATEMENT EXECUTE FUNCTION zzsh_iam.guard_legacy_growth_read_admission();
REVOKE ALL ON FUNCTION zzsh_iam.guard_legacy_growth_read_admission() FROM PUBLIC;

-- 清除默认/继承表列授权；Root在统一runtime ACL中仅恢复SELECT。
DO $zero_read_acl$
DECLARE relation_oid oid;owner_oid oid;column_list text;grant_row record;grantee_sql text;
BEGIN
 SELECT oid,relowner INTO STRICT relation_oid,owner_oid FROM pg_class WHERE oid='zzsh_iam.membership_growth_legacy_read_admission'::regclass;
 SELECT string_agg(format('%I',attname),',' ORDER BY attnum) INTO STRICT column_list FROM pg_attribute WHERE attrelid=relation_oid AND attnum>0 AND NOT attisdropped;
 FOR grant_row IN SELECT DISTINCT grantee FROM (
  SELECT 0::oid AS grantee UNION ALL SELECT a.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid=relation_oid
  UNION ALL SELECT a.grantee FROM pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a WHERE c.attrelid=relation_oid AND c.attnum>0 AND NOT c.attisdropped
 ) grants WHERE grantee<>owner_oid LOOP
  IF grant_row.grantee=0 THEN grantee_sql:='PUBLIC';ELSE SELECT format('%I',rolname) INTO STRICT grantee_sql FROM pg_roles WHERE oid=grant_row.grantee;END IF;
  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE zzsh_iam.membership_growth_legacy_read_admission FROM %s',grantee_sql);
  EXECUTE format('REVOKE ALL PRIVILEGES (%s) ON TABLE zzsh_iam.membership_growth_legacy_read_admission FROM %s',column_list,grantee_sql);
 END LOOP;
END $zero_read_acl$;
