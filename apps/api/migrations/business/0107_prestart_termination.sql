-- 0107_prestart_termination: 前向追加；由正式迁移入口安装，旧链不改写。
-- 依赖0106；新增未开租终止及全额原款退款责任。

CREATE TABLE zzsh_order.prestart_termination (
 id text PRIMARY KEY,order_id text NOT NULL REFERENCES zzsh_order.rental_order(id),
 requested_by_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 requested_by_party text NOT NULL CHECK(requested_by_party IN('RENTER','OWNER')),
 reason text NOT NULL CHECK(length(btrim(reason))>=3 AND octet_length(reason)<=600),
 basis_digest text NOT NULL CHECK(basis_digest~'^[a-f0-9]{64}$'),payment_basis jsonb NOT NULL,
 request_id text NOT NULL,state text NOT NULL DEFAULT 'REQUESTED' CHECK(state IN('REQUESTED','REVIEW_REQUIRED','REJECTED','APPROVED')),
 revision bigint NOT NULL DEFAULT 1 CHECK(revision>0),last_reason text,
 approved_at timestamptz,approved_xid xid8,
 liability_root_id text REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED,
 liability_event_id text REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK((state='APPROVED' AND approved_at IS NOT NULL AND approved_xid IS NOT NULL)
    OR(state<>'APPROVED' AND approved_at IS NULL AND approved_xid IS NULL AND liability_root_id IS NULL AND liability_event_id IS NULL))
);
CREATE UNIQUE INDEX prestart_termination_one_active ON zzsh_order.prestart_termination(order_id) WHERE state<>'REJECTED';
CREATE TABLE zzsh_order.prestart_termination_decision (
 id text PRIMARY KEY,termination_id text NOT NULL REFERENCES zzsh_order.prestart_termination(id),result_revision bigint NOT NULL CHECK(result_revision>1),
 decision text NOT NULL CHECK(decision IN('APPROVE','REJECT','REVIEW_REQUIRED')),assessment text,
 reason text NOT NULL CHECK(length(btrim(reason))>=3 AND octet_length(reason)<=600),
 admin_user_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),session_id text NOT NULL REFERENCES zzsh_auth_admin.session(id),
 request_id text NOT NULL,created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(termination_id,result_revision),CHECK((decision='APPROVE' AND assessment='NO_USE_NO_DISPUTE') OR(decision<>'APPROVE' AND assessment IS NULL))
);

CREATE FUNCTION zzsh_order.prestart_payment_basis_valid(b jsonb) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT COALESCE(EXISTS(SELECT 1 FROM zzsh_order.rental_order o
  JOIN zzsh_order.payment_confirmation c ON c.id=o.paid_confirmation_id AND c.order_id=o.id
  WHERE o.id=b->>'orderId' AND c.id=b->>'paymentConfirmationId' AND c.disposition='APPLIED'
   AND c.source IN('JOINPAY','CONTROLLED') AND c.source=b->>'source' AND c.currency='CNY' AND b->>'currency'='CNY'
   AND c.amount_cents=o.rental_amount_cents+o.deposit_amount_cents AND c.amount_cents::text=b->>'amountCents' AND c.amount_cents>0
   AND b->>'amountCents'~'^[1-9][0-9]{0,15}$' AND b->>'digest'~'^[a-f0-9]{64}$'
   AND o.renter_user_id=b->>'renterUserId' AND o.owner_user_id=b->>'ownerUserId'
   AND c.merchant_scope_id=b->>'merchantIdentityId' AND c.merchant_order_no=b->>'merchantOrderNo' AND c.provider_transaction_id=b->>'channelTrxNo'
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_opening x WHERE x.order_id=o.id AND(x.status='CONFIRMED'
     OR(SELECT count(DISTINCT a.party) FROM zzsh_order.rental_opening_ack a WHERE a.opening_id=x.id AND a.version_no=x.version_no)=2))
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_version v WHERE v.order_id=o.id AND v.kind='MANUAL_ADJUSTMENT' AND v.superseded_at IS NULL)
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_referral_earning e WHERE e.order_id=o.id AND e.amount_cents>0 AND e.state<>'REVOKED')),false)
$$;

