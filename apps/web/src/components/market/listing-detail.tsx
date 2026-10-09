"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { getImageProps } from "next/image";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowRight, Box, CalendarDays, Check, ChevronLeft, ChevronRight, Clock3, Coins, Copy, Crosshair, Dumbbell, FileText, Gem, ImageOff, Info, LogIn, MapPin, Package, ReceiptText, RotateCw, Share2, Shield, Shirt, UserRound, Waves, X, Zap } from "lucide-react";
import { ServiceShell } from "@/components/layout/service-shell";
import { FavoriteButton, FavoriteNotice } from "@/components/favorites/favorite-button";
import { FavoritesProvider } from "@/components/favorites/favorites-context";
import { accountHref, composeGridTitle, isHaff, moneyValue, orderedQuoteResources } from "@/components/delta/account-card";
import { accountReturnTarget, readAccountReturn } from "@/lib/account-return";
import { canonicalResourceCode } from "@/lib/listing-filters";
import { DELTA_GAME_CODE } from "@/lib/supply-games";
import { detailBreadcrumbs, haffRatioLabel, resourceQuantityLabel, toListingDetail, type ListingDetailData, type ResourceLine } from "@/lib/listing-view";
import { supplyApi, SupplyRequestError } from "@/lib/supply-client";
import { RentalConfirmPanel } from "@/components/order/rental-confirm-panel";
import { useUserSession } from "@/components/session/user-session-provider";
import "./account-detail.css";

type DetailState = { status: "loading" } | { status: "ready"; data: ListingDetailData; gameCode?: string } | { status: "unavailable" } | { status: "error" };
type BackTarget = { href: string; label: string };

function AccountDetailBanner() {
  const desktop = getImageProps({ src: "/art/zhouzhou/account-detail-banner-d-desktop-final.png", width: 2141, height: 251, alt: "资源有据，租用有数；公开资料、费用构成与租赁规则", sizes: "100vw", loading: "eager" }).props;
  const mobile = getImageProps({ src: "/art/zhouzhou/account-detail-banner-a-mobile-v2.png", width: 2172, height: 724, alt: "三角洲行动账号租赁", sizes: "100vw", loading: "eager" }).props;
  return <section className="account-detail-banner" aria-label="三角洲行动账号租赁">
    <picture>
      <source media="(max-width: 699px)" srcSet={mobile.srcSet} sizes={mobile.sizes} />
      <img {...desktop} src={desktop.src} className="account-detail-banner-image" />
    </picture>
  </section>;
}

export function ListingDetail({ accountId }: { accountId: string }) {
  return <FavoritesProvider><DetailView accountId={accountId} /></FavoritesProvider>;
}

