import type { DragEvent } from "react";
import { ChevronDown, ChevronRight, FileText, FolderClosed, MoreHorizontal } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { DOC_MAX_DEPTH, type DocTreeNode } from "./docs-model";

export type DocsDropZone = "before" | "inside" | "after";

export type DocsTreeRowProps = {
  node: DocTreeNode;
  nodes: readonly DocTreeNode[];
  expanded: ReadonlySet<string>;
  dropHint: { id: string; zone: DocsDropZone } | null;
  selectedId: string | null;
  activeId: string;
  canManage: boolean;
  siblingsOf: (parentId: string | null) => DocTreeNode[];
  setRowRef: (id: string) => (element: HTMLElement | null) => void;
  setActiveId: (id: string) => void;
  onOpen: (id: string) => void;
  setDragId: (id: string | null) => void;
  setDropHint: (value: { id: string; zone: DocsDropZone } | null | ((current: { id: string; zone: DocsDropZone } | null) => { id: string; zone: DocsDropZone } | null)) => void;
  onRowDragOver: (event: DragEvent<HTMLDivElement>, target: DocTreeNode) => void;
  onRowDrop: (event: DragEvent<HTMLDivElement>, target: DocTreeNode) => void;
  toggleExpanded: (id: string) => void;
  onCreate: (parentId: string | null) => void;
  openMoveDialog: (id: string) => void;
  onDelete: (id: string) => void;
};

export function DocsTreeRow(props: DocsTreeRowProps) {
  const { node, ...shared } = props;
  const {
    nodes, expanded, dropHint, selectedId, activeId, canManage, siblingsOf, setRowRef, setActiveId, onOpen,
    setDragId, setDropHint, onRowDragOver, onRowDrop, toggleExpanded, onCreate, openMoveDialog, onDelete,
  } = shared;
    const children = nodes.filter((item) => item.parentId === node.id);
    const isExpanded = expanded.has(node.id);
    const hint = dropHint?.id === node.id ? dropHint.zone : undefined;
    return (
      <div key={node.id} role="none">
        <div
          ref={setRowRef(node.id)}
          role="treeitem"
          aria-level={node.depth + 1}
          aria-selected={selectedId === node.id}
          aria-expanded={children.length ? isExpanded : undefined}
          tabIndex={activeId === node.id ? 0 : -1}
          data-doc-id={node.id}
          data-drop={hint}
          className="docs-tree-row"
          draggable={canManage}
          onFocus={() => setActiveId(node.id)}
          onClick={() => onOpen(node.id)}
          onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); event.stopPropagation(); onOpen(node.id); } }}
          onDragStart={(event) => { if (!canManage) return; setDragId(node.id); event.dataTransfer.setData("text/plain", node.id); event.dataTransfer.effectAllowed = "move"; }}
          onDragEnd={() => { setDragId(null); setDropHint(null); }}
          onDragOver={(event) => onRowDragOver(event, node)}
          onDragLeave={() => setDropHint((current) => (current?.id === node.id ? null : current))}
          onDrop={(event) => onRowDrop(event, node)}
          style={{ paddingInlineStart: `${0.55 + (node.depth - 1) * 0.65}rem` }}
        >
          {children.length ? (
            <button
              type="button"
              className="docs-tree-twisty"
              aria-label={isExpanded ? `折叠「${node.title}」` : `展开「${node.title}」`}
              tabIndex={-1}
              onClick={(event) => { event.stopPropagation(); toggleExpanded(node.id); }}
            >
              {isExpanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            </button>
          ) : <span className="docs-tree-twisty" aria-hidden="true" />}
          {children.length > 0 ? <FolderClosed size={14} aria-hidden="true" className="docs-tree-icon" /> : <FileText size={14} aria-hidden="true" className="docs-tree-icon" />}
          <span className="docs-tree-title" title={node.title}>{node.title}</span>
          {canManage ? (
            <DropdownMenu>
              <DropdownMenuTrigger
                className="docs-tree-menu"
                aria-label={`「${node.title}」操作`}
                onClick={(event) => event.stopPropagation()}
              >
                <MoreHorizontal size={14} aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="docs-overlay" onClick={(event) => event.stopPropagation()}>
                {node.depth < DOC_MAX_DEPTH ? <DropdownMenuItem onClick={() => onCreate(node.id)}>新建子文档</DropdownMenuItem> : null}
                <DropdownMenuItem onClick={() => openMoveDialog(node.id)}>移动到…</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => onDelete(node.id)}>删除</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        {children.length && isExpanded ? <div role="group">{siblingsOf(node.id).map((child) => <DocsTreeRow key={child.id} {...shared} node={child} />)}</div> : null}
      </div>
    );
}
