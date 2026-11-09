"use client";
import { BusinessUpdateNotices } from "@/components/content/platform-update-notices";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, Check, CheckCircle2, CircleSlash, Clock3, Copy, Gamepad2, MessageCircle, RefreshCw, UserRound, WalletCards, XCircle } from "lucide-react";
import { formatOrderMoney, formatOrderTime as timeText, orderApi, OrderRequestError, type Order, type OrderImProjection, type OrderParty, type OrderStatusFilter, type OrderSearchFilters, type PersonalAbnormalResponsibility, type PersonalRefundIntent, type PersonalRefundRead } from "@/lib/order-client";
import { useUserSession } from "@/components/session/user-session-provider";
import { useIdentityReset } from "@/components/session/identity-reset";
import { ORDER_FULFILLMENT_STEPS, orderFulfillmentStepStates, orderFulfillmentSummary, orderLineQuantityText, orderLinesTotalLabel, orderListingSourceLabel, orderRentalModeLabel, orderSettlementStageLabel, orderUnitPriceText, unitLabel, orderAccountTitle, orderResourceLines, orderProgressView, type OrderProgressAction, type OrderProgressView } from "@/lib/order-display";
import { OrderTradeActions, type OrderStageFacts } from "@/components/order/order-trade-actions";
import { OrderAftersale } from "./order-aftersale";
import { PrestartTerminationPanel } from "@/components/order/prestart-termination-panel";
import { OrderError, OrderStatusBadge, orderTermLabel, orderUrl, statusLabel } from "@/components/order/order-presentation";
import { OrderAccountDossier } from "./order-account-dossier";
import "./order.css";

type DetailState = { status: "loading" } | { status: "ready"; order: Order | null; error: OrderRequestError | null } | { status: "error"; error: OrderRequestError | null };

/** What still needs a decision from the reader. The order's own state lives in the identity band. */
type Attention = { tone: "info" | "warning"; title: string; note: string; actions: Array<"retry" | "group" | "browse" | "manage"> } | null;

