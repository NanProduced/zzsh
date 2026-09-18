-- OIM-2A: accepted payment and durable waiting intent; no dispatch or provider work.
CREATE TABLE zzsh_order.payment_confirmation (
  id text PRIMARY KEY,
  source text NOT NULL CHECK (source IN ('CONTROLLED')),
  merchant_scope_id text NOT NULL CHECK (length(merchant_scope_id) BETWEEN 1 AND 128),
  provider_transaction_id text NOT NULL CHECK (length(provider_transaction_id) BETWEEN 1 AND 128),
  merchant_order_no text NOT NULL CHECK (length(merchant_order_no) BETWEEN 1 AND 128),
  order_id text NOT NULL REFERENCES zzsh_order.rental_order(id),
  amount_cents numeric(25,0) NOT NULL CHECK (amount_cents >= 0),
  currency text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  provider_paid_at timestamptz NOT NULL,
  accepted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  disposition text NOT NULL CHECK (disposition IN ('APPLIED','REVIEW_REQUIRED')),
  reason_code text CHECK (reason_code IN ('BINDING_MISMATCH','LATE_PAYMENT','DUPLICATE_PAYMENT')),
  request_id text NOT NULL,
  UNIQUE (source, merchant_scope_id, provider_transaction_id),
  UNIQUE (order_id, id, disposition),
  CHECK ((disposition = 'APPLIED' AND reason_code IS NULL)
      OR (disposition = 'REVIEW_REQUIRED' AND reason_code IS NOT NULL))
);
CREATE UNIQUE INDEX payment_confirmation_one_applied ON zzsh_order.payment_confirmation(order_id)
  WHERE disposition = 'APPLIED';

ALTER TABLE zzsh_order.rental_order
  DROP CONSTRAINT rental_order_status_check,
  DROP CONSTRAINT rental_order_cancel_shape,
  ADD COLUMN paid_confirmation_id text,
  ADD COLUMN paid_at timestamptz,
  ADD COLUMN payment_disposition text GENERATED ALWAYS AS
    (CASE WHEN status = 'PAID' THEN 'APPLIED'::text END) STORED,
  ADD CONSTRAINT rental_order_status_check CHECK (status IN ('PENDING_PAYMENT','CANCELLED','PAID')),
  ADD CONSTRAINT rental_order_cancel_shape CHECK (
    (status = 'CANCELLED' AND cancel_reason IS NOT NULL AND cancelled_at IS NOT NULL)
    OR (status IN ('PENDING_PAYMENT','PAID') AND cancel_reason IS NULL AND cancelled_at IS NULL)),
  ADD CONSTRAINT rental_order_payment_shape CHECK (
    (status = 'PAID' AND paid_confirmation_id IS NOT NULL AND paid_at IS NOT NULL)
    OR (status <> 'PAID' AND paid_confirmation_id IS NULL AND paid_at IS NULL)),
  ADD CONSTRAINT rental_order_applied_payment_fk FOREIGN KEY (id, paid_confirmation_id, payment_disposition)
    REFERENCES zzsh_order.payment_confirmation(order_id,id,disposition),
  ADD CONSTRAINT rental_order_payment_pair UNIQUE (id, paid_confirmation_id);

DROP INDEX zzsh_order.rental_order_single_occupancy;
CREATE UNIQUE INDEX rental_order_single_occupancy ON zzsh_order.rental_order(account_id)
  WHERE status IN ('PENDING_PAYMENT','PAID');

CREATE TABLE zzsh_order.im_order_group (
  order_id text PRIMARY KEY,
  payment_confirmation_id text NOT NULL,
  app_id text NOT NULL CHECK (app_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  provision_state text NOT NULL DEFAULT 'WAITING' CHECK (provision_state = 'WAITING'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (order_id,payment_confirmation_id) REFERENCES zzsh_order.rental_order(id,paid_confirmation_id)
);

CREATE FUNCTION zzsh_order.guard_payment_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'payment facts and waiting bindings are immutable' USING ERRCODE = '40001';
END $$;
CREATE TRIGGER payment_confirmation_immutable BEFORE UPDATE OR DELETE ON zzsh_order.payment_confirmation
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_payment_fact();
CREATE TRIGGER im_order_group_immutable BEFORE UPDATE OR DELETE ON zzsh_order.im_order_group
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_payment_fact();

-- An APPLIED fact must commit together with the matching order and waiting row.
CREATE FUNCTION zzsh_order.check_applied_payment() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.disposition = 'APPLIED' AND NOT EXISTS (
    SELECT 1 FROM zzsh_order.rental_order o
      JOIN zzsh_order.im_order_group g ON g.order_id=o.id AND g.payment_confirmation_id=NEW.id
     WHERE o.id=NEW.order_id AND o.paid_confirmation_id=NEW.id AND o.status='PAID'
       AND o.display_no=NEW.merchant_order_no AND o.currency=NEW.currency
       AND o.rental_amount_cents+o.deposit_amount_cents=NEW.amount_cents
       AND o.paid_at=NEW.accepted_at AND o.paid_at < o.hold_until
  ) THEN
    RAISE EXCEPTION 'applied payment must match paid order and waiting intent' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER payment_confirmation_applied_guard
  AFTER INSERT ON zzsh_order.payment_confirmation DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_applied_payment();
CREATE OR REPLACE FUNCTION "zzsh_order"."guard_rental_order"() RETURNS trigger LANGUAGE plpgsql AS $$
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
    -- Strict textual validation first; the standard numeric cast is only applied
    -- to values that already match the checked shape.
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
     AND NOT (OLD.status = 'PENDING_PAYMENT' AND NEW.status IN ('CANCELLED','PAID')) THEN
    RAISE EXCEPTION 'invalid rental order transition' USING ERRCODE = '40001';
  END IF;
  IF OLD.status = 'PAID' AND (NEW.paid_confirmation_id,NEW.paid_at) IS DISTINCT FROM (OLD.paid_confirmation_id,OLD.paid_at) THEN
    RAISE EXCEPTION 'paid order reference is immutable' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

