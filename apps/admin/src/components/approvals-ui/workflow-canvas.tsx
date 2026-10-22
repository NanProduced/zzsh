// Adapted from Dylan Mérigaud's approvals-ui registry; see LICENSE in this directory.
import "@xyflow/react/dist/style.css";
import {
  Background, Controls, type Edge, type EdgeTypes, type Node, type NodeTypes,
  ReactFlow, ReactFlowProvider, useReactFlow,
} from "@xyflow/react";
import { useEffect, useMemo, type CSSProperties, type KeyboardEvent } from "react";
import { AlignedStepEdge, useAutoLayout, withAlignedElbows } from "react-flow-auto-layout/react";
import type { ApprovalPolicy } from "../../lib/approvals-ui/policy";
import { cn } from "../../lib/utils";
import { type ApprovalFlowNode, ApprovalNode } from "./approval-node";
import { type TerminalFlowNode, TerminalNode } from "./terminal-node";

type CanvasNode = ApprovalFlowNode | TerminalFlowNode;
const NODE_TYPES = { approval: ApprovalNode, terminal: TerminalNode } satisfies NodeTypes;
const EDGE_TYPES = { alignedStep: AlignedStepEdge } satisfies EdgeTypes;
const PAN_STEPS: Record<string, [number, number]> = { ArrowLeft: [60, 0], ArrowRight: [-60, 0], ArrowUp: [0, 60], ArrowDown: [0, -60] };

export type WorkflowCanvasProps = {
  policy: ApprovalPolicy;
  direction?: "TB" | "LR";
  selectedId?: string | null;
  onSelectStep?: (stepId: string | null) => void;
  className?: string;
};

function buildNodes(policy: ApprovalPolicy, vertical: boolean, selectedId: string | null | undefined, onSelect?: (id: string | null) => void): CanvasNode[] {
  const incoming = new Set(policy.steps.flatMap(step => step.next));
  return policy.steps.map(step => {
    const shared = { selected: selectedId === step.id, vertical, onSelect };
    return step.kind === "terminal"
      ? { id: step.id, type: "terminal", position: { x: 0, y: 0 }, data: { step, ...shared } } satisfies TerminalFlowNode
      : { id: step.id, type: "approval", position: { x: 0, y: 0 }, data: { step, ...shared, hasIncoming: incoming.has(step.id), hasOutgoing: step.next.length > 0 } } satisfies ApprovalFlowNode;
  });
}

function buildEdges(policy: ApprovalPolicy): Edge[] {
  const ids = new Set(policy.steps.map(step => step.id));
  const edges = policy.steps.flatMap(step => step.next.filter(id => ids.has(id)).map(id => ({
    id: `${step.id}->${id}`, source: step.id, target: id,
    style: { stroke: "var(--muted-foreground)", strokeWidth: 1.5 },
  })));
  return withAlignedElbows(edges).map(edge => ({ ...edge, type: "alignedStep" }));
}

function CanvasInner({ policy, direction = "LR", selectedId, onSelectStep }: WorkflowCanvasProps) {
  const flow = useReactFlow();
  const vertical = direction === "TB";
  const sourceNodes = useMemo<Node[]>(() => buildNodes(policy, vertical, selectedId, onSelectStep), [policy, vertical, selectedId, onSelectStep]);
  const sourceEdges = useMemo(() => buildEdges(policy), [policy]);
  const { nodes, edges, onNodesChange, onEdgesChange } = useAutoLayout({
    nodes: sourceNodes, edges: sourceEdges, vertical, nodeSep: 36, rankSep: 70,
  });
  const structureKey = `${direction}:${policy.steps.map(step => `${step.id}>${step.next.join("|")}`).join(",")}`;

  useEffect(() => {
    const timer = setTimeout(() => { void flow.fitView({ padding: 0.15, minZoom: vertical ? 0.65 : 0.5, maxZoom: 1 }); }, 180);
    return () => clearTimeout(timer);
  }, [structureKey, vertical, flow]);

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    if (event.target !== event.currentTarget) return;
    const shift = PAN_STEPS[event.key];
    if (shift) {
      event.preventDefault();
      const view = flow.getViewport();
      void flow.setViewport({ ...view, x: view.x + shift[0], y: view.y + shift[1] });
    } else if (["+", "=", "-", "Home"].includes(event.key)) {
      event.preventDefault();
      if (event.key === "-") void flow.zoomOut();
      else if (event.key === "Home") void flow.fitView({ padding: 0.15, minZoom: 0.5, maxZoom: 1 });
      else void flow.zoomIn();
    }
  }

  return (
    <div role="group" aria-label="审批流程图。方向键平移，加减键缩放，Home 适应画布，Tab 选择步骤。" tabIndex={0} onKeyDown={navigate} className="h-full rounded-lg focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
      <ReactFlow
        nodes={nodes} edges={edges} onNodesChange={onNodesChange} onEdgesChange={onEdgesChange}
        nodeTypes={NODE_TYPES} edgeTypes={EDGE_TYPES} fitView fitViewOptions={{ padding: 0.15, minZoom: 0.5, maxZoom: 1 }}
        minZoom={0.3} maxZoom={1.5} nodesDraggable={false} nodesConnectable={false}
        nodesFocusable={false} edgesFocusable={false} elementsSelectable={false}
        onPaneClick={() => onSelectStep?.(null)} className="bg-background"
        ariaLabelConfig={{ "controls.zoomIn.ariaLabel": "放大流程图", "controls.zoomOut.ariaLabel": "缩小流程图", "controls.fitView.ariaLabel": "适应画布" }}
      >
        <Background gap={18} />
        <Controls showInteractive={false} />
      </ReactFlow>
    </div>
  );
}

const FLOW_THEME: CSSProperties & Record<`--${string}`, string> = {
  "--xy-controls-button-background-color": "var(--card)",
  "--xy-controls-button-background-color-hover": "var(--muted)",
  "--xy-controls-button-color": "var(--foreground)",
  "--xy-controls-button-color-hover": "var(--foreground)",
  "--xy-controls-button-border-color": "var(--border)",
  "--xy-attribution-background-color": "transparent",
};

/** Approvals UI's measured layout and canvas, constrained to read-only request facts. */
export function WorkflowCanvas({ className, ...props }: WorkflowCanvasProps) {
  return <div className={cn("h-full w-full", className)} style={FLOW_THEME}><ReactFlowProvider><CanvasInner {...props} /></ReactFlowProvider></div>;
}
