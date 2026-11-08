-- 订单包赔赔款与原路退款、押金补偿、包赔服务费分别记账。
INSERT INTO zzsh_iam.admin_permission(code,name,description) VALUES
 ('order.compensation.request','发起订单包赔赔偿','为订单号主提交有依据的包赔赔偿申请'),
 ('order.compensation.approve','审批订单包赔赔偿','审批通过时同事务记入号主余额') ON CONFLICT(code) DO NOTHING;
INSERT INTO zzsh_iam.admin_role_permission(role_id,permission_code)
 SELECT v.role_id,v.code FROM (VALUES('role_preset_support','order.compensation.request'),('role_preset_ops','order.compensation.request'),('role_preset_ops','order.compensation.approve')) v(role_id,code)
 JOIN zzsh_iam.admin_role r ON r.id=v.role_id ON CONFLICT DO NOTHING;
INSERT INTO zzsh_iam.approval_template(id,operation_code,trigger_condition,version)
 VALUES('approval_tpl_order_compensation','order.compensation.grant','order.compensation.requested',1)
 ON CONFLICT(operation_code,trigger_condition) DO NOTHING;
CREATE UNIQUE INDEX order_compensation_incident_once ON zzsh_iam.approval_request
 ((operation_payload->>'origin'),(operation_payload->>'orderId'),lower(operation_payload->>'caseRef'))
 WHERE operation_code='order.compensation.grant' AND status IN('PENDING','APPROVED','EXECUTED','EXECUTION_FAILED');

--> statement-breakpoint
DO $extend$
DECLARE expression text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='zzsh_order.finance_economic_root'::regclass AND conname='finance_root_enabled_source_shape';
 IF expression IS NULL OR position('NATIVE_RENTAL_REFUND' IN expression)=0 THEN RAISE EXCEPTION 'finance source contract missing';END IF;
 ALTER TABLE zzsh_order.finance_economic_root DROP CONSTRAINT finance_root_enabled_source_shape;
 EXECUTE format('ALTER TABLE zzsh_order.finance_economic_root ADD CONSTRAINT finance_root_enabled_source_shape CHECK((%s) OR (source_kind=''ORDER_COMPENSATION'' AND basis_id IS NULL))',expression);
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='zzsh_order.finance_event'::regclass AND conname='finance_event_kind_check';
 IF expression IS NULL OR position('LEGACY_REFUND_PAID' IN expression)=0 THEN RAISE EXCEPTION 'finance event contract missing';END IF;
 ALTER TABLE zzsh_order.finance_event DROP CONSTRAINT finance_event_kind_check;
 EXECUTE format('ALTER TABLE zzsh_order.finance_event ADD CONSTRAINT finance_event_kind_check CHECK((%s) OR kind=''ORDER_COMPENSATION_PAID'')',expression);
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint WHERE conrelid='zzsh_order.settlement_ledger_entry'::regclass AND conname='settlement_ledger_accounts';
 IF expression IS NULL OR position('WALLET_AVAILABLE' IN expression)=0 THEN RAISE EXCEPTION 'finance ledger contract missing';END IF;
 ALTER TABLE zzsh_order.settlement_ledger_entry DROP CONSTRAINT settlement_ledger_accounts;
 EXECUTE format('ALTER TABLE zzsh_order.settlement_ledger_entry ADD CONSTRAINT settlement_ledger_accounts CHECK((%s) OR (finance_event_id IS NOT NULL AND account_code=''PLATFORM_COMPENSATION_EXPENSE''))',expression);
END $extend$;

