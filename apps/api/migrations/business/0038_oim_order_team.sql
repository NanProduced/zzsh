-- Reliable CREATE only; assignment, payment and occupancy remain independent.
ALTER TABLE zzsh_iam.im_identity_mapping ADD CONSTRAINT im_identity_id_app_unique UNIQUE(id,app_id);
ALTER TABLE zzsh_order.im_order_group
  ADD CONSTRAINT im_order_id_app_unique UNIQUE(order_id,app_id),
  ADD COLUMN team_state text NOT NULL DEFAULT 'PENDING' CHECK(team_state IN ('PENDING','IDENTITY_PENDING','CREATING','READY','NEEDS_REVIEW')),
  ADD COLUMN system_identity_id text,
  ADD COLUMN team_name text CHECK(char_length(team_name) BETWEEN 1 AND 64),
  ADD COLUMN members_limit integer CHECK(members_limit BETWEEN 4 AND 5000),
  ADD COLUMN team_id text CHECK(team_id ~ '^[0-9]{1,19}$'),
  ADD COLUMN team_ready_at timestamptz,
  ADD COLUMN team_failure text CHECK(team_failure ~ '^[A-Z_]{1,64}$'),
  ADD COLUMN team_retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  ADD CONSTRAINT im_order_system_fk FOREIGN KEY(system_identity_id,app_id) REFERENCES zzsh_iam.im_identity_mapping(id,app_id),
  ADD CONSTRAINT im_order_team_shape CHECK (
    (team_state<>'READY' AND team_id IS NULL AND team_ready_at IS NULL)
    OR (team_state='READY' AND team_id IS NOT NULL AND team_ready_at IS NOT NULL)),
  ADD CONSTRAINT im_order_plan_shape CHECK(team_state NOT IN ('CREATING','READY') OR
    (provision_state='ASSIGNED' AND system_identity_id IS NOT NULL AND team_name IS NOT NULL AND members_limit IS NOT NULL));
CREATE UNIQUE INDEX im_order_team_unique ON zzsh_order.im_order_group(app_id,team_id) WHERE team_id IS NOT NULL;

CREATE TABLE zzsh_order.im_order_member (
  order_id text NOT NULL, app_id text NOT NULL, identity_id text NOT NULL,
  party text NOT NULL CHECK(party IN ('BUYER','OWNER','STAFF')),
  state text NOT NULL DEFAULT 'PLANNED' CHECK(state IN ('PLANNED','JOINED')),
  joined_at timestamptz,
  PRIMARY KEY(order_id,identity_id),
  FOREIGN KEY(order_id,app_id) REFERENCES zzsh_order.im_order_group(order_id,app_id),
  FOREIGN KEY(identity_id,app_id) REFERENCES zzsh_iam.im_identity_mapping(id,app_id),
  CHECK((state='PLANNED' AND joined_at IS NULL) OR (state='JOINED' AND joined_at IS NOT NULL))
);
CREATE UNIQUE INDEX im_order_one_buyer ON zzsh_order.im_order_member(order_id) WHERE party='BUYER';
CREATE UNIQUE INDEX im_order_one_owner ON zzsh_order.im_order_member(order_id) WHERE party='OWNER';
CREATE TABLE zzsh_order.im_order_operation (
  id text PRIMARY KEY, order_id text NOT NULL UNIQUE, app_id text NOT NULL,
  kind text NOT NULL DEFAULT 'CREATE' CHECK(kind='CREATE'),
  state text NOT NULL DEFAULT 'PENDING' CHECK(state IN ('PENDING','RUNNING','NEEDS_REVIEW','SUCCEEDED')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0), attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count>=0),
  next_retry_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  lease_until timestamptz, lease_token_hash text, sent_at timestamptz,
  candidate_team_id text CHECK(candidate_team_id ~ '^[0-9]{1,19}$'),
  failure_class text CHECK(failure_class ~ '^[A-Z_]{1,64}$'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY(order_id,app_id) REFERENCES zzsh_order.im_order_group(order_id,app_id),
  CHECK((state='RUNNING' AND lease_until IS NOT NULL AND lease_token_hash IS NOT NULL)
    OR (state<>'RUNNING' AND lease_until IS NULL AND lease_token_hash IS NULL)),
  CHECK(candidate_team_id IS NULL OR sent_at IS NOT NULL),
  CHECK(state<>'SUCCEEDED' OR candidate_team_id IS NOT NULL)
);
CREATE INDEX im_order_operation_due ON zzsh_order.im_order_operation(app_id,state,next_retry_at);

