-- 已开租订单的客服特殊取消；正式迁移编号由合并时统一登记。
DO $$
BEGIN
 IF encode(sha256(convert_to(replace(pg_get_functiondef(to_regprocedure('zzsh_order.guard_rental_order()')),chr(13)||chr(10),chr(10)),'UTF8')),'hex')
    IS DISTINCT FROM 'd803359a145d8acf54d5a72064f08893a51b5924a9c1d8f2a9f2bf67479b3cbb'
 THEN RAISE EXCEPTION 'order cancellation guard prefix differs' USING ERRCODE='55000';END IF;
END $$;

ALTER TABLE zzsh_order.rental_order DROP CONSTRAINT rental_order_cancel_reason_check,
 ADD CONSTRAINT rental_order_cancel_reason_check CHECK(cancel_reason IN
  ('USER','TIMEOUT','PRESTART_TERMINATED','MANUAL_CLOSE','SUPPORT_CANCELLED_REFUND','SUPPORT_UNPAID','SUPPORT_AFTER_START_CANCELLED')),
 DROP CONSTRAINT rental_order_payment_shape,
 ADD CONSTRAINT rental_order_payment_shape CHECK(
  (status IN('PAID','COMPLETED') AND paid_confirmation_id IS NOT NULL AND paid_at IS NOT NULL)
  OR(status='PENDING_PAYMENT' AND paid_confirmation_id IS NULL AND paid_at IS NULL)
  OR(status='CANCELLED' AND(
   (cancel_reason IN('PRESTART_TERMINATED','MANUAL_CLOSE','SUPPORT_CANCELLED_REFUND','SUPPORT_AFTER_START_CANCELLED') AND paid_confirmation_id IS NOT NULL AND paid_at IS NOT NULL)
   OR(cancel_reason IN('USER','TIMEOUT','SUPPORT_UNPAID') AND paid_confirmation_id IS NULL AND paid_at IS NULL))));

DO $extend$
DECLARE expression text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='zzsh_order.finance_economic_root'::regclass AND conname='finance_root_enabled_source_shape';
 IF expression IS NULL OR position('NATIVE_RENTAL_REFUND' IN expression)=0 THEN RAISE EXCEPTION 'finance root contract missing';END IF;
 ALTER TABLE zzsh_order.finance_economic_root DROP CONSTRAINT finance_root_enabled_source_shape;
 EXECUTE format('ALTER TABLE zzsh_order.finance_economic_root ADD CONSTRAINT finance_root_enabled_source_shape CHECK((%s) OR (source_kind=''NATIVE_SUPPORT_CANCELLATION'' AND basis_id IS NULL))',expression);
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='zzsh_order.finance_event'::regclass AND conname='finance_event_kind_check';
 IF expression IS NULL OR position('REFUND_LIABILITY_RECOGNIZED' IN expression)=0 THEN RAISE EXCEPTION 'finance event contract missing';END IF;
 ALTER TABLE zzsh_order.finance_event DROP CONSTRAINT finance_event_kind_check;
 EXECUTE format('ALTER TABLE zzsh_order.finance_event ADD CONSTRAINT finance_event_kind_check CHECK((%s) OR kind=''SUPPORT_CANCELLATION_RECOGNIZED'')',expression);
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='zzsh_order.settlement_ledger_entry'::regclass AND conname='settlement_ledger_accounts';
 IF expression IS NULL OR position('RENTER_REFUND_PAYABLE' IN expression)=0 THEN RAISE EXCEPTION 'finance entry contract missing';END IF;
 ALTER TABLE zzsh_order.settlement_ledger_entry DROP CONSTRAINT settlement_ledger_accounts;
 EXECUTE format('ALTER TABLE zzsh_order.settlement_ledger_entry ADD CONSTRAINT settlement_ledger_accounts CHECK((%s) OR (finance_event_id IS NOT NULL AND account_code=''PLATFORM_CANCELLATION_CONTRIBUTION''))',expression);
END $extend$;