CREATE TABLE zzsh_order.order_compensation_posting (
 id text PRIMARY KEY,approval_request_id text NOT NULL UNIQUE REFERENCES zzsh_iam.approval_request(id),
 order_origin text NOT NULL CHECK(order_origin IN('NATIVE','LEGACY')),order_id text NOT NULL,game_id text NOT NULL REFERENCES zzsh_supply.game(id),
 owner_user_id text NOT NULL REFERENCES zzsh_auth_user."user"(id),source_digest text NOT NULL CHECK(source_digest~'^[a-f0-9]{64}$'),
 amount_cents numeric(16,0) NOT NULL CHECK(amount_cents>0),case_ref text NOT NULL,reason text NOT NULL,evidence_ref text NOT NULL,
 requested_by text NOT NULL REFERENCES zzsh_auth_admin."user"(id),approved_by text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
 root_id text NOT NULL UNIQUE REFERENCES zzsh_order.finance_economic_root(id) DEFERRABLE INITIALLY DEFERRED,
 event_id text NOT NULL UNIQUE REFERENCES zzsh_order.finance_event(id) DEFERRABLE INITIALLY DEFERRED,
 payload_digest text NOT NULL CHECK(payload_digest~'^[a-f0-9]{64}$'),created_xid xid8 NOT NULL DEFAULT pg_current_xact_id(),created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX order_compensation_order_idx ON zzsh_order.order_compensation_posting(order_origin,order_id,created_at,id);
COMMENT ON TABLE zzsh_order.order_compensation_posting IS '订单全额包赔赔款的不可变入账凭证，关联审批及钱包账本。';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.id IS '赔偿入账凭证标识';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.approval_request_id IS '原审批申请标识，同申请仅入账一次';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.order_origin IS '订单来源，NATIVE 或 LEGACY';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.order_id IS '按来源限定的订单标识';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.game_id IS '订单所属游戏';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.owner_user_id IS '本单号主及赔偿受益人';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.source_digest IS '提交时核对的订单及付款或旧来源依据摘要';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.amount_cents IS '赔偿金额，单位分';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.case_ref IS '用于辨别同订单不同事故的工单或事项编号';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.reason IS '赔偿处理原因';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.evidence_ref IS '客服核对依据或工单引用';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.requested_by IS '申请人';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.approved_by IS '审批人，可与申请人为同一名有权运营';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.root_id IS '本赔款唯一经济根';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.event_id IS '余额入账事件';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.payload_digest IS '不可变审批载荷摘要';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.created_xid IS '审批入账事务标识';
COMMENT ON COLUMN zzsh_order.order_compensation_posting.created_at IS '入账时间';
CREATE TRIGGER order_compensation_immutable BEFORE UPDATE OR DELETE ON zzsh_order.order_compensation_posting FOR EACH ROW EXECUTE FUNCTION zzsh_order.finance_immutable();
CREATE FUNCTION zzsh_order.guard_order_compensation_posting() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE a zzsh_iam.approval_request;
BEGIN
 SELECT * INTO a FROM zzsh_iam.approval_request WHERE id=NEW.approval_request_id;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  OR a.id IS NULL OR a.operation_code<>'order.compensation.grant' OR a.status<>'APPROVED' OR a.decided_by IS DISTINCT FROM NEW.approved_by
  OR a.requested_by IS DISTINCT FROM NEW.requested_by OR a.operation_payload_hash IS DISTINCT FROM NEW.payload_digest
  OR a.operation_payload->>'origin' IS DISTINCT FROM NEW.order_origin OR a.operation_payload->>'orderId' IS DISTINCT FROM NEW.order_id
  OR a.operation_payload->>'ownerUserId' IS DISTINCT FROM NEW.owner_user_id OR a.operation_payload->>'gameId' IS DISTINCT FROM NEW.game_id
  OR a.operation_payload->>'sourceDigest' IS DISTINCT FROM NEW.source_digest OR a.operation_payload->>'amountCents' IS DISTINCT FROM NEW.amount_cents::text
  OR a.operation_payload->>'caseRef' IS DISTINCT FROM NEW.case_ref OR a.operation_payload->>'reason' IS DISTINCT FROM NEW.reason
  OR a.operation_payload->>'evidenceRef' IS DISTINCT FROM NEW.evidence_ref
 THEN RAISE EXCEPTION 'compensation posting lacks exact approval' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
CREATE TRIGGER order_compensation_posting_guard BEFORE INSERT ON zzsh_order.order_compensation_posting FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_order_compensation_posting();
CREATE FUNCTION zzsh_order.protect_order_compensation_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF EXISTS(SELECT 1 FROM zzsh_order.order_compensation_posting WHERE approval_request_id=OLD.id)
  AND (NEW.status<>'EXECUTED' OR OLD.status NOT IN('APPROVED','EXECUTED') OR
   (OLD.status='EXECUTED' AND (NEW.decided_by,NEW.decided_at,NEW.decision_reason) IS DISTINCT FROM (OLD.decided_by,OLD.decided_at,OLD.decision_reason)))
 THEN RAISE EXCEPTION 'posted compensation approval cannot be reopened' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER order_compensation_approval_guard BEFORE UPDATE ON zzsh_iam.approval_request FOR EACH ROW EXECUTE FUNCTION zzsh_order.protect_order_compensation_approval();

--> statement-breakpoint
CREATE FUNCTION zzsh_order.guard_order_compensation_root() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p zzsh_order.order_compensation_posting;
BEGIN
 SELECT * INTO p FROM zzsh_order.order_compensation_posting WHERE root_id=NEW.id;
 IF p.id IS NULL OR p.created_xid<>pg_current_xact_id() OR NEW.basis_id IS NOT NULL OR NEW.source_type<>'NATIVE'
  OR NEW.source_system<>'zzsh' OR NEW.source_entity<>'order_compensation' OR NEW.source_id<>p.id
  OR NEW.subject_user_id<>p.owner_user_id OR NEW.beneficiary_role<>'OWNER' OR NEW.policy_version<>'order-compensation-v1' OR NEW.source_digest<>p.payload_digest
 THEN RAISE EXCEPTION 'compensation root does not bind approved posting' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER order_compensation_root_guard BEFORE INSERT ON zzsh_order.finance_economic_root FOR EACH ROW
 WHEN(NEW.source_kind='ORDER_COMPENSATION') EXECUTE FUNCTION zzsh_order.guard_order_compensation_root();
CREATE FUNCTION zzsh_order.guard_order_compensation_event() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p zzsh_order.order_compensation_posting;r zzsh_order.finance_economic_root;rev bigint;
BEGIN
 SELECT * INTO p FROM zzsh_order.order_compensation_posting WHERE event_id=NEW.id;SELECT * INTO r FROM zzsh_order.finance_economic_root WHERE id=NEW.economic_root_id;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=NEW.subject_user_id FOR UPDATE;
 SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=NEW.subject_user_id;
 IF p.id IS NULL OR r.id IS NULL OR p.created_xid<>pg_current_xact_id() OR r.created_xid<>pg_current_xact_id() OR p.root_id<>r.id
  OR NEW.subject_user_id<>p.owner_user_id OR rev IS DISTINCT FROM NEW.expected_ledger_revision
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage WHERE user_id=p.owner_user_id)
 THEN RAISE EXCEPTION 'compensation wallet or revision unavailable' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER order_compensation_event_guard BEFORE INSERT ON zzsh_order.finance_event FOR EACH ROW
 WHEN(NEW.kind='ORDER_COMPENSATION_PAID') EXECUTE FUNCTION zzsh_order.guard_order_compensation_event();
