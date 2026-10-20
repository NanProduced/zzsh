-- Catalog facts evolve independently of immutable account presentation snapshots.
ALTER TABLE zzsh_supply.skin
  ADD COLUMN rarity_evidence jsonb,
  ADD COLUMN is_collectible boolean,
  ADD COLUMN default_state text NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN media_source jsonb;
--> statement-breakpoint
ALTER TABLE zzsh_supply.skin DROP CONSTRAINT skin_owner_shape;
ALTER TABLE zzsh_supply.skin ADD CONSTRAINT skin_owner_shape CHECK ((
  (owner_kind IS NULL AND owner_id IS NULL AND firearm_id IS NULL)
  OR (owner_kind = 'AGENT' AND owner_id IS NOT NULL AND firearm_id IS NULL)
  OR (owner_kind = 'MELEE_TYPE' AND firearm_id IS NULL)
  OR (owner_kind = 'FIREARM' AND owner_id IS NULL AND firearm_id IS NOT NULL)
) IS TRUE);
--> statement-breakpoint
ALTER TABLE zzsh_supply.skin
  ADD CONSTRAINT skin_default_state_valid CHECK (default_state IN ('UNKNOWN','DEFAULT','NON_DEFAULT')),
  ADD CONSTRAINT skin_rarity_evidence_shape CHECK (
    rarity_evidence IS NULL OR (
      rarity_code IS NOT NULL
      AND jsonb_typeof(rarity_evidence) = 'object'
      AND rarity_evidence ?& ARRAY['schema','basis','sourceName','references']
      AND rarity_evidence - ARRAY['schema','basis','sourceName','references'] = '{}'::jsonb
      AND rarity_evidence->>'schema' = 'skin-rarity-evidence-v1'
      AND rarity_evidence->>'basis' IN ('PLATFORM_REFERENCE','OFFICIAL')
      AND jsonb_typeof(rarity_evidence->'sourceName') = 'string'
      AND length(btrim(rarity_evidence->>'sourceName')) BETWEEN 1 AND 100
      AND CASE WHEN jsonb_typeof(rarity_evidence->'references') = 'array'
        THEN jsonb_array_length(rarity_evidence->'references') BETWEEN 1 AND 8 ELSE false END
    ) IS TRUE
  ),
  ADD CONSTRAINT skin_media_source_shape CHECK (
    media_source IS NULL OR (
      media_id IS NOT NULL
      AND jsonb_typeof(media_source) = 'object'
      AND media_source ?& ARRAY['schema','kind','sourceName','url']
      AND media_source - ARRAY['schema','kind','sourceName','url'] = '{}'::jsonb
      AND media_source->>'schema' = 'skin-media-source-v1'
      AND media_source->>'kind' IN ('PORTRAIT_CARD','MODEL_IMAGE','PROMO_POSTER')
      AND jsonb_typeof(media_source->'sourceName') = 'string'
      AND length(btrim(media_source->>'sourceName')) BETWEEN 1 AND 100
      AND jsonb_typeof(media_source->'url') = 'string'
      AND length(media_source->>'url') BETWEEN 1 AND 2000
      AND media_source->>'url' ~ '^https://[^[:space:]]+$'
    ) IS TRUE
  );
