-- 0108: reviewed legacy source proof; preserve old inputs, receipts and original financial facts.
-- 只接纳维护者受审输入，不新增HTTP导入或从流水净和推算期初余额。
DO $$ DECLARE item record;n integer:=0;
BEGIN
 FOR item IN SELECT conname,pg_get_constraintdef(oid) AS definition FROM pg_constraint
  WHERE conrelid='zzsh_order.finance_covered_event'::regclass AND contype='c'
    AND pg_get_constraintdef(oid) LIKE '%source_kind%' LOOP
  IF item.definition NOT LIKE '%LEGACY_ADMIN_LOG%' OR item.definition LIKE '%LEGACY_WITHDRAWAL_RETURN%'
  THEN RAISE EXCEPTION 'covered source parent differs' USING ERRCODE='55000';END IF;
  EXECUTE format('ALTER TABLE zzsh_order.finance_covered_event DROP CONSTRAINT %I',item.conname);n:=n+1;
 END LOOP;
 IF n<>2 THEN RAISE EXCEPTION 'covered source constraint inventory differs' USING ERRCODE='55000';END IF;
END $$;
ALTER TABLE zzsh_order.finance_covered_event
 ADD CONSTRAINT finance_covered_event_source_kind_check CHECK(source_kind IN('LEGACY_DISTRIBUTION_EARNING','LEGACY_WITHDRAWAL',
  'LEGACY_RENTAL_OWNER_INCOME','LEGACY_ADMIN_LOG','LEGACY_DEPOSIT_COMPENSATION','LEGACY_WITHDRAWAL_RETURN')),
 ADD CONSTRAINT finance_covered_event_source_shape CHECK(
  (source_kind='LEGACY_DISTRIBUTION_EARNING' AND source_entity='la_distribution_order' AND beneficiary_role IN('TASK_REFERRAL','RENTER_REFERRAL','OWNER_REFERRAL'))
  OR(source_kind='LEGACY_WITHDRAWAL' AND source_entity='la_withdraw_apply' AND beneficiary_role='WALLET_HOLDER')
  OR(source_kind IN('LEGACY_RENTAL_OWNER_INCOME','LEGACY_DEPOSIT_COMPENSATION') AND source_entity='la_order' AND beneficiary_role='OWNER')
  OR(source_kind IN('LEGACY_ADMIN_LOG','LEGACY_WITHDRAWAL_RETURN') AND source_entity='la_log_earnings' AND beneficiary_role='WALLET_HOLDER'));

CREATE FUNCTION zzsh_order.guard_stored_opening_source_proof() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b zzsh_order.finance_opening_basis;i jsonb;r jsonb;p jsonb;s jsonb;binding jsonb;obs jsonb;raw_log jsonb;root_source jsonb;
 raw_obs json;matched jsonb;original jsonb;extended jsonb;withdrawal jsonb;value_id text;counted bigint;amount numeric;
