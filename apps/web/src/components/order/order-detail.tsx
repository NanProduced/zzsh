"use client";

import Link from "next/link";
import { useState } from "react";
import { ArrowLeft, Check, CheckCircle2, CircleSlash, Clock3, Copy, Gamepad2, MessageCircle, RefreshCw, UserRound, WalletCards, XCircle } from "lucide-react";
import { formatOrderMoney, formatOrderTime as timeText, type Order, type OrderParty, type OrderRequestError, type OrderStatusFilter } from "@/lib/order-client";
import { unitHint, unitLabel, orderAccountTitle } from "@/lib/order-display";
import { OrderTradeActions, type OrderStageFacts } from "@/components/order/order-trade-actions";
import { OrderError, OrderStatusBadge, orderTermLabel, orderUrl, statusLabel } from "@/components/order/order-presentation";
import "./order.css";

type DetailState = { status: "loading" } | { status: "ready"; order: Order | null; error: OrderRequestError | null } | { status: "error"; error: OrderRequestError | null };

/** What still needs a decision from the reader. The order's own state lives in the identity band. */
type Attention = { tone: "info" | "warning"; title: string; note: string; actions: Array<"retry" | "group" | "browse" | "manage"> } | null;

function attentionFor(order: Order, facts: OrderStageFacts | null, readFailed: boolean, party: OrderParty): Attention {
  if (facts?.phase === "DECISION_REJECTED") {
    return {
      tone: "warning",
      title: `你已拒绝第${facts.settlementVersionNo ?? "?"}版结算`,
      note: "拒绝不会使这一版生效；服务端会按新的期末数据或人工调整生成新版本，之后再按最新版本重新核对。",
      actions: ["group"],
    };
  }
  if (facts?.phase === "DECISION_PENDING") {
    return { tone: "warning", title: "待你确认结算", note: "请核对本次消耗、费用承担与责任归属；拒绝不等于确认。确认入口在下方结算区。", actions: [] };
  }
  if (facts?.phase === "INTAKE_PENDING") {
    return { tone: "info", title: "结束申请待客服处理", note: "已提交期末数据，等待受权客服核实原因并复核；复核与双方确认完成后结算生效。", actions: [] };
  }
  if (facts?.phase === "DECISION_WAITING") {
    return { tone: "info", title: "等待对方确认结算", note: "你已在这一版完成操作；金额或版本变化会生成新版本并要求重新确认。", actions: [] };
  }
  if (order.status === "CANCELLED") {
    return {
      tone: "info",
      title: "账号占用已解除",
      note: "本单不再产生新的交易动作；已确认的订单信息仍可查看。",
      actions: [party === "renter" ? "browse" : "manage"],
    };
  }
  if (order.status === "COMPLETED" || order.status === "PAID") {
    // While the read is still in flight nothing is missing yet; only a real failure is a gap.
    if (facts || !readFailed) return null;
    return {
      tone: "warning",
      title: order.status === "COMPLETED" ? "结算明细暂时读不到" : "开租与结算明细暂时读不到",
      note: "订单状态仍然有效，已展示的金额与时间不受影响；消耗、费用与退款要读到结算记录才能确认。",
      actions: ["retry", "group"],
    };
  }
  return null;
}

function AttentionBlock({ attention, party, orderId, onRetry }: { attention: Attention; party: OrderParty; orderId: string; onRetry: () => void }) {
  if (!attention) return null;
  return <section className={`order-attention is-${attention.tone}`} role="status">
    <div className="order-attention-copy">
      <h2>{attention.title}</h2>
      <p>{attention.note}</p>
    </div>
    {/* One cluster. Talking to the person who fulfils the order is the primary move; trying the read
        again is a link, not a second button competing with it. */}
    <div className="order-attention-actions">
      {attention.actions.includes("group") ? <button type="button" className="button primary button--sm" data-support-trigger onClick={() => window.dispatchEvent(new CustomEvent("zzsh:order-groups", { detail: { party, orderId } }))}><MessageCircle size={15} aria-hidden="true" />打开订单群列表</button> : null}
      {attention.actions.includes("browse") ? <Link href="/accounts" className="button primary button--sm">浏览可租账号</Link> : null}
      {attention.actions.includes("manage") ? <Link href="/account?view=accounts" className="button primary button--sm">管理出租账号</Link> : null}
      {attention.actions.includes("retry") ? <button type="button" className="order-attention-link" onClick={onRetry}>重试读取</button> : null}
    </div>
  </section>;
}

