-- Seal each posting through its existing PAID -> COMPLETED transaction boundary.
CREATE FUNCTION zzsh_order.settlement_snapshot_cents(value text) RETURNS numeric
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
BEGIN
  IF value !~ '^(0|[1-9][0-9]*)[.][0-9]{2}$' THEN
    RAISE EXCEPTION 'invalid settlement snapshot amount' USING ERRCODE = '23514';
  END IF;
  RETURN replace(value, '.', '')::numeric;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.guard_settlement_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'settlement ledger entries are immutable' USING ERRCODE = '40001';
  END IF;
  SELECT p.order_id, p.payment_confirmation_id, p.captured_cents,
         o.status, o.owner_user_id, o.renter_user_id
    INTO batch
    FROM zzsh_order.settlement_posting p
    JOIN zzsh_order.rental_order o ON o.id = p.order_id
   WHERE p.id = NEW.posting_id
   FOR UPDATE OF o;
  IF NOT FOUND OR batch.status IS DISTINCT FROM 'PAID' THEN
    RAISE EXCEPTION 'settlement posting batch is sealed or not assembling' USING ERRCODE = '40001';
  END IF;
  IF NEW.account_code = 'CAPTURED_PAYMENT_SOURCE' THEN
    IF NEW.debit_cents <> batch.captured_cents OR NEW.credit_cents <> 0
       OR NEW.source_payment_confirmation_id IS DISTINCT FROM batch.payment_confirmation_id
       OR NEW.counterparty_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'captured payment source entry is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.account_code = 'OWNER_AVAILABLE' THEN
    IF NEW.debit_cents <> 0 OR NEW.credit_cents <= 0
       OR NEW.counterparty_user_id IS DISTINCT FROM batch.owner_user_id
       OR NEW.source_payment_confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'owner available entry is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.account_code = 'RENTER_REFUND_PAYABLE' THEN
    IF NEW.debit_cents <> 0 OR NEW.credit_cents <= 0
       OR NEW.counterparty_user_id IS DISTINCT FROM batch.renter_user_id
       OR NEW.source_payment_confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'renter refund payable entry is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.account_code = 'PLATFORM_MANUAL_NET_ADJUSTMENT' THEN
    IF NEW.counterparty_user_id IS NOT NULL OR NEW.source_payment_confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'manual adjustment entry is invalid' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF NEW.debit_cents <> 0 OR NEW.credit_cents <= 0
       OR NEW.counterparty_user_id IS NOT NULL OR NEW.source_payment_confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'platform contribution entry is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER settlement_ledger_entry_guard ON zzsh_order.settlement_ledger_entry;
CREATE TRIGGER settlement_ledger_entry_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_order.settlement_ledger_entry
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_settlement_ledger_entry();

