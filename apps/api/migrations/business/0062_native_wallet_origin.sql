-- Unnumbered candidate, NOT an execution permit. Install only in the reviewed U4B window.
-- Existing audit_event INSERT permissions cannot establish this evidence.
CREATE TABLE zzsh_order.native_user_insert_proof (
 user_id text PRIMARY KEY REFERENCES zzsh_auth_user."user"(id),
 insert_xid xid8,
 captured_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
-- Explicitly ineligible baseline; never backfill a fresh-registration claim.
-- This also prevents delete/reinsert of an existing ID from forging a new origin.
INSERT INTO zzsh_order.native_user_insert_proof(user_id,insert_xid)
 SELECT id,NULL FROM zzsh_auth_user."user";
REVOKE ALL ON TABLE zzsh_order.native_user_insert_proof FROM PUBLIC;
CREATE FUNCTION zzsh_order.guard_native_user_insert_proof() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF current_user<>pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid=TG_RELID))
  OR pg_trigger_depth()<>2 OR NEW.insert_xid IS DISTINCT FROM pg_current_xact_id()
 THEN RAISE EXCEPTION 'protected proof can only be issued by original INSERT trigger' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.guard_native_user_insert_proof() FROM PUBLIC;
CREATE TRIGGER native_user_insert_proof_issuer BEFORE INSERT ON zzsh_order.native_user_insert_proof
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_native_user_insert_proof();
CREATE TRIGGER native_user_insert_proof_immutable BEFORE UPDATE OR DELETE
 ON zzsh_order.native_user_insert_proof FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER native_user_insert_proof_no_truncate BEFORE TRUNCATE
 ON zzsh_order.native_user_insert_proof FOR EACH STATEMENT EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE FUNCTION zzsh_order.capture_native_user_insert() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
BEGIN
 IF TG_TABLE_SCHEMA<>'zzsh_auth_user' OR TG_TABLE_NAME<>'user' OR TG_OP<>'INSERT' OR TG_LEVEL<>'ROW'
 THEN RAISE EXCEPTION 'only original user INSERT can issue proof' USING ERRCODE='23514';END IF;
 INSERT INTO zzsh_order.native_user_insert_proof(user_id,insert_xid)
  VALUES(NEW.id,pg_current_xact_id());
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.capture_native_user_insert() FROM PUBLIC;
CREATE TRIGGER native_user_insert_proof_capture AFTER INSERT ON zzsh_auth_user."user"
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.capture_native_user_insert();
-- Exact reviewed runtime receives SELECT only. No INSERT/UPDATE/DELETE/TRUNCATE,
-- no trigger function EXECUTE, ownership, schema CREATE or role membership changes.
-- Do not use blanket default privileges: explicit role ACL is part of the window package.

-- U4 native-origin candidate; no number/execution authorization. Preserve old0058/0059 files.
-- Requires native-user-insert-proof-candidate.sql; xmin/audit alone never proves birth.
ALTER TABLE zzsh_order.finance_opening_basis
 DROP CONSTRAINT finance_opening_basis_source_kind_check,DROP CONSTRAINT finance_opening_basis_check,
 ADD COLUMN native_origin_canonical text,
 ADD CONSTRAINT finance_opening_basis_source_kind_check CHECK(source_kind IN('LEGACY_OPENING','NATIVE_GENESIS')),
 ADD CONSTRAINT finance_opening_basis_check CHECK(
  source_kind='LEGACY_OPENING' AND source_entity='la_user' AND source_cutoff IS NOT NULL AND identity_source_digest IS NOT NULL AND identity_source_digest~'^[0-9a-f]{64}$' AND native_origin_canonical IS NULL
  OR source_kind='NATIVE_GENESIS' AND source_system='zzsh-native-registration' AND source_entity='zzsh_auth_user.user' AND source_id=user_id
   AND available_cents=0 AND covered_count=0 AND covered_set_digest=encode(sha256(convert_to('','UTF8')),'hex') AND source_cutoff IS NOT NULL
   AND native_origin_canonical IS NOT NULL AND source_digest=encode(sha256(convert_to(native_origin_canonical,'UTF8')),'hex') AND identity_source_digest=source_digest);
ALTER TABLE zzsh_order.wallet_coverage DROP CONSTRAINT wallet_coverage_origin_check,
 ADD CONSTRAINT wallet_coverage_origin_check CHECK(origin IN('RECONCILED_OPENING','NATIVE_GENESIS'));
