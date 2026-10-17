"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import useEmblaCarousel from "embla-carousel-react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, ArrowRight, ChevronLeft, ChevronRight, Clock3, Crown, Lock, Percent, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import type { EntitlementKind, EntitlementState, GrowthTier, MembershipGrowthData, MembershipGrowthViewState, MembershipPointEvent } from "@/lib/membership-growth-client";
import { Progress } from "../ui/progress";
import "./membership-center.css";

export const GROWTH_TIER_LABELS: Record<GrowthTier, string> = {
  STANDARD: "普通会员",
  SILVER: "银卡会员",
  GOLD: "金卡会员",
  PLATINUM: "铂金会员",
  DIAMOND: "钻石会员",
  BLACK_GOLD: "黑金会员 · 终身",
  UNKNOWN: "资格待确认",
};

export const GROWTH_TIER_EN_LABELS: Record<GrowthTier, string> = {
  STANDARD: "REGULAR MEMBER",
  SILVER: "SILVER MEMBER",
  GOLD: "GOLD MEMBER",
  PLATINUM: "PLATINUM MEMBER",
  DIAMOND: "DIAMOND MEMBER",
  BLACK_GOLD: "BLACK GOLD MEMBER",
  UNKNOWN: "MEMBER CARD",
};

export const TIER_ORDER = ["STANDARD", "SILVER", "GOLD", "PLATINUM", "DIAMOND", "BLACK_GOLD"] as const;
export type TrackTier = (typeof TIER_ORDER)[number];

export const TIER_THRESHOLDS: Record<TrackTier, string> = {
  STANDARD: "0",
  SILVER: "5000",
  GOLD: "10000",
  PLATINUM: "20000",
  DIAMOND: "40000",
  BLACK_GOLD: "50000",
};

const TIER_SHORT: Record<TrackTier, string> = {
  STANDARD: "普通",
  SILVER: "银卡",
  GOLD: "金卡",
  PLATINUM: "铂金",
  DIAMOND: "钻石",
  BLACK_GOLD: "黑金·终身",
};

const benefitName = (tier: TrackTier): string => (tier === "BLACK_GOLD" ? "黑金" : TIER_SHORT[tier]);

const COMPARISON_LABEL_TO_TIER: Record<string, TrackTier> = {
  普通会员: "STANDARD",
  银卡会员: "SILVER",
  金卡会员: "GOLD",
  铂金会员: "PLATINUM",
  钻石会员: "DIAMOND",
};

const ENTITLEMENT_STATE_LABELS: Record<EntitlementState, string> = {
  PENDING: "待审批",
  APPROVED_PENDING_EXECUTION: "审批通过，待执行",
  EXECUTED_PENDING_START: "待生效",
  ACTIVE: "生效中",
  EXPIRED: "已到期",
  REPLACED: "已替换",
  REVOKED: "已撤销",
  UNKNOWN: "状态待确认",
};

export const TIER_CARD_IMAGE: Record<GrowthTier, string | null> = {
  STANDARD: "/art/membership/a-metal/standard-card.webp",
  SILVER: "/art/membership/a-metal/silver-card.webp",
  GOLD: "/art/membership/a-metal/gold-card.webp",
  PLATINUM: "/art/membership/a-metal/platinum-card.webp",
  DIAMOND: "/art/membership/a-metal/diamond-card.webp",
  BLACK_GOLD: "/art/membership/a-metal/black-gold-card.webp",
  UNKNOWN: null,
};

const TIER_CARD_SQUARE: Record<TrackTier, string> = {
  STANDARD: "/art/membership/b-ceramic-square/standard-card.webp",
  SILVER: "/art/membership/b-ceramic-square/silver-card.webp",
  GOLD: "/art/membership/b-ceramic-square/gold-card.webp",
  PLATINUM: "/art/membership/b-ceramic-square/platinum-card.webp",
  DIAMOND: "/art/membership/b-ceramic-square/diamond-card.webp",
  BLACK_GOLD: "/art/membership/b-ceramic-square/black-gold-card.webp",
};

export const ENTITLEMENT_BADGE_IMAGE: Record<EntitlementKind, string | null> = {
  FRIEND: "/art/membership/friend-badge.webp",
  PRESTIGE: "/art/membership/prestige-badge.webp",
  UNKNOWN: null,
};

const EDGE_DROP = 26;

function tierClass(tier: GrowthTier): string {
  return `tier-${tier.toLowerCase().replace("_", "-")}`;
}

