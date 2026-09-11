ALTER TABLE "zzsh_iam"."admin_security"
  ADD COLUMN IF NOT EXISTS "last_full_authenticated_at" timestamptz;

CREATE TABLE IF NOT EXISTS "zzsh_iam"."admin_permission" (
  "code" text PRIMARY KEY,
  "name" text NOT NULL,
  "description" text,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "zzsh_iam"."admin_role" (
  "id" text PRIMARY KEY,
  "code" text NOT NULL UNIQUE,
  "name" text NOT NULL,
  "description" text,
  "status" text NOT NULL CHECK ("status" IN ('ACTIVE', 'DISABLED')),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "zzsh_iam"."admin_role_permission" (
  "role_id" text NOT NULL REFERENCES "zzsh_iam"."admin_role"("id") ON DELETE CASCADE,
  "permission_code" text NOT NULL REFERENCES "zzsh_iam"."admin_permission"("code"),
  PRIMARY KEY ("role_id", "permission_code")
);

CREATE TABLE IF NOT EXISTS "zzsh_iam"."admin_user_role" (
  "admin_user_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id") ON DELETE CASCADE,
  "role_id" text NOT NULL REFERENCES "zzsh_iam"."admin_role"("id") ON DELETE CASCADE,
  PRIMARY KEY ("admin_user_id", "role_id")
);

CREATE TABLE IF NOT EXISTS "zzsh_iam"."admin_user_permission" (
  "admin_user_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id") ON DELETE CASCADE,
  "permission_code" text NOT NULL REFERENCES "zzsh_iam"."admin_permission"("code"),
  "effect" text NOT NULL CHECK ("effect" IN ('ALLOW', 'DENY')),
  PRIMARY KEY ("admin_user_id", "permission_code")
);

CREATE INDEX IF NOT EXISTS "admin_user_role_role_idx"
  ON "zzsh_iam"."admin_user_role" ("role_id");
CREATE INDEX IF NOT EXISTS "admin_user_permission_code_idx"
  ON "zzsh_iam"."admin_user_permission" ("permission_code");

INSERT INTO "zzsh_iam"."admin_permission" ("code", "name", "description") VALUES
  ('admin.account.read', '查看管理员', '读取管理员目录与详情'),
  ('admin.account.create', '创建管理员', '创建普通管理员并交付临时密码'),
  ('admin.account.update', '编辑管理员资料', '修改显示名称等非身份字段'),
  ('admin.account.freeze', '冻结管理员', '冻结普通管理员登录与会话'),
  ('admin.account.unfreeze', '解冻管理员', '恢复已冻结的普通管理员'),
  ('admin.role.read', '查看角色', '读取预设角色与权限目录'),
  ('admin.role.configure', '配置角色', '创建或修改预设角色及其权限'),
  ('admin.permission.read', '查看权限', '读取有效权限与个人差异'),
  ('admin.permission.grant', '授予权限', '分配角色及个人允许或禁止')
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "zzsh_iam"."admin_role" ("id", "code", "name", "description", "status") VALUES
  ('role_preset_ops', 'ops', '运营', '可配置的运营预设角色，权限由配置决定，名称不触发硬编码能力', 'ACTIVE'),
  ('role_preset_support', 'support', '客服', '可配置的客服预设角色，权限由配置决定，名称不触发硬编码能力', 'ACTIVE')
ON CONFLICT ("code") DO NOTHING;
