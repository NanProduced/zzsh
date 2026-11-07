-- Legacy paid originals may lack a verified merchant, so reserve their order number across merchants.
-- Source imports must finish before opening collection; this guard does not serialize a later import.
CREATE INDEX legacy_continuation_paid_order_no_idx ON zzsh_order.legacy_continuation_evidence
  USING gin ((facts #> '{evidence,source,paidPay}') jsonb_path_ops) WHERE source_kind='SOURCE_IMPORT';

--> statement-breakpoint
CREATE INDEX legacy_payment_observation_number_idx ON zzsh_order.personal_finance_observation ((snapshot->>'sourceNumber'),source_id)
 WHERE source_kind='HISTORICAL_PAYMENT' AND source_system='legacy_mysql_restore' AND source_entity='la_pay_order';
CREATE INDEX legacy_refund_observation_number_idx ON zzsh_order.personal_finance_observation ((snapshot->>'sourceNumber'))
 WHERE source_kind='HISTORICAL_REFUND' AND source_system='legacy_mysql_restore' AND source_entity='la_refund_record';

--> statement-breakpoint
CREATE INDEX legacy_native_request_number_idx ON zzsh_order.payment_request(channel_order_no) WHERE channel='JOINPAY';
CREATE INDEX legacy_native_confirmation_number_idx ON zzsh_order.payment_confirmation(merchant_order_no) WHERE source='JOINPAY';
CREATE INDEX legacy_native_refund_number_idx ON zzsh_order.channel_refund_intent(original_payment_order_no) WHERE payment_source='JOINPAY';

--> statement-breakpoint
CREATE FUNCTION zzsh_order.guard_legacy_payment_order_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.channel='JOINPAY' THEN
  IF current_setting('transaction_isolation')<>'read committed' THEN
   RAISE EXCEPTION 'payment original number check requires read committed' USING ERRCODE='23514';
  END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-order-no:v1',NEW.merchant_identity_id,NEW.channel_order_no)::text,0));
  PERFORM pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:legacy-original-order-no:v1',NEW.channel_order_no)::text,0));
  IF EXISTS(SELECT 1 FROM zzsh_order.legacy_continuation_evidence e
   WHERE e.source_kind='SOURCE_IMPORT' AND e.facts #> '{evidence,source,paidPay}' @> jsonb_build_array(jsonb_build_object('payOrderSn',NEW.channel_order_no)))
   OR EXISTS(SELECT 1 FROM zzsh_order.personal_finance_observation o WHERE o.source_type='LEGACY_MYSQL' AND o.source_kind='HISTORICAL_PAYMENT'
    AND o.source_system='legacy_mysql_restore' AND o.source_entity='la_pay_order' AND o.snapshot->>'sourceNumber'=NEW.channel_order_no)
   OR EXISTS(SELECT 1 FROM zzsh_order.personal_finance_observation o WHERE o.source_type='LEGACY_MYSQL' AND o.source_kind='HISTORICAL_REFUND'
    AND o.source_system='legacy_mysql_restore' AND o.source_entity='la_refund_record' AND o.snapshot->>'sourceNumber'=NEW.channel_order_no) THEN
   RAISE EXCEPTION 'legacy payment order number is reserved' USING ERRCODE='23514';
  END IF;
  IF to_regclass('zzsh_order.legacy_refund_case') IS NOT NULL THEN
   IF EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_case WHERE original_payment_order_no=NEW.channel_order_no) THEN
    RAISE EXCEPTION 'legacy refund original number is reserved' USING ERRCODE='23514';
   END IF;
  END IF;
  IF to_regclass('zzsh_order.legacy_refund_intent') IS NOT NULL THEN
   IF EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_intent WHERE refund_order_no=NEW.channel_order_no) THEN
    RAISE EXCEPTION 'legacy refund number is reserved' USING ERRCODE='23514';
   END IF;
  END IF;
 END IF;
 RETURN NEW;
END $$;

--> statement-breakpoint
CREATE TRIGGER legacy_payment_order_number_guard BEFORE INSERT ON zzsh_order.payment_request
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_legacy_payment_order_number();

--> statement-breakpoint
REVOKE ALL ON FUNCTION zzsh_order.guard_legacy_payment_order_number() FROM PUBLIC;