export function formatScopeName(scope: string): string {
  if (scope === "ALL_PLATFORM") return "全平台适用";
  if (scope === "DELTA_ACCOUNT_RENTAL" || scope.includes("DELTA")) return "三角洲租赁";
  return "范围待确认";
}

function formatBeijingDate(value: string | null): string {
  if (!value) return "待确认";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "待确认";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(date).replace(/\//g, ".");
}

function formatBeijingDateTime(value: string | null): string {
  if (!value) return "待确认";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "待确认";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", dateStyle: "medium", timeStyle: "short" }).format(date);
}

function groupDigits(value: string): string {
  if (!/^-?\d+$/.test(value)) return value;
  const negative = value.startsWith("-");
  const grouped = (negative ? value.slice(1) : value).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return negative ? `-${grouped}` : grouped;
}

function signedPoints(value: string): string {
  if (!/^-?\d+$/.test(value)) return value;
  return value.startsWith("-") ? `−${groupDigits(value.slice(1))}` : `+${groupDigits(value)}`;
}

function pointsGap(points: string, threshold: string): string | null {
  if (!/^\d+$/.test(points) || !/^\d+$/.test(threshold)) return null;
  const gap = BigInt(threshold) - BigInt(points);
  return groupDigits((gap > 0n ? gap : 0n).toString());
}

function pointsPercent(points: string, threshold: string): number | null {
  if (!/^\d+$/.test(points) || !/^\d+$/.test(threshold) || threshold === "0") return null;
  const percent = (BigInt(points) * 100n) / BigInt(threshold);
  return Number(percent > 100n ? 100n : percent);
}

function yuanFromCents(value: string): string {
  if (!/^-?\d+$/.test(value)) return "待确认";
  const negative = value.startsWith("-");
  const padded = (negative ? value.slice(1) : value).padStart(3, "0");
  return `${negative ? "-" : ""}¥${groupDigits(padded.slice(0, -2))}.${padded.slice(-2)}`;
}

function useMediaState(query: string, initial: boolean): boolean {
  const [matches, setMatches] = useState(initial);
  useEffect(() => {
    const media = matchMedia(query);
    const sync = () => setMatches(media.matches);
    sync();
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, [query]);
  return matches;
}

export function GrowthMemberCardArt({ tier }: { tier: GrowthTier | null }) {
  const safeTier = tier ?? "UNKNOWN";
  const enLabel = GROWTH_TIER_EN_LABELS[safeTier] ?? "MEMBER CARD";
  const zhLabel = safeTier === "BLACK_GOLD" ? "黑金会员 · 终身" : (tier ? (GROWTH_TIER_LABELS[tier] ?? "会员身份") : "会员身份");
  const cardImageSrc = tier ? TIER_CARD_IMAGE[tier] : null;
  const [imageFailed, setImageFailed] = useState(false);
  const [currentTier, setCurrentTier] = useState(tier);

  if (currentTier !== tier) {
    setCurrentTier(tier);
    setImageFailed(false);
  }

  const showImage = Boolean(cardImageSrc && !imageFailed);

  return (
    <div
      className={`membership-card card-tier-${safeTier.toLowerCase().replace("_", "-")}${showImage ? " has-card-art" : ""}`}
      data-testid="membership-card"
      data-tier={tier ?? undefined}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          key={cardImageSrc!}
          src={cardImageSrc!}
          alt=""
          aria-hidden="true"
          className="membership-card-img"
          width={1020}
          height={600}
          onError={() => setImageFailed(true)}
        />
      ) : (
        <div className="membership-card-fallback-content">
          <div className="membership-card-top">
            <span className="membership-card-brand">洲洲商行</span>
            <span className="membership-card-slogan">以行致远 · 汇聚美好</span>
          </div>
          <div className="membership-card-mid">
            <span className="membership-card-en">{enLabel}</span>
          </div>
          <div className="membership-card-bot">
            {safeTier === "BLACK_GOLD" ? <span className="membership-card-infinity">∞</span> : null}
            <span className="membership-card-level">{zhLabel}</span>
          </div>
          <div className="membership-card-emboss" aria-hidden="true" />
        </div>
      )}
    </div>
  );
}

