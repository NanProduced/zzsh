"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { QRCodeSVG } from "qrcode.react";
import { Dialog } from "@base-ui/react/dialog";
import { AlertCircle, CheckCircle2, CircleSlash, Clock3, RefreshCw, WalletCards } from "lucide-react";
import { ConfirmAlertDialog } from "@/components/ui/alert-dialog";
import TradeTermsDocument from "@/components/content/trade-terms-document";
import { useUserSession } from "@/components/session/user-session-provider";
import { useIdentityReset } from "@/components/session/identity-reset";
import {
  formatOrderTime,
  orderApi,
  orderIntentKey,
  parseLocalCheckout,
  OrderRequestError,
  type DemoCheckoutAvailability,
  type LocalCheckout,
  type LocalCheckoutAvailability,
  type Order,
  type OrderParty,
  type ChannelPaymentView,
  type ChannelPaymentMethod,
  type OrderSettlement,
  type EarlySettlementDisclosure,
  type OrderSettlementStage,
  type SettlementLine,
  type SettlementOpening,
  type SettlementPreview,
  type SettlementQuantityInput,
  type SettlementVersion,
  type OrderSubjectInput,
  captureOrderSubject,
  isOrderSubjectCurrent,
  runGuardedWrite,
  type GuardedError,
  type GuardedWriteResult,
} from "@/lib/order-client";
import { clearIntent, inspectIntent, isIntentStale, loadIntent, type IntentKind } from "@/lib/order-intents";
import { cancelEntryOpen, chargeRowLabel, consumptionRows, decisionAmountRows, isAdjustedVersion, moneyCents, moneyText, paymentEntryOpen, paymentObservation, postingAmountRows, previewAmounts, proposedConfirmationCents, quantityText, resourceName, settlementAmountRows, settlementPreviewProblem, unitHint, type OrderPaymentFacts, type SettlementAmountRow } from "@/lib/order-display";
import "./order.css";

type PanelError = { message: string; retryable: boolean };
export type WriteOutcome<T> =
  | { status: "ok"; value: T }
  | { status: "unknown"; message: string }
  | { status: "unauthorized"; error: OrderRequestError }
  | { status: "blocked"; message: string }
  | { status: "recovery-unresolved"; error: OrderRequestError }
  | { status: "definitive"; error: OrderRequestError };

/** Only what the channel payment read actually returned; the progress card must not infer an outcome. */
export function channelPaymentFacts(view: ChannelPaymentView): OrderPaymentFacts {
  return {
    state: view.request?.state ?? null,
    displayState: view.projection?.displayState ?? null,
    blockedReason: view.projection?.actionBlockedReason ?? null,
    readFailed: false,
  };
}

export const PAYMENT_FACTS_UNREADABLE: OrderPaymentFacts = { state: null, displayState: null, blockedReason: null, readFailed: true };

/** Brand marks are used only to identify the payment method; no remote icon dependency. */
function PaymentMethodIcon({ method }: { method: ChannelPaymentMethod }) {
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


/** Facts the detail banner may state, and only what the settlement read actually returned. */
export type OrderStageFacts = {
  rentalStarted: boolean;
  phase: "RENTING" | "INTAKE_PENDING" | "DECISION_PENDING" | "DECISION_REJECTED" | "DECISION_WAITING" | "POSTED";
  early: boolean;
  postedAt: string | null;
  openingVersionNo: string | null;
  settlementVersionNo: string | null;
  rejectedBy?: string | null;
  openingConfirmedAt: string | null;
  myAck: boolean;
  otherAck: boolean;
  /** Server-owned stage when the settlement read supplies one; null on older projections. */
  stageCode: OrderSettlementStage["code"] | null;
  viewerActionRequired: boolean;
  /** Frozen per-order auto-confirm deadline; null when the server recorded none. */
  autoConfirmDueAt: string | null;
  /** Opening generation outcome; null when the read omits the field. */
  openingGenerationState: "CREATED" | "REVIEW_REQUIRED" | null;
  openingGenerationRecoveryRequired: boolean;
  feeReconfirmationRequired?: boolean;
  /** This party's final settlement figure, straight from the posting's final column. `null` until posted. */
  settled: { label: string; text: string } | null;
};

function writeError(error: unknown): string {
  if (error instanceof OrderRequestError) {
    if (error.status === 0 || error.status === 502) return "网络或网关中断，原请求结果未知；可查询原请求，不会重复执行。";
    return error.message || "操作未完成，请稍后重试。";
  }
  return "操作未完成，请稍后重试。";
}

/**
 * Freeze key/body/context before a write and never overwrite an existing intent: a retry or a
 * recovery consumes the original frozen body, not whatever the caller passes now. Age only
 * disables automatic replay (callers must read authority first); it never releases the intent.
 * A 4xx on a fresh key is a definitive non-commit; a 4xx while recovering an existing intent is
 * returned as `recovery-unresolved` and only an authoritative read may release it.
 */
/** The shared lib result carries structural errors; map them back to the panel outcome type. */
function toOrderRequestError(error: GuardedError): OrderRequestError {
  return new OrderRequestError(error.status, { error: { code: error.code, message: error.message } });
}
function mapGuardedResult<T>(result: GuardedWriteResult<T>): WriteOutcome<T> {
  if (result.status === "ok") return { status: "ok", value: result.value };
  if (result.status === "unknown") return { status: "unknown", message: writeError(toOrderRequestError(result.error)) };
  if (result.status === "unauthorized") return { status: "unauthorized", error: toOrderRequestError(result.error) };
  if (result.status === "blocked") return { status: "blocked", message: result.message };
  if (result.status === "recovery-unresolved") return { status: "recovery-unresolved", error: toOrderRequestError(result.error) };
  return { status: "definitive", error: toOrderRequestError(result.error) };
}

/**
 * Panels delegate to the same lib core as the customer-support order card, so a frozen
 * `opening.confirm` intent written by either entry is byte-compatible and recoverable by both.
 */
export async function performGuardedWrite<T>(
  subject: OrderSubjectInput | null,
  kind: IntentKind,
  resourceId: string,
  body: Record<string, unknown>,
  context: Record<string, unknown> | undefined,
  request: (key: string, body: Record<string, unknown>, context: Record<string, unknown> | undefined, subject: string) => Promise<T>,
  assertCurrent?: (subject: string) => boolean,
): Promise<WriteOutcome<T>> {
  return mapGuardedResult(await runGuardedWrite<T>({
    subject, kind, resourceId, body, context, request,
    keyFactory: orderIntentKey,
    assertCurrent,
  }));
}

function panelError(error: unknown): PanelError {
  if (error instanceof OrderRequestError) {
    // An already-open older tab hits the new BFF without the frozen-subject header. Never relax
    // the write binding for compatibility: tell the user to reload once. The original key/body
    // stays in session storage and is recovered by the new bundle after the reload.
    if (error.status === 400 && error.code === "IDENTITY_BINDING_REQUIRED") return { message: "页面版本已更新，请刷新页面后重试；原申请已保留，不会重复提交。", retryable: false };
    if (error.status === 0) return { message: "网络中断，结果未知。原请求可安全重试，不会重复扣款或重复记账。", retryable: true };
    if (error.status === 401 || error.code === "UNAUTHENTICATED") return { message: "登录状态已变化；原申请已保留，确认身份后可恢复。", retryable: false };
    if (error.status === 403) return { message: "当前身份没有这项操作权限。", retryable: false };
    if (error.status === 404) return { message: "当前对象不存在或当前环境未开启这项交易操作。", retryable: false };
    if (error.status === 409) return { message: "服务端状态与本次请求不一致；已按最新处理状态刷新，请按最新结果操作。", retryable: false };
    if (error.status === 503) return { message: error.message || "依赖的服务端依据暂不可用。", retryable: true };
    return { message: error.message || "操作未完成，请稍后重试。", retryable: true };
  }
  return { message: "操作未完成，请稍后重试。", retryable: true };
}

const AUTH_MESSAGE = "登录状态已变化；原申请已保留。正在确认身份，确认后可在本页恢复。";
const BLOCKED_MESSAGE = "浏览器会话存储不可用，无法保存原请求恢复信息；已阻止提交。请启用会话存储后重试。";
const STALE_MESSAGE = "这笔申请已超过自动查询期限。请先刷新页面并联系客服核对原申请，请勿重复提交。";

function partyLabel(party: string): string {
  if (party === "RENTER") return "租客";
  if (party === "OWNER") return "号主";
  if (party === "SUPPORT") return "客服";
  return party;
}

function UnknownNotice({ label, message, onQuery, onOpenOrder }: { label: string; message: string; onQuery: () => void; onOpenOrder?: () => void }) {
  return <div className="order-notice is-warning" role="status"><AlertCircle size={17} aria-hidden="true" /><div><strong>{label}</strong><span>{message}</span></div>
    <div className="order-trade-actions">
      <button type="button" className="button secondary button--sm" onClick={onQuery}><RefreshCw size={14} aria-hidden="true" />查询原请求结果</button>
      {onOpenOrder ? <button type="button" className="button quiet button--sm" onClick={onOpenOrder}>刷新订单</button> : null}
    </div>
  </div>;
}

function AmountTable({ rows, caption }: { rows: SettlementAmountRow[]; caption: string }) {
  if (rows.length === 0) return null;
  return <table className="order-trade-amounts" aria-label={caption}>
    <caption>{caption}</caption>
    <tbody>{rows.map((row) => <tr key={row.label}><th scope="row">{row.label}</th><td>{row.value}{row.note ? <small>{row.note}</small> : null}</td></tr>)}</tbody>
  </table>;
}

function RecordList({ title, records }: { title: string; records: Array<{ label: string; time?: string | null }> }) {
  if (records.length === 0) return null;
  return <div className="order-records">
    <h3>{title}</h3>
    <ul>{records.map((record, index) => {
      const recordedAt = record.time;
      const knownTime = typeof recordedAt === "string" && Number.isFinite(Date.parse(recordedAt));
      return <li key={`${record.label}-${index}`}><span className="order-record-mark" aria-hidden="true"><CheckCircle2 size={13} /></span><span>{record.label}</span>{knownTime ? <time dateTime={recordedAt}>{formatOrderTime(recordedAt)}</time> : <span className="order-muted">时间未记录</span>}</li>;
    })}</ul>
  </div>;
}

const channelStateLabels: Record<string, string> = {
  SUBMITTING: "正在提交支付请求", UNKNOWN: "支付结果正在确认", ACTION_READY: "等待付款", PROCESSING_UNCONFIRMED: "支付状态正在确认",
  CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE: "付款依据正在接纳", ACCEPTED: "付款依据未记录", REVIEW_REQUIRED: "支付需要人工核对", REJECTED_BY_CHANNEL: "渠道未受理本次请求",
};
function channelMoneyText(value: { cents: string; currency: string } | null | undefined) {
  if (!value || value.currency !== "CNY" || typeof value.cents !== "string" || !/^(0|[1-9][0-9]{0,15})$/.test(value.cents)) return "未记录";
  const cents = BigInt(value.cents);
  return moneyText({ amount: `${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}`, currency: "CNY" });
}
function channelPaymentUrl(value: unknown): string | null {
  if (typeof value !== "string" || value.length > 2048 || /[\s\u0000-\u001f\u007f]/u.test(value)) return null;
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash ? value : null; } catch { return null; }
}
function channelApplied(view: ChannelPaymentView | null): boolean {
  const payment = view?.payment;
  const acceptedSource = view?.dataOrigin === "JOINPAY_PROVIDER" || view?.dataOrigin === "LOCAL_CONTROLLED"
    && view.capability?.evidenceProfile === "CONTROLLED_TEST" && view.capability.productionPaymentCapability === false;
  return acceptedSource && payment?.disposition === "APPLIED" && typeof payment.confirmationId === "string" && payment.confirmationId.length > 0
    && payment.amount?.currency === "CNY" && typeof payment.amount.cents === "string" && /^[1-9][0-9]{0,15}$/.test(payment.amount.cents);
}

const ignoreDemoMode = () => {};