CREATE TABLE zzsh_order.support_poststart_cancellation (
 id text PRIMARY KEY,order_id text NOT NULL UNIQUE REFERENCES zzsh_order.rental_order(id),
 payment_confirmation_id text NOT NULL UNIQUE REFERENCES zzsh_order.payment_confirmation(id),
 owner_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),renter_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 admin_user_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),admin_session_id text NOT NULL,request_id text NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason))>=3 AND octet_length(reason)<=600),
 paid_cents numeric(16,0) NOT NULL CHECK(paid_cents>0),refund_cents numeric(16,0) NOT NULL CHECK(refund_cents>=0),
 owner_cents numeric(16,0) NOT NULL CHECK(owner_cents>=0),platform_cents numeric(16,0) NOT NULL CHECK(platform_cents>=0),
 source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),
 root_id text NOT NULL UNIQUE REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED,
 event_id text NOT NULL UNIQUE REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED,
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(paid_cents=refund_cents+owner_cents+platform_cents)
);
COMMENT ON TABLE zzsh_order.support_poststart_cancellation IS '客服对已开租订单特殊取消的不可变资金分配记录';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.id IS '取消记录标识';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.order_id IS '被取消的新平台订单';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.payment_confirmation_id IS '本单原付款确认';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.owner_user_id IS '号主';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.renter_user_id IS '租客';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.admin_user_id IS '办理客服';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.admin_session_id IS '办理时的管理端会话';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.request_id IS '办理请求追踪编号';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.reason IS '客服记录的取消原因';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.paid_cents IS '原付款金额，单位分';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.refund_cents IS '租客应退金额，单位分';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.owner_cents IS '号主应入余额，单位分';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.platform_cents IS '平台结算贡献，单位分';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.source_digest IS '订单、原款与资金分配的摘要';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.root_id IS '资金分配经济根';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.event_id IS '资金分配事件';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.created_xid IS '取消事务标识';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.created_at IS '取消记录时间';
CREATE TRIGGER support_poststart_cancellation_immutable BEFORE UPDATE OR DELETE ON zzsh_order.support_poststart_cancellation
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();

-- Preserve every installed finance source exclusion while adding this one.
DO $entry_guards$
DECLARE item record;original text;updated text;enabled "char";
BEGIN
 FOR item IN SELECT * FROM (VALUES
  ('finance_entry_guard','zzsh_order.guard_finance_entry()',false),
  ('finance_entry_batch_guard','zzsh_order.check_finance_batch()',true)
 ) AS required(name,fn,deferred) LOOP
  SELECT pg_get_triggerdef(t.oid),t.tgenabled INTO STRICT original,enabled FROM pg_trigger t
   WHERE t.tgrelid='zzsh_order.settlement_ledger_entry'::regclass AND t.tgname=item.name AND NOT t.tgisinternal
    AND t.tgfoid=to_regprocedure(item.fn) AND t.tgdeferrable=item.deferred AND t.tginitdeferred=item.deferred AND t.tgenabled IN('O','A');
  IF position('supportCancellationId' IN original)>0 THEN RAISE EXCEPTION 'cancellation entry guard already installed';END IF;
  updated:=regexp_replace(original,' WHEN \((.*)\) EXECUTE FUNCTION ',' WHEN ((\1) AND NOT (NEW.details ? ''supportCancellationId'')) EXECUTE FUNCTION ');
  IF updated=original THEN RAISE EXCEPTION 'finance entry guard shape unavailable';END IF;
  EXECUTE format('DROP TRIGGER %I ON zzsh_order.settlement_ledger_entry',item.name);
  EXECUTE updated;
  IF enabled='A' THEN EXECUTE format('ALTER TABLE zzsh_order.settlement_ledger_entry ENABLE ALWAYS TRIGGER %I',item.name);END IF;
 END LOOP;
END $entry_guards$;

