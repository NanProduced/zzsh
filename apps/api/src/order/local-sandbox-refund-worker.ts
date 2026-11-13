import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { SecurityApiError, withTransaction } from "../auth/security-core";
import { canonicalize } from "../supply/content-hash";
import { conflict, invalid, notFound } from "../supply/supply-util";
import { claimRefundIntent, lockRefundFunds, recordRefundTransportFailure, type RefundLease } from "./channel-refund-store";
import { assertLocalSandboxRefundResource, captureLocalSandboxRefundTerminalFact, localRefundRegistration, type LocalSandboxRefundOptions, type ControlledRefundOptions } from "./local-sandbox-refund-source";
import { consumeLocalSandboxRentalRefundTerminal } from "../finance/native-rental-refund-store";
import { demoFinanceScope } from "../finance/ecs-test-demo-resource";
const sha=(value:string)=>createHash('sha256').update(value).digest('hex'),ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export class LocalSandboxRefundCommitUnknown extends SecurityApiError{
  constructor(readonly intentId:string,readonly phase:'CLAIM'|'OPERATION'|'RESULT'){super(503,'EVIDENCE_UNAVAILABLE','Local refund result is unknown; query its original refund number');}
}
async function confirmed<T>(pool:Pool,intentId:string,phase:LocalSandboxRefundCommitUnknown['phase'],run:(c:PoolClient)=>Promise<T>){
  let completed=false;
  try{return await withTransaction(pool,async c=>{
    await c.query("SELECT set_config('statement_timeout','3000ms',true),set_config('lock_timeout','500ms',true),set_config('max_parallel_workers_per_gather','0',true)");
    const value=await run(c);await c.query('SET CONSTRAINTS ALL IMMEDIATE');completed=true;return value;
  });}catch(error){if(completed)throw new LocalSandboxRefundCommitUnknown(intentId,phase);throw error;}
}

