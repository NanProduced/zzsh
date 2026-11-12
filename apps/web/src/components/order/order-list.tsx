"use client";

import Link from "next/link";
import { useEffect, useState, type FormEvent, type MouseEvent as ReactMouseEvent } from "react";
import { AlertCircle, Check, ChevronDown, ChevronRight, Copy, Info, MessageCircle, RefreshCw, RotateCcw, Search } from "lucide-react";
import { orderItemKey, formatOrderTime as timeText, type FulfillmentAssignment, type Order, type OrderPage, type OrderParty, type OrderRequestError, type OrderStatusFilter, type OrderSearchFilters } from "@/lib/order-client";
import { orderAccountTitle, orderAmountFacts, orderPaymentUrl, orderRentalModeLabel, orderSettlementStageLabel, paymentEntryOpen } from "@/lib/order-display";
import { OrderError, OrderStatusBadge, orderUrl, STATUS_LABELS } from "@/components/order/order-presentation";
import { DatePicker, FormSelect } from "@/components/ui/form-controls";
import { useUserSession } from "@/components/session/user-session-provider";
import { requestSupportDialog } from "@/components/support/support-dialog-request";
import "./order.css";

const STAGE_OPTIONS = [
  { value: "", label: "全部进度" },
  { value: "OPENING_PENDING", label: "等待开租确认" },
  { value: "RENTING", label: "租赁中" },
  { value: "INTAKE_PENDING", label: "结算受理中" },
  { value: "DECISION_PENDING", label: "待你确认结算" },
  { value: "DECISION_WAITING", label: "等待对方或平台确认" },
  { value: "DECISION_REJECTED", label: "结算方案未达成一致" },
  { value: "POSTED", label: "已结算" },
  { value: "UNKNOWN", label: "进度未记录" },
];

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
  { value: "ALL", label: "全部" },
  { value: "IN_PROGRESS", label: "进行中" },
  { value: "PENDING_PAYMENT", label: STATUS_LABELS.PENDING_PAYMENT },
  { value: "PAID", label: STATUS_LABELS.PAID },
  { value: "COMPLETED", label: STATUS_LABELS.COMPLETED },
  { value: "CANCELLED", label: STATUS_LABELS.CANCELLED },
];

function fulfillmentText(value: FulfillmentAssignment): string {
  if (value.state === "WAITING") return value.waitingReason === "NO_ELIGIBLE_STAFF" ? "当前暂无可用客服" : "等待客服分配";
  if (value.state === "ASSIGNED" && value.teamReady) return "订单群已就绪";
  if (value.state === "ASSIGNED") return "订单群准备中";
  return "履约状态未记录";
}

