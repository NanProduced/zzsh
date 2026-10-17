-- AV-1 candidate only. Root must reconcile existing duplicates before execution.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM zzsh_supply.rental_account WHERE display_no IS NOT NULL AND (btrim(display_no)='' OR btrim(display_no)<>display_no OR length(display_no)>128 OR display_no ~ '[[:cntrl:]]')) THEN
  RAISE EXCEPTION 'ACCOUNT_NUMBER_FORMAT_REVIEW_REQUIRED';
 END IF;
 IF EXISTS(SELECT 1 FROM zzsh_supply.rental_account WHERE display_no IS NOT NULL GROUP BY display_no HAVING count(*)>1) THEN
  RAISE EXCEPTION 'ACCOUNT_NUMBER_DUPLICATE_REVIEW_REQUIRED';
 END IF;
END $$;
CREATE UNIQUE INDEX rental_account_public_number_unique ON zzsh_supply.rental_account(display_no) WHERE display_no IS NOT NULL;
CREATE SEQUENCE zzsh_supply.account_display_no_seq;
-- Preserve existing AC values, without rewriting them or consuming the order namespace.
SELECT setval('zzsh_supply.account_display_no_seq',
 GREATEST(1,COALESCE((SELECT max(substring(number_text FROM 3)::bigint)+1 FROM (
  SELECT display_no AS number_text FROM zzsh_supply.rental_account
  UNION ALL SELECT h.snapshot->>'resourceNo' FROM zzsh_supply.legacy_listing_read_snapshot h
   JOIN zzsh_supply.legacy_supply_map m ON m.account_id=h.account_id AND m.version_id=h.observation_version_id AND m.source_digest=h.source_digest
    AND m.source_system=h.source_system AND m.source_entity=h.source_entity AND m.legacy_id=h.legacy_id
 ) existing_numbers WHERE number_text ~ '^AC[0-9]{1,18}$'),1)),false);
CREATE FUNCTION zzsh_supply.next_account_display_no() RETURNS text LANGUAGE sql AS $$
 SELECT 'AC'||CASE WHEN n<10000000000 THEN lpad(n::text,10,'0') ELSE n::text END
 FROM (SELECT nextval('zzsh_supply.account_display_no_seq') AS n) number_value;
$$;
CREATE FUNCTION zzsh_supply.guard_account_public_number() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' THEN
  IF OLD.display_no IS NOT NULL AND NEW.display_no IS DISTINCT FROM OLD.display_no THEN
   RAISE EXCEPTION 'ACCOUNT_NUMBER_IMMUTABLE';
  END IF;
 END IF;
 IF NEW.display_no IS NOT NULL AND (btrim(NEW.display_no)='' OR btrim(NEW.display_no)<>NEW.display_no OR length(NEW.display_no)>128 OR NEW.display_no ~ '[[:cntrl:]]') THEN
  RAISE EXCEPTION 'ACCOUNT_NUMBER_INVALID';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_public_number_guard BEFORE INSERT OR UPDATE ON zzsh_supply.rental_account FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_account_public_number();
CREATE INDEX legacy_account_number_lookup ON zzsh_supply.legacy_listing_read_snapshot((snapshot->>'resourceNo'));
-- Storage only. Public non-3 reads additionally require exact per-row v3 admission.
ALTER TABLE zzsh_supply.legacy_listing_read_snapshot DROP CONSTRAINT legacy_listing_read_snapshot_source_status_check;
ALTER TABLE zzsh_supply.legacy_listing_read_snapshot ADD CONSTRAINT legacy_listing_read_snapshot_source_status_check CHECK (source_status IN (0,3,4,5,6));
REVOKE ALL ON FUNCTION zzsh_supply.next_account_display_no() FROM PUBLIC;
