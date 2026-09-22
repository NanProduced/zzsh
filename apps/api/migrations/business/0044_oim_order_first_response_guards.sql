-- OIM-4B-R1: first-response binding guards. 0043 stays frozen; this migration only
-- strengthens the event evidence guard and adds the group-level binding guard.
CREATE OR REPLACE FUNCTION zzsh_order.guard_order_event() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'order event evidence retained' USING ERRCODE='40001'; END IF;
  IF (NEW.id,NEW.order_id,NEW.app_id,NEW.team_id,NEW.event_key,NEW.type,NEW.actor,NEW.message_client_id,NEW.message_server_id,
      NEW.sender_account_id,NEW.message_type,NEW.occurred_at,NEW.recorded_at,NEW.raw_body_sha256,NEW.metadata) IS DISTINCT FROM
     (OLD.id,OLD.order_id,OLD.app_id,OLD.team_id,OLD.event_key,OLD.type,OLD.actor,OLD.message_client_id,OLD.message_server_id,
      OLD.sender_account_id,OLD.message_type,OLD.occurred_at,OLD.recorded_at,OLD.raw_body_sha256,OLD.metadata) THEN
    RAISE EXCEPTION 'order event binding is immutable' USING ERRCODE='40001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    OLD.type='message_delivered' AND OLD.status='WAITING_AUTH' AND NEW.status IN ('VERIFIED','REJECTED','VERIFY_REQUIRED')
  ) THEN RAISE EXCEPTION 'invalid order event transition' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;

-- A group may only point at a VERIFIED first-response event of the same App/order/team
-- that itself references a VERIFIED delivery; the time must equal the event time, may only
-- move earlier, and a STOPPED fact can never be cleared or reopened.
CREATE FUNCTION zzsh_order.guard_first_response_binding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_row zzsh_order.im_order_event%ROWTYPE;
BEGIN
  IF NEW.first_response_event_id IS NULL THEN
    IF TG_OP='UPDATE' AND OLD.first_response_state='STOPPED' THEN
      RAISE EXCEPTION 'stopped first response cannot be cleared' USING ERRCODE='40001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT * INTO event_row FROM zzsh_order.im_order_event WHERE id=NEW.first_response_event_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'first response event is missing' USING ERRCODE='40001'; END IF;
  IF event_row.type<>'first_response' OR event_row.status<>'VERIFIED'
    OR event_row.app_id<>NEW.app_id OR event_row.order_id<>NEW.order_id OR event_row.team_id<>NEW.team_id THEN
    RAISE EXCEPTION 'first response event binding mismatch' USING ERRCODE='40001';
  END IF;
  IF NEW.first_response_at IS DISTINCT FROM event_row.occurred_at THEN
    RAISE EXCEPTION 'first response time must equal its event time' USING ERRCODE='40001';
  END IF;
  IF event_row.message_server_id IS NULL OR NOT EXISTS (
    SELECT 1 FROM zzsh_order.im_order_event d WHERE d.type='message_delivered' AND d.status='VERIFIED'
      AND d.app_id=NEW.app_id AND d.team_id=NEW.team_id AND d.message_server_id=event_row.message_server_id) THEN
    RAISE EXCEPTION 'first response requires a verified delivery' USING ERRCODE='40001';
  END IF;
  IF TG_OP='UPDATE' AND OLD.first_response_event_id IS NOT NULL AND OLD.first_response_event_id<>NEW.first_response_event_id
    AND (OLD.first_response_at IS NULL OR NEW.first_response_at IS NULL OR NEW.first_response_at>=OLD.first_response_at) THEN
    RAISE EXCEPTION 'first response may only move to an earlier event' USING ERRCODE='40001';
  END IF;
  IF TG_OP='UPDATE' AND OLD.first_response_state='STOPPED' AND NEW.first_response_state<>'STOPPED' THEN
    RAISE EXCEPTION 'stopped first response cannot reopen' USING ERRCODE='40001';
  END IF;
  IF NEW.first_response_state='STOPPED' AND (NEW.first_response_event_id IS NULL OR NEW.first_response_at IS NULL) THEN
    RAISE EXCEPTION 'stopped first response requires evidence' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER im_order_group_first_response_guard BEFORE INSERT OR UPDATE ON zzsh_order.im_order_group
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_first_response_binding();
