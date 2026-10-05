-- Referral lines derive from their earning root; only the original captured source carries the unique payment source pointer.
CREATE OR REPLACE FUNCTION zzsh_order.earning_expected_lines(event_id_value text)
 RETURNS TABLE(line_no integer,account_code text,debit_cents numeric,credit_cents numeric,counterparty_user_id text,source_payment_confirmation_id text)
 LANGUAGE plpgsql STABLE AS $$
DECLARE e zzsh_order.finance_event;r zzsh_order.rental_referral_earning;from_settled boolean;
BEGIN
 SELECT * INTO e FROM zzsh_order.finance_event WHERE id=event_id_value;
 SELECT * INTO r FROM zzsh_order.rental_referral_earning WHERE economic_root_id=e.economic_root_id;
 IF r.id IS NULL OR r.amount_cents=0 THEN RETURN;END IF;
 IF e.kind='EARNING_PENDING' THEN
  RETURN QUERY VALUES(1,'DISTRIBUTION_EXPENSE',r.amount_cents,0::numeric,NULL::text,NULL::text),(2,'WALLET_PENDING_EARNINGS',0::numeric,r.amount_cents,r.beneficiary_user_id,NULL::text);
 ELSIF e.kind='EARNING_SETTLED' THEN
  RETURN QUERY VALUES(1,'WALLET_PENDING_EARNINGS',r.amount_cents,0::numeric,r.beneficiary_user_id,NULL::text),(2,'WALLET_AVAILABLE',0::numeric,r.amount_cents,r.beneficiary_user_id,NULL::text);
 ELSIF e.kind='EARNING_REVOKED' THEN
  SELECT EXISTS(SELECT 1 FROM zzsh_order.finance_event WHERE economic_root_id=r.economic_root_id AND kind='EARNING_SETTLED') INTO from_settled;
  RETURN QUERY VALUES(1,CASE WHEN from_settled THEN 'WALLET_AVAILABLE' ELSE 'WALLET_PENDING_EARNINGS' END,r.amount_cents,0::numeric,r.beneficiary_user_id,NULL::text),(2,'DISTRIBUTION_EXPENSE',0::numeric,r.amount_cents,NULL::text,NULL::text);
 END IF;
END $$;
