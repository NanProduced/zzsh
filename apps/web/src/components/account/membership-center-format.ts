import type { EntitlementKind, EntitlementState, GrowthTier } from "../../lib/membership-growth-client";

export const GROWTH_TIER_LABELS: Record<GrowthTier, string> = {
  STANDARD: "普通会员",
  SILVER: "银卡会员",
  GOLD: "金卡会员",
  PLATINUM: "铂金会员",
  DIAMOND: "钻石会员",
  BLACK_GOLD: "黑金会员 · 终身",
  UNKNOWN: "资格待确认",
};

export const GROWTH_TIER_EN_LABELS: Record<GrowthTier, string> = {
  STANDARD: "REGULAR MEMBER",
  SILVER: "SILVER MEMBER",
  GOLD: "GOLD MEMBER",
  PLATINUM: "PLATINUM MEMBER",
  DIAMOND: "DIAMOND MEMBER",
  BLACK_GOLD: "BLACK GOLD MEMBER",
  UNKNOWN: "MEMBER CARD",
};

export const TIER_ORDER = ["STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND", "BLACK_GOLD"] as const;
export type TrackTier = (typeof TIER_ORDER)[number];

export const TIER_THRESHOLDS: Record<TrackTier, string> = {
  STANDARD: "0",
  SILVER: "5000",
  GOLD: "10000",
  PLATINUM: "20000",
  DIAMOND: "40000",
  BLACK_GOLD: "50000",
};

export const TIER_SHORT: Record<TrackTier, string> = {
  STANDARD: "普通",
  SILVER: "银卡",
  GOLD: "金卡",
  PLATINUM: "铂金",
  DIAMOND: "钻石",
  BLACK_GOLD: "黑金·终身",
};

export const benefitName = (tier: TrackTier): string => (tier === "BLACK_GOLD" ? "黑金" : TIER_SHORT[tier]);

export const COMPARISON_LABEL_TO_TIER: Record<string, TrackTier> = {
  普通会员: "STANDARD",
  银卡会员: "SILVER",
  金卡会员: "GOLD",
  铂金会员: "PLATINUM",
  钻石会员: "DIAMOND",
  黑金会员: "BLACK_GOLD",
  "黑金会员 · 终身": "BLACK_GOLD",
  "黑金会员·终身": "BLACK_GOLD",
};

export const ENTITLEMENT_STATE_LABELS: Record<EntitlementState, string> = {
  PENDING: "待审批",
  APPROVED_PENDING_EXECUTION: "审批通过，待执行",
  EXECUTED_PENDING_START: "待生效",
  ACTIVE: "生效中",
  EXPIRED: "已到期",
  REPLACED: "已替换",
  REVOKED: "已撤销",
  UNKNOWN: "状态待确认",
};

export const TIER_CARD_IMAGE: Record<GrowthTier, string | null> = {
  STANDARD: "/art/membership/a-metal/standard-card.webp",
  SILVER: "/art/membership/a-metal/silver-card.webp",
  GOLD: "/art/membership/a-metal/gold-card.webp",
  PLATINUM: "/art/membership/a-metal/platinum-card.webp",
  DIAMOND: "/art/membership/a-metal/diamond-card.webp",
  BLACK_GOLD: "/art/membership/a-metal/black-gold-card.webp",
  UNKNOWN: null,
};

export const TIER_CARD_SQUARE: Record<TrackTier, string> = {
  STANDARD: "/art/membership/b-ceramic-square/standard-card.webp",
  SILVER: "/art/membership/b-ceramic-square/silver-card.webp",
  GOLD: "/art/membership/b-ceramic-square/gold-card.webp",
  PLATINUM: "/art/membership/b-ceramic-square/platinum-card.webp",
  DIAMOND: "/art/membership/b-ceramic-square/diamond-card.webp",
  BLACK_GOLD: "/art/membership/b-ceramic-square/black-gold-card.webp",
};

export const ENTITLEMENT_BADGE_IMAGE: Record<EntitlementKind, string | null> = {
  FRIEND: "/art/membership/friend-badge.webp",
  PRESTIGE: "/art/membership/prestige-badge.webp",
  UNKNOWN: null,
};

export const EDGE_DROP = 26;

export function tierClass(tier: GrowthTier): string {
  return `tier-${tier.toLowerCase().replace("_", "-")}`;
}

export function formatScopeName(scope: string, gameId?: string | null, gameName?: string | null): string {
  if (scope === "ALL_PLATFORM") return "全平台适用";
  if (scope.startsWith("game:")) return gameId && gameName && scope === `game:${gameId}` ? `${gameName}租赁` : "范围待确认";
  if (scope === "DELTA_ACCOUNT_RENTAL" || scope.includes("DELTA")) return "三角洲租赁";
  return "范围待确认";
}

export function formatBeijingDate(value: string | null): string {
  if (!value) return "待确认";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "待确认";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replace(/\//g, ".");
}

export function formatBeijingDateTime(value: string | null): string {
  if (!value) return "待确认";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "待确认";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(date);
}

export function groupDigits(value: string): string {
  if (!/^-?\d+$/.test(value)) return value;
  const negative = value.startsWith("-");
  const grouped = (negative ? value.slice(1) : value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}

export function signedPoints(value: string): string {
  if (!/^-?\d+$/.test(value)) return value;
  return value.startsWith("-") ? `−${groupDigits(value.slice(1))}` : `+${groupDigits(value)}`;
}

export function pointsGap(points: string, threshold: string): string | null {
  if (!/^\d+$/.test(points) || !/^\d+$/.test(threshold)) return null;
  const gap = BigInt(threshold) - BigInt(points);
  return groupDigits((gap > 0n ? gap : 0n).toString());
}

export function pointsPercent(points: string, threshold: string): number | null {
  if (!/^\d+$/.test(points) || !/^\d+$/.test(threshold) || threshold === "0") return null;
  const percent = (BigInt(points) * 100n) / BigInt(threshold);
  return Number(percent > 100n ? 100n : percent);
}

export function yuanFromCents(value: string): string {
  if (!/^-?\d+$/.test(value)) return "待确认";
  const negative = value.startsWith("-");
  const padded = (negative ? value.slice(1) : value).padStart(3, "0");
  return `${negative ? "-" : ""}¥${groupDigits(padded.slice(0, -2))}.${padded.slice(-2)}`;
}
