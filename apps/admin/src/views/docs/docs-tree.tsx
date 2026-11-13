import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type DragEvent, type KeyboardEvent, type SetStateAction } from "react";
import { ChevronDown, ChevronRight, FolderTree, Plus, Search, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { friendlyError } from "../../api";
import { searchDocs } from "./docs-api";
import {
  DOC_SEARCH_MAX,
  buildDocTree,
  canMoveDoc,
  docSearchError,
  docTime,
  flattenDocTree,
  searchResults,
  type DocTreeNode,
} from "./docs-model";
import { DocsMoveDialog } from "./docs-move-dialog";
import { DocsTreeRow } from "./docs-tree-row";

const INTERNAL_ROOT = "__internal_root";
const EMPTY_EXPANSION = new Set<string>();

type DropZone = "before" | "inside" | "after";

export type DocsTreeProps = {
  nodes: DocTreeNode[];
  status: "loading" | "ready" | "error";
  errorMessage?: string;
  canManage: boolean;
  selectedId: string | null;
  trashActive: boolean;
  query: string;
  onSearchChange: (query: string) => void;
  expanded: Set<string> | null;
  setExpanded: Dispatch<SetStateAction<Set<string> | null>>;
  internalOpen: boolean;
  setInternalOpen: Dispatch<SetStateAction<boolean>>;
  onRetry: () => void;
  onOpen: (id: string) => void;
  onCreate: (parentId: string | null) => void;
  onMove: (id: string, parentId: string | null, afterId: string | null) => void;
  onDelete: (id: string) => void;
  onOpenTrash: () => void;
};

/**
 * 内部文档树：只渲染内部文档根。帮助中心（公开）目录已移到内容管理「帮助目录」tab，
 * 不再混入内部文档库（Owner 验收：内部文档不应包含公开帮助文档）。
 */
export function DocsTree({
  nodes, status, errorMessage, canManage, selectedId, trashActive, query, onSearchChange, expanded: savedExpansion, setExpanded,
  internalOpen, setInternalOpen, onRetry, onOpen, onCreate, onMove, onDelete, onOpenTrash,
}: DocsTreeProps) {
  const byId = useMemo(() => new Map(nodes.map((node) => [node.id, node])), [nodes]);
  const roots = useMemo(() => buildDocTree(nodes), [nodes]);
  const expanded = savedExpansion ?? EMPTY_EXPANSION;
  const [activeId, setActiveId] = useState<string>(INTERNAL_ROOT);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dropHint, setDropHint] = useState<{ id: string; zone: DropZone } | null>(null);
  const [moveId, setMoveId] = useState<string | null>(null);
  const [moveParent, setMoveParent] = useState<string>("");
  const [moveAfter, setMoveAfter] = useState<string>("");
  const [notice, setNotice] = useState<string | null>(null);
  const rowRefs = useRef(new Map<string, HTMLElement>());

  const [searchState, setSearchState] = useState<{ status: "idle" | "loading" | "ready" | "error"; items: DocTreeNode[]; cursor: string | null; error?: string }>({ status: "idle", items: [], cursor: null });
  const searchSeq = useRef(0);

  useEffect(() => {
    if (status !== "ready") return;
    setExpanded((current) => current
      ? new Set([...current].filter((id) => byId.has(id)))
      : new Set(nodes.filter((node) => node.depth === 1).map((node) => node.id)));
  }, [nodes, byId, status, setExpanded]);

  const flatVisible = useMemo(() => {
    const internalList = internalOpen ? flattenDocTree(roots, expanded).map((node) => node.id) : [];
    return [INTERNAL_ROOT, ...internalList];
  }, [roots, expanded, internalOpen]);

  const focusRow = useCallback((id: string) => {
    setActiveId(id);
    requestAnimationFrame(() => rowRefs.current.get(id)?.focus());
  }, []);

  const toggleExpanded = useCallback((id: string) => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [setExpanded]);

  const onTreeKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.target !== event.currentTarget && (event.target as HTMLElement).getAttribute("role") !== "treeitem") return;
    const index = flatVisible.indexOf(activeId);
    const key = event.key;
    if (key === "ArrowDown" || key === "ArrowUp") {
      event.preventDefault();
      const next = key === "ArrowDown" ? Math.min(flatVisible.length - 1, index + 1) : Math.max(0, index - 1);
      focusRow(flatVisible[next] ?? INTERNAL_ROOT);
      return;
    }
    if (key === "Home" || key === "End") {
      event.preventDefault();
      focusRow(key === "Home" ? flatVisible[0]! : flatVisible[flatVisible.length - 1]!);
      return;
    }
    if (activeId === INTERNAL_ROOT) {
      const firstChild = flatVisible[1];
      if (key === "ArrowRight" || key === "Enter" || key === " ") {
        event.preventDefault();
        if (!internalOpen) setInternalOpen(true);
        else if (nodes.length > 0 && firstChild) focusRow(firstChild);
      }
      if (key === "ArrowLeft") { event.preventDefault(); setInternalOpen(false); }
      return;
    }
    const node = byId.get(activeId);
    if (!node) return;
    const children = nodes.filter((item) => item.parentId === node.id);
    if (key === "ArrowRight") {
      event.preventDefault();
      if (children.length && !expanded.has(node.id)) toggleExpanded(node.id);
      else if (children.length) focusRow(children.sort((a, b) => (a.sortKey < b.sortKey ? -1 : 1))[0]!.id);
      return;
    }
    if (key === "ArrowLeft") {
      event.preventDefault();
      if (children.length && expanded.has(node.id)) toggleExpanded(node.id);
      else focusRow(node.parentId ?? INTERNAL_ROOT);
      return;
    }
    if (key === "Enter" || key === " ") {
      event.preventDefault();
      onOpen(node.id);
    }
  };

  const siblingsOf = (parentId: string | null) => nodes.filter((node) => node.parentId === parentId).sort((a, b) => (a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0));

  const dropTarget = (target: DocTreeNode, zone: DropZone): { parentId: string | null; afterId: string | null } | null => {
    if (!dragId || dragId === target.id) return null;
    if (zone === "inside") {
      if (!canMoveDoc(dragId, target.id, byId)) return null;
      const children = siblingsOf(target.id).filter((node) => node.id !== dragId);
      return { parentId: target.id, afterId: children[children.length - 1]?.id ?? null };
    }
    if (!canMoveDoc(dragId, target.parentId, byId)) return null;
    const siblings = siblingsOf(target.parentId).filter((node) => node.id !== dragId);
    const index = siblings.findIndex((node) => node.id === target.id);
    if (index < 0) return null;
    return zone === "before"
      ? { parentId: target.parentId, afterId: siblings[index - 1]?.id ?? null }
      : { parentId: target.parentId, afterId: target.id };
  };

  const onRowDragOver = (event: DragEvent<HTMLDivElement>, target: DocTreeNode) => {
    if (!dragId || !canManage) return;
    const rect = event.currentTarget.getBoundingClientRect();
    const ratio = rect.height > 0 ? (event.clientY - rect.top) / rect.height : 0.5;
    const zone: DropZone = ratio < 0.3 ? "before" : ratio > 0.7 ? "after" : "inside";
    if (dropTarget(target, zone)) {
      event.preventDefault();
      event.dataTransfer.dropEffect = "move";
      setDropHint({ id: target.id, zone });
    } else {
      setDropHint(null);
    }
  };

  const onRowDrop = (event: DragEvent<HTMLDivElement>, target: DocTreeNode) => {
    event.preventDefault();
    const hint = dropHint;
    setDragId(null);
    setDropHint(null);
    if (!dragId || !hint || hint.id !== target.id) return;
    const destination = dropTarget(target, hint.zone);
    if (!destination) { setNotice("无法移动到该位置：超出三层或目标是其子文档。"); return; }
    onMove(dragId, destination.parentId, destination.afterId);
  };

  const runSearch = useCallback(async (q: string, cursor?: string | null) => {
    const seq = ++searchSeq.current;
    const problem = docSearchError(q);
    if (problem) { setSearchState({ status: "error", items: [], cursor: null, error: problem }); return; }
    const trimmed = q.trim();
    if (!trimmed) { setSearchState({ status: "idle", items: [], cursor: null }); return; }
    setSearchState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      const page = await searchDocs({ q: trimmed, cursor });
      if (seq !== searchSeq.current) return;
      setSearchState((current) => ({
        status: "ready",
        items: cursor ? [...current.items, ...searchResults(page)] : searchResults(page),
        cursor: page.nextCursor ?? null,
      }));
    } catch (failure) {
      if (seq !== searchSeq.current) return;
      setSearchState({ status: "error", items: [], cursor: null, error: friendlyError(failure) });
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => { void runSearch(query); }, 300);
    return () => clearTimeout(timer);
  }, [query, runSearch]);

  const openMoveDialog = (id: string) => {
    setMoveId(id);
    setMoveParent("");
    setMoveAfter("");
  };

  const moveParentOptions = useMemo(() => {
    if (!moveId) return [];
    const candidates = nodes.filter((node) => node.id !== moveId && canMoveDoc(moveId, node.id, byId));
    return [
      { value: "", label: "顶层（内部文档根）" },
      ...candidates.map((node) => ({ value: node.id, label: `${" ".repeat(node.depth - 1)}${node.title}` })),
    ];
  }, [moveId, nodes, byId]);

  const movePositionOptions = useMemo(() => {
    const parentId = moveParent || null;
    const children = siblingsOf(parentId).filter((node) => node.id !== moveId);
    return [{ value: "", label: "排在最前" }, ...children.map((node) => ({ value: node.id, label: `在「${node.title}」之后` }))];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [moveParent, moveId, nodes]);

  const searching = query.trim().length > 0;
  const setRowRef = (id: string) => (element: HTMLElement | null) => {
    if (element) rowRefs.current.set(id, element);
    else rowRefs.current.delete(id);
  };

  const rowShared = {
    nodes, expanded, dropHint, selectedId, activeId, canManage, siblingsOf, setRowRef, setActiveId, onOpen,
    setDragId, setDropHint, onRowDragOver, onRowDrop, toggleExpanded, onCreate, openMoveDialog, onDelete,
  };

  return (
    <div className="docs-tree-panel">
      <div className="docs-tree-toolbar">
        <div className="docs-tree-search">
          <Search size={14} aria-hidden="true" />
          <Input
            aria-label="搜索文档标题"
            placeholder="搜索标题…"
            value={query}
            maxLength={DOC_SEARCH_MAX + 20}
            onChange={(event) => {
              searchSeq.current += 1;
              setSearchState({ status: "idle", items: [], cursor: null });
              onSearchChange(event.target.value);
            }}
          />
        </div>
        {canManage ? <Button type="button" size="sm" onClick={() => onCreate(null)}><Plus size={14} aria-hidden="true" />新建文档</Button> : null}
      </div>
      <div className="docs-tree-scroll">
        {searching ? (
          <div className="docs-search-results" aria-label="标题搜索结果">
            {(searchState.status === "idle" || searchState.status === "loading") && searchState.items.length === 0 ? <p className="docs-tree-note" role="status">搜索中…</p> : null}
            {searchState.status === "error" ? (
              <div className="docs-tree-note" role="alert">
                <p>{searchState.error}</p>
                <Button type="button" size="xs" variant="secondary" onClick={() => void runSearch(query)}>重试</Button>
              </div>
            ) : null}
            {searchState.status === "ready" && searchState.items.length === 0 ? <p className="docs-tree-note">没有匹配标题的文档。</p> : null}
            <ul className="docs-search-list">
              {searchState.items.map((node) => (
                <li key={node.id}>
                  <button type="button" className="docs-search-row" onClick={() => onOpen(node.id)}>
                    <span className="docs-tree-title">{node.title}</span>
                    <span className="docs-search-time">更新 {docTime(node.updatedAt)}</span>
                  </button>
                </li>
              ))}
            </ul>
            {searchState.cursor ? <Button type="button" size="xs" variant="secondary" loading={searchState.status === "loading"} onClick={() => void runSearch(query, searchState.cursor)}>加载更多</Button> : null}
          </div>
        ) : status === "loading" ? (
          <div className="docs-tree-skeleton" role="status" aria-label="文档树加载中">
            {[68, 82, 55, 74, 60, 45].map((width, index) => <Skeleton key={index} className="docs-tree-skeleton-row" style={{ width: `${width}%` }} />)}
          </div>
        ) : status === "error" ? (
          <div className="docs-tree-note" role="alert">
            <p>文档暂时无法读取{errorMessage ? `：${errorMessage}` : ""}</p>
            <Button type="button" size="xs" variant="secondary" onClick={onRetry}>重试</Button>
          </div>
        ) : (
          <div role="tree" aria-label="文档库目录" className="docs-tree" onKeyDown={onTreeKeyDown}>
            <div
              ref={setRowRef(INTERNAL_ROOT)}
              role="treeitem"
              aria-level={1}
              aria-expanded={internalOpen}
              tabIndex={activeId === INTERNAL_ROOT ? 0 : -1}
              className="docs-tree-row docs-tree-root"
              onFocus={() => setActiveId(INTERNAL_ROOT)}
              onClick={() => setInternalOpen((open) => !open)}
            >
              <span className="docs-tree-twisty" aria-hidden="true">{internalOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}</span>
              <FolderTree size={14} aria-hidden="true" className="docs-tree-icon" />
              <span className="docs-tree-title">内部文档</span>
            </div>
            {internalOpen ? (
              <div role="group">
                {nodes.length === 0 ? (
                  <div className="docs-tree-empty">
                    <p>还没有内部文档</p>
                    {canManage ? <Button type="button" size="sm" variant="secondary" onClick={() => onCreate(null)}><Plus size={14} aria-hidden="true" />新建文档</Button> : null}
                  </div>
                ) : roots.map((root) => <DocsTreeRow key={root.node.id} {...rowShared} node={root.node} />)}
              </div>
            ) : null}
          </div>
        )}
      </div>

      {notice ? <p className="docs-tree-notice" role="status">{notice}</p> : null}
      <div className="docs-tree-footer">
        <Button type="button" variant="ghost" size="sm" aria-pressed={trashActive} onClick={onOpenTrash}>
          <Trash2 size={14} aria-hidden="true" />回收站
        </Button>
      </div>

      <DocsMoveDialog
        moveId={moveId}
        setMoveId={setMoveId}
        moveParent={moveParent}
        setMoveParent={setMoveParent}
        moveAfter={moveAfter}
        setMoveAfter={setMoveAfter}
        moveParentOptions={moveParentOptions}
        movePositionOptions={movePositionOptions}
        onMove={onMove}
      />
    </div>
  );
}
