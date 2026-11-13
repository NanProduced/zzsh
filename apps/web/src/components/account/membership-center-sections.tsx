"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { AlertTriangle, ArrowRight, Clock3, Info, RefreshCw, ShieldCheck } from "lucide-react";
import { readMyMembershipGrowthConsumption, MembershipGrowthRequestError, type GrowthConsumptionScope, type MembershipGrowthConsumption, type MembershipGrowthData, type MembershipGrowthViewState, type MembershipPointEvent } from "../../lib/membership-growth-client";
import { rentalModeLabel } from "../../lib/publish-derive";
import { EntitlementBadge } from "./membership-center-card";
import { COMPARISON_LABEL_TO_TIER, ENTITLEMENT_STATE_LABELS, TIER_ORDER, TIER_SHORT, TIER_THRESHOLDS, formatBeijingDate, formatBeijingDateTime, formatScopeName, groupDigits, pointsGap, pointsPercent, signedPoints, yuanFromCents, type TrackTier } from "./membership-center-format";

export function StateMessage({ state, onRetry }: { state: Exclude<MembershipGrowthViewState, { status: "ready" }>; onRetry?: () => void }) {
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

export function targetSummary(selected: TrackTier, actual: TrackTier | null, data: MembershipGrowthData): TargetSummary {
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

type BenefitCardItem = {
  title: string;
  badge: string;
  highlight: string;
  subtext: string;
  icon: "pricing" | "deposit" | "crown";
};

type BenefitResult = { items: BenefitCardItem[] | null; note: string | null };

export function benefitItems(selected: TrackTier, actual: TrackTier | null, data: MembershipGrowthData): BenefitResult {
  if (data.benefitsState !== "CONFIGURED") return { items: null, note: "具体政策待公布。" };
  if (selected === actual) {
    const items: BenefitCardItem[] = data.benefits.map(item => ({
      title: item.label, badge: "当前权益", highlight: item.value,
      subtext: "以当前生效政策及个人报价为准。", icon: item.label.includes("押金") ? "deposit" : "pricing",
    }));
    // Canonical sort: deposit card on the left, pricing card on the right
    items.sort((a, b) => (a.icon === "deposit" ? -1 : b.icon === "deposit" ? 1 : 0));
    return items.length ? { items, note: null } : { items: null, note: "当前档权益暂时无法读取。" };
  }
  const row = data.comparison?.find((item) => COMPARISON_LABEL_TO_TIER[item.tier] === selected);
  if (!row) return { items: null, note: "该档权益暂时无法展示。" };
  return { items: [
    { title: "租客押金", badge: "等级权益", highlight: row.deposit, subtext: "以适用资格和个人报价为准。", icon: "deposit" },
    { title: "租赁优惠", badge: "等级权益", highlight: row.pricing, subtext: "以个人确认报价为准。", icon: "pricing" },
  ], note: null };
}

/** 应付比例 × 10^8 ＝ 实付百分比 × 10^6：一次换算，同时给出“折”的简写和精确百分比。 */
function entitlementDiscountParts(payableRatio: string): { label: string; percent: string } {
  const [integer = "0", fraction = ""] = payableRatio.split(".");
  const scaled = BigInt(`${integer}${fraction.padEnd(8, "0")}`);
  const percentWhole = scaled / 1_000_000n;
  const percentFraction = (scaled % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  const percent = `${percentWhole}${percentFraction ? `.${percentFraction}` : ""}%`;
  if (scaled === 100_000_000n) return { label: "原价", percent };
  const hundredths = (scaled + 50_000n) / 100_000n;
  const exact = scaled % 100_000n === 0n;
  const zheWhole = hundredths / 100n;
  const zheFraction = (hundredths % 100n).toString().padStart(2, "0").replace(/0+$/, "");
  return { label: `${exact ? "" : "约"}${zheWhole}${zheFraction ? `.${zheFraction}` : ""}折`, percent };
}

function entitlementDiscountLabel(summary: MembershipGrowthData["entitlements"][number]["pricingSummary"]): string {
  if (summary?.knowledge === "LEGACY") return "旧版计价合同";
  if (summary?.knowledge !== "KNOWN" || !summary.payableRatio) return "折扣还没核对";
  return entitlementDiscountParts(summary.payableRatio).label;
}

function entitlementScopeLabel(summary: MembershipGrowthData["entitlements"][number]["pricingSummary"]): string {
  if (summary?.knowledge !== "KNOWN") return "范围待核";
  if ("scope" in summary && summary.scope === "ALL_ENABLED_RENTAL_MODES") return "全部已启用租赁方式统一";
  if ("mode" in summary && summary.mode) return `旧版 · ${rentalModeLabel(summary.mode)}`;
  return "范围待核";
}

function formatDepositAllowanceYuan(cents: string): string {
  if (!cents || !/^[1-9]\d*$/.test(cents)) return "0";
  const val = BigInt(cents);
  const whole = val / 100n;
  const rem = val % 100n;
  if (rem === 0n) return whole.toString();
  const frac = rem.toString().padStart(2, "0").replace(/0$/, "");
  return `${whole}.${frac}`;
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
        <span className="mc-entitlement-meta">{formatScopeName(item.scope, item.gameId, item.gameName)} · {period}</span>
        <span className="mc-entitlement-meta">
          {entitlementDiscountLabel(item.pricingSummary)}
          {item.pricingSummary?.knowledge === "KNOWN" ? ` · ${entitlementScopeLabel(item.pricingSummary)}` : ""} · {
            item.depositWaived
              ? "含租客免押"
              : item.depositAllowanceCents && item.depositAllowanceCents !== "0" && /^[1-9]\d*$/.test(item.depositAllowanceCents)
              ? `减免押金 ¥${formatDepositAllowanceYuan(item.depositAllowanceCents)} 元`
              : "不含租客免押"
          }
        </span>
      </div>
    </div>
  );
}

/** 成长未知态只给礼遇事实，没有可比较的成长数据。 */
export function EntitlementSection({ data, entitlements }: { data?: MembershipGrowthData; entitlements?: MembershipGrowthData["entitlements"] }) {
  const rows = data?.entitlements ?? entitlements ?? [];
  const active = rows.filter((item) => item.state === "ACTIVE");
  const rest = rows.filter((item) => item.state !== "ACTIVE");
  if (rows.length === 0) {
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
                      <div><dt>适用范围</dt><dd>{formatScopeName(item.scope, item.gameId, item.gameName)}</dd></div>
                      <div><dt>生效时间</dt><dd>{formatBeijingDateTime(item.startsAt)}</dd></div>
                      <div><dt>到期时间</dt><dd>{formatBeijingDateTime(item.endsAt)}</dd></div>
                      <div><dt>租赁优惠</dt><dd>{entitlementDiscountLabel(item.pricingSummary)}</dd></div>
                      {item.pricingSummary?.knowledge === "KNOWN" && item.pricingSummary.payableRatio ? <div><dt>实付比例</dt><dd>{entitlementDiscountParts(item.pricingSummary.payableRatio).percent}（精确值，下单价以服务端报价为准）</dd></div> : null}
                      {item.pricingSummary?.knowledge === "KNOWN" ? <div><dt>适用范围</dt><dd>{entitlementScopeLabel(item.pricingSummary)}</dd></div> : null}
                      <div><dt>租客押金</dt><dd>{
                        item.depositWaived
                          ? "含租客完全免押，以生效记录为准"
                          : item.depositAllowanceCents && item.depositAllowanceCents !== "0" && /^[1-9]\d*$/.test(item.depositAllowanceCents)
                          ? `每单最高减免押金 ¥${formatDepositAllowanceYuan(item.depositAllowanceCents)} 元，实缴不低于0元`
                          : "不包含租客押金减免"
                      }</dd></div>
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

function ConsumptionDetails({ data }: { data: MembershipGrowthData }) {
  const [scope, setScope] = useState<GrowthConsumptionScope>("LIFETIME");
  const [retry, setRetry] = useState(0);
  const [visibleCount, setVisibleCount] = useState(5);
  const key = `${data.subjectId ?? ""}:${data.asOf}:${scope}`;
  const [state, setState] = useState<{ key: string; page?: MembershipGrowthConsumption; error?: string; loading: boolean }>({ key, loading: true });
  const generation = useRef(0), controller = useRef<AbortController | null>(null);
  const shown = state.key === key ? state : { key, loading: true };
  useEffect(() => {
    setVisibleCount(5);
  }, [scope]);
  useEffect(() => {
    const mine = ++generation.current;
    controller.current?.abort();
    const abort = new AbortController(); controller.current = abort;
    setState({ key, loading: true });
    if (data.subjectId) void readMyMembershipGrowthConsumption(data.subjectId, scope, undefined, abort.signal).then((page) => {
      if (mine === generation.current && !abort.signal.aborted) setState({ key, page, loading: false });
    }).catch((error) => {
      if (mine === generation.current && !abort.signal.aborted) setState({ key, loading: false, error: error instanceof MembershipGrowthRequestError && error.status === 401 ? "当前身份已变化，请重新验证后读取明细。" : "成长消费明细暂时无法读取。" });
    });
    return () => { generation.current += 1; abort.abort(); };
  }, [key, data.subjectId, scope, retry]);
  if (!data.subjectId) return <p className="mc-quiet-note">积分变动明细暂不可用；下方为近90天有效消费记录。</p>;
  const page = shown.page;
  async function loadMore() {
    if (!page?.nextCursor || shown.loading) return;
    const mine = ++generation.current, abort = new AbortController();
    controller.current?.abort(); controller.current = abort;
    setState({ key, page, loading: true });
    try {
      const next = await readMyMembershipGrowthConsumption(data.subjectId!, scope, page.nextCursor, abort.signal);
      if (mine !== generation.current || abort.signal.aborted) return;
      if (next.snapshotVersion !== page.snapshotVersion || next.asOf !== page.asOf || next.total !== page.total || next.nextCursor === page.nextCursor || next.items.some((item) => page.items.some((prior) => prior.id === item.id))) throw new MembershipGrowthRequestError(409, null);
      setState({ key, page: { ...next, items: [...page.items, ...next.items] }, loading: false });
      setVisibleCount((c) => c + 5);
    } catch (error) {
      if (mine !== generation.current || abort.signal.aborted) return;
      const stale = error instanceof MembershipGrowthRequestError && [401, 403, 409].includes(error.status);
      setState({ key, ...(stale ? {} : { page }), loading: false, error: stale ? "身份或消费依据已变化，请重新读取明细。" : "后续明细读取失败，已显示的记录保留。" });
    }
  }

  const items = page?.items ?? [];
  const displayedItems = items.slice(0, visibleCount);
  const hasMoreLocal = items.length > visibleCount;
  const hasMoreRemote = Boolean(page?.nextCursor);
  const canLoadMore = hasMoreLocal || hasMoreRemote;

  const handleLoadMore = () => {
    if (hasMoreLocal) {
      setVisibleCount((c) => c + 5);
    } else if (hasMoreRemote) {
      void loadMore();
    }
  };

  return <div className="mc-consumption-details">
    <div className="mc-detail-scopes" role="group" aria-label="消费明细范围">
      <button type="button" className="mc-button" aria-pressed={scope === "LIFETIME"} onClick={() => setScope("LIFETIME")}>累计有效消费</button>
      <button type="button" className="mc-button" aria-pressed={scope === "ROLLING"} onClick={() => setScope("ROLLING")}>近90天有效消费</button>
    </div>
    <p className="mc-consumption-note">
      <Info size={13} aria-hidden="true" />
      按确认更正合并计算消费依据，金额合计后折算积分（不是历史积分发放流水）。
    </p>
    {shown.loading && !page ? <p className="mc-quiet-note" role="status">正在读取消费明细…</p> : null}
    {shown.error ? <p className="mc-quiet-note" role="alert">{shown.error}<button type="button" className="mc-button" onClick={() => setRetry((value) => value + 1)}>重新读取明细</button></p> : null}
    {page?.knowledge === "UNKNOWN" ? <div className="mc-consumption-empty" role="status"><p>消费来源尚未完成核验</p><span>暂不展示完整明细，稍后重新读取。</span></div> : null}
    {page?.knowledge === "KNOWN" ? <>
      <div className="mc-consumption-summary" aria-label="有效消费摘要">
        <div className="mc-consumption-metric"><span>{scope === "LIFETIME" ? "累计有效消费" : "近90天有效消费"}</span><strong>{yuanFromCents(page.amountCents!)}</strong></div>
        <div className="mc-consumption-metric"><span>折算成长积分</span><strong>合计 {page.points} 积分</strong></div>
      </div>
      {page.total === 0 ? <div className="mc-consumption-empty" role="status"><p>{scope === "LIFETIME" ? "累计没有有效消费记录" : "当前窗口没有有效消费记录"}</p><span>完成结算的有效消费会出现在这里。</span></div> : <ul className="mc-contributions">
        {displayedItems.map((item) => <li key={item.id} className="mc-contribution-row">
          <span className="mc-contribution-label">{item.label}<em>{item.withinWindow ? "计入近90天" : "仅计入累计"}{item.corrected ? ` · 已更正至第${item.revision}版` : ""}</em></span>
          <span className="mc-contribution-time">{formatBeijingDateTime(item.effectiveAt)}{scope === "ROLLING" ? ` · 退出窗口 ${formatBeijingDate(item.expiresAt)}` : ""}</span>
          <strong className="mc-contribution-amount">{yuanFromCents(item.amountCents)}</strong>
        </li>)}
      </ul>}
      <p className="mc-consumption-foot">已展示 {displayedItems.length} 条 · 共已加载 {page.items.length} / {page.total} 条有效消费依据{page.sourceSummary.pendingCount > 0 || page.sourceSummary.excludedCount > 0 ? `（${page.sourceSummary.pendingCount > 0 ? `${page.sourceSummary.pendingCount} 条未结算` : ""}${page.sourceSummary.pendingCount > 0 && page.sourceSummary.excludedCount > 0 ? "，" : ""}${page.sourceSummary.excludedCount > 0 ? `${page.sourceSummary.excludedCount} 条已排除` : ""}均不计入）` : null}。</p>
      {canLoadMore ? <button type="button" className="mc-button" disabled={shown.loading} onClick={handleLoadMore}>{shown.loading ? "正在读取…" : "加载更多消费依据"}</button> : null}
    </> : null}
  </div>;
}

export function PointsLedger({ data, events }: { data: MembershipGrowthData; events?: MembershipPointEvent[] }) {
  return (
    <section className="mc-section" aria-labelledby="mc-ledger-heading">
      <div className="mc-section-heading">
        <h3 id="mc-ledger-heading">{events?.length ? "积分变动明细" : "成长消费明细"}</h3>
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
        <ConsumptionDetails data={data} />
      )}
      {!data.subjectId ? <>
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
      </> : null}
      {data.nextExpiryAt ? <p className="mc-quiet-note"><Clock3 size={14} aria-hidden="true" />下一批有效消费预计于 {formatBeijingDateTime(data.nextExpiryAt)} 退出窗口；届时实时重算档位。</p> : null}
      {data.pendingCount > 0 ? <p className="mc-quiet-note">还有 {data.pendingCount} 条未完成结算，完成前不会增加成长积分。</p> : null}
    </section>
  );
}