async function submitOriginalOperation(c:PoolClient,options:ControlledRefundOptions,lease:RefundLease){
  const r=await assertLocalSandboxRefundResource(c,options),p=localRefundRegistration(options),i=lease.intent;
  await lockRefundFunds(c,'CONTROLLED',i.originalPayment.merchantIdentityId,i.originalPayment.transactionNo);
  await c.query('SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE',[i.renterUserId]);
  const row=(await c.query(`SELECT id,refund_order_no,original_payment_trx_no,amount_cents::text,currency,
    (state='SUBMITTING' AND lease_owner=$2 AND lease_version=$3::bigint AND lease_until>clock_timestamp()) AS live
    FROM zzsh_order.channel_refund_intent WHERE id=$1 AND payment_source='CONTROLLED' AND sandbox_registration_ref=$4 FOR UPDATE`,
  [i.intentId,lease.owner,lease.version,r.reference])).rows[0];
  if(!row)throw notFound();if(row.live!==true)throw conflict('Original local refund submit lease changed');
  const existing=(await c.query('SELECT id FROM zzsh_order.local_controlled_refund_operation WHERE intent_id=$1',[i.intentId])).rows[0];
  if(existing)return;
  const at=(await c.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at`)).rows[0]?.at;
  if(typeof at!=='string')throw conflict('Local refund clock unavailable');
  const id='local_refund_op_'+sha(i.intentId).slice(0,40),terminal={mode:'LOCAL_CONTROLLED',intentId:i.intentId,refundOrderNo:row.refund_order_no,
    originalPaymentTrxNo:row.original_payment_trx_no,amountCents:row.amount_cents,currency:'CNY',terminal:'SUCCEEDED',
    refundTransactionNo:'local_refund_trx_'+sha(i.intentId).slice(0,40),completedAt:at};
  const canonical=canonicalize(terminal);
  await c.query(`INSERT INTO zzsh_order.local_controlled_refund_operation(id,intent_id,sandbox_registration_ref,scenario,
    refund_order_no,original_payment_trx_no,amount_cents,currency,final_canonical,final_digest,original_lease_version,original_lease_owner)
    VALUES($1,$2,$3,$11,$4,$5,$6,'CNY',$7,$8,$9,$10)`,
  [id,i.intentId,p.reference,row.refund_order_no,row.original_payment_trx_no,row.amount_cents,canonical,sha(canonical),lease.version,lease.owner,
    'demo' in options?'IMMEDIATE_SUCCESS':'TIMEOUT_THEN_SUCCEED']);
}

/** ECS demo: persist one simulated operation and consume its original liability atomically.
 * It never calls a provider; after an uncertain commit only the original intent may be read. */
export async function runEcsDemoRefundStep(pool:Pool,options:Extract<LocalSandboxRefundOptions,{demo:unknown}>,intentId:string,workerId='demo_refund_'+randomUUID().replaceAll('-','')){
  if(typeof intentId!=='string'||!ID.test(intentId)||typeof workerId!=='string'||!ID.test(workerId))throw invalid();
  const lease=await confirmed(pool,intentId,'CLAIM',async c=>{
    await assertLocalSandboxRefundResource(c,options);
    return claimRefundIntent(c,{intentId,owner:workerId,ttlSeconds:30,requestId:workerId,capability:options.capability});
  });
  if(!lease)return{action:'NONE' as const,scope:demoFinanceScope(options.demo),bankArrival:'UNKNOWN' as const};
  return confirmed(pool,intentId,'RESULT',async c=>{
    await assertLocalSandboxRefundResource(c,options);
    if(lease.operation==='SUBMIT')await submitOriginalOperation(c,options,lease);
    const existing=(await c.query('SELECT id FROM zzsh_order.local_controlled_refund_operation WHERE intent_id=$1',[intentId])).rows[0];
    if(!existing){
      const observation=await recordRefundTransportFailure(c,{intentId,owner:lease.owner,version:lease.version,reason:'LOCAL_FAILURE',requestId:workerId,capability:options.capability});
      return{action:'QUERY' as const,scope:demoFinanceScope(options.demo),observation,bankArrival:'UNKNOWN' as const};
    }
    const fact=await captureLocalSandboxRefundTerminalFact(c,options,{intentId,owner:lease.owner,version:lease.version});
    const terminal=await consumeLocalSandboxRentalRefundTerminal(c,{fact,requestId:workerId});
    return{action:lease.operation,scope:demoFinanceScope(options.demo),terminal,bankArrival:'UNKNOWN' as const};
  });
}

/** One bounded local step: the first ACK is lost after durable fake-channel truth. Only QUERY of
 * that original operation can then consume the liability. No HTTP outcome or real provider call. */
export async function runLocalSandboxRefundStep(pool:Pool,options:ControlledRefundOptions,intentId:string,workerId='local_refund_'+randomUUID().replaceAll('-','')){
  if(typeof intentId!=='string'||!ID.test(intentId)||typeof workerId!=='string'||!ID.test(workerId))throw invalid();
  const lease=await confirmed(pool,intentId,'CLAIM',async c=>{
    await assertLocalSandboxRefundResource(c,options);
    return claimRefundIntent(c,{intentId,owner:workerId,ttlSeconds:30,requestId:workerId,capability:options.capability});
  });
  if(!lease)return{action:'NONE' as const,dataOrigin:'LOCAL_CONTROLLED' as const,formalRefund:false as const};
  if(lease.operation==='SUBMIT'){
    await confirmed(pool,intentId,'OPERATION',c=>submitOriginalOperation(c,options,lease));
    const observation=await confirmed(pool,intentId,'RESULT',c=>recordRefundTransportFailure(c,{intentId,owner:lease.owner,
      version:lease.version,reason:'TIMEOUT',requestId:workerId,capability:options.capability}));
    return{action:'SUBMIT' as const,dataOrigin:'LOCAL_CONTROLLED' as const,formalRefund:false as const,observation,terminal:null,bankArrival:'UNKNOWN' as const};
  }
  return confirmed(pool,intentId,'RESULT',async c=>{
    await assertLocalSandboxRefundResource(c,options);
    const existing=(await c.query('SELECT id FROM zzsh_order.local_controlled_refund_operation WHERE intent_id=$1',[intentId])).rows[0];
    if(!existing){
      const observation=await recordRefundTransportFailure(c,{intentId,owner:lease.owner,version:lease.version,reason:'LOCAL_FAILURE',requestId:workerId,capability:options.capability});
      return{action:'QUERY' as const,dataOrigin:'LOCAL_CONTROLLED' as const,formalRefund:false as const,observation,terminal:null,bankArrival:'UNKNOWN' as const};
    }
    const fact=await captureLocalSandboxRefundTerminalFact(c,options,{intentId,owner:lease.owner,version:lease.version});
    const terminal=await consumeLocalSandboxRentalRefundTerminal(c,{fact,requestId:workerId});
    return{action:'QUERY' as const,dataOrigin:'LOCAL_CONTROLLED' as const,formalRefund:false as const,terminal,bankArrival:'UNKNOWN' as const};
  });
}

/** Explicit host-driven batch only; does not install a timer or start with ordinary configuration. */
export async function runLocalSandboxRefundBatch(pool:Pool,options:LocalSandboxRefundOptions,limit:number,workerId:string){
  if(!Number.isSafeInteger(limit)||limit<1||limit>10||typeof workerId!=='string'||!ID.test(workerId))throw invalid();
  const ids=await withTransaction(pool,async c=>{
    const r=await assertLocalSandboxRefundResource(c,options);
    return(await c.query<{id:string}>(`SELECT id FROM zzsh_order.channel_refund_intent WHERE payment_source='CONTROLLED' AND sandbox_registration_ref=$1
      AND state IN('READY','SUBMITTING','UNKNOWN') AND due_at<=clock_timestamp() AND (lease_until IS NULL OR lease_until<=clock_timestamp())
      ORDER BY due_at,id LIMIT $2`,[r.reference,limit])).rows.map(row=>row.id);
  });
  const results=[];for(const id of ids)results.push(await runLocalSandboxRefundStep(pool,options,id,workerId));return{selected:ids.length,results};
}
