-- 客服特殊取消沿原付款退回，不借用未开租退款或正常结算语义。
DO $$
BEGIN
 IF EXISTS(SELECT 1 FROM (VALUES
  ('zzsh_order.guard_joinpay_refund_intent()',ARRAY['83d17c9ac78cf4f401b6a093212128c23a9d2fe558443c7008d8009f1ae15216']),
  ('zzsh_order.guard_native_refund_entry()',ARRAY['db17191aad9a063a2ef10fe8b1ea665a0e36c68bfa418e538609540975278c29']),
  ('zzsh_order.check_native_refund_closure()',ARRAY['4db393adbba52645ca8dd8a8cd11990008df0c00394a53b9ae028d45527893a6']),
  ('zzsh_order.native_prestart_refund_terminal_complete(text)',ARRAY['94b3cccba78f64ed0f56cfcfe475b5881a1d36b6c319f3714e4941e57f844483'])
 ) expected(signature,digests)
 LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
 WHERE p.oid IS NULL OR NOT (encode(sha256(convert_to(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)),'UTF8')),'hex')=ANY(expected.digests)))
 THEN RAISE EXCEPTION 'poststart refund guard prefix differs' USING ERRCODE='55000';END IF;
 IF (SELECT count(*) FROM (VALUES
  ('zzsh_order.guard_sandbox_refund_intent()'),('zzsh_order.local_controlled_refund_liability_complete(text)'),('zzsh_order.guard_local_refund_source()')
 ) expected(signature) WHERE to_regprocedure(expected.signature) IS NOT NULL) NOT IN (0,3)
 THEN RAISE EXCEPTION 'controlled refund guard prefix incomplete' USING ERRCODE='55000';END IF;
 IF (to_regprocedure('zzsh_order.guard_sandbox_refund_intent()') IS NOT NULL) IS DISTINCT FROM EXISTS(
  SELECT 1 FROM pg_attribute WHERE attrelid='zzsh_order.channel_refund_intent'::regclass AND attname='sandbox_registration_ref' AND attnum>0 AND NOT attisdropped)
 THEN RAISE EXCEPTION 'controlled refund column and guards differ' USING ERRCODE='55000';END IF;
 IF EXISTS(SELECT 1 FROM (VALUES
  ('zzsh_order.guard_sandbox_refund_intent()',ARRAY['aa705fcd4dbb921d4900455877b92c70556bb43d0d013258428d2693a0f0ec16','0eb1a378657e00bf7e6b54bc1d4ebdbe3076349e50dae6ca7d869a39c00b51ca']),
  ('zzsh_order.local_controlled_refund_liability_complete(text)',ARRAY['5258a935ea192497c8a6197df2c00a968bc435968281d631d3112bea174084b3']),
  ('zzsh_order.guard_local_refund_source()',ARRAY['8f37dfa01f5b55f1139490a5bc0ee409e2928b2fc97307b938a81f71757d1377','ef171dfa5ec8d0ccba1fdbe23613f96af7c11e02794afc1e8b7c76afa4203d8b'])
 ) expected(signature,digests)
 LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
 WHERE p.oid IS NOT NULL AND NOT (encode(sha256(convert_to(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)),'UTF8')),'hex')=ANY(expected.digests)))
 THEN RAISE EXCEPTION 'controlled refund guard prefix differs' USING ERRCODE='55000';END IF;
END $$;

ALTER TABLE zzsh_order.channel_refund_intent DROP CONSTRAINT channel_refund_current_basis_only,
 ADD CONSTRAINT channel_refund_current_basis_only CHECK(basis_kind IN('POSTING','PRESTART_TERMINATION','SUPPORT_CANCELLATION'));
