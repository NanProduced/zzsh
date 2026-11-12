-- Help center tree, slug tombstones and update visibility.
-- Existing content snapshots stay immutable; the API projects legacy bodies to Plate.

-- Help center tree. FOLDER nodes drive the public directory; ARTICLE nodes
-- point at a guide resource. Only folders containing a published article are
-- public. Deletion is soft (30-day trash) and shares a delete_batch_id.
CREATE TABLE "zzsh_content"."help_tree_node" (
  "id" text PRIMARY KEY,
  "parent_id" text REFERENCES "zzsh_content"."help_tree_node"("id"),
  "depth" smallint NOT NULL CHECK ("depth" BETWEEN 1 AND 3),
  "kind" text NOT NULL CHECK ("kind" IN ('FOLDER', 'ARTICLE')),
  "title" text,
  "description" text CHECK ("description" IS NULL OR char_length("description") <= 120),
  "resource_key" text,
  "sort_key" text COLLATE "C" NOT NULL,
  "revision" bigint NOT NULL DEFAULT 1 CHECK ("revision" >= 1),
  "created_by_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "updated_by_admin_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "deleted_at" timestamptz,
  "deleted_by_admin_id" text REFERENCES "zzsh_auth_admin"."user"("id"),
  "delete_batch_id" text,
  "pre_delete_state" text CHECK ("pre_delete_state" IN ('PUBLISHED', 'DRAFT_ONLY')),
  CONSTRAINT "help_tree_node_folder_title" CHECK (
    "kind" <> 'FOLDER' OR ("title" IS NOT NULL AND char_length("title") BETWEEN 1 AND 40)),
  CONSTRAINT "help_tree_node_article_key" CHECK (
    ("kind" = 'ARTICLE' AND "resource_key" IS NOT NULL AND "resource_key" ~ '^guide:[a-z0-9]+(-[a-z0-9]+)*$')
    OR ("kind" = 'FOLDER' AND "resource_key" IS NULL)),
  CONSTRAINT "help_tree_node_delete_shape" CHECK (
    ("deleted_at" IS NULL AND "deleted_by_admin_id" IS NULL AND "delete_batch_id" IS NULL AND "pre_delete_state" IS NULL)
    OR ("deleted_at" IS NOT NULL AND "deleted_by_admin_id" IS NOT NULL AND "delete_batch_id" IS NOT NULL)),
  CONSTRAINT "help_tree_node_pre_delete_article" CHECK ("pre_delete_state" IS NULL OR "kind" = 'ARTICLE')
);

-- resource_key is reserved even while soft-deleted: a slug is never reused.
CREATE UNIQUE INDEX "help_tree_node_resource_key_unique" ON "zzsh_content"."help_tree_node" ("resource_key") WHERE "resource_key" IS NOT NULL;
-- PG16 NULLS NOT DISTINCT keeps top-level siblings (parent_id IS NULL) unique too.
CREATE UNIQUE INDEX "help_tree_node_sibling_sort_key" ON "zzsh_content"."help_tree_node" ("parent_id", "sort_key") NULLS NOT DISTINCT WHERE "deleted_at" IS NULL;
CREATE INDEX "help_tree_node_parent_sort_idx" ON "zzsh_content"."help_tree_node" ("parent_id", "sort_key");
CREATE INDEX "help_tree_node_deleted_idx" ON "zzsh_content"."help_tree_node" ("deleted_at") WHERE "deleted_at" IS NOT NULL;
CREATE INDEX "help_tree_node_batch_idx" ON "zzsh_content"."help_tree_node" ("delete_batch_id") WHERE "delete_batch_id" IS NOT NULL;

-- Depth derives from the parent (1-3); cycles and deleted parents are refused;
-- an ARTICLE can never be a parent (no children under an article).
CREATE FUNCTION "zzsh_content"."guard_help_tree_node"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_depth smallint;
  parent_deleted timestamptz;
  parent_kind text;
  cursor_id text;
  computed_depth smallint;
