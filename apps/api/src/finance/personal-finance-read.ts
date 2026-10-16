import {exactCents} from './finance-money';
export {exactCents} from './finance-money';
import {readNativeWalletBuckets,readNativeReservationStatus} from './native-wallet-projection';
import type {NativeWithdrawalScope} from './native-withdrawal-resource';
import { createHmac, timingSafeEqual, createHash } from "node:crypto";
import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import { invalid, conflict, notFound } from "../supply/supply-util";
import { requireListingCursorKey, type ListingCursorKey } from "../supply/listing-cursor";
import { canonicalize } from "../supply/content-hash";
import {hasProvedNativeHistoryAbsence,readObservationCoverage} from './personal-finance-coverage';

export const FINANCE_READ_VERSION = "personal-finance.read.v1";
/** A later opening may admit an already immutable observation without changing its original row. */
export const OPENING_OBSERVATION_JOIN=`LEFT JOIN zzsh_order.wallet_coverage oc ON oc.user_id=o.user_id
 LEFT JOIN zzsh_order.finance_observation_admission oa ON oa.basis_id=oc.basis_id AND oa.user_id=o.user_id
  AND oa.source_system=o.source_system AND oa.legacy_user_id=o.legacy_user_id AND oa.source_entity=o.source_entity
  AND oa.source_id=o.source_id AND oa.source_digest=o.source_digest AND oa.source_event_at=o.source_event_at`;
