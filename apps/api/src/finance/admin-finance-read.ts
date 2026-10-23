import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { PoolClient } from "pg";
import { SecurityApiError } from "../auth/security-core";
import { canonicalize } from "../supply/content-hash";
import { invalid, notFound } from "../supply/supply-util";
import { requireListingCursorKey, type ListingCursorKey } from "../supply/listing-cursor";
import { exactCents, sourceYuanToCents, sourceSignedYuanToCents, readPersonalWallet,OPENING_OBSERVATION_JOIN,FINANCE_LEDGER_POSTED_AT_SQL } from "./personal-finance-read";
import { loadFinanceOrderFacts, type FinanceOrderFact } from "./admin-finance-order-read";
import { scopedFinanceSql, financeVersionSql, financeLookupPageSql,FINANCE_LEDGER_BUCKET_SQL, type FinanceLoadScope } from "./admin-finance-query";
import {prepareOwnerGuaranteeHistory} from './owner-guarantee-history';
import { historicalObservationDisplay,enrichHistoricalObservations,resolveHistoricalReverseLinks,type HistoricalFinanceDisplay,type HistoricalRelationAccess } from './legacy-observation-display';
import type {FinancePeriodBasis} from './admin-finance-period-basis';
import {readAdminEarningCalculations,readAdminEarningEventActions,type AdminEarningCalculation} from './distribution-earning-read';
export {readAdminFinancePeriodBasis} from './admin-finance-period-basis';
export type { HistoricalFinanceDisplay,HistoricalRelationAccess } from './legacy-observation-display';

