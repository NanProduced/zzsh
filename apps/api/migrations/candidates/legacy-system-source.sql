-- Candidate only: the migration owner records source facts without impersonating an administrator.
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
