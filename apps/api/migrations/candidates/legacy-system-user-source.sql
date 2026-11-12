-- Candidate only: new migration-role user sources must not impersonate an administrator.
ALTER TABLE zzsh_iam.audit_event ADD COLUMN legacy_user_migration_manifest_sha256 text
  CHECK (legacy_user_migration_manifest_sha256 ~ '^[a-f0-9]{64}$');

CREATE FUNCTION zzsh_iam.guard_legacy_system_user_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_oid oid; actor_role record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    IF OLD.legacy_user_migration_manifest_sha256 IS NOT NULL OR
       (TG_OP = 'UPDATE' AND NEW.legacy_user_migration_manifest_sha256 IS NOT NULL) THEN
      RAISE EXCEPTION 'system migration source is immutable' USING ERRCODE='40001';
    END IF;
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF NEW.legacy_user_migration_manifest_sha256 IS NULL THEN RETURN NEW; END IF;
  SELECT relowner INTO owner_oid FROM pg_class WHERE oid=TG_RELID;
  SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls INTO actor_role FROM pg_roles WHERE rolname=current_user;
  IF actor_role.oid IS DISTINCT FROM owner_oid OR current_user<>session_user
     OR actor_role.rolsuper OR actor_role.rolcreatedb OR actor_role.rolcreaterole OR actor_role.rolbypassrls
     OR NEW.actor_type IS DISTINCT FROM 'system' OR NEW.session_id IS NOT NULL
     OR NEW.action IS DISTINCT FROM 'user.legacy_owner.migrated' OR NEW.object_type IS DISTINCT FROM 'user'
     OR NEW.outcome IS DISTINCT FROM 'SUCCESS'
     OR COALESCE(NEW.details->>'migrationRunDigest','') !~ '^[a-f0-9]{64}$'
     OR NEW.actor_id IS DISTINCT FROM 'legacy-user-migration:'||(NEW.details->>'migrationRunDigest')
     OR NEW.details->>'sourceDatasetSha256' IS DISTINCT FROM NEW.legacy_user_migration_manifest_sha256
     OR NEW.details->>'sourceSystem' IS DISTINCT FROM 'legacy_mysql_restore' OR NEW.details->>'sourceEntity' IS DISTINCT FROM 'la_user'
     OR COALESCE(NEW.details->>'legacyId','') !~ '^[1-9][0-9]{0,23}$'
     OR COALESCE(NEW.details->>'sourceDigest','') !~ '^[a-f0-9]{64}$'
     OR COALESCE(NEW.details->>'evidenceDigest','') !~ '^[a-f0-9]{64}$'
     OR NEW.details#>>'{initialAvatar,created}' IS DISTINCT FROM 'true'
     OR NEW.details#>>'{initialAvatar,version}' IS DISTINCT FROM '1'
     OR NOT EXISTS (SELECT 1 FROM zzsh_supply.profile_avatar p WHERE p.realm='user' AND p.subject_id=NEW.object_id
       AND p.current_kind='DEFAULT' AND p.current_version=1 AND p.default_preset_id=p.current_preset_id
       AND p.default_preset_id=NEW.details#>>'{initialAvatar,presetId}') THEN
    RAISE EXCEPTION 'legacy system user source requires the migration owner' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legacy_system_user_audit_insert BEFORE INSERT ON zzsh_iam.audit_event
  FOR EACH ROW WHEN (NEW.legacy_user_migration_manifest_sha256 IS NOT NULL)
  EXECUTE FUNCTION zzsh_iam.guard_legacy_system_user_audit();
CREATE TRIGGER legacy_system_user_audit_update BEFORE UPDATE ON zzsh_iam.audit_event
  FOR EACH ROW WHEN (OLD.legacy_user_migration_manifest_sha256 IS NOT NULL OR NEW.legacy_user_migration_manifest_sha256 IS NOT NULL)
  EXECUTE FUNCTION zzsh_iam.guard_legacy_system_user_audit();
CREATE TRIGGER legacy_system_user_audit_delete BEFORE DELETE ON zzsh_iam.audit_event
  FOR EACH ROW WHEN (OLD.legacy_user_migration_manifest_sha256 IS NOT NULL)
  EXECUTE FUNCTION zzsh_iam.guard_legacy_system_user_audit();
REVOKE ALL ON FUNCTION zzsh_iam.guard_legacy_system_user_audit() FROM PUBLIC;
COMMENT ON COLUMN zzsh_iam.audit_event.legacy_user_migration_manifest_sha256 IS '旧用户由系统迁移导入时的源数据集摘要；空值不表示系统来源。';
COMMENT ON FUNCTION zzsh_iam.guard_legacy_system_user_audit() IS '限制旧用户系统迁移来源只能由迁移属主写入，且不可更改。';
