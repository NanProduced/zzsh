import type { AuthSecurityOptions } from "../auth/auth-security";
import { readAdminContext } from "../auth/auth-security";
import { SecurityApiError, withTransaction } from "../auth/security-core";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { bodyOf, ensureOnlyFields, invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { requireOrigin, runIdempotentWrite, type SupplyResponse } from "../supply/supply-routes";
import { assertSupportOrderAccess } from "./manual-close";
import { assertSupportCancelInput,assertSupportPoststartCancelInput } from "./support-cancel-model";
import { readSupportCancellation, supportCancelAfterOpening,supportCancelOrder } from "./support-cancel";
import type { DemoFinanceResource } from "../finance/ecs-test-demo-resource";

const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

/** Admin客服取消入口；GET只读预检，POST沿用manual-close的客服/订单写权限与幂等恢复。 */
export async function handleSupportCancelAdminRoute(
  request: SupplyNodeRequest,
  response: SupplyResponse,
  options: AuthSecurityOptions & { ecsTestDemo?: DemoFinanceResource },
  orderId: string,
  query: URLSearchParams,
  method: string,
): Promise<boolean> {
  if (!ID.test(orderId)) throw notFound();
  if (query.size) throw invalid("Support cancellation does not accept query fields");
  const requestId = ensureApiV1RequestId(request);
  response.setHeader("X-Request-Id", requestId);
  if (method === "GET") {
    const context = await readAdminContext(request, options);
    const actor = { userId: context.userId, sessionId: context.sessionId, settlementAdmission: options.settlementAdmission, ecsTestDemo: options.ecsTestDemo };
    const body = await withTransaction(options.pool, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return readSupportCancellation(client, actor, orderId);
    });
    sendJson(response, 200, body, requestId);
    return true;
  }
  if (method !== "POST") throw notFound();
  if (!requireOrigin(request, response, options, requestId)) return true;
  const context = await readAdminContext(request, options);
  const actor = { userId: context.userId, sessionId: context.sessionId, settlementAdmission: options.settlementAdmission, ecsTestDemo: options.ecsTestDemo };
  const body = bodyOf(request);
  ensureOnlyFields(body, ["expectedOrderRevision", "reason","refundCents","ownerCents","expectedAdminId"]);
  const poststart=body.refundCents!==undefined||body.ownerCents!==undefined;
  if (poststart && (typeof body.expectedAdminId !== "string" || !ID.test(body.expectedAdminId))) throw invalid("Missing cancellation administrator");
  if (poststart && body.expectedAdminId !== actor.userId) throw new SecurityApiError(401,"UNAUTHENTICATED","Administrator identity changed");
  const frozen = poststart?{...assertSupportPoststartCancelInput(body),expectedAdminId:body.expectedAdminId}:assertSupportCancelInput(body);
  let actionCompleted = false;
  try {
    await runIdempotentWrite(options, request, response, requestId,
      { principalId: actor.userId, operation: poststart?"order.support_cancel_after_opening":"order.support_cancel", resourceId: orderId },
      { realm: "admin", id: actor.userId, sessionId: actor.sessionId }, frozen,
      async (client) => { await assertSupportOrderAccess(client, orderId, actor); },
      async (client) => {
        const result = poststart
          ?await supportCancelAfterOpening(client,actor,{orderId,...assertSupportPoststartCancelInput(frozen),requestId})
          :await supportCancelOrder(client,actor,{orderId,...assertSupportCancelInput(frozen),requestId});
        actionCompleted = true;
        return result;
      });
  } catch (error) {
    if (actionCompleted && !(error instanceof SecurityApiError && error.status < 500) && !response.headersSent) {
      sendJson(response, 202, { contractVersion: "admin-support-cancel.v1", orderId, outcome: "UNKNOWN",
        originalKeyRequired: true, channelResult: "NOT_SUBMITTED", bankArrival: "UNKNOWN" }, requestId);
      return true;
    }
    throw error;
  }
  return true;
}
