-- O-03：客服异常手动结单。状态-only：不改金额、不生成结算/退款责任；资金由线下核对。
ALTER TABLE zzsh_order.rental_order DROP CONSTRAINT rental_order_cancel_reason_check,
 ADD CONSTRAINT rental_order_cancel_reason_check CHECK(cancel_reason IN('USER','TIMEOUT','PRESTART_TERMINATED','MANUAL_CLOSE')),
 DROP CONSTRAINT rental_order_payment_shape,
 ADD CONSTRAINT rental_order_payment_shape CHECK(
  (status IN('PAID','COMPLETED') AND paid_confirmation_id IS NOT NULL AND paid_at IS NOT NULL)
  OR(status='PENDING_PAYMENT' AND paid_confirmation_id IS NULL AND paid_at IS NULL)
  OR(status='CANCELLED' AND((cancel_reason IN('PRESTART_TERMINATED','MANUAL_CLOSE') AND paid_confirmation_id IS NOT NULL AND paid_at IS NOT NULL)
    OR(cancel_reason IN('USER','TIMEOUT') AND paid_confirmation_id IS NULL AND paid_at IS NULL))));

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
  IF OLD.cancel_reason='PRESTART_TERMINATED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminated paid order is immutable' USING ERRCODE='40001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'PENDING_PAYMENT' AND NEW.status IN ('CANCELLED','PAID'))
     AND NOT (OLD.status='PAID' AND NEW.status='CANCELLED' AND NEW.cancel_reason='PRESTART_TERMINATED')
     AND NOT (OLD.status='PAID' AND NEW.status='CANCELLED' AND NEW.cancel_reason='MANUAL_CLOSE')
     AND NOT (OLD.status = 'PAID' AND NEW.status = 'COMPLETED'
       AND EXISTS (SELECT 1 FROM zzsh_order.settlement_posting WHERE order_id = OLD.id)) THEN
    RAISE EXCEPTION 'invalid rental order transition' USING ERRCODE = '40001';
  END IF;
  IF OLD.status IN ('PAID','COMPLETED') AND (NEW.paid_confirmation_id,NEW.paid_at) IS DISTINCT FROM (OLD.paid_confirmation_id,OLD.paid_at) THEN
    RAISE EXCEPTION 'paid order reference is immutable' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.guard_manual_close_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status='CANCELLED' AND OLD.cancel_reason='MANUAL_CLOSE' THEN
    IF NEW IS DISTINCT FROM OLD THEN
      RAISE EXCEPTION 'manually closed order is immutable' USING ERRCODE='40001';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW.status='CANCELLED' AND NEW.cancel_reason='MANUAL_CLOSE' THEN
    IF OLD.status<>'PAID' OR NEW.cancelled_at IS NULL OR NEW.revision<>OLD.revision+1
      OR (NEW.paid_confirmation_id,NEW.paid_at) IS DISTINCT FROM (OLD.paid_confirmation_id,OLD.paid_at)
      OR (to_jsonb(NEW)-ARRAY['status','cancel_reason','cancelled_at','revision','updated_at','payment_disposition'])
         IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','cancel_reason','cancelled_at','revision','updated_at','payment_disposition'])
      OR NOT EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation c
        WHERE c.id=OLD.paid_confirmation_id AND c.order_id=OLD.id AND c.disposition='APPLIED')
      OR EXISTS(SELECT 1 FROM zzsh_order.prestart_termination t WHERE t.order_id=NEW.id AND t.state<>'REJECTED')
    THEN
      RAISE EXCEPTION 'manual close requires the original applied payment and no termination' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER manual_close_order_guard BEFORE UPDATE ON zzsh_order.rental_order
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_manual_close_order();