function DetailImage({ src, alt, className, loading = "lazy", onLoad }: { src: string; alt: string; className?: string; loading?: "lazy" | "eager"; onLoad?: (image: HTMLImageElement) => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return <span className={`detail-image-fallback${className ? ` ${className}` : ""}`}><ImageOff size={24} />图片暂不可用</span>;
  return <img className={className} src={src} alt={alt} loading={loading} onLoad={event => onLoad?.(event.currentTarget)} onError={() => setFailed(true)} />;
}

function DetailGallery({ title, media }: { title: string; media: ListingDetailData["media"] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [shape, setShape] = useState<{ assetId: string; ratio: number } | null>(null);
  const galleryMedia = media.filter((m) => m.category !== "PENALTY");
  const activeList = galleryMedia;
  useEffect(() => setActiveIndex(0), [media]);
  if (activeList.length === 0) return <div className="detail-gallery"><span className="detail-image-fallback"><ImageOff size={24} />暂无可展示的图片</span></div>;
  const index = Math.min(activeIndex, activeList.length - 1);
  const activeMedia = activeList[index]!;
  const select = (next: number) => setActiveIndex(Math.max(0, Math.min(activeList.length - 1, next)));
  return <div className="detail-gallery" aria-label={`${title}公开展示图`} onKeyDown={event => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const next = Math.max(0, Math.min(activeList.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
    select(next);
    if (!previewOpen && event.target instanceof Element && event.target.closest(".detail-gallery-thumbs")) event.currentTarget.querySelectorAll<HTMLElement>(".detail-gallery-thumb")[next]?.focus();
  }}>
    <div className="detail-gallery-stage">
    <Dialog.Root open={previewOpen} onOpenChange={setPreviewOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="detail-gallery-main" style={{ aspectRatio: shape?.assetId === activeMedia.assetId ? shape.ratio : "16 / 9" }} aria-label={`放大查看第 ${index + 1} 张公开展示图`}>
          <DetailImage src={activeMedia.url} alt={`${title}公开展示图，第${index + 1}张`} loading="eager" onLoad={image => { if (image.naturalWidth && image.naturalHeight) setShape({ assetId: activeMedia.assetId, ratio: Math.max(1, Math.min(8, image.naturalWidth / image.naturalHeight)) }); }} />
          <span className="detail-gallery-count" aria-live="polite">{index + 1} / {activeList.length}</span>
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="detail-preview-content" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">{title} 大图预览</Dialog.Title>
          <Dialog.Close className="icon-button detail-preview-close" aria-label="关闭预览"><X size={18} aria-hidden="true" /></Dialog.Close>
          <DetailImage src={activeMedia.url} alt={`${title}公开展示图大图，第${index + 1}张`} className="detail-preview-image" loading="eager" />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    {activeList.length > 1 ? <>
      <button type="button" className="detail-gallery-nav detail-gallery-nav--previous" aria-label="上一张公开展示图" disabled={index === 0} onClick={() => select(index - 1)}><ChevronLeft size={20} aria-hidden="true" /></button>
      <button type="button" className="detail-gallery-nav detail-gallery-nav--next" aria-label="下一张公开展示图" disabled={index === activeList.length - 1} onClick={() => select(index + 1)}><ChevronRight size={20} aria-hidden="true" /></button>
    </> : null}
    </div>
    <div className="detail-gallery-thumbs" aria-label="选择公开展示图">
      {activeList.map((item, thumbnailIndex) => <button key={item.assetId} type="button" className="detail-gallery-thumb" aria-label={`选择第 ${thumbnailIndex + 1} 张公开展示图`} aria-pressed={thumbnailIndex === index} onClick={() => select(thumbnailIndex)}>
        <DetailImage src={item.url} alt="" className="detail-gallery-thumb-image" />
        <span className="detail-gallery-thumb-index">{thumbnailIndex + 1}</span>
      </button>)}
    </div>
  </div>;
}

function conditionValue(data: ListingDetailData, key: string): string | null {
  return data.conditionLines.find((line) => line.key === key)?.value ?? null;
}

function regionValue(data: ListingDetailData): string {
  const parts = [conditionValue(data, "region_province"), conditionValue(data, "region_city")].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "未提供";
}

function displayTime(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(value)).replaceAll("/", "-");
}

export function entitlementExpiryLabel(item: { expiresAt: string | null; expiryState: "MISSING" | "PERMANENT" | "TIMED" }, now = Date.now()): string {
  if (item.expiryState === "MISSING") return "期限未提供 · 覆盖范围以个人确认时为准";
  if (item.expiryState === "PERMANENT") return "长期权益 · 不保证覆盖全部租期";
  const time = displayTime(item.expiresAt);
  if (!time) return "到期时间未确认 · 覆盖范围以个人确认时为准";
  return `${Date.parse(item.expiresAt!) <= now ? "已到期" : "到期"} ${time} · 不保证覆盖全部租期`;
}

function unitPriceText(line: ResourceLine): string {
  if (!line.unitPriceLabel) return "未确认";
  const match = line.unitPriceLabel.match(/^(¥\d+(?:\.\d+)?)\s*\/\s*(\d+)\s+(.+)$/);
  if (!match) return line.unitPriceLabel;
  const amount = match[1]!.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
  const grouped = canonicalResourceCode(line.code) === "df_billable_level6_bullet" && match[2] === "60" && match[3] === "发";
  return `${amount} / ${grouped ? "组" : `${match[2] === "1" ? "" : match[2]}${match[3]}`}`;
}

function InventoryArt({ code }: { code: string | null }) {
  // Reuse the publisher's existing artwork and stable codes; no new inventory images.
  const art = ({ df_billable_awm_bullet: "awm-round", df_billable_level6_bullet: "level6-round", df_billable_barrett_bullet: "barrett-round", df_billable_level6_armor: "level6-armor", df_billable_level6_helmet: "level6-helmet", df_billable_coffee: "coffee-beans", top_insure_card_piece: "insurance-card", df_billable_top_insure_card_piece: "insurance-card" } as Record<string, string>)[canonicalResourceCode(code) ?? ""];
  return <span className="account-resource-art" aria-hidden="true">{art ? <DetailImage src={`/art/zhouzhou/inventory-polished/${art}.webp`} alt="" /> : <Box size={22} />}</span>;
}

function ReadyDetail({ data }: { data: ListingDetailData }) {
  const session = useUserSession();
  const identityKey = session.status === "authenticated" && session.userId ? session.userId : "guest";
  const [copyState, setCopyState] = useState<{ number: string; ok: boolean } | null>(null);
  const [linkState, setLinkState] = useState<{ accountId: string; ok: boolean } | null>(null);
  const number = data.displayNo?.trim() || null;
  const copyNumber = async () => {
    if (!number) return;
    try { await navigator.clipboard.writeText(number); setCopyState({ number, ok: true }); }
    catch { setCopyState({ number, ok: false }); }
  };
  const value = (key: string) => { const raw = conditionValue(data, key); return !raw ? "未提供" : raw.startsWith("未确认（代码") ? "未确认" : raw; };
  const haff = data.resourceLines.find(isHaff);
  const titleParts = composeGridTitle({ ...data, title: data.publicTitle ?? "" }, haff ? resourceQuantityLabel(haff) : null);
  const rank = conditionValue(data, "grading_code");
  if (rank) titleParts.rest = titleParts.rest.replace(rank, `${rank}段位`);
  const title = [titleParts.haff, titleParts.rest].filter(Boolean).join(" · ");
  const fast = data.rentalMode === "fast";
  const copyLink = async () => {
    const accountId = data.id;
    try { await navigator.clipboard.writeText(new URL(accountHref(accountId), window.location.origin).href); setLinkState({ accountId, ok: true }); }
    catch { setLinkState({ accountId, ok: false }); }
  };
  const otherFacts = [
    { label: "哈夫币", value: haff ? resourceQuantityLabel(haff) : "未申报", icon: Coins },
    { label: "安全箱", value: value("safe_box_code"), icon: Box },
    { label: "游戏段位", value: value("grading_code"), icon: Gem },
    { label: "角色等级", value: value("character_level"), icon: UserRound },
    { label: "体力", value: value("vit_level"), icon: Dumbbell },
    { label: "负重", value: value("bear_level"), icon: Package },
    { label: "潜水", value: value("dive_level"), icon: Waves },
    { label: "绝密KD", value: value("secret_kd"), icon: Crosshair },
    { label: "地区", value: regionValue(data), icon: MapPin },
    { label: "参考比例", value: haff ? haffRatioLabel(haff.quantity, haff.costAmount) : "未确认", icon: Coins },
    { label: "出租模式", value: ({ ordinary: "普通出租", custom: "自定义出租", fast: "极速出租" } as Record<string, string>)[data.rentalMode ?? ""] ?? "未提供", icon: Package },
    { label: "人脸归属", value: "暂未公开", icon: UserRound },
    { label: "封禁声明", value: "暂未公开", icon: Shield },
  ];
  const factGroups = [
    { label: "账号基础", facts: otherFacts.slice(0, 4) },
    { label: "作战属性", facts: otherFacts.slice(4, 8) },
    { label: "租赁信息", facts: otherFacts.slice(8) },
  ];
  const summary = [
    { label: "上号方式", value: value("login_method_code"), icon: LogIn },
    { label: "配合上号", value: value("service_window"), icon: Clock3, note: "北京时间" },
    { label: "每日消耗", value: value("daily_consumption"), icon: Coins },
    { label: data.historicalReadOnly ? "来源租期" : "推算租期", value: data.termLabel, icon: CalendarDays },
  ];
  const published = displayTime(data.publishedAt);
  const resources = orderedQuoteResources(data);
  const penalties = data.media.filter(item => item.category === "PENALTY");
  const skinGroups = new Map<string, ListingDetailData["skinTags"]>();
  for (const tag of data.skinTags) { const category = tag.categoryName || "未分类"; skinGroups.set(category, [...(skinGroups.get(category) ?? []), tag]); }
  return <article className="listing-detail account-detail">
    <div className="account-detail-top">
      <section className="account-detail-info" aria-label="账号摘要">
        <h1 className="account-detail-title">{titleParts.haff ? <><strong className="account-title-haff account-title-part">{titleParts.haff}</strong>{titleParts.rest ? <span className="account-title-separator"> · </span> : null}</> : null}{titleParts.rest.split(" · ").map((part, index) => <span key={index}>{index > 0 ? <span className="account-title-separator"> · </span> : null}<span className="account-title-part">{part}</span></span>)}</h1>
        {fast ? <span className="account-detail-deal"><Zap size={14} aria-hidden="true" />特惠 · 极速出租</span> : null}
        <div className="account-identity">
          <div className="account-number-row"><span>账号编号</span><strong>{number ?? "未提供"}</strong>
            <button type="button" className="account-copy" disabled={!number} onClick={() => void copyNumber()} aria-label="复制账号编号">{copyState?.number === number && copyState.ok ? <Check size={16} /> : <Copy size={16} />}<span>复制</span></button>
          </div>
          <div className="account-published"><Clock3 size={15} aria-hidden="true" />{published ? <time dateTime={data.publishedAt!}>发布时间 {published}</time> : <span>发布时间未提供</span>}</div>
          {copyState?.number === number ? <p className="account-copy-note" role="status">{copyState.ok ? "账号编号已复制" : "暂时无法自动复制，请选中编号复制。"}</p> : null}
        </div>
        <div className="account-identity-actions"><FavoriteButton accountId={data.id} title={title} variant="inline" /><button type="button" className="button secondary account-share" onClick={() => void copyLink()}><Share2 size={16} aria-hidden="true" />{linkState?.accountId === data.id && linkState.ok ? "已复制链接" : "分享"}</button></div>
        {linkState?.accountId === data.id ? <p className="account-link-notice" role="status">{linkState.ok ? "链接已复制，可粘贴分享。" : "暂时无法复制，请复制地址栏链接。"}</p> : null}
      </section>
      <aside className="account-quote" aria-label="租赁报价">
        {data.historicalReadOnly ? <>
          <div className="account-quote-head"><h2><ReceiptText size={20} aria-hidden="true" />来源资源费用 · 历史只读</h2></div>
          <p className="account-readonly-badge">历史来源记录 · 不支持在线租赁</p>
          <p className="account-reference-price">{moneyValue(data.resourceTotalLabel)}</p>
          <dl className="account-fee-lines"><div><dt>哈夫币租金</dt><dd>{moneyValue(data.haffRentLabel)}</dd></div><div><dt>物资预付</dt><dd>{moneyValue(data.itemResourceTotalLabel)}</dd></div></dl>
          <p className="detail-stage-note account-readonly">这笔费用来自历史来源记录，不是当前本人应付。</p>
          <Link className="button secondary button--sm account-readonly-action" href="/accounts">返回可租账号列表</Link>
         </> : <>
           <RentalConfirmPanel key={`${identityKey}:${data.id}:${data.versionId}:${data.releaseId}`} accountId={data.id} gameId={data.gameId} versionId={data.versionId} releaseId={data.releaseId} autoQuote reference={{ total: moneyValue(data.resourceTotalLabel), haff: moneyValue(data.haffRentLabel), items: moneyValue(data.itemResourceTotalLabel) }} />
           <section className="account-process-panel account-process-panel--quote" aria-labelledby="account-process-title">
             <div className="account-section-title"><h2 id="account-process-title"><Shield size={20} aria-hidden="true" />租赁流程</h2><span>从核对到开租</span></div>
             <ol className="account-process-steps">
               {["核对资料与适用条款", "读取本人报价并确认建单", "付款后由真人客服协助履约", "交付确认后再开租"].map((step, index) => <li key={step}><span className="account-process-index">{String(index + 1).padStart(2, "0")}</span><div><strong>{step}</strong><span>{index === 0 ? "公开属性与当前发布版本" : index === 1 ? "会员价格与押金在确认时读取" : index === 2 ? "订单阶段由真人客服协助处理" : "交付确认后才进入开租阶段"}</span></div></li>)}
             </ol>
             <div className="account-rental-tip"><Info size={17} aria-hidden="true" /><p>付款与开租是不同阶段。费用和适用协议在个人确认时核对，实际金额与进度以订单为准。</p></div>
             <Link className="account-help-link" href="/help/rental-check-before-order">查看租赁须知 <ArrowRight size={15} aria-hidden="true" /></Link>
           </section>
         </>}
        <FavoriteNotice />
      </aside>
      <div className="account-detail-gallery"><DetailGallery title={title} media={data.media} /><p className="account-media-caption">号主提供 · 点击图片查看大图</p>
      <dl className="account-summary-conditions">{summary.map(fact => { const Icon = fact.icon; return <div key={fact.label}><dt><Icon size={24} aria-hidden="true" />{fact.label}</dt><dd>{fact.value}</dd>{fact.note && fact.value !== "未提供" ? <span>{fact.note}</span> : null}</div>; })}</dl>
      </div>
      <section className="account-detail-notes account-owner-section">
        <section aria-labelledby="account-note-title"><h2 id="account-note-title"><FileText size={20} aria-hidden="true" />号主说明</h2><p className="account-owner-note">{data.description || "暂无公开备注。"}</p><p className="account-note-source">资料由号主申报，以公开信息与当次适用条款核对。</p>
          <div className="account-cosmetics"><h3><Shirt size={17} aria-hidden="true" />皮肤与权益</h3>
            {data.skinTags.length || data.entitlementNames.length ? <>
              <div className="account-skin-groups">{[...skinGroups].map(([category, skins]) => <section key={category} className="account-skin-group"><div className="account-skin-group-head"><strong>{category}</strong><span>{skins.length}项 · 图片待接入</span></div><div className="account-skin-grid">{skins.map((tag, i) => <article key={`${tag.name}:${i}`} className="account-skin-card"><div className="account-skin-card-media"><Shirt size={22} aria-hidden="true" /><span>图鉴图片待接入</span></div><strong>{tag.name}</strong></article>)}</div></section>)}</div>
              <div className="account-entitlement-list">{data.entitlementDetails?.length ? data.entitlementDetails.map(item => <div key={item.id} className="account-entitlement-item"><strong>{item.name}</strong><span>{entitlementExpiryLabel(item)}</span></div>) : data.entitlementNames.map((name, index) => <div key={`${name}:${index}`} className="account-entitlement-item"><strong>{name}</strong><span>权益详情以个人确认时为准</span></div>)}</div>
            </> : <p className="account-empty-note">暂无皮肤或权益的公开申报。</p>}
          </div>
          {penalties.length ? <details className="account-penalties"><summary><Shield size={17} aria-hidden="true" /><span>处罚公示资料</span><span>{penalties.length}张 · 查看公示</span></summary><p className="account-note-source">号主提供的公开资料，不替代平台核验。</p><div>{penalties.map((item, index) => <DetailImage key={item.assetId} src={item.url} alt={`处罚公示资料，第${index + 1}张`} />)}</div></details> : null}
        </section>
      </section>

    </div>
    <section className="account-core" aria-labelledby="account-core-title">
      <h2 id="account-core-title"><Box size={20} aria-hidden="true" />账号参数</h2>
      <div className="account-fact-groups">{factGroups.map(group => <section key={group.label} className="account-fact-group" aria-labelledby={`account-fact-group-${group.label}`}>
        <h3 id={`account-fact-group-${group.label}`}>{group.label}</h3>
        <dl className="account-facts">{group.facts.map(fact => { const Icon = fact.icon; return <div key={fact.label} className="account-fact"><dt><Icon size={21} aria-hidden="true" /><span>{fact.label}</span></dt><dd>{fact.value}</dd></div>; })}</dl>
      </section>)}</div>
    </section>
    <div className="account-detail-body">
      <section className="account-stock" aria-labelledby="account-stock-title">
        <div className="account-section-title"><h2 id="account-stock-title"><Box size={20} aria-hidden="true" />物资库存</h2><span>号主申报数量</span></div>
        {resources.length ? <table className="account-stock-table"><thead><tr><th scope="col">物资</th><th scope="col">数量</th><th scope="col">参考单价</th><th scope="col">参考费用</th></tr></thead><tbody>
          {resources.map(line => <tr key={line.itemId}><th scope="row"><InventoryArt code={line.code} /><span>{line.name}</span></th><td data-label="数量">{resourceQuantityLabel(line)}</td><td data-label="参考单价" className={!line.unitPriceLabel ? "account-value-unknown" : undefined}>{line.unitPriceLabel ? unitPriceText(line) : "未返回"}</td><td data-label="参考费用" className={!line.costLabel ? "account-value-unknown" : undefined}>{line.costLabel ?? "未返回"}</td></tr>)}
        </tbody><tfoot><tr><th scope="row" colSpan={3}>物资参考合计</th><td>{data.itemResourceTotalLabel ?? "待服务端确认"}</td></tr></tfoot></table> : <p className="account-empty-note">尚未申报可展示的物资库存。</p>}
        {resources.length ? <div className="account-stock-legend" role="note"><Info size={15} aria-hidden="true" /><span>“未返回”表示公开接口没有给出参考价，不等于零。</span></div> : null}
        <p className="account-stock-note">物资金额先预付，最终按实际消耗与有效规则结算。</p>
      </section>
    </div>
  </article>;
}

function DetailView({ accountId }: { accountId: string }) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [back, setBack] = useState<BackTarget>({ href: "/accounts", label: "返回账号列表" });
  useEffect(() => {
    setBack(accountReturnTarget(readAccountReturn(accountId)));
  }, [accountId]);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    supplyApi
      .listing(accountId, controller.signal)
      .then((listing) => {
        if (!controller.signal.aborted) {
          if (listing.id !== accountId) throw new Error("Listing object mismatch");
          setState({ status: "ready", data: toListingDetail(listing), gameCode: listing.game?.code });
        }
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const unavailable = error instanceof SupplyRequestError && [401, 403, 404].includes(error.status);
        setState({ status: unavailable ? "unavailable" : "error" });
      });
    return () => controller.abort();
  }, [accountId, attempt]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const current = state.status === "ready" && state.data.id !== accountId ? { status: "loading" as const } : state;
  const title = "账号详情";
  const description = "";
  const breadcrumbs = detailBreadcrumbs(state.status === "ready" ? state.data.gameName : null);
  return <ServiceShell surface="detail" contextLabel={null} breadcrumbs={breadcrumbs} title={title} description={description} backHref={back.href} backLabel={back.label} showPageHeading={false} headingInContent={current.status === "ready"} searchLabel="在公开目录中搜索账号名称" searchInputLabel="搜索账号名称" searchPlaceholder="搜索其他账号名称">
    {current.status === "loading" ? <div className="detail-skeleton" aria-busy="true" aria-label="正在加载账号详情">
      <div className="detail-skeleton-hero" aria-hidden="true">
        <div className="detail-skeleton-gallery" />
        <div className="detail-skeleton-copy"><span /><span /><span /><span /></div>
      </div>
      <div className="detail-skeleton-blocks" aria-hidden="true"><div /><div /></div>
    </div> :
      current.status === "unavailable" ? <section className="account-empty listing-unavailable" role="status">
        <h3>该账号暂不可用或已下架</h3>
        <p>该账号当前没有可公开的租用信息，请返回列表选择其他账号。</p>
        <Link className="button secondary" href={back.href}>{back.label}</Link>
      </section> :
      current.status === "error" ? <section className="account-empty" role="alert">
        <h3>账号详情加载失败</h3>
        <p>请检查网络后重试。</p>
        <button type="button" className="button secondary" onClick={retry}><RotateCw size={15} />重试</button>
      </section> :
      <>
        {current.status === "ready" && current.gameCode === DELTA_GAME_CODE ? <AccountDetailBanner /> : null}
        {current.status === "ready" ? <ReadyDetail data={current.data} /> : null}
      </>}
  </ServiceShell>;
}