/** 新渠道独立保留原键；普通刷新只读本地状态，不把旧受控请求当作渠道付款。 */
function ChannelPaymentAction({ order, blocked, onChanged, onModeChange, onPendingChange, onPaymentFacts, compact = false, children }: {
  order: Order; blocked: boolean; onChanged: () => void; onModeChange: (active: boolean) => void; onPendingChange: (pending: boolean) => void;
  onPaymentFacts?: (facts: OrderPaymentFacts | null) => void; compact?: boolean; children: ReactNode;
}) {
  const reportPayment = useRef(onPaymentFacts);
  useEffect(() => { reportPayment.current = onPaymentFacts; }, [onPaymentFacts]);
  const session = useUserSession();
  const paymentMethodGroup = useId();
  const [snapshot, setSnapshot] = useState<{ userId: string; orderId: string; view: ChannelPaymentView } | null>(null);
  const [readError, setReadError] = useState<string | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [reading, setReading] = useState(true);
  const [cashierOpen, setCashierOpen] = useState(false), [cashierPending, setCashierPending] = useState(false);
  const [method, setMethod] = useState<ChannelPaymentMethod>("ALIPAY_NATIVE");
  const autoOpenedGroup = useRef(false);
  const latest = useRef({ orderId: order.id, onChanged }); latest.current = { orderId: order.id, onChanged };
  const reset = useCallback(() => { setSnapshot(null); setReadError(null); setNotice(null); setBusy(false); setReading(true); setMethod("ALIPAY_NATIVE"); setCashierOpen(false); setCashierPending(false); }, []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  const identity = useRef(isCurrent); identity.current = isCurrent;
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [visibleOrder, setVisibleOrder] = useState(order.id);
  if (visibleOrder !== order.id) { setVisibleOrder(order.id); reset(); }
  const view = snapshot?.userId === userId && snapshot.orderId === order.id ? snapshot.view : null;
  const pending = userId ? inspectIntent(userId, "order.channel-payment", order.id) : { state: "NONE" as const, intent: null };
  const previousDemoPending = userId ? inspectIntent(userId, "order.demo-checkout", order.id) : { state: "NONE" as const, intent: null };
  const originalRequestPending = pending.state !== "NONE" || previousDemoPending.state !== "NONE";
  const originalRequestPendingRef = useRef(originalRequestPending);
  originalRequestPendingRef.current = originalRequestPending;
  const conflictingIntents = pending.state !== "NONE" && previousDemoPending.state !== "NONE";
  const testMode = view?.dataOrigin === "LOCAL_CONTROLLED" && view.capability?.productionPaymentCapability === false;
  const active = conflictingIntents || pending.state === "VALID" || !!view && (testMode && (previousDemoPending.state === "NONE" || cashierPending) && view.capability.channelEnabled === true
    || view.dataOrigin !== "LOCAL_CONTROLLED" && (view.capability?.channelEnabled === true && view.capability.productionPaymentCapability === true
      || ["JOINPAY_CANDIDATE", "JOINPAY_PROVIDER"].includes(view.dataOrigin)));
  const unsettled = busy || cashierPending || conflictingIntents || pending.state === "VALID" || active && (pending.state === "UNREADABLE" || view?.payment != null
    || view?.request != null && !["ACTION_READY", "REJECTED_BY_CHANNEL"].includes(view.request.state));
  useEffect(() => { onModeChange(active); onPendingChange(unsettled); }, [active, unsettled, onModeChange, onPendingChange]);
  useEffect(() => {
    if (originalRequestPending) {
      reportPayment.current?.({ ...(view && !readError ? channelPaymentFacts(view) : PAYMENT_FACTS_UNREADABLE), originalRequestPending: true });
    } else if (view && !reading && !readError) {
      reportPayment.current?.(channelPaymentFacts(view));
    }
  }, [originalRequestPending, view, reading, readError]);
  useEffect(() => () => { onModeChange(false); onPendingChange(false); }, [onModeChange, onPendingChange]);
  const refresh = useCallback(async (acting: string, signal?: AbortSignal, notify = false) => {
    const expected = order.id;
    setReading(true);
    reportPayment.current?.(null);
    try {
      const next = await orderApi.channelPaymentStatus(acting, expected, signal);
      if (!mounted.current || !identity.current(acting) || latest.current.orderId !== expected || signal?.aborted) return;
      if (next?.contractVersion !== "order-payment-request.v1" || next.order?.id !== expected || !Array.isArray(next.capability?.methods)) throw new OrderRequestError(502, null);
      setSnapshot({ userId: acting, orderId: expected, view: next }); setReadError(null);
      reportPayment.current?.({ ...channelPaymentFacts(next), originalRequestPending: originalRequestPendingRef.current });
      if (notify && channelApplied(next)) latest.current.onChanged();
    } catch (error) {
      if (mounted.current && identity.current(acting) && latest.current.orderId === expected && !signal?.aborted) {
        setReadError(panelError(error).message);
        reportPayment.current?.({ ...PAYMENT_FACTS_UNREADABLE, originalRequestPending: originalRequestPendingRef.current });
      }
    } finally { if (mounted.current && identity.current(acting) && latest.current.orderId === expected && !signal?.aborted) setReading(false); }
  }, [order.id]);
  useEffect(() => {
    if (!userId) { setReading(false); reportPayment.current?.(PAYMENT_FACTS_UNREADABLE); return; }
    const controller = new AbortController(); void refresh(userId, controller.signal);
    return () => controller.abort();
  }, [userId, refresh]);
  const submit = async (recover = false) => {
    if (!userId || busy || blocked) return;
    const acting = userId, expected = order.id, original = inspectIntent(acting, "order.channel-payment", expected);
    if (recover) await refresh(acting);
    if (!mounted.current || !isCurrent(acting) || latest.current.orderId !== expected) return;
    if (original.state === "UNREADABLE") { setNotice("原支付请求记录无法读取，已停止提交；请保留本页并联系平台核对。"); return; }
    if (original.intent && isIntentStale(original.intent)) { setNotice("原支付请求已超出自动恢复时限；原请求已保留，请刷新状态或联系平台核对。"); return; }
    const selected = original.intent?.body?.method ?? method;
    if (selected !== "ALIPAY_NATIVE" && selected !== "WEIXIN_NATIVE") { setNotice("原支付方式未能确认，不能更换方式重新提交。"); return; }
    setBusy(true); setNotice(null);
    const outcome = await performGuardedWrite(acting, "order.channel-payment", expected, { method: selected }, undefined, async (key, body, _context, subject) => {
      if (body.method !== "ALIPAY_NATIVE" && body.method !== "WEIXIN_NATIVE") throw new OrderRequestError(400, null);
      const receipt = await orderApi.requestChannelPayment(subject, expected, body.method, key);
      const amount = receipt?.request?.amount;
      if (receipt?.contractVersion !== "order-payment-request.v1" || receipt.dataOrigin !== (testMode ? "LOCAL_CONTROLLED" : "JOINPAY_CANDIDATE") || typeof receipt.replay !== "boolean"
        || receipt.request?.orderId !== expected || receipt.request.method !== body.method || typeof receipt.request.id !== "string" || !receipt.request.id
        || typeof receipt.request.createdAt !== "string" || !Number.isFinite(Date.parse(receipt.request.createdAt)) || typeof receipt.request.updatedAt !== "string" || !Number.isFinite(Date.parse(receipt.request.updatedAt))
        || amount?.currency !== "CNY" || typeof amount.cents !== "string" || !/^[1-9][0-9]{0,15}$/.test(amount.cents)
        || receipt.payment !== null || receipt.paymentAction !== null) throw new OrderRequestError(502, null);
      return receipt;
    }, isCurrent);
    if (!mounted.current || !isCurrent(acting) || latest.current.orderId !== expected) return;
    setBusy(false);
    if (outcome.status === "ok") { await refresh(acting, undefined, true); return; }
    if (outcome.status === "unknown") setNotice("支付请求回执尚未确认，原请求和支付方式已保留；请恢复原请求，不要重复付款。");
    else if (outcome.status === "blocked") setNotice(BLOCKED_MESSAGE);
    else if (outcome.status === "unauthorized") { setNotice(AUTH_MESSAGE); void session.confirm(); }
    else setNotice(outcome.status === "recovery-unresolved" ? "原请求仍未记录，恢复记录已保留；请刷新状态或联系平台核对。" : panelError(outcome.error).message);
  };
  const queryChannel = async () => {
    const queryingRequestId = view?.request?.id;
    if (!userId || busy || blocked || !queryingRequestId) return;
    const acting = userId;
    setBusy(true); setNotice(null);
    try {
      const receipt = await orderApi.queryChannelPayment(acting, order.id);
      if (!mounted.current || !isCurrent(acting) || latest.current.orderId !== order.id) return;
      if (receipt?.contractVersion !== "order-payment-request.v1" || receipt.request?.id !== queryingRequestId || receipt.request?.orderId !== order.id || typeof receipt.query?.kind !== "string") throw new OrderRequestError(502, null);
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
  const cashier = testMode && view?.capability.channelEnabled === true && view.payment === null
    && view.request?.state === "ACTION_READY" && view.request.amount?.currency === "CNY"
    && /^[1-9][0-9]{0,15}$/.test(view.request.amount.cents) && view.paymentAction?.kind === "TEST_CASHIER"
    && ["ECS_TEST_SIMULATED", "LOCAL_DEMO_SIMULATED"].includes(view.paymentAction.scope) ? view.paymentAction : null;
  const cashierRequestId = cashier ? view?.request?.id : null;
  useEffect(() => { if (cashierRequestId) setCashierOpen(true); }, [cashierRequestId]);
  // 付款成功是用户此刻最关心的事件：付款页直接打开本单群。每个浏览器会话只主动开一次。
  const openPaidOrderGroup = useCallback(() => {
    if (autoOpenedGroup.current) return;
    autoOpenedGroup.current = true;
    const key = `zzsh:order-group-autopen:${order.id}`;
    try { if (window.sessionStorage.getItem(key)) return; window.sessionStorage.setItem(key, "1"); } catch { /* sessionStorage is optional */ }
    window.dispatchEvent(new CustomEvent("zzsh:order-groups", { detail: { party: "renter", orderId: order.id } }));
  }, [order.id]);
  useEffect(() => { if (applied) openPaidOrderGroup(); }, [applied, openPaidOrderGroup]);
  if (conflictingIntents) return <p className="order-inline-notice" role="alert">本单有待核对的原支付请求，请联系客服协助处理。</p>;
  if (!active) return <>{reading ? <p className="order-muted" role="status">正在读取支付方式…</p> : <>{readError ? <div className="order-channel-payment" role="alert"><p className="order-inline-notice">{readError}</p><button type="button" className="button secondary button--sm" disabled={busy || !userId} onClick={() => userId && void refresh(userId, undefined, true)}>刷新支付状态</button></div> : null}{children}</>}</>;
  const methods = (view?.capability?.methods ?? []).filter(m => m === "ALIPAY_NATIVE" || m === "WEIXIN_NATIVE");
  const selected = view?.request?.method ?? pending.intent?.body?.method ?? method;
  const payable = paymentEntryOpen(order) && view?.order.status === "PENDING_PAYMENT";
  const amount = view?.request?.amount;
  const amountKnown = amount?.currency === "CNY" && typeof amount.cents === "string" && /^[1-9][0-9]{0,15}$/.test(amount.cents);
  const url = !applied && payable && view?.payment === null && view.dataOrigin === "JOINPAY_CANDIDATE" && view.capability.channelEnabled === true && view.capability.productionPaymentCapability === true
    && amountKnown && ["ACTION_READY", "PROCESSING_UNCONFIRMED"].includes(view.request?.state ?? "") && view.projection?.actionBlockedReason === null
    && view.paymentAction?.kind === "QR_URL" ? channelPaymentUrl(view.paymentAction.url) : null;
  const queryOpen = !!view?.request && !applied && view.dataOrigin === "JOINPAY_CANDIDATE"
    && ["SUBMITTING", "UNKNOWN", "PROCESSING_UNCONFIRMED", "ACTION_READY"].includes(view.request.state);
  const mayStart = payable && view?.capability.channelEnabled === true && (view.capability.productionPaymentCapability === true || testMode)
    && view.payment === null && view.request === null && pending.state === "NONE" && methods.includes(method) && !blocked;
  const capabilityOff = Boolean(view?.dataOrigin === "JOINPAY_CANDIDATE" && view.payment === null && !view.request
    && (view.capability.channelEnabled !== true || view.capability.productionPaymentCapability !== true));
  const missingAmount = Boolean(view?.request && view.payment === null && !amountKnown && !capabilityOff);
  const actionUnavailable = Boolean(view?.request && view.payment === null && !applied && amountKnown && !capabilityOff && !missingAmount
    && view.dataOrigin === "JOINPAY_CANDIDATE" && view.capability.channelEnabled === true && view.capability.productionPaymentCapability === true
    && ["ACTION_READY", "PROCESSING_UNCONFIRMED"].includes(view.request.state) && view.projection?.actionBlockedReason === null && !url);
  return <div className="order-channel-payment" aria-busy={busy || reading}>
    <p role="status">{applied ? testMode ? "付款已记录" : "渠道付款已接纳" : testMode ? view?.request ? "等待付款" : "请选择支付方式" : view?.request && view.dataOrigin === "SYNTHETIC_PROTOCOL" ? "协议测试记录，不代表真实付款" : view?.payment?.disposition === "REVIEW_REQUIRED" ? "支付需要人工核对" : view?.payment?.disposition === "APPLIED" ? "付款依据未记录" : view?.request ? channelStateLabels[view.request.state] ?? "支付状态未记录" : "请选择支付方式"}</p>
    {view?.request ? <p className="order-muted">{amountKnown ? `待支付 ${channelMoneyText(view.request.amount)}，请使用原支付方式完成付款。` : "支付金额暂时无法确认。"}</p> : null}
    {url ? <figure className="order-channel-code"><QRCodeSVG value={url} size={176} level="M" marginSize={4} role="img" aria-label="本单支付二维码" /><figcaption className="order-muted">请使用{view?.request?.method === "WEIXIN_NATIVE" ? "微信" : "支付宝"}扫描本单二维码。二维码有效期未确认，请以渠道提示为准。</figcaption></figure> : null}
    {capabilityOff ? <p className="order-inline-notice" role="status">当前环境未开放真实渠道支付；本页不会生成支付参数，也不会自动改用其他收款方式。</p> : null}
    {missingAmount ? <p className="order-inline-notice" role="status">支付金额暂时无法确认；本页不会生成支付二维码或跳转。</p> : null}
    {actionUnavailable ? <p className="order-inline-notice" role="status">支付参数暂时不可用，本页不会生成二维码或跳转；请刷新支付状态。</p> : null}
    {!applied && !view?.request ? (
      methods.length ? <div className="order-payment-methods" role="radiogroup" aria-label="支付方式">
        {methods.map(value => {
          const checked = selected === value;
          return <label key={value} className={`order-payment-method${checked ? " is-selected" : ""}`}>
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
          </label>;
        })}
      </div> : <p className="order-inline-notice" role="status">当前没有可用支付方式；请稍后重试或联系客服。</p>
    ) : null}
    {pending.state === "UNREADABLE" || notice || readError ? <p className="order-inline-notice" role="alert">{pending.state === "UNREADABLE" ? "原支付请求恢复记录无法读取，已停止提交；请刷新状态或联系平台核对。" : notice ?? readError}</p> : null}
    <div className="order-trade-actions">
      {mayStart ? <button type="button" className="button primary" disabled={busy || reading} onClick={() => void submit()}>{testMode ? "去支付" : "生成支付二维码"}</button> : null}
      {cashier ? <button type="button" className="button secondary" disabled={busy || reading} onClick={() => setCashierOpen(true)}>打开支付</button> : null}
    {queryOpen ? <button type="button" className="button secondary button--sm" disabled={busy || reading || blocked} onClick={() => void queryChannel()}>{busy ? "查询渠道结果…" : "查询渠道结果"}</button> : null}
      {url ? <a className="button primary" href={url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">打开支付页面</a> : null}
      <button type="button" className="button secondary button--sm" disabled={busy || reading || !userId} onClick={() => userId && void refresh(userId, undefined, true)}>刷新支付状态</button>
      {pending.state === "VALID" && !applied ? <button type="button" className="button secondary button--sm" disabled={busy || reading || blocked} onClick={() => void submit(true)}>恢复原请求回执</button> : null}
    </div>
    {cashier ? <Dialog.Root open={cashierOpen} onOpenChange={open => { if (!open && cashierPending) return; setCashierOpen(open); }}>
      <Dialog.Portal><Dialog.Backdrop className="modal-overlay" /><Dialog.Popup className="order-cashier-dialog">
        <Dialog.Title>扫码支付</Dialog.Title>
        <Dialog.Description>订单金额 {channelMoneyText(view?.request?.amount ?? null)} · {selected === "WEIXIN_NATIVE" ? "微信支付" : "支付宝"}</Dialog.Description>
        <div className="order-cashier-code" aria-label="测试二维码区域，不可扫码" />
        <p className="order-muted">测试环境无需真实扫码，点击下方按钮模拟付款。</p>
        <DemoCheckoutAction order={order} blocked={blocked} onChanged={onChanged} onAccepted={openPaidOrderGroup} onModeChange={ignoreDemoMode} onPendingChange={setCashierPending} embedded expectedScope={cashier.scope}>{null}</DemoCheckoutAction>
        <Dialog.Close className="button secondary" disabled={cashierPending}>稍后支付</Dialog.Close>
      </Dialog.Popup></Dialog.Portal>
    </Dialog.Root> : null}
    {!compact ? <p className="order-trade-note">打开支付页面不代表付款成功；付款状态以平台接纳记录为准，支付后仍须完成交付与开租确认。</p> : null}
  </div>;
}

export function LocalSandboxPaymentAction({ order, blocked, onChanged, onModeChange, onPendingChange, compact = false, children }: {
  order: Order; blocked: boolean; onChanged: () => void; onModeChange: (active: boolean) => void; onPendingChange: (pending: boolean) => void; compact?: boolean; children: ReactNode;
}) {
  const session = useUserSession();
  const [discovery, setDiscovery] = useState<'NOT_INSTALLED' | 'CHECKING' | 'LOCAL' | 'FAILED'>('NOT_INSTALLED');
  const [view, setView] = useState<LocalCheckoutAvailability | null>(null), [checkout, setCheckout] = useState<LocalCheckout | null>(null);
  const [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const reset = useCallback(() => { setView(null); setCheckout(null); setBusy(false); setNotice(null); }, []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  const latest = useRef({ orderId: order.id, isCurrent, onChanged }); latest.current = { orderId: order.id, isCurrent, onChanged };
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [visibleOrder, setVisibleOrder] = useState(order.id);
  if (visibleOrder !== order.id) { setVisibleOrder(order.id); reset(); }
  const isLocal = typeof window !== 'undefined' && window.location.protocol === 'http:' && window.location.hostname === '127.0.0.1' && !!window.location.port;
  const pending = userId && isLocal ? inspectIntent(userId, 'order.local-checkout', order.id) : { state: 'NONE' as const, intent: null };
  const active = isLocal && discovery !== 'NOT_INSTALLED';
  useEffect(() => { onModeChange(active); onPendingChange(active && (busy || pending.state !== 'NONE')); }, [active, busy, pending.state, onModeChange, onPendingChange]);
  useEffect(() => () => { onModeChange(false); onPendingChange(false); }, [onModeChange, onPendingChange]);
  useEffect(() => {
    if (!isLocal || !userId) { setDiscovery('NOT_INSTALLED'); return; }
    const controller = new AbortController(), acting = userId, expected = order.id;
    setDiscovery('CHECKING'); setView(null); setCheckout(null);
    void orderApi.localCheckoutAvailability(acting, expected, controller.signal).then(next => {
      if (!controller.signal.aborted && latest.current.isCurrent(acting) && latest.current.orderId === expected) { setView(next); setDiscovery('LOCAL'); }
    }).catch(error => {
      if (!controller.signal.aborted && latest.current.isCurrent(acting) && latest.current.orderId === expected) {
        setDiscovery(error instanceof OrderRequestError && error.status === 404 ? 'NOT_INSTALLED' : 'FAILED');
      }
    });
    return () => controller.abort();
  }, [isLocal, userId, order.id]);
  const expected = (key: string) => {
    const amount = order.amounts?.totalDue;
    if (!order.displayNo || !amount || amount.currency !== 'CNY' || amount.unit !== 'yuan' || amount.scale !== 2 || !/^(0|[1-9]\d{0,21})\.\d{2}$/.test(amount.amount)) throw new OrderRequestError(502, null);
    return { orderId: order.id, displayNo: order.displayNo, amountCents: BigInt(amount.amount.replace('.', '')).toString(), key, origin: window.location.origin };
  };
  const issue = async () => {
    if (!userId || busy || blocked || !view?.checkoutEnabled || pending.state !== 'NONE') return;
    const acting = userId, orderId = order.id; setBusy(true); setNotice(null); setCheckout(null);
    const result = await performGuardedWrite(acting, 'order.local-checkout', orderId, {}, undefined, async (key, body, _context, subject) => {
      if (Object.keys(body).length) throw new OrderRequestError(409, null);
      const binding = expected(key);
      return parseLocalCheckout(await orderApi.issueLocalCheckout(subject, orderId, key), binding);
    }, isCurrent);
    if (!mounted.current || !isCurrent(acting) || latest.current.orderId !== orderId) return;
    setBusy(false);
    if (result.status === 'ok') setCheckout(result.value);
    else { setNotice(result.status === 'blocked' ? BLOCKED_MESSAGE : result.status === 'definitive' ? '本次未取得本地凭据；请刷新原订单，核对当前可操作状态。' : '本地凭据申请结果尚未确认；请查询原申请，不要重新提交。'); if (result.status === 'unauthorized') void session.confirm(); }
  };
  const recover = async () => {
    if (!userId || busy || blocked || pending.state !== 'VALID' || !pending.intent) return;
    const acting = userId, orderId = order.id, original = pending.intent; setBusy(true); setNotice(null);
    try {
      if (Object.keys(original.body).length) throw new OrderRequestError(409, null);
      const binding = expected(original.key), result = await orderApi.localCheckoutReceipt(acting, orderId, original.key);
      if (!mounted.current || !isCurrent(acting) || latest.current.orderId !== orderId) return;
      if (result.scope !== 'LOCAL_CONTROLLED' || result.mayReapply !== false || result.knowledge !== 'KNOWN') throw new OrderRequestError(503, null);
      const safe = parseLocalCheckout(result.receipt, binding); clearIntent(acting, 'order.local-checkout', orderId); setCheckout(safe);
    } catch { if (mounted.current && isCurrent(acting) && latest.current.orderId === orderId) setNotice('原申请尚未取得确定回执，原标识已保留；请稍后再查询，不会重新发起。'); }
    finally { if (mounted.current && isCurrent(acting) && latest.current.orderId === orderId) setBusy(false); }
  };
  if (!active) return children;
  return <div className="order-local-checkout" aria-label="本地模拟付款">
    {!compact ? <p className="order-inline-notice">本地模拟付款仅用于当前隔离联调环境，不会向银行或支付机构发起真实支付。</p> : null}
    {discovery === 'CHECKING' ? <p role="status">正在确认本单本地模拟入口…</p> : discovery === 'FAILED' ? <p role="alert">本地模拟入口暂无法确认；请刷新原订单，不会自动改用其他支付方式。</p> : !view?.checkoutEnabled ? <p role="status">本单当前不可发起本地模拟，请刷新原订单查看最新结果。</p> : null}
    {pending.state === 'UNREADABLE' ? <p role="alert">原本地凭据申请无法读取，已停止提交，请保留本页并联系平台核对。</p> : notice ? <p role="status">{notice}</p> : null}
    {checkout ? <><p>原订单 {checkout.displayNo} · 本次模拟 {moneyCents(checkout.amount.cents)} · 凭据有效至 {formatOrderTime(checkout.expiresAt)}</p><a className="button" href={checkout.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">打开本地模拟确认页</a></> : null}
    <div className="order-trade-actions">
      {view?.checkoutEnabled && pending.state === 'NONE' ? <button type="button" className="button" disabled={busy || blocked} onClick={() => void issue()}>{busy ? '正在申请本地凭据…' : checkout ? '重新获取本地凭据' : '获取本地模拟付款凭据'}</button> : null}
      {pending.state === 'VALID' ? <button type="button" className="button secondary" disabled={busy || blocked} onClick={() => void recover()}>查询原本地凭据申请</button> : null}
      <button type="button" className="button secondary" disabled={busy || !userId} onClick={onChanged}>返回后刷新原订单</button>
    </div>
    {!compact ? <p className="order-trade-note">取得或打开凭据不代表付款已接纳；请在确认页核对原单，并返回刷新订单。后续客服与开租仍按订单流程处理。</p> : null}
  </div>;
}

export function DemoCheckoutAction({ order, blocked, onChanged, onAccepted, onModeChange, onPendingChange, children, embedded = false, expectedScope }: {
  order: Order; blocked: boolean; onChanged: () => void; onModeChange: (active: boolean) => void; onPendingChange: (pending: boolean) => void; children: ReactNode;
  embedded?: boolean; expectedScope?: "ECS_TEST_SIMULATED" | "LOCAL_DEMO_SIMULATED"; onAccepted?: () => void;
}) {
  const session = useUserSession();
  const [discovery, setDiscovery] = useState<"CHECKING" | "AVAILABLE" | "NOT_INSTALLED" | "FAILED">("CHECKING");
  const [view, setView] = useState<DemoCheckoutAvailability | null>(null), [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [retry, setRetry] = useState(0), [completed, setCompleted] = useState(false);
  const reset = useCallback(() => { setDiscovery("CHECKING"); setView(null); setNotice(null); setBusy(false); setCompleted(false); }, []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  const latest = useRef({ orderId: order.id, isCurrent, onChanged }); latest.current = { orderId: order.id, isCurrent, onChanged };
  const mounted = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [visibleOrder, setVisibleOrder] = useState(order.id);
  if (visibleOrder !== order.id) { setVisibleOrder(order.id); reset(); }
  const pending = userId ? inspectIntent(userId, "order.demo-checkout", order.id) : { state: "NONE" as const, intent: null };
  const localPending = userId ? inspectIntent(userId, "order.local-checkout", order.id) : { state: "NONE" as const, intent: null };
  const active = Boolean(userId && localPending.state !== "VALID" && (discovery !== "NOT_INSTALLED" || pending.state !== "NONE"));
  useEffect(() => { onModeChange(active); onPendingChange(active && (busy || pending.state !== "NONE")); }, [active, busy, pending.state, onModeChange, onPendingChange]);
  useEffect(() => () => { onModeChange(false); onPendingChange(false); }, [onModeChange, onPendingChange]);
  useEffect(() => {
    if (!userId) { setDiscovery("NOT_INSTALLED"); return; }
    const controller = new AbortController(), acting = userId, expected = order.id;
    setDiscovery("CHECKING"); setView(null);
    void orderApi.demoCheckoutAvailability(acting, expected, controller.signal).then(next => {
      if (!controller.signal.aborted && mounted.current && latest.current.isCurrent(acting) && latest.current.orderId === expected) {
        if (expectedScope && next.scope !== expectedScope) { setDiscovery("FAILED"); return; }
        setView(next); setDiscovery("AVAILABLE");
      }
    }).catch(error => {
      if (!controller.signal.aborted && mounted.current && latest.current.isCurrent(acting) && latest.current.orderId === expected)
        setDiscovery(error instanceof OrderRequestError && error.status === 404 ? "NOT_INSTALLED" : "FAILED");
    });
    return () => controller.abort();
  }, [userId, order.id, retry, expectedScope, embedded, pending.state]);
  const submit = async () => {
    if (!userId || busy || blocked || !view?.checkoutEnabled || pending.state !== "NONE" || !paymentEntryOpen(order)) return;
    const acting = userId, expected = order.id; setBusy(true); setNotice(null);
    const scope = view.scope;
    const outcome = await performGuardedWrite(acting, "order.demo-checkout", expected, {}, { scope }, async (key, body, context, subject) => {
      if (Object.keys(body).length || context?.scope !== scope) throw new OrderRequestError(409, null);
      const result = await orderApi.confirmDemoCheckout(subject, expected, key);
      if (result.scope !== scope) throw new OrderRequestError(502, null);
      return result;
    }, isCurrent);
    if (!mounted.current || !isCurrent(acting) || latest.current.orderId !== expected) return;
    setBusy(false);
    if (outcome.status === "ok") { setCompleted(true); setNotice("模拟付款已完成，不会真实扣款。"); onAccepted?.(); latest.current.onChanged(); }
    else if (outcome.status === "blocked") setNotice(BLOCKED_MESSAGE);
    else if (outcome.status === "unauthorized") { setNotice(AUTH_MESSAGE); void session.confirm(); }
    else if (outcome.status === "unknown" || outcome.status === "recovery-unresolved") setNotice("模拟付款结果尚未确认；请查询原请求，不要重复提交。");
    else { setNotice(panelError(outcome.error).message); latest.current.onChanged(); }
  };
  const recover = async () => {
    if (!userId || busy || blocked || pending.state !== "VALID" || !pending.intent) return;
    const acting = userId, expected = order.id, original = pending.intent; setBusy(true); setNotice(null);
    try {
      if (Object.keys(original.body).length || !["ECS_TEST_SIMULATED", "LOCAL_DEMO_SIMULATED"].includes(String(original.context?.scope))) throw new OrderRequestError(409, null);
      const result = await orderApi.demoCheckoutReceipt(acting, expected, original.key);
      if (!mounted.current || !isCurrent(acting) || latest.current.orderId !== expected) return;
      if (result.scope !== original.context?.scope) throw new OrderRequestError(502, null);
      if (result.knowledge !== "KNOWN" || !result.receipt) { setNotice("原模拟付款结果尚未确认，请稍后再次查询或联系客服。"); return; }
      clearIntent(acting, "order.demo-checkout", expected); setCompleted(true); setNotice("模拟付款已完成，不会真实扣款。"); onAccepted?.(); latest.current.onChanged();
    } catch { if (mounted.current && isCurrent(acting) && latest.current.orderId === expected) setNotice("原模拟付款结果暂时无法读取，请稍后再查询或联系客服。"); }
    finally { if (mounted.current && isCurrent(acting) && latest.current.orderId === expected) setBusy(false); }
  };
  if (!active) return children;
  if (discovery === "CHECKING" && pending.state !== "VALID") return <p className="order-muted" role="status">正在读取付款方式…</p>;
  if (discovery === "FAILED" && pending.state !== "VALID") return <div className="order-inline-notice" role="alert">付款方式暂时无法确认，请重试或联系平台。 <button type="button" className="button secondary button--sm" onClick={() => setRetry(value => value + 1)}>重试</button></div>;
  return <div className="order-local-checkout" aria-label="测试付款" aria-busy={busy || discovery === "CHECKING"}>
    {!embedded ? <><strong>测试付款</strong><p className="order-inline-notice">这是模拟付款，不会向支付机构或银行发起扣款。</p></> : null}
    {discovery === "CHECKING" ? <p role="status">正在确认本单是否可以模拟付款…</p> : null}
    {discovery === "FAILED" || discovery === "NOT_INSTALLED" ? <p role="alert">模拟付款暂时无法确认，请重试或联系平台。</p> : null}
    {discovery === "AVAILABLE" && !view?.checkoutEnabled && pending.state === "NONE" && !completed ? <p role="status">本单当前不能模拟付款，请刷新订单查看最新状态。</p> : null}
    {!embedded && discovery === "AVAILABLE" && view?.checkoutEnabled && pending.state === "NONE" ? <p role="status">请刷新订单，通过支付入口打开收银台。</p> : null}
    {pending.state === "UNREADABLE" ? <p role="alert">原请求记录无法读取，请保留本页并联系客服核对。</p> : notice ? <p role="status">{notice}</p> : null}
    <div className="order-trade-actions">
      {embedded && view?.checkoutEnabled && pending.state === "NONE" && !completed && paymentEntryOpen(order) ? <button type="button" className="button" disabled={busy || blocked} onClick={() => void submit()}>{busy ? "处理中…" : "模拟付款"}</button> : null}
      {pending.state === "VALID" ? <button type="button" className="button secondary" disabled={busy || blocked} onClick={() => void recover()}>查询原付款结果</button> : null}
      {discovery === "FAILED" ? <button type="button" className="button secondary" disabled={busy} onClick={() => setRetry(value => value + 1)}>重试</button> : null}
    </div>
  </div>;
}

export function PaymentAction({ order, party, onChanged, onPaymentFacts, onAccepted, onCancelled, embedded = false }: { order: Order; party: OrderParty; onChanged: () => void; onPaymentFacts?: (facts: OrderPaymentFacts | null) => void; onAccepted?: () => void; onCancelled?: () => void; embedded?: boolean }) {
  const session = useUserSession();
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [error, setError] = useState<PanelError | null>(null);
  const [receipt, setReceipt] = useState<{ disposition: string; reasonCode?: string | null; replay: boolean } | null>(null);
  const [cancelDialogOpen, setCancelDialogOpen] = useState(false);
  const cancelButtonRef = useRef<HTMLButtonElement | null>(null);
  const [cancelUnknown, setCancelUnknown] = useState<string | null>(null);
  const [channelMode, setChannelMode] = useState(false), [channelPending, setChannelPending] = useState(false);
  const [localMode, setLocalMode] = useState(false), [localPending, setLocalPending] = useState(false);
  const [demoMode, setDemoMode] = useState(false), [demoPending, setDemoPending] = useState(false);
  const autoOpenedGroup = useRef(false);
  useEffect(() => {
    if (party !== "renter" || receipt?.disposition !== "APPLIED" || autoOpenedGroup.current) return;
    autoOpenedGroup.current = true;
    const key = `zzsh:order-group-autopen:${order.id}`;
    try { if (window.sessionStorage.getItem(key)) return; window.sessionStorage.setItem(key, "1"); } catch { /* sessionStorage is optional */ }
    window.dispatchEvent(new CustomEvent("zzsh:order-groups", { detail: { party: "renter", orderId: order.id } }));
  }, [order.id, party, receipt]);
  const reset = useCallback(() => { setBusy(false); setUnknown(null); setError(null); setReceipt(null); setCancelDialogOpen(false); setCancelUnknown(null); }, []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  useEffect(() => {
    if (!userId) return;
    const payment = loadIntent(userId, "order.payment", order.id);
    if (payment) setUnknown(isIntentStale(payment) ? STALE_MESSAGE : "检测到本订单有一笔结果未知的支付请求；原申请已保留，请勿重复提交。");
    const cancel = loadIntent(userId, "order.cancel", order.id);
    if (cancel) setCancelUnknown(isIntentStale(cancel) ? STALE_MESSAGE : "检测到本订单有一笔结果未知的取消请求；原申请已保留，请勿重复提交。");
  }, [userId, order.id]);
  const applyOutcome = (acting: string, outcome: WriteOutcome<{ payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } }>, kind: "pay" | "cancel") => {
    const fail = (typed: OrderRequestError) => {
      setError(panelError(typed));
      if (typed.status === 401 || typed.code === "UNAUTHENTICATED") void session.confirm();
    };
    if (outcome.status === "ok") {
      if (kind === "pay") {
        setReceipt(outcome.value.payment);
        if (outcome.value.payment.disposition === "APPLIED") { onAccepted?.(); onChanged(); }
      } else { setCancelDialogOpen(false); onCancelled?.(); onChanged(); }
      return;
    }
    if (outcome.status === "unknown") { kind === "pay" ? setUnknown(outcome.message) : setCancelUnknown(outcome.message); return; }
    if (outcome.status === "blocked") { setError({ message: BLOCKED_MESSAGE, retryable: false }); return; }
    if (outcome.status === "unauthorized") { fail(outcome.error); return; }
    if (outcome.status === "recovery-unresolved") { void resolveRecovery(acting, outcome.error, kind); return; }
    fail(outcome.error);
    onChanged();
  };
  /** A read can only describe the observed state; only the original-key receipt may release the lock. */
  const resolveRecovery = async (acting: string, typed: OrderRequestError, kind: "pay" | "cancel") => {
    const label = kind === "pay" ? "支付" : "取消";
    try {
      const authority = await orderApi.paymentStatus(acting, order.id);
      if (!isCurrent(acting)) return;
      const observed = paymentObservation(authority.payment);
      const message = `原${label}请求仍未取得确定回执（原申请保留）。${observed}；当前页面状态不能确定这笔申请是否生效，请稍后再次查询或联系客服核对。`;
      if (kind === "pay") setUnknown(message); else setCancelUnknown(message);
    } catch {
      if (isCurrent(acting)) {
        const message = `原${label}请求仍未取得确定回执；最新处理状态暂时无法读取（${typed.message || "读取失败"}）。原请求保留，请稍后再次查询。`;
        if (kind === "pay") setUnknown(message); else setCancelUnknown(message);
      }
    }
  };
  const pay = async () => {
    if (!userId) return;
    const acting = userId;
    setBusy(true); setError(null); setUnknown(null);
    const outcome = await performGuardedWrite(acting, "order.payment", order.id, {}, undefined,
      (_key, _body, _context, subject) => orderApi.pay(subject, order.id, _key), isCurrent);
    if (!isCurrent(acting)) return;
    setBusy(false);
    applyOutcome(acting, outcome as WriteOutcome<{ payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } }>, "pay");
  };
  const queryPayment = async () => {
    if (!userId) return;
    const acting = userId;
    if (!loadIntent(acting, "order.payment", order.id)) { setUnknown(null); onChanged(); return; }
    setBusy(true);
    const outcome = await performGuardedWrite(acting, "order.payment", order.id, {}, undefined,
      (key, _body, _context, subject) => orderApi.pay(subject, order.id, key), isCurrent);
    if (!isCurrent(acting)) return;
    setBusy(false);
    applyOutcome(acting, outcome as WriteOutcome<{ payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } }>, "pay");
  };
  const cancel = async () => {
    if (!userId) return;
    const acting = userId;
    setBusy(true); setError(null); setCancelUnknown(null);
    const outcome = await performGuardedWrite(acting, "order.cancel", order.id, {}, undefined,
      (key, body, _context, subject) => orderApi.cancel(subject, order.id, key, typeof body.reason === "string" ? body.reason : undefined), isCurrent);
    if (!isCurrent(acting)) return;
    setBusy(false);
    setCancelDialogOpen(false);
    applyOutcome(acting, outcome as WriteOutcome<{ payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } }>, "cancel");
  };
  const queryCancel = async () => {
    if (!userId) return;
    const acting = userId;
    if (!loadIntent(acting, "order.cancel", order.id)) { setCancelUnknown(null); onChanged(); return; }
    setBusy(true);
    const outcome = await performGuardedWrite(acting, "order.cancel", order.id, {}, undefined,
      (key, body, _context, subject) => orderApi.cancel(subject, order.id, key, typeof body.reason === "string" ? body.reason : undefined), isCurrent);
    if (!isCurrent(acting)) return;
    setBusy(false);
    applyOutcome(acting, outcome as WriteOutcome<{ payment: { confirmationId: string; disposition: string; reasonCode?: string | null; replay: boolean } }>, "cancel");
  };
  const payLocked = busy || receipt !== null || unknown !== null || cancelUnknown !== null;
  const cancelLocked = busy || receipt !== null || unknown !== null || cancelUnknown !== null || channelPending || localPending || demoPending;
  const paymentOpen = paymentEntryOpen(order);
  const cancelOpen = cancelEntryOpen(order);
  const expired = order.status === "PENDING_PAYMENT" && order.expiredAwaitingCancel === true;
  return <section className={embedded ? "order-payment-embedded" : "order-detail-section order-trade-panel"} id={embedded ? undefined : "order-trade-actions"} aria-label="支付与取消">
    {!embedded ? <div className="order-trade-heading"><h2 className="order-section-title">支付与取消</h2></div> : null}
    {receipt?.disposition === "APPLIED" ? <div className="order-notice is-success" role="status"><CheckCircle2 size={17} aria-hidden="true" /><div><strong>支付已接纳{receipt.replay ? "（原回执重放）" : ""}</strong><span>订单状态以服务端记录为准；支付不等于交付、建群或开租。</span></div></div> : null}
    {!embedded && order.status === "PENDING_PAYMENT" && order.holdUntil ? <p className="order-trade-deadline">{expired ? "原支付保留截止" : "支付保留至"} {formatOrderTime(order.holdUntil)}；到期后是否取消以服务端订单状态为准。</p> : null}
    {expired ? <div className="order-notice is-warning" role="status"><Clock3 size={17} aria-hidden="true" /><div><strong>已到期，取消处理中</strong><span>占用时间以订单记录为准；系统正在按序释放该账号，不再接受新的支付。</span></div></div> : null}
    {party === "renter" && !embedded ? <p className="order-muted">付款或取消后，请先确认处理结果。结果尚未确认时，请查询原申请，不要重复操作；确认前暂不能付款或取消。</p> : null}
    {receipt?.disposition === "REVIEW_REQUIRED" ? <div className="order-notice is-warning" role="status"><AlertCircle size={17} aria-hidden="true" /><div><strong>支付结果需要人工核对</strong><span>原因：{receipt.reasonCode ?? "未记录"}。未重复扣款；不再新发起支付，等待平台核对。</span></div></div> : null}
    {unknown ? <UnknownNotice label="支付结果未知" message={unknown} onQuery={() => void queryPayment()} onOpenOrder={onChanged} /> : null}
    {cancelUnknown ? <UnknownNotice label="取消结果未知" message={cancelUnknown} onQuery={() => void queryCancel()} onOpenOrder={onChanged} /> : null}
    {error ? <p className="order-inline-notice" role="alert">{error.message}</p> : null}
    {party === "renter" ? <div className="order-trade-actions">
      <ChannelPaymentAction order={order} blocked={payLocked || cancelDialogOpen || demoPending} onChanged={onChanged} onModeChange={setChannelMode} onPendingChange={setChannelPending} onPaymentFacts={onPaymentFacts} compact={embedded}><DemoCheckoutAction order={order} blocked={payLocked || cancelDialogOpen} onChanged={onChanged} onModeChange={setDemoMode} onPendingChange={setDemoPending} embedded={embedded}><LocalSandboxPaymentAction order={order} blocked={payLocked || cancelDialogOpen} onChanged={onChanged} onModeChange={setLocalMode} onPendingChange={setLocalPending} compact={embedded}>{paymentOpen ? <button type="button" className="button primary" onClick={() => void pay()} disabled={payLocked}>
        <WalletCards size={15} aria-hidden="true" />{busy ? "提交支付请求…" : "提交支付（本地测试支付）"}
      </button> : <p className="order-muted">当前订单不可继续支付；请刷新查看最新订单记录。</p>}</LocalSandboxPaymentAction></DemoCheckoutAction></ChannelPaymentAction>
      {cancelOpen ? <button ref={cancelButtonRef} type="button" className="button quiet" onClick={() => { setError(null); setCancelDialogOpen(true); }} disabled={cancelLocked}>取消订单</button> : null}
    </div> : <p className="order-muted">等待租客完成支付；订单不提供代付或代为接单操作。</p>}
    {!channelMode && !localMode && !demoMode && !embedded ? <p className="order-trade-note">当前为本地测试支付入口，测试付款记录不代表支付渠道已扣款。</p> : null}
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
  </section>;
}

function OpeningLines({ order, opening, heading }: { order: Order; opening: SettlementOpening; heading: string }) {
  return <table className="order-trade-lines"><thead><tr><th scope="col">资源</th><th scope="col">{heading}</th></tr></thead>
    <tbody>{opening.lines.map((line) => <tr key={line.itemId}>
      <td>{resourceName(order, line.itemId)}<span className="order-trade-unit">{unitHint(resourceName(order, line.itemId), line.unit)}</span></td>
      <td>{quantityText(line.unit, line.quantity ?? "0")}</td>
    </tr>)}</tbody></table>;
}

function OpeningPanel({ opening, order, party, onChanged, readOnly = false }: { opening: SettlementOpening; order: Order; party: OrderParty; onChanged: () => void; readOnly?: boolean }) {
  const session = useUserSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PanelError | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const reset = useCallback(() => { setBusy(false); setError(null); setUnknown(null); }, []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  useEffect(() => {
    if (!userId) return;
    const intent = loadIntent(userId, "opening.confirm", order.id);
    if (intent) setUnknown(isIntentStale(intent) ? STALE_MESSAGE : "检测到一条结果未知的期初确认；原申请已保留，请勿重复提交。");
  }, [userId, order.id]);
  const myParty = party.toUpperCase();
  const acks = opening.acks ?? [];
  const myAck = acks.find((ack) => ack.party === myParty), otherAck = acks.find((ack) => ack.party !== myParty);
  const acked = Boolean(myAck), otherAcked = Boolean(otherAck);
  const confirmed = opening.status === "CONFIRMED";
  const ackText = (ack: typeof myAck, own: boolean) => !ack ? "" : ack.source === "PARTY" ? `${own ? "你" : partyLabel(ack.party)}已确认`
    : ack.source === "ON_BEHALF" ? `客服已协助${own ? "你" : partyLabel(ack.party)}确认`
    : ack.source === "AUTO" ? `${own ? "你的" : partyLabel(ack.party) + "的"}期初已自动确认` : `${own ? "你的" : partyLabel(ack.party) + "的"}确认已记录`;
  const bothPartyConfirmed = acked && otherAcked && acks.every(ack => ack.source === "PARTY");
  const tag = confirmed || acked && otherAcked ? bothPartyConfirmed ? "双方已确认" : "期初已确认" : acked ? `${ackText(myAck, true)} · 对方未记录` : otherAcked ? `${ackText(otherAck, false)} · 你未记录` : "待双方确认";
  const apply = (acting: string, outcome: WriteOutcome<OrderSettlement>) => {
    if (outcome.status === "ok") { onChanged(); return; }
    if (outcome.status === "unknown") { setUnknown(outcome.message); return; }
    if (outcome.status === "blocked") { setError({ message: BLOCKED_MESSAGE, retryable: false }); return; }
    if (outcome.status === "unauthorized") { setError(panelError(outcome.error)); void session.confirm(); return; }
    if (outcome.status === "recovery-unresolved") { void resolveRecovery(acting); return; }
    setError(panelError(outcome.error));
    onChanged();
  };
  /** Only a receipt on the original opening/version may release the lock; a projection only observes. */
  const resolveRecovery = async (acting: string) => {
    const intent = loadIntent(acting, "opening.confirm", order.id);
    const targetId = typeof intent?.context?.openingId === "string" ? intent.context.openingId : "";
    const targetVersion = Number(intent?.body?.versionNo ?? 0);
    if (!targetId || !Number.isInteger(targetVersion) || targetVersion < 1) {
      setUnknown("原请求缺少目标期初标识或版本，不能按当前页面对象恢复；原请求保留，请人工核对或联系客服。");
      return;
    }
    try {
      const authority = await orderApi.settlement(acting, order.id);
      if (!isCurrent(acting)) return;
      const target = authority.openings.find((candidate) => candidate.id === targetId);
      const originalPartyAck = target?.acks?.some((ack) => ack.party === myParty && ack.source === "PARTY") ?? false;
      if (target && originalPartyAck) {
        clearIntent(acting, "opening.confirm", order.id);
        setUnknown(null);
        setError({ message: target.status === "CONFIRMED" ? "服务端已记录你的期初确认，期初已生效。" : "服务端已记录你的期初确认，等待对方确认。", retryable: false });
        onChanged();
        return;
      }
      const observed = target ? `原目标期初${target.status === "CONFIRMED" ? "已确认" : target.status === "DRAFT" ? "未记录" : "状态未确认"}` : "未在原结算记录中找到该期初版本";
      setUnknown(`原开租确认申请仍未取得确定回执（原申请保留）。${observed}；当前页面状态不能确定这笔申请是否生效，请稍后再次查询或联系客服核对。`);
    } catch {
      if (isCurrent(acting)) setUnknown("原开租确认申请仍未取得确定回执；最新结算状态暂时无法读取。原请求保留，请稍后再次查询。");
    }
  };
  const confirm = async () => {
    if (!userId) return;
    const acting = userId;
    const pending = inspectIntent(acting, "opening.confirm", order.id);
    if (pending.state === "UNREADABLE") { setError({ message: "原开租确认记录无法读取，请联系客服核对。", retryable: false }); return; }
    if (pending.intent) { setUnknown(isIntentStale(pending.intent) ? STALE_MESSAGE : "检测到未完成的开租确认，请先查询原请求。"); return; }
    setBusy(true); setError(null); setUnknown(null);
    const outcome = await performGuardedWrite(acting, "opening.confirm", order.id, { versionNo: Number(opening.versionNo) },
      { openingId: opening.id, orderId: order.id },
      (key, body, frozenContext, subject) => orderApi.confirmOpening(subject, order.id, String(frozenContext?.openingId ?? ""), Number(body.versionNo), key), isCurrent);
    if (!isCurrent(acting)) return;
    setBusy(false);
    apply(acting, outcome as WriteOutcome<OrderSettlement>);
  };
  const query = async () => {
    if (!userId) return;
    const acting = userId;
    const intent = loadIntent(acting, "opening.confirm", order.id);
    if (!intent) { setUnknown(null); onChanged(); return; }
    const targetId = typeof intent.context?.openingId === "string" ? intent.context.openingId : "";
    if (!targetId) {
      setUnknown("原请求缺少目标期初标识，不能按当前页面对象恢复；原请求保留，请人工核对或联系客服。");
      return;
    }
    setBusy(true);
    const outcome = await performGuardedWrite(acting, "opening.confirm", order.id, { versionNo: Number(opening.versionNo) },
      { openingId: opening.id, orderId: order.id },
      (key, body, frozenContext, subject) => orderApi.confirmOpening(subject, order.id, String(frozenContext?.openingId ?? ""), Number(body.versionNo), key), isCurrent);
    if (!isCurrent(acting)) return;
    setBusy(false);
    apply(acting, outcome as WriteOutcome<OrderSettlement>);
  };
  return <div className="order-trade-block">
    <h3>{confirmed ? "已确认期初库存" : "期初库存确认"} <span className="order-trade-tag">第{opening.versionNo}版</span> <span className="order-trade-tag is-accent">{tag}</span></h3>
    <p className="order-muted">{confirmed ? "以下为已生效的开租库存，确认方式见下方记录；开租后按结算记录核对消耗。" : "期初数量取自本单冻结报价；请双方核对同一版本，资料异常时联系客服处理。付款、建群与沟通都不等于已开租。"}</p>
    <OpeningLines order={order} opening={opening} heading={confirmed ? "开租时数量" : "期初数量"} />
    {unknown ? <UnknownNotice label="期初确认结果未知" message={unknown} onQuery={() => void query()} onOpenOrder={onChanged} /> : null}
    {error ? <p className="order-inline-notice" role="alert">{error.message}</p> : null}
    {!readOnly && !confirmed && !acked && !unknown ? <button type="button" className="button primary" onClick={() => void confirm()} disabled={busy}>{busy ? "确认中…" : "确认期初并开租"}</button> : null}
    {readOnly && !confirmed && !acked && !unknown ? <p className="order-muted">订单主状态已完成，本页不再提供新的期初确认；如有一笔结果未知的申请，请用下方「查询原请求」按原键核对。</p> : null}
    {!confirmed && acked ? <p className="order-muted"><Clock3 size={14} aria-hidden="true" /> {ackText(myAck, true)}；等待对方确认后正式开租。</p> : null}
    {!confirmed && opening.status === "DRAFT" && opening.autoConfirmDueAt && Number.isFinite(Date.parse(opening.autoConfirmDueAt)) ? <p className="order-muted">双方未确认时，将于 {formatOrderTime(opening.autoConfirmDueAt)} 自动确认并开始租期。</p> : null}
    <RecordList title="确认记录" records={acks.map((ack) => ({ label: ack.source === "PARTY" ? `${partyLabel(ack.party)}确认期初` : ack.source === "ON_BEHALF" ? `客服协助${partyLabel(ack.party)}确认期初` : ack.source === "AUTO" ? `${partyLabel(ack.party)}期初自动确认` : `${partyLabel(ack.party)}期初确认已记录`, time: ack.createdAt ?? null }))} />
    {opening.confirmedAt ? <p className="order-muted">开租时间：{formatOrderTime(opening.confirmedAt)}</p> : null}
  </div>;
}

function settlementDecisionLabel(action:string):string{return action==="CONFIRM"?"已确认":action==="REJECT"?"已拒绝":action==="REVIEW"?"已复核":action==="FINALIZE"?"已确认结算":"状态待核";}

function ConsumedTable({ order, lines, values, actual, consumed }: { order: Order; lines: SettlementLine[]; values: Record<string, string>; actual: boolean; consumed?: { haff?: unknown; items?: Array<{ itemId: string; consumed: string; remaining: string }> } | null }) {
  return <table className="order-trade-lines"><thead><tr><th scope="col">资源</th><th scope="col">期初</th><th scope="col">期末剩余</th><th scope="col">本次实耗</th></tr></thead>
    <tbody>{lines.map((line) => {
      const open = line.quantity ?? "0";
      const value = values[line.itemId] ?? "";
      const valid = /^\d+$/.test(value);
      const rest = valid && actual ? (BigInt(value)<BigInt(open)?BigInt(open)-BigInt(value):0n).toString() : value;
      const derived = valid && actual ? value : valid && BigInt(rest) <= BigInt(open) ? (BigInt(open) - BigInt(rest)).toString() : null;
      const serverLine = consumed?.items?.find((item) => item.itemId === line.itemId);
      const used = line.pricingKind === "HAFF_RATIO" && consumed?.haff !== undefined && consumed.haff !== null
        ? String(consumed.haff)
        : serverLine?.consumed ?? derived;
      const name=line.name??resourceName(order,line.itemId);
      return <tr key={line.itemId}>
        <td>{name}<span className="order-trade-unit">{unitHint(name, line.unit)}</span></td>
        <td>{quantityText(line.unit, open)}</td>
        <td>{rest === "" ? "未记录" : quantityText(line.unit, rest)}</td>
        <td>{used === null || used === undefined ? "未记录" : quantityText(line.unit, used)}</td>
      </tr>;
    })}</tbody></table>;
}

function ConsumptionTable({ order, opening, version, extraResources }: { order: Order; opening: SettlementOpening | null; version: SettlementVersion | null | undefined; extraResources?:SettlementLine[] }) {
  const rows = consumptionRows(order, opening, version, extraResources);
  if (rows.length === 0) return null;
  return <table className="order-trade-lines"><thead><tr><th scope="col">资源</th><th scope="col">期初</th><th scope="col">期末剩余</th><th scope="col">实际消耗</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.itemId}>
      <td>{row.name}<span className="order-trade-unit">{unitHint(row.name, row.unit)}</span></td>
      <td>{row.opening === null ? "未记录" : quantityText(row.unit, row.opening)}</td>
      <td>{row.remaining === null ? "未记录" : quantityText(row.unit, row.remaining)}</td>
      <td>{row.consumed === null ? "未记录" : quantityText(row.unit, row.consumed)}</td>
    </tr>)}</tbody></table>;
}

function EarlyTermsConsent({ disclosure, accepted, onChange, disabled, label }: {
  disclosure?: EarlySettlementDisclosure; accepted: boolean; onChange: (accepted: boolean) => void; disabled: boolean; label: string;
}) {
  const [readDigest, setReadDigest] = useState<string | null>(null);
  if (!disclosure) return <p className="order-inline-notice" role="alert">本单提前结算告知暂时无法核验。请刷新后重试。</p>;
  const readable = !disclosure.bodyDocument || readDigest === disclosure.digest;
  return <>
    <TradeTermsDocument body={disclosure.body} document={disclosure.bodyDocument} target={disclosure.digest} onReady={setReadDigest} />
    <label className="order-trade-consent"><input type="checkbox" checked={accepted && readable} disabled={disabled || !readable}
      onChange={event => onChange(event.target.checked)} /><span>{label}</span></label>
  </>;
}

function boundEarlyDisclosure(order: Order, disclosure?: EarlySettlementDisclosure): EarlySettlementDisclosure | undefined {
  const ref = order.earlySettlementDisclosure;
  if (!ref) return undefined;
  if (disclosure?.versionId === ref.versionId && disclosure.digest === ref.digest) return disclosure;
  if (!disclosure && ref.body !== undefined) return { ...ref, body: ref.body };
  return undefined;
}

function EndingForm({ opening, order, party, onChanged, consumptionMode, extraResources=[], readOnly = false }: { opening: SettlementOpening; order: Order; party: OrderParty; onChanged: () => void; consumptionMode?: OrderSettlement["consumptionMode"]; extraResources?: SettlementLine[]; readOnly?: boolean }) {
  const session = useUserSession();
  const actual=consumptionMode==="ACTUAL";
  const extra=actual?extraResources.filter(line=>!opening.lines.some(item=>item.itemId===line.itemId)).map(line=>({...line,quantity:"0"})):[];
  const lines=[...opening.lines,...extra];
  const extraKey=extra.map(line=>line.itemId).join("|");
  const initialValues=()=>Object.fromEntries(lines.map(line=>[line.itemId,extra.some(item=>item.itemId===line.itemId)?"0":""]));
  // The ending quantities are the user's own input: they start empty so that "unknown" is never
  // silently submitted as the opening quantity (i.e. as zero consumption).
  const [raw, setRaw] = useState<Record<string, string>>(initialValues);
  const [expanded, setExpanded] = useState(false);
  const [checked, setChecked] = useState<{ lines: SettlementQuantityInput[]; versionHash: string; snapshot: string; preview: SettlementPreview } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const revision = useRef(0);
  const reset = useCallback(() => { setChecked(null); setError(null); setBusy(false); setUnknown(null); setTermsAccepted(false); }, []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  useEffect(() => {
    revision.current += 1;
    setChecked(null);
    setError(null);
    setTermsAccepted(false);
    setRaw(initialValues());
  }, [opening.id, opening.versionNo, order.id, order.status, actual, extraKey]);
  useEffect(() => { setTermsAccepted(false); }, [checked?.versionHash]);
  useEffect(() => {
    if (!userId) return;
    const intent = loadIntent(userId, "settlement.submit", order.id);
    if (intent) {
      setUnknown(isIntentStale(intent) ? STALE_MESSAGE : "检测到一条结果未知的结束提交；原申请内容已保留，请勿重复提交。");
      setExpanded(true);
    }
  }, [userId, order.id]);
  const locked = unknown !== null;
  const open = expanded || locked || checked !== null;
  const update = (itemId: string, value: string) => {
    if (locked) return;
    revision.current += 1;
    setChecked(null);
    setError(null);
    setBusy(false);
    setRaw((current) => ({ ...current, [itemId]: value }));
  };
  const validate = (): { lines?: SettlementQuantityInput[]; error?: string } => {
    const selected: SettlementQuantityInput[] = [];
    for (const line of lines) {
      const value = (raw[line.itemId] ?? "").trim();
      const name = line.name??resourceName(order, line.itemId);
      const label=actual?"实际消耗数量":"期末剩余数量";
      if (value === "") return { error: `请填写「${name}」的${label}；留空表示未知，不能按 0 处理。` };
      if (!/^(0|[1-9]\d{0,18})$/.test(value)) return { error: `「${name}」的${label}必须是 0 或正整数。` };
      if (!actual&&BigInt(value) > BigInt(line.quantity ?? "0")) return { error: `「${name}」的期末数量不能大于期初数量（${line.quantity}）；异常数量请联系客服核实。` };
      selected.push(actual?{itemId:line.itemId,consumedQuantity:value}:{itemId:line.itemId,remainingQuantity:value});
    }
    return { lines:selected };
  };
  const runPreview = async () => {
    if (locked || !userId) return;
    const result = validate();
    if (result.error || !result.lines) { setChecked(null); setError(result.error ?? "数量无效"); return; }
    const sequence = ++revision.current;
    setBusy(true);
    setError(null);
    try {
      const preview = await orderApi.settlementPreview(userId, order.id, { lines: result.lines });
      if (sequence !== revision.current) return;
      if (!preview.versionHash || (preview.reasons ?? []).some((reason) => reason !== "EARLY_REASON_REQUIRED")) {
        setError(settlementPreviewProblem(preview.reasons));
        return;
      }
      setChecked({ lines: result.lines, versionHash: preview.versionHash, snapshot: JSON.stringify(result.lines), preview });
    } catch (caught) {
      if (sequence === revision.current) setError(panelError(caught).message);
    } finally {
      if (sequence === revision.current) setBusy(false);
    }
  };
  const apply = (acting: string, outcome: WriteOutcome<OrderSettlement>) => {
    if (outcome.status === "ok") { setChecked(null); onChanged(); return; }
    if (outcome.status === "unknown") { setUnknown(outcome.message); return; }
    if (outcome.status === "blocked") { setError(BLOCKED_MESSAGE); return; }
    if (outcome.status === "unauthorized") { setError(panelError(outcome.error).message); void session.confirm(); return; }
    if (outcome.status === "recovery-unresolved") { void resolveRecovery(acting); return; }
    setChecked(null);
    setError(panelError(outcome.error).message);
    onChanged();
  };
  /**
   * No projection entry can be bound to the original submission (the receipt hash is not part of
   * the projection), so equal content is never treated as the same request: only the original-key
   * replay may release the lock; everything read here is observation only.
   */
  const resolveRecovery = async (acting: string) => {
    try {
      const authority = await orderApi.settlement(acting, order.id);
      if (!isCurrent(acting)) return;
      const observed = authority.currentRequest
        ? authority.currentRequest.kind === "INTAKE" ? "当前有结束申请，状态未确认" : authority.currentRequest.kind === "SETTLEMENT_VERSION" ? "当前有结算方案" : "当前申请状态未记录"
        : authority.settlement
          ? `当前结算版本 ${authority.settlement.versionNo}`
          : "当前没有可读的申请或结算版本";
      setUnknown(`原结束提交仍未取得确定回执（原申请保留）。${observed}；当前页面状态不能确定这笔申请是否生效，请稍后再次查询或联系客服核对。`);
    } catch {
      if (isCurrent(acting)) setUnknown("原结束提交仍未取得确定回执；最新结算状态暂时无法读取。原请求保留，请稍后再次查询。");
    }
  };
  const submit = async () => {
    if (!userId || locked) return;
    const acting = userId;
    const result = validate();
    if (result.error || !result.lines) { setChecked(null); setError(result.error ?? "数量无效"); return; }
    if (!checked || JSON.stringify(result.lines) !== checked.snapshot) { setChecked(null); setError("数量已修改或尚未预览，请重新预览后再提交。"); return; }
    const early = checked.preview.reasons?.includes("EARLY_REASON_REQUIRED") === true;
    if (early && order.earlySettlementDisclosure && (!earlyDisclosure || !termsAccepted)) { setError("请阅读并同意本单提前结束规则后再提交。"); return; }
    setBusy(true);
    setError(null);
    const outcome = await performGuardedWrite(acting, "settlement.submit", order.id,
      { lines: checked.lines, acceptedHash: checked.versionHash, ...(early && order.earlySettlementDisclosure ? { termsAccepted: true } : {}) },
      { openingId: opening.id, openingVersion: opening.versionNo },
      (key, body, _context, subject) => orderApi.submitSettlement(subject, order.id, body as { lines: SettlementQuantityInput[]; acceptedHash: string; termsAccepted?: boolean }, key), isCurrent);
    if (!isCurrent(acting)) return;
    setBusy(false);
    apply(acting, outcome as WriteOutcome<OrderSettlement>);
  };
  const querySubmit = async () => {
    if (!userId) return;
    const acting = userId;
    if (!loadIntent(acting, "settlement.submit", order.id)) { setUnknown(null); onChanged(); return; }
    setBusy(true);
    const outcome = await performGuardedWrite(acting, "settlement.submit", order.id, {}, undefined,
      (key, body, _context, subject) => orderApi.submitSettlement(subject, order.id, body as { lines: SettlementQuantityInput[]; acceptedHash: string }, key), isCurrent);
    if (!isCurrent(acting)) return;
    setBusy(false);
    apply(acting, outcome as WriteOutcome<OrderSettlement>);
  };
  const earlyDisclosure = boundEarlyDisclosure(order, checked?.preview.earlySettlementDisclosure);
  const amounts = settlementAmountRows(party, previewAmounts(checked?.preview ?? null));
  if(consumptionMode==="UNAVAILABLE")return <div className="order-trade-block"><h3>发起结束租用</h3><p className="order-inline-notice" role="alert">本单结算价格资料暂不可用，请联系客服核实。</p></div>;
  if (!open) return <div className="order-trade-block">
    <h3>发起结束租用</h3>
    <p className="order-muted">{actual?"填写实际消耗数量，先预览结算金额，再确认提交。":"填写归还时的剩余数量，先预览结算金额，再确认提交。留空或负数不会被当作 0。"}</p>
    {readOnly ? <p className="order-muted">订单主状态已完成，本页不再提供新的结束租用或结算申请；如有一笔结果未知的申请，请用下方「查询原请求」按原键核对。</p>
      : <div className="order-trade-actions"><button type="button" className="button primary" onClick={() => setExpanded(true)}>发起结束租用</button></div>}
  </div>;
  return <div className="order-trade-block">
    <div className="order-trade-heading"><h3>发起结束租用</h3>{!locked && checked === null ? <button type="button" className="button quiet button--sm" onClick={() => setExpanded(false)} disabled={busy}>收起</button> : null}</div>
    <p className="order-muted">{actual?"按实际使用量填写；超出期初的部分按本单价格与会员规则计算。未在期初申报的物资默认 0，请核对后修改。":"填写归还时账号内的剩余库存。留空不会被当作 0。"}</p>
    <table className="order-trade-lines order-trade-input"><thead><tr><th scope="col">资源</th><th scope="col">期初数量</th><th scope="col">{actual?"实际消耗":"期末剩余"}</th></tr></thead>
      <tbody>{lines.map((line) => <tr key={line.itemId}>
        <td>{line.name??resourceName(order, line.itemId)}<span className="order-trade-unit">{unitHint(line.name??resourceName(order, line.itemId), line.unit)}</span></td>
        <td>{quantityText(line.unit, line.quantity ?? "0")}</td>
        <td><input type="text" inputMode="numeric" autoComplete="off" value={raw[line.itemId] ?? ""} placeholder="填写整数" disabled={locked || busy || readOnly} aria-label={`${line.name??resourceName(order, line.itemId)} ${actual?"实际消耗":"期末剩余"}数量`} aria-invalid={error ? true : undefined} onChange={(event) => update(line.itemId, event.target.value)} /></td>
      </tr>)}</tbody></table>
    {error ? <p className="order-inline-notice" role="alert">{error}</p> : null}
    {unknown ? <UnknownNotice label="结束提交结果未知" message={unknown} onQuery={() => void querySubmit()} onOpenOrder={onChanged} /> : null}
    {checked && !locked ? <div className="order-trade-preview">
      <p className="order-muted">{checked.preview.reasons?.includes("EARLY_REASON_REQUIRED") ? "本次消耗低于 70%，属于提前结束。提交后客服会核实原因并生成结算方案，请按方案核对费用和退款安排。" : "消耗比例满足正常结算条件：对方确认后自动生效，无需客服审核。"}</p>
      {checked.preview.reasons?.includes("EARLY_REASON_REQUIRED") && order.earlySettlementDisclosure ? <EarlyTermsConsent key={checked.versionHash} disclosure={earlyDisclosure} accepted={termsAccepted} onChange={setTermsAccepted} disabled={busy} label="我已阅读并同意上述提前结束规则，具体金额以结算方案为准" /> : null}
      <ConsumedTable order={order} lines={lines} values={Object.fromEntries(checked.lines.map((line) => [line.itemId,"consumedQuantity" in line?line.consumedQuantity:line.remainingQuantity]))} actual={actual} consumed={checked.preview.consumed} />
      <AmountTable rows={amounts} caption={`本版结算金额明细（${party === "renter" ? "租客口径" : "号主口径"}，服务端计算）`} />
      {readOnly ? <p className="order-muted">订单主状态已完成，本页不再提交新的结算申请；下方金额仅为已读到的预览记录。</p> : <div className="order-trade-actions">
        <button type="button" className="button primary" onClick={() => void submit()} disabled={busy || (checked.preview.reasons?.includes("EARLY_REASON_REQUIRED") && Boolean(order.earlySettlementDisclosure) && (!earlyDisclosure || !termsAccepted))}>{busy ? "提交中…" : checked.preview.reasons?.includes("EARLY_REASON_REQUIRED") ? "提交结束申请" : "提交结算"}</button>
        <button type="button" className="button quiet" onClick={() => setChecked(null)} disabled={busy}>修改数量</button>
      </div>}
    </div> : (!locked && !readOnly ? <div className="order-trade-actions">
      <button type="button" className="button primary" onClick={() => void runPreview()} disabled={busy}>{busy ? "计算中…" : "预览结算金额"}</button>
    </div> : null)}
  </div>;
}

function DecisionPanel({ version, party, order, disclosure, onChanged, readOnly = false, feeReconfirmationRequired = false }: { version: SettlementVersion; party: OrderParty; order: Order; disclosure?: EarlySettlementDisclosure; onChanged: () => void; readOnly?: boolean; feeReconfirmationRequired?: boolean }) {
  const session = useUserSession();
  const [busy, setBusy] = useState<"CONFIRM" | "REJECT" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [unknown, setUnknown] = useState<string | null>(null);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [termsAccepted, setTermsAccepted] = useState(false);
  const reset = useCallback(() => { setBusy(null); setError(null); setUnknown(null); setRejectOpen(false); setReason(""); setTermsAccepted(false); }, []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  useEffect(() => {
    if (!userId) return;
    const intent = loadIntent(userId, "settlement.decision", order.id);
    if (intent) setUnknown(isIntentStale(intent) ? STALE_MESSAGE : "检测到一条结果未知的结算决定；原申请内容已保留，请勿重复提交。");
  }, [userId, order.id]);
  useEffect(() => { setTermsAccepted(false); }, [version.id, version.versionHash, disclosure?.digest]);
  const earlyDisclosure = boundEarlyDisclosure(order, disclosure);
  const myParty = party.toUpperCase();
  const decided = (version.decisions ?? []).find((decision) => decision.party === myParty);
  const locked = unknown !== null;
  const apply = (acting: string, outcome: WriteOutcome<OrderSettlement>) => {
    if (outcome.status === "ok") { setRejectOpen(false); onChanged(); return; }
    if (outcome.status === "unknown") { setUnknown(outcome.message); return; }
    if (outcome.status === "blocked") { setError(BLOCKED_MESSAGE); return; }
    if (outcome.status === "unauthorized") { setError(panelError(outcome.error).message); void session.confirm(); return; }
    if (outcome.status === "recovery-unresolved") { void resolveRecovery(acting); return; }
    setRejectOpen(false);
    setError(panelError(outcome.error).message);
    onChanged();
  };
  /** Only the original version + action + party may release the lock; a projection only observes. */
  const resolveRecovery = async (acting: string) => {
    const intent = loadIntent(acting, "settlement.decision", order.id);
    const targetVersionId = typeof intent?.context?.versionId === "string" ? intent.context.versionId : "";
    const targetAction = intent?.body?.action === "CONFIRM" || intent?.body?.action === "REJECT" ? intent.body.action : "";
    if (!targetVersionId || !targetAction) {
      setUnknown("原决定缺少目标版本或动作，不能按当前页面对象恢复；原请求保留，请人工核对或联系客服。");
      return;
    }
    try {
      const authority = await orderApi.settlement(acting, order.id);
      if (!isCurrent(acting)) return;
      const target = authority.versions.find((candidate) => candidate.id === targetVersionId);
      const recorded = (target?.decisions ?? []).some((decision) => decision.party === myParty && decision.action === targetAction);
      if (recorded) {
        clearIntent(acting, "settlement.decision", order.id);
        setUnknown(null);
        setError("服务端已记录你的决定。");
        onChanged();
        return;
      }
      const observed = target ? `原目标版本当前状态（版本 ${target.versionNo}，你的决定未记录）` : "未在原结算记录中找到该版本";
      setUnknown(`原结算决定仍未取得确定回执（原申请保留）。${observed}；当前页面状态不能确定这笔申请是否生效，请稍后再次查询或联系客服核对。`);
    } catch {
      if (isCurrent(acting)) setUnknown("原结算决定仍未取得确定回执；最新结算状态暂时无法读取。原请求保留，请稍后再次查询。");
    }
  };
  const decide = async (action: "CONFIRM" | "REJECT") => {
    if (!userId || locked) return;
    const pending = inspectIntent(userId, "settlement.decision", order.id);
    if (pending.state === "UNREADABLE") { setError("原结算决定记录无法读取，请联系客服核对。"); return; }
    if (pending.intent) { setUnknown(isIntentStale(pending.intent) ? STALE_MESSAGE : "检测到未完成的结算决定，请先查询原请求。"); return; }
    // A new confirmation is refused while the amount it would settle cannot be read. Rejecting,
    // refreshing and recovering an existing frozen request stay available.
    if (action === "CONFIRM" && !confirmable) {
      setError("服务端未返回可读的拟调整金额，无法确认这一版；请刷新或联系客服核对后重试。");
      return;
    }
    if (action === "CONFIRM" && version.early && order.earlySettlementDisclosure && (!earlyDisclosure || !termsAccepted)) {
      setError("请阅读并同意提前结束规则后再确认。");
      return;
    }
    const acting = userId;
    setBusy(action);
    setError(null);
    const body = { action, versionHash: version.versionHash, ...(action === "REJECT" && reason.trim() ? { reason: reason.trim() } : {}), ...(action === "CONFIRM" && version.early && order.earlySettlementDisclosure ? { termsAccepted: true } : {}) };
    const outcome = await performGuardedWrite(acting, "settlement.decision", order.id, body, { versionId: version.id, orderId: order.id },
      (key, frozen, frozenContext, subject) => orderApi.decideSettlement(subject, order.id, String(frozenContext?.versionId ?? ""), frozen as { action: "CONFIRM" | "REJECT"; versionHash: string }, key), isCurrent);
    if (!isCurrent(acting)) return;
    setBusy(null);
    apply(acting, outcome as WriteOutcome<OrderSettlement>);
  };
  const query = async () => {
    if (!userId) return;
    const acting = userId;
    const intent = loadIntent(acting, "settlement.decision", order.id);
    if (!intent) { setUnknown(null); onChanged(); return; }
    const targetVersionId = typeof intent.context?.versionId === "string" ? intent.context.versionId : "";
    if (!targetVersionId) {
      setUnknown("原决定缺少目标版本，不能按当前页面版本恢复；原请求保留，请人工核对或联系客服。");
      return;
    }
    setBusy("CONFIRM");
    const outcome = await performGuardedWrite(acting, "settlement.decision", order.id,
      { action: "CONFIRM", versionHash: version.versionHash }, { versionId: version.id, orderId: order.id },
      (key, frozen, frozenContext, subject) => orderApi.decideSettlement(subject, order.id, String(frozenContext?.versionId ?? ""), frozen as { action: "CONFIRM" | "REJECT"; versionHash: string }, key), isCurrent);
    if (!isCurrent(acting)) return;
    setBusy(null);
    apply(acting, outcome as WriteOutcome<OrderSettlement>);
  };
  const amounts = decisionAmountRows(party, version);
  const adjusted = isAdjustedVersion(version);
  const confirmable = !adjusted || proposedConfirmationCents(party, version) !== null;
  const subject = party === "owner" ? "净额" : "应退";
  return <div className="order-trade-block">
    <div className="order-trade-heading"><h3>结算确认</h3><span className="order-trade-tag">第{version.versionNo}版</span><span className="order-trade-tag is-accent">{version.early ? "提前结算" : version.kind === "MANUAL_ADJUSTMENT" ? "人工调整" : "正常结算"}</span></div>
    {feeReconfirmationRequired ? <p className="order-inline-notice" role="status">原方案的包赔费计算口径需要更正，暂不能生效。请联系客服重新生成方案；双方需确认新方案。</p> : <p className="order-muted">金额取自已确认的期初与本次期末数据，按冻结单价计算；双方同一版本确认后生效。拒绝与确认是不同的结果，拒绝不会生效这一版。</p>}
    {adjusted ? <div className="order-notice is-warning" role="status"><AlertCircle size={17} aria-hidden="true" /><div><strong>这一版含人工调整</strong><span>确认后会按「本次将确认的{subject}」生效，而不是系统计算值；请先核对两组金额与调整说明。</span></div></div> : null}
    <AmountTable rows={amounts} caption={adjusted ? `系统计算与拟调整金额（${party === "renter" ? "租客口径" : "号主口径"}）` : `本版结算金额明细（${party === "renter" ? "租客口径" : "号主口径"}，服务端计算）`} />
    {adjusted ? <p className="order-muted">调整说明：{version.inputSnapshot?.reason ?? version.inputSnapshot?.endReason ?? "服务端未返回说明"}</p> : null}
    {unknown ? <UnknownNotice label="结算决定结果未知" message={unknown} onQuery={() => void query()} onOpenOrder={onChanged} /> : null}
    {error ? <p className="order-inline-notice" role="alert">{error}</p> : null}
    {version.early && order.earlySettlementDisclosure && !decided && !locked && !feeReconfirmationRequired ? <EarlyTermsConsent key={version.versionHash} disclosure={earlyDisclosure} accepted={termsAccepted} onChange={setTermsAccepted} disabled={busy !== null} label="我已核对并接受本次提前结束的费用与退款安排" /> : null}
    {feeReconfirmationRequired ? <p className="order-muted">原版本仅供核对；如有结果未知的申请，请用上方「查询原请求」核对。</p> : decided ? <p className="order-muted">{decided.action === "CONFIRM" ? "你已确认这一版结算" : "你已拒绝这一版结算"} · {formatOrderTime(decided.createdAt)}</p> :
      readOnly ? <p className="order-muted">订单主状态已完成，本页不再提供新的确认或拒绝操作；如有一笔结果未知的申请，请用上方「查询原请求」按原键核对。</p> :
      locked ? null :
      <div className="order-trade-actions">
        {!confirmable ? <p className="order-inline-notice" role="status">这一版的拟调整金额暂时不可读，确认已暂时停用；可以刷新、拒绝，或先查询原请求。拒绝与查询不受影响。</p> : null}
        <button type="button" className="button primary" onClick={() => void decide("CONFIRM")} disabled={busy !== null || !confirmable || (version.early && Boolean(order.earlySettlementDisclosure) && (!earlyDisclosure || !termsAccepted))}>{busy === "CONFIRM" ? "确认中…" : version.early ? "确认提前结算（待客服复核）" : "确认结算"}</button>
        {!rejectOpen ? <button type="button" className="button quiet" onClick={() => setRejectOpen(true)} disabled={busy !== null}>拒绝并说明</button> :
          <span className="order-trade-reject"><input type="text" value={reason} maxLength={500} placeholder="请填写拒绝原因（可留空）" onChange={(event) => setReason(event.target.value)} aria-label="拒绝原因" /><button type="button" className="button secondary button--sm" onClick={() => void decide("REJECT")} disabled={busy !== null}>{busy === "REJECT" ? "提交中…" : "提交拒绝"}</button><button type="button" className="button quiet button--sm" onClick={() => setRejectOpen(false)} disabled={busy !== null}>返回</button></span>}
      </div>}
  </div>;
}

/** The confirmed opening the page settles against: the confirmed version if one exists, otherwise the latest recorded one. */
export function activeOpening(openings: SettlementOpening[]): SettlementOpening | null {
  if (openings.length === 0) return null;
  return openings.find((opening) => opening.status === "CONFIRMED") ?? openings[openings.length - 1]!;
}

/**
 * The server's `stage` is authoritative when readSettlement() returns the additive field. Codes
 * that describe an opening/no-stage/unknown state keep the local reconstruction, because the
 * progress card still needs the opening acks and deadline from the same read; a client-side
 * rebuild is only a fallback for older projections that omit `stage`.
 */
function serverPhase(code: OrderSettlementStage["code"]): OrderStageFacts["phase"] | null {
  if (code === "POSTED") return "POSTED";
  if (code === "INTAKE_PENDING") return "INTAKE_PENDING";
  if (code === "DECISION_REJECTED") return "DECISION_REJECTED";
  if (code === "DECISION_PENDING") return "DECISION_PENDING";
  if (code === "DECISION_WAITING") return "DECISION_WAITING";
  if (code === "RENTING") return "RENTING";
  return null;
}

export function stageFacts(data: OrderSettlement, opening: SettlementOpening | null, party: OrderParty): OrderStageFacts {
  const myParty = party.toUpperCase();
  const posting = data.posting ?? null;
  const current = data.settlement ?? null;
  const request = data.currentRequest ?? null;
  const myDecision = current ? (current.decisions ?? []).find((decision) => decision.party === myParty) : undefined;
  const rejection = current?.decisions?.find(decision => decision.action === "REJECT");
  const reconstructed: OrderStageFacts["phase"] = posting
    ? "POSTED"
    : request?.kind === "INTAKE" && request.status === "OPEN"
      ? "INTAKE_PENDING"
      : rejection
        ? "DECISION_REJECTED"
        : current && !myDecision
          ? "DECISION_PENDING"
          : current
            ? "DECISION_WAITING"
            : "RENTING";
  const stage = data.stage ?? null;
  const phase = (stage ? serverPhase(stage.code) : null) ?? reconstructed;
  return {
    rentalStarted: data.rentalStarted === true,
    phase,
    stageCode: stage?.code ?? null,
    viewerActionRequired: stage?.viewerActionRequired ?? false,
    autoConfirmDueAt: opening?.autoConfirmDueAt ?? null,
    openingGenerationState: data.openingGeneration?.state ?? null,
    openingGenerationRecoveryRequired: data.openingGenerationRecoveryRequired === true,
    feeReconfirmationRequired: data.reasons?.includes("SETTLEMENT_FEE_RECONFIRM_REQUIRED") === true,
    early: posting?.early === true,
    postedAt: posting?.postedAt ?? null,
    openingVersionNo: opening?.versionNo ?? null,
    settlementVersionNo: current?.versionNo ?? null,
    rejectedBy: rejection?.party ?? null,
    openingConfirmedAt: opening?.confirmedAt ?? null,
    myAck: (opening?.acks ?? []).some((ack) => ack.party === myParty),
    otherAck: (opening?.acks ?? []).some((ack) => ack.party !== myParty),
    // Reuses the M3 final-column rule: an unreadable figure stays "—" rather than becoming zero.
    settled: posting
      ? {
          label: party === "owner" ? "本单净入账" : "本单应退",
          text: party === "owner" ? moneyCents(posting.owner?.availableCents) : moneyCents(posting.refund?.payableCents),
        }
      : null,
  };
}

function PostingResult({ data, order, party, posting }: { data: OrderSettlement; order: Order; party: OrderParty; posting: NonNullable<OrderSettlement["posting"]> }) {
  const version = data.versions.find((candidate) => candidate.id === posting.settlementVersionId) ?? data.settlement ?? null;
  const opening = activeOpening(data.openings);
  const fee = typeof posting.compensationFeeCents === "string" && /^\d+$/.test(posting.compensationFeeCents) ? moneyCents(posting.compensationFeeCents) : null;
  const adjustment = posting.manualAdjustment;
  // The posted snapshot carries the fee decision; the response-level amounts only exist on a preview.
  const effectiveAmounts = posting.amounts ?? null;
  const feePayer = effectiveAmounts && typeof effectiveAmounts.feePayer === "string" ? effectiveAmounts.feePayer : null;
  const amountRows = postingAmountRows(party, posting);
  const captured = typeof posting.capturedCents === "string" && /^\d+$/.test(posting.capturedCents) ? moneyCents(posting.capturedCents) : "未记录";
  const charge = amountRows.find((row) => row.label === chargeRowLabel(Boolean(posting.manualAdjustment))) ?? null;
  const records = (version?.decisions ?? []).map((decision) => ({ label: `${partyLabel(decision.party)}${settlementDecisionLabel(decision.action)}`, time: decision.createdAt ?? null }));
  if (posting.postedAt) records.push({ label: "结算生效", time: posting.postedAt });
  return <>
    <div className="order-trade-block">
      <div className="order-trade-heading"><h3>结算已生效</h3><span className="order-trade-tag is-accent">{posting.early ? "提前结算" : "正常结算"}{version ? ` · 第${version.versionNo}版` : ""} · 已生效</span></div>
      <dl className="order-facts order-trade-facts">
        {party === "renter" ? <>
          <div><dt>{charge?.label ?? "本次结算扣费"}</dt><dd>{charge?.value ?? moneyText(posting.amounts?.renterCharge)}</dd></div>
          <div><dt>最终应退</dt><dd>{moneyCents(posting.refund?.payableCents)}</dd></div>
        </> : <>
          <div><dt>本单净入账</dt><dd>{moneyCents(posting.owner?.availableCents)}</dd></div>
          <div><dt>本次毛收入</dt><dd>{moneyText(posting.owner?.gross)}</dd></div>
          {feePayer === "OWNER" ? <div><dt>包赔费（号主承担）</dt><dd>{fee ?? "未记录"}</dd></div> : null}
        </>}
        {party === "renter" ? <><div><dt>原订单已付</dt><dd>{captured}</dd></div>
        <div><dt>退款应付款时间</dt><dd>{formatOrderTime(posting.refundDueAt)}</dd></div></> : null}
      </dl>
      <p className="order-muted">{party === "owner" ? "本单净入账只表示这一笔订单的净额，不代表钱包全部余额或提现结果。" : "最终应退为已生效的应付金额；退款到账结果未记录，需以收款渠道的实际记录为准，可在我的钱包查看。"}</p>
      {amountRows.length ? <AmountTable rows={amountRows} caption={`生效结算金额明细（${party === "renter" ? "租客口径" : "号主口径"}）`} /> : null}
      {adjustment ? <div className="order-trade-sub">
        <h5>人工调整</h5>
        <dl className="order-facts order-trade-facts">
          <div><dt>{party === "owner" ? "系统净额 → 最终净额" : "系统应退 → 最终应退"}</dt><dd>{party === "owner" ? `${moneyCents(adjustment.systemOwnerNetCents)} → ${moneyCents(adjustment.postedOwnerNetCents)}` : `${moneyCents(adjustment.systemRenterRefundCents)} → ${moneyCents(adjustment.postedRenterRefundCents)}`}</dd></div>
        </dl>
        <p className="order-muted">调整说明：{adjustment.reason ?? "服务端未返回说明"}</p>
      </div> : null}
      <ConsumptionTable order={order} opening={opening} version={version} extraResources={data.extraResources} />
      <RecordList title="结算记录" records={records} />
    </div>
    <div className="order-trade-block">
      <h3>版本记录</h3>
      <VersionHistory versions={data.versions} current={version} />
    </div>
  </>;
}

function VersionHistory({ versions, current }: { versions: SettlementVersion[]; current: SettlementVersion | null }) {
  if (versions.length === 0) return <p className="order-muted">服务端未返回历史结算版本。</p>;
  return <ul className="order-version-list">{versions.map((version) => {
    const reason = version.inputSnapshot?.reason ?? version.inputSnapshot?.endReason ?? version.endReason ?? null;
    const decisions = version.decisions ?? [];
    return <li key={version.id} data-state={version.supersededAt ? "superseded" : version.id === current?.id ? "current" : undefined}>
      <span className="order-version-no">第{version.versionNo}版</span>
      <span className="order-version-kind">{version.early ? "提前结算" : version.kind === "MANUAL_ADJUSTMENT" ? "人工调整" : "正常结算"}</span>
      {version.supersededAt ? <span className="order-version-state">已被替换 · {formatOrderTime(version.supersededAt)}</span> : <span className="order-version-state">当前版本</span>}
      {decisions.length ? <span className="order-version-decisions">{decisions.map((decision) => `${partyLabel(decision.party)}${settlementDecisionLabel(decision.action)}${decision.createdAt ? ` ${formatOrderTime(decision.createdAt)}` : ""}`).join(" · ")}</span> : null}
      {reason ? <span className="order-version-reason">说明：{reason}</span> : null}
      {version.supersededAt ? <span className="order-version-readonly">历史版本只读，不能再对其确认。</span> : null}
    </li>;
  })}</ul>;
}

export type SettlementFocus = "opening" | "settlement" | "decision";

export function SettlementAction({ order, party, onChanged, onStageFacts, modal = false, focus = "settlement" }: { order: Order; party: OrderParty; onChanged: () => void; onStageFacts?: (facts: OrderStageFacts | null, failed: boolean) => void; modal?: boolean; focus?: SettlementFocus }) {
  const session = useUserSession();
  // Freeze the read subject when the read is created. A late response from an older identity is
  // dropped instead of being rendered as the new subject's settlement facts.
  const subject = useMemo(() => captureOrderSubject(session.userId, session.identityVersion), [session.userId, session.identityVersion]);
  const [reload, setReload] = useState(0);
  const [state, setState] = useState<{ status: "loading" } | { status: "ready"; data: OrderSettlement } | { status: "unavailable" } | { status: "error" }>({ status: "loading" });
  const report = useRef(onStageFacts);
  useEffect(() => { report.current = onStageFacts; }, [onStageFacts]);
  useEffect(() => {
    const controller = new AbortController();
    setState({ status: "loading" });
    report.current?.(null, false);
    if (!subject) { report.current?.(null, true); setState({ status: "error" }); return () => controller.abort(); }
    orderApi.settlement(subject, order.id, controller.signal).then((data) => {
      if (controller.signal.aborted || !isOrderSubjectCurrent(subject, session)) return;
      setState({ status: "ready", data });
      report.current?.(stageFacts(data, activeOpening(data.openings), party), false);
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !isOrderSubjectCurrent(subject, session)) return;
      report.current?.(null, true);
      if (error instanceof OrderRequestError && error.status === 404) setState({ status: "unavailable" });
      else setState({ status: "error" });
    });
    return () => { controller.abort(); report.current?.(null, false); };
  }, [order.id, party, reload, subject, session]);
  const refresh = useCallback(() => { setReload((value) => value + 1); onChanged(); }, [onChanged]);
  if (state.status === "loading") {
    if (modal) return <div className="order-action-form"><p className="order-muted" role="status">正在读取履约记录…</p></div>;
    return <section className="order-detail-section order-trade-panel" id="order-trade-actions" aria-busy="true" aria-label="开租与结算"><h2 className="order-section-title">开租与结算</h2><p className="order-muted">正在读取结算记录…</p></section>;
  }
  if ((state.status === "unavailable" || state.status === "error") && onStageFacts) return null;
  if (state.status === "unavailable") {
    if (modal) return <div className="order-action-form"><p className="order-inline-notice" role="status">履约明细暂时无法读取，请稍后重试或联系客服。</p></div>;
    return <section className="order-detail-section order-trade-panel" id="order-trade-actions" aria-label="开租与结算">
      <h2 className="order-section-title">开租与结算</h2>
      <p className="order-muted">结算明细暂时无法读取，消耗、费用与退款金额尚无法展示。</p>
    </section>;
  }
  if (state.status === "error") {
    if (modal) return <div className="order-action-form"><p className="order-inline-notice" role="alert">履约记录没有读取成功，请稍后重试或联系客服。</p></div>;
    return <section className="order-detail-section order-trade-panel" id="order-trade-actions" role="alert"><h2 className="order-section-title">开租与结算</h2><p className="order-inline-notice">结算记录没有读取成功。</p></section>;
  }
  const data = state.data;
  // The order status is the server-owned terminal fact. A stale settlement read can still report
  // an in-flight opening or version; keep showing those records but never offer a new write.
  // Original-key recovery notices live inside the panels and stay available.
  const terminal = order.status === "COMPLETED";
  const opening = activeOpening(data.openings);
  const current = data.settlement ?? null;
  const myParty = party.toUpperCase();
  const myDecision = current ? (current.decisions ?? []).find((decision) => decision.party === myParty) : undefined;
  const posting = data.posting ?? null;
  const openIntake = data.currentRequest?.kind === "INTAKE" && data.currentRequest.status === "OPEN";
  const rejected = current?.decisions?.some(decision => decision.action === "REJECT") === true;
  if (modal) {
    const form = (() => {
      if (focus === "opening") {
        return opening
          ? <OpeningPanel opening={opening} order={order} party={party} onChanged={refresh} readOnly={terminal} />
          : <p className="order-muted">开租清单还没有准备好，请稍后刷新或联系客服。</p>;
      }
      if (focus === "decision") {
        if (!current) return <p className="order-muted">当前没有需要你确认的结算版本，请刷新后查看。</p>;
        if (myDecision) return <div className="order-trade-block">
          <h3>等待对方确认 <span className="order-trade-tag">第{current.versionNo}版</span></h3>
          <p className="order-muted">你已确认这一版结算，无需重复提交。</p>
          <AmountTable rows={decisionAmountRows(party, current)} caption={`本版金额明细（${party === "renter" ? "租客口径" : "号主口径"}）`} />
        </div>;
        return <DecisionPanel version={current} party={party} order={order} disclosure={data.earlySettlementDisclosure} onChanged={refresh} readOnly={terminal} feeReconfirmationRequired={data.reasons?.includes("SETTLEMENT_FEE_RECONFIRM_REQUIRED")} />;
      }
      if (posting) return <PostingResult data={data} order={order} party={party} posting={posting} />;
      if (current && data.reasons?.includes("SETTLEMENT_FEE_RECONFIRM_REQUIRED")) {
        return <DecisionPanel version={current} party={party} order={order} disclosure={data.earlySettlementDisclosure} onChanged={refresh} readOnly={terminal} feeReconfirmationRequired />;
      }
      if (openIntake) return <p className="order-muted">结束申请已提交，客服核对后会生成结算方案。</p>;
      if (current && rejected) return <p className="order-muted">上一版结算未达成一致，请联系客服生成新的方案。</p>;
      if (current && !myDecision) return <DecisionPanel version={current} party={party} order={order} disclosure={data.earlySettlementDisclosure} onChanged={refresh} readOnly={terminal} />;
      if (current && myDecision) return <p className="order-muted">你已确认本版结算，等待对方确认。</p>;
      if (opening && data.rentalStarted) return <EndingForm opening={opening} order={order} party={party} onChanged={refresh} consumptionMode={data.consumptionMode} extraResources={data.extraResources} readOnly={terminal} />;
      return <p className="order-muted">当前没有可执行的结算操作，请稍后刷新或联系客服。</p>;
    })();
    return <div className="order-action-form">{form}</div>;
  }
  return <section className="order-detail-section order-trade-panel" id="order-trade-actions" aria-label="开租与结算">
    <div className="order-trade-heading"><h2 className="order-section-title">{terminal ? "开租与结算记录" : "开租与结算"}</h2><button type="button" className="button quiet button--sm" onClick={refresh}><RefreshCw size={14} aria-hidden="true" />刷新</button></div>
    {!opening ? <div className="order-trade-block"><h3>期初库存</h3><p className="order-muted">{data.openingGeneration?.state === "REVIEW_REQUIRED" || data.openingGenerationRecoveryRequired
      ? data.openingGeneration?.reason === "LEGACY_V1_QUOTE_REVIEW"
        ? "本单使用旧版建单，缺少个性化资金/包赔依据，系统不会自动生成开租清单；请联系客服按未开租取消退款或使用新版重新下单。"
        : "付款已接纳，但本单冻结资料不足或自动生成记录暂不可用，开租清单正在等待客服核对。可点本区右上角「刷新」重新读取，或用页面上方「下一步」联系客服办理；用户侧不会自行生成清单或交付。订单页与聊天不受影响。"
      : "付款接纳后系统会按本单冻结报价生成开租清单；当前尚未读取到清单。可点本区右上角「刷新」重新读取，或用页面上方「下一步」联系客服核对；用户侧不会自行生成清单或交付，订单群准备好不等于已经开租。"}</p></div>
      : <OpeningPanel opening={opening} order={order} party={party} onChanged={refresh} readOnly={terminal} />}
    {opening && data.rentalStarted ? <>
      {posting ? <PostingResult data={data} order={order} party={party} posting={posting} /> :
        current && data.reasons?.includes("SETTLEMENT_FEE_RECONFIRM_REQUIRED") ? <DecisionPanel version={current} party={party} order={order} disclosure={data.earlySettlementDisclosure} onChanged={refresh} readOnly feeReconfirmationRequired /> :
        openIntake ? <div className="order-trade-block"><h3>结束申请待客服处理</h3><p className="order-muted">已提交期末数据，等待受权客服核实原因并复核；复核与双方确认完成后结算生效。期间不会重复受理同一份结束申请。</p></div> :
          current && rejected ? <div className="order-trade-block">
              <h3>{myDecision?.action === "REJECT" ? "你已拒绝" : "未达成一致的结算"}第{current.versionNo}版</h3>
              <p className="order-muted">拒绝不会使这一版生效；服务端会按新的期末数据或人工调整生成新版本，请按最新版本重新核对后再决定。</p>
              <AmountTable rows={decisionAmountRows(party, current)} caption={`被拒绝版本金额明细（${party === "renter" ? "租客口径" : "号主口径"}${isAdjustedVersion(current) ? "，含人工调整" : ""}）`} />
            </div> : current && !myDecision ? <DecisionPanel version={current} party={party} order={order} disclosure={data.earlySettlementDisclosure} onChanged={refresh} readOnly={terminal} /> :
              current && myDecision ? <div className="order-trade-block"><h3>等待对方确认 <span className="order-trade-tag">第{current.versionNo}版</span></h3><p className="order-muted">你已在这一版结算上完成操作；金额变化会生成新版本并要求重新确认。</p>
                <AmountTable rows={decisionAmountRows(party, current)} caption={`当前版本金额明细（${party === "renter" ? "租客口径" : "号主口径"}${isAdjustedVersion(current) ? "，含人工调整" : ""}）`} />
                <RecordList title="结算记录" records={(current.decisions ?? []).map((decision) => ({ label: `${partyLabel(decision.party)}${settlementDecisionLabel(decision.action)}`, time: decision.createdAt ?? null }))} />
              </div> :
                <EndingForm opening={opening} order={order} party={party} onChanged={refresh} consumptionMode={data.consumptionMode} extraResources={data.extraResources} readOnly={terminal} />}
    </> : null}
    {opening && !posting && data.versions.length > 1 ? <div className="order-trade-block"><h3>历史结算版本</h3><VersionHistory versions={data.versions} current={current} /></div> : null}
  </section>;
}

export function PaymentFactsProbe({ order, onFacts }: { order: Order; onFacts?: (facts: OrderPaymentFacts | null) => void }) {
  const session = useUserSession();
  const userId = session.status === "authenticated" ? session.userId : null;
  const { id } = order;
  useEffect(() => {
    if (!userId) { onFacts?.(PAYMENT_FACTS_UNREADABLE); return; }
    const controller = new AbortController();
    const originalRequestPending = (["order.channel-payment", "order.demo-checkout", "order.local-checkout", "order.payment"] as const)
      .some((kind) => inspectIntent(userId, kind, id).state !== "NONE");
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

export function OrderTradeActions({ order, party, onChanged, onStageFacts, onPaymentFacts }: { order: Order; party: OrderParty; onChanged: () => void; onStageFacts?: (facts: OrderStageFacts | null, failed: boolean) => void; onPaymentFacts?: (facts: OrderPaymentFacts | null) => void }) {
  if (order.status === "PENDING_PAYMENT") return <PaymentAction order={order} party={party} onChanged={onChanged} onPaymentFacts={onPaymentFacts} />;
  if (order.status === "PAID" || order.status === "COMPLETED") return <SettlementAction order={order} party={party} onChanged={onChanged} onStageFacts={onStageFacts} />;
  if (order.status === "CANCELLED") return <section className="order-detail-section order-trade-panel" id="order-trade-actions" aria-label="订单收尾">
    <h2 className="order-section-title">订单收尾</h2>
    <p className="order-muted"><CircleSlash size={14} aria-hidden="true" /> 订单已结束，本页不再提供开租、结算或新的支付操作。退款进度、售后记录与客服入口按实际可用性保留；取消或过账都不代表渠道退款已到账，本单账号不会因完单而再次上架。</p>
    <div className="order-trade-actions">
      <Link className="button secondary" href={party === "renter" ? "/accounts" : "/account?view=accounts"} scroll={false}>{party === "renter" ? "浏览可租账号" : "管理上架账号"}</Link>
    </div>
  </section>;
  return null;
}
