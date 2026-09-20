-- Operational display/options only: no production game IDs, query expressions or price defaults.
CREATE TABLE zzsh_supply.listing_filter_config (
  game_id text NOT NULL REFERENCES zzsh_supply.game(id),
  revision bigint NOT NULL CHECK(revision>0),
  config jsonb NOT NULL CHECK(COALESCE(jsonb_typeof(config)='object' AND config->'schemaVersion'='1'::jsonb AND jsonb_typeof(config->'fields')='array' AND jsonb_typeof(config->'sorts')='array',false)),
  restore_from_revision bigint,
  created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY(game_id,revision),
  FOREIGN KEY(game_id,restore_from_revision) REFERENCES zzsh_supply.listing_filter_config(game_id,revision),
  CHECK(restore_from_revision IS NULL OR restore_from_revision<revision)
);
--> statement-breakpoint
CREATE FUNCTION zzsh_supply.guard_listing_filter_config() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE previous bigint;
BEGIN
  IF TG_OP<>'INSERT' THEN RAISE EXCEPTION 'filter revisions are immutable' USING ERRCODE='40001'; END IF;
  PERFORM id FROM zzsh_supply.game WHERE id=NEW.game_id FOR UPDATE;
  SELECT COALESCE(max(revision),0) INTO previous FROM zzsh_supply.listing_filter_config WHERE game_id=NEW.game_id;
  IF NEW.revision<>previous+1 THEN RAISE EXCEPTION 'filter revision changed' USING ERRCODE='40001'; END IF;
  NEW.created_at:=clock_timestamp();
  RETURN NEW;
END $$;
CREATE TRIGGER listing_filter_config_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_supply.listing_filter_config
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_listing_filter_config();
INSERT INTO zzsh_iam.admin_permission(code,name,description) VALUES('supply.listing_filters.manage','管理租号筛选配置','维护已实现筛选/排序的展示与允许选项，不配置查询逻辑');
