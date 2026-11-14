import { readNewListingPrice } from "./pricing-policy-schedule";
import { assertPublishedPricingAnnouncement } from "./pricing-announcement";
import { effectiveRuleRelease } from "./effective-rule-release";
import { lockFixedFeePolicyChange } from "../auth/fixed-fee-policy-timeline";
import { plateDigest } from "@zzsh/content/plate";
import type { PoolClient } from "pg";

import { legalDigest, parseLegalPlateDocument, plateProjection, readCurrentEarlySettlementDisclosure } from "../legal/legal-documents";
import { SecurityApiError } from "../auth/security-core";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { assertGameScope, conflict, ensureOnlyFields, invalid, newSupplyId, notFound } from "./supply-util";
import { computeDeltaQuote, projectDeltaQuote, type HaffRatioRule, type PricingLineInput, type QuoteResult } from "./pricing";
import { assertDeltaResourceUnit, DELTA_CUSTOM_DAILY_CONSUMPTION, DELTA_RESOURCE_UNITS, DELTA_ROUNDING_POLICY, normalizeRentalPricing, parseDeltaPriceLines, validateDeltaHaffRule, validateDeltaRentalTerm, type DeltaHaffRule, type DeltaPriceLineInputBody } from "./delta-rental";
import { computeContentHash, humanText, normalizeContentPayload, normalizeTime, withoutContentHash, type ContentDeclaration, type ContentPayloadInput } from "./content-hash";
import { validateFundingPolicy, validateFundingPolicyDraft } from "./funding-policy";
import { fullPayoutDraftFields, readFullPayoutTerms, verifyFullPayoutTermsRow, verifyTradeTermsBody } from "./full-payout-terms";
import { decimalToBigInt, parseNonNegativeDecimal } from "./decimal";
import { FIXED_FEE_ALGORITHM, fixedFeeRateForMode, parseFixedFeeRates, type FixedFeeRates } from "./fixed-fee";

const DECIMAL_PATTERN = /^(0|[1-9]\d*)(?:\.\d{1,8})?$/;
const CODE_PATTERN = /^[a-z][a-z0-9_:-]{1,63}$/;

export type HaffRuleInput = DeltaHaffRule;
export type PriceLineInputBody = DeltaPriceLineInputBody;
export const validateHaffRule = validateDeltaHaffRule;
export const parsePriceLines = parseDeltaPriceLines;

type VersionRow = Record<string, unknown>;
type ExistingPriceLine = { itemId: string; customerTier: string; pricingKind: string; unitQuantity: string | null; buyerUnitAmount: string | null; ownerUnitAmount: string | null; mode: string };

async function assertChangedUnitPricesAtCentPrecision(client: PoolClient, versionId: string, gameId: string, mode: string, lines: readonly DeltaPriceLineInputBody[]) {
  const scaled = (value: string) => decimalToBigInt(parseNonNegativeDecimal(value, 8, "unit amount"), 8);
  const extraDigits = (value: string | undefined) => value !== undefined && (value.split(".")[1]?.length ?? 0)>2;
  if (!lines.some(line => extraDigits(line.buyerUnitAmount) || extraDigits(line.ownerUnitAmount))) return;
  const columns = `l.item_id AS "itemId",l.customer_tier AS "customerTier",l.pricing_kind AS "pricingKind",l.unit_quantity::text AS "unitQuantity",l.buyer_unit_amount::text AS "buyerUnitAmount",l.owner_unit_amount::text AS "ownerUnitAmount",v.mode`;
  let prior = (await client.query<ExistingPriceLine>(`/* existing precision in draft */ SELECT ${columns} FROM zzsh_supply.price_line l JOIN zzsh_supply.price_version v ON v.id=l.price_version_id WHERE v.id=$1`, [versionId])).rows;
  if (!prior.length) prior = (await client.query<ExistingPriceLine>(`/* current precision source for empty draft */ SELECT ${columns} FROM zzsh_supply.price_line l JOIN zzsh_supply.price_version v ON v.id=l.price_version_id WHERE v.id=COALESCE(
    (SELECT price_version_id FROM zzsh_supply.rule_release WHERE game_id=$1 ORDER BY generation DESC LIMIT 1),
    (SELECT id FROM zzsh_supply.price_version WHERE game_id=$1 AND status='SEALED' ORDER BY created_at DESC,id DESC LIMIT 1))`, [gameId])).rows;
  for (const line of lines) {
    const old = prior.find(row => row.itemId===line.itemId && row.customerTier===(line.customerTier??"STANDARD"));
    for (const field of ["buyerUnitAmount", "ownerUnitAmount"] as const) {
      const amount=line[field];
      if (!extraDigits(amount)) continue;
      const previous=old?.[field];
      if (!old || old.mode!==mode || old.pricingKind!==line.pricingKind || old.unitQuantity!==line.unitQuantity
        || typeof previous!=="string" || scaled(previous)!==scaled(amount!)) throw invalid("新建或修改的物资单价最多两位小数", "lines");
    }
  }
}

