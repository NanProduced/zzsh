-- PUB-1/2: direct owner publication. 0-51 remain frozen.
-- Pre-release replacement approved by Owner; original rejected 0052 is archived.
ALTER TABLE zzsh_supply.listing_version
  DROP CONSTRAINT listing_version_review_state_check;
ALTER TABLE zzsh_supply.listing_version
  ADD CONSTRAINT listing_version_review_state_check
  CHECK (review_state IN ('DRAFT','SUBMITTED','WITHDRAWN','REJECTED','APPROVED','PUBLISHED','IMPORTED_UNVERIFIED'));
--> statement-breakpoint

ALTER TABLE zzsh_supply.media_asset
  ADD COLUMN technical_state text NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN technical_checked_at timestamptz,
  ADD COLUMN technical_failure_code text;
ALTER TABLE zzsh_supply.media_asset
  ADD CONSTRAINT media_asset_technical_state_check
  CHECK (technical_state IN ('UNKNOWN','READY','FAILED'));
ALTER TABLE zzsh_supply.media_asset
  ADD CONSTRAINT media_asset_technical_check_shape
  CHECK ((technical_state='UNKNOWN' AND technical_checked_at IS NULL AND technical_failure_code IS NULL)
      OR (technical_state='READY' AND technical_checked_at IS NOT NULL AND technical_failure_code IS NULL)
      OR (technical_state='FAILED' AND technical_checked_at IS NOT NULL AND technical_failure_code IS NOT NULL));
ALTER TABLE zzsh_supply.media_asset
  DROP CONSTRAINT media_asset_public_requires_approval;
ALTER TABLE zzsh_supply.media_asset
  DROP CONSTRAINT media_asset_public_ownership;
-- Existing user display assets have no trustworthy technical fact yet. Revoke
-- their public visibility before the new constraint is validated; revalidation
-- is a separate controlled operation and never infers READY from old approval.
UPDATE zzsh_supply.media_asset
   SET access_class='PRIVATE_REVIEW',
       review_reason=COALESCE(review_reason,'PUB-1 technical revalidation required'),
       revision=revision+1,
       updated_at=clock_timestamp()
 WHERE ownership_kind='USER_SUPPLY'
   AND purpose='ACCOUNT_DISPLAY'
   AND access_class='PUBLIC_DISPLAY';
ALTER TABLE zzsh_supply.media_asset
  ADD CONSTRAINT media_asset_public_visibility CHECK (
    access_class <> 'PUBLIC_DISPLAY'
    OR (public_storage_key IS NOT NULL AND (
      (ownership_kind IN ('PLATFORM_CATALOG','PLATFORM_CONTENT') AND review_state='APPROVED')
      OR (ownership_kind='USER_SUPPLY' AND purpose='ACCOUNT_DISPLAY' AND technical_state='READY')
    ))
  );
--> statement-breakpoint

CREATE TABLE zzsh_supply.listing_publication (
  id text PRIMARY KEY,
  version_id text NOT NULL UNIQUE,
  account_id text NOT NULL,
  owner_user_id text NOT NULL,
  game_id text NOT NULL REFERENCES zzsh_supply.game(id),
  rule_release_id text NOT NULL REFERENCES zzsh_supply.rule_release(id),
  content_hash text NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  source text NOT NULL CHECK (source IN ('OWNER_DIRECT','LEGACY_APPROVED')),
  published_by_realm text NOT NULL CHECK (published_by_realm IN ('user','admin')),
  published_by_user_id text REFERENCES zzsh_auth_user."user"(id),
  published_by_admin_id text REFERENCES zzsh_auth_admin."user"(id),
  published_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT listing_publication_version_fk
    FOREIGN KEY (version_id,account_id) REFERENCES zzsh_supply.listing_version(id,account_id),
  CONSTRAINT listing_publication_owner_fk
    FOREIGN KEY (account_id,owner_user_id) REFERENCES zzsh_supply.rental_account(id,owner_user_id),
  CONSTRAINT listing_publication_acceptance_fk
    FOREIGN KEY (owner_user_id,version_id,rule_release_id,content_hash)
    REFERENCES zzsh_supply.rule_acceptance(owner_user_id,listing_version_id,rule_release_id,accepted_content_hash),
  CONSTRAINT listing_publication_actor_shape CHECK (
    (source='OWNER_DIRECT' AND published_by_realm='user' AND published_by_user_id IS NOT NULL AND published_by_user_id=owner_user_id AND published_by_admin_id IS NULL)
    OR (source='LEGACY_APPROVED' AND published_by_realm='admin' AND published_by_user_id IS NULL AND published_by_admin_id IS NOT NULL)
  )
);
CREATE INDEX listing_publication_account_time_idx
  ON zzsh_supply.listing_publication(account_id,published_at DESC,id);
--> statement-breakpoint

