"use client";
import { useRef, useState, type ChangeEvent, type ClipboardEvent as ReactClipboardEvent, type DragEvent as ReactDragEvent, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactElement, type ReactNode, type RefObject } from "react";
import { FileText, ImagePlus, Paperclip, ReceiptText, Smile, Video, X } from "lucide-react";
import * as Popover from "@radix-ui/react-popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { CHAT_EMOJIS, MessageReplyQuote } from "@zzsh/ui/message-actions";
import { MediaDraftBar, type MessageMediaDraft } from "@zzsh/ui/message-media";
import "./support-composer.css";

export const MAX_PENDING_IMAGES = 6;

export type StagedImageItem = {
  id: string;
  file: File;
  previewUrl: string;
  name: string;
  size: number;
  width?: number;
  height?: number;
  state?: "DECODING" | "READY";
};

export type PendingImageItem = {
  id?: string;
  conversationId: string;
  file: File;
  previewUrl: string;
  name: string;
  messageClientId?: string;
  state: "FAILED" | "UNKNOWN" | "SENDING";
  progress?: number;
};

/** 旧订单卡只在本轮入口上下文里出现一次；是否已发送由服务事实回读后的签名决定。 */
export type ComposerLegacyOrder = { displayNo: string; sent: boolean };

type SupportComposerProps = {
  preview: boolean;
  busy: boolean;
  canSend: boolean;
  canCompose: boolean;
  canEndRound: boolean;
  closing: boolean;
  imageSending: boolean;
  mediaSending: boolean;
  mediaInFlight: boolean;
  draft: string;
  onDraftChange: (value: string) => void;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
  /** 不可发送时的具体原因；null 表示可发送，显示快捷键提示。 */
  blockReason: string | null;
  composerStatus: string | null;
  attachment: string | null;
  onRemoveAttachment: () => void;
  legacyOrder: ComposerLegacyOrder | null;
  hasUnresolvedText: boolean;
  onSendLegacyOrder: () => void;
  pendingImage: PendingImageItem | null;
  onRetryPendingImage: () => void;
  onRemovePendingImage: () => void;
  stagedImages: StagedImageItem[];
  onResumeStaged: () => void;
  onRemoveStagedItem: (itemId: string) => void;
  selectedMedia: MessageMediaDraft | null;
  onRetryMedia: () => void;
  onRemoveMedia: () => void;
  replyLabel: string | null;
  onCancelReply: () => void;
  contextOpen: boolean;
  onToggleContext: () => void;
  onStageFiles: (files: File[]) => void;
  onMediaSelected: (file: File, kind: "video" | "file") => void;
  onRequestEndRound: () => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  renderTooltip: (text: string, trigger: ReactElement) => ReactNode;
};

