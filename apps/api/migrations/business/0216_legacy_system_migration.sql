-- System-owned legacy import source proof and indexed opening readback.
-- Import admission remains closed until full source and target verification.

--> statement-breakpoint
-- Contract: legacy-system-source
-- The migration owner records source facts without impersonating an administrator.
ALTER TABLE zzsh_iam.audit_event ADD COLUMN legacy_migration_manifest_sha256 text
  CHECK (legacy_migration_manifest_sha256 ~ '^[a-f0-9]{64}$');

CREATE FUNCTION zzsh_iam.guard_legacy_system_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_oid oid; actor_role record; actor_prefix text; source_entity text;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'legacy system migration source is immutable' USING ERRCODE='40001';
  END IF;
  SELECT relowner INTO owner_oid FROM pg_class WHERE oid=TG_RELID;
  SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls INTO actor_role FROM pg_roles WHERE rolname=current_user;
  IF actor_role.oid IS DISTINCT FROM owner_oid OR current_user<>session_user
     OR actor_role.rolsuper OR actor_role.rolcreatedb OR actor_role.rolcreaterole OR actor_role.rolbypassrls
     OR NEW.actor_type IS DISTINCT FROM 'system' OR NEW.session_id IS NOT NULL OR NEW.object_id IS NULL
     OR NEW.outcome IS DISTINCT FROM 'SUCCESS'
     OR (NEW.action NOT IN ('distribution.legacy_facts.imported','distribution.legacy_facts.counts_closed') AND
       (NEW.details->>'sourceSystem' IS DISTINCT FROM 'legacy_mysql_restore'
        OR NEW.details->>'sourceDatasetSha256' IS DISTINCT FROM NEW.legacy_migration_manifest_sha256
        OR COALESCE(NEW.details->>'migrationRunDigest','') !~ '^[a-f0-9]{64}$')) THEN
    RAISE EXCEPTION 'legacy system source requires the migration owner' USING ERRCODE='42501';
  END IF;
  IF NEW.action='distribution.legacy_facts.imported' THEN
    actor_prefix:='legacy-invitation-migration:';
    IF NEW.object_type IS DISTINCT FROM 'legacy_invitation_batch' OR NEW.object_id !~ '^[a-f0-9]{64}$'
       OR COALESCE(NEW.actor_id,'') !~ '^legacy-invitation-migration:[a-f0-9]{64}$' OR NEW.details->>'bodyDigest' IS DISTINCT FROM NEW.object_id
       OR NEW.details#>>'{source,sourceSystem}' IS DISTINCT FROM 'legacy_mysql_restore'
       OR COALESCE(NEW.details#>>'{source,receiptSha256}','') !~ '^[a-f0-9]{64}$'
       OR jsonb_typeof(NEW.details->'facts') IS DISTINCT FROM 'array' OR jsonb_array_length(NEW.details->'facts')<1
       OR NEW.details->'financialEffects' IS DISTINCT FROM 'false'::jsonb THEN
      RAISE EXCEPTION 'legacy invitation fact source is invalid' USING ERRCODE='42501';
    END IF;
  ELSIF NEW.action='distribution.legacy_facts.counts_closed' THEN
    actor_prefix:='legacy-invitation-migration:';
    IF NEW.object_type IS DISTINCT FROM 'legacy_invitation_batch' OR NEW.object_id !~ '^[a-f0-9]{64}$'
       OR COALESCE(NEW.actor_id,'') !~ '^legacy-invitation-migration:[a-f0-9]{64}$' OR NEW.details->>'bodyDigest' IS DISTINCT FROM NEW.object_id
       OR COALESCE(NEW.details->>'sourceDigest','') !~ '^[a-f0-9]{64}$' OR NEW.details->'financialEffects' IS DISTINCT FROM 'false'::jsonb
       OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='distribution.legacy_facts.imported'
         AND a.object_id=NEW.object_id AND a.actor_type='system' AND a.actor_id=NEW.actor_id AND a.outcome='SUCCESS'
         AND a.legacy_migration_manifest_sha256=NEW.legacy_migration_manifest_sha256) THEN
      RAISE EXCEPTION 'legacy invitation count source is invalid' USING ERRCODE='42501';
    END IF;
  ELSIF NEW.action='user.legacy_owner.migrated' THEN
    actor_prefix:='legacy-user-migration:'; source_entity:='la_user';
    IF NEW.object_type IS DISTINCT FROM 'user' OR COALESCE(NEW.details->>'evidenceDigest','') !~ '^[a-f0-9]{64}$'
       OR NEW.details#>>'{initialAvatar,created}' IS DISTINCT FROM 'true' OR NEW.details#>>'{initialAvatar,version}' IS DISTINCT FROM '1'
       OR NOT EXISTS (SELECT 1 FROM zzsh_supply.profile_avatar p WHERE p.realm='user' AND p.subject_id=NEW.object_id
         AND p.current_kind='DEFAULT' AND p.current_version=1 AND p.default_preset_id=p.current_preset_id
         AND p.default_preset_id=NEW.details#>>'{initialAvatar,presetId}')
       OR NOT EXISTS (SELECT 1 FROM zzsh_auth_user."user" u WHERE u.id=NEW.object_id
         AND u.image='/api/v1/profile/avatars/user/'||NEW.object_id||'/1') THEN
      RAISE EXCEPTION 'legacy user source or avatar is invalid' USING ERRCODE='42501';
    END IF;
  ELSIF NEW.action IN ('supply.legacy.account_created','supply.publication.legacy_observed','supply.legacy.read_snapshot_recorded','supply.legacy.display_snapshot_recorded') THEN
    actor_prefix:='legacy-account-migration:'; source_entity:='la_rental_accounts';
    IF NEW.object_type IS DISTINCT FROM 'rental_account' OR COALESCE(NEW.details->>'payloadDigest','') !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'legacy account source is invalid' USING ERRCODE='42501';
    END IF;
    IF NEW.action='supply.legacy.display_snapshot_recorded' AND
      (NEW.details->>'displayDigest' IS DISTINCT FROM NEW.details->>'payloadDigest'
       OR COALESCE(NEW.details->>'extractSha256','') !~ '^[a-f0-9]{64}$'
       OR COALESCE(NEW.details#>>'{after,observationVersionId}','')='') THEN
      RAISE EXCEPTION 'legacy display source is invalid' USING ERRCODE='42501';
    END IF;
  ELSIF NEW.action='order.legacy.read_imported' THEN
    actor_prefix:='legacy-order-migration:'; source_entity:='la_order';
    IF NEW.object_type IS DISTINCT FROM 'rental_order' OR COALESCE(NEW.details->>'bindingDigest','') !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'legacy order source is invalid' USING ERRCODE='42501';
    END IF;
  ELSIF NEW.action='order.legacy.continuation.import' THEN
    actor_prefix:='legacy-order-migration:'; source_entity:='la_order';
    IF NEW.object_type IS DISTINCT FROM 'rental_order' OR COALESCE(NEW.details->>'bindingDigest','') !~ '^[a-f0-9]{64}$'
       OR COALESCE(NEW.details->>'payloadDigest','') !~ '^[a-f0-9]{64}$'
       OR COALESCE(NEW.details->>'factsDigest','') !~ '^[a-f0-9]{64}$'
       OR COALESCE(NEW.details->>'evidenceId','')='' THEN
      RAISE EXCEPTION 'legacy continuation source is invalid' USING ERRCODE='42501';
    END IF;
  ELSIF NEW.action='order.legacy.liability.import' THEN
    actor_prefix:='legacy-order-migration:'; source_entity:='la_order';
    IF NEW.object_type IS DISTINCT FROM 'rental_order' OR COALESCE(NEW.details->>'bindingDigest','') !~ '^[a-f0-9]{64}$'
       OR COALESCE(NEW.details->>'payloadDigest','') !~ '^[a-f0-9]{64}$'
       OR NEW.details->>'parentSourceDigest' IS DISTINCT FROM NEW.details->>'sourceDigest'
       OR COALESCE(NEW.details->>'classification','') NOT IN ('COMPLETED_UNREFUNDED','DETAINED','POSTED_CONFISCATION','REFUND_RECORD_EXISTS')
       OR NEW.details->>'channelState' IS DISTINCT FROM 'UNKNOWN'
       OR COALESCE(NEW.details#>>'{settlementRecord,digest}','') !~ '^[a-f0-9]{64}$'
       OR encode(sha256(convert_to(NEW.details#>>'{settlementRecord,canonical}','UTF8')),'hex') IS DISTINCT FROM NEW.details#>>'{settlementRecord,digest}' THEN
      RAISE EXCEPTION 'legacy liability source is invalid' USING ERRCODE='42501';
    END IF;
  ELSIF NEW.action='order.legacy.commission.completed-import' THEN
    actor_prefix:='legacy-order-migration:'; source_entity:='la_order';
    IF NEW.object_type IS DISTINCT FROM 'rental_order' OR COALESCE(NEW.details->>'bindingDigest','') !~ '^[a-f0-9]{64}$'
       OR COALESCE(NEW.details->>'payloadDigest','') !~ '^[a-f0-9]{64}$'
       OR NEW.details->>'parentSourceDigest' IS DISTINCT FROM NEW.details->>'sourceDigest'
       OR COALESCE(NEW.details->>'sourceRecordId','') !~ '^[1-9][0-9]{0,23}$'
       OR COALESCE(NEW.details->>'sourceRecordDigest','') !~ '^[a-f0-9]{64}$'
       OR COALESCE(NEW.details->>'admissionId','') !~ '^legacy_admission_[a-f0-9]{40}$'
       OR COALESCE(NEW.details->>'admissionDigest','') !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'legacy completed commission source is invalid' USING ERRCODE='42501';
    END IF;
  ELSIF NEW.action='finance.history.empty_batch.imported' THEN
    actor_prefix:='legacy-finance-migration:'; source_entity:='EMPTY_FINANCE_COVERAGE';
    IF NEW.object_type IS DISTINCT FROM 'personal_finance_observation_coverage_batch'
       OR NEW.object_id !~ '^history-empty-batch-[a-f0-9]{40}$'
       OR NEW.details->>'schema' IS DISTINCT FROM 'finance-empty-coverage-batch.system.v1'
       OR NEW.details->>'batchId' IS DISTINCT FROM NEW.object_id OR NEW.details->>'financialEffect' IS DISTINCT FROM 'NONE'
       OR COALESCE(NEW.details->>'inputsDigest','') !~ '^[a-f0-9]{64}$'
       OR COALESCE(NEW.details->>'inputSha256','') !~ '^[a-f0-9]{64}$'
       OR COALESCE(NEW.details->>'coverageCount','') !~ '^([1-9]|[1-9][0-9]|[1-3][0-9]{2}|400)$' THEN
      RAISE EXCEPTION 'legacy empty finance source is invalid' USING ERRCODE='42501';
    END IF;
  ELSIF NEW.action='finance.history.batch.imported' THEN
    actor_prefix:='legacy-finance-migration:'; source_entity:='FINANCE_HISTORY_COVERAGE';
    IF NEW.object_type IS DISTINCT FROM 'personal_finance_observation_coverage_batch'
       OR NEW.object_id !~ '^history-batch-[a-f0-9]{40}$'
       OR NEW.details->>'schema' IS DISTINCT FROM 'finance-history-batch.system.v1'
       OR NEW.details->>'batchId' IS DISTINCT FROM NEW.object_id OR NEW.details->>'financialEffect' IS DISTINCT FROM 'NONE'
       OR COALESCE(NEW.details->>'inputsDigest','') !~ '^[a-f0-9]{64}$'
       OR COALESCE(NEW.details->>'inputSha256','') !~ '^[a-f0-9]{64}$'
       OR COALESCE(NEW.details->>'coverageCount','') !~ '^([1-9]|[1-9][0-9]|[1-4][0-9]{2}|500)$' THEN
      RAISE EXCEPTION 'legacy finance history source is invalid' USING ERRCODE='42501';
    END IF;
  ELSIF NEW.action='finance.opening.imported' THEN
    actor_prefix:='legacy-finance-migration:'; source_entity:='la_user';
    IF NEW.object_type IS DISTINCT FROM 'finance_event' OR COALESCE(NEW.details->>'subjectId','')=''
       OR COALESCE(NEW.details->>'bodyDigest','') !~ '^[a-f0-9]{64}$'
       OR COALESCE(NEW.details->>'inputSha256','') !~ '^[a-f0-9]{64}$'
       OR COALESCE(NEW.details->>'fenceEpochSha256','') !~ '^[a-f0-9]{64}$'
       OR COALESCE(NEW.details->>'executionRef','')='' OR COALESCE(NEW.details->>'attempt','')='' THEN
      RAISE EXCEPTION 'legacy opening source is invalid' USING ERRCODE='42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported legacy system source' USING ERRCODE='42501';
  END IF;
  IF NEW.action NOT IN ('distribution.legacy_facts.imported','distribution.legacy_facts.counts_closed') AND
     (NEW.actor_id IS DISTINCT FROM actor_prefix||(NEW.details->>'migrationRunDigest')
     OR NEW.details->>'sourceEntity' IS DISTINCT FROM source_entity) THEN
    RAISE EXCEPTION 'legacy system source identity is invalid' USING ERRCODE='42501';
  END IF;
  IF NEW.action NOT IN ('finance.history.empty_batch.imported','finance.history.batch.imported','distribution.legacy_facts.imported','distribution.legacy_facts.counts_closed')
     AND (COALESCE(NEW.details->>'legacyId','') !~ '^[1-9][0-9]{0,23}$'
       OR COALESCE(NEW.details->>'sourceDigest','') !~ '^[a-f0-9]{64}$') THEN
    RAISE EXCEPTION 'legacy system source tuple is invalid' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legacy_system_audit_insert BEFORE INSERT ON zzsh_iam.audit_event
  FOR EACH ROW WHEN (NEW.legacy_migration_manifest_sha256 IS NOT NULL) EXECUTE FUNCTION zzsh_iam.guard_legacy_system_audit();
CREATE TRIGGER legacy_system_audit_update BEFORE UPDATE ON zzsh_iam.audit_event
  FOR EACH ROW WHEN (OLD.legacy_migration_manifest_sha256 IS NOT NULL OR NEW.legacy_migration_manifest_sha256 IS NOT NULL)
  EXECUTE FUNCTION zzsh_iam.guard_legacy_system_audit();
CREATE TRIGGER legacy_system_audit_delete BEFORE DELETE ON zzsh_iam.audit_event
  FOR EACH ROW WHEN (OLD.legacy_migration_manifest_sha256 IS NOT NULL) EXECUTE FUNCTION zzsh_iam.guard_legacy_system_audit();
REVOKE ALL ON FUNCTION zzsh_iam.guard_legacy_system_audit() FROM PUBLIC;
COMMENT ON COLUMN zzsh_iam.audit_event.legacy_migration_manifest_sha256 IS '旧数据系统迁移绑定的源数据集摘要；空值不表示系统来源。';
COMMENT ON FUNCTION zzsh_iam.guard_legacy_system_audit() IS '限制旧数据系统来源只能由迁移属主写入，且不可更改。';

--> statement-breakpoint
-- Contract: legacy-system-account-source
-- Apply after the shared legacy migration source guard.
ALTER TABLE zzsh_supply.legacy_listing_read_snapshot
  ALTER COLUMN created_by_admin_id DROP NOT NULL,
  ADD COLUMN created_by_migration_id text,
  ADD COLUMN migration_manifest_sha256 text,
  ADD CONSTRAINT legacy_snapshot_migration_source CHECK (
    (created_by_admin_id IS NOT NULL AND created_by_migration_id IS NULL AND migration_manifest_sha256 IS NULL)
    OR (created_by_admin_id IS NULL AND created_by_migration_id IS NOT NULL AND migration_manifest_sha256 IS NOT NULL
      AND created_by_migration_id ~ '^legacy-account-migration:[a-f0-9]{64}$' AND migration_manifest_sha256 ~ '^[a-f0-9]{64}$')
  );
CREATE FUNCTION zzsh_supply.guard_legacy_system_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_oid oid; actor_role record;
BEGIN
  SELECT relowner INTO owner_oid FROM pg_class WHERE oid=TG_RELID;
  SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls INTO actor_role FROM pg_roles WHERE rolname=current_user;
  IF actor_role.oid IS DISTINCT FROM owner_oid OR current_user<>session_user
     OR actor_role.rolsuper OR actor_role.rolcreatedb OR actor_role.rolcreaterole OR actor_role.rolbypassrls THEN
    RAISE EXCEPTION 'legacy system snapshot requires the migration owner' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legacy_system_snapshot_insert BEFORE INSERT ON zzsh_supply.legacy_listing_read_snapshot
  FOR EACH ROW WHEN (NEW.created_by_migration_id IS NOT NULL) EXECUTE FUNCTION zzsh_supply.guard_legacy_system_snapshot();

CREATE FUNCTION zzsh_supply.guard_legacy_system_snapshot_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM zzsh_iam.audit_event a
    WHERE a.actor_type='system' AND a.actor_id=NEW.created_by_migration_id AND a.session_id IS NULL
      AND a.action='supply.legacy.read_snapshot_recorded' AND a.object_type='rental_account'
      AND a.object_id=NEW.account_id AND a.outcome='SUCCESS'
      AND a.legacy_migration_manifest_sha256=NEW.migration_manifest_sha256
      AND a.details->>'sourceSystem'=NEW.source_system AND a.details->>'sourceEntity'=NEW.source_entity
      AND a.details->>'legacyId'=NEW.legacy_id AND a.details->>'sourceDigest'=NEW.source_digest
      AND a.details#>>'{after,observationVersionId}'=NEW.observation_version_id) THEN
    RAISE EXCEPTION 'legacy system snapshot requires its matching source audit' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER legacy_system_snapshot_audit AFTER INSERT ON zzsh_supply.legacy_listing_read_snapshot
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.created_by_migration_id IS NOT NULL)
  EXECUTE FUNCTION zzsh_supply.guard_legacy_system_snapshot_audit();
REVOKE ALL ON FUNCTION zzsh_supply.guard_legacy_system_snapshot(),zzsh_supply.guard_legacy_system_snapshot_audit() FROM PUBLIC;
COMMENT ON COLUMN zzsh_supply.legacy_listing_read_snapshot.created_by_migration_id IS '系统迁移执行身份；管理员导入时为空。';
COMMENT ON COLUMN zzsh_supply.legacy_listing_read_snapshot.migration_manifest_sha256 IS '系统迁移的源数据集摘要；管理员导入时为空。';

ALTER TABLE zzsh_supply.legacy_listing_display_snapshot
  ALTER COLUMN created_by_admin_id DROP NOT NULL,
  ADD COLUMN created_by_migration_id text,
  ADD COLUMN migration_manifest_sha256 text,
  ADD CONSTRAINT legacy_display_migration_source CHECK (
    (created_by_admin_id IS NOT NULL AND created_by_migration_id IS NULL AND migration_manifest_sha256 IS NULL)
    OR (created_by_admin_id IS NULL AND created_by_migration_id IS NOT NULL AND migration_manifest_sha256 IS NOT NULL
      AND created_by_migration_id ~ '^legacy-account-migration:[a-f0-9]{64}$' AND migration_manifest_sha256 ~ '^[a-f0-9]{64}$')
  );
CREATE TRIGGER legacy_system_display_insert BEFORE INSERT ON zzsh_supply.legacy_listing_display_snapshot
  FOR EACH ROW WHEN (NEW.created_by_migration_id IS NOT NULL) EXECUTE FUNCTION zzsh_supply.guard_legacy_system_snapshot();
CREATE FUNCTION zzsh_supply.guard_legacy_system_display_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM zzsh_iam.audit_event a
    WHERE a.actor_type='system' AND a.actor_id=NEW.created_by_migration_id AND a.session_id IS NULL
      AND a.action='supply.legacy.display_snapshot_recorded' AND a.object_type='rental_account'
      AND a.object_id=NEW.account_id AND a.outcome='SUCCESS'
      AND a.legacy_migration_manifest_sha256=NEW.migration_manifest_sha256
      AND a.details->>'sourceSystem'='legacy_mysql_restore' AND a.details->>'sourceEntity'='la_rental_accounts'
      AND a.details->>'sourceDigest'=NEW.base_source_digest AND a.details->>'displayDigest'=NEW.display_digest
      AND a.details->>'extractSha256'=NEW.extract_sha256 AND a.details#>>'{after,observationVersionId}'=NEW.observation_version_id) THEN
    RAISE EXCEPTION 'legacy system display requires its matching source audit' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER legacy_system_display_audit AFTER INSERT ON zzsh_supply.legacy_listing_display_snapshot
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.created_by_migration_id IS NOT NULL)
  EXECUTE FUNCTION zzsh_supply.guard_legacy_system_display_audit();
REVOKE ALL ON FUNCTION zzsh_supply.guard_legacy_system_display_audit() FROM PUBLIC;
COMMENT ON COLUMN zzsh_supply.legacy_listing_display_snapshot.created_by_migration_id IS '系统迁移执行身份；管理员导入时为空。';
COMMENT ON COLUMN zzsh_supply.legacy_listing_display_snapshot.migration_manifest_sha256 IS '系统迁移的源数据集摘要；管理员导入时为空。';
COMMENT ON FUNCTION zzsh_supply.guard_legacy_system_display_audit() IS '校验旧账号展示事实与系统来源审计匹配。';

--> statement-breakpoint
-- Contract: legacy-system-order-source
-- Apply after the shared legacy migration source guard.
ALTER TABLE zzsh_order.legacy_order_read_snapshot ALTER COLUMN created_by_admin_id DROP NOT NULL,
  ADD COLUMN created_by_migration_id text, ADD COLUMN migration_manifest_sha256 text,
  ADD CONSTRAINT legacy_order_migration_source CHECK (
    (created_by_admin_id IS NOT NULL AND created_by_migration_id IS NULL AND migration_manifest_sha256 IS NULL)
    OR (created_by_admin_id IS NULL AND created_by_migration_id IS NOT NULL AND migration_manifest_sha256 IS NOT NULL
      AND created_by_migration_id ~ '^legacy-order-migration:[a-f0-9]{64}$' AND migration_manifest_sha256 ~ '^[a-f0-9]{64}$')
  );
CREATE FUNCTION zzsh_order.guard_legacy_system_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_oid oid; actor_role record;
BEGIN
  SELECT relowner INTO owner_oid FROM pg_class WHERE oid=TG_RELID;
  SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls INTO actor_role FROM pg_roles WHERE rolname=current_user;
  IF actor_role.oid IS DISTINCT FROM owner_oid OR current_user<>session_user
     OR actor_role.rolsuper OR actor_role.rolcreatedb OR actor_role.rolcreaterole OR actor_role.rolbypassrls THEN
    RAISE EXCEPTION 'legacy system order requires the migration owner' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legacy_system_order_insert BEFORE INSERT ON zzsh_order.legacy_order_read_snapshot
  FOR EACH ROW WHEN (NEW.created_by_migration_id IS NOT NULL) EXECUTE FUNCTION zzsh_order.guard_legacy_system_order();

CREATE OR REPLACE FUNCTION zzsh_order.check_legacy_order_read_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM zzsh_iam.audit_event e
    WHERE e.action='order.legacy.read_imported' AND e.object_id=NEW.id AND e.outcome='SUCCESS'
      AND e.details->>'sourceSystem'=NEW.source_system AND e.details->>'sourceEntity'=NEW.source_entity
      AND e.details->>'legacyId'=NEW.legacy_id AND e.details->>'sourceDigest'=NEW.source_digest
      AND e.details->>'bindingDigest'=NEW.binding_digest
      AND ((NEW.created_by_admin_id IS NOT NULL AND e.actor_id=NEW.created_by_admin_id)
        OR (NEW.created_by_admin_id IS NULL AND e.actor_type='system' AND e.session_id IS NULL
          AND e.actor_id=NEW.created_by_migration_id AND e.object_type='rental_order'
          AND e.legacy_migration_manifest_sha256=NEW.migration_manifest_sha256)))
  THEN RAISE EXCEPTION 'Legacy order import audit is missing' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.guard_legacy_system_order() FROM PUBLIC;
COMMENT ON COLUMN zzsh_order.legacy_order_read_snapshot.created_by_migration_id IS '系统迁移执行身份；管理员导入时为空。';
COMMENT ON COLUMN zzsh_order.legacy_order_read_snapshot.migration_manifest_sha256 IS '系统迁移的源数据集摘要；管理员导入时为空。';

ALTER TABLE zzsh_order.legacy_continuation_evidence
  ADD COLUMN created_by_migration_id text, ADD COLUMN migration_manifest_sha256 text,
  ADD CONSTRAINT legacy_continuation_migration_source CHECK (
    (created_by_migration_id IS NULL AND migration_manifest_sha256 IS NULL)
    OR (source_kind='SOURCE_IMPORT' AND created_by_migration_id IS NOT NULL AND migration_manifest_sha256 IS NOT NULL
      AND created_by_migration_id ~ '^legacy-order-migration:[a-f0-9]{64}$' AND migration_manifest_sha256 ~ '^[a-f0-9]{64}$')
  );
CREATE TRIGGER legacy_system_continuation_insert BEFORE INSERT ON zzsh_order.legacy_continuation_evidence
  FOR EACH ROW WHEN (NEW.created_by_migration_id IS NOT NULL) EXECUTE FUNCTION zzsh_order.guard_legacy_system_order();
CREATE FUNCTION zzsh_order.check_legacy_system_continuation_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM zzsh_iam.audit_event e JOIN zzsh_order.legacy_order_read_snapshot o ON o.id=NEW.order_id
    WHERE e.action='order.legacy.continuation.import' AND e.object_type='rental_order' AND e.object_id=NEW.order_id
      AND e.actor_type='system' AND e.actor_id=NEW.created_by_migration_id AND e.session_id IS NULL AND e.outcome='SUCCESS'
      AND e.legacy_migration_manifest_sha256=NEW.migration_manifest_sha256
      AND e.details->>'evidenceId'=NEW.id AND e.details->>'sourceDigest'=NEW.source_digest
      AND e.details->>'factsDigest'=NEW.facts_digest AND e.details->>'bindingDigest'=o.binding_digest
      AND o.created_by_migration_id=NEW.created_by_migration_id AND o.migration_manifest_sha256=NEW.migration_manifest_sha256)
  THEN RAISE EXCEPTION 'Legacy system continuation audit is missing' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER legacy_system_continuation_audit AFTER INSERT ON zzsh_order.legacy_continuation_evidence
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.created_by_migration_id IS NOT NULL)
  EXECUTE FUNCTION zzsh_order.check_legacy_system_continuation_audit();
REVOKE ALL ON FUNCTION zzsh_order.check_legacy_system_continuation_audit() FROM PUBLIC;
COMMENT ON COLUMN zzsh_order.legacy_continuation_evidence.created_by_migration_id IS '系统迁移执行身份；管理员和后续业务记录为空。';
COMMENT ON COLUMN zzsh_order.legacy_continuation_evidence.migration_manifest_sha256 IS '系统迁移的源数据集摘要；其他记录为空。';
COMMENT ON FUNCTION zzsh_order.check_legacy_system_continuation_audit() IS '校验旧单续办依据与系统迁移来源审计匹配。';

CREATE FUNCTION zzsh_order.check_legacy_system_liability_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o zzsh_order.legacy_order_read_snapshot; d zzsh_order.legacy_order_duty; s jsonb; r jsonb; classification text;
BEGIN
  SELECT * INTO o FROM zzsh_order.legacy_order_read_snapshot WHERE id=NEW.object_id;
  classification:=NEW.details->>'classification';s:=(NEW.details#>>'{settlementRecord,canonical}')::jsonb;
  IF o.id IS NULL OR o.source_pay_status IS DISTINCT FROM 1 OR s IS NULL OR jsonb_typeof(s) IS DISTINCT FROM 'object'
    OR o.created_by_migration_id IS DISTINCT FROM NEW.actor_id OR o.migration_manifest_sha256 IS DISTINCT FROM NEW.legacy_migration_manifest_sha256
    OR NEW.details->>'bindingDigest' IS DISTINCT FROM o.binding_digest OR NEW.details->>'sourceDigest' IS DISTINCT FROM o.source_digest
    OR NEW.details->>'legacyId' IS DISTINCT FROM o.legacy_id OR NEW.details->>'sourceStatus' IS DISTINCT FROM s->>'is_settle' OR NOT (s @> o.source_snapshot)
    OR (classification<>'REFUND_RECORD_EXISTS' AND NEW.details->'refundRecord' IS DISTINCT FROM 'null'::jsonb)
    OR (SELECT count(*) FROM zzsh_iam.audit_event a WHERE a.object_type='rental_order' AND a.object_id=o.id
      AND a.action='order.legacy.liability.import' AND a.outcome='SUCCESS')<>1
  THEN RAISE EXCEPTION 'Legacy system liability order or audit mismatch' USING ERRCODE='23514'; END IF;
  IF classification='REFUND_RECORD_EXISTS' THEN
    r:=(NEW.details#>>'{refundRecord,canonical}')::jsonb;
    IF o.source_order_status<>5 OR COALESCE((s->>'return_order_money')::numeric,0)<=0 OR NEW.details->>'dutyId' IS NOT NULL
      OR COALESCE(NEW.details#>>'{refundRecord,digest}','') !~ '^[a-f0-9]{64}$'
      OR encode(sha256(convert_to(NEW.details#>>'{refundRecord,canonical}','UTF8')),'hex') IS DISTINCT FROM NEW.details#>>'{refundRecord,digest}'
      OR r->>'order_id' IS DISTINCT FROM o.legacy_id OR COALESCE(r->>'id','') !~ '^[1-9][0-9]{0,23}$'
    THEN RAISE EXCEPTION 'Legacy refund source evidence mismatch' USING ERRCODE='23514'; END IF;
  ELSE
    SELECT * INTO d FROM zzsh_order.legacy_order_duty WHERE id=NEW.details->>'dutyId' AND order_id=o.id;
    IF d.id IS NULL OR d.source IS DISTINCT FROM 'LEGACY_IMPORT' OR d.source_record_id IS DISTINCT FROM o.legacy_id
      OR d.source_status IS DISTINCT FROM classification OR d.source_digest IS DISTINCT FROM o.source_digest
      OR (classification='POSTED_CONFISCATION' AND (s->>'is_settle' IS DISTINCT FROM '3' OR d.kind<>'DEPOSIT_COMPENSATION'
        OR d.counterparty_user_id IS DISTINCT FROM o.owner_user_id OR d.amount_cents IS DISTINCT FROM o.deposit_amount_cents
        OR d.status<>'SETTLED' OR d.settled_by IS DISTINCT FROM 'LEGACY_RECORDS'))
      OR (classification IN ('COMPLETED_UNREFUNDED','DETAINED') AND (o.source_order_status<>4 OR d.kind<>'RENTER_REFUND'
        OR d.counterparty_user_id IS DISTINCT FROM o.renter_user_id OR d.status<>'PENDING' OR d.settled_by IS NOT NULL
        OR s->>'is_settle' IS DISTINCT FROM CASE classification WHEN 'DETAINED' THEN '2' ELSE '0' END
        OR d.amount_cents IS DISTINCT FROM ((s->>'return_order_money')::numeric-GREATEST(COALESCE((s->>'detain_money')::numeric,0),0))*100))
    THEN RAISE EXCEPTION 'Legacy system liability duty mismatch' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER legacy_system_liability_audit AFTER INSERT ON zzsh_iam.audit_event
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.legacy_migration_manifest_sha256 IS NOT NULL AND NEW.action='order.legacy.liability.import')
  EXECUTE FUNCTION zzsh_order.check_legacy_system_liability_audit();
REVOKE ALL ON FUNCTION zzsh_order.check_legacy_system_liability_audit() FROM PUBLIC;
COMMENT ON FUNCTION zzsh_order.check_legacy_system_liability_audit() IS '校验旧退款责任与系统来源及历史记录一致，不表示渠道到账。';

CREATE OR REPLACE FUNCTION zzsh_order.check_legacy_duty_admission() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE d zzsh_order.legacy_order_duty;l zzsh_order.legacy_order_read_snapshot;s jsonb;f jsonb;t jsonb;
BEGIN
 SELECT * INTO d FROM zzsh_order.legacy_order_duty WHERE id=NEW.duty_id;
 SELECT * INTO l FROM zzsh_order.legacy_order_read_snapshot WHERE id=NEW.order_id;
 s:=NEW.source_canonical::jsonb;f:=NEW.final_amount_evidence_canonical::jsonb;t:=NEW.time_evidence_canonical::jsonb;
 IF d.id IS NULL OR l.source_order_status IS DISTINCT FROM 4 OR l.source_pay_status IS DISTINCT FROM 1
  OR(d.order_id,d.kind,d.source_record_id,d.counterparty_user_id,d.amount_cents,d.currency,d.level,d.ratio,d.maturity_at,d.admission_id)
   IS DISTINCT FROM(NEW.order_id,NEW.kind,NEW.source_record_id,NEW.counterparty_user_id,NEW.amount_cents,NEW.currency,NEW.level,NEW.ratio,NEW.maturity_at,NEW.id)
  OR NEW.parent_source_digest IS DISTINCT FROM l.source_digest OR s->>'order_id' IS DISTINCT FROM l.legacy_id OR s->>'id' IS DISTINCT FROM NEW.source_record_id
  OR s->>'status' IS DISTINCT FROM '1' OR(s->>'earnings')::numeric*100 IS DISTINCT FROM NEW.amount_cents
  OR f->>'parentSourceDigest' IS DISTINCT FROM NEW.parent_source_digest OR f->>'sourceRecordDigest' IS DISTINCT FROM NEW.source_record_digest
  OR f->>'beneficiaryLegacyId' IS DISTINCT FROM s->>'user_id' OR(f->>'amountCents')::numeric IS DISTINCT FROM NEW.amount_cents
  OR(f->>'cutoff')::timestamptz IS DISTINCT FROM NEW.cutoff
  OR t->>'parentSourceDigest' IS DISTINCT FROM NEW.parent_source_digest OR t->>'sourceRecordDigest' IS DISTINCT FROM NEW.source_record_digest
  OR t->>'kind' IS DISTINCT FROM NEW.time_kind OR(t->>'at')::timestamptz IS DISTINCT FROM NEW.source_time OR(t->>'cutoff')::timestamptz IS DISTINCT FROM NEW.cutoff
  OR t->>'sourceValue' IS DISTINCT FROM NEW.source_time_value OR t->>'sourceUnit' IS DISTINCT FROM NEW.source_time_unit
  OR NOT EXISTS(SELECT 1 FROM zzsh_iam.user_identity_state i WHERE i.user_id=NEW.counterparty_user_id AND i.provider='legacy_mysql_restore' AND i.provider_reference='la_user:'||(s->>'user_id'))
  OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.object_id=NEW.order_id AND a.action='order.legacy.commission.completed-import' AND a.outcome='SUCCESS'
   AND a.details->>'admissionId'=NEW.id AND a.details->>'admissionDigest'=NEW.admission_digest
   AND ((a.actor_type='admin' AND a.actor_id=NEW.reviewed_by->>'userId' AND a.session_id=NEW.reviewed_by->>'sessionId')
     OR (a.actor_type='system' AND a.session_id IS NULL AND NEW.reviewed_by->>'kind'='SYSTEM_ORDER_MIGRATION'
       AND a.actor_id=NEW.reviewed_by->>'id' AND a.legacy_migration_manifest_sha256=NEW.reviewed_by->>'sourceDatasetSha256'
       AND l.created_by_migration_id=a.actor_id AND l.migration_manifest_sha256=a.legacy_migration_manifest_sha256
       AND a.details->>'bindingDigest'=l.binding_digest AND a.details->>'sourceRecordId'=NEW.source_record_id
       AND a.details->>'sourceRecordDigest'=NEW.source_record_digest)))
 THEN RAISE EXCEPTION 'Completed commission admission/actor/audit incomplete' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;

--> statement-breakpoint
-- Contract: legacy-system-opening-source
-- Apply after the shared legacy migration source guard. Existing administrator reviews remain valid.
CREATE OR REPLACE FUNCTION zzsh_order.guard_stored_opening_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b zzsh_order.finance_opening_basis;s jsonb;i jsonb;r jsonb;owner_name text;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 s:=NEW.source_canonical::jsonb;i:=NEW.input_canonical::jsonb;r:=NEW.review_canonical::jsonb;
 IF current_user IS DISTINCT FROM owner_name OR b.id IS NULL OR b.source_kind<>'LEGACY_OPENING' OR b.created_xid<>pg_current_xact_id()
  OR NOT COALESCE((current_setting('zzsh.actor_type',true)='admin' AND r#>>'{actor,userId}'=current_setting('zzsh.actor_id',true)
    AND r#>>'{actor,sessionId}'=current_setting('zzsh.session_id',true) AND r#>>'{actor,userId}' IS NOT NULL AND r#>>'{actor,sessionId}' IS NOT NULL)
   OR (current_setting('zzsh.actor_type',true)='system' AND current_user=session_user AND NULLIF(current_setting('zzsh.session_id',true),'') IS NULL
    AND r#>>'{actor,kind}'='SYSTEM_FINANCE_MIGRATION' AND r#>>'{actor,id}'=current_setting('zzsh.actor_id',true)
    AND r#>>'{actor,id}' ~ '^legacy-finance-migration:[a-f0-9]{64}$' AND r#>>'{actor,sourceDatasetSha256}' ~ '^[a-f0-9]{64}$'
    AND r#>>'{actor,fenceEpochSha256}' ~ '^[a-f0-9]{64}$' AND r#>>'{target,databaseOid}'=(SELECT oid::text FROM pg_database WHERE datname=current_database())
    AND r#>>'{target,roleOid}'=(SELECT oid::text FROM pg_roles WHERE rolname=current_user)
    AND r#>>'{target,systemIdentifier}'=(SELECT system_identifier::text FROM pg_control_system())
    AND r#>>'{target,marker}'=(SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database())
    AND r#>>'{target,nonce}'=current_setting('zzsh.regression_run',true)),false)
  OR jsonb_typeof(s) IS DISTINCT FROM 'object' OR jsonb_typeof(i) IS DISTINCT FROM 'object' OR jsonb_typeof(r) IS DISTINCT FROM 'object'
  OR r->>'notBefore' IS NULL OR r->>'expiresAt' IS NULL OR r->>'ref' IS NULL OR r->>'attempt' IS NULL OR r->>'inputSha256' IS DISTINCT FROM i->>'inputSha256'
  OR i->>'cutoff' IS DISTINCT FROM r->>'cutoff' OR r->>'observationCount' IS NULL OR r->>'coveredCount' IS NULL
  OR (r->>'notBefore')::timestamptz>=(r->>'expiresAt')::timestamptz
  OR encode(sha256(convert_to('{"id":'||to_jsonb(s->>'id')::text||',"earnings":'||to_jsonb(s->>'earnings')::text||',"money":'||to_jsonb(s->>'money')::text||'}','UTF8')),'hex') IS DISTINCT FROM b.source_digest
  OR encode(sha256(convert_to(NEW.input_canonical,'UTF8')),'hex') IS DISTINCT FROM NEW.body_digest
  OR encode(sha256(convert_to(NEW.review_canonical,'UTF8')),'hex') IS DISTINCT FROM NEW.review_digest
  OR i->>'sourceCanonical' IS DISTINCT FROM NEW.source_canonical OR r->>'bodyDigest' IS DISTINCT FROM NEW.body_digest
  OR s->>'id' IS DISTINCT FROM b.source_id OR NOT COALESCE((s->>'earnings')~'^(0|[1-9][0-9]{0,21})\.[0-9]{2}$',false)
  OR NOT COALESCE((s->>'money')~'^-?(0|[1-9][0-9]{0,21})\.[0-9]{2}$',false) OR (s->>'earnings')::numeric*100 IS DISTINCT FROM b.available_cents
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(s) k WHERE k NOT IN('id','earnings','money'))
  OR r#>>'{subject,userId}' IS DISTINCT FROM b.user_id OR r#>>'{subject,sourceId}' IS DISTINCT FROM b.source_id
  OR r#>>'{subject,identityDigest}' IS DISTINCT FROM b.identity_source_digest OR r#>>'{subject,sourceDigest}' IS DISTINCT FROM b.source_digest
  OR r#>>'{subject,availableCents}' IS DISTINCT FROM b.available_cents::text OR r#>>'{subject,coveredDigest}' IS DISTINCT FROM b.covered_set_digest
  OR (r->>'coveredCount')::int IS DISTINCT FROM b.covered_count OR (r->>'cutoff')::timestamptz IS DISTINCT FROM b.source_cutoff
  OR (r->>'observationCount')::int NOT BETWEEN 0 AND 10000 OR b.covered_count>5000
  OR i->'proof' IS DISTINCT FROM jsonb_build_object('userId',b.user_id,'source',jsonb_build_object('sourceSystem',b.source_system,'sourceEntity',b.source_entity,'sourceId',b.source_id,'identityDigest',b.identity_source_digest),'availableCents',b.available_cents::text,'sourceDigest',b.source_digest,'coveredCount',b.covered_count,'coveredDigest',b.covered_set_digest,'coveredSet',i#>'{proof,coveredSet}')
  OR jsonb_typeof(i->'admissions') IS DISTINCT FROM 'array' OR jsonb_typeof(i->'observations') IS DISTINCT FROM 'array'
  OR jsonb_array_length(i->'admissions') IS DISTINCT FROM (r->>'observationCount')::int
  OR jsonb_array_length(i->'observations') IS DISTINCT FROM (r->>'observationCount')::int
  OR (r->>'notBefore')::timestamptz>clock_timestamp() OR (r->>'expiresAt')::timestamptz<=clock_timestamp()
  OR b.source_cutoff>(r->>'notBefore')::timestamptz
 THEN RAISE EXCEPTION 'stored opening exact source/review/actor mismatch' USING ERRCODE='23514'; END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;

CREATE FUNCTION zzsh_order.check_legacy_system_opening_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b zzsh_order.finance_opening_basis;r jsonb;event_id text;
BEGIN
 r:=NEW.review_canonical::jsonb;
 IF r#>>'{actor,kind}' IS DISTINCT FROM 'SYSTEM_FINANCE_MIGRATION' THEN RETURN NULL; END IF;
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 SELECT e.id INTO event_id FROM zzsh_order.finance_economic_root root JOIN zzsh_order.finance_event e ON e.economic_root_id=root.id
  WHERE root.basis_id=b.id AND e.kind='OPENING' AND e.subject_user_id=b.user_id;
 IF event_id IS NULL OR (SELECT count(*) FROM zzsh_iam.audit_event a WHERE a.action='finance.opening.imported' AND a.object_type='finance_event'
   AND a.object_id=event_id AND a.outcome='SUCCESS')<>1 OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a
   WHERE a.action='finance.opening.imported' AND a.object_type='finance_event' AND a.object_id=event_id AND a.outcome='SUCCESS'
    AND a.actor_type='system' AND a.actor_id=r#>>'{actor,id}' AND a.session_id IS NULL
    AND a.legacy_migration_manifest_sha256=r#>>'{actor,sourceDatasetSha256}' AND a.details->>'subjectId'=b.user_id
    AND a.details->>'legacyId'=b.source_id AND a.details->>'sourceDigest'=b.source_digest AND a.details->>'bodyDigest'=NEW.body_digest
    AND a.details->>'inputSha256'=r->>'inputSha256' AND a.details->>'executionRef'=r->>'ref' AND a.details->>'attempt'=r->>'attempt'
    AND a.details->>'fenceEpochSha256'=r#>>'{actor,fenceEpochSha256}')
 THEN RAISE EXCEPTION 'Legacy system opening audit is missing' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER legacy_system_opening_audit AFTER INSERT ON zzsh_order.finance_stored_opening_review
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_legacy_system_opening_audit();
REVOKE ALL ON FUNCTION zzsh_order.check_legacy_system_opening_audit() FROM PUBLIC;
COMMENT ON FUNCTION zzsh_order.check_legacy_system_opening_audit() IS '校验期初余额的系统迁移来源、事实和审计，不表示渠道到账。';

--> statement-breakpoint
-- Contract: legacy-opening-covered-index
-- Keep deferred opening coverage checks indexed by their existing lookup key.
CREATE INDEX finance_covered_event_basis_idx ON zzsh_order.finance_covered_event (basis_id);
CREATE INDEX personal_finance_observation_basis_idx ON zzsh_order.personal_finance_observation (basis_id) WHERE basis_id IS NOT NULL;
COMMENT ON INDEX zzsh_order.finance_covered_event_basis_idx IS '按期初依据核对覆盖事实，避免逐户扫描全部历史覆盖记录。';
COMMENT ON INDEX zzsh_order.personal_finance_observation_basis_idx IS '按期初依据核对历史观察事实，空依据不进入此索引。';
