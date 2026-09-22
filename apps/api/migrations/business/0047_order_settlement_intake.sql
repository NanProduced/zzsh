-- TR-B2 F4: a party may record remaining quantities before a fee version exists.
-- The row is not a confirmation and does not price the settlement.

CREATE TABLE zzsh_order.settlement_intake (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES zzsh_order.rental_order(id),
  opening_id text NOT NULL REFERENCES zzsh_order.rental_opening(id),
  version_no integer NOT NULL CHECK (version_no > 0),
  initiator_party text NOT NULL CHECK (initiator_party IN ('RENTER','OWNER')),
  initiator_subject_id text NOT NULL,
  lines jsonb NOT NULL,
  basis_hash text NOT NULL CHECK (basis_hash ~ '^[0-9a-f]{64}$'),
  status text NOT NULL CHECK (status IN ('OPEN','CLASSIFIED','SUPERSEDED')),
  settlement_version_id text REFERENCES zzsh_order.settlement_version(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  classified_at timestamptz,
  superseded_at timestamptz,
  UNIQUE (order_id, version_no),
  CHECK (
    (status = 'OPEN' AND settlement_version_id IS NULL AND classified_at IS NULL AND superseded_at IS NULL)
    OR (status = 'CLASSIFIED' AND settlement_version_id IS NOT NULL AND classified_at IS NOT NULL AND superseded_at IS NULL)
    OR (status = 'SUPERSEDED' AND settlement_version_id IS NULL AND classified_at IS NULL AND superseded_at IS NOT NULL)
  )
);

CREATE UNIQUE INDEX settlement_intake_one_open ON zzsh_order.settlement_intake(order_id) WHERE status = 'OPEN';

CREATE FUNCTION zzsh_order.guard_settlement_intake() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'settlement intakes are immutable' USING ERRCODE = '40001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.opening_id IS DISTINCT FROM OLD.opening_id OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.initiator_party IS DISTINCT FROM OLD.initiator_party
     OR NEW.initiator_subject_id IS DISTINCT FROM OLD.initiator_subject_id
     OR NEW.lines IS DISTINCT FROM OLD.lines OR NEW.basis_hash IS DISTINCT FROM OLD.basis_hash
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION 'settlement intake content is immutable' USING ERRCODE = '40001';
  END IF;
  IF NOT (
    (OLD.status = 'OPEN' AND NEW.status = 'SUPERSEDED' AND NEW.superseded_at IS NOT NULL AND NEW.settlement_version_id IS NULL)
    OR (OLD.status = 'OPEN' AND NEW.status = 'CLASSIFIED' AND NEW.classified_at IS NOT NULL AND NEW.settlement_version_id IS NOT NULL)
  ) THEN
    RAISE EXCEPTION 'settlement intake can only be classified or superseded' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER settlement_intake_guard BEFORE UPDATE OR DELETE ON zzsh_order.settlement_intake
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_settlement_intake();
