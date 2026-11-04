import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {SecurityApiError} from '../auth/security-core';
import {canonicalize} from '../supply/content-hash';
import {conflict,invalid} from '../supply/supply-util';
import type {ListingCursorKey} from '../supply/listing-cursor';
import {decodeFinanceCursor,encodeFinanceCursor,exactCents} from './personal-finance-read';
import {prepareOwnerGuaranteeHistory,readOwnerGuaranteeHistory} from './owner-guarantee-history';

const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const unavailable=()=>new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Guarantee history sources require reconciliation');
const stamp=(expression:string)=>{const f='('+expression+')';return `CASE WHEN ${f} ~ '^[0-9]{1,10}$' THEN CASE WHEN ${f}::numeric>0 AND ${f}::numeric<=4294967295 THEN to_timestamp(${f}::double precision) ELSE NULL::timestamptz END ELSE NULL::timestamptz END`;};
const clockSql=(column:string)=>`to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
export type UnifiedGuaranteeEvent={
 id:string;eventKind:'REQUIREMENT'|'PAYMENT_ATTEMPT'|'REFUND_ATTEMPT'|'PAYMENT_OBSERVATION'|'ACCOUNT_OBSERVATION';
 accountId:string|null;accountNumber:string|null;occurredAt:string|null;recordedAt:string;amountCents:string|null;
 source:{type:'NATIVE'|'LEGACY_MYSQL';entity:string;id:string};
 requirement:{id:string;status:string;requiredCents:string}|null;
 paymentAttempt:{id:string;status:string;providerState:string|null;merchantOrderNumber:string|null}|null;
 refundAttempt:{id:string;paymentId:string;status:string;providerState:string;releasePolicyState:string}|null;
 localPosting:{knowledge:'KNOWN'|'UNKNOWN';amountCents:string|null;postedAt:string|null;reason:string}|null;
 classification:string|null;conflicts:string[];channelArrival:'UNKNOWN';
};

function nativeEventsSql(){
 const common="jsonb_build_object('sourceType','NATIVE','requirementId',r.id,'requirementStatus',r.status,'requiredCents',r.required_cents::text,'accountId',r.account_id,'accountNumber',a.display_no)";
 return `SELECT 'native:requirement:'||r.id AS id,r.created_at AS occurred_at,r.created_at AS recorded_at,
  ${common}||jsonb_build_object('eventKind','REQUIREMENT','sourceEntity','owner_guarantee_requirement','sourceId',r.id,'amountCents',r.required_cents::text) AS payload,NULL::text AS source_canonical,NULL::text AS source_digest
  FROM zzsh_order.owner_guarantee_requirement r JOIN zzsh_supply.rental_account a ON a.id=r.account_id AND a.owner_user_id=r.owner_user_id WHERE r.owner_user_id=$1
 UNION ALL
 SELECT 'native:payment:'||p.id,p.created_at,p.created_at,
  ${common}||jsonb_build_object('eventKind','PAYMENT_ATTEMPT','sourceEntity','owner_guarantee_payment','sourceId',p.id,'amountCents',p.amount_cents::text,
   'attemptStatus',p.status,'providerState',p.provider_request_state,'merchantOrderNumber',p.merchant_order_no,
   'financeEventId',p.finance_event_id,'ledgerEntryRef',p.ledger_entry_ref,'postedAt',${clockSql('e.created_at')},
   'postingValid',COALESCE(p.status='CONFIRMED' AND p.provider_request_state='CONFIRMED' AND e.kind='GUARANTEE_CAPTURE' AND e.subject_user_id=p.owner_user_id
    AND root.source_kind='NATIVE_GUARANTEE' AND root.source_entity='owner_guarantee_payment' AND root.source_id=p.id AND root.subject_user_id=p.owner_user_id
    AND l.finance_event_id=e.id AND l.account_code='GUARANTEE_HELD' AND l.counterparty_user_id=p.owner_user_id AND l.debit_cents=0 AND l.credit_cents=COALESCE(p.observed_amount_cents,p.amount_cents),false),
   'postedAmountCents',COALESCE(p.observed_amount_cents,p.amount_cents)::text),NULL::text,NULL::text
  FROM zzsh_order.owner_guarantee_payment p JOIN zzsh_order.owner_guarantee_requirement r ON r.id=p.requirement_id AND r.owner_user_id=p.owner_user_id
   JOIN zzsh_supply.rental_account a ON a.id=r.account_id AND a.owner_user_id=r.owner_user_id
   LEFT JOIN zzsh_order.finance_event e ON e.id=p.finance_event_id LEFT JOIN zzsh_order.finance_economic_root root ON root.id=e.economic_root_id
   LEFT JOIN zzsh_order.settlement_ledger_entry l ON l.id=p.ledger_entry_ref WHERE p.owner_user_id=$1
 UNION ALL
 SELECT 'native:refund:'||f.id,f.created_at,f.created_at,
  ${common}||jsonb_build_object('eventKind','REFUND_ATTEMPT','sourceEntity','owner_guarantee_refund','sourceId',f.id,'amountCents',f.amount_cents::text,
   'attemptStatus',f.status,'providerState',f.provider_request_state,'paymentId',f.payment_id,'releasePolicyState',f.release_policy_state,
   'financeEventId',f.finance_event_id,'ledgerEntryRef',f.ledger_entry_ref,'postedAt',${clockSql('e.created_at')},
   'postingValid',COALESCE(f.status='SUCCEEDED' AND f.provider_request_state='SUCCEEDED' AND e.kind='GUARANTEE_REFUND' AND e.subject_user_id=f.owner_user_id
    AND root.source_kind='NATIVE_GUARANTEE' AND root.source_entity='owner_guarantee_refund' AND root.source_id=f.id AND root.subject_user_id=f.owner_user_id
    AND l.finance_event_id=e.id AND l.account_code='GUARANTEE_HELD' AND l.counterparty_user_id=f.owner_user_id AND l.credit_cents=0 AND l.debit_cents=f.amount_cents,false),
   'postedAmountCents',f.amount_cents::text),NULL::text,NULL::text
  FROM zzsh_order.owner_guarantee_refund f JOIN zzsh_order.owner_guarantee_requirement r ON r.id=f.requirement_id AND r.owner_user_id=f.owner_user_id
   JOIN zzsh_order.owner_guarantee_payment p ON p.id=f.payment_id AND p.requirement_id=r.id AND p.owner_user_id=f.owner_user_id
   JOIN zzsh_supply.rental_account a ON a.id=r.account_id AND a.owner_user_id=r.owner_user_id
   LEFT JOIN zzsh_order.finance_event e ON e.id=f.finance_event_id LEFT JOIN zzsh_order.finance_economic_root root ON root.id=e.economic_root_id
   LEFT JOIN zzsh_order.settlement_ledger_entry l ON l.id=f.ledger_entry_ref WHERE f.owner_user_id=$1`;
}
function unifiedSql(legacy:boolean,native:boolean){
 const empty="SELECT NULL::text AS id,NULL::timestamptz AS occurred_at,NULL::timestamptz AS recorded_at,NULL::jsonb AS payload,NULL::text AS source_canonical,NULL::text AS source_digest WHERE false";
 const legacySql=legacy?`SELECT 'legacy:account:'||o.id AS id,NULL::timestamptz AS occurred_at,o.imported_at AS recorded_at,
   jsonb_build_object('sourceType','LEGACY_MYSQL','eventKind','ACCOUNT_OBSERVATION','sourceId',o.legacy_account_id,'observationId',o.id) AS payload,o.source_canonical,o.source_digest
   FROM zzsh_order.legacy_owner_guarantee_observation o WHERE o.user_id=$1 AND o.source_cutoff=$2::timestamptz
    AND (jsonb_array_length(o.source_canonical::jsonb->'payOrders')>0 OR (o.source_canonical::jsonb->'source'->>'pay_is'='1' AND (o.source_canonical::jsonb->'source'->>'pay_money')::numeric>0))
  UNION ALL SELECT 'legacy:payment:'||(payment->>'id'),COALESCE(${stamp("payment->>'pay_time'")},${stamp("payment->>'create_time'")}),o.imported_at,
   jsonb_build_object('sourceType','LEGACY_MYSQL','eventKind','PAYMENT_OBSERVATION','sourceId',payment->>'id'),o.source_canonical,o.source_digest
   FROM zzsh_order.legacy_owner_guarantee_observation o CROSS JOIN LATERAL jsonb_array_elements(o.source_canonical::jsonb->'payOrders') payment
   WHERE o.user_id=$1 AND o.source_cutoff=$2::timestamptz`:empty;
 return `/* unified owner guarantee history v2 */ WITH events AS MATERIALIZED (${native?nativeEventsSql():empty} UNION ALL ${legacySql}),
 bound AS MATERIALIZED (SELECT $1::text AS subject_id,$2::timestamptz AS cutoff,COALESCE($3::timestamptz,clock_timestamp()) AS at),
 facts AS (SELECT *,COALESCE(occurred_at,'0001-01-01T00:00:00Z'::timestamptz) AS sort_at,
  (CASE WHEN source_digest IS NOT NULL THEN source_digest||':'||id ELSE payload::text END)||':'||COALESCE(${clockSql('occurred_at')},'UNKNOWN')||':'||${clockSql('recorded_at')} AS fingerprint FROM events),
 totals AS (SELECT count(*)::text AS total,count(*) FILTER(WHERE payload->>'sourceType'='NATIVE')::text AS native_count,
  count(*) FILTER(WHERE occurred_at IS NULL)::text AS unknown_time_count,
  (count(*)-count(DISTINCT id))::text AS duplicate_count,
  encode(sha256(convert_to(COALESCE(string_agg(id||':'||fingerprint,chr(10) ORDER BY id COLLATE "C"),''),'UTF8')),'hex') AS digest FROM facts),
 page AS (SELECT * FROM facts WHERE recorded_at<=(SELECT at FROM bound)
  AND ($4::timestamptz IS NULL OR (sort_at,id COLLATE "C")<($4::timestamptz,$5 COLLATE "C"))
  ORDER BY sort_at DESC,id COLLATE "C" DESC LIMIT 21)
 SELECT totals.*, ${clockSql('(SELECT at FROM bound)')} AS as_of,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',id,'occurredAt',${clockSql('occurred_at')},'recordedAt',${clockSql('recorded_at')},'sortAt',${clockSql('sort_at')},'payload',payload,'sourceCanonical',source_canonical,'sourceDigest',source_digest) ORDER BY sort_at DESC,id COLLATE "C" DESC) FROM page),'[]'::jsonb) AS page FROM totals`;
}
const amount=(v:unknown)=>{const n=exactCents(v);if(BigInt(n)<0n)throw unavailable();return n;};
const time=(v:unknown):string|null=>v===null?null:typeof v==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(v)&&Number.isFinite(Date.parse(v))?v:(()=>{throw unavailable();})();
export function projectUnifiedGuaranteeEvent(row:any,userId:string):UnifiedGuaranteeEvent{
 const p=row.payload;if(!p||!['NATIVE','LEGACY_MYSQL'].includes(p.sourceType)||typeof row.id!=='string')throw unavailable();
 const result:UnifiedGuaranteeEvent={id:row.id,eventKind:p.eventKind,accountId:null,accountNumber:null,occurredAt:time(row.occurredAt),recordedAt:time(row.recordedAt)!,amountCents:null,
  source:{type:p.sourceType,entity:'',id:p.sourceId},requirement:null,paymentAttempt:null,refundAttempt:null,localPosting:null,classification:null,conflicts:[],channelArrival:'UNKNOWN'};
 if(!result.recordedAt)throw unavailable();
 if(p.sourceType==='LEGACY_MYSQL'){
  let source:ReturnType<typeof prepareOwnerGuaranteeHistory>;try{source=prepareOwnerGuaranteeHistory(JSON.parse(row.sourceCanonical));}catch{throw unavailable();}
  if(source.userId!==userId||source.sourceCanonical!==row.sourceCanonical||source.sourceDigest!==row.sourceDigest)throw unavailable();
  result.accountId=source.accountId;result.accountNumber=typeof source.source.no==='string'&&source.source.no?source.source.no:null;result.classification=source.classification;result.conflicts=source.conflicts;
  if(p.eventKind==='ACCOUNT_OBSERVATION'){
   if(row.id!=='legacy:account:'+p.observationId||p.sourceId!==source.sourceId||result.occurredAt!==null)throw unavailable();
   result.source={type:'LEGACY_MYSQL',entity:'la_rental_accounts',id:source.sourceId};
  }else if(p.eventKind==='PAYMENT_OBSERVATION'){
   const payment=source.payments.find(v=>v.source.id===p.sourceId);if(!payment||row.id!=='legacy:payment:'+p.sourceId)throw unavailable();
   const expected=payment.sourcePaidAt??payment.sourceCreatedAt;
   if((expected===null)!==(result.occurredAt===null)||expected!==null&&Date.parse(expected)!==Date.parse(result.occurredAt!))throw unavailable();
   result.amountCents=payment.amountCents;result.source={type:'LEGACY_MYSQL',entity:'la_pay_order',id:p.sourceId};
   result.paymentAttempt={id:p.sourceId,status:payment.sourceStatus==='1'?'SOURCE_PAID_RECORD':payment.sourceStatus==='0'?'SOURCE_UNPAID_RECORD':'SOURCE_UNCONFIRMED',providerState:null,merchantOrderNumber:payment.merchantOrderNumber};
  }else throw unavailable();
  return result;
 }
 if(!['REQUIREMENT','PAYMENT_ATTEMPT','REFUND_ATTEMPT'].includes(p.eventKind)||typeof p.requirementId!=='string'||typeof p.accountId!=='string'||typeof p.requirementStatus!=='string')throw unavailable();
 const prefix=p.eventKind==='REQUIREMENT'?'requirement':p.eventKind==='PAYMENT_ATTEMPT'?'payment':'refund';if(row.id!=='native:'+prefix+':'+p.sourceId)throw unavailable();
 result.accountId=p.accountId;result.accountNumber=typeof p.accountNumber==='string'?p.accountNumber:null;result.amountCents=amount(p.amountCents);result.source={type:'NATIVE',entity:p.sourceEntity,id:p.sourceId};result.requirement={id:p.requirementId,status:p.requirementStatus,requiredCents:amount(p.requiredCents)};
 if(p.eventKind==='PAYMENT_ATTEMPT')result.paymentAttempt={id:p.sourceId,status:p.attemptStatus,providerState:p.providerState,merchantOrderNumber:p.merchantOrderNumber};
 if(p.eventKind==='REFUND_ATTEMPT')result.refundAttempt={id:p.sourceId,paymentId:p.paymentId,status:p.attemptStatus,providerState:p.providerState,releasePolicyState:p.releasePolicyState};
 if(p.eventKind!=='REQUIREMENT'){
  const recorded=typeof p.financeEventId==='string'&&typeof p.ledgerEntryRef==='string';
  if((p.financeEventId!==null)!==(p.ledgerEntryRef!==null)||recorded&&!p.postingValid)throw unavailable();
  result.localPosting=p.postingValid===true&&recorded?{knowledge:'KNOWN',amountCents:amount(p.postedAmountCents),postedAt:time(p.postedAt),reason:'BOUND_LOCAL_GUARANTEE_POSTING'}:{knowledge:'UNKNOWN',amountCents:null,postedAt:null,reason:'NO_CONFIRMED_LOCAL_POSTING'};
  if(result.localPosting.knowledge==='KNOWN'&&!result.localPosting.postedAt)throw unavailable();
 }
 return result;
}

