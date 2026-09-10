CREATE TABLE IF NOT EXISTS "zzsh_iam"."admin_security_notification_outbox" (
  "id" text PRIMARY KEY,
  "event" text NOT NULL CHECK ("event" IN ('admin.frozen', 'admin.unfrozen', 'admin.recovery.issued', 'admin.recovery.completed')),
  "actor_id" text NOT NULL,
  "target_admin_id" text NOT NULL,
  "reason" text,
  "request_id" text NOT NULL,
  "status" text NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING', 'DELIVERED')),
  "attempts" integer NOT NULL DEFAULT 0,
  "last_error" text,
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "delivered_at" timestamptz
);

CREATE INDEX IF NOT EXISTS "admin_security_notification_outbox_pending_idx"
  ON "zzsh_iam"."admin_security_notification_outbox" ("status", "created_at");

CREATE OR REPLACE FUNCTION "zzsh_iam"."revoke_admin_recovery_on_password_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."password" IS DISTINCT FROM OLD."password" THEN
    UPDATE "zzsh_iam"."admin_recovery_request"
       SET "status" = 'EXPIRED', "recovery_token_hash" = NULL
     WHERE "target_admin_user_id" = NEW."userId"
       AND "status" IN ('PENDING', 'ISSUED');
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "admin_recovery_revoke_on_password_change" ON "zzsh_auth_admin"."account";
CREATE TRIGGER "admin_recovery_revoke_on_password_change"
AFTER UPDATE OF "password" ON "zzsh_auth_admin"."account"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."revoke_admin_recovery_on_password_change"();