export function EntitlementBadge({ kind, label, size = 32 }: { kind: EntitlementKind; label: string; size?: number }) {
  const badgeSrc = ENTITLEMENT_BADGE_IMAGE[kind];
  const [imageFailed, setImageFailed] = useState(false);
  const [prevSrc, setPrevSrc] = useState(badgeSrc);
  if (prevSrc !== badgeSrc) {
    setPrevSrc(badgeSrc);
    setImageFailed(false);
  }
  const showImage = Boolean(badgeSrc && !imageFailed);
  return (
    <span className="account-entitlement-badge-wrap" aria-hidden="true">
      {showImage ? (
        <img
          key={badgeSrc!}
          src={badgeSrc!}
          alt={label}
          aria-hidden="true"
          className="account-entitlement-badge-img"
          width={size}
          height={size}
          onError={() => setImageFailed(true)}
        />
      ) : (
        <span className="account-entitlement-badge-icon" aria-hidden="true">
          <Sparkles size={Math.round(size / 2)} />
        </span>
      )}
    </span>
  );
}

function StateMessage({ state, onRetry }: { state: Exclude<MembershipGrowthViewState, { status: "ready" }>; onRetry?: () => void }) {
  const copy = state.status === "loading" ? "正在读取成长档案" : state.status === "permission" ? "当前身份没有查看成长档案的权限" : state.message;
  return (
    <div className="mc-state" data-state={state.status} role={state.status === "error" ? "alert" : "status"} aria-busy={state.status === "loading" || undefined}>
      <span className="mc-state-icon" aria-hidden="true">{state.status === "loading" ? <Clock3 size={22} /> : state.status === "permission" ? <ShieldCheck size={22} /> : <AlertTriangle size={22} />}</span>
      <div>
        <strong>{state.status === "loading" ? "成长档案" : state.status === "permission" ? "无法查看" : "成长档案暂不可用"}</strong>
        <p>{copy}</p>
      </div>
      {state.status === "error" && state.retryable && onRetry ? (
        <button type="button" className="mc-button" data-testid="retry-membership-center" onClick={onRetry}>
          <RefreshCw size={14} aria-hidden="true" />重试
        </button>
      ) : null}
    </div>
  );
}


type TargetSummary = {
  headline: string | null;
  value: string | null;
  note: string | null;
  progress: { label: string; detail: string; percent: number } | null;
};

function targetSummary(selected: TrackTier, actual: TrackTier | null, data: MembershipGrowthData): TargetSummary {
  const browsing = null;
  if (selected === "BLACK_GOLD") {
    const percent = pointsPercent(data.lifetimePoints, TIER_THRESHOLDS.BLACK_GOLD);
    return {
      headline: actual === "BLACK_GOLD" ? "累计成长" : "累计成长门槛",
      value: actual === "BLACK_GOLD" ? groupDigits(data.lifetimePoints) : groupDigits(TIER_THRESHOLDS.BLACK_GOLD),
      note: actual === "BLACK_GOLD" ? "终身资格已保留，停止消费不会降级" : "累计达标即获终身资格",
      progress: percent === null ? null : { label: "累计成长进度", detail: `${groupDigits(data.lifetimePoints)} / ${groupDigits(TIER_THRESHOLDS.BLACK_GOLD)}`, percent },
    };
  }
  const threshold = TIER_THRESHOLDS[selected];
  if (selected === actual) {
    if (!data.nextTier) return { headline: null, value: null, note: selected === "STANDARD" ? "普通等级不设成长门槛" : "当前成长档位已确认", progress: null };
    const percent = pointsPercent(data.rollingPoints, data.nextTier.threshold);
    return {
      headline: `距${TIER_SHORT[data.nextTier.tier]}还差`,
      value: groupDigits(data.nextTier.remaining),
      note: null,
      progress: percent === null ? null : { label: `升级${TIER_SHORT[data.nextTier.tier]}进度`, detail: `${groupDigits(data.rollingPoints)} / ${groupDigits(data.nextTier.threshold)}`, percent },
    };
  }
  if (selected === "STANDARD") {
    return { headline: null, value: null, note: "普通等级不设成长门槛", progress: null };
  }
  const actualIndex = actual ? TIER_ORDER.indexOf(actual) : -1;
  const percent = pointsPercent(data.rollingPoints, threshold);
  const progress = percent === null ? null : { label: `${TIER_SHORT[selected]}门槛进度`, detail: `${groupDigits(data.rollingPoints)} / ${groupDigits(threshold)}`, percent };
  if (actualIndex >= 0 && TIER_ORDER.indexOf(selected) > actualIndex) {
    return { headline: `达到${TIER_SHORT[selected]}还差`, value: pointsGap(data.rollingPoints, threshold) ?? "待确认", note: browsing, progress };
  }
  return { headline: `${TIER_SHORT[selected]}门槛`, value: groupDigits(threshold), note: browsing, progress };
}

