"use client";
import { useCallback, useEffect, useState } from "react";
import { PortalHome } from "@/components/portal-home";
import type { AccountCardData } from "@/components/delta/account-card";
import type { SupplyState } from "@/components/delta/delta-section";
import { collectFastAccounts, HOME_FAST_DISPLAY_LIMIT, HOME_FAST_MAX_PAGES, HOME_FAST_PAGE_LIMIT } from "@/lib/home-fast-accounts";
import { supplyApi } from "@/lib/supply-client";
import { listingQuery } from "@/lib/listing-filters";
import { selectDeltaGame } from "@/lib/supply-games";
import type { PlatformStatsData, PublicDeal } from "@/lib/public-activity";

// Unavailable metrics stay null and render as "—"; the API never sends zero for unknowns.
const EMPTY_STATS: PlatformStatsData = { visits: null, transactions: null, listings: null };
type ActivityMetric = { state?: unknown; value?: unknown };
function metricValue(metric: ActivityMetric | undefined): number | null {
  if (!metric || metric.state !== "AVAILABLE") return null;
  return typeof metric.value === "number" && Number.isSafeInteger(metric.value) && metric.value >= 0 ? metric.value : null;
}
function readActivity(payload: unknown): { stats: PlatformStatsData; deals: PublicDeal[] } {
  if (!payload || typeof payload !== "object") return { stats: EMPTY_STATS, deals: [] };
  const metrics = (payload as { metrics?: Record<string, ActivityMetric> }).metrics;
  const stats: PlatformStatsData = {
    visits: metricValue(metrics?.visits),
    transactions: metricValue(metrics?.transactions),
    listings: metricValue(metrics?.listings),
  };
  const dealsNode = (payload as { deals?: { state?: unknown; items?: unknown } }).deals;
  const items = dealsNode && dealsNode.state === "AVAILABLE" && Array.isArray(dealsNode.items) ? dealsNode.items : [];
  const deals = items.flatMap((entry): PublicDeal[] => {
    if (!entry || typeof entry !== "object") return [];
    const { id, game, title, priceLabel } = entry as Record<string, unknown>;
    return typeof id === "string" && typeof game === "string" && typeof title === "string" && typeof priceLabel === "string" && id && game && title && priceLabel
      ? [{ id, game, title, priceLabel }]
      : [];
  });
  return { stats, deals };
}
export function LiveHome() {
  const [supply, setSupply] = useState<{ state: SupplyState; accounts: AccountCardData[]; historicalAccounts: AccountCardData[]; supplyMayHaveMore: boolean }>({ state: "loading", accounts: [], historicalAccounts: [], supplyMayHaveMore: false });
  const [activity, setActivity] = useState<{ stats: PlatformStatsData; deals: PublicDeal[] }>({ stats: EMPTY_STATS, deals: [] });
  useEffect(() => {
    const controller = new AbortController();
    (async () => {
      try {
        const response = await fetch("/api/content/activity", { cache: "no-store", signal: controller.signal, headers: { accept: "application/json" } });
        if (!response.ok) return;
        setActivity(readActivity(await response.json()));
      } catch { /* Statistics stay "—" when the public activity endpoint is unreachable. */ }
    })();
    return () => controller.abort();
  }, []);
  const load = useCallback(async () => {
    setSupply({ state: "loading", accounts: [], historicalAccounts: [], supplyMayHaveMore: false });
    try {
      const games = await supplyApi.games();
      const delta = selectDeltaGame(games.games);
      // The delta shelf never falls back to another game or to an unscoped listing query.
      if (!delta) {
        setSupply({ state: "ready", accounts: [], historicalAccounts: [], supplyMayHaveMore: false });
        return;
      }
      const metadata = await supplyApi.listingFilters(delta.id);
      if(!metadata.available){ setSupply({state:"unavailable",accounts:[],historicalAccounts:[],supplyMayHaveMore:false}); return; }
      const result = await collectFastAccounts(
        async (cursor) => {
          const query = listingQuery({game:delta.id,filters:{},q:null,sort:"latest",direction:"DESC",coreItemId:null,cursor,limit:HOME_FAST_PAGE_LIMIT,viewMode:"grid"},metadata);
          return supplyApi.market(query);
        },
        undefined,
        HOME_FAST_MAX_PAGES,
        HOME_FAST_DISPLAY_LIMIT,
      );
      setSupply({ state: "ready", accounts: result.accounts, historicalAccounts: result.historicalAccounts, supplyMayHaveMore: result.hasMore });
    } catch {
      setSupply({ state: "error", accounts: [], historicalAccounts: [], supplyMayHaveMore: false });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return <PortalHome accounts={supply.accounts} historicalAccounts={supply.historicalAccounts} supplyState={supply.state} supplyMayHaveMore={supply.supplyMayHaveMore} stats={activity.stats} deals={activity.deals} onRetrySupply={() => void load()} />;
}
