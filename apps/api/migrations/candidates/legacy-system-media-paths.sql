-- System imports retain private source paths without impersonating an administrator.
ALTER TABLE zzsh_supply.legacy_account_media_paths
  ALTER COLUMN created_by_admin_id DROP NOT NULL,
  ADD COLUMN created_by_migration_id text,
  ADD COLUMN migration_manifest_sha256 text,
  ADD COLUMN migration_batch_id text,
  ADD CONSTRAINT legacy_media_paths_migration_source CHECK (
    (created_by_admin_id IS NOT NULL AND created_by_migration_id IS NULL AND migration_manifest_sha256 IS NULL AND migration_batch_id IS NULL)
    OR (created_by_admin_id IS NULL AND created_by_migration_id IS NOT NULL AND migration_manifest_sha256 IS NOT NULL AND migration_batch_id IS NOT NULL
      AND created_by_migration_id ~ '^legacy-account-migration:[a-f0-9]{64}$' AND migration_manifest_sha256 ~ '^[a-f0-9]{64}$'
      AND migration_batch_id ~ '^legacy-media-batch:[a-f0-9]{64}$')
  );
CREATE INDEX legacy_media_paths_migration_batch_idx ON zzsh_supply.legacy_account_media_paths(migration_batch_id) WHERE migration_batch_id IS NOT NULL;
CREATE TRIGGER legacy_system_media_paths_insert BEFORE INSERT ON zzsh_supply.legacy_account_media_paths
  FOR EACH ROW WHEN (NEW.created_by_migration_id IS NOT NULL) EXECUTE FUNCTION zzsh_supply.guard_legacy_system_snapshot();
--> statement-breakpoint
DO $migration$
DECLARE definition text; branch_anchor text := $old$  ELSIF NEW.action='order.legacy.read_imported' THEN$old$;
  branch_value text := $new$  ELSIF NEW.action='supply.legacy.image_paths_recorded' THEN
    actor_prefix:='legacy-account-migration:'; source_entity:='la_rental_accounts';
    IF NEW.object_type IS DISTINCT FROM 'legacy_media_batch' OR COALESCE(NEW.details->>'sourceBindingDigest','') !~ '^[a-f0-9]{64}$'
       OR NEW.object_id IS DISTINCT FROM 'legacy-media-batch:'||(NEW.details->>'sourceBindingDigest')
       OR COALESCE(NEW.details->>'count','') !~ '^([1-9]|[1-9][0-9]|100)$' THEN
      RAISE EXCEPTION 'legacy media batch source is invalid' USING ERRCODE='42501';
    END IF;
  ELSIF NEW.action='order.legacy.read_imported' THEN$new$;
  tuple_anchor text := $old$'distribution.legacy_facts.imported','distribution.legacy_facts.counts_closed')
     AND (COALESCE(NEW.details->>'legacyId'$old$;
  tuple_value text := $new$'distribution.legacy_facts.imported','distribution.legacy_facts.counts_closed','supply.legacy.image_paths_recorded')
     AND (COALESCE(NEW.details->>'legacyId'$new$;
BEGIN
  SELECT pg_get_functiondef('zzsh_iam.guard_legacy_system_audit()'::regprocedure) INTO definition;
  IF definition IS NULL OR length(definition)-length(replace(definition,branch_anchor,''))<>length(branch_anchor)
    OR length(definition)-length(replace(definition,tuple_anchor,''))<>length(tuple_anchor) THEN
    RAISE EXCEPTION 'legacy audit source guard differs from expected version' USING ERRCODE='23514';
  END IF;
  EXECUTE replace(replace(definition,branch_anchor,branch_value),tuple_anchor,tuple_value);
END $migration$;
--> statement-breakpoint
CREATE FUNCTION zzsh_supply.guard_legacy_system_media_paths_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM zzsh_iam.audit_event a WHERE a.actor_type='system' AND a.actor_id=NEW.created_by_migration_id
    AND a.session_id IS NULL AND a.action='supply.legacy.image_paths_recorded' AND a.object_type='legacy_media_batch'
    AND a.object_id=NEW.migration_batch_id AND a.outcome='SUCCESS' AND a.legacy_migration_manifest_sha256=NEW.migration_manifest_sha256
    AND a.details->>'sourceSystem'='legacy_mysql_restore' AND a.details->>'sourceEntity'='la_rental_accounts'
    AND a.object_id='legacy-media-batch:'||(a.details->>'sourceBindingDigest')
    AND (a.details->>'count')::integer=(SELECT count(*) FROM zzsh_supply.legacy_account_media_paths p WHERE p.migration_batch_id=NEW.migration_batch_id))<>1 THEN
    RAISE EXCEPTION 'legacy system image paths require matching batch audit' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER legacy_system_media_paths_audit AFTER INSERT ON zzsh_supply.legacy_account_media_paths
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.created_by_migration_id IS NOT NULL)
  EXECUTE FUNCTION zzsh_supply.guard_legacy_system_media_paths_audit();
REVOKE ALL ON FUNCTION zzsh_supply.guard_legacy_system_media_paths_audit() FROM PUBLIC;
COMMENT ON COLUMN zzsh_supply.legacy_account_media_paths.created_by_migration_id IS '系统迁移执行身份；管理员导入时为空。';
COMMENT ON COLUMN zzsh_supply.legacy_account_media_paths.migration_manifest_sha256 IS '系统迁移的源数据集摘要；管理员导入时为空。';
COMMENT ON COLUMN zzsh_supply.legacy_account_media_paths.migration_batch_id IS '系统迁移批次标识，绑定批次审计和原回执。';
COMMENT ON INDEX zzsh_supply.legacy_media_paths_migration_batch_idx IS '按系统迁移批次核对图片路径来源。';
COMMENT ON FUNCTION zzsh_supply.guard_legacy_system_media_paths_audit() IS '校验旧图片路径系统迁移事实及批次审计，不表示媒体对象已上传。';
