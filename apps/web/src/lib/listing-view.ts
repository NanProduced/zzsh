import type { Money, PublicListing, PublicCodeLabel } from "./supply-types.ts";

export type ResourceLine = {
  itemId: string;
  code: string | null;
  name: string;
  quantity: string;
  quantityLabel: string;
  unitLabel: string;
  costAmount: string | null;
  costLabel: string | null;
  unitPriceLabel: string | null;
};
export type ConditionLine = { key: string; label: string; value: string };
export type SkinTag = {
  name: string;
  categoryCode: string | null;
  categoryName: string | null;
};
export type ListingMedia = { assetId: string; url: string };
export type ListingCardData = {
  id: string;
  displayNo: string | null;
  title: string;
  imageUrl?: string;
  media: ListingMedia[];
  resourceLines: ResourceLine[];
  resourceTotalLabel: string;
  depositLabel: string | null;
  payableTotalLabel: string | null;
  termLabel: string;
  termOptionLabel: string | null;
  quoteSourceLabel: string;
  conditionLines: ConditionLine[];
  loginMethod: PublicCodeLabel | null;
  skinNames: string[];
  skinLabels: string[];
  skinTags: SkinTag[];
  entitlementNames: string[];
};
export type ListingDetailData = ListingCardData & {
  description: string | null;
  gameName: string | null;
};

const UNIT_LABELS: Record<string, string> = { HAFF_BASE: "哈夫币", ROUND: "发", PIECE: "件", DAY: "天" };
const CONDITION_LABELS: Record<string, string> = {
  safe_box_code: "安全箱",
  vit_level: "体力等级",
  bear_level: "负重等级",
  dive_level: "潜水等级",
  character_level: "角色等级",
  grading_code: "段位",
  login_method_code: "登录方式",
  region_province: "省份",
  region_city: "城市",
  secret_kd: "绝密 KD",
};
const CONDITION_LEVELS = new Set(["vit_level", "bear_level", "dive_level", "character_level"]);

