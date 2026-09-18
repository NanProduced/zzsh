CREATE TABLE IF NOT EXISTS "zzsh_iam"."im_identity_mapping" (
  "id" text PRIMARY KEY CHECK (char_length("id") BETWEEN 1 AND 128),
  "provider" text NOT NULL CHECK ("provider" = 'yunxin'),
  "app_id" text NOT NULL CHECK (char_length("app_id") BETWEEN 1 AND 128),
  "realm" text NOT NULL CHECK (char_length("realm") BETWEEN 1 AND 128),
  "identity_kind" text NOT NULL CHECK ("identity_kind" IN ('USER', 'ADMIN', 'SYSTEM')),
  "platform_subject_id" text NOT NULL CHECK (char_length("platform_subject_id") BETWEEN 1 AND 256),
  "account_id" text NOT NULL CHECK ("account_id" ~ '^[A-Za-z0-9][A-Za-z0-9_@.-]{0,31}$'),
  "identity_marker" text NOT NULL CHECK (char_length("identity_marker") BETWEEN 1 AND 4096),
  "status" text NOT NULL CHECK ("status" IN ('PENDING', 'READY', 'FAILED_PERMANENT', 'DISABLED', 'REVOKED')),
  "version" bigint NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "attempt_count" integer NOT NULL DEFAULT 0 CHECK ("attempt_count" >= 0),
  "attempt_lease_until" timestamptz,
  "attempt_lease_token_hash" text CHECK ("attempt_lease_token_hash" IS NULL OR "attempt_lease_token_hash" ~ '^[0-9a-f]{64}$'),
  "next_retry_at" timestamptz,
  "last_failure_class" text CHECK ("last_failure_class" IS NULL OR "last_failure_class" IN ('UNKNOWN_RESULT', 'TRANSIENT_PROVIDER', 'PERMANENT_PROVIDER', 'ACCOUNT_OWNERSHIP_CONFLICT')),
  "last_failure_provider_code" integer,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "im_identity_mapping_platform_unique"
    UNIQUE ("provider", "app_id", "realm", "identity_kind", "platform_subject_id"),
  CONSTRAINT "im_identity_mapping_account_unique"
    UNIQUE ("provider", "app_id", "account_id"),
  CONSTRAINT "im_identity_mapping_lease_pair_check"
    CHECK (("attempt_lease_until" IS NULL) = ("attempt_lease_token_hash" IS NULL)),
  CONSTRAINT "im_identity_mapping_pending_state_check"
    CHECK ("status" = 'PENDING' OR ("attempt_lease_until" IS NULL AND "attempt_lease_token_hash" IS NULL AND "next_retry_at" IS NULL)),
  CONSTRAINT "im_identity_mapping_permanent_failure_check"
    CHECK ("status" <> 'FAILED_PERMANENT' OR "last_failure_class" IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS "im_identity_mapping_pending_idx"
  ON "zzsh_iam"."im_identity_mapping" ("status", "next_retry_at", "attempt_lease_until", "updated_at", "id")
  WHERE "status" = 'PENDING';

CREATE INDEX IF NOT EXISTS "im_identity_mapping_scope_idx"
  ON "zzsh_iam"."im_identity_mapping" ("provider", "app_id", "realm", "identity_kind", "status", "updated_at", "id");

CREATE OR REPLACE FUNCTION "zzsh_iam"."guard_im_identity_mapping_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."provider" IS DISTINCT FROM OLD."provider"
     OR NEW."app_id" IS DISTINCT FROM OLD."app_id"
     OR NEW."realm" IS DISTINCT FROM OLD."realm"
     OR NEW."identity_kind" IS DISTINCT FROM OLD."identity_kind"
     OR NEW."platform_subject_id" IS DISTINCT FROM OLD."platform_subject_id"
     OR NEW."account_id" IS DISTINCT FROM OLD."account_id"
     OR NEW."identity_marker" IS DISTINCT FROM OLD."identity_marker"
     OR NEW."id" IS DISTINCT FROM OLD."id" THEN
    RAISE EXCEPTION 'IM identity mapping identity fields are immutable';
  END IF;
  IF NEW."status" IS DISTINCT FROM OLD."status" AND NOT (
    (OLD."status" = 'PENDING' AND NEW."status" IN ('READY', 'FAILED_PERMANENT', 'DISABLED', 'REVOKED'))
    OR (OLD."status" = 'READY' AND NEW."status" IN ('DISABLED', 'REVOKED'))
  ) THEN
    RAISE EXCEPTION 'IM identity mapping status transition is invalid';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "im_identity_mapping_mutation_guard" ON "zzsh_iam"."im_identity_mapping";
CREATE TRIGGER "im_identity_mapping_mutation_guard"
BEFORE UPDATE ON "zzsh_iam"."im_identity_mapping"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."guard_im_identity_mapping_mutation"();

INSERT INTO "zzsh_iam"."admin_permission" ("code", "name", "description")
VALUES ('im.support.read', '查看客服云信', '读取受权客服身份映射并签发当前会话的云信短效 Token')
ON CONFLICT ("code") DO NOTHING;
