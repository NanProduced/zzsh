import {createHash,randomUUID} from "node:crypto";
import type {Pool,PoolClient} from "pg";
import {recordAudit,withTransaction} from "../auth/security-core";
import {conflict,invalid} from "../supply/supply-util";
import {acceptNativeWithdrawalTerminalInTransaction,assertNativePayoutResource,assertNativePayoutExecutionReady,assertNativeWithdrawalExecution,lockNativeWithdrawal,nativePayoutBinding,NATIVE_WITHDRAWAL_COLUMNS,
 type NativeWithdrawalOptions,type NativeWithdrawalRow} from "./native-withdrawal-store";
import {assertPayoutProfile,assertPayoutSubmitBinding,describePayoutProfile,eligiblePayoutTerminal,inspectPayoutProfile,preflightPayoutProfile,payoutAcknowledgement,producePayoutRequest,readPayoutOutbound,readPayoutProfileEvidence,readPayoutScope,PayoutProfileError,
 type BoundPayoutProfile,type PayoutBinding,type PayoutOutbound,type PayoutProfileOperation} from "./joinpay-payout-profile";
import {reduceJoinpayPayoutObservation} from "./joinpay-payout-state";
import {capturePayoutFact,type PayoutSourceOptions} from "./joinpay-payout-source";
const sha=(v:string|Uint8Array)=>createHash("sha256").update(v).digest("hex"),ID=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/,fresh=(p:string)=>`${p}_${randomUUID().replaceAll("-","")}`,expiredLease=Symbol("native payout expired lease");
export const JOINPAY_PAYOUT_MAX_AUTOMATIC_QUERIES=10;
export class PayoutCommitUnknown extends Error{readonly code="PAYOUT_EXECUTION_UNKNOWN";constructor(readonly intentId:string,readonly phase:"CLAIM"|"RESULT"){super("Recover the original payout; do not resubmit");}}
async function confirmed<T>(pool:Pool,id:string,phase:"CLAIM"|"RESULT",callback:(c:PoolClient)=>Promise<T>){let done=false;try{return await withTransaction(pool,async c=>{const v=await callback(c);done=true;return v;});}catch(e){if(done)throw new PayoutCommitUnknown(id,phase);throw e;}}
export type PayoutExecution=PayoutSourceOptions&NativeWithdrawalOptions&{pool:Pool;fetch?:typeof globalThis.fetch};
export type PayoutQuerySkipReason="TERMINAL"|"PENDING_ACCEPTANCE"|"REVIEW_REQUIRED"|"ACTIVE_LEASE"|"THROTTLED"|"BUDGET_EXHAUSTED"|"OUTSIDE_QUERY_WINDOW"|"INELIGIBLE";
export type PayoutQueryOptions=Readonly<{minimumIntervalSeconds:number;authorize?:(client:PoolClient,intentId:string)=>Promise<void>}>;
export type PayoutQueryOutcome=
 |Readonly<{kind:"NOT_DISPATCHED";intentId:string;state:NativeWithdrawalRow["state"]}>
 |Readonly<{kind:"SKIPPED";intentId:string;state:NativeWithdrawalRow["state"];reason:PayoutQuerySkipReason}>
 |Readonly<{kind:"OBSERVED";intentId:string;observationId:string;event:string;terminal:Awaited<ReturnType<typeof acceptNativeWithdrawalTerminalInTransaction>>|null;accepted:boolean;receiptAccepted:boolean}>;