export async function listRules(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  gameId: string,
): Promise<Record<string, unknown>> {
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const game = await client.query(
    `SELECT "id", "code", "name", "catalog_revision"::text AS "catalogRevision", ${effectiveRuleRelease("g")} AS "currentReleaseId"
       FROM "zzsh_supply"."game" g WHERE "id" = $1`,
    [gameId],
  );
  if (game.rows.length === 0) throw notFound();
  const release = await client.query(
    `SELECT r."id", r."game_id" AS "gameId", r."price_version_id" AS "priceVersionId", r."term_version_id" AS "termVersionId",
            r."agreement_version_id" AS "agreementVersionId", to_jsonb(r)->>'early_settlement_version_id' AS "earlySettlementVersionId", r."generation"::text AS "generation",
            CASE WHEN to_jsonb(r)->>'system_initial_sha256' IS NULL THEN r."activated_by_admin_id" END AS "activatedByAdminId",
            CASE WHEN to_jsonb(r)->>'system_initial_sha256' IS NOT NULL THEN 'SYSTEM_INITIAL' END AS "activationSource", r."activated_at" AS "activatedAt",
            to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "evaluatedAt"
       FROM "zzsh_supply"."rule_release" r
      WHERE r."game_id" = $1 AND r."id" = $2`,
    [gameId, game.rows[0].currentReleaseId],
  );
  const current = release.rows[0];
  const newListingPrice = current ? await readNewListingPrice(client, gameId, current.priceVersionId, current.evaluatedAt)
    .then(({ priceVersionId, pricingModel, priceEffectiveAt, effectiveAt }) => ({ priceVersionId, pricingModel, priceEffectiveAt, modeEffectiveAt: effectiveAt }))
    .catch(error => {
      if (!(error instanceof SecurityApiError)) throw error;
      return null;
    }) : null;
  const ruleScheduling = (await client.query(`SELECT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid='zzsh_supply.rule_release'::regclass AND attname='effective_at' AND NOT attisdropped) AS available,
    to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "asOf"`)).rows[0];
  const plans = ruleScheduling?.available ? (await client.query(`SELECT id, generation::text,
    price_version_id AS "priceVersionId", term_version_id AS "termVersionId", agreement_version_id AS "agreementVersionId",
    to_jsonb(rule_release)->>'early_settlement_version_id' AS "earlySettlementVersionId",
    to_char(effective_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "effectiveAt",
    announcement_version_id AS "announcementVersionId"
    FROM zzsh_supply.rule_release r WHERE game_id=$1 AND effective_at>transaction_timestamp() AND to_jsonb(r)->>'voided_at' IS NULL
    ORDER BY effective_at LIMIT 101`, [gameId])).rows : [];
  const generation = (await client.query(`SELECT COALESCE(MAX(generation),0)::text AS generation
    FROM zzsh_supply.rule_release WHERE game_id=$1`, [gameId])).rows[0]?.generation ?? "0";
  const priceVersions = await client.query(
    `SELECT v."id", v."game_id" AS "gameId", v."mode", v."status", v."commission_rate"::text AS "commissionRate",
            v."haff_rule" AS "haffRule", to_jsonb(v)->'fixed_fee_rates' AS "fixedFeeRates", v."rounding_policy" AS "roundingPolicy", v."compensation_policy_ref" AS "compensationPolicyRef",
            v."funding_policy" AS "fundingPolicy", v."full_payout_terms_version_id" AS "fullPayoutTermsVersionId", v."revision"::text AS "revision", v."created_at" AS "createdAt", v."sealed_at" AS "sealedAt",
            CASE WHEN to_jsonb(v)->>'system_initial_sha256' IS NOT NULL THEN 'SYSTEM_INITIAL' END AS "source"
       FROM "zzsh_supply"."price_version" v
      WHERE v."game_id" = $1 ORDER BY (v."id"=ANY($2::text[])) DESC NULLS LAST, v."created_at" DESC, v."id" DESC LIMIT 20`,
    [gameId, [current?.priceVersionId, newListingPrice?.priceVersionId].filter(Boolean)],
  );
  const priceLines = await client.query(
    `SELECT l."price_version_id" AS "priceVersionId", l.customer_tier AS "customerTier", l."item_id" AS "itemId", l."pricing_kind" AS "pricingKind",
            l."unit_quantity"::text AS "unitQuantity", l."buyer_unit_amount"::text AS "buyerUnitAmount", l."owner_unit_amount"::text AS "ownerUnitAmount"
       FROM "zzsh_supply"."price_line" l
       JOIN "zzsh_supply"."price_version" v ON v."id" = l."price_version_id"
      WHERE v."game_id" = $1 ORDER BY l."item_id"`,
    [gameId],
  );
  const termVersions = await client.query(
    `SELECT v."id", v."game_id" AS "gameId", v."status", v."revision"::text AS "revision", v."created_at" AS "createdAt", v."sealed_at" AS "sealedAt",
            CASE WHEN to_jsonb(v)->>'system_initial_sha256' IS NOT NULL THEN 'SYSTEM_INITIAL' END AS "source"
       FROM "zzsh_supply"."term_version" v WHERE v."game_id" = $1
      ORDER BY (v."id" IS NOT DISTINCT FROM $2) DESC, v."created_at" DESC, v."id" DESC LIMIT 20`,
    [gameId, current?.termVersionId ?? null],
  );
  const termOptions = await client.query(
    `SELECT o."version_id" AS "versionId", o."code", o."name", o."daily_consumption"::text AS "dailyConsumption", o."duration_rounding" AS "durationRounding"
       FROM "zzsh_supply"."term_option" o
       JOIN "zzsh_supply"."term_version" v ON v."id" = o."version_id"
      WHERE v."game_id" = $1 ORDER BY o."code"`,
    [gameId],
  );
  const agreementVersions = await client.query(
    `SELECT v."id", v."game_id" AS "gameId", v."title", v."body", to_jsonb(v)->'body_document' AS "bodyDocument", v."digest", v."status", v."revision"::text AS "revision",
            v."created_at" AS "createdAt", v."sealed_at" AS "sealedAt",
            CASE WHEN to_jsonb(v)->>'system_initial_sha256' IS NOT NULL THEN 'SYSTEM_INITIAL' END AS "source"
       FROM "zzsh_supply"."agreement_version" v WHERE v."game_id" = $1
      ORDER BY (v."id" IS NOT DISTINCT FROM $2) DESC, v."created_at" DESC, v."id" DESC LIMIT 20`,
    [gameId, current?.agreementVersionId ?? null],
  );
  const earlySettlement = await readCurrentEarlySettlementDisclosure(client).catch(error => {
    if (error instanceof SecurityApiError) return null;
    throw error;
  });
  const items = await client.query(
    `SELECT "id", "code", "name", "unit", "quantity_scale" AS "quantityScale", "required", "enabled", "sort_order" AS "sortOrder"
       FROM "zzsh_supply"."billable_item" WHERE "game_id" = $1 AND "enabled" = true ORDER BY "sort_order", "code"`,
    [gameId],
  );
  return {
    game: game.rows[0],
    release: current ?? null,
    currentFullPayoutTermsVersionId: priceVersions.rows.find(v => v.id === current?.priceVersionId)?.fullPayoutTermsVersionId ?? null,
    newListingPrice,
    ruleScheduling: { ...ruleScheduling, generation, plans: plans.slice(0,100), truncated: plans.length>100,
      earlySettlement: earlySettlement ? { versionId: earlySettlement.versionId, digest: earlySettlement.digest } : null },
    priceVersions: priceVersions.rows,
    priceLines: priceLines.rows,
    termVersions: termVersions.rows,
    termOptions: termOptions.rows,
    agreementVersions: agreementVersions.rows,
    fullPayoutTermsVersions: (await client.query(`SELECT id,policy_ref AS "policyRef",policy_version AS "policyVersion",disclosure_version AS "disclosureVersion",title,digest,status,revision::text,created_at AS "createdAt",sealed_at AS "sealedAt",
      CASE WHEN to_jsonb(v)->>'system_initial_sha256' IS NOT NULL THEN 'SYSTEM_INITIAL' END AS source
      FROM zzsh_supply.full_payout_terms_version v WHERE game_id=$1 ORDER BY (id IS NOT DISTINCT FROM $2) DESC, created_at DESC,id DESC LIMIT 20`,[gameId, priceVersions.rows.find(v => v.id === current?.priceVersionId)?.fullPayoutTermsVersionId ?? null])).rows,
    depositCatalog: (await client.query<{ catalog: unknown }>(`
      SELECT jsonb_build_object(
        'catalogRevision', g.catalog_revision::text,
        'rarities', (SELECT COALESCE(jsonb_agg(jsonb_build_object('code',r.code,'name',r.name,'enabled',r.enabled) ORDER BY r.sort_order,r.code),'[]'::jsonb) FROM zzsh_supply.skin_rarity r WHERE r.game_id=g.id),
        'skins', (SELECT COALESCE(jsonb_agg(jsonb_build_object('id',s.id,'name',s.name,'ownerKind',s.owner_kind,'rarityCode',s.rarity_code) ORDER BY s.name,s.id),'[]'::jsonb) FROM zzsh_supply.skin s WHERE s.game_id=g.id)
      ) AS catalog FROM zzsh_supply.game g WHERE g.id=$1`, [gameId])).rows[0]?.catalog,
    items: items.rows,
  };
}

async function lockDraftishVersion(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  table: "price_version" | "term_version" | "agreement_version" | "full_payout_terms_version",
  versionId: string,
): Promise<VersionRow> {
  const result = await client.query<VersionRow>(`SELECT * FROM "zzsh_supply"."${table}" WHERE "id" = $1 FOR UPDATE`, [versionId]);
  const row = result.rows[0];
  if (!row) throw notFound();
  await assertGameScope(client, adminUserId, isBoss, String(row.game_id));
  return row;
}

function checkRevision(row: VersionRow, expectedRevision: unknown): void {
  if (typeof expectedRevision !== "string" || row.revision !== expectedRevision) throw conflict("Version changed; refresh and retry");
}

