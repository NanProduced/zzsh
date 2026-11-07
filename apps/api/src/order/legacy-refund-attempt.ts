import {createHash,randomUUID} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {recordAudit,setAuditContext,withTransaction} from '../auth/security-core';
import {conflict,forbidden,invalid,notFound} from '../supply/supply-util';
import {assertRefundResource} from './channel-refund-store';
import {hasNativeOriginalOrderNo,lockRefundOrderNos} from './payment-original-lock';
import {readLegacyRefundCaseForExecution} from './legacy-refund-case-command';
import {assertFormalRefundProfile,assertInitialRefundAdmission,assertRefundBinding,assertRefundStart,describeRefundProfile,produceRefundRequest,readRefundOutbound,readRefundProfileEvidence,
  inspectRefundProfile,refundCompleteTimeToUtc,refundFailureMayRelease,refundWayAccepted,
  type BoundRefundProfile,type RefundOperation,type RefundWireBinding} from './joinpay-refund-profile';
import {preflightJoinpayRefundResponse} from './joinpay-refund-protocol';
import {exchangeRefundRequest,RefundAttemptCommitUnknown,type RefundExchange,type RefundExecution} from './joinpay-refund-attempt';
import {refundTerminalConflicts,type RefundSourceOptions} from './joinpay-refund-source';
import {canonicalize} from '../supply/content-hash';
import {LEGACY_REFUND_REASON} from './legacy-refund-review';

const ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/,sha=(value:string|Uint8Array)=>createHash('sha256').update(value).digest('hex');
const fresh=(prefix:string)=>`${prefix}_${randomUUID().replaceAll('-','')}`;
export type LegacyRefundExecution=RefundExecution & {legacyRefundsEnabled:boolean};
type LegacyIntent={id:string;case_id:string;state:string;revision:string;lease_version:string;lease_owner:string|null;lease_until:string|null;
  generation:number;
  requires_review:boolean;budget_disposition:string;terminal_evidence_id:string|null;terminal_event_id:string|null;provider_refund_trx_no:string|null;completed_at:string|null;
  order_id:string;duty_id:string;renter_user_id:string;merchant_identity_id:string;merchant_no:string;original_payment_order_no:string;refund_order_no:string;
  amount_cents:string;initial_admission_ref:string;initial_admission_sha256:string;initial_profile_id:string;initial_profile_sha256:string;initial_key_version_ref:string;
  notify_url:string;funds_account:string|null};
const columns=`i.id,i.case_id,i.generation,i.state,i.revision::text,i.lease_version::text,i.lease_owner,i.lease_until::text,i.requires_review,i.budget_disposition,
 i.terminal_evidence_id,i.terminal_event_id,i.provider_refund_trx_no,i.completed_at::text,x.order_id,x.duty_id,x.renter_user_id,x.merchant_identity_id,
 x.merchant_no,x.original_payment_order_no,i.refund_order_no,i.amount_cents::text,i.initial_admission_ref,i.initial_admission_sha256,i.initial_profile_id,
 i.initial_profile_sha256,i.initial_key_version_ref,i.notify_url,i.funds_account`;

