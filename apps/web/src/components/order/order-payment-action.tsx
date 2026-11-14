"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { QRCodeSVG } from "qrcode.react";
import { Dialog } from "@base-ui/react/dialog";
import { AlertCircle, CheckCircle2, Clock3, WalletCards } from "lucide-react";
import { ConfirmAlertDialog } from "@/components/ui/alert-dialog";
import { useUserSession } from "@/components/session/user-session-provider";
import { useIdentityReset } from "@/components/session/identity-reset";
import {
  formatOrderTime,
  orderApi,
  OrderRequestError,
  type ChannelPaymentMethod,
  type ChannelPaymentView,
  type Order,
  type OrderParty,
} from "@/lib/order-client";
import { inspectIntent, isIntentStale, loadIntent } from "@/lib/order-intents";
import {
  cancelEntryOpen,
  moneyText,
  paymentEntryOpen,
  paymentObservation,
  type OrderPaymentFacts,
} from "@/lib/order-display";
import type { PanelError, WriteOutcome } from "./order-trade-types";
import {
  AUTH_MESSAGE,
  BLOCKED_MESSAGE,
  STALE_MESSAGE,
  panelError,
  performGuardedWrite,
  triggerOpenPaidOrderGroup,
  UnknownNotice,
} from "./order-trade-shared";
import { LocalSandboxPaymentAction } from "./order-sandbox-action";
import { DemoCheckoutAction } from "./order-demo-action";

/** Only what the channel payment read actually returned; the progress card must not infer an outcome. */
export function channelPaymentFacts(view: ChannelPaymentView): OrderPaymentFacts {
  return {
    state: view.request?.state ?? null,
    displayState: view.projection?.displayState ?? null,
    blockedReason: view.projection?.actionBlockedReason ?? null,
    readFailed: false,
  };
}

export const PAYMENT_FACTS_UNREADABLE: OrderPaymentFacts = {
  state: null,
  displayState: null,
  blockedReason: null,
  readFailed: true,
};

/** Brand marks are used only to identify the payment method; no remote icon dependency. */
export function PaymentMethodIcon({ method }: { method: ChannelPaymentMethod }) {
  return method === "ALIPAY_NATIVE" ? (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#1677FF" d="M19.695 15.07c3.426 1.158 4.203 1.22 4.203 1.22V3.846c0-2.124-1.705-3.845-3.81-3.845H3.914C1.808.001.102 1.722.102 3.846v16.31c0 2.123 1.706 3.845 3.813 3.845h16.173c2.105 0 3.81-1.722 3.81-3.845v-.157s-6.19-2.602-9.315-4.119c-2.096 2.602-4.8 4.181-7.607 4.181-4.75 0-6.361-4.19-4.112-6.949.49-.602 1.324-1.175 2.617-1.497 2.025-.502 5.247.313 8.266 1.317a16.796 16.796 0 0 0 1.341-3.302H5.781v-.952h4.799V6.975H4.77v-.953h5.81V3.591s0-.409.411-.409h2.347v2.84h5.744v.951h-5.744v1.704h4.69a19.453 19.453 0 0 1-1.986 5.06c1.424.52 2.702 1.011 3.654 1.333m-13.81-2.032c-.596.06-1.71.325-2.321.869-1.83 1.608-.735 4.55 2.968 4.55 2.151 0 4.301-1.388 5.99-3.61-2.403-1.182-4.438-2.028-6.637-1.809" />
    </svg>
  ) : (
    <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
      <path fill="#07C160" d="M8.691 2.188C3.891 2.188 0 5.476 0 9.53c0 2.212 1.17 4.203 3.002 5.55a.59.59 0 0 1 .213.665l-.39 1.48c-.019.07-.048.141-.048.213 0 .163.13.295.29.295a.326.326 0 0 0 .167-.054l1.903-1.114a.864.864 0 0 1 .717-.098 10.16 10.16 0 0 0 2.837.403c.276 0 .543-.027.811-.05-.857-2.578.157-4.972 1.932-6.446 1.703-1.415 3.882-1.98 5.853-1.838-.576-3.583-4.196-6.348-8.596-6.348zM5.785 5.991c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178A1.17 1.17 0 0 1 4.623 7.17c0-.651.52-1.18 1.162-1.18zm5.813 0c.642 0 1.162.529 1.162 1.18a1.17 1.17 0 0 1-1.162 1.178 1.17 1.17 0 0 1-1.162-1.178c0-.651.52-1.18 1.162-1.18zm5.34 2.867c-1.797-.052-3.746.512-5.28 1.786-1.72 1.428-2.687 3.72-1.78 6.22.942 2.453 3.666 4.229 6.884 4.229.826 0 1.622-.12 2.361-.336a.722.722 0 0 1 .598.082l1.584.926a.272.272 0 0 0 .14.047c.134 0 .24-.111.24-.247 0-.06-.023-.12-.038-.177l-.327-1.233a.582.582 0 0 1-.023-.156.49.49 0 0 1 .201-.398C23.024 18.48 24 16.82 24 14.98c0-3.21-2.931-5.837-6.656-6.088V8.89c-.135-.01-.27-.027-.407-.03zm-2.53 3.274c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.97-.982zm4.844 0c.535 0 .969.44.969.982a.976.976 0 0 1-.969.983.976.976 0 0 1-.969-.983c0-.542.434-.982.969-.982z" />
    </svg>
  );
}

