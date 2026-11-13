"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useUserSession } from "@/components/session/user-session-provider";
import { useIdentityReset } from "@/components/session/identity-reset";
import {
  orderApi,
  OrderRequestError,
  type DemoCheckoutAvailability,
  type Order,
} from "@/lib/order-client";
import { clearIntent, inspectIntent } from "@/lib/order-intents";
import { paymentEntryOpen } from "@/lib/order-display";
import { AUTH_MESSAGE, BLOCKED_MESSAGE, panelError, performGuardedWrite } from "./order-trade-shared";

/**
 * ============================================================================
 * [MOCK / DEBUG ONLY - 上线前必须删除]
 * ----------------------------------------------------------------------------
 * 本组件仅用于演示联调环境（ECS_TEST_SIMULATED / LOCAL_DEMO_SIMULATED）下未接真实
 * 汇聚支付商户时模拟快捷付款与开户联调。接入真实聚合支付商户后，请直接删除此文件。
 * ============================================================================
 */
export function DemoCheckoutAction({
  order,
  blocked,
  onChanged,
  onAccepted,
  onModeChange,
  onPendingChange,
  children,
  embedded = false,
  expectedScope,
}: {
  order: Order;
  blocked: boolean;
  onChanged: () => void;
  onModeChange: (active: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  children: ReactNode;
  embedded?: boolean;
  expectedScope?: "ECS_TEST_SIMULATED" | "LOCAL_DEMO_SIMULATED";
  onAccepted?: () => void;
}) {
  const session = useUserSession();
  const [discovery, setDiscovery] = useState<"CHECKING" | "AVAILABLE" | "NOT_INSTALLED" | "FAILED">("CHECKING");
  const [view, setView] = useState<DemoCheckoutAvailability | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [retry, setRetry] = useState(0);
  const [completed, setCompleted] = useState(false);

  const reset = useCallback(() => {
    setDiscovery("CHECKING");
    setView(null);
    setNotice(null);
    setBusy(false);
    setCompleted(false);
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

  const pending = userId ? inspectIntent(userId, "order.demo-checkout", order.id) : { state: "NONE" as const, intent: null };
  const localPending = userId ? inspectIntent(userId, "order.local-checkout", order.id) : { state: "NONE" as const, intent: null };
  const active = Boolean(userId && localPending.state !== "VALID" && (discovery !== "NOT_INSTALLED" || pending.state !== "NONE"));

  useEffect(() => {
    onModeChange(active);
    onPendingChange(active && (busy || pending.state !== "NONE"));
  }, [active, busy, pending.state, onModeChange, onPendingChange]);

  useEffect(() => () => {
    onModeChange(false);
    onPendingChange(false);
  }, [onModeChange, onPendingChange]);

  useEffect(() => {
    if (!userId) {
      setDiscovery("NOT_INSTALLED");
      return;
    }
    const controller = new AbortController();
    const acting = userId;
    const expected = order.id;
    setDiscovery("CHECKING");
    setView(null);

    void orderApi.demoCheckoutAvailability(acting, expected, controller.signal).then((next) => {
      if (!controller.signal.aborted && mounted.current && latest.current.isCurrent(acting) && latest.current.orderId === expected) {
        if (expectedScope && next.scope !== expectedScope) {
          setDiscovery("FAILED");
          return;
        }
        setView(next);
        setDiscovery("AVAILABLE");
      }
    }).catch((error) => {
      if (!controller.signal.aborted && mounted.current && latest.current.isCurrent(acting) && latest.current.orderId === expected) {
        setDiscovery(error instanceof OrderRequestError && error.status === 404 ? "NOT_INSTALLED" : "FAILED");
      }
    });

    return () => controller.abort();
  }, [userId, order.id, retry, expectedScope, embedded, pending.state]);

  const submit = async () => {
    if (!userId || busy || blocked || !view?.checkoutEnabled || pending.state !== "NONE" || !paymentEntryOpen(order)) return;
    const acting = userId;
    const expected = order.id;
    setBusy(true);
    setNotice(null);
    const scope = view.scope;

    const outcome = await performGuardedWrite(acting, "order.demo-checkout", expected, {}, { scope }, async (key, body, context, subject) => {
      if (Object.keys(body).length || context?.scope !== scope) throw new OrderRequestError(409, null);
      const result = await orderApi.confirmDemoCheckout(subject, expected, key);
      if (result.scope !== scope) throw new OrderRequestError(502, null);
      return result;
    }, isCurrent);

    if (!mounted.current || !isCurrent(acting) || latest.current.orderId !== expected) return;
    setBusy(false);

    if (outcome.status === "ok") {
      setCompleted(true);
      setNotice("模拟付款已完成，不会真实扣款。");
      onAccepted?.();
      latest.current.onChanged();
    } else if (outcome.status === "blocked") {
      setNotice(BLOCKED_MESSAGE);
    } else if (outcome.status === "unauthorized") {
      setNotice(AUTH_MESSAGE);
      void session.confirm();
    } else if (outcome.status === "unknown" || outcome.status === "recovery-unresolved") {
      setNotice("模拟付款结果尚未确认；请查询原请求，不要重复提交。");
    } else {
      setNotice(panelError(outcome.error).message);
      latest.current.onChanged();
    }
  };

  const recover = async () => {
    if (!userId || busy || blocked || pending.state !== "VALID" || !pending.intent) return;
    const acting = userId;
    const expected = order.id;
    const original = pending.intent;
    setBusy(true);
    setNotice(null);

    try {
      if (Object.keys(original.body).length || !["ECS_TEST_SIMULATED", "LOCAL_DEMO_SIMULATED"].includes(String(original.context?.scope))) {
        throw new OrderRequestError(409, null);
      }
      const result = await orderApi.demoCheckoutReceipt(acting, expected, original.key);
      if (!mounted.current || !isCurrent(acting) || latest.current.orderId !== expected) return;
      if (result.scope !== original.context?.scope) throw new OrderRequestError(502, null);
      if (result.knowledge !== "KNOWN" || !result.receipt) {
        setNotice("原模拟付款结果尚未确认，请稍后再次查询或联系客服。");
        return;
      }
      clearIntent(acting, "order.demo-checkout", expected);
      setCompleted(true);
      setNotice("模拟付款已完成，不会真实扣款。");
      onAccepted?.();
      latest.current.onChanged();
    } catch {
      if (mounted.current && isCurrent(acting) && latest.current.orderId === expected) {
        setNotice("原模拟付款结果暂时无法读取，请稍后再查询或联系客服。");
      }
    } finally {
      if (mounted.current && isCurrent(acting) && latest.current.orderId === expected) setBusy(false);
    }
  };

  if (!active) return <>{children}</>;
  if (discovery === "CHECKING" && pending.state !== "VALID") return <p className="order-muted" role="status">正在读取付款方式…</p>;
  if (discovery === "FAILED" && pending.state !== "VALID") {
    return (
      <div className="order-inline-notice" role="alert">
        付款方式暂时无法确认，请重试或联系平台。{" "}
        <button type="button" className="button secondary button--sm" onClick={() => setRetry(value => value + 1)}>重试</button>
      </div>
    );
  }

  return (
    <div className="order-local-checkout" aria-label="测试付款" aria-busy={busy || discovery === "CHECKING"}>
      {!embedded ? (
        <>
          <strong>测试付款</strong>
          <p className="order-inline-notice">这是模拟付款，不会向支付机构或银行发起扣款。</p>
        </>
      ) : null}
      {discovery === "CHECKING" ? <p role="status">正在确认本单是否可以模拟付款…</p> : null}
      {discovery === "FAILED" || discovery === "NOT_INSTALLED" ? <p role="alert">模拟付款暂时无法确认，请重试或联系平台。</p> : null}
      {discovery === "AVAILABLE" && !view?.checkoutEnabled && pending.state === "NONE" && !completed ? <p role="status">本单当前不能模拟付款，请刷新订单查看最新状态。</p> : null}
      {!embedded && discovery === "AVAILABLE" && view?.checkoutEnabled && pending.state === "NONE" ? <p role="status">请刷新订单，通过支付入口打开收银台。</p> : null}
      {pending.state === "UNREADABLE" ? <p role="alert">原请求记录无法读取，请保留本页并联系客服核对。</p> : notice ? <p role="status">{notice}</p> : null}
      <div className="order-trade-actions">
        {embedded && view?.checkoutEnabled && pending.state === "NONE" && !completed && paymentEntryOpen(order) ? (
          <button type="button" className="button" disabled={busy || blocked} onClick={() => void submit()}>{busy ? "处理中…" : "模拟付款"}</button>
        ) : null}
        {pending.state === "VALID" ? (
          <button type="button" className="button secondary" disabled={busy || blocked} onClick={() => void recover()}>查询原付款结果</button>
        ) : null}
        {discovery === "FAILED" ? (
          <button type="button" className="button secondary" disabled={busy} onClick={() => setRetry(value => value + 1)}>重试</button>
        ) : null}
      </div>
    </div>
  );
}
