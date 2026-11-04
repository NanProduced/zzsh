-- 保留全部期初来源证明守卫；循环复用已解码的 JSONB，不重复解析原输入全文。
CREATE OR REPLACE FUNCTION zzsh_order.guard_stored_opening_source_proof() RETURNS trigger LANGUAGE plpgsql AS $$
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
  SELECT count(*),jsonb_agg(v::jsonb) INTO counted,matched FROM jsonb_array_elements(i->'observations') v
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
REVOKE ALL ON FUNCTION zzsh_order.guard_stored_opening_source_proof() FROM PUBLIC;