CREATE FUNCTION zzsh_order.guard_prestart_termination() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o zzsh_order.rental_order;
BEGIN
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'prestart request is retained' USING ERRCODE='40001';END IF;
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=NEW.order_id FOR UPDATE;
 IF o.id IS NULL OR NEW.basis_digest IS DISTINCT FROM NEW.payment_basis->>'digest'
  OR NEW.payment_basis->>'orderId' IS DISTINCT FROM NEW.order_id
  OR NEW.requested_by_user_id IS DISTINCT FROM (CASE NEW.requested_by_party WHEN 'RENTER' THEN o.renter_user_id ELSE o.owner_user_id END)
 THEN RAISE EXCEPTION 'prestart original party/basis differs' USING ERRCODE='23514';END IF;
 IF TG_OP='INSERT' THEN
  IF NEW.state<>'REQUESTED' OR NEW.revision<>1 OR o.status<>'PAID' OR NEW.last_reason IS NOT NULL
   OR NEW.approved_at IS NOT NULL OR NEW.approved_xid IS NOT NULL OR NEW.liability_root_id IS NOT NULL OR NEW.liability_event_id IS NOT NULL
   OR NOT zzsh_order.prestart_payment_basis_valid(NEW.payment_basis)
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
  IF NOT zzsh_order.prestart_payment_basis_valid(NEW.payment_basis) THEN RAISE EXCEPTION 'prestart use/payment changed' USING ERRCODE='23514';END IF;
  NEW.approved_at:=clock_timestamp();NEW.approved_xid:=pg_current_xact_id();
 ELSE NEW.approved_at:=NULL;NEW.approved_xid:=NULL;END IF;
 NEW.updated_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER prestart_termination_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_order.prestart_termination FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_prestart_termination();

CREATE FUNCTION zzsh_order.guard_prestart_termination_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t zzsh_order.prestart_termination;
BEGIN
 SELECT * INTO t FROM zzsh_order.prestart_termination WHERE id=NEW.termination_id;
 IF t.id IS NULL OR t.revision<>NEW.result_revision OR t.last_reason IS DISTINCT FROM NEW.reason
   OR t.state<>(CASE NEW.decision WHEN 'APPROVE' THEN 'APPROVED' WHEN 'REJECT' THEN 'REJECTED' ELSE 'REVIEW_REQUIRED' END)
   OR NOT EXISTS(SELECT 1 FROM zzsh_auth_admin.session s WHERE s.id=NEW.session_id AND s."userId"=NEW.admin_user_id AND s."expiresAt">clock_timestamp())
 THEN RAISE EXCEPTION 'prestart decision original differs' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER prestart_decision_guard BEFORE INSERT ON zzsh_order.prestart_termination_decision FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_prestart_termination_decision();
CREATE TRIGGER prestart_decision_immutable BEFORE UPDATE OR DELETE ON zzsh_order.prestart_termination_decision FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();

ALTER TABLE zzsh_order.rental_order DROP CONSTRAINT rental_order_cancel_reason_check,
 ADD CONSTRAINT rental_order_cancel_reason_check CHECK(cancel_reason IN('USER','TIMEOUT','PRESTART_TERMINATED')),
 DROP CONSTRAINT rental_order_payment_shape,
 ADD CONSTRAINT rental_order_payment_shape CHECK(
  (status IN('PAID','COMPLETED') AND paid_confirmation_id IS NOT NULL AND paid_at IS NOT NULL)
  OR(status='PENDING_PAYMENT' AND paid_confirmation_id IS NULL AND paid_at IS NULL)
  OR(status='CANCELLED' AND((cancel_reason='PRESTART_TERMINATED' AND paid_confirmation_id IS NOT NULL AND paid_at IS NOT NULL)
    OR(cancel_reason IN('USER','TIMEOUT') AND paid_confirmation_id IS NULL AND paid_at IS NULL))));
-- generated payment_disposition原样保留；新CANCELLED分支由下面的原款守卫与延迟闭合替代NULL外键分支。