function TierTrack({ actual, selected, onSelect, reduced, visible }: { actual: TrackTier | null; selected: TrackTier; onSelect: (tier: TrackTier) => void; reduced: boolean; visible: number }) {
  const [viewportRef, emblaApi] = useEmblaCarousel({ align: "start", loop: false, containScroll: false });
  const selectedIndex = TIER_ORDER.indexOf(selected);
  const ghost = 2;
  const snapOffset = ghost - Math.floor(visible / 2);
  const lastSnap = snapOffset + TIER_ORDER.length - 1;
  const groupRef = useRef<HTMLDivElement>(null);
  const focusPending = useRef(false);
  const selectionRef = useRef(selectedIndex);
  selectionRef.current = selectedIndex;

  useEffect(() => {
    if (!emblaApi) return;
    const sync = () => {
      const snap = emblaApi.selectedScrollSnap();
      if (snap < snapOffset || snap > lastSnap) {
        emblaApi.scrollTo(Math.min(Math.max(snap, snapOffset), lastSnap), true);
        return;
      }
      const tier = TIER_ORDER[snap - snapOffset];
      if (tier && tier !== selected) onSelect(tier);
    };
    emblaApi.on("select", sync);
    return () => {
      emblaApi.off("select", sync);
    };
  }, [emblaApi, onSelect, selected, snapOffset, lastSnap]);

  useEffect(() => {
    if (!emblaApi) return;
    emblaApi.reInit();
    emblaApi.scrollTo(selectionRef.current + snapOffset, true);
  }, [emblaApi, visible, snapOffset]);

  useEffect(() => {
    if (!emblaApi) return;
    const target = selectedIndex + snapOffset;
    if (emblaApi.selectedScrollSnap() === target) return;
    emblaApi.scrollTo(target, reduced);
  }, [emblaApi, selectedIndex, snapOffset, reduced]);

  useEffect(() => {
    if (!focusPending.current) return;
    focusPending.current = false;
    groupRef.current?.querySelector<HTMLElement>(`.mc-node[data-tier="${selected}"]`)?.focus({ preventScroll: true });
  }, [selected]);

  useEffect(() => {
    if (!emblaApi) return;
    const curve = EDGE_DROP / Math.pow(0.5 - 0.5 / visible, 2);
    const arcDrop = curve * 0.25;
    // Follow the rendered scroll position, not the destination snap, so dots stay on the arc while dragging.
    const paint = () => {
      const snaps = emblaApi.scrollSnapList();
      const first = snaps[snapOffset];
      const next = snaps[snapOffset + 1];
      if (first === undefined || next === undefined) return;
      const step = next - first;
      if (!step) return;
      const centerIndex = ghost + (emblaApi.scrollProgress() - first) / step;
      emblaApi.slideNodes().forEach((node, index) => {
        const distance = index - centerIndex;
        const offset = distance / visible;
        node.style.setProperty("--mc-node-y", `${(arcDrop - curve * offset * offset).toFixed(2)}px`);
        node.style.setProperty("--mc-focus", Math.max(0, 1 - Math.abs(distance)).toFixed(3));
      });
    };
    paint();
    emblaApi.on("scroll", paint);
    emblaApi.on("reInit", paint);
    return () => { emblaApi.off("scroll", paint); emblaApi.off("reInit", paint); };
  }, [emblaApi, visible, snapOffset]);


  const move = (index: number) => {
    const next = TIER_ORDER[Math.min(Math.max(index, 0), TIER_ORDER.length - 1)];
    if (next) onSelect(next);
  };

  const moveFocus = (index: number) => {
    focusPending.current = true;
    move(index);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      moveFocus(selectedIndex + 1);
    } else if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      moveFocus(selectedIndex - 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveFocus(0);
    } else if (event.key === "End") {
      event.preventDefault();
      moveFocus(TIER_ORDER.length - 1);
    }
  };

  const curve = EDGE_DROP / Math.pow(0.5 - 0.5 / visible, 2);
  const arcDrop = curve * 0.25;
  const arcHeight = Math.ceil(arcDrop) + 12;
  const canPrev = selectedIndex > 0;
  const canNext = selectedIndex < TIER_ORDER.length - 1;

  return (
    <div className="mc-track-zone" ref={groupRef} data-fade-left={canPrev || undefined} data-fade-right={canNext || undefined}>
      <button type="button" className="mc-arrow mc-arrow--prev" aria-label="查看上一个等级" disabled={!canPrev} onClick={() => move(selectedIndex - 1)}>
        <ChevronLeft size={20} aria-hidden="true" />
      </button>
      <div className="mc-track-shell" style={{ "--mc-visible": visible, "--mc-arc-drop": `${arcDrop}px` } as CSSProperties}>
        <svg className="mc-arc" viewBox={`0 0 1000 ${arcHeight}`} preserveAspectRatio="none" aria-hidden="true" style={{ height: arcHeight }}>
          <defs>
            <linearGradient id="mc-arc-grad" x1="0" y1="0" x2="1" y2="0">
              <stop offset="0" style={{ stopColor: "var(--header-accent)", stopOpacity: 0.12 }} />
              <stop offset="0.5" style={{ stopColor: "var(--header-accent)", stopOpacity: 0.75 }} />
              <stop offset="1" style={{ stopColor: "var(--header-accent)", stopOpacity: 0.12 }} />
            </linearGradient>
          </defs>
          <path className="mc-arc-edge" d={`M0 0 Q500 ${2 * arcDrop} 1000 0`} stroke="url(#mc-arc-grad)" />
        </svg>
        <div className="mc-track" ref={viewportRef} role="radiogroup" aria-label="选择要查看的会员等级" onKeyDown={onKeyDown}>
          <div className="mc-track-slides">
            {[0, 1].map((pad) => <div key={`ghost-start-${pad}`} className="mc-node mc-node--ghost" aria-hidden="true" />)}
            {TIER_ORDER.map((tier) => (
              <button
                key={tier}
                type="button"
                role="radio"
                aria-checked={tier === selected}
                tabIndex={tier === selected ? 0 : -1}
                className="mc-node"
                data-tier={tier}
                data-current={tier === actual || undefined}
                onClick={() => onSelect(tier)}
              >
                <span className="mc-node-dot" aria-hidden="true" />
                <span className="mc-node-label">{TIER_SHORT[tier]}</span>
                <span className="mc-node-current" aria-hidden={tier !== actual}>{tier === actual ? "当前" : "\u00a0"}</span>
                {tier === "BLACK_GOLD" ? <span className="mc-node-chip sr-only">累计</span> : null}
              </button>
            ))}
            {[0, 1].map((pad) => <div key={`ghost-end-${pad}`} className="mc-node mc-node--ghost" aria-hidden="true" />)}
          </div>
        </div>
      </div>
      <button type="button" className="mc-arrow mc-arrow--next" aria-label="查看下一个等级" disabled={!canNext} onClick={() => move(selectedIndex + 1)}>
        <ChevronRight size={20} aria-hidden="true" />
      </button>
      {actual ? (
        <button type="button" className="mc-return" style={selected === actual ? { visibility: "hidden" } : undefined} disabled={selected === actual} aria-hidden={selected === actual} tabIndex={selected === actual ? -1 : 0} onClick={() => { focusPending.current = true; onSelect(actual); }}>
          返回当前等级
        </button>
      ) : null}
    </div>
  );
}

