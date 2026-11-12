"use client";

import { useEffect, useState } from "react";
import { formatOrderTime } from "@/lib/order-client";
import { formatPaymentCountdown } from "@/lib/order-display";

/**
 * The server's hold deadline is the only fact. Before hydration we show the absolute time,
 * after hydration we show a local countdown; neither the countdown nor a zero ever cancels an order.
 */
export function PaymentCountdown({ until, expired = false, className = "payment-countdown" }: {
  until?: string | null;
  expired?: boolean;
  className?: string;
}) {
  const [now, setNow] = useState<number | null>(null);

  useEffect(() => {
    if (!until) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [until]);

  if (expired) return <span className={className} data-state="expired" role="status">已到期，取消处理中</span>;
  if (!until) return <span className={className} data-state="unknown">支付保留时间待确认</span>;

  const remaining = now === null ? null : Date.parse(until) - now;
  if (remaining !== null && remaining <= 0) {
    return <span className={className} data-state="expired" role="status">已到期，取消处理中</span>;
  }
  const text = remaining === null ? null : formatPaymentCountdown(remaining);
  return (
    <span className={className} data-state="active" role="timer" aria-live="off">
      {text ? `支付保留 ${text}` : `支付保留至 ${formatOrderTime(until)}`}
    </span>
  );
}
