-- 0106_joinpay_abnormal_refund_basis: 前向追加；由正式迁移入口安装，旧链不改写。
-- 扩展原生异常原款退款责任，保留原付款与预算约束。

ALTER TABLE zzsh_order.channel_refund_intent
  ALTER COLUMN posting_id DROP NOT NULL,
  ADD COLUMN basis_kind text NOT NULL DEFAULT 'POSTING',
  ADD COLUMN liability_root_id text,
  ADD COLUMN liability_event_id text;

ALTER TABLE zzsh_order.channel_refund_intent
  ADD CONSTRAINT channel_refund_liability_root_fk FOREIGN KEY(liability_root_id)
    REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT channel_refund_liability_event_fk FOREIGN KEY(liability_event_id)
    REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED,
  ADD CONSTRAINT channel_refund_basis_shape CHECK (
    (basis_kind='POSTING' AND posting_id IS NOT NULL AND liability_root_id IS NULL AND liability_event_id IS NULL)
    OR (basis_kind='REVIEW_CONFIRMATION' AND payment_source='JOINPAY' AND evidence_level='JOINPAY_FORMAL'
      AND posting_id IS NULL AND liability_root_id IS NOT NULL AND liability_event_id IS NOT NULL)
  );

CREATE UNIQUE INDEX joinpay_abnormal_refund_key
  ON zzsh_order.channel_refund_intent(payment_confirmation_id,idempotency_key)
  WHERE basis_kind='REVIEW_CONFIRMATION' AND payment_source='JOINPAY';

-- ---------------------------------------------------------------------------
-- 2. finance constraints: keep every existing withdrawal value, add abnormal kinds/accounts
-- ---------------------------------------------------------------------------
ALTER TABLE zzsh_order.finance_economic_root DROP CONSTRAINT finance_root_enabled_source_shape,
 ADD CONSTRAINT finance_root_enabled_source_shape CHECK((source_kind IN('LEGACY_OPENING','NATIVE_GENESIS') AND basis_id IS NOT NULL)
  OR(source_kind IN('LOCAL_CONTROLLED_WITHDRAWAL','NATIVE_RENTAL_REFERRAL','NATIVE_GUARANTEE','LEGACY_CONTINUATION_DUTY',
    'NATIVE_RENTAL_REFUND','JOINPAY_WITHDRAWAL','NATIVE_ABNORMAL_REFUND') AND basis_id IS NULL));

ALTER TABLE zzsh_order.finance_event DROP CONSTRAINT finance_event_kind_check,
 ADD CONSTRAINT finance_event_kind_check CHECK(kind IN('OPENING','RESERVE','RELEASE','PAYOUT','EARNING_PENDING','EARNING_SETTLED','EARNING_REVOKED',
  'GUARANTEE_CAPTURE','GUARANTEE_REFUND','LEGACY_DUTY_SETTLED','REFUND_PAID','JOINPAY_WITHDRAWAL_RESERVED','JOINPAY_WITHDRAWAL_PAID',
  'JOINPAY_WITHDRAWAL_RELEASED','REFUND_LIABILITY_RECOGNIZED'));

ALTER TABLE zzsh_order.settlement_ledger_entry DROP CONSTRAINT settlement_ledger_accounts,
 ADD CONSTRAINT settlement_ledger_accounts CHECK(
  (posting_id IS NOT NULL AND account_code IN('CAPTURED_PAYMENT_SOURCE','OWNER_AVAILABLE','RENTER_REFUND_PAYABLE',
    'PLATFORM_HAFF_SPREAD','PLATFORM_ITEM_SPREAD','PLATFORM_EARLY_MAKEUP','PLATFORM_COMPENSATION_FEE','PLATFORM_MANUAL_NET_ADJUSTMENT'))
  OR(finance_event_id IS NOT NULL AND account_code IN('WALLET_AVAILABLE','LEGACY_OPENING_SOURCE','WALLET_RESERVED','PAYOUT_CLEARING',
    'WITHDRAW_FEE','WALLET_PENDING_EARNINGS','DISTRIBUTION_EXPENSE','GUARANTEE_CASH','GUARANTEE_HELD','LEGACY_LIABILITY_SOURCE',
    'OWNER_AVAILABLE','RENTER_REFUND_PAYABLE','JOINPAY_UNALLOCATED_RECEIPT')));

