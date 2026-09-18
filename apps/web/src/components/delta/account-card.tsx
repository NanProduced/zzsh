"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Calendar, Check, ChevronRight, Coins, Copy, Gauge, ImageOff, X } from "lucide-react";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ThumbnailCarousel } from "@/components/ui/thumbnail-carousel";
import { rememberAccountReturn } from "@/lib/account-return";
import { haffRatioLabel, resourceQuantityLabel, type ListingCardData, type ResourceLine } from "@/lib/listing-view";
import { LoginMethodIcon } from "./login-method-icon";

export type AccountCardData = ListingCardData;

export function accountHref(accountId: string): string {
  return "/accounts/" + encodeURIComponent(accountId);
}

function conditionValue(data: AccountCardData, key: string): string | null {
  return data.conditionLines.find((line) => line.key === key)?.value ?? null;
}

function compactSafeBox(value: string | null): string {
  if (!value) return "安全箱待确认";
  const match = value.match(/\((\d)\*(\d)\)/);
  if (match) return `安全箱 ${match[1]}×${match[2]}`;
  if (value.includes("3*3") || value.includes("3×3")) return "安全箱 3×3";
  if (value.includes("2*2") || value.includes("2×2")) return "安全箱 2×2";
  if (value.includes("2*3") || value.includes("2×3")) return "安全箱 2×3";
  return `安全箱 ${value}`;
}

function compactLevel(value: string | null, fallback: string): string {
  if (!value) return fallback;
  const compact = value.replace(/\s+/g, "").replace(/级$/, "");
  return compact ? `${compact}级` : fallback;
}

function isHaff(line: ResourceLine): boolean {
  return line.itemId === "haff" || line.unitLabel === "哈夫币" || line.name.includes("哈夫币");
}

function fallbackResourceValue(line: ResourceLine): string {
  return resourceQuantityLabel(line);
}

const RESOURCE_DISPLAY_ORDER = [
  "df_billable_level6_armor",
  "df_billable_level6_helmet",
  "df_billable_level6_bullet",
  "df_billable_awm_bullet",
  "df_billable_barrett_bullet",
  "df_billable_coffee",
  "df_billable_top_insure_card",
];

function resourceDisplayOrder(line: ResourceLine): number {
  const index = RESOURCE_DISPLAY_ORDER.indexOf(line.code ?? "");
  return index === -1 ? RESOURCE_DISPLAY_ORDER.length : index;
}

function resourceItems(data: AccountCardData): Array<{ code: string | null; label: string; value: string }> {
  return data.resourceLines
    .filter((line) => !isHaff(line))
    .sort((left, right) => resourceDisplayOrder(left) - resourceDisplayOrder(right))
    .map((line) => ({ code: line.code ?? null, label: line.name, value: fallbackResourceValue(line) }));
}

function skinKind(categoryCode: string | null, categoryName: string | null): "agent" | "knife" | "weapon" | "other" {
  const value = `${categoryCode ?? ""} ${categoryName ?? ""}`.toLowerCase();
  if (value.includes("agent") || value.includes("干员")) return "agent";
  if (value.includes("knife") || value.includes("近战") || value.includes("刀")) return "knife";
  if (value.includes("weapon") || value.includes("枪械") || value.includes("武器")) return "weapon";
  return "other";
}

function moneyValue(value: string | null): string {
  return value?.trim() || "待确认";
}

