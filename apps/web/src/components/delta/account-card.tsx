"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as Popover from "@radix-ui/react-popover";
import { Check, ChevronRight, Clock, Copy, Image as ImageIcon, ImageOff, PackageOpen, X } from "lucide-react";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ThumbnailCarousel } from "@/components/ui/thumbnail-carousel";
import { rememberAccountReturn, type AccountReturnSnapshot } from "@/lib/account-return";
import { resourceQuantityLabel, skinQualityLabel, skinTypeLabel, type ListingCardData, type ResourceLine, type SkinTag } from "@/lib/listing-view";
import { LoginMethodIcon } from "./login-method-icon";
import { canonicalResourceCode } from "@/lib/listing-filters";
export { canonicalResourceCode } from "@/lib/listing-filters";
import {
  deriveAccountTitle,
  formatSupplyItem,
  isHaff,
  orderedQuoteResources,
} from "@/lib/account-title";
export { isHaff, orderedQuoteResources } from "@/lib/account-title";

export type AccountCardData = ListingCardData;
export type AccountCardViewMode = "list" | "grid";

export function accountHref(accountId: string): string {
  return "/accounts/" + encodeURIComponent(accountId);
}

function conditionValue(data: Pick<AccountCardData, "conditionLines">, key: string): string | null {
  return data.conditionLines.find((line) => line.key === key)?.value ?? null;
}

function safeBoxSizeText(value: string | null): string | null {
  if (!value) return null;
  const match = value.match(/(\d)\s*[*×xX]\s*(\d)/);
  if (match) return `${match[1]}×${match[2]}`;
  return value;
}

function compactLevel(value: string | null, fallback: string): string;
function compactLevel(value: string | null, fallback: string | null): string | null;
function compactLevel(value: string | null, fallback: string | null = null): string | null {
  if (!value) return fallback;
  const compact = value.replace(/\s+/g, "").replace(/级$/, "");
  return compact ? `${compact}级` : fallback;
}

/** Published base ratio exactly as the server delivered it; never re-derived from quantities or amounts. */
export function authoritativeRatioLabel(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed || !/^\d+(?:\.\d+)?$/.test(trimmed)) return null;
  return `${trimmed.replace(/(\.\d*?[1-9])0+$|\.0+$/, "$1")}万/元`;
}

function isZeroQuantity(line: ResourceLine): boolean {
  const quantity = line.quantity.trim();
  return /^\d+$/.test(quantity) && BigInt(quantity) === 0n;
}

export type ResourceSummary = { lines: ResourceLine[]; hiddenCount: number };

/**
 * Explicit comparison summary: current filter hits first, then declared stock that is not a
 * known zero. hiddenCount counts every real row left out, so "还有 N 项" never hides a row
 * silently and never invents stock from the visible cells.
 */
function compactResourceQty(line: ResourceLine): string {
  const ql = (line.quantityLabel || line.quantity || "").replace(/\s+/g, "");
  if (ql.includes("（")) {
    return ql.split("（")[0] || ql;
  }
  return resourceQuantityLabel(line);
}

function resourceVisualPriority(line: ResourceLine): number {
  const code = line.code ?? "";
  const name = line.name;
  if (code.includes("armor") || name.includes("甲")) return 1;
  if (code.includes("helmet") || name.includes("头")) return 2;
  if (code.includes("bullet") || name.includes("子弹")) return 3;
  return 10;
}

export function summarizeQuoteResources(
  data: Pick<AccountCardData, "resourceLines">,
  matchedItemIds: ReadonlySet<string> | null | undefined,
  slots: number
): ResourceSummary {
  const ordered = orderedQuoteResources(data);
  const eligible = ordered.filter((line) => matchedItemIds?.has(line.itemId) || !isZeroQuantity(line));
  const ranked = [...eligible].sort((left, right) => {
    const leftMatch = matchedItemIds?.has(left.itemId) ? 1 : 0;
    const rightMatch = matchedItemIds?.has(right.itemId) ? 1 : 0;
    if (leftMatch !== rightMatch) return rightMatch - leftMatch;

    const leftTier = resourceVisualPriority(left);
    const rightTier = resourceVisualPriority(right);
    if (leftTier !== rightTier) return leftTier - rightTier;

    const leftLen = left.name.length;
    const rightLen = right.name.length;
    if (leftLen !== rightLen) return leftLen - rightLen;

    return 0;
  });
  const lines = ranked.slice(0, ranked.length > slots ? slots - 1 : slots);
  return { lines, hiddenCount: ranked.length - lines.length };
}

function financeFacts(data: AccountCardData) {
  const historical = Boolean(data.historicalReadOnly);
  const depositKnown = !isUnknownMoney(data.depositLabel);
  const payableKnown = !isUnknownMoney(data.payableTotalLabel);
  const depositZero = depositKnown && isZeroMoney(data.depositLabel ?? "");
  const totalIsPayable = !historical && payableKnown;
  const totalValue = historical
    ? moneyValue(data.resourceTotalLabel, "无资源费用")
    : moneyValue(totalIsPayable ? data.payableTotalLabel : data.resourceTotalLabel, "无资源费用");
  const totalCaption = historical ? "不含押金" : totalIsPayable ? (depositZero ? "" : "含押金") : "押金待核";
  return {
    historical,
    totalLabel: historical ? "资源费用记录" : "总价",
    totalValue,
    totalCaption,
    totalAria: historical
      ? `资源费用记录 ${totalValue}，不含押金`
      : totalIsPayable
        ? `总价 ${totalValue}${depositZero ? "" : "，含押金"}`
        : `资源费用 ${totalValue}，押金待核`,
    haffLabel: historical ? "哈夫币租金记录" : "哈夫币租金",
    haffValue: moneyValue(data.haffRentLabel, "无租金"),
    itemsLabel: historical ? "物资预付记录" : "物资预付",
    itemsValue: moneyValue(data.itemResourceTotalLabel, "无物品费用"),
    depositLabel: historical ? "押金记录" : "押金",
    depositValue: depositKnown ? moneyValue(data.depositLabel, "无需押金") : historical ? "未提供" : "详情核定",
    depositUnknown: !historical && !depositKnown,
    ratio: authoritativeRatioLabel(data.baseRenterHaffRatioWanPerYuan),
  };
}

