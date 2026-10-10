-- 0068 assigned by Master 2026-10-09. Candidate only; database execution not approved.
-- MEMBERSHIP-GROWTH-1 schema and personal quote v3 contract
-- idx68 / when1789490037000; original 0..67 immutable.
-- 这些表保存成长事实/版本和礼遇授予，不复制钱包、订单或资金分录。

CREATE TABLE zzsh_iam.membership_growth_policy (
  id text PRIMARY KEY,
  version bigint NOT NULL CHECK (version >= 1),
  status text NOT NULL CHECK (status IN ('DRAFT', 'APPROVED', 'REVOKED')),
  effective_at timestamptz,
  rule_release_id text NOT NULL,
  price_version_id text NOT NULL,
  source_ref text NOT NULL,
  policy_schema text NOT NULL CHECK (policy_schema = 'membership-growth-v1'),
  policy_payload jsonb NOT NULL,
  payload_hash char(64) NOT NULL,
  approval_request_id text,
  approved_by_admin_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE zzsh_iam.membership_growth_contribution (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  game_id text NOT NULL,
  source_key text NOT NULL,
  source_type text NOT NULL CHECK (source_type IN ('RENTAL_SETTLEMENT', 'MATERIAL_CONSUMPTION', 'MINIMUM_BILLING', 'REFUND_CORRECTION')),
  source_id text NOT NULL,
  settlement_version text NOT NULL,
  revision bigint NOT NULL CHECK (revision >= 0),
  effective_at timestamptz NOT NULL,
  recorded_at timestamptz NOT NULL,
  amount_cents numeric(24,0) NOT NULL,
  previous_amount_cents numeric(24,0),
  correction_of_source_key text,
  correction_mode text CHECK (correction_mode IN ('REPLACE', 'INCREMENT')),
  state text NOT NULL CHECK (state IN ('SETTLED', 'PENDING', 'VOID')),
  eligible boolean NOT NULL,
  exclusion_reason text,
  source_digest char(64) NOT NULL CHECK (source_digest ~ '^[0-9a-f]{64}$'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, source_key, revision)
);

CREATE INDEX membership_growth_contribution_user_effective_idx
  ON zzsh_iam.membership_growth_contribution (user_id, effective_at DESC);
CREATE INDEX membership_growth_contribution_user_game_idx
  ON zzsh_iam.membership_growth_contribution (user_id, game_id, effective_at DESC);

CREATE TABLE zzsh_iam.membership_growth_state (
  user_id text PRIMARY KEY,
  policy_id text NOT NULL REFERENCES zzsh_iam.membership_growth_policy(id),
  rolling_cents numeric(24,0) NOT NULL,
  rolling_points bigint NOT NULL,
  lifetime_cents numeric(24,0) NOT NULL,
  lifetime_points bigint NOT NULL,
  normal_tier text NOT NULL CHECK (normal_tier IN ('STANDARD', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND')),
  effective_tier text NOT NULL CHECK (effective_tier IN ('STANDARD', 'SILVER', 'GOLD', 'PLATINUM', 'DIAMOND', 'BLACK_GOLD', 'UNKNOWN')),
  black_gold_state text NOT NULL CHECK (black_gold_state IN ('QUALIFIED', 'NOT_QUALIFIED', 'REVIEW_REQUIRED')),
  grace_state text NOT NULL CHECK (grace_state IN ('NONE', 'ACTIVE', 'RECOVERED', 'EXPIRED', 'UNKNOWN')),
  last_tier_drop_at timestamptz,
  grace_until timestamptz,
  projection_revision bigint NOT NULL CHECK (projection_revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE zzsh_iam.membership_entitlement (
  id text PRIMARY KEY,
  user_id text NOT NULL,
  game_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('FRIEND', 'PRESTIGE')),
  scope_key text NOT NULL,
  starts_at timestamptz NOT NULL,
  ends_at timestamptz NOT NULL CHECK (ends_at > starts_at AND ends_at <= starts_at + interval '90 days'),
  pricing_schema text NOT NULL CHECK (pricing_schema IN ('haff-ratio-v1', 'haff-ratio-v2')),
  pricing_payload jsonb NOT NULL,
  price_version_id text NOT NULL,
  cost_basis_ref text NOT NULL,
  deposit_waived boolean NOT NULL DEFAULT false,
  approved_policy_id text NOT NULL REFERENCES zzsh_iam.membership_growth_policy(id),
  approval_request_id text NOT NULL,
  approved_payload_hash char(64) NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING', 'APPROVED_PENDING_EXECUTION', 'EXECUTED_PENDING_START', 'ACTIVE', 'EXPIRED', 'REVOKED', 'REPLACED')),
  replaced_by_id text REFERENCES zzsh_iam.membership_entitlement(id),
  revoked_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX membership_entitlement_subject_scope_idx
  ON zzsh_iam.membership_entitlement (user_id, game_id, scope_key, starts_at, ends_at);

-- Permission/approval registration draft only; no journal number or execution in this task.
INSERT INTO zzsh_iam.admin_permission(code, name, description) VALUES
  ('membership.growth.read.summary', '会员成长摘要读取', '读取授权用户的全站成长摘要，不自动授予范围明细'),
  ('membership.growth.read.detail', '会员成长明细读取', '按管理员game scope读取成长来源明细'),
  ('membership.policy.draft', '会员政策草稿', '保存会员政策草稿并查看差异'),
  ('membership.policy.publish', '会员政策发布', '提交或执行已审批的会员政策发布'),
  ('membership.entitlement.request', '会员礼遇申请', '提交人工礼遇申请'),
  ('membership.entitlement.decide', '会员礼遇决定', '决定人工礼遇审批且不得自审'),
  ('membership.entitlement.execute', '会员礼遇执行', '执行已批准的人工礼遇'),
  ('membership.entitlement.revoke', '会员礼遇撤销', '在授权范围内提交并执行礼遇撤销'),
  ('membership.growth.audit.read', '会员成长审计', '读取会员成长和礼遇审计事件'),
  ('membership.growth.backfill', '会员成长补读', '在授权game scope内重复执行已过账结算的成长补读')
ON CONFLICT (code) DO NOTHING;

-- No wallet/ledger/order/receipt table is added. Applying this draft requires
-- a separately approved migration, ACL, journal number, backfill plan and lock.

--> statement-breakpoint
-- MEMBERSHIP-SOURCE-INPUT-REPAIR-1
-- Derived from apps/api/migrations/business/0051_order_personal_quote_v2_guard_fix.sql.
-- Separate unnumbered repair artifact; the original v3 draft is preserved.
-- PG parsing/execution: NOT_RUN.
CREATE OR REPLACE FUNCTION zzsh_order.guard_personal_order() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  expires_text text;
  personal_schema text;
  personal_doc jsonb;
  declaration_doc jsonb;
  rule_refs_doc jsonb;
  membership_doc jsonb;
  guarantee_doc jsonb;
  funding_doc jsonb;
  growth_doc jsonb;
  binding_doc jsonb;
  key_count integer;
BEGIN
  IF TG_OP='UPDATE' THEN
    IF NEW.confirmation_id IS DISTINCT FROM OLD.confirmation_id THEN
      RAISE EXCEPTION 'confirmation consumption is immutable' USING ERRCODE='40001';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.quote_snapshot->>'quoteKind'='ORDER_CONFIRMATION' THEN
    personal_schema := NEW.quote_snapshot#>>'{personal,schema}';
    IF NEW.confirmation_id IS NULL
      OR NEW.quote_snapshot->>'confirmationId' IS DISTINCT FROM NEW.confirmation_id::text
      OR NEW.quote_snapshot->>'orderSnapshotSchema' IS DISTINCT FROM '1'
      OR COALESCE(NEW.quote_snapshot->>'confirmationDigest','') !~ '^[0-9a-f]{64}$'
      OR NEW.quote_snapshot->>'listingHash' IS DISTINCT FROM NEW.content_hash
      OR NEW.quote_snapshot#>>'{personal,listingHash}' IS DISTINCT FROM NEW.content_hash
      OR NEW.quote_snapshot#>>'{personal,userId}' IS DISTINCT FROM NEW.renter_user_id
      OR (personal_schema IS DISTINCT FROM 'personal-quote-v1' AND personal_schema IS DISTINCT FROM 'personal-quote-v2' AND personal_schema IS DISTINCT FROM 'personal-quote-v3')
      OR jsonb_typeof(NEW.quote_snapshot->'priceVersionId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(NEW.quote_snapshot->'ruleReleaseId') IS DISTINCT FROM 'string'
      OR jsonb_typeof(NEW.quote_snapshot->'termSeconds') IS DISTINCT FROM 'string'
      OR NEW.quote_snapshot->>'priceVersionId' IS DISTINCT FROM NEW.quote_snapshot#>>'{personal,ruleRefs,priceVersionId}'
      OR NEW.quote_snapshot->>'ruleReleaseId' IS DISTINCT FROM NEW.rule_release_id
      OR NEW.quote_snapshot#>>'{personal,ruleRefs,releaseId}' IS DISTINCT FROM NEW.rule_release_id
      OR NEW.quote_snapshot#>>'{personal,ruleRefs,priceVersionId}' IS DISTINCT FROM NEW.quote_snapshot->>'priceVersionId'
      OR NEW.quote_snapshot->>'termSeconds' IS DISTINCT FROM NEW.term_seconds::text
      OR COALESCE(NEW.quote_snapshot#>>'{personal,membership,tier}','') NOT IN ('STANDARD','VIP','SVIP','DISCOUNT_USER')
      OR COALESCE(NEW.quote_snapshot#>>'{personal,membership,version}','') !~ '^[1-9][0-9]{0,18}$'
      OR NEW.quote_snapshot ? 'confirmationToken' OR NEW.quote_snapshot ? 'signature' THEN
      RAISE EXCEPTION 'invalid personal order snapshot' USING ERRCODE='40001';
    END IF;

    IF personal_schema IN ('personal-quote-v2','personal-quote-v3') THEN
      personal_doc := NEW.quote_snapshot->'personal';
      IF jsonb_typeof(personal_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'invalid personal order snapshot' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(personal_doc) AS object_key(key);
      IF (personal_schema='personal-quote-v2' AND key_count <> 11)
        OR (personal_schema='personal-quote-v3' AND key_count <> 12)
        OR EXISTS (
          SELECT 1 FROM jsonb_object_keys(personal_doc) AS object_key(key)
          WHERE NOT (object_key.key = ANY (ARRAY[
            'schema','userId','ownerUserId','accountId','listingVersionId','listingHash',
            'fullPayoutDeclaration','ruleRefs','membership','guarantee','funding','membershipGrowth'
          ]::text[]))
          OR (personal_schema='personal-quote-v2' AND object_key.key='membershipGrowth')
        ) THEN
        RAISE EXCEPTION 'invalid personal quote v2/v3 shape' USING ERRCODE='40001';
      END IF;
      IF jsonb_typeof(personal_doc->'schema') IS DISTINCT FROM 'string'
        OR jsonb_typeof(personal_doc->'userId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(personal_doc->'ownerUserId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(personal_doc->'accountId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(personal_doc->'listingVersionId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(personal_doc->'listingHash') IS DISTINCT FROM 'string'
        OR personal_doc->>'ownerUserId' IS DISTINCT FROM NEW.owner_user_id
        OR personal_doc->>'accountId' IS DISTINCT FROM NEW.account_id
        OR personal_doc->>'listingVersionId' IS DISTINCT FROM NEW.listing_version_id
        OR personal_doc->>'listingHash' IS DISTINCT FROM NEW.content_hash
        OR personal_doc->>'schema' IS DISTINCT FROM personal_schema
        OR NEW.quote_snapshot ? 'fullPayoutSelected'
        OR NEW.quote_snapshot ? 'fullPayoutFeeCents' THEN
        RAISE EXCEPTION 'personal quote v2/v3 binding is invalid' USING ERRCODE='40001';
      END IF;

      declaration_doc := personal_doc->'fullPayoutDeclaration';
      IF jsonb_typeof(declaration_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2/v3 declaration is invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(declaration_doc) AS object_key(key);
      IF key_count <> 2 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(declaration_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY['schema','selected']::text[]))
      ) OR declaration_doc->>'schema' IS DISTINCT FROM 'full-payout-declaration-v1'
        OR jsonb_typeof(declaration_doc->'selected') IS DISTINCT FROM 'boolean' THEN
        RAISE EXCEPTION 'personal quote v2/v3 declaration is invalid' USING ERRCODE='40001';
      END IF;

      rule_refs_doc := personal_doc->'ruleRefs';
      IF jsonb_typeof(rule_refs_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2/v3 rule references are invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(rule_refs_doc) AS object_key(key);
      IF key_count <> 5 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(rule_refs_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY['releaseId','priceVersionId','termVersionId','agreementVersionId','agreementDigest']::text[]))
      ) THEN
        RAISE EXCEPTION 'personal quote v2/v3 rule references are invalid' USING ERRCODE='40001';
      END IF;
      IF jsonb_typeof(rule_refs_doc->'releaseId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(rule_refs_doc->'priceVersionId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(rule_refs_doc->'termVersionId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(rule_refs_doc->'agreementVersionId') IS DISTINCT FROM 'string'
        OR jsonb_typeof(rule_refs_doc->'agreementDigest') IS DISTINCT FROM 'string'
        OR COALESCE(NULLIF(trim(rule_refs_doc->>'releaseId'),''),'') = ''
        OR COALESCE(NULLIF(trim(rule_refs_doc->>'priceVersionId'),''),'') = ''
        OR COALESCE(NULLIF(trim(rule_refs_doc->>'termVersionId'),''),'') = ''
        OR COALESCE(NULLIF(trim(rule_refs_doc->>'agreementVersionId'),''),'') = ''
        OR COALESCE(rule_refs_doc->>'agreementDigest','') !~ '^[0-9a-f]{64}$'
        OR rule_refs_doc->>'releaseId' IS DISTINCT FROM NEW.rule_release_id
        OR rule_refs_doc->>'priceVersionId' IS DISTINCT FROM NEW.quote_snapshot->>'priceVersionId' THEN
        RAISE EXCEPTION 'personal quote v2/v3 rule references are invalid' USING ERRCODE='40001';
      END IF;

      membership_doc := personal_doc->'membership';
      IF jsonb_typeof(membership_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2/v3 membership is invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(membership_doc) AS object_key(key);
      IF key_count <> 3 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(membership_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY['tier','version','sourceRef']::text[]))
      ) OR jsonb_typeof(membership_doc->'tier') IS DISTINCT FROM 'string'
        OR jsonb_typeof(membership_doc->'version') IS DISTINCT FROM 'string'
        OR jsonb_typeof(membership_doc->'sourceRef') IS DISTINCT FROM 'string'
        OR COALESCE(membership_doc->>'tier','') NOT IN ('STANDARD','VIP','SVIP','DISCOUNT_USER')
        OR COALESCE(membership_doc->>'version','') !~ '^[1-9][0-9]{0,18}$'
        OR COALESCE(NULLIF(trim(membership_doc->>'sourceRef'),''),'') = '' THEN
        RAISE EXCEPTION 'personal quote v2/v3 membership is invalid' USING ERRCODE='40001';
      END IF;

      guarantee_doc := personal_doc->'guarantee';
      IF jsonb_typeof(guarantee_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2/v3 guarantee is invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(guarantee_doc) AS object_key(key);
      IF key_count <> 2 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(guarantee_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY['status','reference']::text[]))
      ) OR jsonb_typeof(guarantee_doc->'status') IS DISTINCT FROM 'string'
        OR jsonb_typeof(guarantee_doc->'reference') IS DISTINCT FROM 'string'
        OR COALESCE(guarantee_doc->>'status','') NOT IN ('SATISFIED','NOT_REQUIRED')
        OR COALESCE(NULLIF(trim(guarantee_doc->>'reference'),''),'') = '' THEN
        RAISE EXCEPTION 'personal quote v2/v3 guarantee is invalid' USING ERRCODE='40001';
      END IF;

      funding_doc := personal_doc->'funding';
      IF jsonb_typeof(funding_doc) IS DISTINCT FROM 'object' THEN
        RAISE EXCEPTION 'personal quote v2/v3 funding is invalid' USING ERRCODE='40001';
      END IF;
      SELECT count(*) INTO key_count FROM jsonb_object_keys(funding_doc) AS object_key(key);
      IF key_count <> 9 OR EXISTS (
        SELECT 1 FROM jsonb_object_keys(funding_doc) AS object_key(key)
        WHERE NOT (object_key.key = ANY (ARRAY[
          'version','sourceRef','baseDepositCents','publisherBailRequirementCents',
          'fullPayoutPolicyRef','fullPayoutPolicyVersion','disclosureVersion','vipWaiver','svipWaiver'
        ]::text[]))
      ) THEN
        RAISE EXCEPTION 'personal quote v2/v3 funding is invalid' USING ERRCODE='40001';
      END IF;
      IF jsonb_typeof(funding_doc->'version') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'sourceRef') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'baseDepositCents') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'publisherBailRequirementCents') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'fullPayoutPolicyRef') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'fullPayoutPolicyVersion') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'disclosureVersion') IS DISTINCT FROM 'string'
        OR jsonb_typeof(funding_doc->'vipWaiver') IS DISTINCT FROM 'boolean'
        OR jsonb_typeof(funding_doc->'svipWaiver') IS DISTINCT FROM 'boolean'
        OR COALESCE(NULLIF(trim(funding_doc->>'version'),''),'') = ''
        OR COALESCE(NULLIF(trim(funding_doc->>'sourceRef'),''),'') = ''
        OR COALESCE(funding_doc->>'baseDepositCents','') !~ '^(0|[1-9][0-9]{0,17})$'
        OR COALESCE(funding_doc->>'publisherBailRequirementCents','') !~ '^(0|[1-9][0-9]{0,17})$'
        OR COALESCE(NULLIF(trim(funding_doc->>'fullPayoutPolicyRef'),''),'') = ''
        OR COALESCE(NULLIF(trim(funding_doc->>'fullPayoutPolicyVersion'),''),'') = ''
        OR COALESCE(NULLIF(trim(funding_doc->>'disclosureVersion'),''),'') = '' THEN
        RAISE EXCEPTION 'personal quote v2/v3 funding is invalid' USING ERRCODE='40001';
      END IF;

      IF personal_schema='personal-quote-v3' THEN
        growth_doc := personal_doc->'membershipGrowth';
        IF jsonb_typeof(growth_doc) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'personal quote v3 growth extension is invalid' USING ERRCODE='40001';
        END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(growth_doc) AS object_key(key);
        IF key_count <> 6 OR EXISTS (
          SELECT 1 FROM jsonb_object_keys(growth_doc) AS object_key(key)
          WHERE NOT (object_key.key = ANY (ARRAY['schema','policyVersion','selectedSource','entitlementIds','binding','depositSource']::text[]))
        ) OR growth_doc->>'schema' IS DISTINCT FROM 'membership-growth-v1'
          OR COALESCE(NULLIF(trim(growth_doc->>'policyVersion'),''),'') = ''
          OR COALESCE(growth_doc->>'selectedSource','') NOT IN ('GROWTH','FRIEND','PRESTIGE')
          OR COALESCE(growth_doc->>'depositSource','') NOT IN ('GROWTH','FRIEND','PRESTIGE','UNKNOWN')
          OR jsonb_typeof(growth_doc->'entitlementIds') IS DISTINCT FROM 'array' THEN
          RAISE EXCEPTION 'personal quote v3 growth extension is invalid' USING ERRCODE='40001';
        END IF;
        IF EXISTS (SELECT 1 FROM jsonb_array_elements(growth_doc->'entitlementIds') AS entitlement(value) WHERE jsonb_typeof(entitlement.value) IS DISTINCT FROM 'string') THEN
          RAISE EXCEPTION 'personal quote v3 entitlement references are invalid' USING ERRCODE='40001';
        END IF;
        binding_doc := growth_doc->'binding';
        IF jsonb_typeof(binding_doc) IS DISTINCT FROM 'object' THEN
          RAISE EXCEPTION 'personal quote v3 offer binding is invalid' USING ERRCODE='40001';
        END IF;
        SELECT count(*) INTO key_count FROM jsonb_object_keys(binding_doc) AS object_key(key);
        IF key_count <> 6
          OR EXISTS (SELECT 1 FROM jsonb_object_keys(binding_doc) AS object_key(key)
                     WHERE NOT (object_key.key = ANY (ARRAY['userId','accountId','ownerUserId','listingVersionId','ruleReleaseId','quantityDigest']::text[])))
          OR binding_doc->>'userId' IS DISTINCT FROM NEW.renter_user_id
          OR binding_doc->>'accountId' IS DISTINCT FROM NEW.account_id
          OR binding_doc->>'ownerUserId' IS DISTINCT FROM NEW.owner_user_id
          OR binding_doc->>'listingVersionId' IS DISTINCT FROM NEW.listing_version_id
          OR binding_doc->>'ruleReleaseId' IS DISTINCT FROM NEW.rule_release_id
          OR COALESCE(binding_doc->>'quantityDigest','') !~ '^[0-9a-f]{64}$' THEN
          RAISE EXCEPTION 'personal quote v3 offer binding is invalid' USING ERRCODE='40001';
        END IF;
      END IF;

      -- The normalized quote is at quote_snapshot root in the real producer.
      IF NEW.quote_snapshot->>'priceVersionId' IS DISTINCT FROM rule_refs_doc->>'priceVersionId'
        OR NEW.quote_snapshot->>'ruleReleaseId' IS DISTINCT FROM NEW.rule_release_id
        OR NEW.quote_snapshot->>'termSeconds' IS DISTINCT FROM NEW.term_seconds::text THEN
        RAISE EXCEPTION 'personal quote v2/v3 quote binding is invalid' USING ERRCODE='40001';
      END IF;

      IF NOT EXISTS (
        SELECT 1
          FROM zzsh_supply.listing_version v
         WHERE v.id=NEW.listing_version_id
           AND v.account_id=NEW.account_id
           AND v.content_hash=NEW.content_hash
           AND v.rule_release_id=NEW.rule_release_id
           AND v.payload->>'accountId' IS NOT DISTINCT FROM NEW.account_id
           AND v.payload->>'gameId' IS NOT DISTINCT FROM NEW.game_id
           AND v.payload#>>'{ruleRefs,releaseId}' IS NOT DISTINCT FROM rule_refs_doc->>'releaseId'
           AND v.payload#>>'{ruleRefs,priceVersionId}' IS NOT DISTINCT FROM rule_refs_doc->>'priceVersionId'
           AND v.payload#>>'{ruleRefs,termVersionId}' IS NOT DISTINCT FROM rule_refs_doc->>'termVersionId'
           AND v.payload#>>'{ruleRefs,agreementVersionId}' IS NOT DISTINCT FROM rule_refs_doc->>'agreementVersionId'
           AND v.payload#>>'{ruleRefs,agreementDigest}' IS NOT DISTINCT FROM rule_refs_doc->>'agreementDigest'
           AND v.payload#>>'{quoteValues,priceVersionId}' IS NOT DISTINCT FROM NEW.quote_snapshot->>'priceVersionId'
           AND v.payload#>>'{quoteValues,termSeconds}' IS NOT DISTINCT FROM NEW.quote_snapshot->>'termSeconds'
           AND v.payload#>'{declaration,attributes,full_payout_declaration}' IS NOT DISTINCT FROM declaration_doc
      ) THEN
        RAISE EXCEPTION 'personal listing reference mismatch' USING ERRCODE='40001';
      END IF;
    ELSIF personal_schema='personal-quote-v1' THEN
      NULL;
    ELSE
      RAISE EXCEPTION 'invalid personal order snapshot' USING ERRCODE='40001';
    END IF;

    IF personal_schema='personal-quote-v1' AND NOT EXISTS(
      SELECT 1 FROM zzsh_supply.listing_version v
       WHERE v.id=NEW.listing_version_id AND v.account_id=NEW.account_id
         AND v.content_hash=NEW.content_hash AND v.rule_release_id=NEW.rule_release_id
    ) THEN
      RAISE EXCEPTION 'personal listing reference mismatch' USING ERRCODE='40001';
    END IF;
    expires_text:=NEW.quote_snapshot->>'confirmationExpiresAt';
    IF expires_text IS NULL OR expires_text !~ '^[1-9][0-9]{0,11}$' THEN
      RAISE EXCEPTION 'invalid confirmation expiry' USING ERRCODE='40001';
    END IF;
    IF extract(epoch FROM clock_timestamp()) >= expires_text::numeric THEN
      RAISE EXCEPTION 'personal confirmation expired' USING ERRCODE='40001';
    END IF;
  ELSIF NEW.confirmation_id IS NOT NULL OR NEW.quote_snapshot ? 'quoteKind' OR NEW.quote_snapshot->>'schemaVersion'='2' THEN
    RAISE EXCEPTION 'personal quote requires confirmation consumption' USING ERRCODE='40001';
  END IF;
  RETURN NEW;
END $$;
