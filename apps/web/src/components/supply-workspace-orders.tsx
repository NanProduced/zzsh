"use client";

import { OrderWorkspace } from "./order/order-workspace";

export function AccountOrderPanel({ active, orderId, status, accountId, source, pay, orderNo, createdFrom, createdTo, stage }: { active: "rentals" | "leased"; orderId?: string; status?: string; accountId?: string; source?: string; pay?: string; orderNo?: string; createdFrom?: string; createdTo?: string; stage?: string }) {
  return <OrderWorkspace party={active === "rentals" ? "renter" : "owner"} orderId={orderId} status={status} accountId={accountId} source={source} pay={pay} filters={{orderNo,createdFrom,createdTo,stage}} />;
}
