import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { readAdminContext, type AuthSecurityOptions } from "../auth/auth-security";
import { ensureApiV1RequestId, validateIdempotencyKey } from "../contracts/api-v1";
import { bodyOf, ensureOnlyFields, invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { requireOrigin, requestPath, safely, type SupplyResponse } from "../supply/supply-routes";
import { readAdminNativeRefunds, requestAdminNativeRefund, type AdminNativeRefundExecution } from "./native-refund-command";

const PREFIXES = ["/api/v1/admin/orders", "/api/bff/admin/orders"] as const;
const PATH = /^\/([A-Za-z0-9._:-]+)\/refunds$/;
export type AdminNativeRefundOptions = Readonly<{ pool: Pool; refund?: AdminNativeRefundExecution }>;

/** Admin退款业务入口；只创建原责任上的正式意图，不在此出网、不伪造渠道终态。 */
export async function handleAdminNativeRefundRoute(request: SupplyNodeRequest, response: SupplyResponse,
  security: AuthSecurityOptions, prefix: typeof PREFIXES[number], options: AdminNativeRefundOptions): Promise<boolean> {
  const { path } = requestPath(request, prefix);
  const match = PATH.exec(path);
  if (!match) return false;
  const requestId = ensureApiV1RequestId(request), method = (request.method ?? "GET").toUpperCase();
  response.setHeader("X-Request-Id", requestId);
  await safely(response, requestId, async () => {
    if (method !== "GET" && method !== "POST") throw notFound();
    if (method === "POST") { if (!requireOrigin(request, response, security, requestId)) return; }
    const context = await readAdminContext(request, security), orderId = match[1]!;
    if (method === "GET") {
      sendJson(response, 200, await readAdminNativeRefunds(security.pool, { actor: context, orderId }), requestId);
      return;
    }
    const refund = options.refund ?? {};
    const body = bodyOf(request);
    ensureOnlyFields(body, ["amountCents", "reason", "postingId"]);
    if (typeof body.amountCents !== "string") throw invalid("amountCents is required", "amountCents");
    if (body.reason !== undefined && typeof body.reason !== "string") throw invalid("reason is invalid", "reason");
    if (body.postingId !== undefined && typeof body.postingId !== "string") throw invalid("postingId is invalid", "postingId");
    const result = await requestAdminNativeRefund(security.pool, refund, {
      actor: context, orderId, amountCents: body.amountCents,
      ...(body.reason === undefined ? {} : { reason: body.reason }),
      ...(body.postingId === undefined ? {} : { postingId: body.postingId }),
      idempotencyKey: validateIdempotencyKey(request.headers["idempotency-key"]), requestId });
    sendJson(response, 200, result, requestId);
  });
  return true;
}

/** 仅共享装配显式挂载；不读取环境、不启动worker。 */
export function mountAdminNativeRefunds(app: INestApplication, security: AuthSecurityOptions, options: AdminNativeRefundOptions): void {
  for (const prefix of PREFIXES) app.getHttpAdapter().getInstance().use(prefix,
    (request: SupplyNodeRequest, response: SupplyResponse, next: () => void) =>
      handleAdminNativeRefundRoute(request, response, security, prefix, options).then(handled => { if (!handled) next(); }));
}