/**
 * The order's own history, in the order things happened. Identity facts live in the identity band
 * above, so nothing here repeats them.
 */
function OrderTimeline({ order, facts, party }: { order: Order; facts: OrderStageFacts | null; party: OrderParty }) {
  const events: Array<{ key: string; label: string; time: string | null; state: "done" | "closed" | "pending" }> = [
    { key: "created", label: "下单", time: order.createdAt ?? null, state: "done" },
  ];
  if (order.paidAt) events.push({ key: "paid", label: "支付确认", time: order.paidAt ?? null, state: "done" });
  if (facts?.openingConfirmedAt) events.push({ key: "opened", label: "开租确认", time: facts.openingConfirmedAt, state: "done" });
  if (facts?.postedAt) events.push({ key: "posted", label: "结算生效", time: facts.postedAt, state: "done" });
  if (order.cancelledAt) {
    events.push({
      key: "cancelled",
      label: `取消${order.cancelReason === "USER" ? "（租客取消）" : order.cancelReason === "TIMEOUT" ? "（到期未支付）" : ""}`,
      time: order.cancelledAt ?? null,
      state: "closed",
    });
  }
  return <section className="order-detail-section order-timeline-block">
    <h2 className="order-section-title">订单进度</h2>
    <ol className="order-timeline">
      {events.map((event) => <li key={event.key} data-state={event.state}>
        <span className="order-timeline-dot" aria-hidden="true" />
        <strong>{event.label}</strong>
        <time>{event.time ? timeText(event.time) : "待确认"}</time>
      </li>)}
    </ol>
  </section>;
}

function CopyOrderNo({ value }: { value: string | null | undefined }) {
  const [copied, setCopied] = useState(false);
  if (!value) return null;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2400);
    } catch {
      setCopied(false);
    }
  };
  return <button type="button" className="order-copy-button" onClick={() => void copy()} aria-label={`复制订单号 ${value}`}>{copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}{copied ? "已复制" : "复制"}</button>;
}

function OrderLines({ order, party }: { order: Order; party: OrderParty }) {
  const lines = order.quote?.lines ?? [];
  if (lines.length === 0) return <p className="order-muted">费用明细暂时无法读取。</p>;
  return <>
    <div className="order-table-wrap">
      <table><thead><tr><th scope="col">资源</th><th scope="col">数量</th><th scope="col">{party === "owner" ? "号主报价" : "金额"}</th></tr></thead>
        <tbody>{lines.map((line, index) => <tr key={`${line.itemId ?? line.name ?? line.unit ?? "line"}-${index}`}>
          <td>{line.name ?? unitLabel(line.unit) ?? "资源待确认"}</td>
          <td>{line.quantity ?? line.unitQuantity ?? "数量待确认"}{unitHint(line.name ?? "", line.unit) ? ` ${unitHint(line.name ?? "", line.unit)}` : ""}</td>
          <td>{formatOrderMoney(party === "owner" ? line.ownerAmount : line.buyerAmount)}</td>
        </tr>)}</tbody>
      </table>
    </div>
    {order.quote?.unitAmountsInformational ? <p className="order-lines-note">明细为下单时的费用记录，最终金额请查看结算明细。</p> : null}
  </>;
}

/** Each party sees its own quoted amounts; a missing owner total stays unknown instead of borrowing the renter's. */
function linesSummary(order: Order, party: OrderParty): string {
  const lines = order.quote?.lines ?? [];
  const parts = lines.map((line) => `${line.name ?? unitLabel(line.unit) ?? "资源"} ${formatOrderMoney(party === "owner" ? line.ownerAmount : line.buyerAmount)}`);
  if (party === "owner") parts.push(order.quote?.ownerTotal ? `合计 ${formatOrderMoney(order.quote.ownerTotal)}` : "合计待确认");
  else parts.push(`合计 ${formatOrderMoney(order.amounts?.rental)}`);
  return parts.join(" · ");
}

/**
 * The rail answers "what is this transaction worth to me", and it only ever shows the reading party's
 * own money. The two sides are different numbers — a renter may pay less through a discount, and an
 * owner is quoted at listing time — so stacking both in one card manufactures a contradiction that
 * was never in the data. Owner sees the listing quote and the owner settlement; renter sees what they
 * paid and the renter settlement.
 */
