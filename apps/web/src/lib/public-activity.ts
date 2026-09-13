export type PlatformStatsData = { visits: number | null; transactions: number | null; listings: number | null };
export type PublicDeal = { id: string; game: string; title: string; priceLabel: string };
export function isPublicCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