-- Compose this source shape with earnings-source shape in the final numbered migration.
ALTER TABLE zzsh_order.finance_economic_root DROP CONSTRAINT finance_root_enabled_source_shape,
 ADD CONSTRAINT finance_root_enabled_source_shape CHECK(source_kind IN('LEGACY_OPENING','NATIVE_GENESIS') AND basis_id IS NOT NULL
  OR source_kind='LOCAL_CONTROLLED_WITHDRAWAL' AND basis_id IS NULL);
DROP TRIGGER opening_basis_guard ON zzsh_order.finance_opening_basis;
CREATE TRIGGER opening_basis_guard BEFORE INSERT ON zzsh_order.finance_opening_basis FOR EACH ROW
 WHEN(NEW.source_kind='LEGACY_OPENING') EXECUTE FUNCTION zzsh_order.guard_opening_basis();
CREATE FUNCTION zzsh_order.guard_native_origin_basis() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof jsonb:=NEW.native_origin_canonical::jsonb;owner_name text;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 IF current_user<>owner_name OR session_user!~'_r$' OR proof->>'schema' IS DISTINCT FROM 'native-wallet-origin.v2' OR proof->>'userId' IS DISTINCT FROM NEW.user_id
  OR (SELECT count(*) FROM jsonb_object_keys(proof))<>4
  OR NOT EXISTS(SELECT 1 FROM zzsh_auth_user."user" u JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id
   JOIN zzsh_order.native_user_insert_proof p ON p.user_id=u.id
   WHERE u.id=NEW.user_id AND NOT u.suspended AND s.account_status='ACTIVE' AND s.provider='none'
    AND p.insert_xid=pg_current_xact_id() AND p.insert_xid::text=proof->>'insertionXid' AND NEW.source_cutoff=p.captured_at
    AND s.version::text=proof->>'identityVersion')
  OR EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=NEW.user_id AND action='user.legacy_owner.migrated' AND outcome='SUCCESS')
  OR EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=NEW.user_id)
  OR EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage WHERE user_id=NEW.user_id)
 THEN RAISE EXCEPTION 'native zero origin requires fresh source/empty financial history' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER native_origin_basis_guard BEFORE INSERT ON zzsh_order.finance_opening_basis FOR EACH ROW
 WHEN(NEW.source_kind='NATIVE_GENESIS') EXECUTE FUNCTION zzsh_order.guard_native_origin_basis();
-- Both statement orders must reject: legacy then genesis, or genesis then late legacy.
CREATE FUNCTION zzsh_order.check_native_origin_excludes_legacy() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE subject_value text;
BEGIN
 IF TG_TABLE_SCHEMA='zzsh_order' AND TG_TABLE_NAME='finance_opening_basis' THEN
  subject_value:=NEW.user_id;
 ELSIF TG_TABLE_SCHEMA='zzsh_iam' AND TG_TABLE_NAME='audit_event' THEN
  subject_value:=NEW.object_id;
 ELSE RAISE EXCEPTION 'unexpected native origin trigger relation' USING ERRCODE='23514';END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=subject_value FOR UPDATE;
 IF EXISTS(SELECT 1 FROM zzsh_order.finance_opening_basis WHERE user_id=subject_value AND source_kind='NATIVE_GENESIS')
  AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=subject_value AND action='user.legacy_owner.migrated' AND outcome='SUCCESS')
 THEN RAISE EXCEPTION 'legacy identity cannot receive native zero origin' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.check_native_origin_excludes_legacy() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER native_origin_excludes_legacy_basis AFTER INSERT ON zzsh_order.finance_opening_basis
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.source_kind='NATIVE_GENESIS')
 EXECUTE FUNCTION zzsh_order.check_native_origin_excludes_legacy();
CREATE CONSTRAINT TRIGGER native_origin_excludes_legacy_source AFTER INSERT ON zzsh_iam.audit_event
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.action='user.legacy_owner.migrated' AND NEW.outcome='SUCCESS')
 EXECUTE FUNCTION zzsh_order.check_native_origin_excludes_legacy();
