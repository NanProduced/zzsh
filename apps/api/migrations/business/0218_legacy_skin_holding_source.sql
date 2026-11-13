-- Preserve the importing system identity without manufacturing an administrator session.
ALTER TABLE zzsh_supply.legacy_skin_holding
  ALTER COLUMN created_by_admin_id DROP NOT NULL,
  ADD COLUMN created_by_migration_id text,
  ADD COLUMN migration_manifest_sha256 text,
  ADD CONSTRAINT legacy_skin_holding_migration_source CHECK (
    (created_by_admin_id IS NOT NULL AND created_by_migration_id IS NULL AND migration_manifest_sha256 IS NULL)
    OR (created_by_admin_id IS NULL AND created_by_migration_id IS NOT NULL AND migration_manifest_sha256 IS NOT NULL
      AND created_by_migration_id ~ '^legacy-account-migration:[a-f0-9]{64}$'
      AND migration_manifest_sha256 ~ '^[a-f0-9]{64}$')
  );
--> statement-breakpoint
CREATE TRIGGER legacy_system_skin_holding_insert BEFORE INSERT ON zzsh_supply.legacy_skin_holding
  FOR EACH ROW WHEN (NEW.created_by_migration_id IS NOT NULL) EXECUTE FUNCTION zzsh_supply.guard_legacy_system_snapshot();
--> statement-breakpoint
-- Extend the existing owner-only audit guard without replacing any other source rule.
DO $migration$
DECLARE definition text; old_clause text := $old$'supply.legacy.display_snapshot_recorded') THEN$old$;
  new_clause text := $new$'supply.legacy.display_snapshot_recorded','supply.legacy.skin_holdings_recorded') THEN$new$;
BEGIN
  SELECT pg_get_functiondef('zzsh_iam.guard_legacy_system_audit()'::regprocedure) INTO definition;
  IF definition IS NULL OR length(definition)-length(replace(definition,old_clause,''))<>length(old_clause) THEN
    RAISE EXCEPTION 'legacy audit source guard differs from expected version' USING ERRCODE='23514';
  END IF;
  EXECUTE replace(definition,old_clause,new_clause);
END $migration$;
--> statement-breakpoint
CREATE FUNCTION zzsh_supply.guard_legacy_system_skin_holding_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM zzsh_iam.audit_event a
    WHERE a.actor_type='system' AND a.actor_id=NEW.created_by_migration_id AND a.session_id IS NULL
      AND a.action='supply.legacy.skin_holdings_recorded' AND a.object_type='rental_account'
      AND a.object_id=NEW.account_id AND a.outcome='SUCCESS'
      AND a.legacy_migration_manifest_sha256=NEW.migration_manifest_sha256
      AND a.details->>'sourceSystem'=NEW.source_system AND a.details->>'sourceEntity'=NEW.source_entity
      AND a.details->>'legacyId'=NEW.legacy_id AND a.details->>'sourceDigest'=NEW.source_digest
      AND a.details->>'holdingDigest'=NEW.holding_digest AND a.details->>'evidenceRef'=NEW.evidence_ref
      AND a.details->>'observationVersionId'=NEW.observation_version_id
      AND a.details->'attachedSkins'=to_jsonb(NEW.skin_ids)
      AND a.details->>'payloadDigest'=a.details#>>'{sourceAdmission,requestFingerprint}'
      AND a.details#>>'{sourceAdmission,bindingDigest}' ~ '^[a-f0-9]{64}$')<>1 THEN
    RAISE EXCEPTION 'legacy system skin holding requires its matching source audit' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER legacy_system_skin_holding_audit AFTER INSERT ON zzsh_supply.legacy_skin_holding
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN (NEW.created_by_migration_id IS NOT NULL)
  EXECUTE FUNCTION zzsh_supply.guard_legacy_system_skin_holding_audit();
REVOKE ALL ON FUNCTION zzsh_supply.guard_legacy_system_skin_holding_audit() FROM PUBLIC;
COMMENT ON COLUMN zzsh_supply.legacy_skin_holding.created_by_migration_id IS '系统迁移执行身份；管理员导入时为空。';
COMMENT ON COLUMN zzsh_supply.legacy_skin_holding.migration_manifest_sha256 IS '系统迁移的源数据集摘要；管理员导入时为空。';
COMMENT ON FUNCTION zzsh_supply.guard_legacy_system_skin_holding_audit() IS '校验旧账号皮肤持有事实与系统迁移来源审计匹配。';
