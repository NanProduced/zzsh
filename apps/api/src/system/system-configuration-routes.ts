import type { INestApplication } from "@nestjs/common";
import type { PoolClient } from "pg";
import { createHash } from "node:crypto";

import { assertAdminContextInTransaction, readAdminContext } from "../auth/auth-security";
import { withTransaction } from "../auth/security-core";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { ALLOWED_IMAGE_MIMES, MAX_MEDIA_BYTES } from "../supply/media";
import { requireAdminAccess, runIdempotentWrite, safely, type SupplyResponse, type SupplyRuntimeOptions } from "../supply/supply-routes";
import { bodyOf, ensureOnlyFields, forbidden, headerValue, invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { readSettlementRefundPolicy, updateSettlementRefundPolicy, validateSettlementRefundPolicy, type SettlementRefundPolicyInput } from "../order/settlement-refund-policy";
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
    const sms = /^\/api\/(?:v1\/admin|bff\/admin)\/system\/sms$/.test(url.pathname);
    if (!(request.method === "GET" && /^\/api\/(?:v1\/admin|bff\/admin)\/system\/storage(?:\/check)?$/.test(url.pathname))
      && !(request.method === "GET" && sms)
      && !(policy && (request.method === "GET" || request.method === "PUT"))) throw notFound();
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
