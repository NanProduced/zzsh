-- Test-only simulation of a continued legacy-order refund. No provider call or bank fact is created.
DO $guard$
DECLARE db record;
BEGIN
 SELECT pg_get_userbyid(n.nspowner) AS owner,shobj_description(d.oid,'pg_database') AS marker INTO db
 FROM pg_database d JOIN pg_namespace n ON n.nspname='zzsh_order' WHERE d.datname=current_database();
 IF (current_database() ~ '^zzsh_ecs_test(_[a-z0-9_]{1,32})?$' AND db.marker='zzsh:ecs-test:v1'
   OR current_database()='zzsh_test_r07_delivery_20261108' AND db.marker='zzsh:r07-delivery-clone:v1') IS NOT TRUE
   OR db.owner<>current_user OR to_regprocedure('zzsh_order.ecs_test_demo_finance_matches(text)') IS NULL
   OR to_regclass('zzsh_order.ecs_demo_legacy_refund') IS NOT NULL THEN RAISE EXCEPTION 'Exact unmodified demo resource required';END IF;
END $guard$;

CREATE TABLE zzsh_order.ecs_demo_legacy_refund (
 id text PRIMARY KEY CHECK(id ~ '^demo_legacy_refund_[a-f0-9]{40}$'),
 registration_ref text NOT NULL REFERENCES zzsh_order.ecs_test_demo_finance_registration(reference),
 order_id text NOT NULL REFERENCES zzsh_order.legacy_order_read_snapshot(id),
 duty_id text NOT NULL UNIQUE REFERENCES zzsh_order.legacy_order_duty(id),
 renter_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),
 payment_record_id text NOT NULL,
 payment_order_no text NOT NULL UNIQUE,
 source_digest text NOT NULL CHECK(source_digest ~ '^[a-f0-9]{64}$'),
 duty_fact_digest text NOT NULL CHECK(duty_fact_digest ~ '^[a-f0-9]{64}$'),
 amount_cents numeric(24,0) NOT NULL CHECK(amount_cents>0),
 paid_cents numeric(24,0) NOT NULL CHECK(paid_cents>=amount_cents),
 event_id text NOT NULL UNIQUE REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED,
 assumption text NOT NULL CHECK(assumption='SIMULATION_ASSUME_NO_PRIOR_REFUND'),
 actor_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
 session_id text NOT NULL,
 request_id text NOT NULL,
 reason text NOT NULL CHECK(length(btrim(reason)) BETWEEN 3 AND 500),
 created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE FUNCTION zzsh_order.guard_demo_legacy_refund() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE s zzsh_order.ecs_test_demo_finance_registration; d zzsh_order.legacy_order_duty;
 f zzsh_order.legacy_duty_finance_fact; o zzsh_order.legacy_order_read_snapshot;
 e zzsh_order.legacy_continuation_evidence; v zzsh_order.legacy_continuation_version; paid text;
