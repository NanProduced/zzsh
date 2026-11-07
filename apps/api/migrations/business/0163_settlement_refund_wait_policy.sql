-- Configure only future settlement postings; existing refund due times stay unchanged.
CREATE TABLE zzsh_order.settlement_refund_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  normal_days integer NOT NULL DEFAULT 0 CHECK (normal_days BETWEEN 0 AND 365),
  early_days integer NOT NULL DEFAULT 7 CHECK (early_days BETWEEN 0 AND 365),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  updated_by_admin_id text REFERENCES zzsh_auth_admin."user"(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO zzsh_order.settlement_refund_policy(singleton) VALUES(true);

CREATE FUNCTION zzsh_order.guard_settlement_refund_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'refund policy singleton cannot be deleted' USING ERRCODE='23514';
  END IF;
  IF NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'refund policy revision must advance by one' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER settlement_refund_policy_guard BEFORE UPDATE OR DELETE ON zzsh_order.settlement_refund_policy
FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_settlement_refund_policy();

ALTER TABLE zzsh_order.settlement_posting ADD COLUMN refund_policy_revision bigint;
ALTER TABLE zzsh_order.settlement_posting ADD COLUMN refund_wait_days integer;
ALTER TABLE zzsh_order.settlement_posting DROP CONSTRAINT settlement_posting_check3;
ALTER TABLE zzsh_order.settlement_posting ADD CONSTRAINT settlement_posting_refund_policy_shape CHECK (
  (refund_policy_revision IS NULL AND refund_wait_days IS NULL
    AND refund_due_at = posted_at + CASE WHEN early THEN interval '168 hours' ELSE interval '0' END)
  OR
  (refund_policy_revision IS NOT NULL AND refund_policy_revision > 0
    AND refund_wait_days IS NOT NULL AND refund_wait_days BETWEEN 0 AND 365
    AND refund_due_at = posted_at + refund_wait_days * interval '24 hours')
);

CREATE OR REPLACE FUNCTION zzsh_order.guard_settlement_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ord record;
  ver record;
  policy record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'settlement postings are immutable' USING ERRCODE = '40001';
  END IF;
  SELECT status, paid_confirmation_id INTO ord FROM zzsh_order.rental_order WHERE id = NEW.order_id FOR UPDATE;
  SELECT kind, early, version_hash, superseded_at INTO ver FROM zzsh_order.settlement_version
    WHERE id = NEW.settlement_version_id AND order_id = NEW.order_id FOR UPDATE;
  IF ord IS NULL OR ord.status <> 'PAID' OR ord.paid_confirmation_id IS DISTINCT FROM NEW.payment_confirmation_id
     OR ver IS NULL OR ver.superseded_at IS NOT NULL OR ver.version_hash IS DISTINCT FROM NEW.version_hash
     OR ver.early IS DISTINCT FROM NEW.early THEN
    RAISE EXCEPTION 'posting must bind the paid order current settlement and payment' USING ERRCODE = '23514';
  END IF;
  SELECT revision, normal_days, early_days INTO policy FROM zzsh_order.settlement_refund_policy WHERE singleton FOR SHARE;
  IF policy IS NULL THEN
    RAISE EXCEPTION 'settlement refund policy is unavailable' USING ERRCODE = '23514';
  END IF;
  NEW.refund_policy_revision := policy.revision;
  NEW.refund_wait_days := CASE WHEN NEW.early THEN policy.early_days ELSE policy.normal_days END;
  NEW.refund_due_at := NEW.posted_at + NEW.refund_wait_days * interval '24 hours';
  RETURN NEW;
END $$;

REVOKE ALL ON TABLE zzsh_order.settlement_refund_policy FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_settlement_refund_policy() FROM PUBLIC;
-- Runtime role grants are installed with the other business-table privileges.
