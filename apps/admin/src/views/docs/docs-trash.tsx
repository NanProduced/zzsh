import { useCallback, useEffect, useMemo, useState } from "react";
import { ArchiveRestore, RefreshCw, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { FloatingStatusMessage, StatusMessage } from "../../components/ui-elements";
import { friendlyError } from "../../api";
import { fetchDocTrash, isConflict, isMoveInvalid, isNotFound, restoreDocTrash } from "./docs-api";
import { docTime, purgeDaysLeft, type DocTrashItem, type DocTreeNode } from "./docs-model";

export type DocsTrashProps = {
  nodes: DocTreeNode[];
  canManage: boolean;
  refreshNonce: number;
  onOpenPath: (path: string, title?: string) => void;
  onTreeChanged: () => void;
};

const ROOT_PARENT = "__root__";

export function DocsTrash({ nodes, canManage, refreshNonce, onOpenPath, onTreeChanged }: DocsTrashProps) {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; items: DocTrashItem[]; cursor: string | null; error?: string }>({ status: "loading", items: [], cursor: null });
  const [restoring, setRestoring] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [reparent, setReparent] = useState<{ batch: DocTrashItem; parentId: string } | null>(null);

  const load = useCallback(async (cursor?: string | null) => {
    setState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      const page = await fetchDocTrash(cursor);
      setState((current) => ({
        status: "ready",
        items: cursor ? [...current.items, ...(page.items ?? [])] : page.items ?? [],
        cursor: page.nextCursor ?? null,
      }));
    } catch (failure) {
      setState({ status: "error", items: [], cursor: null, error: friendlyError(failure) });
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshNonce]);

  const restore = async (batch: DocTrashItem, parentId?: string | null) => {
    if (restoring) return;
    setRestoring(batch.batchId);
    setActionError(null);
    try {
      const result = await restoreDocTrash(batch.batchId, parentId === undefined ? {} : { parentId });
      setActionSuccess(`已恢复「${batch.title}」等 ${batch.count} 篇文档，回到删除前状态。`);
      setReparent(null);
      setState(current => ({ ...current, items: current.items.filter(item => item.batchId !== batch.batchId) }));
      onTreeChanged();
      onOpenPath(`/docs/${encodeURIComponent(result.node.id)}`, result.node.title);
    } catch (failure) {
      if (isMoveInvalid(failure)) {
        // 原父节点不可用：必须指定新父节点并校验深度。
        setReparent({ batch, parentId: parentId ?? ROOT_PARENT });
        setActionError("原父目录已不可用，请选择新的父目录后恢复。");
      } else if (isNotFound(failure)) {
        setActionError("该批次已被永久清理，无法恢复。");
        void load();
      } else if (isConflict(failure)) {
        setActionError("恢复目标已被其他会话更新，请刷新后重试。");
      } else {
        setActionError(friendlyError(failure));
      }
    } finally {
      setRestoring(null);
    }
  };

  const parentOptions = useMemo(() => {
    if (!reparent) return [];
    // 批次已删除，其子树深度不在当前树里：列出全部候选，深度由服务端最终校验（400 MOVE_INVALID）。
    return [
      { value: ROOT_PARENT, label: "顶层（内部文档根）" },
      ...nodes.map((node) => ({ value: node.id, label: `${" ".repeat(node.depth - 1)}${node.title}` })),
    ];
  }, [reparent, nodes]);

  return (
    <div className="docs-trash">
      <header className="docs-trash-head">
        <div>
          <h2 className="docs-trash-title"><Trash2 size={16} aria-hidden="true" />回收站</h2>
          <p className="docs-tree-note">删除的文档按批次保留 30 天，到期自动永久清理（含私有图片对象）。</p>
        </div>
        <div className="docs-trash-actions">
          <Button type="button" variant="ghost" size="sm" loading={state.status === "loading"} onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />刷新</Button>
          <Button type="button" variant="secondary" size="sm" onClick={() => onOpenPath("/docs")}>返回文档库</Button>
        </div>
      </header>

      <FloatingStatusMessage error={actionError ?? undefined} success={actionSuccess ?? undefined} />

      {state.status === "loading" && state.items.length === 0 ? (
        <div role="status" aria-label="回收站加载中" className="docs-trash-skeleton">
          <Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" />
        </div>
      ) : state.status === "error" ? (
        <div role="alert" className="docs-detail-state">
          <StatusMessage error={`回收站暂时无法读取：${state.error}`} />
          <Button type="button" variant="secondary" onClick={() => void load()}>重试</Button>
        </div>
      ) : state.items.length === 0 ? (
        <p className="docs-trash-empty">回收站是空的。</p>
      ) : (
        <ul className="docs-trash-list" aria-label="回收站批次">
          {state.items.map((batch) => (
            <li key={batch.batchId} className="docs-trash-item">
              <div className="docs-trash-item-main">
                <span className="docs-trash-item-title">{batch.title}</span>
                <span className="docs-trash-item-meta">
                  共 {batch.count} 篇 · 删除于 {docTime(batch.deletedAt)} · 操作人 {batch.deletedBy || "—"}
                </span>
              </div>
              <span className="docs-trash-purge" data-testid="purge-countdown">{purgeDaysLeft(batch.purgeAt)} 天后永久清理</span>
              {canManage ? (
                <Button type="button" size="sm" variant="secondary" loading={restoring === batch.batchId} disabled={restoring !== null && restoring !== batch.batchId} onClick={() => void restore(batch)}>
                  <ArchiveRestore size={13} aria-hidden="true" />恢复
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {state.cursor ? <Button type="button" size="sm" variant="secondary" loading={state.status === "loading"} onClick={() => void load(state.cursor)}>加载更多</Button> : null}

      <Dialog open={reparent !== null} onOpenChange={(open) => { if (!open && !restoring) setReparent(null); }}>
        <DialogContent className="docs-overlay">
          <DialogTitle>选择恢复位置</DialogTitle>
          <DialogDescription>「{reparent?.batch.title}」的原父目录已不可用。选择新的父目录；深度超过三层时服务端会拒绝。</DialogDescription>
          <label className="docs-move-field">
            <span>新的父目录</span>
            <Select value={reparent?.parentId ?? ROOT_PARENT} items={parentOptions} onValueChange={(value) => setReparent((current) => (current ? { ...current, parentId: value === null ? ROOT_PARENT : String(value) } : current))}>
              <SelectTrigger aria-label="新的父目录"><SelectValue /></SelectTrigger>
              <SelectContent className="docs-overlay">{parentOptions.map((option) => <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>)}</SelectContent>
            </Select>
          </label>
          <DialogFooter>
            <Button type="button" variant="secondary" disabled={restoring !== null} onClick={() => setReparent(null)}>取消</Button>
            <Button type="button" loading={restoring !== null} onClick={() => { if (reparent) void restore(reparent.batch, reparent.parentId === ROOT_PARENT ? null : reparent.parentId); }}>恢复到此目录</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
