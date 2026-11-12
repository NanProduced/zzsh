import OSS from "ali-oss";

import { ConfigurationError } from "../config/config";
import { ALLOWED_IMAGE_MIMES, type ImageMime } from "../supply/media";
import {
  INTERNAL_DOCS_OSS_PREFIX,
  OSS_REQUEST_TIMEOUT_MS,
  assertPublicObjectPrefix,
  loadOssCredentials,
  type OssCredentials,
} from "../supply/media-oss";

/**
 * P1a internal documentation images use an API relay (browser -> API -> OSS).
 * There are no STS credentials, signed URLs or direct browser uploads: every
 * upload and view is authorized per request by the admin session. Objects live
 * under the fixed private internal-docs/ prefix in the existing bucket and are
 * written with a private ACL. When OSS is not configured the feature is disabled
 * and the image endpoints answer 503 IMAGES_DISABLED while documents keep working.
 */

export const DOCS_IMAGE_UPLOAD_TTL_MS = 5 * 60 * 1000;
export const DOCS_IMAGE_VIEW_TTL_MS = 10 * 60 * 1000;

const MIME_EXTENSION: Record<ImageMime, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export function docsImageExtension(mime: ImageMime): string {
  return MIME_EXTENSION[mime]!;
}

/** object_key = internal-docs/<nodeId>/<imageId>.<ext>; matches the 0197 CHECK. */
export function docsImageObjectKey(nodeId: string, imageId: string, mime: ImageMime): string {
  return `${INTERNAL_DOCS_OSS_PREFIX}${nodeId}/${imageId}.${docsImageExtension(mime)}`;
}

export function assertDocsImageObjectKey(objectKey: string): void {
  if (!objectKey.startsWith(INTERNAL_DOCS_OSS_PREFIX) || objectKey.includes("..")) {
    throw new ConfigurationError("docs image object key is outside the internal-docs/ prefix");
  }
}

// Structural surface of the ali-oss client used by the docs relay; injected in tests.
export type DocsImageObjectClient = {
  head: (objectKey: string) => Promise<unknown>;
  put: (objectKey: string, bytes: Buffer, options: { mime: ImageMime; headers: Record<string, string> }) => Promise<unknown>;
  get: (objectKey: string) => Promise<{ content: Buffer }>;
  delete: (objectKey: string) => Promise<unknown>;
};

export type DocsImageStorage = {
  writeObject: (objectKey: string, bytes: Buffer, mime: ImageMime) => Promise<void>;
  readObject: (objectKey: string) => Promise<Buffer>;
  headObject: (objectKey: string) => Promise<boolean>;
  deleteObject: (objectKey: string) => Promise<void>;
};

export type DocsImageFeature =
  | { enabled: false }
  | { enabled: true; prefix: string; storage: DocsImageStorage };

export const DOCS_IMAGES_DISABLED: DocsImageFeature = { enabled: false };

function isObjectMissing(error: unknown): boolean {
  const status = (error as { status?: unknown }).status;
  const code = (error as { code?: unknown }).code;
  return code === "NoSuchKey" || status === 404;
}

export function defaultCreateDocsImageClient(target: { bucket: string; region: string; endpoint: string }, credentials: OssCredentials): DocsImageObjectClient {
  return new OSS({
    region: target.region,
    bucket: target.bucket,
    endpoint: target.endpoint,
    secure: true,
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    ...(credentials.stsToken ? { stsToken: credentials.stsToken } : {}),
    authorizationV4: true,
    timeout: OSS_REQUEST_TIMEOUT_MS,
  }) as unknown as DocsImageObjectClient;
}

export function createDocsImageStorage(client: DocsImageObjectClient): DocsImageStorage {
  return {
    async writeObject(objectKey, bytes, mime) {
      assertDocsImageObjectKey(objectKey);
      if (!ALLOWED_IMAGE_MIMES.includes(mime)) throw new ConfigurationError("docs image MIME is invalid");
      // Private ACL is forced on every internal object; the bucket is private too.
      await client.put(objectKey, bytes, { mime, headers: { "x-oss-object-acl": "private" } });
    },
    async readObject(objectKey) {
      assertDocsImageObjectKey(objectKey);
      const result = await client.get(objectKey);
      if (!Buffer.isBuffer(result.content)) throw new ConfigurationError("docs image object is unavailable");
      return result.content;
    },
    async headObject(objectKey) {
      assertDocsImageObjectKey(objectKey);
      try {
        await client.head(objectKey);
        return true;
      } catch (error) {
        if (isObjectMissing(error)) return false;
        throw error;
      }
    },
    async deleteObject(objectKey) {
      assertDocsImageObjectKey(objectKey);
      try {
        await client.delete(objectKey);
      } catch (error) {
        if (!isObjectMissing(error)) throw error;
      }
    },
  };
}

function readOssTarget(env: NodeJS.ProcessEnv): { bucket: string; region: string; endpoint: string } {
  const bucket = env.OSS_BUCKET?.trim() ?? "";
  const region = env.OSS_REGION?.trim() ?? "";
  const endpoint = env.OSS_ENDPOINT?.trim() ?? "";
  if (!bucket || !region || !endpoint) throw new ConfigurationError("docs images require OSS_BUCKET, OSS_REGION and OSS_ENDPOINT");
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(bucket)) throw new ConfigurationError("OSS_BUCKET is invalid");
  if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(region)) throw new ConfigurationError("OSS_REGION is invalid");
  let url: URL;
  try { url = new URL(endpoint); } catch { throw new ConfigurationError("OSS_ENDPOINT must be an absolute https URL"); }
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.hostname.endsWith(".aliyuncs.com")) {
    throw new ConfigurationError("OSS_ENDPOINT must be an official https OSS endpoint");
  }
  return { bucket, region, endpoint };
}

/**
 * Resolve the docs image feature. Disabled unless DOCS_IMAGES_ENABLED=true and
 * the shared OSS target plus server credentials are present. DOCS_OSS_PREFIX is
 * fixed to internal-docs/ and must not overlap the public object prefix.
 */
export function loadDocsImageFeature(
  env: NodeJS.ProcessEnv,
  deps: { createClient?: (target: { bucket: string; region: string; endpoint: string }, credentials: OssCredentials) => DocsImageObjectClient } = {},
): DocsImageFeature {
  if ((env.DOCS_IMAGES_ENABLED?.trim() ?? "false") !== "true") return DOCS_IMAGES_DISABLED;
  const prefix = env.DOCS_OSS_PREFIX?.trim() || INTERNAL_DOCS_OSS_PREFIX;
  if (prefix !== INTERNAL_DOCS_OSS_PREFIX) throw new ConfigurationError("DOCS_OSS_PREFIX must be internal-docs/");
  const publicPrefix = env.OSS_OBJECT_PREFIX?.trim();
  if (publicPrefix) assertPublicObjectPrefix(publicPrefix);
  let target: { bucket: string; region: string; endpoint: string };
  let credentials: OssCredentials;
  try {
    target = readOssTarget(env);
    credentials = loadOssCredentials(env);
  } catch (error) {
    // Missing storage configuration disables images only; documents stay available.
    if (error instanceof ConfigurationError) return DOCS_IMAGES_DISABLED;
    throw error;
  }
  const createClient = deps.createClient ?? defaultCreateDocsImageClient;
  return { enabled: true, prefix, storage: createDocsImageStorage(createClient(target, credentials)) };
}