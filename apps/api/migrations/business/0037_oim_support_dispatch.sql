-- Local assignment only: no Team, member, provider operation or reception timer.
ALTER TABLE zzsh_iam.im_support_presence DROP COLUMN capacity,
  ADD COLUMN last_order_assigned_at timestamptz,
  ADD COLUMN last_consultation_assigned_at timestamptz;
CREATE OR REPLACE FUNCTION zzsh_iam.guard_im_support_presence_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.admin_user_id,NEW.app_id) IS DISTINCT FROM (OLD.admin_user_id,OLD.app_id) THEN
    RAISE EXCEPTION 'presence identity is immutable' USING ERRCODE='40001';
  END IF;
  IF NEW.active_load < 0 THEN RAISE EXCEPTION 'negative consultation load' USING ERRCODE='40001'; END IF;
  IF (NEW.last_order_assigned_at,NEW.last_consultation_assigned_at) IS DISTINCT FROM
     (OLD.last_order_assigned_at,OLD.last_consultation_assigned_at) AND NEW.version <> OLD.version THEN
    RAISE EXCEPTION 'assignment must not change presence connection version' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
DROP INDEX IF EXISTS zzsh_iam.im_support_presence_available_idx;
DROP INDEX IF EXISTS zzsh_iam.im_support_presence_app_available_idx;
CREATE INDEX im_support_order_rotation ON zzsh_iam.im_support_presence(app_id,last_order_assigned_at,admin_user_id);
CREATE INDEX im_support_consultation_rotation ON zzsh_iam.im_support_presence(app_id,last_consultation_assigned_at,admin_user_id);

ALTER TABLE zzsh_order.im_order_group
  DROP CONSTRAINT im_order_group_provision_state_check,
  ADD COLUMN assigned_admin_id text REFERENCES zzsh_auth_admin."user"(id),
  ADD COLUMN assigned_at timestamptz,
  ADD COLUMN version bigint NOT NULL DEFAULT 1 CHECK (version>0),
  ADD COLUMN wait_reason text CHECK (wait_reason IN ('NO_ELIGIBLE_STAFF')),
  ADD CONSTRAINT im_order_group_assignment_shape CHECK (
    (provision_state='WAITING' AND assigned_admin_id IS NULL AND assigned_at IS NULL)
    OR (provision_state='ASSIGNED' AND assigned_admin_id IS NOT NULL AND assigned_at IS NOT NULL AND wait_reason IS NULL));
CREATE INDEX im_order_dispatch_waiting ON zzsh_order.im_order_group(app_id,created_at,order_id) WHERE provision_state='WAITING';
CREATE FUNCTION zzsh_order.guard_im_order_dispatch() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'order waiting intent cannot be deleted' USING ERRCODE='40001'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.provision_state<>'WAITING' OR NEW.version<>1 OR NEW.wait_reason IS NOT NULL THEN
      RAISE EXCEPTION 'order intent must start unassigned' USING ERRCODE='40001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.order_id,NEW.payment_confirmation_id,NEW.app_id,NEW.created_at) IS DISTINCT FROM
     (OLD.order_id,OLD.payment_confirmation_id,OLD.app_id,OLD.created_at)
     OR OLD.provision_state<>'WAITING' OR NEW.version<>OLD.version+1 THEN
    RAISE EXCEPTION 'order dispatch binding or transition is invalid' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER im_order_group_immutable ON zzsh_order.im_order_group;
CREATE TRIGGER im_order_group_dispatch_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_order.im_order_group
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_im_order_dispatch();
