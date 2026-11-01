-- 0134_support_cancel: 客服取消订单并全额原路退款。
-- 复用未开租终止的全额原款责任与 JoinPay 退款意图/执行链，但增加 SUPPORT 申请方、
-- 独立订单取消原因 SUPPORT_CANCELLED_REFUND；与用户终止共用“必须未开租”的资金准入。
-- 已确认开租或双方已确认的订单不属于全额原款退款合同，SUPPORT 也不能绕过。

-- 1. 终止申请方扩展为支持客服；申请仍须绑定真实管理员，不冒用租客/号主身份。
ALTER TABLE zzsh_order.prestart_termination ADD COLUMN IF NOT EXISTS requested_by_admin_user_id text;
ALTER TABLE zzsh_order.prestart_termination ALTER COLUMN requested_by_user_id DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid='zzsh_order.prestart_termination'::regclass
    AND conname='prestart_termination_requested_by_admin_fk') THEN
    ALTER TABLE zzsh_order.prestart_termination ADD CONSTRAINT prestart_termination_requested_by_admin_fk
      FOREIGN KEY(requested_by_admin_user_id) REFERENCES zzsh_auth_admin."user"(id) DEFERRABLE INITIALLY DEFERRED;
  END IF;
END $$;

-- 旧内联 party CHECK 名称由 PostgreSQL 生成；按定义找到并替换，避免依赖版本差异。
DO $$
DECLARE name text;
BEGIN
  FOR name IN SELECT conname FROM pg_constraint WHERE conrelid='zzsh_order.prestart_termination'::regclass AND contype='c'
    AND (conname='prestart_termination_requested_by_party_check' OR pg_get_constraintdef(oid) LIKE '%requested_by_party%')
  LOOP
    EXECUTE format('ALTER TABLE zzsh_order.prestart_termination DROP CONSTRAINT %I',name);
  END LOOP;
END $$;
ALTER TABLE zzsh_order.prestart_termination
  DROP CONSTRAINT IF EXISTS prestart_termination_party_shape,
  ADD CONSTRAINT prestart_termination_party_shape CHECK(requested_by_party IN('RENTER','OWNER','SUPPORT')),
  DROP CONSTRAINT IF EXISTS prestart_termination_requester_shape,
  ADD CONSTRAINT prestart_termination_requester_shape CHECK(
    (requested_by_party IN('RENTER','OWNER') AND requested_by_user_id IS NOT NULL AND requested_by_admin_user_id IS NULL)
    OR(requested_by_party='SUPPORT' AND requested_by_user_id IS NULL AND requested_by_admin_user_id IS NOT NULL));

-- 2. 核准结论：用户终止仍须“未使用无争议”，客服取消保留独立结论，不扩大资金准入。
DO $$
DECLARE name text;
BEGIN
  FOR name IN SELECT conname FROM pg_constraint WHERE conrelid='zzsh_order.prestart_termination_decision'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%assessment%'
  LOOP
    EXECUTE format('ALTER TABLE zzsh_order.prestart_termination_decision DROP CONSTRAINT %I',name);
  END LOOP;
END $$;
ALTER TABLE zzsh_order.prestart_termination_decision
  ADD CONSTRAINT prestart_termination_decision_assessment_shape CHECK(
    (decision='APPROVE' AND assessment IN('NO_USE_NO_DISPUTE','SUPPORT_FULL_REFUND'))
    OR(decision<>'APPROVE' AND assessment IS NULL));

-- 3. 客服取消的支付依据：先通过同一未开租原款校验，再收紧为 JOINPAY 及无待处理结算。
CREATE OR REPLACE FUNCTION zzsh_order.support_cancel_payment_basis_valid(b jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT COALESCE(EXISTS(SELECT 1 FROM zzsh_order.rental_order o
  JOIN zzsh_order.payment_confirmation c ON c.id=o.paid_confirmation_id AND c.order_id=o.id
  WHERE o.id=b->>'orderId' AND c.id=b->>'paymentConfirmationId' AND c.disposition='APPLIED'
   AND zzsh_order.prestart_payment_basis_valid(b)
   AND c.source='JOINPAY' AND b->>'source'='JOINPAY' AND c.currency='CNY' AND b->>'currency'='CNY'
   AND c.amount_cents=o.rental_amount_cents+o.deposit_amount_cents AND c.amount_cents::text=b->>'amountCents' AND c.amount_cents>0
   AND b->>'amountCents'~'^[1-9][0-9]{0,15}$' AND b->>'digest'~'^[a-f0-9]{64}$'
   AND o.renter_user_id=b->>'renterUserId' AND o.owner_user_id=b->>'ownerUserId'
   AND c.merchant_scope_id=b->>'merchantIdentityId' AND c.merchant_order_no=b->>'merchantOrderNo' AND c.provider_transaction_id=b->>'channelTrxNo'
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_version v WHERE v.order_id=o.id AND v.superseded_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_intake i WHERE i.order_id=o.id AND i.status IN('OPEN','CLASSIFIED'))
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_referral_earning e WHERE e.order_id=o.id AND e.amount_cents>0 AND e.state<>'REVOKED')),false)
$$;

