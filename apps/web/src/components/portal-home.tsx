"use client";
import { useState } from "react";
import { PortalHeader } from "./layout/portal-header";
import { ServiceBenefits } from "./hero/service-benefits";
import { HeroSection } from "./hero/hero-section";
import { PlatformStats, type PlatformStatsData, type PublicDeal } from "./notice/platform-stats";
import { DeltaSection, type SupplyState } from "./delta/delta-section";
import type { AccountCardData } from "./delta/account-card";
import { PortalFooter } from "./layout/portal-footer";
import { FavoritesProvider } from "./favorites/favorites-context";
import { searchAccounts } from "@/lib/account-search";
import { UpcomingGames } from "./delta/game-identity";
import { SupportRail } from "./support/support-rail";
export function PortalHome({ accounts, supplyState, stats, deals, statsAreDemo=false, onRetrySupply }: { accounts?: AccountCardData[]; supplyState?: SupplyState; stats?: PlatformStatsData; deals?: PublicDeal[]; statsAreDemo?:boolean; onRetrySupply?:()=>void }) {
  const [query, setQuery] = useState("");
  return <FavoritesProvider><div className="portal-home">
    <div className="brand-backdrop" aria-hidden="true"><div className="brand-landscape"/></div>
    <a href="#main-content" className="skip-link">跳到主要内容</a>
    <PortalHeader query={query} onQueryChange={setQuery} />
    <main id="main-content">
      <h1 className="sr-only">洲洲商行游戏服务与账号租赁</h1>
      <HeroSection />
      <ServiceBenefits />
      <div className="portal-width activity-shell"><PlatformStats data={stats} deals={deals} isDemo={statsAreDemo}/></div>

      <DeltaSection accounts={searchAccounts(accounts ?? [], query)} supplyState={supplyState} searchQuery={query} onResetSearch={() => setQuery("")} onRetry={onRetrySupply} />
      <UpcomingGames />
    </main>
    <PortalFooter />
    <SupportRail />
  </div></FavoritesProvider>;
}