CREATE TRIGGER order_compensation_wallet_revision AFTER INSERT ON zzsh_order.finance_event FOR EACH ROW
 WHEN(NEW.kind='ORDER_COMPENSATION_PAID') EXECUTE FUNCTION zzsh_order.withdrawal_wallet_revision();

-- Preserve installed product-specific exclusions while adding the new event's own guard.
DO $extend_entry_guards$
DECLARE item record;original text;updated text;enabled "char";
BEGIN
 FOR item IN SELECT * FROM (VALUES
   ('finance_entry_guard','zzsh_order.guard_finance_entry()',false),
   ('finance_entry_batch_guard','zzsh_order.check_finance_batch()',true)
 ) AS required(name,fn,deferred) LOOP
  SELECT pg_get_triggerdef(t.oid),t.tgenabled INTO STRICT original,enabled FROM pg_trigger t
   WHERE t.tgrelid='zzsh_order.settlement_ledger_entry'::regclass AND t.tgname=item.name AND NOT t.tgisinternal
    AND t.tgfoid=to_regprocedure(item.fn) AND t.tgdeferrable=item.deferred AND t.tginitdeferred=item.deferred AND t.tgenabled IN('O','A');
  IF position('compensationCaseId' IN original)>0 THEN RAISE EXCEPTION 'compensation entry guard already present';END IF;
  updated:=regexp_replace(original,' WHEN \((.*)\) EXECUTE FUNCTION ',' WHEN ((\1) AND NOT (NEW.details ? ''compensationCaseId'')) EXECUTE FUNCTION ');
  IF updated=original THEN RAISE EXCEPTION 'finance entry guard shape unavailable';END IF;
  EXECUTE format('DROP TRIGGER %I ON zzsh_order.settlement_ledger_entry',item.name);
  EXECUTE updated;
  IF enabled='A' THEN EXECUTE format('ALTER TABLE zzsh_order.settlement_ledger_entry ENABLE ALWAYS TRIGGER %I',item.name);END IF;
 END LOOP;