COMMENT ON CONSTRAINT channel_refund_current_basis_only ON zzsh_order.channel_refund_intent IS '只允许正常结算、未开租取消和已开租客服取消产生退款意图';
DO $extend$
DECLARE expression text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint
  WHERE conrelid='zzsh_order.channel_refund_intent'::regclass AND conname='channel_refund_basis_shape';
 IF expression IS NULL OR position('PRESTART_TERMINATION' IN expression)=0 THEN RAISE EXCEPTION 'refund basis contract missing';END IF;
 ALTER TABLE zzsh_order.channel_refund_intent DROP CONSTRAINT channel_refund_basis_shape;
 IF EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='zzsh_order.channel_refund_intent'::regclass
   AND attname='sandbox_registration_ref' AND attnum>0 AND NOT attisdropped) THEN
 EXECUTE format('ALTER TABLE zzsh_order.channel_refund_intent ADD CONSTRAINT channel_refund_basis_shape CHECK((%s) OR
  (basis_kind=''SUPPORT_CANCELLATION'' AND posting_id IS NULL AND liability_root_id IS NOT NULL AND liability_event_id IS NOT NULL
   AND ((payment_source=''JOINPAY'' AND evidence_level=''JOINPAY_FORMAL'' AND sandbox_registration_ref IS NULL)
    OR(payment_source=''CONTROLLED'' AND evidence_level=''CONTROLLED_TEST'' AND sandbox_registration_ref IS NOT NULL))))',expression);
 ELSE
 EXECUTE format('ALTER TABLE zzsh_order.channel_refund_intent ADD CONSTRAINT channel_refund_basis_shape CHECK((%s) OR
  (basis_kind=''SUPPORT_CANCELLATION'' AND posting_id IS NULL AND liability_root_id IS NOT NULL AND liability_event_id IS NOT NULL
   AND payment_source=''JOINPAY'' AND evidence_level=''JOINPAY_FORMAL''))',expression);
 END IF;
END $extend$;
DO $extend_sandbox$
DECLARE expression text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint
  WHERE conrelid='zzsh_order.channel_refund_intent'::regclass AND conname='sandbox_refund_source_reference';
 IF expression IS NOT NULL THEN
  IF position('PRESTART_TERMINATION' IN expression)=0 THEN RAISE EXCEPTION 'sandbox refund source contract missing';END IF;
  ALTER TABLE zzsh_order.channel_refund_intent DROP CONSTRAINT sandbox_refund_source_reference;
  ALTER TABLE zzsh_order.channel_refund_intent ADD CONSTRAINT sandbox_refund_source_reference CHECK(
   sandbox_registration_ref IS NULL OR(payment_source='CONTROLLED' AND evidence_level='CONTROLLED_TEST'
    AND basis_kind IN('POSTING','PRESTART_TERMINATION','SUPPORT_CANCELLATION')));
 END IF;
END $extend_sandbox$;
CREATE UNIQUE INDEX support_cancellation_refund_original_key ON zzsh_order.channel_refund_intent(payment_confirmation_id,idempotency_key)
 WHERE basis_kind='SUPPORT_CANCELLATION';

CREATE FUNCTION zzsh_order.support_cancellation_refund_liability_complete(intent_value text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT COALESCE(EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i
  JOIN zzsh_order.support_poststart_cancellation p ON p.order_id=i.order_id AND p.payment_confirmation_id=i.payment_confirmation_id
  JOIN zzsh_order.rental_order o ON o.id=p.order_id
  JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id AND c.order_id=o.id
  WHERE i.id=intent_value AND i.basis_kind='SUPPORT_CANCELLATION' AND i.posting_id IS NULL
   AND c.disposition='APPLIED' AND c.source=i.payment_source AND c.currency='CNY'
   AND ((i.payment_source='JOINPAY' AND i.evidence_level='JOINPAY_FORMAL')
     OR(i.payment_source='CONTROLLED' AND i.evidence_level='CONTROLLED_TEST' AND to_jsonb(i)->>'sandbox_registration_ref' IS NOT NULL))
   AND p.refund_cents>0 AND i.amount_cents=p.refund_cents AND i.currency='CNY'
   AND i.renter_user_id=p.renter_user_id AND i.merchant_identity_id=c.merchant_scope_id
   AND i.original_payment_trx_no=c.provider_transaction_id AND i.original_payment_order_no=c.merchant_order_no
   AND i.responsibility_version_hash=p.source_digest AND i.liability_root_id=p.root_id AND i.liability_event_id=p.event_id
   AND i.due_at=p.created_at AND zzsh_order.support_poststart_cancellation_complete(p.id)),false)
$$;
COMMENT ON FUNCTION zzsh_order.support_cancellation_refund_liability_complete(text) IS '核对客服特殊取消的原付款和应退金额';

