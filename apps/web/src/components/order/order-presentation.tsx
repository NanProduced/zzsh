import { AlertCircle, LockKeyhole, RefreshCw } from "lucide-react";
import { type Order, OrderRequestError, type OrderParty, type OrderStatus, type OrderStatusFilter } from "@/lib/order-client";

export const STATUS_LABELS: Record<OrderStatus, string> = {
  PENDING_PAYMENT: "待支付",
  PAID: "已支付",
  COMPLETED: "已完成",
  CANCELLED: "已取消",
};

const VALID_STATUS = new Set<OrderStatus>(Object.keys(STATUS_LABELS) as OrderStatus[]);

export function isOrderStatus(value: string | undefined): value is OrderStatus {
  return Boolean(value && VALID_STATUS.has(value as OrderStatus));
}

export function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

export function errorFrom(error: unknown): OrderRequestError {
  return error instanceof OrderRequestError ? error : new OrderRequestError(0, null);
}

export function isPrivateBoundary(error: OrderRequestError): boolean {
  return error.status === 401 || error.status === 403 || error.status === 404 || error.code === "UNAUTHENTICATED" || error.code === "FORBIDDEN";
}

export function isAuthenticationFailure(error: OrderRequestError): boolean {
  return error.status === 401 || error.code === "UNAUTHENTICATED";
}

function orderView(party: OrderParty): "rentals" | "leased" {
  return party === "renter" ? "rentals" : "leased";
}

export function orderUrl(party: OrderParty, status: OrderStatusFilter, accountId?: string, orderId?: string, source?: "NATIVE" | "LEGACY"): string {
  const query = new URLSearchParams({ view: orderView(party) });
  if (status) query.set("status", status);
  if (accountId) query.set("accountId", accountId);
  if (orderId) query.set("orderId", orderId);
  if (orderId && source === "LEGACY") query.set("source", "legacy");
  return `/account?${query.toString()}`;
}

export function loginHref(party: OrderParty, status: OrderStatusFilter, accountId?: string, orderId?: string): string {
  return `/login?next=${encodeURIComponent(orderUrl(party, status, accountId, orderId))}`;
}

export function statusLabel(order: Order): string {
  if (order.status === "PENDING_PAYMENT" && order.expiredAwaitingCancel) return "已到期 · 取消处理中";
  if (isOrderStatus(order.status)) {
    if (order.status === "CANCELLED") {
      if (order.cancelReason === "TIMEOUT") return "已取消 · 到期未支付";
      if (order.cancelReason === "USER") return "已取消 · 租客取消";
    }
    return STATUS_LABELS[order.status];
  }
  return "待确认";
}

export function statusTone(order: Order): string {
  if (order.status === "CANCELLED") return "cancelled";
  if (order.status === "PENDING_PAYMENT" && order.expiredAwaitingCancel) return "expired";
  if (order.status === "PAID") return "paid";
  if (order.status === "COMPLETED") return "completed";
  if (order.status === "PENDING_PAYMENT") return "pending";
  return "unknown";
}

export function OrderStatusBadge({ order }: { order: Order }) {
  return <span className="order-status" data-state={statusTone(order)}>{statusLabel(order)}</span>;
}

/** Agreed rental term; never converted into an elapsed/remaining countdown. */
export function termText(value: string | null | undefined): string {
  const seconds = Number(value);
  if (!value || !Number.isSafeInteger(seconds) || seconds <= 0) return "待确认";
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}

export function OrderError({ error, first, onRetry, onLogin, onReauthorize, label }: { error: OrderRequestError; first: boolean; onRetry: () => void; onLogin: () => void; onReauthorize?: () => void; label?: string }) {
  if (isPrivateBoundary(error)) {
    const authExpired = error.status === 401 || error.code === "UNAUTHENTICATED";
    return <section className="order-error-block" role="status"><LockKeyhole size={24} aria-hidden="true" /><h3>{authExpired ? "登录状态已变化" : "订单不可用"}</h3><p>{authExpired ? "请重新确认登录身份后再读取订单；此前数据不会继续展示。" : "当前身份没有可用的订单列表或详情，未展示另一方私人资料。"}</p>{authExpired ? <button type="button" className="button secondary" onClick={onLogin}>重新登录</button> : onReauthorize ? <button type="button" className="button secondary" onClick={onReauthorize}>重新确认授权</button> : null}</section>;
  }
  return <section className="order-error-block" role="alert"><AlertCircle size={24} aria-hidden="true" /><h3>{label ?? (first ? "订单列表暂时没有读取成功" : "订单信息暂时没有读取成功")}</h3><p>当前没有更新已展示的订单信息，请稍后重试。</p><button type="button" className="button secondary" onClick={onRetry}><RefreshCw size={15} aria-hidden="true" />重试读取</button></section>;
}