const channelStateLabels: Record<string, string> = {
  SUBMITTING: "正在提交支付请求",
  UNKNOWN: "支付结果正在确认",
  ACTION_READY: "等待付款",
  PROCESSING_UNCONFIRMED: "支付状态正在确认",
  CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE: "付款依据正在接纳",
  ACCEPTED: "付款依据未记录",
  REVIEW_REQUIRED: "支付需要人工核对",
  REJECTED_BY_CHANNEL: "渠道未受理本次请求",
};

function channelMoneyText(value: { cents: string; currency: string } | null | undefined): string {
  if (!value || value.currency !== "CNY" || typeof value.cents !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(value.cents)) return "未记录";
  const cents = BigInt(value.cents);
  return moneyText({ amount: `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`, currency: "CNY" });
}

function channelPaymentUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password && !url.hash ? value : null;
  } catch {
    return null;
  }
}

function channelApplied(view: ChannelPaymentView | null): boolean {
  const payment = view?.payment;
  const acceptedSource =
    view?.dataOrigin === "JOINPAY_PROVIDER" ||
    (view?.dataOrigin === "LOCAL_CONTROLLED" &&
      view.capability?.evidenceProfile === "CONTROLLED_TEST" &&
      view.capability.productionPaymentCapability === false);
  return (
    Boolean(acceptedSource) &&
    payment?.disposition === "APPLIED" &&
    typeof payment.confirmationId === "string" &&
    payment.confirmationId.length > 0 &&
    payment.amount?.currency === "CNY" &&
    typeof payment.amount.cents === "string" &&
    /^[1-9][0-9]{0,15}$/.test(payment.amount.cents)
  );
}

const ignoreDemoMode = () => {};