CREATE FUNCTION zzsh_order.guard_prestart_order_cancel() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='CANCELLED' AND NEW.cancel_reason='PRESTART_TERMINATED' THEN
  IF OLD.status<>'PAID' OR NEW.paid_confirmation_id IS DISTINCT FROM OLD.paid_confirmation_id OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
   OR NEW.revision<>OLD.revision+1 OR NEW.cancelled_at IS NULL
   OR(to_jsonb(NEW)-ARRAY['status','cancel_reason','cancelled_at','revision','updated_at','payment_disposition'])
      IS DISTINCT FROM(to_jsonb(OLD)-ARRAY['status','cancel_reason','cancelled_at','revision','updated_at','payment_disposition'])
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.prestart_termination t WHERE t.order_id=NEW.id AND t.state='APPROVED'
     AND t.approved_xid=pg_current_xact_id() AND zzsh_order.prestart_payment_basis_valid(t.payment_basis)
     AND t.liability_root_id IS NOT NULL AND t.liability_event_id IS NOT NULL)
  THEN RAISE EXCEPTION 'prestart cancellation requires same-transaction approved liability' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prestart_order_cancel_guard BEFORE UPDATE ON zzsh_order.rental_order FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_prestart_order_cancel();

CREATE FUNCTION zzsh_order.guard_prestart_opening() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE order_value text;
BEGIN
 IF TG_TABLE_NAME='rental_opening' THEN order_value:=NEW.order_id;
 ELSE SELECT order_id INTO order_value FROM zzsh_order.rental_opening WHERE id=NEW.opening_id;END IF;
 PERFORM id FROM zzsh_order.rental_order WHERE id=order_value FOR UPDATE;
 IF EXISTS(SELECT 1 FROM zzsh_order.prestart_termination WHERE order_id=order_value AND state<>'REJECTED')
 THEN RAISE EXCEPTION 'prestart termination pending; resolve before opening' USING ERRCODE='40001',CONSTRAINT='prestart_no_opening_while_requested';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prestart_opening_guard BEFORE INSERT OR UPDATE ON zzsh_order.rental_opening FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_prestart_opening();
CREATE TRIGGER prestart_opening_ack_guard BEFORE INSERT OR UPDATE ON zzsh_order.rental_opening_ack FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_prestart_opening();

ALTER TABLE zzsh_order.finance_economic_root DROP CONSTRAINT finance_root_enabled_source_shape,
 ADD CONSTRAINT finance_root_enabled_source_shape CHECK((source_kind IN('LEGACY_OPENING','NATIVE_GENESIS') AND basis_id IS NOT NULL)
 OR(source_kind IN('LOCAL_CONTROLLED_WITHDRAWAL','NATIVE_RENTAL_REFERRAL','NATIVE_GUARANTEE','LEGACY_CONTINUATION_DUTY',
  'NATIVE_RENTAL_REFUND','JOINPAY_WITHDRAWAL','NATIVE_ABNORMAL_REFUND','NATIVE_PRESTART_REFUND') AND basis_id IS NULL));
ALTER TABLE zzsh_order.settlement_ledger_entry DROP CONSTRAINT settlement_ledger_accounts,
 ADD CONSTRAINT settlement_ledger_accounts CHECK(
 (posting_id IS NOT NULL AND account_code IN('CAPTURED_PAYMENT_SOURCE','OWNER_AVAILABLE','RENTER_REFUND_PAYABLE','PLATFORM_HAFF_SPREAD',
  'PLATFORM_ITEM_SPREAD','PLATFORM_EARLY_MAKEUP','PLATFORM_COMPENSATION_FEE','PLATFORM_MANUAL_NET_ADJUSTMENT'))
 OR(finance_event_id IS NOT NULL AND account_code IN('WALLET_AVAILABLE','LEGACY_OPENING_SOURCE','WALLET_RESERVED','PAYOUT_CLEARING','WITHDRAW_FEE',
  'WALLET_PENDING_EARNINGS','DISTRIBUTION_EXPENSE','GUARANTEE_CASH','GUARANTEE_HELD','LEGACY_LIABILITY_SOURCE','OWNER_AVAILABLE',
  'RENTER_REFUND_PAYABLE','JOINPAY_UNALLOCATED_RECEIPT','CAPTURED_PAYMENT_SOURCE')));