BEGIN
 SELECT * INTO s FROM zzsh_order.ecs_test_demo_finance_registration WHERE reference=NEW.registration_ref AND active FOR SHARE;
 SELECT * INTO d FROM zzsh_order.legacy_order_duty WHERE id=NEW.duty_id;
 SELECT * INTO f FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=NEW.duty_id;
 SELECT * INTO o FROM zzsh_order.legacy_order_read_snapshot WHERE id=NEW.order_id;
 SELECT * INTO e FROM zzsh_order.legacy_continuation_evidence WHERE order_id=NEW.order_id AND source_kind='SOURCE_IMPORT';
 SELECT * INTO v FROM zzsh_order.legacy_continuation_version WHERE id=d.continuation_version_id AND order_id=NEW.order_id AND command='CONFIRM';
 paid:=e.facts#>>'{evidence,source,paidPay,0,payMoney}';
 IF (s.reference IS NULL OR NOT zzsh_order.ecs_test_demo_finance_matches(s.registration_digest)
  OR NEW.id IS DISTINCT FROM 'demo_legacy_refund_'||substr(encode(sha256(convert_to(NEW.duty_id,'UTF8')),'hex'),1,40)
  OR NEW.event_id IS DISTINCT FROM 'demo_legacy_refund_paid_'||substr(encode(sha256(convert_to(NEW.duty_id,'UTF8')),'hex'),1,40)
  OR NEW.actor_id IS DISTINCT FROM current_setting('zzsh.actor_id',true) OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin'
  OR NEW.session_id IS DISTINCT FROM current_setting('zzsh.session_id',true) OR NEW.request_id IS DISTINCT FROM current_setting('zzsh.request_id',true)
  OR d.id IS NULL OR d.order_id<>NEW.order_id OR d.kind<>'RENTER_REFUND' OR d.source<>'CONTINUATION'
  OR d.status<>'SETTLED' OR d.settled_by<>'FINANCE' OR d.counterparty_user_id<>NEW.renter_user_id
  OR f.duty_id IS NULL OR f.order_id<>NEW.order_id OR f.kind<>'RENTER_REFUND' OR f.subject_user_id<>NEW.renter_user_id
  OR f.created_xid<>pg_current_xact_id() OR f.actor_realm<>'admin' OR f.actor_id<>NEW.actor_id OR f.session_id<>NEW.session_id OR f.request_id<>NEW.request_id
  OR d.revision<>f.duty_revision+1 OR f.amount_cents<>NEW.amount_cents OR f.facts_digest<>NEW.duty_fact_digest OR d.settled_ref_digest<>f.facts_digest
  OR o.id IS NULL OR o.source_pay_status<>1 OR o.source_order_status NOT IN (3,8,9) OR o.renter_user_id<>NEW.renter_user_id
  OR o.recorded_paid_amount_cents<>NEW.paid_cents OR o.source_digest<>NEW.source_digest OR f.parent_source_digest<>NEW.source_digest
  OR e.id IS NULL OR e.source_digest<>NEW.source_digest OR e.admission<>'PARAMETER_COMPLETE'
  OR e.facts_digest<>encode(sha256(convert_to(e.facts_canonical,'UTF8')),'hex') OR e.facts_canonical::jsonb<>e.facts
  OR jsonb_typeof(e.facts#>'{evidence,source,paidPay}')<>'array' OR jsonb_array_length(e.facts#>'{evidence,source,paidPay}')<>1
  OR e.facts#>>'{evidence,source,paidPay,0,id}'<>NEW.payment_record_id
  OR e.facts#>>'{evidence,source,paidPay,0,payOrderSn}'<>NEW.payment_order_no
  OR paid IS NULL OR paid !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$' OR (paid::numeric*100)<>NEW.paid_cents
  OR v.id IS NULL OR v.stage<>4 OR v.refund_due_at IS NULL OR v.refund_due_at>clock_timestamp()
  OR EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_case x WHERE x.duty_id=NEW.duty_id OR x.original_payment_order_no=NEW.payment_order_no)) IS NOT FALSE
 THEN RAISE EXCEPTION 'Demo refund lacks original order, due duty or explicit test resource' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER demo_legacy_refund_guard BEFORE INSERT ON zzsh_order.ecs_demo_legacy_refund FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_demo_legacy_refund();
CREATE TRIGGER demo_legacy_refund_immutable BEFORE UPDATE OR DELETE ON zzsh_order.ecs_demo_legacy_refund FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE TRIGGER demo_legacy_refund_no_truncate BEFORE TRUNCATE ON zzsh_order.ecs_demo_legacy_refund FOR EACH STATEMENT EXECUTE FUNCTION zzsh_order.finance_immutable();

DO $install$
DECLARE expression text; old_trigger text; replacement text; name text; function_oid oid;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='zzsh_order.finance_event'::regclass AND conname='finance_event_kind_check';
 IF expression IS NULL OR position('LEGACY_REFUND_PAID' IN expression)=0 THEN RAISE EXCEPTION 'Finance event contract missing';END IF;
 ALTER TABLE zzsh_order.finance_event DROP CONSTRAINT finance_event_kind_check;
 EXECUTE format('ALTER TABLE zzsh_order.finance_event ADD CONSTRAINT finance_event_kind_check CHECK((%s) OR kind=''DEMO_LEGACY_REFUND_PAID'')',expression);
 FOREACH name IN ARRAY ARRAY['finance_entry_guard','finance_entry_batch_guard'] LOOP
  SELECT pg_get_triggerdef(t.oid),t.tgfoid INTO old_trigger,function_oid FROM pg_trigger t
   WHERE t.tgrelid='zzsh_order.settlement_ledger_entry'::regclass AND t.tgname=name AND NOT t.tgisinternal;
  IF old_trigger IS NULL OR position('NOT (new.details ? ''legacyRefundIntentId''::text)' IN old_trigger)=0
    OR position('demoLegacyRefundId' IN old_trigger)>0
    OR function_oid<>(CASE name WHEN 'finance_entry_guard' THEN 'zzsh_order.guard_finance_entry()'::regprocedure ELSE 'zzsh_order.check_finance_batch()'::regprocedure END)
  THEN RAISE EXCEPTION 'Existing ledger trigger contract differs';END IF;
  replacement:=replace(old_trigger,'NOT (new.details ? ''legacyRefundIntentId''::text)',
    'NOT (new.details ? ''legacyRefundIntentId''::text) AND NOT (new.details ? ''demoLegacyRefundId''::text)');
  EXECUTE format('DROP TRIGGER %I ON zzsh_order.settlement_ledger_entry',name);EXECUTE replacement;
 END LOOP;
