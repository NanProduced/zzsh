-- Candidate only; apply after legacy-system-source.sql.
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
