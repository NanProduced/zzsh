"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import { OrderAftersale } from "./order-aftersale";
import "./order.css";
import "./payment.css";

/** Secondary surface for after-sales records; the detail page keeps only the entry. */
export function OrderAftersaleDialog({ orderId, orderDisplayNo, open, onOpenChange }: {
  orderId: string;
  orderDisplayNo: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return <Dialog.Root open={open} onOpenChange={onOpenChange}>
    {open ? <Dialog.Portal>
      <Dialog.Overlay className="modal-overlay" />
      <Dialog.Content className="order-action-dialog order-aftersale-dialog" aria-describedby={undefined}>
        <header className="order-action-dialog-head">
          <div>
            <Dialog.Title className="order-action-dialog-title">售后记录</Dialog.Title>
            <Dialog.Description className="order-action-dialog-description">提交订单问题，或查看客服处理进度。</Dialog.Description>
          </div>
          <Dialog.Close asChild>
            <button type="button" className="order-action-dialog-close" aria-label="关闭售后记录"><X size={18} aria-hidden="true" /></button>
          </Dialog.Close>
        </header>
        <div className="order-action-dialog-body">
          <OrderAftersale orderId={orderId} orderDisplayNo={orderDisplayNo} />
        </div>
      </Dialog.Content>
    </Dialog.Portal> : null}
  </Dialog.Root>;
}
