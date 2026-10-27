import type { CatalogItem, PriceLineRecord, PriceVersionRecord, RulesResponse } from "../../api";
import { unitText } from "../supply-review/model.ts";

/** haff-ratio-v2 shape as returned by the API (read-only view model; the server stays the source of truth). */
export type RatioBound = { base: "C" | "ABSOLUTE"; value: string };
export type HaffV2 = {
  schema: "haff-ratio-v2";
  baseBySafeBox: Record<string, string>;
  vitalityDeltaByLevel: Record<string, string>;
  bearDeltaByLevel: Record<string, string>;
  dailyDeltaByTermOption: Record<string, string>;
  compatibility: {
    ordinary: { spreadDelta: string; discounts: Record<string, string> };
    /** 极速 lane 仅在极速启用时必备；关闭时可缺省。 */
    fast?: { spreadDelta: string; discounts: Record<string, string> };
    /** 关闭的模式可不带界值；启用时 min 必填，max 可省略＝仅下限。 */
    modes: { ordinary: { enabled: boolean }; custom: { enabled: boolean; min?: RatioBound; max?: RatioBound }; fast: { enabled: boolean; min?: RatioBound; max?: RatioBound } };
  };
};

/**
 * Only a complete real haff-ratio-v2 becomes an editable/estimable model.
 * v1 stays null so callers degrade to "暂不支持，请核对原始配置" instead of
 * inventing spread deltas, level deltas or term deltas that were never approved.
 */
export function asHaffV2(rule: PriceVersionRecord["haffRule"] | undefined): HaffV2 | null {
  if (rule?.schema !== "haff-ratio-v2") return null;
  const r = rule as Partial<HaffV2>;
  if (!r.baseBySafeBox || !r.vitalityDeltaByLevel || !r.bearDeltaByLevel || !r.dailyDeltaByTermOption || !r.compatibility?.ordinary?.discounts || !r.compatibility.modes?.ordinary || !r.compatibility.modes.custom || !r.compatibility.modes.fast) return null;
  // 合法的“极速关闭”规则可以没有 fast lane；只有极速启用而缺 lane 才视为不完整。
  if (r.compatibility.modes.fast.enabled === true && !r.compatibility.fast?.discounts) return null;
  return rule as unknown as HaffV2;
}

