"use client";

import type { ChangeEvent, Dispatch, DragEvent, SetStateAction } from "react";
import { ArrowDown, ArrowUp, FileImage, Trash2, Upload } from "lucide-react";
import { SectionCard, FieldError } from "./publish-dialogs";
import { MEDIA_ACCEPT_ATTRIBUTE, mediaUploadFailureHint } from "../../lib/media-upload";
import { mediaReviewLabel } from "./publish-form-helpers";
import type { MediaCategory, MediaEntry } from "./publish-form-types";

export interface PublishMediaSectionProps {
  hasError: boolean;
  fieldError?: string;
  hasBanRecord: boolean;
  retainedPenaltyCount: number;
  media: MediaEntry[];
  mediaDropActive: MediaCategory | null;
  setMediaDropActive: Dispatch<SetStateAction<MediaCategory | null>>;
  dragMediaId: string | null;
  setDragMediaId: Dispatch<SetStateAction<string | null>>;
  dragOverMediaId: string | null;
  setDragOverMediaId: Dispatch<SetStateAction<string | null>>;
  formDisabled: boolean;
  gameId: string;
  acceptFiles: (category: MediaCategory, files: File[]) => void;
  selectFiles: (category: MediaCategory, event: ChangeEvent<HTMLInputElement>) => void;
  reorderMediaCard: (sourceId: string, targetId: string) => void;
  setPreviewMedia: Dispatch<SetStateAction<{ url: string; title: string } | null>>;
  upload: (item: MediaEntry) => Promise<void>;
  setCoverMedia: (id: string) => void;
  moveMedia: (id: string, delta: -1 | 1) => void;
  removeMedia: (id: string) => void;
}

