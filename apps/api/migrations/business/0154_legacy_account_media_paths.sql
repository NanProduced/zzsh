-- Candidate only: Root assigns the migration number and validates ACLs before installation.
CREATE TABLE zzsh_supply.legacy_account_media_paths (
  account_id text PRIMARY KEY REFERENCES zzsh_supply.rental_account(id),
  observation_version_id text NOT NULL,
  source_digest text NOT NULL CHECK (source_digest ~ '^[a-f0-9]{64}$'),
  display_paths text[] NOT NULL,
  penalty_paths text[] NOT NULL,
  created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (observation_version_id, account_id) REFERENCES zzsh_supply.listing_version(id, account_id),
  CHECK (array_position(display_paths, NULL) IS NULL AND array_position(penalty_paths, NULL) IS NULL)
);

COMMENT ON TABLE zzsh_supply.legacy_account_media_paths IS '旧账号展示图与私有处罚图的原始相对路径映射；不创建媒体资产或改变交易资格';
COMMENT ON COLUMN zzsh_supply.legacy_account_media_paths.account_id IS '已存在的新账号标识';
COMMENT ON COLUMN zzsh_supply.legacy_account_media_paths.observation_version_id IS '与旧来源映射一致的原观察版本';
COMMENT ON COLUMN zzsh_supply.legacy_account_media_paths.source_digest IS '旧账号整行来源摘要';
COMMENT ON COLUMN zzsh_supply.legacy_account_media_paths.display_paths IS '旧展示图片相对路径，保留首次顺序';
COMMENT ON COLUMN zzsh_supply.legacy_account_media_paths.penalty_paths IS '旧处罚截图相对路径，仅本人及授权管理员可读';
COMMENT ON COLUMN zzsh_supply.legacy_account_media_paths.created_by_admin_id IS '执行来源映射的管理员';
COMMENT ON COLUMN zzsh_supply.legacy_account_media_paths.created_at IS '来源映射记录时间';
REVOKE ALL ON TABLE zzsh_supply.legacy_account_media_paths FROM PUBLIC;

CREATE FUNCTION zzsh_supply.guard_legacy_account_media_paths() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM zzsh_supply.legacy_supply_map m
    WHERE m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts'
      AND m.account_id=NEW.account_id AND m.version_id=NEW.observation_version_id AND m.source_digest=NEW.source_digest) THEN
    RAISE EXCEPTION 'legacy media paths must bind the source observation';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER legacy_account_media_paths_insert BEFORE INSERT ON zzsh_supply.legacy_account_media_paths
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_legacy_account_media_paths();
CREATE TRIGGER legacy_account_media_paths_immutable BEFORE UPDATE OR DELETE ON zzsh_supply.legacy_account_media_paths
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();
CREATE INDEX legacy_account_media_penalty_paths_idx ON zzsh_supply.legacy_account_media_paths USING gin (penalty_paths);
-- Root assigns the registered migration role SELECT/INSERT and runtime role SELECT only.