END $install$;

CREATE FUNCTION zzsh_order.guard_demo_legacy_refund_money() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x zzsh_order.ecs_demo_legacy_refund; f zzsh_order.legacy_duty_finance_fact; ev zzsh_order.finance_event; rev bigint; expected jsonb;
BEGIN
 IF TG_TABLE_NAME='finance_event' THEN SELECT * INTO x FROM zzsh_order.ecs_demo_legacy_refund WHERE event_id=NEW.id;
 ELSE SELECT * INTO x FROM zzsh_order.ecs_demo_legacy_refund WHERE id=NEW.details->>'demoLegacyRefundId';END IF;
 SELECT * INTO f FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=x.duty_id;
 IF (x.id IS NULL OR f.duty_id IS NULL OR x.created_xid<>pg_current_xact_id() OR f.created_xid<>x.created_xid
  OR f.facts_digest<>x.duty_fact_digest OR f.subject_user_id<>x.renter_user_id) IS NOT FALSE THEN RAISE EXCEPTION 'Demo refund original duty unavailable' USING ERRCODE='23514';END IF;
 IF TG_TABLE_NAME='finance_event' THEN
  PERFORM id FROM zzsh_auth_user."user" WHERE id=x.renter_user_id FOR UPDATE;
  SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=x.renter_user_id;
  IF (NEW.kind<>'DEMO_LEGACY_REFUND_PAID' OR NEW.economic_root_id<>f.root_id OR NEW.subject_user_id<>x.renter_user_id
    OR NEW.expected_ledger_revision IS DISTINCT FROM rev) IS NOT FALSE THEN RAISE EXCEPTION 'Demo refund event differs from duty' USING ERRCODE='23514';END IF;
  NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
 END IF;
 SELECT * INTO ev FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 expected:=jsonb_build_object('demoLegacyRefundId',x.id,'dataOrigin','SIMULATED','orderId',x.order_id,'dutyFactDigest',x.duty_fact_digest);
 IF (ev.id<>x.event_id OR ev.kind<>'DEMO_LEGACY_REFUND_PAID' OR ev.created_xid<>x.created_xid OR NEW.posting_id IS NOT NULL
  OR NEW.source_payment_confirmation_id IS NOT NULL OR NEW.details IS DISTINCT FROM expected
  OR NOT((NEW.line_no=1 AND NEW.account_code='RENTER_REFUND_PAYABLE' AND NEW.debit_cents=x.amount_cents AND NEW.credit_cents=0 AND NEW.counterparty_user_id=x.renter_user_id)
   OR(NEW.line_no=2 AND NEW.account_code='PAYOUT_CLEARING' AND NEW.debit_cents=0 AND NEW.credit_cents=x.amount_cents AND NEW.counterparty_user_id IS NULL))) IS NOT FALSE
 THEN RAISE EXCEPTION 'Demo refund entry differs from duty' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER demo_legacy_refund_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW
 WHEN(NEW.kind='DEMO_LEGACY_REFUND_PAID') EXECUTE FUNCTION zzsh_order.guard_demo_legacy_refund_money();
CREATE TRIGGER demo_legacy_refund_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'demoLegacyRefundId') EXECUTE FUNCTION zzsh_order.guard_demo_legacy_refund_money();
CREATE TRIGGER demo_legacy_refund_revision AFTER INSERT ON zzsh_order.finance_event FOR EACH ROW
 WHEN(NEW.kind='DEMO_LEGACY_REFUND_PAID') EXECUTE FUNCTION zzsh_order.withdrawal_wallet_revision();

