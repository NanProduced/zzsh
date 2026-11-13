-- Candidate only: keep fixed-fee cancellation gated until transaction and refund tests pass.
ALTER TABLE zzsh_order.support_poststart_cancellation
  ADD COLUMN platform_service_fee_cents numeric(24,0),
  ADD COLUMN fixed_fee_rate text,
  DROP CONSTRAINT support_poststart_owner_fee_shape,
  ADD CONSTRAINT support_poststart_owner_fee_shape CHECK (
    (platform_service_fee_cents IS NULL AND fixed_fee_rate IS NULL AND (
      (owner_gross_cents IS NULL AND full_payout_fee_cents IS NULL AND full_payout_selected IS NULL)
      OR (owner_gross_cents IS NOT NULL AND full_payout_fee_cents IS NOT NULL
        AND owner_gross_cents>=0 AND full_payout_fee_cents>=0 AND refund_cents+owner_gross_cents<=paid_cents
        AND owner_cents=owner_gross_cents-full_payout_fee_cents AND platform_cents>=full_payout_fee_cents
        AND CASE WHEN full_payout_selected IS TRUE THEN full_payout_fee_cents=round(owner_gross_cents*8/100)
          WHEN full_payout_selected IS FALSE THEN full_payout_fee_cents=0
          ELSE owner_gross_cents=0 AND full_payout_fee_cents=0 END)))
    OR (platform_service_fee_cents IS NOT NULL AND fixed_fee_rate IS NOT NULL AND
      CASE WHEN fixed_fee_rate ~ '^(0|1)(\.[0-9]{1,8})?$' THEN
        fixed_fee_rate::numeric >= 0 AND fixed_fee_rate::numeric < 1
        AND owner_gross_cents IS NOT NULL AND full_payout_fee_cents IS NOT NULL AND full_payout_selected IS NOT NULL
        AND owner_gross_cents>=0 AND full_payout_fee_cents>=0 AND platform_service_fee_cents>=0
        AND platform_service_fee_cents=round(owner_gross_cents*fixed_fee_rate::numeric)
        AND refund_cents+owner_gross_cents<=paid_cents
        AND owner_cents=owner_gross_cents-full_payout_fee_cents-platform_service_fee_cents
        AND platform_cents>=full_payout_fee_cents+platform_service_fee_cents
        AND full_payout_fee_cents=CASE WHEN full_payout_selected THEN round(owner_gross_cents*8/100) ELSE 0 END
      ELSE false END)
  );
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.platform_service_fee_cents IS '固定手续费模式按号主毛收入扣除的平台手续费，单位分；旧记录为空';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.fixed_fee_rate IS '取消订单冻结的固定手续费率；旧记录为空';
COMMENT ON CONSTRAINT support_poststart_owner_fee_shape ON zzsh_order.support_poststart_cancellation IS '按订单原计价模式约束特殊取消毛收入、手续费和入账';

DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint
   WHERE conrelid='zzsh_order.settlement_ledger_entry'::regclass AND conname='settlement_ledger_accounts';
  IF expression IS NULL THEN RAISE EXCEPTION 'settlement ledger account constraint is missing'; END IF;
  ALTER TABLE zzsh_order.settlement_ledger_entry DROP CONSTRAINT settlement_ledger_accounts;
  EXECUTE format('ALTER TABLE zzsh_order.settlement_ledger_entry ADD CONSTRAINT settlement_ledger_accounts CHECK((%s) OR (finance_event_id IS NOT NULL AND account_code=''PLATFORM_SERVICE_FEE'' AND details ? ''supportCancellationId''))',expression);
END $$;