export type PayoutExchange=Readonly<{body:Uint8Array|null;responseComplete:boolean;receivedBytes:number;httpStatus:number|null;failure:"TIMEOUT"|"ABORTED"|"BODY_TOO_LARGE"|"HTTP_STATUS"|"NETWORK_ERROR"|null;evidenceLevel:"PROVIDER_RESPONSE"|"SYNTHETIC_PROTOCOL"}>;
/** 本代付产品单次标准fetch；合成目的永不发送，有界原件不重编码/重试。 */
export async function exchangePayoutRequest(request:PayoutOutbound,dependencies:{fetch?:typeof globalThis.fetch;signal?:AbortSignal}={}):Promise<PayoutExchange>{
 const wire=readPayoutOutbound(request);if(wire.purpose==="SYNTHETIC_PROTOCOL")throw new PayoutProfileError("PAYOUT_SYNTHETIC_TRANSPORT_FORBIDDEN");
 const supplied=dependencies.fetch,signal=dependencies.signal,fetcher=supplied??globalThis.fetch,controller=new AbortController(),chunks:Uint8Array[]=[],deadline=performance.now()+8000;
 let bytes=0,kept=0,status:number|null=null,complete=false,failure:PayoutExchange["failure"]=null,timeout=false,reader:ReadableStreamDefaultReader<Uint8Array>|undefined;
 const abort=()=>controller.abort(),cancel=()=>{if(reader)void reader.cancel().catch(()=>{});};if(signal?.aborted)abort();else signal?.addEventListener("abort",abort,{once:true});controller.signal.addEventListener("abort",cancel,{once:true});
 const expired=()=>{if(performance.now()>=deadline){timeout=true;controller.abort();}return controller.signal.aborted;},timer=setTimeout(()=>{timeout=true;controller.abort();},8000);let listener:(()=>void)|undefined;
 const interrupted=new Promise<void>(resolve=>{listener=()=>{failure=timeout?"TIMEOUT":"ABORTED";resolve();};if(controller.signal.aborted)listener();else controller.signal.addEventListener("abort",listener,{once:true});});
 async function once(){if(expired())return;try{
  const r=await fetcher(wire.endpoint,{method:"POST",body:wire.body,headers:{"content-type":"application/json; charset=UTF-8",accept:"application/json"},redirect:"error",credentials:"omit",referrerPolicy:"no-referrer",signal:controller.signal});status=r.status;
  if(expired()){void r.body?.cancel().catch(()=>{});return;}const len=r.headers.get("content-length");if(len&&/^\d+$/.test(len)&&BigInt(len)>65536n){failure="BODY_TOO_LARGE";void r.body?.cancel().catch(()=>{});return;}
  if(r.body){reader=r.body.getReader();for(;;){const n=await reader.read();if(expired())return;if(n.done)break;if(!(n.value instanceof Uint8Array)){failure="NETWORK_ERROR";cancel();return;}bytes+=n.value.byteLength;const part=new Uint8Array(n.value.subarray(0,65536-kept));if(part.length){chunks.push(part);kept+=part.length;}if(bytes>65536){failure="BODY_TOO_LARGE";cancel();return;}}}
  complete=true;if(status!==200)failure="HTTP_STATUS";
 }catch{if(!controller.signal.aborted)failure="NETWORK_ERROR";}}
 try{await Promise.race([once(),interrupted]);if(expired()){failure=timeout?"TIMEOUT":"ABORTED";complete=false;}}
 finally{clearTimeout(timer);signal?.removeEventListener("abort",abort);controller.signal.removeEventListener("abort",cancel);if(listener)controller.signal.removeEventListener("abort",listener);}
 return Object.freeze({body:complete||kept?Buffer.concat(chunks):null,responseComplete:complete,receivedBytes:bytes,httpStatus:status,failure,evidenceLevel:supplied===undefined?"PROVIDER_RESPONSE":"SYNTHETIC_PROTOCOL"});
}
type Prepared={row:NativeWithdrawalRow;binding:PayoutBinding;profile:BoundPayoutProfile;operation:"SUBMIT"|"QUERY";attemptId:string;key:string;request:PayoutOutbound;owner:string;version:string};
type PrepareResult={kind:"READY";prepared:Prepared}|{kind:"NOT_DISPATCHED";state:NativeWithdrawalRow["state"]}|{kind:"SKIPPED";state:NativeWithdrawalRow["state"];reason:PayoutQuerySkipReason};
async function prepare(o:PayoutExecution,id:string,owner:string,minimumIntervalSeconds?:number,queryOnly=false,
 authorize?:(client:PoolClient,intentId:string)=>Promise<void>):Promise<PrepareResult>{return confirmed(o.pool,id,"CLAIM",async c=>{
 if(authorize)await authorize(c,id);
 const{row}=await lockNativeWithdrawal(c,o.scope,id),state=row.state;
 if(["SUCCEEDED","FAILED"].includes(state))return{kind:"SKIPPED",state,reason:"TERMINAL"};
 if(queryOnly&&row.requires_review)return{kind:"SKIPPED",state,reason:"REVIEW_REQUIRED"};
 if(queryOnly&&state==="CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE")return{kind:"SKIPPED",state,reason:"PENDING_ACCEPTANCE"};
 await assertNativePayoutExecutionReady(c);
 let withinQueryWindow=true;
 if(queryOnly){const timing=(await c.query(`SELECT COALESCE(lease_until>clock_timestamp(),false) AS active,
   COALESCE((SELECT min(a.created_at) FROM zzsh_order.joinpay_payout_attempt a WHERE a.intent_id=$1 AND a.operation='SUBMIT'),accepted_at)
     >clock_timestamp()-interval '15 days' AS within_window
   FROM zzsh_order.joinpay_withdrawal_intent WHERE id=$1`,[id])).rows[0];
  if(typeof timing?.active!=="boolean"||typeof timing?.within_window!=="boolean")throw conflict("Payout timing evidence unavailable");
  if(timing.active)return{kind:"SKIPPED",state,reason:"ACTIVE_LEASE"};withinQueryWindow=timing.within_window;}
 const dispatched=queryOnly?(await c.query(`SELECT EXISTS(SELECT 1 FROM zzsh_order.joinpay_payout_attempt WHERE intent_id=$1 AND operation='SUBMIT') AS dispatched`,[id])).rows[0]?.dispatched:false;
 if(typeof dispatched!=="boolean")throw conflict("Payout attempt evidence unavailable");
 const operation=state==="RESERVED"&&row.lease_version==="0"&&!dispatched?"SUBMIT":"QUERY";
 if(queryOnly&&row.funds_disposition!=="RESERVED")return{kind:"SKIPPED",state,reason:"INELIGIBLE"};
 if(queryOnly&&!dispatched)return{kind:"NOT_DISPATCHED",state};
 if(queryOnly&&!withinQueryWindow)return{kind:"SKIPPED",state,reason:"OUTSIDE_QUERY_WINDOW"};
 // 原意图行锁内重核；到达本地补查预算只保留未知，不核销/释放或换号重发。
 if(minimumIntervalSeconds!==undefined){
  if(!queryOnly){const due=(await c.query(`SELECT count(*) FILTER(WHERE operation='QUERY')<$3::integer
    AND COALESCE(max(created_at)<=clock_timestamp()-make_interval(secs=>$2::integer),true) AS allowed
    FROM zzsh_order.joinpay_payout_attempt WHERE intent_id=$1`,[id,minimumIntervalSeconds,JOINPAY_PAYOUT_MAX_AUTOMATIC_QUERIES])).rows[0]?.allowed;
   if(typeof due!=="boolean")throw conflict("Payout recovery timing evidence unavailable");if(!due)return{kind:"SKIPPED",state,reason:"THROTTLED"};}
  else{const recovery=(await c.query(`SELECT count(*) FILTER(WHERE operation='QUERY')::text AS queries,
    COALESCE(max(created_at)<=clock_timestamp()-make_interval(secs=>$2::integer),true) AS interval_ok
    FROM zzsh_order.joinpay_payout_attempt WHERE intent_id=$1`,[id,minimumIntervalSeconds])).rows[0];
   if(typeof recovery?.queries!=="string"||!/^\d+$/.test(recovery.queries)||typeof recovery?.interval_ok!=="boolean")throw conflict("Payout recovery timing evidence unavailable");
   if(BigInt(recovery.queries)>=BigInt(JOINPAY_PAYOUT_MAX_AUTOMATIC_QUERIES))return{kind:"SKIPPED",state,reason:"BUDGET_EXHAUSTED"};
   if(!recovery.interval_ok)return{kind:"SKIPPED",state,reason:"THROTTLED"};}
 }
 const binding=nativePayoutBinding(row,o.scope),profile=o.profileFor(operation,Object.freeze({...binding})),p=describePayoutProfile(profile,operation);assertPayoutProfile(o.scope,profile,operation);
 if(operation==="SUBMIT"){if(row.requires_review)return{kind:"SKIPPED",state,reason:"REVIEW_REQUIRED"};await assertNativeWithdrawalExecution(c,row,{...o,initialProfile:profile});}
 const updated=(await c.query<NativeWithdrawalRow>(`UPDATE zzsh_order.joinpay_withdrawal_intent SET state=CASE WHEN state='RESERVED' THEN 'SUBMITTING' WHEN state='SUBMITTING' THEN 'UNKNOWN' ELSE state END,
  lease_version=lease_version+1,lease_owner=$2,lease_until=clock_timestamp()+interval '30 seconds',operation_version=operation_version+1
  WHERE id=$1 AND funds_disposition='RESERVED' AND state NOT IN ('SUCCEEDED','FAILED') AND (lease_until IS NULL OR lease_until<=clock_timestamp()) AND ($3='QUERY' OR NOT requires_review) RETURNING ${NATIVE_WITHDRAWAL_COLUMNS}`,[id,owner,operation])).rows[0];if(!updated)return{kind:"SKIPPED",state,reason:"INELIGIBLE"};
 const clock=(await c.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS now`)).rows[0]?.now;
 if(operation==="SUBMIT")assertPayoutSubmitBinding(profile,binding,clock);
 let key:string;try{key=o.keyFor(p.keyVersionRef);}catch{throw new PayoutProfileError("PAYOUT_KEY_UNAVAILABLE");}
 const request=producePayoutRequest(profile,operation,binding,key,clock),wire=readPayoutOutbound(request),attemptId=fresh("pwa"),scope=readPayoutScope(o.scope);
 await c.query(`INSERT INTO zzsh_order.joinpay_payout_attempt(id,intent_id,operation,lease_version,lease_owner,profile_id,profile_canonical,profile_sha256,key_version_ref,scope_sha256,scope_canonical,request_body,request_sha256) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,[attemptId,id,operation,updated.lease_version,owner,p.profileId,readPayoutProfileEvidence(profile),p.profileSha256,p.keyVersionRef,scope.sha256,scope.canonical,Buffer.from(wire.body),request.requestSha256]);
 await recordAudit(c,{actorType:"system",action:"joinpay.payout.claimed",objectType:"joinpay_withdrawal_intent",objectId:id,outcome:"SUCCESS",requestId:attemptId,details:{attemptId,leaseVersion:updated.lease_version,operation,profileSha256:p.profileSha256,requestSha256:request.requestSha256}});
 return{kind:"READY",prepared:{row:updated,binding,profile,operation,attemptId,key,request,owner,version:updated.lease_version}};
});}
type Received={operation:PayoutProfileOperation;profile:BoundPayoutProfile;key:string|null;attemptId:string|null;version:string|null;owner:string|null;exchange:PayoutExchange};
async function recordReceived(c:PoolClient,o:PayoutSourceOptions,id:string,r:Received,requestId:string){
 const{row}=await lockNativeWithdrawal(c,o.scope,id),binding=nativePayoutBinding(row,o.scope),p=describePayoutProfile(r.profile,r.operation);assertPayoutProfile(o.scope,r.profile,r.operation);
 const liveSql=`SELECT lease_version=$2::bigint AND lease_owner=$3 AND lease_until>clock_timestamp() AS current FROM zzsh_order.joinpay_withdrawal_intent WHERE id=$1`,args=[id,r.version,r.owner],live=r.operation==="NOTIFY"||(await c.query(liveSql,args)).rows[0]?.current===true;
 async function persist(stale:boolean){
  let schema="NOT_CHECKED",signature="NOT_CHECKED",bound="NOT_CHECKED",next=row.state,event=stale?"STALE":"UNKNOWN",qualified=false,hardConflict=false,serial=row.platform_serial_no,receiptCandidate=false,terminalRequired=false;
  const e=r.exchange,real=e.evidenceLevel==="PROVIDER_RESPONSE";
  if(!stale&&e.responseComplete&&e.failure===null&&e.body!==null&&r.key!==null){const d=inspectPayoutProfile(r.profile,r.operation,e.body,binding,r.key);signature=d.signature;schema=signature==="NOT_CHECKED"?"INVALID":"VALID";bound=d.binding;
   if(real){const terminal=eligiblePayoutTerminal(r.profile,d);qualified=terminal!==null;
    const verified=signature==="MATCH"&&bound==="MATCH";receiptCandidate=verified&&["PROCESSING","CHANNEL_REPORTED_SUCCEEDED","CHANNEL_REPORTED_FAILED"].includes(d.decision);terminalRequired=qualified||d.decision==="CHANNEL_REPORTED_SUCCEEDED";
    if(receiptCandidate&&d.platformSerialNo){await c.query(`SELECT pg_advisory_xact_lock(hashtextextended(jsonb_build_array('zzsh:joinpay-payout-serial:v1',$1::text,$2::text)::text,0))`,[row.merchant_identity_id,d.platformSerialNo]);
     const other=(await c.query(`SELECT id FROM zzsh_order.joinpay_withdrawal_intent WHERE merchant_identity_id=$1 AND platform_serial_no=$2 AND id<>$3`,[row.merchant_identity_id,d.platformSerialNo,row.id])).rows[0];if(other||serial!==null&&serial!==d.platformSerialNo)hardConflict=true;
     else if(!row.requires_review)serial=d.platformSerialNo;
    }
    const projected=reduceJoinpayPayoutObservation({phase:row.state==="RESERVED"?"SUBMITTING":row.state,requiresReview:row.requires_review,platformSerialNo:row.platform_serial_no},d);
    if(projected.requiresReview&&!row.requires_review)hardConflict=true;
    if(row.terminal_evidence_id&&qualified){const originalTerminal=row.state==="SUCCEEDED"?"PAID":"UNPAID_CONFIRMED";if(terminal!==originalTerminal||d.platformSerialNo!==row.platform_serial_no||d.providerFeeRaw!==row.provider_fee_raw||d.providerFeeCents!==row.provider_fee_cents)hardConflict=true;}
    if(hardConflict||row.requires_review&&qualified)event="REVIEW";
    else if(qualified)event=row.terminal_evidence_id?"TERMINAL":"PENDING_TERMINAL";
    else if(!row.requires_review&&!["SUCCEEDED","FAILED"].includes(row.state)){
     // 不完整205保留待接纳状态和原始观察，不能先写PENDING而缺账务闭包。
     next=projected.phase;event=next==="PROCESSING"?"PROCESSING":"UNKNOWN";
    }
   }
  }else if(!stale&&e.responseComplete&&e.failure===null&&e.body!==null&&r.key===null)schema="INVALID";
  else if(!stale&&real&&r.operation!=="NOTIFY"&&!["SUCCEEDED","FAILED","CHANNEL_SUCCEEDED_PENDING_ACCEPTANCE"].includes(row.state)&&!row.requires_review)next="UNKNOWN";
  const observationId=fresh("pwo");await c.query(`INSERT INTO zzsh_order.joinpay_payout_observation(id,intent_id,attempt_id,operation,lease_version,lease_owner,profile_id,profile_canonical,profile_sha256,key_version_ref,raw_body,raw_sha256,response_complete,http_status,received_bytes,transport_failure,event,schema_status,signature_status,binding_status,evidence_level,state_before,state_after,request_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24)`,[observationId,id,r.attemptId,r.operation,r.version,r.owner,p.profileId,readPayoutProfileEvidence(r.profile),p.profileSha256,p.keyVersionRef,e.body===null?null:Buffer.from(e.body),e.body===null?null:sha(e.body),e.responseComplete,e.httpStatus,e.receivedBytes,e.failure,event,schema,signature,bound,e.evidenceLevel,row.state,next,requestId]);
  if(hardConflict||next!==row.state||serial!==row.platform_serial_no){const changed=await c.query(`UPDATE zzsh_order.joinpay_withdrawal_intent SET state=$2,requires_review=requires_review OR $3::boolean,platform_serial_no=$4,operation_version=operation_version+1 WHERE id=$1 AND operation_version=$5::bigint AND ($6::boolean OR (lease_version=$7::bigint AND lease_owner=$8 AND lease_until>clock_timestamp()))`,[id,next,hardConflict,serial,row.operation_version,r.operation==="NOTIFY",r.version,r.owner]);if(changed.rowCount!==1)throw Object.assign(conflict("Payout lease changed"),{[expiredLease]:true});}
  let terminal:Awaited<ReturnType<typeof acceptNativeWithdrawalTerminalInTransaction>>|null=null;
  if(qualified&&!hardConflict&&!row.requires_review){const fact=await capturePayoutFact(c,o,id,observationId);if(fact)terminal=await acceptNativeWithdrawalTerminalInTransaction(c,{fact,requestId});else throw conflict("Payout terminal evidence incomplete");}
  await recordAudit(c,{actorType:"system",action:"joinpay.payout.observed",objectType:"joinpay_withdrawal_intent",objectId:id,outcome:"SUCCESS",requestId,details:{observationId,attemptId:r.attemptId,leaseVersion:r.version,operation:r.operation,profileSha256:p.profileSha256,event,evidenceLevel:e.evidenceLevel,rawSha256:e.body===null?null:sha(e.body)}});
  return{intentId:id,observationId,event,terminal,accepted:terminal!==null,receiptAccepted:receiptCandidate&&!hardConflict&&!row.requires_review&&(!terminalRequired||terminal!==null)};
 }
 if(!live)return persist(true);await c.query("SAVEPOINT native_payout_result");try{const v=await persist(false);await c.query("RELEASE SAVEPOINT native_payout_result");return v;}
 catch(error){const e=error as{code?:string;constraint?:string;[expiredLease]?:boolean};if(r.operation==="NOTIFY"||!(e[expiredLease]===true||e.code==="23514"&&e.constraint==="joinpay_payout_live_lease"))throw error;
  await c.query("ROLLBACK TO SAVEPOINT native_payout_result");if((await c.query(liveSql,args)).rows[0]?.current!==false)throw error;const v=await persist(true);await c.query("RELEASE SAVEPOINT native_payout_result");return v;}
}
export async function executeJoinpayPayout(o:PayoutExecution,intentId:string,owner:string,minimumIntervalSeconds?:number){if(!ID.test(intentId)||!ID.test(owner)||minimumIntervalSeconds!==undefined&&(!Number.isSafeInteger(minimumIntervalSeconds)||minimumIntervalSeconds<30||minimumIntervalSeconds>86400))throw invalid();readPayoutScope(o.scope);const fetch=o.fetch,a=await prepare(o,intentId,owner,minimumIntervalSeconds);if(a.kind!=="READY")return null;const p=a.prepared,exchange=await exchangePayoutRequest(p.request,{fetch});return confirmed(o.pool,intentId,"RESULT",c=>recordReceived(c,o,intentId,{operation:p.operation,profile:p.profile,key:p.key,attemptId:p.attemptId,version:p.version,owner:p.owner,exchange},p.attemptId));}
/** 窄QUERY-only入口：绝不首派，仅对已持久SUBMIT attempt的原单沿原号补查；不依赖新单KYC/初始profile。 */
export async function queryJoinpayPayout(o:PayoutExecution,intentId:string,owner:string,options:PayoutQueryOptions):Promise<PayoutQueryOutcome>{
 if(!options||!Number.isSafeInteger(options.minimumIntervalSeconds)||options.minimumIntervalSeconds<30||options.minimumIntervalSeconds>86400
  ||options.authorize!==undefined&&typeof options.authorize!=="function")throw invalid();
 if(!ID.test(intentId)||!ID.test(owner))throw invalid();readPayoutScope(o.scope);
 const a=await prepare(o,intentId,owner,options.minimumIntervalSeconds,true,options.authorize);
 if(a.kind==="NOT_DISPATCHED")return{kind:"NOT_DISPATCHED",intentId,state:a.state};
 if(a.kind==="SKIPPED")return{kind:"SKIPPED",intentId,state:a.state,reason:a.reason};
 const p=a.prepared,exchange=await exchangePayoutRequest(p.request,{fetch:o.fetch});
 const observed=await confirmed(o.pool,intentId,"RESULT",c=>recordReceived(c,o,intentId,{operation:p.operation,profile:p.profile,key:p.key,attemptId:p.attemptId,version:p.version,owner:p.owner,exchange},p.attemptId));
 return{kind:"OBSERVED",intentId,observationId:observed.observationId,event:observed.event,terminal:observed.terminal,accepted:observed.accepted,receiptAccepted:observed.receiptAccepted};
}
/** 仅POST原始字节；定位已知对象由薄adapter先做，不重建JSON也不盲试key。 */
export async function receiveJoinpayPayoutNotification(o:PayoutExecution,intentId:string,raw:Uint8Array,requestId:string){if(!ID.test(intentId)||!ID.test(requestId)||!(raw instanceof Uint8Array)||!raw.length||raw.length>65536)throw invalid();const bytes=new Uint8Array(raw);
 return confirmed(o.pool,intentId,"RESULT",async c=>{const{row}=await lockNativeWithdrawal(c,o.scope,intentId);await assertNativePayoutExecutionReady(c);const binding=nativePayoutBinding(row,o.scope),profile=o.profileFor("NOTIFY",Object.freeze({...binding})),p=describePayoutProfile(profile,"NOTIFY");assertPayoutProfile(o.scope,profile,"NOTIFY");let key:string|null=null;if(preflightPayoutProfile(profile,"NOTIFY",bytes,binding).ok){try{key=o.keyFor(p.keyVersionRef);}catch{throw new PayoutProfileError("PAYOUT_KEY_UNAVAILABLE");}}
  const result=await recordReceived(c,o,intentId,{operation:"NOTIFY",profile,key,attemptId:null,version:null,owner:null,exchange:Object.freeze({body:bytes,responseComplete:true,receivedBytes:bytes.length,httpStatus:null,failure:null,evidenceLevel:"PROVIDER_RESPONSE"})},requestId);return{...result,ackBody:payoutAcknowledgement(profile,result.receiptAccepted)};});}
