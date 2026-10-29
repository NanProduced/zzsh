"use client";
import { BusinessUpdateNotices } from "@/components/content/platform-update-notices";
import { ManagedNoticeSections } from "@/components/content/managed-notice";
import { CatalogItemArt } from "@/components/supply/catalog-item-art";
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { Toast } from "@heroui/react/toast";
import {
  ArrowRight,
  Box,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock3,
  Coins,
  Copy,
  Crosshair,
  Dumbbell,
  FileText,
  Gamepad2,
  Gem,
  ImageOff,
  Info,
  Layers,
  LogIn,
  MapPin,
  Package,
  ReceiptText,
  RotateCw,
  Share2,
  Shield,
  ShieldAlert,
  Shirt,
  Sparkles,
  UserRound,
  Waves,
  X,
  Zap,
} from "lucide-react";
import { ServiceShell } from "@/components/layout/service-shell";
import { FavoriteButton, FavoriteNotice } from "@/components/favorites/favorite-button";
import { FavoritesProvider } from "@/components/favorites/favorites-context";
import { accountHref, isHaff, moneyValue, orderedQuoteResources } from "@/components/delta/account-card";
import {
  deriveAccountTitle,
  deriveDetailTitle,
  formatSupplyItem,
  parseRank,
  parseSafeBox,
} from "@/lib/account-title";
export { deriveDetailTitle, formatSupplyItem, parseRank, parseSafeBox } from "@/lib/account-title";
import { accountReturnTarget, readAccountReturn } from "@/lib/account-return";
import { canonicalResourceCode } from "@/lib/listing-filters";
import {
  detailBreadcrumbs,
  resourceQuantityLabel,
  skinTypeLabel,
  toListingDetail,
  type ListingDetailData,
  type ResourceLine,
} from "@/lib/listing-view";
import { supplyApi, SupplyRequestError } from "@/lib/supply-client";
import { RentalConfirmPanel } from "@/components/order/rental-confirm-panel";
import { useUserSession } from "@/components/session/user-session-provider";
import { SkinMediaPreview, SkinMetadata, skinCardTitle } from "@/components/supply/skin-media-thumb";
import "./account-detail.css";

type DetailState =
  | { status: "loading" }
  | { status: "ready"; data: ListingDetailData; gameCode?: string }
  | { status: "unavailable" }
  | { status: "error" };
type BackTarget = { href: string; label: string };

const ITEM_ART_MAP: Record<string, string> = {
  df_billable_level6_helmet: "/art/delta/items/level6-helmet-dich9.png",
  level6_helmet: "/art/delta/items/level6-helmet-dich9.png",
  df_billable_level6_armor: "/art/delta/items/level6-armor-mas2.png",
  level6_armor: "/art/delta/items/level6-armor-mas2.png",
  df_billable_coffee: "/art/delta/items/coffee-beans.png",
  coffee: "/art/delta/items/coffee-beans.png",
  df_billable_awm_bullet: "/art/delta/items/awm-ammo.png",
  awm_round: "/art/delta/items/awm-ammo.png",
  df_billable_barrett_bullet: "/art/delta/items/barrett-ammo.png",
  barrett_round: "/art/delta/items/barrett-ammo.png",
  legacy_barrett_round: "/art/delta/items/barrett-ammo.png",
  df_billable_turtle_backpack_45: "/art/delta/items/turtle-backpack-45.png",
  turtle_backpack_45: "/art/delta/items/turtle-backpack-45.png",
  df_billable_level6_bullet: "/art/delta/items/level6-ammo.png",
  level6_round: "/art/delta/items/level6-ammo.png",
  df_billable_top_insure_card: "/art/delta/items/insurance-experience-card-thumb.png",
  top_insure_card_piece: "/art/delta/items/insurance-experience-card-thumb.png",
  df_billable_top_insure_card_piece: "/art/delta/items/insurance-experience-card-thumb.png",
  legacy_insurance_day: "/art/delta/items/insurance-experience-card-thumb.png",
};

export function ListingDetail({ accountId }: { accountId: string }) {
  return (
    <FavoritesProvider>
      <DetailView accountId={accountId} />
    </FavoritesProvider>
  );
}

function DetailImage({
  src,
  alt,
  className,
  loading = "lazy",
  onLoad,
}: {
  src: string;
  alt: string;
  className?: string;
  loading?: "lazy" | "eager";
  onLoad?: (image: HTMLImageElement) => void;
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (failed) {
    return (
      <span className={`detail-image-fallback${className ? ` ${className}` : ""}`}>
        <ImageOff size={24} />图片暂不可用
      </span>
    );
  }
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading={loading}
      onLoad={(event) => onLoad?.(event.currentTarget)}
      onError={() => setFailed(true)}
    />
  );
}

