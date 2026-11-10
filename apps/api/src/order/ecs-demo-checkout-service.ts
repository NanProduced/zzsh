import type { Pool, PoolClient } from "pg";
import { assertUserContextInTransaction, type UserContext } from "../auth/user-identity";
import { recordAudit, SecurityApiError, withTransaction } from "../auth/security-core";
import { validateIdempotencyKey } from "../contracts/api-v1";
import { assertEcsTestDemoResource, demoFinanceScope, ecsTestDemoPaymentAnchor,
  type DemoFinanceResource } from "../finance/ecs-test-demo-resource";
import type { PaymentDistributionStore } from "../finance/distribution-payment-store";
import { readDistributionPolicyRowInTransaction } from "../finance/distribution-policy-store";
import { conflict, fingerprintRequest, invalid, notFound, withIdempotency } from "../supply/supply-util";
import { createEcsDemoControlledPaymentSource, type PaymentInput } from "./payment-confirmation";
import { acceptControlledPayment, readDemoPaymentRequestForAcceptance, type SyntheticRequestCapability } from "./channel-payment-store";
import { automaticOpeningAcceptance } from "./settlement-record";

type Actor = UserContext & { requestId: string };
// TODO(正式上线前): 移除测试收银适配及其装配，模拟成功不是渠道收款。
export type EcsDemoCheckoutOptions = Readonly<{ demo: DemoFinanceResource; appId: string; distribution: PaymentDistributionStore; capability: SyntheticRequestCapability }>;
type Order = { id: string; display_no: string; status: string; currency: string; amount_cents: string; created_at: string; hold_until: string };
const operation = "ecs-demo.checkout.confirm.v1";
const validId = (value: unknown): value is string => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "测试付款记录暂不可用");

export class EcsDemoCheckoutCommitUnknown extends SecurityApiError {
  constructor(readonly originalKey: string) { super(503, "EVIDENCE_UNAVAILABLE", "测试付款结果未知，请按原请求查询"); }
}

async function now(c: PoolClient) {
  return (await c.query<{ at: string }>("SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.MS\"Z\"') AS at")).rows[0]!.at;
}
async function ownOrder(c: PoolClient, actor: Actor, orderId: string, lock = false): Promise<Order> {
  const row = (await c.query<Order>(`SELECT id,display_no,status,currency,(rental_amount_cents+deposit_amount_cents)::text AS amount_cents,
    to_char(created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS created_at,
    to_char(hold_until AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS hold_until
    FROM zzsh_order.rental_order WHERE id=$1 AND renter_user_id=$2${lock ? " FOR UPDATE" : ""}`, [orderId, actor.userId])).rows[0];
  if (!row) throw notFound();
  if (row.currency !== "CNY" || !/^(0|[1-9]\d{0,23})$/.test(row.amount_cents)) throw unavailable();
  return row;
}
async function bounded(c: PoolClient) {
  await c.query("SELECT set_config('statement_timeout','3000ms',true),set_config('lock_timeout','500ms',true),set_config('max_parallel_workers_per_gather','0',true)");
}
async function command<T>(pool: Pool, key: string, work: (c: PoolClient) => Promise<T>) {
  let completed = false;
  try { return await withTransaction(pool, async c => {
    await bounded(c); const result = await work(c); await c.query("SET CONSTRAINTS ALL IMMEDIATE"); completed = true; return result;
  }); } catch (error) { if (completed) throw new EcsDemoCheckoutCommitUnknown(key); throw error; }
}

export async function readEcsDemoCheckoutAvailability(pool: Pool, actor: Actor, orderId: string, options: EcsDemoCheckoutOptions) {
  if (!validId(orderId)) throw invalid();
  return withTransaction(pool, async c => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); await bounded(c);
    const reg = await assertEcsTestDemoResource(c, options.demo, "READ_ORIGINAL");
    await assertUserContextInTransaction(c, actor, "READ"); const order = await ownOrder(c, actor, orderId), observedAt = await now(c);
    const original = (await c.query(`SELECT count(a.id)=1 AS eligible FROM zzsh_order.rental_order o
      JOIN zzsh_order.ecs_test_demo_finance_registration s ON s.reference=$2
      JOIN zzsh_iam.audit_event a ON a.object_id=o.id AND a.object_type='rental_order' AND a.action='order.reservation.created'
        AND a.actor_type='user' AND a.actor_id=o.renter_user_id AND a.outcome='SUCCESS' AND a.occurred_at>=s.registered_at
      WHERE o.id=$1 AND o.created_at>=s.registered_at AND NOT EXISTS(SELECT 1 FROM zzsh_order.distribution_order_admission d
        WHERE d.order_id=o.id AND (d.mode<>'LOCAL_CONTROLLED' OR d.approval_digest<>s.registration_digest OR NOT d.active))`,
    [orderId, reg.reference])).rows[0]?.eligible === true;
    const policy = await readDistributionPolicyRowInTransaction(c, false, "NATIVE");
    return { contractVersion: "ecs-test-checkout-availability.v1", scope: demoFinanceScope(options.demo), orderId, observedAt,
      checkoutEnabled: reg.active && original && policy.knowledge === "KNOWN" && order.status === "PENDING_PAYMENT" && order.hold_until > observedAt,
      productionPaymentCapability: false, bankArrival: "UNKNOWN" };
  });
}

