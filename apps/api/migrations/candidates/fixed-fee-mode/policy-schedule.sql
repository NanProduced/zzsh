-- Candidate only: fee policy publication remains disabled until application and ledger guards are complete.
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
