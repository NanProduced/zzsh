-- M3E: game/service support gates and the fixed Delta gunsmith domain.
-- This is additive. Existing rental, catalog, listing and historical rows are
-- not rewritten or re-priced.
CREATE TABLE IF NOT EXISTS "zzsh_supply"."game_service_operation" (
  "id" text PRIMARY KEY,
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "service_code" text NOT NULL CHECK ("service_code" IN ('ACCOUNT_RENTAL', 'GUNSMITH')),
  "enabled" boolean NOT NULL DEFAULT false,
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "game_service_operation_unique" UNIQUE ("game_id", "service_code")
);

INSERT INTO "zzsh_supply"."game_service_operation" ("id", "game_id", "service_code", "enabled")
SELECT g."id" || ':service:' || service_code, g."id", service_code,
       (g."code" = 'delta' AND service_code = 'ACCOUNT_RENTAL' AND g."enabled")
  FROM "zzsh_supply"."game" g
 CROSS JOIN (VALUES ('ACCOUNT_RENTAL'::text), ('GUNSMITH'::text)) services(service_code)
ON CONFLICT ("game_id", "service_code") DO NOTHING;

CREATE INDEX IF NOT EXISTS "game_service_operation_game_idx"
  ON "zzsh_supply"."game_service_operation" ("game_id", "service_code");

CREATE TABLE IF NOT EXISTS "zzsh_supply"."firearm_classification" (
  "id" text PRIMARY KEY,
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "code" text NOT NULL CHECK ("code" ~ '^[a-z][a-z0-9_:-]{1,63}$'),
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 120),
  "enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0 CHECK ("sort_order" BETWEEN -100000 AND 100000),
  "source_namespace" text,
  "source_token" text,
  "source_note" text CHECK ("source_note" IS NULL OR char_length("source_note") <= 500),
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "created_by_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "updated_by_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "firearm_classification_game_code_unique" UNIQUE ("game_id", "code"),
  CONSTRAINT "firearm_classification_game_id_unique" UNIQUE ("game_id", "id"),
  CONSTRAINT "firearm_classification_source_shape" CHECK (("source_namespace" IS NULL) = ("source_token" IS NULL))
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."firearm" (
  "id" text PRIMARY KEY,
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "code" text NOT NULL CHECK ("code" ~ '^[a-z][a-z0-9_:-]{1,63}$'),
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 120),
  "classification_id" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0 CHECK ("sort_order" BETWEEN -100000 AND 100000),
  "media_id" text,
  "source_namespace" text,
  "source_token" text,
  "source_note" text CHECK ("source_note" IS NULL OR char_length("source_note") <= 500),
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "created_by_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "updated_by_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "firearm_game_code_unique" UNIQUE ("game_id", "code"),
  CONSTRAINT "firearm_game_id_unique" UNIQUE ("game_id", "id"),
  CONSTRAINT "firearm_classification_same_game_fk" FOREIGN KEY ("game_id", "classification_id")
    REFERENCES "zzsh_supply"."firearm_classification" ("game_id", "id"),
  CONSTRAINT "firearm_source_shape" CHECK (("source_namespace" IS NULL) = ("source_token" IS NULL))
);

CREATE INDEX IF NOT EXISTS "firearm_game_sort_idx"
  ON "zzsh_supply"."firearm" ("game_id", "updated_at" DESC, "id" DESC);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."firearm_alias" (
  "id" text PRIMARY KEY,
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "firearm_id" text NOT NULL,
  "locale" text NOT NULL DEFAULT 'zh-CN' CHECK (char_length("locale") BETWEEN 2 AND 32),
  "name" text NOT NULL CHECK (char_length("name") BETWEEN 1 AND 120),
  "enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0 CHECK ("sort_order" BETWEEN -100000 AND 100000),
  "source_namespace" text,
  "source_token" text,
  "source_note" text CHECK ("source_note" IS NULL OR char_length("source_note") <= 500),
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "created_by_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "updated_by_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "firearm_alias_same_game_fk" FOREIGN KEY ("game_id", "firearm_id")
    REFERENCES "zzsh_supply"."firearm" ("game_id", "id"),
  CONSTRAINT "firearm_alias_unique" UNIQUE ("game_id", "firearm_id", "locale", "name"),
  CONSTRAINT "firearm_alias_source_shape" CHECK (("source_namespace" IS NULL) = ("source_token" IS NULL))
);

CREATE INDEX IF NOT EXISTS "firearm_alias_search_idx"
  ON "zzsh_supply"."firearm_alias" ("game_id", "firearm_id", "enabled", "name");

CREATE TABLE IF NOT EXISTS "zzsh_supply"."gunsmith_code" (
  "id" text PRIMARY KEY,
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "firearm_id" text NOT NULL,
  "code" text NOT NULL CHECK (
    char_length("code") BETWEEN 4 AND 1024
    AND "code" = btrim("code")
    AND "code" !~ '[[:cntrl:]]'
  ),
  "note" text NOT NULL DEFAULT '' CHECK (char_length("note") <= 500),
  "mode_code" text CHECK ("mode_code" IS NULL OR "mode_code" IN ('HAZARD', 'BATTLEFIELD', 'GENERAL')),
  "status" text NOT NULL DEFAULT 'ACTIVE' CHECK ("status" IN ('ACTIVE', 'WITHDRAWN')),
  "last_reviewed_at" timestamptz,
  "source_namespace" text,
  "source_token" text,
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "created_by_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "updated_by_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "gunsmith_code_same_game_fk" FOREIGN KEY ("game_id", "firearm_id")
    REFERENCES "zzsh_supply"."firearm" ("game_id", "id"),
  CONSTRAINT "gunsmith_code_source_shape" CHECK (("source_namespace" IS NULL) = ("source_token" IS NULL))
);