export async function createPriceDraft(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  gameId: string,
  mode: unknown,
  fixedFeeRates?: unknown,
  sourcePriceVersionId?: string,
): Promise<{ id: string }> {
  await assertGameScope(client, adminUserId, isBoss, gameId);
  if (mode !== "SPREAD" && mode !== "PERCENT") throw invalid("Mode is invalid");
  const id = newSupplyId("price");
  if (sourcePriceVersionId) {
    if (mode !== "PERCENT" || fixedFeeRates !== undefined) throw invalid("只能复制已封存的固定手续费价目");
    const source = await client.query(`INSERT INTO zzsh_supply.price_version
      (id,game_id,mode,haff_rule,rounding_policy,funding_policy,fixed_fee_rates,created_by_admin_id)
      SELECT $1,p.game_id,p.mode,p.haff_rule,p.rounding_policy,
        CASE WHEN r.id IS NULL THEN p.funding_policy ELSE funding.funding_policy END,p.fixed_fee_rates,$4
      FROM zzsh_supply.price_version p JOIN zzsh_supply.game g ON g.id=p.game_id
      LEFT JOIN zzsh_supply.rule_release r ON r.id=${effectiveRuleRelease("g")} AND r.game_id=g.id
      LEFT JOIN zzsh_supply.price_version funding ON funding.id=r.price_version_id AND funding.game_id=g.id
      WHERE p.id=$2 AND p.game_id=$3 AND p.status='SEALED'
      AND p.mode='PERCENT' AND p.fixed_fee_rates IS NOT NULL AND p.haff_rule->>'schema'='haff-ratio-v3'`,
      [id, sourcePriceVersionId, gameId, adminUserId]);
    if (!source.rowCount) throw notFound();
    await client.query(`INSERT INTO zzsh_supply.price_line(id,price_version_id,item_id,pricing_kind,unit_quantity,buyer_unit_amount,owner_unit_amount,customer_tier)
      SELECT $1||'_'||row_number() OVER (ORDER BY item_id),$1,item_id,pricing_kind,unit_quantity,buyer_unit_amount,owner_unit_amount,customer_tier
      FROM zzsh_supply.price_line WHERE price_version_id=$2 AND customer_tier='STANDARD'`,[id,sourcePriceVersionId]);
    return { id };
  }
  if (fixedFeeRates !== undefined) {
    if (mode !== "PERCENT") throw invalid("Fixed fee rates require PERCENT mode");
    let rates: FixedFeeRates;
    try { rates = parseFixedFeeRates(fixedFeeRates); } catch { throw invalid("Fixed fee rates are invalid", "fixedFeeRates"); }
    await client.query(
      `INSERT INTO "zzsh_supply"."price_version" ("id", "game_id", "mode", "fixed_fee_rates", "created_by_admin_id") VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [id, gameId, mode, JSON.stringify(rates), adminUserId],
    );
    return { id };
  }
  await client.query(
    `INSERT INTO "zzsh_supply"."price_version" ("id", "game_id", "mode", "created_by_admin_id")
     VALUES ($1, $2, $3, $4)`,
    [id, gameId, mode, adminUserId],
  );
  return { id };
}

export async function updatePriceDraft(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  versionId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const current = await lockDraftishVersion(client, adminUserId, isBoss, "price_version", versionId);
  if (current.status !== "DRAFT") throw conflict("Sealed price versions cannot be edited");
  checkRevision(current, body.expectedRevision);
  const mode = body.mode === undefined ? (current.mode as "SPREAD" | "PERCENT") : body.mode;
  if (mode !== "SPREAD" && mode !== "PERCENT") throw invalid("Mode is invalid");
  const isFixedFee = current.fixed_fee_rates !== null && current.fixed_fee_rates !== undefined;
  if (isFixedFee && (mode !== "PERCENT" || body.commissionRate !== undefined)) throw invalid("Fixed fee drafts use per-mode rates");
  if (!isFixedFee && body.fixedFeeRates !== undefined) throw invalid("Create a fixed fee draft to set per-mode rates");
  let fixedFeeRates: FixedFeeRates | undefined;
  if (body.fixedFeeRates !== undefined) {
    try { fixedFeeRates = parseFixedFeeRates(body.fixedFeeRates); } catch { throw invalid("Fixed fee rates are invalid", "fixedFeeRates"); }
  }
  let commissionRate: string | null | undefined;
  if (body.commissionRate !== undefined) {
    if (mode !== "PERCENT") throw invalid("Commission rate is only valid for PERCENT mode");
    if (typeof body.commissionRate !== "string" || !DECIMAL_PATTERN.test(body.commissionRate)) throw invalid("Commission rate is invalid");
    const numeric = Number(body.commissionRate);
    if (!(numeric >= 0 && numeric < 1)) throw invalid("Commission rate is invalid");
    commissionRate = body.commissionRate;
  } else if (mode === "SPREAD") {
    commissionRate = null;
  }
  let haffRule: HaffRuleInput | null | undefined;
  if (body.haffRule !== undefined) {
    haffRule = body.haffRule === null ? null : validateDeltaHaffRule(body.haffRule, mode);
    if (isFixedFee && haffRule !== null && haffRule.schema !== "haff-ratio-v3") throw invalid("Fixed fee drafts require a fixed fee haff rule");
  }
  const lines = body.lines === undefined ? undefined : parseDeltaPriceLines(body.lines, mode);
  if (lines) await assertChangedUnitPricesAtCentPrecision(client,versionId,String(current.game_id),mode,lines);
  // Check both stored and requested schemas: an old editor must not erase tiers,
  // including when it also attempts to replace or clear the compatibility rule.
  if (lines && ((current.haff_rule as HaffRuleInput | null)?.schema === "haff-ratio-v2" || haffRule?.schema === "haff-ratio-v2")
    && lines.some((line) => line.customerTier === undefined)) {
    throw invalid("Compatibility price lines require an explicit customerTier", "lines");
  }
  const roundingPolicy = body.roundingPolicy === undefined ? undefined : body.roundingPolicy;
  if (roundingPolicy !== undefined && roundingPolicy !== DELTA_ROUNDING_POLICY) throw invalid("Rounding policy is unsupported");
  const fundingPolicy = Object.hasOwn(body, "fundingPolicy")
    ? body.fundingPolicy === null ? null : validateFundingPolicyDraft(body.fundingPolicy)
    : undefined;
  if (fundingPolicy?.recommendation.schema === "deposit-recommendation-v2") {
    const codes = [...new Set(fundingPolicy.recommendation.parameters.skinRules.flatMap(row => row.rarityCode === null ? [] : [row.rarityCode]))];
    const ids = fundingPolicy.recommendation.parameters.skinOverrides.map(row => row.skinId);
    const rarities = (await client.query<{ code: string }>(`SELECT code FROM zzsh_supply.skin_rarity WHERE game_id=$1 AND code=ANY($2::text[])`, [current.game_id, codes])).rows;
    const skins = (await client.query<{ id: string }>(`SELECT id FROM zzsh_supply.skin WHERE game_id=$1 AND id=ANY($2::text[])`, [current.game_id, ids])).rows;
    if (codes.some(code => !rarities.some(row => row.code === code)) || ids.some(id => !skins.some(row => row.id === id))) throw invalid("Skin deposit policy references an unknown quality or skin for this game");
  }
  await client.query(
    `UPDATE "zzsh_supply"."price_version"
        SET "mode" = $1,
            "commission_rate" = CASE WHEN $2::boolean THEN $3::numeric ELSE "commission_rate" END,
            "haff_rule" = CASE WHEN $4::boolean THEN $5::jsonb ELSE "haff_rule" END,
            "rounding_policy" = COALESCE($6, "rounding_policy"),
            "funding_policy" = CASE WHEN $7::boolean THEN $8::jsonb ELSE "funding_policy" END,
            "fixed_fee_rates" = CASE WHEN $10::boolean THEN $11::jsonb ELSE "fixed_fee_rates" END,
            "revision" = "revision" + 1,
            "updated_at" = clock_timestamp()
      WHERE "id" = $9`,
    [
      mode,
      commissionRate !== undefined,
      commissionRate ?? null,
      haffRule !== undefined,
      haffRule === null || haffRule === undefined ? null : JSON.stringify(haffRule),
      roundingPolicy ?? null,
      fundingPolicy !== undefined,
      fundingPolicy === null || fundingPolicy === undefined ? null : JSON.stringify(fundingPolicy),
      versionId,
      fixedFeeRates !== undefined,
      fixedFeeRates === undefined ? null : JSON.stringify(fixedFeeRates),
    ],
  );
  if (lines !== undefined) {
    const items = await client.query<{ id: string; code: string; unit: string; quantityScale: number; gameId: string }>(
      `SELECT "id", "code", "unit", "quantity_scale" AS "quantityScale", "game_id" AS "gameId" FROM "zzsh_supply"."billable_item" WHERE "id" = ANY($1::text[])`,
      [lines.map((line) => line.itemId)],
    );
    const itemById = new Map(items.rows.map((item) => [item.id, item]));
    if (itemById.size !== new Set(lines.map((line) => line.itemId)).size) throw invalid("Price line item does not exist");
    for (const line of lines) {
      const item = itemById.get(line.itemId)!;
      if (item.gameId !== String(current.game_id)) throw invalid("Price line item belongs to another game");
      assertDeltaResourceUnit(item.code, item.unit, item.quantityScale ?? null);
      if ((item.unit === "HAFF_BASE") !== (line.pricingKind === "HAFF_RATIO")) throw invalid("Haff items must use the haff ratio pricing kind");
      if (DELTA_RESOURCE_UNITS[item.code] && (line.pricingKind !== "FIXED_UNIT" || line.unitQuantity !== "1")) throw invalid("该固定资源按基础单位计价，份量必须为1", "lines");
    }
    await client.query(`DELETE FROM "zzsh_supply"."price_line" WHERE "price_version_id" = $1`, [versionId]);
    for (const line of lines) {
      await client.query(
        `INSERT INTO "zzsh_supply"."price_line" ("id", "price_version_id", "item_id", "pricing_kind", "unit_quantity", "buyer_unit_amount", "owner_unit_amount", customer_tier)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [newSupplyId("pline"), versionId, line.itemId, line.pricingKind, line.unitQuantity ?? null, line.buyerUnitAmount ?? null, line.ownerUnitAmount ?? null, line.customerTier ?? "STANDARD"],
      );
    }
  }
}

