"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { AlertTriangle, ArrowRight, Clock3, Crown, Lock, Percent, ShieldCheck } from "lucide-react";
import type { GrowthTier, MembershipGrowthViewState, MembershipPointEvent } from "../../lib/membership-growth-client";
import { Progress } from "../ui/progress";
import "./membership-center.css";
import { GrowthMemberCardArt, TierCardImage } from "./membership-center-card";
import { GROWTH_TIER_LABELS, TIER_ORDER, benefitName, formatBeijingDate, formatBeijingDateTime, groupDigits, tierClass, type TrackTier } from "./membership-center-format";
import { EntitlementSection, PointsLedger, StateMessage, benefitItems, targetSummary } from "./membership-center-sections";
import { TierTrack } from "./membership-center-track";

export { ENTITLEMENT_BADGE_IMAGE, GROWTH_TIER_EN_LABELS, GROWTH_TIER_LABELS, TIER_CARD_IMAGE, TIER_ORDER, TIER_THRESHOLDS, formatScopeName, type TrackTier } from "./membership-center-format";
export { EntitlementBadge, GrowthMemberCardArt } from "./membership-center-card";

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
            当前：{data ? GROWTH_TIER_LABELS[data.tier] : state.status === "unknown" ? GROWTH_TIER_LABELS.UNKNOWN : "读取中"}
          </span>
          <Link className="mc-link-button" href="/help/membership-benefits">
            成长规则<ArrowRight size={14} aria-hidden="true" />
          </Link>
        </div>
      </header>

      {!data ? (
        <>
          <StateMessage state={state as Exclude<MembershipGrowthViewState, { status: "ready" }>} onRetry={onRetry} />
          {state.status === "unknown" ? <EntitlementSection entitlements={state.entitlements} /> : null}
        </>
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
                <span className="mc-progress-label">
                  {summary.progress.label}
                  <strong>{summary.progress.detail}</strong>
                  <span className="mc-progress-percent">{summary.progress.percent}%</span>
                </span>
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
                    <li key={item.title} className="mc-benefit-card" data-benefit-kind={item.icon}>
                      <div className="mc-benefit-card-top">
                        <span className={`mc-benefit-icon mc-benefit-icon--${item.icon}`} aria-hidden="true">
                          {item.icon === "pricing" ? <Percent size={20} /> : item.icon === "crown" ? <Crown size={20} /> : <ShieldCheck size={20} />}
                        </span>
                        <span className="mc-benefit-title">{item.title}</span>
                        <span className="mc-benefit-pill">{item.badge}</span>
                      </div>
                      <div className="mc-benefit-card-body">
                        <strong className="mc-benefit-highlight">{item.highlight}</strong>
                        <span className="mc-benefit-subtext">{item.subtext}</span>
                      </div>
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
