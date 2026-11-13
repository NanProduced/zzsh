/** 规则页分区：同一页签内切换，全部保持挂载，切换不丢未保存输入。 */
export const RULES_SECTIONS = ["overview", "deposit", "settlement", "agreement", "pricing", "items", "skin"] as const;
export type RulesSection = typeof RULES_SECTIONS[number];
export const RULES_SECTION_LABEL: Record<RulesSection, string> = { overview: "规则总览", deposit: "押金规则", settlement: "结算与退赔", agreement: "出租协议", pricing: "租赁定价", items: "物资价目", skin: "皮肤推荐押金" };
export function rulesSection(value: string | undefined): RulesSection {
  return (RULES_SECTIONS as readonly string[]).includes(value ?? "") ? value as RulesSection : "overview";
}
export const PRICING_TABS = [["base", "基础计价"], ["mode", "租赁模式"], ["term", "租期与每日消耗"], ["schedule", "调价排期"]] as const;
export type PricingTab = typeof PRICING_TABS[number][0];
/** 三角洲行动专属分区；其他游戏显示未适配。 */
export const DELTA_GAME_CODE = "delta";

export type TermOptionDraft = { code: string; name: string; dailyConsumption: string };

export function modeLabel(mode: string): string {
  return mode === "SPREAD" ? "差价" : mode === "PERCENT" ? "百分比" : mode;
}

export function statusLabel(status: string): string {
  return status === "SEALED" ? "已封存" : status === "DRAFT" ? "草稿" : status;
}

export function kindLabel(kind: string): string {
  return kind === "HAFF_RATIO" ? "按哈夫币规则推算" : kind === "FIXED_UNIT" ? "固定单价" : kind;
}

export function latestSealed<T extends { id: string; status: string; sealedAt: string | null; createdAt: string }>(versions: T[]): string {
  const sealed = versions.filter(version => version.status === "SEALED").sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0];
  return sealed?.id ?? "";
}
