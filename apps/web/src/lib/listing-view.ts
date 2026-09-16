import type { Money, PublicListing } from "./supply-types.ts";

export type ResourceLine = { itemId: string; name: string; quantityLabel: string; unitLabel: string };
export type ConditionLine = { key: string; label: string; value: string };
export type ListingCardData = {
  id: string;
  title: string;
  imageUrl?: string;
  resourceLines: ResourceLine[];
  resourceTotalLabel: string;
  depositLabel: string | null;
  termLabel: string;
  conditionLines: ConditionLine[];
  skinNames: string[];
};
export type ListingDetailData = ListingCardData & {
  description: string | null;
  gameName: string | null;
  media: Array<{ assetId: string; url: string }>;
};

const UNIT_LABELS: Record<string, string> = { HAFF_BASE: "哈夫币", ROUND: "发", PIECE: "件" };
const CONDITION_LABELS: Record<string, string> = {
  vit_level: "体力等级",
  bear_level: "负重等级",
  dive_level: "潜水等级",
  character_level: "角色等级",
  grading_code: "段位",
  login_method_code: "登录方式",
  region_province: "省份",
  region_city: "城市",
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
function quantityLabel(unit: string, quantity: string): string {
  return unit === "HAFF_BASE" ? `${haffMillionsLabel(quantity)} M` : quantity;
}
export function conditionLines(attributes: PublicListing["attributes"]): ConditionLine[] {
  return Object.entries(CONDITION_LABELS)
    .map(([key, label]) => {
      const raw = attributes[key];
      if (raw === null || raw === undefined || raw === "") return null;
      const value = CONDITION_LEVELS.has(key) ? `${raw} 级` : String(raw);
      return { key, label, value };
    })
    .filter((line): line is ConditionLine => line !== null);
}
export function toListingCard(listing: PublicListing): ListingCardData {
  const names = new Map(listing.presentation.items.map((item) => [item.id, item.name]));
  const resourceLines: ResourceLine[] = listing.quote.lines.map((line) => ({
    itemId: line.itemId,
    name: names.get(line.itemId) ?? line.itemId,
    quantityLabel: quantityLabel(line.unit, line.quantity),
    unitLabel: unitLabel(line.unit),
  }));
  const firstMedia = [...listing.media].sort((a, b) => a.position - b.position)[0];
  return {
    id: listing.id,
    title: listing.title,
    imageUrl: firstMedia?.url,
    resourceLines,
    resourceTotalLabel: formatMoneyLabel(listing.quote.resourceTotal) ?? "以平台确认为准",
    depositLabel: formatMoneyLabel(listing.quote.tenantDeposit),
    termLabel: termLabel(listing.quote.termSeconds),
    conditionLines: conditionLines(listing.attributes),
    skinNames: listing.presentation.skins.map((skin) => skin.name),
  };
}
export function toListingDetail(listing: PublicListing): ListingDetailData {
  return {
    ...toListingCard(listing),
    description: listing.description,
    gameName: listing.game?.name ?? null,
    media: [...listing.media].sort((a, b) => a.position - b.position).map(({ assetId, url }) => ({ assetId, url })),
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
  return data.resourceLines.map((line) => `${line.quantityLabel} ${line.unitLabel}`).join(" / ");
}
