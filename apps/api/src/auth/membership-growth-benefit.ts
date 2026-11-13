/** 权益合同与重叠判断。从 membership-growth 原样移出，判定不变。 */
import { decimalToBigInt, formatDecimalExact, parseNonNegativeDecimal, subtractDecimal } from "../supply/decimal";
import { DELTA_HAFF_FIXED_SCHEMA, validateDeltaHaffRule } from "../supply/delta-rental";
import { fixedFeeAllowsPayableRatio, parseFixedFeeRates, type FixedFeeRates } from "../supply/fixed-fee";
import { fail, GROWTH_WINDOW_US, MEMBERSHIP_GROWTH_SCHEMA, parseDepositAllowanceCents, parseInstant } from "./membership-growth-money";
import { NORMAL_GROWTH_TIERS, type GrowthTier, type NormalGrowthTier, type RentalMode } from "./membership-growth-replay";

export type NotPricedParameter = { status: "NOT_PRICED"; reason: string };
export type HaffPricingParameter = NotPricedParameter | {
  status: "CONFIGURED";
  kind: "HAFF_RATIO";
  schema: "haff-ratio-v1" | "haff-ratio-v2";
  priceVersionId: string;
  costBasisRef: string;
  baseBySafeBox: Record<string, string>;
  spreadDelta?: string;
};
export type MaterialPricingParameter = NotPricedParameter | {
  status: "CONFIGURED";
  kind: "FIXED_UNIT";
  itemId: string;
  unit: "ROUND" | "PIECE" | "DAY";
  unitQuantity: string;
  buyerUnitAmount: string;
  ownerUnitAmount: string;
  priceVersionId: string;
  costBasisRef: string;
};
export type GrowthPricingContract = {
  mode: RentalMode;
  priceVersionId: string;
  haff: HaffPricingParameter;
  materials: Record<string, MaterialPricingParameter>;
};
/**
 * Owner rule (2026-10-19): a member/entitlement benefit discounts the combined base total of
 * haff rent + item resource fees once, expressed as a payable share (e.g. "0.9" pays 90%).
 * It never rewrites the base haff rule or per-item unit prices.
 */
type TotalDiscountTerms = {
  status: "CONFIGURED";
  kind: "TOTAL_DISCOUNT";
  priceVersionId: string;
  /** Payable share of the combined base total; decimal text in (0, 1]. */
  payableRatio: string;
  costBasisRef: string;
};
export type TotalDiscountContract = TotalDiscountTerms & (
  | {mode:RentalMode;scope?:never}
  | {scope:'ALL_ENABLED_RENTAL_MODES';mode?:never}
);
export type ModePricingContract = GrowthPricingContract | TotalDiscountContract | NotPricedParameter;

export type EntitlementDiscountRange = {
  status: "CONFIGURED";
  kind: "TOTAL_DISCOUNT_RANGE";
  mode: RentalMode;
  priceVersionId: string;
  minPayableRatio: string;
  maxPayableRatio: string;
  costBasisRef: string;
};
export type EntitlementRanges = Record<"FRIEND" | "PRESTIGE", { byMode: Partial<Record<RentalMode, EntitlementDiscountRange | NotPricedParameter>> }>;

export function isTotalDiscountContract(value: unknown): value is TotalDiscountContract {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).status === "CONFIGURED" && (value as Record<string, unknown>).kind === "TOTAL_DISCOUNT"
    && !(Object.hasOwn(value,'mode')&&Object.hasOwn(value,'scope')));
}
export function isUnifiedTotalDiscountContract(value:unknown):value is Extract<TotalDiscountContract,{scope:'ALL_ENABLED_RENTAL_MODES'}>{
  return isTotalDiscountContract(value)&&value.scope==='ALL_ENABLED_RENTAL_MODES'&&!Object.hasOwn(value,'mode');
}
export function isLegacyPricingContract(value: unknown): value is GrowthPricingContract {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value as Record<string, unknown>).haff !== undefined && (value as Record<string, unknown>).materials !== undefined
    && !Object.hasOwn(value,'scope') && !isTotalDiscountContract(value) && !notPriced(value));
}
/**
 * A single legacy cap only bounds its own mode. The `byMode` shape keeps one cap entry per mode so
 * FRIEND/PRESTIGE boundaries are expressible in every enabled mode without rewriting old hashes.
 */
export type EntitlementCapByMode = { byMode: Partial<Record<RentalMode, ModePricingContract>> };
export type EntitlementCap = ModePricingContract | EntitlementCapByMode;
export type TierBenefitConfig = {
  tier: NormalGrowthTier;
  tenantDeposit: "ACCOUNT_BASE" | "WAIVED";
  depositAllowanceCents?: string;
  /** A mode disabled by the bound SEALED release may omit its contract; enabled modes must be CONFIGURED to publish. */
  pricing: Partial<Record<RentalMode, ModePricingContract>>;
  entitlementCap: EntitlementCap;
};

export function isEntitlementCapByMode(cap: EntitlementCap): cap is EntitlementCapByMode {
  return Boolean(cap && typeof cap === "object" && !Array.isArray(cap) && (cap as Record<string, unknown>).byMode && typeof (cap as Record<string, unknown>).byMode === "object" && !Array.isArray((cap as Record<string, unknown>).byMode));
}

/** Resolves the cap entry for a candidate mode; legacy single contracts stay returned for every mode (pricingWithinCap rejects a mode mismatch). */
export function entitlementCapForMode(cap: EntitlementCap, mode: RentalMode): ModePricingContract | undefined {
  if (isEntitlementCapByMode(cap)) return cap.byMode[mode];
  return cap as ModePricingContract;
}

/**
 * Enabled rental modes are an authoritative property of the bound SEALED release, not of the policy.
 * haff-ratio-v1 releases only ever price ordinary rentals; null means the release shape cannot be trusted.
 */
