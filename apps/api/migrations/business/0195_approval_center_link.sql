-- 0195: approval center link - self approval allowed, approval effective on decision,
-- compensation is Boss-only. Sealed migrations are never edited: the three functions
-- below are copied verbatim from their FINAL definitions (0162 L11-208, 0158 L389-470,
-- 0178 L207-294) with only the noted conditions changed. Constraint: DROP then ADD
-- (relaxation only); functions use CREATE OR REPLACE. Safe to run on a populated DB.

--> statement-breakpoint
ALTER TABLE zzsh_order.settlement_posting DROP CONSTRAINT IF EXISTS settlement_posting_check2;
ALTER TABLE zzsh_order.settlement_posting ADD CONSTRAINT settlement_posting_check2 CHECK (
  (approval_request_id IS NULL AND approval_requested_by IS NULL AND approval_approved_by IS NULL
      AND approval_expires_at IS NULL AND approval_payload_hash IS NULL)
   OR (approval_request_id IS NOT NULL AND approval_requested_by IS NOT NULL AND approval_approved_by IS NOT NULL
       AND approval_expires_at > posted_at AND approval_payload_hash IS NOT NULL));
--> statement-breakpoint
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
--> statement-breakpoint
CREATE OR REPLACE FUNCTION zzsh_order.guard_rental_referral_earning() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b zzsh_order.payment_distribution_basis;p zzsh_order.settlement_posting;root zzsh_order.finance_economic_root;doc jsonb;role jsonb;seed jsonb;base numeric;expected numeric;n numeric;d numeric;available numeric;pair_total numeric;pair_role jsonb;
 posting_source jsonb;posting_hash text;key_value text;due_value timestamptz;due_text text;items jsonb:='[]'::jsonb;item jsonb;own_item jsonb;allocation_hash text;expected_seed jsonb;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'earning obligation cannot be deleted' USING ERRCODE='40001';END IF;
 IF TG_OP='UPDATE' THEN
  IF (NEW.id,NEW.economic_root_id,NEW.economic_key,NEW.order_id,NEW.payment_confirmation_id,NEW.posting_id,NEW.beneficiary_user_id,NEW.beneficiary_role,NEW.amount_cents,NEW.due_at,NEW.basis_digest,NEW.posting_digest,NEW.canonical_seed,NEW.seed_digest,NEW.created_xid,NEW.created_at)
   IS DISTINCT FROM(OLD.id,OLD.economic_root_id,OLD.economic_key,OLD.order_id,OLD.payment_confirmation_id,OLD.posting_id,OLD.beneficiary_user_id,OLD.beneficiary_role,OLD.amount_cents,OLD.due_at,OLD.basis_digest,OLD.posting_digest,OLD.canonical_seed,OLD.seed_digest,OLD.created_xid,OLD.created_at)
   OR NEW.version<>OLD.version+1
  THEN RAISE EXCEPTION 'original earning source/amount/due immutable and next CAS required' USING ERRCODE='40001';END IF;
  IF NOT(OLD.state='PENDING' AND NEW.state IN('SETTLED','REVOKED') OR OLD.state='SETTLED' AND NEW.state IN('REVOKED','RECOVERY_REQUIRED') OR OLD.state='RECOVERY_REQUIRED' AND NEW.state='REVOKED')
  THEN RAISE EXCEPTION 'earning state transition invalid' USING ERRCODE='23514';END IF;
  IF NEW.state='SETTLED' AND clock_timestamp()<OLD.due_at THEN RAISE EXCEPTION 'earning cannot settle before original due' USING ERRCODE='23514';END IF;
  PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.beneficiary_user_id FOR UPDATE;
  IF NEW.state='RECOVERY_REQUIRED' THEN
   SELECT COALESCE(sum(credit_cents-debit_cents),0) INTO available FROM zzsh_order.settlement_ledger_entry
    WHERE counterparty_user_id=NEW.beneficiary_user_id AND account_code IN('OWNER_AVAILABLE','WALLET_AVAILABLE');
   IF available>=OLD.amount_cents OR NEW.recovery_required_cents IS DISTINCT FROM OLD.amount_cents OR NEW.funds_disposition<>'SETTLED'
   THEN RAISE EXCEPTION 'recovery requires actual shortfall and original settled funds' USING ERRCODE='23514';END IF;
  END IF;RETURN NEW;
 END IF;
 SELECT * INTO b FROM zzsh_order.payment_distribution_basis WHERE order_id=NEW.order_id AND payment_confirmation_id=NEW.payment_confirmation_id;
 SELECT * INTO p FROM zzsh_order.settlement_posting WHERE id=NEW.posting_id AND order_id=NEW.order_id AND payment_confirmation_id=NEW.payment_confirmation_id;
 SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;doc:=b.canonical_basis::jsonb;seed:=NEW.canonical_seed::jsonb;
 SELECT value INTO role FROM jsonb_array_elements(doc->'roles') WHERE value->>'role'=NEW.beneficiary_role AND value->>'beneficiaryUserId'=NEW.beneficiary_user_id;
 IF b.id IS NULL OR p.id IS NULL OR root.id IS NULL OR root.created_xid<>pg_current_xact_id() OR root.source_id<>NEW.order_id
  OR root.subject_user_id<>NEW.beneficiary_user_id OR root.beneficiary_role<>NEW.beneficiary_role OR root.source_digest<>NEW.posting_digest
  OR NEW.basis_digest<>b.basis_digest OR role IS NULL OR role->>'status'<>'ELIGIBLE'
  OR p.platform_contribution_cents<p.compensation_fee_cents
  OR p.manual_reason IS NOT NULL AND(p.approval_request_id IS NULL OR p.approval_requested_by IS NULL
   OR p.approval_approved_by IS NULL
   OR p.approval_payload_hash IS DISTINCT FROM p.version_hash OR p.approval_expires_at IS NULL OR p.approval_expires_at<=p.posted_at)
  OR p.owner_net_cents+p.renter_refund_cents+p.platform_contribution_cents<>p.captured_cents
  OR NEW.state<>'PENDING' OR NEW.version<>1 OR NEW.funds_disposition<>'PENDING' OR NEW.recovery_required_cents IS NOT NULL
 THEN RAISE EXCEPTION 'earning must derive from original closed posting/payment role' USING ERRCODE='23514';END IF;
 n:=(role#>>'{ratio,numerator}')::numeric;d:=(role#>>'{ratio,denominator}')::numeric;base:=CASE WHEN (doc#>>'{policyConfig,schema}'='distribution-policy.v3' OR doc#>>'{policyConfig,schema}'='distribution-policy.v4' AND doc#>>'{policyConfig,baseMode}'='LEGACY_RENTAL') THEN p.captured_cents-p.owner_net_cents-p.renter_refund_cents ELSE p.platform_contribution_cents-p.compensation_fee_cents END;
 IF n IS NULL OR d IS NULL OR n<0 OR d<=0 OR n>d THEN RAISE EXCEPTION 'original referral ratio invalid' USING ERRCODE='23514';END IF;
 expected:=floor(base*n/d+0.5);
 posting_source:=jsonb_build_object('id',p.id,'order_id',p.order_id,'payment_confirmation_id',p.payment_confirmation_id,
  'version_hash',p.version_hash,'early',p.early,'manual_reason',p.manual_reason,'captured_cents',p.captured_cents::text,
  'owner_net_cents',p.owner_net_cents::text,'renter_refund_cents',p.renter_refund_cents::text,
  'platform_contribution_cents',p.platform_contribution_cents::text,'compensation_fee_cents',p.compensation_fee_cents::text,
  'posted_at',to_char(p.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 posting_hash:=encode(sha256(convert_to(zzsh_order.canonical_finance_json(posting_source),'UTF8')),'hex');
 due_value:=((p.posted_at AT TIME ZONE 'UTC')+((doc#>>'{policyConfig,settlementDelayDays}')::integer*interval '1 day')) AT TIME ZONE 'UTC';
 due_text:=to_char(due_value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
 -- Validate the complete frozen pair even when only one earning is being inserted.
 -- Otherwise direct SQL could mint two individually valid shares exceeding the base.
 pair_total:=0;
 FOR pair_role IN SELECT value FROM jsonb_array_elements(doc->'roles') LOOP
  IF pair_role->>'status' LIKE 'UNKNOWN%' THEN RAISE EXCEPTION 'unknown counterpart cannot authorize partial accrual' USING ERRCODE='23514';END IF;
  IF pair_role->>'status'='ELIGIBLE' THEN
   n:=(pair_role#>>'{ratio,numerator}')::numeric;d:=(pair_role#>>'{ratio,denominator}')::numeric;
   IF n IS NULL OR d IS NULL OR n<0 OR d<=0 OR n>d THEN RAISE EXCEPTION 'counterpart ratio invalid' USING ERRCODE='23514';END IF;
   pair_total:=pair_total+floor(base*n/d+0.5);
   key_value:=zzsh_order.canonical_finance_json(jsonb_build_array('NATIVE_RENTAL_REFERRAL','NATIVE','zzsh','rental_order',NEW.order_id,pair_role->>'beneficiaryUserId',pair_role->>'role'));
   item:=jsonb_build_object('economicKey',key_value,'beneficiaryUserId',pair_role->>'beneficiaryUserId','role',pair_role->>'role',
    'amountCents',floor(base*n/d+0.5)::numeric(24,0)::text,'dueAt',due_text,'policyVersion',doc->>'policyVersion',
    'basisDigest',b.basis_digest,'postingDigest',posting_hash,'relationDigest',pair_role->>'relationDigest');
   items:=items||jsonb_build_array(item);
   IF pair_role->>'role'=NEW.beneficiary_role AND pair_role->>'beneficiaryUserId'=NEW.beneficiary_user_id THEN own_item:=item;END IF;
  END IF;
 END LOOP;
 IF pair_total>base THEN RAISE EXCEPTION 'rounded referral pair exceeds original base without subsidy' USING ERRCODE='23514';END IF;
 allocation_hash:=encode(sha256(convert_to(zzsh_order.canonical_finance_json(jsonb_build_object('orderId',NEW.order_id,
  'confirmationId',NEW.payment_confirmation_id,'basisDigest',b.basis_digest,'postingId',p.id,'postingDigest',posting_hash,
  'base',base::numeric(24,0)::text,'items',items)),'UTF8')),'hex');
 expected_seed:=jsonb_build_object('id',NEW.id,'economicKey',own_item->>'economicKey',
  'source',jsonb_build_object('kind','NATIVE_RENTAL_REFERRAL','type','NATIVE','system','zzsh','entity','rental_order','id',NEW.order_id,
   'digest',posting_hash,'eventAt',to_char(p.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')),
  'beneficiaryUserId',NEW.beneficiary_user_id,'role',NEW.beneficiary_role,'policyVersion',doc->>'policyVersion',
  'policyDigest',doc->>'policyDigest','baseDigest',allocation_hash,'relationDigest',role->>'relationDigest',
  'amountCents',expected::numeric(24,0)::text,'dueAt',due_text,
  'fingerprint',encode(sha256(convert_to(zzsh_order.canonical_finance_json(own_item),'UTF8')),'hex'),
  'state','PENDING','fundsDisposition','PENDING','recoveryRequiredCents',NULL,'version','1');
 IF NEW.amount_cents<>expected OR NEW.due_at IS DISTINCT FROM due_value OR own_item IS NULL
  OR NEW.posting_digest IS DISTINCT FROM posting_hash OR NEW.economic_key IS DISTINCT FROM own_item->>'economicKey'
  OR NEW.id IS DISTINCT FROM 'earning_'||encode(sha256(convert_to(NEW.economic_key,'UTF8')),'hex')
  OR seed IS DISTINCT FROM expected_seed OR NEW.canonical_seed IS DISTINCT FROM zzsh_order.canonical_finance_json(expected_seed)
 THEN RAISE EXCEPTION 'earning amount/due/seed differs from original frozen derivation' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION zzsh_order.post_order_compensation(request_value text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a zzsh_iam.approval_request;d zzsh_iam.approval_decision;doc jsonb;native zzsh_order.rental_order;legacy zzsh_order.legacy_order_read_snapshot;
 actor_value text:=current_setting('zzsh.actor_id',true);session_value text:=current_setting('zzsh.session_id',true);trace_value text:=current_setting('zzsh.request_id',true);
 boss boolean;owner_value text;renter_value text;game_value text;source_value text;payment_id text;paid_cents text;proof jsonb;
 case_id text;root_id text;event_id text;rev bigint;available numeric;amount_value numeric;entry_details jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin'
  OR COALESCE(length(actor_value),0)=0 OR COALESCE(length(session_value),0)=0 OR COALESCE(length(trace_value),0)=0 OR length(trace_value)>128
 THEN RAISE EXCEPTION 'compensation session unavailable' USING ERRCODE='42501';END IF;
 SELECT sec.is_boss INTO boss FROM zzsh_iam.admin_security sec JOIN zzsh_auth_admin."user" u ON u.id=sec.admin_user_id
  JOIN zzsh_auth_admin."session" s ON s."userId"=u.id AND s.id=session_value
  WHERE sec.admin_user_id=actor_value AND sec.status='ACTIVE' AND NOT sec.password_change_required AND NOT u.suspended
   AND u."twoFactorEnabled" IS TRUE AND NOT s.locked AND s."expiresAt">clock_timestamp() FOR SHARE OF sec,u,s;
 IF boss IS NULL THEN RAISE EXCEPTION 'compensation actor unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO a FROM zzsh_iam.approval_request WHERE id=request_value FOR UPDATE;
 SELECT * INTO d FROM zzsh_iam.approval_decision WHERE request_id=request_value;
 doc:=a.operation_payload;
 IF a.id IS NULL OR a.operation_code<>'order.compensation.grant' OR a.payload_version<>1 OR a.status<>'APPROVED'
  OR a.expires_at<=clock_timestamp() OR a.decided_by IS DISTINCT FROM actor_value OR d.decision<>'APPROVED' OR d.approver_admin_id IS DISTINCT FROM actor_value
  OR jsonb_typeof(doc)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(doc))<>10
  OR NOT(doc ?& ARRAY['schema','orderId','origin','gameId','ownerUserId','sourceDigest','amountCents','caseRef','reason','evidenceRef'])
  OR EXISTS(SELECT 1 FROM jsonb_each(doc) field WHERE jsonb_typeof(field.value)<>'string') OR doc->>'schema'<>'order-compensation.v1'
  OR encode(sha256(convert_to(zzsh_order.canonical_finance_json(doc),'UTF8')),'hex') IS DISTINCT FROM a.operation_payload_hash
  OR doc->>'origin' NOT IN('NATIVE','LEGACY') OR COALESCE(doc->>'orderId','')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR COALESCE(doc->>'amountCents','')!~'^[1-9][0-9]{0,15}$' OR COALESCE(doc->>'sourceDigest','')!~'^[a-f0-9]{64}$'
  OR length(trim(COALESCE(doc->>'caseRef',''))) NOT BETWEEN 3 AND 120 OR length(trim(COALESCE(doc->>'reason',''))) NOT BETWEEN 3 AND 500
  OR length(trim(COALESCE(doc->>'evidenceRef',''))) NOT BETWEEN 3 AND 200 OR doc->>'caseRef' IS DISTINCT FROM trim(doc->>'caseRef')
  OR doc->>'reason' IS DISTINCT FROM trim(doc->>'reason') OR doc->>'evidenceRef' IS DISTINCT FROM trim(doc->>'evidenceRef')
  OR ((doc->>'caseRef')||(doc->>'reason')||(doc->>'evidenceRef'))~'[[:cntrl:]]'
  OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE action='approval.request.approved' AND object_type='approval_request' AND object_id=a.id
   AND actor_type='admin' AND actor_id=actor_value AND session_id=session_value AND request_id=trace_value AND outcome='SUCCESS')
 THEN RAISE EXCEPTION 'compensation approval unavailable' USING ERRCODE='23514';END IF;
  IF NOT boss THEN RAISE EXCEPTION 'compensation approval requires the Boss role' USING ERRCODE='42501';END IF;
IF doc->>'origin'='NATIVE' THEN
  SELECT * INTO native FROM zzsh_order.rental_order WHERE id=doc->>'orderId';owner_value:=native.owner_user_id;renter_value:=native.renter_user_id;
 ELSE SELECT * INTO legacy FROM zzsh_order.legacy_order_read_snapshot WHERE id=doc->>'orderId';owner_value:=legacy.owner_user_id;renter_value:=legacy.renter_user_id;END IF;
 IF owner_value IS NULL OR renter_value IS NULL THEN RAISE EXCEPTION 'compensation order unavailable' USING ERRCODE='23514';END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id IN(owner_value,renter_value) ORDER BY id COLLATE "C" FOR UPDATE;
 IF doc->>'origin'='NATIVE' THEN
  SELECT * INTO native FROM zzsh_order.rental_order WHERE id=doc->>'orderId' FOR SHARE;
  SELECT c.id,c.amount_cents::text INTO payment_id,paid_cents FROM zzsh_order.payment_confirmation c WHERE c.id=native.paid_confirmation_id AND c.order_id=native.id AND c.disposition='APPLIED' AND c.currency='CNY' AND c.amount_cents=native.rental_amount_cents+native.deposit_amount_cents;
  game_value:=native.game_id;
  IF native.owner_user_id IS DISTINCT FROM owner_value OR native.renter_user_id IS DISTINCT FROM renter_value OR payment_id IS NULL OR paid_cents!~'^[1-9][0-9]{0,15}$'
   OR native.quote_snapshot#>>'{personal,fullPayoutDeclaration,schema}'<>'full-payout-declaration-v1'
   OR native.quote_snapshot#>'{personal,fullPayoutDeclaration,selected}' IS DISTINCT FROM 'true'::jsonb
   OR native.quote_snapshot#>>'{personal,ownerUserId}' IS DISTINCT FROM native.owner_user_id OR native.quote_snapshot#>>'{personal,userId}' IS DISTINCT FROM native.renter_user_id
   OR native.quote_snapshot#>>'{personal,accountId}' IS DISTINCT FROM native.account_id OR native.quote_snapshot#>>'{personal,listingVersionId}' IS DISTINCT FROM native.listing_version_id
   OR native.quote_snapshot#>>'{personal,listingHash}' IS DISTINCT FROM native.content_hash OR native.quote_snapshot->>'listingHash' IS DISTINCT FROM native.content_hash
   OR native.quote_snapshot#>>'{personal,ruleRefs,releaseId}' IS DISTINCT FROM native.rule_release_id
   OR COALESCE(native.quote_snapshot->>'confirmationDigest','')!~'^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'compensation native source unavailable' USING ERRCODE='23514';END IF;
  proof:=jsonb_build_object('origin','NATIVE','orderId',native.id,'gameId',game_value,'ownerUserId',owner_value,'paymentId',payment_id,'paidCents',paid_cents,'confirmationDigest',native.quote_snapshot->>'confirmationDigest');
 ELSE
  SELECT * INTO legacy FROM zzsh_order.legacy_order_read_snapshot WHERE id=doc->>'orderId' FOR SHARE;game_value:=legacy.game_id;
  IF legacy.owner_user_id IS DISTINCT FROM owner_value OR legacy.renter_user_id IS DISTINCT FROM renter_value OR legacy.source_pay_status<>1
   OR legacy.source_snapshot->>'pay_is' IS DISTINCT FROM '1' OR legacy.source_snapshot->>'sale_user_id' IS DISTINCT FROM legacy.legacy_owner_id
   OR encode(sha256(convert_to(zzsh_order.canonical_finance_json(legacy.source_snapshot),'UTF8')),'hex') IS DISTINCT FROM legacy.source_digest
  THEN RAISE EXCEPTION 'compensation legacy source unavailable' USING ERRCODE='23514';END IF;
  proof:=jsonb_build_object('origin','LEGACY','orderId',legacy.id,'gameId',game_value,'ownerUserId',owner_value,'sourceDigest',legacy.source_digest);
 END IF;
 source_value:=encode(sha256(convert_to(zzsh_order.canonical_finance_json(proof),'UTF8')),'hex');
 IF owner_value IS DISTINCT FROM doc->>'ownerUserId' OR game_value IS DISTINCT FROM doc->>'gameId' OR source_value IS DISTINCT FROM doc->>'sourceDigest'
 THEN RAISE EXCEPTION 'compensation source changed' USING ERRCODE='23514';END IF;
 SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=owner_value FOR UPDATE;
 SELECT coalesce(sum(credit_cents-debit_cents),0) INTO available FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=owner_value AND account_code IN('OWNER_AVAILABLE','WALLET_AVAILABLE');
 IF rev IS NULL OR available<0 OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage WHERE user_id=owner_value) THEN RAISE EXCEPTION 'compensation wallet unavailable' USING ERRCODE='23514';END IF;
 amount_value:=(doc->>'amountCents')::numeric;case_id:='comp_'||substr(encode(sha256(convert_to(a.id,'UTF8')),'hex'),1,40);root_id:='comp_root_'||substr(encode(sha256(convert_to(a.id,'UTF8')),'hex'),1,40);event_id:='comp_event_'||substr(encode(sha256(convert_to(a.id,'UTF8')),'hex'),1,40);
 INSERT INTO zzsh_order.order_compensation_posting(id,approval_request_id,order_origin,order_id,game_id,owner_user_id,source_digest,amount_cents,case_ref,reason,evidence_ref,requested_by,approved_by,root_id,event_id,payload_digest)
  VALUES(case_id,a.id,doc->>'origin',doc->>'orderId',game_value,owner_value,source_value,amount_value,doc->>'caseRef',doc->>'reason',doc->>'evidenceRef',a.requested_by,actor_value,root_id,event_id,a.operation_payload_hash);
 INSERT INTO zzsh_order.finance_economic_root(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,policy_version,source_digest)
  VALUES(root_id,NULL,'ORDER_COMPENSATION','NATIVE','zzsh','order_compensation',case_id,owner_value,'OWNER','order-compensation-v1',a.operation_payload_hash);
 INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision) VALUES(event_id,root_id,'ORDER_COMPENSATION_PAID',owner_value,rev);
 entry_details:=jsonb_build_object('compensationCaseId',case_id,'approvalRequestId',a.id,'orderId',doc->>'orderId','origin',doc->>'origin');
 INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
 VALUES(case_id||'_1',event_id,1,'PLATFORM_COMPENSATION_EXPENSE',amount_value,0,NULL,entry_details),
       (case_id||'_2',event_id,2,'WALLET_AVAILABLE',0,amount_value,owner_value,entry_details);
 INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,reason,occurred_at,details)
 VALUES('audit_'||replace(gen_random_uuid()::text,'-',''),'admin',actor_value,session_value,'order.compensation.posted','order_compensation',case_id,'SUCCESS',trace_value,doc->>'reason',clock_timestamp(),entry_details||jsonb_build_object('ownerUserId',owner_value,'amountCents',amount_value::text,'sourceDigest',source_value));
 RETURN jsonb_build_object('caseId',case_id,'eventId',event_id);
END $$;
--> statement-breakpoint
-- Owner 2026-11-10: compensation approval belongs to Boss only; revoke 0178:6 ops preset grant.
DELETE FROM zzsh_iam.admin_role_permission WHERE role_id = 'role_preset_ops' AND permission_code = 'order.compensation.approve';
COMMENT ON FUNCTION zzsh_order.post_order_compensation(text) IS 'Boss 批准后在审批事务中将包赔赔款记入号主余额；不再依赖候选快照。';
