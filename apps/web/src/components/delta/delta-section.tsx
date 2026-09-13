"use client";
import { ArrowUpRight, Crosshair } from "lucide-react";
import { AccountCard, type AccountCardData } from "./account-card";
import { AccountCardSkeleton } from "./account-card-skeleton";
import { AccountCardEmpty } from "./account-card-empty";
import Link from "next/link";
import { GameIdentity } from "./game-identity";
export type SupplyState = "unavailable" | "ready" | "loading" | "error";
export interface DeltaSectionProps {
  accounts?: AccountCardData[];
  supplyState?: SupplyState;
  searchQuery?: string;
  onResetSearch?: () => void;
  onRetry?: () => void;
  onToolNotice?: (title: string, message: string) => void;
}
export function DeltaSection({ accounts = [], supplyState = "unavailable", searchQuery = "", onResetSearch, onRetry, onToolNotice }: DeltaSectionProps) {
  return <section id="delta-section" className="portal-width delta-section game-section" aria-label="三角洲行动专区">
    <div className="game-row">
      <GameIdentity game="delta"><button className="button delta-tool" onClick={() => onToolNotice?.("三角洲改枪码", "当前没有可展示的改枪码。请稍后再来。")}><Crosshair size={16} />改枪码</button></GameIdentity>
      <div className="delta-supply" id="account-list" tabIndex={-1}>
        <div className="supply-heading"><h3>资源账号</h3><Link href="/accounts">全部账号<ArrowUpRight size={14} /></Link></div>
        {searchQuery.trim() && <div className="site-search-summary" role="status">
          <span>“{searchQuery.trim()}”{supplyState === "ready" ? ` · ${accounts.length} 个匹配账号` : " · 账号数据暂不可查询"}<small>仅搜索当前已加载的账号编号与名称</small></span>
          <button type="button" onClick={onResetSearch}>清空搜索</button>
        </div>}
        {supplyState === "loading" ? <div role="status" aria-label="正在加载账号" className="account-grid"><AccountCardSkeleton /><AccountCardSkeleton /><AccountCardSkeleton /></div> :
          supplyState === "ready" && accounts.length > 0 ? <div className="account-grid">{accounts.map((data) => <AccountCard key={data.id} data={data} />)}</div> :
          <AccountCardEmpty {...(supplyState === "ready" ? searchQuery.trim() ? { message: "未找到匹配账号", description: "试试其他账号编号或名称，也可以清空搜索查看全部。", onReset: onResetSearch } : { message: "暂无可选账号", description: "当前没有可展示的号源，请稍后再来。" } : supplyState === "error" ? { message: "账号列表加载失败", description: "请检查网络后重试。", onRetry } : {})} />}
      </div>
    </div>
  </section>;
}
