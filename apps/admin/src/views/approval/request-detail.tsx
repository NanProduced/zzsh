import { useEffect, useId, useRef, useState } from "react";
import {
  Ban, Check, Clock, FilePlus2, Settings2, UserPlus, X, Play, TriangleAlert,
} from "lucide-react";

import { Button } from "../../components/ui-elements";
import { Badge } from "../../components/ui/badge";
import {
  Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogTitle,
} from "../../components/ui/dialog";
import { Input } from "../../components/ui/input";
import { Checkbox } from "../../components/ui/checkbox";
import { MembershipDateTimeField, parsePayableRatio, entitlementWindowError, formatCentsToYuan } from "../membership-entitlement-form";
import { Textarea } from "../../components/ui/textarea";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select";
import {
  Timeline, TimelineContent, TimelineDate, TimelineHeader, TimelineIndicator,
  TimelineItem, TimelineSeparator, TimelineTitle,
} from "../../components/reui/timeline";
import { adminRequest, formatDate, friendlyError } from "../../api";
import {
  ACTION_LABELS, APPROVAL_ACTION_NAMES, actionBlockReason, actionFor, auditActionLabel, auditNarrative,
  auditOutcomeView, businessProgress, canAct, candidateAvailabilityLabel, executionModeLabel,
  executionProgress, nextStepLabel, objectRefLabel, objectRefPath, personLabel, reasonLabel, statusView,
  type ActionEligibility, type AuditEvent, type Candidate, type CandidateOptions, type RequestDetail as Detail,
  type ApprovalDecisionAmendment, type EntitlementAmendmentPayload,
} from "./contract";
import { BusinessSummary } from "./business-summary";
import { RequestFlow } from "./request-flow";
import { Fact, FactGrid, FieldLabel, NotApplicable, Section, SectionTitle, StatusFact, UnknownFact } from "./atoms";

const REASON_MAX = 500;

function eventIcon(event: AuditEvent) {
  if (event.outcome === "FAILURE") return <TriangleAlert size={13} aria-hidden />;
  switch (event.action) {
    case "approval.request.created": return <FilePlus2 size={13} aria-hidden />;
    case "approval.request.approved": return <Check size={13} aria-hidden />;
    case "approval.request.rejected": return <X size={13} aria-hidden />;
    case "approval.request.cancelled": return <Ban size={13} aria-hidden />;
    case "approval.request.expired": return <Clock size={13} aria-hidden />;
    case "approval.request.candidate_added": return <UserPlus size={13} aria-hidden />;
    case "approval.execution.completed": return <Play size={13} aria-hidden />;
    case "approval.template.configured": return <Settings2 size={13} aria-hidden />;
    default: return <Clock size={13} aria-hidden />;
  }
}

/**
 * 事件按真实结果逐项显示。Timeline 的 value 固定为 0，使 step<=activeStep 恒不成立，
 * 连接线保持中性——否则驳回/失败/过期会被渲染成“流程已完成”。
 */
function HistoryTimeline({ history }: { history: AuditEvent[] }) {
  if (history.length === 0) return <p className="text-xs text-muted-foreground">暂未读到这张申请的事件记录。</p>;
  return (
    <Timeline value={0} aria-label="申请事件记录">
      {history.map((event, index) => {
        const outcome = auditOutcomeView(event.outcome);
        return (
          <TimelineItem key={event.eventId} step={index + 1}>
            <TimelineIndicator className="grid place-items-center border-border bg-surface text-muted-foreground">
              {eventIcon(event)}
            </TimelineIndicator>
            <TimelineSeparator className="bg-border" />
            <TimelineHeader>
              <TimelineDate dateTime={event.occurredAt ?? undefined}>{formatDate(event.occurredAt)}</TimelineDate>
              <TimelineTitle className="flex flex-wrap items-center gap-2">
                {auditActionLabel(event.action)}
                <span className={`text-xs font-normal ${outcome.tone === "error" ? "text-destructive" : outcome.tone === "success" ? "text-emerald-700 dark:text-emerald-300" : "text-muted-foreground"}`}>
                  {outcome.label}
                </span>
              </TimelineTitle>
            </TimelineHeader>
            <TimelineContent className="text-xs">
              <span>{personLabel(event.actor)}</span>
              <span className="mx-1.5 text-muted-foreground">·</span>
              <span className="break-words">{auditNarrative(event)}</span>
              <details className="mt-1 text-[11px] text-muted-foreground"><summary className="cursor-pointer">技术标识</summary><span className="font-mono">{event.action}</span></details>
            </TimelineContent>
          </TimelineItem>
        );
      })}
    </Timeline>
  );
}

