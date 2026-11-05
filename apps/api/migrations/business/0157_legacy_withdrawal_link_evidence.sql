-- A read-only relationship certificate. It never posts, admits or changes wallet money.
-- The source rows remain the authority; new legacy observations invalidate certificates
-- for the whole subject until they are independently proved again.
CREATE TABLE zzsh_order.legacy_withdrawal_subject_revision (
 source_system text NOT NULL,
 user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 revision bigint NOT NULL CHECK(revision>0),
 PRIMARY KEY(source_system,user_id)
);

CREATE TABLE zzsh_order.legacy_withdrawal_link_evidence (
 parent_id text NOT NULL REFERENCES zzsh_order.personal_finance_observation(id),
 debit_id text NOT NULL REFERENCES zzsh_order.personal_finance_observation(id),
 return_id text REFERENCES zzsh_order.personal_finance_observation(id),
 source_system text NOT NULL,
 user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 revision bigint NOT NULL CHECK(revision>0),
 parent_digest text NOT NULL CHECK(parent_digest~'^[0-9a-f]{64}$'),
 debit_digest text NOT NULL CHECK(debit_digest~'^[0-9a-f]{64}$'),
 return_digest text CHECK(return_digest~'^[0-9a-f]{64}$'),
 parent_fingerprint text NOT NULL CHECK(parent_fingerprint~'^[0-9a-f]{64}$'),
 debit_fingerprint text NOT NULL CHECK(debit_fingerprint~'^[0-9a-f]{64}$'),
 return_fingerprint text CHECK(return_fingerprint~'^[0-9a-f]{64}$'),
 CHECK(parent_id<>debit_id AND (return_id IS NULL OR return_id<>debit_id AND return_id<>parent_id)),
 CHECK((return_id IS NULL)=(return_digest IS NULL) AND (return_id IS NULL)=(return_fingerprint IS NULL)),
 PRIMARY KEY(parent_id,revision),
 UNIQUE(debit_id,revision),
 UNIQUE(return_id,revision)
);

CREATE INDEX legacy_withdrawal_candidate_reference_idx
 ON zzsh_order.personal_finance_observation(source_system,user_id,(snapshot->>'referenceId'))
 WHERE source_type='LEGACY_MYSQL' AND source_kind='HISTORICAL_EARNINGS_LOG' AND source_entity='la_log_earnings';

-- This digest binds the actual row, not only a caller-supplied digest. Timestamp text
-- is reduced to epoch seconds, so it does not depend on the session time zone.
CREATE FUNCTION zzsh_order.legacy_withdrawal_row_fingerprint(o zzsh_order.personal_finance_observation)
 RETURNS text LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT encode(sha256(convert_to(jsonb_build_array(o.id,o.user_id,o.legacy_user_id,o.source_type,o.source_system,
  o.source_kind,o.source_entity,o.source_id,o.source_digest,o.source_canonical,
  extract(epoch FROM o.source_event_at)::text,o.snapshot)::text,'UTF8')),'hex')
$$;

-- This deliberately fails closed on unsupported/noncanonical JSON, including malformed
-- embedded source bytes. It is used only while writing a certificate, never per page.
CREATE FUNCTION zzsh_order.legacy_withdrawal_verified_source(o zzsh_order.personal_finance_observation)
 RETURNS jsonb LANGUAGE plpgsql STABLE AS $$
