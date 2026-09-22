-- OIM-4C-1: same-team reminder, staff add and system notice operations.
ALTER TABLE zzsh_order.im_order_group
  ADD COLUMN responsible_admin_id text REFERENCES zzsh_auth_admin."user"(id),
  ADD COLUMN remind_due_at timestamptz,
  ADD COLUMN next_add_due_at timestamptz,
  ADD COLUMN add_round integer NOT NULL DEFAULT 0 CHECK (add_round >= 0),
  ADD COLUMN escalation_state text NOT NULL DEFAULT 'NOT_STARTED'
    CHECK (escalation_state IN ('NOT_STARTED','RUNNING','STOPPED','EXHAUSTED','VERIFY_REQUIRED'));

-- Existing assignments remain historical facts; they do not acquire a timer.
UPDATE zzsh_order.im_order_group
   SET responsible_admin_id=assigned_admin_id, version=version+1
 WHERE provision_state='ASSIGNED' AND responsible_admin_id IS NULL;
-- Flush the existing deferred READY guards before altering this table again.
SET CONSTRAINTS ALL IMMEDIATE;

ALTER TABLE zzsh_order.im_order_group
  ADD CONSTRAINT im_order_escalation_running_shape CHECK (
    escalation_state<>'RUNNING' OR
      (team_state='READY' AND first_response_state='RUNNING' AND responsible_admin_id IS NOT NULL)),
  ADD CONSTRAINT im_order_responsible_ready_shape CHECK (team_state<>'READY' OR responsible_admin_id IS NOT NULL),
  ADD CONSTRAINT im_order_escalation_inactive_due_shape CHECK (
    escalation_state IN ('RUNNING','NOT_STARTED') OR (remind_due_at IS NULL AND next_add_due_at IS NULL)),
  ADD CONSTRAINT im_order_escalation_not_started_shape CHECK (
    escalation_state<>'NOT_STARTED' OR (remind_due_at IS NULL AND next_add_due_at IS NULL));
SET CONSTRAINTS ALL DEFERRED;

CREATE INDEX im_order_group_reminder_due ON zzsh_order.im_order_group(escalation_state,remind_due_at,order_id)
  WHERE remind_due_at IS NOT NULL;
CREATE INDEX im_order_group_add_due ON zzsh_order.im_order_group(escalation_state,next_add_due_at,order_id)
  WHERE next_add_due_at IS NOT NULL;

-- Set initial responsibility in the original dispatch transaction, without changing
-- the already-frozen dispatcher SQL or the immutable assigned_admin_id fact.
CREATE FUNCTION zzsh_order.fill_order_responsible() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.provision_state='ASSIGNED' AND NEW.responsible_admin_id IS NULL THEN
    NEW.responsible_admin_id := NEW.assigned_admin_id;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER im_order_group_responsible_fill BEFORE INSERT OR UPDATE ON zzsh_order.im_order_group
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.fill_order_responsible();

ALTER TABLE zzsh_order.im_order_operation
  ADD COLUMN round integer NOT NULL DEFAULT 0 CHECK (round >= 0),
  ADD COLUMN target_admin_id text REFERENCES zzsh_auth_admin."user"(id);
ALTER TABLE zzsh_order.im_order_operation
  DROP CONSTRAINT im_order_operation_order_id_key,
  DROP CONSTRAINT im_order_operation_kind_check,
  DROP CONSTRAINT im_order_operation_state_check,
  DROP CONSTRAINT im_order_operation_check1,
  DROP CONSTRAINT im_order_operation_check2,
  ADD CONSTRAINT im_order_operation_kind_check CHECK (kind IN ('CREATE','ADD_MEMBER','BOT_NOTICE')),
  ADD CONSTRAINT im_order_operation_state_check CHECK (state IN ('PENDING','RUNNING','NEEDS_REVIEW','SUCCEEDED','CANCELLED')),
  ADD CONSTRAINT im_order_operation_round_target CHECK (
    (kind='CREATE' AND round=0 AND target_admin_id IS NULL)
    OR (kind='ADD_MEMBER' AND round>=1 AND target_admin_id IS NOT NULL)
    OR (kind='BOT_NOTICE' AND round>=1 AND target_admin_id IS NULL)),
  ADD CONSTRAINT im_order_operation_candidate_shape CHECK (
    candidate_team_id IS NULL OR (sent_at IS NOT NULL AND kind IN ('CREATE','ADD_MEMBER'))),
  ADD CONSTRAINT im_order_operation_success_shape CHECK (
    state<>'SUCCEEDED' OR
      (kind IN ('CREATE','ADD_MEMBER') AND candidate_team_id IS NOT NULL)
      OR (kind='BOT_NOTICE' AND candidate_team_id IS NULL)),
  ADD CONSTRAINT im_order_operation_pending_unsent CHECK (
    state<>'PENDING' OR sent_at IS NULL);

CREATE UNIQUE INDEX im_order_operation_create_unique ON zzsh_order.im_order_operation(order_id) WHERE kind='CREATE';
CREATE UNIQUE INDEX im_order_operation_round_unique ON zzsh_order.im_order_operation(order_id,kind,round)
  WHERE kind IN ('ADD_MEMBER','BOT_NOTICE');
