ALTER TABLE zzsh_supply.legacy_listing_read_snapshot
  DROP CONSTRAINT legacy_listing_read_snapshot_source_status_check;
ALTER TABLE zzsh_supply.legacy_listing_read_snapshot
  ADD CONSTRAINT legacy_listing_read_snapshot_source_status_check
  CHECK (source_status IN (0, 3, 4, 5));
