/**
 * 上架报价域：报价试算、保证金建议与收入预览。金额沿用既有十进制解析，不引入浮点真值。
 * 写函数接收调用方的 PoolClient，事务边界仍由调用方持有。
 */
import { effectiveRuleRelease } from "./effective-rule-release";
import { verifyTradeTermsBody } from "./full-payout-terms";
import { SecurityApiError } from "../auth/security-core";
import { API_V1_ERROR_CODES } from "../contracts/api-v1";
import { readLegacyPublishedReference } from "./legacy-published-reference";
import { PoolClient } from "pg";
import { canonicalize, computeContentHash, normalizeContentPayload, type ContentPayloadInput } from "./content-hash";
import { computeDeltaQuote, computeFixedUnitAmounts, ROUNDING_POLICY, type QuoteInput } from "./pricing";
import { formatDecimalExact, parseNonNegativeDecimal, yuanAmountObject } from "./decimal";
import { conflict, ensureOnlyFields, invalid, notFound, sha256Hex } from "./supply-util";
import { GAME_SERVICE, requireWritableGameService } from "./game-services";
import { assertDeltaResourceUnit, isRetiredDeltaInsurance, normalizeRentalPricing, validateDeltaRentalTerm, type RentalMode } from "./delta-rental";
import { readFundingPolicyForRelease } from "./funding-authority";
import { computeDepositRecommendation, validateOwnerDepositDeclaration } from "./funding-policy";
import { DepositSkinFacts } from "./deposit-recommendation";
import { FIXED_FEE_ALGORITHM, parseFixedFeeRates } from "./fixed-fee";
import { readEffectiveFixedFeePrice, readNewListingPrice, readEffectiveSpreadPrice, readListingPricingModel } from "./pricing-policy-schedule";
import { publicSkinMediaIdSql, publicSkinMetadataSql, publicSkinOwnerNameSql, publicSkinRarityNameSql } from "./catalog";
import { type LegacyTakeoverGradingContext, type PublishingAccount, assertUnpublishedAccount, bumpAccount, checkAccountRevision, currentVersion, readDeclaration, validatePublicationAttributes } from "./publishing-internals";

export async function readDepositRecommendation(
  client: PoolClient,
  a: PublishingAccount,
): Promise<Record<string, unknown>> {
  const v = await currentVersion(client, a);
  if (v.review_state !== "DRAFT" || v.origin !== "NATIVE")
    throw conflict("仅可为新申报草稿查看推荐押金");
  const release = (
    await client.query<{ id: string; priceVersionId: string }>(
      `SELECT r.id,r.price_version_id AS "priceVersionId" FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=${effectiveRuleRelease("g")} WHERE g.id=$1 AND g.enabled`,
      [a.game_id],
    )
  ).rows[0];
  if (!release) throw conflict("暂无可用规则");
  const policy = await readFundingPolicyForRelease(client, release.id);
  if (!policy)
    return {
      available: false,
      reason: "FUNDING_POLICY_UNCONFIGURED",
      releaseId: release.id,
    };
  const d = await readDeclaration(client, v);
  const factRow = policy.recommendation.schema === "deposit-recommendation-v2" ? (await client.query<{ catalogRevision: string; skins: DepositSkinFacts["skins"] }>(`
    SELECT g.catalog_revision::text AS "catalogRevision",
      COALESCE(jsonb_agg(jsonb_build_object('skinId',s.id,'ownerKind',s.owner_kind,'rarityCode',s.rarity_code) ORDER BY s.id) FILTER (WHERE s.id IS NOT NULL),'[]'::jsonb) AS skins
    FROM zzsh_supply.game g LEFT JOIN zzsh_supply.skin s ON s.game_id=g.id AND s.id=ANY($2::text[]) AND s.naming_state='VERIFIED'
    WHERE g.id=$1 GROUP BY g.id,g.catalog_revision`, [a.game_id, d.skins])).rows[0] : undefined;
  const skinFacts: DepositSkinFacts | undefined = factRow ? { schema: "deposit-skin-facts-v1", gameId: a.game_id, listingVersionId: v.id, catalogRevision: factRow.catalogRevision, skins: factRow.skins } : undefined;
  const attrs = d.attributes as Record<string, unknown>;
  const vitality = attrs.vit_level ?? attrs.vitLevel;
  const bear = attrs.bear_level ?? attrs.bearLevel;
  const inputs = {
    safeBoxCode:
      typeof attrs.safe_box_code === "string" ? attrs.safe_box_code : null,
    vitality: typeof vitality === "number" ? vitality : null,
    bear: typeof bear === "number" ? bear : null,
    dive: typeof attrs.dive_level === "number" ? attrs.dive_level : null,
    skinIds: [...d.skins],
    ...(skinFacts ? { skinFacts } : {}),
  };
  const binding = {
    accountId: a.id,
    accountRevision: a.revision,
    versionId: v.id,
    versionRevision: v.revision,
    ruleReleaseId: release.id,
    priceVersionId: release.priceVersionId,
    inputs,
  };
  try {
    const amountCents = computeDepositRecommendation(policy, {
      accountId: a.id,
      gameId: a.game_id,
      listingVersionId: v.id,
      priceVersionId: release.priceVersionId,
      ruleReleaseId: release.id,
      safeBoxCode: inputs.safeBoxCode,
      vitality: inputs.vitality,
      bear: inputs.bear,
      dive: inputs.dive,
      skinIds: inputs.skinIds,
      skinFacts,
    });
    return {
      available: true,
      amountCents,
      minCents: policy.ownerDepositRules.normal.minCents,
      fullPayoutMinCents: policy.ownerDepositRules.fullPayoutSelected.minCents,
      capCents: policy.ownerDepositRules.capCents,
      policyVersion: policy.policyVersion,
      recommendationSchema: policy.recommendation.schema,
      ...binding,
    };
  } catch {
    return {
      available: false,
      reason: "INPUTS_UNAVAILABLE",
      releaseId: release.id,
    };
  }
}

