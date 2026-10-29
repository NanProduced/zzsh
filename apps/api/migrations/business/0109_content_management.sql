-- Content snapshots and recoverable drafts; follows the accepted supply migration.
ALTER TABLE "zzsh_content"."content_item" DROP CONSTRAINT "content_item_type_check";
ALTER TABLE "zzsh_content"."content_item" ADD CONSTRAINT "content_item_type_check"
  CHECK ("type" IN ('ANNOUNCEMENT', 'NEWS', 'RESOURCE'));
ALTER TABLE "zzsh_content"."content_item" ADD COLUMN "resource_key" text;
ALTER TABLE "zzsh_content"."content_item" ADD CONSTRAINT "content_item_resource_shape"
  CHECK (("type" = 'RESOURCE' AND "resource_key" IS NOT NULL AND length("resource_key") <= 128
    AND "resource_key" ~ '^(guide:[a-z0-9]+(-[a-z0-9]+)*|placement:[A-Z][A-Z0-9_]*)$')
    OR ("type" <> 'RESOURCE' AND "resource_key" IS NULL));
CREATE UNIQUE INDEX "content_item_resource_key_unique" ON "zzsh_content"."content_item" ("resource_key") WHERE "resource_key" IS NOT NULL;
ALTER TABLE "zzsh_content"."content_version" ADD COLUMN "payload" jsonb;
ALTER TABLE "zzsh_content"."content_version" ADD CONSTRAINT "content_version_payload_shape"
  CHECK ("payload" IS NULL OR (jsonb_typeof("payload") = 'object' AND octet_length("payload"::text) <= 250000));

CREATE FUNCTION "zzsh_content"."guard_resource_version"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_type text;
BEGIN
  SELECT "type" INTO item_type FROM "zzsh_content"."content_item" WHERE "id" = NEW."item_id";
  IF (item_type = 'RESOURCE') <> (NEW."payload" IS NOT NULL) THEN
    RAISE EXCEPTION 'content resource payload shape mismatch' USING ERRCODE = '23514';
  END IF;
  IF item_type = 'RESOURCE' AND TG_OP = 'UPDATE' AND ((OLD."state" = 'DRAFT' AND NEW."state" NOT IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED'))
    OR (OLD."state" = 'PUBLISHED' AND NEW."state" NOT IN ('PUBLISHED', 'SUPERSEDED', 'WITHDRAWN'))
    OR (OLD."state" IN ('SUPERSEDED', 'WITHDRAWN') AND NEW."state" <> OLD."state")) THEN
    RAISE EXCEPTION 'content version state transition is immutable' USING ERRCODE = '23514';
  END IF;
  IF item_type = 'RESOURCE' AND TG_OP = 'UPDATE' AND OLD."state" <> 'DRAFT' AND
    (NEW."payload", NEW."title", NEW."summary", NEW."body", NEW."cover_media_id", NEW."item_id", NEW."sequence", NEW."published_at", NEW."published_by_admin_id", NEW."created_at", NEW."created_by_admin_id")
      IS DISTINCT FROM
    (OLD."payload", OLD."title", OLD."summary", OLD."body", OLD."cover_media_id", OLD."item_id", OLD."sequence", OLD."published_at", OLD."published_by_admin_id", OLD."created_at", OLD."created_by_admin_id") THEN
    RAISE EXCEPTION 'published content versions are immutable' USING ERRCODE = '23514';
  END IF;
  IF item_type = 'RESOURCE' AND TG_OP = 'UPDATE' AND OLD."state" = 'DRAFT' AND NEW."state" = 'SUPERSEDED' AND
    (NEW."payload", NEW."title", NEW."summary", NEW."body", NEW."cover_media_id", NEW."item_id", NEW."sequence", NEW."published_at", NEW."published_by_admin_id", NEW."created_at", NEW."created_by_admin_id") IS DISTINCT FROM
    (OLD."payload", OLD."title", OLD."summary", OLD."body", OLD."cover_media_id", OLD."item_id", OLD."sequence", OLD."published_at", OLD."published_by_admin_id", OLD."created_at", OLD."created_by_admin_id") THEN
    RAISE EXCEPTION 'superseded draft snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER "content_resource_version_guard" BEFORE INSERT OR UPDATE ON "zzsh_content"."content_version"
  FOR EACH ROW EXECUTE FUNCTION "zzsh_content"."guard_resource_version"();
