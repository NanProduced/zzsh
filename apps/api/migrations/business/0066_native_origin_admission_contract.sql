-- 0066 candidate (prepared, NOT executed): separates "admission row missing" (a defined
-- structured UNKNOWN, registration may continue) from digest/subject/privilege failures
-- (raise, the whole registration transaction rolls back). Requires the corrected 0065.
CREATE OR REPLACE FUNCTION zzsh_order.initialize_native_wallet_origin(user_id_value text,canonical text,digest text,request_id_value text)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE basis_id_value text:='native_basis_'||substr(encode(sha256(convert_to(user_id_value,'UTF8')),'hex'),1,40);
 root_id_value text:='native_root_'||substr(encode(sha256(convert_to(user_id_value,'UTF8')),'hex'),1,40);
 event_id_value text:='native_origin_'||substr(encode(sha256(convert_to(user_id_value,'UTF8')),'hex'),1,40);birth timestamptz;
BEGIN
 IF digest IS DISTINCT FROM encode(sha256(convert_to(canonical,'UTF8')),'hex')
 THEN RAISE EXCEPTION 'native origin canonical digest mismatch' USING ERRCODE='23514';END IF;
 IF NOT EXISTS(SELECT 1 FROM zzsh_order.native_origin_resource_admission a
  WHERE a.resource_oid=(SELECT oid FROM pg_database WHERE datname=current_database())
   AND a.database_name=current_database() AND a.runtime_role=session_user
   AND a.resource_marker=COALESCE((SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()),''))
 THEN RETURN jsonb_build_object('knowledge','UNKNOWN','reason','NATIVE_ORIGIN_RESOURCE_NOT_ADMITTED');END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id=user_id_value FOR UPDATE;
 SELECT captured_at INTO birth FROM zzsh_order.native_user_insert_proof
  WHERE user_id=user_id_value AND insert_xid=pg_current_xact_id();
 IF birth IS NULL THEN RAISE EXCEPTION 'native subject missing' USING ERRCODE='23514';END IF;
 INSERT INTO zzsh_order.finance_opening_basis(id,user_id,source_kind,source_system,source_entity,source_id,identity_source_digest,source_digest,available_cents,source_cutoff,covered_count,covered_set_digest,native_origin_canonical)
  VALUES(basis_id_value,user_id_value,'NATIVE_GENESIS','zzsh-native-registration','zzsh_auth_user.user',user_id_value,digest,digest,0,birth,0,encode(sha256(convert_to('','UTF8')),'hex'),canonical);
 INSERT INTO zzsh_order.finance_economic_root(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,source_digest)
  VALUES(root_id_value,basis_id_value,'NATIVE_GENESIS','NATIVE','zzsh-native-registration','zzsh_auth_user.user',user_id_value,user_id_value,'WALLET_HOLDER',digest);
 INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision) VALUES(event_id_value,root_id_value,'OPENING',user_id_value,0);
 INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,action,object_type,object_id,outcome,request_id,occurred_at,details)
  VALUES('audit_native_origin_'||replace(gen_random_uuid()::text,'-',''),'system',user_id_value,'finance.native.origin.created','wallet_coverage',user_id_value,'SUCCESS',request_id_value,clock_timestamp(),jsonb_build_object('origin','NATIVE_GENESIS','sourceDigest',digest));
 RETURN jsonb_build_object('knowledge','KNOWN','origin','NATIVE_GENESIS','availableCents','0');
END $$;
REVOKE ALL ON FUNCTION zzsh_order.initialize_native_wallet_origin(text,text,text,text) FROM PUBLIC;
