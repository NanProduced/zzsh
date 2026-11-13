-- Candidate only. A committed native posting is the original accrual recovery key.
DO $$ BEGIN
 IF to_regprocedure('zzsh_order.derive_frozen_referral_accrual(text)') IS NULL
  OR to_regprocedure('zzsh_order.frozen_referral_earning_seed(jsonb,jsonb)') IS NULL
  OR to_regprocedure('zzsh_order.earning_expected_lines(text)') IS NULL
 THEN RAISE EXCEPTION 'frozen referral derivation and ledger proof are required' USING ERRCODE='55000'; END IF;
END $$;
CREATE TABLE zzsh_order.distribution_accrual_task (
  posting_id text PRIMARY KEY REFERENCES zzsh_order.settlement_posting(id),
  state text NOT NULL DEFAULT 'PENDING' CONSTRAINT distribution_accrual_task_state_check CHECK (state IN ('PENDING','DONE','SKIPPED','REVIEW_REQUIRED')),
  reason_code text CONSTRAINT distribution_accrual_task_reason_code_check CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z0-9_]{1,64}$'),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT distribution_accrual_task_outcome_check CHECK ((state IN ('SKIPPED','REVIEW_REQUIRED') AND reason_code IS NOT NULL)
      OR (state IN ('PENDING','DONE') AND (state <> 'DONE' OR reason_code IS NULL)))
);
CREATE INDEX distribution_accrual_task_due ON zzsh_order.distribution_accrual_task(next_attempt_at,posting_id) WHERE state='PENDING';
CREATE INDEX referral_earning_posting ON zzsh_order.rental_referral_earning(posting_id,economic_key);
CREATE INDEX distribution_due_unfinished_receipt ON zzsh_supply.idempotency_record(created_at,key)
  WHERE response_status<>200 AND scope_key LIKE '["system","distribution-due-%';
CREATE FUNCTION zzsh_order.guard_distribution_accrual_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE derivation jsonb;item jsonb;expected_seed jsonb;actual_count integer;
 earning zzsh_order.rental_referral_earning;root zzsh_order.finance_economic_root;
 receipt zzsh_order.rental_referral_transition;event_row zzsh_order.finance_event;
