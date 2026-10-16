-- Immutable, owner-maintained legacy growth closure versions. Runtime receives SELECT only.
CREATE TABLE zzsh_iam.membership_growth_legacy_coverage (
 id text PRIMARY KEY CHECK(id ~ '^growth_coverage_[a-f0-9]{48}$'),
 subject_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 fingerprint text NOT NULL CHECK(fingerprint ~ '^[a-f0-9]{64}$'),
 execution_key text NOT NULL CHECK(execution_key ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$'),
 receipt_digest text NOT NULL CHECK(receipt_digest ~ '^[a-f0-9]{64}$'),
 cutoff timestamptz NOT NULL, from_exclusive timestamptz,
 coverage_state text NOT NULL CHECK(coverage_state IN('COMPLETE','BACKFILL_PENDING')),
 record jsonb NOT NULL CHECK(jsonb_typeof(record)='object'),
 record_canonical text NOT NULL,
 record_digest text NOT NULL CHECK(record_digest=encode(sha256(convert_to(record_canonical,'UTF8')),'hex')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(subject_user_id,fingerprint), UNIQUE(subject_user_id,execution_key),
 CHECK(from_exclusive IS NULL OR from_exclusive<cutoff),
 CHECK(record_canonical::jsonb=record)
);
CREATE INDEX membership_growth_legacy_coverage_subject_scope
 ON zzsh_iam.membership_growth_legacy_coverage(subject_user_id,cutoff DESC,created_at DESC,id COLLATE "C" DESC);
CREATE INDEX membership_growth_legacy_coverage_receipt
 ON zzsh_iam.membership_growth_legacy_coverage(subject_user_id,receipt_digest);
CREATE FUNCTION zzsh_iam.guard_legacy_growth_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc jsonb;
BEGIN
 IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'legacy growth coverage is immutable' USING ERRCODE='23514'; END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
 THEN RAISE EXCEPTION 'legacy growth coverage maintenance owner required' USING ERRCODE='23514'; END IF;
 doc:=NEW.record;
 IF doc->>'schema' IS DISTINCT FROM 'legacy-growth-coverage-record-v2'
  OR doc->>'subjectUserId' IS DISTINCT FROM NEW.subject_user_id
  OR doc->>'fingerprint' IS DISTINCT FROM NEW.fingerprint
  OR doc->>'executionKey' IS DISTINCT FROM NEW.execution_key
  OR doc->>'receiptDigest' IS DISTINCT FROM NEW.receipt_digest
  OR (doc->>'cutoff')::timestamptz IS DISTINCT FROM NEW.cutoff
  OR (doc->>'fromExclusive')::timestamptz IS DISTINCT FROM NEW.from_exclusive
  OR doc->>'coverageState' IS DISTINCT FROM NEW.coverage_state
  OR jsonb_typeof(doc->'factKeys') IS DISTINCT FROM 'array'
  OR jsonb_typeof(doc->'expectedSourceKeys') IS DISTINCT FROM 'array'
  OR jsonb_typeof(doc->'correctionProofDigests') IS DISTINCT FROM 'array'
  OR encode(sha256(convert_to(doc->>'receiptCanonical','UTF8')),'hex') IS DISTINCT FROM NEW.receipt_digest
 THEN RAISE EXCEPTION 'legacy growth coverage binding invalid' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER legacy_growth_coverage_guard BEFORE INSERT OR UPDATE OR DELETE
 ON zzsh_iam.membership_growth_legacy_coverage FOR EACH ROW EXECUTE FUNCTION zzsh_iam.guard_legacy_growth_coverage();
CREATE TRIGGER legacy_growth_coverage_no_truncate BEFORE TRUNCATE
 ON zzsh_iam.membership_growth_legacy_coverage FOR EACH STATEMENT EXECUTE FUNCTION zzsh_iam.guard_legacy_growth_coverage();
REVOKE ALL ON FUNCTION zzsh_iam.guard_legacy_growth_coverage() FROM PUBLIC;

-- Remove inherited table AND column defaults before migration COMMIT, not only in the later ACL transaction.
DO $growth_initial_acl$
DECLARE relation_oid oid; owner_oid oid; column_list text; grant_row record; grantee_sql text;
BEGIN
 SELECT oid,relowner INTO STRICT relation_oid,owner_oid FROM pg_class
  WHERE oid='zzsh_iam.membership_growth_legacy_coverage'::regclass;
 SELECT string_agg(format('%I',attname),',' ORDER BY attnum) INTO STRICT column_list
  FROM pg_attribute WHERE attrelid=relation_oid AND attnum>0 AND NOT attisdropped;
 FOR grant_row IN
  SELECT DISTINCT grantee FROM (
   SELECT 0::oid AS grantee
   UNION ALL SELECT a.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid=relation_oid
   UNION ALL SELECT a.grantee FROM pg_attribute c CROSS JOIN LATERAL aclexplode(c.attacl) a
    WHERE c.attrelid=relation_oid AND c.attnum>0 AND NOT c.attisdropped
  ) grants WHERE grantee<>owner_oid
 LOOP
  IF grant_row.grantee=0 THEN grantee_sql:='PUBLIC';
  ELSE SELECT format('%I',rolname) INTO STRICT grantee_sql FROM pg_roles WHERE oid=grant_row.grantee; END IF;
  EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE zzsh_iam.membership_growth_legacy_coverage FROM %s',grantee_sql);
  EXECUTE format('REVOKE ALL PRIVILEGES (%s) ON TABLE zzsh_iam.membership_growth_legacy_coverage FROM %s',column_list,grantee_sql);
 END LOOP;
END $growth_initial_acl$;
