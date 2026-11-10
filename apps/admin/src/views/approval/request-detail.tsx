import { useId, useState } from "react";
import { Check, X, Ban, Clock, FilePlus2, TriangleAlert } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Input } from "../../components/ui/input";
import { Checkbox } from "../../components/ui/checkbox";
import { Textarea } from "../../components/ui/textarea";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { ConfirmAlertDialog } from "../../components/ui/alert-dialog";
import {
  Timeline, TimelineContent, TimelineDate, TimelineHeader, TimelineIndicator,
  TimelineItem, TimelineSeparator, TimelineTitle,
} from "../../components/reui/timeline";
import {
  MembershipDateTimeField, parsePayableRatio, entitlementWindowError, formatCentsToYuan,
} from "../membership-entitlement-form";
import { financeMoney } from "../admin-finance-api";
import {
  actionBlockReason, actionFor, auditActionLabel, auditNarrative, canAct, isHighImpactOperation,
  objectRefLabel, objectRefPath, personLabel, requestStatusView,
  type ApprovalDecisionAmendment, type AuditEvent, type EntitlementAmendmentPayload,
  type RequestDetail as Detail,
} from "./contract";
import { BusinessSummary } from "./business-summary";
import { RequestFlow } from "./request-flow";
import { Fact, FactGrid, FieldLabel, formatApprovalDate as formatDate } from "./atoms";

const REASON_MAX = 500;

/** 实时复核凭据：高影响类型批准时只带 6 位动态码，绝不携带密码。 */
export type ApprovalStepUp = { totpCode: string };

function eventIcon(event: AuditEvent) {
  switch (event.action) {
    case "approval.request.created": return <FilePlus2 size={13} aria-hidden />;
    case "approval.request.approved": return <Check size={13} aria-hidden />;
    case "approval.request.rejected": return <X size={13} aria-hidden />;
    case "approval.request.cancelled":
    case "approval.request.withdrawn": return <Ban size={13} aria-hidden />;
    default: return <Clock size={13} aria-hidden />;
  }
}

/** 审计事件进入各申请详情的时间线，用「提交 / 批准 / 驳回 / 撤回 / 已生效」。 */
function CompactTimeline({ history }: { history: AuditEvent[] }) {
  if (history.length === 0) return <p className="text-xs text-muted-foreground">暂未读到这张申请的事件记录。</p>;
  return (
    <Timeline value={0} aria-label="申请时间线">
      {history.map((event, index) => (
        <TimelineItem key={event.eventId} step={index + 1}>
          <TimelineIndicator className="grid place-items-center border-border bg-surface text-muted-foreground">
            {eventIcon(event)}
          </TimelineIndicator>
          <TimelineSeparator className="bg-border" />
          <TimelineHeader>
            <TimelineDate dateTime={event.occurredAt ?? undefined}>{formatDate(event.occurredAt)}</TimelineDate>
            <TimelineTitle>{auditActionLabel(event.action)}</TimelineTitle>
          </TimelineHeader>
          <TimelineContent className="text-xs">
            <span>{personLabel(event.actor)}</span>
            <span className="mx-1.5 text-muted-foreground">·</span>
            <span className="break-words">{auditNarrative(event)}</span>
          </TimelineContent>
        </TimelineItem>
      ))}
    </Timeline>
  );
}

