-- A replaced resource draft is retained as history without inventing publication facts.
ALTER TABLE "zzsh_content"."content_version" DROP CONSTRAINT "content_version_publish_shape";
ALTER TABLE "zzsh_content"."content_version" ADD CONSTRAINT "content_version_publish_shape" CHECK (
  ("state" = 'DRAFT' AND "published_at" IS NULL AND "published_by_admin_id" IS NULL)
  OR ("state" <> 'DRAFT' AND "published_at" IS NOT NULL AND "published_by_admin_id" IS NOT NULL)
  OR ("state" = 'SUPERSEDED' AND "payload" IS NOT NULL AND "published_at" IS NULL AND "published_by_admin_id" IS NULL)
);