CREATE FUNCTION zzsh_order.support_cancellation_refund_terminal_complete(intent_id_value text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.channel_refund_intent;e zzsh_order.joinpay_refund_evidence;r zzsh_order.finance_economic_root;
 ev zzsh_order.finance_event;rev bigint;lines bigint;good bigint;dr numeric;cr numeric;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=intent_id_value;
 SELECT * INTO e FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=i.id;
 IF i.id IS NULL OR i.payment_source<>'JOINPAY' OR i.evidence_level<>'JOINPAY_FORMAL'
  OR i.basis_kind<>'SUPPORT_CANCELLATION' OR i.posting_id IS NOT NULL OR e.id IS NULL
  OR i.terminal_evidence_id IS DISTINCT FROM e.id OR i.provider_refund_trx_no IS DISTINCT FROM e.refund_transaction_no
  OR i.completed_at IS DISTINCT FROM e.completed_at
  OR NOT zzsh_order.support_cancellation_refund_liability_complete(i.id)
 THEN RETURN false;END IF;
 IF e.terminal='FAILED_NO_EXECUTION' THEN
  RETURN i.state='FAILED' AND i.budget_disposition='RELEASED' AND i.terminal_root_id IS NULL AND i.terminal_event_id IS NULL
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.finance_economic_root WHERE source_kind='NATIVE_RENTAL_REFUND' AND source_id=i.id)
   AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.refund.allocation.released' AND a.object_type='channel_refund_intent'
    AND a.object_id=i.id AND a.outcome='SUCCESS' AND a.details->>'evidenceId'=e.id AND a.details->>'factsDigest'=e.facts_digest
    AND a.details->>'budgetDisposition'='RELEASED' AND a.details->>'postingId' IS NULL
    AND a.details->>'paymentConfirmationId'=i.payment_confirmation_id AND a.details->>'amountCents'=i.amount_cents::text
    AND a.details->>'currency'='CNY' AND a.details->>'channelArrival'='UNKNOWN');
 END IF;
 IF e.terminal<>'SUCCEEDED' THEN RETURN false;END IF;
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=i.terminal_root_id;
 SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=i.terminal_event_id;
 SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=i.renter_user_id;
 IF i.state<>'SUCCEEDED' OR i.budget_disposition<>'CONSUMED' OR r.id IS NULL OR ev.id IS NULL OR rev IS NULL
  OR r.source_kind<>'NATIVE_RENTAL_REFUND' OR r.source_type<>'NATIVE' OR r.source_system<>'zzsh' OR r.source_entity<>'channel_refund_intent'
  OR r.source_id<>i.id OR r.subject_user_id<>i.renter_user_id OR r.source_digest<>e.facts_digest OR r.beneficiary_role<>'RENTER'
  OR r.basis_id IS NOT NULL OR r.policy_version IS NOT NULL OR ev.kind<>'REFUND_PAID' OR ev.economic_root_id<>r.id
  OR ev.subject_user_id<>i.renter_user_id OR rev<ev.expected_ledger_revision+1
  OR(SELECT count(*) FROM zzsh_order.finance_event WHERE economic_root_id=r.id)<>1
 THEN RETURN false;END IF;
 SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0),count(*) FILTER(WHERE
  source_payment_confirmation_id IS NULL AND details=jsonb_build_object('nativeRefundIntentId',i.id,'postingId',i.posting_id,
   'paymentConfirmationId',i.payment_confirmation_id,'refundOrderNo',i.refund_order_no,'factsDigest',e.facts_digest)
  AND((line_no=1 AND account_code='RENTER_REFUND_PAYABLE' AND debit_cents=i.amount_cents AND credit_cents=0 AND counterparty_user_id=i.renter_user_id)
   OR(line_no=2 AND account_code='PAYOUT_CLEARING' AND debit_cents=0 AND credit_cents=i.amount_cents AND counterparty_user_id IS NULL)))
  INTO lines,dr,cr,good FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=ev.id;
 RETURN lines=2 AND good=2 AND dr=i.amount_cents AND cr=i.amount_cents
  AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.refund.liability.consumed' AND a.object_type='channel_refund_intent'
   AND a.object_id=i.id AND a.outcome='SUCCESS' AND a.details->>'evidenceId'=e.id AND a.details->>'factsDigest'=e.facts_digest
   AND a.details->>'budgetDisposition'='CONSUMED' AND a.details->>'postingId' IS NULL
   AND a.details->>'paymentConfirmationId'=i.payment_confirmation_id AND a.details->>'amountCents'=i.amount_cents::text
   AND a.details->>'currency'='CNY' AND a.details->>'channelArrival'='UNKNOWN');
END $$;
COMMENT ON FUNCTION zzsh_order.support_cancellation_refund_terminal_complete(text) IS '核对客服特殊取消退款的渠道证据和账务闭合';

