"use client";
import { useCallback, useEffect, useState } from "react";
import { PortalHome } from "@/components/portal-home";
import type { AccountCardData } from "@/components/delta/account-card";
import type { SupplyState } from "@/components/delta/delta-section";
import { toListingCard } from "@/lib/listing-view";
import { supplyApi } from "@/lib/supply-client";
import { selectDeltaGame } from "@/lib/supply-games";

// Owner-approved draft statistics; replace this source with the public backend response.
const DEMO_STATS = { visits: 12580, transactions: 150960, listings: 3086 };
export function LiveHome() {
  const [stats, setStats] = useState(DEMO_STATS);
  const [supply, setSupply] = useState<{ state: SupplyState; accounts: AccountCardData[] }>({ state: "loading", accounts: [] });
  useEffect(() => {
    const timer = setInterval(() => {
      if (!document.hidden) setStats((value) => ({ visits: value.visits + 3, transactions: value.transactions + 1, listings: value.listings }));
    }, 5000);
    return () => clearInterval(timer);
  }, []);
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
      const page = await supplyApi.market(new URLSearchParams({ gameId: delta.id, limit: "3" }));
      setSupply({ state: "ready", accounts: page.items.map(toListingCard) });
    } catch {
      setSupply({ state: "error", accounts: [] });
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);
  return <PortalHome accounts={supply.accounts} supplyState={supply.state} stats={stats} statsAreDemo onRetrySupply={() => void load()} />;
}