export function sealedEnabledRentalModes(haffRule: unknown): RentalMode[] | null {
  if (haffRule === null || haffRule === undefined) return null;
  if (typeof haffRule !== "object" || Array.isArray(haffRule)) return null;
  const rule = haffRule as Record<string, unknown>;
  if (rule.schema === "haff-ratio-v1") return ["ordinary"];
  if (rule.schema === DELTA_HAFF_FIXED_SCHEMA) {
    try {
      const modes = validateDeltaHaffRule(rule, "PERCENT").fixedModes!;
      return (["ordinary", "custom", "fast"] as const).filter(mode => modes[mode].enabled);
    } catch { return null; }
  }
  if (rule.schema !== "haff-ratio-v2") return null;
  const compatibility = rule.compatibility;
  if (!compatibility || typeof compatibility !== "object" || Array.isArray(compatibility)) return null;
  const modes = (compatibility as Record<string, unknown>).modes;
  if (!modes || typeof modes !== "object" || Array.isArray(modes)) return null;
  const enabled: RentalMode[] = [];
  for (const mode of ["ordinary", "custom", "fast"] as const) {
    const config = (modes as Record<string, unknown>)[mode];
    if (config && typeof config === "object" && !Array.isArray(config) && (config as Record<string, unknown>).enabled === true) enabled.push(mode);
  }
  return enabled.length > 0 ? enabled : null;
}
export type GrowthBenefitPolicy = {
  schema: typeof MEMBERSHIP_GROWTH_SCHEMA;
  pricingScope?: 'ALL_ENABLED_RENTAL_MODES';
  version: string;
  status: "DRAFT" | "APPROVED";
  effectiveAt: string | null;
  sourceRef: string;
  tiers: Record<NormalGrowthTier, TierBenefitConfig>;
  entitlementCaps: { FRIEND: "GOLD"; PRESTIGE: "DIAMOND" };
  /** Independent manual ranges; absence preserves the immutable legacy tier-cap contract. */
  entitlementRanges?: EntitlementRanges;
};

export function entitlementRangeForMode(policy: GrowthBenefitPolicy, kind: "FRIEND" | "PRESTIGE", mode: RentalMode): EntitlementDiscountRange | NotPricedParameter | undefined {
  return policy.entitlementRanges?.[kind]?.byMode?.[mode];
}

export type PolicyValidation = { valid: boolean; publishable: boolean; errors: string[]; warnings: string[] };

function notPriced(value: unknown): value is NotPricedParameter {
  return Boolean(value && typeof value === "object" && (value as Record<string, unknown>).status === "NOT_PRICED");
}

export { notPriced as isNotPriced };

function validateNotPriced(value: NotPricedParameter, path: string, result: PolicyValidation): void {
  if (typeof value.reason !== "string" || !value.reason.trim() || value.reason.length > 300) result.errors.push(`${path}.reason`);
  result.warnings.push(`${path}.cost_basis_missing`);
}

/** Draft-visible pending value. A published policy can never carry one: every pending warning blocks publishability. */
function validatePendingValue(value: unknown, path: string, result: PolicyValidation): boolean {
  if (value !== "") return false;
  result.warnings.push(`${path}.value_pending`);
  return true;
}

const DECIMAL_8 = /^(0|[1-9]\d*)(?:\.\d{1,8})?$/;

function validateHaffPricing(value: HaffPricingParameter, path: string, result: PolicyValidation): void {
  if (!value || typeof value !== "object") { result.errors.push(path); return; }
  if (notPriced(value)) return validateNotPriced(value, path, result);
  if (value.status !== "CONFIGURED" || value.kind !== "HAFF_RATIO" || !["haff-ratio-v1", "haff-ratio-v2"].includes(value.schema)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.priceVersionId)
    || !value.baseBySafeBox || typeof value.baseBySafeBox !== "object" || Object.keys(value.baseBySafeBox).length === 0) {
    result.errors.push(path);
    return;
  }
  if (value.costBasisRef === "") result.warnings.push(`${path}.cost_basis_missing`);
  else if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/.test(value.costBasisRef)) result.errors.push(`${path}.costBasisRef`);
  for (const [safeBox, ratio] of Object.entries(value.baseBySafeBox)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/.test(safeBox)) result.errors.push(`${path}.baseBySafeBox.${safeBox}`);
    else if (!validatePendingValue(ratio, `${path}.baseBySafeBox.${safeBox}`, result) && !DECIMAL_8.test(ratio)) result.errors.push(`${path}.baseBySafeBox.${safeBox}`);
  }
  if (value.spreadDelta !== undefined && !validatePendingValue(value.spreadDelta, `${path}.spreadDelta`, result) && !DECIMAL_8.test(value.spreadDelta)) result.errors.push(`${path}.spreadDelta`);
}

function validateMaterialPricing(value: MaterialPricingParameter, path: string, result: PolicyValidation): void {
  if (!value || typeof value !== "object") { result.errors.push(path); return; }
  if (notPriced(value)) return validateNotPriced(value, path, result);
  if (value.status !== "CONFIGURED" || value.kind !== "FIXED_UNIT" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.itemId)
    || !["ROUND", "PIECE", "DAY"].includes(value.unit)
    || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.priceVersionId)) {
    result.errors.push(path);
    return;
  }
  if (value.costBasisRef === "") result.warnings.push(`${path}.cost_basis_missing`);
  else if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/.test(value.costBasisRef)) result.errors.push(`${path}.costBasisRef`);
  if (!validatePendingValue(value.unitQuantity, `${path}.unitQuantity`, result) && !/^[1-9]\d{0,23}$/.test(value.unitQuantity)) result.errors.push(`${path}.unitQuantity`);
  if (!validatePendingValue(value.buyerUnitAmount, `${path}.buyerUnitAmount`, result) && !DECIMAL_8.test(value.buyerUnitAmount)) result.errors.push(`${path}.buyerUnitAmount`);
  if (!validatePendingValue(value.ownerUnitAmount, `${path}.ownerUnitAmount`, result) && !DECIMAL_8.test(value.ownerUnitAmount)) result.errors.push(`${path}.ownerUnitAmount`);
}

function validatePricingContract(value: GrowthPricingContract | NotPricedParameter, path: string, result: PolicyValidation): void {
  if (notPriced(value)) return validateNotPriced(value, path, result);
  if (!value || Object.hasOwn(value,'scope') || !["ordinary", "custom", "fast"].includes(value.mode) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.priceVersionId) || !value.materials || typeof value.materials !== "object") {
    result.errors.push(path);
    return;
  }
  if (!value.haff || typeof value.haff !== "object") result.errors.push(`${path}.haff`);
  else validateHaffPricing(value.haff, `${path}.haff`, result);
  for (const [itemId, material] of Object.entries(value.materials)) {
    if (!material || typeof material !== "object") { result.errors.push(`${path}.materials.${itemId}`); continue; }
    if (itemId !== (notPriced(material) ? itemId : material.itemId)) result.errors.push(`${path}.materials.${itemId}.itemId`);
    validateMaterialPricing(material, `${path}.materials.${itemId}`, result);
  }
}