export function PublishMediaSection({
  hasError,
  fieldError,
  hasBanRecord,
  retainedPenaltyCount,
  media,
  mediaDropActive,
  setMediaDropActive,
  dragMediaId,
  setDragMediaId,
  dragOverMediaId,
  setDragOverMediaId,
  formDisabled,
  gameId,
  acceptFiles,
  selectFiles,
  reorderMediaCard,
  setPreviewMedia,
  upload,
  setCoverMedia,
  moveMedia,
  removeMedia,
}: PublishMediaSectionProps) {
  const mediaStatusText = (item: MediaEntry) => item.status === "uploading"
    ? "上传中…"
    : item.status === "failed"
      ? item.error ?? "上传未完成"
      : item.reviewState === "REJECTED" || item.reviewState === "QUARANTINED"
        ? `${item.bindingSaved ? "已保存" : "已上传"} · ${mediaReviewLabel(item.reviewState)}`
        : item.bindingSaved ? "已保存" : "已上传，待保存";

  const renderMediaPanel = (category: MediaCategory) => {
    const isPenalty = category === "PENALTY";
    const rows = isPenalty
      ? media.filter((item) => item.category === "PENALTY" || item.purpose === "ACCOUNT_EVIDENCE")
      : media.filter((item) => item.category !== "PENALTY" && item.purpose === "ACCOUNT_DISPLAY");
    const canUpload = !isPenalty || hasBanRecord;
    const isPenaltyEmpty = isPenalty && hasBanRecord && rows.length === 0;
    const title = isPenalty ? (canUpload ? "封禁记录截图" : "已保留的封禁截图") : "账号展示图";
    const desc = isPenalty ? (canUpload ? "请上传该账号三角洲行动所有封禁记录截图" : "已有图片仍在本次资料中，可在这里查看或移除。") : "至少上传一张，第一张作为封面；可调整图片顺序。";
    return <div className="supply-media-panel" key={category} id={isPenalty ? "publish-media-penalty" : undefined}>
      <div className="supply-media-heading"><FileImage size={20} aria-hidden="true" /><div><h3>{title}{isPenalty && hasBanRecord ? <span className="publish-required-mark">必填</span> : null}</h3><p>{desc}</p></div>{rows.length ? <span className="publish-media-count">{rows.length} 张</span> : null}</div>
      {canUpload ? <label
        className="supply-upload-dropzone"
        data-disabled={formDisabled || !gameId ? "true" : "false"}
        data-drag-active={mediaDropActive === category ? "true" : "false"}
        onDragEnter={() => { if (!formDisabled && gameId) setMediaDropActive(category); }}
        onDragOver={(event) => {
          event.preventDefault();
          if (!formDisabled && gameId && mediaDropActive !== category) setMediaDropActive(category);
        }}
        onDragLeave={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
            setMediaDropActive((previous) => (previous === category ? null : previous));
          }
        }}
        onDrop={(event: DragEvent<HTMLLabelElement>) => {
          event.preventDefault();
          setMediaDropActive(null);
          acceptFiles(category, Array.from(event.dataTransfer.files));
        }}
      >
        <Upload size={22} aria-hidden="true" /><span className="publish-upload-copy"><strong>选择图片、拖入此处，或直接 Ctrl+V 粘贴截图</strong><span>PNG / JPEG / WebP · 单张 ≤ 10 MiB</span></span><span className="publish-upload-action" aria-hidden="true">选择图片</span>
        <input aria-label={isPenalty ? "上传封禁记录截图" : "上传账号展示图"} data-first-field={!isPenalty ? true : undefined} type="file" accept={MEDIA_ACCEPT_ATTRIBUTE} multiple disabled={formDisabled || !gameId} onChange={(event) => selectFiles(category, event)} />
      </label> : null}
      {!isPenalty && canUpload ? <p className="publish-media-guide">建议依次上传：① 仓库/哈夫币总览（首张作封面） ② 干员或枪械外观 ③ 特勤处与段位页，更易吸引租客下单。</p> : null}
      {isPenaltyEmpty ? <p className="supply-field-error" role="alert" style={{ margin: "8px 0 0" }}>请上传该账号三角洲行动所有封禁记录截图</p> : null}
      <div className="supply-media-list">{rows.map((item, index) => {
        const isCover = !isPenalty && index === 0;
        const previewLabel = item.file?.name ?? (isPenalty ? `处罚公示图 ${index + 1}` : `展示图 ${index + 1}`);
        const canDrag = !formDisabled && item.status !== "uploading" && rows.length > 1;
        return <div
          key={item.id}
          className={`supply-media-row supply-media-card${isCover ? " is-cover" : ""}${item.status === "failed" ? " is-failed" : ""}`}
          draggable={canDrag}
          data-dragging={dragMediaId === item.id ? "true" : undefined}
          data-drag-over={dragOverMediaId === item.id && dragMediaId !== item.id ? "true" : undefined}
          onDragStart={(event) => {
            if (!canDrag) return;
            setDragMediaId(item.id);
            event.dataTransfer.effectAllowed = "move";
            event.dataTransfer.setData("text/plain", item.id);
          }}
          onDragOver={(event) => {
            if (!canDrag || !dragMediaId || dragMediaId === item.id) return;
            event.preventDefault();
            if (dragOverMediaId !== item.id) setDragOverMediaId(item.id);
          }}
          onDrop={(event) => {
            if (!canDrag || !dragMediaId) return;
            event.preventDefault();
            reorderMediaCard(dragMediaId, item.id);
            setDragMediaId(null);
            setDragOverMediaId(null);
          }}
          onDragEnd={() => {
            setDragMediaId(null);
            setDragOverMediaId(null);
          }}
        >
          <div className="supply-media-preview">
            {isCover ? <span className="supply-media-badge-cover">封面</span> : null}
            {item.status === "uploading" || item.status === "failed" || !item.bindingSaved ? (
              <span className="supply-media-badge-state" data-saved={item.bindingSaved ? "true" : "false"} data-status={item.status}>
                {item.status === "uploading" ? "上传中" : item.status === "failed" ? "未完成" : "待保存草稿"}
              </span>
            ) : null}
            {item.previewUrl ? (
              <button
                type="button"
                className="supply-media-zoom-btn"
                aria-label={`预览 ${previewLabel}`}
                onClick={() => setPreviewMedia({ url: item.previewUrl!, title: previewLabel })}
              >
                <img src={item.previewUrl} alt="" />
              </button>
            ) : (
              <span className="supply-media-placeholder" aria-hidden="true"><FileImage size={20} /></span>
            )}
          </div>
          <div className="supply-media-copy">
            <span title={previewLabel}>{item.file?.name ?? (isPenalty ? "处罚公示图" : "展示图")}</span>
            <small>{mediaStatusText(item)}</small>
            {item.error && item.status === "failed" ? <small className="supply-field-error" role="alert">{item.error}</small> : null}
          </div>
          <div className="supply-media-actions">
            {item.status === "failed" && item.file && !mediaUploadFailureHint(item.file) ? <button type="button" className="button quiet" disabled={formDisabled} onClick={() => void upload(item)}>重试</button> : null}
            {!isPenalty && index > 0 && item.status === "bound" ? <button type="button" className="button quiet supply-media-set-cover" disabled={formDisabled} onClick={() => setCoverMedia(item.id)}>设为封面</button> : null}
            <button type="button" className="button quiet" disabled={formDisabled || item.status === "uploading" || index === 0} aria-label="上移" onClick={() => moveMedia(item.id, -1)}><ArrowUp size={14} /></button>
            <button type="button" className="button quiet" disabled={formDisabled || item.status === "uploading" || index === rows.length - 1} aria-label="下移" onClick={() => moveMedia(item.id, 1)}><ArrowDown size={14} /></button>
            <button type="button" className="button quiet" disabled={formDisabled || item.status === "uploading"} onClick={() => removeMedia(item.id)}><Trash2 size={14} />移除</button>
          </div>
        </div>;
      })}</div>
    </div>;
  };

  return (
    <SectionCard id="media" title="账号图片" hasError={hasError}>
      <div className="supply-media-columns">
        {renderMediaPanel("SHOWCASE")}
        {hasBanRecord ? (
          renderMediaPanel("PENALTY")
        ) : retainedPenaltyCount > 0 ? (
          <details className="publish-retained-media">
            <summary>已保留 {retainedPenaltyCount} 张封禁截图 · 查看与管理</summary>
            {renderMediaPanel("PENALTY")}
          </details>
        ) : null}
      </div>
      <FieldError text={fieldError} />
    </SectionCard>
  );
}
