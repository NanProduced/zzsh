import { setSystemInitialSource } from "../database/system-initial-source";
import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { recordAudit } from "../auth/security-core";
import { lockFixedFeePolicyChange } from "../auth/fixed-fee-policy-timeline";
import { assertSealedRuleRelease } from "../auth/membership-growth-approval";
import { NORMAL_GROWTH_TIERS, validateBenefitPolicy, type GrowthBenefitPolicy } from "../auth/membership-growth";
import { normalizeUnifiedMembershipPolicy, projectUnifiedMembershipPricing } from "../auth/membership-unified-pricing";
import { assertContentBootstrapBoss } from "../content/content-bootstrap";
import { canonicalize, normalizeTime } from "./content-hash";
import { DELTA_CUSTOM_DAILY_CONSUMPTION, validateDeltaHaffRule } from "./delta-rental";
import { initializeFixedFeePricing } from "./pricing-policy-schedule";
import {
  assertPriceVersionResources, createAgreementDraft, createFullPayoutTermsDraft, createPriceDraft,
  createTermDraft, parseTermOptions, sealVersion, updatePriceDraft, updateTermDraft,
} from "./rules";
import { conflict, ensureOnlyFields, invalid, newSupplyId, requiredString, sha256Hex } from "./supply-util";

function fields(value: unknown, keys: readonly string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("首次租赁配置格式无效");
  const row = value as Record<string, unknown>;
  ensureOnlyFields(row, keys);
  if (keys.some(key => !Object.hasOwn(row, key))) throw invalid("首次租赁配置缺少必填字段");
  return row;
}

