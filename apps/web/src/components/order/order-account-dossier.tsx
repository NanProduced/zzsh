"use client";

import { useEffect, useState, useCallback, useRef } from "react";
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
  CheckCircle2,
  Sparkles,
  Clock,
  ExternalLink,
  ImageOff,
  Dumbbell,
  ShieldAlert,
} from "lucide-react";
import { LegacyAccountImage } from "@zzsh/ui/legacy-account-image";
import { supplyApi, SupplyRequestError } from "@/lib/supply-client";
import { toListingDetail, type ListingDetailData } from "@/lib/listing-view";
import type { OrderListingFacts, OrderParty } from "@/lib/order-client";

type DossierState =
  | { status: "loading" }
  | { status: "ready"; data: ListingDetailData }
  | { status: "fallback" };

export function OrderAccountDossier({
  accountId,
  accountDisplayNo,
  party,
  listingFacts,
}: {
  accountId?: string | null;
  accountDisplayNo?: string | null;
  party: OrderParty;
  listingFacts?: OrderListingFacts | null;
}) {
  const [state, setState] = useState<DossierState>({ status: "loading" });
  const [activeImageIdx, setActiveImageIdx] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const lightboxIdxRef = useRef(activeImageIdx);
  lightboxIdxRef.current = activeImageIdx;

  // Load listing details
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });

    const fetcher = accountId
      ? supplyApi.listing(accountId, controller.signal)
      : accountDisplayNo
      ? supplyApi.lookupListing(accountDisplayNo, null, controller.signal)
      : Promise.reject(new Error("No account identifier provided"));

    fetcher
      .then((listing) => {
        if (!controller.signal.aborted) {
          setState({ status: "ready", data: toListingDetail(listing) });
        }
      })
      .catch((_err) => {
        if (!controller.signal.aborted) {
          setState({ status: "fallback" });
        }
      });

    return () => controller.abort();
  }, [accountId, accountDisplayNo]);

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
  if (state.status === "fallback" || (!accountId && !accountDisplayNo)) {
    const safeBox = listingFacts?.attributeDisplay?.safeBox;
    const grading = listingFacts?.attributeDisplay?.grading;
    const loginMethod = listingFacts?.attributeDisplay?.loginMethod;
    if (!safeBox && !grading && !loginMethod) return null;

    return (
      <section className="account-module-card order-account-dossier-card">
        <div className="account-module-card-header order-dossier-header">
          <div className="order-dossier-header-title">
            <span className="order-dossier-tag">账号档案</span>
            <h3>关联游戏账号基本规格</h3>
          </div>
          {accountDisplayNo ? (
            <span className="order-dossier-acc-badge">编号：{accountDisplayNo}</span>
          ) : null}
        </div>
        <div className="order-dossier-specs-grid">
          {safeBox ? (
            <div className="order-dossier-spec-item">
              <span className="dossier-spec-label"><Shield size={13} aria-hidden="true" /> 安全箱</span>
              <strong className="dossier-spec-value">{safeBox}</strong>
            </div>
          ) : null}
          {grading ? (
            <div className="order-dossier-spec-item">
              <span className="dossier-spec-label"><Gamepad2 size={13} aria-hidden="true" /> 游戏段位</span>
              <strong className="dossier-spec-value">{grading}</strong>
            </div>
          ) : null}
          {loginMethod ? (
            <div className="order-dossier-spec-item">
              <span className="dossier-spec-label"><LogIn size={13} aria-hidden="true" /> 上号方式</span>
              <strong className="dossier-spec-value">{loginMethod}</strong>
            </div>
          ) : null}
        </div>
      </section>
    );
  }

  if (state.status === "loading") {
    return (
      <section className="account-module-card order-account-dossier-card is-loading" aria-busy="true">
        <div className="order-dossier-loading-text">
          <Gamepad2 size={16} className="animate-spin" aria-hidden="true" />
          <span>正在获取游戏账号完整档案与实机截图…</span>
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

  const safeBox = conditionMap.get("safe_box_code") || listingFacts?.attributeDisplay?.safeBox;
  const grading = conditionMap.get("grading_code") || listingFacts?.attributeDisplay?.grading;
  const charLevel = conditionMap.get("character_level");
  const secretKd = conditionMap.get("secret_kd");
  const loginMethod = conditionMap.get("login_method_code") || listingFacts?.attributeDisplay?.loginMethod;
  const province = conditionMap.get("region_province");
  const city = conditionMap.get("region_city");
  const regionText = province && city ? `${province} · ${city}` : province || city;
  const vitLevel = conditionMap.get("vit_level");
  const bearLevel = conditionMap.get("bear_level");
  const diveLevel = conditionMap.get("dive_level");
  const serviceWindow = conditionMap.get("service_window");

  // Public target link
  const publicHref = targetAccId
    ? party === "owner"
      ? `/account?view=accounts&accountId=${encodeURIComponent(targetAccId)}`
      : `/accounts/${encodeURIComponent(targetAccId)}`
    : null;

  return (
    <section className="account-module-card order-account-dossier-card" aria-label="关联账号完整档案">
      {/* 区分明确的卡片 Header */}
      <div className="order-dossier-header">
        <div className="order-dossier-header-title">
          <span className="order-dossier-tag">
            <Gamepad2 size={13} aria-hidden="true" />
            账号完整档案
          </span>
          <div className="order-dossier-title-text">
            <h3>{data.displayNo ? `账号 ${data.displayNo}` : "游戏账号规格"}</h3>
            <span className="order-dossier-game-name">三角洲行动 · 角色与外观资产</span>
          </div>
        </div>
        {publicHref ? (
          <Link className="order-dossier-public-link" href={publicHref} scroll={false}>
            <span>{party === "owner" ? "管理本人账号" : "查看账号公开主页"}</span>
            <ExternalLink size={13} aria-hidden="true" />
          </Link>
        ) : null}
      </div>

      <div className="order-dossier-body">
        {/* 左侧/上方：账号实机截图相册 */}
        <div className="order-dossier-gallery-col">
          <div className="order-dossier-gallery-title">
            <h4>实机展示截图 ({mediaList.length} 张)</h4>
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
                  alt={`账号实机截图 第 ${activeImageIdx + 1} 张`}
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
              <ImageOff size={24} aria-hidden="true" />
              <span>号主暂未上传实机截图</span>
            </div>
          )}
        </div>

        {/* 右侧/下方：账号核心规格与外观 */}
        <div className="order-dossier-info-col">
          {/* 分组 1：核心游戏参数 */}
          <div className="order-dossier-spec-section">
            <h4 className="order-dossier-section-title">核心战力与上号方式</h4>
            <div className="order-dossier-specs-grid">
              {safeBox ? (
                <div className="order-dossier-spec-card">
                  <div className="dossier-card-icon"><Shield size={14} aria-hidden="true" /></div>
                  <div className="dossier-card-meta">
                    <span className="dossier-card-label">安全箱规格</span>
                    <strong className="dossier-card-val highlight">{safeBox}</strong>
                  </div>
                </div>
              ) : null}
              {grading ? (
                <div className="order-dossier-spec-card">
                  <div className="dossier-card-icon"><Gamepad2 size={14} aria-hidden="true" /></div>
                  <div className="dossier-card-meta">
                    <span className="dossier-card-label">游戏段位</span>
                    <strong className="dossier-card-val">{grading}</strong>
                  </div>
                </div>
              ) : null}
              {charLevel ? (
                <div className="order-dossier-spec-card">
                  <div className="dossier-card-icon"><User size={14} aria-hidden="true" /></div>
                  <div className="dossier-card-meta">
                    <span className="dossier-card-label">角色等级</span>
                    <strong className="dossier-card-val">{charLevel}</strong>
                  </div>
                </div>
              ) : null}
              {secretKd ? (
                <div className="order-dossier-spec-card">
                  <div className="dossier-card-icon"><Crosshair size={14} aria-hidden="true" /></div>
                  <div className="dossier-card-meta">
                    <span className="dossier-card-label">绝密 KD</span>
                    <strong className="dossier-card-val">{secretKd}</strong>
                  </div>
                </div>
              ) : null}
              {loginMethod ? (
                <div className="order-dossier-spec-card">
                  <div className="dossier-card-icon"><LogIn size={14} aria-hidden="true" /></div>
                  <div className="dossier-card-meta">
                    <span className="dossier-card-label">上号方式</span>
                    <strong className="dossier-card-val">{loginMethod}</strong>
                  </div>
                </div>
              ) : null}
              {regionText ? (
                <div className="order-dossier-spec-card">
                  <div className="dossier-card-icon"><MapPin size={14} aria-hidden="true" /></div>
                  <div className="dossier-card-meta">
                    <span className="dossier-card-label">游戏地区</span>
                    <strong className="dossier-card-val">{regionText}</strong>
                  </div>
                </div>
              ) : null}
            </div>
          </div>

          {/* 分组 2：体能等级三维属性 */}
          {(vitLevel || bearLevel || diveLevel) ? (
            <div className="order-dossier-spec-section">
              <h4 className="order-dossier-section-title">体能三维等级</h4>
              <div className="order-dossier-triple-grid">
                {vitLevel ? (
                  <div className="order-dossier-subspec-chip">
                    <Dumbbell size={13} aria-hidden="true" />
                    <span>体力等级</span>
                    <strong>{vitLevel}</strong>
                  </div>
                ) : null}
                {bearLevel ? (
                  <div className="order-dossier-subspec-chip">
                    <Shield size={13} aria-hidden="true" />
                    <span>负重等级</span>
                    <strong>{bearLevel}</strong>
                  </div>
                ) : null}
                {diveLevel ? (
                  <div className="order-dossier-subspec-chip">
                    <Sparkles size={13} aria-hidden="true" />
                    <span>潜水等级</span>
                    <strong>{diveLevel}</strong>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

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

          {/* 分组 4：安全信用与服务时间 */}
          <div className="order-dossier-spec-section order-dossier-trust-section">
            <h4 className="order-dossier-section-title">安全认证与交付约定</h4>
            <div className="order-dossier-trust-badges">
              <div className="order-dossier-trust-item">
                <CheckCircle2 size={13} className="trust-icon success" aria-hidden="true" />
                <span>{data.faceIsSelf ? "号主声明本人脸" : "人脸认证已审核"}</span>
              </div>
              <div className="order-dossier-trust-item">
                <CheckCircle2 size={13} className="trust-icon success" aria-hidden="true" />
                <span>{data.banRecord ? "存在封禁提示" : "号主声明无封禁记录"}</span>
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
