import type { PoolClient } from "pg";
import type { UserContext } from "../auth/user-identity";
import { normalizeTime } from "./content-hash";
import { DELTA_PUBLISH_LEVELS, assertDeltaResourceUnit, calculateDeltaTermSeconds, isRetiredDeltaInsurance, normalizeDeltaAttributes, normalizeRentalPricing, resolveDeltaHaffContext, type RentalPricingSelection } from "./delta-rental";
import { formatDecimalExact, parseNonNegativeDecimal, yuanAmountObject } from "./decimal";
import { readFundingPolicyForRelease } from "./funding-authority";
import { validateOwnerDepositAmount, validateOwnerDepositDeclaration, type OwnerDepositDeclaration } from "./funding-policy";
import { computeDeltaQuote, projectDeltaQuote, type QuoteAmount, type QuoteInput } from "./pricing";
import { parseIncomePreviewInventory, projectResourceIncomePreview, readIncomePreviewContext, readPublishingAccount, type IncomePreviewItem } from "./publishing";
import { ensureOnlyFields, invalid, notFound } from "./supply-util";

export const OWNER_INCOME_PREVIEW_MAX_BYTES = 64 * 1024;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type PreviewEntitlement = { entitlementId: string; value: boolean | number | string | null; expiresAt: string | null; expiryKnowledge: "KNOWN" | "UNKNOWN" };
export type OwnerIncomePreviewInput = {
  releaseId: string; catalogRevision: string; accountId?: string;
  attributes: {
    safe_box_code?: string | null; vit_level?: number | null; bear_level?: number | null;
    rentalPricing?: RentalPricingSelection | null;
    owner_deposit_declaration?: OwnerDepositDeclaration | null;
    full_payout_declaration?: { schema: "full-payout-declaration-v1"; selected: boolean } | null;
  };
  termOptionCode: string | null; pricingOptionCode?: string | null;
  inventory: Array<{ itemId: string; quantity: string | null }>;
  entitlements: PreviewEntitlement[];
};
type PreviewLine = {
  itemId: string; code: string; name: string; quantity: string | null; unit: IncomePreviewItem["unit"]; unitQuantity: string | null;
  ownerUnitAmount: { currency: "CNY"; unit: "yuan"; amount: string; scale: number } | null; ownerAmount: QuoteAmount | null;
};
export type OwnerIncomePreview = {
  schema: "owner-income-preview.v1"; state: "READY" | "PARTIAL" | "INCOMPLETE" | "UNAVAILABLE";
  binding: { gameId: string; releaseId: string; releaseGeneration: string; priceVersionId: string; termVersionId: string; catalogRevision: string } | null;
  evaluatedAt: string; refreshAfter: string; rentalMode: RentalPricingSelection["rentalMode"] | null;
  ownerHaffRatioWanPerYuan: string | null; termSeconds: string | null; lines: PreviewLine[];
  ownerHaffIncome: QuoteAmount | null; ownerResourceIncome: QuoteAmount | null; knownResourceSubtotal: QuoteAmount | null; totalExpectedIncome: QuoteAmount | null;
  baseTenantDeposit: QuoteAmount | null; depositState: "KNOWN" | "INCOMPLETE" | "UNAVAILABLE";
  missingFields: string[]; reasonCodes: string[]; unitAmountsInformational: boolean;
  estimateOnly: true; incomeBasis: "OWNER_RESOURCE_INCOME_BEFORE_FEES";
};

function record(value: unknown, allowed: readonly string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalid("预览字段格式错误", field);
  ensureOnlyFields(value as Record<string, unknown>, allowed);
  return value as Record<string, unknown>;
}
function id(value: unknown, field: string): string {
  if (typeof value !== "string" || !ID.test(value)) throw invalid("预览身份或选项格式错误", field);
  return value;
}

