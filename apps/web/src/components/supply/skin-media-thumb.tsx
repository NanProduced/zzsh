"use client";

import { useState } from "react";
import { FileImage } from "lucide-react";

type SkinMediaThumbProps = {
  mediaId: string | null;
  className?: string;
  fallbackClassName?: string;
  iconSize?: number;
};

export function skinMediaSource(mediaId: string | null): string | null {
  return mediaId ? `/api/supply/media/${encodeURIComponent(mediaId)}/content` : null;
}

function MediaFallback({ className, iconSize }: { className: string; iconSize: number }) {
  return <span className={className}><FileImage size={iconSize} aria-hidden="true" /><span>暂无公开图</span></span>;
}

/** One display cycle: failure is local, so a remount on mediaId change always starts clean. */
function SkinMediaCycle({ src, fallbackClassName, iconSize }: { src: string | null; fallbackClassName: string; iconSize: number }) {
  const [failed, setFailed] = useState(false);
  if (!src || failed) return <MediaFallback className={fallbackClassName} iconSize={iconSize} />;
  return <img src={src} alt="" loading="lazy" onError={() => setFailed(true)} />;
}

/** Public skin thumbnail over the existing media URL contract; missing or failed media stays neutral. */
export function SkinMediaThumb({ mediaId, className = "skin-card-media", fallbackClassName = "skin-card-media-fallback", iconSize = 16 }: SkinMediaThumbProps) {
  const src = skinMediaSource(mediaId);
  return <span className={className} aria-hidden="true">
    <SkinMediaCycle key={src ?? "missing"} src={src} fallbackClassName={fallbackClassName} iconSize={iconSize} />
  </span>;
}

export function skinCardTitle(tag: { name: string; ownerName?: string | null; baseName?: string | null }): string {
  const owner = tag.ownerName?.trim();
  const base = tag.baseName?.trim();
  if (!owner || !base) return tag.name;
  const composed = `${owner}-${base}`;
  return tag.name === composed || tag.name.startsWith(`${composed} `) ? tag.name : composed;
}