/** Called by the migration CLI in one transaction using an Owner-supplied, digest-bound package. */
export async function initializeFixedFeeDeployment(client: PoolClient, bytes: Buffer, expectedSha256: string) {
  if (client.getTransactionStatus() !== "T") throw invalid("首次租赁配置必须在事务内执行");
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || bytes.length > 1_000_000 || createHash("sha256").update(bytes).digest("hex") !== expectedSha256)
    throw invalid("首次租赁配置文件摘要不一致");
  let raw: unknown;
  try { raw = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw invalid("首次租赁配置不是有效的 UTF-8 JSON"); }
  const input = fields(raw, ["schema", "gameId", "initialBossId", "effectiveAt", "price", "termOptions", "agreement", "fullPayoutTerms", "memberDeposits", "unifiedPricing"]);
  const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  const gameId = requiredString(input, "gameId", 128), boss = requiredString(input, "initialBossId", 128);
  let effectiveAt: string | null;
  try { effectiveAt = normalizeTime(requiredString(input, "effectiveAt", 48)); } catch { throw invalid("首次租赁配置生效时间无效"); }
  if (input.schema !== "initial-fixed-fee-v1" || !id.test(gameId) || !id.test(boss) || !effectiveAt)
    throw invalid("首次租赁配置标识无效");
  const price = fields(input.price, ["fixedFeeRates", "haffRule", "lines", "fundingPolicy"]);
  if (!price.fundingPolicy || !price.haffRule || !Array.isArray(price.lines)) throw invalid("首次计价必须提供价格、比例和资金规则");
  const terms = parseTermOptions(input.termOptions);
  const rule = validateDeltaHaffRule(price.haffRule, "PERCENT");
  if (rule.schema !== "haff-ratio-v3" || terms.some(term => !Object.hasOwn(rule.dailyDeltaByTermOption, term.code))
    || !terms.some(term => term.dailyConsumption === DELTA_CUSTOM_DAILY_CONSUMPTION))
    throw invalid("首次租期选项须有对应比例，并包含自定义出租所用的日耗");
  const agreement = fields(input.agreement, ["title", "body"]);
  const fullPayoutTerms = fields(input.fullPayoutTerms, ["title", "body", "policyRef", "policyVersion", "disclosureVersion"]);
  const memberDeposits = fields(input.memberDeposits, NORMAL_GROWTH_TIERS);
  const tiers = {} as GrowthBenefitPolicy["tiers"];
  for (const tier of NORMAL_GROWTH_TIERS) {
    const entry = memberDeposits[tier];
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid("首次会员押金配置无效");
    const { tenantDeposit, depositAllowanceCents } = entry as Record<string, unknown>;
    ensureOnlyFields(entry as Record<string, unknown>, ["tenantDeposit", "depositAllowanceCents"]);
    if ((tenantDeposit !== "ACCOUNT_BASE" && tenantDeposit !== "WAIVED")
      || (depositAllowanceCents !== undefined && typeof depositAllowanceCents !== "string")) throw invalid("首次会员押金配置无效");
    tiers[tier] = { tier, tenantDeposit, ...(depositAllowanceCents === undefined ? {} : { depositAllowanceCents }),
      pricing: {}, entitlementCap: { status: "NOT_PRICED", reason: "独立礼遇范围" } };
  }

  const role = (await client.query(`SELECT current_user=session_user AND NOT r.rolsuper AND NOT r.rolbypassrls
    AND r.oid=c.relowner AS allowed FROM pg_roles r JOIN pg_class c ON c.oid=to_regclass('zzsh_supply.pricing_policy_schedule')
    WHERE r.rolname=current_user`)).rows[0];
  if (role?.allowed !== true) throw conflict("首次租赁配置需要独立迁移角色及完整价格结构");
  await lockFixedFeePolicyChange(client);
  const game = (await client.query(`SELECT code,enabled,current_release_id AS "releaseId"
    FROM zzsh_supply.game WHERE id=$1 FOR UPDATE`, [gameId])).rows[0];
  if (game?.code !== "delta" || game.enabled !== true) throw conflict("首次租赁配置需要已启用的三角洲游戏目录");
  const requestId = "first-fixed-fee-" + expectedSha256;
  const previous = (await client.query(`SELECT a.object_id AS "releaseId",a.details,
    r.id IS NOT NULL AND m.id IS NOT NULL AS bound FROM zzsh_iam.audit_event a
    LEFT JOIN zzsh_supply.rule_release r ON r.id=a.object_id AND r.game_id=$2 AND r.generation=1
      AND r.price_version_id=a.details->>'priceVersionId' AND r.system_initial_sha256=$4
      AND EXISTS(SELECT 1 FROM zzsh_supply.price_version p JOIN zzsh_supply.full_payout_terms_version f ON f.id=p.full_payout_terms_version_id
        WHERE p.id=r.price_version_id AND p.system_initial_sha256=$4 AND f.system_initial_sha256=$4)
      AND EXISTS(SELECT 1 FROM zzsh_supply.term_version t WHERE t.id=r.term_version_id AND t.system_initial_sha256=$4)
      AND EXISTS(SELECT 1 FROM zzsh_supply.agreement_version ag WHERE ag.id=r.agreement_version_id AND ag.system_initial_sha256=$4)
    LEFT JOIN zzsh_iam.membership_growth_policy m ON m.id=a.details->>'membershipPolicyId'
      AND m.rule_release_id=r.id AND m.price_version_id=r.price_version_id AND m.version=1
      AND m.source_ref=$3 AND m.approval_request_id IS NULL AND m.approved_by_admin_id IS NULL
    WHERE a.actor_type='system' AND a.outcome='SUCCESS'
      AND a.action='supply.rules.first_fixed_fee.initialized' AND a.request_id=$1`,
  [requestId, gameId, "initial-fixed-fee:" + expectedSha256, expectedSha256])).rows;
  if (previous.length === 1 && previous[0]?.bound === true
    && previous[0].details?.packageSha256 === expectedSha256 && previous[0].details.gameId === gameId) {
    const result = await initializeFixedFeePricing(client, { gameId, priceVersionId: previous[0].details.priceVersionId, effectiveAt, requestId });
    if (result.status !== "ALREADY_INITIALIZED") throw conflict("首次租赁配置的原回执不完整");
    return { ...result, releaseId: previous[0].releaseId, packageSha256: expectedSha256 };
  }
  await client.query("LOCK TABLE zzsh_iam.membership_growth_policy IN SHARE ROW EXCLUSIVE MODE");
  const existing = (await client.query(`SELECT EXISTS (SELECT 1 FROM zzsh_supply.rule_release WHERE game_id=$1)
    OR EXISTS (SELECT 1 FROM zzsh_supply.pricing_policy_schedule WHERE game_id=$1)
    OR EXISTS (SELECT 1 FROM zzsh_supply.pricing_mode_schedule WHERE game_id=$1)
    OR EXISTS (SELECT 1 FROM zzsh_iam.membership_growth_policy)
    OR EXISTS (SELECT 1 FROM zzsh_supply.listing_publication WHERE game_id=$1 AND source='OWNER_DIRECT')
    OR EXISTS (SELECT 1 FROM zzsh_order.rental_order WHERE game_id=$1) AS occupied`, [gameId])).rows[0];
  if (game.releaseId !== null || existing?.occupied !== false || previous.length) throw conflict("已有租赁或会员配置，未覆盖");
  // Use the reserved Boss for version provenance. The migration creates no session or approval.
  await assertContentBootstrapBoss(client, boss);
  await setSystemInitialSource(client, expectedSha256);
  const payout = await createFullPayoutTermsDraft(client, boss, true, gameId, fullPayoutTerms);
  await sealVersion(client, boss, true, "full_payout_terms_version", payout.id, "0");
  const { id: priceVersionId } = await createPriceDraft(client, boss, true, gameId, "PERCENT", price.fixedFeeRates);
  await updatePriceDraft(client, boss, true, priceVersionId, { ...price, expectedRevision: "1" });
  await sealVersion(client, boss, true, "price_version", priceVersionId, "2");
  await assertPriceVersionResources(client, gameId, priceVersionId, "PERCENT");

  const term = await createTermDraft(client, boss, true, gameId);
  await updateTermDraft(client, boss, true, term.id, { expectedRevision: "1", options: terms });
  await sealVersion(client, boss, true, "term_version", term.id, "2");
  const agreementVersion = await createAgreementDraft(client, boss, true, gameId, requiredString(agreement, "title", 120), requiredString(agreement, "body", 20_000));
  await sealVersion(client, boss, true, "agreement_version", agreementVersion.id, "1");
  const releaseId = newSupplyId("release");
  await client.query(`INSERT INTO zzsh_supply.rule_release(id,game_id,price_version_id,term_version_id,agreement_version_id,generation,activated_by_admin_id,system_initial_sha256)
    VALUES($1,$2,$3,$4,$5,1,$6,$7)`, [releaseId, gameId, priceVersionId, term.id, agreementVersion.id, boss, expectedSha256]);
  await client.query("UPDATE zzsh_supply.game SET current_release_id=$2,updated_at=clock_timestamp() WHERE id=$1", [gameId, releaseId]);
  const sealed = await assertSealedRuleRelease(client, releaseId, priceVersionId);
  if (!sealed.fixedFeeRates || sealed.enabledModes.length !== 3) throw invalid("首次价格必须明确配置普通、自定义和极速");
  const sourceRef = "initial-fixed-fee:" + expectedSha256;
  let policy: GrowthBenefitPolicy;
  try {
    policy = normalizeUnifiedMembershipPolicy({ schema: "membership-growth-v1", version: "1", status: "APPROVED", effectiveAt,
      sourceRef, tiers, entitlementCaps: { FRIEND: "GOLD", PRESTIGE: "DIAMOND" } }, input.unifiedPricing,
    { enabledModes: sealed.enabledModes, priceVersionId });
  } catch { throw invalid("首次会员或礼遇折扣配置无效"); }
  if (!validateBenefitPolicy(policy, { enabledModes: sealed.enabledModes, catalog: sealed.catalog, releaseMode: sealed.releaseMode,
    fixedFeeRates: sealed.fixedFeeRates }).publishable || projectUnifiedMembershipPricing(policy, sealed.enabledModes).knowledge !== "KNOWN")
    throw conflict("首次会员或礼遇折扣与固定手续费不兼容");
  const membershipPolicyId = newSupplyId("growth_policy");
  await client.query(`INSERT INTO zzsh_iam.membership_growth_policy
    (id,version,status,effective_at,rule_release_id,price_version_id,source_ref,policy_schema,policy_payload,payload_hash)
    VALUES($1,1,'APPROVED',$2,$3,$4,$5,'membership-growth-v1',$6::jsonb,$7)`,
  [membershipPolicyId, effectiveAt, releaseId, priceVersionId, sourceRef, JSON.stringify(policy), sha256Hex(canonicalize(policy))]);
  const result = await initializeFixedFeePricing(client, { gameId, priceVersionId, effectiveAt, requestId });
  await setSystemInitialSource(client, null);
  await recordAudit(client, { actorType: "system", action: "supply.rules.first_fixed_fee.initialized", objectType: "rule_release",
    objectId: releaseId, outcome: "SUCCESS", requestId, details: { packageSha256: expectedSha256, gameId, priceVersionId, membershipPolicyId, compatibilityBossRef: boss } });
  return { ...result, releaseId, packageSha256: expectedSha256 };
}