CREATE FUNCTION zzsh_order.prestart_liability_complete(termination_id_value text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT COALESCE(EXISTS(SELECT 1 FROM zzsh_order.prestart_termination t
  JOIN zzsh_order.rental_order o ON o.id=t.order_id
  JOIN zzsh_order.finance_economic_root r ON r.id=t.liability_root_id
  JOIN zzsh_order.finance_event e ON e.id=t.liability_event_id AND e.economic_root_id=r.id
  WHERE t.id=termination_id_value AND t.state='APPROVED' AND t.basis_digest=t.payment_basis->>'digest'
   AND o.status='CANCELLED' AND o.cancel_reason='PRESTART_TERMINATED' AND zzsh_order.prestart_payment_basis_valid(t.payment_basis)
   AND r.source_kind='NATIVE_PRESTART_REFUND' AND r.source_type='NATIVE' AND r.source_system='zzsh' AND r.source_entity='prestart_termination'
   AND r.source_id=t.id AND r.subject_user_id=o.renter_user_id AND r.source_digest=t.basis_digest AND r.basis_id IS NULL
   AND r.policy_version='prestart-full-refund.v1' AND r.beneficiary_role='RENTER'
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
     AND d.decision='APPROVE' AND d.assessment='NO_USE_NO_DISPUTE' AND d.created_xid=t.approved_xid)
   AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.prestart.termination.reviewed' AND a.object_type='prestart_termination'
     AND a.object_id=t.id AND a.outcome='SUCCESS' AND a.details->>'decision'='APPROVE' AND a.details->>'basisDigest'=t.basis_digest
     AND a.details->>'liabilityRootId'=r.id)),false)
$$;

CREATE FUNCTION zzsh_order.guard_prestart_liability_root() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE t zzsh_order.prestart_termination;
BEGIN
 SELECT * INTO t FROM zzsh_order.prestart_termination WHERE id=NEW.source_id;
 IF t.id IS NULL OR t.state<>'APPROVED' OR t.approved_xid IS DISTINCT FROM pg_current_xact_id()
  OR NOT zzsh_order.prestart_payment_basis_valid(t.payment_basis) OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh'
  OR NEW.source_entity<>'prestart_termination' OR NEW.basis_id IS NOT NULL OR NEW.policy_version IS DISTINCT FROM 'prestart-full-refund.v1'
  OR NEW.subject_user_id IS DISTINCT FROM t.payment_basis->>'renterUserId' OR NEW.beneficiary_role<>'RENTER' OR NEW.source_digest<>t.basis_digest
  OR NEW.id IS DISTINCT FROM 'prestart_refund_'||substr(encode(sha256(convert_to(t.payment_basis->>'paymentConfirmationId','UTF8')),'hex'),1,40)
 THEN RAISE EXCEPTION 'prestart liability root differs' USING ERRCODE='23514';END IF;
 -- 只有同事务已核准原APPLIED款可补零计数器；不创建coverage/genesis或可用余额。
 INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision)
  VALUES(t.payment_basis->>'renterUserId',0,0) ON CONFLICT(user_id) DO NOTHING;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER prestart_liability_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW
 WHEN(NEW.source_kind='NATIVE_PRESTART_REFUND') EXECUTE FUNCTION zzsh_order.guard_prestart_liability_root();

CREATE FUNCTION zzsh_order.guard_prestart_liability_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r zzsh_order.finance_economic_root;t zzsh_order.prestart_termination;rev bigint;
BEGIN
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 IF r.source_kind IS DISTINCT FROM 'NATIVE_PRESTART_REFUND' THEN RETURN NEW;END IF;
 SELECT * INTO t FROM zzsh_order.prestart_termination WHERE id=r.source_id;
 SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=r.subject_user_id;
 IF t.id IS NULL OR t.approved_xid IS DISTINCT FROM pg_current_xact_id() OR r.created_xid IS DISTINCT FROM pg_current_xact_id()
  OR NEW.kind<>'REFUND_LIABILITY_RECOGNIZED' OR NEW.subject_user_id IS DISTINCT FROM r.subject_user_id
  OR NEW.expected_ledger_revision IS DISTINCT FROM rev OR rev IS NULL
  OR NEW.id IS DISTINCT FROM 'prestart_liability_'||substr(encode(sha256(convert_to(t.payment_basis->>'paymentConfirmationId','UTF8')),'hex'),1,40)
 THEN RAISE EXCEPTION 'prestart liability event/revision differs' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER prestart_liability_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_prestart_liability_event();

