-- Owner-provisioned exact resource admission; no runtime INSERT authority or synthesized balances.
ALTER TABLE zzsh_order.native_origin_resource_admission
 DROP CONSTRAINT native_origin_resource_admission_database_name_check,
 DROP CONSTRAINT native_origin_resource_admission_runtime_role_check,
 DROP CONSTRAINT native_origin_resource_admission_resource_marker_check,
 ADD CONSTRAINT native_origin_resource_admission_database_name_check CHECK(database_name~'^[a-z][a-z0-9_]{0,62}$'),
 ADD CONSTRAINT native_origin_resource_admission_runtime_role_check CHECK(runtime_role~'^[a-z][a-z0-9_]{0,62}$'),
 ADD CONSTRAINT native_origin_resource_admission_resource_marker_check CHECK(char_length(resource_marker) BETWEEN 1 AND 256);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION zzsh_order.guard_native_origin_basis() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE proof jsonb:=NEW.native_origin_canonical::jsonb;owner_name text;
BEGIN
 SELECT pg_get_userbyid(relowner) INTO owner_name FROM pg_class WHERE oid=TG_RELID;
 IF current_user<>owner_name OR NOT EXISTS(SELECT 1 FROM zzsh_order.native_origin_resource_admission a WHERE a.resource_oid=(SELECT oid FROM pg_database WHERE datname=current_database()) AND a.database_name=current_database() AND a.runtime_role=session_user AND a.resource_marker=COALESCE((SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname=current_database()),'')) OR proof->>'schema' IS DISTINCT FROM 'native-wallet-origin.v2' OR proof->>'userId' IS DISTINCT FROM NEW.user_id
  OR (SELECT count(*) FROM jsonb_object_keys(proof))<>4
  OR NOT EXISTS(SELECT 1 FROM zzsh_auth_user."user" u JOIN zzsh_iam.user_identity_state s ON s.user_id=u.id
   JOIN zzsh_order.native_user_insert_proof p ON p.user_id=u.id
   WHERE u.id=NEW.user_id AND NOT u.suspended AND s.account_status='ACTIVE' AND s.provider='none'
    AND p.insert_xid=pg_current_xact_id() AND p.insert_xid::text=proof->>'insertionXid' AND NEW.source_cutoff=p.captured_at
    AND s.version::text=proof->>'identityVersion')
  OR EXISTS(SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=NEW.user_id AND action='user.legacy_owner.migrated' AND outcome='SUCCESS')
  OR EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=NEW.user_id)
  OR EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage WHERE user_id=NEW.user_id)
 THEN RAISE EXCEPTION 'native zero origin requires fresh source/empty financial history' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION zzsh_order.guard_native_origin_basis() FROM PUBLIC;
