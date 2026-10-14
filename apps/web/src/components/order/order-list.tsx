"use client";

import Link from "next/link";
import type { MouseEvent as ReactMouseEvent } from "react";
import { AlertCircle, ChevronRight, Info, RefreshCw } from "lucide-react";
import { orderItemKey, formatOrderMoney, formatOrderTime as timeText, type FulfillmentAssignment, type Order, type OrderPage, type OrderParty, type OrderRequestError, type OrderStatusFilter } from "@/lib/order-client";
import { groupedInteger, unitLabel } from "@/lib/order-display";
import { paymentEntryOpen } from "@/lib/order-display";
import { OrderError, OrderStatusBadge, orderUrl, STATUS_LABELS, termText } from "@/components/order/order-presentation";
import "./order.css";

export type OrderListState = {
  page: OrderPage | null;
  loading: boolean;
  refreshing: boolean;
  loadingMore: boolean;
  error: OrderRequestError | null;
  moreError: OrderRequestError | null;
  notice: string;
};

export const ORDER_LIST_FILTERS: Array<{ value: OrderStatusFilter; label: string }> = [
  { value: "", label: "全部" },
  { value: "PENDING_PAYMENT", label: STATUS_LABELS.PENDING_PAYMENT },
  { value: "PAID", label: STATUS_LABELS.PAID },
  { value: "COMPLETED", label: STATUS_LABELS.COMPLETED },
  { value: "CANCELLED", label: STATUS_LABELS.CANCELLED },
];

function fulfillmentText(value: FulfillmentAssignment): string {
  if (value.state === "WAITING") return value.waitingReason === "NO_ELIGIBLE_STAFF" ? "当前暂无可用客服" : "等待客服分配";
  if (value.state === "ASSIGNED" && value.teamReady) return "订单群已就绪";
  if (value.state === "ASSIGNED") return "订单群准备中";
  return "履约状态待确认";
}

/** Compact Beijing date for a list row; the detail keeps the exact, offset-annotated time. */
function shortTime(value: string | null | undefined): string {
  if (!value) return "待确认";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "待确认";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).format(date);
}

/**
 * Orders bind to one account, so an order number alone tells two similar orders apart only by digits.
 * This is the account's resource signature in the same spirit as the account list's structured title:
 * it is built only from what the order read actually returned, and a line with neither name nor known
 * unit is left as "资源" rather than guessed at.
 */
function resourceSummary(order: Order): string | null {
  const lines = order.quote?.lines ?? [];
  if (lines.length === 0) return null;
  return lines.map((line) => {
    const name = line.name?.trim() || unitLabel(line.unit) || "资源";
    const raw = line.quantity ?? line.unitQuantity;
    if (raw === null || raw === undefined || raw === "") return name;
    if (!/^\d+$/.test(raw)) return `${name} ${raw}`;
    if (line.unit === "HAFF_BASE") {
      const value = BigInt(raw);
      const whole = value / 1_000_000n;
      const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
      return `${name} ${fraction ? `${whole}.${fraction}` : whole.toString()} M`;
    }
    return `${name} ×${groupedInteger(raw)}`;
  }).join(" · ");
}

/**
 * One line of state-specific context under the badge. Nothing here repeats a rule the whole list
 * already states once in the footnote, so a row never has to say "see the detail" to look complete.
 */
function statusHint(order: Order): string | null {
  if (order.readOnly) return order.status === "PAID" ? "进度以订单记录为准" : null;
  if (order.status === "PENDING_PAYMENT") {
    if (order.expiredAwaitingCancel) return "已到期，取消处理中";
    return `占用截止 · ${timeText(order.holdUntil)}`;
  }
  if (order.status === "PAID") return order.fulfillmentAssignment ? fulfillmentText(order.fulfillmentAssignment) : "等待客服分配";
  if (order.status === "COMPLETED") return null;
  if (order.status === "CANCELLED") return "订单已关闭，账号占用已解除";
  return "状态以服务端记录为准";
}

/**
 * The money column names what the figure actually is for this row's state. A closed order never
 * reads as an unpaid bill and a settled one never reads as still payable; the numbers themselves
 * are still the server's order snapshot, never recomputed here.
 */
function amountFacts(order: Order, party: OrderParty): { main: string; caption: string; secondary: string[] } {
  if (order.readOnly && order.source?.origin === "LEGACY") {
    if (party === "owner") return { main: "待确认", caption: "结算收入待确认", secondary: [] };
    const paid = order.payment?.state === "RECORDED_PAID";
    return { main: formatOrderMoney(paid ? order.legacyAmounts?.paid : order.legacyAmounts?.required), caption: paid ? "已付金额记录" : "订单应付", secondary: [] };
  }
  const amounts = order.amounts;
  const settled = order.status === "COMPLETED";
  if (party === "owner") {
    // The owner is quoted at listing time; what the renter actually pays is a different number
    // (rental discounts apply), so a row never carries the other side's figure.
    const quote = order.quote?.ownerTotal;
    return quote
      ? { main: formatOrderMoney(quote), caption: "下单时号主报价", secondary: [] }
      : { main: "待确认", caption: "号主报价暂不可用", secondary: [] };
  }
  const caption = order.status === "PENDING_PAYMENT" ? "待支付"
    : order.status === "PAID" ? "已支付"
    : settled ? "实付 · 下单快照"
    : "下单金额";
  return {
    main: formatOrderMoney(amounts?.totalDue),
    caption,
    secondary: [`租赁 ${formatOrderMoney(amounts?.rental)}`, `押金 ${formatOrderMoney(amounts?.deposit)}`],
  };
}

