-- ADM-USER-LIST-REPAIR-01：用户列表的读取索引、内部高危标识与两项窄权限。
-- 索引部分：目录 ORIGINAL 读取每次都要按 object_id 取“最新一条成功迁入审计”，
-- 此前 zzsh_iam.audit_event 上没有覆盖该读取的部分索引，155181 用户规模下退化为
-- 66 万行顺序扫描加外部归并排序；本索引只覆盖目录实际读取的迁入行，等价不改语义。
CREATE INDEX IF NOT EXISTS zzsh_iam_audit_event_user_migration_latest_idx
  ON "zzsh_iam"."audit_event" ("object_id", "occurred_at" DESC, "id" DESC)
  WHERE "action" = 'user.legacy_owner.migrated' AND "object_type" = 'user' AND "outcome" = 'SUCCESS';
--> statement-breakpoint
-- 内部高危标识：一个固定布尔事实，绑定稳定用户 ID。
-- 不联动账号状态、信用、上架或订单资格；操作者与时间只留在此行与审计事件里。
CREATE TABLE IF NOT EXISTS "zzsh_iam"."user_risk_flag" (
  "user_id" text PRIMARY KEY REFERENCES "zzsh_auth_user"."user"("id") ON DELETE CASCADE,
  "flagged" boolean NOT NULL DEFAULT false,
  "revision" integer NOT NULL DEFAULT 1,
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "updated_by" text NOT NULL
);
--> statement-breakpoint
INSERT INTO "zzsh_iam"."admin_permission" ("code", "name", "description") VALUES
  ('user.wallet.read', '查看用户可用余额', '只读查看受权用户的钱包可用余额；不含提现预留、待结算收益、应退与押金保证金，不授予平台财务或资金命令'),
  ('user.risk.manage', '维护用户内部高危标识', '标记或取消用户的内部高危标识；客服只读，不联动账号状态、信用、上架或订单资格')
ON CONFLICT ("code") DO NOTHING;
