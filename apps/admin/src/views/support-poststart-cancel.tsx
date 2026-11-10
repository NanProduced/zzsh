"use client";

import { useEffect, useRef, useState } from "react";
import { parseYuanToCents } from "@zzsh/ui/display-money";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { ConfirmAlertDialog } from "../components/ui/alert-dialog";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardDescription, CardTitle } from "../components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../components/ui/dialog";
import { Input } from "../components/ui/input";
import { readSupportCancel, sendSupportCancel, type SupportCancelView } from "../lib/order-fulfillment-client";
import { withSupplyWriteLock } from "../lib/supply-write-lock";
import { formatFundingCents } from "./supply-review/model";

type CancelIntent = {
  subject: string; orderId: string; key: string; revision: string; paidCents: string;
  refundCents: string; ownerCents: string; reason: string; simulationScope?: string;
};
const cents = /^(0|[1-9][0-9]{0,15})$/;
const storageKey = (subject: string, orderId: string) => `zzsh.support.poststart-cancel.${subject}.${orderId}`;
function validIntent(value: unknown, subject: string, orderId: string): value is CancelIntent {
  if (!value || typeof value !== "object") return false;
  const i = value as CancelIntent;
  return i.subject === subject && i.orderId === orderId && typeof i.key === "string" && /^support_cancel_[A-Za-z0-9._:-]+$/.test(i.key)
    && typeof i.revision === "string" && /^[1-9][0-9]{0,18}$/.test(i.revision)
    && [i.paidCents, i.refundCents, i.ownerCents].every(v => typeof v === "string" && cents.test(v))
    && BigInt(i.paidCents) > 0n && BigInt(i.refundCents) + BigInt(i.ownerCents) <= BigInt(i.paidCents)
    && typeof i.reason === "string" && [...i.reason].length >= 3 && new TextEncoder().encode(i.reason).length <= 600
    && !/[\u0000-\u001f\u007f]/.test(i.reason)
    && (i.simulationScope === undefined || ["LOCAL_DEMO_SIMULATED", "ECS_TEST_SIMULATED"].includes(i.simulationScope));
}

