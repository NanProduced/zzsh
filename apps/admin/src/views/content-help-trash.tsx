import { useCallback, useEffect, useState } from "react";
import { ArchiveRestore, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { FloatingStatusMessage, StatusMessage } from "../components/ui-elements";
import { fetchHelpTrash, isConflict, isForbidden, restoreHelpTrash, type HelpTrashItem } from "./docs/docs-help-api";
import { docTime, purgeDaysLeft } from "./docs/docs-model";

/** 帮助中心回收站（从内部文档库迁入）：批次保留 30 天；恢复回到删除前状态，需发布权限。 */
export function HelpTrashPanel({ canRestore, refreshNonce, onRestored }: { canRestore: boolean; refreshNonce: number; onRestored: () => void }) {
  const [state, setState] = useState<{ status: "loading" | "ready" | "error"; items: HelpTrashItem[]; cursor: string | null; error?: string }>({ status: "loading", items: [], cursor: null });
  const [restoring, setRestoring] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const load = useCallback(async (cursor?: string | null) => {
    setState((current) => ({ ...current, status: "loading", error: undefined }));
    try {
      const page = await fetchHelpTrash(cursor);
      setState((current) => ({
        status: "ready",
        items: cursor ? [...current.items, ...(page.items ?? [])] : page.items ?? [],
        cursor: page.nextCursor ?? null,
      }));
    } catch (failure) {
      setState({ status: "error", items: [], cursor: null, error: isForbidden(failure) ? "没有权限" : "回收站暂时无法读取" });
    }
  }, []);

  useEffect(() => { void load(); }, [load, refreshNonce]);

  const restore = async (batch: HelpTrashItem) => {
    if (restoring) return;
    setRestoring(batch.batchId);
    setActionError(null);
    setActionSuccess(null);
    try {
      await restoreHelpTrash(batch.batchId);
      setActionSuccess(`已恢复 ${batch.count} 项。`);
      onRestored();
      void load();
    } catch (failure) {
      setActionError(isForbidden(failure) ? "恢复需要帮助发布权限。" : isConflict(failure) ? "别人刚改过，刷新后再改。" : "恢复未完成，请刷新回收站后重试。");
      void load();
    } finally {
      setRestoring(null);
    }
  };

  return (
    <section className="docs-trash" aria-label="帮助中心回收站">
      <div className="docs-trash-actions">
        <Button type="button" variant="ghost" size="sm" loading={state.status === "loading"} onClick={() => void load()}><RefreshCw size={14} aria-hidden="true" />刷新</Button>
      </div>
        <FloatingStatusMessage error={actionError ?? undefined} success={actionSuccess ?? undefined} />
        {state.status === "loading" && state.items.length === 0 ? (
          <div role="status" aria-label="帮助回收站加载中" className="docs-trash-skeleton">
            <Skeleton className="h-16 w-full" /><Skeleton className="h-16 w-full" />
          </div>
        ) : state.status === "error" ? (
          <div role="alert" className="docs-detail-state">
            <StatusMessage error={state.error ?? "回收站暂时无法读取"} />
            <Button type="button" variant="secondary" onClick={() => void load()}>重试</Button>
          </div>
        ) : state.items.length === 0 ? (
          <p className="docs-trash-empty">帮助中心回收站是空的。</p>
        ) : (
          <ul className="docs-trash-list" aria-label="帮助中心回收站批次">
            {state.items.map((batch) => (
              <li key={batch.batchId} className="docs-trash-item" data-help-batch={batch.batchId}>
                <div className="docs-trash-item-main">
                  <span className="docs-trash-item-title">{batch.title ?? "（无标题）"}</span>
                  <span className="docs-trash-item-meta">共 {batch.count} 项 · 删除于 {docTime(batch.deletedAt)} · 操作人 {batch.deletedBy || "—"}</span>
                </div>
                <span className="docs-trash-purge">{purgeDaysLeft(batch.purgeAt)} 天后永久清理</span>
                {canRestore ? (
                  <Button type="button" size="sm" variant="secondary" loading={restoring === batch.batchId} disabled={restoring !== null && restoring !== batch.batchId} onClick={() => void restore(batch)}>
                    <ArchiveRestore size={13} aria-hidden="true" />恢复
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {state.cursor ? <Button type="button" size="sm" variant="secondary" loading={state.status === "loading"} onClick={() => void load(state.cursor)}>加载更多</Button> : null}
    </section>
  );
}
