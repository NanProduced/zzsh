-- TR-B3A: one immutable local posting per paid order; no provider execution.
ALTER TABLE zzsh_order.rental_order
  DROP CONSTRAINT rental_order_status_check,
  DROP CONSTRAINT rental_order_cancel_shape,
  DROP CONSTRAINT rental_order_payment_shape,
  DROP CONSTRAINT rental_order_applied_payment_fk,
  DROP COLUMN payment_disposition;

ALTER TABLE zzsh_order.rental_order
  ADD COLUMN payment_disposition text GENERATED ALWAYS AS
    (CASE WHEN status IN ('PAID','COMPLETED') THEN 'APPLIED'::text END) STORED,
  ADD CONSTRAINT rental_order_status_check CHECK (status IN ('PENDING_PAYMENT','CANCELLED','PAID','COMPLETED')),
  ADD CONSTRAINT rental_order_cancel_shape CHECK (
    (status = 'CANCELLED' AND cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL)
    OR (status IN ('PENDING_PAYMENT','PAID','COMPLETED') AND cancel_reason IS NULL AND cancelled_at IS NULL)),
  ADD CONSTRAINT rental_order_payment_shape CHECK (
    (status IN ('PAID','COMPLETED') AND paid_confirmation_id IS NOT NULL AND paid_at IS NOT NULL)
    OR (status IN ('PENDING_PAYMENT','CANCELLED') AND paid_confirmation_id IS NULL AND paid_at IS NULL)),
  ADD CONSTRAINT rental_order_applied_payment_fk FOREIGN KEY (id, paid_confirmation_id, payment_disposition)
    REFERENCES zzsh_order.payment_confirmation(order_id,id,disposition);

CREATE TABLE zzsh_order.settlement_posting (
  id text PRIMARY KEY,
  order_id text NOT NULL UNIQUE REFERENCES zzsh_order.rental_order(id),
  settlement_version_id text NOT NULL UNIQUE REFERENCES zzsh_order.settlement_version(id),
  payment_confirmation_id text NOT NULL UNIQUE REFERENCES zzsh_order.payment_confirmation(id),
  version_hash text NOT NULL CHECK (version_hash ~ '^[0-9a-f]{64}$'),
  early boolean NOT NULL,
  currency text NOT NULL DEFAULT 'CNY' CHECK (currency = 'CNY'),
  captured_cents numeric(24,0) NOT NULL CHECK (captured_cents >= 0),
  system_owner_net_cents numeric(24,0) NOT NULL CHECK (system_owner_net_cents >= 0),
  owner_net_cents numeric(24,0) NOT NULL CHECK (owner_net_cents >= 0),
  system_renter_refund_cents numeric(24,0) NOT NULL CHECK (system_renter_refund_cents >= 0),
  renter_refund_cents numeric(24,0) NOT NULL CHECK (renter_refund_cents >= 0),
  platform_contribution_cents numeric(24,0) NOT NULL CHECK (platform_contribution_cents >= 0),
  compensation_fee_cents numeric(24,0) NOT NULL CHECK (compensation_fee_cents >= 0),
  manual_reason text,
  approval_request_id text REFERENCES zzsh_iam.approval_request(id),
  approval_requested_by text REFERENCES zzsh_auth_admin."user"(id),
  approval_approved_by text REFERENCES zzsh_auth_admin."user"(id),
  approval_expires_at timestamptz,
  approval_payload_hash text CHECK (approval_payload_hash IS NULL OR approval_payload_hash ~ '^[0-9a-f]{64}$'),
  posted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  refund_due_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (captured_cents = owner_net_cents + renter_refund_cents + platform_contribution_cents),
  CHECK ((manual_reason IS NULL AND approval_request_id IS NULL)
      OR (length(btrim(manual_reason)) BETWEEN 3 AND 500 AND approval_request_id IS NOT NULL)),
  CHECK ((approval_request_id IS NULL AND approval_requested_by IS NULL AND approval_approved_by IS NULL
          AND approval_expires_at IS NULL AND approval_payload_hash IS NULL)
      OR (approval_request_id IS NOT NULL AND approval_requested_by IS NOT NULL AND approval_approved_by IS NOT NULL
          AND approval_requested_by <> approval_approved_by AND approval_expires_at > posted_at AND approval_payload_hash IS NOT NULL)),
  CHECK (refund_due_at = posted_at + CASE WHEN early THEN interval '168 hours' ELSE interval '0' END)
);