CREATE OR REPLACE FUNCTION zzsh_supply.guard_listing_commitments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' AND NEW.review_state<>'DRAFT' THEN
    RAISE EXCEPTION 'a listing starts as a draft';
  END IF;
  IF NEW.review_state IN ('SUBMITTED','APPROVED','PUBLISHED') AND NOT EXISTS(
    SELECT 1 FROM zzsh_supply.rule_acceptance r
     WHERE r.listing_version_id=NEW.id AND r.account_id=NEW.account_id
       AND r.rule_release_id=NEW.rule_release_id AND r.accepted_content_hash=NEW.content_hash
  ) THEN
    RAISE EXCEPTION 'submitted content requires matching acceptance';
  END IF;
  IF NEW.review_state='APPROVED' AND NOT EXISTS(
    SELECT 1 FROM zzsh_supply.review_decision d
     WHERE d.version_id=NEW.id AND d.release_id=NEW.rule_release_id
       AND d.content_hash=NEW.content_hash AND d.decision='APPROVE'
  ) THEN
    RAISE EXCEPTION 'approval requires an exact decision';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION zzsh_supply.guard_listing_content() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW.id,NEW.account_id,NEW.sequence,NEW.origin) IS DISTINCT FROM (OLD.id,OLD.account_id,OLD.sequence,OLD.origin) THEN
    RAISE EXCEPTION 'listing identity is immutable';
  END IF;
  IF OLD.review_state <> 'DRAFT' AND (to_jsonb(NEW)-'review_state'-'revision') IS DISTINCT FROM (to_jsonb(OLD)-'review_state'-'revision') THEN
    RAISE EXCEPTION 'submitted listing content is immutable';
  END IF;
  IF NEW.review_state IS DISTINCT FROM OLD.review_state AND NOT (
    (OLD.review_state='DRAFT' AND NEW.review_state IN ('SUBMITTED','IMPORTED_UNVERIFIED','PUBLISHED')) OR
    (OLD.review_state='SUBMITTED' AND NEW.review_state IN ('WITHDRAWN','APPROVED','REJECTED'))
  ) THEN
    RAISE EXCEPTION 'invalid listing transition' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION zzsh_supply.guard_listing_publication_shape() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  listing_row record;
BEGIN
  SELECT lv.*,ra.owner_user_id AS actual_owner,ra.game_id AS actual_game
    INTO listing_row
    FROM zzsh_supply.listing_version lv
    JOIN zzsh_supply.rental_account ra ON ra.id=lv.account_id
   WHERE lv.id=NEW.version_id AND ra.id=NEW.account_id
   FOR UPDATE OF lv;
  IF NOT FOUND
     OR listing_row.actual_owner IS DISTINCT FROM NEW.owner_user_id
     OR listing_row.actual_game IS DISTINCT FROM NEW.game_id
     OR listing_row.rule_release_id IS DISTINCT FROM NEW.rule_release_id
     OR listing_row.content_hash IS DISTINCT FROM NEW.content_hash THEN
    RAISE EXCEPTION 'publication does not match listing snapshot' USING ERRCODE='40001';
  END IF;
  IF NEW.source='OWNER_DIRECT' AND listing_row.review_state NOT IN ('DRAFT','PUBLISHED') THEN
    RAISE EXCEPTION 'direct publication requires the owner draft';
  END IF;
  IF NEW.source='LEGACY_APPROVED' AND listing_row.review_state<>'APPROVED' THEN
    RAISE EXCEPTION 'legacy publication requires an approved version';
  END IF;
  IF NOT EXISTS(
    SELECT 1 FROM zzsh_supply.rule_acceptance r
     WHERE r.owner_user_id=NEW.owner_user_id AND r.listing_version_id=NEW.version_id
       AND r.account_id=NEW.account_id AND r.rule_release_id=NEW.rule_release_id
       AND r.accepted_content_hash=NEW.content_hash
  ) THEN
    RAISE EXCEPTION 'publication requires matching rule acceptance';
  END IF;
  IF NEW.source='LEGACY_APPROVED' AND NOT EXISTS(
    SELECT 1 FROM zzsh_supply.review_decision d
     WHERE d.version_id=NEW.version_id AND d.release_id=NEW.rule_release_id
       AND d.content_hash=NEW.content_hash AND d.decision='APPROVE'
       AND d.reviewer_admin_id=NEW.published_by_admin_id AND d.decided_at=NEW.published_at
  ) THEN
    RAISE EXCEPTION 'legacy publication requires an exact approval';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listing_publication_shape
  BEFORE INSERT ON zzsh_supply.listing_publication
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_publication_shape();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION zzsh_supply.guard_listing_publication_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'listing publication is immutable' USING ERRCODE='40001';
END $$;
CREATE TRIGGER listing_publication_immutable
  BEFORE UPDATE OR DELETE ON zzsh_supply.listing_publication
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_publication_immutable();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION zzsh_supply.assert_listing_publication_final(p_version_id text) RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  version_state text;
  publication_source text;
  publication_version_id text;
  publication_account_id text;
  publication_owner_user_id text;
  publication_game_id text;
  publication_rule_release_id text;
  publication_content_hash text;
  version_account_id text;
  version_owner_user_id text;
  version_game_id text;
  version_rule_release_id text;
  version_content_hash text;
  has_publication boolean;
