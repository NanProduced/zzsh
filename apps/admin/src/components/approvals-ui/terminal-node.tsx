// Adapted from Dylan Mérigaud's approvals-ui registry; see LICENSE in this directory.
import { Handle, type Node, type NodeProps, Position } from "@xyflow/react";
import { CircleCheck, CircleX } from "lucide-react";
import type { TerminalStep } from "../../lib/approvals-ui/policy";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { stateRing, StatusBadge } from "./approval-node";

type TerminalNodeData = {
  step: TerminalStep;
  selected?: boolean;
  vertical?: boolean;
  onSelect?: (id: string) => void;
  [key: string]: unknown;
};
export type TerminalFlowNode = Node<TerminalNodeData, "terminal">;

export const TerminalNode = ({ data }: NodeProps<TerminalFlowNode>) => {
  const { step } = data;
  const vertical = data.vertical !== false;
  const Icon = step.outcome === "approved" ? CircleCheck : CircleX;
  return (
    <Button
      variant="outline"
      type="button"
      aria-pressed={data.selected === true}
      aria-label={`${step.label}：${step.statusLabel}`}
      onClick={() => data.onSelect?.(step.id)}
      className={cn("nodrag nopan relative block h-auto w-52 whitespace-normal rounded-xl bg-card p-3 text-left text-card-foreground", stateRing(data))}
    >
      <Handle type="target" position={vertical ? Position.Top : Position.Left} className="!size-2 !border-none !bg-border" />
      <span className="flex items-center gap-2 text-sm font-semibold"><Icon className="size-4" aria-hidden />{step.label}</span>
      <span className="mt-1 block"><StatusBadge status={step.status} label={step.statusLabel} /></span>
      {step.next.length > 0 && <Handle type="source" position={vertical ? Position.Bottom : Position.Right} className="!size-2 !border-none !bg-border" />}
    </Button>
  );
};
