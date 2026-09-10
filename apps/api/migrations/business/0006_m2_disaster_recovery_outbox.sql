ALTER TABLE "zzsh_iam"."admin_recovery_request"
  ADD COLUMN IF NOT EXISTS "recovery_method" text NOT NULL DEFAULT 'BOSS_CONFIRMATION',
  ADD COLUMN IF NOT EXISTS "offline_confirmation_id" text;

ALTER TABLE "zzsh_iam"."admin_recovery_request"
  DROP CONSTRAINT IF EXISTS "admin_recovery_request_method_check",
  DROP CONSTRAINT IF EXISTS "admin_recovery_request_offline_confirmation_check";

ALTER TABLE "zzsh_iam"."admin_recovery_request"
  ADD CONSTRAINT "admin_recovery_request_method_check"
    CHECK ("recovery_method" IN ('BOSS_CONFIRMATION', 'DISASTER_CLI')),
  ADD CONSTRAINT "admin_recovery_request_offline_confirmation_check"
    CHECK (
      ("recovery_method" = 'BOSS_CONFIRMATION' AND "offline_confirmation_id" IS NULL)
      OR ("recovery_method" = 'DISASTER_CLI' AND "offline_confirmation_id" IS NOT NULL)
    );

CREATE TABLE IF NOT EXISTS "zzsh_iam"."admin_recovery_notification_target" (
  "id" text PRIMARY KEY,
  "admin_user_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id") ON DELETE CASCADE,
  "channel" text NOT NULL CHECK ("channel" IN ('EMAIL', 'PHONE', 'SECURE_STORE')),
  "target_ref" text NOT NULL,
  "active" boolean NOT NULL DEFAULT true,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE UNIQUE INDEX IF NOT EXISTS "admin_recovery_notification_target_active_user_idx"
  ON "zzsh_iam"."admin_recovery_notification_target" ("admin_user_id")
  WHERE "active";

ALTER TABLE "zzsh_iam"."admin_security_notification_outbox"
  ADD COLUMN IF NOT EXISTS "next_attempt_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "claimed_at" timestamptz,
  ADD COLUMN IF NOT EXISTS "claim_token" text;

UPDATE "zzsh_iam"."admin_security_notification_outbox"
   SET "next_attempt_at" = COALESCE("next_attempt_at", "created_at");

ALTER TABLE "zzsh_iam"."admin_security_notification_outbox"
  ALTER COLUMN "next_attempt_at" SET DEFAULT clock_timestamp(),
  ALTER COLUMN "next_attempt_at" SET NOT NULL;

ALTER TABLE "zzsh_iam"."admin_security_notification_outbox"
  DROP CONSTRAINT IF EXISTS "admin_security_notification_outbox_event_check";

ALTER TABLE "zzsh_iam"."admin_security_notification_outbox"
  ADD CONSTRAINT "admin_security_notification_outbox_event_check"
  CHECK ("event" IN ('admin.frozen', 'admin.unfrozen', 'admin.recovery.issued', 'admin.recovery.completed', 'admin.recovery.disaster.issued'));

DROP INDEX IF EXISTS "zzsh_iam"."admin_security_notification_outbox_pending_idx";
CREATE INDEX "admin_security_notification_outbox_pending_idx"
  ON "zzsh_iam"."admin_security_notification_outbox" ("status", "next_attempt_at", "created_at");
