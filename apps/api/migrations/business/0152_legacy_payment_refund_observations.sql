-- 旧支付/退款只读事实：不创建原生确认、钱包、账务或渠道到账。
ALTER TABLE zzsh_order.personal_finance_observation DROP CONSTRAINT personal_finance_observation_source_kind_check;
ALTER TABLE zzsh_order.personal_finance_observation ADD CONSTRAINT personal_finance_observation_source_kind_check CHECK(source_kind IN('HISTORICAL_EARNINGS_LOG','HISTORICAL_DISTRIBUTION','HISTORICAL_WITHDRAWAL','HISTORICAL_PAYMENT','HISTORICAL_REFUND'));
ALTER TABLE zzsh_order.personal_finance_observation_coverage DROP CONSTRAINT personal_finance_observation_coverage_source_kind_check;
ALTER TABLE zzsh_order.personal_finance_observation_coverage ADD CONSTRAINT personal_finance_observation_coverage_source_kind_check CHECK(source_kind IN('HISTORICAL_EARNINGS_LOG','HISTORICAL_DISTRIBUTION','HISTORICAL_WITHDRAWAL','HISTORICAL_PAYMENT','HISTORICAL_REFUND'));
ALTER TABLE zzsh_order.personal_finance_observation_coverage DROP CONSTRAINT personal_finance_observation_coverage_check1;
ALTER TABLE zzsh_order.personal_finance_observation_coverage ADD CONSTRAINT personal_finance_observation_coverage_check1 CHECK(
 (source_kind='HISTORICAL_EARNINGS_LOG' AND source_entity='la_log_earnings')
 OR(source_kind='HISTORICAL_DISTRIBUTION' AND source_entity='la_distribution_order')
 OR(source_kind='HISTORICAL_WITHDRAWAL' AND source_entity='la_withdraw_apply')
 OR(source_kind='HISTORICAL_PAYMENT' AND source_entity='la_pay_order')
 OR(source_kind='HISTORICAL_REFUND' AND source_entity='la_refund_record'));
