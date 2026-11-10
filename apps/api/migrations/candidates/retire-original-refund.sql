-- 合入正式迁移链时按当时未占用的编号登记；旧业务迁移保持原字节。
-- 退役的异常原款责任不再产生；真实支付及正常结算、未开租退款继续保留。
DO $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM (VALUES
   ('zzsh_order.guard_joinpay_refund_intent()','abeb1a635fe48b897681b0106967bc7e04c9b4d4f39a9db180432b537448eb1a'),
   ('zzsh_order.guard_native_refund_entry()','2af59fa874c459cafb298693c07fb7e1bf2c69afb016d023f6752b73ed8796cd'),
   ('zzsh_order.check_native_refund_closure()','6495d95ccb17ce270d7418337ca03ee2cd909970dcacf71f01cbedf2e8289903'),
   ('zzsh_order.guard_prestart_liability_event()','2a25274877d3b77ccd76ecab5182a09846891399b79e84b8a893df5b29a0abaa')
  ) expected(signature,digest)
  LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
  WHERE p.oid IS NULL OR encode(sha256(convert_to(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)),'UTF8')),'hex') IS DISTINCT FROM expected.digest
 ) THEN RAISE EXCEPTION 'refund guard prefix differs; stop before retirement' USING ERRCODE='55000'; END IF;
END $$;

ALTER TABLE zzsh_order.channel_refund_intent
  ADD CONSTRAINT channel_refund_current_basis_only
  CHECK (basis_kind IN ('POSTING', 'PRESTART_TERMINATION'));
COMMENT ON CONSTRAINT channel_refund_current_basis_only ON zzsh_order.channel_refund_intent
  IS '只允许正常结算和未开租终止产生退款意图';

ALTER TABLE zzsh_order.finance_economic_root
  ADD CONSTRAINT finance_root_retired_refund_excluded
  CHECK (source_kind <> 'NATIVE_ABNORMAL_REFUND');
COMMENT ON CONSTRAINT finance_root_retired_refund_excluded ON zzsh_order.finance_economic_root
  IS '不再生成已退役的异常原款退款责任';

ALTER TABLE zzsh_order.settlement_ledger_entry
  ADD CONSTRAINT settlement_retired_refund_excluded
  CHECK (NOT COALESCE(details ? 'abnormalRefundLiabilityId', false)
    AND account_code <> 'JOINPAY_UNALLOCATED_RECEIPT');
COMMENT ON CONSTRAINT settlement_retired_refund_excluded ON zzsh_order.settlement_ledger_entry
  IS '不再生成已退役的异常原款退款分录';

-- 未开租退款沿用原有责任闭合；其他来源不得借用该事件类型。
CREATE OR REPLACE FUNCTION zzsh_order.guard_prestart_liability_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r zzsh_order.finance_economic_root;t zzsh_order.prestart_termination;rev bigint;
BEGIN
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 IF r.source_kind IS DISTINCT FROM 'NATIVE_PRESTART_REFUND' THEN
  IF NEW.kind='REFUND_LIABILITY_RECOGNIZED' THEN
   RAISE EXCEPTION 'refund liability event source differs' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO t FROM zzsh_order.prestart_termination WHERE id=r.source_id;
 SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=r.subject_user_id;
 IF t.id IS NULL OR t.approved_xid IS DISTINCT FROM pg_current_xact_id() OR r.created_xid IS DISTINCT FROM pg_current_xact_id()
  OR NEW.kind<>'REFUND_LIABILITY_RECOGNIZED' OR NEW.subject_user_id IS DISTINCT FROM r.subject_user_id
  OR NEW.expected_ledger_revision IS DISTINCT FROM rev OR rev IS NULL
  OR NEW.id IS DISTINCT FROM 'prestart_liability_'||substr(encode(sha256(convert_to(t.payment_basis->>'paymentConfirmationId','UTF8')),'hex'),1,40)
 THEN RAISE EXCEPTION 'prestart liability event/revision differs' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
