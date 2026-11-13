"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ChevronRight, FileText, Gamepad2, House, RefreshCw } from "lucide-react";
import { useUserSession } from "@/components/session/user-session-provider";
import {
  formatOrderTime,
  orderApi,
  orderItemKey,
  OrderRequestError,
  type Order,
  type OrderPage,
  type OrderParty,
} from "@/lib/order-client";
import { orderTermLabel, orderUrl } from "@/components/order/order-presentation";
import {
  orderAccountTitle,
  orderAmountFacts,
  orderListingSourceLabel,
  orderSettlementStageLabel,
} from "@/lib/order-display";
import { accountSectionHref, isAuthenticationFailure } from "./account-nav-constants";

const STATUS_LABELS: Record<string, string> = {
  PENDING_PAYMENT: "待支付",
  PAID: "已支付",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
};

function coreStatus(order: Order): string {
  if (order.source?.origin === "LEGACY") return order.source.statusLabel ?? "状态待确认";
  if (order.status === "PENDING_PAYMENT" && order.expiredAwaitingCancel) return "已到期 · 取消处理中";
  if (order.status === "CANCELLED" && order.cancelReason === "TIMEOUT") return "已取消 · 到期未支付";
  if (order.status === "CANCELLED" && order.cancelReason === "USER") return "已取消 · 租客取消";
  if (order.status === "CANCELLED" && order.cancelReason === "SUPPORT_UNPAID") return "已取消 · 客服处理";
  if (order.status === "CANCELLED" && order.cancelReason === "OWNER_DELISTED") return "已取消 · 号主下架账号";
  const stage = orderSettlementStageLabel(order);
  if (order.status === "PAID" && stage) return stage;
  return STATUS_LABELS[order.status] ?? "状态待确认";
}

function summaryOrderTime(value: string): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "时间暂不可用";
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
    timeZone: "Asia/Shanghai", hourCycle: "h23",
  }).format(date);
}

