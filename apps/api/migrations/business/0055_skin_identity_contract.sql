-- SKIN-1B-IMP-1 candidate 0055; not yet applied or PG-verified.
-- Requires the matching API and post-migration runtime column grants.
-- Baseline 0..54 is immutable. No data imports or namespace backfill.

LOCK TABLE zzsh_supply.skin IN SHARE ROW EXCLUSIVE MODE;

-- Pure row-value validators. No cross-table CHECK functions.
CREATE FUNCTION zzsh_supply.skin_text_valid(value text, max_chars integer, canonical boolean)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog AS $$
  SELECT value IS NOT NULL
    AND char_length(value) BETWEEN 1 AND max_chars
    AND btrim(value, E' \t\n\r\f\013') <> ''
    AND (NOT canonical OR value = btrim(value, E' \t\n\r\f\013'))
$$;

CREATE FUNCTION zzsh_supply.skin_aliases_valid(value text[])
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE
SET search_path = pg_catalog AS $$
  SELECT value IS NOT NULL
    AND cardinality(value) <= 32
    AND (cardinality(value) = 0 OR (array_ndims(value) = 1 AND array_lower(value, 1) = 1))
    AND NOT EXISTS (
      SELECT 1 FROM unnest(value) AS a(name)
      WHERE NOT zzsh_supply.skin_text_valid(name, 200, true)
    )
    AND cardinality(value) = (SELECT count(DISTINCT name COLLATE "C") FROM unnest(value) AS a(name))
$$;

