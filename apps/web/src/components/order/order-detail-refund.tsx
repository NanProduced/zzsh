"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { CircleSlash, RefreshCw } from "lucide-react";
import { formatOrderTime as timeText, orderApi, OrderRequestError, type Order, type PersonalRefundIntent, type PersonalRefundRead } from "@/lib/order-client";
import { useUserSession } from "@/components/session/user-session-provider";
import { useIdentityReset } from "@/components/session/identity-reset";

const refundOutcomeCopy: Record<PersonalRefundRead["outcome"], { label: string; note: string }> = {
  RESPONSIBILITY_NOT_POSTED: { label: "退款金额未记录", note: "如有退款，进度会显示在这里。" },
  ZERO_RESPONSIBILITY: { label: "本次结算应退为零", note: "其他退款事项会单独显示。" },
  NOT_DUE: { label: "退款尚未到期", note: "到期不代表退款已处理或到账。" },
  NO_INTENT: { label: "退款进度未记录", note: "如有疑问，请联系客服。" },
  PARTIALLY_ALLOCATED: { label: "退款进度未记录", note: "到账情况请以收款记录为准。" },
  FULLY_ALLOCATED: { label: "退款进度未记录", note: "到账情况请以收款记录为准。" },
  PARTIALLY_CONSUMED: { label: "退款进度未记录", note: "到账情况请以收款记录为准。" },
  FULLY_CONSUMED: { label: "退款进度未记录", note: "到账情况请以收款记录为准。" },
  RELEASED: { label: "退款进度未记录", note: "如有疑问，请联系客服。" },
  PROCESSING: { label: "退款处理中", note: "到账情况请以收款记录为准。" },
  UNKNOWN: { label: "退款结果未记录", note: "请稍后查看，或联系客服。" },
  REVIEW_REQUIRED: { label: "退款需要核对", note: "如有疑问，请联系客服。" },
  TRUNCATED: { label: "部分退款记录未记录", note: "当前显示的记录可能不完整。" },
  CONFLICT: { label: "退款记录需要核对", note: "部分金额暂时无法确认，请联系客服。" },
};
const refundIntentStateLabel: Record<PersonalRefundIntent["state"], string> = {
  READY: "等待处理", SUBMITTING: "发送结果待核", UNKNOWN: "结果未记录", PROCESSING: "处理中",
  REVIEW_REQUIRED: "需要核对", SUCCEEDED: "退款结果待核对", FAILED: "申请处理失败", UNRECOGNIZED: "状态未记录",
};

function refundMoney(cents: string | null): string {
  if (cents === null) return "未记录";
  const value = BigInt(cents);
  return `¥${(value / 100n).toLocaleString("zh-CN")}.${(value % 100n).toString().padStart(2, "0")}`;
}

function RefundIntentCard({ intent, conflict }: { intent: PersonalRefundIntent; conflict: boolean }) {
  const channelSucceeded = intent.source === "JOINPAY_FORMAL" && intent.state === "SUCCEEDED" && intent.budgetDisposition === "CONSUMED"
    && intent.savedChannelEvidence?.terminal === "SUCCEEDED" && intent.savedChannelEvidence.evidenceLevel === "PROVIDER_RESPONSE";
  const stateLabel = intent.requiresReview || conflict ? "退款状态待核对" : intent.source === "LOCAL_CONTROLLED" && intent.state === "SUCCEEDED" && intent.budgetDisposition === "CONSUMED" ? "模拟退款已记录" : channelSucceeded ? "退款成功" : refundIntentStateLabel[intent.state];
  return <li className="order-refund-intent">
    <div className="order-refund-intent-head"><strong>{intent.refundOrderNo ?? "退款申请"}</strong><span className="order-refund-state">{stateLabel}</span></div>
    <dl className="order-facts order-refund-intent-facts">
      <div><dt>申请金额</dt><dd>{intent.amount ? refundMoney(intent.amount.cents) : "未记录"}</dd></div>
      {intent.createdAt ? <div><dt>申请时间</dt><dd>{timeText(intent.createdAt, { timeZoneName: false })}</dd></div> : null}
    </dl>
    {intent.source === "LOCAL_CONTROLLED" ? <p className="order-muted">测试记录，不代表真实退款。</p> : null}
    {intent.requiresReview || conflict ? <p className="order-muted">这笔退款需要核对，请联系客服。</p> : null}
  </li>;
}