export type PolicyValidationContext = {
  /**
   * Authoritative enabled modes of the bound SEALED release. Omitted keeps the legacy all-modes rule.
   * A mode the release disabled is inert: its contract may be omitted or NOT_PRICED and never blocks publish.
   */
  enabledModes?: readonly RentalMode[];
  /** Bound release catalog. When present, every enabled contract must cover every catalog safe box and material. */
  catalog?: { safeBoxes?: readonly string[]; materials?: ReadonlyArray<{ itemId: string; unit?: "ROUND" | "PIECE" | "DAY" }> };
  /** Bound release quote mode. SPREAD releases price through a spread delta, so enabled contracts must carry one. */
  releaseMode?: "SPREAD" | "PERCENT";
  /** When a sealed fixed-fee policy is evaluated, all enabled mode rates must be supplied. */
  fixedFeeRates?: FixedFeeRates;
};

function validateCatalogCoverage(contract: GrowthPricingContract, path: string, context: PolicyValidationContext, result: PolicyValidation): void {
  const haff = contract.haff;
  if (haff && !notPriced(haff) && haff.baseBySafeBox && typeof haff.baseBySafeBox === "object") {
    for (const safeBox of context.catalog?.safeBoxes ?? []) if (!Object.hasOwn(haff.baseBySafeBox, safeBox)) result.warnings.push(`${path}.haff.baseBySafeBox.${safeBox}.catalog_missing`);
  }
  const materials = contract.materials;
  if (materials && typeof materials === "object") for (const material of context.catalog?.materials ?? []) {
    const entry = materials[material.itemId];
    if (!entry || notPriced(entry)) result.warnings.push(`${path}.materials.${material.itemId}.catalog_missing`);
    else if (material.unit !== undefined && entry.unit !== material.unit) result.errors.push(`${path}.materials.${material.itemId}.unit_mismatch`);
  }
}

function validateConfiguredContract(contract: GrowthPricingContract, path: string, context: PolicyValidationContext, result: PolicyValidation): void {
  validatePricingContract(contract, path, result);
  if (context.releaseMode === "SPREAD" && contract.haff && !notPriced(contract.haff) && contract.haff.spreadDelta === undefined) result.warnings.push(`${path}.haff.spreadDelta.spread_required`);
  validateCatalogCoverage(contract, path, context, result);
}

/** Payable ratio as an exact 8-decimal integer; null for pending/malformed/out-of-range values. */
function discountRatio(value: string | undefined): bigint | null {
  if (typeof value !== 'string' || value === "") return null;
  try {
    const parsed = parseNonNegativeDecimal(value, 8, "payableRatio");
    const unit = 10n ** BigInt(parsed.scale);
    return parsed.value > 0n && parsed.value <= unit ? (parsed.value * 100_000_000n) / unit : null;
  } catch { return null; }
}

/** Owner total-discount contract: combined base total × payable ratio, applied once by the quote adapter. */
function validateTotalDiscount(contract: TotalDiscountContract, path: string, result: PolicyValidation): void {
  if (contract.scope==='ALL_ENABLED_RENTAL_MODES'?Object.hasOwn(contract,'mode'):Object.hasOwn(contract,'scope')||typeof contract.mode!=='string'||!["ordinary", "custom", "fast"].includes(contract.mode)) result.errors.push(path);
  if (typeof contract.priceVersionId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(contract.priceVersionId)) result.errors.push(`${path}.priceVersionId`);
  if (contract.payableRatio === undefined || contract.payableRatio === "") result.warnings.push(`${path}.payableRatio.value_pending`);
  else if (discountRatio(contract.payableRatio) === null) result.errors.push(`${path}.payableRatio`);
  if (contract.costBasisRef === undefined || contract.costBasisRef === "") result.warnings.push(`${path}.cost_basis_missing`);
  else if (typeof contract.costBasisRef!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/.test(contract.costBasisRef)) result.errors.push(`${path}.costBasisRef`);
}

function validateEntitlementRanges(value: EntitlementRanges, enabled: ReadonlySet<RentalMode>, result: PolicyValidation): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some((key) => key !== "FRIEND" && key !== "PRESTIGE")) {
    result.errors.push("entitlementRanges"); return;
  }
  for (const kind of ["FRIEND", "PRESTIGE"] as const) {
    const byMode = value[kind]?.byMode;
    if (!byMode || typeof byMode !== "object" || Array.isArray(byMode)) { result.errors.push(`entitlementRanges.${kind}`); continue; }
    if (Object.keys(byMode).some((mode) => !["ordinary", "custom", "fast"].includes(mode))) result.errors.push(`entitlementRanges.${kind}.byMode`);
    for (const mode of enabled) {
      const range = byMode[mode], path = `entitlementRanges.${kind}.byMode.${mode}`;
      if (!range) { result.warnings.push(`${path}.unconfigured`); result.publishable = false; continue; }
      if (notPriced(range)) { validateNotPriced(range, path, result); result.publishable = false; continue; }
      if (range.status !== "CONFIGURED" || range.kind !== "TOTAL_DISCOUNT_RANGE" || range.mode !== mode) result.errors.push(path);
      validateTotalDiscount({ ...range, kind: "TOTAL_DISCOUNT", payableRatio: range.minPayableRatio }, path, result);
      const min = discountRatio(range.minPayableRatio), max = discountRatio(range.maxPayableRatio);
      if (min === null) (range.minPayableRatio===''?result.warnings:result.errors).push(`${path}.minPayableRatio${range.minPayableRatio===''?'.value_pending':''}`);
      if (max === null) (range.maxPayableRatio===''?result.warnings:result.errors).push(`${path}.maxPayableRatio${range.maxPayableRatio===''?'.value_pending':''}`);
      if (min !== null && max !== null && min > max) result.errors.push(`${path}.range`);
    }
  }
}

