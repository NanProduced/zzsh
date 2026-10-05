-- U4-A candidate; no activation values or permissions are assigned automatically.
CREATE TABLE zzsh_order.distribution_policy_version (
 id text PRIMARY KEY,revision bigint NOT NULL CHECK(revision>0),scope text NOT NULL CHECK(scope='LOCAL_CONTROLLED'),
 schema_version text NOT NULL CHECK(schema_version='distribution-policy.v1'),canonical_config text NOT NULL,
 config_digest text NOT NULL CHECK(config_digest~'^[0-9a-f]{64}$'),created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(config_digest=encode(sha256(convert_to(canonical_config,'UTF8')),'hex')),
 CHECK(jsonb_typeof(canonical_config::jsonb)='object'),UNIQUE(scope,revision),UNIQUE(id,scope,revision)
);
CREATE TABLE zzsh_order.distribution_policy_head (
 scope text PRIMARY KEY CHECK(scope='LOCAL_CONTROLLED'),revision bigint NOT NULL CHECK(revision>0),current_version_id text NOT NULL,
 FOREIGN KEY(current_version_id,scope,revision) REFERENCES zzsh_order.distribution_policy_version(id,scope,revision) DEFERRABLE INITIALLY DEFERRED
);
CREATE FUNCTION zzsh_order.guard_distribution_policy_version() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE doc jsonb:=NEW.canonical_config::jsonb;l jsonb;u jsonb;c jsonb;keys integer;defaults integer:=0;max_r numeric:=0;max_o numeric:=0;
BEGIN
 SELECT count(*) INTO keys FROM jsonb_object_keys(doc);
 IF keys<>10 OR doc->>'schema' IS DISTINCT FROM NEW.schema_version OR doc->>'scope' IS DISTINCT FROM NEW.scope
  OR jsonb_typeof(doc->'enabled') IS DISTINCT FROM 'boolean' OR doc->>'participation' IS DISTINCT FROM 'AUTO_AT_REGISTRATION'
  OR doc->'depth' IS DISTINCT FROM '1'::jsonb OR doc->'selfRebate' IS DISTINCT FROM 'false'::jsonb
  OR jsonb_typeof(doc->'minimumAccrualCents') IS DISTINCT FROM 'string' OR COALESCE(doc->>'minimumAccrualCents','')!~'^(0|[1-9][0-9]{0,23})$'
  OR jsonb_typeof(doc->'settlementDelayDays') IS DISTINCT FROM 'number' OR COALESCE(doc->>'settlementDelayDays','')!~'^(0|[1-9][0-9]{0,5})$'
  OR jsonb_typeof(doc->'accountModes') IS DISTINCT FROM 'array' OR jsonb_typeof(doc->'levels') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'typed distribution policy shape invalid' USING ERRCODE='23514';END IF;
 IF jsonb_array_length(doc->'accountModes') NOT BETWEEN 1 AND 2 OR EXISTS(
  SELECT 1 FROM jsonb_array_elements(doc->'accountModes') m WHERE m NOT IN('"ordinary"'::jsonb,'"custom"'::jsonb))
  OR (SELECT count(DISTINCT m) FROM jsonb_array_elements(doc->'accountModes') m)<>jsonb_array_length(doc->'accountModes')
  OR jsonb_array_length(doc->'levels') NOT BETWEEN 1 AND 999
 THEN RAISE EXCEPTION 'distribution modes or levels invalid' USING ERRCODE='23514';END IF;
 FOR l IN SELECT value FROM jsonb_array_elements(doc->'levels') LOOP
  IF jsonb_typeof(l) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'typed level object required' USING ERRCODE='23514';END IF;
  SELECT count(*) INTO keys FROM jsonb_object_keys(l);
  IF keys<>6 OR jsonb_typeof(l->'code') IS DISTINCT FROM 'string' OR COALESCE(l->>'code','')!~'^[A-Za-z][A-Za-z0-9_-]{0,63}$'
   OR jsonb_typeof(l->'rank') IS DISTINCT FROM 'number' OR COALESCE(l->>'rank','')!~'^[1-9][0-9]{0,2}$'
   OR jsonb_typeof(l->'default') IS DISTINCT FROM 'boolean'
   OR jsonb_typeof(l->'renterPercent') IS DISTINCT FROM 'string' OR COALESCE(l->>'renterPercent','')!~'^(0|[1-9][0-9]{0,2})(\.[0-9]{1,8})?$'
   OR jsonb_typeof(l->'ownerPercent') IS DISTINCT FROM 'string' OR COALESCE(l->>'ownerPercent','')!~'^(0|[1-9][0-9]{0,2})(\.[0-9]{1,8})?$'
  THEN RAISE EXCEPTION 'typed level fields invalid' USING ERRCODE='23514';END IF;
  max_r:=greatest(max_r,(l->>'renterPercent')::numeric);max_o:=greatest(max_o,(l->>'ownerPercent')::numeric);
  IF l->'default'='true'::jsonb THEN defaults:=defaults+1;END IF;
  u:=l->'upgrade';IF u IS DISTINCT FROM 'null'::jsonb THEN
   IF jsonb_typeof(u) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'typed upgrade required' USING ERRCODE='23514';END IF;
   SELECT count(*) INTO keys FROM jsonb_object_keys(u);
   IF keys<>2 OR COALESCE(u->>'match','') NOT IN('ANY','ALL') OR jsonb_typeof(u->'conditions') IS DISTINCT FROM 'array' OR l->'default'='true'::jsonb
   THEN RAISE EXCEPTION 'typed upgrade shape invalid' USING ERRCODE='23514';END IF;
   IF jsonb_array_length(u->'conditions') NOT BETWEEN 1 AND 4 THEN RAISE EXCEPTION 'empty upgrade is not automatic eligibility' USING ERRCODE='23514';END IF;
   FOR c IN SELECT value FROM jsonb_array_elements(u->'conditions') LOOP
    IF jsonb_typeof(c) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'typed upgrade condition required' USING ERRCODE='23514';END IF;
    SELECT count(*) INTO keys FROM jsonb_object_keys(c);
    IF keys<>2 OR COALESCE(c->>'metric','') NOT IN('LAST_PAID_AMOUNT','TOTAL_PAID_AMOUNT','PAID_COUNT','SETTLED_REFERRAL')
     OR jsonb_typeof(c->'value') IS DISTINCT FROM 'string' OR COALESCE(c->>'value','')!~'^(0|[1-9][0-9]{0,23})$'
    THEN RAISE EXCEPTION 'typed upgrade condition invalid' USING ERRCODE='23514';END IF;
   END LOOP;
   IF (SELECT count(DISTINCT x->>'metric') FROM jsonb_array_elements(u->'conditions') x)<>jsonb_array_length(u->'conditions')
   THEN RAISE EXCEPTION 'duplicate upgrade metric' USING ERRCODE='23514';END IF;
  END IF;
 END LOOP;
 IF defaults<>1 OR max_r+max_o>100
  OR (SELECT count(DISTINCT x->>'code') FROM jsonb_array_elements(doc->'levels') x)<>jsonb_array_length(doc->'levels')
  OR (SELECT count(DISTINCT x->>'rank') FROM jsonb_array_elements(doc->'levels') x)<>jsonb_array_length(doc->'levels')
 THEN RAISE EXCEPTION 'distribution defaults, stable levels or cross-level rate bounds invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER distribution_policy_version_guard BEFORE INSERT ON zzsh_order.distribution_policy_version
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_distribution_policy_version();
CREATE TRIGGER distribution_policy_version_immutable BEFORE UPDATE OR DELETE ON zzsh_order.distribution_policy_version
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE FUNCTION zzsh_order.guard_distribution_policy_head() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('zzsh:distribution-policy:LOCAL_CONTROLLED',0));
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'policy head cannot be deleted' USING ERRCODE='40001';END IF;
 IF TG_OP='INSERT' AND NEW.revision<>1 OR TG_OP='UPDATE' AND(NEW.scope IS DISTINCT FROM OLD.scope OR NEW.revision<>OLD.revision+1 OR NEW.current_version_id=OLD.current_version_id)
  THEN RAISE EXCEPTION 'policy head requires exact next immutable version' USING ERRCODE='40001';END IF;RETURN NEW;
