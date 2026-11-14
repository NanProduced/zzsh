import type { PoolClient } from "pg";
import { ADMIN_PERMISSION, loadEffectiveAdminAccess, requirePermission } from "../auth/admin-authorization";
import type { ApprovalOperationExecutorInput } from "../auth/auth-security";
import { lockFixedFeePolicyChange, validateFixedFeeTimeline } from "../auth/fixed-fee-policy-timeline";
import { recordAudit, SecurityApiError } from "../auth/security-core";
import type { DemoFinanceResource } from "../finance/ecs-test-demo-resource";
import { demoSpreadTradingReady } from "../finance/controlled-fixed-fee-resource";
import { normalizeTime, canonicalize } from "./content-hash";
import { effectiveRuleRelease } from "./effective-rule-release";
import { assertRulesGameSupported } from "./game-services";
import { assertPublishedPricingAnnouncement } from "./pricing-announcement";
import { readFixedFeeTimeline, readNewListingPrice, scheduleFixedFeePrice, schedulePricingMode, scheduleSpreadPrice, type PricingModel } from "./pricing-policy-schedule";
import { activateRelease, assertRulePricingTimeline, sealVersion } from "./rules";
import { assertGameScope, conflict, ensureOnlyFields, invalid, newSupplyId, notFound } from "./supply-util";

export const PRICING_MODE_SWITCH_OPERATION = "supply.rules.mode_switch";
export const RULE_CHANGE_SCHEDULED = "RULE_CHANGE_SCHEDULED";
const VERSION = /^(0|[1-9]\d{0,18})$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const stamp = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
type Actor = { userId: string; isBoss: boolean; sessionId?: string };
type Reference = { id: string; revision: string };

function fields(value: unknown, allowed: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("规则变更内容无效");
  const record = value as Record<string, unknown>;
  ensureOnlyFields(record, allowed);
  return record;
}

function required(value: unknown, pattern: RegExp, path: string): string {
  if (typeof value !== "string" || !pattern.test(value)) throw invalid("规则变更引用无效", path);
  return value;
}

function reference(value: unknown): Reference {
  const record = fields(value, ["id", "revision"]);
  return { id: required(record.id, ID, "id"), revision: required(record.revision, VERSION, "revision") };
}

export function parseRuleChange(value: unknown, switching: boolean) {
  const body = fields(value, ["gameId", "effectiveAt", "announcementVersionId", "pricingModel",
    "expectedModeGeneration", "expectedReleaseGeneration", "price", "combination"]);
  const pricingModel = body.pricingModel;
  if (pricingModel !== "FIXED_FEE" && pricingModel !== "SPREAD") throw invalid("计价模式无效");
  let effectiveAt: string | null;
  try { effectiveAt = typeof body.effectiveAt === "string" ? normalizeTime(body.effectiveAt) : null; }
  catch { throw invalid("规则变更生效时间无效"); }
  if (!effectiveAt) throw invalid("规则变更生效时间无效");
  const price = body.price === undefined ? null : fields(body.price, ["version", "expectedGeneration"]);
  const combination = body.combination === undefined ? null : fields(body.combination, ["funding", "term", "agreement", "earlySettlement"]);
  if (switching ? !price : !price && !combination) throw invalid("请选择要发布的规则变更");
  const early = combination ? fields(combination.earlySettlement, ["versionId", "digest"]) : null;
  return {
    gameId: required(body.gameId, ID, "gameId"),
    pricingModel: pricingModel as PricingModel,
    expectedModeGeneration: required(body.expectedModeGeneration, VERSION, "expectedModeGeneration"),
    expectedReleaseGeneration: required(body.expectedReleaseGeneration, VERSION, "expectedReleaseGeneration"),
    effectiveAt,
    announcementVersionId: required(body.announcementVersionId, ID, "announcementVersionId"),
    price: price && { version: reference(price.version), expectedGeneration: required(price.expectedGeneration, VERSION, "price.expectedGeneration") },
    combination: combination && early && {
      funding: reference(combination.funding), term: reference(combination.term), agreement: reference(combination.agreement),
      earlySettlement: { versionId: required(early.versionId, ID, "earlySettlement.versionId"), digest: required(early.digest, /^[a-f0-9]{64}$/, "earlySettlement.digest") },
    },
  };
}

type RuleChange = ReturnType<typeof parseRuleChange>;

async function requireRuleChangeSchema(client: PoolClient) {
  const row = (await client.query<{ ready: boolean }>("SELECT to_regclass('zzsh_supply.rule_change_batch') IS NOT NULL AS ready")).rows[0];
  if (row?.ready !== true) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "整批规则变更结构暂不可用");
}


