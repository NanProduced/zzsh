CREATE TABLE zzsh_supply.listing_version (
  id text PRIMARY KEY,
  account_id text NOT NULL REFERENCES zzsh_supply.rental_account(id),
  sequence bigint NOT NULL CHECK (sequence > 0),
  origin text NOT NULL DEFAULT 'NATIVE' CHECK (origin IN ('NATIVE','LEGACY_OBSERVATION')),
  review_state text NOT NULL DEFAULT 'DRAFT' CHECK (review_state IN ('DRAFT','SUBMITTED','WITHDRAWN','REJECTED','APPROVED','IMPORTED_UNVERIFIED')),
  title text NOT NULL DEFAULT '', description text,
  attributes jsonb NOT NULL DEFAULT '{}',
  term_option_code text NOT NULL DEFAULT '', pricing_option_code text NOT NULL DEFAULT '',
  rule_release_id text REFERENCES zzsh_supply.rule_release(id),
  content_hash text CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  payload jsonb,
  presentation jsonb NOT NULL DEFAULT '{}',
  revision bigint NOT NULL DEFAULT 1 CHECK (revision > 0),
  submitted_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, sequence), UNIQUE (id, account_id),
  CHECK ((payload IS NULL) = (content_hash IS NULL)),
  CHECK (review_state NOT IN ('SUBMITTED','APPROVED') OR (payload IS NOT NULL AND rule_release_id IS NOT NULL AND submitted_at IS NOT NULL)),
  CHECK (origin <> 'LEGACY_OBSERVATION' OR review_state IN ('DRAFT','IMPORTED_UNVERIFIED'))
);
ALTER TABLE zzsh_supply.rental_account ADD CONSTRAINT rental_account_owner_unique UNIQUE(id,owner_user_id);
ALTER TABLE zzsh_supply.rental_account ADD CONSTRAINT current_listing_account_fk FOREIGN KEY(current_version_id,id) REFERENCES zzsh_supply.listing_version(id,account_id);
ALTER TABLE zzsh_supply.rule_acceptance ADD CONSTRAINT acceptance_listing_account_fk FOREIGN KEY(listing_version_id,account_id) REFERENCES zzsh_supply.listing_version(id,account_id);
ALTER TABLE zzsh_supply.rule_acceptance ADD CONSTRAINT acceptance_owner_fk FOREIGN KEY(account_id,owner_user_id) REFERENCES zzsh_supply.rental_account(id,owner_user_id);

CREATE TABLE zzsh_supply.inventory_line (
  version_id text NOT NULL REFERENCES zzsh_supply.listing_version(id), item_id text NOT NULL REFERENCES zzsh_supply.billable_item(id),
  quantity numeric(24,0) CHECK(quantity >= 0), PRIMARY KEY(version_id,item_id)
);
CREATE TABLE zzsh_supply.listing_skin (
  version_id text NOT NULL REFERENCES zzsh_supply.listing_version(id), skin_id text NOT NULL REFERENCES zzsh_supply.skin(id), PRIMARY KEY(version_id,skin_id)
);
CREATE TABLE zzsh_supply.listing_entitlement (
  version_id text NOT NULL REFERENCES zzsh_supply.listing_version(id), entitlement_id text NOT NULL REFERENCES zzsh_supply.entitlement(id),
  value jsonb, expires_at timestamptz, expiry_knowledge text NOT NULL CHECK(expiry_knowledge IN ('KNOWN','UNKNOWN')),
  PRIMARY KEY(version_id,entitlement_id)
);
ALTER TABLE zzsh_supply.media_asset ADD COLUMN account_id text REFERENCES zzsh_supply.rental_account(id);
UPDATE zzsh_supply.media_asset a SET account_id=i.account_id FROM zzsh_supply.media_upload_intent i WHERE i.consumed_asset_id=a.id AND a.ownership_kind='USER_SUPPLY';
ALTER TABLE zzsh_supply.media_asset ADD CONSTRAINT asset_account_owner_fk FOREIGN KEY(account_id,owner_user_id) REFERENCES zzsh_supply.rental_account(id,owner_user_id);
ALTER TABLE zzsh_supply.media_asset ADD CONSTRAINT asset_account_required CHECK(ownership_kind <> 'USER_SUPPLY' OR account_id IS NOT NULL) NOT VALID;

