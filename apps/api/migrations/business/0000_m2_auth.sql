CREATE SCHEMA IF NOT EXISTS "zzsh_iam";
CREATE SCHEMA IF NOT EXISTS "zzsh_auth_user";
CREATE SCHEMA IF NOT EXISTS "zzsh_auth_admin";

CREATE TABLE "zzsh_iam"."admin_security" (
  "admin_user_id" text PRIMARY KEY,
  "status" text NOT NULL CHECK ("status" IN ('PENDING_ENROLLMENT', 'ACTIVE', 'FROZEN')),
  "is_boss" boolean NOT NULL DEFAULT false,
  "bootstrap_expires_at" timestamptz,
  "bootstrap_used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE "zzsh_iam"."audit_event" (
  "id" text PRIMARY KEY,
  "actor_type" text NOT NULL,
  "actor_id" text,
  "session_id" text,
  "action" text NOT NULL,
  "object_type" text NOT NULL,
  "object_id" text,
  "outcome" text NOT NULL CHECK ("outcome" IN ('SUCCESS', 'FAILURE')),
  "request_id" text,
  "reason" text,
  "occurred_at" timestamptz NOT NULL,
  "recorded_at" timestamptz NOT NULL DEFAULT now(),
  "details" jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX "audit_event_occurred_at_idx" ON "zzsh_iam"."audit_event" ("occurred_at");
CREATE INDEX "audit_event_actor_idx" ON "zzsh_iam"."audit_event" ("actor_type", "actor_id");

CREATE TABLE "zzsh_auth_user"."user" (
  "id" text PRIMARY KEY,
  "name" text NOT NULL,
  "email" text NOT NULL UNIQUE,
  "emailVerified" boolean NOT NULL DEFAULT false,
  "image" text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "username" text UNIQUE,
  "displayUsername" text,
  "twoFactorEnabled" boolean DEFAULT false,
  "phoneNumber" text UNIQUE,
  "phoneNumberVerified" boolean,
  "suspended" boolean NOT NULL DEFAULT false
);

CREATE TABLE "zzsh_auth_user"."session" (
  "id" text PRIMARY KEY,
  "expiresAt" timestamptz NOT NULL,
  "token" text NOT NULL UNIQUE,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  "ipAddress" text,
  "userAgent" text,
  "userId" text NOT NULL REFERENCES "zzsh_auth_user"."user"("id") ON DELETE CASCADE,
  "locked" boolean NOT NULL DEFAULT false,
  "pinHash" text,
  "pinFailures" integer NOT NULL DEFAULT 0
);
CREATE INDEX "user_session_user_id_idx" ON "zzsh_auth_user"."session" ("userId");

CREATE TABLE "zzsh_auth_user"."account" (
  "id" text PRIMARY KEY,
  "accountId" text NOT NULL,
  "providerId" text NOT NULL,
  "userId" text NOT NULL REFERENCES "zzsh_auth_user"."user"("id") ON DELETE CASCADE,
  "accessToken" text,
  "refreshToken" text,
  "idToken" text,
  "accessTokenExpiresAt" timestamptz,
  "refreshTokenExpiresAt" timestamptz,
  "scope" text,
  "password" text,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL,
  UNIQUE ("providerId", "accountId")
);
CREATE INDEX "user_account_user_id_idx" ON "zzsh_auth_user"."account" ("userId");

CREATE TABLE "zzsh_auth_user"."verification" (
  "id" text PRIMARY KEY,
  "identifier" text NOT NULL,
  "value" text NOT NULL,
  "expiresAt" timestamptz NOT NULL,
  "createdAt" timestamptz NOT NULL,
  "updatedAt" timestamptz NOT NULL
);
CREATE INDEX "user_verification_identifier_idx" ON "zzsh_auth_user"."verification" ("identifier");

CREATE TABLE "zzsh_auth_user"."twoFactor" (
  "id" text PRIMARY KEY,
  "secret" text NOT NULL,
  "backupCodes" text NOT NULL,
  "userId" text NOT NULL REFERENCES "zzsh_auth_user"."user"("id") ON DELETE CASCADE,
  "verified" boolean NOT NULL DEFAULT true,
  "failedVerificationCount" integer NOT NULL DEFAULT 0,
  "lockedUntil" timestamptz
);
CREATE INDEX "user_two_factor_secret_idx" ON "zzsh_auth_user"."twoFactor" ("secret");
CREATE INDEX "user_two_factor_user_id_idx" ON "zzsh_auth_user"."twoFactor" ("userId");

CREATE TABLE "zzsh_auth_admin"."user" (LIKE "zzsh_auth_user"."user" INCLUDING ALL);
CREATE TABLE "zzsh_auth_admin"."session" (LIKE "zzsh_auth_user"."session" INCLUDING ALL);
CREATE TABLE "zzsh_auth_admin"."account" (LIKE "zzsh_auth_user"."account" INCLUDING ALL);
CREATE TABLE "zzsh_auth_admin"."verification" (LIKE "zzsh_auth_user"."verification" INCLUDING ALL);
CREATE TABLE "zzsh_auth_admin"."twoFactor" (LIKE "zzsh_auth_user"."twoFactor" INCLUDING ALL);

ALTER TABLE "zzsh_auth_admin"."session"
  DROP CONSTRAINT IF EXISTS "session_userId_fkey",
  ADD CONSTRAINT "admin_session_user_id_fkey"
    FOREIGN KEY ("userId") REFERENCES "zzsh_auth_admin"."user"("id") ON DELETE CASCADE;
ALTER TABLE "zzsh_auth_admin"."account"
  DROP CONSTRAINT IF EXISTS "account_userId_fkey",
  ADD CONSTRAINT "admin_account_user_id_fkey"
    FOREIGN KEY ("userId") REFERENCES "zzsh_auth_admin"."user"("id") ON DELETE CASCADE;
ALTER TABLE "zzsh_auth_admin"."twoFactor"
  DROP CONSTRAINT IF EXISTS "twoFactor_userId_fkey",
  ADD CONSTRAINT "admin_two_factor_user_id_fkey"
    FOREIGN KEY ("userId") REFERENCES "zzsh_auth_admin"."user"("id") ON DELETE CASCADE;

CREATE INDEX "admin_session_user_id_idx" ON "zzsh_auth_admin"."session" ("userId");
CREATE INDEX "admin_account_user_id_idx" ON "zzsh_auth_admin"."account" ("userId");
CREATE INDEX "admin_verification_identifier_idx" ON "zzsh_auth_admin"."verification" ("identifier");
CREATE INDEX "admin_two_factor_secret_idx" ON "zzsh_auth_admin"."twoFactor" ("secret");
CREATE INDEX "admin_two_factor_user_id_idx" ON "zzsh_auth_admin"."twoFactor" ("userId");

CREATE OR REPLACE FUNCTION "zzsh_iam"."record_auth_user_created"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "zzsh_iam"."audit_event" (
    "id", "actor_type", "actor_id", "action", "object_type", "object_id",
    "outcome", "occurred_at", "details"
  ) VALUES (
    'audit_' || replace(gen_random_uuid()::text, '-', ''),
    CASE WHEN TG_TABLE_SCHEMA = 'zzsh_auth_admin' THEN 'admin' ELSE 'user' END,
    NEW."id",
    CASE WHEN TG_TABLE_SCHEMA = 'zzsh_auth_admin' THEN 'admin.account.created' ELSE 'user.account.created' END,
    'auth_user',
    NEW."id",
    'SUCCESS',
    clock_timestamp(),
    jsonb_build_object('source', 'better-auth')
  );
  RETURN NEW;
END;
$$;

CREATE TRIGGER "user_auth_creation_audit"
AFTER INSERT ON "zzsh_auth_user"."user"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."record_auth_user_created"();
CREATE TRIGGER "admin_auth_creation_audit"
AFTER INSERT ON "zzsh_auth_admin"."user"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."record_auth_user_created"();