export const ADMIN_FINANCE_VERSION = "admin-finance.read.v1";
export const FINANCE_BUCKETS = ["AVAILABLE", "RESERVED", "GUARANTEE_HELD", "REFUND_PAYABLE", "PENDING_EARNINGS", "PLATFORM", "CLEARING"] as const;
export type FinanceBucket = typeof FINANCE_BUCKETS[number];
export type FinanceFilters = { scope: string; from: string; to: string; period: boolean; bucket: FinanceBucket | "ALL"; kind: string; state: string; q: string };
export type FinanceActor = { userId: string; sessionId: string; authorizationKey: string };
export type FinanceEntry = {
  id: string; documentRef: string; documentNumber: string; subjectId: string; subjectName: string;
  bucket: FinanceBucket; direction: "IN" | "OUT" | "UNKNOWN"; deltaCents: string | null;
  knowledge: "KNOWN" | "UNKNOWN"; kind: string; state: string; classification: string;
  affectsCurrentWallet: boolean; affectsCurrentLedger: boolean; occurredAt: string | null; importedAt: string; sourceType: string;
  sourceEntity: string; sourceSystem: string; sourceId: string; sourceDigest: string | null; basisId: string | null;
  reasonCodes: string[]; accountCode: string | null; evidence: Record<string, string | null>;
  related: { ref: string; label: string; path?: string }[];
  historical?: HistoricalFinanceDisplay;
};
export type FinanceFacts = { historicalLinks?:Record<string,ReturnType<typeof resolveHistoricalReverseLinks>>;distributionCalculation?:AdminEarningCalculation;entries: FinanceEntry[]; subjects: { id: string; name: string }[]; revisions: unknown[]; withdrawalsReady: boolean; nativeDistributionReady?:boolean; orders?: FinanceOrderFact[]; subjectCandidates?: {items:{id:string;name:string}[];total:number}; lookupPage?: {refs: string[]; documentCount: number; entryCount: number}; asOf: string; version: string };
const MAX_FACTS = 20_000;
const digest = (value: unknown) => createHash("sha256").update(canonicalize(value)).digest("hex");
const singleText=(values:(string|null|undefined)[])=>{const unique=[...new Set(values.filter((v):v is string=>typeof v==='string'))];return unique.length===1?unique[0]!:null;};
const utc = (column: string) => `to_char(${column} AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
const stale = () => new SecurityApiError(409, "CONFLICT", "Finance snapshot changed; reload", [{ path: "snapshot", code: "INVALID_FIELD" }]);
const unavailable = (message: string) => new SecurityApiError(503, "EVIDENCE_UNAVAILABLE", message);

function day(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw invalid("Invalid finance date");
  const date = new Date(value + "T00:00:00Z");
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== value) throw invalid("Invalid finance date");
  return value;
}
function hasPhoneQuery(value:string){
  const text=value.normalize('NFKC'),phone=/(?<!\d)(?:\+?86[\s.()-]*)?1[\s.()-]*[3-9](?:[\s.()-]*\d){9}(?!\d)/u;
  let reference=text;
  if(text.includes('://'))try{
    const url=new URL(text),match=/^\/(?:users|orders|finance\/users|finance\/documents)\/([^/]+)$/.exec(url.pathname);
    if(match&&!url.search&&!url.hash&&!url.username&&!url.password&&!phone.test(url.origin))reference=decodeURIComponent(match[1]!);
  }catch{}
  const id=reference.replace(/^(?:ORDER|LEGACY_ORDER|ORDER_LINK):/,'');
  if(/^(?:(?:user|order|legacy_order|account)_(?:[a-f0-9]{32}|[a-f0-9]{40})|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i.test(id))return false;
  return phone.test(text);
}
export function parseAdminFinanceFilters(query: URLSearchParams, now = new Date(), periodRequired = true): FinanceFilters {
  for (const key of query.keys()) if (!["scope", "from", "to", "period", "bucket", "kind", "state", "q", "snapshot", "page", "pageSize", "entry"].includes(key) || query.getAll(key).length !== 1) throw invalid("Unsupported or repeated finance filter");
  const today = new Date(now.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
  const from = day(query.get("from") ?? today), to = day(query.get("to") ?? today);
  if (from > to || Date.parse(to) - Date.parse(from) > 366 * 86400_000) throw invalid("Finance period must be at most 367 days");
  const scope = query.get("scope") ?? "ALL", bucket = query.get("bucket") ?? "ALL";
  if (scope !== "ALL" && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(scope)) throw invalid("Invalid finance subject");
  if (bucket !== "ALL" && !(FINANCE_BUCKETS as readonly string[]).includes(bucket)) throw invalid("Invalid finance bucket");
  const kind = query.get("kind") ?? "ALL", state = query.get("state") ?? "ALL", q = (query.get("q") ?? "").trim();
  if (!/^(ALL|OPENING|SETTLEMENT|WITHDRAWAL|REFUND|EARNINGS|DISTRIBUTION|GUARANTEE)$/.test(kind) || !["ALL", "POSTED", "PENDING", "SETTLED", "REVOKED", "RECOVERY_REQUIRED", "RESERVED", "SUBMITTING", "PROCESSING", "UNKNOWN", "SUCCEEDED", "FAILED", "RECONCILIATION_REQUIRED", "HISTORICAL_OBSERVED", "ORDER_RECORDED", "HISTORICAL_ORDER_RECORDED", "REFUND_PAYABLE_RECORDED"].includes(state) || q.length > 512) throw invalid("Invalid finance query");
  const phoneField=hasPhoneQuery(scope)?'scope':hasPhoneQuery(q)?'q':null;
  if (phoneField) throw invalid("Phone lookup requires the authorized user POST lookup", phoneField);
  const periodValue = query.get("period");
  if (periodValue !== null && !["0", "1"].includes(periodValue) || periodRequired && periodValue === "0") throw invalid("Invalid finance period mode");
  const period = periodRequired || periodValue === "1" || periodValue !== "0" && (query.has("from") || query.has("to"));
  return { scope, from, to, period, bucket: bucket as FinanceFilters["bucket"], kind, state, q };
}
export function resolveFinanceLookup(value: string, origins: readonly string[]): string {
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value) || !value.includes("://")) return value;
  let url: URL; try { url = new URL(value); } catch { throw invalid("Invalid station link"); }
  if (!origins.includes(url.origin) || url.username || url.password || url.hash) throw invalid("Only known station links are supported");
  const match = /^\/(users|orders|finance\/users|finance\/documents)\/([^/]+)$/.exec(url.pathname);
  if (!match || url.search) throw invalid("Unsupported station link");
  try { const id = decodeURIComponent(match[2]!); return match[1] === "orders" ? `ORDER_LINK:${id}` : id; } catch { throw invalid("Invalid station reference"); }
}
function cents(value: unknown, yuan = false): string | null {
  try { return yuan ? sourceYuanToCents(value) : exactCents(value); } catch { return null; }
}
function signedSourceCents(value: unknown): string | null { try { return sourceSignedYuanToCents(value); } catch { return null; } }
function displayName(value: unknown, fallback: string): string { return typeof value !== "string" ? fallback : /^1[3-9]\d{9}$/.test(value) ? value.slice(0, 3) + "****" + value.slice(-4) : value; }
function bucketOf(code: string): FinanceBucket {
  if (["OWNER_AVAILABLE", "WALLET_AVAILABLE"].includes(code)) return "AVAILABLE";
  if (code==='WALLET_RESERVED') return "RESERVED";
  if(code==='GUARANTEE_HELD')return'GUARANTEE_HELD';
  if (code === "WALLET_PENDING_EARNINGS") return "PENDING_EARNINGS";
  if (code === "RENTER_REFUND_PAYABLE") return "REFUND_PAYABLE";
  if (code.startsWith("PLATFORM_") || code === "WITHDRAW_FEE") return "PLATFORM";
  return "CLEARING";
}
export const ADMIN_FINANCE_LEDGER_SQL = `SELECT l.id,l.account_code,l.counterparty_user_id AS subject_id,
  COALESCE(u.name,l.counterparty_user_id,'平台') AS subject_name,(l.credit_cents-l.debit_cents)::text AS delta,
  ${utc(FINANCE_LEDGER_POSTED_AT_SQL)} AS at,${utc("l.created_at")} AS recorded_at,l.finance_event_id,l.posting_id,e.kind AS event_kind,r.source_kind,r.source_type,r.source_system,r.source_entity,r.source_id,r.source_digest,
  r.basis_id,r.id AS economic_root_id,r.beneficiary_role,COALESCE(p.order_id,re.order_id) AS order_id,o.display_no,o.account_id,b.source_cutoff::text AS opening_cutoff,b.covered_count::text AS covered_count,
  re.state AS earning_state,re.beneficiary_role AS earning_role,re.amount_cents::text AS earning_amount,re.funds_disposition AS earning_disposition,re.recovery_required_cents::text AS earning_recovery,${utc("re.due_at")} AS earning_due_at,re.version::text AS earning_version,
  p.payment_confirmation_id,p.settlement_version_id,p.version_hash,p.captured_cents::text,p.renter_refund_cents::text,p.platform_contribution_cents::text,${utc("p.refund_due_at")} AS refund_due_at
  FROM zzsh_order.settlement_ledger_entry l LEFT JOIN zzsh_auth_user."user" u ON u.id=l.counterparty_user_id
  LEFT JOIN zzsh_order.finance_event e ON e.id=l.finance_event_id LEFT JOIN zzsh_order.finance_economic_root r ON r.id=e.economic_root_id
  LEFT JOIN zzsh_order.finance_opening_basis b ON b.id=r.basis_id
  LEFT JOIN zzsh_order.rental_referral_earning re ON re.economic_root_id=r.id AND r.source_kind='NATIVE_RENTAL_REFERRAL'
  LEFT JOIN zzsh_order.settlement_posting p ON p.id=l.posting_id LEFT JOIN zzsh_order.rental_order o ON o.id=COALESCE(p.order_id,re.order_id)
  ORDER BY l.id COLLATE "C" LIMIT $1`;
export function adminFinanceLedgerSql(nativeDistribution:boolean){return nativeDistribution?ADMIN_FINANCE_LEDGER_SQL:ADMIN_FINANCE_LEDGER_SQL
 .replace('COALESCE(p.order_id,re.order_id) AS order_id','p.order_id AS order_id')
 .replace(/re\.state AS earning_state,[\s\S]+?re\.version::text AS earning_version,/,"NULL::text AS earning_state,NULL::text AS earning_role,NULL::text AS earning_amount,NULL::text AS earning_disposition,NULL::text AS earning_recovery,NULL::text AS earning_due_at,NULL::text AS earning_version,")
 .replace(/\s+LEFT JOIN zzsh_order\.rental_referral_earning re[^\n]+/,'')
 .replace('o.id=COALESCE(p.order_id,re.order_id)','o.id=p.order_id');}
export const ADMIN_FINANCE_OBSERVATION_SQL = `SELECT o.id,o.user_id AS subject_id,COALESCE(u.name,o.user_id) AS subject_name,o.source_kind,o.source_type,o.source_system,o.source_entity,o.source_id,o.source_digest,COALESCE(oa.basis_id,o.basis_id) AS basis_id,COALESCE(oa.included_in_opening,o.included_in_opening) AS included_in_opening,
  ${utc("o.source_event_at")} AS at,${utc("o.imported_at")} AS imported_at,
  o.snapshot->>'amount' AS amount,o.snapshot->>'action' AS action,o.snapshot->>'sourceStatus' AS source_status,
  o.snapshot->>'referenceId' AS reference_id,o.snapshot->>'referenceSn' AS reference_no,
  o.snapshot->>'net' AS net,o.snapshot->>'fee' AS fee,o.snapshot->>'leftAmount' AS balance_after,'LEGACY_MYSQL'::text AS observation_origin,jsonb_build_object('snapshot',o.snapshot,'canonical',o.source_canonical,'legacyUserId',o.legacy_user_id) AS extra_evidence
  FROM zzsh_order.personal_finance_observation o ${OPENING_OBSERVATION_JOIN} LEFT JOIN zzsh_auth_user."user" u ON u.id=o.user_id ORDER BY o.id COLLATE "C" LIMIT $1`;
export function adminFinanceObservationSql(ready:{native_distribution?:boolean;earning_transitions?:boolean;legacy_duty_finance?:boolean;guarantee_history?:boolean}){
 if(!ready.native_distribution&&!ready.legacy_duty_finance&&!ready.guarantee_history)return ADMIN_FINANCE_OBSERVATION_SQL;
 const history=ADMIN_FINANCE_OBSERVATION_SQL.replace(/\s+ORDER BY o\.id COLLATE "C" LIMIT \$1\s*$/,'');
 // Only a unique original ACCRUE receipt proves the zero fact's event clock; the root INSERT is trace data.
 const accrual=ready.earning_transitions!==false?`LEFT JOIN LATERAL (SELECT
   CASE WHEN count(*)=1 AND count(fe.id)=1 THEN min(fe.created_at) END AS posted_at,
   CASE WHEN count(*)=1 AND count(fe.id)=1 THEN min(fe.id) END AS event_id
   FROM zzsh_order.rental_referral_transition t LEFT JOIN zzsh_order.finance_event fe ON fe.id=t.finance_event_id
    AND t.expected_version=0 AND t.result_version=1 AND t.source_digest=e.posting_digest
    AND fe.economic_root_id=e.id AND e.economic_root_id=e.id AND fe.subject_user_id=e.beneficiary_user_id AND fe.kind='EARNING_PENDING'
   WHERE t.earning_id=e.id AND t.action='ACCRUE') accrual ON TRUE`:`LEFT JOIN (SELECT NULL::timestamptz AS posted_at,NULL::text AS event_id) accrual ON TRUE`;
 const native=ready.native_distribution?` UNION ALL SELECT 'zero_earning:'||e.id,e.beneficiary_user_id,COALESCE(u.name,e.beneficiary_user_id),'NATIVE_RENTAL_REFERRAL','NATIVE','zzsh','rental_referral_earning',e.id,e.seed_digest,NULL::text,false,
  ${utc('accrual.posted_at')},${utc('e.created_at')},'0'::text,e.beneficiary_role,e.state,e.order_id,NULL::text,NULL::text,NULL::text,NULL::text,'NATIVE_EARNING_ZERO',jsonb_build_object('earningRole',e.beneficiary_role,'earningFundsDisposition',e.funds_disposition,'earningVersion',e.version::text,'dueAt',${utc('e.due_at')},
   'eventId',accrual.event_id,'eventAction',CASE WHEN accrual.posted_at IS NOT NULL THEN 'ACCRUE' END,'eventKind',CASE WHEN accrual.posted_at IS NOT NULL THEN 'EARNING_PENDING' END,'postedAt',${utc('accrual.posted_at')},'recordedAt',${utc('e.created_at')})
  FROM zzsh_order.rental_referral_earning e LEFT JOIN zzsh_auth_user."user" u ON u.id=e.beneficiary_user_id ${accrual} WHERE e.amount_cents=0`:'';
 const legacy=ready.legacy_duty_finance?` UNION ALL SELECT 'zero_duty:'||f.duty_id,f.subject_user_id,COALESCE(u.name,f.subject_user_id),'LEGACY_CONTINUATION_DUTY','LEGACY_CONTINUATION','zzsh','legacy_order_duty',f.duty_id,f.facts_digest,NULL::text,false,
  ${utc('e.created_at')},${utc('f.created_at')},'0'::text,f.kind,'SETTLED',f.order_id,NULL::text,NULL::text,NULL::text,NULL::text,'LEGACY_DUTY_ZERO',jsonb_build_object('zeroFinalReferenceType',f.ref_type,'zeroFinalReferenceId',f.ref_id,'finalFactsDigest',f.facts_digest,
   'eventId',e.id,'eventKind',e.kind,'postedAt',${utc('e.created_at')},'recordedAt',${utc('f.created_at')})
  FROM zzsh_order.legacy_duty_finance_fact f JOIN zzsh_order.finance_event e ON e.id=f.event_id AND e.economic_root_id=f.root_id AND e.kind='LEGACY_DUTY_SETTLED'
  JOIN zzsh_order.legacy_order_duty d ON d.id=f.duty_id AND d.status='SETTLED' AND d.settled_by='FINANCE' AND d.settled_ref_type='FINANCE_EVENT' AND d.settled_ref_id=f.event_id AND d.settled_ref_digest=f.facts_digest
  LEFT JOIN zzsh_auth_user."user" u ON u.id=f.subject_user_id WHERE f.amount_cents=0 AND f.zero_finalization AND NOT EXISTS(SELECT 1 FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=f.event_id)`:'';
 const guarantee=ready.guarantee_history?` UNION ALL SELECT 'guarantee_source:'||g.id,g.user_id,COALESCE(u.name,g.user_id),'OWNER_GUARANTEE_HISTORY','LEGACY_MYSQL','legacy_mysql_restore','la_rental_accounts',g.legacy_account_id,g.source_digest,NULL::text,false,
  NULL::text,${utc('g.imported_at')},NULL::text,'GUARANTEE_HISTORY','HISTORICAL_OBSERVED',NULL::text,g.legacy_account_id,NULL::text,NULL::text,NULL::text,'LEGACY_GUARANTEE_HISTORY',jsonb_build_object('canonical',g.source_canonical,'accountId',g.account_id)
  FROM zzsh_order.legacy_owner_guarantee_observation g LEFT JOIN zzsh_auth_user."user" u ON u.id=g.user_id
  WHERE jsonb_array_length(g.source_canonical::jsonb->'payOrders')>0 OR(g.source_canonical::jsonb->'source'->>'pay_money')::numeric>0`:'';
 return`SELECT o.* FROM (${history}${native}${legacy}${guarantee}) o ORDER BY o.id COLLATE "C" LIMIT $1`;
}
type Raw = Record<string, any>;
export function projectAdminFinanceLedger(row: Raw): FinanceEntry {
  const opening = row.event_kind === "OPENING", withdrawal = row.source_entity === "withdrawal_intent",earning=row.source_kind==='NATIVE_RENTAL_REFERRAL',duty=row.source_kind==='LEGACY_CONTINUATION_DUTY',guarantee=row.source_kind==='NATIVE_GUARANTEE';
  const ref = opening ? `OPENING:${row.basis_id}` : withdrawal ? `WITHDRAWAL:${row.source_id}` : earning?`DISTRIBUTION:${row.economic_root_id}`:duty?`LEGACY_DUTY:${row.source_id}`:guarantee?`${row.source_entity==='owner_guarantee_payment'?'GUARANTEE_PAYMENT':'GUARANTEE_REFUND'}:${row.source_id}`:row.order_id ? `ORDER:${row.order_id}` : `POSTING:${row.posting_id ?? row.id}`;
  const amount = cents(row.delta), type = opening ? "OPENING" : withdrawal ? "WITHDRAWAL" : earning||duty&&row.beneficiary_role==='COMMISSION'?'DISTRIBUTION':guarantee?'GUARANTEE':bucketOf(row.account_code) === "REFUND_PAYABLE" ? "REFUND" : "SETTLEMENT";
  return { id: `ledger:${row.id}`, documentRef: ref, documentNumber: row.display_no ?? (opening ? row.basis_id : row.source_id) ?? row.posting_id ?? row.id,
    subjectId: row.subject_id ?? (bucketOf(row.account_code) === "PLATFORM" ? "PLATFORM" : "SYSTEM"), subjectName: row.subject_id ? displayName(row.subject_name, row.subject_id) : bucketOf(row.account_code) === "PLATFORM" ? "平台" : "对照科目", bucket: bucketOf(row.account_code), direction: amount === null ? "UNKNOWN" : BigInt(amount) < 0n ? "OUT" : "IN",
    deltaCents: amount, knowledge: amount === null ? "UNKNOWN" : "KNOWN", kind: type, state: earning?row.earning_state??'UNKNOWN':type === "REFUND" ? "REFUND_PAYABLE_RECORDED" : "POSTED", classification: opening ? "OPENING" : "CURRENT_POSTED", affectsCurrentWallet: row.subject_id !== null && row.subject_id !== undefined, affectsCurrentLedger: true,
    occurredAt: row.at, importedAt: row.recorded_at ?? row.at, sourceType: row.source_type ?? "NATIVE", sourceSystem: row.source_system ?? "zzsh", sourceEntity: row.source_entity ?? "settlement_posting", sourceId: row.source_id ?? row.posting_id ?? row.id,
    sourceDigest: row.source_digest ?? null, basisId: row.basis_id ?? null, reasonCodes: [...(amount === null ? ["INVALID_EXACT_AMOUNT"] : []), ...(type === "REFUND" ? ["REFUND_PAYMENT_SOURCE_NOT_AVAILABLE"] : [])], accountCode: row.account_code,
    evidence: { postedAt:row.at??null,recordedAt:row.recorded_at??row.at??null,eventId:row.finance_event_id??null,eventKind: row.event_kind ?? null, openingCutoff: row.opening_cutoff ?? null, coveredCount: row.covered_count ?? null, postingId: row.posting_id ?? null,
      paymentConfirmationId: row.payment_confirmation_id ?? null, settlementVersionId: row.settlement_version_id ?? null, settlementVersionHash: row.version_hash ?? null,
      postingCapturedCents: cents(row.captured_cents),
      refundPayableCents: cents(row.renter_refund_cents), refundDueAt: row.refund_due_at ?? null, ...(type === "REFUND" ? { refundPaidCents: null, refundPaymentReference: null } : {}), ...(earning?{earningRole:row.earning_role??null,earningAmountCents:cents(row.earning_amount),earningFundsDisposition:row.earning_disposition??null,recoveryRequiredCents:cents(row.earning_recovery),dueAt:row.earning_due_at??null,earningVersion:row.earning_version??null}:{}),postedPlatformContributionCents: cents(row.platform_contribution_cents) },
    related: [...(row.order_id ? [{ ref: `ORDER:${row.order_id}`, label: "原订单", path: `/orders/${encodeURIComponent(row.order_id)}` }] : []), ...(row.account_id ? [{ ref: row.account_id, label: "资源账号", path: `/supply/accounts/${encodeURIComponent(row.account_id)}` }] : [])] };
}
export function projectAdminFinanceObservation(row: Raw): FinanceEntry {
 if(row.observation_origin==='LEGACY_GUARANTEE_HISTORY'){
  let p:ReturnType<typeof prepareOwnerGuaranteeHistory>;try{p=prepareOwnerGuaranteeHistory(JSON.parse(row.extra_evidence?.canonical));}catch{throw unavailable('Guarantee historical source is inconsistent');}
  if(p.userId!==row.subject_id||p.sourceId!==row.source_id||p.sourceDigest!==row.source_digest||p.sourceCanonical!==row.extra_evidence.canonical||p.accountId!==row.extra_evidence.accountId)throw unavailable('Guarantee source binding changed');
  const rawTime=p.source.pay_time;let paidAt:string|null=null;if(rawTime!==null&&rawTime!==undefined&&rawTime!==''&&rawTime!=='0'){if(typeof rawTime!=='string'||!/^\d{1,10}$/.test(rawTime)||BigInt(rawTime)>4294967295n)throw unavailable('Guarantee source time is inconsistent');paidAt=new Date(Number(rawTime)*1000).toISOString();}
  return{id:`history:${row.id}`,documentRef:`GUARANTEE_SOURCE:${row.id}`,documentNumber:typeof p.source.no==='string'&&p.source.no?p.source.no:p.sourceId,subjectId:row.subject_id,subjectName:displayName(row.subject_name,row.subject_id),
   bucket:'GUARANTEE_HELD',direction:'UNKNOWN',deltaCents:null,knowledge:'UNKNOWN',kind:'GUARANTEE',state:'HISTORICAL_OBSERVED',classification:'HISTORICAL_GUARANTEE',affectsCurrentWallet:false,affectsCurrentLedger:false,
   occurredAt:null,importedAt:row.imported_at,sourceType:'LEGACY_MYSQL',sourceSystem:'legacy_mysql_restore',sourceEntity:'la_rental_accounts',sourceId:p.sourceId,sourceDigest:p.sourceDigest,basisId:null,
   reasonCodes:['HISTORICAL_GUARANTEE_NOT_CURRENT_HELD','HISTORICAL_STATUS_NOT_CHANNEL_RESULT'],accountCode:null,evidence:{accountId:p.accountId,legacyAccountId:p.sourceId,sourcePaidRecordCents:p.paidRecordCents,sourcePaidRecordCount:p.paidRecordCount,accountFieldCents:p.accountFieldCents,sourcePaidMark:String(p.source.pay_is),sourceReturnMark:p.source.return_is===null?null:String(p.source.return_is),sourcePaidAt:paidAt,sourceClass:p.classification,sourceConflicts:p.conflicts.join(','),currentLiabilityCents:null,originalReference:null,originalNumber:null,channelArrival:'UNKNOWN'},related:[]};
 }
 if(['NATIVE_EARNING_ZERO','LEGACY_DUTY_ZERO'].includes(row.observation_origin)){
  const legacy=row.observation_origin==='LEGACY_DUTY_ZERO',ref=legacy?`LEGACY_DUTY:${row.source_id}`:`DISTRIBUTION:${row.source_id}`;
  const eventKnown=legacy||typeof row.at==='string'&&typeof row.extra_evidence?.eventId==='string'&&row.extra_evidence.eventAction==='ACCRUE';
  if(row.amount!=='0'||!['PENDING','SETTLED','REVOKED'].includes(row.source_status)||legacy&&row.source_status!=='SETTLED')throw unavailable('Zero finance fact is inconsistent');
  return{id:`history:${row.id}`,documentRef:ref,documentNumber:row.source_id,subjectId:row.subject_id,subjectName:displayName(row.subject_name,row.subject_id),
   bucket:legacy&&row.action==='RENTER_REFUND'?'REFUND_PAYABLE':!legacy&&row.source_status==='PENDING'?'PENDING_EARNINGS':'AVAILABLE',direction:'IN',deltaCents:eventKnown?'0':null,knowledge:eventKnown?'KNOWN':'UNKNOWN',kind:!legacy||row.action==='COMMISSION'?'DISTRIBUTION':row.action==='RENTER_REFUND'?'REFUND':'SETTLEMENT',state:row.source_status,classification:legacy?'ZERO_FINALIZATION':'ZERO_AMOUNT_FACT',affectsCurrentWallet:false,affectsCurrentLedger:false,
   occurredAt:eventKnown?row.at:null,importedAt:row.imported_at,sourceType:row.source_type,sourceEntity:row.source_entity,sourceSystem:row.source_system,sourceId:row.source_id,sourceDigest:row.source_digest,basisId:null,reasonCodes:['ZERO_FACT_NO_LEDGER_OR_CHANNEL_PAYMENT',...(!eventKnown?['ORIGINAL_ACCRUAL_EVENT_UNAVAILABLE']:[])],accountCode:null,
   evidence:{...(row.extra_evidence??{}),zeroAmount:'0',originalReference:row.reference_id,channelArrival:'UNKNOWN'},related:row.reference_id?[{ref:(legacy?'LEGACY_ORDER:':'ORDER:')+row.reference_id,label:'原订单',path:`/orders/${encodeURIComponent(row.reference_id)}`}]:[]};
 }
  const earnings = row.source_entity === "la_log_earnings", distribution = row.source_entity === "la_distribution_order";
  const unsigned = cents(row.amount, true), direction = earnings ? row.action === "1" ? "IN" : row.action === "2" ? "OUT" : "UNKNOWN" : distribution ? "IN" : "OUT";
  const amount = unsigned === null || direction === "UNKNOWN" ? null : direction === "OUT" && unsigned !== "0" ? `-${unsigned}` : unsigned;
  const identityKind = earnings ? "EARNINGS" : distribution ? "DISTRIBUTION" : "WITHDRAWAL";
  const historical=historicalObservationDisplay(row);
  const kind=earnings&&['1002','1003','1004','1005'].includes(historical.changeType??'')?'WITHDRAWAL':identityKind;
  const distributionNumber=distribution?row.extra_evidence?.snapshot?.sourceNumber:null;
  return { id: `history:${row.id}`, documentRef: `HISTORY_${identityKind}:${row.id}`, documentNumber: earnings?historical.originalLogNumber??row.source_id:row.reference_no??distributionNumber??row.source_id, subjectId: row.subject_id, subjectName: displayName(row.subject_name, row.subject_id),
    bucket: distribution ? "PENDING_EARNINGS" : "AVAILABLE", direction, deltaCents: amount, knowledge: amount === null ? "UNKNOWN" : "KNOWN", kind,
    state: "HISTORICAL_OBSERVED", classification: row.included_in_opening ? "HISTORICAL_COVERED" : "HISTORICAL_UNCOVERED", affectsCurrentWallet: false, affectsCurrentLedger: false,
    occurredAt: row.at, importedAt: row.imported_at, sourceType: row.source_type, sourceSystem: row.source_system ?? "SOURCE_SYSTEM_UNKNOWN", sourceEntity: row.source_entity, sourceId: row.source_id, sourceDigest: row.source_digest, basisId: row.basis_id,
    reasonCodes: [...(row.included_in_opening ? [] : ["HISTORICAL_NOT_ADMITTED"]), ...(!earnings ? ["HISTORICAL_STATUS_NOT_CHANNEL_RESULT"] : []), ...(amount === null ? ["AMOUNT_OR_DIRECTION_UNKNOWN"] : [])], accountCode: null,
    evidence: { originalReference: row.reference_id ?? null, originalNumber: row.reference_no ?? null, originalStatus: row.source_status ?? null,
      originalNetCents: signedSourceCents(row.net), originalFeeCents: signedSourceCents(row.fee), historicalBalanceAfterCents: signedSourceCents(row.balance_after), dueAt: null, policyVersion: null }, related: [],historical };
}
export async function readFinanceSourceVersion(client: PoolClient) {
  const ready = (await client.query(`SELECT to_regclass('zzsh_order.wallet_coverage') IS NOT NULL AND to_regclass('zzsh_order.personal_finance_observation') IS NOT NULL AND to_regclass('zzsh_order.wallet_revision') IS NOT NULL AND to_regclass('zzsh_order.finance_economic_root') IS NOT NULL AND to_regclass('zzsh_order.finance_event') IS NOT NULL AND to_regclass('zzsh_order.finance_opening_basis') IS NOT NULL AS ready,
    to_regclass('zzsh_order.withdrawal_intent') IS NOT NULL AND to_regclass('zzsh_order.withdrawal_provider_fact') IS NOT NULL AND to_regclass('zzsh_order.controlled_payout_operation') IS NOT NULL AS withdrawals,
    to_regclass('zzsh_order.rental_order') IS NOT NULL AS native_orders,to_regclass('zzsh_order.legacy_order_read_snapshot') IS NOT NULL AS legacy_orders,
    to_regclass('zzsh_order.rental_referral_earning') IS NOT NULL AS native_distribution,to_regclass('zzsh_order.payment_distribution_basis') IS NOT NULL AS earning_basis,to_regclass('zzsh_order.rental_referral_transition') IS NOT NULL AS earning_transitions,to_regclass('zzsh_order.personal_finance_observation_coverage') IS NOT NULL AS history_coverage,
    to_regclass('zzsh_order.legacy_duty_finance_fact') IS NOT NULL AND to_regclass('zzsh_order.legacy_order_duty') IS NOT NULL AS legacy_duty_finance,to_regclass('zzsh_order.legacy_owner_guarantee_coverage') IS NOT NULL AND to_regclass('zzsh_order.legacy_owner_guarantee_observation') IS NOT NULL AS guarantee_history`)).rows[0];
  if (!ready?.ready) throw unavailable("Finance read foundation is not available");
  const version=(await client.query(financeVersionSql(ready))).rows[0]?.finance_version;
  if(typeof version!=="string")throw unavailable("Finance version evidence unavailable");
  const asOf=(await client.query(`SELECT ${utc("clock_timestamp()")} AS at`)).rows[0].at;
  return {ready,version,asOf};
}
async function loadHistoricalReferenceRows(client:PoolClient,history:Raw[]):Promise<Raw[]> {
  const present=new Set(history.map(row=>[row.source_system,row.subject_id,row.source_entity,row.source_id].join('\u0000'))),references=new Map<string,string[]>();
  for(const row of history){
    const fact=row.extra_evidence?.snapshot,type=String(fact?.legacyChangeType??''),entity=type==='1001'?'la_distribution_order':['1002','1003','1004','1005'].includes(type)?'la_withdraw_apply':null;
    if(row.source_type!=='LEGACY_MYSQL'||row.source_entity!=='la_log_earnings'||!entity||typeof fact?.referenceId!=='string'||! /^[1-9]\d{0,23}$/.test(fact.referenceId))continue;
    const reference=[String(row.source_system),String(row.subject_id),entity,fact.referenceId],key=reference.join('\u0000');
    if(!present.has(key))references.set(key,reference);
  }
  const refs=[...references.values()],rows:Raw[]=[],source=ADMIN_FINANCE_OBSERVATION_SQL.replace(/\s+ORDER BY o\.id COLLATE "C" LIMIT \$1\s*$/,'');
  // A bounded VALUES batch retains exact source/subject/entity identity and stays below PG's parameter ceiling.
  for(let offset=0;offset<refs.length;offset+=16_000){
    const values:unknown[]=[],tuples=refs.slice(offset,offset+16_000).map(reference=>'('+reference.map(value=>'$'+values.push(value)).join(',')+')');
    const query=`WITH finance_reference_rows AS (${source}) SELECT r.* FROM finance_reference_rows r
      WHERE (r.source_system,r.subject_id,r.source_entity,r.source_id) IN (VALUES ${tuples.join(',')}) ORDER BY r.id COLLATE "C" LIMIT $${values.push(MAX_FACTS+1)}`;
    rows.push(...(await client.query(query,values)).rows);
    if(rows.length>MAX_FACTS)throw unavailable('Historical reference size limit reached');
  }
  return rows;
}

async function loadHistoricalReverseRows(client:PoolClient,documentRef:string|undefined,history:Raw[],orders:FinanceOrderFact[]):Promise<Raw[]>{
  if(!documentRef)return[];
  const targets:string[][]=[];
  for(const row of history)if(documentRef===`HISTORY_WITHDRAWAL:${row.id}`&&row.source_type==='LEGACY_MYSQL'&&row.source_entity==='la_withdraw_apply')
    for(const type of ['1002','1003','1004','1005'])targets.push([row.source_system,row.subject_id,row.source_id,type]);
  for(const row of history)if(documentRef===`HISTORY_EARNINGS:${row.id}`&&row.source_type==='LEGACY_MYSQL'&&row.source_entity==='la_log_earnings'&&['1003','1004','1005'].includes(String(row.extra_evidence?.snapshot?.legacyChangeType))&&typeof row.reference_id==='string')
    for(const type of ['1002','1003','1004','1005'])targets.push([row.source_system,row.subject_id,row.reference_id,type]);
  for(const order of orders)if(order.ref===documentRef&&order.sourceType==='LEGACY_MYSQL')targets.push([order.sourceSystem,order.ownerId,order.sourceId,'1001']);
  if(!targets.length)return[];
  const values:unknown[]=[],tuples=targets.map(target=>'('+target.map(value=>'$'+values.push(value)).join(',')+')');
  const source=ADMIN_FINANCE_OBSERVATION_SQL.replace(/\s+ORDER BY o\.id COLLATE "C" LIMIT \$1\s*$/,'');
  const rows=(await client.query(`WITH finance_reverse_candidates AS (${source}) SELECT r.* FROM finance_reverse_candidates r
    WHERE r.source_type='LEGACY_MYSQL' AND r.source_entity='la_log_earnings'
    AND (r.source_system,r.subject_id,r.reference_id,r.extra_evidence->'snapshot'->>'legacyChangeType') IN (VALUES ${tuples.join(',')})
    ORDER BY r.id COLLATE "C" LIMIT $${values.push(MAX_FACTS+1)}`,values)).rows;
  if(rows.length>MAX_FACTS)throw unavailable('Historical reverse reference size limit reached');return rows;
}

export async function loadAdminFinanceFacts(client: PoolClient, scope: FinanceLoadScope = {},relations?:HistoricalRelationAccess): Promise<FinanceFacts> {
  const {ready,version,asOf}=await readFinanceSourceVersion(client);
  let lookupPage: FinanceFacts["lookupPage"], entryScope = scope;const ledgerSource=adminFinanceLedgerSql(ready.native_distribution===true),historySource=adminFinanceObservationSql(ready);
  if(scope.lookup){
    const query=financeLookupPageSql(ledgerSource,historySource,ready,scope), rows=(await client.query(query.text,query.values)).rows, row=rows[0];
    if(!row||![row.document_count,row.entry_count].every(value=>Number.isSafeInteger(Number(value))&&Number(value)>=0))throw unavailable("Finance page evidence unavailable");
    lookupPage={refs:rows.flatMap(row=>row.ref===null?[]:[String(row.ref)]),documentCount:Number(row.document_count),entryCount:Number(row.entry_count)};
    entryScope={...scope,filters:undefined,documentRefs:lookupPage.refs};
  }
  const ledgerQuery=scopedFinanceSql(ledgerSource,"ledger",entryScope,MAX_FACTS+1,ready.withdrawals);
  const historyQuery=scopedFinanceSql(historySource,"history",entryScope,MAX_FACTS+1,ready.withdrawals);
  const ledger=(await client.query(ledgerQuery.text,ledgerQuery.values)).rows,history=(await client.query(historyQuery.text,historyQuery.values)).rows;
  if(ledger.length+history.length>MAX_FACTS)throw new SecurityApiError(503,"EVIDENCE_UNAVAILABLE","Matching finance result exceeds 20000; apply a narrower subject, period or query",[{path:"finance.matchingLimit.20000",code:"INVALID_FIELD"}]);
  const linkedOrders=ledger.flatMap(row=>typeof row.order_id==='string'?[`ORDER:${row.order_id}`]:[]);
  const orderScope=lookupPage?{...scope,orderRefs:[...new Set([...lookupPage.refs,...linkedOrders])]}:scope.documentRef?{...scope,orderRefs:[...new Set([scope.documentRef,...linkedOrders])]}:scope.filters?.q.startsWith("ORDER_LINK:")?scope:{...scope,orderRefs:linkedOrders};
  const orderReferences=history.filter(row=>row.source_entity==='la_log_earnings'&&String(row.extra_evidence?.snapshot?.legacyChangeType)==='1001');
  const orders=await loadFinanceOrderFacts(client,ready,orderScope,orderReferences,relations);
  const reverseRows=await loadHistoricalReverseRows(client,scope.documentRef,history,orders);
  const referenceRows=await loadHistoricalReferenceRows(client,[...history,...reverseRows]);
  const historicalSources=[...new Map([...history,...reverseRows,...referenceRows].map(row=>[row.id,row])).values()];
  const subjectIds=[...new Set([...ledger.map(row=>row.subject_id),...history.map(row=>row.subject_id),...orders.flatMap(order=>[order.ownerId,order.renterId]),scope.subjectId,scope.filters?.scope!=="ALL"?scope.filters?.scope:undefined].filter((id):id is string=>typeof id==="string"))];
  const subjects=(await client.query(`SELECT id,COALESCE(name,id) AS name FROM zzsh_auth_user."user" WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C"`,[subjectIds])).rows.map(row=>({id:String(row.id),name:displayName(row.name,String(row.id))}));
  let subjectCandidates:FinanceFacts["subjectCandidates"];
  if(scope.lookup&&!scope.lookup.exact&&scope.filters?.q&&!scope.filters.q.startsWith("ORDER_LINK:")){
    const search="%"+scope.filters.q.replace(/[\\%_]/g,value=>"\\"+value).toLocaleLowerCase("zh-CN")+"%",limit=scope.pageSize??20,offset=((scope.page??1)-1)*limit;
    const predicate=`lower(id) LIKE $1 ESCAPE '\\' OR lower(COALESCE(name,'')) LIKE $1 ESCAPE '\\'`;
    const count=(await client.query(`SELECT count(*)::text AS total FROM zzsh_auth_user."user" WHERE ${predicate}`,[search])).rows[0]?.total??"0";
    const candidates=(await client.query(`SELECT id,COALESCE(name,id) AS name FROM zzsh_auth_user."user" WHERE ${predicate} ORDER BY id COLLATE "C" LIMIT $2 OFFSET $3`,[search,limit,offset])).rows;
    subjectCandidates={items:candidates.map(row=>({id:String(row.id),name:displayName(row.name,String(row.id))})),total:Number(count)};
  }
  const intentIds=[...new Set(ledger.filter(row=>row.source_entity==="withdrawal_intent").map(row=>row.source_id))];
  const withdrawals:Raw[]=ready.withdrawals&&intentIds.length?(await client.query(`SELECT i.id,i.user_id,i.state,i.operation_version::text,i.funds_disposition,i.gross_cents::text,i.net_cents::text,i.fee_cents::text,i.policy_version,
    ${utc("i.accepted_at")} AS accepted_at,i.terminal->>'state' AS terminal_state,i.terminal->>'reference' AS terminal_reference,
    f.id AS query_ref,${utc("f.observed_at")} AS queried_at FROM zzsh_order.withdrawal_intent i LEFT JOIN zzsh_order.withdrawal_provider_fact f ON f.id=i.last_provider_fact_id WHERE i.id=ANY($1::text[]) ORDER BY i.id COLLATE "C"`,[intentIds])).rows:[];
  const operations=ready.withdrawals&&intentIds.length?(await client.query(`SELECT id,intent_id,final_evidence_digest,${utc("recorded_at")} AS at,final_evidence_canonical::jsonb->>'outcome' AS outcome,final_evidence_canonical::jsonb->>'reference' AS reference FROM zzsh_order.controlled_payout_operation WHERE intent_id=ANY($1::text[]) ORDER BY id COLLATE "C"`,[intentIds])).rows:[];
  const entries=[...ledger.map(projectAdminFinanceLedger),...history.map(projectAdminFinanceObservation)];
  const readableOrders=new Set(orders.filter(order=>order.objectReadable===true).map(order=>order.ref)),readableAccounts=new Set(orders.filter(order=>order.accountReadable===true).map(order=>order.accountId));
  for(const entry of entries)entry.related=entry.related.filter(link=>{
    if(link.path?.startsWith('/orders/'))return readableOrders.has(link.ref);
    if(link.path?.startsWith('/supply/accounts/'))return readableAccounts.has(link.ref);
    return true;
  });
  enrichHistoricalObservations(entries,historicalSources,orders,relations);
  const historicalLinks=scope.documentRef?{[scope.documentRef]:resolveHistoricalReverseLinks(scope.documentRef,historicalSources,orders,relations)}:undefined;
  if(ready.native_distribution){
    const eventIds=[...new Set([...ledger.filter(row=>row.source_kind==='NATIVE_RENTAL_REFERRAL'&&typeof row.finance_event_id==='string').map(row=>row.finance_event_id as string),
      ...history.filter(row=>row.observation_origin==='NATIVE_EARNING_ZERO'&&typeof row.extra_evidence?.eventId==='string').map(row=>row.extra_evidence.eventId as string)])];
    const actions=ready.earning_transitions===true?await readAdminEarningEventActions(client,eventIds):undefined;
    for(const entry of entries)if(entry.sourceType==='NATIVE'&&entry.kind==='DISTRIBUTION'){
      const action=actions?.get(entry.evidence.eventId??'');entry.evidence.eventAction=action?.action??null;
      entry.reasonCodes.push(...(action?.reasonCodes??['ORIGINAL_TRANSITION_UNAVAILABLE']));
    }
  }
  const distributionId=scope.documentRef?.startsWith('DISTRIBUTION:')&&entries.some(entry=>entry.documentRef===scope.documentRef)?scope.documentRef.slice('DISTRIBUTION:'.length):null;
  const distributionCalculation=ready.native_distribution&&distributionId?(ready.earning_basis===true
    ?(await readAdminEarningCalculations(client,[distributionId])).get(distributionId)
    :{knowledge:'UNKNOWN' as const,policyVersion:null,levelCode:null,percent:null,baseCents:null,formula:null,reasonCodes:['ORIGINAL_BASIS_UNAVAILABLE']}):undefined;
  const intentById = new Map(withdrawals.map(row => [row.id, row]));
  const operationByIntent = new Map(operations.map(row => [row.intent_id, row]));
  for (const entry of entries) if (entry.documentRef.startsWith("WITHDRAWAL:")) {
    const intent = intentById.get(entry.documentRef.slice("WITHDRAWAL:".length));
    if (intent) { entry.state = intent.state; entry.evidence = { ...entry.evidence, intentId: intent.id, mode: "LOCAL_CONTROLLED", fundsDisposition: intent.funds_disposition,
      grossCents: cents(intent.gross_cents), netCents: cents(intent.net_cents), feeCents: cents(intent.fee_cents), policyVersion: intent.policy_version,
      acceptedAt: intent.accepted_at, operationVersion: intent.operation_version, channelState: intent.terminal_state ?? null,
      channelReference: intent.terminal_reference ?? null, queryRef: intent.query_ref ?? null, queriedAt: intent.queried_at ?? null };
      entry.reasonCodes.push("LOCAL_CONTROLLED_NOT_BANK_RECEIPT");
      const operation = operationByIntent.get(intent.id);
      if (operation) { entry.evidence.originalOperationRef = operation.id; entry.evidence.originalOperationRecordedAt = operation.at; entry.evidence.originalOperationOutcome = operation.outcome; entry.evidence.originalOperationReference = operation.reference;
        if (intent.state !== operation.outcome) entry.reasonCodes.push("LOCAL_OPERATION_NOT_APPLIED"); }
    } else entry.reasonCodes.push("WITHDRAWAL_SOURCE_UNAVAILABLE");
  }
  return {entries,subjects,revisions:[],orders,subjectCandidates,lookupPage,historicalLinks,distributionCalculation,withdrawalsReady:ready.withdrawals,nativeDistributionReady:ready.native_distribution===true,asOf,version};
}