const hash = (s:string) => createHash("sha256").update(s).digest("hex");
const money = (amountCents:string|null,scope?:'POSTED_LEDGER_ONLY') => ({currency:"CNY",unit:"cent",knowledge:amountCents===null?"UNKNOWN":"KNOWN",amountCents,...(scope?{scope}:{})});
export function sourceYuanToCents(value:unknown):string {
  if(typeof value!=="string" || !/^(0|[1-9]\d{0,21})\.\d{2}$/.test(value))throw invalid("Invalid source amount");
  return (BigInt(value.replace(".",""))).toString();
}
export function sourceSignedYuanToCents(value:unknown):string {
  if(typeof value!=="string"||! /^-?(0|[1-9]\d{0,21})\.\d{2}$/.test(value)||value==='-0.00')throw invalid('Invalid signed source amount');
  return BigInt(value.replace('.','')).toString();
}
export type ObservationMapping={userId:string;legacyUserId:string;sourceSystem:string;basisId:string|null;openingAdmission?:{sourceDigest:string;included:boolean;cutoff:string}};
export function prepareHistoricalObservation(row:Record<string,unknown>,mapping:ObservationMapping) {
  const entity=row.kind==="earningsLog"?"la_log_earnings":row.kind==="historicalDistribution"?"la_distribution_order":row.kind==="withdrawObservation"?"la_withdraw_apply":null;
  if(!entity || String(row.sourceUserId)!==mapping.legacyUserId || !Number.isSafeInteger(row.sourceId) || Number(row.sourceId)<=0)throw invalid("Historical subject/source mismatch");
  sourceYuanToCents(row.amount);
  if(entity==='la_log_earnings'){
    if(row.action!==1&&row.action!==2)throw invalid('Historical direction unknown');
    sourceSignedYuanToCents(row.leftAmount);
  }else if(entity==='la_distribution_order'){
    if(![1,2,3].includes(row.sourceStatus as number))throw invalid('Historical distribution status unknown');
  }else{
    if(![1,2,3,4,5].includes(row.sourceStatus as number))throw invalid('Historical withdrawal status unknown');
    sourceSignedYuanToCents(row.net);sourceSignedYuanToCents(row.fee);
  }
  const sourceCanonical=canonicalize(row),sourceDigest=hash(sourceCanonical);
  const at=entity==="la_distribution_order"?row.sourceUpdatedAt:row.createdAt;
  if(!Number.isSafeInteger(at)||Number(at)<=0||Number(at)>4294967295)throw invalid("Historical event time unknown");
  const sourceEventAt=new Date(Number(at)*1000).toISOString(),admission=mapping.openingAdmission;
  if(mapping.basisId && (!admission||admission.sourceDigest!==sourceDigest||!Number.isFinite(Date.parse(admission.cutoff))||Number(at)*1000>Date.parse(admission.cutoff)))throw invalid('Frozen opening admission/time mismatch');
  if(!mapping.basisId&&admission)throw invalid('Opening admission requires its basis');
  const {openingAdmission:_,...subject}=mapping;
  return {...subject,sourceType:"LEGACY_MYSQL",sourceEntity:entity,sourceId:String(row.sourceId),sourceKind:entity==="la_log_earnings"?"HISTORICAL_EARNINGS_LOG":entity==="la_distribution_order"?"HISTORICAL_DISTRIBUTION":"HISTORICAL_WITHDRAWAL",sourceCanonical,sourceDigest,includedInOpening:admission?.included??false,sourceEventAt};
}
async function ready(client:PoolClient,userId:string){
  const schema=(await client.query(`SELECT to_regclass('zzsh_order.wallet_coverage') IS NOT NULL AND to_regclass('zzsh_order.personal_finance_observation') IS NOT NULL AND to_regclass('zzsh_order.wallet_revision') IS NOT NULL AS ready`)).rows[0];
  if(schema?.ready!==true)throw new SecurityApiError(503,"EVIDENCE_UNAVAILABLE","Wallet read schema is not available");
  if(!(await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR SHARE`,[userId])).rowCount)throw notFound();
}
export async function readPersonalWallet(client:PoolClient,userId:string,nativeScope?:NativeWithdrawalScope){
  await ready(client,userId);
  const c=(await client.query(`SELECT c.origin,b.source_cutoff AS "cutoff",b.source_digest AS "sourceDigest",b.covered_set_digest AS "coveredSetDigest",c.coverage_version::text AS "coverageVersion" FROM zzsh_order.wallet_coverage c JOIN zzsh_order.finance_opening_basis b ON b.id=c.basis_id AND b.user_id=c.user_id WHERE c.user_id=$1`,[userId])).rows[0];
  const r=(await client.query(`SELECT ledger_revision::text AS "ledgerRevision",read_revision::text AS "readRevision" FROM zzsh_order.wallet_revision WHERE user_id=$1`,[userId])).rows[0]??{ledgerRevision:"0",readRevision:"0"};
  const totals=(await client.query(`SELECT COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code IN('OWNER_AVAILABLE','WALLET_AVAILABLE')),0)::text AS available,
   COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code='WALLET_RESERVED'),0)::text AS reserved,
   COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code='WALLET_PENDING_EARNINGS'),0)::text AS pending,
   COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code='RENTER_REFUND_PAYABLE'),0)::text AS refund
   FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1`,[userId])).rows[0];
  if(!totals)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Wallet ledger aggregate unavailable');
  if(c&&c.origin!=='NATIVE_GENESIS')for(const k of ['available','reserved','pending','refund'])if(BigInt(exactCents(totals[k]))<0n)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Wallet ledger requires reconciliation');
  const native=c?.origin==='NATIVE_GENESIS'?await readNativeWalletBuckets(client,userId):null;
  if(c?.origin==='NATIVE_GENESIS'&&!native)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Native wallet origin is not closed');
  const nativeWithdrawal=nativeScope?await readNativeReservationStatus(client,userId,nativeScope):undefined;
  return {...(nativeScope?{nativeWithdrawal}:{}),contractVersion:FINANCE_READ_VERSION,subjectId:userId,asOf:new Date().toISOString(),currency:"CNY",coverage:c?{knowledge:"KNOWN",...c}:{knowledge:"UNKNOWN",reason:"SOURCE_COVERAGE_NOT_ADMITTED"},...r,snapshotVersion:`${r.ledgerRevision}:${r.readRevision}:${c?.coverageVersion??"0"}`,buckets:native??{available:money(c?exactCents(totals.available):null,c?'POSTED_LEDGER_ONLY':undefined),reserved:money(c?exactCents(totals.reserved):null,c?'POSTED_LEDGER_ONLY':undefined),restricted:money(null),pendingEarnings:money(c?exactCents(totals.pending):null,c?'POSTED_LEDGER_ONLY':undefined),refundPayable:money(c?exactCents(totals.refund):null,c?'POSTED_LEDGER_ONLY':undefined)},withdrawable:{...money(null),reasonCodes:[c?"WITHDRAWAL_POLICY_NOT_ACTIVE":"SOURCE_COVERAGE_UNKNOWN"]}};
}
export type FinanceQuery={limit:number;cursor:string|null;bucket:"AVAILABLE"|"REFUND_PAYABLE"|"RESERVED"|"PENDING_EARNINGS"|"ALL";projectionVersion?:2};
export function parseFinanceProjectionVersion(q:URLSearchParams):1|2{const values=q.getAll('projectionVersion');if(values.length>1||values.length===1&&!['1','2'].includes(values[0]!))throw invalid('Unsupported finance projection version');return values[0]==='2'?2:1;}
export function decodeFinanceEntryId(raw:string){let value:string;try{value=decodeURIComponent(raw);}catch{throw notFound();}if(!/^(ledger|history):[A-Za-z0-9_-]{1,180}$/.test(value))throw notFound();return value;}
export function parseFinanceQuery(q:URLSearchParams):FinanceQuery {
  for(const k of q.keys())if(!["limit","cursor","bucket","projectionVersion"].includes(k)||q.getAll(k).length!==1)throw invalid("Unsupported wallet filter",k);
  const limit=q.get("limit")??"20",bucket=q.get("bucket")??"ALL",version=parseFinanceProjectionVersion(q);
  if(!/^[1-9]\d{0,2}$/.test(limit)||Number(limit)>100||!(version===2?["AVAILABLE","REFUND_PAYABLE","RESERVED","PENDING_EARNINGS","ALL"]:["AVAILABLE","REFUND_PAYABLE","ALL"]).includes(bucket))throw invalid("Invalid wallet query");
  return {limit:Number(limit),cursor:q.get("cursor"),bucket:bucket as FinanceQuery["bucket"],...(version===2?{projectionVersion:2 as const}:{})};
}
type CursorBinding={userId:string;sessionHash:string;snapshotVersion:string;bucket:string};
export function encodeFinanceCursor(position:{at:string;id:string},asOf:string,binding:CursorBinding,key:ListingCursorKey|undefined){requireListingCursorKey(key);const bytes=Buffer.from(JSON.stringify({audience:FINANCE_READ_VERSION,keyId:key.keyId,...binding,asOf,position})).toString("base64url");return bytes+"."+createHmac("sha256",key.secret).update(bytes).digest("base64url");}
export function decodeFinanceCursor(token:string,binding:CursorBinding,key:ListingCursorKey|undefined){requireListingCursorKey(key);try{if(token.length>4096||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))throw Error();const [bytes,sig]=token.split(".") as [string,string];const actual=Buffer.from(sig,"base64url"),expected=createHmac("sha256",key.secret).update(bytes).digest();if(actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error();const value=JSON.parse(Buffer.from(bytes,"base64url").toString());if(value.audience!==FINANCE_READ_VERSION||value.keyId!==key.keyId)throw Error();for(const [k,v]of Object.entries(binding))if(value[k]!==v)throw conflict("Wallet identity or snapshot changed; reload first page");for(const d of [value.asOf,value.position?.at])if(typeof d!=="string"||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(d))throw Error();if(typeof value.position.id!=="string"||value.position.id.length>200)throw Error();return value as {asOf:string;position:{at:string;id:string}};}catch(e){if(e instanceof SecurityApiError&&e.status===409)throw e;throw invalid("Invalid wallet cursor");}}
const entrySql=(version:1|2=1)=>`WITH entries AS (
 SELECT 'ledger:'||l.id AS id,l.created_at AS at,l.created_at AS imported_at,
 CASE WHEN l.account_code='RENTER_REFUND_PAYABLE' THEN 'REFUND_PAYABLE' ${version===2?"WHEN l.account_code='WALLET_RESERVED' THEN 'RESERVED' WHEN l.account_code='WALLET_PENDING_EARNINGS' THEN 'PENDING_EARNINGS' ":''}ELSE 'AVAILABLE' END AS bucket,
 (l.credit_cents-l.debit_cents)::text AS delta,'POSTED' AS kind,false AS included,
 CASE WHEN e.kind='OPENING' THEN 'OPENING' WHEN root.source_kind='LOCAL_CONTROLLED_WITHDRAWAL' THEN 'CONTROLLED_WITHDRAWAL_'||e.kind WHEN root.source_kind='NATIVE_RENTAL_REFERRAL' THEN 'NATIVE_REFERRAL_'||e.kind WHEN root.source_kind='NATIVE_GUARANTEE' THEN 'OWNER_GUARANTEE_'||e.kind WHEN l.finance_event_id IS NOT NULL THEN e.kind ELSE 'NATIVE_SETTLEMENT' END AS source_kind,
 COALESCE(root.source_id,l.posting_id) AS source_id,NULL::text AS balance_after,
 CASE WHEN l.finance_event_id IS NOT NULL THEN root.source_type ELSE 'NATIVE' END AS source_type,COALESCE(root.source_system,'zzsh') AS source_system,
 CASE WHEN l.finance_event_id IS NOT NULL THEN root.source_entity ELSE 'settlement_posting' END AS source_entity,
 COALESCE(p.order_id,CASE WHEN root.source_kind='LEGACY_CONTINUATION_DUTY' THEN l.details->>'legacyOrderId' WHEN root.source_kind='NATIVE_RENTAL_REFERRAL' THEN root.source_id ELSE NULL END) AS business_id,
 CASE WHEN root.source_kind='LEGACY_CONTINUATION_DUTY' THEN l.details->>'legacyOrderNumber' ELSE NULL END AS business_no,
 CASE WHEN root.source_kind='LEGACY_CONTINUATION_DUTY' THEN 'LEGACY_ORDER' WHEN p.order_id IS NOT NULL OR root.source_kind='NATIVE_RENTAL_REFERRAL' THEN 'RENTAL_ORDER' ELSE 'UNKNOWN' END AS business_type
 FROM zzsh_order.settlement_ledger_entry l LEFT JOIN zzsh_order.finance_event e ON e.id=l.finance_event_id LEFT JOIN zzsh_order.finance_economic_root root ON root.id=e.economic_root_id LEFT JOIN zzsh_order.settlement_posting p ON p.id=l.posting_id
 WHERE l.counterparty_user_id=$1 AND l.account_code IN ('OWNER_AVAILABLE','WALLET_AVAILABLE','RENTER_REFUND_PAYABLE'${version===2?",'WALLET_RESERVED','WALLET_PENDING_EARNINGS'":''})
 UNION ALL SELECT 'history:'||o.id,o.source_event_at,o.imported_at,'AVAILABLE',
 ((o.snapshot->>'amount')::numeric*100*(CASE WHEN o.snapshot->>'action'='1' THEN 1 WHEN o.snapshot->>'action'='2' THEN -1 ELSE NULL END))::numeric(24,0)::text,
 'HISTORICAL',COALESCE(oa.included_in_opening,o.included_in_opening),o.source_kind,o.source_id,((o.snapshot->>'leftAmount')::numeric*100)::numeric(24,0)::text,
 o.source_type,o.source_system,o.source_entity,o.snapshot->>'referenceId',o.snapshot->>'referenceSn','LEGACY_UNRESOLVED'
 FROM zzsh_order.personal_finance_observation o ${OPENING_OBSERVATION_JOIN} WHERE o.user_id=$1 AND o.source_entity='la_log_earnings'
 )`;
function entry(row:any){return {schemaVersion:1,id:row.id,occurredAt:row.at,importedAt:row.imported_at,bucket:row.bucket,deltaCents:exactCents(row.delta),kind:row.kind,includedInOpening:row.included,sourceKind:row.source_kind,sourceId:row.source_id,source:{type:row.source_type,system:row.source_system,entity:row.source_entity,id:row.source_id},businessReference:{type:row.business_type,id:row.business_id??null,number:row.business_no??null},balanceAfterCents:row.balance_after===null?null:exactCents(row.balance_after)};}
export async function readPersonalFinanceEntries(client:PoolClient,actor:{userId:string;sessionId:string},q:FinanceQuery,key:ListingCursorKey|undefined){
  const version=q.projectionVersion??1,source=entrySql(version);if(![1,2].includes(version)||version===1&&['RESERVED','PENDING_EARNINGS'].includes(q.bucket))throw invalid('Wallet bucket requires projection 2');
  const wallet=await readPersonalWallet(client,actor.userId);
  const ledgerOnly=version===2&&['RESERVED','PENDING_EARNINGS'].includes(q.bucket);
  const native=!ledgerOnly&&wallet.coverage.knowledge==='KNOWN'&&'origin' in wallet.coverage&&wallet.coverage.origin==='NATIVE_GENESIS'?await hasProvedNativeHistoryAbsence(client,actor.userId,'HISTORICAL_EARNINGS_LOG'):false;
  const historyCoverage=ledgerOnly?{knowledge:'KNOWN' as const,reason:'POSTED_LEDGER_SCOPE',count:'0',cutoff:null,version:'LEDGER:'+wallet.snapshotVersion}:native?{knowledge:'KNOWN' as const,reason:'PROVED_NATIVE_HISTORY_ABSENCE',count:'0',cutoff:null,version:'NATIVE_GENESIS'}:await readObservationCoverage(client,actor.userId,'HISTORICAL_EARNINGS_LOG');
  const binding={userId:actor.userId,sessionHash:hash(actor.sessionId),snapshotVersion:wallet.snapshotVersion,bucket:'WALLET_ENTRIES:'+(version===2?'v2:':'')+q.bucket+':'+historyCoverage.version};
  const after=q.cursor?decodeFinanceCursor(q.cursor,binding,key):null;
  const asOf=after?.asOf??(await client.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0].at;
  const totals=(await client.query(source+` SELECT bucket,count(*)::text AS count,COALESCE(sum(delta::numeric) FILTER(WHERE kind='POSTED'),0)::text AS "postedNetCents",COALESCE(sum(delta::numeric) FILTER(WHERE kind='HISTORICAL' AND included),0)::text AS "coveredHistoricalNetCents",COALESCE(sum(delta::numeric) FILTER(WHERE kind='HISTORICAL' AND NOT included),0)::text AS "uncoveredHistoricalNetCents",count(*) FILTER(WHERE kind='HISTORICAL' AND included)::text AS "coveredCount",count(*) FILTER(WHERE kind='HISTORICAL' AND NOT included)::text AS "uncoveredCount" FROM entries WHERE imported_at<=$2::timestamptz AND ($3='ALL' OR bucket=$3) GROUP BY bucket ORDER BY bucket`,[actor.userId,asOf,q.bucket])).rows;
  const byBucket=totals.map(t=>({...t,postedNetCents:exactCents(t.postedNetCents),coveredHistoricalNetCents:exactCents(t.coveredHistoricalNetCents),uncoveredHistoricalNetCents:exactCents(t.uncoveredHistoricalNetCents)}));
  const count=totals.reduce((n,t)=>n+BigInt(t.count),0n).toString(),hasUncovered=totals.some(t=>BigInt(t.uncoveredCount)>0n),hasCovered=totals.some(t=>BigInt(t.coveredCount)>0n);
  const rows=(await client.query(source+` SELECT *,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at FROM entries WHERE imported_at<=$2::timestamptz AND ($3='ALL' OR bucket=$3) AND ($4::timestamptz IS NULL OR (at,id COLLATE "C")<($4::timestamptz,$5 COLLATE "C")) ORDER BY at DESC,id COLLATE "C" DESC LIMIT $6`,[actor.userId,asOf,q.bucket,after?.position.at??null,after?.position.id??null,q.limit+1])).rows;
  const more=rows.length>q.limit,visible=rows.slice(0,q.limit),last=visible.at(-1);
  return {contractVersion:FINANCE_READ_VERSION,...(version===2?{projectionVersion:2 as const}:{}),subjectId:actor.userId,asOf,snapshotVersion:wallet.snapshotVersion,coverage:wallet.coverage,listCoverage:{knowledge:historyCoverage.knowledge,count:historyCoverage.knowledge==='KNOWN'?count:null,mappedRecordCount:count,reason:historyCoverage.reason,cutoff:historyCoverage.cutoff,version:historyCoverage.version,...(ledgerOnly?{scope:'POSTED_LEDGER_ONLY' as const}:{})},bucket:q.bucket,items:visible.map(entry),totals:{count,byBucket,historicalCoverage:hasUncovered?(hasCovered?'MIXED':'NOT_INCLUDED'):hasCovered?'INCLUDED':'NO_HISTORY',meaning:hasUncovered?'Uncovered historical facts do not change the current wallet':'Covered historical facts are already represented by the opening; do not add them again'},nextCursor:more&&last?encodeFinanceCursor({at:last.sort_at,id:last.id},asOf,binding,key):null};
}
export async function readPersonalFinanceEntry(client:PoolClient,userId:string,id:string,projectionVersion:1|2=1){if(![1,2].includes(projectionVersion))throw invalid('Unsupported finance projection version');const wallet=await readPersonalWallet(client,userId);if(!/^(ledger|history):[A-Za-z0-9_-]{1,180}$/.test(id))throw notFound();const row=(await client.query(entrySql(projectionVersion)+` SELECT * FROM entries WHERE id=$2`,[userId,id])).rows[0];if(!row)throw notFound();return {contractVersion:FINANCE_READ_VERSION,...(projectionVersion===2?{projectionVersion:2 as const}:{}),subjectId:userId,asOf:wallet.asOf,snapshotVersion:wallet.snapshotVersion,coverage:wallet.coverage,entry:entry(row)};}
