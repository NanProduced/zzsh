CREATE TABLE zzsh_iam.user_rental_membership (
  user_id text PRIMARY KEY REFERENCES zzsh_auth_user."user"(id),
  tier text NOT NULL CHECK(tier IN ('STANDARD','VIP','SVIP','DISCOUNT_USER','UNKNOWN')),
  version bigint NOT NULL DEFAULT 1 CHECK(version>0),
  source_ref text NOT NULL CHECK(length(btrim(source_ref)) BETWEEN 1 AND 256),
  updated_by_admin_id text REFERENCES zzsh_auth_admin."user"(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
CREATE FUNCTION zzsh_iam.guard_rental_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.version<>1 THEN RAISE EXCEPTION 'initial membership version must be 1'; END IF;
  ELSE
    IF NEW.user_id<>OLD.user_id OR NEW.version<>OLD.version+1 THEN RAISE EXCEPTION 'invalid membership version' USING ERRCODE='40001'; END IF;
  END IF;
  NEW.updated_at:=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER rental_membership_guard BEFORE INSERT OR UPDATE ON zzsh_iam.user_rental_membership FOR EACH ROW EXECUTE FUNCTION zzsh_iam.guard_rental_membership();
-- No backfill. Every new platform identity is initialized in its creation transaction,
-- independent of username/phone/Better Auth entry point. Historical imports must explicitly
-- set their authorized known/UNKNOWN provenance, never infer it from display names.
CREATE FUNCTION zzsh_iam.initialize_rental_membership() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO zzsh_iam.user_rental_membership(user_id,tier,source_ref) VALUES(NEW.id,'STANDARD','registration:v1');
  RETURN NEW;
END $$;
CREATE TRIGGER user_rental_membership_init AFTER INSERT ON zzsh_auth_user."user" FOR EACH ROW EXECUTE FUNCTION zzsh_iam.initialize_rental_membership();
INSERT INTO zzsh_iam.admin_permission(code,name,description) VALUES ('user.rental_membership.manage','管理租赁会员资格','受权读取及修改用户租赁会员资格，要求原因与版本校验');
