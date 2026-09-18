ALTER TABLE "zzsh_iam"."im_support_presence"
  ADD COLUMN IF NOT EXISTS "app_id" text;

ALTER TABLE "zzsh_iam"."im_support_presence"
  DROP CONSTRAINT IF EXISTS "im_support_presence_pkey";

ALTER TABLE "zzsh_iam"."im_support_presence"
  ADD CONSTRAINT "im_support_presence_app_admin_unique"
  UNIQUE ("app_id", "admin_user_id");

ALTER TABLE "zzsh_iam"."im_support_presence"
  ADD CONSTRAINT "im_support_presence_app_id_check"
  CHECK ("app_id" IS NULL OR "app_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');

CREATE INDEX IF NOT EXISTS "im_support_presence_app_available_idx"
  ON "zzsh_iam"."im_support_presence" ("app_id", "availability", "connection_state", "last_connected_at", "active_load", "updated_at", "admin_user_id");

ALTER TABLE "zzsh_iam"."im_consultation"
  ADD COLUMN IF NOT EXISTS "app_id" text,
  ADD COLUMN IF NOT EXISTS "message_scope_type" text NOT NULL DEFAULT 'TEAM',
  ADD COLUMN IF NOT EXISTS "message_scope_id" text,
  ADD COLUMN IF NOT EXISTS "message_scope_state" text NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "message_scope_version" bigint NOT NULL DEFAULT 1;

ALTER TABLE "zzsh_iam"."im_consultation"
  ADD CONSTRAINT "im_consultation_app_id_check"
  CHECK ("app_id" IS NULL OR "app_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$');

ALTER TABLE "zzsh_iam"."im_consultation"
  ADD CONSTRAINT "im_consultation_message_scope_type_check"
  CHECK ("message_scope_type" = 'TEAM');

ALTER TABLE "zzsh_iam"."im_consultation"
  ADD CONSTRAINT "im_consultation_message_scope_id_check"
  CHECK ("message_scope_id" IS NULL OR "message_scope_id" ~ '^[0-9]{1,19}$');

ALTER TABLE "zzsh_iam"."im_consultation"
  ADD CONSTRAINT "im_consultation_message_scope_state_check"
  CHECK (
    "message_scope_state" IN ('PENDING', 'PROVISIONING', 'READY', 'FAILED', 'TRANSFERRING', 'REVOKING', 'REVOKED')
    AND (
      "message_scope_state" IN ('PENDING', 'PROVISIONING', 'FAILED')
      OR "message_scope_id" IS NOT NULL
    )
  );

ALTER TABLE "zzsh_iam"."im_consultation"
  ADD CONSTRAINT "im_consultation_message_scope_version_check"
  CHECK ("message_scope_version" > 0);

CREATE UNIQUE INDEX IF NOT EXISTS "im_consultation_message_scope_unique_idx"
  ON "zzsh_iam"."im_consultation" ("message_scope_id")
  WHERE "message_scope_id" IS NOT NULL;

DROP INDEX IF EXISTS "zzsh_iam"."im_consultation_user_kind_active_unique_idx";
CREATE UNIQUE INDEX IF NOT EXISTS "im_consultation_app_user_kind_active_unique_idx"
  ON "zzsh_iam"."im_consultation" ("app_id", "user_id", "kind")
  WHERE "app_id" IS NOT NULL AND "state" <> 'CLOSED';

CREATE INDEX IF NOT EXISTS "im_consultation_app_queue_idx"
  ON "zzsh_iam"."im_consultation" ("app_id", "state", "kind", "assigned_admin_id", "updated_at" DESC, "id");

CREATE INDEX IF NOT EXISTS "im_consultation_app_user_idx"
  ON "zzsh_iam"."im_consultation" ("app_id", "user_id", "updated_at" DESC, "id");

CREATE OR REPLACE FUNCTION "zzsh_iam"."guard_im_consultation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."app_id" IS DISTINCT FROM OLD."app_id"
     OR NEW."user_account_id" IS DISTINCT FROM OLD."user_account_id"
     OR NEW."subject_ref" IS DISTINCT FROM OLD."subject_ref"
     OR NEW."message_scope_type" IS DISTINCT FROM OLD."message_scope_type"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'IM consultation identity and message scope type are immutable';
  END IF;
  IF OLD."message_scope_id" IS NOT NULL AND NEW."message_scope_id" IS DISTINCT FROM OLD."message_scope_id" THEN
    RAISE EXCEPTION 'IM consultation message scope identity is immutable';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    (OLD."state" = 'WAITING' AND NEW."state" IN ('ACTIVE', 'CLOSED'))
    OR (OLD."state" = 'ACTIVE' AND NEW."state" = 'CLOSED')
  ) THEN
    RAISE EXCEPTION 'IM consultation state transition is invalid';
  END IF;
  IF NEW."message_scope_state" IS DISTINCT FROM OLD."message_scope_state" AND NOT (
    (OLD."message_scope_state" = 'PENDING' AND NEW."message_scope_state" IN ('PROVISIONING', 'REVOKED'))
    OR (OLD."message_scope_state" = 'PROVISIONING' AND NEW."message_scope_state" IN ('READY', 'FAILED', 'REVOKED'))
    OR (OLD."message_scope_state" = 'READY' AND NEW."message_scope_state" IN ('TRANSFERRING', 'REVOKING', 'REVOKED'))
    OR (OLD."message_scope_state" = 'FAILED' AND NEW."message_scope_state" IN ('PROVISIONING', 'REVOKED'))
    OR (OLD."message_scope_state" = 'TRANSFERRING' AND NEW."message_scope_state" IN ('READY', 'FAILED', 'REVOKED'))
    OR (OLD."message_scope_state" = 'REVOKING' AND NEW."message_scope_state" IN ('READY', 'REVOKED'))
  ) THEN
    RAISE EXCEPTION 'IM consultation message scope transition is invalid';
  END IF;
  IF OLD."state" = 'CLOSED' AND (
    NEW."assigned_admin_id" IS DISTINCT FROM OLD."assigned_admin_id"
    OR NEW."peer_account_id" IS DISTINCT FROM OLD."peer_account_id"
  ) THEN
    RAISE EXCEPTION 'Closed IM consultation assignment is immutable';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "im_consultation_mutation_guard" ON "zzsh_iam"."im_consultation";
CREATE TRIGGER "im_consultation_mutation_guard"
BEFORE UPDATE ON "zzsh_iam"."im_consultation"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."guard_im_consultation_mutation"();
