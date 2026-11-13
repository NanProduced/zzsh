-- Atomic fixed-fee pricing, publication, funding and distribution contracts.
-- Application transaction and publication gates remain closed pending end-to-end verification.

--> statement-breakpoint
-- Contract: price-contract
-- Fixed-fee price version constraints.
CREATE FUNCTION zzsh_supply.valid_fixed_fee_rates(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE mode_name text; rate_text text;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR value - ARRAY['ordinary','custom','fast'] <> '{}'::jsonb THEN RETURN false; END IF;
  FOREACH mode_name IN ARRAY ARRAY['ordinary','custom','fast'] LOOP
    IF jsonb_typeof(value->mode_name) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    rate_text := value->>mode_name;
    IF length(rate_text)>10 OR rate_text !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$'
      OR rate_text::numeric >= 1 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION zzsh_supply.valid_fixed_fee_haff_rule(rule jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE map_name text; mode_name text; bound_name text; entry record; modes jsonb; config jsonb; bound jsonb;
BEGIN
  IF jsonb_typeof(rule) IS DISTINCT FROM 'object' OR rule->>'schema' IS DISTINCT FROM 'haff-ratio-v3'
    OR rule - ARRAY['schema','baseBySafeBox','vitalityDeltaByLevel','bearDeltaByLevel','dailyDeltaByTermOption','fixedModes'] <> '{}'::jsonb THEN RETURN false; END IF;
  FOREACH map_name IN ARRAY ARRAY['baseBySafeBox','vitalityDeltaByLevel','bearDeltaByLevel','dailyDeltaByTermOption'] LOOP
    IF jsonb_typeof(rule->map_name) IS DISTINCT FROM 'object' OR rule->map_name='{}'::jsonb THEN RETURN false; END IF;
    FOR entry IN SELECT * FROM jsonb_each(rule->map_name) LOOP
      IF map_name IN ('vitalityDeltaByLevel','bearDeltaByLevel') AND entry.key !~ '^(0|[1-9][0-9]*)$' THEN RETURN false; END IF;
      IF map_name IN ('baseBySafeBox','dailyDeltaByTermOption') AND entry.key !~ '^[a-z][a-z0-9_:-]{1,63}$' THEN RETURN false; END IF;
      IF jsonb_typeof(entry.value) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
      IF map_name='baseBySafeBox' THEN
        IF (entry.value#>>'{}') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$' OR (entry.value#>>'{}')::numeric<=0 THEN RETURN false; END IF;
      ELSIF (entry.value#>>'{}') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,8})?$' THEN RETURN false;
      END IF;
    END LOOP;
  END LOOP;
  modes := rule->'fixedModes';
  IF jsonb_typeof(modes) IS DISTINCT FROM 'object' OR modes - ARRAY['ordinary','custom','fast'] <> '{}'::jsonb THEN RETURN false; END IF;
  FOREACH mode_name IN ARRAY ARRAY['ordinary','custom','fast'] LOOP
    config := modes->mode_name;
    IF jsonb_typeof(config) IS DISTINCT FROM 'object' OR jsonb_typeof(config->'enabled') IS DISTINCT FROM 'boolean' THEN RETURN false; END IF;
    IF mode_name='ordinary' THEN
      IF config-'enabled'<>'{}'::jsonb THEN RETURN false; END IF;
    ELSE
      IF config-ARRAY['enabled','min','max']<>'{}'::jsonb THEN RETURN false; END IF;
      IF (config->>'enabled')::boolean THEN
        IF NOT (config ? 'min') THEN RETURN false; END IF;
        FOREACH bound_name IN ARRAY ARRAY['min','max'] LOOP
          IF bound_name='max' AND NOT (config ? 'max') THEN CONTINUE; END IF;
          bound := config->bound_name;
          IF jsonb_typeof(bound) IS DISTINCT FROM 'object' OR bound-ARRAY['base','value']<>'{}'::jsonb
            OR COALESCE(bound->>'base','') NOT IN ('C','ABSOLUTE') OR jsonb_typeof(bound->'value') IS DISTINCT FROM 'string'
            OR length(bound->>'value')>33 OR (bound->>'value') !~ '^-?(0|[1-9][0-9]*)(\.[0-9]{1,8})?$' THEN RETURN false; END IF;
        END LOOP;
      END IF;
    END IF;
  END LOOP;
  RETURN EXISTS (SELECT 1 FROM jsonb_each(modes) mode WHERE mode.value->>'enabled'='true');
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
ALTER TABLE zzsh_supply.price_version ADD COLUMN fixed_fee_rates jsonb;
COMMENT ON COLUMN zzsh_supply.price_version.fixed_fee_rates IS '固定手续费模式下普通、自定义和极速出租方式的费率；封存后不可更改。';
ALTER TABLE zzsh_supply.price_version DROP CONSTRAINT price_version_mode_amounts;
ALTER TABLE zzsh_supply.price_version ADD CONSTRAINT price_version_mode_amounts CHECK (COALESCE(
  (mode='SPREAD' AND commission_rate IS NULL AND fixed_fee_rates IS NULL)
  OR (mode='PERCENT' AND fixed_fee_rates IS NULL AND commission_rate IS NOT NULL AND commission_rate>=0 AND commission_rate<1)
  OR (mode='PERCENT' AND commission_rate IS NULL AND zzsh_supply.valid_fixed_fee_rates(fixed_fee_rates)
      AND (haff_rule IS NULL OR haff_rule->>'schema'='haff-ratio-v3')
      AND (status='DRAFT' OR haff_rule IS NOT NULL)), false));
ALTER TABLE zzsh_supply.price_version DROP CONSTRAINT price_version_haff_rule_shape;
ALTER TABLE zzsh_supply.price_version ADD CONSTRAINT price_version_haff_rule_shape CHECK (COALESCE(
  haff_rule IS NULL
  OR (fixed_fee_rates IS NULL AND jsonb_typeof(haff_rule)='object' AND haff_rule->>'schema'='haff-ratio-v1')
  OR (fixed_fee_rates IS NULL AND mode='SPREAD' AND zzsh_supply.valid_compat_haff_rule(haff_rule))
  OR (mode='PERCENT' AND fixed_fee_rates IS NOT NULL AND zzsh_supply.valid_fixed_fee_haff_rule(haff_rule)), false));
--> statement-breakpoint
CREATE FUNCTION zzsh_supply.guard_fixed_fee_price_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.fixed_fee_rates IS NOT NULL AND NEW.status='SEALED' THEN RAISE EXCEPTION 'fixed fee price version must be sealed from a draft'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER price_version_fixed_fee_guard BEFORE INSERT ON zzsh_supply.price_version
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_fixed_fee_price_version();
COMMENT ON FUNCTION zzsh_supply.valid_fixed_fee_rates(jsonb) IS '校验三种出租方式的固定手续费率。';
COMMENT ON FUNCTION zzsh_supply.valid_fixed_fee_haff_rule(jsonb) IS '校验固定手续费模式的哈夫币比例规则。';
COMMENT ON FUNCTION zzsh_supply.guard_fixed_fee_price_version() IS '固定手续费价格版本必须先建草稿再封存。';

--> statement-breakpoint
-- Contract: fixed-fee-rate-cap
-- At 92% + 8%, independent half-up on whole cents is complementary: cents*2/25 is never a half.
-- Validate any existing drafts when applying the fee cap.
CREATE OR REPLACE FUNCTION zzsh_supply.valid_fixed_fee_rates(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE mode_name text; rate_text text;
BEGIN
  IF jsonb_typeof(value) IS DISTINCT FROM 'object'
    OR value - ARRAY['ordinary','custom','fast'] <> '{}'::jsonb THEN RETURN false; END IF;
  FOREACH mode_name IN ARRAY ARRAY['ordinary','custom','fast'] LOOP
    IF jsonb_typeof(value->mode_name) IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    rate_text := value->>mode_name;
    IF length(rate_text)>10 OR rate_text !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,8})?$'
      OR rate_text::numeric > 0.92 THEN RETURN false; END IF;
  END LOOP;
  RETURN true;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
ALTER TABLE zzsh_supply.price_version ADD CONSTRAINT price_version_fixed_fee_full_payout_cap
 CHECK (fixed_fee_rates IS NULL OR zzsh_supply.valid_fixed_fee_rates(fixed_fee_rates));
COMMENT ON CONSTRAINT price_version_fixed_fee_full_payout_cap ON zzsh_supply.price_version IS '三种手续费率均不得超过 92%，给号主承担的 8% 包赔费留足毛收入。';

--> statement-breakpoint
-- Contract: policy-schedule
-- Fee policy publication remains disabled until application and ledger guards are complete.
CREATE TABLE zzsh_supply.pricing_policy_schedule (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  game_id text NOT NULL REFERENCES zzsh_supply.game(id),
  pricing_model text NOT NULL CHECK (pricing_model IN ('SPREAD','FIXED_FEE')),
  price_version_id text NOT NULL REFERENCES zzsh_supply.price_version(id),
  generation bigint NOT NULL CHECK (generation>0),
  effective_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('SYSTEM_INITIAL','ADMIN')),
  created_by_admin_id text REFERENCES zzsh_auth_admin."user"(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (game_id,pricing_model,generation),
  CHECK ((source='SYSTEM_INITIAL' AND created_by_admin_id IS NULL) OR (source='ADMIN' AND created_by_admin_id IS NOT NULL))
);
CREATE INDEX pricing_policy_schedule_effective_idx ON zzsh_supply.pricing_policy_schedule(game_id,pricing_model,effective_at DESC,generation DESC);
COMMENT ON TABLE zzsh_supply.pricing_policy_schedule IS '各游戏和抽成模式按生效时间排列的不可变价格政策。';
COMMENT ON COLUMN zzsh_supply.pricing_policy_schedule.id IS '价格政策记录标识。';
COMMENT ON COLUMN zzsh_supply.pricing_policy_schedule.game_id IS '所属游戏。';
COMMENT ON COLUMN zzsh_supply.pricing_policy_schedule.pricing_model IS '该记录适用的价差或固定手续费模式。';
COMMENT ON COLUMN zzsh_supply.pricing_policy_schedule.price_version_id IS '本次生效的已封存价格版本。';
COMMENT ON COLUMN zzsh_supply.pricing_policy_schedule.generation IS '同游戏同模式下的递增记录版本。';
COMMENT ON COLUMN zzsh_supply.pricing_policy_schedule.effective_at IS '价格政策生效时间。';
COMMENT ON COLUMN zzsh_supply.pricing_policy_schedule.source IS '首次安装或管理员配置来源。';
COMMENT ON COLUMN zzsh_supply.pricing_policy_schedule.created_by_admin_id IS '管理员配置时的操作人，首次安装为空。';
COMMENT ON COLUMN zzsh_supply.pricing_policy_schedule.created_at IS '记录创建时间。';
--> statement-breakpoint
CREATE TABLE zzsh_supply.pricing_mode_schedule (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'),
  game_id text NOT NULL REFERENCES zzsh_supply.game(id),
  pricing_model text NOT NULL CHECK (pricing_model IN ('SPREAD','FIXED_FEE')),
  generation bigint NOT NULL CHECK (generation>0),
  effective_at timestamptz NOT NULL,
  source text NOT NULL CHECK (source IN ('SYSTEM_INITIAL','ADMIN')),
  created_by_admin_id text REFERENCES zzsh_auth_admin."user"(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (game_id,generation),
  CHECK ((source='SYSTEM_INITIAL' AND created_by_admin_id IS NULL) OR (source='ADMIN' AND created_by_admin_id IS NOT NULL))
);
CREATE INDEX pricing_mode_schedule_effective_idx ON zzsh_supply.pricing_mode_schedule(game_id,effective_at DESC,generation DESC);
COMMENT ON TABLE zzsh_supply.pricing_mode_schedule IS '新上架账号默认抽成模式的生效计划，不改变已有账号及订单。';
COMMENT ON COLUMN zzsh_supply.pricing_mode_schedule.id IS '默认模式记录标识。';
COMMENT ON COLUMN zzsh_supply.pricing_mode_schedule.game_id IS '所属游戏。';
COMMENT ON COLUMN zzsh_supply.pricing_mode_schedule.pricing_model IS '新上架账号采用的抽成模式。';
COMMENT ON COLUMN zzsh_supply.pricing_mode_schedule.generation IS '同游戏下的递增记录版本。';
COMMENT ON COLUMN zzsh_supply.pricing_mode_schedule.effective_at IS '默认模式生效时间。';
COMMENT ON COLUMN zzsh_supply.pricing_mode_schedule.source IS '首次安装或管理员配置来源。';
COMMENT ON COLUMN zzsh_supply.pricing_mode_schedule.created_by_admin_id IS '管理员配置时的操作人，首次安装为空。';
COMMENT ON COLUMN zzsh_supply.pricing_mode_schedule.created_at IS '记录创建时间。';
--> statement-breakpoint
CREATE FUNCTION zzsh_supply.guard_pricing_schedule() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE version_row record; next_generation bigint; table_owner name;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'pricing schedules are immutable' USING ERRCODE='40001'; END IF;
  NEW.created_at:=clock_timestamp();
  PERFORM 1 FROM zzsh_supply.game WHERE id=NEW.game_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'pricing schedule game is missing' USING ERRCODE='23514'; END IF;
  SELECT pg_get_userbyid(c.relowner) INTO table_owner FROM pg_class c WHERE c.oid=TG_RELID;
  IF NEW.source='SYSTEM_INITIAL' AND current_user<>table_owner THEN RAISE EXCEPTION 'system initialization is restricted' USING ERRCODE='42501'; END IF;
  IF NEW.source='ADMIN' AND NEW.effective_at<=clock_timestamp() THEN RAISE EXCEPTION 'pricing schedule must take effect in the future' USING ERRCODE='23514'; END IF;
  IF TG_TABLE_NAME='pricing_policy_schedule' THEN
    SELECT game_id,mode,status,fixed_fee_rates INTO version_row FROM zzsh_supply.price_version WHERE id=NEW.price_version_id;
    IF version_row IS NULL OR version_row.game_id<>NEW.game_id OR version_row.status<>'SEALED'
      OR (NEW.pricing_model='SPREAD' AND (version_row.mode<>'SPREAD' OR version_row.fixed_fee_rates IS NOT NULL))
      OR (NEW.pricing_model='FIXED_FEE' AND (version_row.mode<>'PERCENT' OR NOT zzsh_supply.valid_fixed_fee_rates(version_row.fixed_fee_rates)))
      THEN RAISE EXCEPTION 'pricing schedule requires a matching sealed version' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(MAX(generation),0)+1 INTO next_generation FROM zzsh_supply.pricing_policy_schedule WHERE game_id=NEW.game_id AND pricing_model=NEW.pricing_model;
  ELSE
    IF NOT EXISTS (SELECT 1 FROM zzsh_supply.pricing_policy_schedule WHERE game_id=NEW.game_id AND pricing_model=NEW.pricing_model AND effective_at<=NEW.effective_at)
      THEN RAISE EXCEPTION 'default pricing model requires an effective price policy' USING ERRCODE='23514'; END IF;
    SELECT COALESCE(MAX(generation),0)+1 INTO next_generation FROM zzsh_supply.pricing_mode_schedule WHERE game_id=NEW.game_id;
  END IF;
  IF NEW.generation<>next_generation OR (NEW.source='SYSTEM_INITIAL' AND next_generation<>1)
    THEN RAISE EXCEPTION 'pricing schedule generation differs' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER pricing_policy_schedule_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_supply.pricing_policy_schedule
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_pricing_schedule();
CREATE TRIGGER pricing_mode_schedule_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_supply.pricing_mode_schedule
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_pricing_schedule();
COMMENT ON FUNCTION zzsh_supply.guard_pricing_schedule() IS '校验价格及默认模式生效计划的版本、来源和不可变约束。';
--> statement-breakpoint
CREATE FUNCTION zzsh_supply.guard_pricing_schedule_not_late() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source='ADMIN' AND NEW.effective_at<=clock_timestamp()
    THEN RAISE EXCEPTION 'pricing schedule became effective before commit' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER pricing_policy_schedule_not_late AFTER INSERT ON zzsh_supply.pricing_policy_schedule
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_pricing_schedule_not_late();
CREATE CONSTRAINT TRIGGER pricing_mode_schedule_not_late AFTER INSERT ON zzsh_supply.pricing_mode_schedule
DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_pricing_schedule_not_late();
COMMENT ON FUNCTION zzsh_supply.guard_pricing_schedule_not_late() IS '防止计划在事务提交前已过生效时间。';

--> statement-breakpoint
-- Contract: system-initial-source
-- Preserve existing admin foreign keys as compatibility references.
-- A source stamp is owned by the direct migration role, immutable, and never backfilled from a Boss id.
CREATE FUNCTION zzsh_iam.guard_system_initial_source() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='UPDATE' THEN
    IF OLD.system_initial_sha256 IS NOT DISTINCT FROM NEW.system_initial_sha256 THEN RETURN NEW; END IF;
    RAISE EXCEPTION 'system initialization source is immutable' USING ERRCODE='40001';
  END IF;
  NEW.system_initial_sha256:=COALESCE(NEW.system_initial_sha256,NULLIF(current_setting('zzsh.system_initial_sha256',true),''));
  IF NEW.system_initial_sha256 IS NOT NULL AND NOT EXISTS(
    SELECT 1 FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner
    WHERE c.oid=TG_RELID AND r.rolname=current_user AND current_user=session_user AND NOT r.rolsuper AND NOT r.rolbypassrls
  ) THEN RAISE EXCEPTION 'system initialization requires the migration owner' USING ERRCODE='42501'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION zzsh_iam.guard_system_initial_source() FROM PUBLIC;
COMMENT ON FUNCTION zzsh_iam.guard_system_initial_source() IS '首次初始化来源仅由独立迁移属主写入，写入后不可更改。';
--> statement-breakpoint
DO $bootstrap_source$
DECLARE target text;
BEGIN
  FOREACH target IN ARRAY ARRAY[
    'zzsh_supply.price_version','zzsh_supply.term_version','zzsh_supply.agreement_version',
    'zzsh_supply.full_payout_terms_version','zzsh_supply.rule_release',
    'zzsh_content.content_item','zzsh_content.content_version','zzsh_content.help_tree_node','zzsh_content.legal_document_version'
  ] LOOP
    EXECUTE format('ALTER TABLE %s ADD COLUMN system_initial_sha256 text CHECK (system_initial_sha256 ~ %L)',target,'^[a-f0-9]{64}$');
    EXECUTE format('COMMENT ON COLUMN %s.system_initial_sha256 IS %L',target,'系统首次初始化确认包摘要；非空时初始管理员外键仅作兼容引用。');
    EXECUTE format('CREATE TRIGGER system_initial_source_guard BEFORE INSERT OR UPDATE OF system_initial_sha256 ON %s FOR EACH ROW EXECUTE FUNCTION zzsh_iam.guard_system_initial_source()',target);
  END LOOP;
END $bootstrap_source$;

--> statement-breakpoint
-- Contract: rule-release-schedule
-- Rule-release schedules follow price schedules and system initialization provenance.
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

--> statement-breakpoint
-- Contract: personal-order-contract
-- Do not enable v5 inserts until the final-funding and posting guards
-- use this same contract and the complete migration is exercised with runtime ACLs.
-- This v5-only identity/funding verifier mirrors 0078 exactly except for the separately bound listing price.
DO $check$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_class c ON c.oid=to_regclass('zzsh_order.rental_order')
    WHERE p.oid=to_regprocedure('zzsh_order.assert_personal_growth_order_v4(zzsh_order.rental_order)')
      AND p.proowner=c.relowner AND NOT p.prosecdef
      AND encode(sha256(convert_to(replace(p.prosrc,E'\r\n',E'\n'),'UTF8')),'hex')='96c5c3783b5b94db1e3aabf7e7d4a88e74183c06291fc03fe00e550b39f3c8a4')
  THEN RAISE EXCEPTION 'personal quote v4 base contract changed' USING ERRCODE='40001'; END IF;
END $check$;
CREATE FUNCTION zzsh_order.assert_personal_growth_for_fixed_fee_v5(n zzsh_order.rental_order, expected_listing_price_id text)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE p jsonb:=n.quote_snapshot->'personal';g jsonb;b jsonb;f jsonb;r jsonb;d jsonb;v zzsh_supply.listing_version;k int;
BEGIN
 g:=p->'membershipGrowth';b:=g->'binding';f:=p->'funding';r:=p->'ruleRefs';d:=p->'fullPayoutDeclaration';
 IF n.confirmation_id IS NULL OR n.quote_snapshot->>'quoteKind' IS DISTINCT FROM 'ORDER_CONFIRMATION' OR n.quote_snapshot->>'confirmationId' IS DISTINCT FROM n.confirmation_id::text
  OR n.quote_snapshot->>'orderSnapshotSchema' IS DISTINCT FROM '1' OR COALESCE(n.quote_snapshot->>'confirmationDigest','')!~'^[a-f0-9]{64}$'
  OR p->>'schema' IS DISTINCT FROM 'personal-quote-v4' OR n.quote_snapshot?'confirmationToken' OR n.quote_snapshot?'signature'
  OR p?'membership' OR p->>'userId' IS DISTINCT FROM n.renter_user_id OR p->>'ownerUserId' IS DISTINCT FROM n.owner_user_id OR p->>'accountId' IS DISTINCT FROM n.account_id
  OR p->>'listingVersionId' IS DISTINCT FROM n.listing_version_id OR p->>'listingHash' IS DISTINCT FROM n.content_hash OR n.quote_snapshot->>'listingHash' IS DISTINCT FROM n.content_hash
  OR jsonb_typeof(p) IS DISTINCT FROM 'object' OR jsonb_typeof(g) IS DISTINCT FROM 'object' OR jsonb_typeof(b) IS DISTINCT FROM 'object'
  OR jsonb_typeof(f) IS DISTINCT FROM 'object' OR jsonb_typeof(r) IS DISTINCT FROM 'object' OR jsonb_typeof(d) IS DISTINCT FROM 'object'
 THEN RAISE EXCEPTION 'personal quote v4 binding invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(p);
 IF k<>11 OR EXISTS(SELECT 1 FROM jsonb_object_keys(p) x WHERE NOT(x=ANY(ARRAY['schema','userId','ownerUserId','accountId','listingVersionId','listingHash','fullPayoutDeclaration','ruleRefs','membershipGrowth','guarantee','funding'])))
  THEN RAISE EXCEPTION 'personal quote v4 shape invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(d);
 IF k<>2 OR d->>'schema' IS DISTINCT FROM 'full-payout-declaration-v1' OR jsonb_typeof(d->'selected') IS DISTINCT FROM 'boolean'
  THEN RAISE EXCEPTION 'personal quote v4 declaration invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(r);
 IF k<>5 OR EXISTS(SELECT 1 FROM jsonb_object_keys(r) x WHERE NOT(x=ANY(ARRAY['releaseId','priceVersionId','termVersionId','agreementVersionId','agreementDigest'])))
  OR EXISTS(SELECT 1 FROM jsonb_each(r) x WHERE jsonb_typeof(x.value)<>'string' OR length(trim(x.value#>>'{}'))=0)
  OR r->>'releaseId' IS DISTINCT FROM n.rule_release_id OR r->>'priceVersionId' IS DISTINCT FROM n.quote_snapshot->>'priceVersionId' OR COALESCE(r->>'agreementDigest','')!~'^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'personal quote v4 rules invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(f);
 IF k<>7 OR EXISTS(SELECT 1 FROM jsonb_object_keys(f) x WHERE NOT(x=ANY(ARRAY['version','sourceRef','baseDepositCents','publisherBailRequirementCents','fullPayoutPolicyRef','fullPayoutPolicyVersion','disclosureVersion'])))
  OR EXISTS(SELECT 1 FROM jsonb_each(f) x WHERE jsonb_typeof(x.value)<>'string' OR length(trim(x.value#>>'{}'))=0)
  OR COALESCE(f->>'baseDepositCents','')!~'^(0|[1-9][0-9]{0,17})$' OR COALESCE(f->>'publisherBailRequirementCents','')!~'^(0|[1-9][0-9]{0,17})$'
  THEN RAISE EXCEPTION 'personal quote v4 funding invalid' USING ERRCODE='40001';END IF;
 IF jsonb_typeof(p->'guarantee') IS DISTINCT FROM 'object' OR COALESCE(p#>>'{guarantee,status}','') NOT IN('SATISFIED','NOT_REQUIRED') OR COALESCE(p#>>'{guarantee,reference}','')=''
  THEN RAISE EXCEPTION 'personal quote v4 guarantee invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(p->'guarantee');IF k<>2 THEN RAISE EXCEPTION 'personal quote v4 guarantee shape invalid' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(g);
 IF k<>16 OR EXISTS(SELECT 1 FROM jsonb_object_keys(g) x WHERE NOT(x=ANY(ARRAY['schema','policyVersion','effectiveTier','policyTier','selectedSource','depositSource','entitlementIds','binding','selectedBenefitVersion','selectedEntitlementId','selectedValidUntil','depositBenefitVersion','depositEntitlementId','depositValidUntil','pricePlanDigest','depositCents'])))
  OR g->>'schema' IS DISTINCT FROM 'membership-growth-v2' OR COALESCE(g->>'policyVersion','')!~'^[1-9][0-9]{0,18}$'
  OR COALESCE(g->>'effectiveTier','') NOT IN('STANDARD','SILVER','GOLD','PLATINUM','DIAMOND','BLACK_GOLD')
  OR g->>'policyTier' IS DISTINCT FROM(CASE WHEN g->>'effectiveTier'='BLACK_GOLD' THEN 'DIAMOND' ELSE g->>'effectiveTier' END)
  OR COALESCE(g->>'selectedSource','') NOT IN('GROWTH','FRIEND','PRESTIGE') OR COALESCE(g->>'depositSource','') NOT IN('GROWTH','FRIEND','PRESTIGE')
  OR COALESCE(g->>'selectedBenefitVersion','')='' OR COALESCE(g->>'depositBenefitVersion','')='' OR COALESCE(g->>'pricePlanDigest','')!~'^[a-f0-9]{64}$'
  OR jsonb_typeof(g->'entitlementIds') IS DISTINCT FROM 'array' OR COALESCE(g->>'depositCents','')!~'^(0|[1-9][0-9]{0,23})$'
  THEN RAISE EXCEPTION 'personal quote v4 growth invalid' USING ERRCODE='40001';END IF;
 IF jsonb_typeof(g->'selectedEntitlementId') NOT IN('null','string') OR jsonb_typeof(g->'depositEntitlementId') NOT IN('null','string') OR jsonb_typeof(g->'selectedValidUntil') NOT IN('null','string') OR jsonb_typeof(g->'depositValidUntil') NOT IN('null','string')
  OR EXISTS(SELECT 1 FROM jsonb_array_elements(g->'entitlementIds') e WHERE jsonb_typeof(e)<>'string' OR COALESCE(e#>>'{}','')='')
  OR EXISTS(SELECT 1 FROM (SELECT x.source,x.ref,x.until FROM(VALUES(g->>'selectedSource',g->>'selectedEntitlementId',g->>'selectedValidUntil'),(g->>'depositSource',g->>'depositEntitlementId',g->>'depositValidUntil'))x(source,ref,until))z
    WHERE(z.source='GROWTH' AND(z.ref IS NOT NULL OR z.until IS NOT NULL)) OR(z.source<>'GROWTH' AND(z.ref IS NULL OR z.until IS NULL OR NOT(g->'entitlementIds'?z.ref) OR z.until::timestamptz<=clock_timestamp())))
  THEN RAISE EXCEPTION 'personal quote v4 entitlement invalid or expired' USING ERRCODE='40001';END IF;
 SELECT count(*) INTO k FROM jsonb_object_keys(b);
 IF k<>6 OR b->>'userId' IS DISTINCT FROM n.renter_user_id OR b->>'ownerUserId' IS DISTINCT FROM n.owner_user_id OR b->>'accountId' IS DISTINCT FROM n.account_id
  OR b->>'listingVersionId' IS DISTINCT FROM n.listing_version_id OR b->>'ruleReleaseId' IS DISTINCT FROM n.rule_release_id OR COALESCE(b->>'quantityDigest','')!~'^[a-f0-9]{64}$'
  THEN RAISE EXCEPTION 'personal quote v4 offer binding invalid' USING ERRCODE='40001';END IF;
 IF n.quote_snapshot->>'currency' IS DISTINCT FROM 'CNY' OR n.currency IS DISTINCT FROM 'CNY' OR n.quote_snapshot->>'ruleReleaseId' IS DISTINCT FROM n.rule_release_id OR n.quote_snapshot->>'termSeconds' IS DISTINCT FROM n.term_seconds::text
  OR n.quote_snapshot#>>'{tenantDeposit,currency}' IS DISTINCT FROM 'CNY' OR n.quote_snapshot#>>'{tenantDeposit,unit}' IS DISTINCT FROM 'yuan' OR n.quote_snapshot#>>'{tenantDeposit,scale}' IS DISTINCT FROM '2'
  OR COALESCE(n.quote_snapshot#>>'{tenantDeposit,amount}','')!~'^(0|[1-9][0-9]*)\.[0-9]{2}$' OR(n.quote_snapshot#>>'{tenantDeposit,amount}')::numeric*100 IS DISTINCT FROM n.deposit_amount_cents
  OR n.quote_snapshot#>>'{resourceTotal,currency}' IS DISTINCT FROM 'CNY' OR n.quote_snapshot#>>'{resourceTotal,unit}' IS DISTINCT FROM 'yuan' OR n.quote_snapshot#>>'{resourceTotal,scale}' IS DISTINCT FROM '2'
  OR COALESCE(n.quote_snapshot#>>'{resourceTotal,amount}','')!~'^(0|[1-9][0-9]*)\.[0-9]{2}$' OR(g->>'depositCents')::numeric IS DISTINCT FROM n.deposit_amount_cents OR(n.quote_snapshot#>>'{resourceTotal,amount}')::numeric*100 IS DISTINCT FROM n.rental_amount_cents
  THEN RAISE EXCEPTION 'personal quote v4 quote amounts invalid' USING ERRCODE='40001';END IF;
 SELECT * INTO v FROM zzsh_supply.listing_version WHERE id=n.listing_version_id AND account_id=n.account_id AND content_hash=n.content_hash AND rule_release_id=n.rule_release_id;
 IF NOT FOUND OR v.payload->>'accountId' IS DISTINCT FROM n.account_id OR v.payload->>'gameId' IS DISTINCT FROM n.game_id
  OR v.payload#>>'{ruleRefs,releaseId}' IS DISTINCT FROM r->>'releaseId' OR v.payload#>>'{ruleRefs,priceVersionId}' IS DISTINCT FROM r->>'priceVersionId'
  OR v.payload#>>'{ruleRefs,termVersionId}' IS DISTINCT FROM r->>'termVersionId' OR v.payload#>>'{ruleRefs,agreementVersionId}' IS DISTINCT FROM r->>'agreementVersionId'
  OR v.payload#>>'{ruleRefs,agreementDigest}' IS DISTINCT FROM r->>'agreementDigest' OR v.payload#>'{declaration,attributes,full_payout_declaration}' IS DISTINCT FROM d
  OR v.payload#>>'{quoteValues,priceVersionId}' IS DISTINCT FROM expected_listing_price_id OR v.payload#>>'{quoteValues,termSeconds}' IS DISTINCT FROM n.term_seconds::text
  OR b->>'quantityDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(v.payload#>'{quoteValues,lines}'),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'personal quote v4 listing reference invalid' USING ERRCODE='40001';END IF;
 IF COALESCE(n.quote_snapshot->>'confirmationExpiresAt','')!~'^[1-9][0-9]{0,11}$' OR(n.quote_snapshot->>'confirmationExpiresAt')::numeric<=extract(epoch FROM clock_timestamp())
  THEN RAISE EXCEPTION 'personal confirmation expired' USING ERRCODE='40001';END IF;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.assert_personal_growth_for_fixed_fee_v5(zzsh_order.rental_order,text) FROM PUBLIC;
COMMENT ON FUNCTION zzsh_order.assert_personal_growth_for_fixed_fee_v5(zzsh_order.rental_order,text)
  IS '固定手续费复用旧版身份与条款约束，单独核对已验证的上架价格版本。';
--> statement-breakpoint

CREATE FUNCTION zzsh_order.assert_fixed_fee_personal_order_v5(n zzsh_order.rental_order)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  p jsonb:=n.quote_snapshot->'personal';
  policy jsonb; basis jsonb:=n.quote_snapshot->'settlementPricing'; quote jsonb;
  v zzsh_supply.listing_version; shadow zzsh_order.rental_order;
  effective record; old_policy record; choice jsonb; conditions jsonb;
  mode_value text; base_ratio numeric; ratio_value numeric; rate numeric; payable numeric;
  gross numeric; owner_total numeric; buyer_total numeric; platform_total numeric; expected_fee numeric;
  line_count integer; mismatch boolean; parts jsonb; entry jsonb;
  ids text[]:=ARRAY[]::text[]; bases numeric[]:=ARRAY[]::numeric[]; buyers numeric[]:=ARRAY[]::numeric[];
  capacity numeric[]:=ARRAY[]::numeric[]; discounts numeric[]:=ARRAY[]::numeric[]; take numeric[];
  remaining numeric; weight numeric; taken numeric; remaining_before numeric; i integer; chosen integer; attempts integer;
  haff_line jsonb; exact jsonb; raw_num numeric; raw_den numeric; owner_num numeric; owner_den numeric;
  buyer_num numeric; buyer_den numeric; haff_owner numeric; haff_buyer numeric; haff_base numeric;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->>'schema' IS DISTINCT FROM 'personal-quote-v5'
    OR jsonb_typeof(basis) IS DISTINCT FROM 'object' OR basis->>'schema' IS DISTINCT FROM 'settlement-pricing-v3'
    OR basis-ARRAY['schema','priceVersionId','payableRatio','fixedFeeRate','haff','items'] <> '{}'::jsonb
    OR NOT(basis ?& ARRAY['schema','priceVersionId','payableRatio','fixedFeeRate','haff','items'])
    OR jsonb_typeof(basis->'fixedFeeRate') IS DISTINCT FROM 'string' OR jsonb_typeof(basis->'payableRatio') IS DISTINCT FROM 'string'
    OR n.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '4' OR n.quote_snapshot->>'mode' IS DISTINCT FROM 'PERCENT'
    OR n.quote_snapshot#>>'{pricingInputs,fixedFeeAlgorithm}' IS DISTINCT FROM 'FIXED_TOTAL_V1'
    OR n.quote_snapshot#>>'{pricingInputs,haffRatioSchema}' IS DISTINCT FROM 'haff-ratio-v3'
    OR jsonb_typeof(n.quote_snapshot#>'{pricingInputs,fixedFeeGrossCents}') IS DISTINCT FROM 'string'
    OR COALESCE(n.quote_snapshot#>>'{pricingInputs,fixedFeeGrossCents}','') !~ '^(0|[1-9][0-9]{0,23})$'
  THEN RAISE EXCEPTION 'fixed fee order snapshot invalid' USING ERRCODE='40001'; END IF;

  policy:=p->'pricingPolicy';
  IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
    OR policy - ARRAY['schema','pricingModel','scheduleId','generation','effectiveAt','priceVersionId'] <> '{}'::jsonb
    OR NOT(policy ?& ARRAY['schema','pricingModel','scheduleId','generation','effectiveAt','priceVersionId'])
    OR EXISTS(SELECT 1 FROM jsonb_each(policy) entry WHERE jsonb_typeof(entry.value)<>'string')
    OR policy->>'schema' IS DISTINCT FROM 'pricing-policy-v1' OR policy->>'pricingModel' IS DISTINCT FROM 'FIXED_FEE'
    OR COALESCE(policy->>'scheduleId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR COALESCE(policy->>'priceVersionId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR COALESCE(policy->>'generation','') !~ '^[1-9][0-9]{0,18}$'
    OR jsonb_typeof(policy->'effectiveAt') IS DISTINCT FROM 'string'
  THEN RAISE EXCEPTION 'fixed fee policy reference invalid' USING ERRCODE='40001'; END IF;

  SELECT lv.* INTO v FROM zzsh_supply.listing_version lv
    JOIN zzsh_supply.listing_publication pub ON pub.version_id=lv.id AND pub.account_id=lv.account_id
      AND pub.owner_user_id=n.owner_user_id AND pub.game_id=n.game_id AND pub.rule_release_id=n.rule_release_id
      AND pub.content_hash=n.content_hash AND pub.source='OWNER_DIRECT'
    WHERE lv.id=n.listing_version_id AND lv.account_id=n.account_id AND lv.content_hash=n.content_hash AND lv.rule_release_id=n.rule_release_id
      AND lv.review_state='PUBLISHED'
      AND (lv.payload#>>'{pricingPolicy,effectiveAt}')::timestamptz<=pub.published_at;
  IF NOT FOUND OR v.origin IS DISTINCT FROM 'NATIVE' OR v.schema_version IS DISTINCT FROM 4
    OR v.payload->>'schemaVersion' IS DISTINCT FROM '4' OR v.payload#>>'{quoteValues,schemaVersion}' IS DISTINCT FROM '4'
    OR v.payload#>>'{pricingPolicy,schema}' IS DISTINCT FROM 'pricing-policy-v1'
    OR v.payload#>>'{pricingPolicy,pricingModel}' IS DISTINCT FROM 'FIXED_FEE'
  THEN RAISE EXCEPTION 'fixed fee listing reference invalid' USING ERRCODE='40001'; END IF;
  SELECT s.id,s.generation,s.effective_at,s.price_version_id INTO old_policy
    FROM zzsh_supply.pricing_policy_schedule s
   WHERE s.id=v.payload#>>'{pricingPolicy,scheduleId}' AND s.game_id=n.game_id AND s.pricing_model='FIXED_FEE';
  IF NOT FOUND OR old_policy.generation::text IS DISTINCT FROM v.payload#>>'{pricingPolicy,generation}'
    OR old_policy.effective_at IS DISTINCT FROM (v.payload#>>'{pricingPolicy,effectiveAt}')::timestamptz
    OR old_policy.price_version_id IS DISTINCT FROM v.payload#>>'{pricingPolicy,priceVersionId}'
    OR old_policy.price_version_id IS DISTINCT FROM v.payload#>>'{quoteValues,priceVersionId}'
  THEN RAISE EXCEPTION 'fixed fee original listing policy invalid' USING ERRCODE='40001'; END IF;

  SELECT s.id,s.generation,s.effective_at,s.price_version_id,pv.haff_rule,pv.fixed_fee_rates,pv.rounding_policy
    INTO effective
    FROM zzsh_supply.pricing_policy_schedule s JOIN zzsh_supply.price_version pv ON pv.id=s.price_version_id
   WHERE s.id=old_policy.id AND policy IS NOT DISTINCT FROM v.payload->'pricingPolicy'
     AND pv.game_id=n.game_id AND pv.status='SEALED' AND pv.mode='PERCENT'
     AND zzsh_supply.valid_fixed_fee_rates(pv.fixed_fee_rates) AND zzsh_supply.valid_fixed_fee_haff_rule(pv.haff_rule);
  IF NOT FOUND OR effective.id IS DISTINCT FROM policy->>'scheduleId'
    OR effective.generation::text IS DISTINCT FROM policy->>'generation'
    OR effective.effective_at IS DISTINCT FROM (policy->>'effectiveAt')::timestamptz
    OR effective.price_version_id IS DISTINCT FROM policy->>'priceVersionId'
    OR effective.price_version_id IS DISTINCT FROM n.quote_snapshot->>'priceVersionId'
    OR basis->>'priceVersionId' IS DISTINCT FROM effective.price_version_id
    OR n.quote_snapshot->>'roundingPolicy' IS DISTINCT FROM effective.rounding_policy
  THEN RAISE EXCEPTION 'fixed fee published policy differs' USING ERRCODE='40001'; END IF;

  choice:=v.payload#>'{declaration,attributes,rentalPricing}';
  conditions:=n.quote_snapshot#>'{pricingInputs,conditions}';
  mode_value:=choice->>'rentalMode';
  IF mode_value NOT IN ('ordinary','custom','fast') OR mode_value IS NULL
    OR n.quote_snapshot#>>'{pricingInputs,compatibility,rentalMode}' IS DISTINCT FROM mode_value
    OR n.quote_snapshot#>>'{pricingInputs,compatibility,customerTier}' IS DISTINCT FROM 'STANDARD'
    OR n.quote_snapshot#>>'{pricingInputs,compatibility,memberDelta}' IS DISTINCT FROM '0'
    OR effective.haff_rule#>>ARRAY['fixedModes',mode_value,'enabled'] IS DISTINCT FROM 'true'
    OR conditions->>'safeBoxCode' IS DISTINCT FROM v.payload#>>'{declaration,attributes,safe_box_code}'
    OR conditions->>'vitLevel' IS DISTINCT FROM COALESCE(v.payload#>>'{declaration,attributes,vit_level}',v.payload#>>'{declaration,attributes,vitLevel}')
    OR conditions->>'bearLevel' IS DISTINCT FROM COALESCE(v.payload#>>'{declaration,attributes,bear_level}',v.payload#>>'{declaration,attributes,bearLevel}')
    OR conditions->>'termOptionCode' IS DISTINCT FROM v.payload#>>'{declaration,termOptionCode}'
  THEN RAISE EXCEPTION 'fixed fee rental selection invalid' USING ERRCODE='40001'; END IF;
  base_ratio:=(effective.haff_rule#>>ARRAY['baseBySafeBox',conditions->>'safeBoxCode'])::numeric
    +(effective.haff_rule#>>ARRAY['vitalityDeltaByLevel',conditions->>'vitLevel'])::numeric
    +(effective.haff_rule#>>ARRAY['bearDeltaByLevel',conditions->>'bearLevel'])::numeric
    +(effective.haff_rule#>>ARRAY['dailyDeltaByTermOption',conditions->>'termOptionCode'])::numeric;
  ratio_value:=CASE WHEN mode_value='ordinary' THEN base_ratio ELSE (choice->>'ownerRatioB')::numeric END;
  rate:=(effective.fixed_fee_rates->>mode_value)::numeric;
  IF COALESCE(basis->>'payableRatio','') !~ '^(0|1)(\.[0-9]{1,8})?$' THEN
    RAISE EXCEPTION 'fixed fee discount invalid' USING ERRCODE='40001';
  END IF;
  payable:=(basis->>'payableRatio')::numeric;
  IF base_ratio IS NULL OR base_ratio<=0 OR ratio_value IS NULL OR ratio_value<=0
    OR (n.quote_snapshot#>>'{pricingInputs,compatibility,baseRatioC}')::numeric IS DISTINCT FROM base_ratio
    OR (n.quote_snapshot#>>'{pricingInputs,compatibility,ownerRatioB}')::numeric IS DISTINCT FROM ratio_value
    OR (n.quote_snapshot#>>'{pricingInputs,denominators,buyer}')::numeric IS DISTINCT FROM ratio_value
    OR (n.quote_snapshot#>>'{pricingInputs,denominators,owner}')::numeric IS DISTINCT FROM ratio_value
    OR (n.quote_snapshot#>>'{pricingInputs,commissionRate}')::numeric IS DISTINCT FROM rate
    OR (basis->>'fixedFeeRate')::numeric IS DISTINCT FROM rate
    OR payable IS NULL OR payable<=0 OR payable>1 OR 1-payable>rate
  THEN RAISE EXCEPTION 'fixed fee ratio or discount invalid' USING ERRCODE='40001'; END IF;

  quote:=n.quote_snapshot-ARRAY['quoteKind','orderSnapshotSchema','confirmationId','confirmationDigest','confirmationExpiresAt',
    'listingHash','personal','settlementPricing','agreementAcceptanceSchema','agreementAcceptance','earlySettlementDisclosure','fullPayoutTermsAcceptance'];
  IF quote-ARRAY['schemaVersion','currency','priceVersionId','ruleReleaseId','mode','lines','resourceTotal','ownerTotal','platformFullProfit',
    'tenantDeposit','publisherBailRequirement','termSeconds','expiryDisclosures','unitAmountsInformational','roundingPolicy','pricingInputs'] <> '{}'::jsonb
    OR NOT(quote ?& ARRAY['schemaVersion','currency','priceVersionId','ruleReleaseId','mode','lines','resourceTotal','ownerTotal','platformFullProfit',
      'tenantDeposit','publisherBailRequirement','termSeconds','expiryDisclosures','unitAmountsInformational','roundingPolicy','pricingInputs'])
    OR n.quote_snapshot->>'confirmationDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(
      p||jsonb_build_object('quote',quote,'settlementPricing',basis)),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'fixed fee confirmation digest invalid' USING ERRCODE='40001'; END IF;

  -- Reuse the existing identity, entitlement, original terms and funding checks;
  -- the temporary value never replaces the v5 snapshot stored on the order.
  shadow:=n;
  shadow.quote_snapshot:=jsonb_set(jsonb_set(n.quote_snapshot,'{personal}',(p-'pricingPolicy')||jsonb_build_object('schema','personal-quote-v4')),
    '{priceVersionId}',to_jsonb(p#>>'{ruleRefs,priceVersionId}'));
  PERFORM zzsh_order.assert_personal_growth_for_fixed_fee_v5(shadow,old_policy.price_version_id);

  IF jsonb_typeof(quote->'lines') IS DISTINCT FROM 'array' OR jsonb_typeof(basis->'items') IS DISTINCT FROM 'array'
    OR jsonb_array_length(quote->'lines')<1 OR jsonb_array_length(quote->'lines')>64 OR jsonb_array_length(basis->'items')>63
  THEN RAISE EXCEPTION 'fixed fee lines invalid' USING ERRCODE='40001'; END IF;
  SELECT count(*),count(*)<>count(DISTINCT line->>'itemId') OR count(*) FILTER (WHERE line->>'pricingKind'='HAFF_RATIO')<>1
    OR bool_or(COALESCE(line->>'itemId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      OR jsonb_typeof(line->'itemId') IS DISTINCT FROM 'string' OR jsonb_typeof(line->'quantity') IS DISTINCT FROM 'string'
      OR jsonb_typeof(line->'unitQuantity') IS DISTINCT FROM 'string' OR jsonb_typeof(line->'unit') IS DISTINCT FROM 'string'
      OR jsonb_typeof(line->'pricingKind') IS DISTINCT FROM 'string'
      OR COALESCE(line->>'quantity','') !~ '^(0|[1-9][0-9]{0,23})$'
      OR COALESCE(line->>'unitQuantity','') !~ '^[1-9][0-9]{0,23}$'
      OR EXISTS(SELECT 1 FROM unnest(ARRAY['buyerAmount','ownerAmount','platformAmount','buyerUnitAmount','ownerUnitAmount']) k
        WHERE jsonb_typeof(line->k) IS DISTINCT FROM 'object' OR line#>>ARRAY[k,'currency'] IS DISTINCT FROM 'CNY'
          OR line#>>ARRAY[k,'unit'] IS DISTINCT FROM 'yuan' OR jsonb_typeof(line#>ARRAY[k,'amount']) IS DISTINCT FROM 'string'
          OR line#>>ARRAY[k,'scale'] IS DISTINCT FROM CASE WHEN k IN ('buyerUnitAmount','ownerUnitAmount') THEN '8' ELSE '2' END)
      OR COALESCE(line#>>'{buyerAmount,amount}','') !~ '^(0|[1-9][0-9]*)\.[0-9]{2}$'
      OR COALESCE(line#>>'{ownerAmount,amount}','') !~ '^(0|[1-9][0-9]*)\.[0-9]{2}$'
      OR COALESCE(line#>>'{platformAmount,amount}','') !~ '^(0|[1-9][0-9]*)\.[0-9]{2}$')
    INTO line_count,mismatch FROM jsonb_array_elements(quote->'lines') line;
  IF mismatch THEN RAISE EXCEPTION 'fixed fee line shape invalid' USING ERRCODE='40001'; END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(quote->'lines') q FULL JOIN jsonb_array_elements(v.payload#>'{quoteValues,lines}') original
      ON q->>'itemId'=original->>'itemId'
     WHERE q IS NULL OR original IS NULL OR q->>'quantity' IS DISTINCT FROM original->>'quantity'
       OR q->>'unit' IS DISTINCT FROM original->>'unit' OR q->>'pricingKind' IS DISTINCT FROM original->>'pricingKind'
  ) OR line_count<>jsonb_array_length(v.payload#>'{quoteValues,lines}') THEN
    RAISE EXCEPTION 'fixed fee listing quantities changed' USING ERRCODE='40001';
  END IF;
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(quote->'lines') q
    LEFT JOIN zzsh_supply.price_line l ON l.price_version_id=effective.price_version_id AND l.customer_tier='STANDARD' AND l.item_id=q->>'itemId'
    LEFT JOIN zzsh_supply.billable_item i ON i.id=l.item_id AND i.game_id=n.game_id
    WHERE l.id IS NULL OR i.id IS NULL OR l.pricing_kind IS DISTINCT FROM q->>'pricingKind' OR i.unit IS DISTINCT FROM q->>'unit'
      OR (l.pricing_kind='FIXED_UNIT' AND (l.owner_unit_amount IS NOT NULL OR l.buyer_unit_amount IS NULL
        OR l.unit_quantity IS DISTINCT FROM (q->>'unitQuantity')::numeric
        OR l.buyer_unit_amount IS DISTINCT FROM (q#>>'{buyerUnitAmount,amount}')::numeric
        OR l.buyer_unit_amount IS DISTINCT FROM (q#>>'{ownerUnitAmount,amount}')::numeric))
      OR (l.pricing_kind='HAFF_RATIO' AND (q->>'unit' IS DISTINCT FROM 'HAFF_BASE' OR q->>'unitQuantity' IS DISTINCT FROM '1000000'
        OR (q->>'quantity')::numeric<=0))
  ) THEN RAISE EXCEPTION 'fixed fee current unit prices invalid' USING ERRCODE='40001'; END IF;

  IF jsonb_typeof(basis->'haff') IS DISTINCT FROM 'object'
    OR (basis->'haff')-ARRAY['itemId','openingQuantity','buyerNumerator','buyerDenominator'] <> '{}'::jsonb
    OR NOT ((basis->'haff') ?& ARRAY['itemId','openingQuantity','buyerNumerator','buyerDenominator'])
    OR COALESCE(basis#>>'{haff,buyerNumerator}','') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$'
    OR COALESCE(basis#>>'{haff,buyerDenominator}','') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$'
    OR (basis#>>'{haff,buyerDenominator}')::numeric<=0
    OR NOT EXISTS (SELECT 1 FROM jsonb_array_elements(quote->'lines') q
      WHERE q->>'pricingKind'='HAFF_RATIO' AND q->>'itemId'=basis#>>'{haff,itemId}'
        AND q->>'quantity'=basis#>>'{haff,openingQuantity}'
        AND (basis#>>'{haff,buyerNumerator}')::numeric*1000000*ratio_value
          =(q->>'quantity')::numeric*100*(basis#>>'{haff,buyerDenominator}')::numeric)
  THEN RAISE EXCEPTION 'fixed fee original haff price invalid' USING ERRCODE='40001'; END IF;
  IF (SELECT count(*)<>count(DISTINCT item->>'itemId') FROM jsonb_array_elements(basis->'items') item)
    OR EXISTS (SELECT 1 FROM jsonb_array_elements(basis->'items') item
      WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
        OR item-ARRAY['itemId','name','unit','unitQuantity','buyerUnitAmount','ownerUnitAmount'] <> '{}'::jsonb
        OR NOT(item ?& ARRAY['itemId','name','unit','unitQuantity','buyerUnitAmount','ownerUnitAmount']))
    OR EXISTS (
      SELECT 1 FROM jsonb_array_elements(basis->'items') frozen FULL JOIN (
        SELECT l.item_id,l.unit_quantity,l.buyer_unit_amount,l.owner_unit_amount,i.unit
          FROM zzsh_supply.price_line l JOIN zzsh_supply.billable_item i ON i.id=l.item_id AND i.game_id=n.game_id
         WHERE l.price_version_id=effective.price_version_id AND l.customer_tier='STANDARD' AND l.pricing_kind='FIXED_UNIT'
           AND (i.enabled OR EXISTS(SELECT 1 FROM jsonb_array_elements(quote->'lines') q WHERE q->>'itemId'=l.item_id))
      ) line ON line.item_id=frozen->>'itemId'
      WHERE frozen IS NULL OR line.item_id IS NULL OR line.owner_unit_amount IS NOT NULL OR line.buyer_unit_amount IS NULL
        OR frozen->>'unit' IS DISTINCT FROM line.unit OR (frozen->>'unitQuantity')::numeric IS DISTINCT FROM line.unit_quantity
        OR (frozen->>'buyerUnitAmount')::numeric IS DISTINCT FROM line.buyer_unit_amount
        OR (frozen->>'ownerUnitAmount')::numeric IS DISTINCT FROM line.buyer_unit_amount
    )
  THEN RAISE EXCEPTION 'fixed fee original item prices invalid' USING ERRCODE='40001'; END IF;

  -- div truncates the exact rational result; numeric / can round before the final cent rounding.
  WITH rows AS (
    SELECT q,q->>'itemId' AS item_id,
      CASE WHEN q->>'pricingKind'='HAFF_RATIO' THEN div((q->>'quantity')::numeric*20000+1000000*ratio_value,2000000*ratio_value)
      ELSE div((q->>'quantity')::numeric*(q#>>'{buyerUnitAmount,amount}')::numeric*200+(q->>'unitQuantity')::numeric,2*(q->>'unitQuantity')::numeric) END AS base,
      (q#>>'{buyerAmount,amount}')::numeric*100 AS buyer,
      (q#>>'{ownerAmount,amount}')::numeric*100 AS owner,
      (q#>>'{platformAmount,amount}')::numeric*100 AS platform
    FROM jsonb_array_elements(quote->'lines') q
  ), totals AS (SELECT *,sum(base) OVER () AS total FROM rows), shares AS (
    SELECT *,round(total*rate) AS fee,CASE WHEN total=0 THEN 0 ELSE div(base*round(total*rate),total) END AS share,
      CASE WHEN total=0 THEN 0 ELSE mod(base*round(total*rate),total) END AS remainder FROM totals
  ), ranked AS (
    SELECT *,sum(share) OVER () AS shares,row_number() OVER (ORDER BY remainder DESC,item_id COLLATE "C") AS rank FROM shares
  )
  SELECT COALESCE(sum(base),0),COALESCE(sum(owner),0),COALESCE(sum(buyer),0),COALESCE(sum(platform),0),
    COALESCE(bool_or(buyer<owner OR buyer>base OR platform<>buyer-owner
      OR owner<>base-share-CASE WHEN rank<=fee-shares THEN 1 ELSE 0 END),false),
    jsonb_agg(jsonb_build_object('itemId',item_id,'base',base,'owner',owner,'buyer',buyer) ORDER BY item_id COLLATE "C")
    INTO gross,owner_total,buyer_total,platform_total,mismatch,parts FROM ranked;
  expected_fee:=round(gross*rate);
  IF mismatch OR gross IS DISTINCT FROM (quote#>>'{pricingInputs,fixedFeeGrossCents}')::numeric
    OR owner_total IS DISTINCT FROM gross-expected_fee OR buyer_total IS DISTINCT FROM round(gross*payable)
    OR buyer_total IS DISTINCT FROM (quote#>>'{resourceTotal,amount}')::numeric*100
    OR owner_total IS DISTINCT FROM (quote#>>'{ownerTotal,amount}')::numeric*100
    OR platform_total IS DISTINCT FROM (quote#>>'{platformFullProfit,amount}')::numeric*100
    OR platform_total IS DISTINCT FROM buyer_total-owner_total
  THEN RAISE EXCEPTION 'fixed fee quote totals invalid' USING ERRCODE='40001'; END IF;

  -- Verify the same capped, deterministic per-line allocation used at confirmation.
  FOR entry IN SELECT value FROM jsonb_array_elements(parts) LOOP
    ids:=array_append(ids,entry->>'itemId');bases:=array_append(bases,(entry->>'base')::numeric);
    buyers:=array_append(buyers,(entry->>'buyer')::numeric);
    capacity:=array_append(capacity,(entry->>'base')::numeric-(entry->>'owner')::numeric);
    discounts:=array_append(discounts,0::numeric);
  END LOOP;
  remaining:=gross-buyer_total;attempts:=line_count+2;
  WHILE remaining>0 LOOP
    attempts:=attempts-1;
    IF attempts<0 THEN RAISE EXCEPTION 'fixed fee discount allocation invalid' USING ERRCODE='40001'; END IF;
    weight:=0;take:=array_fill(0::numeric,ARRAY[line_count]);
    FOR i IN 1..line_count LOOP IF capacity[i]>0 THEN weight:=weight+bases[i]; END IF; END LOOP;
    taken:=0;
    IF weight>0 THEN
      FOR i IN 1..line_count LOOP
        IF capacity[i]>0 THEN take[i]:=LEAST(div(remaining*bases[i],weight),capacity[i]);taken:=taken+take[i]; END IF;
      END LOOP;
    END IF;
    IF taken>0 THEN
      FOR i IN 1..line_count LOOP discounts[i]:=discounts[i]+take[i];capacity[i]:=capacity[i]-take[i]; END LOOP;
      remaining:=remaining-taken;
    ELSE
      remaining_before:=remaining;
      FOR chosen IN SELECT idx FROM generate_subscripts(capacity,1) idx WHERE capacity[idx]>0
        ORDER BY CASE WHEN weight>0 THEN mod(remaining*bases[idx],weight) ELSE 0 END DESC,bases[idx] DESC,ids[idx] COLLATE "C"
      LOOP
        EXIT WHEN remaining=0;
        discounts[chosen]:=discounts[chosen]+1;capacity[chosen]:=capacity[chosen]-1;remaining:=remaining-1;
      END LOOP;
      IF remaining=remaining_before THEN RAISE EXCEPTION 'fixed fee discount allocation unavailable' USING ERRCODE='40001'; END IF;
    END IF;
  END LOOP;
  FOR i IN 1..line_count LOOP
    IF buyers[i] IS DISTINCT FROM bases[i]-discounts[i] THEN
      RAISE EXCEPTION 'fixed fee line discount allocation invalid' USING ERRCODE='40001';
    END IF;
  END LOOP;
  IF jsonb_typeof(quote#>'{pricingInputs,exactRatios}') IS DISTINCT FROM 'array'
    OR jsonb_array_length(quote#>'{pricingInputs,exactRatios}')<>1
  THEN RAISE EXCEPTION 'fixed fee exact ratio invalid' USING ERRCODE='40001'; END IF;
  exact:=quote#>'{pricingInputs,exactRatios,0}';
  SELECT q INTO haff_line FROM jsonb_array_elements(quote->'lines') q WHERE q->>'pricingKind'='HAFF_RATIO';
  IF jsonb_typeof(exact) IS DISTINCT FROM 'object' OR exact->>'itemId' IS DISTINCT FROM haff_line->>'itemId'
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['buyerNumerator','buyerDenominator','ownerNumerator','ownerDenominator']) key
      WHERE jsonb_typeof(exact->key) IS DISTINCT FROM 'string' OR COALESCE(exact->>key,'') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$')
    OR (exact->>'buyerDenominator')::numeric<=0 OR (exact->>'ownerDenominator')::numeric<=0
  THEN RAISE EXCEPTION 'fixed fee exact ratio invalid' USING ERRCODE='40001'; END IF;
  raw_num:=(haff_line->>'quantity')::numeric*100;raw_den:=1000000*ratio_value;
  haff_owner:=(haff_line#>>'{ownerAmount,amount}')::numeric*100;
  haff_buyer:=(haff_line#>>'{buyerAmount,amount}')::numeric*100;
  haff_base:=div(raw_num*200+raw_den,raw_den*2);
  IF raw_num*100<haff_owner*raw_den THEN owner_num:=raw_num;owner_den:=raw_den;
  ELSE owner_num:=haff_owner;owner_den:=100;END IF;
  IF haff_buyer=haff_base THEN buyer_num:=raw_num;buyer_den:=raw_den;
  ELSIF haff_buyer*owner_den>=100*owner_num THEN buyer_num:=haff_buyer;buyer_den:=100;
  ELSE buyer_num:=owner_num;buyer_den:=owner_den;END IF;
  IF (exact->>'ownerNumerator')::numeric*owner_den IS DISTINCT FROM owner_num*(exact->>'ownerDenominator')::numeric
    OR (exact->>'buyerNumerator')::numeric*buyer_den IS DISTINCT FROM buyer_num*(exact->>'buyerDenominator')::numeric
  THEN RAISE EXCEPTION 'fixed fee exact ratio changed' USING ERRCODE='40001'; END IF;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.assert_fixed_fee_personal_order_v5(zzsh_order.rental_order) FROM PUBLIC;
COMMENT ON FUNCTION zzsh_order.assert_fixed_fee_personal_order_v5(zzsh_order.rental_order)
  IS '校验固定手续费订单的生效政策、原上架和确认快照；不单独启用订单写入。';

--> statement-breakpoint
-- Scheduled spread retains the accepted listing selection while binding the current price separately.
-- New v6 discounts use the stable item-id tie break; earlier v4/v5 snapshots are unchanged.
CREATE FUNCTION zzsh_order.assert_scheduled_spread_order_v6(n zzsh_order.rental_order)
RETURNS void LANGUAGE plpgsql AS $$
DECLARE
  p jsonb:=n.quote_snapshot->'personal'; policy jsonb; basis jsonb:=n.quote_snapshot->'settlementPricing';
  quote jsonb; v zzsh_supply.listing_version; shadow zzsh_order.rental_order; published_at timestamptz;
  old_policy record; effective record; choice jsonb; conditions jsonb; mode_value text;
  base_ratio numeric; owner_ratio numeric; buyer_ratio numeric; spread numeric; payable numeric;
  line_count integer; mismatch boolean; parts jsonb; entry jsonb;
  ids text[]:=ARRAY[]::text[]; bases numeric[]:=ARRAY[]::numeric[]; buyers numeric[]:=ARRAY[]::numeric[];
  owners numeric[]:=ARRAY[]::numeric[]; capacity numeric[]:=ARRAY[]::numeric[]; discounts numeric[]:=ARRAY[]::numeric[];
  remaining numeric; weight numeric; taken numeric; remaining_before numeric; take numeric[]; attempts integer;
  gross numeric; owner_total numeric; buyer_total numeric; platform_total numeric; i integer; chosen integer;
  haff_line jsonb; exact jsonb; owner_num numeric; owner_den numeric; buyer_num numeric; buyer_den numeric; base_haff numeric;
BEGIN
  IF jsonb_typeof(p) IS DISTINCT FROM 'object' OR p->>'schema' IS DISTINCT FROM 'personal-quote-v6'
    OR jsonb_typeof(basis) IS DISTINCT FROM 'object' OR basis->>'schema' IS DISTINCT FROM 'settlement-pricing-v1'
    OR basis-ARRAY['schema','priceVersionId','payableRatio','haff','items'] <> '{}'::jsonb
    OR NOT(basis ?& ARRAY['schema','priceVersionId','payableRatio','haff','items'])
    OR jsonb_typeof(basis->'payableRatio') IS DISTINCT FROM 'string'
    OR n.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '2' OR n.quote_snapshot->>'mode' IS DISTINCT FROM 'SPREAD'
    OR n.quote_snapshot#>>'{pricingInputs,haffRatioSchema}' IS DISTINCT FROM 'haff-ratio-v2'
    OR n.quote_snapshot#>'{pricingInputs,commissionRate}' IS DISTINCT FROM 'null'::jsonb
  THEN RAISE EXCEPTION 'scheduled spread order snapshot invalid' USING ERRCODE='40001'; END IF;

  policy:=p->'pricingPolicy';
  IF jsonb_typeof(policy) IS DISTINCT FROM 'object'
    OR policy-ARRAY['schema','pricingModel','scheduleId','generation','effectiveAt','priceVersionId'] <> '{}'::jsonb
    OR NOT(policy ?& ARRAY['schema','pricingModel','scheduleId','generation','effectiveAt','priceVersionId'])
    OR EXISTS(SELECT 1 FROM jsonb_each(policy) e WHERE jsonb_typeof(e.value)<>'string')
    OR policy->>'schema' IS DISTINCT FROM 'pricing-policy-v1' OR policy->>'pricingModel' IS DISTINCT FROM 'SPREAD'
    OR COALESCE(policy->>'scheduleId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR COALESCE(policy->>'priceVersionId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    OR COALESCE(policy->>'generation','') !~ '^[1-9][0-9]{0,18}$'
  THEN RAISE EXCEPTION 'scheduled spread policy reference invalid' USING ERRCODE='40001'; END IF;

  SELECT lv.* INTO v FROM zzsh_supply.listing_version lv
    JOIN zzsh_supply.listing_publication pub ON pub.version_id=lv.id AND pub.account_id=lv.account_id
      AND pub.owner_user_id=n.owner_user_id AND pub.game_id=n.game_id AND pub.rule_release_id=n.rule_release_id
      AND pub.content_hash=n.content_hash AND pub.source='OWNER_DIRECT'
   WHERE lv.id=n.listing_version_id AND lv.account_id=n.account_id AND lv.content_hash=n.content_hash
     AND lv.rule_release_id=n.rule_release_id AND lv.origin='NATIVE' AND lv.schema_version=2 AND lv.review_state='PUBLISHED';
  IF NOT FOUND OR v.payload->>'schemaVersion' IS DISTINCT FROM '2' OR v.payload#>>'{quoteValues,schemaVersion}' IS DISTINCT FROM '2'
    OR v.payload#>>'{quoteValues,mode}' IS DISTINCT FROM 'SPREAD'
    OR n.content_hash IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(v.payload),'UTF8')),'hex')
  THEN RAISE EXCEPTION 'scheduled spread listing reference invalid' USING ERRCODE='40001'; END IF;
  SELECT pub.published_at INTO published_at FROM zzsh_supply.listing_publication pub
    WHERE pub.version_id=v.id AND pub.account_id=n.account_id AND pub.owner_user_id=n.owner_user_id AND pub.game_id=n.game_id
      AND pub.rule_release_id=n.rule_release_id AND pub.content_hash=n.content_hash AND pub.source='OWNER_DIRECT' LIMIT 1;

  SELECT s.id,s.generation,s.effective_at,s.price_version_id INTO old_policy FROM zzsh_supply.pricing_policy_schedule s
    WHERE s.id=v.payload#>>'{pricingPolicy,scheduleId}' AND s.game_id=n.game_id AND s.pricing_model='SPREAD';
  IF NOT FOUND OR v.payload#>>'{pricingPolicy,schema}' IS DISTINCT FROM 'pricing-policy-v1'
    OR v.payload#>>'{pricingPolicy,pricingModel}' IS DISTINCT FROM 'SPREAD'
    OR old_policy.generation::text IS DISTINCT FROM v.payload#>>'{pricingPolicy,generation}'
    OR old_policy.effective_at IS DISTINCT FROM (v.payload#>>'{pricingPolicy,effectiveAt}')::timestamptz
    OR old_policy.effective_at>published_at OR old_policy.price_version_id IS DISTINCT FROM v.payload#>>'{pricingPolicy,priceVersionId}'
    OR old_policy.price_version_id IS DISTINCT FROM v.payload#>>'{quoteValues,priceVersionId}'
  THEN RAISE EXCEPTION 'scheduled spread original listing policy invalid' USING ERRCODE='40001'; END IF;

  SELECT s.id,s.generation,s.effective_at,s.price_version_id,pv.haff_rule,pv.rounding_policy INTO effective
    FROM zzsh_supply.pricing_policy_schedule s JOIN zzsh_supply.price_version pv ON pv.id=s.price_version_id AND pv.game_id=s.game_id
   WHERE s.id=old_policy.id AND policy IS NOT DISTINCT FROM v.payload->'pricingPolicy'
     AND pv.status='SEALED' AND pv.mode='SPREAD' AND pv.fixed_fee_rates IS NULL AND zzsh_supply.valid_compat_haff_rule(pv.haff_rule);
  IF NOT FOUND OR effective.id IS DISTINCT FROM policy->>'scheduleId' OR effective.generation::text IS DISTINCT FROM policy->>'generation'
    OR effective.effective_at IS DISTINCT FROM (policy->>'effectiveAt')::timestamptz OR effective.price_version_id IS DISTINCT FROM policy->>'priceVersionId'
    OR effective.price_version_id IS DISTINCT FROM n.quote_snapshot->>'priceVersionId' OR basis->>'priceVersionId' IS DISTINCT FROM effective.price_version_id
    OR effective.rounding_policy IS DISTINCT FROM 'HALF_UP_CENT_V1' OR n.quote_snapshot->>'roundingPolicy' IS DISTINCT FROM effective.rounding_policy
  THEN RAISE EXCEPTION 'scheduled spread published policy differs' USING ERRCODE='40001'; END IF;

  quote:=n.quote_snapshot-ARRAY['quoteKind','orderSnapshotSchema','confirmationId','confirmationDigest','confirmationExpiresAt',
    'listingHash','personal','settlementPricing','agreementAcceptanceSchema','agreementAcceptance','earlySettlementDisclosure','fullPayoutTermsAcceptance'];
  IF quote-ARRAY['schemaVersion','currency','priceVersionId','ruleReleaseId','mode','lines','resourceTotal','ownerTotal','platformFullProfit',
    'tenantDeposit','publisherBailRequirement','termSeconds','expiryDisclosures','unitAmountsInformational','roundingPolicy','pricingInputs'] <> '{}'::jsonb
    OR NOT(quote ?& ARRAY['schemaVersion','currency','priceVersionId','ruleReleaseId','mode','lines','resourceTotal','ownerTotal','platformFullProfit',
      'tenantDeposit','publisherBailRequirement','termSeconds','expiryDisclosures','unitAmountsInformational','roundingPolicy','pricingInputs'])
    OR n.quote_snapshot->>'confirmationDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(
      p||jsonb_build_object('quote',quote,'settlementPricing',basis)),'UTF8')),'hex')
    OR quote->'expiryDisclosures' IS DISTINCT FROM v.payload#>'{quoteValues,expiryDisclosures}'
  THEN RAISE EXCEPTION 'scheduled spread confirmation digest invalid' USING ERRCODE='40001'; END IF;
  shadow:=n;
  shadow.quote_snapshot:=jsonb_set(jsonb_set(n.quote_snapshot,'{personal}',(p-'pricingPolicy')||jsonb_build_object('schema','personal-quote-v4')),
    '{priceVersionId}',to_jsonb(p#>>'{ruleRefs,priceVersionId}'));
  PERFORM zzsh_order.assert_personal_growth_for_fixed_fee_v5(shadow,v.payload#>>'{quoteValues,priceVersionId}');

  choice:=v.payload#>'{declaration,attributes,rentalPricing}';conditions:=quote#>'{pricingInputs,conditions}';mode_value:=choice->>'rentalMode';
  IF mode_value NOT IN ('ordinary','custom','fast') OR mode_value IS NULL
    OR v.payload#>>'{quoteValues,pricingInputs,compatibility,rentalMode}' IS DISTINCT FROM mode_value
    OR v.payload#>>'{quoteValues,pricingInputs,compatibility,customerTier}' IS DISTINCT FROM 'STANDARD'
    OR (mode_value<>'ordinary' AND v.payload#>>'{quoteValues,pricingInputs,compatibility,ownerRatioB}' IS DISTINCT FROM choice->>'ownerRatioB')
    OR v.payload#>>'{quoteValues,pricingInputs,conditions,safeBoxCode}' IS DISTINCT FROM v.payload#>>'{declaration,attributes,safe_box_code}'
    OR v.payload#>>'{quoteValues,pricingInputs,conditions,vitLevel}' IS DISTINCT FROM COALESCE(v.payload#>>'{declaration,attributes,vit_level}',v.payload#>>'{declaration,attributes,vitLevel}')
    OR v.payload#>>'{quoteValues,pricingInputs,conditions,bearLevel}' IS DISTINCT FROM COALESCE(v.payload#>>'{declaration,attributes,bear_level}',v.payload#>>'{declaration,attributes,bearLevel}')
    OR v.payload#>>'{quoteValues,pricingInputs,conditions,termOptionCode}' IS DISTINCT FROM v.payload#>>'{declaration,termOptionCode}'
    OR quote#>>'{pricingInputs,compatibility,rentalMode}' IS DISTINCT FROM mode_value
    OR quote#>>'{pricingInputs,compatibility,customerTier}' IS DISTINCT FROM 'STANDARD'
    OR quote#>>'{pricingInputs,compatibility,memberDelta}' IS DISTINCT FROM '0'
    OR effective.haff_rule#>>ARRAY['compatibility','modes',mode_value,'enabled'] IS DISTINCT FROM 'true'
    OR conditions->>'safeBoxCode' IS DISTINCT FROM v.payload#>>'{declaration,attributes,safe_box_code}'
    OR conditions->>'vitLevel' IS DISTINCT FROM COALESCE(v.payload#>>'{declaration,attributes,vit_level}',v.payload#>>'{declaration,attributes,vitLevel}')
    OR conditions->>'bearLevel' IS DISTINCT FROM COALESCE(v.payload#>>'{declaration,attributes,bear_level}',v.payload#>>'{declaration,attributes,bearLevel}')
    OR conditions->>'termOptionCode' IS DISTINCT FROM v.payload#>>'{declaration,termOptionCode}'
    OR COALESCE(basis->>'payableRatio','') !~ '^(0|1)(\.[0-9]{1,8})?$'
  THEN RAISE EXCEPTION 'scheduled spread rental selection invalid' USING ERRCODE='40001'; END IF;
  base_ratio:=(effective.haff_rule#>>ARRAY['baseBySafeBox',conditions->>'safeBoxCode'])::numeric
    +(effective.haff_rule#>>ARRAY['vitalityDeltaByLevel',conditions->>'vitLevel'])::numeric
    +(effective.haff_rule#>>ARRAY['bearDeltaByLevel',conditions->>'bearLevel'])::numeric
    +(effective.haff_rule#>>ARRAY['dailyDeltaByTermOption',conditions->>'termOptionCode'])::numeric;
  owner_ratio:=CASE WHEN mode_value='ordinary' THEN base_ratio ELSE (choice->>'ownerRatioB')::numeric END;
  spread:=(effective.haff_rule#>>ARRAY['compatibility',CASE WHEN mode_value='fast' THEN 'fast' ELSE 'ordinary' END,'spreadDelta'])::numeric;
  buyer_ratio:=owner_ratio-spread;payable:=(basis->>'payableRatio')::numeric;
  IF base_ratio IS NULL OR base_ratio<=0 OR owner_ratio IS NULL OR owner_ratio<=0 OR buyer_ratio IS NULL OR buyer_ratio<=0
    OR payable IS NULL OR payable<=0 OR payable>1
    OR (quote#>>'{pricingInputs,compatibility,baseRatioC}')::numeric IS DISTINCT FROM base_ratio
    OR (quote#>>'{pricingInputs,compatibility,ownerRatioB}')::numeric IS DISTINCT FROM owner_ratio
    OR (quote#>>'{pricingInputs,denominators,buyer}')::numeric IS DISTINCT FROM buyer_ratio
    OR (quote#>>'{pricingInputs,denominators,owner}')::numeric IS DISTINCT FROM owner_ratio
    OR (quote#>>'{pricingInputs,spreadDelta}')::numeric IS DISTINCT FROM spread
  THEN RAISE EXCEPTION 'scheduled spread ratios invalid' USING ERRCODE='40001'; END IF;

  IF jsonb_typeof(quote->'lines') IS DISTINCT FROM 'array' OR jsonb_typeof(basis->'items') IS DISTINCT FROM 'array'
    OR jsonb_array_length(quote->'lines')<1 OR jsonb_array_length(quote->'lines')>64 OR jsonb_array_length(basis->'items')>63
  THEN RAISE EXCEPTION 'scheduled spread lines invalid' USING ERRCODE='40001'; END IF;
  SELECT count(*),count(*)<>count(DISTINCT line->>'itemId') OR count(*) FILTER (WHERE line->>'pricingKind'='HAFF_RATIO')<>1
    OR bool_or(COALESCE(line->>'itemId','') !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
      OR line-ARRAY['itemId','quantity','unit','unitQuantity','pricingKind','buyerUnitAmount','ownerUnitAmount','buyerAmount','ownerAmount','platformAmount'] <> '{}'::jsonb
      OR NOT(line ?& ARRAY['itemId','quantity','unit','unitQuantity','pricingKind','buyerUnitAmount','ownerUnitAmount','buyerAmount','ownerAmount','platformAmount'])
      OR COALESCE(line->>'quantity','') !~ '^(0|[1-9][0-9]{0,23})$' OR COALESCE(line->>'unitQuantity','') !~ '^[1-9][0-9]{0,23}$'
      OR EXISTS(SELECT 1 FROM unnest(ARRAY['buyerAmount','ownerAmount','platformAmount','buyerUnitAmount','ownerUnitAmount']) k
        WHERE jsonb_typeof(line->k) IS DISTINCT FROM 'object' OR line#>>ARRAY[k,'currency'] IS DISTINCT FROM 'CNY'
          OR line#>>ARRAY[k,'unit'] IS DISTINCT FROM 'yuan' OR jsonb_typeof(line#>ARRAY[k,'amount']) IS DISTINCT FROM 'string'
          OR line#>>ARRAY[k,'scale'] IS DISTINCT FROM CASE WHEN k IN ('buyerUnitAmount','ownerUnitAmount') THEN '8' ELSE '2' END
          OR COALESCE(line#>>ARRAY[k,'amount'],'') !~ CASE WHEN k IN ('buyerUnitAmount','ownerUnitAmount') THEN '^(0|[1-9][0-9]*)\.[0-9]{8}$' ELSE '^(0|[1-9][0-9]*)\.[0-9]{2}$' END))
    INTO line_count,mismatch FROM jsonb_array_elements(quote->'lines') line;
  IF mismatch THEN RAISE EXCEPTION 'scheduled spread line shape invalid' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(quote->'lines') q FULL JOIN jsonb_array_elements(v.payload#>'{quoteValues,lines}') original
    ON q->>'itemId'=original->>'itemId' WHERE q IS NULL OR original IS NULL OR q->>'quantity' IS DISTINCT FROM original->>'quantity'
      OR q->>'unit' IS DISTINCT FROM original->>'unit' OR q->>'unitQuantity' IS DISTINCT FROM original->>'unitQuantity'
      OR q->>'pricingKind' IS DISTINCT FROM original->>'pricingKind')
    OR line_count<>jsonb_array_length(v.payload#>'{quoteValues,lines}')
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(v.payload#>'{declaration,inventory}') inventory
      FULL JOIN jsonb_array_elements(v.payload#>'{quoteValues,lines}') original ON inventory->>'itemId'=original->>'itemId'
      WHERE inventory IS NULL OR original IS NULL OR inventory->>'quantity' IS DISTINCT FROM original->>'quantity')
  THEN RAISE EXCEPTION 'scheduled spread listing quantities changed' USING ERRCODE='40001'; END IF;
  IF EXISTS(SELECT 1 FROM jsonb_array_elements(quote->'lines') q
    LEFT JOIN zzsh_supply.price_line l ON l.price_version_id=effective.price_version_id AND l.customer_tier='STANDARD' AND l.item_id=q->>'itemId'
    LEFT JOIN zzsh_supply.billable_item item ON item.id=l.item_id AND item.game_id=n.game_id
    WHERE l.id IS NULL OR item.id IS NULL OR l.pricing_kind IS DISTINCT FROM q->>'pricingKind' OR item.unit IS DISTINCT FROM q->>'unit'
      OR (l.pricing_kind='FIXED_UNIT' AND (l.owner_unit_amount IS NULL OR l.buyer_unit_amount IS NULL
        OR l.owner_unit_amount>l.buyer_unit_amount OR l.unit_quantity IS DISTINCT FROM (q->>'unitQuantity')::numeric
        OR l.owner_unit_amount IS DISTINCT FROM (q#>>'{ownerUnitAmount,amount}')::numeric))
      OR (l.pricing_kind='HAFF_RATIO' AND (q->>'unit' IS DISTINCT FROM 'HAFF_BASE' OR q->>'unitQuantity' IS DISTINCT FROM '1000000'
        OR (q->>'quantity')::numeric<=0)))
  THEN RAISE EXCEPTION 'scheduled spread current unit prices invalid' USING ERRCODE='40001'; END IF;

  IF jsonb_typeof(basis->'haff') IS DISTINCT FROM 'object'
    OR (basis->'haff')-ARRAY['itemId','openingQuantity','buyerNumerator','buyerDenominator'] <> '{}'::jsonb
    OR NOT((basis->'haff') ?& ARRAY['itemId','openingQuantity','buyerNumerator','buyerDenominator'])
    OR COALESCE(basis#>>'{haff,buyerNumerator}','') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$'
    OR COALESCE(basis#>>'{haff,buyerDenominator}','') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$'
    OR (basis#>>'{haff,buyerDenominator}')::numeric<=0
    OR NOT EXISTS(SELECT 1 FROM jsonb_array_elements(quote->'lines') q WHERE q->>'pricingKind'='HAFF_RATIO'
      AND q->>'itemId'=basis#>>'{haff,itemId}' AND q->>'quantity'=basis#>>'{haff,openingQuantity}'
      AND (basis#>>'{haff,buyerNumerator}')::numeric*1000000*buyer_ratio=(q->>'quantity')::numeric*100*(basis#>>'{haff,buyerDenominator}')::numeric)
  THEN RAISE EXCEPTION 'scheduled spread original haff price invalid' USING ERRCODE='40001'; END IF;
  IF (SELECT count(*)<>count(DISTINCT item->>'itemId') FROM jsonb_array_elements(basis->'items') item)
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'items') item WHERE jsonb_typeof(item) IS DISTINCT FROM 'object'
      OR item-ARRAY['itemId','name','unit','unitQuantity','buyerUnitAmount','ownerUnitAmount'] <> '{}'::jsonb
      OR NOT(item ?& ARRAY['itemId','name','unit','unitQuantity','buyerUnitAmount','ownerUnitAmount']))
    OR EXISTS(SELECT 1 FROM jsonb_array_elements(basis->'items') frozen FULL JOIN (
      SELECT l.item_id,l.unit_quantity,l.buyer_unit_amount,l.owner_unit_amount,item.unit
        FROM zzsh_supply.price_line l JOIN zzsh_supply.billable_item item ON item.id=l.item_id AND item.game_id=n.game_id
       WHERE l.price_version_id=effective.price_version_id AND l.customer_tier='STANDARD' AND l.pricing_kind='FIXED_UNIT'
         AND (item.enabled OR EXISTS(SELECT 1 FROM jsonb_array_elements(quote->'lines') q WHERE q->>'itemId'=l.item_id))
      ) line ON line.item_id=frozen->>'itemId' WHERE frozen IS NULL OR line.item_id IS NULL OR line.owner_unit_amount IS NULL OR line.buyer_unit_amount IS NULL
        OR frozen->>'unit' IS DISTINCT FROM line.unit OR (frozen->>'unitQuantity')::numeric IS DISTINCT FROM line.unit_quantity
        OR (frozen->>'buyerUnitAmount')::numeric IS DISTINCT FROM line.buyer_unit_amount
        OR (frozen->>'ownerUnitAmount')::numeric IS DISTINCT FROM line.owner_unit_amount)
  THEN RAISE EXCEPTION 'scheduled spread original item prices invalid' USING ERRCODE='40001'; END IF;

  WITH rows AS (
    SELECT q,q->>'itemId' AS item_id,
      CASE WHEN q->>'pricingKind'='HAFF_RATIO' THEN div((q->>'quantity')::numeric*20000+1000000*buyer_ratio,2000000*buyer_ratio)
        ELSE div((q->>'quantity')::numeric*l.buyer_unit_amount*200+(q->>'unitQuantity')::numeric,2*(q->>'unitQuantity')::numeric) END AS base,
      CASE WHEN q->>'pricingKind'='HAFF_RATIO' THEN div((q->>'quantity')::numeric*20000+1000000*owner_ratio,2000000*owner_ratio)
        ELSE div((q->>'quantity')::numeric*l.owner_unit_amount*200+(q->>'unitQuantity')::numeric,2*(q->>'unitQuantity')::numeric) END AS expected_owner,
      (q#>>'{buyerAmount,amount}')::numeric*100 AS buyer,(q#>>'{ownerAmount,amount}')::numeric*100 AS owner,
      (q#>>'{platformAmount,amount}')::numeric*100 AS platform
    FROM jsonb_array_elements(quote->'lines') q JOIN zzsh_supply.price_line l
      ON l.price_version_id=effective.price_version_id AND l.customer_tier='STANDARD' AND l.item_id=q->>'itemId'
  )
  SELECT COALESCE(sum(base),0),COALESCE(sum(owner),0),COALESCE(sum(buyer),0),COALESCE(sum(platform),0),
    COALESCE(bool_or(owner IS DISTINCT FROM expected_owner OR buyer<owner OR buyer>base OR platform<>buyer-owner),false),
    jsonb_agg(jsonb_build_object('itemId',item_id,'base',base,'owner',owner,'buyer',buyer) ORDER BY item_id COLLATE "C")
    INTO gross,owner_total,buyer_total,platform_total,mismatch,parts FROM rows;
  IF mismatch OR buyer_total IS DISTINCT FROM round(gross*payable)
    OR buyer_total IS DISTINCT FROM (quote#>>'{resourceTotal,amount}')::numeric*100
    OR owner_total IS DISTINCT FROM (quote#>>'{ownerTotal,amount}')::numeric*100
    OR platform_total IS DISTINCT FROM (quote#>>'{platformFullProfit,amount}')::numeric*100
    OR platform_total IS DISTINCT FROM buyer_total-owner_total
  THEN RAISE EXCEPTION 'scheduled spread quote totals invalid' USING ERRCODE='40001'; END IF;

  FOR entry IN SELECT value FROM jsonb_array_elements(parts) LOOP
    ids:=array_append(ids,entry->>'itemId');bases:=array_append(bases,(entry->>'base')::numeric);
    buyers:=array_append(buyers,(entry->>'buyer')::numeric);owners:=array_append(owners,(entry->>'owner')::numeric);
    capacity:=array_append(capacity,(entry->>'base')::numeric-(entry->>'owner')::numeric);discounts:=array_append(discounts,0::numeric);
  END LOOP;
  remaining:=gross-buyer_total;attempts:=line_count+2;
  WHILE remaining>0 LOOP
    attempts:=attempts-1;
    IF attempts<0 THEN RAISE EXCEPTION 'scheduled spread discount allocation invalid' USING ERRCODE='40001'; END IF;
    weight:=0;take:=array_fill(0::numeric,ARRAY[line_count]);
    FOR i IN 1..line_count LOOP IF capacity[i]>0 THEN weight:=weight+bases[i]; END IF; END LOOP;
    taken:=0;
    IF weight>0 THEN
      FOR i IN 1..line_count LOOP
        IF capacity[i]>0 THEN take[i]:=LEAST(div(remaining*bases[i],weight),capacity[i]);taken:=taken+take[i]; END IF;
      END LOOP;
    END IF;
    IF taken>0 THEN
      FOR i IN 1..line_count LOOP discounts[i]:=discounts[i]+take[i];capacity[i]:=capacity[i]-take[i]; END LOOP;
      remaining:=remaining-taken;
    ELSE
      remaining_before:=remaining;
      FOR chosen IN SELECT idx FROM generate_subscripts(capacity,1) idx WHERE capacity[idx]>0
        ORDER BY CASE WHEN weight>0 THEN mod(remaining*bases[idx],weight) ELSE 0 END DESC,bases[idx] DESC,ids[idx] COLLATE "C"
      LOOP
        EXIT WHEN remaining=0;discounts[chosen]:=discounts[chosen]+1;capacity[chosen]:=capacity[chosen]-1;remaining:=remaining-1;
      END LOOP;
      IF remaining=remaining_before THEN RAISE EXCEPTION 'scheduled spread discount allocation unavailable' USING ERRCODE='40001'; END IF;
    END IF;
  END LOOP;
  FOR i IN 1..line_count LOOP
    IF buyers[i] IS DISTINCT FROM bases[i]-discounts[i] THEN RAISE EXCEPTION 'scheduled spread line discount allocation invalid' USING ERRCODE='40001'; END IF;
  END LOOP;

  IF EXISTS (
    WITH lines AS (
      SELECT q,l.buyer_unit_amount,l.owner_unit_amount,(q->>'quantity')::numeric AS quantity,
        (q->>'unitQuantity')::numeric AS unit_quantity,(q#>>'{buyerAmount,amount}')::numeric*100 AS buyer,
        (q#>>'{ownerAmount,amount}')::numeric*100 AS owner,
        CASE WHEN q->>'pricingKind'='HAFF_RATIO' THEN div((q->>'quantity')::numeric*20000+1000000*buyer_ratio,2000000*buyer_ratio)
          ELSE div((q->>'quantity')::numeric*l.buyer_unit_amount*200+(q->>'unitQuantity')::numeric,2*(q->>'unitQuantity')::numeric) END AS base
      FROM jsonb_array_elements(quote->'lines') q JOIN zzsh_supply.price_line l
        ON l.price_version_id=effective.price_version_id AND l.customer_tier='STANDARD' AND l.item_id=q->>'itemId'
    ), expected AS (
      SELECT *,CASE WHEN q->>'pricingKind'='HAFF_RATIO' THEN
          CASE WHEN buyer=base THEN div(20000000000+buyer_ratio,2*buyer_ratio)
            WHEN buyer*1000000*owner_ratio>=100*quantity*100 THEN div(2*buyer*unit_quantity*100000000+quantity*100,2*quantity*100)
            ELSE div(20000000000+owner_ratio,2*owner_ratio) END
        ELSE CASE WHEN buyer=base THEN buyer_unit_amount*100000000
            WHEN buyer=owner THEN owner_unit_amount*100000000
            ELSE div((2*buyer-1)*unit_quantity*1000000+2*quantity-1,2*quantity) END END AS buyer_scaled,
        CASE WHEN q->>'pricingKind'='HAFF_RATIO' THEN div(20000000000+owner_ratio,2*owner_ratio)
          ELSE owner_unit_amount*100000000 END AS owner_scaled
      FROM lines
    ) SELECT 1 FROM expected WHERE (q#>>'{buyerUnitAmount,amount}')::numeric*100000000 IS DISTINCT FROM buyer_scaled
      OR (q#>>'{ownerUnitAmount,amount}')::numeric*100000000 IS DISTINCT FROM owner_scaled
      OR (q->>'pricingKind'='FIXED_UNIT' AND div(quantity*buyer_scaled*200+unit_quantity*100000000,
        2*unit_quantity*100000000) IS DISTINCT FROM buyer)
  ) THEN RAISE EXCEPTION 'scheduled spread quoted unit price invalid' USING ERRCODE='40001'; END IF;

  IF jsonb_typeof(quote#>'{pricingInputs,exactRatios}') IS DISTINCT FROM 'array' OR jsonb_array_length(quote#>'{pricingInputs,exactRatios}')<>1
  THEN RAISE EXCEPTION 'scheduled spread exact ratio invalid' USING ERRCODE='40001'; END IF;
  exact:=quote#>'{pricingInputs,exactRatios,0}';
  SELECT q INTO haff_line FROM jsonb_array_elements(quote->'lines') q WHERE q->>'pricingKind'='HAFF_RATIO';
  IF jsonb_typeof(exact) IS DISTINCT FROM 'object' OR exact->>'itemId' IS DISTINCT FROM haff_line->>'itemId'
    OR EXISTS(SELECT 1 FROM unnest(ARRAY['buyerNumerator','buyerDenominator','ownerNumerator','ownerDenominator']) key
      WHERE jsonb_typeof(exact->key) IS DISTINCT FROM 'string' OR COALESCE(exact->>key,'') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,18})?$')
    OR (exact->>'buyerDenominator')::numeric<=0 OR (exact->>'ownerDenominator')::numeric<=0
  THEN RAISE EXCEPTION 'scheduled spread exact ratio invalid' USING ERRCODE='40001'; END IF;
  owner_num:=(haff_line->>'quantity')::numeric*100;owner_den:=1000000*owner_ratio;
  base_haff:=div((haff_line->>'quantity')::numeric*20000+1000000*buyer_ratio,2000000*buyer_ratio);
  IF (haff_line#>>'{buyerAmount,amount}')::numeric*100=base_haff THEN buyer_num:=owner_num;buyer_den:=1000000*buyer_ratio;
  ELSIF (haff_line#>>'{buyerAmount,amount}')::numeric*100*owner_den>=100*owner_num THEN
    buyer_num:=(haff_line#>>'{buyerAmount,amount}')::numeric*100;buyer_den:=100;
  ELSE buyer_num:=owner_num;buyer_den:=owner_den; END IF;
  IF (exact->>'ownerNumerator')::numeric*owner_den IS DISTINCT FROM owner_num*(exact->>'ownerDenominator')::numeric
    OR (exact->>'buyerNumerator')::numeric*buyer_den IS DISTINCT FROM buyer_num*(exact->>'buyerDenominator')::numeric
  THEN RAISE EXCEPTION 'scheduled spread exact ratio changed' USING ERRCODE='40001'; END IF;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.assert_scheduled_spread_order_v6(zzsh_order.rental_order) FROM PUBLIC;
COMMENT ON FUNCTION zzsh_order.assert_scheduled_spread_order_v6(zzsh_order.rental_order)
  IS '校验独立价差订单的原上架、当前价目、金额与版本化确认依据。';

--> statement-breakpoint
-- Contract: final-funding-contract
-- Bind new orders to the original publication guarantee and funding terms.
-- Install only together with the v5 order guard and explicit runtime ACL verification.
-- Refuse installation before the account line's immutable publication snapshot exists.
SELECT credit_guarantee_waived,credit_guarantee_waived_revision FROM zzsh_supply.listing_publication LIMIT 0;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION zzsh_order.guard_supply_final_funding() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  personal jsonb;
  binding record;
  proof record;
  terms record;
  credit_revision text;
  requirement record;
  last_payment text;
  confirmed numeric;
  refunded numeric;
  active_refund boolean;
  unrecognized boolean;
  reference text;
  required_text text;
  credit_state text;
  coverage_revision text;
  expected_reference text;
BEGIN
  IF NEW.confirmation_id IS NULL THEN RETURN NEW; END IF;
  personal:=NEW.quote_snapshot->'personal';
  IF personal->>'schema' NOT IN ('personal-quote-v2','personal-quote-v3','personal-quote-v4','personal-quote-v5','personal-quote-v6') THEN RETURN NEW; END IF;
  SELECT a.game_id,p.id AS price_id,p.funding_policy AS policy,v.payload,
    p.full_payout_terms_version_id,p.full_payout_terms_digest,p.full_payout_disclosure_version,
    pub.id AS publication_id,pub.credit_guarantee_waived,pub.credit_guarantee_waived_revision::text AS waiver_revision INTO binding
    FROM zzsh_supply.rental_account a
    JOIN zzsh_supply.game g ON g.id=a.game_id AND g.enabled
    JOIN zzsh_supply.rule_release r ON r.id=NEW.rule_release_id AND r.game_id=a.game_id
    JOIN zzsh_supply.price_version p ON p.id=r.price_version_id AND p.game_id=a.game_id AND p.status='SEALED'
    JOIN zzsh_supply.listing_version v ON v.id=NEW.listing_version_id AND v.id=a.current_version_id AND v.account_id=a.id
      AND v.rule_release_id=r.id AND v.content_hash=NEW.content_hash
    LEFT JOIN zzsh_supply.listing_publication pub ON pub.version_id=v.id AND pub.account_id=a.id
      AND pub.owner_user_id=a.owner_user_id AND pub.game_id=a.game_id AND pub.rule_release_id=r.id AND pub.content_hash=v.content_hash
   WHERE a.id=NEW.account_id AND a.owner_user_id=NEW.owner_user_id AND a.game_id=NEW.game_id
     AND a.lifecycle='ACTIVE' AND NOT a.staff_restricted AND NOT a.owner_paused AND a.legacy_hold='NONE'
     AND NOT (g.code='delta' AND EXISTS (SELECT 1 FROM zzsh_supply.legacy_supply_map m WHERE m.account_id=a.id
       AND m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts'))
     AND ((v.review_state='PUBLISHED' AND pub.source='OWNER_DIRECT')
       OR (v.review_state='APPROVED' AND pub.source='LEGACY_APPROVED'))
     AND p.id=personal#>>'{ruleRefs,priceVersionId}' AND p.funding_policy->>'policyVersion'=personal#>>'{funding,version}';
  IF NOT FOUND THEN RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001'; END IF;
  IF personal#>>'{fullPayoutDeclaration,selected}'='true' THEN
    SELECT * INTO terms FROM zzsh_supply.full_payout_terms_version t
      WHERE t.id=binding.full_payout_terms_version_id AND t.game_id=binding.game_id AND t.status='SEALED'
        AND t.digest=binding.full_payout_terms_digest AND t.disclosure_version=binding.full_payout_disclosure_version
        AND t.policy_ref=personal#>>'{funding,fullPayoutPolicyRef}'
        AND t.policy_version=personal#>>'{funding,fullPayoutPolicyVersion}'
        AND t.disclosure_version=personal#>>'{funding,disclosureVersion}'
        AND t.policy_ref=binding.policy->>'fullPayoutPolicyRef'
        AND t.policy_version=binding.policy->>'fullPayoutPolicyVersion'
        AND t.disclosure_version=binding.policy->>'disclosureVersion';
    IF NOT FOUND OR right(personal#>>'{funding,sourceRef}',length(':full-payout-terms:'||terms.id||':'||terms.digest))
      IS DISTINCT FROM ':full-payout-terms:'||terms.id||':'||terms.digest THEN
      RAISE EXCEPTION 'full-payout terms binding changed' USING ERRCODE='40001';
    END IF;
  END IF;
  reference:=personal#>>'{guarantee,reference}';
  IF reference ~ '^credit-guarantee-v1:[0-9a-f]{64}$' THEN
    PERFORM 1 FROM zzsh_credit.user_credit_state WHERE user_id=NEW.owner_user_id FOR SHARE;
    IF NOT FOUND OR binding.publication_id IS NULL OR binding.payload#>>'{quoteValues,resourceTotal,currency}' IS DISTINCT FROM 'CNY'
      OR binding.payload#>>'{quoteValues,resourceTotal,unit}' IS DISTINCT FROM 'yuan'
      OR binding.payload#>>'{quoteValues,resourceTotal,scale}' IS DISTINCT FROM '2'
      OR COALESCE(binding.payload#>>'{quoteValues,resourceTotal,amount}','') !~ '^(0|[1-9][0-9]*)(\.[0-9]{1,2})?$'
      OR (binding.payload#>>'{quoteValues,resourceTotal,amount}')::numeric<=0
      OR round((binding.payload#>>'{quoteValues,resourceTotal,amount}')::numeric*5)<=0
      OR (binding.payload#>'{quoteValues,pricingInputs,compatibility}' IS NOT NULL
        AND binding.payload#>>'{quoteValues,pricingInputs,compatibility,customerTier}' IS DISTINCT FROM 'STANDARD') THEN
      RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
    END IF;
    IF EXISTS (SELECT 1 FROM zzsh_order.owner_guarantee_requirement previous
      JOIN zzsh_order.owner_guarantee_payment paid ON paid.requirement_id=previous.id AND paid.owner_user_id=previous.owner_user_id
      WHERE previous.account_id=NEW.account_id AND previous.owner_user_id=NEW.owner_user_id
        AND (previous.price_version_id IS DISTINCT FROM binding.price_id OR previous.listing_version_id IS DISTINCT FROM NEW.listing_version_id)
        AND paid.status<>'FAILED' AND NOT EXISTS (SELECT 1 FROM zzsh_order.owner_guarantee_refund f
          JOIN zzsh_order.finance_event e ON e.id=f.finance_event_id
          JOIN zzsh_order.finance_economic_root root ON root.id=e.economic_root_id
          JOIN zzsh_order.settlement_ledger_entry cash ON cash.id=f.ledger_entry_ref AND cash.finance_event_id=e.id
          WHERE f.payment_id=paid.id AND f.status='SUCCEEDED' AND f.provider_request_state='SUCCEEDED'
            AND f.amount_cents=COALESCE(paid.observed_amount_cents,paid.amount_cents)
            AND e.kind='GUARANTEE_REFUND' AND e.subject_user_id=previous.owner_user_id
            AND root.source_kind='NATIVE_GUARANTEE' AND root.source_entity='owner_guarantee_refund' AND root.source_id=f.id
            AND root.subject_user_id=previous.owner_user_id AND root.source_digest=f.source_digest
            AND cash.account_code='GUARANTEE_CASH' AND cash.debit_cents=0 AND cash.credit_cents=f.amount_cents)
    ) THEN RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001'; END IF;
    SELECT id,status,score_snapshot,required_cents::text,updated_at::text INTO requirement FROM zzsh_order.owner_guarantee_requirement
      WHERE account_id=NEW.account_id AND owner_user_id=NEW.owner_user_id AND price_version_id=binding.price_id
        AND listing_version_id IS NOT DISTINCT FROM NEW.listing_version_id ORDER BY created_at DESC,id DESC LIMIT 1 FOR SHARE;
    IF FOUND THEN
      SELECT COALESCE(sum(COALESCE(observed_amount_cents,amount_cents)),0),
        COALESCE(bool_or(provider_request_state<>'CONFIRMED' OR finance_event_id IS NULL OR ledger_entry_ref IS NULL),false)
        INTO confirmed,unrecognized FROM zzsh_order.owner_guarantee_payment WHERE requirement_id=requirement.id AND status='CONFIRMED';
      SELECT COALESCE(sum(CASE WHEN status='SUCCEEDED' THEN amount_cents ELSE 0 END),0),
        COALESCE(bool_or(status IN ('REQUESTED','PROCESSING','UNKNOWN')),false)
        INTO refunded,active_refund FROM zzsh_order.owner_guarantee_refund WHERE requirement_id=requirement.id;
      SELECT status INTO last_payment FROM zzsh_order.owner_guarantee_payment WHERE requirement_id=requirement.id ORDER BY created_at DESC,id DESC LIMIT 1;
      IF requirement.status='RESTRICTED' OR active_refund OR refunded>0
        OR last_payment IN ('REQUESTED','ACCEPTED','PROCESSING','UNKNOWN') OR unrecognized THEN
        RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
      END IF;
    END IF;
    IF binding.credit_guarantee_waived IS TRUE AND binding.waiver_revision ~ '^[1-9][0-9]*$' THEN
      IF COALESCE(confirmed,0)<>0 OR (last_payment IS NOT NULL AND last_payment<>'FAILED') THEN
        RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
      END IF;
      credit_state:='NOT_REQUIRED';required_text:='0';coverage_revision:=NULL;credit_revision:=binding.waiver_revision;
    ELSE
      IF requirement.id IS NULL OR requirement.score_snapshot IS NULL OR requirement.score_snapshot NOT BETWEEN 0 AND 100
        OR requirement.required_cents::numeric<=0 OR confirmed IS NULL OR confirmed<requirement.required_cents::numeric THEN
        RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
      END IF;
      credit_state:='SATISFIED';required_text:=requirement.required_cents;coverage_revision:=requirement.updated_at;credit_revision:=NULL;
    END IF;
    expected_reference:='credit-guarantee-v1:'||encode(sha256(convert_to(zzsh_order.canonical_finance_json(jsonb_build_object(
      'accountId',NEW.account_id,'ownerUserId',NEW.owner_user_id,'gameId',binding.game_id,'versionId',NEW.listing_version_id,
      'priceVersionId',binding.price_id,'releaseId',NEW.rule_release_id,'creditRevision',credit_revision,
      'coverageRevision',coverage_revision,'state',credit_state,'requiredCents',required_text)), 'UTF8')),'hex');
    IF reference IS DISTINCT FROM expected_reference OR personal#>>'{guarantee,status}' IS DISTINCT FROM credit_state
      OR personal#>>'{funding,publisherBailRequirementCents}' IS DISTINCT FROM required_text THEN
      RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
    END IF;
    RETURN NEW;
  END IF;
  SELECT id,owner_user_id,account_id,price_version_id,policy_version,status,required_cents,covered_cents,valid_from,valid_until
    INTO proof FROM zzsh_supply.account_guarantee_proof WHERE account_id=NEW.account_id ORDER BY version_no DESC LIMIT 1;
  IF binding.policy#>>'{guaranteeRequirement,mode}'='NOT_REQUIRED' THEN
    IF binding.policy#>>'{guaranteeRequirement,requiredCents}' IS DISTINCT FROM '0'
      OR reference IS DISTINCT FROM 'policy:'||binding.price_id||':'||(binding.policy->>'policyVersion')||':NOT_REQUIRED'
      OR personal#>>'{guarantee,status}' IS DISTINCT FROM 'NOT_REQUIRED'
      OR personal#>>'{funding,publisherBailRequirementCents}' IS DISTINCT FROM '0' OR proof.status='REVOKED' THEN
      RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
    END IF;
  ELSE
    IF proof.id IS DISTINCT FROM reference OR proof.status IS DISTINCT FROM 'SATISFIED'
      OR proof.owner_user_id IS DISTINCT FROM NEW.owner_user_id OR proof.price_version_id IS DISTINCT FROM binding.price_id
      OR proof.policy_version IS DISTINCT FROM binding.policy->>'policyVersion'
      OR proof.required_cents::text IS DISTINCT FROM binding.policy#>>'{guaranteeRequirement,requiredCents}'
      OR proof.covered_cents<proof.required_cents OR personal#>>'{guarantee,status}' IS DISTINCT FROM 'SATISFIED'
      OR personal#>>'{funding,publisherBailRequirementCents}' IS DISTINCT FROM proof.required_cents::text THEN
      RAISE EXCEPTION 'formal guarantee binding changed' USING ERRCODE='40001';
    END IF;
    IF proof.valid_from IS NULL OR proof.valid_until IS NULL OR proof.valid_from>clock_timestamp()
      OR clock_timestamp()>=proof.valid_until THEN
      RAISE EXCEPTION 'formal guarantee expired at order write' USING ERRCODE='40001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
COMMENT ON FUNCTION zzsh_order.guard_supply_final_funding() IS '验证新旧订单的原资金政策、保证金和包赔条款。';

--> statement-breakpoint
-- Contract: personal-order-enable
-- Apply together with the v5 evidence and final-funding guards;
-- publication and settlement remain closed until their own contracts are ready.
ALTER TABLE zzsh_supply.listing_version DROP CONSTRAINT listing_version_schema_version_check;
ALTER TABLE zzsh_supply.listing_version ADD CONSTRAINT listing_version_schema_version_check CHECK(schema_version IN (1,2,3,4));

-- Retain the existing trigger and original v1-v4 body for every earlier snapshot.
DROP TRIGGER rental_order_personal_guard ON zzsh_order.rental_order;
CREATE TRIGGER rental_order_personal_guard BEFORE INSERT OR UPDATE ON zzsh_order.rental_order
  FOR EACH ROW WHEN (NEW.quote_snapshot#>>'{personal,schema}' IS DISTINCT FROM 'personal-quote-v5')
  EXECUTE FUNCTION zzsh_order.guard_personal_order();

CREATE FUNCTION zzsh_order.guard_fixed_fee_personal_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE listing_schema integer;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT schema_version INTO listing_schema FROM zzsh_supply.listing_version
      WHERE id=NEW.listing_version_id AND account_id=NEW.account_id;
    IF listing_schema=4 OR NEW.quote_snapshot->>'schemaVersion'='4'
      OR NEW.quote_snapshot#>>'{personal,schema}'='personal-quote-v5'
      OR NEW.quote_snapshot#>>'{settlementPricing,schema}'='settlement-pricing-v3' THEN
      IF listing_schema IS DISTINCT FROM 4 OR NEW.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '4'
        OR NEW.quote_snapshot#>>'{personal,schema}' IS DISTINCT FROM 'personal-quote-v5'
        OR NEW.quote_snapshot#>>'{settlementPricing,schema}' IS DISTINCT FROM 'settlement-pricing-v3'
      THEN RAISE EXCEPTION 'fixed fee order contract mismatch' USING ERRCODE='40001'; END IF;
      PERFORM zzsh_order.assert_fixed_fee_personal_order_v5(NEW);
    END IF;
  ELSIF NEW.confirmation_id IS DISTINCT FROM OLD.confirmation_id THEN
    RAISE EXCEPTION 'confirmation consumption is immutable' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_order_fixed_fee_personal_guard BEFORE INSERT OR UPDATE ON zzsh_order.rental_order
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_fixed_fee_personal_order();
REVOKE ALL ON FUNCTION zzsh_order.guard_fixed_fee_personal_order() FROM PUBLIC;
COMMENT ON FUNCTION zzsh_order.guard_fixed_fee_personal_order()
  IS '对固定手续费订单执行版本化确认依据校验；不改变历史订单校验。';

--> statement-breakpoint
-- The scheduled-spread guard is attached after its financial dependencies.
CREATE FUNCTION zzsh_order.guard_scheduled_spread_personal_order() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.quote_snapshot#>>'{personal,schema}'='personal-quote-v6' THEN
      PERFORM zzsh_order.assert_scheduled_spread_order_v6(NEW);
    ELSIF EXISTS(SELECT 1 FROM zzsh_supply.listing_version v
      JOIN zzsh_supply.listing_publication pub ON pub.version_id=v.id AND pub.account_id=v.account_id AND pub.source='OWNER_DIRECT'
      WHERE v.id=NEW.listing_version_id AND v.account_id=NEW.account_id AND v.schema_version=2 AND v.origin='NATIVE'
        AND v.payload#>>'{quoteValues,mode}'='SPREAD'
        AND v.payload ? 'pricingPolicy'
    ) THEN RAISE EXCEPTION 'scheduled spread order requires its versioned confirmation' USING ERRCODE='40001'; END IF;
  ELSIF NEW.confirmation_id IS DISTINCT FROM OLD.confirmation_id THEN
    RAISE EXCEPTION 'confirmation consumption is immutable' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION zzsh_order.guard_scheduled_spread_personal_order() FROM PUBLIC;
COMMENT ON FUNCTION zzsh_order.guard_scheduled_spread_personal_order()
  IS '校验独立价差订单的冻结确认，禁止退回旧订单合同绕过生效价目。';

--> statement-breakpoint
-- Contract: settlement-posting-contract
-- Keep fixed-fee publication and posting gated until transaction tests pass.
DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint
   WHERE conrelid='zzsh_order.settlement_ledger_entry'::regclass AND conname='settlement_ledger_accounts';
  IF expression IS NULL THEN RAISE EXCEPTION 'settlement ledger account constraint is missing'; END IF;
  ALTER TABLE zzsh_order.settlement_ledger_entry DROP CONSTRAINT settlement_ledger_accounts;
  EXECUTE format('ALTER TABLE zzsh_order.settlement_ledger_entry ADD CONSTRAINT settlement_ledger_accounts CHECK((%s) OR (posting_id IS NOT NULL AND account_code IN (''PLATFORM_SERVICE_FEE'',''PLATFORM_MEMBER_DISCOUNT'')))',expression);
END $$;
COMMENT ON CONSTRAINT settlement_ledger_accounts ON zzsh_order.settlement_ledger_entry IS '限定资金流水科目，固定手续费订单单列平台手续费和会员优惠';

CREATE OR REPLACE FUNCTION zzsh_order.guard_settlement_ledger_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  batch record;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'settlement ledger entries are immutable' USING ERRCODE = '40001';
  END IF;
  SELECT p.order_id, p.payment_confirmation_id, p.captured_cents, v.input_snapshot->>'schema' AS settlement_schema,
         o.status, o.owner_user_id, o.renter_user_id
    INTO batch
    FROM zzsh_order.settlement_posting p
    JOIN zzsh_order.rental_order o ON o.id = p.order_id
    JOIN zzsh_order.settlement_version v ON v.id=p.settlement_version_id AND v.order_id=p.order_id
   WHERE p.id = NEW.posting_id
   FOR UPDATE OF o;
  IF NOT FOUND OR batch.status IS DISTINCT FROM 'PAID' THEN
    RAISE EXCEPTION 'settlement posting batch is sealed or not assembling' USING ERRCODE = '40001';
  END IF;
  IF NEW.account_code = 'CAPTURED_PAYMENT_SOURCE' THEN
    IF NEW.debit_cents <> batch.captured_cents OR NEW.credit_cents <> 0
       OR NEW.source_payment_confirmation_id IS DISTINCT FROM batch.payment_confirmation_id
       OR NEW.counterparty_user_id IS NOT NULL THEN
      RAISE EXCEPTION 'captured payment source entry is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.account_code = 'OWNER_AVAILABLE' THEN
    IF NEW.debit_cents <> 0 OR NEW.credit_cents <= 0
       OR NEW.counterparty_user_id IS DISTINCT FROM batch.owner_user_id
       OR NEW.source_payment_confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'owner available entry is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.account_code = 'RENTER_REFUND_PAYABLE' THEN
    IF NEW.debit_cents <> 0 OR NEW.credit_cents <= 0
       OR NEW.counterparty_user_id IS DISTINCT FROM batch.renter_user_id
       OR NEW.source_payment_confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'renter refund payable entry is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.account_code = 'PLATFORM_MANUAL_NET_ADJUSTMENT' THEN
    IF NEW.counterparty_user_id IS NOT NULL OR NEW.source_payment_confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'manual adjustment entry is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.account_code = 'PLATFORM_MEMBER_DISCOUNT' THEN
    IF batch.settlement_schema IS DISTINCT FROM 'settlement-version-v4'
       OR NEW.debit_cents <= 0 OR NEW.credit_cents <> 0
       OR NEW.counterparty_user_id IS NOT NULL OR NEW.source_payment_confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'fixed fee member discount entry is invalid' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.account_code = 'PLATFORM_SERVICE_FEE' THEN
    IF batch.settlement_schema IS DISTINCT FROM 'settlement-version-v4'
       OR NEW.debit_cents <> 0 OR NEW.credit_cents <= 0
       OR NEW.counterparty_user_id IS NOT NULL OR NEW.source_payment_confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'fixed fee service entry is invalid' USING ERRCODE = '23514';
    END IF;
  ELSE
    IF (batch.settlement_schema = 'settlement-version-v4' AND NEW.account_code IN ('PLATFORM_HAFF_SPREAD','PLATFORM_ITEM_SPREAD'))
       OR NEW.debit_cents <> 0 OR NEW.credit_cents <= 0
       OR NEW.counterparty_user_id IS NOT NULL OR NEW.source_payment_confirmation_id IS NOT NULL THEN
      RAISE EXCEPTION 'platform contribution entry is invalid' USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.check_settlement_posting_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_posting_id text;
  batch record;
  ord record;
  ver record;
  payment record;
  approval record;
  sums record;
  snapshot_captured numeric;
  snapshot_system_owner numeric;
  snapshot_system_refund numeric;
  snapshot_platform numeric;
  snapshot_fee numeric;
  applied_fee numeric;
  manual_gross numeric;
  payout_selected boolean;
  snapshot_haff numeric;
  snapshot_item numeric;
  snapshot_early numeric;
  is_fixed boolean;
  payout_quote jsonb;
  snapshot_gross numeric;
  snapshot_service numeric;
  applied_service numeric;
  snapshot_discount numeric;
  proposed_discount numeric;
  fixed_rate numeric;
  payable_ratio numeric;
  expected_owner numeric;
  expected_refund numeric;
  expected_platform numeric;
  expected_adjustment numeric;
BEGIN
  IF TG_TABLE_NAME = 'settlement_posting' THEN
    v_posting_id := NEW.id;
  ELSE
    v_posting_id := NEW.posting_id;
  END IF;
  SELECT * INTO batch FROM zzsh_order.settlement_posting WHERE id = v_posting_id;
  IF batch IS NULL THEN RETURN NULL; END IF;
  SELECT status, paid_confirmation_id, renter_user_id, owner_user_id, quote_snapshot, account_id, listing_version_id, content_hash, rule_release_id INTO ord
    FROM zzsh_order.rental_order WHERE id = batch.order_id;
  SELECT kind, early, version_hash, superseded_at, approval_request_id, input_snapshot INTO ver
    FROM zzsh_order.settlement_version WHERE id = batch.settlement_version_id AND order_id = batch.order_id;
  SELECT order_id, amount_cents, currency, disposition INTO payment
    FROM zzsh_order.payment_confirmation WHERE id = batch.payment_confirmation_id;
  IF ord IS NULL OR ord.status IS DISTINCT FROM 'COMPLETED' OR ord.paid_confirmation_id IS DISTINCT FROM batch.payment_confirmation_id
     OR ver IS NULL OR ver.superseded_at IS NOT NULL OR ver.version_hash IS DISTINCT FROM batch.version_hash
     OR ver.early IS DISTINCT FROM batch.early OR payment IS NULL OR payment.order_id IS DISTINCT FROM batch.order_id
     OR payment.disposition <> 'APPLIED' OR payment.currency <> 'CNY' OR payment.amount_cents <> batch.captured_cents THEN
    RAISE EXCEPTION 'posting header is not bound to a completed order and its applied payment' USING ERRCODE = '23514';
  END IF;
  IF ver.input_snapshot IS NULL OR ver.input_snapshot->>'kind' IS DISTINCT FROM ver.kind
     OR ver.input_snapshot->>'early' IS DISTINCT FROM batch.early::text THEN
    RAISE EXCEPTION 'posting header is not bound to its settlement snapshot' USING ERRCODE = '23514';
  END IF;
  is_fixed := COALESCE(ver.input_snapshot->>'schema' = 'settlement-version-v4',false);
  IF is_fixed IS DISTINCT FROM COALESCE(ord.quote_snapshot#>>'{personal,schema}' = 'personal-quote-v5',false) THEN
    RAISE EXCEPTION 'settlement and order pricing versions differ' USING ERRCODE = '23514';
  END IF;
  IF ord.quote_snapshot#>>'{personal,schema}'='personal-quote-v6' THEN
    payout_selected := zzsh_order.poststart_full_payout_selected(ord.quote_snapshot,ord.renter_user_id,ord.owner_user_id,ord.account_id,ord.listing_version_id,ord.content_hash,ord.rule_release_id);
    snapshot_gross := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,ownerGross}');
    snapshot_fee := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,feeAmount}');
    IF ver.input_snapshot->>'schema' IS DISTINCT FROM 'settlement-version-v3'
       OR ver.input_snapshot->>'personalQuoteSchema' IS DISTINCT FROM 'personal-quote-v6'
       OR payout_selected IS NULL OR jsonb_typeof(ver.input_snapshot->'fullPayoutSelected') IS DISTINCT FROM 'boolean'
       OR payout_selected IS DISTINCT FROM (ver.input_snapshot->>'fullPayoutSelected')::boolean
       OR snapshot_gross IS NULL OR snapshot_fee IS NULL
       OR snapshot_gross IS DISTINCT FROM (zzsh_order.settlement_snapshot_cents(ver.input_snapshot#>>'{amounts,haffConsumedOwner}')
         +zzsh_order.settlement_snapshot_cents(ver.input_snapshot#>>'{amounts,itemConsumedOwner}'))
       OR snapshot_fee IS DISTINCT FROM (CASE WHEN payout_selected THEN round(snapshot_gross*8/100) ELSE 0 END)
       OR zzsh_order.settlement_snapshot_cents(ver.input_snapshot#>>'{amounts,ownerNet}') IS DISTINCT FROM snapshot_gross-snapshot_fee
       OR NOT EXISTS(SELECT 1 FROM zzsh_order.rental_opening op WHERE op.order_id=batch.order_id AND op.id=ver.input_snapshot->>'openingId'
         AND op.status='CONFIRMED' AND op.version_no::text=ver.input_snapshot->>'openingVersion'
         AND op.quote_digest=ver.input_snapshot->>'quoteDigest' AND op.payment_digest=ver.input_snapshot->>'paymentDigest')
    THEN RAISE EXCEPTION 'scheduled spread settlement basis differs' USING ERRCODE='23514'; END IF;
  ELSIF ver.input_snapshot->>'personalQuoteSchema'='personal-quote-v6' THEN
    RAISE EXCEPTION 'scheduled spread settlement and order versions differ' USING ERRCODE='23514';
  END IF;
  IF is_fixed THEN
    IF ord.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '4'
       OR ord.quote_snapshot->>'mode' IS DISTINCT FROM 'PERCENT'
       OR ord.quote_snapshot#>>'{pricingInputs,fixedFeeAlgorithm}' IS DISTINCT FROM 'FIXED_TOTAL_V1'
       OR ord.quote_snapshot#>>'{settlementPricing,schema}' IS DISTINCT FROM 'settlement-pricing-v3'
       OR ord.quote_snapshot#>>'{personal,pricingPolicy,pricingModel}' IS DISTINCT FROM 'FIXED_FEE'
       OR COALESCE(ord.quote_snapshot#>>'{settlementPricing,fixedFeeRate}','') !~ '^(0|1)(\.[0-9]{1,8})?$'
       OR COALESCE(ord.quote_snapshot#>>'{settlementPricing,payableRatio}','') !~ '^(0|1)(\.[0-9]{1,8})?$'
       OR COALESCE(ord.quote_snapshot#>>'{pricingInputs,commissionRate}','') !~ '^(0|1)(\.[0-9]{1,8})?$'
    THEN RAISE EXCEPTION 'fixed fee order basis is incomplete' USING ERRCODE='23514'; END IF;
    fixed_rate := (ord.quote_snapshot#>>'{settlementPricing,fixedFeeRate}')::numeric;
    payable_ratio := (ord.quote_snapshot#>>'{settlementPricing,payableRatio}')::numeric;
    IF fixed_rate < 0 OR fixed_rate >= 1 OR payable_ratio < 0 OR payable_ratio > 1
       OR 1-payable_ratio > fixed_rate
       OR fixed_rate IS DISTINCT FROM (ord.quote_snapshot#>>'{pricingInputs,commissionRate}')::numeric THEN
      RAISE EXCEPTION 'fixed fee order rates are inconsistent' USING ERRCODE='23514';
    END IF;
    -- Reuse the existing identity-bound payout check without changing older cancellation behavior.
    payout_quote := jsonb_set(ord.quote_snapshot,'{personal,schema}',to_jsonb('personal-quote-v4'::text));
    payout_selected := zzsh_order.poststart_full_payout_selected(payout_quote,ord.renter_user_id,ord.owner_user_id,ord.account_id,ord.listing_version_id,ord.content_hash,ord.rule_release_id);
    IF payout_selected IS NULL OR jsonb_typeof(ver.input_snapshot->'fullPayoutSelected') IS DISTINCT FROM 'boolean'
       OR payout_selected IS DISTINCT FROM (ver.input_snapshot->>'fullPayoutSelected')::boolean THEN
      RAISE EXCEPTION 'fixed fee payout declaration is unavailable' USING ERRCODE='23514';
    END IF;
  END IF;
  -- Authorized support can finalize only the exact system version, with matching audit evidence.
  IF NOT EXISTS (
    SELECT 1 FROM zzsh_order.settlement_decision d
    JOIN zzsh_iam.audit_event a ON a.actor_type='admin' AND a.actor_id=d.subject_id
      AND a.action='order.settlement.support_finalized' AND a.object_type='rental_order'
      AND a.object_id=batch.order_id AND a.outcome='SUCCESS'
      AND a.details->>'settlementVersionId'=batch.settlement_version_id
      AND a.details->>'versionHash'=batch.version_hash AND a.details->>'reason'=d.reason
    JOIN zzsh_auth_admin."user" u ON u.id=d.subject_id AND NOT u.suspended
    WHERE d.settlement_version_id=batch.settlement_version_id AND d.party='SUPPORT'
      AND d.action='FINALIZE' AND d.version_hash=batch.version_hash AND ver.kind='SYSTEM'
      AND length(btrim(d.reason)) BETWEEN 3 AND 500
  ) THEN
  IF (SELECT count(*) FROM zzsh_order.settlement_decision
       WHERE settlement_version_id = batch.settlement_version_id AND party = 'RENTER'
         AND action = 'CONFIRM' AND subject_id = ord.renter_user_id AND version_hash = batch.version_hash) <> 1
     OR (SELECT count(*) FROM zzsh_order.settlement_decision
       WHERE settlement_version_id = batch.settlement_version_id AND party = 'OWNER'
         AND action = 'CONFIRM' AND subject_id = ord.owner_user_id AND version_hash = batch.version_hash) <> 1
     OR EXISTS (SELECT 1 FROM zzsh_order.settlement_decision
       WHERE settlement_version_id = batch.settlement_version_id AND party IN ('RENTER','OWNER') AND action = 'REJECT') THEN
    RAISE EXCEPTION 'posting requires both parties to confirm the same version' USING ERRCODE = '23514';
  END IF;
  IF batch.early AND NOT EXISTS (SELECT 1 FROM zzsh_order.settlement_decision
       WHERE settlement_version_id = batch.settlement_version_id AND party = 'SUPPORT' AND action = 'REVIEW'
         AND version_hash = batch.version_hash) THEN
    RAISE EXCEPTION 'early posting requires support review' USING ERRCODE = '23514';
  END IF;
  END IF;
  IF ver.kind = 'MANUAL_ADJUSTMENT' THEN
    SELECT status, requested_by, decided_by, operation_payload_hash, expires_at INTO approval
      FROM zzsh_iam.approval_request WHERE id = batch.approval_request_id;
    IF approval IS NULL OR approval.status <> 'APPROVED' OR approval.decided_by IS NULL
       OR approval.operation_payload_hash <> batch.version_hash
       OR approval.expires_at <= batch.posted_at OR batch.approval_request_id IS DISTINCT FROM ver.approval_request_id
       OR batch.approval_requested_by IS DISTINCT FROM approval.requested_by
       OR batch.approval_approved_by IS DISTINCT FROM approval.decided_by
       OR batch.approval_expires_at IS DISTINCT FROM approval.expires_at
       OR batch.approval_payload_hash IS DISTINCT FROM approval.operation_payload_hash
       OR batch.manual_reason IS DISTINCT FROM ver.input_snapshot->>'reason' THEN
      RAISE EXCEPTION 'posting requires the current valid manual approval' USING ERRCODE = '23514';
    END IF;
  ELSIF batch.approval_request_id IS NOT NULL OR batch.manual_reason IS NOT NULL THEN
    RAISE EXCEPTION 'system settlement cannot bind a manual approval' USING ERRCODE = '23514';
  END IF;

  snapshot_captured := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'capturedAmount');
  snapshot_system_owner := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,ownerNet}');
  snapshot_system_refund := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,renterRefund}');
  snapshot_platform := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,platformContribution}');
  snapshot_fee := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,feeAmount}');
  applied_fee := snapshot_fee;
  snapshot_haff := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,haffSpread}');
  snapshot_item := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,itemSpread}');
  snapshot_early := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,earlyMakeup}');
  applied_service := 0;
  IF is_fixed THEN
    snapshot_gross := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,ownerGross}');
    snapshot_service := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,platformServiceFee}');
    snapshot_discount := zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,membershipDiscount}');
    IF snapshot_gross IS NULL OR snapshot_service IS NULL OR snapshot_discount IS NULL OR snapshot_fee IS NULL
       OR snapshot_platform IS NULL OR snapshot_system_owner IS NULL OR snapshot_early IS NULL
       OR snapshot_haff IS NULL OR snapshot_item IS NULL
       OR snapshot_service IS DISTINCT FROM round(snapshot_gross*fixed_rate)
       OR snapshot_discount IS DISTINCT FROM snapshot_gross-round(snapshot_gross*payable_ratio)
       OR snapshot_discount > snapshot_service
       OR snapshot_fee IS DISTINCT FROM (CASE WHEN payout_selected THEN round(snapshot_gross*8/100) ELSE 0 END)
       OR ver.input_snapshot #>> '{amounts,feePayer}' IS DISTINCT FROM (CASE WHEN payout_selected THEN 'OWNER' ELSE 'NONE' END)
       OR ver.input_snapshot #>> '{amounts,feeRate}' IS DISTINCT FROM (CASE WHEN payout_selected THEN '0.08' ELSE '0' END)
       OR (payout_selected AND zzsh_order.settlement_snapshot_cents(ver.input_snapshot #>> '{amounts,feeBase}') IS DISTINCT FROM snapshot_gross)
       OR snapshot_gross < snapshot_service+snapshot_fee
       OR snapshot_system_owner IS DISTINCT FROM snapshot_gross-snapshot_service-snapshot_fee
       OR snapshot_haff+snapshot_item IS DISTINCT FROM snapshot_service-snapshot_discount
       OR snapshot_platform IS DISTINCT FROM snapshot_service-snapshot_discount+snapshot_early+snapshot_fee THEN
      RAISE EXCEPTION 'fixed fee settlement amounts are inconsistent' USING ERRCODE='23514';
    END IF;
    applied_service := snapshot_service;
  END IF;
  IF ver.kind = 'MANUAL_ADJUSTMENT' THEN
    expected_owner := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedOwnerNet');
    expected_refund := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedRenterRefund');
    IF ver.input_snapshot ? 'proposedOwnerGross' THEN
      manual_gross := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedOwnerGross');
      applied_fee := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedFullPayoutFee');
      IF NOT is_fixed THEN
        payout_selected := CASE WHEN jsonb_typeof(ver.input_snapshot->'fullPayoutSelected')='boolean'
          THEN (ver.input_snapshot->>'fullPayoutSelected')::boolean ELSE NULL END;
      ELSE
        applied_service := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedPlatformServiceFee');
        -- The adjusted discount is for distribution only; the ledger retains the actual system discount.
        proposed_discount := zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedMembershipDiscount');
      END IF;
      IF manual_gross IS NULL OR applied_fee IS NULL OR payout_selected IS NULL
         OR (NOT is_fixed AND zzsh_order.poststart_full_payout_selected(ord.quote_snapshot,ord.renter_user_id,ord.owner_user_id,ord.account_id,ord.listing_version_id,ord.content_hash,ord.rule_release_id) IS DISTINCT FROM payout_selected)
         OR applied_fee<>(CASE WHEN payout_selected THEN round(manual_gross*8/100) ELSE 0 END)
         OR (is_fixed AND (applied_service IS NULL OR proposed_discount IS NULL
           OR applied_service IS DISTINCT FROM round(manual_gross*fixed_rate)
           OR proposed_discount IS DISTINCT FROM round(manual_gross*(1-payable_ratio))))
         OR expected_owner IS DISTINCT FROM manual_gross-applied_fee-applied_service
         OR manual_gross+expected_refund>snapshot_captured THEN
        RAISE EXCEPTION 'manual settlement owner fee differs from the accepted basis' USING ERRCODE='23514';
      END IF;
    ELSIF is_fixed OR ver.input_snapshot->>'fullPayoutSelected'='true' THEN
      RAISE EXCEPTION 'manual settlement owner fee requires reconfirmation' USING ERRCODE='23514';
    END IF;
  ELSE
    expected_owner := snapshot_system_owner;
    expected_refund := snapshot_system_refund;
  END IF;
  IF snapshot_captured IS NULL OR snapshot_system_owner IS NULL OR snapshot_system_refund IS NULL OR snapshot_platform IS NULL
     OR snapshot_fee IS NULL OR snapshot_haff IS NULL OR snapshot_item IS NULL OR snapshot_early IS NULL
     OR expected_owner IS NULL OR expected_refund IS NULL THEN
    RAISE EXCEPTION 'settlement amount snapshot is incomplete' USING ERRCODE = '23514';
  END IF;
  expected_adjustment := snapshot_system_owner + snapshot_system_refund - expected_owner - expected_refund
    - (applied_fee-snapshot_fee) - (CASE WHEN is_fixed THEN applied_service-snapshot_service ELSE 0 END);
  expected_platform := snapshot_platform + (applied_fee-snapshot_fee) + expected_adjustment
    + (CASE WHEN is_fixed THEN applied_service-snapshot_service ELSE 0 END);
  IF batch.captured_cents <> snapshot_captured OR batch.system_owner_net_cents <> snapshot_system_owner
     OR batch.system_renter_refund_cents <> snapshot_system_refund OR batch.owner_net_cents <> expected_owner
     OR batch.renter_refund_cents <> expected_refund OR batch.platform_contribution_cents <> expected_platform
     OR batch.compensation_fee_cents <> applied_fee OR batch.captured_cents <> batch.owner_net_cents + batch.renter_refund_cents + batch.platform_contribution_cents THEN
    RAISE EXCEPTION 'posting header does not match the accepted settlement amounts' USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer AS line_count,
         COALESCE(sum(debit_cents),0) AS debit_cents,
         COALESCE(sum(credit_cents),0) AS credit_cents,
         count(*) FILTER (WHERE account_code = 'CAPTURED_PAYMENT_SOURCE') AS source_count,
         COALESCE(sum(debit_cents) FILTER (WHERE account_code = 'CAPTURED_PAYMENT_SOURCE'),0) AS source_debit,
         COALESCE(sum(credit_cents) FILTER (WHERE account_code = 'CAPTURED_PAYMENT_SOURCE'),0) AS source_credit,
         count(*) FILTER (WHERE account_code = 'OWNER_AVAILABLE') AS owner_count,
         COALESCE(sum(credit_cents) FILTER (WHERE account_code = 'OWNER_AVAILABLE'),0) AS owner_cents,
         COALESCE(sum(debit_cents) FILTER (WHERE account_code = 'OWNER_AVAILABLE'),0) AS owner_debits,
         count(*) FILTER (WHERE account_code = 'RENTER_REFUND_PAYABLE') AS refund_count,
         COALESCE(sum(credit_cents) FILTER (WHERE account_code = 'RENTER_REFUND_PAYABLE'),0) AS refund_cents,
         COALESCE(sum(debit_cents) FILTER (WHERE account_code = 'RENTER_REFUND_PAYABLE'),0) AS refund_debits,
         count(*) FILTER (WHERE account_code = 'PLATFORM_HAFF_SPREAD') AS haff_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_HAFF_SPREAD'),0) AS haff_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_ITEM_SPREAD') AS item_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_ITEM_SPREAD'),0) AS item_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_SERVICE_FEE') AS service_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_SERVICE_FEE'),0) AS service_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_MEMBER_DISCOUNT') AS discount_count,
         COALESCE(sum(debit_cents - credit_cents) FILTER (WHERE account_code = 'PLATFORM_MEMBER_DISCOUNT'),0) AS discount_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_EARLY_MAKEUP') AS early_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_EARLY_MAKEUP'),0) AS early_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_COMPENSATION_FEE') AS fee_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_COMPENSATION_FEE'),0) AS fee_cents,
         count(*) FILTER (WHERE account_code = 'PLATFORM_MANUAL_NET_ADJUSTMENT') AS adjustment_count,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code = 'PLATFORM_MANUAL_NET_ADJUSTMENT'),0) AS adjustment_cents,
         COALESCE(sum(credit_cents - debit_cents) FILTER (WHERE account_code LIKE 'PLATFORM_%'),0) AS platform_cents
    INTO sums FROM zzsh_order.settlement_ledger_entry AS entry WHERE entry.posting_id = v_posting_id;
  IF sums.line_count < 2 OR sums.debit_cents <> sums.credit_cents OR sums.source_count <> 1
     OR sums.source_debit <> batch.captured_cents OR sums.source_credit <> 0
     OR sums.owner_count <> (CASE WHEN expected_owner = 0 THEN 0 ELSE 1 END) OR sums.owner_cents <> expected_owner OR sums.owner_debits <> 0
     OR sums.refund_count <> (CASE WHEN expected_refund = 0 THEN 0 ELSE 1 END) OR sums.refund_cents <> expected_refund OR sums.refund_debits <> 0
     OR (is_fixed AND (sums.haff_count<>0 OR sums.item_count<>0
       OR sums.service_count<>(CASE WHEN applied_service=0 THEN 0 ELSE 1 END) OR sums.service_cents<>applied_service
       OR sums.discount_count<>(CASE WHEN snapshot_discount=0 THEN 0 ELSE 1 END) OR sums.discount_cents<>snapshot_discount))
     OR (NOT is_fixed AND (sums.service_count<>0 OR sums.discount_count<>0
       OR sums.haff_count<>(CASE WHEN snapshot_haff=0 THEN 0 ELSE 1 END) OR sums.haff_cents<>snapshot_haff
       OR sums.item_count<>(CASE WHEN snapshot_item=0 THEN 0 ELSE 1 END) OR sums.item_cents<>snapshot_item))
     OR sums.early_count <> (CASE WHEN snapshot_early = 0 THEN 0 ELSE 1 END) OR sums.early_cents <> snapshot_early
     OR sums.fee_count <> (CASE WHEN applied_fee = 0 THEN 0 ELSE 1 END) OR sums.fee_cents <> applied_fee
     OR sums.adjustment_count <> (CASE WHEN expected_adjustment = 0 THEN 0 ELSE 1 END) OR sums.adjustment_cents <> expected_adjustment
     OR sums.platform_cents <> expected_platform THEN
    RAISE EXCEPTION 'settlement posting classifications are incomplete or inconsistent' USING ERRCODE = '23514';
  END IF;
  IF EXISTS (SELECT 1 FROM zzsh_order.settlement_ledger_entry e WHERE e.posting_id = v_posting_id AND (
       (e.account_code = 'CAPTURED_PAYMENT_SOURCE' AND
         (e.details->>'paymentConfirmationId' IS DISTINCT FROM batch.payment_confirmation_id
          OR e.details->>'disposition' IS DISTINCT FROM 'APPLIED'
          OR e.details->>'fundingSourceRef' IS DISTINCT FROM ver.input_snapshot->>'fundingSourceRef'))
       OR (e.account_code = 'OWNER_AVAILABLE' AND
         (e.details->>'settlementVersionId' IS DISTINCT FROM batch.settlement_version_id
          OR e.details->>'versionHash' IS DISTINCT FROM batch.version_hash
          OR e.details #>> '{systemGross,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,ownerGross}'
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemNet') IS DISTINCT FROM snapshot_system_owner
          OR zzsh_order.settlement_snapshot_cents(e.details->>'postedNet') IS DISTINCT FROM expected_owner
          OR e.details->>'feePayer' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feePayer}'
          OR e.details #>> '{compensationFee,amount}' IS DISTINCT FROM CASE WHEN manual_gross IS NULL THEN ver.input_snapshot #>> '{amounts,feeAmount}' ELSE ver.input_snapshot->>'proposedFullPayoutFee' END))
       OR (e.account_code = 'RENTER_REFUND_PAYABLE' AND
         (e.details->>'settlementVersionId' IS DISTINCT FROM batch.settlement_version_id
          OR e.details->>'versionHash' IS DISTINCT FROM batch.version_hash
          OR e.details->>'dueAt' IS NULL OR (e.details->>'dueAt')::timestamptz IS DISTINCT FROM batch.refund_due_at
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemRefund') IS DISTINCT FROM snapshot_system_refund
          OR e.details #>> '{depositRefund,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,depositRefund}'
          OR e.details #>> '{unusedItemRefund,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,unusedItemRefund}'
          OR e.details #>> '{unusedHaffRefund,amount}' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,unusedHaffRefund}'))
       OR (e.account_code = 'PLATFORM_HAFF_SPREAD' AND zzsh_order.settlement_snapshot_cents(e.details #>> '{amount,amount}') IS DISTINCT FROM snapshot_haff)
       OR (e.account_code = 'PLATFORM_ITEM_SPREAD' AND zzsh_order.settlement_snapshot_cents(e.details #>> '{amount,amount}') IS DISTINCT FROM snapshot_item)
       OR (e.account_code = 'PLATFORM_SERVICE_FEE' AND
         (zzsh_order.settlement_snapshot_cents(e.details #>> '{amount,amount}') IS DISTINCT FROM applied_service
          OR zzsh_order.settlement_snapshot_cents(e.details #>> '{systemAmount,amount}') IS DISTINCT FROM snapshot_service))
       OR (e.account_code = 'PLATFORM_MEMBER_DISCOUNT' AND
         zzsh_order.settlement_snapshot_cents(e.details #>> '{amount,amount}') IS DISTINCT FROM snapshot_discount)
       OR (e.account_code = 'PLATFORM_EARLY_MAKEUP' AND
         (zzsh_order.settlement_snapshot_cents(e.details #>> '{amount,amount}') IS DISTINCT FROM snapshot_early
          OR e.details->>'endReason' IS DISTINCT FROM ver.input_snapshot->>'endReason'))
       OR (e.account_code = 'PLATFORM_COMPENSATION_FEE' AND
         (e.details #>> '{base,amount}' IS DISTINCT FROM CASE WHEN manual_gross IS NULL THEN ver.input_snapshot #>> '{amounts,feeBase}' ELSE ver.input_snapshot->>'proposedOwnerGross' END
          OR e.details->>'rate' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feeRate}'
          OR e.details->>'payer' IS DISTINCT FROM ver.input_snapshot #>> '{amounts,feePayer}'
          OR e.details->>'policyVersion' IS DISTINCT FROM ver.input_snapshot->>'feePolicyVersion'))
       OR (e.account_code = 'PLATFORM_MANUAL_NET_ADJUSTMENT' AND
         (e.details->>'reason' IS DISTINCT FROM ver.input_snapshot->>'reason'
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemOwnerNet') IS DISTINCT FROM snapshot_system_owner
          OR zzsh_order.settlement_snapshot_cents(e.details->>'postedOwnerNet') IS DISTINCT FROM expected_owner
          OR zzsh_order.settlement_snapshot_cents(e.details->>'systemRenterRefund') IS DISTINCT FROM snapshot_system_refund
          OR zzsh_order.settlement_snapshot_cents(e.details->>'postedRenterRefund') IS DISTINCT FROM expected_refund
          OR (manual_gross IS NOT NULL AND (CASE WHEN coalesce(e.details->>'deltaPayoutFee','')~'^-?(0|[1-9][0-9]*)\.[0-9]{2}$'
            THEN (e.details->>'deltaPayoutFee')::numeric*100 ELSE NULL END) IS DISTINCT FROM applied_fee-snapshot_fee)
          OR (is_fixed AND manual_gross IS NOT NULL AND (CASE WHEN coalesce(e.details->>'deltaPlatformServiceFee','')~'^-?(0|[1-9][0-9]*)\.[0-9]{2}$'
            THEN (e.details->>'deltaPlatformServiceFee')::numeric*100 ELSE NULL END) IS DISTINCT FROM applied_service-snapshot_service)))
     )) THEN
    RAISE EXCEPTION 'settlement posting details do not match the accepted settlement snapshot' USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END $$;

--> statement-breakpoint
-- Contract: support-cancel-contract
-- Keep fixed-fee cancellation gated until transaction and refund tests pass.
ALTER TABLE zzsh_order.support_poststart_cancellation
  ADD COLUMN platform_service_fee_cents numeric(24,0),
  ADD COLUMN fixed_fee_rate text,
  DROP CONSTRAINT support_poststart_owner_fee_shape,
  ADD CONSTRAINT support_poststart_owner_fee_shape CHECK (
    (platform_service_fee_cents IS NULL AND fixed_fee_rate IS NULL AND (
      (owner_gross_cents IS NULL AND full_payout_fee_cents IS NULL AND full_payout_selected IS NULL)
      OR (owner_gross_cents IS NOT NULL AND full_payout_fee_cents IS NOT NULL
        AND owner_gross_cents>=0 AND full_payout_fee_cents>=0 AND refund_cents+owner_gross_cents<=paid_cents
        AND owner_cents=owner_gross_cents-full_payout_fee_cents AND platform_cents>=full_payout_fee_cents
        AND CASE WHEN full_payout_selected IS TRUE THEN full_payout_fee_cents=round(owner_gross_cents*8/100)
          WHEN full_payout_selected IS FALSE THEN full_payout_fee_cents=0
          ELSE owner_gross_cents=0 AND full_payout_fee_cents=0 END)))
    OR (platform_service_fee_cents IS NOT NULL AND fixed_fee_rate IS NOT NULL AND
      CASE WHEN fixed_fee_rate ~ '^(0|1)(\.[0-9]{1,8})?$' THEN
        fixed_fee_rate::numeric >= 0 AND fixed_fee_rate::numeric < 1
        AND owner_gross_cents IS NOT NULL AND full_payout_fee_cents IS NOT NULL AND full_payout_selected IS NOT NULL
        AND owner_gross_cents>=0 AND full_payout_fee_cents>=0 AND platform_service_fee_cents>=0
        AND platform_service_fee_cents=round(owner_gross_cents*fixed_fee_rate::numeric)
        AND refund_cents+owner_gross_cents<=paid_cents
        AND owner_cents=owner_gross_cents-full_payout_fee_cents-platform_service_fee_cents
        AND platform_cents>=full_payout_fee_cents+platform_service_fee_cents
        AND full_payout_fee_cents=CASE WHEN full_payout_selected THEN round(owner_gross_cents*8/100) ELSE 0 END
      ELSE false END)
  );
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.platform_service_fee_cents IS '固定手续费模式按号主毛收入扣除的平台手续费，单位分；旧记录为空';
COMMENT ON COLUMN zzsh_order.support_poststart_cancellation.fixed_fee_rate IS '取消订单冻结的固定手续费率；旧记录为空';
COMMENT ON CONSTRAINT support_poststart_owner_fee_shape ON zzsh_order.support_poststart_cancellation IS '按订单原计价模式约束特殊取消毛收入、手续费和入账';

DO $$
DECLARE expression text;
BEGIN
  SELECT pg_get_expr(conbin,conrelid) INTO expression FROM pg_constraint
   WHERE conrelid='zzsh_order.settlement_ledger_entry'::regclass AND conname='settlement_ledger_accounts';
  IF expression IS NULL THEN RAISE EXCEPTION 'settlement ledger account constraint is missing'; END IF;
  ALTER TABLE zzsh_order.settlement_ledger_entry DROP CONSTRAINT settlement_ledger_accounts;
  EXECUTE format('ALTER TABLE zzsh_order.settlement_ledger_entry ADD CONSTRAINT settlement_ledger_accounts CHECK((%s) OR (finance_event_id IS NOT NULL AND account_code=''PLATFORM_SERVICE_FEE'' AND details ? ''supportCancellationId''))',expression);
END $$;

CREATE FUNCTION zzsh_order.fixed_fee_poststart_rate(quote_value jsonb,renter_value text,owner_value text,account_value text,listing_value text,hash_value text,release_value text)
RETURNS text LANGUAGE plpgsql IMMUTABLE PARALLEL SAFE AS $$
DECLARE rate_value text:=quote_value#>>'{settlementPricing,fixedFeeRate}';
BEGIN
 IF quote_value#>>'{personal,schema}' IS DISTINCT FROM 'personal-quote-v5'
   OR quote_value->>'schemaVersion' IS DISTINCT FROM '4' OR quote_value->>'mode' IS DISTINCT FROM 'PERCENT'
   OR quote_value#>>'{pricingInputs,fixedFeeAlgorithm}' IS DISTINCT FROM 'FIXED_TOTAL_V1'
   OR quote_value#>>'{settlementPricing,schema}' IS DISTINCT FROM 'settlement-pricing-v3'
   OR quote_value#>>'{personal,pricingPolicy,pricingModel}' IS DISTINCT FROM 'FIXED_FEE'
   OR quote_value#>>'{personal,pricingPolicy,priceVersionId}' IS DISTINCT FROM quote_value->>'priceVersionId'
   OR quote_value#>>'{settlementPricing,priceVersionId}' IS DISTINCT FROM quote_value->>'priceVersionId'
   OR coalesce(rate_value,'') !~ '^(0|1)(\.[0-9]{1,8})?$'
   OR coalesce(quote_value#>>'{pricingInputs,commissionRate}','') !~ '^(0|1)(\.[0-9]{1,8})?$'
 THEN RETURN NULL; END IF;
 IF rate_value::numeric<0 OR rate_value::numeric>=1 OR rate_value::numeric IS DISTINCT FROM (quote_value#>>'{pricingInputs,commissionRate}')::numeric
   OR zzsh_order.poststart_full_payout_selected(jsonb_set(quote_value,'{personal,schema}',to_jsonb('personal-quote-v4'::text)),renter_value,owner_value,account_value,listing_value,hash_value,release_value) IS NULL
 THEN RETURN NULL; END IF;
 RETURN rate_value;
END $$;
COMMENT ON FUNCTION zzsh_order.fixed_fee_poststart_rate(jsonb,text,text,text,text,text,text) IS '校验订单冻结的固定手续费依据并返回费率；无法核实时返回空';

CREATE OR REPLACE FUNCTION zzsh_order.guard_support_poststart_cancellation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE o zzsh_order.rental_order;c zzsh_order.payment_confirmation;expected text;rate_value text;selected boolean;is_fixed boolean;
BEGIN
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=NEW.order_id FOR UPDATE;
 SELECT * INTO c FROM zzsh_order.payment_confirmation WHERE id=NEW.payment_confirmation_id AND order_id=NEW.order_id;
 is_fixed:=COALESCE(o.quote_snapshot#>>'{personal,schema}'='personal-quote-v5',false);
 IF is_fixed THEN
  rate_value:=zzsh_order.fixed_fee_poststart_rate(o.quote_snapshot,o.renter_user_id,o.owner_user_id,o.account_id,o.listing_version_id,o.content_hash,o.rule_release_id);
  selected:=zzsh_order.poststart_full_payout_selected(jsonb_set(o.quote_snapshot,'{personal,schema}',to_jsonb('personal-quote-v4'::text)),o.renter_user_id,o.owner_user_id,o.account_id,o.listing_version_id,o.content_hash,o.rule_release_id);
  IF rate_value IS NULL OR selected IS NULL OR NEW.fixed_fee_rate IS DISTINCT FROM rate_value
    OR NEW.platform_service_fee_cents IS NULL OR NEW.platform_service_fee_cents IS DISTINCT FROM round(NEW.owner_gross_cents*rate_value::numeric)
  THEN RAISE EXCEPTION 'poststart fixed fee basis unavailable' USING ERRCODE='23514';END IF;
  expected:=encode(sha256(convert_to(jsonb_build_array(NEW.order_id,NEW.payment_confirmation_id,NEW.owner_user_id,NEW.renter_user_id,
   NEW.paid_cents::text,NEW.refund_cents::text,NEW.owner_cents::text,NEW.platform_cents::text,NEW.reason,NEW.owner_gross_cents::text,
   NEW.full_payout_fee_cents::text,NEW.full_payout_selected,'fixed-fee-v1',NEW.fixed_fee_rate,NEW.platform_service_fee_cents::text)::text,'UTF8')),'hex');
 ELSE
  IF NEW.fixed_fee_rate IS NOT NULL OR NEW.platform_service_fee_cents IS NOT NULL THEN
   RAISE EXCEPTION 'legacy cancellation cannot use fixed fee fields' USING ERRCODE='23514';END IF;
  selected:=zzsh_order.poststart_full_payout_selected(o.quote_snapshot,o.renter_user_id,o.owner_user_id,o.account_id,o.listing_version_id,o.content_hash,o.rule_release_id);
  expected:=encode(sha256(convert_to(jsonb_build_array(NEW.order_id,NEW.payment_confirmation_id,NEW.owner_user_id,NEW.renter_user_id,
   NEW.paid_cents::text,NEW.refund_cents::text,NEW.owner_cents::text,NEW.platform_cents::text,NEW.reason,NEW.owner_gross_cents::text,NEW.full_payout_fee_cents::text,NEW.full_payout_selected)::text,'UTF8')),'hex');
 END IF;
 IF current_user IS DISTINCT FROM (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=TG_RELID)
  OR o.id IS NULL OR o.status<>'PAID' OR c.id IS NULL OR c.id IS DISTINCT FROM o.paid_confirmation_id
  OR c.disposition<>'APPLIED' OR c.currency<>'CNY' OR c.source NOT IN('JOINPAY','CONTROLLED')
  OR (c.source='CONTROLLED' AND NOT EXISTS(SELECT 1 FROM zzsh_order.distribution_order_admission a
    JOIN pg_database db ON db.datname=current_database()
    WHERE a.order_id=o.id AND a.mode='LOCAL_CONTROLLED' AND a.resource_oid=db.oid AND a.resource_name=current_database()
     AND a.resource_marker=shobj_description(db.oid,'pg_database') AND a.active
     AND a.admitted_at<=clock_timestamp() AND a.expires_at>clock_timestamp()))
  OR c.amount_cents IS DISTINCT FROM NEW.paid_cents OR c.amount_cents IS DISTINCT FROM o.rental_amount_cents+o.deposit_amount_cents
  OR o.owner_user_id IS DISTINCT FROM NEW.owner_user_id OR o.renter_user_id IS DISTINCT FROM NEW.renter_user_id
  OR NEW.owner_gross_cents IS NULL OR NEW.full_payout_fee_cents IS NULL
  OR NEW.full_payout_selected IS DISTINCT FROM selected
  OR (NEW.full_payout_selected IS NULL AND NEW.owner_gross_cents<>0)
  OR NEW.source_digest IS DISTINCT FROM expected
  OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin'
  OR current_setting('zzsh.actor_id',true) IS DISTINCT FROM NEW.admin_user_id
  OR current_setting('zzsh.session_id',true) IS DISTINCT FROM NEW.admin_session_id
  OR current_setting('zzsh.request_id',true) IS DISTINCT FROM NEW.request_id
  OR NOT EXISTS(SELECT 1 FROM zzsh_auth_admin.session s WHERE s.id=NEW.admin_session_id AND s."userId"=NEW.admin_user_id
    AND NOT s.locked AND s."expiresAt">clock_timestamp())
  OR NOT EXISTS(SELECT 1 FROM zzsh_order.rental_opening x WHERE x.order_id=o.id AND (x.status='CONFIRMED'
    OR (SELECT count(DISTINCT a.party) FROM zzsh_order.rental_opening_ack a WHERE a.opening_id=x.id AND a.version_no=x.version_no)=2))
  OR EXISTS(SELECT 1 FROM zzsh_order.settlement_posting p WHERE p.order_id=o.id)
  OR EXISTS(SELECT 1 FROM zzsh_order.rental_referral_earning e WHERE e.order_id=o.id AND e.amount_cents>0 AND e.state<>'REVOKED')
  OR EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.order_id=o.id AND i.budget_disposition<>'RELEASED')
  OR EXISTS(SELECT 1 FROM zzsh_order.prestart_termination t WHERE t.order_id=o.id AND t.state<>'REJECTED')
  OR (NEW.owner_cents>0 AND NOT EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage w WHERE w.user_id=o.owner_user_id))
 THEN RAISE EXCEPTION 'poststart cancellation original facts unavailable' USING ERRCODE='23514';END IF;
 NEW.created_xid:=pg_current_xact_id();NEW.created_at:=clock_timestamp();RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.guard_support_poststart_entry() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p zzsh_order.support_poststart_cancellation;e zzsh_order.finance_event;source text;
BEGIN
 SELECT * INTO p FROM zzsh_order.support_poststart_cancellation WHERE id=NEW.details->>'supportCancellationId';
 SELECT * INTO e FROM zzsh_order.finance_event WHERE id=NEW.finance_event_id;
 SELECT c.source INTO source FROM zzsh_order.payment_confirmation c WHERE c.id=p.payment_confirmation_id;
 IF p.id IS NULL OR e.id IS NULL OR p.created_xid<>pg_current_xact_id() OR e.created_xid<>pg_current_xact_id()
  OR e.id<>p.event_id OR e.kind<>'SUPPORT_CANCELLATION_RECOGNIZED' OR NEW.posting_id IS NOT NULL
  OR NEW.details IS DISTINCT FROM jsonb_build_object('supportCancellationId',p.id,'orderId',p.order_id,
    'paymentConfirmationId',p.payment_confirmation_id,'dataOrigin',CASE source WHEN 'JOINPAY' THEN 'JOINPAY_LOCAL_ACCEPTANCE' ELSE 'LOCAL_CONTROLLED' END)
  OR NOT((NEW.line_no=1 AND NEW.account_code='CAPTURED_PAYMENT_SOURCE' AND NEW.debit_cents=p.paid_cents AND NEW.credit_cents=0
      AND NEW.counterparty_user_id IS NULL AND NEW.source_payment_confirmation_id=p.payment_confirmation_id)
   OR(p.refund_cents>0 AND NEW.line_no=2 AND NEW.account_code='RENTER_REFUND_PAYABLE' AND NEW.debit_cents=0 AND NEW.credit_cents=p.refund_cents
      AND NEW.counterparty_user_id=p.renter_user_id AND NEW.source_payment_confirmation_id IS NULL)
   OR(p.owner_cents>0 AND NEW.line_no=2+(p.refund_cents>0)::integer AND NEW.account_code='OWNER_AVAILABLE' AND NEW.debit_cents=0 AND NEW.credit_cents=p.owner_cents
      AND NEW.counterparty_user_id=p.owner_user_id AND NEW.source_payment_confirmation_id IS NULL)
   OR(p.platform_cents>coalesce(p.full_payout_fee_cents,0)+coalesce(p.platform_service_fee_cents,0) AND NEW.line_no=2+(p.refund_cents>0)::integer+(p.owner_cents>0)::integer
      AND NEW.account_code='PLATFORM_CANCELLATION_CONTRIBUTION' AND NEW.debit_cents=0 AND NEW.credit_cents=p.platform_cents-coalesce(p.full_payout_fee_cents,0)-coalesce(p.platform_service_fee_cents,0)
      AND NEW.counterparty_user_id IS NULL AND NEW.source_payment_confirmation_id IS NULL)
   OR(coalesce(p.full_payout_fee_cents,0)>0 AND NEW.line_no=2+(p.refund_cents>0)::integer+(p.owner_cents>0)::integer
      +(p.platform_cents>coalesce(p.full_payout_fee_cents,0)+coalesce(p.platform_service_fee_cents,0))::integer
      AND NEW.account_code='PLATFORM_COMPENSATION_FEE' AND NEW.debit_cents=0 AND NEW.credit_cents=p.full_payout_fee_cents
      AND NEW.counterparty_user_id IS NULL AND NEW.source_payment_confirmation_id IS NULL)
   OR(coalesce(p.platform_service_fee_cents,0)>0 AND NEW.line_no=2+(p.refund_cents>0)::integer+(p.owner_cents>0)::integer
      +(p.platform_cents>coalesce(p.full_payout_fee_cents,0)+coalesce(p.platform_service_fee_cents,0))::integer+(coalesce(p.full_payout_fee_cents,0)>0)::integer
      AND NEW.account_code='PLATFORM_SERVICE_FEE' AND NEW.debit_cents=0 AND NEW.credit_cents=p.platform_service_fee_cents
      AND NEW.counterparty_user_id IS NULL AND NEW.source_payment_confirmation_id IS NULL))
 THEN RAISE EXCEPTION 'poststart cancellation entry differs' USING ERRCODE='23514';END IF;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.guard_support_poststart_root() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p zzsh_order.support_poststart_cancellation;
BEGIN
 SELECT * INTO p FROM zzsh_order.support_poststart_cancellation WHERE root_id=NEW.id;
 IF p.id IS NULL OR p.created_xid IS DISTINCT FROM pg_current_xact_id() OR NEW.basis_id IS NOT NULL
  OR NEW.source_type<>'NATIVE' OR NEW.source_system<>'zzsh' OR NEW.source_entity<>'support_poststart_cancellation'
  OR NEW.source_id<>p.id OR NEW.subject_user_id<>p.owner_user_id OR NEW.beneficiary_role<>'OWNER'
  OR NEW.policy_version<>(CASE WHEN p.fixed_fee_rate IS NULL THEN 'support-cancellation-v1' ELSE 'support-cancellation-v2' END) OR NEW.source_digest<>p.source_digest
 THEN RAISE EXCEPTION 'poststart cancellation root differs' USING ERRCODE='23514';END IF;
 INSERT INTO zzsh_order.wallet_revision(user_id,ledger_revision,read_revision)
  VALUES(p.owner_user_id,0,0),(p.renter_user_id,0,0) ON CONFLICT(user_id) DO NOTHING;
 RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION zzsh_order.support_poststart_cancellation_complete(case_value text) RETURNS boolean LANGUAGE sql VOLATILE AS $$
 SELECT COALESCE(EXISTS(SELECT 1 FROM zzsh_order.support_poststart_cancellation p
  JOIN zzsh_order.rental_order o ON o.id=p.order_id
  JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id AND c.order_id=o.id
  JOIN zzsh_order.finance_economic_root r ON r.id=p.root_id
  JOIN zzsh_order.finance_event e ON e.id=p.event_id AND e.economic_root_id=r.id
  JOIN zzsh_order.wallet_revision w ON w.user_id=p.owner_user_id
  WHERE p.id=case_value AND o.status='CANCELLED' AND o.cancel_reason='SUPPORT_AFTER_START_CANCELLED'
   AND o.paid_confirmation_id=c.id AND c.disposition='APPLIED' AND c.currency='CNY' AND c.amount_cents=p.paid_cents
   AND o.owner_user_id=p.owner_user_id AND o.renter_user_id=p.renter_user_id
   AND r.source_kind='NATIVE_SUPPORT_CANCELLATION' AND r.source_type='NATIVE' AND r.source_system='zzsh'
   AND r.source_entity='support_poststart_cancellation' AND r.source_id=p.id AND r.subject_user_id=p.owner_user_id
   AND r.beneficiary_role='OWNER' AND r.policy_version=CASE WHEN p.fixed_fee_rate IS NULL THEN 'support-cancellation-v1' ELSE 'support-cancellation-v2' END AND r.source_digest=p.source_digest
   AND e.kind='SUPPORT_CANCELLATION_RECOGNIZED' AND e.subject_user_id=p.owner_user_id AND w.ledger_revision>=e.expected_ledger_revision+1
   AND (SELECT count(*) FROM zzsh_order.finance_event x WHERE x.economic_root_id=r.id)=1
   AND (SELECT count(*) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)
      =1+(p.refund_cents>0)::integer+(p.owner_cents>0)::integer
        +(p.platform_cents>coalesce(p.full_payout_fee_cents,0)+coalesce(p.platform_service_fee_cents,0))::integer
        +(coalesce(p.full_payout_fee_cents,0)>0)::integer+(coalesce(p.platform_service_fee_cents,0)>0)::integer
   AND (SELECT coalesce(sum(debit_cents),0) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)=p.paid_cents
   AND (SELECT coalesce(sum(credit_cents),0) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id)=p.paid_cents
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_posting s WHERE s.order_id=o.id)
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.rental_referral_earning d WHERE d.order_id=o.id AND d.amount_cents>0 AND d.state<>'REVOKED')
   AND EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.action='order.support_poststart_cancel' AND a.object_type='support_poststart_cancellation'
    AND a.object_id=p.id AND a.outcome='SUCCESS' AND a.actor_type='admin' AND a.actor_id=p.admin_user_id
    AND a.session_id=p.admin_session_id AND a.request_id=p.request_id AND a.reason=p.reason
    AND a.details->>'sourceDigest'=p.source_digest)),false)
$$;

CREATE OR REPLACE FUNCTION zzsh_order.cancel_order_after_start_v3(order_value text,expected_revision bigint,refund_value numeric,owner_gross_value numeric,reason_value text)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE actor_value text:=current_setting('zzsh.actor_id',true);session_value text:=current_setting('zzsh.session_id',true);
 request_value text:=current_setting('zzsh.request_id',true);boss boolean;o zzsh_order.rental_order;c zzsh_order.payment_confirmation;
 owner_id text;renter_id text;game_value text;account_value text;case_id text;root_value text;event_value text;digest_value text;
 platform_value numeric;owner_value numeric;fee_value numeric;service_value numeric;rate_value text;full_payout boolean;revision_value bigint;line_value integer:=1;details_value jsonb;
BEGIN
 IF current_setting('transaction_isolation')<>'read committed' OR current_setting('zzsh.actor_type',true) IS DISTINCT FROM 'admin'
  OR coalesce(actor_value,'')='' OR coalesce(session_value,'')='' OR coalesce(request_value,'')=''
  OR order_value IS NULL OR order_value !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$' OR expected_revision IS NULL OR expected_revision<1
  OR refund_value IS NULL OR owner_gross_value IS NULL OR refund_value<>trunc(refund_value) OR owner_gross_value<>trunc(owner_gross_value)
  OR refund_value<0 OR owner_gross_value<0 OR refund_value>9999999999999999 OR owner_gross_value>9999999999999999
  OR reason_value IS NULL OR length(btrim(reason_value))<3 OR octet_length(reason_value)>600 OR reason_value<>btrim(reason_value)
  OR reason_value~'[[:cntrl:]]'
 THEN RAISE EXCEPTION 'poststart cancellation input invalid' USING ERRCODE='23514';END IF;
 SELECT sec.is_boss INTO boss FROM zzsh_iam.admin_security sec JOIN zzsh_auth_admin."user" u ON u.id=sec.admin_user_id
  JOIN zzsh_auth_admin.session s ON s."userId"=u.id AND s.id=session_value
  WHERE sec.admin_user_id=actor_value AND sec.status='ACTIVE' AND NOT sec.password_change_required AND NOT u.suspended
   AND u."twoFactorEnabled" IS TRUE AND NOT s.locked AND s."expiresAt">clock_timestamp() FOR SHARE OF sec,u,s;
 IF boss IS NULL THEN RAISE EXCEPTION 'poststart cancellation actor unavailable' USING ERRCODE='42501';END IF;
 SELECT q.owner_user_id,q.renter_user_id,q.game_id,q.account_id INTO owner_id,renter_id,game_value,account_value FROM zzsh_order.rental_order q WHERE q.id=order_value;
 IF owner_id IS NULL OR renter_id IS NULL THEN RAISE EXCEPTION 'poststart cancellation order unavailable' USING ERRCODE='23514';END IF;
 IF NOT boss AND (EXISTS(SELECT 1 FROM zzsh_iam.admin_user_permission d WHERE d.admin_user_id=actor_value AND d.permission_code='order.settlement.write' AND d.effect='DENY')
  OR NOT(EXISTS(SELECT 1 FROM zzsh_iam.admin_user_permission a WHERE a.admin_user_id=actor_value AND a.permission_code='order.settlement.write' AND a.effect='ALLOW')
   OR EXISTS(SELECT 1 FROM zzsh_iam.admin_user_role ur JOIN zzsh_iam.admin_role role ON role.id=ur.role_id AND role.status='ACTIVE'
    JOIN zzsh_iam.admin_role_permission rp ON rp.role_id=role.id WHERE ur.admin_user_id=actor_value AND rp.permission_code='order.settlement.write'))
  OR NOT EXISTS(SELECT 1 FROM zzsh_iam.admin_security sec WHERE sec.admin_user_id=actor_value AND (sec.game_scope_mode='ALL_GAMES'
   OR EXISTS(SELECT 1 FROM zzsh_supply.admin_supply_scope scope WHERE scope.admin_user_id=actor_value AND scope.game_id=game_value))))
 THEN RAISE EXCEPTION 'poststart cancellation permission unavailable' USING ERRCODE='42501';END IF;
 PERFORM id FROM zzsh_auth_user."user" WHERE id IN(owner_id,renter_id) ORDER BY id COLLATE "C" FOR UPDATE;
 PERFORM id FROM zzsh_supply.game WHERE id=game_value FOR SHARE;
 PERFORM id FROM zzsh_supply.rental_account WHERE id=account_value FOR UPDATE;
 SELECT * INTO o FROM zzsh_order.rental_order WHERE id=order_value FOR UPDATE;
 SELECT * INTO c FROM zzsh_order.payment_confirmation WHERE id=o.paid_confirmation_id AND order_id=o.id;
 IF o.id IS NULL OR o.owner_user_id IS DISTINCT FROM owner_id OR o.renter_user_id IS DISTINCT FROM renter_id
  OR o.game_id IS DISTINCT FROM game_value OR o.account_id IS DISTINCT FROM account_value OR o.status<>'PAID'
  OR o.revision<>expected_revision OR c.id IS NULL OR c.disposition<>'APPLIED' OR c.currency<>'CNY'
  OR c.amount_cents<=0 OR c.amount_cents>9999999999999999 OR c.amount_cents<>o.rental_amount_cents+o.deposit_amount_cents
  OR refund_value+owner_gross_value>c.amount_cents
 THEN RAISE EXCEPTION 'poststart cancellation amount or order changed' USING ERRCODE='23514';END IF;

 rate_value:=zzsh_order.fixed_fee_poststart_rate(o.quote_snapshot,o.renter_user_id,o.owner_user_id,o.account_id,o.listing_version_id,o.content_hash,o.rule_release_id);
 full_payout:=zzsh_order.poststart_full_payout_selected(jsonb_set(o.quote_snapshot,'{personal,schema}',to_jsonb('personal-quote-v4'::text)),o.renter_user_id,o.owner_user_id,o.account_id,o.listing_version_id,o.content_hash,o.rule_release_id);
 IF rate_value IS NULL OR full_payout IS NULL THEN RAISE EXCEPTION 'poststart fixed fee basis unknown' USING ERRCODE='23514';END IF;
 fee_value:=CASE WHEN full_payout IS TRUE THEN round(owner_gross_value*8/100) ELSE 0 END;
 service_value:=round(owner_gross_value*rate_value::numeric);
 owner_value:=owner_gross_value-fee_value-service_value;
 IF owner_value<0 THEN RAISE EXCEPTION 'poststart owner fees exceed income' USING ERRCODE='23514';END IF;
 platform_value:=c.amount_cents-refund_value-owner_value;
 case_id:='spcancel_'||substr(encode(sha256(convert_to(o.id,'UTF8')),'hex'),1,40);
 root_value:='spcancel_root_'||substr(encode(sha256(convert_to(o.id,'UTF8')),'hex'),1,40);
 event_value:='spcancel_event_'||substr(encode(sha256(convert_to(o.id,'UTF8')),'hex'),1,40);
 digest_value:=encode(sha256(convert_to(jsonb_build_array(o.id,c.id,owner_id,renter_id,c.amount_cents::text,
  refund_value::text,owner_value::text,platform_value::text,reason_value,owner_gross_value::text,fee_value::text,full_payout,'fixed-fee-v1',rate_value,service_value::text)::text,'UTF8')),'hex');
 INSERT INTO zzsh_order.support_poststart_cancellation(id,order_id,payment_confirmation_id,owner_user_id,renter_user_id,
  admin_user_id,admin_session_id,request_id,reason,paid_cents,refund_cents,owner_cents,platform_cents,source_digest,root_id,event_id,owner_gross_cents,full_payout_fee_cents,full_payout_selected,fixed_fee_rate,platform_service_fee_cents)
 VALUES(case_id,o.id,c.id,owner_id,renter_id,actor_value,session_value,request_value,reason_value,c.amount_cents,refund_value,owner_value,platform_value,digest_value,root_value,event_value,owner_gross_value,fee_value,full_payout,rate_value,service_value);
 INSERT INTO zzsh_order.finance_economic_root(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,policy_version,source_digest)
 VALUES(root_value,NULL,'NATIVE_SUPPORT_CANCELLATION','NATIVE','zzsh','support_poststart_cancellation',case_id,owner_id,'OWNER','support-cancellation-v2',digest_value);
 SELECT ledger_revision INTO revision_value FROM zzsh_order.wallet_revision WHERE user_id=owner_id;
 INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision)
 VALUES(event_value,root_value,'SUPPORT_CANCELLATION_RECOGNIZED',owner_id,revision_value);
 details_value:=jsonb_build_object('supportCancellationId',case_id,'orderId',o.id,'paymentConfirmationId',c.id,
  'dataOrigin',CASE c.source WHEN 'JOINPAY' THEN 'JOINPAY_LOCAL_ACCEPTANCE' ELSE 'LOCAL_CONTROLLED' END);
 INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,source_payment_confirmation_id,details)
 VALUES(event_value||'_1',event_value,line_value,'CAPTURED_PAYMENT_SOURCE',c.amount_cents,0,NULL,c.id,details_value);
 IF refund_value>0 THEN line_value:=line_value+1;
  INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
  VALUES(event_value||'_'||line_value,event_value,line_value,'RENTER_REFUND_PAYABLE',0,refund_value,renter_id,details_value);END IF;
 IF owner_value>0 THEN line_value:=line_value+1;
  INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
  VALUES(event_value||'_'||line_value,event_value,line_value,'OWNER_AVAILABLE',0,owner_value,owner_id,details_value);END IF;
 IF platform_value>fee_value+service_value THEN line_value:=line_value+1;
  INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
  VALUES(event_value||'_'||line_value,event_value,line_value,'PLATFORM_CANCELLATION_CONTRIBUTION',0,platform_value-fee_value-service_value,NULL,details_value);END IF;
 IF fee_value>0 THEN line_value:=line_value+1;
  INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
  VALUES(event_value||'_'||line_value,event_value,line_value,'PLATFORM_COMPENSATION_FEE',0,fee_value,NULL,details_value);END IF;
 IF service_value>0 THEN line_value:=line_value+1;
  INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
  VALUES(event_value||'_'||line_value,event_value,line_value,'PLATFORM_SERVICE_FEE',0,service_value,NULL,details_value);END IF;
 UPDATE zzsh_order.rental_order SET status='CANCELLED',cancel_reason='SUPPORT_AFTER_START_CANCELLED',cancelled_at=clock_timestamp(),
  revision=revision+1,updated_at=clock_timestamp() WHERE id=o.id AND status='PAID' AND revision=expected_revision;
 IF NOT FOUND THEN RAISE EXCEPTION 'poststart cancellation order changed' USING ERRCODE='40001';END IF;
 INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,reason,occurred_at,details)
 VALUES('audit_'||substr(encode(sha256(convert_to(case_id||request_value,'UTF8')),'hex'),1,40),'admin',actor_value,session_value,
  'order.support_poststart_cancel','support_poststart_cancellation',case_id,'SUCCESS',request_value,reason_value,clock_timestamp(),
  jsonb_build_object('orderId',o.id,'paymentConfirmationId',c.id,'paidCents',c.amount_cents::text,'refundCents',refund_value::text,
   'ownerCents',owner_value::text,'ownerGrossCents',owner_gross_value::text,'fullPayoutFeeCents',fee_value::text,'fullPayoutSelected',full_payout,'platformServiceFeeCents',service_value::text,'fixedFeeRate',rate_value,'platformCents',platform_value::text,'sourceDigest',digest_value,'channelResult','NOT_SUBMITTED'));
 RETURN jsonb_build_object('caseId',case_id,'orderId',o.id,'status','CANCELLED','paidCents',c.amount_cents::text,'refundCents',refund_value::text,
  'ownerCents',owner_value::text,'ownerGrossCents',owner_gross_value::text,'fullPayoutFeeCents',fee_value::text,'fullPayoutSelected',full_payout,'platformServiceFeeCents',service_value::text,'fixedFeeRate',rate_value,'platformContributionCents',platform_value::text,'commissionCents','0','channelResult','NOT_SUBMITTED');
END $$;
COMMENT ON FUNCTION zzsh_order.cancel_order_after_start_v3(text,bigint,numeric,numeric,text) IS '固定手续费订单客服特殊取消：按冻结费率及包赔费分配原款';
REVOKE ALL ON FUNCTION zzsh_order.cancel_order_after_start_v3(text,bigint,numeric,numeric,text),zzsh_order.fixed_fee_poststart_rate(jsonb,text,text,text,text,text,text) FROM PUBLIC;

--> statement-breakpoint
-- Contract: distribution-payment-contract
-- Preserve the installed ECS demo scope while extending the frozen payment contract.
DO $patch$
DECLARE source text; definition text; prior text; replacement text; digest text; idx integer;
 old_parts text[]:=ARRAY[
  $old$IF o.quote_snapshot->'schemaVersion'='2'::jsonb OR (o.quote_snapshot->'schemaVersion'='3'::jsonb$old$,
  $old$IF (cfg->>'schema'='distribution-policy.v3' OR cfg->>'schema'='distribution-policy.v4' AND cfg->>'baseMode'='LEGACY_RENTAL') THEN$old$,
  $old$IF uncertain OR total>base THEN items[i]:=jsonb_set(items[i],'{status}','"UNKNOWN_ESTIMATE_CONSERVATION"'::jsonb);
    ELSIF raw_amounts[i]=0 OR raw_amounts[i]<minimum THEN items[i]:=jsonb_set(items[i],'{status}','"SKIPPED_BELOW_MIN"'::jsonb);$old$
 ];
 new_parts text[]:=ARRAY[
  $new$IF o.quote_snapshot->'schemaVersion' IN ('2'::jsonb,'4'::jsonb) OR (o.quote_snapshot->'schemaVersion'='3'::jsonb$new$,
  $new$IF (cfg->>'schema'='distribution-policy.v3' OR cfg->>'schema'='distribution-policy.v4' AND cfg->>'baseMode'='LEGACY_RENTAL') AND o.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '4' THEN$new$,
  $new$IF uncertain OR (total>base AND o.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '4') THEN items[i]:=jsonb_set(items[i],'{status}','"UNKNOWN_ESTIMATE_CONSERVATION"'::jsonb);
    ELSIF total>base THEN NULL;
    ELSIF (raw_amounts[i]=0 OR raw_amounts[i]<minimum) AND o.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '4' THEN items[i]:=jsonb_set(items[i],'{status}','"SKIPPED_BELOW_MIN"'::jsonb);$new$
 ];
BEGIN
 IF to_regprocedure('zzsh_order.assert_fixed_fee_personal_order_v5(zzsh_order.rental_order)') IS NULL
 THEN RAISE EXCEPTION 'fixed fee order proof contract is required' USING ERRCODE='55000'; END IF;
 SELECT p.prosrc,pg_get_functiondef(p.oid) INTO source,definition FROM pg_proc p
  WHERE p.oid=to_regprocedure('zzsh_order.derive_payment_referral_inputs(text)')
    AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND NOT p.prosecdef;
 digest:=encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex');
 IF digest IS NULL OR digest NOT IN ('ccdb2fb81e27a2682d20b8afb74048f0693fc22a4a98588d2409bc3089233b07','f0e13c1b2604647d82b490aec3fae1adb4d75aa4413950387c343107508665ec')
 THEN RAISE EXCEPTION 'installed payment referral derivation is unrecognized' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,E'\r\n',E'\n');
 FOR idx IN 1..array_length(old_parts,1) LOOP
  prior:=old_parts[idx];replacement:=new_parts[idx];
  IF position(prior IN definition)=0 OR position(prior IN replace(definition,prior,''))<>0
  THEN RAISE EXCEPTION 'payment referral derivation patch is absent or ambiguous: %',idx USING ERRCODE='55000'; END IF;
  definition:=replace(definition,prior,replacement);
 END LOOP;
 EXECUTE definition;
END $patch$;

DO $patch$
DECLARE source text; definition text; prior text; replacement text; digest text; idx integer;
 old_parts text[]:=ARRAY[
  $old$doc->>'schema' IS DISTINCT FROM 'payment-distribution-basis.v1'$old$,
  $old$IF doc->'policyVersion' IS DISTINCT FROM derived->'policyVersion' OR doc->'policyDigest' IS DISTINCT FROM derived->'policyDigest'
  OR doc->'policyConfig' IS DISTINCT FROM derived->'policyConfig' OR doc->'accountMode' IS DISTINCT FROM derived->'accountMode'
  OR doc->'estimateBaseCents' IS DISTINCT FROM derived->'estimateBaseCents' OR doc->'roles' IS DISTINCT FROM derived->'roles'
 THEN RAISE EXCEPTION 'payment basis differs from original policy, role, relation or rounded estimate' USING ERRCODE='23514';END IF;
 IF derived->'estimateBaseCents'='null'::jsonb THEN$old$,
  $old$CASE WHEN (doc#>>'{policyConfig,schema}'='distribution-policy.v3' OR doc#>>'{policyConfig,schema}'='distribution-policy.v4' AND doc#>>'{policyConfig,baseMode}'='LEGACY_RENTAL') THEN 'LEGACY_RENTAL_QUOTE_HAFF_SPREAD_V1'$old$
 ];
 new_parts text[]:=ARRAY[
  $new$doc->>'schema' IS DISTINCT FROM (CASE WHEN order_row.quote_snapshot->>'schemaVersion'='4' THEN 'payment-distribution-basis.v2' ELSE 'payment-distribution-basis.v1' END)$new$,
  $new$IF doc->'policyVersion' IS DISTINCT FROM derived->'policyVersion' OR doc->'policyDigest' IS DISTINCT FROM derived->'policyDigest'
  OR doc->'policyConfig' IS DISTINCT FROM derived->'policyConfig' THEN
  RAISE EXCEPTION 'payment basis policy differs from its original source' USING ERRCODE='23514'; END IF;
 IF doc->>'schema'='payment-distribution-basis.v2' AND doc->'fixedFeePricing'='null'::jsonb THEN
  IF doc->'accountMode' IS DISTINCT FROM 'null'::jsonb OR doc->'estimateBaseCents' IS DISTINCT FROM 'null'::jsonb
   OR EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'roles') r
      LEFT JOIN LATERAL (SELECT value AS source FROM jsonb_array_elements(derived->'roles') WHERE value->>'role'=r->>'role') d ON true
      WHERE d.source IS NULL OR r->>'partyUserId' IS DISTINCT FROM
       (CASE r->>'role' WHEN 'OWNER_REFERRAL' THEN order_row.owner_user_id ELSE order_row.renter_user_id END)
      OR r->>'status' IS DISTINCT FROM (CASE WHEN derived->'policyConfig'='null'::jsonb THEN 'UNKNOWN_POLICY'
       WHEN derived#>>'{policyConfig,enabled}'='false' THEN 'SKIPPED_DISABLED' ELSE 'UNKNOWN_MODE' END)
      OR r->'beneficiaryUserId' IS DISTINCT FROM d.source->'beneficiaryUserId'
      OR r->'relationId' IS DISTINCT FROM d.source->'relationId' OR r->'relationDigest' IS DISTINCT FROM d.source->'relationDigest'
      OR r->'levelCode' IS DISTINCT FROM d.source->'levelCode'
      OR r->'ratio' IS DISTINCT FROM 'null'::jsonb OR r->'percent' IS DISTINCT FROM 'null'::jsonb OR r->'estimatedCents' IS DISTINCT FROM 'null'::jsonb)
  THEN RAISE EXCEPTION 'unknown fixed fee pricing cannot authorize referral eligibility' USING ERRCODE='23514'; END IF;
 ELSE
  IF doc->>'schema'='payment-distribution-basis.v2' AND (jsonb_typeof(doc->'fixedFeePricing') IS DISTINCT FROM 'object'
    OR doc->'fixedFeePricing' IS DISTINCT FROM jsonb_build_object('fixedFeeRate',order_row.quote_snapshot#>>'{settlementPricing,fixedFeeRate}',
       'payableRatio',order_row.quote_snapshot#>>'{settlementPricing,payableRatio}'))
  THEN RAISE EXCEPTION 'fixed fee pricing differs from the original order' USING ERRCODE='23514'; END IF;
  IF doc->'accountMode' IS DISTINCT FROM derived->'accountMode' OR doc->'estimateBaseCents' IS DISTINCT FROM derived->'estimateBaseCents'
    OR doc->'roles' IS DISTINCT FROM derived->'roles'
  THEN RAISE EXCEPTION 'payment basis differs from original role, relation or rounded estimate' USING ERRCODE='23514'; END IF;
 END IF;
 IF doc->'estimateBaseCents'='null'::jsonb THEN$new$,
  $new$CASE WHEN doc->>'schema'<>'payment-distribution-basis.v2' AND (doc#>>'{policyConfig,schema}'='distribution-policy.v3' OR doc#>>'{policyConfig,schema}'='distribution-policy.v4' AND doc#>>'{policyConfig,baseMode}'='LEGACY_RENTAL') THEN 'LEGACY_RENTAL_QUOTE_HAFF_SPREAD_V1'$new$
 ];
BEGIN
 SELECT p.prosrc,pg_get_functiondef(p.oid) INTO source,definition FROM pg_proc p
  WHERE p.oid=to_regprocedure('zzsh_order.guard_payment_distribution_basis()')
    AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND NOT p.prosecdef;
 digest:=encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex');
 IF digest IS DISTINCT FROM 'cbaa24ed55812c12c0a6228c682f3c2a326f3ac408f8da10b48e9e7f4d046ea2'
 THEN RAISE EXCEPTION 'installed payment referral guard is unrecognized' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,E'\r\n',E'\n');
 FOR idx IN 1..array_length(old_parts,1) LOOP
  prior:=old_parts[idx];replacement:=new_parts[idx];
  IF position(prior IN definition)=0 OR position(prior IN replace(definition,prior,''))<>0
  THEN RAISE EXCEPTION 'payment referral guard patch is absent or ambiguous: %',idx USING ERRCODE='55000'; END IF;
  definition:=replace(definition,prior,replacement);
 END LOOP;
 EXECUTE definition;
END $patch$;

--> statement-breakpoint
-- Contract: distribution-referral-derivation
-- Both individual earnings and task completion use this frozen derivation.
CREATE FUNCTION zzsh_order.derive_frozen_referral_accrual(posting_value text) RETURNS jsonb
LANGUAGE plpgsql STABLE AS $$
DECLARE
 p zzsh_order.settlement_posting;b zzsh_order.payment_distribution_basis;
 ord zzsh_order.rental_order;pay zzsh_order.payment_confirmation;ver zzsh_order.settlement_version;
 doc jsonb;payment_source jsonb;posting_source jsonb;posting_hash text;due_value timestamptz;due_text text;
 pricing jsonb;gross numeric;service numeric;discount numeric;rate numeric;payable numeric;base numeric;
 pair_role jsonb;n numeric;d numeric;commission numeric;pair_total numeric:=0;key_value text;item jsonb;items jsonb:='[]'::jsonb;
 allocation_hash text;fixed boolean;renter_n numeric:=0;renter_d numeric:=1;renter_rounded numeric:=0;
BEGIN
 SELECT * INTO p FROM zzsh_order.settlement_posting WHERE id=posting_value;
 IF p.id IS NULL THEN RAISE EXCEPTION 'original referral posting unavailable' USING ERRCODE='23514'; END IF;
 SELECT * INTO b FROM zzsh_order.payment_distribution_basis WHERE order_id=p.order_id AND payment_confirmation_id=p.payment_confirmation_id;
 SELECT * INTO ord FROM zzsh_order.rental_order WHERE id=p.order_id;
 SELECT * INTO pay FROM zzsh_order.payment_confirmation WHERE id=p.payment_confirmation_id AND order_id=p.order_id;
 IF b.id IS NULL OR ord.id IS NULL OR ord.status IS DISTINCT FROM 'COMPLETED' OR ord.paid_confirmation_id IS DISTINCT FROM p.payment_confirmation_id
  OR pay.id IS NULL OR pay.disposition IS DISTINCT FROM 'APPLIED' OR pay.currency IS DISTINCT FROM 'CNY'
  OR pay.amount_cents IS DISTINCT FROM p.captured_cents OR p.currency IS DISTINCT FROM pay.currency
 THEN RAISE EXCEPTION 'original referral order or payment unavailable' USING ERRCODE='23514'; END IF;
 doc:=b.canonical_basis::jsonb;
 payment_source:=jsonb_build_object('id',pay.id,'order_id',pay.order_id,'source',pay.source,'merchant_scope_id',pay.merchant_scope_id,
  'provider_transaction_id',pay.provider_transaction_id,'merchant_order_no',pay.merchant_order_no,'amount_cents',pay.amount_cents::text,
  'currency',pay.currency,'provider_paid_at',to_char(pay.provider_paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'accepted_at',to_char(pay.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 IF jsonb_typeof(doc) IS DISTINCT FROM 'object' OR COALESCE(doc->>'schema','') NOT IN ('payment-distribution-basis.v1','payment-distribution-basis.v2')
  OR doc->>'orderId' IS DISTINCT FROM p.order_id OR doc->>'confirmationId' IS DISTINCT FROM p.payment_confirmation_id
  OR doc->>'admissionId' IS DISTINCT FROM b.admission_id OR doc->>'admissionRevision' IS DISTINCT FROM b.admission_revision::text
  OR doc->>'gameId' IS DISTINCT FROM ord.game_id OR doc->>'currency' IS DISTINCT FROM ord.currency
  OR doc->>'acceptedAt' IS DISTINCT FROM to_char(pay.accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')
  OR doc->>'paymentDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(payment_source),'UTF8')),'hex')
  OR b.canonical_basis IS DISTINCT FROM zzsh_order.canonical_finance_json(doc)
  OR b.basis_digest IS DISTINCT FROM encode(sha256(convert_to(b.canonical_basis,'UTF8')),'hex')
  OR jsonb_typeof(doc->'policyConfig') IS DISTINCT FROM 'object' OR jsonb_typeof(doc->'policyVersion') IS DISTINCT FROM 'string'
  OR COALESCE(doc->>'policyVersion','')='' OR jsonb_typeof(doc->'policyDigest') IS DISTINCT FROM 'string'
  OR COALESCE(doc->>'policyDigest','') !~ '^[0-9a-f]{64}$'
  OR doc->>'policyDigest' IS DISTINCT FROM encode(sha256(convert_to(zzsh_order.canonical_finance_json(doc->'policyConfig'),'UTF8')),'hex')
  OR jsonb_typeof(doc->'roles') IS DISTINCT FROM 'array'
 THEN RAISE EXCEPTION 'original frozen referral basis unavailable' USING ERRCODE='23514'; END IF;
 IF jsonb_array_length(doc->'roles')<>2 OR (SELECT count(DISTINCT r->>'role') FROM jsonb_array_elements(doc->'roles') r
  WHERE r->>'role' IN ('RENTER_REFERRAL','OWNER_REFERRAL'))<>2
  OR COALESCE(doc#>>'{policyConfig,settlementDelayDays}','') !~ '^(0|[1-9][0-9]{0,5})$'
  OR COALESCE(doc#>>'{policyConfig,minimumAccrualCents}','') !~ '^(0|[1-9][0-9]{0,23})$'
  OR p.platform_contribution_cents<p.compensation_fee_cents
  OR p.manual_reason IS NOT NULL AND (p.approval_request_id IS NULL OR p.approval_requested_by IS NULL OR p.approval_approved_by IS NULL
   OR p.approval_payload_hash IS DISTINCT FROM p.version_hash OR p.approval_expires_at IS NULL OR p.approval_expires_at<=p.posted_at)
  OR p.owner_net_cents+p.renter_refund_cents+p.platform_contribution_cents<>p.captured_cents
 THEN RAISE EXCEPTION 'original referral facts are incomplete' USING ERRCODE='23514'; END IF;

 fixed:=doc->>'schema'='payment-distribution-basis.v2';
 IF fixed THEN
  SELECT * INTO ver FROM zzsh_order.settlement_version WHERE id=p.settlement_version_id AND order_id=p.order_id;
  pricing:=doc->'fixedFeePricing';
  IF ord.quote_snapshot->>'schemaVersion' IS DISTINCT FROM '4' OR ord.quote_snapshot#>>'{personal,schema}' IS DISTINCT FROM 'personal-quote-v5'
   OR ord.quote_snapshot#>>'{settlementPricing,schema}' IS DISTINCT FROM 'settlement-pricing-v3'
   OR jsonb_typeof(pricing) IS DISTINCT FROM 'object' OR pricing IS DISTINCT FROM jsonb_build_object(
      'fixedFeeRate',ord.quote_snapshot#>>'{settlementPricing,fixedFeeRate}','payableRatio',ord.quote_snapshot#>>'{settlementPricing,payableRatio}')
   OR COALESCE(pricing->>'fixedFeeRate','') !~ '^(0|1)(\.[0-9]{1,8})?$' OR COALESCE(pricing->>'payableRatio','') !~ '^(0|1)(\.[0-9]{1,8})?$'
   OR ver.id IS NULL OR ver.superseded_at IS NOT NULL OR ver.version_hash IS DISTINCT FROM p.version_hash
   OR ver.early IS DISTINCT FROM p.early OR ver.kind NOT IN ('SYSTEM','MANUAL_ADJUSTMENT')
   OR (ver.kind='SYSTEM') IS DISTINCT FROM (p.manual_reason IS NULL)
   OR ver.input_snapshot->>'schema' IS DISTINCT FROM 'settlement-version-v4'
   OR ver.input_snapshot->>'orderId' IS DISTINCT FROM p.order_id OR ver.input_snapshot->>'paymentConfirmationId' IS DISTINCT FROM p.payment_confirmation_id
   OR ver.input_snapshot->>'renterUserId' IS DISTINCT FROM ord.renter_user_id OR ver.input_snapshot->>'ownerUserId' IS DISTINCT FROM ord.owner_user_id
   OR ver.input_snapshot->>'listingVersionId' IS DISTINCT FROM ord.listing_version_id OR ver.input_snapshot->>'listingHash' IS DISTINCT FROM ord.content_hash
   OR ver.input_snapshot->>'kind' IS DISTINCT FROM ver.kind OR ver.input_snapshot->>'early' IS DISTINCT FROM p.early::text
   OR zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'capturedAmount') IS DISTINCT FROM p.captured_cents
   OR encode(sha256(convert_to(zzsh_order.canonical_finance_json(ver.input_snapshot),'UTF8')),'hex') IS DISTINCT FROM p.version_hash
   OR COALESCE(doc->>'accountMode','') NOT IN ('ordinary','custom','fast')
  THEN RAISE EXCEPTION 'fixed fee commission lacks a bound completed settlement' USING ERRCODE='23514'; END IF;
  rate:=(pricing->>'fixedFeeRate')::numeric;payable:=(pricing->>'payableRatio')::numeric;
  IF rate<0 OR rate>=1 OR payable<=0 OR payable>1 OR 1-payable>rate
   OR COALESCE(ord.quote_snapshot#>>'{pricingInputs,commissionRate}','') !~ '^(0|1)(\.[0-9]{1,8})?$'
   OR (ord.quote_snapshot#>>'{pricingInputs,commissionRate}')::numeric IS DISTINCT FROM rate
  THEN RAISE EXCEPTION 'fixed fee commission rates differ from the original order' USING ERRCODE='23514'; END IF;
  IF ver.kind='MANUAL_ADJUSTMENT' THEN
   gross:=zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedOwnerGross');
   service:=zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedPlatformServiceFee');
   discount:=zzsh_order.settlement_snapshot_cents(ver.input_snapshot->>'proposedMembershipDiscount');
   IF discount IS DISTINCT FROM round(gross*(1-payable)) THEN RAISE EXCEPTION 'manual referral discount differs' USING ERRCODE='23514'; END IF;
  ELSE
   gross:=zzsh_order.settlement_snapshot_cents(ver.input_snapshot#>>'{amounts,ownerGross}');
   service:=zzsh_order.settlement_snapshot_cents(ver.input_snapshot#>>'{amounts,platformServiceFee}');
   discount:=zzsh_order.settlement_snapshot_cents(ver.input_snapshot#>>'{amounts,membershipDiscount}');
   IF discount IS DISTINCT FROM gross-round(gross*payable) THEN RAISE EXCEPTION 'settlement referral discount differs' USING ERRCODE='23514'; END IF;
  END IF;
  IF gross IS NULL OR service IS NULL OR discount IS NULL OR service IS DISTINCT FROM round(gross*rate)
   OR discount>service OR gross IS DISTINCT FROM p.owner_net_cents+service+p.compensation_fee_cents
   OR p.platform_contribution_cents-p.compensation_fee_cents<service-discount
  THEN RAISE EXCEPTION 'fixed fee commission amounts differ from posting' USING ERRCODE='23514'; END IF;
  base:=service-discount;
 ELSE
  IF ord.quote_snapshot->>'schemaVersion'='4' THEN RAISE EXCEPTION 'fixed fee basis version differs' USING ERRCODE='23514'; END IF;
  base:=CASE WHEN (doc#>>'{policyConfig,schema}'='distribution-policy.v3' OR doc#>>'{policyConfig,schema}'='distribution-policy.v4' AND doc#>>'{policyConfig,baseMode}'='LEGACY_RENTAL')
    THEN p.captured_cents-p.owner_net_cents-p.renter_refund_cents ELSE p.platform_contribution_cents-p.compensation_fee_cents END;
 END IF;
 IF base IS NULL OR base<0 THEN RAISE EXCEPTION 'original referral base unavailable' USING ERRCODE='23514'; END IF;
 posting_source:=jsonb_build_object('id',p.id,'order_id',p.order_id,'payment_confirmation_id',p.payment_confirmation_id,
  'version_hash',p.version_hash,'early',p.early,'manual_reason',p.manual_reason,'captured_cents',p.captured_cents::text,
  'owner_net_cents',p.owner_net_cents::text,'renter_refund_cents',p.renter_refund_cents::text,
  'platform_contribution_cents',p.platform_contribution_cents::text,'compensation_fee_cents',p.compensation_fee_cents::text,
  'posted_at',to_char(p.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'));
 posting_hash:=encode(sha256(convert_to(zzsh_order.canonical_finance_json(posting_source),'UTF8')),'hex');
 due_value:=((p.posted_at AT TIME ZONE 'UTC')+((doc#>>'{policyConfig,settlementDelayDays}')::integer*interval '1 day')) AT TIME ZONE 'UTC';
 due_text:=to_char(due_value AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
 -- Compute the renter's rounded share first, but keep canonical output in the original OWNER, RENTER order.
 FOR pair_role IN SELECT value FROM jsonb_array_elements(doc->'roles') WITH ORDINALITY r(value,ordinal)
  ORDER BY CASE WHEN fixed THEN (value->>'role'='OWNER_REFERRAL')::integer ELSE 0 END,ordinal
 LOOP
  IF COALESCE(pair_role->>'status','') NOT IN ('ELIGIBLE','SKIPPED_DISABLED','SKIPPED_FAST','SKIPPED_MODE','SKIPPED_NO_PARENT','SKIPPED_INELIGIBLE','SKIPPED_BELOW_MIN')
   OR doc->>'schema'='payment-distribution-basis.v2' AND (pair_role->>'status'='SKIPPED_BELOW_MIN'
    OR doc->>'accountMode'='fast' AND pair_role->>'status'='ELIGIBLE'
    OR doc->>'accountMode'<>'fast' AND pair_role->>'status'='SKIPPED_FAST')
  THEN RAISE EXCEPTION 'unknown counterpart cannot authorize accrual' USING ERRCODE='23514'; END IF;
  IF pair_role->>'status'='ELIGIBLE' THEN
   IF COALESCE(pair_role->>'beneficiaryUserId','')='' OR COALESCE(pair_role->>'relationDigest','') !~ '^[0-9a-f]{64}$'
    OR COALESCE(pair_role#>>'{ratio,numerator}','') !~ '^(0|[1-9][0-9]{0,23})$'
    OR COALESCE(pair_role#>>'{ratio,denominator}','') !~ '^(0|[1-9][0-9]{0,23})$'
   THEN RAISE EXCEPTION 'original referral role unavailable' USING ERRCODE='23514'; END IF;
   n:=(pair_role#>>'{ratio,numerator}')::numeric;d:=(pair_role#>>'{ratio,denominator}')::numeric;
   IF n<0 OR d<=0 OR n>d THEN RAISE EXCEPTION 'counterpart ratio invalid' USING ERRCODE='23514'; END IF;
   -- Integer division avoids an intermediate numeric rounding before HALF_UP.
   commission:=div(base*n*2+d,2*d);
   IF fixed THEN
    IF pair_role->>'role'='RENTER_REFERRAL' THEN
     renter_n:=n;renter_d:=d;renter_rounded:=commission;
    ELSE
     IF renter_n*d+n*renter_d>renter_d*d THEN RAISE EXCEPTION 'counterpart ratios exceed original base' USING ERRCODE='23514'; END IF;
     commission:=LEAST(commission,base-renter_rounded);
    END IF;
    IF commission=0 OR commission<(doc#>>'{policyConfig,minimumAccrualCents}')::numeric THEN CONTINUE; END IF;
   END IF;
   pair_total:=pair_total+commission;
   key_value:=zzsh_order.canonical_finance_json(jsonb_build_array('NATIVE_RENTAL_REFERRAL','NATIVE','zzsh','rental_order',p.order_id,pair_role->>'beneficiaryUserId',pair_role->>'role'));
   item:=jsonb_build_object('economicKey',key_value,'beneficiaryUserId',pair_role->>'beneficiaryUserId','role',pair_role->>'role',
    'amountCents',commission::numeric(24,0)::text,'dueAt',due_text,'policyVersion',doc->>'policyVersion',
    'basisDigest',b.basis_digest,'postingDigest',posting_hash,'relationDigest',pair_role->>'relationDigest');
   items:=items||jsonb_build_array(item);
  END IF;
 END LOOP;
 IF pair_total>base THEN RAISE EXCEPTION 'rounded referral pair exceeds original base without subsidy' USING ERRCODE='23514'; END IF;
 IF fixed THEN
  SELECT COALESCE(jsonb_agg(entry ORDER BY (entry->>'role') COLLATE "C"),'[]'::jsonb)
   INTO items FROM jsonb_array_elements(items) entry;
 END IF;
 allocation_hash:=encode(sha256(convert_to(zzsh_order.canonical_finance_json(jsonb_build_object('orderId',p.order_id,
  'confirmationId',p.payment_confirmation_id,'basisDigest',b.basis_digest,'postingId',p.id,'postingDigest',posting_hash,
  'base',base::numeric(24,0)::text,'items',items)),'UTF8')),'hex');
 RETURN jsonb_build_object('orderId',p.order_id,'confirmationId',p.payment_confirmation_id,'basisDigest',b.basis_digest,
  'postingId',p.id,'postingDigest',posting_hash,'postedAt',to_char(p.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
  'policyDigest',doc->>'policyDigest','dueAt',due_text,'base',base::numeric(24,0)::text,
  'items',items,'allocationDigest',allocation_hash,'skipReason',CASE WHEN jsonb_array_length(items)<>0 THEN NULL
   WHEN EXISTS(SELECT 1 FROM jsonb_array_elements(doc->'roles') r WHERE r->>'status'='ELIGIBLE') THEN 'NO_PAYABLE_COMMISSION'
   ELSE 'NO_ELIGIBLE_REFERRAL' END);
END $$;
COMMENT ON FUNCTION zzsh_order.derive_frozen_referral_accrual(text) IS '由原付款冻结关系和结算过账推导完整分销计佣，不读取当前政策。';

CREATE FUNCTION zzsh_order.frozen_referral_earning_seed(derivation jsonb,item jsonb) RETURNS jsonb
LANGUAGE sql IMMUTABLE STRICT AS $$
 SELECT jsonb_build_object('id','earning_'||encode(sha256(convert_to(item->>'economicKey','UTF8')),'hex'),
  'economicKey',item->>'economicKey',
  'source',jsonb_build_object('kind','NATIVE_RENTAL_REFERRAL','type','NATIVE','system','zzsh','entity','rental_order',
   'id',derivation->>'orderId','digest',derivation->>'postingDigest','eventAt',derivation->>'postedAt'),
  'beneficiaryUserId',item->>'beneficiaryUserId','role',item->>'role','policyVersion',item->>'policyVersion',
  'policyDigest',derivation->>'policyDigest','baseDigest',derivation->>'allocationDigest','relationDigest',item->>'relationDigest',
  'amountCents',item->>'amountCents','dueAt',item->>'dueAt',
  'fingerprint',encode(sha256(convert_to(zzsh_order.canonical_finance_json(item),'UTF8')),'hex'),
  'state','PENDING','fundsDisposition','PENDING','recoveryRequiredCents',NULL,'version','1')
$$;
COMMENT ON FUNCTION zzsh_order.frozen_referral_earning_seed(jsonb,jsonb) IS '生成与冻结分销计佣明细一致的原始账务根。';
REVOKE ALL ON FUNCTION zzsh_order.derive_frozen_referral_accrual(text),zzsh_order.frozen_referral_earning_seed(jsonb,jsonb) FROM PUBLIC;

--> statement-breakpoint
-- Contract: distribution-earning-contract
-- Preserve the installed v1 guard and make both modes use the shared frozen derivation.
DO $patch$
DECLARE source text;definition text;digest text;start_at integer;end_at integer;
 old_declare text:=$old$posting_source jsonb;posting_hash text;key_value text;due_value timestamptz;due_text text;items jsonb:='[]'::jsonb;item jsonb;own_item jsonb;allocation_hash text;expected_seed jsonb;$old$;
 first_part text:=$old$n:=(role#>>'{ratio,numerator}')::numeric;d:=(role#>>'{ratio,denominator}')::numeric;base:=CASE WHEN$old$;
 last_part text:=$old$IF NEW.amount_cents<>expected OR NEW.due_at IS DISTINCT FROM due_value OR own_item IS NULL$old$;
 replacement text:=$new$derivation:=zzsh_order.derive_frozen_referral_accrual(NEW.posting_id);
 items:=derivation->'items';posting_hash:=derivation->>'postingDigest';allocation_hash:=derivation->>'allocationDigest';
 SELECT value INTO own_item FROM jsonb_array_elements(items)
  WHERE value->>'role'=NEW.beneficiary_role AND value->>'beneficiaryUserId'=NEW.beneficiary_user_id;
 IF own_item IS NULL THEN RAISE EXCEPTION 'original referral role is not payable' USING ERRCODE='23514'; END IF;
 expected:=(own_item->>'amountCents')::numeric;due_value:=(own_item->>'dueAt')::timestamptz;
 expected_seed:=zzsh_order.frozen_referral_earning_seed(derivation,own_item);
 $new$;
BEGIN
 IF to_regprocedure('zzsh_order.derive_frozen_referral_accrual(text)') IS NULL
  OR to_regprocedure('zzsh_order.frozen_referral_earning_seed(jsonb,jsonb)') IS NULL
 THEN RAISE EXCEPTION 'frozen referral derivation is required' USING ERRCODE='55000'; END IF;
 SELECT p.prosrc,pg_get_functiondef(p.oid) INTO source,definition FROM pg_proc p
  WHERE p.oid=to_regprocedure('zzsh_order.guard_rental_referral_earning()')
   AND p.proowner=(SELECT oid FROM pg_roles WHERE rolname=current_user) AND NOT p.prosecdef;
 digest:=encode(sha256(convert_to(replace(source,E'\r\n',E'\n'),'UTF8')),'hex');
 IF digest IS DISTINCT FROM 'cb4d2f8b48926487c6cdf70eca38d5b9b75a8e9a4b378d44ecfc21f8594c984d'
 THEN RAISE EXCEPTION 'installed referral earning guard is unrecognized' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,E'\r\n',E'\n');
 IF position(old_declare IN definition)=0 OR position(old_declare IN replace(definition,old_declare,''))<>0
  OR position(first_part IN definition)=0 OR position(first_part IN replace(definition,first_part,''))<>0
  OR position(last_part IN definition)=0 OR position(last_part IN replace(definition,last_part,''))<>0
 THEN RAISE EXCEPTION 'referral earning guard patch is absent or ambiguous' USING ERRCODE='55000'; END IF;
 definition:=replace(definition,old_declare,old_declare||' derivation jsonb;');
 start_at:=position(first_part IN definition);end_at:=position(last_part IN definition);
 IF end_at<=start_at THEN RAISE EXCEPTION 'referral earning guard patch order invalid' USING ERRCODE='55000'; END IF;
 definition:=substring(definition FROM 1 FOR start_at-1)||replacement||substring(definition FROM end_at);
 EXECUTE definition;
END $patch$;

--> statement-breakpoint
-- Contract: distribution-accrual-task
-- A committed native posting is the original accrual recovery key.
DO $$ BEGIN
 IF to_regprocedure('zzsh_order.derive_frozen_referral_accrual(text)') IS NULL
  OR to_regprocedure('zzsh_order.frozen_referral_earning_seed(jsonb,jsonb)') IS NULL
  OR to_regprocedure('zzsh_order.earning_expected_lines(text)') IS NULL
 THEN RAISE EXCEPTION 'frozen referral derivation and ledger proof are required' USING ERRCODE='55000'; END IF;
END $$;
CREATE TABLE zzsh_order.distribution_accrual_task (
  posting_id text PRIMARY KEY REFERENCES zzsh_order.settlement_posting(id),
  state text NOT NULL DEFAULT 'PENDING' CONSTRAINT distribution_accrual_task_state_check CHECK (state IN ('PENDING','DONE','SKIPPED','REVIEW_REQUIRED')),
  reason_code text CONSTRAINT distribution_accrual_task_reason_code_check CHECK (reason_code IS NULL OR reason_code ~ '^[A-Z0-9_]{1,64}$'),
  next_attempt_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT distribution_accrual_task_outcome_check CHECK ((state IN ('SKIPPED','REVIEW_REQUIRED') AND reason_code IS NOT NULL)
      OR (state IN ('PENDING','DONE') AND (state <> 'DONE' OR reason_code IS NULL)))
);
CREATE INDEX distribution_accrual_task_due ON zzsh_order.distribution_accrual_task(next_attempt_at,posting_id) WHERE state='PENDING';
CREATE INDEX referral_earning_posting ON zzsh_order.rental_referral_earning(posting_id,economic_key);
CREATE INDEX distribution_due_unfinished_receipt ON zzsh_supply.idempotency_record(created_at,key)
  WHERE response_status<>200 AND scope_key LIKE '["system","distribution-due-%';
CREATE FUNCTION zzsh_order.guard_distribution_accrual_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE derivation jsonb;item jsonb;expected_seed jsonb;actual_count integer;
 earning zzsh_order.rental_referral_earning;root zzsh_order.finance_economic_root;
 receipt zzsh_order.rental_referral_transition;event_row zzsh_order.finance_event;
BEGIN
  IF TG_OP='INSERT' AND NEW.state<>'PENDING' THEN
    RAISE EXCEPTION 'accrual task must start pending' USING ERRCODE='23514';
  ELSIF TG_OP='UPDATE' AND (NEW.posting_id IS DISTINCT FROM OLD.posting_id
    OR OLD.state IN ('DONE','SKIPPED') AND NEW IS DISTINCT FROM OLD
    OR OLD.state='REVIEW_REQUIRED' AND NEW.state='PENDING') THEN
    RAISE EXCEPTION 'accrual task original identity or completed state changed' USING ERRCODE='23514';
  END IF;
  IF TG_OP='UPDATE' AND NEW.state IN ('DONE','SKIPPED') AND NEW.state IS DISTINCT FROM OLD.state THEN
    derivation:=zzsh_order.derive_frozen_referral_accrual(NEW.posting_id);
    SELECT count(*) INTO actual_count FROM zzsh_order.rental_referral_earning WHERE posting_id=NEW.posting_id;
    IF NEW.state='DONE' AND (jsonb_array_length(derivation->'items')=0 OR actual_count<>jsonb_array_length(derivation->'items'))
      OR NEW.state='SKIPPED' AND (jsonb_array_length(derivation->'items')<>0 OR actual_count<>0
       OR NEW.reason_code IS DISTINCT FROM derivation->>'skipReason') THEN
      RAISE EXCEPTION 'accrual task requires the complete original referral set' USING ERRCODE='23514';
    END IF;
    FOR item IN SELECT value FROM jsonb_array_elements(derivation->'items') LOOP
      expected_seed:=zzsh_order.frozen_referral_earning_seed(derivation,item);
      SELECT * INTO earning FROM zzsh_order.rental_referral_earning
       WHERE posting_id=NEW.posting_id AND economic_key=item->>'economicKey';
      IF earning.id IS NULL OR earning.id IS DISTINCT FROM expected_seed->>'id' OR earning.economic_root_id IS DISTINCT FROM earning.id
       OR earning.order_id IS DISTINCT FROM derivation->>'orderId' OR earning.payment_confirmation_id IS DISTINCT FROM derivation->>'confirmationId'
       OR earning.beneficiary_user_id IS DISTINCT FROM item->>'beneficiaryUserId' OR earning.beneficiary_role IS DISTINCT FROM item->>'role'
       OR earning.amount_cents IS DISTINCT FROM (item->>'amountCents')::numeric OR earning.due_at IS DISTINCT FROM (item->>'dueAt')::timestamptz
       OR earning.basis_digest IS DISTINCT FROM item->>'basisDigest' OR earning.posting_digest IS DISTINCT FROM item->>'postingDigest'
       OR earning.canonical_seed IS DISTINCT FROM zzsh_order.canonical_finance_json(expected_seed)
       OR earning.seed_digest IS DISTINCT FROM encode(sha256(convert_to(earning.canonical_seed,'UTF8')),'hex')
      THEN RAISE EXCEPTION 'accrual task earning differs from the frozen referral set' USING ERRCODE='23514'; END IF;
      SELECT * INTO root FROM zzsh_order.finance_economic_root WHERE id=earning.economic_root_id;
      SELECT * INTO receipt FROM zzsh_order.rental_referral_transition WHERE earning_id=earning.id AND action='ACCRUE';
      SELECT * INTO event_row FROM zzsh_order.finance_event WHERE id=receipt.finance_event_id;
      IF root.id IS NULL OR root.basis_id IS NOT NULL OR root.source_kind IS DISTINCT FROM 'NATIVE_RENTAL_REFERRAL'
       OR root.source_type IS DISTINCT FROM 'NATIVE' OR root.source_system IS DISTINCT FROM 'zzsh' OR root.source_entity IS DISTINCT FROM 'rental_order'
       OR root.source_id IS DISTINCT FROM earning.order_id OR root.subject_user_id IS DISTINCT FROM earning.beneficiary_user_id
       OR root.beneficiary_role IS DISTINCT FROM earning.beneficiary_role OR root.policy_version IS DISTINCT FROM item->>'policyVersion'
       OR root.source_digest IS DISTINCT FROM earning.posting_digest OR receipt.id IS NULL OR receipt.expected_version<>0 OR receipt.result_version<>1
       OR receipt.reversal_source_id IS NOT NULL OR receipt.source_digest IS DISTINCT FROM earning.posting_digest
       OR event_row.id IS NULL OR event_row.kind IS DISTINCT FROM 'EARNING_PENDING' OR event_row.economic_root_id IS DISTINCT FROM root.id
       OR event_row.subject_user_id IS DISTINCT FROM earning.beneficiary_user_id
      THEN RAISE EXCEPTION 'accrual task original earning receipt is incomplete' USING ERRCODE='23514'; END IF;
      IF EXISTS(SELECT l.line_no,l.account_code,l.debit_cents,l.credit_cents,l.counterparty_user_id,l.source_payment_confirmation_id
        FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=event_row.id
        EXCEPT ALL SELECT x.line_no,x.account_code,x.debit_cents,x.credit_cents,x.counterparty_user_id,x.source_payment_confirmation_id
         FROM zzsh_order.earning_expected_lines(event_row.id) x)
       OR EXISTS(SELECT x.line_no,x.account_code,x.debit_cents,x.credit_cents,x.counterparty_user_id,x.source_payment_confirmation_id
        FROM zzsh_order.earning_expected_lines(event_row.id) x
        EXCEPT ALL SELECT l.line_no,l.account_code,l.debit_cents,l.credit_cents,l.counterparty_user_id,l.source_payment_confirmation_id
         FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=event_row.id)
      THEN RAISE EXCEPTION 'accrual task original earning ledger is incomplete' USING ERRCODE='23514'; END IF;
    END LOOP;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER distribution_accrual_task_guard BEFORE INSERT OR UPDATE ON zzsh_order.distribution_accrual_task
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_distribution_accrual_task();
COMMENT ON FUNCTION zzsh_order.guard_distribution_accrual_task() IS '保护计佣任务原过账身份和完成状态。';
CREATE FUNCTION zzsh_order.enqueue_distribution_accrual_task() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO zzsh_order.distribution_accrual_task(posting_id) VALUES(NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER settlement_distribution_accrual_enqueue AFTER INSERT ON zzsh_order.settlement_posting
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.enqueue_distribution_accrual_task();
COMMENT ON FUNCTION zzsh_order.enqueue_distribution_accrual_task() IS '在结算过账事务中登记原过账计佣任务。';
CREATE FUNCTION zzsh_order.guard_referral_earning_task() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE task_state text;
BEGIN
  IF TG_OP='INSERT' THEN
    SELECT state INTO task_state FROM zzsh_order.distribution_accrual_task WHERE posting_id=NEW.posting_id FOR UPDATE;
    IF task_state IS NULL OR task_state NOT IN ('PENDING','REVIEW_REQUIRED') THEN
      RAISE EXCEPTION 'earning requires an open original accrual task' USING ERRCODE='23514';
    END IF;
  ELSIF OLD.state='PENDING' AND NEW.state='SETTLED' THEN
    SELECT state INTO task_state FROM zzsh_order.distribution_accrual_task WHERE posting_id=NEW.posting_id FOR SHARE;
    IF task_state IS DISTINCT FROM 'DONE' THEN
      RAISE EXCEPTION 'earning cannot settle before the complete original accrual task' USING ERRCODE='23514';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_referral_earning_task_guard BEFORE INSERT OR UPDATE ON zzsh_order.rental_referral_earning
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_referral_earning_task();
COMMENT ON FUNCTION zzsh_order.guard_referral_earning_task() IS '使用同一任务行锁保护计佣明细并阻止未核实佣金入账。';
COMMENT ON TABLE zzsh_order.distribution_accrual_task IS '新站结算过账对应的分销计佣恢复任务，不含旧站迁入责任。';
COMMENT ON COLUMN zzsh_order.distribution_accrual_task.posting_id IS '原结算过账；也是任务幂等和恢复键。';
COMMENT ON COLUMN zzsh_order.distribution_accrual_task.state IS '待处理、已计佣、明确无佣或待人工核对。';
COMMENT ON COLUMN zzsh_order.distribution_accrual_task.reason_code IS '跳过、复核或暂时失败的稳定原因码。';
COMMENT ON COLUMN zzsh_order.distribution_accrual_task.next_attempt_at IS '待处理任务下次可重试时间。';
COMMENT ON COLUMN zzsh_order.distribution_accrual_task.created_at IS '任务创建时间。';
COMMENT ON COLUMN zzsh_order.distribution_accrual_task.updated_at IS '任务最后更新时间。';

-- Existing native postings also need recovery; the stored payment basis, not current policy, decides accrual.
INSERT INTO zzsh_order.distribution_accrual_task(posting_id)
SELECT p.id FROM zzsh_order.settlement_posting p
JOIN zzsh_order.rental_order o ON o.id=p.order_id AND o.status='COMPLETED'
JOIN zzsh_order.payment_confirmation c ON c.id=p.payment_confirmation_id AND c.order_id=p.order_id
WHERE c.disposition='APPLIED' AND c.source IN ('JOINPAY','CONTROLLED')
ON CONFLICT (posting_id) DO NOTHING;

--> statement-breakpoint
-- Contract: scheduled-spread-order-enable
-- Install after posting, cancellation, compensation and distribution guards.
-- Application publication, scheduling and order switches remain closed.
CREATE OR REPLACE FUNCTION zzsh_order.poststart_full_payout_selected(quote_value jsonb,renter_value text,owner_value text,account_value text,listing_value text,hash_value text,release_value text)
RETURNS boolean LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
 SELECT CASE
  WHEN quote_value#>>'{personal,userId}' IS DISTINCT FROM renter_value
   OR quote_value#>>'{personal,listingHash}' IS DISTINCT FROM hash_value
   OR quote_value#>>'{personal,ruleRefs,releaseId}' IS DISTINCT FROM release_value
   OR quote_value->>'ruleReleaseId' IS DISTINCT FROM release_value THEN NULL
  WHEN quote_value#>>'{personal,schema}'='personal-quote-v1'
   AND quote_value#>'{personal,funding,fullPayoutSelected}'='false'::jsonb
   AND quote_value#>>'{personal,funding,fullPayoutFeeCents}'='0'
   AND NOT ((quote_value->'personal') ? 'fullPayoutDeclaration') THEN false
  WHEN (quote_value#>>'{personal,schema}' IN('personal-quote-v2','personal-quote-v3','personal-quote-v4')
    OR (quote_value#>>'{personal,schema}'='personal-quote-v6' AND quote_value->>'schemaVersion'='2'
      AND quote_value->>'mode'='SPREAD' AND quote_value#>>'{personal,pricingPolicy,pricingModel}'='SPREAD'
      AND quote_value#>>'{settlementPricing,schema}'='settlement-pricing-v1'
      AND quote_value#>>'{settlementPricing,priceVersionId}'=quote_value->>'priceVersionId'
      AND quote_value#>>'{personal,pricingPolicy,priceVersionId}'=quote_value->>'priceVersionId'))
   AND quote_value#>>'{personal,ownerUserId}'=owner_value
   AND quote_value#>>'{personal,accountId}'=account_value
   AND quote_value#>>'{personal,listingVersionId}'=listing_value
   AND quote_value#>>'{personal,fullPayoutDeclaration,schema}'='full-payout-declaration-v1'
   AND jsonb_typeof(quote_value#>'{personal,fullPayoutDeclaration,selected}')='boolean'
   AND NOT ((quote_value#>'{personal,funding}') ? 'fullPayoutSelected')
   AND NOT ((quote_value#>'{personal,funding}') ? 'fullPayoutFeeCents')
   AND length(btrim(coalesce(quote_value#>>'{personal,funding,fullPayoutPolicyVersion}','')))>0
   AND length(btrim(coalesce(quote_value#>>'{personal,funding,disclosureVersion}','')))>0
  THEN (quote_value#>>'{personal,fullPayoutDeclaration,selected}')::boolean
  ELSE NULL END
$$;
--> statement-breakpoint
DROP TRIGGER rental_order_personal_guard ON zzsh_order.rental_order;
CREATE TRIGGER rental_order_personal_guard BEFORE INSERT OR UPDATE ON zzsh_order.rental_order
  FOR EACH ROW WHEN (NEW.quote_snapshot#>>'{personal,schema}' IS DISTINCT FROM 'personal-quote-v5'
    AND NEW.quote_snapshot#>>'{personal,schema}' IS DISTINCT FROM 'personal-quote-v6')
  EXECUTE FUNCTION zzsh_order.guard_personal_order();
CREATE TRIGGER rental_order_scheduled_spread_personal_guard BEFORE INSERT OR UPDATE ON zzsh_order.rental_order
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_scheduled_spread_personal_order();

--> statement-breakpoint
COMMENT ON COLUMN zzsh_supply.rule_release.effective_at IS '规则组合的计划生效时间；空值表示原有基准版本。';
COMMENT ON COLUMN zzsh_supply.rule_release.announcement_version_id IS '计划发布规则时关联的已公开公告版本。';
