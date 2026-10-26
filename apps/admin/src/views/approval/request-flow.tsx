import { useMemo, useState } from "react";
import { WorkflowCanvas } from "../../components/approvals-ui/workflow-canvas";
import { Button } from "../../components/ui-elements";
import { InlineStatus } from "../../components/ui/badge";
import { useIsMobile } from "../../hooks/use-mobile";
import { requestPolicy } from "../../lib/approvals-ui/request-policy";
import { statusTone } from "../../components/approvals-ui/approval-node";
import { formatApprovalDate as formatDate } from "./atoms";
import { personLabel, type RequestDetail } from "./contract";

// Display selection only. Action eligibility still comes from the original server actions.
function currentRecord(detail: RequestDetail): string {
  if (detail.execution || detail.decision?.decision === "APPROVED") return "execution";
  if (detail.decision?.decision === "REJECTED") return "rejected";
  return detail.status === "PENDING" ? "review" : "request";
}

function RequestFlowContent({ detail, onLocateActions }: { detail: RequestDetail; onLocateActions?: () => void }) {
  const policy = useMemo(() => requestPolicy(detail), [detail]);
  const currentId = currentRecord(detail);
  const [selectedId, setSelectedId] = useState<string | null>(currentId);
  const mobile = useIsMobile();
  const [expanded, setExpanded] = useState(false);
  const selected = policy.steps.find(step => step.id === selectedId) ?? policy.steps.find(step => step.id === currentId);
  const facts = selected ? [...selected.facts] : [];
  if (selected?.id === "execution" && detail.execution) {
    facts.push(
      { label: "执行人", value: personLabel(detail.execution.executor) },
      { label: "执行记录时间", value: detail.execution.createdAt ?? "未提供" },
      { label: "执行完成时间", value: detail.execution.completedAt ?? "未提供" },
    );
  }
  const technicalLabels = new Set(["规则快照", "发起条件"]);
  const visibleFacts = facts.filter(fact => !technicalLabels.has(fact.label));
  const technicalFacts = facts.filter(fact => technicalLabels.has(fact.label));
  const grid = (items: typeof facts) => <dl className="mt-3 grid gap-x-5 gap-y-3 text-xs sm:grid-cols-2">{items.map(fact => <div key={fact.label} className="min-w-0"><dt className="text-muted-foreground">{fact.label}</dt><dd className="mt-1 break-words leading-relaxed">{fact.label.endsWith("时间") && fact.value !== "未提供" ? formatDate(fact.value) : fact.value}</dd></div>)}</dl>;

  return (
    <section aria-label="审批流程" className="space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold">审批流程</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">当前办理位于上方。展开流程可核对各环节的已记录人员与时间；审批决定、执行结果与业务状态分别确认。</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="secondary" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? "收起审批流程" : "展开审批流程"}</Button>
          {onLocateActions ? <Button type="button" size="sm" variant="secondary" onClick={onLocateActions}>定位当前办理</Button> : null}
        </div>
      </div>
      {expanded ? <><div data-approval-workflow-canvas className="h-[360px] overflow-hidden rounded-lg border border-border sm:h-[320px]">
        <WorkflowCanvas policy={policy} direction={mobile ? "TB" : "LR"} selectedId={selected?.id} onSelectStep={setSelectedId} />
      </div>
      <div aria-live="polite" className="min-h-24 border-t border-border pt-3">
        {selected ? (
          <>
            <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-medium">{selected.label}</h4><InlineStatus tone={statusTone[selected.status]}>{selected.statusLabel}</InlineStatus>{selected.id === currentId ? <span className="text-xs text-muted-foreground">当前记录</span> : null}</div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{selected.description}</p>
            {visibleFacts.length ? grid(visibleFacts) : null}
            {technicalFacts.length ? <details className="mt-3 text-xs text-muted-foreground"><summary className="cursor-pointer">步骤技术信息</summary>{grid(technicalFacts)}</details> : null}
            {selected.kind === "approval" && selected.approvers.length > 0 ? <div className="mt-3 text-xs"><p className="text-muted-foreground">候选名单；通用资格不代表本单操作授权，也不代表已作出决定。</p><ul className="mt-2 flex flex-wrap gap-x-4 gap-y-2">{selected.approvers.map((approver, index) => <li key={approver.name + "-" + index}><span>{approver.name}</span><span className="ml-1 text-muted-foreground">{approver.title}</span></li>)}</ul></div> : null}
          </>
        ) : <p className="text-xs text-muted-foreground">步骤记录未提供；当前可办理动作以服务端资格为准。</p>}
      </div></> : null}
    </section>
  );
}

export function RequestFlow({ detail, onLocateActions }: { detail: RequestDetail; onLocateActions?: () => void }) {
  const recordKey = [detail.requestId, detail.status, detail.decision?.decision, detail.execution?.status].join("|");
  return <RequestFlowContent key={recordKey} detail={detail} onLocateActions={onLocateActions} />;
}
