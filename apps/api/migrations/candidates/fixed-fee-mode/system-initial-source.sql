-- Candidate: preserve existing admin foreign keys as compatibility references.
-- A source stamp is owned by the direct migration role, immutable, and never backfilled from a Boss id.
CREATE FUNCTION zzsh_iam.guard_system_initial_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.system_initial_sha256 IS NOT DISTINCT FROM NEW.system_initial_sha256 THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'system initialization source is immutable' USING ERRCODE='40001';
  END IF;
  NEW.system_initial_sha256:=COALESCE(NEW.system_initial_sha256,NULLIF(current_setting('zzsh.system_initial_sha256',true),''));
  IF NEW.system_initial_sha256 IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
    WHERE c.oid=TG_RELID AND r.rolname=current_user AND current_user=session_user AND NOT r.rolsuper AND NOT r.rolbypassrls
  ) THEN RAISE EXCEPTION 'system initialization requires the migration owner' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION zzsh_iam.guard_system_initial_source() FROM PUBLIC;
COMMENT ON FUNCTION zzsh_iam.guard_system_initial_source() IS '首次初始化来源仅由独立迁移属主写入，写入后不可更改。';
--> statement-breakpoint
DO $bootstrap_source$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'zzsh_supply.price_version','zzsh_supply.term_version','zzsh_supply.agreement_version',
    'zzsh_supply.full_payout_terms_version','zzsh_supply.rule_release',
    'zzsh_content.content_item','zzsh_content.content_version','zzsh_content.help_tree_node','zzsh_content.legal_document_version'
  ] LOOP
    EXECUTE format('ALTER TABLE %s ADD COLUMN system_initial_sha256 text CHECK (system_initial_sha256 ~ %L)',target,'^[a-f0-9]{64}$');
    EXECUTE format('COMMENT ON COLUMN %s.system_initial_sha256 IS %L',target,'系统首次初始化确认包摘要；非空时初始管理员外键仅作兼容引用。');
    EXECUTE format('CREATE TRIGGER system_initial_source_guard BEFORE INSERT OR UPDATE OF system_initial_sha256 ON %s FOR EACH ROW EXECUTE FUNCTION zzsh_iam.guard_system_initial_source()',target);
  END LOOP;
END $bootstrap_source$;
