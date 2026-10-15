-- Immutable legacy display facts; this migration does not enable public admission.
CREATE TABLE zzsh_supply.legacy_listing_display_snapshot (
  account_id text NOT NULL REFERENCES zzsh_supply.legacy_listing_read_snapshot(account_id),
  schema_version smallint NOT NULL CHECK (schema_version=1),
  observation_version_id text NOT NULL,
  base_source_digest text NOT NULL CHECK (base_source_digest ~ '^[a-f0-9]{64}$'),
  extract_sha256 text NOT NULL CHECK (extract_sha256 ~ '^[a-f0-9]{64}$'),
  source_updated_at timestamptz NOT NULL,
  evidence_ref text NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot)='object' AND (snapshot->>'schema') IS NOT DISTINCT FROM 'legacy-listing-display-v1'),
  display_digest text NOT NULL CHECK (display_digest ~ '^[a-f0-9]{64}$'),
  created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (account_id,schema_version),
  CONSTRAINT legacy_display_version_account_fk FOREIGN KEY (observation_version_id,account_id) REFERENCES zzsh_supply.listing_version(id,account_id)
);
--> statement-breakpoint
CREATE FUNCTION zzsh_supply.guard_legacy_display_snapshot() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM zzsh_supply.legacy_listing_read_snapshot h
    WHERE h.account_id=NEW.account_id AND h.observation_version_id=NEW.observation_version_id
      AND h.source_digest=NEW.base_source_digest AND h.source_updated_at=NEW.source_updated_at)
    AND EXISTS (SELECT 1 FROM zzsh_supply.listing_version v WHERE v.id=NEW.observation_version_id AND v.account_id=NEW.account_id) THEN
    RAISE EXCEPTION 'legacy display snapshot must bind the original read snapshot';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER legacy_display_insert BEFORE INSERT ON zzsh_supply.legacy_listing_display_snapshot
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_legacy_display_snapshot();
--> statement-breakpoint
CREATE TRIGGER legacy_display_immutable BEFORE UPDATE OR DELETE ON zzsh_supply.legacy_listing_display_snapshot
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();
-- runtime: SELECT, INSERT only; no UPDATE, DELETE, TRUNCATE, trigger ownership or DDL.
-- Existing original snapshot/map/listing_version/account rows are not modified.
