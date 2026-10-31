import type { PriceLineRecord, PriceVersionRecord, RulesResponse } from "../../api";

/**
 * Step 0 共享草稿模型：一次编辑会话只针对一个显式选中的价格草稿（gameId + draftId）。
 * 分页签保存只提交本页签负责的字段；服务端对未提交字段保持原值（PUT 局部更新）。
 * Owner 决定：新草稿的物资价目只写普通（STANDARD）档位，VIP/SVIP/优惠用户档位不再随新草稿复制；已封存版本不变。
 */
export type StandardLineBody = { itemId: string; customerTier: "STANDARD"; pricingKind: PriceLineRecord["pricingKind"]; unitQuantity?: string; buyerUnitAmount?: string; ownerUnitAmount?: string };

export function standardLineBodies(lines: PriceLineRecord[], mode: PriceVersionRecord["mode"]): StandardLineBody[] {
  return lines.filter(line => (line.customerTier ?? "STANDARD") === "STANDARD").map(({ itemId, pricingKind, unitQuantity, buyerUnitAmount, ownerUnitAmount }) => ({
    itemId, customerTier: "STANDARD" as const, pricingKind,
    ...(pricingKind === "FIXED_UNIT" ? { unitQuantity: unitQuantity ?? "1", buyerUnitAmount: buyerUnitAmount ?? "", ...(mode === "SPREAD" && ownerUnitAmount !== null ? { ownerUnitAmount } : {}) } : {}),
  }));
}

/** 编辑基线来源：当前生效价格版本，缺省时取最新封存版本。 */
export function sourcePriceVersion(rules: RulesResponse): PriceVersionRecord | undefined {
  return rules.priceVersions.find(v => v.id === rules.release?.priceVersionId) ?? rules.priceVersions.find(v => v.status === "SEALED");
}

export function draftHasLines(rules: RulesResponse, id: string): boolean {
  return rules.priceLines.some(line => line.priceVersionId === id);
}

/**
 * 组装一次价格草稿保存：patch 为本页签负责的字段。目标草稿仍为空（刚新建）时，
 * 从来源版本补齐其余合同字段（普通档位价目、哈夫币规则、取整、资金政策），保证草稿完整可封存。
 */
export function priceSaveBody(rules: RulesResponse, target: PriceVersionRecord, patch: Record<string, unknown>): Record<string, unknown> {
  const body: Record<string, unknown> = { expectedRevision: target.revision, ...patch };
  const source = sourcePriceVersion(rules);
  if (!draftHasLines(rules, target.id) && !("lines" in patch)) {
    const lines = source ? rules.priceLines.filter(line => line.priceVersionId === source.id) : [];
    if (!source || !lines.length) throw new Error("缺少可复用的价格行，请先在「物资价目」中填写并保存价目。");
    const mode = (patch.mode as PriceVersionRecord["mode"] | undefined) ?? source.mode;
    if (!("mode" in patch)) { body.mode = source.mode; if (source.commissionRate !== null && !("commissionRate" in patch)) body.commissionRate = source.commissionRate; }
    body.lines = standardLineBodies(lines, mode);
  }
  if (source) {
    if (target.haffRule === null && !("haffRule" in patch) && source.haffRule) body.haffRule = source.haffRule;
    if (!target.fundingPolicy && !("fundingPolicy" in patch) && source.fundingPolicy) body.fundingPolicy = source.fundingPolicy;
    if (!("roundingPolicy" in patch) && !target.roundingPolicy && source.roundingPolicy) body.roundingPolicy = source.roundingPolicy;
  }
  return body;
}

export type SealCheck = { label: string; ok: boolean; section?: "pricing" | "items" | "skin"; detail?: string; failLabel?: string };