export function parseOwnerIncomePreviewInput(value: unknown): OwnerIncomePreviewInput {
  let bytes: number;
  try { bytes = Buffer.byteLength(JSON.stringify(value), "utf8"); } catch { throw invalid("预览内容格式错误"); }
  if (bytes > OWNER_INCOME_PREVIEW_MAX_BYTES) throw invalid("预览内容过大");
  const body = record(value, ["releaseId", "catalogRevision", "accountId", "attributes", "termOptionCode", "pricingOptionCode", "inventory", "entitlements"], "body");
  const releaseId = id(body.releaseId, "releaseId");
  if (typeof body.catalogRevision !== "string" || !/^(0|[1-9]\d{0,23})$/.test(body.catalogRevision)) throw invalid("目录版本错误", "catalogRevision");
  const raw = record(body.attributes, ["safe_box_code", "vit_level", "bear_level", "rentalPricing", "owner_deposit_declaration", "full_payout_declaration"], "attributes");
  const attributes: OwnerIncomePreviewInput["attributes"] = {};
  if (raw.safe_box_code != null) attributes.safe_box_code = id(raw.safe_box_code, "attributes.safe_box_code");
  for (const field of ["vit_level", "bear_level"] as const) {
    if (raw[field] != null) {
      if (!(DELTA_PUBLISH_LEVELS as readonly unknown[]).includes(raw[field])) throw invalid("等级须为4至7的整数", `attributes.${field}`);
      attributes[field] = raw[field] as number;
    }
  }
  if (raw.rentalPricing != null) {
    const selection = record(raw.rentalPricing, ["rentalMode", "ownerRatioB"], "attributes.rentalPricing");
    if (typeof selection.rentalMode !== "string" || !["ordinary", "custom", "fast"].includes(selection.rentalMode)) throw invalid("请选择有效租赁方式", "attributes.rentalPricing");
    // An unfinished custom ratio is missing input, not an invented default.
    attributes.rentalPricing = selection.rentalMode !== "ordinary" && selection.ownerRatioB === undefined
      ? { rentalMode: selection.rentalMode as "custom" | "fast" }
      : normalizeRentalPricing(selection);
  }
  if (raw.owner_deposit_declaration != null) attributes.owner_deposit_declaration = validateOwnerDepositDeclaration(raw.owner_deposit_declaration);
  if (raw.full_payout_declaration != null) {
    try { attributes.full_payout_declaration = normalizeDeltaAttributes({ full_payout_declaration: raw.full_payout_declaration }).full_payout_declaration as NonNullable<OwnerIncomePreviewInput["attributes"]["full_payout_declaration"]>; }
    catch { throw invalid("包赔声明格式错误", "attributes.full_payout_declaration"); }
  }
  const quantities = parseIncomePreviewInventory(body.inventory);
  if (!Array.isArray(body.entitlements) || body.entitlements.length > 100) throw invalid("权益格式错误", "entitlements");
  const seen = new Set<string>();
  const entitlements = body.entitlements.map(value => {
    const row = record(value, ["entitlementId", "value", "expiresAt", "expiryKnowledge"], "entitlements"), entitlementId = id(row.entitlementId, "entitlements.entitlementId");
    if (seen.has(entitlementId)) throw invalid("权益重复", "entitlements");
    seen.add(entitlementId);
    if (typeof row.expiryKnowledge !== "string" || !["KNOWN", "UNKNOWN"].includes(row.expiryKnowledge)) throw invalid("权益期限状态错误", "entitlements.expiryKnowledge");
    if (row.value !== null && typeof row.value !== "boolean" && typeof row.value !== "string" && !(Number.isSafeInteger(row.value) && Number(row.value) >= 0)) throw invalid("权益值格式错误", "entitlements.value");
    if (typeof row.value === "string" && row.value.length > 33) throw invalid("权益值格式错误", "entitlements.value");
    let expiresAt: string | null;
    try { expiresAt = row.expiresAt == null ? null : normalizeTime(row.expiresAt as string); }
    catch { throw invalid("权益到期时间错误", "entitlements.expiresAt"); }
    return { entitlementId, value: row.value as PreviewEntitlement["value"], expiresAt, expiryKnowledge: row.expiryKnowledge as PreviewEntitlement["expiryKnowledge"] };
  });
  return { releaseId, catalogRevision: body.catalogRevision, ...(body.accountId === undefined ? {} : { accountId: id(body.accountId, "accountId") }), attributes,
    termOptionCode: body.termOptionCode == null ? null : id(body.termOptionCode, "termOptionCode"),
    ...(body.pricingOptionCode == null ? {} : { pricingOptionCode: id(body.pricingOptionCode, "pricingOptionCode") }),
    inventory: [...quantities].map(([itemId, quantity]) => ({ itemId, quantity })), entitlements };
}