function ListRow({ party, order, status, accountId, onOpen }: { party: OrderParty; order: Order; status: OrderStatusFilter; accountId?: string; onOpen: (orderId: string, event: ReactMouseEvent<HTMLAnchorElement>) => void }) {
  const facts = amountFacts(order, party);
  const hint = statusHint(order);
  const resources = resourceSummary(order);
  // Only the renter, and only while the server still offers the payment entry, is invited to pay.
  const pending = party === "renter" && paymentEntryOpen(order);
  return <li className="order-row" data-order-status={order.status}>
    <div className="order-row-account">
      {/* The title link is the row's single focusable target; its click surface covers the whole row. */}
      <Link className="order-row-title" href={orderUrl(party, status, accountId, order.id, order.source?.origin)} scroll={false} data-order-id={order.id} data-order-key={orderItemKey(order)} onClick={(event) => onOpen(orderItemKey(order), event)}>{order.title ?? "账号信息暂不可用"}</Link>
      {resources ? <p className="order-row-resources">{resources}</p> : null}
      <p className="order-row-meta">
        <span className="order-row-no">订单 {order.displayNo ?? "暂不可用"}</span>
        <span aria-hidden="true">·</span>
        <span>{shortTime(order.createdAt)}</span>
        <span aria-hidden="true">·</span>
        <span>约定租期 {termText(order.termSeconds)}</span>
      </p>
      {party === "owner" && !order.readOnly ? <p className="order-row-meta">租客：{order.renterName ?? "暂不显示"}</p> : null}
    </div>
    {/* Badge and its explanation stay one block so the state column never opens a hole beside a taller account block. */}
    <div className="order-row-state">
      <OrderStatusBadge order={order} />
      {hint ? <p className="order-row-hint">{hint}</p> : null}
    </div>
    <div className="order-row-amount">
      <strong>{facts.main}</strong>
      <span className="order-row-amount-label">{facts.caption}</span>
      {facts.secondary.length ? <span className="order-row-amount-sub">{facts.secondary.map((line) => <span key={line}>{line}</span>)}</span> : null}
    </div>
    <span className={`order-row-action${pending ? " is-primary" : ""}`} aria-hidden="true">{pending ? "查看并付款" : "查看订单"}<ChevronRight size={15} /></span>
  </li>;
}

/** Approved empty-state art is reserved for a genuinely empty full list; filter misses and scoped views stay text-only. */
const EMPTY_ART: Partial<Record<OrderParty, string>> = {
  renter: "/art/empty/rental-discover-r1.webp",
  owner: "/art/empty/owner-orders-r1.webp",
};

function emptyCopy(party: OrderParty, status: OrderStatusFilter, accountId?: string): { title: string; body: string; art?: string } {
  if (status) return { title: "没有符合筛选条件的订单", body: "可以切换订单状态，或清除当前状态筛选。" };
  if (accountId) return { title: "该账号暂无订单记录", body: "这里仅展示当前账号对应的交易记录。" };
  if (party === "renter") return { title: "还没有租入订单", body: "选好账号并创建订单后，交易进展会显示在这里。", art: EMPTY_ART.renter };
  return { title: "还没有收到出租订单", body: "租客创建订单后，交易记录会显示在这里；账号资料与上架状态在出租账号管理中处理。", art: EMPTY_ART.owner };
}

function emptyAction(party: OrderParty, status: OrderStatusFilter, accountId: string | undefined, className: string) {
  if (status) return <Link className={className} href={orderUrl(party, "", accountId)} scroll={false} replace>清除状态筛选</Link>;
  if (party === "renter") return <Link className={className} href="/accounts">浏览可租账号</Link>;
  return <Link className={className} href={accountId ? `/account?view=accounts&accountId=${encodeURIComponent(accountId)}` : "/account?view=accounts"} scroll={false}>管理出租账号</Link>;
}

