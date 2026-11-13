"use client";
import { BusinessUpdateNotices } from "@/components/content/platform-update-notices";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowLeft, XCircle } from "lucide-react";
import { formatOrderTime as timeText, OrderRequestError, type Order, type OrderParty, type OrderStatusFilter, type OrderSearchFilters } from "@/lib/order-client";
import { useUserSession } from "@/components/session/user-session-provider";
import { requestSupportDialog } from "@/components/support/support-dialog-request";
import { orderAccountTitle, orderListingSourceLabel, orderProgressView, orderRentalModeLabel, orderResourceLines, paymentEntryOpen, type OrderPaymentFacts } from "@/lib/order-display";
import { PaymentFactsProbe, type OrderStageFacts, type SettlementFocus } from "@/components/order/order-trade-actions";
import { OrderActionDialog } from "@/components/order/order-action-dialog";
import { OrderAftersaleDialog } from "@/components/order/order-aftersale-dialog";
import { PaymentDialog } from "@/components/order/payment-dialog";
import { PrestartTerminationPanel } from "@/components/order/prestart-termination-panel";
import { OrderError, OrderStatusBadge, orderTermLabel, orderUrl } from "@/components/order/order-presentation";
import { OrderAccountDossier } from "./order-account-dossier";
import { AttentionBlock, attentionFor, CopyOrderNo, FulfillmentStageBar, OrderActionCard, OrderEntitlements, OrderGroupCard, OrderProgressCard, OrderTimeline } from "./order-detail-progress";
import { OrderAmountDetails } from "./order-detail-amount";
import { OrderOwnerRefundSummary, OrderRefundSection } from "./order-detail-refund";
import "./order.css";

type DetailState = { status: "loading" } | { status: "ready"; order: Order | null; error: OrderRequestError | null } | { status: "error"; error: OrderRequestError | null };

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
