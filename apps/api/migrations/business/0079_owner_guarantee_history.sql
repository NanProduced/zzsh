-- Q integration source candidate 0079_owner_guarantee_history. No DDL/ACL/financial execution authorized.
-- Derived from tmp/business-continuity-milestone-20261016/f-finance/implementation/owner-guarantee-history.sql
-- Source SHA256 0aac8ce9a9995a154f63eec84b4100b68e4f94d07f211ad7b0333d290e4587ee; old0000-0073/proposals/UNKNOWN/claim/NO_MERGE remain unchanged.
CREATE TABLE zzsh_order.legacy_owner_guarantee_observation (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),legacy_user_id text NOT NULL CHECK(legacy_user_id~'^[1-9][0-9]{0,23}$'),
 account_id text REFERENCES zzsh_supply.rental_account(id),legacy_account_id text NOT NULL CHECK(legacy_account_id~'^[1-9][0-9]{0,23}$'),
 source_cutoff timestamptz NOT NULL,input_sha256 text NOT NULL CHECK(input_sha256~'^[a-f0-9]{64}$'),identity_digest text NOT NULL CHECK(identity_digest~'^[a-f0-9]{64}$'),
 source_canonical text NOT NULL,source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),
 imported_at timestamptz NOT NULL DEFAULT clock_timestamp(),created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),UNIQUE(user_id,legacy_account_id,source_cutoff)
);
CREATE INDEX legacy_guarantee_history_user_page ON zzsh_order.legacy_owner_guarantee_observation(user_id,source_cutoff,imported_at DESC,id COLLATE "C" DESC);
CREATE TABLE zzsh_order.legacy_owner_guarantee_coverage (
 id text PRIMARY KEY,user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),legacy_user_id text NOT NULL,source_cutoff timestamptz NOT NULL,
 input_sha256 text NOT NULL CHECK(input_sha256~'^[a-f0-9]{64}$'),identity_digest text NOT NULL CHECK(identity_digest~'^[a-f0-9]{64}$'),
 source_count integer NOT NULL CHECK(source_count BETWEEN 0 AND 50000),imported_count integer NOT NULL CHECK(imported_count>=0),isolated_count integer NOT NULL CHECK(isolated_count>=0),
 source_set_digest text NOT NULL CHECK(source_set_digest~'^[a-f0-9]{64}$'),imported_set_digest text NOT NULL CHECK(imported_set_digest~'^[a-f0-9]{64}$'),isolated_set_digest text NOT NULL CHECK(isolated_set_digest~'^[a-f0-9]{64}$'),
 body_digest text NOT NULL CHECK(body_digest~'^[a-f0-9]{64}$'),input_canonical text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 CHECK(source_count=imported_count+isolated_count),UNIQUE(user_id,source_cutoff)
);
CREATE INDEX legacy_guarantee_coverage_latest ON zzsh_order.legacy_owner_guarantee_coverage(user_id,source_cutoff DESC,id COLLATE "C" DESC);
CREATE TRIGGER legacy_guarantee_observation_immutable BEFORE UPDATE OR DELETE ON zzsh_order.legacy_owner_guarantee_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER legacy_guarantee_coverage_immutable BEFORE UPDATE OR DELETE ON zzsh_order.legacy_owner_guarantee_coverage FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();