ALTER TABLE zzsh_supply.media_upload_intent DROP CONSTRAINT media_upload_intent_purpose_check;
ALTER TABLE zzsh_supply.media_asset DROP CONSTRAINT media_asset_purpose_check;
ALTER TABLE zzsh_supply.media_upload_intent ADD CHECK(purpose IN ('GAME_COVER','SKIN_MEDIA','ITEM_MEDIA','ACCOUNT_EVIDENCE','ACCOUNT_DISPLAY'));
ALTER TABLE zzsh_supply.media_asset ADD CHECK(purpose IN ('GAME_COVER','SKIN_MEDIA','ITEM_MEDIA','ACCOUNT_EVIDENCE','ACCOUNT_DISPLAY'));
ALTER TABLE zzsh_supply.media_upload_intent DROP CONSTRAINT media_upload_intent_actor_shape;
ALTER TABLE zzsh_supply.media_upload_intent ADD CONSTRAINT media_upload_intent_actor_shape CHECK(
 (uploaded_by_realm='admin' AND ownership_kind='PLATFORM_CATALOG' AND purpose IN ('GAME_COVER','SKIN_MEDIA','ITEM_MEDIA') AND owner_user_id IS NULL AND uploaded_by_admin_id IS NOT NULL AND uploaded_by_user_id IS NULL AND account_id IS NULL)
 OR (uploaded_by_realm='user' AND ownership_kind='USER_SUPPLY' AND purpose IN ('ACCOUNT_EVIDENCE','ACCOUNT_DISPLAY') AND owner_user_id=uploaded_by_user_id AND uploaded_by_admin_id IS NULL AND owner_user_id IS NOT NULL AND account_id IS NOT NULL));
ALTER TABLE zzsh_supply.media_asset DROP CONSTRAINT media_asset_actor_shape;
ALTER TABLE zzsh_supply.media_asset ADD CONSTRAINT media_asset_actor_shape CHECK(
 (uploaded_by_realm='admin' AND ownership_kind='PLATFORM_CATALOG' AND purpose IN ('GAME_COVER','SKIN_MEDIA','ITEM_MEDIA') AND owner_user_id IS NULL AND uploaded_by_admin_id IS NOT NULL AND uploaded_by_user_id IS NULL)
 OR (uploaded_by_realm='user' AND ownership_kind='USER_SUPPLY' AND purpose IN ('ACCOUNT_EVIDENCE','ACCOUNT_DISPLAY') AND owner_user_id=uploaded_by_user_id AND uploaded_by_admin_id IS NULL AND owner_user_id IS NOT NULL));
ALTER TABLE zzsh_supply.media_asset ADD CHECK(access_class <> 'PUBLIC_DISPLAY' OR ownership_kind='PLATFORM_CATALOG' OR purpose='ACCOUNT_DISPLAY');

CREATE TABLE zzsh_supply.listing_media (
  version_id text NOT NULL REFERENCES zzsh_supply.listing_version(id), asset_id text NOT NULL REFERENCES zzsh_supply.media_asset(id),
  position integer NOT NULL CHECK(position>=0 AND position<100), PRIMARY KEY(version_id,asset_id), UNIQUE(version_id,position)
);
CREATE TABLE zzsh_supply.review_decision (
  id text PRIMARY KEY, version_id text NOT NULL UNIQUE REFERENCES zzsh_supply.listing_version(id),
  release_id text NOT NULL REFERENCES zzsh_supply.rule_release(id), content_hash text NOT NULL,
  decision text NOT NULL CHECK(decision IN ('APPROVE','REJECT')),
  reason text NOT NULL CHECK(length(reason) BETWEEN 2 AND 500),
  reviewer_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id), decided_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE zzsh_supply.duplicate_hint (
  id text PRIMARY KEY, account_id text NOT NULL REFERENCES zzsh_supply.rental_account(id), related_account_id text NOT NULL REFERENCES zzsh_supply.rental_account(id),
  evidence_ref text NOT NULL, result text NOT NULL CHECK(result IN ('UNREVIEWED','DISTINCT','POSSIBLE_SAME')),
  reason text NOT NULL, reviewer_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id), created_at timestamptz NOT NULL DEFAULT now(), CHECK(account_id<>related_account_id)
);
CREATE TABLE zzsh_supply.legacy_supply_map (
  source_system text NOT NULL, source_entity text NOT NULL, legacy_id text NOT NULL,
  account_id text NOT NULL REFERENCES zzsh_supply.rental_account(id), version_id text NOT NULL REFERENCES zzsh_supply.listing_version(id),
  evidence_ref text NOT NULL, source_digest text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(source_system,source_entity,legacy_id)
);
CREATE INDEX listing_review_queue ON zzsh_supply.listing_version(review_state,submitted_at,id);

CREATE FUNCTION zzsh_supply.guard_listing_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.account_id,NEW.sequence,NEW.origin) IS DISTINCT FROM (OLD.id,OLD.account_id,OLD.sequence,OLD.origin) THEN RAISE EXCEPTION 'listing identity is immutable'; END IF;
  IF OLD.review_state <> 'DRAFT' AND (to_jsonb(NEW)-'review_state'-'revision') IS DISTINCT FROM (to_jsonb(OLD)-'review_state'-'revision') THEN RAISE EXCEPTION 'submitted listing content is immutable'; END IF;
  IF NEW.review_state IS DISTINCT FROM OLD.review_state AND NOT (
    (OLD.review_state='DRAFT' AND NEW.review_state IN ('SUBMITTED','IMPORTED_UNVERIFIED')) OR
    (OLD.review_state='SUBMITTED' AND NEW.review_state IN ('WITHDRAWN','APPROVED','REJECTED'))
  ) THEN RAISE EXCEPTION 'invalid listing transition' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listing_content BEFORE UPDATE ON zzsh_supply.listing_version FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_content();

