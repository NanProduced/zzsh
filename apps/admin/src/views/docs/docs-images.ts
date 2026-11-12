import { useCallback, useEffect, useRef, useState } from "react";
import { isImagesDisabled, signDocImages, uploadDocImageIntent, completeDocImage } from "./docs-api";
import type { DocImageUploadIntent } from "./docs-model";

/**
 * P1a 私有图片：两阶段 upload-intent（POST docs/:id/images → 浏览器按凭证
 * PUT/POST 到 API 中继 → complete），查看走 10 分钟签名（过期自动重签）。
 * 503 IMAGES_DISABLED → 「未开启图片存储」，其余文档功能照常。
 */

export const DOC_IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp"] as const;
export const DOC_IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const DOC_IMAGE_MAX_DIM = 8192;
const SIGN_MARGIN_MS = 30_000;

export class ImagesDisabledError extends Error {
  constructor() {
    super("未开启图片存储");
    this.name = "ImagesDisabledError";
  }
}

export type DocImageMeta = { mime: string; bytes: number; width: number; height: number };

async function imageDimensions(file: File): Promise<{ width: number; height: number }> {
  if (typeof globalThis.createImageBitmap === "function") {
    const bitmap = await globalThis.createImageBitmap(file);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  }
  return await new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();
    image.onload = () => { URL.revokeObjectURL(url); resolve({ width: image.naturalWidth, height: image.naturalHeight }); };
    image.onerror = () => { URL.revokeObjectURL(url); reject(new Error("图片无法解码，请换一张图片重试。")); };
    image.src = url;
  });
}

export async function readDocImageMeta(file: File): Promise<DocImageMeta> {
  if (!(DOC_IMAGE_MIMES as readonly string[]).includes(file.type)) throw new Error("只支持 PNG / JPEG / WebP 图片。");
  if (file.size < 1 || file.size > DOC_IMAGE_MAX_BYTES) throw new Error("图片大小需在 1 字节到 10 MiB 之间。");
  const { width, height } = await imageDimensions(file);
  if (width < 1 || height < 1 || width > DOC_IMAGE_MAX_DIM || height > DOC_IMAGE_MAX_DIM) throw new Error(`图片边长需在 1–${DOC_IMAGE_MAX_DIM} 像素之间。`);
  return { mime: file.type, bytes: file.size, width, height };
}

/** 浏览器 → API 中继：fields 走 POST 表单，headers 走 PUT 原字节；XHR 提供上传进度。 */
export function relayUpload(intent: DocImageUploadIntent, file: File, onProgress?: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const useFields = Boolean(intent.upload.fields);
    xhr.open(useFields ? "POST" : "PUT", intent.upload.url, true);
    xhr.withCredentials = true;
    if (!useFields && intent.upload.headers) {
      for (const [name, value] of Object.entries(intent.upload.headers)) xhr.setRequestHeader(name, value);
    }
    xhr.upload.onprogress = (event) => { if (event.lengthComputable) onProgress?.(Math.min(1, event.loaded / event.total)); };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) { onProgress?.(1); resolve(); }
      else reject(new Error(`图片上传失败（${xhr.status}），请重试。`));
    };
    xhr.onerror = () => reject(new Error("图片上传网络失败，请重试。"));
    xhr.ontimeout = () => reject(new Error("图片上传超时，请重试。"));
    if (useFields) {
      const form = new FormData();
      for (const [name, value] of Object.entries(intent.upload.fields!)) form.append(name, value);
      form.append("file", file);
      xhr.send(form);
    } else {
      xhr.send(file);
    }
  });
}

export async function uploadDocImage(nodeId: string, file: File, onProgress?: (fraction: number) => void): Promise<{ imageId: string }> {
  const meta = await readDocImageMeta(file);
  const intent = async () => {
    try {
      return await uploadDocImageIntent(nodeId, meta);
    } catch (failure) {
      if (isImagesDisabled(failure)) throw new ImagesDisabledError();
      throw failure;
    }
  };
  let handle = await intent();
  try {
    await relayUpload(handle, file, onProgress);
  } catch {
    // 凭证 5 分钟过期或被拒：重签一次（新 imageId）；旧 PENDING 由服务端到期清理。
    handle = await intent();
    await relayUpload(handle, file, onProgress);
  }
  await completeDocImage(handle.imageId);
  return { imageId: handle.imageId };
}