/** 新渠道独立保留原键；普通刷新只读本地状态，不把旧受控请求当作渠道付款。 */
export function ChannelPaymentAction({
  order,
  blocked,
  onChanged,
  onModeChange,
  onPendingChange,
  onPaymentFacts,
  onAccepted,
  compact = false,
  children,
}: {
  order: Order;
  blocked: boolean;
  onChanged: () => void;
  onModeChange: (active: boolean) => void;
  onPendingChange: (pending: boolean) => void;
  onPaymentFacts?: (facts: OrderPaymentFacts | null) => void;
  onAccepted?: () => void;
  compact?: boolean;
  children: ReactNode;
}) {
  const reportPayment = useRef(onPaymentFacts);
  useEffect(() => {
    reportPayment.current = onPaymentFacts;
  }, [onPaymentFacts]);

  const session = useUserSession();
  const paymentMethodGroup = useId();
  const [snapshot, setSnapshot] = useState<{ userId: string; orderId: string; view: ChannelPaymentView } | null>(null);
  const [readError, setReadError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [reading, setReading] = useState(true);
  const [cashierOpen, setCashierOpen] = useState(false);
  const [cashierPending, setCashierPending] = useState(false);
  const [method, setMethod] = useState<ChannelPaymentMethod>("ALIPAY_NATIVE");

  const latest = useRef({ orderId: order.id, onChanged, onAccepted });
  latest.current = { orderId: order.id, onChanged, onAccepted };

  const reset = useCallback(() => {
    setSnapshot(null);
    setReadError(null);
    setNotice(null);
    setBusy(false);
    setReading(true);
    setMethod("ALIPAY_NATIVE");
    setCashierOpen(false);
    setCashierPending(false);
  }, []);

  const { userId, isCurrent } = useIdentityReset(session, reset);
  const identity = useRef(isCurrent);
  identity.current = isCurrent;

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

  const view = snapshot?.userId === userId && snapshot.orderId === order.id ? snapshot.view : null;
  const pending = userId ? inspectIntent(userId, "order.channel-payment", order.id) : { state: "NONE" as const, intent: null };
  const previousDemoPending = userId ? inspectIntent(userId, "order.demo-checkout", order.id) : { state: "NONE" as const, intent: null };
  const originalRequestPending = pending.state !== "NONE" || previousDemoPending.state !== "NONE";
  const originalRequestPendingRef = useRef(originalRequestPending);
  originalRequestPendingRef.current = originalRequestPending;
  const conflictingIntents = pending.state !== "NONE" && previousDemoPending.state !== "NONE";
  const testMode = view?.dataOrigin === "LOCAL_CONTROLLED" && view.capability?.productionPaymentCapability === false;
  const active =
    conflictingIntents ||
    pending.state === "VALID" ||
    (!!view &&
      ((testMode && (previousDemoPending.state === "NONE" || cashierPending) && view.capability.channelEnabled === true) ||
        (view.dataOrigin !== "LOCAL_CONTROLLED" &&
          ((view.capability?.channelEnabled === true && view.capability.productionPaymentCapability === true) ||
            ["JOINPAY_CANDIDATE", "JOINPAY_PROVIDER"].includes(view.dataOrigin)))));

  const unsettled =
    busy ||
    cashierPending ||
    conflictingIntents ||
    pending.state === "VALID" ||
    (active &&
      (pending.state === "UNREADABLE" ||
        view?.payment != null ||
        (view?.request != null && !["ACTION_READY", "REJECTED_BY_CHANNEL"].includes(view.request.state))));

  useEffect(() => {
    onModeChange(active);
    onPendingChange(unsettled);
  }, [active, unsettled, onModeChange, onPendingChange]);

  useEffect(() => {
    if (originalRequestPending) {
      reportPayment.current?.({ ...(view && !readError ? channelPaymentFacts(view) : PAYMENT_FACTS_UNREADABLE), originalRequestPending: true });
    } else if (view && !reading && !readError) {
      reportPayment.current?.(channelPaymentFacts(view));
    }
  }, [originalRequestPending, view, reading, readError]);

  useEffect(() => () => {
    onModeChange(false);
    onPendingChange(false);
  }, [onModeChange, onPendingChange]);

  const refresh = useCallback(async (acting: string, signal?: AbortSignal, notify = false) => {
    const expected = order.id;
    setReading(true);
    reportPayment.current?.(null);
    try {
      const next = await orderApi.channelPaymentStatus(acting, expected, signal);
      if (!mounted.current || !identity.current(acting) || latest.current.orderId !== expected || signal?.aborted) return;
      if (next?.contractVersion !== "order-payment-request.v1" || next.order?.id !== expected || !Array.isArray(next.capability?.methods)) throw new OrderRequestError(502, null);
      setSnapshot({ userId: acting, orderId: expected, view: next });
      setReadError(null);
      reportPayment.current?.({ ...channelPaymentFacts(next), originalRequestPending: originalRequestPendingRef.current });
      // APPLIED + 服务端订单已 PAID 是确定回执，不是对未知结果的猜测：向上告知已接纳，
      // 让外层立即撤掉倒计时、待付款说明和取消入口；未知结果不走这条路径。
      if (channelApplied(next) && next.order.status === "PAID") latest.current.onAccepted?.();
      if (notify && channelApplied(next)) latest.current.onChanged();
    } catch (error) {
      if (mounted.current && identity.current(acting) && latest.current.orderId === expected && !signal?.aborted) {
        setReadError(panelError(error).message);
        reportPayment.current?.({ ...PAYMENT_FACTS_UNREADABLE, originalRequestPending: originalRequestPendingRef.current });
      }
    } finally {
      if (mounted.current && identity.current(acting) && latest.current.orderId === expected && !signal?.aborted) setReading(false);
    }
  }, [order.id]);

  useEffect(() => {
    if (!userId) {
      setReading(false);
      reportPayment.current?.(PAYMENT_FACTS_UNREADABLE);
      return;
    }
    const controller = new AbortController();
    void refresh(userId, controller.signal);
    return () => controller.abort();
  }, [userId, refresh]);

  const submit = async (recover = false) => {
    if (!userId || busy || blocked) return;
    const acting = userId;
    const expected = order.id;
    const original = inspectIntent(acting, "order.channel-payment", expected);
    if (recover) await refresh(acting);
    if (!mounted.current || !isCurrent(acting) || latest.current.orderId !== expected) return;
    if (original.state === "UNREADABLE") {
      setNotice("原支付请求记录无法读取，已停止提交；请保留本页并联系平台核对。");
      return;
    }
    if (original.intent && isIntentStale(original.intent)) {
      setNotice("原支付请求已超出自动恢复时限；原请求已保留，请刷新状态或联系平台核对。");
      return;
    }
    const selected = original.intent?.body?.method ?? method;
    if (selected !== "ALIPAY_NATIVE" && selected !== "WEIXIN_NATIVE") {
      setNotice("原支付方式未能确认，不能更换方式重新提交。");
      return;
    }
    setBusy(true);
    setNotice(null);

    const outcome = await performGuardedWrite(acting, "order.channel-payment", expected, { method: selected }, undefined, async (key, body, _context, subject) => {
      if (body.method !== "ALIPAY_NATIVE" && body.method !== "WEIXIN_NATIVE") throw new OrderRequestError(400, null);
      const receipt = await orderApi.requestChannelPayment(subject, expected, body.method, key);
      const amount = receipt?.request?.amount;
      if (
        receipt?.contractVersion !== "order-payment-request.v1" ||
        receipt.dataOrigin !== (testMode ? "LOCAL_CONTROLLED" : "JOINPAY_CANDIDATE") ||
        typeof receipt.replay !== "boolean" ||
        receipt.request?.orderId !== expected ||
        receipt.request.method !== body.method ||
        typeof receipt.request.id !== "string" ||
        !receipt.request.id ||
        typeof receipt.request.createdAt !== "string" ||
        !Number.isFinite(Date.parse(receipt.request.createdAt)) ||
        typeof receipt.request.updatedAt !== "string" ||
        !Number.isFinite(Date.parse(receipt.request.updatedAt)) ||
        amount?.currency !== "CNY" ||
        typeof amount.cents !== "string" ||
        !/^[1-9][0-9]{0,15}$/.test(amount.cents) ||
        receipt.payment !== null ||
        receipt.paymentAction !== null
      ) {
        throw new OrderRequestError(502, null);
      }
      return receipt;
    }, isCurrent);

    if (!mounted.current || !isCurrent(acting) || latest.current.orderId !== expected) return;
    setBusy(false);

    if (outcome.status === "ok") {
      await refresh(acting, undefined, true);
      return;
    }
    if (outcome.status === "unknown") setNotice("支付请求回执尚未确认，原请求和支付方式已保留；请恢复原请求，不要重复付款。");
    else if (outcome.status === "blocked") setNotice(BLOCKED_MESSAGE);
    else if (outcome.status === "unauthorized") {
      setNotice(AUTH_MESSAGE);
      void session.confirm();
    } else {
      setNotice(outcome.status === "recovery-unresolved" ? "原请求仍未记录，恢复记录已保留；请刷新状态或联系平台核对。" : panelError(outcome.error).message);
    }
  };

  const queryChannel = async () => {
    const queryingRequestId = view?.request?.id;
    if (!userId || busy || blocked || !queryingRequestId) return;
    const acting = userId;
    setBusy(true);
    setNotice(null);
    try {
      const receipt = await orderApi.queryChannelPayment(acting, order.id);
      if (!mounted.current || !isCurrent(acting) || latest.current.orderId !== order.id) return;
      if (
        receipt?.contractVersion !== "order-payment-request.v1" ||
        receipt.request?.id !== queryingRequestId ||
        receipt.request?.orderId !== order.id ||
        typeof receipt.query?.kind !== "string"
      ) {
        throw new OrderRequestError(502, null);
      }
      if (receipt.query.kind === "NOT_DISPATCHED") setNotice("原支付请求尚未向渠道派发；请恢复原请求，系统不会自动重新下单。");
      else if (receipt.query.kind === "THROTTLED") setNotice("最近已查询过渠道，请稍后再试；原请求仍按原号保留。");
      else if (receipt.query.kind === "TERMINAL") setNotice("该支付请求已到终态；请以本地付款记录为准。");
      else if (receipt.query.kind === "PENDING_ACCEPTANCE") setNotice("渠道已返回付款依据，正在走既有接纳/恢复；请刷新支付状态。");
      else if (receipt.query.kind === "UNKNOWN_COMMIT") setNotice("查询结果提交尚未确认；原请求保留，请刷新支付状态后再试。");
      else setNotice("已按原商户号查询渠道结果；付款状态以最新本地记录为准。");
      await refresh(acting, undefined, receipt.query.kind === "OBSERVED");
    } catch (error) {
      if (mounted.current && isCurrent(acting) && latest.current.orderId === order.id) {
        const typed = error instanceof OrderRequestError ? error : new OrderRequestError(0, null);
        setNotice(typed.status === 0 ? "渠道查询回执尚未确认；原请求保留，请稍后重试。" : panelError(typed).message);
        if (typed.status === 401 || typed.code === "UNAUTHENTICATED") void session.confirm();
      }
    } finally {
      if (mounted.current && isCurrent(acting) && latest.current.orderId === order.id) setBusy(false);
    }
  };

  const applied = channelApplied(view);
  const cashier =
    testMode &&
    view?.capability.channelEnabled === true &&
    view.payment === null &&
    view.request?.state === "ACTION_READY" &&
    view.request.amount?.currency === "CNY" &&
    /^[1-9][0-9]{0,15}$/.test(view.request.amount.cents) &&
    view.paymentAction?.kind === "TEST_CASHIER" &&
    ["ECS_TEST_SIMULATED", "LOCAL_DEMO_SIMULATED"].includes(view.paymentAction.scope)
      ? view.paymentAction
      : null;
  const cashierRequestId = cashier ? view?.request?.id : null;
  useEffect(() => {
    if (cashierRequestId) setCashierOpen(true);
  }, [cashierRequestId]);

  useEffect(() => {
    if (!applied) return;
    triggerOpenPaidOrderGroup(order.id);
    // 付款已接纳后，内嵌测试扫码小窗不再有意义，立即收起。
    setCashierOpen(false);
  }, [applied, order.id]);

  if (conflictingIntents) return <p className="order-inline-notice" role="alert">本单有待核对的原支付请求，请联系客服协助处理。</p>;
  if (!active) {
    return (
      <>
        {reading ? (
          <p className="order-muted" role="status">正在读取支付方式…</p>
        ) : (
          <>
            {readError ? (
              <div className="order-channel-payment" role="alert">
                <p className="order-inline-notice">{readError}</p>
                <button type="button" className="button secondary button--sm" disabled={busy || !userId} onClick={() => userId && void refresh(userId, undefined, true)}>
                  刷新支付状态
                </button>
              </div>
            ) : null}
            {children}
          </>
        )}
      </>
    );
  }

  const methods = (view?.capability?.methods ?? []).filter((m) => m === "ALIPAY_NATIVE" || m === "WEIXIN_NATIVE");
  const selected = view?.request?.method ?? pending.intent?.body?.method ?? method;
  const payable = paymentEntryOpen(order) && view?.order.status === "PENDING_PAYMENT";
  const amount = view?.request?.amount;
  const amountKnown = amount?.currency === "CNY" && typeof amount.cents === "string" && /^[1-9][0-9]{0,15}$/.test(amount.cents);
  const url =
    !applied &&
    payable &&
    view?.payment === null &&
    view.dataOrigin === "JOINPAY_CANDIDATE" &&
    view.capability.channelEnabled === true &&
    view.capability.productionPaymentCapability === true &&
    amountKnown &&
    ["ACTION_READY", "PROCESSING_UNCONFIRMED"].includes(view.request?.state ?? "") &&
    view.projection?.actionBlockedReason === null &&
    view.paymentAction?.kind === "QR_URL"
      ? channelPaymentUrl(view.paymentAction.url)
      : null;

  const queryOpen =
    !!view?.request &&
    !applied &&
    view?.dataOrigin === "JOINPAY_CANDIDATE" &&
    Boolean(view.request.state && ["SUBMITTING", "UNKNOWN", "PROCESSING_UNCONFIRMED", "ACTION_READY"].includes(view.request.state));

  const mayStart =
    payable &&
    view?.capability.channelEnabled === true &&
    (view.capability.productionPaymentCapability === true || testMode) &&
    view.payment === null &&
    view.request === null &&
    pending.state === "NONE" &&
    methods.includes(method) &&
    !blocked;

  const capabilityOff = Boolean(
    view?.dataOrigin === "JOINPAY_CANDIDATE" &&
    view.payment === null &&
    !view.request &&
    (view.capability.channelEnabled !== true || view.capability.productionPaymentCapability !== true)
  );

  const missingAmount = Boolean(view?.request && view.payment === null && !amountKnown && !capabilityOff);

  const actionUnavailable = Boolean(
    view?.request &&
    view.payment === null &&
    !applied &&
    amountKnown &&
    !capabilityOff &&
    !missingAmount &&
    view.dataOrigin === "JOINPAY_CANDIDATE" &&
    view.capability.channelEnabled === true &&
    view.capability.productionPaymentCapability === true &&
    ["ACTION_READY", "PROCESSING_UNCONFIRMED"].includes(view.request.state) &&
    view.projection?.actionBlockedReason === null &&
    !url
  );

  return (
    <div className="order-channel-payment" aria-busy={busy || reading}>
      <p role="status">
        {applied
          ? testMode
            ? "付款已记录"
            : "渠道付款已接纳"
          : testMode
            ? view?.request
              ? "等待付款"
              : "请选择支付方式"
            : view?.request && view.dataOrigin === "SYNTHETIC_PROTOCOL"
              ? "协议测试记录，不代表真实付款"
              : view?.payment?.disposition === "REVIEW_REQUIRED"
                ? "支付需要人工核对"
                : view?.payment?.disposition === "APPLIED"
                  ? "付款依据未记录"
                  : view?.request
                    ? channelStateLabels[view.request.state] ?? "支付状态未记录"
                    : "请选择支付方式"}
      </p>
      {!applied && view?.request ? (
        <p className="order-muted">
          {amountKnown ? `待支付 ${channelMoneyText(view.request.amount)}，请使用原支付方式完成付款。` : "支付金额暂时无法确认。"}
        </p>
      ) : null}
      {url ? (
        <figure className="order-channel-code">
          <QRCodeSVG value={url} size={176} level="M" marginSize={4} role="img" aria-label="本单支付二维码" />
          <figcaption className="order-muted">
            请使用{view?.request?.method === "WEIXIN_NATIVE" ? "微信" : "支付宝"}扫描本单二维码。二维码有效期未确认，请以渠道提示为准。
          </figcaption>
        </figure>
      ) : null}
      {capabilityOff ? <p className="order-inline-notice" role="status">当前环境未开放真实渠道支付；本页不会生成支付参数，也不会自动改用其他收款方式。</p> : null}
      {missingAmount ? <p className="order-inline-notice" role="status">支付金额暂时无法确认；本页不会生成支付二维码或跳转。</p> : null}
      {actionUnavailable ? <p className="order-inline-notice" role="status">支付参数暂时不可用，本页不会生成二维码或跳转；请刷新支付状态。</p> : null}
      {!applied && !view?.request ? (
        methods.length ? (
          <div className="order-payment-methods" role="radiogroup" aria-label="支付方式">
            {methods.map((value) => {
              const checked = selected === value;
              return (
                <label key={value} className={`order-payment-method${checked ? " is-selected" : ""}`}>
                  <input
                    type="radio"
                    name={paymentMethodGroup}
                    value={value}
                    checked={checked}
                    disabled={busy || reading || pending.state !== "NONE" || blocked}
                    onChange={() => setMethod(value)}
                  />
                  <span className="order-payment-method-icon"><PaymentMethodIcon method={value} /></span>
                  <span className="order-payment-method-copy">
                    <strong>{value === "ALIPAY_NATIVE" ? "支付宝" : "微信支付"}</strong>
                  </span>
                </label>
              );
            })}
          </div>
        ) : (
          <p className="order-inline-notice" role="status">当前没有可用支付方式；请稍后重试或联系客服。</p>
        )
      ) : null}
      {pending.state === "UNREADABLE" || notice || readError ? (
        <p className="order-inline-notice" role="alert">
          {pending.state === "UNREADABLE" ? "原支付请求恢复记录无法读取，已停止提交；请刷新状态或联系平台核对。" : notice ?? readError}
        </p>
      ) : null}
      <div className="order-trade-actions">
        {mayStart ? (
          <button type="button" className="button primary" disabled={busy || reading} onClick={() => void submit()}>
            {testMode ? "去支付" : "生成支付二维码"}
          </button>
        ) : null}
        {cashier ? (
          <button type="button" className="button secondary" disabled={busy || reading} onClick={() => setCashierOpen(true)}>
            打开支付
          </button>
        ) : null}
        {queryOpen ? (
          <button type="button" className="button secondary button--sm" disabled={busy || reading || blocked} onClick={() => void queryChannel()}>
            {busy ? "查询渠道结果…" : "查询渠道结果"}
          </button>
        ) : null}
        {url ? (
          <a className="button primary" href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">
            打开支付页面
          </a>
        ) : null}
        <button type="button" className="button secondary button--sm" disabled={busy || reading || !userId} onClick={() => userId && void refresh(userId, undefined, true)}>
          刷新支付状态
        </button>
        {pending.state === "VALID" && !applied ? (
          <button type="button" className="button secondary button--sm" disabled={busy || reading || blocked} onClick={() => void submit(true)}>
            恢复原请求回执
          </button>
        ) : null}
      </div>
      {cashier ? (
        <Dialog.Root open={cashierOpen} onOpenChange={(open) => { if (!open && cashierPending) return; setCashierOpen(open); }}>
          <Dialog.Portal>
            <Dialog.Backdrop className="modal-overlay" />
            <Dialog.Popup className="order-cashier-dialog">
              <Dialog.Title>扫码支付</Dialog.Title>
              <Dialog.Description>订单金额 {channelMoneyText(view?.request?.amount ?? null)} · {selected === "WEIXIN_NATIVE" ? "微信支付" : "支付宝"}</Dialog.Description>
              <div className="order-cashier-code" aria-label="测试二维码区域，不可扫码" />
              <p className="order-muted">测试环境无需真实扫码，点击下方按钮模拟付款。</p>
              <DemoCheckoutAction
                order={order}
                blocked={blocked}
                onChanged={onChanged}
                onAccepted={() => {
                  setCashierOpen(false);
                  triggerOpenPaidOrderGroup(order.id);
                  // 成功回执只说明模拟付款已完成；用独立读回刷新本组件自己的 view，
                  // 由读回的 APPLIED + PAID 把已接纳状态一路向上传递到 PaymentDialog。
                  if (userId) void refresh(userId, undefined, true);
                }}
                onModeChange={ignoreDemoMode}
                onPendingChange={setCashierPending}
                embedded
                expectedScope={cashier.scope}
              >{null}</DemoCheckoutAction>
              <Dialog.Close className="button secondary" disabled={cashierPending}>稍后支付</Dialog.Close>
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      ) : null}
      {!compact && !applied ? <p className="order-trade-note">打开支付页面不代表付款成功；付款状态以平台接纳记录为准，支付后仍须完成交付与开租确认。</p> : null}
    </div>
  );
}

export function PaymentAction({
  order,
  party,
  onChanged,
  onPaymentFacts,
  onAccepted,
  onCancelled,
  embedded = false,
  paid = false,
}: {
  order: Order;
  party: OrderParty;
  onChanged: () => void;
  onPaymentFacts?: (facts: OrderPaymentFacts | null) => void;
  onAccepted?: () => void;
  onCancelled?: () => void;
  embedded?: boolean;
  paid?: boolean;
}) {
  const session = useUserSession();
  const [channelAccepted, setChannelAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [error, setError] = useState<PanelError | null>(null);
  const [receipt, setReceipt] = useState<{ disposition: string; reasonCode?: string | null; replay: boolean } | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const [cancelUnknown, setCancelUnknown] = useState<string | null>(null);
  const [channelMode, setChannelMode] = useState(false);
  const [channelPending, setChannelPending] = useState(false);
  const [localMode, setLocalMode] = useState(false);
  const [localPending, setLocalPending] = useState(false);
  const [demoMode, setDemoMode] = useState(false);
  const [demoPending, setDemoPending] = useState(false);

  useEffect(() => {
    if (party === "renter" && receipt?.disposition === "APPLIED") {
      triggerOpenPaidOrderGroup(order.id);
    }
  }, [order.id, party, receipt]);

  const reset = useCallback(() => {
    setChannelAccepted(false);
    setBusy(false);
    setUnknown(null);
    setError(null);
    setReceipt(null);
    setCancelDialogOpen(false);
    setCancelUnknown(null);
  }, []);

  const { userId, isCurrent } = useIdentityReset(session, reset);

  useEffect(() => {
    if (!userId) return;
    const payment = loadIntent(userId, "order.payment", order.id);
    if (payment) setUnknown(isIntentStale(payment) ? STALE_MESSAGE : "检测到本订单有一笔结果未知的支付请求；原申请已保留，请勿重复提交。");
    const cancel = loadIntent(userId, "order.cancel", order.id);
    if (cancel) setCancelUnknown(isIntentStale(cancel) ? STALE_MESSAGE : "检测到本订单有一笔结果未知的取消请求；原申请已保留，请勿重复提交。");
  }, [userId, order.id]);

  type PayResult = { payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } };
  type CancelResult = { order?: Order } | Order;

  function applyOutcome(acting: string, outcome: WriteOutcome<PayResult>, kind: "pay"): void;
  function applyOutcome(acting: string, outcome: WriteOutcome<CancelResult>, kind: "cancel"): void;
  function applyOutcome(acting: string, outcome: WriteOutcome<PayResult> | WriteOutcome<CancelResult>, kind: "pay" | "cancel"): void {
    const fail = (typed: OrderRequestError) => {
      setError(panelError(typed));
      if (typed.status === 401 || typed.code === "UNAUTHENTICATED") void session.confirm();
    };
    if (outcome.status === "ok") {
      if (kind === "pay") {
        const payVal = outcome.value as PayResult;
        setReceipt(payVal.payment);
        if (payVal.payment.disposition === "APPLIED") {
          onAccepted?.();
          onChanged();
        }
      } else {
        setCancelDialogOpen(false);
        onCancelled?.();
        onChanged();
      }
      return;
    }
    if (outcome.status === "unknown") {
      if (kind === "pay") setUnknown(outcome.message);
      else setCancelUnknown(outcome.message);
      return;
    }
    if (outcome.status === "blocked") {
      setError({ message: BLOCKED_MESSAGE, retryable: false });
      return;
    }
    if (outcome.status === "unauthorized") {
      fail(outcome.error);
      return;
    }
    if (outcome.status === "recovery-unresolved") {
      void resolveRecovery(acting, outcome.error, kind);
      return;
    }
    fail(outcome.error);
    onChanged();
  }

  /** A read can only describe the observed state; only the original-key receipt may release the lock. */
  const resolveRecovery = async (acting: string, typed: OrderRequestError, kind: "pay" | "cancel") => {
    const label = kind === "pay" ? "支付" : "取消";
    try {
      const authority = await orderApi.paymentStatus(acting, order.id);
      if (!isCurrent(acting)) return;
      const observed = paymentObservation(authority.payment);
      const message = `原${label}请求仍未取得确定回执（原申请保留）。${observed}；当前页面状态不能确定这笔申请是否生效，请稍后再次查询或联系客服核对。`;
      if (kind === "pay") setUnknown(message);
      else setCancelUnknown(message);
    } catch {
      if (isCurrent(acting)) {
        const message = `原${label}请求仍未取得确定回执；最新处理状态暂时无法读取（${typed.message || "读取失败"}）。原请求保留，请稍后再次查询。`;
        if (kind === "pay") setUnknown(message);
        else setCancelUnknown(message);
      }
    }
  };

  const pay = async () => {
    if (!userId) return;
    const acting = userId;
    setBusy(true);
    setError(null);
    setUnknown(null);
    const outcome = await performGuardedWrite<PayResult>(
      acting,
      "order.payment",
      order.id,
      {},
      undefined,
      (_key, _body, _context, subject) => orderApi.pay(subject, order.id, _key),
      isCurrent
    );
    if (!isCurrent(acting)) return;
    setBusy(false);
    applyOutcome(acting, outcome, "pay");
  };

  const queryPayment = async () => {
    if (!userId) return;
    const acting = userId;
    if (!loadIntent(acting, "order.payment", order.id)) {
      setUnknown(null);
      onChanged();
      return;
    }
    setBusy(true);
    const outcome = await performGuardedWrite<PayResult>(
      acting,
      "order.payment",
      order.id,
      {},
      undefined,
      (key, _body, _context, subject) => orderApi.pay(subject, order.id, key),
      isCurrent
    );
    if (!isCurrent(acting)) return;
    setBusy(false);
    applyOutcome(acting, outcome, "pay");
  };

  const cancel = async () => {
    if (!userId) return;
    const acting = userId;
    setBusy(true);
    setError(null);
    setCancelUnknown(null);
    const outcome = await performGuardedWrite<CancelResult>(
      acting,
      "order.cancel",
      order.id,
      {},
      undefined,
      (key, body, _context, subject) => orderApi.cancel(subject, order.id, key, typeof body.reason === "string" ? body.reason : undefined),
      isCurrent
    );
    if (!isCurrent(acting)) return;
    setBusy(false);
    setCancelDialogOpen(false);
    applyOutcome(acting, outcome, "cancel");
  };

  const queryCancel = async () => {
    if (!userId) return;
    const acting = userId;
    if (!loadIntent(acting, "order.cancel", order.id)) {
      setCancelUnknown(null);
      onChanged();
      return;
    }
    setBusy(true);
    const outcome = await performGuardedWrite<CancelResult>(
      acting,
      "order.cancel",
      order.id,
      {},
      undefined,
      (key, body, _context, subject) => orderApi.cancel(subject, order.id, key, typeof body.reason === "string" ? body.reason : undefined),
      isCurrent
    );
    if (!isCurrent(acting)) return;
    setBusy(false);
    applyOutcome(acting, outcome, "cancel");
  };

  const payLocked = busy || receipt !== null || unknown !== null || cancelUnknown !== null;
  const cancelLocked = busy || receipt !== null || unknown !== null || cancelUnknown !== null || channelPending || localPending || demoPending;
  const paymentOpen = paymentEntryOpen(order);
  const cancelOpen = cancelEntryOpen(order);
  const expired = order.status === "PENDING_PAYMENT" && order.expiredAwaitingCancel === true;
  // 已知订单不再待支付、原键回执 APPLIED，或渠道读回 APPLIED+PAID，都属于确定生效事实。
  // unknown / cancelUnknown 的提示与「查询原请求 / 恢复原请求回执」入口始终独立保留，
  // 不因这里隐藏倒计时和取消入口而消失。
  const paidNow = paid || order.status !== "PENDING_PAYMENT" || receipt?.disposition === "APPLIED" || channelAccepted;

  return (
    <section className={embedded ? "order-payment-embedded" : "order-detail-section order-trade-panel"} id={embedded ? undefined : "order-trade-actions"} aria-label="支付与取消">
      {!embedded ? <div className="order-trade-heading"><h2 className="order-section-title">支付与取消</h2></div> : null}
      {paidNow ? (
        <div className="order-notice is-success" role="status">
          <CheckCircle2 size={17} aria-hidden="true" />
          <div>
            <strong>支付已接纳{receipt?.replay ? "（原回执重放）" : ""}</strong>
            <span>订单状态以服务端记录为准；支付不等于交付、建群或开租。</span>
          </div>
        </div>
      ) : null}
      {!embedded && !paidNow && order.status === "PENDING_PAYMENT" && order.holdUntil ? (
        <p className="order-trade-deadline">
          {expired ? "原支付保留截止" : "支付保留至"} {formatOrderTime(order.holdUntil)}；到期后是否取消以服务端订单状态为准。
        </p>
      ) : null}
      {expired && !paidNow ? (
        <div className="order-notice is-warning" role="status">
          <Clock3 size={17} aria-hidden="true" />
          <div>
            <strong>已到期，取消处理中</strong>
            <span>占用时间以订单记录为准；系统正在按序释放该账号，不再接受新的支付。</span>
          </div>
        </div>
      ) : null}
      {party === "renter" && !embedded && !paidNow ? (
        <p className="order-muted">付款或取消后，请先确认处理结果。结果尚未确认时，请查询原申请，不要重复操作；确认前暂不能付款或取消。</p>
      ) : null}
      {receipt?.disposition === "REVIEW_REQUIRED" ? (
        <div className="order-notice is-warning" role="status">
          <AlertCircle size={17} aria-hidden="true" />
          <div>
            <strong>支付结果需要人工核对</strong>
            <span>原因：{receipt.reasonCode ?? "未记录"}。未重复扣款；不再新发起支付，等待平台核对。</span>
          </div>
        </div>
      ) : null}
      {unknown ? <UnknownNotice label="支付结果未知" message={unknown} onQuery={() => void queryPayment()} onOpenOrder={onChanged} /> : null}
      {cancelUnknown ? <UnknownNotice label="取消结果未知" message={cancelUnknown} onQuery={() => void queryCancel()} onOpenOrder={onChanged} /> : null}
      {error ? <p className="order-inline-notice" role="alert">{error.message}</p> : null}
      {party === "renter" ? (
        <div className="order-trade-actions">
          <ChannelPaymentAction
            order={order}
            blocked={payLocked || cancelDialogOpen || demoPending}
            onChanged={onChanged}
            onModeChange={setChannelMode}
            onPendingChange={setChannelPending}
            onPaymentFacts={onPaymentFacts}
            onAccepted={() => { setChannelAccepted(true); onAccepted?.(); }}
            compact={embedded}
          >
            <DemoCheckoutAction
              order={order}
              blocked={payLocked || cancelDialogOpen}
              onChanged={onChanged}
              onModeChange={setDemoMode}
              onPendingChange={setDemoPending}
              onAccepted={() => { setChannelAccepted(true); onAccepted?.(); }}
              embedded={embedded}
            >
              <LocalSandboxPaymentAction
                order={order}
                blocked={payLocked || cancelDialogOpen}
                onChanged={onChanged}
                onModeChange={setLocalMode}
                onPendingChange={setLocalPending}
                compact={embedded}
              >
                {paidNow ? (
                  <p className="order-muted">本单已完成支付，无需再次付款。</p>
                ) : paymentOpen ? (
                  <button type="button" className="button primary" onClick={() => void pay()} disabled={payLocked}>
                    <WalletCards size={15} aria-hidden="true" />
                    {busy ? "提交支付请求…" : "提交支付（本地测试支付）"}
                  </button>
                ) : (
                  <p className="order-muted">当前订单不可继续支付；请刷新查看最新订单记录。</p>
                )}
              </LocalSandboxPaymentAction>
            </DemoCheckoutAction>
          </ChannelPaymentAction>
          {cancelOpen && !paidNow ? (
            <button ref={cancelButtonRef} type="button" className="button quiet" onClick={() => { setError(null); setCancelDialogOpen(true); }} disabled={cancelLocked}>
              取消订单
            </button>
          ) : null}
        </div>
      ) : (
        <p className="order-muted">等待租客完成支付；订单不提供代付或代为接单操作。</p>
      )}
      {!paidNow && !channelMode && !localMode && !demoMode && !embedded ? (
        <p className="order-trade-note">当前为本地测试支付入口，测试付款记录不代表支付渠道已扣款。</p>
      ) : null}
      <ConfirmAlertDialog
        open={cancelDialogOpen}
        onOpenChange={setCancelDialogOpen}
        title="取消订单"
        description="确认要取消这笔订单吗？取消后账号会重新开放，可能被其他租客租走。未付款订单不会扣款。"
        consequences={error ? <p role="alert">{error.message}</p> : undefined}
        confirmLabel={busy ? "取消中…" : "确认取消"}
        cancelLabel="再想想"
        onConfirm={() => void cancel()}
        busy={busy}
        returnFocusRef={cancelButtonRef}
      />
    </section>
  );
}

export function PaymentFactsProbe({ order, onFacts }: { order: Order; onFacts?: (facts: OrderPaymentFacts | null) => void }) {
  const session = useUserSession();
  const userId = session.status === "authenticated" ? session.userId : null;
  const { id } = order;
  useEffect(() => {
    if (!userId) {
      onFacts?.(PAYMENT_FACTS_UNREADABLE);
      return;
    }
    const controller = new AbortController();
    const originalRequestPending = (["order.channel-payment", "order.demo-checkout", "order.local-checkout", "order.payment"] as const).some(
      (kind) => inspectIntent(userId, kind, id).state !== "NONE"
    );
    onFacts?.(null);
    void orderApi.channelPaymentStatus(userId, id, controller.signal).then((view) => {
      if (!controller.signal.aborted) onFacts?.({ ...channelPaymentFacts(view), originalRequestPending });
    }).catch(() => {
      if (!controller.signal.aborted) onFacts?.({ ...PAYMENT_FACTS_UNREADABLE, originalRequestPending });
    });
    return () => controller.abort();
  }, [id, onFacts, userId]);
  return null;
}