export function OrderSummaryCard({
  party,
  scope,
  refreshVersion = 0,
  onStatusChange,
}: {
  party: OrderParty;
  scope: string;
  refreshVersion?: number;
  onStatusChange?: (status: "loading" | "ready" | "error", items: Order[], hasMore: boolean) => void;
}) {
  const session = useUserSession();
  const revalidate = session.revalidate;
  const rental = party === "renter";
  const title = rental ? "我的租入" : "我的出租";
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{
    scope: string;
    status: "loading" | "ready" | "error";
    page: OrderPage | null;
    error: OrderRequestError | null;
  }>({
    scope,
    status: "loading",
    page: null,
    error: null,
  });
  const sequence = useRef(0);
  const onStatusChangeRef = useRef(onStatusChange);
  onStatusChangeRef.current = onStatusChange;
  if (state.scope !== scope) setState({ scope, status: "loading", page: null, error: null });

  useEffect(() => {
    const current = ++sequence.current;
    const controller = new AbortController();
    setState({ scope, status: "loading", page: null, error: null });
    onStatusChangeRef.current?.("loading", [], false);
    if (session.status !== "authenticated" || !session.userId) return () => controller.abort();
    orderApi.listUnified(session.userId, { party, limit: 3 }, controller.signal).then(
      (page) => {
        if (!controller.signal.aborted && current === sequence.current) {
          setState({ scope, status: "ready", page, error: null });
          onStatusChangeRef.current?.("ready", page.items, Boolean(page.nextCursor));
        }
      },
      (error: unknown) => {
        if (controller.signal.aborted || current !== sequence.current) return;
        const failure = error instanceof OrderRequestError ? error : new OrderRequestError(0, null);
        if (isAuthenticationFailure(failure)) revalidate();
        setState({ scope, status: "error", page: null, error: failure });
        onStatusChangeRef.current?.("error", [], false);
      }
    );
    return () => controller.abort();
  }, [party, scope, reload, refreshVersion, revalidate, session.status, session.userId]);

  const page = state.page;
  const items = page?.items.slice(0, 3) ?? [];
  const href = accountSectionHref(rental ? "rentals" : "leased", { view: "overview" });
  const headerActionText = rental ? "全部租入订单" : "全部出租订单";

  return (
    <article
      className={`account-summary-card${state.status === "ready" && items.length === 0 ? " is-empty" : ""}`}
      data-testid={`order-summary-${party}`}
      aria-busy={state.status === "loading" ? true : undefined}
    >
      <header className="account-summary-heading">
        <div className="account-summary-heading-left">
          <span className="account-summary-icon" aria-hidden="true">
            {rental ? <FileText size={20} /> : <House size={20} />}
          </span>
          <h3>{title}</h3>
        </div>
        <Link className="account-summary-header-link" href={href} scroll={false}>
          {headerActionText}<ChevronRight size={14} aria-hidden="true" />
        </Link>
      </header>
      <div className="account-summary-body">
        {state.status === "loading" ? (
          <p className="account-summary-feedback" role="status">正在读取订单</p>
        ) : null}
        {state.status === "error" ? (
          <div className="account-summary-feedback" role="alert">
            <strong>{isAuthenticationFailure(state.error!) ? "登录状态已变化" : `${rental ? "租入订单" : "出租订单"}暂时无法读取`}</strong>
            <button
              type="button"
              className="button secondary button--xs"
              data-testid={`retry-${party}`}
              onClick={() => setReload((value) => value + 1)}
            >
              <RefreshCw size={13} aria-hidden="true" />重试
            </button>
          </div>
        ) : null}
        {state.status === "ready" && page && items.length === 0 ? (
          <div className="account-summary-empty" role="status">
            {/* Approved empty-state art, one per party. Decorative only: the copy and the action below
                carry the meaning, and the block still reads if the picture cannot load. */}
            <img
              className="account-summary-empty-art"
              src={rental ? "/art/empty/rental-discover-r1.webp" : "/art/empty/owner-orders-r1.webp"}
              alt=""
              width={132}
              height={99}
              loading="lazy"
              onError={(event) => { event.currentTarget.style.display = "none"; }}
            />
            <p className="account-summary-empty-title">{rental ? "暂无租入记录" : "暂无出租记录"}</p>
            <span className="account-summary-empty-desc">
              {rental
                ? "租入后，可在这里查看订单进度。"
                : "发布账号，在这里查看后续出租订单。"}
            </span>
            <Link
              className="account-summary-empty-cta"
              href={rental ? "/accounts" : "/publish"}
            >
              {rental ? "浏览账号" : "发布账号"}<ChevronRight size={14} aria-hidden="true" />
            </Link>
          </div>
        ) : null}
        {state.status === "ready" && items.length > 0 ? (
          <div className="account-recent-orders-list">
            {items.map((order) => {
              const orderHref = orderUrl(party, "", undefined, order.id, order.source?.origin);
              const facts = orderAmountFacts(order, party);
              const loginMethod = order.listingFacts?.attributeDisplay?.loginMethod;
              const safeBox = order.listingFacts?.attributeDisplay?.safeBox;
              const title = orderAccountTitle(order);
              return (
                <Link key={orderItemKey(order)} className="account-order-row" href={orderHref} scroll={false}>
                  <div className={`account-order-row-icon is-${party}`} aria-hidden="true">
                    {rental ? <Gamepad2 size={20} /> : <House size={20} />}
                  </div>
                  <div className="account-order-row-main">
                    <div className="account-order-row-badges">
                      {loginMethod ? <span className="account-order-login-tag">{loginMethod}</span> : null}
                      {safeBox ? <span className="account-order-safebox-tag">{safeBox}</span> : null}
                      <strong className="account-order-row-title" title={title}>{title}</strong>
                    </div>
                    <div className="account-order-row-meta">
                      {order.accountDisplayNo ? <span className="account-order-acc-no">账号 {order.accountDisplayNo}</span> : null}
                      {order.displayNo ? <span>单号 {order.displayNo}</span> : null}
                      {order.createdAt ? <time dateTime={order.createdAt} title={formatOrderTime(order.createdAt)} aria-label={formatOrderTime(order.createdAt)}>{summaryOrderTime(order.createdAt)}</time> : null}
                      <span>{orderTermLabel(order)}</span>
                      {orderListingSourceLabel(order) === "历史订单" || orderListingSourceLabel(order)?.startsWith("当前账号资料") ? <span>{orderListingSourceLabel(order)}</span> : null}
                    </div>
                  </div>
                  <div className="account-order-row-money">
                    <span className="account-order-row-money-caption">{facts.caption}</span>
                    <strong className={`account-order-row-money-value${facts.main === "未记录" ? " is-unrecorded" : ""}`}>{facts.main}</strong>
                    {facts.secondary.length ? <span className="account-order-row-money-sub">{facts.secondary.join(" · ")}</span> : null}
                  </div>
                  <div className="account-order-row-end">
                    <span className="account-order-row-status" data-status={order.expiredAwaitingCancel ? "EXPIRING" : order.status} data-testid={`order-status-${party}`}>{coreStatus(order)}</span>
                    <ChevronRight size={15} aria-hidden="true" />
                  </div>
                </Link>
              );
            })}
            {page?.nextCursor ? (
              <p className="account-order-more-hint">还有更多订单，打开列表查看完整记录。</p>
            ) : null}
          </div>
        ) : null}
      </div>
    </article>
  );
}

