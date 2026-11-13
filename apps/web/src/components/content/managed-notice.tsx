"use client";

import { PlateDocument } from "@zzsh/ui/plate-document";
import "@zzsh/ui/plate-document.css";
import { extractPlate } from "@zzsh/content/plate";
import { usePublicContent } from "./public-content-provider";

/** PlateDocument 只接受已解析的素材 URL；空值（素材不可用）交给渲染器占位。 */
function plateMediaUrls(urls: Readonly<Record<string, string | null>>): Record<string, string> {
  return Object.fromEntries(Object.entries(urls).filter((entry): entry is [string, string] => entry[1] !== null));
}

export function ManagedNoticeSections({ contentKey, compact = false }: { contentKey: string; compact?: boolean }) {
  const { status, resource, retry } = usePublicContent(contentKey);
  if (status === "loading") return <p role="status">正在读取说明…</p>;
  if (status === "error") return <div role="status"><p>说明暂时无法读取，请以本次报价、条款和订单记录为准。</p><button type="button" className="button quiet" onClick={retry}>重试读取说明</button></div>;
  if (!resource?.payload || resource.payload.kind !== "notice") return <p role="status">当前说明未公布，请通过站内客服核对。</p>;
  const payload = resource.payload;
  const mediaUrls = plateMediaUrls(Object.fromEntries(resource.media.map(row => [row.id, row.url])));
  return <div className={compact ? "content-document managed-notice managed-notice--compact" : "content-document managed-notice"}>
    <PlateDocument document={payload.document} mediaUrls={mediaUrls} />
  </div>;
}

export function ManagedNoticeText({ contentKey, fallback }: { contentKey: string; fallback?: string }) {
  const { status, resource } = usePublicContent(contentKey);
  if (status === "loading") return <span>{fallback ?? "正在读取说明…"}</span>;
  if (status === "error") return <span>{fallback ?? "说明暂时无法读取，具体条件以本次有效报价与条款为准。"}</span>;
  const payload = resource?.payload?.kind === "notice" ? resource.payload : null;
  if (!payload) return <span>{fallback ?? "当前说明尚未公布。"}</span>;
  return <span>{extractPlate(payload.document).plainText}</span>;
}