async function confirmed<T>(pool:Pool,id:string,phase:'CLAIM'|'RESULT',action:(client:PoolClient)=>Promise<T>):Promise<T>{
 let complete=false;try{return await withTransaction(pool,async client=>{const result=await action(client);complete=true;return result;});}
 catch(error){if(complete)throw new RefundAttemptCommitUnknown(id,phase);throw error;}
}
async function lockContext(client:PoolClient,execution:LegacyRefundExecution,id:string):Promise<LegacyIntent>{
 if(!ID.test(id))throw invalid('Invalid legacy refund intent');await assertRefundResource(client,execution.admission);
 const hint=(await client.query<LegacyIntent>(`SELECT ${columns} FROM zzsh_order.legacy_refund_intent i JOIN zzsh_order.legacy_refund_case x ON x.id=i.case_id WHERE i.id=$1`,[id])).rows[0];
 if(!hint)throw notFound();
 const numbers=(await client.query<{refund_order_no:string}>(`SELECT refund_order_no FROM zzsh_order.legacy_refund_intent WHERE case_id=$1 ORDER BY refund_order_no COLLATE "C"`,[hint.case_id])).rows.map(value=>value.refund_order_no);
 await lockRefundOrderNos(client,hint.merchant_identity_id,[hint.original_payment_order_no,...numbers]);
 if(!(await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`,[hint.renter_user_id])).rowCount
  || !(await client.query(`SELECT ledger_revision FROM zzsh_order.wallet_revision WHERE user_id=$1`,[hint.renter_user_id])).rowCount)throw conflict('LEGACY_REFUND_SUBJECT_UNAVAILABLE');
 const row=(await client.query<LegacyIntent>(`SELECT ${columns} FROM zzsh_order.legacy_refund_intent i JOIN zzsh_order.legacy_refund_case x ON x.id=i.case_id WHERE i.id=$1 FOR UPDATE OF i`,[id])).rows[0];
 if(!row || row.case_id!==hint.case_id || row.order_id!==hint.order_id || row.duty_id!==hint.duty_id || row.renter_user_id!==hint.renter_user_id
  || row.merchant_identity_id!==hint.merchant_identity_id || row.merchant_no!==hint.merchant_no || row.original_payment_order_no!==hint.original_payment_order_no)throw conflict('LEGACY_REFUND_BINDING_CHANGED');
 const rechecked=(await client.query<{refund_order_no:string}>(`SELECT refund_order_no FROM zzsh_order.legacy_refund_intent WHERE case_id=$1 ORDER BY refund_order_no COLLATE "C"`,[hint.case_id])).rows.map(value=>value.refund_order_no);
 if(canonicalize(numbers)!==canonicalize(rechecked))throw conflict('LEGACY_REFUND_BINDING_CHANGED');
 assertInitialRefundAdmission(execution.admission,row.initial_admission_ref,row.initial_admission_sha256);
 return row;
}
function wire(row:LegacyIntent):RefundWireBinding{
 return {merchantNo:row.merchant_no,merchantIdentityId:row.merchant_identity_id,originalPaymentOrderNo:row.original_payment_order_no,
  refundOrderNo:row.refund_order_no,amountCents:row.amount_cents,currency:'CNY',notifyUrl:row.notify_url,profileId:row.initial_profile_id,
  initialProfileSha256:row.initial_profile_sha256,keyVersionRef:row.initial_key_version_ref,reason:LEGACY_REFUND_REASON,...(row.funds_account?{fundsAccount:row.funds_account as 'SETTLED'|'ADVANCE'}:{})};
}
type Prepared={row:LegacyIntent;binding:RefundWireBinding;profile:BoundRefundProfile;operation:'SUBMIT'|'QUERY';attemptId:string;key:string;owner:string;version:string;request:ReturnType<typeof produceRefundRequest>};
type PrepareResult={kind:'READY';prepared:Prepared}|{kind:'SKIPPED';state:string;reason:string}|{kind:'NOT_DISPATCHED';state:string};
type PrepareOptions={queryOnly?:boolean;terminalReview?:boolean;minimumIntervalSeconds?:number;authorize?:(client:PoolClient,id:string)=>Promise<void>};

/** Claim and persist the exact first request before any network action. */
async function prepareLegacyRefund(execution:LegacyRefundExecution,id:string,owner:string,options:PrepareOptions={}):Promise<PrepareResult>{
 if(!ID.test(owner) || options.minimumIntervalSeconds!==undefined && (!Number.isSafeInteger(options.minimumIntervalSeconds)||options.minimumIntervalSeconds<0||options.minimumIntervalSeconds>86400))throw invalid('Invalid legacy refund worker');
 return confirmed(execution.pool,id,'CLAIM',async client=>{
  if(options.authorize)await options.authorize(client,id);
  const row=await lockContext(client,execution,id);
  const terminalReview=options.terminalReview===true&&options.queryOnly===true&&row.requires_review&&['SUCCEEDED','FAILED'].includes(row.state)&&!!row.terminal_evidence_id;
  if(['SUCCEEDED','FAILED'].includes(row.state)&&!terminalReview)return {kind:'SKIPPED',state:row.state,reason:'TERMINAL'};
  const basis=await readLegacyRefundCaseForExecution(client,row.order_id,row.duty_id,row.case_id,row.id);
  if(basis.chainReview)return {kind:'SKIPPED',state:row.state,reason:'PREVIOUS_ATTEMPT_REVIEW'};
  await verifyPredecessors(client,execution,row);
  if(terminalReview)await verifyExistingTerminal(client,execution,row);
  const info=(await client.query<{dispatched:boolean;active:boolean;due:boolean;queries:string;interval_ok:boolean}>(`SELECT
    EXISTS(SELECT 1 FROM zzsh_order.legacy_refund_attempt WHERE intent_id=$1 AND operation='SUBMIT') AS dispatched,
    COALESCE(i.lease_until>clock_timestamp(),false) AS active,x.refund_due_at<=clock_timestamp() AS due,
    (SELECT count(*)::text FROM zzsh_order.legacy_refund_attempt WHERE intent_id=$1 AND operation='QUERY') AS queries,
    COALESCE((SELECT max(created_at)<=clock_timestamp()-make_interval(secs=>$2::integer) FROM zzsh_order.legacy_refund_attempt WHERE intent_id=$1),true) AS interval_ok
    FROM zzsh_order.legacy_refund_intent i JOIN zzsh_order.legacy_refund_case x ON x.id=i.case_id WHERE i.id=$1`,[id,options.minimumIntervalSeconds??0])).rows[0];
  if(!info || typeof info.dispatched!=='boolean' || typeof info.active!=='boolean' || typeof info.due!=='boolean' || typeof info.interval_ok!=='boolean' || !/^\d+$/.test(info.queries))throw conflict('LEGACY_REFUND_TIMING_UNAVAILABLE');
  if(info.active)return {kind:'SKIPPED',state:row.state,reason:'ACTIVE_LEASE'};
  if(!info.due)return {kind:'SKIPPED',state:row.state,reason:'NOT_DUE'};
  if(!info.interval_ok)return {kind:'SKIPPED',state:row.state,reason:'THROTTLED'};
  if(options.queryOnly&&!info.dispatched)return {kind:'NOT_DISPATCHED',state:row.state};
  const operation:Prepared['operation']=row.state==='READY'&&row.lease_version==='0'&&!info.dispatched?'SUBMIT':'QUERY';
  if(operation==='QUERY'&&!info.dispatched)return {kind:'SKIPPED',state:row.state,reason:'ORIGINAL_SUBMIT_UNAVAILABLE'};
  if(operation==='SUBMIT'&&(!execution.legacyRefundsEnabled||row.requires_review))return {kind:'SKIPPED',state:row.state,reason:'NEW_REFUND_DISABLED'};
  if(operation==='QUERY'&&BigInt(info.queries)>=10n&&!options.authorize)return {kind:'SKIPPED',state:row.state,reason:'BUDGET_EXHAUSTED'};
  if(row.budget_disposition!=='ALLOCATED'&&!terminalReview)return {kind:'SKIPPED',state:row.state,reason:'INELIGIBLE'};
  if(operation==='SUBMIT'&&await hasNativeOriginalOrderNo(client,row.original_payment_order_no)){
   await recordAudit(client,{actorType:'system',actorId:'legacy-refund-worker',action:'order.legacy.refund.first_submit.blocked',objectType:'legacy_refund_intent',
    objectId:id,requestId:id,outcome:'FAILURE',reason:'ORIGINAL_PAYMENT_CONFLICT'});
   return {kind:'SKIPPED',state:row.state,reason:'ORIGINAL_PAYMENT_CONFLICT'};
  }
  if(operation==='SUBMIT')assertRefundStart(execution.admission);
  const binding=wire(row),profile=execution.profileFor(operation,Object.freeze({...binding}));
  const p=describeRefundProfile(profile,operation),admission=assertFormalRefundProfile(execution.admission,profile,operation);
  const updated=(await client.query<{lease_version:string}>(`UPDATE zzsh_order.legacy_refund_intent SET state=CASE WHEN state='READY' THEN 'SUBMITTING' WHEN state IN('SUCCEEDED','FAILED') THEN state ELSE 'UNKNOWN' END,
    lease_version=lease_version+1,lease_owner=$2,lease_until=clock_timestamp()+interval '30 seconds',claim_xid=pg_current_xact_id(),revision=revision+1
    WHERE id=$1 AND state IN('READY','SUBMITTING','UNKNOWN','PROCESSING','REVIEW_REQUIRED','SUCCEEDED','FAILED') AND (lease_until IS NULL OR lease_until<=clock_timestamp())
    RETURNING lease_version::text`,[id,owner])).rows[0];
  if(!updated)return {kind:'SKIPPED',state:row.state,reason:'INELIGIBLE'};
  let key:string;try{key=execution.keyFor(p.keyVersionRef);}catch{throw conflict('LEGACY_REFUND_KEY_UNAVAILABLE');}
  const request=produceRefundRequest(profile,operation,binding,key),outbound=readRefundOutbound(request),attemptId=fresh('legacy_rfa');
  await client.query(`INSERT INTO zzsh_order.legacy_refund_attempt(id,intent_id,operation,lease_version,lease_owner,profile_id,profile_canonical,profile_sha256,
    key_version_ref,admission_sha256,request_body,request_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [attemptId,id,operation,updated.lease_version,owner,p.profileId,readRefundProfileEvidence(profile),p.profileSha256,p.keyVersionRef,admission.sha256,Buffer.from(outbound.body),request.requestSha256]);
  await recordAudit(client,{actorType:'system',actorId:'legacy-refund-worker',action:'order.legacy.refund.claimed',objectType:'legacy_refund_intent',objectId:id,
    requestId:attemptId,outcome:'SUCCESS',details:{operation,leaseVersion:updated.lease_version,requestSha256:request.requestSha256}});
  return {kind:'READY',prepared:{row,binding,profile,operation,attemptId,key,owner,version:updated.lease_version,request}};
 });
}

