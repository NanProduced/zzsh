import type OSS from "ali-oss";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ConfigurationError } from "../config/config";
import { inspectPublicAccountImage, MAX_MEDIA_BYTES, ALLOWED_IMAGE_MIMES, STORAGE_KEY_PATTERN, type ImageMime, MediaStorageError } from "./media";
import { readBoundedObject } from "./account-media-oss";
import { isLegacyImagePath, legacyImageObjectKey } from "./legacy-path-media";
import type { AccountImageCdnTarget } from "./account-image-cdn";
import type { OssMediaStorageOptions } from "./media-oss";

export type LegacyImageProof = { path: string; sha256: string; byteSize: number; mime: ImageMime };
export type LegacyImageCdnDelivery = { id: string; accountId: string; versionId: string; position: number; sourcePath: string };
export type LegacyImageCdn = {
  enabled: boolean;
  proof: (path: string) => LegacyImageProof | undefined;
  inspectSource: (proof: LegacyImageProof) => Promise<"READY" | "PENDING_IMPORT" | "UNAVAILABLE">;
  publish: (delivery: LegacyImageCdnDelivery, proof: LegacyImageProof) => Promise<void>;
  revoke: (delivery: LegacyImageCdnDelivery) => Promise<string>;
  url: (delivery: LegacyImageCdnDelivery) => string;
};

export function parseLegacyImageCdnManifest(bytes: Buffer, sha256: string): Map<string, LegacyImageProof> {
  if (!STORAGE_KEY_PATTERN.test(sha256) || bytes.length > 16 * 1024 * 1024 || createHash("sha256").update(bytes).digest("hex") !== sha256) {
    throw new ConfigurationError("Legacy image CDN manifest SHA-256 is invalid");
  }
  try {
    const manifest = JSON.parse(bytes.toString("utf8")) as { schema?: string; images?: unknown[] };
    if (manifest.schema !== "zzsh.legacy-image-cdn.v1" || !Array.isArray(manifest.images) || !manifest.images.length) throw new Error();
    const proofs = new Map<string, LegacyImageProof>();
    for (const value of manifest.images) {
      const entry = value as LegacyImageProof;
      if (!entry || !isLegacyImagePath(entry.path) || typeof entry.sha256 !== "string" || !STORAGE_KEY_PATTERN.test(entry.sha256)
        || !Number.isSafeInteger(entry.byteSize) || entry.byteSize < 1 || entry.byteSize > MAX_MEDIA_BYTES
        || !ALLOWED_IMAGE_MIMES.includes(entry.mime) || proofs.has(entry.path)) throw new Error();
      proofs.set(entry.path, { path: entry.path, sha256: entry.sha256, byteSize: entry.byteSize, mime: entry.mime });
    }
    return proofs;
  } catch {
    throw new ConfigurationError("Legacy image CDN manifest is invalid");
  }
}

export function loadLegacyImageCdnManifest(env: NodeJS.ProcessEnv, workingDirectory: string): Map<string, LegacyImageProof> | undefined {
  const mode = env.OSS_ACCOUNT_LEGACY_CDN?.trim();
  if (!mode || mode === "0") return;
  if (mode === "1" && env.OSS_ACCOUNT_IMAGE_CDN_MODE?.trim() === "drain") return;
  if (mode !== "1" || env.OSS_ACCOUNT_IMAGE_CDN_MODE?.trim() !== "serve") throw new ConfigurationError("Legacy image CDN requires serve mode and explicit enablement");
  const file = env.OSS_ACCOUNT_LEGACY_CDN_MANIFEST?.trim(), sha256 = env.OSS_ACCOUNT_LEGACY_CDN_MANIFEST_SHA256?.trim();
  if (!file || !sha256) throw new ConfigurationError("Legacy image CDN requires a manifest and SHA-256");
  let bytes: Buffer;
  try { bytes = readFileSync(resolve(workingDirectory, file)); }
  catch { throw new ConfigurationError("Legacy image CDN manifest could not be read"); }
  return parseLegacyImageCdnManifest(bytes, sha256);
}

export function createLegacyImageCdn(target: AccountImageCdnTarget, options: OssMediaStorageOptions, storage: Pick<OSS, "copy" | "getStream" | "delete">,
  refresh: (urls: string[]) => Promise<string>, proofs?: Map<string, LegacyImageProof>): LegacyImageCdn {
  const objectKey = ({ id, sourcePath }: LegacyImageCdnDelivery) => {
    if (!/^cdn_[a-f0-9]{32}$/.test(id) || !isLegacyImagePath(sourcePath)) throw new MediaStorageError("Legacy CDN object key is invalid");
    return `${options.objectPrefix}public/legacy/${id}/${sourcePath}`;
  };
  const url = (delivery: LegacyImageCdnDelivery) => `${target.origin}/${objectKey(delivery).split("/").map(encodeURIComponent).join("/")}`;
  const matches = ({ bytes, contentType }: { bytes: Buffer; contentType?: string }, proof: LegacyImageProof) =>
    contentType === proof.mime && bytes.length === proof.byteSize && createHash("sha256").update(bytes).digest("hex") === proof.sha256;
  return {
    enabled: target.mode === "serve" && proofs !== undefined,
    proof: path => proofs?.get(path),
    async inspectSource(proof) {
      try {
        const result = await readBoundedObject(storage, legacyImageObjectKey(options.objectPrefix, proof.path), proof.byteSize);
        if (!matches(result, proof) || (await inspectPublicAccountImage(result.bytes)).mime !== proof.mime) return "UNAVAILABLE";
        return "READY";
      } catch (error) {
        const failure = error as { code?: unknown; status?: unknown } | null;
        return failure?.code === "NoSuchKey" && (failure.status === undefined || failure.status === 404) ? "PENDING_IMPORT" : "UNAVAILABLE";
      }
    },
    async publish(delivery, proof) {
      if (target.mode !== "serve" || proofs?.get(delivery.sourcePath) !== proof) throw new MediaStorageError("Legacy CDN source is unapproved");
      const key = objectKey(delivery);
      try {
        await storage.copy(key, legacyImageObjectKey(options.objectPrefix, proof.path), options.bucket,
          { headers: { "content-type": proof.mime, "cache-control": "public, max-age=0, s-maxage=300, must-revalidate" } });
        if (!matches(await readBoundedObject(storage, key, proof.byteSize), proof)) throw new Error();
      } catch { throw new MediaStorageError("Legacy CDN origin object could not be published and verified"); }
    },
    async revoke(delivery) {
      try {
        await storage.delete(objectKey(delivery)).catch(error => { if ((error as { code?: unknown } | null)?.code !== "NoSuchKey") throw error; });
        return await refresh([url(delivery)]);
      } catch { throw new MediaStorageError("Legacy CDN object removal or refresh failed"); }
    },
    url,
  };
}
