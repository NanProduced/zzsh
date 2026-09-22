-- TR-B2: opening versions, settlement versions, and confirmation facts.
-- Does not post funds, complete orders, or release occupancy.

CREATE TABLE zzsh_order.rental_opening (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES zzsh_order.rental_order(id),
  version_no integer NOT NULL CHECK (version_no > 0),
  quote_digest text NOT NULL CHECK (quote_digest ~ '^[0-9a-f]{64}$'),
  payment_digest text NOT NULL CHECK (payment_digest ~ '^[0-9a-f]{64}$'),
  lines jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('DRAFT','CONFIRMED')),
  created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  confirmed_at timestamptz,
  UNIQUE (order_id, version_no),
  CHECK ((status = 'DRAFT' AND confirmed_at IS NULL) OR (status = 'CONFIRMED' AND confirmed_at IS NOT NULL))
);

CREATE UNIQUE INDEX rental_opening_one_confirmed ON zzsh_order.rental_opening(order_id) WHERE status = 'CONFIRMED';

CREATE TABLE zzsh_order.rental_opening_ack (
  opening_id text NOT NULL REFERENCES zzsh_order.rental_opening(id),
  party text NOT NULL CHECK (party IN ('RENTER','OWNER')),
  user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
  version_no integer NOT NULL CHECK (version_no > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (opening_id, party)
);

CREATE TABLE zzsh_order.settlement_version (
  id text PRIMARY KEY,
  order_id text NOT NULL REFERENCES zzsh_order.rental_order(id),
  opening_id text NOT NULL REFERENCES zzsh_order.rental_opening(id),
  version_no integer NOT NULL CHECK (version_no > 0),
  kind text NOT NULL CHECK (kind IN ('SYSTEM','MANUAL_ADJUSTMENT')),
  end_reason text NOT NULL CHECK (end_reason IN ('NORMAL','TENANT_VOLUNTARY_EARLY','OWNER_OR_ACCOUNT_EARLY')),
  early boolean NOT NULL,
  initiator_party text NOT NULL CHECK (initiator_party IN ('RENTER','OWNER','SUPPORT')),
  initiator_subject_id text NOT NULL,
  basis_hash text NOT NULL CHECK (basis_hash ~ '^[0-9a-f]{64}$'),
  version_hash text NOT NULL CHECK (version_hash ~ '^[0-9a-f]{64}$'),
  input_snapshot jsonb NOT NULL,
  computation jsonb NOT NULL,
  system_owner_net_cents numeric(24,0) NOT NULL CHECK (system_owner_net_cents >= 0),
  system_renter_refund_cents numeric(24,0) NOT NULL CHECK (system_renter_refund_cents >= 0),
  proposed_owner_net_cents numeric(24,0) CHECK (proposed_owner_net_cents >= 0),
  proposed_renter_refund_cents numeric(24,0) CHECK (proposed_renter_refund_cents >= 0),
  approval_request_id text UNIQUE REFERENCES zzsh_iam.approval_request(id),
  superseded_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (order_id, version_no),
  CHECK (basis_hash = version_hash),
  CHECK (
    (kind = 'SYSTEM' AND proposed_owner_net_cents IS NULL AND proposed_renter_refund_cents IS NULL AND approval_request_id IS NULL)
    OR (kind = 'MANUAL_ADJUSTMENT' AND proposed_owner_net_cents IS NOT NULL AND proposed_renter_refund_cents IS NOT NULL AND approval_request_id IS NOT NULL)
  )
);

CREATE UNIQUE INDEX settlement_version_current ON zzsh_order.settlement_version(order_id) WHERE superseded_at IS NULL;

CREATE TABLE zzsh_order.settlement_decision (
  id text PRIMARY KEY,
  settlement_version_id text NOT NULL REFERENCES zzsh_order.settlement_version(id),
  version_hash text NOT NULL CHECK (version_hash ~ '^[0-9a-f]{64}$'),
  basis_hash text NOT NULL CHECK (basis_hash ~ '^[0-9a-f]{64}$'),
  party text NOT NULL CHECK (party IN ('RENTER','OWNER','SUPPORT')),
  action text NOT NULL CHECK (action IN ('CONFIRM','REJECT','REVIEW')),
  subject_id text NOT NULL,
  reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (settlement_version_id, party, action),
  CHECK (
    (party IN ('RENTER','OWNER') AND action IN ('CONFIRM','REJECT'))
    OR (party = 'SUPPORT' AND action = 'REVIEW')
  ),
  CHECK (action <> 'REJECT' OR (reason IS NOT NULL AND length(reason) >= 1))
);

CREATE FUNCTION zzsh_order.guard_rental_opening() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'opening versions are immutable' USING ERRCODE = '40001';
  END IF;
  IF OLD.status = 'CONFIRMED' OR NEW.lines IS DISTINCT FROM OLD.lines
     OR NEW.order_id IS DISTINCT FROM OLD.order_id OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.quote_digest IS DISTINCT FROM OLD.quote_digest OR NEW.payment_digest IS DISTINCT FROM OLD.payment_digest
     OR NEW.created_by_admin_id IS DISTINCT FROM OLD.created_by_admin_id OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'confirmed opening lines are immutable' USING ERRCODE = '40001';
  END IF;
  IF NOT (OLD.status = 'DRAFT' AND NEW.status = 'CONFIRMED' AND NEW.confirmed_at IS NOT NULL) THEN
    RAISE EXCEPTION 'opening can only move from draft to confirmed' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER rental_opening_guard BEFORE UPDATE OR DELETE ON zzsh_order.rental_opening
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_rental_opening();

CREATE FUNCTION zzsh_order.guard_opening_ack() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'opening confirmations are immutable' USING ERRCODE = '40001';
END $$;

CREATE TRIGGER rental_opening_ack_guard BEFORE UPDATE OR DELETE ON zzsh_order.rental_opening_ack
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_opening_ack();

CREATE FUNCTION zzsh_order.guard_settlement_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'settlement versions are immutable' USING ERRCODE = '40001';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.order_id IS DISTINCT FROM OLD.order_id
     OR NEW.opening_id IS DISTINCT FROM OLD.opening_id OR NEW.version_no IS DISTINCT FROM OLD.version_no
     OR NEW.kind IS DISTINCT FROM OLD.kind OR NEW.end_reason IS DISTINCT FROM OLD.end_reason
     OR NEW.early IS DISTINCT FROM OLD.early OR NEW.initiator_party IS DISTINCT FROM OLD.initiator_party
     OR NEW.initiator_subject_id IS DISTINCT FROM OLD.initiator_subject_id
     OR NEW.basis_hash IS DISTINCT FROM OLD.basis_hash OR NEW.version_hash IS DISTINCT FROM OLD.version_hash
     OR NEW.input_snapshot IS DISTINCT FROM OLD.input_snapshot OR NEW.computation IS DISTINCT FROM OLD.computation
     OR NEW.system_owner_net_cents IS DISTINCT FROM OLD.system_owner_net_cents
     OR NEW.system_renter_refund_cents IS DISTINCT FROM OLD.system_renter_refund_cents
     OR NEW.proposed_owner_net_cents IS DISTINCT FROM OLD.proposed_owner_net_cents
     OR NEW.proposed_renter_refund_cents IS DISTINCT FROM OLD.proposed_renter_refund_cents
     OR NEW.approval_request_id IS DISTINCT FROM OLD.approval_request_id
     OR NEW.created_at IS DISTINCT FROM OLD.created_at
     OR OLD.superseded_at IS NOT NULL OR NEW.superseded_at IS NULL THEN
    RAISE EXCEPTION 'settlement version content is immutable' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER settlement_version_guard BEFORE UPDATE OR DELETE ON zzsh_order.settlement_version
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_settlement_version();

CREATE FUNCTION zzsh_order.guard_settlement_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  bound record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'settlement decisions are immutable' USING ERRCODE = '40001';
  END IF;
  SELECT version_hash, basis_hash, superseded_at INTO bound
    FROM zzsh_order.settlement_version WHERE id = NEW.settlement_version_id;
  IF bound IS NULL OR bound.version_hash IS DISTINCT FROM NEW.version_hash
     OR bound.basis_hash IS DISTINCT FROM NEW.basis_hash OR bound.superseded_at IS NOT NULL THEN
    RAISE EXCEPTION 'settlement decision is not bound to the current version' USING ERRCODE = '40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM zzsh_order.settlement_decision
     WHERE settlement_version_id = NEW.settlement_version_id AND party = NEW.party
       AND action IN ('CONFIRM','REJECT') AND NEW.action IN ('CONFIRM','REJECT') AND action <> NEW.action
  ) THEN
    RAISE EXCEPTION 'settlement party already decided' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER settlement_decision_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_order.settlement_decision
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_settlement_decision();

INSERT INTO zzsh_iam.admin_permission(code, name, description) VALUES
  ('order.settlement.write', '订单结算写入', '录入开租清单、改版结算、提前复核和提交人工调整；不含资金执行')
ON CONFLICT (code) DO NOTHING;
