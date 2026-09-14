-- M3E follow-up: source identity is stable per game and entity table.
-- Preflight is intentional: an existing duplicate blocks this migration and
-- must be resolved by an explicit mapping decision; it is never merged here.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "zzsh_supply"."firearm"
     WHERE "source_namespace" IS NOT NULL AND "source_token" IS NOT NULL
     GROUP BY "game_id", "source_namespace", "source_token"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate firearm source mappings require an explicit preflight resolution';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "zzsh_supply"."firearm_classification"
     WHERE "source_namespace" IS NOT NULL AND "source_token" IS NOT NULL
     GROUP BY "game_id", "source_namespace", "source_token"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate firearm classification source mappings require an explicit preflight resolution';
  END IF;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM "zzsh_supply"."firearm_alias"
     WHERE "source_namespace" IS NOT NULL AND "source_token" IS NOT NULL
     GROUP BY "game_id", "source_namespace", "source_token"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'duplicate firearm alias source mappings require an explicit preflight resolution';
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "firearm_source_unique"
  ON "zzsh_supply"."firearm" ("game_id", "source_namespace", "source_token")
  WHERE "source_namespace" IS NOT NULL AND "source_token" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "firearm_classification_source_unique"
  ON "zzsh_supply"."firearm_classification" ("game_id", "source_namespace", "source_token")
  WHERE "source_namespace" IS NOT NULL AND "source_token" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "firearm_alias_source_unique"
  ON "zzsh_supply"."firearm_alias" ("game_id", "source_namespace", "source_token")
  WHERE "source_namespace" IS NOT NULL AND "source_token" IS NOT NULL;