/** The renter-side figure's name for the reading party, never implying a charge that did not happen. */
function renterFigureLabel(order: Order): string {
  if (order.status === "CANCELLED") return "下单时租客金额";
  return order.paidAt ? "租客已付" : "租客应付";
}

function AmountCard({ order, party, facts, readFailed }: { order: Order; party: OrderParty; facts: OrderStageFacts | null; readFailed: boolean }) {
  const amounts = order.amounts;
  const closed = order.status === "CANCELLED";
  const paid = Boolean(order.paidAt);
  const posted = facts?.phase === "POSTED" && facts.settled && facts.settled.text !== "—" ? facts.settled : null;
  const settledUnread = order.status === "COMPLETED" && !posted;

  if (party === "owner") {
    return <section className="order-side-card order-amount-block">
      <h2 className="order-section-title">号主侧金额</h2>
      {posted
        ? <><strong className="order-amount-total">{posted.text}</strong><p className="order-amount-label">{posted.label}</p></>
        : settledUnread
          ? <><strong className="order-amount-total is-unknown">{readFailed ? "结算金额暂时无法读取" : facts ? "暂无可用结算金额" : "正在读取结算金额"}</strong><p className="order-amount-label">下单时的费用记录仍可查看</p></>
          : <><strong className="order-amount-total">{formatOrderMoney(order.quote?.ownerTotal)}</strong><p className="order-amount-label">下单时号主报价</p></>}
      {posted || settledUnread ? <dl className="order-facts order-amount-rows">
        <div><dt>下单时号主报价</dt><dd>{formatOrderMoney(order.quote?.ownerTotal)}</dd></div>
      </dl> : null}
      <p className="order-muted">{posted ? "最终以结算记录为准；报价不代表已赚取或可提现。" : "按上架时约定的报价展示，不代表已赚取或可提现。"}</p>
    </section>;
  }

  const lead = settledUnread ? null : posted ?? {
    label: closed ? "下单金额" : order.status === "PENDING_PAYMENT" ? "待支付" : "租客已付",
    text: formatOrderMoney(amounts?.totalDue),
  };
  return <section className="order-side-card order-amount-block">
    <h2 className="order-section-title">租客侧金额</h2>
    {lead ? <><strong className="order-amount-total">{lead.text}</strong><p className="order-amount-label">{lead.label}</p></>
      : <><strong className="order-amount-total is-unknown">{readFailed ? "结算金额暂时无法读取" : facts ? "暂无可用结算金额" : "正在读取结算金额"}</strong><p className="order-amount-label">下单时的费用记录仍可查看</p></>}
    {posted || settledUnread ? <dl className="order-facts order-amount-rows">
      <div><dt>{renterFigureLabel(order)}</dt><dd>{formatOrderMoney(amounts?.totalDue)}</dd></div>
    </dl> : null}
    <dl className="order-facts order-amount-parts">
      <div><dt>{paid && !closed ? "租赁预付" : "租赁费用"}</dt><dd>{formatOrderMoney(amounts?.rental)}</dd></div>
      <div><dt>租客押金</dt><dd>{formatOrderMoney(amounts?.deposit)}</dd></div>
    </dl>
    {closed ? <p className="order-muted">本金额为下单时的订单快照，不代表已扣款或应退款。</p> : null}
    {paid || order.status === "COMPLETED" ? <p className="order-side-link"><WalletCards size={14} aria-hidden="true" />退款到账结果待确认时，可在<Link href="/account?view=wallet" scroll={false}>我的钱包</Link>查看实际记录。</p> : null}
  </section>;
}

