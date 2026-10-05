import {createHash} from 'node:crypto';import type {Pool} from 'pg';
import {withTransaction,SecurityApiError} from '../auth/security-core';import {canonicalize} from '../supply/content-hash';import {conflict,notFound,invalid} from '../supply/supply-util';
import {createControlledPaymentSource,type PaymentInput} from '../order/payment-confirmation';
type Options=Parameters<typeof createControlledPaymentSource>[0]&{resourceOid:number;approvalDigest:string;allowedSourceIds:readonly string[]};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
/** Durable LOCAL_CONTROLLED declaration reader. It reuses the original order payment capability;
 * neither arbitrary HTTP outcomes nor a real-bank signature are accepted here. */
export function createDeclaredControlledPaymentReader(pool:Pool,options:Options){
 const verify=createControlledPaymentSource(options);if(!Number.isSafeInteger(options.resourceOid)||options.resourceOid<=0||!/^[0-9a-f]{64}$/.test(options.approvalDigest)||!options.allowedSourceIds.length||options.allowedSourceIds.some(id=>!/^[A-Za-z0-9_-]{1,128}$/.test(id)))throw invalid('Explicit reviewed payment declaration sources required');const allowed=new Set(options.allowedSourceIds);
 const read=async(sourceId:string)=>withTransaction(pool,async c=>{
  if(!allowed.has(sourceId))throw notFound();const resource=(await c.query("SELECT d.oid,current_database() AS name,current_user AS role,shobj_description(d.oid,'pg_database') AS marker,to_regclass('zzsh_order.controlled_payment_declaration') IS NOT NULL AS complete FROM pg_database d WHERE datname=current_database()")).rows[0];
  if(!resource||Number(resource.oid)!==options.resourceOid||resource.name!==options.config.database.name||resource.role!==options.config.database.user||resource.marker!=='zzsh:order-reservation-test:v1')throw conflict('Original payment declaration resource differs');if(!resource.complete)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Reliable local payment source unavailable');
  const row=(await c.query('SELECT * FROM zzsh_order.controlled_payment_declaration WHERE id=$1',[sourceId])).rows[0];if(!row)throw notFound();
  if(row.mode!=='LOCAL_CONTROLLED_DECLARED_PAYMENT'||row.app_id!==options.appId||row.merchant_scope_id!==options.merchantScopeId||row.approval_digest!==options.approvalDigest||row.resource_oid!==options.resourceOid||sha(row.canonical_payment)!==row.payment_digest)throw conflict('Original declared payment provenance differs');
  let input:PaymentInput;try{input=JSON.parse(row.canonical_payment);if(canonicalize(input)!==row.canonical_payment)throw Error();}catch{throw conflict('Original payment source is not canonical');}
  if(input.orderId!==row.order_id||input.providerTransactionId!==row.provider_transaction_id||input.merchantOrderNo!==row.merchant_order_no)throw conflict('Original payment transaction binding differs');
  const fact=verify(input);return Object.freeze({sourceId:row.id,sourceEventKey:row.source_event_key,sourceDigest:row.payment_digest,fact});
 });
 /** Query only. No accepted row is UNKNOWN responsibility, never an invitation to repay/reapply. */
 const recover=async(sourceId:string)=>{const original=await read(sourceId);return withTransaction(pool,async c=>{
  const payment=(await c.query(`SELECT id,order_id,disposition,merchant_order_no,amount_cents::text AS amount_cents,currency,
   to_char(provider_paid_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS provider_paid_at
   FROM zzsh_order.payment_confirmation WHERE source='CONTROLLED' AND merchant_scope_id=$1 AND provider_transaction_id=$2`,[options.merchantScopeId,original.fact.providerTransactionId])).rows[0];
  if(!payment)return{sourceId,sourceDigest:original.sourceDigest,acceptanceKnowledge:'UNKNOWN' as const,reason:'ORIGINAL_ACCEPTANCE_NOT_PROVED',mayReapply:false};
  if(payment.order_id!==original.fact.orderId||payment.merchant_order_no!==original.fact.merchantOrderNo
   ||payment.amount_cents!==original.fact.amountCents||payment.currency!==original.fact.currency
   ||payment.provider_paid_at!==original.fact.providerPaidAt)throw conflict('Original accepted payment differs from declared source');
  if(payment.disposition!=='APPLIED')return{sourceId,sourceDigest:original.sourceDigest,acceptanceKnowledge:'KNOWN' as const,disposition:payment.disposition,basisKnowledge:'NOT_APPLIED',mayReapply:false};
  const installed=(await c.query("SELECT to_regclass('zzsh_order.payment_distribution_basis') IS NOT NULL AS complete")).rows[0]?.complete;
  const basis=installed?(await c.query('SELECT basis_digest FROM zzsh_order.payment_distribution_basis WHERE order_id=$1 AND payment_confirmation_id=$2',[payment.order_id,payment.id])).rows[0]:null;
  return{sourceId,sourceDigest:original.sourceDigest,acceptanceKnowledge:'KNOWN' as const,disposition:'APPLIED',basisKnowledge:basis?'PRESENT_REQUIRES_ORIGINAL_DIGEST_READBACK':'UNKNOWN_MISSING_ORIGINAL_BASIS',mayReapply:false};
 });};return{read,recover};
}


