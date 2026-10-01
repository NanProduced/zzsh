"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { AlertCircle, ArrowLeft, CheckCircle2, Clock3, FileText, LockKeyhole, MessageCircle, RefreshCw, UserRound, WalletCards, XCircle } from "lucide-react";
import { useUserSession } from "@/components/session/user-session-provider";
import { formatOrderMoney, formatOrderTime as timeText, mergeOrderItems, orderApi, OrderRequestError, type FulfillmentAssignment, type Order, type OrderPage, type OrderParty, type OrderStatus, type OrderStatusFilter } from "@/lib/order-client";
import "./order.css";

const STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING_PAYMENT: "待支付",
  PAID: "已支付",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
};

const VALID_STATUS = new Set<OrderStatus>(Object.keys(STATUS_LABELS) as OrderStatus[]);

function isOrderStatus(value: string | undefined): value is OrderStatus {
  return Boolean(value && VALID_STATUS.has(value as OrderStatus));
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function errorFrom(error: unknown): OrderRequestError {
  return error instanceof OrderRequestError ? error : new OrderRequestError(0, null);
}

function isPrivateBoundary(error: OrderRequestError): boolean {
  return error.status === 401 || error.status === 403 || error.status === 404 || error.code === "UNAUTHENTICATED" || error.code === "FORBIDDEN";
}

function isAuthenticationFailure(error: OrderRequestError): boolean {
  return error.status === 401 || error.code === "UNAUTHENTICATED";
}

function orderView(party: OrderParty): "rentals" | "leased" {
  return party === "renter" ? "rentals" : "leased";
}

function orderUrl(party: OrderParty, status: OrderStatusFilter, accountId?: string, orderId?: string): string {
  const query = new URLSearchParams({ view: orderView(party) });
  if (status) query.set("status", status);
  if (accountId) query.set("accountId", accountId);
  if (orderId) query.set("orderId", orderId);
  return `/account?${query.toString()}`;
}

function termText(value: string | null | undefined): string {
  const seconds = Number(value);
  if (!value || !Number.isSafeInteger(seconds) || seconds <= 0) return "租期暂不可用";
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

function unitText(value: string | undefined): string {
  return ({ HAFF_BASE: "哈夫币", ROUND: "发", PIECE: "件", DAY: "天" } as Record<string, string>)[value ?? ""] ?? value ?? "单位待确认";
}

function statusLabel(order: Order): string {
  if (order.status === "PENDING_PAYMENT" && order.expiredAwaitingCancel) return "已到期 · 取消处理中";
  if (isOrderStatus(order.status)) {
    if (order.status === "CANCELLED") {
      if (order.cancelReason === "TIMEOUT") return "已取消 · 到期未支付";
      if (order.cancelReason === "USER") return "已取消 · 租客取消";
    }
    return STATUS_LABELS[order.status];
  }
  return "状态待确认";
}

function statusTone(order: Order): string {
  if (order.status === "CANCELLED") return "cancelled";
  if (order.status === "PENDING_PAYMENT" && order.expiredAwaitingCancel) return "expired";
  if (order.status === "PAID") return "paid";
  if (order.status === "COMPLETED") return "completed";
  if (order.status === "PENDING_PAYMENT") return "pending";
  return "unknown";
}

function OrderStatusBadge({ order }: { order: Order }) {
  return <span className="order-status" data-state={statusTone(order)}>{statusLabel(order)}</span>;
}

function holdText(order: Order): string | null {
  if (order.status !== "PENDING_PAYMENT" || order.expiredAwaitingCancel) return null;
  if (!order.holdUntil) return "占用截止时间暂不可用";
  const until = Date.parse(order.holdUntil);
  if (!Number.isFinite(until)) return "占用截止时间暂不可用";
  return `占用截止 · ${timeText(order.holdUntil)}，状态以最新订单记录为准`;
}

function OrderTimeHint({ order }: { order: Order }) {
  const hold = holdText(order);
  if (hold) return <p className="order-time-hint"><Clock3 size={14} aria-hidden="true" />{hold}</p>;
  if (order.status === "CANCELLED") return <p className="order-time-hint"><Clock3 size={14} aria-hidden="true" />取消时间 · {timeText(order.cancelledAt)}</p>;
  if (order.status === "PAID") return <p className="order-time-hint"><CheckCircle2 size={14} aria-hidden="true" />收款事实已接纳 · {timeText(order.paidAt)}</p>;
  if (order.status === "COMPLETED") return <p className="order-time-hint"><CheckCircle2 size={14} aria-hidden="true" />订单已完成</p>;
  return null;
}

function statusNotice(order: Order) {
  if (order.status === "PENDING_PAYMENT" && order.expiredAwaitingCancel) return <div className="order-notice is-warning" role="status"><Clock3 size={17} aria-hidden="true" /><div><strong>已到期，取消处理中</strong><span>占用时间以订单记录为准；系统正在按序释放，期间该账号不可再次预订。</span></div></div>;
  if (order.status === "PENDING_PAYMENT") return <div className="order-notice is-info" role="status"><WalletCards size={17} aria-hidden="true" /><div><strong>待支付 · 支付功能暂未开放</strong><span>本页仅展示订单信息；支付入口开放前，订单保留至占用截止。</span></div></div>;
  if (order.status === "PAID") return <div className="order-notice is-info" role="status"><CheckCircle2 size={17} aria-hidden="true" /><div><strong>已支付 · 平台已接纳收款事实</strong><span>这不等于真实到账、交付或开租。</span></div></div>;
  if (order.status === "COMPLETED") return <div className="order-notice is-success" role="status"><CheckCircle2 size={17} aria-hidden="true" /><div><strong>已完成</strong><span>订单已完成；结算与到账记录以服务端结算信息为准。</span></div></div>;
  if (order.status === "CANCELLED") return <div className="order-notice" role="status"><XCircle size={17} aria-hidden="true" /><div><strong>{statusLabel(order)}</strong><span>订单已关闭，账号占用已解除。</span></div></div>;
  return <div className="order-notice is-warning" role="status"><AlertCircle size={17} aria-hidden="true" /><div><strong>状态待确认</strong><span>当前订单状态暂不可确认，请刷新后查看最新记录。</span></div></div>;
}

function fulfillmentText(value: FulfillmentAssignment): string {
  if (value.state === "WAITING") return value.waitingReason === "NO_ELIGIBLE_STAFF" ? "当前暂无可用客服" : "等待客服分配";
  if (value.state === "ASSIGNED" && value.teamReady) return "订单群已就绪 · 群就绪不等于已开租";
  if (value.state === "ASSIGNED") return "客服已分配，订单群准备中";
  return "履约状态待确认";
}

function NextStep({ order, party }: { order: Order; party: OrderParty }) {
  const assignment = order.fulfillmentAssignment;
  if (!assignment) {
    if (order.status !== "PENDING_PAYMENT") return null;
    return <section className="order-next-step" aria-label="下一步"><div><strong>下一步</strong><span>支付功能暂未开放；订单信息仍以服务端记录为准。</span></div></section>;
  }
  return <section className="order-next-step" aria-label="下一步"><div className="order-next-step-copy"><MessageCircle size={18} aria-hidden="true" /><span><strong>履约与沟通</strong><small>{fulfillmentText(assignment)}</small></span></div><button type="button" className="button secondary" data-support-trigger onClick={() => window.dispatchEvent(new CustomEvent("zzsh:order-groups", { detail: { party } }))}><MessageCircle size={15} aria-hidden="true" />打开订单群</button></section>;
}

function MoneyFacts({ order, party }: { order: Order; party: OrderParty }) {
  const amounts = order.amounts;
  const rows = [
    ...(party === "owner" && order.quote?.ownerTotal ? [{ label: "号主侧金额", value: formatOrderMoney(order.quote.ownerTotal) }] : []),
    { label: "租赁费用", value: formatOrderMoney(amounts?.rental) },
    { label: "押金", value: formatOrderMoney(amounts?.deposit) },
    { label: party === "owner" ? "租客应付" : "订单金额", value: formatOrderMoney(amounts?.totalDue) },
  ];
  return <dl className="order-facts order-money-facts">{rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd className={row.label.includes("金额") || row.label.includes("应付") || row.label.includes("订单") ? "order-total" : undefined}>{row.value}</dd></div>)}</dl>;
}

function OrderLines({ order, party }: { order: Order; party: OrderParty }) {
  const lines = order.quote?.lines ?? [];
  return <section className="order-lines" aria-labelledby="order-lines-title"><h3 id="order-lines-title">费用明细</h3>{lines.length ? <div className="order-table-wrap"><table><thead><tr><th scope="col">资源</th><th scope="col">数量</th><th scope="col">{party === "owner" ? "租客侧金额" : "金额"}</th>{party === "owner" ? <th scope="col">号主侧金额</th> : null}</tr></thead><tbody>{lines.map((line, index) => <tr key={`${line.itemId ?? line.name ?? line.unit ?? "line"}-${index}`}><td>{line.name ?? unitText(line.unit)}</td><td>{line.quantity ?? line.unitQuantity ?? "数量待确认"}{line.unit && !line.name ? ` ${unitText(line.unit)}` : ""}</td><td>{formatOrderMoney(line.buyerAmount)}</td>{party === "owner" ? <td>{formatOrderMoney(line.ownerAmount)}</td> : null}</tr>)}</tbody></table></div> : <p className="order-muted">费用明细暂不可用；订单金额以服务端记录为准。</p>}{order.quote?.unitAmountsInformational ? <p className="order-lines-note">单位价仅作信息展示，总额由服务端派生。</p> : null}</section>;
}

function OrderFacts({ order, party }: { order: Order; party: OrderParty }) {
  const rows: Array<{ label: string; value: string }> = [
    { label: "订单号", value: order.displayNo ?? "订单号暂不可用" },
    { label: "账号快照", value: order.title ?? "账号信息暂不可用" },
    { label: "租期", value: termText(order.termSeconds) },
    { label: "创建时间", value: timeText(order.createdAt) },
  ];
  if (order.status === "PENDING_PAYMENT") rows.push({ label: "占用截止（待支付）", value: timeText(order.holdUntil) });
  if ((order.status === "PAID" || order.status === "COMPLETED") && order.paidAt) rows.push({ label: "收款接纳时间", value: timeText(order.paidAt) });
  if (order.status === "CANCELLED") {
    rows.push({ label: "取消时间", value: timeText(order.cancelledAt) });
    if (order.cancelReason === "USER") rows.push({ label: "取消原因", value: "租客取消" });
    if (order.cancelReason === "TIMEOUT") rows.push({ label: "取消原因", value: "到期未支付" });
  }
  if (party === "owner") rows.push({ label: "租客", value: order.renterName ?? "暂不显示" });
  return <dl className="order-facts">{rows.map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>;
}

function loginHref(party: OrderParty, status: OrderStatusFilter, accountId?: string, orderId?: string): string {
  return `/login?next=${encodeURIComponent(orderUrl(party, status, accountId, orderId))}`;
}

function OrderError({ error, first, onRetry, onLogin, onReauthorize, label }: { error: OrderRequestError; first: boolean; onRetry: () => void; onLogin: () => void; onReauthorize?: () => void; label?: string }) {
  if (isPrivateBoundary(error)) {
    const authExpired = error.status === 401 || error.code === "UNAUTHENTICATED";
    return <section className="order-error-block" role="status"><LockKeyhole size={24} aria-hidden="true" /><h3>{authExpired ? "登录状态已变化" : "订单不可用"}</h3><p>{authExpired ? "请重新确认登录身份后再读取订单；此前数据不会继续展示。" : "当前身份没有可用的订单列表或详情，未展示另一方私人资料。"}</p>{authExpired ? <button type="button" className="button secondary" onClick={onLogin}>重新登录</button> : onReauthorize ? <button type="button" className="button secondary" onClick={onReauthorize}>重新确认授权</button> : null}</section>;
  }
  return <section className="order-error-block" role="alert"><AlertCircle size={24} aria-hidden="true" /><h3>{label ?? (first ? "订单列表暂时没有读取成功" : "订单信息暂时没有读取成功")}</h3><p>当前没有更新已展示的订单信息，请稍后重试。</p><button type="button" className="button secondary" onClick={onRetry}><RefreshCw size={15} aria-hidden="true" />重试读取</button></section>;
}

function Detail({ party, status, accountId, orderId, state, onRetry, onLogin }: { party: OrderParty; status: OrderStatusFilter; accountId?: string; orderId: string; state: DetailState; onRetry: () => void; onLogin: () => void }) {
  const backHref = orderUrl(party, status, accountId);
  if (state.status === "loading") return <section className="order-detail-card order-detail-loading" aria-busy="true" role="status"><span /><span /><span /></section>;
  if (state.status === "error" && state.error) return <section className="order-detail-view"><Link className="order-detail-back" href={backHref} scroll={false}><ArrowLeft size={16} aria-hidden="true" />返回订单列表</Link><OrderError error={state.error} first={false} onRetry={onRetry} onLogin={onLogin} label="订单详情暂时无法读取" /></section>;
  if (state.status !== "ready" || !state.order) return <section className="order-detail-view"><Link className="order-detail-back" href={backHref} scroll={false}><ArrowLeft size={16} aria-hidden="true" />返回订单列表</Link><section className="order-error-block" role="status"><XCircle size={24} aria-hidden="true" /><h3>订单不可用</h3><p>当前身份没有这笔订单的可用详情，未展示另一方私人资料。</p></section></section>;
  const order = state.order;
  return <section className="order-detail-view"><Link className="order-detail-back" href={backHref} scroll={false}><ArrowLeft size={16} aria-hidden="true" />返回订单列表</Link><article className="order-detail-card" data-testid="order-detail"><header className="order-detail-heading"><div><h2>{order.title ?? "账号信息暂不可用"}</h2><p>{order.displayNo ?? "订单号暂不可用"}</p></div><OrderStatusBadge order={order} /></header>{statusNotice(order)}<MoneyFacts order={order} party={party} /><NextStep order={order} party={party} /><section className="order-detail-section"><h3>订单信息</h3><OrderFacts order={order} party={party} /></section><OrderLines order={order} party={party} /></article></section>;
}

function ListRow({ party, order, status, accountId, onOpen }: { party: OrderParty; order: Order; status: OrderStatusFilter; accountId?: string; onOpen: (orderId: string, event: ReactMouseEvent<HTMLAnchorElement>) => void }) {
  const ownerAmount = party === "owner" && order.quote?.ownerTotal;
  return <li className="order-list-item"><Link className="order-list-link" href={orderUrl(party, status, accountId, order.id)} scroll={false} data-order-id={order.id} onClick={(event) => onOpen(order.id, event)}><div className="order-list-main"><span className="order-kicker">{order.displayNo ?? "订单号暂不可用"}</span><strong>{order.title ?? "账号信息暂不可用"}</strong>{party === "owner" ? <span className="order-list-person"><UserRound size={13} aria-hidden="true" />租客：{order.renterName ?? "暂不显示"}</span> : null}</div><div className="order-list-side"><OrderStatusBadge order={order} /><strong>{formatOrderMoney(ownerAmount || order.amounts?.totalDue)}</strong><span className="order-amount-caption">{ownerAmount ? "号主侧金额" : party === "owner" ? "租客应付" : "订单金额"}</span><OrderTimeHint order={order} /></div></Link></li>;
}

type DetailState = { scope: string; orderId: string | null; status: "loading" | "ready" | "error"; order: Order | null; error: OrderRequestError | null };
type ListState = { scope: string; page: OrderPage | null; loading: boolean; refreshing: boolean; loadingMore: boolean; error: OrderRequestError | null; moreError: OrderRequestError | null; notice: string };

function emptyListState(scope: string): ListState {
  return { scope, page: null, loading: true, refreshing: false, loadingMore: false, error: null, moreError: null, notice: "" };
}

export function OrderWorkspace({ party, orderId, status: statusParam, accountId }: { party: OrderParty; orderId?: string; status?: string; accountId?: string }) {
  const router = useRouter();
  const session = useUserSession();
  const status: OrderStatusFilter = isOrderStatus(statusParam) ? statusParam : "";
  const identityScope = session.status === "authenticated" && session.userId ? `${session.userId}:${session.identityVersion}` : "unauthenticated";
  const listScope = `${identityScope}:${party}:${status}:${accountId ?? ""}`;
  const detailScope = `${identityScope}:${party}:${orderId ?? ""}`;
  const [listState, setListState] = useState<ListState>(() => emptyListState(listScope));
  const [detailState, setDetailState] = useState<DetailState>(() => ({ scope: detailScope, orderId: orderId ?? null, status: orderId ? "loading" : "ready", order: null, error: null }));
  const [detailReload, setDetailReload] = useState(0);
  const listController = useRef<AbortController | null>(null);
  const moreController = useRef<AbortController | null>(null);
  const detailController = useRef<AbortController | null>(null);
  const listSequence = useRef(0);
  const moreSequence = useRef(0);
  const detailSequence = useRef(0);
  const positionRef = useRef<{ orderId: string; scrollY: number } | null>(null);
  const previousOrderId = useRef(orderId);

  const loadFirst = useCallback(async (preserve: boolean, notice = "") => {
    listController.current?.abort();
    moreController.current?.abort();
    const sequence = ++listSequence.current;
    moreSequence.current += 1;
    const controller = new AbortController();
    listController.current = controller;
    setListState((previous) => preserve && previous.scope === listScope && previous.page
      ? { ...previous, refreshing: true, loadingMore: false, error: null, moreError: null, notice }
      : { ...emptyListState(listScope), notice });
    if (session.status !== "authenticated" || !session.userId) {
      if (sequence === listSequence.current) setListState({ ...emptyListState(listScope), loading: false, notice });
      if (listController.current === controller) listController.current = null;
      return;
    }
    try {
      const page = await orderApi.list({ party, ...(status ? { status } : {}), ...(accountId ? { accountId } : {}) }, controller.signal);
      if (controller.signal.aborted || sequence !== listSequence.current) return;
      setListState({ scope: listScope, page, loading: false, refreshing: false, loadingMore: false, error: null, moreError: null, notice });
    } catch (error) {
      if (controller.signal.aborted || sequence !== listSequence.current || isAbortError(error)) return;
      const typed = errorFrom(error);
      setListState((previous) => {
        const discard = isPrivateBoundary(typed);
        return discard || !preserve || !previous.page
          ? { scope: listScope, page: null, loading: false, refreshing: false, loadingMore: false, error: typed, moreError: null, notice }
          : { ...previous, loading: false, refreshing: false, loadingMore: false, error: typed, moreError: null, notice };
      });
    } finally {
      if (listController.current === controller) listController.current = null;
    }
  }, [accountId, listScope, party, session.status, session.userId, status]);

  useEffect(() => {
    void loadFirst(false);
    return () => {
      listSequence.current += 1;
      moreSequence.current += 1;
      listController.current?.abort();
      moreController.current?.abort();
    };
  }, [loadFirst]);

  useEffect(() => {
    detailController.current?.abort();
    const sequence = ++detailSequence.current;
    if (!orderId || session.status !== "authenticated" || !session.userId) {
      setDetailState({ scope: detailScope, orderId: null, status: "ready", order: null, error: null });
      return () => undefined;
    }
    const controller = new AbortController();
    detailController.current = controller;
    setDetailState({ scope: detailScope, orderId, status: "loading", order: null, error: null });
    void orderApi.detail(orderId, controller.signal).then((order) => {
      if (!controller.signal.aborted && sequence === detailSequence.current) setDetailState({ scope: detailScope, orderId, status: "ready", order, error: null });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || sequence !== detailSequence.current || isAbortError(error)) return;
      const typed = errorFrom(error);
      if (isAuthenticationFailure(typed)) {
        listController.current?.abort();
        moreController.current?.abort();
        listController.current = null;
        moreController.current = null;
        listSequence.current += 1;
        moreSequence.current += 1;
        setListState({ ...emptyListState(listScope), notice: "登录状态已变化，正在重新确认身份。" });
        session.revalidate();
      }
      setDetailState({ scope: detailScope, orderId, status: "error", order: null, error: typed });
    });
    return () => {
      controller.abort();
      if (detailController.current === controller) detailController.current = null;
    };
  }, [detailReload, detailScope, listScope, orderId, session.revalidate, session.status, session.userId]);

  useEffect(() => {
    const previous = previousOrderId.current;
    if (orderId && !previous) requestAnimationFrame(() => window.scrollTo({ top: 0, behavior: "auto" }));
    if (!orderId && previous) {
      const position = positionRef.current;
      requestAnimationFrame(() => {
        if (position) window.scrollTo({ top: position.scrollY, behavior: "auto" });
        if (!position) return;
        const link = [...document.querySelectorAll<HTMLAnchorElement>("a[data-order-id]")].find((candidate) => candidate.dataset.orderId === position.orderId);
        link?.focus({ preventScroll: true });
      });
    }
    previousOrderId.current = orderId;
  }, [orderId]);

  const loadMore = useCallback(async () => {
    const page = listState.scope === listScope ? listState.page : null;
    if (!page?.nextCursor || session.status !== "authenticated" || !session.userId || moreController.current) return;
    const sequence = listSequence.current;
    const more = ++moreSequence.current;
    const controller = new AbortController();
    moreController.current = controller;
    setListState((previous) => previous.scope === listScope ? { ...previous, loadingMore: true, moreError: null } : previous);
    try {
      const next = await orderApi.list({ party, ...(status ? { status } : {}), ...(accountId ? { accountId } : {}), cursor: page.nextCursor }, controller.signal);
      if (controller.signal.aborted || sequence !== listSequence.current || more !== moreSequence.current) return;
      setListState((previous) => previous.scope !== listScope || !previous.page ? previous : { ...previous, page: { ...next, items: mergeOrderItems(previous.page.items, next.items) }, loadingMore: false, moreError: null });
    } catch (error) {
      if (controller.signal.aborted || sequence !== listSequence.current || more !== moreSequence.current || isAbortError(error)) return;
      const typed = errorFrom(error);
      if (typed.status === 409) {
        await loadFirst(true, "筛选或分页状态已变化，已重新读取。");
      } else if (isPrivateBoundary(typed)) {
        setListState({ scope: listScope, page: null, loading: false, refreshing: false, loadingMore: false, error: typed, moreError: null, notice: "" });
      } else {
        setListState((previous) => previous.scope === listScope ? { ...previous, loadingMore: false, moreError: typed } : previous);
      }
    } finally {
      if (moreController.current === controller) moreController.current = null;
    }
  }, [accountId, listScope, listState, loadFirst, party, session.status, session.userId, status]);

  const onOpen = (nextOrderId: string, event: ReactMouseEvent<HTMLAnchorElement>) => {
    if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey) positionRef.current = { orderId: nextOrderId, scrollY: window.scrollY };
  };
  const onStatusChange = (next: string) => {
    const nextStatus = isOrderStatus(next) ? next : "";
    router.replace(orderUrl(party, nextStatus, accountId), { scroll: false });
  };
  const visibleListState = listState.scope === listScope ? listState : emptyListState(listScope);
  const retryList = () => void loadFirst(Boolean(visibleListState.page));
  const login = () => { session.revalidate(); router.push(loginHref(party, status, accountId, orderId)); };
  const page = visibleListState.page;
  const detail = orderId
    ? detailState.scope === detailScope && detailState.orderId === orderId
      ? detailState
      : { scope: detailScope, orderId, status: "loading" as const, order: null, error: null }
    : null;
  const title = party === "renter" ? "租入订单" : "出租订单";
  const showingDetail = Boolean(orderId);

  if (session.status !== "authenticated" || !session.userId) return <section className="order-session-guard" role="status"><LockKeyhole size={22} aria-hidden="true" /><h2>正在确认订单身份</h2><p>确认期间不会展示上一位用户的订单数据。</p></section>;
  if (showingDetail && detail) return <Detail party={party} status={status} accountId={accountId} orderId={orderId!} state={detail} onRetry={() => setDetailReload((value) => value + 1)} onLogin={login} />;
  return <section className="order-workspace order-account-workspace" aria-labelledby={`orders-${party}-title`} data-testid={`orders-${party}`}>
    <div className="order-workspace-heading account-module-heading"><div><h2 id={`orders-${party}-title`}>{title}</h2><p>{party === "renter" ? "查看你发起的租号订单、费用与当前状态。" : "查看租客提交的订单、订单金额与当前状态。"}</p></div><button type="button" className="button quiet" onClick={retryList} disabled={visibleListState.refreshing}><RefreshCw size={15} aria-hidden="true" />{visibleListState.refreshing ? "刷新中…" : "刷新"}</button></div>
    <div className="order-list-toolbar"><label htmlFor={`order-status-${party}`}>订单状态<select id={`order-status-${party}`} value={status} onChange={(event) => onStatusChange(event.target.value)}><option value="">全部状态</option>{(Object.keys(STATUS_LABELS) as OrderStatus[]).map((value) => <option key={value} value={value}>{STATUS_LABELS[value]}</option>)}</select></label>{party === "owner" && Boolean(page?.items.length || status || accountId) ? <Link className="account-inline-link" href="/account?view=accounts" scroll={false}>管理账号资料与上架状态</Link> : null}</div>
    {accountId ? <div className="account-filter-context"><span>正在查看指定账号的订单</span><Link href={orderUrl(party, status)} scroll={false}>查看全部{title}</Link></div> : null}
    {listState.notice ? <p className="order-inline-notice" role="status">{listState.notice}</p> : null}
    {visibleListState.error ? <OrderError error={visibleListState.error} first={!page} onRetry={retryList} onLogin={login} onReauthorize={() => session.revalidate()} label={page ? "刷新失败" : undefined} /> : null}
    <section className="order-list-panel account-module-card" aria-labelledby={`order-list-title-${party}`} aria-busy={visibleListState.loading || visibleListState.refreshing || visibleListState.loadingMore}>
      <div className="order-list-heading"><h3 id={`order-list-title-${party}`}>订单记录</h3>{page ? <span>当前显示 {page.items.length} 条</span> : null}</div>
      {visibleListState.loading && !page ? <div className="order-skeleton-list" aria-busy="true" role="status"><span /><span /><span /></div> : null}
      {!visibleListState.loading && !visibleListState.error && (!page || page.items.length === 0) ? (
        <div className="order-list-empty account-empty-state">
          <FileText size={26} aria-hidden="true" />
          <h3>{status ? "没有符合筛选条件的订单" : accountId ? "该账号暂无订单记录" : party === "renter" ? "还没有租入记录" : "尚未收到出租订单"}</h3>
          <p>
            {status
              ? "可以切换订单状态，或清除当前状态筛选。"
              : accountId
              ? "这里仅展示当前账号对应的交易记录。"
              : party === "renter"
              ? "选好账号并创建订单后，交易进展会显示在这里。"
              : "租客创建订单后，交易记录会显示在这里；账号资料与上架状态在出租账号管理中处理。"}
          </p>
          <div className="order-empty-actions">
            {status ? (
              <button type="button" className="button secondary button--sm" onClick={() => onStatusChange("")}>
                清除状态筛选
              </button>
            ) : party === "renter" ? (
              <Link href="/accounts" className="button secondary button--sm">
                浏览可租账号
              </Link>
            ) : (
              <Link href={accountId ? `/account?view=accounts&accountId=${encodeURIComponent(accountId)}` : "/account?view=accounts"} className="button secondary button--sm">
                管理出租账号
              </Link>
            )}
          </div>
        </div>
      ) : null}
      {page?.items.length ? <ul className="order-list">{page.items.map((order) => <ListRow key={order.id} party={party} order={order} status={status} accountId={accountId} onOpen={onOpen} />)}</ul> : null}
      {visibleListState.moreError ? <div className="order-more-error" role="alert"><AlertCircle size={17} aria-hidden="true" /><span>更多订单暂未加载，已显示的记录仍保留。</span><button type="button" className="button secondary" onClick={() => void loadMore()}>重试加载</button></div> : null}
      {page && page.items.length > 0 && page.nextCursor && !visibleListState.moreError ? <button type="button" className="button secondary order-more" onClick={() => void loadMore()} disabled={visibleListState.loadingMore}>{visibleListState.loadingMore ? "正在加载…" : "加载更多订单"}</button> : null}
      {page && page.items.length > 0 && !page.nextCursor && !visibleListState.moreError ? <p className="order-list-end">没有更多订单了。</p> : null}
    </section>
  </section>;
}
