-- Read projection only. Audit remains the source; invalid newest facts explicitly retain a null date.
CREATE TABLE "zzsh_iam"."user_registration_fact" (
  "user_id" text PRIMARY KEY,
  "audit_id" text NOT NULL,
  "occurred_at" timestamptz NOT NULL,
  "legacy_id" text,
  "registered_at" timestamptz
);
--> statement-breakpoint
CREATE FUNCTION "zzsh_iam"."migration_registration_time"(details jsonb)
RETURNS timestamptz LANGUAGE sql STABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN details->>'sourceSystem'='legacy_mysql_restore'
    AND details->>'sourceEntity'='la_user' AND NULLIF(details->>'legacyId','') IS NOT NULL
    AND details->>'sourceDigest' ~ '^[0-9a-f]{64}$' AND NULLIF(details->>'evidenceRef','') IS NOT NULL
    AND details->>'sourceCreatedAt' ~ '^[0-9]{4}-(0[1-9]|1[0-2])-(0[1-9]|[12][0-9]|3[01])T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]([.][0-9]{1,6})?Z$'
    AND pg_input_is_valid(details->>'sourceCreatedAt','timestamp with time zone')
    THEN (details->>'sourceCreatedAt')::timestamptz ELSE NULL END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "zzsh_iam"."migration_registration_time"(jsonb) FROM PUBLIC;
--> statement-breakpoint
CREATE FUNCTION "zzsh_iam"."refresh_user_registration_fact"()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  INSERT INTO zzsh_iam.user_registration_fact(user_id,audit_id,occurred_at,legacy_id,registered_at)
    VALUES (NEW.object_id,NEW.id,NEW.occurred_at,NEW.details->>'legacyId',zzsh_iam.migration_registration_time(NEW.details))
  ON CONFLICT (user_id) DO UPDATE SET audit_id=EXCLUDED.audit_id,occurred_at=EXCLUDED.occurred_at,
    legacy_id=EXCLUDED.legacy_id,registered_at=EXCLUDED.registered_at
  WHERE (EXCLUDED.occurred_at,EXCLUDED.audit_id) > (user_registration_fact.occurred_at,user_registration_fact.audit_id);
  RETURN NEW;
END;
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION "zzsh_iam"."refresh_user_registration_fact"() FROM PUBLIC;
--> statement-breakpoint
-- Install before backfill: the trigger's table lock closes the insert/backfill race until migration commit.
CREATE TRIGGER "user_registration_fact_after_migration"
AFTER INSERT ON "zzsh_iam"."audit_event"
FOR EACH ROW WHEN (NEW.action='user.legacy_owner.migrated' AND NEW.object_type='user' AND NEW.outcome='SUCCESS' AND NEW.object_id IS NOT NULL)
EXECUTE FUNCTION "zzsh_iam"."refresh_user_registration_fact"();
--> statement-breakpoint
INSERT INTO zzsh_iam.user_registration_fact(user_id,audit_id,occurred_at,legacy_id,registered_at)
SELECT object_id,id,occurred_at,details->>'legacyId',zzsh_iam.migration_registration_time(details)
FROM (
  SELECT DISTINCT ON (object_id) object_id,id,occurred_at,details
  FROM zzsh_iam.audit_event
  WHERE action='user.legacy_owner.migrated' AND object_type='user' AND outcome='SUCCESS' AND object_id IS NOT NULL
  ORDER BY object_id,occurred_at DESC,id DESC
) latest
ON CONFLICT (user_id) DO UPDATE SET audit_id=EXCLUDED.audit_id,occurred_at=EXCLUDED.occurred_at,
  legacy_id=EXCLUDED.legacy_id,registered_at=EXCLUDED.registered_at
WHERE (EXCLUDED.occurred_at,EXCLUDED.audit_id) > (user_registration_fact.occurred_at,user_registration_fact.audit_id);
--> statement-breakpoint
ANALYZE zzsh_iam.user_registration_fact;