CREATE UNIQUE INDEX im_order_operation_unresolved_structure_unique ON zzsh_order.im_order_operation(order_id)
  WHERE kind IN ('CREATE','ADD_MEMBER') AND state IN ('PENDING','RUNNING','NEEDS_REVIEW');
CREATE INDEX im_order_operation_escalation_due ON zzsh_order.im_order_operation(app_id,kind,state,next_retry_at,order_id)
  WHERE kind IN ('ADD_MEMBER','BOT_NOTICE');

CREATE OR REPLACE FUNCTION zzsh_order.guard_order_operation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE allowed boolean := false;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'operation evidence retained' USING ERRCODE='40001'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.state<>'PENDING' OR NEW.sent_at IS NOT NULL OR NEW.candidate_team_id IS NOT NULL
      OR NEW.version<>1 OR NEW.attempt_count<>0 THEN
      RAISE EXCEPTION 'invalid operation initial state' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id,NEW.order_id,NEW.app_id,NEW.kind,NEW.round,NEW.target_admin_id,NEW.created_at)
       IS DISTINCT FROM
     (OLD.id,OLD.order_id,OLD.app_id,OLD.kind,OLD.round,OLD.target_admin_id,OLD.created_at)
    OR OLD.state IN ('SUCCEEDED','CANCELLED')
    OR (OLD.sent_at IS NOT NULL AND NEW.sent_at IS DISTINCT FROM OLD.sent_at)
    OR (OLD.candidate_team_id IS NOT NULL AND NEW.candidate_team_id IS DISTINCT FROM OLD.candidate_team_id)
    OR NEW.version<OLD.version OR (NEW.state='PENDING' AND NEW.sent_at IS NOT NULL) THEN
    RAISE EXCEPTION 'operation evidence is immutable' USING ERRCODE='40001';
  END IF;
  IF NEW.state IS DISTINCT FROM OLD.state THEN
    IF NEW.state='CANCELLED' THEN
      allowed := OLD.kind IN ('ADD_MEMBER','BOT_NOTICE') AND OLD.sent_at IS NULL
        AND OLD.state IN ('PENDING','RUNNING') AND NEW.version=OLD.version+1;
    ELSIF OLD.kind='CREATE' THEN
      allowed := (OLD.state='PENDING' AND NEW.state='RUNNING')
        OR (OLD.state='RUNNING' AND NEW.state IN ('PENDING','NEEDS_REVIEW','SUCCEEDED'))
        OR (OLD.state='NEEDS_REVIEW' AND NEW.state='RUNNING' AND OLD.candidate_team_id IS NOT NULL);
    ELSIF OLD.kind='ADD_MEMBER' THEN
      allowed := (OLD.state='PENDING' AND NEW.state='RUNNING')
        OR (OLD.state='RUNNING' AND NEW.state IN ('PENDING','NEEDS_REVIEW','SUCCEEDED'))
        OR (OLD.state='NEEDS_REVIEW' AND NEW.state='RUNNING' AND OLD.sent_at IS NOT NULL);
    ELSE
      allowed := (OLD.state='PENDING' AND NEW.state='RUNNING')
        OR (OLD.state='RUNNING' AND NEW.state IN ('NEEDS_REVIEW','SUCCEEDED'));
    END IF;
    IF NOT allowed THEN RAISE EXCEPTION 'invalid operation transition' USING ERRCODE='40001'; END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.check_order_team_ready() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.team_state='READY' AND (
    NOT EXISTS(SELECT 1 FROM zzsh_order.im_order_operation WHERE order_id=NEW.order_id AND kind='CREATE'
      AND state='SUCCEEDED' AND candidate_team_id=NEW.team_id)
    OR (SELECT count(*) FROM zzsh_order.im_order_member WHERE order_id=NEW.order_id AND state='JOINED' AND party IN ('BUYER','OWNER'))<>2
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.im_order_member mm JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id
      WHERE mm.order_id=NEW.order_id AND mm.state='JOINED' AND mm.party='STAFF' AND m.platform_subject_id=NEW.assigned_admin_id)
  ) THEN RAISE EXCEPTION 'READY requires successful CREATE and joined parties' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.check_order_operation_success() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.state='SUCCEEDED' AND NEW.kind='CREATE' AND NOT EXISTS (
    SELECT 1 FROM zzsh_order.im_order_group WHERE order_id=NEW.order_id AND app_id=NEW.app_id
      AND team_state='READY' AND team_id=NEW.candidate_team_id
  ) THEN RAISE EXCEPTION 'CREATE success requires READY binding' USING ERRCODE='23514'; END IF;
  IF NEW.state='SUCCEEDED' AND NEW.kind='ADD_MEMBER' AND NOT EXISTS (
    SELECT 1 FROM zzsh_order.im_order_group g JOIN zzsh_order.im_order_member mm ON mm.order_id=g.order_id
    JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id AND m.app_id=g.app_id
      WHERE g.order_id=NEW.order_id AND g.app_id=NEW.app_id AND g.team_state='READY'
        AND g.team_id=NEW.candidate_team_id AND mm.party='STAFF' AND mm.state='JOINED'
        AND m.realm='admin' AND m.identity_kind='ADMIN' AND m.platform_subject_id=NEW.target_admin_id
  ) THEN RAISE EXCEPTION 'ADD success requires joined target in READY Team' USING ERRCODE='23514'; END IF;
  IF NEW.state='SUCCEEDED' AND NEW.kind='BOT_NOTICE' AND NEW.sent_at IS NULL THEN
    RAISE EXCEPTION 'BOT success requires a sent notice' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;