-- ---------------------------------------------------------------------------
-- 3. abnormal liability root / event / entry narrow guards
-- ---------------------------------------------------------------------------
CREATE FUNCTION zzsh_order.guard_abnormal_refund_liability_root() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE basis_row record;
BEGIN
  SELECT c0.order_id,c0.source,c0.disposition,c0.reason_code,c0.currency,c0.amount_cents,c0.merchant_scope_id,
         c0.provider_transaction_id,c0.merchant_order_no,c0.joinpay_request_id,c0.joinpay_evidence_id,c0.joinpay_anchor_id,o.renter_user_id,
         rq.channel AS request_channel,rq.evidence_level AS request_evidence_level,rq.merchant_identity_id AS request_merchant,
         rq.channel_order_no AS request_order_no,rq.amount_cents AS request_amount_cents,rq.currency AS request_currency,
         bnd.wire_merchant_no AS binding_wire_merchant_no,bnd.formal_admission_ref AS formal_admission_ref,
         ev.event AS evidence_event,ev.channel_trx_no AS evidence_trx,ev.schema_outcome AS evidence_schema,
         ev.signature_outcome AS evidence_signature,ev.binding_outcome AS evidence_binding,ev.raw_sha256 AS evidence_raw_sha256,
         an.channel AS anchor_channel,an.evidence_level AS anchor_evidence_level,an.native_order_id AS anchor_order,
         an.request_id AS anchor_request,an.merchant_identity_id AS anchor_merchant,an.channel_trx_no AS anchor_trx
    INTO basis_row
    FROM zzsh_order.payment_confirmation c0
    JOIN zzsh_order.rental_order o ON o.id=c0.order_id
    LEFT JOIN zzsh_order.payment_request rq ON rq.id=c0.joinpay_request_id AND rq.order_id=c0.order_id
    LEFT JOIN zzsh_order.joinpay_collection_binding bnd ON bnd.request_id=rq.id
    LEFT JOIN zzsh_order.joinpay_collection_evidence ev ON ev.id=c0.joinpay_evidence_id AND ev.request_id=c0.joinpay_request_id
    LEFT JOIN zzsh_order.payment_channel_transaction an ON an.id=c0.joinpay_anchor_id
   WHERE c0.id=NEW.source_id;
  IF NOT FOUND OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh'
   OR NEW.source_entity<>'joinpay_abnormal_refund_liability' OR NEW.basis_id IS NOT NULL
   OR NEW.beneficiary_role<>'RENTER' OR NEW.policy_version IS NOT NULL
   OR NEW.id IS DISTINCT FROM 'native_abnormal_refund_liability_'||substr(encode(sha256(convert_to(NEW.source_id,'UTF8')),'hex'),1,40)
   OR basis_row.source IS DISTINCT FROM 'JOINPAY' OR basis_row.disposition IS DISTINCT FROM 'REVIEW_REQUIRED'
   OR basis_row.reason_code IS NULL OR basis_row.reason_code NOT IN('DUPLICATE_PAYMENT','LATE_PAYMENT')
   OR basis_row.currency IS DISTINCT FROM 'CNY'
   OR NEW.subject_user_id IS DISTINCT FROM basis_row.renter_user_id
   OR NEW.source_digest IS DISTINCT FROM basis_row.evidence_raw_sha256
   OR basis_row.request_channel IS DISTINCT FROM 'JOINPAY' OR basis_row.request_evidence_level IS DISTINCT FROM 'JOINPAY_CANDIDATE'
   OR basis_row.request_merchant IS DISTINCT FROM basis_row.merchant_scope_id
   OR basis_row.request_order_no IS DISTINCT FROM basis_row.merchant_order_no
   OR basis_row.request_amount_cents IS DISTINCT FROM basis_row.amount_cents OR basis_row.request_currency IS DISTINCT FROM 'CNY'
   OR basis_row.formal_admission_ref IS NULL OR basis_row.binding_wire_merchant_no IS NULL
   OR basis_row.evidence_event IS DISTINCT FROM 'E4' OR basis_row.evidence_schema IS DISTINCT FROM 'VALID'
   OR basis_row.evidence_signature IS DISTINCT FROM 'MATCH' OR basis_row.evidence_binding IS DISTINCT FROM 'MATCH'
   OR basis_row.evidence_trx IS DISTINCT FROM basis_row.provider_transaction_id
   OR basis_row.anchor_channel IS DISTINCT FROM 'JOINPAY' OR basis_row.anchor_evidence_level IS DISTINCT FROM 'JOINPAY_VERIFIED'
   OR basis_row.anchor_order IS DISTINCT FROM basis_row.order_id OR basis_row.anchor_request IS DISTINCT FROM basis_row.joinpay_request_id
   OR basis_row.anchor_merchant IS DISTINCT FROM basis_row.merchant_scope_id
   OR basis_row.anchor_trx IS DISTINCT FROM basis_row.provider_transaction_id
   OR EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.source='JOINPAY'
      AND p.merchant_scope_id=basis_row.merchant_scope_id AND p.provider_transaction_id=basis_row.provider_transaction_id AND p.disposition='APPLIED')
   OR EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.payment_confirmation_id=NEW.source_id)
   OR (SELECT count(DISTINCT p.provider_transaction_id) FROM zzsh_order.payment_confirmation p
       WHERE p.source='JOINPAY' AND p.merchant_scope_id=basis_row.merchant_scope_id
         AND p.merchant_order_no=basis_row.merchant_order_no AND p.disposition IN('APPLIED','REVIEW_REQUIRED'))<>1
  THEN RAISE EXCEPTION 'abnormal refund liability root basis differs' USING ERRCODE='23514';
  END IF;
  NEW.created_xid:=pg_current_xact_id();
  NEW.created_at:=clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER abnormal_refund_liability_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root
  FOR EACH ROW WHEN(NEW.source_kind='NATIVE_ABNORMAL_REFUND') EXECUTE FUNCTION zzsh_order.guard_abnormal_refund_liability_root();

