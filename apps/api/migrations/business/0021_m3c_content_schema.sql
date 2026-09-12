-- Version all declaration and presentation JSON, including incomplete drafts.
ALTER TABLE zzsh_supply.listing_version ADD COLUMN schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version=1);