type BenefitResult = { items: Array<{ title: string; detail: string }> | null; note: string | null };

function benefitItems(selected: TrackTier, actual: TrackTier | null, data: MembershipGrowthData): BenefitResult {
  if (data.benefitsState !== "CONFIGURED") return { items: null, note: "具体政策待公布。" };
  if (selected === actual) {
    const items = data.benefits.map((item) => ({ title: item.label, detail: item.value }));
    return items.length ? { items, note: null } : { items: null, note: "当前档权益暂时无法读取。" };
  }
  const row = data.comparison?.find((item) => COMPARISON_LABEL_TO_TIER[item.tier] === selected);
  if (!row) return { items: null, note: "该档权益暂时无法展示。" };
  const pricing = row.pricing === "完整方案可比价" ? "按完整报价择优，以下单确认页本人报价为准" : "具体政策待公布。";
  const deposit = row.deposit === "免租客押金" ? "免租客押金" : "以适用资格为准";
  return {
    items: [
      { title: "租赁优惠", detail: pricing },
      { title: "租客押金", detail: deposit },
    ],
    note: null,
  };
}

function EntitlementRow({ item, detailed }: { item: MembershipGrowthData["entitlements"][number]; detailed?: boolean }) {
  const period = item.state === "ACTIVE"
    ? `自 ${formatBeijingDate(item.startsAt)} · 有效至 ${formatBeijingDate(item.endsAt)}`
    : item.state === "EXECUTED_PENDING_START"
      ? `自 ${formatBeijingDateTime(item.startsAt)} 起生效 · 至 ${formatBeijingDate(item.endsAt)}`
      : `${formatBeijingDate(item.startsAt)} – ${formatBeijingDate(item.endsAt)}`;
  return (
    <div className="mc-entitlement-row" data-state={item.state}>
      <EntitlementBadge kind={item.kind} label={item.label} size={detailed ? 48 : 32} />
      <div className="mc-entitlement-copy">
        <span className="mc-entitlement-title">
          {item.label}
          <em data-state={item.state}>{ENTITLEMENT_STATE_LABELS[item.state]}</em>
        </span>
        <span className="mc-entitlement-meta">{formatScopeName(item.scope)} · {period}</span>
      </div>
    </div>
  );
}