END $extend_entry_guards$;
CREATE FUNCTION zzsh_order.guard_order_compensation_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p zzsh_order.order_compensation_posting;e zzsh_order.finance_event;
BEGIN
 SELECT * INTO p FROM zzsh_order.order_compensation_posting WHERE id=NEW.details->>'compensationCaseId';
 SELECT * INTO e FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 IF p.id IS NULL OR e.id IS NULL OR p.event_id<>e.id OR e.kind<>'ORDER_COMPENSATION_PAID' OR e.created_xid<>pg_current_xact_id()
  OR NEW.source_payment_confirmation_id IS NOT NULL OR NEW.details IS DISTINCT FROM jsonb_build_object('compensationCaseId',p.id,'approvalRequestId',p.approval_request_id,'orderId',p.order_id,'origin',p.order_origin)
  OR NOT((NEW.line_no=1 AND NEW.account_code='PLATFORM_COMPENSATION_EXPENSE' AND NEW.debit_cents=p.amount_cents AND NEW.credit_cents=0 AND NEW.counterparty_user_id IS NULL)
       OR(NEW.line_no=2 AND NEW.account_code='WALLET_AVAILABLE' AND NEW.debit_cents=0 AND NEW.credit_cents=p.amount_cents AND NEW.counterparty_user_id=p.owner_user_id))
 THEN RAISE EXCEPTION 'compensation ledger line invalid' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER order_compensation_entry_guard BEFORE INSERT ON zzsh_order.settlement_ledger_entry FOR EACH ROW
 WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'compensationCaseId') EXECUTE FUNCTION zzsh_order.guard_order_compensation_entry();

--> statement-breakpoint
CREATE FUNCTION zzsh_order.check_order_compensation_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p zzsh_order.order_compensation_posting;target text;
BEGIN
 IF TG_TABLE_NAME='order_compensation_posting' THEN target:=NEW.id;
 ELSIF TG_TABLE_NAME='finance_economic_root' THEN SELECT id INTO target FROM zzsh_order.order_compensation_posting WHERE root_id=NEW.id;
 ELSIF TG_TABLE_NAME='finance_event' THEN SELECT id INTO target FROM zzsh_order.order_compensation_posting WHERE event_id=NEW.id;
 ELSE target:=NEW.details->>'compensationCaseId';END IF;
 SELECT * INTO p FROM zzsh_order.order_compensation_posting WHERE id=target;
 IF p.id IS NULL OR NOT EXISTS(SELECT 1 FROM zzsh_iam.approval_request a JOIN zzsh_iam.approval_decision d ON d.request_id=a.id
   JOIN zzsh_iam.approval_execution x ON x.request_id=a.id WHERE a.id=p.approval_request_id AND a.operation_code='order.compensation.grant'
   AND a.status='EXECUTED' AND a.requested_by=p.requested_by AND a.decided_by=p.approved_by AND d.decision='APPROVED' AND d.approver_admin_id=p.approved_by
   AND x.status='SUCCEEDED' AND x.result_code='ORDER_COMPENSATION_POSTED' AND x.result_detail=p.id AND x.executed_by=p.approved_by)
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.finance_economic_root r JOIN zzsh_order.finance_event e ON e.economic_root_id=r.id
    JOIN zzsh_order.wallet_revision w ON w.user_id=e.subject_user_id WHERE r.id=p.root_id AND r.source_kind='ORDER_COMPENSATION' AND r.subject_user_id=p.owner_user_id
     AND e.id=p.event_id AND e.kind='ORDER_COMPENSATION_PAID' AND e.subject_user_id=p.owner_user_id AND w.ledger_revision>=e.expected_ledger_revision+1)
  OR (SELECT count(*) FROM zzsh_order.finance_event WHERE economic_root_id=p.root_id)<>1
  OR (SELECT count(*) FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=p.event_id)<>2
  OR (SELECT coalesce(sum(debit_cents),0) FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=p.event_id)<>p.amount_cents
  OR (SELECT coalesce(sum(credit_cents),0) FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=p.event_id)<>p.amount_cents
 THEN RAISE EXCEPTION 'compensation approval and ledger are not closed' USING ERRCODE='23514';END IF;
 RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER order_compensation_posting_complete AFTER INSERT ON zzsh_order.order_compensation_posting DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_order.check_order_compensation_batch();
