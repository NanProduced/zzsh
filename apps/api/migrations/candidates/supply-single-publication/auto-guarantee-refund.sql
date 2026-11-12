-- Candidate: integrate after the permanent DELISTED account state is installed.
ALTER TABLE zzsh_order.owner_guarantee_refund
  DROP CONSTRAINT owner_guarantee_refund_release_policy_state_check,
  DROP CONSTRAINT owner_guarantee_refund_release_decision_shape;
--> statement-breakpoint
ALTER TABLE zzsh_order.owner_guarantee_refund
  ADD CONSTRAINT owner_guarantee_refund_release_policy_state_check
    CHECK (release_policy_state IN ('OWNER_DECISION_REQUIRED','APPROVED','REJECTED','AUTO_APPROVED')),
  ADD CONSTRAINT owner_guarantee_refund_release_decision_shape CHECK ((
    (release_policy_state='OWNER_DECISION_REQUIRED' AND release_decision_fingerprint IS NULL AND release_decided_by IS NULL AND release_decided_at IS NULL)
    OR (release_policy_state IN ('APPROVED','REJECTED') AND release_decision_fingerprint IS NOT NULL AND release_decided_by IS NOT NULL AND release_decided_at IS NOT NULL)
    OR (release_policy_state='AUTO_APPROVED' AND release_decision_reason='ACCOUNT_DELISTED'
      AND release_decision_fingerprint=request_fingerprint AND release_decided_by IS NULL AND release_decided_at IS NOT NULL)
  ) IS TRUE);

--> statement-breakpoint
CREATE UNIQUE INDEX owner_guarantee_refund_active_payment_uq ON zzsh_order.owner_guarantee_refund(payment_id)
  WHERE status IN ('REQUESTED','PROCESSING','UNKNOWN','SUCCEEDED');

