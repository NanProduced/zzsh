import type { FundingPolicy, PriceVersionRecord, RulesResponse } from "../../api";
import { asHaffV2, num, safeBoxLabel, type HaffV2 } from "./rules-model";

/**
 * 规则与价目 · 整页编辑模式的纯模型。
 * 基线＝当前生效版本；只用于本地编辑与试算，不编排草稿写入。审批接入时另核草稿归属及逐步原回执。
 */
export type EditValues = Record<string, string>;
export type EditField = { key: string; group: "哈夫币价格" | "物品单价" | "押金规则" | "租期与每日消耗"; label: string; unit?: string };
export type ChangeRow = EditField & { before: string; after: string };


export type EditContext = { price?: PriceVersionRecord; haff: HaffV2 | null; policy: FundingPolicy | null; termVersionId?: string };

/** priceVersionId 省略时取线上版本；传入时按该版本（如草稿）读取。 */
export function editContext(rules: RulesResponse, priceVersionId?: string): EditContext {
  const r = rules.release;
  const id = priceVersionId ?? r?.priceVersionId;
  const price = id ? rules.priceVersions.find((v) => v.id === id) : undefined;
  return { price, haff: asHaffV2(price?.haffRule), policy: price?.fundingPolicy ?? null, termVersionId: r?.termVersionId };
}

const centsToYuan = (c: string) => { const n = num(c); return n === null ? "" : String(n / 100); };
const normAmt = (x: string | null) => {
  if (x === null || !/^\d+(\.\d{1,8})?$/.test(x.trim())) return "";
  const [whole, fraction = ""] = x.trim().split("."), tail = fraction.replace(/0+$/, "");
  return `${whole!.replace(/^0+(?=\d)/, "")}${tail ? `.${tail}` : ""}`;
};
const rawToM = (raw: string) => { const n = num(raw); return n === null ? "" : String(n / 1e6); };

/** All editable fields with their baseline (current effective) values. */
export function baseline(rules: RulesResponse, priceVersionId?: string): { fields: EditField[]; values: EditValues } {
  const ctx = editContext(rules, priceVersionId); const fields: EditField[] = []; const values: EditValues = {};
  const add = (f: EditField, v: string | null | undefined) => { fields.push(f); values[f.key] = v ?? ""; };
  const { haff, policy, price } = ctx;
  if (haff) {
    for (const [code, b] of Object.entries(haff.baseBySafeBox)) add({ key: `haff.base.${code}`, group: "哈夫币价格", label: `${safeBoxLabel(code)} 号主比例` }, b);
    add({ key: "haff.spread.ordinary", group: "哈夫币价格", label: "比例差（普通/自定义）" }, haff.compatibility.ordinary.spreadDelta);
    // 极速 lane 缺省（极速关闭）时不生成该字段；极速参数在“租赁模式配置”中单独维护。
    if (haff.compatibility.fast) add({ key: "haff.spread.fast", group: "哈夫币价格", label: "比例差（快速）" }, haff.compatibility.fast.spreadDelta);
    for (const [l, d] of Object.entries(haff.vitalityDeltaByLevel)) add({ key: `haff.vit.${l}`, group: "哈夫币价格", label: `体力 ${l} 级比例调整` }, d);
    for (const [l, d] of Object.entries(haff.bearDeltaByLevel)) add({ key: `haff.bear.${l}`, group: "哈夫币价格", label: `负重 ${l} 级比例调整` }, d);
    for (const [c, d] of Object.entries(haff.dailyDeltaByTermOption)) add({ key: `haff.daily.${c}`, group: "租期与每日消耗", label: `${rules.termOptions.find((o) => o.code === c && o.versionId === ctx.termVersionId)?.name ?? c} 号主比例调整` }, d);
  }
  if (price) {
    for (const line of rules.priceLines.filter((l) => l.priceVersionId === price.id && l.pricingKind === "FIXED_UNIT" && (l.customerTier ?? "STANDARD") === "STANDARD")) {
      const name = rules.items.find((i) => i.id === line.itemId)?.name ?? line.itemId;
      add({ key: `item.${line.itemId}.buyer`, group: "物品单价", label: `${name} 租客价`, unit: "元" }, normAmt(line.buyerUnitAmount));
      if (price.mode === "SPREAD") add({ key: `item.${line.itemId}.owner`, group: "物品单价", label: `${name} 号主价`, unit: "元" }, normAmt(line.ownerUnitAmount));
    }
    for (const item of rules.items.filter((i) => i.enabled && i.unit !== "HAFF_BASE")) {
      if (!fields.some((f) => f.key === `item.${item.id}.buyer`)) {
        add({ key: `item.${item.id}.buyer`, group: "物品单价", label: `${item.name} 租客价`, unit: "元" }, "");
        if (price.mode === "SPREAD") add({ key: `item.${item.id}.owner`, group: "物品单价", label: `${item.name} 号主价`, unit: "元" }, "");
      }
    }
  }
  if (policy) {
    const p = policy.recommendation.parameters;
    add({ key: "dep.cap", group: "押金规则", label: "押金上限", unit: "元" }, centsToYuan(p.upperLimitCents));
    for (const [c, v] of Object.entries(p.safeBoxWeightsByCode)) add({ key: `dep.box.${c}`, group: "押金规则", label: `${safeBoxLabel(c)} 保险箱`, unit: "元" }, centsToYuan(v));
    add({ key: "dep.vit7", group: "押金规则", label: "7 级体力", unit: "元" }, centsToYuan(p.vitalityAtLeast7Cents));
    add({ key: "dep.bear7", group: "押金规则", label: "7 级负重", unit: "元" }, centsToYuan(p.bearAtLeast7Cents));
    add({ key: "dep.dive3", group: "押金规则", label: "3 级潜水", unit: "元" }, centsToYuan(p.diveAtLeast3Cents));
  }
  // 缺正式资金政策时不生成押金字段：页面对应位置显示“资金政策未提供”，不按默认值可编辑。
  for (const o of rules.termOptions.filter((o) => o.versionId === ctx.termVersionId)) add({ key: `term.${o.code}.daily`, group: "租期与每日消耗", label: `${o.name} 每天消耗`, unit: "M" }, rawToM(o.dailyConsumption));
  return { fields, values };
}