export async function confirmEcsDemoCheckout(pool: Pool, actor: Actor, orderId: string, keyValue: unknown, options: EcsDemoCheckoutOptions) {
  if (!validId(orderId) || !validId(options.appId)) throw invalid();
  if (!options.capability) throw unavailable();
  const key = validateIdempotencyKey(keyValue);
  return command(pool, key, async c => {
    await assertEcsTestDemoResource(c, options.demo, "READ_ORIGINAL");
    return withIdempotency(c, { realm: "user", principalId: actor.userId, operation, resourceId: orderId }, key,
      fingerprintRequest(operation, orderId, {}), async () => { await assertUserContextInTransaction(c, actor, "READ"); await ownOrder(c, actor, orderId); }, async () => {
        await assertEcsTestDemoResource(c, options.demo); const order = await ownOrder(c, actor, orderId), at = await now(c);
        if (order.status !== "PENDING_PAYMENT" || order.hold_until <= at) throw conflict("订单已无法付款，请查看原订单状态");
        const expiresAt = new Date(Math.min(Date.parse(order.hold_until), Date.parse(at) + 120000)).toISOString();
        const anchor = ecsTestDemoPaymentAnchor(options.demo, orderId);
        const input: PaymentInput = { orderId, merchantOrderNo: order.display_no, amountCents: order.amount_cents, currency: order.currency,
          providerTransactionId: anchor.providerTransactionId, providerPaidAt: at, requestId: anchor.requestId };
        const source = createEcsDemoControlledPaymentSource({ demo: options.demo, payerUserId: actor.userId,
          payerSessionId: actor.sessionId, checkoutExpiresAt: expiresAt, appId: options.appId });
        const request = await readDemoPaymentRequestForAcceptance(c, { orderId, capability: options.capability });
        if (!request) throw conflict("请先选择支付方式并打开收银台");
        const fact = source(input);
        const payment = (await acceptControlledPayment(c, { fact, distribution: options.distribution, requestId: request, acceptance: automaticOpeningAcceptance })).payment;
        if (payment.disposition !== "APPLIED" || payment.reasonCode !== null) throw conflict("测试付款未完成，请查询原请求");
        await recordAudit(c, { actorType: "user", actorId: actor.userId, sessionId: actor.sessionId, requestId: actor.requestId,
          action: "ecs.demo.checkout.confirmed", objectType: "rental_order", objectId: orderId, outcome: "SUCCESS",
          details: { declarationId: anchor.declarationId, disposition: payment.disposition, bankArrival: "UNKNOWN" } });
        return { status: 200, body: { contractVersion: "ecs-test-checkout-result.v1", scope: demoFinanceScope(options.demo), orderId, payment, bankArrival: "UNKNOWN" } };
      });
  });
}

export async function readEcsDemoCheckoutReceipt(pool: Pool, actor: Actor, orderId: string, keyValue: unknown, options: EcsDemoCheckoutOptions) {
  if (!validId(orderId)) throw invalid(); const key = validateIdempotencyKey(keyValue);
  return withTransaction(pool, async c => {
    await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY"); await bounded(c);
    const reg = await assertEcsTestDemoResource(c, options.demo, "READ_ORIGINAL"); await assertUserContextInTransaction(c, actor, "READ"); await ownOrder(c, actor, orderId);
    const row = (await c.query(`SELECT response_status,response_body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2`,
      [JSON.stringify(["user", actor.userId, operation, orderId]), key])).rows[0];
    const receipt = row?.response_body as Record<string, unknown> | undefined;
    if (row && (row.response_status !== 200 || receipt?.contractVersion !== "ecs-test-checkout-result.v1"
      || receipt.scope !== demoFinanceScope(options.demo) || receipt.orderId !== orderId || receipt.bankArrival !== "UNKNOWN")) throw unavailable();
    return { contractVersion: "ecs-test-checkout-receipt.v1", scope: demoFinanceScope(options.demo), knowledge: row ? "KNOWN" : "UNKNOWN",
      receipt: receipt ?? null, observedAt: await now(c), writeAssemblyReady: reg.active, mayReapply: false };
  });
}