async function checkReference(client: PoolClient, actor: Actor | null, gameId: string,
  table: "price_version" | "term_version" | "agreement_version", reference: Reference) {
  const found = (await client.query<{ status: string; revision: string; fixed: boolean; mode: string | null }>(
    `SELECT v.status, v.revision::text, (to_jsonb(v)->>'fixed_fee_rates') IS NOT NULL AS fixed, to_jsonb(v)->>'mode' AS mode
       FROM zzsh_supply.${table} v WHERE v.id=$1 AND v.game_id=$2`, [reference.id, gameId])).rows[0];
  if (!found || found.revision !== reference.revision) throw conflict("配置已变化，请刷新后重新核对");
  if (found.status === "DRAFT" && actor) {
    await sealVersion(client, actor.userId, actor.isBoss, table, reference.id, reference.revision);
  } else if (!["DRAFT", "SEALED"].includes(found.status)) throw conflict("配置不可发布");
  return found;
}

export async function validateRuleChange(client: PoolClient, change: RuleChange, switching: boolean, actor: Actor | null, demo?: DemoFinanceResource) {
  const { gameId, effectiveAt, announcementVersionId, pricingModel, price, combination } = change;
  await requireRuleChangeSchema(client);
  await assertRulesGameSupported(client, gameId);
  const base = (await client.query<{ priceVersionId: string; termVersionId: string; agreementVersionId: string; modeGeneration: string; releaseGeneration: string; pendingMode: boolean; priceGeneration: string; pendingRelease: boolean }>(
    `SELECT r.price_version_id AS "priceVersionId",r.term_version_id AS "termVersionId",r.agreement_version_id AS "agreementVersionId",
       (SELECT COALESCE(MAX(generation),0)::text FROM zzsh_supply.pricing_mode_schedule WHERE game_id=g.id) AS "modeGeneration",
       (SELECT COALESCE(MAX(generation),0)::text FROM zzsh_supply.rule_release WHERE game_id=g.id) AS "releaseGeneration",
       (SELECT COALESCE(MAX(generation),0)::text FROM zzsh_supply.pricing_policy_schedule WHERE game_id=g.id AND pricing_model=$2) AS "priceGeneration",
       EXISTS(SELECT 1 FROM zzsh_supply.pricing_mode_schedule m WHERE m.game_id=g.id AND m.effective_at>clock_timestamp()
         AND m.voided_at IS NULL) AS "pendingMode",
       EXISTS(SELECT 1 FROM zzsh_supply.rule_release planned WHERE planned.game_id=g.id AND planned.effective_at>clock_timestamp()
         AND planned.voided_at IS NULL) AS "pendingRelease"
       FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=${effectiveRuleRelease("g")}
       WHERE g.id=$1 AND g.enabled`, [gameId, pricingModel])).rows[0];
  if (!base) throw conflict("当前规则组合无法核实");
  if (base.modeGeneration !== change.expectedModeGeneration || base.releaseGeneration !== change.expectedReleaseGeneration)
    throw conflict("当前计价模式或规则组合已变化，请重新核对");
  if (price && price.expectedGeneration !== base.priceGeneration) throw conflict("价目排期已变化，请重新核对");
  if (base.pendingMode) throw conflict("已有待生效的计价模式变更");
  if (base.pendingRelease && combination) throw conflict("规则组合已有待生效的改动");
  const at = (await client.query<{ at: string }>(`SELECT ${stamp("clock_timestamp()")} AS at`)).rows[0]?.at;
  if (!at || effectiveAt <= at) throw conflict("计划生效时间已过，请重新选择未来时间");
  const current = await readNewListingPrice(client, gameId, base.priceVersionId, at);
  const currentModel = current.pricingModel === "LEGACY_SPREAD" ? "SPREAD" : current.pricingModel;
  if (switching ? currentModel === pricingModel : currentModel !== pricingModel) throw conflict("当前计价模式与本次操作不符");
  if (price && !switching && !current.priceScheduleId)
    throw conflict("历史价差仍随规则组合生效，请从规则总览安排组合，或先切换计价模式");
  if (price && !switching && current.priceVersionId === price.version.id && !combination) throw conflict("所选价目已生效，无需再次排期");
  if (pricingModel === "SPREAD" && price && !await demoSpreadTradingReady(client, demo, actor ? "WRITE" : "READ"))
    throw conflict("价差订单结算暂未就绪");
  await assertPublishedPricingAnnouncement(client, gameId, announcementVersionId, effectiveAt);
  const fundingAt = combination?.funding.id ?? (base.pendingRelease ? (await client.query<{ id: string }>(`SELECT r.price_version_id AS id
    FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=${effectiveRuleRelease("g", "$2::timestamptz")}
    WHERE g.id=$1`, [gameId, effectiveAt])).rows[0]?.id : base.priceVersionId);
  if (!fundingAt) throw conflict("目标时点的资金政策无法核实");
  if (price) {
    const version = await checkReference(client, actor, gameId, "price_version", price.version);
    if (pricingModel === "FIXED_FEE" ? !version.fixed || version.mode !== "PERCENT" : version.fixed || version.mode !== "SPREAD")
      throw conflict("价目与目标计价模式不符");
    const funding = (await client.query<{ id: string; policy: unknown; terms: string | null }>(
      `SELECT id,funding_policy AS policy, full_payout_terms_version_id AS terms FROM zzsh_supply.price_version
      WHERE game_id=$1 AND id=ANY($2::text[])`,
      [gameId, [price.version.id, fundingAt]])).rows;
    const intended = funding.find(row => row.id === price.version.id);
    const effective = funding.find(row => row.id === fundingAt);
    if (intended?.policy != null && (canonicalize(intended.policy) !== canonicalize(effective?.policy ?? null)
      || (!combination && intended.terms !== null && intended.terms !== effective?.terms)))
      throw conflict("价目中的押金或包赔与本次规则组合不一致，请一并核对和发布");
  }
  if (combination) {
    if (combination.funding.id !== price?.version.id) await checkReference(client, actor, gameId, "price_version", combination.funding);
    else if (combination.funding.revision !== price.version.revision) throw conflict("同一价目的版本修订不一致");
    await checkReference(client, actor, gameId, "term_version", combination.term);
    await checkReference(client, actor, gameId, "agreement_version", combination.agreement);
  }
  return { previousPriceVersionId: current.priceVersionId, previousFundingVersionId: base.priceVersionId,
    previousTermVersionId: base.termVersionId, previousAgreementVersionId: base.agreementVersionId, fundingAt };
}

