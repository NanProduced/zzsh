"use client";
import { useCallback, useEffect, useState, type MouseEvent } from "react";
import useEmblaCarousel from "embla-carousel-react";
import { ArrowUpRight, ChevronLeft, ChevronRight, Crosshair } from "lucide-react";
import { AccountCard, accountHref, authoritativeRatioLabel, type AccountCardData } from "./account-card";
import { AccountCardSkeleton } from "./account-card-skeleton";
import { AccountCardEmpty } from "./account-card-empty";
import Link from "next/link";
import { GameIdentity } from "./game-identity";
import { deriveAccountTitle } from "@/lib/account-title";
import { rememberAccountReturn } from "@/lib/account-return";
import { FavoriteButton } from "../favorites/favorite-button";

export type SupplyState = "unavailable" | "ready" | "loading" | "error";

export interface DeltaSectionProps {
  accounts?: AccountCardData[];
  supplyState?: SupplyState;
  supplyMayHaveMore?: boolean;
  fastEnabled?: boolean | null;
  onRetry?: () => void;
}

export function HomeFastAccountRow({ data }: { data: AccountCardData }) {
  const title = deriveAccountTitle(data);
  const ratio = authoritativeRatioLabel(data.baseRenterHaffRatioWanPerYuan);
  const href = accountHref(data.id);
  const rememberDetail = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)
      rememberAccountReturn(data.id, window.location);
  };
  return <article className="home-fast-row" data-account-id={data.id}>
    <div className="home-fast-row-heading">
      <Link href={href} onClick={rememberDetail}><h4>{title.primary}</h4></Link>
      <FavoriteButton accountId={data.id} title={title.primary} />
    </div>
    {title.secondary && <p className="home-fast-resources">{title.secondary}</p>}
    <p className="home-fast-conditions"><span>{data.termLabel || "租期详情核定"}</span><span>{data.loginMethod?.displayName || "上号方式待确认"}</span>{ratio && <span>{ratio}</span>}</p>
    <dl className="home-fast-fees" aria-label="公开基础费用，最终费用以下单前确认为准">
      <div><dt>资源费用</dt><dd>{data.resourceTotalLabel}</dd></div>
      <div><dt>押金</dt><dd>{data.depositLabel || "详情核定"}</dd></div>
      <div><dt>基础预付</dt><dd>{data.payableTotalLabel || "详情核定"}</dd></div>
    </dl>
    <div className="home-fast-row-footer"><span>{data.displayNo ? `账号 ${data.displayNo}` : "账号编号待分配"}</span><Link href={href} onClick={rememberDetail}>查看账号<ArrowUpRight size={15} aria-hidden="true" /></Link></div>
  </article>;
}

export function DeltaSection({
  accounts = [],
  supplyState = "unavailable",
  supplyMayHaveMore = false,
  fastEnabled = null,
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
    <section id="delta-section" className="portal-width delta-section game-section" aria-label="三角洲行动专区">
      <div className="game-row">
        <GameIdentity game="delta"><Link className="button delta-tool" href="/gunsmith"><Crosshair size={16} />改枪码</Link></GameIdentity>
        <div className="delta-supply" id="account-list" tabIndex={-1}>
          <div className="supply-heading">
            <h3>特惠账号</h3>
            <div className="supply-heading-actions">
              {supplyState === "ready" && accounts.length > 3 ? (
                <div className="account-carousel-controls" aria-label="切换资源账号">
                  <button type="button" aria-label="向左查看账号" disabled={!canScrollPrev} onClick={() => emblaApi?.scrollPrev()}><ChevronLeft size={16} aria-hidden="true" /></button>
                  <button type="button" aria-label="向右查看账号" disabled={!canScrollNext} onClick={() => emblaApi?.scrollNext()}><ChevronRight size={16} aria-hidden="true" /></button>
                </div>
              ) : null}
              <Link href="/accounts">全部账号<ArrowUpRight size={14} /></Link>
            </div>
          </div>
          {supplyState === "loading" ? (
            <><div className="home-fast-mobile home-fast-loading" role="status" aria-label="正在加载特惠账号"><span className="sr-only">正在加载特惠账号</span>{[0, 1].map(index => <div className="home-fast-row-skeleton" key={index} aria-hidden="true"><span /><span /><span /></div>)}</div><div className="account-carousel account-carousel--loading home-fast-desktop" role="status" aria-label="正在加载账号">
              <div className="account-carousel-viewport"><div className="account-carousel-container">
                {Array.from({ length: 4 }, (_, index) => <div className="account-carousel-slide" key={index}><AccountCardSkeleton /></div>)}
              </div></div>
            </div></>
          ) : supplyState === "ready" && accounts.length > 0 ? (
            <><div className="home-fast-mobile" role="region" aria-label="特惠账号列表">{accounts.map(data => <HomeFastAccountRow key={data.id} data={data} />)}</div><div className="account-carousel home-fast-desktop" role="region" aria-label="资源账号">
              <div className="account-carousel-viewport" ref={viewportRef} tabIndex={0} onKeyDown={(event) => {
                if (event.key === "ArrowLeft") { event.preventDefault(); emblaApi?.scrollPrev(); }
                else if (event.key === "ArrowRight") { event.preventDefault(); emblaApi?.scrollNext(); }
              }}>
                <div className="account-carousel-container">
                  {accounts.map((data) => <div className="account-carousel-slide" key={data.id}><AccountCard data={data} /></div>)}
                </div>
              </div>
            </div></>
          ) : (
            <AccountCardEmpty {...(supplyState === "ready" || supplyState === "unavailable"
              ? {
                message: supplyState === "unavailable" ? "特惠号源暂不可用" : fastEnabled === false ? "极速出租暂未开放" : fastEnabled === null ? "特惠状态暂时无法确认" : "暂无特惠账号",
                description: supplyState === "unavailable" ? "可前往账号市场继续选号。"
                  : fastEnabled === false ? "可前往账号市场查看其他账号。"
                    : fastEnabled === null ? "未能确认极速是否开放，也暂未读到可租特惠账号；可稍后重试或浏览账号市场。"
                      : supplyMayHaveMore ? "更多账号请前往账号市场浏览。" : "当前没有可租的特惠账号，可前往账号市场继续选号。",
                children: <Link href="/accounts">浏览全部账号 <ArrowUpRight size={14} /></Link>,
              }
              : supplyState === "error"
                ? { message: "账号列表加载失败", description: "请检查网络后重试。", onRetry }
                : {})} />
          )}
        </div>
      </div>
    </section>
  );
}