COMMENT ON FUNCTION zzsh_order.guard_prestart_liability_event() IS '限制未开租退款责任事件的来源、主体和同事务依据';

CREATE OR REPLACE FUNCTION zzsh_order.guard_native_refund_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.channel_refund_intent;e zzsh_order.joinpay_refund_evidence;ev zzsh_order.finance_event;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=NEW.details->>'nativeRefundIntentId';
 SELECT * INTO e FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=i.id;
 SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 IF i.id IS NULL OR i.basis_kind NOT IN('POSTING','PRESTART_TERMINATION') OR e.id IS NULL
  OR e.created_xid<>pg_current_xact_id() OR e.terminal<>'SUCCEEDED'
  OR ev.id IS NULL OR ev.kind<>'REFUND_PAID' OR ev.created_xid<>pg_current_xact_id()
  OR ev.economic_root_id IS DISTINCT FROM 'native_refund_root_'||substr(encode(sha256(convert_to(i.id,'UTF8')),'hex'),1,40)
  OR ev.subject_user_id<>i.renter_user_id OR NEW.source_payment_confirmation_id IS NOT NULL
  OR NEW.details IS DISTINCT FROM jsonb_build_object('nativeRefundIntentId',i.id,'postingId',i.posting_id,
   'paymentConfirmationId',i.payment_confirmation_id,'refundOrderNo',i.refund_order_no,'factsDigest',e.facts_digest)
  OR NOT((NEW.line_no=1 AND NEW.account_code='RENTER_REFUND_PAYABLE' AND NEW.debit_cents=i.amount_cents AND NEW.credit_cents=0
    AND NEW.counterparty_user_id=i.renter_user_id)
   OR(NEW.line_no=2 AND NEW.account_code='PAYOUT_CLEARING' AND NEW.debit_cents=0
    AND NEW.credit_cents=i.amount_cents AND NEW.counterparty_user_id IS NULL))
 THEN RAISE EXCEPTION 'native refund entry differs from original responsibility consumption' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
COMMENT ON FUNCTION zzsh_order.guard_native_refund_entry() IS '校验正常或未开租退款的原责任和资金分录';

CREATE OR REPLACE FUNCTION zzsh_order.check_native_refund_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text;i zzsh_order.channel_refund_intent;
BEGIN
 IF TG_TABLE_NAME='channel_refund_intent' THEN target:=NEW.id;
 ELSIF TG_TABLE_NAME='joinpay_refund_evidence' THEN target:=NEW.intent_id;
 ELSIF TG_TABLE_NAME='joinpay_refund_observation' THEN
  IF NEW.event<>'PENDING_TERMINAL' THEN RETURN NULL;END IF;target:=NEW.intent_id;
  IF NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_evidence WHERE observation_id=NEW.id)
  THEN RAISE EXCEPTION 'pending refund observation lacks terminal evidence' USING ERRCODE='23514';END IF;
 ELSIF TG_TABLE_NAME='finance_economic_root' THEN target:=NEW.source_id;
 ELSIF TG_TABLE_NAME='finance_event' THEN SELECT source_id INTO target FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 ELSE target:=NEW.details->>'nativeRefundIntentId';END IF;
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=target;
 IF i.id IS NULL OR i.payment_source<>'JOINPAY' OR i.basis_kind NOT IN('POSTING','PRESTART_TERMINATION')
 THEN RAISE EXCEPTION 'native refund closure original missing' USING ERRCODE='23514';END IF;
 IF i.lease_version>0 AND NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_attempt a
  WHERE a.intent_id=i.id AND a.lease_version=i.lease_version AND a.lease_owner=i.lease_owner)
 THEN RAISE EXCEPTION 'native refund claim has no committed original attempt' USING ERRCODE='23514';END IF;
 IF i.basis_kind='PRESTART_TERMINATION' THEN
  IF i.state IN('SUCCEEDED','FAILED') THEN
   IF NOT zzsh_order.native_prestart_refund_terminal_complete(target)
   THEN RAISE EXCEPTION 'prestart refund terminal batch incomplete' USING ERRCODE='23514';END IF;
  ELSIF i.budget_disposition<>'ALLOCATED' OR EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=target)
   OR EXISTS(SELECT 1 FROM zzsh_order.finance_economic_root WHERE source_kind='NATIVE_RENTAL_REFUND' AND source_id=target)
   OR NOT zzsh_order.native_prestart_refund_liability_complete(target)
  THEN RAISE EXCEPTION 'unresolved prestart refund cannot release or post money' USING ERRCODE='23514';END IF;
  RETURN NULL;
 END IF;
 IF i.state IN('SUCCEEDED','FAILED') THEN
  IF NOT zzsh_order.native_refund_terminal_complete(target)
  THEN RAISE EXCEPTION 'native refund terminal batch incomplete' USING ERRCODE='23514';END IF;
 ELSIF i.budget_disposition<>'ALLOCATED' OR EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=target)
  OR EXISTS(SELECT 1 FROM zzsh_order.finance_economic_root WHERE source_kind='NATIVE_RENTAL_REFUND' AND source_id=target)
 THEN RAISE EXCEPTION 'unresolved native refund cannot release or post money' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
