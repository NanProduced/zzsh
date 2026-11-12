-- P1a internal documentation library permission catalog (provisional number, Master to finalize).
-- Additive seed only; mirrors the 0024 catalog shape. Boss is an is_boss bypass,
-- not a role, so docs.internal.manage is delegable and never Boss-only.
INSERT INTO "zzsh_iam"."admin_permission" ("code", "name", "description") VALUES
  ('docs.internal.read', '读取内部文档', '读取内部文档树、详情、版本、回收站、搜索与图片签名'),
  ('docs.internal.comment', '评论内部文档', '在内部文档划词评论、回复、解决或重开讨论'),
  ('docs.internal.manage', '管理内部文档', '新建、编辑、移动、删除、恢复、回滚内部文档并上传图片')
ON CONFLICT ("code") DO NOTHING;