CREATE FUNCTION zzsh_order.guard_legacy_guarantee_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc jsonb;s jsonb;p jsonb;n bigint;
BEGIN
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'guarantee source maintenance owner required' USING ERRCODE='23514'; END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.user_id FOR UPDATE;
 IF NOT FOUND OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=NEW.user_id AND action='user.legacy_owner.migrated' AND outcome='SUCCESS'
  AND details->>'sourceSystem'='legacy_mysql_restore' AND details->>'sourceEntity'='la_user' AND details->>'legacyId'=NEW.legacy_user_id AND details->>'sourceDigest'=NEW.identity_digest)
 THEN RAISE EXCEPTION 'original guarantee owner identity mismatch' USING ERRCODE='23514'; END IF;
 doc:=NEW.source_canonical::jsonb;s:=doc->'source';
 IF doc->>'userId' IS DISTINCT FROM NEW.user_id OR doc->>'legacyUserId' IS DISTINCT FROM NEW.legacy_user_id OR doc->>'accountId' IS DISTINCT FROM NEW.account_id
  OR s->>'id' IS DISTINCT FROM NEW.legacy_account_id OR s->>'user_id' IS DISTINCT FROM NEW.legacy_user_id
  OR NEW.source_canonical IS DISTINCT FROM zzsh_order.canonical_finance_json(doc)
  OR NEW.source_digest IS DISTINCT FROM encode(sha256(convert_to(NEW.source_canonical,'UTF8')),'hex') OR NEW.source_cutoff>clock_timestamp()
  OR jsonb_typeof(doc->'payOrders') IS DISTINCT FROM 'array' OR jsonb_array_length(doc->'payOrders')>1000
  OR NOT COALESCE(s->>'pay_money'~'^(0|[1-9][0-9]{0,21})\.[0-9]{2}$',false) OR NOT COALESCE(s->>'pay_is' IN('0','1'),false)
  OR s->>'return_is' IS NOT NULL AND s->>'return_is'<>'1'
  OR NEW.account_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM zzsh_supply.legacy_supply_map WHERE source_system='legacy_mysql_restore' AND source_entity='la_rental_accounts' AND legacy_id=NEW.legacy_account_id AND account_id=NEW.account_id)
 THEN RAISE EXCEPTION 'guarantee source account/canonical binding invalid' USING ERRCODE='23514'; END IF;
 SELECT count(DISTINCT v->>'id') INTO n FROM jsonb_array_elements(doc->'payOrders') v;
 IF n<>jsonb_array_length(doc->'payOrders') THEN RAISE EXCEPTION 'duplicate guarantee pay attempt' USING ERRCODE='23514'; END IF;
 FOR p IN SELECT value FROM jsonb_array_elements(doc->'payOrders') LOOP
  IF p->>'order_type' IS DISTINCT FROM '2' OR p->>'order_id' IS DISTINCT FROM NEW.legacy_account_id OR NOT COALESCE(p->>'id'~'^[1-9][0-9]{0,23}$',false)
   OR NOT COALESCE(p->>'pay_is' IN('0','1'),false) OR NOT COALESCE(p->>'pay_money'~'^(0|[1-9][0-9]{0,21})\.[0-9]{2}$',false)
  THEN RAISE EXCEPTION 'typed guarantee attempt source invalid' USING ERRCODE='23514'; END IF;
 END LOOP;
 NEW.imported_at:=clock_timestamp();NEW.created_xid:=pg_current_xact_id();RETURN NEW;
END $$;
CREATE TRIGGER legacy_guarantee_observation_guard BEFORE INSERT ON zzsh_order.legacy_owner_guarantee_observation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_guarantee_observation();

