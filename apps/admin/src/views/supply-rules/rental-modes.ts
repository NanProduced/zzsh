import type { PriceVersionRecord, RulesResponse } from "../../api";
import { asHaffV2, type HaffV2, type RatioBound } from "./rules-model.ts";
import { priceSaveBody } from "./price-draft.ts";

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
/**
 * legacyDiscounts 只读：旧 VIP/SVIP/优惠用户档位增量仅为历史/接口兼容保留，日常表单不提供编辑。
 * 已有草稿/历史版本原值原样带回；只有“新建极速草稿”把新 fast 基础增量置 0。
 */
export type RentalModeDraft = { custom: ModeDraft; fast: ModeDraft & { spreadDelta: string; legacyDiscounts: Readonly<Record<string, string>> | null } };

const boundDraft = (b: RatioBound | undefined): BoundDraft => ({ base: b?.base ?? "C", value: b?.value ?? "" });

export function rentalModeDraft(haff: HaffV2): RentalModeDraft {
  const m = haff.compatibility.modes, lane = haff.compatibility.fast;
  return {
    custom: { enabled: m.custom.enabled, min: boundDraft(m.custom.min), max: boundDraft(m.custom.max) },
    fast: {
      enabled: m.fast.enabled, min: boundDraft(m.fast.min), max: boundDraft(m.fast.max), spreadDelta: lane?.spreadDelta ?? "",
      legacyDiscounts: lane ? Object.freeze({ ...lane.discounts }) : null,
    },
  };
}

const zeroDiscounts = () => Object.freeze(Object.fromEntries(CUSTOMER_TIERS.map((t) => [t, "0"])));

/** 非零旧档位增量（只读核对用）；空表示全部为 0 或无 fast lane。 */
export function legacyNonZero(d: RentalModeDraft): string[] {
  return Object.entries(d.fast.legacyDiscounts ?? {}).filter(([, v]) => !/^0(\.0+)?$/.test(String(v).trim())).map(([t, v]) => `${t}=${v}`);
}

/** 仅用于“新建极速草稿”：开启极速并填入 Owner 已定的 P=12、下限 C+6、无上限；新会员按统一总价折扣，隐藏的旧档位增量保持原值（无原值时为 0）。 */
export function withFastDefaults(draft: RentalModeDraft): RentalModeDraft {
  return { ...draft, fast: { enabled: true, spreadDelta: FAST_DEFAULT_SPREAD, min: { ...FAST_DEFAULT_MIN }, max: { base: "C", value: "" }, legacyDiscounts: draft.fast.legacyDiscounts } };
}

const SIGNED8 = /^-?(0|[1-9]\d*)(\.\d{1,2})?$/, UNSIGNED8 = /^(0|[1-9]\d*)(\.\d{1,2})?$/;

/** 字段级问题；键与表单控件一一对应。 */
export function rentalModeIssues(d: RentalModeDraft): Record<string, string> {
  const e: Record<string, string> = {};
  for (const name of ["custom", "fast"] as const) {
    const m = d[name];
    if (!m.enabled) continue;
    const min = m.min.value.trim(), max = m.max.value.trim();
    if (!SIGNED8.test(min)) e[`${name}.min`] = "启用时下限必填，须为数字，最多两位小数";
    if (max !== "" && !SIGNED8.test(max)) e[`${name}.max`] = "上限须为数字，最多两位小数；留空表示不设上限";
    if (!e[`${name}.min`] && !e[`${name}.max`] && max !== "" && m.min.base === m.max.base && Number(max) < Number(min)) e[`${name}.max`] = "上限不能小于下限";
    if (m.min.base === "ABSOLUTE" && !e[`${name}.min`] && Number(min) <= 0) e[`${name}.min`] = "固定比例下限须大于 0";
  }
  if (d.fast.enabled) {
    const p = d.fast.spreadDelta.trim();
    if (!UNSIGNED8.test(p)) e["fast.spreadDelta"] = "利润点须为非负数，最多两位小数";
    // 旧档位增量不可编辑，此处不校验其数值；保留原值由服务端规则校验兜底。
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
    // 原有 lane 增量原样保留（不静默清零）；无原 lane 时新 fast 基础增量全部为 0。
    ? { spreadDelta: d.fast.spreadDelta.trim(), discounts: { ...(d.fast.legacyDiscounts ?? c.fast?.discounts ?? zeroDiscounts()) } }
    : c.fast;
  const { fast: _omit, ...rest } = c;
  return { ...base, compatibility: { ...rest, ...(fastLane ? { fast: fastLane } : {}), modes: { ordinary: c.modes.ordinary, custom: mode(c.modes.custom, d.custom), fast: mode(c.modes.fast, d.fast) } } };
}

/** 保存体：只提交 haffRule；目标草稿尚为空时由 priceSaveBody 从当前生效版本补齐普通档位价目与资金政策。 */
export function rentalModeSaveBody(rules: RulesResponse, target: PriceVersionRecord, _source: PriceVersionRecord, haffRule: HaffV2): Record<string, unknown> {
  return priceSaveBody(rules, target, { haffRule });
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