DECLARE s jsonb:=o.snapshot; p jsonb; raw jsonb; supplement jsonb; ts text;
BEGIN
 IF (o.source_type='LEGACY_MYSQL' AND o.source_system='legacy_mysql_restore'
   AND o.source_entity IN('la_log_earnings','la_withdraw_apply')
   AND encode(sha256(convert_to(o.source_canonical,'UTF8')),'hex')=o.source_digest
   AND zzsh_order.canonical_finance_json(s)=o.source_canonical
   AND s->>'sourceId'=o.source_id AND s->>'sourceUserId'=o.legacy_user_id) IS NOT TRUE THEN RETURN NULL; END IF;
 p:=s->'rawSource';
 IF (jsonb_typeof(p)='object' AND p->>'entity'=o.source_entity AND jsonb_typeof(p->'canonical')='string'
   AND encode(sha256(convert_to(p->>'canonical','UTF8')),'hex')=p->>'digest') IS NOT TRUE THEN RETURN NULL; END IF;
 raw:=(p->>'canonical')::jsonb;
 IF (jsonb_typeof(raw)='object' AND zzsh_order.canonical_finance_json(raw)=p->>'canonical'
   AND raw->>'id'=o.source_id AND raw->>'userId'=o.legacy_user_id) IS NOT TRUE THEN RETURN NULL; END IF;
 IF o.source_entity='la_log_earnings' THEN
  IF (o.source_kind='HISTORICAL_EARNINGS_LOG' AND s->>'kind'='earningsLog'
    AND raw ?& ARRAY['id','sn','action','amount','userId','sourceId','createdAt','changeType','leftAmount']
    AND (SELECT count(*) FROM jsonb_object_keys(raw))=9
    AND jsonb_typeof(s->'referenceId')='string' AND s->>'referenceId'=raw->>'sourceId'
    AND s->'amount'=raw->'amount' AND s->'leftAmount'=raw->'leftAmount'
    AND s->>'action'=raw->>'action' AND s->>'legacyChangeType'=raw->>'changeType'
    AND s->'legacyLogNumber'=raw->'sn' AND s->>'createdAt'=raw->>'createdAt') IS NOT TRUE THEN RETURN NULL; END IF;
  p:=s->'sourceSupplement';
  IF (jsonb_typeof(p)='object' AND p->>'entity'=o.source_entity AND jsonb_typeof(p->'canonical')='string'
    AND encode(sha256(convert_to(p->>'canonical','UTF8')),'hex')=p->>'digest') IS NOT TRUE THEN RETURN NULL; END IF;
  supplement:=(p->>'canonical')::jsonb;
  IF (jsonb_typeof(supplement)='object' AND zzsh_order.canonical_finance_json(supplement)=p->>'canonical'
    AND NOT EXISTS(SELECT 1 FROM jsonb_each(raw) x WHERE supplement->x.key IS DISTINCT FROM x.value)
    AND jsonb_typeof(supplement->'sourceSn')='string' AND s->'referenceSn'=supplement->'sourceSn') IS NOT TRUE THEN RETURN NULL; END IF;
  ts:=raw->>'createdAt';
 ELSE
  IF (o.source_kind='HISTORICAL_WITHDRAWAL' AND s->>'kind'='withdrawObservation'
    AND s->'amount'=raw->'money' AND s->'fee'=raw->'handling_fee' AND s->'net'=raw->'left_money'
    AND s->>'sourceStatus'=raw->>'status' AND s->>'referenceId'=raw->>'id'
    AND s->'referenceSn'=raw->'sn' AND s->>'createdAt'=raw->>'create_time') IS NOT TRUE THEN RETURN NULL; END IF;
  ts:=raw->>'create_time';
 END IF;
 IF (jsonb_typeof(s->'amount')='string' AND (s->>'amount')~'^(0|[1-9][0-9]{0,21})\.[0-9]{2}$'
   AND ts~'^[1-9][0-9]{0,9}$' AND ts::numeric<=4294967295
   AND o.source_event_at=to_timestamp(ts::double precision)) IS NOT TRUE THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('original',raw,'supplement',supplement);
EXCEPTION WHEN OTHERS THEN
 RETURN NULL;
END $$;

CREATE FUNCTION zzsh_order.bump_legacy_withdrawal_subject_revision() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 INSERT INTO zzsh_order.legacy_withdrawal_subject_revision(source_system,user_id,revision)
 SELECT source_system,user_id,1 FROM inserted_legacy_observations WHERE source_type='LEGACY_MYSQL'
 GROUP BY source_system,user_id ORDER BY source_system COLLATE "C",user_id COLLATE "C"
 ON CONFLICT(source_system,user_id) DO UPDATE
 SET revision=zzsh_order.legacy_withdrawal_subject_revision.revision+1;
 RETURN NULL;
END $$;
CREATE TRIGGER legacy_withdrawal_subject_revision_insert
 AFTER INSERT ON zzsh_order.personal_finance_observation
 REFERENCING NEW TABLE AS inserted_legacy_observations FOR EACH STATEMENT
 EXECUTE FUNCTION zzsh_order.bump_legacy_withdrawal_subject_revision();

