ALTER TABLE "zzsh_auth_user"."account"
  ADD COLUMN IF NOT EXISTS "legacyPasswordMd5" text,
  ADD COLUMN IF NOT EXISTS "legacyPasswordUpgradedAt" timestamptz;

ALTER TABLE "zzsh_auth_admin"."account"
  ADD COLUMN IF NOT EXISTS "legacyPasswordMd5" text,
  ADD COLUMN IF NOT EXISTS "legacyPasswordUpgradedAt" timestamptz;

CREATE TABLE IF NOT EXISTS "zzsh_iam"."admin_recovery_request" (
  "id" text PRIMARY KEY,
  "target_admin_user_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id") ON DELETE CASCADE,
  "requested_by" text NOT NULL,
  "confirmed_by" text,
  "status" text NOT NULL CHECK ("status" IN ('PENDING', 'ISSUED', 'COMPLETED', 'EXPIRED')),
  "expires_at" timestamptz NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "admin_recovery_request_target_idx"
  ON "zzsh_iam"."admin_recovery_request" ("target_admin_user_id", "status");

CREATE OR REPLACE FUNCTION "zzsh_iam"."record_security_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed_id text;
  action_name text;
BEGIN
  IF TG_TABLE_NAME = 'admin_security' THEN
    changed_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."admin_user_id" ELSE NEW."admin_user_id" END;
    action_name := 'admin.security.' || lower(TG_OP);
  ELSE
    changed_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
    action_name := 'auth.' || lower(TG_TABLE_SCHEMA) || '.' || lower(TG_TABLE_NAME) || '.' || lower(TG_OP);
  END IF;
  INSERT INTO "zzsh_iam"."audit_event" (
    "id", "actor_type", "actor_id", "session_id", "action", "object_type", "object_id",
    "outcome", "request_id", "occurred_at", "details"
  ) VALUES (
    'audit_' || replace(gen_random_uuid()::text, '-', ''),
    COALESCE(NULLIF(current_setting('zzsh.actor_type', true), ''), 'system'),
    NULLIF(current_setting('zzsh.actor_id', true), ''),
    NULLIF(current_setting('zzsh.session_id', true), ''),
    action_name,
    TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
    changed_id,
    'SUCCESS',
    NULLIF(current_setting('zzsh.request_id', true), ''),
    clock_timestamp(),
    jsonb_build_object('operation', TG_OP, 'source', 'database-trigger')
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "admin_security_audit" ON "zzsh_iam"."admin_security";
CREATE TRIGGER "admin_security_audit"
AFTER INSERT OR UPDATE OR DELETE ON "zzsh_iam"."admin_security"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."record_security_change"();

DROP TRIGGER IF EXISTS "admin_session_audit" ON "zzsh_auth_admin"."session";
CREATE TRIGGER "admin_session_audit"
AFTER INSERT OR UPDATE OR DELETE ON "zzsh_auth_admin"."session"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."record_security_change"();

DROP TRIGGER IF EXISTS "user_session_audit" ON "zzsh_auth_user"."session";
CREATE TRIGGER "user_session_audit"
AFTER INSERT OR UPDATE OR DELETE ON "zzsh_auth_user"."session"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."record_security_change"();

DROP TRIGGER IF EXISTS "admin_two_factor_audit" ON "zzsh_auth_admin"."twoFactor";
CREATE TRIGGER "admin_two_factor_audit"
AFTER INSERT OR UPDATE OR DELETE ON "zzsh_auth_admin"."twoFactor"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."record_security_change"();

DROP TRIGGER IF EXISTS "user_two_factor_audit" ON "zzsh_auth_user"."twoFactor";
CREATE TRIGGER "user_two_factor_audit"
AFTER INSERT OR UPDATE OR DELETE ON "zzsh_auth_user"."twoFactor"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."record_security_change"();

CREATE OR REPLACE FUNCTION "zzsh_iam"."clear_legacy_password_on_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."password" IS DISTINCT FROM OLD."password" THEN
    NEW."legacyPasswordMd5" := NULL;
    NEW."legacyPasswordUpgradedAt" := clock_timestamp();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "user_clear_legacy_password" ON "zzsh_auth_user"."account";
CREATE TRIGGER "user_clear_legacy_password"
BEFORE UPDATE OF "password" ON "zzsh_auth_user"."account"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."clear_legacy_password_on_change"();

DROP TRIGGER IF EXISTS "admin_clear_legacy_password" ON "zzsh_auth_admin"."account";
CREATE TRIGGER "admin_clear_legacy_password"
BEFORE UPDATE OF "password" ON "zzsh_auth_admin"."account"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."clear_legacy_password_on_change"();

CREATE OR REPLACE FUNCTION "zzsh_iam"."record_password_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."password" IS NOT DISTINCT FROM NEW."password" THEN RETURN NEW; END IF;
  INSERT INTO "zzsh_iam"."audit_event" (
    "id", "actor_type", "actor_id", "session_id", "action", "object_type", "object_id",
    "outcome", "request_id", "occurred_at", "details"
  ) VALUES (
    'audit_' || replace(gen_random_uuid()::text, '-', ''),
    COALESCE(NULLIF(current_setting('zzsh.actor_type', true), ''), 'system'),
    NULLIF(current_setting('zzsh.actor_id', true), ''),
    NULLIF(current_setting('zzsh.session_id', true), ''),
    CASE WHEN TG_TABLE_SCHEMA = 'zzsh_auth_admin' THEN 'admin.password.changed' ELSE 'user.password.changed' END,
    TG_TABLE_SCHEMA || '.account',
    NEW."userId",
    'SUCCESS',
    NULLIF(current_setting('zzsh.request_id', true), ''),
    clock_timestamp(),
    jsonb_build_object('source', 'database-trigger')
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "user_password_change_audit" ON "zzsh_auth_user"."account";
CREATE TRIGGER "user_password_change_audit"
AFTER UPDATE OF "password" ON "zzsh_auth_user"."account"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."record_password_change"();

DROP TRIGGER IF EXISTS "admin_password_change_audit" ON "zzsh_auth_admin"."account";
CREATE TRIGGER "admin_password_change_audit"
AFTER UPDATE OF "password" ON "zzsh_auth_admin"."account"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."record_password_change"();
