import type {PoolClient} from 'pg';
import type {FinanceFilters} from './admin-finance-read';
import {normalizeTime} from '../supply/content-hash';

export type FinancePeriodBasis={knowledge:'KNOWN'|'UNKNOWN';origin:string|null;sourceCutoff:string|null;openingPostedAt:string|null;reasonCodes:string[]};
type PeriodFilters=Pick<FinanceFilters,'scope'|'from'|'to'|'bucket'|'kind'|'state'|'q'>;
const unknown=(reason:string,origin:string|null=null):FinancePeriodBasis=>({knowledge:'UNKNOWN',origin,sourceCutoff:null,openingPostedAt:null,reasonCodes:[reason]});
function incompleteScope(f:PeriodFilters){
 if(f.scope==='ALL')return'ALL_SUBJECTS_PERIOD_BALANCE_NOT_PROVABLE';
 if(f.kind!=='ALL'||f.state!=='ALL'||f.q!=='')return'FILTERED_PERIOD_BALANCE_NOT_PROVABLE';
 return null;
}
/** Proves the origin of a posted-ledger period, never a historical-source or channel balance. */
export function deriveAdminFinancePeriodBasis(f:PeriodFilters,row:Record<string,any>|undefined):FinancePeriodBasis{
 const partial=incompleteScope(f);if(partial)return unknown(partial);
 if(!row)return unknown('SOURCE_COVERAGE_NOT_ADMITTED');
 const origin=['RECONCILED_OPENING','NATIVE_GENESIS'].includes(row.origin)?row.origin:null;
 if(!origin)return unknown('WALLET_ORIGIN_NOT_VERIFIED');
 const kind=origin==='NATIVE_GENESIS'?'NATIVE_GENESIS':'LEGACY_OPENING',type=origin==='NATIVE_GENESIS'?'NATIVE':'LEGACY_MYSQL';
 if(row.user_id!==f.scope||row.basis_user_id!==f.scope||!row.basis_id||row.basis_id!==row.coverage_basis_id||!row.event_id||row.event_id!==row.opening_event_id
  ||row.event_subject_id!==f.scope||row.event_kind!=='OPENING'||row.event_root_id!==row.root_id||row.root_basis_id!==row.basis_id||row.root_subject_id!==f.scope
  ||row.source_kind!==kind||row.root_kind!==kind||row.root_type!==type||row.root_role!=='WALLET_HOLDER'
  ||!row.source_system||!row.source_entity||!row.source_id||row.root_system!==row.source_system||row.root_entity!==row.source_entity||row.root_source_id!==row.source_id
  ||typeof row.source_digest!=='string'||!/^[0-9a-f]{64}$/.test(row.source_digest)||row.root_digest!==row.source_digest)
  return unknown('OPENING_ORIGIN_BINDING_NOT_VERIFIED',origin);
 if(origin==='NATIVE_GENESIS'&&(row.native_zero!==true||row.source_system!=='zzsh-native-registration'||row.source_entity!=='zzsh_auth_user.user'||row.source_id!==f.scope||row.native_origin_verified!==true)
  ||origin==='RECONCILED_OPENING'&&(row.source_entity!=='la_user'||row.legacy_identity_verified!==true))return unknown('OPENING_ORIGIN_SOURCE_NOT_VERIFIED',origin);
 let sourceCutoff:string|null,openingPostedAt:string|null;
 try{sourceCutoff=normalizeTime(row.source_cutoff??null);openingPostedAt=normalizeTime(row.opening_posted_at??null);}catch{return unknown('OPENING_ORIGIN_TIME_NOT_VERIFIED',origin);}
 if(!sourceCutoff||!openingPostedAt||sourceCutoff>openingPostedAt)return unknown('OPENING_ORIGIN_TIME_NOT_VERIFIED',origin);
 const openingDay=new Date(Date.parse(openingPostedAt)+8*3600_000).toISOString().slice(0,10);
 return{knowledge:f.from<openingDay?'UNKNOWN':'KNOWN',origin,sourceCutoff,openingPostedAt,
  reasonCodes:f.from<openingDay?['HISTORICAL_PERIOD_BALANCE_NOT_PROVABLE']:['POSTED_LEDGER_ONLY','CHANNEL_ARRIVAL_NOT_PROVED']};
}
/** The caller has authorized this exact subject and validated the date/filter contract. */
export async function readAdminFinancePeriodBasis(c:PoolClient,f:PeriodFilters):Promise<FinancePeriodBasis>{
 const partial=incompleteScope(f);if(partial)return unknown(partial);
 const rows=(await c.query(`SELECT c.user_id,c.origin,c.basis_id AS coverage_basis_id,c.opening_event_id,
  b.id AS basis_id,b.user_id AS basis_user_id,b.source_kind,b.source_system,b.source_entity,b.source_id,b.source_digest,
  to_char(b.source_cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS source_cutoff,
  b.available_cents=0 AND b.covered_count=0 AS native_zero,
  b.native_origin_canonical IS NOT NULL AND b.source_digest=encode(sha256(convert_to(b.native_origin_canonical,'UTF8')),'hex') AND b.identity_source_digest=b.source_digest AS native_origin_verified,
  b.identity_source_digest ~ '^[0-9a-f]{64}$' AND b.native_origin_canonical IS NULL AS legacy_identity_verified,
  e.id AS event_id,e.kind AS event_kind,e.subject_user_id AS event_subject_id,e.economic_root_id AS event_root_id,
  to_char(e.created_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS opening_posted_at,
  r.id AS root_id,r.basis_id AS root_basis_id,r.subject_user_id AS root_subject_id,r.source_kind AS root_kind,r.source_type AS root_type,
  r.source_system AS root_system,r.source_entity AS root_entity,r.source_id AS root_source_id,r.beneficiary_role AS root_role,r.source_digest AS root_digest
  FROM zzsh_order.wallet_coverage c LEFT JOIN zzsh_order.finance_opening_basis b ON b.id=c.basis_id
  LEFT JOIN zzsh_order.finance_event e ON e.id=c.opening_event_id LEFT JOIN zzsh_order.finance_economic_root r ON r.id=e.economic_root_id
  WHERE c.user_id=$1`,[f.scope])).rows;
 if(rows.length>1)return unknown('AMBIGUOUS_OPENING_ORIGIN');
 return deriveAdminFinancePeriodBasis(f,rows[0]);
}
