"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import {
  ChevronLeft,
  ChevronRight,
  Maximize2,
  X,
  Shield,
  Gamepad2,
  User,
  Crosshair,
  LogIn,
  MapPin,
  Sparkles,
  Clock,
  ExternalLink,
  ImageOff,
  Dumbbell,
  ShieldAlert,
} from "lucide-react";
import { LegacyAccountImage } from "@zzsh/ui/legacy-account-image";
import { AccountMediaPlaceholder } from "@zzsh/ui/account-media-placeholder";
import { supplyApi } from "@/lib/supply-client";
import { haffMillionsLabel, toListingDetail, type ListingDetailData } from "@/lib/listing-view";
import type { OrderListingFacts, OrderParty } from "@/lib/order-client";

type DossierState =
  | { accountId: string | null; status: "loading" }
  | { accountId: string | null; status: "ready"; data: ListingDetailData }
  | { accountId: string | null; status: "fallback" };

export function OrderAccountDossier({
  accountId,
  accountDisplayNo,
  party,
  listingFacts,
  orderResources,
  gameName = "三角洲行动",
}: {
  accountId?: string | null;
  accountDisplayNo?: string | null;
  party: OrderParty;
  listingFacts?: OrderListingFacts | null;
  orderResources?: Array<{ code: string; name: string; value: string; quantity?: string | null }> | null;
  gameName?: string | null;
}) {
  const [savedState, setState] = useState<DossierState>({ accountId: accountId ?? null, status: "loading" });
  const state: DossierState = savedState.accountId === (accountId ?? null) ? savedState : { accountId: accountId ?? null, status: "loading" };
  const [activeImageIdx, setActiveImageIdx] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);

  // Load listing details
  useEffect(() => {
    const controller = new AbortController();
    const target = accountId ?? null;
    setState({ accountId: target, status: "loading" });
    setActiveImageIdx(0);
    setLightboxOpen(false);

    const fetcher = accountId
      ? supplyApi.listing(accountId, controller.signal)
      : Promise.reject(new Error("No linked account identifier"));

    fetcher
      .then((listing) => {
        if (!controller.signal.aborted) {
          if (listing.id !== target) throw new Error("Listing identity mismatch");
          setState({ accountId: target, status: "ready", data: toListingDetail(listing) });
        }
      })
      .catch((_err) => {
        if (!controller.signal.aborted) {
          setState({ accountId: target, status: "fallback" });
        }
      });

    return () => controller.abort();
  }, [accountId]);

  // Keyboard navigation for lightbox
  useEffect(() => {
    if (!lightboxOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setLightboxOpen(false);
      } else if (e.key === "ArrowLeft") {
        setActiveImageIdx((prev) => Math.max(0, prev - 1));
      } else if (e.key === "ArrowRight") {
        if (state.status === "ready" && state.data.media.length > 0) {
          setActiveImageIdx((prev) => Math.min(state.data.media.length - 1, prev + 1));
        }
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [lightboxOpen, state]);

  // Fallback rendering when public listing is not available
  if (state.status === "fallback" || !accountId) {
    const safeBox = listingFacts?.attributeDisplay?.safeBox;
    const grading = listingFacts?.attributeDisplay?.grading;
    const loginMethod = listingFacts?.attributeDisplay?.loginMethod;
    const rentalMode = listingFacts?.rentalMode;
    const rentalModeLabel = rentalMode === "fast" ? "极速出租" : rentalMode === "ordinary" ? "普通租赁" : rentalMode === "custom" ? "自定义租赁" : rentalMode ?? null;
    const termSeconds = listingFacts?.termSeconds;
    const termDaysLabel = termSeconds ? `${Math.round(Number(termSeconds) / 86400)} 天` : null;

    const validResources = (orderResources ?? []).filter(r => r.value && !/^0(?:\s*天)?$/.test(r.value));
    const factResources = (listingFacts?.resourceLines ?? [])
      .filter(l => l.quantity && l.quantity !== "0")
      .map(l => ({
        code: l.code,
        name: l.name || "资源",
        value: l.unit === "HAFF_BASE"
          ? (/^\d{1,24}$/.test(l.quantity!) ? `${haffMillionsLabel(l.quantity!)} M 哈夫币` : `${l.quantity} 哈夫币`)
          : `${l.quantity} ${l.unit === "ROUND" ? "发" : l.unit === "PIECE" ? "件" : l.unit === "DAY" ? "天" : ""}`.trim()
      }));
    const displayResources = factResources.length > 0 ? factResources : validResources;

    if (!safeBox && !grading && !loginMethod && !displayResources.length) return null;

    const isWechat = loginMethod?.includes("微信");

    return (
      <section className="account-module-card order-account-dossier-card" aria-label="关联游戏账号基本规格">
        <div className="account-module-card-header order-dossier-header">
          <div className="order-dossier-header-title">
            <span className="order-dossier-tag">账号档案</span>
            <div className="order-dossier-title-text">
              <h3>{accountDisplayNo ? `账号 ${accountDisplayNo}` : "关联游戏账号基本规格"}</h3>
              <span className="order-dossier-game-name">{listingFacts?.source === "ORDER_VERSION" ? "下单时账号资料" : listingFacts?.source === "LEGACY_ACCOUNT_SNAPSHOT" ? "当前账号资料（迁入时记录）" : "当前账号资料"}</span>
            </div>
          </div>
          <div className="order-dossier-header-badges">
            <span className="mra-game-tag">{gameName}</span>
            {loginMethod ? (
              <span className={`account-order-method-badge ${isWechat ? "is-wechat" : "is-qq"}`}>{loginMethod}</span>
            ) : null}
            {accountDisplayNo ? (
              <span className="order-dossier-acc-badge">编号：{accountDisplayNo}</span>
            ) : null}
          </div>
        </div>

        <div className="order-dossier-body">
          {/* 左侧相册/占位图区域 */}
          <div className="order-dossier-gallery-col">
            <div className="order-dossier-gallery-title">
              <h4>公开截图 (0 张)</h4>
            </div>
            <div className="order-dossier-no-media">
              <AccountMediaPlaceholder state="UNAVAILABLE" className="order-dossier-empty-placeholder" />
            </div>
          </div>

          {/* 右侧规格详情区域 */}
          <div className="order-dossier-info-col">
            {/* 统一属性规格网格 */}
            <div className="order-dossier-unified-specs">
              {safeBox ? (
                <div className="order-dossier-spec-pill highlight">
                  <span className="spec-pill-label">安全箱</span>
                  <strong className="spec-pill-val">{safeBox}</strong>
                </div>
              ) : null}
              {grading ? (
                <div className="order-dossier-spec-pill">
                  <span className="spec-pill-label">游戏段位</span>
                  <strong className="spec-pill-val">{grading}</strong>
                </div>
              ) : null}
              {loginMethod ? (
                <div className="order-dossier-spec-pill">
                  <span className="spec-pill-label">上号方式</span>
                  <strong className="spec-pill-val">{loginMethod}</strong>
                </div>
              ) : null}
              {rentalModeLabel ? (
                <div className="order-dossier-spec-pill">
                  <span className="spec-pill-label">租赁模式</span>
                  <strong className="spec-pill-val">{rentalModeLabel}</strong>
                </div>
              ) : null}
              {termDaysLabel ? (
                <div className="order-dossier-spec-pill">
                  <span className="spec-pill-label">约定租期</span>
                  <strong className="spec-pill-val">{termDaysLabel}</strong>
                </div>
              ) : null}
              <div className="order-dossier-spec-pill">
                <span className="spec-pill-label">资料来源</span>
                <strong className="spec-pill-val">
                  {listingFacts?.source === "LEGACY_ACCOUNT_SNAPSHOT" ? "历史迁入快照" : "下单资料快照"}
                </strong>
              </div>
            </div>

            {/* 关联在架物资与交付资源 */}
            {displayResources.length > 0 ? (
              <div className="order-dossier-spec-section order-dossier-resources-section">
                <h4 className="order-dossier-section-title">关联在架物资与交付资源 ({displayResources.length})</h4>
                <div className="order-dossier-resource-chips">
                  {displayResources.map((res) => {
                    const isHaff = res.code === "haff_base" || res.name?.includes("哈夫币");
                    return (
                      <div key={res.code} className={`order-dossier-resource-chip${isHaff ? " is-haff" : ""}`}>
                        <span className="resource-chip-name">{res.name}：</span>
                        <strong className="resource-chip-val">{res.value}</strong>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* 号主声明与交付保障 */}
            <div className="order-dossier-spec-section order-dossier-trust-section">
              <h4 className="order-dossier-section-title">号主声明与服务</h4>
              <div className="order-dossier-trust-badges">
                <div className="order-dossier-trust-item">
                  <Shield size={13} className="trust-icon" aria-hidden="true" />
                  <span>人脸声明未提供</span>
                </div>
                <div className="order-dossier-trust-item">
                  <Shield size={13} className="trust-icon" aria-hidden="true" />
                  <span>封禁记录声明未提供</span>
                </div>
                <div className="order-dossier-trust-item">
                  <Clock size={13} className="trust-icon" aria-hidden="true" />
                  <span>平台实机核验 · 真人客服一单一群交接</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>
    );
  }

  if (state.status === "loading") {
    return (
      <section className="account-module-card order-account-dossier-card is-loading" aria-busy="true">
        <div className="order-dossier-loading-text">
          <Gamepad2 size={16} className="animate-spin" aria-hidden="true" />
          <span>正在读取账号当前公开资料…</span>
        </div>
      </section>
    );
  }

  const { data } = state;
  const mediaList = data.media ?? [];
  const currentMedia = mediaList[activeImageIdx] ?? mediaList[0];
  const targetAccId = data.id || accountId;

  // Extract condition attributes
  const conditionMap = new Map<string, string>();
  for (const c of data.conditionLines ?? []) {
    conditionMap.set(c.key, c.value);
  }

  const safeBox = conditionMap.get("safe_box_code");
  const grading = conditionMap.get("grading_code");
  const charLevel = conditionMap.get("character_level");
  const secretKd = conditionMap.get("secret_kd");
  const loginMethod = conditionMap.get("login_method_code");
  const province = conditionMap.get("region_province");
  const city = conditionMap.get("region_city");
  const regionText = province && city ? `${province} · ${city}` : province || city;
  const vitLevel = conditionMap.get("vit_level");
  const bearLevel = conditionMap.get("bear_level");
  const diveLevel = conditionMap.get("dive_level");
  const serviceWindow = conditionMap.get("service_window");

  const displayResources = (data.resourceLines ?? [])
    .filter(line => line.quantity && line.quantity !== "0")
    .map(line => ({ code: line.code ?? line.itemId, name: line.name, value: line.unitLabel === "哈夫币" ? `${line.quantityLabel} 哈夫币` : line.quantityLabel }));

  // Public target link
  const publicHref = targetAccId ? `/accounts/${encodeURIComponent(targetAccId)}` : null;

  return (
    <section className="account-module-card order-account-dossier-card" aria-label="关联账号当前公开资料">
      {/* 区分明确的卡片 Header */}
      <div className="order-dossier-header">
        <div className="order-dossier-header-title">
          <span className="order-dossier-tag">
            <Gamepad2 size={13} aria-hidden="true" />
            当前公开账号资料
          </span>
          <div className="order-dossier-title-text">
            <h3>{data.displayNo ? `账号 ${data.displayNo}` : "游戏账号规格"}</h3>
            <span className="order-dossier-game-name">当前公开资料，不代表下单时快照</span>
          </div>
        </div>
        <div className="order-dossier-header-badges">
          <span className="mra-game-tag">{gameName}</span>
          {loginMethod ? (
            <span className={`account-order-method-badge ${loginMethod.includes("微信") ? "is-wechat" : "is-qq"}`}>{loginMethod}</span>
          ) : null}
          {publicHref ? (
            <Link className="order-dossier-public-link" href={publicHref} scroll={false}>
              <span>查看账号公开主页</span>
              <ExternalLink size={13} aria-hidden="true" />
            </Link>
          ) : null}
        </div>
      </div>

      <div className="order-dossier-body">
        {/* 左侧/上方：账号实机截图相册 */}
        <div className="order-dossier-gallery-col">
          <div className="order-dossier-gallery-title">
            <h4>公开截图 ({mediaList.length} 张)</h4>
            {mediaList.length > 0 ? (
              <button
                type="button"
                className="order-dossier-zoom-btn"
                onClick={() => setLightboxOpen(true)}
                aria-label="放大查看大图"
              >
                <Maximize2 size={13} aria-hidden="true" />
                <span>放大看大图</span>
              </button>
            ) : null}
          </div>

          {mediaList.length > 0 && currentMedia ? (
            <div className="order-dossier-gallery-viewer">
              <div
                className="order-dossier-main-img-wrap"
                onClick={() => setLightboxOpen(true)}
                title="点击放大查看原图"
              >
                <LegacyAccountImage
                  src={currentMedia.url}
                  alt={`账号公开截图 第 ${activeImageIdx + 1} 张`}
                  className="order-dossier-main-img"
                  loading="eager"
                />
                <span className="order-dossier-img-counter">
                  {activeImageIdx + 1} / {mediaList.length}
                </span>

                {mediaList.length > 1 ? (
                  <>
                    <button
                      type="button"
                      className="order-dossier-nav-btn prev"
                      disabled={activeImageIdx === 0}
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveImageIdx((prev) => Math.max(0, prev - 1));
                      }}
                      aria-label="查看上一张截图"
                    >
                      <ChevronLeft size={18} aria-hidden="true" />
                    </button>
                    <button
                      type="button"
                      className="order-dossier-nav-btn next"
                      disabled={activeImageIdx === mediaList.length - 1}
                      onClick={(e) => {
                        e.stopPropagation();
                        setActiveImageIdx((prev) => Math.min(mediaList.length - 1, prev + 1));
                      }}
                      aria-label="查看下一张截图"
                    >
                      <ChevronRight size={18} aria-hidden="true" />
                    </button>
                  </>
                ) : null}
              </div>

              {/* 缩略图横向滑轨 */}
              {mediaList.length > 1 ? (
                <div className="order-dossier-thumb-strip" role="tablist" aria-label="截图缩略图列表">
                  {mediaList.map((m, idx) => (
                    <button
                      key={m.assetId || idx}
                      type="button"
                      className={`order-dossier-thumb-btn ${idx === activeImageIdx ? "is-active" : ""}`}
                      onClick={() => setActiveImageIdx(idx)}
                      aria-label={`切换到第 ${idx + 1} 张截图`}
                      aria-selected={idx === activeImageIdx}
                    >
                      <LegacyAccountImage
                        src={m.url}
                        alt=""
                        className="order-dossier-thumb-img"
                        loading="lazy"
                      />
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : (
            <div className="order-dossier-no-media">
              <AccountMediaPlaceholder state="UNAVAILABLE" className="order-dossier-empty-placeholder" />
            </div>
          )}
        </div>

        {/* 右侧/下方：账号核心规格与外观 */}
        <div className="order-dossier-info-col">
          {/* 统一属性网格 */}
          <div className="order-dossier-unified-specs">
            {safeBox ? (
              <div className="order-dossier-spec-pill highlight">
                <span className="spec-pill-label">安全箱</span>
                <strong className="spec-pill-val">{safeBox}</strong>
              </div>
            ) : null}
            {grading ? (
              <div className="order-dossier-spec-pill">
                <span className="spec-pill-label">段位</span>
                <strong className="spec-pill-val">{grading}</strong>
              </div>
            ) : null}
            {charLevel ? (
              <div className="order-dossier-spec-pill">
                <span className="spec-pill-label">角色等级</span>
                <strong className="spec-pill-val">{charLevel.endsWith("级") ? charLevel : `${charLevel} 级`}</strong>
              </div>
            ) : null}
            {secretKd ? (
              <div className="order-dossier-spec-pill">
                <span className="spec-pill-label">绝密 KD</span>
                <strong className="spec-pill-val">{secretKd}</strong>
              </div>
            ) : null}
            {loginMethod ? (
              <div className="order-dossier-spec-pill">
                <span className="spec-pill-label">上号方式</span>
                <strong className="spec-pill-val">{loginMethod}</strong>
              </div>
            ) : null}
            {regionText ? (
              <div className="order-dossier-spec-pill">
                <span className="spec-pill-label">地区</span>
                <strong className="spec-pill-val">{regionText}</strong>
              </div>
            ) : null}
            {vitLevel ? (
              <div className="order-dossier-spec-pill">
                <span className="spec-pill-label">体力等级</span>
                <strong className="spec-pill-val">{vitLevel.endsWith("级") ? vitLevel : `${vitLevel} 级`}</strong>
              </div>
            ) : null}
            {bearLevel ? (
              <div className="order-dossier-spec-pill">
                <span className="spec-pill-label">负重等级</span>
                <strong className="spec-pill-val">{bearLevel.endsWith("级") ? bearLevel : `${bearLevel} 级`}</strong>
              </div>
            ) : null}
            {diveLevel ? (
              <div className="order-dossier-spec-pill">
                <span className="spec-pill-label">潜水等级</span>
                <strong className="spec-pill-val">{diveLevel.endsWith("级") ? diveLevel : `${diveLevel} 级`}</strong>
              </div>
            ) : null}
          </div>

          {/* 分组 3：外观与收藏品（若有） */}
          {data.skinTags && data.skinTags.length > 0 ? (
            <div className="order-dossier-spec-section">
              <h4 className="order-dossier-section-title">
                极品外观与收藏品 ({data.skinTags.length})
              </h4>
              <div className="order-dossier-skins-list">
                {data.skinTags.map((skin) => (
                  <div key={skin.id} className="order-dossier-skin-tag">
                    {skin.categoryName ? (
                      <span className="skin-tag-category">{skin.categoryName}</span>
                    ) : null}
                    <span className="skin-tag-name">{skin.name}</span>
                    {skin.rarityName ? (
                      <span className="skin-tag-rarity" data-rarity={skin.rarityCode}>
                        {skin.rarityName}
                      </span>
                    ) : null}
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {/* 分组 4：关联在架物资与资源（若有） */}
          {displayResources.length > 0 ? (
            <div className="order-dossier-spec-section order-dossier-resources-section">
              <h4 className="order-dossier-section-title">当前公开账号资源</h4>
              <div className="order-dossier-resource-chips">
                {displayResources.map((res) => {
                  const isHaff = res.code === "haff_base" || res.name?.includes("哈夫币");
                  return (
                    <div key={res.code} className={`order-dossier-resource-chip${isHaff ? " is-haff" : ""}`}>
                      <span className="resource-chip-name">{res.name}：</span>
                      <strong className="resource-chip-val">{res.value}</strong>
                    </div>
                  );
                })}
              </div>
            </div>
          ) : null}

          {/* 分组 4：安全信用与服务时间 */}
          <div className="order-dossier-spec-section order-dossier-trust-section">
            <h4 className="order-dossier-section-title">号主声明与服务时间</h4>
            <div className="order-dossier-trust-badges">
              <div className="order-dossier-trust-item">
                <Shield size={13} className="trust-icon" aria-hidden="true" />
                <span>{data.faceIsSelf === true ? "号主声明本人脸" : data.faceIsSelf === false ? "号主声明非本人脸" : "人脸声明未提供"}</span>
              </div>
              <div className="order-dossier-trust-item">
                <Shield size={13} className="trust-icon" aria-hidden="true" />
                <span>{data.banRecord === true ? "号主声明有封禁记录" : data.banRecord === false ? "号主声明无封禁记录" : "封禁记录声明未提供"}</span>
              </div>
              {serviceWindow ? (
                <div className="order-dossier-trust-item">
                  <Clock size={13} className="trust-icon" aria-hidden="true" />
                  <span>配合上号：{serviceWindow}</span>
                </div>
              ) : null}
            </div>
          </div>
        </div>
      </div>

      {/* Lightbox 全屏沉浸式大图预览 Modal */}
      {lightboxOpen && mediaList.length > 0 && typeof document !== "undefined"
        ? createPortal(
            <div
              className="order-dossier-lightbox-overlay"
              onClick={() => setLightboxOpen(false)}
              role="dialog"
              aria-modal="true"
              aria-label="账号实机大图预览"
            >
              <div className="order-dossier-lightbox-content" onClick={(e) => e.stopPropagation()}>
                <div className="order-dossier-lightbox-topbar">
                  <span className="order-dossier-lightbox-count">
                    {activeImageIdx + 1} / {mediaList.length}
                  </span>
                  <button
                    type="button"
                    className="order-dossier-lightbox-close"
                    onClick={() => setLightboxOpen(false)}
                    aria-label="关闭原图预览"
                  >
                    <X size={20} aria-hidden="true" />
                  </button>
                </div>

                <div className="order-dossier-lightbox-stage">
                  {mediaList.length > 1 ? (
                    <button
                      type="button"
                      className="order-lightbox-arrow prev"
                      disabled={activeImageIdx === 0}
                      onClick={() => setActiveImageIdx((prev) => Math.max(0, prev - 1))}
                      aria-label="上一张"
                    >
                      <ChevronLeft size={28} aria-hidden="true" />
                    </button>
                  ) : null}

                  <div className="order-lightbox-img-box">
                    <LegacyAccountImage
                      src={mediaList[activeImageIdx]?.url ?? null}
                      alt={`账号原图 第 ${activeImageIdx + 1} 张`}
                      className="order-lightbox-img"
                    />
                  </div>

                  {mediaList.length > 1 ? (
                    <button
                      type="button"
                      className="order-lightbox-arrow next"
                      disabled={activeImageIdx === mediaList.length - 1}
                      onClick={() => setActiveImageIdx((prev) => Math.min(mediaList.length - 1, prev + 1))}
                      aria-label="下一张"
                    >
                      <ChevronRight size={28} aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
              </div>
            </div>,
            document.body
          )
        : null}
    </section>
  );
}
