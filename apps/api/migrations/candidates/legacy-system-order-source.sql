-- Candidate only: preserve historical order facts without inventing an administrator session.
ALTER TABLE zzsh_iam.audit_event ADD COLUMN legacy_order_migration_manifest_sha256 text
  CHECK (legacy_order_migration_manifest_sha256 ~ '^[a-f0-9]{64}$');
CREATE FUNCTION zzsh_iam.guard_legacy_system_order_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_oid oid; actor_role record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'system order migration source is immutable' USING ERRCODE='40001';
  END IF;
  SELECT relowner INTO owner_oid FROM pg_class WHERE oid=TG_RELID;
  SELECT oid,rolsuper,rolcreatedb,rolcreaterole,rolbypassrls INTO actor_role FROM pg_roles WHERE rolname=current_user;
  IF actor_role.oid IS DISTINCT FROM owner_oid OR current_user<>session_user
     OR actor_role.rolsuper OR actor_role.rolcreatedb OR actor_role.rolcreaterole OR actor_role.rolbypassrls
     OR NEW.actor_type IS DISTINCT FROM 'system' OR NEW.session_id IS NOT NULL
     OR NEW.action IS DISTINCT FROM 'order.legacy.read_imported' OR NEW.object_type IS DISTINCT FROM 'rental_order'
     OR NEW.object_id IS NULL OR NEW.outcome IS DISTINCT FROM 'SUCCESS'
     OR COALESCE(NEW.details->>'migrationRunDigest','') !~ '^[a-f0-9]{64}$'
     OR NEW.actor_id IS DISTINCT FROM 'legacy-order-migration:'||(NEW.details->>'migrationRunDigest')
     OR NEW.details->>'sourceDatasetSha256' IS DISTINCT FROM NEW.legacy_order_migration_manifest_sha256
     OR NEW.details->>'sourceSystem' IS DISTINCT FROM 'legacy_mysql_restore' OR NEW.details->>'sourceEntity' IS DISTINCT FROM 'la_order'
     OR COALESCE(NEW.details->>'legacyId','') !~ '^[1-9][0-9]{0,23}$'
     OR COALESCE(NEW.details->>'sourceDigest','') !~ '^[a-f0-9]{64}$'
     OR COALESCE(NEW.details->>'bindingDigest','') !~ '^[a-f0-9]{64}$' THEN
    RAISE EXCEPTION 'legacy system order source requires the migration owner' USING ERRCODE='42501';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legacy_system_order_audit_insert BEFORE INSERT ON zzsh_iam.audit_event
  FOR EACH ROW WHEN (NEW.legacy_order_migration_manifest_sha256 IS NOT NULL) EXECUTE FUNCTION zzsh_iam.guard_legacy_system_order_audit();
CREATE TRIGGER legacy_system_order_audit_update BEFORE UPDATE ON zzsh_iam.audit_event
  FOR EACH ROW WHEN (OLD.legacy_order_migration_manifest_sha256 IS NOT NULL OR NEW.legacy_order_migration_manifest_sha256 IS NOT NULL)
  EXECUTE FUNCTION zzsh_iam.guard_legacy_system_order_audit();
CREATE TRIGGER legacy_system_order_audit_delete BEFORE DELETE ON zzsh_iam.audit_event
  FOR EACH ROW WHEN (OLD.legacy_order_migration_manifest_sha256 IS NOT NULL) EXECUTE FUNCTION zzsh_iam.guard_legacy_system_order_audit();

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
          AND e.legacy_order_migration_manifest_sha256=NEW.migration_manifest_sha256)))
  THEN RAISE EXCEPTION 'Legacy order import audit is missing' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION zzsh_iam.guard_legacy_system_order_audit(),zzsh_order.guard_legacy_system_order() FROM PUBLIC;
COMMENT ON COLUMN zzsh_iam.audit_event.legacy_order_migration_manifest_sha256 IS '旧订单系统迁移绑定的源数据集摘要；空值不表示系统来源。';
COMMENT ON COLUMN zzsh_order.legacy_order_read_snapshot.created_by_migration_id IS '系统迁移执行身份；管理员导入时为空。';
COMMENT ON COLUMN zzsh_order.legacy_order_read_snapshot.migration_manifest_sha256 IS '系统迁移的源数据集摘要；管理员导入时为空。';
