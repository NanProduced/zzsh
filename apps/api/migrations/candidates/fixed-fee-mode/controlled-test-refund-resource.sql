-- Unnumbered fixed-fee verification candidate. Apply in the registered synthetic database only.
DO $fixed_fee_refund$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_database d JOIN pg_roles r ON r.rolname=current_user
    WHERE d.datname=current_database() AND d.datname='zzsh_test_supply_fixed_fee' AND d.oid=3513966
      AND shobj_description(d.oid,'pg_database')='zzsh:synthetic:fixed-fee:v1'
      AND r.rolname='zzsh_m3b_fixed_fee_m' AND r.oid=3513964
      AND shobj_description(r.oid,'pg_authid')='zzsh:synthetic:fixed-fee:v1:zzsh_test_supply_fixed_fee:migration'
      AND NOT r.rolsuper AND NOT r.rolbypassrls
  ) THEN RAISE EXCEPTION 'fixed-fee refund migration resource differs' USING ERRCODE='42501'; END IF;
END $fixed_fee_refund$;

CREATE TABLE zzsh_order.fixed_fee_refund_registration (
  reference text PRIMARY KEY CHECK (reference='fixed-fee-isolated'),
  registration_digest text NOT NULL CHECK (registration_digest ~ '^[a-f0-9]{64}$'),
  active boolean NOT NULL
);
REVOKE ALL ON zzsh_order.fixed_fee_refund_registration FROM PUBLIC;
GRANT SELECT,UPDATE(active) ON zzsh_order.fixed_fee_refund_registration TO zzsh_m3b_fixed_fee_r;
CREATE FUNCTION zzsh_order.guard_fixed_fee_refund_registration() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_user <> 'zzsh_m3b_fixed_fee_m' OR TG_OP <> 'UPDATE' OR NOT OLD.active OR NEW.active
    OR (NEW.reference,NEW.registration_digest) IS DISTINCT FROM (OLD.reference,OLD.registration_digest)
  THEN RAISE EXCEPTION 'fixed-fee refund registration can only be revoked by its owner' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER fixed_fee_refund_registration_guard BEFORE UPDATE OR DELETE ON zzsh_order.fixed_fee_refund_registration
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_fixed_fee_refund_registration();
REVOKE ALL ON FUNCTION zzsh_order.guard_fixed_fee_refund_registration() FROM PUBLIC;

CREATE FUNCTION zzsh_order.fixed_fee_refund_resource_matches() RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM pg_database d JOIN pg_roles r ON r.rolname=current_user
    WHERE d.datname=current_database() AND d.datname='zzsh_test_supply_fixed_fee' AND d.oid=3513966
      AND shobj_description(d.oid,'pg_database')='zzsh:synthetic:fixed-fee:v1'
      AND r.rolname='zzsh_m3b_fixed_fee_r' AND r.oid=3513965
      AND shobj_description(r.oid,'pg_authid')='zzsh:synthetic:fixed-fee:v1:zzsh_test_supply_fixed_fee:runtime'
      AND NOT (r.rolsuper OR r.rolbypassrls OR r.rolcreaterole OR r.rolcreatedb OR r.rolreplication)
  ) AND current_setting('session_replication_role')='origin'
    AND current_setting('transaction_isolation')='read committed'
$$;
REVOKE ALL ON FUNCTION zzsh_order.fixed_fee_refund_resource_matches() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION zzsh_order.fixed_fee_refund_resource_matches() TO zzsh_m3b_fixed_fee_r;