export function OrderListPanel({ party, status, accountId, state, onRefresh, onRetryList, onLoadMore, onLogin, onReauthorize, onOpen }: {
  party: OrderParty;
  status: OrderStatusFilter;
  accountId?: string;
  state: OrderListState;
  onRefresh: () => void;
  onRetryList: () => void;
  onLoadMore: () => void;
  onLogin: () => void;
  onReauthorize: () => void;
  onOpen: (orderId: string, event: ReactMouseEvent<HTMLAnchorElement>) => void;
}) {
  const page = state.page;
  const title = party === "renter" ? "租入订单" : "出租订单";
  const empty = emptyCopy(party, status, accountId);
  const loaded = page?.items.length ?? 0;
  // Art and the "nothing here" layout are reserved for a successful read of a list that is truly empty.
  const emptyNow = !state.loading && !state.error && Boolean(page) && loaded === 0;
  return <section className="order-workspace order-account-workspace" aria-labelledby={`orders-${party}-title`} data-testid={`orders-${party}`}>
    <div className="order-workspace-heading account-module-heading">
      <div>
        <h2 id={`orders-${party}-title`}>{title}</h2>
        <p>{party === "renter" ? "查看订单进展，处理当前事项。" : "查看租客订单与当前进展。"}</p>
      </div>
      <div className="order-workspace-actions">
        {party === "owner" ? <Link className="account-inline-link" href="/account?view=accounts" scroll={false}>管理出租账号</Link> : null}
        <button type="button" className="button quiet" onClick={onRefresh} disabled={state.refreshing}><RefreshCw size={15} aria-hidden="true" />{state.refreshing ? "刷新中…" : "刷新"}</button>
      </div>
    </div>
    <nav className="order-filter-bar" aria-label={`${title}状态`}>
      {ORDER_LIST_FILTERS.map((filter) => <Link key={filter.value || "all"} className="order-filter" href={orderUrl(party, filter.value, accountId)} scroll={false} replace aria-current={status === filter.value ? "page" : undefined}>{filter.label}</Link>)}
    </nav>
    {accountId ? <div className="account-filter-context"><span>正在查看指定账号的订单</span><Link href={orderUrl(party, status)} scroll={false}>查看全部{title}</Link></div> : null}
    {state.notice ? <p className="order-inline-notice" role="status">{state.notice}</p> : null}
    {state.error ? <OrderError error={state.error} first={!page} onRetry={onRetryList} onLogin={onLogin} onReauthorize={onReauthorize} label={page ? "刷新失败" : undefined} /> : null}
    <section className="order-list-panel account-module-card" aria-labelledby={`order-list-title-${party}`} aria-busy={state.loading || state.refreshing || state.loadingMore} data-empty={emptyNow ? "true" : undefined}>
      {emptyNow ? null : <div className="order-list-heading"><h3 id={`order-list-title-${party}`}>订单记录</h3></div>}
      {emptyNow ? null : <div className="order-list-columns" aria-hidden="true">
        <span>{party === "owner" ? "订单与租客" : "订单与账号"}</span>
        <span>当前状态</span>
        <span>{party === "owner" ? "号主报价" : "订单金额"}</span>
        <span>操作</span>
      </div>}
      {state.loading && !page ? <div className="order-skeleton-list" aria-busy="true" role="status"><span /><span /><span /></div> : null}
      {emptyNow ? (
        empty.art ? (
          <div className="account-empty-art-state">
            <img className="account-empty-art" src={empty.art} alt="" width={240} height={180} loading="lazy" onError={(event) => { event.currentTarget.style.display = "none"; }} />
            <h3>{empty.title}</h3>
            <p>{empty.body}</p>
            <div className="account-empty-actions">{emptyAction(party, status, accountId, "button primary")}</div>
          </div>
        ) : (
          <div className="order-list-empty">
            <h3>{empty.title}</h3>
            <p>{empty.body}</p>
            <div className="order-empty-actions">{emptyAction(party, status, accountId, "button secondary button--sm")}</div>
          </div>
        )
      ) : null}
      {loaded > 0 ? <ul className="order-list">{page?.items.map((order) => <ListRow key={orderItemKey(order)} party={party} order={order} status={status} accountId={accountId} onOpen={onOpen} />)}</ul> : null}
      {state.moreError ? <div className="order-more-error" role="alert"><AlertCircle size={17} aria-hidden="true" /><span>更多订单暂未加载，已显示的记录仍保留。</span><button type="button" className="button secondary" onClick={onLoadMore}>重试加载</button></div> : null}
      {loaded > 0 ? <div className="order-list-footer">
        <span className="order-list-count">{`已加载 ${loaded} 条`}</span>
        {page?.nextCursor && !state.moreError ? <button type="button" className="button secondary" onClick={onLoadMore} disabled={state.loadingMore}>{state.loadingMore ? "正在加载…" : "加载更多订单"}</button> : null}
        {!page?.nextCursor && !state.moreError ? <span className="order-list-end">没有更多订单了。</span> : null}
      </div> : null}
    </section>
    {emptyNow ? null : <p className="order-list-footnote"><Info size={13} aria-hidden="true" />金额为下单时的订单快照，不代表最终消费或退款到账；实际扣费与应退见订单详情。</p>}
  </section>;
}
