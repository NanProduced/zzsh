import { useState } from "react";
import { Ban, Check, Clock, FilePlus2, TriangleAlert, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Badge } from "../../components/ui/badge";
import { Alert, AlertDescription } from "../../components/ui/alert";
import {
  Timeline, TimelineContent, TimelineDate, TimelineHeader, TimelineIndicator,
  TimelineItem, TimelineSeparator, TimelineTitle,
} from "../../components/reui/timeline";
import {
  OPERATION_TITLES, actionBlockReason, actionFor, auditActionLabel, auditNarrative, canAct,
  isHighImpactOperation, objectRefLabel, objectRefPath, personLabel, requestStatusView,
  type ApprovalDecisionAmendment, type AuditEvent, type RequestDetail as Detail,
} from "./contract";
import { BusinessSummary } from "./business-summary";
import { RequestFlow } from "./request-flow";
import { ApprovalActionDialog, type ApprovalActionMode } from "./approval-action-dialog";
import { Fact, FactGrid, formatApprovalDate as formatDate } from "./atoms";

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
  detail, busy, blocked, error, canApprove, onOpenRequest, onOpenPath, onLocateRecovery, onDecide, onWithdraw,
}: {
  detail: Detail;
  busy: boolean;
  blocked: boolean;
  error?: string;
  /** 是否具备审批权限；纯客服为 false，此时不渲染批准/驳回按钮。 */
  canApprove: boolean;
  onOpenRequest: (requestId: string, title: string) => void;
  onOpenPath?: (path: string, title: string) => void;
  onLocateRecovery?: () => void;
  onDecide: (decision: "APPROVE" | "REJECT", reason: string, totpCode?: string, amendment?: ApprovalDecisionAmendment) => void;
  onWithdraw?: (reason: string) => void;
}) {
  const [contentOpen, setContentOpen] = useState(true);
  const [actionMode, setActionMode] = useState<ApprovalActionMode | null>(null);

  const actions = detail.actions;
  const highImpact = isHighImpactOperation(detail.operation.code);
  const status = requestStatusView({ status: detail.status, operationCode: detail.operation.code, business: detail.business });
  const title = detail.business?.businessTitle ?? OPERATION_TITLES[detail.operation.code] ?? "审批申请";
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

  return (
    <div className="space-y-5">
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

      {/* 流程图优先：先看当前走到哪一步，再看申请内容。 */}
      <section aria-label="审批流程" className="space-y-3 border-b border-border/60 pb-5">
        <div>
          <h3 className="text-sm font-semibold text-foreground">审批流程</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">点击节点查看该环节事实；批准与执行、资金到账分别确认。</p>
        </div>
        <RequestFlow detail={detail} />
      </section>

      <section className="rounded-md border border-border/60 p-3">
        <button type="button" className="flex w-full items-center justify-between gap-2 text-left" aria-expanded={contentOpen} onClick={() => setContentOpen((value) => !value)}>
          <span className="text-sm font-medium">申请内容</span>
          <span className="text-xs text-muted-foreground">{contentOpen ? "收起" : "展开"}</span>
        </button>
        {contentOpen ? (
          <div className="mt-4"><BusinessSummary business={detail.business} operationCode={detail.operation.code} onOpenPath={onOpenPath} /></div>
        ) : null}
      </section>

      <section aria-label="办理" className="space-y-3 rounded-md border border-border/60 p-3">
        <div>
          <h3 className="text-sm font-medium">办理</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">批准、驳回或撤回会打开确认窗口；高影响申请还需要动态验证码。</p>
        </div>

        {contentChanged ? (
          <Alert variant="warning" role="status">
            <TriangleAlert aria-hidden="true" />
            <AlertDescription>内容已变化，请驳回并请申请人重新提交。</AlertDescription>
          </Alert>
        ) : null}

        {settlementAwaitingOrder ? (
          <Alert variant="info" role="status">
            <AlertDescription className="flex flex-wrap items-center gap-2">
              这张结算调整已批准，请回订单完成双方确认和过账。
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
          <div className="flex flex-wrap gap-2">
            {canApproveAction ? <Button type="button" size="sm" variant="primary" disabled={busy || blocked} onClick={() => setActionMode("approve")}><Check />批准</Button> : null}
            {canRejectAction ? <Button type="button" size="sm" variant="danger" disabled={busy || blocked} onClick={() => setActionMode("reject")}><X />驳回</Button> : null}
            {canWithdrawAction && onWithdraw ? <Button type="button" size="sm" variant="secondary" disabled={busy || blocked} onClick={() => setActionMode("withdraw")}><Ban />撤回申请</Button> : null}
          </div>
        )}
      </section>

      <section aria-label="办理时间线" className="space-y-2">
        <h3 className="text-sm font-medium">办理时间线</h3>
        <div className="rounded-lg border border-border bg-foreground/[0.02] p-3"><CompactTimeline history={detail.history} /></div>
      </section>

      {detail.supersedesRequestId || detail.supersededByRequestId ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 p-3 text-xs">
          {detail.supersededByRequestId ? <span className="text-foreground">本申请已被另一申请替代，不再推进。</span> : null}
          {detail.supersedesRequestId ? <Button type="button" size="sm" variant="secondary" onClick={() => onOpenRequest(detail.supersedesRequestId!, "被替代的原申请")}>查看被替代的原申请</Button> : null}
          {detail.supersededByRequestId ? <Button type="button" size="sm" variant="secondary" onClick={() => onOpenRequest(detail.supersededByRequestId!, "替代本申请的申请")}>查看替代申请</Button> : null}
        </div>
      ) : null}

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
              <p className="text-xs font-medium text-muted-foreground">载荷正文（仅测试操作返回脱敏正文）</p>
              <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-foreground/[0.04] p-2 font-mono text-[11px]">{JSON.stringify(detail.operation.payload, null, 2)}</pre>
            </>
          ) : null}
        </div>
      </details>

      {actionMode ? (
        <ApprovalActionDialog
          open
          mode={actionMode}
          detail={detail}
          busy={busy}
          blocked={blocked}
          error={error}
          onClose={() => setActionMode(null)}
          onDecide={onDecide}
          onWithdraw={onWithdraw ?? (() => undefined)}
        />
      ) : null}
    </div>
  );
}
