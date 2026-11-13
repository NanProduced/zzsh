-- Candidate only. Install after policy schedules and system initialization provenance.
ALTER TABLE zzsh_supply.rule_release
  ADD COLUMN effective_at timestamptz,
  ADD COLUMN announcement_version_id text REFERENCES zzsh_content.content_version(id),
  ADD CONSTRAINT rule_release_schedule_shape CHECK (
    (effective_at IS NULL AND announcement_version_id IS NULL)
    OR (effective_at IS NOT NULL AND announcement_version_id IS NOT NULL AND activated_at=effective_at));
CREATE UNIQUE INDEX rule_release_schedule_time ON zzsh_supply.rule_release(game_id,effective_at) WHERE effective_at IS NOT NULL;

CREATE FUNCTION zzsh_supply.guard_rule_release_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.effective_at IS NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.oid=TG_RELID AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)) THEN
      RAISE EXCEPTION 'operational rule release requires a schedule' USING ERRCODE='40001';
    END IF;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM zzsh_iam.admin_security s
      WHERE s.admin_user_id=NEW.activated_by_admin_id AND s.status='ACTIVE' AND s.is_boss
    ) THEN RAISE EXCEPTION 'rule release schedule requires an active boss' USING ERRCODE='42501'; END IF;
    PERFORM 1 FROM zzsh_supply.game WHERE id=NEW.game_id FOR UPDATE;
    IF NOT FOUND OR NEW.generation IS DISTINCT FROM (
      SELECT COALESCE(MAX(generation),0)+1 FROM zzsh_supply.rule_release WHERE game_id=NEW.game_id
    ) THEN RAISE EXCEPTION 'rule release generation changed' USING ERRCODE='40001'; END IF;
    PERFORM 1 FROM zzsh_content.content_version v JOIN zzsh_content.content_item i ON i.id=v.item_id
      WHERE v.id=NEW.announcement_version_id AND i.type='ANNOUNCEMENT' AND (i.game_id IS NULL OR i.game_id=NEW.game_id)
        AND v.state='PUBLISHED' AND v.published_at<=statement_timestamp()
        AND (v.update_settings->>'visibleFrom' IS NULL OR (v.update_settings->>'visibleFrom')::timestamptz<=statement_timestamp())
        AND (v.update_settings->>'validUntil' IS NULL OR (v.update_settings->>'validUntil')::timestamptz>statement_timestamp())
      FOR SHARE OF v,i;
    IF NOT FOUND OR NEW.effective_at<=clock_timestamp() OR NEW.activated_at<>NEW.effective_at THEN
      RAISE EXCEPTION 'invalid rule release announcement or effective time' USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rule_release_schedule_guard BEFORE INSERT ON zzsh_supply.rule_release
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_rule_release_schedule();

CREATE FUNCTION zzsh_supply.guard_rule_release_commit_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.effective_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'rule release schedule must take effect after commit' USING ERRCODE='40001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rule_release_commit_time AFTER INSERT ON zzsh_supply.rule_release
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_rule_release_commit_time();

CREATE FUNCTION zzsh_supply.guard_rule_release_baseline() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.current_release_id IS DISTINCT FROM OLD.current_release_id AND NOT EXISTS (
    SELECT 1 FROM pg_class c WHERE c.oid=TG_RELID AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)
  ) THEN RAISE EXCEPTION 'only initialization can change the rule release baseline' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rule_release_baseline_guard BEFORE UPDATE OF current_release_id ON zzsh_supply.game
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_rule_release_baseline();

CREATE FUNCTION zzsh_supply.effective_rule_release(game_id text, baseline text, as_of timestamptz)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT r.id FROM zzsh_supply.rule_release r
    WHERE r.game_id=$1 AND r.effective_at<=$3 ORDER BY r.effective_at DESC,r.generation DESC LIMIT 1), $2)
$$;

CREATE FUNCTION zzsh_supply.guard_publication_effective_rule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  effective_release text;
  selected_model text;
  evaluated_at timestamptz;
  expected_policy jsonb;
  actual_policy jsonb;
