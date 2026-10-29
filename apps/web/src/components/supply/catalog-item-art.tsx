"use client";
import { useState, type ReactNode } from "react";

export function CatalogItemArt({ mediaId, children }: { mediaId?: string | null; children: ReactNode }) {
  const [failed, setFailed] = useState<string | null>(null);
  const safeId = mediaId && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(mediaId) ? mediaId : null;
  return safeId && failed !== safeId
    ? <img src={`/api/supply/media/${encodeURIComponent(safeId)}/content`} alt="" width={56} height={56} loading="lazy" onError={() => setFailed(safeId)} />
    : children;
}
