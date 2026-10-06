import type { Money, PublicListing, PublicQuote, PublicCodeLabel } from "./supply-types.ts";
import { resourceItemDisplayName } from "./listing-filters.ts";

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
  historicalReadOnly?: boolean;
  id: string;
  gameId?: string;
  versionId?: string;
  releaseId?: string;
  displayNo: string | null;
  title: string;
  imageUrl?: string;
  media: ListingMedia[];
  resourceLines: ResourceLine[];
  resourceTotalLabel: string;
  haffRentLabel: string | null;
  itemResourceTotalLabel: string | null;
  depositLabel: string | null;
  payableTotalLabel: string | null;
  termLabel: string;
  termOptionLabel: string | null;
  conditionLines: ConditionLine[];
  loginMethod: PublicCodeLabel | null;
  skinNames: string[];
  skinLabels: string[];
  skinTags: SkinTag[];
  entitlementNames: string[];
  rentalMode?: "ordinary" | "custom" | "fast" | null;
  unitAmountsInformational: boolean;
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
function sumQuoteLineAmounts(lines: PublicQuote["lines"]): Money | null {
  if (lines.length === 0) return null;
  let cents = 0n;
  for (const line of lines) {
    const amount = line.buyerAmount.amount.trim();
    if (!/^\d+\.\d{2}$/.test(amount)) return null;
    cents += BigInt(amount.replace(".", ""));
  }
  const yuan = cents / 100n;
  const remainder = (cents % 100n).toString().padStart(2, "0");
  return { currency: "CNY", unit: "yuan", amount: `${yuan}.${remainder}`, scale: 2 };
}
function quoteLineSubtotalLabel(lines: PublicQuote["lines"], hasQuoteLines: boolean): string | null {
  if (!hasQuoteLines) return null;
  if (lines.length === 0) return "¥0.00";
  return formatMoneyLabel(sumQuoteLineAmounts(lines));
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
  if (listing.source === "LEGACY_READ_ONLY") return toHistoricalListingCard(listing);
  if (!listing.quote) throw new Error("Current listing has no authoritative quote");
  const items = new Map(listing.presentation.items.map((item) => [item.id, item]));
  const haffLines = listing.quote.lines.filter((line) => line.unit === "HAFF_BASE");
  const itemLines = listing.quote.lines.filter((line) => line.unit !== "HAFF_BASE");
  const resourceLines: ResourceLine[] = listing.quote.lines.map((line) => ({
    itemId: line.itemId,
    code: items.get(line.itemId)?.code ?? null,
    name: resourceItemDisplayName(items.get(line.itemId), { gameCode: listing.game?.code, itemId: line.itemId }),
    quantity: line.quantity,
    quantityLabel: quantityLabel(line.unit, line.quantity, items.get(line.itemId)?.code, line.unitQuantity),
    unitLabel: unitLabel(line.unit),
    costAmount: line.buyerAmount.amount,
    costLabel: formatMoneyLabel(line.buyerAmount),
    unitPriceLabel: `¥${line.buyerUnitAmount.amount} / ${line.unitQuantity} ${unitLabel(line.unit)}`,
  }));
  const media = projectListingMedia(listing);
  const firstMedia = media[0];
  return {
    id: listing.id,
    gameId: listing.game?.id,
    versionId: listing.versionId,
    releaseId: listing.releaseId,
    displayNo: listing.displayNo ?? null,
    title: listing.title,
    imageUrl: firstMedia?.url,
    media,
    resourceLines,
    resourceTotalLabel: formatMoneyLabel(listing.quote.resourceTotal) ?? "以平台确认为准",
    haffRentLabel: quoteLineSubtotalLabel(haffLines, listing.quote.lines.length > 0),
    itemResourceTotalLabel: quoteLineSubtotalLabel(itemLines, listing.quote.lines.length > 0),
    depositLabel: formatMoneyLabel(listing.quote.tenantDeposit),
    payableTotalLabel: formatMoneyLabel(listing.quote.tenantPayableTotal),
    termLabel: termLabel(listing.quote.termSeconds),
    termOptionLabel: listing.termOption?.displayName ?? (listing.termOption ? `未确认（代码 ${listing.termOption.code}）` : null),
    conditionLines: conditionLines(listing.attributes, listing),
    loginMethod: listing.attributeDisplay?.loginMethod ?? null,
    ...projectListingSkins(listing),
    entitlementNames: listing.presentation.entitlements.map((entitlement) => entitlement.name),
    rentalMode: listing.quote.rentalMode ?? (listing.attributes?.rental_mode as "ordinary" | "custom" | "fast" | undefined) ?? null,
    unitAmountsInformational: listing.quote.unitAmountsInformational === true,
  };
}
function projectListingMedia(listing: PublicListing): ListingMedia[] {
  return [...listing.media]
    .sort((a, b) => a.position - b.position)
    .map(({ assetId, url }) => ({ assetId, url }));
}
function projectListingSkins(listing: PublicListing): Pick<ListingCardData, "skinNames" | "skinLabels" | "skinTags"> {
  return {
    skinNames: listing.presentation.skins.map((skin) => skin.name),
    skinLabels: listing.presentation.skins.map((skin) => skin.categoryName ? `${skin.categoryName} · ${skin.name}` : skin.name),
    skinTags: listing.presentation.skins.map((skin) => ({
      name: skin.name,
      categoryCode: skin.categoryCode ?? null,
      categoryName: skin.categoryName ?? null,
    })),
  };
}
function historicalCentsLabel(...amounts: string[]): string {
  const cents = amounts.reduce((sum, amount) => sum + BigInt(amount.replace(".", "")), 0n);
  return `¥${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`;
}
function toHistoricalListingCard(listing: PublicListing): ListingCardData {
  const history = listing.historicalQuote;
  if (!history || !listing.inventory || listing.quote !== null || listing.canCreateOrder !== false)
    throw new Error("Invalid historical listing projection");
  const items = new Map(listing.presentation.items.map(item => [item.id, item]));
  const subtotal = BigInt(history.haffRent.amount.replace(".", "")) + BigInt(history.goods.amount.replace(".", ""));
  const media = projectListingMedia(listing);
  return {
    historicalReadOnly: true, id: listing.id, displayNo: listing.displayNo ?? null, title: listing.title,
    imageUrl: media[0]?.url,
    media, resourceLines: listing.inventory.map(line => ({
      itemId: line.itemId, code: items.get(line.itemId)?.code ?? null, name: items.get(line.itemId)?.name ?? "未确认物品",
      quantity: line.quantity ?? "", quantityLabel: line.quantity === null ? "未确认" : quantityLabel(line.unit, line.quantity, items.get(line.itemId)?.code, "1"),
      unitLabel: unitLabel(line.unit), costAmount: null, costLabel: null, unitPriceLabel: null,
    })),
    resourceTotalLabel: `¥${subtotal / 100n}.${(subtotal % 100n).toString().padStart(2, "0")}`,
    haffRentLabel: formatMoneyLabel(history.haffRent), itemResourceTotalLabel: formatMoneyLabel(history.goods),
    depositLabel: formatMoneyLabel(history.deposit),
    payableTotalLabel: historicalCentsLabel(history.haffRent.amount, history.goods.amount, history.deposit.amount),
    termLabel: `${history.termDays} 天`, termOptionLabel: listing.termOption?.displayName ?? null,
    conditionLines: conditionLines(listing.attributes, listing), loginMethod: listing.attributeDisplay?.loginMethod ?? null,
    ...projectListingSkins(listing), entitlementNames: [], rentalMode: null, unitAmountsInformational: false,
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