type VerifiedTerminal={terminal:'SUCCEEDED'|'FAILED_NO_EXECUTION';refundTransactionNo:string|null;completedAt:string|null;completedAtRaw:string|null};

/** Re-read and re-verify the channel bytes; saved status and evidence labels are not proof. */
async function inspectOriginal(client:PoolClient,execution:RefundSourceOptions,row:LegacyIntent,observationId:string):Promise<VerifiedTerminal|null>{
 const raw=(await client.query<any>(`SELECT operation,profile_id,profile_canonical,profile_sha256,key_version_ref,raw_body,raw_sha256,
   response_complete,http_status,transport_failure,evidence_level,event FROM zzsh_order.legacy_refund_observation WHERE id=$1 AND intent_id=$2`,[observationId,row.id])).rows[0];
 if(!raw || !['QUERY','NOTIFY'].includes(raw.operation) || raw.evidence_level!=='PROVIDER_RESPONSE' || raw.event==='STALE'
   || !raw.response_complete || raw.transport_failure!==null || (raw.operation==='QUERY'?raw.http_status!==200:raw.http_status!==null)
   || !raw.raw_body || !raw.raw_sha256 || sha(raw.raw_body)!==raw.raw_sha256 || sha(raw.profile_canonical)!==raw.profile_sha256)return null;
 const binding=wire(row),profile=execution.profileFor(raw.operation,Object.freeze({...binding}),
   Object.freeze({profileId:raw.profile_id,profileSha256:raw.profile_sha256,keyVersionRef:raw.key_version_ref}));
 const p=describeRefundProfile(profile,raw.operation);assertFormalRefundProfile(execution.admission,profile,raw.operation);
 if(p.profileId!==raw.profile_id || p.profileSha256!==raw.profile_sha256 || p.keyVersionRef!==raw.key_version_ref
   || readRefundProfileEvidence(profile)!==raw.profile_canonical)throw conflict('LEGACY_REFUND_EVIDENCE_PROFILE_CHANGED');
 let key:string;try{key=execution.keyFor(p.keyVersionRef);}catch{throw conflict('LEGACY_REFUND_KEY_UNAVAILABLE');}
 let body:string|Uint8Array=raw.raw_body;
 if(raw.operation==='NOTIFY'){try{body=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(raw.raw_body);}catch{return null;}}
 const result=inspectRefundProfile(profile,raw.operation,body,binding,key);
 if(result.signature!=='MATCH')return null;
 if(result.result==='CHANNEL_REPORTED_SUCCEEDED' && result.providerRefundTrxNo && result.completedAtRaw && refundWayAccepted(profile,result.refundWay))
  return {terminal:'SUCCEEDED',refundTransactionNo:result.providerRefundTrxNo,completedAt:refundCompleteTimeToUtc(profile,result.completedAtRaw),completedAtRaw:result.completedAtRaw};
 if(refundFailureMayRelease(profile,result))return {terminal:'FAILED_NO_EXECUTION',refundTransactionNo:result.providerRefundTrxNo??null,
  completedAt:result.completedAtRaw?refundCompleteTimeToUtc(profile,result.completedAtRaw):null,completedAtRaw:result.completedAtRaw??null};
 return null;
}