-- The migration transaction holds the table lock acquired by CREATE TRIGGER through
-- backfill, so concurrent source inserts cannot fall between registration and seeding.
INSERT INTO zzsh_order.legacy_withdrawal_subject_revision(source_system,user_id,revision)
 SELECT source_system,user_id,1 FROM zzsh_order.personal_finance_observation WHERE source_type='LEGACY_MYSQL'
 GROUP BY source_system,user_id ON CONFLICT(source_system,user_id) DO NOTHING;

CREATE FUNCTION zzsh_order.guard_legacy_withdrawal_link_evidence() RETURNS trigger
 LANGUAGE plpgsql AS $$
DECLARE parent zzsh_order.personal_finance_observation; debit zzsh_order.personal_finance_observation;
 returned zzsh_order.personal_finance_observation; p jsonb; d jsonb; r jsonb;
 subject_revision bigint; debit_count bigint; return_count bigint; other_count bigint;
BEGIN
 SELECT * INTO parent FROM zzsh_order.personal_finance_observation WHERE id=NEW.parent_id;
 SELECT * INTO debit FROM zzsh_order.personal_finance_observation WHERE id=NEW.debit_id;
 IF parent.id IS NULL OR debit.id IS NULL THEN RAISE EXCEPTION 'withdrawal source missing' USING ERRCODE='23514'; END IF;
 SELECT revision INTO subject_revision FROM zzsh_order.legacy_withdrawal_subject_revision
  WHERE source_system=parent.source_system AND user_id=parent.user_id FOR SHARE;
 IF subject_revision IS NULL OR NEW.revision IS DISTINCT FROM subject_revision THEN
  RAISE EXCEPTION 'withdrawal subject revision changed' USING ERRCODE='23514'; END IF;
 p:=zzsh_order.legacy_withdrawal_verified_source(parent); d:=zzsh_order.legacy_withdrawal_verified_source(debit);
 IF p IS NULL OR d IS NULL THEN RAISE EXCEPTION 'withdrawal source proof unavailable' USING ERRCODE='23514'; END IF;
 IF (parent.source_entity='la_withdraw_apply' AND debit.source_entity='la_log_earnings'
   AND parent.source_system=debit.source_system AND parent.user_id=debit.user_id AND parent.legacy_user_id=debit.legacy_user_id
   AND parent.source_id=debit.snapshot->>'referenceId' AND p#>>'{original,sn}'=d#>>'{supplement,sourceSn}'
   AND p#>>'{original,sn}'~'^[ -~]{1,255}$' AND p#>>'{original,money}'=d#>>'{original,amount}'
   AND p#>>'{original,status}' IN('1','2','3','4','5') AND d#>>'{original,changeType}'='1002'
   AND d#>>'{original,action}'='2' AND parent.source_event_at<=debit.source_event_at) IS NOT TRUE THEN
  RAISE EXCEPTION 'withdrawal debit does not close' USING ERRCODE='23514'; END IF;
 SELECT count(*) FILTER(WHERE snapshot->>'legacyChangeType'='1002'),
        count(*) FILTER(WHERE snapshot->>'legacyChangeType' IN('1003','1004','1005')),
        count(*) FILTER(WHERE id NOT IN(NEW.debit_id,COALESCE(NEW.return_id,NEW.debit_id)))
 INTO debit_count,return_count,other_count FROM zzsh_order.personal_finance_observation
 WHERE source_type='LEGACY_MYSQL' AND source_kind='HISTORICAL_EARNINGS_LOG' AND source_entity='la_log_earnings'
  AND source_system=parent.source_system AND user_id=parent.user_id AND snapshot->>'referenceId'=parent.source_id
  AND snapshot->>'legacyChangeType' IN('1002','1003','1004','1005');
 IF debit_count<>1 OR return_count<>(CASE WHEN NEW.return_id IS NULL THEN 0 ELSE 1 END) OR other_count<>0 THEN
  RAISE EXCEPTION 'withdrawal candidates are missing or ambiguous' USING ERRCODE='23514'; END IF;
 IF NEW.return_id IS NOT NULL THEN
  SELECT * INTO returned FROM zzsh_order.personal_finance_observation WHERE id=NEW.return_id;
  r:=zzsh_order.legacy_withdrawal_verified_source(returned);
  IF (r IS NOT NULL AND returned.source_entity='la_log_earnings' AND returned.source_system=parent.source_system
    AND returned.user_id=parent.user_id AND returned.legacy_user_id=parent.legacy_user_id
    AND returned.snapshot->>'referenceId'=parent.source_id AND r#>>'{supplement,sourceSn}'=p#>>'{original,sn}'
    AND r#>>'{original,amount}'=p#>>'{original,money}' AND p#>>'{original,status}'='4'
    AND r#>>'{original,changeType}' IN('1003','1004','1005') AND r#>>'{original,action}'='1'
    AND returned.source_event_at>=debit.source_event_at AND returned.source_event_at>=parent.source_event_at) IS NOT TRUE THEN
   RAISE EXCEPTION 'withdrawal return does not close' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.source_system:=parent.source_system; NEW.user_id:=parent.user_id;
 NEW.parent_digest:=parent.source_digest; NEW.debit_digest:=debit.source_digest;
 NEW.parent_fingerprint:=zzsh_order.legacy_withdrawal_row_fingerprint(parent);
 NEW.debit_fingerprint:=zzsh_order.legacy_withdrawal_row_fingerprint(debit);
 IF NEW.return_id IS NOT NULL THEN
  NEW.return_digest:=returned.source_digest; NEW.return_fingerprint:=zzsh_order.legacy_withdrawal_row_fingerprint(returned);
 ELSE NEW.return_digest:=NULL; NEW.return_fingerprint:=NULL; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER legacy_withdrawal_link_evidence_guard BEFORE INSERT ON zzsh_order.legacy_withdrawal_link_evidence
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_withdrawal_link_evidence();
CREATE TRIGGER legacy_withdrawal_link_evidence_immutable BEFORE UPDATE OR DELETE ON zzsh_order.legacy_withdrawal_link_evidence
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();

-- Run only in the controlled import, in bounded transactions. An unprovable group
-- is deliberately left independent; unexpected SQL/ACL errors abort the batch.
CREATE FUNCTION zzsh_order.certify_legacy_withdrawal_link(parent_id_value text) RETURNS text
 LANGUAGE plpgsql AS $$
DECLARE parent zzsh_order.personal_finance_observation; subject_revision bigint;
 debit_id_value text; return_id_value text; debit_count bigint; return_count bigint; inserted boolean;
BEGIN
 SELECT * INTO parent FROM zzsh_order.personal_finance_observation WHERE id=parent_id_value
  AND source_type='LEGACY_MYSQL' AND source_entity='la_withdraw_apply';
 IF parent.id IS NULL THEN RETURN 'UNRESOLVED'; END IF;
 SELECT revision INTO subject_revision FROM zzsh_order.legacy_withdrawal_subject_revision
  WHERE source_system=parent.source_system AND user_id=parent.user_id FOR SHARE;
 IF subject_revision IS NULL THEN RETURN 'UNRESOLVED'; END IF;
 SELECT count(*) FILTER(WHERE snapshot->>'legacyChangeType'='1002'),
   min(id) FILTER(WHERE snapshot->>'legacyChangeType'='1002'),
   count(*) FILTER(WHERE snapshot->>'legacyChangeType' IN('1003','1004','1005')),
   min(id) FILTER(WHERE snapshot->>'legacyChangeType' IN('1003','1004','1005'))
 INTO debit_count,debit_id_value,return_count,return_id_value
 FROM zzsh_order.personal_finance_observation WHERE source_type='LEGACY_MYSQL'
  AND source_kind='HISTORICAL_EARNINGS_LOG' AND source_entity='la_log_earnings'
  AND source_system=parent.source_system AND user_id=parent.user_id AND snapshot->>'referenceId'=parent.source_id
  AND snapshot->>'legacyChangeType' IN('1002','1003','1004','1005');
 IF debit_count<>1 OR return_count>1 THEN RETURN 'UNRESOLVED'; END IF;
 BEGIN
  INSERT INTO zzsh_order.legacy_withdrawal_link_evidence(parent_id,debit_id,return_id,revision)
   VALUES(parent.id,debit_id_value,return_id_value,subject_revision)
   ON CONFLICT(parent_id,revision) DO NOTHING RETURNING TRUE INTO inserted;
 EXCEPTION WHEN check_violation THEN RETURN 'UNRESOLVED'; END;
 IF inserted IS TRUE THEN RETURN 'CREATED'; END IF;
 IF EXISTS(SELECT 1 FROM zzsh_order.legacy_withdrawal_link_evidence WHERE parent_id=parent.id
  AND revision=subject_revision AND debit_id=debit_id_value AND return_id IS NOT DISTINCT FROM return_id_value)
 THEN RETURN 'REPLAY'; END IF;
 RAISE EXCEPTION 'withdrawal certificate replay differs' USING ERRCODE='23514';
END $$;

REVOKE ALL ON TABLE zzsh_order.legacy_withdrawal_subject_revision,zzsh_order.legacy_withdrawal_link_evidence FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.legacy_withdrawal_row_fingerprint(zzsh_order.personal_finance_observation),
 zzsh_order.legacy_withdrawal_verified_source(zzsh_order.personal_finance_observation),
 zzsh_order.bump_legacy_withdrawal_subject_revision(),zzsh_order.guard_legacy_withdrawal_link_evidence(),
 zzsh_order.certify_legacy_withdrawal_link(text) FROM PUBLIC;

-- Default privileges can grant a specific runtime role before the separate ACL stage.
-- Remove table, column and routine grants from every nonowner at schema commit.
DO $withdrawal_link_initial_acl$
DECLARE name text; object_oid oid; owner_oid oid; object_sql text; column_list text; grant_row record; grantee_sql text;
BEGIN
 FOREACH name IN ARRAY ARRAY['zzsh_order.legacy_withdrawal_subject_revision','zzsh_order.legacy_withdrawal_link_evidence']::text[] LOOP
  SELECT c.oid,c.relowner,format('%I.%I',n.nspname,c.relname) INTO STRICT object_oid,owner_oid,object_sql
   FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.oid=to_regclass(name) AND c.relkind='r';
  SELECT string_agg(format('%I',a.attname),',' ORDER BY a.attnum) INTO STRICT column_list
   FROM pg_attribute a WHERE a.attrelid=object_oid AND a.attnum>0 AND NOT a.attisdropped;
  IF column_list IS NULL THEN RAISE EXCEPTION 'withdrawal link ACL column inventory unavailable'; END IF;
  FOR grant_row IN SELECT DISTINCT grantee FROM (
   SELECT 0::oid AS grantee UNION ALL SELECT acl.grantee FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) acl WHERE c.oid=object_oid
   UNION ALL SELECT acl.grantee FROM pg_attribute a CROSS JOIN LATERAL aclexplode(a.attacl) acl
    WHERE a.attrelid=object_oid AND a.attnum>0 AND NOT a.attisdropped
  ) grants WHERE grantee<>owner_oid LOOP
   IF grant_row.grantee=0 THEN grantee_sql:='PUBLIC';
   ELSE SELECT format('%I',rolname) INTO STRICT grantee_sql FROM pg_roles WHERE oid=grant_row.grantee; END IF;
   EXECUTE format('REVOKE ALL PRIVILEGES ON TABLE %s FROM %s',object_sql,grantee_sql);
   EXECUTE format('REVOKE ALL PRIVILEGES (%s) ON TABLE %s FROM %s',column_list,object_sql,grantee_sql);
  END LOOP;
 END LOOP;
 FOREACH name IN ARRAY ARRAY[
  'zzsh_order.legacy_withdrawal_row_fingerprint(zzsh_order.personal_finance_observation)',
  'zzsh_order.legacy_withdrawal_verified_source(zzsh_order.personal_finance_observation)',
  'zzsh_order.bump_legacy_withdrawal_subject_revision()',
  'zzsh_order.guard_legacy_withdrawal_link_evidence()',
  'zzsh_order.certify_legacy_withdrawal_link(text)'
 ]::text[] LOOP
  SELECT p.oid,p.proowner,p.oid::regprocedure::text INTO STRICT object_oid,owner_oid,object_sql
   FROM pg_proc p WHERE p.oid=to_regprocedure(name);
  FOR grant_row IN SELECT DISTINCT grantee FROM (
   SELECT 0::oid AS grantee UNION ALL SELECT acl.grantee FROM pg_proc p CROSS JOIN LATERAL aclexplode(p.proacl) acl WHERE p.oid=object_oid
  ) grants WHERE grantee<>owner_oid LOOP
   IF grant_row.grantee=0 THEN grantee_sql:='PUBLIC';
   ELSE SELECT format('%I',rolname) INTO STRICT grantee_sql FROM pg_roles WHERE oid=grant_row.grantee; END IF;
   EXECUTE format('REVOKE ALL PRIVILEGES ON FUNCTION %s FROM %s',object_sql,grantee_sql);
  END LOOP;
 END LOOP;
END $withdrawal_link_initial_acl$;