export type UnifiedEntitlementRangeProjection={knowledge:'KNOWN'|'UNKNOWN';minPayableRatio:string|null;maxPayableRatio:string|null;priceVersionId:string|null;costBasisRef:string|null;reasonCodes:string[]};
function validEnabledModes(modes:readonly RentalMode[]|null|undefined):modes is readonly RentalMode[]{
  return Array.isArray(modes)&&modes.length>0&&modes.length<=3&&new Set(modes).size===modes.length&&modes.every(mode=>['ordinary','custom','fast'].includes(mode));
}
/** One original range must apply identically in every real enabled path; neither union nor first-slot fallback is approval evidence. */
export function projectUniformEntitlementRange(policy:GrowthBenefitPolicy,kind:'FRIEND'|'PRESTIGE',enabledModes:readonly RentalMode[]|null|undefined):UnifiedEntitlementRangeProjection{
  const unknown=(reason:string):UnifiedEntitlementRangeProjection=>({knowledge:'UNKNOWN',minPayableRatio:null,maxPayableRatio:null,priceVersionId:null,costBasisRef:null,reasonCodes:[reason]});
  if(!validEnabledModes(enabledModes))return unknown('ENABLED_MODES_UNAVAILABLE');
  const terms:{min:bigint;max:bigint;price:string;cost:string}[]=[];
  for(const mode of enabledModes){
    let range:EntitlementDiscountRange|NotPricedParameter|undefined;
    if(policy?.entitlementRanges!==undefined)range=entitlementRangeForMode(policy,kind,mode);
    else{
      const cap=policy?.tiers?.[kind==='FRIEND'?'GOLD':'DIAMOND']?.entitlementCap,entry=cap?entitlementCapForMode(cap,mode):undefined;
      if(!entry||notPriced(entry)||!isTotalDiscountContract(entry))return unknown('LEGACY_PRICING_REQUIRES_REVIEW');
      if(entry.mode!==mode||Object.hasOwn(entry,'scope'))return unknown('UNIFIED_RANGE_UNAVAILABLE');
      range={...entry,kind:'TOTAL_DISCOUNT_RANGE',mode,minPayableRatio:entry.payableRatio,maxPayableRatio:'1'};
    }
    if(!range||notPriced(range)||range.status!=='CONFIGURED'||range.kind!=='TOTAL_DISCOUNT_RANGE'||range.mode!==mode)return unknown('UNIFIED_RANGE_UNAVAILABLE');
    const checked:PolicyValidation={valid:true,publishable:true,errors:[],warnings:[]};
    validateTotalDiscount({...range,kind:'TOTAL_DISCOUNT',payableRatio:range.minPayableRatio},'range',checked);
    const min=discountRatio(range.minPayableRatio),max=discountRatio(range.maxPayableRatio);
    if(checked.errors.length||checked.warnings.length||min===null||max===null||min>max)return unknown('UNIFIED_RANGE_UNAVAILABLE');
    terms.push({min,max,price:range.priceVersionId,cost:range.costBasisRef});
  }
  if(new Set(terms.map(t=>[t.min,t.max,t.price,t.cost].join('\u0000'))).size!==1)return unknown('LEGACY_MODE_VALUES_DIFFER');
  const term=terms[0]!;
  return{knowledge:'KNOWN',minPayableRatio:formatDecimalExact({value:term.min,scale:8}),maxPayableRatio:formatDecimalExact({value:term.max,scale:8}),priceVersionId:term.price,costBasisRef:term.cost,reasonCodes:[]};
}

export type EntitlementPricingSummary =
  | { knowledge: "KNOWN"; kind: "TOTAL_DISCOUNT"; mode: RentalMode; payableRatio: string }
  | { knowledge: "KNOWN"; kind: "TOTAL_DISCOUNT"; scope:'ALL_ENABLED_RENTAL_MODES'; payableRatio: string }
  | { knowledge: "LEGACY"; kind: "LEGACY" }
  | { knowledge: "UNKNOWN"; kind: "UNKNOWN" };

/** Public display facts only: no cost basis, policy body or owner prices leave this projection. */
export function entitlementPricingSummary(value: unknown): EntitlementPricingSummary {
  if (isTotalDiscountContract(value)) {
    const validation: PolicyValidation = { valid: true, publishable: true, errors: [], warnings: [] };
    validateTotalDiscount(value, "pricing", validation);
    if (!validation.errors.length && !validation.warnings.length) return value.scope==='ALL_ENABLED_RENTAL_MODES'
      ? {knowledge:'KNOWN',kind:'TOTAL_DISCOUNT',scope:value.scope,payableRatio:value.payableRatio}
      : { knowledge: "KNOWN", kind: "TOTAL_DISCOUNT", mode: value.mode, payableRatio: value.payableRatio };
  } else if (isLegacyPricingContract(value)) return { knowledge: "LEGACY", kind: "LEGACY" };
  return { knowledge: "UNKNOWN", kind: "UNKNOWN" };
}

/**
 * R1-01: a consumed entitlement cap must not be more generous than its own tier boundary.
 * Directional compare with the exact decimal tools: a stricter cap (smaller effective HAFF ratio, higher
 * buyer price, or a larger spread) passes; only a deeper discount is rejected. Pending/malformed values
 * are skipped because their own validation already blocks publish.
 */
function capWithinTierBoundary(cap: GrowthPricingContract, tier: GrowthPricingContract): boolean {
  // All legacy decimals are normalised to their 8-decimal integer value before any comparison,
  // so "0.5", "0.50" and "0.50000000" compare equal instead of by raw digit count.
  const decimal = (value: string | undefined): bigint | null => {
    if (value === undefined || value === "") return null;
    try { return decimalToBigInt(parseNonNegativeDecimal(value, 8, "pricing"), 8); } catch { return null; }
  };
  if (!notPriced(cap.haff) && !notPriced(tier.haff)) {
    const capSpread = decimal(cap.haff.spreadDelta ?? "0");
    const tierSpread = decimal(tier.haff.spreadDelta ?? "0");
    for (const safeBox of new Set([...Object.keys(cap.haff.baseBySafeBox), ...Object.keys(tier.haff.baseBySafeBox)])) {
      const capBase = decimal(cap.haff.baseBySafeBox[safeBox]);
      const tierBase = decimal(tier.haff.baseBySafeBox[safeBox]);
      if (capBase === null || tierBase === null || capSpread === null || tierSpread === null) continue;
      // Buyer ratio = base - spread; a larger ratio is a cheaper (more generous) buyer price.
      if (capBase - capSpread > tierBase - tierSpread) return false;
    }
  }
  for (const itemId of new Set([...Object.keys(cap.materials), ...Object.keys(tier.materials)])) {
    const capMaterial = cap.materials[itemId];
    const tierMaterial = tier.materials[itemId];
    if (!capMaterial || !tierMaterial || notPriced(capMaterial) || notPriced(tierMaterial)) continue;
    if (capMaterial.unit !== tierMaterial.unit || capMaterial.unitQuantity !== tierMaterial.unitQuantity) return false;
    const capBuyer = decimal(capMaterial.buyerUnitAmount);
    const tierBuyer = decimal(tierMaterial.buyerUnitAmount);
    if (capBuyer === null || tierBuyer === null) continue;
    if (capBuyer < tierBuyer) return false;
  }
  return true;
}

