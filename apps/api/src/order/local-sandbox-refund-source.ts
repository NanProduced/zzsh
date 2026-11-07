import { createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { invalid, conflict, notFound } from "../supply/supply-util";
import { canonicalize } from "../supply/content-hash";
import { assertLocalFinancialSandboxResource, localFinancialSandboxRegistration, type LocalFinancialSandbox } from "../finance/local-financial-sandbox-resource";
import { assertEcsTestDemoResource, readEcsTestDemoRegistration, type DemoFinanceResource } from "../finance/ecs-test-demo-resource";
import { sandboxForChannelRequestCapability, demoForChannelRequestCapability } from "./channel-payment-store";
import type { NativeRefundTerminalFact } from "./joinpay-refund-source";

export type LocalSandboxRefundOptions=Readonly<{sandbox:LocalFinancialSandbox;capability:unknown}|{demo:DemoFinanceResource;capability:unknown}>;
const facts=new WeakMap<object,{client:PoolClient;xid:string;owner:string;version:string;options:LocalSandboxRefundOptions;canonical:string;fact:NativeRefundTerminalFact}>();
const sha=(value:string)=>createHash('sha256').update(value).digest('hex'),ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export function localRefundRegistration(options:LocalSandboxRefundOptions){
  if('sandbox' in options){const p=localFinancialSandboxRegistration(options.sandbox);return{reference:p.registration.reference,digest:p.digest,merchant:'local_sandbox_'+p.digest.slice(0,32)};}
  const p=readEcsTestDemoRegistration(options.demo);return{reference:p.registration.reference,digest:p.digest,merchant:(options.demo.kind==='ECS_TEST_DEMO_FINANCE'?'ecs_demo_':'local_demo_')+p.digest.slice(0,32)};
}
export function isEcsDemoRefundTerminalFact(fact:unknown):boolean {
  const proof=fact&&typeof fact==='object'?facts.get(fact):undefined;
  return Boolean(proof&&'demo' in proof.options);
}
export async function assertLocalSandboxRefundResource(client:PoolClient,options:LocalSandboxRefundOptions){
  if(!options||typeof options!=='object')throw invalid('Registered refund capability required');
  let resource;
  if('sandbox' in options){const sandbox=sandboxForChannelRequestCapability(options.capability);
    if(!sandbox||sandbox!==options.sandbox)throw invalid('Registered local refund capabilities differ');resource=await assertLocalFinancialSandboxResource(client,sandbox);
  } else {const demo=demoForChannelRequestCapability(options.capability);
    if(!demo||demo!==options.demo)throw invalid('Registered test refund capabilities differ');resource=await assertEcsTestDemoResource(client,demo);}
  const ready=(await client.query(`SELECT to_regclass('zzsh_order.local_controlled_refund_operation') IS NOT NULL
    AND to_regclass('zzsh_order.local_controlled_refund_evidence') IS NOT NULL AS complete`)).rows[0];
  if(ready?.complete!==true)throw conflict('Local refund source schema unavailable');return resource;
}

/** Reads the original SQL-backed local operation, never an HTTP outcome or a cached terminal flag.
 * No evidence FK is written until the common kernel owns its original funds/user/intent locks. */
export async function captureLocalSandboxRefundTerminalFact(client:PoolClient,options:LocalSandboxRefundOptions,lease:{intentId:string;owner:string;version:string}):Promise<NativeRefundTerminalFact>{
  const {intentId,owner,version}=lease;
  if(typeof intentId!=='string'||!ID.test(intentId)||typeof owner!=='string'||!ID.test(owner)||typeof version!=='string'
    ||!/^[1-9][0-9]{0,18}$/.test(version)||BigInt(version)>9223372036854775807n)throw invalid();
  await assertLocalSandboxRefundResource(client,options);
  const p=localRefundRegistration(options);
  const row=(await client.query(`SELECT i.id,i.posting_id,i.order_id,i.payment_confirmation_id,i.renter_user_id,i.merchant_identity_id,
    i.original_payment_trx_no,i.original_payment_order_no,i.responsibility_version_hash,i.refund_order_no,i.amount_cents::text,i.currency,
    i.basis_kind,i.sandbox_registration_ref,op.id AS operation_id,op.scenario,op.final_canonical,op.final_digest
    FROM zzsh_order.channel_refund_intent i JOIN zzsh_order.local_controlled_refund_operation op ON op.intent_id=i.id
    JOIN zzsh_order.payment_confirmation c ON c.id=i.payment_confirmation_id AND c.order_id=i.order_id AND c.source='CONTROLLED' AND c.disposition='APPLIED'
    JOIN zzsh_order.controlled_payment_declaration d ON d.order_id=c.order_id AND d.merchant_scope_id=c.merchant_scope_id AND d.provider_transaction_id=c.provider_transaction_id
    JOIN zzsh_order.distribution_order_admission a ON a.id=d.admission_id AND a.order_id=i.order_id
    WHERE i.id=$1 AND i.payment_source='CONTROLLED' AND i.evidence_level='CONTROLLED_TEST'
      AND i.sandbox_registration_ref=$2 AND op.sandbox_registration_ref=$2 AND a.approval_digest=$3
      AND d.approval_digest=$3 AND i.merchant_identity_id=$4 AND c.merchant_scope_id=$4 AND i.lease_owner=$5 AND i.lease_version=$6::bigint`,
  [intentId,p.reference,p.digest,p.merchant,owner,version])).rows[0];
  if(!row)throw notFound();
  let terminal:Record<string,unknown>;
  try{
    terminal=JSON.parse(row.final_canonical);
    if(!terminal||Array.isArray(terminal)||Object.keys(terminal).sort().join(',')!=='amountCents,completedAt,currency,intentId,mode,originalPaymentTrxNo,refundOrderNo,refundTransactionNo,terminal'
      ||canonicalize(terminal)!==row.final_canonical||sha(row.final_canonical)!==row.final_digest||row.scenario!=='TIMEOUT_THEN_SUCCEED'
      ||terminal.mode!=='LOCAL_CONTROLLED'||terminal.terminal!=='SUCCEEDED'||terminal.intentId!==row.id||terminal.refundOrderNo!==row.refund_order_no
      ||terminal.originalPaymentTrxNo!==row.original_payment_trx_no||terminal.amountCents!==row.amount_cents||terminal.currency!=='CNY'
      ||typeof terminal.refundTransactionNo!=='string'||!ID.test(terminal.refundTransactionNo)||typeof terminal.completedAt!=='string'
      ||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(terminal.completedAt)||!Number.isFinite(Date.parse(terminal.completedAt))
      ||new Date(terminal.completedAt).toISOString()!==terminal.completedAt||!['POSTING','PRESTART_TERMINATION'].includes(row.basis_kind))throw Error();
  }catch{throw conflict('Original local refund operation is incomplete or mismatched');}
  const body:Omit<NativeRefundTerminalFact,'factsDigest'>={evidenceId:'local_rfe_'+sha(row.id+':'+row.operation_id).slice(0,40),intentId:row.id,
    postingId:row.posting_id,orderId:row.order_id,paymentConfirmationId:row.payment_confirmation_id,renterUserId:row.renter_user_id,
    merchantIdentityId:row.merchant_identity_id,originalPaymentTrxNo:row.original_payment_trx_no,originalPaymentOrderNo:row.original_payment_order_no,
    responsibilityVersionHash:row.responsibility_version_hash,refundOrderNo:row.refund_order_no,amountCents:row.amount_cents,currency:'CNY',terminal:'SUCCEEDED',
    refundTransactionNo:terminal.refundTransactionNo as string,completedAt:terminal.completedAt as string,sourceObservationId:row.operation_id,
    ...(row.basis_kind==='PRESTART_TERMINATION'?{basisKind:'PRESTART_TERMINATION' as const}:{})};
  const canonical=canonicalize(body),fact=Object.freeze({...body,factsDigest:sha(canonical)});
  const context=(await client.query('SELECT pg_current_xact_id()::text AS xid')).rows[0];
  if(typeof context?.xid!=='string')throw invalid('Original refund transaction unavailable');
  const bound='sandbox' in options?{sandbox:options.sandbox,capability:options.capability}:{demo:options.demo,capability:options.capability};
  facts.set(fact,{client,xid:context.xid,owner,version,options:Object.freeze(bound),canonical,fact});return fact;
}

export async function assertLocalSandboxRefundTerminalFact(client:PoolClient,fact:unknown):Promise<NativeRefundTerminalFact>{
  const p=fact&&typeof fact==='object'?facts.get(fact):undefined;
  if(!p||p.client!==client)throw invalid('Local refund fact is not verified on this transaction');
  await assertLocalSandboxRefundResource(client,p.options);
  const row=(await client.query(`SELECT pg_current_xact_id()::text AS xid,
    (i.state IN('SUCCEEDED','FAILED') AND COALESCE(i.terminal_evidence_id,to_jsonb(i)->>'demo_terminal_evidence_id')=$2 OR
      i.state IN('SUBMITTING','UNKNOWN','PROCESSING') AND i.lease_owner=$4 AND i.lease_version=$5::bigint AND i.lease_until>clock_timestamp()) AS live
    FROM zzsh_order.channel_refund_intent i WHERE i.id=$1 AND i.sandbox_registration_ref=$3`,
  [p.fact.intentId,p.fact.evidenceId,localRefundRegistration(p.options).reference,p.owner,p.version])).rows[0];
  if(row?.xid!==p.xid||row.live!==true)throw conflict('Local refund lease or transaction changed');return p.fact;
}

export async function persistLocalSandboxRefundTerminalFact(client:PoolClient,fact:unknown):Promise<void>{
  const checked=await assertLocalSandboxRefundTerminalFact(client,fact),p=facts.get(checked)!;
  const reference=localRefundRegistration(p.options).reference;
  await client.query(`INSERT INTO zzsh_order.local_controlled_refund_evidence(id,intent_id,operation_id,sandbox_registration_ref,
    terminal,refund_transaction_no,completed_at,facts_canonical,facts_digest,lease_version,lease_owner)
    VALUES($1,$2,$3,$4,'SUCCEEDED',$5,$6,$7,$8,$9,$10) ON CONFLICT(intent_id) DO NOTHING`,
  [checked.evidenceId,checked.intentId,checked.sourceObservationId,reference,checked.refundTransactionNo,checked.completedAt,p.canonical,checked.factsDigest,p.version,p.owner]);
  const original=(await client.query('SELECT id,facts_canonical,facts_digest FROM zzsh_order.local_controlled_refund_evidence WHERE intent_id=$1',[checked.intentId])).rows[0];
  if(!original||original.id!==checked.evidenceId||original.facts_canonical!==p.canonical||original.facts_digest!==checked.factsDigest)throw conflict('Original local refund evidence changed');
}