CREATE FUNCTION zzsh_supply.guard_listing_child() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE parent record; new_id text; old_id text; target_game text; asset record;
BEGIN
  IF TG_OP<>'INSERT' THEN old_id:=OLD.version_id; END IF;
  IF TG_OP<>'DELETE' THEN new_id:=NEW.version_id; END IF;
  FOR parent IN SELECT v.*,a.game_id,a.owner_user_id FROM zzsh_supply.listing_version v JOIN zzsh_supply.rental_account a ON a.id=v.account_id WHERE v.id=ANY(ARRAY[old_id,new_id]) ORDER BY v.id FOR UPDATE OF v LOOP
    IF parent.review_state<>'DRAFT' THEN RAISE EXCEPTION 'submitted listing children are immutable' USING ERRCODE='40001'; END IF;
    UPDATE zzsh_supply.listing_version SET payload=NULL,content_hash=NULL,rule_release_id=NULL WHERE id=parent.id;
  END LOOP;
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  SELECT v.*,a.game_id,a.owner_user_id INTO parent FROM zzsh_supply.listing_version v JOIN zzsh_supply.rental_account a ON a.id=v.account_id WHERE v.id=new_id;
  IF TG_TABLE_NAME='inventory_line' THEN SELECT game_id INTO target_game FROM zzsh_supply.billable_item WHERE id=NEW.item_id;
  ELSIF TG_TABLE_NAME='listing_skin' THEN SELECT game_id INTO target_game FROM zzsh_supply.skin WHERE id=NEW.skin_id;
  ELSIF TG_TABLE_NAME='listing_entitlement' THEN SELECT game_id INTO target_game FROM zzsh_supply.entitlement WHERE id=NEW.entitlement_id;
  ELSE
    SELECT * INTO asset FROM zzsh_supply.media_asset WHERE id=NEW.asset_id;
    target_game:=asset.game_id;
    IF asset.account_id IS DISTINCT FROM parent.account_id OR asset.owner_user_id IS DISTINCT FROM parent.owner_user_id OR asset.purpose NOT IN ('ACCOUNT_EVIDENCE','ACCOUNT_DISPLAY') THEN RAISE EXCEPTION 'media belongs to another account'; END IF;
  END IF;
  IF target_game IS DISTINCT FROM parent.game_id THEN RAISE EXCEPTION 'listing child belongs to another game'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listing_child BEFORE INSERT OR UPDATE OR DELETE ON zzsh_supply.inventory_line FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_child();
CREATE TRIGGER listing_child BEFORE INSERT OR UPDATE OR DELETE ON zzsh_supply.listing_skin FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_child();
CREATE TRIGGER listing_child BEFORE INSERT OR UPDATE OR DELETE ON zzsh_supply.listing_entitlement FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_child();
CREATE TRIGGER listing_child BEFORE INSERT OR UPDATE OR DELETE ON zzsh_supply.listing_media FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_child();

CREATE FUNCTION zzsh_supply.guard_listing_acceptance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version record;
BEGIN
 SELECT * INTO version FROM zzsh_supply.listing_version WHERE id=NEW.listing_version_id FOR UPDATE;
 IF version.origin<>'NATIVE' OR version.review_state<>'DRAFT' OR version.content_hash IS DISTINCT FROM NEW.accepted_content_hash OR version.rule_release_id IS DISTINCT FROM NEW.rule_release_id THEN RAISE EXCEPTION 'acceptance does not match quoted content'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER listing_acceptance BEFORE INSERT ON zzsh_supply.rule_acceptance FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_acceptance();
CREATE TRIGGER acceptance_immutable BEFORE UPDATE OR DELETE ON zzsh_supply.rule_acceptance FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();
CREATE TRIGGER decision_immutable BEFORE UPDATE OR DELETE ON zzsh_supply.review_decision FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();
CREATE TRIGGER duplicate_immutable BEFORE UPDATE OR DELETE ON zzsh_supply.duplicate_hint FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();
CREATE TRIGGER legacy_map_immutable BEFORE UPDATE OR DELETE ON zzsh_supply.legacy_supply_map FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();

INSERT INTO zzsh_iam.admin_permission(code,name,description) VALUES
 ('supply.restrict','限制与解除供给','限制或解除指定范围供给'),
 ('supply.duplicate.review','供给重复线索','记录人工重复判断，不自动处置供给')
ON CONFLICT(code) DO NOTHING;