CREATE FUNCTION zzsh_order.guard_native_origin_root() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b zzsh_order.finance_opening_basis;
BEGIN
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 IF b.id IS NULL OR b.source_kind<>'NATIVE_GENESIS' OR b.created_xid<>pg_current_xact_id() OR NEW.source_type<>'NATIVE' OR NEW.subject_user_id<>b.user_id
  OR NEW.source_system<>b.source_system OR NEW.source_entity<>b.source_entity OR NEW.source_id<>b.source_id OR NEW.source_digest<>b.source_digest
  OR NEW.beneficiary_role<>'WALLET_HOLDER' OR NEW.policy_version IS NOT NULL
 THEN RAISE EXCEPTION 'native root not bound to original zero origin' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER native_origin_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW
 WHEN(NEW.source_kind='NATIVE_GENESIS') EXECUTE FUNCTION zzsh_order.guard_native_origin_root();
DROP TRIGGER finance_root_guard ON zzsh_order.finance_economic_root;
CREATE TRIGGER finance_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW
 WHEN(NEW.source_kind='LEGACY_OPENING') EXECUTE FUNCTION zzsh_order.guard_finance_root();
CREATE FUNCTION zzsh_order.check_native_origin_closure() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE b zzsh_order.finance_opening_basis;r zzsh_order.finance_economic_root;e zzsh_order.finance_event;
BEGIN
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=NEW.id;
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE basis_id=b.id;
 SELECT * INTO e FROM zzsh_order.finance_event WHERE economic_root_id=r.id AND kind='OPENING';
 IF r.id IS NULL OR e.id IS NULL OR r.source_kind<>'NATIVE_GENESIS' OR r.subject_user_id<>b.user_id
  OR e.subject_user_id<>b.user_id OR e.expected_ledger_revision<>0 OR e.created_xid<>b.created_xid
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage c WHERE c.user_id=b.user_id AND c.basis_id=b.id
    AND c.opening_event_id=e.id AND c.origin='NATIVE_GENESIS')
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_revision WHERE user_id=b.user_id AND ledger_revision>=1)
  OR EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=e.id)
 THEN RAISE EXCEPTION 'native zero origin requires complete zero-entry opening/coverage' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.check_native_origin_closure() FROM PUBLIC;
CREATE CONSTRAINT TRIGGER native_origin_complete_batch AFTER INSERT ON zzsh_order.finance_opening_basis
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.source_kind='NATIVE_GENESIS')
 EXECUTE FUNCTION zzsh_order.check_native_origin_closure();
CREATE OR REPLACE FUNCTION zzsh_order.finance_event_wallet_revision() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE root zzsh_order.finance_economic_root;basis zzsh_order.finance_opening_basis;
BEGIN
 SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 SELECT * INTO basis FROM zzsh_order.finance_opening_basis WHERE id=root.basis_id;
 INSERT INTO zzsh_order.wallet_coverage(user_id,origin,basis_id,opening_event_id)
  VALUES(NEW.subject_user_id,CASE basis.source_kind WHEN 'NATIVE_GENESIS' THEN 'NATIVE_GENESIS' ELSE 'RECONCILED_OPENING' END,basis.id,NEW.id);
 INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision) VALUES(NEW.subject_user_id,1,1)
  ON CONFLICT(user_id) DO UPDATE SET ledger_revision=zzsh_order.wallet_revision.ledger_revision+1,read_revision=zzsh_order.wallet_revision.read_revision+1;
 RETURN NULL;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.finance_event_wallet_revision() FROM PUBLIC;