CREATE FUNCTION zzsh_order.guard_prestart_liability_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t zzsh_order.prestart_termination;r zzsh_order.finance_economic_root;e zzsh_order.finance_event;amount numeric;
BEGIN
 SELECT * INTO t FROM zzsh_order.prestart_termination WHERE id=NEW.details->>'prestartTerminationId';
 SELECT * INTO e FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=e.economic_root_id;
 amount:=(t.payment_basis->>'amountCents')::numeric;
 IF t.id IS NULL OR r.id IS NULL OR e.id IS NULL OR r.source_kind<>'NATIVE_PRESTART_REFUND' OR r.source_id<>t.id
  OR t.approved_xid IS DISTINCT FROM pg_current_xact_id() OR e.created_xid IS DISTINCT FROM pg_current_xact_id()
  OR e.kind<>'REFUND_LIABILITY_RECOGNIZED' OR NEW.posting_id IS NOT NULL
  OR NEW.details IS DISTINCT FROM jsonb_build_object('prestartTerminationId',t.id,'basisDigest',t.basis_digest,
    'paymentConfirmationId',t.payment_basis->>'paymentConfirmationId','dataOrigin',CASE t.payment_basis->>'source' WHEN 'JOINPAY' THEN 'JOINPAY_LOCAL_ACCEPTANCE' ELSE 'LOCAL_CONTROLLED' END)
  OR NOT((NEW.line_no=1 AND NEW.account_code='CAPTURED_PAYMENT_SOURCE' AND NEW.debit_cents=amount AND NEW.credit_cents=0
      AND NEW.counterparty_user_id IS NULL AND NEW.source_payment_confirmation_id=t.payment_basis->>'paymentConfirmationId')
    OR(NEW.line_no=2 AND NEW.account_code='RENTER_REFUND_PAYABLE' AND NEW.debit_cents=0 AND NEW.credit_cents=amount
      AND NEW.counterparty_user_id=t.payment_basis->>'renterUserId' AND NEW.source_payment_confirmation_id IS NULL))
 THEN RAISE EXCEPTION 'prestart liability entry differs' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER prestart_liability_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW
 WHEN(NEW.details?'prestartTerminationId') EXECUTE FUNCTION zzsh_order.guard_prestart_liability_entry();

CREATE FUNCTION zzsh_order.check_prestart_termination_closure() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text;t zzsh_order.prestart_termination;
BEGIN
 IF TG_TABLE_NAME='prestart_termination' THEN target:=NEW.id;
 ELSIF TG_TABLE_NAME='prestart_termination_decision' THEN target:=NEW.termination_id;
 ELSIF TG_TABLE_NAME='rental_order' THEN SELECT id INTO target FROM zzsh_order.prestart_termination WHERE order_id=NEW.id AND state='APPROVED';
 ELSIF TG_TABLE_NAME='finance_economic_root' THEN target:=NEW.source_id;
 ELSIF TG_TABLE_NAME='finance_event' THEN SELECT source_id INTO target FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id AND source_kind='NATIVE_PRESTART_REFUND';
 ELSE target:=NEW.details->>'prestartTerminationId';END IF;
 IF target IS NULL THEN RETURN NULL;END IF;
 SELECT * INTO t FROM zzsh_order.prestart_termination WHERE id=target;
 IF t.id IS NULL OR(t.state='APPROVED' AND NOT zzsh_order.prestart_liability_complete(t.id))
   OR(t.revision>1 AND NOT EXISTS(SELECT 1 FROM zzsh_order.prestart_termination_decision d WHERE d.termination_id=t.id
     AND d.result_revision=t.revision AND d.reason=t.last_reason AND d.decision=CASE t.state WHEN 'APPROVED' THEN 'APPROVE' WHEN 'REJECTED' THEN 'REJECT' ELSE 'REVIEW_REQUIRED' END))
 THEN RAISE EXCEPTION 'prestart approval/liability/cancellation batch incomplete' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER prestart_request_closure AFTER INSERT OR UPDATE ON zzsh_order.prestart_termination DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_prestart_termination_closure();
