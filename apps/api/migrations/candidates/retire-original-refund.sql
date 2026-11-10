-- 合入正式迁移链时按当时未占用的编号登记；旧业务迁移保持原字节。
-- 退役的异常原款责任不再产生；真实支付及正常结算、未开租退款继续保留。
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
