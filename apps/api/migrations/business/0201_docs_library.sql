-- P1a internal documentation library (provisional number, Master to finalize).
-- New schema zzsh_docs: three-level node tree, append-only versions with a
-- 10-minute same-author merge window, private images and per-version image
-- references. Purely additive; no existing table or row is touched.
CREATE SCHEMA IF NOT EXISTS "zzsh_docs";

CREATE TABLE "zzsh_docs"."doc_node" (
  "id" text PRIMARY KEY,
  "parent_id" text REFERENCES "zzsh_docs"."doc_node"("id"),
  "depth" smallint NOT NULL CHECK ("depth" BETWEEN 1 AND 3),
  "sort_key" text COLLATE "C" NOT NULL,
  "title" text NOT NULL CHECK (char_length("title") BETWEEN 1 AND 200),
  "current_version_id" text,
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
  "created_by_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "updated_by_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  "deleted_by_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "delete_batch_id" text,
  CONSTRAINT "doc_node_delete_shape" CHECK (
    ("deleted_at" IS NULL AND "deleted_by_admin_id" IS NULL AND "delete_batch_id" IS NULL)
    OR ("deleted_at" IS NOT NULL AND "deleted_by_admin_id" IS NOT NULL AND "delete_batch_id" IS NOT NULL)
  )
);

-- PG16 NULLS NOT DISTINCT keeps top-level siblings (parent_id IS NULL) unique too.
CREATE UNIQUE INDEX "doc_node_sibling_sort_key" ON "zzsh_docs"."doc_node" ("parent_id", "sort_key") NULLS NOT DISTINCT WHERE "deleted_at" IS NULL;
CREATE INDEX "doc_node_parent_sort_idx" ON "zzsh_docs"."doc_node" ("parent_id", "sort_key");
CREATE INDEX "doc_node_updated_idx" ON "zzsh_docs"."doc_node" ("updated_at");
CREATE INDEX "doc_node_title_idx" ON "zzsh_docs"."doc_node" (lower("title"));
CREATE INDEX "doc_node_deleted_idx" ON "zzsh_docs"."doc_node" ("deleted_at") WHERE "deleted_at" IS NOT NULL;
CREATE INDEX "doc_node_batch_idx" ON "zzsh_docs"."doc_node" ("delete_batch_id") WHERE "delete_batch_id" IS NOT NULL;

CREATE TABLE "zzsh_docs"."doc_version" (
  "id" text PRIMARY KEY,
  "node_id" text NOT NULL REFERENCES "zzsh_docs"."doc_node"("id"),
  "seq" integer NOT NULL CHECK ("seq" >= 1),
  "document" jsonb NOT NULL CHECK (octet_length("document"::text) <= 200000),
  "digest" char(64) NOT NULL CHECK ("digest" ~ '^[0-9a-f]{64}$'),
  -- ANNOTATE is reserved for P1b comment marks; it never bumps the content revision.
  "kind" text NOT NULL CHECK ("kind" IN ('CREATE', 'EDIT', 'RESTORE', 'ANNOTATE')),
  "author_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "window_started_at" timestamptz NOT NULL,
  "saved_at" timestamptz NOT NULL,
  "save_count" integer NOT NULL DEFAULT 1 CHECK ("save_count" >= 1),
  "restored_from_version_id" text REFERENCES "zzsh_docs"."doc_version"("id"),
  CONSTRAINT "doc_version_node_seq_unique" UNIQUE ("node_id", "seq"),
  CONSTRAINT "doc_version_restore_shape" CHECK (
    ("kind" = 'RESTORE' AND "restored_from_version_id" IS NOT NULL)
    OR ("kind" <> 'RESTORE' AND "restored_from_version_id" IS NULL)
  )
);

CREATE INDEX "doc_version_node_seq_idx" ON "zzsh_docs"."doc_version" ("node_id", "seq" DESC);

ALTER TABLE "zzsh_docs"."doc_node"
  ADD CONSTRAINT "doc_node_current_version_fk" FOREIGN KEY ("current_version_id") REFERENCES "zzsh_docs"."doc_version"("id");