CREATE TABLE zzsh_order.settlement_ledger_entry (
  id text PRIMARY KEY,
  posting_id text NOT NULL REFERENCES zzsh_order.settlement_posting(id),
  line_no integer NOT NULL CHECK (line_no > 0),
  account_code text NOT NULL CHECK (account_code IN (
    'CAPTURED_PAYMENT_SOURCE','OWNER_AVAILABLE','RENTER_REFUND_PAYABLE',
    'PLATFORM_HAFF_SPREAD','PLATFORM_ITEM_SPREAD','PLATFORM_EARLY_MAKEUP',
    'PLATFORM_COMPENSATION_FEE','PLATFORM_MANUAL_NET_ADJUSTMENT')),
  debit_cents numeric(24,0) NOT NULL DEFAULT 0 CHECK (debit_cents >= 0),
  credit_cents numeric(24,0) NOT NULL DEFAULT 0 CHECK (credit_cents >= 0),
  counterparty_user_id text REFERENCES zzsh_auth_user."user"(id),
  source_payment_confirmation_id text REFERENCES zzsh_order.payment_confirmation(id),
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (posting_id,line_no),
  CHECK ((debit_cents > 0 AND credit_cents = 0) OR (credit_cents > 0 AND debit_cents = 0)),
  CHECK ((account_code = 'CAPTURED_PAYMENT_SOURCE' AND source_payment_confirmation_id IS NOT NULL AND counterparty_user_id IS NULL)
      OR (account_code <> 'CAPTURED_PAYMENT_SOURCE' AND source_payment_confirmation_id IS NULL)),
  CHECK ((account_code = 'OWNER_AVAILABLE' AND counterparty_user_id IS NOT NULL)
      OR (account_code = 'RENTER_REFUND_PAYABLE' AND counterparty_user_id IS NOT NULL)
      OR (account_code NOT IN ('OWNER_AVAILABLE','RENTER_REFUND_PAYABLE') AND counterparty_user_id IS NULL))
);
CREATE UNIQUE INDEX settlement_ledger_source_payment_once
  ON zzsh_order.settlement_ledger_entry(source_payment_confirmation_id)
  WHERE source_payment_confirmation_id IS NOT NULL;

CREATE FUNCTION zzsh_order.guard_settlement_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  ord record;
  ver record;
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
  NEW.refund_due_at := NEW.posted_at + CASE WHEN NEW.early THEN interval '168 hours' ELSE interval '0' END;
  RETURN NEW;
END $$;
CREATE TRIGGER settlement_posting_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_order.settlement_posting
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_settlement_posting();

CREATE FUNCTION zzsh_order.guard_settlement_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'settlement ledger entries are immutable' USING ERRCODE = '40001';
END $$;
CREATE TRIGGER settlement_ledger_entry_guard BEFORE UPDATE OR DELETE ON zzsh_order.settlement_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_settlement_ledger_entry();

CREATE FUNCTION zzsh_order.check_settlement_posting_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_posting_id text;
  batch record;
  ord record;
  ver record;
  payment record;
  approval record;
  sums record;