CREATE FUNCTION zzsh_order.guard_support_poststart_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o zzsh_order.rental_order;c zzsh_order.payment_confirmation;expected text;
BEGIN
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=NEW.order_id FOR UPDATE;
 SELECT * INTO c FROM zzsh_order.payment_confirmation WHERE id=NEW.payment_confirmation_id AND order_id=NEW.order_id;
 expected:=encode(sha256(convert_to(jsonb_build_array(NEW.order_id,NEW.payment_confirmation_id,NEW.owner_user_id,NEW.renter_user_id,
  NEW.paid_cents::text,NEW.refund_cents::text,NEW.owner_cents::text,NEW.platform_cents::text,NEW.reason)::text,'UTF8')),'hex');
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  OR o.id IS NULL OR o.status<>'PAID' OR c.id IS NULL OR c.id IS DISTINCT FROM o.paid_confirmation_id
  OR c.disposition<>'APPLIED' OR c.currency<>'CNY' OR c.source NOT IN('JOINPAY','CONTROLLED')
  OR (c.source='CONTROLLED' AND NOT EXISTS(SELECT 1 FROM zzsh_order.distribution_order_admission a
    JOIN pg_database db ON db.datname=current_database()
    WHERE a.order_id=o.id AND a.mode='LOCAL_CONTROLLED' AND a.resource_oid=db.oid AND a.resource_name=current_database()
     AND a.resource_marker=shobj_description(db.oid,'pg_database') AND a.active
     AND a.admitted_at<=clock_timestamp() AND a.expires_at>clock_timestamp()))
  OR c.amount_cents IS DISTINCT FROM NEW.paid_cents OR c.amount_cents IS DISTINCT FROM o.rental_amount_cents+o.deposit_amount_cents
  OR o.owner_user_id IS DISTINCT FROM NEW.owner_user_id OR o.renter_user_id IS DISTINCT FROM NEW.renter_user_id
  OR NEW.source_digest IS DISTINCT FROM expected
  OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin'
  OR current_setting('zzsh.actor_id',true) IS DISTINCT FROM NEW.admin_user_id
  OR current_setting('zzsh.session_id',true) IS DISTINCT FROM NEW.admin_session_id
  OR current_setting('zzsh.request_id',true) IS DISTINCT FROM NEW.request_id
  OR NOT EXISTS(SELECT 1 FROM zzsh_auth_admin.session s WHERE s.id=NEW.admin_session_id AND s."userId"=NEW.admin_user_id
    AND NOT s.locked AND s."expiresAt">clock_timestamp())
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.rental_opening x WHERE x.order_id=o.id AND (x.status='CONFIRMED'
    OR (SELECT count(DISTINCT a.party) FROM zzsh_order.rental_opening_ack a WHERE a.opening_id=x.id AND a.version_no=x.version_no)=2))
  OR EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.order_id=o.id)
  OR EXISTS(SELECT 1 FROM zzsh_order.rental_referral_earning e WHERE e.order_id=o.id AND e.amount_cents>0 AND e.state<>'REVOKED')
  OR EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.order_id=o.id AND i.budget_disposition<>'RELEASED')
  OR EXISTS(SELECT 1 FROM zzsh_order.prestart_termination t WHERE t.order_id=o.id AND t.state<>'REJECTED')
  OR (NEW.owner_cents>0 AND NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage w WHERE w.user_id=o.owner_user_id))
 THEN RAISE EXCEPTION 'poststart cancellation original facts unavailable' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER support_poststart_cancellation_guard BEFORE INSERT ON zzsh_order.support_poststart_cancellation
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_support_poststart_cancellation();

CREATE FUNCTION zzsh_order.guard_support_poststart_root() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p zzsh_order.support_poststart_cancellation;
BEGIN
 SELECT * INTO p FROM zzsh_order.support_poststart_cancellation WHERE root_id=NEW.id;
 IF p.id IS NULL OR p.created_xid IS DISTINCT FROM pg_current_xact_id() OR NEW.basis_id IS NOT NULL
  OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh' OR NEW.source_entity<>'support_poststart_cancellation'
  OR NEW.source_id<>p.id OR NEW.subject_user_id<>p.owner_user_id OR NEW.beneficiary_role<>'OWNER'
  OR NEW.policy_version<>'support-cancellation-v1' OR NEW.source_digest<>p.source_digest
 THEN RAISE EXCEPTION 'poststart cancellation root differs' USING ERRCODE='23514';END IF;
 INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision)
  VALUES(p.owner_user_id,0,0),(p.renter_user_id,0,0) ON CONFLICT(user_id) DO NOTHING;
 RETURN NEW;
END $$;
CREATE TRIGGER support_poststart_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW
 WHEN(NEW.source_kind='NATIVE_SUPPORT_CANCELLATION') EXECUTE FUNCTION zzsh_order.guard_support_poststart_root();

