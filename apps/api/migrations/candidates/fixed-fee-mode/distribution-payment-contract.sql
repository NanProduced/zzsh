-- Candidate only. Preserve the installed ECS demo scope while extending the frozen payment contract.
DO $patch$
DECLARE source text; definition text; prior text; replacement text; digest text; idx integer;
 old_parts text[]:=ARRAY[
  $old$IF o.quote_snapshot->'schemaVersion'='2'::jsonb OR (o.quote_snapshot->'schemaVersion'='3'::jsonb$old$,
  $old$IF (cfg->>'schema'='distribution-policy.v3' OR cfg->>'schema'='distribution-policy.v4' AND cfg->>'baseMode'='LEGACY_RENTAL') THEN$old$,
  $old$IF uncertain OR total>base THEN items[i]:=jsonb_set(items[i],'{status}','"UNKNOWN_ESTIMATE_CONSERVATION"'::jsonb);
    ELSIF raw_amounts[i]=0 OR raw_amounts[i]<minimum THEN items[i]:=jsonb_set(items[i],'{status}','"SKIPPED_BELOW_MIN"'::jsonb);$old$
 ];
 new_parts text[]:=ARRAY[
  $new$IF o.quote_snapshot->'schemaVersion' IN ('2'::jsonb,'4'::jsonb) OR (o.quote_snapshot->'schemaVersion'='3'::jsonb$new$,
  $new$IF (cfg->>'schema'='distribution-policy.v3' OR cfg->>'schema'='distribution-policy.v4' AND cfg->>'baseMode'='LEGACY_RENTAL') AND o.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '4' THEN$new$,
  $new$IF uncertain OR (total>base AND o.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '4') THEN items[i]:=jsonb_set(items[i],'{status}','"UNKNOWN_ESTIMATE_CONSERVATION"'::jsonb);
    ELSIF total>base THEN NULL;
    ELSIF (raw_amounts[i]=0 OR raw_amounts[i]<minimum) AND o.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '4' THEN items[i]:=jsonb_set(items[i],'{status}','"SKIPPED_BELOW_MIN"'::jsonb);$new$
 ];
BEGIN
 IF to_regprocedure('zzsh_order.assert_fixed_fee_personal_order_v5(zzsh_order.rental_order)') IS NULL
 THEN RAISE EXCEPTION 'fixed fee order proof contract is required' USING ERRCODE='55000'; END IF;
 SELECT p.prosrc,pg_get_functiondef(p.oid) INTO source,definition FROM pg_proc p
  WHERE p.oid=to_regprocedure('zzsh_order.derive_payment_referral_inputs(text)')
    AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND NOT p.prosecdef;
 digest:=encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex');
 IF digest IS NULL OR digest NOT IN ('ccdb2fb81e27a2682d20b8afb74048f0693fc22a4a98588d2409bc3089233b07','f0e13c1b2604647d82b490aec3fae1adb4d75aa4413950387c343107508665ec')
 THEN RAISE EXCEPTION 'installed payment referral derivation is unrecognized' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,E'\r\n',E'\n');
 FOR idx IN 1..array_length(old_parts,1) LOOP
  prior:=old_parts[idx];replacement:=new_parts[idx];
  IF position(prior IN definition)=0 OR position(prior IN replace(definition,prior,''))<>0
  THEN RAISE EXCEPTION 'payment referral derivation patch is absent or ambiguous: %',idx USING ERRCODE='55000'; END IF;
  definition:=replace(definition,prior,replacement);
 END LOOP;
 EXECUTE definition;
END $patch$;

DO $patch$
DECLARE source text; definition text; prior text; replacement text; digest text; idx integer;
 old_parts text[]:=ARRAY[
  $old$doc->>'schema' IS DISTINCT FROM 'payment-distribution-basis.v1'$old$,
  $old$IF doc->'policyVersion' IS DISTINCT FROM derived->'policyVersion' OR doc->'policyDigest' IS DISTINCT FROM derived->'policyDigest'
  OR doc->'policyConfig' IS DISTINCT FROM derived->'policyConfig' OR doc->'accountMode' IS DISTINCT FROM derived->'accountMode'
  OR doc->'estimateBaseCents' IS DISTINCT FROM derived->'estimateBaseCents' OR doc->'roles' IS DISTINCT FROM derived->'roles'
 THEN RAISE EXCEPTION 'payment basis differs from original policy, role, relation or rounded estimate' USING ERRCODE='23514';END IF;
 IF derived->'estimateBaseCents'='null'::jsonb THEN$old$,
  $old$CASE WHEN (doc#>>'{policyConfig,schema}'='distribution-policy.v3' OR doc#>>'{policyConfig,schema}'='distribution-policy.v4' AND doc#>>'{policyConfig,baseMode}'='LEGACY_RENTAL') THEN 'LEGACY_RENTAL_QUOTE_HAFF_SPREAD_V1'$old$
 ];
 new_parts text[]:=ARRAY[
  $new$doc->>'schema' IS DISTINCT FROM (CASE WHEN order_row.quote_snapshot->>'schemaVersion'='4' THEN 'payment-distribution-basis.v2' ELSE 'payment-distribution-basis.v1' END)$new$,
  $new$IF doc->'policyVersion' IS DISTINCT FROM derived->'policyVersion' OR doc->'policyDigest' IS DISTINCT FROM derived->'policyDigest'
  OR doc->'policyConfig' IS DISTINCT FROM derived->'policyConfig' THEN
  RAISE EXCEPTION 'payment basis policy differs from its original source' USING ERRCODE='23514'; END IF;
 IF doc->>'schema'='payment-distribution-basis.v2' AND doc->'fixedFeePricing'='null'::jsonb THEN
  IF doc->'accountMode' IS DISTINCT FROM 'null'::jsonb OR doc->'estimateBaseCents' IS DISTINCT FROM 'null'::jsonb
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'roles') r
      LEFT JOIN LATERAL (SELECT value AS source FROM jsonb_array_elements(derived->'roles') WHERE value->>'role'=r->>'role') d ON true
      WHERE d.source IS NULL OR r->>'partyUserId' IS DISTINCT FROM
       (CASE r->>'role' WHEN 'OWNER_REFERRAL' THEN order_row.owner_user_id ELSE order_row.renter_user_id END)
      OR r->>'status' IS DISTINCT FROM (CASE WHEN derived->'policyConfig'='null'::jsonb THEN 'UNKNOWN_POLICY'
       WHEN derived#>>'{policyConfig,enabled}'='false' THEN 'SKIPPED_DISABLED' ELSE 'UNKNOWN_MODE' END)
      OR r->'beneficiaryUserId' IS DISTINCT FROM d.source->'beneficiaryUserId'
      OR r->'relationId' IS DISTINCT FROM d.source->'relationId' OR r->'relationDigest' IS DISTINCT FROM d.source->'relationDigest'
      OR r->'levelCode' IS DISTINCT FROM d.source->'levelCode'
      OR r->'ratio' IS DISTINCT FROM 'null'::jsonb OR r->'percent' IS DISTINCT FROM 'null'::jsonb OR r->'estimatedCents' IS DISTINCT FROM 'null'::jsonb)
  THEN RAISE EXCEPTION 'unknown fixed fee pricing cannot authorize referral eligibility' USING ERRCODE='23514'; END IF;
 ELSE
  IF doc->>'schema'='payment-distribution-basis.v2' AND (jsonb_typeof(doc->'fixedFeePricing') IS DISTINCT FROM 'object'
    OR doc->'fixedFeePricing' IS DISTINCT FROM jsonb_build_object('fixedFeeRate',order_row.quote_snapshot#>>'{settlementPricing,fixedFeeRate}',
       'payableRatio',order_row.quote_snapshot#>>'{settlementPricing,payableRatio}'))
  THEN RAISE EXCEPTION 'fixed fee pricing differs from the original order' USING ERRCODE='23514'; END IF;
  IF doc->'accountMode' IS DISTINCT FROM derived->'accountMode' OR doc->'estimateBaseCents' IS DISTINCT FROM derived->'estimateBaseCents'
    OR doc->'roles' IS DISTINCT FROM derived->'roles'
  THEN RAISE EXCEPTION 'payment basis differs from original role, relation or rounded estimate' USING ERRCODE='23514'; END IF;
 END IF;
 IF doc->'estimateBaseCents'='null'::jsonb THEN$new$,
  $new$CASE WHEN doc->>'schema'<>'payment-distribution-basis.v2' AND (doc#>>'{policyConfig,schema}'='distribution-policy.v3' OR doc#>>'{policyConfig,schema}'='distribution-policy.v4' AND doc#>>'{policyConfig,baseMode}'='LEGACY_RENTAL') THEN 'LEGACY_RENTAL_QUOTE_HAFF_SPREAD_V1'$new$
 ];
BEGIN
 SELECT p.prosrc,pg_get_functiondef(p.oid) INTO source,definition FROM pg_proc p
  WHERE p.oid=to_regprocedure('zzsh_order.guard_payment_distribution_basis()')
    AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND NOT p.prosecdef;
 digest:=encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex');
 IF digest IS DISTINCT FROM 'cbaa24ed55812c12c0a6228c682f3c2a326f3ac408f8da10b48e9e7f4d046ea2'
 THEN RAISE EXCEPTION 'installed payment referral guard is unrecognized' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,E'\r\n',E'\n');
 FOR idx IN 1..array_length(old_parts,1) LOOP
  prior:=old_parts[idx];replacement:=new_parts[idx];
  IF position(prior IN definition)=0 OR position(prior IN replace(definition,prior,''))<>0
  THEN RAISE EXCEPTION 'payment referral guard patch is absent or ambiguous: %',idx USING ERRCODE='55000'; END IF;
  definition:=replace(definition,prior,replacement);
 END LOOP;
 EXECUTE definition;
END $patch$;