function Candidates({ candidates, availability }: { candidates: Candidate[]; availability: Detail["candidateAvailability"] }) {
  const summary = candidateAvailabilityLabel(availability);
  return (
    <Section
      title="候选审批人"
      hint="名单上的资格是通用审批资格（账号状态、双因素、通用审批权限）。能不能处理这一单还取决于该操作的业务权限与游戏范围，以候选可用汇总与逐项动作资格为准。"
    >
      {candidates.length === 0 ? <p className="text-xs text-muted-foreground">候选快照为空。</p> : (
        <ul className="flex flex-wrap gap-1.5">
          {candidates.map((candidate) => (
            <li key={`${candidate.username}-${candidate.source ?? "TEMPLATE"}`}>
              <Badge variant={candidate.eligible === true ? "outline" : "unknown"}>
                {personLabel(candidate)}
                <span className="text-muted-foreground">·</span>
                {candidate.eligible === true ? "具备通用审批资格" : candidate.status === "FROZEN" ? "已冻结，通用资格不满足" : "通用资格不满足"}
                <span className="text-muted-foreground">·</span>
                {candidate.source === "APPENDED" ? "追加" : "模板"}
              </Badge>
            </li>
          ))}
        </ul>
      )}
      {summary ? <p className="text-xs text-muted-foreground">{summary}</p> : <UnknownFact hint="服务端未提供候选可用性汇总。" />}
      <p className="text-xs text-muted-foreground">
        徽标只表示通用审批资格；本单是否有人可处理看上一步的候选可用汇总，本人能否处理看逐项动作资格。
      </p>
    </Section>
  );
}

