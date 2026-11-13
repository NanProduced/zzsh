-- Candidate only; apply after legacy-system-source.sql. Existing administrator reviews remain valid.
CREATE OR REPLACE FUNCTION zzsh_order.guard_stored_opening_review() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b zzsh_order.finance_opening_basis;s jsonb;i jsonb;r jsonb;owner_name text;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 s:=NEW.source_canonical::jsonb;i:=NEW.input_canonical::jsonb;r:=NEW.review_canonical::jsonb;
 IF current_user IS DISTINCT FROM owner_name OR b.id IS NULL OR b.source_kind<>'LEGACY_OPENING' OR b.created_xid<>pg_current_xact_id()
  OR NOT COALESCE((current_setting('zzsh.actor_type',true)='admin' AND r#>>'{actor,userId}'=current_setting('zzsh.actor_id',true)
    AND r#>>'{actor,sessionId}'=current_setting('zzsh.session_id',true) AND r#>>'{actor,userId}' IS NOT NULL AND r#>>'{actor,sessionId}' IS NOT NULL)
   OR (current_setting('zzsh.actor_type',true)='system' AND current_user=session_user AND NULLIF(current_setting('zzsh.session_id',true),'') IS NULL
    AND r#>>'{actor,kind}'='SYSTEM_FINANCE_MIGRATION' AND r#>>'{actor,id}'=current_setting('zzsh.actor_id',true)
    AND r#>>'{actor,id}' ~ '^legacy-finance-migration:[a-f0-9]{64}$' AND r#>>'{actor,sourceDatasetSha256}' ~ '^[a-f0-9]{64}$'
    AND r#>>'{actor,fenceEpochSha256}' ~ '^[a-f0-9]{64}$' AND r#>>'{target,databaseOid}'=(SELECT oid::text FROM pg_database WHERE datname=current_database())
    AND r#>>'{target,roleOid}'=(SELECT oid::text FROM pg_roles WHERE rolname=current_user)
    AND r#>>'{target,systemIdentifier}'=(SELECT system_identifier::text FROM pg_control_system())
    AND r#>>'{target,marker}'=(SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database())
    AND r#>>'{target,nonce}'=current_setting('zzsh.regression_run',true)),false)
  OR jsonb_typeof(s) IS DISTINCT FROM 'object' OR jsonb_typeof(i) IS DISTINCT FROM 'object' OR jsonb_typeof(r) IS DISTINCT FROM 'object'
  OR r->>'notBefore' IS NULL OR r->>'expiresAt' IS NULL OR r->>'ref' IS NULL OR r->>'attempt' IS NULL OR r->>'inputSha256' IS DISTINCT FROM i->>'inputSha256'
  OR i->>'cutoff' IS DISTINCT FROM r->>'cutoff' OR r->>'observationCount' IS NULL OR r->>'coveredCount' IS NULL
  OR (r->>'notBefore')::timestamptz>=(r->>'expiresAt')::timestamptz
  OR encode(sha256(convert_to('{"id":'||to_jsonb(s->>'id')::text||',"earnings":'||to_jsonb(s->>'earnings')::text||',"money":'||to_jsonb(s->>'money')::text||'}','UTF8')),'hex') IS DISTINCT FROM b.source_digest
  OR encode(sha256(convert_to(NEW.input_canonical,'UTF8')),'hex') IS DISTINCT FROM NEW.body_digest
  OR encode(sha256(convert_to(NEW.review_canonical,'UTF8')),'hex') IS DISTINCT FROM NEW.review_digest
  OR i->>'sourceCanonical' IS DISTINCT FROM NEW.source_canonical OR r->>'bodyDigest' IS DISTINCT FROM NEW.body_digest
  OR s->>'id' IS DISTINCT FROM b.source_id OR NOT COALESCE((s->>'earnings')~'^(0|[1-9][0-9]{0,21})\.[0-9]{2}$',false)
  OR NOT COALESCE((s->>'money')~'^-?(0|[1-9][0-9]{0,21})\.[0-9]{2}$',false) OR (s->>'earnings')::numeric*100 IS DISTINCT FROM b.available_cents
  OR EXISTS(SELECT 1 FROM jsonb_object_keys(s) k WHERE k NOT IN('id','earnings','money'))
  OR r#>>'{subject,userId}' IS DISTINCT FROM b.user_id OR r#>>'{subject,sourceId}' IS DISTINCT FROM b.source_id
  OR r#>>'{subject,identityDigest}' IS DISTINCT FROM b.identity_source_digest OR r#>>'{subject,sourceDigest}' IS DISTINCT FROM b.source_digest
  OR r#>>'{subject,availableCents}' IS DISTINCT FROM b.available_cents::text OR r#>>'{subject,coveredDigest}' IS DISTINCT FROM b.covered_set_digest
  OR (r->>'coveredCount')::int IS DISTINCT FROM b.covered_count OR (r->>'cutoff')::timestamptz IS DISTINCT FROM b.source_cutoff
  OR (r->>'observationCount')::int NOT BETWEEN 0 AND 10000 OR b.covered_count>5000
  OR i->'proof' IS DISTINCT FROM jsonb_build_object('userId',b.user_id,'source',jsonb_build_object('sourceSystem',b.source_system,'sourceEntity',b.source_entity,'sourceId',b.source_id,'identityDigest',b.identity_source_digest),'availableCents',b.available_cents::text,'sourceDigest',b.source_digest,'coveredCount',b.covered_count,'coveredDigest',b.covered_set_digest,'coveredSet',i#>'{proof,coveredSet}')
  OR jsonb_typeof(i->'admissions') IS DISTINCT FROM 'array' OR jsonb_typeof(i->'observations') IS DISTINCT FROM 'array'
  OR jsonb_array_length(i->'admissions') IS DISTINCT FROM (r->>'observationCount')::int
  OR jsonb_array_length(i->'observations') IS DISTINCT FROM (r->>'observationCount')::int
  OR (r->>'notBefore')::timestamptz>clock_timestamp() OR (r->>'expiresAt')::timestamptz<=clock_timestamp()
  OR b.source_cutoff>(r->>'notBefore')::timestamptz
 THEN RAISE EXCEPTION 'stored opening exact source/review/actor mismatch' USING ERRCODE='23514'; END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;

CREATE FUNCTION zzsh_order.check_legacy_system_opening_audit() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b zzsh_order.finance_opening_basis;r jsonb;event_id text;
BEGIN
 r:=NEW.review_canonical::jsonb;
 IF r#>>'{actor,kind}' IS DISTINCT FROM 'SYSTEM_FINANCE_MIGRATION' THEN RETURN NULL; END IF;
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 SELECT e.id INTO event_id FROM zzsh_order.finance_economic_root root JOIN zzsh_order.finance_event e ON e.economic_root_id=root.id
  WHERE root.basis_id=b.id AND e.kind='OPENING' AND e.subject_user_id=b.user_id;
 IF event_id IS NULL OR (SELECT count(*) FROM zzsh_iam.audit_event a WHERE a.action='finance.opening.imported' AND a.object_type='finance_event'
   AND a.object_id=event_id AND a.outcome='SUCCESS')<>1 OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a
   WHERE a.action='finance.opening.imported' AND a.object_type='finance_event' AND a.object_id=event_id AND a.outcome='SUCCESS'
    AND a.actor_type='system' AND a.actor_id=r#>>'{actor,id}' AND a.session_id IS NULL
    AND a.legacy_migration_manifest_sha256=r#>>'{actor,sourceDatasetSha256}' AND a.details->>'subjectId'=b.user_id
    AND a.details->>'legacyId'=b.source_id AND a.details->>'sourceDigest'=b.source_digest AND a.details->>'bodyDigest'=NEW.body_digest
    AND a.details->>'inputSha256'=r->>'inputSha256' AND a.details->>'executionRef'=r->>'ref' AND a.details->>'attempt'=r->>'attempt'
    AND a.details->>'fenceEpochSha256'=r#>>'{actor,fenceEpochSha256}')
 THEN RAISE EXCEPTION 'Legacy system opening audit is missing' USING ERRCODE='23514'; END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER legacy_system_opening_audit AFTER INSERT ON zzsh_order.finance_stored_opening_review
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_legacy_system_opening_audit();
REVOKE ALL ON FUNCTION zzsh_order.check_legacy_system_opening_audit() FROM PUBLIC;
COMMENT ON FUNCTION zzsh_order.check_legacy_system_opening_audit() IS '校验期初余额的系统迁移来源、事实和审计，不表示渠道到账。';
