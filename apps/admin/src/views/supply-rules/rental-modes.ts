import type { PriceVersionRecord, RulesResponse } from "../../api";
import { asHaffV2, type HaffV2, type RatioBound } from "./rules-model.ts";

/**
 * 租赁模式（普通/自定义/极速）配置的纯模型。
 * 读取时只反映服务端原值，不补默认；极速默认 P=12、下限 C+6 只在用户明确“新建极速草稿”时套用。
 * 上限留空＝仅下限，绝不用 9999 等大数伪装无上限。
 */
export const CUSTOMER_TIERS = ["STANDARD", "VIP", "SVIP", "DISCOUNT_USER"] as const;
export const FAST_DEFAULT_SPREAD = "12";
export const FAST_DEFAULT_MIN: RatioBound = { base: "C", value: "6" };

export type BoundDraft = { base: "C" | "ABSOLUTE"; value: string };
export type ModeDraft = { enabled: boolean; min: BoundDraft; max: BoundDraft };
export type RentalModeDraft = { custom: ModeDraft; fast: ModeDraft & { spreadDelta: string; discounts: Record<string, string> } };

const boundDraft = (b: RatioBound | undefined): BoundDraft => ({ base: b?.base ?? "C", value: b?.value ?? "" });

export function rentalModeDraft(haff: HaffV2): RentalModeDraft {
  const m = haff.compatibility.modes, lane = haff.compatibility.fast;
  return {
    custom: { enabled: m.custom.enabled, min: boundDraft(m.custom.min), max: boundDraft(m.custom.max) },
    fast: {
      enabled: m.fast.enabled, min: boundDraft(m.fast.min), max: boundDraft(m.fast.max), spreadDelta: lane?.spreadDelta ?? "",
      discounts: Object.fromEntries(CUSTOMER_TIERS.map((t) => [t, lane?.discounts[t] ?? ""])),
    },
  };
}

/** 仅用于“新建极速草稿”：开启极速并填入 Owner 已定的 P=12、下限 C+6、无上限；新会员按统一总价折扣，档位增量全部为 0。 */
export function withFastDefaults(draft: RentalModeDraft): RentalModeDraft {
  return { ...draft, fast: { enabled: true, spreadDelta: FAST_DEFAULT_SPREAD, min: { ...FAST_DEFAULT_MIN }, max: { base: "C", value: "" }, discounts: Object.fromEntries(CUSTOMER_TIERS.map((t) => [t, "0"])) } };
}

const SIGNED8 = /^-?(0|[1-9]\d*)(\.\d{1,8})?$/, UNSIGNED8 = /^(0|[1-9]\d*)(\.\d{1,8})?$/;

/** 字段级问题；键与表单控件一一对应。 */
export function rentalModeIssues(d: RentalModeDraft): Record<string, string> {
  const e: Record<string, string> = {};
  for (const name of ["custom", "fast"] as const) {
    const m = d[name];
    if (!m.enabled) continue;
    const min = m.min.value.trim(), max = m.max.value.trim();
    if (!SIGNED8.test(min)) e[`${name}.min`] = "启用时下限必填，须为数字，最多八位小数";
    if (max !== "" && !SIGNED8.test(max)) e[`${name}.max`] = "上限须为数字，最多八位小数；留空表示不设上限";
    if (!e[`${name}.min`] && !e[`${name}.max`] && max !== "" && m.min.base === m.max.base && Number(max) < Number(min)) e[`${name}.max`] = "上限不能小于下限";
    if (m.min.base === "ABSOLUTE" && !e[`${name}.min`] && Number(min) <= 0) e[`${name}.min`] = "固定比例下限须大于 0";
  }
  if (d.fast.enabled) {
    const p = d.fast.spreadDelta.trim();
    if (!UNSIGNED8.test(p)) e["fast.spreadDelta"] = "利润点须为非负数，最多八位小数";
    for (const t of CUSTOMER_TIERS) {
      const v = (d.fast.discounts[t] ?? "").trim();
      if (!UNSIGNED8.test(v)) e[`fast.discounts.${t}`] = "须为非负数";
      else if (t === "STANDARD" && Number(v) !== 0) e[`fast.discounts.${t}`] = "普通档须为 0";
      else if (!e["fast.spreadDelta"] && Number(v) > Number(p)) e[`fast.discounts.${t}`] = "不能大于利润点";
    }
  }
  return e;
}

