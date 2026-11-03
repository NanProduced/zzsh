// Explicit local provider adapter; the browser supplies a signed original ticket, never money truth.
import type { Pool, PoolClient } from "pg";
import { assertUserContextInTransaction, type UserContext } from "../auth/user-identity";
import { recordAudit, SecurityApiError, withTransaction } from "../auth/security-core";
import { canonicalize } from "../supply/content-hash";
import { conflict, fingerprintRequest, invalid, notFound, withIdempotency } from "../supply/supply-util";
import { validateIdempotencyKey } from "../contracts/api-v1";
import { assertLocalFinancialSandboxResource, ensureLocalSandboxOrderAdmission, localFinancialSandboxRegistration, type LocalFinancialSandbox } from "../finance/local-financial-sandbox-resource";
import type { PaymentDistributionStore } from "../finance/distribution-payment-store";
import { createSandboxControlledPaymentSource, confirmOrderPayment, type PaymentInput } from "./payment-confirmation";
import { signLocalSandboxCheckout, verifyLocalSandboxCheckout, assertLocalSandboxCheckoutSigner, localSandboxPaymentAnchor, type LocalSandboxCheckoutSigner } from "./local-sandbox-checkout-crypto";
import { createHash } from "node:crypto";

type Actor = UserContext & { requestId: string };
export type LocalSandboxCheckoutOptions = Readonly<{ sandbox: LocalFinancialSandbox; signer: LocalSandboxCheckoutSigner; appId: string; distribution: PaymentDistributionStore }>;
type Options = LocalSandboxCheckoutOptions;
type Order = { id: string; display_no: string; status: string; currency: string; amount_cents: string; created_at: string; hold_until: string };
const sha = (value: string) => createHash("sha256").update(value).digest("hex"), ISSUE = "local-sandbox.checkout.issue.v1", COMPLETE = "local-sandbox.checkout.complete.v1";
const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "Original sandbox checkout facts unavailable");
const validOrderId = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
export class LocalSandboxCheckoutCommitUnknown extends SecurityApiError {
  constructor(readonly originalKey: string) { super(503, "EVIDENCE_UNAVAILABLE", "Checkout result is unknown; recover only the original key"); }
}
async function command<T>(pool: Pool, key: string, work: (c: PoolClient) => Promise<T>) {
  let completed = false;
  try { return await withTransaction(pool, async c => {
    await c.query("SELECT set_config('statement_timeout','3000ms',true),set_config('lock_timeout','500ms',true),set_config('max_parallel_workers_per_gather','0',true)");
    const result = await work(c);await c.query('SET CONSTRAINTS ALL IMMEDIATE'); completed = true; return result;
  }); } catch (error) { if (completed) throw new LocalSandboxCheckoutCommitUnknown(key); throw error; }
}
async function ownOrder(c: PoolClient, actor: Actor, orderId: string, lockForIssue = false): Promise<Order> {
  // No user/order lock before the original graph/party/account/order lock sequence.
  const row = (await c.query<Order>(`SELECT id,display_no,status,currency,(rental_amount_cents+deposit_amount_cents)::text AS amount_cents,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
    to_char(hold_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS hold_until
    FROM zzsh_order.rental_order WHERE id=$1 AND renter_user_id=$2${lockForIssue ? " FOR UPDATE" : ""}`, [orderId, actor.userId])).rows[0];
  if (!row) throw notFound();
  if (row.currency !== "CNY" || !/^(0|[1-9]\d{0,23})$/.test(row.amount_cents)) throw unavailable(); return row;
}
const now = async (c: PoolClient) => (await c.query<{ at: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS at")).rows[0]!.at;

/** Discovery is read-only; issuing and completing still recheck the original order and every money gate. */
export async function readLocalSandboxCheckoutAvailability(pool: Pool, actor: Actor, orderId: string, options: Options) {
  assertLocalSandboxCheckoutSigner(options.signer, options.sandbox);
  if (!validOrderId(orderId)) throw invalid();
  return withTransaction(pool, async c => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const registration = await assertLocalFinancialSandboxResource(c, options.sandbox, "READ_ORIGINAL");
    await assertUserContextInTransaction(c, actor, "READ");
    const order = await ownOrder(c, actor, orderId), observedAt = await now(c);
    const original = (await c.query(`SELECT count(a.id)=1 AS eligible FROM zzsh_order.rental_order o
      JOIN zzsh_order.local_financial_sandbox_registration s ON s.reference=$2
      JOIN zzsh_iam.audit_event a ON a.object_id=o.id AND a.object_type='rental_order' AND a.action='order.reservation.created'
        AND a.actor_type='user' AND a.actor_id=o.renter_user_id AND a.outcome='SUCCESS' AND a.occurred_at>=s.registered_at
      WHERE o.id=$1 AND o.created_at>=s.registered_at AND NOT EXISTS(SELECT 1 FROM zzsh_order.distribution_order_admission d
        WHERE d.order_id=o.id AND(d.mode<>'LOCAL_CONTROLLED' OR d.approval_digest<>s.registration_digest OR NOT d.active))`,
    [orderId, registration.reference])).rows[0]?.eligible === true;
    return { contractVersion: "local-sandbox-checkout-availability.v1", scope: "LOCAL_CONTROLLED", orderId, observedAt,
      checkoutEnabled: registration.active && original && order.status === "PENDING_PAYMENT" && order.hold_until > observedAt,
      productionPaymentCapability: false, bankArrival: "UNKNOWN" };
  });
}

export async function issueLocalSandboxCheckout(pool: Pool, actor: Actor, orderId: string, keyValue: unknown, options: Options) {
  assertLocalSandboxCheckoutSigner(options.signer, options.sandbox);
  if (!validOrderId(orderId)) throw invalid();
  const key = validateIdempotencyKey(keyValue);
  return command(pool, key, async c => {
    await assertLocalFinancialSandboxResource(c, options.sandbox, "READ_ORIGINAL");
    return withIdempotency(c, { realm: "user", principalId: actor.userId, operation: ISSUE, resourceId: orderId }, key,
      fingerprintRequest(ISSUE, orderId, {}), async () => { await assertUserContextInTransaction(c, actor, "READ"); await ownOrder(c, actor, orderId); }, async () => {
        // This short ISSUE transaction never waits for graph/party/account locks. Its own order lock
        // lets the admission FK be created before a future confirmation transaction starts.
        const registration = await assertLocalFinancialSandboxResource(c, options.sandbox), proof = localFinancialSandboxRegistration(options.sandbox), order = await ownOrder(c, actor, orderId, true), at = await now(c);
        if (order.status !== "PENDING_PAYMENT" || order.hold_until <= at) throw conflict("Order is no longer payable; read original payment status");
        await ensureLocalSandboxOrderAdmission(c, options.sandbox, orderId);
        const checkoutId = "sandbox_checkout_" + sha(canonicalize([proof.digest, actor.userId, orderId, key])).slice(0, 40);
        const expiresAt = new Date(Math.min(Date.parse(order.hold_until), Date.parse(at) + 120000)).toISOString();
        const token = signLocalSandboxCheckout(options.signer, { schema: "local-sandbox-checkout.v1", sandboxDigest: proof.digest,
          checkoutId, userId: actor.userId, sessionHash: sha(actor.sessionId), orderId, displayNo: order.display_no,
          amountCents: order.amount_cents, currency: "CNY", orderCreatedAt: order.created_at, issuedAt: at, expiresAt });
        const completeKey = "sandbox-complete-" + sha(checkoutId).slice(0, 48);
        const url = new URL(`/api/v1/orders/${encodeURIComponent(orderId)}/local-checkouts/page`, registration.origins.apiOrigin); url.searchParams.set("key", key);
        await recordAudit(c, { actorType: "user", actorId: actor.userId, sessionId: actor.sessionId, requestId: actor.requestId,
          action: "local.sandbox.checkout.issued", objectType: "rental_order", objectId: orderId, outcome: "SUCCESS", details: { checkoutId, sandboxDigest: proof.digest } });
        return { status: 200, body: { contractVersion: "local-sandbox-checkout.v1", scope: "LOCAL_CONTROLLED", dataOrigin:"LOCAL_CONTROLLED",orderId,productionPaymentCapability: false,
          checkout: { id: checkoutId, displayNo: order.display_no, amount: { cents: order.amount_cents, currency: "CNY" }, expiresAt, ticket:token, completeKey, url: url.href } } };
      });
  });
}

export async function completeLocalSandboxCheckout(pool: Pool, actor: Actor, orderId: string, token: string, keyValue: unknown, options: Options) {
  assertLocalSandboxCheckoutSigner(options.signer, options.sandbox);
  if (!validOrderId(orderId)) throw invalid();
  const key = validateIdempotencyKey(keyValue);
  return command(pool, key, async c => {
    await assertLocalFinancialSandboxResource(c, options.sandbox, "READ_ORIGINAL");
    return withIdempotency(c, { realm: "user", principalId: actor.userId, operation: COMPLETE, resourceId: orderId }, key,
      fingerprintRequest(COMPLETE, orderId, { ticket:token }), async () => { await assertUserContextInTransaction(c, actor, "READ"); await ownOrder(c, actor, orderId); }, async () => {
        await assertLocalFinancialSandboxResource(c, options.sandbox);
        const at = await now(c);
        const claim = verifyLocalSandboxCheckout(options.signer, token, actor, orderId, at);
        if (key !== "sandbox-complete-" + sha(claim.checkoutId).slice(0, 48)) throw conflict("Use the original server checkout completion key");
        const order = await ownOrder(c, actor, orderId);
        if (claim.displayNo !== order.display_no || claim.amountCents !== order.amount_cents || claim.currency !== order.currency || claim.orderCreatedAt !== order.created_at) throw conflict("Original checkout/order binding changed");
        const anchor = localSandboxPaymentAnchor(options.sandbox, orderId);
        const input: PaymentInput = { orderId, merchantOrderNo: order.display_no, amountCents: order.amount_cents, currency: order.currency,
          providerTransactionId: anchor.providerTransactionId, providerPaidAt: order.created_at, requestId: anchor.requestId };
        // Declaration INSERT is deliberately inside confirmOrderPayment after its original lock
        // sequence; an early FK key-share lock here would invert order -> invitation graph.
        // The original kernel rechecks session/freeze after its party locks, and this deadline after
        // all account/order waits. Pre-lock verification alone cannot authorize a later expired ticket.
        const source = createSandboxControlledPaymentSource({ sandbox: options.sandbox, payerUserId: actor.userId,
          payerSessionId: actor.sessionId, checkoutExpiresAt: claim.expiresAt, appId: options.appId });
        const payment = await confirmOrderPayment(c, source(input), options.distribution);
        await recordAudit(c, { actorType: "user", actorId: actor.userId, sessionId: actor.sessionId, requestId: actor.requestId, action: "local.sandbox.checkout.completed",
          objectType: "rental_order", objectId: orderId, outcome: "SUCCESS", details: { checkoutId: claim.checkoutId, declarationId: anchor.declarationId, disposition: payment.disposition } });
        return { status: 200, body: { contractVersion: "local-sandbox-checkout-result.v1", scope: "LOCAL_CONTROLLED", orderId, payment, bankArrival: "UNKNOWN" } };
      });
  });
}

export async function readLocalSandboxCheckoutReceipt(pool: Pool, actor: Actor, orderId: string, operation: "ISSUE" | "COMPLETE", keyValue: unknown, options: Options) {
  assertLocalSandboxCheckoutSigner(options.signer, options.sandbox);
  if (!validOrderId(orderId) || !['ISSUE','COMPLETE'].includes(operation)) throw invalid();
  const key = validateIdempotencyKey(keyValue);
  return withTransaction(pool, async c => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await c.query("SELECT set_config('statement_timeout','3000ms',true),set_config('lock_timeout','500ms',true),set_config('max_parallel_workers_per_gather','0',true)");
    const registration=await assertLocalFinancialSandboxResource(c, options.sandbox, "READ_ORIGINAL"); await assertUserContextInTransaction(c, actor, "READ"); await ownOrder(c, actor, orderId);
    const row = (await c.query("SELECT response_status,response_body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2",
      [JSON.stringify(["user", actor.userId, operation === "ISSUE" ? ISSUE : COMPLETE, orderId]), key])).rows[0];
    const observedAt = await now(c);
    return row ? { scope: "LOCAL_CONTROLLED", knowledge: "KNOWN", receipt: row.response_body as unknown, observedAt, writeAssemblyReady:registration.active, mayReapply: false }
      : { scope: "LOCAL_CONTROLLED", knowledge: "UNKNOWN", receipt: null, observedAt, writeAssemblyReady:registration.active, mayReapply: false };
  });
}