function attentionFor(order: Order, facts: OrderStageFacts | null, readFailed: boolean, party: OrderParty): Attention {
  if (order.fundsResolution?.code === "HISTORICAL_MANUAL_CLOSE") return {
    tone: "warning", title: "订单已关闭，资金处理未确认", note: "原人工关闭没有自动完成结算或退款。请联系平台核对原付款与资金处理记录，勿将订单关闭理解为退款已到账。", actions: ["group"],
  };
  if (facts?.phase === "DECISION_REJECTED") {
    return {
      tone: "warning",
      title: facts.rejectedBy && facts.rejectedBy !== party.toUpperCase() ? `第${facts.settlementVersionNo ?? "?"}版结算未达成一致` : `你已拒绝第${facts.settlementVersionNo ?? "?"}版结算`,
      note: "拒绝后，当前方案不会生效。新方案生成后，请重新核对。",
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
      title: order.cancelReason === "PRESTART_TERMINATED" ? "未开租订单已终止" : order.cancelReason === "MANUAL_CLOSE" ? "客服已手动结束本单" : "账号占用已解除",
      note: order.cancelReason === "PRESTART_TERMINATED" ? "账号占用已解除，退款处理进度见下方记录。终止订单不代表退款已到账。"
        : order.cancelReason === "MANUAL_CLOSE" ? "已收款不会自动结算或退款；资金处理以客服通知与对账为准，沟通权限以订单群当前提示为准。" : "本单不再产生新的交易动作；已确认的订单信息仍可查看。",
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
      {attention.actions.includes("group") ? <button type="button" className="button secondary button--sm" data-support-trigger onClick={() => window.dispatchEvent(new CustomEvent("zzsh:order-groups", { detail: { party, orderId } }))}><MessageCircle size={15} aria-hidden="true" />打开订单群列表</button> : null}
      {attention.actions.includes("browse") ? <Link href="/accounts" className="button secondary button--sm">浏览可租账号</Link> : null}
      {attention.actions.includes("manage") ? <Link href="/account?view=accounts" className="button secondary button--sm">管理上架账号</Link> : null}
      {attention.actions.includes("retry") ? <button type="button" className="order-attention-link" onClick={onRetry}>重试读取</button> : null}
    </div>
  </section>;
}

/**
 * One decision, one primary action, facts on demand. The primary action only locates the page's
 * single real control (or the support host); it never submits a write, so there is no second
 * idempotency path and no duplicate capability to keep in sync with the server.
 */
const PROGRESS_ANCHORS: Partial<Record<OrderProgressAction["target"], string>> = {
  trade: "order-trade-actions",
  legacy: "order-legacy-continuation",
  refund: "order-refund-section",
};

function OrderProgressCard({ view, party, orderId, backHref, onRefresh }: {
  view: OrderProgressView;
  party: OrderParty;
  orderId: string;
  backHref: string;
  onRefresh: () => void;
}) {
  const focusAnchor = (id: string) => {
    if (typeof document === "undefined") return;
    const target = document.getElementById(id);
    // A refund section can be legitimately absent (not applicable / not readable yet). Never let a
    // primary action become a dead click: land on the detail body and keep keyboard focus somewhere.
    const fallback = target ? null : document.getElementById("order-detail-body");
    const node = target ?? fallback;
    if (!node) return;
    try {
      const reduced = typeof window !== "undefined" && typeof window.matchMedia === "function"
        && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      node.scrollIntoView?.({ behavior: reduced ? "auto" : "smooth", block: "start" });
    } catch { /* scrolling is a convenience, never a fact about the order */ }
    if (fallback) {
      try { fallback.focus?.({ preventScroll: true }); } catch { /* focus is best-effort */ }
      return;
    }
    const focusable = node.querySelector<HTMLElement>("button.button.primary, a.button.primary, button.button, a.button, summary, input, [tabindex]");
    try { focusable?.focus?.({ preventScroll: true }); } catch { /* focus is best-effort */ }
  };
  const run = (action: OrderProgressAction) => {
    if (action.target === "refresh") { onRefresh(); return; }
    if (action.target === "groups") {
      window.dispatchEvent(new CustomEvent("zzsh:order-groups", { detail: { party, orderId } }));
      return;
    }
    const anchor = PROGRESS_ANCHORS[action.target];
    if (anchor) focusAnchor(anchor);
  };
  const actionNode = (action: OrderProgressAction, primary: boolean) => {
    const icon = action.target === "groups" ? <MessageCircle size={15} aria-hidden="true" />
      : action.target === "refresh" ? <RefreshCw size={15} aria-hidden="true" /> : null;
    const href = action.target === "list" ? backHref : action.href;
    const className = primary ? "button primary" : "button quiet button--sm";
    if (href) return <Link key={`${action.target}:${action.label}`} className={className} href={href} scroll={false}>{icon}{action.label}</Link>;
    return <button key={`${action.target}:${action.label}`} type="button" className={className} onClick={() => run(action)}>{icon}{action.label}</button>;
  };
  return <section className="order-progress-card" data-tone={view.tone} data-terminal={view.noNewTransaction ? "true" : undefined} data-testid="order-progress-card" aria-label="当前进度与下一步">
    <div className="order-progress-head">
      <span className="order-progress-label">下一步</span>
      <span className="order-progress-owner">{view.pendingRead ? "进度核对中" : view.owner === "暂无" ? "暂无待处理动作" : `由${view.owner}处理`}</span>
    </div>
    <h2 className="order-progress-title">{view.title}</h2>
    <p className="order-progress-note">{view.note}</p>
    <div className="order-progress-actions">
      {view.primary ? actionNode(view.primary, true) : null}
      {view.secondary.map(action => actionNode(action, false))}
    </div>
    <details className="order-progress-facts" open={view.pendingRead || view.tone === "unknown"}>
      <summary>本页已确认的事实</summary>
      <ul>{view.known.map(fact => <li key={fact}>{fact}</li>)}</ul>
    </details>
  </section>;
}

type StageReadState = { scope: string; status: "loading" | "ready" | "failed"; projection: OrderImProjection | null };

/**
 * A compact six-step bar. It is read-only: the stage comes from the order IM projection, the group
 * entry reuses the existing support host, and a missing projection says "阶段未确认" rather than
 * deriving progress from the order status.
 */
function FulfillmentStageBar({ order, party, facts }: { order: Order; party: OrderParty; facts: OrderStageFacts | null }) {
  const session = useUserSession();
  const userId = session.status === "authenticated" ? session.userId : null;
  const scope = userId ? `${userId}:${order.id}:${order.status}` : "";
  const [state, setState] = useState<StageReadState>({ scope: "", status: "loading", projection: null });
  const confirm = useRef(session.confirm);
  confirm.current = session.confirm;
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    setState({ scope, status: "loading", projection: null });
    void orderApi.orderIm(order.id, controller.signal).then((projection) => {
      if (!controller.signal.aborted) setState({ scope, status: "ready", projection });
    }).catch((error: unknown) => {
      if (controller.signal.aborted) return;
      const typed = error instanceof OrderRequestError ? error : new OrderRequestError(0, null);
      if (typed.status === 401 || typed.code === "UNAUTHENTICATED") void confirm.current();
      setState({ scope, status: "failed", projection: null });
    });
    return () => controller.abort();
  }, [order.id, order.status, scope, userId]);
  const visible = state.scope === scope ? state : { scope, status: "loading" as const, projection: null };
  const projection = visible.status === "ready" ? visible.projection : null;
  const ending = facts?.phase === "DECISION_PENDING" ? "PENDING" as const
    : facts?.phase === "DECISION_REJECTED" ? "REJECTED" as const
    : facts?.phase === "DECISION_WAITING" ? "WAITING" as const
    : facts?.phase === "INTAKE_PENDING" ? "SERVICE" as const
    : null;
  const summary = projection
    ? orderFulfillmentSummary(projection, { ending })
    : visible.status === "failed" ? "阶段未确认" : "阶段核对中…";
  const steps = projection ? orderFulfillmentStepStates(projection.stage) : null;
  const tone = !projection ? "unknown" : projection.stage === "SETTLED" ? "done" : projection.stage === "CANCELLED" ? "closed" : "active";
  return <section className="order-fulfillment-stage" data-stage={projection?.stage ?? "UNKNOWN"} data-tone={tone} aria-label="履约阶段">
    <div className="order-fulfillment-head">
      <span className="order-fulfillment-dot" aria-hidden="true" />
      <p className="order-fulfillment-summary" role="status">{summary}</p>
      <button type="button" className="button quiet button--sm" data-support-trigger onClick={() => window.dispatchEvent(new CustomEvent("zzsh:order-groups", { detail: { party, orderId: order.id } }))}><MessageCircle size={15} aria-hidden="true" />打开订单群</button>
    </div>
    {steps ? <ol className="order-fulfillment-steps" aria-label="六个履约阶段">{ORDER_FULFILLMENT_STEPS.map((step, index) => {
      const stepState = steps[index] ?? "unknown";
      return <li key={step.key} data-state={stepState} aria-current={stepState === "current" ? "step" : undefined}><span className="order-fulfillment-step-dot" aria-hidden="true" />{step.label}</li>;
    })}</ol> : null}
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
      label: `取消${order.cancelReason === "USER" ? "（租客取消）" : order.cancelReason === "TIMEOUT" ? "（到期未支付）" : order.cancelReason === "SUPPORT_UNPAID" ? "（客服处理）" : order.cancelReason === "PRESTART_TERMINATED" ? "（未开租终止）" : ""}`,
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
        <time>{event.time ? timeText(event.time) : "未记录"}</time>
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
  if (lines.length === 0) return <p className="order-muted">暂无可展示的费用明细，可稍后查看或联系客服。</p>;
  const total = party === "owner" ? order.quote?.ownerTotal : order.amounts?.rental;
  return <>
    <div className="order-table-wrap">
      <table><thead><tr><th scope="col">资源</th><th scope="col">数量</th><th scope="col">{party === "owner" ? "号主报价" : "金额"}</th></tr></thead>
        <tbody>{lines.map((line, index) => {
          const unitPrice = orderUnitPriceText(party === "owner" ? line.ownerUnitAmount : line.buyerUnitAmount, line.unitQuantity, line.unit);
          return <tr key={`${line.itemId ?? line.name ?? line.unit ?? "line"}-${index}`}>
            <td data-label="资源"><span>{line.name ?? unitLabel(line.unit) ?? "资源未记录"}</span>{unitPrice ? <small className="order-line-unit">{unitPrice}</small> : null}</td>
            <td data-label="数量">{orderLineQuantityText(line)}</td>
            <td data-label={party === "owner" ? "号主报价" : "金额"}>{formatOrderMoney(party === "owner" ? line.ownerAmount : line.buyerAmount)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    <p className="order-lines-total">{orderLinesTotalLabel(party)} <strong>{formatOrderMoney(total)}</strong></p>
    {order.quote?.unitAmountsInformational ? <p className="order-lines-note">明细为下单时的费用记录，最终金额请查看结算明细。</p> : null}
  </>;
}

/** Each party sees its own quoted amounts; a missing owner total stays unknown instead of borrowing the renter's. */
function linesSummary(order: Order, party: OrderParty): string {
  const count = order.quote?.lines?.length ?? 0;
  if (!count) return "明细未记录";
  if (party === "owner") return order.quote?.ownerTotal ? `号主报价合计 ${formatOrderMoney(order.quote.ownerTotal)}` : "号主报价 · 合计未记录";
  return `费用 ${count} 项 · ${orderLinesTotalLabel(party)} ${formatOrderMoney(order.amounts?.rental)}`;
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
  return order.status === "PENDING_PAYMENT" ? "待支付金额" : "下单金额";
}

function AmountCard({ order, party, facts, readFailed }: { order: Order; party: OrderParty; facts: OrderStageFacts | null; readFailed: boolean }) {
  const amounts = order.amounts;
  const closed = order.status === "CANCELLED";
  const paid = Boolean(order.paidAt);
  const posted = facts?.phase === "POSTED" && facts.settled && facts.settled.text !== "—" ? facts.settled : null;
  const settledUnread = order.status === "COMPLETED" && !posted;

  if (party === "owner") {
    return <section className="order-side-card order-amount-block">
      <h2 className="order-section-title">{posted || settledUnread ? "本单结算" : "下单时的出租报价"}</h2>
      {posted
        ? <><strong className="order-amount-total">{posted.text}</strong><p className="order-amount-label">{posted.label}</p></>
        : settledUnread
          ? <><strong className="order-amount-total is-unknown">{readFailed ? "结算金额暂时无法读取" : facts ? "暂无可用结算金额" : "正在读取结算金额"}</strong><p className="order-amount-label">下单时的费用记录仍可查看</p></>
          : <strong className="order-amount-total">{formatOrderMoney(order.amounts?.ownerExpectedIncome ?? order.quote?.ownerTotal)}</strong>}
      {posted || settledUnread ? <dl className="order-facts order-amount-rows">
        <div><dt>下单时的出租报价</dt><dd>{formatOrderMoney(order.amounts?.ownerExpectedIncome ?? order.quote?.ownerTotal)}</dd></div>
      </dl> : null}
      {!posted ? <p className="order-muted">实际收入以结算结果为准。</p> : null}
      {posted ? <p className="order-side-link"><WalletCards size={14} aria-hidden="true" /><Link href="/account?view=wallet" scroll={false}>查看钱包</Link></p> : null}
    </section>;
  }

  const lead = settledUnread ? null : posted ?? {
    label: order.status === "PENDING_PAYMENT" ? "待支付" : "下单金额",
    text: formatOrderMoney(amounts?.totalDue),
  };
  return <section className="order-side-card order-amount-block">
    <h2 className="order-section-title">我的订单费用</h2>
    {lead ? <><strong className="order-amount-total">{lead.text}</strong><p className="order-amount-label">{lead.label}</p></>
      : <><strong className="order-amount-total is-unknown">{readFailed ? "结算金额暂时无法读取" : facts ? "暂无可用结算金额" : "正在读取结算金额"}</strong><p className="order-amount-label">下单时的费用记录仍可查看</p></>}
    {posted || settledUnread ? <dl className="order-facts order-amount-rows">
      <div><dt>{renterFigureLabel(order)}</dt><dd>{formatOrderMoney(amounts?.totalDue)}</dd></div>
    </dl> : null}
    <dl className="order-facts order-amount-parts">
      <div><dt>{paid && !closed ? "租赁预付" : "租赁费用"}</dt><dd>{formatOrderMoney(amounts?.rental)}</dd></div>
      <div><dt>租客押金</dt><dd>{formatOrderMoney(amounts?.deposit)}</dd></div>
    </dl>
    {closed ? <p className="order-muted">{order.cancelReason === "PRESTART_TERMINATED" && paid ? "退款进度请查看本页。"
      : order.cancelReason === "MANUAL_CLOSE" && paid ? "退款进度请联系客服核对。"
      : "这是下单时的金额，实际扣费和退款请查看订单进度。"}</p> : null}
  </section>;
}

function ContactCard({ order, onChanged, quiet }: { order: Order; onChanged: () => void; quiet: boolean }) {
  if (!order.fulfillmentAssignment) return null;
  const value = order.fulfillmentAssignment;
  const ended = order.status === "COMPLETED" || order.status === "CANCELLED" || order.readOnly === true;
  const copy = value.state === "WAITING"
    ? value.waitingReason === "NO_ELIGIBLE_STAFF" ? "当前暂无可用客服，正在等待平台调度。" : "等待客服分配；分配与建群都不等于开租。"
    : value.state === "ASSIGNED" && value.teamReady
      ? ended
        ? order.cancelReason === "PRESTART_TERMINATED"
          ? "本单未开租终止；退款处理期间订单群仍可沟通，窗口以群内提示为准。"
          : "本单已结束，沟通权限以订单群当前提示为准；如需进一步核对请联系客服。"
        : "订单群已就绪，可在订单群中与客服、对方核对交付事项。"
    : value.state === "ASSIGNED" ? "客服已分配，订单群准备中。" : "履约状态未记录。";
  return <section className="order-side-card">
    <h2 className="order-section-title">履约与沟通</h2>
    <p className="order-contact-copy"><MessageCircle size={16} aria-hidden="true" />{copy}</p>
    {value.state === "ASSIGNED" ? <dl className="order-facts order-contact-facts">
      <div><dt>客服分配</dt><dd>{value.assignedAt ? timeText(value.assignedAt, { timeZoneName: false }) : "时间未记录"}</dd></div>
      <div><dt>订单群</dt><dd>{value.teamReady ? "已就绪" : value.teamState ? "尚未就绪" : "状态未记录"}</dd></div>
    </dl> : null}
    {quiet ? null : <div className="order-contact-actions">
      <button type="button" className="button quiet" onClick={onChanged}><RefreshCw size={15} aria-hidden="true" />刷新订单</button>
    </div>}
  </section>;
}

const refundOutcomeCopy: Record<PersonalRefundRead["outcome"], { label: string; note: string }> = {
  RESPONSIBILITY_NOT_POSTED: { label: "退款金额未记录", note: "如有退款，进度会显示在这里。" },
  ZERO_RESPONSIBILITY: { label: "本次结算应退为零", note: "其他退款事项会单独显示。" },
  NOT_DUE: { label: "退款尚未到期", note: "到期不代表退款已处理或到账。" },
  NO_INTENT: { label: "退款进度未记录", note: "如有疑问，请联系客服。" },
  PARTIALLY_ALLOCATED: { label: "退款进度未记录", note: "到账情况请以收款记录为准。" },
  FULLY_ALLOCATED: { label: "退款进度未记录", note: "到账情况请以收款记录为准。" },
  PARTIALLY_CONSUMED: { label: "退款进度未记录", note: "到账情况请以收款记录为准。" },
  FULLY_CONSUMED: { label: "退款进度未记录", note: "到账情况请以收款记录为准。" },
  RELEASED: { label: "退款进度未记录", note: "如有疑问，请联系客服。" },
  PROCESSING: { label: "退款处理中", note: "到账情况请以收款记录为准。" },
  UNKNOWN: { label: "退款结果未记录", note: "请稍后查看，或联系客服。" },
  REVIEW_REQUIRED: { label: "退款需要核对", note: "如有疑问，请联系客服。" },
  TRUNCATED: { label: "部分退款记录未记录", note: "当前显示的记录可能不完整。" },
  CONFLICT: { label: "退款记录需要核对", note: "部分金额暂时无法确认，请联系客服。" },
};
const refundIntentStateLabel: Record<PersonalRefundIntent["state"], string> = {
  READY: "等待处理", SUBMITTING: "发送结果待核", UNKNOWN: "结果未记录", PROCESSING: "处理中",
  REVIEW_REQUIRED: "需要核对", SUCCEEDED: "到账未记录", FAILED: "申请处理失败", UNRECOGNIZED: "状态未记录",
};
const abnormalReasonLabel: Record<PersonalAbnormalResponsibility["reasonCode"], string> = { DUPLICATE_PAYMENT: "重复支付", LATE_PAYMENT: "支付时间异常", UNKNOWN_REASON: "其他付款" };
const abnormalStateLabel: Record<PersonalAbnormalResponsibility["state"], string> = {
  NO_INTENT: "待处理", READY: "待处理", PROCESSING: "处理中", UNKNOWN: "未记录", CONSUMED: "到账未记录", RELEASED: "未记录", REVIEW_REQUIRED: "需要核对", CONFLICT: "需要核对",
};

function refundMoney(cents: string | null): string {
  if (cents === null) return "未记录";
  const value = BigInt(cents);
  return `¥${(value / 100n).toLocaleString("zh-CN")}.${(value % 100n).toString().padStart(2, "0")}`;
}

function AbnormalResponsibilityCard({ item }: { item: PersonalAbnormalResponsibility }) {
  return <li className="order-refund-intent order-refund-abnormal-item">
    <div className="order-refund-intent-head"><strong>{abnormalReasonLabel[item.reasonCode]}</strong><span className="order-refund-state">{abnormalStateLabel[item.state]}</span></div>
    <dl className="order-facts order-refund-intent-facts"><div><dt>相关金额</dt><dd>{item.totalsComplete ? refundMoney(item.originalCents) : "未记录"}</dd></div></dl>
    {item.firstSubmit?.dispatch === "NEVER_DISPATCHED" && item.firstSubmit.blockedReason ? <p className="order-muted">暂时无法提交，请联系客服。</p> : null}
  </li>;
}

function RefundIntentCard({ intent }: { intent: PersonalRefundIntent }) {
  const stateLabel = intent.source === "LOCAL_CONTROLLED" && intent.state === "SUCCEEDED" ? "模拟退款已记录" : refundIntentStateLabel[intent.state];
  return <li className="order-refund-intent">
    <div className="order-refund-intent-head"><strong>{intent.refundOrderNo ?? "退款申请"}</strong><span className="order-refund-state">{stateLabel}</span></div>
    <dl className="order-facts order-refund-intent-facts">
      <div><dt>申请金额</dt><dd>{intent.amount ? refundMoney(intent.amount.cents) : "未记录"}</dd></div>
      {intent.createdAt ? <div><dt>申请时间</dt><dd>{timeText(intent.createdAt, { timeZoneName: false })}</dd></div> : null}
    </dl>
    {intent.source === "LOCAL_CONTROLLED" ? <p className="order-muted">测试记录，不代表真实退款。</p> : null}
    {intent.requiresReview ? <p className="order-muted">这笔退款需要核对，请联系客服。</p> : null}
  </li>;
}


function OrderOwnerRefundSummary({ order }: { order: Order }) {
  const session = useUserSession();
  const [state, setState] = useState<{ scope: string; status: "loading" | "ready" | "error"; read: import("@/lib/order-client").OwnerRefundMinimalSummary | null; error: OrderRequestError | null }>({ scope: "", status: "loading", read: null, error: null });
  const [reload, setReload] = useState(0);
  const reset = useCallback(() => setState({ scope: "", status: "loading", read: null, error: null }), []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  const current = useRef(isCurrent); current.current = isCurrent;
  const confirm = useRef(session.confirm); confirm.current = session.confirm;
  const scope = userId ? `${userId}:${order.id}:${order.status}:owner-refund` : "";
  const visible = state.scope === scope ? state : { scope, status: "loading" as const, read: null, error: null };
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    setState({ scope, status: "loading", read: null, error: null });
    void orderApi.ownerRefundSummary(userId, order.id, controller.signal).then((read) => {
      if (!controller.signal.aborted && current.current(userId) && scope.endsWith(":owner-refund")) setState({ scope, status: "ready", read, error: null });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !current.current(userId)) return;
      const typed = error instanceof OrderRequestError ? error : new OrderRequestError(0, null);
      if (typed.status === 401 || typed.code === "UNAUTHENTICATED") void confirm.current();
      setState({ scope, status: "error", read: null, error: typed });
    });
    return () => controller.abort();
  }, [order.id, order.status, reload, scope, userId]);
  if (!userId) return null;
  const refresh = <button type="button" className="button quiet button--sm" disabled={visible.status === "loading"} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />刷新</button>;
  if (visible.status === "loading") return <section className="order-detail-section order-refund-block" id="order-refund-section" aria-label="退款进度"><h2 className="order-section-title">退款进度</h2><p className="order-muted" role="status">正在加载退款进度…</p></section>;
  if (visible.status === "error") {
    return <section className="order-detail-section order-refund-block" id="order-refund-section" aria-label="退款进度"><div className="order-refund-heading"><h2 className="order-section-title">退款进度</h2>{refresh}</div><p className="order-muted" role="status">退款进度暂时无法查看，请稍后重试。</p></section>;
  }
  const read = visible.read;
  if (!read || read.progress === "NOT_APPLICABLE") return null;
  const open = ["PROCESSING", "NEEDS_REVIEW", "UNKNOWN"].includes(read.progress);
  return <section className="order-detail-section order-refund-block" id="order-refund-section" aria-label="退款进度" data-progress={read.progress}>
    <div className="order-refund-heading"><h2 className="order-section-title">退款进度</h2>{refresh}</div>
    <details className="order-secondary-details order-refund-details" open={open}>
      <summary><strong>{read.label}</strong><span>{read.note}</span></summary>
      <div className="order-refund-detail-content">
        <p className="order-muted">订单主状态仍以页面顶部为准。本摘要不展示租客收款资料。</p>
        {read.openIntentCount > 0 ? <p className="order-muted">进行中的退款处理记录：{read.openIntentCount} 笔</p> : null}
      </div>
    </details>
  </section>;
}

function OrderRefundSection({ order }: { order: Order }) {
  const session = useUserSession();
  const [state, setState] = useState<{ scope: string; status: "loading" | "ready" | "error"; read: PersonalRefundRead | null; error: OrderRequestError | null }>({ scope: "", status: "loading", read: null, error: null });
  const [reload, setReload] = useState(0);
  const reset = useCallback(() => setState({ scope: "", status: "loading", read: null, error: null }), []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  const current = useRef(isCurrent); current.current = isCurrent;
  const confirm = useRef(session.confirm); confirm.current = session.confirm;
  const scope = userId ? `${userId}:${order.id}:${order.status}` : "";
  const visible = state.scope === scope ? state : { scope, status: "loading" as const, read: null, error: null };
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    setState({ scope, status: "loading", read: null, error: null });
    void orderApi.personalRefunds(userId, order.id, controller.signal).then((read) => {
      if (!controller.signal.aborted && current.current(userId) && scope === `${userId}:${order.id}:${order.status}`) setState({ scope, status: "ready", read, error: null });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !current.current(userId) || scope !== `${userId}:${order.id}:${order.status}`) return;
      const typed = error instanceof OrderRequestError ? error : new OrderRequestError(0, null);
      if (typed.status === 401 || typed.code === "UNAUTHENTICATED") void confirm.current();
      setState({ scope, status: "error", read: null, error: typed });
    });
    return () => controller.abort();
  }, [order.id, order.status, reload, scope, userId]);
  if (!userId) return null;
  const refresh = <button type="button" className="button quiet button--sm" disabled={visible.status === "loading"} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />刷新</button>;
  if (visible.status === "loading") return <section className="order-detail-section order-refund-block" id="order-refund-section" aria-label="退款进度"><h2 className="order-section-title">退款进度</h2><p className="order-muted" role="status">正在加载退款进度…</p></section>;
  if (visible.status === "error") {
    const error = visible.error ?? new OrderRequestError(0, null);
    const copy = error.status === 401 || error.code === "UNAUTHENTICATED" ? "登录状态已变化，请重新登录后查看。" : "退款进度暂时无法查看，请稍后重试。";
    return <section className="order-detail-section order-refund-block" id="order-refund-section" aria-label="退款进度"><div className="order-refund-heading"><h2 className="order-section-title">退款进度</h2>{refresh}</div><div className="order-notice is-warning" role="alert"><CircleSlash size={17} aria-hidden="true" /><div><strong>{copy}</strong>{error.requestId ? <span>查询编号：{error.requestId}</span> : null}</div></div></section>;
  }
  const read = visible.read;
  if (!read) return null;
  const responsibility = read.responsibility;
  const attentionRequired = ["UNKNOWN", "REVIEW_REQUIRED", "TRUNCATED", "CONFLICT"].includes(read.outcome);
  const incomplete = read.responsibilitiesTruncated || read.intentsTruncated || !read.coverage.intentsComplete || Boolean(read.responsibilityTotals && !read.responsibilityTotals.totalsComplete) || responsibility.state === "POSTED" && !responsibility.totalsComplete;
  const simulated = read.outcome === "FULLY_CONSUMED" && !incomplete && read.intents.length > 0
    && read.intents.every(intent => intent.source === "LOCAL_CONTROLLED" && intent.state === "SUCCEEDED" && intent.budgetDisposition === "CONSUMED");
  const outcome = simulated ? { label: "模拟退款已记录", note: "测试记录，不代表实际退款或到账。" } : refundOutcomeCopy[read.outcome];
  return <section className="order-detail-section order-refund-block" id="order-refund-section" aria-label="退款进度" data-outcome={read.outcome}>
    <div className="order-refund-heading"><h2 className="order-section-title">退款进度</h2>{refresh}</div>
    <details className="order-secondary-details order-refund-details" open={attentionRequired}>
      <summary><strong>{outcome.label}</strong><span>{outcome.note}</span></summary>
      <div className="order-refund-detail-content">
        {incomplete ? <p className="order-inline-notice" role="status">部分退款信息仍在核对，当前记录可能不完整。</p> : null}
        {responsibility.state === "POSTED" ? <dl className="order-facts order-refund-amounts">
          <div><dt>本次结算应退</dt><dd>{refundMoney(responsibility.originalCents)}</dd></div>
          {responsibility.dueAt ? <div><dt>退款到期时间</dt><dd>{timeText(responsibility.dueAt, { timeZoneName: false })}{responsibility.dueState === "DUE" ? "（已到期）" : responsibility.dueState === "NOT_DUE" ? "（未到期）" : "（状态未记录）"}</dd></div> : null}
        </dl> : null}
        {responsibility.state === "POSTED" && responsibility.dueAt ? <p className="order-muted">到期不代表退款已处理或到账。</p> : null}
        {read.abnormalResponsibilities?.length ? <section className="order-refund-abnormal" aria-label="其他付款处理">
          <div className="order-refund-intents-heading"><h3>其他付款处理</h3></div>
          <ul className="order-refund-intents">{read.abnormalResponsibilities.map(item => <AbnormalResponsibilityCard key={item.confirmationId} item={item} />)}</ul>
        </section> : null}
        {read.intents.length ? <section aria-label="退款申请记录"><div className="order-refund-intents-heading"><h3>退款申请</h3><span>{read.intentsTruncated || !read.coverage.intentsComplete ? "部分记录未记录" : `${read.returnedIntentCount} 笔`}</span></div><ul className="order-refund-intents">{read.intents.map(intent => <RefundIntentCard key={intent.intentId} intent={intent} />)}</ul></section> : null}
        <p className="order-muted">到账情况请以收款记录为准。</p>
      </div>
    </details>
  </section>;
}