CREATE CONSTRAINT TRIGGER prestart_decision_closure AFTER INSERT ON zzsh_order.prestart_termination_decision DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_prestart_termination_closure();
CREATE CONSTRAINT TRIGGER prestart_order_closure AFTER UPDATE ON zzsh_order.rental_order DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.cancel_reason='PRESTART_TERMINATED') EXECUTE FUNCTION zzsh_order.check_prestart_termination_closure();
CREATE CONSTRAINT TRIGGER prestart_root_closure AFTER INSERT ON zzsh_order.finance_economic_root DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.source_kind='NATIVE_PRESTART_REFUND') EXECUTE FUNCTION zzsh_order.check_prestart_termination_closure();
CREATE CONSTRAINT TRIGGER prestart_event_closure AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='REFUND_LIABILITY_RECOGNIZED') EXECUTE FUNCTION zzsh_order.check_prestart_termination_closure();
CREATE CONSTRAINT TRIGGER prestart_entry_closure AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.details?'prestartTerminationId') EXECUTE FUNCTION zzsh_order.check_prestart_termination_closure();

ALTER TABLE zzsh_order.channel_refund_intent DROP CONSTRAINT channel_refund_basis_shape,
 ADD CONSTRAINT channel_refund_basis_shape CHECK(
  (basis_kind='POSTING' AND posting_id IS NOT NULL AND liability_root_id IS NULL AND liability_event_id IS NULL)
  OR(basis_kind IN('REVIEW_CONFIRMATION','PRESTART_TERMINATION') AND payment_source='JOINPAY' AND evidence_level='JOINPAY_FORMAL'
   AND posting_id IS NULL AND liability_root_id IS NOT NULL AND liability_event_id IS NOT NULL));
CREATE UNIQUE INDEX prestart_refund_original_key ON zzsh_order.channel_refund_intent(payment_confirmation_id,idempotency_key)
 WHERE basis_kind='PRESTART_TERMINATION' AND payment_source='JOINPAY';

CREATE FUNCTION zzsh_order.native_prestart_refund_liability_complete(intent_id_value text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT COALESCE(EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i
  JOIN zzsh_order.prestart_termination t ON t.order_id=i.order_id AND t.payment_basis->>'paymentConfirmationId'=i.payment_confirmation_id
  WHERE i.id=intent_id_value AND i.basis_kind='PRESTART_TERMINATION' AND i.posting_id IS NULL
   AND i.payment_source='JOINPAY' AND i.evidence_level='JOINPAY_FORMAL' AND t.payment_basis->>'source'='JOINPAY'
   AND zzsh_order.prestart_liability_complete(t.id) AND i.renter_user_id=t.payment_basis->>'renterUserId'
   AND i.merchant_identity_id=t.payment_basis->>'merchantIdentityId' AND i.original_payment_trx_no=t.payment_basis->>'channelTrxNo'
   AND i.original_payment_order_no=t.payment_basis->>'merchantOrderNo' AND i.amount_cents::text=t.payment_basis->>'amountCents' AND i.currency='CNY'
   AND i.responsibility_version_hash=t.basis_digest AND i.liability_root_id=t.liability_root_id AND i.liability_event_id=t.liability_event_id
   AND i.due_at=t.approved_at),false)
$$;

-- 以下兼容替换由固定原函数逐段派生；没有覆盖其他源、提现、POSTING或REVIEW分支。
-- GENERATED_COMPATIBILITY_START

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
  IF OLD.cancel_reason='PRESTART_TERMINATED' AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminated paid order is immutable' USING ERRCODE='40001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'PENDING_PAYMENT' AND NEW.status IN ('CANCELLED','PAID'))
     AND NOT (OLD.status='PAID' AND NEW.status='CANCELLED' AND NEW.cancel_reason='PRESTART_TERMINATED')
     AND NOT (OLD.status = 'PAID' AND NEW.status = 'COMPLETED'
       AND EXISTS (SELECT 1 FROM zzsh_order.settlement_posting WHERE order_id = OLD.id)) THEN
    RAISE EXCEPTION 'invalid rental order transition' USING ERRCODE = '40001';
  END IF;
  IF OLD.status IN ('PAID','COMPLETED') AND (NEW.paid_confirmation_id,NEW.paid_at) IS DISTINCT FROM (OLD.paid_confirmation_id,OLD.paid_at) THEN
    RAISE EXCEPTION 'paid order reference is immutable' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.guard_abnormal_refund_liability_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r zzsh_order.finance_economic_root;rev bigint;