export function filterAdminFinanceEntries(facts: FinanceFacts, filter: FinanceFilters, period: boolean): FinanceEntry[] {
  const from = Date.parse(filter.from + "T00:00:00+08:00"), end = Date.parse(filter.to + "T00:00:00+08:00") + 86400_000;
  const query = filter.q.toLocaleLowerCase("zh-CN");
  const orderLinks = filter.q.startsWith("ORDER_LINK:") ? new Set((facts.orders ?? []).filter(order => order.id === filter.q.slice(11)).map(order => order.ref)) : null;
  return facts.entries.filter(entry => (filter.scope === "ALL" || entry.subjectId === filter.scope) && (filter.bucket === "ALL" || entry.bucket === filter.bucket) && (filter.kind === "ALL" || entry.kind === filter.kind) && (filter.state === "ALL" || entry.state === filter.state)
    && (orderLinks ? orderLinks.has(entry.documentRef) : !query || [entry.subjectId, entry.subjectName, entry.documentRef, entry.documentNumber, entry.sourceId, entry.id,entry.evidence.originalNumber??''].some(value => value.toLocaleLowerCase("zh-CN").includes(query)))
    && (!period || entry.occurredAt === null || (Date.parse(entry.occurredAt) >= from && Date.parse(entry.occurredAt) < end)))
    .sort((a, b) => (b.occurredAt ?? "").localeCompare(a.occurredAt ?? "") || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0));
}
type Snapshot = { audience: string; keyId: string; actor: string; session: string; access: string; filters: string; version: string; asOf: string; expiresAt: number };
export function financeSnapshot(facts: FinanceFacts, filters: FinanceFilters, actor: FinanceActor, key: ListingCursorKey | undefined, token?: string | null, now = Date.now()): { token: string; asOf: string } {
  requireListingCursorKey(key);
  const binding = { audience: ADMIN_FINANCE_VERSION, keyId: key.keyId, actor: digest(actor.userId), session: digest(actor.sessionId), access: actor.authorizationKey, filters: digest(filters), version: facts.version };
  let snapshot: Snapshot;
  if (token) {
    try {
      if (token.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$/.test(token)) throw Error();
      const [payload, signature] = token.split(".") as [string, string];
      const expected = createHmac("sha256", key.secret).update(payload).digest(), actual = Buffer.from(signature, "base64url");
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw Error();
      snapshot = JSON.parse(Buffer.from(payload, "base64url").toString()) as Snapshot;
      if (snapshot.audience !== binding.audience || snapshot.keyId !== binding.keyId || !Number.isFinite(snapshot.expiresAt) || snapshot.expiresAt <= now || snapshot.expiresAt > now + 600_000 || typeof snapshot.asOf !== "string" || !Number.isFinite(Date.parse(snapshot.asOf))) throw stale();
      for (const [name, value] of Object.entries(binding)) if (snapshot[name as keyof Snapshot] !== value) throw stale();
    } catch (error) { if (error instanceof SecurityApiError) throw error; throw invalid("Invalid finance snapshot"); }
  } else snapshot = { ...binding, asOf: facts.asOf, expiresAt: now + 600_000 };
  const payload = Buffer.from(JSON.stringify(snapshot)).toString("base64url");
  return { token: payload + "." + createHmac("sha256", key.secret).update(payload).digest("base64url"), asOf: snapshot.asOf };
}
export function financeDocuments(entries: FinanceEntry[],summaryScope:'DOCUMENT'|'SUBJECT'='DOCUMENT') {
  const groups = new Map<string, FinanceEntry[]>();
  for (const entry of entries){const group=groups.get(entry.documentRef)??[];group.push(entry);groups.set(entry.documentRef,group);}
  const single=singleText;
  return [...groups].sort(([a],[b])=>a.localeCompare(b)).map(([ref,raw])=>{
    const lines=[...raw].sort((a,b)=>a.id.localeCompare(b.id)),family=ref.slice(0,ref.indexOf(':'));
    const kind=family==='ORDER'?'SETTLEMENT':family==='DISTRIBUTION'?'DISTRIBUTION':family==='WITHDRAWAL'?'WITHDRAWAL':family==='OPENING'?'OPENING':single(lines.map(e=>e.kind))??'UNKNOWN';
    const state=family==='ORDER'||family==='OPENING'?'POSTED':single(lines.map(e=>e.state))??'UNKNOWN';
    return{ref,number:single(lines.map(e=>e.documentNumber))??ref,kind,state,occurredAt:lines.map(e=>e.occurredAt).filter((v):v is string=>typeof v==='string').sort().at(-1)??null,
      requestedAmountCents:single(lines.map(e=>e.evidence.grossCents??(e.historical?.purposeCode==='WITHDRAWAL_APPLICATION'?e.historical.recordedAmountCents:null))),
      subjects:[...new Map(lines.map(e=>[e.subjectId,{id:e.subjectId,name:e.subjectName}])).values()].sort((a,b)=>a.id.localeCompare(b.id)),entryCount:lines.length,summaryScope,
      subjectEntryCount:summaryScope==='SUBJECT'?lines.length:null,documentEntryCount:summaryScope==='SUBJECT'?null:lines.length,
      amounts:[...new Set(lines.map(e=>e.bucket))].sort().map(bucket=>({bucket,knownNetCents:lines.filter(e=>e.bucket===bucket&&e.deltaCents!==null).reduce((n,e)=>n+BigInt(e.deltaCents!),0n).toString(),unknownCount:lines.filter(e=>e.bucket===bucket&&e.deltaCents===null).length})),
      ...(lines.length===1&&lines[0]!.historical?{historical:lines[0]!.historical}:{})};
  });
}
export function financeOrderDocuments(facts: FinanceFacts, filter: FinanceFilters) {
  const query = filter.q.toLocaleLowerCase("zh-CN"), from = Date.parse(filter.from + "T00:00:00+08:00"), end = Date.parse(filter.to + "T00:00:00+08:00") + 86400_000;
  return (facts.orders ?? []).filter(order => (filter.scope === "ALL" || [order.ownerId, order.renterId].includes(filter.scope)) && filter.bucket === "ALL" && ["ALL", "SETTLEMENT"].includes(filter.kind) && ["ALL", order.state].includes(filter.state)
    && (!filter.period || !order.occurredAt || Date.parse(order.occurredAt) >= from && Date.parse(order.occurredAt) < end)
    && (filter.q.startsWith("ORDER_LINK:") ? order.id === filter.q.slice(11) : !query || [order.ref, order.number, order.id, order.sourceId, order.ownerId, order.renterId, ...facts.subjects.filter(subject => subject.id === order.ownerId || subject.id === order.renterId).map(subject => subject.name)].some(value => value.toLocaleLowerCase("zh-CN").includes(query))))
    .map(order => ({ ref: order.ref, number: order.number, kind: order.kind, state: order.state, occurredAt: order.occurredAt, requestedAmountCents: null,
      subjects: [order.ownerId, order.renterId].map(id => ({ id, name: facts.subjects.find(subject => subject.id === id)?.name ?? id })), entryCount: 0,summaryScope:'DOCUMENT' as const,subjectEntryCount:null,documentEntryCount:0, amounts: [] }));
}
export type FinancePeriodBalance={bucket:FinanceBucket;opening:string;closing:string;movement:string};
/** Complete DB-side ledger aggregates, scoped like the rows. These are book balances, not source/channel completeness. */
export async function readAdminFinancePeriodBalances(client:PoolClient,filters:FinanceFilters){
 const ready=(await client.query(`/* finance period optional sources */ SELECT to_regclass('zzsh_order.rental_referral_earning') IS NOT NULL AS native_distribution,to_regclass('zzsh_order.withdrawal_intent') IS NOT NULL AS withdrawals`)).rows[0];
 if(typeof ready?.native_distribution!=='boolean'||typeof ready?.withdrawals!=='boolean')throw unavailable('Finance period source metadata unavailable');
 const source=scopedFinanceSql(adminFinanceLedgerSql(ready.native_distribution),'ledger',{filters:{...filters,period:false}},null,ready.withdrawals),start=`${filters.from}T00:00:00+08:00`,end=new Date(Date.parse(`${filters.to}T00:00:00+08:00`)+86400000).toISOString();
 const values=[...source.values,start,end],a='$'+(values.length-1),b='$'+values.length;
 const rows=(await client.query(`/* finance period complete ledger balances */ WITH period_rows AS (${source.text}) SELECT ${FINANCE_LEDGER_BUCKET_SQL} AS bucket,
  COALESCE(sum(r.delta::numeric) FILTER(WHERE r.at::timestamptz<${a}::timestamptz),0)::text AS opening,
  COALESCE(sum(r.delta::numeric) FILTER(WHERE r.at::timestamptz<${b}::timestamptz),0)::text AS closing,
  COALESCE(sum(r.delta::numeric) FILTER(WHERE r.at::timestamptz>=${a}::timestamptz AND r.at::timestamptz<${b}::timestamptz),0)::text AS movement
  FROM period_rows r GROUP BY ${FINANCE_LEDGER_BUCKET_SQL}`,values)).rows;
 const seen=new Set<string>();return rows.map(row=>{if(!(FINANCE_BUCKETS as readonly string[]).includes(row.bucket)||seen.has(row.bucket))throw unavailable('Finance period aggregate shape invalid');seen.add(row.bucket);const opening=exactCents(row.opening),closing=exactCents(row.closing),movement=exactCents(row.movement);if(BigInt(closing)-BigInt(opening)!==BigInt(movement))throw unavailable('Finance period ledger arithmetic does not close');return{bucket:row.bucket as FinanceBucket,opening,closing,movement};});
}
export function financePeriodProjection(entries: FinanceEntry[],balances?:FinancePeriodBalance[],balanceBasis?:FinancePeriodBasis) {
  return FINANCE_BUCKETS.map(bucket => {
    const lines = entries.filter(entry => entry.bucket === bucket), posted = lines.filter(entry => entry.affectsCurrentLedger);
    const known = posted.filter(entry => entry.deltaCents !== null), movements = known.filter(entry => entry.classification !== "OPENING");
    const balance=balances?.find(b=>b.bucket===bucket)??(balances?{opening:'0',closing:'0',movement:'0'}:undefined);
    const proved=balance&&balanceBasis?.knowledge==='KNOWN'&&posted.every(entry=>entry.occurredAt!==null&&entry.deltaCents!==null);
    const inflows=movements.filter(entry=>BigInt(entry.deltaCents!)>=0n).reduce((s,e)=>s+BigInt(e.deltaCents!),0n),outflows=movements.filter(entry=>BigInt(entry.deltaCents!)<0n).reduce((s,e)=>s-BigInt(e.deltaCents!),0n),migration=known.filter(entry=>entry.classification==='OPENING').reduce((s,e)=>s+BigInt(e.deltaCents!),0n);
    if(balance&&BigInt(balance.movement)!==inflows-outflows+migration)throw unavailable('Finance period rows differ from complete ledger totals');
    return { bucket, knownInflows: inflows.toString(),
      knownOutflows: movements.filter(entry => BigInt(entry.deltaCents!) < 0n).reduce((sum, entry) => sum - BigInt(entry.deltaCents!), 0n).toString(),
      migrationMovement: known.filter(entry => entry.classification === "OPENING").reduce((sum, entry) => sum + BigInt(entry.deltaCents!), 0n).toString(),
      ledgerOpeningBalance:balance?.opening??null,ledgerClosingBalance:balance?.closing??null,ledgerDifference:balance?'0':null,...(balanceBasis?{balanceBasis}:{}),
      openingBalance:proved?balance.opening:null,closingBalance:proved?balance.closing:null,difference:proved?'0':null,knowledge:proved?'KNOWN':'UNKNOWN',scope:'CURRENT_LEDGER_ONLY',
      reasonCodes:!balanceBasis?["PERIOD_BALANCE_PROOF_NOT_AVAILABLE"]:balanceBasis.knowledge==='UNKNOWN'?balanceBasis.reasonCodes:balance&&!proved?['POSTED_EVENT_AMOUNT_OR_TIME_UNAVAILABLE']:balance?["CURRENT_LEDGER_EXCLUDES_UNADMITTED_LEGACY","CHANNEL_ARRIVAL_NOT_PROVED"]:["PERIOD_BALANCE_PROOF_NOT_AVAILABLE"],
      unknownCount: posted.length - known.length, unknownTimeCount: lines.filter(entry => entry.occurredAt === null).length,
      coveredHistoricalCount: lines.filter(entry => entry.classification === "HISTORICAL_COVERED").length, uncoveredHistoricalCount: lines.filter(entry => entry.classification === "HISTORICAL_UNCOVERED").length };
  });
}
export async function readAdminFinanceSubject(client: PoolClient, facts: FinanceFacts, id: string, asOf: string) {
  const subject = facts.subjects.find(row => row.id === id); if (!subject) throw notFound();
  const wallet = await readPersonalWallet(client, id);
  return { subject, wallet: { ...wallet, asOf }, documents: financeDocuments(facts.entries.filter(entry => entry.subjectId === id),'SUBJECT'),
    gaps: ["PERIOD_BALANCE_PROOF_NOT_AVAILABLE", "GLOBAL_RESERVED_AND_WITHDRAWABLE_NOT_ADMITTED"], sourcesReady: { withdrawals: facts.withdrawalsReady, nativeDistribution: facts.nativeDistributionReady===true } };
}
export function readAdminFinanceDocument(facts: FinanceFacts, ref: string, entryId?: string | null) {
  const entries = facts.entries.filter(entry => entry.documentRef === ref);
  const order = facts.orders?.find(row => row.ref === ref);
  if (!entries.length && !order || entryId && !entries.some(entry => entry.id === entryId)) throw notFound();
  const document = financeDocuments(entries)[0] ?? { ref, number: order!.number, kind: order!.kind, state: order!.state, occurredAt: order!.occurredAt, requestedAmountCents: null, subjects: [order!.ownerId, order!.renterId].map(id => ({ id, name: facts.subjects.find(subject => subject.id === id)?.name ?? id })), entryCount: 0,summaryScope:'DOCUMENT' as const,subjectEntryCount:null,documentEntryCount:0, amounts: [] };
  const evidence=Object.fromEntries([...new Set(entries.flatMap(entry=>Object.keys(entry.evidence)))].map(name=>[name,singleText(entries.map(entry=>entry.evidence[name]))]));
  const reverse=facts.historicalLinks?.[ref];
  const related = [...new Map([...entries.flatMap(entry => entry.related),...(reverse?.related??[])].map(link => [link.ref, link])).values()].filter(link => link.ref !== ref || link.path);
  if (order) {
    Object.assign(evidence, { originalOrderNumber: order.number, originalOrderId: order.sourceId, originalOrderStatus: order.originalOrderStatus, ...(order.sourceType === "LEGACY_MYSQL" ? { originalPaymentStatus: order.originalPaymentStatus, recordedPaidCents: order.recordedPaidCents } : {}), ownerSubjectId: order.ownerId, renterSubjectId: order.renterId, recordedDueCents: order.dueCents, recordedDepositCents: order.depositCents, orderSourceType: order.sourceType, orderSourceSystem: order.sourceSystem, orderSourceDigest: order.sourceDigest });
    if(order.objectReadable)related.push({ ref, label: "订单详情", path: `/orders/${encodeURIComponent(order.id)}` });
    if(order.accountReadable)related.push({ ref: order.accountId, label: "资源账号", path: `/supply/accounts/${encodeURIComponent(order.accountId)}` });
    related.push(...facts.entries.filter(entry => entry.related.some(link => link.ref === ref)).map(entry => ({ ref: entry.documentRef, label: entry.documentNumber })));
  }
  return { document, entries, evidence, related: [...new Map(related.map(link => [link.ref + (link.path ?? ""), link])).values()], reasonCodes: [...new Set([...entries.flatMap(entry => entry.reasonCodes),...(reverse?.reasonCodes??[]), ...(order ? ["ORDER_RECORD_NOT_CHANNEL_RESULT", ...(!entries.length ? ["ORDER_NO_CURRENT_POSTING"] : [])] : [])])],
    ...(facts.distributionCalculation?{distributionCalculation:facts.distributionCalculation}:{}),
    platform: { postedComponents: entries.filter(entry => entry.bucket === "PLATFORM").map(entry => ({ accountCode: entry.accountCode, deltaCents: entry.deltaCents })), beforeDistributionCents: null, distributionExpenseCents: null, retainedCents: null, channelCostCents: null, netProfitCents: null, reasonCodes: ["DISTRIBUTION_AND_CHANNEL_COST_NOT_ADMITTED"] } };
}