CREATE CONSTRAINT TRIGGER order_compensation_root_complete AFTER INSERT ON zzsh_order.finance_economic_root DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.source_kind='ORDER_COMPENSATION') EXECUTE FUNCTION zzsh_order.check_order_compensation_batch();
CREATE CONSTRAINT TRIGGER order_compensation_event_complete AFTER INSERT ON zzsh_order.finance_event DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.kind='ORDER_COMPENSATION_PAID') EXECUTE FUNCTION zzsh_order.check_order_compensation_batch();
CREATE CONSTRAINT TRIGGER order_compensation_entry_complete AFTER INSERT ON zzsh_order.settlement_ledger_entry DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.finance_event_id IS NOT NULL AND NEW.details?'compensationCaseId') EXECUTE FUNCTION zzsh_order.check_order_compensation_batch();
CREATE FUNCTION zzsh_order.order_compensation_posting_complete(case_value text) RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog AS $$
 SELECT COALESCE(EXISTS(SELECT 1 FROM zzsh_order.order_compensation_posting p
  JOIN zzsh_iam.approval_request a ON a.id=p.approval_request_id AND a.operation_code='order.compensation.grant' AND a.status='EXECUTED'
    AND a.operation_payload_hash=p.payload_digest AND a.operation_payload->>'orderId'=p.order_id AND a.operation_payload->>'origin'=p.order_origin
    AND a.operation_payload->>'ownerUserId'=p.owner_user_id AND a.operation_payload->>'gameId'=p.game_id AND a.operation_payload->>'sourceDigest'=p.source_digest
    AND a.operation_payload->>'amountCents'=p.amount_cents::text AND a.operation_payload->>'caseRef'=p.case_ref AND a.operation_payload->>'reason'=p.reason
    AND a.operation_payload->>'evidenceRef'=p.evidence_ref AND a.requested_by=p.requested_by AND a.decided_by=p.approved_by
  JOIN zzsh_iam.approval_decision d ON d.request_id=a.id AND d.decision='APPROVED' AND d.approver_admin_id=p.approved_by
  JOIN zzsh_iam.approval_execution x ON x.request_id=a.id AND x.status='SUCCEEDED' AND x.result_code='ORDER_COMPENSATION_POSTED' AND x.result_detail=p.id AND x.executed_by=p.approved_by
  JOIN zzsh_order.finance_economic_root r ON r.id=p.root_id AND r.source_kind='ORDER_COMPENSATION' AND r.subject_user_id=p.owner_user_id AND r.source_id=p.id AND r.source_digest=p.payload_digest
  JOIN zzsh_order.finance_event e ON e.id=p.event_id AND e.economic_root_id=r.id AND e.kind='ORDER_COMPENSATION_PAID' AND e.subject_user_id=p.owner_user_id
  JOIN zzsh_order.wallet_revision w ON w.user_id=p.owner_user_id AND w.ledger_revision>=e.expected_ledger_revision+1
  WHERE p.id=case_value AND (SELECT count(*) FROM zzsh_order.finance_event z WHERE z.economic_root_id=r.id)=1
   AND (SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)=2
   AND (SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id
    AND l.details=jsonb_build_object('compensationCaseId',p.id,'approvalRequestId',p.approval_request_id,'orderId',p.order_id,'origin',p.order_origin) AND
    ((l.line_no=1 AND l.account_code='PLATFORM_COMPENSATION_EXPENSE' AND l.debit_cents=p.amount_cents AND l.credit_cents=0 AND l.counterparty_user_id IS NULL)
     OR(l.line_no=2 AND l.account_code='WALLET_AVAILABLE' AND l.debit_cents=0 AND l.credit_cents=p.amount_cents AND l.counterparty_user_id=p.owner_user_id)))=2),false)
$$;
REVOKE ALL ON FUNCTION zzsh_order.order_compensation_posting_complete(text) FROM PUBLIC;
COMMENT ON FUNCTION zzsh_order.order_compensation_posting_complete(text) IS '只读验证赔偿申请、审批、经济根、余额事件和双分录是否完整闭合。';
REVOKE ALL ON FUNCTION zzsh_order.guard_order_compensation_posting(),zzsh_order.protect_order_compensation_approval(),
 zzsh_order.guard_order_compensation_root(),zzsh_order.guard_order_compensation_event(),zzsh_order.guard_order_compensation_entry(),
 zzsh_order.check_order_compensation_batch() FROM PUBLIC;

