-- Operational rule changes retain the approved content and append one cancellation fact.
CREATE TABLE zzsh_supply.rule_change_batch (
  id text PRIMARY KEY,
  game_id text NOT NULL REFERENCES zzsh_supply.game(id),
  effective_at timestamptz NOT NULL,
  announcement_version_id text NOT NULL REFERENCES zzsh_content.content_version(id),
  created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
  approval_request_id text UNIQUE REFERENCES zzsh_iam.approval_request(id),
  change jsonb NOT NULL CHECK (jsonb_typeof(change)='object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  voided_at timestamptz,
  voided_by_admin_id text REFERENCES zzsh_auth_admin."user"(id),
  void_reason text,
  CHECK ((voided_at IS NULL AND voided_by_admin_id IS NULL AND void_reason IS NULL)
    OR (voided_at<effective_at AND voided_by_admin_id IS NOT NULL AND length(btrim(void_reason)) BETWEEN 2 AND 500))
);
CREATE INDEX rule_change_batch_history ON zzsh_supply.rule_change_batch(game_id,created_at DESC,id DESC);
ALTER TABLE zzsh_supply.pricing_policy_schedule ADD COLUMN batch_id text REFERENCES zzsh_supply.rule_change_batch(id), ADD COLUMN voided_at timestamptz;
ALTER TABLE zzsh_supply.pricing_mode_schedule ADD COLUMN batch_id text REFERENCES zzsh_supply.rule_change_batch(id), ADD COLUMN voided_at timestamptz;
ALTER TABLE zzsh_supply.rule_release ADD COLUMN batch_id text REFERENCES zzsh_supply.rule_change_batch(id), ADD COLUMN voided_at timestamptz;
CREATE INDEX pricing_policy_schedule_batch ON zzsh_supply.pricing_policy_schedule(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX pricing_mode_schedule_batch ON zzsh_supply.pricing_mode_schedule(batch_id) WHERE batch_id IS NOT NULL;
CREATE INDEX rule_release_batch ON zzsh_supply.rule_release(batch_id) WHERE batch_id IS NOT NULL;
DROP INDEX zzsh_supply.rule_release_schedule_time;
CREATE UNIQUE INDEX rule_release_schedule_time ON zzsh_supply.rule_release(game_id,effective_at)
  WHERE effective_at IS NOT NULL AND voided_at IS NULL;
--> statement-breakpoint
CREATE FUNCTION zzsh_supply.guard_rule_change_batch() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE actor_id text;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'rule change is immutable' USING ERRCODE='40001'; END IF;
  actor_id:=CASE WHEN TG_OP='UPDATE' THEN NEW.voided_by_admin_id ELSE NEW.created_by_admin_id END;
  IF NOT EXISTS(SELECT 1 FROM zzsh_iam.admin_security
    WHERE admin_user_id=actor_id AND status='ACTIVE' AND is_boss) THEN
    RAISE EXCEPTION 'rule change requires active boss' USING ERRCODE='42501';
  END IF;
  IF NEW.effective_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'rule change time has passed' USING ERRCODE='40001';
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.voided_at IS NOT NULL THEN RAISE EXCEPTION 'rule change must start scheduled' USING ERRCODE='23514'; END IF;
    IF NEW.approval_request_id IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM zzsh_iam.approval_request a
      WHERE a.id=NEW.approval_request_id AND a.operation_code='supply.rules.mode_switch'
        AND a.status='APPROVED' AND a.decided_by=actor_id AND a.operation_payload->>'gameId'=NEW.game_id
    ) THEN RAISE EXCEPTION 'pricing mode change requires approved request' USING ERRCODE='42501'; END IF;
  ELSE
    IF OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL
      OR (to_jsonb(NEW)-ARRAY['voided_at','voided_by_admin_id','void_reason']) IS DISTINCT FROM
         (to_jsonb(OLD)-ARRAY['voided_at','voided_by_admin_id','void_reason'])
    THEN RAISE EXCEPTION 'rule change is immutable' USING ERRCODE='40001'; END IF;
    NEW.voided_at:=clock_timestamp();
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rule_change_batch_guard BEFORE INSERT OR UPDATE OR DELETE ON zzsh_supply.rule_change_batch
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_rule_change_batch();

CREATE FUNCTION zzsh_supply.guard_rule_change_member() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE batch zzsh_supply.rule_change_batch%ROWTYPE;
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'rule schedule is immutable' USING ERRCODE='40001'; END IF;
  IF NEW.batch_id IS NOT NULL THEN
    SELECT * INTO batch FROM zzsh_supply.rule_change_batch WHERE id=NEW.batch_id;
    IF NOT FOUND OR batch.game_id<>NEW.game_id OR batch.effective_at IS DISTINCT FROM NEW.effective_at THEN
      RAISE EXCEPTION 'rule schedule batch differs' USING ERRCODE='23514';
    END IF;
  END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.voided_at IS NOT NULL OR batch.voided_at IS NOT NULL THEN
      RAISE EXCEPTION 'cannot insert voided rule schedule' USING ERRCODE='23514';
    END IF;
    IF TG_TABLE_NAME='pricing_mode_schedule' AND to_jsonb(NEW)->>'source'='ADMIN' AND batch.approval_request_id IS NULL THEN
      RAISE EXCEPTION 'operational mode schedule requires approval' USING ERRCODE='42501';
    END IF;
    IF NEW.effective_at IS NOT NULL AND COALESCE(to_jsonb(NEW)->>'source','ADMIN')='ADMIN' THEN
      PERFORM 1 FROM zzsh_supply.game WHERE id=NEW.game_id FOR UPDATE;
      IF TG_TABLE_NAME='rule_release' THEN
        IF EXISTS (SELECT 1 FROM zzsh_supply.rule_release WHERE game_id=NEW.game_id AND voided_at IS NULL AND effective_at>clock_timestamp()) THEN
          RAISE EXCEPTION 'rule release has a pending schedule' USING ERRCODE='40001';
        END IF;
      ELSIF TG_TABLE_NAME='pricing_mode_schedule' THEN
        IF EXISTS (SELECT 1 FROM zzsh_supply.pricing_mode_schedule WHERE game_id=NEW.game_id AND voided_at IS NULL AND effective_at>clock_timestamp()) THEN
          RAISE EXCEPTION 'pricing mode has a pending schedule' USING ERRCODE='40001';
        END IF;
      ELSIF EXISTS (SELECT 1 FROM zzsh_supply.pricing_policy_schedule WHERE game_id=NEW.game_id
        AND pricing_model=to_jsonb(NEW)->>'pricing_model' AND voided_at IS NULL AND effective_at>clock_timestamp()) THEN
        RAISE EXCEPTION 'pricing policy has a pending schedule' USING ERRCODE='40001';
      END IF;
    END IF;
  ELSIF OLD.voided_at IS NOT NULL OR NEW.voided_at IS NULL OR NEW.effective_at<=clock_timestamp()
    OR batch.voided_at IS DISTINCT FROM NEW.voided_at
    OR (to_jsonb(NEW)-'voided_at') IS DISTINCT FROM (to_jsonb(OLD)-'voided_at')
  THEN RAISE EXCEPTION 'rule schedule is immutable' USING ERRCODE='40001'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER release_immutable ON zzsh_supply.rule_release;
CREATE TRIGGER rule_release_change_member BEFORE INSERT OR UPDATE OR DELETE ON zzsh_supply.rule_release
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_rule_change_member();
DROP TRIGGER pricing_policy_schedule_guard ON zzsh_supply.pricing_policy_schedule;
DROP TRIGGER pricing_mode_schedule_guard ON zzsh_supply.pricing_mode_schedule;
CREATE TRIGGER pricing_policy_schedule_guard BEFORE INSERT ON zzsh_supply.pricing_policy_schedule
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_pricing_schedule();
CREATE TRIGGER pricing_mode_schedule_guard BEFORE INSERT ON zzsh_supply.pricing_mode_schedule
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_pricing_schedule();
CREATE TRIGGER pricing_policy_change_member BEFORE INSERT OR UPDATE OR DELETE ON zzsh_supply.pricing_policy_schedule
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_rule_change_member();
CREATE TRIGGER pricing_mode_change_member BEFORE INSERT OR UPDATE OR DELETE ON zzsh_supply.pricing_mode_schedule
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_rule_change_member();
--> statement-breakpoint
CREATE FUNCTION zzsh_supply.void_rule_change_members() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE zzsh_supply.pricing_policy_schedule SET voided_at=NEW.voided_at WHERE batch_id=NEW.id;
  UPDATE zzsh_supply.pricing_mode_schedule SET voided_at=NEW.voided_at WHERE batch_id=NEW.id;
  UPDATE zzsh_supply.rule_release SET voided_at=NEW.voided_at WHERE batch_id=NEW.id;
  RETURN NULL;
END $$;
CREATE TRIGGER rule_change_batch_void_members AFTER UPDATE OF voided_at ON zzsh_supply.rule_change_batch
  FOR EACH ROW EXECUTE FUNCTION zzsh_supply.void_rule_change_members();

CREATE FUNCTION zzsh_supply.guard_rule_change_void_time() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.effective_at<=clock_timestamp() THEN
    RAISE EXCEPTION 'rule change became effective before void committed' USING ERRCODE='40001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER rule_change_batch_void_time AFTER UPDATE ON zzsh_supply.rule_change_batch
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_rule_change_void_time();
COMMENT ON TABLE zzsh_supply.rule_change_batch IS '按同一公告和时间安排生效的规则变更批次。';
COMMENT ON COLUMN zzsh_supply.rule_change_batch.change IS '提交时核对的游戏、模式、配置修订和生效计划。';
COMMENT ON COLUMN zzsh_supply.rule_change_batch.voided_at IS '生效前整批作废时的数据库时间。';
--> statement-breakpoint
CREATE OR REPLACE FUNCTION zzsh_supply.effective_rule_release(game_id text, baseline text, as_of timestamptz)
RETURNS text LANGUAGE sql STABLE AS $$
  SELECT COALESCE((SELECT r.id FROM zzsh_supply.rule_release r
    WHERE r.game_id=$1 AND r.effective_at<=$3 AND (r.voided_at IS NULL OR r.voided_at>$3)
    ORDER BY r.effective_at DESC,r.generation DESC LIMIT 1), $2)
$$;

CREATE OR REPLACE FUNCTION zzsh_supply.guard_publication_effective_rule() RETURNS trigger LANGUAGE plpgsql AS $$
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
    WHERE game_id=NEW.game_id AND effective_at<=NEW.published_at AND voided_at IS NULL ORDER BY effective_at DESC,generation DESC LIMIT 1;
  SELECT v.payload->'pricingPolicy' INTO actual_policy FROM zzsh_supply.listing_version v WHERE v.id=NEW.version_id;
  IF selected_model IS NOT NULL THEN
    SELECT jsonb_build_object('schema','pricing-policy-v1','pricingModel',pricing_model,
      'scheduleId',id,'generation',generation::text,'priceVersionId',price_version_id,'effectiveAt',
      to_char(effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"'))
      INTO expected_policy FROM zzsh_supply.pricing_policy_schedule
      WHERE game_id=NEW.game_id AND pricing_model=selected_model AND effective_at<=NEW.published_at AND voided_at IS NULL
      ORDER BY effective_at DESC,generation DESC LIMIT 1;
    IF expected_policy IS NULL THEN RAISE EXCEPTION 'publication price policy missing' USING ERRCODE='40001'; END IF;
  END IF;
  IF actual_policy IS DISTINCT FROM expected_policy THEN
    RAISE EXCEPTION 'publication price policy changed' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;

--> statement-breakpoint
INSERT INTO zzsh_iam.approval_template(id,operation_code,trigger_condition,version)
VALUES ('approval_tpl_pricing_mode_switch','supply.rules.mode_switch','supply.rules.mode_switch.requested',1)
ON CONFLICT (operation_code,trigger_condition) DO NOTHING;

ALTER TABLE zzsh_order.rental_order ADD COLUMN fixed_fee_early_v2 boolean NOT NULL DEFAULT false;
CREATE FUNCTION zzsh_order.guard_fixed_fee_early_version() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    NEW.fixed_fee_early_v2:=COALESCE(NEW.quote_snapshot #>> '{personal,schema}'='personal-quote-v5',false);
  ELSIF NEW.fixed_fee_early_v2 IS DISTINCT FROM OLD.fixed_fee_early_v2 THEN
    RAISE EXCEPTION 'order settlement calculation version is immutable' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER rental_order_fixed_fee_early_version BEFORE INSERT OR UPDATE OF fixed_fee_early_v2 ON zzsh_order.rental_order
  FOR EACH ROW EXECUTE FUNCTION zzsh_order.guard_fixed_fee_early_version();
COMMENT ON COLUMN zzsh_order.rental_order.fixed_fee_early_v2 IS '新建固定手续费订单使用按折后租金限制补足基数并统一舍入的提前结束合同。';