function terminalBody(row:LegacyIntent,observationId:string,verified:VerifiedTerminal){
 return {evidenceId:'legacy_refund_evidence_'+sha(JSON.stringify([row.id,observationId,verified.terminal])).slice(0,40),intentId:row.id,
  caseId:row.case_id,orderId:row.order_id,dutyId:row.duty_id,renterUserId:row.renter_user_id,merchantIdentityId:row.merchant_identity_id,
  merchantNo:row.merchant_no,originalPaymentOrderNo:row.original_payment_order_no,refundOrderNo:row.refund_order_no,
  amountCents:row.amount_cents,currency:'CNY',terminal:verified.terminal,refundTransactionNo:verified.refundTransactionNo,
  completedAt:verified.completedAt,financeEventId:verified.terminal==='SUCCEEDED'?'legacy_refund_paid_'+sha(row.id).slice(0,40):null,sourceObservationId:observationId};
}

async function verifyExistingTerminal(client:PoolClient,execution:RefundSourceOptions,row:LegacyIntent):Promise<VerifiedTerminal>{
 const proof=(await client.query<any>(`SELECT id,observation_id,terminal,refund_transaction_no,completed_at::text,finance_event_id,facts_canonical,facts_digest
  FROM zzsh_order.legacy_refund_terminal_evidence WHERE id=$1 AND intent_id=$2`,[row.terminal_evidence_id,row.id])).rows[0];
 if(!proof || sha(proof.facts_canonical)!==proof.facts_digest)throw conflict('LEGACY_REFUND_TERMINAL_UNVERIFIED');
 const original=await inspectOriginal(client,execution,row,proof.observation_id);if(!original)throw conflict('LEGACY_REFUND_TERMINAL_UNVERIFIED');
 const body=terminalBody(row,proof.observation_id,original),canonical=JSON.stringify(body);
 if(proof.id!==body.evidenceId || proof.facts_canonical!==canonical || proof.facts_digest!==sha(canonical)
  || proof.terminal!==body.terminal || proof.refund_transaction_no!==body.refundTransactionNo || proof.finance_event_id!==body.financeEventId
  || (proof.completed_at===null?null:new Date(proof.completed_at).toISOString())!==body.completedAt
  || row.state!==(body.terminal==='SUCCEEDED'?'SUCCEEDED':'FAILED') || row.terminal_event_id!==body.financeEventId
  || row.provider_refund_trx_no!==body.refundTransactionNo || (row.completed_at===null?null:new Date(row.completed_at).toISOString())!==body.completedAt)
  throw conflict('LEGACY_REFUND_TERMINAL_UNVERIFIED');
 const posted=(await client.query<any>(`SELECT e.kind,e.economic_root_id,e.subject_user_id,f.root_id,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('line',l.line_no,'account',l.account_code,'debit',l.debit_cents::text,'credit',l.credit_cents::text,
   'subject',l.counterparty_user_id,'details',l.details) ORDER BY l.line_no) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=e.id),'[]'::jsonb) lines
  FROM zzsh_order.legacy_duty_finance_fact f LEFT JOIN zzsh_order.finance_event e ON e.id=$2 WHERE f.duty_id=$1`,[row.duty_id,body.financeEventId])).rows[0];
 const details={legacyRefundIntentId:row.id,caseId:row.case_id,evidenceDigest:sha(canonical)};
 const expected=body.terminal==='SUCCEEDED'?[{line:1,account:'RENTER_REFUND_PAYABLE',debit:row.amount_cents,credit:'0',subject:row.renter_user_id,details},
  {line:2,account:'PAYOUT_CLEARING',debit:'0',credit:row.amount_cents,subject:null,details}]:[];
 if(!posted || canonicalize(posted.lines)!==canonicalize(expected) || (body.terminal==='SUCCEEDED'
  ? posted.kind!=='LEGACY_REFUND_PAID' || posted.economic_root_id!==posted.root_id || posted.subject_user_id!==row.renter_user_id
  : posted.kind!==null))throw conflict('LEGACY_REFUND_TERMINAL_UNVERIFIED');
 return original;
}

async function hasConflictingTerminal(client:PoolClient,execution:RefundSourceOptions,row:LegacyIntent,original:VerifiedTerminal){
 const observations=(await client.query<{id:string;signature_status:string;evidence_level:string}>(`SELECT id,signature_status,evidence_level FROM zzsh_order.legacy_refund_observation
   WHERE intent_id=$1 AND event='REVIEW' ORDER BY created_at,id LIMIT 101`,[row.id])).rows;
 if(observations.length>100)return true;
 for(const observation of observations){
  const other=await inspectOriginal(client,execution,row,observation.id);
  if(other?refundTerminalConflicts(original,other):observation.signature_status==='MATCH'&&observation.evidence_level==='PROVIDER_RESPONSE')return true;
 }
 return false;
}

async function verifyPredecessors(client:PoolClient,execution:LegacyRefundExecution,row:LegacyIntent){
 if(row.generation===1)return;
 const previous=(await client.query<LegacyIntent>(`SELECT ${columns} FROM zzsh_order.legacy_refund_intent i
  JOIN zzsh_order.legacy_refund_case x ON x.id=i.case_id WHERE i.case_id=$1 AND i.generation<$2 ORDER BY i.generation`,[row.case_id,row.generation])).rows;
 if(previous.length!==row.generation-1)throw conflict('LEGACY_REFUND_RETRY_CHAIN_INVALID');
 for(const prior of previous){
  if(prior.state!=='FAILED'||prior.budget_disposition!=='RELEASED'||prior.requires_review
    || (await verifyExistingTerminal(client,execution,prior)).terminal!=='FAILED_NO_EXECUTION')throw conflict('PREVIOUS_ATTEMPT_REVIEW');
 }
}