CREATE FUNCTION zzsh_order.initialize_native_wallet_origin(user_id_value text,canonical text,digest text,request_id_value text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE basis_id_value text:='native_basis_'||substr(encode(sha256(convert_to(user_id_value,'UTF8')),'hex'),1,40);
 root_id_value text:='native_root_'||substr(encode(sha256(convert_to(user_id_value,'UTF8')),'hex'),1,40);
 event_id_value text:='native_origin_'||substr(encode(sha256(convert_to(user_id_value,'UTF8')),'hex'),1,40);birth timestamptz;
BEGIN
 -- Materialize these four literals from the exact Master-assigned resource before sealing SQL.
 -- Unmaterialized template fails closed; naming patterns never admit another resource.
 IF current_database()<>'zzsh_test_order_personal_finance' OR session_user<>'zzsh_order_personal_finance_r'
  OR (SELECT oid::text FROM pg_database WHERE datname=current_database())<>'869754'
  OR COALESCE((SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()),'')<>'zzsh:order-reservation-test:v1'
  OR digest IS DISTINCT FROM encode(sha256(convert_to(canonical,'UTF8')),'hex')
 THEN RAISE EXCEPTION 'native origin caller/resource/digest not admitted' USING ERRCODE='23514';END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=user_id_value FOR UPDATE;
 SELECT captured_at INTO birth FROM zzsh_order.native_user_insert_proof
  WHERE user_id=user_id_value AND insert_xid=pg_current_xact_id();
 IF birth IS NULL THEN RAISE EXCEPTION 'native subject missing' USING ERRCODE='23514';END IF;
 INSERT INTO zzsh_order.finance_opening_basis(id,user_id,source_kind,source_system,source_entity,source_id,identity_source_digest,source_digest,available_cents,source_cutoff,covered_count,covered_set_digest,native_origin_canonical)
  VALUES(basis_id_value,user_id_value,'NATIVE_GENESIS','zzsh-native-registration','zzsh_auth_user.user',user_id_value,digest,digest,0,birth,0,encode(sha256(convert_to('','UTF8')),'hex'),canonical);
 INSERT INTO zzsh_order.finance_economic_root(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,source_digest)
  VALUES(root_id_value,basis_id_value,'NATIVE_GENESIS','NATIVE','zzsh-native-registration','zzsh_auth_user.user',user_id_value,user_id_value,'WALLET_HOLDER',digest);
 INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision) VALUES(event_id_value,root_id_value,'OPENING',user_id_value,0);
 INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,action,object_type,object_id,outcome,request_id,occurred_at,details)
  VALUES('audit_native_origin_'||replace(gen_random_uuid()::text,'-',''),'system',user_id_value,'finance.native.origin.created','wallet_coverage',user_id_value,'SUCCESS',request_id_value,clock_timestamp(),jsonb_build_object('origin','NATIVE_GENESIS','sourceDigest',digest));
 RETURN jsonb_build_object('knowledge','KNOWN','origin','NATIVE_GENESIS','availableCents','0');
END $$;
REVOKE ALL ON FUNCTION zzsh_order.initialize_native_wallet_origin(text,text,text,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_native_origin_basis() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_native_origin_root() FROM PUBLIC;
-- Required before execution: compose root trigger WHENs with earning dispatch, exact resource OID
-- and runtime EXECUTE grant; genesis function/result/coverage reverse assertion, same-SDK registration
-- hunk; native bucket/read projection + old-zero/legacy/duplicate UID negative PG window.


-- Candidate continuation of the proved birth primitive. Requires original 0061 + native proof.
-- No existing participant/code/relation rows are rewritten.
CREATE OR REPLACE FUNCTION zzsh_order.guard_distribution_participant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy jsonb;head_id text;default_level text;owner_name text;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'participant provenance cannot be deleted' USING ERRCODE='40001';END IF;
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 IF TG_OP='INSERT' THEN
  IF NEW.source_type<>'NATIVE_REGISTRATION' AND current_user<>owner_name
  THEN RAISE EXCEPTION 'runtime participant requires native registration provenance' USING ERRCODE='23514';END IF;
  IF NEW.source_type='NATIVE_REGISTRATION' THEN
   IF NEW.source_ref<>'registration:'||NEW.user_id OR NEW.invitees_knowledge<>'KNOWN'
    OR NEW.commission_frozen IS DISTINCT FROM false OR NOT EXISTS(
     SELECT 1 FROM zzsh_order.native_user_insert_proof p JOIN zzsh_auth_user."user" u ON u.id=p.user_id
     JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id
     WHERE p.user_id=NEW.user_id AND p.insert_xid=pg_current_xact_id() AND NOT u.suspended
      AND s.account_status='ACTIVE' AND s.provider='none')
    OR EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=NEW.user_id AND action='user.legacy_owner.migrated' AND outcome='SUCCESS')
   THEN RAISE EXCEPTION 'native participant requires protected fresh insertion' USING ERRCODE='23514';END IF;
   SELECT v.id,v.canonical_config::jsonb INTO head_id,policy FROM zzsh_order.distribution_policy_head h
    JOIN zzsh_order.distribution_policy_version v ON v.id=h.current_version_id AND v.scope=h.scope AND v.revision=h.revision
    WHERE h.scope='LOCAL_CONTROLLED' FOR SHARE OF h;
   SELECT level->>'code' INTO default_level FROM jsonb_array_elements(COALESCE(policy->'levels','[]'::jsonb)) level WHERE level->'default'='true'::jsonb;
   IF NEW.policy_version_id IS DISTINCT FROM head_id OR NEW.level_code IS DISTINCT FROM default_level
    OR NEW.eligibility IS DISTINCT FROM (CASE WHEN head_id IS NULL THEN 'UNKNOWN' WHEN policy->'enabled'='true'::jsonb THEN 'ELIGIBLE' ELSE 'INELIGIBLE' END)
   THEN RAISE EXCEPTION 'native registration must use original head and default qualification' USING ERRCODE='23514';END IF;
  END IF;
 END IF;
 IF TG_OP='INSERT' AND NEW.revision<>1 OR TG_OP='UPDATE' AND(
  NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.source_type IS DISTINCT FROM OLD.source_type
  OR NEW.source_ref IS DISTINCT FROM OLD.source_ref OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
  OR NEW.revision<>OLD.revision+1 OR NEW.inviter_knowledge IS DISTINCT FROM OLD.inviter_knowledge
  OR OLD.leader_knowledge='KNOWN_PARENT' AND NEW.leader_knowledge<>'KNOWN_PARENT')
 THEN RAISE EXCEPTION 'participant requires exact next revision and immutable original provenance' USING ERRCODE='40001';END IF;
 IF NEW.policy_version_id IS NOT NULL THEN
  SELECT canonical_config::jsonb INTO policy FROM zzsh_order.distribution_policy_version WHERE id=NEW.policy_version_id;
  IF policy IS NULL OR NEW.level_code IS NOT NULL AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements(policy->'levels') level WHERE level->>'code'=NEW.level_code)
  THEN RAISE EXCEPTION 'participant level has no exact policy source' USING ERRCODE='23514';END IF;
  IF NEW.eligibility='ELIGIBLE' AND policy->'enabled' IS DISTINCT FROM 'true'::jsonb
  THEN RAISE EXCEPTION 'disabled policy cannot admit an eligible participant' USING ERRCODE='23514';END IF;
 ELSIF NEW.level_code IS NOT NULL THEN RAISE EXCEPTION 'level has no policy source' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE OR REPLACE FUNCTION zzsh_order.guard_native_invitation_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p zzsh_order.distribution_participant;
