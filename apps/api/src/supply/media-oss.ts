import OSS from "ali-oss";
import { join } from "node:path";

import { ConfigurationError } from "../config/config";
import { createLocalMediaStorage, MediaStorageError, STORAGE_KEY_PATTERN, type MediaStorage } from "./media";

export const OSS_REQUEST_TIMEOUT_MS = 30_000;

export type OssMediaStorageOptions = {
  bucket: string;
  region: string;
  endpoint: string;
  objectPrefix: string;
};

export type OssCredentials = {
  accessKeyId: string;
  accessKeySecret: string;
  stsToken?: string;
};

// Structural surface of the ali-oss client used by this adapter; injected in tests.
export type OssObjectClient = {
  head: (objectKey: string) => Promise<unknown>;
  put: (objectKey: string, bytes: Buffer) => Promise<unknown>;
  get: (objectKey: string) => Promise<{ content: Buffer }>;
};

function isSafeOssName(value: string): boolean {
  return /^[a-z0-9][a-z0-9-]{1,62}$/.test(value);
}

function validateEndpoint(endpoint: string, name: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ConfigurationError(`${name} must be an absolute https URL`);
  }
  // Signed requests carry the server credentials; only official OSS endpoints are allowed.
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || !url.hostname.endsWith(".aliyuncs.com")) {
    throw new ConfigurationError(`${name} must be an official https OSS endpoint`);
  }
}

export function loadOssMediaStorageOptions(env: NodeJS.ProcessEnv): OssMediaStorageOptions {
  const missing: string[] = [];
  const read = (name: string): string => {
    const value = env[name]?.trim() ?? "";
    if (!value) missing.push(name);
    return value;
  };
  const bucket = read("OSS_BUCKET");
  const region = read("OSS_REGION");
  const endpoint = read("OSS_ENDPOINT");
  const objectPrefix = read("OSS_OBJECT_PREFIX");
  if (missing.length > 0) throw new ConfigurationError(`OSS media storage requires ${missing.join(", ")}`);
  if (!isSafeOssName(bucket)) throw new ConfigurationError("OSS_BUCKET is invalid");
  if (!isSafeOssName(region)) throw new ConfigurationError("OSS_REGION is invalid");
  validateEndpoint(endpoint, "OSS_ENDPOINT");
  // The prefix must be non-empty, use safe characters and end with a slash so every
  // object key stays inside the authorized prefix.
  if (!/^[A-Za-z0-9][A-Za-z0-9/._-]*\/$/.test(objectPrefix) || objectPrefix.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new ConfigurationError("OSS_OBJECT_PREFIX is invalid");
  }
  return { bucket, region, endpoint, objectPrefix };
}

export function loadOssCredentials(env: NodeJS.ProcessEnv): OssCredentials {
  const missing: string[] = [];
  const accessKeyId = env.ALIBABA_CLOUD_ACCESS_KEY_ID?.trim() ?? "";
  const accessKeySecret = env.ALIBABA_CLOUD_ACCESS_KEY_SECRET?.trim() ?? "";
  if (!accessKeyId) missing.push("ALIBABA_CLOUD_ACCESS_KEY_ID");
  if (!accessKeySecret) missing.push("ALIBABA_CLOUD_ACCESS_KEY_SECRET");
  if (missing.length > 0) throw new ConfigurationError(`OSS media storage requires server-side credentials: ${missing.join(", ")}`);
  const stsToken = env.ALIBABA_CLOUD_SECURITY_TOKEN?.trim();
  return stsToken ? { accessKeyId, accessKeySecret, stsToken } : { accessKeyId, accessKeySecret };
}

export function ossObjectKey(objectPrefix: string, storageKey: string): string {
  return `${objectPrefix}${storageKey.slice(0, 2)}/${storageKey}`;
}

function isObjectMissing(error: unknown): boolean {
  const status = (error as { status?: unknown }).status;
  const code = (error as { code?: unknown }).code;
  return code === "NoSuchKey" || status === 404;
}

// Never surface SDK messages, headers or request ids: they are not for logs or clients.
function storageFailure(): MediaStorageError {
  return new MediaStorageError("media storage operation failed");
}

function defaultCreateClient(options: OssMediaStorageOptions, credentials: OssCredentials): OssObjectClient {
  const client = new OSS({
    region: options.region,
    bucket: options.bucket,
    endpoint: options.endpoint,
    secure: true,
    accessKeyId: credentials.accessKeyId,
    accessKeySecret: credentials.accessKeySecret,
    ...(credentials.stsToken ? { stsToken: credentials.stsToken } : {}),
    authorizationV4: true,
    timeout: OSS_REQUEST_TIMEOUT_MS,
  });
  return client;
}

export function createOssMediaStorage(
  options: OssMediaStorageOptions,
  credentials: OssCredentials,
  deps: { createClient?: (options: OssMediaStorageOptions, credentials: OssCredentials) => OssObjectClient } = {},
): MediaStorage {
  const createClient = deps.createClient ?? defaultCreateClient;
  const client = createClient(options, credentials);
  return {
    available: true,
    kind: "oss",
    async write(bytes, contentHash) {
      if (!STORAGE_KEY_PATTERN.test(contentHash)) throw new MediaStorageError("content hash is invalid");
      const objectKey = ossObjectKey(options.objectPrefix, contentHash);
      try {
        // Content-addressed object already present; skip the upload.
        await client.head(objectKey);
        return { storageKey: contentHash };
      } catch (error) {
        if (!isObjectMissing(error)) throw storageFailure();
      }
      try {
        await client.put(objectKey, bytes);
        return { storageKey: contentHash };
      } catch {
        // Unknown outcome (including timeouts): keys are content addressed, so a
        // retry re-runs this path safely and cannot duplicate business objects.
        throw storageFailure();
      }
    },
    async read(storageKey) {
      if (!STORAGE_KEY_PATTERN.test(storageKey)) throw new MediaStorageError("storage key is invalid");
      try {
        const result = await client.get(ossObjectKey(options.objectPrefix, storageKey));
        if (!Buffer.isBuffer(result.content)) throw storageFailure();
        return result.content;
      } catch (error) {
        if (isObjectMissing(error)) throw new MediaStorageError("stored media is unavailable");
        throw storageFailure();
      }
    },
  };
}

// Explicit media provider selection, independent of PROVIDER_MODE: choosing the
// OSS adapter never turns SMS, identity or payment providers into real mode.
export function resolveMediaStorage(env: NodeJS.ProcessEnv, workingDirectory: string): MediaStorage {
  const kind = env.MEDIA_STORAGE?.trim() || "local";
  if (kind === "local") return createLocalMediaStorage(join(workingDirectory, "uploads"));
  if (kind === "oss") return createOssMediaStorage(loadOssMediaStorageOptions(env), loadOssCredentials(env));
  throw new ConfigurationError("MEDIA_STORAGE must be local or oss");
}