export function validateBenefitPolicy(value: GrowthBenefitPolicy, context: PolicyValidationContext = {}): PolicyValidation {
  const result: PolicyValidation = { valid: true, publishable: true, errors: [], warnings: [] };
  const enabled = new Set<RentalMode>(context.enabledModes ?? ["ordinary", "custom", "fast"]);
  if (!value || value.schema !== MEMBERSHIP_GROWTH_SCHEMA) result.errors.push("schema");
  if (value?.pricingScope !== undefined && value.pricingScope !== 'ALL_ENABLED_RENTAL_MODES') result.errors.push('pricingScope');
  if (!value || !["DRAFT", "APPROVED"].includes(value.status)) result.errors.push("status");
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value.version)) result.errors.push("version");
  if (!value || !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/.test(value.sourceRef)) result.errors.push("sourceRef");
  if (value?.effectiveAt !== null) {
    try { parseInstant(value.effectiveAt, "effectiveAt"); } catch { result.errors.push("effectiveAt"); }
  }
  const independentRanges = value?.entitlementRanges !== undefined;
  if (independentRanges) validateEntitlementRanges(value.entitlementRanges!, enabled, result);
  else if (!value?.entitlementCaps || value.entitlementCaps.FRIEND !== "GOLD" || value.entitlementCaps.PRESTIGE !== "DIAMOND") result.errors.push("entitlementCaps");
  for (const tier of NORMAL_GROWTH_TIERS) {
    const config = value?.tiers?.[tier];
    if (!config || config.tier !== tier) {
      result.errors.push(`tiers.${tier}`);
      continue;
    }
    if (config.tenantDeposit !== "ACCOUNT_BASE" && config.tenantDeposit !== "WAIVED") result.errors.push(`tiers.${tier}.tenantDeposit`);
    try { parseDepositAllowanceCents(config.depositAllowanceCents, config.tenantDeposit === "WAIVED"); }
    catch { result.errors.push(`tiers.${tier}.depositAllowanceCents`); }
    for (const mode of ["ordinary", "custom", "fast"] as const) {
      const contract = config.pricing?.[mode];
      const path = `tiers.${tier}.pricing.${mode}`;
      if (contract === undefined) {
        if (enabled.has(mode)) { result.errors.push(path); result.publishable = false; }
        continue;
      }
      if (notPriced(contract)) {
        if (enabled.has(mode)) { validatePricingContract(contract, path, result); result.publishable = false; }
        continue;
      }
      if (isTotalDiscountContract(contract)) {
        // A disabled mode is inert; a configured total discount is only shape-checked when its mode is enabled.
        if (!enabled.has(mode)) continue;
        validateTotalDiscount(contract, path, result);
        if (contract.mode !== mode) result.errors.push(path);
        continue;
      }
      // Legacy haff/materials contract: disabled by the sealed release stays inert, enabled is fully validated.
      if (!enabled.has(mode)) {
        if (contract.haff !== undefined && notPriced(contract.haff)) continue;
        validatePricingContract(contract, path, result);
        if (contract.mode !== mode) result.errors.push(path);
        continue;
      }
      validateConfiguredContract(contract, path, context, result);
      // R1-06: an enabled slot must carry the contract for that slot's own mode; otherwise the published
      // policy is unreachable in the formal quote adapter.
      if (contract.mode !== mode) result.errors.push(path);
    }
    if (independentRanges) continue;
    const capPath = `tiers.${tier}.entitlementCap`;
    const cap = config.entitlementCap;
    if (isEntitlementCapByMode(cap)) {
      for (const mode of Object.keys(cap.byMode) as RentalMode[]) {
        if (mode !== "ordinary" && mode !== "custom" && mode !== "fast") { result.errors.push(`${capPath}.byMode`); continue; }
        const entry = cap.byMode[mode];
        if (entry === undefined || !enabled.has(mode)) continue;
        if (isTotalDiscountContract(entry)) validateTotalDiscount(entry, `${capPath}.byMode.${mode}`, result);
        else validatePricingContract(entry, `${capPath}.byMode.${mode}`, result);
        if (!notPriced(entry) && entry.mode !== mode) result.errors.push(`${capPath}.byMode.${mode}`);
        else if (!notPriced(entry) && !isTotalDiscountContract(entry)) validateCatalogCoverage(entry, `${capPath}.byMode.${mode}`, context, result);
      }
      for (const mode of enabled) {
        const entry = cap.byMode[mode];
        if (!entry || notPriced(entry)) {
          result.publishable = false;
          result.warnings.push(`${capPath}.byMode.${mode}.cost_basis_missing`);
        }
      }
    } else if (isTotalDiscountContract(cap)) {validateTotalDiscount(cap, capPath, result);if(cap.scope==='ALL_ENABLED_RENTAL_MODES')result.errors.push(capPath);}
    else validatePricingContract(cap, capPath, result);
    // R1-01: the consumed caps (GOLD/DIAMOND) must not be more generous than the tier boundary they derive from.
    if (tier === "GOLD" || tier === "DIAMOND") for (const mode of enabled) {
      const capEntry = entitlementCapForMode(config.entitlementCap, mode);
      const tierContract = config.pricing?.[mode];
      if (!capEntry || notPriced(capEntry) || !tierContract || notPriced(tierContract)) continue;
      const byModeCap = isEntitlementCapByMode(config.entitlementCap);
      if (!byModeCap && capEntry.mode !== mode) continue; // a legacy single cap only bounds its own mode
      if (isTotalDiscountContract(capEntry) || isTotalDiscountContract(tierContract)) {
        if (isTotalDiscountContract(capEntry) && isTotalDiscountContract(tierContract)) {
          const capRatio = discountRatio(capEntry.payableRatio);
          const tierRatio = discountRatio(tierContract.payableRatio);
          // Cap payable ratio must not be lower (deeper) than the tier it derives from.
          if (capRatio !== null && tierRatio !== null && capRatio < tierRatio) result.warnings.push(`${capPath}.${mode}.below_tier_boundary`);
        } else result.warnings.push(`${capPath}.${mode}.contract_kind_mismatch`);
        continue;
      }
      if (!capWithinTierBoundary(capEntry, tierContract)) result.warnings.push(`${capPath}.${mode}.below_tier_boundary`);
    }
  }
  if (value?.pricingScope === 'ALL_ENABLED_RENTAL_MODES') {
    for (const tier of NORMAL_GROWTH_TIERS) {
      const terms = new Set<string>();
      for (const mode of enabled) {
        const contract = value.tiers?.[tier]?.pricing?.[mode];
        if (!contract || notPriced(contract)) continue;
        if (!isTotalDiscountContract(contract)) { result.errors.push(`tiers.${tier}.unified_pricing_required`); continue; }
        const ratio = discountRatio(contract.payableRatio);
        if (ratio !== null) terms.add([ratio, contract.priceVersionId, contract.costBasisRef].join('\u0000'));
      }
      if (terms.size > 1) result.errors.push(`tiers.${tier}.unified_pricing_differs`);
    }
    if (!independentRanges) result.errors.push('entitlementRanges.unified_range_required');
    else for (const kind of ['FRIEND','PRESTIGE'] as const) {
      if (projectUniformEntitlementRange(value, kind, [...enabled]).reasonCodes.includes('LEGACY_MODE_VALUES_DIFFER')) result.errors.push(`entitlementRanges.${kind}.unified_range_differs`);
    }
  }
  const pricingDecimalDifference = (left: string, right: string): bigint | null => {
    try { return subtractDecimal(parseNonNegativeDecimal(left, 8, "pricing"), parseNonNegativeDecimal(right, 8, "pricing")).value; } catch { return null; }
  };
  const pricingEffectiveHaff = (base: string, spread: string) => {
    try { return subtractDecimal(parseNonNegativeDecimal(base, 8, "pricing"), parseNonNegativeDecimal(spread, 8, "pricing")); } catch { return null; }
  };
  const comparePricing = (left: GrowthPricingContract, right: GrowthPricingContract, path: string) => {
    const leftHaff = left.haff;
    const rightHaff = right.haff;
    if (notPriced(leftHaff) || notPriced(rightHaff)) result.publishable = false;
    else for (const safeBox of new Set([...Object.keys(leftHaff.baseBySafeBox), ...Object.keys(rightHaff.baseBySafeBox)])) {
      const leftBase = leftHaff.baseBySafeBox[safeBox];
      const rightBase = rightHaff.baseBySafeBox[safeBox];
      if (leftBase === undefined || rightBase === undefined) result.errors.push(`${path}.haff.baseBySafeBox.${safeBox}`);
      else if (leftBase === "" || rightBase === "" || leftHaff.spreadDelta === "" || rightHaff.spreadDelta === "") continue; // pending draft values are not comparable
      else {
        const leftSpread = leftHaff.spreadDelta ?? "0";
        const rightSpread = rightHaff.spreadDelta ?? "0";
        const leftEffective = pricingEffectiveHaff(leftBase, leftSpread);
        const rightEffective = pricingEffectiveHaff(rightBase, rightSpread);
        if (leftEffective === null || rightEffective === null || subtractDecimal(rightEffective, leftEffective).value < 0n) result.errors.push(`${path}.haff.${safeBox}.not_monotonic`);
      }
    }
    const itemIds = new Set([...Object.keys(left.materials), ...Object.keys(right.materials)]);
    for (const itemId of itemIds) {
      const lower = left.materials[itemId];
      const higher = right.materials[itemId];
      if (!lower || !higher || notPriced(lower) || notPriced(higher)) { result.publishable = false; continue; }
      if (lower.unitQuantity === "" || higher.unitQuantity === "") continue; // pending draft values are not comparable
      if (lower.unit !== higher.unit || lower.unitQuantity !== higher.unitQuantity) result.errors.push(`${path}.materials.${itemId}.contract_mismatch`);
      if ((pricingDecimalDifference(higher.buyerUnitAmount, lower.buyerUnitAmount) ?? 0n) > 0n) result.errors.push(`${path}.materials.${itemId}.buyer_not_monotonic`);
      if ((pricingDecimalDifference(higher.ownerUnitAmount, lower.ownerUnitAmount) ?? 0n) < 0n) result.errors.push(`${path}.materials.${itemId}.owner_not_monotonic`);
    }
  };
  for (let index = 1; index < NORMAL_GROWTH_TIERS.length; index += 1) {
    const lower = value?.tiers?.[NORMAL_GROWTH_TIERS[index - 1]!];
    const higher = value?.tiers?.[NORMAL_GROWTH_TIERS[index]!];
    if (!lower || !higher) continue;
    if (lower.tenantDeposit === "WAIVED" && higher.tenantDeposit !== "WAIVED") result.errors.push(`tiers.${higher.tier}.tenantDeposit.not_monotonic`);
    try {
      if (higher.tenantDeposit !== "WAIVED" && BigInt(parseDepositAllowanceCents(higher.depositAllowanceCents)) < BigInt(parseDepositAllowanceCents(lower.depositAllowanceCents))) result.errors.push(`tiers.${higher.tier}.depositAllowanceCents.not_monotonic`);
    } catch { /* Each invalid field is reported above. */ }
    for (const mode of enabled) {
      const lowerContract = lower.pricing?.[mode];
      const higherContract = higher.pricing?.[mode];
      if (!lowerContract || !higherContract) continue;
      if (isTotalDiscountContract(lowerContract) && isTotalDiscountContract(higherContract)) {
        const lowerRatio = discountRatio(lowerContract.payableRatio);
        const higherRatio = discountRatio(higherContract.payableRatio);
        if (lowerRatio === null || higherRatio === null) continue; // pending/invalid values already reported
        // A higher tier must never pay more than a lower tier on the same base total.
        if (higherRatio > lowerRatio) result.errors.push(`pricing.${mode}.${higher.tier}.discount_not_monotonic`);
        continue;
      }
      if (notPriced(lowerContract) || notPriced(higherContract)) continue;
      if (isLegacyPricingContract(lowerContract) && isLegacyPricingContract(higherContract)) comparePricing(lowerContract, higherContract, `pricing.${mode}.${higher.tier}`);
    }
  }
  if (context.fixedFeeRates !== undefined) {
    try {
      const rates = parseFixedFeeRates(context.fixedFeeRates);
      if (!validEnabledModes(context.enabledModes)) throw new Error("enabled modes are required");
      const check = (mode: RentalMode, ratio: string | undefined, path: string) => {
        if (ratio === undefined || ratio === "") return; // The ordinary policy validator reports pending values.
        if (!fixedFeeAllowsPayableRatio(rates[mode], ratio)) result.errors.push(`${path}.discount_exceeds_fee`);
      };
      for (const mode of context.enabledModes) {
        for (const tier of NORMAL_GROWTH_TIERS) {
          const contract = value?.tiers?.[tier]?.pricing?.[mode], path = `tiers.${tier}.pricing.${mode}`;
          if (!contract || notPriced(contract)) continue;
          if (!isTotalDiscountContract(contract)) result.errors.push(`${path}.total_discount_required`);
          else check(mode, contract.payableRatio, path);
        }
        for (const kind of ["FRIEND", "PRESTIGE"] as const) {
          if (independentRanges) {
            const range = entitlementRangeForMode(value, kind, mode);
            if (range && !notPriced(range)) check(mode, range.minPayableRatio, `entitlementRanges.${kind}.byMode.${mode}`);
          } else {
            const cap = value?.tiers?.[kind === "FRIEND" ? "GOLD" : "DIAMOND"]?.entitlementCap;
            const entry = cap && entitlementCapForMode(cap, mode);
            if (!entry || notPriced(entry) || (!isEntitlementCapByMode(cap!) && entry.mode !== mode)) continue;
            if (!isTotalDiscountContract(entry)) result.errors.push(`entitlementCaps.${kind}.${mode}.total_discount_required`);
            else check(mode, entry.payableRatio, `entitlementCaps.${kind}.${mode}`);
          }
        }
      }
    } catch { result.errors.push("fixedFeeRates.invalid"); }
  }
  result.publishable = result.publishable && result.errors.length === 0 && value?.status === "APPROVED" && result.warnings.length === 0;
  result.valid = result.errors.length === 0;
  return result;
}

