ALTER TABLE zzsh_supply.account_image_cdn_queue ADD COLUMN legacy_candidate boolean NOT NULL DEFAULT false;

CREATE TABLE zzsh_supply.legacy_image_cdn_delivery (
  id text PRIMARY KEY CHECK (id ~ '^cdn_[a-f0-9]{32}$'),
  account_id text NOT NULL REFERENCES zzsh_supply.rental_account(id),
  version_id text NOT NULL,
  position integer NOT NULL CHECK (position BETWEEN 0 AND 999999),
  source_path text NOT NULL CHECK (source_path ~ '^accountsImage/[0-9]{8}/[A-Za-z0-9][A-Za-z0-9._-]{0,195}$'),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 10485760),
  mime text NOT NULL CHECK (mime IN ('image/jpeg','image/png','image/webp')),
  state text NOT NULL CHECK (state IN ('PENDING_IMPORT','UNAVAILABLE','PUBLISHING','READY','REVOKING','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  purge_task_id text,
  FOREIGN KEY (version_id,account_id) REFERENCES zzsh_supply.listing_version(id,account_id),
  CHECK ((state <> 'READY' OR published_at IS NOT NULL) AND (state <> 'REVOKED' OR published_at IS NULL OR purge_task_id IS NOT NULL))
);
CREATE UNIQUE INDEX legacy_image_cdn_active_slot ON zzsh_supply.legacy_image_cdn_delivery(account_id, version_id, position) WHERE state<>'REVOKED';
CREATE INDEX legacy_image_cdn_active_path ON zzsh_supply.legacy_image_cdn_delivery(source_path) WHERE state IN ('PUBLISHING','READY');
CREATE INDEX legacy_account_media_display_paths_idx ON zzsh_supply.legacy_account_media_paths USING gin (display_paths);

INSERT INTO zzsh_supply.account_image_cdn_queue(account_id,legacy_candidate)
SELECT account_id,true FROM zzsh_supply.legacy_account_media_paths WHERE cardinality(display_paths)>0
ON CONFLICT(account_id) DO UPDATE SET legacy_candidate=true;

CREATE FUNCTION zzsh_supply.schedule_legacy_image_cdn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, zzsh_supply AS $$
BEGIN
  IF cardinality(NEW.display_paths)>0 THEN
    INSERT INTO zzsh_supply.account_image_cdn_queue(account_id,legacy_candidate) VALUES(NEW.account_id,true)
    ON CONFLICT(account_id) DO UPDATE SET legacy_candidate=true, due_at=clock_timestamp(), request_revision=account_image_cdn_queue.request_revision+1;
  END IF;
  IF cardinality(NEW.penalty_paths)>0 THEN
    UPDATE zzsh_supply.account_image_cdn_queue q SET due_at=clock_timestamp(),request_revision=q.request_revision+1
      FROM zzsh_supply.legacy_account_media_paths p WHERE p.account_id=q.account_id AND p.display_paths && NEW.penalty_paths;
    UPDATE zzsh_supply.legacy_image_cdn_delivery SET state='REVOKING'
      WHERE source_path=ANY(NEW.penalty_paths) AND state IN ('PUBLISHING','READY');
  END IF;
  RETURN NEW;
END $$;
COMMENT ON COLUMN zzsh_supply.account_image_cdn_queue.legacy_candidate IS '账号是否包含需要核对的历史图片来源';
COMMENT ON TABLE zzsh_supply.legacy_image_cdn_delivery IS '旧平台账号图片的来源核验与 CDN 投放记录';
COMMENT ON COLUMN zzsh_supply.legacy_image_cdn_delivery.id IS '单次历史图片投放标识';
COMMENT ON COLUMN zzsh_supply.legacy_image_cdn_delivery.account_id IS '关联的迁入账号';
COMMENT ON COLUMN zzsh_supply.legacy_image_cdn_delivery.version_id IS '关联的历史资料快照';
COMMENT ON COLUMN zzsh_supply.legacy_image_cdn_delivery.position IS '历史展示图片顺序';
COMMENT ON COLUMN zzsh_supply.legacy_image_cdn_delivery.source_path IS '旧平台图片来源路径';
COMMENT ON COLUMN zzsh_supply.legacy_image_cdn_delivery.sha256 IS '经核准的来源图片 SHA-256';
COMMENT ON COLUMN zzsh_supply.legacy_image_cdn_delivery.byte_size IS '经核准的来源图片字节数';
COMMENT ON COLUMN zzsh_supply.legacy_image_cdn_delivery.mime IS '经核准的来源图片 MIME 类型';
COMMENT ON COLUMN zzsh_supply.legacy_image_cdn_delivery.state IS '来源导入、投放或撤回状态';
COMMENT ON COLUMN zzsh_supply.legacy_image_cdn_delivery.created_at IS '投放记录创建时间';
COMMENT ON COLUMN zzsh_supply.legacy_image_cdn_delivery.published_at IS '源站图片校验完成并允许投放的时间';
COMMENT ON COLUMN zzsh_supply.legacy_image_cdn_delivery.purge_task_id IS 'CDN 接受的缓存刷新任务编号，不代表刷新完成';
REVOKE ALL ON FUNCTION zzsh_supply.schedule_legacy_image_cdn() FROM PUBLIC;
CREATE TRIGGER legacy_image_cdn_source_insert AFTER INSERT ON zzsh_supply.legacy_account_media_paths
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.schedule_legacy_image_cdn();

-- Extend the existing triggers after the legacy table exists. Workers lock the
-- queue revision before a delivery row, so each trigger wakes the queue first.
CREATE OR REPLACE FUNCTION zzsh_supply.schedule_account_image_cdn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, zzsh_supply AS $$
DECLARE affected_account text;
BEGIN
  affected_account := NEW.account_id;
  IF TG_TABLE_NAME = 'media_asset' THEN
    IF NEW.purpose <> 'ACCOUNT_DISPLAY' OR affected_account IS NULL THEN RETURN NEW; END IF;
    IF NOT EXISTS (SELECT 1 FROM zzsh_supply.account_image_cdn_queue WHERE account_id=affected_account) THEN RETURN NEW; END IF;
  END IF;
  INSERT INTO zzsh_supply.account_image_cdn_queue(account_id) VALUES(affected_account)
    ON CONFLICT(account_id) DO UPDATE SET due_at=clock_timestamp(), request_revision=account_image_cdn_queue.request_revision+1;
  IF TG_TABLE_NAME = 'listing_publication' THEN
    UPDATE zzsh_supply.account_image_cdn_delivery d SET state='REVOKING'
      WHERE d.account_id=affected_account AND d.state IN ('PUBLISHING','READY')
        AND NOT EXISTS (SELECT 1 FROM zzsh_supply.listing_media m WHERE m.version_id=NEW.version_id AND m.asset_id=d.asset_id);
    UPDATE zzsh_supply.legacy_image_cdn_delivery SET state='REVOKING'
      WHERE account_id=affected_account AND version_id<>NEW.version_id AND state IN ('PUBLISHING','READY');
  ELSIF TG_TABLE_NAME = 'media_asset' THEN
    IF NEW.review_state NOT IN ('PENDING','APPROVED') OR NEW.access_class <> 'PUBLIC_DISPLAY' OR NEW.technical_state <> 'READY'
      OR OLD.review_state NOT IN ('PENDING','APPROVED') OR OLD.access_class <> 'PUBLIC_DISPLAY' OR OLD.technical_state <> 'READY' THEN
      UPDATE zzsh_supply.account_image_cdn_delivery SET state='REVOKING'
        WHERE account_id=affected_account AND asset_id=NEW.id AND state IN ('PUBLISHING','READY');
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_supply.restrict_account_image_cdn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, zzsh_supply AS $$
DECLARE affected_game text;
BEGIN
  IF TG_TABLE_NAME='rental_account' THEN
    UPDATE zzsh_supply.account_image_cdn_queue SET due_at=clock_timestamp(), request_revision=request_revision+1 WHERE account_id=NEW.id;
    UPDATE zzsh_supply.account_image_cdn_delivery SET state='REVOKING'
      WHERE account_id=NEW.id AND state IN ('PUBLISHING','READY');
    UPDATE zzsh_supply.legacy_image_cdn_delivery SET state='REVOKING' WHERE account_id=NEW.id AND state IN ('PUBLISHING','READY');
  ELSE
    IF TG_TABLE_NAME='game' THEN affected_game := NEW.id;
    ELSE
      IF NEW.service_code <> 'ACCOUNT_RENTAL' THEN RETURN NEW; END IF;
      affected_game := NEW.game_id;
    END IF;
    UPDATE zzsh_supply.account_image_cdn_queue q SET due_at=clock_timestamp(), request_revision=q.request_revision+1 FROM zzsh_supply.rental_account a
      WHERE a.id=q.account_id AND a.game_id=affected_game;
    UPDATE zzsh_supply.account_image_cdn_delivery d SET state='REVOKING' FROM zzsh_supply.rental_account a
      WHERE a.id=d.account_id AND a.game_id=affected_game AND d.state IN ('PUBLISHING','READY');
    UPDATE zzsh_supply.legacy_image_cdn_delivery d SET state='REVOKING' FROM zzsh_supply.rental_account a
      WHERE a.id=d.account_id AND a.game_id=affected_game AND d.state IN ('PUBLISHING','READY');
  END IF;
  RETURN NEW;
END $$;
