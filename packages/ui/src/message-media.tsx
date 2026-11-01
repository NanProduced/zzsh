"use client";
import { Component, lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseNimMessageMedia, type NimMessageLike, type NimMessageMedia } from "@zzsh/im-client/nim-web-client";

/**
 * Video/file/audio rendering shared by every order and consultation chat.
 * Only the parsed media envelope is trusted; a URL is never assembled from
 * message text or an attachment the client did not validate.
 */
export type MessageMediaDraftState = "READY" | "SENDING" | "FAILED" | "UNKNOWN";

/** One staged video/file. The chat keeps at most one of these per conversation. */
export type MessageMediaDraft = {
  file: File;
  kind: "video" | "file";
  name: string;
  size: number;
  state: MessageMediaDraftState;
  progress: number;
  messageClientId?: string;
};

export function mediaMessageOf(message: Pick<NimMessageLike, "media">): NimMessageMedia | undefined {
  return parseNimMessageMedia(message.media);
}

export function mediaKindLabel(kind: NimMessageMedia["kind"]): string {
  return kind === "video" ? "视频" : kind === "file" ? "文件" : "语音";
}

/** Composer/reply summary for a media message; null for non-media messages. */
export function mediaSummaryOf(message: Pick<NimMessageLike, "media" | "messageType">): string | null {
  const media = mediaMessageOf(message);
  if (media) return `[${mediaKindLabel(media.kind)}]`;
  if (message.messageType === 2) return "[语音]";
  if (message.messageType === 3) return "[视频]";
  if (message.messageType === 6) return "[文件]";
  return null;
}

export function formatMediaBytes(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "大小未知";
  if (value >= 1024 * 1024 * 1024) return `${(value / 1024 / 1024 / 1024).toFixed(1)} GiB`;
  if (value >= 1024 * 1024) return `${(value / 1024 / 1024).toFixed(1)} MiB`;
  return `${Math.max(1, Math.round(value / 1024))} KiB`;
}

function durationLabel(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) return null;
  const total = Math.round(ms / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function fileExtension(name: string): string {
  const match = /\.([A-Za-z0-9]{1,8})$/.exec(name);
  return match ? match[1]!.toUpperCase() : "FILE";
}

function MediaCaption({ media }: { media: NimMessageMedia }) {
  const duration = durationLabel(media.durationMs);
  return <figcaption className="message-media-caption">
    <span className="message-media-name" title={media.name}>{media.name}</span>
    <span className="message-media-size">{formatMediaBytes(media.size)}{duration ? ` · ${duration}` : ""}</span>
  </figcaption>;
}

function Unavailable() {
  return <span className="message-media-unavailable" role="status">媒体暂不可用</span>;
}

export type MediaPreviewItem = {
  kind: "image" | "video";
  url: string;
  name: string;
  width?: number;
  height?: number;
  size?: number;
  mimeType?: string;
};

// The viewer (library + zoom/video/fullscreen plugins + CSS) stays out of the
// message list until a preview is actually opened.
const loadMediaLightbox = () => import("./media-lightbox");
const warmMediaLightbox = () => { void loadMediaLightbox().catch(() => {}); };

class PreviewErrorBoundary extends Component<{ children: ReactNode; fallback: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

function PreviewPending({ failed = false, onClose, onRetry, returnFocus }: {
  failed?: boolean; onClose: () => void; onRetry?: () => void; returnFocus?: HTMLElement | null;
}) {
  const dialog = useRef<HTMLDialogElement | null>(null);
  const close = () => {
    onClose();
    requestAnimationFrame(() => { if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); });
  };
  const closeRef = useRef(close); closeRef.current = close;
  useLayoutEffect(() => {
    const node = dialog.current;
    node?.showModal();
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopImmediatePropagation(); closeRef.current();
    };
    window.addEventListener("keydown", escape, true);
    return () => { window.removeEventListener("keydown", escape, true); node?.close(); };
  }, []);
  return <dialog ref={dialog} className="message-lightbox message-lightbox-loading" aria-label="媒体预览" aria-modal="true" onCancel={event => { event.preventDefault(); close(); }}>
    <p role={failed ? "alert" : "status"}>{failed ? "预览组件加载失败，请重试。" : "正在打开媒体…"}</p>
    <div className="message-lightbox-loading-actions">
      {failed ? <button type="button" onClick={onRetry}>重新加载</button> : null}
      <button type="button" onClick={close}>关闭预览</button>
    </div>
  </dialog>;
}

export function MediaPreview({ item, onClose, returnFocus }: {
  item: MediaPreviewItem | null; onClose: () => void; returnFocus?: HTMLElement | null;
}) {
  const [attempt, setAttempt] = useState(0);
  const MediaLightbox = useMemo(() => lazy(loadMediaLightbox), [attempt, item?.url]);
  if (!item) return null;
  return <PreviewErrorBoundary key={`${item.url}:${attempt}`} fallback={<PreviewPending failed onClose={onClose} returnFocus={returnFocus} onRetry={() => setAttempt(value => value + 1)} />}>
    <Suspense fallback={<PreviewPending onClose={onClose} returnFocus={returnFocus} />}>
      <MediaLightbox item={item} sizeLabel={item.size ? formatMediaBytes(item.size) : null} onClose={onClose} returnFocus={returnFocus} />
    </Suspense>
  </PreviewErrorBoundary>;
}

