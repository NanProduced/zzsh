"use client";
import { BusinessUpdateNotices } from "@/components/content/platform-update-notices";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { ArrowLeft, Check, CheckCircle2, CircleSlash, Clock3, Copy, Crown, Gamepad2, MessageCircle, RefreshCw, UserRound, WalletCards, XCircle } from "lucide-react";
import { captureOrderSubject, formatOrderMoney, formatOrderTime as timeText, isOrderSubjectCurrent, orderApi, OrderRequestError, type Order, type OrderImProjection, type OrderParty, type OrderSettlement, type OrderStatusFilter, type OrderSearchFilters, type PersonalRefundIntent, type PersonalRefundRead, type SettlementOpening } from "@/lib/order-client";
import { useUserSession } from "@/components/session/user-session-provider";
import { useIdentityReset } from "@/components/session/identity-reset";
import { requestSupportDialog } from "@/components/support/support-dialog-request";
import { haffMillionsText, matchingResourceDiscount, formatYuanFromCents, orderMembershipText, orderFulfillmentSteps, orderFulfillmentStepStates, orderFulfillmentSummary, orderLineQuantityText, orderLinesTotalLabel, orderListingSourceLabel, orderRentalModeLabel, orderUnitPriceText, quantityText, unitLabel, orderAccountTitle, orderResourceLines, orderProgressView, paymentEntryOpen, type OrderPaymentFacts, type OrderProgressAction, type OrderProgressView } from "@/lib/order-display";
import { formatReferenceYuan } from "@zzsh/ui/display-money";
import { activeOpening, PaymentFactsProbe, stageFacts, type OrderStageFacts } from "@/components/order/order-trade-actions";
import type { SettlementFocus } from "@/components/order/order-trade-actions";
import { OrderActionDialog } from "@/components/order/order-action-dialog";
import { OrderAftersaleDialog } from "@/components/order/order-aftersale-dialog";
import { PaymentDialog } from "@/components/order/payment-dialog";
import { PrestartTerminationPanel } from "@/components/order/prestart-termination-panel";
import { OrderError, OrderStatusBadge, orderTermLabel, orderUrl } from "@/components/order/order-presentation";
import { OrderAccountDossier } from "./order-account-dossier";
import "./order.css";

type DetailState = { status: "loading" } | { status: "ready"; order: Order | null; error: OrderRequestError | null } | { status: "error"; error: OrderRequestError | null };

/** What still needs a decision from the reader. The order's own state lives in the identity band. */
type Attention = { tone: "info" | "warning"; title: string; note: string; actions: Array<"retry" | "group" | "browse" | "manage"> } | null;

function attentionFor(order: Order, facts: OrderStageFacts | null, readFailed: boolean, party: OrderParty): Attention {
  if (order.fundsResolution?.code === "HISTORICAL_MANUAL_CLOSE") return {
    tone: "warning", title: "订单已关闭，资金处理未确认", note: "原人工关闭没有自动完成结算或退款。请联系平台核对原付款与资金处理记录，勿将订单关闭理解为退款已到账。", actions: ["group"],
  };
  if (facts?.feeReconfirmationRequired) return { tone: "warning", title: "结算方案待重新核对", note: "原方案的包赔费计算口径需要更正，请联系客服重新生成方案。", actions: ["group"] };
  if (facts?.phase === "DECISION_REJECTED" && facts.viewerActionRequired) {
    return {
      tone: "warning",
      title: facts.rejectedBy && facts.rejectedBy !== party.toUpperCase() ? `第${facts.settlementVersionNo ?? "?"}版结算未达成一致` : `你已拒绝第${facts.settlementVersionNo ?? "?"}版结算`,
      note: "拒绝后这一版不会生效，请联系客服生成新的结算方案。",
      actions: ["group"],
    };
  }
  if (order.status === "CANCELLED") {
    // Unpaid cancellations have no refund consequence; the single next step lives in the progress card.
    if (!order.paidAt) return null;
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
      note: "已展示的金额和时间不受影响，请重试或联系客服。",
      actions: ["retry", "group"],
    };
  }
  return null;
}

