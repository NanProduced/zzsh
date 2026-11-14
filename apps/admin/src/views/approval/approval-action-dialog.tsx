import { useEffect, useState } from "react";
import { Check, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Checkbox } from "../../components/ui/checkbox";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../components/ui/dialog";
import { Textarea } from "../../components/ui/textarea";
import { FieldLabel } from "./atoms";
import {
  OPERATION_TITLES,
  isHighImpactOperation,
  requestSummaryLine,
  type ApprovalDecisionAmendment,
  type EntitlementAmendmentPayload,
  type RequestDetail as Detail,
} from "./contract";
import { SmoothTotpInput } from "../../components/smoothui/animated-otp-input";
import { Input } from "../../components/ui/input";
import { beijingLocalToIso, formatBeijing } from "../../lib/audit-labels";
import {
  MembershipDateTimeField,
  formatCentsToYuan,
  parsePayableRatio,
  entitlementWindowError,
} from "../membership-entitlement-form";


const REASON_MAX = 500;

export type ApprovalActionMode = "approve" | "reject" | "withdraw";

export function ApprovalActionDialog({
  open,
  mode,
  detail,
  busy,
  blocked,
  error,
  onClose,
  onDecide,
  onWithdraw,
}: {
  open: boolean;
  mode: ApprovalActionMode;
  detail: Detail;
  busy: boolean;
  blocked: boolean;
  error?: string;
  onClose: () => void;
  onDecide: (decision: "APPROVE" | "REJECT", reason: string, totpCode?: string, amendment?: ApprovalDecisionAmendment) => void;
  onWithdraw: (reason: string) => void;
}) {
  const [reason, setReason] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [editRequested, setEditRequested] = useState(false);
  const [finalPayload, setFinalPayload] = useState<EntitlementAmendmentPayload | null>(
    () => detail.entitlementAmendment?.editablePayload ?? null,
  );
  const [depositAllowanceInput, setDepositAllowanceInput] = useState(() => {
    const payload = detail.entitlementAmendment?.editablePayload;
    return payload?.depositAllowanceCents && payload.depositAllowanceCents !== "0" && !payload.depositWaived
      ? formatCentsToYuan(payload.depositAllowanceCents)
      : "";
  });
  const [confirmCompensation, setConfirmCompensation] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [localError, setLocalError] = useState<string>();
  const [pricingTime, setPricingTime] = useState("");

  useEffect(() => {
    if (!open) return;
    setReason("");
    setTotpCode("");
    setEditRequested(false);
    setFinalPayload(detail.entitlementAmendment?.editablePayload ?? null);
    const payload = detail.entitlementAmendment?.editablePayload;
    setDepositAllowanceInput(payload?.depositAllowanceCents && payload.depositAllowanceCents !== "0" && !payload.depositWaived
      ? formatCentsToYuan(payload.depositAllowanceCents)
      : "");
    setConfirmCompensation(false);
    setSubmitting(false);
    setLocalError(undefined);
    setPricingTime("");
  }, [open, mode, detail.requestId, detail.entitlementAmendment]);

  const highImpact = isHighImpactOperation(detail.operation.code);
  const compensation = detail.operation.code === "order.compensation.grant";
  const canEdit = detail.entitlementAmendment != null;
  const allowanceValid = !depositAllowanceInput || /^(0|[1-9]\d*)(\.\d{1,2})?$/.test(depositAllowanceInput.trim());
  const editError = editRequested && finalPayload
    ? entitlementWindowError(finalPayload.startsAtUtc, finalPayload.endsAtUtc)
      || (parsePayableRatio(finalPayload.pricing.payableRatio) === null ? "请填写有效的应付比例（大于0且不超过1）" : "")
      || (!allowanceValid ? "押金减免额度须为合法人民币金额（最多2位小数）" : "")
      || (finalPayload.reason.trim().length < 2 ? "请填写礼遇办理原因" : "")
    : "";

  const buildAmendment = (): ApprovalDecisionAmendment | undefined => {
    if (detail.pricingTimeAmendment && pricingTime) return {
      expectedPayloadHash: detail.pricingTimeAmendment.expectedPayloadHash,
      finalPayload: { ...detail.pricingTimeAmendment.editablePayload, effectiveAt: beijingLocalToIso(pricingTime) },
    };
    if (!canEdit || !editRequested || !finalPayload) return undefined;
    const base = { ...finalPayload };
    const trimmed = depositAllowanceInput.trim();
    if (base.depositWaived) {
      if (base.depositAllowanceCents !== undefined) base.depositAllowanceCents = "0";
    } else if (trimmed && /^(0|[1-9]\d*)(\.\d{1,2})?$/.test(trimmed)) {
      const [whole = "0", fraction = ""] = trimmed.split(".");
      base.depositAllowanceCents = (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))).toString();
      base.depositWaived = false;
    } else if (base.depositAllowanceCents !== undefined) {
      base.depositAllowanceCents = "0";
    }
    return { expectedPayloadHash: detail.entitlementAmendment!.expectedPayloadHash, finalPayload: base };
  };

  const pricingTimeInvalid = pricingTime ? !(Date.parse(beijingLocalToIso(pricingTime)) > Date.now())
    : Boolean(detail.business?.pricingChange && Date.parse(detail.business.pricingChange.effectiveAt) <= Date.now());
  const approveDisabled = busy || blocked || submitting || (highImpact && !/^\d{6}$/.test(totpCode)) || (compensation && !confirmCompensation) || Boolean(editError) || pricingTimeInvalid;
  const rejectDisabled = busy || blocked || submitting || reason.trim().length < 3;
  const withdrawDisabled = busy || blocked || submitting;

  useEffect(() => {
    if (!submitting || busy) return;
    if (error) {
      setLocalError(error);
      setSubmitting(false);
      return;
    }
    onClose();
  }, [submitting, busy, error, onClose]);

  const submit = () => {
    if (mode === "approve") {
      if (approveDisabled) return;
      setLocalError(undefined);
      setSubmitting(true);
      onDecide("APPROVE", reason.trim(), highImpact ? totpCode : undefined, buildAmendment());
      return;
    }
    if (mode === "reject") {
      if (rejectDisabled) return;
      setLocalError(undefined);
      setSubmitting(true);
      onDecide("REJECT", reason.trim());
      return;
    }
    if (withdrawDisabled) return;
    setLocalError(undefined);
    setSubmitting(true);
    onWithdraw(reason.trim());
  };

  const title = mode === "approve" ? "批准申请" : mode === "reject" ? "驳回申请" : "撤回申请";
  const summary = requestSummaryLine({ operationCode: detail.operation.code, summary: detail.summary, business: detail.business });
  const operationTitle = OPERATION_TITLES[detail.operation.code] ?? detail.business?.businessTitle ?? "审批申请";
  const displayedError = localError ?? error;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onClose(); }}>
      <DialogContent size="md" className="max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription className="break-words">
            {operationTitle} · {summary}
          </DialogDescription>
        </DialogHeader>

        {mode === "approve" ? (
          <div className="space-y-4">
            {highImpact ? <div className="rounded-md border border-amber-500/30 bg-amber-500/10 p-3 text-sm leading-relaxed text-amber-900 dark:text-amber-200">
              这是高影响申请。批准前请输入身份验证器中的 6 位动态码。
            </div> : null}
            <label className="block space-y-1.5">
              <FieldLabel>办理意见（可选，最多 {REASON_MAX} 字）</FieldLabel>
              <Textarea value={reason} rows={3} maxLength={REASON_MAX} onChange={(event) => setReason(event.target.value)} placeholder="补充说明（可选）" />
            </label>
            {highImpact ? (
              <div className="space-y-2 rounded-md border border-border p-3">
                <FieldLabel>6 位动态验证码</FieldLabel>
                <SmoothTotpInput value={totpCode} onChange={setTotpCode} disabled={busy || submitting} autoFocus ariaLabel="批准动态验证码" />
                <p className="text-xs leading-relaxed text-muted-foreground">打开身份验证器，输入当前 6 位数字；不会自动提交。</p>
              </div>
            ) : null}
            {detail.pricingTimeAmendment && detail.business?.pricingChange ? <label className="block space-y-1.5">
              <FieldLabel>重选生效时间（北京时间）</FieldLabel>
              <Input type="datetime-local" value={pricingTime} onChange={event => setPricingTime(event.target.value)} disabled={busy || submitting} />
              <p className="text-sm text-muted-foreground">原计划 {formatBeijing(detail.business.pricingChange.effectiveAt)}。新时间须晚于当前时间，并仍在原公告有效期内。</p>
            </label> : null}
            {compensation ? (
              <label className="flex items-start gap-2 rounded-md border border-border/60 p-3 text-sm leading-relaxed">
                <Checkbox checked={confirmCompensation} onCheckedChange={(checked) => setConfirmCompensation(checked === true)} />
                <span>我已核对赔偿金额、事故依据和入账对象。</span>
              </label>
            ) : null}
            {canEdit && finalPayload ? (
              <details className="rounded-md border border-border/60 p-3 text-sm">
                <summary className="cursor-pointer">调整礼遇后批准</summary>
                <div className="mt-3 space-y-3">
                  <label className="flex items-center gap-2" htmlFor="approval-edit-requested">
                    <Checkbox id="approval-edit-requested" checked={editRequested} onCheckedChange={(checked) => setEditRequested(checked === true)} />
                    <span>按调整后的内容批准</span>
                  </label>
                  {editRequested ? (
                    <>
                      <p className="text-muted-foreground">保留原申请；以下内容作为本次最终批准结果。</p>
                      <label className="block space-y-1.5"><FieldLabel>应付比例</FieldLabel><input aria-label="批准应付比例" inputMode="decimal" className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm" value={finalPayload.pricing.payableRatio} onChange={(event) => setFinalPayload({ ...finalPayload, pricing: { ...finalPayload.pricing, payableRatio: event.target.value } })} /></label>
                      <MembershipDateTimeField label="批准开始时间" value={finalPayload.startsAtUtc} onChange={(value) => setFinalPayload({ ...finalPayload, startsAtUtc: value })} />
                      <MembershipDateTimeField label="批准结束时间" value={finalPayload.endsAtUtc} onChange={(value) => setFinalPayload({ ...finalPayload, endsAtUtc: value })} />
                      <label className="flex items-center gap-2" htmlFor="approval-deposit-waived">
                        <Checkbox id="approval-deposit-waived" checked={finalPayload.depositWaived} onCheckedChange={(checked) => { setFinalPayload({ ...finalPayload, depositWaived: checked === true }); if (checked) setDepositAllowanceInput(""); }} />
                        <span>独立免押</span>
                      </label>
                      {!finalPayload.depositWaived ? <label className="block space-y-1.5"><FieldLabel>押金减免额度（元）</FieldLabel><input aria-label="批准押金减免额度" inputMode="decimal" placeholder="0 表示不减免" className="h-9 w-full rounded-md border border-input bg-transparent px-2.5 text-sm" value={depositAllowanceInput} onChange={(event) => setDepositAllowanceInput(event.target.value)} /></label> : null}
                      <label className="block space-y-1.5"><FieldLabel>办理原因</FieldLabel><Textarea aria-label="批准礼遇原因" value={finalPayload.reason} maxLength={500} onChange={(event) => setFinalPayload({ ...finalPayload, reason: event.target.value })} /></label>
                      {editError ? <p role="alert" className="text-destructive">{editError}</p> : null}
                    </>
                  ) : null}
                </div>
              </details>
            ) : null}
          </div>
        ) : mode === "reject" ? (
          <label className="block space-y-1.5">
            <FieldLabel>驳回原因（至少 3 字，最多 {REASON_MAX} 字）</FieldLabel>
            <Textarea value={reason} rows={4} maxLength={REASON_MAX} onChange={(event) => setReason(event.target.value)} placeholder="说明驳回原因" autoFocus />
          </label>
        ) : (
          <div className="space-y-3">
            <p className="text-sm leading-relaxed text-muted-foreground">撤回后这张申请关闭，审批人不能再处理；如需继续办理，由来源业务重新发起。</p>
            <label className="block space-y-1.5">
              <FieldLabel>撤回原因（可选，最多 {REASON_MAX} 字）</FieldLabel>
              <Textarea value={reason} rows={3} maxLength={REASON_MAX} onChange={(event) => setReason(event.target.value)} placeholder="补充说明（可选）" autoFocus />
            </label>
          </div>
        )}

        {displayedError ? <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm leading-relaxed text-destructive">{displayedError}</p> : null}

        <DialogFooter>
          <Button type="button" size="sm" variant="ghost" disabled={submitting} onClick={onClose}>取消</Button>
          {mode === "approve" ? <Button type="button" size="sm" loading={submitting} disabled={approveDisabled} onClick={submit}><Check />确认批准</Button> : null}
          {mode === "reject" ? <Button type="button" size="sm" variant="danger" loading={submitting} disabled={rejectDisabled} onClick={submit}><X />确认驳回</Button> : null}
          {mode === "withdraw" ? <Button type="button" size="sm" variant="secondary" loading={submitting} disabled={withdrawDisabled} onClick={submit}>确认撤回</Button> : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