function AccountGallery({
  data,
  open,
  onOpenChange,
  returnFocusRef,
}: {
  data: AccountCardData;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  returnFocusRef: RefObject<HTMLButtonElement | null>;
}) {
  const media = data.media.length > 0
    ? data.media
    : data.imageUrl
      ? [{ assetId: "primary", url: data.imageUrl }]
      : [];
  const [activeIndex, setActiveIndex] = useState(0);
  const [failedItemIds, setFailedItemIds] = useState<Set<string>>(() => new Set());
  const descriptionId = `account-gallery-description-${data.id}`;

  useEffect(() => {
    setActiveIndex(0);
    setFailedItemIds(new Set());
  }, [data.id]);

  if (media.length === 0) return null;
  const move = (direction: -1 | 1) => setActiveIndex((index) => Math.max(0, Math.min(media.length - 1, index + direction)));
  const carouselItems = media.map((item, index) => ({
    id: item.assetId,
    src: item.url,
    alt: `${data.title}公开图片，第${index + 1}张`,
  }));
  const handleImageError = (itemId: string) => {
    setFailedItemIds((current) => new Set(current).add(itemId));
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay account-gallery-overlay" />
        <Dialog.Content
          className="account-gallery-dialog"
          aria-describedby={descriptionId}
          onCloseAutoFocus={(event) => {
            const trigger = returnFocusRef.current;
            if (trigger?.isConnected) {
              event.preventDefault();
              trigger.focus();
            }
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft" && media.length > 1) {
              event.preventDefault();
              move(-1);
            }
            if (event.key === "ArrowRight" && media.length > 1) {
              event.preventDefault();
              move(1);
            }
          }}
        >
          <Dialog.Title className="account-gallery-title">{data.title} · 图片预览</Dialog.Title>
          <Dialog.Description id={descriptionId} className="sr-only">
            使用左右按钮切换该账号的公开展示图片，按 Esc 关闭预览。
          </Dialog.Description>
          <Dialog.Close className="icon-button account-gallery-close" aria-label="关闭图片预览">
            <X size={20} aria-hidden="true" />
          </Dialog.Close>
          <ThumbnailCarousel
            items={carouselItems}
            index={activeIndex}
            onIndexChange={setActiveIndex}
            failedItemIds={failedItemIds}
            onImageError={handleImageError}
          />
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export function AccountCard({
  data,
}: {
  data: AccountCardData;
}) {
  const [failedSrc, setFailedSrc] = useState<string>();
  const [copied, setCopied] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const galleryTriggerRef = useRef<HTMLButtonElement>(null);
  const missing = !data.imageUrl || failedSrc === data.imageUrl;
  const displaySourceId = data.displayNo?.trim() || "待确认";
  const canCopyId = Boolean(data.displayNo?.trim());

  const handleCopyId = (event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    if (canCopyId && typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(displaySourceId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    }
  };

  const haffLine = data.resourceLines.find((line) => isHaff(line));
  const haffQuantityText = haffLine
    ? (haffLine.quantityLabel || haffLine.quantity).replace(/\s+/g, "")
    : "待确认";
  const safeBoxText = compactSafeBox(conditionValue(data, "safe_box_code"));
  const vitText = `体力 ${compactLevel(conditionValue(data, "vit_level"), "待确认")}`;
  const bearText = `负重 ${compactLevel(conditionValue(data, "bear_level"), "待确认")}`;
  const pseudoTitle = `${conditionValue(data, "grading_code") ?? "段位待确认"} · ${compactLevel(conditionValue(data, "character_level"), "等级待确认")}`;
  const coreAttrParts = [safeBoxText, vitText, bearText];

  const resources = resourceItems(data);
  const visibleResources = resources.slice(0, 7);
  const extraResourceCount = Math.max(0, resources.length - visibleResources.length);

  const skinEntries = data.skinTags.length > 0
    ? data.skinTags
    : data.skinNames.map((name) => ({ name, categoryCode: null, categoryName: null }));
  const visibleSkins = skinEntries.slice(0, 4);
  const extraSkinCount = Math.max(0, skinEntries.length - visibleSkins.length);

  const ratioText = haffLine ? haffRatioLabel(haffLine.quantity, haffLine.costAmount) : "待确认";
  const termValue = data.termLabel?.replace(/\s+/g, "") || "待确认";
  const termText = termValue.startsWith("租期") ? termValue : `租期 ${termValue}`;
  const dailyLine = data.conditionLines.find((line) => line.key === "daily_consumption");
  const dailyText = dailyLine?.value
    ? `日消耗 ${dailyLine.value.replace(/哈夫币/g, "").replace(/\s+/g, "")}`
    : "日消耗待确认";
  const loginMethodName = data.loginMethod?.displayName ?? "登录方式待确认";

  return (
    <>
      <article className="account-card" data-account-id={data.id}>
        <div className="account-card-surface">
          <button
            type="button"
            ref={galleryTriggerRef}
            className="account-card-thumb"
            aria-label={missing && data.media.length === 0 ? "公开图片不可用" : `查看${data.title}公开图片`}
            disabled={missing && data.media.length === 0}
            onClick={() => setGalleryOpen(true)}
          >
            {missing ? (
              <div className="thumb-fallback">
                <ImageOff size={24} aria-hidden="true" />
                <span>{data.imageUrl ? "图片加载失败" : "图片未提供"}</span>
              </div>
            ) : (
              <img
                src={data.imageUrl}
                alt={`${data.title}公开图片`}
                onError={() => setFailedSrc(data.imageUrl)}
                loading="lazy"
              />
            )}
            {data.media.length > 1 && <span className="account-card-gallery-hint">查看图片 <ChevronRight size={13} aria-hidden="true" /></span>}
          </button>

          <div className="account-body-area">
            <div className="account-title-row">
              <div className="account-title-core">
                <span className="account-haff-display" aria-label={`哈夫币 ${haffQuantityText}`}>
                  <span className="account-haff-label">哈夫币</span>
                  <strong className="account-haff-quantity">{haffQuantityText}</strong>
                </span>
                <Link
                  className="account-pseudo-link"
                  href={accountHref(data.id)}
                  aria-label={`查看账号 ${data.title}`}
                  onClick={() => rememberAccountReturn(data.id, window.location)}
                >
                  <strong className="account-pseudo-title">{pseudoTitle}</strong>
                </Link>
              </div>
              <span className="account-source-label">
                {canCopyId ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <span className="account-source-trigger" tabIndex={0} aria-label={`账号编号：${displaySourceId}`}>
                        <span className="account-source-value">{displaySourceId}</span>
                      </span>
                    </TooltipTrigger>
                    <TooltipContent side="top">账号编号：{displaySourceId}</TooltipContent>
                  </Tooltip>
                ) : <span className="account-source-value">{displaySourceId}</span>}
                {canCopyId ? (
                  <Tooltip>
                    <TooltipTrigger asChild>
                      <button
                        type="button"
                        className="account-source-copy-btn"
                        onClick={handleCopyId}
                        aria-label="复制账号编号"
                      >
                        {copied ? <Check size={12} className="copy-icon copy-icon--success" aria-hidden="true" /> : <Copy size={12} className="copy-icon" aria-hidden="true" />}
                      </button>
                    </TooltipTrigger>
                    <TooltipContent side="top">复制账号编号</TooltipContent>
                  </Tooltip>
                ) : null}
              </span>
            </div>

            <Link
              className="account-card-link account-card-link--body"
              href={accountHref(data.id)}
              aria-label={`查看账号 ${data.title}`}
              onClick={() => rememberAccountReturn(data.id, window.location)}
            >
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="account-attr-line account-attr-line--secondary">
                    {coreAttrParts.map((part, index) => (
                      <span key={part} className="attr-item-wrap">
                        {index > 0 && <span className="attr-slash">/</span>}
                        <span className="attr-normal">{part}</span>
                      </span>
                    ))}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top">{coreAttrParts.join(" / ")}</TooltipContent>
              </Tooltip>

              <section className="account-resource-section" aria-label="账号资源">
                {visibleResources.length > 0 ? (
                  <div className="account-resource-grid">
                    {visibleResources.map((item) => (
                      <div
                        className={`account-resource-item${item.code === "df_billable_top_insure_card" ? " account-resource-item--full" : ""}`}
                        key={`${item.label}-${item.value}`}
                      >
                        <span>{item.label}</span>
                        <strong>{item.value}</strong>
                      </div>
                    ))}
                    {extraResourceCount > 0 && <span className="account-resource-more">+{extraResourceCount}种</span>}
                  </div>
                ) : (
                  <span className="account-resource-empty">资源待确认</span>
                )}
              </section>

              {visibleSkins.length > 0 ? (
                <div className="account-skins-row" aria-label="皮肤配置">
                  {visibleSkins.map((skin) => {
                    const skinLabel = skin.categoryName ? `${skin.categoryName} · ${skin.name}` : skin.name;
                    return (
                      <Tooltip key={`${skin.name}-${skin.categoryCode ?? "other"}`}>
                        <TooltipTrigger asChild>
                          <span className={`skin-tag skin-tag--${skinKind(skin.categoryCode, skin.categoryName)}`}>
                            {skin.name}
                          </span>
                        </TooltipTrigger>
                        <TooltipContent side="top">{skinLabel}</TooltipContent>
                      </Tooltip>
                    );
                  })}
                  {extraSkinCount > 0 && <span className="skin-tag skin-tag--more">+{extraSkinCount}</span>}
                </div>
              ) : null}

              <div className="account-metric-quad">
                <div className="quad-col"><Coins size={16} className="quad-icon" aria-hidden="true" /><span className="quad-text">{ratioText}</span></div>
                <div className="quad-col"><Calendar size={16} className="quad-icon" aria-hidden="true" /><span className="quad-text">{termText}</span></div>
                <div className="quad-col"><Gauge size={16} className="quad-icon" aria-hidden="true" /><span className="quad-text">{dailyText}</span></div>
                <div className="quad-col"><LoginMethodIcon method={data.loginMethod} size={17} /><span className="quad-text">{loginMethodName}</span></div>
              </div>

              <div className="account-card-bottom">
                <div className="bottom-price-block">
                  <span className="price-title">资源费</span>
                  <div className="price-amount-row"><span className="price-currency">¥</span><strong className="price-digits">{moneyValue(data.resourceTotalLabel).replace(/^¥\s*/, "")}</strong></div>
                </div>
                <div className="bottom-finance-block">
                  <div><span>押金</span><strong>{moneyValue(data.depositLabel)}</strong></div>
                  <div><span>合计</span><strong>{moneyValue(data.payableTotalLabel)}</strong></div>
                </div>
              </div>
            </Link>
          </div>

          <div className="account-card-fav-wrap">
            <FavoriteButton accountId={data.id} title={data.title} />
          </div>
        </div>
      </article>
      <AccountGallery data={data} open={galleryOpen} onOpenChange={setGalleryOpen} returnFocusRef={galleryTriggerRef} />
    </>
  );
}