CREATE OR REPLACE FUNCTION zzsh_order.guard_im_order_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE system_row zzsh_iam.im_identity_mapping%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'order intent cannot be deleted' USING ERRCODE='40001'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.provision_state<>'WAITING' OR NEW.version<>1 OR NEW.wait_reason IS NOT NULL OR NEW.team_state<>'PENDING'
      OR NEW.system_identity_id IS NOT NULL OR NEW.team_name IS NOT NULL OR NEW.members_limit IS NOT NULL THEN
      RAISE EXCEPTION 'order intent must start unassigned' USING ERRCODE='40001'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.order_id,NEW.payment_confirmation_id,NEW.app_id,NEW.created_at) IS DISTINCT FROM
    (OLD.order_id,OLD.payment_confirmation_id,OLD.app_id,OLD.created_at) OR NEW.version<>OLD.version+1
    OR (OLD.provision_state='ASSIGNED' AND (NEW.provision_state,NEW.assigned_admin_id,NEW.assigned_at) IS DISTINCT FROM (OLD.provision_state,OLD.assigned_admin_id,OLD.assigned_at))
    OR (OLD.team_name IS NOT NULL AND (NEW.team_name,NEW.system_identity_id,NEW.members_limit) IS DISTINCT FROM (OLD.team_name,OLD.system_identity_id,OLD.members_limit))
    OR (OLD.team_id IS NOT NULL AND (NEW.team_id,NEW.team_state,NEW.team_ready_at) IS DISTINCT FROM (OLD.team_id,OLD.team_state,OLD.team_ready_at)) THEN
    RAISE EXCEPTION 'order binding is immutable' USING ERRCODE='40001';
  END IF;
  IF NEW.provision_state='WAITING' AND NEW.team_state<>'PENDING' THEN RAISE EXCEPTION 'unassigned Team' USING ERRCODE='23514'; END IF;
  IF NEW.system_identity_id IS NOT NULL THEN
    SELECT * INTO system_row FROM zzsh_iam.im_identity_mapping WHERE id=NEW.system_identity_id;
    IF system_row.app_id IS DISTINCT FROM NEW.app_id OR system_row.identity_kind IS DISTINCT FROM 'SYSTEM'
      OR system_row.realm IS DISTINCT FROM 'system' OR system_row.platform_subject_id IS DISTINCT FROM 'support-manager' THEN
      RAISE EXCEPTION 'wrong SYSTEM identity' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE FUNCTION zzsh_order.guard_order_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m zzsh_iam.im_identity_mapping%ROWTYPE; o zzsh_order.rental_order%ROWTYPE; g zzsh_order.im_order_group%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'member association retained' USING ERRCODE='40001'; END IF;
  IF TG_OP='UPDATE' AND ((NEW.order_id,NEW.app_id,NEW.identity_id,NEW.party) IS DISTINCT FROM (OLD.order_id,OLD.app_id,OLD.identity_id,OLD.party)
      OR OLD.state='JOINED') THEN RAISE EXCEPTION 'member binding is immutable' USING ERRCODE='40001'; END IF;
  SELECT * INTO m FROM zzsh_iam.im_identity_mapping WHERE id=NEW.identity_id;
  SELECT * INTO o FROM zzsh_order.rental_order WHERE id=NEW.order_id;
  SELECT * INTO g FROM zzsh_order.im_order_group WHERE order_id=NEW.order_id;
  IF m.app_id IS DISTINCT FROM NEW.app_id OR m.status IS DISTINCT FROM 'READY'
    OR (NEW.party='BUYER' AND (m.realm<>'user' OR m.identity_kind<>'USER' OR m.platform_subject_id<>o.renter_user_id))
    OR (NEW.party='OWNER' AND (m.realm<>'user' OR m.identity_kind<>'USER' OR m.platform_subject_id<>o.owner_user_id))
    OR (NEW.party='STAFF' AND (m.realm<>'admin' OR m.identity_kind<>'ADMIN'
        OR (g.team_state<>'READY' AND m.platform_subject_id<>g.assigned_admin_id))) THEN
    RAISE EXCEPTION 'member identity or order party mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER im_order_member_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_order.im_order_member FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_order_member();