BEGIN
 i:=NEW.input_canonical::jsonb;r:=NEW.review_canonical::jsonb;p:=i->'sourceProof';
 IF NOT(i?'sourceProof') THEN
  IF r?'sourceProofDigest' THEN RAISE EXCEPTION 'unbound source proof digest' USING ERRCODE='23514';END IF;
  RETURN NEW;
 END IF;
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 IF b.id IS NULL OR b.created_xid<>pg_current_xact_id() OR p->>'schema' IS DISTINCT FROM 'legacy-finance-source-proof.v1'
  OR jsonb_typeof(p->'sources') IS DISTINCT FROM 'array' OR jsonb_typeof(p->'logBindings') IS DISTINCT FROM 'array'
  OR jsonb_typeof(p->'supplementalLogs') IS DISTINCT FROM 'array'
  OR r->>'sourceProofDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(p),'UTF8')),'hex')
  OR jsonb_array_length(p->'sources')>5000 OR jsonb_array_length(p->'logBindings')>10000 OR jsonb_array_length(p->'supplementalLogs')>10000
  OR jsonb_array_length(p->'sources')<>b.covered_count
  OR(SELECT count(*) FROM jsonb_array_elements(i->'observations') v WHERE v->>'kind'='earningsLog' AND v->>'referenceType'='UNRESOLVED_ECONOMIC_SOURCE')<>jsonb_array_length(p->'logBindings')
 THEN RAISE EXCEPTION 'source proof schema/digest/bounds differ' USING ERRCODE='23514';END IF;
 IF(SELECT count(DISTINCT v->>'observationId') FROM jsonb_array_elements(p->'logBindings') v)<>jsonb_array_length(p->'logBindings')
  OR(SELECT count(DISTINCT v->>'observationId') FROM jsonb_array_elements(p->'supplementalLogs') v)<>jsonb_array_length(p->'supplementalLogs')
 THEN RAISE EXCEPTION 'duplicate original observation binding' USING ERRCODE='23514';END IF;
 FOR s IN SELECT value FROM jsonb_array_elements(p->'sources') LOOP
  original:=(s->>'sourceCanonical')::jsonb;
  IF NOT(s?&ARRAY['sourceKind','sourceEntity','sourceId','beneficiaryRole','sourceEventAt','sourceCanonical','sourceDigest'])
    OR (s->>'sourceId'~'^[1-9][0-9]{0,23}$') IS NOT TRUE OR(s->>'sourceDigest'~'^[a-f0-9]{64}$') IS NOT TRUE
    OR s->>'sourceDigest' IS DISTINCT FROM encode(sha256(convert_to(s->>'sourceCanonical','UTF8')),'hex')
    OR s->>'sourceId' IS DISTINCT FROM original->>'id'
    OR (s->>'sourceEventAt'~'^[1-9][0-9]{0,9}$') IS NOT TRUE OR to_timestamp((s->>'sourceEventAt')::bigint)>b.source_cutoff
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(i#>'{proof,coveredSet}') v WHERE v=jsonb_build_array(
      b.user_id,s->>'sourceKind','LEGACY_MYSQL',s->>'sourceEntity',s->>'sourceId',s->>'beneficiaryRole',s->>'sourceEventAt',s->>'sourceDigest'))
    OR(s->>'sourceKind' IN('LEGACY_WITHDRAWAL_RETURN','LEGACY_ADMIN_LOG','LEGACY_DEPOSIT_COMPENSATION') AND
      (SELECT count(*) FROM jsonb_array_elements(p->'logBindings') x WHERE x->>'sourceKind'=s->>'sourceKind'
       AND x->>'sourceEntity'=s->>'sourceEntity' AND x->>'sourceId'=s->>'sourceId' AND x->>'beneficiaryRole'=s->>'beneficiaryRole'
       AND x->>'sourceDigest'=s->>'sourceDigest')<>1)
  THEN RAISE EXCEPTION 'source root is not exact covered set' USING ERRCODE='23514';END IF;
 END LOOP;
 FOR binding IN SELECT value FROM jsonb_array_elements(p->'logBindings') LOOP
  SELECT count(*),jsonb_agg(v::jsonb) INTO counted,matched FROM json_array_elements(NEW.input_canonical::json->'observations') v
   WHERE v::jsonb->>'sourceId'=binding->>'observationId' AND v::jsonb->>'kind'='earningsLog'
    AND v::jsonb->>'referenceType'='UNRESOLVED_ECONOMIC_SOURCE'
    AND encode(sha256(convert_to(zzsh_order.canonical_finance_json(v::jsonb),'UTF8')),'hex')=binding->>'observationDigest';
  IF counted<>1 THEN RAISE EXCEPTION 'binding original observation differs' USING ERRCODE='23514';END IF;
  obs:=matched->0;raw_log:=(obs#>>'{rawSource,canonical}')::jsonb;
  IF NOT(raw_log?&ARRAY['id','sn','action','amount','userId','sourceId','createdAt','changeType','leftAmount'])
   OR(raw_log->>'createdAt'~'^[1-9][0-9]{0,9}$') IS NOT TRUE OR to_timestamp((raw_log->>'createdAt')::bigint)>b.source_cutoff
   OR raw_log->>'id' IS DISTINCT FROM binding->>'observationId' OR raw_log->>'userId' IS DISTINCT FROM b.source_id
   OR obs#>>'{rawSource,digest}' IS DISTINCT FROM encode(sha256(convert_to(obs#>>'{rawSource,canonical}','UTF8')),'hex')
   OR raw_log->>'sourceId' IS DISTINCT FROM obs->>'referenceId' OR raw_log->'amount' IS DISTINCT FROM obs->'amount'
   OR raw_log->'action' IS DISTINCT FROM obs->'action' OR raw_log->'createdAt' IS DISTINCT FROM obs->'createdAt'
   OR raw_log->'changeType' IS DISTINCT FROM obs->'legacyChangeType' OR raw_log->'sn' IS DISTINCT FROM obs->'legacyLogNumber'
   OR raw_log->'leftAmount' IS DISTINCT FROM obs->'leftAmount'
   OR(raw_log->>'amount'~'^(0|[1-9][0-9]{0,21})(\.[0-9]{1,2})?$') IS NOT TRUE
  THEN RAISE EXCEPTION 'original log fields changed' USING ERRCODE='23514';END IF;
  SELECT count(*),jsonb_agg(v) INTO counted,matched FROM jsonb_array_elements(p->'sources') v
   WHERE v->>'sourceKind'=binding->>'sourceKind' AND v->>'sourceEntity'=binding->>'sourceEntity'
    AND v->>'sourceId'=binding->>'sourceId' AND v->>'beneficiaryRole'=binding->>'beneficiaryRole' AND v->>'sourceDigest'=binding->>'sourceDigest';
  IF counted<>1 THEN RAISE EXCEPTION 'binding has no unique reviewed root' USING ERRCODE='23514';END IF;
  root_source:=matched->0;original:=(root_source->>'sourceCanonical')::jsonb;amount:=(raw_log->>'amount')::numeric;
  IF root_source->>'sourceKind' IN('LEGACY_WITHDRAWAL_RETURN','LEGACY_ADMIN_LOG') THEN
   IF root_source->>'sourceId'<>raw_log->>'id' OR root_source->>'sourceCanonical' IS DISTINCT FROM obs#>>'{rawSource,canonical}'
     OR root_source->>'sourceEventAt' IS DISTINCT FROM raw_log->>'createdAt'
   THEN RAISE EXCEPTION 'log root must use its own original id/time' USING ERRCODE='23514';END IF;
  END IF;
  IF root_source->>'sourceKind'='LEGACY_WITHDRAWAL_RETURN' THEN
   SELECT count(*),jsonb_agg(v) INTO counted,matched FROM jsonb_array_elements(p->'sources') v
    WHERE v->>'sourceKind'='LEGACY_WITHDRAWAL' AND v->>'sourceId'=raw_log->>'sourceId';
   IF counted<>1 THEN RAISE EXCEPTION 'withdrawal return parent missing' USING ERRCODE='23514';END IF;
   withdrawal:=(matched->0->>'sourceCanonical')::jsonb;
   IF withdrawal->>'status' IS DISTINCT FROM '4' OR withdrawal->>'userId' IS DISTINCT FROM b.source_id OR withdrawal->>'is_delete' IS DISTINCT FROM '0'
    OR(raw_log->>'changeType') NOT IN('1003','1004') OR raw_log->>'action'<>'1'
    OR amount<>(withdrawal->>'money')::numeric OR amount<>(withdrawal->>'handling_fee')::numeric+(withdrawal->>'left_money')::numeric
    OR(SELECT count(*) FROM jsonb_array_elements(i->'observations') v
      WHERE v->>'kind'='earningsLog' AND v->>'referenceId'=raw_log->>'sourceId' AND v->>'legacyChangeType'='1002'
       AND v->>'action'='2' AND(v->>'amount')::numeric=amount AND(v->>'createdAt')::bigint>=(withdrawal->>'create_time')::bigint
       AND(v->>'createdAt')::bigint<=(raw_log->>'createdAt')::bigint)<>1
    OR(SELECT count(*) FROM jsonb_array_elements(i->'observations') v WHERE v->>'kind'='earningsLog'
      AND v->>'referenceId'=raw_log->>'sourceId' AND v->>'legacyChangeType' IN('1003','1004','1005'))<>1
   THEN RAISE EXCEPTION 'withdrawal debit/return/gross/time does not close' USING ERRCODE='23514';END IF;
  END IF;
  IF raw_log->>'changeType' IN('1006','1007','1008') THEN
   SELECT count(*),jsonb_agg(v) INTO counted,matched FROM jsonb_array_elements(p->'supplementalLogs') v
    WHERE v->>'observationId'=binding->>'observationId';
   IF counted<>1 THEN RAISE EXCEPTION 'actual supplemental extraction missing' USING ERRCODE='23514';END IF;
   s:=matched->0;extended:=(s->>'canonical')::jsonb;
   IF s->>'digest' IS DISTINCT FROM encode(sha256(convert_to(s->>'canonical','UTF8')),'hex')
     OR s->>'originalDigest' IS DISTINCT FROM obs#>>'{rawSource,digest}' OR(s->>'extractSha256')!~'^[a-f0-9]{64}$'
     OR NOT(extended?&ARRAY['source_sn','remark','extra']) OR extended-ARRAY['source_sn','remark','extra'] IS DISTINCT FROM raw_log
     OR EXISTS(SELECT 1 FROM jsonb_each(extended) e WHERE e.key=ANY(ARRAY['source_sn','remark','extra']) AND jsonb_typeof(e.value) NOT IN('null','string'))
   THEN RAISE EXCEPTION 'supplement changed original nine fields or omitted extraction' USING ERRCODE='23514';END IF;
  END IF;
  IF root_source->>'sourceKind' IN('LEGACY_WITHDRAWAL_RETURN','LEGACY_ADMIN_LOG','LEGACY_DEPOSIT_COMPENSATION') AND NOT EXISTS(
    SELECT 1 FROM jsonb_array_elements(i->'admissions') a WHERE a->>'sourceEntity'='la_log_earnings' AND a->>'sourceId'=binding->>'observationId' AND a->>'included'='true')
  THEN RAISE EXCEPTION 'reviewed log not included in original opening admission' USING ERRCODE='23514';END IF;
 END LOOP;
 RETURN NEW;
END $$;
CREATE TRIGGER stored_opening_source_proof_guard BEFORE INSERT ON zzsh_order.finance_stored_opening_review
 FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_stored_opening_source_proof();

-- Runtime仅取得来源绑定摘要；既有review原文仍不授予SELECT。
CREATE FUNCTION zzsh_order.legacy_opening_source_proof(basis_id_value text) RETURNS jsonb
 LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE r zzsh_order.finance_stored_opening_review;b zzsh_order.finance_opening_basis;i jsonb;proof jsonb;digest_value text;
BEGIN
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=basis_id_value;
 SELECT * INTO r FROM zzsh_order.finance_stored_opening_review WHERE basis_id=b.id;
 IF r.basis_id IS NULL THEN RETURN NULL;END IF;
 i:=r.input_canonical::jsonb;
 IF NOT(i?'sourceProof') THEN RETURN NULL;END IF;
 proof:=i->'sourceProof';digest_value:=encode(sha256(convert_to(zzsh_order.canonical_finance_json(proof),'UTF8')),'hex');
 IF b.source_kind<>'LEGACY_OPENING' OR proof->>'schema'<>'legacy-finance-source-proof.v1'
   OR r.review_canonical::jsonb->>'sourceProofDigest' IS DISTINCT FROM digest_value
 THEN RAISE EXCEPTION 'sealed source proof digest differs' USING ERRCODE='23514';END IF;
 RETURN jsonb_build_object('schema','reviewed-opening-log-bindings.v1','basisId',b.id,'userId',b.user_id,'legacyUserId',b.source_id,
  'sourceDigest',b.source_digest,'coveredDigest',b.covered_set_digest,'cutoff',to_char(b.source_cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
  'digest',digest_value,'logBindings',proof->'logBindings');
END $$;
REVOKE ALL ON FUNCTION zzsh_order.guard_stored_opening_source_proof(),zzsh_order.legacy_opening_source_proof(text) FROM PUBLIC;

CREATE FUNCTION zzsh_order.guard_withdrawal_return_covered() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE b zzsh_order.finance_opening_basis;r zzsh_order.finance_stored_opening_review;
BEGIN
 SELECT * INTO b FROM zzsh_order.finance_opening_basis WHERE id=NEW.basis_id;
 SELECT * INTO r FROM zzsh_order.finance_stored_opening_review WHERE basis_id=b.id;
 IF b.id IS NULL OR b.created_xid<>pg_current_xact_id() OR r.basis_id IS NULL
  OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(r.input_canonical::jsonb#>'{sourceProof,sources}') s
   WHERE s->>'sourceKind'=NEW.source_kind AND s->>'sourceEntity'=NEW.source_entity AND s->>'sourceId'=NEW.source_id
    AND s->>'beneficiaryRole'=NEW.beneficiary_role AND s->>'sourceDigest'=NEW.source_digest
    AND to_timestamp((s->>'sourceEventAt')::bigint)=NEW.source_event_at)
 THEN RAISE EXCEPTION 'withdrawal return requires its separately reviewed opening proof' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER withdrawal_return_covered_guard BEFORE INSERT ON zzsh_order.finance_covered_event FOR EACH ROW
 WHEN(NEW.source_kind='LEGACY_WITHDRAWAL_RETURN') EXECUTE FUNCTION zzsh_order.guard_withdrawal_return_covered();
REVOKE ALL ON FUNCTION zzsh_order.guard_withdrawal_return_covered() FROM PUBLIC;

-- 后附0077的精确前向替换，保持所有原事务/余额/重复根守卫。
-- GENERATED_LEGACY_FUNDING_ASSERT
CREATE OR REPLACE FUNCTION zzsh_order.assert_legacy_duty_funding(p jsonb,d zzsh_order.legacy_order_duty) RETURNS void LANGUAGE plpgsql AS $$
DECLARE b zzsh_order.finance_opening_basis;c zzsh_order.personal_finance_observation_coverage;o zzsh_order.legacy_order_read_snapshot;
 actual_count bigint;actual_digest text;w jsonb;source_id_value text;entity_value text;types text[];resolved jsonb;bindings jsonb;
BEGIN
 SELECT basis.* INTO b FROM zzsh_order.wallet_coverage wc JOIN zzsh_order.finance_opening_basis basis ON basis.id=wc.basis_id AND basis.user_id=wc.user_id
  WHERE wc.user_id=d.counterparty_user_id AND wc.origin='RECONCILED_OPENING' AND basis.source_kind='LEGACY_OPENING';
 SELECT * INTO c FROM zzsh_order.personal_finance_observation_coverage WHERE user_id=d.counterparty_user_id AND source_kind='HISTORICAL_EARNINGS_LOG' ORDER BY source_cutoff DESC,id COLLATE "C" DESC LIMIT 1;
 SELECT * INTO o FROM zzsh_order.legacy_order_read_snapshot WHERE id=d.order_id;
 IF b.id IS NULL OR c.id IS NULL OR o.id IS NULL OR b.source_system<>'legacy_mysql_restore' OR c.source_system<>b.source_system OR c.legacy_user_id<>b.source_id
  OR c.source_entity<>'la_log_earnings' OR c.source_cutoff<>b.source_cutoff OR c.isolated_count<>0 OR c.source_count<>c.imported_count
 THEN RAISE EXCEPTION 'complete opening/history funding witness missing' USING ERRCODE='23514'; END IF;
 resolved:=zzsh_order.legacy_opening_source_proof(b.id);
 IF (resolved IS NOT NULL AND p#>>'{witness,sourceProofDigest}' IS DISTINCT FROM resolved->>'digest')
   OR(resolved IS NULL AND(p->'witness')?'sourceProofDigest')
 THEN RAISE EXCEPTION 'funding reviewed source proof digest differs' USING ERRCODE='23514';END IF;
 SELECT COALESCE(jsonb_object_agg(x->>'observationId',x),'{}'::jsonb) INTO bindings
  FROM jsonb_array_elements(resolved->'logBindings') x;

 SELECT count(*),encode(sha256(convert_to(COALESCE(string_agg(source_id||':'||source_digest,chr(10) ORDER BY source_id COLLATE "C"),''),'UTF8')),'hex')
 INTO actual_count,actual_digest FROM zzsh_order.personal_finance_observation WHERE user_id=d.counterparty_user_id AND source_kind='HISTORICAL_EARNINGS_LOG'
  AND source_system='legacy_mysql_restore' AND source_entity='la_log_earnings' AND source_event_at<=c.source_cutoff;
 IF actual_count<>c.imported_count OR actual_count>20000 OR actual_digest<>c.imported_set_digest
  OR EXISTS(SELECT 1 FROM zzsh_order.personal_finance_observation WHERE user_id=d.counterparty_user_id AND source_kind='HISTORICAL_EARNINGS_LOG'
   AND(source_system<>'legacy_mysql_restore' OR source_entity<>'la_log_earnings' OR source_type<>'LEGACY_MYSQL' OR source_event_at IS NULL OR source_event_at>c.source_cutoff))
 THEN RAISE EXCEPTION 'funding history source set does not close' USING ERRCODE='23514'; END IF;
 entity_value:=CASE WHEN d.kind='COMMISSION' THEN 'la_distribution_order' ELSE 'la_order' END;
 source_id_value:=CASE WHEN d.kind='COMMISSION' THEN d.source_record_id ELSE o.legacy_id END;
 types:=CASE d.kind WHEN 'COMMISSION' THEN ARRAY['LEGACY_DISTRIBUTION_EARNING'] WHEN 'RENTER_REFUND' THEN ARRAY['LEGACY_RENTAL_REFUND'] WHEN 'OWNER_CREDIT' THEN ARRAY['LEGACY_RENTAL_OWNER_INCOME'] ELSE ARRAY['LEGACY_DEPOSIT_COMPENSATION'] END;
 IF p->>'originalSourceEntity' IS DISTINCT FROM entity_value OR p->>'originalSourceId' IS DISTINCT FROM source_id_value OR p->>'originalOrderNumber' IS DISTINCT FROM NULLIF(o.original_order_no,'')
  OR EXISTS(SELECT 1 FROM zzsh_order.finance_covered_event WHERE user_id=d.counterparty_user_id AND source_entity=entity_value AND source_id=source_id_value AND source_kind=ANY(types))
  OR EXISTS(SELECT 1 FROM zzsh_order.personal_finance_observation obs WHERE obs.user_id=d.counterparty_user_id AND obs.source_kind='HISTORICAL_EARNINGS_LOG'
   AND obs.snapshot->>'action'='1' AND (obs.snapshot->>'amount')::numeric>0 AND(NOT COALESCE(COALESCE(bindings->obs.source_id->>'sourceKind',obs.snapshot->>'referenceType')=ANY(ARRAY['LEGACY_DISTRIBUTION_EARNING','LEGACY_RENTAL_REFUND','LEGACY_RENTAL_OWNER_INCOME','LEGACY_DEPOSIT_COMPENSATION','LEGACY_WITHDRAWAL','LEGACY_ADMIN_LOG','LEGACY_WITHDRAWAL_RETURN']),false)
    OR COALESCE(bindings->obs.source_id->>'sourceKind',obs.snapshot->>'referenceType')=ANY(types)
     AND(CASE WHEN bindings?obs.source_id THEN bindings->obs.source_id->>'sourceEntity'=entity_value AND bindings->obs.source_id->>'sourceId'=source_id_value
       ELSE obs.snapshot->>'referenceId' IN(source_id_value,o.original_order_no) OR obs.snapshot->>'referenceSn'=o.original_order_no END)
    OR NOT EXISTS(SELECT 1 FROM zzsh_order.finance_covered_event prior WHERE prior.basis_id=b.id AND prior.user_id=d.counterparty_user_id
     AND prior.source_kind=COALESCE(bindings->obs.source_id->>'sourceKind',obs.snapshot->>'referenceType') AND prior.source_type='LEGACY_MYSQL' AND prior.source_entity=CASE COALESCE(bindings->obs.source_id->>'sourceKind',obs.snapshot->>'referenceType')
      WHEN 'LEGACY_DISTRIBUTION_EARNING' THEN 'la_distribution_order' WHEN 'LEGACY_WITHDRAWAL' THEN 'la_withdraw_apply' WHEN 'LEGACY_ADMIN_LOG' THEN 'la_log_earnings' WHEN 'LEGACY_WITHDRAWAL_RETURN' THEN 'la_log_earnings' ELSE 'la_order' END
     AND prior.source_id=CASE WHEN COALESCE(bindings->obs.source_id->>'sourceKind',obs.snapshot->>'referenceType') IN('LEGACY_ADMIN_LOG','LEGACY_WITHDRAWAL_RETURN') THEN obs.source_id ELSE COALESCE(bindings->obs.source_id->>'sourceId',obs.snapshot->>'referenceId') END
     AND(NOT(bindings?obs.source_id) OR(prior.source_digest=bindings->obs.source_id->>'sourceDigest'
       AND prior.beneficiary_role=bindings->obs.source_id->>'beneficiaryRole')))))
  OR EXISTS(SELECT 1 FROM zzsh_order.legacy_duty_finance_fact other WHERE other.order_id=d.order_id AND other.kind=d.kind AND other.subject_user_id=d.counterparty_user_id
   AND(other.duty_id=d.id OR other.facts_canonical::jsonb#>>'{duty,sourceRecordId}'=d.source_record_id))
 THEN RAISE EXCEPTION 'legacy responsibility prior credit/posting not excluded' USING ERRCODE='23514'; END IF;
 w:=jsonb_build_object('openingBasisId',b.id,'openingSourceDigest',b.source_digest,'coveredSetDigest',b.covered_set_digest,
  'historyCoverageVersion',c.id||':'||c.imported_set_digest,'historyReferenceDigest',actual_digest,
  'historyCutoff',to_char(c.source_cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'sourceCount',actual_count::text);
 IF resolved IS NOT NULL THEN w:=w||jsonb_build_object('sourceProofDigest',resolved->>'digest');END IF;
 IF p->'witness' IS DISTINCT FROM w OR p->>'coverageEvidenceDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(w),'UTF8')),'hex')
 THEN RAISE EXCEPTION 'funding DTO differs from immutable source witness' USING ERRCODE='23514'; END IF;
END $$;
