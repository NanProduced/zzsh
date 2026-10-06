import { createHash } from "node:crypto";
import type { INestApplication } from "@nestjs/common";
import type { AuthSecurityOptions } from "../auth/auth-security";
import { readUserContext } from "../auth/user-identity";
import { withTransaction } from "../auth/security-core";
import { ConfigurationError, type AppConfig } from "../config/config";
import { ensureApiV1RequestId, validateIdempotencyKey } from "../contracts/api-v1";
import { bodyOf, conflict, ensureOnlyFields, forbidden, headerValue, notFound, sendJson, type SupplyNodeRequest } from "../supply/supply-util";
import { safely, type SupplyResponse } from "../supply/supply-routes";
import { confirmOrderPayment, createControlledPaymentSource } from "./payment-confirmation";

/**
 * Explicit local test-only assembly seam. The page submits a payment request and the server,
 * never the client, produces the CONTROLLED local source. This module is mounted only when the
 * process passes an explicit option; no environment flag or HTTP input can install it.
 */
export type LocalControlledPaymentOptions = Readonly<{
  config: AppConfig;
  resourceSet: string;
  appId: string;
  merchantScopeId: string;
}>;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const PATHS = ["/api/v1/orders", "/api/bff/user/orders"] as const;

export function assertLocalControlledPaymentAssembly(options: LocalControlledPaymentOptions): void {
  const { config, resourceSet } = options;
  if (config.profile !== "test" || config.provider !== "fake" || !config.testOperationsEnabled
    || config.database.target !== "local-compose" || config.database.host !== "127.0.0.1" || config.database.port !== 55432
    || !/^[a-z][a-z0-9_]{0,20}$/.test(resourceSet)
    || config.database.name !== `zzsh_test_order_${resourceSet}` || config.database.user !== `zzsh_order_${resourceSet}_r`
    || !ID.test(options.appId) || !ID.test(options.merchantScopeId)) {
    throw new ConfigurationError("Local controlled payment requires an explicit isolated test/fake resource");
  }
}

/** Deterministic per accepted intent: the same key replays the same provider transaction. */
export function localPaymentTransactionId(userId: string, orderId: string, key: string): string {
  return `local_${createHash("sha256").update(JSON.stringify([userId, orderId, key])).digest("hex").slice(0, 48)}`;
}

export function mountLocalControlledPayments(app: INestApplication, security: AuthSecurityOptions, options: LocalControlledPaymentOptions): void {
  assertLocalControlledPaymentAssembly(options);
  const requestMatch = /^\/([A-Za-z0-9._:-]+)\/payment-requests$/;
  for (const prefix of PATHS) {
    app.getHttpAdapter().getInstance().use(prefix, (request: SupplyNodeRequest, response: SupplyResponse, next: () => void) => {
      const { path, query } = (() => {
        const raw = (request.originalUrl ?? request.url ?? "/").split("?", 2);
        const suffix = raw[0]!.startsWith(prefix) ? raw[0]!.slice(prefix.length) : raw[0]!;
        return { path: suffix || "/", query: new URLSearchParams(raw[1] ?? "") };
      })();
      const method = (request.method ?? "GET").toUpperCase();
      const match = requestMatch.exec(path);
      if (!match || (method !== "GET" && method !== "POST")) {
        next();
        return;
      }
      const requestId = ensureApiV1RequestId(request);
      response.setHeader("X-Request-Id", requestId);
      return safely(response, requestId, async () => {
        if (query.size) throw notFound();
        if (request.headers.authorization || request.headers.origin !== security.userOrigin) throw forbidden();
        const context = await readUserContext(request, security);
        const orderId = match[1]!;
        if (method === "GET") {
          const body = await withTransaction(security.pool, async (client) => {
            const order = await payerOrder(client, orderId, context.userId);
            const payment = (await client.query(
              `SELECT id AS "confirmationId", disposition, reason_code AS "reasonCode", amount_cents::text AS "amountCents", currency,
                      to_char(accepted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "acceptedAt"
                 FROM zzsh_order.payment_confirmation WHERE order_id=$1 ORDER BY accepted_at DESC, id DESC LIMIT 1`, [orderId],
            )).rows[0] ?? null;
            return { order: { id: order.id, displayNo: order.display_no, status: order.status, paidAt: order.paid_at }, payment };
          });
          sendJson(response, 200, body, requestId);
          return;
        }
        const body = bodyOf(request);
        ensureOnlyFields(body, []);
        const key = validateIdempotencyKey(headerValue(request.headers["idempotency-key"]));
        const source = createControlledPaymentSource({
          config: options.config, resourceSet: options.resourceSet, appId: options.appId,
          merchantScopeId: options.merchantScopeId, allowedOrderIds: [orderId],
        });
        const result = await withTransaction(security.pool, async (client) => {
          const order = await payerOrder(client, orderId, context.userId);
          const applied = (await client.query(
            `SELECT id, reason_code AS "reasonCode" FROM zzsh_order.payment_confirmation WHERE order_id=$1 AND disposition='APPLIED'`, [orderId],
          )).rows[0];
          if (applied) return { confirmationId: applied.id, disposition: "APPLIED", reasonCode: applied.reasonCode, replay: true };
          if (order.status !== "PENDING_PAYMENT") throw conflict("Order is not awaiting local payment");
          const total = (BigInt(order.rental_amount_cents) + BigInt(order.deposit_amount_cents)).toString();
          const payment = await confirmOrderPayment(client, source({
            orderId, merchantOrderNo: order.display_no, providerTransactionId: localPaymentTransactionId(context.userId, orderId, key),
            // Stable per order so a retried key replays the identical local declaration; the
            // authoritative acceptance time is still the database clock inside the gate.
            amountCents: total, currency: order.currency, providerPaidAt: order.created_at as string, requestId,
          }));
          return payment;
        });
        sendJson(response, 200, { payment: result }, requestId);
      });
    });
  }
}

async function payerOrder(client: import("pg").PoolClient, orderId: string, userId: string) {
  const order = (await client.query(
    `SELECT id, display_no, status, currency, renter_user_id, rental_amount_cents::text AS rental_amount_cents, deposit_amount_cents::text AS deposit_amount_cents,
            to_char(paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS paid_at,
            to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at
       FROM zzsh_order.rental_order WHERE id=$1`, [orderId],
  )).rows[0];
  if (!order || order.renter_user_id !== userId) throw notFound();
  return order;
}
