"use client";

import * as Dialog from "@radix-ui/react-dialog";
import { X } from "lucide-react";
import type { Order, OrderParty } from "@/lib/order-client";
import { SettlementAction, type SettlementFocus } from "./order-trade-actions";
import "./order.css";
import "./payment.css";

const COPY: Record<SettlementFocus, { title: string; description: string }> = {
  opening: { title: "确认开租", description: "核对本期期初库存后确认开租。" },
  settlement: { title: "发起结束租用", description: "填写本次消耗，先预览金额，再提交结算。" },
  decision: { title: "确认结算", description: "核对本版金额与责任后确认或拒绝。" },
};

/** Focused order action. The page keeps the summary; this dialog owns the form. */
export function OrderActionDialog({ order, party, focus, open, onOpenChange, onChanged }: {
  order: Order;
  party: OrderParty;
  focus: SettlementFocus;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => void;
}) {
  const copy = COPY[focus];
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      {open ? <Dialog.Portal>
        <Dialog.Overlay className="modal-overlay" />
        <Dialog.Content className="order-action-dialog" aria-describedby={undefined}>
          <header className="order-action-dialog-head">
            <div>
              <Dialog.Title className="order-action-dialog-title">{copy.title}</Dialog.Title>
              <Dialog.Description className="order-action-dialog-description">{copy.description}</Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button type="button" className="order-action-dialog-close" aria-label="关闭订单操作"><X size={18} aria-hidden="true" /></button>
            </Dialog.Close>
          </header>
          <div className="order-action-dialog-body">
            <SettlementAction order={order} party={party} modal focus={focus} onChanged={onChanged} />
          </div>
        </Dialog.Content>
      </Dialog.Portal> : null}
    </Dialog.Root>
  );
}