export function changes(fields: EditField[], before: EditValues, after: EditValues): ChangeRow[] {
  return fields.filter((f) => (after[f.key] ?? "").trim() !== (before[f.key] ?? "").trim()).map((f) => ({ ...f, before: before[f.key] ?? "", after: (after[f.key] ?? "").trim() }));
}

const DEC = /^\d+(\.\d{1,2})?$/; const SIGNED = /^-?\d+(\.\d+)?$/;
/** Field-level validation; returns a message per invalid key. */
export function validate(fields: EditField[], v: EditValues): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const f of fields) {
    const x = (v[f.key] ?? "").trim();
    if (x !== "" && !Number.isFinite(Number(x))) { errors[f.key] = "数值超出可用范围"; continue; }
    if (f.key.startsWith("haff.base.")) { if (!/^\d+(\.\d{1,2})?$/.test(x) || !Number.isFinite(Number(x)) || Number(x) <= 0) errors[f.key] = "须为大于 0 的数，最多两位小数"; }
    else if (f.key.startsWith("haff.")) { if (!SIGNED.test(x) || !Number.isFinite(Number(x)) || (x.split(".")[1]?.length ?? 0) > 2) errors[f.key] = "须为数字，最多两位小数"; }
    else if (f.key.startsWith("term.")) { if (!/^\d+(\.\d{1,6})?$/.test(x) || Number(x) <= 0) errors[f.key] = "须为大于 0 的 M 数"; }
    else if (f.key.startsWith("item.")) { if (x !== "" && (!/^\d+(\.\d{1,2})?$/.test(x) || !Number.isFinite(Number(x)))) errors[f.key] = "须为非负金额，最多两位小数"; }
    else if (!DEC.test(x)) errors[f.key] = "金额最多两位小数";
  }
  if (v["dep.cap"] !== undefined && !errors["dep.cap"] && Number(v["dep.cap"]) < 300) errors["dep.cap"] = "上限不能低于 300 元（全额包赔最低押金）";
  const p = num(v["haff.spread.ordinary"] ?? null);
  for (const f of fields) if (f.key.startsWith("haff.base.") && !errors[f.key] && p !== null && Number(v[f.key]) - p <= 0) errors[f.key] = "租客比例（基准−比例差）须大于 0";
  return errors;
}