function DetailGallery({ title, media }: { title: string; media: ListingDetailData["media"] }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const galleryMedia = media.filter((m) => m.category !== "PENALTY");
  const activeList = galleryMedia;

  useEffect(() => setActiveIndex(0), [media]);

  if (activeList.length === 0) {
    return (
      <div className="detail-gallery detail-gallery--empty" role="note">
        <ImageOff size={18} aria-hidden="true" />
        <span>暂无可展示的图片</span>
      </div>
    );
  }

  const index = Math.min(activeIndex, activeList.length - 1);
  const activeMedia = activeList[index]!;
  const select = (next: number) => setActiveIndex(Math.max(0, Math.min(activeList.length - 1, next)));

  return (
    <div
      className="detail-gallery"
      aria-label={`${title}公开展示图`}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const next = Math.max(0, Math.min(activeList.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
        select(next);
        if (!previewOpen && event.target instanceof Element && event.target.closest(".detail-gallery-thumbs")) {
          event.currentTarget.querySelectorAll<HTMLElement>(".detail-gallery-thumb")[next]?.focus();
        }
      }}
    >
      <div className="detail-gallery-stage">
        <Dialog.Root open={previewOpen} onOpenChange={setPreviewOpen}>
          <Dialog.Trigger asChild>
            <button
              type="button"
              className="detail-gallery-main"
              aria-label={`放大查看第 ${index + 1} 张公开展示图`}
            >
              <DetailImage
                src={activeMedia.url}
                alt={`${title}公开展示图，第${index + 1}张`}
                loading="eager"
              />
              <span className="detail-gallery-count" aria-live="polite">
                {index + 1} / {activeList.length}
              </span>
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="modal-overlay" />
            <Dialog.Content className="detail-preview-content" aria-describedby={undefined}>
              <Dialog.Title className="sr-only">{title} 大图预览</Dialog.Title>
              <Dialog.Close className="icon-button detail-preview-close" aria-label="关闭预览">
                <X size={18} aria-hidden="true" />
              </Dialog.Close>
              <DetailImage
                src={activeMedia.url}
                alt={`${title}公开展示图大图，第${index + 1}张`}
                className="detail-preview-image"
                loading="eager"
              />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        {activeList.length > 1 ? (
          <>
            <button
              type="button"
              className="detail-gallery-nav detail-gallery-nav--previous"
              aria-label="上一张公开展示图"
              disabled={index === 0}
              onClick={() => select(index - 1)}
            >
              <ChevronLeft size={20} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="detail-gallery-nav detail-gallery-nav--next"
              aria-label="下一张公开展示图"
              disabled={index === activeList.length - 1}
              onClick={() => select(index + 1)}
            >
              <ChevronRight size={20} aria-hidden="true" />
            </button>
          </>
        ) : null}
      </div>
      <div className="detail-gallery-thumbs" aria-label="选择公开展示图">
        {activeList.map((item, thumbnailIndex) => (
          <button
            key={item.assetId}
            type="button"
            className="detail-gallery-thumb"
            aria-label={`选择第 ${thumbnailIndex + 1} 张公开展示图`}
            aria-pressed={thumbnailIndex === index}
            onClick={() => select(thumbnailIndex)}
          >
            <DetailImage src={item.url} alt="" className="detail-gallery-thumb-image" />
            <span className="detail-gallery-thumb-index">{thumbnailIndex + 1}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

function conditionValue(data: ListingDetailData, key: string): string | null {
  return data.conditionLines.find((line) => line.key === key)?.value ?? null;
}

function regionValue(data: ListingDetailData): string {
  const parts = [conditionValue(data, "region_province"), conditionValue(data, "region_city")].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(" · ") : "未提供";
}

function displayTime(value: string | null | undefined): string | null {
  if (!value || !Number.isFinite(Date.parse(value))) return null;
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  })
    .format(new Date(value))
    .replaceAll("/", "-");
}

export function withheldSkinsNote(count: number | undefined): string | null {
  return typeof count === "number" && Number.isSafeInteger(count) && count > 0
    ? `另有 ${count} 项已申报皮肤当前未公开展示。`
    : null;
}

export function entitlementExpiryLabel(
  item: { expiresAt: string | null; expiryState: "MISSING" | "PERMANENT" | "TIMED" },
  now = Date.now(),
): string {
  if (item.expiryState === "MISSING") return "期限未提供 · 覆盖范围以个人确认时为准";
  if (item.expiryState === "PERMANENT") return "长期权益 · 不保证覆盖全部租期";
  const time = displayTime(item.expiresAt);
  if (!time) return "到期时间未确认 · 覆盖范围以个人确认时为准";
  return `${Date.parse(item.expiresAt!) <= now ? "已到期" : "到期"} ${time} · 不保证覆盖全部租期`;
}

export function formatItemUnitPrice(line: ResourceLine): string {
  const full = unitPriceText(line);
  const match = full.match(/^(¥\d+(?:\.\d+)?)/);
  return match ? match[1]! : full;
}

export function unitPriceText(line: ResourceLine): string {
  if (!line.unitPriceLabel) return "未确认";
  const match = line.unitPriceLabel.match(/^(¥\d+(?:\.\d+)?)\s*\/\s*(\d+)\s+(.+)$/);
  if (!match) return line.unitPriceLabel;
  const amount = match[1]!.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1");
  const grouped = canonicalResourceCode(line.code) === "df_billable_level6_bullet" && match[2] === "60" && match[3] === "发";
  return `${amount} / ${grouped ? "组" : `${match[2] === "1" ? "" : match[2]}${match[3]}`}`;
}

export function inventoryQuantityText(line: ResourceLine): string {
  return line.quantity == null || line.quantity === "" ? "未提供" : resourceQuantityLabel(line);
}

function loginMethodText(data: ListingDetailData): { text: string; hint: string } {
  const raw = conditionValue(data, "login_method_code") || "";
  if (raw.includes("QQ") && (raw.includes("扫码") || raw.includes("scan"))) {
    return { text: "QQ扫码上号", hint: "由客服提供二维码" };
  }
  if (raw.includes("微信") || raw.includes("wx")) {
    return { text: "微信扫码上号", hint: "由客服提供二维码" };
  }
  if (raw.includes("账密") || raw.includes("password")) {
    return { text: "QQ账密上号", hint: "客服协助安全上号" };
  }
  return { text: raw || "未提供", hint: "由客服协助上号" };
}

function ReadyDetail({ data }: { data: ListingDetailData }) {
  const session = useUserSession();
  const identityKey = session.status === "authenticated" && session.userId ? session.userId : "guest";
  const number = data.displayNo?.trim() || null;
  const copyTarget = JSON.stringify([data.id, number]);
  const copyTargetRef = useRef<string | null>(copyTarget);
  const copySequence = useRef(0);
  const pendingCopies = useRef(new Map<"number" | "link", number>());
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{ target: string; action: "number" | "link"; ok: boolean } | null>(null);
  const [copyQueue] = useState(() => new Toast.Queue({ maxVisibleToasts: 1, wrapUpdate: (update) => update() }));
  const [penaltyModalOpen, setPenaltyModalOpen] = useState(false);
  const penaltyTriggerRef = useRef<HTMLButtonElement>(null);
  const [noteExpanded, setNoteExpanded] = useState(false);
  const noteRef = useRef<HTMLParagraphElement>(null);
  const [canExpandNote, setCanExpandNote] = useState(false);

  useEffect(() => {
    const el = noteRef.current;
    if (!el) return;
    const measure = () => {
      setCanExpandNote(el.scrollHeight > el.clientHeight + 2);
    };
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [data.description]);

  useEffect(() => {
    copyTargetRef.current = copyTarget;
    setCopyFeedback(null);
    return () => {
      copyTargetRef.current = null;
      copySequence.current += 1;
      pendingCopies.current.clear();
      if (copyTimer.current !== null) clearTimeout(copyTimer.current);
      copyQueue.clear();
    };
  }, [copyTarget, copyQueue]);

  const copy = async (action: "number" | "link", text: string | null) => {
    if (!text || pendingCopies.current.has(action)) return;
    const request = ++copySequence.current;
    pendingCopies.current.set(action, request);
    if (copyTimer.current !== null) clearTimeout(copyTimer.current);
    copyQueue.clear();
    setCopyFeedback(null);
    let ok = false;
    try {
      await navigator.clipboard.writeText(text);
      ok = true;
    } catch {
      // Clipboard permission can be unavailable; keep the manual copy path visible.
    } finally {
      if (pendingCopies.current.get(action) === request) pendingCopies.current.delete(action);
    }
    if (request !== copySequence.current || copyTargetRef.current !== copyTarget) return;
    setCopyFeedback({ target: copyTarget, action, ok });
    copyQueue.add({
      title: ok
        ? action === "number" ? "账号编号已复制" : "链接已复制，可粘贴分享"
        : action === "number" ? "复制未成功，请选中账号编号手动复制" : "复制未成功，请复制浏览器地址栏链接",
      variant: ok ? "success" : "warning",
      indicator: ok ? <Check size={18} aria-hidden="true" /> : <Info size={18} aria-hidden="true" />,
    }, { timeout: 0 });
    copyTimer.current = setTimeout(() => {
      copyQueue.clear();
      setCopyFeedback(null);
      copyTimer.current = null;
    }, 2000);
  };
  const copiedAction = copyFeedback?.target === copyTarget && copyFeedback.ok ? copyFeedback.action : null;

  const value = (key: string) => {
    const raw = conditionValue(data, key);
    return !raw ? "未提供" : raw.startsWith("未确认（代码") ? "未确认" : raw;
  };

  const title = deriveDetailTitle(data);
  const availability = data.historicalReadOnly
    ? "资料暂不可租"
    : data.availabilityLabel ?? (data.canCreateOrder === false ? "暂不可租" : null);

  const fast = !data.historicalReadOnly && data.canCreateOrder !== false && data.rentalMode === "fast";
  const displayedAt = data.historicalReadOnly ? data.sourceUpdatedAt : data.publishedAt;
  const published = displayTime(displayedAt);

  const haff = data.resourceLines.find(isHaff);
  const resources = orderedQuoteResources(data);
  const penalties = data.media.filter((item) => item.category === "PENALTY");
  const faceValue = data.faceIsSelf === true ? "号主声明本人脸" : data.faceIsSelf === false ? "号主声明非本人脸" : "未提供";
  const penaltyDeclaredText = data.banRecord === true ? (penalties.length > 0 ? `号主声明有封禁记录 · 公示图 ${penalties.length} 张` : "号主声明有封禁记录 · 公示图未提供") : data.banRecord === false ? "号主声明无封禁记录" : "未提供";
  const hasGallery = data.media.some((item) => item.category !== "PENALTY");

  const rankInfo = parseRank(value("grading_code"));
  const loginInfo = loginMethodText(data);

  const safeBox = parseSafeBox(value("safe_box_code"));
  const vitValue = value("vit_level");
  const bearValue = value("bear_level");
  const levelValue = value("character_level");
  const secretKdValue = value("secret_kd");
  const diveValue = value("dive_level");
  const regionText = regionValue(data);

  const skinGroups = new Map<string, ListingDetailData["skinTags"]>();
  for (const tag of data.skinTags) {
    const category = skinTypeLabel(tag.ownerKind) ?? "类型待核";
    skinGroups.set(category, [...(skinGroups.get(category) ?? []), tag]);
  }

  return (
    <article className="listing-detail account-detail">
      <BusinessUpdateNotices surface="rental" gameId={data.gameId} />
      {typeof document !== "undefined" ? createPortal(
        <Toast.Provider queue={copyQueue} placement="top" width="min(360px, calc(100% - 32px))" className="account-copy-feedback" aria-label="复制反馈">
          {({ toast }) => (
            <Toast toast={toast} variant={toast.content.variant}>
              <Toast.Indicator>{toast.content.indicator}</Toast.Indicator>
              <Toast.Content><Toast.Title>{toast.content.title}</Toast.Title></Toast.Content>
            </Toast>
          )}
        </Toast.Provider>, document.body,
      ) : null}
      {/* 1. Unified Header */}
      <header className="account-detail-top">
        <section className="account-detail-info" aria-label="账号摘要">
          <div className="account-heading-row">
            <h1 className="account-detail-title">
              <span className="account-title-primary">{title.primary}</span>
              {title.secondary ? <span className="account-title-secondary">{title.secondary}</span> : null}
            </h1>
            {availability ? <span className="account-detail-status">{availability}</span> : null}
          </div>
          {fast ? (
            <span className="account-detail-deal">
              <Zap size={14} aria-hidden="true" />特惠 · 极速出租
            </span>
          ) : null}

          <div className="account-identity">
            <div className="account-number-row">
              <span>账号编号</span>
              <strong>{number ?? "待分配"}</strong>
              <button
                type="button"
                className="account-copy"
                disabled={!number}
                onClick={() => void copy("number", number)}
                aria-label="复制账号编号"
              >
                {copiedAction === "number" ? <Check size={16} aria-hidden="true" /> : <Copy size={16} aria-hidden="true" />}
                <span>复制</span>
              </button>
            </div>
            <div className="account-published">
              <Clock3 size={15} aria-hidden="true" />
              {published ? (
                <time dateTime={displayedAt!}>
                  {data.historicalReadOnly ? "来源更新时间" : "发布时间"} {published}
                </time>
              ) : (
                <span>{data.historicalReadOnly ? "来源时间未提供" : "发布时间未提供"}</span>
              )}
            </div>
          </div>

          <div className="account-identity-actions">
            <FavoriteButton accountId={data.id} title={title.primary} variant="inline" />
            <button type="button" className="button secondary account-share" onClick={() => void copy("link", new URL(accountHref(data.id), window.location.origin).href)}>
              {copiedAction === "link" ? <Check size={16} aria-hidden="true" /> : <Share2 size={16} aria-hidden="true" />}
              分享
            </button>
          </div>
        </section>
      </header>

      {/* 2-Column Main Layout: Left 2/3, Right 1/3 */}
      <div className="account-detail-layout">
        <div className="account-detail-left">
          {/* Section 1: Gallery + Basic Info (Side-by-Side) */}
          <section className="account-overview account-hero-section" aria-label="图片与基本信息">
            <div className={`account-detail-gallery${hasGallery ? "" : " account-detail-gallery--empty"}`}>
              {hasGallery ? <h2 className="sr-only">账号图片</h2> : null}
              <DetailGallery title={title.primary} media={data.media} />
              {hasGallery ? <p className="account-media-caption">号主提供 · 点击图片查看大图</p> : null}
            </div>

            <div className="account-hero-attributes">
              {/* Group 1: 核心配置 */}
              <div className="account-attr-group">
                <h3 className="account-attr-group-title">
                  <Box size={16} aria-hidden="true" />
                  <span>核心配置</span>
                </h3>
                <dl className="account-capabilities account-attr-dl">
                  <div className="account-attr-item">
                    <dt className="account-attr-label">安全箱</dt>
                    <dd className="account-attr-value account-safebox-value">
                      {safeBox.size ? (
                        <>
                          <span className="account-safebox-size">{safeBox.size}</span>
                          {safeBox.name ? <span className="account-safebox-name">{safeBox.name}</span> : null}
                        </>
                      ) : (
                        <span className={safeBox.full === "未提供" ? "account-value-unknown" : ""}>{safeBox.full}</span>
                      )}
                    </dd>
                  </div>
                  <div className="account-attr-item">
                    <dt className="account-attr-label">体力等级</dt>
                    <dd className={`account-attr-value${vitValue === "未提供" ? " account-value-unknown" : ""}`}>
                      {vitValue}
                    </dd>
                  </div>
                  <div className="account-attr-item">
                    <dt className="account-attr-label">负重等级</dt>
                    <dd className={`account-attr-value${bearValue === "未提供" ? " account-value-unknown" : ""}`}>
                      {bearValue}
                    </dd>
                  </div>
                  <div className="account-attr-item">
                    <dt className="account-attr-label">潜水等级</dt>
                    <dd className={`account-attr-value${diveValue === "未提供" ? " account-value-unknown" : ""}`}>
                      {diveValue}
                    </dd>
                  </div>
                </dl>
              </div>

              {/* Group 2: 游戏资料 */}
              <div className="account-attr-group">
                <h3 className="account-attr-group-title">
                  <Gamepad2 size={16} aria-hidden="true" />
                  <span>游戏资料</span>
                </h3>
                <dl className="account-facts account-attr-dl">
                  <div className="account-attr-item account-attr-item--full">
                    <dt className="account-attr-label">游戏段位</dt>
                    <dd className="account-attr-value account-rank-dd">
                      {rankInfo.iconSrc ? (
                        <img src={rankInfo.iconSrc} alt="" className="account-rank-icon" />
                      ) : null}
                      <span className={rankInfo.text === "未提供" ? "account-value-unknown" : ""}>{rankInfo.text}</span>
                    </dd>
                  </div>
                  <div className="account-attr-item">
                    <dt className="account-attr-label">角色等级</dt>
                    <dd className={`account-attr-value${levelValue === "未提供" ? " account-value-unknown" : ""}`}>
                      {levelValue}
                    </dd>
                  </div>
                  <div className="account-attr-item">
                    <dt className="account-attr-label">绝密KD</dt>
                    <dd className={`account-attr-value${secretKdValue === "未提供" ? " account-value-unknown" : ""}`}>
                      {secretKdValue}
                    </dd>
                  </div>
                </dl>
              </div>

            </div>
              {/* Group 3: 账号资料 */}
              <div className="account-attr-group account-hero-declarations">
                <h3 className="account-attr-group-title">
                  <Shield size={16} aria-hidden="true" />
                  <span>账号资料</span>
                </h3>
                <dl className="account-facts account-attr-dl">
                  <div className="account-attr-item"><dt className="account-attr-label">下赛季通行证</dt><dd className={`account-attr-value${value("next_season_pass") === "未提供" ? " account-value-unknown" : ""}`}>{value("next_season_pass")}</dd></div>
                  <div className="account-attr-item"><dt className="account-attr-label">解锁德穆兰</dt><dd className={`account-attr-value${value("demulan_unlocked") === "未提供" ? " account-value-unknown" : ""}`}>{value("demulan_unlocked")}</dd></div>
                  <div className="account-attr-item">
                    <dt className="account-attr-label">游戏地区</dt>
                    <dd className={`account-attr-value${regionText === "未提供" ? " account-value-unknown" : ""}`}>
                      {regionText}
                    </dd>
                  </div>
                  <div className="account-attr-item">
                    <dt className="account-attr-label">人脸归属</dt>
                    <dd className={`account-attr-value${faceValue === "未提供" ? " account-value-unknown" : ""}`}>
                      {faceValue}
                    </dd>
                  </div>
                  <div className="account-attr-item">
                    <dt className="account-attr-label">处罚记录</dt>
                    <dd className="account-attr-value">
                      <span className={data.banRecord == null ? "account-value-unknown" : "account-penalty-declared"}>{penaltyDeclaredText}</span>
                      {penalties.length > 0 ? (
                        <button
                          ref={penaltyTriggerRef}
                          type="button"
                          className="account-penalty-btn"
                          onClick={() => setPenaltyModalOpen(true)}
                          aria-label="查看处罚记录公示图"
                        >
                          <span className="account-penalty-tag">有公示图</span>
                          <span className="account-penalty-arrow">查看截图 &gt;</span>
                        </button>
                      ) : null}
                    </dd>
                  </div>
                </dl>
              </div>
          </section>

          {/* Mobile quick price summary: appears directly after hero attributes */}
          <div className="account-mobile-quote-strip" role="region" aria-label="费用概览">
            <div className="account-mobile-quote-inner">
              <div className="account-mobile-quote-amount">
                <span className="account-mobile-quote-label">
                  {data.historicalReadOnly ? "来源记录费用" : "当前参考费用"}
                </span>
                <strong>{data.payableTotalLabel ?? data.resourceTotalLabel}</strong>
              </div>
              <div className="account-mobile-quote-status">
                {availability ? <span className="account-detail-status">{availability}</span> : null}
                <a href="#account-quote-anchor" className="account-mobile-quote-jump">
                  查看报价明细 &gt;
                </a>
              </div>
            </div>
          </div>

          {/* Golden Process Bar */}
          <section className="account-process-bar" role="region" aria-label="租用流程">
            <span className="account-process-tag">租用流程</span>
            <ol className="account-process-steps-row">
              <li className="account-process-step">
                <span className="account-step-circle">1</span>
                <div className="account-step-text">
                  <strong>确认费用</strong>
                  <span className="account-step-sub">核对配置报价</span>
                </div>
              </li>
              <li className="account-process-step">
                <span className="account-step-circle">2</span>
                <div className="account-step-text">
                  <strong>付款</strong>
                  <span className="account-step-sub">在线支付款项</span>
                </div>
              </li>
              <li className="account-process-step">
                <span className="account-step-circle">3</span>
                <div className="account-step-text">
                  <strong>客服交付</strong>
                  <span className="account-step-sub">协助安全上号</span>
                </div>
              </li>
              <li className="account-process-step">
                <span className="account-step-circle">4</span>
                <div className="account-step-text">
                  <strong>确认开租</strong>
                  <span className="account-step-sub">核对进入游戏</span>
                </div>
              </li>
              <li className="account-process-step">
                <span className="account-step-circle">5</span>
                <div className="account-step-text">
                  <strong>按耗结算</strong>
                  <span className="account-step-sub">退还结余押金</span>
                </div>
              </li>
            </ol>
          </section>

          <details className="account-process-panel"><summary>租赁流程说明</summary><ManagedNoticeSections contentKey="placement:RENTAL_PROCESS" /></details>

          {/* Section 2: Rental Conditions & Owner Note */}
          <section className="account-detail-conditions account-conditions-card" aria-labelledby="account-conditions-title">
            <div className="account-section-title">
              <h2 id="account-conditions-title">
                <Shield size={20} aria-hidden="true" />租用条件
              </h2>
            </div>
            <dl className="account-summary-conditions account-conditions-grid">
              <div className="account-condition-item">
                <dt>
                  <LogIn size={20} aria-hidden="true" />
                  <span>上号方式</span>
                </dt>
                <dd>{loginInfo.text}</dd>
                <span className="account-condition-note">{loginInfo.hint}</span>
              </div>
              <div className="account-condition-item">
                <dt>
                  <Clock3 size={20} aria-hidden="true" />
                  <span>配合上号</span>
                </dt>
                <dd>{value("service_window")}</dd>
                <span className="account-condition-note">北京时间</span>
              </div>
              <div className="account-condition-item">
                <dt>
                  <Coins size={20} aria-hidden="true" />
                  <span>每日消耗</span>
                </dt>
                <dd>{value("daily_consumption")}</dd>
                <span className="account-condition-note">
                  {data.historicalReadOnly ? "来源消耗记录" : "约定消耗档位"}
                </span>
              </div>
              <div className="account-condition-item">
                <dt>
                  <CalendarDays size={20} aria-hidden="true" />
                  <span>{data.historicalReadOnly ? "租期记录" : "推算租期"}</span>
                </dt>
                <dd>{data.termLabel}</dd>
                <span className="account-condition-note">
                  {data.historicalReadOnly ? "来源租期" : "约定消耗推算"}
                </span>
              </div>
            </dl>

            {/* Owner Note */}
            {data.description && data.description.trim() ? (
              <div className="account-owner-note-block">
                <div className="account-owner-note-top">
                  <span className="account-owner-badge">👑 号主补充</span>
                  <p
                    ref={noteRef}
                    className={`account-owner-note-content${noteExpanded ? " is-expanded" : ""}`}
                  >
                    “ {data.description.trim()} ”
                  </p>
                  {canExpandNote || noteExpanded ? (
                    <button
                      type="button"
                      className="account-owner-note-toggle"
                      onClick={() => setNoteExpanded((prev) => !prev)}
                      aria-expanded={noteExpanded}
                    >
                      {noteExpanded ? "收起 ∧" : "展开 ∨"}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : null}
          </section>

          {/* Section 3: Supplies Inventory (8 Items Grid) */}
          <section className="account-stock" aria-labelledby="account-stock-title">
            <div className="account-section-title">
              <h2 id="account-stock-title">
                <Box size={20} aria-hidden="true" />物资库存
              </h2>
              <span>号主申报数量</span>
            </div>
            {resources.length ? (
              <div className="account-stock-grid account-resource-quantities">
                {resources.map((line) => {
                  const itemInfo = formatSupplyItem(line);
                  return (
                    <div
                      key={line.itemId}
                      className="account-stock-card"
                      data-resource-id={line.itemId}
                      data-zero={itemInfo.isZero || undefined}
                    >
                      <div className="account-stock-card-art">
                        <CatalogItemArt mediaId={line.mediaId}>{itemInfo.imageSrc ? (
                          <DetailImage src={itemInfo.imageSrc} alt="" className="account-stock-card-img" />
                        ) : (
                          <Box size={24} aria-hidden="true" />
                        )}</CatalogItemArt>
                      </div>
                      <div className="account-stock-card-info">
                        <dt className="account-stock-card-name" title={line.name}>{line.name}</dt>
                        <dd className={`account-stock-card-qty${itemInfo.isUnknown ? " account-value-unknown" : ""}`}>
                          {itemInfo.quantityText}
                        </dd>
                      </div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <p className="account-empty-note">尚未申报可展示的物资库存。</p>
            )}
            <p className="account-stock-note">
              {data.historicalReadOnly
                ? "以上为来源库存记录，当前不可据此下单。"
                : "物资金额先预付，最终按实际消耗与有效规则结算。"}
            </p>
          </section>

          {/* Section 4: Skins & Entitlements */}
          <section className="account-cosmetics-section" aria-labelledby="account-skins-title">
            <div className="account-section-title">
              <h2 id="account-skins-title">
                <Shirt size={20} aria-hidden="true" />皮肤与权益
              </h2>
            </div>
            {withheldSkinsNote(data.skinsWithheld) ? (
              <p className="account-note-source">{withheldSkinsNote(data.skinsWithheld)}</p>
            ) : null}
            {data.skinTags.length || data.entitlementNames.length ? (
              <div className="account-cosmetics-body">
                <div className="account-skin-groups">
                  {[...skinGroups].map(([category, skins]) => (
                    <section key={category} className="account-skin-group">
                      <div className="account-skin-group-head">
                        <strong>{category}</strong>
                        <span>{skins.length}项</span>
                      </div>
                      <div className="account-skin-grid">
                        {skins.map((tag, i) => (
                          <article
                            key={`${tag.id}:${i}`}
                            className="account-skin-card"
                            data-skin-id={tag.id}
                            data-owner-kind={tag.ownerKind ?? "UNKNOWN"}
                          >
                            <SkinMediaPreview
                              skin={tag}
                              triggerClassName="skin-media-preview-trigger account-skin-card-media-btn"
                              mediaClassName="account-skin-card-media"
                              fallbackClassName="account-skin-card-media-fallback"
                            />
                            <strong title={skinCardTitle(tag)}>{skinCardTitle(tag)}</strong>
                            <SkinMetadata skin={tag} className="account-skin-card-quality" />
                          </article>
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
                <div className="account-entitlement-list">
                  {data.entitlementDetails?.length
                    ? data.entitlementDetails.map((item) => (
                        <div key={item.id} className="account-entitlement-item">
                          <strong>{item.name}</strong>
                          <span>{entitlementExpiryLabel(item)}</span>
                        </div>
                      ))
                    : data.entitlementNames.map((name, index) => (
                        <div key={`${name}:${index}`} className="account-entitlement-item">
                          <strong>{name}</strong>
                          <span>权益详情以个人确认时为准</span>
                        </div>
                      ))}
                </div>
              </div>
            ) : (
              <p className="account-empty-note">暂无皮肤或权益的公开申报。</p>
            )}
          </section>
        </div>

        {/* Right Sticky Column: Price & Confirmation */}
        <aside
          id="account-quote-anchor"
          className="account-quote account-quote-column"
          aria-label="租赁报价"
          data-readonly={data.historicalReadOnly || data.canCreateOrder === false || undefined}
        >
          {data.historicalReadOnly ? (
            <div className="account-quote-panel">
              <div className="account-quote-banner">
                <div className="account-quote-banner-title">
                  <ReceiptText size={18} aria-hidden="true" />
                  <h2>资源费用记录</h2>
                </div>
                <span className="account-quote-banner-tag">资料暂不可租</span>
              </div>
              <div className="account-quote-content">
                {data.sourceAvailabilityLabel ? (
                  <p className="account-source-status">{data.sourceAvailabilityLabel}，不代表当前租态。</p>
                ) : null}
                <p className="account-reference-label">资源费用记录 · 不含押金</p>
                <p className="account-reference-price">{moneyValue(data.resourceTotalLabel)}</p>
                <dl className="account-fee-lines">
                  <div>
                    <dt>哈夫币租金记录</dt>
                    <dd>{moneyValue(data.haffRentLabel)}</dd>
                  </div>
                  <div>
                    <dt>物资预付记录</dt>
                    <dd>{moneyValue(data.itemResourceTotalLabel)}</dd>
                  </div>
                  <div>
                    <dt>押金记录</dt>
                    <dd>{moneyValue(data.depositLabel)}</dd>
                  </div>
                </dl>
                <p className="detail-stage-note account-readonly">
                  这些费用来自该账号的资料记录，不是当前报价；当前不能创建新订单。
                </p>
                <Link className="button secondary button--sm account-readonly-action" href="/accounts">
                  返回账号市场
                </Link>
              </div>
            </div>
          ) : data.canCreateOrder === false ? (
            <div className="account-quote-panel">
              <div className="account-quote-banner">
                <div className="account-quote-banner-title">
                  <ReceiptText size={18} aria-hidden="true" />
                  <h2>公开版本资源费用参考</h2>
                </div>
                <span className="account-quote-banner-tag">暂不可租</span>
              </div>
              <div className="account-quote-content">
                <p className="account-reference-price">{moneyValue(data.resourceTotalLabel)}</p>
                <p className="detail-stage-note account-readonly">
                  已获准公开的资料仍可查看，当前不能创建新订单。这里是公开版本的资源费用参考，不是本人最终报价。
                </p>
                <Link className="button secondary button--sm account-readonly-action" href="/accounts">
                  返回账号市场
                </Link>
              </div>
            </div>
          ) : (
            <div className="account-quote-panel">
              <div className="account-quote-content">
                <RentalConfirmPanel
                  key={`${identityKey}:${data.id}:${data.versionId}:${data.releaseId}`}
                  accountId={data.id}
                  gameId={data.gameId}
                  versionId={data.versionId}
                  releaseId={data.releaseId}
                  fullPayoutSelected={data.fullPayoutSelected === true}
                  {...(data.autoPreview ? { autoPreview: true } : {})}
                  reference={{
                    total: moneyValue(data.resourceTotalLabel),
                    haff: moneyValue(data.haffRentLabel),
                    items: moneyValue(data.itemResourceTotalLabel),
                    lines: data.resourceLines,
                    unitAmountsInformational: data.unitAmountsInformational,
                    ...(data.baseRenterHaffRatioWanPerYuan ? { baseRenterHaffRatioWanPerYuan: data.baseRenterHaffRatioWanPerYuan } : {}),
                  }}
                />
              </div>
            </div>
          )}
          <FavoriteNotice />
        </aside>
      </div>

      {/* Penalty Modal Dialog */}
      <Dialog.Root open={penaltyModalOpen} onOpenChange={setPenaltyModalOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="modal-overlay" />
          <Dialog.Content className="detail-preview-content account-penalty-dialog" aria-describedby={undefined} onCloseAutoFocus={(event) => {
            if (penaltyTriggerRef.current?.isConnected) {
              event.preventDefault();
              penaltyTriggerRef.current.focus();
            }
          }}>
            <div className="account-penalty-dialog-head">
              <Dialog.Title className="account-penalty-dialog-title">
                <ShieldAlert size={20} aria-hidden="true" />
                <span>处罚记录公示资料</span>
              </Dialog.Title>
              <Dialog.Close className="icon-button detail-preview-close" aria-label="关闭处罚截图">
                <X size={18} aria-hidden="true" />
              </Dialog.Close>
            </div>
            <p className="account-note-source">
              {data.banRecord === true ? "号主声明有封禁记录。" : data.banRecord === false ? "号主声明无封禁记录。" : "号主未提供封禁记录声明。"}以下为号主上传的公开截图，不代表平台核验承诺。
            </p>
            <div className="account-penalty-dialog-images">
              {penalties.length > 0 ? (
                penalties.map((item, idx) => (
                  <DetailImage
                    key={item.assetId}
                    src={item.url}
                    alt={`处罚公示资料，第 ${idx + 1} 张`}
                    className="account-penalty-dialog-img"
                  />
                ))
              ) : (
                <p className="account-empty-note">暂未提供可展示的公示图片。</p>
              )}
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </article>
  );
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

  return (
    <ServiceShell
      surface="detail"
      contextLabel={null}
      breadcrumbs={breadcrumbs}
      title={title}
      description={description}
      backHref={back.href}
      backLabel={back.label}
      showPageHeading={false}
      headingInContent={current.status === "ready"}
      searchLabel="在公开目录中搜索账号编号或关键词"
      searchInputLabel="搜索账号编号或关键词"
      searchPlaceholder="搜索其他账号编号或关键词"
    >
      {current.status === "loading" ? (
        <div className="detail-skeleton" aria-busy="true" aria-label="正在加载账号详情">
          <div className="detail-skeleton-hero" aria-hidden="true">
            <div className="detail-skeleton-gallery" />
            <div className="detail-skeleton-copy">
              <span />
              <span />
              <span />
              <span />
            </div>
          </div>
          <div className="detail-skeleton-blocks" aria-hidden="true">
            <div />
            <div />
          </div>
        </div>
      ) : current.status === "unavailable" ? (
        <section className="account-empty listing-unavailable" role="status">
          <h3>该账号暂不可用或已下架</h3>
          <p>该账号当前没有可公开的租用信息，请返回列表选择其他账号。</p>
          <Link className="button secondary" href={back.href}>
            {back.label}
          </Link>
        </section>
      ) : current.status === "error" ? (
        <section className="account-empty" role="alert">
          <h3>账号详情加载失败</h3>
          <p>请检查网络后重试。</p>
          <button type="button" className="button secondary" onClick={retry}>
            <RotateCw size={15} />重试
          </button>
        </section>
      ) : (
        <>{current.status === "ready" ? <ReadyDetail data={current.data} /> : null}</>
      )}
    </ServiceShell>
  );
}
