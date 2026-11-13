import type { RefObject } from "react";
import { History, MessageSquareText, MoreHorizontal, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { docPath, type DocTreeNode } from "./docs-model";
import type { DocSavePhase } from "./use-doc-autosave";
import { SaveStatus } from "./docs-save-status";

export function DocsDetailWorkbar({
  ancestors, onOpenPath, canManage, autosave, canComment, commentsButton, overviewOpen, closeComments, setPanel, setVersionsOpen, conflict, dirty, setActionError, setDeleteOpen,
}: {
  ancestors: readonly DocTreeNode[];
  onOpenPath: (path: string, title?: string) => void;
  canManage: boolean;
  autosave: { phase: DocSavePhase; savedAt: string | null; message: string | null };
  canComment: boolean;
  commentsButton: RefObject<HTMLButtonElement | null>;
  overviewOpen: boolean;
  closeComments: () => void;
  setPanel: (panel: { view: { kind: "overview" }; trigger: HTMLElement }) => void;
  setVersionsOpen: (open: boolean) => void;
  conflict: boolean;
  dirty: boolean;
  setActionError: (value: string | null) => void;
  setDeleteOpen: (open: boolean) => void;
}) {
  return (
      <header className="docs-workbar">
        <nav className="docs-breadcrumb" aria-label="文档位置">
          <button type="button" onClick={() => onOpenPath("/docs")}>内部文档</button>
          {ancestors.map((ancestor) => (
            <span key={ancestor.id} className="docs-breadcrumb-item">
              <span aria-hidden="true">/</span>
              <button type="button" onClick={() => onOpenPath(docPath(ancestor.id), ancestor.title)}>{ancestor.title}</button>
            </span>
          ))}
        </nav>
        <div className="docs-head-actions">
          {!canManage ? <Badge variant="unknown">只读</Badge> : null}
          {canManage ? <SaveStatus phase={autosave.phase} savedAt={autosave.savedAt} message={autosave.message} /> : null}
          {canComment ? (
            <Button ref={commentsButton} type="button" variant={overviewOpen ? "secondary" : "ghost"} size="sm" aria-expanded={overviewOpen} aria-haspopup="dialog" aria-controls={overviewOpen ? "internal-doc-comments" : undefined} onClick={(event) => {
              if (overviewOpen) closeComments();
              else setPanel({ view: { kind: "overview" }, trigger: event.currentTarget });
            }}>
              <MessageSquareText size={15} aria-hidden="true" />评论
            </Button>
          ) : null}
          <Button type="button" variant="ghost" size="sm" onClick={() => setVersionsOpen(true)}>
            <History size={15} aria-hidden="true" />版本历史
          </Button>
          {canManage && !conflict ? (
            <DropdownMenu>
              <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon-sm" aria-label="更多文档操作" />}>
                <MoreHorizontal size={16} aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="docs-overlay">
                <DropdownMenuItem variant="destructive" disabled={dirty} onClick={() => { setActionError(null); setDeleteOpen(true); }}>
                  <Trash2 size={14} aria-hidden="true" />删除
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </header>
  );
}