--> statement-breakpoint
CREATE FUNCTION zzsh_order.post_order_compensation(request_value text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE a zzsh_iam.approval_request;d zzsh_iam.approval_decision;doc jsonb;native zzsh_order.rental_order;legacy zzsh_order.legacy_order_read_snapshot;
 actor_value text:=current_setting('zzsh.actor_id',true);session_value text:=current_setting('zzsh.session_id',true);trace_value text:=current_setting('zzsh.request_id',true);
 boss boolean;owner_value text;renter_value text;game_value text;source_value text;payment_id text;paid_cents text;proof jsonb;
 case_id text;root_id text;event_id text;rev bigint;available numeric;amount_value numeric;entry_details jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin'
  OR COALESCE(length(actor_value),0)=0 OR COALESCE(length(session_value),0)=0 OR COALESCE(length(trace_value),0)=0 OR length(trace_value)>128
 THEN RAISE EXCEPTION 'compensation session unavailable' USING ERRCODE='42501';END IF;
 SELECT sec.is_boss INTO boss FROM zzsh_iam.admin_security sec JOIN zzsh_auth_admin."user" u ON u.id=sec.admin_user_id
  JOIN zzsh_auth_admin."session" s ON s."userId"=u.id AND s.id=session_value
  WHERE sec.admin_user_id=actor_value AND sec.status='ACTIVE' AND NOT sec.password_change_required AND NOT u.suspended
   AND u."twoFactorEnabled" IS TRUE AND NOT s.locked AND s."expiresAt">clock_timestamp() FOR SHARE OF sec,u,s;
 IF boss IS NULL THEN RAISE EXCEPTION 'compensation actor unavailable' USING ERRCODE='42501';END IF;
 SELECT * INTO a FROM zzsh_iam.approval_request WHERE id=request_value FOR UPDATE;
 SELECT * INTO d FROM zzsh_iam.approval_decision WHERE request_id=request_value;
 doc:=a.operation_payload;
 IF a.id IS NULL OR a.operation_code<>'order.compensation.grant' OR a.payload_version<>1 OR a.status<>'APPROVED'
  OR a.expires_at<=clock_timestamp() OR a.decided_by IS DISTINCT FROM actor_value OR d.decision<>'APPROVED' OR d.approver_admin_id IS DISTINCT FROM actor_value
  OR jsonb_typeof(doc)<>'object' OR (SELECT count(*) FROM jsonb_object_keys(doc))<>10
  OR NOT(doc ?& ARRAY['schema','orderId','origin','gameId','ownerUserId','sourceDigest','amountCents','caseRef','reason','evidenceRef'])
  OR EXISTS(SELECT 1 FROM jsonb_each(doc) field WHERE jsonb_typeof(field.value)<>'string') OR doc->>'schema'<>'order-compensation.v1'
  OR encode(sha256(convert_to(zzsh_order.canonical_finance_json(doc),'UTF8')),'hex') IS DISTINCT FROM a.operation_payload_hash
  OR doc->>'origin' NOT IN('NATIVE','LEGACY') OR COALESCE(doc->>'orderId','')!~'^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
  OR COALESCE(doc->>'amountCents','')!~'^[1-9][0-9]{0,15}$' OR COALESCE(doc->>'sourceDigest','')!~'^[a-f0-9]{64}$'
  OR length(trim(COALESCE(doc->>'caseRef',''))) NOT BETWEEN 3 AND 120 OR length(trim(COALESCE(doc->>'reason',''))) NOT BETWEEN 3 AND 500
  OR length(trim(COALESCE(doc->>'evidenceRef',''))) NOT BETWEEN 3 AND 200 OR doc->>'caseRef' IS DISTINCT FROM trim(doc->>'caseRef')
  OR doc->>'reason' IS DISTINCT FROM trim(doc->>'reason') OR doc->>'evidenceRef' IS DISTINCT FROM trim(doc->>'evidenceRef')
  OR ((doc->>'caseRef')||(doc->>'reason')||(doc->>'evidenceRef'))~'[[:cntrl:]]'
  OR NOT EXISTS(SELECT 1 FROM zzsh_iam.approval_request_candidate WHERE request_id=a.id AND admin_user_id=actor_value)
  OR NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE action='approval.request.approved' AND object_type='approval_request' AND object_id=a.id
   AND actor_type='admin' AND actor_id=actor_value AND session_id=session_value AND request_id=trace_value AND outcome='SUCCESS')
 THEN RAISE EXCEPTION 'compensation approval unavailable' USING ERRCODE='23514';END IF;
 IF NOT boss AND (EXISTS(SELECT 1 FROM (VALUES('approval.request.approve'),('order.compensation.approve')) required(code)
  WHERE EXISTS(SELECT 1 FROM zzsh_iam.admin_user_permission deny WHERE deny.admin_user_id=actor_value AND deny.permission_code=required.code AND deny.effect='DENY')
   OR NOT(EXISTS(SELECT 1 FROM zzsh_iam.admin_user_permission allow WHERE allow.admin_user_id=actor_value AND allow.permission_code=required.code AND allow.effect='ALLOW')
    OR EXISTS(SELECT 1 FROM zzsh_iam.admin_user_role ur JOIN zzsh_iam.admin_role role ON role.id=ur.role_id AND role.status='ACTIVE'
     JOIN zzsh_iam.admin_role_permission rp ON rp.role_id=role.id WHERE ur.admin_user_id=actor_value AND rp.permission_code=required.code)))
  OR NOT EXISTS(SELECT 1 FROM zzsh_iam.admin_security sec WHERE sec.admin_user_id=actor_value AND (sec.game_scope_mode='ALL_GAMES'
   OR EXISTS(SELECT 1 FROM zzsh_supply.admin_supply_scope scope WHERE scope.admin_user_id=actor_value AND scope.game_id=doc->>'gameId'))))
 THEN RAISE EXCEPTION 'compensation approval permission unavailable' USING ERRCODE='42501';END IF;
 IF doc->>'origin'='NATIVE' THEN
  SELECT * INTO native FROM zzsh_order.rental_order WHERE id=doc->>'orderId';owner_value:=native.owner_user_id;renter_value:=native.renter_user_id;
 ELSE SELECT * INTO legacy FROM zzsh_order.legacy_order_read_snapshot WHERE id=doc->>'orderId';owner_value:=legacy.owner_user_id;renter_value:=legacy.renter_user_id;END IF;
 IF owner_value IS NULL OR renter_value IS NULL THEN RAISE EXCEPTION 'compensation order unavailable' USING ERRCODE='23514';END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id IN(owner_value,renter_value) ORDER BY id COLLATE "C" FOR UPDATE;
 IF doc->>'origin'='NATIVE' THEN
  SELECT * INTO native FROM zzsh_order.rental_order WHERE id=doc->>'orderId' FOR SHARE;
  SELECT c.id,c.amount_cents::text INTO payment_id,paid_cents FROM zzsh_order.payment_confirmation c WHERE c.id=native.paid_confirmation_id AND c.order_id=native.id AND c.disposition='APPLIED' AND c.currency='CNY' AND c.amount_cents=native.rental_amount_cents+native.deposit_amount_cents;
  game_value:=native.game_id;
  IF native.owner_user_id IS DISTINCT FROM owner_value OR native.renter_user_id IS DISTINCT FROM renter_value OR payment_id IS NULL OR paid_cents!~'^[1-9][0-9]{0,15}$'
   OR native.quote_snapshot#>>'{personal,fullPayoutDeclaration,schema}'<>'full-payout-declaration-v1'
   OR native.quote_snapshot#>'{personal,fullPayoutDeclaration,selected}' IS DISTINCT FROM 'true'::jsonb
   OR native.quote_snapshot#>>'{personal,ownerUserId}' IS DISTINCT FROM native.owner_user_id OR native.quote_snapshot#>>'{personal,userId}' IS DISTINCT FROM native.renter_user_id
   OR native.quote_snapshot#>>'{personal,accountId}' IS DISTINCT FROM native.account_id OR native.quote_snapshot#>>'{personal,listingVersionId}' IS DISTINCT FROM native.listing_version_id
   OR native.quote_snapshot#>>'{personal,listingHash}' IS DISTINCT FROM native.content_hash OR native.quote_snapshot->>'listingHash' IS DISTINCT FROM native.content_hash
   OR native.quote_snapshot#>>'{personal,ruleRefs,releaseId}' IS DISTINCT FROM native.rule_release_id
   OR COALESCE(native.quote_snapshot->>'confirmationDigest','')!~'^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'compensation native source unavailable' USING ERRCODE='23514';END IF;
  proof:=jsonb_build_object('origin','NATIVE','orderId',native.id,'gameId',game_value,'ownerUserId',owner_value,'paymentId',payment_id,'paidCents',paid_cents,'confirmationDigest',native.quote_snapshot->>'confirmationDigest');
 ELSE
  SELECT * INTO legacy FROM zzsh_order.legacy_order_read_snapshot WHERE id=doc->>'orderId' FOR SHARE;game_value:=legacy.game_id;
  IF legacy.owner_user_id IS DISTINCT FROM owner_value OR legacy.renter_user_id IS DISTINCT FROM renter_value OR legacy.source_pay_status<>1
   OR legacy.source_snapshot->>'pay_is' IS DISTINCT FROM '1' OR legacy.source_snapshot->>'sale_user_id' IS DISTINCT FROM legacy.legacy_owner_id
   OR encode(sha256(convert_to(zzsh_order.canonical_finance_json(legacy.source_snapshot),'UTF8')),'hex') IS DISTINCT FROM legacy.source_digest
  THEN RAISE EXCEPTION 'compensation legacy source unavailable' USING ERRCODE='23514';END IF;
  proof:=jsonb_build_object('origin','LEGACY','orderId',legacy.id,'gameId',game_value,'ownerUserId',owner_value,'sourceDigest',legacy.source_digest);
 END IF;
 source_value:=encode(sha256(convert_to(zzsh_order.canonical_finance_json(proof),'UTF8')),'hex');
 IF owner_value IS DISTINCT FROM doc->>'ownerUserId' OR game_value IS DISTINCT FROM doc->>'gameId' OR source_value IS DISTINCT FROM doc->>'sourceDigest'
 THEN RAISE EXCEPTION 'compensation source changed' USING ERRCODE='23514';END IF;
 SELECT ledger_revision INTO rev FROM zzsh_order.wallet_revision WHERE user_id=owner_value FOR UPDATE;
 SELECT coalesce(sum(credit_cents-debit_cents),0) INTO available FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=owner_value AND account_code IN('OWNER_AVAILABLE','WALLET_AVAILABLE');
 IF rev IS NULL OR available<0 OR NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage WHERE user_id=owner_value) THEN RAISE EXCEPTION 'compensation wallet unavailable' USING ERRCODE='23514';END IF;
 amount_value:=(doc->>'amountCents')::numeric;case_id:='comp_'||substr(encode(sha256(convert_to(a.id,'UTF8')),'hex'),1,40);root_id:='comp_root_'||substr(encode(sha256(convert_to(a.id,'UTF8')),'hex'),1,40);event_id:='comp_event_'||substr(encode(sha256(convert_to(a.id,'UTF8')),'hex'),1,40);
 INSERT INTO zzsh_order.order_compensation_posting(id,approval_request_id,order_origin,order_id,game_id,owner_user_id,source_digest,amount_cents,case_ref,reason,evidence_ref,requested_by,approved_by,root_id,event_id,payload_digest)
  VALUES(case_id,a.id,doc->>'origin',doc->>'orderId',game_value,owner_value,source_value,amount_value,doc->>'caseRef',doc->>'reason',doc->>'evidenceRef',a.requested_by,actor_value,root_id,event_id,a.operation_payload_hash);
 INSERT INTO zzsh_order.finance_economic_root(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,policy_version,source_digest)
  VALUES(root_id,NULL,'ORDER_COMPENSATION','NATIVE','zzsh','order_compensation',case_id,owner_value,'OWNER','order-compensation-v1',a.operation_payload_hash);
 INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision) VALUES(event_id,root_id,'ORDER_COMPENSATION_PAID',owner_value,rev);
 entry_details:=jsonb_build_object('compensationCaseId',case_id,'approvalRequestId',a.id,'orderId',doc->>'orderId','origin',doc->>'origin');
 INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
 VALUES(case_id||'_1',event_id,1,'PLATFORM_COMPENSATION_EXPENSE',amount_value,0,NULL,entry_details),
       (case_id||'_2',event_id,2,'WALLET_AVAILABLE',0,amount_value,owner_value,entry_details);
 INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,reason,occurred_at,details)
 VALUES('audit_'||replace(gen_random_uuid()::text,'-',''),'admin',actor_value,session_value,'order.compensation.posted','order_compensation',case_id,'SUCCESS',trace_value,doc->>'reason',clock_timestamp(),entry_details||jsonb_build_object('ownerUserId',owner_value,'amountCents',amount_value::text,'sourceDigest',source_value));
 RETURN jsonb_build_object('caseId',case_id,'eventId',event_id);
END $$;
REVOKE ALL ON FUNCTION zzsh_order.post_order_compensation(text) FROM PUBLIC;
COMMENT ON FUNCTION zzsh_order.post_order_compensation(text) IS '经订单范围和运营审批校验，在审批事务中将包赔赔款记入号主余额。';