export async function sealVersion(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  table: "price_version" | "term_version" | "agreement_version" | "full_payout_terms_version",
  versionId: string,
  expectedRevision: unknown,
): Promise<void> {
  const current = await lockDraftishVersion(client, adminUserId, isBoss, table, versionId);
  if (current.status !== "DRAFT") throw conflict("Version is already sealed");
  if (typeof expectedRevision !== "string" || current.revision !== expectedRevision) throw conflict("Version changed; refresh and retry");
  if (table === "price_version" && current.fixed_fee_rates != null) {
    try { parseFixedFeeRates(current.fixed_fee_rates); }
    catch { throw invalid("三种手续费率必须完整，且不能超过 92%", "fixedFeeRates"); }
    if (validateDeltaHaffRule(current.haff_rule, "PERCENT").schema !== "haff-ratio-v3")
      throw invalid("固定手续费价目缺少哈夫币规则");
    await assertPriceVersionResources(client, String(current.game_id), versionId, "PERCENT");
  }
  const terms=table === "price_version" && current.funding_policy !== null && current.funding_policy !== undefined
    ? await readFullPayoutTerms(client,String(current.game_id),validateFundingPolicy(current.funding_policy)) : undefined;
  if (table === "full_payout_terms_version") await verifyFullPayoutTermsRow(current);
  if (table === "agreement_version") await verifyTradeTermsBody(String(current.body), current.digest, current.body_document);
  await client.query(
    `UPDATE "zzsh_supply"."${table}"
        SET "status" = 'SEALED', "sealed_at" = clock_timestamp(), "sealed_by_admin_id" = $1,
            "revision" = "revision" + 1, "updated_at" = clock_timestamp()${terms?", full_payout_terms_version_id=$3, full_payout_terms_digest=$4, full_payout_disclosure_version=$5":""}
      WHERE "id" = $2`,
    [adminUserId, versionId,...(terms?[terms.termsVersionId,terms.termsDigest,terms.disclosureVersion]:[])],
  );
}

export async function createTermDraft(client: PoolClient, adminUserId: string, isBoss: boolean, gameId: string): Promise<{ id: string }> {
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const id = newSupplyId("term");
  await client.query(`INSERT INTO "zzsh_supply"."term_version" ("id", "game_id", "created_by_admin_id") VALUES ($1, $2, $3)`, [id, gameId, adminUserId]);
  return { id };
}

export function parseTermOptions(value: unknown): Array<{ code: string; name: string; dailyConsumption: string; durationRounding: "CEIL_DAY" }> {
  if (!Array.isArray(value) || value.length === 0) throw invalid("Term options are required");
  const seen = new Set<string>();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid("Term option is invalid");
    const option = entry as Record<string, unknown>;
    const code = option.code;
    if (typeof code !== "string" || !CODE_PATTERN.test(code)) throw invalid("Term option code is invalid");
    if (seen.has(code)) throw invalid("Term option codes must be unique");
    seen.add(code);
    if (typeof option.name !== "string" || option.name.length === 0 || option.name.length > 120) throw invalid("Term option name is invalid");
    if (typeof option.dailyConsumption !== "string" || !/^[1-9]\d{0,23}$/.test(option.dailyConsumption)) throw invalid("Daily consumption is invalid");
    if (option.durationRounding !== undefined && option.durationRounding !== "CEIL_DAY") throw invalid("Duration rounding is unsupported");
    return { code, name: option.name, dailyConsumption: option.dailyConsumption, durationRounding: "CEIL_DAY" as const };
  });
}