CREATE FUNCTION zzsh_order.guard_abnormal_refund_liability_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r zzsh_order.finance_economic_root;rev bigint;
BEGIN
  SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
  SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=NEW.subject_user_id;
  IF r.id IS NULL OR r.source_kind<>'NATIVE_ABNORMAL_REFUND' OR r.source_entity<>'joinpay_abnormal_refund_liability'
   OR r.source_type<>'NATIVE' OR r.source_system<>'zzsh' OR r.basis_id IS NOT NULL OR r.created_xid<>pg_current_xact_id()
   OR NEW.kind<>'REFUND_LIABILITY_RECOGNIZED' OR NEW.subject_user_id IS DISTINCT FROM r.subject_user_id
   OR NEW.id IS DISTINCT FROM r.id||'_recognized' OR rev IS NULL OR NEW.expected_ledger_revision IS DISTINCT FROM rev
  THEN RAISE EXCEPTION 'abnormal refund liability event root/revision differs' USING ERRCODE='23514';
  END IF;
  NEW.created_xid:=pg_current_xact_id();
  NEW.created_at:=clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER abnormal_refund_liability_event_guard BEFORE INSERT ON zzsh_order.finance_event
  FOR EACH ROW WHEN(NEW.kind='REFUND_LIABILITY_RECOGNIZED') EXECUTE FUNCTION zzsh_order.guard_abnormal_refund_liability_event();

CREATE FUNCTION zzsh_order.guard_abnormal_refund_liability_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE ev zzsh_order.finance_event;r zzsh_order.finance_economic_root;c zzsh_order.payment_confirmation;
BEGIN
  SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
  SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=ev.economic_root_id;
  SELECT * INTO c FROM zzsh_order.payment_confirmation WHERE id=(NEW.details->>'abnormalRefundLiabilityId');
  IF ev.id IS NULL OR ev.kind<>'REFUND_LIABILITY_RECOGNIZED' OR ev.created_xid<>pg_current_xact_id()
   OR r.id IS NULL OR r.source_kind<>'NATIVE_ABNORMAL_REFUND' OR r.source_entity<>'joinpay_abnormal_refund_liability'
   OR r.source_type<>'NATIVE' OR r.source_system<>'zzsh' OR r.basis_id IS NOT NULL
   OR r.subject_user_id IS DISTINCT FROM ev.subject_user_id OR c.id IS NULL OR c.id IS DISTINCT FROM r.source_id
   OR NEW.posting_id IS NOT NULL OR NEW.source_payment_confirmation_id IS NOT NULL
   OR NEW.details IS DISTINCT FROM jsonb_build_object('abnormalRefundLiabilityId',c.id,'paymentConfirmationId',c.id,
     'evidenceId',c.joinpay_evidence_id,'anchorId',c.joinpay_anchor_id,'amountCents',c.amount_cents::text)
   OR NOT((NEW.line_no=1 AND NEW.account_code='JOINPAY_UNALLOCATED_RECEIPT' AND NEW.debit_cents=c.amount_cents
       AND NEW.credit_cents=0 AND NEW.counterparty_user_id IS NULL)
     OR(NEW.line_no=2 AND NEW.account_code='RENTER_REFUND_PAYABLE' AND NEW.debit_cents=0 AND NEW.credit_cents=c.amount_cents
       AND NEW.counterparty_user_id=r.subject_user_id))
  THEN RAISE EXCEPTION 'abnormal refund liability entry differs' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER abnormal_refund_liability_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry
  FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'abnormalRefundLiabilityId')
  EXECUTE FUNCTION zzsh_order.guard_abnormal_refund_liability_entry();

CREATE FUNCTION zzsh_order.check_abnormal_refund_liability_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_id text;ev zzsh_order.finance_event;r zzsh_order.finance_economic_root;c zzsh_order.payment_confirmation;
  total bigint;debit_total numeric;credit_total numeric;good bigint;
BEGIN
  IF TG_TABLE_NAME='finance_event' THEN event_id:=NEW.id; ELSE event_id:=NEW.finance_event_id; END IF;
  SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=event_id AND kind='REFUND_LIABILITY_RECOGNIZED';
  IF ev.id IS NULL THEN RETURN NULL;END IF;
  SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=ev.economic_root_id;
  SELECT * INTO c FROM zzsh_order.payment_confirmation WHERE id=r.source_id;
  IF r.id IS NULL OR c.id IS NULL OR r.source_kind<>'NATIVE_ABNORMAL_REFUND' THEN
    RAISE EXCEPTION 'abnormal refund liability batch original missing' USING ERRCODE='23514';
  END IF;
  SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0),
         count(*) FILTER(WHERE source_payment_confirmation_id IS NULL
           AND details=jsonb_build_object('abnormalRefundLiabilityId',c.id,'paymentConfirmationId',c.id,
             'evidenceId',c.joinpay_evidence_id,'anchorId',c.joinpay_anchor_id,'amountCents',c.amount_cents::text)
           AND((line_no=1 AND account_code='JOINPAY_UNALLOCATED_RECEIPT' AND debit_cents=c.amount_cents AND credit_cents=0
               AND counterparty_user_id IS NULL)
             OR(line_no=2 AND account_code='RENTER_REFUND_PAYABLE' AND debit_cents=0 AND credit_cents=c.amount_cents
               AND counterparty_user_id=r.subject_user_id)))
    INTO total,debit_total,credit_total,good FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=ev.id;
  IF total<>2 OR good<>2 OR debit_total<>c.amount_cents OR credit_total<>c.amount_cents THEN
    RAISE EXCEPTION 'abnormal refund liability batch is incomplete' USING ERRCODE='23514';
  END IF;
  RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER abnormal_refund_liability_event_batch_guard AFTER INSERT ON zzsh_order.finance_event
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='REFUND_LIABILITY_RECOGNIZED')
  EXECUTE FUNCTION zzsh_order.check_abnormal_refund_liability_batch();