function AddCandidateForm({ requestId, busy, blocked, onAppend }: { requestId: string; busy: boolean; blocked: boolean; onAppend: (username: string, reason: string) => void }) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<CandidateOptions | null>(null);
  const [loadError, setLoadError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [username, setUsername] = useState("");
  const [reason, setReason] = useState("");

  // 候选人读取用审批专用接口，不要求全管理员目录权限。
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setLoadError(undefined);
    adminRequest<CandidateOptions>("/security/approvals/candidate-options?requestId=" + encodeURIComponent(requestId))
      .then((data) => { if (!cancelled) setOptions(data); })
      .catch((failure) => { if (!cancelled) { setOptions(null); setLoadError(friendlyError(failure)); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, requestId, nonce]);

  const eligible = options?.candidates ?? [];
  const excluded = Object.entries(options?.excludedByReason ?? {});
  const items = eligible.map((candidate) => ({ value: candidate.username, label: personLabel(candidate) }));

  return (
    <div className="rounded-md border border-border/60 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <SectionTitle hint="追加的候选人必须是当前对这一张申请合格的人；原配置名单不会被删除或跳过。">追加审批人</SectionTitle>
        <Button type="button" size="sm" variant="secondary" disabled={busy || blocked} onClick={() => setOpen((value) => !value)}>
          {open ? "收起" : "追加审批人"}
        </Button>
      </div>
      {open ? (
        <div className="mt-3 space-y-3">
          {loading ? <p className="text-xs text-muted-foreground">正在读取可选审批人…</p> : null}
          {loadError ? <NotApplicable reason={`读不到可选审批人：${loadError}`} /> : null}
          {options && !loading ? (
            <>
              {eligible.length === 0 ? (
                <p className="text-xs leading-relaxed text-muted-foreground">
                  当前没有可追加的合格审批人。{excluded.length > 0 ? `另有 ${excluded.map(([code, count]) => `${count} 人${reasonLabel(code)}`).join("、")}，不列出身份。` : ""}
                </p>
              ) : (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <label className="block min-w-0">
                    <FieldLabel>选择审批人（仅列出对这一单合格的人）</FieldLabel>
                    <Select value={username} onValueChange={(value) => setUsername(value ?? "")} items={items}>
                      <SelectTrigger className="h-9 w-full focus-visible:outline-none!"><SelectValue /></SelectTrigger>
                      <SelectContent>
                        {eligible.map((candidate) => (
                          <SelectItem key={candidate.username} value={candidate.username}>{personLabel(candidate)}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </label>
                  <label className="block min-w-0">
                    <FieldLabel>追加原因（至少 3 字，最多 {REASON_MAX} 字）</FieldLabel>
                    <Input value={reason} maxLength={REASON_MAX} onChange={(event) => setReason(event.target.value)} placeholder="为什么需要追加这位审批人" />
                  </label>
                </div>
              )}
              {excluded.length > 0 && eligible.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  另有 {excluded.map(([code, count]) => `${count} 人${reasonLabel(code)}`).join("、")}，按合同不列出身份。
                  {options.requesterExcluded ? " 原申请人已排除。" : ""}
                </p>
              ) : null}
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button" size="sm" variant="secondary" loading={busy}
                  disabled={busy || blocked || loading || !username || reason.trim().length < 3}
                  onClick={() => { onAppend(username, reason.trim()); setReason(""); setUsername(""); setOpen(false); }}
                >
                  提交追加
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={loading} onClick={() => setNonce((value) => value + 1)}>重新读取可选审批人</Button>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function DecisionDialog({
  kind, detail, onClose, onSubmit,
}: {
  kind: "approve" | "reject" | "execute" | null;
  detail: Detail;
  onClose: () => void;
  onSubmit: (kind: "approve" | "reject" | "execute", reason: string, amendment?: ApprovalDecisionAmendment) => void;
}) {
  const [reason, setReason] = useState("");
  const [recall, setRecall] = useState("");
  const [editRequested, setEditRequested] = useState(false);
  const editId = useId();
  const depositId = useId();
  const [finalPayload, setFinalPayload] = useState<EntitlementAmendmentPayload | null>(null);
  const [depositAllowanceInput, setDepositAllowanceInput] = useState(() => {
    const payload = detail.entitlementAmendment?.editablePayload;
    return payload?.depositAllowanceCents && payload.depositAllowanceCents !== "0" && !payload?.depositWaived
      ? formatCentsToYuan(payload.depositAllowanceCents)
      : "";
  });
  const canEdit = kind === "approve" && detail.entitlementAmendment != null;
  const allowanceValid = !depositAllowanceInput || /^(0|[1-9]\d*)(\.\d{1,2})?$/.test(depositAllowanceInput.trim());
  const editError = editRequested && finalPayload
    ? entitlementWindowError(finalPayload.startsAtUtc, finalPayload.endsAtUtc)
      || (parsePayableRatio(finalPayload.pricing.payableRatio) === null ? "请填写有效的应付比例（大于0且不超过1）" : "")
      || (!allowanceValid ? "押金减免额度须为合法人民币金额（最多2位小数）" : "")
      || (finalPayload.reason.trim().length < 2 ? "请填写礼遇办理原因" : "")
    : "";
  const change = detail.business?.changeSummary ?? detail.summary;
  const recallTarget = detail.summary.slice(0, 8);
  const rejectRequiresReason = kind === "reject";
  const disabled = Boolean(editError) || (kind === null
    ? true
    : rejectRequiresReason
      ? reason.trim().length < 3
      : kind === "execute"
        ? recall.trim() !== recallTarget
        : false);

  useEffect(() => {
    setEditRequested(false);
    const payload = detail.entitlementAmendment?.editablePayload ?? null;
    setFinalPayload(payload);
    const initialCents = payload?.depositAllowanceCents;
    if (initialCents && initialCents !== "0" && !payload?.depositWaived) {
      setDepositAllowanceInput(formatCentsToYuan(initialCents));
    } else {
      setDepositAllowanceInput("");
    }
    if (kind === null) { setReason(""); setRecall(""); }
  }, [kind, detail.requestId, detail.entitlementAmendment?.editablePayload]);

  const title = kind === "approve" ? "确认批准" : kind === "reject" ? "确认驳回" : "确认执行";
  const consequence = kind === "approve"
    ? (detail.business?.executionMode === "SOURCE_BUSINESS"
      ? "批准后本申请进入待执行；本业务由来源流程完成双方确认、客服复核与过账，审批页不会代为到账。"
      : "批准后本申请进入待执行；执行是独立步骤，批准不代表执行完成或资金到账。")
    : kind === "reject"
      ? "驳回后原申请关闭且不会复活；如需再次办理请由来源业务重新发起。"
      : "执行结果单独记录，不可撤销。执行成功只代表本次执行完成，业务对象是否生效以领域结果为准。";

  return (
    <Dialog open={kind !== null} onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{consequence}</DialogDescription>
        <div className="space-y-3 text-xs">
          <div className="space-y-1.5 rounded-md border border-border bg-foreground/[0.02] p-3">
            <p className="text-sm font-medium text-foreground">{detail.business?.businessTitle ?? "业务摘要未接入"}</p>
            <p className="leading-relaxed break-words text-muted-foreground">{change}</p>
            <p><span className="text-muted-foreground">申请人：</span>{personLabel(detail.requester)}</p>
            <p><span className="text-muted-foreground">申请编号：</span><span className="font-mono break-all">{detail.requestId}</span></p>
            {detail.business?.objectRefs?.length ? (
              <p className="break-words">
                <span className="text-muted-foreground">作用对象：</span>
                {detail.business.objectRefs.filter((ref) => ref.id).map((ref) => `${objectRefLabel(ref.type)} ${ref.id}`).join("；")}
              </p>
            ) : null}
            <p><span className="text-muted-foreground">载荷哈希：</span><span className="font-mono break-all">{detail.operation.payloadHash}</span></p>
          </div>
          {canEdit ? <div className="space-y-3 rounded-md border border-border p-3">
            <div className="flex items-center gap-2"><Checkbox id={editId} checked={editRequested} onCheckedChange={checked => setEditRequested(checked === true)} /><label htmlFor={editId}>调整礼遇后批准</label></div>
            {editRequested && finalPayload ? <div className="space-y-3">
              <p className="text-xs text-muted-foreground">保留原申请；以下内容将作为本次最终批准结果。</p>
              <label className="block space-y-1.5"><FieldLabel>应付比例</FieldLabel><Input aria-label="批准应付比例" inputMode="decimal" value={finalPayload.pricing.payableRatio} onChange={event => setFinalPayload({ ...finalPayload, pricing: { ...finalPayload.pricing, payableRatio: event.target.value } })} /></label>
              <p className="text-[11px] text-muted-foreground">
                适用范围：{finalPayload.pricing.scope === "ALL_ENABLED_RENTAL_MODES"
                  ? "全部已启用租赁方式统一"
                  : typeof finalPayload.pricing.mode === "string"
                    ? `旧版 · ${({ ordinary: "普通", custom: "自定义", fast: "极速" } as Record<string, string>)[finalPayload.pricing.mode] ?? finalPayload.pricing.mode}`
                    : "范围待核"}（不可修改）。受益人、游戏、礼遇类型、政策与成本引用同样不可修改。
              </p>
              <MembershipDateTimeField label="批准开始时间" value={finalPayload.startsAtUtc} onChange={value => setFinalPayload({ ...finalPayload, startsAtUtc: value })} />
              <MembershipDateTimeField label="批准结束时间" value={finalPayload.endsAtUtc} onChange={value => setFinalPayload({ ...finalPayload, endsAtUtc: value })} />
              <div className="space-y-2">
                <div className="flex items-center gap-2"><Checkbox id={depositId} checked={finalPayload.depositWaived} onCheckedChange={checked => { setFinalPayload({ ...finalPayload, depositWaived: checked === true }); if (checked) setDepositAllowanceInput(""); }} /><label htmlFor={depositId}>独立免押</label></div>
                {!finalPayload.depositWaived ? (
                  <label className="block space-y-1.5"><FieldLabel>押金减免额度（元）</FieldLabel><Input aria-label="批准押金减免额度" inputMode="decimal" placeholder="0 表示不减免" value={depositAllowanceInput} onChange={event => setDepositAllowanceInput(event.target.value)} /></label>
                ) : null}
              </div>
              <label className="block space-y-1.5"><FieldLabel>办理原因</FieldLabel><Textarea aria-label="批准礼遇原因" value={finalPayload.reason} maxLength={500} onChange={event => setFinalPayload({ ...finalPayload, reason: event.target.value })} /></label>
              {editError ? <p role="alert" className="text-destructive">{editError}</p> : null}
            </div> : null}
          </div> : null}
          {kind === "approve" || kind === "reject" ? (
            <label className="block space-y-1.5">
              <FieldLabel>{rejectRequiresReason ? `驳回原因（必填，至少 3 字，最多 ${REASON_MAX} 字）` : `批准意见（可选，最多 ${REASON_MAX} 字）`}</FieldLabel>
              <Textarea
                value={reason} rows={2} maxLength={REASON_MAX}
                onChange={(event) => setReason(event.target.value)}
                placeholder={rejectRequiresReason ? "说明驳回依据" : "补充说明（可选）"}
              />
            </label>
          ) : null}
          {kind === "execute" ? (
            <label className="block space-y-1.5">
              <FieldLabel>复述申请摘要前 8 字以确认：{recallTarget}</FieldLabel>
              <Input value={recall} onChange={(event) => setRecall(event.target.value)} className="font-mono" placeholder="复述摘要前 8 字" />
            </label>
          ) : null}
        </div>
        <DialogFooter>
          <DialogClose render={<Button variant="secondary" size="sm" />}>取消</DialogClose>
          <Button type="button" size="sm" variant={kind === "approve" ? "primary" : "danger"} disabled={disabled} onClick={() => {
            if (!kind) return;
            const amendment = canEdit && editRequested && finalPayload ? {
              expectedPayloadHash: detail.entitlementAmendment!.expectedPayloadHash,
              finalPayload: (() => {
                const base = { ...finalPayload };
                const trimmed = depositAllowanceInput.trim();
                if (base.depositWaived) {
                  if (base.depositAllowanceCents !== undefined) base.depositAllowanceCents = "0";
                } else if (trimmed && /^(0|[1-9]\d*)(\.\d{1,2})?$/.test(trimmed)) {
                  const [whole = "0", fraction = ""] = trimmed.split(".");
                  base.depositAllowanceCents = (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"))).toString();
                  base.depositWaived = false;
                } else {
                  if (base.depositAllowanceCents !== undefined) base.depositAllowanceCents = "0";
                }
                return base;
              })()
            } : undefined;
            onSubmit(kind, reason.trim(), amendment);
          }}>
            {kind === "approve" ? "确认批准" : kind === "reject" ? "确认驳回" : "确认执行"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ActionButton({ eligibility, busy, blocked, onClick }: { eligibility: ActionEligibility; busy: boolean; blocked: boolean; onClick: () => void }) {
  const label = ACTION_LABELS[eligibility.action] ?? eligibility.action;
  const block = eligibility.allowed ? null : actionBlockReason([eligibility], eligibility.action);
  // 只有真正可办理时才给饱和色：禁用态用中性 secondary，避免危险色成为页面唯一的高饱和块。
  const variant = !eligibility.allowed
    ? "secondary"
    : eligibility.action === "reject"
      ? "danger"
      : eligibility.action === "approve" || eligibility.action === "execute"
        ? "primary"
        : "secondary";
  const button = (
    <Button
      type="button" size="sm" variant={variant}
      loading={busy && eligibility.allowed}
      disabled={!eligibility.allowed || busy || blocked}
      onClick={onClick}
    >
      {label}
    </Button>
  );
  if (!block) return button;
  return (
    <Tooltip>
      <TooltipTrigger render={<span tabIndex={0} className="inline-flex cursor-not-allowed focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring" />}>{button}</TooltipTrigger>
      <TooltipContent className="max-w-64">{block}</TooltipContent>
    </Tooltip>
  );
}

export function RequestDetail({
  detail, busy, blocked, onOpenRequest, onOpenPath, onLocateRecovery, onDecide, onExecute, onAppend,
}: {
  detail: Detail;
  busy: boolean;
  blocked: boolean;
  onOpenRequest: (requestId: string, title: string) => void;
  /** 跨对象导航由工作区壳提供；未透传时来源对象只列标识，不渲染死按钮。 */
  onOpenPath?: (path: string, title: string) => void;
  onLocateRecovery?: () => void;
  onDecide: (decision: "APPROVE" | "REJECT", reason: string, amendment?: ApprovalDecisionAmendment) => void;
  onExecute: () => void;
  onAppend: (username: string, reason: string) => void;
}) {
  const [dialog, setDialog] = useState<"approve" | "reject" | "execute" | null>(null);
  const actionsElement = useRef<HTMLElement>(null);
  const status = statusView(detail.status);
  const execution = executionProgress(detail);
  const progress = businessProgress(detail.business);
  const actions = detail.actions;
  const unknownActions = (actions ?? []).filter((item) => !item || !(APPROVAL_ACTION_NAMES as readonly string[]).includes(item.action));
  const listed = APPROVAL_ACTION_NAMES.filter((name) => actionFor(actions, name) !== null);
  const refs = detail.business?.objectRefs ?? [];
  // 来源业务回链：结算调整由来源订单流程消费，替代申请也必须由来源业务重新发起。
  const sourcePath = refs.map((ref) => objectRefPath(ref)).find((path): path is string => path !== null) ?? null;
  const sourceBusiness = (detail.operation.executionMode ?? detail.business?.executionMode) === "SOURCE_BUSINESS";
  const allBlocked = listed.length > 0 && listed.every(name => !canAct(actions, name));
  const notes = new Map<string, { labels: string[]; reason: string }>();
  for (const name of listed) {
    const action = actionFor(actions, name)!;
    if (action.allowed || (!["approve", "reject", "execute"].includes(name) && !allBlocked)) continue;
    const key = JSON.stringify([action.reasonCode, action.requiredPermission ?? null, action.nextStepCode ?? null]);
    const previous = notes.get(key);
    if (previous) previous.labels.push(ACTION_LABELS[name] ?? name);
    else notes.set(key, { labels: [ACTION_LABELS[name] ?? name], reason: actionBlockReason(actions, name) ?? "原因未提供" });
  }
  const guide = blocked ? "这次办理的原结果尚待核对，请先查询原结果，再决定是否继续。"
    : busy ? "正在办理或核对这次请求，请稍候。"
      : canAct(actions, "approve") || canAct(actions, "reject") ? "请先核对本次事项，再选择批准或驳回。"
        : canAct(actions, "execute") ? "已具备本次执行资格；核对后通过原确认框执行。"
          : sourceBusiness ? nextStepLabel(actionFor(actions, "execute")?.nextStepCode) ?? "后续由来源业务办理，请前往来源对象核对。"
            : actions === undefined ? "本次操作资格暂未确认，当前只能查看。"
              : "当前不能批准、驳回或执行；请按下方具体原因核对。";
  const locateActions = () => {
    actionsElement.current?.scrollIntoView?.({ block: "nearest" });
    actionsElement.current?.focus();
  };


  return (
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="text-base font-semibold break-words text-foreground">{detail.business?.businessTitle ?? "业务摘要未接入"}</h3>
            <p className="mt-1 text-sm leading-relaxed break-words text-muted-foreground">{detail.business?.changeSummary || detail.summary}</p>
          </div>
          <Badge variant="outline" className="font-mono">{executionModeLabel(detail.operation.executionMode ?? detail.business?.executionMode)}</Badge>
        </div>
        <p className="text-xs text-muted-foreground">
          申请编号 <span className="font-mono break-all">{detail.requestId}</span>
          <span className="mx-1.5">·</span>申请人 {personLabel(detail.requester)}
          <span className="mx-1.5">·</span>申请时间 {formatDate(detail.createdAt)}
          <span className="mx-1.5">·</span>有效期至 {formatDate(detail.expiresAt)}
        </p>
      </div>

      {/* 审批状态 / 执行状态 / 业务进度分列，不用连续 Stepper 暗示必然成功。 */}
      <div className="grid grid-cols-1 gap-4 rounded-md border border-border/60 bg-foreground/[0.02] p-3 sm:grid-cols-3">
        <StatusFact label="审批状态" tone={status.tone}>
          {status.label}
          {detail.statusReason ? <span className="ml-1.5 font-normal text-muted-foreground">{detail.statusReason}</span> : null}
        </StatusFact>
        <StatusFact label="执行状态" tone={execution.tone}>
          {execution.label}
          {execution.detail ? <span className="ml-1.5 font-normal text-muted-foreground">{execution.detail}</span> : null}
        </StatusFact>
        <StatusFact label="业务进度" tone={progress.tone}>
          {progress.label}
          {progress.detail ? <span className="ml-1.5 font-normal text-muted-foreground">{progress.detail}</span> : null}
        </StatusFact>
      </div>

      {detail.supersedesRequestId || detail.supersededByRequestId ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-border/60 p-3 text-xs">
          {detail.supersededByRequestId ? <span className="text-foreground">本申请已被另一申请替代，不再推进。</span> : null}
          {detail.supersedesRequestId ? (
            <Button type="button" size="sm" variant="secondary" onClick={() => onOpenRequest(detail.supersedesRequestId!, "被替代的原申请")}>查看被替代的原申请</Button>
          ) : null}
          {detail.supersededByRequestId ? (
            <Button type="button" size="sm" variant="secondary" onClick={() => onOpenRequest(detail.supersededByRequestId!, "替代本申请的审批申请")}>查看替代申请</Button>
          ) : null}
        </div>
      ) : null}

      {refs.length > 0 ? (
        <Section title="作用对象与去向" hint="链接只指向平台内已有对象页；没有对应页面的类型只列标识，不拼技术 ID 造入口。">
          <ul className="flex flex-wrap gap-1.5">
            {refs.filter((ref) => ref.id).map((ref) => {
              const path = objectRefPath(ref);
              return (
                <li key={`${ref.type}-${ref.id}`}>
                  {path && onOpenPath
                    ? <Button type="button" size="sm" variant="secondary" onClick={() => onOpenPath(path, objectRefLabel(ref.type))}>{objectRefLabel(ref.type)}<span className="font-mono text-[11px] opacity-70">{ref.id}</span></Button>
                    : <Badge variant="outline">{objectRefLabel(ref.type)}<span className="font-mono text-[11px] opacity-70">{ref.id}</span></Badge>}
                </li>
              );
            })}
          </ul>
          {sourcePath === null || !onOpenPath ? (
            <p className="text-xs text-muted-foreground">
              {detail.business?.executionMode === "SOURCE_BUSINESS"
                ? "结算调整的结果由来源订单流程消费；请从上方订单对象进入完成双方确认、客服复核与过账，审批页不提供通用执行。"
                : "这些对象类型当前没有可跳转的平台页面，只列出标识供核对。"}
              {sourcePath !== null && !onOpenPath ? " 工作区尚未提供跨对象导航，请从左侧导航进入对应页面。" : ""}
            </p>
          ) : null}
        </Section>
      ) : null}

      <section ref={actionsElement} tabIndex={-1} aria-label="当前办理" className="space-y-3 rounded-lg border border-border bg-foreground/[0.02] p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <h4 className="text-sm font-semibold">当前卡点与下一步</h4>
        <p className="text-sm leading-relaxed">{guide}</p>
        {candidateAvailabilityLabel(detail.candidateAvailability) ? <p className="text-xs text-muted-foreground">{candidateAvailabilityLabel(detail.candidateAvailability)}</p> : null}
        {blocked && onLocateRecovery ? <Button type="button" size="sm" variant="secondary" onClick={onLocateRecovery}>查看原结果核对</Button> : null}
      <Section
        title="可办理的动作"
        hint="按钮依据本申请当前提供的逐项资格显示。没有资格信息时保留只读，确认办理时还会再次核对。"
      >
        {actions === undefined ? (
          <NotApplicable reason="本次操作资格暂未确认，当前只能查看；可刷新后再次核对。" />
        ) : listed.length === 0 && unknownActions.length === 0 ? (
          <p className="text-xs text-muted-foreground">当前没有可办理动作。</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-2">
              {listed.map((name) => {
                const eligibility = actionFor(actions, name)!;
                if (name === "addCandidate") return null;
                if (name === "replace") {
                  // 没有 cancel/withdraw 接口：撤销只能由来源业务重新发起并带 supersedesRequestId。
                  return eligibility.allowed ? (
                    <Button
                      type="button" size="sm" variant="secondary" key={name}
                      disabled={busy || blocked || sourcePath === null || !onOpenPath}
                      onClick={() => { if (sourcePath && onOpenPath) onOpenPath(sourcePath, "重新发起（替代本申请）"); }}
                    >
                      返回来源业务
                    </Button>
                  ) : <ActionButton key={name} eligibility={eligibility} busy={busy} blocked={blocked} onClick={() => undefined} />;
                }
                return (
                  <ActionButton
                    key={name} eligibility={eligibility} busy={busy} blocked={blocked}
                    onClick={() => setDialog(name === "approve" ? "approve" : name === "reject" ? "reject" : "execute")}
                  />
                );
              })}
            </div>
            {unknownActions.length > 0 ? (
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                这张申请包含本页暂不支持的动作，当前不能办理该项；具体标识可在技术追溯中核对。
              </p>
            ) : null}
            {notes.size > 0 ? <ul aria-label="操作不可用原因" className="mt-2 space-y-1 text-xs leading-relaxed text-muted-foreground">{[...notes].map(([key, note]) => <li key={key}>{note.labels.join("、")}：{note.reason}</li>)}</ul> : null}
            {detail.business?.executionMode === "SOURCE_BUSINESS" ? (
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                {nextStepLabel(actionFor(actions, "execute")?.nextStepCode) ?? "本业务由来源流程完成，审批页不执行、也不显示“执行后到账”。"}
              </p>
            ) : null}
          </>
        )}
        {canAct(actions, "addCandidate") ? (
          <div className="mt-3">
            <AddCandidateForm requestId={detail.requestId} busy={busy} blocked={blocked} onAppend={onAppend} />
          </div>
        ) : actionFor(actions, "addCandidate") && !allBlocked ? (
          <p className="mt-3 text-xs text-muted-foreground">
            追加审批人不可用：{actionBlockReason(actions, "addCandidate")}。
          </p>
        ) : null}
      </Section>
      {sourceBusiness ? <Button type="button" size="sm" variant="secondary" disabled={busy || blocked || sourcePath === null || !onOpenPath} onClick={() => { if (sourcePath && onOpenPath) onOpenPath(sourcePath, "来源业务"); }}>前往来源业务</Button> : null}
      </section>

      <RequestFlow detail={detail} onLocateActions={locateActions} />

      {detail.decision ? (
        <Section title="决定">
          <FactGrid>
            <Fact label="结果" value={detail.decision.decision === "APPROVED" ? "批准" : detail.decision.decision === "REJECTED" ? "驳回" : detail.decision.decision} />
            <Fact label="决定人" value={personLabel(detail.decision.approver)} />
            <Fact label="决定时间" value={formatDate(detail.decision.createdAt)} />
            <Fact label="意见" value={detail.decision.reason} />
          </FactGrid>
        </Section>
      ) : null}

      <details data-approval-business-details className="rounded-md border border-border/60 p-3">
        <summary className="cursor-pointer text-sm font-medium">申请明细与业务结果</summary>
        <div className="mt-4 space-y-5"><BusinessSummary business={detail.business} operationCode={detail.operation.code} /></div>
      </details>
      <details className="rounded-md border border-border/60 p-3">
        <summary className="cursor-pointer text-sm font-medium">候选名单与资格说明</summary>
        <div className="mt-3"><Candidates candidates={detail.candidates} availability={detail.candidateAvailability} /></div>
      </details>

      <Section title="事件记录" hint="按真实结果逐项显示；时间靠前不等于执行成功，驳回、失败、过期与取消分别呈现。">
        <HistoryTimeline history={detail.history} />
      </Section>

      <Section title="技术追溯">
        <details className="rounded-md border border-border/60 px-3 py-2 text-xs">
          <summary className="cursor-pointer select-none text-muted-foreground">载荷快照与模板标识</summary>
          <div className="mt-2">
            <FactGrid>
              <Fact label="操作标识" value={detail.operation.code} mono />
              <Fact label="触发条件" value={detail.operation.triggerCondition} mono />
              <Fact label="载荷版本" value={`v${detail.operation.payloadVersion}`} />
              <Fact label="模板快照版本" value={`v${detail.template.version}`} />
              {unknownActions.length > 0 ? <Fact label="未识别动作" value={unknownActions.map(item => item.action).join("、")} mono /> : null}
            </FactGrid>
            <p className="mt-2 text-xs text-muted-foreground">动作资格与原因来自服务端 actions；本页只作展示，实际办理时仍会重新核对权限、对象和状态。</p>
            {detail.operation.payload ? (
              <>
                <FieldLabel>不可变载荷（仅测试操作返回脱敏正文）</FieldLabel>
                <pre className="overflow-x-auto whitespace-pre-wrap break-words rounded-md bg-foreground/[0.04] p-2 font-mono text-[11px]">{JSON.stringify(detail.operation.payload, null, 2)}</pre>
              </>
            ) : (
              <p className="mt-2 text-xs text-muted-foreground">正式业务的载荷正文不外发；判断依据以上方受权摘要为准。</p>
            )}
          </div>
        </details>
      </Section>

      <DecisionDialog
        key={detail.requestId}
        kind={dialog}
        detail={detail}
        onClose={() => setDialog(null)}
        onSubmit={(kind, reason, amendment) => {
          setDialog(null);
          if (kind === "approve") onDecide("APPROVE", reason, amendment);
          else if (kind === "reject") onDecide("REJECT", reason);
          else onExecute();
        }}
      />
    </div>
  );
}
