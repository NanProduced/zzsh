import type { PriceVersionRecord, RulesResponse } from "../../api";
import { asHaffV2 } from "./rules-model.ts";

/**
 * 选中极速草稿的正式试算（复用服务端 /supply/quote-preview，不在前端复制定价算法）。
 * 请求绑定草稿 id + revision（expectedRevision，草稿被改则 409）、rentalMode=fast、号主比例 B 与库存；
 * 服务端回执 binding 与本次签名不一致时结果作废。
 */
export type DraftTrialInput = { ownerRatioB: string; haffM: string; box: string; vit: string; bear: string; term: string };
export type DraftTrialBinding = { priceVersionId: string; priceVersionRevision: string; rentalMode: string | null; ownerRatioB: string | null; inventory: { itemId: string; quantity: string }[] };

const B_RE = /^(0|[1-9]\d*)(\.\d{1,2})?$/;

export function draftTrialRequest(rules: RulesResponse, version: PriceVersionRecord | undefined, input: DraftTrialInput):
  { ok: true; body: Record<string, unknown>; signature: string; expected: DraftTrialBinding } | { ok: false; errors: Record<string, string> } {
  const errors: Record<string, string> = {};
  const haff = asHaffV2(version?.haffRule);
  if (!version || version.status !== "DRAFT") errors.version = "请选择价格草稿";
  else if (!haff) errors.version = "草稿尚未保存完整的兼容比例规则，先保存模式草稿";
  else if (!haff.compatibility.modes.fast.enabled) errors.version = "所选草稿未启用极速模式";
  if (!rules.release) errors.version = "当前没有生效版本，无法确定消耗档版本";
  if (!B_RE.test(input.ownerRatioB.trim()) || Number(input.ownerRatioB) <= 0) errors.ownerRatioB = "号主比例 B 须为正数，最多两位小数";
  let raw = "";
  if (!/^\d+(\.\d{1,6})?$/.test(input.haffM)) errors.haffM = "填入大于 0 的 M 数，最多六位小数";
  else { const [w, f = ""] = input.haffM.split("."); raw = BigInt(`${w}${f.padEnd(6, "0")}`).toString(); if (raw === "0" || raw.length > 24) errors.haffM = "哈夫币数量须大于 0"; }
  if (haff && !Object.hasOwn(haff.baseBySafeBox, input.box)) errors.box = "请选择草稿已配置的保险箱";
  if (haff && !Object.hasOwn(haff.vitalityDeltaByLevel, input.vit)) errors.vit = "请选择已配置等级";
  if (haff && !Object.hasOwn(haff.bearDeltaByLevel, input.bear)) errors.bear = "请选择已配置等级";
  if (!rules.termOptions.some((o) => o.versionId === rules.release?.termVersionId && o.code === input.term)) errors.term = "请选择当前版本的消耗档";
  const haffItem = rules.items.find((i) => i.enabled && i.unit === "HAFF_BASE");
  if (!haffItem) errors.haffM = "当前目录未提供可用的哈夫币物品";
  if (Object.keys(errors).length) return { ok: false, errors };
  const ownerRatioB = input.ownerRatioB.trim(), inventory = [{ itemId: haffItem!.id, quantity: raw }];
  const body = {
    priceVersionId: version!.id, expectedRevision: version!.revision, termVersionId: rules.release!.termVersionId,
    conditions: { safeBoxCode: input.box, vitLevel: Number(input.vit), bearLevel: Number(input.bear), termOptionCode: input.term, rentalPricing: { rentalMode: "fast", ownerRatioB } },
    inventory,
  };
  const expected: DraftTrialBinding = { priceVersionId: version!.id, priceVersionRevision: version!.revision, rentalMode: "fast", ownerRatioB, inventory };
  return { ok: true, body, signature: JSON.stringify(body), expected };
}

/** B 的十进制规范形（去尾零），纯字符串比较，不经 Number；格式不合法返回 null。 */
export function canonicalB(value: unknown): string | null {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)(\.\d+)?$/.test(value)) return null;
  const [whole, fraction = ""] = value.split(".");
  const f = fraction.replace(/0+$/, "");
  return f ? `${whole}.${f}` : whole!;
}

/** 服务端 binding 须逐项对应（B 按十进制精确比较：仅允许尾零差异）。 */
export function bindingMatches(actual: Partial<DraftTrialBinding> | undefined, expected: DraftTrialBinding): boolean {
  if (!actual) return false;
  const inv = (x: DraftTrialBinding["inventory"] | undefined) => JSON.stringify([...(x ?? [])].sort((a, b) => (a.itemId < b.itemId ? -1 : 1)));
  return actual.priceVersionId === expected.priceVersionId && actual.priceVersionRevision === expected.priceVersionRevision && actual.rentalMode === expected.rentalMode
    && canonicalB(actual.ownerRatioB) !== null && canonicalB(actual.ownerRatioB) === canonicalB(expected.ownerRatioB) && inv(actual.inventory) === inv(expected.inventory);
}