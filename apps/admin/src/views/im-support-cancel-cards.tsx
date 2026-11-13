"use client";
/**
 * 客服取消订单卡：待付款取消与未开租取消退款。
 * 取消结果未知时保留原请求键，只按原请求重试；金额与退款进度以服务端事实为准。
 */
import { useRef, useState } from "react";
import { CircleAlert, ShieldCheck, TriangleAlert } from "lucide-react";
import { AdminApiError, friendlyError } from "../api";
import { ConfirmAlertDialog } from "../components/ui/alert-dialog";
import { Textarea } from "../components/ui/textarea";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardTitle } from "../components/ui/card";
import { formatFundingCents } from "./supply-review/model";
import {
  readSupportCancel,
  readSupportUnpaidCancel,
  sendSupportCancel,
  sendSupportUnpaidCancel,
  type SupportCancelView,
  type SupportUnpaidCancelView,
} from "../lib/order-fulfillment-client";
import { SUPPORT_CANCEL_UNKNOWN, supportCancelReasonText, supportCancelRefundText } from "./im-support-fulfillment-model";

/** The pending-order path never creates a refund or claims the channel is closed. */
export function SupportUnpaidCancelCard({ orderId, displayNo, onReviewPayment, compact=false }: { orderId: string; displayNo: string; onReviewPayment?: () => void; compact?:boolean }) {
  const [open, setOpen] = useState(false), [reason, setReason] = useState(""), [error, setError] = useState("");
  const [phase, setPhase] = useState<"IDLE" | "LOADING" | "SENDING" | "UNKNOWN">("IDLE");
  const [view, setView] = useState<SupportUnpaidCancelView | null>(null), [done, setDone] = useState(false);
  const key = useRef("");
  const valid = reason.trim().length >= 3 && new TextEncoder().encode(reason.trim()).length <= 600
    && ![...reason].some(ch => { const code = ch.codePointAt(0)!; return code < 32 && code !== 10 && code !== 13 || code === 127; });
  const openDialog = async () => {
    setOpen(true); setError(""); setReason(""); setView(null); setPhase("LOADING"); key.current = "";
    try {
      const result = await readSupportUnpaidCancel(orderId);
      if (result.contractVersion !== "admin-support-unpaid-cancel.v1" || result.orderId !== orderId
        || typeof result.orderRevision !== "string" || !/^[1-9]\d{0,18}$/.test(result.orderRevision) || typeof result.eligibility?.allowed !== "boolean") throw new Error("INVALID_RESPONSE");
      setView(result); setPhase("IDLE");
    } catch { setError("暂时无法核对付款状态，请刷新后重试。"); setPhase("IDLE"); }
  };
  const submit = async () => {
    if (!view?.eligibility.allowed || !valid || phase === "SENDING") return;
    if (!key.current) key.current = `support_unpaid_${crypto.randomUUID()}`;
    setPhase("SENDING"); setError("");
    const outcome = await sendSupportUnpaidCancel(orderId, view.orderRevision, reason.trim(), key.current);
    if (outcome.kind === "accepted") { setDone(true); setOpen(false); setPhase("IDLE"); return; }
    if (outcome.kind === "unknown") { setPhase("UNKNOWN"); setError("取消结果尚未确认，请按原请求重试或核对订单状态。"); return; }
    setPhase("IDLE"); setView(null);
    setError(outcome.reason === "PAYMENT_REVIEW_REQUIRED" ? "发现付款记录或请求，请先核对付款情况。" : "订单状态已变化或当前无权处理，请刷新后核对。");
  };
  const blocked = view && !view.eligibility.allowed;
  return <Card className={`im-support-fulfillment im-order-card${compact?" oc-action-card":""}`} data-support-unpaid-cancel="true">
    <CardContent className={compact?"grid gap-2 p-0":"grid gap-2 p-4"}>
      <CardTitle className="text-sm">取消待付款订单</CardTitle>
      <CardDescription className="text-xs leading-relaxed">仅可处理尚未发起付款的订单。若已有付款请求或付款记录，请先核对资金状态。</CardDescription>
      {done ? <Alert><ShieldCheck /><AlertTitle>订单已取消</AlertTitle><AlertDescription>账号占用已解除；此操作未向支付渠道发送关单请求。</AlertDescription></Alert>
        : <div><Button type="button" variant="outline" size="sm" onClick={() => void openDialog()}>取消待付款订单</Button></div>}
    </CardContent>
    <ConfirmAlertDialog open={open} onOpenChange={next => { if (!next && (phase === "SENDING" || phase === "UNKNOWN")) return; setOpen(next); }}
      contentLabel="取消待付款订单" title="确认取消待付款订单？" description={`订单 ${displayNo}。系统会再次核查本站付款记录并记录处理人和原因；此操作不请求渠道关单。`}
      confirmLabel={phase === "SENDING" ? "提交中…" : phase === "UNKNOWN" ? "重试同一请求" : "确认取消"}
      onConfirm={() => void submit()} busy={phase === "SENDING"} confirmDisabled={!view?.eligibility.allowed || !valid}>
      {phase === "LOADING" ? <p role="status">正在核对付款记录…</p> : null}
      {blocked ? <Alert variant="warning"><TriangleAlert /><AlertTitle>暂不能直接取消</AlertTitle><AlertDescription>{view.eligibility.reason === "PAYMENT_REVIEW_REQUIRED" ? "本单已有付款请求或记录，请先核对付款情况。" : "订单状态已变化，请刷新后查看。"}</AlertDescription>{view.eligibility.reason === "PAYMENT_REVIEW_REQUIRED" && onReviewPayment ? <AlertAction><Button variant="outline" size="sm" onClick={() => { setOpen(false); onReviewPayment(); }}>查看资金与退款</Button></AlertAction> : null}</Alert> : null}
      <label className="im-wb-dialog-note"><span>取消原因（必填）</span><Textarea value={reason} maxLength={150} rows={3} aria-label="待付款订单取消原因"
        placeholder="说明与双方核实的情况" disabled={phase === "SENDING" || phase === "UNKNOWN" || !view?.eligibility.allowed}
        onChange={event => setReason(event.target.value)} /></label>
      {error ? <p role="alert" className="im-wb-dialog-error"><CircleAlert size={14}/>{error}</p> : null}
    </ConfirmAlertDialog>
  </Card>;
}