COMMENT ON FUNCTION zzsh_order.check_native_refund_closure() IS '校验正常或未开租退款的终态、证据和资金闭合';

CREATE OR REPLACE FUNCTION zzsh_order.guard_joinpay_refund_intent() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE b record;paid_allocated numeric;responsibility_allocated numeric;proof zzsh_order.joinpay_refund_evidence;
 origin zzsh_order.joinpay_refund_observation;doc jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'refund requires READ COMMITTED' USING ERRCODE='25001';END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'refund allocation immutable' USING ERRCODE='40001';END IF;
 IF NEW.payment_source<>'JOINPAY' OR NEW.evidence_level<>'JOINPAY_FORMAL' THEN RAISE EXCEPTION 'formal refund source mismatch' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['state','revision','lease_version','lease_owner','lease_until','updated_at','budget_disposition','requires_review',
    'terminal_evidence_id','terminal_root_id','terminal_event_id','provider_refund_trx_no','completed_at'])
   IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','revision','lease_version','lease_owner','lease_until','updated_at','budget_disposition','requires_review',
    'terminal_evidence_id','terminal_root_id','terminal_event_id','provider_refund_trx_no','completed_at'])
   OR NEW.revision<>OLD.revision+1
  THEN RAISE EXCEPTION 'formal refund original binding immutable' USING ERRCODE='40001';END IF;
  IF OLD.state IN('SUCCEEDED','FAILED') THEN
   IF (to_jsonb(NEW)-ARRAY['revision','requires_review','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['revision','requires_review','updated_at'])
    OR NOT((NOT OLD.requires_review AND NEW.requires_review AND EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_observation x
      WHERE x.intent_id=OLD.id AND x.event='REVIEW' AND x.created_xid=pg_current_xact_id() AND x.state_before=OLD.state AND x.state_after=OLD.state))
     OR(OLD.requires_review AND NOT NEW.requires_review AND EXISTS(SELECT 1 FROM zzsh_order.native_refund_review_resolution z
      WHERE z.intent_id=OLD.id AND z.previous_revision=OLD.revision AND z.terminal_evidence_id=OLD.terminal_evidence_id AND z.created_xid=pg_current_xact_id()
       AND z.actor_id=current_setting('zzsh.actor_id',true) AND z.session_id=current_setting('zzsh.session_id',true) AND z.request_id=current_setting('zzsh.request_id',true))))
   THEN RAISE EXCEPTION 'formal refund terminal cannot change' USING ERRCODE='40001';END IF;
  ELSIF OLD.requires_review AND NOT NEW.requires_review THEN
   IF (to_jsonb(NEW)-ARRAY['state','revision','requires_review','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','revision','requires_review','updated_at'])
    OR NEW.state<>'UNKNOWN' OR OLD.state NOT IN('SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED')
    OR OLD.terminal_evidence_id IS NOT NULL OR OLD.budget_disposition<>'ALLOCATED' OR OLD.lease_until IS NULL OR OLD.lease_until>clock_timestamp()
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.native_refund_review_resolution z WHERE z.intent_id=OLD.id AND z.previous_revision=OLD.revision
      AND z.created_xid=pg_current_xact_id() AND z.actor_id=current_setting('zzsh.actor_id',true)
      AND z.session_id=current_setting('zzsh.session_id',true) AND z.request_id=current_setting('zzsh.request_id',true))
   THEN RAISE EXCEPTION 'native refund review requires authorized original-query recovery' USING ERRCODE='23514';END IF;
  ELSIF NOT OLD.requires_review AND NEW.requires_review THEN
   IF (to_jsonb(NEW)-ARRAY['revision','requires_review','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['revision','requires_review','updated_at'])
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_observation x WHERE x.intent_id=OLD.id AND x.event='REVIEW'
      AND x.created_xid=pg_current_xact_id() AND x.state_before=OLD.state AND x.state_after=OLD.state)
   THEN RAISE EXCEPTION 'refund conflict requires its original review observation' USING ERRCODE='23514';END IF;
  ELSIF NEW.state IN('SUCCEEDED','FAILED') THEN
   SELECT * INTO proof FROM zzsh_order.joinpay_refund_evidence WHERE id=NEW.terminal_evidence_id AND intent_id=OLD.id;
   SELECT * INTO origin FROM zzsh_order.joinpay_refund_observation WHERE id=proof.observation_id;
   IF origin.operation='QUERY' AND(OLD.lease_version IS DISTINCT FROM origin.lease_version OR OLD.lease_owner IS DISTINCT FROM origin.lease_owner
    OR OLD.lease_until IS NULL OR OLD.lease_until<=clock_timestamp())
   THEN RAISE EXCEPTION 'refund terminal lease expired' USING ERRCODE='23514',CONSTRAINT='joinpay_refund_live_lease';END IF;
   IF OLD.state NOT IN('SUBMITTING','UNKNOWN','PROCESSING') OR OLD.requires_review OR NEW.requires_review
    OR proof.id IS NULL OR proof.created_xid<>pg_current_xact_id()
    OR NEW.state IS DISTINCT FROM (CASE proof.terminal WHEN 'SUCCEEDED' THEN 'SUCCEEDED' ELSE 'FAILED' END)
    OR NEW.budget_disposition IS DISTINCT FROM (CASE proof.terminal WHEN 'SUCCEEDED' THEN 'CONSUMED' ELSE 'RELEASED' END)
    OR NEW.provider_refund_trx_no IS DISTINCT FROM proof.refund_transaction_no OR NEW.completed_at IS DISTINCT FROM proof.completed_at
    OR NEW.lease_version<>OLD.lease_version OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
   THEN RAISE EXCEPTION 'formal refund terminal lacks same transaction proof' USING ERRCODE='23514';END IF;
  ELSIF NEW.lease_version=OLD.lease_version+1 THEN
   IF (OLD.state='READY' AND OLD.requires_review) OR NEW.requires_review IS DISTINCT FROM OLD.requires_review OR OLD.due_at>clock_timestamp()
    OR(OLD.lease_until IS NOT NULL AND OLD.lease_until>clock_timestamp()) OR NEW.lease_owner IS NULL OR NEW.lease_until<=clock_timestamp()
    OR NEW.lease_until>clock_timestamp()+interval '3600 seconds'
    OR NEW.state IS DISTINCT FROM (CASE WHEN OLD.state='READY' THEN 'SUBMITTING' ELSE 'UNKNOWN' END)
    OR NEW.budget_disposition<>'ALLOCATED'
   THEN RAISE EXCEPTION 'formal refund lease not claimable' USING ERRCODE='40001';END IF;
   IF OLD.state='READY' AND EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent x WHERE x.payment_source='JOINPAY'
    AND x.merchant_identity_id=OLD.merchant_identity_id AND x.original_payment_trx_no=OLD.original_payment_trx_no AND x.requires_review)
   THEN RAISE EXCEPTION 'original payment refund submit requires review' USING ERRCODE='23514';END IF;
  ELSE
   IF NEW.lease_version<>OLD.lease_version OR NEW.lease_owner IS DISTINCT FROM OLD.lease_owner OR NEW.lease_until IS DISTINCT FROM OLD.lease_until
    OR NEW.budget_disposition<>'ALLOCATED' OR NEW.state NOT IN('UNKNOWN','PROCESSING','REVIEW_REQUIRED')
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_observation x WHERE x.intent_id=OLD.id AND x.created_xid=pg_current_xact_id()
      AND x.state_before=OLD.state AND x.state_after=NEW.state AND x.event IN('UNKNOWN','PROCESSING','REVIEW')
      AND(x.operation='NOTIFY' OR(x.lease_version=OLD.lease_version AND x.lease_owner=OLD.lease_owner AND OLD.lease_until>clock_timestamp())))
   THEN RAISE EXCEPTION 'formal refund update lacks live evidence' USING ERRCODE='40001';END IF;
  END IF;
  NEW.updated_at:=clock_timestamp();RETURN NEW;
 END IF;
 doc:=NEW.initial_admission_canonical::jsonb;
 IF (doc->>'kind' IS DISTINCT FROM 'FORMAL_NATIVE_REFUND_SERVER_REVIEW' OR doc->>'reference' IS DISTINCT FROM NEW.initial_admission_ref
  OR doc->>'reviewSha256'!~'^[a-f0-9]{64}$' OR doc->>'database' IS DISTINCT FROM current_database() OR doc->>'runtimeUser' IS DISTINCT FROM current_user
  OR doc->>'merchantIdentityId' IS DISTINCT FROM NEW.merchant_identity_id OR doc->>'merchantNo' IS DISTINCT FROM NEW.wire_merchant_no
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'='SUBMIT'
   AND p->>'profileId'=NEW.initial_profile_id AND p->>'profileSha256'=NEW.initial_profile_sha256 AND p->>'keyVersionRef'=NEW.initial_key_version_ref)
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'='QUERY')
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'acceptedProfiles') p WHERE p->>'operation'='NOTIFY')) IS NOT FALSE
 THEN RAISE EXCEPTION 'refund initial server admission resource/profile mismatch' USING ERRCODE='23514';END IF;
 IF NEW.basis_kind='PRESTART_TERMINATION' THEN
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-funds:v1','JOINPAY',NEW.merchant_identity_id,NEW.original_payment_trx_no)::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-order-no:v1',NEW.merchant_identity_id,NEW.original_payment_order_no)::text,0));
  PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.renter_user_id FOR UPDATE;
  IF NEW.posting_id IS NOT NULL OR NEW.currency<>'CNY' OR NEW.amount_cents<=0 OR NEW.amount_cents>9999999999999999
   OR NEW.state<>'READY' OR NEW.lease_version<>0 OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL
   OR NEW.revision<>1 OR NEW.requires_review OR NEW.budget_disposition<>'ALLOCATED'
   OR NEW.terminal_evidence_id IS NOT NULL OR NEW.terminal_root_id IS NOT NULL OR NEW.terminal_event_id IS NOT NULL
   OR NEW.provider_refund_trx_no IS NOT NULL OR NEW.completed_at IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.prestart_termination t
    JOIN zzsh_order.payment_confirmation c ON c.id=t.payment_basis->>'paymentConfirmationId'
    JOIN zzsh_order.joinpay_collection_binding bnd ON bnd.request_id=c.joinpay_request_id
    WHERE t.state='APPROVED' AND t.order_id=NEW.order_id AND c.id=NEW.payment_confirmation_id
     AND t.payment_basis->>'source'='JOINPAY' AND zzsh_order.prestart_liability_complete(t.id)
     AND NEW.renter_user_id=t.payment_basis->>'renterUserId' AND NEW.merchant_identity_id=c.merchant_scope_id
     AND NEW.original_payment_trx_no=c.provider_transaction_id AND NEW.original_payment_order_no=c.merchant_order_no
     AND NEW.amount_cents=c.amount_cents AND NEW.wire_merchant_no=bnd.wire_merchant_no AND NEW.due_at=t.approved_at
     AND NEW.responsibility_version_hash=t.basis_digest AND NEW.liability_root_id=t.liability_root_id AND NEW.liability_event_id=t.liability_event_id)
   OR(SELECT count(DISTINCT c.provider_transaction_id) FROM zzsh_order.payment_confirmation c
    WHERE c.source='JOINPAY' AND c.merchant_scope_id=NEW.merchant_identity_id AND c.merchant_order_no=NEW.original_payment_order_no
      AND c.disposition IN('APPLIED','REVIEW_REQUIRED'))<>1
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_revision WHERE user_id=NEW.renter_user_id)
   OR EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.payment_source='JOINPAY'
     AND i.merchant_identity_id=NEW.merchant_identity_id AND i.original_payment_trx_no=NEW.original_payment_trx_no
     AND(i.requires_review OR i.budget_disposition<>'RELEASED'))
  THEN RAISE EXCEPTION 'prestart refund requires full unique original liability' USING ERRCODE='23514';END IF;
  NEW.created_at:=clock_timestamp();NEW.updated_at:=NEW.created_at;RETURN NEW;
 END IF;
 SELECT p.order_id,p.payment_confirmation_id,p.version_hash,p.refund_due_at,p.renter_refund_cents,o.renter_user_id,
  c.source,c.merchant_scope_id,c.provider_transaction_id,c.merchant_order_no,c.amount_cents INTO b
  FROM zzsh_order.settlement_posting p JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id
  JOIN zzsh_order.rental_order o ON o.id=p.order_id AND o.paid_confirmation_id=c.id
  WHERE p.id=NEW.posting_id AND o.status='COMPLETED' AND c.order_id=o.id AND c.disposition='APPLIED' AND c.source='JOINPAY'
   AND c.currency='CNY' AND p.currency=c.currency AND p.captured_cents=c.amount_cents
   AND EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.posting_id=p.id AND l.account_code='RENTER_REFUND_PAYABLE'
    AND l.credit_cents=p.renter_refund_cents AND l.debit_cents=0 AND l.counterparty_user_id=o.renter_user_id);
 IF NOT FOUND OR NEW.order_id IS DISTINCT FROM b.order_id OR NEW.payment_confirmation_id IS DISTINCT FROM b.payment_confirmation_id
  OR NEW.renter_user_id IS DISTINCT FROM b.renter_user_id OR NEW.responsibility_version_hash IS DISTINCT FROM b.version_hash
  OR NEW.merchant_identity_id IS DISTINCT FROM b.merchant_scope_id OR NEW.original_payment_trx_no IS DISTINCT FROM b.provider_transaction_id
  OR NEW.original_payment_order_no IS DISTINCT FROM b.merchant_order_no OR NEW.due_at IS DISTINCT FROM b.refund_due_at
  OR NEW.basis_kind IS DISTINCT FROM 'POSTING' OR NEW.liability_root_id IS NOT NULL OR NEW.liability_event_id IS NOT NULL
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_revision WHERE user_id=NEW.renter_user_id)
 THEN RAISE EXCEPTION 'formal refund frozen posting basis missing' USING ERRCODE='23514';END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-funds:v1','JOINPAY',NEW.merchant_identity_id,NEW.original_payment_trx_no)::text,0));
 IF EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.payment_source='JOINPAY' AND i.merchant_identity_id=NEW.merchant_identity_id
  AND i.original_payment_trx_no=NEW.original_payment_trx_no AND i.requires_review)
 THEN RAISE EXCEPTION 'original payment refund requires review' USING ERRCODE='23514';END IF;
 SELECT COALESCE(sum(amount_cents),0),COALESCE(sum(amount_cents) FILTER(WHERE posting_id=NEW.posting_id),0)
  INTO paid_allocated,responsibility_allocated FROM zzsh_order.channel_refund_intent WHERE payment_source='JOINPAY'
  AND merchant_identity_id=NEW.merchant_identity_id AND original_payment_trx_no=NEW.original_payment_trx_no AND budget_disposition<>'RELEASED';
 IF paid_allocated+NEW.amount_cents>b.amount_cents OR responsibility_allocated+NEW.amount_cents>b.renter_refund_cents
  OR NEW.state<>'READY' OR NEW.revision<>1 OR NEW.lease_version<>0 OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL
  OR NEW.budget_disposition<>'ALLOCATED' OR NEW.requires_review
 THEN RAISE EXCEPTION 'formal refund allocation exceeds exact original liability' USING ERRCODE='23514';END IF;
 NEW.created_at:=clock_timestamp();NEW.updated_at:=NEW.created_at;RETURN NEW;
