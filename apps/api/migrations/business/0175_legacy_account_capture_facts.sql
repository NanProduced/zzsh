-- 旧账号在采集时的补充展示事实：只追加，不更改旧展示快照、订单或发布报价。
CREATE TABLE zzsh_supply.legacy_listing_capture_fact (
  account_id text PRIMARY KEY REFERENCES zzsh_supply.legacy_listing_read_snapshot(account_id),
  observation_version_id text NOT NULL,
  base_source_digest text NOT NULL CHECK (base_source_digest ~ '^[a-f0-9]{64}$'),
  display_digest text NOT NULL CHECK (display_digest ~ '^[a-f0-9]{64}$'),
  capture_sha256 text NOT NULL CHECK (capture_sha256 ~ '^[a-f0-9]{64}$'),
  source_updated_at timestamptz NOT NULL,
  base_ratio_wan_per_yuan text,
  ratio_issue text,
  full_payout_selected boolean,
  payout_issue text,
  evidence_digest text NOT NULL CHECK (evidence_digest ~ '^[a-f0-9]{64}$'),
  created_by_admin_id text NOT NULL REFERENCES zzsh_auth_admin."user"(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT legacy_capture_observation_fk FOREIGN KEY (observation_version_id,account_id)
    REFERENCES zzsh_supply.listing_version(id,account_id),
  CONSTRAINT legacy_capture_ratio_check CHECK (
    (base_ratio_wan_per_yuan IS NULL AND ratio_issue IS NOT NULL AND ratio_issue IN ('base_bot:MISSING','base_bot:NON_POSITIVE','base_bot:INVALID'))
    OR (base_ratio_wan_per_yuan IS NOT NULL AND ratio_issue IS NULL
      AND CASE WHEN base_ratio_wan_per_yuan ~ '^(0|[1-9][0-9]{0,9})(\.[0-9]{1,8})?$'
        THEN base_ratio_wan_per_yuan::numeric > 0 ELSE false END)),
  CONSTRAINT legacy_capture_payout_check CHECK (
    (full_payout_selected IS NULL AND payout_issue IS NOT NULL AND payout_issue='is_full_payout:UNKNOWN')
    OR (full_payout_selected IS NOT NULL AND payout_issue IS NULL))
);
--> statement-breakpoint
CREATE FUNCTION zzsh_supply.guard_legacy_listing_capture_fact() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM zzsh_supply.legacy_listing_read_snapshot h
    JOIN zzsh_supply.legacy_listing_display_snapshot d
      ON d.account_id=h.account_id AND d.schema_version=1
    WHERE h.account_id=NEW.account_id AND h.observation_version_id=NEW.observation_version_id
      AND h.source_digest=NEW.base_source_digest AND h.source_updated_at=NEW.source_updated_at
      AND d.observation_version_id=h.observation_version_id AND d.base_source_digest=h.source_digest
      AND d.source_updated_at=h.source_updated_at AND d.display_digest=NEW.display_digest
      AND (NOT (d.snapshot ? 'sourceAccountBaseRatioWanPerYuan') OR
        (jsonb_typeof(d.snapshot->'sourceAccountBaseRatioWanPerYuan') IN ('string','null')
        AND d.snapshot->>'sourceAccountBaseRatioWanPerYuan' IS NOT DISTINCT FROM NEW.base_ratio_wan_per_yuan))
      AND (NOT (d.snapshot ? 'sourceAccountFullPayoutSelected') OR
        (jsonb_typeof(d.snapshot->'sourceAccountFullPayoutSelected') IN ('boolean','null')
        AND d.snapshot->>'sourceAccountFullPayoutSelected' IS NOT DISTINCT FROM NEW.full_payout_selected::text))
  ) THEN RAISE EXCEPTION 'legacy account capture must bind original observation and display'; END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
CREATE TRIGGER legacy_capture_insert BEFORE INSERT ON zzsh_supply.legacy_listing_capture_fact
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_legacy_listing_capture_fact();
--> statement-breakpoint
CREATE TRIGGER legacy_capture_immutable BEFORE UPDATE OR DELETE ON zzsh_supply.legacy_listing_capture_fact
FOR EACH ROW EXECUTE FUNCTION zzsh_supply.guard_release_immutable();
--> statement-breakpoint
REVOKE ALL ON zzsh_supply.legacy_listing_capture_fact FROM PUBLIC;
--> statement-breakpoint
COMMENT ON TABLE zzsh_supply.legacy_listing_capture_fact IS '旧账号采集时的比例和包赔展示事实；不代表订单下单时冻结值。';
--> statement-breakpoint
COMMENT ON COLUMN zzsh_supply.legacy_listing_capture_fact.account_id IS '关联的新平台账号标识。';
--> statement-breakpoint
COMMENT ON COLUMN zzsh_supply.legacy_listing_capture_fact.observation_version_id IS '绑定的原始旧账号观察版本。';
--> statement-breakpoint
COMMENT ON COLUMN zzsh_supply.legacy_listing_capture_fact.base_source_digest IS '已导入原始旧账号来源行的摘要。';
--> statement-breakpoint
COMMENT ON COLUMN zzsh_supply.legacy_listing_capture_fact.display_digest IS '原始不可变展示快照的摘要。';
--> statement-breakpoint
COMMENT ON COLUMN zzsh_supply.legacy_listing_capture_fact.capture_sha256 IS '经核验的旧账号采集文件摘要。';
--> statement-breakpoint
COMMENT ON COLUMN zzsh_supply.legacy_listing_capture_fact.source_updated_at IS '原始旧账号在采集时记录的更新时间。';
--> statement-breakpoint
COMMENT ON COLUMN zzsh_supply.legacy_listing_capture_fact.base_ratio_wan_per_yuan IS '采集时旧账号的万哈夫币每元比例，未知时为空。';
--> statement-breakpoint
COMMENT ON COLUMN zzsh_supply.legacy_listing_capture_fact.ratio_issue IS '比例未知的来源原因，已知时为空。';
--> statement-breakpoint
COMMENT ON COLUMN zzsh_supply.legacy_listing_capture_fact.full_payout_selected IS '采集时旧账号是否选择包赔，未知时为空。';
--> statement-breakpoint
COMMENT ON COLUMN zzsh_supply.legacy_listing_capture_fact.payout_issue IS '包赔状态未知的来源原因，已知时为空。';
--> statement-breakpoint
COMMENT ON COLUMN zzsh_supply.legacy_listing_capture_fact.evidence_digest IS '账号、原快照、采集来源与补充字段的规范化证据摘要。';
--> statement-breakpoint
COMMENT ON COLUMN zzsh_supply.legacy_listing_capture_fact.created_by_admin_id IS '完成该补充事实记录的管理员审计主体。';
--> statement-breakpoint
COMMENT ON COLUMN zzsh_supply.legacy_listing_capture_fact.created_at IS '补充事实在当前库中记录的时间。';
