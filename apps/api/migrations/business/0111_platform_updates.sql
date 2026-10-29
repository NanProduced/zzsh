ALTER TABLE "zzsh_content"."content_version" ADD COLUMN "update_settings" jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE "zzsh_content"."content_version" ADD CONSTRAINT "content_update_settings_shape"
  CHECK (jsonb_typeof("update_settings") = 'object' AND octet_length("update_settings"::text) <= 65536);
CREATE FUNCTION "zzsh_content"."guard_update_settings"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'UPDATE' AND OLD."state" <> 'DRAFT' AND NEW."update_settings" IS DISTINCT FROM OLD."update_settings" THEN
    RAISE EXCEPTION 'published update settings are immutable' USING ERRCODE = '23514';
  END IF;
  IF NEW."update_settings" <> '{}'::jsonb AND EXISTS (SELECT 1 FROM "zzsh_content"."content_item" WHERE "id" = NEW."item_id" AND "type" = 'RESOURCE') THEN
    RAISE EXCEPTION 'resource cannot carry update settings' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "content_update_settings_guard" BEFORE INSERT OR UPDATE ON "zzsh_content"."content_version"
  FOR EACH ROW EXECUTE FUNCTION "zzsh_content"."guard_update_settings"();