export function assertValidBenefitPolicy(policy: GrowthBenefitPolicy, context?: PolicyValidationContext): void {
  const result = validateBenefitPolicy(policy, context);
  if (!result.valid) fail("INVALID_BENEFIT_POLICY", result.errors.join(","));
}

export function assertPublishableBenefitPolicy(policy: GrowthBenefitPolicy, context?: PolicyValidationContext): void {
  const result = validateBenefitPolicy(policy, context);
  if (!result.valid || !result.publishable) fail("BENEFIT_POLICY_NOT_PUBLISHABLE", [...result.errors, ...result.warnings].join(","));
}

export type EntitlementKind = "FRIEND" | "PRESTIGE";
export type EntitlementCandidate = {
  id?: string;
  userId: string;
  kind: EntitlementKind;
  scopeKey: string;
  startsAt: string;
  endsAt: string;
  /** Legacy haff/materials contract or the owner total-discount contract. */
  pricing: ModePricingContract;
  depositWaived?: boolean;
  depositAllowanceCents?: string;
  reason: string;
  requestedBy: string;
};

export type EntitlementValidation = { valid: boolean; errors: string[]; depositWaived: boolean };

function pricingWithinCap(candidate: GrowthPricingContract, cap: GrowthPricingContract): boolean {
  if (JSON.stringify(candidate) === JSON.stringify(cap)) return true;
  if (candidate.mode !== cap.mode || candidate.priceVersionId !== cap.priceVersionId) return false;
  if (notPriced(candidate.haff) || notPriced(cap.haff)) return false;
  const higher = (left: string, right: string) => subtractDecimal(parseNonNegativeDecimal(left, 8, "pricing"), parseNonNegativeDecimal(right, 8, "pricing")).value > 0n;
  const lower = (left: string, right: string) => subtractDecimal(parseNonNegativeDecimal(left, 8, "pricing"), parseNonNegativeDecimal(right, 8, "pricing")).value < 0n;
  const candidateSpread = candidate.haff.spreadDelta;
  const capSpread = cap.haff.spreadDelta;
  if (candidateSpread !== undefined || capSpread !== undefined) {
    if (candidateSpread === undefined || capSpread === undefined) return false;
    if (subtractDecimal(parseNonNegativeDecimal(candidateSpread, 8, "pricing"), parseNonNegativeDecimal(capSpread, 8, "pricing")).value !== 0n) return false;
  }
  for (const safeBox of Object.keys(candidate.haff.baseBySafeBox)) {
    const candidateBase = candidate.haff.baseBySafeBox[safeBox];
    const capBase = cap.haff.baseBySafeBox[safeBox];
    if (candidateBase === undefined || capBase === undefined || higher(candidateBase, capBase)) return false;
  }
  for (const [itemId, candidateMaterial] of Object.entries(candidate.materials)) {
    const capMaterial = cap.materials[itemId];
    if (!capMaterial || notPriced(candidateMaterial) || notPriced(capMaterial)) return false;
    if (candidateMaterial.unit !== capMaterial.unit || candidateMaterial.unitQuantity !== capMaterial.unitQuantity) return false;
    if (lower(candidateMaterial.buyerUnitAmount, capMaterial.buyerUnitAmount) || lower(candidateMaterial.ownerUnitAmount, capMaterial.ownerUnitAmount)) return false;
  }
  return true;
}