CREATE OR REPLACE FUNCTION zzsh_order.guard_prestart_termination() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o zzsh_order.rental_order;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'prestart request is retained' USING ERRCODE='40001';END IF;
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=NEW.order_id FOR UPDATE;
 IF o.id IS NULL OR NEW.basis_digest IS DISTINCT FROM NEW.payment_basis->>'digest'
  OR NEW.payment_basis->>'orderId' IS DISTINCT FROM NEW.order_id
 THEN RAISE EXCEPTION 'prestart original basis differs' USING ERRCODE='23514';END IF;
 IF NEW.requested_by_party IN('RENTER','OWNER') THEN
  IF NEW.requested_by_user_id IS DISTINCT FROM (CASE NEW.requested_by_party WHEN 'RENTER' THEN o.renter_user_id ELSE o.owner_user_id END)
   OR NEW.requested_by_admin_user_id IS NOT NULL
  THEN RAISE EXCEPTION 'prestart original party differs' USING ERRCODE='23514';END IF;
 ELSIF NEW.requested_by_party='SUPPORT' THEN
  IF NEW.requested_by_user_id IS NOT NULL OR NEW.requested_by_admin_user_id IS NULL
   OR NOT EXISTS(SELECT 1 FROM zzsh_auth_admin."user" u WHERE u.id=NEW.requested_by_admin_user_id)
  THEN RAISE EXCEPTION 'support cancellation actor missing' USING ERRCODE='23514';END IF;
 ELSE RAISE EXCEPTION 'prestart party unsupported' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'REQUESTED' OR NEW.revision<>1 OR o.status<>'PAID' OR NEW.last_reason IS NOT NULL
   OR NEW.approved_at IS NOT NULL OR NEW.approved_xid IS NOT NULL OR NEW.liability_root_id IS NOT NULL OR NEW.liability_event_id IS NOT NULL
   OR NOT(CASE WHEN NEW.requested_by_party='SUPPORT' THEN zzsh_order.support_cancel_payment_basis_valid(NEW.payment_basis)
     ELSE zzsh_order.prestart_payment_basis_valid(NEW.payment_basis) END)
  THEN RAISE EXCEPTION 'prestart request is ineligible' USING ERRCODE='23514';END IF;
  NEW.created_at:=clock_timestamp();NEW.updated_at:=NEW.created_at;RETURN NEW;
 END IF;
 IF (to_jsonb(NEW)-ARRAY['state','revision','last_reason','approved_at','approved_xid','liability_root_id','liability_event_id','updated_at'])
  IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['state','revision','last_reason','approved_at','approved_xid','liability_root_id','liability_event_id','updated_at'])
 THEN RAISE EXCEPTION 'prestart frozen request immutable' USING ERRCODE='40001';END IF;
 IF OLD.state='APPROVED' THEN
  IF OLD.approved_xid IS DISTINCT FROM pg_current_xact_id() OR OLD.liability_root_id IS NOT NULL OR OLD.liability_event_id IS NOT NULL
    OR NEW.liability_root_id IS NULL OR NEW.liability_event_id IS NULL
    OR(to_jsonb(NEW)-ARRAY['liability_root_id','liability_event_id']) IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['liability_root_id','liability_event_id'])
  THEN RAISE EXCEPTION 'approved prestart request immutable' USING ERRCODE='40001';END IF;
  RETURN NEW;
 END IF;
 IF OLD.state='REJECTED' OR NEW.state NOT IN('REVIEW_REQUIRED','REJECTED','APPROVED') OR NEW.revision<>OLD.revision+1
  OR NEW.last_reason IS NULL OR length(btrim(NEW.last_reason))<3 OR octet_length(NEW.last_reason)>600
  OR NEW.liability_root_id IS NOT NULL OR NEW.liability_event_id IS NOT NULL OR o.status<>'PAID'
 THEN RAISE EXCEPTION 'invalid prestart review transition' USING ERRCODE='40001';END IF;
 IF NEW.state='APPROVED' THEN
  IF NOT(CASE WHEN NEW.requested_by_party='SUPPORT' THEN zzsh_order.support_cancel_payment_basis_valid(NEW.payment_basis)
    ELSE zzsh_order.prestart_payment_basis_valid(NEW.payment_basis) END)
  THEN RAISE EXCEPTION 'prestart use/payment changed' USING ERRCODE='23514';END IF;
  NEW.approved_at:=clock_timestamp();NEW.approved_xid:=pg_current_xact_id();
 ELSE NEW.approved_at:=NULL;NEW.approved_xid:=NULL;END IF;
 NEW.updated_at:=clock_timestamp();RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.guard_prestart_termination_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t zzsh_order.prestart_termination;
