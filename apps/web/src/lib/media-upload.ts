// Client-side mirror of the API media limits (apps/api/src/supply/media.ts
// MAX_MEDIA_BYTES / ALLOWED_IMAGE_MIMES). The server stays authoritative.
export const MAX_MEDIA_BYTES = 10 * 1024 * 1024;
export const MAX_MEDIA_LABEL = "10 MiB";
export const ALLOWED_MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;
export const MEDIA_ACCEPT_ATTRIBUTE = ALLOWED_MEDIA_TYPES.join(",");
export const MEDIA_UPLOAD_HINT = "支持 PNG/JPEG/WebP，单张不超过 10 MiB。";

export function mediaUploadFailureHint(file: { type: string; size: number }): string | null {
  if (!ALLOWED_MEDIA_TYPES.includes(file.type as (typeof ALLOWED_MEDIA_TYPES)[number])) {
    return "仅支持 PNG、JPEG 或 WebP 图片；请更换文件。";
  }
  if (!Number.isFinite(file.size) || file.size <= 0) return "图片内容为空或无法读取；请更换文件。";
  if (file.size > MAX_MEDIA_BYTES) {
    const size = (file.size / (1024 * 1024)).toFixed(1);
    return `图片大小 ${size} MiB 超过 ${MAX_MEDIA_LABEL} 上限；请压缩或更换图片。`;
  }
  return null;
}