function AttentionBlock({ attention, onRetry, onGroups }: { attention: Attention; onRetry: () => void; onGroups: (trigger: HTMLElement) => void }) {
  if (!attention) return null;
  return <section className={`order-alert-band is-${attention.tone}`} role="status">
    <div className="order-alert-copy">
      <h2>{attention.title}</h2>
      <p>{attention.note}</p>
    </div>
    {/* One cluster. Talking to the person who fulfils the order is the primary move; trying the read
        again is a link, not a second button competing with it. */}
    <div className="order-alert-actions">
      {attention.actions.includes("group") ? <button type="button" className="button secondary button--sm" data-support-trigger onClick={(event) => onGroups(event.currentTarget)}><MessageCircle size={15} aria-hidden="true" />打开订单群列表</button> : null}
      {attention.actions.includes("browse") ? <Link href="/accounts" className="button secondary button--sm">浏览可租账号</Link> : null}
      {attention.actions.includes("manage") ? <Link href="/account?view=accounts" className="button secondary button--sm">管理上架账号</Link> : null}
      {attention.actions.includes("retry") ? <button type="button" className="order-alert-link" onClick={onRetry}>重试读取</button> : null}
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

function OrderProgressCard({ view, party, orderId, orderDisplayNo, userId, backHref, onRefresh, onPay, onTrade, onAftersale, onGroups }: {
  view: OrderProgressView;
  party: OrderParty;
  orderId: string;
  orderDisplayNo: string | null;
  userId: string | null;
  backHref: string;
  onRefresh: () => void;
  onPay?: () => void;
  onTrade?: () => void;
  onAftersale?: () => void;
  onGroups?: (trigger: HTMLElement) => void;
}) {
  const focusAnchor = (id: string, label: string) => {
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
    // A comma-separated selector is resolved in document order, not selector priority. In the
    // trade panel "刷新" appears before the actual action, so focus must be chosen by the action
    // the card offered, then by primary weight, and only then by a non-refresh control.
    const controls = [...node.querySelectorAll<HTMLElement>("button, a[href], summary, input, [tabindex]")]
      .filter(control => !control.hasAttribute("disabled"));
    const isRefresh = (control: HTMLElement) => (control.textContent ?? "").includes("刷新");
    const wanted = controls.find(control => (control.textContent ?? "").includes(label) && !isRefresh(control));
    const primary = controls.find(control => control.matches("button.button.primary, a.button.primary") && !isRefresh(control));
    const plain = controls.find(control => control.matches("button.button, a.button") && !isRefresh(control));
    const focusable = wanted ?? primary ?? plain ?? controls.find(control => !isRefresh(control));
    if (focusable) {
      try { focusable.focus?.({ preventScroll: true }); } catch { /* focus is best-effort */ }
      return;
    }
    if (node.tabIndex < 0) node.tabIndex = -1;
    try { node.focus?.({ preventScroll: true }); } catch { /* focus is best-effort */ }
  };
  const run = (action: OrderProgressAction, trigger?: HTMLElement | null) => {
    if (action.target === "pay") { onPay?.(); return; }
    if (action.target === "refresh") { onRefresh(); return; }
    if (action.target === "support") {
      // A service consultation is not the order-group panel. Keep the order context so the
      // support dialog can prefill the order number without inventing any business fact.
      const context = userId && orderDisplayNo
        ? { userId, subjectRef: `order:${orderId}`, recordId: orderId, draftText: `订单 ${orderDisplayNo}` }
        : undefined;
      requestSupportDialog("SERVICE", trigger ?? null, context);
      return;
    }
    if (action.target === "groups") {
      if (onGroups) onGroups(trigger ?? document.body);
      else window.dispatchEvent(new CustomEvent("zzsh:order-groups", { detail: { party, orderId } }));
      return;
    }
    if (action.target === "trade" && onTrade) { onTrade(); return; }
    const anchor = PROGRESS_ANCHORS[action.target];
    if (anchor) {
      // A not-applicable refund read removes its section; never leave the primary action pointing at nothing.
      if (action.target === "refund" && onAftersale && typeof document !== "undefined" && !document.getElementById(anchor)) {
        onAftersale();
        return;
      }
      focusAnchor(anchor, action.label);
    }
  };
  const actionNode = (action: OrderProgressAction, primary: boolean) => {
    const icon = action.target === "support" || action.target === "groups" ? <MessageCircle size={15} aria-hidden="true" />
      : action.target === "refresh" ? <RefreshCw size={15} aria-hidden="true" /> : null;
    const href = action.target === "list" ? backHref : action.href;
    const className = primary ? "button primary" : "button quiet button--sm";
    if (href) return <Link key={`${action.target}:${action.label}`} className={className} href={href} scroll={false}>{icon}{action.label}</Link>;
    return <button key={`${action.target}:${action.label}`} type="button" className={className} onClick={(event) => run(action, event.currentTarget)}>{icon}{action.label}</button>;
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
      {onAftersale ? <button type="button" className="button quiet button--sm" onClick={onAftersale}>售后记录</button> : null}
    </div>
  </section>;
}

type StageReadState = { scope: string; status: "loading" | "ready" | "failed"; projection: OrderImProjection | null };

/**
 * A compact fulfillment timeline. It is read-only: the stage comes from the order IM projection, the group
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
    void orderApi.orderIm(userId, order.id, controller.signal).then((projection) => {
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
    ? orderFulfillmentSummary(projection, { ending, showRefund: party === "renter" })
    : visible.status === "failed" ? "阶段未确认" : "阶段核对中…";
  const cancelledAfterOpening = Boolean(projection && projection.stage === "CANCELLED" && (projection.openingState === "CONFIRMED" || projection.rentalStartedAt));
  const steps = projection ? orderFulfillmentStepStates(projection.stage, cancelledAfterOpening, Boolean(order.paidAt)) : null;
  const stepDefs = orderFulfillmentSteps(projection?.stage, cancelledAfterOpening, Boolean(order.paidAt));
  const tone = !projection ? "unknown" : projection.stage === "SETTLED" ? "done" : projection.stage === "CANCELLED" ? "closed" : "active";
  return <section className="order-fulfillment-stage" data-stage={projection?.stage ?? "UNKNOWN"} data-tone={tone} aria-label="履约阶段">
    <div className="order-fulfillment-head">
      <span className="order-fulfillment-dot" aria-hidden="true" />
      <p className="order-fulfillment-summary" role="status">{summary}</p>
    </div>
    {steps ? <ol className="order-fulfillment-steps" aria-label="订单履约阶段">{stepDefs.map((step, index) => {
      const stepState = steps[index] ?? "unknown";
      return <li key={step.key} data-state={stepState} aria-current={stepState === "current" ? "step" : undefined}><span className="order-fulfillment-step-dot" aria-hidden="true" /><span>{step.label}</span></li>;
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

type PriceReferenceLine = { itemId?: string; quantity?: string; costAmount?: string; unitPriceLabel?: string };

function OrderLines({ order, party, opening, referenceLines, showTotal = true, originalAmounts = false }: { order: Order; party: OrderParty; opening?: SettlementOpening | null; referenceLines?: readonly PriceReferenceLine[] | null; showTotal?: boolean; originalAmounts?: boolean }) {
  const lines = order.quote?.lines ?? [];
  if (lines.length === 0) return <p className="order-muted">暂无可展示的费用明细，可稍后查看或联系客服。</p>;
  const total = party === "owner" ? order.quote?.ownerTotal : order.amounts?.rental;
  const hasOpening = Boolean(opening?.lines.length);
  const openingFor = (itemId?: string | null) => itemId ? opening?.lines.find((line) => line.itemId === itemId) : undefined;
  const referenceFor = (itemId?: string | null) => itemId ? referenceLines?.find((line) => line.itemId === itemId) : undefined;
  return <>
    <div className="order-table-wrap">
      <table><thead><tr><th scope="col">资源</th><th scope="col">{hasOpening ? "开租数量" : "数量"}</th><th scope="col">{party === "owner" ? "号主报价" : "金额"}</th></tr></thead>
        <tbody>{lines.map((line, index) => {
          // Renter line amounts are the final allocated price. The public listing can supply the
          // base unit price for comparison, but it is not used for any arithmetic here.
          const referenceLine = originalAmounts ? referenceFor(line.itemId) : undefined;
          const unitPrice = party === "owner"
            ? orderUnitPriceText(line.ownerUnitAmount, line.unitQuantity, line.unit)
            : line.unit === "HAFF_BASE" ? null : referenceLine?.unitPriceLabel ? `参考 ${referenceLine.unitPriceLabel}` : null;
          const amount = party === "renter" && referenceLine?.costAmount ? formatReferenceYuan(referenceLine.costAmount) : null;
          const openingQuantity = openingFor(line.itemId)?.quantity;
          const quantity = openingQuantity !== undefined && openingQuantity !== null && openingQuantity !== ""
            ? line.unit === "HAFF_BASE" ? haffMillionsText(openingQuantity) : quantityText(line.unit, openingQuantity)
            : orderLineQuantityText(line);
          return <tr key={`${line.itemId ?? line.name ?? line.unit ?? "line"}-${index}`}>
            <td data-label="资源"><span>{line.name ?? unitLabel(line.unit) ?? "资源未记录"}</span>{unitPrice ? <small className="order-line-unit">{unitPrice}</small> : null}</td>
            <td data-label={hasOpening ? "开租数量" : "数量"}>{quantity}</td>
            <td data-label={party === "owner" ? "号主报价" : "金额"}>{amount ?? formatOrderMoney(party === "owner" ? line.ownerAmount : line.buyerAmount)}</td>
          </tr>;
        })}</tbody>
      </table>
    </div>
    {showTotal ? <p className="order-lines-total">{orderLinesTotalLabel(party)} <strong>{formatOrderMoney(total)}</strong></p> : null}
    {party === "renter" ? <p className="order-lines-note">{originalAmounts ? "资源行金额为下单时原价；会员优惠在合计中一次性扣除。" : "资源行金额为下单时最终报价；如享会员优惠，已一次性计入合计，不逐项分摊。"}</p> : null}
    {!originalAmounts && order.quote?.unitAmountsInformational ? <p className="order-lines-note">明细为下单时的费用记录，最终金额请查看结算明细。</p> : null}
  </>;
}

/** One money section: party-owned summary plus the resource lines and confirmed opening quantities. */
function OrderAmountDetails({ order, party, refreshVersion = 0, onFacts }: { order: Order; party: OrderParty; refreshVersion?: number; onFacts?: (facts: OrderStageFacts | null, failed: boolean) => void }) {
  const session = useUserSession();
  const report = useRef(onFacts);
  useEffect(() => { report.current = onFacts; }, [onFacts]);
  const [state, setState] = useState<{ scope: string; status: "idle" | "loading" | "ready" | "unavailable" | "error"; data: OrderSettlement | null }>({ scope: "", status: "idle", data: null });
  const [referenceLines, setReferenceLines] = useState<PriceReferenceLine[] | null>(null);
  const scope = `${session.userId ?? ""}:${session.identityVersion}:${order.id}:${order.status}:${refreshVersion}`;
  useEffect(() => {
    if (order.source?.origin === "LEGACY" || (order.status !== "PAID" && order.status !== "COMPLETED")) {
      setState({ scope, status: "idle", data: null });
      report.current?.(null, false);
      return;
    }
    const subject = captureOrderSubject(session.userId, session.identityVersion);
    if (!subject) {
      setState({ scope, status: "error", data: null });
      report.current?.(null, true);
      return;
    }
    const controller = new AbortController();
    setState({ scope, status: "loading", data: null });
    orderApi.settlement(subject, order.id, controller.signal).then((data) => {
      if (controller.signal.aborted || !isOrderSubjectCurrent(subject, session)) return;
      setState({ scope, status: "ready", data });
      report.current?.(stageFacts(data, activeOpening(data.openings), party), false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !isOrderSubjectCurrent(subject, session)) return;
      setState({ scope, status: error instanceof OrderRequestError && error.status === 404 ? "unavailable" : "error", data: null });
      report.current?.(null, true);
    });
    return () => controller.abort();
  }, [order.id, order.status, order.source?.origin, party, refreshVersion, scope, session, session.userId, session.identityVersion]);
  useEffect(() => {
    const expectedVersion = order.listingFacts?.versionId ?? null;
    if (party !== "renter" || !order.accountId || !expectedVersion || order.source?.origin === "LEGACY") { setReferenceLines(null); return; }
    const controller = new AbortController();
    void fetch(`/api/supply/listings/${encodeURIComponent(order.accountId)}`, { credentials: "same-origin", cache: "no-store", signal: controller.signal })
      .then((response) => response.ok ? response.json() : null)
      .then((listing: { versionId?: unknown; quote?: { lines?: unknown } | null } | null) => {
        if (controller.signal.aborted) return;
        if (!listing || listing.versionId !== expectedVersion || !Array.isArray(listing.quote?.lines)) { setReferenceLines(null); return; }
        setReferenceLines(listing.quote.lines.flatMap((raw) => {
          if (!raw || typeof raw !== "object") return [];
          const line = raw as { itemId?: unknown; quantity?: unknown; unit?: unknown; unitQuantity?: unknown; buyerUnitAmount?: { amount?: unknown }; buyerAmount?: { amount?: unknown } };
          if (typeof line.itemId !== "string" || typeof line.quantity !== "string" || typeof line.buyerAmount?.amount !== "string") return [];
          const unitPrice = formatReferenceYuan(line.buyerUnitAmount?.amount);
          const unitLabel = typeof line.unitQuantity === "string" && typeof line.unit === "string" ? quantityText(line.unit, line.unitQuantity) : null;
          return [{
            itemId: line.itemId,
            quantity: line.quantity,
            costAmount: line.buyerAmount.amount,
            ...(unitPrice ? { unitPriceLabel: unitLabel ? `${unitPrice} / ${unitLabel}` : unitPrice } : {}),
          }];
        }));
      })
      .catch(() => { if (!controller.signal.aborted) setReferenceLines(null); });
    return () => controller.abort();
  }, [order.accountId, order.listingFacts?.versionId, order.source?.origin, party]);
  const visible = state.scope === scope ? state : { scope, status: "loading" as const, data: null };
  const facts = visible.status === "ready" && visible.data ? stageFacts(visible.data, activeOpening(visible.data.openings), party) : null;
  const opening = visible.status === "ready" && visible.data ? activeOpening(visible.data.openings) : null;
  const priceDiscount = party === "renter" && referenceLines && (order.status !== "CANCELLED" || Boolean(order.paidAt)) && order.quote?.lines?.length
    ? matchingResourceDiscount(order.quote.lines, order.quote.resourceTotal ?? order.amounts?.rental, referenceLines)
    : null;
  const membershipText = orderMembershipText(order.membership);
  return <section className="order-detail-section order-amount-details" aria-label="订单金额明细">
    <div className="order-amount-details-head">
      <div className="order-amount-details-heading">
        <h2 className="order-section-title">订单金额明细</h2>
        {membershipText ? <span className="order-member-badge"><Crown size={13} aria-hidden="true" />{membershipText}</span> : null}
      </div>
      <span>{party === "owner" ? (facts?.phase === "POSTED" ? "结算净入账" : "预估收益") : order.status === "PENDING_PAYMENT" ? "本次应付" : order.status === "CANCELLED" && !order.paidAt ? "下单金额" : "实付金额"}</span>
    </div>
    <p className="order-amount-details-note">{party === "owner" ? (facts?.phase === "POSTED" ? "包赔费已按结算规则扣除。" : "预估收益，包赔费按结算规则扣除。") : order.status === "PENDING_PAYMENT" ? "含租金与租客押金，支付后金额以订单记录为准。" : order.status === "CANCELLED" && !order.paidAt ? "订单未支付，以下为下单时的金额记录。" : "退款到账以实际进度为准。"}</p>
    <div className="order-amount-details-grid">
      <AmountCard order={order} party={party} facts={facts} readFailed={visible.status === "error" || visible.status === "unavailable"} />
      <div className="order-amount-lines order-lines">
        <h3 className="order-amount-lines-title">{order.status === "PENDING_PAYMENT" ? "资源与费用" : "资源与开租数量"}</h3>
        <OrderLines order={order} party={party} opening={opening} referenceLines={referenceLines} showTotal={!priceDiscount} originalAmounts={Boolean(priceDiscount)} />
        {priceDiscount ? <dl className="order-price-calc" aria-label="价格计算">
          <div><dt>资源原价小计</dt><dd><del>{priceDiscount.original}</del></dd></div>
          <div className="is-discount"><dt>会员优惠</dt><dd>-{formatYuanFromCents(priceDiscount.reduction)}</dd></div>
          <div className="is-final"><dt>折后资源合计</dt><dd>{priceDiscount.final}</dd></div>
        </dl> : null}
        {visible.status === "loading" ? <p className="order-muted" role="status">正在读取开租确认数量…</p> : null}
        {visible.status === "error" || visible.status === "unavailable" ? <p className="order-inline-notice" role="status">开租确认数量暂时无法读取，资源费用仍可查看。</p> : null}
      </div>
    </div>
  </section>;
}

function OrderActionCard({ order, facts, readFailed, onAction, onSupport, onCancel, onRefresh, onAftersale }: {
  order: Order;
  facts: OrderStageFacts | null;
  readFailed: boolean;
  onAction: (focus: SettlementFocus) => void;
  onSupport: (trigger: HTMLElement) => void;
  onCancel: () => void;
  onRefresh: () => void;
  onAftersale?: () => void;
}) {
  const serverStage = order.stage?.code ?? null;
  const phase = facts?.phase ?? null;
  const stage = serverStage ?? (readFailed || facts === null ? null : phase);
  const opening = facts !== null && (!facts.rentalStarted || !facts.openingConfirmedAt)
    && (serverStage === "OPENING_PENDING" || (!serverStage && (phase === "RENTING" || phase === null)));
  let title = "核对订单进度";
  let note = readFailed ? "开租与结算记录暂时无法读取，请重试或联系客服。" : "正在读取开租与结算记录。";
  let owner = readFailed ? "平台" : "核对中";
  let primary: { label: string; onClick?: (event: ReactMouseEvent<HTMLButtonElement>) => void; href?: string } | null = readFailed ? { label: "重试读取", onClick: onRefresh } : null;
  let cancel = false;

  if (stage === "OPENING_PENDING" || (serverStage === null && opening)) {
    cancel = true;
    if (facts && facts.openingVersionNo === null) {
      title = "联系客服核对开租清单";
      note = "付款已确认，但开租清单还没有读到。请刷新或联系客服。";
      owner = "等待客服";
      primary = { label: "联系客服", onClick: (event) => onSupport(event.currentTarget) };
    } else if (facts && facts.myAck) {
      const due = typeof facts.autoConfirmDueAt === "string" && Number.isFinite(Date.parse(facts.autoConfirmDueAt));
      title = "等待对方确认期初清单";
      note = due ? "你已确认，等待对方确认后开租。超过确认截止时间后按本单规则自动处理。" : "你已确认，等待对方确认后开租。本单没有记录自动确认截止时间，页面不会承诺系统会自动确认。";
      owner = "等待对方";
      primary = { label: "刷新进度", onClick: onRefresh };
    } else {
      title = "确认开租";
      note = "核对本期期初库存后确认。";
      owner = "由你处理";
      primary = { label: "确认开租", onClick: () => onAction("opening") };
    }
  } else if (stage === "RENTING") {
    title = "结束租用并结算";
    note = "填写本次消耗，预览金额后再提交。";
    owner = "由你处理";
    primary = { label: "发起结束租用", onClick: () => onAction("settlement") };
  } else if (stage === "INTAKE_PENDING") {
    title = "等待客服核对结束申请";
    note = "客服核对后会生成结算方案，请留意订单群消息。";
    owner = "等待客服";
    primary = { label: "查看结算进度", onClick: () => onAction("settlement") };
  } else if (stage === "DECISION_PENDING") {
    title = "待你确认结算";
    note = "核对本版金额与责任后确认或拒绝。";
    owner = "由你处理";
    primary = { label: "确认结算", onClick: () => onAction("decision") };
  } else if (stage === "DECISION_REJECTED") {
    title = "结算未达成一致";
    note = "请联系客服生成新的结算方案。";
    owner = "等待客服";
    primary = { label: "联系客服", onClick: (event) => onSupport(event.currentTarget) };
  } else if (stage === "DECISION_WAITING") {
    title = "等待对方确认结算";
    note = "你已确认本版结算，无需重复提交。";
    owner = "等待对方";
    primary = { label: "查看结算", onClick: () => onAction("decision") };
  } else if (stage === "POSTED") {
    title = "订单已结算";
    note = "退款与售后记录仍可查看，到账以实际记录为准。";
    owner = "暂无待处理动作";
    primary = { label: "查看退款与售后", onClick: () => {
      const node = typeof document !== "undefined" ? document.getElementById("order-refund-section") : null;
      if (node) node.scrollIntoView({ block: "start" });
      else onAftersale?.();
    } };
  }

  return <section className="order-progress-card order-action-card" data-tone={readFailed ? "unknown" : "active"} aria-label="订单操作">
    <div className="order-progress-head">
      <span className="order-progress-label">下一步</span>
      <span className="order-progress-owner">{owner}</span>
    </div>
    <h2 className="order-progress-title">{title}</h2>
    <p className="order-progress-note">{note}</p>
    <div className="order-progress-actions">
      {primary?.href ? <a className="button primary" href={primary.href}>{primary.label}</a> : primary ? <button type="button" className="button primary" onClick={primary.onClick}>{primary.label}</button> : null}
      {cancel ? <button type="button" className="button quiet" onClick={onCancel}>取消订单</button> : null}
      {onAftersale ? <button type="button" className="button quiet button--sm" onClick={onAftersale}>售后记录</button> : null}
    </div>
  </section>;
}

function OrderGroupCard({ order, party, onSupport, onGroups }: { order: Order; party: OrderParty; onSupport: (trigger: HTMLElement) => void; onGroups: (trigger: HTMLElement) => void }) {
  const legacy = order.source?.origin === "LEGACY";
  const assignment = order.fulfillmentAssignment;
  const ready = assignment?.state === "ASSIGNED" && assignment.teamReady === true;
  const waiting = assignment?.state === "WAITING";
  const copy = legacy
    ? "本单来自旧平台，不会自动建群，请联系客服。"
    : ready
      ? "订单群已就绪。"
      : waiting
        ? "等待客服接入并建立订单群。"
        : "客服接入后可在这里进入订单群。";
  return <section className="order-side-card order-group-card" aria-label="订单群与客服">
    <h2 className="order-section-title">订单群</h2>
    <p className="order-contact-copy"><MessageCircle size={16} aria-hidden="true" />{copy}</p>
    {legacy || !ready
      ? <button type="button" className="button secondary" onClick={(event) => onSupport(event.currentTarget)}>联系客服</button>
      : <button type="button" className="button primary" onClick={(event) => onGroups(event.currentTarget)}>打开订单群</button>}
  </section>;
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
    {lead ? <><strong className="order-amount-total">{lead.text}</strong><p className="order-amount-label">{lead.label}</p></>
      : <><strong className="order-amount-total is-unknown">{readFailed ? "结算金额暂时无法读取" : facts ? "暂无可用结算金额" : "正在读取结算金额"}</strong><p className="order-amount-label">下单时的费用记录仍可查看</p></>}
    {posted || settledUnread ? <dl className="order-facts order-amount-rows">
      <div><dt>{renterFigureLabel(order)}</dt><dd>{formatOrderMoney(amounts?.totalDue)}</dd></div>
    </dl> : null}
    <dl className="order-facts order-amount-parts">
      <div><dt>{paid && !closed ? "租赁预付" : "租赁费用"}</dt><dd>{formatOrderMoney(amounts?.rental)}</dd></div>
      <div><dt>租客押金</dt><dd>{formatOrderMoney(amounts?.deposit)}</dd></div>
    </dl>
    {closed ? <p className="order-muted">{!paid ? "订单未支付，这是下单时的金额。"
      : order.cancelReason === "PRESTART_TERMINATED" ? "退款进度请查看本页。"
      : order.cancelReason === "MANUAL_CLOSE" ? "退款进度请联系客服核对。"
      : "这是下单时的金额，实际扣费和退款请查看订单进度。"}</p> : null}
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
  REVIEW_REQUIRED: "需要核对", SUCCEEDED: "退款结果待核对", FAILED: "申请处理失败", UNRECOGNIZED: "状态未记录",
};

function refundMoney(cents: string | null): string {
  if (cents === null) return "未记录";
  const value = BigInt(cents);
  return `¥${(value / 100n).toLocaleString("zh-CN")}.${(value % 100n).toString().padStart(2, "0")}`;
}

function RefundIntentCard({ intent, conflict }: { intent: PersonalRefundIntent; conflict: boolean }) {
  const channelSucceeded = intent.source === "JOINPAY_FORMAL" && intent.state === "SUCCEEDED" && intent.budgetDisposition === "CONSUMED"
    && intent.savedChannelEvidence?.terminal === "SUCCEEDED" && intent.savedChannelEvidence.evidenceLevel === "PROVIDER_RESPONSE";
  const stateLabel = intent.requiresReview || conflict ? "退款状态待核对" : intent.source === "LOCAL_CONTROLLED" && intent.state === "SUCCEEDED" && intent.budgetDisposition === "CONSUMED" ? "模拟退款已记录" : channelSucceeded ? "退款成功" : refundIntentStateLabel[intent.state];
  return <li className="order-refund-intent">
    <div className="order-refund-intent-head"><strong>{intent.refundOrderNo ?? "退款申请"}</strong><span className="order-refund-state">{stateLabel}</span></div>
    <dl className="order-facts order-refund-intent-facts">
      <div><dt>申请金额</dt><dd>{intent.amount ? refundMoney(intent.amount.cents) : "未记录"}</dd></div>
      {intent.createdAt ? <div><dt>申请时间</dt><dd>{timeText(intent.createdAt, { timeZoneName: false })}</dd></div> : null}
    </dl>
    {intent.source === "LOCAL_CONTROLLED" ? <p className="order-muted">测试记录，不代表真实退款。</p> : null}
    {intent.requiresReview || conflict ? <p className="order-muted">这笔退款需要核对，请联系客服。</p> : null}
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
  return <section className="order-detail-section order-refund-block" id="order-refund-section" aria-label="退款进度" data-progress={read.progress}>
    <div className="order-refund-heading"><h2 className="order-section-title">退款进度</h2>{refresh}</div>
    <div className="order-refund-details">
      <div className="order-refund-summary"><strong>{read.label}</strong><span>{read.note}</span></div>
      <div className="order-refund-detail-content">
        <p className="order-muted">订单状态以页面顶部为准；此处不展示租客收款资料。</p>
        {read.openIntentCount > 0 ? <p className="order-muted">进行中的退款处理记录：{read.openIntentCount} 笔</p> : null}
      </div>
    </div>
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
  if (read.status === "NOT_APPLICABLE" && !read.prestartRefund && !read.cancellationRefund) return null;
  const responsibility = read.responsibility;
  const prestart = read.prestartRefund ?? read.cancellationRefund;
  const needsReview = read.intents.some(intent => intent.requiresReview);
  const incomplete = read.intentsTruncated || !read.coverage.intentsComplete || responsibility.state === "POSTED" && !responsibility.totalsComplete;
  const simulated = read.outcome === "FULLY_CONSUMED" && !incomplete && read.intents.length > 0
    && read.intents.every(intent => intent.source === "LOCAL_CONTROLLED" && intent.state === "SUCCEEDED" && intent.budgetDisposition === "CONSUMED");
  const channelSucceeded = read.outcome === "FULLY_CONSUMED" && !incomplete && read.intents.length > 0
    && read.intents.every(intent => intent.source === "JOINPAY_FORMAL" && intent.state === "SUCCEEDED" && intent.budgetDisposition === "CONSUMED"
      && intent.savedChannelEvidence?.terminal === "SUCCEEDED" && intent.savedChannelEvidence.evidenceLevel === "PROVIDER_RESPONSE");
  const prestartCopy = prestart ? {
    PROCESSING: { label: "退款处理中", note: "请稍后查看退款进度。" },
    SUCCEEDED: { label: prestart.source === "SIMULATED" ? "模拟退款成功" : "退款成功", note: prestart.source === "SIMULATED" ? "测试记录，不会实际退款。" : "渠道已记录退款成功，到账时间以收款记录为准。" },
    FAILED: { label: "退款未完成", note: "请联系客服处理。" },
    UNKNOWN: { label: "退款状态待核对", note: "请稍后查看或联系客服。" },
  }[prestart.state] : null;
  const outcome = prestartCopy ?? (needsReview ? refundOutcomeCopy.REVIEW_REQUIRED : simulated ? { label: "模拟退款已记录", note: "测试记录，不代表实际退款或到账。" }
    : channelSucceeded ? { label: "退款成功", note: "渠道已记录退款成功，到账时间以收款记录为准。" } : refundOutcomeCopy[read.outcome]);
  return <section className="order-detail-section order-refund-block" id="order-refund-section" aria-label="退款进度" data-outcome={prestart?.state ?? read.outcome}>
    <div className="order-refund-heading"><h2 className="order-section-title">退款进度</h2>{refresh}</div>
    <div className="order-refund-details">
      <div className="order-refund-summary"><strong>{outcome.label}</strong><span>{outcome.note}</span></div>
      <div className="order-refund-detail-content">
        {incomplete && !prestart ? <p className="order-inline-notice" role="status">部分退款信息仍在核对，当前记录可能不完整。</p> : null}
        {prestart?.amountCents ? <dl className="order-facts order-refund-amounts"><div><dt>{prestart.state === "SUCCEEDED" ? "退款金额" : "应退金额"}</dt><dd>{refundMoney(prestart.amountCents)}</dd></div></dl> : null}
        {responsibility.state === "POSTED" ? <dl className="order-facts order-refund-amounts">
          <div><dt>本次结算应退</dt><dd>{refundMoney(responsibility.originalCents)}</dd></div>
          {responsibility.dueAt ? <div><dt>退款到期时间</dt><dd>{timeText(responsibility.dueAt, { timeZoneName: false })}{responsibility.dueState === "DUE" ? "（已到期）" : responsibility.dueState === "NOT_DUE" ? "（未到期）" : "（状态未记录）"}</dd></div> : null}
        </dl> : null}
        {responsibility.state === "POSTED" && responsibility.dueAt ? <p className="order-muted">到期不代表退款已处理或到账。</p> : null}
        {read.intents.length ? <section aria-label="退款申请记录"><div className="order-refund-intents-heading"><h3>退款申请</h3><span>{read.intentsTruncated || !read.coverage.intentsComplete ? "部分记录未记录" : `${read.returnedIntentCount} 笔`}</span></div><ul className="order-refund-intents">{read.intents.map(intent => <RefundIntentCard key={intent.intentId} intent={intent} conflict={read.outcome === "CONFLICT"} />)}</ul></section> : null}
        <p className="order-muted">到账情况请以收款记录为准。</p>
      </div>
    </div>
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

export function OrderDetail({ party, status, accountId, orderId, filters, state, onRetry, onLogin, onChanged, payRequested = false }: {
  party: OrderParty;
  status: OrderStatusFilter;
  filters?: OrderSearchFilters;
  accountId?: string;
  orderId: string;
  state: DetailState;
  onRetry: () => void;
  onLogin: () => void;
  onChanged: () => void;
  payRequested?: boolean;
}) {
  const backHref = orderUrl(party, status, accountId, undefined, undefined, filters);
  const title = party === "renter" ? "租入订单" : "出租订单";
  const session = useUserSession();
  const readScope = `${session.status === "authenticated" ? session.userId : ""}:${party}:${orderId}`;
  const [read, setRead] = useState<{ scope: string; facts: OrderStageFacts | null; failed: boolean }>({ scope: "", facts: null, failed: false });
  const [payment, setPayment] = useState<{ scope: string; facts: OrderPaymentFacts | null }>({ scope: "", facts: null });
  const [payOpen, setPayOpen] = useState(false);
  const [actionFocus, setActionFocus] = useState<SettlementFocus | null>(null);
  const [dataVersion, setDataVersion] = useState(0);
  const [aftersaleOpen, setAftersaleOpen] = useState(false);
  const autoPay = useRef<string | null>(null);
  const facts = read.scope === readScope ? read.facts : null;
  const readFailed = read.scope === readScope && read.failed;
  const paymentFacts = payment.scope === readScope ? payment.facts : null;
  useEffect(() => {
    if (!payRequested) { autoPay.current = null; return; }
    if (autoPay.current === orderId) return;
    const current = state.status === "ready" ? state.order : null;
    if (current?.id === orderId && current.status === "PENDING_PAYMENT" && paymentEntryOpen(current)) {
      autoPay.current = orderId;
      setPayOpen(true);
    }
  }, [orderId, payRequested, state]);
  const openPay = useCallback(() => {
    setPayOpen(true);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("pay", "1");
      window.history.replaceState(null, "", url.toString());
    }
  }, []);
  const closePay = useCallback(() => {
    autoPay.current = orderId;
    setPayOpen(false);
    if (typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("pay");
      window.history.replaceState(null, "", url.toString());
    }
  }, [orderId]);
  const reportPayment = useCallback((next: OrderPaymentFacts | null) => setPayment({ scope: readScope, facts: next }), [readScope]);
  const reportStage = useCallback((next: OrderStageFacts | null, failed: boolean) => setRead({ scope: readScope, facts: next, failed }), [readScope]);
  const refreshDetail = useCallback(() => { setDataVersion((value) => value + 1); onChanged(); }, [onChanged]);
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
  const attention = attentionFor(order, facts, readFailed, party);
  const progress = orderProgressView({ order, party, facts, readFailed, payment: paymentFacts });
  const openSupport = (trigger: HTMLElement) => requestSupportDialog("SERVICE", trigger,
    session.status === "authenticated" && session.userId
      ? { userId: session.userId, subjectRef: `order:${order.id}`, recordId: order.id, draftText: `订单 ${order.displayNo ?? order.id}` }
      : undefined);
  const openGroups = (trigger: HTMLElement) => {
    window.dispatchEvent(new CustomEvent("zzsh:order-groups", { detail: { party, orderId: order.id } }));
    // If the support host cannot open the group (e.g. archived beyond the window), fall back to service.
    requestAnimationFrame(() => {
      if (session.status === "loading" || session.status === "error") return;
      const opened = document.querySelector('.support-dialog-content[data-state="open"], [data-auth-dialog][data-state="open"]');
      if (!opened) openSupport(trigger);
    });
  };
  const openCancel = () => {
    const section = document.getElementById("order-cancel-request");
    const details = section?.querySelector("details");
    if (details) details.open = true;
    const reduced = typeof window !== "undefined" && typeof window.matchMedia === "function"
      && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    section?.scrollIntoView?.({ behavior: reduced ? "auto" : "smooth", block: "start" });
    section?.querySelector<HTMLElement>("select, button")?.focus({ preventScroll: true });
  };
  const canCancelBeforeOpening = order.status === "PAID"
    && (order.stage?.code === "OPENING_PENDING" || (order.stage?.code === undefined && facts?.rentalStarted === false));
  const aftersaleAvailable = !order.readOnly && order.source?.origin !== "LEGACY"
    && (order.status === "COMPLETED" || order.stage?.code === "POSTED");
  const showStageBar = order.source?.origin !== "LEGACY" && !order.readOnly && order.status !== "PENDING_PAYMENT";
  return <section className="order-detail-view" data-testid="order-detail">
    {back}
    {/* Identity band: the account is the subject, the order number identifies the transaction, and the
        lifecycle status is stated once here and nowhere else. */}
    <header className="order-detail-hero">
      <div className="order-detail-hero-copy">
        <div className="order-detail-title-row">
          <h1 className="order-detail-title">{orderAccountTitle(order)}</h1>
          <OrderStatusBadge order={order} />
        </div>
        <div className="order-detail-identity">
          {order.accountDisplayNo ? <span className="order-detail-account-no">账号 {order.accountDisplayNo}</span> : null}
          <span className="order-detail-no">订单 {order.displayNo ?? "未记录"}<CopyOrderNo value={order.displayNo} /></span>
          {order.accountId ? <Link className="order-detail-public-link" href={party === "owner" ? `/account?view=accounts&accountId=${encodeURIComponent(order.accountId)}` : `/accounts/${encodeURIComponent(order.accountId)}?fromOrder=${encodeURIComponent(order.id)}`} scroll={false}>{party === "owner" ? "查看本人账号" : "查看当前公开资料"}</Link> : null}
        </div>
        <div className="order-detail-context">
          <span>下单 {timeText(order.createdAt, { timeZoneName: false })}</span>
          <span>{orderTermLabel(order)}</span>
          {modeLabel ? <span className="order-detail-mode" data-mode={order.quote?.rentalMode}>{modeLabel}</span> : null}
          {!order.listingFacts && order.listingFactsUnknownReason ? <span className="order-detail-source-note">账号资料未确认</span> : null}
          {sourceLabel ? <span className="order-detail-source-note">{sourceLabel}</span> : null}
        </div>
      </div>
    </header>
    {showStageBar ? <FulfillmentStageBar order={order} party={party} facts={facts} /> : null}
    <BusinessUpdateNotices surface="orders" />
    {attention ? <AttentionBlock attention={attention} onRetry={refreshDetail} onGroups={openGroups} /> : null}
    <div className="order-detail-overview order-detail-actions">
      {order.status === "PAID"
        ? <OrderActionCard order={order} facts={facts} readFailed={readFailed} onAction={setActionFocus} onSupport={openSupport} onCancel={openCancel} onRefresh={refreshDetail} onAftersale={aftersaleAvailable ? () => setAftersaleOpen(true) : undefined} />
        : <>
          {order.status === "PENDING_PAYMENT" ? <PaymentFactsProbe order={order} onFacts={reportPayment} /> : null}
          <OrderProgressCard view={progress} party={party} orderId={order.id} orderDisplayNo={order.displayNo ?? null} userId={session.status === "authenticated" ? session.userId : null} backHref={backHref} onRefresh={refreshDetail} onPay={openPay} onTrade={openPay} onAftersale={aftersaleAvailable ? () => setAftersaleOpen(true) : undefined} onGroups={openGroups} />
        </>}
      {order.status !== "PENDING_PAYMENT" ? <OrderGroupCard order={order} party={party} onSupport={openSupport} onGroups={openGroups} /> : null}
    </div>
    <OrderAmountDetails order={order} party={party} refreshVersion={dataVersion} onFacts={reportStage} />
    <div className="order-detail-body" id="order-detail-body" tabIndex={-1}>
      <div className="order-detail-main">
        {canCancelBeforeOpening || order.status === "CANCELLED" ? <PrestartTerminationPanel key={`prestart:${order.id}:${order.status}`} order={order} party={party} onChanged={onChanged}/> : null}
        {party === "renter" && order.source?.origin !== "LEGACY" && !order.readOnly && (order.status === "PAID" || order.status === "COMPLETED" || (order.status === "CANCELLED" && Boolean(order.paidAt))) ? <OrderRefundSection key={`${order.id}:${order.status}:${facts?.phase ?? "NONE"}`} order={order} /> : null}
        {party === "owner" && order.source?.origin !== "LEGACY" && !order.readOnly && (order.status === "CANCELLED" || order.status === "COMPLETED") ? <OrderOwnerRefundSummary key={`owner-refund:${order.id}:${order.status}`} order={order} /> : null}
        <OrderAccountDossier
          accountId={order.accountId}
          accountDisplayNo={order.accountDisplayNo}
          party={party}
          listingFacts={order.listingFacts}
          orderResources={orderResourceLines(order)}
        />
        <OrderEntitlements order={order} />
        <section className="order-detail-section order-history-details" id="order-history">
          <details className="order-secondary-details">
            <summary><h2 className="order-section-title">订单进度详情</h2><span>下单、支付、开租与结算记录</span></summary>
            <OrderTimeline order={order} facts={facts} party={party} />
          </details>
        </section>
      </div>
    </div>
    <OrderActionDialog
      order={order}
      party={party}
      focus={actionFocus ?? "settlement"}
      open={actionFocus !== null}
      onOpenChange={(next) => { if (!next) setActionFocus(null); }}
      onChanged={refreshDetail}
    />
    <OrderAftersaleDialog
      orderId={order.id}
      orderDisplayNo={order.displayNo ?? null}
      open={aftersaleOpen}
      onOpenChange={setAftersaleOpen}
    />
    <PaymentDialog
      order={order}
      party={party}
      open={payOpen}
      onOpenChange={(next) => { if (next) openPay(); else closePay(); }}
      onChanged={refreshDetail}
      onPaymentFacts={reportPayment}
    />
  </section>;
}
