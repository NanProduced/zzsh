"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { ArrowLeft, ImageOff, RotateCw, X } from "lucide-react";
import { ServiceShell } from "@/components/layout/service-shell";
import { FavoriteButton, FavoriteNotice } from "@/components/favorites/favorite-button";
import { FavoritesProvider } from "@/components/favorites/favorites-context";
import { isHaff, moneyValue, orderedQuoteResources, skinChipTone } from "@/components/delta/account-card";
import { accountReturnTarget, readAccountReturn } from "@/lib/account-return";
import { detailBreadcrumbs, resourceQuantityLabel, toListingDetail, type ListingDetailData } from "@/lib/listing-view";
import { supplyApi, SupplyRequestError } from "@/lib/supply-client";

type DetailState = { status: "loading" } | { status: "ready"; data: ListingDetailData } | { status: "unavailable" } | { status: "error" };
type BackTarget = { href: string; label: string };

const ANCHORS = [
  { id: "detail-info", label: "账号信息" },
  { id: "detail-resources", label: "资源与皮肤" },
  { id: "detail-shots", label: "账号截图" },
  { id: "detail-terms", label: "租赁说明" },
] as const;

const SKIN_GROUPS = [
  { tone: "teal", label: "刀皮 / 近战" },
  { tone: "purple", label: "干员皮肤" },
  { tone: "blue", label: "枪械皮肤" },
  { tone: "default", label: "其他" },
] as const;

export function ListingDetail({ accountId }: { accountId: string }) {
  return <FavoritesProvider><DetailView accountId={accountId} /></FavoritesProvider>;
}

function DetailImage({ src, alt, className, loading = "lazy" }: { src: string; alt: string; className?: string; loading?: "lazy" | "eager" }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) return <span className={`detail-image-fallback${className ? ` ${className}` : ""}`}><ImageOff size={24} />图片暂不可用</span>;
  return <img className={className} src={src} alt={alt} loading={loading} onError={() => setFailed(true)} />;
}