export async function updateTermDraft(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  versionId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const current = await lockDraftishVersion(client, adminUserId, isBoss, "term_version", versionId);
  if (current.status !== "DRAFT") throw conflict("Sealed term versions cannot be edited");
  checkRevision(current, body.expectedRevision);
  const options = parseTermOptions(body.options);
  await client.query(`DELETE FROM "zzsh_supply"."term_option" WHERE "version_id" = $1`, [versionId]);
  for (const option of options) {
    await client.query(
      `INSERT INTO "zzsh_supply"."term_option" ("id", "version_id", "code", "name", "daily_consumption", "duration_rounding")
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [newSupplyId("termopt"), versionId, option.code, option.name, option.dailyConsumption, option.durationRounding],
    );
  }
  await client.query(`UPDATE "zzsh_supply"."term_version" SET "revision" = "revision" + 1, "updated_at" = clock_timestamp() WHERE "id" = $1`, [versionId]);
}

function tradeTermsDocument(input: Record<string, unknown>, current?: Record<string, unknown>) {
  if (input.bodyDocument !== undefined) {
    if (input.body !== undefined) throw invalid("正文由 Plate 文档生成", "body");
    const document = parseLegalPlateDocument(input.bodyDocument, "draft");
    return { document, body: humanText(plateProjection(document)) };
  }
  if (input.body === undefined) return { document: undefined, body: undefined };
  if (typeof input.body !== "string") throw invalid("正文格式无效", "body");
  const body = humanText(input.body);
  if (current?.body_document != null && body !== current.body) {
    throw invalid("请用 Plate 编辑器更新此版本的正文", "bodyDocument");
  }
  return { document: undefined, body };
}

export async function createAgreementDraft(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  gameId: string,
  title: string,
  body: string | undefined,
  bodyDocument?: unknown,
): Promise<{ id: string }> {
  title = humanText(title);
  const text = tradeTermsDocument({ body, bodyDocument });
  body = text.body;
  await assertGameScope(client, adminUserId, isBoss, gameId);
  if (title.length === 0 || title.length > 120) throw invalid("Title is invalid");
  if (!body?.trim() || Buffer.byteLength(body, "utf8") > 20_000) throw invalid("Agreement body is invalid");
  const id = newSupplyId("agreement");
  await client.query(
    `INSERT INTO "zzsh_supply"."agreement_version" ("id", "game_id", "title", "body", "digest", "created_by_admin_id"${text.document ? ', "body_document"' : ""})
     VALUES ($1, $2, $3, $4, $5, $6${text.document ? ", $7::jsonb" : ""})`,
    [id, gameId, title, body, text.document ? await plateDigest(text.document) : legalDigest(body), adminUserId, ...(text.document ? [JSON.stringify(text.document)] : [])],
  );
  return { id };
}

export async function updateAgreementDraft(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  versionId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const current = await lockDraftishVersion(client, adminUserId, isBoss, "agreement_version", versionId);
  if (current.status !== "DRAFT") throw conflict("Sealed agreement versions cannot be edited");
  checkRevision(current, body.expectedRevision);
  if (body.title !== undefined && typeof body.title !== "string") throw invalid("Title is invalid", "title");
  const title = body.title === undefined ? undefined : humanText(body.title);
  const { body: agreementBody, document } = tradeTermsDocument(body, current);
  if (title === undefined && agreementBody === undefined) throw invalid();
  if (title !== undefined && (typeof title !== "string" || title.length === 0 || title.length > 120)) throw invalid("Title is invalid");
  if (agreementBody !== undefined && (typeof agreementBody !== "string" || agreementBody.trim().length === 0 || Buffer.byteLength(agreementBody, "utf8") > 20_000)) {
    throw invalid("Agreement body is invalid");
  }
  const digest = document ? await plateDigest(document)
    : agreementBody === undefined || current.body_document != null ? undefined : legalDigest(agreementBody);
  await client.query(
    `UPDATE "zzsh_supply"."agreement_version"
        SET "title" = COALESCE($1, "title"),
            "body" = COALESCE($2, "body"),
            "digest" = COALESCE($3, "digest"),
            ${document ? '"body_document" = $5::jsonb,' : ""}
            "revision" = "revision" + 1,
            "updated_at" = clock_timestamp()
      WHERE "id" = $4`,
    [title ?? null, agreementBody ?? null, digest ?? null, versionId, ...(document ? [JSON.stringify(document)] : [])],
  );
}

export async function createFullPayoutTermsDraft(client: PoolClient, adminUserId: string, isBoss: boolean, gameId: string, body: Record<string, unknown>): Promise<{id: string}> {
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const text = tradeTermsDocument(body);
  const v = fullPayoutDraftFields({ ...body, body: text.body }), id = newSupplyId("payout");
  await client.query(
    `INSERT INTO zzsh_supply.full_payout_terms_version(id,game_id,policy_ref,policy_version,disclosure_version,title,body,digest,created_by_admin_id${text.document ? ",body_document" : ""}) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9${text.document ? ",$10::jsonb" : ""})`,
    [id,gameId,v.policyRef,v.policyVersion,v.disclosureVersion,v.title,v.body,text.document ? await plateDigest(text.document) : v.digest,adminUserId,...(text.document ? [JSON.stringify(text.document)] : [])]);
  return {id};
}

export async function updateFullPayoutTermsDraft(client: PoolClient, adminUserId: string, isBoss: boolean, id: string, body: Record<string, unknown>): Promise<void> {
  const current=await lockDraftishVersion(client,adminUserId,isBoss,"full_payout_terms_version",id);
  if(current.status!=="DRAFT")throw conflict("Sealed full-payout terms cannot be edited");
  checkRevision(current,body.expectedRevision);
  ensureOnlyFields(body,["expectedRevision","title","body","bodyDocument","disclosureVersion"]);
  if(!["title","body","bodyDocument","disclosureVersion"].some(k=>Object.hasOwn(body,k)))throw invalid();
  const text = tradeTermsDocument(body, current);
  const v=fullPayoutDraftFields({policyRef:current.policy_ref,policyVersion:current.policy_version,
    disclosureVersion:body.disclosureVersion===undefined?current.disclosure_version:body.disclosureVersion,title:body.title===undefined?current.title:body.title,body:text.body ?? current.body});
  await client.query(`UPDATE zzsh_supply.full_payout_terms_version SET title=$1,body=$2,disclosure_version=$3,digest=$4,${text.document ? "body_document=$6::jsonb," : ""}revision=revision+1,updated_at=clock_timestamp() WHERE id=$5`,[v.title,v.body,v.disclosureVersion,text.document ? await plateDigest(text.document) : current.body_document != null ? current.digest : v.digest,id,...(text.document ? [JSON.stringify(text.document)] : [])]);
}

export type ActivationResult = { releaseId: string; generation: string; effectiveAt: string; announcementVersionId: string };

type SettlementResourcePrice = { name:string; unit:string; pricingKind:string|null; unitQuantity:string|null; buyerUnitAmount:string|null; ownerUnitAmount:string|null };
export function assertSettlementResourcePrices(mode:unknown,rows:readonly SettlementResourcePrice[]) {
  if(mode!=='SPREAD' && mode!=='PERCENT')throw invalid('价格模式无效');
  if(rows.length>63)throw invalid('可结算物资超过 63 项，请先调整物资目录');
  for(const row of rows){
    let valid=['ROUND','PIECE','DAY'].includes(row.unit) && row.pricingKind==='FIXED_UNIT'
      && typeof row.unitQuantity==='string' && /^[1-9]\d{0,23}$/.test(row.unitQuantity) && typeof row.buyerUnitAmount==='string';
    try{
      if(valid){
        const buyer=decimalToBigInt(parseNonNegativeDecimal(row.buyerUnitAmount!,8,'buyer unit'),8);
        valid=mode==='PERCENT' ? row.ownerUnitAmount===null : typeof row.ownerUnitAmount==='string'
          && decimalToBigInt(parseNonNegativeDecimal(row.ownerUnitAmount,8,'owner unit'),8)<=buyer;
      }
    }catch{valid=false;}
    if(!valid)throw invalid(`物资“${row.name}”的结算单价或单位未配置完整，请先检查价格规则`,'priceVersionId');
  }
}

/** Every enabled resource must have a price, including items absent from the original listing. */
export async function assertPriceVersionResources(client:PoolClient,gameId:string,priceVersionId:string,mode:unknown):Promise<void> {
  const rows=(await client.query<SettlementResourcePrice>(`SELECT i.name,i.unit,p.pricing_kind AS "pricingKind",p.unit_quantity::text AS "unitQuantity",
    p.buyer_unit_amount::text AS "buyerUnitAmount",p.owner_unit_amount::text AS "ownerUnitAmount"
    FROM zzsh_supply.billable_item i LEFT JOIN zzsh_supply.price_line p ON p.item_id=i.id AND p.price_version_id=$2 AND p.customer_tier='STANDARD'
    WHERE i.game_id=$1 AND i.enabled ORDER BY i.id FOR SHARE OF i`,[gameId,priceVersionId])).rows;
  const haff=rows.filter(row=>row.unit==='HAFF_BASE');
  if(haff.length!==1||haff[0]!.pricingKind!=='HAFF_RATIO')throw invalid('哈夫币计价未配置完整','priceVersionId');
  assertSettlementResourcePrices(mode,rows.filter(row=>row.unit!=='HAFF_BASE'));
}

export async function assertScheduledTermCompatibility(client: PoolClient, termVersionId: string,
  prices: readonly { mode: "PERCENT" | "SPREAD"; haffRule: unknown }[]) {
  const terms = (await client.query<{ code: string; dailyConsumption: string }>(
    `SELECT code, daily_consumption::text AS "dailyConsumption" FROM zzsh_supply.term_option WHERE version_id=$1`, [termVersionId])).rows;
  for (const { mode, haffRule } of prices) {
    let rule: DeltaHaffRule;
    try { rule = validateDeltaHaffRule(haffRule, mode); }
    catch { throw conflict("排期价目的哈夫币比例无法核对"); }
    const fixed = mode === "PERCENT";
    const modes = fixed ? rule.fixedModes : rule.compatibility?.modes;
    if (rule.schema !== (fixed ? "haff-ratio-v3" : "haff-ratio-v2") || !terms.length
      || terms.some(term => !Object.hasOwn(rule.dailyDeltaByTermOption, term.code))
      || (modes?.custom.enabled && !terms.some(term => term.dailyConsumption === DELTA_CUSTOM_DAILY_CONSUMPTION)))
      throw conflict("租期选项与排期价目不兼容，请核对日耗和对应比例");
  }
}

/** Check the effective default at every combination, price or mode boundary in the changed interval. */
export async function assertRulePricingTimeline(client: PoolClient, gameId: string, from: string) {
  const ready = (await client.query(`SELECT to_regclass('zzsh_supply.pricing_policy_schedule') IS NOT NULL AS prices,
    to_regclass('zzsh_supply.pricing_mode_schedule') IS NOT NULL AS modes`)).rows[0];
  if (!ready?.prices || !ready?.modes) throw conflict("价格和模式排期尚未安装");
  const pairs = (await client.query<{ termId: string | null; mode: "PERCENT" | "SPREAD"; haffRule: unknown; priceId: string | null; scheduled: boolean }>(`
    WITH boundaries AS (
      SELECT $2::timestamptz AS at
      UNION SELECT r.activated_at FROM zzsh_supply.rule_release r
        WHERE r.game_id=$1 AND to_jsonb(r)->>'effective_at' IS NOT NULL AND to_jsonb(r)->>'voided_at' IS NULL AND r.activated_at>=$2::timestamptz
      UNION SELECT effective_at FROM zzsh_supply.pricing_policy_schedule p WHERE game_id=$1 AND effective_at>=$2::timestamptz AND to_jsonb(p)->>'voided_at' IS NULL
      UNION SELECT effective_at FROM zzsh_supply.pricing_mode_schedule m WHERE game_id=$1 AND effective_at>=$2::timestamptz AND to_jsonb(m)->>'voided_at' IS NULL
    )
    SELECT DISTINCT r.term_version_id AS "termId", p.mode, p.haff_rule AS "haffRule", p.id AS "priceId",
      (m.pricing_model IS NOT NULL) AS scheduled
    FROM boundaries b JOIN zzsh_supply.game g ON g.id=$1
    LEFT JOIN zzsh_supply.rule_release r ON r.id=${effectiveRuleRelease("g", "b.at")} AND r.game_id=g.id
    LEFT JOIN LATERAL (SELECT pricing_model FROM zzsh_supply.pricing_mode_schedule m WHERE game_id=g.id AND effective_at<=b.at AND to_jsonb(m)->>'voided_at' IS NULL
      ORDER BY effective_at DESC,generation DESC LIMIT 1) m ON true
    LEFT JOIN LATERAL (SELECT price_version_id FROM zzsh_supply.pricing_policy_schedule p
      WHERE game_id=g.id AND pricing_model=m.pricing_model AND effective_at<=b.at AND to_jsonb(p)->>'voided_at' IS NULL
      ORDER BY effective_at DESC,generation DESC LIMIT 1) q ON true
    LEFT JOIN zzsh_supply.price_version p ON p.game_id=g.id AND p.status='SEALED'
      AND p.id=CASE WHEN m.pricing_model IS NULL THEN r.price_version_id ELSE q.price_version_id END
      AND (m.pricing_model IS NOT NULL OR p.fixed_fee_rates IS NULL)
      AND (m.pricing_model IS NULL OR (m.pricing_model='FIXED_FEE' AND p.mode='PERCENT' AND p.fixed_fee_rates IS NOT NULL)
        OR (m.pricing_model='SPREAD' AND p.mode='SPREAD' AND p.fixed_fee_rates IS NULL))`, [gameId,from])).rows;
  for (const pair of pairs) {
    if (!pair.termId || !pair.priceId) throw conflict("生效时点缺少可用租期或价目");
    const schema = (pair.haffRule as { schema?: unknown } | null)?.schema;
    if (pair.scheduled || schema === "haff-ratio-v2" || schema === "haff-ratio-v3")
      await assertScheduledTermCompatibility(client, pair.termId, [pair]);
  }
}

export async function activateRelease(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  gameId: string,
  priceVersionId: string,
  termVersionId: string,
  agreementVersionId: string,
  expectedGeneration: string,
  schedule?: { effectiveAt: string; announcementVersionId: string; earlySettlement?: { versionId: string; digest: string }; batchId?: string },
): Promise<ActivationResult> {
  if (!/^(0|[1-9]\d*)$/.test(expectedGeneration)) throw invalid("Expected generation is required");
  if (!isBoss) throw new SecurityApiError(403, API_V1_ERROR_CODES.FORBIDDEN, "Only a boss can activate a rule release");
  if (!schedule) throw invalid("规则组合须绑定公告和未来生效时间");
  let effectiveAt: string | null;
  try { effectiveAt = normalizeTime(schedule.effectiveAt); }
  catch { throw invalid("规则组合生效时间无效"); }
  if (!effectiveAt) throw invalid("规则组合生效时间无效");
  const ready = (await client.query(`SELECT EXISTS (SELECT 1 FROM pg_attribute
    WHERE attrelid='zzsh_supply.rule_release'::regclass AND attname='effective_at' AND NOT attisdropped) AS available`)).rows[0];
  if (!ready?.available) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "规则组合排期尚未安装");
  await lockFixedFeePolicyChange(client);
  const locked = await client.query(`SELECT id FROM zzsh_supply.game WHERE id=$1 FOR UPDATE`, [gameId]);
  if (!locked.rows.length) throw notFound();
  // Read the joined versions after acquiring the lock, including when the lock had to wait.
  const game = (await client.query<{ id: string; priceVersionId: string | null; termVersionId: string | null; agreementVersionId: string | null; earlySettlementVersionId: string | null; earlySettlementDigest: string | null; fixedFee: boolean }>(
    `SELECT g.id, r.price_version_id AS "priceVersionId", r.term_version_id AS "termVersionId", r.agreement_version_id AS "agreementVersionId", r.early_settlement_version_id AS "earlySettlementVersionId", r.early_settlement_digest AS "earlySettlementDigest",
      to_jsonb(p)->>'fixed_fee_rates' IS NOT NULL AS "fixedFee"
      FROM "zzsh_supply"."game" g LEFT JOIN zzsh_supply.rule_release r ON r.id=${effectiveRuleRelease("g", "$2::timestamptz")} AND r.game_id=g.id
      LEFT JOIN zzsh_supply.price_version p ON p.id=r.price_version_id AND p.game_id=g.id
      WHERE g.id=$1`, [gameId, effectiveAt])).rows[0];
  if (!game) throw notFound();
  await assertGameScope(client, adminUserId, isBoss, gameId);
  const now = (await client.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0]?.at;
  if (!now || effectiveAt <= now) throw invalid("规则组合生效时间必须晚于当前时间");
  const pending = await client.query(`SELECT 1 FROM zzsh_supply.rule_release r
    WHERE game_id=$1 AND effective_at>clock_timestamp() AND to_jsonb(r)->>'voided_at' IS NULL`, [gameId]);
  if (pending.rows.length) throw conflict("规则组合已有待生效的改动");
  const versions = await client.query<{ id: string; status: string; gameId: string }>(
    `SELECT "id", "status", "game_id" AS "gameId" FROM "zzsh_supply"."price_version" WHERE "id" = $1
     UNION ALL SELECT "id", "status", "game_id" AS "gameId" FROM "zzsh_supply"."term_version" WHERE "id" = $2
     UNION ALL SELECT "id", "status", "game_id" AS "gameId" FROM "zzsh_supply"."agreement_version" WHERE "id" = $3`,
    [priceVersionId, termVersionId, agreementVersionId],
  );
  if (versions.rows.length !== 3) throw invalid("Rule versions do not exist");
  for (const row of versions.rows) {
    if (row.gameId !== gameId) throw invalid("Rule versions must belong to this game");
    if (row.status !== "SEALED") throw conflict("Rule versions must be sealed before activation");
  }
  const priceMeta = (await client.query<{ policy: unknown | null;mode:string;fixedFeeRates:unknown | null }>(
    `SELECT "funding_policy" AS policy,mode,to_jsonb(v)->'fixed_fee_rates' AS "fixedFeeRates" FROM "zzsh_supply"."price_version" v WHERE "id" = $1`, [priceVersionId],
  )).rows[0];
  if(!priceMeta)throw invalid('价格规则不存在');
  if (game.fixedFee && priceMeta.fixedFeeRates == null && !schedule.batchId)
    throw conflict("固定手续费组合须引用固定手续费资金版本");
  if (priceMeta.fixedFeeRates != null && game.priceVersionId !== priceVersionId) {
    const effective = await readNewListingPrice(client, gameId, game.priceVersionId ?? priceVersionId, effectiveAt);
    if (!effective.priceScheduleId || priceMeta.policy == null)
      throw conflict("固定手续费资金版本须包含资金政策，且该时点须有独立生效价目");
  }
  const nextGeneration = await client.query<{ generation: string }>(
    `SELECT (COALESCE(MAX("generation"), 0) + 1)::text AS "generation" FROM "zzsh_supply"."rule_release" WHERE "game_id" = $1`,
    [gameId],
  );
  const generation = nextGeneration.rows[0]!.generation;
  if (BigInt(generation) - 1n !== BigInt(expectedGeneration)) throw conflict("Rule release changed; reload before confirming activation");
  const earlySettlement = await readCurrentEarlySettlementDisclosure(client);
  if (!earlySettlement) throw conflict("请先发布提前结算告知");
  if (schedule.earlySettlement && (schedule.earlySettlement.versionId !== earlySettlement.versionId || schedule.earlySettlement.digest !== earlySettlement.digest))
    throw conflict("提前结算告知已变更，请刷新规则后重新核对");
  if (game.earlySettlementVersionId === earlySettlement.versionId && game.earlySettlementDigest === earlySettlement.digest && priceVersionId === game.priceVersionId && termVersionId === game.termVersionId && agreementVersionId === game.agreementVersionId)
    throw conflict("规则组合没有变化");
  if (priceMeta.fixedFeeRates == null && !schedule.batchId) {
    await assertPriceVersionResources(client,gameId,priceVersionId,priceMeta.mode);
  }
  const pricePolicy=priceMeta.policy;
  if (pricePolicy == null && schedule.batchId && priceVersionId !== game.priceVersionId)
    throw conflict("规则组合须保留有效押金和包赔政策");
  if (pricePolicy !== null && pricePolicy !== undefined) {
    const policy = validateFundingPolicy(pricePolicy);
    if ((priceMeta.fixedFeeRates != null || schedule.batchId) && game.priceVersionId && game.priceVersionId !== priceVersionId) {
      const prior = (await client.query<{ policy: unknown }>(
        "SELECT funding_policy AS policy FROM zzsh_supply.price_version WHERE id=$1 AND game_id=$2", [game.priceVersionId, gameId])).rows[0]?.policy;
      const priorPolicy = prior == null ? null : validateFundingPolicy(prior);
      if (priorPolicy?.policyVersion === policy.policyVersion && JSON.stringify(priorPolicy) !== JSON.stringify(policy))
        throw conflict("变更押金或包赔条款时须使用新的资金政策版本");
    }
    await readFullPayoutTerms(client, gameId, policy, priceVersionId);
  }
  await assertPublishedPricingAnnouncement(client, gameId, schedule.announcementVersionId, effectiveAt);
  const releaseId = newSupplyId("release");
  await client.query(
    `INSERT INTO zzsh_supply.rule_release(id, game_id, price_version_id, term_version_id, agreement_version_id,
      generation, activated_by_admin_id, activated_at, effective_at, announcement_version_id, early_settlement_version_id, early_settlement_digest${schedule.batchId ? ',batch_id' : ''})
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8::timestamptz,$8::timestamptz,$9,$10,$11${schedule.batchId ? ',$12' : ''})`,
    [releaseId, gameId, priceVersionId, termVersionId, agreementVersionId, generation, adminUserId, effectiveAt, schedule.announcementVersionId, earlySettlement.versionId, earlySettlement.digest, ...(schedule.batchId ? [schedule.batchId] : [])],
  );
  if (!schedule.batchId) await assertRulePricingTimeline(client, gameId, effectiveAt);
  return { releaseId, generation, effectiveAt, announcementVersionId: schedule.announcementVersionId };
}

/** 试算回执绑定：调用方据此判定结果是否仍对应当前选择的草稿修订、模式、B 与库存。 */
export type QuotePreviewBinding = {
  priceVersionId: string; priceVersionStatus: string; priceVersionRevision: string; termVersionId: string;
  rentalMode: "ordinary" | "custom" | "fast" | null; ownerRatioB: string | null; inventory: Array<{ itemId: string; quantity: string }>;
};

export async function quotePreview(
  client: PoolClient,
  adminUserId: string,
  isBoss: boolean,
  body: Record<string, unknown>,
): Promise<{ gameId: string; quotable: boolean; quote?: unknown; contentPayload?: ContentPayloadInput; contentHash?: string; reasonCodes?: string[]; binding: QuotePreviewBinding }> {
  ensureOnlyFields(body, ["priceVersionId", "termVersionId", "expectedRevision", "accountId", "conditions", "inventory", "entitlements", "deposits", "title", "description", "skins", "mediaBindings", "releaseId", "agreementVersionId", "agreementDigest"]);
  const priceVersionId = String(body.priceVersionId ?? "");
  const termVersionId = String(body.termVersionId ?? "");
  const price = await client.query<{
    id: string;
    gameId: string;
    mode: "SPREAD" | "PERCENT";
    status: string;
    commissionRate: string | null;
    fixedFeeRates: unknown | null;
    haffRule: unknown;
    roundingPolicy: string;
    revision: string;
  }>(
    `SELECT "id", "game_id" AS "gameId", "mode", "status", "commission_rate"::text AS "commissionRate",
            "haff_rule" AS "haffRule", "fixed_fee_rates" AS "fixedFeeRates", "rounding_policy" AS "roundingPolicy", "revision"::text AS "revision"
       FROM "zzsh_supply"."price_version" WHERE "id" = $1`,
    [priceVersionId],
  );
  const priceRow = price.rows[0];
  if (!priceRow) throw notFound();
  await assertGameScope(client, adminUserId, isBoss, priceRow.gameId);
  // 草稿试算须绑定调用方看到的修订；草稿被改后旧试算作废（409），不静默按新内容出价。
  if (body.expectedRevision !== undefined && (typeof body.expectedRevision !== "string" || body.expectedRevision !== priceRow.revision)) throw conflict("Version changed; refresh and retry");
  // 不加行锁：会员利润模拟在 READ ONLY 事务内调用（membership-growth-routes），PG 拒绝只读事务中的 FOR SHARE。
  // 一致性改由读后修订复核保证：草稿行的唯一写入者 updatePriceDraft/updateTermDraft 在同一事务内
  // FOR UPDATE 父行 + 替换 price_line/term_option + revision+1；SEALED 版本不可编辑，复核恒等。
  const term = await client.query<{ id: string; gameId: string; status: string; revision?: string }>(
    `SELECT "id", "game_id" AS "gameId", "status", "revision"::text AS "revision" FROM "zzsh_supply"."term_version" WHERE "id" = $1`,
    [termVersionId],
  );
  const termRow = term.rows[0];
  if (!termRow || termRow.gameId !== priceRow.gameId) throw invalid("Term version does not belong to this game");

  const conditions = body.conditions && typeof body.conditions === "object" && !Array.isArray(body.conditions)
    ? (body.conditions as Record<string, unknown>)
    : {};
  ensureOnlyFields(conditions, ["safeBoxCode", "vitLevel", "bearLevel", "termOptionCode", "pricingOptionCode", "rentalPricing"]);
  const termOptionCode = typeof conditions.termOptionCode === "string" ? conditions.termOptionCode : "";
  const termOptionRow = await client.query<{ code: string; dailyConsumption: string; durationRounding: "CEIL_DAY" }>(
    `SELECT "code", "daily_consumption"::text AS "dailyConsumption", "duration_rounding" AS "durationRounding"
       FROM "zzsh_supply"."term_option" WHERE "version_id" = $1 AND "code" = $2`,
    [termVersionId, termOptionCode],
  );
  const termOption = termOptionRow.rows[0];
  if (!termOption) throw invalid("Term option is not defined in the selected term version");
  validateDeltaRentalTerm(conditions.rentalPricing == null ? undefined : normalizeRentalPricing(conditions.rentalPricing), termOption, termOptionCode);

  const inventory = Array.isArray(body.inventory) ? body.inventory : [];
  const inventoryById = new Map<string, string>();
  for (const entry of inventory) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid("Inventory is invalid");
    const item = entry as Record<string, unknown>;
    ensureOnlyFields(item, ["itemId", "quantity"]);
    if (typeof item.itemId !== "string" || typeof item.quantity !== "string" || !/^(0|[1-9]\d{0,23})$/.test(item.quantity)) throw invalid("Inventory is invalid");
    if (inventoryById.has(item.itemId)) throw invalid("Inventory must not repeat an item");
    inventoryById.set(item.itemId, item.quantity);
  }

  const lineRows = await client.query<{
    itemId: string;
    code: string;
    unit: string;
    pricingKind: "FIXED_UNIT" | "HAFF_RATIO";
    unitQuantity: string | null;
    buyerUnitAmount: string | null;
    ownerUnitAmount: string | null;
  }>(
    `SELECT l."item_id" AS "itemId", i."code", i."unit", l."pricing_kind" AS "pricingKind", l."unit_quantity"::text AS "unitQuantity",
            l."buyer_unit_amount"::text AS "buyerUnitAmount", l."owner_unit_amount"::text AS "ownerUnitAmount"
       FROM "zzsh_supply"."price_line" l JOIN "zzsh_supply"."billable_item" i ON i."id" = l."item_id"
      WHERE l."price_version_id" = $1 AND l.customer_tier='STANDARD' ORDER BY l."item_id"`,
    [priceVersionId],
  );
  const lines: PricingLineInput[] = [];
  for (const row of lineRows.rows) {
    const quantity = inventoryById.get(row.itemId);
    if (quantity === undefined) continue;
    assertDeltaResourceUnit(row.code, row.unit);
    lines.push({
      customerTier: "STANDARD",
      itemId: row.itemId,
      quantity,
      pricingKind: row.pricingKind,
      unit: row.unit as PricingLineInput["unit"],
      ...(row.unitQuantity !== null ? { unitQuantity: row.unitQuantity } : {}),
      ...(row.buyerUnitAmount !== null ? { buyerUnitAmount: row.buyerUnitAmount } : {}),
      ...(row.ownerUnitAmount !== null ? { ownerUnitAmount: row.ownerUnitAmount } : {}),
    });
  }
  if (lines.length === 0) throw invalid("No declared inventory matches the selected price version");
  // 读后复核：锁不可用（如调用方不在事务内）时也不让多表读取混入另一修订；binding 只回执已复核的修订。
  const priceAfter = await client.query<{ revision: string }>(`SELECT "revision"::text AS "revision" FROM "zzsh_supply"."price_version" WHERE "id" = $1`, [priceVersionId]);
  const termAfter = await client.query<{ revision?: string }>(`SELECT "revision"::text AS "revision" FROM "zzsh_supply"."term_version" WHERE "id" = $1`, [termVersionId]);
  if (priceAfter.rows[0]?.revision !== priceRow.revision || termAfter.rows[0]?.revision !== termRow.revision) throw conflict("Version changed; refresh and retry");
  const rentalSelection = conditions.rentalPricing == null ? null : normalizeRentalPricing(conditions.rentalPricing);
  let fixedRates: FixedFeeRates | null = null;
  if (priceRow.fixedFeeRates !== null && priceRow.fixedFeeRates !== undefined) {
    try { fixedRates = parseFixedFeeRates(priceRow.fixedFeeRates); } catch { throw invalid("Fixed fee rates are invalid"); }
    if (!rentalSelection) throw invalid("Fixed fee pricing requires a rental mode", "conditions.rentalPricing");
  }
  const binding: QuotePreviewBinding = {
    priceVersionId, priceVersionStatus: priceRow.status, priceVersionRevision: priceRow.revision, termVersionId,
    rentalMode: rentalSelection?.rentalMode ?? null, ownerRatioB: rentalSelection?.ownerRatioB ?? null,
    inventory: [...inventoryById.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([itemId, quantity]) => ({ itemId, quantity })),
  };

  const entitlementInputs: Array<{ entitlementId: string; expiryKind: "PERMANENT" | "TIMED"; expiresAt?: string }> = [];
  if (Array.isArray(body.entitlements)) {
    for (const entry of body.entitlements) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid("Entitlements are invalid");
      const entitlement = entry as Record<string, unknown>;
      ensureOnlyFields(entitlement, ["entitlementId", "expiresAt"]);
      if (typeof entitlement.entitlementId !== "string") throw invalid("Entitlements are invalid");
      const known = await client.query<{ expiryKind: "PERMANENT" | "TIMED"; gameId: string }>(
        `SELECT "expiry_kind" AS "expiryKind", "game_id" AS "gameId" FROM "zzsh_supply"."entitlement" WHERE "id" = $1`,
        [entitlement.entitlementId],
      );
      const row = known.rows[0];
      if (!row || row.gameId !== priceRow.gameId) throw invalid("Entitlement does not belong to this game");
      const expiresAt = typeof entitlement.expiresAt === "string" ? normalizeTime(entitlement.expiresAt) : null;
      entitlementInputs.push({
        entitlementId: entitlement.entitlementId,
        expiryKind: row.expiryKind,
        ...(typeof expiresAt === "string" ? { expiresAt } : {}),
      });
    }
  }

  const deposits = body.deposits && typeof body.deposits === "object" && !Array.isArray(body.deposits)
    ? (body.deposits as { tenantDepositCents?: unknown; publisherBailRequirementCents?: unknown })
    : undefined;
  if (deposits) ensureOnlyFields(deposits, ["tenantDepositCents", "publisherBailRequirementCents"]);
  if (body.skins !== undefined && (!Array.isArray(body.skins) || body.skins.some((id) => typeof id !== "string"))) throw invalid("Skins must be an array of IDs");
  if (body.mediaBindings !== undefined) {
    if (!Array.isArray(body.mediaBindings)) throw invalid("Media bindings must be an array");
    for (const entry of body.mediaBindings) {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw invalid("Invalid media binding");
      ensureOnlyFields(entry, ["assetId", "byteHash", "purpose", "position"]);
    }
  }

  const result: QuoteResult = computeDeltaQuote({
    customerTier: "STANDARD",
    priceVersionId,
    mode: priceRow.mode,
    roundingPolicy: priceRow.roundingPolicy,
    ...(fixedRates && rentalSelection ? { fixedFeeAlgorithm: FIXED_FEE_ALGORITHM, commissionRate: fixedFeeRateForMode(fixedRates, rentalSelection.rentalMode) }
      : priceRow.commissionRate !== null ? { commissionRate: priceRow.commissionRate } : {}),
    ...(priceRow.haffRule ? { haffRule: priceRow.haffRule as HaffRatioRule } : {}),
    lines,
    conditions: {
      ...(conditions.rentalPricing === undefined ? {} : { rentalPricing: normalizeRentalPricing(conditions.rentalPricing) }),
      ...(typeof conditions.safeBoxCode === "string" ? { safeBoxCode: conditions.safeBoxCode } : {}),
      ...(typeof conditions.vitLevel === "number" ? { vitLevel: conditions.vitLevel } : {}),
      ...(typeof conditions.bearLevel === "number" ? { bearLevel: conditions.bearLevel } : {}),
      ...(termOptionCode ? { termOptionCode } : {}),
      ...(typeof conditions.pricingOptionCode === "string" ? { pricingOptionCode: conditions.pricingOptionCode } : {}),
    },
    termOption,
    entitlements: entitlementInputs,
    ...(deposits
      ? {
          deposits: {
            ...(typeof deposits.tenantDepositCents === "string" ? { tenantDepositCents: deposits.tenantDepositCents } : {}),
            ...(typeof deposits.publisherBailRequirementCents === "string" ? { publisherBailRequirementCents: deposits.publisherBailRequirementCents } : {}),
          },
        }
      : {}),
  });

  if (!result.quotable) return { gameId: priceRow.gameId, quotable: false, reasonCodes: result.reasonCodes, binding };

  let contentHash: string | undefined;
  let contentPayload: ContentPayloadInput | undefined;
  if (typeof body.accountId === "string" && body.accountId.length > 0) {
    const declaration: ContentDeclaration = {
      title: typeof body.title === "string" ? body.title : "",
      description: typeof body.description === "string" ? body.description : null,
      attributes: conditions.rentalPricing === undefined ? {} : { rentalPricing: normalizeRentalPricing(conditions.rentalPricing) },
      inventory: [...inventoryById.entries()].map(([itemId, quantity]) => ({ itemId, quantity })),
      skins: Array.isArray(body.skins) ? body.skins.filter((value): value is string => typeof value === "string") : [],
      entitlements: entitlementInputs.map((entitlement) => ({
        entitlementId: entitlement.entitlementId,
        value: null,
        expiresAt: entitlement.expiresAt ?? null,
        expiryKnowledge: entitlement.expiresAt ? "KNOWN" : "UNKNOWN",
      })),
      termOptionCode,
      pricingOptionCode: typeof conditions.pricingOptionCode === "string" ? conditions.pricingOptionCode : "",
      mediaBindings: Array.isArray(body.mediaBindings)
        ? body.mediaBindings
            .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === "object" && !Array.isArray(entry))
            .map((entry) => ({
              assetId: String(entry.assetId ?? ""),
              byteHash: String(entry.byteHash ?? ""),
              purpose: String(entry.purpose ?? ""),
              position: typeof entry.position === "number" ? entry.position : 0,
            }))
        : [],
    };
    const payload: ContentPayloadInput = {
      schemaVersion: result.quote.schemaVersion,
      accountId: body.accountId,
      gameId: priceRow.gameId,
      declaration,
      ruleRefs: {
        releaseId: typeof body.releaseId === "string" ? body.releaseId : "",
        priceVersionId,
        termVersionId,
        agreementVersionId: typeof body.agreementVersionId === "string" ? body.agreementVersionId : "",
        agreementDigest: typeof body.agreementDigest === "string" ? body.agreementDigest : "",
      },
      quoteValues: withoutContentHash(result.quote) as unknown as Record<string, unknown>,
    };
    contentPayload = normalizeContentPayload(payload);
    contentHash = computeContentHash(contentPayload);
  }

  const projected = projectDeltaQuote({ ...result.quote, ...(contentHash ? { contentHash } : {}) }, "admin");
  return { gameId: priceRow.gameId, quotable: true, quote: projected, ...(contentPayload ? { contentPayload } : {}), ...(contentHash ? { contentHash } : {}), binding };
}
