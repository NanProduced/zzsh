-- An explicitly requested new Team can belong to either native or imported order evidence.
-- A legacy order never receives a synthetic native payment confirmation.
ALTER TABLE zzsh_order.im_order_group
  ALTER COLUMN payment_confirmation_id DROP NOT NULL,
  ADD COLUMN legacy_order_id text REFERENCES zzsh_order.legacy_order_read_snapshot(id),
  ADD CONSTRAINT im_order_group_source_binding CHECK (
    (legacy_order_id IS NULL AND payment_confirmation_id IS NOT NULL)
    OR (legacy_order_id IS NOT NULL AND legacy_order_id=order_id AND payment_confirmation_id IS NULL)
  );
--> statement-breakpoint
ALTER TABLE zzsh_order.im_order_activity DROP CONSTRAINT im_order_activity_order_fk,
  ADD CONSTRAINT im_order_activity_order_fk FOREIGN KEY (order_id) REFERENCES zzsh_order.im_order_group(order_id);
--> statement-breakpoint
ALTER TABLE zzsh_order.im_order_unread DROP CONSTRAINT im_order_unread_order_fk,
  ADD CONSTRAINT im_order_unread_order_fk FOREIGN KEY (order_id) REFERENCES zzsh_order.im_order_group(order_id);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION zzsh_order.guard_order_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE m zzsh_iam.im_identity_mapping%ROWTYPE; g zzsh_order.im_order_group%ROWTYPE; renter text; owner_id text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'member association retained' USING ERRCODE='40001'; END IF;
  IF TG_OP='UPDATE' AND ((NEW.order_id,NEW.app_id,NEW.identity_id,NEW.party) IS DISTINCT FROM (OLD.order_id,OLD.app_id,OLD.identity_id,OLD.party)
      OR OLD.state='JOINED') THEN RAISE EXCEPTION 'member binding is immutable' USING ERRCODE='40001'; END IF;
  SELECT * INTO m FROM zzsh_iam.im_identity_mapping WHERE id=NEW.identity_id;
  SELECT * INTO g FROM zzsh_order.im_order_group WHERE order_id=NEW.order_id;
  IF g.legacy_order_id IS NULL THEN
    SELECT renter_user_id,owner_user_id INTO renter,owner_id FROM zzsh_order.rental_order WHERE id=NEW.order_id;
  ELSE
    SELECT renter_user_id,owner_user_id INTO renter,owner_id FROM zzsh_order.legacy_order_read_snapshot WHERE id=g.legacy_order_id;
  END IF;
  IF renter IS NULL OR owner_id IS NULL OR m.app_id IS DISTINCT FROM NEW.app_id OR m.status IS DISTINCT FROM 'READY'
    OR (NEW.party='BUYER' AND (m.realm IS DISTINCT FROM 'user' OR m.identity_kind IS DISTINCT FROM 'USER' OR m.platform_subject_id IS DISTINCT FROM renter))
    OR (NEW.party='OWNER' AND (m.realm IS DISTINCT FROM 'user' OR m.identity_kind IS DISTINCT FROM 'USER' OR m.platform_subject_id IS DISTINCT FROM owner_id))
    OR (NEW.party='STAFF' AND (m.realm IS DISTINCT FROM 'admin' OR m.identity_kind IS DISTINCT FROM 'ADMIN'
        OR (g.team_state<>'READY' AND m.platform_subject_id IS DISTINCT FROM g.assigned_admin_id))) THEN
    RAISE EXCEPTION 'member identity or order party mismatch' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
