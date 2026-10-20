import {createHash} from 'node:crypto';
import type {PoolClient} from 'pg';
import {SecurityApiError} from '../auth/security-core';
import {canonicalize} from '../supply/content-hash';
import {ensureOnlyFields,invalid} from '../supply/supply-util';

export const OBSERVATION_ENTITIES={
 HISTORICAL_EARNINGS_LOG:'la_log_earnings',
 HISTORICAL_DISTRIBUTION:'la_distribution_order',
 HISTORICAL_WITHDRAWAL:'la_withdraw_apply',
} as const;
export type ObservationKind=keyof typeof OBSERVATION_ENTITIES;
type Member={sourceId:string;sourceDigest:string};
export type ObservationCoverageInput={
 userId:string;legacyUserId:string;sourceSystem:string;sourceKind:ObservationKind;
 cutoff:string;inputSha256:string;identityDigest:string;sourceCount:number;
 imported:Member[];isolated:(Member&{reason:string})[];
};
const digest=/^[0-9a-f]{64}$/;
const id=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/;
const sourceId=/^[1-9]\d{0,23}$/;
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const unavailable=()=>new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Historical finance coverage is inconsistent');
function setDigest(rows:readonly Member[]){
 return sha([...rows].sort((a,b)=>a.sourceId<b.sourceId?-1:a.sourceId>b.sourceId?1:0).map(r=>r.sourceId+':'+r.sourceDigest).join('\n'));
}
/** Exact set arithmetic shared by independent source domains; grants no import or financial authority. */
export function prepareFinanceSourceSet(input:{sourceCount:number;imported:Member[];isolated:(Member&{reason:string})[]}){
 if(!Number.isSafeInteger(input.sourceCount)||input.sourceCount<0||input.sourceCount>500000||!Array.isArray(input.imported)||!Array.isArray(input.isolated))throw invalid('Exact finance source set required');
 const all=[...input.imported,...input.isolated];
 if(all.length!==input.sourceCount||new Set(all.map(r=>r?.sourceId)).size!==all.length
  ||all.some(r=>!r||typeof r.sourceId!=='string'||!sourceId.test(r.sourceId)||typeof r.sourceDigest!=='string'||!digest.test(r.sourceDigest))
  ||input.isolated.some(r=>typeof r.reason!=='string'||!r.reason||r.reason.length>128))throw invalid('Historical coverage source set does not close');
 for(const r of input.imported)ensureOnlyFields(r,['sourceId','sourceDigest']);for(const r of input.isolated)ensureOnlyFields(r,['sourceId','sourceDigest','reason']);
 return{sourceCount:input.sourceCount,importedCount:input.imported.length,isolatedCount:input.isolated.length,sourceSetDigest:setDigest(all),importedSetDigest:setDigest(input.imported),isolatedSetDigest:setDigest(input.isolated)};
}

/** A proof of source completeness, not a wallet balance or permission to import. */
export function prepareObservationCoverage(input:ObservationCoverageInput){
 if(!input||typeof input.userId!=='string'||!id.test(input.userId)||typeof input.legacyUserId!=='string'||!sourceId.test(input.legacyUserId)||input.sourceSystem!=='legacy_mysql_restore'
  ||!Object.hasOwn(OBSERVATION_ENTITIES,input.sourceKind)||!digest.test(input.inputSha256)||!digest.test(input.identityDigest)
  ||typeof input.cutoff!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(input.cutoff)||!Number.isFinite(Date.parse(input.cutoff))
  ||!Number.isSafeInteger(input.sourceCount)||input.sourceCount<0||input.sourceCount>500000
  ||!Array.isArray(input.imported)||!Array.isArray(input.isolated))throw invalid('Exact historical coverage proof required');
 ensureOnlyFields(input,['userId','legacyUserId','sourceSystem','sourceKind','cutoff','inputSha256','identityDigest','sourceCount','imported','isolated']);
 const set=prepareFinanceSourceSet(input);
 const bodyDigest=sha(canonicalize(input));
 return{
  id:'history_coverage_'+sha(canonicalize([input.userId,input.sourceSystem,input.sourceKind,input.cutoff])).slice(0,40),
  userId:input.userId,legacyUserId:input.legacyUserId,sourceSystem:input.sourceSystem,sourceKind:input.sourceKind,
  sourceEntity:OBSERVATION_ENTITIES[input.sourceKind],cutoff:input.cutoff,inputSha256:input.inputSha256,identityDigest:input.identityDigest,
  ...set,
  bodyDigest,canonical:canonicalize(input),
 };
}

export type ObservationCoverage=
 |{knowledge:'KNOWN';reason:'SOURCE_COMPLETE_THROUGH_CUTOFF';count:string;cutoff:string;version:string}
 |{knowledge:'UNKNOWN';reason:'HISTORICAL_COVERAGE_NOT_INSTALLED'|'HISTORICAL_COVERAGE_NOT_IMPORTED'|'HISTORICAL_SOURCE_ISOLATED'|'HISTORICAL_COVERAGE_OUTDATED';count:null;cutoff:string|null;version:string|null};