CREATE FUNCTION zzsh_order.fixed_fee_poststart_rate(quote_value jsonb,renter_value text,owner_value text,account_value text,listing_value text,hash_value text,release_value text)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE rate_value text:=quote_value#>>'{settlementPricing,fixedFeeRate}';
BEGIN
 IF quote_value#>>'{personal,schema}' IS DISTINCT FROM 'personal-quote-v5'
   OR quote_value->>'schemaVersion' IS DISTINCT FROM '4' OR quote_value->>'mode' IS DISTINCT FROM 'PERCENT'
   OR quote_value#>>'{pricingInputs,fixedFeeAlgorithm}' IS DISTINCT FROM 'FIXED_TOTAL_V1'
   OR quote_value#>>'{settlementPricing,schema}' IS DISTINCT FROM 'settlement-pricing-v3'
   OR quote_value#>>'{personal,pricingPolicy,pricingModel}' IS DISTINCT FROM 'FIXED_FEE'
   OR quote_value#>>'{personal,pricingPolicy,priceVersionId}' IS DISTINCT FROM quote_value->>'priceVersionId'
   OR quote_value#>>'{settlementPricing,priceVersionId}' IS DISTINCT FROM quote_value->>'priceVersionId'
   OR coalesce(rate_value,'') !~ '^(0|1)(\.[0-9]{1,8})?$'
   OR coalesce(quote_value#>>'{pricingInputs,commissionRate}','') !~ '^(0|1)(\.[0-9]{1,8})?$'
 THEN RETURN NULL; END IF;
 IF rate_value::numeric<0 OR rate_value::numeric>=1 OR rate_value::numeric IS DISTINCT FROM (quote_value#>>'{pricingInputs,commissionRate}')::numeric
   OR zzsh_order.poststart_full_payout_selected(jsonb_set(quote_value,'{personal,schema}',to_jsonb('personal-quote-v4'::text)),renter_value,owner_value,account_value,listing_value,hash_value,release_value) IS NULL
 THEN RETURN NULL; END IF;
 RETURN rate_value;
END $$;
COMMENT ON FUNCTION zzsh_order.fixed_fee_poststart_rate(jsonb,text,text,text,text,text,text) IS '校验订单冻结的固定手续费依据并返回费率；无法核实时返回空';

CREATE OR REPLACE FUNCTION zzsh_order.guard_support_poststart_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o zzsh_order.rental_order;c zzsh_order.payment_confirmation;expected text;rate_value text;selected boolean;is_fixed boolean;
BEGIN
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=NEW.order_id FOR UPDATE;
 SELECT * INTO c FROM zzsh_order.payment_confirmation WHERE id=NEW.payment_confirmation_id AND order_id=NEW.order_id;
 is_fixed:=COALESCE(o.quote_snapshot#>>'{personal,schema}'='personal-quote-v5',false);
 IF is_fixed THEN
  rate_value:=zzsh_order.fixed_fee_poststart_rate(o.quote_snapshot,o.renter_user_id,o.owner_user_id,o.account_id,o.listing_version_id,o.content_hash,o.rule_release_id);
  selected:=zzsh_order.poststart_full_payout_selected(jsonb_set(o.quote_snapshot,'{personal,schema}',to_jsonb('personal-quote-v4'::text)),o.renter_user_id,o.owner_user_id,o.account_id,o.listing_version_id,o.content_hash,o.rule_release_id);
  IF rate_value IS NULL OR selected IS NULL OR NEW.fixed_fee_rate IS DISTINCT FROM rate_value
    OR NEW.platform_service_fee_cents IS NULL OR NEW.platform_service_fee_cents IS DISTINCT FROM round(NEW.owner_gross_cents*rate_value::numeric)
  THEN RAISE EXCEPTION 'poststart fixed fee basis unavailable' USING ERRCODE='23514';END IF;
  expected:=encode(sha256(convert_to(jsonb_build_array(NEW.order_id,NEW.payment_confirmation_id,NEW.owner_user_id,NEW.renter_user_id,
   NEW.paid_cents::text,NEW.refund_cents::text,NEW.owner_cents::text,NEW.platform_cents::text,NEW.reason,NEW.owner_gross_cents::text,
   NEW.full_payout_fee_cents::text,NEW.full_payout_selected,'fixed-fee-v1',NEW.fixed_fee_rate,NEW.platform_service_fee_cents::text)::text,'UTF8')),'hex');
 ELSE
  IF NEW.fixed_fee_rate IS NOT NULL OR NEW.platform_service_fee_cents IS NOT NULL THEN
   RAISE EXCEPTION 'legacy cancellation cannot use fixed fee fields' USING ERRCODE='23514';END IF;
  selected:=zzsh_order.poststart_full_payout_selected(o.quote_snapshot,o.renter_user_id,o.owner_user_id,o.account_id,o.listing_version_id,o.content_hash,o.rule_release_id);
  expected:=encode(sha256(convert_to(jsonb_build_array(NEW.order_id,NEW.payment_confirmation_id,NEW.owner_user_id,NEW.renter_user_id,
   NEW.paid_cents::text,NEW.refund_cents::text,NEW.owner_cents::text,NEW.platform_cents::text,NEW.reason,NEW.owner_gross_cents::text,NEW.full_payout_fee_cents::text,NEW.full_payout_selected)::text,'UTF8')),'hex');
 END IF;
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
  OR NEW.full_payout_selected IS DISTINCT FROM selected
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
   OR(p.platform_cents>coalesce(p.full_payout_fee_cents,0)+coalesce(p.platform_service_fee_cents,0) AND NEW.line_no=2+(p.refund_cents>0)::integer+(p.owner_cents>0)::integer
      AND NEW.account_code='PLATFORM_CANCELLATION_CONTRIBUTION' AND NEW.debit_cents=0 AND NEW.credit_cents=p.platform_cents-coalesce(p.full_payout_fee_cents,0)-coalesce(p.platform_service_fee_cents,0)
      AND NEW.counterparty_user_id IS NULL AND NEW.source_payment_confirmation_id IS NULL)
   OR(coalesce(p.full_payout_fee_cents,0)>0 AND NEW.line_no=2+(p.refund_cents>0)::integer+(p.owner_cents>0)::integer
      +(p.platform_cents>coalesce(p.full_payout_fee_cents,0)+coalesce(p.platform_service_fee_cents,0))::integer
      AND NEW.account_code='PLATFORM_COMPENSATION_FEE' AND NEW.debit_cents=0 AND NEW.credit_cents=p.full_payout_fee_cents
      AND NEW.counterparty_user_id IS NULL AND NEW.source_payment_confirmation_id IS NULL)
   OR(coalesce(p.platform_service_fee_cents,0)>0 AND NEW.line_no=2+(p.refund_cents>0)::integer+(p.owner_cents>0)::integer
      +(p.platform_cents>coalesce(p.full_payout_fee_cents,0)+coalesce(p.platform_service_fee_cents,0))::integer+(coalesce(p.full_payout_fee_cents,0)>0)::integer
      AND NEW.account_code='PLATFORM_SERVICE_FEE' AND NEW.debit_cents=0 AND NEW.credit_cents=p.platform_service_fee_cents
      AND NEW.counterparty_user_id IS NULL AND NEW.source_payment_confirmation_id IS NULL))
 THEN RAISE EXCEPTION 'poststart cancellation entry differs' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.guard_support_poststart_root() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p zzsh_order.support_poststart_cancellation;
BEGIN
 SELECT * INTO p FROM zzsh_order.support_poststart_cancellation WHERE root_id=NEW.id;
 IF p.id IS NULL OR p.created_xid IS DISTINCT FROM pg_current_xact_id() OR NEW.basis_id IS NOT NULL
  OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh' OR NEW.source_entity<>'support_poststart_cancellation'
  OR NEW.source_id<>p.id OR NEW.subject_user_id<>p.owner_user_id OR NEW.beneficiary_role<>'OWNER'
  OR NEW.policy_version<>(CASE WHEN p.fixed_fee_rate IS NULL THEN 'support-cancellation-v1' ELSE 'support-cancellation-v2' END) OR NEW.source_digest<>p.source_digest
 THEN RAISE EXCEPTION 'poststart cancellation root differs' USING ERRCODE='23514';END IF;
 INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision)
  VALUES(p.owner_user_id,0,0),(p.renter_user_id,0,0) ON CONFLICT(user_id) DO NOTHING;
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
   AND r.beneficiary_role='OWNER' AND r.policy_version=CASE WHEN p.fixed_fee_rate IS NULL THEN 'support-cancellation-v1' ELSE 'support-cancellation-v2' END AND r.source_digest=p.source_digest
   AND e.kind='SUPPORT_CANCELLATION_RECOGNIZED' AND e.subject_user_id=p.owner_user_id AND w.ledger_revision>=e.expected_ledger_revision+1
   AND (SELECT count(*) FROM zzsh_order.finance_event x WHERE x.economic_root_id=r.id)=1
   AND (SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)
      =1+(p.refund_cents>0)::integer+(p.owner_cents>0)::integer
        +(p.platform_cents>coalesce(p.full_payout_fee_cents,0)+coalesce(p.platform_service_fee_cents,0))::integer
        +(coalesce(p.full_payout_fee_cents,0)>0)::integer+(coalesce(p.platform_service_fee_cents,0)>0)::integer
   AND (SELECT coalesce(sum(debit_cents),0) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)=p.paid_cents
   AND (SELECT coalesce(sum(credit_cents),0) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)=p.paid_cents
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_posting s WHERE s.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_referral_earning d WHERE d.order_id=o.id AND d.amount_cents>0 AND d.state<>'REVOKED')
   AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.support_poststart_cancel' AND a.object_type='support_poststart_cancellation'
    AND a.object_id=p.id AND a.outcome='SUCCESS' AND a.actor_type='admin' AND a.actor_id=p.admin_user_id
    AND a.session_id=p.admin_session_id AND a.request_id=p.request_id AND a.reason=p.reason
    AND a.details->>'sourceDigest'=p.source_digest)),false)