async function captureTerminal(client:PoolClient,execution:RefundSourceOptions,row:LegacyIntent,observationId:string):Promise<VerifiedTerminal|null>{
 const verified=await inspectOriginal(client,execution,row,observationId);if(!verified)return null;
 const body=terminalBody(row,observationId,verified),canonical=JSON.stringify(body),digest=sha(canonical);
 await client.query(`INSERT INTO zzsh_order.legacy_refund_terminal_evidence(id,intent_id,observation_id,terminal,merchant_no,refund_transaction_no,
  completed_at_raw,completed_at,finance_event_id,facts_canonical,facts_digest) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
  [body.evidenceId,row.id,observationId,body.terminal,row.merchant_no,body.refundTransactionNo,verified.completedAtRaw,body.completedAt,body.financeEventId,canonical,digest]);
 if(body.financeEventId){
  const basis=(await client.query<any>(`SELECT f.root_id,w.ledger_revision::text FROM zzsh_order.legacy_duty_finance_fact f
   JOIN zzsh_order.wallet_revision w ON w.user_id=$2 WHERE f.duty_id=$1`,[row.duty_id,row.renter_user_id])).rows[0];
  if(!basis)throw conflict('LEGACY_REFUND_LIABILITY_UNAVAILABLE');
  await client.query(`INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision)
   VALUES($1,$2,'LEGACY_REFUND_PAID',$3,$4)`,[body.financeEventId,basis.root_id,row.renter_user_id,basis.ledger_revision]);
  const details={legacyRefundIntentId:row.id,caseId:row.case_id,evidenceDigest:digest};
  await client.query(`INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details)
   VALUES($1,$3,1,'RENTER_REFUND_PAYABLE',$4,0,$5,$6),($2,$3,2,'PAYOUT_CLEARING',0,$4,NULL,$6)`,
   [body.financeEventId+'_1',body.financeEventId+'_2',body.financeEventId,row.amount_cents,row.renter_user_id,details]);
 }
 const changed=await client.query(`UPDATE zzsh_order.legacy_refund_intent SET state=$2,budget_disposition=$3,terminal_evidence_id=$4,terminal_event_id=$5,
  provider_refund_trx_no=$6,completed_at=$7,revision=revision+1 WHERE id=$1 AND revision=$8::bigint AND NOT requires_review`,
  [row.id,body.terminal==='SUCCEEDED'?'SUCCEEDED':'FAILED',body.terminal==='SUCCEEDED'?'CONSUMED':'RELEASED',body.evidenceId,
   body.financeEventId,body.refundTransactionNo,body.completedAt,row.revision]);
 if(changed.rowCount!==1)throw conflict('LEGACY_REFUND_TERMINAL_CONFLICT');
 return verified;
}

type Received={operation:RefundOperation;profile:BoundRefundProfile;key:string|null;attemptId:string|null;version:string|null;owner:string|null;exchange:RefundExchange};
type TerminalReview={actor:{userId:string;sessionId:string};requestId:string;reason:string;authorize:(client:PoolClient,id:string)=>Promise<void>};
const leaseChanged=Symbol('legacy refund lease changed');
async function recordReceived(client:PoolClient,execution:LegacyRefundExecution,id:string,received:Received,requestId:string,resolution?:TerminalReview){
 if(resolution)await resolution.authorize(client,id);
 const row=await lockContext(client,execution,id),basis=await readLegacyRefundCaseForExecution(client,row.order_id,row.duty_id,row.case_id,row.id);
 let predecessorReview=basis.chainReview;
 try{await verifyPredecessors(client,execution,row);}catch(error){
  if(!(error instanceof RefundAttemptCommitUnknown) && error instanceof Error && ('status' in error && [404,409,503].includes(Number((error as {status:unknown}).status))))predecessorReview=true;
  else throw error;
 }
 const binding=wire(row),p=describeRefundProfile(received.profile,received.operation);assertFormalRefundProfile(execution.admission,received.profile,received.operation);
 if(row.state==='READY')return {intentId:id,observationId:null,event:'NOT_DISPATCHED',terminal:null,ack:'fail' as const};
 const args=[id,received.version,received.owner],liveSql=`SELECT lease_version=$2::bigint AND lease_owner=$3 AND lease_until>clock_timestamp() AS current
  FROM zzsh_order.legacy_refund_intent WHERE id=$1`;
 const live=received.operation==='NOTIFY'||(await client.query(liveSql,args)).rows[0]?.current===true;
 async function persist(stale:boolean){
  let schema='NOT_CHECKED',signature='NOT_CHECKED',bound='NOT_CHECKED',next=row.state,event=stale?'STALE':'UNKNOWN',channelCode:string|null=null;
  let qualified=false,hardConflict=!stale&&predecessorReview,incoming:VerifiedTerminal|null=null;
  const e=received.exchange;
  if(!stale && e.responseComplete && e.failure===null && e.body!==null && received.key!==null){
   let raw:string|Uint8Array=e.body;
   if(received.operation==='NOTIFY'){try{raw=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(e.body);}catch{raw='';}}
   const d=inspectRefundProfile(received.profile,received.operation,raw,binding,received.key);
   signature=d.signature;schema=signature==='NOT_CHECKED'?'INVALID':'VALID';channelCode=d.channelCode??null;
   bound=signature!=='MATCH'?'NOT_CHECKED':['BINDING_MISMATCH','REFUND_TRANSACTION_MISMATCH'].includes(d.reason??'')?'MISMATCH':'MATCH';
   if(d.result==='CHANNEL_REPORTED_SUCCEEDED' && d.providerRefundTrxNo && d.completedAtRaw && refundWayAccepted(received.profile,d.refundWay))
    incoming={terminal:'SUCCEEDED',refundTransactionNo:d.providerRefundTrxNo,completedAt:refundCompleteTimeToUtc(received.profile,d.completedAtRaw),completedAtRaw:d.completedAtRaw};
   else if(refundFailureMayRelease(received.profile,d))incoming={terminal:'FAILED_NO_EXECUTION',refundTransactionNo:d.providerRefundTrxNo??null,
    completedAt:d.completedAtRaw?refundCompleteTimeToUtc(received.profile,d.completedAtRaw):null,completedAtRaw:d.completedAtRaw??null};
   qualified=!!incoming && signature==='MATCH' && bound==='MATCH' && e.evidenceLevel==='PROVIDER_RESPONSE'
    && (received.operation==='NOTIFY' && e.httpStatus===null || received.operation==='QUERY' && e.httpStatus===200);
   hardConflict ||= signature==='MATCH' && d.result==='REVIEW_REQUIRED';
   if(row.terminal_evidence_id && qualified && incoming){
    const original=await verifyExistingTerminal(client,execution,row);
    hardConflict ||= refundTerminalConflicts(original,incoming);
   }
   if(signature==='MATCH' && bound==='MATCH' && d.providerRefundTrxNo){
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-transaction:v1','JOINPAY',$1::text,$2::text)::text,0))`,[row.merchant_identity_id,d.providerRefundTrxNo]);
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:refund-merchant-trx:v1',$1::text,$2::text)::text,0))`,[row.merchant_no,d.providerRefundTrxNo]);
    const duplicate=(await client.query(`SELECT 1 FROM zzsh_order.channel_refund_intent WHERE payment_source='JOINPAY' AND wire_merchant_no=$1 AND provider_refund_trx_no=$2
     UNION ALL SELECT 1 FROM zzsh_order.legacy_refund_terminal_evidence WHERE merchant_no=$1 AND refund_transaction_no=$2 AND intent_id<>$3 LIMIT 1`,
     [row.merchant_no,d.providerRefundTrxNo,row.id])).rowCount;
    if(duplicate)hardConflict=true;
   }
   if(hardConflict || row.requires_review && qualified)event='REVIEW';
   else if(qualified)event=row.terminal_evidence_id?'TERMINAL':'PENDING_TERMINAL';
   else if(signature==='MATCH' && bound==='MATCH' && !['SUCCEEDED','FAILED'].includes(row.state)){
    next=d.result==='PROCESSING'||d.result==='APPLICATION_ACCEPTED'?'PROCESSING':'UNKNOWN';event=next;
   }
  }else if(!stale && e.responseComplete && e.failure===null && e.body!==null && received.key===null)schema='INVALID';
  else if(!stale && received.operation!=='NOTIFY' && !['SUCCEEDED','FAILED'].includes(row.state))next='UNKNOWN';
  if(hardConflict){event='REVIEW';next=row.state;}
  const observationId=fresh('legacy_rfo');
  await client.query(`INSERT INTO zzsh_order.legacy_refund_observation(id,intent_id,attempt_id,operation,lease_version,lease_owner,profile_id,profile_canonical,profile_sha256,key_version_ref,
   raw_body,raw_sha256,response_complete,http_status,received_bytes,transport_failure,event,schema_status,signature_status,binding_status,channel_code,evidence_level,state_before,state_after,request_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25)`,
   [observationId,id,received.attemptId,received.operation,received.version,received.owner,p.profileId,readRefundProfileEvidence(received.profile),p.profileSha256,p.keyVersionRef,
    e.body===null?null:Buffer.from(e.body),e.body===null?null:sha(e.body),e.responseComplete,e.httpStatus,e.receivedBytes,e.failure,event,schema,signature,bound,channelCode,e.evidenceLevel,row.state,next,requestId]);
  if(hardConflict && !row.requires_review)await client.query(`UPDATE zzsh_order.legacy_refund_intent SET requires_review=true,revision=revision+1 WHERE id=$1 AND NOT requires_review`,[id]);
  if(next!==row.state){
   const changed=await client.query(`UPDATE zzsh_order.legacy_refund_intent SET state=$2,revision=revision+1 WHERE id=$1 AND state=$3 AND revision=$4::bigint
    AND ($5::boolean OR (lease_version=$6::bigint AND lease_owner=$7 AND lease_until>clock_timestamp()))`,[id,next,row.state,row.revision,received.operation==='NOTIFY',received.version,received.owner]);
   if(changed.rowCount!==1)throw Object.assign(conflict('LEGACY_REFUND_LEASE_CHANGED'),{[leaseChanged]:true});
  }
  let terminal:VerifiedTerminal|null=null,resolved=false;
  if(resolution&&qualified&&!hardConflict&&row.requires_review&&row.terminal_evidence_id&&received.operation==='QUERY'){
   const original=await verifyExistingTerminal(client,execution,row),checked=await inspectOriginal(client,execution,row,observationId);
   if(checked&&!refundTerminalConflicts(original,checked)&&!await hasConflictingTerminal(client,execution,row,original)){
    await setAuditContext(client,'admin',resolution.actor.userId,resolution.actor.sessionId,resolution.requestId);
    const result=(await client.query<{result:{intentId:string;resolved:boolean}}>(`SELECT zzsh_order.resolve_legacy_refund_terminal($1,$2,$3) AS result`,
      [id,observationId,resolution.reason.trim()])).rows[0]?.result;
    if(!result||result.intentId!==id||result.resolved!==true)throw conflict('LEGACY_REFUND_REVIEW_UNAVAILABLE');
    terminal=original;resolved=true;
   }
  }
  if(qualified && !hardConflict && !row.requires_review)terminal=row.terminal_evidence_id?await verifyExistingTerminal(client,execution,row):await captureTerminal(client,execution,row,observationId);
  await recordAudit(client,{actorType:'system',actorId:'legacy-refund-worker',action:'order.legacy.refund.observed',objectType:'legacy_refund_intent',objectId:id,
   requestId,outcome:'SUCCESS',details:{observationId,operation:received.operation,event,evidenceLevel:e.evidenceLevel,terminal:terminal?.terminal??null,rawSha256:e.body===null?null:sha(e.body)}});
  return {intentId:id,observationId,event:resolved?'REVIEW_RESOLVED':event,terminal,ack:terminal?'success' as const:'fail' as const};
 }
 if(!live)return persist(true);
 await client.query('SAVEPOINT legacy_refund_result');
 try{const result=await persist(false);await client.query('RELEASE SAVEPOINT legacy_refund_result');return result;}
 catch(error){
  const e=error as {code?:string;constraint?:string;[leaseChanged]?:boolean};
  if(received.operation==='NOTIFY'||!(e[leaseChanged]===true||e.code==='23514'&&e.constraint==='legacy_refund_live_lease'))throw error;
  await client.query('ROLLBACK TO SAVEPOINT legacy_refund_result');
  if((await client.query(liveSql,args)).rows[0]?.current!==false)throw error;
  const result=await persist(true);await client.query('RELEASE SAVEPOINT legacy_refund_result');return result;
 }
}

