"use client";

import Link from "next/link";
import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { Check, Copy, MessageCircle, RefreshCw } from "lucide-react";
import { formatOrderTime as timeText, orderApi, OrderRequestError, type Order, type OrderImProjection, type OrderParty } from "@/lib/order-client";
import { useUserSession } from "@/components/session/user-session-provider";
import { requestSupportDialog } from "@/components/support/support-dialog-request";
import { orderFulfillmentSteps, orderFulfillmentStepStates, orderFulfillmentSummary, type OrderProgressAction, type OrderProgressView } from "@/lib/order-display";
import type { OrderStageFacts, SettlementFocus } from "@/components/order/order-trade-actions";

/** What still needs a decision from the reader. The order's own state lives in the identity band. */
type Attention = { tone: "info" | "warning"; title: string; note: string; actions: Array<"retry" | "group" | "browse" | "manage"> } | null;

export function attentionFor(order: Order, facts: OrderStageFacts | null, readFailed: boolean, party: OrderParty): Attention {
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

export function AttentionBlock({ attention, onRetry, onGroups }: { attention: Attention; onRetry: () => void; onGroups: (trigger: HTMLElement) => void }) {
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

export function OrderProgressCard({ view, party, orderId, orderDisplayNo, userId, backHref, onRefresh, onPay, onTrade, onAftersale, onGroups }: {
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
export function FulfillmentStageBar({ order, party, facts }: { order: Order; party: OrderParty; facts: OrderStageFacts | null }) {
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
export function OrderTimeline({ order, facts, party }: { order: Order; facts: OrderStageFacts | null; party: OrderParty }) {
  const events: Array<{ key: string; label: string; time: string | null; state: "done" | "closed" | "pending" }> = [
    { key: "created", label: "下单", time: order.createdAt ?? null, state: "done" },
  ];
  if (order.paidAt) events.push({ key: "paid", label: "支付确认", time: order.paidAt ?? null, state: "done" });
  if (facts?.openingConfirmedAt) events.push({ key: "opened", label: "开租确认", time: facts.openingConfirmedAt, state: "done" });
  if (facts?.postedAt) events.push({ key: "posted", label: "结算生效", time: facts.postedAt, state: "done" });
  if (order.cancelledAt) {
    events.push({
      key: "cancelled",
      label: `取消${order.cancelReason === "USER" ? "（租客取消）" : order.cancelReason === "TIMEOUT" ? "（到期未支付）" : order.cancelReason === "SUPPORT_UNPAID" ? "（客服处理）" : order.cancelReason === "OWNER_DELISTED" ? "（号主下架账号）" : order.cancelReason === "PRESTART_TERMINATED" ? "（未开租终止）" : ""}`,
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

export function CopyOrderNo({ value }: { value: string | null | undefined }) {
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

export function OrderActionCard({ order, facts, readFailed, onAction, onSupport, onCancel, onRefresh, onAftersale }: {
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

export function OrderGroupCard({ order, party, onSupport, onGroups }: { order: Order; party: OrderParty; onSupport: (trigger: HTMLElement) => void; onGroups: (trigger: HTMLElement) => void }) {
  const legacy = order.source?.origin === "LEGACY";
  const assignment = order.fulfillmentAssignment;
  const ready = assignment?.state === "ASSIGNED" && assignment.teamReady === true;
  const waiting = assignment?.state === "WAITING";
  const terminal = order.status === "COMPLETED" || order.status === "CANCELLED";
  const terminalWithoutGroup = terminal && (legacy || !ready);
  const copy = terminalWithoutGroup
    ? `本单已${order.status === "COMPLETED" ? "完成" : "取消"}，履约期间未建立订单群；如有账务或售后疑问可咨询客服`
    : legacy
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
      ? <button type="button" className="button secondary" onClick={(event) => onSupport(event.currentTarget)}>咨询客服</button>
      : <button type="button" className="button primary" onClick={(event) => onGroups(event.currentTarget)}>打开订单群</button>}
  </section>;
}

export function OrderEntitlements({ order }: { order: Order }) {
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
