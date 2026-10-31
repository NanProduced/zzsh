import {createHash} from 'node:crypto';import type {Pool,PoolClient} from 'pg';
import {Logger} from '@nestjs/common';
import {withTransaction,recordAudit,SecurityApiError} from '../auth/security-core';import {canonicalize} from '../supply/content-hash';import {conflict,invalid,notFound} from '../supply/supply-util';
import {createPaymentDistributionStore,createNativePaymentDistributionStore,type DistributionOrderScope} from './distribution-payment-store';import {prepareAccrualFromFrozenPayment,type CompletedDistributionFacts} from './distribution-accrual';import {transitionRentalEarning,earningEconomicKey,type RentalEarning,type EarningLedgerPlan} from './distribution-mechanism';
import {readFormalCollectionAdmission,type FormalCollectionAdmission} from '../order/joinpay-collection-profile';
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
type LocalResource={kind:'LOCAL_CONTROLLED';scope:DistributionOrderScope};
type NativeResource={kind:'NATIVE';admission:FormalCollectionAdmission;database:string;runtimeUser:string;admissionSha256:string};
type Resource=LocalResource|NativeResource;
export type MissingAccrualItem={economicKey:string;beneficiaryUserId:string;role:'RENTER_REFERRAL'|'OWNER_REFERRAL';amountCents:string;dueAt:string;state:'MISSING'|'PRESENT'|'CONFLICT'};
export type MissingAccrualOrder={orderId:string;postingId:string;paymentConfirmationId:string;postedAt:string;gameId:string;
 status:'MISSING'|'PARTIAL'|'COMPLETE'|'CONFLICT'|'SKIPPED'|'UNKNOWN';reason:string|null;baseCents:string|null;items:MissingAccrualItem[]};
