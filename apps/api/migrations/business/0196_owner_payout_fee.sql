-- New special cancellations use owner gross income; existing cancellation records remain unchanged.
ALTER TABLE zzsh_order.support_poststart_cancellation
 ADD COLUMN owner_gross_cents numeric(24,0),
 ADD COLUMN full_payout_fee_cents numeric(24,0),
 ADD COLUMN full_payout_selected boolean,
 ADD CONSTRAINT support_poststart_owner_fee_shape CHECK (
  (owner_gross_cents IS NULL AND full_payout_fee_cents IS NULL AND full_payout_selected IS NULL)
  OR (owner_gross_cents IS NOT NULL AND full_payout_fee_cents IS NOT NULL
   AND owner_gross_cents>=0 AND full_payout_fee_cents>=0 AND refund_cents+owner_gross_cents<=paid_cents
   AND owner_cents=owner_gross_cents-full_payout_fee_cents AND platform_cents>=full_payout_fee_cents
   AND CASE WHEN full_payout_selected IS TRUE THEN full_payout_fee_cents=round(owner_gross_cents*8/100)
    WHEN full_payout_selected IS FALSE THEN full_payout_fee_cents=0
    ELSE owner_gross_cents=0 AND full_payout_fee_cents=0 END)
 );
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.owner_gross_cents IS '客服确认的号主扣包赔费前收入，单位分；历史记录为空';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.full_payout_fee_cents IS '从号主收入扣除的全额包赔费，单位分；历史记录为空';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.full_payout_selected IS '订单冻结的全额包赔选择；未记录且号主收入为零时为空';
COMMENT ON CONSTRAINT support_poststart_owner_fee_shape ON zzsh_order.support_poststart_cancellation IS '约束特殊取消的号主毛额、包赔费、入账额及原款分配';

