"use client";

import Link from "next/link";
import type { MouseEvent as ReactMouseEvent } from "react";
import { AlertCircle, ChevronRight, Info, RefreshCw } from "lucide-react";
import { orderItemKey, formatOrderTime as timeText, type FulfillmentAssignment, type Order, type OrderLine, type OrderPage, type OrderParty, type OrderRequestError, type OrderStatusFilter } from "@/lib/order-client";
import { groupedInteger, orderAccountTitle, orderAmountFacts, orderRentalModeLabel, paymentEntryOpen } from "@/lib/order-display";
import { OrderError, OrderStatusBadge, orderTermLabel, orderUrl, STATUS_LABELS } from "@/components/order/order-presentation";
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
function resourceSummary(order: Order, includeHaff = true): string | null {
  const lines = order.quote?.lines ?? [];
  if (lines.length === 0) return null;
  const quantity = (line: OrderLine) => line.quantity ?? line.unitQuantity;
  const isZero = (line: OrderLine) => {
    const raw = quantity(line);
    return typeof raw === "string" && /^\d+$/.test(raw) && BigInt(raw) === 0n;
  };
  const haffText = (line: OrderLine): string | null => {
    const raw = quantity(line);
    if (line.unit !== "HAFF_BASE" || raw === null || raw === undefined || !/^\d+$/.test(raw)) return null;
    const value = BigInt(raw), whole = value / 1_000_000n;
    const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
    return `哈夫币 ${fraction ? `${whole}.${fraction}` : whole.toString()} M`;
  };
  const lineText = (line: OrderLine): string => {
    const name = line.name!.trim();
    const raw = quantity(line);
    if (raw === null || raw === undefined || raw === "") return name;
    if (!/^\d+$/.test(raw)) return `${name} ${raw}`;
    return `${name} ×${groupedInteger(raw)}`;
  };
  const isHaffLine = (line: OrderLine) => line.unit === "HAFF_BASE" || line.name?.trim() === "哈夫币";
  const allUnnamed = lines.filter((line) => !line.name?.trim() && !isZero(line));
  const haff = allUnnamed.find(isHaffLine);
  const named = lines.filter((line) => Boolean(line.name?.trim()) && !isZero(line) && (includeHaff || !isHaffLine(line)));
  const unnamed = allUnnamed.filter((line) => includeHaff || !isHaffLine(line));
  if (named.length === 0) {
    const otherUnnamed = unnamed.filter((line) => line !== haff);
    if (!includeHaff) return otherUnnamed.length ? `物资 ${otherUnnamed.length} 项` : null;
    const haffValue = haff ? haffText(haff) : null;
    if (haffValue) return [haffValue, ...(otherUnnamed.length ? [`物资 ${otherUnnamed.length} 项`] : [])].join(" · ");
    return otherUnnamed.length ? `物资 ${otherUnnamed.length} 项` : null;
  }
  const parts = named.map((line) => lineText(line));
  if (includeHaff && haff) parts.push(haffText(haff)!);
  const otherUnnamed = unnamed.filter((line) => line !== haff).length;
  if (otherUnnamed) parts.push(`物资 ${otherUnnamed} 项`);
  return parts.join(" · ");
}

/**
 * One line of state-specific context under the badge. Nothing here repeats a rule the whole list
 * already states once in the footnote, so a row never has to say "see the detail" to look complete.
 */
function statusHint(order: Order): string | null {
  if (order.readOnly) return order.status === "PAID" ? "进度以订单记录为准" : null;
  if (order.stage?.label && order.stage.code !== "NONE") {
    return order.stage.viewerActionRequired ? `${order.stage.label} · 需要你处理` : order.stage.label;
  }
  if (order.status === "PENDING_PAYMENT") {
    if (order.expiredAwaitingCancel) return "已到期，取消处理中";
    return `占用截止 · ${timeText(order.holdUntil)}`;
  }
  if (order.status === "PAID") return order.fulfillmentAssignment ? fulfillmentText(order.fulfillmentAssignment) : "等待客服分配";
  if (order.status === "COMPLETED") return null;
  if (order.status === "CANCELLED") return "订单已关闭，账号占用已解除";
  return "状态以服务端记录为准";
}

function ListRow({ party, order, status, accountId, onOpen }: { party: OrderParty; order: Order; status: OrderStatusFilter; accountId?: string; onOpen: (orderId: string, event: ReactMouseEvent<HTMLAnchorElement>) => void }) {
  const facts = orderAmountFacts(order, party);
  const hint = statusHint(order);
  const title = orderAccountTitle(order);
  const resources = order.source?.origin === "LEGACY" ? null : resourceSummary(order, !title.includes("哈夫币"));
  const modeLabel = orderRentalModeLabel(order);
  // Only the renter, and only while the server still offers the payment entry, is invited to pay.
  const pending = party === "renter" && paymentEntryOpen(order);
  return <li className="order-row" data-order-status={order.status}>
    <div className="order-row-account">
      {/* The title link is the row's single focusable target; its click surface covers the whole row. */}
      <div className="order-row-title-line">
        <Link className="order-row-title" href={orderUrl(party, status, accountId, order.id, order.source?.origin)} scroll={false} data-order-id={order.id} data-order-key={orderItemKey(order)} onClick={(event) => onOpen(orderItemKey(order), event)}>{title}</Link>
        {modeLabel ? <span className="order-row-tag" data-mode={order.quote?.rentalMode}>{modeLabel}</span> : null}
        {!order.listingFacts && order.listingFactsUnknownReason ? <span className="order-row-tag">资料待核实</span> : null}
      </div>
      {resources ? <p className="order-row-resources">{resources}</p> : null}
      <p className="order-row-meta">
        {order.accountDisplayNo ? <><span className="order-row-account-no">账号 {order.accountDisplayNo}</span><span aria-hidden="true">·</span></> : null}
        <span className="order-row-no">订单 {order.displayNo ?? "暂不可用"}</span>
        <span aria-hidden="true">·</span>
        <span>{shortTime(order.createdAt)}</span>
        <span aria-hidden="true">·</span>
        <span>{orderTermLabel(order)}</span>
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
  return { title: "还没有收到出租订单", body: "租客创建订单后，交易记录会显示在这里；账号资料与上架状态在上架账号中处理。", art: EMPTY_ART.owner };
}

function emptyAction(party: OrderParty, status: OrderStatusFilter, accountId: string | undefined, className: string) {
  if (status) return <Link className={className} href={orderUrl(party, "", accountId)} scroll={false} replace>清除状态筛选</Link>;
  if (party === "renter") return <Link className={className} href="/accounts">浏览可租账号</Link>;
  return <Link className={className} href={accountId ? `/account?view=accounts&accountId=${encodeURIComponent(accountId)}` : "/account?view=accounts"} scroll={false}>管理上架账号</Link>;
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
        {party === "owner" ? <Link className="account-inline-link" href="/account?view=accounts" scroll={false}>管理上架账号</Link> : null}
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
