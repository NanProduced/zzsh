-- PROFILE-AVATAR-CLOSURE-1: avatar media purposes and the per-subject current binding.
-- Only the two explicit avatar tuples gain game/account-free ownership; every
-- existing catalog, content and user-supply shape is preserved verbatim.
ALTER TABLE "zzsh_supply"."media_upload_intent" DROP CONSTRAINT "media_upload_intent_purpose_check";
ALTER TABLE "zzsh_supply"."media_upload_intent" ADD CONSTRAINT "media_upload_intent_purpose_check"
  CHECK ("purpose" IN ('GAME_COVER', 'SKIN_MEDIA', 'ITEM_MEDIA', 'ACCOUNT_EVIDENCE', 'ACCOUNT_DISPLAY', 'CONTENT_MEDIA', 'FIREARM_MEDIA', 'AVATAR'));
ALTER TABLE "zzsh_supply"."media_asset" DROP CONSTRAINT "media_asset_purpose_check";
ALTER TABLE "zzsh_supply"."media_asset" ADD CONSTRAINT "media_asset_purpose_check"
  CHECK ("purpose" IN ('GAME_COVER', 'SKIN_MEDIA', 'ITEM_MEDIA', 'ACCOUNT_EVIDENCE', 'ACCOUNT_DISPLAY', 'CONTENT_MEDIA', 'FIREARM_MEDIA', 'AVATAR'));

ALTER TABLE "zzsh_supply"."media_upload_intent" DROP CONSTRAINT "media_upload_intent_ownership_kind_check";
ALTER TABLE "zzsh_supply"."media_upload_intent" ADD CONSTRAINT "media_upload_intent_ownership_kind_check"
  CHECK ("ownership_kind" IN ('PLATFORM_CATALOG', 'USER_SUPPLY', 'PLATFORM_CONTENT', 'USER_AVATAR', 'ADMIN_AVATAR'));
ALTER TABLE "zzsh_supply"."media_asset" DROP CONSTRAINT "media_asset_ownership_kind_check";
ALTER TABLE "zzsh_supply"."media_asset" ADD CONSTRAINT "media_asset_ownership_kind_check"
  CHECK ("ownership_kind" IN ('PLATFORM_CATALOG', 'USER_SUPPLY', 'PLATFORM_CONTENT', 'USER_AVATAR', 'ADMIN_AVATAR'));

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
  OR ("uploaded_by_realm" = 'user' AND "ownership_kind" = 'USER_AVATAR'
    AND "purpose" = 'AVATAR' AND "game_id" IS NULL AND "account_id" IS NULL
    AND "owner_user_id" = "uploaded_by_user_id" AND "owner_user_id" IS NOT NULL
    AND "uploaded_by_user_id" IS NOT NULL AND "uploaded_by_admin_id" IS NULL)
  OR ("uploaded_by_realm" = 'admin' AND "ownership_kind" = 'ADMIN_AVATAR'
    AND "purpose" = 'AVATAR' AND "game_id" IS NULL AND "account_id" IS NULL
    AND "owner_user_id" IS NULL AND "uploaded_by_user_id" IS NULL
    AND "uploaded_by_admin_id" IS NOT NULL)
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
  OR ("uploaded_by_realm" = 'user' AND "ownership_kind" = 'USER_AVATAR'
    AND "purpose" = 'AVATAR' AND "game_id" IS NULL
    AND "owner_user_id" = "uploaded_by_user_id" AND "owner_user_id" IS NOT NULL
    AND "uploaded_by_user_id" IS NOT NULL AND "uploaded_by_admin_id" IS NULL AND "account_id" IS NULL)
  OR ("uploaded_by_realm" = 'admin' AND "ownership_kind" = 'ADMIN_AVATAR'
    AND "purpose" = 'AVATAR' AND "game_id" IS NULL
    AND "owner_user_id" IS NULL AND "uploaded_by_user_id" IS NULL
    AND "uploaded_by_admin_id" IS NOT NULL AND "account_id" IS NULL)
);