BEGIN
  -- A historical import keeps its original approval time and version.
  IF NEW.source='LEGACY_APPROVED' AND EXISTS (
    SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid=TG_RELID AND r.rolname=current_user
  ) THEN RETURN NEW; END IF;
  PERFORM 1 FROM zzsh_supply.game WHERE id=NEW.game_id AND enabled FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'publication game unavailable' USING ERRCODE='40001'; END IF;
  evaluated_at := clock_timestamp();
  IF NEW.source='OWNER_DIRECT' THEN NEW.published_at := evaluated_at; END IF;
  SELECT zzsh_supply.effective_rule_release(g.id,g.current_release_id,evaluated_at)
    INTO effective_release FROM zzsh_supply.game g WHERE g.id=NEW.game_id;
  IF effective_release IS NULL OR NEW.rule_release_id IS DISTINCT FROM effective_release THEN
    RAISE EXCEPTION 'publication rule release changed' USING ERRCODE='40001';
  END IF;
  IF NEW.source<>'OWNER_DIRECT' THEN RETURN NEW; END IF;
  SELECT pricing_model INTO selected_model FROM zzsh_supply.pricing_mode_schedule
    WHERE game_id=NEW.game_id AND effective_at<=NEW.published_at ORDER BY effective_at DESC,generation DESC LIMIT 1;
  SELECT v.payload->'pricingPolicy' INTO actual_policy FROM zzsh_supply.listing_version v WHERE v.id=NEW.version_id;
  IF selected_model IS NOT NULL THEN
    SELECT jsonb_build_object('schema','pricing-policy-v1','pricingModel',pricing_model,
      'scheduleId',id,'generation',generation::text,'priceVersionId',price_version_id,'effectiveAt',
      to_char(effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      INTO expected_policy FROM zzsh_supply.pricing_policy_schedule
      WHERE game_id=NEW.game_id AND pricing_model=selected_model AND effective_at<=NEW.published_at
      ORDER BY effective_at DESC,generation DESC LIMIT 1;
    IF expected_policy IS NULL THEN RAISE EXCEPTION 'publication price policy missing' USING ERRCODE='40001'; END IF;
  END IF;
  IF actual_policy IS DISTINCT FROM expected_policy THEN
    RAISE EXCEPTION 'publication price policy changed' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER listing_publication_effective_rule_guard BEFORE INSERT ON zzsh_supply.listing_publication
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_publication_effective_rule();

-- Preserve the installed guarantee checks. Replace only the rule lookup they share with the API.
DO $guard$
DECLARE definition text; previous text := 'JOIN zzsh_supply.rule_release r ON r.id=g.current_release_id AND r.game_id=g.id';
BEGIN
  definition := pg_get_functiondef('zzsh_supply.guard_account_guarantee_proof_insert()'::regprocedure);
  IF array_length(string_to_array(definition,previous),1) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION 'unexpected guarantee proof contract';
  END IF;
  EXECUTE replace(definition,previous,$binding$LEFT JOIN zzsh_supply.rental_account a ON a.id=NEW.account_id
    LEFT JOIN zzsh_supply.listing_version v ON v.id=a.current_version_id AND v.account_id=a.id
    LEFT JOIN zzsh_supply.listing_publication pub ON pub.version_id=v.id AND pub.account_id=a.id
      AND pub.owner_user_id=a.owner_user_id AND pub.game_id=a.game_id
      AND pub.rule_release_id=v.rule_release_id AND pub.content_hash=v.content_hash
    JOIN zzsh_supply.rule_release r ON r.game_id=g.id AND r.id=CASE
      WHEN v.review_state IN ('PUBLISHED','APPROVED') THEN
        CASE WHEN (v.review_state='PUBLISHED' AND pub.source='OWNER_DIRECT') OR (v.review_state='APPROVED' AND pub.source='LEGACY_APPROVED')
          THEN v.rule_release_id END
      ELSE zzsh_supply.effective_rule_release(g.id,g.current_release_id,transaction_timestamp()) END$binding$);
END $guard$;