function OrderEntitlements({ order }: { order: Order }) {
  const list = order.entitlements;
  if (!list?.length) {
    if (order.entitlementsUnknownReason && order.entitlementsUnknownReason !== "NOT_DISCLOSED") {
      return <section className="order-detail-section"><h2 className="order-section-title">订单权益</h2><p className="order-muted">该订单权益记录暂不可用。</p></section>;
    }
    return null;
  }
  return <section className="order-detail-section">
    <h2 className="order-section-title">订单权益</h2>
    <dl className="order-facts order-entitlements">
      {list.map((item) => <div key={item.id}>
        <dt>{item.name?.trim() || "权益名称未记录"}{item.nameSource === "CURRENT_CATALOG" ? <small className="order-source-note">名称取自当前目录</small> : item.nameSource === "UNKNOWN" ? <small className="order-source-note">名称尚未记录</small> : null}</dt>
        <dd>{item.expiryKind === "PERMANENT" ? "长期有效" : item.expiresAt ? `至 ${timeText(item.expiresAt, { timeZoneName: false })}` : "期限未记录"}{item.fullTermGuaranteed === false ? " · 不保证覆盖完整租期" : ""}</dd>
      </div>)}
    </dl>
  </section>;
}

export function OrderDetail({ party, status, accountId, orderId, filters, state, onRetry, onLogin, onChanged }: {
  party: OrderParty;
  status: OrderStatusFilter;
  filters?: OrderSearchFilters;
  accountId?: string;
  orderId: string;
  state: DetailState;
  onRetry: () => void;
  onLogin: () => void;
  onChanged: () => void;
}) {
  const backHref = orderUrl(party, status, accountId, undefined, undefined, filters);
  const title = party === "renter" ? "租入订单" : "出租订单";
  const session = useUserSession();
  const readScope = `${session.status === "authenticated" ? session.userId : ""}:${party}:${orderId}`;
  const [read, setRead] = useState<{ scope: string; facts: OrderStageFacts | null; failed: boolean }>({ scope: "", facts: null, failed: false });
  const facts = read.scope === readScope ? read.facts : null;
  const readFailed = read.scope === readScope && read.failed;
  const back = <Link className="order-detail-back" href={backHref} scroll={false}><ArrowLeft size={16} aria-hidden="true" />返回{title}</Link>;
  if (state.status === "loading") return <section className="order-detail-view" data-testid="order-detail-loading" aria-busy="true" role="status"><div className="order-detail-loading account-module-card"><span /><span /><span /></div></section>;
  if (state.status === "error" && state.error) return <section className="order-detail-view">{back}<OrderError error={state.error} first={false} onRetry={onRetry} onLogin={onLogin} label="订单详情暂时无法读取" /></section>;
  if (state.status !== "ready" || !state.order) return <section className="order-detail-view">{back}<section className="order-error-block" role="status"><XCircle size={24} aria-hidden="true" /><h3>订单不可用</h3><p>当前身份没有这笔订单的可用详情，未展示另一方私人资料。</p></section></section>;
  const order = state.order;
  if (order.viewerParty && order.viewerParty !== party) {
    const actualTitle = order.viewerParty === "owner" ? "出租订单" : "租入订单";
    return <section className="order-detail-view" data-testid="order-party-mismatch">{back}<section className="order-error-block" role="status"><h2>本单属于你的{actualTitle}</h2><p>请切换到对应订单查看金额和进度。</p><Link className="button primary" href={orderUrl(order.viewerParty, "", undefined, order.id)} scroll={false}>查看我的{actualTitle}</Link></section></section>;
  }
  const modeLabel = orderRentalModeLabel(order);
  const sourceLabel = orderListingSourceLabel(order);
  const stageLabel = orderSettlementStageLabel(order);
  const attention = attentionFor(order, facts, readFailed, party);
  const progress = orderProgressView({ order, party, facts, readFailed });
  return <section className="order-detail-view" data-testid="order-detail">
    {back}
    {/* Identity band: the account is the subject, the order number identifies the transaction, and the
        status pill is stated once here and nowhere else. */}
    <header className="order-detail-hero">
      <div className="order-detail-hero-copy">
        <h1 className="order-detail-title">{orderAccountTitle(order)}</h1>
        <p className="order-detail-meta">
          {order.accountDisplayNo ? <span className="order-detail-account-no">账号 {order.accountDisplayNo}</span> : null}
          {order.accountId ? <Link className="account-inline-link" href={party === "owner" ? `/account?view=accounts&accountId=${encodeURIComponent(order.accountId)}` : `/accounts/${encodeURIComponent(order.accountId)}`} scroll={false}>{party === "owner" ? "查看本人账号" : "查看当前公开资料"}</Link> : null}
          <span className="order-detail-no">订单 {order.displayNo ?? "未记录"}<CopyOrderNo value={order.displayNo} /></span>
          {party === "owner" ? <span>租客：{order.renterName ?? "暂不显示"}</span> : null}
          <span>下单 {timeText(order.createdAt, { timeZoneName: false })}</span>
          <span>{orderTermLabel(order)}</span>
          {!order.listingFacts && order.listingFactsUnknownReason ? <span>账号资料未确认</span> : null}
          {modeLabel ? <span className="order-detail-mode" data-mode={order.quote?.rentalMode}>{modeLabel}</span> : null}
          {sourceLabel ? <span className="order-source-note">{sourceLabel}</span> : null}
        </p>
        <div className="order-detail-status">
          <OrderStatusBadge order={order} />
          {stageLabel ? <span className={`order-stage-label${order.stage?.viewerActionRequired ? " is-action" : ""}`}>{stageLabel}</span> : null}
        </div>
      </div>
    </header>
    <OrderProgressCard view={progress} party={party} orderId={order.id} backHref={backHref} onRefresh={onChanged} />
    {order.source?.origin !== "LEGACY" && !order.readOnly && order.status !== "PENDING_PAYMENT" ? <FulfillmentStageBar order={order} party={party} facts={facts} /> : null}
    <BusinessUpdateNotices surface="orders" />
    <AttentionBlock attention={attention} party={party} orderId={order.id} onRetry={onChanged} />
    <div className="order-detail-overview">
      <AmountCard order={order} party={party} facts={facts} readFailed={readFailed} />
      <ContactCard order={order} onChanged={onChanged} quiet={Boolean(attention)} />
    </div>
    <div className="order-detail-body" id="order-detail-body" tabIndex={-1}>
      <div className="order-detail-main">
        {order.source?.origin!=="LEGACY"&&order.stage?.code==="POSTED"?<OrderAftersale key={`aftersale:${order.id}`} orderId={order.id} orderDisplayNo={order.displayNo??null}/>:null}
        {order.status !== "CANCELLED" ? <OrderTradeActions order={order} party={party} onChanged={onChanged} onStageFacts={(next, failed) => setRead({ scope: readScope, facts: next, failed })} /> : null}
        <PrestartTerminationPanel key={`prestart:${order.id}:${order.status}`} order={order} party={party} onChanged={onChanged}/>
        {party === "renter" && order.source?.origin !== "LEGACY" && !order.readOnly ? <OrderRefundSection key={`${order.id}:${order.status}:${facts?.phase ?? "NONE"}`} order={order} /> : null}
        {party === "owner" && order.source?.origin !== "LEGACY" && !order.readOnly && (order.status === "CANCELLED" || order.status === "COMPLETED") ? <OrderOwnerRefundSummary key={`owner-refund:${order.id}:${order.status}`} order={order} /> : null}
        <section className="order-detail-section order-lines">
          <details open={order.status === "PENDING_PAYMENT"}>
            <summary><h2 className="order-section-title">下单时费用明细</h2><span className="order-lines-summary">{linesSummary(order, party)}</span></summary>
            <OrderLines order={order} party={party} />
          </details>
        </section>
        <OrderAccountDossier
          accountId={order.accountId}
          accountDisplayNo={order.accountDisplayNo}
          party={party}
          listingFacts={order.listingFacts}
          orderResources={orderResourceLines(order)}
        />
        <OrderEntitlements order={order} />
        <OrderTimeline order={order} facts={facts} party={party} />
      </div>
    </div>
  </section>;
}
