-- Q integration source candidate 0075_finance_history_coverage. No DDL/ACL/financial execution authorized.
-- Derived from tmp/business-continuity-milestone-20261016/f-finance/implementation/finance-history-coverage.sql
-- Source SHA256 e782e12690fd09c5c5ea68670d6f3c1f88a1a9d26d08d3e7190d182b0d77713e; old0000-0073/proposals/UNKNOWN/claim/NO_MERGE remain unchanged.
CREATE TABLE zzsh_order.personal_finance_observation_coverage (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 source_system text NOT NULL CHECK(source_system='legacy_mysql_restore'),legacy_user_id text NOT NULL CHECK(legacy_user_id~'^[1-9][0-9]{0,23}$'),
 source_kind text NOT NULL CHECK(source_kind IN('HISTORICAL_EARNINGS_LOG','HISTORICAL_DISTRIBUTION','HISTORICAL_WITHDRAWAL')),
 source_entity text NOT NULL,source_cutoff timestamptz NOT NULL,
 input_sha256 text NOT NULL CHECK(input_sha256~'^[0-9a-f]{64}$'),identity_digest text NOT NULL CHECK(identity_digest~'^[0-9a-f]{64}$'),
 source_count integer NOT NULL CHECK(source_count BETWEEN 0 AND 500000),imported_count integer NOT NULL CHECK(imported_count>=0),isolated_count integer NOT NULL CHECK(isolated_count>=0),
 source_set_digest text NOT NULL CHECK(source_set_digest~'^[0-9a-f]{64}$'),imported_set_digest text NOT NULL CHECK(imported_set_digest~'^[0-9a-f]{64}$'),isolated_set_digest text NOT NULL CHECK(isolated_set_digest~'^[0-9a-f]{64}$'),
 body_digest text NOT NULL CHECK(body_digest~'^[0-9a-f]{64}$'),source_canonical text NOT NULL,
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(user_id,source_kind,source_system,source_cutoff),
 CHECK(source_count=imported_count+isolated_count),
 CHECK((source_kind='HISTORICAL_EARNINGS_LOG' AND source_entity='la_log_earnings')
  OR(source_kind='HISTORICAL_DISTRIBUTION' AND source_entity='la_distribution_order')
  OR(source_kind='HISTORICAL_WITHDRAWAL' AND source_entity='la_withdraw_apply'))
);
CREATE INDEX finance_observation_coverage_latest ON zzsh_order.personal_finance_observation_coverage(user_id,source_kind,source_cutoff DESC,id DESC);
CREATE TRIGGER history_coverage_immutable BEFORE UPDATE OR DELETE ON zzsh_order.personal_finance_observation_coverage
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();

