-- 审计降噪 + Boss 手动日志保留清理（Owner 2026-10-31，t366u）。未经批准不得应用。
-- 1) 触发器降噪：只改「时间戳/计数类」字段的 UPDATE 不再写审计行：
--    admin_security 仅 updated_at / last_full_authenticated_at 变化；
--    session 仅 updatedAt / expiresAt / last_active_at 变化（续期、最近活跃）；
--    twoFactor 仅 failedVerificationCount 归零（验证成功后的计数复位）。
--    INSERT / DELETE 及状态、Boss、2FA、PIN、锁定等字段变化照常记录。
CREATE OR REPLACE FUNCTION "zzsh_iam"."record_security_change"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  changed_id text;
  action_name text;
  noise_keys text[];
BEGIN
  IF TG_OP = 'UPDATE' THEN
    noise_keys := CASE
      WHEN TG_TABLE_NAME = 'admin_security' THEN ARRAY['updated_at', 'last_full_authenticated_at']
      WHEN TG_TABLE_NAME = 'session' THEN ARRAY['updatedAt', 'expiresAt', 'last_active_at']
      WHEN TG_TABLE_NAME = 'twoFactor' AND (to_jsonb(NEW) ->> 'failedVerificationCount') = '0' THEN ARRAY['failedVerificationCount']
      ELSE ARRAY[]::text[]
    END;
    IF (to_jsonb(NEW) - noise_keys) = (to_jsonb(OLD) - noise_keys) THEN
      RETURN NEW;
    END IF;
  END IF;
  IF TG_TABLE_NAME = 'admin_security' THEN
    changed_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."admin_user_id" ELSE NEW."admin_user_id" END;
    action_name := 'admin.security.' || lower(TG_OP);
  ELSE
    changed_id := CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END;
    action_name := 'auth.' || lower(TG_TABLE_SCHEMA) || '.' || lower(TG_TABLE_NAME) || '.' || lower(TG_OP);
  END IF;
  INSERT INTO "zzsh_iam"."audit_event" (
    "id", "actor_type", "actor_id", "session_id", "action", "object_type", "object_id",
    "outcome", "request_id", "occurred_at", "details"
  ) VALUES (
    'audit_' || replace(gen_random_uuid()::text, '-', ''),
    COALESCE(NULLIF(current_setting('zzsh.actor_type', true), ''), 'system'),
    NULLIF(current_setting('zzsh.actor_id', true), ''),
    NULLIF(current_setting('zzsh.session_id', true), ''),
    action_name,
    TG_TABLE_SCHEMA || '.' || TG_TABLE_NAME,
    changed_id,
    'SUCCESS',
    NULLIF(current_setting('zzsh.request_id', true), ''),
    clock_timestamp(),
    jsonb_build_object('operation', TG_OP, 'source', 'database-trigger')
  );
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$;

-- 2) 清理记录本身永不可删（任何角色、任何路径）。
CREATE OR REPLACE FUNCTION "zzsh_iam"."guard_audit_purge_record"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."action" = 'admin.audit.purged' THEN
    RAISE EXCEPTION 'audit purge records are permanent' USING ERRCODE = '42501';
  END IF;
  RETURN OLD;
END;
$$;
DROP TRIGGER IF EXISTS "audit_purge_record_guard" ON "zzsh_iam"."audit_event";
CREATE TRIGGER "audit_purge_record_guard"
BEFORE DELETE ON "zzsh_iam"."audit_event"
FOR EACH ROW EXECUTE FUNCTION "zzsh_iam"."guard_audit_purge_record"();

-- 3) Boss 手动清理 N 天前（90 ≤ N ≤ 3650）的账号/安全类审计：仅 action 前缀 admin.* / auth.*。
--    订单、资金、提现、审批、用户、供给、会员、分销等业务审计一律不在清理范围（部分被业务约束引用）。
--    运行时角色无 audit_event DELETE 权限，只能经此 SECURITY DEFINER 函数；函数内复核 Boss，并写入清理记录。
CREATE OR REPLACE FUNCTION "zzsh_iam"."purge_admin_audit_events"(
  p_retention_days integer, p_actor_id text, p_session_id text, p_request_id text, p_dry_run boolean
)
RETURNS TABLE ("deleted" bigint, "cutoff" timestamptz)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $$
DECLARE
  v_cutoff timestamptz;
  v_count bigint;
BEGIN
  IF p_retention_days IS NULL OR p_retention_days < 90 OR p_retention_days > 3650 THEN
    RAISE EXCEPTION 'retention days out of range' USING ERRCODE = '22023';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM "zzsh_iam"."admin_security" s
     WHERE s."admin_user_id" = p_actor_id AND s."is_boss" AND s."status" = 'ACTIVE'
  ) THEN
    RAISE EXCEPTION 'boss required' USING ERRCODE = '42501';
  END IF;
  v_cutoff := clock_timestamp() - make_interval(days => p_retention_days);
  IF p_dry_run THEN
    SELECT count(*) INTO v_count FROM "zzsh_iam"."audit_event" e
     WHERE e."occurred_at" < v_cutoff
       AND split_part(e."action", '.', 1) IN ('admin', 'auth')
       AND e."action" <> 'admin.audit.purged';
    RETURN QUERY SELECT v_count, v_cutoff;
    RETURN;
  END IF;
  DELETE FROM "zzsh_iam"."audit_event" e
   WHERE e."occurred_at" < v_cutoff
     AND split_part(e."action", '.', 1) IN ('admin', 'auth')
     AND e."action" <> 'admin.audit.purged';
  GET DIAGNOSTICS v_count = ROW_COUNT;
  INSERT INTO "zzsh_iam"."audit_event" (
    "id", "actor_type", "actor_id", "session_id", "action", "object_type", "object_id",
    "outcome", "request_id", "occurred_at", "details"
  ) VALUES (
    'audit_' || replace(gen_random_uuid()::text, '-', ''),
    'admin', p_actor_id, p_session_id, 'admin.audit.purged', 'audit_event', NULL,
    'SUCCESS', p_request_id, clock_timestamp(),
    jsonb_build_object('retentionDays', p_retention_days, 'cutoff', v_cutoff, 'deletedCount', v_count, 'scope', 'admin,auth')
  );
  RETURN QUERY SELECT v_count, v_cutoff;
END;
$$;
REVOKE ALL ON FUNCTION "zzsh_iam"."purge_admin_audit_events"(integer, text, text, text, boolean) FROM PUBLIC;
