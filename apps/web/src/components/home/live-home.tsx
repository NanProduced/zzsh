"use client";
import { useCallback, useEffect, useState } from "react";
import { PortalHome } from "@/components/portal-home";
import type { AccountCardData } from "@/components/delta/account-card";
import type { SupplyState } from "@/components/delta/delta-section";
import { collectFastAccounts, HOME_FAST_DISPLAY_LIMIT, HOME_FAST_MAX_PAGES, HOME_FAST_PAGE_LIMIT } from "@/lib/home-fast-accounts";
import { supplyApi } from "@/lib/supply-client";
import { selectDeltaGame } from "@/lib/supply-games";

// Unknown statistics stay unknown until a real public aggregate endpoint exists.
const EMPTY_STATS = { visits: null, transactions: null, listings: null };
export function LiveHome() {
  const [supply, setSupply] = useState<{ state: SupplyState; accounts: AccountCardData[]; supplyMayHaveMore: boolean }>({ state: "loading", accounts: [], supplyMayHaveMore: false });
  const load = useCallback(async () => {
    setSupply({ state: "loading", accounts: [], supplyMayHaveMore: false });
    try {
      const games = await supplyApi.games();
      const delta = selectDeltaGame(games.games);
      // The delta shelf never falls back to another game or to an unscoped listing query.
      if (!delta) {
        setSupply({ state: "ready", accounts: [], supplyMayHaveMore: false });
        return;
      }
      const metadata = await supplyApi.listingFilters(delta.id);
      const result = await collectFastAccounts(
        async (cursor) => {
          const query = new URLSearchParams({ gameId: delta.id, limit: String(HOME_FAST_PAGE_LIMIT) });
          if (cursor) query.set("cursor", cursor);
          if (metadata.readMode === "LEGACY_READ_ONLY") query.set("queryVersion", "2");
          return supplyApi.market(query);
        },
        undefined,
        HOME_FAST_MAX_PAGES,
        HOME_FAST_DISPLAY_LIMIT,
      );
      setSupply({ state: "ready", accounts: result.accounts, supplyMayHaveMore: result.hasMore });
    } catch {
      setSupply({ state: "error", accounts: [], supplyMayHaveMore: false });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return <PortalHome accounts={supply.accounts} supplyState={supply.state} supplyMayHaveMore={supply.supplyMayHaveMore} stats={EMPTY_STATS} onRetrySupply={() => void load()} />;
}
