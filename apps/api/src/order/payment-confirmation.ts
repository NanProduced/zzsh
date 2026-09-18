import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

import { recordAudit } from "../auth/security-core";
import { ConfigurationError, type AppConfig } from "../config/config";
import { invalid, notFound } from "../supply/supply-util";
import { cancelExpiredReservation, lockOrderPartiesInOrder } from "./order";

export type PaymentInput = Readonly<{
  orderId: string;
  merchantOrderNo: string;
  providerTransactionId: string;
  amountCents: string;
  currency: string;
  providerPaidAt: string;
  requestId: string;
}>;
type VerifiedPaymentFact = PaymentInput & { readonly source: "CONTROLLED"; readonly merchantScopeId: string };
const verifiedFacts = new WeakMap<object, { appId: string; database: string; runtimeUser: string }>();
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const INPUT_KEYS = ["orderId", "merchantOrderNo", "providerTransactionId", "amountCents", "currency", "providerPaidAt", "requestId"];

/** Process-local capability only. No HTTP route or environment fallback installs it. */
export function createControlledPaymentSource(options: {
  config: AppConfig;
  resourceSet: string;
  appId: string;
  merchantScopeId: string;
  allowedOrderIds: readonly string[];
}): (input: PaymentInput) => VerifiedPaymentFact {
  const { config, resourceSet, appId, merchantScopeId } = options;
  if (config.profile !== "test" || config.provider !== "fake" || !config.testOperationsEnabled
    || config.database.target !== "local-compose" || config.database.host !== "127.0.0.1" || config.database.port !== 55432
    || !/^[a-z][a-z0-9_]{0,20}$/.test(resourceSet)
    || config.database.name !== `zzsh_test_order_${resourceSet}`
    || config.database.user !== `zzsh_order_${resourceSet}_r`
    || !ID.test(appId) || !ID.test(merchantScopeId) || !options.allowedOrderIds.length
    || options.allowedOrderIds.some((id) => !ID.test(id))) {
    throw new ConfigurationError("Controlled payment requires an explicit isolated test/fake resource and order allowlist");
  }
  const allowed = new Set(options.allowedOrderIds);
  const scope = Object.freeze({ appId, database: config.database.name, runtimeUser: config.database.user });
  return (input) => {
    if (!input || Object.keys(input).some((key) => !INPUT_KEYS.includes(key))
      || !allowed.has(input.orderId)
      || ![input.orderId, input.merchantOrderNo, input.providerTransactionId, input.requestId].every((value) => typeof value === "string" && ID.test(value))
      || typeof input.amountCents !== "string" || !/^(0|[1-9]\d{0,24})$/.test(input.amountCents)
      || typeof input.currency !== "string" || !/^[A-Z]{3}$/.test(input.currency)
      || typeof input.providerPaidAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(input.providerPaidAt)
      || !Number.isFinite(Date.parse(input.providerPaidAt)) || new Date(input.providerPaidAt).toISOString() !== input.providerPaidAt) {
      throw invalid("Invalid controlled payment fact");
    }
    const fact = Object.freeze({ ...input, source: "CONTROLLED" as const, merchantScopeId });
    verifiedFacts.set(fact, scope);
    return fact;
  };
}

/** Stable namespace reserved for OIM-2B's order/consultation dispatch gate. */
export function orderDispatchLockKey(appId: string): string {
  return BigInt(`0x${createHash("sha256").update(`zzsh:im-dispatch:v1:${appId}`).digest("hex").slice(0, 15)}`).toString();
}

export type PaymentResult = {
  confirmationId: string;
  disposition: "APPLIED" | "REVIEW_REQUIRED" | "CONFLICT";
  reasonCode: string | null;
  replay: boolean;
};

