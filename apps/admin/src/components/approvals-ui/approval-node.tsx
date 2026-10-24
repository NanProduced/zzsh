// Adapted from Dylan Mérigaud's approvals-ui registry; see LICENSE in this directory.
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { CircleCheck, CircleHelp, CircleX, Clock, UserRound } from "lucide-react";
import type { ApprovalStep, StepStatus } from "../../lib/approvals-ui/policy";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { InlineStatus, type InlineStatusTone } from "../ui/badge";

export type ApprovalNodeData = {
  step: ApprovalStep;
  selected?: boolean;
  vertical?: boolean;
  hasIncoming?: boolean;
  hasOutgoing?: boolean;
  onSelect?: (id: string) => void;
  [key: string]: unknown;
};
export type ApprovalFlowNode = Node<ApprovalNodeData, "approval">;

export const statusTone: Record<StepStatus, InlineStatusTone> = {
  complete: "success", pending: "warning", inactive: "neutral", unknown: "unknown", failed: "error",
};
export const stateRing = ({ selected }: { selected?: boolean }): string => selected ? "ring-2 ring-ring" : "";

export function StatusBadge({ status, label }: { status: StepStatus; label: string }) {
  const Icon = status === "complete" ? CircleCheck : status === "failed" ? CircleX : status === "unknown" ? CircleHelp : Clock;
  return <InlineStatus tone={statusTone[status]} className="whitespace-normal"><Icon className="size-3.5 shrink-0" aria-hidden />{label}</InlineStatus>;
}

export const ApprovalNode = ({ data }: NodeProps<ApprovalFlowNode>) => {
  const { step } = data;
  const vertical = data.vertical !== false;
  return (
    <Button
      variant="outline"
      type="button"
      aria-pressed={data.selected === true}
      aria-label={`${step.label}：${step.statusLabel}`}
      onClick={(event) => { event.stopPropagation(); data.onSelect?.(step.id); }}
      className={cn("nodrag nopan relative block h-auto w-64 whitespace-normal rounded-xl bg-card p-3 text-left text-card-foreground", stateRing(data))}
    >
      {data.hasIncoming !== false && <Handle type="target" position={vertical ? Position.Top : Position.Left} className="!size-2 !border-none !bg-border" />}
      <span className="block text-sm font-semibold">{step.label}</span>
      <span className="mt-1 block"><StatusBadge status={step.status} label={step.statusLabel} /></span>
      <span className="mt-2 block text-xs leading-relaxed text-muted-foreground">{step.description}</span>
      {step.approvers.length > 0 && (
        <span className="mt-3 block space-y-2 border-t border-border pt-2">
          {step.approvers.slice(0, 3).map((approver, index) => (
            <span key={`${approver.name}-${index}`} className="flex items-center gap-2">
              <UserRound className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate text-xs">{approver.name}</span>
            </span>
          ))}
          {step.approvers.length > 3 && <span className="block text-xs text-muted-foreground">另 {step.approvers.length - 3} 人，点此查看</span>}
        </span>
      )}
      {data.hasOutgoing !== false && <Handle type="source" position={vertical ? Position.Bottom : Position.Right} className="!size-2 !border-none !bg-border" />}
    </Button>
  );
};