function isUnknownMoney(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  return !trimmed || trimmed === "以平台确认为准" || trimmed === "待确认" || trimmed === "null" || trimmed === "undefined";
}

function isZeroMoney(value: string): boolean {
  return /^￥?¥?\s*0(?:\.0+)?$/.test(value.replace(/\s+/g, ""));
}

const COPY_ACTION_TEXT = { idle: "复制", ok: "已复制", error: "复制失败" } as const;
type CopyStatus = keyof typeof COPY_ACTION_TEXT;

function CopyableAccountNumber({ displayNo, compact = false }: { displayNo: string | null; compact?: boolean }) {
  const [status, setStatus] = useState<CopyStatus>("idle");
  const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => {
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
  }, []);
  const number = displayNo?.trim() || null;
  if (!number) return <span className={`account-card-number account-card-number--missing${compact ? " account-card-number--compact" : ""}`}>账号编号待分配</span>;
  const copy = async (event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    let ok = false;
    try {
      await navigator.clipboard.writeText(number);
      ok = true;
    } catch {
      ok = false;
    }
    setStatus(ok ? "ok" : "error");
    if (resetTimer.current !== null) clearTimeout(resetTimer.current);
    resetTimer.current = setTimeout(() => {
      setStatus("idle");
      resetTimer.current = null;
    }, 2000);
  };
  return <button type="button" className={`account-card-number${compact ? " account-card-number--compact" : ""}`} onClick={copy} aria-label={`复制账号编号 ${number}`}>
    {status === "ok" ? <Check size={12} aria-hidden="true" /> : status === "error" ? <X size={12} aria-hidden="true" /> : <Copy size={12} aria-hidden="true" />}
    <span>账号 {number}</span>
    {/* Stacked labels keep the button width fixed while the transient result shows. */}
    <span className="account-card-number-action" aria-hidden="true" style={{ display: "inline-grid" }}>
      {(Object.keys(COPY_ACTION_TEXT) as CopyStatus[]).map((key) => (
        <span key={key} style={{ gridArea: "1 / 1", visibility: status === key ? "visible" : "hidden" }}>{COPY_ACTION_TEXT[key]}</span>
      ))}
    </span>
    <span className="sr-only" role="status">{status === "ok" ? "账号编号已复制" : status === "error" ? "复制失败，请选中编号手动复制" : ""}</span>
  </button>;
}

function ResourceEmpty({ compact = false }: { compact?: boolean }) {
  return <span className={`account-resource-empty${compact ? " account-resource-empty--compact" : ""}`} role="note">
    <PackageOpen size={compact ? 13 : 15} aria-hidden="true" />
    <span>{compact ? "物资未申报" : "库存尚未申报"}</span>
  </span>;
}

const RESOURCE_POPOVER_SURFACE: CSSProperties = {
  width: 300,
  padding: 6,
  border: "1px solid var(--color-border-default)",
  borderRadius: 8,
  background: "var(--color-bg-card)",
  color: "var(--color-text-primary)",
  boxShadow: "var(--shadow-lg)",
};

