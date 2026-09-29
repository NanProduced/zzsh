-- Explicit historical read projection. This is not a new-platform publication,
-- quote, acceptance, eligibility, payment or order fact.
CREATE TABLE zzsh_supply.legacy_listing_read_snapshot (
  account_id text PRIMARY KEY REFERENCES zzsh_supply.rental_account(id),
  observation_version_id text NOT NULL,
  source_system text NOT NULL,
  source_entity text NOT NULL,
  legacy_id text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  source_status integer NOT NULL CHECK (source_status = 3),
  source_updated_at timestamptz NOT NULL,
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 512),
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (observation_version_id, account_id) REFERENCES zzsh_supply.listing_version(id, account_id),
  FOREIGN KEY (source_system, source_entity, legacy_id) REFERENCES zzsh_supply.legacy_supply_map(source_system, source_entity, legacy_id)
);
CREATE FUNCTION zzsh_supply.guard_legacy_read_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM zzsh_supply.legacy_supply_map m
    JOIN zzsh_supply.listing_version v ON v.id=m.version_id
    WHERE m.source_system=NEW.source_system AND m.source_entity=NEW.source_entity AND m.legacy_id=NEW.legacy_id
      AND m.account_id=NEW.account_id AND m.version_id=NEW.observation_version_id AND m.source_digest=NEW.source_digest
      AND v.origin='LEGACY_OBSERVATION' AND v.review_state='IMPORTED_UNVERIFIED'
  ) THEN RAISE EXCEPTION 'Legacy read snapshot must bind the immutable source observation'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER legacy_read_snapshot_insert BEFORE INSERT ON zzsh_supply.legacy_listing_read_snapshot
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_legacy_read_snapshot();
CREATE TRIGGER legacy_read_snapshot_immutable BEFORE UPDATE OR DELETE ON zzsh_supply.legacy_listing_read_snapshot
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();
