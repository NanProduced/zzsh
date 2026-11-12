import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { History, RotateCcw } from "lucide-react";
import { extractPlate } from "@zzsh/content/plate";
import { PlateDocument } from "@zzsh/ui/plate-document";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { FloatingStatusMessage } from "../../components/ui-elements";
import { friendlyError } from "../../api";
import { fetchDocVersion, fetchDocVersions, isConflict, restoreDocVersion, versionItems } from "./docs-api";
import { docTime, versionKindLabel, type DocDetail, type DocVersion } from "./docs-model";
import { useDocImageUrls } from "./docs-images";

export type DocsVersionsProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  docId: string;
  docTitle: string;
  canManage: boolean;
  currentRevision: () => string;
  onRestored: (detail: DocDetail) => void;
  onConflict: () => void;
};

export function DocsVersions({ open, onOpenChange, docId, docTitle, canManage, currentRevision, onRestored, onConflict }: DocsVersionsProps) {
  const [listState, setListState] = useState<{ status: "loading" | "ready" | "error"; items: DocVersion[]; cursor: string | null; error?: string }>({ status: "loading", items: [], cursor: null });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<{ id: string; version?: DocVersion; error?: string } | null>(null);
  const [restoring, setRestoring] = useState(false);
  const [confirm, setConfirm] = useState<DocVersion | null>(null);
  const [actionError, setActionError] = useState<string>();
  const [actionSuccess, setActionSuccess] = useState<string>();
  const [retry, setRetry] = useState(0);
  const listSequence = useRef(0);

  const loadList = useCallback(async (cursor?: string | null) => {
    const sequence = ++listSequence.current;
    setListState(current => ({ status: "loading", items: cursor ? current.items : [], cursor: cursor ?? null }));
    try {
      const page = await fetchDocVersions(docId, cursor);
      if (sequence !== listSequence.current) return;
      const items = versionItems(page);
      setListState(current => ({ status: "ready", items: cursor ? [...current.items, ...items] : items, cursor: page.nextCursor ?? null }));
      if (!cursor) {
        setSnapshot(null);
        setSelectedId(items[0]?.id ?? null);
        setRetry(value => value + 1);
      }
    } catch (failure) {
      if (sequence === listSequence.current) setListState(current => ({ ...current, status: "error", error: friendlyError(failure) }));
    }
  }, [docId]);

  useEffect(() => {
    if (!open) return;
    setSelectedId(null);
    setSnapshot(null);
    setActionError(undefined);
    setActionSuccess(undefined);
    void loadList();
    return () => { ++listSequence.current; };
  }, [open, loadList]);

  useEffect(() => {
    if (!open || !selectedId) return;
    let active = true;
    void fetchDocVersion(docId, selectedId).then(version => {
      if (!version?.document) throw new Error("未能读取这次保存的正文。");
      if (active) setSnapshot({ id: selectedId, version });
    }).catch(failure => { if (active) setSnapshot({ id: selectedId, error: friendlyError(failure) }); });
    return () => { active = false; };
  }, [docId, open, retry, selectedId]);

  const selected = snapshot?.id === selectedId ? snapshot : null;
  const version = selected?.version;
  const document = version?.document;
  const projection = useMemo(() => document ? extractPlate(document) : null, [document]);
  const previewIds = projection?.imageIds ?? [];
  const { urls: previewUrls } = useDocImageUrls(open && document ? docId : null, previewIds);
  const latestId = listState.items[0]?.id;
  const blank = document?.value.length === 1 && document.value[0]?.type === "p" && !projection?.plainText;

  const restore = async () => {
    if (!confirm || restoring || !canManage || confirm.id === latestId) return;
    setRestoring(true);
    setActionError(undefined);
    setActionSuccess(undefined);
    try {
      const detail = await restoreDocVersion(docId, { expectedRevision: currentRevision(), versionId: confirm.id });
      setConfirm(null);
      setActionSuccess(`已恢复 v${confirm.seq} 的正文，当前版本为 v${detail.version.seq}。`);
      onRestored(detail);
      await loadList();
    } catch (failure) {
      setConfirm(null);
      if (isConflict(failure)) { setActionError("正文已被更新，请重新读取后再恢复。"); onConflict(); }
      else setActionError(friendlyError(failure));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <Sheet open={open} onOpenChange={value => { if (!restoring) onOpenChange(value); }}>
      <SheetContent side="right" className="docs-sheet" closeLabel="关闭版本历史">
        <SheetHeader>
          <SheetTitle className="flex items-center gap-2"><History size={15} aria-hidden="true" />版本历史</SheetTitle>
          <SheetDescription>{docTitle} · 同一作者 10 分钟内的正文保存合并为一条记录。</SheetDescription>
        </SheetHeader>
        <div className="docs-versions-body">
          <FloatingStatusMessage error={actionError} success={actionSuccess} />
          {listState.status === "loading" && listState.items.length === 0 ? (
            <div role="status" aria-label="版本列表加载中" className="docs-versions-skeleton">
              <Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" /><Skeleton className="h-10 w-full" />
            </div>
          ) : null}
          {listState.items.length ? (
            <ul className="docs-version-list" aria-label="版本列表">
              {listState.items.map(entry => (
                <li key={entry.id}>
                  <button type="button" className="docs-version-row" aria-pressed={selectedId === entry.id}
                    onClick={() => { if (selectedId !== entry.id) { setSnapshot(null); setSelectedId(entry.id); } }}>
                    <span className="docs-version-seq">v{entry.seq}</span>
                    <span className="docs-version-kind" data-kind={entry.kind}>{entry.id === latestId ? "当前" : versionKindLabel(entry.kind)}</span>
                    <span className="docs-version-time">{docTime(entry.savedAt)}</span>
                    {typeof entry.saveCount === "number" && entry.saveCount > 1 ? <span className="docs-version-merged">合并 {entry.saveCount} 次保存</span> : null}
                  </button>
                </li>
              ))}
            </ul>
          ) : listState.status === "ready" ? <p className="docs-tree-note">保存正文后可在这里查看并恢复旧版本。</p> : null}
          {listState.status === "error" ? (
            <div role="alert" className="docs-inline-error">
              <p>版本暂时无法读取：{listState.error}</p>
              <Button type="button" size="xs" variant="secondary" onClick={() => void loadList(listState.cursor)}>重试</Button>
            </div>
          ) : listState.cursor ? <Button type="button" size="xs" variant="secondary" loading={listState.status === "loading"} onClick={() => void loadList(listState.cursor)}>加载更多</Button> : null}

          {selectedId ? (
            <div className="docs-version-preview" aria-label="版本正文">
              {!selected ? <Skeleton className="h-40 w-full" /> : selected.error ? (
                <div className="docs-inline-error" role="alert">
                  <p>{selected.error}</p>
                  <Button type="button" size="xs" variant="secondary" onClick={() => { setSnapshot(null); setRetry(value => value + 1); }}>重新读取正文</Button>
                </div>
              ) : version && document ? (
                <>
                  <div className="docs-version-preview-head">
                    <span>v{version.seq} · {versionKindLabel(version.kind)} · {docTime(version.savedAt)}</span>
                    {canManage && version.id !== latestId ? (
                      <Button type="button" size="sm" variant="secondary" onClick={() => { setActionError(undefined); setActionSuccess(undefined); setConfirm(version); }}>
                        <RotateCcw size={13} aria-hidden="true" />恢复此版本
                      </Button>
                    ) : null}
                  </div>
                  {blank ? <p className="docs-tree-note">此版本的正文为空。</p> : <PlateDocument document={document} imageUrls={previewUrls} anchorPrefix={`ver-${version.id}-`} />}
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        <Dialog open={confirm !== null} onOpenChange={value => { if (!value && !restoring) setConfirm(null); }}>
          <DialogContent role="alertdialog" className="docs-overlay">
            <DialogTitle>恢复 v{confirm?.seq} 的正文？</DialogTitle>
            <DialogDescription>恢复后会生成一条新版本记录，你仍可回到当前正文。</DialogDescription>
            <DialogFooter>
              <Button type="button" variant="secondary" disabled={restoring} onClick={() => setConfirm(null)}>取消</Button>
              <Button type="button" loading={restoring} disabled={!canManage} onClick={() => void restore()}>恢复正文</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </SheetContent>
    </Sheet>
  );
}
