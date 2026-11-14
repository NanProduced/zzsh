"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { PortalHeader } from "./layout/portal-header";
import { ServiceBenefits } from "./hero/service-benefits";
import { HeroSection } from "./hero/hero-section";
import { PlatformStats, type PlatformStatsData, type PublicDeal } from "./notice/platform-stats";
import { DeltaSection, type SupplyState } from "./delta/delta-section";
import type { AccountCardData } from "./delta/account-card";
import { PortalFooter } from "./layout/portal-footer";
import { FavoritesProvider } from "./favorites/favorites-context";
import { accountSearchHref } from "@/lib/account-search";
import { UpcomingGames } from "./delta/game-identity";
import { isHomeFastAccount } from "@/lib/home-fast-accounts";
import "./home/home-mobile.css";
export function PortalHome({ accounts, supplyState, supplyMayHaveMore, fastEnabled, stats, deals, statsAreDemo=false, onRetrySupply }: { accounts?: AccountCardData[]; historicalAccounts?: AccountCardData[]; supplyState?: SupplyState; supplyMayHaveMore?: boolean; fastEnabled?: boolean | null; stats?: PlatformStatsData; deals?: PublicDeal[]; statsAreDemo?:boolean; onRetrySupply?:()=>void }) {
  const [query, setQuery] = useState("");
  const router = useRouter();
  const displayedAccounts = (accounts ?? []).filter(isHomeFastAccount);
  return <FavoritesProvider><div className="portal-home">
    <div className="brand-backdrop" aria-hidden="true"><div className="brand-landscape"/></div>
    <a href="#main-content" className="skip-link">跳到主要内容</a>
    <PortalHeader query={query} onQueryChange={setQuery} onSearch={(value) => router.push(accountSearchHref(value))} />
    <main id="main-content">
      <div className="portal-width home-intro">
        <h1 className="home-intro-title">三角洲行动账号租赁平台</h1>
        <p className="home-intro-lead">在线挑选高价值账号，支付后由真人客服全程履约。</p>
      </div>
      <HeroSection />
      <ServiceBenefits />
      <div className="portal-width activity-shell"><PlatformStats data={stats} deals={deals} isDemo={statsAreDemo}/></div>

      <DeltaSection accounts={displayedAccounts} supplyState={supplyState} supplyMayHaveMore={supplyMayHaveMore} fastEnabled={fastEnabled} onRetry={onRetrySupply} />
      <UpcomingGames />
    </main>
    <PortalFooter />
  </div></FavoritesProvider>;
}
