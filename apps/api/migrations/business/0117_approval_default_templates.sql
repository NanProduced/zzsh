-- 审批默认模板 + 管理员身份创建审计对象类型纠正（Owner 2026-10-31）。
-- 1) 日常审批（会员礼遇发放/替换/撤销、订单结算人工调整）默认审批人 = 迁移时持有「运营」预设角色
--    (role_preset_ops) 的在用管理员；重要全站策略（分销政策、会员权益政策）默认审批人 = Boss。
--    不写死管理员 id；模板已存在（Boss 已配置过）则完全跳过，不覆盖 Boss 的配置。可重复执行。
-- 2) better-auth 触发器写入的管理员创建事件改用 admin_user 对象类型（历史 auth_user 行由查询侧兼容）。
INSERT INTO zzsh_iam.approval_template (id, operation_code, trigger_condition, version)
SELECT v.id, v.op, v.trig, 1
  FROM (VALUES
    ('approval_tpl_default_ent_grant',   'membership.entitlement.grant',      'membership.entitlement.grant.requested'),
    ('approval_tpl_default_ent_replace', 'membership.entitlement.replace',    'membership.entitlement.replace.requested'),
    ('approval_tpl_default_ent_revoke',  'membership.entitlement.revoke',     'membership.entitlement.revoke.requested'),
    ('approval_tpl_default_settle_adj',  'order.settlement.adjust',           'manual-net'),
    ('approval_tpl_default_dist_policy', 'distribution.policy.publish',       'distribution.policy.publish.requested'),
    ('approval_tpl_default_mem_policy',  'membership.benefit.policy.publish', 'membership.policy.publish.requested')
  ) AS v(id, op, trig)
 WHERE NOT EXISTS (
   SELECT 1 FROM zzsh_iam.approval_template t WHERE t.operation_code = v.op AND t.trigger_condition = v.trig
 );

-- 日常类：运营角色持有人（在用、非 Boss）。
INSERT INTO zzsh_iam.approval_template_candidate (template_id, admin_user_id)
SELECT t.id, ur.admin_user_id
  FROM zzsh_iam.approval_template t
  JOIN zzsh_iam.admin_user_role ur ON ur.role_id = 'role_preset_ops'
  JOIN zzsh_iam.admin_security s ON s.admin_user_id = ur.admin_user_id AND s.status = 'ACTIVE' AND NOT s.is_boss
 WHERE t.id IN ('approval_tpl_default_ent_grant', 'approval_tpl_default_ent_replace', 'approval_tpl_default_ent_revoke', 'approval_tpl_default_settle_adj')
ON CONFLICT DO NOTHING;

-- 策略类：Boss（服务端另有写死的 Boss 校验）。
INSERT INTO zzsh_iam.approval_template_candidate (template_id, admin_user_id)
SELECT t.id, s.admin_user_id
  FROM zzsh_iam.approval_template t
  JOIN zzsh_iam.admin_security s ON s.is_boss AND s.status = 'ACTIVE'
 WHERE t.id IN ('approval_tpl_default_dist_policy', 'approval_tpl_default_mem_policy')
ON CONFLICT DO NOTHING;

CREATE OR REPLACE FUNCTION "zzsh_iam"."record_auth_user_created"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO "zzsh_iam"."audit_event" (
    "id", "actor_type", "actor_id", "action", "object_type", "object_id",
    "outcome", "occurred_at", "details"
  ) VALUES (
    'audit_' || replace(gen_random_uuid()::text, '-', ''),
    CASE WHEN TG_TABLE_SCHEMA = 'zzsh_auth_admin' THEN 'admin' ELSE 'user' END,
    NEW."id",
    CASE WHEN TG_TABLE_SCHEMA = 'zzsh_auth_admin' THEN 'admin.account.created' ELSE 'user.account.created' END,
    CASE WHEN TG_TABLE_SCHEMA = 'zzsh_auth_admin' THEN 'admin_user' ELSE 'auth_user' END,
    NEW."id",
    'SUCCESS',
    clock_timestamp(),
    jsonb_build_object('source', 'better-auth')
  );
  RETURN NEW;
END;
$$;
