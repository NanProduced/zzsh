import { useCallback, useEffect, useState, type RefObject } from "react";
import { Button } from "@/components/ui/button";
import type { PlateEditorHandle } from "@/components/plate/plate-editor";
import { friendlyError } from "../../api";
import { uploadDocImage } from "./docs-images";
import { newWriteKey } from "./docs-model";

type Upload = {
  id: string;
  file: File;
  name: string;
  progress: number;
  status: "uploading" | "error" | "ready";
  error?: string;
  imageId?: string;
};
type Batch = { id: string; blockId: string; tailId?: string; uploads: Upload[] };

export function useDocUploads(docId: string, editorRef: RefObject<PlateEditorHandle | null>, canInsert: boolean, blockIds: ReadonlySet<string>) {
  const [batches, setBatches] = useState<Batch[]>([]);
  const [placementError, setPlacementError] = useState(false);
  const clear = useCallback(() => { setBatches([]); setPlacementError(false); }, []);

  const update = useCallback((id: string, patch: Partial<Upload>) => {
    setBatches((current) => current.map((batch) => {
      if (!batch.uploads.some((upload) => upload.id === id)) return batch;
      return { ...batch, uploads: batch.uploads.map((upload) => upload.id === id ? { ...upload, ...patch } : upload) };
    }));
  }, []);

  const run = useCallback(async (upload: Upload) => {
    update(upload.id, { status: "uploading", progress: 0, error: undefined });
    try {
      const { imageId } = await uploadDocImage(docId, upload.file, (progress) => update(upload.id, { progress }));
      update(upload.id, { status: "ready", imageId });
    } catch (failure) {
      update(upload.id, { status: "error", error: failure instanceof Error ? failure.message : friendlyError(failure) });
    }
  }, [docId, update]);

  const enqueue = useCallback((files: readonly File[], blockId: string) => {
    if (!canInsert) return;
    const uploads: Upload[] = files.filter((file) => file.type.startsWith("image/")).map((file) => ({
      id: newWriteKey(), file, name: file.name || "粘贴的图片", progress: 0, status: "uploading",
    }));
    if (!uploads.length) return;
    const id = newWriteKey();
    setBatches((current) => {
      const existing = current.find((batch) => batch.blockId === blockId);
      return existing
        ? current.map((batch) => batch === existing ? { ...batch, uploads: [...batch.uploads, ...uploads] } : batch)
        : [...current, { id, blockId, uploads }];
    });
    for (const upload of uploads) void run(upload);
  }, [canInsert, run]);

  useEffect(() => {
    const editor = editorRef.current;
    if (!editor || !canInsert) return;
    for (const batch of batches) {
      if (!editor.hasBlock(batch.blockId)) continue;
      // Commit the ready prefix so an upload that finishes early cannot pass the preceding file.
      const firstPending = batch.uploads.findIndex((upload) => !upload.imageId);
      const ready = batch.uploads.slice(0, firstPending < 0 ? batch.uploads.length : firstPending);
      if (!ready.length) continue;
      const after = batch.tailId && editor.hasBlock(batch.tailId) ? batch.tailId : batch.blockId;
      const tailId = editor.insertImagesAfter(after, ready.map((upload) => ({ imageId: upload.imageId!, alt: upload.name })));
      if (!tailId) continue;
      const inserted = new Set(ready.map((upload) => upload.id));
      setBatches((current) => current.flatMap((item) => {
        if (item.id !== batch.id) return [item];
        const uploads = item.uploads.filter((upload) => !inserted.has(upload.id));
        return uploads.length ? [{ ...item, tailId, uploads }] : [];
      }));
    }
  }, [batches, blockIds, canInsert, editorRef]);

  const place = (batchId: string) => {
    const blockId = editorRef.current?.selectedBlockId();
    if (!blockId) { setPlacementError(true); return; }
    setPlacementError(false);
    setBatches((current) => current.map((batch) => batch.id === batchId ? { ...batch, blockId, tailId: undefined } : batch));
  };
  const remove = (id: string) => setBatches((current) => current.flatMap((batch) => {
    const uploads = batch.uploads.filter((upload) => upload.id !== id);
    return uploads.length ? [{ ...batch, uploads }] : [];
  }));

  const renderBatch = (batch: Batch, unplaced = false) => (
    <div key={batch.id} className="docs-upload-batch" contentEditable={false} data-plate-prevent-deselect>
      {unplaced ? (
        <div className="docs-upload-recover">
          <p>图片的原插入位置已删除。把光标放到目标块后可重新放置。</p>
          <Button type="button" size="xs" variant="secondary" disabled={!canInsert} onClick={() => place(batch.id)}>插到当前块后</Button>
          {placementError ? <p role="alert">请先把光标放到正文中的目标块。</p> : null}
        </div>
      ) : null}
      <ul className="docs-upload-list" aria-label="图片上传">
        {batch.uploads.map((upload) => (
          <li key={upload.id} className="docs-upload-item" data-status={upload.status}>
            <span className="docs-upload-name">{upload.name}</span>
            {upload.status === "uploading" ? (
              <progress max={1} value={upload.progress} aria-label={`${upload.name} 上传进度`} />
            ) : upload.status === "ready" ? (
              <span role="status">已上传，等待插入</span>
            ) : (
              <span className="docs-upload-error" role="status">{upload.error}</span>
            )}
            {upload.status === "error" ? (
              <Button type="button" size="xs" variant="secondary" disabled={!canInsert} onClick={() => void run(upload)}>重试</Button>
            ) : null}
            <Button type="button" size="xs" variant="ghost" aria-label={`移除 ${upload.name}`} onClick={() => remove(upload.id)}>移除</Button>
          </li>
        ))}
      </ul>
    </div>
  );

  return {
    enqueue,
    dirty: batches.length > 0,
    clear,
    afterBlock: (id: string) => batches.filter((batch) => editorRef.current?.hasBlock(batch.blockId) &&
      (batch.tailId && editorRef.current.hasBlock(batch.tailId) ? batch.tailId : batch.blockId) === id).map((batch) => renderBatch(batch)),
    unplaced: batches.filter((batch) => !editorRef.current?.hasBlock(batch.blockId)).map((batch) => renderBatch(batch, true)),
  };
}