BEGIN
 SELECT * INTO t FROM zzsh_order.prestart_termination WHERE id=NEW.termination_id;
 IF t.id IS NULL OR t.revision<>NEW.result_revision OR t.last_reason IS DISTINCT FROM NEW.reason
   OR t.state<>(CASE NEW.decision WHEN 'APPROVE' THEN 'APPROVED' WHEN 'REJECT' THEN 'REJECTED' ELSE 'REVIEW_REQUIRED' END)
   OR NEW.decision='APPROVE' AND ((t.requested_by_party='SUPPORT' AND NEW.assessment<>'SUPPORT_FULL_REFUND')
     OR(t.requested_by_party<>'SUPPORT' AND NEW.assessment<>'NO_USE_NO_DISPUTE'))
   OR NEW.decision<>'APPROVE' AND NEW.assessment IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM zzsh_auth_admin.session s WHERE s.id=NEW.session_id AND s."userId"=NEW.admin_user_id AND s."expiresAt">clock_timestamp())
 THEN RAISE EXCEPTION 'prestart decision original differs' USING ERRCODE='23514'; END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;

-- 4. 责任完整性：客服取消使用独立取消原因/结论/审计动作，但仍要求恰好两条原款责任分录。
CREATE OR REPLACE FUNCTION zzsh_order.prestart_liability_complete(termination_id_value text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT COALESCE(EXISTS(SELECT 1 FROM zzsh_order.prestart_termination t
  JOIN zzsh_order.rental_order o ON o.id=t.order_id
  JOIN zzsh_order.finance_economic_root r ON r.id=t.liability_root_id
  JOIN zzsh_order.finance_event e ON e.id=t.liability_event_id AND e.economic_root_id=r.id
  WHERE t.id=termination_id_value AND t.state='APPROVED' AND t.basis_digest=t.payment_basis->>'digest'
   AND((t.requested_by_party='SUPPORT' AND o.status='CANCELLED' AND o.cancel_reason='SUPPORT_CANCELLED_REFUND'
       AND zzsh_order.support_cancel_payment_basis_valid(t.payment_basis))
     OR(t.requested_by_party<>'SUPPORT' AND o.status='CANCELLED' AND o.cancel_reason='PRESTART_TERMINATED'
       AND zzsh_order.prestart_payment_basis_valid(t.payment_basis)))
   AND r.source_kind='NATIVE_PRESTART_REFUND' AND r.source_type='NATIVE' AND r.source_system='zzsh' AND r.source_entity='prestart_termination'
   AND r.source_id=t.id AND r.subject_user_id=o.renter_user_id AND r.source_digest=t.basis_digest AND r.basis_id IS NULL
   AND r.policy_version=(CASE WHEN t.requested_by_party='SUPPORT' THEN 'support-full-refund.v1' ELSE 'prestart-full-refund.v1' END)
   AND r.beneficiary_role='RENTER'
   AND r.id='prestart_refund_'||substr(encode(sha256(convert_to(t.payment_basis->>'paymentConfirmationId','UTF8')),'hex'),1,40)
   AND e.id='prestart_liability_'||substr(encode(sha256(convert_to(t.payment_basis->>'paymentConfirmationId','UTF8')),'hex'),1,40)
   AND e.kind='REFUND_LIABILITY_RECOGNIZED' AND e.subject_user_id=o.renter_user_id
   AND(SELECT count(*) FROM zzsh_order.finance_event ev WHERE ev.economic_root_id=r.id)=1
   AND(SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)=2
   AND(SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id AND l.posting_id IS NULL
     AND l.details=jsonb_build_object('prestartTerminationId',t.id,'basisDigest',t.basis_digest,'paymentConfirmationId',t.payment_basis->>'paymentConfirmationId',
       'dataOrigin',CASE t.payment_basis->>'source' WHEN 'JOINPAY' THEN 'JOINPAY_LOCAL_ACCEPTANCE' ELSE 'LOCAL_CONTROLLED' END)
     AND((l.line_no=1 AND l.account_code='CAPTURED_PAYMENT_SOURCE' AND l.debit_cents=(t.payment_basis->>'amountCents')::numeric AND l.credit_cents=0
       AND l.counterparty_user_id IS NULL AND l.source_payment_confirmation_id=t.payment_basis->>'paymentConfirmationId')
      OR(l.line_no=2 AND l.account_code='RENTER_REFUND_PAYABLE' AND l.debit_cents=0 AND l.credit_cents=(t.payment_basis->>'amountCents')::numeric
       AND l.counterparty_user_id=o.renter_user_id AND l.source_payment_confirmation_id IS NULL)))=2
   AND EXISTS(SELECT 1 FROM zzsh_order.prestart_termination_decision d WHERE d.termination_id=t.id AND d.result_revision=t.revision
     AND d.decision='APPROVE'
     AND d.assessment=(CASE WHEN t.requested_by_party='SUPPORT' THEN 'SUPPORT_FULL_REFUND' ELSE 'NO_USE_NO_DISPUTE' END)
     AND d.created_xid=t.approved_xid)
   AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a
     WHERE a.action=(CASE WHEN t.requested_by_party='SUPPORT' THEN 'order.support_cancel' ELSE 'order.prestart.termination.reviewed' END)
     AND a.object_type='prestart_termination' AND a.object_id=t.id AND a.outcome='SUCCESS'
     AND a.details->>'decision'='APPROVE' AND a.details->>'basisDigest'=t.basis_digest
     AND a.details->>'liabilityRootId'=r.id)),false)