function ContactCard({ order, party, onChanged, quiet }: { order: Order; party: OrderParty; onChanged: () => void; quiet: boolean }) {
  if (!order.fulfillmentAssignment) return null;
  const value = order.fulfillmentAssignment;
  const copy = value.state === "WAITING"
    ? value.waitingReason === "NO_ELIGIBLE_STAFF" ? "当前暂无可用客服，正在等待平台调度。" : "等待客服分配；分配与建群都不等于开租。"
    : value.state === "ASSIGNED" && value.teamReady ? "订单群已就绪，可在订单群中与客服、对方核对交付事项。"
    : value.state === "ASSIGNED" ? "客服已分配，订单群准备中。" : "履约状态待确认。";
  return <section className="order-side-card">
    <h2 className="order-section-title">履约与沟通</h2>
    <p className="order-contact-copy"><MessageCircle size={16} aria-hidden="true" />{copy}</p>
    {quiet ? null : <div className="order-contact-actions">
      <button type="button" className="button secondary" data-support-trigger onClick={() => window.dispatchEvent(new CustomEvent("zzsh:order-groups", { detail: { party, orderId: order.id } }))}><MessageCircle size={15} aria-hidden="true" />打开订单群</button>
      <button type="button" className="button quiet" onClick={onChanged}><RefreshCw size={15} aria-hidden="true" />刷新订单</button>
    </div>}
  </section>;
}

export function OrderDetail({ party, status, accountId, orderId, state, onRetry, onLogin, onChanged }: {
  party: OrderParty;
  status: OrderStatusFilter;
  accountId?: string;
  orderId: string;
  state: DetailState;
  onRetry: () => void;
  onLogin: () => void;
  onChanged: () => void;
}) {
  const backHref = orderUrl(party, status, accountId);
  const title = party === "renter" ? "租入订单" : "出租订单";
  const [read, setRead] = useState<{ facts: OrderStageFacts | null; failed: boolean }>({ facts: null, failed: false });
  const facts = read.facts;
  const back = <Link className="order-detail-back" href={backHref} scroll={false}><ArrowLeft size={16} aria-hidden="true" />返回{title}</Link>;
  if (state.status === "loading") return <section className="order-detail-view" data-testid="order-detail-loading" aria-busy="true" role="status"><div className="order-detail-loading account-module-card"><span /><span /><span /></div></section>;
  if (state.status === "error" && state.error) return <section className="order-detail-view">{back}<OrderError error={state.error} first={false} onRetry={onRetry} onLogin={onLogin} label="订单详情暂时无法读取" /></section>;
  if (state.status !== "ready" || !state.order) return <section className="order-detail-view">{back}<section className="order-error-block" role="status"><XCircle size={24} aria-hidden="true" /><h3>订单不可用</h3><p>当前身份没有这笔订单的可用详情，未展示另一方私人资料。</p></section></section>;
  const order = state.order;
  const attention = attentionFor(order, facts, read.failed, party);
  return <section className="order-detail-view" data-testid="order-detail">
    {back}
    {/* Identity band: the account is the subject, the order number identifies the transaction, and the
        status pill is stated once here and nowhere else. */}
    <header className="order-detail-hero">
      <div className="order-detail-hero-copy">
        <h1 className="order-detail-title">{orderAccountTitle(order)}</h1>
        <p className="order-detail-meta">
          <span className="order-detail-no">订单 {order.displayNo ?? "待确认"}<CopyOrderNo value={order.displayNo} /></span>
          {party === "owner" ? <span>租客：{order.renterName ?? "暂不显示"}</span> : null}
          <span>下单 {timeText(order.createdAt)}</span>
          <span>{orderTermLabel(order)}</span>
        </p>
        <div className="order-detail-status">
          <OrderStatusBadge order={order} />
        </div>
      </div>
    </header>
    <AttentionBlock attention={attention} party={party} orderId={order.id} onRetry={onChanged} />
    <div className="order-detail-body">
      <div className="order-detail-main">
        {order.status !== "CANCELLED" ? <OrderTradeActions order={order} party={party} onChanged={onChanged} onStageFacts={(next, failed) => setRead({ facts: next, failed })} /> : null}
        <section className="order-detail-section order-lines">
          <details open={order.status === "PENDING_PAYMENT" || order.status === "PAID"}>
            <summary><h2 className="order-section-title">下单时费用明细</h2><span className="order-lines-summary">{linesSummary(order, party)}</span></summary>
            <OrderLines order={order} party={party} />
          </details>
        </section>
        <OrderTimeline order={order} facts={facts} party={party} />
      </div>
      <aside className="order-detail-aside">
        <AmountCard order={order} party={party} facts={facts} readFailed={read.failed} />
        <ContactCard order={order} party={party} onChanged={onChanged} quiet={Boolean(attention)} />
      </aside>
    </div>
  </section>;
}