DO $patch_guards$
DECLARE f text;updated text;needle text;
BEGIN
 SELECT pg_get_functiondef(to_regprocedure('zzsh_order.guard_joinpay_refund_intent()')) INTO f;
 needle:=' IF NEW.basis_kind=''PRESTART_TERMINATION'' THEN';
 IF position(needle IN f)=0 OR position(needle IN substring(f FROM position(needle IN f)+length(needle)))>0 THEN RAISE EXCEPTION 'formal refund insertion guard differs';END IF;
 updated:=replace(f,needle,$branch$
 IF NEW.basis_kind='SUPPORT_CANCELLATION' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-funds:v1','JOINPAY',NEW.merchant_identity_id,NEW.original_payment_trx_no)::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-order-no:v1',NEW.merchant_identity_id,NEW.original_payment_order_no)::text,0));
  PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.renter_user_id FOR UPDATE;
  IF NEW.posting_id IS NOT NULL OR NEW.currency<>'CNY' OR NEW.amount_cents<=0 OR NEW.amount_cents>9999999999999999
   OR NEW.state<>'READY' OR NEW.lease_version<>0 OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL
   OR NEW.revision<>1 OR NEW.requires_review OR NEW.budget_disposition<>'ALLOCATED'
   OR NEW.terminal_evidence_id IS NOT NULL OR NEW.terminal_root_id IS NOT NULL OR NEW.terminal_event_id IS NOT NULL
   OR NEW.provider_refund_trx_no IS NOT NULL OR NEW.completed_at IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.support_poststart_cancellation p
    JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id AND c.order_id=p.order_id
    JOIN zzsh_order.joinpay_collection_binding bnd ON bnd.request_id=c.joinpay_request_id
    WHERE p.order_id=NEW.order_id AND c.id=NEW.payment_confirmation_id AND c.source='JOINPAY' AND c.disposition='APPLIED'
     AND NEW.renter_user_id=p.renter_user_id AND NEW.merchant_identity_id=c.merchant_scope_id
     AND NEW.original_payment_trx_no=c.provider_transaction_id AND NEW.original_payment_order_no=c.merchant_order_no
     AND NEW.amount_cents=p.refund_cents AND p.refund_cents>0 AND NEW.wire_merchant_no=bnd.wire_merchant_no AND NEW.due_at=p.created_at
     AND NEW.responsibility_version_hash=p.source_digest AND NEW.liability_root_id=p.root_id AND NEW.liability_event_id=p.event_id
     AND zzsh_order.support_poststart_cancellation_complete(p.id))
   OR (SELECT count(DISTINCT c.provider_transaction_id) FROM zzsh_order.payment_confirmation c
    WHERE c.source='JOINPAY' AND c.merchant_scope_id=NEW.merchant_identity_id AND c.merchant_order_no=NEW.original_payment_order_no
     AND c.disposition IN('APPLIED','REVIEW_REQUIRED'))<>1
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_revision WHERE user_id=NEW.renter_user_id)
   OR EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.payment_source='JOINPAY'
    AND i.merchant_identity_id=NEW.merchant_identity_id AND i.original_payment_trx_no=NEW.original_payment_trx_no
    AND(i.requires_review OR i.budget_disposition<>'RELEASED'))
  THEN RAISE EXCEPTION 'support cancellation refund requires original liability' USING ERRCODE='23514';END IF;
  NEW.created_at:=clock_timestamp();NEW.updated_at:=NEW.created_at;RETURN NEW;
 END IF;
 IF NEW.basis_kind='PRESTART_TERMINATION' THEN$branch$);
 EXECUTE updated;

 SELECT pg_get_functiondef(to_regprocedure('zzsh_order.guard_native_refund_entry()')) INTO f;
 needle:='i.basis_kind NOT IN(''POSTING'',''PRESTART_TERMINATION'')';
 IF position(needle IN f)=0 THEN RAISE EXCEPTION 'refund entry guard differs';END IF;
 EXECUTE replace(f,needle,'i.basis_kind NOT IN(''POSTING'',''PRESTART_TERMINATION'',''SUPPORT_CANCELLATION'')');

 SELECT pg_get_functiondef(to_regprocedure('zzsh_order.check_native_refund_closure()')) INTO f;
 needle:='i.basis_kind NOT IN(''POSTING'',''PRESTART_TERMINATION'')';
 IF position(needle IN f)=0 THEN RAISE EXCEPTION 'refund closure guard differs';END IF;
 updated:=replace(f,needle,'i.basis_kind NOT IN(''POSTING'',''PRESTART_TERMINATION'',''SUPPORT_CANCELLATION'')');
 needle:=' IF i.basis_kind=''PRESTART_TERMINATION'' THEN';
 IF position(needle IN updated)=0 THEN RAISE EXCEPTION 'refund closure basis differs';END IF;
 updated:=replace(updated,needle,$branch$
 IF i.basis_kind='SUPPORT_CANCELLATION' THEN
  IF i.state IN('SUCCEEDED','FAILED') THEN
   IF NOT zzsh_order.support_cancellation_refund_terminal_complete(target)
   THEN RAISE EXCEPTION 'support cancellation refund terminal batch incomplete' USING ERRCODE='23514';END IF;
  ELSIF i.budget_disposition<>'ALLOCATED' OR EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=target)
   OR EXISTS(SELECT 1 FROM zzsh_order.finance_economic_root WHERE source_kind='NATIVE_RENTAL_REFUND' AND source_id=target)
   OR NOT zzsh_order.support_cancellation_refund_liability_complete(target)
  THEN RAISE EXCEPTION 'unresolved support cancellation refund cannot post money' USING ERRCODE='23514';END IF;
  RETURN NULL;
 END IF;
 IF i.basis_kind='PRESTART_TERMINATION' THEN$branch$);
 EXECUTE updated;

 IF to_regprocedure('zzsh_order.guard_sandbox_refund_intent()') IS NOT NULL THEN
 SELECT pg_get_functiondef(to_regprocedure('zzsh_order.guard_sandbox_refund_intent()')) INTO f;
 needle:='  IF frozen IS NULL THEN';
 IF position(needle IN f)=0 THEN RAISE EXCEPTION 'controlled refund basis guard differs';END IF;
 needle:='  END IF;'||chr(10)||'  IF frozen IS NULL THEN';
 IF position(needle IN f)=0 THEN RAISE EXCEPTION 'controlled refund branch differs';END IF;
 updated:=replace(f,needle,$branch$
  ELSIF NEW.basis_kind='SUPPORT_CANCELLATION' THEN
   SELECT p.refund_cents INTO frozen FROM zzsh_order.support_poststart_cancellation p WHERE p.order_id=NEW.order_id
    AND p.payment_confirmation_id=c.id AND p.source_digest=NEW.responsibility_version_hash
    AND p.root_id=NEW.liability_root_id AND p.event_id=NEW.liability_event_id AND p.created_at=NEW.due_at
    AND p.refund_cents>0 AND NEW.amount_cents=p.refund_cents AND zzsh_order.support_poststart_cancellation_complete(p.id);
  END IF;
  IF frozen IS NULL THEN$branch$);
 EXECUTE updated;

 SELECT pg_get_functiondef(to_regprocedure('zzsh_order.local_controlled_refund_liability_complete(text)')) INTO f;
 needle:=' END IF;'||chr(10)||' RETURN false;'||chr(10)||'END';
 IF position(needle IN f)=0 THEN RAISE EXCEPTION 'controlled refund liability differs';END IF;
 updated:=replace(f,needle,$branch$
 ELSIF i.basis_kind='SUPPORT_CANCELLATION' THEN
  RETURN zzsh_order.support_cancellation_refund_liability_complete(i.id);
 END IF;
 RETURN false;
END$branch$);
 EXECUTE updated;

 SELECT pg_get_functiondef(to_regprocedure('zzsh_order.guard_local_refund_source()')) INTO f;
 needle:='CASE WHEN i.basis_kind=''PRESTART_TERMINATION'' THEN jsonb_build_object(''basisKind'',''PRESTART_TERMINATION'') ELSE ''{}''::jsonb END';
 IF position(needle IN f)=0 THEN RAISE EXCEPTION 'controlled refund evidence differs';END IF;
 updated:=replace(f,needle,'CASE WHEN i.basis_kind IN(''PRESTART_TERMINATION'',''SUPPORT_CANCELLATION'') THEN jsonb_build_object(''basisKind'',i.basis_kind) ELSE ''{}''::jsonb END');
 EXECUTE updated;
 END IF;
END $patch_guards$;
REVOKE ALL ON FUNCTION zzsh_order.support_cancellation_refund_liability_complete(text),zzsh_order.support_cancellation_refund_terminal_complete(text) FROM PUBLIC;
