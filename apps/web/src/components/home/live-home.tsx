"use client";
import { useCallback, useEffect, useState } from "react";
import { PortalHome } from "@/components/portal-home";
import type { AccountCardData } from "@/components/delta/account-card";
import type { SupplyState } from "@/components/delta/delta-section";
import { toListingCard } from "@/lib/listing-view";
import { supplyApi } from "@/lib/supply-client";
import { selectDeltaGame } from "@/lib/supply-games";

// Unknown statistics stay unknown until a real public aggregate endpoint exists.
const EMPTY_STATS = { visits: null, transactions: null, listings: null };
export function LiveHome() {
  const [supply, setSupply] = useState<{ state: SupplyState; accounts: AccountCardData[] }>({ state: "loading", accounts: [] });
  const load = useCallback(async () => {
    setSupply({ state: "loading", accounts: [] });
    try {
      const games = await supplyApi.games();
      const delta = selectDeltaGame(games.games);
      // The delta shelf never falls back to another game or to an unscoped listing query.
      if (!delta) {
        setSupply({ state: "ready", accounts: [] });
        return;
      }
      const metadata = await supplyApi.listingFilters(delta.id);
      const query = new URLSearchParams({ gameId: delta.id, limit: "8" });
      if (metadata.readMode === "LEGACY_READ_ONLY") query.set("queryVersion", "2");
      const page = await supplyApi.market(query);
      setSupply({ state: "ready", accounts: page.items.map(toListingCard) });
    } catch {
      setSupply({ state: "error", accounts: [] });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return <PortalHome accounts={supply.accounts} supplyState={supply.state} stats={EMPTY_STATS} onRetrySupply={() => void load()} />;
}