BEGIN
  IF TG_OP='INSERT' AND NEW.state<>'PENDING' THEN
    RAISE EXCEPTION 'accrual task must start pending' USING ERRCODE='23514';
  ELSIF TG_OP='UPDATE' AND (NEW.posting_id IS DISTINCT FROM OLD.posting_id
    OR OLD.state IN ('DONE','SKIPPED') AND NEW IS DISTINCT FROM OLD
    OR OLD.state='REVIEW_REQUIRED' AND NEW.state='PENDING') THEN
    RAISE EXCEPTION 'accrual task original identity or completed state changed' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NEW.state IN ('DONE','SKIPPED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    derivation:=zzsh_order.derive_frozen_referral_accrual(NEW.posting_id);
    SELECT count(*) INTO actual_count FROM zzsh_order.rental_referral_earning WHERE posting_id=NEW.posting_id;
    IF NEW.state='DONE' AND (jsonb_array_length(derivation->'items')=0 OR actual_count<>jsonb_array_length(derivation->'items'))
      OR NEW.state='SKIPPED' AND (jsonb_array_length(derivation->'items')<>0 OR actual_count<>0
       OR NEW.reason_code IS DISTINCT FROM derivation->>'skipReason') THEN
      RAISE EXCEPTION 'accrual task requires the complete original referral set' USING ERRCODE='23514';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(derivation->'items') LOOP
      expected_seed:=zzsh_order.frozen_referral_earning_seed(derivation,item);
      SELECT * INTO earning FROM zzsh_order.rental_referral_earning
       WHERE posting_id=NEW.posting_id AND economic_key=item->>'economicKey';
      IF earning.id IS NULL OR earning.id IS DISTINCT FROM expected_seed->>'id' OR earning.economic_root_id IS DISTINCT FROM earning.id
       OR earning.order_id IS DISTINCT FROM derivation->>'orderId' OR earning.payment_confirmation_id IS DISTINCT FROM derivation->>'confirmationId'
       OR earning.beneficiary_user_id IS DISTINCT FROM item->>'beneficiaryUserId' OR earning.beneficiary_role IS DISTINCT FROM item->>'role'
       OR earning.amount_cents IS DISTINCT FROM (item->>'amountCents')::numeric OR earning.due_at IS DISTINCT FROM (item->>'dueAt')::timestamptz
       OR earning.basis_digest IS DISTINCT FROM item->>'basisDigest' OR earning.posting_digest IS DISTINCT FROM item->>'postingDigest'
       OR earning.canonical_seed IS DISTINCT FROM zzsh_order.canonical_finance_json(expected_seed)
       OR earning.seed_digest IS DISTINCT FROM encode(sha256(convert_to(earning.canonical_seed,'UTF8')),'hex')
      THEN RAISE EXCEPTION 'accrual task earning differs from the frozen referral set' USING ERRCODE='23514'; END IF;
      SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=earning.economic_root_id;
      SELECT * INTO receipt FROM zzsh_order.rental_referral_transition WHERE earning_id=earning.id AND action='ACCRUE';
      SELECT * INTO event_row FROM zzsh_order.finance_event WHERE id=receipt.finance_event_id;
      IF root.id IS NULL OR root.basis_id IS NOT NULL OR root.source_kind IS DISTINCT FROM 'NATIVE_RENTAL_REFERRAL'
       OR root.source_type IS DISTINCT FROM 'NATIVE' OR root.source_system IS DISTINCT FROM 'zzsh' OR root.source_entity IS DISTINCT FROM 'rental_order'
       OR root.source_id IS DISTINCT FROM earning.order_id OR root.subject_user_id IS DISTINCT FROM earning.beneficiary_user_id
       OR root.beneficiary_role IS DISTINCT FROM earning.beneficiary_role OR root.policy_version IS DISTINCT FROM item->>'policyVersion'
       OR root.source_digest IS DISTINCT FROM earning.posting_digest OR receipt.id IS NULL OR receipt.expected_version<>0 OR receipt.result_version<>1
       OR receipt.reversal_source_id IS NOT NULL OR receipt.source_digest IS DISTINCT FROM earning.posting_digest
       OR event_row.id IS NULL OR event_row.kind IS DISTINCT FROM 'EARNING_PENDING' OR event_row.economic_root_id IS DISTINCT FROM root.id
       OR event_row.subject_user_id IS DISTINCT FROM earning.beneficiary_user_id
      THEN RAISE EXCEPTION 'accrual task original earning receipt is incomplete' USING ERRCODE='23514'; END IF;
      IF EXISTS(SELECT l.line_no,l.account_code,l.debit_cents,l.credit_cents,l.counterparty_user_id,l.source_payment_confirmation_id
        FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=event_row.id
        EXCEPT ALL SELECT x.line_no,x.account_code,x.debit_cents,x.credit_cents,x.counterparty_user_id,x.source_payment_confirmation_id
         FROM zzsh_order.earning_expected_lines(event_row.id) x)
       OR EXISTS(SELECT x.line_no,x.account_code,x.debit_cents,x.credit_cents,x.counterparty_user_id,x.source_payment_confirmation_id
        FROM zzsh_order.earning_expected_lines(event_row.id) x
        EXCEPT ALL SELECT l.line_no,l.account_code,l.debit_cents,l.credit_cents,l.counterparty_user_id,l.source_payment_confirmation_id
         FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=event_row.id)
      THEN RAISE EXCEPTION 'accrual task original earning ledger is incomplete' USING ERRCODE='23514'; END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER distribution_accrual_task_guard BEFORE INSERT OR UPDATE ON zzsh_order.distribution_accrual_task
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_distribution_accrual_task();
COMMENT ON FUNCTION zzsh_order.guard_distribution_accrual_task() IS '保护计佣任务原过账身份和完成状态。';
CREATE FUNCTION zzsh_order.enqueue_distribution_accrual_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO zzsh_order.distribution_accrual_task(posting_id) VALUES(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER settlement_distribution_accrual_enqueue AFTER INSERT ON zzsh_order.settlement_posting
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.enqueue_distribution_accrual_task();
COMMENT ON FUNCTION zzsh_order.enqueue_distribution_accrual_task() IS '在结算过账事务中登记原过账计佣任务。';
CREATE FUNCTION zzsh_order.guard_referral_earning_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE task_state text;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT state INTO task_state FROM zzsh_order.distribution_accrual_task WHERE posting_id=NEW.posting_id FOR UPDATE;
    IF task_state IS NULL OR task_state NOT IN ('PENDING','REVIEW_REQUIRED') THEN
      RAISE EXCEPTION 'earning requires an open original accrual task' USING ERRCODE='23514';
    END IF;
  ELSIF OLD.state='PENDING' AND NEW.state='SETTLED' THEN
    SELECT state INTO task_state FROM zzsh_order.distribution_accrual_task WHERE posting_id=NEW.posting_id FOR SHARE;
    IF task_state IS DISTINCT FROM 'DONE' THEN
      RAISE EXCEPTION 'earning cannot settle before the complete original accrual task' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_referral_earning_task_guard BEFORE INSERT OR UPDATE ON zzsh_order.rental_referral_earning
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_referral_earning_task();
COMMENT ON FUNCTION zzsh_order.guard_referral_earning_task() IS '使用同一任务行锁保护计佣明细并阻止未核实佣金入账。';
COMMENT ON TABLE zzsh_order.distribution_accrual_task IS '新站结算过账对应的分销计佣恢复任务，不含旧站迁入责任。';
COMMENT ON COLUMN zzsh_order.distribution_accrual_task.posting_id IS '原结算过账；也是任务幂等和恢复键。';
COMMENT ON COLUMN zzsh_order.distribution_accrual_task.state IS '待处理、已计佣、明确无佣或待人工核对。';
COMMENT ON COLUMN zzsh_order.distribution_accrual_task.reason_code IS '跳过、复核或暂时失败的稳定原因码。';
COMMENT ON COLUMN zzsh_order.distribution_accrual_task.next_attempt_at IS '待处理任务下次可重试时间。';
COMMENT ON COLUMN zzsh_order.distribution_accrual_task.created_at IS '任务创建时间。';
COMMENT ON COLUMN zzsh_order.distribution_accrual_task.updated_at IS '任务最后更新时间。';

-- Existing native postings also need recovery; the stored payment basis, not current policy, decides accrual.
INSERT INTO zzsh_order.distribution_accrual_task(posting_id)
SELECT p.id FROM zzsh_order.settlement_posting p
JOIN zzsh_order.rental_order o ON o.id=p.order_id AND o.status='COMPLETED'
JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id AND c.order_id=p.order_id
WHERE c.disposition='APPLIED' AND c.source IN ('JOINPAY','CONTROLLED')
ON CONFLICT (posting_id) DO NOTHING;