/** One frozen request per administrator and order; an unknown result is replayed with the original body and key. */
export function SupportPoststartCancelCard({ orderId, displayNo, viewerId, compact = false }: {
  orderId: string; displayNo: string; viewerId: string; compact?: boolean;
}) {
  const scope = `${viewerId}:${orderId}`;
  const identity = useRef({ scope, epoch: 0 });
  if (identity.current.scope !== scope) identity.current = { scope, epoch: identity.current.epoch + 1 };
  const [loadedScope, setLoadedScope] = useState("");
  const [pending, setPending] = useState<CancelIntent | null>(null);
  const [storageBlocked, setStorageBlocked] = useState(false);
  const [open, setOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<SupportCancelView | null>(null);
  const [result, setResult] = useState<SupportCancelView | null>(null);
  const [refund, setRefund] = useState("");
  const [owner, setOwner] = useState("");
  const [reason, setReason] = useState("");
  const [message, setMessage] = useState("");

  useEffect(() => {
    setPending(null); setPreview(null); setResult(null); setOpen(false); setConfirm(false); setBusy(false); setMessage(""); setStorageBlocked(false);
    try {
      const raw = window.localStorage.getItem(storageKey(viewerId, orderId));
      if (raw !== null) {
        const saved: unknown = JSON.parse(raw);
        if (!validIntent(saved, viewerId, orderId)) throw new Error("unreadable intent");
        setPending(saved);
      }
    } catch { setStorageBlocked(true); }
    setLoadedScope(scope);
  }, [scope, viewerId, orderId]);

  const visible = loadedScope === scope;
  const refundCents = pending?.refundCents ?? parseYuanToCents(refund);
  const ownerCents = pending?.ownerCents ?? parseYuanToCents(owner);
  const paidCents = pending?.paidCents ?? preview?.poststartEligibility?.refundCents ?? null;
  const reasonText = pending?.reason ?? reason.trim();
  const reasonValid = [...reasonText].length >= 3 && new TextEncoder().encode(reasonText).length <= 600 && !/[\u0000-\u001f\u007f]/.test(reasonText);
  const amountsValid = refundCents !== null && ownerCents !== null && paidCents !== null && cents.test(refundCents)
    && cents.test(ownerCents) && cents.test(paidCents) && BigInt(refundCents) + BigInt(ownerCents) <= BigInt(paidCents);
  const contribution = amountsValid ? (BigInt(paidCents!) - BigInt(refundCents!) - BigInt(ownerCents!)).toString() : null;
  const valid = visible && !storageBlocked && reasonValid && amountsValid && (pending !== null || preview?.poststartEligibility?.allowed === true);

  const openForm = async () => {
    if (!visible || busy) return;
    setOpen(true); setMessage("");
    if (pending) return;
    setPreview(null); setRefund(""); setOwner(""); setReason(""); setBusy(true);
    const epoch = identity.current.epoch;
    try {
      const next = await readSupportCancel(orderId);
      if (identity.current.epoch !== epoch || identity.current.scope !== scope) return;
      setPreview(next);
      if (!next.poststartEligibility?.allowed) setMessage("当前订单不能按此方式取消，请刷新订单并核对付款、结算和退款状态。");
    } catch {
      if (identity.current.epoch === epoch && identity.current.scope === scope) setMessage("暂时无法核对订单，请稍后重试。");
    } finally { if (identity.current.epoch === epoch && identity.current.scope === scope) setBusy(false); }
  };

  const submit = async () => {
    if (!valid || busy || !refundCents || !ownerCents || !paidCents) return;
    const epoch = identity.current.epoch, key = storageKey(viewerId, orderId);
    setBusy(true); setMessage("");
    try {
      await withSupplyWriteLock(key, async () => {
        const raw = window.localStorage.getItem(key);
        let frozen: CancelIntent;
        const replay = raw !== null;
        if (raw !== null) {
          const value: unknown = JSON.parse(raw);
          if (!validIntent(value, viewerId, orderId)) throw new Error("unreadable intent");
          frozen = value;
          if (!pending || pending.key !== frozen.key) {
            setPending(frozen); setConfirm(false); setMessage("本单已有待核对的原请求，请先检查原申请后再操作。");
            return;
          }
        } else {
          if (pending || !preview?.poststartEligibility?.allowed) throw new Error("missing original intent");
          frozen = { subject: viewerId, orderId, key: `support_cancel_${orderId}_${crypto.randomUUID()}`,
            revision: preview.orderRevision, paidCents, refundCents, ownerCents, reason: reasonText,
            ...(preview.simulationScope ? { simulationScope: preview.simulationScope } : {}) };
          if (!validIntent(frozen, viewerId, orderId)) throw new Error("invalid intent");
          window.localStorage.setItem(key, JSON.stringify(frozen));
        }
        if (identity.current.epoch !== epoch || identity.current.scope !== scope) return;
        setPending(frozen);
        const outcome = await sendSupportCancel(orderId, frozen.revision, frozen.reason, frozen.key,
          { refundCents: frozen.refundCents, ownerCents: frozen.ownerCents, expectedAdminId: frozen.subject });
        if (identity.current.epoch !== epoch || identity.current.scope !== scope) return;
        if (outcome.kind === "accepted" && outcome.view.simulationScope === frozen.simulationScope
          && outcome.view.poststartCancellation?.reason === frozen.reason
          && outcome.view.poststartCancellation.platformContributionCents === (BigInt(frozen.paidCents)-BigInt(frozen.refundCents)-BigInt(frozen.ownerCents)).toString()) {
          const stored: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
          if (!validIntent(stored, viewerId, orderId) || stored.key !== frozen.key) throw new Error("intent changed");
          window.localStorage.removeItem(key); setPending(null); setResult(outcome.view); setConfirm(false); setOpen(false);
          return;
        }
        if (outcome.kind === "blocked" && !replay) {
          const stored: unknown = JSON.parse(window.localStorage.getItem(key) ?? "null");
          if (!validIntent(stored, viewerId, orderId) || stored.key !== frozen.key) throw new Error("intent changed");
          window.localStorage.removeItem(key); setPending(null);
          setMessage("订单状态已变化，取消未被接受；请刷新后核对。");
        } else setMessage("取消结果未确认，请先查看订单状态；可在此按原请求重新核对，不要另建请求。");
      });
    } catch {
      if (identity.current.epoch === epoch && identity.current.scope === scope)
        setMessage("请求结果需要核对；请查看订单或保留原请求联系维护人员，不要重复提交。");
    } finally { if (identity.current.epoch === epoch && identity.current.scope === scope) setBusy(false); }
  };

  return <Card className={`im-support-fulfillment im-order-card${compact ? " oc-action-card" : ""}`} data-support-poststart-cancel="true">
    <CardContent className={compact ? "grid gap-2 p-0" : "grid gap-2 p-4"}>
      <CardTitle className="text-sm">取消订单并退款</CardTitle>
      <CardDescription>与双方沟通后填写退款与号主收益；本单取消后不产生分销佣金。</CardDescription>
      {visible && result ? <Alert><AlertTitle>订单已取消</AlertTitle><AlertDescription>退款责任已登记，实际退款结果请查看资金记录。</AlertDescription></Alert>
        : <Button variant="outline" size="sm" disabled={!visible || storageBlocked} onClick={() => void openForm()}>{pending ? "核对原取消请求" : "取消订单并退款"}</Button>}
      {visible && storageBlocked ? <p role="alert">原请求记录无法读取，已暂停操作，请联系维护人员。</p> : null}
    </CardContent>
    <Dialog open={visible && open} onOpenChange={next => { if (!busy) setOpen(next); }}>
      <DialogContent size="md" aria-label="填写取消订单方案">
        <DialogTitle>取消订单并退款</DialogTitle>
        <DialogDescription>订单 {displayNo}。填写双方协商结果，退款与号主收益合计不能超过本单实付。</DialogDescription>
        {pending ? <Alert><AlertTitle>上次请求结果未确认</AlertTitle><AlertDescription>请核对以下原申请；确认后只重试原请求。</AlertDescription></Alert> : null}
        {paidCents ? <p className="text-sm">本单实付：<strong>{formatFundingCents(paidCents)}</strong></p> : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="grid gap-1 text-sm">退还租客（元）<Input aria-label="退还租客金额" inputMode="decimal" value={pending ? formatInput(pending.refundCents) : refund} disabled={busy || !!pending} onChange={e => setRefund(e.target.value)} /></label>
          <label className="grid gap-1 text-sm">号主收益（元）<Input aria-label="号主收益金额" inputMode="decimal" value={pending ? formatInput(pending.ownerCents) : owner} disabled={busy || !!pending} onChange={e => setOwner(e.target.value)} /></label>
        </div>
        <p className="text-sm">平台结算贡献：{contribution === null ? "—" : formatFundingCents(contribution)}；分销佣金：¥0.00</p>
        <label className="grid gap-1 text-sm">取消原因<Input aria-label="取消原因" value={pending?.reason ?? reason} maxLength={200} disabled={busy || !!pending} onChange={e => setReason(e.target.value)} /></label>
        {message ? <p role="alert" className="text-sm text-destructive">{message}</p> : null}
        <div className="flex justify-end gap-2"><Button variant="outline" disabled={busy} onClick={() => setOpen(false)}>返回</Button>
          <Button disabled={!valid || busy} onClick={() => setConfirm(true)}>{pending ? "核对原请求" : "核对并取消"}</Button></div>
      </DialogContent>
    </Dialog>
    <ConfirmAlertDialog open={visible && confirm} onOpenChange={next => { if (!busy) setConfirm(next); }}
      title="确认取消订单？" contentLabel="确认取消已开租订单" description="确认后订单会立即取消，并登记以下资金分配；退款进度以渠道处理结果为准。"
      confirmLabel={busy ? "提交中…" : pending ? "按原请求核对" : "确认取消并退款"} cancelLabel="返回核对" busy={busy} confirmDisabled={!valid} onConfirm={() => void submit()}>
      <p>退还租客 {formatFundingCents(refundCents)} · 号主收益 {formatFundingCents(ownerCents)} · 平台贡献 {formatFundingCents(contribution)}</p>
      <p>取消原因：{reasonText}</p>
      {message ? <p role="alert" className="text-sm text-destructive">{message}</p> : null}
    </ConfirmAlertDialog>
  </Card>;
}

function formatInput(value: string): string {
  const amount = BigInt(value);
  return `${amount / 100n}.${String(amount % 100n).padStart(2, "0")}`;
}