CREATE FUNCTION zzsh_order.check_demo_legacy_refund_complete() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE x zzsh_order.ecs_demo_legacy_refund; f zzsh_order.legacy_duty_finance_fact; target text; n bigint; good bigint; dr numeric; cr numeric;
BEGIN
 IF TG_TABLE_NAME='ecs_demo_legacy_refund' THEN target:=NEW.id;
 ELSIF TG_TABLE_NAME='finance_event' THEN SELECT id INTO target FROM zzsh_order.ecs_demo_legacy_refund WHERE event_id=NEW.id;
 ELSE target:=NEW.details->>'demoLegacyRefundId';END IF;
 SELECT * INTO x FROM zzsh_order.ecs_demo_legacy_refund WHERE id=target;
 SELECT * INTO f FROM zzsh_order.legacy_duty_finance_fact WHERE duty_id=x.duty_id;
 SELECT count(*),COALESCE(sum(debit_cents),0),COALESCE(sum(credit_cents),0),count(*) FILTER(WHERE
   details=jsonb_build_object('demoLegacyRefundId',x.id,'dataOrigin','SIMULATED','orderId',x.order_id,'dutyFactDigest',x.duty_fact_digest)
   AND((line_no=1 AND account_code='RENTER_REFUND_PAYABLE' AND debit_cents=x.amount_cents AND credit_cents=0 AND counterparty_user_id=x.renter_user_id)
    OR(line_no=2 AND account_code='PAYOUT_CLEARING' AND debit_cents=0 AND credit_cents=x.amount_cents AND counterparty_user_id IS NULL)))
  INTO n,dr,cr,good FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=x.event_id;
 IF (x.id IS NULL OR f.duty_id IS NULL OR n<>2 OR good<>2 OR dr<>x.amount_cents OR cr<>x.amount_cents
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.finance_event ev WHERE ev.id=x.event_id AND ev.economic_root_id=f.root_id
    AND ev.kind='DEMO_LEGACY_REFUND_PAID' AND ev.subject_user_id=x.renter_user_id AND ev.created_xid=x.created_xid)
  OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='demo.legacy.refund.simulated' AND a.object_type='legacy_order_duty'
    AND a.object_id=x.duty_id AND a.actor_type='admin' AND a.actor_id=x.actor_id AND a.session_id=x.session_id AND a.request_id=x.request_id
    AND a.outcome='SUCCESS' AND a.details->>'operationId'=x.id AND a.details->>'assumption'=x.assumption AND a.details->>'bankArrival'='UNKNOWN')) IS NOT FALSE
 THEN RAISE EXCEPTION 'Demo refund must atomically close its original liability and audit' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER demo_legacy_refund_complete AFTER INSERT ON zzsh_order.ecs_demo_legacy_refund DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_demo_legacy_refund_complete();
CREATE CONSTRAINT TRIGGER demo_legacy_refund_event_complete AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='DEMO_LEGACY_REFUND_PAID') EXECUTE FUNCTION zzsh_order.check_demo_legacy_refund_complete();
CREATE CONSTRAINT TRIGGER demo_legacy_refund_entry_complete AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'demoLegacyRefundId') EXECUTE FUNCTION zzsh_order.check_demo_legacy_refund_complete();
REVOKE ALL ON TABLE zzsh_order.ecs_demo_legacy_refund FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.guard_demo_legacy_refund(),zzsh_order.guard_demo_legacy_refund_money(),zzsh_order.check_demo_legacy_refund_complete() FROM PUBLIC;
COMMENT ON TABLE zzsh_order.ecs_demo_legacy_refund IS '演示环境旧订单模拟退款；不表示汇聚调用或银行到账。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.id IS '演示退款内部标识。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.registration_ref IS '演示环境独立资源登记。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.order_id IS '迁入旧订单标识。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.duty_id IS '旧订单本次应退责任标识。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.renter_user_id IS '本次应退责任的租客。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.payment_record_id IS '原旧站付款记录来源标识。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.payment_order_no IS '原旧站付款单号，不是新的渠道流水。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.source_digest IS '原旧订单来源摘要。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.duty_fact_digest IS '结算应退责任的账内事实摘要。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.amount_cents IS '本次模拟退款金额，单位分。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.paid_cents IS '原旧站记录的付款金额，单位分，不证明渠道到账。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.event_id IS '对应演示账内事件标识。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.assumption IS '仅供演示的历史未退款假设，不是渠道核实结论。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.actor_id IS '发起模拟的客服或管理员。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.session_id IS '发起操作的会话标识。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.request_id IS '发起操作的请求标识。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.reason IS '模拟操作原因。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.created_xid IS '原子写入时的数据库事务标识。';
COMMENT ON COLUMN zzsh_order.ecs_demo_legacy_refund.created_at IS '模拟记录创建时间。';
