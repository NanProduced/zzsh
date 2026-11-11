-- 首次新装的分销政策可以来自同一旧站快照；已有管理员创建版本保持原样。
ALTER TABLE zzsh_order.distribution_policy_version
  ALTER COLUMN created_by_admin_id DROP NOT NULL,
  ADD COLUMN initial_source_receipt_sha256 text,
  ADD CONSTRAINT distribution_policy_version_creator_origin CHECK (
    (created_by_admin_id IS NOT NULL AND initial_source_receipt_sha256 IS NULL)
    OR (created_by_admin_id IS NULL AND scope='NATIVE' AND revision=1
      AND initial_source_receipt_sha256 IS NOT NULL
      AND initial_source_receipt_sha256 ~ '^[a-f0-9]{64}$')
  );

COMMENT ON COLUMN zzsh_order.distribution_policy_version.initial_source_receipt_sha256 IS '仅首次系统初始化时记录同源旧站采集回执摘要；管理员创建版本为空。';
COMMENT ON CONSTRAINT distribution_policy_version_creator_origin ON zzsh_order.distribution_policy_version IS '管理员创建与首次系统来源互斥；系统来源只允许原生首版。';

CREATE FUNCTION zzsh_order.guard_initial_distribution_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_name text;
BEGIN
  IF NEW.initial_source_receipt_sha256 IS NULL THEN RETURN NEW; END IF;
  SELECT pg_get_userbyid(c.relowner) INTO owner_name FROM pg_class c
    WHERE c.oid='zzsh_order.distribution_policy_version'::regclass;
  IF current_user IS DISTINCT FROM owner_name OR session_user IS DISTINCT FROM current_user
    OR EXISTS(SELECT 1 FROM pg_roles WHERE rolname=current_user AND (rolsuper OR rolbypassrls))
    OR NEW.schema_version IS DISTINCT FROM 'distribution-policy.v3'
    OR NEW.canonical_config::jsonb #>> '{legacySource,receiptSha256}' IS DISTINCT FROM NEW.initial_source_receipt_sha256
  THEN RAISE EXCEPTION 'first distribution source is not authorized' USING ERRCODE='42501'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('zzsh:distribution-policy:NATIVE',0));
  LOCK TABLE zzsh_auth_user."user", zzsh_order.rental_order, zzsh_order.legacy_order_read_snapshot,
    zzsh_order.distribution_participant, zzsh_order.invitation_relation IN SHARE MODE;
  IF EXISTS(SELECT 1 FROM zzsh_auth_user."user") OR EXISTS(SELECT 1 FROM zzsh_order.rental_order)
    OR EXISTS(SELECT 1 FROM zzsh_order.legacy_order_read_snapshot) OR EXISTS(SELECT 1 FROM zzsh_order.distribution_participant)
    OR EXISTS(SELECT 1 FROM zzsh_order.invitation_relation)
  THEN RAISE EXCEPTION 'first distribution target is not empty' USING ERRCODE='23514'; END IF;
  IF EXISTS(SELECT 1 FROM zzsh_order.distribution_policy_version WHERE scope='NATIVE')
    OR EXISTS(SELECT 1 FROM zzsh_order.distribution_policy_head WHERE scope='NATIVE')
  THEN RAISE EXCEPTION 'first distribution policy already exists' USING ERRCODE='23505'; END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER distribution_policy_first_source_guard BEFORE INSERT ON zzsh_order.distribution_policy_version
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_initial_distribution_source();

CREATE FUNCTION zzsh_order.guard_initial_distribution_audit() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (SELECT count(*) FROM zzsh_iam.audit_event a
      WHERE a.actor_type='system' AND a.actor_id='migration.first-deployment' AND a.session_id IS NULL
        AND a.action='distribution.policy.system_initialized' AND a.object_type='distribution_policy_version'
        AND a.object_id=NEW.id AND a.outcome='SUCCESS'
        AND a.details->>'sourceReceiptSha256'=NEW.initial_source_receipt_sha256
        AND a.details->>'policyDigest'=NEW.config_digest
        AND a.xmin::text=(pg_current_xact_id()::text::numeric % 4294967296)::text) <> 1
  THEN RAISE EXCEPTION 'first distribution policy requires its system audit' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER distribution_policy_first_source_audit
  AFTER INSERT ON zzsh_order.distribution_policy_version DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.initial_source_receipt_sha256 IS NOT NULL)
  EXECUTE FUNCTION zzsh_order.guard_initial_distribution_audit();

COMMENT ON FUNCTION zzsh_order.guard_initial_distribution_source() IS '限制首次系统分销政策的来源、数据库角色与唯一初始版本。';
COMMENT ON FUNCTION zzsh_order.guard_initial_distribution_audit() IS '确保首次系统分销政策与同一事务的真实来源审计相互绑定。';
