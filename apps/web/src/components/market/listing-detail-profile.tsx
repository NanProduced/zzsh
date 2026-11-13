"use client";

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import * as Dialog from "@radix-ui/react-dialog";
import { Toast } from "@heroui/react/toast";
import {
  ArrowLeft,
  Box,
  CalendarDays,
  Check,
  Clock3,
  Coins,
  Copy,
  Gamepad2,
  Info,
  LogIn,
  Share2,
  Shield,
  ShieldAlert,
  X,
  Zap,
} from "lucide-react";
import { accountHref } from "@/components/delta/account-card";
import { FavoriteButton } from "@/components/favorites/favorite-button";
import { deriveDetailTitle, parseRank, parseSafeBox } from "@/lib/account-title";
import { orderUrl } from "@/lib/order-client";
import type { ListingDetailData } from "@/lib/listing-view";
import { DetailGallery, DetailImage } from "./listing-detail-gallery";
import { displayTime, loginMethodText, presentedCondition, regionValue } from "./listing-detail-format";

export function ListingDetailHeading({ data, fromOrder }: { data: ListingDetailData; fromOrder?: string }) {
  const number = data.displayNo?.trim() || null;
  const copyTarget = JSON.stringify([data.id, number]);
  const copyTargetRef = useRef<string | null>(copyTarget);
  const copySequence = useRef(0);
  const pendingCopies = useRef(new Map<"number" | "link", number>());
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [copyFeedback, setCopyFeedback] = useState<{ target: string; action: "number" | "link"; ok: boolean } | null>(null);
  const [copyQueue] = useState(() => new Toast.Queue({ maxVisibleToasts: 1, wrapUpdate: (update) => update() }));
  const title = deriveDetailTitle(data);
  const availability = data.historicalReadOnly
    ? "资料暂不可租"
    : data.availabilityLabel ?? (data.canCreateOrder === false ? "暂不可租" : null);
  const fast = !data.historicalReadOnly && data.canCreateOrder !== false && data.rentalMode === "fast";
  const displayedAt = data.historicalReadOnly ? data.sourceUpdatedAt : data.publishedAt;
  const published = displayTime(displayedAt);

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

  return (
    <>
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
      {fromOrder ? <div className="account-order-return">
        <Link href={orderUrl("renter", "", data.id, fromOrder)} scroll={false}><ArrowLeft size={15} aria-hidden="true" />返回订单</Link>
        <span>正在查看订单关联的账号资料</span>
      </div> : null}
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
    </>
  );
}

export function ListingDetailFacts({ data }: { data: ListingDetailData }) {
  const [penaltyModalOpen, setPenaltyModalOpen] = useState(false);
  const penaltyTriggerRef = useRef<HTMLButtonElement>(null);
  const [noteExpanded, setNoteExpanded] = useState(false);
  const noteRef = useRef<HTMLParagraphElement>(null);
  const [canExpandNote, setCanExpandNote] = useState(false);
  const title = deriveDetailTitle(data);
  const availability = data.historicalReadOnly
    ? "资料暂不可租"
    : data.availabilityLabel ?? (data.canCreateOrder === false ? "暂不可租" : null);
  const value = (key: string) => presentedCondition(data, key);
  const rankInfo = parseRank(value("grading_code"));
  const loginInfo = loginMethodText(data);
  const safeBox = parseSafeBox(value("safe_box_code"));
  const vitValue = value("vit_level");
  const bearValue = value("bear_level");
  const levelValue = value("character_level");
  const secretKdValue = value("secret_kd");
  const diveValue = value("dive_level");
  const regionText = regionValue(data);
  const penalties = data.media.filter((item) => item.category === "PENALTY");
  const faceValue = data.faceIsSelf === true ? "号主声明本人脸" : data.faceIsSelf === false ? "号主声明非本人脸" : "未提供";
  const penaltyDeclaredText = data.banRecord === true ? (penalties.length > 0 ? `号主声明有封禁记录 · 公示图 ${penalties.length} 张` : "号主声明有封禁记录 · 公示图未提供") : data.banRecord === false ? "号主声明无封禁记录" : "未提供";
  const hasGallery = data.media.some((item) => item.category !== "PENALTY");

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

  return (
    <>
      <section className="account-overview account-hero-section" aria-label="图片与基本信息">
        <div className={`account-detail-gallery${hasGallery ? "" : " account-detail-gallery--empty"}`}>
          {hasGallery ? <h2 className="sr-only">账号图片</h2> : null}
          <DetailGallery title={title.primary} media={data.media} legacyEmpty={data.historicalReadOnly} />
          {hasGallery ? <p className="account-media-caption">号主提供 · 点击图片查看大图</p> : null}
        </div>

        <div className="account-hero-attributes">
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

      <div className="account-mobile-quote-strip" role="region" aria-label="费用概览">
        <div className="account-mobile-quote-inner">
          <div className="account-mobile-quote-amount">
            <span className="account-mobile-quote-label">
              {data.historicalReadOnly ? "来源记录费用" : "参考费用 · 押金另核"}
            </span>
            <strong>{(data.historicalReadOnly ? data.payableTotalLabel ?? data.resourceTotalLabel : data.resourceTotalLabel) ?? "以平台确认为准"}</strong>
          </div>
          <div className="account-mobile-quote-status">
            {availability ? <span className="account-detail-status">{availability}</span> : null}
            <a href="#account-quote-anchor" className="account-mobile-quote-jump">
              查看报价明细 &gt;
            </a>
          </div>
        </div>
      </div>

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
    </>
  );
}
