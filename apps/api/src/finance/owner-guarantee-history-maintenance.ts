import type {PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {canonicalize} from '../supply/content-hash';
import {recordAudit,setAuditContext} from '../auth/security-core';
import {conflict,ensureOnlyFields,fingerprintRequest,invalid,withIdempotency} from '../supply/supply-util';
import {assertFinanceMaintenanceResource,authorizeFinanceMaintenance,type FinanceOpeningReview} from './personal-finance-maintenance';
import {planOwnerGuaranteeHistoryBatch,type OwnerGuaranteeHistoryBatch} from './owner-guarantee-history';
type Actor={userId:string;sessionId:string;requestId:string};
export type GuaranteeHistoryReview=Pick<FinanceOpeningReview,'ref'|'attempt'|'actor'|'resource'|'notBefore'|'expiresAt'>&{userId:string;inputSha256:string;bodyDigest:string;cutoff:string;sourceCount:number};
export type GuaranteeHistoryAdmission=Readonly<{kind:'REVIEWED_OWNER_GUARANTEE_HISTORY'}>;
const bindings=new WeakMap<object,{review:GuaranteeHistoryReview;recoveryOnly:boolean}>(),sha=(s:string)=>createHash('sha256').update(s).digest('hex'),operation='finance.owner-guarantee.history.import';
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
function binding(s:GuaranteeHistoryAdmission){const b=bindings.get(s);if(!b)throw invalid('Internal owner guarantee history binding required');return b;}
async function authorize(c:PoolClient,a:Actor,s:GuaranteeHistoryAdmission,input?:OwnerGuaranteeHistoryBatch,recover=false){
 const b=binding(s),r=b.review;await authorizeFinanceMaintenance(c,a);await assertFinanceMaintenanceResource(c,a,r,{recover,recoveryOnly:b.recoveryOnly});
 const schema=(await c.query(`/* owner guarantee maintenance schema */ SELECT to_regclass('zzsh_order.legacy_owner_guarantee_observation') IS NOT NULL AND to_regclass('zzsh_order.legacy_owner_guarantee_coverage') IS NOT NULL AS ready,
  (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=to_regclass('zzsh_order.legacy_owner_guarantee_observation')) AS owner`)).rows[0];if(schema?.ready!==true||schema.owner!==r.resource.role)throw conflict('Owner guarantee observation schema/owner not admitted');
 if(input&&(input.userId!==r.userId||input.inputSha256!==r.inputSha256||input.cutoff!==r.cutoff||input.sourceCount!==r.sourceCount||sha(canonicalize(input))!==r.bodyDigest))throw invalid('Owner guarantee history body differs from exact review');return r;
}
/** Out-of-band review, not user JSON. Existing C resource/current Boss guard is reused. */
export async function bindReviewedOwnerGuaranteeHistory(c:PoolClient,a:Actor,review:GuaranteeHistoryReview,mode:'execute'|'recover'='execute'){
 if(!review||!review.actor||!review.resource)throw invalid('Exact guarantee source review required');ensureOnlyFields(review,['ref','attempt','actor','resource','notBefore','expiresAt','userId','inputSha256','bodyDigest','cutoff','sourceCount']);
 const r=copy(review);ensureOnlyFields(r.actor,['userId','sessionId']);ensureOnlyFields(r.resource,['host','port','database','oid','owner','marker','role','roleOid']);
 if(!['execute','recover'].includes(mode)||![r.ref,r.attempt,r.userId].every(s=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(s))
  ||![r.inputSha256,r.bodyDigest].every(s=>typeof s==='string'&&/^[a-f0-9]{64}$/.test(s))||!Number.isSafeInteger(r.sourceCount)||r.sourceCount<0||r.sourceCount>50000
  ||![r.notBefore,r.expiresAt,r.cutoff].every(s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s)))
  ||Date.parse(r.cutoff)>Date.parse(r.notBefore)||Date.parse(r.notBefore)>=Date.parse(r.expiresAt)||r.resource.host!=='127.0.0.1'||r.resource.port!==55432
  ||!/^zzsh_test_order_[a-z][a-z0-9_]{0,20}$/.test(r.resource.database)||r.resource.marker!=='zzsh:order-reservation-test:v1'
  ||![r.resource.oid,r.resource.roleOid].every(n=>Number.isSafeInteger(n)&&n>0)||![r.resource.role,r.resource.owner].every(s=>/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(s)))throw invalid('Exact guarantee source/resource/window required');
 const token=Object.freeze({kind:'REVIEWED_OWNER_GUARANTEE_HISTORY' as const});bindings.set(token,{review:r,recoveryOnly:mode==='recover'});try{await authorize(c,a,token,undefined,mode==='recover');return token;}catch(e){bindings.delete(token);throw e;}
}
async function mappedIdentity(c:PoolClient,i:OwnerGuaranteeHistoryBatch){
 const found=await c.query(`/* guarantee history source identity */ SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=$1 AND action='user.legacy_owner.migrated' AND outcome='SUCCESS' AND details->>'sourceSystem'='legacy_mysql_restore' AND details->>'sourceEntity'='la_user' AND details->>'legacyId'=$2 AND details->>'sourceDigest'=$3`,[i.userId,i.legacyUserId,i.identityDigest]);if(found.rowCount!==1)throw conflict('Original guarantee owner mapping changed');
}
/** One owner's exact source universe per transaction; no guarantee requirement, held ledger or refund is initialized. */
export async function importReviewedOwnerGuaranteeHistory(c:PoolClient,a:Actor,input:OwnerGuaranteeHistoryBatch,s:GuaranteeHistoryAdmission){
 input=copy(input);const plan=planOwnerGuaranteeHistoryBatch(input),r=await authorize(c,a,s,input);await mappedIdentity(c,input);
 const result=await withIdempotency(c,{realm:'admin',principalId:a.userId,operation},plan.key,fingerprintRequest(operation,input.userId,input),async()=>{await authorize(c,a,s,input);await mappedIdentity(c,input);},async()=>{
  await c.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`,[input.userId]);await setAuditContext(c,'admin',a.userId,a.sessionId,a.requestId);
  for(const row of plan.rows){
   if(row.accountId!==null){const map=await c.query(`SELECT 1 FROM zzsh_supply.legacy_supply_map WHERE source_system='legacy_mysql_restore' AND source_entity='la_rental_accounts' AND legacy_id=$1 AND account_id=$2`,[row.sourceId,row.accountId]);if(map.rowCount!==1)throw conflict('Original guarantee account mapping changed');}
   await c.query(`INSERT INTO zzsh_order.legacy_owner_guarantee_observation(id,user_id,legacy_user_id,account_id,legacy_account_id,source_cutoff,input_sha256,identity_digest,source_canonical,source_digest)
    VALUES($1,$2,$3,$4,$5,$6::timestamptz,$7,$8,$9,$10)`,['guarantee_history_'+sha(canonicalize([input.userId,row.sourceId,input.cutoff])).slice(0,40),input.userId,input.legacyUserId,row.accountId,row.sourceId,input.cutoff,input.inputSha256,input.identityDigest,row.sourceCanonical,row.sourceDigest]);
  }
  const p=plan.coverage;await c.query(`INSERT INTO zzsh_order.legacy_owner_guarantee_coverage(id,user_id,legacy_user_id,source_cutoff,input_sha256,identity_digest,source_count,imported_count,isolated_count,source_set_digest,imported_set_digest,isolated_set_digest,body_digest,input_canonical)
   VALUES($1,$2,$3,$4::timestamptz,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,[p.id,input.userId,input.legacyUserId,input.cutoff,input.inputSha256,input.identityDigest,p.sourceCount,p.importedCount,p.isolatedCount,p.sourceSetDigest,p.importedSetDigest,p.isolatedSetDigest,plan.bodyDigest,canonicalize(input)]);
  await recordAudit(c,{actorType:'admin',actorId:a.userId,sessionId:a.sessionId,requestId:a.requestId,action:operation,objectType:'legacy_owner_guarantee_coverage',objectId:p.id,outcome:'SUCCESS',details:{bodyDigest:plan.bodyDigest,approvalRef:r.ref,attempt:r.attempt,inputSha256:input.inputSha256,subjectId:input.userId,rows:p.importedCount,isolated:p.isolatedCount,financialEffect:'NONE'}});
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');await authorize(c,a,s,input);return{status:200,body:{coverageId:p.id,subjectId:input.userId,bodyDigest:plan.bodyDigest,financialEffect:'NONE'}};
 });await authorize(c,a,s,input);return result;
}
/** Original read only; missing receipt is UNKNOWN and never runs an importer. */
export async function recoverReviewedOwnerGuaranteeHistory(c:PoolClient,a:Actor,input:OwnerGuaranteeHistoryBatch,s:GuaranteeHistoryAdmission){
 input=copy(input);const p=planOwnerGuaranteeHistoryBatch(input),r=await authorize(c,a,s,input,true);await mappedIdentity(c,input);
 const row=(await c.query(`SELECT request_fingerprint AS fingerprint,response_status AS status,response_body AS body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2`,[JSON.stringify(['admin',a.userId,operation,null]),p.key])).rows[0];if(!row)return{knowledge:'UNKNOWN',key:p.key,receipt:null};
 if(row.fingerprint!==fingerprintRequest(operation,input.userId,input)||row.status!==200||row.body?.subjectId!==input.userId||row.body?.coverageId!==p.coverage.id||row.body?.bodyDigest!==p.bodyDigest||row.body?.financialEffect!=='NONE')throw conflict('Original guarantee history receipt differs');
 const coverage=(await c.query(`SELECT body_digest FROM zzsh_order.legacy_owner_guarantee_coverage WHERE id=$1 AND user_id=$2`,[p.coverage.id,input.userId])).rows[0];if(coverage?.body_digest!==p.bodyDigest)throw conflict('Original guarantee source coverage differs');
 const actual=(await c.query(`SELECT legacy_account_id AS id,source_digest AS digest,source_canonical AS canonical FROM zzsh_order.legacy_owner_guarantee_observation WHERE user_id=$1 AND source_cutoff=$2::timestamptz ORDER BY legacy_account_id COLLATE "C"`,[input.userId,input.cutoff])).rows;
 const expected=p.rows.map(row=>({id:row.sourceId,digest:row.sourceDigest,canonical:row.sourceCanonical})).sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);if(canonicalize(actual)!==canonicalize(expected))throw conflict('Original guarantee observations differ');
 const audit=await c.query(`SELECT 1 FROM zzsh_iam.audit_event WHERE action=$1 AND object_id=$2 AND actor_type='admin' AND actor_id=$3 AND session_id=$4 AND outcome='SUCCESS' AND details->>'bodyDigest'=$5 AND details->>'approvalRef'=$6 AND details->>'attempt'=$7`,[operation,p.coverage.id,a.userId,a.sessionId,p.bodyDigest,r.ref,r.attempt]);if(audit.rowCount!==1)throw conflict('Original guarantee source audit missing');
 await authorize(c,a,s,input,true);return{knowledge:'KNOWN',key:p.key,receipt:{status:row.status,body:row.body},originalSourceVerified:true,financialEffect:'NONE'};
}