export function parseIncomePreviewInventory(inventory: unknown): Map<string, string | null> {
  if (!Array.isArray(inventory) || inventory.length > 100) throw invalid("库存格式错误", "inventory");
  const quantities = new Map<string, string | null>();
  for (const row of inventory) {
    if (!row || typeof row !== "object" || Array.isArray(row)) throw invalid("库存格式错误", "inventory");
    ensureOnlyFields(row, ["itemId", "quantity"]);
    if (typeof row.itemId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(row.itemId) || quantities.has(row.itemId)
      || (row.quantity !== null && (typeof row.quantity !== "string" || !/^(0|[1-9]\d{0,23})$/.test(row.quantity)))) throw invalid("库存须为不重复的物品身份和整数数量", "inventory");
    quantities.set(row.itemId, row.quantity);
  }
  return quantities;
}

export type IncomePreviewRelease = {
  releaseId: string; generation: string; priceVersionId: string; termVersionId: string; catalogRevision: string;
  mode: "SPREAD" | "PERCENT"; commissionRate: string | null; roundingPolicy: string; priceStatus: string; haffRule: QuoteInput["haffRule"];
  pricingPolicy?: ContentPayloadInput["pricingPolicy"];
};

export type IncomePreviewItem = {
  itemId: string; code: string; name: string; unit: "HAFF_BASE" | "ROUND" | "PIECE" | "DAY"; enabled: boolean; required: boolean;
  pricingKind: "FIXED_UNIT" | "HAFF_RATIO" | null; unitQuantity: string | null; buyerUnitAmount: string | null; ownerUnitAmount: string | null;
};

export type PreviewPricingContext = { asOf: string; accountId?: string; ownerUserId?: string; rentalMode?: RentalMode };

/** Use the same mode and effective price as the later owner quote, without changing the listing. */
export async function resolveIncomePreviewRelease(client:PoolClient,gameId:string,base:IncomePreviewRelease,context?:PreviewPricingContext) {
  const tables=(await client.query<{modes:boolean;prices:boolean}>(`SELECT to_regclass('zzsh_supply.pricing_mode_schedule') IS NOT NULL AS modes,
    to_regclass('zzsh_supply.pricing_policy_schedule') IS NOT NULL AS prices`)).rows[0];
  if(!tables||typeof tables.modes!=="boolean"||typeof tables.prices!=="boolean")return {available:false as const,reason:"RULE_UNCONFIGURED"};
  if(!tables.modes&&!tables.prices) return base.haffRule?.schema === "haff-ratio-v3"
    ? {available:false as const,reason:"RULE_UNCONFIGURED"} : {available:true as const,release:base};
  if(!tables.modes||!tables.prices||!context)return {available:false as const,reason:"PRICING_CONTEXT_REQUIRED"};
  const selected=context.accountId
    ? await readListingPricingModel(client,{accountId:context.accountId,ownerUserId:context.ownerUserId!,gameId,asOf:context.asOf,legacyPriceVersionId:base.priceVersionId})
    : await readNewListingPrice(client,gameId,base.priceVersionId,context.asOf).then(value=>({model:value.pricingModel}));
  if(!selected)return {available:false as const,reason:"RULE_UNCONFIGURED"};
  if(selected.model==="FIXED_FEE"){
    // The ordinary rate is used only to read the common version when the form has no mode yet.
    const effective=await readEffectiveFixedFeePrice(client,gameId,context.rentalMode??"ordinary",context.asOf);
    if(!effective)return {available:false as const,reason:"RULE_UNCONFIGURED"};
    return {available:true as const,release:{...base,priceVersionId:effective.priceVersionId,mode:"PERCENT" as const,
      commissionRate:context.rentalMode?effective.commissionRate:null,roundingPolicy:effective.roundingPolicy,priceStatus:"SEALED",
      haffRule:effective.haffRule as IncomePreviewRelease["haffRule"],pricingPolicy:{schema:"pricing-policy-v1" as const,
        pricingModel:"FIXED_FEE" as const,scheduleId:effective.scheduleId,generation:effective.generation,effectiveAt:effective.effectiveAt,priceVersionId:effective.priceVersionId}}};
  }
  if(selected.model==="SPREAD"){
    const effective=await readEffectiveSpreadPrice(client,gameId,context.asOf);
    if(effective)return {available:true as const,release:{...base,priceVersionId:effective.priceVersionId,mode:"SPREAD" as const,
      commissionRate:null,roundingPolicy:effective.roundingPolicy,priceStatus:"SEALED",haffRule:effective.haffRule,
      pricingPolicy:{schema:"pricing-policy-v1" as const,pricingModel:"SPREAD" as const,scheduleId:effective.scheduleId,
        generation:effective.generation,effectiveAt:effective.effectiveAt,priceVersionId:effective.priceVersionId}}};
    return {available:false as const,reason:"PRICING_POLICY_MISMATCH"};
  }
  if((selected.model==="LEGACY_SPREAD"&&base.mode!=="SPREAD")||(selected.model==="LEGACY_PERCENT"&&base.mode!=="PERCENT"))
    return {available:false as const,reason:"PRICING_POLICY_MISMATCH"};
  return {available:true as const,release:base};
}