CREATE FUNCTION zzsh_order.guard_support_poststart_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p zzsh_order.support_poststart_cancellation;r zzsh_order.finance_economic_root;rev bigint;
BEGIN
 SELECT * INTO p FROM zzsh_order.support_poststart_cancellation WHERE event_id=NEW.id;
 SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=NEW.subject_user_id;
 IF p.id IS NULL OR r.id IS NULL OR p.created_xid<>pg_current_xact_id() OR r.created_xid<>pg_current_xact_id()
  OR p.root_id<>r.id OR NEW.subject_user_id<>p.owner_user_id OR rev IS NULL OR rev IS DISTINCT FROM NEW.expected_ledger_revision
 THEN RAISE EXCEPTION 'poststart cancellation event differs' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER support_poststart_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW
 WHEN(NEW.kind='SUPPORT_CANCELLATION_RECOGNIZED') EXECUTE FUNCTION zzsh_order.guard_support_poststart_event();
CREATE TRIGGER support_poststart_wallet_revision AFTER INSERT ON zzsh_order.finance_event FOR EACH ROW
 WHEN(NEW.kind='SUPPORT_CANCELLATION_RECOGNIZED') EXECUTE FUNCTION zzsh_order.withdrawal_wallet_revision();

CREATE FUNCTION zzsh_order.guard_support_poststart_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p zzsh_order.support_poststart_cancellation;e zzsh_order.finance_event;source text;
BEGIN
 SELECT * INTO p FROM zzsh_order.support_poststart_cancellation WHERE id=NEW.details->>'supportCancellationId';
 SELECT * INTO e FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 SELECT c.source INTO source FROM zzsh_order.payment_confirmation c WHERE c.id=p.payment_confirmation_id;
 IF p.id IS NULL OR e.id IS NULL OR p.created_xid<>pg_current_xact_id() OR e.created_xid<>pg_current_xact_id()
  OR e.id<>p.event_id OR e.kind<>'SUPPORT_CANCELLATION_RECOGNIZED' OR NEW.posting_id IS NOT NULL
  OR NEW.details IS DISTINCT FROM jsonb_build_object('supportCancellationId',p.id,'orderId',p.order_id,
    'paymentConfirmationId',p.payment_confirmation_id,'dataOrigin',CASE source WHEN 'JOINPAY' THEN 'JOINPAY_LOCAL_ACCEPTANCE' ELSE 'LOCAL_CONTROLLED' END)
  OR NOT((NEW.line_no=1 AND NEW.account_code='CAPTURED_PAYMENT_SOURCE' AND NEW.debit_cents=p.paid_cents AND NEW.credit_cents=0
      AND NEW.counterparty_user_id IS NULL AND NEW.source_payment_confirmation_id=p.payment_confirmation_id)
   OR(p.refund_cents>0 AND NEW.line_no=2 AND NEW.account_code='RENTER_REFUND_PAYABLE' AND NEW.debit_cents=0 AND NEW.credit_cents=p.refund_cents
      AND NEW.counterparty_user_id=p.renter_user_id AND NEW.source_payment_confirmation_id IS NULL)
   OR(p.owner_cents>0 AND NEW.line_no=2+(p.refund_cents>0)::integer AND NEW.account_code='OWNER_AVAILABLE' AND NEW.debit_cents=0 AND NEW.credit_cents=p.owner_cents
      AND NEW.counterparty_user_id=p.owner_user_id AND NEW.source_payment_confirmation_id IS NULL)
   OR(p.platform_cents>0 AND NEW.line_no=2+(p.refund_cents>0)::integer+(p.owner_cents>0)::integer
      AND NEW.account_code='PLATFORM_CANCELLATION_CONTRIBUTION' AND NEW.debit_cents=0 AND NEW.credit_cents=p.platform_cents
      AND NEW.counterparty_user_id IS NULL AND NEW.source_payment_confirmation_id IS NULL))
 THEN RAISE EXCEPTION 'poststart cancellation entry differs' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER support_poststart_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'supportCancellationId') EXECUTE FUNCTION zzsh_order.guard_support_poststart_entry();

CREATE FUNCTION zzsh_order.guard_support_poststart_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.status='CANCELLED' AND NEW.cancel_reason='SUPPORT_AFTER_START_CANCELLED' THEN
  IF OLD.status<>'PAID' OR NEW.paid_confirmation_id IS DISTINCT FROM OLD.paid_confirmation_id OR NEW.paid_at IS DISTINCT FROM OLD.paid_at
   OR NEW.revision<>OLD.revision+1 OR NEW.cancelled_at IS NULL
   OR (to_jsonb(NEW)-ARRAY['status','cancel_reason','cancelled_at','revision','updated_at','payment_disposition'])
      IS DISTINCT FROM (to_jsonb(OLD)-ARRAY['status','cancel_reason','cancelled_at','revision','updated_at','payment_disposition'])
   OR NOT EXISTS(SELECT 1 FROM zzsh_order.support_poststart_cancellation p WHERE p.order_id=NEW.id
     AND p.payment_confirmation_id=NEW.paid_confirmation_id AND p.created_xid=pg_current_xact_id())
  THEN RAISE EXCEPTION 'poststart cancellation requires same-transaction allocation' USING ERRCODE='23514';END IF;
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER support_poststart_order_guard BEFORE UPDATE ON zzsh_order.rental_order
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_support_poststart_order();

