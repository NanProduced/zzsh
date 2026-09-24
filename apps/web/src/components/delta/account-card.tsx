"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent, type ReactNode, type RefObject } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { Check, ChevronRight, Clock, Image as ImageIcon, ImageOff, X } from "lucide-react";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ThumbnailCarousel } from "@/components/ui/thumbnail-carousel";
import { rememberAccountReturn, type AccountReturnSnapshot } from "@/lib/account-return";
import { haffRatioLabel, resourceQuantityLabel, type ListingCardData, type ResourceLine, type SkinTag } from "@/lib/listing-view";
import { LoginMethodIcon } from "./login-method-icon";

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

export function isHaff(line: ResourceLine): boolean {
  return line.itemId === "haff" || line.unitLabel === "哈夫币" || line.name.includes("哈夫币");
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

const LIST_RESOURCE_SLOTS = [
  { code: "df_billable_level6_helmet", label: "6级头盔", aliases: ["6级头盔", "六级头盔"] },
  { code: "df_billable_level6_armor", label: "6级护甲", aliases: ["6级护甲", "六级护甲"] },
  { code: "df_billable_level6_bullet", label: "6级子弹", aliases: ["6级子弹", "六级子弹"] },
  { code: "df_billable_awm_bullet", label: "AWM子弹", aliases: ["AWM子弹"] },
] as const;

function resourceDisplayOrder(line: ResourceLine): number {
  const index = RESOURCE_DISPLAY_ORDER.indexOf(line.code ?? "");
  return index === -1 ? RESOURCE_DISPLAY_ORDER.length : index;
}

export function orderedQuoteResources(data: AccountCardData): ResourceLine[] {
  const nonHaff = data.resourceLines.filter((line) => !isHaff(line));
  return [...nonHaff].sort((left, right) => resourceDisplayOrder(left) - resourceDisplayOrder(right));
}

function isUnknownMoney(value: string | null | undefined): boolean {
  const trimmed = value?.trim();
  return !trimmed || trimmed === "以平台确认为准" || trimmed === "待确认" || trimmed === "null" || trimmed === "undefined";
}

function isZeroMoney(value: string): boolean {
  return /^￥?¥?\s*0(?:\.0+)?$/.test(value.replace(/\s+/g, ""));
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
  data: AccountCardData,
  haffQuantityText: string | null
): { haff: string | null; rest: string } {
  const parts: string[] = [];
  const safeBox = safeBoxSizeText(conditionValue(data, "safe_box_code"));
  if (safeBox) parts.push(`${safeBox}安全箱`);
  const grading = conditionValue(data, "grading_code");
  const level = compactLevel(conditionValue(data, "character_level"), null);
  const rank = [grading, level].filter(Boolean).join(" ");
  if (rank) parts.push(rank);

  const haff = haffQuantityText ? `${haffQuantityText} 哈夫币` : null;

  if (parts.length > 0) {
    return { haff, rest: parts.join(" · ") };
  }

  const rawTitle = data.title?.trim() || (data.displayNo ? `账号 ${data.displayNo}` : "游戏账号");
  if (!haffQuantityText) {
    return { haff: null, rest: rawTitle };
  }

  const escapedHaff = haffQuantityText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const haffPrefixPattern = new RegExp(`^\\s*${escapedHaff}\\s*(?:哈夫币)?\\s*[·\\-\\s]*`, "i");
  const cleaned = rawTitle.replace(haffPrefixPattern, "").trim();

  return { haff, rest: cleaned.length > 0 ? cleaned : "" };
}

export function composeListTitle(
  data: Pick<AccountCardData, "title" | "displayNo" | "conditionLines">,
  haffQuantityText: string | null
): { identity: string; haff: string | null; rest: string } {
  let identity = "";
  if (data.displayNo?.trim()) {
    identity = `账号 ${data.displayNo.trim()}`;
  } else if (data.title?.trim()) {
    let t = data.title.trim();
    t = t.replace(/(?:微信扫码|QQ账密|手机号|支持\s*QQ上号|支持\s*微信上号)/g, "").trim();
    if (haffQuantityText) {
      const escaped = haffQuantityText.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      t = t.replace(new RegExp(`^\\s*${escaped}\\s*(?:哈夫币)?\\s*[·\\-\\s]*`, "i"), "").trim();
      t = t.replace(new RegExp(`(^|[^\\dA-Za-z])${escaped}\\s*哈夫币`, "gi"), "$1").trim();
      t = t.replace(/[·|｜]\s*[·|｜]/g, "·");
    }
    t = t.replace(/\s*[·|｜]\s*/g, " · ").replace(/^[·\-|｜\s]+|[·\-|｜\s]+$/g, "").trim();
    identity = t.length > 0 ? t : "游戏账号";
  } else {
    identity = "游戏账号";
  }

  const haff = haffQuantityText ? `${haffQuantityText} 哈夫币` : null;

  const parts: string[] = [];
  const safeBox = safeBoxSizeText(conditionValue(data, "safe_box_code"));
  if (safeBox) parts.push(`${safeBox}安全箱`);
  const grading = conditionValue(data, "grading_code");
  const level = compactLevel(conditionValue(data, "character_level"), null);
  const rank = [grading, level].filter(Boolean).join(" ");
  if (rank) parts.push(rank);

  const rest = parts.join(" · ");
  return { identity, haff, rest };
}

export function skinChipTone(tag: SkinTag): "teal" | "purple" | "blue" | "default" {
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

function compactResourceQty(line: ResourceLine): string {
  const ql = (line.quantityLabel || line.quantity || "").replace(/\s+/g, "");
  if (ql.includes("（")) {
    return ql.split("（")[0] || ql;
  }
  return resourceQuantityLabel(line);
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
  getReturnState,
  viewMode = "grid",
  imageLoading = "lazy",
}: {
  data: AccountCardData;
  getReturnState?: () => AccountReturnSnapshot;
  viewMode?: AccountCardViewMode;
  imageLoading?: "eager" | "lazy";
}) {
  const [failedSrc, setFailedSrc] = useState<string>();
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
  const ratioText = haffLine ? haffRatioLabel(haffLine.quantity, haffLine.costAmount) : "待确认";
  const showRatioNote = ratioText !== "待确认";


  const vitValue = compactLevel(conditionValue(data, "vit_level"), null);
  const bearValue = compactLevel(conditionValue(data, "bear_level"), null);
  const loginValue = data.loginMethod?.displayName?.trim() || null;
  const termValue = data.termLabel?.replace(/\s+/g, "") || null;
  const serviceWindowValue = conditionValue(data, "service_window");

  const gridTitle = composeGridTitle(data, haffQuantityText);
  const isPayableConfirmed = !isUnknownMoney(data.payableTotalLabel);
  const isFastMode = data.rentalMode === "fast" || conditionValue(data, "rental_mode") === "fast";
  const mediaCount = data.media.length;

  const favorite = <FavoriteButton accountId={data.id} title={data.title} />;

  if (viewMode === "list") {
    const listTitle = composeListTitle(data, haffQuantityText);

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

    const listResourceCells = LIST_RESOURCE_SLOTS.map((slot) => ({
      slot,
      line: data.resourceLines.find((line) =>
        line.code === slot.code || (line.code === null && (slot.aliases as readonly string[]).includes(line.name))
      ) ?? null,
    }));

    const extraSkinCount = Math.max(0, data.skinTags.length - 3);

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
              aria-label={missing && mediaCount === 0 ? "公开图片不可用" : `查看${data.title}公开图片`}
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
                  alt={`${data.title}公开图片`}
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
                aria-label={`查看账号 ${listTitle.identity}`}
                onClick={rememberDetail}
              >
                <span className="account-list-title-identity">{listTitle.identity}</span>
                {listTitle.haff ? (
                  <span className="account-list-haff-lead"> · {listTitle.haff}</span>
                ) : null}
                {listTitle.rest ? (
                  <span className="account-list-title-rest"> · {listTitle.rest}</span>
                ) : null}
              </Link>
              {isFastMode ? <span className="account-list-deal-tag">特惠</span> : null}
            </div>

            <p className="account-list-subline">
              {sublineContent}
            </p>
          </div>

          <section className="account-list-matrix" aria-label="账号属性条件">
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

              <div className="resources-grid-2x2">
                {listResourceCells.map(({ slot, line }) => (
                  <div
                    key={slot.code}
                    className={`resources-cell${line ? "" : " resources-cell--placeholder"}`}
                  >
                    <span className="resources-cell-name" title={slot.label}>{slot.label}</span>
                    <strong className="resources-cell-qty" title={line ? resourceQuantityLabel(line) : "暂无该项资源"}>
                      {line ? resourceQuantityLabel(line) : "-"}
                    </strong>
                  </div>
                ))}
              </div>
            </div>
          </section>

          <section className="account-list-skins" aria-label="皮肤外观">
            {data.skinTags && data.skinTags.length > 0 ? (
              <>
                {data.skinTags.slice(0, 3).map((tag, idx) => {
                  const tone = skinChipTone(tag);
                  return (
                    <span key={`${tag.name}-${idx}`} className={`account-skin-chip account-skin-chip--${tone}`}>
                      {tag.categoryName ? (
                        <span className="skin-chip-cat" style={{ opacity: 0.85, marginRight: "3px" }}>
                          [{tag.categoryName}]
                        </span>
                      ) : null}
                      <span className="skin-chip-name" title={tag.name}>{tag.name}</span>
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
            <div className="account-list-finance">
              <div className="finance-row">
                <span className="finance-label">租金</span>
                <span className={`finance-val ${moneyValue(data.haffRentLabel, "无租金") === "待确认" ? "finance-val--unconfirmed" : ""}`}>
                  {moneyValue(data.haffRentLabel, "无租金")}
                </span>
              </div>
              <div className="finance-row">
                <span className="finance-label">资源费用</span>
                <span className={`finance-val ${moneyValue(data.itemResourceTotalLabel, "无物品费用") === "待确认" ? "finance-val--unconfirmed" : ""}`}>
                  {moneyValue(data.itemResourceTotalLabel, "无物品费用")}
                </span>
              </div>
              <div className="finance-row">
                <span className="finance-label">押金</span>
                <span className={`finance-val ${moneyValue(data.depositLabel, "无需押金") === "待确认" ? "finance-val--unconfirmed" : ""}`}>
                  {moneyValue(data.depositLabel, "无需押金")}
                </span>
              </div>
              <div className="finance-total-row">
                <span className="finance-total-label">总价</span>
                <strong
                  className={`finance-total-val ${
                    !isPayableConfirmed ? "finance-total-val--unconfirmed" : ""
                  }`}
                >
                  {moneyValue(data.payableTotalLabel, "无需支付")}
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
              <div className="account-list-fav">{favorite}</div>
            </div>
          </div>
        </div>
        <AccountGallery data={data} open={galleryOpen} onOpenChange={setGalleryOpen} returnFocusRef={galleryTriggerRef} />
      </article>
    );
  }

  const gridAttrs: string[] = [];
  if (vitValue) gridAttrs.push(`体力 ${vitValue}`);
  if (bearValue) gridAttrs.push(`负重 ${bearValue}`);
  if (termValue) gridAttrs.push(`租期 ${termValue}`);
  if (serviceWindowValue) gridAttrs.push(`可用 ${serviceWindowValue}`);
  else if (data.termOptionLabel) gridAttrs.push(`规则 ${data.termOptionLabel}`);

  const visibleSkins = data.skinTags.length > 4 ? data.skinTags.slice(0, 3) : data.skinTags.slice(0, 4);
  const extraSkinCount = Math.max(0, data.skinTags.length - visibleSkins.length);

  const gridQuoteResources = orderedQuoteResources(data);
  const visibleResourcePills = gridQuoteResources.slice(0, 3);
  const extraGridResourceCount = Math.max(0, gridQuoteResources.length - visibleResourcePills.length);


  const gridThumb = (
    <button
      type="button"
      ref={galleryTriggerRef}
      className="account-card-thumb"
      aria-label={missing && data.media.length === 0 ? "公开图片不可用" : `查看${data.title}公开图片`}
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
          src={data.imageUrl}
          alt={`${data.title}公开图片`}
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
              {favorite}
            </div>
          </div>
          <div className="account-card-body">
            <div className="account-title-row">
              <Link
                className="account-card-cover-link"
                href={accountHref(data.id)}
                aria-label={`查看账号 ${data.title}`}
                onClick={rememberDetail}
              >
                <strong
                  className="account-grid-title"
                  title={`${gridTitle.haff ? gridTitle.haff + " · " : ""}${gridTitle.rest}`}
                >
                  {gridTitle.haff ? (
                    <span className="account-grid-haff">{gridTitle.haff}</span>
                  ) : null}
                  {gridTitle.rest ? (
                    <span className="account-grid-title-rest">
                      {gridTitle.haff ? ` · ${gridTitle.rest}` : gridTitle.rest}
                    </span>
                  ) : null}
                </strong>
              </Link>
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
                  {visibleSkins.map((skin, idx) => (
                    <span
                      key={`${skin.name}-${idx}`}
                      className={`account-skin-chip account-skin-chip--${skinChipTone(skin)}`}
                    >
                      {skin.name}
                    </span>
                  ))}
                  {extraSkinCount > 0 ? (
                    <span className="account-skin-chip account-skin-chip--more" title="更多皮肤见详情">
                      +{extraSkinCount}
                    </span>
                  ) : null}
                </>
              ) : null}
            </section>

            <section className="account-resource-pills" aria-label="资源标签">
              {visibleResourcePills.length > 0 ? (
                <>
                  {visibleResourcePills.map((line) => {
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
                  {extraGridResourceCount > 0 ? (
                    <span className="account-resource-pill account-resource-pill--more" title="更多资源见详情">
                      +{extraGridResourceCount}
                    </span>
                  ) : null}
                </>
              ) : null}
            </section>

            <div className="account-card-breakdown">
              <div className="breakdown-header">
                <span className="breakdown-title">金额构成</span>
                {showRatioNote ? (
                  <span className="breakdown-note" title="辅助换算 · 非报价">
                    {ratioText} · 辅助换算 · 非报价
                  </span>
                ) : null}
              </div>
              <div className="breakdown-rows">
                <div className="breakdown-row">
                  <span className="breakdown-label">资源费</span>
                  <span className="breakdown-val">{moneyValue(data.resourceTotalLabel, "无资源费用")}</span>
                </div>
                <div className="breakdown-row">
                  <span className="breakdown-label">押金</span>
                  <span className="breakdown-val">{moneyValue(data.depositLabel, "无需押金")}</span>
                </div>
              </div>
              <div className="breakdown-total-row">
                <span className="breakdown-total-label">合计</span>
                <strong
                  className={`breakdown-total-val ${
                    !isPayableConfirmed ? "breakdown-total-val--unconfirmed" : ""
                  }`}
                >
                  {moneyValue(data.payableTotalLabel, "无需支付")}
                </strong>
              </div>
            </div>
          </div>
        </div>
        <AccountGallery data={data} open={galleryOpen} onOpenChange={setGalleryOpen} returnFocusRef={galleryTriggerRef} />
      </article>
    </>
  );
}
