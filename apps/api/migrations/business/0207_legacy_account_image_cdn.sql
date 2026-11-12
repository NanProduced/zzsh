ALTER TABLE zzsh_supply.account_image_cdn_queue ADD COLUMN legacy_candidate boolean NOT NULL DEFAULT false;
ALTER FUNCTION zzsh_supply.schedule_account_image_cdn() SECURITY DEFINER SET search_path = pg_catalog, zzsh_supply;
ALTER FUNCTION zzsh_supply.restrict_account_image_cdn() SECURITY DEFINER SET search_path = pg_catalog, zzsh_supply;

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
REVOKE ALL ON FUNCTION zzsh_supply.schedule_legacy_image_cdn() FROM PUBLIC;
CREATE TRIGGER legacy_image_cdn_source_insert AFTER INSERT ON zzsh_supply.legacy_account_media_paths
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.schedule_legacy_image_cdn();

CREATE FUNCTION zzsh_supply.restrict_legacy_image_cdn() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, zzsh_supply AS $$
DECLARE affected_game text;
BEGIN
  IF TG_TABLE_NAME='listing_publication' THEN
    UPDATE zzsh_supply.legacy_image_cdn_delivery SET state='REVOKING'
      WHERE account_id=NEW.account_id AND version_id<>NEW.version_id AND state IN ('PUBLISHING','READY');
  ELSIF TG_TABLE_NAME='rental_account' THEN
    UPDATE zzsh_supply.legacy_image_cdn_delivery SET state='REVOKING' WHERE account_id=NEW.id AND state IN ('PUBLISHING','READY');
  ELSE
    IF TG_TABLE_NAME='game' THEN affected_game := NEW.id;
    ELSE
      IF NEW.service_code <> 'ACCOUNT_RENTAL' THEN RETURN NEW; END IF;
      affected_game := NEW.game_id;
    END IF;
    UPDATE zzsh_supply.legacy_image_cdn_delivery d SET state='REVOKING' FROM zzsh_supply.rental_account a
      WHERE a.id=d.account_id AND a.game_id=affected_game AND d.state IN ('PUBLISHING','READY');
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listing_publication_cdn_legacy AFTER INSERT ON zzsh_supply.listing_publication
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.restrict_legacy_image_cdn();
CREATE TRIGGER rental_account_cdn_legacy AFTER UPDATE OF staff_restricted, lifecycle, owner_user_id, legacy_hold ON zzsh_supply.rental_account
FOR EACH ROW WHEN (OLD.staff_restricted IS DISTINCT FROM NEW.staff_restricted OR OLD.lifecycle IS DISTINCT FROM NEW.lifecycle OR OLD.owner_user_id IS DISTINCT FROM NEW.owner_user_id OR OLD.legacy_hold IS DISTINCT FROM NEW.legacy_hold)
EXECUTE FUNCTION zzsh_supply.restrict_legacy_image_cdn();
CREATE TRIGGER game_cdn_legacy AFTER UPDATE OF enabled ON zzsh_supply.game
FOR EACH ROW WHEN (OLD.enabled IS DISTINCT FROM NEW.enabled) EXECUTE FUNCTION zzsh_supply.restrict_legacy_image_cdn();
CREATE TRIGGER game_service_cdn_legacy AFTER UPDATE OF enabled ON zzsh_supply.game_service_operation
FOR EACH ROW WHEN (OLD.enabled IS DISTINCT FROM NEW.enabled) EXECUTE FUNCTION zzsh_supply.restrict_legacy_image_cdn();