/** Compact Beijing date for a list row; the detail keeps the exact, offset-annotated time. */
function shortTime(value: string | null | undefined): string {
  if (!value) return "未记录";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "未记录";
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
/**
 * One line of state-specific context under the badge. Nothing here repeats a rule the whole list
 * already states once in the footnote, so a row never has to say "see the detail" to look complete.
 */
function statusHint(order: Order, status: OrderStatusFilter): string | null {
  const stage = orderSettlementStageLabel(order);
  if (order.readOnly) return order.status === "PAID" ? stage ?? "进度未记录" : null;
  if (status === "IN_PROGRESS" && (order.status === "CANCELLED" || order.status === "COMPLETED")) return "退款处理中或待核对";
  if (stage) {
    return order.stage?.viewerActionRequired ? `${stage} · 需要你处理` : stage;
  }
  if (order.status === "PENDING_PAYMENT") {
    if (order.expiredAwaitingCancel) return "已到期，取消处理中";
    return `占用截止 · ${timeText(order.holdUntil)}`;
  }
  if (order.status === "PAID") return order.fulfillmentAssignment ? fulfillmentText(order.fulfillmentAssignment) : "等待客服分配";
  if (order.status === "COMPLETED") return null;
  if (order.status === "CANCELLED") return null;
  return "订单状态未记录";
}

function InlineCopyBtn({ text, label }: { text: string; label: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async (e: ReactMouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {}
  };
  return (
    <button type="button" className="order-inline-copy-btn" title={`复制${label}`} aria-label={copied ? `已复制${label}` : `复制${label}`} onClick={copy}>
      {copied ? <Check size={11} aria-hidden="true" /> : <Copy size={11} aria-hidden="true" />}
    </button>
  );
}

function ListRow({ party, order, status, accountId, filters, onOpen }: { party: OrderParty; order: Order; status: OrderStatusFilter; accountId?: string; filters?: OrderSearchFilters; onOpen: (orderId: string, event: ReactMouseEvent<HTMLAnchorElement>) => void }) {
  const session = useUserSession();
  const facts = orderAmountFacts(order, party);
  const caption = !order.readOnly && party === "renter" && ["PAID", "COMPLETED"].includes(order.status) ? "下单金额" : facts.caption === "下单时号主报价" ? "下单时的出租报价" : facts.caption;
  const hint = statusHint(order, status);
  const title = orderAccountTitle(order);
  const modeLabel = orderRentalModeLabel(order);
  const loginMethod = order.listingFacts?.attributeDisplay?.loginMethod;
  // Only the renter, and only while the server still offers the payment entry, is invited to pay.
  const pending = party === "renter" && paymentEntryOpen(order);
  const inProgress = order.status === "PAID";
  const legacy = order.source?.origin === "LEGACY";
  const detailHref = orderUrl(party, status, accountId, order.id, order.source?.origin, filters);
  const actionHref = legacy ? `${detailHref}#order-legacy-continuation` : detailHref;
  type QuickAction = { label: string; href?: string; support?: true };
  const primaryQuick: QuickAction | null = !inProgress ? null : legacy ? { label: "进行结算", href: actionHref } : (() => {
    switch (order.stage?.code) {
      case "OPENING_PENDING": return { label: "确认开租", href: actionHref };
      case "RENTING": return { label: "进行结算", href: actionHref };
      case "DECISION_PENDING": return { label: "确认结算", href: actionHref };
      case "INTAKE_PENDING":
      case "DECISION_WAITING": return { label: "查看结算", href: actionHref };
      case "DECISION_REJECTED": return { label: "联系客服", support: true };
      default: return { label: "查看订单", href: detailHref };
    }
  })();
  const action = order.stage?.viewerActionRequired ? "查看并处理" : "查看订单";
  const titleAction = pending || inProgress ? "查看订单" : action;
  const openSupport = (event: ReactMouseEvent<HTMLButtonElement>) => {
    requestSupportDialog("SERVICE", event.currentTarget, session.status === "authenticated" && session.userId
      ? { userId: session.userId, subjectRef: `order:${order.id}`, recordId: order.id, draftText: `订单 ${order.displayNo ?? order.id}` }
      : undefined);
  };
  return <li className="order-row" data-order-status={order.status} data-action-required={order.stage?.viewerActionRequired || pending ? "true" : undefined}>
    <div className="order-row-account">
      {/* The title takes the full line; tags and metadata never wrap around it. */}
      <Link className="order-row-title" title={title} href={detailHref} scroll={false} data-order-id={order.id} data-order-key={orderItemKey(order)} aria-label={[titleAction, order.displayNo ? `订单号 ${order.displayNo}` : null, title].filter(Boolean).join("，")} onClick={(event) => onOpen(orderItemKey(order), event)}>{title}</Link>
      <p className="order-row-meta">
        {loginMethod ? <span className="order-row-tag order-row-login">{loginMethod}</span> : null}
        {modeLabel ? <span className="order-row-tag" data-mode={order.quote?.rentalMode}>{modeLabel}</span> : null}
        {!order.listingFacts && order.listingFactsUnknownReason ? <span className="order-row-tag">资料未确认</span> : null}
        <span className="order-row-no">
          订单 {order.displayNo ?? "暂不可用"}
          {order.displayNo ? <InlineCopyBtn text={order.displayNo} label="订单号" /> : null}
        </span>
        <span className="order-row-date">{shortTime(order.createdAt)}</span>
      </p>
    </div>
    {/* Badge and its explanation stay one block so the state column never opens a hole beside a taller account block. */}
    <div className="order-row-state">
      <OrderStatusBadge order={order} />
      {hint ? <p className="order-row-hint">{hint}</p> : null}
    </div>
    <div className="order-row-amount">
      <strong>{facts.main}</strong>
      <span className="order-row-amount-label">{caption}</span>
      {facts.secondary.length ? <span className="order-row-amount-sub">{facts.secondary.map((line) => <span key={line}>{line.replace("原退款金额记录", "退款记录金额")}</span>)}</span> : null}
    </div>
    {inProgress ? <div className="order-row-actions">
      {primaryQuick?.href
        ? <Link className="order-row-quick" href={primaryQuick.href} scroll={false} aria-label={`${primaryQuick.label}，订单 ${order.displayNo ?? order.id}`}>{primaryQuick.label}</Link>
        : <button type="button" className="order-row-quick" onClick={openSupport}><MessageCircle size={14} aria-hidden="true" />联系客服</button>}
      {legacy
        ? <button type="button" className="order-row-quick-secondary" onClick={openSupport}><MessageCircle size={13} aria-hidden="true" />联系客服</button>
        : <button type="button" className="order-row-quick-secondary" onClick={() => window.dispatchEvent(new CustomEvent("zzsh:order-groups", { detail: { party, orderId: order.id } }))}><MessageCircle size={13} aria-hidden="true" />打开订单群</button>}
    </div> : pending ? <div className="order-row-actions">
      <Link className="order-row-quick is-solid" href={orderPaymentUrl(party, status, accountId, order.id, order.source?.origin, filters)} scroll={false} aria-label="继续支付订单">继续支付<ChevronRight size={15} aria-hidden="true" /></Link>
    </div> : <div className="order-row-actions">
      <Link className="order-row-quick is-quiet" href={detailHref} scroll={false} aria-label={`${action}，订单 ${order.displayNo ?? order.id}`}>{action}<ChevronRight size={15} aria-hidden="true" /></Link>
    </div>}
  </li>;
}

/** Approved empty-state art is reserved for a genuinely empty full list; filter misses and scoped views stay text-only. */
const EMPTY_ART: Partial<Record<OrderParty, string>> = {
  renter: "/art/empty/rental-discover-r1.webp",
  owner: "/art/empty/owner-orders-r1.webp",
};

function emptyCopy(party: OrderParty, status: OrderStatusFilter, accountId?: string): { title: string; body: string; art?: string } {
  if (status === "IN_PROGRESS") return { title: accountId ? "该账号当前没有进行中的订单" : "当前没有进行中的订单", body: "已完成、已取消或全部记录可从上方切换查看。进行中包含待付款、履约中，以及有退款处理中的已取消/已完成订单。" };
  if (status && status !== "ALL") return { title: "没有符合筛选条件的订单", body: "可以切换订单状态，或查看全部订单。" };
  if (accountId) return { title: "该账号暂无订单记录", body: "这里仅展示当前账号对应的交易记录。" };
  if (party === "renter") return { title: "还没有租入订单", body: "选好账号并创建订单后，交易进展会显示在这里。", art: EMPTY_ART.renter };
  return { title: "还没有收到出租订单", body: "租客下单后，可在这里查看订单进度。", art: EMPTY_ART.owner };
}

function emptyAction(party: OrderParty, status: OrderStatusFilter, accountId: string | undefined, className: string) {
  if (status && status !== "ALL") return <Link className={className} href={orderUrl(party, "ALL", accountId)} scroll={false} replace>查看全部订单</Link>;
  if (party === "renter") return <Link className={className} href="/accounts">浏览可租账号</Link>;
  return <Link className={className} href={accountId ? `/account?view=accounts&accountId=${encodeURIComponent(accountId)}` : "/account?view=accounts"} scroll={false}>管理账号</Link>;
}

export function OrderListPanel({ party, status, accountId, filters = {}, onApplyFilters, state, onRefresh, onRetryList, onLoadMore, onLogin, onReauthorize, onOpen }: {
  party: OrderParty;
  status: OrderStatusFilter;
  accountId?: string;
  filters?: OrderSearchFilters;
  onApplyFilters: (filters: OrderSearchFilters) => void;
  state: OrderListState;
  onRefresh: () => void;
  onRetryList: () => void;
  onLoadMore: () => void;
  onLogin: () => void;
  onReauthorize: () => void;
  onOpen: (orderId: string, event: ReactMouseEvent<HTMLAnchorElement>) => void;
}) {
  const page = state.page;
  const [draft, setDraft] = useState<OrderSearchFilters>(filters);
  const [filterError, setFilterError] = useState("");
  const [showMoreFilters, setShowMoreFilters] = useState(Boolean(filters.createdFrom || filters.createdTo || filters.stage));
  useEffect(() => { setDraft(filters); setFilterError(""); if (filters.createdFrom || filters.createdTo || filters.stage) setShowMoreFilters(true); }, [filters.orderNo, filters.createdFrom, filters.createdTo, filters.stage]);
  const extraFilter = Boolean(filters.orderNo || filters.createdFrom || filters.createdTo || filters.stage);
  const submitFilters = (event: FormEvent) => {
    event.preventDefault();
    const orderNo = draft.orderNo?.trim() ?? "";
    if (orderNo && (orderNo.length > 255 || /[\u0000-\u001f\u007f]/.test(orderNo))) { setFilterError("请输入有效的订单号。"); return; }
    if (draft.createdFrom && draft.createdTo && draft.createdFrom > draft.createdTo) { setFilterError("开始日期不能晚于结束日期。"); return; }
    setFilterError(""); onApplyFilters({ orderNo: orderNo || undefined, createdFrom: draft.createdFrom || undefined, createdTo: draft.createdTo || undefined, stage: draft.stage || undefined });
  };
  const title = party === "renter" ? "租入订单" : "出租订单";
  const empty = extraFilter ? { title: filters.stage && page?.stageUnknownObserved ? "没有找到已确认符合条件的订单" : "没有符合筛选条件的订单", body: "可以调整订单号、日期或履约阶段。" } : emptyCopy(party, status, accountId);
  const loaded = page?.items.length ?? 0;
  // Art and the "nothing here" layout are reserved for a successful read of a list that is truly empty.
  const emptyNow = !state.loading && !state.error && Boolean(page) && loaded === 0 && !page?.nextCursor;
  return <section className="order-workspace order-account-workspace" aria-labelledby={`orders-${party}-title`} data-testid={`orders-${party}`}>
    <div className="order-workspace-heading account-module-heading">
      <div>
        <h2 id={`orders-${party}-title`}>{title}</h2>
        <p>{party === "renter" ? "查看订单进展，处理当前事项。" : "查看租客订单与当前进展。"}</p>
      </div>
      <div className="order-workspace-actions">
        {party === "owner" ? <Link className="account-inline-link" href="/account?view=accounts" scroll={false}>管理账号</Link> : null}
        <button type="button" className="button quiet" onClick={onRefresh} disabled={state.refreshing}><RefreshCw size={15} aria-hidden="true" />{state.refreshing ? "刷新中…" : "刷新"}</button>
      </div>
    </div>
    <div className="order-filter-console">
      <nav className="order-filter-bar" aria-label={`${title}状态`}>
        {ORDER_LIST_FILTERS.map((filter) => <Link key={filter.value || "all"} className="order-filter" href={orderUrl(party, filter.value, accountId, undefined, undefined, filters)} scroll={false} replace aria-current={status === filter.value ? "page" : undefined}>{filter.label}</Link>)}
      </nav>
      <form className="order-search-filters" onSubmit={submitFilters}>
        <div className="order-search-row">
          <label className="order-search-input-wrap">
            <Search size={15} className="order-search-icon" aria-hidden="true" />
            <span className="sr-only">订单号</span>
            <input value={draft.orderNo ?? ""} maxLength={255} placeholder="输入订单号查找…" onChange={event=>setDraft(value=>({...value,orderNo:event.target.value}))}/>
          </label>
          <button type="submit" className="button secondary order-search-btn">查找订单</button>
          <button type="button" className={`button quiet order-more-toggle${showMoreFilters ? " is-open" : ""}`} aria-expanded={showMoreFilters} aria-controls="order-more-filters" onClick={()=>setShowMoreFilters(value=>!value)}>
            <span>更多筛选</span>
            <ChevronDown size={14} className="order-more-chevron" aria-hidden="true" />
          </button>
          {extraFilter ? <button type="button" className="button quiet order-clear-btn" onClick={()=>onApplyFilters({})} title="清除查找条件"><RotateCcw size={13} aria-hidden="true" /><span>重置</span></button> : null}
        </div>
        <div id="order-more-filters" className="order-search-extra" hidden={!showMoreFilters}>
          <div className="order-extra-field">
            <span className="order-field-label">开始日期</span>
            <DatePicker label="开始日期" value={draft.createdFrom ?? ""} placeholder="年/月/日" onChange={date=>setDraft(value=>({...value,createdFrom:date||undefined}))}/>
          </div>
          <div className="order-extra-field">
            <span className="order-field-label">结束日期</span>
            <DatePicker label="结束日期" value={draft.createdTo ?? ""} placeholder="年/月/日" onChange={date=>setDraft(value=>({...value,createdTo:date||undefined}))}/>
          </div>
          <div className="order-extra-field">
            <span className="order-field-label">订单进度</span>
            <FormSelect label="订单进度" value={draft.stage ?? ""} options={STAGE_OPTIONS} placeholder="全部进度" onChange={stage=>setDraft(value=>({...value,stage:stage||undefined}))}/>
          </div>
        </div>
        {filterError ? <p role="alert" className="order-filter-alert">{filterError}</p> : null}
      </form>
    </div>
    {(filters.createdFrom || filters.createdTo) ? <p className="order-inline-notice">按北京时间的下单日期筛选；没有下单时间的订单不在结果中。</p> : null}
    {page?.stageUnknownObserved ? <p className="order-inline-notice" role="status">部分订单的进度尚未确认。</p> : null}
    {accountId ? <div className="account-filter-context"><span>正在查看指定账号的订单</span><Link href={orderUrl(party, status, undefined, undefined, undefined, filters)} scroll={false}>查看全部{title}</Link></div> : null}
    {state.notice ? <p className="order-inline-notice" role="status">{state.notice}</p> : null}
    {state.error ? <OrderError error={state.error} first={!page} onRetry={onRetryList} onLogin={onLogin} onReauthorize={onReauthorize} label={page ? "刷新失败" : undefined} /> : null}
    <section className="order-list-panel account-module-card" aria-labelledby={`order-list-title-${party}`} aria-busy={state.loading || state.refreshing || state.loadingMore} data-empty={emptyNow ? "true" : undefined}>
      {emptyNow ? null : <div className="order-list-heading"><h3 id={`order-list-title-${party}`}>订单记录</h3></div>}
      {emptyNow ? null : <div className="order-list-columns" aria-hidden="true">
        <span>{party === "owner" ? "订单与租客" : "订单与账号"}</span>
        <span>当前状态</span>
        <span>{party === "owner" ? "出租报价" : "订单金额"}</span>
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
            <div className="order-empty-actions">{extraFilter ? <button type="button" className="button secondary button--sm" onClick={()=>onApplyFilters({})}>清除查找条件</button> : emptyAction(party, status, accountId, "button secondary button--sm")}</div>
          </div>
        )
      ) : null}
      {loaded > 0 ? <ul className="order-list">{page?.items.map((order) => <ListRow key={orderItemKey(order)} party={party} order={order} status={status} accountId={accountId} filters={filters} onOpen={onOpen} />)}</ul> : null}
      {page?.scanIncomplete ? <p className="order-inline-notice" role="status">本次已查找一部分订单；继续查找可检查更早记录。</p> : null}
      {state.moreError ? <div className="order-more-error" role="alert"><AlertCircle size={17} aria-hidden="true" /><span>更多订单暂未加载，已显示的记录仍保留。</span><button type="button" className="button secondary" onClick={onLoadMore}>重试加载</button></div> : null}
      {loaded > 0 || page?.nextCursor ? <div className="order-list-footer">
        <span className="order-list-count">{`已显示 ${loaded} 条`}</span>
        {page?.nextCursor && !state.moreError ? <button type="button" className="button secondary" onClick={onLoadMore} disabled={state.loadingMore}>{state.loadingMore ? "正在加载…" : page.scanIncomplete ? "继续查找订单" : "加载更多订单"}</button> : null}
        {!page?.nextCursor && !state.moreError ? <span className="order-list-end">没有更多订单了。</span> : null}
      </div> : null}
    </section>
    {emptyNow ? null : <p className="order-list-footnote"><Info size={13} aria-hidden="true" />费用与退款进度可在订单详情查看。</p>}
  </section>;
}
