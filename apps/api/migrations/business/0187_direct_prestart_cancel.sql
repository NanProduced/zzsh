-- 历史审核与资金事实保留。
DO $$
BEGIN
 IF EXISTS (
  SELECT 1 FROM (VALUES
   ('zzsh_order.guard_prestart_termination_decision()','fbcdede1894e68bc9d70c639f395d584f24e17dbcbfa325eff81b344b33fa0e4'),
   ('zzsh_order.prestart_liability_complete(text)','774c9f8c896824f4c8121a0e70f5f387d362911b38e495f18860255384432152')
  ) expected(signature,digest)
  LEFT JOIN pg_proc p ON p.oid=to_regprocedure(expected.signature)
  WHERE p.oid IS NULL OR encode(sha256(convert_to(replace(pg_get_functiondef(p.oid),chr(13)||chr(10),chr(10)),'UTF8')),'hex') IS DISTINCT FROM expected.digest
 ) THEN RAISE EXCEPTION 'prestart cancellation guard prefix differs' USING ERRCODE='55000'; END IF;
END $$;

ALTER TABLE zzsh_order.prestart_termination_decision
 ALTER COLUMN admin_user_id DROP NOT NULL,
 ALTER COLUMN session_id DROP NOT NULL,
 ADD COLUMN user_id text REFERENCES zzsh_auth_user."user"(id),
 ADD COLUMN user_session_id text,
 ADD COLUMN acting_party text,
 ADD COLUMN reason_code text;
COMMENT ON COLUMN zzsh_order.prestart_termination_decision.user_id IS '自行取消的订单当事人；客服审核时为空';
COMMENT ON COLUMN zzsh_order.prestart_termination_decision.user_session_id IS '当事人取消时的登录会话编号';
COMMENT ON COLUMN zzsh_order.prestart_termination_decision.acting_party IS '自行取消的当事人角色：RENTER 或 OWNER';
COMMENT ON COLUMN zzsh_order.prestart_termination_decision.reason_code IS '按当事人角色区分的取消原因代码';

ALTER TABLE zzsh_order.prestart_termination_decision
 DROP CONSTRAINT prestart_termination_decision_assessment_shape,
 ADD CONSTRAINT prestart_termination_decision_assessment_shape CHECK(
   (decision='APPROVE' AND assessment IN('NO_USE_NO_DISPUTE','SUPPORT_FULL_REFUND','PARTY_FULL_REFUND'))
   OR(decision<>'APPROVE' AND assessment IS NULL)),
 ADD CONSTRAINT prestart_decision_actor_shape CHECK((
   (admin_user_id IS NOT NULL AND session_id IS NOT NULL AND user_id IS NULL AND user_session_id IS NULL AND acting_party IS NULL AND reason_code IS NULL
     AND assessment IS DISTINCT FROM 'PARTY_FULL_REFUND')
   OR (admin_user_id IS NULL AND session_id IS NULL AND user_id IS NOT NULL AND user_session_id IS NOT NULL
     AND acting_party IN('RENTER','OWNER') AND decision='APPROVE' AND assessment='PARTY_FULL_REFUND'
     AND ((acting_party='RENTER' AND reason_code IN('RENTER_NO_LONGER_NEEDED','RENTER_WRONG_ACCOUNT','RENTER_PRICE_UNSUITABLE','RENTER_ACCOUNT_MISMATCH','OTHER'))
       OR (acting_party='OWNER' AND reason_code IN('OWNER_UNAVAILABLE','OWNER_ACCOUNT_CHANGED','OWNER_ACCOUNT_UNSUITABLE','OWNER_MUTUAL_AGREEMENT','OTHER'))))) IS TRUE);
COMMENT ON CONSTRAINT prestart_decision_actor_shape ON zzsh_order.prestart_termination_decision IS '区分客服审核与当事人自行取消，并限制各自取消原因';