function EntitlementSection({ data }: { data: MembershipGrowthData }) {
  const active = data.entitlements.filter((item) => item.state === "ACTIVE");
  const rest = data.entitlements.filter((item) => item.state !== "ACTIVE");
  if (data.entitlements.length === 0) {
    return (
      <section className="mc-section mc-section--quiet" id="mc-entitlements" aria-labelledby="mc-entitlements-heading">
        <h3 id="mc-entitlements-heading">我的专属礼遇</h3>
        <p className="mc-quiet-note">暂无生效中的专属礼遇，生效后会在这里显示范围与期限。<Link href="/help/membership-benefits">查看成长与礼遇规则</Link></p>
      </section>
    );
  }
  return (
    <section className="mc-section" id="mc-entitlements" aria-labelledby="mc-entitlements-heading">
      <div className="mc-section-heading">
        <h3 id="mc-entitlements-heading">我的专属礼遇</h3>
      </div>
      {active.length === 0 ? <p className="mc-quiet-note">当前没有生效中的礼遇；以下记录尚未生效或已结束。</p> : (
        <ul className="mc-entitlement-list">
          {active.map((item) => (
            <li key={item.id}>
              <EntitlementRow item={item} />
              <Dialog.Root>
                <Dialog.Trigger asChild>
                  <button type="button" className="mc-link-button">
                    查看详情<ArrowRight size={14} aria-hidden="true" />
                  </button>
                </Dialog.Trigger>
                <Dialog.Portal>
                  <Dialog.Overlay className="mc-dialog-overlay" />
                  <Dialog.Content className="mc-dialog" aria-describedby="mc-entitlement-dialog-note">
                    <Dialog.Title>{item.label}</Dialog.Title>
                    <EntitlementRow item={item} detailed />
                    <dl className="mc-dialog-facts">
                      <div><dt>状态</dt><dd>{ENTITLEMENT_STATE_LABELS[item.state]}</dd></div>
                      <div><dt>适用范围</dt><dd>{formatScopeName(item.scope)}</dd></div>
                      <div><dt>生效时间</dt><dd>{formatBeijingDateTime(item.startsAt)}</dd></div>
                      <div><dt>到期时间</dt><dd>{formatBeijingDateTime(item.endsAt)}</dd></div>
                      <div><dt>租客押金</dt><dd>{item.depositWaived ? "含租客押金减免，以生效记录为准" : "不包含租客押金减免"}</dd></div>
                    </dl>
                    <p id="mc-entitlement-dialog-note" className="mc-quiet-note">礼遇由平台人工核发，范围与期限以生效记录为准；审批通过不等于已享受。</p>
                    <Dialog.Close asChild>
                      <button type="button" className="mc-button">关闭</button>
                    </Dialog.Close>
                  </Dialog.Content>
                </Dialog.Portal>
              </Dialog.Root>
            </li>
          ))}
        </ul>
      )}
      {rest.length > 0 ? (
        <details className="mc-details">
          <summary>待生效与历史礼遇（{rest.length}）</summary>
          <ul className="mc-entitlement-list mc-entitlement-list--history">
            {rest.map((item) => (
              <li key={item.id}><EntitlementRow item={item} /></li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function PointsLedger({ data, events }: { data: MembershipGrowthData; events?: MembershipPointEvent[] }) {
  return (
    <section className="mc-section" aria-labelledby="mc-ledger-heading">
      <div className="mc-section-heading">
        <h3 id="mc-ledger-heading">积分变动明细</h3>
        <p className="mc-section-meta">
          {data.windowStart ? `统计窗口 ${formatBeijingDate(data.windowStart)} – ${formatBeijingDate(data.asOf)}` : `统计截至 ${formatBeijingDateTime(data.asOf)}`}
        </p>
      </div>
      {events && events.length > 0 ? (
        <ul className="mc-ledger">
          {events.map((event) => (
            <li key={event.id} className="mc-ledger-row">
              <span className="mc-ledger-time">{formatBeijingDateTime(event.at)}</span>
              <span className="mc-ledger-reason">{event.reason}</span>
              <span className="mc-ledger-delta" data-sign={event.rollingDelta.startsWith("-") ? "down" : "up"}>{signedPoints(event.rollingDelta)}</span>
              <span className="mc-ledger-delta" data-sign={event.lifetimeDelta.startsWith("-") ? "down" : event.lifetimeDelta === "0" ? "flat" : "up"}>{event.lifetimeDelta === "0" ? "不变" : signedPoints(event.lifetimeDelta)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mc-quiet-note">积分变动明细暂不可用；下方为近90天有效消费记录。</p>
      )}
      <h4 className="mc-ledger-subheading">当前窗口有效消费记录</h4>
      {data.contributions.length === 0 ? (
        <p className="mc-quiet-note">当前窗口没有有效消费记录。</p>
      ) : (
        <ul className="mc-contributions">
          {data.contributions.map((item, index) => (
            <li key={`${item.effectiveAt}:${item.amountCents}:${index}`} className="mc-contribution-row">
              <span className="mc-contribution-label">{item.label}<em>{item.kind === "CORRECTION" ? "更正" : "结算生效"}</em></span>
              <span className="mc-contribution-time">{formatBeijingDateTime(item.effectiveAt)} · 退出 {formatBeijingDate(item.exitsAt)}</span>
              <strong className="mc-contribution-amount">{yuanFromCents(item.amountCents)}</strong>
            </li>
          ))}
        </ul>
      )}
      {data.nextExpiryAt ? <p className="mc-quiet-note"><Clock3 size={14} aria-hidden="true" />下一批有效消费预计于 {formatBeijingDateTime(data.nextExpiryAt)} 退出窗口；届时实时重算档位。</p> : null}
      {data.pendingCount > 0 ? <p className="mc-quiet-note">还有 {data.pendingCount} 条未完成结算，完成前不会增加成长积分。</p> : null}
    </section>
  );
}

export function MembershipCenterView({ state, onRetry, pointEvents }: { state: MembershipGrowthViewState; onRetry?: () => void; pointEvents?: MembershipPointEvent[] }) {
  const data = state.status === "ready" ? state.data : null;
  const actual: TrackTier | null = data && data.tier !== "UNKNOWN" ? (data.tier as TrackTier) : null;
  const [selected, setSelected] = useState<TrackTier | null>(null);
  const desktop = useMediaState("(min-width: 1024px)", true);
  const reduced = useMediaState("(prefers-reduced-motion: reduce)", false);

  useEffect(() => {
    if (!data) return;
    if (data.tier === "UNKNOWN") setSelected(null);
    else setSelected((prev) => prev ?? (data.tier as TrackTier));
  }, [data, data?.tier]);

  const shown: TrackTier | null = selected ?? actual;
  const heroTier: GrowthTier = shown ?? (data ? data.tier : "UNKNOWN");
  const summary = shown && data ? targetSummary(shown, actual, data) : null;
  const benefits = shown && data ? benefitItems(shown, actual, data) : null;
  const actualIndex = actual ? TIER_ORDER.indexOf(actual) : -1;
  const shownIndex = shown ? TIER_ORDER.indexOf(shown) : -1;
  const aboveActual = Boolean(actual && shown && shownIndex > actualIndex);
  const belowActual = Boolean(actual && shown && shownIndex < actualIndex);
  const previewBadge = shown && actual && shown !== actual ? (aboveActual ? "尚未达到" : "等级权益") : null;

  return (
    <div className="account-membership-view membership-center">
      <header className="mc-page-head">
        <h2>会员中心</h2>
        <div className="mc-head-actions">
          <span className="mc-current-chip" data-testid="membership-current-tier">
            <Crown size={14} aria-hidden="true" />
            当前：{data ? GROWTH_TIER_LABELS[data.tier] : "读取中"}
          </span>
          <Link className="mc-link-button" href="/help/membership-benefits">
            成长规则<ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </header>

      {!data ? (
        <StateMessage state={state as Exclude<MembershipGrowthViewState, { status: "ready" }>} onRetry={onRetry} />
      ) : (
        <>
          <div className={`mc-hero account-growth-header-wrap ${tierClass(heroTier)}`} data-tier={heroTier}>
            <div className="mc-hero-grid">
              <div className="mc-hero-points">
                <span className="mc-hero-label">近90天成长积分</span>
                <strong className="mc-hero-value">{groupDigits(data.rollingPoints)}</strong>
                <span className="mc-hero-sub mc-hero-meta"><span>累计 {groupDigits(data.lifetimePoints)}</span><span>截至 {formatBeijingDate(data.asOf)}</span></span>
              </div>
              <div className="mc-hero-card">
                {shown ? <TierCardImage tier={shown} square={!desktop} /> : <GrowthMemberCardArt tier={data.tier} />}
                <span className="mc-hero-card-flag" data-state={aboveActual ? "preview" : belowActual ? "lower" : shown === actual ? "current" : "unknown"}>
                  {aboveActual ? <><Lock size={13} aria-hidden="true" />权益预览</> : belowActual ? "等级权益预览" : shown === actual ? "当前等级" : "资格待确认"}
                </span>
              </div>
              <div className="mc-hero-target">
                {summary?.headline ? <span className="mc-hero-label">{summary.headline}</span> : null}
                {summary?.value ? <strong className="mc-hero-value">{summary.value}</strong> : null}
                <span className="mc-hero-sub">{summary?.progress ? summary.note : null}</span>
              </div>
            </div>
            {shown ? (
              <TierTrack actual={actual} selected={shown} onSelect={setSelected} reduced={reduced} visible={desktop ? 5 : 3} />
            ) : (
              <p className="mc-quiet-note mc-hero-note">等级资格待确认，暂时不能浏览各档权益；确认后会恢复等级轨道。</p>
            )}
            <div className="mc-progress-slot">{summary?.progress ? (
              <div className="mc-progress">
                <span className="mc-progress-label">{summary.progress.label}<strong>{summary.progress.detail}</strong></span>
                <Progress className="mc-progress-bar" value={summary.progress.percent} aria-label={summary.progress.label} aria-valuetext={summary.progress.detail} />
                <span className="mc-progress-gap">{summary.headline?.includes("还差") && summary.value ? `还差 ${summary.value} 分` : ""}</span>
              </div>
            ) : <p className="mc-progress-neutral">{summary?.note ?? "当前等级暂无升级目标"}</p>}</div>
            {data.grace.state === "ACTIVE" ? (
              <div className="mc-callout" data-state="active">
                <Clock3 size={17} aria-hidden="true" />
                <div>
                  <strong>{data.grace.fromTier ? GROWTH_TIER_LABELS[data.grace.fromTier] : "当前"}权益保留至 {formatBeijingDateTime(data.grace.until)}</strong>
                  <span>当前积分不足原档门槛 {data.grace.gapPoints === null ? "待确认" : groupDigits(data.grace.gapPoints)} 分；到期时按当时积分重新定档，消费不会顺延截止时间。</span>
                </div>
              </div>
            ) : null}
            {data.grace.state === "UNKNOWN" ? (
              <div className="mc-callout" data-state="unknown">
                <AlertTriangle size={17} aria-hidden="true" />
                <span>保级截止时间暂时无法确认，当前权益不自动降级。</span>
              </div>
            ) : null}
          </div>

          <div className="mc-stack">
            <section className="mc-section" aria-labelledby="mc-benefits-heading">
              <div className="mc-section-heading">
                <h3 id="mc-benefits-heading">
                  {shown && shown === actual ? `我的${benefitName(shown)}权益` : shown ? `${benefitName(shown)}权益预览` : "等级权益"}
                  {previewBadge ? <em className="mc-badge">{previewBadge}</em> : null}
                </h3>
                <a className="mc-link-button" href="#mc-entitlements">了解专属礼遇<ArrowRight size={14} aria-hidden="true" /></a>
              </div>
              {benefits?.items ? (
                <ul className="mc-benefit-list">
                  {benefits.items.map((item) => (
                    <li key={item.title}>
                      <span className="mc-benefit-icon" aria-hidden="true">{item.title === "租赁优惠" || item.title === "租赁价格" ? <Percent size={18} /> : <ShieldCheck size={18} />}</span>
                      <div><strong>{item.title}</strong><span>{item.detail}</span></div>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mc-quiet-note">{benefits?.note ?? "具体政策待公布。"}</p>
              )}
            </section>

            <EntitlementSection data={data} />
            <PointsLedger data={data} events={pointEvents} />
          </div>
        </>
      )}
    </div>
  );
}

function TierCardImage({ tier, square }: { tier: TrackTier; square: boolean }) {
  const src = square ? TIER_CARD_SQUARE[tier] : TIER_CARD_IMAGE[tier];
  const [failed, setFailed] = useState(false);
  const [prevSrc, setPrevSrc] = useState(src);
  if (prevSrc !== src) {
    setPrevSrc(src);
    setFailed(false);
  }
  if (failed || !src) return <GrowthMemberCardArt tier={tier} />;
  return (
    <img
      key={src}
      className="mc-card-img"
      src={src}
      alt=""
      width={square ? 768 : 1020}
      height={square ? 768 : 600}
      onError={() => setFailed(true)}
    />
  );
}
