CREATE SCHEMA IF NOT EXISTS "zzsh_supply";

CREATE TABLE IF NOT EXISTS "zzsh_supply"."game" (
  "id" text PRIMARY KEY,
  "code" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "description" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "catalog_revision" bigint NOT NULL DEFAULT 1 CHECK ("catalog_revision" > 0),
  "current_release_id" text,
  "cover_media_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "game_code_format" CHECK ("code" ~ '^[a-z][a-z0-9_:-]{1,63}$')
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."billable_item" (
  "id" text PRIMARY KEY,
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "code" text NOT NULL,
  "name" text NOT NULL,
  "unit" text NOT NULL CHECK ("unit" IN ('HAFF_BASE', 'ROUND', 'PIECE')),
  "quantity_scale" smallint NOT NULL DEFAULT 0 CHECK ("quantity_scale" >= 0 AND "quantity_scale" <= 6),
  "required" boolean NOT NULL DEFAULT false,
  "enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "source_field" text,
  "source_token" text,
  "source_note" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "billable_item_game_code_unique" UNIQUE ("game_id", "code"),
  CONSTRAINT "billable_item_code_format" CHECK ("code" ~ '^[a-z][a-z0-9_:-]{1,63}$')
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."skin_rarity" (
  "id" text PRIMARY KEY,
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "code" text NOT NULL,
  "name" text NOT NULL,
  "sort_order" integer NOT NULL DEFAULT 0,
  "enabled" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "skin_rarity_game_code_unique" UNIQUE ("game_id", "code"),
  CONSTRAINT "skin_rarity_code_format" CHECK ("code" ~ '^[a-z][a-z0-9_:-]{1,63}$')
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."skin_category" (
  "id" text PRIMARY KEY,
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "code" text NOT NULL,
  "name" text NOT NULL,
  "parent_id" text REFERENCES "zzsh_supply"."skin_category"("id"),
  "sort_order" integer NOT NULL DEFAULT 0,
  "enabled" boolean NOT NULL DEFAULT true,
  "form_visible" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "skin_category_game_code_unique" UNIQUE ("game_id", "code"),
  CONSTRAINT "skin_category_code_format" CHECK ("code" ~ '^[a-z][a-z0-9_:-]{1,63}$'),
  CONSTRAINT "skin_category_not_self" CHECK ("parent_id" IS NULL OR "parent_id" <> "id")
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."skin" (
  "id" text PRIMARY KEY,
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "code" text NOT NULL,
  "name" text NOT NULL,
  "category_id" text NOT NULL REFERENCES "zzsh_supply"."skin_category"("id"),
  "rarity_code" text,
  "enabled" boolean NOT NULL DEFAULT true,
  "form_visible" boolean NOT NULL DEFAULT true,
  "media_id" text,
  "sort_order" integer NOT NULL DEFAULT 0,
  "source_field" text,
  "source_token" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "skin_game_code_unique" UNIQUE ("game_id", "code"),
  CONSTRAINT "skin_code_format" CHECK ("code" ~ '^[a-z][a-z0-9_:-]{1,63}$')
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."entitlement" (
  "id" text PRIMARY KEY,
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "code" text NOT NULL,
  "name" text NOT NULL,
  "value_kind" text NOT NULL CHECK ("value_kind" IN ('FLAG', 'LEVEL', 'CAPACITY')),
  "expiry_kind" text NOT NULL CHECK ("expiry_kind" IN ('PERMANENT', 'TIMED')),
  "enabled" boolean NOT NULL DEFAULT true,
  "sort_order" integer NOT NULL DEFAULT 0,
  "source_field" text,
  "source_token" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "entitlement_game_code_unique" UNIQUE ("game_id", "code"),
  CONSTRAINT "entitlement_code_format" CHECK ("code" ~ '^[a-z][a-z0-9_:-]{1,63}$')
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."rental_account" (
  "id" text PRIMARY KEY,
  "owner_user_id" text NOT NULL REFERENCES "zzsh_auth_user"."user"("id"),
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "display_no" text,
  "lifecycle" text NOT NULL DEFAULT 'ACTIVE' CHECK ("lifecycle" IN ('ACTIVE', 'ARCHIVED')),
  "owner_paused" boolean NOT NULL DEFAULT false,
  "staff_restricted" boolean NOT NULL DEFAULT false,
  "restriction_reason" text,
  "current_version_id" text,
  "legacy_hold" text NOT NULL DEFAULT 'NONE' CHECK ("legacy_hold" IN ('NONE', 'UNRESOLVED', 'ACTIVE_LEGACY')),
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rental_account_restriction_reason" CHECK (NOT "staff_restricted" OR "restriction_reason" IS NOT NULL)
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."price_version" (
  "id" text PRIMARY KEY,
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "mode" text NOT NULL CHECK ("mode" IN ('SPREAD', 'PERCENT')),
  "status" text NOT NULL DEFAULT 'DRAFT' CHECK ("status" IN ('DRAFT', 'SEALED')),
  "commission_rate" numeric(12, 8),
  "haff_rule" jsonb,
  "rounding_policy" text NOT NULL DEFAULT 'HALF_UP_CENT_V1',
  "compensation_policy_ref" text,
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "created_by_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "sealed_by_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "sealed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "price_version_mode_amounts" CHECK (
    ("mode" = 'SPREAD' AND "commission_rate" IS NULL)
    OR ("mode" = 'PERCENT' AND "commission_rate" IS NOT NULL AND "commission_rate" >= 0 AND "commission_rate" < 1)
  ),
  CONSTRAINT "price_version_haff_rule_shape" CHECK (
    "haff_rule" IS NULL OR (jsonb_typeof("haff_rule") = 'object' AND "haff_rule" ->> 'schema' = 'haff-ratio-v1')
  ),
  CONSTRAINT "price_version_sealed_shape" CHECK (
    "status" = 'DRAFT' OR ("sealed_at" IS NOT NULL AND "sealed_by_admin_id" IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."price_line" (
  "id" text PRIMARY KEY,
  "price_version_id" text NOT NULL REFERENCES "zzsh_supply"."price_version"("id"),
  "item_id" text NOT NULL REFERENCES "zzsh_supply"."billable_item"("id"),
  "customer_tier" text NOT NULL DEFAULT 'STANDARD' CHECK ("customer_tier" = 'STANDARD'),
  "pricing_kind" text NOT NULL CHECK ("pricing_kind" IN ('FIXED_UNIT', 'HAFF_RATIO')),
  "unit_quantity" numeric(24, 0),
  "buyer_unit_amount" numeric(24, 8),
  "owner_unit_amount" numeric(24, 8),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "price_line_version_item_tier_unique" UNIQUE ("price_version_id", "item_id", "customer_tier"),
  CONSTRAINT "price_line_amounts_non_negative" CHECK (
    ("buyer_unit_amount" IS NULL OR "buyer_unit_amount" >= 0)
    AND ("owner_unit_amount" IS NULL OR "owner_unit_amount" >= 0)
  )
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."term_version" (
  "id" text PRIMARY KEY,
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "status" text NOT NULL DEFAULT 'DRAFT' CHECK ("status" IN ('DRAFT', 'SEALED')),
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "created_by_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "sealed_by_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "sealed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "term_version_sealed_shape" CHECK (
    "status" = 'DRAFT' OR ("sealed_at" IS NOT NULL AND "sealed_by_admin_id" IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."term_option" (
  "id" text PRIMARY KEY,
  "version_id" text NOT NULL REFERENCES "zzsh_supply"."term_version"("id"),
  "code" text NOT NULL,
  "name" text NOT NULL,
  "daily_consumption" numeric(24, 0) NOT NULL CHECK ("daily_consumption" > 0),
  "duration_rounding" text NOT NULL DEFAULT 'CEIL_DAY' CHECK ("duration_rounding" IN ('CEIL_DAY')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "term_option_version_code_unique" UNIQUE ("version_id", "code"),
  CONSTRAINT "term_option_code_format" CHECK ("code" ~ '^[a-z][a-z0-9_:-]{1,63}$')
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."agreement_version" (
  "id" text PRIMARY KEY,
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "title" text NOT NULL,
  "body" text NOT NULL,
  "digest" text NOT NULL CHECK ("digest" ~ '^[0-9a-f]{64}$'),
  "status" text NOT NULL DEFAULT 'DRAFT' CHECK ("status" IN ('DRAFT', 'SEALED')),
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "created_by_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "sealed_by_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "sealed_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "agreement_version_body_size" CHECK (octet_length("body") <= 20000),
  CONSTRAINT "agreement_version_sealed_shape" CHECK (
    "status" = 'DRAFT' OR ("sealed_at" IS NOT NULL AND "sealed_by_admin_id" IS NOT NULL)
  )
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."rule_release" (
  "id" text PRIMARY KEY,
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "price_version_id" text NOT NULL REFERENCES "zzsh_supply"."price_version"("id"),
  "term_version_id" text NOT NULL REFERENCES "zzsh_supply"."term_version"("id"),
  "agreement_version_id" text NOT NULL REFERENCES "zzsh_supply"."agreement_version"("id"),
  "generation" bigint NOT NULL CHECK ("generation" > 0),
  "activated_by_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "activated_at" timestamptz NOT NULL DEFAULT now(),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rule_release_game_generation_unique" UNIQUE ("game_id", "generation")
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."rule_acceptance" (
  "id" text PRIMARY KEY,
  "owner_user_id" text NOT NULL REFERENCES "zzsh_auth_user"."user"("id"),
  "account_id" text NOT NULL REFERENCES "zzsh_supply"."rental_account"("id"),
  "listing_version_id" text NOT NULL,
  "rule_release_id" text NOT NULL REFERENCES "zzsh_supply"."rule_release"("id"),
  "accepted_content_hash" text NOT NULL CHECK ("accepted_content_hash" ~ '^[0-9a-f]{64}$'),
  "accepted_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "rule_acceptance_identity_unique" UNIQUE ("owner_user_id", "listing_version_id", "rule_release_id", "accepted_content_hash")
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."media_upload_intent" (
  "id" text PRIMARY KEY,
  "token_hash" text NOT NULL UNIQUE CHECK ("token_hash" ~ '^[0-9a-f]{64}$'),
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "account_id" text REFERENCES "zzsh_supply"."rental_account"("id"),
  "purpose" text NOT NULL CHECK ("purpose" IN ('GAME_COVER', 'SKIN_MEDIA', 'ITEM_MEDIA', 'ACCOUNT_EVIDENCE')),
  "ownership_kind" text NOT NULL CHECK ("ownership_kind" IN ('PLATFORM_CATALOG', 'USER_SUPPLY')),
  "owner_user_id" text REFERENCES "zzsh_auth_user"."user"("id"),
  "uploaded_by_realm" text NOT NULL CHECK ("uploaded_by_realm" IN ('admin', 'user')),
  "uploaded_by_user_id" text REFERENCES "zzsh_auth_user"."user"("id"),
  "uploaded_by_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "declared_mime" text NOT NULL CHECK ("declared_mime" IN ('image/jpeg', 'image/png', 'image/webp')),
  "declared_size" bigint NOT NULL CHECK ("declared_size" > 0 AND "declared_size" <= 10485760),
  "expires_at" timestamptz NOT NULL,
  "consumed_at" timestamptz,
  "consumed_asset_id" text,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "media_upload_intent_actor_shape" CHECK (
    ("uploaded_by_realm" = 'admin'
      AND "ownership_kind" = 'PLATFORM_CATALOG'
      AND "purpose" IN ('GAME_COVER', 'SKIN_MEDIA', 'ITEM_MEDIA')
      AND "owner_user_id" IS NULL
      AND "uploaded_by_admin_id" IS NOT NULL
      AND "uploaded_by_user_id" IS NULL
      AND "account_id" IS NULL)
    OR
    ("uploaded_by_realm" = 'user'
      AND "ownership_kind" = 'USER_SUPPLY'
      AND "purpose" = 'ACCOUNT_EVIDENCE'
      AND "owner_user_id" IS NOT NULL
      AND "uploaded_by_user_id" IS NOT NULL
      AND "uploaded_by_admin_id" IS NULL
      AND "account_id" IS NOT NULL)
  ),
  CONSTRAINT "media_upload_intent_consumed_shape" CHECK (
    ("consumed_at" IS NULL) = ("consumed_asset_id" IS NULL)
  )
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."media_asset" (
  "id" text PRIMARY KEY,
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "purpose" text NOT NULL CHECK ("purpose" IN ('GAME_COVER', 'SKIN_MEDIA', 'ITEM_MEDIA', 'ACCOUNT_EVIDENCE')),
  "ownership_kind" text NOT NULL CHECK ("ownership_kind" IN ('PLATFORM_CATALOG', 'USER_SUPPLY')),
  "owner_user_id" text REFERENCES "zzsh_auth_user"."user"("id"),
  "uploaded_by_realm" text NOT NULL CHECK ("uploaded_by_realm" IN ('admin', 'user')),
  "uploaded_by_user_id" text REFERENCES "zzsh_auth_user"."user"("id"),
  "uploaded_by_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "storage_key" text NOT NULL CHECK ("storage_key" ~ '^[0-9a-f]{64}$'),
  "content_hash" text NOT NULL CHECK ("content_hash" ~ '^[0-9a-f]{64}$'),
  "mime" text NOT NULL CHECK ("mime" IN ('image/jpeg', 'image/png', 'image/webp')),
  "byte_size" bigint NOT NULL CHECK ("byte_size" > 0 AND "byte_size" <= 10485760),
  "width" integer NOT NULL CHECK ("width" > 0 AND "width" <= 8192),
  "height" integer NOT NULL CHECK ("height" > 0 AND "height" <= 8192),
  "access_class" text NOT NULL DEFAULT 'PRIVATE_REVIEW' CHECK ("access_class" IN ('PUBLIC_DISPLAY', 'PRIVATE_REVIEW')),
  "review_state" text NOT NULL DEFAULT 'PENDING' CHECK ("review_state" IN ('PENDING', 'APPROVED', 'REJECTED', 'QUARANTINED')),
  "reviewed_by_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "reviewed_at" timestamptz,
  "review_reason" text,
  "source_note" text,
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "media_asset_actor_shape" CHECK (
    ("uploaded_by_realm" = 'admin'
      AND "ownership_kind" = 'PLATFORM_CATALOG'
      AND "purpose" IN ('GAME_COVER', 'SKIN_MEDIA', 'ITEM_MEDIA')
      AND "owner_user_id" IS NULL
      AND "uploaded_by_admin_id" IS NOT NULL
      AND "uploaded_by_user_id" IS NULL)
    OR
    ("uploaded_by_realm" = 'user'
      AND "ownership_kind" = 'USER_SUPPLY'
      AND "purpose" = 'ACCOUNT_EVIDENCE'
      AND "owner_user_id" IS NOT NULL
      AND "uploaded_by_user_id" IS NOT NULL
      AND "uploaded_by_admin_id" IS NULL)
  ),
  CONSTRAINT "media_asset_public_requires_approval" CHECK ("access_class" <> 'PUBLIC_DISPLAY' OR "review_state" = 'APPROVED'),
  CONSTRAINT "media_asset_review_shape" CHECK (
    ("review_state" = 'PENDING' AND "reviewed_by_admin_id" IS NULL AND "reviewed_at" IS NULL)
    OR ("review_state" <> 'PENDING' AND "reviewed_by_admin_id" IS NOT NULL AND "reviewed_at" IS NOT NULL)
  ),
  CONSTRAINT "media_asset_pixel_total" CHECK ("width"::bigint * "height"::bigint <= 40000000)
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."idempotency_record" (
  "scope_key" text NOT NULL,
  "key" text NOT NULL,
  "request_fingerprint" text NOT NULL CHECK ("request_fingerprint" ~ '^[0-9a-f]{64}$'),
  "response_status" integer NOT NULL,
  "response_body" jsonb NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("scope_key", "key")
);

CREATE TABLE IF NOT EXISTS "zzsh_supply"."admin_supply_scope" (
  "admin_user_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id") ON DELETE CASCADE,
  "game_id" text NOT NULL REFERENCES "zzsh_supply"."game"("id"),
  "granted_by_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("admin_user_id", "game_id")
);

ALTER TABLE "zzsh_supply"."game"
  ADD CONSTRAINT "game_current_release_fk" FOREIGN KEY ("current_release_id") REFERENCES "zzsh_supply"."rule_release"("id");

ALTER TABLE "zzsh_supply"."game"
  ADD CONSTRAINT "game_cover_media_fk" FOREIGN KEY ("cover_media_id") REFERENCES "zzsh_supply"."media_asset"("id");

ALTER TABLE "zzsh_supply"."skin"
  ADD CONSTRAINT "skin_media_fk" FOREIGN KEY ("media_id") REFERENCES "zzsh_supply"."media_asset"("id");

ALTER TABLE "zzsh_supply"."media_upload_intent"
  ADD CONSTRAINT "media_upload_intent_asset_fk" FOREIGN KEY ("consumed_asset_id") REFERENCES "zzsh_supply"."media_asset"("id");

CREATE INDEX IF NOT EXISTS "billable_item_game_idx" ON "zzsh_supply"."billable_item" ("game_id", "sort_order", "code");
CREATE INDEX IF NOT EXISTS "skin_category_game_idx" ON "zzsh_supply"."skin_category" ("game_id", "sort_order", "code");
CREATE INDEX IF NOT EXISTS "skin_game_category_idx" ON "zzsh_supply"."skin" ("game_id", "category_id", "sort_order", "code");
CREATE INDEX IF NOT EXISTS "entitlement_game_idx" ON "zzsh_supply"."entitlement" ("game_id", "sort_order", "code");
CREATE INDEX IF NOT EXISTS "price_version_game_status_idx" ON "zzsh_supply"."price_version" ("game_id", "status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "term_version_game_status_idx" ON "zzsh_supply"."term_version" ("game_id", "status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "agreement_version_game_status_idx" ON "zzsh_supply"."agreement_version" ("game_id", "status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "rule_release_game_generation_idx" ON "zzsh_supply"."rule_release" ("game_id", "generation" DESC);
CREATE INDEX IF NOT EXISTS "rental_account_owner_game_idx" ON "zzsh_supply"."rental_account" ("owner_user_id", "game_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "media_asset_review_idx" ON "zzsh_supply"."media_asset" ("review_state", "ownership_kind", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "media_asset_game_idx" ON "zzsh_supply"."media_asset" ("game_id", "purpose", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "admin_supply_scope_game_idx" ON "zzsh_supply"."admin_supply_scope" ("game_id", "admin_user_id");

CREATE OR REPLACE FUNCTION "zzsh_supply"."guard_skin_category_tree"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  cursor_id text;
  cursor_game text;
  cursor_parent text;
  levels integer := 0;
BEGIN
  IF NEW."parent_id" IS NULL THEN
    RETURN NEW;
  END IF;
  IF NEW."parent_id" = NEW."id" THEN
    RAISE EXCEPTION 'skin category cannot be its own parent';
  END IF;
  cursor_id := NEW."parent_id";
  WHILE cursor_id IS NOT NULL LOOP
    levels := levels + 1;
    IF levels > 2 THEN
      RAISE EXCEPTION 'skin category depth exceeds three levels';
    END IF;
    SELECT c."game_id", c."parent_id" INTO cursor_game, cursor_parent
      FROM "zzsh_supply"."skin_category" c WHERE c."id" = cursor_id;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'skin category parent does not exist';
    END IF;
    IF cursor_game <> NEW."game_id" THEN
      RAISE EXCEPTION 'skin category parent belongs to another game';
    END IF;
    IF cursor_parent = NEW."id" THEN
      RAISE EXCEPTION 'skin category cycle detected';
    END IF;
    cursor_id := cursor_parent;
  END LOOP;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "skin_category_tree_guard" ON "zzsh_supply"."skin_category";
CREATE TRIGGER "skin_category_tree_guard"
BEFORE INSERT OR UPDATE ON "zzsh_supply"."skin_category"
FOR EACH ROW EXECUTE FUNCTION "zzsh_supply"."guard_skin_category_tree"();

CREATE OR REPLACE FUNCTION "zzsh_supply"."guard_price_version_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'SEALED' THEN
    IF (NEW."status", NEW."game_id", NEW."mode", NEW."commission_rate", NEW."haff_rule",
        NEW."rounding_policy", NEW."compensation_policy_ref", NEW."revision",
        NEW."created_by_admin_id", NEW."created_at", NEW."sealed_at", NEW."sealed_by_admin_id")
       IS DISTINCT FROM
       (OLD."status", OLD."game_id", OLD."mode", OLD."commission_rate", OLD."haff_rule",
        OLD."rounding_policy", OLD."compensation_policy_ref", OLD."revision",
        OLD."created_by_admin_id", OLD."created_at", OLD."sealed_at", OLD."sealed_by_admin_id") THEN
      RAISE EXCEPTION 'sealed price version is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" = 'SEALED' THEN
    IF EXISTS (SELECT 1 FROM "zzsh_supply"."price_line" WHERE "price_version_id" = NEW."id" AND "pricing_kind" = 'HAFF_RATIO')
       AND NEW."haff_rule" IS NULL THEN
      RAISE EXCEPTION 'haff rule is required for haff ratio lines';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM "zzsh_supply"."price_line" WHERE "price_version_id" = NEW."id") THEN
      RAISE EXCEPTION 'price version requires at least one line';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "price_version_seal_guard" ON "zzsh_supply"."price_version";
CREATE TRIGGER "price_version_seal_guard"
BEFORE UPDATE ON "zzsh_supply"."price_version"
FOR EACH ROW EXECUTE FUNCTION "zzsh_supply"."guard_price_version_update"();

CREATE OR REPLACE FUNCTION "zzsh_supply"."guard_price_line_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  version_id text;
  parent_mode text;
  parent_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    version_id := OLD."price_version_id";
  ELSE
    version_id := NEW."price_version_id";
  END IF;
  SELECT "mode", "status" INTO parent_mode, parent_status
    FROM "zzsh_supply"."price_version" WHERE "id" = version_id;
  IF parent_status IS NULL THEN
    RAISE EXCEPTION 'price version does not exist';
  END IF;
  IF parent_status = 'SEALED' THEN
    RAISE EXCEPTION 'sealed price version lines are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  IF parent_mode = 'SPREAD' AND NEW."pricing_kind" = 'FIXED_UNIT' THEN
    IF NEW."unit_quantity" IS NULL OR NEW."unit_quantity" <= 0
       OR NEW."buyer_unit_amount" IS NULL OR NEW."owner_unit_amount" IS NULL
       OR NEW."owner_unit_amount" > NEW."buyer_unit_amount" THEN
      RAISE EXCEPTION 'spread fixed lines require buyer and owner unit amounts';
    END IF;
  ELSIF parent_mode = 'PERCENT' AND NEW."pricing_kind" = 'FIXED_UNIT' THEN
    IF NEW."unit_quantity" IS NULL OR NEW."unit_quantity" <= 0
       OR NEW."buyer_unit_amount" IS NULL OR NEW."owner_unit_amount" IS NOT NULL THEN
      RAISE EXCEPTION 'percent fixed lines require only the buyer unit amount';
    END IF;
  ELSE
    IF NEW."unit_quantity" IS NOT NULL OR NEW."buyer_unit_amount" IS NOT NULL OR NEW."owner_unit_amount" IS NOT NULL THEN
      RAISE EXCEPTION 'haff ratio lines cannot define unit amounts';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "price_line_mutation_guard" ON "zzsh_supply"."price_line";
CREATE TRIGGER "price_line_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "zzsh_supply"."price_line"
FOR EACH ROW EXECUTE FUNCTION "zzsh_supply"."guard_price_line_mutation"();

CREATE OR REPLACE FUNCTION "zzsh_supply"."guard_sealed_term_version"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'SEALED' THEN
    IF (NEW."status", NEW."game_id", NEW."revision", NEW."created_by_admin_id", NEW."created_at", NEW."sealed_at", NEW."sealed_by_admin_id")
       IS DISTINCT FROM
       (OLD."status", OLD."game_id", OLD."revision", OLD."created_by_admin_id", OLD."created_at", OLD."sealed_at", OLD."sealed_by_admin_id") THEN
      RAISE EXCEPTION 'sealed term version is immutable';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."status" = 'SEALED' AND NOT EXISTS (SELECT 1 FROM "zzsh_supply"."term_option" WHERE "version_id" = NEW."id") THEN
    RAISE EXCEPTION 'term version requires at least one option';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "term_version_seal_guard" ON "zzsh_supply"."term_version";
CREATE TRIGGER "term_version_seal_guard"
BEFORE UPDATE ON "zzsh_supply"."term_version"
FOR EACH ROW EXECUTE FUNCTION "zzsh_supply"."guard_sealed_term_version"();

CREATE OR REPLACE FUNCTION "zzsh_supply"."guard_term_option_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  version_id text;
  parent_status text;
BEGIN
  IF TG_OP = 'DELETE' THEN
    version_id := OLD."version_id";
  ELSE
    version_id := NEW."version_id";
  END IF;
  SELECT "status" INTO parent_status FROM "zzsh_supply"."term_version" WHERE "id" = version_id;
  IF parent_status IS NULL THEN
    RAISE EXCEPTION 'term version does not exist';
  END IF;
  IF parent_status = 'SEALED' THEN
    RAISE EXCEPTION 'sealed term version options are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "term_option_mutation_guard" ON "zzsh_supply"."term_option";
CREATE TRIGGER "term_option_mutation_guard"
BEFORE INSERT OR UPDATE OR DELETE ON "zzsh_supply"."term_option"
FOR EACH ROW EXECUTE FUNCTION "zzsh_supply"."guard_term_option_mutation"();

CREATE OR REPLACE FUNCTION "zzsh_supply"."guard_agreement_version_update"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."status" = 'SEALED' THEN
    IF (NEW."status", NEW."game_id", NEW."title", NEW."body", NEW."digest", NEW."revision",
        NEW."created_by_admin_id", NEW."created_at", NEW."sealed_at", NEW."sealed_by_admin_id")
       IS DISTINCT FROM
       (OLD."status", OLD."game_id", OLD."title", OLD."body", OLD."digest", OLD."revision",
        OLD."created_by_admin_id", OLD."created_at", OLD."sealed_at", OLD."sealed_by_admin_id") THEN
      RAISE EXCEPTION 'sealed agreement version is immutable';
    END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "agreement_version_seal_guard" ON "zzsh_supply"."agreement_version";
CREATE TRIGGER "agreement_version_seal_guard"
BEFORE UPDATE ON "zzsh_supply"."agreement_version"
FOR EACH ROW EXECUTE FUNCTION "zzsh_supply"."guard_agreement_version_update"();

CREATE OR REPLACE FUNCTION "zzsh_supply"."guard_rule_release_insert"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  price_row record;
  term_row record;
  agreement_row record;
BEGIN
  SELECT "game_id", "status" INTO price_row FROM "zzsh_supply"."price_version" WHERE "id" = NEW."price_version_id";
  SELECT "game_id", "status" INTO term_row FROM "zzsh_supply"."term_version" WHERE "id" = NEW."term_version_id";
  SELECT "game_id", "status" INTO agreement_row FROM "zzsh_supply"."agreement_version" WHERE "id" = NEW."agreement_version_id";
  IF price_row IS NULL OR term_row IS NULL OR agreement_row IS NULL THEN
    RAISE EXCEPTION 'rule release versions must exist';
  END IF;
  IF price_row."status" <> 'SEALED' OR term_row."status" <> 'SEALED' OR agreement_row."status" <> 'SEALED' THEN
    RAISE EXCEPTION 'rule release versions must be sealed';
  END IF;
  IF price_row."game_id" <> NEW."game_id" OR term_row."game_id" <> NEW."game_id" OR agreement_row."game_id" <> NEW."game_id" THEN
    RAISE EXCEPTION 'rule release versions must belong to the same game';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "rule_release_insert_guard" ON "zzsh_supply"."rule_release";
CREATE TRIGGER "rule_release_insert_guard"
BEFORE INSERT ON "zzsh_supply"."rule_release"
FOR EACH ROW EXECUTE FUNCTION "zzsh_supply"."guard_rule_release_insert"();

CREATE OR REPLACE FUNCTION "zzsh_supply"."guard_media_asset_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."storage_key" IS DISTINCT FROM OLD."storage_key"
     OR NEW."content_hash" IS DISTINCT FROM OLD."content_hash"
     OR NEW."game_id" IS DISTINCT FROM OLD."game_id"
     OR NEW."purpose" IS DISTINCT FROM OLD."purpose"
     OR NEW."ownership_kind" IS DISTINCT FROM OLD."ownership_kind"
     OR NEW."owner_user_id" IS DISTINCT FROM OLD."owner_user_id"
     OR NEW."uploaded_by_realm" IS DISTINCT FROM OLD."uploaded_by_realm"
     OR NEW."uploaded_by_user_id" IS DISTINCT FROM OLD."uploaded_by_user_id"
     OR NEW."uploaded_by_admin_id" IS DISTINCT FROM OLD."uploaded_by_admin_id"
     OR NEW."mime" IS DISTINCT FROM OLD."mime"
     OR NEW."byte_size" IS DISTINCT FROM OLD."byte_size"
     OR NEW."width" IS DISTINCT FROM OLD."width"
     OR NEW."height" IS DISTINCT FROM OLD."height"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'media asset file reference is immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS "media_asset_mutation_guard" ON "zzsh_supply"."media_asset";
CREATE TRIGGER "media_asset_mutation_guard"
BEFORE UPDATE ON "zzsh_supply"."media_asset"
FOR EACH ROW EXECUTE FUNCTION "zzsh_supply"."guard_media_asset_mutation"();

INSERT INTO "zzsh_iam"."admin_permission" ("code", "name", "description") VALUES
  ('supply.catalog.manage', '维护供给目录', '按游戏对象范围维护计费物品、皮肤分类、皮肤、稀有度与权益'),
  ('supply.rules.edit', '编辑规则草稿', '创建和编辑价格、租期与协议草稿，封存版本'),
  ('supply.rules.activate', '生效规则版本', 'Boss 原子切换当前规则版本'),
  ('supply.review.read', '查看媒体审核', '按对象范围读取待审媒体与私有材料'),
  ('supply.review.decide', '决定媒体审核', '通过、驳回或隔离媒体材料并管理公开范围'),
  ('supply.quote.internal.read', '读取内部报价', '查看含平台利润与计价依据的内部报价投影')
ON CONFLICT ("code") DO NOTHING;