CREATE CONSTRAINT TRIGGER abnormal_refund_liability_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
  WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'abnormalRefundLiabilityId')
  EXECUTE FUNCTION zzsh_order.check_abnormal_refund_liability_batch();

-- ---------------------------------------------------------------------------
-- 4. replace the JOINPAY refund intent guard: normal posting logic kept; only basis_kind/liability-null checks added
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION zzsh_order.guard_joinpay_refund_intent() RETURNS trigger LANGUAGE plpgsql VOLATILE AS $$
DECLARE b record;paid_allocated numeric;responsibility_allocated numeric;proof zzsh_order.joinpay_refund_evidence;
 origin zzsh_order.joinpay_refund_observation;doc jsonb;basis_row record;lr zzsh_order.finance_economic_root;
 le zzsh_order.finance_event;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' THEN RAISE EXCEPTION 'refund requires READ COMMITTED' USING ERRCODE='25001';END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'refund allocation immutable' USING ERRCODE='40001';END IF;
 IF NEW.payment_source<>'JOINPAY' OR NEW.evidence_level<>'JOINPAY_FORMAL' THEN RAISE EXCEPTION 'formal refund source mismatch' USING ERRCODE='23514';END IF;
 IF TG_OP='UPDATE' THEN
  IF (to_jsonb(NEW)-ARRAY['state','revision','lease_version','lease_owner','lease_until','updated_at','budget_disposition','requires_review',
    'terminal_evidence_id','terminal_root_id','terminal_event_id','provider_refund_trx_no','completed_at'])
   IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','revision','lease_version','lease_owner','lease_until','updated_at','budget_disposition','requires_review',
    'terminal_evidence_id','terminal_root_id','terminal_event_id','provider_refund_trx_no','completed_at'])
   OR NEW.revision<>OLD.revision+1 OR(OLD.requires_review AND NOT NEW.requires_review)
  THEN RAISE EXCEPTION 'formal refund original binding immutable' USING ERRCODE='40001';END IF;
  IF OLD.state IN('SUCCEEDED','FAILED') THEN
   IF (to_jsonb(NEW)-ARRAY['revision','requires_review','updated_at']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['revision','requires_review','updated_at'])
    OR OLD.requires_review OR NOT NEW.requires_review
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_observation x WHERE x.intent_id=OLD.id AND x.event='REVIEW'
      AND x.created_xid=pg_current_xact_id() AND x.state_before=OLD.state AND x.state_after=OLD.state)
   THEN RAISE EXCEPTION 'formal refund terminal cannot change' USING ERRCODE='40001';END IF;
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
 IF NEW.basis_kind='REVIEW_CONFIRMATION' THEN
  IF NEW.posting_id IS NOT NULL OR NEW.liability_root_id IS NULL OR NEW.liability_event_id IS NULL
   OR NEW.currency<>'CNY' OR NEW.amount_cents<=0 THEN
   RAISE EXCEPTION 'abnormal refund basis shape differs' USING ERRCODE='23514';
  END IF;
  SELECT c0.order_id,c0.source,c0.disposition,c0.reason_code,c0.currency,c0.amount_cents,c0.merchant_scope_id,
         c0.provider_transaction_id,c0.merchant_order_no,c0.joinpay_request_id,c0.joinpay_evidence_id,c0.joinpay_anchor_id,o.renter_user_id,
         rq.channel AS request_channel,rq.evidence_level AS request_evidence_level,rq.merchant_identity_id AS request_merchant,
         rq.channel_order_no AS request_order_no,rq.amount_cents AS request_amount_cents,rq.currency AS request_currency,
         bnd.wire_merchant_no AS binding_wire_merchant_no,bnd.formal_admission_ref AS formal_admission_ref,
         ev.event AS evidence_event,ev.channel_trx_no AS evidence_trx,ev.schema_outcome AS evidence_schema,
         ev.signature_outcome AS evidence_signature,ev.binding_outcome AS evidence_binding,ev.raw_sha256 AS evidence_raw_sha256,
         an.channel AS anchor_channel,an.evidence_level AS anchor_evidence_level,an.native_order_id AS anchor_order,
         an.request_id AS anchor_request,an.merchant_identity_id AS anchor_merchant,an.channel_trx_no AS anchor_trx
    INTO basis_row
    FROM zzsh_order.payment_confirmation c0
    JOIN zzsh_order.rental_order o ON o.id=c0.order_id
    LEFT JOIN zzsh_order.payment_request rq ON rq.id=c0.joinpay_request_id AND rq.order_id=c0.order_id
    LEFT JOIN zzsh_order.joinpay_collection_binding bnd ON bnd.request_id=rq.id
    LEFT JOIN zzsh_order.joinpay_collection_evidence ev ON ev.id=c0.joinpay_evidence_id AND ev.request_id=c0.joinpay_request_id
    LEFT JOIN zzsh_order.payment_channel_transaction an ON an.id=c0.joinpay_anchor_id
   WHERE c0.id=NEW.payment_confirmation_id AND c0.order_id=NEW.order_id;
  IF NOT FOUND
   OR basis_row.source IS DISTINCT FROM 'JOINPAY' OR basis_row.disposition IS DISTINCT FROM 'REVIEW_REQUIRED'
   OR basis_row.reason_code IS NULL OR basis_row.reason_code NOT IN('DUPLICATE_PAYMENT','LATE_PAYMENT')
   OR basis_row.currency IS DISTINCT FROM 'CNY' OR NEW.currency IS DISTINCT FROM 'CNY'
   OR NEW.amount_cents IS DISTINCT FROM basis_row.amount_cents
   OR NEW.renter_user_id IS DISTINCT FROM basis_row.renter_user_id
   OR NEW.merchant_identity_id IS DISTINCT FROM basis_row.merchant_scope_id
   OR NEW.original_payment_trx_no IS DISTINCT FROM basis_row.provider_transaction_id
   OR NEW.original_payment_order_no IS DISTINCT FROM basis_row.merchant_order_no
   OR basis_row.joinpay_request_id IS NULL OR basis_row.joinpay_evidence_id IS NULL OR basis_row.joinpay_anchor_id IS NULL
   OR basis_row.request_channel IS DISTINCT FROM 'JOINPAY' OR basis_row.request_evidence_level IS DISTINCT FROM 'JOINPAY_CANDIDATE'
   OR basis_row.request_merchant IS DISTINCT FROM basis_row.merchant_scope_id
   OR basis_row.request_order_no IS DISTINCT FROM basis_row.merchant_order_no
   OR basis_row.request_amount_cents IS DISTINCT FROM basis_row.amount_cents OR basis_row.request_currency IS DISTINCT FROM 'CNY'
   OR basis_row.formal_admission_ref IS NULL OR basis_row.binding_wire_merchant_no IS DISTINCT FROM NEW.wire_merchant_no
   OR basis_row.evidence_event IS DISTINCT FROM 'E4' OR basis_row.evidence_trx IS DISTINCT FROM basis_row.provider_transaction_id
   OR basis_row.evidence_schema IS DISTINCT FROM 'VALID' OR basis_row.evidence_signature IS DISTINCT FROM 'MATCH'
   OR basis_row.evidence_binding IS DISTINCT FROM 'MATCH' OR basis_row.evidence_raw_sha256 IS DISTINCT FROM NEW.responsibility_version_hash
   OR basis_row.anchor_channel IS DISTINCT FROM 'JOINPAY' OR basis_row.anchor_evidence_level IS DISTINCT FROM 'JOINPAY_VERIFIED'
   OR basis_row.anchor_order IS DISTINCT FROM basis_row.order_id OR basis_row.anchor_request IS DISTINCT FROM basis_row.joinpay_request_id
   OR basis_row.anchor_merchant IS DISTINCT FROM basis_row.merchant_scope_id
   OR basis_row.anchor_trx IS DISTINCT FROM basis_row.provider_transaction_id
   OR EXISTS(SELECT 1 FROM zzsh_order.payment_confirmation p WHERE p.source='JOINPAY'
      AND p.merchant_scope_id=basis_row.merchant_scope_id AND p.provider_transaction_id=basis_row.provider_transaction_id AND p.disposition='APPLIED')
   OR EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.payment_confirmation_id=NEW.payment_confirmation_id)
   OR (SELECT count(DISTINCT p.provider_transaction_id) FROM zzsh_order.payment_confirmation p
       WHERE p.source='JOINPAY' AND p.merchant_scope_id=basis_row.merchant_scope_id
         AND p.merchant_order_no=basis_row.merchant_order_no AND p.disposition IN('APPLIED','REVIEW_REQUIRED'))<>1
   OR NEW.liability_root_id IS DISTINCT FROM 'native_abnormal_refund_liability_'||substr(encode(sha256(convert_to(NEW.payment_confirmation_id,'UTF8')),'hex'),1,40)
   OR NEW.liability_event_id IS DISTINCT FROM NEW.liability_root_id||'_recognized'
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_revision WHERE user_id=NEW.renter_user_id)
  THEN RAISE EXCEPTION 'abnormal refund review basis differs' USING ERRCODE='23514';
  END IF;
  SELECT * INTO lr FROM zzsh_order.finance_economic_root WHERE id=NEW.liability_root_id;
  SELECT * INTO le FROM zzsh_order.finance_event WHERE id=NEW.liability_event_id;
  IF lr.id IS NULL OR le.id IS NULL OR lr.source_kind<>'NATIVE_ABNORMAL_REFUND'
   OR lr.source_type<>'NATIVE' OR lr.source_system<>'zzsh' OR lr.source_entity<>'joinpay_abnormal_refund_liability'
   OR lr.basis_id IS NOT NULL OR lr.policy_version IS NOT NULL OR lr.beneficiary_role<>'RENTER'
   OR lr.source_id IS DISTINCT FROM NEW.payment_confirmation_id OR lr.subject_user_id IS DISTINCT FROM NEW.renter_user_id
   OR lr.source_digest IS DISTINCT FROM NEW.responsibility_version_hash
   OR le.kind<>'REFUND_LIABILITY_RECOGNIZED' OR le.economic_root_id IS DISTINCT FROM lr.id
   OR le.subject_user_id IS DISTINCT FROM NEW.renter_user_id
   OR (SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=le.id)<>2
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=le.id AND l.line_no=1
     AND l.account_code='JOINPAY_UNALLOCATED_RECEIPT' AND l.debit_cents=NEW.amount_cents AND l.credit_cents=0
     AND l.counterparty_user_id IS NULL AND l.posting_id IS NULL AND l.source_payment_confirmation_id IS NULL
     AND l.details=jsonb_build_object('abnormalRefundLiabilityId',NEW.payment_confirmation_id,
       'paymentConfirmationId',NEW.payment_confirmation_id,'evidenceId',basis_row.joinpay_evidence_id,
       'anchorId',basis_row.joinpay_anchor_id,'amountCents',NEW.amount_cents::text))
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=le.id AND l.line_no=2
     AND l.account_code='RENTER_REFUND_PAYABLE' AND l.debit_cents=0 AND l.credit_cents=NEW.amount_cents
     AND l.counterparty_user_id=NEW.renter_user_id AND l.posting_id IS NULL AND l.source_payment_confirmation_id IS NULL
     AND l.details=jsonb_build_object('abnormalRefundLiabilityId',NEW.payment_confirmation_id,
       'paymentConfirmationId',NEW.payment_confirmation_id,'evidenceId',basis_row.joinpay_evidence_id,
       'anchorId',basis_row.joinpay_anchor_id,'amountCents',NEW.amount_cents::text))
  THEN RAISE EXCEPTION 'abnormal refund liability closure differs' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-funds:v1','JOINPAY',NEW.merchant_identity_id,NEW.original_payment_trx_no)::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-order-no:v1',NEW.merchant_identity_id,NEW.original_payment_order_no)::text,0));
  PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.renter_user_id FOR UPDATE;
  SELECT COALESCE(sum(amount_cents),0) INTO paid_allocated FROM zzsh_order.channel_refund_intent
   WHERE payment_source='JOINPAY' AND merchant_identity_id=NEW.merchant_identity_id
     AND original_payment_trx_no=NEW.original_payment_trx_no AND budget_disposition<>'RELEASED';
  IF paid_allocated+NEW.amount_cents>basis_row.amount_cents THEN
    RAISE EXCEPTION 'abnormal refund exceeds original payment budget' USING ERRCODE='23514';
  END IF;
  IF EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent x WHERE x.payment_confirmation_id=NEW.payment_confirmation_id
    AND x.basis_kind='REVIEW_CONFIRMATION' AND x.budget_disposition<>'RELEASED')
  THEN RAISE EXCEPTION 'abnormal refund already active for confirmation' USING ERRCODE='23514';
  END IF;
  IF NEW.state<>'READY' OR NEW.revision<>1 OR NEW.lease_version<>0 OR NEW.lease_owner IS NOT NULL OR NEW.lease_until IS NOT NULL
   OR NEW.budget_disposition<>'ALLOCATED' OR NEW.requires_review OR NEW.due_at IS NULL
  THEN RAISE EXCEPTION 'abnormal refund intent must start unclaimed' USING ERRCODE='23514';
  END IF;
  NEW.created_at:=clock_timestamp();
  NEW.updated_at:=NEW.created_at;
  RETURN NEW;
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

