ALTER TABLE "zzsh_iam"."admin_recovery_request"
  ADD COLUMN IF NOT EXISTS "recovery_token_hash" text;

CREATE UNIQUE INDEX IF NOT EXISTS "admin_recovery_request_token_hash_idx"
  ON "zzsh_iam"."admin_recovery_request" ("recovery_token_hash")
  WHERE "recovery_token_hash" IS NOT NULL;

ALTER TABLE "zzsh_iam"."admin_recovery_request"
  DROP CONSTRAINT IF EXISTS "admin_recovery_request_status_check";

ALTER TABLE "zzsh_iam"."admin_recovery_request"
  ADD CONSTRAINT "admin_recovery_request_status_check"
  CHECK ("status" IN ('PENDING', 'ISSUED', 'COMPLETED', 'EXPIRED'));
