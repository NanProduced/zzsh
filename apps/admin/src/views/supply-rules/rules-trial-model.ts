import type { RulesResponse } from "../../api";
import { editContext, type EditValues } from "./rules-edit";
import { num } from "./rules-model";

export type TrialAccount = { haffM: string; box: string; vit: string; bear: string; dive: string; term: string; items: Record<string, string> };
export type TrialRow = { key: string; label: string; tenant: number | null; owner: number | null };
export const roundTrialAmount = (n: number) => Math.round(n * 100 + 1e-9) / 100;
const decimal = (s: string | undefined) => typeof s === "string" && /^-?\d+(\.\d{1,8})?$/.test(s) ? num(s) : null;

export function validateTrialAccount(rules: RulesResponse, account: TrialAccount) {
  const errors: Record<string, string> = {}, { haff } = editContext(rules);
  let rawHaff = "";
  if (!/^\d+(\.\d{1,6})?$/.test(account.haffM)) errors.haffM = "填入大于 0 的 M 数，最多六位小数";
  else {
    const [whole, fraction = ""] = account.haffM.split(".");
    rawHaff = BigInt(`${whole}${fraction.padEnd(6, "0")}`).toString();
    if (rawHaff === "0" || rawHaff.length > 24) errors.haffM = "哈夫币数量须大于 0，且不能超过接口范围";
  }
  if (!haff) errors.haff = "当前哈夫币规则不是完整的 haff-ratio-v2，本页暂不支持换算与试算，请核对原始配置。";
  else if (!Object.hasOwn(haff.baseBySafeBox, account.box)) errors.box = "请选择已配置的保险箱";
  for (const [key, map] of [["vit", haff?.vitalityDeltaByLevel], ["bear", haff?.bearDeltaByLevel]] as const) {
    if (!map || !Object.hasOwn(map, account[key]) || !/^\d+$/.test(account[key]) || !Number.isSafeInteger(Number(account[key]))) errors[key] = "请选择已配置等级";
  }
  if (!/^\d+$/.test(account.dive) || !Number.isSafeInteger(Number(account.dive))) errors.dive = "潜水等级须为非负整数";
  if (!rules.termOptions.some(option => option.versionId === rules.release?.termVersionId && option.code === account.term)) errors.term = "请选择当前版本的消耗档";
  const fixed = rules.items.filter(item => item.enabled && item.unit !== "HAFF_BASE");
  for (const item of fixed) {
    const value = account.items[item.id] ?? "";
    if (value !== "" && !/^(0|[1-9]\d{0,23})$/.test(value)) errors[`item.${item.id}`] = "数量须为非负整数；留空表示未选择";
  }
  const haffItem = rules.items.find(item => item.enabled && item.unit === "HAFF_BASE");
  if (!haffItem) errors.haffM = "当前目录未提供可用的哈夫币物品";
  const inventory = haffItem && !errors.haffM ? [{ itemId: haffItem.id, quantity: rawHaff }, ...fixed.filter(item => account.items[item.id] !== undefined && account.items[item.id] !== "" && !errors[`item.${item.id}`]).map(item => ({ itemId: item.id, quantity: account.items[item.id]! }))] : [];
  return { ready: Object.keys(errors).length === 0 && Boolean(rules.release), errors, inventory, rawHaff };
}

