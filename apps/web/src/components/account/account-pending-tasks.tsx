"use client";

import Link from "next/link";
import { CheckCircle2, ChevronRight, FileText, House } from "lucide-react";
import type { Order } from "@/lib/order-client";
import { orderAccountTitle, orderAmountFacts } from "@/lib/order-display";
import { orderUrl } from "@/components/order/order-presentation";
import { PaymentCountdown } from "@/components/order/payment-countdown";
import { accountSectionHref } from "./account-nav-constants";

export type PendingTaskItem = {
  id: string;
  type: "renter" | "owner" | "supply";
  tagLabel: string;
  title: string;
  description: string;
  buttonText: string;
  href: string;
  meta?: { amount: string; holdUntil?: string | null; expired?: boolean };
};

export function AccountPendingTasks({
  scope: _scope,
  renterStatus = "ready",
  ownerStatus = "ready",
  renterOrders,
  ownerOrders,
  hasMore = false,
  onRetry,
}: {
  scope?: string;
  renterStatus?: "loading" | "ready" | "error";
  ownerStatus?: "loading" | "ready" | "error";
  renterOrders: Order[];
  ownerOrders: Order[];
  hasMore?: boolean;
  onRetry?: () => void;
}) {
  const items: PendingTaskItem[] = [];

  for (const order of renterStatus === "ready" ? renterOrders : []) {
    if (!order.readOnly && order.source?.origin !== "LEGACY" && order.status === "PENDING_PAYMENT" && !order.expiredAwaitingCancel) {
      items.push({
        id: `renter-${order.id}`,
        type: "renter",
        tagLabel: "租入",
        title: `订单待付款${order.displayNo ? ` · ${order.displayNo}` : ""}`,
        description: `完成付款后继续订单 · ${orderAccountTitle(order)}`,
        buttonText: "继续支付",
        href: `${accountSectionHref("rentals", { view: "rentals", orderId: order.id, status: order.status })}&pay=1`,
        meta: { amount: orderAmountFacts(order, "renter").main, holdUntil: order.holdUntil, expired: order.expiredAwaitingCancel },
      });
    }
  }

  for (const [party, orders, status] of [["renter", renterOrders, renterStatus], ["owner", ownerOrders, ownerStatus]] as const) {
    if (status !== "ready") continue;
    for (const order of orders) {
      if (order.readOnly || order.source?.origin === "LEGACY" || order.status !== "PAID" || order.stage?.viewerActionRequired !== true) continue;
      if (order.viewerParty && order.viewerParty !== party) continue;
      const opening = order.stage.code === "OPENING_PENDING";
      if (!opening && order.stage.code !== "DECISION_PENDING") continue;
      items.push({ id: `${party}-${order.id}-decision`, type: party, tagLabel: party === "renter" ? "租入" : "出租",
        title: `${opening ? "待你确认开租" : "待你确认结算"}${order.displayNo ? ` · ${order.displayNo}` : ""}`,
        description: opening ? "核对同一版期初库存后确认；付款与建群不等于已开租。" : "核对本版消耗与本人费用后决定，不以聊天回复代替确认。",
        buttonText: opening ? "核对开租" : "核对结算", href: orderUrl(party, "", undefined, order.id),
      });
    }
  }

  const isLoading = renterStatus === "loading" || ownerStatus === "loading";
  const hasError = renterStatus === "error" || ownerStatus === "error";
  const errorMessage = renterStatus === "error" && ownerStatus === "error"
    ? "待处理事项暂时无法读取。"
    : `${renterStatus === "error" ? "租入" : "出租"}订单暂时无法读取，待处理事项尚未完整确认。`;

  if (!isLoading && !hasError && items.length === 0 && !hasMore) return null;

  return (
    <section className={`account-pending-card${!isLoading && !hasError && items.length === 0 ? " is-empty" : ""}`} aria-labelledby="pending-tasks-heading">
      <div className="account-pending-header">
        <div className="account-pending-title-group">
          <h3 id="pending-tasks-heading">近期订单提醒</h3>
        </div>
        <div className="account-pending-header-links">
          <Link className="account-pending-more-link" href="/account?view=rentals" scroll={false}>
            <span>租入订单</span>
            <ChevronRight size={13} aria-hidden="true" />
          </Link>
          <span className="account-pending-divider">·</span>
          <Link className="account-pending-more-link" href="/account?view=leased" scroll={false}>
            <span>出租订单</span>
            <ChevronRight size={13} aria-hidden="true" />
          </Link>
        </div>
      </div>

      {isLoading ? (
        <div className="account-pending-empty" role="status">
          <p>正在读取待处理事项…</p>
        </div>
      ) : null}
      {hasError ? (
        <div className="account-pending-empty" role="alert">
          <p>{errorMessage}</p>
          {onRetry ? (
            <button type="button" className="button secondary button--xs" onClick={onRetry}>
              重试
            </button>
          ) : null}
        </div>
      ) : null}
      {items.length > 0 ? (
        <div className="account-pending-list">
          {items.map((item) => (
            <div key={item.id} className="account-pending-row" data-tone={item.meta ? "payment" : undefined}>
              <span className="account-pending-icon" aria-hidden="true">
                {item.type === "renter" ? <FileText size={18} /> : <House size={18} />}
              </span>
              <span className={`account-pending-tag tag-${item.type}`}>{item.tagLabel}</span>
              <div className="account-pending-info">
                <strong className="account-pending-item-title">{item.title}</strong>
                <span className="account-pending-item-desc">{item.description}</span>
                {item.meta ? (
                  <span className="account-pending-payment">
                    <span className="account-pending-payment-amount">待付 {item.meta.amount}</span>
                    <PaymentCountdown until={item.meta.holdUntil} expired={item.meta.expired} className="account-pending-countdown" />
                  </span>
                ) : null}
              </div>
              <Link
                className={`button ${item.type === "renter" ? "primary" : "secondary"} button--xs account-pending-btn`}
                href={item.href}
                scroll={false}
              >
                {item.buttonText}
              </Link>
            </div>
          ))}
        </div>
      ) : !isLoading && !hasError ? (
        <div className="account-pending-empty account-pending-clear">
          <CheckCircle2 size={18} aria-hidden="true" /><p>已读取的近期订单暂无待处理事项。</p>
        </div>
      ) : null}
      {hasMore ? (
        <p className="account-order-more-hint">仅汇总每类最近 3 笔订单，更多事项请查看订单列表。</p>
      ) : null}
    </section>
  );
}
