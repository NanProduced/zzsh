-- 0182_complaint_handover_role_status: 0181 已按对象保护升级前已分配的投诉，但判断“其他角色是否带投诉权限”
-- 时没有核对角色 status，导致仅有停用投诉角色的客服丢失既有投诉。这里按有效权限口径补发对象授权。
-- 仍然只写对象级 grant，不写个人全局 allow；个人 DENY 优先；不改写已执行的 0181。
-- 升级边界：0181/0182 必须在同一 pending 迁移批次内执行（业务迁移预检会拒绝两者分批），并在停写窗口运行；
-- 若 0181 已单独提交，必须先冻结投诉写入并对账，不能直接补跑本迁移扩大交接范围。
INSERT INTO "zzsh_iam"."im_complaint_handover_grant" ("consultation_id", "admin_user_id")
SELECT c."id", c."assigned_admin_id"
  FROM "zzsh_iam"."im_consultation" c
  JOIN "zzsh_iam"."admin_user_role" ur
    ON ur."admin_user_id" = c."assigned_admin_id" AND ur."role_id" = 'role_preset_support'
  JOIN "zzsh_iam"."admin_role" support_role
    ON support_role."id" = ur."role_id" AND support_role."status" = 'ACTIVE'
 WHERE c."kind" = 'COMPLAINT'
   AND c."state" IN ('WAITING', 'ACTIVE')
   AND c."assigned_admin_id" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "zzsh_iam"."admin_user_permission" deny
      WHERE deny."admin_user_id" = c."assigned_admin_id"
        AND deny."permission_code" = 'im.support.complaint' AND deny."effect" = 'DENY')
   AND NOT EXISTS (
     SELECT 1 FROM "zzsh_iam"."admin_user_role" other_role
       JOIN "zzsh_iam"."admin_role" other ON other."id" = other_role."role_id" AND other."status" = 'ACTIVE'
       JOIN "zzsh_iam"."admin_role_permission" rp ON rp."role_id" = other_role."role_id"
      WHERE other_role."admin_user_id" = c."assigned_admin_id"
        AND other_role."role_id" <> 'role_preset_support'
        AND rp."permission_code" = 'im.support.complaint')
   AND NOT EXISTS (
     SELECT 1 FROM "zzsh_iam"."admin_user_permission" allow_grant
      WHERE allow_grant."admin_user_id" = c."assigned_admin_id"
        AND allow_grant."permission_code" = 'im.support.complaint' AND allow_grant."effect" = 'ALLOW')
ON CONFLICT ("consultation_id") DO NOTHING;