export async function scheduleRuleChange(client: PoolClient, actor: Actor, change: RuleChange, requestId: string,
  approvalRequestId: string | null, demo?: DemoFinanceResource) {
  if (!actor.isBoss) throw new SecurityApiError(403, "FORBIDDEN", "只有 Boss 可以安排规则生效");
  const { gameId, pricingModel, effectiveAt, announcementVersionId, price, combination } = change;
  await lockFixedFeePolicyChange(client);
  if (!(await client.query("SELECT id FROM zzsh_supply.game WHERE id=$1 FOR UPDATE", [gameId])).rows.length) throw notFound();
  const before = await validateRuleChange(client, change, approvalRequestId !== null, actor, demo);
  const id = newSupplyId("rule_change");
  await client.query(`INSERT INTO zzsh_supply.rule_change_batch
    (id,game_id,effective_at,announcement_version_id,created_by_admin_id,approval_request_id,change)
    VALUES($1,$2,$3,$4,$5,$6,$7)`, [id, gameId, effectiveAt, announcementVersionId, actor.userId, approvalRequestId, JSON.stringify({ ...change, ...before })]);
  const priceInput = price && { gameId, effectiveAt, batchId: id, priceVersionId: price.version.id, expectedGeneration: price.expectedGeneration };
  const pricePlan = priceInput && (pricingModel === "FIXED_FEE"
    ? await scheduleFixedFeePrice(client, actor, priceInput) : await scheduleSpreadPrice(client, actor, priceInput, demo));
  const modePlan = approvalRequestId && await schedulePricingMode(client, actor, {
    gameId, pricingModel, effectiveAt, batchId: id, expectedGeneration: change.expectedModeGeneration,
  }, demo);
  const release = combination && await activateRelease(client, actor.userId, true, gameId, combination.funding.id,
    combination.term.id, combination.agreement.id, change.expectedReleaseGeneration,
    { effectiveAt, announcementVersionId, batchId: id, earlySettlement: combination.earlySettlement });
  await assertRulePricingTimeline(client, gameId, effectiveAt);
  const timeline = await readFixedFeeTimeline(client, gameId, { from: effectiveAt });
  if (timeline && !validateFixedFeeTimeline(timeline).valid) throw conflict("生效后的固定手续费与会员或礼遇配置不兼容");
  const receipt = { id, gameId, pricingModel, effectiveAt, announcementVersionId, status: "SCHEDULED",
    priceScheduleId: pricePlan?.id ?? null, modeScheduleId: modePlan ? modePlan.id : null, releaseId: release?.releaseId ?? null };
  await recordAudit(client, { actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId, action: "supply.rules.batch_scheduled",
    objectType: "rule_change_batch", objectId: id, requestId, outcome: "SUCCESS", details: { ...receipt, approvalRequestId, change } });
  return receipt;
}

