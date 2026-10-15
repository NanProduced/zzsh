"use client";
import { useCallback, useEffect, useState } from "react";
import { PortalHome } from "@/components/portal-home";
import type { AccountCardData } from "@/components/delta/account-card";
import type { SupplyState } from "@/components/delta/delta-section";
import { collectFastAccounts, HOME_FAST_DISPLAY_LIMIT, HOME_FAST_MAX_PAGES, HOME_FAST_PAGE_LIMIT } from "@/lib/home-fast-accounts";
import { supplyApi } from "@/lib/supply-client";
import { listingQuery } from "@/lib/listing-filters";
import { selectDeltaGame } from "@/lib/supply-games";

// Unknown statistics stay unknown until a real public aggregate endpoint exists.
const EMPTY_STATS = { visits: null, transactions: null, listings: null };
export function LiveHome() {
  const [supply, setSupply] = useState<{ state: SupplyState; accounts: AccountCardData[]; historicalAccounts: AccountCardData[]; supplyMayHaveMore: boolean }>({ state: "loading", accounts: [], historicalAccounts: [], supplyMayHaveMore: false });
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
  return <PortalHome accounts={supply.accounts} historicalAccounts={supply.historicalAccounts} supplyState={supply.state} supplyMayHaveMore={supply.supplyMayHaveMore} stats={EMPTY_STATS} onRetrySupply={() => void load()} />;
}