export async function readIncomePreviewContext(client: PoolClient, gameId: string, expected: {catalogRevision: string; releaseId: string}, includeHaff = false, pricing?:PreviewPricingContext) {
  const base = (await client.query<IncomePreviewRelease>(`SELECT r.id AS "releaseId",r.generation::text AS generation,r.price_version_id AS "priceVersionId",r.term_version_id AS "termVersionId",g.catalog_revision::text AS "catalogRevision",p.mode,p.commission_rate::text AS "commissionRate",p.rounding_policy AS "roundingPolicy",p.status AS "priceStatus",p.haff_rule AS "haffRule" FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=${effectiveRuleRelease("g")} JOIN zzsh_supply.price_version p ON p.id=r.price_version_id WHERE g.id=$1 AND g.enabled`, [gameId])).rows[0];
  if (!base) return {available:false as const,reason:"RULE_UNCONFIGURED"};
  if (base.releaseId !== expected.releaseId || base.catalogRevision !== expected.catalogRevision) throw conflict("资源规则已更新，请重新读取目录");
  const resolved=await resolveIncomePreviewRelease(client,gameId,base,pricing);
  if(!resolved.available)return resolved;
  const release=resolved.release;
  if (release.roundingPolicy !== ROUNDING_POLICY || !["SPREAD", "PERCENT"].includes(release.mode)) return {available:false as const,reason:"RULE_UNSUPPORTED"};
  const commission = release.mode === "PERCENT" && release.commissionRate !== null ? parseNonNegativeDecimal(release.commissionRate,8,"commission") : null;
  if (release.mode === "PERCENT" && ((!commission && release.pricingPolicy?.pricingModel!=="FIXED_FEE") || (commission && commission.value >= 10n ** BigInt(commission.scale)))) return {available:false as const,reason:"RULE_UNCONFIGURED"};
  const items=(await client.query<IncomePreviewItem>(`SELECT i.id AS "itemId",i.code,i.name,i.unit,i.enabled,i.required,p.pricing_kind AS "pricingKind",p.unit_quantity::text AS "unitQuantity",p.buyer_unit_amount::text AS "buyerUnitAmount",p.owner_unit_amount::text AS "ownerUnitAmount" FROM zzsh_supply.billable_item i LEFT JOIN zzsh_supply.price_line p ON p.item_id=i.id AND p.price_version_id=$2 AND p.customer_tier='STANDARD' WHERE i.game_id=$1${includeHaff ? "" : " AND i.unit<>'HAFF_BASE'"} ORDER BY i.sort_order,i.code,i.id`,[gameId,release.priceVersionId])).rows;
  return {available:true as const,release,items,commission};
}