CREATE OR REPLACE FUNCTION zzsh_order.guard_prestart_termination_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE t zzsh_order.prestart_termination;o zzsh_order.rental_order;
BEGIN
 SELECT * INTO t FROM zzsh_order.prestart_termination WHERE id=NEW.termination_id;
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=t.order_id;
 IF t.id IS NULL OR o.id IS NULL OR t.revision<>NEW.result_revision OR t.last_reason IS DISTINCT FROM NEW.reason
   OR t.state<>(CASE NEW.decision WHEN 'APPROVE' THEN 'APPROVED' WHEN 'REJECT' THEN 'REJECTED' ELSE 'REVIEW_REQUIRED' END)
 THEN RAISE EXCEPTION 'prestart decision original differs' USING ERRCODE='23514'; END IF;
 IF NEW.user_id IS NOT NULL THEN
  IF t.requested_by_party='SUPPORT' OR NEW.decision IS DISTINCT FROM 'APPROVE' OR NEW.assessment IS DISTINCT FROM 'PARTY_FULL_REFUND'
   OR NEW.user_id IS DISTINCT FROM (CASE NEW.acting_party WHEN 'RENTER' THEN o.renter_user_id WHEN 'OWNER' THEN o.owner_user_id END)
   OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'user'
   OR current_setting('zzsh.actor_id',true) IS DISTINCT FROM NEW.user_id
   OR current_setting('zzsh.session_id',true) IS DISTINCT FROM NEW.user_session_id
   OR current_setting('zzsh.request_id',true) IS DISTINCT FROM NEW.request_id
   OR NOT EXISTS(SELECT 1 FROM zzsh_auth_user.session s WHERE s.id=NEW.user_session_id AND s."userId"=NEW.user_id
     AND s."expiresAt">clock_timestamp() AND NOT s.locked)
  THEN RAISE EXCEPTION 'prestart cancellation party or session differs' USING ERRCODE='23514'; END IF;
 ELSE
  IF NEW.decision='APPROVE' AND ((t.requested_by_party='SUPPORT' AND NEW.assessment<>'SUPPORT_FULL_REFUND')
      OR(t.requested_by_party<>'SUPPORT' AND NEW.assessment<>'NO_USE_NO_DISPUTE'))
   OR NEW.decision<>'APPROVE' AND NEW.assessment IS NOT NULL
   OR NOT EXISTS(SELECT 1 FROM zzsh_auth_admin.session s WHERE s.id=NEW.session_id AND s."userId"=NEW.admin_user_id AND s."expiresAt">clock_timestamp())
  THEN RAISE EXCEPTION 'prestart decision original differs' USING ERRCODE='23514'; END IF;
 END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
COMMENT ON FUNCTION zzsh_order.guard_prestart_termination_decision() IS '核验客服审核或订单当事人自行取消的身份和原申请';

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
     AND ((d.user_id IS NULL AND d.assessment=(CASE WHEN t.requested_by_party='SUPPORT' THEN 'SUPPORT_FULL_REFUND' ELSE 'NO_USE_NO_DISPUTE' END))
       OR(d.user_id IS NOT NULL AND t.requested_by_party<>'SUPPORT' AND d.assessment='PARTY_FULL_REFUND'))
     AND d.created_xid=t.approved_xid)
   AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a
     WHERE ((a.action=(CASE WHEN t.requested_by_party='SUPPORT' THEN 'order.support_cancel' ELSE 'order.prestart.termination.reviewed' END)
        AND EXISTS(SELECT 1 FROM zzsh_order.prestart_termination_decision d WHERE d.termination_id=t.id AND d.result_revision=t.revision AND d.user_id IS NULL))
      OR (a.action='order.prestart.termination.cancelled' AND a.actor_type='user'
        AND EXISTS(SELECT 1 FROM zzsh_order.prestart_termination_decision d WHERE d.termination_id=t.id AND d.result_revision=t.revision
          AND d.user_id=a.actor_id AND d.user_session_id=a.session_id AND d.reason_code=a.details->>'reasonCode')))
     AND a.object_type='prestart_termination' AND a.object_id=t.id AND a.outcome='SUCCESS'
     AND a.details->>'decision'='APPROVE' AND a.details->>'basisDigest'=t.basis_digest
     AND a.details->>'liabilityRootId'=r.id)),false)
$$;
COMMENT ON FUNCTION zzsh_order.prestart_liability_complete(text) IS '校验客服或订单当事人取消时的原款退款责任闭合';
