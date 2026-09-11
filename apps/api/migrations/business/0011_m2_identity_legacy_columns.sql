ALTER TABLE "zzsh_auth_user"."account"
  ADD COLUMN IF NOT EXISTS "legacyPasswordVersion" text,
  ADD COLUMN IF NOT EXISTS "legacyPasswordSalt" text;

ALTER TABLE "zzsh_auth_admin"."account"
  ADD COLUMN IF NOT EXISTS "legacyPasswordVersion" text,
  ADD COLUMN IF NOT EXISTS "legacyPasswordSalt" text;

CREATE OR REPLACE FUNCTION "zzsh_iam"."clear_legacy_password_on_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."password" IS DISTINCT FROM OLD."password" THEN
    NEW."legacyPasswordMd5" := NULL;
    NEW."legacyPasswordVersion" := NULL;
    NEW."legacyPasswordSalt" := NULL;
    NEW."legacyPasswordUpgradedAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;
