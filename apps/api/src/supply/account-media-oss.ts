import type OSS from "ali-oss";
import { createHash, randomUUID } from "node:crypto";
import { addAbortSignal } from "node:stream";

import { ConfigurationError } from "../config/config";
import { inspectAccountWebp, MAX_MEDIA_BYTES, MediaStorageError, STORAGE_KEY_PATTERN, type ImageInfo, type ImageMime } from "./media";
import type { OssCredentials, OssMediaStorageOptions } from "./media-oss";
import { ACCOUNT_IMAGE_VARIANT_EDGES, type AccountImageEdge, type AccountImageWatermark } from "./account-image-watermark";

const PRIVATE_READ_TTL_SECONDS = 120;

export type OssAccountMediaUpload = {
  method: "POST";
  url: string;
  fields: Record<string, string>;
};

export type OssAccountMedia = {
  createUpload: (intentId: string, expiresAt: string, mime: ImageMime, size: number) => OssAccountMediaUpload;
  readUpload: (intentId: string, size: number) => Promise<Buffer>;
  signOriginal: (storageKey: string) => Promise<string>;
  previewVariants: (storageKey: string, source: Pick<ImageInfo, "width" | "height">, watermark: AccountImageWatermark) => Promise<Array<{ maxEdge: AccountImageEdge; url: string }>>;
  generateVariants: (storageKey: string, source: Pick<ImageInfo, "width" | "height">, watermark: AccountImageWatermark, onAttempt: (objectKey: string) => void) => Promise<AccountMediaVariant[]>;
};

export type AccountMediaVariant = {
  maxEdge: AccountImageEdge;
  objectKey: string;
  sha256: string;
  byteSize: number;
  width: number;
  height: number;
  watermarkRevision: string;
};

type OssAccountObjectClient = Pick<OSS, "getStream" | "processObjectSave" | "signPostObjectPolicyV4">;

export function accountMediaBrowserOrigin(env: NodeJS.ProcessEnv): string | undefined {
  const enabled = env.OSS_ACCOUNT_MEDIA_DIRECT?.trim();
  if (!enabled || enabled === "0") return;
  if (enabled !== "1") throw new ConfigurationError("OSS_ACCOUNT_MEDIA_DIRECT must be 0 or 1");
  const value = env.OSS_ACCOUNT_MEDIA_BROWSER_ORIGIN?.trim() ?? "";
  if (!/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}\/?$/i.test(value)) {
    throw new ConfigurationError("OSS_ACCOUNT_MEDIA_BROWSER_ORIGIN must be a dedicated https OSS domain");
  }
  return new URL(value).origin;
}

function stagingKey(prefix: string, intentId: string): string {
  if (!/^upload_[a-f0-9]{32}$/.test(intentId)) throw new MediaStorageError("upload intent is invalid");
  return `${prefix}private/account-upload/${intentId}`;
}

async function readBoundedObject(storage: OssAccountObjectClient, key: string, size: number) {
  const { stream, res } = await storage.getStream(key);
  const chunks: Buffer[] = [];
  let received = 0;
  for await (const chunk of addAbortSignal(AbortSignal.timeout(30_000), stream)) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += bytes.length;
    if (received > size) throw new MediaStorageError("stored object size is invalid");
    chunks.push(bytes);
  }
  return { bytes: Buffer.concat(chunks, received), contentType: res.headers["content-type"] };
}

export function accountVariantProcess(maxEdge: AccountImageEdge, source: Pick<ImageInfo, "width" | "height">, watermark: AccountImageWatermark, prefix: string): string {
  const resize = `image/resize,m_lfit,w_${maxEdge},h_${maxEdge},limit_1`;
  const format = "/format,webp/quality,Q_86";
  if (!watermark.enabled) return resize + format;
  const hash = watermark.logoStorageKey;
  if (!hash || !STORAGE_KEY_PATTERN.test(hash)) throw new MediaStorageError("watermark Logo is unavailable");
  const logo = `${prefix}${hash.slice(0, 2)}/${hash}?x-oss-process=image/resize,P_${watermark.sizePercent}`;
  const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
  const margin = Math.round(Math.min(source.width, source.height) * scale * watermark.marginPercent / 100);
  const overlay = `watermark,image_${Buffer.from(logo).toString("base64url")},t_${watermark.opacityPercent},g_${watermark.position},x_${margin},y_${margin}`;
  return `${resize}/${overlay}${format}`;
}