--> statement-breakpoint
CREATE FUNCTION zzsh_order.guard_auto_delisted_guarantee_refund() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' AND OLD.release_policy_state='AUTO_APPROVED' THEN
    IF (NEW.requirement_id,NEW.payment_id,NEW.owner_user_id,NEW.request_key,NEW.request_fingerprint,NEW.provider,NEW.amount_cents,
        NEW.release_policy_state,NEW.release_decision_reason,NEW.release_decision_fingerprint,NEW.release_decided_by,NEW.release_decided_at)
       IS DISTINCT FROM (OLD.requirement_id,OLD.payment_id,OLD.owner_user_id,OLD.request_key,OLD.request_fingerprint,OLD.provider,OLD.amount_cents,
        OLD.release_policy_state,OLD.release_decision_reason,OLD.release_decision_fingerprint,OLD.release_decided_by,OLD.release_decided_at)
    THEN RAISE EXCEPTION 'automatic guarantee refund basis is immutable' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF NEW.release_policy_state<>'AUTO_APPROVED' THEN RETURN NEW; END IF;
  IF TG_OP<>'INSERT' OR NEW.status<>'REQUESTED' OR NEW.provider_request_state<>'NOT_AUTHORIZED'
    OR NEW.provider_refund_id IS NOT NULL OR NEW.original_receipt IS NOT NULL OR NEW.source_digest IS NOT NULL
    OR NEW.finance_event_id IS NOT NULL OR NEW.ledger_entry_ref IS NOT NULL
  THEN RAISE EXCEPTION 'automatic guarantee refund must start from a new liability' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM zzsh_supply.rental_account a
    JOIN zzsh_order.owner_guarantee_requirement r ON r.account_id=a.id AND r.owner_user_id=a.owner_user_id
    JOIN zzsh_order.owner_guarantee_payment p ON p.requirement_id=r.id AND p.owner_user_id=r.owner_user_id
    WHERE r.id=NEW.requirement_id AND p.id=NEW.payment_id AND r.owner_user_id=NEW.owner_user_id
    FOR UPDATE OF a,r,p;
  IF NOT FOUND THEN RAISE EXCEPTION 'automatic guarantee refund subject is unavailable' USING ERRCODE='23514'; END IF;
  IF NOT EXISTS (
    SELECT 1 FROM zzsh_order.owner_guarantee_requirement r
    JOIN zzsh_supply.rental_account a ON a.id=r.account_id AND a.owner_user_id=r.owner_user_id
    JOIN zzsh_order.owner_guarantee_payment p ON p.id=NEW.payment_id AND p.requirement_id=r.id AND p.owner_user_id=r.owner_user_id
    JOIN zzsh_order.finance_event e ON e.id=p.finance_event_id AND e.kind='GUARANTEE_CAPTURE' AND e.subject_user_id=r.owner_user_id
    JOIN zzsh_order.finance_economic_root root ON root.id=e.economic_root_id AND root.source_kind='NATIVE_GUARANTEE'
      AND root.source_entity='owner_guarantee_payment' AND root.source_id=p.id AND root.subject_user_id=r.owner_user_id AND root.source_digest=p.source_digest
    JOIN zzsh_order.settlement_ledger_entry cash ON cash.id=p.ledger_entry_ref AND cash.finance_event_id=e.id
      AND cash.account_code='GUARANTEE_CASH' AND cash.debit_cents=p.observed_amount_cents AND cash.credit_cents=0
    WHERE r.id=NEW.requirement_id AND r.owner_user_id=NEW.owner_user_id AND a.lifecycle='DELISTED'
      AND p.status='CONFIRMED' AND p.provider_request_state='CONFIRMED' AND p.provider_transaction_id IS NOT NULL
      AND p.observed_amount_cents IS NOT NULL AND p.observed_amount_cents=NEW.amount_cents
      AND (SELECT count(*) FROM zzsh_order.settlement_ledger_entry x WHERE x.finance_event_id=e.id)=2
      AND EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry held WHERE held.finance_event_id=e.id
        AND held.account_code='GUARANTEE_HELD' AND held.counterparty_user_id=r.owner_user_id AND held.debit_cents=0 AND held.credit_cents=NEW.amount_cents)
      AND NOT EXISTS(SELECT 1 FROM zzsh_order.owner_guarantee_payment x WHERE x.requirement_id=r.id AND x.id<>p.id
        AND (x.status<>'FAILED' OR x.provider_request_state<>'FAILED'))
      AND NOT EXISTS(SELECT 1 FROM zzsh_order.owner_guarantee_refund x WHERE x.requirement_id=r.id AND x.status<>'FAILED')
      AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_order o WHERE o.account_id=a.id AND
        (o.status IN ('PENDING_PAYMENT','PAID','COMPLETED') OR EXISTS(SELECT 1 FROM zzsh_order.rental_opening op WHERE op.order_id=o.id AND op.status='CONFIRMED')))
      AND NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_order_read_snapshot l WHERE l.account_id=a.id AND l.source_pay_status IS DISTINCT FROM 0)
      AND NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_inflight_register l WHERE l.account_id=a.id)
  ) THEN RAISE EXCEPTION 'automatic guarantee refund evidence is unavailable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER owner_guarantee_auto_refund_guard BEFORE INSERT OR UPDATE ON zzsh_order.owner_guarantee_refund
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_auto_delisted_guarantee_refund();
--> statement-breakpoint
COMMENT ON CONSTRAINT owner_guarantee_refund_release_decision_shape ON zzsh_order.owner_guarantee_refund IS '人工审核保留经办人；未出租账号下架后的自动退款由系统决策并绑定原款。';
--> statement-breakpoint
COMMENT ON COLUMN zzsh_order.owner_guarantee_refund.release_policy_state IS '退还规则状态；AUTO_APPROVED 表示未出租账号下架后由系统判断可退，不代表渠道到账。';
--> statement-breakpoint
COMMENT ON INDEX zzsh_order.owner_guarantee_refund_active_payment_uq IS '同笔号主保证金付款同时最多一笔未释放或已成功的退款责任。';
--> statement-breakpoint
COMMENT ON FUNCTION zzsh_order.guard_auto_delisted_guarantee_refund() IS '自动退保证金仅接受已下架、未出租账号和已确认的原保证金款项。';
--> statement-breakpoint
REVOKE ALL ON FUNCTION zzsh_order.guard_auto_delisted_guarantee_refund() FROM PUBLIC;
