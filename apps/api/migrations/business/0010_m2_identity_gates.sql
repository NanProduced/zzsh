ALTER TABLE "zzsh_auth_user"."account"
  ADD COLUMN IF NOT EXISTS "legacyPasswordVersion" text,
  ADD COLUMN IF NOT EXISTS "legacyPasswordSalt" text;

ALTER TABLE "zzsh_auth_admin"."account"
  ADD COLUMN IF NOT EXISTS "legacyPasswordVersion" text,
  ADD COLUMN IF NOT EXISTS "legacyPasswordSalt" text;

CREATE TABLE IF NOT EXISTS "zzsh_iam"."user_identity_state" (
  "user_id" text PRIMARY KEY REFERENCES "zzsh_auth_user"."user"("id") ON DELETE RESTRICT,
  "account_status" text NOT NULL DEFAULT 'ACTIVE' CHECK ("account_status" IN ('ACTIVE', 'DEACTIVATED', 'CANCELLED')),
  "identity_status" text NOT NULL DEFAULT 'UNVERIFIED' CHECK ("identity_status" IN ('UNVERIFIED', 'VERIFIED', 'REJECTED', 'UNKNOWN')),
  "age_status" text NOT NULL DEFAULT 'UNKNOWN' CHECK ("age_status" IN ('UNKNOWN', 'ADULT', 'MINOR')),
  "provider" text NOT NULL DEFAULT 'none',
  "provider_reference" text,
  "version" integer NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "verified_at" timestamptz,
  "anonymized_at" timestamptz,
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "user_identity_state_account_status_idx"
  ON "zzsh_iam"."user_identity_state" ("account_status", "updated_at" DESC);

CREATE OR REPLACE FUNCTION "zzsh_iam"."record_user_identity_state_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "zzsh_iam"."audit_event" (
    "id", "actor_type", "actor_id", "session_id", "action", "object_type", "object_id",
    "outcome", "request_id", "occurred_at", "details"
  ) VALUES (
    'audit_' || replace(gen_random_uuid()::text, '-', ''),
    COALESCE(NULLIF(current_setting('zzsh.actor_type', true), ''), 'system'),
    NULLIF(current_setting('zzsh.actor_id', true), ''),
    NULLIF(current_setting('zzsh.session_id', true), ''),
    'user.identity_state.' || lower(TG_OP),
    'zzsh_iam.user_identity_state',
    NEW."user_id",
    'SUCCESS',
    NULLIF(current_setting('zzsh.request_id', true), ''),
    clock_timestamp(),
    jsonb_build_object('operation', TG_OP, 'source', 'database-trigger')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "user_identity_state_audit" ON "zzsh_iam"."user_identity_state";
CREATE TRIGGER "user_identity_state_audit"
AFTER INSERT OR UPDATE ON "zzsh_iam"."user_identity_state"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."record_user_identity_state_change"();
