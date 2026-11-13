"use client";

import Link from "next/link";
import { Dialog } from "@base-ui/react/dialog";
import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronDown, ChevronRight, Copy, ImageOff, Images, Info, Package, Pencil, ReceiptText, RefreshCw, ShieldCheck, SlidersHorizontal, Sparkles, Undo2, X } from "lucide-react";
import { SkinMediaPreview, SkinMetadata, skinCardTitle } from "./supply/skin-media-thumb";
import { ConfirmAlertDialog } from "./ui/alert-dialog";
import { LegacyAccountImage } from "@zzsh/ui/legacy-account-image";
import { formatReferenceYuan } from "@zzsh/ui/display-money";
import { AccountMediaPlaceholder } from "@zzsh/ui/account-media-placeholder";
import { CONDITION_LABELS, booleanDeclarationText, conditionLines, haffMillionsLabel, skinTypeLabel, termLabel, unitLabel, toListingDetail, type ResourceLine } from "../lib/listing-view";
import { deriveAccountTitle } from "../lib/account-title";
import { mediaAccessUrl, supplyApi, supplyBlockerMessages } from "../lib/supply-client";
import type { MySupply } from "../lib/supply-types";

export function AccountCopyInline({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="mra-copy-btn"
      title="复制账号编号"
      aria-label={copied ? "已复制账号编号" : "复制账号编号"}
      onClick={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void navigator.clipboard.writeText(text);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
    >
      {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
    </button>
  );
}

export function moneyText(money: { amount: string } | null | undefined): string {
  return money ? `${money.amount} 元` : "待确认";
}

/** Unit prices arrive at eight decimals; show the readable figure next to the quantity it is quoted per. */
function unitPriceText(money: { amount: string } | null | undefined, unitQuantity: string | undefined, unit: string): string {
  if (!money) return "未返回";
  const price = formatReferenceYuan(money.amount);
  return price ? `${price} / ${unitQuantity && unitQuantity !== "1" ? `${unitQuantity} ` : ""}${unit}`.trim() : "未返回";
}

export function stateLabel(state: string | null | undefined): string {
  return ({ DRAFT: "草稿", SUBMITTED: "审核中", WITHDRAWN: "已撤回", REJECTED: "已退回", APPROVED: "已通过", PUBLISHED: "已上架", IMPORTED_UNVERIFIED: "待复核" } as Record<string, string>)[state ?? ""] ?? "未确认";
}

function blockerText(code: string): string {
  return supplyBlockerMessages[code] ?? "当前资料暂不能继续，请读取最新状态或稍后重试。";
}

const CONDITION_LEVELS = new Set(["vit_level", "bear_level", "dive_level", "character_level"]);

const REVIEW_TONE: Record<string, string> = {
  PUBLISHED: "completed", APPROVED: "completed", SUBMITTED: "pending",
  REJECTED: "expired", DRAFT: "cancelled", WITHDRAWN: "cancelled", IMPORTED_UNVERIFIED: "unknown",
};

const AVAILABILITY_TONE = { open: "completed", uncertain: "pending", blocked: "expired" } as const;

function displayTime(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .format(new Date(value)).replaceAll("/", "-");
}

/**
 * Account conditions, reusing the account-listing label tables. A code the catalog cannot map is
 * reported as "{label}规格待确认" — the raw code is never guessed into a display name.
 */
function conditionRows(version: MySupply["version"]): Array<{ key: string; label: string; value: string }> {
  const attributes = version?.declaration?.attributes as Record<string, unknown> | undefined;
  if (!attributes) return [];
  const display = version?.attributeDisplay ?? null;
  const rows: Array<{ key: string; label: string; value: string }> = [];
  const codeValue = (code: { displayName: string | null; mappingStatus: string } | null | undefined, label: string) =>
    code?.mappingStatus === "CONFIRMED" && code.displayName ? code.displayName : `${label}规格待确认`;
  for (const [key, label] of Object.entries(CONDITION_LABELS)) {
    const raw = attributes[key];
    if (raw === null || raw === undefined || raw === "") continue;
    if (key === "safe_box_code") rows.push({ key, label, value: codeValue(display?.safeBox, label) });
    else if (key === "grading_code") rows.push({ key, label, value: codeValue(display?.grading, label) });
    else if (key === "login_method_code") rows.push({ key, label, value: codeValue(display?.loginMethod, label) });
    else if (key === "next_season_pass" || key === "demulan_unlocked") rows.push({ key, label, value: booleanDeclarationText(key, raw) });
    else if (CONDITION_LEVELS.has(key)) rows.push({ key, label, value: `${raw} 级` });
    else rows.push({ key, label, value: String(raw) });
  }
  if (display?.serviceWindow) rows.push({ key: "service_window", label: "上号时间", value: display.serviceWindow.displayName });
  if (typeof attributes.info_source === "string" && attributes.info_source.trim()) rows.push({ key: "info_source", label: "信息来源", value: attributes.info_source });
  return rows;
}

const UNCERTAIN_BLOCKERS = new Set(["PUBLISHER_BAIL_UNCONFIRMED", "FUNDING_UNKNOWN", "OCCUPANCY_UNKNOWN"]);

/**
 * Whether this account can take a new order comes from the server's aggregated `available` verdict.
 * The client never recombines pause flags, restrictions and coverage into its own boolean.
 */
function availabilityView(detail: MySupply): { tone: "open" | "blocked" | "uncertain"; label: string } {
  if (detail.account.lifecycle === "DELISTED") return { tone: "blocked", label: "已下架" };
  if (detail.account.lifecycle === "ARCHIVED") return { tone: "blocked", label: "已结束出租" };
  if (detail.version?.origin === "LEGACY_OBSERVATION" || detail.blockers?.includes("LEGACY_LISTING_RELIST_REQUIRED")) return { tone: "uncertain", label: "历史只读，不接新单" };
  const reasons = [...new Set([...(detail.blockers ?? []), ...(detail.account.staff_restricted ? ["STAFF_RESTRICTED"] : [])])];
  if (detail.available === true) return { tone: "open", label: "当前可接新单" };
  if (detail.available === false) {
    return reasons.some((code) => UNCERTAIN_BLOCKERS.has(code)) || reasons.length === 0
      ? { tone: "uncertain", label: "资格待确认" }
      : { tone: "blocked", label: "暂不可接新单" };
  }
  return { tone: "uncertain", label: "资格待确认" };
}

type ResourceRow = { code: string | null; rawUnit: string; name: string; unit: string; quantity: string | null; ownerUnit: string | null; ownerAmount: string | null };

function resourceRows(version: MySupply["version"]): ResourceRow[] {
  const lines = version?.quote?.lines ?? [];
  const catalog = version?.catalogItems ?? [];
  const items = version?.presentation?.items ?? [];
  return lines.map((line) => {
    const known = catalog.find((entry) => entry.id === line.itemId) ?? items.find((entry) => entry.id === line.itemId);
    const rawUnit = line.unit ?? known?.unit ?? "";
    const unit = unitLabel(rawUnit);
    return {
      code: known?.code ?? null,
      rawUnit,
      name: known?.name || "资源",
      unit,
      quantity: line.quantity ?? line.unitQuantity ?? null,
      ownerUnit: unitPriceText(line.ownerUnitAmount, line.unitQuantity, unit),
      ownerAmount: moneyText(line.ownerAmount),
    };
  });
}

/**
 * Public account media, with the three states the page has to distinguish: loading, failed (with a
 * retry), and genuinely absent. The frame keeps its shape while loading so nothing jumps.
 */
function AccountMedia({ assetId, alt, className }: { assetId: string; alt: string; className?: string }) {
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [attempt, setAttempt] = useState(0);
  return <div className={`supply-media-frame${className ? ` ${className}` : ""}`} data-state={state}>
    {state === "loading" ? <span className="supply-media-skeleton" aria-hidden="true" /> : null}
    {state === "error" ? <div className="supply-media-error" role="status"><ImageOff size={18} aria-hidden="true" /><span>图片加载失败</span><button type="button" className="button secondary button--sm" onClick={() => { setState("loading"); setAttempt((value) => value + 1); }}>重试</button></div> : null}
    <img key={attempt} style={state === "error" ? { display: "none" } : undefined} src={mediaAccessUrl(assetId)} alt={alt} loading="lazy" onLoad={() => setState("ready")} onError={() => setState("error")} />
  </div>;
}

function historicalQuantityText(quantity: string | null, unit: string): string {
  if (quantity === null || !/^[0-9]{1,24}$/.test(quantity)) return "数量待核";
  return unit === "HAFF_BASE" ? haffMillionsLabel(quantity) + " M 哈夫币" : BigInt(quantity).toLocaleString("zh-CN") + " " + unitLabel(unit);
}

function renderUnifiedSpecsGrid(
  items: Array<{ key: string; label: string; value: string }>,
  attrs: Record<string, unknown> | null | undefined,
  alwaysShowDeclarations: boolean,
) {
  const provinceCond = items.find((c) => c.key === "region_province");
  const cityCond = items.find((c) => c.key === "region_city");
  const regionVal = provinceCond && cityCond
    ? (provinceCond.value === cityCond.value ? provinceCond.value : `${provinceCond.value} · ${cityCond.value}`)
    : provinceCond?.value || cityCond?.value || null;
  const nonRegion = items.filter((c) => c.key !== "region_province" && c.key !== "region_city");
  const orderedKeys = [
    "safe_box_code", "grading_code", "character_level", "secret_kd",
    "vit_level", "bear_level", "dive_level", "login_method_code",
  ];
  const primaryList = orderedKeys
    .map((k) => nonRegion.find((c) => c.key === k))
    .filter((c): c is (typeof items)[number] => Boolean(c));
  const serviceWindowCond = nonRegion.find((c) => c.key === "service_window");
  const remainingList = nonRegion.filter((c) => !orderedKeys.includes(c.key) && c.key !== "service_window");
  const showFace = alwaysShowDeclarations || typeof attrs?.face_is_self === "boolean";
  const showBan = alwaysShowDeclarations || typeof attrs?.ban_record === "boolean";
  return (
    <div className="supply-unified-specs-grid">
      {primaryList.map((item) => (
        <div key={item.key} className={`supply-spec-pill${item.key === "safe_box_code" ? " highlight" : ""}`} data-key={item.key}>
          <span className="supply-spec-pill-k">{item.label}</span>
          <strong className="supply-spec-pill-v">{item.value}</strong>
        </div>
      ))}
      {regionVal ? (
        <div className="supply-spec-pill" data-key="region">
          <span className="supply-spec-pill-k">游戏地区</span>
          <strong className="supply-spec-pill-v">{regionVal}</strong>
        </div>
      ) : null}
      {serviceWindowCond ? (
        <div className="supply-spec-pill" data-key="service_window">
          <span className="supply-spec-pill-k">{serviceWindowCond.label}</span>
          <strong className="supply-spec-pill-v">{serviceWindowCond.value}</strong>
        </div>
      ) : null}
      {showFace ? (
        <div className="supply-spec-pill" data-key="face_declaration">
          <span className="supply-spec-pill-k">人脸声明</span>
          <strong className="supply-spec-pill-v">{attrs?.face_is_self === true ? "号主声明本人脸" : attrs?.face_is_self === false ? "号主声明非本人脸" : "未提供"}</strong>
        </div>
      ) : null}
      {showBan ? (
        <div className="supply-spec-pill" data-key="ban_declaration">
          <span className="supply-spec-pill-k">封禁记录声明</span>
          <strong className="supply-spec-pill-v">{attrs?.ban_record === true ? "号主声明有封禁记录" : attrs?.ban_record === false ? "号主声明无封禁记录" : "未提供"}</strong>
        </div>
      ) : null}
      {remainingList.map((item) => (
        <div key={item.key} className="supply-spec-pill" data-key={item.key}>
          <span className="supply-spec-pill-k">{item.label}</span>
          <strong className="supply-spec-pill-v">{item.value}</strong>
        </div>
      ))}
    </div>
  );
}

export function AccountDetail({ detail, gameName, latest, busy, identityReady, onAction, onRefresh, onAdopt }: { detail: MySupply; gameName?: string | null; latest: MySupply | null; busy: string; identityReady: boolean; onAction: (action: "withdraw" | "delist") => Promise<void>; onRefresh: () => void; onAdopt: () => void }) {
  const account = detail.account;
  const version = detail.version;
  const historicalReadOnly = version?.origin === "LEGACY_OBSERVATION" || Boolean(detail.blockers?.includes("LEGACY_LISTING_RELIST_REQUIRED"));
  // DTO 降级（S16）：historicalRead 缺子对象按「不渲染该块」处理，不整页崩。
  const historical = detail.historicalRead?.historicalQuote ? detail.historicalRead : null;
  const savedDisplay = historical?.display?.state === "KNOWN" ? historical.display.facts : null;
  const historicalDisplay = savedDisplay?.attributes && Array.isArray(savedDisplay.resources) ? savedDisplay : null;
  const historicalRatio = historicalDisplay?.sourceAccountBaseRatioWanPerYuan ? formatReferenceYuan(historicalDisplay.sourceAccountBaseRatioWanPerYuan)?.replace("¥", "") : null;
  const historicalConditions = historicalDisplay ? conditionLines(historicalDisplay.attributes, { attributeDisplay: historicalDisplay.attributeDisplay }) : [];
  // 列表「查看退回原因」锚链：详情异步插入后自行把 #blockers 滚入视野并接管焦点。
  const blockersRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (typeof window === "undefined" || window.location.hash !== "#blockers") return;
    const target = blockersRef.current;
    if (!target) return;
    target.scrollIntoView?.();
    target.focus?.({ preventScroll: true });
  }, [detail.account.id]);
  const declaration = version?.declaration;
  const quote = version?.quote ?? null;
  const publication = version?.publication ?? null;
  const publishedAt = displayTime(publication?.publishedAt);
  const reasons = historicalReadOnly ? [] : detail.decisions?.filter((decision) => decision.decision === "REJECT") ?? [];
  const blockers = [...new Set([...(detail.blockers ?? []), ...(account.staff_restricted ? ["STAFF_RESTRICTED"] : [])])].filter(code => !historicalReadOnly || code === "STAFF_RESTRICTED");
  const availability = availabilityView(detail);
  const conditions = conditionRows(version);
  const resources = resourceRows(version);
  const titleResources: ResourceLine[] = version
    ? (version.quote?.lines ?? []).map((line, index) => {
        const known = version.catalogItems?.find((entry) => entry.id === line.itemId) ?? version.presentation?.items?.find((entry) => entry.id === line.itemId);
        const quantity = line.quantity ?? line.unitQuantity ?? "";
        return { itemId: line.itemId || `account_line_${index}`, code: known?.code ?? null, name: known?.name ?? "资源", quantity, quantityLabel: quantity, unitLabel: unitLabel(line.unit ?? known?.unit ?? ""), costAmount: null, costLabel: null, unitPriceLabel: null };
      })
    : (historicalDisplay?.resources ?? []).map((resource, index) => ({
        itemId: resource.code || `historical_line_${index}`, code: resource.code, name: resource.name || "资源", quantity: resource.quantity ?? "", quantityLabel: resource.quantity ?? "", unitLabel: unitLabel(resource.unit), costAmount: null, costLabel: null, unitPriceLabel: null,
      }));
  const titleConditions = version ? conditions : historicalConditions;
  const accountTitle = deriveAccountTitle({ resourceLines: titleResources, conditionLines: titleConditions });
  const displayTitle = accountTitle.primary && accountTitle.primary !== "游戏账号" ? accountTitle.primary : "出租账号";
  const displayMedia = (declaration?.mediaBindings ?? []).filter((item) => item.purpose === "ACCOUNT_DISPLAY" && item.publicDisplayEligible !== false);
  const evidenceMedia = (declaration?.mediaBindings ?? []).filter((item) => item.purpose === "ACCOUNT_EVIDENCE");
  const penaltyMedia = displayMedia.filter((item) => item.category === "PENALTY");
  const galleryMedia = displayMedia.filter((item) => item.category !== "PENALTY");
  const unconfirmedNativeDraft = version?.origin === "NATIVE" && version.reviewState === "DRAFT" && version.contentHash === null;
  const draftSkinSummary = unconfirmedNativeDraft && version.draftSkinSummary?.source === "CURRENT_DRAFT_SELECTION" ? version.draftSkinSummary : null;
  const legacyHolding = version?.legacySkinHolding;
  const legacySkinVersion = version?.origin === "LEGACY_OBSERVATION" || Boolean(legacyHolding);
  const legacySkinAdmitted = legacyHolding?.state === "ADMITTED" && Number.isSafeInteger(legacyHolding.admittedCount) && legacyHolding.admittedCount! >= 0
    && Array.isArray(legacyHolding.items) && legacyHolding.items.every(skin => skin && typeof skin.id === "string" && typeof skin.name === "string")
    && Number.isSafeInteger(legacyHolding.withheldCount) && legacyHolding.withheldCount! >= 0
    && legacyHolding.items.length + legacyHolding.withheldCount! === legacyHolding.admittedCount;
  const skins = legacySkinVersion ? legacySkinAdmitted ? legacyHolding!.items! : [] : draftSkinSummary ? draftSkinSummary.items : version?.presentation?.skins ?? [];
  const withheldSkins = legacySkinVersion ? legacySkinAdmitted ? legacyHolding!.withheldCount! : 0 : draftSkinSummary?.withheld ?? 0;
  const skinCountKnown = legacySkinVersion ? legacySkinAdmitted : Boolean(draftSkinSummary) || (!unconfirmedNativeDraft && Array.isArray(version?.presentation?.skins));
  const entitlementCountKnown = Array.isArray(declaration?.entitlements);
  const entitlementNames = new Map((version?.presentation?.entitlements ?? []).map((entry) => [entry.id, entry.name]));
  const entitlements = (declaration?.entitlements ?? []).map((entry) => {
    const disclosure = quote?.expiryDisclosures?.find((item) => item.entitlementId === entry.entitlementId);
    return {
      name: entitlementNames.get(entry.entitlementId) ?? "权益",
      term: !disclosure ? "期限未提供" : disclosure.expiresAt === null ? "长期权益" : `到期 ${displayTime(disclosure.expiresAt) ?? "时间未确认"}`,
    };
  });
  const editHref = `/publish?accountId=${encodeURIComponent(account.id)}&edit=1`;
  const editLabel = !version ? "填写账号资料" : "继续完善资料";
  const accountClosed = account.lifecycle === "DELISTED" || account.lifecycle === "ARCHIVED";
  const delistOrderBlocked = blockers.includes("OCCUPANCY_UNKNOWN") || detail.occupancyKind === "RENTED" || detail.occupancyKind === "OCCUPIED" || (blockers.includes("OCCUPIED") && detail.occupancyKind !== "PENDING_PAYMENT");
  const galleryKey = galleryMedia.map(item => item.assetId).join("|");
  const [imageState, setImageState] = useState<{ accountId: string; key: string; status: "loading" | "ready" | "unknown"; urls: string[] }>({ accountId: account.id, key: galleryKey, status: "loading", urls: [] });
  const images = imageState.accountId === account.id && imageState.key === galleryKey ? imageState : { status: "loading" as const, urls: [] };
  const publicImages = images.urls;
  const [activeImgIndex, setActiveImgIndex] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [delistOpen, setDelistOpen] = useState(false);
  const [confirmAction, setConfirmAction] = useState<"withdraw" | null>(null);
  useEffect(() => { setDelistOpen(false); }, [account.id]);

  useEffect(() => {
    const controller = new AbortController();
    setImageState({ accountId: account.id, key: galleryKey, status: galleryMedia.length ? "ready" : "loading", urls: galleryMedia.map(item => mediaAccessUrl(item.assetId)) });
    setActiveImgIndex(0);
    setLightboxOpen(false);
    setConfirmAction(null);
    void supplyApi.listing(account.id, controller.signal).then(listing => {
      if (listing.id !== account.id) throw new Error("Listing identity mismatch");
      const urls = toListingDetail(listing).media.map(item => item.url);
      if (!controller.signal.aborted && (urls.length || !galleryMedia.length)) setImageState({ accountId: account.id, key: galleryKey, status: "ready", urls });
    }).catch(() => { if (!controller.signal.aborted && !galleryMedia.length) setImageState({ accountId: account.id, key: galleryKey, status: "unknown", urls: [] }); });
    return () => controller.abort();
  // The fallback contains only this account's display bindings.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [account.id, galleryKey]);


  return <div className="supply-account-detail account-module-card">
    {/* 1. 顶部 Hero 控制条：单一行精简有质感 */}
    <div className="supply-detail-hero">
      <div className="supply-detail-hero-copy">
        <div className="supply-detail-hero-title-row">
          {gameName ? <span className="mra-game-tag">{gameName}</span> : null}
          <h1 className="supply-detail-title">{displayTitle}</h1>
          {account.display_no ? <span className="mra-meta-pill mra-no-pill"><span>账号 {account.display_no}</span><AccountCopyInline text={account.display_no} /></span> : <span className="mra-meta-pill">编号待分配</span>}
        </div>
        <div className="supply-detail-status">
          <span className="order-status" data-state={historicalReadOnly || accountClosed ? "unknown" : REVIEW_TONE[version?.reviewState ?? ""] ?? "unknown"}>{historicalReadOnly ? "历史记录" : account.lifecycle === "DELISTED" ? "已下架" : account.lifecycle === "ARCHIVED" ? "已结束出租" : version ? stateLabel(version.reviewState) : "尚未提交上架资料"}</span>
          <span className="order-status" data-state={AVAILABILITY_TONE[availability.tone]}>{availability.label}</span>
          {publishedAt ? <span className="supply-detail-pub-time">发布于 {publishedAt}</span> : null}
          <button type="button" className="button quiet button--sm" disabled={!identityReady || busy !== ""} onClick={onRefresh}><RefreshCw size={13} aria-hidden="true" />刷新状态</button>
        </div>
      </div>
      <div className="supply-detail-actions">
        {historicalReadOnly || accountClosed ? <div className="space-y-2"><p className="supply-detail-actions-hint">此账号仅保留记录；如需出租，请重新填写上架资料。</p><Link href="/publish" className="button primary">重新填写上架资料</Link></div> : <>
          {version?.reviewState === "SUBMITTED" ? (
            <button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={() => setConfirmAction("withdraw")}><Undo2 size={16} aria-hidden="true" />{busy === "withdraw" ? "撤回中…" : "撤回审核"}</button>
          ) : !version || ["DRAFT", "WITHDRAWN", "REJECTED"].includes(version.reviewState) ? (
            <Link href={editHref} className="button primary"><Pencil size={15} aria-hidden="true" />{editLabel}</Link>
          ) : publication && account.lifecycle === "ACTIVE" ? <div className="space-y-2"><button type="button" className="button secondary" disabled={!identityReady || busy !== "" || delistOrderBlocked} onClick={() => setDelistOpen(true)}>下架账号</button>{delistOrderBlocked ? <p className="supply-detail-actions-hint">订单已付款、租期中或状态待核，请先处理订单后再下架。</p> : null}</div> : null}
        </>}
      </div>
    </div>

    <ConfirmAlertDialog open={delistOpen} onOpenChange={setDelistOpen} title="确认下架账号？"
      description="下架后不能恢复此账号的出租资料；如需再次出租，请重新填写上架资料。"
      consequences={<p>未发起支付的待付款订单会随下架取消；如果已发起支付或付款状态待核，请先联系客服处理。已付款或租期中的订单需先处理。保证金退款进度可在信用与保证金中查看。</p>}
      confirmLabel="确认下架" busy={busy === "delist"} confirmDisabled={!identityReady}
      onConfirm={() => { void onAction("delist").finally(() => setDelistOpen(false)); }} />

    {/* 冲突/阻塞/退回原因提示 */}
    {latest || blockers.length || reasons.length ? <div className="supply-blockers-group" id="blockers" tabIndex={-1} ref={blockersRef}>
      {latest ? <div className="supply-conflict"><strong>资料状态已变化</strong><p>当前状态：{latest.version ? stateLabel(latest.version.reviewState) : "未创建草稿"}。</p><div className="supply-inline-actions"><button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={onRefresh}>重新读取</button><button type="button" className="button secondary" disabled={!identityReady || busy !== ""} onClick={onAdopt}>采用最新状态</button></div></div> : null}
      {blockers.length ? (
        <div className="supply-blockers supply-blockers--compact" role="alert">
          <div className="supply-blockers-lead">
            <AlertCircle size={15} aria-hidden="true" />
            <strong>当前限制</strong>
            <span className="supply-blockers-count">{blockers.length}项</span>
          </div>
          <div className="supply-blockers-chips">
            {blockers.map((code) => (
              <span key={code} className="supply-blocker-chip">
                {blockerText(code)}
                {code === "STAFF_RESTRICTED" && account.restriction_reason ? (
                  <span className="supply-blocker-reason">{account.restriction_reason}</span>
                ) : null}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      {reasons.length ? <div className="supply-decisions"><h3>退回原因</h3>{reasons.map((decision) => <p key={decision.id}>{decision.reason}</p>)}</div> : null}
    </div> : null}

    {/* 2. 控制台双列布局：左栏 64% 核心资产与画廊，右栏 36% 收益经营与操作履约 */}
    <div className="supply-console-grid">
      {/* ===== 左主栏 ===== */}
      <div className="supply-console-main">
        {/* 实机截图画廊 */}
        <section className="supply-block account-module-card supply-gallery-card">
          <div className="account-module-card-header">
            <div className="supply-section-title-wrap">
              <Images size={17} className="supply-section-icon" aria-hidden="true" />
              <h2 className="supply-section-title">账号展示图</h2>
            </div>
            <span className="supply-section-note">{publicImages.length ? `共 ${publicImages.length} 张展示图 · 点击放大` : images.status === "loading" ? "正在读取" : images.status === "unknown" ? "展示图暂未确认" : "暂无展示图"}</span>
          </div>
          {publicImages.length ? (
            <div className="supply-gallery-body">
              <button type="button" className="supply-gallery-main" onClick={() => setLightboxOpen(true)} aria-label="全屏查看账号展示图" title="点击全屏查看大图">
                <LegacyAccountImage src={publicImages[activeImgIndex] ?? publicImages[0] ?? null} alt="游戏公开截图" className="supply-gallery-hero-img" />
                <span className="supply-gallery-zoom-pill"><Sparkles size={13} aria-hidden="true" />点击放大预览</span>
              </button>
              {publicImages.length > 1 ? (
                <div className="supply-gallery-thumbs-rail" role="tablist" aria-label="截图缩略图滑轨">
                  {publicImages.map((img, idx) => (
                    <button
                      type="button"
                      key={idx}
                      className={`supply-gallery-thumb-btn${idx === activeImgIndex ? " is-active" : ""}`}
                      onClick={() => setActiveImgIndex(idx)}
                      aria-label={`查看第 ${idx + 1} 张截图`}
                    >
                      <LegacyAccountImage src={img} alt="" />
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="supply-gallery-empty-art-wrap">
              <AccountMediaPlaceholder state="UNAVAILABLE" className="supply-gallery-placeholder-art" />
              <span className="supply-gallery-placeholder-note">
                {images.status === "loading" ? "正在读取展示图…" : images.status === "unknown" ? "展示图暂未确认" : "暂无公开展示图"}
              </span>
            </div>
          )}
        </section>

        {/* 核心战力与参数矩阵 */}
        {historical ? <section className="supply-block account-module-card supply-specs-card">
          <div className="account-module-card-header">
            <div className="supply-section-title-wrap">
              <SlidersHorizontal size={17} className="supply-section-icon" aria-hidden="true" />
              <h2 className="supply-section-title">历史属性与资源</h2>
            </div>
            <div className="supply-specs-header-meta">
              <span className="supply-section-note">{historicalDisplay ? `更新于 ${displayTime(historicalDisplay.sourceUpdatedAt) ?? "时间待核"}` : "历史记录"}</span>
              <span className="supply-hint-capsule" title="部分属性未提供或尚待核实。历史资料，请以当前上架信息和状态为准。">
                <Info size={13} aria-hidden="true" />
                <span>历史资料说明</span>
                <span className="sr-only">
                  {historicalDisplay && Object.values(historicalDisplay.attributes).some(value => value === null) ? "部分属性未提供或尚待核实。" : ""}
                  历史资料，请以当前上架信息和状态为准。
                </span>
              </span>
            </div>
          </div>
          {historicalDisplay ? renderUnifiedSpecsGrid(historicalConditions, historicalDisplay.attributes, true) : <p role="status">部分账号资料暂未确认。</p>}
        </section> : (!historical && conditions.length ? <section className="supply-block account-module-card supply-specs-card">
          <div className="account-module-card-header">
            <div className="supply-section-title-wrap">
              <SlidersHorizontal size={17} className="supply-section-icon" aria-hidden="true" />
              <h2 className="supply-section-title">账号配置</h2>
            </div>
          </div>
          {renderUnifiedSpecsGrid(conditions, declaration?.attributes as Record<string, unknown> | undefined, false)}
        </section> : null)}

        {/* 在架物资清单 */}
        {historical && historicalDisplay ? (
          <section className="supply-block account-module-card supply-resources-card">
            <div className="account-module-card-header">
              <div className="supply-section-title-wrap">
                <Package size={17} className="supply-section-icon" aria-hidden="true" />
                <h2 className="supply-section-title">历史账号资源</h2>
              </div>
              <span className="supply-section-note">按历史资料展示</span>
            </div>
            {historicalDisplay.resources.length ? (
              <div className="supply-resources-chips">
                {historicalDisplay.resources.map(item => {
                  const isHaff = item.code === "haff_base" || item.name?.includes("哈夫币");
                  return (
                    <div key={item.code} className={`supply-resource-chip${isHaff ? " is-haff" : ""}`}>
                      <span className="supply-resource-name">{item.name}：</span>
                      <strong className="supply-resource-qty">{historicalQuantityText(item.quantity, item.unit)}</strong>
                      {isHaff && historical.historicalQuote?.haffRentYuan ? (
                        <span className="supply-resource-chip-price">租金 ¥{historical.historicalQuote.haffRentYuan}</span>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="supply-block-empty">本账号暂无在架物资申报。</p>
            )}
          </section>
        ) : (!historical && resources.length ? <section className="supply-block account-module-card supply-resources-card">
          <div className="account-module-card-header">
            <div className="supply-section-title-wrap">
              <Package size={17} className="supply-section-icon" aria-hidden="true" />
              <h2 className="supply-section-title">账号资源</h2>
            </div>
          </div>
          <div className="supply-resources-chips">
            {resources.map((row, index) => {
              const isHaff = row.code === "haff_base" || row.rawUnit === "HAFF_BASE" || row.name.includes("哈夫币");
              const qtyText = (row.rawUnit === "HAFF_BASE" || row.code === "haff_base") && row.quantity && /^\d+$/.test(row.quantity)
                ? `${haffMillionsLabel(row.quantity)} M 哈夫币`
                : `${row.quantity ?? "未返回"}${row.unit ? ` ${row.unit}` : ""}`;
              return (
                <div key={`${row.name}-${index}`} className={`supply-resource-chip${isHaff ? " is-haff" : ""}`}>
                  <span className="supply-resource-name">{row.name}：</span>
                  <strong className="supply-resource-qty">{qtyText}</strong>
                </div>
              );
            })}
          </div>
          <details className="supply-inline-fold"><summary>查看报价明细</summary><table className="supply-stock-table"><thead><tr><th scope="col">物资</th><th scope="col">数量</th><th scope="col">号主侧单价</th><th scope="col">号主侧费用</th></tr></thead><tbody>{resources.map((row, index) => <tr key={`${row.name}-${index}`}><th scope="row">{row.name}{row.unit ? <small>{row.unit}</small> : null}</th><td>{row.quantity ?? "未返回"}</td><td>{row.ownerUnit ?? "未返回"}</td><td>{row.ownerAmount ?? "未返回"}</td></tr>)}</tbody>{quote?.ownerTotal ? <tfoot><tr><th scope="row" colSpan={3}>发布报价合计</th><td>{moneyText(quote.ownerTotal)}</td></tr></tfoot> : null}</table></details>
        </section> : null)}

        {/* 补充折叠区域：皮肤与权益、审核资料、修改记录 */}
        <div className="supply-console-folds">
          <details className="supply-block supply-block--fold" data-skin-summary-source={legacySkinVersion ? legacySkinAdmitted ? "LEGACY_ADMITTED" : "LEGACY_UNKNOWN" : draftSkinSummary?.source}>
            <summary><strong>{draftSkinSummary ? "草稿已选皮肤" : "皮肤与权益"}</strong><span>{!skinCountKnown ? "皮肤数量待确认" : legacySkinVersion ? `${legacyHolding!.admittedCount} 项皮肤` : draftSkinSummary ? `${skins.length + withheldSkins} 项已选皮肤` : `${skins.length} 项皮肤`}{entitlementCountKnown ? ` · ${entitlements.length} 项权益` : ""}</span><ChevronDown size={16} aria-hidden="true" /></summary>
            <div className="supply-fold-body">
              {legacySkinVersion ? (legacySkinAdmitted ? null : <p className="supply-block-empty">皮肤资料暂未确认。</p>) : null}
              {draftSkinSummary ? <p className="supply-block-empty">这是草稿中选择的皮肤，尚未公开上架。</p> : unconfirmedNativeDraft ? <p className="supply-block-empty">草稿的皮肤资料暂不可用，请进入编辑查看。</p> : null}
              {withheldSkins > 0 ? <p className="supply-block-empty">{legacySkinVersion ? `另有 ${withheldSkins} 项皮肤暂时无法显示。` : `另有 ${withheldSkins} 项已选皮肤暂时无法显示，请进入编辑查看。`}</p> : null}
              {skins.length ? <ul className="supply-skin-list">{skins.map((skin, index) => <li key={`${skin.id}-${index}`} data-skin-id={skin.id}>
                <SkinMediaPreview skin={skin} triggerClassName="skin-media-preview-trigger supply-skin-preview" mediaClassName="supply-skin-thumb" fallbackClassName="supply-skin-thumb-empty" iconSize={22} />
                <span>{skinCardTitle(skin)}</span>
                {skinTypeLabel(skin.ownerKind) ? <small>{skinTypeLabel(skin.ownerKind)}</small> : null}
                <SkinMetadata skin={skin} />
              </li>)}</ul> : null}
              {entitlements.length ? <ul className="supply-entitlement-list">{entitlements.map((entry, index) => <li key={`${entry.name}-${index}`}><strong>{entry.name}</strong><span>{entry.term}</span></li>)}</ul> : null}
              {!skins.length && !entitlements.length && !withheldSkins && skinCountKnown ? <p className="supply-block-empty">{legacySkinVersion ? "账号记录中没有皮肤。" : draftSkinSummary ? "草稿尚未选择皮肤。" : entitlementCountKnown ? "还没有申报皮肤或权益。" : "还没有申报皮肤。"}</p> : null}
            </div>
          </details>

          {penaltyMedia.length ? <details className="supply-block supply-block--fold">
            <summary><strong>处罚公示资料</strong><span>{penaltyMedia.length} 张</span><ChevronDown size={16} aria-hidden="true" /></summary>
            <div className="supply-fold-body"><ul className="supply-media-thumbs">{penaltyMedia.map((item) => <li key={item.assetId}><AccountMedia assetId={item.assetId} alt="" className="supply-media-thumb" /></li>)}</ul></div>
          </details> : null}

          {evidenceMedia.length ? <details className="supply-block supply-block--fold">
          <summary><strong>审核资料</strong><span>{evidenceMedia.length} 张 · 仅本人及审核人员可见</span><ChevronDown size={16} aria-hidden="true" /></summary>
            <div className="supply-fold-body"><ul className="supply-media-thumbs">{evidenceMedia.map((item) => <li key={item.assetId}><AccountMedia assetId={item.assetId} alt="" className="supply-media-thumb" /></li>)}</ul></div>
          </details> : null}

        </div>
      </div>

      {/* ===== 右侧栏（38%）：经营驾驶舱与履约操作 ===== */}
      <aside className="supply-console-sidebar">
        {/* 出租经营收益卡片（大字号金墨高光） */}
        <section className="supply-block account-module-card supply-side-revenue-card">
          <div className="account-module-card-header">
            <div className="supply-section-title-wrap">
              <ReceiptText size={17} className="supply-section-icon" aria-hidden="true" />
              <h2 className="supply-section-title">出租设置与收益</h2>
            </div>
            <span className="supply-mode-badge">
              {({ ordinary: "普通租赁", custom: "定制租赁", fast: "极速租赁" } as Record<string, string>)[quote?.rentalMode ?? historicalDisplay?.rentalMode ?? ""] ?? "出租方式待确认"}
            </span>
          </div>

          {quote || !historical ? <>
            <div className="supply-revenue-hero supply-revenue-hero--single">
              <div className="supply-revenue-stat"><span className="supply-revenue-label">上架报价</span><strong className="supply-revenue-num">{moneyText(quote?.ownerTotal)}</strong></div>
            </div>
            <div className="supply-revenue-sub-grid">
              <div className="supply-revenue-sub-cell">
                <span className="supply-rev-sub-k">约定租期</span>
                <strong className="supply-rev-sub-v">{quote?.termSeconds ? termLabel(quote.termSeconds) : "未提供"}</strong>
              </div>
              <div className="supply-revenue-sub-cell">
                <span className="supply-rev-sub-k">哈夫币出租比例</span>
                <strong className="supply-rev-sub-v">{quote?.ownerHaffRatio ? `1 元 = ${quote.ownerHaffRatio} 万哈夫币` : "待确认"}</strong>
              </div>
            </div>
          </> : null}
          {historical ? <><div className="supply-revenue-hero">
            <div className="supply-revenue-stat">
              <span className="supply-revenue-label">哈夫币租金记录</span>
              <div className="supply-revenue-num-wrap">
                <span className="supply-revenue-symbol">¥</span>
                <strong className="supply-revenue-num">{historical.historicalQuote.haffRentYuan}</strong>
              </div>
            </div>
            <div className="supply-revenue-stat">
              <span className="supply-revenue-label">押金记录</span>
              <div className="supply-revenue-num-wrap">
                <span className="supply-revenue-symbol">¥</span>
                <strong className="supply-revenue-num">{historical.historicalQuote.depositYuan}</strong>
              </div>
            </div>
          </div>

          <div className="supply-revenue-sub-grid">
            <div className="supply-revenue-sub-cell">
              <span className="supply-rev-sub-k">约定租期</span>
              <strong className="supply-rev-sub-v">{historical.historicalQuote.termDays} 天</strong>
            </div>
            <div className="supply-revenue-sub-cell">
              <span className="supply-rev-sub-k">物资金额</span>
              <strong className="supply-rev-sub-v">{historical.historicalQuote.goodsYuan} 元</strong>
            </div>
            <div className="supply-revenue-sub-cell">
              <span className="supply-rev-sub-k">迁入时账号比例</span>
              <strong className="supply-rev-sub-v">{historicalRatio ? `1 元 = ${historicalRatio} 万哈夫币` : "未记录"}</strong>
            </div>
            <div className="supply-revenue-sub-cell">
              <span className="supply-rev-sub-k">迁入时包赔选择</span>
              <strong className="supply-rev-sub-v">{historicalDisplay?.sourceAccountFullPayoutSelected === true ? "已选择" : historicalDisplay?.sourceAccountFullPayoutSelected === false ? "未选择" : "未记录"}</strong>
            </div>
          </div></> : null}

          <div className="supply-revenue-foot">
            <Link href={`/account?view=leased&accountId=${encodeURIComponent(account.id)}`} className="supply-side-order-btn">
              <span>查看该账号的出租订单</span>
              <ChevronRight size={15} aria-hidden="true" />
            </Link>
          </div>
        </section>

        {/* 履约责任与保证金卡片 */}
        <section className="supply-block account-module-card supply-side-duty-card">
          <div className="account-module-card-header">
            <div className="supply-section-title-wrap">
              <ShieldCheck size={17} className="supply-section-icon" aria-hidden="true" />
              <h2 className="supply-section-title">履约责任与保证金</h2>
            </div>
          </div>
          <div className="supply-duty-content">
            <div className="supply-duty-row">
              <span className="supply-duty-k">上架时保证金要求</span>
              <strong className="supply-duty-v">{quote?.publisherBailRequirement ? `${quote.publisherBailRequirement.amount} 元` : "待确认"}</strong>
            </div>
            <div className="supply-duty-note">
              <p>查看本账号当前应缴保证金状态与信用分值。</p>
            </div>
            <div className="supply-duty-link-wrap">
              <Link href={`/account?view=credit&accountId=${encodeURIComponent(account.id)}`} className="supply-duty-nav-link" scroll={false}>
                <span>进入信用与保证金中心</span>
                <ChevronRight size={14} aria-hidden="true" />
              </Link>
            </div>
          </div>
        </section>
      </aside>
    </div>

    <ConfirmAlertDialog
      open={confirmAction !== null}
      onOpenChange={(open) => { if (!open && busy === "") setConfirmAction(null); }}
      title="确认撤回当前审核？"
      description="撤回后账号将退回草稿状态，等待你修改资料并重新提交审核。"
      consequences={["当前排队审核将被取消。", "你可以继续编辑资料后再次提交上架。"]}
      cancelLabel="继续等待审核"
      confirmLabel="确认撤回审核"
      busy={busy === "withdraw"}
      onConfirm={async () => {
        if (!confirmAction) return;
        const action = confirmAction;
        setConfirmAction(null);
        await onAction(action);
      }}
    />

    {/* 全屏 Lightbox 大图预览 */}
    <Dialog.Root open={lightboxOpen && publicImages.length > 0} onOpenChange={setLightboxOpen}>
      <Dialog.Portal>
        <Dialog.Backdrop className="supply-lightbox-backdrop" />
        <Dialog.Popup
          className="supply-lightbox-overlay"
          aria-label="全屏查看账号展示图"
          onKeyDown={(e) => {
            if (publicImages.length <= 1) return;
            if (e.key === "ArrowLeft") {
              e.preventDefault();
              setActiveImgIndex((i) => Math.max(0, i - 1));
            } else if (e.key === "ArrowRight") {
              e.preventDefault();
              setActiveImgIndex((i) => Math.min(publicImages.length - 1, i + 1));
            }
          }}
        >
          <div className="supply-lightbox-modal">
            <Dialog.Close className="supply-lightbox-close" aria-label="关闭预览">
              <X size={20} aria-hidden="true" />
            </Dialog.Close>
            <LegacyAccountImage src={publicImages[activeImgIndex] ?? publicImages[0] ?? null} alt={`截图 ${activeImgIndex + 1}`} className="supply-lightbox-img" />
            {publicImages.length > 1 ? (
              <div className="supply-lightbox-nav">
                <button type="button" className="supply-lightbox-arrow" disabled={activeImgIndex === 0} onClick={() => setActiveImgIndex((i) => Math.max(0, i - 1))} aria-label="上一张">‹</button>
                <span className="supply-lightbox-counter">{activeImgIndex + 1} / {publicImages.length}</span>
                <button type="button" className="supply-lightbox-arrow" disabled={activeImgIndex === publicImages.length - 1} onClick={() => setActiveImgIndex((i) => Math.min(publicImages.length - 1, i + 1))} aria-label="下一张">›</button>
              </div>
            ) : null}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  </div>;
}