function sumKnown(amounts: Array<QuoteAmount | null>): QuoteAmount | null {
  const known = amounts.filter((amount): amount is QuoteAmount => amount !== null);
  return known.length ? yuanAmountObject(known.reduce((sum, amount) => sum + parseNonNegativeDecimal(amount.amount, 2, "owner income").value, 0n)) : null;
}

/** Called only inside the owner's authenticated RR READ ONLY snapshot. */
export async function readOwnerIncomePreview(client: PoolClient, context: UserContext, gameId: string, input: OwnerIncomePreviewInput): Promise<OwnerIncomePreview> {
  if (input.accountId) {
    const account = await readPublishingAccount(client, input.accountId);
    if (account.owner_user_id !== context.userId || account.game_id !== gameId) throw notFound();
  }
  const evaluatedAt = (await client.query<{ evaluatedAt: string }>(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "evaluatedAt"`)).rows[0]!.evaluatedAt;
  const response: OwnerIncomePreview = {
    schema: "owner-income-preview.v1", state: "UNAVAILABLE", binding: null, evaluatedAt, refreshAfter: new Date(Date.parse(evaluatedAt) + 30_000).toISOString(),
    rentalMode: input.attributes.rentalPricing?.rentalMode ?? null, ownerHaffRatioWanPerYuan: null, termSeconds: null, lines: [], ownerHaffIncome: null,
    ownerResourceIncome: null, knownResourceSubtotal: null, totalExpectedIncome: null, baseTenantDeposit: null, depositState: "INCOMPLETE",
    missingFields: [], reasonCodes: [], unitAmountsInformational: true, estimateOnly: true, incomeBasis: "OWNER_RESOURCE_INCOME_BEFORE_FEES",
  };
  const pricing = await readIncomePreviewContext(client, gameId, input, true);
  if (!pricing.available) return { ...response, reasonCodes: [pricing.reason] };
  const { release, items, commission } = pricing;
  response.binding = { gameId, releaseId: release.releaseId, releaseGeneration: release.generation, priceVersionId: release.priceVersionId, termVersionId: release.termVersionId, catalogRevision: release.catalogRevision };
  if (release.priceStatus !== "SEALED") return { ...response, reasonCodes: ["RULE_UNCONFIGURED"] };
  const quantities = new Map(input.inventory.map(row => [row.itemId, row.quantity])), selected = items.filter(row => quantities.has(row.itemId) || (row.enabled && row.required));
  if ([...quantities.keys()].some(itemId => !items.some(item => item.itemId === itemId))) throw invalid("库存物品不属于当前游戏", "inventory");
  for (const row of selected) {
    assertDeltaResourceUnit(row.code, row.unit);
    if (!row.enabled || isRetiredDeltaInsurance(row.code)) throw invalid("物品已停止申报", "inventory");
  }
  const missing = response.missingFields, reasons = new Set<string>();
  for (const field of ["safe_box_code", "vit_level", "bear_level"] as const) if (input.attributes[field] == null) missing.push(`attributes.${field}`);
  if (release.haffRule?.schema === "haff-ratio-v2") {
    if (!input.attributes.rentalPricing) missing.push("attributes.rentalPricing");
    else if (input.attributes.rentalPricing.rentalMode !== "ordinary" && input.attributes.rentalPricing.ownerRatioB === undefined) missing.push("attributes.rentalPricing.ownerRatioB");
    if (input.pricingOptionCode) throw invalid("当前租赁方式不能混入旧计价选项", "pricingOptionCode");
  } else if (!input.pricingOptionCode) missing.push("pricingOptionCode");
  if (!input.termOptionCode) missing.push("termOptionCode");
  for (const row of selected) if (quantities.get(row.itemId) == null) missing.push(`inventory.${row.itemId}.quantity`);
  if (!selected.some(row => row.unit === "HAFF_BASE")) missing.push("inventory.HAFF_BASE.quantity");
  type Term = QuoteInput["termOption"];
  const term = input.termOptionCode ? (await client.query<Term>(`SELECT code,daily_consumption::text AS "dailyConsumption",duration_rounding AS "durationRounding" FROM zzsh_supply.term_option WHERE version_id=$1 AND code=$2`, [release.termVersionId, input.termOptionCode])).rows[0] : undefined;
  if (input.termOptionCode && !term) throw invalid("请选择当前租期选项", "termOptionCode");
  const knownEntitlements: NonNullable<QuoteInput["entitlements"]>[number][] = [];
  if (input.entitlements.length) {
    const entries = (await client.query<{ entitlementId: string; expiryKind: "TIMED" | "PERMANENT"; valueKind: "FLAG" | "LEVEL" | "CAPACITY"; enabled: boolean }>(`SELECT id AS "entitlementId",expiry_kind AS "expiryKind",value_kind AS "valueKind",enabled FROM zzsh_supply.entitlement WHERE game_id=$1 AND id=ANY($2::text[])`, [gameId, input.entitlements.map(row => row.entitlementId)])).rows;
    for (const value of input.entitlements) {
      const entry = entries.find(row => row.entitlementId === value.entitlementId);
      if (!entry || !entry.enabled) throw invalid("权益不属于当前可用目录", "entitlements");
      if (value.value !== null && (entry.valueKind === "FLAG" ? typeof value.value !== "boolean" : !Number.isSafeInteger(value.value) || Number(value.value) < 0)) throw invalid("权益值与目录类型不符", "entitlements.value");
      if (value.value === null) missing.push(`entitlements.${value.entitlementId}.value`);
      if (entry.expiryKind === "TIMED" && (value.expiryKnowledge !== "KNOWN" || !value.expiresAt)) missing.push(`entitlements.${value.entitlementId}.expiresAt`);
      else knownEntitlements.push({ entitlementId: value.entitlementId, expiryKind: entry.expiryKind, ...(value.expiresAt ? { expiresAt: value.expiresAt } : {}) });
    }
  }
  const fixedItems = items.filter(row => row.unit !== "HAFF_BASE"), fixedQuantities = new Map([...quantities].filter(([itemId]) => fixedItems.some(row => row.itemId === itemId)));
  const fixed = projectResourceIncomePreview(fixedItems, fixedQuantities, release, commission);
  if (fixed.unpricedItemIds.length) reasons.add("RESOURCE_PRICE_UNAVAILABLE");
  const quoteLines = selected.filter(row => quantities.get(row.itemId) != null && row.pricingKind !== null && !fixed.unpricedItemIds.includes(row.itemId)).map(row => ({
    itemId: row.itemId, quantity: quantities.get(row.itemId)!, unit: row.unit, pricingKind: row.pricingKind!, customerTier: "STANDARD" as const,
    ...(row.unitQuantity === null ? {} : { unitQuantity: row.unitQuantity }), ...(row.buyerUnitAmount === null ? {} : { buyerUnitAmount: row.buyerUnitAmount }), ...(row.ownerUnitAmount === null ? {} : { ownerUnitAmount: row.ownerUnitAmount }),
  }));
  if (selected.some(row => row.pricingKind === null)) reasons.add("RESOURCE_PRICE_UNAVAILABLE");
  const conditions: QuoteInput["conditions"] = { safeBoxCode: input.attributes.safe_box_code ?? undefined, vitLevel: input.attributes.vit_level ?? undefined, bearLevel: input.attributes.bear_level ?? undefined, termOptionCode: input.termOptionCode ?? undefined, pricingOptionCode: input.pricingOptionCode ?? undefined, rentalPricing: input.attributes.rentalPricing ?? undefined };
  const haff = resolveDeltaHaffContext({ mode: release.mode, haffRule: release.haffRule, hasHaffLines: selected.some(row => row.pricingKind === "HAFF_RATIO"), conditions, customerTier: "STANDARD" });
  if (!haff.reasonCodes.length && haff.ownerDenominator) response.ownerHaffRatioWanPerYuan = formatDecimalExact(haff.ownerDenominator);
  const quoted = term ? computeDeltaQuote({ priceVersionId: release.priceVersionId, customerTier: "STANDARD", mode: release.mode, roundingPolicy: release.roundingPolicy, ...(release.commissionRate === null ? {} : { commissionRate: release.commissionRate }), haffRule: release.haffRule, conditions, lines: quoteLines, termOption: term, entitlements: knownEntitlements }) : null;
  if (quoted && !quoted.quotable) for (const reason of quoted.reasonCodes) reasons.add(reason);
  const owner = quoted?.quotable ? projectDeltaQuote(quoted.quote, "owner") : null;
  response.lines = selected.map(item => {
    const priced = owner?.lines.find(row => row.itemId === item.itemId) ?? fixed.lines.find(row => row.itemId === item.itemId);
    return { itemId: item.itemId, code: item.code, name: item.name, quantity: quantities.get(item.itemId) ?? null, unit: item.unit,
      unitQuantity: priced?.unitQuantity ?? null, ownerUnitAmount: priced?.ownerUnitAmount ?? null, ownerAmount: priced?.ownerAmount ?? null };
  });
  const itemLines = response.lines.filter(row => row.unit !== "HAFF_BASE"), haffLines = response.lines.filter(row => row.unit === "HAFF_BASE");
  response.knownResourceSubtotal = sumKnown(itemLines.map(row => row.ownerAmount));
  response.ownerResourceIncome = itemLines.every(row => row.ownerAmount !== null) ? response.knownResourceSubtotal ?? (owner ? yuanAmountObject(0n) : null) : null;
  response.ownerHaffIncome = haffLines.length && haffLines.every(row => row.ownerAmount !== null) ? sumKnown(haffLines.map(row => row.ownerAmount)) : null;
  if (term && haffLines.length && haffLines.every(row => row.quantity !== null)) response.termSeconds = calculateDeltaTermSeconds(haffLines.reduce((sum, row) => sum + BigInt(row.quantity!), 0n), term).termSeconds;
  response.state = owner && missing.length === 0 && reasons.size === 0 ? "READY" : response.lines.some(row => row.ownerAmount !== null) ? "PARTIAL" : missing.length ? "INCOMPLETE" : "UNAVAILABLE";
  response.totalExpectedIncome = response.state === "READY" ? owner!.ownerTotal! : null;
  const deposit = input.attributes.owner_deposit_declaration, fullPayout = input.attributes.full_payout_declaration;
  if (deposit && fullPayout) {
    const policy = await readFundingPolicyForRelease(client, release.releaseId);
    response.depositState = "UNAVAILABLE";
    if (policy) {
      validateOwnerDepositAmount(policy, deposit.amountCents, fullPayout.selected);
      response.baseTenantDeposit = yuanAmountObject(BigInt(deposit.amountCents)); response.depositState = "KNOWN";
    }
  }
  response.reasonCodes = [...reasons].sort();
  return response;
}