/** Caller has checked the native origin tables exist; the same birth proof serves the history readers. */
export async function hasProvedNativeHistoryAbsence(client:PoolClient,userId:string,kind:ObservationKind){
 if(typeof userId!=='string'||!id.test(userId)||!Object.hasOwn(OBSERVATION_ENTITIES,kind))throw invalid('Historical coverage subject/source required');
 const row=(await client.query(`SELECT EXISTS(SELECT 1 FROM zzsh_order.wallet_coverage c
  JOIN zzsh_order.finance_opening_basis b ON b.id=c.basis_id AND b.user_id=c.user_id
  JOIN zzsh_iam.user_identity_state s ON s.user_id=c.user_id JOIN zzsh_order.native_user_insert_proof p ON p.user_id=c.user_id
  WHERE c.user_id=$1 AND c.origin='NATIVE_GENESIS' AND b.source_kind='NATIVE_GENESIS' AND b.available_cents=0 AND b.covered_count=0 AND s.provider='none'
   AND NOT EXISTS(SELECT 1 FROM zzsh_iam.audit_event a WHERE a.object_id=c.user_id AND a.action='user.legacy_owner.migrated' AND a.outcome='SUCCESS')
   AND NOT EXISTS(SELECT 1 FROM zzsh_order.personal_finance_observation h WHERE h.user_id=c.user_id AND h.source_kind=$2)) AS complete`,[userId,kind])).rows[0];
 if(typeof row?.complete!=='boolean')throw unavailable();return row.complete;
}

/** SELECT only. Wallet coverage and a zero-row query are never history completeness proofs. */
export async function readObservationCoverage(client:PoolClient,userId:string,kind:ObservationKind):Promise<ObservationCoverage>{
 if(typeof userId!=='string'||!id.test(userId)||!Object.hasOwn(OBSERVATION_ENTITIES,kind))throw invalid('Historical coverage subject/source required');
 const installed=(await client.query(`/* finance history coverage installed */ SELECT to_regclass('zzsh_order.personal_finance_observation_coverage') IS NOT NULL AS installed`)).rows[0];
 if(installed?.installed===false)return{knowledge:'UNKNOWN',reason:'HISTORICAL_COVERAGE_NOT_INSTALLED',count:null,cutoff:null,version:null};
 if(installed?.installed!==true)throw unavailable();
 const row=(await client.query(`/* finance history coverage exact target */
  SELECT c.id,c.source_count,c.imported_count,c.isolated_count,c.imported_set_digest,
   to_char(c.source_cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cutoff,
   s.actual_count,s.actual_digest,s.invalid_count,s.outside_count
  FROM zzsh_order.personal_finance_observation_coverage c
  LEFT JOIN LATERAL (
   /* One pass over the subject/kind observations replaces the former four correlated scans; each FILTER keeps the original predicate. */
   SELECT count(*) FILTER(WHERE o.source_system=c.source_system AND o.source_entity=c.source_entity AND o.source_event_at<=c.source_cutoff)::text AS actual_count,
    encode(sha256(convert_to(COALESCE(string_agg(o.source_id||':'||o.source_digest,chr(10) ORDER BY o.source_id COLLATE "C") FILTER(WHERE o.source_system=c.source_system AND o.source_entity=c.source_entity AND o.source_event_at<=c.source_cutoff),''),'UTF8')),'hex') AS actual_digest,
    count(*) FILTER(WHERE o.source_system<>c.source_system OR o.source_entity<>c.source_entity OR o.source_type<>'LEGACY_MYSQL' OR o.source_event_at IS NULL)::text AS invalid_count,
    count(*) FILTER(WHERE o.source_event_at>c.source_cutoff)::text AS outside_count
   FROM zzsh_order.personal_finance_observation o WHERE o.user_id=c.user_id AND o.source_kind=c.source_kind
  ) s ON true
  WHERE c.user_id=$1 AND c.source_kind=$2
  ORDER BY c.source_cutoff DESC,c.id COLLATE "C" DESC LIMIT 1`,[userId,kind])).rows[0];
 if(!row)return{knowledge:'UNKNOWN',reason:'HISTORICAL_COVERAGE_NOT_IMPORTED',count:null,cutoff:null,version:null};
 const counts=[row.source_count,row.imported_count,row.isolated_count].map(String);
 if(!counts.every(n=>/^(0|[1-9]\d{0,8})$/.test(n))||BigInt(counts[0]!)!==BigInt(counts[1]!)+BigInt(counts[2]!)
  ||row.actual_count!==counts[1]||!digest.test(row.imported_set_digest)||row.actual_digest!==row.imported_set_digest
  ||typeof row.id!=='string'||!id.test(row.id)||typeof row.cutoff!=='string'||!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(row.cutoff)||!Number.isFinite(Date.parse(row.cutoff))
  ||row.invalid_count!=='0'||typeof row.outside_count!=='string'||!/^(0|[1-9]\d*)$/.test(row.outside_count))throw unavailable();
 const version=row.id+':'+row.imported_set_digest;
 if(row.outside_count!=='0')return{knowledge:'UNKNOWN',reason:'HISTORICAL_COVERAGE_OUTDATED',count:null,cutoff:row.cutoff,version};
 if(counts[2]!=='0')return{knowledge:'UNKNOWN',reason:'HISTORICAL_SOURCE_ISOLATED',count:null,cutoff:row.cutoff,version};
 return{knowledge:'KNOWN',reason:'SOURCE_COMPLETE_THROUGH_CUTOFF',count:counts[0]!,cutoff:row.cutoff,version};
}
