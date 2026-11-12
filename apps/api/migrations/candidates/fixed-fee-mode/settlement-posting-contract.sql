-- Candidate only: keep fixed-fee publication and posting gated until transaction tests pass.
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint
   WHERE conrelid='zzsh_order.settlement_ledger_entry'::regclass AND conname='settlement_ledger_accounts';
  IF expression IS NULL THEN RAISE EXCEPTION 'settlement ledger account constraint is missing'; END IF;
  ALTER TABLE zzsh_order.settlement_ledger_entry DROP CONSTRAINT settlement_ledger_accounts;
  EXECUTE format('ALTER TABLE zzsh_order.settlement_ledger_entry ADD CONSTRAINT settlement_ledger_accounts CHECK((%s) OR (posting_id IS NOT NULL AND account_code IN (''PLATFORM_SERVICE_FEE'',''PLATFORM_MEMBER_DISCOUNT'')))',expression);
END $$;
COMMENT ON CONSTRAINT settlement_ledger_accounts ON zzsh_order.settlement_ledger_entry IS '限定资金流水科目，固定手续费订单单列平台手续费和会员优惠';

CREATE OR REPLACE FUNCTION zzsh_order.guard_settlement_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'settlement ledger entries are immutable' USING ERRCODE = '40001';
  END IF;
  SELECT p.order_id, p.payment_confirmation_id, p.captured_cents, v.input_snapshot->>'schema' AS settlement_schema,
         o.status, o.owner_user_id, o.renter_user_id
    INTO batch
    FROM zzsh_order.settlement_posting p
    JOIN zzsh_order.rental_order o ON o.id = p.order_id
    JOIN zzsh_order.settlement_version v ON v.id=p.settlement_version_id AND v.order_id=p.order_id
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
  ELSIF NEW.account_code = 'PLATFORM_MEMBER_DISCOUNT' THEN
    IF batch.settlement_schema IS DISTINCT FROM 'settlement-version-v4'
       OR NEW.debit_cents <= 0 OR NEW.credit_cents <> 0
       OR NEW.counterparty_user_id IS NOT NULL OR NEW.source_payment_confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'fixed fee member discount entry is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.account_code = 'PLATFORM_SERVICE_FEE' THEN
    IF batch.settlement_schema IS DISTINCT FROM 'settlement-version-v4'
       OR NEW.debit_cents <> 0 OR NEW.credit_cents <= 0
       OR NEW.counterparty_user_id IS NOT NULL OR NEW.source_payment_confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'fixed fee service entry is invalid' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (batch.settlement_schema = 'settlement-version-v4' AND NEW.account_code IN ('PLATFORM_HAFF_SPREAD','PLATFORM_ITEM_SPREAD'))
       OR NEW.debit_cents <> 0 OR NEW.credit_cents <= 0
       OR NEW.counterparty_user_id IS NOT NULL OR NEW.source_payment_confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'platform contribution entry is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

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
  applied_fee numeric;
  manual_gross numeric;
  payout_selected boolean;
  snapshot_haff numeric;
  snapshot_item numeric;
  snapshot_early numeric;
  is_fixed boolean;
  payout_quote jsonb;
  snapshot_gross numeric;
  snapshot_service numeric;
  applied_service numeric;
  snapshot_discount numeric;
  proposed_discount numeric;
  fixed_rate numeric;
  payable_ratio numeric;
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
  SELECT status, paid_confirmation_id, renter_user_id, owner_user_id, quote_snapshot, account_id, listing_version_id, content_hash, rule_release_id INTO ord
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
  is_fixed := COALESCE(ver.input_snapshot->>'schema' = 'settlement-version-v4',false);
  IF is_fixed IS DISTINCT FROM COALESCE(ord.quote_snapshot#>>'{personal,schema}' = 'personal-quote-v5',false) THEN
    RAISE EXCEPTION 'settlement and order pricing versions differ' USING ERRCODE = '23514';
  END IF;
  IF ord.quote_snapshot#>>'{personal,schema}'='personal-quote-v6' THEN
    payout_selected := zzsh_order.poststart_full_payout_selected(ord.quote_snapshot,ord.renter_user_id,ord.owner_user_id,ord.account_id,ord.listing_version_id,ord.content_hash,ord.rule_release_id);
    snapshot_gross := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,ownerGross}');
    snapshot_fee := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,feeAmount}');
    IF ver.input_snapshot->>'schema' IS DISTINCT FROM 'settlement-version-v3'
       OR ver.input_snapshot->>'personalQuoteSchema' IS DISTINCT FROM 'personal-quote-v6'
       OR payout_selected IS NULL OR jsonb_typeof(ver.input_snapshot->'fullPayoutSelected') IS DISTINCT FROM 'boolean'
       OR payout_selected IS DISTINCT FROM (ver.input_snapshot->>'fullPayoutSelected')::boolean
       OR snapshot_gross IS NULL OR snapshot_fee IS NULL
       OR snapshot_gross IS DISTINCT FROM (zzsh_order.settlement_snapshot_cents(ver.input_snapshot#>>'{amounts,haffConsumedOwner}')
         +zzsh_order.settlement_snapshot_cents(ver.input_snapshot#>>'{amounts,itemConsumedOwner}'))
       OR snapshot_fee IS DISTINCT FROM (CASE WHEN payout_selected THEN round(snapshot_gross*8/100) ELSE 0 END)
       OR zzsh_order.settlement_snapshot_cents(ver.input_snapshot#>>'{amounts,ownerNet}') IS DISTINCT FROM snapshot_gross-snapshot_fee
       OR NOT EXISTS(SELECT 1 FROM zzsh_order.rental_opening op WHERE op.order_id=batch.order_id AND op.id=ver.input_snapshot->>'openingId'
         AND op.status='CONFIRMED' AND op.version_no::text=ver.input_snapshot->>'openingVersion'
         AND op.quote_digest=ver.input_snapshot->>'quoteDigest' AND op.payment_digest=ver.input_snapshot->>'paymentDigest')
    THEN RAISE EXCEPTION 'scheduled spread settlement basis differs' USING ERRCODE='23514'; END IF;
  ELSIF ver.input_snapshot->>'personalQuoteSchema'='personal-quote-v6' THEN
    RAISE EXCEPTION 'scheduled spread settlement and order versions differ' USING ERRCODE='23514';
  END IF;
  IF is_fixed THEN
    IF ord.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '4'
       OR ord.quote_snapshot->>'mode' IS DISTINCT FROM 'PERCENT'
       OR ord.quote_snapshot#>>'{pricingInputs,fixedFeeAlgorithm}' IS DISTINCT FROM 'FIXED_TOTAL_V1'
       OR ord.quote_snapshot#>>'{settlementPricing,schema}' IS DISTINCT FROM 'settlement-pricing-v3'
       OR ord.quote_snapshot#>>'{personal,pricingPolicy,pricingModel}' IS DISTINCT FROM 'FIXED_FEE'
       OR COALESCE(ord.quote_snapshot#>>'{settlementPricing,fixedFeeRate}','') !~ '^(0|1)(\.[0-9]{1,8})?$'
       OR COALESCE(ord.quote_snapshot#>>'{settlementPricing,payableRatio}','') !~ '^(0|1)(\.[0-9]{1,8})?$'
       OR COALESCE(ord.quote_snapshot#>>'{pricingInputs,commissionRate}','') !~ '^(0|1)(\.[0-9]{1,8})?$'
    THEN RAISE EXCEPTION 'fixed fee order basis is incomplete' USING ERRCODE='23514'; END IF;
    fixed_rate := (ord.quote_snapshot#>>'{settlementPricing,fixedFeeRate}')::numeric;
    payable_ratio := (ord.quote_snapshot#>>'{settlementPricing,payableRatio}')::numeric;
    IF fixed_rate < 0 OR fixed_rate >= 1 OR payable_ratio < 0 OR payable_ratio > 1
       OR 1-payable_ratio > fixed_rate
       OR fixed_rate IS DISTINCT FROM (ord.quote_snapshot#>>'{pricingInputs,commissionRate}')::numeric THEN
      RAISE EXCEPTION 'fixed fee order rates are inconsistent' USING ERRCODE='23514';
    END IF;
    -- Reuse the existing identity-bound payout check without changing older cancellation behavior.
    payout_quote := jsonb_set(ord.quote_snapshot,'{personal,schema}',to_jsonb('personal-quote-v4'::text));
    payout_selected := zzsh_order.poststart_full_payout_selected(payout_quote,ord.renter_user_id,ord.owner_user_id,ord.account_id,ord.listing_version_id,ord.content_hash,ord.rule_release_id);
    IF payout_selected IS NULL OR jsonb_typeof(ver.input_snapshot->'fullPayoutSelected') IS DISTINCT FROM 'boolean'
       OR payout_selected IS DISTINCT FROM (ver.input_snapshot->>'fullPayoutSelected')::boolean THEN
      RAISE EXCEPTION 'fixed fee payout declaration is unavailable' USING ERRCODE='23514';
    END IF;
  END IF;
  -- Authorized support can finalize only the exact system version, with matching audit evidence.
  IF NOT EXISTS (
    SELECT 1 FROM zzsh_order.settlement_decision d
    JOIN zzsh_iam.audit_event a ON a.actor_type='admin' AND a.actor_id=d.subject_id
      AND a.action='order.settlement.support_finalized' AND a.object_type='rental_order'
      AND a.object_id=batch.order_id AND a.outcome='SUCCESS'
      AND a.details->>'settlementVersionId'=batch.settlement_version_id
      AND a.details->>'versionHash'=batch.version_hash AND a.details->>'reason'=d.reason
    JOIN zzsh_auth_admin."user" u ON u.id=d.subject_id AND NOT u.suspended
    WHERE d.settlement_version_id=batch.settlement_version_id AND d.party='SUPPORT'
      AND d.action='FINALIZE' AND d.version_hash=batch.version_hash AND ver.kind='SYSTEM'
      AND length(btrim(d.reason)) BETWEEN 3 AND 500
  ) THEN
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
  END IF;
  IF ver.kind = 'MANUAL_ADJUSTMENT' THEN
    SELECT status, requested_by, decided_by, operation_payload_hash, expires_at INTO approval
      FROM zzsh_iam.approval_request WHERE id = batch.approval_request_id;
    IF approval IS NULL OR approval.status <> 'APPROVED' OR approval.decided_by IS NULL
       OR approval.operation_payload_hash <> batch.version_hash
       OR approval.expires_at <= batch.posted_at OR batch.approval_request_id IS DISTINCT FROM ver.approval_request_id
       OR batch.approval_requested_by IS DISTINCT FROM approval.requested_by
       OR batch.approval_approved_by IS DISTINCT FROM approval.decided_by
       OR batch.approval_expires_at IS DISTINCT FROM approval.expires_at
       OR batch.approval_payload_hash IS DISTINCT FROM approval.operation_payload_hash
       OR batch.manual_reason IS DISTINCT FROM ver.input_snapshot->>'reason' THEN
      RAISE EXCEPTION 'posting requires the current valid manual approval' USING ERRCODE = '23514';
    END IF;
  ELSIF batch.approval_request_id IS NOT NULL OR batch.manual_reason IS NOT NULL THEN
    RAISE EXCEPTION 'system settlement cannot bind a manual approval' USING ERRCODE = '23514';
  END IF;

  snapshot_captured := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'capturedAmount');
  snapshot_system_owner := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,ownerNet}');
  snapshot_system_refund := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,renterRefund}');
  snapshot_platform := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,platformContribution}');
  snapshot_fee := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,feeAmount}');
  applied_fee := snapshot_fee;
  snapshot_haff := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,haffSpread}');
  snapshot_item := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,itemSpread}');
  snapshot_early := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,earlyMakeup}');
  applied_service := 0;
  IF is_fixed THEN
    snapshot_gross := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,ownerGross}');
    snapshot_service := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,platformServiceFee}');
    snapshot_discount := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,membershipDiscount}');
    IF snapshot_gross IS NULL OR snapshot_service IS NULL OR snapshot_discount IS NULL OR snapshot_fee IS NULL
       OR snapshot_platform IS NULL OR snapshot_system_owner IS NULL OR snapshot_early IS NULL
       OR snapshot_haff IS NULL OR snapshot_item IS NULL
       OR snapshot_service IS DISTINCT FROM round(snapshot_gross*fixed_rate)
       OR snapshot_discount IS DISTINCT FROM snapshot_gross-round(snapshot_gross*payable_ratio)
       OR snapshot_discount > snapshot_service
       OR snapshot_fee IS DISTINCT FROM (CASE WHEN payout_selected THEN round(snapshot_gross*8/100) ELSE 0 END)
       OR ver.input_snapshot #>> '{amounts,feePayer}' IS DISTINCT FROM (CASE WHEN payout_selected THEN 'OWNER' ELSE 'NONE' END)
       OR ver.input_snapshot #>> '{amounts,feeRate}' IS DISTINCT FROM (CASE WHEN payout_selected THEN '0.08' ELSE '0' END)
       OR (payout_selected AND zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,feeBase}') IS DISTINCT FROM snapshot_gross)
       OR snapshot_gross < snapshot_service+snapshot_fee
       OR snapshot_system_owner IS DISTINCT FROM snapshot_gross-snapshot_service-snapshot_fee
       OR snapshot_haff+snapshot_item IS DISTINCT FROM snapshot_service-snapshot_discount
       OR snapshot_platform IS DISTINCT FROM snapshot_service-snapshot_discount+snapshot_early+snapshot_fee THEN
      RAISE EXCEPTION 'fixed fee settlement amounts are inconsistent' USING ERRCODE='23514';
    END IF;
    applied_service := snapshot_service;
  END IF;
  IF ver.kind = 'MANUAL_ADJUSTMENT' THEN
    expected_owner := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedOwnerNet');
    expected_refund := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedRenterRefund');
    IF ver.input_snapshot ? 'proposedOwnerGross' THEN
      manual_gross := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedOwnerGross');
      applied_fee := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedFullPayoutFee');
      IF NOT is_fixed THEN
        payout_selected := CASE WHEN jsonb_typeof(ver.input_snapshot->'fullPayoutSelected')='boolean'
          THEN (ver.input_snapshot->>'fullPayoutSelected')::boolean ELSE NULL END;
      ELSE
        applied_service := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedPlatformServiceFee');
        -- The adjusted discount is for distribution only; the ledger retains the actual system discount.
        proposed_discount := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedMembershipDiscount');
      END IF;
      IF manual_gross IS NULL OR applied_fee IS NULL OR payout_selected IS NULL
         OR (NOT is_fixed AND zzsh_order.poststart_full_payout_selected(ord.quote_snapshot,ord.renter_user_id,ord.owner_user_id,ord.account_id,ord.listing_version_id,ord.content_hash,ord.rule_release_id) IS DISTINCT FROM payout_selected)
         OR applied_fee<>(CASE WHEN payout_selected THEN round(manual_gross*8/100) ELSE 0 END)
         OR (is_fixed AND (applied_service IS NULL OR proposed_discount IS NULL
           OR applied_service IS DISTINCT FROM round(manual_gross*fixed_rate)
           OR proposed_discount IS DISTINCT FROM round(manual_gross*(1-payable_ratio))))
         OR expected_owner IS DISTINCT FROM manual_gross-applied_fee-applied_service
         OR manual_gross+expected_refund>snapshot_captured THEN
        RAISE EXCEPTION 'manual settlement owner fee differs from the accepted basis' USING ERRCODE='23514';
      END IF;
    ELSIF is_fixed OR ver.input_snapshot->>'fullPayoutSelected'='true' THEN
      RAISE EXCEPTION 'manual settlement owner fee requires reconfirmation' USING ERRCODE='23514';
    END IF;
  ELSE
    expected_owner := snapshot_system_owner;
    expected_refund := snapshot_system_refund;
  END IF;
  IF snapshot_captured IS NULL OR snapshot_system_owner IS NULL OR snapshot_system_refund IS NULL OR snapshot_platform IS NULL
     OR snapshot_fee IS NULL OR snapshot_haff IS NULL OR snapshot_item IS NULL OR snapshot_early IS NULL
     OR expected_owner IS NULL OR expected_refund IS NULL THEN
    RAISE EXCEPTION 'settlement amount snapshot is incomplete' USING ERRCODE = '23514';
  END IF;
  expected_adjustment := snapshot_system_owner + snapshot_system_refund - expected_owner - expected_refund
    - (applied_fee-snapshot_fee) - (CASE WHEN is_fixed THEN applied_service-snapshot_service ELSE 0 END);
  expected_platform := snapshot_platform + (applied_fee-snapshot_fee) + expected_adjustment
    + (CASE WHEN is_fixed THEN applied_service-snapshot_service ELSE 0 END);
  IF batch.captured_cents <> snapshot_captured OR batch.system_owner_net_cents <> snapshot_system_owner
     OR batch.system_renter_refund_cents <> snapshot_system_refund OR batch.owner_net_cents <> expected_owner
     OR batch.renter_refund_cents <> expected_refund OR batch.platform_contribution_cents <> expected_platform
     OR batch.compensation_fee_cents <> applied_fee OR batch.captured_cents <> batch.owner_net_cents + batch.renter_refund_cents + batch.platform_contribution_cents THEN
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
         count(*) FILTER (WHERE account_code = 'PLATFORM_SERVICE_FEE') AS service_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_SERVICE_FEE'),0) AS service_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_MEMBER_DISCOUNT') AS discount_count,
         COALESCE(sum(debit_cents - credit_cents) FILTER (WHERE account_code = 'PLATFORM_MEMBER_DISCOUNT'),0) AS discount_cents,
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
     OR (is_fixed AND (sums.haff_count<>0 OR sums.item_count<>0
       OR sums.service_count<>(CASE WHEN applied_service=0 THEN 0 ELSE 1 END) OR sums.service_cents<>applied_service
       OR sums.discount_count<>(CASE WHEN snapshot_discount=0 THEN 0 ELSE 1 END) OR sums.discount_cents<>snapshot_discount))
     OR (NOT is_fixed AND (sums.service_count<>0 OR sums.discount_count<>0
       OR sums.haff_count<>(CASE WHEN snapshot_haff=0 THEN 0 ELSE 1 END) OR sums.haff_cents<>snapshot_haff
       OR sums.item_count<>(CASE WHEN snapshot_item=0 THEN 0 ELSE 1 END) OR sums.item_cents<>snapshot_item))
     OR sums.early_count <> (CASE WHEN snapshot_early = 0 THEN 0 ELSE 1 END) OR sums.early_cents <> snapshot_early
     OR sums.fee_count <> (CASE WHEN applied_fee = 0 THEN 0 ELSE 1 END) OR sums.fee_cents <> applied_fee
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
          OR e.details #>> '{compensationFee,amount}' IS DISTINCT FROM CASE WHEN manual_gross IS NULL THEN ver.input_snapshot #>> '{amounts,feeAmount}' ELSE ver.input_snapshot->>'proposedFullPayoutFee' END))
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
       OR (e.account_code = 'PLATFORM_SERVICE_FEE' AND
         (zzsh_order.settlement_snapshot_cents(e.details #>> '{amount,amount}') IS DISTINCT FROM applied_service
          OR zzsh_order.settlement_snapshot_cents(e.details #>> '{systemAmount,amount}') IS DISTINCT FROM snapshot_service))
       OR (e.account_code = 'PLATFORM_MEMBER_DISCOUNT' AND
         zzsh_order.settlement_snapshot_cents(e.details #>> '{amount,amount}') IS DISTINCT FROM snapshot_discount)
       OR (e.account_code = 'PLATFORM_EARLY_MAKEUP' AND
         (zzsh_order.settlement_snapshot_cents(e.details #>> '{amount,amount}') IS DISTINCT FROM snapshot_early
          OR e.details->>'endReason' IS DISTINCT FROM ver.input_snapshot->>'endReason'))
       OR (e.account_code = 'PLATFORM_COMPENSATION_FEE' AND
         (e.details #>> '{base,amount}' IS DISTINCT FROM CASE WHEN manual_gross IS NULL THEN ver.input_snapshot #>> '{amounts,feeBase}' ELSE ver.input_snapshot->>'proposedOwnerGross' END
          OR e.details->>'rate' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feeRate}'
          OR e.details->>'payer' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feePayer}'
          OR e.details->>'policyVersion' IS DISTINCT FROM ver.input_snapshot->>'feePolicyVersion'))
       OR (e.account_code = 'PLATFORM_MANUAL_NET_ADJUSTMENT' AND
         (e.details->>'reason' IS DISTINCT FROM ver.input_snapshot->>'reason'
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemOwnerNet') IS DISTINCT FROM snapshot_system_owner
          OR zzsh_order.settlement_snapshot_cents(e.details->>'postedOwnerNet') IS DISTINCT FROM expected_owner
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemRenterRefund') IS DISTINCT FROM snapshot_system_refund
          OR zzsh_order.settlement_snapshot_cents(e.details->>'postedRenterRefund') IS DISTINCT FROM expected_refund
          OR (manual_gross IS NOT NULL AND (CASE WHEN coalesce(e.details->>'deltaPayoutFee','')~'^-?(0|[1-9][0-9]*)\.[0-9]{2}$'
            THEN (e.details->>'deltaPayoutFee')::numeric*100 ELSE NULL END) IS DISTINCT FROM applied_fee-snapshot_fee)
          OR (is_fixed AND manual_gross IS NOT NULL AND (CASE WHEN coalesce(e.details->>'deltaPlatformServiceFee','')~'^-?(0|[1-9][0-9]*)\.[0-9]{2}$'
            THEN (e.details->>'deltaPlatformServiceFee')::numeric*100 ELSE NULL END) IS DISTINCT FROM applied_service-snapshot_service)))
     )) THEN
    RAISE EXCEPTION 'settlement posting details do not match the accepted settlement snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