export function num(value: string | null | undefined): number | null {
  if (value === null || value === undefined || value.trim() === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

/** Display only: yuan per 1M haff at a ratio (万哈夫币/元). Never written back into the ratio. */
export function perMillion(ratio: number | null): number | null {
  if (ratio === null || !Number.isFinite(ratio) || ratio <= 0) return null;
  return Math.round((100 / ratio) * 100 + 1e-9) / 100;
}

export function yuan(value: string | number | null | undefined): string {
  const n = typeof value === "number" ? value : num(value ?? null);
  return n === null ? "未配置" : `¥${n.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

export function unitYuan(value: string | number | null | undefined): string {
  if (typeof value === "number") return Number.isFinite(value) ? `¥${value.toLocaleString("zh-CN", { minimumFractionDigits: 2, maximumFractionDigits: 8 })}` : "未配置";
  const raw = value?.trim();
  if (!raw || !/^-?\d+(\.\d{1,8})?$/.test(raw)) return "未配置";
  const [whole, fraction = ""] = raw.replace(/^-/, "").split(".");
  return `¥${raw.startsWith("-") ? "-" : ""}${BigInt(whole!).toLocaleString("zh-CN")}.${fraction.replace(/0+$/, "").padEnd(2, "0")}`;
}

export function centsYuan(cents: string | null | undefined): string {
  const n = num(cents ?? null);
  return n === null ? "未配置" : yuan(n / 100);
}

export function boundText(bound: RatioBound | undefined): string {
  if (!bound) return "未配置";
  if (bound.base === "ABSOLUTE") return bound.value;
  const v = num(bound.value);
  if (v === null) return "未配置";
  if (v === 0) return "基准";
  return `基准${v > 0 ? "+" : ""}${bound.value}`;
}

const BOX_LABELS: Record<string, string> = {
  "box-1x2": "1×2", "box-2x2": "2×2", "box-2x3": "2×3", "box-3x3": "3×3",
  "1x2": "1×2", "2x2": "2×2", "2x3": "2×3", "3x3": "3×3",
  "box-a": "标准箱 A", "box-b": "高级箱 B",
};
export function safeBoxLabel(code: string): string {
  return BOX_LABELS[code] ?? code;
}

export function haffCount(raw: string | null | undefined): string {
  const n = num(raw ?? null);
  if (n === null) return "未配置";
  return n % 1_000_000 === 0 ? `${n / 1_000_000}M` : n.toLocaleString("zh-CN");
}

export function unitLabel(unit: string, itemCode?: string): string {
  return ({ ROUND: "发", PIECE: unitText("PIECE", itemCode), DAY: "天", HAFF_BASE: "哈夫币" } as Record<string, string>)[unit] ?? unit;
}

export type ItemPriceRow = { item: CatalogItem; line: PriceLineRecord | null };

/** Standard-tier rows of one price version; the other member tiers are legacy compat data (folded, untouched). */
export function standardItemRows(rules: RulesResponse, priceVersionId: string): ItemPriceRow[] {
  const lines = rules.priceLines.filter((line) => line.priceVersionId === priceVersionId && (line.customerTier ?? "STANDARD") === "STANDARD");
  return rules.items.filter((item) => item.unit !== "HAFF_BASE").map((item) => ({ item, line: lines.find((line) => line.itemId === item.id) ?? null }));
}

export function compatTierCount(rules: RulesResponse, priceVersionId: string): number {
  return new Set(rules.priceLines.filter((line) => line.priceVersionId === priceVersionId && line.customerTier && line.customerTier !== "STANDARD").map((line) => line.customerTier)).size;
}

export function spread(buyer: string | null | undefined, owner: string | null | undefined): string {
  const scaled = (value: string | null | undefined) => {
    const raw = value?.trim(); if (!raw || !/^-?\d+(\.\d{1,8})?$/.test(raw)) return null;
    const [whole, fraction = ""] = raw.replace(/^-/, "").split(".");
    return (raw.startsWith("-") ? -1n : 1n) * (BigInt(whole!) * 100_000_000n + BigInt(fraction.padEnd(8, "0")));
  };
  const b = scaled(buyer), o = scaled(owner);
  if (b === null || o === null) return "未配置";
  const difference = b - o, absolute = difference < 0n ? -difference : difference;
  return unitYuan(`${difference < 0n ? "-" : ""}${absolute / 100_000_000n}.${(absolute % 100_000_000n).toString().padStart(8, "0")}`);
}

/** settlement.ts makeupExact: share of the haff spread the renter tops up after a voluntary early end. */
export function makeupShare(consumed: number): number {
  if (consumed <= 0.5) return 1 - consumed;
  if (consumed < 0.7) return (7 - 10 * consumed) / 4;
  return 0;
}

export type RuleDiffRow = { group: string; label: string; before: string; after: string };

const DIFF_LABELS: Record<string, string> = {
  mode: "计价方式", commissionRate: "平台抽成比例", roundingPolicy: "金额取整方式", compensationPolicyRef: "赔偿政策引用",
  schema: "规则格式", baseBySafeBox: "保险箱基准", vitalityDeltaByLevel: "体力调整", bearDeltaByLevel: "负重调整", dailyDeltaByTermOption: "每日消耗调整",
  compatibility: "兼容规则", ordinary: "普通 / 自定义", custom: "自定义", fast: "快速", spreadDelta: "比例差", discounts: "档位调整", modes: "模式", enabled: "启用状态", min: "下限", max: "上限", base: "基准类型", value: "数值",
  STANDARD: "普通", VIP: "VIP", SVIP: "SVIP", DISCOUNT_USER: "折扣用户", policyVersion: "政策版本", recommendation: "推荐押金", algorithm: "算法", version: "版本", currency: "币种", unit: "单位", inputSpec: "输入规范", parameters: "参数",
  safeBoxWeightsByCode: "保险箱加价（分）", vitalityAtLeast7Cents: "7 级体力加价（分）", bearAtLeast7Cents: "7 级负重加价（分）", diveAtLeast3Cents: "3 级潜水加价（分）", skinGroupById: "皮肤分组", skinWeights: "皮肤加价", skinRules: "类型与品质加价", skinOverrides: "单词条覆盖", ownerKind: "皮肤类型", rarityCode: "品质匹配", skinId: "皮肤词条", amountCents: "加价金额（分）", firstCents: "首件（分）", subsequentCents: "后续每件（分）", rounding: "推荐押金取整", upperLimitCents: "推荐押金上限（分）", unitCents: "取整单位（分）", zeroFallbackCents: "零值最低推荐（分）",
  ownerDepositRules: "账号押金约束", normal: "普通", fullPayoutSelected: "全额包赔", minCents: "最低值（分）", zeroAllowed: "允许零值", capCents: "押金上限（分）", guaranteeRequirement: "号主保证金", scope: "适用范围", requiredCents: "要求金额（分）", proofValidity: "凭证有效期", satisfiedMode: "满足方式", satisfiedDays: "天数", vipWaiver: "VIP 豁免", svipWaiver: "SVIP 豁免", fullPayoutPolicyRef: "包赔条款引用", fullPayoutPolicyVersion: "包赔条款版本", disclosureVersion: "披露版本",
  pricingKind: "计价类型", unitQuantity: "计费单位数量", buyerUnitAmount: "租客单价（元）", ownerUnitAmount: "号主单价（元）", name: "名称", dailyConsumption: "每日消耗（哈夫币）", durationRounding: "租期取整", title: "标题", body: "正文", digest: "正文摘要",
};

/** Compare every business leaf, including unknown future fields, without rounding away a difference. */
function appendDiff(rows: RuleDiffRow[], group: string, label: string, before: unknown, after: unknown): void {
  const object = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
  if (object(before) || object(after)) {
    const a = object(before) ? before : {}, b = object(after) ? after : {};
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    if (keys.size) { for (const key of keys) appendDiff(rows, group, `${label}${label ? " · " : ""}${DIFF_LABELS[key] ?? safeBoxLabel(key)}`, a[key], b[key]); return; }
  }
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  const text = (value: unknown) => value === undefined ? "未提供" : value === null ? "未配置" : typeof value === "boolean" ? value ? "是" : "否" : typeof value === "object" ? JSON.stringify(value) : String(value);
  rows.push({ group, label: label || "规则内容", before: text(before), after: text(after) });
}

export function priceDiff(rules: RulesResponse, fromId: string | undefined, toId: string | undefined): RuleDiffRow[] {
  if (!toId || fromId === toId) return [];
  const a = fromId ? rules.priceVersions.find((v) => v.id === fromId) : undefined;
  const b = rules.priceVersions.find((v) => v.id === toId);
  if (!b) return [{ group: "价格规则", label: "所选版本", before: fromId ?? "未提供", after: "版本内容未提供，无法完成对比" }];
  const rows: RuleDiffRow[] = [];
  for (const key of ["mode", "commissionRate", "roundingPolicy", "compensationPolicyRef"] as const) appendDiff(rows, "价格规则", DIFF_LABELS[key]!, a?.[key], b[key]);
  appendDiff(rows, "哈夫币价格", "", a?.haffRule, b.haffRule);
  appendDiff(rows, "押金规则", "", a?.fundingPolicy, b.fundingPolicy);
  const lines = (id: string | undefined) => rules.priceLines.filter((line) => line.priceVersionId === id);
  const ra = lines(fromId), rb = lines(toId);
  for (const key of new Set([...ra, ...rb].map((line) => `${line.itemId}\u0000${line.customerTier ?? "STANDARD"}`))) {
    const find = (list: PriceLineRecord[]) => list.find((line) => `${line.itemId}\u0000${line.customerTier ?? "STANDARD"}` === key);
    const x = find(ra), y = find(rb), ref = y ?? x!;
    const label = `${rules.items.find((item) => item.id === ref.itemId)?.name ?? ref.itemId} · ${DIFF_LABELS[ref.customerTier ?? "STANDARD"]}`;
    for (const field of ["pricingKind", "unitQuantity", "buyerUnitAmount", "ownerUnitAmount"] as const) appendDiff(rows, "物品单价", `${label} · ${DIFF_LABELS[field]}`, x?.[field], y?.[field]);
  }
  return rows;
}

export function termOptionsText(rules: RulesResponse, versionId: string | undefined): string {
  if (!versionId) return "无";
  return rules.termOptions.filter((o) => o.versionId === versionId).map((o) => `${o.name} ${haffCount(o.dailyConsumption)}/天`).join("、") || "无";
}

export function termDiff(rules: RulesResponse, fromId: string | undefined, toId: string | undefined): RuleDiffRow[] {
  if (!toId || fromId === toId) return [];
  const rows: RuleDiffRow[] = [];
  const a = rules.termOptions.filter((o) => o.versionId === fromId), b = rules.termOptions.filter((o) => o.versionId === toId);
  if (!rules.termVersions.some(v => v.id === toId)) return [{ group: "租期与每日消耗", label: "所选版本", before: fromId ?? "未提供", after: "版本内容未提供，无法完成对比" }];
  for (const code of new Set([...a, ...b].map(o => o.code))) for (const field of ["name", "dailyConsumption", "durationRounding"] as const) appendDiff(rows, "租期与每日消耗", `${code} · ${DIFF_LABELS[field]}`, a.find(o => o.code === code)?.[field], b.find(o => o.code === code)?.[field]);
  return rows;
}

export function agreementDiff(rules: RulesResponse, fromId: string | undefined, toId: string | undefined): RuleDiffRow[] {
  if (!toId || fromId === toId) return [];
  const rows: RuleDiffRow[] = [], a = rules.agreementVersions.find(v => v.id === fromId), b = rules.agreementVersions.find(v => v.id === toId);
  if (!b) return [{ group: "出租协议", label: "所选版本", before: fromId ?? "未提供", after: "版本内容未提供，无法完成对比" }];
  for (const field of ["title", "body", "digest"] as const) appendDiff(rows, "出租协议", DIFF_LABELS[field]!, a?.[field], b[field]);
  return rows;
}

export function payoutRef(price: PriceVersionRecord | undefined): string | null {
  const p = price?.fundingPolicy;
  return p ? `${p.fullPayoutPolicyRef} · 第 ${p.fullPayoutPolicyVersion} 版` : null;
}

export const REASON_TEXT: Record<string, string> = {
  DEPENDENCY_UNAVAILABLE: "依赖的规则或物品不可用",
  ROUNDING_POLICY_UNSUPPORTED: "取整方式不受支持",
  INVALID_QUANTITY: "数量不合法",
  INVALID_DENOMINATOR: "比例不合法（可能低于比例差）",
  RULE_INPUT_MISSING: "缺少计价条件或价格未配置",
  TERM_UNDETERMINED: "租期无法确定",
  EXPIRY_UNKNOWN: "到期时间未知",
};