-- ---------------------------------------------------------------------------
-- 5. replace the native refund entry guard: abnormal terminal credit is the unallocated receipt
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION zzsh_order.guard_native_refund_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.channel_refund_intent;e zzsh_order.joinpay_refund_evidence;ev zzsh_order.finance_event;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=NEW.details->>'nativeRefundIntentId';
 SELECT * INTO e FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=i.id;
 SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 IF i.id IS NULL OR e.id IS NULL OR e.created_xid<>pg_current_xact_id() OR e.terminal<>'SUCCEEDED'
  OR ev.id IS NULL OR ev.kind<>'REFUND_PAID' OR ev.created_xid<>pg_current_xact_id()
  OR ev.economic_root_id IS DISTINCT FROM 'native_refund_root_'||substr(encode(sha256(convert_to(i.id,'UTF8')),'hex'),1,40)
  OR ev.subject_user_id<>i.renter_user_id OR NEW.source_payment_confirmation_id IS NOT NULL
  OR(i.basis_kind='REVIEW_CONFIRMATION' AND i.posting_id IS NOT NULL)
  OR NEW.details IS DISTINCT FROM jsonb_build_object('nativeRefundIntentId',i.id,'postingId',i.posting_id,
   'paymentConfirmationId',i.payment_confirmation_id,'refundOrderNo',i.refund_order_no,'factsDigest',e.facts_digest)
  OR NOT((NEW.line_no=1 AND NEW.account_code='RENTER_REFUND_PAYABLE' AND NEW.debit_cents=i.amount_cents AND NEW.credit_cents=0
    AND NEW.counterparty_user_id=i.renter_user_id)
   OR(NEW.line_no=2 AND NEW.account_code=CASE WHEN i.basis_kind='REVIEW_CONFIRMATION' THEN 'JOINPAY_UNALLOCATED_RECEIPT' ELSE 'PAYOUT_CLEARING' END
    AND NEW.debit_cents=0 AND NEW.credit_cents=i.amount_cents AND NEW.counterparty_user_id IS NULL))
 THEN RAISE EXCEPTION 'native refund entry differs from original responsibility consumption' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

