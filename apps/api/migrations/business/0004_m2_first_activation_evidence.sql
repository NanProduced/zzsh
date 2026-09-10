ALTER TABLE "zzsh_iam"."admin_security"
  ADD COLUMN IF NOT EXISTS "first_activated_at" timestamptz;

UPDATE "zzsh_iam"."admin_security"
   SET "first_activated_at" = COALESCE("bootstrap_used_at", "updated_at", "created_at")
 WHERE "first_activated_at" IS NULL
   AND "status" = 'ACTIVE';

ALTER TABLE "zzsh_iam"."admin_security"
  DROP CONSTRAINT IF EXISTS "admin_security_first_activation_check";

ALTER TABLE "zzsh_iam"."admin_security"
  ADD CONSTRAINT "admin_security_first_activation_check"
  CHECK ("status" <> 'ACTIVE' OR "first_activated_at" IS NOT NULL);

CREATE OR REPLACE FUNCTION "zzsh_iam"."protect_admin_first_activation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."status" <> 'PENDING_ENROLLMENT' OR NEW."first_activated_at" IS NOT NULL THEN
      RAISE EXCEPTION 'admin first activation must use the enrollment transition';
    END IF;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD."first_activated_at" IS NOT NULL AND NEW."first_activated_at" IS DISTINCT FROM OLD."first_activated_at" THEN
      RAISE EXCEPTION 'admin first activation evidence is immutable';
    END IF;
    IF OLD."first_activated_at" IS NULL AND NEW."first_activated_at" IS NOT NULL
       AND NOT (OLD."status" = 'PENDING_ENROLLMENT' AND NEW."status" = 'ACTIVE') THEN
      RAISE EXCEPTION 'admin first activation evidence must be created by enrollment';
    END IF;
  END IF;
  IF NEW."status" = 'ACTIVE' AND NEW."first_activated_at" IS NULL THEN
    RAISE EXCEPTION 'active admin requires first activation evidence';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "admin_first_activation_evidence" ON "zzsh_iam"."admin_security";
CREATE TRIGGER "admin_first_activation_evidence"
BEFORE INSERT OR UPDATE ON "zzsh_iam"."admin_security"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."protect_admin_first_activation"();