END $$;
CREATE TRIGGER distribution_policy_head_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_order.distribution_policy_head
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_distribution_policy_head();
CREATE TABLE zzsh_order.distribution_participant (
 user_id text PRIMARY KEY REFERENCES zzsh_auth_user."user"(id),
 eligibility text NOT NULL CHECK(eligibility IN('ELIGIBLE','INELIGIBLE','UNKNOWN')),commission_frozen boolean,level_code text,
 policy_version_id text REFERENCES zzsh_order.distribution_policy_version(id),revision bigint NOT NULL CHECK(revision>0),
 inviter_knowledge text NOT NULL CHECK(inviter_knowledge IN('KNOWN_NONE','KNOWN_PARENT','UNKNOWN')),
 leader_knowledge text NOT NULL CHECK(leader_knowledge IN('KNOWN_NONE','KNOWN_PARENT','UNKNOWN')),
 invitees_knowledge text NOT NULL DEFAULT 'UNKNOWN' CHECK(invitees_knowledge IN('KNOWN','UNKNOWN')),
 source_type text NOT NULL CHECK(source_type IN('NATIVE_REGISTRATION','LEGACY_MYSQL','LOCAL_CONTROLLED')),
 source_ref text NOT NULL CHECK(length(btrim(source_ref)) BETWEEN 1 AND 256),source_digest text NOT NULL CHECK(source_digest~'^[0-9a-f]{64}$'),
 CHECK(eligibility<>'ELIGIBLE' OR(level_code IS NOT NULL AND policy_version_id IS NOT NULL))
);
CREATE TABLE zzsh_order.distribution_invite_code (
 id text PRIMARY KEY,user_id text REFERENCES zzsh_auth_user."user"(id),display_code varchar(30) NOT NULL,
 match_code varchar(30) GENERATED ALWAYS AS(upper(display_code)) STORED UNIQUE,
 source_type text NOT NULL CHECK(source_type IN('NATIVE_REGISTRATION','LEGACY_MYSQL','LOCAL_CONTROLLED')),
 source_system text NOT NULL,source_entity text NOT NULL,source_id text NOT NULL,source_digest text NOT NULL CHECK(source_digest~'^[0-9a-f]{64}$'),
 CHECK(display_code~'^[A-Za-z0-9_-]{1,30}$'),UNIQUE(source_type,source_system,source_entity,source_id)
);
CREATE TRIGGER distribution_code_immutable BEFORE UPDATE OR DELETE ON zzsh_order.distribution_invite_code
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TABLE zzsh_order.invitation_relation (
 id text PRIMARY KEY,type text NOT NULL CHECK(type IN('INVITER','DISTRIBUTION_LEADER')),
 child_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),parent_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 policy_version_id text REFERENCES zzsh_order.distribution_policy_version(id),
 source_type text NOT NULL CHECK(source_type IN('NATIVE_REGISTRATION','LEGACY_MYSQL','LOCAL_CONTROLLED')),
 source_ref text NOT NULL,source_digest text NOT NULL CHECK(source_digest~'^[0-9a-f]{64}$'),bound_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(child_user_id<>parent_user_id),UNIQUE(type,child_user_id)
);
CREATE TRIGGER invitation_relation_immutable BEFORE UPDATE OR DELETE ON zzsh_order.invitation_relation
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE INDEX invitation_relation_parent_read ON zzsh_order.invitation_relation(parent_user_id,type,id);
CREATE FUNCTION zzsh_order.guard_invitation_relation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE cyclic boolean;
BEGIN
 PERFORM pg_advisory_xact_lock(hashtextextended('zzsh:invitation-graph:v1',0));
 WITH RECURSIVE ancestors(user_id,path) AS(
  SELECT NEW.parent_user_id,ARRAY[NEW.parent_user_id]::text[]
  UNION ALL SELECT r.parent_user_id,a.path||r.parent_user_id FROM ancestors a JOIN zzsh_order.invitation_relation r ON r.child_user_id=a.user_id AND r.type=NEW.type
   WHERE NOT(r.parent_user_id=ANY(a.path))
 ) SELECT EXISTS(SELECT 1 FROM ancestors WHERE user_id=NEW.child_user_id) INTO cyclic;
 IF cyclic THEN RAISE EXCEPTION 'invitation ancestor cycle rejected' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;
