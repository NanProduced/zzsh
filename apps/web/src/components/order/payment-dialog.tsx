"use client";

import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { X } from "lucide-react";
import { formatOrderMoney, type Order, type OrderParty } from "@/lib/order-client";
import { orderAccountTitle, type OrderPaymentFacts } from "@/lib/order-display";
import { orderTermLabel } from "@/components/order/order-presentation";
import { PaymentAction } from "./order-trade-actions";
import { PaymentCountdown } from "./payment-countdown";
import "./order.css";
import "./payment.css";

/**
 * A single-task payment surface over the existing payment state machine. It never creates an
 * order or a payment request; it only presents the order's current server-owned payment entry.
 */
export function PaymentDialog({ order, party, open, onOpenChange, onChanged, onPaymentFacts, onAccepted, onCancelled }: {
  order: Order;
  party: OrderParty;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
  onPaymentFacts?: (facts: OrderPaymentFacts | null) => void;
  onAccepted?: () => void;
  onCancelled?: () => void;
}) {
  // 外层订单快照可能仍是待支付，但渠道已回执 APPLIED。已接纳是确定事实，必须立刻撤掉
  // 倒计时与待付款引导；未知回执不在此列，仍由 PaymentAction 完整保留查询与恢复入口。
  // 按订单号记住已接纳，切换到另一笔订单时自然回到未完成态。
  const [acceptedOrderId, setAcceptedOrderId] = useState<string | null>(null);
  const paid = acceptedOrderId === order.id || order.status !== "PENDING_PAYMENT";
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Backdrop className="modal-overlay payment-dialog-overlay" />
        <Dialog.Popup className="payment-dialog">
          <header className="payment-dialog-head">
            <div>
              <Dialog.Title className="payment-dialog-title">{paid ? "支付已完成" : "支付订单"}</Dialog.Title>
              <Dialog.Description className="payment-dialog-subtitle">
                {order.displayNo ? `订单 ${order.displayNo}` : "订单号待确认"}
              </Dialog.Description>
            </div>
            <Dialog.Close className="payment-dialog-close" aria-label="关闭支付弹窗">
              <X size={18} aria-hidden="true" />
            </Dialog.Close>
          </header>

          <div className="payment-dialog-body">
            <div className="payment-dialog-hero">
              <div className="payment-dialog-hero-head">
                <p className="payment-dialog-hero-label">{paid ? "已支付金额" : "本次应付"}</p>
                {!paid ? <PaymentCountdown until={order.holdUntil} expired={order.expiredAwaitingCancel} className="payment-dialog-countdown" /> : null}
              </div>
              <strong className="payment-dialog-hero-amount">{formatOrderMoney(order.amounts?.totalDue)}</strong>
              <p className="payment-dialog-hero-sub">{orderAccountTitle(order)}</p>
            </div>

            <dl className="payment-dialog-summary">
              <div><dt>资源费用</dt><dd>{formatOrderMoney(order.amounts?.rental)}</dd></div>
              <div><dt>租客押金</dt><dd>{formatOrderMoney(order.amounts?.deposit)}</dd></div>
              <div><dt>约定租期</dt><dd>{orderTermLabel(order)}</dd></div>
            </dl>

            <PaymentAction
              order={order}
              party={party}
              onChanged={onChanged}
              onPaymentFacts={onPaymentFacts}
              onAccepted={() => { setAcceptedOrderId(order.id); onAccepted?.(); }}
              onCancelled={() => { onOpenChange(false); onCancelled?.(); }}
              paid={paid}
              embedded
            />
            {!paid ? <p className="payment-dialog-footnote">关闭后仍可从个人中心“待支付”或订单列表继续付款。</p> : null}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
