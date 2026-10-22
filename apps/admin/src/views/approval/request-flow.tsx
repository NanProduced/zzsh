import { useMemo, useState } from "react";
import { WorkflowCanvas } from "../../components/approvals-ui/workflow-canvas";
import { InlineStatus } from "../../components/ui/badge";
import { useIsMobile } from "../../hooks/use-mobile";
import { requestPolicy } from "../../lib/approvals-ui/request-policy";
import { statusTone } from "../../components/approvals-ui/approval-node";
import { formatDate } from "../../api";
import type { RequestDetail } from "./contract";

function RequestFlowContent({ detail }: { detail: RequestDetail }) {
  const policy = useMemo(() => requestPolicy(detail), [detail]);
  const [selectedId, setSelectedId] = useState<string | null>("review");
  const mobile = useIsMobile();
  const selected = policy.steps.find(step => step.id === selectedId);
  return (
    <section aria-label="审批流程" className="space-y-3">
      <div>
        <h3 className="text-sm font-semibold">审批流程</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">点击步骤查看记录；候选组内首个有效决定生效。批准与业务执行分别显示。</p>
      </div>
      <div className="h-[420px] overflow-hidden rounded-lg border border-border">
        <WorkflowCanvas policy={policy} direction={mobile ? "TB" : "LR"} selectedId={selectedId} onSelectStep={setSelectedId} />
      </div>
      <div aria-live="polite" className="min-h-24 border-t border-border pt-3">
        {selected ? (
          <>
            <div className="flex flex-wrap items-center gap-2"><h4 className="text-sm font-medium">{selected.label}</h4><InlineStatus tone={statusTone[selected.status]}>{selected.statusLabel}</InlineStatus></div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{selected.description}</p>
            {selected.facts.length > 0 && <dl className="mt-3 grid gap-x-5 gap-y-3 text-xs sm:grid-cols-2">{selected.facts.map(fact => <div key={fact.label} className="min-w-0"><dt className="text-muted-foreground">{fact.label}</dt><dd className="mt-1 break-words leading-relaxed">{fact.label.endsWith("时间") && fact.value !== "未提供" ? formatDate(fact.value) : fact.value}</dd></div>)}</dl>}
            {selected.kind === "approval" && selected.approvers.length > 0 && <ul className="mt-3 flex flex-wrap gap-x-4 gap-y-2 text-xs">{selected.approvers.map((approver, index) => <li key={`${approver.name}-${index}`}><span>{approver.name}</span><span className="ml-1 text-muted-foreground">{approver.title}</span></li>)}</ul>}
          </>
        ) : <p className="text-xs text-muted-foreground">选择流程中的一个步骤查看记录。</p>}
      </div>
    </section>
  );
}

export function RequestFlow({ detail }: { detail: RequestDetail }) {
  return <RequestFlowContent key={detail.requestId} detail={detail} />;
}
