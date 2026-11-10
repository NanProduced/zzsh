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

DROP INDEX IF EXISTS zzsh_order.joinpay_abnormal_refund_key;
DROP TRIGGER abnormal_refund_liability_root_guard ON zzsh_order.finance_economic_root;
DROP TRIGGER abnormal_refund_liability_entry_guard ON zzsh_order.settlement_ledger_entry;
DROP TRIGGER abnormal_refund_liability_entry_batch_guard ON zzsh_order.settlement_ledger_entry;
DROP FUNCTION zzsh_order.guard_abnormal_refund_liability_root();
DROP FUNCTION zzsh_order.guard_abnormal_refund_liability_entry();