--> statement-breakpoint
CREATE OR REPLACE FUNCTION zzsh_supply.guard_skin_identity_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  object_name text;
  object_enabled boolean;
  relation_changed boolean;
  identity_changed boolean;
  unclassified_melee boolean;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.naming_state <> 'PENDING' OR NEW.owner_kind IS NOT NULL OR NEW.base_name IS NOT NULL THEN
      RAISE EXCEPTION 'SKIN_CREATE_DRAFT_FIRST';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW.id, NEW.game_id, NEW.code, NEW.created_at) IS DISTINCT FROM (OLD.id, OLD.game_id, OLD.code, OLD.created_at) THEN
    RAISE EXCEPTION 'SKIN_STABLE_IDENTITY_IMMUTABLE';
  END IF;
  IF NEW.naming_state IS DISTINCT FROM OLD.naming_state THEN
    RAISE EXCEPTION 'SKIN_NAMING_STATE_IS_DERIVED';
  END IF;
  IF OLD.source_namespace IS NOT NULL AND
     (NEW.source_namespace, NEW.source_field, NEW.source_token) IS DISTINCT FROM (OLD.source_namespace, OLD.source_field, OLD.source_token) THEN
    RAISE EXCEPTION 'SKIN_PRIMARY_SOURCE_IMMUTABLE';
  END IF;
  IF OLD.source_namespace IS NULL AND OLD.source_field IS NOT NULL AND
     (NEW.source_field, NEW.source_token) IS DISTINCT FROM (OLD.source_field, OLD.source_token) THEN
    RAISE EXCEPTION 'SKIN_LEGACY_SOURCE_MUST_BE_PRESERVED';
  END IF;
  relation_changed := (NEW.owner_kind, NEW.owner_id, NEW.firearm_id) IS DISTINCT FROM (OLD.owner_kind, OLD.owner_id, OLD.firearm_id);
  identity_changed := relation_changed OR NEW.base_name IS DISTINCT FROM OLD.base_name;
  IF NEW.owner_kind IS NOT NULL AND NEW.base_name IS NOT NULL THEN NEW.naming_state := 'VERIFIED'; END IF;
  IF OLD.naming_state = 'VERIFIED' AND (NEW.owner_kind IS NULL OR NEW.base_name IS NULL) THEN
    RAISE EXCEPTION 'SKIN_VERIFIED_IDENTITY_CANNOT_BE_CLEARED';
  END IF;
  IF OLD.naming_state = 'LEGACY' AND NEW.naming_state = 'LEGACY' AND
     ((NOT OLD.enabled AND NEW.enabled) OR (NOT OLD.form_visible AND NEW.form_visible)) THEN
    RAISE EXCEPTION 'SKIN_LEGACY_REENABLE_REQUIRES_REVIEW';
  END IF;
  IF NEW.naming_state = 'VERIFIED' AND
     (OLD.naming_state <> 'VERIFIED' OR identity_changed OR NEW.name IS DISTINCT FROM OLD.name) THEN
    unclassified_melee := NEW.owner_kind = 'MELEE_TYPE' AND NEW.owner_id IS NULL;
    IF unclassified_melee THEN
      object_name := ''; object_enabled := true;
    ELSIF NEW.owner_kind = 'FIREARM' THEN
      SELECT name, enabled INTO object_name, object_enabled
        FROM zzsh_supply.firearm WHERE game_id = NEW.game_id AND id = NEW.firearm_id;
    ELSE
      SELECT name, enabled INTO object_name, object_enabled
        FROM zzsh_supply.skin_owner WHERE game_id = NEW.game_id AND kind = NEW.owner_kind AND id = NEW.owner_id;
    END IF;
    IF object_name IS NULL THEN RAISE EXCEPTION 'SKIN_OWNER_NOT_FOUND'; END IF;
    IF (OLD.naming_state <> 'VERIFIED' OR relation_changed) AND NOT object_enabled THEN RAISE EXCEPTION 'SKIN_OWNER_DISABLED'; END IF;
    IF NEW.name IS DISTINCT FROM (CASE WHEN unclassified_melee THEN NEW.base_name ELSE object_name || '-' || NEW.base_name END) THEN
      RAISE EXCEPTION 'SKIN_DISPLAY_NAME_MISMATCH';
    END IF;
  END IF;
  IF NEW.name IS DISTINCT FROM OLD.name AND NOT (OLD.name = ANY(NEW.aliases)) THEN RAISE EXCEPTION 'SKIN_RENAME_MUST_KEEP_OLD_ALIAS'; END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;
