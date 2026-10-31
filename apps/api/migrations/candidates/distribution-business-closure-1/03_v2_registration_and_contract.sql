-- UNNUMBERED CANDIDATE. Root owns numbering/journal/rollback. NOT APPLIED to any database.
-- Apply together with 01 and 02 inside the existing Drizzle migration transaction:
-- no BEGIN/COMMIT in this package. Marks contract readiness only after the v1/v2 participant
-- shape and the policy/derive replacements are installed in the same transaction.

ALTER TABLE zzsh_order.invitation_relation
  DROP CONSTRAINT IF EXISTS invitation_relation_source_type_check,
  ADD CONSTRAINT invitation_relation_source_type_check CHECK(source_type IN('NATIVE_REGISTRATION','LEGACY_MYSQL','LOCAL_CONTROLLED','NATIVE_SELF_BIND'));

ALTER TABLE zzsh_order.distribution_participant
  DROP CONSTRAINT IF EXISTS distribution_participant_check,
  ADD CONSTRAINT distribution_participant_check
    CHECK(eligibility<>'ELIGIBLE' OR policy_version_id IS NOT NULL);

CREATE OR REPLACE FUNCTION zzsh_order.guard_distribution_participant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy jsonb;policy_scope text;policy_schema text;head_id text;default_level text;owner_name text;
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
  END IF;
 END IF;
 IF TG_OP='INSERT' AND NEW.revision<>1 OR TG_OP='UPDATE' AND(
  NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.source_type IS DISTINCT FROM OLD.source_type
  OR NEW.source_ref IS DISTINCT FROM OLD.source_ref OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
  OR NEW.revision<>OLD.revision+1 OR NEW.inviter_knowledge IS DISTINCT FROM OLD.inviter_knowledge
  OR OLD.leader_knowledge='KNOWN_PARENT' AND NEW.leader_knowledge<>'KNOWN_PARENT')
 THEN RAISE EXCEPTION 'participant requires exact next revision and immutable original provenance' USING ERRCODE='40001';END IF;
 IF NEW.policy_version_id IS NULL THEN
  IF NEW.level_code IS NOT NULL OR NEW.eligibility='ELIGIBLE'
  THEN RAISE EXCEPTION 'participant without a policy source cannot claim eligibility or level' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 SELECT v.scope,v.schema_version,v.canonical_config::jsonb INTO policy_scope,policy_schema,policy
  FROM zzsh_order.distribution_policy_version v WHERE v.id=NEW.policy_version_id;
 IF policy IS NULL THEN RAISE EXCEPTION 'participant policy source is missing' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' OR NEW.policy_version_id IS DISTINCT FROM OLD.policy_version_id THEN
  SELECT h.current_version_id INTO head_id FROM zzsh_order.distribution_policy_head h WHERE h.scope=policy_scope;
  IF head_id IS DISTINCT FROM NEW.policy_version_id
  THEN RAISE EXCEPTION 'participant must use the exact current head of its policy scope' USING ERRCODE='23514';END IF;
 END IF;
 IF policy_schema='distribution-policy.v2' THEN
  IF NEW.level_code IS NOT NULL THEN RAISE EXCEPTION 'uniform policy participant cannot carry a legacy level' USING ERRCODE='23514';END IF;
  -- v2 disabled stops new first-payment accrual; it does not erase participation eligibility.
  IF TG_OP='INSERT' AND NEW.source_type='NATIVE_REGISTRATION' AND NEW.eligibility<>'ELIGIBLE'
  THEN RAISE EXCEPTION 'uniform registration must retain eligibility' USING ERRCODE='23514';END IF;
 ELSE
  SELECT level->>'code' INTO default_level FROM jsonb_array_elements(COALESCE(policy->'levels','[]'::jsonb)) level WHERE level->'default'='true'::jsonb;
  IF NEW.level_code IS NULL OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(COALESCE(policy->'levels','[]'::jsonb)) level WHERE level->>'code'=NEW.level_code)
  THEN RAISE EXCEPTION 'participant level has no exact policy source' USING ERRCODE='23514';END IF;
  IF TG_OP='INSERT' AND NEW.source_type='NATIVE_REGISTRATION'
   AND(NEW.level_code IS DISTINCT FROM default_level OR NEW.eligibility IS DISTINCT FROM(CASE WHEN policy->'enabled'='true'::jsonb THEN 'ELIGIBLE' ELSE 'INELIGIBLE' END))
  THEN RAISE EXCEPTION 'native registration must use original head and default qualification' USING ERRCODE='23514';END IF;
  IF NEW.eligibility='ELIGIBLE' AND policy->'enabled' IS DISTINCT FROM 'true'::jsonb
  THEN RAISE EXCEPTION 'disabled policy cannot admit an eligible participant' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.distribution_policy_contract_version() RETURNS integer
 LANGUAGE sql IMMUTABLE AS $$ SELECT 2 $$;
REVOKE ALL ON FUNCTION zzsh_order.distribution_policy_contract_version() FROM PUBLIC;
