"use client";
import { useCallback, useEffect, useState } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { ArrowUpRight, ChevronLeft, ChevronRight, Crosshair } from "lucide-react";
import { AccountCard, type AccountCardData } from "./account-card";
import { AccountCardSkeleton } from "./account-card-skeleton";
import { AccountCardEmpty } from "./account-card-empty";
import Link from "next/link";
import { GameIdentity } from "./game-identity";

export type SupplyState = "unavailable" | "ready" | "loading" | "error";

export interface DeltaSectionProps {
  accounts?: AccountCardData[];
  historicalAccounts?: AccountCardData[];
  supplyState?: SupplyState;
  supplyMayHaveMore?: boolean;
  searchQuery?: string;
  onResetSearch?: () => void;
  onRetry?: () => void;
}

export function DeltaSection({
  accounts = [],
  historicalAccounts = [],
  supplyState = "unavailable",
  supplyMayHaveMore = false,
  searchQuery = "",
  onResetSearch,
  onRetry,
}: DeltaSectionProps) {
  const [viewportRef, emblaApi] = useEmblaCarousel({ align: "start", containScroll: "trimSnaps" });
  const [historyViewportRef, historyApi] = useEmblaCarousel({ align: "start", containScroll: "trimSnaps" });
  const [canScrollPrev, setCanScrollPrev] = useState(false);
  const [canScrollNext, setCanScrollNext] = useState(false);
  const updateScrollState = useCallback((api: { canScrollPrev: () => boolean; canScrollNext: () => boolean }) => {
    setCanScrollPrev(api.canScrollPrev());
    setCanScrollNext(api.canScrollNext());
  }, []);

  useEffect(() => {
    if (!emblaApi) return;
    updateScrollState(emblaApi);
    emblaApi.on("select", updateScrollState);
    emblaApi.on("reInit", updateScrollState);
    return () => {
      emblaApi.off("select", updateScrollState);
      emblaApi.off("reInit", updateScrollState);
    };
  }, [emblaApi, updateScrollState]);

  useEffect(() => {
    emblaApi?.reInit();
  }, [emblaApi, accounts.length]);
  useEffect(() => { historyApi?.reInit(); }, [historyApi,historicalAccounts.length]);

  return (
    <section
      id="delta-section"
      className="portal-width delta-section game-section"
      aria-label="三角洲行动专区"
    >
      <div className="game-row">
        <GameIdentity game="delta"><Link className="button delta-tool" href="/gunsmith"><Crosshair size={16} />改枪码</Link></GameIdentity>
        <div className="delta-supply" id="account-list" tabIndex={-1}>
          <div className="supply-heading">
            <h3>资源账号</h3>
            <div className="supply-heading-actions">
              {supplyState === "ready" && accounts.length > 3 ? (
                <div className="account-carousel-controls" aria-label="切换资源账号">
                  <button type="button" aria-label="向左查看账号" disabled={!canScrollPrev} onClick={() => emblaApi?.scrollPrev()}>
                    <ChevronLeft size={16} aria-hidden="true" />
                  </button>
                  <button type="button" aria-label="向右查看账号" disabled={!canScrollNext} onClick={() => emblaApi?.scrollNext()}>
                    <ChevronRight size={16} aria-hidden="true" />
                  </button>
                </div>
              ) : null}
              <Link href="/accounts">
                全部账号
                <ArrowUpRight size={14} />
              </Link>
            </div>
          </div>
          {searchQuery.trim() && (
            <div className="site-search-summary" role="status">
              <span>
                “{searchQuery.trim()}”
                {supplyState === "ready"
                  ? ` · ${accounts.length + historicalAccounts.length} 个匹配账号`
                  : " · 账号数据暂不可查询"}
                <small>仅搜索当前已加载的账号编号与名称</small>
              </span>
              <button type="button" onClick={onResetSearch}>
                清空搜索
              </button>
            </div>
          )}
          {supplyState === "loading" ? (
            <div className="account-carousel account-carousel--loading" role="status" aria-label="正在加载账号">
              <div className="account-carousel-viewport">
                <div className="account-carousel-container">
                  {Array.from({ length: 4 }, (_, index) => <div className="account-carousel-slide" key={index}><AccountCardSkeleton /></div>)}
                </div>
              </div>
            </div>
          ) : supplyState === "ready" && accounts.length > 0 ? (
            <div className="account-carousel" role="region" aria-label="资源账号">
              <div
                className="account-carousel-viewport"
                ref={viewportRef}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (event.key === "ArrowLeft") {
                    event.preventDefault();
                    emblaApi?.scrollPrev();
                  } else if (event.key === "ArrowRight") {
                    event.preventDefault();
                    emblaApi?.scrollNext();
                  }
                }}
              >
                <div className="account-carousel-container">
                  {accounts.map((data) => (
                    <div className="account-carousel-slide" key={data.id}>
                      <AccountCard data={data} />
                    </div>
                  ))}
                </div>
              </div>
            </div>
          ) : (
            <AccountCardEmpty
              {...(supplyState === "ready"
                ? historicalAccounts.length > 0
                  ? {
                      message: "暂无可在线租赁的账号",
                      description: "已加载的历史账号在下方展示，仅供资料查阅。",
                    }
                  : searchQuery.trim()
                  ? {
                      message: "未找到匹配账号",
                      description:
                        "试试其他账号编号或名称，也可以清空搜索查看全部。",
                      onReset: onResetSearch,
                    }
                  : supplyMayHaveMore
                  ? {
                      message: "首批结果中暂未找到极速出租账号",
                      description: "目录仍有后续页，前往全部账号继续浏览。",
                      children: <Link href="/accounts">浏览全部账号 <ArrowUpRight size={14} /></Link>,
                    }
                  : {
                      message: "暂无可选账号",
                      description: "当前没有可展示的号源，请稍后再来。",
                    }
                : supplyState === "error"
                ? {
                    message: "账号列表加载失败",
                    description: "请检查网络后重试。",
                    onRetry,
                  }
                : {})}
            />
          )}
          {supplyState === "ready" && historicalAccounts.length > 0 ? <section aria-label="历史账号 · 只读">
            <div className="supply-heading"><h3>历史账号 · 只读</h3><div className="supply-heading-actions">{historicalAccounts.length>3 ? <div className="account-carousel-controls" aria-label="切换历史账号"><button type="button" aria-label="向左查看历史账号" onClick={()=>historyApi?.scrollPrev()}><ChevronLeft size={16} aria-hidden="true"/></button><button type="button" aria-label="向右查看历史账号" onClick={()=>historyApi?.scrollNext()}><ChevronRight size={16} aria-hidden="true"/></button></div> : null}<Link href="/accounts">浏览账号市场 <ArrowUpRight size={14} aria-hidden="true" /></Link></div></div>
            <p className="site-search-summary">保留历史资料与原金额，不支持在线租赁。{supplyMayHaveMore ? "此处仅展示首批结果，完整目录请进入账号市场。" : ""}</p>
            <div className="account-carousel"><div className="account-carousel-viewport" ref={historyViewportRef} tabIndex={0} aria-label="历史账号横向列表，使用左右方向键浏览" onKeyDown={event=>{if(event.key==="ArrowLeft"||event.key==="ArrowRight"){event.preventDefault();if(event.key==="ArrowLeft")historyApi?.scrollPrev();else historyApi?.scrollNext();}}}><div className="account-carousel-container">
              {historicalAccounts.map(data=><div className="account-carousel-slide" key={data.id}><AccountCard data={data}/></div>)}
            </div></div></div>
          </section> : null}
        </div>
      </div>
    </section>
  );
}
