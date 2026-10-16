// Public platform activity aggregation for the portal home statistics cards.
//
// Every metric is sourced from an authoritative provider owned by another domain
// (trade/finance). When no provider is registered the metric is reported as
// UNAVAILABLE — never as zero and never as a static fixture number. A provider
// returning null means the authoritative source itself is unknown right now and
// is reported the same way.

export type PublicActivityUnavailable = {
  state: "UNAVAILABLE";
  reason: "NO_AUTHORITATIVE_SOURCE" | "SOURCE_UNKNOWN";
  detail: string;
};

export type PublicActivityAvailable = {
  state: "AVAILABLE";
  value: number;
  asOf: string;
  scope: string;
};

export type PublicActivityMetric = PublicActivityAvailable | PublicActivityUnavailable;

export type PublicDealEntry = { id: string; game: string; title: string; priceLabel: string };

export type PublicActivityDeals =
  | { state: "AVAILABLE"; items: PublicDealEntry[]; asOf: string }
  | PublicActivityUnavailable;

export type PublicActivityResult = {
  generatedAt: string;
  metrics: {
    visits: PublicActivityMetric;
    transactions: PublicActivityMetric;
    listings: PublicActivityMetric;
  };
  deals: PublicActivityDeals;
};

export type PublicActivityCountReading = { value: number; asOf: string; scope: string };

export type PublicActivityProviders = {
  // T (trade) authority: completed orders under the frozen status/cutoff/dedup rules.
  completedTransactions?: () => Promise<PublicActivityCountReading | null>;
  // T (trade) authority: currently publicly listable accounts.
  currentListings?: () => Promise<PublicActivityCountReading | null>;
  // No authoritative source exists yet: la_index_visit is an unreviewed archive
  // proposal (C-R5). Registered only once a sanctioned visits read exists.
  visitsYesterday?: () => Promise<PublicActivityCountReading | null>;
  // T (trade) authority: recent completed public deals for the ticker.
  recentDeals?: () => Promise<{ items: PublicDealEntry[]; asOf: string } | null>;
};

const NO_SOURCE = {
  visits: "历史访问统计尚无授权读取口径（la_index_visit 归档提案未定）",
  transactions: "成交计数权威提供方未注册（交易域口径待定）",
  listings: "上架计数权威提供方未注册（供给域口径待定）",
  deals: "最新成交权威提供方未注册（交易域口径待定）",
} as const;

function isSafeCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

async function readMetric(
  key: keyof typeof NO_SOURCE,
  provider: (() => Promise<PublicActivityCountReading | null>) | undefined,
): Promise<PublicActivityMetric> {
  if (!provider) return { state: "UNAVAILABLE", reason: "NO_AUTHORITATIVE_SOURCE", detail: NO_SOURCE[key]! };
  const reading = await provider();
  if (!reading || !isSafeCount(reading.value)) {
    return { state: "UNAVAILABLE", reason: "SOURCE_UNKNOWN", detail: NO_SOURCE[key]! };
  }
  return { state: "AVAILABLE", value: reading.value, asOf: reading.asOf, scope: reading.scope };
}

function sanitizeDeal(entry: PublicDealEntry): PublicDealEntry | null {
  const id = typeof entry?.id === "string" ? entry.id.trim() : "";
  const game = typeof entry?.game === "string" ? entry.game.trim() : "";
  const title = typeof entry?.title === "string" ? entry.title.trim() : "";
  const priceLabel = typeof entry?.priceLabel === "string" ? entry.priceLabel.trim() : "";
  if (!id || !game || !title || !priceLabel) return null;
  if ([id, game, title, priceLabel].some((field) => field.length > 200)) return null;
  return { id, game, title, priceLabel };
}

export async function readPublicActivity(
  providers: PublicActivityProviders,
  now: () => Date = () => new Date(),
): Promise<PublicActivityResult> {
  const [visits, transactions, listings] = await Promise.all([
    readMetric("visits", providers.visitsYesterday),
    readMetric("transactions", providers.completedTransactions),
    readMetric("listings", providers.currentListings),
  ]);
  let deals: PublicActivityDeals = { state: "UNAVAILABLE", reason: "NO_AUTHORITATIVE_SOURCE", detail: NO_SOURCE.deals };
  if (providers.recentDeals) {
    const reading = await providers.recentDeals();
    if (!reading || !Array.isArray(reading.items)) {
      deals = { state: "UNAVAILABLE", reason: "SOURCE_UNKNOWN", detail: NO_SOURCE.deals };
    } else {
      deals = {
        state: "AVAILABLE",
        items: reading.items.map(sanitizeDeal).filter((entry): entry is PublicDealEntry => entry !== null).slice(0, 20),
        asOf: reading.asOf,
      };
    }
  }
  return { generatedAt: now().toISOString(), metrics: { visits, transactions, listings }, deals };
}
