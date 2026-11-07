import type { AuthSecurityOptions } from "../auth/auth-security";
import { readAdminContext } from "../auth/auth-security";
import { SecurityApiError, withTransaction } from "../auth/security-core";
import { ensureApiV1RequestId } from "../contracts/api-v1";
import { bodyOf, ensureOnlyFields, invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { requireOrigin, runIdempotentWrite, type SupplyResponse } from "../supply/supply-routes";
import { assertSupportOrderAccess } from "./manual-close";
import { assertSupportCancelInput } from "./support-cancel-model";
import { readSupportUnpaidCancellation, supportCancelUnpaidOrder } from "./support-unpaid-cancel";

export async function handleSupportUnpaidCancelRoute(request: SupplyNodeRequest, response: SupplyResponse,
  options: AuthSecurityOptions, orderId: string, query: URLSearchParams, method: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(orderId)) throw notFound();
  if (query.size) throw invalid("Cancellation does not accept query fields");
  const requestId = ensureApiV1RequestId(request);
  if (method === "GET") {
    const actor = await readAdminContext(request, options);
    const body = await withTransaction(options.pool, async client => {
      await client.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return readSupportUnpaidCancellation(client, actor, orderId);
    });
    sendJson(response, 200, body, requestId);
    return;
  }
  if (method !== "POST") throw notFound();
  if (!requireOrigin(request, response, options, requestId)) return;
  const actor = await readAdminContext(request, options);
  const body = bodyOf(request);
  ensureOnlyFields(body, ["expectedOrderRevision", "reason"]);
  const frozen = assertSupportCancelInput(body);
  if (BigInt(frozen.expectedOrderRevision) >= 9223372036854775807n) throw invalid("Order revision is outside supported range", "expectedOrderRevision");
  let actionCompleted = false;
  try {
    await runIdempotentWrite(options, request, response, requestId,
      { principalId: actor.userId, operation: "order.support_cancel_unpaid", resourceId: orderId },
      { realm: "admin", id: actor.userId, sessionId: actor.sessionId }, frozen,
      client => assertSupportOrderAccess(client, orderId, actor),
      async client => { const result = await supportCancelUnpaidOrder(client, actor, { orderId, ...frozen, requestId }); actionCompleted = true; return result; });
  } catch (error) {
    if (actionCompleted && !(error instanceof SecurityApiError && error.status < 500) && !response.headersSent) {
      sendJson(response, 202, { contractVersion: "admin-support-unpaid-cancel.v1", orderId, outcome: "UNKNOWN", originalKeyRequired: true }, requestId);
      return;
    }
    throw error;
  }
}