/** Complete declared stock on demand: the comparison summary stays short, nothing is clipped silently. */
function FullResourcesPopover({ data, hiddenCount, className, children }: {
  data: AccountCardData;
  hiddenCount: number;
  className: string;
  children: ReactNode;
}) {
  return <Popover.Root>
    <Popover.Trigger asChild>
      <button type="button" className={className} aria-label={`还有 ${hiddenCount} 项物资，展开完整清单`}>{children}</button>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content side="bottom" align="start" sideOffset={6} collisionPadding={12} style={RESOURCE_POPOVER_SURFACE} aria-label="该账号申报的全部物资">
        <div className="resources-grid-2x2" style={{ minHeight: 0 }}>
          {orderedQuoteResources(data).map((line) => (
            <div key={line.itemId} className="resources-cell">
              <span className="resources-cell-name" title={line.name}>{line.name}</span>
              <strong className="resources-cell-qty" title={resourceQuantityLabel(line)}>{resourceQuantityLabel(line)}</strong>
            </div>
          ))}
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

export function moneyValue(value: string | null | undefined, zeroLabel = "¥0.00"): string {
  const trimmed = value?.trim();
  if (isUnknownMoney(trimmed)) return "待确认";
  return isZeroMoney(trimmed ?? "") ? zeroLabel : trimmed ?? "待确认";
}

export function listTermRuleLabel(termOptionLabel: string | null | undefined): string {
  if (!termOptionLabel) return "租期规则待确认";
  const cleanTerm = termOptionLabel
    .replace(/日消耗\s*[^\s·|]*/g, "")
    .replace(/\(测试\)|\（测试\）/g, "")
    .replace(/^[\s·|]+|[\s·|]+$/g, "")
    .trim();
  return `租期规则 ${cleanTerm || "待确认"}`;
}

export function composeGridTitle(
  data: Parameters<typeof deriveAccountTitle>[0],
  haffQuantityText?: string | null
): { haff: string | null; rest: string } {
  const title = deriveAccountTitle(data, haffQuantityText);
  return {
    haff: title.haff,
    rest: title.rest,
  };
}

export function composeListTitle(
  data: Parameters<typeof deriveAccountTitle>[0],
  haffQuantityText?: string | null
): { identity: string; haff: string | null; rest: string } {
  const title = deriveAccountTitle(data, haffQuantityText);
  return {
    identity: "",
    haff: title.haff,
    rest: title.rest,
  };
}

export function skinChipTone(tag: SkinTag): "teal" | "purple" | "blue" | "default" {
  // The verified owner type wins; the category fallback below only colours older frozen snapshots without it.
  if (tag.ownerKind === "MELEE_TYPE") return "teal";
  if (tag.ownerKind === "AGENT") return "purple";
  if (tag.ownerKind === "FIREARM") return "blue";
  const code = (tag.categoryCode ?? "").toLowerCase();
  const cat = (tag.categoryName ?? "").toLowerCase();

  // 1. Knife / melee skins
  if (code.includes("knife") || code.includes("melee") || cat.includes("近战") || cat.includes("刀")) {
    return "teal";
  }
  // 2. Operator / agent skins
  if (code.includes("operator") || code.includes("agent") || code.includes("character") || cat.includes("干员") || cat.includes("角色")) {
    return "purple";
  }
  // 3. Weapon / gun skins
  if (code.includes("weapon") || code.includes("gun") || cat.includes("枪") || cat.includes("武器")) {
    return "blue";
  }
  // 4. Missing or unknown category -> neutral
  return "default";
}

function isBulletResource(line: ResourceLine): boolean {
  return (line.code ?? "").includes("bullet") || line.unitLabel === "发" || line.name.includes("子弹");
}

function isArmorResource(line: ResourceLine): boolean {
  return (line.code ?? "").includes("armor") || (line.code ?? "").includes("helmet") || line.name.includes("甲") || line.name.includes("头盔");
}



function AccountGallery({
  data,
  visibleTitle,
  open,
  onOpenChange,
  returnFocusRef,
}: {
  data: AccountCardData;
  visibleTitle: string;
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
    alt: `${visibleTitle}公开图片，第${index + 1}张`,
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
          <Dialog.Title className="account-gallery-title">{visibleTitle} · 图片预览</Dialog.Title>
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
  getReturnState,
  viewMode = "grid",
  imageLoading = "lazy",
  coverRetry = false,
  matchedResourceItemIds = null,
}: {
  data: AccountCardData;
  getReturnState?: () => AccountReturnSnapshot;
  viewMode?: AccountCardViewMode;
  imageLoading?: "eager" | "lazy";
  /** 收藏页需要封面失败后可重试；市场页默认保持原降级，不新增控件。 */
  coverRetry?: boolean;
  /** Committed filter hits; listed first in the resource summary so a matched row is always checkable. */
  matchedResourceItemIds?: ReadonlySet<string> | null;
}) {
  const [failedSrc, setFailedSrc] = useState<string>();
  const [retryToken, setRetryToken] = useState(0);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const galleryTriggerRef = useRef<HTMLButtonElement>(null);
  const missing = !data.imageUrl || failedSrc === data.imageUrl;

  const rememberDetail = (event: ReactMouseEvent) => {
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)
      rememberAccountReturn(data.id, window.location, getReturnState?.());
  };

  const haffLine = data.resourceLines.find((line) => isHaff(line));
  const haffQuantityText = haffLine
    ? (haffLine.quantityLabel || haffLine.quantity).replace(/\s+/g, "")
    : null;
  const facts = financeFacts(data);


  const vitValue = compactLevel(conditionValue(data, "vit_level"), null);
  const bearValue = compactLevel(conditionValue(data, "bear_level"), null);
  const loginValue = data.loginMethod?.displayName?.trim() || null;
  const termValue = data.termLabel?.replace(/\s+/g, "") || null;
  const serviceWindowValue = conditionValue(data, "service_window");

  const accountTitle = deriveAccountTitle(data, haffQuantityText);
  const accountVisibleTitle = [accountTitle.primary, accountTitle.secondary].filter(Boolean).join(" · ");
  const readOnly = data.historicalReadOnly || data.canCreateOrder === false;
  const isFastMode = !readOnly && (data.rentalMode === "fast" || conditionValue(data, "rental_mode") === "fast");
  const mediaCount = data.media.length;

  const favoriteFor = (title: string) => <FavoriteButton accountId={data.id} title={title} />;

  const [expandedSupplies, setExpandedSupplies] = useState(false);
  const [expandedFees, setExpandedFees] = useState(false);

  if (viewMode === "list") {
    const quoteResources = matchedResourceItemIds && matchedResourceItemIds.size > 0
      ? [...orderedQuoteResources(data)].sort((left, right) => Number(matchedResourceItemIds.has(right.itemId)) - Number(matchedResourceItemIds.has(left.itemId)))
      : orderedQuoteResources(data);
    const regionProvince = conditionValue(data, "region_province");
    const regionCity = conditionValue(data, "region_city");
    const regionText = [regionProvince, regionCity].filter(Boolean).join(" · ") || "-";

    // Row 1 cells: 体力 | 负重 | 租期 | 地区
    const row1Cells = [
      { label: "体力", value: compactLevel(conditionValue(data, "vit_level"), "-") },
      { label: "负重", value: compactLevel(conditionValue(data, "bear_level"), "-") },
      { label: "租期", value: data.termLabel?.replace(/\s+/g, "") || "-" },
      { label: "地区", value: regionText },
    ];

    // Row 2 cells: 段位 | 绝密 KD | 潜水等级/角色等级 | 每日消耗
    const gradingValue = conditionValue(data, "grading_code") || "-";
    const kdValue = conditionValue(data, "secret_kd") || "-";
    const diveVal = conditionValue(data, "dive_level");
    const charVal = conditionValue(data, "character_level");
    const levelCell = diveVal
      ? { label: "潜水等级", value: compactLevel(diveVal, "-") }
      : charVal
      ? { label: "角色等级", value: compactLevel(charVal, "-") }
      : { label: "角色等级", value: "-" };
    const dailyLine = data.conditionLines.find((e) => e.key === "daily_consumption");
    const dailyVal = dailyLine?.value || "-";

    const row2Cells = [
      { label: "段位", value: gradingValue },
      { label: "绝密 KD", value: kdValue },
      { label: levelCell.label, value: levelCell.value },
      { label: "每日消耗", value: dailyVal },
    ];

    // Mobile 3x2 core attributes: 账号等级/体力/负重, 6级护甲/6级头盔/6级子弹
    const armorLine = data.resourceLines.find((l) => {
      const code = canonicalResourceCode(l.code);
      return code === "df_billable_level6_armor" || l.name.includes("6级护甲") || l.name.includes("六级甲") || l.name.includes("六级护甲");
    });
    const armor6Display = armorLine ? formatSupplyItem(armorLine).quantityText : "-";

    const helmetLine = data.resourceLines.find((l) => {
      const code = canonicalResourceCode(l.code);
      return code === "df_billable_level6_helmet" || l.name.includes("6级头盔") || l.name.includes("六级头") || l.name.includes("六级头盔");
    });
    const helmet6Display = helmetLine ? formatSupplyItem(helmetLine).quantityText : "-";

    const bulletLine = data.resourceLines.find((l) => {
      const code = canonicalResourceCode(l.code);
      return code === "df_billable_level6_bullet" || l.name.includes("6级子弹") || l.name.includes("六级子弹");
    });
    const bullet6Display = bulletLine ? (() => {
      const raw = bulletLine.quantity?.trim() ?? "";
      if (/^\d+$/.test(raw)) {
        const rounds = BigInt(raw);
        const stacks = rounds / 60n;
        const rem = rounds % 60n;
        if (stacks > 0n && rem === 0n) return `${stacks}组`;
        if (stacks === 0n) return `${rounds}发`;
        return `${stacks}组（${rounds}发）`;
      }
      return formatSupplyItem(bulletLine).quantityText;
    })() : "-";

    const safeBoxRaw = conditionValue(data, "safe_box_code");
    const safeBoxText = safeBoxSizeText(safeBoxRaw) ? `${safeBoxSizeText(safeBoxRaw)}安全箱` : null;
    const gradingDisplay = conditionValue(data, "grading_code") && conditionValue(data, "grading_code") !== "-"
      ? conditionValue(data, "grading_code")
      : null;

    const extraSkinCount = Math.max(0, data.skinTags.length - 6);

    const mobileResourceItems = [
      { label: "6级甲", value: armor6Display },
      { label: "6级头盔", value: helmet6Display },
      { label: "6级子弹", value: bullet6Display },
    ];
    const hasMobileResourceFacts = mobileResourceItems.some((item) => item.value !== "-");
    const positiveResourceCount = quoteResources.filter((line) => !formatSupplyItem(line).isZero).length;
    const accountSummaryItems = [
      { label: "等级", value: charVal ? compactLevel(charVal, "-") : "-" },
      { label: "体力", value: vitValue || "-" },
      { label: "负重", value: bearValue || "-" },
      ...(gradingDisplay ? [] : [{ label: "段位", value: gradingValue }]),
    ];
    const conditionSummaryItems = [
      serviceWindowValue ? { label: "可上号", value: serviceWindowValue } : null,
      termValue ? { label: "租期", value: termValue } : null,
      dailyVal && dailyVal !== "-" ? { label: "每日", value: dailyVal } : null,
    ].filter((item): item is { label: string; value: string } => item !== null);
    const resourceSummaryItems = mobileResourceItems.filter((item) => item.value !== "-").slice(0, 2);
    const depositSummaryText = facts.historical
      ? "记录不含押金"
      : facts.depositUnknown
      ? "押金待核"
      : facts.depositValue === "无需押金"
      ? "无押金"
      : `含押金 ${facts.depositValue.replace(/\.00$/, "")}`;

    let sublineContent: ReactNode = null;
    if (serviceWindowValue) {
      sublineContent = (
        <>
          <Clock size={11} className="subline-clock-icon" aria-hidden="true" />
          <span>可上号 {serviceWindowValue}</span>
        </>
      );
    } else {
      sublineContent = <span>{listTermRuleLabel(data.termOptionLabel)}</span>;
    }

    return (
      <article className="account-card account-card--list" data-account-id={data.id}>
        <div className="account-card-surface account-list-item">
          <div className="account-list-media">
            <button
              type="button"
              ref={galleryTriggerRef}
              className="account-card-thumb account-list-thumb"
              aria-label={missing && mediaCount === 0 ? "公开图片不可用" : `查看${accountVisibleTitle}公开图片`}
              disabled={missing && mediaCount === 0}
              onClick={(e) => {
                e.stopPropagation();
                setGalleryOpen(true);
              }}
            >
              {missing ? (
                <div className="thumb-fallback">
                  <ImageOff size={22} aria-hidden="true" />
                  <span>{data.imageUrl ? "图片加载失败" : "图片未提供"}</span>
                </div>
              ) : (
                <img
                  src={data.imageUrl}
                  alt={`${accountVisibleTitle}公开图片`}
                  onError={() => setFailedSrc(data.imageUrl)}
                  width={220}
                  height={100}
                  loading={imageLoading}
                  fetchPriority={imageLoading === "eager" ? "high" : "auto"}
                  decoding="async"
                />
              )}
              <div className="account-list-thumb-badges">
                {mediaCount > 0 ? (
                  <span className="thumb-badge thumb-badge--count" title={`共 ${mediaCount} 张图片`}>
                    <ImageIcon size={11} aria-hidden="true" />
                    <span>{mediaCount} 张</span>
                  </span>
                ) : null}
                {loginValue ? (
                  <span className="thumb-badge thumb-badge--login">
                    <LoginMethodIcon method={data.loginMethod} size={11} />
                    <span>支持 {loginValue}</span>
                  </span>
                ) : null}
              </div>
            </button>
          </div>

          <div className="account-list-header">
            <div className="account-list-title-row">
              <Link
                className="account-list-title-link"
                href={accountHref(data.id)}
                aria-label={`查看账号 ${accountVisibleTitle}`}
                onClick={rememberDetail}
              >
                {accountTitle.haff ? <span className="account-list-haff-lead">{accountTitle.haff}</span> : null}
                {accountTitle.rest ? (
                  <span className="account-list-title-rest">{accountTitle.haff ? " · " : ""}{accountTitle.rest}</span>
                ) : null}
                {accountTitle.secondary ? (
                  <span className="account-list-title-secondary">
                    <span className="sr-only"> · </span>
                    <span className="account-title-supplies-badge">{accountTitle.secondary}</span>
                  </span>
                ) : null}
              </Link>
              {facts.ratio ? (
                <span
                  className="account-tag-pill account-tag-pill--ratio"
                  title="哈夫币兑换比例（万哈夫币/元），不含会员礼遇与个人优惠"
                >
                  {facts.ratio}
                </span>
              ) : null}
              <div className="account-mobile-badges" aria-label="关键属性标签">
                {safeBoxText ? <span className="account-tag-pill account-tag-pill--safebox">{safeBoxText}</span> : null}
                {gradingDisplay ? <span className="account-tag-pill account-tag-pill--grading">{gradingDisplay}</span> : null}
              </div>
            </div>
            <div className="account-list-subline-row">{data.availabilityLabel || data.historicalReadOnly ? <span className="account-history-badge" data-public-availability={data.availabilityState}>{data.availabilityLabel ?? "暂不可租"}</span> : null}
              {isFastMode ? <span className="account-list-deal-tag">特惠</span> : null}
              <p className="account-list-subline">{sublineContent}</p>
              <CopyableAccountNumber displayNo={data.displayNo} compact />
            </div>
          </div>

          <section className="account-list-matrix" aria-label="账号属性条件">
            <div className="account-matrix-desktop">
              <div className="matrix-row">
                {row1Cells.map((cell) => (
                  <div key={cell.label} className="matrix-col">
                    <span className="matrix-label">{cell.label}</span>
                    <strong className="matrix-value" title={cell.value}>{cell.value}</strong>
                  </div>
                ))}
              </div>
              <div className="matrix-row">
                {row2Cells.map((cell) => (
                  <div key={cell.label} className="matrix-col">
                    <span className="matrix-label">{cell.label}</span>
                    <strong className="matrix-value" title={cell.value}>{cell.value}</strong>
                  </div>
                ))}
              </div>
            </div>
            <div className="account-mobile-summary" aria-label="账号摘要">
              <div className="account-mobile-summary-line">
                {accountSummaryItems.map((item, index) => (
                  <span className="account-mobile-summary-item" key={item.label}>
                    {index > 0 ? <span className="account-mobile-summary-sep">｜</span> : null}
                    <span className="account-mobile-summary-label">{item.label}</span>
                    <strong title={item.value}>{item.value}</strong>
                  </span>
                ))}
              </div>
              {conditionSummaryItems.length > 0 ? (
                <div className="account-mobile-summary-line">
                  {conditionSummaryItems.map((item, index) => (
                    <span className="account-mobile-summary-item" key={item.label}>
                      {index > 0 ? <span className="account-mobile-summary-sep">·</span> : null}
                      <span className="account-mobile-summary-label">{item.label}</span>
                      <strong title={item.value}>{item.value}</strong>
                    </span>
                  ))}
                </div>
              ) : null}
              <div className="account-mobile-summary-line account-mobile-summary-resources">
                {hasMobileResourceFacts ? (
                  <>
                    {resourceSummaryItems.map((item, index) => (
                      <span className="account-mobile-summary-item" key={item.label}>
                        {index > 0 ? <span className="account-mobile-summary-sep">·</span> : null}
                        <span className="account-mobile-summary-label">{item.label}</span>
                        <strong title={item.value}>{item.value}</strong>
                      </span>
                    ))}
                    {positiveResourceCount > 0 ? (
                      <button
                        type="button"
                        className="account-mobile-resource-toggle"
                        data-with-sep={resourceSummaryItems.length > 0 ? "true" : undefined}
                        aria-expanded={expandedSupplies}
                        onClick={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setExpandedSupplies((v) => !v);
                        }}
                      >
                        <span>{expandedSupplies ? "收起" : `全部 ${positiveResourceCount} 项`}</span>
                        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={expandedSupplies ? "account-toggle-icon--open" : ""} aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
                      </button>
                    ) : null}
                  </>
                ) : <ResourceEmpty compact />}
              </div>
              {expandedSupplies ? (
                <div className="account-mobile-expanded-supplies" aria-label="全部物资明细">
                  {quoteResources.map((line) => {
                    const formatted = formatSupplyItem(line);
                    return (
                      <div key={`${line.itemId}-${line.code ?? ""}`} className={`expanded-supply-row ${formatted.isZero ? "expanded-supply-row--zero" : ""}`}>
                        <span className="expanded-supply-name">{line.name}</span>
                        <strong className="expanded-supply-qty">{formatted.quantityText}</strong>
                      </div>
                    );
                  })}
                </div>
              ) : null}
            </div>
          </section>

          <section className="account-list-resources-panel" aria-label="物品资源区">
            <div className="resources-table-wrap">
              <div className="resources-table-side">
                <span className="resources-side-title">物品资源</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="resources-info-trigger"
                      aria-label="物品资源说明：物品金额先预付，结算按实际使用量核算，未使用部分退还；最终以订单结算为准。"
                    >
                      <span className="resources-info-icon" aria-hidden="true">!</span>
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top" className="resources-info-tooltip">
                    物品金额先预付，结算按实际使用量核算，未使用部分退还；最终以订单结算为准。
                  </TooltipContent>
                </Tooltip>
              </div>

              {(() => {
                const positiveResources = quoteResources.filter((line) => {
                  const formatted = formatSupplyItem(line);
                  return !formatted.isZero;
                }).sort((left, right) => {
                  const matched = Number(matchedResourceItemIds?.has(right.itemId) ?? false) - Number(matchedResourceItemIds?.has(left.itemId) ?? false);
                  return matched || Number(canonicalResourceCode(right.code) === "df_billable_level6_bullet") - Number(canonicalResourceCode(left.code) === "df_billable_level6_bullet");
                });
                return positiveResources.length > 0 ? (
                  <div className="resources-grid-2x2">
                    {positiveResources.map((line) => {
                      const formatted = formatSupplyItem(line);
                      return (
                        <div
                          key={`${line.itemId}-${line.code ?? ""}`}
                          className={`resources-cell ${formatted.isUnknown ? "resources-cell--unknown" : ""}`}
                        >
                          <span className="resources-cell-name" title={line.name}>{canonicalResourceCode(line.code) === "df_billable_level6_bullet" ? "六级子弹" : line.name}</span>
                          <strong className="resources-cell-qty" title={formatted.quantityText}>
                            {formatted.quantityText}
                          </strong>
                        </div>
                      );
                    })}
                  </div>
                ) : <ResourceEmpty />;
              })()}
            </div>
          </section>

          <section className="account-list-skins" aria-label="皮肤外观">
            {data.skinTags && data.skinTags.length > 0 ? (
              <>
                {data.skinTags.slice(0, 6).map((tag, idx) => {
                  const tone = skinChipTone(tag);
                  const typeLabel = skinTypeLabel(tag.ownerKind);
                  const qualityLabel = skinQualityLabel(tag);
                  const tooltipText = [tag.name, typeLabel, qualityLabel].filter(Boolean).join(" · ");
                  return (
                    <span
                      key={`${tag.id}-${idx}`}
                      className={`account-skin-chip account-skin-chip--${tone}`}
                      data-skin-id={tag.id}
                      title={tooltipText}
                      aria-label={`${tag.name}${typeLabel ? ` (${typeLabel})` : ""}`}
                    >
                      <span className="skin-chip-name">{tag.name}</span>
                    </span>
                  );
                })}
                {extraSkinCount > 0 ? (
                  <span className="account-skin-chip account-skin-chip--more" title={`还有 ${extraSkinCount} 款皮肤见详情`}>
                    +{extraSkinCount}
                  </span>
                ) : null}
              </>
            ) : (
              <span className="account-list-skins-empty" aria-hidden="true" />
            )}
          </section>

          <div className="account-list-rail">
            <div className="account-mobile-price-summary">
              <div className="account-mobile-price-main" aria-label={facts.totalAria}>
                <span className="account-mobile-price-main-label">{facts.totalLabel}</span>
                <strong className={`account-mobile-price-main-val ${facts.totalValue === "待确认" ? "account-mobile-price-main-val--unconfirmed" : ""}`}>{facts.totalValue}</strong>
              </div>
              <div className="account-mobile-price-sub">
                <span
                  className={`account-mobile-price-deposit-text ${facts.depositUnknown ? "account-price-unknown" : ""}`}
                  title={facts.historical ? undefined : "基础押金；会员实付以下单时个人报价为准"}
                  data-deposit-state={facts.depositUnknown ? "unknown" : facts.depositValue === "无需押金" ? "zero" : "known"}
                >
                  {depositSummaryText}
                </span>
                <button
                  type="button"
                  className="account-mobile-fee-toggle"
                  aria-expanded={expandedFees}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setExpandedFees((v) => !v);
                  }}
                >
                  <span>{expandedFees ? "收起明细" : "费用明细"}</span>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={expandedFees ? "account-toggle-icon--open" : ""} aria-hidden="true"><polyline points="6 9 12 15 18 9" /></svg>
                </button>
              </div>
            </div>
            <div className="account-list-finance">
              {facts.ratio ? (
                <div className="finance-row finance-row--ratio">
                  <span className="finance-label">基准比例</span>
                  <span className="finance-val" title="公开基准比例（万哈夫币/元），不含会员礼遇与个人优惠">{facts.ratio}</span>
                </div>
              ) : null}
              <div className="finance-row">
                <span className="finance-label">{facts.haffLabel}</span>
                <span className={`finance-val ${facts.haffValue === "待确认" ? "finance-val--unconfirmed" : ""}`}>{facts.haffValue}</span>
              </div>
              <div className="finance-row">
                <span className="finance-label">{facts.itemsLabel}</span>
                <span className={`finance-val ${facts.itemsValue === "待确认" ? "finance-val--unconfirmed" : ""}`}>{facts.itemsValue}</span>
              </div>
              <div className="finance-row finance-row--deposit">
                <span className="finance-label">{facts.depositLabel}</span>
                <span
                  className={`finance-val ${facts.depositValue === "详情核定" || facts.depositValue === "未提供" ? "finance-val--unconfirmed" : ""}`}
                  title={facts.historical ? undefined : "基础押金；会员实付以下单时个人报价为准"}
                  data-deposit-state={facts.depositUnknown ? "unknown" : facts.depositValue === "无需押金" ? "zero" : "known"}
                >
                  {facts.depositValue}
                </span>
              </div>
              <div className="finance-total-row" aria-label={facts.totalAria}>
                <span className="finance-total-meta">
                  <span className="finance-total-title">{facts.totalLabel}</span>
                  {facts.totalCaption ? <span className="finance-total-caption">{facts.totalCaption}</span> : null}
                </span>
                <strong className={`finance-total-val ${facts.totalValue === "待确认" ? "finance-total-val--unconfirmed" : ""}`}>
                  {facts.totalValue}
                </strong>
              </div>
            </div>
            <div className="account-list-cta-row">
              <Link
                className="account-card-cta account-list-cta-btn"
                href={accountHref(data.id)}
                onClick={rememberDetail}
              >
                <span>查看详情</span>
                <ChevronRight size={14} aria-hidden="true" />
              </Link>
              <div className="account-list-fav">{favoriteFor(accountVisibleTitle)}</div>
            </div>
            {expandedFees ? (
              <dl className="account-mobile-price-lines">
                {facts.ratio ? (
                  <div>
                    <dt>哈夫币比例</dt>
                    <dd title="公开基准比例（万哈夫币/元），不含会员礼遇与个人优惠">{facts.ratio}</dd>
                  </div>
                ) : null}
                <div>
                  <dt>{facts.haffLabel}</dt>
                  <dd>{facts.haffValue}</dd>
                </div>
                <div>
                  <dt>{facts.itemsLabel}</dt>
                  <dd>{facts.itemsValue}</dd>
                </div>
                <div className="account-mobile-price-deposit">
                  <dt>{facts.depositLabel}</dt>
                  <dd className={facts.depositUnknown ? "account-price-unknown" : ""}>{facts.depositValue}</dd>
                </div>
              </dl>
            ) : null}
          </div>
        </div>
        <AccountGallery data={data} visibleTitle={accountVisibleTitle} open={galleryOpen} onOpenChange={setGalleryOpen} returnFocusRef={galleryTriggerRef} />
      </article>
    );
  }

  const gridAttrs: string[] = [];
  if (vitValue) gridAttrs.push(`体力 ${vitValue}`);
  if (bearValue) gridAttrs.push(`负重 ${bearValue}`);
  if (termValue) gridAttrs.push(`租期 ${termValue}`);
  if (serviceWindowValue) gridAttrs.push(`可用 ${serviceWindowValue}`);
  else if (data.termOptionLabel) gridAttrs.push(`规则 ${data.termOptionLabel}`);

  const visibleSkins = data.skinTags.slice(0, 4);
  const extraSkinCount = Math.max(0, data.skinTags.length - visibleSkins.length);

  const gridSummary = summarizeQuoteResources(data, matchedResourceItemIds, 5);


  // 封面失败只降级封面区：收藏页（coverRetry）给重试入口，其余页面保持原有降级，不新增控件。
  const gridThumb = missing && coverRetry && data.imageUrl ? (
    <div className="account-card-thumb is-cover-failed" role="status">
      <div className="thumb-fallback">
        <ImageOff size={24} aria-hidden="true" />
        <span>图片加载失败</span>
        <button
          type="button"
          className="button secondary button--sm"
          onClick={() => {
            setFailedSrc(undefined);
            setRetryToken((value) => value + 1);
          }}
        >
          重试
        </button>
      </div>
    </div>
  ) : (
    <button
      type="button"
      ref={galleryTriggerRef}
      className="account-card-thumb"
      aria-label={missing && data.media.length === 0 ? "公开图片不可用" : `查看${accountVisibleTitle}公开图片`}
      disabled={missing && data.media.length === 0}
      onClick={(e) => {
        e.stopPropagation();
        setGalleryOpen(true);
      }}
    >
      {missing ? (
        <div className="thumb-fallback">
          <ImageOff size={24} aria-hidden="true" />
          <span>{data.imageUrl ? "图片加载失败" : "图片未提供"}</span>
        </div>
      ) : (
        <img
          key={retryToken}
          src={data.imageUrl}
          alt={`${accountVisibleTitle}公开图片`}
          onError={() => setFailedSrc(data.imageUrl)}
          width={320}
          height={190}
          loading={imageLoading}
          fetchPriority={imageLoading === "eager" ? "high" : "auto"}
          decoding="async"
        />
      )}
      {data.media.length > 1 && (
        <span className="account-card-gallery-hint">
          查看图片 <ChevronRight size={13} aria-hidden="true" />
        </span>
      )}
    </button>
  );

  return (
    <>
      <article className="account-card account-card--grid" data-account-id={data.id}>
        <div className="account-card-surface">
          <div className="account-card-media-wrap">
            {gridThumb}
            {loginValue ? (
              <div className="account-card-login-pill">
                <LoginMethodIcon method={data.loginMethod} size={13} />
                <span>{loginValue}</span>
              </div>
            ) : null}
            <div className="account-card-fav-wrap" onClick={(e) => e.stopPropagation()}>
              {favoriteFor(accountVisibleTitle)}
            </div>
          </div>
          <div className="account-card-body">
            <div className="account-title-row">
              <Link
                className="account-card-cover-link"
                href={accountHref(data.id)}
                aria-label={`查看账号 ${accountVisibleTitle}`}
                onClick={rememberDetail}
              >
                <strong
                  className="account-grid-title"
                  title={[accountTitle.primary, accountTitle.secondary].filter(Boolean).join(" · ")}
                >
                  {accountTitle.haff ? (
                    <span className="account-grid-haff">{accountTitle.haff}</span>
                  ) : null}
                  {accountTitle.rest ? (
                    <span className="account-grid-title-rest">
                      {accountTitle.haff ? ` · ${accountTitle.rest}` : accountTitle.rest}
                    </span>
                  ) : null}
                  {accountTitle.secondary ? (
                    <span className="account-grid-title-secondary">
                      {accountTitle.haff || accountTitle.rest ? " · " : ""}
                      <span className="account-title-supplies-badge">{accountTitle.secondary}</span>
                    </span>
                  ) : null}
                </strong>
              </Link>
            </div>
            <div className="account-card-meta-row">{data.availabilityLabel || data.historicalReadOnly ? <span className="account-history-badge" data-public-availability={data.availabilityState}>{data.availabilityLabel ?? "暂不可租"}</span> : null}
              {isFastMode ? <span className="account-card-deal-tag">特惠</span> : null}
              <CopyableAccountNumber displayNo={data.displayNo} compact />
            </div>

            {gridAttrs.length > 0 ? (
              <div className="account-grid-subattrs" title={gridAttrs.join(" · ")}>
                {gridAttrs.join(" · ")}
              </div>
            ) : (
              <div className="account-grid-subattrs account-grid-subattrs--empty" />
            )}

            <section className="account-skin-tags" aria-label="皮肤标签">
              {visibleSkins.length > 0 ? (
                <>
                  {visibleSkins.map((skin, idx) => {
                    const typeLabel = skinTypeLabel(skin.ownerKind);
                    const qualityLabel = skinQualityLabel(skin);
                    const tooltipText = [skin.name, typeLabel, qualityLabel].filter(Boolean).join(" · ");
                    return (
                      <span
                        key={`${skin.id}-${idx}`}
                        className={`account-skin-chip account-skin-chip--${skinChipTone(skin)}`}
                        data-skin-id={skin.id}
                        title={tooltipText}
                        aria-label={`${skin.name}${typeLabel ? ` (${typeLabel})` : ""}`}
                      >
                        <span className="skin-chip-name">{skin.name}</span>
                      </span>
                    );
                  })}
                  {extraSkinCount > 0 ? (
                    <span className="account-skin-chip account-skin-chip--more" title="更多皮肤见详情">
                      +{extraSkinCount}
                    </span>
                  ) : null}
                </>
              ) : null}
            </section>

            <section className="account-resource-pills" aria-label="资源标签">
              {gridSummary.lines.length > 0 ? (
                <>
                  {gridSummary.lines.map((line) => {
                    const isBullet = isBulletResource(line);
                    const isArmor = isArmorResource(line);
                    return (
                      <span
                        key={`${line.itemId}-${line.code ?? ""}`}
                        className={`account-resource-pill ${isBullet ? "account-resource-pill--bullet" : isArmor ? "account-resource-pill--armor" : ""}`}
                      >
                        {isBullet ? (
                          <svg width="9" height="12" viewBox="0 0 9 12" fill="none" aria-hidden="true" className="pill-icon">
                            <path d="M1.5 4.5V11H7.5V4.5C7.5 2 4.5 0.8 4.5 0.8C4.5 0.8 1.5 2 1.5 4.5Z" stroke="currentColor" strokeWidth="1.2" />
                          </svg>
                        ) : isArmor ? (
                          <svg width="10" height="12" viewBox="0 0 10 12" fill="none" aria-hidden="true" className="pill-icon">
                            <path d="M5 0.8L1 2.8V6C1 9 5 11.2 5 11.2C5 11.2 9 9 9 6V2.8L5 0.8Z" stroke="currentColor" strokeWidth="1.2" />
                          </svg>
                        ) : null}
                        <span className="pill-name">{line.name}</span>
                        <strong className="pill-qty">{compactResourceQty(line)}</strong>
                      </span>
                    );
                  })}
                  {gridSummary.hiddenCount > 0 ? (
                    <FullResourcesPopover data={data} hiddenCount={gridSummary.hiddenCount} className="account-resource-pill account-resource-pill--more">
                      +{gridSummary.hiddenCount}
                    </FullResourcesPopover>
                  ) : null}
                </>
              ) : <ResourceEmpty compact />}
            </section>

            <div className="account-card-breakdown">
              <div className="breakdown-header">
                <span className="breakdown-title">金额构成</span>
                {facts.ratio ? (
                  <span className="breakdown-note" title="公开基准比例（万哈夫币/元），不含会员礼遇与个人优惠">
                    {facts.ratio} · 基准比例
                  </span>
                ) : null}
              </div>
              <div className="breakdown-rows">
                <div className="breakdown-row">
                  <span className="breakdown-label">{facts.haffLabel}</span>
                  <span className="breakdown-val">{facts.haffValue}</span>
                </div>
                <div className="breakdown-row">
                  <span className="breakdown-label">{facts.itemsLabel}</span>
                  <span className="breakdown-val">{facts.itemsValue}</span>
                </div>
                <div className="breakdown-row breakdown-row--deposit">
                  <span className="breakdown-label">{facts.depositLabel}</span>
                  <span
                    className="breakdown-val"
                    title={facts.historical ? undefined : "基础押金；会员实付以下单时个人报价为准"}
                    data-deposit-state={facts.depositUnknown ? "unknown" : facts.depositValue === "无需押金" ? "zero" : "known"}
                  >
                    {facts.depositValue}
                  </span>
                </div>
              </div>
              <div className="breakdown-total-row" aria-label={facts.totalAria}>
                <span className="finance-total-meta">
                  <span className="finance-total-title">{facts.totalLabel}</span>
                  {facts.totalCaption ? <span className="finance-total-caption">{facts.totalCaption}</span> : null}
                </span>
                <strong className={`breakdown-total-val ${facts.totalValue === "待确认" ? "breakdown-total-val--unconfirmed" : ""}`}>
                  {facts.totalValue}
                </strong>
              </div>
            </div>
          </div>
        </div>
        <AccountGallery data={data} visibleTitle={accountVisibleTitle} open={galleryOpen} onOpenChange={setGalleryOpen} returnFocusRef={galleryTriggerRef} />
      </article>
    </>
  );
}