BEGIN
  SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
  IF r.source_kind='NATIVE_PRESTART_REFUND' THEN RETURN NEW;END IF;
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

CREATE OR REPLACE FUNCTION zzsh_order.check_abnormal_refund_liability_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE event_id text;ev zzsh_order.finance_event;r zzsh_order.finance_economic_root;c zzsh_order.payment_confirmation;
  total bigint;debit_total numeric;credit_total numeric;good bigint;
BEGIN
  IF TG_TABLE_NAME='finance_event' THEN event_id:=NEW.id; ELSE event_id:=NEW.finance_event_id; END IF;
  SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=event_id AND kind='REFUND_LIABILITY_RECOGNIZED';
  IF ev.id IS NULL THEN RETURN NULL;END IF;
  SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=ev.economic_root_id;
  IF r.source_kind='NATIVE_PRESTART_REFUND' THEN RETURN NULL;END IF;
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

CREATE OR REPLACE FUNCTION zzsh_order.native_prestart_refund_terminal_complete(intent_id_value text) RETURNS boolean LANGUAGE plpgsql AS $$
DECLARE i zzsh_order.channel_refund_intent;e zzsh_order.joinpay_refund_evidence;r zzsh_order.finance_economic_root;
 ev zzsh_order.finance_event;rev bigint;lines bigint;good bigint;dr numeric;cr numeric;
BEGIN
 SELECT * INTO i FROM zzsh_order.channel_refund_intent WHERE id=intent_id_value;
 SELECT * INTO e FROM zzsh_order.joinpay_refund_evidence WHERE intent_id=i.id;
 IF i.id IS NULL OR i.payment_source<>'JOINPAY' OR i.evidence_level<>'JOINPAY_FORMAL'
  OR i.basis_kind<>'PRESTART_TERMINATION' OR i.posting_id IS NOT NULL OR e.id IS NULL
  OR i.terminal_evidence_id IS DISTINCT FROM e.id OR i.provider_refund_trx_no IS DISTINCT FROM e.refund_transaction_no
  OR i.completed_at IS DISTINCT FROM e.completed_at
  OR NOT zzsh_order.native_prestart_refund_liability_complete(i.id)
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

DROP TRIGGER finance_entry_guard ON zzsh_order.settlement_ledger_entry;
CREATE TRIGGER finance_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId') AND NOT(NEW.details?'earningId') AND NOT(NEW.details?'guaranteeId')
  AND NOT(NEW.details?'legacyDutyId') AND NOT(NEW.details?'nativeRefundIntentId') AND NOT(NEW.details?'joinpayWithdrawalIntentId')
  AND NOT(NEW.details?'abnormalRefundLiabilityId') AND NOT(NEW.details?'prestartTerminationId'))
 EXECUTE FUNCTION zzsh_order.guard_finance_entry();

DROP TRIGGER finance_entry_batch_guard ON zzsh_order.settlement_ledger_entry;
CREATE CONSTRAINT TRIGGER finance_entry_batch_guard AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NOT(NEW.details?'intentId') AND NOT(NEW.details?'earningId') AND NOT(NEW.details?'guaranteeId')
  AND NOT(NEW.details?'legacyDutyId') AND NOT(NEW.details?'nativeRefundIntentId') AND NOT(NEW.details?'joinpayWithdrawalIntentId')
  AND NOT(NEW.details?'abnormalRefundLiabilityId') AND NOT(NEW.details?'prestartTerminationId'))
 EXECUTE FUNCTION zzsh_order.check_finance_batch();

REVOKE ALL ON zzsh_order.prestart_termination,zzsh_order.prestart_termination_decision FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.prestart_payment_basis_valid(jsonb),zzsh_order.guard_prestart_termination(),
 zzsh_order.guard_prestart_termination_decision(),zzsh_order.guard_prestart_order_cancel(),zzsh_order.guard_prestart_opening(),
 zzsh_order.prestart_liability_complete(text),zzsh_order.guard_prestart_liability_root(),zzsh_order.guard_prestart_liability_event(),
 zzsh_order.guard_prestart_liability_entry(),zzsh_order.check_prestart_termination_closure(),
 zzsh_order.native_prestart_refund_liability_complete(text),zzsh_order.native_prestart_refund_terminal_complete(text) FROM PUBLIC;