export function projectResourceIncomePreview(items: readonly IncomePreviewItem[], quantities: ReadonlyMap<string, string | null>, release: IncomePreviewRelease, commission: ReturnType<typeof parseNonNegativeDecimal> | null) {
  if([...quantities.keys()].some(id=>!items.some(row=>row.itemId===id)))throw invalid("库存物品不属于当前游戏资源", "inventory");
  const lines=[],unpricedItemIds:string[]=[];let total=0n,declared=0;
  for(const item of items){
    const quantity=quantities.get(item.itemId)??null;
    if(isRetiredDeltaInsurance(item.code)){if(quantity!==null)assertDeltaResourceUnit(item.code,item.unit);continue;}
    if(!item.enabled||item.pricingKind!=="FIXED_UNIT") {if(quantity!==null)unpricedItemIds.push(item.itemId);continue;}
    assertDeltaResourceUnit(item.code,item.unit);
    try {
      const fixedFee=release.pricingPolicy?.pricingModel==="FIXED_FEE";
      const amounts=computeFixedUnitAmounts({...item,pricingKind:"FIXED_UNIT",quantity:quantity??"0",unitQuantity:item.unitQuantity??undefined,buyerUnitAmount:item.buyerUnitAmount??undefined,
        ownerUnitAmount:(fixedFee?item.buyerUnitAmount:item.ownerUnitAmount)??undefined},fixedFee?"SPREAD":release.mode,fixedFee?null:commission);
      const ownerAmount=quantity===null?null:yuanAmountObject(amounts.ownerAmount.value);
      if(ownerAmount){total+=amounts.ownerAmount.value;declared++;}
      lines.push({itemId:item.itemId,code:item.code,name:item.name,unit:item.unit,unitQuantity:amounts.unitQuantity.value.toString(),ownerUnitAmount:{currency:"CNY" as const,unit:"yuan" as const,amount:formatDecimalExact(amounts.ownerUnit),scale:amounts.ownerUnit.scale},quantity,ownerAmount});
    }catch {if(quantity!==null)unpricedItemIds.push(item.itemId);}
  }
  return {lines,ownerTotal:declared&&unpricedItemIds.length===0?yuanAmountObject(total):null,unreportedItemIds:lines.filter(row=>row.quantity===null).map(row=>row.itemId),unpricedItemIds};
}

export async function readResourceIncomePreview(client: PoolClient, gameId: string, inventory: unknown, expected: {catalogRevision: string; releaseId: string},
  account?: {accountId:string;ownerUserId:string}): Promise<Partial<ReturnType<typeof projectResourceIncomePreview>> & {
  available: boolean; reason?: string; informationalOnly?: boolean;
  incomeBasis?: "OWNER_RESOURCE_INCOME_BEFORE_FEES"; pricingPolicy?: NonNullable<ContentPayloadInput["pricingPolicy"]>;
  binding?: { gameId: string; releaseId: string; releaseGeneration: string; priceVersionId: string; catalogRevision: string };
}> {
  const quantities = parseIncomePreviewInventory(inventory);
  const asOf=(await client.query<{evaluatedAt:string}>(`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "evaluatedAt"`)).rows[0]?.evaluatedAt;
  if(!asOf)return {available:false,reason:"RULE_UNCONFIGURED"};
  const context = await readIncomePreviewContext(client, gameId, expected,false,{asOf,...account});
  if (!context.available) return {available:false,reason:context.reason};
  const {release, items, commission} = context;
  return {available:true,binding:{gameId,releaseId:release.releaseId,releaseGeneration:release.generation,priceVersionId:release.priceVersionId,catalogRevision:release.catalogRevision},
    ...projectResourceIncomePreview(items,quantities,release,commission),informationalOnly:true,
    ...(release.pricingPolicy?{incomeBasis:"OWNER_RESOURCE_INCOME_BEFORE_FEES" as const,pricingPolicy:release.pricingPolicy}:{})};
}