CREATE FUNCTION zzsh_order.poststart_full_payout_selected(quote_value jsonb,renter_value text,owner_value text,account_value text,listing_value text,hash_value text,release_value text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE
  WHEN quote_value#>>'{personal,userId}' IS DISTINCT FROM renter_value
   OR quote_value#>>'{personal,listingHash}' IS DISTINCT FROM hash_value
   OR quote_value#>>'{personal,ruleRefs,releaseId}' IS DISTINCT FROM release_value
   OR quote_value->>'ruleReleaseId' IS DISTINCT FROM release_value THEN NULL
  WHEN quote_value#>>'{personal,schema}'='personal-quote-v1'
   AND quote_value#>'{personal,funding,fullPayoutSelected}'='false'::jsonb
   AND quote_value#>>'{personal,funding,fullPayoutFeeCents}'='0'
   AND NOT ((quote_value->'personal') ? 'fullPayoutDeclaration') THEN false
  WHEN quote_value#>>'{personal,schema}' IN('personal-quote-v2','personal-quote-v3','personal-quote-v4')
   AND quote_value#>>'{personal,ownerUserId}'=owner_value
   AND quote_value#>>'{personal,accountId}'=account_value
   AND quote_value#>>'{personal,listingVersionId}'=listing_value
   AND quote_value#>>'{personal,fullPayoutDeclaration,schema}'='full-payout-declaration-v1'
   AND jsonb_typeof(quote_value#>'{personal,fullPayoutDeclaration,selected}')='boolean'
   AND NOT ((quote_value#>'{personal,funding}') ? 'fullPayoutSelected')
   AND NOT ((quote_value#>'{personal,funding}') ? 'fullPayoutFeeCents')
   AND length(btrim(coalesce(quote_value#>>'{personal,funding,fullPayoutPolicyVersion}','')))>0
   AND length(btrim(coalesce(quote_value#>>'{personal,funding,disclosureVersion}','')))>0
  THEN (quote_value#>>'{personal,fullPayoutDeclaration,selected}')::boolean
  ELSE NULL END
$$;
COMMENT ON FUNCTION zzsh_order.poststart_full_payout_selected(jsonb,text,text,text,text,text,text) IS '从订单冻结报价读取包赔选择；无法核实时返回空';

DO $extend$
DECLARE expression text;
BEGIN
 SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint
  WHERE conrelid='zzsh_order.settlement_ledger_entry'::regclass AND conname='settlement_ledger_accounts';
 IF expression IS NULL OR position('PLATFORM_CANCELLATION_CONTRIBUTION' IN expression)=0 THEN
  RAISE EXCEPTION 'poststart cancellation ledger contract missing';
 END IF;
 ALTER TABLE zzsh_order.settlement_ledger_entry DROP CONSTRAINT settlement_ledger_accounts;
 EXECUTE format('ALTER TABLE zzsh_order.settlement_ledger_entry ADD CONSTRAINT settlement_ledger_accounts CHECK((%s) OR (finance_event_id IS NOT NULL AND account_code=''PLATFORM_COMPENSATION_FEE'' AND details ? ''supportCancellationId''))',expression);
END $extend$;
COMMENT ON CONSTRAINT settlement_ledger_accounts ON zzsh_order.settlement_ledger_entry IS '限定各类资金事件可使用的账务科目；客服特殊取消可单列包赔费';

CREATE OR REPLACE FUNCTION zzsh_order.guard_support_poststart_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o zzsh_order.rental_order;c zzsh_order.payment_confirmation;expected text;
BEGIN
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=NEW.order_id FOR UPDATE;
 SELECT * INTO c FROM zzsh_order.payment_confirmation WHERE id=NEW.payment_confirmation_id AND order_id=NEW.order_id;
 expected:=encode(sha256(convert_to(jsonb_build_array(NEW.order_id,NEW.payment_confirmation_id,NEW.owner_user_id,NEW.renter_user_id,
  NEW.paid_cents::text,NEW.refund_cents::text,NEW.owner_cents::text,NEW.platform_cents::text,NEW.reason,NEW.owner_gross_cents::text,NEW.full_payout_fee_cents::text,NEW.full_payout_selected)::text,'UTF8')),'hex');
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
  OR NEW.owner_gross_cents IS NULL OR NEW.full_payout_fee_cents IS NULL
  OR NEW.full_payout_selected IS DISTINCT FROM zzsh_order.poststart_full_payout_selected(o.quote_snapshot,o.renter_user_id,o.owner_user_id,o.account_id,o.listing_version_id,o.content_hash,o.rule_release_id)
  OR (NEW.full_payout_selected IS NULL AND NEW.owner_gross_cents<>0)
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

CREATE OR REPLACE FUNCTION zzsh_order.guard_support_poststart_entry() RETURNS trigger LANGUAGE plpgsql AS $$
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
   OR(p.platform_cents>coalesce(p.full_payout_fee_cents,0) AND NEW.line_no=2+(p.refund_cents>0)::integer+(p.owner_cents>0)::integer
      AND NEW.account_code='PLATFORM_CANCELLATION_CONTRIBUTION' AND NEW.debit_cents=0 AND NEW.credit_cents=p.platform_cents-coalesce(p.full_payout_fee_cents,0)
      AND NEW.counterparty_user_id IS NULL AND NEW.source_payment_confirmation_id IS NULL)
   OR(coalesce(p.full_payout_fee_cents,0)>0 AND NEW.line_no=2+(p.refund_cents>0)::integer+(p.owner_cents>0)::integer
      +(p.platform_cents>p.full_payout_fee_cents)::integer
      AND NEW.account_code='PLATFORM_COMPENSATION_FEE' AND NEW.debit_cents=0 AND NEW.credit_cents=p.full_payout_fee_cents
      AND NEW.counterparty_user_id IS NULL AND NEW.source_payment_confirmation_id IS NULL))
 THEN RAISE EXCEPTION 'poststart cancellation entry differs' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.support_poststart_cancellation_complete(case_value text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
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
      =1+(p.refund_cents>0)::integer+(p.owner_cents>0)::integer+(p.platform_cents>coalesce(p.full_payout_fee_cents,0))::integer+(coalesce(p.full_payout_fee_cents,0)>0)::integer
   AND (SELECT coalesce(sum(debit_cents),0) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)=p.paid_cents
   AND (SELECT coalesce(sum(credit_cents),0) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)=p.paid_cents
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_posting s WHERE s.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_referral_earning d WHERE d.order_id=o.id AND d.amount_cents>0 AND d.state<>'REVOKED')
   AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.support_poststart_cancel' AND a.object_type='support_poststart_cancellation'
    AND a.object_id=p.id AND a.outcome='SUCCESS' AND a.actor_type='admin' AND a.actor_id=p.admin_user_id
    AND a.session_id=p.admin_session_id AND a.request_id=p.request_id AND a.reason=p.reason
    AND a.details->>'sourceDigest'=p.source_digest)),false)
$$;

CREATE OR REPLACE FUNCTION zzsh_order.cancel_order_after_start_v2(order_value text,expected_revision bigint,refund_value numeric,owner_gross_value numeric,reason_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor_value text:=current_setting('zzsh.actor_id',true);session_value text:=current_setting('zzsh.session_id',true);
 request_value text:=current_setting('zzsh.request_id',true);boss boolean;o zzsh_order.rental_order;c zzsh_order.payment_confirmation;
 owner_id text;renter_id text;game_value text;account_value text;case_id text;root_value text;event_value text;digest_value text;
 platform_value numeric;owner_value numeric;fee_value numeric;full_payout boolean;revision_value bigint;line_value integer:=1;details_value jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin'
  OR coalesce(actor_value,'')='' OR coalesce(session_value,'')='' OR coalesce(request_value,'')=''
  OR order_value IS NULL OR order_value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR expected_revision IS NULL OR expected_revision<1
  OR refund_value IS NULL OR owner_gross_value IS NULL OR refund_value<>trunc(refund_value) OR owner_gross_value<>trunc(owner_gross_value)
  OR refund_value<0 OR owner_gross_value<0 OR refund_value>9999999999999999 OR owner_gross_value>9999999999999999
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
  OR refund_value+owner_gross_value>c.amount_cents
 THEN RAISE EXCEPTION 'poststart cancellation amount or order changed' USING ERRCODE='23514';END IF;

 full_payout:=zzsh_order.poststart_full_payout_selected(o.quote_snapshot,o.renter_user_id,o.owner_user_id,o.account_id,o.listing_version_id,o.content_hash,o.rule_release_id);
 IF full_payout IS NULL AND owner_gross_value>0 THEN
  RAISE EXCEPTION 'poststart full payout selection unknown' USING ERRCODE='23514';
 END IF;
 fee_value:=CASE WHEN full_payout IS TRUE THEN round(owner_gross_value*8/100) ELSE 0 END;
 owner_value:=owner_gross_value-fee_value;
 platform_value:=c.amount_cents-refund_value-owner_value;
 case_id:='spcancel_'||substr(encode(sha256(convert_to(o.id,'UTF8')),'hex'),1,40);
 root_value:='spcancel_root_'||substr(encode(sha256(convert_to(o.id,'UTF8')),'hex'),1,40);
 event_value:='spcancel_event_'||substr(encode(sha256(convert_to(o.id,'UTF8')),'hex'),1,40);
 digest_value:=encode(sha256(convert_to(jsonb_build_array(o.id,c.id,owner_id,renter_id,c.amount_cents::text,
  refund_value::text,owner_value::text,platform_value::text,reason_value,owner_gross_value::text,fee_value::text,full_payout)::text,'UTF8')),'hex');
 INSERT INTO zzsh_order.support_poststart_cancellation(id,order_id,payment_confirmation_id,owner_user_id,renter_user_id,
  admin_user_id,admin_session_id,request_id,reason,paid_cents,refund_cents,owner_cents,platform_cents,source_digest,root_id,event_id,owner_gross_cents,full_payout_fee_cents,full_payout_selected)
 VALUES(case_id,o.id,c.id,owner_id,renter_id,actor_value,session_value,request_value,reason_value,c.amount_cents,refund_value,owner_value,platform_value,digest_value,root_value,event_value,owner_gross_value,fee_value,full_payout);
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
 IF platform_value>fee_value THEN line_value:=line_value+1;
  INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
  VALUES(event_value||'_'||line_value,event_value,line_value,'PLATFORM_CANCELLATION_CONTRIBUTION',0,platform_value-fee_value,NULL,details_value);END IF;
 IF fee_value>0 THEN line_value:=line_value+1;
  INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
  VALUES(event_value||'_'||line_value,event_value,line_value,'PLATFORM_COMPENSATION_FEE',0,fee_value,NULL,details_value);END IF;
 UPDATE zzsh_order.rental_order SET status='CANCELLED',cancel_reason='SUPPORT_AFTER_START_CANCELLED',cancelled_at=clock_timestamp(),
  revision=revision+1,updated_at=clock_timestamp() WHERE id=o.id AND status='PAID' AND revision=expected_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'poststart cancellation order changed' USING ERRCODE='40001';END IF;
 INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,reason,occurred_at,details)
 VALUES('audit_'||substr(encode(sha256(convert_to(case_id||request_value,'UTF8')),'hex'),1,40),'admin',actor_value,session_value,
  'order.support_poststart_cancel','support_poststart_cancellation',case_id,'SUCCESS',request_value,reason_value,clock_timestamp(),
  jsonb_build_object('orderId',o.id,'paymentConfirmationId',c.id,'paidCents',c.amount_cents::text,'refundCents',refund_value::text,
   'ownerCents',owner_value::text,'ownerGrossCents',owner_gross_value::text,'fullPayoutFeeCents',fee_value::text,'fullPayoutSelected',full_payout,'platformCents',platform_value::text,'sourceDigest',digest_value,'channelResult','NOT_SUBMITTED'));
 RETURN jsonb_build_object('caseId',case_id,'orderId',o.id,'status','CANCELLED','paidCents',c.amount_cents::text,'refundCents',refund_value::text,
  'ownerCents',owner_value::text,'ownerGrossCents',owner_gross_value::text,'fullPayoutFeeCents',fee_value::text,'fullPayoutSelected',full_payout,'platformContributionCents',platform_value::text,'commissionCents','0','channelResult','NOT_SUBMITTED');
END $$;


COMMENT ON FUNCTION zzsh_order.cancel_order_after_start_v2(text,bigint,numeric,numeric,text) IS '客服特殊取消：按号主毛收入扣包赔费并记录退款责任';
REVOKE ALL ON FUNCTION zzsh_order.cancel_order_after_start_v2(text,bigint,numeric,numeric,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_order.cancel_order_after_start(text,bigint,numeric,numeric,text) FROM PUBLIC;
DO $revoke$
DECLARE role_name text;
BEGIN
 FOR role_name IN
  SELECT DISTINCT pg_get_userbyid(a.grantee) FROM pg_proc p,
   LATERAL aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a
  WHERE p.oid='zzsh_order.cancel_order_after_start(text,bigint,numeric,numeric,text)'::regprocedure
   AND a.grantee<>0 AND a.grantee<>p.proowner AND a.privilege_type='EXECUTE'
 LOOP EXECUTE format('REVOKE EXECUTE ON FUNCTION zzsh_order.cancel_order_after_start(text,bigint,numeric,numeric,text) FROM %I',role_name); END LOOP;
END $revoke$;

-- A legacy cancellation records gross and fee in the immutable continuation evidence.
DO $legacy$
DECLARE f text;needle text;updated text;
BEGIN
 SELECT pg_get_functiondef(to_regprocedure('zzsh_order.check_legacy_continuation_result()')) INTO f;
 needle:='r.facts#>>''{evidence,source,saleEarnings}''=NEW.amounts->>''ownerNet''';
 IF position(needle IN f)=0 THEN RAISE EXCEPTION 'legacy cancellation owner guard differs'; END IF;
 updated:=replace(f,needle,$guard$
  COALESCE(NEW.amounts->>'ownerGross','')~'^(0|[1-9][0-9]{0,13})\.[0-9]{2}$'
  AND COALESCE(NEW.amounts->>'fullPayoutMoney','')~'^(0|[1-9][0-9]{0,13})\.[0-9]{2}$'
  AND r.facts#>>'{evidence,source,saleEarnings}'=NEW.amounts->>'ownerGross'
  AND (NEW.amounts->>'ownerGross')::numeric=(NEW.amounts->>'ownerNet')::numeric+(NEW.amounts->>'fullPayoutMoney')::numeric
  AND ((NEW.amounts->>'refundNet')::numeric+(NEW.amounts->>'ownerGross')::numeric)*100<=l.recorded_paid_amount_cents
  AND CASE
   WHEN i.facts#>>'{evidence,source,isFullPayout}'='1' THEN (NEW.amounts->>'fullPayoutMoney')::numeric=round((NEW.amounts->>'ownerGross')::numeric*8/100,2)
   WHEN i.facts#>>'{evidence,source,isFullPayout}'='0' THEN (NEW.amounts->>'fullPayoutMoney')::numeric=0
   ELSE (NEW.amounts->>'ownerGross')::numeric=0 AND (NEW.amounts->>'fullPayoutMoney')::numeric=0 END
 $guard$);
 IF updated=f THEN RAISE EXCEPTION 'legacy cancellation owner guard not installed'; END IF;
 f:=updated;
 needle:='(r.facts#>>''{evidence,source,fullPayoutMoney}'')::numeric=0';
 IF position(needle IN f)=0 THEN RAISE EXCEPTION 'legacy cancellation fee guard differs'; END IF;
 updated:=replace(f,needle,'r.facts#>>''{evidence,source,fullPayoutMoney}''=NEW.amounts->>''fullPayoutMoney''');
 IF updated=f THEN RAISE EXCEPTION 'legacy cancellation fee guard not installed'; END IF;
 EXECUTE updated;
END $legacy$;


-- Preserve the system baseline while verifying the manually agreed gross, fee and net.
CREATE OR REPLACE FUNCTION zzsh_order.check_settlement_posting_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_posting_id text;
  batch record;
  ord record;
  ver record;
  payment record;
  approval record;
  sums record;
  snapshot_captured numeric;
  snapshot_system_owner numeric;
  snapshot_system_refund numeric;
  snapshot_platform numeric;
  snapshot_fee numeric;
  applied_fee numeric;
  manual_gross numeric;
  payout_selected boolean;
  snapshot_haff numeric;
  snapshot_item numeric;
  snapshot_early numeric;
  expected_owner numeric;
  expected_refund numeric;
  expected_platform numeric;
  expected_adjustment numeric;
BEGIN
  IF TG_TABLE_NAME = 'settlement_posting' THEN
    v_posting_id := NEW.id;
  ELSE
    v_posting_id := NEW.posting_id;
  END IF;
  SELECT * INTO batch FROM zzsh_order.settlement_posting WHERE id = v_posting_id;
  IF batch IS NULL THEN RETURN NULL; END IF;
  SELECT status, paid_confirmation_id, renter_user_id, owner_user_id, quote_snapshot, account_id, listing_version_id, content_hash, rule_release_id INTO ord
    FROM zzsh_order.rental_order WHERE id = batch.order_id;
  SELECT kind, early, version_hash, superseded_at, approval_request_id, input_snapshot INTO ver
    FROM zzsh_order.settlement_version WHERE id = batch.settlement_version_id AND order_id = batch.order_id;
  SELECT order_id, amount_cents, currency, disposition INTO payment
    FROM zzsh_order.payment_confirmation WHERE id = batch.payment_confirmation_id;
  IF ord IS NULL OR ord.status IS DISTINCT FROM 'COMPLETED' OR ord.paid_confirmation_id IS DISTINCT FROM batch.payment_confirmation_id
     OR ver IS NULL OR ver.superseded_at IS NOT NULL OR ver.version_hash IS DISTINCT FROM batch.version_hash
     OR ver.early IS DISTINCT FROM batch.early OR payment IS NULL OR payment.order_id IS DISTINCT FROM batch.order_id
     OR payment.disposition <> 'APPLIED' OR payment.currency <> 'CNY' OR payment.amount_cents <> batch.captured_cents THEN
    RAISE EXCEPTION 'posting header is not bound to a completed order and its applied payment' USING ERRCODE = '23514';
  END IF;
  IF ver.input_snapshot IS NULL OR ver.input_snapshot->>'kind' IS DISTINCT FROM ver.kind
     OR ver.input_snapshot->>'early' IS DISTINCT FROM batch.early::text THEN
    RAISE EXCEPTION 'posting header is not bound to its settlement snapshot' USING ERRCODE = '23514';
  END IF;
  -- Authorized support can finalize only the exact system version, with matching audit evidence.
  IF NOT EXISTS (
    SELECT 1 FROM zzsh_order.settlement_decision d
    JOIN zzsh_iam.audit_event a ON a.actor_type='admin' AND a.actor_id=d.subject_id
      AND a.action='order.settlement.support_finalized' AND a.object_type='rental_order'
      AND a.object_id=batch.order_id AND a.outcome='SUCCESS'
      AND a.details->>'settlementVersionId'=batch.settlement_version_id
      AND a.details->>'versionHash'=batch.version_hash AND a.details->>'reason'=d.reason
    JOIN zzsh_auth_admin."user" u ON u.id=d.subject_id AND NOT u.suspended
    WHERE d.settlement_version_id=batch.settlement_version_id AND d.party='SUPPORT'
      AND d.action='FINALIZE' AND d.version_hash=batch.version_hash AND ver.kind='SYSTEM'
      AND length(btrim(d.reason)) BETWEEN 3 AND 500
  ) THEN
  IF (SELECT count(*) FROM zzsh_order.settlement_decision
       WHERE settlement_version_id = batch.settlement_version_id AND party = 'RENTER'
         AND action = 'CONFIRM' AND subject_id = ord.renter_user_id AND version_hash = batch.version_hash) <> 1
     OR (SELECT count(*) FROM zzsh_order.settlement_decision
       WHERE settlement_version_id = batch.settlement_version_id AND party = 'OWNER'
         AND action = 'CONFIRM' AND subject_id = ord.owner_user_id AND version_hash = batch.version_hash) <> 1
     OR EXISTS (SELECT 1 FROM zzsh_order.settlement_decision
       WHERE settlement_version_id = batch.settlement_version_id AND party IN ('RENTER','OWNER') AND action = 'REJECT') THEN
    RAISE EXCEPTION 'posting requires both parties to confirm the same version' USING ERRCODE = '23514';
  END IF;
  IF batch.early AND NOT EXISTS (SELECT 1 FROM zzsh_order.settlement_decision
       WHERE settlement_version_id = batch.settlement_version_id AND party = 'SUPPORT' AND action = 'REVIEW'
         AND version_hash = batch.version_hash) THEN
    RAISE EXCEPTION 'early posting requires support review' USING ERRCODE = '23514';
  END IF;
  END IF;
  IF ver.kind = 'MANUAL_ADJUSTMENT' THEN
    SELECT status, requested_by, decided_by, operation_payload_hash, expires_at INTO approval
      FROM zzsh_iam.approval_request WHERE id = batch.approval_request_id;
    IF approval IS NULL OR approval.status <> 'APPROVED' OR approval.decided_by IS NULL
       OR approval.operation_payload_hash <> batch.version_hash
       OR approval.expires_at <= batch.posted_at OR batch.approval_request_id IS DISTINCT FROM ver.approval_request_id
       OR batch.approval_requested_by IS DISTINCT FROM approval.requested_by
       OR batch.approval_approved_by IS DISTINCT FROM approval.decided_by
       OR batch.approval_expires_at IS DISTINCT FROM approval.expires_at
       OR batch.approval_payload_hash IS DISTINCT FROM approval.operation_payload_hash
       OR batch.manual_reason IS DISTINCT FROM ver.input_snapshot->>'reason' THEN
      RAISE EXCEPTION 'posting requires the current valid manual approval' USING ERRCODE = '23514';
    END IF;
  ELSIF batch.approval_request_id IS NOT NULL OR batch.manual_reason IS NOT NULL THEN
    RAISE EXCEPTION 'system settlement cannot bind a manual approval' USING ERRCODE = '23514';
  END IF;

  snapshot_captured := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'capturedAmount');
  snapshot_system_owner := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,ownerNet}');
  snapshot_system_refund := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,renterRefund}');
  snapshot_platform := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,platformContribution}');
  snapshot_fee := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,feeAmount}');
  applied_fee := snapshot_fee;
  snapshot_haff := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,haffSpread}');
  snapshot_item := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,itemSpread}');
  snapshot_early := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,earlyMakeup}');
  IF ver.kind = 'MANUAL_ADJUSTMENT' THEN
    expected_owner := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedOwnerNet');
    expected_refund := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedRenterRefund');
    IF ver.input_snapshot ? 'proposedOwnerGross' THEN
      manual_gross := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedOwnerGross');
      applied_fee := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedFullPayoutFee');
      payout_selected := CASE WHEN jsonb_typeof(ver.input_snapshot->'fullPayoutSelected')='boolean'
        THEN (ver.input_snapshot->>'fullPayoutSelected')::boolean ELSE NULL END;
      IF manual_gross IS NULL OR applied_fee IS NULL OR payout_selected IS NULL
         OR zzsh_order.poststart_full_payout_selected(ord.quote_snapshot,ord.renter_user_id,ord.owner_user_id,ord.account_id,ord.listing_version_id,ord.content_hash,ord.rule_release_id) IS DISTINCT FROM payout_selected
         OR applied_fee<>(CASE WHEN payout_selected THEN round(manual_gross*8/100) ELSE 0 END)
         OR expected_owner IS DISTINCT FROM manual_gross-applied_fee
         OR manual_gross+expected_refund>snapshot_captured THEN
        RAISE EXCEPTION 'manual settlement owner fee differs from the accepted basis' USING ERRCODE='23514';
      END IF;
    ELSIF ver.input_snapshot->>'fullPayoutSelected'='true' THEN
      RAISE EXCEPTION 'manual settlement owner fee requires reconfirmation' USING ERRCODE='23514';
    END IF;
  ELSE
    expected_owner := snapshot_system_owner;
    expected_refund := snapshot_system_refund;
  END IF;
  IF snapshot_captured IS NULL OR snapshot_system_owner IS NULL OR snapshot_system_refund IS NULL OR snapshot_platform IS NULL
     OR snapshot_fee IS NULL OR snapshot_haff IS NULL OR snapshot_item IS NULL OR snapshot_early IS NULL
     OR expected_owner IS NULL OR expected_refund IS NULL THEN
    RAISE EXCEPTION 'settlement amount snapshot is incomplete' USING ERRCODE = '23514';
  END IF;
  expected_adjustment := snapshot_system_owner + snapshot_system_refund - expected_owner - expected_refund - (applied_fee-snapshot_fee);
  expected_platform := snapshot_platform + (applied_fee-snapshot_fee) + expected_adjustment;
  IF batch.captured_cents <> snapshot_captured OR batch.system_owner_net_cents <> snapshot_system_owner
     OR batch.system_renter_refund_cents <> snapshot_system_refund OR batch.owner_net_cents <> expected_owner
     OR batch.renter_refund_cents <> expected_refund OR batch.platform_contribution_cents <> expected_platform
     OR batch.compensation_fee_cents <> applied_fee OR batch.captured_cents <> batch.owner_net_cents + batch.renter_refund_cents + batch.platform_contribution_cents THEN
    RAISE EXCEPTION 'posting header does not match the accepted settlement amounts' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer AS line_count,
         COALESCE(sum(debit_cents),0) AS debit_cents,
         COALESCE(sum(credit_cents),0) AS credit_cents,
         count(*) FILTER (WHERE account_code = 'CAPTURED_PAYMENT_SOURCE') AS source_count,
         COALESCE(sum(debit_cents) FILTER (WHERE account_code = 'CAPTURED_PAYMENT_SOURCE'),0) AS source_debit,
         COALESCE(sum(credit_cents) FILTER (WHERE account_code = 'CAPTURED_PAYMENT_SOURCE'),0) AS source_credit,
         count(*) FILTER (WHERE account_code = 'OWNER_AVAILABLE') AS owner_count,
         COALESCE(sum(credit_cents) FILTER (WHERE account_code = 'OWNER_AVAILABLE'),0) AS owner_cents,
         COALESCE(sum(debit_cents) FILTER (WHERE account_code = 'OWNER_AVAILABLE'),0) AS owner_debits,
         count(*) FILTER (WHERE account_code = 'RENTER_REFUND_PAYABLE') AS refund_count,
         COALESCE(sum(credit_cents) FILTER (WHERE account_code = 'RENTER_REFUND_PAYABLE'),0) AS refund_cents,
         COALESCE(sum(debit_cents) FILTER (WHERE account_code = 'RENTER_REFUND_PAYABLE'),0) AS refund_debits,
         count(*) FILTER (WHERE account_code = 'PLATFORM_HAFF_SPREAD') AS haff_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_HAFF_SPREAD'),0) AS haff_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_ITEM_SPREAD') AS item_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_ITEM_SPREAD'),0) AS item_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_EARLY_MAKEUP') AS early_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_EARLY_MAKEUP'),0) AS early_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_COMPENSATION_FEE') AS fee_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_COMPENSATION_FEE'),0) AS fee_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_MANUAL_NET_ADJUSTMENT') AS adjustment_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_MANUAL_NET_ADJUSTMENT'),0) AS adjustment_cents,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code LIKE 'PLATFORM_%'),0) AS platform_cents
    INTO sums FROM zzsh_order.settlement_ledger_entry AS entry WHERE entry.posting_id = v_posting_id;
  IF sums.line_count < 2 OR sums.debit_cents <> sums.credit_cents OR sums.source_count <> 1
     OR sums.source_debit <> batch.captured_cents OR sums.source_credit <> 0
     OR sums.owner_count <> (CASE WHEN expected_owner = 0 THEN 0 ELSE 1 END) OR sums.owner_cents <> expected_owner OR sums.owner_debits <> 0
     OR sums.refund_count <> (CASE WHEN expected_refund = 0 THEN 0 ELSE 1 END) OR sums.refund_cents <> expected_refund OR sums.refund_debits <> 0
     OR sums.haff_count <> (CASE WHEN snapshot_haff = 0 THEN 0 ELSE 1 END) OR sums.haff_cents <> snapshot_haff
     OR sums.item_count <> (CASE WHEN snapshot_item = 0 THEN 0 ELSE 1 END) OR sums.item_cents <> snapshot_item
     OR sums.early_count <> (CASE WHEN snapshot_early = 0 THEN 0 ELSE 1 END) OR sums.early_cents <> snapshot_early
     OR sums.fee_count <> (CASE WHEN applied_fee = 0 THEN 0 ELSE 1 END) OR sums.fee_cents <> applied_fee
     OR sums.adjustment_count <> (CASE WHEN expected_adjustment = 0 THEN 0 ELSE 1 END) OR sums.adjustment_cents <> expected_adjustment
     OR sums.platform_cents <> expected_platform THEN
    RAISE EXCEPTION 'settlement posting classifications are incomplete or inconsistent' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM zzsh_order.settlement_ledger_entry e WHERE e.posting_id = v_posting_id AND (
       (e.account_code = 'CAPTURED_PAYMENT_SOURCE' AND
         (e.details->>'paymentConfirmationId' IS DISTINCT FROM batch.payment_confirmation_id
          OR e.details->>'disposition' IS DISTINCT FROM 'APPLIED'
          OR e.details->>'fundingSourceRef' IS DISTINCT FROM ver.input_snapshot->>'fundingSourceRef'))
       OR (e.account_code = 'OWNER_AVAILABLE' AND
         (e.details->>'settlementVersionId' IS DISTINCT FROM batch.settlement_version_id
          OR e.details->>'versionHash' IS DISTINCT FROM batch.version_hash
          OR e.details #>> '{systemGross,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,ownerGross}'
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemNet') IS DISTINCT FROM snapshot_system_owner
          OR zzsh_order.settlement_snapshot_cents(e.details->>'postedNet') IS DISTINCT FROM expected_owner
          OR e.details->>'feePayer' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feePayer}'
          OR e.details #>> '{compensationFee,amount}' IS DISTINCT FROM CASE WHEN manual_gross IS NULL THEN ver.input_snapshot #>> '{amounts,feeAmount}' ELSE ver.input_snapshot->>'proposedFullPayoutFee' END))
       OR (e.account_code = 'RENTER_REFUND_PAYABLE' AND
         (e.details->>'settlementVersionId' IS DISTINCT FROM batch.settlement_version_id
          OR e.details->>'versionHash' IS DISTINCT FROM batch.version_hash
          OR e.details->>'dueAt' IS NULL OR (e.details->>'dueAt')::timestamptz IS DISTINCT FROM batch.refund_due_at
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemRefund') IS DISTINCT FROM snapshot_system_refund
          OR e.details #>> '{depositRefund,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,depositRefund}'
          OR e.details #>> '{unusedItemRefund,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,unusedItemRefund}'
          OR e.details #>> '{unusedHaffRefund,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,unusedHaffRefund}'))
       OR (e.account_code = 'PLATFORM_HAFF_SPREAD' AND zzsh_order.settlement_snapshot_cents(e.details #>> '{amount,amount}') IS DISTINCT FROM snapshot_haff)
       OR (e.account_code = 'PLATFORM_ITEM_SPREAD' AND zzsh_order.settlement_snapshot_cents(e.details #>> '{amount,amount}') IS DISTINCT FROM snapshot_item)
       OR (e.account_code = 'PLATFORM_EARLY_MAKEUP' AND
         (zzsh_order.settlement_snapshot_cents(e.details #>> '{amount,amount}') IS DISTINCT FROM snapshot_early
          OR e.details->>'endReason' IS DISTINCT FROM ver.input_snapshot->>'endReason'))
       OR (e.account_code = 'PLATFORM_COMPENSATION_FEE' AND
         (e.details #>> '{base,amount}' IS DISTINCT FROM CASE WHEN manual_gross IS NULL THEN ver.input_snapshot #>> '{amounts,feeBase}' ELSE ver.input_snapshot->>'proposedOwnerGross' END
          OR e.details->>'rate' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feeRate}'
          OR e.details->>'payer' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feePayer}'
          OR e.details->>'policyVersion' IS DISTINCT FROM ver.input_snapshot->>'feePolicyVersion'))
       OR (e.account_code = 'PLATFORM_MANUAL_NET_ADJUSTMENT' AND
         (e.details->>'reason' IS DISTINCT FROM ver.input_snapshot->>'reason'
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemOwnerNet') IS DISTINCT FROM snapshot_system_owner
          OR zzsh_order.settlement_snapshot_cents(e.details->>'postedOwnerNet') IS DISTINCT FROM expected_owner
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemRenterRefund') IS DISTINCT FROM snapshot_system_refund
          OR zzsh_order.settlement_snapshot_cents(e.details->>'postedRenterRefund') IS DISTINCT FROM expected_refund
          OR (manual_gross IS NOT NULL AND (CASE WHEN coalesce(e.details->>'deltaPayoutFee','')~'^-?(0|[1-9][0-9]*)\.[0-9]{2}$'
            THEN (e.details->>'deltaPayoutFee')::numeric*100 ELSE NULL END) IS DISTINCT FROM applied_fee-snapshot_fee)))
     )) THEN
    RAISE EXCEPTION 'settlement posting details do not match the accepted settlement snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;
