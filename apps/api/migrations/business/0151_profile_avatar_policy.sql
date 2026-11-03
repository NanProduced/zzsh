-- 头像上传审核策略：默认须人工审核，只影响随后完成提交的新自定义头像。
-- 全局单例，默认继续人工审核；不批准已有待审素材，不自动授予任何角色权限。
CREATE TABLE zzsh_supply.profile_avatar_policy (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  requires_review boolean NOT NULL DEFAULT true,
  revision bigint NOT NULL DEFAULT 1 CHECK (revision>0),
  updated_by_admin_id text REFERENCES zzsh_auth_admin."user"(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
INSERT INTO zzsh_supply.profile_avatar_policy(singleton,requires_review,revision) VALUES(true,true,1);
COMMENT ON TABLE zzsh_supply.profile_avatar_policy IS '用户与管理员共用的自定义头像上传审核策略；只影响随后完成提交的新素材';
COMMENT ON COLUMN zzsh_supply.profile_avatar_policy.requires_review IS 'true须人工审核；false仅新完成提交的合格头像按系统政策直接生效';
COMMENT ON COLUMN zzsh_supply.profile_avatar_policy.revision IS '并发修改CAS版本；每次实际变更严格加一';

CREATE FUNCTION zzsh_supply.guard_profile_avatar_policy() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'avatar policy singleton cannot be deleted' USING ERRCODE='23514'; END IF;
  IF NEW.singleton IS DISTINCT FROM OLD.singleton OR NEW.revision<>OLD.revision+1 THEN
    RAISE EXCEPTION 'avatar policy revision must advance by one' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER profile_avatar_policy_guard BEFORE UPDATE OR DELETE ON zzsh_supply.profile_avatar_policy
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_profile_avatar_policy();

ALTER TABLE zzsh_supply.media_asset ADD COLUMN avatar_policy_revision bigint;
COMMENT ON COLUMN zzsh_supply.media_asset.avatar_policy_revision IS '首次系统免人工审核批准使用的头像政策版本；人审字段不冒充系统审核，后续人工处置仍保留来源';
ALTER TABLE zzsh_supply.media_asset ADD CONSTRAINT avatar_policy_source_shape CHECK (
  avatar_policy_revision IS NULL OR (avatar_policy_revision>0 AND purpose='AVATAR' AND ownership_kind IN('USER_AVATAR','ADMIN_AVATAR'))
);
ALTER TABLE zzsh_supply.media_asset DROP CONSTRAINT media_asset_review_shape;
ALTER TABLE zzsh_supply.media_asset ADD CONSTRAINT media_asset_review_shape CHECK (
  (review_state='PENDING' AND reviewed_by_admin_id IS NULL AND reviewed_at IS NULL AND avatar_policy_revision IS NULL)
  OR (review_state<>'PENDING' AND reviewed_by_admin_id IS NOT NULL AND reviewed_at IS NOT NULL)
  OR (purpose='AVATAR' AND ownership_kind IN('USER_AVATAR','ADMIN_AVATAR') AND review_state='APPROVED'
      AND reviewed_by_admin_id IS NULL AND reviewed_at IS NOT NULL AND avatar_policy_revision IS NOT NULL AND avatar_policy_revision>0)
);

CREATE FUNCTION zzsh_supply.guard_avatar_policy_asset() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.avatar_policy_revision IS NOT NULL THEN RAISE EXCEPTION 'policy approval requires a finalized pending avatar' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.avatar_policy_revision IS NOT NULL AND NEW.avatar_policy_revision IS DISTINCT FROM OLD.avatar_policy_revision THEN
    RAISE EXCEPTION 'avatar original policy approval source is immutable' USING ERRCODE='23514';
  END IF;
  IF OLD.avatar_policy_revision IS NULL AND NEW.avatar_policy_revision IS NOT NULL THEN
    IF OLD.purpose<>'AVATAR' OR OLD.review_state<>'PENDING' OR NEW.review_state<>'APPROVED'
       OR NEW.reviewed_by_admin_id IS NOT NULL OR NEW.technical_state<>'READY' OR NEW.public_storage_key IS NULL
       OR NEW.access_class<>'PUBLIC_DISPLAY'
       OR NOT EXISTS (SELECT 1 FROM zzsh_supply.profile_avatar_policy p WHERE p.singleton=true AND NOT p.requires_review AND p.revision=NEW.avatar_policy_revision)
       OR NOT EXISTS (SELECT 1 FROM zzsh_supply.profile_avatar p WHERE p.pending_asset_id=NEW.id AND p.latest_upload_intent_id IS NULL
          AND ((NEW.ownership_kind='USER_AVATAR' AND p.realm='user' AND p.subject_id=NEW.owner_user_id)
            OR (NEW.ownership_kind='ADMIN_AVATAR' AND p.realm='admin' AND p.subject_id=NEW.uploaded_by_admin_id)))
    THEN RAISE EXCEPTION 'avatar policy approval binding is not proved' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER avatar_policy_asset_guard BEFORE INSERT OR UPDATE ON zzsh_supply.media_asset
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_avatar_policy_asset();

INSERT INTO zzsh_iam.admin_permission(code,name,description) VALUES
  ('profile.avatar.policy.manage','管理头像审核策略','控制随后提交的用户及管理员自定义头像是否须人工审核；不自动授予素材审核权限')
ON CONFLICT(code) DO NOTHING;
REVOKE ALL ON zzsh_supply.profile_avatar_policy FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_supply.guard_profile_avatar_policy() FROM PUBLIC;
REVOKE ALL ON FUNCTION zzsh_supply.guard_avatar_policy_asset() FROM PUBLIC;
-- 运行时表/列权限由Root按正式ACL安装；这里不硬编码本机角色或改变现行开关值。