export async function quoteListing(
  client: PoolClient,
  a: PublishingAccount,
  expected: unknown,
  legacyGrading?: LegacyTakeoverGradingContext,
  legacyQuote?: { actorId: string; sourceCanonical: string; policyCanonical: string;
    source: Parameters<typeof import("./legacy-listed-source-quote").buildLegacyListedSourceQuote>[0]["source"];
    policyBinding: Parameters<typeof import("./legacy-listed-source-quote").buildLegacyListedSourceQuote>[0]["policyBinding"];
    display: Parameters<typeof import("./legacy-listed-source-quote").buildLegacyListedSourceQuote>[0]["display"] },
): Promise<void> {
  checkAccountRevision(a, expected);
  if (a.lifecycle !== "ACTIVE") throw conflict("账号已归档，不能重新核价或上架");
  if ((await client.query(`SELECT 1 FROM zzsh_order.rental_order WHERE account_id=$1 AND status='COMPLETED' LIMIT 1`, [a.id])).rowCount) throw conflict("RENTAL_COMPLETED");
  await assertUnpublishedAccount(client, a);
  await requireWritableGameService(client, a.game_id, GAME_SERVICE.ACCOUNT_RENTAL);
  const v = await currentVersion(client, a);
  if (v.review_state !== "DRAFT" || v.origin !== "NATIVE")
    throw conflict("仅可为新申报草稿报价");
  const d = await readDeclaration(client, v);
  await validatePublicationAttributes(client, a, d.attributes, legacyGrading);
  if (d.inventory.some((i) => i.quantity === null))
    throw invalid("请补齐库存，未知数量不能当作零", "inventory");
  const missing = await client.query(
    `SELECT 1 FROM zzsh_supply.billable_item i WHERE game_id=$1 AND enabled AND required AND NOT EXISTS(SELECT 1 FROM zzsh_supply.inventory_line l WHERE l.version_id=$2 AND l.item_id=i.id AND l.quantity IS NOT NULL)`,
    [a.game_id, v.id],
  );
  if (missing.rowCount)
    throw invalid("必填物品须明确填写数量或零", "inventory");
  const release = (
    await client.query(
      `SELECT r.*,to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS "evaluatedAt",g.catalog_revision::text AS "catalogRevision",p.mode,p.commission_rate::text,p.haff_rule,p.rounding_policy,ag.digest FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=${effectiveRuleRelease("g")} JOIN zzsh_supply.price_version p ON p.id=r.price_version_id JOIN zzsh_supply.agreement_version ag ON ag.id=r.agreement_version_id WHERE g.id=$1 AND g.enabled FOR SHARE OF g`,
      [a.game_id],
    )
  ).rows[0];
  if (!release) throw conflict("暂无可用规则");
  let priceVersionId:string=release.price_version_id;
  let priceMode:"SPREAD"|"PERCENT"=release.mode;
  let priceRule=release.haff_rule,priceRounding:string=release.rounding_policy,commissionRate:string|null=release.commission_rate;
  let pricingPolicy:ContentPayloadInput["pricingPolicy"];
  if(!legacyQuote){
    const selected=await readListingPricingModel(client,{accountId:a.id,ownerUserId:a.owner_user_id,gameId:a.game_id,asOf:release.evaluatedAt,legacyPriceVersionId:release.price_version_id});
    if (!selected && release.haff_rule?.schema === "haff-ratio-v3")
      throw conflict("当前尚未配置固定手续费价格政策");
    if(selected?.model==="FIXED_FEE"){
      const rentalMode=normalizeRentalPricing(d.attributes.rentalPricing).rentalMode;
      const effective=await readEffectiveFixedFeePrice(client,a.game_id,rentalMode,selected.asOf);
      if(!effective)throw conflict("当前尚未配置固定手续费价格政策");
      priceVersionId=effective.priceVersionId;priceMode="PERCENT";priceRule=effective.haffRule;priceRounding=effective.roundingPolicy;commissionRate=effective.commissionRate;
      pricingPolicy={schema:"pricing-policy-v1",pricingModel:"FIXED_FEE",scheduleId:effective.scheduleId,generation:effective.generation,effectiveAt:effective.effectiveAt,priceVersionId:effective.priceVersionId};
    }else if(selected?.model==="SPREAD"){
      const effective=await readEffectiveSpreadPrice(client,a.game_id,selected.asOf);
      if(!effective)throw conflict("当前价差政策无法核实");
      priceVersionId=effective.priceVersionId;priceMode="SPREAD";priceRule=effective.haffRule;priceRounding=effective.roundingPolicy;commissionRate=null;
      pricingPolicy={schema:"pricing-policy-v1",pricingModel:"SPREAD",scheduleId:effective.scheduleId,generation:effective.generation,effectiveAt:effective.effectiveAt,priceVersionId:effective.priceVersionId};
    }else if(selected?.model==="LEGACY_SPREAD"||selected?.model==="LEGACY_PERCENT"){
      const expected=selected.model==="LEGACY_SPREAD"?"SPREAD":"PERCENT";
      if(release.mode!==expected)throw conflict("原账号的抽成模式与当前规则不一致，请联系客服");
    }
  }
  const term = (
    await client.query(
      `SELECT code,daily_consumption::text AS "dailyConsumption",duration_rounding AS "durationRounding" FROM zzsh_supply.term_option WHERE version_id=$1 AND code=$2`,
      [release.term_version_id, d.termOptionCode],
    )
  ).rows[0];
  if (!term) throw invalid("请选择当前租期选项", "termOptionCode");
  validateDeltaRentalTerm(d.attributes.rentalPricing == null ? undefined : normalizeRentalPricing(d.attributes.rentalPricing), term, d.termOptionCode);
  const rows = (
    await client.query(
      `SELECT l.item_id AS "itemId", i.code, l.quantity::text,i.unit,i.name,i.enabled,i.quantity_scale AS "quantityScale",p.pricing_kind AS "pricingKind",p.unit_quantity::text AS "unitQuantity",p.buyer_unit_amount::text AS "buyerUnitAmount",p.owner_unit_amount::text AS "ownerUnitAmount" FROM zzsh_supply.inventory_line l JOIN zzsh_supply.billable_item i ON i.id=l.item_id LEFT JOIN zzsh_supply.price_line p ON p.item_id=i.id AND p.price_version_id=$2 AND p.customer_tier='STANDARD' WHERE l.version_id=$1 ORDER BY l.item_id`,
      [v.id, priceVersionId],
    )
  ).rows;
  if (!rows.length || rows.some((r) => !r.enabled || !r.pricingKind))
    throw invalid("申报物品不在当前可用价目中", "inventory");
  for (const row of rows) assertDeltaResourceUnit(row.code, row.unit);
  const ents = (
    await client.query(
      `SELECT e.id AS "entitlementId",e.expiry_kind AS "expiryKind",e.value_kind,e.name,e.enabled,l.value,l.expiry_knowledge,CASE WHEN l.expires_at IS NULL THEN NULL ELSE to_char(l.expires_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') END AS "expiresAt" FROM zzsh_supply.listing_entitlement l JOIN zzsh_supply.entitlement e ON e.id=l.entitlement_id WHERE version_id=$1`,
      [v.id],
    )
  ).rows;
  if (
    ents.some(
      (e) =>
        !e.enabled ||
        (e.value_kind === "FLAG"
          ? typeof e.value !== "boolean"
          : !Number.isSafeInteger(e.value) || e.value < 0),
    )
  )
    throw invalid("权益值与目录类型不符", "entitlements");
  const skins = (
    await client.query(
      `SELECT s.id,s.name,s.base_name,NULL::text AS category_id,NULL::text AS category_code,NULL::text AS category_name,s.enabled,s.form_visible,true AS category_visible,true AS category_retired,
        ${publicSkinOwnerNameSql("s")} AS owner_name,
        s.owner_kind,s.rarity_code,${publicSkinRarityNameSql("s")} AS rarity_name,${publicSkinMetadataSql("s")},
        ${publicSkinMediaIdSql("s")} AS media_id
        FROM zzsh_supply.listing_skin l JOIN zzsh_supply.skin s ON s.id=l.skin_id JOIN zzsh_supply.game g ON g.id=s.game_id WHERE version_id=$1`,
      [v.id],
    )
  ).rows;
  if (skins.some((s) => !s.enabled || !s.form_visible || !s.category_visible))
    throw invalid("皮肤已停止申报", "skins");
  if (
    ents.some((e) => e.expiryKind === "TIMED" && e.expiry_knowledge !== "KNOWN")
  )
    throw invalid("请先确认限时权益的到期时间", "entitlements");
  const attrs = d.attributes;
  const vitality = attrs.vit_level ?? attrs.vitLevel;
  const bear = attrs.bear_level ?? attrs.bearLevel;
  const depositDeclaration = validateOwnerDepositDeclaration(attrs.owner_deposit_declaration);
  const fundingPolicy = depositDeclaration ? await readFundingPolicyForRelease(client, release.id) : null;
  // Pricing keeps deposits null unless both sides are configured; the owner's
  // sealed declaration is what the renter sees as the base deposit.
  const deposits = fundingPolicy && depositDeclaration
    ? {
        tenantDepositCents: depositDeclaration.amountCents,
        publisherBailRequirementCents: fundingPolicy.guaranteeRequirement.mode === "NOT_REQUIRED" ? "0" : fundingPolicy.guaranteeRequirement.requiredCents,
      }
    : undefined;
  const normalInput = {
    customerTier: "STANDARD",
    priceVersionId,
    mode: priceMode,
    roundingPolicy: priceRounding,
    ...(commissionRate === null
      ? {}
      : { commissionRate }),
    ...(pricingPolicy?.pricingModel==="FIXED_FEE"?{fixedFeeAlgorithm:FIXED_FEE_ALGORITHM}:{}),
    haffRule: priceRule,
    lines: rows.map((r) => ({
      customerTier: "STANDARD",
      itemId: r.itemId,
      quantity: r.quantity,
      unit: r.unit,
      pricingKind: r.pricingKind,
      ...(r.unitQuantity === null ? {} : { unitQuantity: r.unitQuantity }),
      ...(r.buyerUnitAmount === null
        ? {}
        : { buyerUnitAmount: r.buyerUnitAmount }),
      ...(r.ownerUnitAmount === null
        ? {}
        : { ownerUnitAmount: r.ownerUnitAmount }),
    })),
    conditions: {
      safeBoxCode: String(attrs.safe_box_code ?? ""),
      vitLevel: typeof vitality === "number" ? vitality : undefined,
      bearLevel: typeof bear === "number" ? bear : undefined,
      termOptionCode: d.termOptionCode,
      pricingOptionCode: d.pricingOptionCode,
      ...(attrs.rentalPricing === undefined ? {} : { rentalPricing: normalizeRentalPricing(attrs.rentalPricing) }),
    },
    termOption: term,
    entitlements: ents.map((e) => ({
      entitlementId: e.entitlementId,
      expiryKind: e.expiryKind,
      ...(e.expiresAt ? { expiresAt: e.expiresAt } : {}),
    })),
    ...(deposits ? { deposits } : {}),
  } as QuoteInput;
  let policyCanonical: string | undefined;
  let result: ReturnType<typeof computeDeltaQuote>;
  if (legacyQuote) {
    const marker = attrs.legacy_published_reference;
    const reference = typeof marker === "string" ? await readLegacyPublishedReference(client, a.id, marker) : null;
    if (!deposits || legacyGrading?.kind !== "VERIFIED_LEGACY_TAKEOVER" || legacyGrading.accountId !== a.id
      || legacyGrading.sourceDigest !== legacyQuote.source.sourceDigest || legacyGrading.observationVersionId !== legacyQuote.source.observationVersionId
      || !reference || reference.legacyId !== legacyQuote.source.legacyId || reference.sourceDigest !== legacyQuote.source.sourceDigest
      || reference.observationVersionId !== legacyQuote.source.observationVersionId) throw conflict("LEGACY_QUOTE_SOURCE_BINDING_MISMATCH");
    const { buildLegacyListedSourceQuote } = await import("./legacy-listed-source-quote");
    const frozen = buildLegacyListedSourceQuote({ ...legacyQuote, catalog: rows.map(r => ({ id:r.itemId, code:r.code, unit:r.unit, quantityScale:r.quantityScale })),
      declaredInventory:d.inventory.map(item => ({ itemId:item.itemId, quantity:item.quantity! })), termOption:term,
      priceVersionId:release.price_version_id, ruleReleaseId:release.id, publisherBailRequirementCents:deposits.publisherBailRequirementCents,
      expiryDisclosures:ents.map(e => ({ entitlementId:e.entitlementId, expiresAt:e.expiryKind === "TIMED" ? e.expiresAt : null, fullTermGuaranteed:false })) });
    policyCanonical = frozen.policyCanonical; result = { quotable:true, quote:frozen.quote };
  } else result = computeDeltaQuote(normalInput);
  if (!result.quotable)
    throw invalid(
      `当前条件无法报价：${result.reasonCodes.join(",")}`,
      "attributes",
    );
  result.quote.ruleReleaseId = release.id;
  const payload = normalizeContentPayload({
    schemaVersion: result.quote.schemaVersion,
    accountId: a.id,
    gameId: a.game_id,
    declaration: d,
    ruleRefs: {
      releaseId: release.id,
      catalogRevision: release.catalogRevision,
      priceVersionId: release.price_version_id,
      termVersionId: release.term_version_id,
      agreementVersionId: release.agreement_version_id,
      agreementDigest: release.digest,
    },
    quoteValues: result.quote as unknown as Record<string, unknown>,
    ...(pricingPolicy && (result.quote.schemaVersion===2||result.quote.schemaVersion===4)?{pricingPolicy}:{}),
    ...(result.quote.schemaVersion === 3 ? { quoteSource:"LEGACY_QUOTED" as const, legacyQuote:result.quote.legacyQuote } : {}),
  });
  if (legacyQuote && policyCanonical && result.quote.schemaVersion === 3) {
    const policyDigest = result.quote.legacyQuote!.sourcePolicyDigest, quoteCanonical = canonicalize(result.quote);
    await client.query(`INSERT INTO zzsh_supply.legacy_listed_policy_evidence(policy_digest,policy_canonical,policy,created_by_admin_id) VALUES($1,$2::text,$2::text::jsonb,$3) ON CONFLICT(policy_digest) DO NOTHING`, [policyDigest,policyCanonical,legacyQuote.actorId]);
    const policy = (await client.query(`SELECT 1 FROM zzsh_supply.legacy_listed_policy_evidence WHERE policy_digest=$1 AND policy_canonical=$2`,[policyDigest,policyCanonical])).rowCount;
    if (!policy) throw conflict("LEGACY_POLICY_EVIDENCE_MISMATCH");
    await client.query(`INSERT INTO zzsh_supply.legacy_listed_quote_evidence(listing_version_id,account_id,policy_digest,quote_digest,quote_canonical,quote,created_by_admin_id) VALUES($1,$2,$3,$4,$5::text,$5::text::jsonb,$6) ON CONFLICT(listing_version_id) DO NOTHING`,
      [v.id,a.id,policyDigest,sha256Hex(quoteCanonical),quoteCanonical,legacyQuote.actorId]);
    const quoteEvidence = (await client.query(`SELECT 1 FROM zzsh_supply.legacy_listed_quote_evidence WHERE listing_version_id=$1 AND account_id=$2 AND policy_digest=$3 AND quote_canonical=$4`,[v.id,a.id,policyDigest,quoteCanonical])).rowCount;
    if (!quoteEvidence) throw conflict("LEGACY_QUOTE_EVIDENCE_MISMATCH");
  }
  await client.query(
    `UPDATE zzsh_supply.listing_version SET payload=$2,content_hash=$3,rule_release_id=$4,presentation=$5,schema_version=$6,revision=revision+1 WHERE id=$1`,
    [
      v.id,
      payload,
      computeContentHash(payload),
      release.id,
      {
        items: rows.map((r) => ({ id: r.itemId, code: r.code, name: r.name, unit: r.unit })),
        skins: skins.map(freezePresentationSkin),
        entitlements: ents.map((e) => ({ id: e.entitlementId, name: e.name })),
      },
      result.quote.schemaVersion,
    ],
  );
  await bumpAccount(client, a);
}