export function MessageImage({ url, thumbnailUrl, name, className = "" }: { url: string | null; thumbnailUrl?: string | null; name: string; className?: string }) {
  const [failed, setFailed] = useState(false), [retry, setRetry] = useState(0), [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { setFailed(false); setOpen(false); }, [url, thumbnailUrl]);
  if (!url) return <span className="message-media-unavailable" role="status">图片暂不可预览</span>;
  return <><button ref={trigger} type="button" className={`message-image ${className}${failed ? " message-image-failed" : ""}`}
    onPointerEnter={warmMediaLightbox} onFocus={warmMediaLightbox}
    aria-label={`${failed ? "重新加载图片" : "查看图片"} ${name}`} onClick={() => { if (failed) { setRetry(n => n + 1); setFailed(false); } else setOpen(true); }}>
    {failed ? "图片加载失败 · 点击重试" : <img key={`${url}:${thumbnailUrl ?? ""}:${retry}`} src={thumbnailUrl || url} alt={name} loading="lazy" onError={() => setFailed(true)} />}
  </button><MediaPreview item={open ? { kind: "image", url, name } : null} returnFocus={trigger.current} onClose={() => setOpen(false)} /></>;
}

export function MediaMessage({ media }: { media: NimMessageMedia }) {
  const [preview, setPreview] = useState(false), [videoFailed, setVideoFailed] = useState(false);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { setPreview(false); setVideoFailed(false); }, [media.mediaId, media.url]);
  if (media.kind === "video") {
    return <figure className="message-media message-media-video" data-kind="video">
      {media.url ? <button ref={trigger} type="button" className="message-media-video-open" onPointerEnter={warmMediaLightbox} onFocus={warmMediaLightbox} aria-label={videoFailed ? `预览视频 ${media.name}（加载失败）` : `预览视频 ${media.name}`} onClick={() => setPreview(true)}>
        {videoFailed
          ? <span className="message-media-video-missing message-media-video-failed">视频加载失败 · 点击查看</span>
          : <><video className="message-media-video-player" preload="metadata" muted playsInline src={media.url} aria-hidden="true" tabIndex={-1} onError={() => setVideoFailed(true)} />
            <span className="message-media-play" aria-hidden="true"><svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="m9 5 11 7-11 7z" /></svg></span></>}
      </button> : <span className="message-media-video-missing"><Unavailable /></span>}
      <MediaCaption media={media} />
      <MediaPreview item={preview && media.url ? { kind: "video", url: media.url, name: media.name, width: media.width, height: media.height, size: media.size, mimeType: media.mimeType } : null} returnFocus={trigger.current} onClose={() => setPreview(false)} />
    </figure>;
  }
  if (media.kind === "audio") {
    const duration = durationLabel(media.durationMs);
    return <div className="message-media message-media-audio" data-kind="audio" role="group" aria-label={`语音 ${media.name}`}>
      {media.url ? <audio className="message-media-audio-player" controls preload="metadata" src={media.url} aria-label={media.name} /> : <Unavailable />}
      <span className="message-media-audio-copy"><span className="message-media-name" title={media.name}>{media.name}</span><span className="message-media-size">{formatMediaBytes(media.size)}{duration ? ` · ${duration}` : ""}</span></span>
    </div>;
  }
  const extension = fileExtension(media.name);
  const content = <><span className="message-media-file-icon" data-ext={extension} aria-hidden="true">{extension}</span>
    <span className="message-media-file-copy"><span className="message-media-name" title={media.name}>{media.name}</span><span className="message-media-size">{extension} · {formatMediaBytes(media.size)}{media.url ? " · 点击下载" : ""}</span>{media.url ? null : <Unavailable />}</span>
    {media.url ? <span className="message-media-file-action" aria-hidden="true"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 3v12m-5-5 5 5 5-5M5 16v5h14v-5" /></svg></span> : null}</>;
  return media.url
    ? <a className="message-media message-media-file message-media-download" data-kind="file" href={media.url} download={media.name} target="_blank" rel="noopener noreferrer" aria-label={`下载 ${media.name}`} title={`下载 ${media.name}`}>{content}</a>
    : <div className="message-media message-media-file" data-kind="file" role="group" aria-label={`文件 ${media.name}`}>{content}</div>;
}

function draftStatus(draft: MessageMediaDraft): string {
  if (draft.state === "SENDING") return `发送中 ${Math.max(0, Math.min(100, Math.round(draft.progress)))}%`;
  if (draft.state === "UNKNOWN") return "结果未确认";
  if (draft.state === "FAILED") return "发送失败";
  return "待发送";
}

export function MediaDraftBar({ draft, onRetry, onRemove, disabled = false }: {
  draft: MessageMediaDraft;
  onRetry: () => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const canRetry = draft.state === "FAILED" || (draft.state === "UNKNOWN" && Boolean(draft.messageClientId));
  return <div className="message-media-draft" data-state={draft.state} data-kind={draft.kind} role="group" aria-label={`待发送${mediaKindLabel(draft.kind)}`}>
    <span className="message-media-draft-icon" data-kind={draft.kind} aria-hidden="true">{draft.kind === "video" ? "VID" : "FILE"}</span>
    <span className="message-media-draft-copy">
      <strong title={draft.name}>{draft.name}</strong>
      <small>{formatMediaBytes(draft.size)} · {draftStatus(draft)}</small>
    </span>
    {draft.state === "FAILED" || draft.state === "UNKNOWN"
      ? <button type="button" onClick={onRetry} disabled={disabled || !canRetry}
          title={draft.state === "UNKNOWN" && !draft.messageClientId ? "缺少原消息标识，无法重试；请刷新历史核对" : undefined}>
          {draft.messageClientId ? "原消息重试" : "重试"}
        </button>
      : null}
    <button type="button" onClick={onRemove} disabled={disabled || draft.state === "SENDING" || draft.state === "UNKNOWN"}
      title={draft.state === "UNKNOWN" ? "结果未确认时不可移除原媒体" : undefined}>移除</button>
  </div>;
}
