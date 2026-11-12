import type { INestApplication } from "@nestjs/common";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";

import { assertAdminContextInTransaction, readAdminContext } from "../auth/auth-security";
import { withTransaction } from "../auth/security-core";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { ALLOWED_IMAGE_MIMES, loadMediaAsset, MAX_MEDIA_BYTES } from "../supply/media";
import { isAccountDisplayPubliclyEligible } from "../supply/listing-query";
import { parseAccountWatermarkSettings, parseAccountWatermarkUpdate, readAccountWatermarkPolicy, resolveAccountImageWatermark, updateAccountWatermarkPolicy } from "../supply/account-image-watermark";
import { requireAdminAccess, runIdempotentWrite, safely, type SupplyResponse, type SupplyRuntimeOptions } from "../supply/supply-routes";
import { bodyOf, conflict, ensureOnlyFields, forbidden, headerValue, invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { readSettlementRefundPolicy, updateSettlementRefundPolicy, validateSettlementRefundPolicy, type SettlementRefundPolicyInput } from "../order/settlement-refund-policy";
import {
  readOpeningAutoConfirmPolicy, updateOpeningAutoConfirmPolicy, validateOpeningAutoConfirmPolicy,
  type OpeningAutoConfirmPolicyInput,
} from "../order/opening-auto-confirm-policy";
import { SMS_ADDITIONAL_SCENES, SMS_CONFIGURATION_V1_SCENES, type SmsTemplateScene } from "../auth/sms-templates";

type StorageCheck = {
  state: "NOT_RUN" | "NO_PUBLIC_SAMPLE" | "PASS" | "FAILED";
  checkedAt: string | null;
  scope: "PUBLIC_CONTENT_DERIVATIVE";
  integrity: "NOT_RUN" | "PASS" | "FAILED";
};

export async function handleSystemConfiguration(
  request: SupplyNodeRequest,
  response: SupplyResponse,
  options: SupplyRuntimeOptions,
): Promise<void> {
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("Cache-Control", "no-store");
  await safely(response, requestId, async () => {
    const url = new URL(request.originalUrl ?? request.url ?? "", options.apiOrigin);
    const policy = /^\/api\/(?:v1\/admin|bff\/admin)\/system\/settlement-refund-policy$/.test(url.pathname);
    const openingPolicy = /^\/api\/(?:v1\/admin|bff\/admin)\/system\/opening-auto-confirm$/.test(url.pathname);
    const sms = /^\/api\/(?:v1\/admin|bff\/admin)\/system\/sms$/.test(url.pathname);
    const watermark = /^\/api\/(?:v1\/admin|bff\/admin)\/system\/account-image-watermark$/.test(url.pathname);
    const watermarkPreview = request.method === "POST" && /^\/api\/(?:v1\/admin|bff\/admin)\/system\/account-image-watermark\/preview$/.test(url.pathname);
    if (!(request.method === "GET" && /^\/api\/(?:v1\/admin|bff\/admin)\/system\/storage(?:\/check)?$/.test(url.pathname))
      && !(request.method === "GET" && sms)
      && !(watermark && (request.method === "GET" || request.method === "PUT")) && !watermarkPreview
      && !(policy && (request.method === "GET" || request.method === "PUT"))
      && !(openingPolicy && (request.method === "GET" || request.method === "PUT"))) throw notFound();
    if (url.searchParams.size) throw invalid("System configuration does not accept query parameters");
    const origin = headerValue(request.headers.origin);
    if (request.method !== "GET" && origin === undefined
      || origin !== undefined && origin !== options.adminOrigin && origin !== options.apiOrigin
      || headerValue(request.headers["sec-fetch-site"]) === "cross-site") throw forbidden();

    const context = await readAdminContext(request, options);
    const authorize = async (client: PoolClient) => {
      await assertAdminContextInTransaction(client, context);
      if (!(await requireAdminAccess(client, context.userId)).isBoss) throw forbidden();
    };
    const accountMedia = options.mediaStorage.accountMedia;
    if (watermarkPreview) {
      const body = bodyOf(request);
      ensureOnlyFields(body, ["assetId", "enabled", "logoAssetId", "position", "sizePercent", "opacityPercent", "marginPercent"]);
      if (typeof body.assetId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(body.assetId)) throw invalid("样本图片编号无效", "assetId");
      const sampleId = body.assetId;
      const settings = parseAccountWatermarkSettings(body);
      const sample = await withTransaction(options.pool, async client => {
        await authorize(client);
        if (!accountMedia) throw conflict("OSS 图片处理尚未启用");
        const asset = await loadMediaAsset(client, sampleId);
        if (!asset || !asset.accountId || asset.ownershipKind !== "USER_SUPPLY" || !asset.publicStorageKey || !isAccountDisplayPubliclyEligible(asset)) throw notFound();
        const policy = await resolveAccountImageWatermark(client, { ...settings, revision: "1" });
        return { asset, storageKey: asset.publicStorageKey, policy, accountMedia };
      });
      const images = await sample.accountMedia.previewVariants(sample.storageKey, sample.asset, sample.policy);
      await withTransaction(options.pool, authorize);
      sendJson(response, 200, { images }, requestId);
      return;
    }
    if (watermark) {
      if (request.method === "GET") {
        const policy = await withTransaction(options.pool, async client => { await authorize(client); return readAccountWatermarkPolicy(client); });
        sendJson(response, 200, { policy, previewAvailable: Boolean(accountMedia) }, requestId);
        return;
      }
      const input = parseAccountWatermarkUpdate(bodyOf(request));
      await runIdempotentWrite(options, request, response, requestId,
        { principalId: context.userId, operation: "supply.account_image_watermark.update", resourceId: "global" },
        { realm: "admin", id: context.userId, sessionId: context.sessionId }, input, authorize,
        async client => ({ status: 200, body: { policy: await updateAccountWatermarkPolicy(client, { id: context.userId, sessionId: context.sessionId }, input, requestId) } }));
      return;
    }
    if(sms){
      await withTransaction(options.pool,authorize);
      const config=options.userSmsConfiguration;
      const describe=(scene:SmsTemplateScene)=>({scene,...(config?.scenes[scene]??{templateCode:null,source:"NOT_CONFIGURED"}),
        trigger:scene==="RENTAL_EXPIRY"||scene==="OWNER_ORDER_PAID"?"NOT_CONNECTED":"CONNECTED"});
      sendJson(response,200,{provider:config?"aliyun":"disabled",configurationSource:"DEPLOYMENT_ENVIRONMENT",
        signName:config?.signName??null,scenes:SMS_CONFIGURATION_V1_SCENES.map(describe),additionalScenes:SMS_ADDITIONAL_SCENES.map(describe),
        providerVerification:"NOT_RUN"},requestId);
      return;
    }
    if (policy) {
      if (request.method === "GET") {
        const data = await withTransaction(options.pool, async client => { await authorize(client); return readSettlementRefundPolicy(client); });
        sendJson(response, 200, data, requestId);
        return;
      }
      const body = bodyOf(request);
      ensureOnlyFields(body, ["normalDays", "earlyDays", "expectedRevision"]);
      const input = body as SettlementRefundPolicyInput;
      validateSettlementRefundPolicy(input);
      await runIdempotentWrite(options, request, response, requestId,
        { principalId: context.userId, operation: "order.settlement.refund_policy.update", resourceId: "global" },
        { realm: "admin", id: context.userId, sessionId: context.sessionId }, input,
        async client => authorize(client),
        async client => ({ status: 200, body: await updateSettlementRefundPolicy(client, { id: context.userId, sessionId: context.sessionId }, input, requestId) }));
      return;
    }
    if (openingPolicy) {
      if (request.method === "GET") {
        const data = await withTransaction(options.pool, async client => { await authorize(client); return readOpeningAutoConfirmPolicy(client); });
        sendJson(response, 200, data, requestId);
        return;
      }
      const body = bodyOf(request);
      ensureOnlyFields(body, ["waitMinutes", "expectedRevision"]);
      const input = body as OpeningAutoConfirmPolicyInput;
      validateOpeningAutoConfirmPolicy(input);
      await runIdempotentWrite(options, request, response, requestId,
        { principalId: context.userId, operation: "order.opening.auto_confirm.policy.update", resourceId: "global" },
        { realm: "admin", id: context.userId, sessionId: context.sessionId }, input,
        async client => authorize(client),
        async client => ({ status: 200, body: await updateOpeningAutoConfirmPolicy(client, { id: context.userId, sessionId: context.sessionId }, input, requestId) }));
      return;
    }
    const checking = url.pathname.endsWith("/check");
    const sample = await withTransaction(options.pool, async client => {
      await authorize(client);
      if (!checking) return null;
      return (await client.query<{ publicStorageKey: string }>(
        `SELECT "public_storage_key" AS "publicStorageKey" FROM "zzsh_supply"."media_asset"
          WHERE "purpose" = 'CONTENT_MEDIA' AND "ownership_kind" = 'PLATFORM_CONTENT' AND "review_state" = 'APPROVED'
            AND "access_class" = 'PUBLIC_DISPLAY' AND "public_storage_key" IS NOT NULL ORDER BY "id" LIMIT 1`,
      )).rows[0] ?? null;
    });
    const check: StorageCheck = { state: checking ? "NO_PUBLIC_SAMPLE" : "NOT_RUN", checkedAt: null, scope: "PUBLIC_CONTENT_DERIVATIVE", integrity: "NOT_RUN" };
    if (sample) {
      try {
        const bytes = await options.mediaStorage.read(sample.publicStorageKey);
        check.integrity = createHash("sha256").update(bytes).digest("hex") === sample.publicStorageKey ? "PASS" : "FAILED";
        check.state = check.integrity === "PASS" ? "PASS" : "FAILED";
      } catch { check.state = "FAILED"; }
      // Storage I/O must not hold a DB transaction or return configuration after access was revoked.
      await withTransaction(options.pool, authorize);
    }
    if (checking) check.checkedAt = new Date().toISOString();
    const storage = options.mediaStorage;
    const configuration = storage.configuration;
    sendJson(response, 200, {
      backend: storage.kind, configured: storage.available, configurationSource: "DEPLOYMENT_ENVIRONMENT",
      target: configuration ? { bucket: configuration.target.bucket, region: configuration.target.region, endpoint: configuration.target.endpoint, objectPrefix: configuration.target.objectPrefix } : null,
      credentialMode: configuration?.credentialMode ?? "NOT_APPLICABLE",
      automaticCredentialRefresh: configuration?.automaticCredentialRefresh ?? null,
      limits: { maxBytes: MAX_MEDIA_BYTES, allowedMimes: [...ALLOWED_IMAGE_MIMES] }, check,
    }, requestId);
  });
}

export function mountSystemConfigurationHandlers(app: INestApplication, options: SupplyRuntimeOptions): void {
  app.getHttpAdapter().getInstance().use("/api/v1/admin/system", (request: SupplyNodeRequest, response: SupplyResponse) => handleSystemConfiguration(request, response, options));
}