/** 输入区只呈现草稿与发送闸门；发送、重试与未确认结果的责任判定都留在窗口壳里。 */
export function SupportComposer({
  preview, busy, canSend, canCompose, canEndRound, closing, imageSending, mediaSending, mediaInFlight,
  draft, onDraftChange, textareaRef, blockReason, composerStatus,
  attachment, onRemoveAttachment, legacyOrder, hasUnresolvedText, onSendLegacyOrder,
  pendingImage, onRetryPendingImage, onRemovePendingImage,
  stagedImages, onResumeStaged, onRemoveStagedItem,
  selectedMedia, onRetryMedia, onRemoveMedia,
  replyLabel, onCancelReply, contextOpen, onToggleContext,
  onStageFiles, onMediaSelected, onRequestEndRound, onSubmit, renderTooltip,
}: SupportComposerProps) {
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const composingRef = useRef(false);

  const insertEmoji = (emoji: string) => {
    const el = textareaRef.current;
    const start = el?.selectionStart ?? draft.length;
    const end = el?.selectionEnd ?? start;
    const next = `${draft.slice(0, start)}${emoji}${draft.slice(end)}`;
    if (next.length > 4000) return;
    onDraftChange(next);
    setEmojiOpen(false);
    requestAnimationFrame(() => {
      el?.focus();
      const position = start + emoji.length;
      el?.setSelectionRange(position, position);
    });
  };

  const chooseQuickReply = (value: string) => { onDraftChange(value); requestAnimationFrame(() => textareaRef.current?.focus()); };

  const onKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing || composingRef.current) return;
    event.preventDefault();
    const form = event.currentTarget.form;
    if (!form) return;
    if (typeof form.requestSubmit === "function") form.requestSubmit();
    else form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  };

  const onPaste = (event: ReactClipboardEvent<HTMLTextAreaElement>) => {
    const items = event.clipboardData?.items;
    if (!items) return;
    const files: File[] = [];
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item && item.kind === "file" && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) files.push(file);
      }
    }
    if (files.length > 0) {
      event.preventDefault();
      onStageFiles(files);
    }
  };

  const chooseImage = (event: ChangeEvent<HTMLInputElement>) => {
    const files = event.target.files ? Array.from(event.target.files) : [];
    event.target.value = "";
    if (files.length === 0) return;
    onStageFiles(files);
  };

  const chooseMedia = (kind: "video" | "file") => (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (file) onMediaSelected(file, kind);
  };

  const handleDragEnter = (event: ReactDragEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current += 1;
    if (event.dataTransfer.types.includes("Files")) {
      setIsDragging(true);
    }
  };

  const handleDragOver = (event: ReactDragEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  };

  const handleDragLeave = (event: ReactDragEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  };

  const handleDrop = (event: ReactDragEvent<HTMLFormElement>) => {
    event.preventDefault();
    event.stopPropagation();
    dragCounterRef.current = 0;
    setIsDragging(false);
    if (!canSend || busy || imageSending || mediaSending) return;
    const files = Array.from(event.dataTransfer.files || []).filter((file) => file.type.startsWith("image/"));
    if (files.length > 0) onStageFiles(files);
  };

  const toolDisabled = preview ? busy : (!canSend || busy);
  const mediaInputDisabled = toolDisabled || imageSending || mediaSending || selectedMedia?.state === "UNKNOWN";

  return <div className="support-composer-wrap">
    {legacyOrder ? <div className="support-attachment" role="group" aria-label="关联旧订单">
      <span>旧订单 {legacyOrder.displayNo} · 发送后客服可核对</span><button type="button" disabled={busy || !canSend || hasUnresolvedText || legacyOrder.sent} onClick={onSendLegacyOrder}>{legacyOrder.sent ? "已发送" : "发送订单信息"}</button>
    </div> : null}
    {preview ? <div className="support-quick-replies" aria-label="快捷回复"><span>快捷回复</span>{["我先帮你确认一下", "请稍等，我正在核对"].map((reply) => <button key={reply} type="button" onClick={() => chooseQuickReply(reply)}>{reply}</button>)}</div> : null}
    {attachment ? <div className="support-attachment" data-slot="attachment"><Paperclip size={14} /><span>{attachment}</span>{renderTooltip("移除附件", <button type="button" onClick={onRemoveAttachment} aria-label="移除附件">×</button>)}</div> : null}
    {!preview && pendingImage ? <div className="support-pending-image" data-state={pendingImage.state}><img src={pendingImage.previewUrl} alt={pendingImage.name} /><span>{pendingImage.name} · {pendingImage.state === "UNKNOWN" ? "发送结果未确认" : pendingImage.state === "SENDING" ? `发送中 ${pendingImage.progress ?? 0}%` : "发送失败"}{pendingImage.messageClientId ? "" : "（无原消息标识）"}</span><button type="button" onClick={onRetryPendingImage} disabled={imageSending || !canSend}>{pendingImage.messageClientId ? "原消息重试" : "重试"}</button><button type="button" onClick={onRemovePendingImage} disabled={imageSending || pendingImage.state === "UNKNOWN"}>移除</button></div> : null}
    {replyLabel !== null ? <MessageReplyQuote label={replyLabel} onCancel={() => { onCancelReply(); requestAnimationFrame(() => textareaRef.current?.focus()); }} /> : null}
    <form
      className="support-composer"
      data-dragging={isDragging}
      onSubmit={onSubmit}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {stagedImages.length > 0 ? (
        <div className="support-staged-tray" data-slot="attachment">
          <div className="support-staged-tray-header">
              <span>待发队列 ({stagedImages.length}/{MAX_PENDING_IMAGES})</span>
              {!pendingImage ? (
                <button
                  type="button"
                  className="support-staged-resume-button"
                  onClick={onResumeStaged}
                  disabled={imageSending || !canSend}
                >
                  继续发送
                </button>
              ) : null}
            </div>
          <div className="support-staged-tray-list">
            {stagedImages.map((staged, idx) => (
              <div className="support-staged-image" data-slot="attachment" key={staged.id}>
                <div className="support-staged-thumb">
                  <img src={staged.previewUrl} alt={staged.name} />
                </div>
                <div className="support-staged-info">
                  <strong>{stagedImages.length > 1 ? `${idx + 1}. ${staged.name}` : staged.name}</strong>
                  <span>{(staged.size / 1024).toFixed(1)} KB · {staged.state === "DECODING" ? "检查中" : "待发送"}</span>
                </div>
                {renderTooltip("移除待发送图片", <button
                  type="button"
                  className="support-staged-remove"
                  onClick={() => onRemoveStagedItem(staged.id)}
                  aria-label="移除待发送图片"
                >
                  <X size={13} />
                </button>)}
              </div>
            ))}
          </div>
        </div>
      ) : null}
      {selectedMedia ? (
        <MediaDraftBar
          draft={selectedMedia}
          onRetry={onRetryMedia}
          onRemove={onRemoveMedia}
          disabled={mediaSending || imageSending}
        />
      ) : null}
      <textarea
        ref={textareaRef}
        value={draft}
        onChange={(event) => {
          onDraftChange(event.target.value);
          event.currentTarget.style.height = "auto";
          event.currentTarget.style.height = Math.min(Math.max(event.currentTarget.scrollHeight, 44), 120) + "px";
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onCompositionStart={() => { composingRef.current = true; }}
        onCompositionEnd={() => { composingRef.current = false; }}
        placeholder={preview ? "输入咨询内容…" : blockReason ?? "输入咨询内容…"}
        aria-label="输入咨询内容"
        rows={2}
        disabled={!canCompose || busy}
      />
      <div className="support-composer-footer">
        <div className="support-composer-tools">
          <TooltipProvider delayDuration={200}>
            {renderTooltip("关联订单", <button
              type="button"
              className="support-tool-btn"
              data-action="toggle-product-context"
              aria-expanded={contextOpen}
              aria-label="关联订单"
              disabled={toolDisabled}
              onClick={onToggleContext}
            >
              <ReceiptText size={16} />
            </button>)}

            <Popover.Root open={emojiOpen} onOpenChange={setEmojiOpen}>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Popover.Trigger asChild>
                    <button type="button" className="support-tool-btn" aria-label="表情" disabled={toolDisabled}>
                      <Smile size={16} />
                    </button>
                  </Popover.Trigger>
                </TooltipTrigger>
                <TooltipContent side="top">表情</TooltipContent>
              </Tooltip>
              <Popover.Portal>
                <Popover.Content className="support-emoji-pop chat-emoji-grid" align="start" side="top" sideOffset={8}>
                  {CHAT_EMOJIS.map((item) => <button key={item.emoji} type="button" className="chat-emoji-button" aria-label={item.label} onClick={() => insertEmoji(item.emoji)}>{item.emoji}</button>)}
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>

            <Tooltip>
              <TooltipTrigger asChild>
                <label className="support-tool-btn" aria-label="发送图片">
                  <ImagePlus size={16} />
                  <input
                    type="file"
                    multiple
                    accept="image/jpeg,image/png"
                    onChange={chooseImage}
                    disabled={toolDisabled || imageSending}
                  />
                </label>
              </TooltipTrigger>
              <TooltipContent side="top">发送图片 (JPG/PNG，最大 10MB，最多 6 张)</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <label className="support-tool-btn" aria-label="发送视频">
                  <Video size={16} />
                  <input
                    type="file"
                    accept="video/mp4,video/quicktime,video/webm"
                    onChange={chooseMedia("video")}
                    disabled={mediaInputDisabled}
                  />
                </label>
              </TooltipTrigger>
              <TooltipContent side="top">发送视频 (MP4/MOV/WebM，最大 100MB)</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <label className="support-tool-btn" aria-label="发送文件">
                  <FileText size={16} />
                  <input
                    type="file"
                    accept="application/pdf,application/zip,text/plain,text/csv,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation"
                    onChange={chooseMedia("file")}
                    disabled={mediaInputDisabled}
                  />
                </label>
              </TooltipTrigger>
              <TooltipContent side="top">发送文件 (PDF/ZIP/TXT/CSV/DOCX/XLSX/PPTX，最大 50MB)</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </div>
        <div className="support-composer-actions">
          {canEndRound ? (
            <button
              type="button"
              className="support-action-btn support-action-secondary"
              data-action="end-consultation"
              disabled={closing || busy}
              onClick={onRequestEndRound}
            >结束本次咨询</button>
          ) : null}
          {composerStatus !== null ? (
            <span className="support-composer-status">{composerStatus}</span>
          ) : (
            <span className="support-composer-hint">
              <kbd className="support-kbd">Enter</kbd> 发送 · <kbd className="support-kbd">Shift</kbd> + <kbd className="support-kbd">Enter</kbd> 换行
            </span>
          )}
          <button type="submit" className="support-send-btn" disabled={!canSend || busy || imageSending || mediaSending || mediaInFlight || (!draft.trim() && !attachment && stagedImages.length === 0 && selectedMedia?.state !== "READY")} aria-label="发送消息">
            <span>{busy || imageSending || mediaSending ? "发送中" : "发送"}</span>
          </button>
        </div>
      </div>
    </form>
  </div>;
}