END $$;
COMMENT ON FUNCTION zzsh_order.guard_joinpay_refund_intent() IS '核验正常和未开租退款的原付款、责任与渠道状态';

-- 已验证分录约束后，去除通用守卫对已退役字段的例外；保留其他领域的原条件。
DO $retire_entry_guard$
DECLARE item record;original text;updated text;enabled "char";
 needle text:=' AND (NOT (new.details ? ''abnormalRefundLiabilityId''::text))';
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('finance_entry_guard','zzsh_order.guard_finance_entry()',false),
  ('finance_entry_batch_guard','zzsh_order.check_finance_batch()',true)
 ) AS required(name,fn,deferred) LOOP
  SELECT pg_get_triggerdef(t.oid),t.tgenabled INTO STRICT original,enabled FROM pg_trigger t
   WHERE t.tgrelid='zzsh_order.settlement_ledger_entry'::regclass AND t.tgname=item.name AND NOT t.tgisinternal
    AND t.tgfoid=to_regprocedure(item.fn) AND t.tgdeferrable=item.deferred AND t.tginitdeferred=item.deferred AND t.tgenabled IN('O','A');
  updated:=replace(original,needle,'');
  IF length(original)-length(updated)<>length(needle) THEN RAISE EXCEPTION 'retired entry exclusion differs'; END IF;
  EXECUTE format('DROP TRIGGER %I ON zzsh_order.settlement_ledger_entry',item.name);
  EXECUTE updated;
  IF enabled='A' THEN EXECUTE format('ALTER TABLE zzsh_order.settlement_ledger_entry ENABLE ALWAYS TRIGGER %I',item.name);END IF;
 END LOOP;
END $retire_entry_guard$;

DROP INDEX IF EXISTS zzsh_order.joinpay_abnormal_refund_key;
DROP TRIGGER abnormal_refund_liability_root_guard ON zzsh_order.finance_economic_root;
DROP TRIGGER abnormal_refund_liability_entry_guard ON zzsh_order.settlement_ledger_entry;
DROP TRIGGER abnormal_refund_liability_entry_batch_guard ON zzsh_order.settlement_ledger_entry;
DROP TRIGGER abnormal_refund_liability_event_guard ON zzsh_order.finance_event;
DROP TRIGGER abnormal_refund_liability_event_batch_guard ON zzsh_order.finance_event;
DROP FUNCTION zzsh_order.guard_abnormal_refund_liability_root();
DROP FUNCTION zzsh_order.guard_abnormal_refund_liability_entry();
DROP FUNCTION zzsh_order.guard_abnormal_refund_liability_event();
DROP FUNCTION zzsh_order.check_abnormal_refund_liability_batch();
DROP FUNCTION zzsh_order.native_abnormal_refund_terminal_complete(text);
DROP FUNCTION zzsh_order.native_abnormal_refund_liability_complete(text);