BEGIN
  IF NEW."parent_id" IS NULL THEN
    computed_depth := 1;
  ELSE
    SELECT "depth", "deleted_at", "kind" INTO parent_depth, parent_deleted, parent_kind
      FROM "zzsh_content"."help_tree_node" WHERE "id" = NEW."parent_id";
    IF parent_depth IS NULL THEN
      RAISE EXCEPTION 'help_tree_node parent does not exist';
    END IF;
    IF parent_deleted IS NOT NULL THEN
      RAISE EXCEPTION 'help_tree_node parent is deleted';
    END IF;
    IF parent_kind <> 'FOLDER' THEN
      RAISE EXCEPTION 'help_tree_node article cannot have children';
    END IF;
    cursor_id := NEW."parent_id";
    WHILE cursor_id IS NOT NULL LOOP
      IF cursor_id = NEW."id" THEN
        RAISE EXCEPTION 'help_tree_node cycle';
      END IF;
      SELECT "parent_id" INTO cursor_id FROM "zzsh_content"."help_tree_node" WHERE "id" = cursor_id;
    END LOOP;
    computed_depth := parent_depth + 1;
  END IF;
  IF computed_depth > 3 THEN
    RAISE EXCEPTION 'help_tree_node depth exceeds three levels';
  END IF;
  NEW."depth" := computed_depth;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "help_tree_node_guard" BEFORE INSERT OR UPDATE OF "parent_id"
  ON "zzsh_content"."help_tree_node" FOR EACH ROW EXECUTE FUNCTION "zzsh_content"."guard_help_tree_node"();

-- 3. Slug tombstones. Written on delete, kept after purge, never deleted: an
-- old /help/<slug> link always resolves to the offline page, never a new article.
-- deleted_at is cleared on restore (the same article comes back); purged_at is
-- set by the 30-day cleanup. A row with deleted_at set reserves the slug forever.
CREATE TABLE "zzsh_content"."help_slug_tombstone" (
  "slug" text PRIMARY KEY,
  "resource_key" text NOT NULL,
  "last_title" text,
  "deleted_at" timestamptz,
  "purged_at" timestamptz
);

-- 4. update_settings.visibleFrom is a jsonb key (no new column). Constrain its
-- shape so a scheduled visibility time is always a valid UTC timestamp or null.
ALTER TABLE "zzsh_content"."content_version" ADD CONSTRAINT "content_update_settings_visible_from"
  CHECK ("update_settings"->>'visibleFrom' IS NULL
    OR "update_settings"->>'visibleFrom' ~ '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$');

-- 5. Updates (ANNOUNCEMENT / NEWS) now store their plate document in payload and
-- a plain-text projection in body. Relax the resource-only payload shape so a
-- non-RESOURCE version may carry a payload, and extend published-version
-- immutability to every content type. The RESOURCE state machine is unchanged.
CREATE OR REPLACE FUNCTION "zzsh_content"."guard_resource_version"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE item_type text;
BEGIN
  SELECT "type" INTO item_type FROM "zzsh_content"."content_item" WHERE "id" = NEW."item_id";
  IF item_type = 'RESOURCE' AND NEW."payload" IS NULL THEN
    RAISE EXCEPTION 'content resource payload shape mismatch' USING ERRCODE = '23514';
  END IF;
  IF item_type = 'RESOURCE' AND TG_OP = 'UPDATE' AND ((OLD."state" = 'DRAFT' AND NEW."state" NOT IN ('DRAFT', 'PUBLISHED', 'SUPERSEDED'))
    OR (OLD."state" = 'PUBLISHED' AND NEW."state" NOT IN ('PUBLISHED', 'SUPERSEDED', 'WITHDRAWN'))
    OR (OLD."state" IN ('SUPERSEDED', 'WITHDRAWN') AND NEW."state" <> OLD."state")) THEN
    RAISE EXCEPTION 'content version state transition is immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."state" <> 'DRAFT' AND
    (NEW."payload", NEW."title", NEW."summary", NEW."body", NEW."cover_media_id", NEW."item_id", NEW."sequence", NEW."published_at", NEW."published_by_admin_id", NEW."created_at", NEW."created_by_admin_id")
      IS DISTINCT FROM
    (OLD."payload", OLD."title", OLD."summary", OLD."body", OLD."cover_media_id", OLD."item_id", OLD."sequence", OLD."published_at", OLD."published_by_admin_id", OLD."created_at", OLD."created_by_admin_id") THEN
    RAISE EXCEPTION 'published content versions are immutable' USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD."state" = 'DRAFT' AND NEW."state" = 'SUPERSEDED' AND
    (NEW."payload", NEW."title", NEW."summary", NEW."body", NEW."cover_media_id", NEW."item_id", NEW."sequence", NEW."published_at", NEW."published_by_admin_id", NEW."created_at", NEW."created_by_admin_id") IS DISTINCT FROM
    (OLD."payload", OLD."title", OLD."summary", OLD."body", OLD."cover_media_id", OLD."item_id", OLD."sequence", OLD."published_at", OLD."published_by_admin_id", OLD."created_at", OLD."created_by_admin_id") THEN
    RAISE EXCEPTION 'superseded draft snapshot is immutable' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;