CREATE FUNCTION zzsh_order.support_poststart_cancellation_complete(case_value text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT COALESCE(EXISTS(SELECT 1 FROM zzsh_order.support_poststart_cancellation p
  JOIN zzsh_order.rental_order o ON o.id=p.order_id
  JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id AND c.order_id=o.id
  JOIN zzsh_order.finance_economic_root r ON r.id=p.root_id
  JOIN zzsh_order.finance_event e ON e.id=p.event_id AND e.economic_root_id=r.id
  JOIN zzsh_order.wallet_revision w ON w.user_id=p.owner_user_id
  WHERE p.id=case_value AND o.status='CANCELLED' AND o.cancel_reason='SUPPORT_AFTER_START_CANCELLED'
   AND o.paid_confirmation_id=c.id AND c.disposition='APPLIED' AND c.currency='CNY' AND c.amount_cents=p.paid_cents
   AND o.owner_user_id=p.owner_user_id AND o.renter_user_id=p.renter_user_id
   AND r.source_kind='NATIVE_SUPPORT_CANCELLATION' AND r.source_type='NATIVE' AND r.source_system='zzsh'
   AND r.source_entity='support_poststart_cancellation' AND r.source_id=p.id AND r.subject_user_id=p.owner_user_id
   AND r.beneficiary_role='OWNER' AND r.policy_version='support-cancellation-v1' AND r.source_digest=p.source_digest
   AND e.kind='SUPPORT_CANCELLATION_RECOGNIZED' AND e.subject_user_id=p.owner_user_id AND w.ledger_revision>=e.expected_ledger_revision+1
   AND (SELECT count(*) FROM zzsh_order.finance_event x WHERE x.economic_root_id=r.id)=1
   AND (SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)
      =1+(p.refund_cents>0)::integer+(p.owner_cents>0)::integer+(p.platform_cents>0)::integer
   AND (SELECT coalesce(sum(debit_cents),0) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)=p.paid_cents
   AND (SELECT coalesce(sum(credit_cents),0) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)=p.paid_cents
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_posting s WHERE s.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_referral_earning d WHERE d.order_id=o.id AND d.amount_cents>0 AND d.state<>'REVOKED')
   AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.support_poststart_cancel' AND a.object_type='support_poststart_cancellation'
    AND a.object_id=p.id AND a.outcome='SUCCESS' AND a.actor_type='admin' AND a.actor_id=p.admin_user_id
    AND a.session_id=p.admin_session_id AND a.request_id=p.request_id AND a.reason=p.reason
    AND a.details->>'sourceDigest'=p.source_digest)),false)
$$;
COMMENT ON FUNCTION zzsh_order.support_poststart_cancellation_complete(text) IS '校验客服特殊取消的原款、资金分配、账本和审计闭合';