export function RequestDetail({
  detail, busy, blocked, canApprove, onOpenRequest, onOpenPath, onLocateRecovery, onDecide, onWithdraw,
}: {
  detail: Detail;
  busy: boolean;
  blocked: boolean;
  /** 是否具备审批权限；纯客服为 false，此时不渲染批准/驳回按钮。 */
  canApprove: boolean;
  onOpenRequest: (requestId: string, title: string) => void;
  onOpenPath?: (path: string, title: string) => void;
  onLocateRecovery?: () => void;
  onDecide: (decision: "APPROVE" | "REJECT", reason: string, totpCode?: string, amendment?: ApprovalDecisionAmendment) => void;
  onWithdraw?: (reason: string) => void;
}) {
  const [contentOpen, setContentOpen] = useState(true);
  const [flowView, setFlowView] = useState<false | "flow">(false);
  const [reason, setReason] = useState("");
  const [totpCode, setTotpCode] = useState("");
  const [confirmCompensation, setConfirmCompensation] = useState(false);
  const [editRequested, setEditRequested] = useState(false);
  const [finalPayload, setFinalPayload] = useState<EntitlementAmendmentPayload | null>(
    () => detail.entitlementAmendment?.editablePayload ?? null,
  );
  const [depositAllowanceInput, setDepositAllowanceInput] = useState(() => {
    const payload = detail.entitlementAmendment?.editablePayload;
    return payload?.depositAllowanceCents && payload.depositAllowanceCents !== "0" && !payload?.depositWaived
      ? formatCentsToYuan(payload.depositAllowanceCents)
      : "";
  });
  const totpId = useId();
  const reasonId = useId();
  const editId = useId();
  const depositId = useId();

  const actions = detail.actions;
  const highImpact = isHighImpactOperation(detail.operation.code);
  const status = requestStatusView({ status: detail.status, operationCode: detail.operation.code, business: detail.business });
  const title = detail.business?.businessTitle ?? OPERATION_FALLBACK_TITLE(detail.operation.code);
  const summaryLine = detail.business?.changeSummary || detail.summary;

  const canApproveAction = canAct(actions, "approve");
  const canRejectAction = canAct(actions, "reject");
  const canWithdrawAction = canAct(actions, "withdraw");
  const decisionAvailable = canApprove && (canApproveAction || canRejectAction || canWithdrawAction);

  const approveBlockReason = actionBlockReason(actions, "approve");
  const contentChanged = actionFor(actions, "approve")?.reasonCode === "OBJECT_VERSION_CHANGED"
    || Boolean(detail.statusReason && /变化|被修改|不一致/.test(detail.statusReason));
  const settlementAwaitingOrder = detail.operation.code === "order.settlement.adjust"
    && detail.status === "APPROVED" && detail.business?.settlementResult?.posted !== true;

  const refs = detail.business?.objectRefs ?? [];
  const sourcePath = refs.map((ref) => objectRefPath(ref)).find((path): path is string => path !== null) ?? null;

  const canEdit = canApproveAction && detail.entitlementAmendment != null;
  const allowanceValid = !depositAllowanceInput || /^(0|[1-9]\d*)(\.\d{1,2})?$/.test(depositAllowanceInput.trim());
  const editError = editRequested && finalPayload
    ? entitlementWindowError(finalPayload.startsAtUtc, finalPayload.endsAtUtc)
      || (parsePayableRatio(finalPayload.pricing.payableRatio) === null ? "请填写有效的应付比例（大于0且不超过1）" : "")
      || (!allowanceValid ? "押金减免额度须为合法人民币金额（最多2位小数）" : "")
      || (finalPayload.reason.trim().length < 2 ? "请填写礼遇办理原因" : "")
    : "";

  const buildAmendment = (): ApprovalDecisionAmendment | undefined => {
    if (!canEdit || !editRequested || !finalPayload) return undefined;
    const base = { ...finalPayload };
    const trimmed = depositAllowanceInput.trim();
    if (base.depositWaived) { if (base.depositAllowanceCents !== undefined) base.depositAllowanceCents = "0"; }
    else if (trimmed && /^(0|[1-9]\d*)(\.\d{1,2})?$/.test(trimmed)) {
      const [whole = "0", fraction = ""] = trimmed.split(".");
      base.depositAllowanceCents = (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))).toString();
      base.depositWaived = false;
    } else if (base.depositAllowanceCents !== undefined) base.depositAllowanceCents = "0";
    return { expectedPayloadHash: detail.entitlementAmendment!.expectedPayloadHash, finalPayload: base };
  };

  const totpReady = !highImpact || /^\d{6}$/.test(totpCode);
  const rejectReady = reason.trim().length >= 3;
  const approveDisabled = busy || blocked || !canApproveAction || !totpReady || Boolean(editError);

  const runApprove = () => {
    if (approveDisabled) return;
    const code = totpCode; setTotpCode("");
    onDecide("APPROVE", reason.trim(), highImpact ? code : undefined, buildAmendment());
    setReason(""); setEditRequested(false);
  };
  const clickApprove = () => {
    if (approveDisabled) return;
    if (detail.operation.code === "order.compensation.grant") setConfirmCompensation(true);
    else runApprove();
  };
  const clickReject = () => {
    if (busy || blocked || !canRejectAction || !rejectReady) return;
    onDecide("REJECT", reason.trim());
    setReason("");
  };
  const clickWithdraw = () => {
    if (busy || blocked || !canWithdrawAction) return;
    onWithdraw?.(reason.trim());
    setReason("");
  };

  const compensationAmount = detail.business?.compensation?.amountCents;

  return (
    <div className="space-y-5">
      {/* 页头 */}
      <div className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold break-words text-foreground">{title}</h3>
            <p className="mt-1 text-sm leading-relaxed break-words text-muted-foreground">{summaryLine}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={status.tone === "error" ? "destructive" : status.tone === "success" ? "success" : status.tone === "warning" ? "warning" : "outline"}>{status.label}</Badge>
            <Badge variant="outline">{highImpact ? "高" : detail.operation.code === "order.settlement.adjust" ? "中" : "低"}</Badge>
          </div>
        </div>
        <dl aria-label="申请基本信息" className="grid grid-cols-1 gap-x-6 gap-y-3 text-xs sm:grid-cols-2">
          <div><dt className="text-muted-foreground">申请人</dt><dd className="mt-1">{personLabel(detail.requester)}</dd></div>
          <div><dt className="text-muted-foreground">提交时间（北京时间）</dt><dd className="mt-1">{formatDate(detail.createdAt)}</dd></div>
        </dl>
        {detail.statusReason ? <p className="text-xs text-muted-foreground">{detail.statusReason}</p> : null}
      </div>

      {/* 申请内容卡（默认展开） */}
      <section className="rounded-md border border-border/60 p-3">
        <button type="button" className="flex w-full items-center justify-between gap-2 text-left" aria-expanded={contentOpen} onClick={() => setContentOpen((value) => !value)}>
          <span className="text-sm font-medium">申请内容</span>
          <span className="text-xs text-muted-foreground">{contentOpen ? "收起" : "展开"}</span>
        </button>
        {contentOpen ? (
          <div className="mt-4"><BusinessSummary business={detail.business} operationCode={detail.operation.code} /></div>
        ) : null}
      </section>

      {/* 决定区 */}
      <section aria-label="决定区" className="space-y-3 rounded-md border border-border/60 p-3">
        <h3 className="text-sm font-medium">办理</h3>

        {contentChanged ? (
          <Alert variant="warning" role="status">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>内容已变化，请驳回并请申请人重新提交。</AlertDescription>
          </Alert>
        ) : null}

        {settlementAwaitingOrder ? (
          <Alert variant="info" role="status">
            <AlertDescription className="flex flex-wrap items-center gap-2">
              请回订单完成双方确认和过账。
              {sourcePath && onOpenPath ? <Button type="button" size="sm" variant="secondary" onClick={() => onOpenPath(sourcePath, "来源订单")}>前往订单</Button> : null}
            </AlertDescription>
          </Alert>
        ) : null}

        {blocked && onLocateRecovery ? (
          <div><Button type="button" size="sm" variant="secondary" onClick={onLocateRecovery}>查看原结果核对</Button></div>
        ) : null}

        {!decisionAvailable ? (
          <p className="text-xs leading-relaxed text-muted-foreground" role="status">
            {!canApprove
              ? "当前账号没有审批权限，只能查看申请内容。"
              : detail.statusReason || approveBlockReason || "当前不能批准或驳回；这张申请已处理或你不在可办理范围内。"}
          </p>
        ) : (
          <div className="space-y-3">
            <label className="block space-y-1.5" htmlFor={reasonId}>
              <FieldLabel>{canRejectAction ? `办理意见（驳回需至少 3 字，最多 ${REASON_MAX} 字）` : `办理意见（可选，最多 ${REASON_MAX} 字）`}</FieldLabel>
              <Textarea id={reasonId} value={reason} rows={2} maxLength={REASON_MAX} onChange={(event) => setReason(event.target.value)} placeholder="补充说明（可选）" />
            </label>

            {highImpact && canApproveAction ? (
              <div className="space-y-2 rounded-md border border-border p-3">
                <p className="text-[11px] leading-relaxed text-muted-foreground">这是高影响申请，批准需输入身份验证器中的 6 位动态码。</p>
                <div className="flex flex-wrap items-end gap-3">
                  <label className="block space-y-1.5" htmlFor={totpId}>
                    <FieldLabel>6 位动态验证码</FieldLabel>
                    <Input id={totpId} aria-label="批准动态验证码" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={totpCode}
                      onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, "").slice(0, 6))} className="w-40 font-mono tracking-widest" />
                  </label>
                </div>
              </div>
            ) : null}

            {canEdit ? (
              <details className="rounded-md border border-border/60 p-3 text-xs">
                <summary className="cursor-pointer">调整礼遇后批准</summary>
                <div className="mt-3 space-y-3">
                  <div className="flex items-center gap-2"><Checkbox id={editId} checked={editRequested} onCheckedChange={(checked) => setEditRequested(checked === true)} /><label htmlFor={editId}>按调整后的内容批准</label></div>
                  {editRequested && finalPayload ? (
                    <>
                      <p className="text-muted-foreground">保留原申请；以下内容作为本次最终批准结果。</p>
                      <label className="block space-y-1.5"><FieldLabel>应付比例</FieldLabel><Input aria-label="批准应付比例" inputMode="decimal" value={finalPayload.pricing.payableRatio} onChange={(event) => setFinalPayload({ ...finalPayload, pricing: { ...finalPayload.pricing, payableRatio: event.target.value } })} /></label>
                      <MembershipDateTimeField label="批准开始时间" value={finalPayload.startsAtUtc} onChange={(value) => setFinalPayload({ ...finalPayload, startsAtUtc: value })} />
                      <MembershipDateTimeField label="批准结束时间" value={finalPayload.endsAtUtc} onChange={(value) => setFinalPayload({ ...finalPayload, endsAtUtc: value })} />
                      <div className="flex items-center gap-2"><Checkbox id={depositId} checked={finalPayload.depositWaived} onCheckedChange={(checked) => { setFinalPayload({ ...finalPayload, depositWaived: checked === true }); if (checked) setDepositAllowanceInput(""); }} /><label htmlFor={depositId}>独立免押</label></div>
                      {!finalPayload.depositWaived ? <label className="block space-y-1.5"><FieldLabel>押金减免额度（元）</FieldLabel><Input aria-label="批准押金减免额度" inputMode="decimal" placeholder="0 表示不减免" value={depositAllowanceInput} onChange={(event) => setDepositAllowanceInput(event.target.value)} /></label> : null}
                      <label className="block space-y-1.5"><FieldLabel>办理原因</FieldLabel><Textarea aria-label="批准礼遇原因" value={finalPayload.reason} maxLength={500} onChange={(event) => setFinalPayload({ ...finalPayload, reason: event.target.value })} /></label>
                      {editError ? <p role="alert" className="text-destructive">{editError}</p> : null}
                    </>
                  ) : null}
                </div>
              </details>
            ) : null}

            <div className="flex flex-wrap gap-2">
              {canApproveAction ? <Button type="button" size="sm" variant="primary" loading={busy && canApproveAction} disabled={approveDisabled} onClick={clickApprove}>确认批准</Button> : null}
              {canRejectAction ? <Button type="button" size="sm" variant="danger" disabled={busy || blocked || !rejectReady} onClick={clickReject}>确认驳回</Button> : null}
              {canWithdrawAction && onWithdraw ? <Button type="button" size="sm" variant="secondary" disabled={busy || blocked} onClick={clickWithdraw}>撤回申请</Button> : null}
            </div>
            {canApproveAction && !totpReady ? <p className="text-xs text-muted-foreground">请输入 6 位动态验证码后再批准。</p> : null}
          </div>
        )}
      </section>

      {/* 缩小的流程或时间线 */}
      <section aria-label="流程与时间线" className="space-y-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-medium">办理时间线</h3>
          <Button type="button" size="sm" variant="ghost" aria-pressed={flowView === "flow"} onClick={() => setFlowView((value) => value === "flow" ? false : "flow")}>{flowView === "flow" ? "收起流程图" : "查看流程图"}</Button>
        </div>
        {flowView === "flow" ? (
          <div className="rounded-lg border border-border p-2"><RequestFlow detail={detail} /></div>
        ) : (
          <div className="rounded-lg border border-border bg-foreground/[0.02] p-3"><CompactTimeline history={detail.history} /></div>
        )}
      </section>

      {detail.supersedesRequestId || detail.supersededByRequestId ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 p-3 text-xs">
          {detail.supersededByRequestId ? <span className="text-foreground">本申请已被另一申请替代，不再推进。</span> : null}
          {detail.supersedesRequestId ? <Button type="button" size="sm" variant="secondary" onClick={() => onOpenRequest(detail.supersedesRequestId!, "被替代的原申请")}>查看被替代的原申请</Button> : null}
          {detail.supersededByRequestId ? <Button type="button" size="sm" variant="secondary" onClick={() => onOpenRequest(detail.supersededByRequestId!, "替代本申请的申请")}>查看替代申请</Button> : null}
        </div>
      ) : null}

      {/* 作用对象：没有可跳转页面的类型只列名称，不造死按钮、不说无导航 */}
      {refs.length > 0 ? (
        <section className="space-y-2">
          <h3 className="text-sm font-medium">涉及对象</h3>
          <ul className="flex flex-wrap gap-1.5">
            {refs.filter((ref) => ref.id).map((ref) => {
              const path = objectRefPath(ref);
              return (
                <li key={`${ref.type}-${ref.id}`}>
                  {path && onOpenPath
                    ? <Button type="button" size="sm" variant="secondary" onClick={() => onOpenPath(path, objectRefLabel(ref.type))}>{objectRefLabel(ref.type)}</Button>
                    : <Badge variant="outline">{objectRefLabel(ref.type)}</Badge>}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {/* 技术详情：折叠到页脚，默认不显示编号/触发条件/哈希/事件编码 */}
      <details className="rounded-md border border-border/60 p-3">
        <summary className="cursor-pointer text-sm font-medium">技术详情</summary>
        <div className="mt-3 space-y-3 text-xs">
          <FactGrid>
            <Fact label="申请编号" value={detail.requestId} mono />
            <Fact label="业务操作" value={detail.operation.code} mono />
            <Fact label="触发条件" value={detail.operation.triggerCondition} mono />
            <Fact label="载荷版本" value={`v${detail.operation.payloadVersion}`} />
            <Fact label="内容校验值" value={detail.operation.payloadHash} mono />
            <Fact label="模板版本" value={`v${detail.template.version}`} />
          </FactGrid>
          {detail.history.length > 0 ? (
            <p className="break-all text-muted-foreground">事件编码：{detail.history.map((event) => event.action).join("、")}</p>
          ) : null}
          {detail.operation.payload ? (
            <>
              <FieldLabel>载荷正文（仅测试操作返回脱敏正文）</FieldLabel>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-foreground/[0.04] p-2 font-mono text-[11px]">{JSON.stringify(detail.operation.payload, null, 2)}</pre>
            </>
          ) : null}
        </div>
      </details>

      <ConfirmAlertDialog open={confirmCompensation} onOpenChange={setConfirmCompensation} contentLabel="确认包赔入账" title="确认批准并入账？"
        description={`赔偿 ${financeMoney(compensationAmount)} 将记入本单号主余额；请核对事故与依据。`}
        confirmLabel="确认批准并入账" cancelLabel="返回核对" onConfirm={() => { setConfirmCompensation(false); runApprove(); }} />
    </div>
  );
}

function OPERATION_FALLBACK_TITLE(code: string): string {
  const map: Record<string, string> = {
    "membership.benefit.policy.publish": "发布会员权益政策",
    "distribution.policy.publish": "调整分销政策",
    "order.compensation.grant": "订单全额包赔赔偿",
    "order.settlement.adjust": "人工调整订单结算",
    "membership.entitlement.grant": "发放会员礼遇",
    "membership.entitlement.replace": "替换会员礼遇",
    "membership.entitlement.revoke": "撤销会员礼遇",
  };
  return map[code] ?? "审批申请";
}
