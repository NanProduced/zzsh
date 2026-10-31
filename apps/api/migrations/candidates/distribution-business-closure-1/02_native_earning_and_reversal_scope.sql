-- UNNUMBERED CANDIDATE. Root owns numbering/journal/rollback. NOT APPLIED to any database.
-- Lets the same typed earning ledger serve formal NATIVE collection without relabelling it LOCAL.

ALTER TABLE zzsh_order.rental_referral_reversal_source
  DROP CONSTRAINT rental_referral_reversal_source_scope_check,
  ADD CONSTRAINT rental_referral_reversal_source_scope_check CHECK(scope IN('LOCAL_CONTROLLED','NATIVE'));

-- Scope must follow the original admission mode; approval digest, basis and amount still bind the earning.
CREATE OR REPLACE FUNCTION zzsh_order.guard_referral_reversal_declaration() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE r zzsh_order.rental_referral_earning;a zzsh_order.distribution_order_admission;owner_name text;expected_scope text;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 SELECT * INTO r FROM zzsh_order.rental_referral_earning WHERE id=NEW.earning_id;
 SELECT * INTO a FROM zzsh_order.distribution_order_admission WHERE order_id=r.order_id;
 expected_scope:=CASE WHEN a.mode='NATIVE' THEN 'NATIVE' ELSE 'LOCAL_CONTROLLED' END;
 IF current_user<>owner_name OR r.id IS NULL OR a.id IS NULL OR NEW.scope<>expected_scope
  OR NEW.approval_digest IS DISTINCT FROM a.approval_digest OR NEW.basis_digest IS DISTINCT FROM r.basis_digest
  OR NEW.amount_cents IS DISTINCT FROM r.amount_cents OR a.resource_oid<>(SELECT oid FROM pg_database WHERE datname=current_database())
  OR a.resource_name<>current_database()
 THEN RAISE EXCEPTION 'reversal declaration requires exact maintenance admission and original earning' USING ERRCODE='23514';END IF;
 NEW.declared_at:=clock_timestamp();RETURN NEW;
END $$;

-- Ledger evidence carries the same source label as the producing admission; never a blanket LOCAL label.
CREATE OR REPLACE FUNCTION zzsh_order.guard_earning_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE e zzsh_order.finance_event;r zzsh_order.rental_referral_earning;expected_scope text;
BEGIN
 SELECT * INTO e FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 SELECT * INTO r FROM zzsh_order.rental_referral_earning WHERE economic_root_id=e.economic_root_id;
 SELECT CASE WHEN a.mode='NATIVE' THEN 'NATIVE' ELSE 'LOCAL_CONTROLLED' END INTO expected_scope
  FROM zzsh_order.distribution_order_admission a WHERE a.order_id=r.order_id;
 IF r.id IS NULL OR expected_scope IS NULL OR e.created_xid<>pg_current_xact_id() OR NEW.details->>'earningId' IS DISTINCT FROM r.id
  OR NEW.details->>'earningRole' IS DISTINCT FROM r.beneficiary_role OR NEW.details->>'scope' IS DISTINCT FROM expected_scope
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.earning_expected_lines(e.id) x WHERE
   (NEW.line_no,NEW.account_code,NEW.debit_cents,NEW.credit_cents,NEW.counterparty_user_id,NEW.source_payment_confirmation_id)
    IS NOT DISTINCT FROM(x.line_no,x.account_code,x.debit_cents,x.credit_cents,x.counterparty_user_id,x.source_payment_confirmation_id))
 THEN RAISE EXCEPTION 'earning line differs from exact original template' USING ERRCODE='23514';END IF;RETURN NEW;
END $$;

