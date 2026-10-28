-- ADMIN-USER-FREEZE-01：用户自助“停用(DEACTIVATED)”退役，改为管理员冻结(FROZEN)/解冻。
-- 1) 放宽 CHECK 以接纳 FROZEN；2) 存量 DEACTIVATED 迁为 FROZEN（并保证 suspended=true）；
-- 3) 收紧 CHECK 为 ACTIVE/FROZEN/CANCELLED；4) 新增 user.account.freeze / user.account.unfreeze
--    （Boss 运行时自动拥有全部 ADMIN_PERMISSION_CODES，此处不向任何角色或个人授予）；
-- 5) user.account.restore 前向退役：撤销全部角色/个人授权，权限行保留（历史审计/审批仍引用该 code）。
-- user_identity_state 的审计触发器会为第 2 步每行写入 system 审计，属预期。
DO $$
DECLARE c record;
BEGIN
  FOR c IN
    SELECT con.conname FROM pg_constraint con
     WHERE con.conrelid = '"zzsh_iam"."user_identity_state"'::regclass
       AND con.contype = 'c'
       AND pg_get_constraintdef(con.oid) LIKE '%account_status%'
  LOOP
    EXECUTE format('ALTER TABLE "zzsh_iam"."user_identity_state" DROP CONSTRAINT %I', c.conname);
  END LOOP;
END $$;
--> statement-breakpoint
UPDATE "zzsh_auth_user"."user" u
   SET "suspended" = true, "updatedAt" = clock_timestamp()
  FROM "zzsh_iam"."user_identity_state" s
 WHERE s."user_id" = u."id" AND s."account_status" = 'DEACTIVATED' AND NOT u."suspended";
--> statement-breakpoint
UPDATE "zzsh_iam"."user_identity_state"
   SET "account_status" = 'FROZEN', "version" = "version" + 1, "updated_at" = clock_timestamp()
 WHERE "account_status" = 'DEACTIVATED';
--> statement-breakpoint
ALTER TABLE "zzsh_iam"."user_identity_state"
  ADD CONSTRAINT "user_identity_state_account_status_check"
  CHECK ("account_status" IN ('ACTIVE', 'FROZEN', 'CANCELLED'));
--> statement-breakpoint
INSERT INTO "zzsh_iam"."admin_permission" ("code", "name", "description") VALUES
  ('user.account.freeze', '冻结用户账号', '管理员将 ACTIVE 用户冻结为 FROZEN：suspended=true，撤销全部会话与待用验证凭据；需二次验证与原因；不可作用于 CANCELLED'),
  ('user.account.unfreeze', '解冻用户账号', '管理员将 FROZEN 用户恢复为 ACTIVE：suspended=false；旧会话不复活；需二次验证与原因')
ON CONFLICT ("code") DO NOTHING;
--> statement-breakpoint
DELETE FROM "zzsh_iam"."admin_role_permission" WHERE "permission_code" = 'user.account.restore';
--> statement-breakpoint
DELETE FROM "zzsh_iam"."admin_user_permission" WHERE "permission_code" = 'user.account.restore';
--> statement-breakpoint
UPDATE "zzsh_iam"."admin_permission"
   SET "name" = '恢复停用用户账号（已退役）',
       "description" = '已退役（0103）：自助停用已移除，改用 user.account.freeze / user.account.unfreeze；保留本行仅为历史审计与审批引用'
 WHERE "code" = 'user.account.restore';
