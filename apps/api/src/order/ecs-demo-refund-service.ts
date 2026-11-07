import type { Pool } from "pg";
import { SecurityApiError, withTransaction } from "../auth/security-core";
import { assertEcsTestDemoOrderAdmission, assertEcsTestDemoResource, demoFinanceScope, readEcsTestDemoRegistration, type DemoFinanceResource } from "../finance/ecs-test-demo-resource";
import { conflict, invalid } from "../supply/supply-util";
import { createNativeRefundIntent, postedRefundAllocationKey } from "./channel-refund-store";
import { demoForChannelRequestCapability } from "./channel-payment-store";
import { runEcsDemoRefundStep } from "./local-sandbox-refund-worker";

type Options = Readonly<{ demo: DemoFinanceResource; capability: unknown }>;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const unavailable = () => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", "模拟退款记录暂不可用");

/** Allocates only the frozen posted responsibility and never accepts an amount from HTTP. */
export async function allocateEcsDemoPostedRefund(pool: Pool, options: Options, postingId: string, requestId: string) {
  if (!ID.test(postingId) || !ID.test(requestId) || demoForChannelRequestCapability(options.capability) !== options.demo) throw invalid();
  let completed = false;
  try { return await withTransaction(pool, async c => {
    await assertEcsTestDemoResource(c, options.demo);
    const row = (await c.query<{order_id:string;amount:string;due:boolean}>(`SELECT p.order_id,p.renter_refund_cents::text AS amount,
      p.refund_due_at<=clock_timestamp() AS due FROM zzsh_order.settlement_posting p
      JOIN zzsh_order.rental_order o ON o.id=p.order_id AND o.status='COMPLETED'
      JOIN zzsh_order.payment_confirmation pay ON pay.id=p.payment_confirmation_id AND pay.order_id=o.id
        AND pay.id=o.paid_confirmation_id AND pay.source='CONTROLLED' AND pay.disposition='APPLIED'
      WHERE p.id=$1`,[postingId])).rows[0];
    if (!row || typeof row.amount !== 'string' || !/^(0|[1-9]\d{0,23})$/.test(row.amount)) throw unavailable();
    await assertEcsTestDemoOrderAdmission(c, options.demo, row.order_id);
    if (!row.due) throw conflict('退款尚未到期');
    if (row.amount === '0') return { scope:demoFinanceScope(options.demo), outcome:'NO_REFUND_DUE' as const, bankArrival:'UNKNOWN' as const };
    const result = await createNativeRefundIntent(c,{postingId,amountCents:row.amount,idempotencyKey:postedRefundAllocationKey(postingId),
      requestId,capability:options.capability});
    await c.query('SET CONSTRAINTS ALL IMMEDIATE'); completed = true;
    return { scope:demoFinanceScope(options.demo), outcome:result.replayed?'REPLAYED' as const:'ALLOCATED' as const,
      intentId:result.intent.intentId, bankArrival:'UNKNOWN' as const };
  }); } catch (error) { if (completed) throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','模拟退款申请结果未知，请查询原订单'); throw error; }
}

/** Bounded worker pass. Each selected intent keeps its original payment, amount and idempotency key. */
export async function runEcsDemoRefundBatch(pool:Pool,options:Options,limit:number,workerId:string){
  if(!Number.isSafeInteger(limit)||limit<1||limit>10||!ID.test(workerId)||demoForChannelRequestCapability(options.capability)!==options.demo)throw invalid();
  const proof=readEcsTestDemoRegistration(options.demo);
  const postings=await withTransaction(pool,async c=>{
    await assertEcsTestDemoResource(c,options.demo);
    return(await c.query<{id:string}>(`SELECT p.id FROM zzsh_order.settlement_posting p
      JOIN zzsh_order.rental_order o ON o.id=p.order_id AND o.status='COMPLETED'
      JOIN zzsh_order.payment_confirmation pay ON pay.id=p.payment_confirmation_id AND pay.id=o.paid_confirmation_id AND pay.source='CONTROLLED'
      JOIN zzsh_order.distribution_order_admission a ON a.order_id=o.id AND a.approval_digest=$1 AND a.resource_oid=$2 AND a.resource_marker=$3
      WHERE p.renter_refund_cents>0 AND p.refund_due_at<=clock_timestamp()
        AND NOT EXISTS(SELECT 1 FROM zzsh_order.channel_refund_intent i WHERE i.posting_id=p.id)
      ORDER BY p.refund_due_at,p.id LIMIT $4`,[proof.digest,proof.registration.resource.databaseOid,proof.registration.resource.marker,limit])).rows;
  });
  const allocations=[];for(const row of postings)allocations.push(await allocateEcsDemoPostedRefund(pool,options,row.id,workerId));
  const intents=await withTransaction(pool,async c=>{
    await assertEcsTestDemoResource(c,options.demo);
    return(await c.query<{id:string}>(`SELECT id FROM zzsh_order.channel_refund_intent WHERE payment_source='CONTROLLED' AND sandbox_registration_ref=$1
      AND state IN('READY','SUBMITTING','UNKNOWN') AND due_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
      ORDER BY due_at,id LIMIT $2`,[proof.registration.reference,limit])).rows;
  });
  const outcomes=[];for(const row of intents)outcomes.push(await runEcsDemoRefundStep(pool,options,row.id,workerId));
  return { scope:demoFinanceScope(options.demo), selected:postings.length, allocations, outcomes, bankArrival:'UNKNOWN' as const };
}
