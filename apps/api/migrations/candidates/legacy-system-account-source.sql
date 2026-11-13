-- Candidate only; apply after legacy-system-source.sql.
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