-- ---------------------------------------------------------------------------
-- 6. abnormal liability and terminal completeness
-- ---------------------------------------------------------------------------
CREATE FUNCTION zzsh_order.native_abnormal_refund_liability_complete(intent_id_value text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.channel_refund_intent;r zzsh_order.finance_economic_root;ev zzsh_order.finance_event;
 c zzsh_order.payment_confirmation;total bigint;good bigint;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=intent_id_value;
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=i.liability_root_id;
 SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=i.liability_event_id;
 SELECT * INTO c FROM zzsh_order.payment_confirmation WHERE id=i.payment_confirmation_id;
 IF i.id IS NULL OR i.basis_kind<>'REVIEW_CONFIRMATION' OR i.posting_id IS NOT NULL OR r.id IS NULL OR ev.id IS NULL OR c.id IS NULL
  OR r.source_kind<>'NATIVE_ABNORMAL_REFUND' OR r.source_type<>'NATIVE' OR r.source_system<>'zzsh'
  OR r.source_entity<>'joinpay_abnormal_refund_liability' OR r.basis_id IS NOT NULL OR r.policy_version IS NOT NULL
  OR r.source_id<>i.payment_confirmation_id OR r.subject_user_id<>i.renter_user_id
  OR r.source_digest<>i.responsibility_version_hash OR r.beneficiary_role<>'RENTER'
  OR r.id<>'native_abnormal_refund_liability_'||substr(encode(sha256(convert_to(i.payment_confirmation_id,'UTF8')),'hex'),1,40)
  OR ev.kind<>'REFUND_LIABILITY_RECOGNIZED' OR ev.economic_root_id<>r.id OR ev.subject_user_id<>i.renter_user_id
  OR ev.id<>r.id||'_recognized' OR c.amount_cents<>i.amount_cents OR c.joinpay_evidence_id IS NULL OR c.joinpay_anchor_id IS NULL
  OR(SELECT count(*) FROM zzsh_order.finance_event WHERE economic_root_id=r.id)<>1
 THEN RETURN false;END IF;
 SELECT count(*),count(*) FILTER(WHERE source_payment_confirmation_id IS NULL
   AND details=jsonb_build_object('abnormalRefundLiabilityId',i.payment_confirmation_id,'paymentConfirmationId',i.payment_confirmation_id,
     'evidenceId',c.joinpay_evidence_id,'anchorId',c.joinpay_anchor_id,'amountCents',i.amount_cents::text)
   AND((line_no=1 AND account_code='JOINPAY_UNALLOCATED_RECEIPT' AND debit_cents=i.amount_cents AND credit_cents=0
       AND counterparty_user_id IS NULL)
     OR(line_no=2 AND account_code='RENTER_REFUND_PAYABLE' AND debit_cents=0 AND credit_cents=i.amount_cents
       AND counterparty_user_id=i.renter_user_id)))
  INTO total,good FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=ev.id;
 RETURN total=2 AND good=2;
END $$;

CREATE FUNCTION zzsh_order.native_abnormal_refund_terminal_complete(intent_id_value text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.channel_refund_intent;e zzsh_order.joinpay_refund_evidence;r zzsh_order.finance_economic_root;
 ev zzsh_order.finance_event;rev bigint;lines bigint;good bigint;dr numeric;cr numeric;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=intent_id_value;
 SELECT * INTO e FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=i.id;
 IF i.id IS NULL OR i.payment_source<>'JOINPAY' OR i.evidence_level<>'JOINPAY_FORMAL'
  OR i.basis_kind<>'REVIEW_CONFIRMATION' OR i.posting_id IS NOT NULL OR e.id IS NULL
  OR i.terminal_evidence_id IS DISTINCT FROM e.id OR i.provider_refund_trx_no IS DISTINCT FROM e.refund_transaction_no
  OR i.completed_at IS DISTINCT FROM e.completed_at
  OR NOT zzsh_order.native_abnormal_refund_liability_complete(i.id)
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
   OR(line_no=2 AND account_code='JOINPAY_UNALLOCATED_RECEIPT' AND debit_cents=0 AND credit_cents=i.amount_cents AND counterparty_user_id IS NULL)))
  INTO lines,dr,cr,good FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=ev.id;
 RETURN lines=2 AND good=2 AND dr=i.amount_cents AND cr=i.amount_cents
  AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.refund.liability.consumed' AND a.object_type='channel_refund_intent'
   AND a.object_id=i.id AND a.outcome='SUCCESS' AND a.details->>'evidenceId'=e.id AND a.details->>'factsDigest'=e.facts_digest
   AND a.details->>'budgetDisposition'='CONSUMED' AND a.details->>'postingId' IS NULL
   AND a.details->>'paymentConfirmationId'=i.payment_confirmation_id AND a.details->>'amountCents'=i.amount_cents::text
   AND a.details->>'currency'='CNY' AND a.details->>'channelArrival'='UNKNOWN');