export type DistributionEarningStore={
 accrue(pool:Pool,orderId:string,requestId:string):Promise<{knowledge:'KNOWN';items:{root:RentalEarning;replayed:boolean}[]}|{knowledge:'UNKNOWN';reason:string;baseCents:string|null;items:import('./distribution-accrual').AccruedReferral[]}>;
 transition(pool:Pool,earningId:string,action:'SETTLE'|'REVOKE'|'RECOVER',expectedVersion:string,requestId:string,reversalSourceId?:string):Promise<{root:RentalEarning;replayed:boolean;receipt?:Record<string,any>;originalResult?:Record<string,any>}>;
 settleDue(pool:Pool,limit:number,requestId:string,gameIds?:readonly string[]|null):Promise<{scope:'LOCAL_CONTROLLED'|'NATIVE';selected:number;notAttempted:number;recoveryRequired:boolean;results:({earningId:string;status:'SETTLED';currentState:RentalEarning['state'];replayed:boolean}|{earningId:string;status:'UNKNOWN';errorCode:string})[]}>;
 readOrder(pool:Pool,orderId:string):Promise<{scope:'LOCAL_CONTROLLED'|'NATIVE';orderId:string;items:{root:RentalEarning;transitions:Record<string,any>[]}[]}>;
 discover(pool:Pool,input:{limit:number;gameIds?:readonly string[]|null}):Promise<{scope:'LOCAL_CONTROLLED'|'NATIVE';examined:number;orders:MissingAccrualOrder[]}>;
 replay(pool:Pool,orderIds:readonly string[],requestId:string):Promise<{scope:'LOCAL_CONTROLLED'|'NATIVE';requested:number;attempted:number;notAttempted:number;results:({orderId:string;status:'ACCRUED'|'REPLAYED';earningIds:string[]}|{orderId:string;status:'UNKNOWN';reason:string})[]}>;
 admitsOrder(orderId:string):boolean;
};
function originalOutcome(receipt:any,root:RentalEarning,action:'SETTLE'|'REVOKE'|'RECOVER'){
 const version=String(receipt.result_version),expected=String(receipt.expected_version),event=receipt.finance_event_id;
 if(receipt.earning_id!==root.id||receipt.action!==action||!/^[1-9]\d{0,18}$/.test(version)||!/^[1-9]\d{0,18}$/.test(expected)||BigInt(version)!==BigInt(expected)+1n||BigInt(version)>BigInt(root.version)||typeof receipt.source_digest!=='string'||!/^[0-9a-f]{64}$/.test(receipt.source_digest)||event!==null&&(typeof event!=='string'||!event)||action!=='REVOKE'&&event===null)throw conflict('Original earning transition receipt is inconsistent');
 const state=action==='SETTLE'?'SETTLED':action==='REVOKE'&&event===null?'RECOVERY_REQUIRED':'REVOKED',fundsDisposition=state==='RECOVERY_REQUIRED'?'SETTLED':state,recoveryRequiredCents=state==='RECOVERY_REQUIRED'?root.amountCents:null;
 if(state==='RECOVERY_REQUIRED'&&BigInt(root.amountCents)<=0n||version===root.version&&(root.state!==state||root.fundsDisposition!==fundsDisposition||root.recoveryRequiredCents!==recoveryRequiredCents))throw conflict('Original outcome differs from the exact current transition');
 return{earningId:root.id,action,version,state,fundsDisposition,recoveryRequiredCents,financeEventId:event,sourceDigest:receipt.source_digest};
}
function seed(row:any):RentalEarning{
 if(sha(row.canonical_seed)!==row.seed_digest)throw conflict('Original earning source digest differs');
 const original=JSON.parse(row.canonical_seed),source={kind:'NATIVE_RENTAL_REFERRAL',type:'NATIVE',system:'zzsh',entity:'rental_order',id:row.order_id} as const;
 const economicKey=earningEconomicKey(source,row.beneficiary_user_id,row.beneficiary_role);
 if(original.id!==row.id||row.economic_root_id!==row.id||row.economic_key!==economicKey||original.economicKey!==economicKey
  ||original.role!==row.beneficiary_role||original.beneficiaryUserId!==row.beneficiary_user_id
  ||Object.entries(source).some(([key,value])=>original.source?.[key]!==value)||original.source?.digest!==row.posting_digest
  ||original.amountCents!==String(row.amount_cents)||original.dueAt!==row.due_exact
  ||original.version!=='1'||original.state!=='PENDING'||original.fundsDisposition!=='PENDING'||original.recoveryRequiredCents!==null)
  throw conflict('Original earning seed and persisted source differ');
 return{...original,state:row.state,fundsDisposition:row.funds_disposition,version:String(row.version),recoveryRequiredCents:row.recovery_required_cents===null?null:String(row.recovery_required_cents)};
}
function completedFacts(row:any,orderId:string):CompletedDistributionFacts{
 return{origin:'NATIVE',orderId,confirmationId:row.payment_confirmation_id,postingId:row.id,postingDigest:sha(canonicalize(row)),
  postedAt:row.posted_at,classification:row.early?'EARLY':'NORMAL',calculationMode:row.manual_reason===null?'SYSTEM':'MANUAL',
  capturedCents:String(row.captured_cents),ownerNetCents:String(row.owner_net_cents),renterRefundCents:String(row.renter_refund_cents),
  platformContributionCents:String(row.platform_contribution_cents),compensationFeeCents:String(row.compensation_fee_cents)};
}
/** Explicit assembly only; creates no policy, admission, identity or money. */
export function createDistributionEarningStore(scope:DistributionOrderScope):DistributionEarningStore{return earningStore({kind:'LOCAL_CONTROLLED',scope});}
/** Formal NATIVE assembly from the reviewed collection admission; never a local allowlist alias. */
export function createNativeDistributionEarningStore(admission:FormalCollectionAdmission):DistributionEarningStore{
 const view=readFormalCollectionAdmission(admission);
 return earningStore({kind:'NATIVE',admission,database:view.database,runtimeUser:view.runtimeUser,admissionSha256:view.sha256});
}
function earningStore(resource:Resource):DistributionEarningStore{
 const local=resource.kind==='LOCAL_CONTROLLED'?resource.scope:null,allowed=new Set(local?.allowedOrderIds??[]),scopeLabel=local?'LOCAL_CONTROLLED' as const:'NATIVE' as const;
 const approvalDigest=resource.kind==='NATIVE'?resource.admissionSha256:local!.approvalDigest;
 const name=resource.kind==='NATIVE'?resource.database:'zzsh_test_order_'+local!.resourceSet,role=resource.kind==='NATIVE'?resource.runtimeUser:'zzsh_order_'+local!.resourceSet+'_r';
 const payment=resource.kind==='NATIVE'?createNativePaymentDistributionStore(resource.admission):createPaymentDistributionStore(resource.scope);
 if(!approvalDigest)throw invalid('Exact reviewed earning resource required');
 async function ready(c:PoolClient){
  if(resource.kind==='NATIVE'){
   const r=(await c.query(`SELECT current_database() AS name,current_user AS role,to_regclass('zzsh_order.rental_referral_earning') IS NOT NULL AND to_regclass('zzsh_order.rental_referral_transition') IS NOT NULL AND to_regclass('zzsh_order.rental_referral_reversal_source') IS NOT NULL AS complete`)).rows[0];
   if(!r||r.name!==name||r.role!==role||r.complete!==true)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Typed earning schema/resource not installed');return;
  }
  const r=(await c.query("SELECT d.oid,current_database() AS name,current_user AS role,shobj_description(d.oid,'pg_database') AS marker,to_regclass('zzsh_order.rental_referral_earning') IS NOT NULL AND to_regclass('zzsh_order.rental_referral_transition') IS NOT NULL AS complete FROM pg_database d WHERE d.datname=current_database()")).rows[0];
  if(!r||Number(r.oid)!==local!.resourceOid||r.name!==name||r.role!==role||r.marker!=='zzsh:order-reservation-test:v1'||!r.complete)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Typed earning schema/resource not installed');
 }
 async function orderLock(c:PoolClient,orderId:string){if(local&&!allowed.has(orderId))throw notFound();await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))",['zzsh:earning-order:'+orderId]);}
 async function wallet(c:PoolClient,userId:string){const covered=(await c.query('SELECT 1 FROM zzsh_order.wallet_coverage WHERE user_id=$1',[userId])).rowCount;if(!covered)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Wallet origin coverage not closed');const r=(await c.query(`SELECT ledger_revision::text AS revision,COALESCE((SELECT sum(credit_cents-debit_cents) FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1 AND account_code IN('OWNER_AVAILABLE','WALLET_AVAILABLE')),0)::text AS available FROM zzsh_order.wallet_revision WHERE user_id=$1`,[userId])).rows[0];if(!r||BigInt(r.available)<0n)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Wallet requires reconciliation');return r;}
 async function append(c:PoolClient,root:RentalEarning,plan:EarningLedgerPlan,revision:string){const eventId='earning_event_'+sha(canonicalize([root.economicKey,plan.kind])).slice(0,40);await c.query('INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision) VALUES($1,$2,$3,$4,$5)',[eventId,root.id,plan.kind,root.beneficiaryUserId,revision]);for(const[n,line]of plan.lines.entries())await c.query(`INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,source_payment_confirmation_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,['earning_line_'+sha(canonicalize([eventId,n+1])).slice(0,40),eventId,n+1,line.accountCode,line.debitCents,line.creditCents,line.counterpartyUserId,null,JSON.stringify({earningId:root.id,earningRole:root.role,scope:scopeLabel})]);return eventId;}
 async function posting(c:PoolClient,orderId:string){const row=(await c.query(`SELECT p.id,p.order_id,p.payment_confirmation_id,p.version_hash,p.early,p.manual_reason,p.captured_cents::text,p.owner_net_cents::text,p.renter_refund_cents::text,p.platform_contribution_cents::text,p.compensation_fee_cents::text,to_char(p.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS posted_at FROM zzsh_order.settlement_posting p WHERE order_id=$1`,[orderId])).rows[0];if(!row)return null;return{row,facts:completedFacts(row,orderId)};}
 async function accrue(pool:Pool,orderId:string,requestId:string){return withTransaction(pool,async c=>{
  await ready(c);await orderLock(c,orderId);const completed=await posting(c,orderId);if(!completed)return{knowledge:'UNKNOWN' as const,reason:'ORDER_NOT_COMPLETED',baseCents:null,items:[]};const original=await payment.readOriginal(c,orderId,completed.facts.confirmationId),allocation=prepareAccrualFromFrozenPayment(original.basis,completed.facts);if(allocation.knowledge==='UNKNOWN')return allocation;
  await c.query('SELECT id FROM zzsh_auth_user."user" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE',[[...new Set(allocation.items.map(i=>i.beneficiaryUserId))]]);const results=[];
  for(const item of allocation.items){const found=(await c.query(`SELECT e.*,to_char(e.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS due_exact FROM zzsh_order.rental_referral_earning e WHERE economic_key=$1 FOR UPDATE`,[item.economicKey])).rows[0];if(found){if(found.basis_digest!==item.basisDigest||found.posting_digest!==item.postingDigest||String(found.amount_cents)!==item.amountCents||found.due_exact!==item.dueAt)throw conflict('Original economic event has different frozen earning facts');results.push({root:seed(found),replayed:true});continue;}
   const w=await wallet(c,item.beneficiaryUserId),root:RentalEarning={id:'earning_'+sha(item.economicKey),economicKey:item.economicKey,source:{kind:'NATIVE_RENTAL_REFERRAL',type:'NATIVE',system:'zzsh',entity:'rental_order',id:orderId,digest:item.postingDigest,eventAt:completed.facts.postedAt},beneficiaryUserId:item.beneficiaryUserId,role:item.role,policyVersion:item.policyVersion,policyDigest:original.basis!.policyDigest!,baseDigest:allocation.digest,relationDigest:item.relationDigest,amountCents:item.amountCents,dueAt:item.dueAt,fingerprint:sha(canonicalize(item)),state:'PENDING',fundsDisposition:'PENDING',recoveryRequiredCents:null,version:'1'},canonical=canonicalize(root);
   await c.query(`INSERT INTO zzsh_order.finance_economic_root(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,policy_version,source_digest) VALUES($1,NULL,'NATIVE_RENTAL_REFERRAL','NATIVE','zzsh','rental_order',$2,$3,$4,$5,$6)`,[root.id,orderId,root.beneficiaryUserId,root.role,root.policyVersion,item.postingDigest]);
   await c.query(`INSERT INTO zzsh_order.rental_referral_earning(id,economic_root_id,economic_key,order_id,payment_confirmation_id,posting_id,beneficiary_user_id,beneficiary_role,amount_cents,due_at,basis_digest,posting_digest,canonical_seed,seed_digest,state,funds_disposition,version) VALUES($1,$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'PENDING','PENDING',1)`,[root.id,root.economicKey,orderId,completed.facts.confirmationId,completed.facts.postingId,root.beneficiaryUserId,root.role,root.amountCents,root.dueAt,item.basisDigest,item.postingDigest,canonical,sha(canonical)]);
   const n=root.amountCents,lines=BigInt(n)===0n?[]:[{accountCode:'DISTRIBUTION_EXPENSE',debitCents:n,creditCents:'0',counterpartyUserId:null},{accountCode:'WALLET_PENDING_EARNINGS',debitCents:'0',creditCents:n,counterpartyUserId:root.beneficiaryUserId}],eventId=await append(c,root,{kind:'EARNING_PENDING',rootId:root.id,subjectUserId:root.beneficiaryUserId,lines},w.revision);await c.query(`INSERT INTO zzsh_order.rental_referral_transition(id,earning_id,action,expected_version,result_version,finance_event_id,source_digest) VALUES($1,$2,'ACCRUE',0,1,$3,$4)`,['earning_transition_'+sha(root.id+':ACCRUE').slice(0,40),root.id,eventId,item.postingDigest]);await recordAudit(c,{actorType:'system',actorId:'distribution-accrual',action:'distribution.earning.pending',objectType:'rental_referral_earning',objectId:root.id,requestId,outcome:'SUCCESS',details:{orderId,role:root.role,basisDigest:item.basisDigest,postingDigest:item.postingDigest}});results.push({root,replayed:false});
  }await c.query('SET CONSTRAINTS ALL IMMEDIATE');return{knowledge:'KNOWN' as const,items:results};
 });}
 async function transition(pool:Pool,earningId:string,action:'SETTLE'|'REVOKE'|'RECOVER',expectedVersion:string,requestId:string,reversalSourceId?:string){if(!['SETTLE','REVOKE','RECOVER'].includes(action)||!/^[1-9]\d{0,18}$/.test(expectedVersion))throw invalid('Original earning action/version required');return withTransaction(pool,async c=>{
  await ready(c);const hint=(await c.query('SELECT order_id,beneficiary_user_id FROM zzsh_order.rental_referral_earning WHERE id=$1',[earningId])).rows[0];if(!hint)throw notFound();await orderLock(c,hint.order_id);await c.query('SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE',[hint.beneficiary_user_id]);const row=(await c.query(`SELECT e.*,to_char(e.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS due_exact FROM zzsh_order.rental_referral_earning e WHERE id=$1 FOR UPDATE`,[earningId])).rows[0],root=seed(row),receipt=(await c.query('SELECT * FROM zzsh_order.rental_referral_transition WHERE earning_id=$1 AND action=$2',[earningId,action])).rows[0];
  if(receipt){if(action!=='SETTLE'&&receipt.reversal_source_id!==reversalSourceId)throw conflict('Original reversal source changed');return{root,replayed:true,receipt,originalResult:originalOutcome(receipt,root,action)};}if(root.version!==expectedVersion)throw conflict('Earning version changed');let reversal=null;if(action!=='SETTLE'){if(!reversalSourceId)throw invalid('Original reversal source required');reversal=(await c.query('SELECT * FROM zzsh_order.rental_referral_reversal_source WHERE id=$1 AND earning_id=$2',[reversalSourceId,earningId])).rows[0];if(!reversal)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Original reversal source unavailable');if(reversal.scope!==scopeLabel||reversal.approval_digest!==approvalDigest||reversal.basis_digest!==row.basis_digest||String(reversal.amount_cents)!==root.amountCents||sha(reversal.canonical_source)!==reversal.source_digest||reversal.canonical_source!==canonicalize({schema:'rental-referral-reversal.v1',scope:scopeLabel,earningId,basisDigest:row.basis_digest,amountCents:root.amountCents}))throw conflict('Reversal source does not bind original earning');}
  const clock=(await c.query("SELECT date_trunc('milliseconds',clock_timestamp()) AS now,clock_timestamp()>=$1::timestamptz AS due",[root.dueAt])).rows[0];if(action==='SETTLE'&&root.state==='PENDING'&&!clock.due)throw conflict('Earning is not due');const w=await wallet(c,root.beneficiaryUserId);
  let changed;
  if(action==='RECOVER'){
   if(root.state!=='RECOVERY_REQUIRED'||root.fundsDisposition!=='SETTLED'||root.recoveryRequiredCents!==root.amountCents||BigInt(root.amountCents)<=0n)throw conflict('Original settled recovery obligation required');
   const original=(await c.query("SELECT reversal_source_id,finance_event_id FROM zzsh_order.rental_referral_transition WHERE earning_id=$1 AND action='REVOKE'",[earningId])).rows[0];if(!original||original.reversal_source_id!==reversalSourceId||original.finance_event_id!==null)throw conflict('Original outstanding reversal receipt required');
   if(BigInt(w.available)<BigInt(root.amountCents))throw conflict('Original recovery still has insufficient available funds');
   changed={root:{...root,state:'REVOKED' as const,fundsDisposition:'REVOKED' as const,recoveryRequiredCents:null,version:(BigInt(root.version)+1n).toString()},replayed:false,ledgerPlan:{kind:'EARNING_REVOKED' as const,rootId:root.id,subjectUserId:root.beneficiaryUserId,lines:[{accountCode:'WALLET_AVAILABLE',debitCents:root.amountCents,creditCents:'0',counterpartyUserId:root.beneficiaryUserId},{accountCode:'DISTRIBUTION_EXPENSE',debitCents:'0',creditCents:root.amountCents,counterpartyUserId:null}]}};
  }else changed=transitionRentalEarning({...root,dueAt:new Date(root.dueAt).toISOString()},action,expectedVersion,new Date(clock.now).toISOString(),w.available);
  if(changed.replayed)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Original earning transition receipt unavailable');const next={...changed.root,dueAt:root.dueAt};const eventId=changed.ledgerPlan?await append(c,next,changed.ledgerPlan,w.revision):null;
  const updated=await c.query('UPDATE zzsh_order.rental_referral_earning SET state=$2,funds_disposition=$3,version=$4,recovery_required_cents=$5 WHERE id=$1 AND version=$6',[earningId,next.state,next.fundsDisposition,next.version,next.recoveryRequiredCents,expectedVersion]);if(updated.rowCount!==1)throw conflict('Earning CAS changed');await c.query(`INSERT INTO zzsh_order.rental_referral_transition(id,earning_id,action,expected_version,result_version,finance_event_id,reversal_source_id,source_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8)`,['earning_transition_'+sha(earningId+':'+action).slice(0,40),earningId,action,expectedVersion,next.version,eventId,reversal?.id??null,reversal?.source_digest??row.seed_digest]);await recordAudit(c,{actorType:'system',actorId:'distribution-transition',action:'distribution.earning.'+action.toLowerCase(),objectType:'rental_referral_earning',objectId:earningId,requestId,outcome:'SUCCESS',details:{before:root.state,after:next.state,version:next.version,reversalSourceId:reversal?.id??null}});await c.query('SET CONSTRAINTS ALL IMMEDIATE');return{root:next,replayed:false,originalResult:originalOutcome({earning_id:earningId,action,expected_version:expectedVersion,result_version:next.version,finance_event_id:eventId,source_digest:reversal?.source_digest??row.seed_digest},next,action)};
 });}
 function scopeIds(gameIds:readonly string[]|null|undefined){if(gameIds!==null&&gameIds!==undefined&&(!Array.isArray(gameIds)||gameIds.length>50||new Set(gameIds).size!==gameIds.length||gameIds.some(id=>!ID.test(id))))throw invalid('Bounded game scope required');return gameIds===null||gameIds===undefined?null:[...gameIds];}
 async function settleDue(pool:Pool,limit:number,requestId:string,gameIds?:readonly string[]|null){
  if(local&&allowed.size>100||!Number.isSafeInteger(limit)||limit<1||limit>100||typeof requestId!=='string'||!ID.test(requestId))throw invalid('Bounded due batch and request required');const games=scopeIds(gameIds);
  const due=await withTransaction(pool,async c=>{
   await ready(c);
   if(local)return(await c.query(`SELECT id,version::text AS version FROM zzsh_order.rental_referral_earning
    WHERE order_id=ANY($1::text[]) AND state='PENDING' AND due_at<=clock_timestamp() ORDER BY due_at,id LIMIT $2`,
    [[...allowed],limit])).rows as {id:string;version:string}[];
   return(await c.query(`SELECT e.id,e.version::text AS version FROM zzsh_order.rental_referral_earning e JOIN zzsh_order.rental_order o ON o.id=e.order_id
    WHERE e.state='PENDING' AND e.due_at<=clock_timestamp() AND ($1::text[] IS NULL OR o.game_id=ANY($1))
    ORDER BY e.due_at,e.id LIMIT $2`,
    [games,limit])).rows as {id:string;version:string}[];
  });
  const results:({earningId:string;status:'SETTLED';currentState:RentalEarning['state'];replayed:boolean}|{earningId:string;status:'UNKNOWN';errorCode:string})[]=[];
  for(const row of due){
   try{
    const result=await transition(pool,row.id,'SETTLE',row.version,requestId);
    results.push({earningId:row.id,status:'SETTLED',currentState:result.root.state,replayed:result.replayed});
   }catch(error){
    results.push({earningId:row.id,status:'UNKNOWN',errorCode:distributionFailureCode(error)});
    break;
   }
  }
  return{scope:scopeLabel,selected:due.length,notAttempted:due.length-results.length,recoveryRequired:results.some(r=>r.status==='UNKNOWN'),results};
 }
 async function discover(pool:Pool,input:{limit:number;gameIds?:readonly string[]|null}){
  if(!Number.isSafeInteger(input.limit)||input.limit<1||input.limit>100)throw invalid('Bounded accrual discovery required');const games=scopeIds(input.gameIds);
  return withTransaction(pool,async c=>{
   await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');await ready(c);
   const rows=(await c.query(`SELECT p.id,p.order_id,p.payment_confirmation_id,p.version_hash,p.early,p.manual_reason,p.captured_cents::text,p.owner_net_cents::text,
    p.renter_refund_cents::text,p.platform_contribution_cents::text,p.compensation_fee_cents::text,
    to_char(p.posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS posted_at,o.game_id
    FROM zzsh_order.settlement_posting p JOIN zzsh_order.rental_order o ON o.id=p.order_id
    WHERE ($1::text[] IS NULL OR p.order_id=ANY($1)) AND ($2::text[] IS NULL OR o.game_id=ANY($2))
    ORDER BY p.posted_at DESC,p.id DESC LIMIT $3`,[local?[...allowed]:null,games,input.limit])).rows;
   const orders:MissingAccrualOrder[]=[];
   for(const row of rows){
    // game_id is only for admin scope; the immutable posting digest must use the same columns as accrual.
    const {game_id,...postingRow}=row;
    const facts=completedFacts(postingRow,row.order_id),base={orderId:row.order_id,postingId:row.id,paymentConfirmationId:row.payment_confirmation_id,postedAt:row.posted_at,gameId:row.game_id};
    try{
     const original=await payment.readOriginal(c,row.order_id,row.payment_confirmation_id),allocation=prepareAccrualFromFrozenPayment(original.basis,facts);
     if(allocation.knowledge==='UNKNOWN'){orders.push({...base,status:'UNKNOWN',reason:allocation.reason,baseCents:allocation.baseCents,items:[]});continue;}
     if(!allocation.items.length){orders.push({...base,status:'SKIPPED',reason:'NO_ELIGIBLE_REFERRAL',baseCents:allocation.baseCents,items:[]});continue;}
     const items:MissingAccrualItem[]=[];for(const item of allocation.items){
      const found=(await c.query('SELECT amount_cents::text,basis_digest,posting_digest FROM zzsh_order.rental_referral_earning WHERE economic_key=$1',[item.economicKey])).rows[0];
      items.push({economicKey:item.economicKey,beneficiaryUserId:item.beneficiaryUserId,role:item.role,amountCents:item.amountCents,dueAt:item.dueAt,
       state:!found?'MISSING':found.basis_digest!==item.basisDigest||found.posting_digest!==item.postingDigest||String(found.amount_cents)!==item.amountCents?'CONFLICT':'PRESENT'});
     }
     const missing=items.filter(i=>i.state==='MISSING').length,conflictCount=items.filter(i=>i.state==='CONFLICT').length;
     orders.push({...base,status:conflictCount?'CONFLICT':missing===items.length?'MISSING':missing?'PARTIAL':'COMPLETE',reason:conflictCount?'ORIGINAL_EARNING_FACTS_DIFFER':null,baseCents:allocation.baseCents,items});
    }catch(error){orders.push({...base,status:'UNKNOWN',reason:distributionFailureCode(error),baseCents:null,items:[]});}
   }
   return{scope:scopeLabel,examined:orders.length,orders};
  });
 }
 async function replay(pool:Pool,orderIds:readonly string[],requestId:string){
  if(!Array.isArray(orderIds)||!orderIds.length||orderIds.length>100||new Set(orderIds).size!==orderIds.length||orderIds.some(id=>!ID.test(id))||typeof requestId!=='string'||!ID.test(requestId))throw invalid('One bounded unique order cohort required');
  if(local&&orderIds.some(id=>!allowed.has(id)))throw notFound();
  const results:({orderId:string;status:'ACCRUED'|'REPLAYED';earningIds:string[]}|{orderId:string;status:'UNKNOWN';reason:string})[]=[];
  for(const orderId of orderIds){
   try{
    const result=await accrue(pool,orderId,requestId);
    if(result.knowledge==='UNKNOWN'){results.push({orderId,status:'UNKNOWN',reason:result.reason});break;}
    results.push({orderId,status:result.items.every(item=>item.replayed)?'REPLAYED':'ACCRUED',earningIds:result.items.map(item=>item.root.id)});
   }catch(error){results.push({orderId,status:'UNKNOWN',reason:distributionFailureCode(error)});break;}
  }
  return{scope:scopeLabel,requested:orderIds.length,attempted:results.length,notAttempted:orderIds.length-results.length,results};
 }
 async function readOrder(pool:Pool,orderId:string){return withTransaction(pool,async c=>{
  await c.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY');
  await ready(c);if(local&&!allowed.has(orderId))throw notFound();
  const rows=(await c.query(`SELECT e.*,to_char(e.due_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS due_exact
   FROM zzsh_order.rental_referral_earning e WHERE order_id=$1 ORDER BY id`,[orderId])).rows;
  const items=[];
  for(const row of rows){
   const root=seed(row),receipts=(await c.query('SELECT * FROM zzsh_order.rental_referral_transition WHERE earning_id=$1 ORDER BY result_version',[row.id])).rows;
   items.push({root,transitions:receipts.filter(r=>['SETTLE','REVOKE','RECOVER'].includes(r.action)).map(r=>originalOutcome(r,root,r.action))});
  }
  return{scope:scopeLabel,orderId,items};
 });}
 return{accrue,transition,settleDue,readOrder,discover,replay,admitsOrder:(orderId:string)=>!local||allowed.has(orderId)};
}
export function distributionFailureCode(error:unknown){
 const code=(error as {code?:unknown}|null)?.code;
 return typeof code==='string'&&/^[A-Z0-9_]{1,64}$/.test(code)?code:'EARNING_WRITE_FAILED';
}
/** The posting is already committed. Its original economic roots are the recovery keys. */
export function distributionSettlementPostCommitCallback(pool:Pool,orderId:string,requestId:string,store?:DistributionEarningStore):(()=>Promise<void>)|undefined{
 if(!store?.admitsOrder(orderId))return undefined;
 return async()=>{
  try{
   const result=await store.accrue(pool,orderId,requestId);
   if(result.knowledge==='UNKNOWN'&&result.reason!=='ORDER_NOT_COMPLETED')Logger.warn({event:'distribution.accrual.unknown',orderId,requestId,reason:result.reason},'Distribution');
  }catch(error){
   Logger.warn({event:'distribution.accrual.unknown',orderId,requestId,reason:distributionFailureCode(error),recovery:'READ_ORIGINAL_ORDER_BEFORE_RECOVERY'},'Distribution');
  }
 };
}