/** Internal projection; the caller must first authorize the administrator and order. */
export async function readLegacyRefundProgress(client:PoolClient,execution:LegacyRefundExecution,id:string){
 const row=await lockContext(client,execution,id),basis=await readLegacyRefundCaseForExecution(client,row.order_id,row.duty_id,row.case_id,row.id);
 let predecessorReview=basis.chainReview;
 try{await verifyPredecessors(client,execution,row);}catch(error){
  if(error instanceof Error&&'status' in error&&[404,409,503].includes(Number((error as {status:unknown}).status)))predecessorReview=true;else throw error;
 }
 let terminal:VerifiedTerminal|null=null;
 if(row.terminal_evidence_id)terminal=await verifyExistingTerminal(client,execution,row);
 return {intentId:row.id,caseId:row.case_id,orderId:row.order_id,dutyId:row.duty_id,refundOrderNo:row.refund_order_no,amountCents:row.amount_cents,
  state:row.requires_review||predecessorReview?'REVIEW_REQUIRED':row.state,terminal:terminal?.terminal??null,completedAt:terminal?.completedAt??null,bankArrival:'UNKNOWN' as const};
}

/** An authorized operator may resume queries of the same dispatched refund; this never sends a new refund. */
export async function resumeLegacyRefundReview(execution:LegacyRefundExecution,id:string,actor:{userId:string;sessionId:string},requestId:string,reason:string,
  authorize:(client:PoolClient,id:string)=>Promise<void>){
 if(![id,actor?.userId,actor?.sessionId,requestId].every(value=>typeof value==='string'&&ID.test(value))
   || typeof reason!=='string'||reason.trim().length<3||reason.length>200||/[\u0000-\u001f\u007f]/.test(reason)||typeof authorize!=='function')throw invalid('Invalid legacy refund review');
 return confirmed(execution.pool,id,'RESULT',async client=>{
  await authorize(client,id);await setAuditContext(client,'admin',actor.userId,actor.sessionId,requestId);
  const row=await lockContext(client,execution,id),basis=await readLegacyRefundCaseForExecution(client,row.order_id,row.duty_id,row.case_id,row.id);
  if(basis.chainReview)throw conflict('PREVIOUS_ATTEMPT_REVIEW');
  await verifyPredecessors(client,execution,row);
  let value:{intentId:string;resumed:boolean;state:string;resolutionId:string}|undefined;
  try{value=(await client.query<{result:{intentId:string;resumed:boolean;state:string;resolutionId:string}}>(
   `SELECT zzsh_order.resume_legacy_refund_review($1,$2) AS result`,[id,reason.trim()])).rows[0]?.result;}
  catch(error){const code=(error as {code?:string}).code;if(code==='42501')throw forbidden();if(code==='23514'||code==='40001')throw conflict('LEGACY_REFUND_REVIEW_BLOCKED');throw error;}
  if(!value || value.intentId!==id || typeof value.resumed!=='boolean' || typeof value.resolutionId!=='string' || !ID.test(value.resolutionId)
    || value.resumed && value.state!=='UNKNOWN')throw conflict('LEGACY_REFUND_REVIEW_UNAVAILABLE');
  return value;
 });
}

