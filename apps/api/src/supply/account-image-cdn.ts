import type OSS from "ali-oss";
import OpenApi, { $OpenApiUtil } from "@alicloud/openapi-core";
import { RuntimeOptions } from "@darabonba/typescript";
import { createHash } from "node:crypto";

import { ConfigurationError } from "../config/config";
import { MAX_MEDIA_BYTES, MediaStorageError } from "./media";
import { readBoundedObject, type AccountMediaVariant } from "./account-media-oss";
import { ACCOUNT_IMAGE_VARIANT_EDGES, type AccountImageEdge } from "./account-image-watermark";
import type { OssCredentials, OssMediaStorageOptions } from "./media-oss";
import type { LegacyImageCdn } from "./legacy-image-cdn";

export type AccountImageCdnTarget = { mode: "serve" | "drain"; origin: string };
export type AccountImageDelivery = { id: string; accountId: string; assetId: string };
export type AccountImageCdn = {
  mode: AccountImageCdnTarget["mode"];
  legacy?: LegacyImageCdn;
  url: (delivery: AccountImageDelivery, edge: AccountImageEdge) => string;
  publish: (delivery: AccountImageDelivery, variant: AccountMediaVariant) => Promise<void>;
  revoke: (delivery: AccountImageDelivery) => Promise<string>;
};

export function loadAccountImageCdnTarget(env: NodeJS.ProcessEnv): AccountImageCdnTarget | undefined {
  const mode = env.OSS_ACCOUNT_IMAGE_CDN_MODE?.trim();
  if (!mode || mode === "off") return;
  if (mode !== "serve" && mode !== "drain") throw new ConfigurationError("OSS_ACCOUNT_IMAGE_CDN_MODE must be off, serve, or drain");
  const value = env.OSS_ACCOUNT_IMAGE_CDN_ORIGIN?.trim() ?? "";
  if (!/^https:\/\/(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}\/?$/i.test(value)) {
    throw new ConfigurationError("OSS_ACCOUNT_IMAGE_CDN_ORIGIN must be a dedicated https CDN domain");
  }
  return { mode, origin: new URL(value).origin };
}

function objectKey(delivery: AccountImageDelivery, edge: AccountImageEdge): string {
  const id = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  if (!/^cdn_[a-f0-9]{32}$/.test(delivery.id) || !id.test(delivery.accountId) || !id.test(delivery.assetId)) throw new MediaStorageError("account image delivery is invalid");
  return `public/listing/${delivery.accountId}/${delivery.assetId}/${delivery.id}/${edge}.webp`;
}

export function createAccountImageCdn(
  target: AccountImageCdnTarget,
  options: OssMediaStorageOptions,
  storage: Pick<OSS, "copy" | "delete" | "getStream">,
  refresh: (urls: string[]) => Promise<string>,
): AccountImageCdn {
  const url = (delivery: AccountImageDelivery, edge: AccountImageEdge) => {
    const key = options.objectPrefix + objectKey(delivery, edge);
    return `${target.origin}/${key.split("/").map(encodeURIComponent).join("/")}`;
  };
  return {
    mode: target.mode,
    url,
    async publish(delivery, variant) {
      if (target.mode !== "serve" || !/^private\/account-variants\/[a-f0-9]{32}\/(640|1920)\.webp$/.test(variant.objectKey)
        || !variant.objectKey.endsWith(`/${variant.maxEdge}.webp`) || variant.byteSize < 1 || variant.byteSize > MAX_MEDIA_BYTES) throw new MediaStorageError("account image variant is invalid");
      const key = options.objectPrefix + objectKey(delivery, variant.maxEdge);
      try {
        await storage.copy(key, options.objectPrefix + variant.objectKey, options.bucket,
          { headers: { "content-type": "image/webp", "cache-control": "public, max-age=0, s-maxage=300, must-revalidate" } });
        const { bytes, contentType } = await readBoundedObject(storage, key, variant.byteSize);
        if (contentType !== "image/webp" || bytes.length !== variant.byteSize || createHash("sha256").update(bytes).digest("hex") !== variant.sha256) {
          throw new MediaStorageError("CDN origin object verification failed");
        }
      } catch {
        throw new MediaStorageError("CDN origin object could not be published and verified");
      }
    },
    async revoke(delivery) {
      const removed = await Promise.allSettled(ACCOUNT_IMAGE_VARIANT_EDGES.map(async edge => {
        try { await storage.delete(options.objectPrefix + objectKey(delivery, edge)); }
        catch (error) { if ((error as { code?: unknown } | null)?.code !== "NoSuchKey") throw error; }
      }));
      if (removed.some(result => result.status === "rejected")) throw new MediaStorageError("CDN origin objects could not be removed");
      try { return await refresh(ACCOUNT_IMAGE_VARIANT_EDGES.map(edge => url(delivery, edge))); }
      catch { throw new MediaStorageError("CDN cache refresh was not accepted"); }
    },
  };
}

export function createAccountCdnRefresh(credentials: OssCredentials): (urls: string[]) => Promise<string> {
  const client = new OpenApi(new $OpenApiUtil.Config({ accessKeyId: credentials.accessKeyId, accessKeySecret: credentials.accessKeySecret,
    securityToken: credentials.stsToken, type: credentials.stsToken ? "sts" : "access_key", endpoint: "cdn.aliyuncs.com", protocol: "https" }));
  const params = new $OpenApiUtil.Params({ action: "RefreshObjectCaches", version: "2018-05-10", protocol: "HTTPS", pathname: "/",
    method: "POST", authType: "AK", style: "RPC", reqBodyType: "formData", bodyType: "json" });
  return async urls => {
    const result = await client.callApi(params, new $OpenApiUtil.OpenApiRequest({ body: { ObjectType: "File", ObjectPath: urls.join("\n") } }),
      new RuntimeOptions({ autoretry: false, maxAttempts: 1, connectTimeout: 3000, readTimeout: 8000 }));
    const task = (result.body as { RefreshTaskId?: unknown } | undefined)?.RefreshTaskId;
    if (typeof task !== "string" || !/^[0-9,]{1,256}$/.test(task)) throw new MediaStorageError("CDN cache refresh task is invalid");
    return task;
  };
}