-- Invalid legacy values block, without printing or correcting the values.
-- Duplicate old field/token pairs are ambiguous even without a known namespace:
-- stop for a reviewed disposition, never guess that they share a namespace.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM zzsh_supply.skin
    WHERE NOT zzsh_supply.skin_text_valid(name, 120, true)
       OR (source_field IS NULL) <> (source_token IS NULL)
       OR (source_field IS NOT NULL AND NOT zzsh_supply.skin_text_valid(source_field, 64, true))
       OR (source_token IS NOT NULL AND NOT zzsh_supply.skin_text_valid(source_token, 200, false))
  ) THEN
    RAISE EXCEPTION 'SKIN_PREFLIGHT_DIRTY_LEGACY_FIELDS';
  END IF;
  IF EXISTS (
    SELECT 1 FROM zzsh_supply.skin
    WHERE source_field IS NOT NULL AND source_token IS NOT NULL
    GROUP BY game_id, source_field COLLATE "C", source_token COLLATE "C"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'SKIN_PREFLIGHT_AMBIGUOUS_LEGACY_SOURCE';
  END IF;
END $$;

CREATE TABLE zzsh_supply.skin_owner (
  id text PRIMARY KEY CHECK (zzsh_supply.skin_text_valid(id, 128, true)),
  game_id text NOT NULL REFERENCES zzsh_supply.game(id),
  kind text NOT NULL CHECK (kind IN ('AGENT', 'MELEE_TYPE')),
  code text NOT NULL CHECK (char_length(code) BETWEEN 2 AND 64 AND code ~ '^[a-z][a-z0-9_:-]{1,63}$'),
  name text NOT NULL CHECK (zzsh_supply.skin_text_valid(name, 120, true)),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT skin_owner_game_kind_code_unique UNIQUE (game_id, kind, code),
  CONSTRAINT skin_owner_game_kind_id_unique UNIQUE (game_id, kind, id)
);

-- Constant defaults preserve old name/enabled/form_visible/source values.
-- Existing rows become LEGACY; only the future INSERT default becomes PENDING.
ALTER TABLE zzsh_supply.skin
  ADD COLUMN owner_kind text,
  ADD COLUMN owner_id text,
  ADD COLUMN firearm_id text,
  ADD COLUMN base_name text,
  ADD COLUMN aliases text[] NOT NULL DEFAULT ARRAY[]::text[],
  ADD COLUMN source_namespace text,
  ADD COLUMN naming_state text NOT NULL DEFAULT 'LEGACY';
ALTER TABLE zzsh_supply.skin ALTER COLUMN naming_state SET DEFAULT 'PENDING';
ALTER TABLE zzsh_supply.skin ALTER COLUMN enabled SET DEFAULT false;
ALTER TABLE zzsh_supply.skin ALTER COLUMN form_visible SET DEFAULT false;

ALTER TABLE zzsh_supply.skin
  ADD CONSTRAINT skin_name_valid CHECK (zzsh_supply.skin_text_valid(name, 120, true)),
  ADD CONSTRAINT skin_base_name_valid CHECK (base_name IS NULL OR zzsh_supply.skin_text_valid(base_name, 120, true)),
  ADD CONSTRAINT skin_aliases_valid CHECK (zzsh_supply.skin_aliases_valid(aliases)),
  ADD CONSTRAINT skin_owner_shape CHECK ((
    (owner_kind IS NULL AND owner_id IS NULL AND firearm_id IS NULL)
    OR (owner_kind IN ('AGENT', 'MELEE_TYPE') AND owner_id IS NOT NULL AND firearm_id IS NULL)
    OR (owner_kind = 'FIREARM' AND owner_id IS NULL AND firearm_id IS NOT NULL)
  ) IS TRUE),
  ADD CONSTRAINT skin_owner_same_game_kind_fk FOREIGN KEY (game_id, owner_kind, owner_id)
    REFERENCES zzsh_supply.skin_owner(game_id, kind, id) ON DELETE RESTRICT,
  ADD CONSTRAINT skin_firearm_same_game_fk FOREIGN KEY (game_id, firearm_id)
    REFERENCES zzsh_supply.firearm(game_id, id) ON DELETE RESTRICT,
  ADD CONSTRAINT skin_naming_state_shape CHECK ((
    (naming_state IN ('LEGACY', 'PENDING') AND owner_kind IS NULL AND base_name IS NULL)
    OR (naming_state = 'VERIFIED' AND owner_kind IS NOT NULL AND base_name IS NOT NULL)
  ) IS TRUE),
  ADD CONSTRAINT skin_pending_disabled CHECK (naming_state <> 'PENDING' OR (NOT enabled AND NOT form_visible)),
  ADD CONSTRAINT skin_source_shape CHECK ((
    (source_namespace IS NULL AND source_field IS NULL AND source_token IS NULL)
    OR (naming_state = 'LEGACY' AND source_namespace IS NULL AND source_field IS NOT NULL AND source_token IS NOT NULL)
    OR (source_namespace IS NOT NULL AND source_field IS NOT NULL AND source_token IS NOT NULL)
  ) IS TRUE),
  ADD CONSTRAINT skin_source_namespace_valid CHECK (source_namespace IS NULL OR zzsh_supply.skin_text_valid(source_namespace, 64, true)),
  ADD CONSTRAINT skin_source_field_valid CHECK (source_field IS NULL OR zzsh_supply.skin_text_valid(source_field, 64, true)),
  ADD CONSTRAINT skin_source_token_valid CHECK (source_token IS NULL OR zzsh_supply.skin_text_valid(source_token, 200, false));

-- Disabled skins participate. Raw token equality is exact, not normalized.
CREATE UNIQUE INDEX skin_source_identity_unique
  ON zzsh_supply.skin (game_id, source_namespace COLLATE "C", source_field COLLATE "C", source_token COLLATE "C")
  WHERE source_namespace IS NOT NULL;

-- Lifecycle guard and write-time name check. This is NOT a CHECK on other tables.
-- naming_state is excluded from runtime INSERT/UPDATE column grants.
-- The trusted authorized API supplies the complete reviewed tuple only after
-- confirmIdentity/reason/evidence checks. The trigger derives VERIFIED; it does
-- NOT authenticate people, validate official evidence, or replace API RBAC.
CREATE FUNCTION zzsh_supply.guard_skin_identity_write()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  object_name text;
  object_enabled boolean;
  relation_changed boolean;
  identity_changed boolean;
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
  IF NEW.owner_kind IS NOT NULL AND NEW.base_name IS NOT NULL THEN
    NEW.naming_state := 'VERIFIED';
  END IF;
  IF OLD.naming_state = 'VERIFIED' AND (NEW.owner_kind IS NULL OR NEW.base_name IS NULL) THEN
    RAISE EXCEPTION 'SKIN_VERIFIED_IDENTITY_CANNOT_BE_CLEARED';
  END IF;
  IF OLD.naming_state = 'LEGACY' AND NEW.naming_state = 'LEGACY' AND
     ((NOT OLD.enabled AND NEW.enabled) OR (NOT OLD.form_visible AND NEW.form_visible)) THEN
    RAISE EXCEPTION 'SKIN_LEGACY_REENABLE_REQUIRES_REVIEW';
  END IF;

  IF NEW.naming_state = 'VERIFIED' AND
     (OLD.naming_state <> 'VERIFIED' OR identity_changed OR NEW.name IS DISTINCT FROM OLD.name) THEN
    IF NEW.owner_kind = 'FIREARM' THEN
      SELECT name, enabled INTO object_name, object_enabled
        FROM zzsh_supply.firearm WHERE game_id = NEW.game_id AND id = NEW.firearm_id;
    ELSE
      SELECT name, enabled INTO object_name, object_enabled
        FROM zzsh_supply.skin_owner WHERE game_id = NEW.game_id AND kind = NEW.owner_kind AND id = NEW.owner_id;
    END IF;
    IF object_name IS NULL THEN RAISE EXCEPTION 'SKIN_OWNER_NOT_FOUND'; END IF;
    IF (OLD.naming_state <> 'VERIFIED' OR relation_changed) AND NOT object_enabled THEN
      RAISE EXCEPTION 'SKIN_OWNER_DISABLED';
    END IF;
    IF NEW.name IS DISTINCT FROM object_name || '-' || NEW.base_name THEN
      RAISE EXCEPTION 'SKIN_DISPLAY_NAME_MISMATCH';
    END IF;
  END IF;
  IF NEW.name IS DISTINCT FROM OLD.name AND NOT (OLD.name = ANY(NEW.aliases)) THEN
    RAISE EXCEPTION 'SKIN_RENAME_MUST_KEEP_OLD_ALIAS';
  END IF;
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

CREATE TRIGGER skin_identity_write_guard BEFORE INSERT OR UPDATE ON zzsh_supply.skin
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_skin_identity_write();

-- No security-definer routine, permission grants, data seeding, or hard deletes.
-- The runtime role must not own tables/functions or have CREATE/TRIGGER rights.
-- The runner's blanket GRANT must be followed by the column grants implemented
-- in src/database/business-migrations.ts. Merely appending this DDL is NOT the complete implementation.