$$;

CREATE OR REPLACE FUNCTION zzsh_order.guard_prestart_liability_root() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t zzsh_order.prestart_termination;
BEGIN
 SELECT * INTO t FROM zzsh_order.prestart_termination WHERE id=NEW.source_id;
 IF t.id IS NULL OR t.state<>'APPROVED' OR t.approved_xid IS DISTINCT FROM pg_current_xact_id()
  OR NOT(CASE WHEN t.requested_by_party='SUPPORT' THEN zzsh_order.support_cancel_payment_basis_valid(t.payment_basis)
    ELSE zzsh_order.prestart_payment_basis_valid(t.payment_basis) END)
  OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh'
  OR NEW.source_entity<>'prestart_termination' OR NEW.basis_id IS NOT NULL
  OR NEW.policy_version IS DISTINCT FROM(CASE WHEN t.requested_by_party='SUPPORT' THEN 'support-full-refund.v1' ELSE 'prestart-full-refund.v1' END)
  OR NEW.subject_user_id IS DISTINCT FROM t.payment_basis->>'renterUserId' OR NEW.beneficiary_role<>'RENTER' OR NEW.source_digest<>t.basis_digest
  OR NEW.id IS DISTINCT FROM 'prestart_refund_'||substr(encode(sha256(convert_to(t.payment_basis->>'paymentConfirmationId','UTF8')),'hex'),1,40)
 THEN RAISE EXCEPTION 'prestart liability root differs' USING ERRCODE='23514';END IF;
 INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision)
  VALUES(t.payment_basis->>'renterUserId',0,0) ON CONFLICT(user_id) DO NOTHING;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;

