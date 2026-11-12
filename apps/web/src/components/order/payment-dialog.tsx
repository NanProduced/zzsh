"use client";

import * as Dialog from "@radix-ui/react-dialog";
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
  if (!open) {
    return <Dialog.Root open={false} onOpenChange={onOpenChange} />;
  }
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay payment-dialog-overlay" />
        <Dialog.Content className="payment-dialog">
          <header className="payment-dialog-head">
            <div>
              <Dialog.Title className="payment-dialog-title">支付订单</Dialog.Title>
              <Dialog.Description className="payment-dialog-subtitle">
                {order.displayNo ? `订单 ${order.displayNo}` : "订单号待确认"}
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="payment-dialog-close" aria-label="关闭支付弹窗"><X size={18} aria-hidden="true" /></button>
            </Dialog.Close>
          </header>

          <div className="payment-dialog-body">
            <div className="payment-dialog-hero">
              <div className="payment-dialog-hero-head">
                <p className="payment-dialog-hero-label">本次应付</p>
                <PaymentCountdown until={order.holdUntil} expired={order.expiredAwaitingCancel} className="payment-dialog-countdown" />
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
              onAccepted={onAccepted}
              onCancelled={() => { onOpenChange(false); onCancelled?.(); }}
              embedded
            />
            <p className="payment-dialog-footnote">关闭后仍可从个人中心“待支付”或订单列表继续付款。</p>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
