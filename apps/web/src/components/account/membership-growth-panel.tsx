"use client";

import { AlertTriangle, Check, ChevronDown, Clock3, Crown, RefreshCw, ShieldCheck, Sparkles } from "lucide-react";
import type { ReactNode } from "react";
import "./membership-growth-panel.css";

export type GrowthTier = "STANDARD" | "SILVER" | "GOLD" | "PLATINUM" | "DIAMOND" | "BLACK_GOLD" | "UNKNOWN";
export type GrowthGraceState = "NONE" | "ACTIVE" | "RECOVERED" | "EXPIRED" | "UNKNOWN";

export type MembershipGrowthData = {
  tier: GrowthTier;
  rollingPoints: string;
  lifetimePoints: string;
  asOf: string;
  nextTier: { tier: Exclude<GrowthTier, "BLACK_GOLD" | "STANDARD" | "UNKNOWN">; threshold: string; remaining: string } | null;
  grace: { state: GrowthGraceState; fromTier: GrowthTier | null; until: string | null; gapPoints: string | null };
  nextExpiryAt: string | null;
  benefits: Array<{ label: string; value: string; sourceVersion?: string }>;
  comparison?: Array<{ tier: string; deposit: string; pricing: string }>;
  entitlements: Array<{ kind: "FRIEND" | "PRESTIGE"; label: string; scope: string; endsAt: string; state: "PENDING" | "APPROVED_PENDING_EXECUTION" | "EXECUTED_PENDING_START" | "ACTIVE" | "EXPIRED" | "REPLACED" | "REVOKED"; depositWaived: boolean }>;
  contributions: Array<{ label: string; effectiveAt: string; amountCents: string; exitsAt: string; kind: "CONSUMPTION" | "CORRECTION" }>;
  pendingCount: number;
};

export type MembershipGrowthViewState =
  | { status: "loading" }
  | { status: "error"; message: string; retryable?: boolean }
  | { status: "permission"; message: string }
  | { status: "unknown"; message: string }
  | { status: "ready"; data: MembershipGrowthData };

const TIER_LABELS: Record<GrowthTier, string> = {
  STANDARD: "普通会员",
  SILVER: "银卡会员",
  GOLD: "金卡会员",
  PLATINUM: "铂金会员",
  DIAMOND: "钻石会员",
  BLACK_GOLD: "黑金会员",
  UNKNOWN: "资格待确认",
};

const GRACE_LABELS: Record<GrowthGraceState, string> = {
  NONE: "正常成长",
  ACTIVE: "保级中",
  RECOVERED: "已恢复",
  EXPIRED: "保级期已结束",
  UNKNOWN: "保级状态待确认",
};

function formatDate(value: string | null): string {
  if (!value) return "待确认";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "待确认" : new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(date);
}

