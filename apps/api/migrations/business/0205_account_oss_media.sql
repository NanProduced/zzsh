ALTER TABLE zzsh_supply.media_upload_intent
  ADD COLUMN direct_oss boolean NOT NULL DEFAULT false,
  ADD CONSTRAINT media_upload_intent_direct_oss_shape CHECK (
    NOT direct_oss OR (account_id IS NOT NULL AND uploaded_by_realm = 'user'
      AND purpose IN ('ACCOUNT_DISPLAY', 'ACCOUNT_EVIDENCE'))
  );

CREATE TABLE zzsh_supply.account_image_watermark (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  enabled boolean NOT NULL DEFAULT false,
  logo_asset_id text REFERENCES zzsh_supply.media_asset(id),
  position text NOT NULL DEFAULT 'se' CHECK (position IN ('nw','ne','sw','se')),
  size_percent smallint NOT NULL DEFAULT 12 CHECK (size_percent BETWEEN 5 AND 30),
  opacity_percent smallint NOT NULL DEFAULT 55 CHECK (opacity_percent BETWEEN 1 AND 100),
  margin_percent smallint NOT NULL DEFAULT 2 CHECK (margin_percent BETWEEN 0 AND 10),
  updated_by_admin_id text REFERENCES zzsh_auth_admin."user"(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (NOT enabled OR logo_asset_id IS NOT NULL)
);
INSERT INTO zzsh_supply.account_image_watermark DEFAULT VALUES;

CREATE TABLE zzsh_supply.account_image_variant (
  asset_id text NOT NULL REFERENCES zzsh_supply.media_asset(id),
  max_edge smallint NOT NULL CHECK (max_edge IN (640, 1920)),
  object_key text NOT NULL UNIQUE CHECK (object_key ~ '^private/account-variants/[a-f0-9]{32}/(640|1920)\.webp$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  width smallint NOT NULL CHECK (width BETWEEN 1 AND max_edge),
  height smallint NOT NULL CHECK (height BETWEEN 1 AND max_edge),
  watermark_revision bigint NOT NULL CHECK (watermark_revision > 0),
  PRIMARY KEY (asset_id, max_edge),
  CHECK (object_key LIKE '%/' || max_edge::text || '.webp')
);
COMMENT ON TABLE zzsh_supply.account_image_variant IS '已校验的私有账号展示衍生图；公开投放及撤权另行管理';
