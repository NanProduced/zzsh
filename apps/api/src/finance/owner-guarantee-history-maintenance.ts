import type {PoolClient} from 'pg';
import {createHash,randomUUID} from 'node:crypto';
import {canonicalize} from '../supply/content-hash';
import {recordAudit,setAuditContext} from '../auth/security-core';
import {conflict,ensureOnlyFields,fingerprintRequest,invalid,withIdempotency} from '../supply/supply-util';
import {assertFinanceMaintenanceResource,authorizeFinanceMaintenance,authorizeMaintenanceBatch,closeMaintenanceBatch,isReviewedFinanceMaintenanceResource,type FinanceOpeningReview} from './personal-finance-maintenance';
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
  ||!isReviewedFinanceMaintenanceResource(r.resource)
  ||![r.resource.oid,r.resource.roleOid].every(n=>Number.isSafeInteger(n)&&n>0)||![r.resource.role,r.resource.owner].every(s=>/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(s)))throw invalid('Exact guarantee source/resource/window required');
 const token=Object.freeze({kind:'REVIEWED_OWNER_GUARANTEE_HISTORY' as const});bindings.set(token,{review:r,recoveryOnly:mode==='recover'});try{await authorize(c,a,token,undefined,mode==='recover');return token;}catch(e){bindings.delete(token);throw e;}
}
/** 批级绑定：逐个纯 JS 校验后一次鉴权覆盖整批。 */
export async function bindReviewedOwnerGuaranteeHistoryBatch(client:PoolClient,a:Actor,reviews:GuaranteeHistoryReview[],mode:'execute'|'recover'='execute'):Promise<GuaranteeHistoryAdmission[]>{
 if(!Array.isArray(reviews)||reviews.length<1||reviews.length>1000)throw invalid('Bounded guarantee history review batch required');
 const normalized=reviews.map(review=>{
  if(!review||!review.actor||!review.resource||typeof review.userId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(review.userId)
   ||typeof review.inputSha256!=='string'||!/^[a-f0-9]{64}$/.test(review.inputSha256)||typeof review.bodyDigest!=='string'||!/^[a-f0-9]{64}$/.test(review.bodyDigest)
   ||!Number.isSafeInteger(review.sourceCount)||review.sourceCount<0||review.sourceCount>50000
   ||![review.ref,review.attempt].every(s=>typeof s==='string'&&/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(s))
   ||![review.notBefore,review.expiresAt,review.cutoff].every(s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s)&&Number.isFinite(Date.parse(s)))
   ||Date.parse(review.cutoff)>Date.parse(review.notBefore)||Date.parse(review.notBefore)>=Date.parse(review.expiresAt)
   ||review.resource.host!=='127.0.0.1'||review.resource.port!==55432||!isReviewedFinanceMaintenanceResource(review.resource)
   ||![review.resource.oid,review.resource.roleOid].every(n=>Number.isSafeInteger(n)&&n>0)
   ||![review.resource.role,review.resource.owner].every(s=>/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(s)))throw invalid('Exact guarantee source/resource/window required');
  return copy(review);
 });
 await authorizeMaintenanceBatch(client,a,normalized,{recover:mode==='recover',recoveryOnly:mode==='recover'});
 return normalized.map(r=>{const token=Object.freeze({kind:'REVIEWED_OWNER_GUARANTEE_HISTORY' as const});bindings.set(token,{review:r,recoveryOnly:mode==='recover'});return token;});
}
async function mappedIdentity(c:PoolClient,i:OwnerGuaranteeHistoryBatch){
 const found=await c.query(`/* guarantee history source identity */ SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=$1 AND action='user.legacy_owner.migrated' AND outcome='SUCCESS' AND details->>'sourceSystem'='legacy_mysql_restore' AND details->>'sourceEntity'='la_user' AND details->>'legacyId'=$2 AND details->>'sourceDigest'=$3`,[i.userId,i.legacyUserId,i.identityDigest]);if(found.rowCount!==1)throw conflict('Original guarantee owner mapping changed');
}
/** One owner's exact source universe per transaction; no guarantee requirement, held ledger or refund is initialized. */
export async function importReviewedOwnerGuaranteeHistory(c:PoolClient,a:Actor,input:OwnerGuaranteeHistoryBatch,s:GuaranteeHistoryAdmission){
 input=copy(input);const plan=planOwnerGuaranteeHistoryBatch(input),r=await authorize(c,a,s,input);await mappedIdentity(c,input);
 const result=await withIdempotency(c,{realm:'admin',principalId:a.userId,operation},plan.key,fingerprintRequest(operation,input.userId,input),async()=>{await authorize(c,a,s,input);await mappedIdentity(c,input);},async()=>{
  await c.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`,[input.userId]);await setAuditContext(c,'admin',a.userId,a.sessionId,a.requestId);
  const mapped=plan.rows.filter(row=>row.accountId!==null);
  if(mapped.length){
   const matches=await c.query(`SELECT 1 FROM unnest($1::text[],$2::text[]) AS requested(legacy_id,account_id)
     JOIN zzsh_supply.legacy_supply_map m ON m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts'
       AND m.legacy_id=requested.legacy_id AND m.account_id=requested.account_id`,[mapped.map(row=>row.sourceId),mapped.map(row=>row.accountId)]);
   if(matches.rowCount!==mapped.length)throw conflict('Original guarantee account mapping changed');
  }
  for(const row of plan.rows){
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

/** 批级保证金历史写入：整批 4 条 jsonb_to_recordset 语句（observation / coverage / audit / receipt），
 *  鉴权批首批尾各一次；原键身份与账号映射校验批级化。语义与逐对象版本一致：financialEffect 恒为 NONE。 */
export async function importReviewedOwnerGuaranteeHistoryBatchOn(c:PoolClient,a:Actor,inputs:OwnerGuaranteeHistoryBatch[],scopes:GuaranteeHistoryAdmission[]){
 inputs=copy(inputs);
 if(!Array.isArray(inputs)||inputs.length<1||inputs.length>1000||inputs.length!==scopes.length)throw invalid('Bounded guarantee history batch required');
 const plans=inputs.map(planOwnerGuaranteeHistoryBatch);
 if(new Set(plans.map(p=>p.coverage.id)).size!==plans.length||new Set(inputs.map(i=>i.userId)).size!==inputs.length)throw invalid('Duplicate guarantee coverage in batch');
 const pairs=plans.map((plan,i)=>({input:inputs[i]!,scope:scopes[i]!,plan})).sort((x,y)=>x.plan.coverage.id<y.plan.coverage.id?-1:x.plan.coverage.id>y.plan.coverage.id?1:0);
 const window=await authorizeMaintenanceBatch(c,a,pairs.map(p=>binding(p.scope).review));
 for(const p of pairs){const r=binding(p.scope).review;
  if(p.input.userId!==r.userId||p.input.inputSha256!==r.inputSha256||p.input.cutoff!==r.cutoff||p.input.sourceCount!==r.sourceCount||p.plan.bodyDigest!==r.bodyDigest)
   throw invalid('Guarantee history body differs from exact review');}
 const scopeKey=JSON.stringify(['admin',a.userId,operation,null]);
 await c.query(`/* guarantee batch key locks */ SELECT pg_advisory_xact_lock(hashtextextended(k,0)) FROM unnest($1::text[]) WITH ORDINALITY keys(k,n) ORDER BY n`,[pairs.map(p=>JSON.stringify(['supply-idempotency',scopeKey,p.plan.key]))]);
 const subjects=pairs.map(p=>p.input.userId).sort();
 if((await c.query(`/* guarantee batch subject locks */ SELECT id FROM zzsh_auth_user."user" WHERE id=ANY($1::text[]) ORDER BY id COLLATE "C" FOR UPDATE`,[subjects])).rowCount!==subjects.length)throw conflict('Guarantee batch subject is not mapped');
 const invalidSubjects=await c.query(`/* guarantee batch source identities */ SELECT x.user_id FROM jsonb_to_recordset($1::jsonb) x(user_id text,legacy_user_id text,identity_digest text)
   WHERE (SELECT count(*) FROM zzsh_iam.audit_event ev WHERE ev.object_id=x.user_id AND ev.action='user.legacy_owner.migrated' AND ev.outcome='SUCCESS'
     AND ev.details->>'sourceSystem'='legacy_mysql_restore' AND ev.details->>'sourceEntity'='la_user' AND ev.details->>'legacyId'=x.legacy_user_id
     AND ev.details->>'sourceDigest'=x.identity_digest)<>1`,
  [JSON.stringify(pairs.map(p=>({user_id:p.input.userId,legacy_user_id:p.input.legacyUserId,identity_digest:p.input.identityDigest})))]);
 if(invalidSubjects.rows.length)throw conflict('Guarantee batch original source identity changed');
 const mappedRows=pairs.flatMap(p=>p.plan.rows.filter(r=>r.accountId!==null).map(r=>({legacy_id:r.sourceId,account_id:r.accountId})));
 if(mappedRows.length){
  const matches=await c.query(`/* guarantee batch account mapping */ SELECT 1 FROM jsonb_to_recordset($1::jsonb) x(legacy_id text,account_id text)
    JOIN zzsh_supply.legacy_supply_map m ON m.source_system='legacy_mysql_restore' AND m.source_entity='la_rental_accounts'
      AND m.legacy_id=x.legacy_id AND m.account_id=x.account_id`,[JSON.stringify(mappedRows)]);
  if(matches.rowCount!==mappedRows.length)throw conflict('Original guarantee account mapping changed');
 }
 const receipts=await c.query(`/* guarantee batch original receipts */ SELECT key,request_fingerprint,response_status,response_body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=ANY($2::text[]) FOR UPDATE`,[scopeKey,pairs.map(p=>p.plan.key)]);
 const receiptByKey=new Set<string>(receipts.rows.map((r:any)=>r.key));
 const fresh=pairs.filter(p=>!receiptByKey.has(p.plan.key));
 const observationRows:any[]=[],coverageRows:any[]=[],auditRows:any[]=[],receiptRows:any[]=[];
 for(const {input,plan,scope} of fresh){
  const r=binding(scope).review;
  for(const row of plan.rows)observationRows.push({id:'guarantee_history_'+sha(canonicalize([input.userId,row.sourceId,input.cutoff])).slice(0,40),user_id:input.userId,legacy_user_id:input.legacyUserId,account_id:row.accountId,legacy_account_id:row.sourceId,source_cutoff:input.cutoff,input_sha256:input.inputSha256,identity_digest:input.identityDigest,source_canonical:row.sourceCanonical,source_digest:row.sourceDigest});
  const p=plan.coverage;
  coverageRows.push({id:p.id,user_id:input.userId,legacy_user_id:input.legacyUserId,source_cutoff:input.cutoff,input_sha256:input.inputSha256,identity_digest:input.identityDigest,source_count:p.sourceCount,imported_count:p.importedCount,isolated_count:p.isolatedCount,source_set_digest:p.sourceSetDigest,imported_set_digest:p.importedSetDigest,isolated_set_digest:p.isolatedSetDigest,body_digest:plan.bodyDigest,input_canonical:canonicalize(input)});
  auditRows.push({id:'audit_'+randomUUID().replaceAll('-',''),object_id:p.id,details:{bodyDigest:plan.bodyDigest,approvalRef:r.ref,attempt:r.attempt,inputSha256:input.inputSha256,subjectId:input.userId,rows:p.importedCount,isolated:p.isolatedCount,financialEffect:'NONE',authorizedAt:window.authorizedAt,windowExpiresAt:window.windowExpiresAt}});
  receiptRows.push({key:plan.key,fingerprint:fingerprintRequest(operation,input.userId,input),body:{coverageId:p.id,subjectId:input.userId,bodyDigest:plan.bodyDigest,financialEffect:'NONE'}});
 }
 if(coverageRows.length){
  if(observationRows.length)await c.query(`/* guarantee batch observations */ INSERT INTO zzsh_order.legacy_owner_guarantee_observation(id,user_id,legacy_user_id,account_id,legacy_account_id,source_cutoff,input_sha256,identity_digest,source_canonical,source_digest)
   SELECT x.id,x.user_id,x.legacy_user_id,x.account_id,x.legacy_account_id,x.source_cutoff::timestamptz,x.input_sha256,x.identity_digest,x.source_canonical,x.source_digest
   FROM jsonb_to_recordset($1::jsonb) x(id text,user_id text,legacy_user_id text,account_id text,legacy_account_id text,source_cutoff text,input_sha256 text,identity_digest text,source_canonical text,source_digest text)
   ORDER BY x.user_id COLLATE "C",x.legacy_account_id COLLATE "C"`,[JSON.stringify(observationRows)]);
  await c.query(`/* guarantee batch coverage */ INSERT INTO zzsh_order.legacy_owner_guarantee_coverage(id,user_id,legacy_user_id,source_cutoff,input_sha256,identity_digest,source_count,imported_count,isolated_count,source_set_digest,imported_set_digest,isolated_set_digest,body_digest,input_canonical)
   SELECT x.id,x.user_id,x.legacy_user_id,x.source_cutoff::timestamptz,x.input_sha256,x.identity_digest,x.source_count,x.imported_count,x.isolated_count,x.source_set_digest,x.imported_set_digest,x.isolated_set_digest,x.body_digest,x.input_canonical
   FROM jsonb_to_recordset($1::jsonb) x(id text,user_id text,legacy_user_id text,source_cutoff text,input_sha256 text,identity_digest text,source_count integer,imported_count integer,isolated_count integer,source_set_digest text,imported_set_digest text,isolated_set_digest text,body_digest text,input_canonical text)
   ORDER BY x.user_id COLLATE "C",x.id COLLATE "C"`,[JSON.stringify(coverageRows)]);
  await c.query(`/* guarantee batch audit */ INSERT INTO zzsh_iam.audit_event(id,actor_type,actor_id,session_id,action,object_type,object_id,outcome,request_id,reason,occurred_at,details)
   SELECT x.id,'admin',$2,$3,$5,'legacy_owner_guarantee_coverage',x.object_id,'SUCCESS',$4,NULL,clock_timestamp(),x.details
   FROM jsonb_to_recordset($1::jsonb) x(id text,object_id text,details jsonb) ORDER BY x.object_id COLLATE "C"`,[JSON.stringify(auditRows),a.userId,a.sessionId,a.requestId,operation]);
  await c.query(`/* guarantee batch receipts */ INSERT INTO zzsh_supply.idempotency_record(scope_key,key,request_fingerprint,response_status,response_body,publish_required)
   SELECT $2,x.key,x.fingerprint,200,x.body,false FROM jsonb_to_recordset($1::jsonb) x(key text,fingerprint text,body jsonb) ORDER BY x.key COLLATE "C"`,[JSON.stringify(receiptRows),scopeKey]);
 }
 await closeMaintenanceBatch(c,a,binding(pairs[0]!.scope).review);
 return{status:200,body:{coverageCount:pairs.length,created:fresh.length,replayed:pairs.length-fresh.length,observations:observationRows.length,authorizedAt:window.authorizedAt,windowExpiresAt:window.windowExpiresAt,financialEffect:'NONE'}};
}
