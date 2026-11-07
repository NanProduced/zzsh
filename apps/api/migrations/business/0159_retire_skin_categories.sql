-- Existing populated catalogues require a separately reviewed archival upgrade.
DO $skin_retirement$
DECLARE category_table boolean; category_column boolean;
BEGIN
  IF to_regclass('zzsh_supply.skin') IS NULL OR to_regclass('zzsh_supply.game') IS NULL
     OR to_regclass('zzsh_supply.listing_filter_config') IS NULL THEN
    RAISE EXCEPTION 'SKIN_CATEGORY_SCHEMA_INCOMPLETE';
  END IF;
  EXECUTE 'LOCK TABLE zzsh_supply.game, zzsh_supply.skin, zzsh_supply.listing_filter_config IN ACCESS EXCLUSIVE MODE';
  category_table := to_regclass('zzsh_supply.skin_category') IS NOT NULL;
  IF category_table THEN EXECUTE 'LOCK TABLE zzsh_supply.skin_category IN ACCESS EXCLUSIVE MODE'; END IF;
  SELECT EXISTS(SELECT 1 FROM pg_attribute WHERE attrelid='zzsh_supply.skin'::regclass
    AND attname='category_id' AND attnum>0 AND NOT attisdropped) INTO category_column;
  IF category_table IS DISTINCT FROM category_column THEN RAISE EXCEPTION 'SKIN_CATEGORY_SCHEMA_INCOMPLETE'; END IF;
  IF NOT category_table THEN RETURN; END IF;
  IF EXISTS(SELECT 1 FROM zzsh_supply.skin_category) OR EXISTS(SELECT 1 FROM zzsh_supply.skin) THEN
    RAISE EXCEPTION 'SKIN_CATEGORY_NONEMPTY_REQUIRES_ARCHIVE_PLAN';
  END IF;
  IF EXISTS (SELECT 1 FROM zzsh_supply.listing_filter_config f
    CROSS JOIN LATERAL jsonb_array_elements(f.config->'fields') AS field(value)
    WHERE field.value->>'key'='skinGroups' AND field.value ? 'categoryIds') THEN
    RAISE EXCEPTION 'SKIN_CATEGORY_FILTER_CONFIG_REQUIRES_MIGRATION_PLAN';
  END IF;
END $skin_retirement$;
--> statement-breakpoint
ALTER TABLE zzsh_supply.skin DROP COLUMN IF EXISTS category_id;
--> statement-breakpoint
DROP TABLE IF EXISTS zzsh_supply.skin_category;
--> statement-breakpoint
DROP FUNCTION IF EXISTS zzsh_supply.guard_skin_category_tree();