BEGIN
  IF TG_TABLE_NAME = 'settlement_posting' THEN
    v_posting_id := NEW.id;
  ELSE
    v_posting_id := NEW.posting_id;
  END IF;
  SELECT * INTO batch FROM zzsh_order.settlement_posting WHERE id = v_posting_id;
  IF batch IS NULL THEN RETURN NULL; END IF;
  SELECT status, paid_confirmation_id, renter_user_id, owner_user_id INTO ord
    FROM zzsh_order.rental_order WHERE id = batch.order_id;
  SELECT kind, early, version_hash, superseded_at, approval_request_id INTO ver
    FROM zzsh_order.settlement_version WHERE id = batch.settlement_version_id AND order_id = batch.order_id;
  SELECT order_id, amount_cents, currency, disposition INTO payment
    FROM zzsh_order.payment_confirmation WHERE id = batch.payment_confirmation_id;
  IF ord IS NULL OR ord.status IS DISTINCT FROM 'COMPLETED' OR ord.paid_confirmation_id IS DISTINCT FROM batch.payment_confirmation_id
     OR ver IS NULL OR ver.superseded_at IS NOT NULL OR ver.version_hash IS DISTINCT FROM batch.version_hash
     OR ver.early IS DISTINCT FROM batch.early OR payment IS NULL OR payment.order_id IS DISTINCT FROM batch.order_id
     OR payment.disposition <> 'APPLIED' OR payment.currency <> 'CNY' OR payment.amount_cents <> batch.captured_cents THEN
    RAISE EXCEPTION 'posting header is not bound to a completed order and its applied payment' USING ERRCODE = '23514';
  END IF;
  IF (SELECT count(*) FROM zzsh_order.settlement_decision
       WHERE settlement_version_id = batch.settlement_version_id AND party = 'RENTER'
         AND action = 'CONFIRM' AND subject_id = ord.renter_user_id AND version_hash = batch.version_hash) <> 1
     OR (SELECT count(*) FROM zzsh_order.settlement_decision
       WHERE settlement_version_id = batch.settlement_version_id AND party = 'OWNER'
         AND action = 'CONFIRM' AND subject_id = ord.owner_user_id AND version_hash = batch.version_hash) <> 1
     OR EXISTS (SELECT 1 FROM zzsh_order.settlement_decision
       WHERE settlement_version_id = batch.settlement_version_id AND party IN ('RENTER','OWNER') AND action = 'REJECT') THEN
    RAISE EXCEPTION 'posting requires both parties to confirm the same version' USING ERRCODE = '23514';
  END IF;
  IF batch.early AND NOT EXISTS (SELECT 1 FROM zzsh_order.settlement_decision
       WHERE settlement_version_id = batch.settlement_version_id AND party = 'SUPPORT' AND action = 'REVIEW'
         AND version_hash = batch.version_hash) THEN
    RAISE EXCEPTION 'early posting requires support review' USING ERRCODE = '23514';
  END IF;
  IF ver.kind = 'MANUAL_ADJUSTMENT' THEN
    SELECT status, requested_by, decided_by, operation_payload_hash, expires_at INTO approval
      FROM zzsh_iam.approval_request WHERE id = batch.approval_request_id;
    IF approval IS NULL OR approval.status <> 'APPROVED' OR approval.decided_by IS NULL
       OR approval.decided_by = approval.requested_by OR approval.operation_payload_hash <> batch.version_hash
       OR approval.expires_at <= batch.posted_at OR batch.approval_request_id IS DISTINCT FROM ver.approval_request_id
       OR batch.approval_requested_by IS DISTINCT FROM approval.requested_by
       OR batch.approval_approved_by IS DISTINCT FROM approval.decided_by
       OR batch.approval_expires_at IS DISTINCT FROM approval.expires_at
       OR batch.approval_payload_hash IS DISTINCT FROM approval.operation_payload_hash THEN
      RAISE EXCEPTION 'posting requires the current valid non-self manual approval' USING ERRCODE = '23514';
    END IF;
  ELSIF batch.approval_request_id IS NOT NULL THEN
    RAISE EXCEPTION 'system settlement cannot bind a manual approval' USING ERRCODE = '23514';
  END IF;
  SELECT count(*)::integer AS line_count,
         COALESCE(sum(debit_cents),0) AS debit_cents,
         COALESCE(sum(credit_cents),0) AS credit_cents,
         count(*) FILTER (WHERE account_code = 'CAPTURED_PAYMENT_SOURCE' AND debit_cents = batch.captured_cents
                           AND source_payment_confirmation_id = batch.payment_confirmation_id) AS source_count,
         COALESCE(sum(credit_cents) FILTER (WHERE account_code = 'OWNER_AVAILABLE'),0) AS owner_cents,
         COALESCE(sum(credit_cents) FILTER (WHERE account_code = 'RENTER_REFUND_PAYABLE'),0) AS refund_cents,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code LIKE 'PLATFORM_%'),0) AS platform_cents,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_COMPENSATION_FEE'),0) AS fee_cents
    INTO sums FROM zzsh_order.settlement_ledger_entry AS entry WHERE entry.posting_id = v_posting_id;
  IF sums.line_count < 2 OR sums.debit_cents <> sums.credit_cents OR sums.source_count <> 1
     OR sums.owner_cents <> batch.owner_net_cents OR sums.refund_cents <> batch.renter_refund_cents
     OR sums.platform_cents <> batch.platform_contribution_cents OR sums.fee_cents <> batch.compensation_fee_cents THEN
    RAISE EXCEPTION 'settlement posting batch is incomplete or unbalanced' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER settlement_posting_batch_guard
  AFTER INSERT ON zzsh_order.settlement_posting DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_settlement_posting_batch();