CREATE FUNCTION zzsh_order.guard_finance_history_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_name text;p jsonb;source_rows integer;unique_rows integer;imported_digest text;isolated_digest text;source_digest text;actual_count integer;actual_digest text;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 IF current_user<>owner_name THEN RAISE EXCEPTION 'history coverage requires maintenance owner' USING ERRCODE='42501';END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.user_id FOR UPDATE;
 p:=NEW.source_canonical::jsonb;
 IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(p->'imported') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'isolated') IS DISTINCT FROM 'array'
  OR NEW.body_digest IS DISTINCT FROM encode(sha256(convert_to(NEW.source_canonical,'UTF8')),'hex')
  OR p->>'userId' IS DISTINCT FROM NEW.user_id OR p->>'legacyUserId' IS DISTINCT FROM NEW.legacy_user_id
  OR p->>'sourceSystem' IS DISTINCT FROM NEW.source_system OR p->>'sourceKind' IS DISTINCT FROM NEW.source_kind
  OR p->>'inputSha256' IS DISTINCT FROM NEW.input_sha256 OR p->>'identityDigest' IS DISTINCT FROM NEW.identity_digest
  OR (p->>'cutoff')::timestamptz IS DISTINCT FROM NEW.source_cutoff OR NEW.source_cutoff>clock_timestamp()
  OR p->>'sourceCount' IS DISTINCT FROM NEW.source_count::text
  OR jsonb_array_length(p->'imported')<>NEW.imported_count OR jsonb_array_length(p->'isolated')<>NEW.isolated_count THEN
  RAISE EXCEPTION 'history coverage body/source/count mismatch' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE action='user.legacy_owner.migrated' AND outcome='SUCCESS' AND object_id=NEW.user_id
  AND details->>'sourceSystem'=NEW.source_system AND details->>'sourceEntity'='la_user' AND details->>'legacyId'=NEW.legacy_user_id AND details->>'sourceDigest'=NEW.identity_digest) THEN
  RAISE EXCEPTION 'history coverage identity mapping mismatch' USING ERRCODE='23514';END IF;
 SELECT count(*),count(DISTINCT x->>'sourceId'),encode(sha256(convert_to(COALESCE(string_agg((x->>'sourceId')||':'||(x->>'sourceDigest'),chr(10) ORDER BY (x->>'sourceId') COLLATE "C"),''),'UTF8')),'hex')
  INTO source_rows,unique_rows,source_digest FROM jsonb_array_elements((p->'imported')||(p->'isolated')) x;
 IF source_rows<>NEW.source_count OR unique_rows<>source_rows OR source_digest<>NEW.source_set_digest
  OR EXISTS(SELECT 1 FROM jsonb_array_elements((p->'imported')||(p->'isolated')) x WHERE
   jsonb_typeof(x) IS DISTINCT FROM 'object' OR jsonb_typeof(x->'sourceId') IS DISTINCT FROM 'string' OR (x->>'sourceId') !~ '^[1-9][0-9]{0,23}$'
   OR jsonb_typeof(x->'sourceDigest') IS DISTINCT FROM 'string' OR (x->>'sourceDigest') !~ '^[0-9a-f]{64}$')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(p->'isolated') x WHERE jsonb_typeof(x->'reason') IS DISTINCT FROM 'string' OR length(x->>'reason') NOT BETWEEN 1 AND 128) THEN
  RAISE EXCEPTION 'history coverage duplicate/missing/malformed member' USING ERRCODE='23514';END IF;
 SELECT encode(sha256(convert_to(COALESCE(string_agg((x->>'sourceId')||':'||(x->>'sourceDigest'),chr(10) ORDER BY (x->>'sourceId') COLLATE "C"),''),'UTF8')),'hex') INTO imported_digest FROM jsonb_array_elements(p->'imported') x;
 SELECT encode(sha256(convert_to(COALESCE(string_agg((x->>'sourceId')||':'||(x->>'sourceDigest'),chr(10) ORDER BY (x->>'sourceId') COLLATE "C"),''),'UTF8')),'hex') INTO isolated_digest FROM jsonb_array_elements(p->'isolated') x;
 SELECT count(*),encode(sha256(convert_to(COALESCE(string_agg(o.source_id||':'||o.source_digest,chr(10) ORDER BY o.source_id COLLATE "C"),''),'UTF8')),'hex')
  INTO actual_count,actual_digest FROM zzsh_order.personal_finance_observation o
  WHERE o.user_id=NEW.user_id AND o.source_system=NEW.source_system AND o.source_type='LEGACY_MYSQL' AND o.source_kind=NEW.source_kind
   AND o.source_entity=NEW.source_entity AND o.legacy_user_id=NEW.legacy_user_id AND o.source_event_at<=NEW.source_cutoff;
 IF imported_digest<>NEW.imported_set_digest OR isolated_digest<>NEW.isolated_set_digest OR actual_count<>NEW.imported_count OR actual_digest<>NEW.imported_set_digest THEN
  RAISE EXCEPTION 'history coverage target set does not close' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER history_coverage_guard BEFORE INSERT ON zzsh_order.personal_finance_observation_coverage
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_finance_history_coverage();

CREATE FUNCTION zzsh_order.lock_finance_history_subject() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.user_id FOR UPDATE;RETURN NEW;END $$;
CREATE TRIGGER a_history_subject_lock BEFORE INSERT ON zzsh_order.personal_finance_observation
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.lock_finance_history_subject();

CREATE FUNCTION zzsh_order.finance_history_coverage_read_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision) VALUES(NEW.user_id,0,1)
 ON CONFLICT(user_id) DO UPDATE SET read_revision=zzsh_order.wallet_revision.read_revision+1;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.finance_history_coverage_read_revision() FROM PUBLIC;
CREATE TRIGGER history_coverage_read_revision AFTER INSERT ON zzsh_order.personal_finance_observation_coverage
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_history_coverage_read_revision();
REVOKE ALL ON zzsh_order.personal_finance_observation_coverage FROM PUBLIC;
-- Q runtime ACL: SELECT only on the coverage table; no runtime INSERT/UPDATE/DELETE.
-- Exact owner/role/resource/window binds the internal writer. No live GRANT or migration ran here.

-- New helper/trigger functions do not retain implicit PUBLIC EXECUTE.
REVOKE ALL ON FUNCTION zzsh_order.guard_finance_history_coverage() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.lock_finance_history_subject() FROM PUBLIC;