/** An estimate requires every selected parameter. Missing configuration never becomes a numeric zero. */
export function trialEstimate(rules: RulesResponse, values: EditValues, account: TrialAccount, priceVersionId?: string) {
  const invalid = (message: string) => ({ rows: null as TrialRow[] | null, ratio: null as number | null, days: null as number | null, message });
  if (!validateTrialAccount(rules, account).ready) return invalid("待计算：账号条件尚未填写完整或有误。");
  const { haff, price } = editContext(rules, priceVersionId);
  if (!haff || price?.mode !== "SPREAD" || !haff.compatibility.modes.ordinary.enabled) return invalid("当前计价规则暂不支持本地普通模式估算；可继续核对左侧服务端结果。");
  const keys = [`haff.base.${account.box}`, `haff.vit.${account.vit}`, `haff.bear.${account.bear}`, `haff.daily.${account.term}`];
  const parts = keys.map(key => decimal(values[key])), spread = decimal(values["haff.spread.ordinary"]), discount = decimal(haff.compatibility.ordinary.discounts.STANDARD);
  const daily = decimal(values[`term.${account.term}.daily`]);
  if (parts.some(value => value === null) || spread === null || spread < 0 || discount === null || discount < 0 || daily === null || daily <= 0) return invalid("待计算：所选比例、普通档调整或每日消耗缺失 / 非法。");
  const owner = parts.reduce<number>((sum, part) => sum + part!, 0), tenant = owner - spread + discount;
  if (owner <= 0 || tenant <= 0) return invalid("无法报价：号主比例与租客比例都须大于 0。");
  const amount = Number(account.haffM), days = Math.ceil(amount / daily);
  if (!Number.isSafeInteger(days) || days <= 0) return invalid("无法报价：可租天数超出可展示范围。");
  const rows: TrialRow[] = [{ key: rules.items.find(item => item.unit === "HAFF_BASE")!.id, label: `哈夫币 × ${account.haffM}M`, tenant: roundTrialAmount(amount * 100 / tenant), owner: roundTrialAmount(amount * 100 / owner) }];
  for (const item of rules.items.filter(item => item.enabled && item.unit !== "HAFF_BASE" && account.items[item.id] !== undefined && account.items[item.id] !== "")) {
    const line = rules.priceLines.find(line => line.priceVersionId === price.id && line.itemId === item.id && (line.customerTier ?? "STANDARD") === "STANDARD");
    const buyer = decimal(values[`item.${item.id}.buyer`]), seller = decimal(values[`item.${item.id}.owner`]);
    // No price line means no contracted billing quantity; assuming 1 would invent
    // a per-unit price the server has never configured.
    if (!line) return invalid(`无法报价：${item.name} 没有普通档计费单位行，需先有正式计费数量（不按 1 计价）。`);
    const unit = num(line.unitQuantity);
    if (line.pricingKind !== "FIXED_UNIT") return invalid(`无法报价：${item.name} 不是按固定单价计价。`);
    if (unit === null || unit <= 0) return invalid(`无法报价：${item.name} 的计费单位数量未配置 / 非法。`);
    if (buyer === null || buyer < 0 || seller === null || seller < 0) return invalid(`无法报价：${item.name} 的普通档单价未配置 / 非法。`);
    const quantity = Number(account.items[item.id]);
    rows.push({ key: item.id, label: `${item.name} × ${account.items[item.id]}`, tenant: roundTrialAmount(quantity / unit * buyer), owner: roundTrialAmount(quantity / unit * seller) });
  }
  if (rows.some(row => !Number.isFinite(row.tenant) || !Number.isFinite(row.owner))) return invalid("无法报价：金额超出可展示范围。");
  return { rows: rows as TrialRow[] | null, ratio: owner as number | null, days: days as number | null, message: "" };
}

export function trialDeposit(rules: RulesResponse, values: EditValues, account: TrialAccount, priceVersionId?: string): number | null {
  if (!validateTrialAccount(rules, account).ready) return null;
  const { policy } = editContext(rules, priceVersionId);
  if (!policy || policy.recommendation.algorithm !== "delta-deposit-owner-declared-v1" || policy.recommendation.parameters.rounding.mode !== "CEIL") return null;
  const box = decimal(values[`dep.box.${account.box}`]), cap = decimal(values["dep.cap"]);
  const unit = num(policy.recommendation.parameters.rounding.unitCents), zero = num(policy.recommendation.parameters.rounding.zeroFallbackCents);
  if (box === null || box < 0 || cap === null || cap <= 0 || unit === null || unit <= 0 || zero === null || zero < 0) return null;
  let total = box;
  for (const [level, threshold, key] of [[account.vit, 7, "dep.vit7"], [account.bear, 7, "dep.bear7"], [account.dive, 3, "dep.dive3"]] as const) if (Number(level) >= threshold) {
    const add = decimal(values[key]); if (add === null || add < 0) return null; total += add;
  }
  return Math.min(total === 0 ? zero / 100 : Math.ceil(total / (unit / 100)) * (unit / 100), cap);
}

export function clampTrialPosition(position: { x: number; y: number }, viewport: { width: number; height: number }, size: { width: number; height: number }) {
  return { x: Math.max(8, Math.min(position.x, viewport.width - size.width - 8)), y: Math.max(8, Math.min(position.y, viewport.height - size.height - 8)) };
}