CREATE CONSTRAINT TRIGGER settlement_ledger_batch_guard
  AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_settlement_posting_batch();

CREATE OR REPLACE FUNCTION zzsh_order.guard_rental_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  snap_currency text;
  snap_deposit_policy text;
  snap_rental text;
  snap_deposit text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'PENDING_PAYMENT' THEN
      RAISE EXCEPTION 'rental order must start as PENDING_PAYMENT' USING ERRCODE = '40001';
    END IF;
    snap_currency := NEW.quote_snapshot ->> 'currency';
    snap_deposit_policy := NEW.quote_snapshot #>> '{pricingInputs,depositPolicy}';
    snap_rental := NEW.quote_snapshot #>> '{resourceTotal,amount}';
    snap_deposit := NEW.quote_snapshot #>> '{tenantDeposit,amount}';
    IF snap_currency IS DISTINCT FROM 'CNY' OR NEW.currency <> 'CNY' THEN
      RAISE EXCEPTION 'rental order snapshot currency is not CNY' USING ERRCODE = '40001';
    END IF;
    IF snap_deposit_policy IS DISTINCT FROM 'CONFIGURED' THEN
      RAISE EXCEPTION 'rental order snapshot deposit policy is not CONFIGURED' USING ERRCODE = '40001';
    END IF;
    IF snap_rental IS NULL OR snap_deposit IS NULL
       OR snap_rental !~ '^(0|[1-9]\d*)\.\d{2}$' OR snap_deposit !~ '^(0|[1-9]\d*)\.\d{2}$' THEN
      RAISE EXCEPTION 'rental order snapshot amounts are incomplete' USING ERRCODE = '40001';
    END IF;
    IF NEW.rental_amount_cents <> CAST(replace(snap_rental, '.', '') AS numeric)
       OR NEW.deposit_amount_cents <> CAST(replace(snap_deposit, '.', '') AS numeric) THEN
      RAISE EXCEPTION 'rental order amounts do not match the snapshot' USING ERRCODE = '40001';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.display_no, NEW.account_id, NEW.listing_version_id, NEW.owner_user_id,
      NEW.renter_user_id, NEW.game_id, NEW.rule_release_id, NEW.content_hash, NEW.term_option_code,
      NEW.rental_amount_cents, NEW.deposit_amount_cents, NEW.currency, NEW.term_seconds,
      NEW.quote_snapshot, NEW.title, NEW.hold_until)
     IS DISTINCT FROM
     (OLD.id, OLD.display_no, OLD.account_id, OLD.listing_version_id, OLD.owner_user_id,
      OLD.renter_user_id, OLD.game_id, OLD.rule_release_id, OLD.content_hash, OLD.term_option_code,
      OLD.rental_amount_cents, OLD.deposit_amount_cents, OLD.currency, OLD.term_seconds,
      OLD.quote_snapshot, OLD.title, OLD.hold_until) THEN
    RAISE EXCEPTION 'rental order snapshot is immutable' USING ERRCODE = '40001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'PENDING_PAYMENT' AND NEW.status IN ('CANCELLED','PAID'))
     AND NOT (OLD.status = 'PAID' AND NEW.status = 'COMPLETED'
       AND EXISTS (SELECT 1 FROM zzsh_order.settlement_posting WHERE order_id = OLD.id)) THEN
    RAISE EXCEPTION 'invalid rental order transition' USING ERRCODE = '40001';
  END IF;
  IF OLD.status IN ('PAID','COMPLETED') AND (NEW.paid_confirmation_id,NEW.paid_at) IS DISTINCT FROM (OLD.paid_confirmation_id,OLD.paid_at) THEN
    RAISE EXCEPTION 'paid order reference is immutable' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

REVOKE UPDATE, DELETE, TRUNCATE ON zzsh_order.settlement_posting, zzsh_order.settlement_ledger_entry FROM PUBLIC;