/** A verified no-execution failure may create one new, traceable original-payment attempt. */
export async function retryLegacyRefund(execution:LegacyRefundExecution,id:string,actor:{userId:string;sessionId:string},requestId:string,
  input:{previouslyRefundedCents:string;noUnresolvedRefunds:boolean;reason:string},authorize:(client:PoolClient,id:string)=>Promise<void>){
 if(![id,actor?.userId,actor?.sessionId,requestId].every(value=>typeof value==='string'&&ID.test(value))||!input
  || typeof input.previouslyRefundedCents!=='string'||!/^(0|[1-9]\d{0,23})$/.test(input.previouslyRefundedCents)||input.noUnresolvedRefunds!==true
  || typeof input.reason!=='string'||input.reason.trim().length<3||input.reason.length>200||/[\u0000-\u001f\u007f]/.test(input.reason)||typeof authorize!=='function')throw invalid('Invalid legacy refund retry');
 return confirmed(execution.pool,id,'RESULT',async client=>{
  await authorize(client,id);await setAuditContext(client,'admin',actor.userId,actor.sessionId,requestId);
  if(!execution.legacyRefundsEnabled)throw conflict('NEW_REFUND_DISABLED');
  await assertRefundResource(client,execution.admission);
  const hint=(await client.query<LegacyIntent>(`SELECT ${columns} FROM zzsh_order.legacy_refund_intent i JOIN zzsh_order.legacy_refund_case x ON x.id=i.case_id WHERE i.id=$1`,[id])).rows[0];
  if(!hint||!Number.isSafeInteger(hint.generation)||hint.generation<1||hint.generation>=2147483647)throw notFound();
  const suffix=sha(hint.case_id+':retry:'+(hint.generation+1)),nextId='legacy_refund_intent_'+suffix.slice(0,40),nextNo='LR'+suffix.slice(0,28);
  const priorNumbers=(await client.query<{refund_order_no:string}>(`SELECT refund_order_no FROM zzsh_order.legacy_refund_intent WHERE case_id=$1 ORDER BY refund_order_no COLLATE "C"`,[hint.case_id])).rows.map(value=>value.refund_order_no);
  await lockRefundOrderNos(client,hint.merchant_identity_id,[hint.original_payment_order_no,...priorNumbers,nextNo]);
  const row=await lockContext(client,execution,id),basis=await readLegacyRefundCaseForExecution(client,row.order_id,row.duty_id,row.case_id,row.id);
  if(row.generation!==hint.generation||row.case_id!==hint.case_id||basis.chainReview||row.requires_review||row.state!=='FAILED'||row.budget_disposition!=='RELEASED'
    || basis.row.previously_refunded_cents!==input.previouslyRefundedCents)throw conflict('LEGACY_REFUND_RETRY_BLOCKED');
  await verifyPredecessors(client,execution,row);
  const previous=await verifyExistingTerminal(client,execution,row);
  if(previous.terminal!=='FAILED_NO_EXECUTION'||await hasNativeOriginalOrderNo(client,row.original_payment_order_no))throw conflict('LEGACY_REFUND_RETRY_BLOCKED');
  assertRefundStart(execution.admission);const binding={...wire(row),refundOrderNo:nextNo},profile=execution.profileFor('SUBMIT',Object.freeze({...binding}));
  assertFormalRefundProfile(execution.admission,profile,'SUBMIT');assertRefundBinding(profile,'SUBMIT',binding);
  let result:{intentId:string;refundOrderNo:string;state:string;created:boolean}|undefined;
  try{result=(await client.query<{result:{intentId:string;refundOrderNo:string;state:string;created:boolean}}>(
    `SELECT zzsh_order.retry_legacy_refund($1,$2,$3) AS result`,[id,input.previouslyRefundedCents,input.reason.trim()])).rows[0]?.result;}
  catch(error){const code=(error as {code?:string}).code;if(code==='42501')throw forbidden();if(code==='23514'||code==='23505'||code==='40001')throw conflict('LEGACY_REFUND_RETRY_BLOCKED');throw error;}
  if(!result||result.intentId!==nextId||result.refundOrderNo!==nextNo||typeof result.created!=='boolean'||typeof result.state!=='string')throw conflict('LEGACY_REFUND_RETRY_MISMATCH');
  const created=await readLegacyRefundCaseForExecution(client,row.order_id,row.duty_id,row.case_id,nextId);
  if(created.chainReview||created.row.intent_amount!==row.amount_cents)throw conflict('LEGACY_REFUND_RETRY_MISMATCH');
  return result;
 });
}