CREATE FUNCTION zzsh_order.guard_order_responsible() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.responsible_admin_id IS DISTINCT FROM OLD.responsible_admin_id THEN
    IF OLD.responsible_admin_id IS NULL AND OLD.assigned_admin_id IS NULL
      AND NEW.provision_state='ASSIGNED' AND NEW.responsible_admin_id=NEW.assigned_admin_id THEN
      RETURN NEW;
    END IF;
    IF NEW.responsible_admin_id IS NULL OR NOT EXISTS (
      SELECT 1 FROM zzsh_order.im_order_operation op JOIN zzsh_order.im_order_member mm ON mm.order_id=op.order_id
      JOIN zzsh_iam.im_identity_mapping m ON m.id=mm.identity_id AND m.app_id=op.app_id
       WHERE op.order_id=NEW.order_id AND op.app_id=NEW.app_id AND op.kind='ADD_MEMBER'
         AND op.state='SUCCEEDED' AND op.target_admin_id=NEW.responsible_admin_id
         AND op.candidate_team_id=NEW.team_id AND mm.party='STAFF' AND mm.state='JOINED'
         AND m.realm='admin' AND m.identity_kind='ADMIN' AND m.platform_subject_id=NEW.responsible_admin_id
    ) THEN RAISE EXCEPTION 'responsible change requires a confirmed ADD member' USING ERRCODE='40001'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER im_order_group_responsible_guard BEFORE UPDATE OF responsible_admin_id ON zzsh_order.im_order_group
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_order_responsible();

ALTER TABLE zzsh_order.im_order_event
  ADD COLUMN related_operation_id text REFERENCES zzsh_order.im_order_operation(id);
ALTER TABLE zzsh_order.im_order_event
  DROP CONSTRAINT im_order_event_type_check,
  DROP CONSTRAINT im_order_event_check,
  DROP CONSTRAINT im_order_event_check1,
  ADD CONSTRAINT im_order_event_type_check CHECK (type IN (
    'send_approved','message_delivered','first_response','verify_required',
    'first_response_reminder','add_member','bot_notice','staff_exhausted')),
  ADD CONSTRAINT im_order_event_status_check CHECK (
    (type='send_approved' AND status IN ('VERIFIED','REJECTED'))
    OR (type='message_delivered' AND status IN ('WAITING_AUTH','VERIFIED','REJECTED','VERIFY_REQUIRED'))
    OR (type='first_response' AND status='VERIFIED')
    OR (type='verify_required' AND status='VERIFY_REQUIRED')
    OR (type='first_response_reminder' AND status='RECORDED')
    OR (type IN ('add_member','bot_notice') AND status='PLANNED')
    OR (type='staff_exhausted' AND status='EXHAUSTED')),
  ADD CONSTRAINT im_order_event_body_shape CHECK (
    type='verify_required'
    OR (type IN ('first_response_reminder','add_member','bot_notice','staff_exhausted') AND raw_body_sha256 IS NULL)
    OR (type IN ('send_approved','message_delivered','first_response') AND raw_body_sha256 IS NOT NULL));

CREATE INDEX im_order_event_order_type ON zzsh_order.im_order_event(order_id,type,recorded_at);

CREATE OR REPLACE FUNCTION zzsh_order.guard_order_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'order event evidence retained' USING ERRCODE='40001'; END IF;
  IF (NEW.id,NEW.order_id,NEW.app_id,NEW.team_id,NEW.event_key,NEW.type,NEW.actor,NEW.message_client_id,NEW.message_server_id,
      NEW.sender_account_id,NEW.message_type,NEW.occurred_at,NEW.recorded_at,NEW.raw_body_sha256,NEW.metadata,NEW.related_operation_id) IS DISTINCT FROM
     (OLD.id,OLD.order_id,OLD.app_id,OLD.team_id,OLD.event_key,OLD.type,OLD.actor,OLD.message_client_id,OLD.message_server_id,
      OLD.sender_account_id,OLD.message_type,OLD.occurred_at,OLD.recorded_at,OLD.raw_body_sha256,OLD.metadata,OLD.related_operation_id) THEN
    RAISE EXCEPTION 'order event binding is immutable' USING ERRCODE='40001'; END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    OLD.type='message_delivered' AND OLD.status='WAITING_AUTH' AND NEW.status IN ('VERIFIED','REJECTED','VERIFY_REQUIRED')
  ) THEN RAISE EXCEPTION 'invalid order event transition' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;