BEGIN
  SELECT v.review_state,v.account_id,v.rule_release_id,v.content_hash,a.owner_user_id,a.game_id
    INTO version_state,version_account_id,version_rule_release_id,version_content_hash,version_owner_user_id,version_game_id
    FROM zzsh_supply.listing_version v
    JOIN zzsh_supply.rental_account a ON a.id=v.account_id
   WHERE v.id=p_version_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'listing version for publication consistency is missing' USING ERRCODE='40001';
  END IF;

  SELECT p.version_id,p.source,p.account_id,p.owner_user_id,p.game_id,p.rule_release_id,p.content_hash
    INTO publication_version_id,publication_source,publication_account_id,publication_owner_user_id,publication_game_id,publication_rule_release_id,publication_content_hash
    FROM zzsh_supply.listing_publication p
   WHERE p.version_id=p_version_id;
  has_publication := FOUND;

  IF version_state='PUBLISHED' THEN
    IF NOT has_publication OR publication_source<>'OWNER_DIRECT' THEN
      RAISE EXCEPTION 'published version requires an OWNER_DIRECT publication fact' USING ERRCODE='40001';
    END IF;
  ELSIF version_state='APPROVED' THEN
    IF NOT has_publication OR publication_source<>'LEGACY_APPROVED' THEN
      RAISE EXCEPTION 'approved version requires a LEGACY_APPROVED publication fact' USING ERRCODE='40001';
    END IF;
  ELSIF has_publication THEN
    RAISE EXCEPTION 'a publication fact cannot belong to this listing state' USING ERRCODE='40001';
  END IF;

  IF has_publication AND (
    publication_version_id IS DISTINCT FROM p_version_id
    OR publication_account_id IS DISTINCT FROM version_account_id
    OR publication_owner_user_id IS DISTINCT FROM version_owner_user_id
    OR publication_game_id IS DISTINCT FROM version_game_id
    OR publication_rule_release_id IS DISTINCT FROM version_rule_release_id
    OR publication_content_hash IS DISTINCT FROM version_content_hash
  ) THEN
    RAISE EXCEPTION 'publication does not match final listing snapshot' USING ERRCODE='40001';
  END IF;

  IF has_publication AND publication_source='LEGACY_APPROVED' AND NOT EXISTS(
    SELECT 1 FROM zzsh_supply.review_decision d
      JOIN zzsh_supply.listing_publication p ON p.version_id=d.version_id
     WHERE d.version_id=p_version_id AND d.release_id=version_rule_release_id
       AND d.content_hash=version_content_hash AND d.decision='APPROVE'
       AND p.published_by_admin_id=d.reviewer_admin_id AND p.published_at=d.decided_at
  ) THEN
    RAISE EXCEPTION 'legacy publication has no exact approval' USING ERRCODE='40001';
  END IF;
END $$;
--> statement-breakpoint

CREATE OR REPLACE FUNCTION zzsh_supply.guard_listing_publication_consistency() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM zzsh_supply.assert_listing_publication_final(
    CASE WHEN TG_OP='DELETE' THEN OLD.version_id ELSE NEW.version_id END
  );
  RETURN COALESCE(NEW,OLD);
END $$;
CREATE CONSTRAINT TRIGGER listing_publication_consistency
  AFTER INSERT OR UPDATE OR DELETE ON zzsh_supply.listing_publication
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_publication_consistency();
--> statement-breakpoint

CREATE OR REPLACE FUNCTION zzsh_supply.guard_listing_version_publication() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM zzsh_supply.assert_listing_publication_final(NEW.id);
  RETURN NEW;
END $$;
CREATE CONSTRAINT TRIGGER listing_version_publication
  AFTER INSERT OR UPDATE ON zzsh_supply.listing_version
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_version_publication();
--> statement-breakpoint

-- Existing media was not re-read by this migration. UNKNOWN is intentional;
-- a controlled revalidation must promote an asset to READY before exposure.
INSERT INTO zzsh_supply.listing_publication
  (id,version_id,account_id,owner_user_id,game_id,rule_release_id,content_hash,source,published_by_realm,published_by_admin_id,published_at)
SELECT 'legacy_publication_'||v.id,v.id,v.account_id,a.owner_user_id,a.game_id,v.rule_release_id,v.content_hash,
       'LEGACY_APPROVED','admin',d.reviewer_admin_id,d.decided_at
  FROM zzsh_supply.listing_version v
  JOIN zzsh_supply.rental_account a ON a.id=v.account_id
  JOIN zzsh_supply.review_decision d ON d.version_id=v.id
 WHERE v.review_state='APPROVED' AND v.origin='NATIVE'
   AND d.release_id=v.rule_release_id AND d.content_hash=v.content_hash AND d.decision='APPROVE'
   AND EXISTS(
     SELECT 1 FROM zzsh_supply.rule_acceptance r
      WHERE r.owner_user_id=a.owner_user_id AND r.account_id=v.account_id
        AND r.listing_version_id=v.id AND r.rule_release_id=v.rule_release_id
        AND r.accepted_content_hash=v.content_hash
   )
ON CONFLICT (version_id) DO NOTHING;
--> statement-breakpoint

REVOKE UPDATE,DELETE,TRUNCATE ON zzsh_supply.listing_publication FROM PUBLIC;
