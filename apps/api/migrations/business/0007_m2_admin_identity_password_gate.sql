ALTER TABLE "zzsh_iam"."admin_security"
  ADD COLUMN IF NOT EXISTS "password_change_required" boolean NOT NULL DEFAULT false;

-- Existing administrator rows keep their current login state. Only a new
-- controlled bootstrap sets this flag to true.
CREATE SEQUENCE IF NOT EXISTS "zzsh_iam"."admin_login_number_seq"
  AS bigint
  START WITH 1
  INCREMENT BY 1
  MINVALUE 1
  NO CYCLE;

CREATE OR REPLACE FUNCTION "zzsh_iam"."clear_admin_password_change_requirement"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."password" IS DISTINCT FROM OLD."password" THEN
    UPDATE "zzsh_iam"."admin_security"
       SET "password_change_required" = false,
           "updated_at" = clock_timestamp()
     WHERE "admin_user_id" = NEW."userId"
       AND "password_change_required" = true;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "admin_password_change_requirement" ON "zzsh_auth_admin"."account";
CREATE TRIGGER "admin_password_change_requirement"
AFTER UPDATE OF "password" ON "zzsh_auth_admin"."account"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."clear_admin_password_change_requirement"();