$$;

CREATE OR REPLACE FUNCTION zzsh_order.cancel_order_after_start_v3(order_value text,expected_revision bigint,refund_value numeric,owner_gross_value numeric,reason_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor_value text:=current_setting('zzsh.actor_id',true);session_value text:=current_setting('zzsh.session_id',true);
 request_value text:=current_setting('zzsh.request_id',true);boss boolean;o zzsh_order.rental_order;c zzsh_order.payment_confirmation;
 owner_id text;renter_id text;game_value text;account_value text;case_id text;root_value text;event_value text;digest_value text;
 platform_value numeric;owner_value numeric;fee_value numeric;service_value numeric;rate_value text;full_payout boolean;revision_value bigint;line_value integer:=1;details_value jsonb;
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

 rate_value:=zzsh_order.fixed_fee_poststart_rate(o.quote_snapshot,o.renter_user_id,o.owner_user_id,o.account_id,o.listing_version_id,o.content_hash,o.rule_release_id);
 full_payout:=zzsh_order.poststart_full_payout_selected(jsonb_set(o.quote_snapshot,'{personal,schema}',to_jsonb('personal-quote-v4'::text)),o.renter_user_id,o.owner_user_id,o.account_id,o.listing_version_id,o.content_hash,o.rule_release_id);
 IF rate_value IS NULL OR full_payout IS NULL THEN RAISE EXCEPTION 'poststart fixed fee basis unknown' USING ERRCODE='23514';END IF;
 fee_value:=CASE WHEN full_payout IS TRUE THEN round(owner_gross_value*8/100) ELSE 0 END;
 service_value:=round(owner_gross_value*rate_value::numeric);
 owner_value:=owner_gross_value-fee_value-service_value;
 IF owner_value<0 THEN RAISE EXCEPTION 'poststart owner fees exceed income' USING ERRCODE='23514';END IF;
 platform_value:=c.amount_cents-refund_value-owner_value;
 case_id:='spcancel_'||substr(encode(sha256(convert_to(o.id,'UTF8')),'hex'),1,40);
 root_value:='spcancel_root_'||substr(encode(sha256(convert_to(o.id,'UTF8')),'hex'),1,40);
 event_value:='spcancel_event_'||substr(encode(sha256(convert_to(o.id,'UTF8')),'hex'),1,40);
 digest_value:=encode(sha256(convert_to(jsonb_build_array(o.id,c.id,owner_id,renter_id,c.amount_cents::text,
  refund_value::text,owner_value::text,platform_value::text,reason_value,owner_gross_value::text,fee_value::text,full_payout,'fixed-fee-v1',rate_value,service_value::text)::text,'UTF8')),'hex');
 INSERT INTO zzsh_order.support_poststart_cancellation(id,order_id,payment_confirmation_id,owner_user_id,renter_user_id,
  admin_user_id,admin_session_id,request_id,reason,paid_cents,refund_cents,owner_cents,platform_cents,source_digest,root_id,event_id,owner_gross_cents,full_payout_fee_cents,full_payout_selected,fixed_fee_rate,platform_service_fee_cents)
 VALUES(case_id,o.id,c.id,owner_id,renter_id,actor_value,session_value,request_value,reason_value,c.amount_cents,refund_value,owner_value,platform_value,digest_value,root_value,event_value,owner_gross_value,fee_value,full_payout,rate_value,service_value);
 INSERT INTO zzsh_order.finance_economic_root(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,policy_version,source_digest)
 VALUES(root_value,NULL,'NATIVE_SUPPORT_CANCELLATION','NATIVE','zzsh','support_poststart_cancellation',case_id,owner_id,'OWNER','support-cancellation-v2',digest_value);
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
 IF platform_value>fee_value+service_value THEN line_value:=line_value+1;
  INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
  VALUES(event_value||'_'||line_value,event_value,line_value,'PLATFORM_CANCELLATION_CONTRIBUTION',0,platform_value-fee_value-service_value,NULL,details_value);END IF;
 IF fee_value>0 THEN line_value:=line_value+1;
  INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
  VALUES(event_value||'_'||line_value,event_value,line_value,'PLATFORM_COMPENSATION_FEE',0,fee_value,NULL,details_value);END IF;
 IF service_value>0 THEN line_value:=line_value+1;
  INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
  VALUES(event_value||'_'||line_value,event_value,line_value,'PLATFORM_SERVICE_FEE',0,service_value,NULL,details_value);END IF;
 UPDATE zzsh_order.rental_order SET status='CANCELLED',cancel_reason='SUPPORT_AFTER_START_CANCELLED',cancelled_at=clock_timestamp(),
  revision=revision+1,updated_at=clock_timestamp() WHERE id=o.id AND status='PAID' AND revision=expected_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'poststart cancellation order changed' USING ERRCODE='40001';END IF;
 INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,reason,occurred_at,details)
 VALUES('audit_'||substr(encode(sha256(convert_to(case_id||request_value,'UTF8')),'hex'),1,40),'admin',actor_value,session_value,
  'order.support_poststart_cancel','support_poststart_cancellation',case_id,'SUCCESS',request_value,reason_value,clock_timestamp(),
  jsonb_build_object('orderId',o.id,'paymentConfirmationId',c.id,'paidCents',c.amount_cents::text,'refundCents',refund_value::text,
   'ownerCents',owner_value::text,'ownerGrossCents',owner_gross_value::text,'fullPayoutFeeCents',fee_value::text,'fullPayoutSelected',full_payout,'platformServiceFeeCents',service_value::text,'fixedFeeRate',rate_value,'platformCents',platform_value::text,'sourceDigest',digest_value,'channelResult','NOT_SUBMITTED'));
 RETURN jsonb_build_object('caseId',case_id,'orderId',o.id,'status','CANCELLED','paidCents',c.amount_cents::text,'refundCents',refund_value::text,
  'ownerCents',owner_value::text,'ownerGrossCents',owner_gross_value::text,'fullPayoutFeeCents',fee_value::text,'fullPayoutSelected',full_payout,'platformServiceFeeCents',service_value::text,'fixedFeeRate',rate_value,'platformContributionCents',platform_value::text,'commissionCents','0','channelResult','NOT_SUBMITTED');
END $$;
COMMENT ON FUNCTION zzsh_order.cancel_order_after_start_v3(text,bigint,numeric,numeric,text) IS '固定手续费订单客服特殊取消：按冻结费率及包赔费分配原款';
REVOKE ALL ON FUNCTION zzsh_order.cancel_order_after_start_v3(text,bigint,numeric,numeric,text),zzsh_order.fixed_fee_poststart_rate(jsonb,text,text,text,text,text,text) FROM PUBLIC;
