CREATE FUNCTION zzsh_supply.guard_rental_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF (NEW.id,NEW.owner_user_id,NEW.game_id) IS DISTINCT FROM (OLD.id,OLD.owner_user_id,OLD.game_id) THEN RAISE EXCEPTION 'rental account identity is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER rental_identity BEFORE UPDATE ON zzsh_supply.rental_account FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_rental_identity();
CREATE FUNCTION zzsh_supply.guard_asset_account() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.account_id IS DISTINCT FROM OLD.account_id THEN RAISE EXCEPTION 'asset account is immutable'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER asset_account BEFORE UPDATE ON zzsh_supply.media_asset FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_asset_account();
CREATE FUNCTION zzsh_supply.guard_listing_commitments() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='INSERT' AND NEW.review_state<>'DRAFT' THEN RAISE EXCEPTION 'a listing starts as a draft'; END IF;
 IF NEW.review_state IN ('SUBMITTED','APPROVED') AND NOT EXISTS(SELECT 1 FROM zzsh_supply.rule_acceptance r WHERE r.listing_version_id=NEW.id AND r.account_id=NEW.account_id AND r.rule_release_id=NEW.rule_release_id AND r.accepted_content_hash=NEW.content_hash) THEN RAISE EXCEPTION 'submitted content requires matching acceptance'; END IF;
 IF NEW.review_state='APPROVED' AND NOT EXISTS(SELECT 1 FROM zzsh_supply.review_decision d WHERE d.version_id=NEW.id AND d.release_id=NEW.rule_release_id AND d.content_hash=NEW.content_hash AND d.decision='APPROVE') THEN RAISE EXCEPTION 'approval requires an exact decision'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER listing_commitments BEFORE INSERT OR UPDATE ON zzsh_supply.listing_version FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_commitments();
CREATE FUNCTION zzsh_supply.guard_listing_decision() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE v record;
BEGIN
 SELECT * INTO v FROM zzsh_supply.listing_version WHERE id=NEW.version_id FOR UPDATE;
 IF v.review_state<>'SUBMITTED' OR v.content_hash IS DISTINCT FROM NEW.content_hash OR v.rule_release_id IS DISTINCT FROM NEW.release_id THEN RAISE EXCEPTION 'decision requires exact submitted content' USING ERRCODE='40001'; END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER listing_decision BEFORE INSERT ON zzsh_supply.review_decision FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_decision();