/** Native birth proof can prove no legacy source; provider='none' or an empty query alone cannot. */
async function nativeHistoryAbsent(c:PoolClient,userId:string){
 const schema=(await c.query("SELECT to_regclass('zzsh_order.native_user_insert_proof') IS NOT NULL AND to_regclass('zzsh_order.wallet_coverage') IS NOT NULL AND to_regclass('zzsh_order.finance_opening_basis') IS NOT NULL AS ready")).rows[0]?.ready;
 if(schema!==true)return false;
 const r=(await c.query(`/* native owner guarantee history absence */ SELECT EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage w JOIN zzsh_order.finance_opening_basis b ON b.id=w.basis_id AND b.user_id=w.user_id
  JOIN zzsh_iam.user_identity_state i ON i.user_id=w.user_id JOIN zzsh_order.native_user_insert_proof p ON p.user_id=w.user_id
  WHERE w.user_id=$1 AND w.origin='NATIVE_GENESIS' AND b.source_kind='NATIVE_GENESIS' AND b.available_cents=0 AND b.covered_count=0 AND NULLIF(i.provider,'')<>'legacy_mysql_restore'
   AND NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.object_id=w.user_id AND a.action='user.legacy_owner.migrated' AND a.outcome='SUCCESS')
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.legacy_owner_guarantee_observation o WHERE o.user_id=w.user_id)) AS absent`,[userId])).rows[0];
 if(typeof r?.absent!=='boolean')throw unavailable();return r.absent;
}
export async function readUnifiedOwnerGuaranteeHistory(c:PoolClient,actor:{userId:string;sessionId:string},cursor:string|null,key:ListingCursorKey|undefined){
 const prior=await readOwnerGuaranteeHistory(c,actor,null,key),cutoff='cutoff' in prior.coverage?prior.coverage.cutoff:null;
 const native=prior.postedHeld.knowledge==='KNOWN',legacy=typeof cutoff==='string',absence=!legacy&&prior.coverage.reason!=='HISTORY_NOT_INSTALLED'?await nativeHistoryAbsent(c,actor.userId):false;
 const bindingBase={userId:actor.userId,sessionHash:sha(actor.sessionId),bucket:'OWNER_GUARANTEE_UNIFIED_V2'};
 let after:ReturnType<typeof decodeFinanceCursor>|null=null,expectedSnapshot:string|null=null;
 if(cursor){try{if(cursor.length>4096)throw Error();const claims=JSON.parse(Buffer.from(cursor.split('.')[0]??'','base64url').toString());if(typeof claims.snapshotVersion!=='string'||claims.snapshotVersion.length>256)throw Error();expectedSnapshot=claims.snapshotVersion;
   after=decodeFinanceCursor(cursor,{...bindingBase,snapshotVersion:expectedSnapshot!},key);
  }catch(error){if(error instanceof SecurityApiError)throw error;throw invalid('Invalid guarantee history cursor');}}
 const bundle=(await c.query(unifiedSql(legacy,native),[actor.userId,cutoff??null,after?.asOf??null,after?.position.at??null,after?.position.id??null])).rows[0];
 if(!bundle||!['total','native_count','unknown_time_count','duplicate_count'].every(k=>typeof bundle[k]==='string'&&/^(0|[1-9]\d{0,12})$/.test(bundle[k]))||bundle.duplicate_count!=='0'||! /^[a-f0-9]{64}$/.test(bundle.digest)||!Array.isArray(bundle.page)||bundle.page.length>21)throw unavailable();
 const snapshot='owner-guarantee-unified.v2:'+sha(canonicalize(['snapshotVersion' in prior?prior.snapshotVersion:prior.coverage,bundle.digest,prior.postedHeld,absence]));
 if(expectedSnapshot!==null&&snapshot!==expectedSnapshot)throw conflict('Guarantee history source set or current status changed; reload first page');
 const asOf=time(bundle.as_of)!;if(!asOf)throw unavailable();const items:UnifiedGuaranteeEvent[]=bundle.page.slice(0,20).map((r:any)=>projectUnifiedGuaranteeEvent(r,actor.userId));
 if(new Set(items.map((r:UnifiedGuaranteeEvent)=>r.id)).size!==items.length)throw unavailable();
 const complete=native&&(prior.coverage.knowledge==='KNOWN'||absence),last=bundle.page[Math.min(19,bundle.page.length-1)];
 return{contractVersion:'owner-guarantee-history.read.v2' as const,projectionVersion:2 as const,subjectId:actor.userId,asOf,snapshotVersion:snapshot,
  coverage:{knowledge:complete?'KNOWN' as const:'UNKNOWN' as const,count:complete?bundle.total:null,mappedRecordCount:bundle.total,reason:complete?'ALL_BOUND_GUARANTEE_SOURCES':'GUARANTEE_SOURCE_COVERAGE_INCOMPLETE',cutoff:cutoff??null},
  sources:{native:{knowledge:native?'KNOWN':'UNKNOWN',count:native?bundle.native_count:null},legacy:{knowledge:prior.coverage.knowledge==='KNOWN'||absence?'KNOWN':'UNKNOWN',count:prior.coverage.knowledge==='KNOWN'?prior.coverage.count:absence?'0':null,reason:absence?'PROVED_NATIVE_BIRTH_ABSENCE':prior.coverage.reason}},
  unknownTimeCount:bundle.unknown_time_count,items,postedHeld:prior.postedHeld,liability:{knowledge:'UNKNOWN',amountCents:null},channelArrival:'UNKNOWN',
  nextCursor:bundle.page.length>20&&last?encodeFinanceCursor({id:last.id,at:last.sortAt},asOf,{...bindingBase,snapshotVersion:snapshot},key):null};
}