-- 5. 订单取消原因与状态守卫：只允许 PAID -> CANCELLED，且同事务存在已核准的对应申请/责任。
ALTER TABLE zzsh_order.rental_order DROP CONSTRAINT IF EXISTS rental_order_cancel_reason_check,
 ADD CONSTRAINT rental_order_cancel_reason_check CHECK(cancel_reason IN('USER','TIMEOUT','PRESTART_TERMINATED','MANUAL_CLOSE','SUPPORT_CANCELLED_REFUND')),
 DROP CONSTRAINT IF EXISTS rental_order_payment_shape,
 ADD CONSTRAINT rental_order_payment_shape CHECK(
  (status IN('PAID','COMPLETED') AND paid_confirmation_id IS NOT NULL AND paid_at IS NOT NULL)
  OR(status='PENDING_PAYMENT' AND paid_confirmation_id IS NULL AND paid_at IS NULL)
  OR(status='CANCELLED' AND((cancel_reason IN('PRESTART_TERMINATED','MANUAL_CLOSE','SUPPORT_CANCELLED_REFUND') AND paid_confirmation_id IS NOT NULL AND paid_at IS NOT NULL)
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
  IF OLD.cancel_reason IN('PRESTART_TERMINATED','SUPPORT_CANCELLED_REFUND') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminated paid order is immutable' USING ERRCODE='40001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'PENDING_PAYMENT' AND NEW.status IN ('CANCELLED','PAID'))
     AND NOT (OLD.status='PAID' AND NEW.status='CANCELLED' AND NEW.cancel_reason='PRESTART_TERMINATED')
     AND NOT (OLD.status='PAID' AND NEW.status='CANCELLED' AND NEW.cancel_reason='MANUAL_CLOSE')
     AND NOT (OLD.status='PAID' AND NEW.status='CANCELLED' AND NEW.cancel_reason='SUPPORT_CANCELLED_REFUND')
     AND NOT (OLD.status = 'PAID' AND NEW.status = 'COMPLETED'
       AND EXISTS (SELECT 1 FROM zzsh_order.settlement_posting WHERE order_id = OLD.id)) THEN
    RAISE EXCEPTION 'invalid rental order transition' USING ERRCODE = '40001';
  END IF;
  IF OLD.status IN ('PAID','COMPLETED') AND (NEW.paid_confirmation_id,NEW.paid_at) IS DISTINCT FROM (OLD.paid_confirmation_id,OLD.paid_at) THEN
    RAISE EXCEPTION 'paid order reference is immutable' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.guard_prestart_order_cancel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='CANCELLED' AND NEW.cancel_reason IN('PRESTART_TERMINATED','SUPPORT_CANCELLED_REFUND') THEN
  IF OLD.status<>'PAID' OR NEW.paid_confirmation_id IS DISTINCT FROM OLD.paid_confirmation_id OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
   OR NEW.revision<>OLD.revision+1 OR NEW.cancelled_at IS NULL
   OR(to_jsonb(NEW)-ARRAY['status','cancel_reason','cancelled_at','revision','updated_at','payment_disposition'])
      IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['status','cancel_reason','cancelled_at','revision','updated_at','payment_disposition'])
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.prestart_termination t WHERE t.order_id=NEW.id AND t.state='APPROVED'
     AND t.approved_xid=pg_current_xact_id()
     AND((NEW.cancel_reason='PRESTART_TERMINATED' AND t.requested_by_party<>'SUPPORT')
       OR(NEW.cancel_reason='SUPPORT_CANCELLED_REFUND' AND t.requested_by_party='SUPPORT'))
     AND(CASE WHEN t.requested_by_party='SUPPORT' THEN zzsh_order.support_cancel_payment_basis_valid(t.payment_basis)
       ELSE zzsh_order.prestart_payment_basis_valid(t.payment_basis) END)
     AND t.liability_root_id IS NOT NULL AND t.liability_event_id IS NOT NULL)
  THEN RAISE EXCEPTION 'prestart cancellation requires same-transaction approved liability' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS prestart_order_closure ON zzsh_order.rental_order;
CREATE CONSTRAINT TRIGGER prestart_order_closure AFTER UPDATE ON zzsh_order.rental_order
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.cancel_reason IN('PRESTART_TERMINATED','SUPPORT_CANCELLED_REFUND'))
 EXECUTE FUNCTION zzsh_order.check_prestart_termination_closure();

REVOKE ALL ON FUNCTION zzsh_order.support_cancel_payment_basis_valid(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_prestart_termination(),zzsh_order.guard_prestart_termination_decision(),
 zzsh_order.prestart_liability_complete(text),zzsh_order.guard_prestart_liability_root(),
 zzsh_order.guard_rental_order(),zzsh_order.guard_prestart_order_cancel() FROM PUBLIC;