CREATE FUNCTION zzsh_order.guard_order_operation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'operation evidence retained' USING ERRCODE='40001'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'PENDING' OR NEW.sent_at IS NOT NULL OR NEW.candidate_team_id IS NOT NULL OR NEW.version<>1 THEN
      RAISE EXCEPTION 'invalid CREATE initial state' USING ERRCODE='23514'; END IF;
  ELSE
    IF (NEW.id,NEW.order_id,NEW.app_id,NEW.kind,NEW.created_at) IS DISTINCT FROM (OLD.id,OLD.order_id,OLD.app_id,OLD.kind,OLD.created_at)
      OR OLD.state='SUCCEEDED' OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
      OR (OLD.candidate_team_id IS NOT NULL AND NEW.candidate_team_id IS DISTINCT FROM OLD.candidate_team_id)
      OR NEW.version<OLD.version OR (NEW.state='PENDING' AND NEW.sent_at IS NOT NULL) THEN
      RAISE EXCEPTION 'CREATE evidence is immutable' USING ERRCODE='40001'; END IF;
    IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
      (OLD.state='PENDING' AND NEW.state='RUNNING')
      OR (OLD.state='RUNNING' AND NEW.state IN ('PENDING','NEEDS_REVIEW','SUCCEEDED'))
      OR (OLD.state='NEEDS_REVIEW' AND NEW.state='RUNNING' AND OLD.candidate_team_id IS NOT NULL)
    ) THEN RAISE EXCEPTION 'invalid CREATE transition' USING ERRCODE='40001'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER im_order_operation_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_order.im_order_operation FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_order_operation();

CREATE FUNCTION zzsh_order.check_order_team_ready() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.team_state='READY' AND (
    NOT EXISTS(SELECT 1 FROM zzsh_order.im_order_operation WHERE order_id=NEW.order_id AND state='SUCCEEDED' AND candidate_team_id=NEW.team_id)
    OR (SELECT count(*) FROM zzsh_order.im_order_member WHERE order_id=NEW.order_id AND state='JOINED' AND party IN ('BUYER','OWNER'))<>2
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id
      WHERE mm.order_id=NEW.order_id AND mm.state='JOINED' AND mm.party='STAFF' AND m.platform_subject_id=NEW.assigned_admin_id)
  ) THEN RAISE EXCEPTION 'READY requires successful operation and joined parties' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER im_order_team_ready_guard AFTER UPDATE ON zzsh_order.im_order_group DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_order_team_ready();

CREATE FUNCTION zzsh_order.check_order_member_joined() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='JOINED' AND NOT EXISTS(SELECT 1 FROM zzsh_order.im_order_group WHERE order_id=NEW.order_id AND team_state='READY') THEN
    RAISE EXCEPTION 'JOINED requires a READY Team' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER im_order_member_joined_guard AFTER INSERT OR UPDATE ON zzsh_order.im_order_member DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_order_member_joined();
CREATE FUNCTION zzsh_order.check_order_operation_success() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='SUCCEEDED' AND NOT EXISTS(SELECT 1 FROM zzsh_order.im_order_group WHERE order_id=NEW.order_id AND team_state='READY' AND team_id=NEW.candidate_team_id) THEN
    RAISE EXCEPTION 'CREATE success requires READY binding' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER im_order_operation_success_guard AFTER UPDATE ON zzsh_order.im_order_operation DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_order_operation_success();
