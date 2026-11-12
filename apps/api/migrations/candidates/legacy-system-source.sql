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
     OR NEW.outcome IS DISTINCT FROM 'SUCCESS' OR NEW.details->>'sourceSystem' IS DISTINCT FROM 'legacy_mysql_restore'
     OR NEW.details->>'sourceDatasetSha256' IS DISTINCT FROM NEW.legacy_migration_manifest_sha256
     OR COALESCE(NEW.details->>'migrationRunDigest','') !~ '^[a-f0-9]{64}$'
     OR COALESCE(NEW.details->>'legacyId','') !~ '^[1-9][0-9]{0,23}$'
     OR COALESCE(NEW.details->>'sourceDigest','') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'legacy system source requires the migration owner' USING ERRCODE='42501';
  END IF;
  IF NEW.action='user.legacy_owner.migrated' THEN
    actor_prefix:='legacy-user-migration:'; source_entity:='la_user';
    IF NEW.object_type IS DISTINCT FROM 'user' OR COALESCE(NEW.details->>'evidenceDigest','') !~ '^[a-f0-9]{64}$'
       OR NEW.details#>>'{initialAvatar,created}' IS DISTINCT FROM 'true' OR NEW.details#>>'{initialAvatar,version}' IS DISTINCT FROM '1'
       OR NOT EXISTS (SELECT 1 FROM zzsh_supply.profile_avatar p WHERE p.realm='user' AND p.subject_id=NEW.object_id
         AND p.current_kind='DEFAULT' AND p.current_version=1 AND p.default_preset_id=p.current_preset_id
         AND p.default_preset_id=NEW.details#>>'{initialAvatar,presetId}') THEN
      RAISE EXCEPTION 'legacy user source or avatar is invalid' USING ERRCODE='42501';
    END IF;
  ELSIF NEW.action IN ('supply.legacy.account_created','supply.publication.legacy_observed','supply.legacy.read_snapshot_recorded') THEN
    actor_prefix:='legacy-account-migration:'; source_entity:='la_rental_accounts';
    IF NEW.object_type IS DISTINCT FROM 'rental_account' OR COALESCE(NEW.details->>'payloadDigest','') !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'legacy account source is invalid' USING ERRCODE='42501';
    END IF;
  ELSIF NEW.action='order.legacy.read_imported' THEN
    actor_prefix:='legacy-order-migration:'; source_entity:='la_order';
    IF NEW.object_type IS DISTINCT FROM 'rental_order' OR COALESCE(NEW.details->>'bindingDigest','') !~ '^[a-f0-9]{64}$' THEN
      RAISE EXCEPTION 'legacy order source is invalid' USING ERRCODE='42501';
    END IF;
  ELSE
    RAISE EXCEPTION 'unsupported legacy system source' USING ERRCODE='42501';
  END IF;
  IF NEW.actor_id IS DISTINCT FROM actor_prefix||(NEW.details->>'migrationRunDigest')
     OR NEW.details->>'sourceEntity' IS DISTINCT FROM source_entity THEN
    RAISE EXCEPTION 'legacy system source identity is invalid' USING ERRCODE='42501';
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