export type DocImageSigner = {
  sign: (imageIds: readonly string[], force?: boolean) => Promise<Record<string, string>>;
  urlsFor: (imageIds: readonly string[]) => Record<string, string>;
  nextExpiry: (imageIds: readonly string[]) => number | null;
  invalidate: (imageIds?: readonly string[]) => void;
};

export function createDocImageSigner(nodeId: string): DocImageSigner {
  const cache = new Map<string, { url: string; expiresAt: number }>();
  const sign = async (imageIds: readonly string[], force = false): Promise<Record<string, string>> => {
    const now = Date.now();
    const need = [...new Set(imageIds)].filter((id) => force || !cache.has(id) || cache.get(id)!.expiresAt - SIGN_MARGIN_MS <= now);
    for (let index = 0; index < need.length; index += 100) {
      const chunk = need.slice(index, index + 100);
      const result = await signDocImages(nodeId, chunk);
      for (const [id, entry] of Object.entries(result.urls ?? {})) {
        cache.set(id, { url: entry.url, expiresAt: Date.parse(entry.expiresAt) || now + 10 * 60_000 });
      }
    }
    return urlsFor(imageIds);
  };
  const urlsFor = (imageIds: readonly string[]): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const id of new Set(imageIds)) {
      const entry = cache.get(id);
      if (entry) out[id] = entry.url;
    }
    return out;
  };
  const nextExpiry = (imageIds: readonly string[]): number | null => {
    let min: number | null = null;
    for (const id of new Set(imageIds)) {
      const entry = cache.get(id);
      if (entry && (min === null || entry.expiresAt < min)) min = entry.expiresAt;
    }
    return min;
  };
  const invalidate = (imageIds?: readonly string[]) => {
    if (!imageIds) cache.clear();
    else for (const id of imageIds) cache.delete(id);
  };
  return { sign, urlsFor, nextExpiry, invalidate };
}

/** 当前文档图片 URL：挂载即签，临近过期自动重签；refresh 供 img 加载失败时强制重签。 */
export function useDocImageUrls(nodeId: string | null, imageIds: readonly string[]) {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const signerRef = useRef<{ nodeId: string | null; signer: DocImageSigner | null }>({ nodeId: null, signer: null });
  const idsKey = [...new Set(imageIds)].sort().join(",");

  const signer = () => {
    if (signerRef.current.nodeId !== nodeId || !signerRef.current.signer) {
      signerRef.current = { nodeId, signer: nodeId ? createDocImageSigner(nodeId) : null };
    }
    return signerRef.current.signer;
  };

  const refresh = useCallback(async (forceIds?: readonly string[]): Promise<Record<string, string>> => {
    const instance = signer();
    if (!instance) { setUrls({}); return {}; }
    const ids = [...new Set([...(idsKey ? idsKey.split(",") : []), ...(forceIds ?? [])])];
    if (!ids.length) { setUrls({}); return {}; }
    try {
      if (forceIds?.length) instance.invalidate(forceIds);
      const next = await instance.sign(ids, Boolean(forceIds?.length));
      setUrls((current) => ({ ...current, ...next }));
      setError(null);
      return next;
    } catch {
      setError("图片签名暂时不可用，正文不受影响；稍后自动重试。");
      return {};
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, idsKey]);

  useEffect(() => {
    if (!nodeId || !idsKey) { setUrls({}); setError(null); return; }
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const instance = signer();
    const run = async () => {
      try {
        const ids = idsKey.split(",");
        const next = await instance!.sign(ids);
        if (!alive) return;
        setUrls(next);
        setError(null);
        const expiry = instance!.nextExpiry(ids);
        if (expiry !== null) {
          timer = setTimeout(() => { void run(); }, Math.max(5_000, expiry - SIGN_MARGIN_MS - Date.now()));
        }
      } catch {
        if (!alive) return;
        setError("图片签名暂时不可用，正文不受影响；稍后自动重试。");
        timer = setTimeout(() => { void run(); }, 30_000);
      }
    };
    void run();
    return () => { alive = false; if (timer) clearTimeout(timer); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeId, idsKey]);

  return { urls, error, refresh };
}