BEGIN
 IF NEW.source_type='NATIVE_REGISTRATION' THEN
  IF NOT EXISTS(SELECT 1 FROM zzsh_order.native_user_insert_proof WHERE user_id=NEW.child_user_id AND insert_xid=pg_current_xact_id())
  THEN RAISE EXCEPTION 'native relation requires protected original insertion transaction' USING ERRCODE='23514';END IF;
  SELECT * INTO p FROM zzsh_order.distribution_participant WHERE user_id=NEW.child_user_id;
  IF p.source_type IS DISTINCT FROM 'NATIVE_REGISTRATION' OR NEW.source_ref IS DISTINCT FROM p.source_ref OR NEW.source_digest IS DISTINCT FROM p.source_digest
  THEN RAISE EXCEPTION 'native relation has different registration provenance' USING ERRCODE='23514';END IF;
 ELSIF NEW.type='INVITER' AND NEW.source_type='LOCAL_CONTROLLED' THEN
  RAISE EXCEPTION 'self-service cannot overwrite registration inviter' USING ERRCODE='23514';
 END IF;RETURN NEW;
END $$;
CREATE FUNCTION zzsh_order.guard_native_invite_code_proof() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.source_system<>'zzsh' OR NEW.source_entity<>'auth_user' OR NEW.source_id<>NEW.user_id
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.native_user_insert_proof b
   JOIN zzsh_order.distribution_participant p ON p.user_id=b.user_id
   WHERE b.user_id=NEW.user_id AND b.insert_xid=pg_current_xact_id()
    AND p.source_type='NATIVE_REGISTRATION' AND p.source_digest=NEW.source_digest)
 THEN RAISE EXCEPTION 'native code requires the same protected registration source' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.guard_native_invite_code_proof() FROM PUBLIC;
CREATE TRIGGER native_invite_code_proof BEFORE INSERT ON zzsh_order.distribution_invite_code
 FOR EACH ROW WHEN(NEW.source_type='NATIVE_REGISTRATION') EXECUTE FUNCTION zzsh_order.guard_native_invite_code_proof();
