"use client";

import { useState, type ReactNode } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import { FileImage, RotateCw, X } from "lucide-react";
import "./skin-media.css";
import type { SkinMediaKind } from "@/lib/supply-types";

type SkinDisplay = {
  name: string;
  mediaId?: string | null;
  mediaKind?: SkinMediaKind | null;
  ownerKind?: string | null;
  rarityName?: string | null;
  rarityBasis?: "PLATFORM_REFERENCE" | "OFFICIAL" | null;
  isCollectible?: boolean | null;
  defaultState?: "UNKNOWN" | "DEFAULT" | "NON_DEFAULT";
};

type SkinMediaThumbProps = {
  mediaId: string | null;
  className?: string;
  fallbackClassName?: string;
  iconSize?: number;
  ownerKind?: string | null;
};

export function skinMediaSource(mediaId: string | null): string | null {
  return mediaId ? `/api/supply/media/${encodeURIComponent(mediaId)}/content` : null;
}

function MediaFallback({ className, iconSize, failed = false }: { className: string; iconSize: number; failed?: boolean }) {
  return <span className={className}><FileImage size={iconSize} aria-hidden="true" /><span>{failed ? "图片暂不可用" : "暂无公开图"}</span></span>;
}

/** One display cycle: failure is local, so a remount on mediaId change always starts clean. */
function SkinMediaCycle({ src, fallbackClassName, iconSize, alt = "", preview = false }: { src: string | null; fallbackClassName: string; iconSize: number; alt?: string; preview?: boolean }) {
  const [state, setState] = useState<"loading" | "loaded" | "failed">("loading");
  if (!src || state === "failed") return <>
    <MediaFallback className={fallbackClassName} iconSize={iconSize} failed={Boolean(src)} />
    {src && preview ? <button type="button" className="button secondary skin-preview-retry" onClick={() => setState("loading")}><RotateCw size={16} aria-hidden="true" />重试图片</button> : null}
  </>;
  return <>
    <img src={src} alt={alt} loading={preview ? "eager" : "lazy"} decoding="async" data-state={state} onLoad={() => setState("loaded")} onError={() => setState("failed")} />
    {state === "loading" ? <span className="skin-media-loading">图片加载中…</span> : null}
  </>;
}

/** Public skin thumbnail over the existing media URL contract; missing or failed media stays neutral. */
export function SkinMediaThumb({ mediaId, ownerKind, className = "skin-card-media", fallbackClassName = "skin-card-media-fallback", iconSize = 16 }: SkinMediaThumbProps) {
  const src = skinMediaSource(mediaId);
  return <span className={`skin-media ${className}`} data-owner-kind={ownerKind ?? "UNKNOWN"} aria-hidden="true">
    <SkinMediaCycle key={src ?? "missing"} src={src} fallbackClassName={fallbackClassName} iconSize={iconSize} />
  </span>;
}

export function skinCardTitle(tag: { name: string; ownerName?: string | null; baseName?: string | null }): string {
  return tag.name;
}

export function SkinMetadata({ skin, className = "", qualityTag = false }: { skin: SkinDisplay; className?: string; qualityTag?: boolean }) {
  const quality = skin.rarityName?.trim() || "";
  if (qualityTag) {
    // Picker mode: quality is a tag and an unconfirmed quality shows no tag at all;
    // the source basis stays in the preview dialog instead of repeating per tile.
    if (!quality && skin.isCollectible !== true && skin.defaultState !== "DEFAULT") return null;
    return <span className={`skin-metadata skin-metadata--tags ${className}`.trim()}>
      {quality ? <span className="skin-quality-tag" title={skin.rarityBasis === "PLATFORM_REFERENCE" ? "品质来自平台参考资料，以官方确认为准" : undefined}>{quality}</span> : null}
      {skin.isCollectible === true ? <span className="skin-quality-tag skin-quality-tag--collectible">典藏</span> : null}
      {skin.defaultState === "DEFAULT" ? <span className="skin-quality-tag">默认外观</span> : null}
    </span>;
  }
  return <span className={`skin-metadata ${className}`.trim()}>
    <span>{quality || "品质待核"}{skin.rarityBasis === "PLATFORM_REFERENCE" ? " · 平台资料" : ""}</span>
    {skin.isCollectible === true ? <span>典藏</span> : null}
    {skin.defaultState === "DEFAULT" ? <span>默认外观</span> : null}
  </span>;
}

/** One real-media preview for publish, market and public/owner detail; Radix restores the trigger. */
export function SkinMediaPreview({ skin, children, triggerClassName = "skin-media-preview-trigger", mediaClassName, fallbackClassName, iconSize = 22 }: {
  skin: SkinDisplay; children?: ReactNode; triggerClassName?: string; mediaClassName?: string; fallbackClassName?: string; iconSize?: number;
}) {
  const thumbnail = <SkinMediaThumb mediaId={skin.mediaId ?? null} ownerKind={skin.ownerKind} className={mediaClassName} fallbackClassName={fallbackClassName} iconSize={iconSize} />;
  if (!skin.mediaId) return children ? null : thumbnail;
  return <Dialog.Root>
    <Dialog.Trigger asChild><button type="button" className={triggerClassName} aria-label={`放大查看 ${skin.name} 皮肤图片`}>{children ?? thumbnail}</button></Dialog.Trigger>
    <Dialog.Portal>
      {/* React Aria drawers recognise this layer when hiding and containing focus outside their portal. */}
      <Dialog.Overlay className="skin-preview-overlay" data-react-aria-top-layer="" />
      <Dialog.Content className="skin-preview-content" data-react-aria-top-layer="" aria-describedby={undefined} onEscapeKeyDown={(event) => event.stopPropagation()}>
        <Dialog.Title className="skin-preview-title">{skin.name} 皮肤图片</Dialog.Title>
        {skin.mediaKind === "PROMO_POSTER" ? <span className="skin-preview-kind">宣传图</span> : null}
        <Dialog.Close className="skin-preview-close" aria-label="关闭预览"><X size={20} aria-hidden="true" /></Dialog.Close>
        <div className="skin-preview-image"><SkinMediaCycle key={skin.mediaId} src={skinMediaSource(skin.mediaId)} alt={`${skin.name} 皮肤图片`} fallbackClassName="skin-preview-fallback" iconSize={32} preview /></div>
        <SkinMetadata skin={skin} />
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
