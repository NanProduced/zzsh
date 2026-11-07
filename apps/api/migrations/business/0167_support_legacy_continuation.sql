-- Customer support handles migrated in-flight orders under the existing game scope and audit rules.
DO $support_legacy$
BEGIN
  IF NOT EXISTS(SELECT 1 FROM zzsh_iam.admin_role WHERE id='role_preset_support')
    OR NOT EXISTS(SELECT 1 FROM zzsh_iam.admin_permission WHERE code='order.legacy.continue') THEN
    RAISE EXCEPTION 'support preset or legacy continuation permission is unavailable';
  END IF;
END $support_legacy$;
INSERT INTO zzsh_iam.admin_role_permission(role_id,permission_code)
VALUES ('role_preset_support','order.legacy.continue')
ON CONFLICT (role_id, permission_code) DO NOTHING;
