-- 0181_complaint_handover_grant: 投诉权限从客服预设移出后，只保护升级前已分配的具体会话。
-- 不写个人全局 im.support.complaint=ALLOW；授权键为 consultation_id + admin_user_id，
-- 因此不会让原客服看到未分配投诉或进入新投诉派单。
CREATE TABLE IF NOT EXISTS "zzsh_iam"."im_complaint_handover_grant" (
  "consultation_id" text PRIMARY KEY REFERENCES "zzsh_iam"."im_consultation"("id") ON DELETE CASCADE,
  "admin_user_id" text NOT NULL REFERENCES "zzsh_auth_admin"."user"("id"),
  "reason" text NOT NULL DEFAULT 'PRESET_REMOVED_ACTIVE_HANDOVER',
  "created_at" timestamptz NOT NULL DEFAULT clock_timestamp()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "im_complaint_handover_grant_admin_idx"
  ON "zzsh_iam"."im_complaint_handover_grant" ("admin_user_id", "consultation_id");
--> statement-breakpoint
INSERT INTO "zzsh_iam"."im_complaint_handover_grant" ("consultation_id", "admin_user_id")
SELECT c."id", c."assigned_admin_id"
  FROM "zzsh_iam"."im_consultation" c
  JOIN "zzsh_iam"."admin_user_role" ur
    ON ur."admin_user_id" = c."assigned_admin_id" AND ur."role_id" = 'role_preset_support'
 WHERE c."kind" = 'COMPLAINT'
   AND c."state" IN ('WAITING', 'ACTIVE')
   AND c."assigned_admin_id" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "zzsh_iam"."admin_user_permission" deny
      WHERE deny."admin_user_id" = c."assigned_admin_id"
        AND deny."permission_code" = 'im.support.complaint' AND deny."effect" = 'DENY')
   AND NOT EXISTS (
     SELECT 1 FROM "zzsh_iam"."admin_user_role" other_role
       JOIN "zzsh_iam"."admin_role_permission" rp ON rp."role_id" = other_role."role_id"
      WHERE other_role."admin_user_id" = c."assigned_admin_id"
        AND other_role."role_id" <> 'role_preset_support'
        AND rp."permission_code" = 'im.support.complaint')
   AND NOT EXISTS (
     SELECT 1 FROM "zzsh_iam"."admin_user_permission" allow_grant
      WHERE allow_grant."admin_user_id" = c."assigned_admin_id"
        AND allow_grant."permission_code" = 'im.support.complaint' AND allow_grant."effect" = 'ALLOW')
ON CONFLICT ("consultation_id") DO NOTHING;
--> statement-breakpoint
REVOKE ALL ON TABLE "zzsh_iam"."im_complaint_handover_grant" FROM PUBLIC;
--> statement-breakpoint
COMMENT ON TABLE "zzsh_iam"."im_complaint_handover_grant" IS '投诉权限预设调整时对升级前已分配投诉的对象级交接授权；不授予全局投诉权限';
COMMENT ON COLUMN "zzsh_iam"."im_complaint_handover_grant"."consultation_id" IS '被保护的具体投诉轮次；只对该对象生效';
COMMENT ON COLUMN "zzsh_iam"."im_complaint_handover_grant"."admin_user_id" IS '升级前仍负责该投诉的客服';
COMMENT ON COLUMN "zzsh_iam"."im_complaint_handover_grant"."reason" IS '对象级交接授权原因；当前仅用于预设移除后的平滑交接';
COMMENT ON COLUMN "zzsh_iam"."im_complaint_handover_grant"."created_at" IS '对象级交接授权创建时间';
