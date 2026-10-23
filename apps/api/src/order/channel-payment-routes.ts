import type { INestApplication } from "@nestjs/common";
import { randomUUID } from "node:crypto";
import type { AuthSecurityOptions } from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { SecurityApiError, withTransaction } from "../auth/security-core";
import { ensureApiV1RequestId, validateIdempotencyKey } from "../contracts/api-v1";
import { bodyOf, ensureOnlyFields, forbidden, invalid, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { safely, type SupplyResponse } from "../supply/supply-routes";
import { assertReplayAuthorization } from "./order";
import { readChannelPaymentRequest, type ChannelPaymentReadOptions } from "./channel-payment-read";
import { createPaymentRequest, type PaymentRequestView } from "./channel-payment-store";
import { createJoinpayCollectionRequestInTransaction, executeJoinpayCollectionAttempt,
  type JoinpayCollectionRequestInput, type JoinpayCollectionExecution } from "./joinpay-collection-attempt";

export type ChannelPaymentCollectionAssembly = {
  initial?: Pick<JoinpayCollectionRequestInput, "profile" | "wire" | "admission">;
  execution?: Omit<JoinpayCollectionExecution, "pool">;
  /** Trusted local metadata may remain available after new collection is disabled. */
  read?: Omit<ChannelPaymentReadOptions, "formalWriteRouteReady">;
};

/** Composition-only metadata; no key, profile resolver, environment or network reads. */
export function channelPaymentReadOptions(collection?: ChannelPaymentCollectionAssembly, notificationRouteReady = false): ChannelPaymentReadOptions {
  const initial = collection?.initial;
  return { ...collection?.read, formalAdmission: initial?.admission ?? collection?.read?.formalAdmission,
    formalWriteRouteReady: Boolean(initial?.profile && initial.wire && initial.admission && collection?.execution?.formal
      && collection.execution.formal.admission === initial.admission && notificationRouteReady) };
}

const PREFIXES = ["/api/v1/orders", "/api/bff/user/orders"] as const;
const PATH = /^\/([A-Za-z0-9._:-]+)\/(channel-payment-requests|payment-requests)$/;

/** 只投影存下的回执，不重新读取当前状态或改写同键重放结果。 */
export function channelPaymentCommandReceipt(request: PaymentRequestView) {
  if (!request.createdAt || !request.updatedAt || !["SYNTHETIC_PROTOCOL", "CONTROLLED_TEST", "JOINPAY_CANDIDATE"].includes(request.evidenceLevel)) {
    throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Original payment receipt metadata is unavailable; read the original request");
  }
  return { contractVersion: "order-payment-request.v1", replay: request.existing,
    request: { id: request.requestId, orderId: request.orderId, state: request.state, method: request.method,
      amount: { cents: request.amountCents, currency: request.currency }, createdAt: request.createdAt, updatedAt: request.updatedAt },
    paymentAction: null, payment: null, dataOrigin: request.evidenceLevel === "CONTROLLED_TEST" ? "LOCAL_CONTROLLED"
      : request.evidenceLevel === "JOINPAY_CANDIDATE" ? "JOINPAY_CANDIDATE" : "SYNTHETIC_PROTOCOL" };
}

/** 独立 JOINPAY 用户入口；不接商户钥/网络/命令权限。默认能力关闭，只读原请求和重放已有回执。 */
export async function handleChannelPaymentRoute(request: SupplyNodeRequest, response: SupplyResponse, security: AuthSecurityOptions,
  prefix: typeof PREFIXES[number], collection?: ChannelPaymentCollectionAssembly, readOptions?: ChannelPaymentReadOptions): Promise<boolean> {
  const raw = request.originalUrl ?? request.url ?? "/", question = raw.indexOf("?");
  const fullPath = question < 0 ? raw : raw.slice(0, question);
  const path = fullPath.startsWith(prefix + "/") ? fullPath.slice(prefix.length) : fullPath;
  const match = PATH.exec(path);
  if (!match) return false;
  const requestId = ensureApiV1RequestId(request), method = (request.method ?? "GET").toUpperCase();
  response.setHeader("X-Request-Id", requestId);
  await safely(response, requestId, async () => {
    if ((question >= 0 && new URLSearchParams(raw.slice(question + 1)).size) || (method !== "GET" && method !== "POST")) throw notFound();
    if (match[1]!.length > 128) throw notFound();
    if (request.headers.authorization || request.headers.origin !== security.userOrigin) throw forbidden();
    const actor = await readUserContext(request, security), orderId = match[1]!, channel = match[2] === "channel-payment-requests";
    if (!channel) {
      const legacy = await withTransaction(security.pool, async client => {
        await assertReplayAuthorization(client, actor);
        const order = (await client.query(`SELECT id,display_no,status,
            to_char(paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS paid_at
            FROM zzsh_order.rental_order WHERE id=$1 AND renter_user_id=$2`, [orderId, actor.userId])).rows[0];
        if (!order) throw notFound();
        if (method === "POST") return null;
        const payment = (await client.query(`SELECT id AS "confirmationId",disposition,reason_code AS "reasonCode",
            amount_cents::text AS "amountCents",currency,to_char(accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "acceptedAt"
            FROM zzsh_order.payment_confirmation WHERE order_id=$1 AND disposition IN ('APPLIED','REVIEW_REQUIRED')
            ORDER BY (disposition='APPLIED') DESC,accepted_at DESC,id DESC LIMIT 1`, [orderId])).rows[0] ?? null;
        return { order: { id: order.id, displayNo: order.display_no, status: order.status, paidAt: order.paid_at }, payment };
      });
      if (method === "POST") sendJson(response, 409, { error: { code: "PAYMENT_CLIENT_UPGRADE_REQUIRED", message: "Use the channel payment request endpoint", requestId } }, requestId);
      else sendJson(response, 200, legacy, requestId);
      return;
    }
    if (method === "GET") {
      const data = await withTransaction(security.pool, async client => {
        await assertReplayAuthorization(client, actor);
        return readChannelPaymentRequest(client, { orderId, origin: "NATIVE", actor }, readOptions ?? channelPaymentReadOptions(collection));
      });
      if (!data.available) throw new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Payment request schema is not deployed");
      sendJson(response, 200, data.view, requestId);
      return;
    }
    const key = validateIdempotencyKey(request.headers["idempotency-key"]);
    const body = bodyOf(request);
    ensureOnlyFields(body, ["method"]);
    if (body.method !== "ALIPAY_NATIVE" && body.method !== "WEIXIN_NATIVE") throw invalid("Unsupported payment method", "method");
    try {
      const data = await withTransaction(security.pool, async client => {
        await assertReplayAuthorization(client, actor);
        const readiness = (await readChannelPaymentRequest(client, { orderId, origin: "NATIVE", actor })).available;
        if (!readiness) return null;
        const prior = (await client.query("SELECT evidence_level FROM zzsh_order.payment_request WHERE order_id=$1", [orderId])).rows[0];
        if (prior?.evidence_level === "JOINPAY_CANDIDATE" || (!prior && collection?.initial)) {
          // Original-key recovery must not consult today's configuration or payment eligibility.
          const initial = prior ? {} : collection?.initial ?? {};
          const original = await createJoinpayCollectionRequestInTransaction(client, { actor, orderId, idempotencyKey: key,
            method: body.method as "ALIPAY_NATIVE" | "WEIXIN_NATIVE", ...initial });
          return { status: original.status, body: channelPaymentCommandReceipt(original.request),
            collectionStart: !original.replayed && !original.request.existing ? original.request.requestId : null };
        }
        const result = await createPaymentRequest(client, { actor, orderId, idempotencyKey: key, method: body.method as string });
        return { status: result.status, body: channelPaymentCommandReceipt(result.body as PaymentRequestView), collectionStart: null };
      });
      if (data?.collectionStart && collection?.execution) {
        try {
          await executeJoinpayCollectionAttempt({ ...collection.execution, pool: security.pool }, {
            requestId: data.collectionStart, workerId: `payhttp_${randomUUID().replaceAll("-", "")}`,
          });
        } catch (error) {
          // Creation committed; a transport-unknown result only permits original-number recovery.
          if (!(error && typeof error === "object" && "code" in error && error.code === "PAYMENT_EXECUTION_UNKNOWN")) throw error;
        }
      }
      if (!data) sendJson(response, 503, { error: { code: "PAYMENT_CHANNEL_NOT_ENABLED", message: "Payment channel is not enabled", requestId } }, requestId);
      else sendJson(response, data.status, data.body, requestId);
    } catch (error) {
      const reason = error instanceof SecurityApiError && "paymentReason" in error ? error.paymentReason : null;
      if (reason === "PAYMENT_CHANNEL_NOT_ENABLED" || reason === "PAYMENT_REQUEST_EXISTS" || reason === "ORDER_NOT_PAYABLE") {
        sendJson(response, error instanceof SecurityApiError ? error.status : 500, { error: { code: reason, message: (error as Error).message, requestId } }, requestId);
      } else throw error;
    }
  });
  return true;
}

/** 与 mountLocalControlledPayments 互斥，由共享装配选择其一；本模块不自行挂接服务。 */
export function mountChannelPayments(app: INestApplication, security: AuthSecurityOptions,
  collection?: ChannelPaymentCollectionAssembly, readOptions?: ChannelPaymentReadOptions): void {
  for (const prefix of PREFIXES) app.getHttpAdapter().getInstance().use(prefix,
    (request: SupplyNodeRequest, response: SupplyResponse, next: () => void) => handleChannelPaymentRoute(request, response, security, prefix, collection, readOptions).then(handled => { if (!handled) next(); }));
}