CREATE FUNCTION zzsh_order.guard_legacy_guarantee_coverage() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc jsonb;actual_count bigint;actual_digest text;input_digest text;isolated_digest text;all_digest text;unique_sources bigint;
BEGIN
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID) THEN RAISE EXCEPTION 'guarantee source maintenance owner required' USING ERRCODE='23514'; END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.user_id FOR UPDATE;
 doc:=NEW.input_canonical::jsonb;
 IF NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=NEW.user_id AND action='user.legacy_owner.migrated' AND outcome='SUCCESS'
  AND details->>'sourceSystem'='legacy_mysql_restore' AND details->>'sourceEntity'='la_user' AND details->>'legacyId'=NEW.legacy_user_id AND details->>'sourceDigest'=NEW.identity_digest)
  OR doc->>'userId' IS DISTINCT FROM NEW.user_id OR doc->>'legacyUserId' IS DISTINCT FROM NEW.legacy_user_id OR doc->>'identityDigest' IS DISTINCT FROM NEW.identity_digest
  OR doc->>'inputSha256' IS DISTINCT FROM NEW.input_sha256 OR (doc->>'cutoff')::timestamptz IS DISTINCT FROM NEW.source_cutoff
  OR (doc->>'sourceCount')::int IS DISTINCT FROM NEW.source_count OR NEW.source_cutoff>clock_timestamp()
  OR NEW.input_canonical IS DISTINCT FROM zzsh_order.canonical_finance_json(doc) OR NEW.body_digest IS DISTINCT FROM encode(sha256(convert_to(NEW.input_canonical,'UTF8')),'hex')
  OR jsonb_typeof(doc->'rows') IS DISTINCT FROM 'array' OR jsonb_typeof(doc->'isolated') IS DISTINCT FROM 'array'
  OR jsonb_array_length(doc->'rows') IS DISTINCT FROM NEW.imported_count OR jsonb_array_length(doc->'isolated') IS DISTINCT FROM NEW.isolated_count
 THEN RAISE EXCEPTION 'guarantee coverage canonical source binding invalid' USING ERRCODE='23514'; END IF;
 SELECT count(*),encode(sha256(convert_to(COALESCE(string_agg(legacy_account_id||':'||source_digest,chr(10) ORDER BY legacy_account_id COLLATE "C"),''),'UTF8')),'hex')
 INTO actual_count,actual_digest FROM zzsh_order.legacy_owner_guarantee_observation WHERE user_id=NEW.user_id AND source_cutoff=NEW.source_cutoff;
 SELECT encode(sha256(convert_to(COALESCE(string_agg((v#>>'{source,id}')||':'||encode(sha256(convert_to(zzsh_order.canonical_finance_json(v),'UTF8')),'hex'),chr(10) ORDER BY (v#>>'{source,id}') COLLATE "C"),''),'UTF8')),'hex') INTO input_digest FROM jsonb_array_elements(doc->'rows') v;
 SELECT encode(sha256(convert_to(COALESCE(string_agg((v->>'sourceId')||':'||(v->>'sourceDigest'),chr(10) ORDER BY (v->>'sourceId') COLLATE "C"),''),'UTF8')),'hex') INTO isolated_digest FROM jsonb_array_elements(doc->'isolated') v;
 WITH members AS(SELECT v#>>'{source,id}' AS id,encode(sha256(convert_to(zzsh_order.canonical_finance_json(v),'UTF8')),'hex') AS digest FROM jsonb_array_elements(doc->'rows') v
  UNION ALL SELECT v->>'sourceId',v->>'sourceDigest' FROM jsonb_array_elements(doc->'isolated') v)
 SELECT count(DISTINCT id),encode(sha256(convert_to(COALESCE(string_agg(id||':'||digest,chr(10) ORDER BY id COLLATE "C"),''),'UTF8')),'hex') INTO unique_sources,all_digest FROM members;
 IF actual_count<>NEW.imported_count OR actual_digest IS DISTINCT FROM NEW.imported_set_digest OR input_digest IS DISTINCT FROM NEW.imported_set_digest
  OR isolated_digest IS DISTINCT FROM NEW.isolated_set_digest OR all_digest IS DISTINCT FROM NEW.source_set_digest OR unique_sources<>NEW.source_count
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'isolated') v WHERE NOT COALESCE((v->>'sourceId')~'^[1-9][0-9]{0,23}$',false)
   OR NOT COALESCE((v->>'sourceDigest')~'^[a-f0-9]{64}$',false) OR NOT COALESCE(length(v->>'reason') BETWEEN 1 AND 128,false))
 THEN RAISE EXCEPTION 'guarantee coverage source/target sets do not close' USING ERRCODE='23514'; END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER legacy_guarantee_coverage_guard BEFORE INSERT ON zzsh_order.legacy_owner_guarantee_coverage FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_guarantee_coverage();
REVOKE ALL ON zzsh_order.legacy_owner_guarantee_observation,zzsh_order.legacy_owner_guarantee_coverage FROM PUBLIC;
-- Q assigns exact runtime SELECT and separately reviewed maintenance owner; no runtime INSERT/UPDATE/DELETE.
-- There are deliberately no ledger, requirement or refund INSERTs in this migration.

-- New helper/trigger functions do not retain implicit PUBLIC EXECUTE.
REVOKE ALL ON FUNCTION zzsh_order.guard_legacy_guarantee_observation() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_legacy_guarantee_coverage() FROM PUBLIC;

-- Old default ACLs must not expose these new tables between migration COMMIT and the bound runtime ACL transaction.
DO $continuity_initial_acl$
DECLARE
 relation_name text; relation_oid oid; owner_oid oid; table_sql text; column_list text;
 grant_row record; grantee_sql text;
BEGIN
 FOREACH relation_name IN ARRAY ARRAY[
  'zzsh_order.legacy_continuation_evidence',
  'zzsh_order.legacy_continuation_version',
  'zzsh_order.legacy_order_duty',
  'zzsh_order.legacy_order_duty_revision',
  'zzsh_order.legacy_order_duty_admission',
  'zzsh_order.legacy_inflight_register',
  'zzsh_order.personal_finance_observation_coverage',
  'zzsh_order.finance_stored_opening_review',
  'zzsh_order.legacy_duty_finance_contract',
  'zzsh_order.legacy_duty_finance_fact',
  'zzsh_order.legacy_owner_guarantee_observation',
  'zzsh_order.legacy_owner_guarantee_coverage'
 ]::text[] LOOP
  SELECT c.oid, c.relowner, format('%I.%I',n.nspname,c.relname)
   INTO STRICT relation_oid, owner_oid, table_sql
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
   WHERE c.oid=to_regclass(relation_name) AND c.relkind='r';
  SELECT string_agg(format('%I',a.attname),',' ORDER BY a.attnum) INTO column_list
   FROM pg_attribute a WHERE a.attrelid=relation_oid AND a.attnum>0 AND NOT a.attisdropped;
  IF column_list IS NULL THEN RAISE EXCEPTION 'continuity ACL column inventory unavailable: %',relation_name; END IF;
  FOR grant_row IN
   SELECT DISTINCT grantee FROM (
    SELECT 0::oid AS grantee
    UNION ALL SELECT acl.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) acl WHERE c.oid=relation_oid
    UNION ALL SELECT acl.grantee FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl
     WHERE a.attrelid=relation_oid AND a.attnum>0 AND NOT a.attisdropped
   ) grants WHERE grantee <> owner_oid
  LOOP
   IF grant_row.grantee=0 THEN grantee_sql := 'PUBLIC';
   ELSE
    SELECT format('%I',r.rolname) INTO STRICT grantee_sql FROM pg_roles r WHERE r.oid=grant_row.grantee;
   END IF;
   EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM %s',table_sql,grantee_sql);
   EXECUTE format('REVOKE ALL PRIVILEGES (%s) ON TABLE %s FROM %s',column_list,table_sql,grantee_sql);
  END LOOP;
 END LOOP;
END
$continuity_initial_acl$;
