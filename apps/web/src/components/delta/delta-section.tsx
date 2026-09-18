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
  supplyState?: SupplyState;
  searchQuery?: string;
  onResetSearch?: () => void;
  onRetry?: () => void;
}

export function DeltaSection({
  accounts = [],
  supplyState = "unavailable",
  searchQuery = "",
  onResetSearch,
  onRetry,
}: DeltaSectionProps) {
  const [viewportRef, emblaApi] = useEmblaCarousel({ align: "start", containScroll: "trimSnaps" });
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
                  ? ` · ${accounts.length} 个匹配账号`
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
                ? searchQuery.trim()
                  ? {
                      message: "未找到匹配账号",
                      description:
                        "试试其他账号编号或名称，也可以清空搜索查看全部。",
                      onReset: onResetSearch,
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
        </div>
      </div>
    </section>
  );
}