END $$;

-- ---------------------------------------------------------------------------
-- 7. replace the native refund closure: abnormal basis uses its own terminal batch
-- ---------------------------------------------------------------------------
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
 IF i.id IS NULL OR i.payment_source<>'JOINPAY' THEN RAISE EXCEPTION 'native refund closure original missing' USING ERRCODE='23514';END IF;
 IF i.lease_version>0 AND NOT EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_attempt a
  WHERE a.intent_id=i.id AND a.lease_version=i.lease_version AND a.lease_owner=i.lease_owner)
 THEN RAISE EXCEPTION 'native refund claim has no committed original attempt' USING ERRCODE='23514';END IF;
 IF i.state IN('SUCCEEDED','FAILED') THEN
  IF i.basis_kind='REVIEW_CONFIRMATION' THEN
   IF NOT zzsh_order.native_abnormal_refund_terminal_complete(target)
   THEN RAISE EXCEPTION 'abnormal refund terminal batch incomplete' USING ERRCODE='23514';END IF;
  ELSE
   IF NOT zzsh_order.native_refund_terminal_complete(target)
   THEN RAISE EXCEPTION 'native refund terminal batch incomplete' USING ERRCODE='23514';END IF;
  END IF;
 ELSIF i.basis_kind='REVIEW_CONFIRMATION' THEN
  IF i.budget_disposition<>'ALLOCATED' OR EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=target)
   OR EXISTS(SELECT 1 FROM zzsh_order.finance_economic_root WHERE source_kind='NATIVE_RENTAL_REFUND' AND source_id=target)
   OR NOT zzsh_order.native_abnormal_refund_liability_complete(target)
  THEN RAISE EXCEPTION 'unresolved abnormal refund cannot release or post money' USING ERRCODE='23514';END IF;
 ELSIF i.budget_disposition<>'ALLOCATED' OR EXISTS(SELECT 1 FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=target)
  OR EXISTS(SELECT 1 FROM zzsh_order.finance_economic_root WHERE source_kind='NATIVE_RENTAL_REFUND' AND source_id=target)
 THEN RAISE EXCEPTION 'unresolved native refund cannot release or post money' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;

