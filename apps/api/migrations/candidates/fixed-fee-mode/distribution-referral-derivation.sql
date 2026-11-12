-- Candidate only. Both individual earnings and task completion use this frozen derivation.
CREATE FUNCTION zzsh_order.derive_frozen_referral_accrual(posting_value text) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
 p zzsh_order.settlement_posting;b zzsh_order.payment_distribution_basis;
 ord zzsh_order.rental_order;pay zzsh_order.payment_confirmation;ver zzsh_order.settlement_version;
 doc jsonb;payment_source jsonb;posting_source jsonb;posting_hash text;due_value timestamptz;due_text text;
 pricing jsonb;gross numeric;service numeric;discount numeric;rate numeric;payable numeric;base numeric;
 pair_role jsonb;n numeric;d numeric;commission numeric;pair_total numeric:=0;key_value text;item jsonb;items jsonb:='[]'::jsonb;
 allocation_hash text;
BEGIN
 SELECT * INTO p FROM zzsh_order.settlement_posting WHERE id=posting_value;
 IF p.id IS NULL THEN RAISE EXCEPTION 'original referral posting unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO b FROM zzsh_order.payment_distribution_basis WHERE order_id=p.order_id AND payment_confirmation_id=p.payment_confirmation_id;
 SELECT * INTO ord FROM zzsh_order.rental_order WHERE id=p.order_id;
 SELECT * INTO pay FROM zzsh_order.payment_confirmation WHERE id=p.payment_confirmation_id AND order_id=p.order_id;
 IF b.id IS NULL OR ord.id IS NULL OR ord.status IS DISTINCT FROM 'COMPLETED' OR ord.paid_confirmation_id IS DISTINCT FROM p.payment_confirmation_id
  OR pay.id IS NULL OR pay.disposition IS DISTINCT FROM 'APPLIED' OR pay.currency IS DISTINCT FROM 'CNY'
  OR pay.amount_cents IS DISTINCT FROM p.captured_cents OR p.currency IS DISTINCT FROM pay.currency
 THEN RAISE EXCEPTION 'original referral order or payment unavailable' USING ERRCODE='23514'; END IF;
 doc:=b.canonical_basis::jsonb;
 payment_source:=jsonb_build_object('id',pay.id,'order_id',pay.order_id,'source',pay.source,'merchant_scope_id',pay.merchant_scope_id,
  'provider_transaction_id',pay.provider_transaction_id,'merchant_order_no',pay.merchant_order_no,'amount_cents',pay.amount_cents::text,
  'currency',pay.currency,'provider_paid_at',to_char(pay.provider_paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'accepted_at',to_char(pay.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 IF jsonb_typeof(doc) IS DISTINCT FROM 'object' OR COALESCE(doc->>'schema','') NOT IN ('payment-distribution-basis.v1','payment-distribution-basis.v2')
  OR doc->>'orderId' IS DISTINCT FROM p.order_id OR doc->>'confirmationId' IS DISTINCT FROM p.payment_confirmation_id
  OR doc->>'admissionId' IS DISTINCT FROM b.admission_id OR doc->>'admissionRevision' IS DISTINCT FROM b.admission_revision::text
  OR doc->>'gameId' IS DISTINCT FROM ord.game_id OR doc->>'currency' IS DISTINCT FROM ord.currency
  OR doc->>'acceptedAt' IS DISTINCT FROM to_char(pay.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  OR doc->>'paymentDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(payment_source),'UTF8')),'hex')
  OR b.canonical_basis IS DISTINCT FROM zzsh_order.canonical_finance_json(doc)
  OR b.basis_digest IS DISTINCT FROM encode(sha256(convert_to(b.canonical_basis,'UTF8')),'hex')
  OR jsonb_typeof(doc->'policyConfig') IS DISTINCT FROM 'object' OR jsonb_typeof(doc->'policyVersion') IS DISTINCT FROM 'string'
  OR COALESCE(doc->>'policyVersion','')='' OR jsonb_typeof(doc->'policyDigest') IS DISTINCT FROM 'string'
  OR COALESCE(doc->>'policyDigest','') !~ '^[0-9a-f]{64}$'
  OR doc->>'policyDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(doc->'policyConfig'),'UTF8')),'hex')
  OR jsonb_typeof(doc->'roles') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'original frozen referral basis unavailable' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(doc->'roles')<>2 OR (SELECT count(DISTINCT r->>'role') FROM jsonb_array_elements(doc->'roles') r
  WHERE r->>'role' IN ('RENTER_REFERRAL','OWNER_REFERRAL'))<>2
  OR COALESCE(doc#>>'{policyConfig,settlementDelayDays}','') !~ '^(0|[1-9][0-9]{0,5})$'
  OR COALESCE(doc#>>'{policyConfig,minimumAccrualCents}','') !~ '^(0|[1-9][0-9]{0,23})$'
  OR p.platform_contribution_cents<p.compensation_fee_cents
  OR p.manual_reason IS NOT NULL AND (p.approval_request_id IS NULL OR p.approval_requested_by IS NULL OR p.approval_approved_by IS NULL
   OR p.approval_payload_hash IS DISTINCT FROM p.version_hash OR p.approval_expires_at IS NULL OR p.approval_expires_at<=p.posted_at)
  OR p.owner_net_cents+p.renter_refund_cents+p.platform_contribution_cents<>p.captured_cents
 THEN RAISE EXCEPTION 'original referral facts are incomplete' USING ERRCODE='23514'; END IF;

 IF doc->>'schema'='payment-distribution-basis.v2' THEN
  SELECT * INTO ver FROM zzsh_order.settlement_version WHERE id=p.settlement_version_id AND order_id=p.order_id;
  pricing:=doc->'fixedFeePricing';
  IF ord.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '4' OR ord.quote_snapshot#>>'{personal,schema}' IS DISTINCT FROM 'personal-quote-v5'
   OR ord.quote_snapshot#>>'{settlementPricing,schema}' IS DISTINCT FROM 'settlement-pricing-v3'
   OR jsonb_typeof(pricing) IS DISTINCT FROM 'object' OR pricing IS DISTINCT FROM jsonb_build_object(
      'fixedFeeRate',ord.quote_snapshot#>>'{settlementPricing,fixedFeeRate}','payableRatio',ord.quote_snapshot#>>'{settlementPricing,payableRatio}')
   OR COALESCE(pricing->>'fixedFeeRate','') !~ '^(0|1)(\.[0-9]{1,8})?$' OR COALESCE(pricing->>'payableRatio','') !~ '^(0|1)(\.[0-9]{1,8})?$'
   OR ver.id IS NULL OR ver.superseded_at IS NOT NULL OR ver.version_hash IS DISTINCT FROM p.version_hash
   OR ver.early IS DISTINCT FROM p.early OR ver.kind NOT IN ('SYSTEM','MANUAL_ADJUSTMENT')
   OR (ver.kind='SYSTEM') IS DISTINCT FROM (p.manual_reason IS NULL)
   OR ver.input_snapshot->>'schema' IS DISTINCT FROM 'settlement-version-v4'
   OR ver.input_snapshot->>'orderId' IS DISTINCT FROM p.order_id OR ver.input_snapshot->>'paymentConfirmationId' IS DISTINCT FROM p.payment_confirmation_id
   OR ver.input_snapshot->>'renterUserId' IS DISTINCT FROM ord.renter_user_id OR ver.input_snapshot->>'ownerUserId' IS DISTINCT FROM ord.owner_user_id
   OR ver.input_snapshot->>'listingVersionId' IS DISTINCT FROM ord.listing_version_id OR ver.input_snapshot->>'listingHash' IS DISTINCT FROM ord.content_hash
   OR ver.input_snapshot->>'kind' IS DISTINCT FROM ver.kind OR ver.input_snapshot->>'early' IS DISTINCT FROM p.early::text
   OR zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'capturedAmount') IS DISTINCT FROM p.captured_cents
   OR encode(sha256(convert_to(zzsh_order.canonical_finance_json(ver.input_snapshot),'UTF8')),'hex') IS DISTINCT FROM p.version_hash
   OR COALESCE(doc->>'accountMode','') NOT IN ('ordinary','custom','fast')
  THEN RAISE EXCEPTION 'fixed fee commission lacks a bound completed settlement' USING ERRCODE='23514'; END IF;
  rate:=(pricing->>'fixedFeeRate')::numeric;payable:=(pricing->>'payableRatio')::numeric;
  IF rate<0 OR rate>=1 OR payable<=0 OR payable>1 OR 1-payable>rate
   OR COALESCE(ord.quote_snapshot#>>'{pricingInputs,commissionRate}','') !~ '^(0|1)(\.[0-9]{1,8})?$'
   OR (ord.quote_snapshot#>>'{pricingInputs,commissionRate}')::numeric IS DISTINCT FROM rate
  THEN RAISE EXCEPTION 'fixed fee commission rates differ from the original order' USING ERRCODE='23514'; END IF;
  IF ver.kind='MANUAL_ADJUSTMENT' THEN
   gross:=zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedOwnerGross');
   service:=zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedPlatformServiceFee');
   discount:=zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedMembershipDiscount');
   IF discount IS DISTINCT FROM round(gross*(1-payable)) THEN RAISE EXCEPTION 'manual referral discount differs' USING ERRCODE='23514'; END IF;
  ELSE
   gross:=zzsh_order.settlement_snapshot_cents(ver.input_snapshot#>>'{amounts,ownerGross}');
   service:=zzsh_order.settlement_snapshot_cents(ver.input_snapshot#>>'{amounts,platformServiceFee}');
   discount:=zzsh_order.settlement_snapshot_cents(ver.input_snapshot#>>'{amounts,membershipDiscount}');
   IF discount IS DISTINCT FROM gross-round(gross*payable) THEN RAISE EXCEPTION 'settlement referral discount differs' USING ERRCODE='23514'; END IF;
  END IF;
  IF gross IS NULL OR service IS NULL OR discount IS NULL OR service IS DISTINCT FROM round(gross*rate)
   OR discount>service OR gross IS DISTINCT FROM p.owner_net_cents+service+p.compensation_fee_cents
   OR p.platform_contribution_cents-p.compensation_fee_cents<service-discount
  THEN RAISE EXCEPTION 'fixed fee commission amounts differ from posting' USING ERRCODE='23514'; END IF;
  base:=service-discount;
 ELSE
  IF ord.quote_snapshot->>'schemaVersion'='4' THEN RAISE EXCEPTION 'fixed fee basis version differs' USING ERRCODE='23514'; END IF;
  base:=CASE WHEN (doc#>>'{policyConfig,schema}'='distribution-policy.v3' OR doc#>>'{policyConfig,schema}'='distribution-policy.v4' AND doc#>>'{policyConfig,baseMode}'='LEGACY_RENTAL')
    THEN p.captured_cents-p.owner_net_cents-p.renter_refund_cents ELSE p.platform_contribution_cents-p.compensation_fee_cents END;
 END IF;
 IF base IS NULL OR base<0 THEN RAISE EXCEPTION 'original referral base unavailable' USING ERRCODE='23514'; END IF;
 posting_source:=jsonb_build_object('id',p.id,'order_id',p.order_id,'payment_confirmation_id',p.payment_confirmation_id,
  'version_hash',p.version_hash,'early',p.early,'manual_reason',p.manual_reason,'captured_cents',p.captured_cents::text,
  'owner_net_cents',p.owner_net_cents::text,'renter_refund_cents',p.renter_refund_cents::text,
  'platform_contribution_cents',p.platform_contribution_cents::text,'compensation_fee_cents',p.compensation_fee_cents::text,
  'posted_at',to_char(p.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 posting_hash:=encode(sha256(convert_to(zzsh_order.canonical_finance_json(posting_source),'UTF8')),'hex');
 due_value:=((p.posted_at AT TIME ZONE 'UTC')+((doc#>>'{policyConfig,settlementDelayDays}')::integer*interval '1 day')) AT TIME ZONE 'UTC';
 due_text:=to_char(due_value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
 FOR pair_role IN SELECT value FROM jsonb_array_elements(doc->'roles') LOOP
  IF COALESCE(pair_role->>'status','') NOT IN ('ELIGIBLE','SKIPPED_DISABLED','SKIPPED_FAST','SKIPPED_MODE','SKIPPED_NO_PARENT','SKIPPED_INELIGIBLE','SKIPPED_BELOW_MIN')
   OR doc->>'schema'='payment-distribution-basis.v2' AND (pair_role->>'status'='SKIPPED_BELOW_MIN'
    OR doc->>'accountMode'='fast' AND pair_role->>'status'='ELIGIBLE'
    OR doc->>'accountMode'<>'fast' AND pair_role->>'status'='SKIPPED_FAST')
  THEN RAISE EXCEPTION 'unknown counterpart cannot authorize accrual' USING ERRCODE='23514'; END IF;
  IF pair_role->>'status'='ELIGIBLE' THEN
   IF COALESCE(pair_role->>'beneficiaryUserId','')='' OR COALESCE(pair_role->>'relationDigest','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(pair_role#>>'{ratio,numerator}','') !~ '^(0|[1-9][0-9]{0,23})$'
    OR COALESCE(pair_role#>>'{ratio,denominator}','') !~ '^(0|[1-9][0-9]{0,23})$'
   THEN RAISE EXCEPTION 'original referral role unavailable' USING ERRCODE='23514'; END IF;
   n:=(pair_role#>>'{ratio,numerator}')::numeric;d:=(pair_role#>>'{ratio,denominator}')::numeric;
   IF n<0 OR d<=0 OR n>d THEN RAISE EXCEPTION 'counterpart ratio invalid' USING ERRCODE='23514'; END IF;
   -- Integer division avoids an intermediate numeric rounding before HALF_UP.
   commission:=div(base*n*2+d,2*d);
   IF doc->>'schema'='payment-distribution-basis.v2' AND (commission=0 OR commission<(doc#>>'{policyConfig,minimumAccrualCents}')::numeric) THEN CONTINUE; END IF;
   pair_total:=pair_total+commission;
   key_value:=zzsh_order.canonical_finance_json(jsonb_build_array('NATIVE_RENTAL_REFERRAL','NATIVE','zzsh','rental_order',p.order_id,pair_role->>'beneficiaryUserId',pair_role->>'role'));
   item:=jsonb_build_object('economicKey',key_value,'beneficiaryUserId',pair_role->>'beneficiaryUserId','role',pair_role->>'role',
    'amountCents',commission::numeric(24,0)::text,'dueAt',due_text,'policyVersion',doc->>'policyVersion',
    'basisDigest',b.basis_digest,'postingDigest',posting_hash,'relationDigest',pair_role->>'relationDigest');
   items:=items||jsonb_build_array(item);
  END IF;
 END LOOP;
 IF pair_total>base THEN RAISE EXCEPTION 'rounded referral pair exceeds original base without subsidy' USING ERRCODE='23514'; END IF;
 allocation_hash:=encode(sha256(convert_to(zzsh_order.canonical_finance_json(jsonb_build_object('orderId',p.order_id,
  'confirmationId',p.payment_confirmation_id,'basisDigest',b.basis_digest,'postingId',p.id,'postingDigest',posting_hash,
  'base',base::numeric(24,0)::text,'items',items)),'UTF8')),'hex');
 RETURN jsonb_build_object('orderId',p.order_id,'confirmationId',p.payment_confirmation_id,'basisDigest',b.basis_digest,
  'postingId',p.id,'postingDigest',posting_hash,'postedAt',to_char(p.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'policyDigest',doc->>'policyDigest','dueAt',due_text,'base',base::numeric(24,0)::text,
  'items',items,'allocationDigest',allocation_hash,'skipReason',CASE WHEN jsonb_array_length(items)<>0 THEN NULL
   WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'roles') r WHERE r->>'status'='ELIGIBLE') THEN 'NO_PAYABLE_COMMISSION'
   ELSE 'NO_ELIGIBLE_REFERRAL' END);
END $$;
COMMENT ON FUNCTION zzsh_order.derive_frozen_referral_accrual(text) IS '由原付款冻结关系和结算过账推导完整分销计佣，不读取当前政策。';

CREATE FUNCTION zzsh_order.frozen_referral_earning_seed(derivation jsonb,item jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT jsonb_build_object('id','earning_'||encode(sha256(convert_to(item->>'economicKey','UTF8')),'hex'),
  'economicKey',item->>'economicKey',
  'source',jsonb_build_object('kind','NATIVE_RENTAL_REFERRAL','type','NATIVE','system','zzsh','entity','rental_order',
   'id',derivation->>'orderId','digest',derivation->>'postingDigest','eventAt',derivation->>'postedAt'),
  'beneficiaryUserId',item->>'beneficiaryUserId','role',item->>'role','policyVersion',item->>'policyVersion',
  'policyDigest',derivation->>'policyDigest','baseDigest',derivation->>'allocationDigest','relationDigest',item->>'relationDigest',
  'amountCents',item->>'amountCents','dueAt',item->>'dueAt',
  'fingerprint',encode(sha256(convert_to(zzsh_order.canonical_finance_json(item),'UTF8')),'hex'),
  'state','PENDING','fundsDisposition','PENDING','recoveryRequiredCents',NULL,'version','1')
$$;
COMMENT ON FUNCTION zzsh_order.frozen_referral_earning_seed(jsonb,jsonb) IS '生成与冻结分销计佣明细一致的原始账务根。';
REVOKE ALL ON FUNCTION zzsh_order.derive_frozen_referral_accrual(text),zzsh_order.frozen_referral_earning_seed(jsonb,jsonb) FROM PUBLIC;
