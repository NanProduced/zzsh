"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ImageOff, RotateCw } from "lucide-react";
import { ServiceShell } from "@/components/layout/service-shell";
import { FavoriteButton, FavoriteNotice } from "@/components/favorites/favorite-button";
import { FavoritesProvider } from "@/components/favorites/favorites-context";
import { AccountCardSkeleton } from "@/components/delta/account-card-skeleton";
import { accountReturnTarget, readAccountReturn } from "@/lib/account-return";
import { detailBreadcrumbs, resourceQuantityLabel, toListingDetail, type ListingDetailData } from "@/lib/listing-view";
import { supplyApi, SupplyRequestError } from "@/lib/supply-client";

type DetailState = { status: "loading" } | { status: "ready"; data: ListingDetailData } | { status: "unavailable" } | { status: "error" };

export function ListingDetail({ accountId }: { accountId: string }) {
  return <FavoritesProvider><DetailView accountId={accountId} /></FavoritesProvider>;
}

function DetailImage({ src, alt, className }: { src: string; alt: string; className?: string }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className={`detail-image-fallback${className ? ` ${className}` : ""}`}><ImageOff size={24} />图片暂不可用</span>;
  return <img className={className} src={src} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}

function DetailGallery({ title, media }: { title: string; media: ListingDetailData["media"] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  if (media.length === 0) return <div className="detail-gallery"><span className="detail-image-fallback"><ImageOff size={24} />暂无可展示的图片</span></div>;
  const activeMedia = media[activeIndex] ?? media[0]!;
  return <div className="detail-gallery" aria-label={`${title}公开展示图`}>
    <div className="detail-gallery-main">
      <DetailImage src={activeMedia.url} alt={`${title}公开展示图，第${activeIndex + 1}张`} />
      {media.length > 1 ? <span className="detail-gallery-count">第 {activeIndex + 1} / {media.length} 张</span> : null}
    </div>
    {media.length > 1 ? <div className="detail-gallery-thumbs" aria-label="选择公开展示图">
      {media.map((item, index) => <button key={item.assetId} type="button" className="detail-gallery-thumb" aria-label={`查看第 ${index + 1} 张公开展示图`} aria-pressed={index === activeIndex} onClick={() => setActiveIndex(index)}>
        <DetailImage src={item.url} alt="" className="detail-gallery-thumb-image" />
        <span className="detail-gallery-thumb-index">{index + 1}</span>
      </button>)}
    </div> : null}
  </div>;
}

function DetailView({ accountId }: { accountId: string }) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [back, setBack] = useState<{ href: string; label: string }>({ href: "/accounts", label: "返回账号列表" });
  useEffect(() => {
    setBack(accountReturnTarget(readAccountReturn(accountId)));
  }, [accountId]);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    supplyApi
      .listing(accountId, controller.signal)
      .then((listing) => {
        if (!controller.signal.aborted) setState({ status: "ready", data: toListingDetail(listing) });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const unavailable = error instanceof SupplyRequestError && [401, 403, 404].includes(error.status);
        setState({ status: unavailable ? "unavailable" : "error" });
      });
    return () => controller.abort();
  }, [accountId, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const title = state.status === "ready" ? state.data.title : state.status === "unavailable" ? "账号暂不可用" : "账号详情";
  const description = state.status === "ready" ? state.data.displayNo ? `公开编号 ${state.data.displayNo}` : "公开编号待确认" : "账号详情";
  const breadcrumbs = detailBreadcrumbs(state.status === "ready" ? state.data.gameName : null);
  return <ServiceShell surface="detail" contextLabel={null} breadcrumbs={breadcrumbs} title={title} description={description} backHref={back.href} backLabel={back.label} searchLabel="在公开账号目录中搜索" searchPlaceholder="搜索其他账号">
    {state.status === "loading" ? <div className="account-grid listing-detail-loading" aria-busy="true" aria-label="正在加载账号详情"><AccountCardSkeleton /><AccountCardSkeleton /><AccountCardSkeleton /></div> :
      state.status === "unavailable" ? <section className="account-empty listing-unavailable" role="status">
        <h3>该账号暂不可用或已下架</h3>
        <p>该账号当前没有可公开的租用信息，请返回列表选择其他账号。</p>
        <Link className="button secondary" href={back.href}>{back.label}</Link>
      </section> :
      state.status === "error" ? <section className="account-empty" role="alert">
        <h3>账号详情加载失败</h3>
        <p>请检查网络后重试。</p>
        <button type="button" className="button secondary" onClick={retry}><RotateCw size={15} />重试</button>
      </section> :
      <article className="listing-detail">
        <DetailGallery title={state.data.title} media={state.data.media} />
        <div className="detail-sections">
          <section aria-labelledby="detail-resources"><h2 id="detail-resources">资源与费用</h2>
            <dl className="detail-facts">
              {state.data.resourceLines.map((line) => <div key={line.itemId}><dt>{line.name}</dt><dd>{resourceQuantityLabel(line)}{line.costLabel || line.unitPriceLabel ? <small className="detail-fact-note">{line.costLabel ? `本行费用 ${line.costLabel}` : "本行费用待确认"}{line.unitPriceLabel ? ` · 服务端单位价 ${line.unitPriceLabel}` : ""}</small> : null}</dd></div>)}
              <div><dt>资源费用</dt><dd className="detail-price">{state.data.resourceTotalLabel}</dd></div>
              <div><dt>押金</dt><dd>{state.data.depositLabel ?? "待确认"}</dd></div>
              <div><dt>预计合计</dt><dd className="detail-price">{state.data.payableTotalLabel ?? "待确认"}</dd></div>
              <div><dt>预计租期</dt><dd>{state.data.termLabel}</dd></div>
              <div><dt>报价来源</dt><dd>{state.data.quoteSourceLabel}</dd></div>
            </dl>
            <p className="detail-hint">最终费用以下单确认为准。旧来源租金、物品费、押金和比例保留在受限证据中，不与本次报价等同。</p>
          </section>
          <section aria-labelledby="detail-conditions"><h2 id="detail-conditions">账号条件</h2>
            {state.data.conditionLines.length > 0 ? <dl className="detail-facts">{state.data.conditionLines.map((line) => <div key={line.key}><dt>{line.label}</dt><dd>{line.value}</dd></div>)}</dl> :
              <p className="detail-hint">暂无可展示的条件。</p>}
          </section>
          <section aria-labelledby="detail-skins"><h2 id="detail-skins">展示皮肤</h2>
            {state.data.skinLabels.length > 0 ? <ul className="detail-skins">{state.data.skinLabels.map((name) => <li key={name}>{name}</li>)}</ul> :
              <p className="detail-hint">暂无可展示的皮肤；皮肤不自动加价。</p>}
          </section>
          <section aria-labelledby="detail-entitlements"><h2 id="detail-entitlements">权益与有效期</h2>
            {state.data.entitlementNames.length > 0 ? <ul className="detail-skins">{state.data.entitlementNames.map((name) => <li key={name}>{name}</li>)}</ul> :
              <p className="detail-hint">暂无已确认权益；未映射的旧权益不会按 0 展示。</p>}
          </section>
          {state.data.description && <section aria-labelledby="detail-description"><h2 id="detail-description">号主说明</h2><p className="detail-description">{state.data.description}</p></section>}
          <div className="detail-actions">
            <FavoriteButton accountId={state.data.id} title={state.data.title} variant="inline" />
            <FavoriteNotice />
          </div>
          <p className="detail-hint">支付与订单功能尚未开放。</p>
        </div>
      </article>}
  </ServiceShell>;
}
