CREATE TABLE "zzsh_iam"."im_consultation_scope_operation" (
  "id" text PRIMARY KEY,
  "app_id" text NOT NULL,
  "consultation_id" text NOT NULL REFERENCES "zzsh_iam"."im_consultation" ("id"),
  "operation_type" text NOT NULL,
  "state" text NOT NULL DEFAULT 'PENDING',
  "scope_version" bigint NOT NULL,
  "owner_account_id" text NOT NULL,
  "user_account_id" text NOT NULL,
  "previous_admin_id" text,
  "target_admin_id" text,
  "previous_admin_account_id" text,
  "target_admin_account_id" text,
  "provider_team_id" text,
  "attempt_count" integer NOT NULL DEFAULT 0,
  "next_retry_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "lease_until" timestamptz,
  "lease_token_hash" text,
  "last_failure_class" text,
  "last_failure_detail" text,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "im_consultation_scope_operation_id_check"
    CHECK ("id" ~ '^im_scope_op_[a-f0-9]{32}$'),
  CONSTRAINT "im_consultation_scope_operation_app_id_check"
    CHECK ("app_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT "im_consultation_scope_operation_type_check"
    CHECK (
      ("operation_type" = 'CREATE' AND "previous_admin_id" IS NULL AND "target_admin_id" IS NOT NULL
          AND "previous_admin_account_id" IS NULL AND "target_admin_account_id" IS NOT NULL)
      OR ("operation_type" = 'TRANSFER' AND "previous_admin_id" IS NOT NULL AND "target_admin_id" IS NOT NULL
          AND "previous_admin_account_id" IS NOT NULL AND "target_admin_account_id" IS NOT NULL
          AND "previous_admin_account_id" <> "target_admin_account_id")
      OR ("operation_type" = 'CLOSE' AND "previous_admin_id" IS NULL AND "target_admin_id" IS NULL
          AND "previous_admin_account_id" IS NULL AND "target_admin_account_id" IS NULL)
    ),
  CONSTRAINT "im_consultation_scope_operation_state_check"
    CHECK ("state" IN ('PENDING', 'RUNNING', 'UNKNOWN', 'SUCCEEDED', 'FAILED', 'NEEDS_REVIEW')),
  CONSTRAINT "im_consultation_scope_operation_version_check"
    CHECK ("scope_version" > 0),
  CONSTRAINT "im_consultation_scope_operation_owner_check"
    CHECK ("owner_account_id" ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'),
  CONSTRAINT "im_consultation_scope_operation_user_check"
    CHECK ("user_account_id" ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'),
  CONSTRAINT "im_consultation_scope_operation_previous_admin_id_check"
    CHECK ("previous_admin_id" IS NULL OR "previous_admin_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT "im_consultation_scope_operation_target_admin_id_check"
    CHECK ("target_admin_id" IS NULL OR "target_admin_id" ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  CONSTRAINT "im_consultation_scope_operation_previous_check"
    CHECK ("previous_admin_account_id" IS NULL OR "previous_admin_account_id" ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'),
  CONSTRAINT "im_consultation_scope_operation_target_check"
    CHECK ("target_admin_account_id" IS NULL OR "target_admin_account_id" ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'),
  CONSTRAINT "im_consultation_scope_operation_team_check"
    CHECK ("provider_team_id" IS NULL OR "provider_team_id" ~ '^[0-9]{1,19}$'),
  CONSTRAINT "im_consultation_scope_operation_attempt_check"
    CHECK ("attempt_count" >= 0),
  CONSTRAINT "im_consultation_scope_operation_failure_check"
    CHECK ("last_failure_class" IS NULL OR "last_failure_class" IN (
      'IDENTITY_PENDING', 'PROVIDER_UNKNOWN', 'PROVIDER_TRANSIENT', 'REMOTE_MISMATCH',
      'DB_WRITEBACK_UNKNOWN', 'STALE_OPERATION', 'REQUIRES_MANUAL_REVIEW'
    )),
  CONSTRAINT "im_consultation_scope_operation_detail_check"
    CHECK ("last_failure_detail" IS NULL OR length("last_failure_detail") <= 512),
  CONSTRAINT "im_consultation_scope_operation_lease_check"
    CHECK (
      ("state" = 'RUNNING' AND "lease_until" IS NOT NULL AND "lease_token_hash" IS NOT NULL)
      OR ("state" <> 'RUNNING' AND "lease_until" IS NULL AND "lease_token_hash" IS NULL)
    )
);

CREATE UNIQUE INDEX "im_consultation_scope_operation_active_idx"
  ON "zzsh_iam"."im_consultation_scope_operation" ("app_id", "consultation_id")
  WHERE "state" IN ('PENDING', 'RUNNING', 'UNKNOWN');

CREATE INDEX "im_consultation_scope_operation_due_idx"
  ON "zzsh_iam"."im_consultation_scope_operation" ("app_id", "state", "next_retry_at", "updated_at")
  WHERE "state" IN ('PENDING', 'UNKNOWN', 'RUNNING');

CREATE OR REPLACE FUNCTION "zzsh_iam"."guard_im_consultation_scope_operation_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
     OR NEW."app_id" IS DISTINCT FROM OLD."app_id"
     OR NEW."consultation_id" IS DISTINCT FROM OLD."consultation_id"
     OR NEW."operation_type" IS DISTINCT FROM OLD."operation_type"
     OR NEW."scope_version" IS DISTINCT FROM OLD."scope_version"
     OR NEW."owner_account_id" IS DISTINCT FROM OLD."owner_account_id"
     OR NEW."user_account_id" IS DISTINCT FROM OLD."user_account_id"
     OR NEW."previous_admin_id" IS DISTINCT FROM OLD."previous_admin_id"
     OR NEW."target_admin_id" IS DISTINCT FROM OLD."target_admin_id"
     OR NEW."previous_admin_account_id" IS DISTINCT FROM OLD."previous_admin_account_id"
     OR NEW."target_admin_account_id" IS DISTINCT FROM OLD."target_admin_account_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'IM consultation scope operation identity is immutable';
  END IF;
  IF NEW."state" IS DISTINCT FROM OLD."state" AND NOT (
    (OLD."state" = 'PENDING' AND NEW."state" = 'RUNNING')
    OR (OLD."state" = 'RUNNING' AND NEW."state" IN ('UNKNOWN', 'SUCCEEDED', 'FAILED', 'NEEDS_REVIEW'))
    OR (OLD."state" = 'UNKNOWN' AND NEW."state" = 'RUNNING')
    OR (OLD."state" IN ('FAILED', 'NEEDS_REVIEW') AND NEW."state" = 'PENDING')
  ) THEN
    RAISE EXCEPTION 'IM consultation scope operation transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "im_consultation_scope_operation_mutation_guard"
BEFORE UPDATE ON "zzsh_iam"."im_consultation_scope_operation"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."guard_im_consultation_scope_operation_mutation"();

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
    OR (OLD."message_scope_state" = 'FAILED' AND NEW."message_scope_state" IN ('PROVISIONING', 'TRANSFERRING', 'REVOKING', 'REVOKED'))
    OR (OLD."message_scope_state" = 'TRANSFERRING' AND NEW."message_scope_state" IN ('READY', 'FAILED', 'REVOKED'))
    OR (OLD."message_scope_state" = 'REVOKING' AND NEW."message_scope_state" IN ('READY', 'FAILED', 'REVOKED'))
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
