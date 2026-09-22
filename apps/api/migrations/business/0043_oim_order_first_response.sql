-- OIM-4B: authoritative supplier message events and first-response facts.
-- Additive only: existing group/operation/member columns and constraints stay untouched.
ALTER TABLE zzsh_order.im_order_group
  ADD COLUMN first_response_event_id text,
  ADD COLUMN first_response_at timestamptz,
  ADD COLUMN first_response_state text NOT NULL DEFAULT 'NOT_STARTED'
    CHECK(first_response_state IN ('NOT_STARTED','RUNNING','STOPPED','VERIFY_REQUIRED')),
  ADD CONSTRAINT im_order_first_response_shape CHECK (
    (first_response_state IN ('NOT_STARTED','RUNNING','VERIFY_REQUIRED') AND first_response_event_id IS NULL AND first_response_at IS NULL)
    OR (first_response_state='STOPPED' AND first_response_event_id IS NOT NULL AND first_response_at IS NOT NULL));

CREATE TABLE zzsh_order.im_order_event (
  id text PRIMARY KEY,
  order_id text NOT NULL,
  app_id text NOT NULL,
  team_id text NOT NULL CHECK(team_id ~ '^[0-9]{1,19}$'),
  event_key text NOT NULL CHECK(char_length(event_key) BETWEEN 1 AND 200),
  type text NOT NULL CHECK(type IN ('send_approved','message_delivered','first_response','verify_required')),
  status text NOT NULL CHECK (
    (type='send_approved' AND status IN ('VERIFIED','REJECTED'))
    OR (type='message_delivered' AND status IN ('WAITING_AUTH','VERIFIED','REJECTED','VERIFY_REQUIRED'))
    OR (type='first_response' AND status='VERIFIED')
    OR (type='verify_required' AND status='VERIFY_REQUIRED')),
  actor text,
  message_client_id text CHECK(message_client_id IS NULL OR char_length(message_client_id) BETWEEN 1 AND 128),
  message_server_id text CHECK(message_server_id IS NULL OR message_server_id ~ '^[0-9]{1,19}$'),
  sender_account_id text NOT NULL CHECK(char_length(sender_account_id) BETWEEN 1 AND 64),
  message_type text CHECK(message_type IN ('TEXT','PICTURE')),
  occurred_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  raw_body_sha256 text CHECK(raw_body_sha256 ~ '^[0-9a-f]{64}$'),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  FOREIGN KEY(order_id,app_id) REFERENCES zzsh_order.im_order_group(order_id,app_id),
  CHECK(type='first_response' OR raw_body_sha256 IS NOT NULL),
  CHECK(type<>'message_delivered' OR message_server_id IS NOT NULL),
  CHECK(type<>'send_approved' OR message_client_id IS NOT NULL)
);
ALTER TABLE zzsh_order.im_order_group
  ADD CONSTRAINT im_order_first_response_fk FOREIGN KEY(first_response_event_id) REFERENCES zzsh_order.im_order_event(id);

-- One delivery per provider message; approvals are idempotent per client id.
-- A corrected earlier first_response keeps its own event row, so no per-order unique here.
CREATE UNIQUE INDEX im_order_event_key ON zzsh_order.im_order_event(order_id,event_key);
CREATE UNIQUE INDEX im_order_event_delivery_unique ON zzsh_order.im_order_event(app_id,team_id,message_server_id) WHERE type='message_delivered';
CREATE UNIQUE INDEX im_order_event_approval_unique ON zzsh_order.im_order_event(app_id,team_id,sender_account_id,message_client_id) WHERE type='send_approved';
CREATE INDEX im_order_event_pending ON zzsh_order.im_order_event(type,status,recorded_at);

-- Evidence is append-only; only a delivery status may move WAITING_AUTH -> resolved.
CREATE FUNCTION zzsh_order.guard_order_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'order event evidence retained' USING ERRCODE='40001'; END IF;
  IF (NEW.id,NEW.order_id,NEW.app_id,NEW.team_id,NEW.event_key,NEW.type,NEW.message_client_id,NEW.message_server_id,
      NEW.sender_account_id,NEW.message_type,NEW.occurred_at,NEW.raw_body_sha256) IS DISTINCT FROM
     (OLD.id,OLD.order_id,OLD.app_id,OLD.team_id,OLD.event_key,OLD.type,OLD.message_client_id,OLD.message_server_id,
      OLD.sender_account_id,OLD.message_type,OLD.occurred_at,OLD.raw_body_sha256) THEN
    RAISE EXCEPTION 'order event binding is immutable' USING ERRCODE='40001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    OLD.type='message_delivered' AND OLD.status='WAITING_AUTH' AND NEW.status IN ('VERIFIED','REJECTED','VERIFY_REQUIRED')
  ) THEN RAISE EXCEPTION 'invalid order event transition' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER im_order_event_guard BEFORE UPDATE OR DELETE ON zzsh_order.im_order_event FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_order_event();
