CREATE TABLE zzsh_supply.account_image_cdn_queue (
  account_id text PRIMARY KEY REFERENCES zzsh_supply.rental_account(id),
  request_revision bigint NOT NULL DEFAULT 1 CHECK (request_revision > 0),
  due_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX account_image_cdn_queue_due ON zzsh_supply.account_image_cdn_queue(due_at, account_id);

CREATE TABLE zzsh_supply.account_image_cdn_delivery (
  id text PRIMARY KEY CHECK (id ~ '^cdn_[a-f0-9]{32}$'),
  account_id text NOT NULL REFERENCES zzsh_supply.rental_account(id),
  asset_id text NOT NULL REFERENCES zzsh_supply.media_asset(id),
  state text NOT NULL DEFAULT 'PUBLISHING' CHECK (state IN ('PUBLISHING', 'READY', 'REVOKING', 'REVOKED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz,
  purge_task_id text,
  CHECK ((state <> 'READY' OR published_at IS NOT NULL) AND (state <> 'REVOKED' OR purge_task_id IS NOT NULL))
);
CREATE UNIQUE INDEX account_image_cdn_delivery_active ON zzsh_supply.account_image_cdn_delivery(account_id, asset_id) WHERE state <> 'REVOKED';

INSERT INTO zzsh_supply.account_image_cdn_queue(account_id)
SELECT DISTINCT p.account_id FROM zzsh_supply.listing_publication p
WHERE EXISTS (SELECT 1 FROM zzsh_supply.listing_media lm WHERE lm.version_id = p.version_id);

CREATE FUNCTION zzsh_supply.schedule_account_image_cdn() RETURNS trigger LANGUAGE plpgsql AS $$
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
  ELSIF TG_TABLE_NAME = 'media_asset' THEN
    IF NEW.review_state NOT IN ('PENDING','APPROVED') OR NEW.access_class <> 'PUBLIC_DISPLAY' OR NEW.technical_state <> 'READY'
      OR OLD.review_state NOT IN ('PENDING','APPROVED') OR OLD.access_class <> 'PUBLIC_DISPLAY' OR OLD.technical_state <> 'READY' THEN
      UPDATE zzsh_supply.account_image_cdn_delivery SET state='REVOKING'
        WHERE account_id=affected_account AND asset_id=NEW.id AND state IN ('PUBLISHING','READY');
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listing_publication_cdn AFTER INSERT ON zzsh_supply.listing_publication
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.schedule_account_image_cdn();
CREATE TRIGGER media_asset_cdn AFTER UPDATE OF review_state, access_class, technical_state ON zzsh_supply.media_asset
FOR EACH ROW WHEN (OLD.review_state IS DISTINCT FROM NEW.review_state OR OLD.access_class IS DISTINCT FROM NEW.access_class OR OLD.technical_state IS DISTINCT FROM NEW.technical_state)
EXECUTE FUNCTION zzsh_supply.schedule_account_image_cdn();

CREATE FUNCTION zzsh_supply.restrict_account_image_cdn() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE affected_game text;
BEGIN
  IF TG_TABLE_NAME='rental_account' THEN
    UPDATE zzsh_supply.account_image_cdn_queue SET due_at=clock_timestamp(), request_revision=request_revision+1 WHERE account_id=NEW.id;
    UPDATE zzsh_supply.account_image_cdn_delivery SET state='REVOKING'
      WHERE account_id=NEW.id AND state IN ('PUBLISHING','READY');
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
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_account_cdn AFTER UPDATE OF staff_restricted, lifecycle, owner_user_id, legacy_hold ON zzsh_supply.rental_account
FOR EACH ROW WHEN (OLD.staff_restricted IS DISTINCT FROM NEW.staff_restricted OR OLD.lifecycle IS DISTINCT FROM NEW.lifecycle OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id OR OLD.legacy_hold IS DISTINCT FROM NEW.legacy_hold)
EXECUTE FUNCTION zzsh_supply.restrict_account_image_cdn();
CREATE TRIGGER game_cdn AFTER UPDATE OF enabled ON zzsh_supply.game
FOR EACH ROW WHEN (OLD.enabled IS DISTINCT FROM NEW.enabled) EXECUTE FUNCTION zzsh_supply.restrict_account_image_cdn();
CREATE TRIGGER game_service_cdn AFTER UPDATE OF enabled ON zzsh_supply.game_service_operation
FOR EACH ROW WHEN (OLD.enabled IS DISTINCT FROM NEW.enabled) EXECUTE FUNCTION zzsh_supply.restrict_account_image_cdn();
COMMENT ON TABLE zzsh_supply.account_image_cdn_queue IS '账号公开图片投放与撤回的同步队列';
COMMENT ON COLUMN zzsh_supply.account_image_cdn_queue.account_id IS '关联的出租账号';
COMMENT ON COLUMN zzsh_supply.account_image_cdn_queue.request_revision IS '队列请求修订号，用于识别处理期间的变更';
COMMENT ON COLUMN zzsh_supply.account_image_cdn_queue.due_at IS '下次处理时间';
COMMENT ON TABLE zzsh_supply.account_image_cdn_delivery IS '新平台账号图片的单次 CDN 投放记录';
COMMENT ON COLUMN zzsh_supply.account_image_cdn_delivery.id IS '单次投放标识';
COMMENT ON COLUMN zzsh_supply.account_image_cdn_delivery.account_id IS '关联的出租账号';
COMMENT ON COLUMN zzsh_supply.account_image_cdn_delivery.asset_id IS '投放的账号图片素材';
COMMENT ON COLUMN zzsh_supply.account_image_cdn_delivery.state IS '投放或撤回处理状态';
COMMENT ON COLUMN zzsh_supply.account_image_cdn_delivery.created_at IS '投放记录创建时间';
COMMENT ON COLUMN zzsh_supply.account_image_cdn_delivery.published_at IS '源站图片校验完成并允许投放的时间';
COMMENT ON COLUMN zzsh_supply.account_image_cdn_delivery.purge_task_id IS 'CDN 接受的缓存刷新任务编号，不代表刷新完成';