/** Re-query a disputed terminal; clear review only if fresh signed evidence exactly matches the original. */
export async function resolveLegacyRefundTerminal(execution:LegacyRefundExecution,id:string,actor:{userId:string;sessionId:string},requestId:string,
  reason:string,owner:string,authorize:(client:PoolClient,id:string)=>Promise<void>){
 if(![id,actor?.userId,actor?.sessionId,requestId,owner].every(value=>typeof value==='string'&&ID.test(value))
   || typeof reason!=='string'||reason.trim().length<3||reason.length>200||/[\u0000-\u001f\u007f]/.test(reason)||typeof authorize!=='function')throw invalid('Invalid terminal review');
 const claim=await prepareLegacyRefund(execution,id,owner,{queryOnly:true,terminalReview:true,minimumIntervalSeconds:30,authorize});
 if(claim.kind!=='READY')return {...claim,intentId:id};
 const p=claim.prepared,exchange=await exchangeRefundRequest(p.request,{fetch:execution.fetch});
 const result=await confirmed(execution.pool,id,'RESULT',client=>recordReceived(client,execution,id,
  {operation:p.operation,profile:p.profile,key:p.key,attemptId:p.attemptId,version:p.version,owner:p.owner,exchange},p.attemptId,
  {actor,requestId,reason,authorize}));
 return {kind:'OBSERVED' as const,...result};
}

export async function executeLegacyRefund(execution:LegacyRefundExecution,id:string,owner:string,options:{queryOnly?:boolean;minimumIntervalSeconds?:number;authorize?:(client:PoolClient,id:string)=>Promise<void>}={}){
 if(!ID.test(id)||!ID.test(owner))throw invalid('Invalid legacy refund request');
 const claim=await prepareLegacyRefund(execution,id,owner,options);
 if(claim.kind!=='READY')return {...claim,intentId:id};
 const p=claim.prepared,exchange=await exchangeRefundRequest(p.request,{fetch:execution.fetch});
 const result=await confirmed(execution.pool,id,'RESULT',client=>recordReceived(client,execution,id,
  {operation:p.operation,profile:p.profile,key:p.key,attemptId:p.attemptId,version:p.version,owner:p.owner,exchange},p.attemptId));
 return {kind:'OBSERVED' as const,...result};
}

/** Notification only accepts a known original intent and rechecks its signature and binding. */
export async function receiveLegacyRefundNotification(execution:LegacyRefundExecution,id:string,raw:string,requestId:string){
 if(!ID.test(id)||!ID.test(requestId)||typeof raw!=='string'||Buffer.byteLength(raw)>65536||/\p{Cs}/u.test(raw))throw invalid('Invalid legacy refund notification');
 return confirmed(execution.pool,id,'RESULT',async client=>{
  const row=await lockContext(client,execution,id),binding=wire(row);
  const profile=execution.profileFor('NOTIFY',Object.freeze({...binding})),p=describeRefundProfile(profile,'NOTIFY');assertFormalRefundProfile(execution.admission,profile,'NOTIFY');
  let key:string|null=null;
  if(preflightJoinpayRefundResponse('REFUND_NOTIFY',raw).ok){try{key=execution.keyFor(p.keyVersionRef);}catch{throw conflict('LEGACY_REFUND_KEY_UNAVAILABLE');}}
  return recordReceived(client,execution,id,{operation:'NOTIFY',profile,key,attemptId:null,version:null,owner:null,
   exchange:Object.freeze({body:Buffer.from(raw),responseComplete:true,receivedBytes:Buffer.byteLength(raw),httpStatus:null,failure:null,evidenceLevel:'PROVIDER_RESPONSE'})},requestId);
 });
}
