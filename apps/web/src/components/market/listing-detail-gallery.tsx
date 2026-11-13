"use client";

import { useEffect, useState } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { ChevronLeft, ChevronRight, ImageOff, X } from "lucide-react";
import { LegacyAccountImage } from "@zzsh/ui/legacy-account-image";
import { AccountMediaPlaceholder } from "@zzsh/ui/account-media-placeholder";
import type { ListingDetailData } from "@/lib/listing-view";

export function DetailImage({
  src,
  alt,
  className,
  loading = "lazy",
  onLoad,
  legacy,
  legacyState,
}: {
  src: string;
  alt: string;
  className?: string;
  loading?: "lazy" | "eager";
  onLoad?: (image: HTMLImageElement) => void;
  legacy?: boolean;
  legacyState?: "PENDING_IMPORT" | "UNAVAILABLE";
}) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [src]);
  if (legacy) return <LegacyAccountImage src={src} knownState={legacyState} alt={alt} className={className} loading={loading} />;
  if (failed) {
    return (
      <span className={`detail-image-fallback${className ? ` ${className}` : ""}`}>
        <ImageOff size={24} />图片暂不可用
      </span>
    );
  }
  return (
    <img
      className={className}
      src={src}
      alt={alt}
      loading={loading}
      onLoad={(event) => onLoad?.(event.currentTarget)}
      onError={() => setFailed(true)}
    />
  );
}

export function DetailGallery({ title, media, legacyEmpty = false }: { title: string; media: ListingDetailData["media"]; legacyEmpty?: boolean }) {
  const [activeIndex, setActiveIndex] = useState(0);
  const [previewOpen, setPreviewOpen] = useState(false);
  const galleryMedia = media.filter((m) => m.category !== "PENALTY");
  const activeList = galleryMedia;

  useEffect(() => setActiveIndex(0), [media]);

  if (activeList.length === 0) {
    return (
      <div className="detail-gallery detail-gallery--empty" role="note">
        {legacyEmpty ? <AccountMediaPlaceholder state="UNAVAILABLE" /> : <><ImageOff size={18} aria-hidden="true" /><span>暂无可展示的图片</span></>}
      </div>
    );
  }

  const index = Math.min(activeIndex, activeList.length - 1);
  const activeMedia = activeList[index]!;
  const select = (next: number) => setActiveIndex(Math.max(0, Math.min(activeList.length - 1, next)));

  return (
    <div
      className="detail-gallery"
      aria-label={`${title}公开展示图`}
      onKeyDown={(event) => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const next = Math.max(0, Math.min(activeList.length - 1, index + (event.key === "ArrowRight" ? 1 : -1)));
        select(next);
        if (!previewOpen && event.target instanceof Element && event.target.closest(".detail-gallery-thumbs")) {
          event.currentTarget.querySelectorAll<HTMLElement>(".detail-gallery-thumb")[next]?.focus();
        }
      }}
    >
      <div className="detail-gallery-stage">
        <Dialog.Root open={previewOpen} onOpenChange={setPreviewOpen}>
          <Dialog.Trigger asChild>
            <button
              type="button"
              className="detail-gallery-main"
              aria-label={`放大查看第 ${index + 1} 张公开展示图`}
            >
              <DetailImage
                src={activeMedia.url}
                legacy={activeMedia.legacy}
                legacyState={activeMedia.legacyState}
                alt={`${title}公开展示图，第${index + 1}张`}
                loading="eager"
              />
              <span className="detail-gallery-count" aria-live="polite">
                {index + 1} / {activeList.length}
              </span>
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className="modal-overlay" />
            <Dialog.Content className="detail-preview-content" aria-describedby={undefined}>
              <Dialog.Title className="sr-only">{title} 大图预览</Dialog.Title>
              <Dialog.Close className="icon-button detail-preview-close" aria-label="关闭预览">
                <X size={18} aria-hidden="true" />
              </Dialog.Close>
              <DetailImage
                src={activeMedia.url}
                legacy={activeMedia.legacy}
                legacyState={activeMedia.legacyState}
                alt={`${title}公开展示图大图，第${index + 1}张`}
                className="detail-preview-image"
                loading="eager"
              />
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        {activeList.length > 1 ? (
          <>
            <button
              type="button"
              className="detail-gallery-nav detail-gallery-nav--previous"
              aria-label="上一张公开展示图"
              disabled={index === 0}
              onClick={() => select(index - 1)}
            >
              <ChevronLeft size={20} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="detail-gallery-nav detail-gallery-nav--next"
              aria-label="下一张公开展示图"
              disabled={index === activeList.length - 1}
              onClick={() => select(index + 1)}
            >
              <ChevronRight size={20} aria-hidden="true" />
            </button>
          </>
        ) : null}
      </div>
      <div className="detail-gallery-thumbs" aria-label="选择公开展示图">
        {activeList.map((item, thumbnailIndex) => (
          <button
            key={item.assetId}
            type="button"
            className="detail-gallery-thumb"
            aria-label={`选择第 ${thumbnailIndex + 1} 张公开展示图`}
            aria-pressed={thumbnailIndex === index}
            onClick={() => select(thumbnailIndex)}
          >
            <DetailImage src={item.coverUrl ?? item.url} legacy={item.legacy} legacyState={item.legacyState} alt="" className="detail-gallery-thumb-image" />
            <span className="detail-gallery-thumb-index">{thumbnailIndex + 1}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