CREATE TRIGGER invitation_relation_cycle_guard BEFORE INSERT ON zzsh_order.invitation_relation
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_invitation_relation();
CREATE FUNCTION zzsh_order.guard_distribution_participant() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE policy jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'participant provenance cannot be deleted' USING ERRCODE='40001';END IF;
 IF TG_OP='INSERT' AND current_user IN('zzsh_m2_auth_compat_r','zzsh_m2_auth_compat_ui_r') AND(
  NEW.source_type<>'NATIVE_REGISTRATION' OR NEW.source_ref<>'registration:'||NEW.user_id
  OR NEW.invitees_knowledge<>'KNOWN' OR NOT EXISTS(SELECT 1 FROM zzsh_auth_user."user" u WHERE u.id=NEW.user_id
   AND u.xmin::text=(pg_current_xact_id()::text::numeric%4294967296)::text))
 THEN RAISE EXCEPTION 'runtime participant requires native registration provenance' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' AND NEW.revision<>1 OR TG_OP='UPDATE' AND(
  NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.source_type IS DISTINCT FROM OLD.source_type
  OR NEW.source_ref IS DISTINCT FROM OLD.source_ref OR NEW.source_digest IS DISTINCT FROM OLD.source_digest
  OR NEW.revision<>OLD.revision+1 OR NEW.inviter_knowledge IS DISTINCT FROM OLD.inviter_knowledge
  OR OLD.leader_knowledge='KNOWN_PARENT' AND NEW.leader_knowledge<>'KNOWN_PARENT')
 THEN RAISE EXCEPTION 'participant requires exact next revision and immutable original provenance' USING ERRCODE='40001';END IF;
 IF NEW.policy_version_id IS NOT NULL THEN
  SELECT canonical_config::jsonb INTO policy FROM zzsh_order.distribution_policy_version WHERE id=NEW.policy_version_id;
  IF policy IS NULL OR NEW.level_code IS NOT NULL AND NOT EXISTS(
   SELECT 1 FROM jsonb_array_elements(policy->'levels') level WHERE level->>'code'=NEW.level_code)
  THEN RAISE EXCEPTION 'participant level has no exact policy source' USING ERRCODE='23514';END IF;
  IF NEW.eligibility='ELIGIBLE' AND policy->'enabled' IS DISTINCT FROM 'true'::jsonb
  THEN RAISE EXCEPTION 'disabled policy cannot admit an eligible participant' USING ERRCODE='23514';END IF;
 ELSIF NEW.level_code IS NOT NULL THEN RAISE EXCEPTION 'level has no policy source' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER distribution_participant_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_order.distribution_participant
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_distribution_participant();
CREATE FUNCTION zzsh_order.check_distribution_relation_knowledge() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE subject text;p zzsh_order.distribution_participant;inviter_count integer;leader_count integer;
BEGIN
 IF TG_TABLE_NAME='distribution_participant' THEN subject:=NEW.user_id;
 ELSIF TG_TABLE_NAME='invitation_relation' THEN subject:=NEW.child_user_id;
 ELSE RAISE EXCEPTION 'unadmitted relation knowledge trigger table' USING ERRCODE='23514';END IF;
 SELECT * INTO p FROM zzsh_order.distribution_participant WHERE user_id=subject;
 SELECT count(*) FILTER(WHERE type='INVITER'),count(*) FILTER(WHERE type='DISTRIBUTION_LEADER')
  INTO inviter_count,leader_count FROM zzsh_order.invitation_relation WHERE child_user_id=subject;
 IF p.user_id IS NULL OR (p.inviter_knowledge='KNOWN_PARENT') IS DISTINCT FROM (inviter_count=1)
  OR (p.leader_knowledge='KNOWN_PARENT') IS DISTINCT FROM (leader_count=1)
 THEN RAISE EXCEPTION 'invitation relation and participant knowledge disagree' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER distribution_participant_knowledge_guard AFTER INSERT OR UPDATE ON zzsh_order.distribution_participant
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_distribution_relation_knowledge();
CREATE CONSTRAINT TRIGGER invitation_relation_knowledge_guard AFTER INSERT ON zzsh_order.invitation_relation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_distribution_relation_knowledge();
CREATE FUNCTION zzsh_order.guard_native_invitation_source() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p zzsh_order.distribution_participant;
BEGIN
 IF NEW.source_type='NATIVE_REGISTRATION' THEN
  IF NOT EXISTS(SELECT 1 FROM zzsh_auth_user."user" u WHERE u.id=NEW.child_user_id
   AND u.xmin::text=(pg_current_xact_id()::text::numeric%4294967296)::text)
  THEN RAISE EXCEPTION 'native relation requires current registration transaction' USING ERRCODE='23514';END IF;
  SELECT * INTO p FROM zzsh_order.distribution_participant WHERE user_id=NEW.child_user_id;
  IF p.source_type IS DISTINCT FROM 'NATIVE_REGISTRATION' OR NEW.source_ref IS DISTINCT FROM p.source_ref
   OR NEW.source_digest IS DISTINCT FROM p.source_digest
  THEN RAISE EXCEPTION 'native relation has different registration provenance' USING ERRCODE='23514';END IF;
 ELSIF NEW.type='INVITER' AND NEW.source_type='LOCAL_CONTROLLED' THEN
  RAISE EXCEPTION 'self-service cannot overwrite registration inviter' USING ERRCODE='23514';
 END IF;RETURN NEW;
END $$;
CREATE TRIGGER invitation_relation_source_guard BEFORE INSERT ON zzsh_order.invitation_relation
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_native_invitation_source();
-- Explicit permission definitions only; no grant, policy, participant or relation DML.
INSERT INTO zzsh_iam.admin_permission(code,name,description) VALUES
 ('personal.distribution.policy.read','分销政策读取','读取受权分销经营政策及不可变版本'),
 ('personal.distribution.policy.manage','分销政策配置','版本化编辑受权分销经营政策，不授予资金写权限');


