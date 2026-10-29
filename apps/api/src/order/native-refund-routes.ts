import type { INestApplication } from "@nestjs/common";
import type { Pool } from "pg";
import { readAdminContext, type AuthSecurityOptions } from "../auth/auth-security";
import { ensureApiV1RequestId, validateIdempotencyKey } from "../contracts/api-v1";
import { bodyOf, ensureOnlyFields, invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { requireOrigin, requestPath, safely, type SupplyResponse } from "../supply/supply-routes";
import { readAdminNativeRefunds, requestAdminNativeRefund,requestAdminAbnormalNativeRefund,requestAdminPrestartNativeRefund, type AdminNativeRefundExecution } from "./native-refund-command";

const PREFIXES = ["/api/v1/admin/orders", "/api/bff/admin/orders"] as const;
const PATH = /^\/([A-Za-z0-9._:-]+)\/refunds$/;
const ABNORMAL=/^\/([A-Za-z0-9._:-]+)\/refunds\/abnormal$/;
const PRESTART=/^\/([A-Za-z0-9._:-]+)\/prestart-termination\/([A-Za-z0-9._:-]+)\/refund-requests$/;
export type AdminNativeRefundOptions = Readonly<{ pool: Pool; refund?: AdminNativeRefundExecution }>;

/** Admin退款业务入口；只创建原责任上的正式意图，不在此出网、不伪造渠道终态。 */
export async function handleAdminNativeRefundRoute(request: SupplyNodeRequest, response: SupplyResponse,
  security: AuthSecurityOptions, prefix: typeof PREFIXES[number], options: AdminNativeRefundOptions): Promise<boolean> {
  const { path,query } = requestPath(request, prefix);
  const abnormal=ABNORMAL.exec(path),prestart=PRESTART.exec(path),match = PATH.exec(path)??abnormal??prestart;
  if (!match) return false;
  const requestId = ensureApiV1RequestId(request), method = (request.method ?? "GET").toUpperCase();
  response.setHeader("X-Request-Id", requestId);
  await safely(response, requestId, async () => {
    if(abnormal||prestart){
      if(method!=='POST')throw notFound();if(query.size)throw invalid('Original refund accepts no query fields');
      if(!requireOrigin(request,response,security,requestId))return;
      const actor=await readAdminContext(request,security),body=bodyOf(request),orderId=match[1]!,idempotencyKey=validateIdempotencyKey(request.headers['idempotency-key']);
      if(abnormal){ensureOnlyFields(body,['confirmationId','reason']);if(typeof body.confirmationId!=='string'||typeof body.reason!=='string'||body.reason.trim().length<3)throw invalid();
        sendJson(response,200,await requestAdminAbnormalNativeRefund(security.pool,options.refund??{},{actor,orderId,confirmationId:body.confirmationId,reason:body.reason,idempotencyKey,requestId}),requestId);
      }else{ensureOnlyFields(body,[]);sendJson(response,200,await requestAdminPrestartNativeRefund(security.pool,options.refund??{},{actor,orderId,terminationId:prestart![2]!,idempotencyKey,requestId}),requestId);}
      return;
    }
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