CREATE OR REPLACE FUNCTION zzsh_order.check_settlement_posting_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_posting_id text;
  batch record;
  ord record;
  ver record;
  payment record;
  approval record;
  sums record;
  snapshot_captured numeric;
  snapshot_system_owner numeric;
  snapshot_system_refund numeric;
  snapshot_platform numeric;
  snapshot_fee numeric;
  snapshot_haff numeric;
  snapshot_item numeric;
  snapshot_early numeric;
  expected_owner numeric;
  expected_refund numeric;
  expected_platform numeric;
  expected_adjustment numeric;
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
  SELECT kind, early, version_hash, superseded_at, approval_request_id, input_snapshot INTO ver
    FROM zzsh_order.settlement_version WHERE id = batch.settlement_version_id AND order_id = batch.order_id;
  SELECT order_id, amount_cents, currency, disposition INTO payment
    FROM zzsh_order.payment_confirmation WHERE id = batch.payment_confirmation_id;
  IF ord IS NULL OR ord.status IS DISTINCT FROM 'COMPLETED' OR ord.paid_confirmation_id IS DISTINCT FROM batch.payment_confirmation_id
     OR ver IS NULL OR ver.superseded_at IS NOT NULL OR ver.version_hash IS DISTINCT FROM batch.version_hash
     OR ver.early IS DISTINCT FROM batch.early OR payment IS NULL OR payment.order_id IS DISTINCT FROM batch.order_id
     OR payment.disposition <> 'APPLIED' OR payment.currency <> 'CNY' OR payment.amount_cents <> batch.captured_cents THEN
    RAISE EXCEPTION 'posting header is not bound to a completed order and its applied payment' USING ERRCODE = '23514';
  END IF;
  IF ver.input_snapshot IS NULL OR ver.input_snapshot->>'kind' IS DISTINCT FROM ver.kind
     OR ver.input_snapshot->>'early' IS DISTINCT FROM batch.early::text THEN
    RAISE EXCEPTION 'posting header is not bound to its settlement snapshot' USING ERRCODE = '23514';
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
       OR batch.approval_payload_hash IS DISTINCT FROM approval.operation_payload_hash
       OR batch.manual_reason IS DISTINCT FROM ver.input_snapshot->>'reason' THEN
      RAISE EXCEPTION 'posting requires the current valid non-self manual approval' USING ERRCODE = '23514';
    END IF;
  ELSIF batch.approval_request_id IS NOT NULL OR batch.manual_reason IS NOT NULL THEN
    RAISE EXCEPTION 'system settlement cannot bind a manual approval' USING ERRCODE = '23514';
  END IF;

  snapshot_captured := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'capturedAmount');
  snapshot_system_owner := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,ownerNet}');
  snapshot_system_refund := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,renterRefund}');
  snapshot_platform := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,platformContribution}');
  snapshot_fee := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,feeAmount}');
  snapshot_haff := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,haffSpread}');
  snapshot_item := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,itemSpread}');
  snapshot_early := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,earlyMakeup}');
  IF ver.kind = 'MANUAL_ADJUSTMENT' THEN
    expected_owner := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedOwnerNet');
    expected_refund := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedRenterRefund');
  ELSE
    expected_owner := snapshot_system_owner;
    expected_refund := snapshot_system_refund;
  END IF;
  IF snapshot_captured IS NULL OR snapshot_system_owner IS NULL OR snapshot_system_refund IS NULL OR snapshot_platform IS NULL
     OR snapshot_fee IS NULL OR snapshot_haff IS NULL OR snapshot_item IS NULL OR snapshot_early IS NULL
     OR expected_owner IS NULL OR expected_refund IS NULL THEN
    RAISE EXCEPTION 'settlement amount snapshot is incomplete' USING ERRCODE = '23514';
  END IF;
  expected_adjustment := snapshot_system_owner + snapshot_system_refund - expected_owner - expected_refund;
  expected_platform := snapshot_platform + expected_adjustment;
  IF batch.captured_cents <> snapshot_captured OR batch.system_owner_net_cents <> snapshot_system_owner
     OR batch.system_renter_refund_cents <> snapshot_system_refund OR batch.owner_net_cents <> expected_owner
     OR batch.renter_refund_cents <> expected_refund OR batch.platform_contribution_cents <> expected_platform
     OR batch.compensation_fee_cents <> snapshot_fee OR batch.captured_cents <> batch.owner_net_cents + batch.renter_refund_cents + batch.platform_contribution_cents THEN
    RAISE EXCEPTION 'posting header does not match the accepted settlement amounts' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer AS line_count,
         COALESCE(sum(debit_cents),0) AS debit_cents,
         COALESCE(sum(credit_cents),0) AS credit_cents,
         count(*) FILTER (WHERE account_code = 'CAPTURED_PAYMENT_SOURCE') AS source_count,
         COALESCE(sum(debit_cents) FILTER (WHERE account_code = 'CAPTURED_PAYMENT_SOURCE'),0) AS source_debit,
         COALESCE(sum(credit_cents) FILTER (WHERE account_code = 'CAPTURED_PAYMENT_SOURCE'),0) AS source_credit,
         count(*) FILTER (WHERE account_code = 'OWNER_AVAILABLE') AS owner_count,
         COALESCE(sum(credit_cents) FILTER (WHERE account_code = 'OWNER_AVAILABLE'),0) AS owner_cents,
         COALESCE(sum(debit_cents) FILTER (WHERE account_code = 'OWNER_AVAILABLE'),0) AS owner_debits,
         count(*) FILTER (WHERE account_code = 'RENTER_REFUND_PAYABLE') AS refund_count,
         COALESCE(sum(credit_cents) FILTER (WHERE account_code = 'RENTER_REFUND_PAYABLE'),0) AS refund_cents,
         COALESCE(sum(debit_cents) FILTER (WHERE account_code = 'RENTER_REFUND_PAYABLE'),0) AS refund_debits,
         count(*) FILTER (WHERE account_code = 'PLATFORM_HAFF_SPREAD') AS haff_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_HAFF_SPREAD'),0) AS haff_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_ITEM_SPREAD') AS item_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_ITEM_SPREAD'),0) AS item_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_EARLY_MAKEUP') AS early_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_EARLY_MAKEUP'),0) AS early_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_COMPENSATION_FEE') AS fee_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_COMPENSATION_FEE'),0) AS fee_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_MANUAL_NET_ADJUSTMENT') AS adjustment_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_MANUAL_NET_ADJUSTMENT'),0) AS adjustment_cents,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code LIKE 'PLATFORM_%'),0) AS platform_cents
    INTO sums FROM zzsh_order.settlement_ledger_entry AS entry WHERE entry.posting_id = v_posting_id;
  IF sums.line_count < 2 OR sums.debit_cents <> sums.credit_cents OR sums.source_count <> 1
     OR sums.source_debit <> batch.captured_cents OR sums.source_credit <> 0
     OR sums.owner_count <> (CASE WHEN expected_owner = 0 THEN 0 ELSE 1 END) OR sums.owner_cents <> expected_owner OR sums.owner_debits <> 0
     OR sums.refund_count <> (CASE WHEN expected_refund = 0 THEN 0 ELSE 1 END) OR sums.refund_cents <> expected_refund OR sums.refund_debits <> 0
     OR sums.haff_count <> (CASE WHEN snapshot_haff = 0 THEN 0 ELSE 1 END) OR sums.haff_cents <> snapshot_haff
     OR sums.item_count <> (CASE WHEN snapshot_item = 0 THEN 0 ELSE 1 END) OR sums.item_cents <> snapshot_item
     OR sums.early_count <> (CASE WHEN snapshot_early = 0 THEN 0 ELSE 1 END) OR sums.early_cents <> snapshot_early
     OR sums.fee_count <> (CASE WHEN snapshot_fee = 0 THEN 0 ELSE 1 END) OR sums.fee_cents <> snapshot_fee
     OR sums.adjustment_count <> (CASE WHEN expected_adjustment = 0 THEN 0 ELSE 1 END) OR sums.adjustment_cents <> expected_adjustment
     OR sums.platform_cents <> expected_platform THEN
    RAISE EXCEPTION 'settlement posting classifications are incomplete or inconsistent' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM zzsh_order.settlement_ledger_entry e WHERE e.posting_id = v_posting_id AND (
       (e.account_code = 'CAPTURED_PAYMENT_SOURCE' AND
         (e.details->>'paymentConfirmationId' IS DISTINCT FROM batch.payment_confirmation_id
          OR e.details->>'disposition' IS DISTINCT FROM 'APPLIED'
          OR e.details->>'fundingSourceRef' IS DISTINCT FROM ver.input_snapshot->>'fundingSourceRef'))
       OR (e.account_code = 'OWNER_AVAILABLE' AND
         (e.details->>'settlementVersionId' IS DISTINCT FROM batch.settlement_version_id
          OR e.details->>'versionHash' IS DISTINCT FROM batch.version_hash
          OR e.details #>> '{systemGross,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,ownerGross}'
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemNet') IS DISTINCT FROM snapshot_system_owner
          OR zzsh_order.settlement_snapshot_cents(e.details->>'postedNet') IS DISTINCT FROM expected_owner
          OR e.details->>'feePayer' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feePayer}'
          OR e.details #>> '{compensationFee,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feeAmount}'))
       OR (e.account_code = 'RENTER_REFUND_PAYABLE' AND
         (e.details->>'settlementVersionId' IS DISTINCT FROM batch.settlement_version_id
          OR e.details->>'versionHash' IS DISTINCT FROM batch.version_hash
          OR e.details->>'dueAt' IS NULL OR (e.details->>'dueAt')::timestamptz IS DISTINCT FROM batch.refund_due_at
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemRefund') IS DISTINCT FROM snapshot_system_refund
          OR e.details #>> '{depositRefund,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,depositRefund}'
          OR e.details #>> '{unusedItemRefund,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,unusedItemRefund}'
          OR e.details #>> '{unusedHaffRefund,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,unusedHaffRefund}'))
       OR (e.account_code = 'PLATFORM_HAFF_SPREAD' AND zzsh_order.settlement_snapshot_cents(e.details #>> '{amount,amount}') IS DISTINCT FROM snapshot_haff)
       OR (e.account_code = 'PLATFORM_ITEM_SPREAD' AND zzsh_order.settlement_snapshot_cents(e.details #>> '{amount,amount}') IS DISTINCT FROM snapshot_item)
       OR (e.account_code = 'PLATFORM_EARLY_MAKEUP' AND
         (zzsh_order.settlement_snapshot_cents(e.details #>> '{amount,amount}') IS DISTINCT FROM snapshot_early
          OR e.details->>'endReason' IS DISTINCT FROM ver.input_snapshot->>'endReason'))
       OR (e.account_code = 'PLATFORM_COMPENSATION_FEE' AND
         (e.details #>> '{base,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feeBase}'
          OR e.details->>'rate' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feeRate}'
          OR e.details->>'payer' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feePayer}'
          OR e.details->>'policyVersion' IS DISTINCT FROM ver.input_snapshot->>'feePolicyVersion'))
       OR (e.account_code = 'PLATFORM_MANUAL_NET_ADJUSTMENT' AND
         (e.details->>'reason' IS DISTINCT FROM ver.input_snapshot->>'reason'
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemOwnerNet') IS DISTINCT FROM snapshot_system_owner
          OR zzsh_order.settlement_snapshot_cents(e.details->>'postedOwnerNet') IS DISTINCT FROM expected_owner
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemRenterRefund') IS DISTINCT FROM snapshot_system_refund
          OR zzsh_order.settlement_snapshot_cents(e.details->>'postedRenterRefund') IS DISTINCT FROM expected_refund))
     )) THEN
    RAISE EXCEPTION 'settlement posting details do not match the accepted settlement snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