-- ---------------------------------------------------------------------------
-- 8. generic finance entry guards: keep every existing exclusion, add abnormal liability exclusion
-- ---------------------------------------------------------------------------
DROP TRIGGER finance_entry_guard ON zzsh_order.settlement_ledger_entry;
CREATE TRIGGER finance_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId') AND NOT(NEW.details?'earningId') AND NOT(NEW.details?'guaranteeId')
  AND NOT(NEW.details?'legacyDutyId') AND NOT(NEW.details?'nativeRefundIntentId') AND NOT(NEW.details?'joinpayWithdrawalIntentId')
  AND NOT(NEW.details?'abnormalRefundLiabilityId'))
 EXECUTE FUNCTION zzsh_order.guard_finance_entry();

DROP TRIGGER finance_entry_batch_guard ON zzsh_order.settlement_ledger_entry;
CREATE CONSTRAINT TRIGGER finance_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId') AND NOT(NEW.details?'earningId') AND NOT(NEW.details?'guaranteeId')
  AND NOT(NEW.details?'legacyDutyId') AND NOT(NEW.details?'nativeRefundIntentId') AND NOT(NEW.details?'joinpayWithdrawalIntentId')
  AND NOT(NEW.details?'abnormalRefundLiabilityId'))
 EXECUTE FUNCTION zzsh_order.check_finance_batch();

-- ---------------------------------------------------------------------------
-- 9. wallet revision decision
-- ---------------------------------------------------------------------------
-- REFUND_LIABILITY_RECOGNIZED deliberately does NOT advance wallet_revision:
-- it moves JOINPAY_UNALLOCATED_RECEIPT to RENTER_REFUND_PAYABLE and does not change
-- WALLET_AVAILABLE/WALLET_RESERVED/PAYOUT_CLEARING. The existing withdrawal_revision
-- trigger only covers RESERVE/RELEASE/PAYOUT/EARNING_*; this migration does not add the new kind.
-- The event guard above requires expected_ledger_revision to equal the current revision.
-- REFUND_PAID still advances the revision through the existing native_refund_wallet_revision trigger.

-- ---------------------------------------------------------------------------
-- 10. function ACL (runtime EXECUTE is granted by the integration-owned privilege config)
-- ---------------------------------------------------------------------------
REVOKE ALL ON FUNCTION zzsh_order.guard_abnormal_refund_liability_root(),
 zzsh_order.guard_abnormal_refund_liability_event(),zzsh_order.guard_abnormal_refund_liability_entry(),
 zzsh_order.check_abnormal_refund_liability_batch(),
 zzsh_order.native_abnormal_refund_liability_complete(text),
 zzsh_order.native_abnormal_refund_terminal_complete(text) FROM PUBLIC;
