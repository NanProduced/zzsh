ALTER TABLE "zzsh_content"."help_tree_node" ADD COLUMN "icon_key" text
  CHECK ("icon_key" IS NULL OR ("kind" = 'FOLDER' AND "icon_key" IN (
    'rental', 'publish', 'fees', 'account', 'after-sale', 'membership', 'agreement', 'folder', 'book', 'shield'
  )));

-- Preserve the old category navigation for libraries that already contain guides.
WITH categories("id", "title", "position") AS (
  VALUES ('rental', '租号与使用', 1), ('publish', '出租与管理', 2), ('fees', '费用与资金', 3),
    ('account', '账号与安全', 4), ('after-sale', '售后与保障', 5),
    ('membership', '会员与邀请', 6), ('agreement', '协议与规则', 7)
), used_categories AS (
  SELECT c."id", c."title", c."position", min(i."created_by_admin_id") AS "actor"
  FROM categories c
  JOIN "zzsh_content"."content_version" v ON v."payload"->>'category' = c."id"
  JOIN "zzsh_content"."content_item" i ON i."id" = v."item_id"
    AND i."type" = 'RESOURCE' AND i."resource_key" LIKE 'guide:%'
  WHERE v."state" IN ('DRAFT', 'PUBLISHED')
  GROUP BY c."id", c."title", c."position"
)
INSERT INTO "zzsh_content"."help_tree_node"
  ("id", "kind", "title", "icon_key", "sort_key", "created_by_admin_id", "updated_by_admin_id")
SELECT "id", 'FOLDER', "title", "id", lpad(("position" * 1000000)::text, 16, '0'), "actor", "actor"
FROM used_categories
ON CONFLICT ("id") DO NOTHING;

-- Attach previously created platform guides without changing content versions.
WITH missing AS (
  SELECT i."resource_key", i."created_by_admin_id", folder."id" AS "parent_id"
  FROM "zzsh_content"."content_item" i
  JOIN LATERAL (
    SELECT v."payload"->>'category' AS "category"
    FROM "zzsh_content"."content_version" v
    WHERE v."item_id" = i."id"
    ORDER BY (v."state" = 'PUBLISHED') DESC, v."sequence" DESC
    LIMIT 1
  ) version ON true
  LEFT JOIN "zzsh_content"."help_tree_node" folder ON folder."id" = version."category"
    AND folder."kind" = 'FOLDER' AND folder."deleted_at" IS NULL AND folder."depth" < 3
  WHERE i."type" = 'RESOURCE' AND i."game_id" IS NULL AND i."resource_key" LIKE 'guide:%'
    AND NOT EXISTS (SELECT 1 FROM "zzsh_content"."help_tree_node" n WHERE n."resource_key" = i."resource_key")
    AND NOT EXISTS (
      SELECT 1 FROM "zzsh_content"."help_slug_tombstone" t
      WHERE t."slug" = substr(i."resource_key", 7) AND t."deleted_at" IS NOT NULL
    )
), positions AS (
  SELECT m.*,
    coalesce((SELECT max(n."sort_key"::bigint) FROM "zzsh_content"."help_tree_node" n
      WHERE n."deleted_at" IS NULL AND n."parent_id" IS NOT DISTINCT FROM m."parent_id"), 0)
    + row_number() OVER (PARTITION BY m."parent_id" ORDER BY m."resource_key") * 1000000 AS "position"
  FROM missing m
)
INSERT INTO "zzsh_content"."help_tree_node"
  ("id", "parent_id", "kind", "resource_key", "sort_key", "created_by_admin_id", "updated_by_admin_id")
SELECT 'htn_' || replace(gen_random_uuid()::text, '-', ''), "parent_id", 'ARTICLE', "resource_key",
  lpad("position"::text, 16, '0'), "created_by_admin_id", "created_by_admin_id"
FROM positions;

INSERT INTO "zzsh_iam"."admin_permission" ("code", "name", "description") VALUES
  ('content.help.read', '读取帮助中心', '读取已发布的帮助目录及文章'),
  ('content.help.publish', '发布帮助文章', '发布或撤回帮助文章，并恢复帮助回收站内容'),
  ('content.updates.publish', '发布平台动态', '发布或下线平台公告和平台资讯')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "zzsh_iam"."admin_role_permission" ("role_id", "permission_code")
SELECT r."id", v."permission_code"
FROM (VALUES
  ('role_preset_support', 'content.help.read'),
  ('role_preset_ops', 'content.help.publish'),
  ('role_preset_ops', 'content.updates.publish')
) AS v("role_id", "permission_code")
JOIN "zzsh_iam"."admin_role" r ON r."id" = v."role_id"
ON CONFLICT ("role_id", "permission_code") DO NOTHING;