ALTER TABLE "zzsh_supply"."media_asset" DROP CONSTRAINT "media_asset_public_visibility";
ALTER TABLE "zzsh_supply"."media_asset" ADD CONSTRAINT "media_asset_public_visibility" CHECK (
  "access_class" <> 'PUBLIC_DISPLAY'
  OR ("public_storage_key" IS NOT NULL AND (
    ("ownership_kind" IN ('PLATFORM_CATALOG', 'PLATFORM_CONTENT') AND "review_state" = 'APPROVED')
    OR ("ownership_kind" = 'USER_SUPPLY' AND "purpose" = 'ACCOUNT_DISPLAY' AND "technical_state" = 'READY')
    OR ("ownership_kind" IN ('USER_AVATAR', 'ADMIN_AVATAR') AND "purpose" = 'AVATAR'
      AND "review_state" = 'APPROVED' AND "technical_state" = 'READY')
  ))
);
--> statement-breakpoint

CREATE TABLE "zzsh_supply"."profile_avatar" (
  "realm" text NOT NULL CHECK ("realm" IN ('user', 'admin')),
  "subject_id" text NOT NULL CHECK ("subject_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  "default_preset_id" text NOT NULL CHECK ("default_preset_id" ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  "current_kind" text NOT NULL CHECK ("current_kind" IN ('DEFAULT', 'CUSTOM')),
  "current_preset_id" text CHECK ("current_preset_id" ~ '^[a-z0-9][a-z0-9-]{1,31}$'),
  "current_asset_id" text REFERENCES "zzsh_supply"."media_asset"("id"),
  "pending_asset_id" text REFERENCES "zzsh_supply"."media_asset"("id"),
  "latest_upload_intent_id" text REFERENCES "zzsh_supply"."media_upload_intent"("id"),
  CHECK ("pending_asset_id" IS NULL OR "latest_upload_intent_id" IS NULL),
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" > 0),
  "current_version" bigint NOT NULL DEFAULT 1 CHECK ("current_version" > 0),
  "last_review_asset_id" text REFERENCES "zzsh_supply"."media_asset"("id"),
  "last_review_state" text CHECK ("last_review_state" IN ('APPROVED', 'REJECTED', 'QUARANTINED', 'WITHDRAWN')),
  "last_review_reason" text,
  "last_reviewed_at" timestamptz,
  "last_review_applied" boolean NOT NULL DEFAULT false,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY ("realm", "subject_id"),
  CONSTRAINT "profile_avatar_current_shape" CHECK (
    ("current_kind" = 'DEFAULT' AND "current_preset_id" IS NOT NULL AND "current_asset_id" IS NULL)
    OR ("current_kind" = 'CUSTOM' AND "current_preset_id" IS NULL AND "current_asset_id" IS NOT NULL)
  ),
  CONSTRAINT "profile_avatar_pending_distinct" CHECK ("pending_asset_id" IS NULL OR "pending_asset_id" IS DISTINCT FROM "current_asset_id"),
  CONSTRAINT "profile_avatar_last_review_shape" CHECK (
    ("last_review_asset_id" IS NULL AND "last_review_state" IS NULL AND "last_review_reason" IS NULL
      AND "last_reviewed_at" IS NULL AND "last_review_applied" = false)
    OR ("last_review_asset_id" IS NOT NULL AND "last_review_state" IS NOT NULL AND "last_reviewed_at" IS NOT NULL)
  )
);
CREATE INDEX "profile_avatar_pending_idx"
  ON "zzsh_supply"."profile_avatar" ("realm", "updated_at" DESC)
  WHERE "pending_asset_id" IS NOT NULL;

INSERT INTO "zzsh_iam"."admin_permission" ("code", "name", "description") VALUES
  ('profile.avatar.review', '审核头像', '审核用户与管理员本人上传的头像；不包含目录素材或其他身份资料')
ON CONFLICT ("code") DO NOTHING;