CREATE FUNCTION zzsh_order.check_support_poststart_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE target text;
BEGIN
 IF TG_TABLE_NAME='support_poststart_cancellation' THEN target:=NEW.id;
 ELSIF TG_TABLE_NAME='rental_order' THEN SELECT id INTO target FROM zzsh_order.support_poststart_cancellation WHERE order_id=NEW.id;
 ELSIF TG_TABLE_NAME='finance_economic_root' THEN target:=NEW.source_id;
 ELSIF TG_TABLE_NAME='finance_event' THEN SELECT source_id INTO target FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 ELSE target:=NEW.details->>'supportCancellationId';END IF;
 IF target IS NULL OR NOT zzsh_order.support_poststart_cancellation_complete(target)
 THEN RAISE EXCEPTION 'poststart cancellation batch incomplete' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER support_poststart_case_complete AFTER INSERT ON zzsh_order.support_poststart_cancellation
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_support_poststart_cancellation();
CREATE CONSTRAINT TRIGGER support_poststart_order_complete AFTER UPDATE ON zzsh_order.rental_order DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.cancel_reason='SUPPORT_AFTER_START_CANCELLED') EXECUTE FUNCTION zzsh_order.check_support_poststart_cancellation();
CREATE CONSTRAINT TRIGGER support_poststart_root_complete AFTER INSERT ON zzsh_order.finance_economic_root DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.source_kind='NATIVE_SUPPORT_CANCELLATION') EXECUTE FUNCTION zzsh_order.check_support_poststart_cancellation();
CREATE CONSTRAINT TRIGGER support_poststart_event_complete AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.kind='SUPPORT_CANCELLATION_RECOGNIZED') EXECUTE FUNCTION zzsh_order.check_support_poststart_cancellation();
CREATE CONSTRAINT TRIGGER support_poststart_entry_complete AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
 WHEN(NEW.details?'supportCancellationId') EXECUTE FUNCTION zzsh_order.check_support_poststart_cancellation();

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
  IF OLD.cancel_reason IN('PRESTART_TERMINATED','SUPPORT_CANCELLED_REFUND','SUPPORT_AFTER_START_CANCELLED') AND NEW IS DISTINCT FROM OLD THEN
    RAISE EXCEPTION 'terminated paid order is immutable' USING ERRCODE='40001';
  END IF;
  IF NEW.status IS DISTINCT FROM OLD.status
     AND NOT (OLD.status = 'PENDING_PAYMENT' AND NEW.status IN ('CANCELLED','PAID'))
     AND NOT (OLD.status='PAID' AND NEW.status='CANCELLED' AND NEW.cancel_reason='PRESTART_TERMINATED')
     AND NOT (OLD.status='PAID' AND NEW.status='CANCELLED' AND NEW.cancel_reason='MANUAL_CLOSE')
     AND NOT (OLD.status='PAID' AND NEW.status='CANCELLED' AND NEW.cancel_reason='SUPPORT_CANCELLED_REFUND')
     AND NOT (OLD.status='PAID' AND NEW.status='CANCELLED' AND NEW.cancel_reason='SUPPORT_AFTER_START_CANCELLED')
     AND NOT (OLD.status = 'PAID' AND NEW.status = 'COMPLETED'
       AND EXISTS (SELECT 1 FROM zzsh_order.settlement_posting WHERE order_id = OLD.id)) THEN
    RAISE EXCEPTION 'invalid rental order transition' USING ERRCODE = '40001';
  END IF;
  IF OLD.status IN ('PAID','COMPLETED') AND (NEW.paid_confirmation_id,NEW.paid_at) IS DISTINCT FROM (OLD.paid_confirmation_id,OLD.paid_at) THEN
    RAISE EXCEPTION 'paid order reference is immutable' USING ERRCODE = '40001';
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION zzsh_order.guard_rental_order() IS '保持订单原快照不可变并限制合法状态变更';