const bound = (b: BoundDraft): RatioBound => ({ base: b.base, value: b.value.trim() });

/** 由基线 haff-ratio-v2 与表单生成新规则；未改动的哈夫币参数、普通 lane 原样保留。 */
export function buildRentalModeRule(base: HaffV2, d: RentalModeDraft): HaffV2 {
  const c = base.compatibility;
  const mode = (orig: HaffV2["compatibility"]["modes"]["custom"], m: ModeDraft) => m.enabled
    ? { enabled: true, min: bound(m.min), ...(m.max.value.trim() === "" ? {} : { max: bound(m.max) }) }
    // 关闭时保留原界值内容（若有），只翻转启停，避免丢失可追溯的旧参数。
    : { ...orig, enabled: false };
  const fastLane = d.fast.enabled
    ? { spreadDelta: d.fast.spreadDelta.trim(), discounts: Object.fromEntries(CUSTOMER_TIERS.map((t) => [t, d.fast.discounts[t]!.trim()])) }
    : c.fast;
  const { fast: _omit, ...rest } = c;
  return { ...base, compatibility: { ...rest, ...(fastLane ? { fast: fastLane } : {}), modes: { ordinary: c.modes.ordinary, custom: mode(c.modes.custom, d.custom), fast: mode(c.modes.fast, d.fast) } } };
}

/** 保存体：目标草稿尚无价格行时，从来源版本复制价格行、取整、资金政策，保证草稿完整可封存。 */
export function rentalModeSaveBody(rules: RulesResponse, target: PriceVersionRecord, source: PriceVersionRecord, haffRule: HaffV2): Record<string, unknown> {
  const result: Record<string, unknown> = { expectedRevision: target.revision, haffRule };
  if (rules.priceLines.some((l) => l.priceVersionId === target.id)) return result;
  const lines = rules.priceLines.filter((l) => l.priceVersionId === source.id);
  if (!lines.length) throw new Error("来源版本缺少价格行，不能生成完整草稿。");
  return { ...result, mode: source.mode, roundingPolicy: source.roundingPolicy, ...(target.fundingPolicy || !source.fundingPolicy ? {} : { fundingPolicy: source.fundingPolicy }),
    lines: lines.map(({ itemId, customerTier, pricingKind, unitQuantity, buyerUnitAmount, ownerUnitAmount }) => ({ itemId, ...(customerTier === undefined ? {} : { customerTier }), pricingKind, ...(pricingKind === "FIXED_UNIT" ? { unitQuantity, buyerUnitAmount, ...(source.mode === "SPREAD" && ownerUnitAmount !== null ? { ownerUnitAmount } : {}) } : {}) })) };
}

/** 选用的编辑基线：所选草稿自身已有 v2 规则时用草稿，否则用当前生效版本。 */
export function rentalModeBase(rules: RulesResponse, selectedId: string): { source: PriceVersionRecord; haff: HaffV2 } | null {
  const selected = rules.priceVersions.find((v) => v.id === selectedId), sh = asHaffV2(selected?.haffRule);
  if (selected && sh) return { source: selected, haff: sh };
  const current = rules.priceVersions.find((v) => v.id === rules.release?.priceVersionId), ch = asHaffV2(current?.haffRule);
  return current && ch ? { source: current, haff: ch } : null;
}

export function boundText(b: RatioBound | undefined): string {
  if (!b) return "不设上限";
  return b.base === "ABSOLUTE" ? b.value : `C${b.value.startsWith("-") ? "" : "+"}${b.value}`;
}