/**
 * Skin entry of a new quote/presentation snapshot. Owner type and official
 * quality are frozen when the snapshot is generated (null = not known then).
 * Readers never re-derive them from today's catalog, so snapshots written
 * before these fields existed keep the keys absent.
 */
export function freezePresentationSkin(s: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(s.category_retired === true ? { categoryModel: "RETIRED" } : {}),
    id: s.id,
    name: s.name,
    baseName: s.base_name,
    ownerName: s.owner_name,
    ownerKind: s.owner_kind ?? null,
    rarityCode: s.rarity_code ?? null,
    rarityName: s.rarity_name ?? null,
    rarityBasis: s.rarityBasis ?? null,
    isCollectible: s.isCollectible ?? null,
    defaultState: s.defaultState ?? "UNKNOWN",
    mediaKind: s.mediaKind ?? null,
    mediaId: s.media_id,
    categoryCode: s.category_code,
    categoryName: s.category_name,
  };
}

/** 上架选项的规则/协议/租期/费率读取。调用方先完成游戏服务与账号归属校验，事务仍由调用方持有。 */
export async function readPublishingOptions(client: PoolClient, gameId: string, viewer?: { accountId: string; ownerUserId: string }) {
      const release=(await client.query<IncomePreviewRelease&{agreement_id:string;title:string;body:string;digest:string;body_document:unknown}>(
        `SELECT r.id AS "releaseId",r.generation::text AS generation,r.price_version_id AS "priceVersionId",r.term_version_id AS "termVersionId",
          g.catalog_revision::text AS "catalogRevision",p.mode,p.commission_rate::text AS "commissionRate",p.rounding_policy AS "roundingPolicy",
          p.status AS "priceStatus",p.haff_rule AS "haffRule",ag.id AS agreement_id,ag.title,ag.body,ag.digest,to_jsonb(ag)->'body_document' AS body_document
         FROM zzsh_supply.game g JOIN zzsh_supply.rule_release r ON r.id=${effectiveRuleRelease("g")} JOIN zzsh_supply.price_version p ON p.id=r.price_version_id
         JOIN zzsh_supply.agreement_version ag ON ag.id=r.agreement_version_id WHERE g.id=$1 AND g.enabled`,[gameId])).rows[0];
      if(!release)throw notFound();
      const bodyDocument = await verifyTradeTermsBody(release.body, release.digest, release.body_document);
      const asOf=(await client.query<{at:string}>(`SELECT to_char(transaction_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0]?.at;
      if(!asOf)throw new SecurityApiError(503,API_V1_ERROR_CODES.INTERNAL_ERROR,"上架规则暂不可用");
      const resolved=await resolveIncomePreviewRelease(client,gameId,release,{asOf,...(viewer??{})});
      if(!resolved.available)throw new SecurityApiError(503,API_V1_ERROR_CODES.INTERNAL_ERROR,"上架计价规则暂不可用");
      const terms=(await client.query(`SELECT code,name,daily_consumption::text AS "dailyConsumption",duration_rounding AS "durationRounding" FROM zzsh_supply.term_option WHERE version_id=$1 ORDER BY code`,[release.termVersionId])).rows;
      let fixedFeeRates:ReturnType<typeof parseFixedFeeRates>|undefined;
      if(resolved.release.pricingPolicy?.pricingModel==="FIXED_FEE"){
        const row=(await client.query<{rates:unknown}>(`SELECT fixed_fee_rates AS rates FROM zzsh_supply.price_version WHERE id=$1 AND game_id=$2 AND status='SEALED'`,[resolved.release.priceVersionId,gameId])).rows[0];
        try{fixedFeeRates=parseFixedFeeRates(row?.rates);}catch{throw new SecurityApiError(503,API_V1_ERROR_CODES.INTERNAL_ERROR,"手续费率暂不可用");}
      }
      return {release,terms,rule:resolved.release.haffRule,pricingPolicy:resolved.release.pricingPolicy,fixedFeeRates,bodyDocument};
}
