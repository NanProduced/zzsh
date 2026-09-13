-- Bind reviewed ITEM_MEDIA assets to billable catalog items for public display.
ALTER TABLE zzsh_supply.billable_item ADD COLUMN media_id text;
ALTER TABLE zzsh_supply.billable_item ADD CONSTRAINT billable_item_media_fk FOREIGN KEY ("media_id") REFERENCES "zzsh_supply"."media_asset"("id");