export function OrderOwnerRefundSummary({ order }: { order: Order }) {
  const session = useUserSession();
  const [state, setState] = useState<{ scope: string; status: "loading" | "ready" | "error"; read: import("@/lib/order-client").OwnerRefundMinimalSummary | null; error: OrderRequestError | null }>({ scope: "", status: "loading", read: null, error: null });
  const [reload, setReload] = useState(0);
  const reset = useCallback(() => setState({ scope: "", status: "loading", read: null, error: null }), []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  const current = useRef(isCurrent); current.current = isCurrent;
  const confirm = useRef(session.confirm); confirm.current = session.confirm;
  const scope = userId ? `${userId}:${order.id}:${order.status}:owner-refund` : "";
  const visible = state.scope === scope ? state : { scope, status: "loading" as const, read: null, error: null };
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    setState({ scope, status: "loading", read: null, error: null });
    void orderApi.ownerRefundSummary(userId, order.id, controller.signal).then((read) => {
      if (!controller.signal.aborted && current.current(userId) && scope.endsWith(":owner-refund")) setState({ scope, status: "ready", read, error: null });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !current.current(userId)) return;
      const typed = error instanceof OrderRequestError ? error : new OrderRequestError(0, null);
      if (typed.status === 401 || typed.code === "UNAUTHENTICATED") void confirm.current();
      setState({ scope, status: "error", read: null, error: typed });
    });
    return () => controller.abort();
  }, [order.id, order.status, reload, scope, userId]);
  if (!userId) return null;
  const refresh = <button type="button" className="button quiet button--sm" disabled={visible.status === "loading"} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />刷新</button>;
  if (visible.status === "loading") return <section className="order-detail-section order-refund-block" id="order-refund-section" aria-label="退款进度"><h2 className="order-section-title">退款进度</h2><p className="order-muted" role="status">正在加载退款进度…</p></section>;
  if (visible.status === "error") {
    return <section className="order-detail-section order-refund-block" id="order-refund-section" aria-label="退款进度"><div className="order-refund-heading"><h2 className="order-section-title">退款进度</h2>{refresh}</div><p className="order-muted" role="status">退款进度暂时无法查看，请稍后重试。</p></section>;
  }
  const read = visible.read;
  if (!read || read.progress === "NOT_APPLICABLE") return null;
  return <section className="order-detail-section order-refund-block" id="order-refund-section" aria-label="退款进度" data-progress={read.progress}>
    <div className="order-refund-heading"><h2 className="order-section-title">退款进度</h2>{refresh}</div>
    <div className="order-refund-details">
      <div className="order-refund-summary"><strong>{read.label}</strong><span>{read.note}</span></div>
      <div className="order-refund-detail-content">
        <p className="order-muted">订单状态以页面顶部为准；此处不展示租客收款资料。</p>
        {read.openIntentCount > 0 ? <p className="order-muted">进行中的退款处理记录：{read.openIntentCount} 笔</p> : null}
      </div>
    </div>
  </section>;
}