CREATE TABLE "zzsh_docs"."doc_image" (
  "id" text PRIMARY KEY,
  "uploaded_in_node_id" text NOT NULL REFERENCES "zzsh_docs"."doc_node"("id"),
  "object_key" text NOT NULL UNIQUE CHECK ("object_key" ~ '^internal-docs/doc_[0-9a-f]{32}/dimg_[0-9a-f]{32}\.(png|jpg|webp)$'),
  "mime" text NOT NULL CHECK ("mime" IN ('image/png', 'image/jpeg', 'image/webp')),
  "bytes" integer NOT NULL CHECK ("bytes" BETWEEN 1 AND 10485760),
  "width" integer NOT NULL CHECK ("width" BETWEEN 1 AND 8192),
  "height" integer NOT NULL CHECK ("height" BETWEEN 1 AND 8192),
  "status" text NOT NULL DEFAULT 'PENDING' CHECK ("status" IN ('PENDING', 'READY', 'PURGING')),
  "uploaded_by_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "upload_expires_at" timestamptz NOT NULL,
  "completed_at" timestamptz,
  CONSTRAINT "doc_image_ready_shape" CHECK (
    ("status" = 'READY' AND "completed_at" IS NOT NULL)
    OR ("status" <> 'READY' AND "completed_at" IS NULL)
  )
);

CREATE TABLE "zzsh_docs"."doc_version_image" (
  "version_id" text NOT NULL REFERENCES "zzsh_docs"."doc_version"("id"),
  "image_id" text NOT NULL REFERENCES "zzsh_docs"."doc_image"("id"),
  PRIMARY KEY ("version_id", "image_id")
);

CREATE INDEX "doc_version_image_image_idx" ON "zzsh_docs"."doc_version_image" ("image_id");

-- Depth is derived from the parent (1-3), cycles are refused and a deleted node
-- can never become a parent. Fires on insert and on any parent_id change; the
-- store re-parents descendants top-down so each row recomputes against its
-- already-updated parent.
CREATE FUNCTION "zzsh_docs"."guard_doc_node"() RETURNS trigger AS $$
DECLARE
  parent_depth smallint;
  parent_deleted timestamptz;
  cursor_id text;
  computed_depth smallint;
BEGIN
  IF NEW."parent_id" IS NULL THEN
    computed_depth := 1;
  ELSE
    SELECT "depth", "deleted_at" INTO parent_depth, parent_deleted
      FROM "zzsh_docs"."doc_node" WHERE "id" = NEW."parent_id";
    IF parent_depth IS NULL THEN
      RAISE EXCEPTION 'doc_node parent does not exist';
    END IF;
    IF parent_deleted IS NOT NULL THEN
      RAISE EXCEPTION 'doc_node parent is deleted';
    END IF;
    cursor_id := NEW."parent_id";
    WHILE cursor_id IS NOT NULL LOOP
      IF cursor_id = NEW."id" THEN
        RAISE EXCEPTION 'doc_node cycle';
      END IF;
      SELECT "parent_id" INTO cursor_id FROM "zzsh_docs"."doc_node" WHERE "id" = cursor_id;
    END LOOP;
    computed_depth := parent_depth + 1;
  END IF;
  IF computed_depth > 3 THEN
    RAISE EXCEPTION 'doc_node depth exceeds three levels';
  END IF;
  NEW."depth" := computed_depth;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "doc_node_guard" BEFORE INSERT OR UPDATE OF "parent_id"
  ON "zzsh_docs"."doc_node" FOR EACH ROW EXECUTE FUNCTION "zzsh_docs"."guard_doc_node"();

-- Only the newest kind=EDIT row of a node may be updated in place (the merge
-- window). Identity, authorship and window columns are immutable; CREATE,
-- RESTORE and ANNOTATE rows are append-only.
CREATE FUNCTION "zzsh_docs"."guard_doc_version_update"() RETURNS trigger AS $$
BEGIN
  IF OLD."kind" <> 'EDIT' THEN
    RAISE EXCEPTION 'doc_version only EDIT rows may be updated in place';
  END IF;
  IF EXISTS (SELECT 1 FROM "zzsh_docs"."doc_version" v WHERE v."node_id" = OLD."node_id" AND v."seq" > OLD."seq") THEN
    RAISE EXCEPTION 'doc_version only the latest row may be updated in place';
  END IF;
  IF NEW."id" <> OLD."id" OR NEW."node_id" <> OLD."node_id" OR NEW."seq" <> OLD."seq"
    OR NEW."kind" <> OLD."kind" OR NEW."author_admin_id" <> OLD."author_admin_id"
    OR NEW."window_started_at" <> OLD."window_started_at"
    OR NEW."restored_from_version_id" IS DISTINCT FROM OLD."restored_from_version_id" THEN
    RAISE EXCEPTION 'doc_version identity columns are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "doc_version_update_guard" BEFORE UPDATE
  ON "zzsh_docs"."doc_version" FOR EACH ROW EXECUTE FUNCTION "zzsh_docs"."guard_doc_version_update"();