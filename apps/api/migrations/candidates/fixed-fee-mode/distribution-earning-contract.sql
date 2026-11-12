-- Candidate only. The existing v1 earning derivation remains unchanged.
DO $patch$
DECLARE source text; definition text; prior text; replacement text; digest text; idx integer;
 old_parts text[]:=ARRAY[
  $old$posting_source jsonb;posting_hash text;key_value text;due_value timestamptz;due_text text;items jsonb:='[]'::jsonb;item jsonb;own_item jsonb;allocation_hash text;expected_seed jsonb;$old$,
  $old$n:=(role#>>'{ratio,numerator}')::numeric;d:=(role#>>'{ratio,denominator}')::numeric;base:=CASE WHEN (doc#>>'{policyConfig,schema}'='distribution-policy.v3' OR doc#>>'{policyConfig,schema}'='distribution-policy.v4' AND doc#>>'{policyConfig,baseMode}'='LEGACY_RENTAL') THEN p.captured_cents-p.owner_net_cents-p.renter_refund_cents ELSE p.platform_contribution_cents-p.compensation_fee_cents END;$old$,
  $old$IF n IS NULL OR d IS NULL OR n<0 OR d<=0 OR n>d THEN RAISE EXCEPTION 'counterpart ratio invalid' USING ERRCODE='23514';END IF;
   pair_total:=pair_total+floor(base*n/d+0.5);$old$
 ];
 new_parts text[]:=ARRAY[
  $new$posting_source jsonb;posting_hash text;key_value text;due_value timestamptz;due_text text;items jsonb:='[]'::jsonb;item jsonb;own_item jsonb;allocation_hash text;expected_seed jsonb;
 fixed_order record;fixed_version record;fixed_payment record;pricing jsonb;gross numeric;service numeric;discount numeric;rate numeric;payable numeric;$new$,
  $new$n:=(role#>>'{ratio,numerator}')::numeric;d:=(role#>>'{ratio,denominator}')::numeric;
 IF doc->>'schema'='payment-distribution-basis.v2' THEN
  SELECT o.status,o.paid_confirmation_id,o.renter_user_id,o.owner_user_id,o.account_id,o.listing_version_id,o.content_hash,o.quote_snapshot INTO fixed_order
   FROM zzsh_order.rental_order o WHERE o.id=p.order_id;
  SELECT v.order_id,v.kind,v.early,v.version_hash,v.superseded_at,v.input_snapshot INTO fixed_version
   FROM zzsh_order.settlement_version v WHERE v.id=p.settlement_version_id AND v.order_id=p.order_id;
  SELECT c.order_id,c.disposition,c.currency,c.amount_cents INTO fixed_payment
   FROM zzsh_order.payment_confirmation c WHERE c.id=p.payment_confirmation_id AND c.order_id=p.order_id;
  pricing:=doc->'fixedFeePricing';
  IF fixed_order IS NULL OR fixed_order.status IS DISTINCT FROM 'COMPLETED' OR fixed_order.paid_confirmation_id IS DISTINCT FROM p.payment_confirmation_id
   OR fixed_order.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '4' OR fixed_order.quote_snapshot#>>'{personal,schema}' IS DISTINCT FROM 'personal-quote-v5'
   OR fixed_order.quote_snapshot#>>'{settlementPricing,schema}' IS DISTINCT FROM 'settlement-pricing-v3'
   OR jsonb_typeof(pricing) IS DISTINCT FROM 'object' OR pricing IS DISTINCT FROM jsonb_build_object(
      'fixedFeeRate',fixed_order.quote_snapshot#>>'{settlementPricing,fixedFeeRate}','payableRatio',fixed_order.quote_snapshot#>>'{settlementPricing,payableRatio}')
   OR COALESCE(pricing->>'fixedFeeRate','') !~ '^(0|1)(\.[0-9]{1,8})?$' OR COALESCE(pricing->>'payableRatio','') !~ '^(0|1)(\.[0-9]{1,8})?$'
   OR fixed_version IS NULL OR fixed_version.superseded_at IS NOT NULL OR fixed_version.version_hash IS DISTINCT FROM p.version_hash
   OR fixed_version.early IS DISTINCT FROM p.early OR fixed_version.kind NOT IN ('SYSTEM','MANUAL_ADJUSTMENT')
   OR (fixed_version.kind='SYSTEM') IS DISTINCT FROM (p.manual_reason IS NULL)
   OR fixed_version.input_snapshot->>'schema' IS DISTINCT FROM 'settlement-version-v4'
   OR fixed_version.input_snapshot->>'orderId' IS DISTINCT FROM p.order_id OR fixed_version.input_snapshot->>'paymentConfirmationId' IS DISTINCT FROM p.payment_confirmation_id
   OR fixed_version.input_snapshot->>'renterUserId' IS DISTINCT FROM fixed_order.renter_user_id OR fixed_version.input_snapshot->>'ownerUserId' IS DISTINCT FROM fixed_order.owner_user_id
   OR fixed_version.input_snapshot->>'listingVersionId' IS DISTINCT FROM fixed_order.listing_version_id OR fixed_version.input_snapshot->>'listingHash' IS DISTINCT FROM fixed_order.content_hash
   OR fixed_version.input_snapshot->>'kind' IS DISTINCT FROM fixed_version.kind OR fixed_version.input_snapshot->>'early' IS DISTINCT FROM p.early::text
   OR zzsh_order.settlement_snapshot_cents(fixed_version.input_snapshot->>'capturedAmount') IS DISTINCT FROM p.captured_cents
   OR encode(sha256(convert_to(zzsh_order.canonical_finance_json(fixed_version.input_snapshot),'UTF8')),'hex') IS DISTINCT FROM p.version_hash
   OR fixed_payment IS NULL OR fixed_payment.disposition IS DISTINCT FROM 'APPLIED' OR fixed_payment.currency IS DISTINCT FROM 'CNY'
   OR fixed_payment.amount_cents IS DISTINCT FROM p.captured_cents
  THEN RAISE EXCEPTION 'fixed fee commission lacks a bound completed settlement' USING ERRCODE='23514'; END IF;
  rate:=(pricing->>'fixedFeeRate')::numeric;payable:=(pricing->>'payableRatio')::numeric;
  IF rate<0 OR rate>=1 OR payable<=0 OR payable>1 OR 1-payable>rate
    OR COALESCE(fixed_order.quote_snapshot#>>'{pricingInputs,commissionRate}','') !~ '^(0|1)(\.[0-9]{1,8})?$'
    OR (fixed_order.quote_snapshot#>>'{pricingInputs,commissionRate}')::numeric IS DISTINCT FROM rate
  THEN RAISE EXCEPTION 'fixed fee commission rates differ from the original order' USING ERRCODE='23514'; END IF;
  IF fixed_version.kind='MANUAL_ADJUSTMENT' THEN
   gross:=zzsh_order.settlement_snapshot_cents(fixed_version.input_snapshot->>'proposedOwnerGross');
   service:=zzsh_order.settlement_snapshot_cents(fixed_version.input_snapshot->>'proposedPlatformServiceFee');
   discount:=zzsh_order.settlement_snapshot_cents(fixed_version.input_snapshot->>'proposedMembershipDiscount');
   IF discount IS DISTINCT FROM round(gross*(1-payable)) THEN RAISE EXCEPTION 'manual referral discount differs' USING ERRCODE='23514'; END IF;
  ELSE
   gross:=zzsh_order.settlement_snapshot_cents(fixed_version.input_snapshot#>>'{amounts,ownerGross}');
   service:=zzsh_order.settlement_snapshot_cents(fixed_version.input_snapshot#>>'{amounts,platformServiceFee}');
   discount:=zzsh_order.settlement_snapshot_cents(fixed_version.input_snapshot#>>'{amounts,membershipDiscount}');
   IF discount IS DISTINCT FROM gross-round(gross*payable) THEN RAISE EXCEPTION 'settlement referral discount differs' USING ERRCODE='23514'; END IF;
  END IF;
  IF gross IS NULL OR service IS NULL OR discount IS NULL OR service IS DISTINCT FROM round(gross*rate)
    OR discount>service OR gross IS DISTINCT FROM p.owner_net_cents+service+p.compensation_fee_cents
    OR p.platform_contribution_cents-p.compensation_fee_cents<service-discount
  THEN RAISE EXCEPTION 'fixed fee commission amounts differ from posting' USING ERRCODE='23514'; END IF;
  base:=service-discount;
 ELSE
  base:=CASE WHEN (doc#>>'{policyConfig,schema}'='distribution-policy.v3' OR doc#>>'{policyConfig,schema}'='distribution-policy.v4' AND doc#>>'{policyConfig,baseMode}'='LEGACY_RENTAL') THEN p.captured_cents-p.owner_net_cents-p.renter_refund_cents ELSE p.platform_contribution_cents-p.compensation_fee_cents END;
 END IF;$new$,
  $new$IF n IS NULL OR d IS NULL OR n<0 OR d<=0 OR n>d THEN RAISE EXCEPTION 'counterpart ratio invalid' USING ERRCODE='23514';END IF;
   IF doc->>'schema'='payment-distribution-basis.v2' AND (floor(base*n/d+0.5)=0 OR floor(base*n/d+0.5)<(doc#>>'{policyConfig,minimumAccrualCents}')::numeric) THEN CONTINUE; END IF;
   pair_total:=pair_total+floor(base*n/d+0.5);$new$
 ];
BEGIN
 IF to_regprocedure('zzsh_order.settlement_snapshot_cents(text)') IS NULL
 THEN RAISE EXCEPTION 'settlement snapshot proof contract is required' USING ERRCODE='55000'; END IF;
 SELECT p.prosrc,pg_get_functiondef(p.oid) INTO source,definition FROM pg_proc p
  WHERE p.oid=to_regprocedure('zzsh_order.guard_rental_referral_earning()')
   AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND NOT p.prosecdef;
 digest:=encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex');
 IF digest IS DISTINCT FROM 'cb4d2f8b48926487c6cdf70eca38d5b9b75a8e9a4b378d44ecfc21f8594c984d'
 THEN RAISE EXCEPTION 'installed referral earning guard is unrecognized' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,E'\r\n',E'\n');
 FOR idx IN 1..array_length(old_parts,1) LOOP
  prior:=old_parts[idx];replacement:=new_parts[idx];
  IF position(prior IN definition)=0 OR position(prior IN replace(definition,prior,''))<>0
  THEN RAISE EXCEPTION 'referral earning guard patch is absent or ambiguous: %',idx USING ERRCODE='55000'; END IF;
  definition:=replace(definition,prior,replacement);
 END LOOP;
 EXECUTE definition;
END $patch$;
