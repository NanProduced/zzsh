CREATE TABLE "zzsh_iam"."im_aftersale_record" (
  "id" text PRIMARY KEY,
  "app_id" text NOT NULL,
  "order_source" text NOT NULL CHECK ("order_source" = 'NATIVE'),
  "order_id" text NOT NULL REFERENCES "zzsh_order"."rental_order"("id"),
  "requester_user_id" text NOT NULL REFERENCES "zzsh_auth_user"."user"("id"),
  "requester_party" text NOT NULL CHECK ("requester_party" IN ('RENTER','OWNER')),
  "description" text NOT NULL CHECK (length("description") BETWEEN 1 AND 1000 AND octet_length("description") <= 4000),
  "state" text NOT NULL DEFAULT 'PENDING' CHECK ("state" IN ('PENDING','RESOLVED')),
  "handler_admin_id" text REFERENCES "zzsh_iam"."admin_security"("admin_user_id"),
  "result" text CHECK (length("result") BETWEEN 1 AND 1000 AND octet_length("result") <= 4000),
  "resolved_by_admin_id" text REFERENCES "zzsh_iam"."admin_security"("admin_user_id"),
  "resolved_at" timestamptz,
  "operation_id" text NOT NULL,
  "resolve_operation_id" text,
  "version" integer NOT NULL DEFAULT 1 CHECK ("version" > 0),
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  "updated_at" timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT "im_aftersale_resolution_shape" CHECK (
    ("state"='PENDING' AND "result" IS NULL AND "resolved_by_admin_id" IS NULL AND "resolved_at" IS NULL AND "resolve_operation_id" IS NULL)
    OR ("state"='RESOLVED' AND "result" IS NOT NULL AND "resolved_by_admin_id" IS NOT NULL AND "handler_admin_id" IS NOT NULL AND "handler_admin_id"="resolved_by_admin_id" AND "resolved_at" IS NOT NULL AND "resolve_operation_id" IS NOT NULL)
  ),
  UNIQUE ("app_id","requester_user_id","operation_id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "im_aftersale_one_pending" ON "zzsh_iam"."im_aftersale_record"("app_id","order_source","order_id","requester_user_id") WHERE "state"='PENDING';
--> statement-breakpoint
CREATE INDEX "im_aftersale_user_recent" ON "zzsh_iam"."im_aftersale_record"("app_id","requester_user_id","order_id","created_at" DESC,"id" DESC);
--> statement-breakpoint
CREATE INDEX "im_aftersale_queue" ON "zzsh_iam"."im_aftersale_record"("app_id","state","created_at" DESC,"id" DESC);
--> statement-breakpoint
-- Follow the already-confirmed consultation assignment; aftersale has no separate transfer workflow.
CREATE FUNCTION "zzsh_iam"."sync_aftersale_consultation_handler"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind='SERVICE' AND NEW.state='ACTIVE' AND NEW.assigned_admin_id IS NOT NULL THEN
    UPDATE zzsh_iam.im_aftersale_record
       SET handler_admin_id=NEW.assigned_admin_id,version=version+1,updated_at=clock_timestamp()
     WHERE app_id=NEW.app_id AND requester_user_id=NEW.user_id AND state='PENDING'
       AND handler_admin_id IS DISTINCT FROM NEW.assigned_admin_id;
  END IF;
  RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "im_aftersale_follow_consultation" AFTER INSERT OR UPDATE OF state,assigned_admin_id ON "zzsh_iam"."im_consultation"
  FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."sync_aftersale_consultation_handler"();
