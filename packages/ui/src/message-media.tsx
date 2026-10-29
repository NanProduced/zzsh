"use client";
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

export function MediaMessage({ media }: { media: NimMessageMedia }) {
  if (media.kind === "video") {
    return <figure className="message-media message-media-video" data-kind="video">
      {media.url
        ? <video className="message-media-video-player" controls preload="metadata" playsInline src={media.url} aria-label={media.name} />
        : <span className="message-media-video-missing"><Unavailable /></span>}
      <MediaCaption media={media} />
    </figure>;
  }
  if (media.kind === "audio") {
    return <div className="message-media message-media-audio" data-kind="audio" role="group" aria-label={`语音 ${media.name}`}>
      {media.url
        ? <audio className="message-media-audio-player" controls preload="metadata" src={media.url} aria-label={media.name} />
        : <Unavailable />}
      <span className="message-media-audio-copy">
        <span className="message-media-name" title={media.name}>{media.name}</span>
        <span className="message-media-size">{formatMediaBytes(media.size)}{durationLabel(media.durationMs) ? ` · ${durationLabel(media.durationMs)}` : ""}</span>
      </span>
    </div>;
  }
  return <div className="message-media message-media-file" data-kind="file" role="group" aria-label={`文件 ${media.name}`}>
    <span className="message-media-file-icon" data-ext={fileExtension(media.name)} aria-hidden="true">{fileExtension(media.name)}</span>
    <span className="message-media-file-copy">
      <span className="message-media-name" title={media.name}>{media.name}</span>
      <span className="message-media-size">{formatMediaBytes(media.size)}</span>
      {media.url ? null : <Unavailable />}
    </span>
    {media.url
      ? <a className="message-media-download" href={media.url} download={media.name} aria-label={`下载 ${media.name}`}>下载</a>
      : null}
  </div>;
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
