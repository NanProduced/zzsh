-- M3 content foundation: platform announcements, game/platform news, fixed carousel
-- slots and platform-level content media. Purely additive to earlier migrations.
CREATE SCHEMA IF NOT EXISTS "zzsh_content";

CREATE TABLE "zzsh_content"."content_item" (
  "id" text PRIMARY KEY,
  "type" text NOT NULL CHECK ("type" IN ('ANNOUNCEMENT', 'NEWS')),
  "game_id" text REFERENCES "zzsh_supply"."game"("id"),
  "sort_order" integer NOT NULL DEFAULT 0,
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "created_by_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  -- Platform announcements never belong to a single game scope.
  CONSTRAINT "content_item_scope_shape" CHECK ("type" <> 'ANNOUNCEMENT' OR "game_id" IS NULL)
);

CREATE TABLE "zzsh_content"."content_version" (
  "id" text PRIMARY KEY,
  "item_id" text NOT NULL REFERENCES "zzsh_content"."content_item"("id"),
  "sequence" integer NOT NULL CHECK ("sequence" > 0),
  "state" text NOT NULL DEFAULT 'DRAFT' CHECK ("state" IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED', 'WITHDRAWN')),
  "title" text NOT NULL DEFAULT '' CHECK (char_length("title") <= 200),
  "summary" text NOT NULL DEFAULT '' CHECK (char_length("summary") <= 500),
  "body" text NOT NULL DEFAULT '' CHECK (octet_length("body") <= 20000),
  "cover_media_id" text REFERENCES "zzsh_supply"."media_asset"("id"),
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "published_at" timestamptz,
  "published_by_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "created_by_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "content_version_item_sequence_unique" UNIQUE ("item_id", "sequence"),
  CONSTRAINT "content_version_publish_shape" CHECK (
    ("state" = 'DRAFT' AND "published_at" IS NULL AND "published_by_admin_id" IS NULL)
    OR ("state" <> 'DRAFT' AND "published_at" IS NOT NULL AND "published_by_admin_id" IS NOT NULL)
  )
);

-- One editable draft and one live published version per item.
CREATE UNIQUE INDEX "content_version_single_draft" ON "zzsh_content"."content_version" ("item_id") WHERE "state" = 'DRAFT';
CREATE UNIQUE INDEX "content_version_single_published" ON "zzsh_content"."content_version" ("item_id") WHERE "state" = 'PUBLISHED';
CREATE INDEX "content_version_item_idx" ON "zzsh_content"."content_version" ("item_id", "sequence" DESC);
CREATE INDEX "content_item_public_idx" ON "zzsh_content"."content_item" ("type", "game_id", "sort_order" DESC, "id" DESC);

CREATE TABLE "zzsh_content"."carousel_item" (
  "id" text PRIMARY KEY,
  "slot_code" text NOT NULL CHECK ("slot_code" IN ('HOME_HERO')),
  "media_id" text NOT NULL REFERENCES "zzsh_supply"."media_asset"("id"),
  "image_alt" text NOT NULL CHECK (char_length("image_alt") BETWEEN 1 AND 300),
  "title" text NOT NULL CHECK (char_length("title") BETWEEN 1 AND 120),
  "description" text NOT NULL DEFAULT '' CHECK (char_length("description") <= 300),
  -- Relative same-site target only; application validates the allowlisted prefix.
  "link_url" text CHECK ("link_url" IS NULL OR ("link_url" ~ '^/' AND "link_url" !~ '^//' AND char_length("link_url") <= 300)),
  "enabled" boolean NOT NULL DEFAULT false,
  "sort_order" integer NOT NULL DEFAULT 0,
  "starts_at" timestamptz,
  "ends_at" timestamptz,
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "created_by_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "carousel_item_window_shape" CHECK ("ends_at" IS NULL OR "starts_at" IS NULL OR "starts_at" < "ends_at")
);

CREATE INDEX "carousel_item_slot_idx" ON "zzsh_content"."carousel_item" ("slot_code", "sort_order" DESC, "id" DESC);

-- Platform-level content media: same reviewed-image pipeline as catalog media but
-- without a game affiliation. Ownership kind keeps the authorization branch explicit.
ALTER TABLE "zzsh_supply"."media_upload_intent" ALTER COLUMN "game_id" DROP NOT NULL;
ALTER TABLE "zzsh_supply"."media_asset" ALTER COLUMN "game_id" DROP NOT NULL;

ALTER TABLE "zzsh_supply"."media_upload_intent" DROP CONSTRAINT "media_upload_intent_purpose_check";
ALTER TABLE "zzsh_supply"."media_upload_intent" ADD CONSTRAINT "media_upload_intent_purpose_check"
  CHECK ("purpose" IN ('GAME_COVER', 'SKIN_MEDIA', 'ITEM_MEDIA', 'ACCOUNT_EVIDENCE', 'ACCOUNT_DISPLAY', 'CONTENT_MEDIA'));
ALTER TABLE "zzsh_supply"."media_asset" DROP CONSTRAINT "media_asset_purpose_check";
ALTER TABLE "zzsh_supply"."media_asset" ADD CONSTRAINT "media_asset_purpose_check"
  CHECK ("purpose" IN ('GAME_COVER', 'SKIN_MEDIA', 'ITEM_MEDIA', 'ACCOUNT_EVIDENCE', 'ACCOUNT_DISPLAY', 'CONTENT_MEDIA'));

ALTER TABLE "zzsh_supply"."media_upload_intent" DROP CONSTRAINT "media_upload_intent_ownership_kind_check";
ALTER TABLE "zzsh_supply"."media_upload_intent" ADD CONSTRAINT "media_upload_intent_ownership_kind_check"
  CHECK ("ownership_kind" IN ('PLATFORM_CATALOG', 'USER_SUPPLY', 'PLATFORM_CONTENT'));
ALTER TABLE "zzsh_supply"."media_asset" DROP CONSTRAINT "media_asset_ownership_kind_check";
ALTER TABLE "zzsh_supply"."media_asset" ADD CONSTRAINT "media_asset_ownership_kind_check"
  CHECK ("ownership_kind" IN ('PLATFORM_CATALOG', 'USER_SUPPLY', 'PLATFORM_CONTENT'));

ALTER TABLE "zzsh_supply"."media_upload_intent" DROP CONSTRAINT "media_upload_intent_actor_shape";
ALTER TABLE "zzsh_supply"."media_upload_intent" ADD CONSTRAINT "media_upload_intent_actor_shape" CHECK (
  ("uploaded_by_realm" = 'admin' AND "ownership_kind" = 'PLATFORM_CATALOG'
    AND "purpose" IN ('GAME_COVER', 'SKIN_MEDIA', 'ITEM_MEDIA')
    AND "game_id" IS NOT NULL
    AND "owner_user_id" IS NULL AND "uploaded_by_admin_id" IS NOT NULL AND "uploaded_by_user_id" IS NULL AND "account_id" IS NULL)
  OR ("uploaded_by_realm" = 'admin' AND "ownership_kind" = 'PLATFORM_CONTENT'
    AND "purpose" = 'CONTENT_MEDIA'
    AND "game_id" IS NULL
    AND "owner_user_id" IS NULL AND "uploaded_by_admin_id" IS NOT NULL AND "uploaded_by_user_id" IS NULL AND "account_id" IS NULL)
  OR ("uploaded_by_realm" = 'user' AND "ownership_kind" = 'USER_SUPPLY'
    AND "purpose" IN ('ACCOUNT_EVIDENCE', 'ACCOUNT_DISPLAY')
    AND "game_id" IS NOT NULL
    AND "owner_user_id" = "uploaded_by_user_id" AND "uploaded_by_admin_id" IS NULL AND "owner_user_id" IS NOT NULL AND "account_id" IS NOT NULL)
);
ALTER TABLE "zzsh_supply"."media_asset" DROP CONSTRAINT "media_asset_actor_shape";
ALTER TABLE "zzsh_supply"."media_asset" ADD CONSTRAINT "media_asset_actor_shape" CHECK (
  ("uploaded_by_realm" = 'admin' AND "ownership_kind" = 'PLATFORM_CATALOG'
    AND "purpose" IN ('GAME_COVER', 'SKIN_MEDIA', 'ITEM_MEDIA')
    AND "game_id" IS NOT NULL
    AND "owner_user_id" IS NULL AND "uploaded_by_admin_id" IS NOT NULL AND "uploaded_by_user_id" IS NULL)
  OR ("uploaded_by_realm" = 'admin' AND "ownership_kind" = 'PLATFORM_CONTENT'
    AND "purpose" = 'CONTENT_MEDIA'
    AND "game_id" IS NULL
    AND "owner_user_id" IS NULL AND "uploaded_by_admin_id" IS NOT NULL AND "uploaded_by_user_id" IS NULL)
  OR ("uploaded_by_realm" = 'user' AND "ownership_kind" = 'USER_SUPPLY'
    AND "purpose" IN ('ACCOUNT_EVIDENCE', 'ACCOUNT_DISPLAY')
    AND "game_id" IS NOT NULL
    AND "owner_user_id" = "uploaded_by_user_id" AND "uploaded_by_admin_id" IS NULL AND "owner_user_id" IS NOT NULL)
);

-- Public display stays restricted to catalog/display images plus platform content media.
ALTER TABLE "zzsh_supply"."media_asset" DROP CONSTRAINT "media_asset_check";
ALTER TABLE "zzsh_supply"."media_asset" ADD CONSTRAINT "media_asset_public_ownership"
  CHECK ("access_class" <> 'PUBLIC_DISPLAY' OR "ownership_kind" IN ('PLATFORM_CATALOG', 'PLATFORM_CONTENT') OR "purpose" = 'ACCOUNT_DISPLAY');

INSERT INTO "zzsh_iam"."admin_permission" ("code", "name", "description") VALUES
  ('content.read', '读取游戏内容', '按游戏对象范围读取资讯草稿与发布状态'),
  ('content.edit', '编辑游戏内容', '按游戏对象范围创建和编辑游戏资讯草稿'),
  ('content.publish', '发布游戏内容', '按游戏对象范围发布或撤回游戏资讯'),
  ('content.platform.read', '读取平台内容', '读取平台公告、平台资讯、轮播与平台素材'),
  ('content.platform.edit', '编辑平台内容', '创建和编辑平台公告、平台资讯、轮播及上传平台素材'),
  ('content.platform.publish', '发布平台内容', '发布或撤回平台内容，审核与撤权平台素材')
ON CONFLICT ("code") DO NOTHING;