/** Caller owns one transaction; audit failure rolls back the entire acceptance. */
export async function confirmOrderPayment(client: PoolClient, fact: VerifiedPaymentFact): Promise<PaymentResult> {
  const scope = fact && verifiedFacts.get(fact);
  if (!scope) throw invalid("Payment fact is not verified");
  const identity = (await client.query(`SELECT current_database() AS db, current_user AS actor`)).rows[0];
  if (identity.db !== scope.database || identity.actor !== scope.runtimeUser) throw invalid("Payment resource mismatch");
  // No network inside this gate. 2B must also adapt old consultation close/recovery lock paths.
  await client.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [orderDispatchLockKey(scope.appId)]);
  // A provider transaction may be replayed against a different App/order. Serialize its binding too.
  const transactionKey = createHash("sha256").update(JSON.stringify([fact.source, fact.merchantScopeId, fact.providerTransactionId])).digest("hex");
  await client.query(`SELECT pg_advisory_xact_lock($1::bigint)`, [BigInt(`0x${transactionKey.slice(0, 15)}`).toString()]);
  const existing = (await client.query<{
    id: string; orderId: string; merchantOrderNo: string; amountCents: string; currency: string;
    providerPaidAt: string; disposition: "APPLIED" | "REVIEW_REQUIRED"; reasonCode: string | null;
  }>(`SELECT id, order_id AS "orderId", merchant_order_no AS "merchantOrderNo", amount_cents::text AS "amountCents",
      currency, to_char(provider_paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "providerPaidAt",
      disposition, reason_code AS "reasonCode" FROM zzsh_order.payment_confirmation
      WHERE source=$1 AND merchant_scope_id=$2 AND provider_transaction_id=$3`,
  [fact.source, fact.merchantScopeId, fact.providerTransactionId])).rows[0];
  if (existing) {
    const differences = (["orderId", "merchantOrderNo", "amountCents", "currency", "providerPaidAt"] as const)
      .filter((key) => existing[key] !== fact[key]);
    if (differences.length) {
      await recordAudit(client, {
        actorType: "system", action: "order.payment.conflict", objectType: "payment_confirmation", objectId: existing.id,
        outcome: "FAILURE", reason: "TRANSACTION_BINDING_CONFLICT", requestId: fact.requestId,
        details: { attempted: { orderId: fact.orderId, merchantOrderNo: fact.merchantOrderNo,
          amountCents: fact.amountCents, currency: fact.currency, providerPaidAt: fact.providerPaidAt },
          conflictingFields: differences, transactionFingerprint: transactionKey },
      });
      return { confirmationId: existing.id, disposition: "CONFLICT", reasonCode: "TRANSACTION_BINDING_CONFLICT", replay: false };
    }
    return { confirmationId: existing.id, disposition: existing.disposition, reasonCode: existing.reasonCode, replay: true };
  }

  const located = (await client.query(`SELECT account_id, renter_user_id, owner_user_id FROM zzsh_order.rental_order WHERE id=$1`, [fact.orderId])).rows[0];
  if (!located) throw notFound();
  await lockOrderPartiesInOrder(client, located.renter_user_id, located.owner_user_id);
  await client.query(`SELECT id FROM zzsh_supply.rental_account WHERE id=$1 FOR UPDATE`, [located.account_id]);
  const order = (await client.query(`SELECT status, display_no, currency,
      (rental_amount_cents+deposit_amount_cents)::text AS total,
      to_char(hold_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS hold
      FROM zzsh_order.rental_order WHERE id=$1 FOR UPDATE`, [fact.orderId])).rows[0];
  // Capture the decision clock AFTER waiting for row locks. Provider time never revives an expired hold.
  const timing = (await client.query(`SELECT to_char(t AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS accepted,
      t < $1::timestamptz AS open FROM (SELECT clock_timestamp() AS t) clock`, [order.hold])).rows[0];
  const mismatch = order.display_no !== fact.merchantOrderNo || order.currency !== fact.currency || order.total !== fact.amountCents;
  const reasonCode = mismatch ? "BINDING_MISMATCH" : order.status === "PAID" ? "DUPLICATE_PAYMENT"
    : order.status !== "PENDING_PAYMENT" || !timing.open ? "LATE_PAYMENT" : null;
  if (order.status === "PENDING_PAYMENT" && !timing.open) {
    await cancelExpiredReservation(client, fact.orderId, order.hold, fact.requestId);
  }
  const confirmationId = `payment_${randomUUID().replaceAll("-", "")}`;
  const disposition = reasonCode ? "REVIEW_REQUIRED" : "APPLIED";
  await client.query(`INSERT INTO zzsh_order.payment_confirmation
      (id,source,merchant_scope_id,provider_transaction_id,merchant_order_no,order_id,amount_cents,currency,
       provider_paid_at,accepted_at,disposition,reason_code,request_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
  [confirmationId, fact.source, fact.merchantScopeId, fact.providerTransactionId, fact.merchantOrderNo, fact.orderId,
    fact.amountCents, fact.currency, fact.providerPaidAt, timing.accepted, disposition, reasonCode, fact.requestId]);
  if (disposition === "APPLIED") {
    await client.query(`UPDATE zzsh_order.rental_order SET status='PAID', paid_confirmation_id=$2, paid_at=$3,
      revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`, [fact.orderId, confirmationId, timing.accepted]);
    await client.query(`INSERT INTO zzsh_order.im_order_group(order_id,payment_confirmation_id,app_id) VALUES ($1,$2,$3)`,
      [fact.orderId, confirmationId, scope.appId]);
  }
  await recordAudit(client, {
    actorType: "system", action: "order.payment.confirmed", objectType: "rental_order", objectId: fact.orderId,
    outcome: "SUCCESS", reason: reasonCode ?? "APPLIED", requestId: fact.requestId,
    details: { confirmationId, disposition, reasonCode, before: { status: order.status },
      after: { status: disposition === "APPLIED" ? "PAID" : order.status === "PENDING_PAYMENT" && !timing.open ? "CANCELLED" : order.status } },
  });
  return { confirmationId, disposition, reasonCode, replay: false };
}