function yuanFromCents(value: string): string {
  if (!/^-?\d+$/.test(value)) return "待确认";
  const negative = value.startsWith("-");
  const digits = negative ? value.slice(1) : value;
  const padded = digits.padStart(3, "0");
  return `${negative ? "-" : ""}¥${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

function StateMessage({ state, onRetry }: { state: Exclude<MembershipGrowthViewState, { status: "ready" }>; onRetry?: () => void }) {
  const copy = state.status === "loading" ? "正在读取成长档案" : state.status === "permission" ? "当前身份没有查看成长档案的权限" : state.message;
  return <div className="membership-growth-state" data-state={state.status} role={state.status === "error" ? "alert" : "status"} aria-busy={state.status === "loading" || undefined}>
    <span className="membership-growth-state-icon" aria-hidden="true">{state.status === "loading" ? <Clock3 size={22} /> : state.status === "permission" ? <ShieldCheck size={22} /> : <AlertTriangle size={22} />}</span>
    <div><strong>{state.status === "loading" ? "成长档案" : state.status === "permission" ? "无法查看" : "成长档案暂不可用"}</strong><p>{copy}</p></div>
    {state.status === "error" && state.retryable && onRetry ? <button type="button" className="membership-growth-button membership-growth-button--secondary" onClick={onRetry}><RefreshCw size={14} aria-hidden="true" />重试</button> : null}
  </div>;
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return <div className="membership-growth-fact"><dt>{label}</dt><dd>{children}</dd></div>;
}

export function MembershipGrowthPanel({ state, onRetry, onOpenRules }: { state: MembershipGrowthViewState; onRetry?: () => void; onOpenRules?: () => void }) {
  if (state.status !== "ready") return <section className="membership-growth-panel" data-testid="membership-growth-panel"><StateMessage state={state} onRetry={onRetry} /></section>;
  const data = state.data;
  const blackGold = data.tier === "BLACK_GOLD";
  const graceActive = data.grace.state === "ACTIVE";
  return <section className="membership-growth-panel" data-testid="membership-growth-panel" data-tier={data.tier}>
    <header className="membership-growth-heading">
      <div><h2>会员成长</h2><p>近90天有效结算消费形成成长积分；完成结算后才会计入档位。</p></div>
      {onOpenRules ? <button type="button" className="membership-growth-button membership-growth-button--secondary" onClick={onOpenRules}>查看规则<ChevronDown size={15} aria-hidden="true" /></button> : null}
    </header>

    <div className="membership-growth-hero">
      <div className="membership-growth-card-surface" data-tier={data.tier}>
        <span className="membership-growth-card-brand">洲洲商行</span>
        <span className="membership-growth-card-tier">{TIER_LABELS[data.tier]}</span>
        <span className="membership-growth-card-caption">GROWTH ARCHIVE</span>
        {blackGold ? <span className="membership-growth-card-lifetime"><Sparkles size={13} aria-hidden="true" />终身</span> : null}
      </div>
      <div className="membership-growth-hero-copy">
        <div className="membership-growth-status-line"><Crown size={18} aria-hidden="true" /><strong>{TIER_LABELS[data.tier]}</strong><span>{GRACE_LABELS[data.grace.state]}</span></div>
        <dl className="membership-growth-facts">
          <Fact label="近90天成长积分"><strong>{data.rollingPoints}</strong><span>分</span></Fact>
          <Fact label="统计截至">{formatDate(data.asOf)}</Fact>
          {blackGold ? <Fact label="资格状态"><span className="membership-growth-good">累计资格已保留</span></Fact> : data.nextTier ? <Fact label={`距离${TIER_LABELS[data.nextTier.tier]}`}>还差 <strong>{data.nextTier.remaining}</strong> 分</Fact> : <Fact label="成长状态">当前档位已确认</Fact>}
        </dl>
        {graceActive ? <div className="membership-growth-callout" data-state="active"><Clock3 size={17} aria-hidden="true" /><div><strong>{data.grace.fromTier ? TIER_LABELS[data.grace.fromTier] : "当前"}权益保留至 {formatDate(data.grace.until)}</strong><span>当前积分不足原档门槛 {data.grace.gapPoints ?? "待确认"} 分；到期时按当时积分重新定档，消费不会顺延截止时间。</span></div></div> : null}
        {data.grace.state === "UNKNOWN" ? <div className="membership-growth-callout" data-state="unknown"><AlertTriangle size={17} aria-hidden="true" /><span>保级截止时间暂时无法确认，当前权益不自动降级。</span></div> : null}
      </div>
    </div>

    <div className="membership-growth-columns">
      <section className="membership-growth-section" aria-labelledby="membership-growth-benefits-heading">
        <div className="membership-growth-section-heading"><div><h3 id="membership-growth-benefits-heading">当前权益</h3><p>权益版本与本次新建单的有效报价共同决定实际价格。</p></div><ShieldCheck size={20} aria-hidden="true" /></div>
        <dl className="membership-growth-benefit-list">
          {data.benefits.map((benefit) => <div key={benefit.label}><dt>{benefit.label}</dt><dd><strong>{benefit.value}</strong></dd></div>)}
        </dl>
        <p className="membership-growth-note">成长权益与人工礼遇不叠加项目；下单时计算完整方案后取较低价格，免押资格独立判断。</p>
      </section>

      <section className="membership-growth-section" aria-labelledby="membership-growth-entitlements-heading">
        <div className="membership-growth-section-heading"><div><h3 id="membership-growth-entitlements-heading">人工专属礼遇</h3><p>礼遇独立于成长档，范围、参数、审批版本和到期时间分别保存。</p></div><Sparkles size={20} aria-hidden="true" /></div>
        {data.entitlements.length === 0 ? <div className="membership-growth-empty"><p>暂无生效中的人工礼遇</p><span>已有礼遇会在有效期内显示。</span></div> : <ul className="membership-growth-entitlement-list">{data.entitlements.map((item) => <li key={`${item.kind}:${item.scope}:${item.endsAt}`} data-state={item.state}><div><strong>{item.label}</strong><span>{item.scope}</span></div><div><span>{item.state === "ACTIVE" ? `有效至 ${formatDate(item.endsAt)}` : item.state === "EXPIRED" ? "已到期" : item.state === "REVOKED" || item.state === "REPLACED" ? "已结束" : item.state === "APPROVED_PENDING_EXECUTION" ? "审批通过，待执行" : item.state === "EXECUTED_PENDING_START" ? `已发放，${formatDate(item.endsAt)} 起生效` : "待审批"}</span><small>{item.depositWaived ? "含免押" : "不含免押"}</small></div></li>)}</ul>}
      </section>
    </div>

    <details className="membership-growth-details">
      <summary>查看积分明细与到期影响</summary>
      <div className="membership-growth-detail-content">
        <p className="membership-growth-note">消费合计后再换算成长积分，1元=1分；因此明细金额相加与显示积分可能不同。</p>
        {data.nextExpiryAt ? <p className="membership-growth-next-expiry"><Clock3 size={15} aria-hidden="true" />下一批有效消费预计于 {formatDate(data.nextExpiryAt)} 退出窗口；届时实时重算档位。</p> : null}
        {data.pendingCount > 0 ? <p className="membership-growth-pending"><span>待计入</span>还有 {data.pendingCount} 条未完成结算，完成前不会增加成长积分。</p> : null}
        {data.contributions.length === 0 ? <div className="membership-growth-empty"><p>当前没有可展示的有效消费明细</p><span>读取失败或来源未闭合时不显示为0分。</span></div> : <ul className="membership-growth-contribution-list">{data.contributions.map((item) => <li key={`${item.label}:${item.effectiveAt}:${item.amountCents}`}><div><strong>{item.label}</strong><span>{item.kind === "CORRECTION" ? "更正" : "结算生效"} · {formatDate(item.effectiveAt)}</span></div><div><strong>{yuanFromCents(item.amountCents)}</strong><span>退出 {formatDate(item.exitsAt)}</span></div></li>)}</ul>}
      </div>
    </details>

    <details className="membership-growth-details">
      <summary>展开权益对比与规则说明</summary>
      {data.comparison?.length ? <div className="membership-growth-rule-grid">{data.comparison.map((item) => <div key={item.tier}><span>{item.tier}</span><strong>{item.pricing}</strong><small>{item.deposit}</small></div>)}</div> : <p className="membership-growth-note">权益对比暂时无法读取。</p>}
      <p className="membership-growth-note">黑金为累计资格；停止消费不会让已确认的黑金自动失效。</p>
    </details>

    <footer className="membership-growth-footer"><Check size={14} aria-hidden="true" />成长信息会随结算更新；已建订单保留当时合同。</footer>
  </section>;
}