export function OrderRefundSection({ order }: { order: Order }) {
  const session = useUserSession();
  const [state, setState] = useState<{ scope: string; status: "loading" | "ready" | "error"; read: PersonalRefundRead | null; error: OrderRequestError | null }>({ scope: "", status: "loading", read: null, error: null });
  const [reload, setReload] = useState(0);
  const reset = useCallback(() => setState({ scope: "", status: "loading", read: null, error: null }), []);
  const { userId, isCurrent } = useIdentityReset(session, reset);
  const current = useRef(isCurrent); current.current = isCurrent;
  const confirm = useRef(session.confirm); confirm.current = session.confirm;
  const scope = userId ? `${userId}:${order.id}:${order.status}` : "";
  const visible = state.scope === scope ? state : { scope, status: "loading" as const, read: null, error: null };
  useEffect(() => {
    if (!userId) return;
    const controller = new AbortController();
    setState({ scope, status: "loading", read: null, error: null });
    void orderApi.personalRefunds(userId, order.id, controller.signal).then((read) => {
      if (!controller.signal.aborted && current.current(userId) && scope === `${userId}:${order.id}:${order.status}`) setState({ scope, status: "ready", read, error: null });
    }).catch((error: unknown) => {
      if (controller.signal.aborted || !current.current(userId) || scope !== `${userId}:${order.id}:${order.status}`) return;
      const typed = error instanceof OrderRequestError ? error : new OrderRequestError(0, null);
      if (typed.status === 401 || typed.code === "UNAUTHENTICATED") void confirm.current();
      setState({ scope, status: "error", read: null, error: typed });
    });
    return () => controller.abort();
  }, [order.id, order.status, reload, scope, userId]);
  if (!userId) return null;
  const refresh = <button type="button" className="button quiet button--sm" disabled={visible.status === "loading"} onClick={() => setReload(value => value + 1)}><RefreshCw size={14} aria-hidden="true" />刷新</button>;
  if (visible.status === "loading") return <section className="order-detail-section order-refund-block" id="order-refund-section" aria-label="退款进度"><h2 className="order-section-title">退款进度</h2><p className="order-muted" role="status">正在加载退款进度…</p></section>;
  if (visible.status === "error") {
    const error = visible.error ?? new OrderRequestError(0, null);
    const copy = error.status === 401 || error.code === "UNAUTHENTICATED" ? "登录状态已变化，请重新登录后查看。" : "退款进度暂时无法查看，请稍后重试。";
    return <section className="order-detail-section order-refund-block" id="order-refund-section" aria-label="退款进度"><div className="order-refund-heading"><h2 className="order-section-title">退款进度</h2>{refresh}</div><div className="order-notice is-warning" role="alert"><CircleSlash size={17} aria-hidden="true" /><div><strong>{copy}</strong>{error.requestId ? <span>查询编号：{error.requestId}</span> : null}</div></div></section>;
  }
  const read = visible.read;
  if (!read) return null;
  if (read.status === "NOT_APPLICABLE" && !read.prestartRefund && !read.cancellationRefund) return null;
  const responsibility = read.responsibility;
  const prestart = read.prestartRefund ?? read.cancellationRefund;
  const needsReview = read.intents.some(intent => intent.requiresReview);
  const incomplete = read.intentsTruncated || !read.coverage.intentsComplete || responsibility.state === "POSTED" && !responsibility.totalsComplete;
  const simulated = read.outcome === "FULLY_CONSUMED" && !incomplete && read.intents.length > 0
    && read.intents.every(intent => intent.source === "LOCAL_CONTROLLED" && intent.state === "SUCCEEDED" && intent.budgetDisposition === "CONSUMED");
  const channelSucceeded = read.outcome === "FULLY_CONSUMED" && !incomplete && read.intents.length > 0
    && read.intents.every(intent => intent.source === "JOINPAY_FORMAL" && intent.state === "SUCCEEDED" && intent.budgetDisposition === "CONSUMED"
      && intent.savedChannelEvidence?.terminal === "SUCCEEDED" && intent.savedChannelEvidence.evidenceLevel === "PROVIDER_RESPONSE");
  const prestartCopy = prestart ? {
    PROCESSING: { label: "退款处理中", note: "请稍后查看退款进度。" },
    SUCCEEDED: { label: prestart.source === "SIMULATED" ? "模拟退款成功" : "退款成功", note: prestart.source === "SIMULATED" ? "测试记录，不会实际退款。" : "渠道已记录退款成功，到账时间以收款记录为准。" },
    FAILED: { label: "退款未完成", note: "请联系客服处理。" },
    UNKNOWN: { label: "退款状态待核对", note: "请稍后查看或联系客服。" },
  }[prestart.state] : null;
  const outcome = prestartCopy ?? (needsReview ? refundOutcomeCopy.REVIEW_REQUIRED : simulated ? { label: "模拟退款已记录", note: "测试记录，不代表实际退款或到账。" }
    : channelSucceeded ? { label: "退款成功", note: "渠道已记录退款成功，到账时间以收款记录为准。" } : refundOutcomeCopy[read.outcome]);
  return <section className="order-detail-section order-refund-block" id="order-refund-section" aria-label="退款进度" data-outcome={prestart?.state ?? read.outcome}>
    <div className="order-refund-heading"><h2 className="order-section-title">退款进度</h2>{refresh}</div>
    <div className="order-refund-details">
      <div className="order-refund-summary"><strong>{outcome.label}</strong><span>{outcome.note}</span></div>
      <div className="order-refund-detail-content">
        {incomplete && !prestart ? <p className="order-inline-notice" role="status">部分退款信息仍在核对，当前记录可能不完整。</p> : null}
        {prestart?.amountCents ? <dl className="order-facts order-refund-amounts"><div><dt>{prestart.state === "SUCCEEDED" ? "退款金额" : "应退金额"}</dt><dd>{refundMoney(prestart.amountCents)}</dd></div></dl> : null}
        {responsibility.state === "POSTED" ? <dl className="order-facts order-refund-amounts">
          <div><dt>本次结算应退</dt><dd>{refundMoney(responsibility.originalCents)}</dd></div>
          {responsibility.dueAt ? <div><dt>退款到期时间</dt><dd>{timeText(responsibility.dueAt, { timeZoneName: false })}{responsibility.dueState === "DUE" ? "（已到期）" : responsibility.dueState === "NOT_DUE" ? "（未到期）" : "（状态未记录）"}</dd></div> : null}
        </dl> : null}
        {responsibility.state === "POSTED" && responsibility.dueAt ? <p className="order-muted">到期不代表退款已处理或到账。</p> : null}
        {read.intents.length ? <section aria-label="退款申请记录"><div className="order-refund-intents-heading"><h3>退款申请</h3><span>{read.intentsTruncated || !read.coverage.intentsComplete ? "部分记录未记录" : `${read.returnedIntentCount} 笔`}</span></div><ul className="order-refund-intents">{read.intents.map(intent => <RefundIntentCard key={intent.intentId} intent={intent} conflict={read.outcome === "CONFLICT"} />)}</ul></section> : null}
        <p className="order-muted">到账情况请以收款记录为准。</p>
      </div>
    </div>
  </section>;
}
