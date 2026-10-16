import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {SecurityApiError,withTransaction} from '../auth/security-core';
import {assertUserContextInTransaction,type UserContext} from '../auth/user-identity';
import {conflict,invalid,notFound} from '../supply/supply-util';
import {canonicalize} from '../supply/content-hash';
import type {ListingCursorKey} from '../supply/listing-cursor';
import type {NativeWithdrawalScope} from './native-withdrawal-resource';
import {readControlledWithdrawalsInTransaction,isUnadmittedControlledWithdrawalRead} from './controlled-withdrawal-store';
import {prepareHistoricalObservation,sourceYuanToCents,sourceSignedYuanToCents,encodeFinanceCursor,decodeFinanceCursor} from './personal-finance-read';
import {hasProvedNativeHistoryAbsence,readObservationCoverage} from './personal-finance-coverage';

export const PERSONAL_WITHDRAWAL_READ_VERSION='personal-withdrawals.read.v1';
const states=['RESERVED','SUBMITTING','PROCESSING','UNKNOWN','SUCCEEDED','FAILED','RECONCILIATION_REQUIRED'];
export type PersonalWithdrawalQuery={source:'ALL'|'HISTORICAL'|'LOCAL_CONTROLLED';state:string;limit:number;cursor:string|null};
type Actor=UserContext&{requestId:string};
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const unavailable=()=>new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Historical withdrawal evidence is inconsistent');
export function parsePersonalWithdrawalQuery(query:URLSearchParams):PersonalWithdrawalQuery{
 for(const field of query.keys())if(!['source','state','limit','cursor'].includes(field)||query.getAll(field).length!==1)throw invalid('Unsupported withdrawal filter');
 const source=query.get('source')??'ALL',state=query.get('state')??'ALL',limit=query.get('limit')??'20',cursor=query.get('cursor');
 if(!['ALL','HISTORICAL','LOCAL_CONTROLLED'].includes(source)||!/^[1-9]\d{0,2}$/.test(limit)||Number(limit)>100||cursor!==null&&(!cursor||cursor.length>4096))throw invalid('Invalid withdrawal query');
 if(state!=='ALL'&&(source==='ALL'||source==='HISTORICAL'&&!/^[1-5]$/.test(state)||source==='LOCAL_CONTROLLED'&&!states.includes(state)))throw invalid('Withdrawal status requires its exact source');
 if(cursor&&source==='ALL')throw invalid('Continuation requires its exact withdrawal source');
 return{source:source as PersonalWithdrawalQuery['source'],state,limit:Number(limit),cursor};
}
export function parsePersonalWithdrawalDetailPath(path:string):string|null{
 if(/^\/(history|controlled)(?::|%3[aA])[A-Za-z0-9_-]{1,180}$/.test(path))return decodeURIComponent(path.slice(1));
 if(path.startsWith('/history:')||path.startsWith('/controlled:')||/%|\//.test(path.slice(1)))throw notFound();
 return null;
}

/** These are imported observations. Reading them never changes a wallet or repeats a withdrawal. */
export function historicalWithdrawalProjection(row:Record<string,any>){
 try{
  if(!/^[A-Za-z0-9_-]{1,180}$/.test(row.id)||row.source_kind!=='HISTORICAL_WITHDRAWAL'||row.source_entity!=='la_withdraw_apply'||row.source_type!=='LEGACY_MYSQL'||typeof row.included_in_opening!=='boolean'||row.included_in_opening&&!row.basis_id)throw Error();
  const prepared=prepareHistoricalObservation(row.snapshot,{userId:row.user_id,legacyUserId:row.legacy_user_id,sourceSystem:row.source_system,basisId:null});
  if(prepared.sourceId!==row.source_id||prepared.sourceKind!==row.source_kind||prepared.sourceDigest!==row.source_digest||prepared.sourceCanonical!==row.source_canonical||Date.parse(row.occurred_at)!==Date.parse(prepared.sourceEventAt)||![row.occurred_at,row.imported_at].every(value=>typeof value==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(value)))throw Error();
  return{id:'history:'+row.id,source:'HISTORICAL_WITHDRAWAL' as const,sourceReference:{type:'LEGACY_MYSQL' as const,system:row.source_system,entity:'la_withdraw_apply' as const,id:row.source_id},sourceStatus:row.snapshot.sourceStatus as number,amountCents:sourceYuanToCents(row.snapshot.amount),netCents:sourceSignedYuanToCents(row.snapshot.net),feeCents:sourceSignedYuanToCents(row.snapshot.fee),occurredAt:row.occurred_at,importedAt:row.imported_at,sourceDigest:row.source_digest,includedInOpening:row.included_in_opening,accountingEffect:'OBSERVATION_ONLY_NO_NEW_DEBIT' as const,channelArrivalKnowledge:'UNKNOWN' as const};
 }catch{throw unavailable();}
}
const historyWhere=`FROM zzsh_order.personal_finance_observation o WHERE o.user_id=$1 AND o.source_kind='HISTORICAL_WITHDRAWAL' AND o.source_type='LEGACY_MYSQL' AND o.source_entity='la_withdraw_apply'`;
const historyProjection=`SELECT o.*,to_char(o.source_event_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at,to_char(o.imported_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS imported_at `;
async function historicalRead(client:PoolClient,actor:Actor,query:PersonalWithdrawalQuery,key:ListingCursorKey|undefined,detailId?:string){
 const installed=(await client.query(`SELECT to_regclass('zzsh_order.personal_finance_observation') IS NOT NULL AS history,to_regclass('zzsh_order.wallet_coverage') IS NOT NULL AND to_regclass('zzsh_order.finance_opening_basis') IS NOT NULL AND to_regclass('zzsh_order.native_user_insert_proof') IS NOT NULL AS native`)).rows[0];
 if(!installed?.history){if(detailId)throw unavailable();if(query.cursor)throw conflict('Withdrawal source changed; reload first page');return{source:'HISTORICAL_WITHDRAWAL' as const,availability:'NOT_INSTALLED' as const,coverage:{knowledge:'UNKNOWN' as const,reason:'HISTORICAL_WITHDRAWAL_NOT_INSTALLED'},items:[],mappedRecordCount:null,count:null,asOf:null,snapshotVersion:null,nextCursor:null};}
 // Wallet coverage alone is not proof that a legacy withdrawal history is complete.
 const native=installed.native===true?await hasProvedNativeHistoryAbsence(client,actor.userId,'HISTORICAL_WITHDRAWAL'):false;
 const aggregate=(await client.query(`SELECT count(*)::text AS count,md5(COALESCE(string_agg(o.id||':'||o.source_digest,',' ORDER BY o.id),'')) AS digest ${historyWhere} AND($2='ALL' OR o.snapshot->>'sourceStatus'=$2)`,[actor.userId,query.state])).rows[0];
 const nativeEmpty=native&&aggregate.count==='0';
 const proof=nativeEmpty?null:await readObservationCoverage(client,actor.userId,'HISTORICAL_WITHDRAWAL');
 const complete=nativeEmpty||proof?.knowledge==='KNOWN';
 const snapshotVersion='historical-withdrawals.read.v1:'+hash(canonicalize([aggregate.count,aggregate.digest,native,proof?.version??null]));
 const binding={userId:actor.userId,sessionHash:hash(actor.sessionId),snapshotVersion,bucket:'PERSONAL_WITHDRAWALS:HISTORICAL:'+query.state};
 const after=query.cursor?decodeFinanceCursor(query.cursor,binding,key):null;
 const asOf=after?.asOf??(await client.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0].at;
 if(detailId){const row=(await client.query(historyProjection+historyWhere+' AND o.id=$2',[actor.userId,detailId])).rows[0];if(!row)throw notFound();return{source:'HISTORICAL_WITHDRAWAL' as const,item:historicalWithdrawalProjection(row),asOf,snapshotVersion};}
 const found=(await client.query(historyProjection+historyWhere+` AND o.imported_at<=$2::timestamptz AND($3='ALL' OR o.snapshot->>'sourceStatus'=$3) AND($4::timestamptz IS NULL OR(o.source_event_at,o.id COLLATE "C")<($4::timestamptz,$5 COLLATE "C")) ORDER BY o.source_event_at DESC,o.id COLLATE "C" DESC LIMIT $6`,[actor.userId,asOf,query.state,after?.position.at??null,after?.position.id??null,query.limit+1])).rows;
 const visible=found.slice(0,query.limit),last=visible.at(-1);
 return{source:'HISTORICAL_WITHDRAWAL' as const,availability:aggregate.count==='0'&&!complete?'NOT_IMPORTED' as const:'AVAILABLE' as const,coverage:{knowledge:complete?'KNOWN' as const:'UNKNOWN' as const,reason:nativeEmpty?'PROVED_NATIVE_NO_LEGACY_HISTORY':proof?.reason??'HISTORICAL_WITHDRAWAL_COVERAGE_NOT_CLOSED',cutoff:proof?.cutoff??null,version:proof?.version??null},items:visible.map(historicalWithdrawalProjection),mappedRecordCount:aggregate.count,count:complete?aggregate.count:null,asOf,snapshotVersion,nextCursor:found.length>query.limit&&last?encodeFinanceCursor({at:last.occurred_at,id:last.id},asOf,binding,key):null};
}

export async function readPersonalWithdrawals(pool:Pool,actor:Actor,query:PersonalWithdrawalQuery,key:ListingCursorKey|undefined,scope?:NativeWithdrawalScope,detailId?:string){
 const match=detailId===undefined?null:/^(history|controlled):([A-Za-z0-9_-]{1,180})$/.exec(detailId);
 if(detailId!==undefined&&!match)throw notFound();
 return withTransaction(pool,async client=>{
  await assertUserContextInTransaction(client,actor);
  if(match){
   if(match[1]==='history')return{contractVersion:PERSONAL_WITHDRAWAL_READ_VERSION,subjectId:actor.userId,...await historicalRead(client,actor,{source:'HISTORICAL',state:'ALL',limit:20,cursor:null},key,match[2])};
   const body=await readControlledWithdrawalsInTransaction(client,actor,match[2],scope);
   if(!('intent' in body))throw unavailable();
   return{contractVersion:PERSONAL_WITHDRAWAL_READ_VERSION,subjectId:actor.userId,source:'LOCAL_CONTROLLED' as const,item:{id:detailId!,source:'LOCAL_CONTROLLED' as const,intent:body.intent}};
  }
  const historical=query.source==='LOCAL_CONTROLLED'?null:await historicalRead(client,actor,query,key);
  let controlled:{availability:'AVAILABLE'|'NOT_ADMITTED'|'NOT_CONFIGURED'|'NOT_IN_SCOPE'|'NOT_REQUESTED';reason:string|null;data:Awaited<ReturnType<typeof readControlledWithdrawalsInTransaction>>|null}={availability:'NOT_REQUESTED',reason:null,data:null};
  if(query.source!=='HISTORICAL')try{
   const data=await readControlledWithdrawalsInTransaction(client,actor,undefined,scope,{limit:query.limit,cursor:query.cursor,state:query.state,key});
   controlled={availability:'AVAILABLE',reason:null,data};
  }catch(error){
   if(!(error instanceof SecurityApiError)||error.status!==503)throw error;
   if(!scope&&await isUnadmittedControlledWithdrawalRead(client,error))controlled={availability:'NOT_ADMITTED',reason:error.message,data:null};
   else if(error.message==='CONTROLLED_LOCAL_ADMISSION_UNAVAILABLE')controlled={availability:'NOT_CONFIGURED',reason:error.message,data:null};
   else if(scope&&error.message==='NATIVE_WITHDRAWAL_SUBJECT_NOT_ADMITTED')controlled={availability:'NOT_IN_SCOPE',reason:error.message,data:null};
   else throw error;
   if(query.cursor)throw conflict('Withdrawal source changed; reload first page');
  }
  return{contractVersion:PERSONAL_WITHDRAWAL_READ_VERSION,subjectId:actor.userId,source:query.source,state:query.state,historical,controlled};
 });
}
