"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useUserSession } from "@/components/session/user-session-provider";
import { useIdentityReset } from "@/components/session/identity-reset";
import {
  formatOrderTime,
  orderApi,
  parseLocalCheckout,
  OrderRequestError,
  type LocalCheckout,
  type LocalCheckoutAvailability,
  type Order,
} from "@/lib/order-client";
import { clearIntent, inspectIntent } from "@/lib/order-intents";
import { moneyCents } from "@/lib/order-display";
import { BLOCKED_MESSAGE, performGuardedWrite } from "./order-trade-shared";

/**
 * ============================================================================
 * [MOCK / DEBUG ONLY - 上线前必须删除]
 * ----------------------------------------------------------------------------
 * 本组件仅用于当前隔离联调环境下未接汇聚支付真实商户时的本地模拟支付凭据获取。
 * 不会向银行或支付机构发起真实扣款。接入真实商户后，请直接删除此文件并将引用移除。
 * ============================================================================
 */
export function LocalSandboxPaymentAction({
  order,
  blocked,
  onChanged,
  onModeChange,
  onPendingChange,
  compact = false,
  children,
}: {
  order: Order;
  blocked: boolean;
  onChanged: () => void;
  onModeChange: (active: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  compact?: boolean;
  children: ReactNode;
}) {
  const session = useUserSession();
  const [discovery, setDiscovery] = useState<"NOT_INSTALLED" | "CHECKING" | "LOCAL" | "FAILED">("NOT_INSTALLED");
  const [view, setView] = useState<LocalCheckoutAvailability | null>(null);
  const [checkout, setCheckout] = useState<LocalCheckout | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const reset = useCallback(() => {
    setView(null);
    setCheckout(null);
    setBusy(false);
    setNotice(null);
  }, []);

  const { userId, isCurrent } = useIdentityReset(session, reset);
  const latest = useRef({ orderId: order.id, isCurrent, onChanged });
  latest.current = { orderId: order.id, isCurrent, onChanged };

  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const [visibleOrder, setVisibleOrder] = useState(order.id);
  if (visibleOrder !== order.id) {
    setVisibleOrder(order.id);
    reset();
  }

  const isLocal = typeof window !== "undefined" && window.location.protocol === "http:" && window.location.hostname === "127.0.0.1" && !!window.location.port;
  const pending = userId && isLocal ? inspectIntent(userId, "order.local-checkout", order.id) : { state: "NONE" as const, intent: null };
  const active = isLocal && discovery !== "NOT_INSTALLED";

  useEffect(() => {
    onModeChange(active);
    onPendingChange(active && (busy || pending.state !== "NONE"));
  }, [active, busy, pending.state, onModeChange, onPendingChange]);

  useEffect(() => () => {
    onModeChange(false);
    onPendingChange(false);
  }, [onModeChange, onPendingChange]);

  useEffect(() => {
    if (!isLocal || !userId) {
      setDiscovery("NOT_INSTALLED");
      return;
    }
    const controller = new AbortController();
    const acting = userId;
    const expected = order.id;
    setDiscovery("CHECKING");
    setView(null);
    setCheckout(null);

    void orderApi.localCheckoutAvailability(acting, expected, controller.signal).then((next) => {
      if (!controller.signal.aborted && latest.current.isCurrent(acting) && latest.current.orderId === expected) {
        setView(next);
        setDiscovery("LOCAL");
      }
    }).catch((error) => {
      if (!controller.signal.aborted && latest.current.isCurrent(acting) && latest.current.orderId === expected) {
        setDiscovery(error instanceof OrderRequestError && error.status === 404 ? "NOT_INSTALLED" : "FAILED");
      }
    });

    return () => controller.abort();
  }, [isLocal, userId, order.id]);

  const expected = (key: string) => {
    const amount = order.amounts?.totalDue;
    if (!order.displayNo || !amount || amount.currency !== "CNY" || amount.unit !== "yuan" || amount.scale !== 2 || !/^(0|[1-9]\d{0,21})\.\d{2}$/.test(amount.amount)) {
      throw new OrderRequestError(502, null);
    }
    return {
      orderId: order.id,
      displayNo: order.displayNo,
      amountCents: BigInt(amount.amount.replace(".", "")).toString(),
      key,
      origin: window.location.origin,
    };
  };

  const issue = async () => {
    if (!userId || busy || blocked || !view?.checkoutEnabled || pending.state !== "NONE") return;
    const acting = userId;
    const orderId = order.id;
    setBusy(true);
    setNotice(null);
    setCheckout(null);

    const result = await performGuardedWrite(acting, "order.local-checkout", orderId, {}, undefined, async (key, body, _context, subject) => {
      if (Object.keys(body).length) throw new OrderRequestError(409, null);
      const binding = expected(key);
      return parseLocalCheckout(await orderApi.issueLocalCheckout(subject, orderId, key), binding);
    }, isCurrent);

    if (!mounted.current || !isCurrent(acting) || latest.current.orderId !== orderId) return;
    setBusy(false);

    if (result.status === "ok") {
      setCheckout(result.value);
    } else {
      setNotice(
        result.status === "blocked"
          ? BLOCKED_MESSAGE
          : result.status === "definitive"
            ? "本次未取得本地凭据；请刷新原订单，核对当前可操作状态。"
            : "本地凭据申请结果尚未确认；请查询原申请，不要重新提交。"
      );
      if (result.status === "unauthorized") void session.confirm();
    }
  };

  const recover = async () => {
    if (!userId || busy || blocked || pending.state !== "VALID" || !pending.intent) return;
    const acting = userId;
    const orderId = order.id;
    const original = pending.intent;
    setBusy(true);
    setNotice(null);

    try {
      if (Object.keys(original.body).length) throw new OrderRequestError(409, null);
      const binding = expected(original.key);
      const result = await orderApi.localCheckoutReceipt(acting, orderId, original.key);
      if (!mounted.current || !isCurrent(acting) || latest.current.orderId !== orderId) return;
      if (result.scope !== "LOCAL_CONTROLLED" || result.mayReapply !== false || result.knowledge !== "KNOWN") {
        throw new OrderRequestError(503, null);
      }
      const safe = parseLocalCheckout(result.receipt, binding);
      clearIntent(acting, "order.local-checkout", orderId);
      setCheckout(safe);
    } catch {
      if (mounted.current && isCurrent(acting) && latest.current.orderId === orderId) {
        setNotice("原申请尚未取得确定回执，原标识已保留；请稍后再查询，不会重新发起。");
      }
    } finally {
      if (mounted.current && isCurrent(acting) && latest.current.orderId === orderId) setBusy(false);
    }
  };

  if (!active) return <>{children}</>;

  return (
    <div className="order-local-checkout" aria-label="本地模拟付款">
      {!compact ? <p className="order-inline-notice">本地模拟付款仅用于当前隔离联调环境，不会向银行或支付机构发起真实支付。</p> : null}
      {discovery === "CHECKING" ? <p role="status">正在确认本单本地模拟入口…</p> : discovery === "FAILED" ? <p role="alert">本地模拟入口暂无法确认；请刷新原订单，不会自动改用其他支付方式。</p> : !view?.checkoutEnabled ? <p role="status">本单当前不可发起本地模拟，请刷新原订单查看最新结果。</p> : null}
      {pending.state === "UNREADABLE" ? <p role="alert">原本地凭据申请无法读取，已停止提交，请保留本页并联系平台核对。</p> : notice ? <p role="status">{notice}</p> : null}
      {checkout ? (
        <>
          <p>原订单 {checkout.displayNo} · 本次模拟 {moneyCents(checkout.amount.cents)} · 凭据有效至 {formatOrderTime(checkout.expiresAt)}</p>
          <a className="button" href={checkout.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">打开本地模拟确认页</a>
        </>
      ) : null}
      <div className="order-trade-actions">
        {view?.checkoutEnabled && pending.state === "NONE" ? (
          <button type="button" className="button" disabled={busy || blocked} onClick={() => void issue()}>
            {busy ? "正在申请本地凭据…" : checkout ? "重新获取本地凭据" : "获取本地模拟付款凭据"}
          </button>
        ) : null}
        {pending.state === "VALID" ? (
          <button type="button" className="button secondary" disabled={busy || blocked} onClick={() => void recover()}>
            查询原本地凭据申请
          </button>
        ) : null}
        <button type="button" className="button secondary" disabled={busy || !userId} onClick={onChanged}>
          返回后刷新原订单
        </button>
      </div>
      {!compact ? <p className="order-trade-note">取得或打开凭据不代表付款已接纳；请在确认页核对原单，并返回刷新订单。后续客服与开租仍按订单流程处理。</p> : null}
    </div>
  );
}