function DetailGallery({ title, media }: { title: string; media: ListingDetailData["media"] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  if (media.length === 0) return <div className="detail-gallery"><span className="detail-image-fallback"><ImageOff size={24} />暂无可展示的图片</span></div>;
  const activeMedia = media[activeIndex] ?? media[0]!;
  return <div className="detail-gallery" aria-label={`${title}公开展示图`}>
    <Dialog.Root open={previewOpen} onOpenChange={setPreviewOpen}>
      <Dialog.Trigger asChild>
        <button type="button" className="detail-gallery-main" aria-label={`放大查看第 ${activeIndex + 1} 张公开展示图`}>
          <DetailImage src={activeMedia.url} alt={`${title}公开展示图，第${activeIndex + 1}张`} loading="eager" />
          {media.length > 1 ? <span className="detail-gallery-count">第 {activeIndex + 1} / {media.length} 张</span> : null}
        </button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="detail-preview-content" aria-describedby={undefined}>
          <Dialog.Title className="sr-only">{title} 大图预览</Dialog.Title>
          <Dialog.Close className="icon-button detail-preview-close" aria-label="关闭预览"><X size={18} aria-hidden="true" /></Dialog.Close>
          <DetailImage src={activeMedia.url} alt={`${title}公开展示图大图，第${activeIndex + 1}张`} className="detail-preview-image" loading="eager" />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
    {media.length > 1 ? <div className="detail-gallery-thumbs" aria-label="选择公开展示图">
      {media.map((item, index) => <button key={item.assetId} type="button" className="detail-gallery-thumb" aria-label={`选择第 ${index + 1} 张公开展示图`} aria-pressed={index === activeIndex} onClick={() => setActiveIndex(index)}>
        <DetailImage src={item.url} alt="" className="detail-gallery-thumb-image" />
        <span className="detail-gallery-thumb-index">{index + 1}</span>
      </button>)}
    </div> : null}
  </div>;
}

function conditionValue(data: ListingDetailData, key: string): string | null {
  return data.conditionLines.find((line) => line.key === key)?.value ?? null;
}

function orDash(value: string | null | undefined): string {
  return value?.trim() ? value : "-";
}

function regionValue(data: ListingDetailData): string {
  const parts = [conditionValue(data, "region_province"), conditionValue(data, "region_city")].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "-";
}

function quoteNote(line: ListingDetailData["resourceLines"][number], informational: boolean): string {
  const parts = [line.costLabel ? `费用 ${line.costLabel}` : "费用待确认"];
  if (line.unitPriceLabel) parts.push(`服务端单位价 ${line.unitPriceLabel}${informational ? "（辅助说明）" : ""}`);
  return parts.join(" · ");
}

function feeValueClass(value: string, total: boolean): string {
  const pending = value === "待确认";
  if (total) return pending ? "detail-price detail-price--pending" : "detail-price";
  return pending ? "detail-fee-pending" : "detail-fee-value";
}

function ReadyDetail({ data, back, activeAnchor }: { data: ListingDetailData; back: BackTarget; activeAnchor: string }) {
  const serviceWindow = conditionValue(data, "service_window");
  const loginValue = conditionValue(data, "login_method_code");
  const haffLine = data.resourceLines.find(isHaff);
  const resourceRows = [...data.resourceLines.filter(isHaff), ...orderedQuoteResources(data)];
  const skinGroups = SKIN_GROUPS
    .map((group) => ({ ...group, skins: data.skinTags.filter((tag) => skinChipTone(tag) === group.tone) }))
    .filter((group) => group.skins.length > 0);
  const resourceSubtotal = moneyValue(data.resourceTotalLabel, "无需支付");
  const haffRent = moneyValue(data.haffRentLabel, "无需支付");
  const itemResource = moneyValue(data.itemResourceTotalLabel, "无物品费用");
  const deposit = moneyValue(data.depositLabel, "无需押金");
  const payableTotal = moneyValue(data.payableTotalLabel, "无需支付");
  const assetCells = [
    { label: "哈夫币", value: haffLine ? orDash(haffLine.quantityLabel || haffLine.quantity) : "-" },
    { label: "安全箱", value: orDash(conditionValue(data, "safe_box_code")) },
    { label: "段位", value: orDash(conditionValue(data, "grading_code")) },
  ];
  const matrixCells = [
    { label: "体力", value: orDash(conditionValue(data, "vit_level")) },
    { label: "负重", value: orDash(conditionValue(data, "bear_level")) },
    { label: "绝密 KD", value: orDash(conditionValue(data, "secret_kd")) },
    { label: "登录方式", value: orDash(loginValue) },
    { label: "每日消耗", value: orDash(conditionValue(data, "daily_consumption")) },
  ];
  const overviewFields = [
    { label: "账号编号", value: data.displayNo ?? "-" },
    { label: "地区", value: regionValue(data) },
    { label: "角色等级", value: orDash(conditionValue(data, "character_level")) },
    { label: "潜水等级", value: orDash(conditionValue(data, "dive_level")) },
    { label: "租期规则", value: data.termOptionLabel ?? "-" },
  ];
  const rules = [
    { label: "租期", value: data.termLabel },
    { label: "结算规则", value: "物品金额先预付，结算按实际使用量核算，未使用部分退还；最终以订单结算为准。" },
    { label: "真人客服履约", value: "租赁期间由真人客服协助完成上号与使用问题处理。" },
    { label: "支付与订单", value: "支付与订单功能尚未开放。" },
  ];

  return <article className="listing-detail">
    <div className="detail-topbar">
      <Link className="functional-back" href={back.href}><ArrowLeft size={16} aria-hidden="true" /><span>{back.label}</span></Link>
    </div>

    <div className="detail-hero">
      <DetailGallery title={data.title} media={data.media} />
      <div className="detail-hero-summary">
        <div className="detail-hero-title-row">
          <h2 className="detail-hero-title">{data.title}</h2>
          {data.rentalMode === "fast" ? <span className="detail-deal-tag">特惠</span> : null}
        </div>
        <p className="detail-meta">
          {serviceWindow ? <span>可上号 {serviceWindow}</span> : null}
          <span>租期 {data.termLabel}</span>
        </p>
        <dl className="detail-assets" aria-label="核心资产">
          {assetCells.map((cell) => <div key={cell.label}>
            <dt>{cell.label}</dt>
            <dd>{cell.value}</dd>
          </div>)}
        </dl>
        <dl className="detail-matrix" aria-label="关键条件">
          {matrixCells.map((cell) => <div key={cell.label} className="detail-matrix-cell">
            <dt>{cell.label}</dt>
            <dd>{cell.value}</dd>
          </div>)}
        </dl>
        <div className="detail-fees" role="group" aria-label="费用摘要">
          <div className="detail-fee-group" role="group" aria-label="资源费用">
            <div className="detail-fee-row detail-fee-row--head"><span className="detail-fee-label">资源费用小计</span><span className={feeValueClass(resourceSubtotal, false)}>{resourceSubtotal}</span></div>
            <div className="detail-fee-row detail-fee-row--sub"><span className="detail-fee-label">哈夫币租金</span><span className={feeValueClass(haffRent, false)}>{haffRent}</span></div>
            <div className="detail-fee-row detail-fee-row--sub"><span className="detail-fee-label">物品资源费用</span><span className={feeValueClass(itemResource, false)}>{itemResource}</span></div>
          </div>
          <div className="detail-fee-row"><span className="detail-fee-label">押金</span><span className={feeValueClass(deposit, false)}>{deposit}</span></div>
          <div className="detail-fee-row detail-fee-row--total"><span className="detail-fee-label">预计合计</span><span className={feeValueClass(payableTotal, true)}>{payableTotal}</span></div>
        </div>
        <div className="detail-hero-actions">
          <FavoriteButton accountId={data.id} title={data.title} variant="inline" />
          <p className="detail-stage-note">当前仅展示公开报价，确认租赁功能暂未开放</p>
        </div>
        <FavoriteNotice />
      </div>
    </div>

    <nav className="detail-anchors" aria-label="详情章节">
      {ANCHORS.map(({ id, label }) => <a key={id} href={`#${id}`} aria-current={activeAnchor === id ? "true" : undefined}>{label}</a>)}
    </nav>

    <div className="detail-sections">
      <section id="detail-info" aria-labelledby="detail-info-heading">
        <div className="detail-section-heading">
          <h2 id="detail-info-heading">账号概览</h2>
          <p className="detail-section-note">数据由号主提供，仅供参考。</p>
        </div>
        <dl className="detail-overview">
          {overviewFields.map((field) => <div key={field.label}>
            <dt>{field.label}</dt>
            <dd>{field.value}</dd>
          </div>)}
        </dl>
        {data.description ? <>
          <h3 className="detail-subheading">号主说明</h3>
          <p className="detail-description">{data.description}</p>
        </> : null}
      </section>

      <section id="detail-resources" aria-labelledby="detail-resources-heading">
        <div className="detail-section-heading">
          <h2 id="detail-resources-heading">资源与费用明细</h2>
        </div>
        {resourceRows.length > 0 ? <div className="detail-table-wrap">
          <table className="detail-table">
            <thead>
              <tr><th scope="col">资源名称</th><th scope="col">数量</th><th scope="col">报价说明</th></tr>
            </thead>
            <tbody>
              {resourceRows.map((line) => <tr key={line.itemId}>
                <td>{line.name}{isHaff(line) ? <span className="detail-line-tag">哈夫币租金</span> : null}</td>
                <td data-label="数量">{resourceQuantityLabel(line)}</td>
                <td data-label="报价说明" className="detail-table-note">{quoteNote(line, data.unitAmountsInformational)}</td>
              </tr>)}
            </tbody>
          </table>
        </div> : <p className="detail-hint">暂无可展示的资源明细。</p>}
      </section>

      <section id="detail-skins" aria-labelledby="detail-skins-heading">
        <div className="detail-section-heading">
          <h2 id="detail-skins-heading">皮肤与权益</h2>
          <p className="detail-section-note">部分皮肤仅作展示，具体以游戏内实际为准。</p>
        </div>
        <h3 className="detail-subheading">皮肤</h3>
        {data.skinTags.length > 0 ? <div className="detail-skin-groups">
          {skinGroups.map((group) => <div key={group.tone} className={`detail-skin-group detail-skin-group--${group.tone}`}>
            <div className="detail-skin-group-head"><span>{group.label}</span><span>{group.skins.length} 个</span></div>
            <ul className="detail-skin-tags">
              {group.skins.map((tag, index) => <li key={`${tag.name}-${index}`} className={`account-skin-chip account-skin-chip--${group.tone}`} title={tag.name}>{tag.name}</li>)}
            </ul>
          </div>)}
        </div> : <p className="detail-hint">暂无可展示的皮肤。</p>}
        <h3 className="detail-subheading">权益</h3>
        {data.entitlementNames.length > 0 ? <ul className="detail-skins">
          {data.entitlementNames.map((name) => <li key={name}>{name}</li>)}
        </ul> : <p className="detail-hint">暂无已确认权益。</p>}
      </section>

      <section id="detail-shots" aria-labelledby="detail-shots-heading">
        <div className="detail-section-heading">
          <h2 id="detail-shots-heading">账号截图</h2>
          {data.media.length > 0 ? <p className="detail-section-note">共 {data.media.length} 张截图</p> : null}
        </div>
        {data.media.length > 0 ? <div className="detail-shots">
          {data.media.map((item, index) => <DetailImage key={item.assetId} src={item.url} alt={`${data.title}账号截图，第${index + 1}张`} className="detail-shot-image" />)}
        </div> : <p className="detail-hint">暂无可展示的截图。</p>}
      </section>

      <section id="detail-terms" aria-labelledby="detail-terms-heading">
        <div className="detail-section-heading">
          <h2 id="detail-terms-heading">租赁说明与履约规则</h2>
        </div>
        <dl className="detail-rules">
          {rules.map((rule) => <div key={rule.label}>
            <dt>{rule.label}</dt>
            <dd>{rule.value}</dd>
          </div>)}
        </dl>
      </section>

      <section className="detail-similar" aria-labelledby="detail-similar-heading">
        <div>
          <h2 id="detail-similar-heading">相似账号</h2>
          <p className="detail-hint">更多账号请返回列表浏览</p>
        </div>
        <Link className="button secondary" href={back.href}>{back.label}</Link>
      </section>
    </div>
  </article>;
}

function DetailView({ accountId }: { accountId: string }) {
  const [state, setState] = useState<DetailState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [activeAnchor, setActiveAnchor] = useState<string>(ANCHORS[0].id);
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
        if (!controller.signal.aborted) setState({ status: "ready", data: toListingDetail(listing) });
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        const unavailable = error instanceof SupplyRequestError && [401, 403, 404].includes(error.status);
        setState({ status: unavailable ? "unavailable" : "error" });
      });
    return () => controller.abort();
  }, [accountId, attempt]);
  useEffect(() => {
    if (state.status !== "ready" || typeof IntersectionObserver === "undefined") return;
    const anchorByNode = new Map<Element, string>();
    for (const { id } of ANCHORS) {
      const node = document.getElementById(id);
      if (node) anchorByNode.set(node, id);
      if (id === "detail-resources") {
        const skins = document.getElementById("detail-skins");
        if (skins) anchorByNode.set(skins, id);
      }
    }
    if (anchorByNode.size === 0) return;
    const visible = new Set<string>();
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const id = anchorByNode.get(entry.target);
        if (!id) continue;
        if (entry.isIntersecting) visible.add(id);
        else visible.delete(id);
      }
      const active = ANCHORS.find(({ id }) => visible.has(id));
      if (active) setActiveAnchor(active.id);
    }, { rootMargin: "-15% 0px -35% 0px" });
    for (const node of anchorByNode.keys()) observer.observe(node);
    return () => observer.disconnect();
  }, [state.status]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  const title = state.status === "ready" ? state.data.title : state.status === "unavailable" ? "账号暂不可用" : "账号详情";
  const description = state.status === "ready" ? state.data.displayNo ? `公开编号 ${state.data.displayNo}` : "公开编号待确认" : "账号详情";
  const breadcrumbs = detailBreadcrumbs(state.status === "ready" ? state.data.gameName : null);
  return <ServiceShell surface="detail" contextLabel={null} breadcrumbs={breadcrumbs} title={title} description={description} backHref={back.href} backLabel={back.label} showPageHeading={false} searchLabel="在公开账号目录中搜索" searchPlaceholder="搜索其他账号">
    {state.status === "loading" ? <div className="detail-skeleton" aria-busy="true" aria-label="正在加载账号详情">
      <div className="detail-skeleton-hero" aria-hidden="true">
        <div className="detail-skeleton-gallery" />
        <div className="detail-skeleton-copy"><span /><span /><span /><span /></div>
      </div>
      <div className="detail-skeleton-blocks" aria-hidden="true"><div /><div /></div>
    </div> :
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
      <ReadyDetail data={state.data} back={back} activeAnchor={activeAnchor} />}
  </ServiceShell>;
}