export function unitLabel(unit: string): string {
  return UNIT_LABELS[unit] ?? unit;
}
export function formatMoneyLabel(money: Money | null | undefined): string | null {
  return money ? `¥${money.amount}` : null;
}
// Base HAFF quantity uses 1,000,000 base units = 1 M (display only; the server amount is authoritative).
export function haffMillionsLabel(quantity: string): string {
  if (!/^\d{1,24}$/.test(quantity)) return quantity;
  const value = BigInt(quantity);
  const millions = value / 1_000_000n;
  const remainder = value % 1_000_000n;
  if (remainder === 0n) return millions.toString();
  return `${millions}.${remainder.toString().padStart(6, "0").replace(/0+$/, "")}`;
}
export function termLabel(termSeconds: string | undefined): string {
  if (!termSeconds || !/^\d{1,18}$/.test(termSeconds)) return "以平台确认的租期为准";
  const seconds = BigInt(termSeconds);
  if (seconds <= 0n) return "以平台确认的租期为准";
  const days = seconds / 86_400n;
  const rest = seconds % 86_400n;
  if (rest === 0n) return `${days} 天`;
  const tenths = (seconds * 10n + 86_399n) / 86_400n;
  return `${tenths / 10n}.${tenths % 10n} 天`;
}
export function haffRatioLabel(quantity: string, costAmount: string | null): string {
  if (!/^\d+$/.test(quantity) || !costAmount) return "待确认";
  const match = costAmount.trim().match(/^(\d+)(?:\.(\d+))?$/);
  if (!match) return "待确认";
  const fractional = match[2] ?? "";
  const amountNumerator = BigInt(match[1] + fractional);
  if (amountNumerator <= 0n) return "待确认";
  const amountScale = 10n ** BigInt(fractional.length);
  const ratioNumerator = BigInt(quantity) * amountScale;
  const ratioDenominator = 10_000n * amountNumerator;
  const ratio = (2n * ratioNumerator + ratioDenominator) / (2n * ratioDenominator);
  return ratio > 0n ? `${ratio}万/元` : "待确认";
}
function quantityLabel(unit: string, quantity: string, code: string | undefined, unitQuantity: string): string {
  if (unit === "HAFF_BASE") return `${haffMillionsLabel(quantity)} M`;
  if (unit === "ROUND" && code === "df_billable_level6_bullet" && unitQuantity === "60" && /^\d+$/.test(quantity)) {
    const rounds = BigInt(quantity);
    if (rounds % 60n === 0n) return `${rounds / 60n}组（${rounds}发）`;
  }
  return quantity;
}
function unmapped(label: PublicCodeLabel | null | undefined, raw: unknown): string {
  const code = label?.code ?? (raw === null || raw === undefined || raw === "" ? "" : String(raw));
  return code ? `未确认（代码 ${code}）` : "未确认";
}
function mappedCodeValue(
  label: PublicCodeLabel | null | undefined,
  raw: unknown,
): string {
  return label?.displayName ?? unmapped(label, raw);
}
function dailyConsumptionLabel(termOption: PublicListing["termOption"]): string | null {
  const quantity = termOption?.dailyConsumption?.quantity;
  return quantity ? `${haffMillionsLabel(quantity)} M 哈夫币` : null;
}
function presentationItemName(item: { code?: string; name: string } | undefined, itemId: string): string {
  if (item?.code === "df_billable_level6_bullet") return "6级子弹";
  return item?.name ?? `未确认（代码 ${itemId}）`;
}
export function conditionLines(
  attributes: PublicListing["attributes"],
  context: Pick<PublicListing, "attributeDisplay" | "safeBox" | "termOption"> = {},
): ConditionLine[] {
  const lines: ConditionLine[] = [];
  for (const [key, label] of Object.entries(CONDITION_LABELS)) {
    const raw = attributes[key];
    if (raw === null || raw === undefined || raw === "") continue;
    let value: string;
    if (key === "safe_box_code") {
      value = context.attributeDisplay?.safeBox
        ? mappedCodeValue(context.attributeDisplay.safeBox, raw)
        : context.safeBox?.displayName ?? unmapped(null, raw);
    } else if (key === "grading_code") {
      value = mappedCodeValue(context.attributeDisplay?.grading, raw);
    } else if (key === "login_method_code") {
      value = mappedCodeValue(context.attributeDisplay?.loginMethod, raw);
    } else if (CONDITION_LEVELS.has(key)) {
      value = `${raw} 级`;
    } else {
      value = String(raw);
    }
    lines.push({ key, label, value });
  }
  const serviceWindow = context.attributeDisplay?.serviceWindow;
  if (serviceWindow) lines.push({ key: "service_window", label: "上号时间", value: serviceWindow.displayName });
  const termOption = context.termOption;
  if (termOption) {
    lines.push({
      key: "term_option",
      label: "租期规则",
      value: termOption.displayName ?? `未确认（代码 ${termOption.code}）`,
    });
    const daily = dailyConsumptionLabel(termOption);
    if (daily) lines.push({ key: "daily_consumption", label: "每日消耗", value: daily });
  }
  return lines;
}
export function toListingCard(listing: PublicListing): ListingCardData {
  const items = new Map(listing.presentation.items.map((item) => [item.id, item]));
  const resourceLines: ResourceLine[] = listing.quote.lines.map((line) => ({
    itemId: line.itemId,
    code: items.get(line.itemId)?.code ?? null,
    name: presentationItemName(items.get(line.itemId), line.itemId),
    quantity: line.quantity,
    quantityLabel: quantityLabel(line.unit, line.quantity, items.get(line.itemId)?.code, line.unitQuantity),
    unitLabel: unitLabel(line.unit),
    costAmount: line.buyerAmount.amount,
    costLabel: formatMoneyLabel(line.buyerAmount),
    unitPriceLabel: `¥${line.buyerUnitAmount.amount} / ${line.unitQuantity} ${unitLabel(line.unit)}`,
  }));
  const media = [...listing.media]
    .sort((a, b) => a.position - b.position)
    .map(({ assetId, url }) => ({ assetId, url }));
  const firstMedia = media[0];
  const skinNames = listing.presentation.skins.map((skin) => skin.name);
  return {
    id: listing.id,
    displayNo: listing.displayNo ?? null,
    title: listing.title,
    imageUrl: firstMedia?.url,
    media,
    resourceLines,
    resourceTotalLabel: formatMoneyLabel(listing.quote.resourceTotal) ?? "以平台确认为准",
    depositLabel: formatMoneyLabel(listing.quote.tenantDeposit),
    payableTotalLabel: formatMoneyLabel(listing.quote.tenantPayableTotal),
    termLabel: termLabel(listing.quote.termSeconds),
    termOptionLabel: listing.termOption?.displayName ?? (listing.termOption ? `未确认（代码 ${listing.termOption.code}）` : null),
    quoteSourceLabel: "当前服务端报价（非旧站比例）",
    conditionLines: conditionLines(listing.attributes, listing),
    loginMethod: listing.attributeDisplay?.loginMethod ?? null,
    skinNames,
    skinLabels: listing.presentation.skins.map((skin) => skin.categoryName ? `${skin.categoryName} · ${skin.name}` : skin.name),
    skinTags: listing.presentation.skins.map((skin) => ({
      name: skin.name,
      categoryCode: skin.categoryCode ?? null,
      categoryName: skin.categoryName ?? null,
    })),
    entitlementNames: listing.presentation.entitlements.map((entitlement) => entitlement.name),
  };
}
export function toListingDetail(listing: PublicListing): ListingDetailData {
  return {
    ...toListingCard(listing),
    description: listing.description,
    gameName: listing.game?.name ?? null,
  };
}
// Detail breadcrumb stays generic until the server-confirmed object game is
// known; a missing game never falls back to guessing Delta.
export function detailBreadcrumbs(gameName: string | null | undefined): Array<{ label: string; href?: string }> {
  return [
    { label: "首页", href: "/" },
    ...(gameName ? [{ label: gameName }] : []),
    { label: "租账号", href: "/accounts" },
    { label: "账号详情" },
  ];
}
export function listingResourceLinesLabel(data: Pick<ListingCardData, "resourceLines">): string {
  const visible = data.resourceLines.filter((line) => line.quantity !== "0");
  const lines = visible.length > 0 ? visible : data.resourceLines;
  return lines.map((line) => `${line.quantityLabel} ${line.name}`).join(" / ");
}

export function resourceQuantityLabel(line: Pick<ResourceLine, "quantity" | "quantityLabel" | "unitLabel">): string {
  const quantity = (line.quantityLabel || line.quantity || "未确认").replace(/\s+/g, "");
  return line.unitLabel === "哈夫币" || quantity.includes(line.unitLabel)
    ? quantity
    : `${quantity}${line.unitLabel}`;
}
