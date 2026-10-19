-- Late verified holdings do not mutate frozen legacy observation children.
CREATE TABLE zzsh_supply.legacy_skin_holding (
  account_id text PRIMARY KEY REFERENCES zzsh_supply.rental_account(id) ON DELETE RESTRICT,
  observation_version_id text NOT NULL REFERENCES zzsh_supply.listing_version(id) ON DELETE RESTRICT,
  source_system text NOT NULL CHECK (source_system='legacy_mysql_restore'),
  source_entity text NOT NULL CHECK (source_entity='la_rental_accounts'),
  legacy_id text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  holding_digest text NOT NULL CHECK (holding_digest ~ '^[a-f0-9]{64}$'),
  skin_ids text[] NOT NULL DEFAULT '{}',
  evidence_ref text NOT NULL CHECK (length(evidence_ref) BETWEEN 1 AND 512),
  created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX legacy_skin_holding_observation_version_idx
  ON zzsh_supply.legacy_skin_holding(observation_version_id);

CREATE FUNCTION zzsh_supply.guard_legacy_skin_holding()
RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'legacy_skin_holding is append-only' USING ERRCODE='40001';
  END IF;
  SELECT account_id,origin,review_state INTO parent
    FROM zzsh_supply.listing_version WHERE id=NEW.observation_version_id;
  IF parent.account_id IS DISTINCT FROM NEW.account_id
     OR parent.origin IS DISTINCT FROM 'LEGACY_OBSERVATION'
     OR parent.review_state IS DISTINCT FROM 'IMPORTED_UNVERIFIED' THEN
    RAISE EXCEPTION 'legacy_skin_holding requires its own immutable legacy observation'
      USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER legacy_skin_holding_guard
  BEFORE INSERT OR UPDATE OR DELETE ON zzsh_supply.legacy_skin_holding
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_legacy_skin_holding();
