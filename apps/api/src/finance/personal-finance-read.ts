import {exactCents} from './finance-money';
import {readReferralRecovery} from './distribution-recovery-gate';
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
export const FINANCE_LEDGER_POSTED_AT_SQL = 'CASE WHEN l.finance_event_id IS NOT NULL THEN e.created_at ELSE p.posted_at END';
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
export type HistoricalRefundAttempt={source:{type:'LEGACY_MYSQL';entity:'la_refund_log';id:string};originalNumber:string|null;originalStatus:string|null;recordedAmountCents:string|null;occurredAt:string|null;updatedAt:string|null;channelArrival:'UNKNOWN';reasonCodes:string[]};
export function projectHistoricalRefundAttempts(value:unknown,parentId:string):HistoricalRefundAttempt[]{
 if(value===undefined||value===null)return[];
 if(typeof value==='string'){try{value=JSON.parse(value);}catch{throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Refund attempt source unavailable');}}
 if(!Array.isArray(value))throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Refund attempt source unavailable');
 return value.map(a=>{
  if(a.sourceEntity!=='la_refund_log'||a.sourceRecordId!==parentId||typeof a.sourceId!=='string'||! /^[1-9]\d{0,23}$/.test(a.sourceId))throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Refund attempt parent/source differs');
  const own=a.subjectMatchesParent===true;
  return{source:{type:'LEGACY_MYSQL',entity:'la_refund_log',id:a.sourceId},originalNumber:own&&typeof a.sourceNumber==='string'&&a.sourceNumber?a.sourceNumber:null,originalStatus:own?a.sourceStatus:null,recordedAmountCents:own?exactCents(a.amountCents):null,occurredAt:own?sourceTime(a.createdEpoch):null,updatedAt:own?sourceTime(a.updatedEpoch):null,channelArrival:'UNKNOWN',reasonCodes:own?[]:['SOURCE_SUBJECT_MISMATCH']};
 });
}
export type ObservationMapping={userId:string;legacyUserId:string;sourceSystem:string;basisId:string|null;openingAdmission?:{sourceDigest:string;included:boolean;cutoff:string}};
export function prepareHistoricalObservation(row:Record<string,unknown>,mapping:ObservationMapping) {
  const entity=row.kind==="earningsLog"?"la_log_earnings":row.kind==="historicalDistribution"?"la_distribution_order":row.kind==="withdrawObservation"?"la_withdraw_apply":row.kind==="paymentObservation"?"la_pay_order":row.kind==="refundObservation"?"la_refund_record":null;
  if(!entity || String(row.sourceUserId)!==mapping.legacyUserId || !Number.isSafeInteger(row.sourceId) || Number(row.sourceId)<=0)throw invalid("Historical subject/source mismatch");
  sourceYuanToCents(row.amount);
  if(entity==='la_log_earnings'){
    if(row.action!==1&&row.action!==2)throw invalid('Historical direction unknown');
    sourceSignedYuanToCents(row.leftAmount);
  }else if(entity==='la_distribution_order'){
    if(![1,2,3].includes(row.sourceStatus as number))throw invalid('Historical distribution status unknown');
  }else if(entity==='la_pay_order'||entity==='la_refund_record'){
    if(!Number.isSafeInteger(row.sourceStatus)||Number(row.sourceStatus)<0||Number(row.sourceStatus)>999||entity==='la_pay_order'&&![0,1].includes(Number(row.sourceStatus))||row.channelArrival!=='UNKNOWN')throw invalid('Historical payment/refund source status unknown');
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
  return {...subject,sourceType:"LEGACY_MYSQL",sourceEntity:entity,sourceId:String(row.sourceId),sourceKind:entity==="la_log_earnings"?"HISTORICAL_EARNINGS_LOG":entity==="la_distribution_order"?"HISTORICAL_DISTRIBUTION":entity==="la_pay_order"?"HISTORICAL_PAYMENT":entity==="la_refund_record"?"HISTORICAL_REFUND":"HISTORICAL_WITHDRAWAL",sourceCanonical,sourceDigest,includedInOpening:admission?.included??false,sourceEventAt};
}
async function ready(client:PoolClient,userId:string){
  const schema=(await client.query(`SELECT to_regclass('zzsh_order.wallet_coverage') IS NOT NULL AND to_regclass('zzsh_order.personal_finance_observation') IS NOT NULL AND to_regclass('zzsh_order.wallet_revision') IS NOT NULL AS ready`)).rows[0];
  if(schema?.ready!==true)throw new SecurityApiError(503,"EVIDENCE_UNAVAILABLE","Wallet read schema is not available");
  if(!(await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR SHARE`,[userId])).rowCount)throw notFound();
}
/** Available already excludes reserved ledger money. This amount never grants KYC, target or channel eligibility. */
async function readWalletWithdrawalAmount(client:PoolClient,userId:string,input:{coverageKnown:boolean;revisionKnown:boolean;available:string|null;reserved:string|null},knownRecovery?:Awaited<ReturnType<typeof readReferralRecovery>>){
 const unknown=(reason:string)=>({...money(null),reasonCodes:[reason]});
 if(!input.coverageKnown||input.available===null||input.reserved===null)return unknown('SOURCE_COVERAGE_UNKNOWN');
 if(!input.revisionKnown)return unknown('WALLET_REVISION_UNAVAILABLE');
 const installed=(await client.query(`/* wallet withdrawal amount schema */ SELECT to_regclass('zzsh_order.withdrawal_intent') IS NOT NULL AS controlled,
  to_regclass('zzsh_order.joinpay_withdrawal_intent') IS NOT NULL AS channel,
  (EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid=to_regclass('zzsh_order.finance_economic_root')
      AND conname='production_no_local_controlled_root' AND contype='c' AND convalidated)
    AND to_regclass('zzsh_order.withdrawal_intent') IS NULL
    AND to_regclass('zzsh_order.withdrawal_admission') IS NULL
    AND to_regclass('zzsh_order.withdrawal_destination') IS NULL
    AND to_regclass('zzsh_order.withdrawal_provider_fact') IS NULL
    AND to_regclass('zzsh_order.controlled_payout_operation') IS NULL
    AND to_regclass('zzsh_order.controlled_payout_notice') IS NULL
    AND to_regprocedure('zzsh_order.withdrawal_expected_lines(text)') IS NULL) AS production`)).rows[0];
 if(installed?.channel!==true||(installed.controlled!==true&&installed.production!==true))return unknown('WITHDRAWAL_RESERVATION_SOURCE_NOT_INSTALLED');
 const reservation=(await client.query(`/* wallet withdrawal amount reservations */ SELECT COALESCE(sum(gross_cents),0)::text AS reserved,
  count(*) FILTER(WHERE gross_cents IS NULL OR gross_cents<=0)::text AS invalid FROM (
   SELECT gross_cents FROM zzsh_order.joinpay_withdrawal_intent WHERE user_id=$1 AND funds_disposition='RESERVED'
   ${installed.controlled===true?"UNION ALL SELECT gross_cents FROM zzsh_order.withdrawal_intent WHERE user_id=$1 AND funds_disposition='RESERVED'":""}
  ) active`,[userId])).rows[0];
 if(!reservation||reservation.invalid!=='0'||typeof reservation.reserved!=='string'||! /^(0|[1-9]\d{0,23})$/.test(reservation.reserved)||reservation.reserved!==input.reserved)return unknown('WITHDRAWAL_RESERVATION_REQUIRES_RECONCILIATION');
 let recovery:Awaited<ReturnType<typeof readReferralRecovery>>;
 try{recovery=knownRecovery??await readReferralRecovery(client,userId);}catch(error){if(!(error instanceof SecurityApiError&&error.status===503))throw error;return unknown('WITHDRAWAL_RECOVERY_REQUIRES_RECONCILIATION');}
 if(recovery.knowledge!=='KNOWN')return unknown(recovery.reason);
 // The existing writer blocks a fresh withdrawal while any confirmed referral recovery remains; no debt is silently debited here.
 const blocked=recovery.outstandingCents!=='0'||recovery.earningCount!=='0';
 return {...money(blocked?'0':input.available,'POSTED_LEDGER_ONLY'),reasonCodes:[...(blocked?['WITHDRAWAL_BLOCKED_BY_RECOVERY']:[]),'CURRENT_APPLICATION_CHECKS_REQUIRED']};
}
export async function readPersonalWallet(client:PoolClient,userId:string,nativeScope?:NativeWithdrawalScope){
  await ready(client,userId);
  const c=(await client.query(`SELECT c.origin,b.source_cutoff AS "cutoff",b.source_digest AS "sourceDigest",b.covered_set_digest AS "coveredSetDigest",c.coverage_version::text AS "coverageVersion" FROM zzsh_order.wallet_coverage c JOIN zzsh_order.finance_opening_basis b ON b.id=c.basis_id AND b.user_id=c.user_id WHERE c.user_id=$1`,[userId])).rows[0];
  const revision=(await client.query(`SELECT ledger_revision::text AS "ledgerRevision",read_revision::text AS "readRevision" FROM zzsh_order.wallet_revision WHERE user_id=$1`,[userId])).rows[0];
  const r=revision??{ledgerRevision:"0",readRevision:"0"};
  /* A native genesis subject uses the stricter native bucket aggregate instead; never scan the ledger twice. */
  const native=c?.origin==='NATIVE_GENESIS'?await readNativeWalletBuckets(client,userId):null;
  if(c?.origin==='NATIVE_GENESIS'&&!native)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Native wallet origin is not closed');
  const totals=native?null:(await client.query(`SELECT COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code IN('OWNER_AVAILABLE','WALLET_AVAILABLE')),0)::text AS available,
   COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code='WALLET_RESERVED'),0)::text AS reserved,
   COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code='WALLET_PENDING_EARNINGS'),0)::text AS pending,
   COALESCE(sum(credit_cents-debit_cents) FILTER(WHERE account_code='RENTER_REFUND_PAYABLE'),0)::text AS refund
   FROM zzsh_order.settlement_ledger_entry WHERE counterparty_user_id=$1`,[userId])).rows[0];
  if(!native){if(!totals)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Wallet ledger aggregate unavailable');
  if(c)for(const k of ['available','reserved','pending','refund'])if(BigInt(exactCents(totals[k]))<0n)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Wallet ledger requires reconciliation');}
  const nativeWithdrawal=nativeScope?await readNativeReservationStatus(client,userId,nativeScope):undefined;
  const withdrawable=await readWalletWithdrawalAmount(client,userId,{coverageKnown:!!c,revisionKnown:!!revision,available:native?.available.amountCents??(c?exactCents(totals.available):null),reserved:native?.reserved.amountCents??(c?exactCents(totals.reserved):null)},nativeWithdrawal?.recovery);
  return {...(nativeScope?{nativeWithdrawal}:{}),contractVersion:FINANCE_READ_VERSION,subjectId:userId,asOf:new Date().toISOString(),currency:"CNY",coverage:c?{knowledge:"KNOWN",...c}:{knowledge:"UNKNOWN",reason:"SOURCE_COVERAGE_NOT_ADMITTED"},...r,snapshotVersion:`${r.ledgerRevision}:${r.readRevision}:${c?.coverageVersion??"0"}`,buckets:native??{available:money(c?exactCents(totals.available):null,c?'POSTED_LEDGER_ONLY':undefined),reserved:money(c?exactCents(totals.reserved):null,c?'POSTED_LEDGER_ONLY':undefined),restricted:money(null),pendingEarnings:money(c?exactCents(totals.pending):null,c?'POSTED_LEDGER_ONLY':undefined),refundPayable:money(c?exactCents(totals.refund):null,c?'POSTED_LEDGER_ONLY':undefined)},withdrawable};
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
export function decodeFinanceCursor(token:string,binding:CursorBinding,key:ListingCursorKey|undefined){requireListingCursorKey(key);try{if(token.length>4096||!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token))throw Error();const [bytes,sig]=token.split(".") as [string,string];const actual=Buffer.from(sig,"base64url"),expected=createHmac("sha256",key.secret).update(bytes).digest();if(actual.toString("base64url")!==sig||Buffer.from(bytes,"base64url").toString("base64url")!==bytes||actual.length!==expected.length||!timingSafeEqual(actual,expected))throw Error();const value=JSON.parse(Buffer.from(bytes,"base64url").toString());if(value.audience!==FINANCE_READ_VERSION||value.keyId!==key.keyId)throw Error();for(const [k,v]of Object.entries(binding))if(value[k]!==v)throw conflict("Wallet identity or snapshot changed; reload first page");for(const d of [value.asOf,value.position?.at])if(typeof d!=="string"||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{6}Z$/.test(d))throw Error();if(typeof value.position.id!=="string"||value.position.id.length>200)throw Error();return value as {asOf:string;position:{at:string;id:string}};}catch(e){if(e instanceof SecurityApiError&&e.status===409)throw e;throw invalid("Invalid wallet cursor");}}
/** Ledger/history branches stay the single source of truth for the union and for the prefix-routed detail read. */
/* A user-visible wallet entry is a movement of the user's own spendable balance. The counterparty legs of
 * one business — WALLET_RESERVED holds for a withdrawal, WALLET_PENDING_EARNINGS accruals for a commission —
 * are internal counters, not balance movements: listing them made one successful withdrawal look like three
 * rows (reserve debit, reserve credit, payout debit) and made an un-settled commission look like wallet
 * income. They stay in the posted ledger and in the wallet bucket aggregates, never in this entry list.
 * The legacy history branch keeps its rows; zero-amount observations and the opening basis are filtered by
 * the page below. */
const ledgerEntrySelect=(version:1|2, listOnly=false)=>`SELECT 'ledger:'||l.id AS id,l.created_at AS at,l.created_at AS imported_at,${FINANCE_LEDGER_POSTED_AT_SQL} AS posted_at,l.created_at AS recorded_at,
 CASE WHEN l.account_code='RENTER_REFUND_PAYABLE' THEN 'REFUND_PAYABLE' ${version===2?"WHEN l.account_code='WALLET_RESERVED' THEN 'RESERVED' WHEN l.account_code='WALLET_PENDING_EARNINGS' THEN 'PENDING_EARNINGS' ":''}ELSE 'AVAILABLE' END AS bucket,
 (l.credit_cents-l.debit_cents)::text AS delta,'POSTED' AS kind,false AS included,
 CASE WHEN e.kind='OPENING' THEN 'OPENING' WHEN root.source_kind='LOCAL_CONTROLLED_RENTAL_REFUND' THEN 'CONTROLLED_RENTAL_REFUND' WHEN root.source_kind='LOCAL_CONTROLLED_WITHDRAWAL' THEN 'CONTROLLED_WITHDRAWAL_'||e.kind WHEN root.source_kind='NATIVE_RENTAL_REFERRAL' THEN 'NATIVE_REFERRAL_'||e.kind WHEN root.source_kind='NATIVE_GUARANTEE' THEN 'OWNER_GUARANTEE_'||e.kind WHEN l.finance_event_id IS NOT NULL THEN e.kind ELSE 'NATIVE_SETTLEMENT' END AS source_kind,
 COALESCE(root.source_id,l.posting_id) AS source_id,NULL::text AS balance_after,
 CASE WHEN l.finance_event_id IS NOT NULL THEN root.source_type ELSE 'NATIVE' END AS source_type,COALESCE(root.source_system,'zzsh') AS source_system,
 CASE WHEN l.finance_event_id IS NOT NULL THEN root.source_entity ELSE 'settlement_posting' END AS source_entity,
 COALESCE(p.order_id,CASE WHEN root.source_kind='LEGACY_CONTINUATION_DUTY' THEN l.details->>'legacyOrderId' WHEN root.source_kind='LOCAL_CONTROLLED_RENTAL_REFUND' THEN l.details->>'orderId' WHEN root.source_kind='NATIVE_RENTAL_REFERRAL' THEN root.source_id ELSE NULL END) AS business_id,
 CASE WHEN root.source_kind='LEGACY_CONTINUATION_DUTY' THEN l.details->>'legacyOrderNumber' ELSE NULL END AS business_no,
 CASE WHEN root.source_kind='LEGACY_CONTINUATION_DUTY' THEN 'LEGACY_ORDER' WHEN p.order_id IS NOT NULL OR root.source_kind IN('NATIVE_RENTAL_REFERRAL','LOCAL_CONTROLLED_RENTAL_REFUND') THEN 'RENTAL_ORDER' ELSE 'UNKNOWN' END AS business_type${version===2?",NULL::text AS source_status,NULL::text AS source_number,NULL::text AS source_order_type,NULL::text AS source_ratio,NULL::text AS source_level,NULL::text AS reference_type,NULL::text AS recorded_amount,NULL::text AS source_paid_at,NULL::text AS association_state,NULL::text AS association_reason,NULL::jsonb AS source_attempts,NULL::jsonb AS source_refund_flags,NULL::text AS source_record_type":''}
 FROM zzsh_order.settlement_ledger_entry l LEFT JOIN zzsh_order.finance_event e ON e.id=l.finance_event_id LEFT JOIN zzsh_order.finance_economic_root root ON root.id=e.economic_root_id LEFT JOIN zzsh_order.settlement_posting p ON p.id=l.posting_id
 WHERE l.counterparty_user_id=$1 AND l.account_code IN ('OWNER_AVAILABLE','WALLET_AVAILABLE','RENTER_REFUND_PAYABLE'${!listOnly&&version===2?",'WALLET_RESERVED','WALLET_PENDING_EARNINGS'":''})`;
/* source_kind mirrors source_entity one-to-one (guard_finance_observation + immutable trigger), so the kind predicate is exact and index-friendly. */
const historyEntrySelect=(version:1|2=1)=>`SELECT 'history:'||o.id AS id,o.source_event_at AS at,o.imported_at AS imported_at,${version===2?"CASE WHEN o.source_kind='HISTORICAL_EARNINGS_LOG' THEN o.source_event_at ELSE NULL END":'o.source_event_at'} AS posted_at,o.imported_at AS recorded_at,'AVAILABLE' AS bucket,
 ((o.snapshot->>'amount')::numeric*100*(CASE ${version===2?"WHEN o.source_kind IN('HISTORICAL_PAYMENT','HISTORICAL_WITHDRAWAL','HISTORICAL_DISTRIBUTION','HISTORICAL_REFUND') THEN 0 ":''}WHEN o.snapshot->>'action'='1' THEN 1 WHEN o.snapshot->>'action'='2' THEN -1 ELSE NULL END))::numeric(24,0)::text AS delta,
 'HISTORICAL' AS kind,COALESCE(oa.included_in_opening,o.included_in_opening) AS included,o.source_kind,o.source_id,((o.snapshot->>'leftAmount')::numeric*100)::numeric(24,0)::text AS balance_after,
 o.source_type,o.source_system,o.source_entity,o.snapshot->>'referenceId' AS business_id,NULLIF(o.snapshot->>'referenceSn','') AS business_no,${version===2?"COALESCE(o.snapshot->>'referenceType','LEGACY_UNRESOLVED')":"'LEGACY_UNRESOLVED'"} AS business_type${version===2?",o.snapshot->>'sourceStatus' AS source_status,COALESCE(NULLIF(o.snapshot->>'sourceNumber',''),NULLIF(o.snapshot->>'referenceSn','')) AS source_number,o.snapshot->>'sourceOrderType' AS source_order_type,NULLIF(o.snapshot->>'sourceRatio','') AS source_ratio,o.snapshot->>'level' AS source_level,o.snapshot->>'referenceType' AS reference_type,((o.snapshot->>'amount')::numeric*100)::numeric(24,0)::text AS recorded_amount,COALESCE(o.snapshot->>'sourcePaidAt',o.snapshot->>'sourceSettlementTime') AS source_paid_at,o.snapshot->>'associationState' AS association_state,o.snapshot->>'associationReason' AS association_reason,o.snapshot->'sourceAttempts' AS source_attempts,o.snapshot->'sourceRefundFlags' AS source_refund_flags,o.snapshot->>'sourceRecordType' AS source_record_type":''}
 FROM zzsh_order.personal_finance_observation o ${OPENING_OBSERVATION_JOIN} WHERE o.user_id=$1 ${version===1?"AND o.source_kind='HISTORICAL_EARNINGS_LOG' AND o.source_entity='la_log_earnings'":"AND o.source_kind IN('HISTORICAL_EARNINGS_LOG','HISTORICAL_DISTRIBUTION','HISTORICAL_WITHDRAWAL','HISTORICAL_PAYMENT','HISTORICAL_REFUND')"}`;
const entrySql=(version:1|2=1)=>`WITH entries AS (
 ${ledgerEntrySelect(version,true)}
 UNION ALL ${historyEntrySelect(version)}
 )`;
/* Totals and the page share one materialization of entries in a single statement, keeping both on one snapshot. */
const entriesPageSql=(version:1|2)=>entrySql(version)+`,scoped AS (
 SELECT * FROM entries WHERE imported_at<=$2::timestamptz AND ($3='ALL' OR bucket=$3)
  AND COALESCE(source_kind,'')<>'OPENING'
  AND NOT (kind='HISTORICAL' AND delta::numeric=0)
 ),totals AS (
 SELECT bucket,count(*)::text AS count,COALESCE(sum(delta::numeric) FILTER(WHERE kind='POSTED'),0)::text AS "postedNetCents",COALESCE(sum(delta::numeric) FILTER(WHERE kind='HISTORICAL' AND source_kind='HISTORICAL_EARNINGS_LOG' AND included),0)::text AS "coveredHistoricalNetCents",COALESCE(sum(delta::numeric) FILTER(WHERE kind='HISTORICAL' AND source_kind='HISTORICAL_EARNINGS_LOG' AND NOT included),0)::text AS "uncoveredHistoricalNetCents",count(*) FILTER(WHERE kind='HISTORICAL' AND source_kind='HISTORICAL_EARNINGS_LOG' AND included)::text AS "coveredCount",count(*) FILTER(WHERE kind='HISTORICAL' AND source_kind='HISTORICAL_EARNINGS_LOG' AND NOT included)::text AS "uncoveredCount" FROM scoped GROUP BY bucket
 ),page AS (
 SELECT *,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS sort_at,to_char(at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS at_text,to_char(imported_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS imported_at_text,to_char(posted_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS posted_at_text,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS recorded_at_text FROM scoped WHERE ($4::timestamptz IS NULL OR (at,id COLLATE "C")<($4::timestamptz,$5 COLLATE "C")) ORDER BY at DESC,id COLLATE "C" DESC LIMIT $6
 )
 SELECT COALESCE((SELECT json_agg(json_build_object('bucket',t.bucket,'count',t.count,'postedNetCents',t."postedNetCents",'coveredHistoricalNetCents',t."coveredHistoricalNetCents",'uncoveredHistoricalNetCents',t."uncoveredHistoricalNetCents",'coveredCount',t."coveredCount",'uncoveredCount',t."uncoveredCount") ORDER BY t.bucket)::text FROM totals t),'[]') AS totals_json,
 COALESCE((SELECT json_agg(json_build_object('id',p.id,'at',p.at_text,'imported_at',p.imported_at_text,'posted_at',p.posted_at_text,'recorded_at',p.recorded_at_text,'bucket',p.bucket,'delta',p.delta,'kind',p.kind,'included',p.included,'source_kind',p.source_kind,'source_id',p.source_id,'balance_after',p.balance_after,'source_type',p.source_type,'source_system',p.source_system,'source_entity',p.source_entity,'business_id',p.business_id,'business_no',p.business_no,'business_type',p.business_type,'sort_at',p.sort_at${version===2?",'source_status',p.source_status,'source_number',p.source_number,'source_order_type',p.source_order_type,'source_ratio',p.source_ratio,'source_level',p.source_level,'reference_type',p.reference_type,'recorded_amount',p.recorded_amount,'source_paid_at',p.source_paid_at,'association_state',p.association_state,'association_reason',p.association_reason,'source_attempts',p.source_attempts,'source_refund_flags',p.source_refund_flags,'source_record_type',p.source_record_type":''}) ORDER BY p.at DESC,p.id COLLATE "C" DESC)::text FROM page p),'[]') AS page_json`;
const timestamp=(value:unknown):string|null=>value instanceof Date?value.toISOString():typeof value==='string'&&Number.isFinite(Date.parse(value))?value:null;
const sourceTime=(value:unknown):string|null=>typeof value==='string'&&/^[1-9]\d{0,9}$/.test(value)&&Number(value)<=4294967295?new Date(Number(value)*1000).toISOString():null;
function entry(row:any){return {schemaVersion:1,id:row.id,occurredAt:row.at,importedAt:row.imported_at,postedAt:timestamp(row.posted_at),recordedAt:timestamp(row.recorded_at),bucket:row.bucket,deltaCents:exactCents(row.delta),kind:row.kind,includedInOpening:row.included,sourceKind:row.source_kind,sourceId:row.source_id,source:{type:row.source_type,system:row.source_system,entity:row.source_entity,id:row.source_id},businessReference:{type:row.business_type,id:row.business_id??null,number:row.business_no??null},...(row.source_status!==undefined&&row.source_kind!=='HISTORICAL_EARNINGS_LOG'&&row.kind==='HISTORICAL'?{sourceDetails:{originalType:row.source_record_type??null,attempts:projectHistoricalRefundAttempts(row.source_attempts,row.source_id),reasonCodes:typeof row.source_refund_flags==='string'?JSON.parse(row.source_refund_flags):row.source_refund_flags??[],associationState:row.association_state??null,associationReason:row.association_reason??null,recordedAmountCents:exactCents(row.recorded_amount),sourcePaidAt:sourceTime(row.source_paid_at),originalStatus:row.source_status,originalNumber:row.source_number,originalOrderType:row.source_order_type,originalRatio:row.source_ratio,originalLevel:row.source_level,channelArrival:'UNKNOWN',affectsCurrentWallet:false}}:{}),balanceAfterCents:row.balance_after===null?null:exactCents(row.balance_after)};}
export async function readPersonalFinanceEntries(client:PoolClient,actor:{userId:string;sessionId:string},q:FinanceQuery,key:ListingCursorKey|undefined){
  const version=q.projectionVersion??1;if(![1,2].includes(version)||version===1&&['RESERVED','PENDING_EARNINGS'].includes(q.bucket))throw invalid('Wallet bucket requires projection 2');
  const wallet=await readPersonalWallet(client,actor.userId);
  const ledgerOnly=version===2&&['RESERVED','PENDING_EARNINGS'].includes(q.bucket);
  const native=!ledgerOnly&&wallet.coverage.knowledge==='KNOWN'&&'origin' in wallet.coverage&&wallet.coverage.origin==='NATIVE_GENESIS'?await hasProvedNativeHistoryAbsence(client,actor.userId,'HISTORICAL_EARNINGS_LOG'):false;
  let historyCoverage:{knowledge:'KNOWN'|'UNKNOWN';reason:string;count:string|null;cutoff:string|null;version:string|null}=ledgerOnly?{knowledge:'KNOWN' as const,reason:'POSTED_LEDGER_SCOPE',count:'0',cutoff:null,version:'LEDGER:'+wallet.snapshotVersion}:native?{knowledge:'KNOWN' as const,reason:'PROVED_NATIVE_HISTORY_ABSENCE',count:'0',cutoff:null,version:'NATIVE_GENESIS'}:await readObservationCoverage(client,actor.userId,'HISTORICAL_EARNINGS_LOG');
  if(version===2&&!ledgerOnly){
    const sources=[historyCoverage];
    for(const kind of ['HISTORICAL_DISTRIBUTION','HISTORICAL_WITHDRAWAL','HISTORICAL_PAYMENT','HISTORICAL_REFUND'] as const)sources.push(native&&await hasProvedNativeHistoryAbsence(client,actor.userId,kind)?{knowledge:'KNOWN',reason:'PROVED_NATIVE_HISTORY_ABSENCE',count:'0',cutoff:null,version:'NATIVE_GENESIS'}:await readObservationCoverage(client,actor.userId,kind));
    const unknown=sources.find(s=>s.knowledge!=='KNOWN'),cutoffs=new Set(sources.map(s=>s.cutoff));
    const combinedVersion=sources.every(s=>s.reason==='PROVED_NATIVE_HISTORY_ABSENCE'&&s.version==='NATIVE_GENESIS')?'NATIVE_GENESIS':'HISTORY5:'+hash(canonicalize(sources.map(s=>[s.version,s.cutoff,s.knowledge,s.reason,s.count])));
    historyCoverage={...historyCoverage,knowledge:unknown||cutoffs.size>1?'UNKNOWN':'KNOWN',reason:unknown?.reason??(cutoffs.size>1?'HISTORICAL_COVERAGE_OUTDATED':historyCoverage.reason),version:combinedVersion,cutoff:cutoffs.size===1?historyCoverage.cutoff:null};
  }
  const binding={userId:actor.userId,sessionHash:hash(actor.sessionId),snapshotVersion:wallet.snapshotVersion,bucket:'WALLET_ENTRIES:'+(version===2?'v2:':'')+q.bucket+':'+historyCoverage.version};
  const after=q.cursor?decodeFinanceCursor(q.cursor,binding,key):null;
  const asOf=after?.asOf??(await client.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS at`)).rows[0].at;
  const bundle=(await client.query(entriesPageSql(version),[actor.userId,asOf,q.bucket,after?.position.at??null,after?.position.id??null,q.limit+1])).rows[0];
  const totals=JSON.parse(bundle?.totals_json??'[]') as {bucket:string;count:string;postedNetCents:string;coveredHistoricalNetCents:string;uncoveredHistoricalNetCents:string;coveredCount:string;uncoveredCount:string}[];
  const rows=(JSON.parse(bundle?.page_json??'[]') as any[]).map(r=>({...r,included:r.included===true||(r.included as unknown)===1}));
  const byBucket=totals.map(t=>({...t,postedNetCents:exactCents(t.postedNetCents),coveredHistoricalNetCents:exactCents(t.coveredHistoricalNetCents),uncoveredHistoricalNetCents:exactCents(t.uncoveredHistoricalNetCents)}));
  const count=totals.reduce((n,t)=>n+BigInt(t.count),0n).toString(),hasUncovered=totals.some(t=>BigInt(t.uncoveredCount)>0n),hasCovered=totals.some(t=>BigInt(t.coveredCount)>0n);
  const more=rows.length>q.limit,visible=rows.slice(0,q.limit),last=visible.at(-1);
  return {contractVersion:FINANCE_READ_VERSION,...(version===2?{projectionVersion:2 as const}:{}),subjectId:actor.userId,asOf,snapshotVersion:wallet.snapshotVersion,coverage:wallet.coverage,listCoverage:{knowledge:historyCoverage.knowledge,count:historyCoverage.knowledge==='KNOWN'?count:null,mappedRecordCount:count,reason:historyCoverage.reason,cutoff:historyCoverage.cutoff,version:historyCoverage.version,...(ledgerOnly?{scope:'POSTED_LEDGER_ONLY' as const}:{})},bucket:q.bucket,items:visible.map(entry),totals:{count,byBucket,historicalCoverage:hasUncovered?(hasCovered?'MIXED':'NOT_INCLUDED'):hasCovered?'INCLUDED':'NO_HISTORY',meaning:hasUncovered?'Uncovered historical facts do not change the current wallet':'Covered historical facts are already represented by the opening; do not add them again'},nextCursor:more&&last?encodeFinanceCursor({at:last.sort_at,id:last.id},asOf,binding,key):null};
}
/* The qualified id prefix selects its source branch exactly once; the raw id is the branch primary key. */
export async function readPersonalFinanceEntry(client:PoolClient,userId:string,id:string,projectionVersion:1|2=1){if(![1,2].includes(projectionVersion))throw invalid('Unsupported finance projection version');const wallet=await readPersonalWallet(client,userId);if(!/^(ledger|history):[A-Za-z0-9_-]{1,180}$/.test(id))throw notFound();const separator=id.indexOf(':'),rawId=id.slice(separator+1);const source=id.startsWith('ledger:')?ledgerEntrySelect(projectionVersion)+` AND l.id=$2`:historyEntrySelect(projectionVersion)+` AND o.id=$2`;const row=(await client.query(source,[userId,rawId])).rows[0];if(!row)throw notFound();return {contractVersion:FINANCE_READ_VERSION,...(projectionVersion===2?{projectionVersion:2 as const}:{}),subjectId:userId,asOf:wallet.asOf,snapshotVersion:wallet.snapshotVersion,coverage:wallet.coverage,entry:entry(row)};}