export function validateEntitlementCandidate(candidate: EntitlementCandidate, _membershipTier: GrowthTier, policy: GrowthBenefitPolicy,context?:{enabledModes?:readonly RentalMode[]}): EntitlementValidation {
  const errors: string[] = [];
  try { parseDepositAllowanceCents(candidate.depositAllowanceCents, candidate.depositWaived ?? false); }
  catch { errors.push("depositAllowanceCents"); }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(candidate.userId)) errors.push("userId");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,199}$/.test(candidate.scopeKey)) errors.push("scopeKey");
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/.test(candidate.requestedBy)) errors.push("requestedBy");
  if (candidate.reason.trim().length < 2 || candidate.reason.length > 500) errors.push("reason");
  const startsAt = parseInstant(candidate.startsAt, "startsAt");
  const endsAt = parseInstant(candidate.endsAt, "endsAt");
  if (endsAt <= startsAt || endsAt - startsAt > GROWTH_WINDOW_US) errors.push("duration");
  const pricing = candidate.pricing;
  if(isTotalDiscountContract(pricing)&&Object.hasOwn(pricing,'scope')){
    const checked:PolicyValidation={valid:true,publishable:true,errors:[],warnings:[]};validateTotalDiscount(pricing,'candidate.pricing',checked);
    if(checked.errors.length||checked.warnings.length)errors.push('pricingInvalid');
    if(!validEnabledModes(context?.enabledModes))errors.push('enabledModesRequired');
    else{
      const range=projectUniformEntitlementRange(policy,candidate.kind,context.enabledModes);if(range.knowledge!=='KNOWN')errors.push(...range.reasonCodes);
      for(const mode of context.enabledModes){
        const bound:TotalDiscountContract={status:'CONFIGURED',kind:'TOTAL_DISCOUNT',mode,priceVersionId:pricing.priceVersionId,costBasisRef:pricing.costBasisRef,payableRatio:pricing.payableRatio};
        errors.push(...validateEntitlementCandidate({...candidate,pricing:bound},_membershipTier,policy).errors);
      }
    }
    return{valid:errors.length===0,errors:[...new Set(errors)],depositWaived:candidate.depositWaived===true};
  }
  const candidateMode = !notPriced(pricing) && typeof (pricing as { mode?: unknown }).mode === "string" && ["ordinary", "custom", "fast"].includes((pricing as { mode: string }).mode)
    ? (pricing as { mode: RentalMode }).mode : null;
  const strict: PolicyValidation = { valid: true, publishable: true, errors: [], warnings: [] };
  if (notPriced(pricing)) strict.errors.push("candidate.pricing");
  else if (isTotalDiscountContract(pricing)) validateTotalDiscount(pricing, "candidate.pricing", strict);
  else validatePricingContract(pricing, "candidate.pricing", strict);
  const pricingValid = strict.errors.length === 0 && strict.warnings.length === 0;
  if (!pricingValid) errors.push("pricingInvalid");
  if (policy.entitlementRanges !== undefined) {
    const range = candidateMode ? entitlementRangeForMode(policy, candidate.kind, candidateMode) : undefined;
    const validation: PolicyValidation = { valid: true, publishable: true, errors: [], warnings: [] };
    if (candidateMode) validateEntitlementRanges(policy.entitlementRanges, new Set([candidateMode]), validation);
    if (!range || notPriced(range) || validation.errors.length || validation.warnings.length) errors.push("costBasisMissing");
    else if (!isTotalDiscountContract(pricing)) errors.push("contractKindMismatch");
    else {
      const actual = discountRatio(pricing.payableRatio), min = discountRatio(range.minPayableRatio), max = discountRatio(range.maxPayableRatio);
      if (actual === null || min === null || max === null || actual < min || actual > max || pricing.priceVersionId !== range.priceVersionId || pricing.costBasisRef !== range.costBasisRef) errors.push("pricingBeyondPolicy");
    }
    return { valid: errors.length === 0, errors, depositWaived: candidate.depositWaived === true };
  }
  const cap = candidate.kind === "FRIEND" ? "GOLD" : "DIAMOND";
  const capPricing = candidateMode ? entitlementCapForMode(policy.tiers[cap].entitlementCap, candidateMode) : undefined;
  if (capPricing === undefined || notPriced(capPricing)) errors.push("costBasisMissing");
  else if (pricingValid) {
    if (isTotalDiscountContract(pricing) && isTotalDiscountContract(capPricing)) {
      const capStrict: PolicyValidation = { valid: true, publishable: true, errors: [], warnings: [] };
      validateTotalDiscount(capPricing, "cap.pricing", capStrict);
      const candidateRatio = discountRatio(pricing.payableRatio);
      const capRatio = discountRatio(capPricing.payableRatio);
      // A manual benefit may keep the cap or make it stricter (pay a larger share), never deeper.
      if (capStrict.errors.length > 0 || capStrict.warnings.length > 0 || pricing.mode !== capPricing.mode || pricing.priceVersionId !== capPricing.priceVersionId
        || candidateRatio === null || capRatio === null || candidateRatio < capRatio) errors.push("pricingBeyondPolicy");
    } else if (isLegacyPricingContract(pricing) && isLegacyPricingContract(capPricing)) {
      const capStrict: PolicyValidation = { valid: true, publishable: true, errors: [], warnings: [] };
      validatePricingContract(capPricing, "cap.pricing", capStrict);
      if (capStrict.errors.length > 0 || capStrict.warnings.length > 0 || !pricingWithinCap(pricing, capPricing)) errors.push("pricingBeyondPolicy");
    } else errors.push("contractKindMismatch");
  }
  return { valid: errors.length === 0, errors, depositWaived: candidate.depositWaived === true };
}

