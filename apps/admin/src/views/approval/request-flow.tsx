import { useMemo, useState } from "react";
import { WorkflowCanvas } from "../../components/approvals-ui/workflow-canvas";
import { InlineStatus } from "../../components/ui/badge";
import { useIsMobile } from "../../hooks/use-mobile";
import { requestPolicy } from "../../lib/approvals-ui/request-policy";
import { statusTone } from "../../components/approvals-ui/approval-node";
import { formatApprovalDate as formatDate } from "./atoms";
import { personLabel, type RequestDetail } from "./contract";

// Display selection only. Action eligibility still comes from the original server actions.
// 已执行落执行结果节点；已决定（含驳回）落审批环节节点（决定人/时间/意见在此）；
// 待审、过期、取消同样停在审批环节以标明在哪一环停止；其余停在提交节点。
function currentRecord(detail: RequestDetail): string {
  if (detail.execution) return "execution";
  if (detail.decision) return "review";
  return detail.status === "PENDING" || detail.status === "EXPIRED" || detail.status === "CANCELLED" ? "review" : "request";
}

// 与顶部标题徽标 / 三轴状态卡重复的状态标签：不再在节点工作区复读。
const CARD_DUPLICATE_LABELS = new Set(["申请状态", "执行方式", "执行结果", "业务进度", "执行说明", "业务说明"]);
const TECHNICAL_LABELS = new Set(["规则快照", "发起条件"]);

/** 选中节点的事实网格：只显示该节点真实、且未在顶部出现过的经手事实。 */
function RequestFlowContent({ detail }: { detail: RequestDetail }) {
  const policy = useMemo(() => requestPolicy(detail), [detail]);
  const currentId = currentRecord(detail);
  const [selectedId, setSelectedId] = useState<string | null>(currentId);
  const mobile = useIsMobile();
  const selected = policy.steps.find(step => step.id === selectedId) ?? policy.steps.find(step => step.id === currentId);
  const facts = selected ? [...selected.facts] : [];
  if (selected?.id === "execution" && detail.execution) {
    facts.push(
      { label: "执行人", value: personLabel(detail.execution.executor) },
      { label: "执行记录时间", value: detail.execution.createdAt ?? "未提供" },
      { label: "执行完成时间", value: detail.execution.completedAt ?? "未提供" },
    );
  }
  const visibleFacts = facts.filter(fact => !TECHNICAL_LABELS.has(fact.label) && !CARD_DUPLICATE_LABELS.has(fact.label));
  const technicalFacts = facts.filter(fact => TECHNICAL_LABELS.has(fact.label));
  const grid = (items: typeof facts) => (
    <dl className="mt-3 grid gap-x-5 gap-y-3 text-xs sm:grid-cols-2">
      {items.map(fact => (
        <div key={fact.label} className="min-w-0">
          <dt className="text-muted-foreground">{fact.label}</dt>
          <dd className="mt-1 break-words leading-relaxed">{fact.label.endsWith("时间") && fact.value !== "未提供" ? formatDate(fact.value) : fact.value}</dd>
        </div>
      ))}
    </dl>
  );

  return (
    <div className="space-y-3">
      <div data-approval-workflow-canvas className="h-[360px] overflow-hidden rounded-lg border border-border sm:h-[320px]">
        <WorkflowCanvas policy={policy} direction={mobile ? "TB" : "LR"} selectedId={selected?.id} onSelectStep={setSelectedId} />
      </div>
      <div aria-live="polite" className="min-h-16 border-t border-border pt-3">
        {selected ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <h4 className="text-sm font-medium">{selected.label}</h4>
              <InlineStatus tone={statusTone[selected.status]}>{selected.statusLabel}</InlineStatus>
              {selected.id === currentId ? <span className="text-xs text-muted-foreground">当前环节</span> : null}
            </div>
            {selected.description ? <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{selected.description}</p> : null}
            {visibleFacts.length ? grid(visibleFacts) : null}
            {technicalFacts.length ? (
              <details className="mt-3 text-xs text-muted-foreground">
                <summary className="cursor-pointer">步骤技术信息</summary>
                {grid(technicalFacts)}
              </details>
            ) : null}
            {selected.kind === "approval" && selected.approvers.length > 0 ? (
              <div className="mt-3 text-xs">
                <p className="text-muted-foreground">候选名单；通用资格不代表本单操作授权，也不代表已作出决定。</p>
                <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                  {selected.approvers.map((approver, index) => (
                    <li key={approver.name + "-" + index}><span>{approver.name}</span><span className="ml-1 text-muted-foreground">{approver.title}</span></li>
                  ))}
                </ul>
              </div>
            ) : null}
          </>
        ) : <p className="text-xs text-muted-foreground">步骤记录未提供；当前可办理动作以服务端资格为准。</p>}
      </div>
    </div>
  );
}

export function RequestFlow({ detail }: { detail: RequestDetail }) {
  const recordKey = [detail.requestId, detail.status, detail.decision?.decision, detail.execution?.status].join("|");
  return <RequestFlowContent key={recordKey} detail={detail} />;
}