export function createOssAccountMedia(
  options: OssMediaStorageOptions,
  credentials: OssCredentials,
  browserOrigin: string,
  storage: OssAccountObjectClient,
  sign: (key: string, seconds: number, process?: string) => Promise<string>,
  now = () => new Date(),
): OssAccountMedia {
  if (!/^oss-[a-z0-9]+(?:-[a-z0-9]+)+$/.test(options.region)) throw new ConfigurationError("Account media requires a regional OSS endpoint");
  const region = options.region.slice(4);
  const contentKey = (hash: string) => {
    if (!STORAGE_KEY_PATTERN.test(hash)) throw new MediaStorageError("storage key is invalid");
    return `${options.objectPrefix}${hash.slice(0, 2)}/${hash}`;
  };
  const signedUrl = async (storageKey: string, process?: string): Promise<string> => {
    try {
      const url = new URL(await sign(contentKey(storageKey), PRIVATE_READ_TTL_SECONDS, process));
      if (url.origin !== browserOrigin || url.username || url.password || url.hash) throw new Error();
      return url.href;
    } catch {
      throw new MediaStorageError("media storage operation failed");
    }
  };
  return {
    createUpload(intentId, expiresAt, mime, size) {
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MEDIA_BYTES) throw new MediaStorageError("upload size is invalid");
      const date = now();
      const timestamp = date.toISOString().replace(/[-:]|\.\d{3}/g, "");
      const day = timestamp.slice(0, 8);
      const fields = {
        key: stagingKey(options.objectPrefix, intentId),
        "x-oss-signature-version": "OSS4-HMAC-SHA256",
        "x-oss-credential": `${credentials.accessKeyId}/${day}/${region}/oss/aliyun_v4_request`,
        "x-oss-date": timestamp,
        "x-oss-content-type": mime,
        "x-oss-object-acl": "private",
        "x-oss-forbid-overwrite": "true",
        success_action_status: "204",
        ...(credentials.stsToken ? { "x-oss-security-token": credentials.stsToken } : {}),
      };
      const policy = {
        expiration: expiresAt,
        conditions: [{ bucket: options.bucket }, ["content-length-range", size, size], ...Object.entries(fields).map(([name, value]) => ({ [name]: value }))],
      };
      return { method: "POST", url: browserOrigin, fields: { ...fields, policy: Buffer.from(JSON.stringify(policy)).toString("base64"),
        "x-oss-signature": storage.signPostObjectPolicyV4(policy, date) } };
    },
    async readUpload(intentId, size) {
      if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MEDIA_BYTES) throw new MediaStorageError("upload size is invalid");
      try {
        return (await readBoundedObject(storage, stagingKey(options.objectPrefix, intentId), size)).bytes;
      } catch (error) {
        if (error instanceof MediaStorageError) throw error;
        const code = (error as { code?: unknown } | null)?.code;
        if (code === "NoSuchKey") throw new MediaStorageError("staged object is unavailable", "MEDIA_OBJECT_NOT_FOUND");
        throw new MediaStorageError("media storage operation failed");
      }
    },
    signOriginal: signedUrl,
    async previewVariants(storageKey, source, watermark) {
      return Promise.all(ACCOUNT_IMAGE_VARIANT_EDGES.map(async maxEdge => ({
        maxEdge,
        url: await signedUrl(storageKey, accountVariantProcess(maxEdge, source, watermark, options.objectPrefix)),
      })));
    },
    async generateVariants(storageKey, source, watermark, onAttempt) {
      const generationId = randomUUID().replaceAll("-", "");
      const from = contentKey(storageKey);
      const results = await Promise.allSettled(ACCOUNT_IMAGE_VARIANT_EDGES.map(async maxEdge => {
        const objectKey = `private/account-variants/${generationId}/${maxEdge}.webp`;
        const key = options.objectPrefix + objectKey;
        const process = accountVariantProcess(maxEdge, source, watermark, options.objectPrefix);
        onAttempt(objectKey);
        const saved = await storage.processObjectSave(from, key, process, options.bucket);
        if (saved.status !== 200) throw new MediaStorageError("OSS image processing failed");
        const { bytes, contentType } = await readBoundedObject(storage, key, MAX_MEDIA_BYTES);
        if (contentType !== "image/webp") throw new MediaStorageError("OSS image variant MIME is invalid");
        const { width, height } = await inspectAccountWebp(bytes, maxEdge);
        const scale = Math.min(1, maxEdge / Math.max(source.width, source.height));
        if (width > source.width || height > source.height || Math.abs(width - source.width * scale) > 1
          || Math.abs(height - source.height * scale) > 1) throw new MediaStorageError("OSS image variant dimensions are invalid");
        return { maxEdge, objectKey, sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length,
          width, height, watermarkRevision: watermark.revision };
      }));
      return results.map(result => {
        if (result.status === "rejected") throw new MediaStorageError("OSS image variant is unavailable or invalid");
        return result.value;
      });
    },
  };
}