export function AccountRecentOrdersPanel({
  scope,
  renterRefreshVersion,
  ownerRefreshVersion,
  renterOrders = [],
  ownerOrders = [],
  onRenterStatusChange,
  onOwnerStatusChange,
}: {
  scope: string;
  renterRefreshVersion: number;
  ownerRefreshVersion: number;
  renterOrders?: Order[];
  ownerOrders?: Order[];
  onRenterStatusChange: (status: "loading" | "ready" | "error", items: Order[], hasMore: boolean) => void;
  onOwnerStatusChange: (status: "loading" | "ready" | "error", items: Order[], hasMore: boolean) => void;
}) {
  const [activeTab, setActiveTab] = useState<OrderParty>("renter");
  const rental = activeTab === "renter";
  const moreHref = accountSectionHref(rental ? "rentals" : "leased", { view: "overview" });
  const moreText = rental ? "全部租入订单" : "全部出租订单";

  return (
    <section className="account-overview-orders-container" aria-label="最近订单看板">
      <div className="account-orders-tab-header">
        <div className="account-orders-tabs" role="tablist" aria-label="订单角色切换">
          <button
            type="button"
            role="tab"
            id="tab-renter-orders"
            aria-selected={rental}
            aria-controls="panel-renter-orders"
            className={`account-orders-tab-btn ${rental ? "is-active" : ""}`}
            onClick={() => setActiveTab("renter")}
          >
            <FileText size={16} aria-hidden="true" />
            <span>我的租入</span>
            <span className="account-orders-tab-role-tag">买家视角</span>
          </button>
          <button
            type="button"
            role="tab"
            id="tab-owner-orders"
            aria-selected={!rental}
            aria-controls="panel-owner-orders"
            className={`account-orders-tab-btn ${!rental ? "is-active" : ""}`}
            onClick={() => setActiveTab("owner")}
          >
            <House size={16} aria-hidden="true" />
            <span>我的出租</span>
            <span className="account-orders-tab-role-tag">号主视角</span>
          </button>
        </div>
        <Link className="account-orders-tab-more" href={moreHref} scroll={false}>
          <span>{moreText}</span>
          <ChevronRight size={14} aria-hidden="true" />
        </Link>
      </div>

      <div className="account-overview-orders-panels">
        <div
          id="panel-renter-orders"
          role="tabpanel"
          aria-labelledby="tab-renter-orders"
          className={`account-orders-panel-wrap ${rental ? "is-active" : "is-hidden"}`}
        >
          <OrderSummaryCard
            party="renter"
            scope={scope}
            refreshVersion={renterRefreshVersion}
            onStatusChange={onRenterStatusChange}
          />
        </div>
        <div
          id="panel-owner-orders"
          role="tabpanel"
          aria-labelledby="tab-owner-orders"
          className={`account-orders-panel-wrap ${!rental ? "is-active" : "is-hidden"}`}
        >
          <OrderSummaryCard
            party="owner"
            scope={scope}
            refreshVersion={ownerRefreshVersion}
            onStatusChange={onOwnerStatusChange}
          />
        </div>
      </div>
    </section>
  );
}