CREATE FUNCTION zzsh_order.cancel_order_after_start(order_value text,expected_revision bigint,refund_value numeric,owner_value numeric,reason_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor_value text:=current_setting('zzsh.actor_id',true);session_value text:=current_setting('zzsh.session_id',true);
 request_value text:=current_setting('zzsh.request_id',true);boss boolean;o zzsh_order.rental_order;c zzsh_order.payment_confirmation;
 owner_id text;renter_id text;game_value text;account_value text;case_id text;root_value text;event_value text;digest_value text;
 platform_value numeric;revision_value bigint;line_value integer:=1;details_value jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin'
  OR coalesce(actor_value,'')='' OR coalesce(session_value,'')='' OR coalesce(request_value,'')=''
  OR order_value IS NULL OR order_value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR expected_revision IS NULL OR expected_revision<1
  OR refund_value IS NULL OR owner_value IS NULL OR refund_value<>trunc(refund_value) OR owner_value<>trunc(owner_value)
  OR refund_value<0 OR owner_value<0 OR refund_value>9999999999999999 OR owner_value>9999999999999999
  OR reason_value IS NULL OR length(btrim(reason_value))<3 OR octet_length(reason_value)>600 OR reason_value<>btrim(reason_value)
  OR reason_value~'[[:cntrl:]]'
 THEN RAISE EXCEPTION 'poststart cancellation input invalid' USING ERRCODE='23514';END IF;
 SELECT sec.is_boss INTO boss FROM zzsh_iam.admin_security sec JOIN zzsh_auth_admin."user" u ON u.id=sec.admin_user_id
  JOIN zzsh_auth_admin.session s ON s."userId"=u.id AND s.id=session_value
  WHERE sec.admin_user_id=actor_value AND sec.status='ACTIVE' AND NOT sec.password_change_required AND NOT u.suspended
   AND u."twoFactorEnabled" IS TRUE AND NOT s.locked AND s."expiresAt">clock_timestamp() FOR SHARE OF sec,u,s;
 IF boss IS NULL THEN RAISE EXCEPTION 'poststart cancellation actor unavailable' USING ERRCODE='42501';END IF;
 SELECT q.owner_user_id,q.renter_user_id,q.game_id,q.account_id INTO owner_id,renter_id,game_value,account_value FROM zzsh_order.rental_order q WHERE q.id=order_value;
 IF owner_id IS NULL OR renter_id IS NULL THEN RAISE EXCEPTION 'poststart cancellation order unavailable' USING ERRCODE='23514';END IF;
 IF NOT boss AND (EXISTS(SELECT 1 FROM zzsh_iam.admin_user_permission d WHERE d.admin_user_id=actor_value AND d.permission_code='order.settlement.write' AND d.effect='DENY')
  OR NOT(EXISTS(SELECT 1 FROM zzsh_iam.admin_user_permission a WHERE a.admin_user_id=actor_value AND a.permission_code='order.settlement.write' AND a.effect='ALLOW')
   OR EXISTS(SELECT 1 FROM zzsh_iam.admin_user_role ur JOIN zzsh_iam.admin_role role ON role.id=ur.role_id AND role.status='ACTIVE'
    JOIN zzsh_iam.admin_role_permission rp ON rp.role_id=role.id WHERE ur.admin_user_id=actor_value AND rp.permission_code='order.settlement.write'))
  OR NOT EXISTS(SELECT 1 FROM zzsh_iam.admin_security sec WHERE sec.admin_user_id=actor_value AND (sec.game_scope_mode='ALL_GAMES'
   OR EXISTS(SELECT 1 FROM zzsh_supply.admin_supply_scope scope WHERE scope.admin_user_id=actor_value AND scope.game_id=game_value))))
 THEN RAISE EXCEPTION 'poststart cancellation permission unavailable' USING ERRCODE='42501';END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id IN(owner_id,renter_id) ORDER BY id COLLATE "C" FOR UPDATE;
 PERFORM id FROM zzsh_supply.game WHERE id=game_value FOR SHARE;
 PERFORM id FROM zzsh_supply.rental_account WHERE id=account_value FOR UPDATE;
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=order_value FOR UPDATE;
 SELECT * INTO c FROM zzsh_order.payment_confirmation WHERE id=o.paid_confirmation_id AND order_id=o.id;
 IF o.id IS NULL OR o.owner_user_id IS DISTINCT FROM owner_id OR o.renter_user_id IS DISTINCT FROM renter_id
  OR o.game_id IS DISTINCT FROM game_value OR o.account_id IS DISTINCT FROM account_value OR o.status<>'PAID'
  OR o.revision<>expected_revision OR c.id IS NULL OR c.disposition<>'APPLIED' OR c.currency<>'CNY'
  OR c.amount_cents<=0 OR c.amount_cents>9999999999999999 OR c.amount_cents<>o.rental_amount_cents+o.deposit_amount_cents
  OR refund_value+owner_value>c.amount_cents
 THEN RAISE EXCEPTION 'poststart cancellation amount or order changed' USING ERRCODE='23514';END IF;
 platform_value:=c.amount_cents-refund_value-owner_value;
 case_id:='spcancel_'||substr(encode(sha256(convert_to(o.id,'UTF8')),'hex'),1,40);
 root_value:='spcancel_root_'||substr(encode(sha256(convert_to(o.id,'UTF8')),'hex'),1,40);
 event_value:='spcancel_event_'||substr(encode(sha256(convert_to(o.id,'UTF8')),'hex'),1,40);
 digest_value:=encode(sha256(convert_to(jsonb_build_array(o.id,c.id,owner_id,renter_id,c.amount_cents::text,
  refund_value::text,owner_value::text,platform_value::text,reason_value)::text,'UTF8')),'hex');
 INSERT INTO zzsh_order.support_poststart_cancellation(id,order_id,payment_confirmation_id,owner_user_id,renter_user_id,
  admin_user_id,admin_session_id,request_id,reason,paid_cents,refund_cents,owner_cents,platform_cents,source_digest,root_id,event_id)
 VALUES(case_id,o.id,c.id,owner_id,renter_id,actor_value,session_value,request_value,reason_value,c.amount_cents,refund_value,owner_value,platform_value,digest_value,root_value,event_value);
 INSERT INTO zzsh_order.finance_economic_root(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,policy_version,source_digest)
 VALUES(root_value,NULL,'NATIVE_SUPPORT_CANCELLATION','NATIVE','zzsh','support_poststart_cancellation',case_id,owner_id,'OWNER','support-cancellation-v1',digest_value);
 SELECT ledger_revision INTO revision_value FROM zzsh_order.wallet_revision WHERE user_id=owner_id;
 INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision)
 VALUES(event_value,root_value,'SUPPORT_CANCELLATION_RECOGNIZED',owner_id,revision_value);
 details_value:=jsonb_build_object('supportCancellationId',case_id,'orderId',o.id,'paymentConfirmationId',c.id,
  'dataOrigin',CASE c.source WHEN 'JOINPAY' THEN 'JOINPAY_LOCAL_ACCEPTANCE' ELSE 'LOCAL_CONTROLLED' END);
 INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,source_payment_confirmation_id,details)
 VALUES(event_value||'_1',event_value,line_value,'CAPTURED_PAYMENT_SOURCE',c.amount_cents,0,NULL,c.id,details_value);
 IF refund_value>0 THEN line_value:=line_value+1;
  INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
  VALUES(event_value||'_'||line_value,event_value,line_value,'RENTER_REFUND_PAYABLE',0,refund_value,renter_id,details_value);END IF;
 IF owner_value>0 THEN line_value:=line_value+1;
  INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
  VALUES(event_value||'_'||line_value,event_value,line_value,'OWNER_AVAILABLE',0,owner_value,owner_id,details_value);END IF;
 IF platform_value>0 THEN line_value:=line_value+1;
  INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
  VALUES(event_value||'_'||line_value,event_value,line_value,'PLATFORM_CANCELLATION_CONTRIBUTION',0,platform_value,NULL,details_value);END IF;
 UPDATE zzsh_order.rental_order SET status='CANCELLED',cancel_reason='SUPPORT_AFTER_START_CANCELLED',cancelled_at=clock_timestamp(),
  revision=revision+1,updated_at=clock_timestamp() WHERE id=o.id AND status='PAID' AND revision=expected_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'poststart cancellation order changed' USING ERRCODE='40001';END IF;
 INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,reason,occurred_at,details)
 VALUES('audit_'||substr(encode(sha256(convert_to(case_id||request_value,'UTF8')),'hex'),1,40),'admin',actor_value,session_value,
  'order.support_poststart_cancel','support_poststart_cancellation',case_id,'SUCCESS',request_value,reason_value,clock_timestamp(),
  jsonb_build_object('orderId',o.id,'paymentConfirmationId',c.id,'paidCents',c.amount_cents::text,'refundCents',refund_value::text,
   'ownerCents',owner_value::text,'platformCents',platform_value::text,'sourceDigest',digest_value,'channelResult','NOT_SUBMITTED'));
 RETURN jsonb_build_object('caseId',case_id,'orderId',o.id,'status','CANCELLED','paidCents',c.amount_cents::text,'refundCents',refund_value::text,
  'ownerCents',owner_value::text,'platformContributionCents',platform_value::text,'commissionCents','0','channelResult','NOT_SUBMITTED');
END $$;
COMMENT ON FUNCTION zzsh_order.cancel_order_after_start(text,bigint,numeric,numeric,text) IS '按当事订单原款记录客服特殊取消与资金分配，不直接调用渠道';
REVOKE ALL ON FUNCTION zzsh_order.cancel_order_after_start(text,bigint,numeric,numeric,text),
 zzsh_order.support_poststart_cancellation_complete(text),zzsh_order.guard_support_poststart_cancellation(),
 zzsh_order.guard_support_poststart_root(),zzsh_order.guard_support_poststart_event(),zzsh_order.guard_support_poststart_entry(),
 zzsh_order.guard_support_poststart_order(),zzsh_order.check_support_poststart_cancellation() FROM PUBLIC;
