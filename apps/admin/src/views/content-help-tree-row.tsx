import type { DragEvent } from "react";
import { ChevronDown, ChevronRight, FileText, MoreHorizontal } from "lucide-react";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { helpArticleStateLabel, type HelpTreeNode } from "./docs/docs-help-api";
import { DOC_MAX_DEPTH } from "./docs/docs-model";
import { displayTitle, groupIcon } from "./content-help-icons";

export type HelpDropZone = "before" | "inside" | "after";

export type HelpTreeRowProps = {
  node: HelpTreeNode;
  siblingsOf: (parentId: string | null) => HelpTreeNode[];
  visibleNodes: readonly HelpTreeNode[];
  treeExpanded: ReadonlySet<string>;
  dropHint: { id: string; zone: HelpDropZone } | null;
  focusId: string | undefined;
  openKey: string | null;
  selectedFolder: string | null;
  canManage: boolean;
  query: string;
  navigationLocked: boolean;
  setActiveId: (id: string) => void;
  openArticle: (node: HelpTreeNode) => void;
  toggleExpanded: (id: string) => void;
  setDragId: (id: string | null) => void;
  setDropHint: (value: { id: string; zone: HelpDropZone } | null | ((current: { id: string; zone: HelpDropZone } | null) => { id: string; zone: HelpDropZone } | null)) => void;
  onRowDragOver: (event: DragEvent<HTMLDivElement>, target: HelpTreeNode) => void;
  onRowDrop: (event: DragEvent<HTMLDivElement>, target: HelpTreeNode) => void;
  setRowRef: (id: string) => (element: HTMLElement | null) => void;
  beginCreate: (kind: "FOLDER" | "ARTICLE", parentId?: string | null) => void;
  beginRename: (node: HelpTreeNode) => void;
  requestMove: (id: string, parentId: string | null, afterId: string | null) => void;
  openMoveDialog: (id: string) => void;
  setActionError: (value: string | null) => void;
  setDeleteTarget: (node: HelpTreeNode | null) => void;
};

export function HelpTreeRow(props: HelpTreeRowProps) {
  const { node, ...shared } = props;
  const {
    siblingsOf, visibleNodes, treeExpanded, dropHint, focusId, openKey, selectedFolder,
    canManage, query, navigationLocked, setActiveId, openArticle, toggleExpanded, setDragId, setDropHint,
    onRowDragOver, onRowDrop, setRowRef, beginCreate, beginRename, requestMove, openMoveDialog, setActionError, setDeleteTarget,
  } = shared;
    const children = siblingsOf(node.id).filter(child => visibleNodes.includes(child));
    const isExpanded = treeExpanded.has(node.id);
    const hint = dropHint?.id === node.id ? dropHint.zone : undefined;
    const title = displayTitle(node);
    const badge = (node as HelpTreeNode & { withdrawn?: boolean }).withdrawn && !node.published && !node.hasDraft ? "已下线" : helpArticleStateLabel(node);
    const Icon = node.kind === "FOLDER" ? groupIcon(node.iconKey ?? node.id) : FileText;
    const siblings = siblingsOf(node.parentId), index = siblings.findIndex(item => item.id === node.id);
    const openRow = () => { setActiveId(node.id); if (node.kind === "ARTICLE") openArticle(node); else if (!query) toggleExpanded(node.id); };
    return (
      <div key={node.id} role="none">
        <div
          ref={setRowRef(node.id)}
          role="treeitem"
          aria-level={node.depth}
          aria-expanded={children.length ? isExpanded : undefined}
          aria-selected={node.kind === "ARTICLE" ? node.resourceKey === openKey : undefined}
          tabIndex={focusId === node.id ? 0 : -1}
          data-help-id={node.id}
          data-current-group={node.kind === "FOLDER" && selectedFolder === node.id || undefined}
          data-drop={hint}
          className="docs-tree-row"
          draggable={canManage && !query && !navigationLocked}
          onFocus={() => setActiveId(node.id)}
          onClick={openRow}
          onKeyDown={(event) => { if (event.target === event.currentTarget && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); openRow(); } }}
          onDragStart={(event) => { if (!canManage || query) return; setDragId(node.id); event.dataTransfer.setData("text/plain", node.id); event.dataTransfer.effectAllowed = "move"; }}
          onDragEnd={() => { setDragId(null); setDropHint(null); }}
          onDragOver={(event) => onRowDragOver(event, node)}
          onDragLeave={() => setDropHint((current) => (current?.id === node.id ? null : current))}
          onDrop={(event) => onRowDrop(event, node)}
          style={{ paddingLeft: `${0.45 + (node.depth - 1) * 0.7}rem` }}
        >
          {children.length ? (
            <button
              type="button"
              className="docs-tree-twisty"
              aria-label={isExpanded ? `折叠「${title}」` : `展开「${title}」`}
              tabIndex={-1}
              onClick={(event) => { event.stopPropagation(); if (!query) toggleExpanded(node.id); }}
            >
              {isExpanded ? <ChevronDown size={13} aria-hidden="true" /> : <ChevronRight size={13} aria-hidden="true" />}
            </button>
          ) : <span className="docs-tree-twisty" aria-hidden="true" />}
          <Icon size={14} aria-hidden="true" className="docs-tree-icon" />
          <span className="docs-tree-title" title={title}>{title}</span>
          {badge ? <span className="help-tree-status" title={badge}>{badge === "有未发布修改" ? "待发布" : badge === "未发布" && node.hasDraft ? "草稿" : badge}</span> : null}
          {canManage ? (
            <DropdownMenu>
              <DropdownMenuTrigger className="docs-tree-menu" disabled={navigationLocked} tabIndex={focusId === node.id ? 0 : -1} aria-label={`「${title}」操作`} onClick={(event) => event.stopPropagation()}>
                <MoreHorizontal size={14} aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" onClick={(event) => event.stopPropagation()}>
                {node.kind === "FOLDER" && node.depth < DOC_MAX_DEPTH ? <DropdownMenuItem onClick={() => beginCreate("FOLDER", node.id)}>新建子分组</DropdownMenuItem> : null}
                {node.kind === "FOLDER" && node.depth < DOC_MAX_DEPTH ? <DropdownMenuItem onClick={() => beginCreate("ARTICLE", node.id)}>新建文章</DropdownMenuItem> : null}
                {node.kind === "FOLDER" ? <DropdownMenuItem onClick={() => beginRename(node)}>编辑分组</DropdownMenuItem> : <DropdownMenuItem onClick={() => openArticle(node)}>编辑文章</DropdownMenuItem>}
                <DropdownMenuItem disabled={index <= 0 || Boolean(query)} onClick={() => requestMove(node.id, node.parentId, siblings[index - 2]?.id ?? null)}>上移</DropdownMenuItem>
                <DropdownMenuItem disabled={index < 0 || index === siblings.length - 1 || Boolean(query)} onClick={() => requestMove(node.id, node.parentId, siblings[index + 1]!.id)}>下移</DropdownMenuItem>
                <DropdownMenuItem onClick={() => openMoveDialog(node.id)}>移动到…</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onClick={() => { setActionError(null); setDeleteTarget(node); }}>删除</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
        {children.length && isExpanded ? <div role="group">{children.map(child => <HelpTreeRow key={child.id} {...shared} node={child} />)}</div> : null}
      </div>
    );
}