export function SupportCancelCard({ orderId, displayNo, compact=false }: { orderId: string; displayNo: string; compact?:boolean }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const [phase, setPhase] = useState<"IDLE" | "LOADING" | "SENDING" | "UNKNOWN">("IDLE");
  const [preview, setPreview] = useState<SupportCancelView | null>(null);
  const [result, setResult] = useState<SupportCancelView | null>(null);
  const [error, setError] = useState("");
  const keyRef = useRef("");
  const trimmed = reason.trim();
  const valid = trimmed.length >= 3 && trimmed.length <= 600
    && ![...reason].some((ch) => { const code = ch.codePointAt(0)!; return code < 32 && code !== 10 && code !== 13 || code === 127; });

  const openDialog = async () => {
    if (phase !== "UNKNOWN") keyRef.current = "";
    setError("");
    setReason("");
    setPreview(null);
    setPhase("LOADING");
    setOpen(true);
    try {
      const view = await readSupportCancel(orderId);
      setPreview(view);
      if (view.supportCancellation) setResult(view);
      setPhase("IDLE");
    } catch (cause) {
      setPhase("IDLE");
      if (cause instanceof AdminApiError && (cause.status === 401 || cause.status === 423)) setError("登录状态已变化；请重新确认管理员身份后核对。");
      else if (cause instanceof AdminApiError && cause.status === 403) setError("当前账号不是本单客服，或没有订单结算写权限。");
      else if (cause instanceof AdminApiError && cause.status === 404) setError("当前无法办理客服取消或读取订单，请核对订单和付款信息。");
      else setError(friendlyError(cause));
    }
  };

  const submit = async () => {
    if (!valid || phase === "SENDING" || !preview?.eligibility.allowed) return;
    if (!keyRef.current) keyRef.current = `support_cancel_${orderId}_${crypto.randomUUID()}`;
    setPhase("SENDING");
    setError("");
    const outcome = await sendSupportCancel(orderId, preview.orderRevision, trimmed, keyRef.current);
    if (outcome.kind === "accepted") {
      if (outcome.view.simulationScope !== preview.simulationScope) {
        setPhase("UNKNOWN");
        setError(SUPPORT_CANCEL_UNKNOWN);
        return;
      }
      setResult(outcome.view);
      setPreview(outcome.view);
      setOpen(false);
      setPhase("IDLE");
      try {
        const fresh = await readSupportCancel(orderId);
        if (fresh.simulationScope === outcome.view.simulationScope) { setResult(fresh); setPreview(fresh); }
      } catch { /* the accepted receipt is already durable; a failed read must not undo it */ }
      return;
    }
    if (outcome.kind === "unknown") {
      setPhase("UNKNOWN");
      setError(SUPPORT_CANCEL_UNKNOWN);
      return;
    }
    if (outcome.kind === "auth") {
      setPhase("IDLE");
      setError("登录状态已变化；请重新确认管理员身份后核对。");
      return;
    }
    setPhase("IDLE");
    setError(supportCancelReasonText(outcome.reasons[0]));
  };

  const refundCents = result?.supportCancellation?.refundCents ?? preview?.eligibility.refundCents ?? null;
  const blocked = preview !== null && !preview.eligibility.allowed && !preview.supportCancellation;
  const simulated = preview?.simulationScope !== undefined;
  return <Card id={`support-cancel-${orderId}`} tabIndex={-1} className={`im-support-fulfillment im-order-card${compact?" oc-action-card":""}`} data-support-cancel="true" aria-label="客服取消订单退款">
    <CardContent className={compact?"grid gap-2 p-0":"grid gap-2 p-4"}>
      <CardTitle className="flex items-center gap-2 text-sm"><TriangleAlert className="size-4 shrink-0 text-destructive" />取消未开租订单</CardTitle>
      <CardDescription className="text-xs leading-relaxed">仅限尚未确认开租的订单，核实未使用且无争议后登记全额退款责任。已开租订单请使用正常或提前结算。</CardDescription>
      {result ? <Alert><ShieldCheck /><AlertTitle>已取消并登记全额退款</AlertTitle><AlertDescription>
        退款金额 {formatFundingCents(refundCents)}（原支付金额）。{supportCancelRefundText(result)} 订单已取消，群聊保留。
      </AlertDescription></Alert>
        : <div className="im-support-fulfillment-actions">
          <Button variant="outline" size="sm" data-action="support-cancel-open" onClick={() => void openDialog()}>取消订单</Button>
        </div>}
      {error && !open ? <p className="im-support-fulfillment-error" role="alert"><CircleAlert size={14} />{error}</p> : null}
    </CardContent>
    <ConfirmAlertDialog open={open} onOpenChange={(next) => { if (!next && (phase === "SENDING" || phase === "UNKNOWN")) return; setOpen(next); }}
      contentLabel="取消订单确认" title={simulated?"确认取消订单并模拟退款？":"确认取消订单并登记退款？"}
      description={simulated?`订单 ${displayNo}。提交后订单立即取消，退款仅用于测试，不会实际退回款项。`:`订单 ${displayNo}。提交后订单立即取消，并登记原支付金额的全额退款责任；渠道提交结果和银行到账状态未知。`}
      confirmLabel={phase === "SENDING" ? "提交中…" : phase === "UNKNOWN" ? "重试同一请求" : simulated?"确认取消并模拟退款":"确认取消并退款"}
      onConfirm={() => void submit()} busy={phase === "SENDING"} confirmDisabled={!preview?.eligibility.allowed || !valid}>
      {phase === "LOADING" ? <p className="im-wb-dialog-hint">正在读取退款资格与金额…</p> : null}
      {preview ? <div className="grid gap-2">
        <p className="text-sm"><strong>退款金额：{formatFundingCents(preview.eligibility.refundCents ?? preview.supportCancellation?.refundCents)}</strong>（原支付金额）</p>
        <p className="im-wb-dialog-hint">{preview.openingConfirmed ? "订单已确认开租，请使用现有结算与退款流程。" : "订单尚未确认开租；核实未使用且无争议后登记全额应退。"} {simulated?"这是模拟退款，不会实际退回款项。":"渠道提交结果与银行到账状态未知，不能把本地退款责任当成已到账。"}</p>
        {blocked ? <Alert variant="warning"><TriangleAlert /><AlertTitle>当前不可取消</AlertTitle><AlertDescription>{supportCancelReasonText(preview.eligibility.reason)}</AlertDescription></Alert> : null}
      </div> : null}
      {preview?.supportCancellation ? <Alert><ShieldCheck /><AlertTitle>已存在客服取消记录</AlertTitle><AlertDescription>{supportCancelRefundText(preview)}</AlertDescription></Alert> : null}
      <label className="im-wb-dialog-note"><span>取消原因（必填，3–600 字）<em>{reason.length}/600</em></span>
        <Textarea value={reason} maxLength={600} rows={3} aria-label="客服取消原因" data-support-cancel-reason="true"
          placeholder="说明取消原因与已与双方沟通的事实" disabled={phase === "SENDING" || phase === "UNKNOWN" || !preview?.eligibility.allowed}
          onChange={(event) => { setReason(event.target.value); setError(""); }} />
      </label>
      {error ? <p className="im-wb-dialog-error" role="alert"><CircleAlert size={14} />{error}</p> : null}
    </ConfirmAlertDialog>
  </Card>;
}