export type ExistingEntitlement = EntitlementCandidate & { status: "PENDING" | "APPROVED_PENDING_EXECUTION" | "EXECUTED_PENDING_START" | "ACTIVE" | "EXPIRED" | "REPLACED" | "REVOKED" };

export function hasOverlappingEntitlement(existing: readonly ExistingEntitlement[], candidate: EntitlementCandidate): boolean {
  const start = parseInstant(candidate.startsAt, "startsAt");
  const end = parseInstant(candidate.endsAt, "endsAt");
  return existing.some((item) => item.userId === candidate.userId && item.scopeKey === candidate.scopeKey && item.status !== "REVOKED" && item.status !== "REPLACED" && item.id !== candidate.id && start < parseInstant(item.endsAt, "endsAt") && end > parseInstant(item.startsAt, "startsAt"));
}

export function entitlementStateAt(entitlement: Pick<ExistingEntitlement, "startsAt" | "endsAt" | "status">, at: string): ExistingEntitlement["status"] {
  if (entitlement.status === "REVOKED" || entitlement.status === "REPLACED") return entitlement.status;
  if (entitlement.status === "PENDING" || entitlement.status === "APPROVED_PENDING_EXECUTION") return entitlement.status;
  const instant = parseInstant(at, "at");
  if (entitlement.status === "EXECUTED_PENDING_START" && instant < parseInstant(entitlement.startsAt, "startsAt")) return "EXECUTED_PENDING_START";
  if (instant >= parseInstant(entitlement.endsAt, "endsAt")) return "EXPIRED";
  return entitlement.status === "EXPIRED" ? "EXPIRED" : "ACTIVE";
}