CREATE INDEX IF NOT EXISTS "gunsmith_code_public_idx"
  ON "zzsh_supply"."gunsmith_code" ("game_id", "firearm_id", "status", "updated_at" DESC, "id" DESC);
CREATE UNIQUE INDEX IF NOT EXISTS "gunsmith_code_source_unique"
  ON "zzsh_supply"."gunsmith_code" ("game_id", "source_namespace", "source_token")
  WHERE "source_namespace" IS NOT NULL AND "source_token" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "media_asset_game_id_unique"
  ON "zzsh_supply"."media_asset" ("game_id", "id");

ALTER TABLE "zzsh_supply"."media_upload_intent" DROP CONSTRAINT "media_upload_intent_purpose_check";
ALTER TABLE "zzsh_supply"."media_upload_intent" ADD CONSTRAINT "media_upload_intent_purpose_check"
  CHECK ("purpose" IN ('GAME_COVER', 'SKIN_MEDIA', 'ITEM_MEDIA', 'ACCOUNT_EVIDENCE', 'ACCOUNT_DISPLAY', 'CONTENT_MEDIA', 'FIREARM_MEDIA'));
ALTER TABLE "zzsh_supply"."media_asset" DROP CONSTRAINT "media_asset_purpose_check";
ALTER TABLE "zzsh_supply"."media_asset" ADD CONSTRAINT "media_asset_purpose_check"
  CHECK ("purpose" IN ('GAME_COVER', 'SKIN_MEDIA', 'ITEM_MEDIA', 'ACCOUNT_EVIDENCE', 'ACCOUNT_DISPLAY', 'CONTENT_MEDIA', 'FIREARM_MEDIA'));

ALTER TABLE "zzsh_supply"."media_upload_intent" DROP CONSTRAINT "media_upload_intent_actor_shape";
ALTER TABLE "zzsh_supply"."media_upload_intent" ADD CONSTRAINT "media_upload_intent_actor_shape" CHECK (
  ("uploaded_by_realm" = 'admin' AND "ownership_kind" = 'PLATFORM_CATALOG'
    AND "purpose" IN ('GAME_COVER', 'SKIN_MEDIA', 'ITEM_MEDIA', 'FIREARM_MEDIA')
    AND "game_id" IS NOT NULL AND "owner_user_id" IS NULL AND "uploaded_by_admin_id" IS NOT NULL
    AND "uploaded_by_user_id" IS NULL AND "account_id" IS NULL)
  OR ("uploaded_by_realm" = 'admin' AND "ownership_kind" = 'PLATFORM_CONTENT'
    AND "purpose" = 'CONTENT_MEDIA' AND "game_id" IS NULL AND "owner_user_id" IS NULL
    AND "uploaded_by_admin_id" IS NOT NULL AND "uploaded_by_user_id" IS NULL AND "account_id" IS NULL)
  OR ("uploaded_by_realm" = 'user' AND "ownership_kind" = 'USER_SUPPLY'
    AND "purpose" IN ('ACCOUNT_EVIDENCE', 'ACCOUNT_DISPLAY') AND "game_id" IS NOT NULL
    AND "owner_user_id" = "uploaded_by_user_id" AND "uploaded_by_admin_id" IS NULL
    AND "owner_user_id" IS NOT NULL AND "account_id" IS NOT NULL)
);
ALTER TABLE "zzsh_supply"."media_asset" DROP CONSTRAINT "media_asset_actor_shape";
ALTER TABLE "zzsh_supply"."media_asset" ADD CONSTRAINT "media_asset_actor_shape" CHECK (
  ("uploaded_by_realm" = 'admin' AND "ownership_kind" = 'PLATFORM_CATALOG'
    AND "purpose" IN ('GAME_COVER', 'SKIN_MEDIA', 'ITEM_MEDIA', 'FIREARM_MEDIA')
    AND "game_id" IS NOT NULL AND "owner_user_id" IS NULL AND "uploaded_by_admin_id" IS NOT NULL
    AND "uploaded_by_user_id" IS NULL)
  OR ("uploaded_by_realm" = 'admin' AND "ownership_kind" = 'PLATFORM_CONTENT'
    AND "purpose" = 'CONTENT_MEDIA' AND "game_id" IS NULL AND "owner_user_id" IS NULL
    AND "uploaded_by_admin_id" IS NOT NULL AND "uploaded_by_user_id" IS NULL)
  OR ("uploaded_by_realm" = 'user' AND "ownership_kind" = 'USER_SUPPLY'
    AND "purpose" IN ('ACCOUNT_EVIDENCE', 'ACCOUNT_DISPLAY') AND "game_id" IS NOT NULL
    AND "owner_user_id" = "uploaded_by_user_id" AND "uploaded_by_admin_id" IS NULL
    AND "owner_user_id" IS NOT NULL)
);

ALTER TABLE "zzsh_supply"."firearm"
  ADD CONSTRAINT "firearm_media_same_game_fk" FOREIGN KEY ("game_id", "media_id")
    REFERENCES "zzsh_supply"."media_asset"("game_id", "id");

INSERT INTO "zzsh_iam"."admin_permission" ("code", "name", "description") VALUES
  ('supply.gunsmith.manage', '维护改枪码目录', '按游戏对象范围维护固定枪械目录、分类、别名与改枪码')
ON CONFLICT ("code") DO NOTHING;