CREATE OR REPLACE FUNCTION zzsh_order.guard_finance_observation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE owner_name text;basis zzsh_order.finance_opening_basis;expected_kind text;event_seconds numeric;admission zzsh_order.finance_observation_admission;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 IF current_user<>owner_name THEN RAISE EXCEPTION 'historical observations require maintenance admission' USING ERRCODE='42501'; END IF;
 IF NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=NEW.user_id AND action='user.legacy_owner.migrated' AND outcome='SUCCESS'
   AND details->>'sourceSystem'=NEW.source_system AND details->>'sourceEntity'='la_user' AND details->>'legacyId'=NEW.legacy_user_id) THEN
   RAISE EXCEPTION 'observation legacy subject/source binding missing' USING ERRCODE='23514'; END IF;
 IF NEW.basis_id IS NOT NULL THEN
  SELECT * INTO basis FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
  IF basis.id IS NULL OR basis.user_id<>NEW.user_id OR basis.source_system<>NEW.source_system OR basis.source_id<>NEW.legacy_user_id THEN
   RAISE EXCEPTION 'observation basis belongs to another subject/source' USING ERRCODE='23514'; END IF;
 END IF;
 expected_kind:=CASE NEW.source_entity WHEN 'la_log_earnings' THEN 'earningsLog' WHEN 'la_distribution_order' THEN 'historicalDistribution' WHEN 'la_withdraw_apply' THEN 'withdrawObservation' WHEN 'la_pay_order' THEN 'paymentObservation' WHEN 'la_refund_record' THEN 'refundObservation' ELSE NULL END;
 IF expected_kind IS NULL OR NEW.snapshot->>'kind' IS DISTINCT FROM expected_kind
  OR NEW.snapshot->>'sourceId' IS DISTINCT FROM NEW.source_id OR NEW.snapshot->>'sourceUserId' IS DISTINCT FROM NEW.legacy_user_id
  OR NEW.snapshot IS DISTINCT FROM NEW.source_canonical::jsonb OR NEW.source_digest IS DISTINCT FROM encode(sha256(convert_to(NEW.source_canonical,'UTF8')),'hex') THEN
  RAISE EXCEPTION 'observation tuple/canonical digest mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.source_kind IS DISTINCT FROM (CASE NEW.source_entity WHEN 'la_log_earnings' THEN 'HISTORICAL_EARNINGS_LOG' WHEN 'la_distribution_order' THEN 'HISTORICAL_DISTRIBUTION' WHEN 'la_pay_order' THEN 'HISTORICAL_PAYMENT' WHEN 'la_refund_record' THEN 'HISTORICAL_REFUND' ELSE 'HISTORICAL_WITHDRAWAL' END) THEN
  RAISE EXCEPTION 'observation source kind mismatch' USING ERRCODE='23514'; END IF;
 IF jsonb_typeof(NEW.snapshot->'amount') IS DISTINCT FROM 'string' OR NEW.snapshot->>'amount' !~ '^(0|[1-9][0-9]{0,21})[.][0-9]{2}$' THEN
 RAISE EXCEPTION 'historical amount invalid' USING ERRCODE='23514'; END IF;
 IF NEW.source_entity='la_log_earnings' THEN
  IF jsonb_typeof(NEW.snapshot->'action') IS DISTINCT FROM 'number' OR NEW.snapshot->>'action' NOT IN ('1','2')
   OR jsonb_typeof(NEW.snapshot->'leftAmount') IS DISTINCT FROM 'string' OR NEW.snapshot->>'leftAmount' !~ '^-?(0|[1-9][0-9]{0,21})[.][0-9]{2}$' OR NEW.snapshot->>'leftAmount'='-0.00' THEN
   RAISE EXCEPTION 'historical direction/left amount invalid' USING ERRCODE='23514'; END IF;
 ELSIF NEW.source_entity='la_distribution_order' THEN
  IF jsonb_typeof(NEW.snapshot->'sourceStatus') IS DISTINCT FROM 'number' OR NEW.snapshot->>'sourceStatus' NOT IN ('1','2','3') THEN RAISE EXCEPTION 'distribution status unknown' USING ERRCODE='23514'; END IF;
 ELSIF NEW.source_entity IN('la_pay_order','la_refund_record') THEN
  IF NEW.basis_id IS NOT NULL OR NEW.included_in_opening OR NEW.snapshot->>'channelArrival' IS DISTINCT FROM 'UNKNOWN'
   OR jsonb_typeof(NEW.snapshot->'sourceStatus') IS DISTINCT FROM 'number' OR NEW.snapshot->>'sourceStatus' !~ '^[0-9]{1,3}$'
   OR (NEW.source_entity='la_pay_order' AND NEW.snapshot->>'sourceStatus' NOT IN('0','1')) THEN
   RAISE EXCEPTION 'payment/refund source observation cannot establish opening or channel result' USING ERRCODE='23514'; END IF;
 ELSE
  IF jsonb_typeof(NEW.snapshot->'sourceStatus') IS DISTINCT FROM 'number' OR NEW.snapshot->>'sourceStatus' NOT IN ('1','2','3','4','5')
   OR jsonb_typeof(NEW.snapshot->'net') IS DISTINCT FROM 'string' OR NEW.snapshot->>'net' !~ '^-?(0|[1-9][0-9]{0,21})[.][0-9]{2}$' OR NEW.snapshot->>'net'='-0.00'
   OR jsonb_typeof(NEW.snapshot->'fee') IS DISTINCT FROM 'string' OR NEW.snapshot->>'fee' !~ '^-?(0|[1-9][0-9]{0,21})[.][0-9]{2}$' OR NEW.snapshot->>'fee'='-0.00' THEN RAISE EXCEPTION 'withdrawal source fields invalid' USING ERRCODE='23514'; END IF;
 END IF;
 IF NEW.source_entity='la_distribution_order' THEN
  IF jsonb_typeof(NEW.snapshot->'sourceUpdatedAt') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'source time unknown' USING ERRCODE='23514'; END IF;
  event_seconds:=(NEW.snapshot->>'sourceUpdatedAt')::numeric;
 ELSE
  IF jsonb_typeof(NEW.snapshot->'createdAt') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION 'source time unknown' USING ERRCODE='23514'; END IF;
  event_seconds:=(NEW.snapshot->>'createdAt')::numeric;
 END IF;
 IF event_seconds<=0 OR event_seconds<>trunc(event_seconds) OR event_seconds>4294967295
  OR NEW.source_event_at IS DISTINCT FROM to_timestamp(event_seconds::double precision) THEN RAISE EXCEPTION 'snapshot/source event time mismatch' USING ERRCODE='23514'; END IF;
 IF NEW.basis_id IS NOT NULL THEN
  SELECT * INTO admission FROM zzsh_order.finance_observation_admission WHERE basis_id=NEW.basis_id AND source_entity=NEW.source_entity AND source_id=NEW.source_id;
  IF admission.user_id IS DISTINCT FROM NEW.user_id OR admission.source_system IS DISTINCT FROM NEW.source_system OR admission.legacy_user_id IS DISTINCT FROM NEW.legacy_user_id
   OR admission.source_digest IS DISTINCT FROM NEW.source_digest OR admission.source_event_at IS DISTINCT FROM NEW.source_event_at
   OR admission.included_in_opening IS DISTINCT FROM NEW.included_in_opening OR NEW.source_event_at>basis.source_cutoff THEN
   RAISE EXCEPTION 'observation not in reviewed frozen admission' USING ERRCODE='23514'; END IF;
 ELSIF NEW.included_in_opening THEN RAISE EXCEPTION 'unadmitted history cannot be included in opening' USING ERRCODE='23514'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.guard_finance_observation() FROM PUBLIC;