export async function executePricingModeSwitch(client: PoolClient, input: ApprovalOperationExecutorInput,
  actor: { userId: string; sessionId: string }, requestId: string, demo?: DemoFinanceResource) {
  const access = await loadEffectiveAdminAccess(client, actor.userId);
  if (input.operationCode !== PRICING_MODE_SWITCH_OPERATION || input.payloadVersion !== 1)
    throw invalid("模式变更审批版本无效");
  if (!access || !access.isBoss || input.decidedBy !== actor.userId) throw new SecurityApiError(403, "FORBIDDEN", "只有 Boss 可以批准模式变更");
  requirePermission(access, ADMIN_PERMISSION.supplyRulesActivate);
  const receipt = await scheduleRuleChange(client, { ...actor, isBoss: true }, parseRuleChange(input.operationPayload, true), requestId, input.requestId, demo);
  return { resultCode: RULE_CHANGE_SCHEDULED, resultDetail: receipt.id };
}

export async function readRuleChanges(client: PoolClient, gameId: string, id?: string) {
  await requireRuleChangeSchema(client);
  const result = await client.query(`SELECT id,game_id AS "gameId",${stamp("effective_at")} AS "effectiveAt",
    announcement_version_id AS "announcementVersionId",created_by_admin_id AS "createdByAdminId",approval_request_id AS "approvalRequestId",
    change,${stamp("created_at")} AS "createdAt",${stamp("voided_at")} AS "voidedAt",voided_by_admin_id AS "voidedByAdminId",void_reason AS "voidReason",
    CASE WHEN voided_at IS NOT NULL THEN 'VOIDED' WHEN effective_at<=transaction_timestamp() THEN 'EFFECTIVE' ELSE 'SCHEDULED' END AS status
    FROM zzsh_supply.rule_change_batch WHERE game_id=$1 AND ($2::text IS NULL OR id=$2)
    ORDER BY created_at DESC,id DESC LIMIT 101`, [gameId, id ?? null]);
  return { items: result.rows.slice(0, 100), truncated: result.rows.length > 100 };
}

export async function voidRuleChange(client: PoolClient, actor: Actor, gameId: string, id: string, reason: string, requestId: string) {
  if (!actor.isBoss) throw new SecurityApiError(403, "FORBIDDEN", "只有 Boss 可以作废规则变更");
  await requireRuleChangeSchema(client);
  await assertGameScope(client, actor.userId, true, gameId);
  await lockFixedFeePolicyChange(client);
  if (!(await client.query("SELECT id FROM zzsh_supply.game WHERE id=$1 FOR UPDATE", [gameId])).rows.length) throw notFound();
  const plan = (await client.query<{ effectiveAt: string; voidedAt: string }>(`UPDATE zzsh_supply.rule_change_batch SET
    voided_at=clock_timestamp(),voided_by_admin_id=$3,void_reason=$4
    WHERE id=$1 AND game_id=$2 AND voided_at IS NULL AND effective_at>clock_timestamp()
    RETURNING ${stamp("effective_at")} AS "effectiveAt",${stamp("voided_at")} AS "voidedAt"`,
    [id, gameId, actor.userId, reason])).rows[0];
  if (!plan) throw conflict("规则变更已生效、已作废或不存在");
  const dependency = (await client.query(`SELECT 1 FROM zzsh_supply.rule_change_batch b
    JOIN zzsh_supply.game g ON g.id=b.game_id
    LEFT JOIN zzsh_supply.rule_release r ON r.id=${effectiveRuleRelease("g", "b.effective_at")}
    WHERE b.game_id=$1 AND b.voided_at IS NULL AND b.effective_at>$2::timestamptz
      AND b.change->>'fundingAt' IS NOT NULL AND b.change->>'fundingAt' IS DISTINCT FROM r.price_version_id LIMIT 1`,
    [gameId, plan.voidedAt])).rows[0];
  if (dependency) throw conflict("另有待生效批次依赖这份资金规则，请先作废依赖批次");
  await assertRulePricingTimeline(client, gameId, plan.voidedAt);
  const timeline = await readFixedFeeTimeline(client, gameId, { from: plan.voidedAt });
  if (timeline && !validateFixedFeeTimeline(timeline).valid) throw conflict("作废后剩余的模式、价目或会员政策不兼容");
  const receipt = { id, gameId, effectiveAt: plan.effectiveAt, status: "VOIDED" };
  await recordAudit(client, { actorType: "admin", actorId: actor.userId, sessionId: actor.sessionId, action: "supply.rules.batch_voided",
    objectType: "rule_change_batch", objectId: id, requestId, outcome: "SUCCESS", reason, details: receipt });
  return receipt;
}
