import { useEffect, useRef, useState } from "react";
import { Crop, ImageOff, ImageUp } from "lucide-react";
import { adminRequest, friendlyError, type UploadedAssetResponse } from "../api";
import { Button } from "@/components/ui/button";

const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
export const MAX_CONTENT_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_ADJUST_BYTES = 32 * 1024 * 1024;
const imageFormatHint = "JPEG、PNG 或 WebP，单张不超过 10 MB。";

export const contentMediaUrl = (id: string) => `/api/bff/admin/content/media/${encodeURIComponent(id)}/content`;

export function contentMediaSize(value: number | string) {
  const bytes = Number(value);
  return bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toLocaleString("zh-CN", { maximumFractionDigits: 1 })} MB`
    : bytes >= 1024 ? `${Math.round(bytes / 1024)} KB` : `${bytes} B`;
}

export function contentMediaFileIssue(file: File, acceptedMime?: "image/png") {
  if (acceptedMime && file.type !== acceptedMime) return "请选择 PNG 图片。";
  if (!IMAGE_TYPES.includes(file.type)) return "请选择 JPEG、PNG 或 WebP 图片。";
  if (!file.size) return "图片文件为空，请另选一张。";
  if (file.size > MAX_ADJUST_BYTES) return "这张图片太大，请先在本地缩小到 10 MB 以内。";
  if (file.size > MAX_CONTENT_IMAGE_BYTES) return "这张图片超过 10 MB。可缩小尺寸后再上传。";
}

export async function uploadContentMedia(file: File): Promise<UploadedAssetResponse> {
  const issue = contentMediaFileIssue(file);
  if (issue) throw new Error(issue);
  let intent: { intentId: string; uploadToken: string };
  try {
    intent = await adminRequest("/content/media/upload-intents", { purpose: "CONTENT_MEDIA", mime: file.type, size: file.size });
  } catch (failure) {
    throw new Error(friendlyError(failure));
  }
  if (!intent?.intentId || !intent.uploadToken) throw new Error("暂时无法开始上传，请稍后重试。");
  const response = await fetch(`/api/bff/admin/content/media/uploads/${encodeURIComponent(intent.intentId)}`, {
    method: "PUT", credentials: "include", headers: { "content-type": file.type, "x-upload-token": intent.uploadToken, "idempotency-key": `idem_${crypto.randomUUID().replaceAll("-", "")}` }, body: file,
  }).catch(() => null);
  const payload = await response?.json().catch(() => null) as (UploadedAssetResponse & { error?: { code?: string } }) | null | undefined;
  if (!response?.ok || !payload?.assetId) throw new Error(payload?.error?.code === "INVALID_ARGUMENT"
    ? "无法读取这张图片，请重新导出为 JPEG、PNG 或 WebP 后再试。"
    : response?.status === 403 ? "没有权限上传图片，请重新进入管理平台后再试。"
      : "暂时无法确认是否上传成功。请先到图片素材查看，避免重复上传。");
  return payload;
}

export function ContentImage({ src, alt, lazy = false, onDimensions }: {
  src: string; alt: string; lazy?: boolean; onDimensions?: (dimensions: { width: number; height: number }) => void;
}) {
  const [failedSrc, setFailedSrc] = useState<string>();
  return failedSrc === src
    ? <span className="content-picture-fallback" role="img" aria-label={`${alt}无法显示`}><ImageOff size={18} aria-hidden="true" />无法显示</span>
    : <img src={src} alt={alt} loading={lazy ? "lazy" : undefined} onError={() => { setFailedSrc(src); onDimensions?.({ width: 0, height: 0 }); }}
      onLoad={event => onDimensions?.({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight })} />;
}

export function ContentMediaFileField({ file, onChange, disabled, onAdjust, onDimensions, acceptedMime }: {
  file: File | null; onChange: (file: File | null) => void; disabled?: boolean; onAdjust?: () => void; acceptedMime?: "image/png";
  onDimensions?: (file: File, dimensions: { width: number; height: number }) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [preview, setPreview] = useState<{ file: File; url: string } | null>(null);
  const issue = file ? contentMediaFileIssue(file, acceptedMime) : undefined;
  useEffect(() => {
    if (!file || issue) { setPreview(null); return; }
    const url = URL.createObjectURL(file);
    setPreview({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file, issue]);
  return <div className="content-file-field">
    {preview && file === preview.file ? <div className="content-file-preview"><ContentImage src={preview.url} alt="待上传图片预览" onDimensions={size => onDimensions?.(preview.file, size)} /></div> : null}
    <input ref={input} type="file" accept={acceptedMime ?? IMAGE_TYPES.join(",")} tabIndex={-1} className="sr-only" aria-hidden="true" disabled={disabled}
      onChange={event => { onChange(event.currentTarget.files?.[0] ?? null); event.currentTarget.value = ""; }} />
    <div className="flex min-w-0 flex-wrap items-center gap-3">
      <Button type="button" variant="outline" disabled={disabled} onClick={() => input.current?.click()}><ImageUp size={15} aria-hidden="true" />{file ? "重新选择文件" : "选择本地图片"}</Button>
      {file && file.size > 0 && file.size <= MAX_ADJUST_BYTES && IMAGE_TYPES.includes(file.type) && onAdjust
        ? <Button type="button" variant="ghost" disabled={disabled} onClick={onAdjust}><Crop size={15} aria-hidden="true" />裁剪或调整尺寸</Button> : null}
      {file ? <span className="min-w-0 break-all text-sm">{file.name}</span> : null}
    </div>
    <p className="text-xs text-muted-foreground">{acceptedMime ? "PNG，单张不超过 10 MB。" : imageFormatHint}</p>
    {issue ? <p className="text-sm text-destructive" role="alert">{issue}</p> : null}
  </div>;
}
