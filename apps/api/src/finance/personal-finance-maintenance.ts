import type {Pool,PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {loadEffectiveAdminAccess} from '../auth/admin-authorization';
import {assertAdminContextInTransaction} from '../auth/auth-security';
import {recordAudit,setAuditContext,withTransaction,SecurityApiError} from '../auth/security-core';
import {forbidden,invalid,conflict,ensureOnlyFields,withIdempotency,fingerprintRequest} from '../supply/supply-util';
import {canonicalize} from '../supply/content-hash';
import {prepareHistoricalObservation,sourceYuanToCents,sourceSignedYuanToCents} from './personal-finance-read';
import {isStoredEconomicSource,reviewedOpeningCoveredSet,validateReviewedOpeningSources,type FinanceSourceProof} from './legacy-finance-source-evidence';

type Actor={userId:string;sessionId:string;requestId:string};
export type OpeningMaintenanceInput={inputSha256:string;cutoff:string;proof:{userId:string;source:{sourceSystem:string;sourceEntity:string;sourceId:string;identityDigest:string};availableCents:string;sourceDigest:string;coveredCount:number;coveredDigest:string;coveredSet:string[][]};observations:Record<string,unknown>[];admissions:{sourceEntity:string;sourceId:string;sourceDigest:string;sourceEventAt:string;included:boolean}[]};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export type FinanceOpeningReview={
 ref:string;attempt:string;actor:{userId:string;sessionId:string};
 resource:{host:'127.0.0.1';port:55432;database:string;oid:number;owner:string;marker:string;role:string;roleOid:number};
 notBefore:string;expiresAt:string;inputSha256:string;cutoff:string;bodyDigest:string;
 subject:{userId:string;sourceId:string;identityDigest:string;sourceDigest:string;availableCents:string;coveredDigest:string};
};
export type FinanceOpeningAdmission=Readonly<{kind:'REVIEWED_FINANCE_OPENING'}>;
export type StoredOpeningInput=OpeningMaintenanceInput&{sourceCanonical:string;sourceProof?:FinanceSourceProof};
export type StoredOpeningReview=FinanceOpeningReview&{coveredCount:number;observationCount:number;admissionDigest:string;sourceProofDigest?:string};
const admissions=new WeakMap<object,{review:FinanceOpeningReview;recoveryOnly:boolean;stored?:Pick<StoredOpeningReview,'coveredCount'|'observationCount'|'admissionDigest'|'sourceProofDigest'>}>();
const digest=/^[a-f0-9]{64}$/,identifier=/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
function admission(value:FinanceOpeningAdmission){const p=admissions.get(value);if(!p)throw invalid('Finance opening admission is not internally bound');return p;}
async function assertAdmission(client:PoolClient,actor:Actor,scope:FinanceOpeningAdmission,recover=false){
 const p=admission(scope);
 await assertFinanceMaintenanceResource(client,actor,p.review,{recover,recoveryOnly:p.recoveryOnly});return p.review;
}
/** Shared actual-resource check for the separately reviewed maintenance entries. No approval is minted here. */
export async function assertFinanceMaintenanceResource(client:PoolClient,actor:Actor,r:Pick<FinanceOpeningReview,'actor'|'resource'|'notBefore'|'expiresAt'>,mode:{recover?:boolean;recoveryOnly?:boolean}={}){
 const connection=(client as PoolClient & {connectionParameters?:{host:string;port:number;database:string;user:string}}).connectionParameters;
 if(actor.userId!==r.actor.userId||actor.sessionId!==r.actor.sessionId)throw forbidden('Opening approval belongs to another actor/session');
 if(!connection||connection.host!==r.resource.host||connection.port!==r.resource.port||connection.database!==r.resource.database||connection.user!==r.resource.role)throw conflict('Opening connection does not match reviewed local resource');
 const actual=(await client.query(`/* finance-opening resource */ SELECT d.oid::int AS oid,current_database() AS database,pg_get_userbyid(d.datdba) AS owner,
 shobj_description(d.oid,'pg_database') AS marker,current_user AS role,r.oid::int AS "roleOid",clock_timestamp() AS now,
 (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=to_regclass('zzsh_order.finance_opening_basis')) AS "tableOwner"
 FROM pg_database d JOIN pg_roles r ON r.rolname=current_user WHERE d.datname=current_database()`)).rows[0];
 if(!actual||['oid','database','owner','marker','role','roleOid'].some(k=>actual[k]!==r.resource[k as keyof FinanceOpeningReview['resource']])||actual.tableOwner!==r.resource.role)throw conflict('Opening database identity/owner/role is not reviewed');
 const now=new Date(actual.now).getTime(),start=Date.parse(r.notBefore),end=Date.parse(r.expiresAt);
 if(![now,start,end].every(Number.isFinite)||end<=start||now<start||(!mode.recover&&(mode.recoveryOnly||now>=end)))throw forbidden('Opening execution window is not active');
}
/** Only the separately reviewed internal runner supplies this out-of-band review, never request JSON.
 * The opaque result is not serializable authority; real connection/role/time are checked again at use. */
export async function bindReviewedFinanceOpeningAdmission(client:PoolClient,actor:Actor,review:FinanceOpeningReview,mode:'execute'|'recover'='execute'):Promise<FinanceOpeningAdmission>{
 if(!review||typeof review!=='object'||!review.resource||!review.actor||!review.subject)throw invalid('Complete internal opening review required');
 ensureOnlyFields(review,['ref','attempt','actor','resource','notBefore','expiresAt','inputSha256','cutoff','bodyDigest','subject']);
 ensureOnlyFields(review.actor,['userId','sessionId']);ensureOnlyFields(review.resource,['host','port','database','oid','owner','marker','role','roleOid']);
 ensureOnlyFields(review.subject,['userId','sourceId','identityDigest','sourceDigest','availableCents','coveredDigest']);
 if(![review.ref,review.attempt,review.actor.userId,review.actor.sessionId,review.subject.userId].every(x=>typeof x==='string'&&identifier.test(x))
 ||review.resource.host!=='127.0.0.1'||review.resource.port!==55432||!/^zzsh_test_order_[a-z][a-z0-9_]{0,20}$/.test(review.resource.database)
 ||![review.resource.owner,review.resource.role].every(x=>typeof x==='string'&&/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(x))||review.resource.marker!=='zzsh:order-reservation-test:v1'
 ||![review.resource.oid,review.resource.roleOid].every(x=>Number.isSafeInteger(x)&&x>0)||typeof review.subject.sourceId!=='string'||!/^[1-9]\d{0,23}$/.test(review.subject.sourceId)
 ||typeof review.subject.availableCents!=='string'||!/^(0|[1-9]\d{0,23})$/.test(review.subject.availableCents)||!['execute','recover'].includes(mode)
 ||![review.inputSha256,review.bodyDigest,review.subject.identityDigest,review.subject.sourceDigest,review.subject.coveredDigest].every(x=>typeof x==='string'&&digest.test(x))
 ||![review.notBefore,review.expiresAt,review.cutoff].every(x=>typeof x==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(x)&&Number.isFinite(Date.parse(x)))||Date.parse(review.expiresAt)<=Date.parse(review.notBefore))throw invalid('Exact reviewed opening binding required');
 const token=Object.freeze({kind:'REVIEWED_FINANCE_OPENING' as const});admissions.set(token,{review:JSON.parse(canonicalize(review)),recoveryOnly:mode==='recover'});
 try{await authorizeFinanceMaintenance(client,actor);await assertAdmission(client,actor,token,mode==='recover');return token;}catch(error){admissions.delete(token);throw error;}
}
/** A separate, bounded review of each stored balance; the original C admissions stay unchanged. */
export async function bindReviewedStoredOpeningAdmission(client:PoolClient,actor:Actor,review:StoredOpeningReview,mode:'execute'|'recover'='execute'){
 if(!review||Date.parse(review.cutoff)>Date.parse(review.notBefore)||!Number.isSafeInteger(review.coveredCount)||review.coveredCount<0||review.coveredCount>5000
  ||!Number.isSafeInteger(review.observationCount)||review.observationCount<0||review.observationCount>10000||!digest.test(review.admissionDigest)
  ||review.sourceProofDigest!==undefined&&!digest.test(review.sourceProofDigest))throw invalid('Exact bounded stored review required');
 const {coveredCount,observationCount,admissionDigest,sourceProofDigest,...base}=JSON.parse(canonicalize(review)) as StoredOpeningReview;
 const scope=await bindReviewedFinanceOpeningAdmission(client,actor,base,mode);
 admission(scope).stored={coveredCount,observationCount,admissionDigest,...(sourceProofDigest!==undefined?{sourceProofDigest}:{})};return scope;
}
function validateStoredOpening(input:StoredOpeningInput,review:NonNullable<ReturnType<typeof admission>['stored']>){
 ensureOnlyFields(input,['inputSha256','cutoff','proof','observations','admissions','sourceCanonical','sourceProof']);
 const p=input.proof;ensureOnlyFields(p,['userId','source','availableCents','sourceDigest','coveredCount','coveredDigest','coveredSet']);
 ensureOnlyFields(p.source,['sourceSystem','sourceEntity','sourceId','identityDigest']);
 let source:Record<string,unknown>;
 try{source=JSON.parse(input.sourceCanonical);}catch{throw invalid('Original stored source canonical required');}
 if(source&&typeof source==='object'&&!Array.isArray(source))ensureOnlyFields(source,['id','earnings','money']);
 if(!source||Array.isArray(source)||typeof source!=='object'||input.sourceCanonical.length>262144||canonicalize(source)!==input.sourceCanonical
  ||typeof source.id!=='string'||sha(JSON.stringify({id:source.id,earnings:source.earnings,money:source.money}))!==p.sourceDigest||source.id!==p.source.sourceId||sourceYuanToCents(source.earnings)!==p.availableCents)throw invalid('Stored amount/source does not close');
 sourceSignedYuanToCents(source.money);
 if(!Array.isArray(p.coveredSet)||p.coveredCount!==review.coveredCount||p.coveredSet.length!==review.coveredCount
  ||!Array.isArray(input.observations)||input.observations.length!==review.observationCount
  ||!Array.isArray(input.admissions)||input.admissions.length!==review.observationCount||sha(canonicalize(input.admissions))!==review.admissionDigest)throw invalid('Stored opening reviewed set changed');
 const keys=new Set<string>();let previous='';
 for(const row of p.coveredSet){
  if(!Array.isArray(row)||row.length!==8||row.some(v=>typeof v!=='string')||row[0]!==p.userId||row[2]!=='LEGACY_MYSQL'||!/^[1-9]\d{0,23}$/.test(row[4]!)
   ||!/^\d{1,10}$/.test(row[6]!)||BigInt(row[6]!)<1n||BigInt(row[6]!)>4294967295n||Number(row[6])*1000>Date.parse(input.cutoff)||!digest.test(row[7]!))throw invalid('Stored covered economic tuple invalid');
  const [,kind,,entity,,role]=row;
  if(!isStoredEconomicSource(kind!,entity!,role!))throw invalid('Unresolved stored economic source');
  const key=JSON.stringify(row.slice(1,6));if(keys.has(key)||previous&&key<=previous)throw invalid('Stored covered set must be unique in source C order');keys.add(key);previous=key;
 }
 for(const a of input.admissions){ensureOnlyFields(a,['sourceEntity','sourceId','sourceDigest','sourceEventAt','included']);if(typeof a.included!=='boolean'||!digest.test(a.sourceDigest))throw invalid('Exact stored observation admission required');}
 if(input.sourceProof!==undefined){
  const proof=input.sourceProof;
  if(!proof||typeof proof!=='object'||proof.schema!=='legacy-finance-source-proof.v1'||sha(canonicalize(proof))!==review.sourceProofDigest
   ||!Array.isArray(proof.logBindings)||!Array.isArray(proof.supplementalLogs))throw invalid('Stored source proof is not separately reviewed');
  ensureOnlyFields(proof,['schema','sources','logBindings','supplementalLogs']);
  const subject={userId:p.userId,legacyUserId:p.source.sourceId};
  if(canonicalize(reviewedOpeningCoveredSet(proof.sources,subject,input.cutoff))!==canonicalize(p.coveredSet))throw invalid('Stored source proof differs from covered set');
  if(!validateReviewedOpeningSources({covered:proof.sources,logBindings:proof.logBindings,sourceEvidence:proof.supplementalLogs,observations:input.observations,cutoff:input.cutoff,
   included:input.admissions.filter(a=>a.included).map(a=>a.sourceEntity+':'+a.sourceId)},subject))throw invalid('Stored source evidence is incomplete');
 }else if(review.sourceProofDigest!==undefined||p.coveredSet.some(row=>row[1]==='LEGACY_WITHDRAWAL_RETURN'))throw invalid('Withdrawal return requires its reviewed original source proof');
}
function reviewedInput(input:OpeningMaintenanceInput,scope:FinanceOpeningAdmission){
 const r=admission(scope).review,p=input.proof,s=r.subject;
 if(sha(canonicalize(input))!==r.bodyDigest||input.inputSha256!==r.inputSha256||input.cutoff!==r.cutoff||!p||p.userId!==s.userId||p.source.sourceSystem!=='legacy_mysql_restore'||p.source.sourceEntity!=='la_user'||p.source.sourceId!==s.sourceId||p.source.identityDigest!==s.identityDigest||p.sourceDigest!==s.sourceDigest||p.availableCents!==s.availableCents||p.coveredDigest!==s.coveredDigest)throw invalid('Opening body/subject differs from internal review');
 const stored=admission(scope).stored;
 if(stored){validateStoredOpening(input as StoredOpeningInput,stored);return r;}
 if(p.coveredCount!==1||p.coveredSet.length!==1||input.observations.length!==1||input.admissions.length!==1)throw invalid('One reviewed economic root and one observation required');
 const c=p.coveredSet[0]!,o=input.observations[0]!,a=input.admissions[0]!;
 if(c.length!==8||c.some(x=>typeof x!=='string')||c[0]!==p.userId||c[1]!=='LEGACY_DISTRIBUTION_EARNING'||c[2]!=='LEGACY_MYSQL'||c[3]!=='la_distribution_order'||!/^[1-9]\d{0,23}$/.test(c[4]!)||c[5]!=='RENTER_REFERRAL'||!/^\d+$/.test(c[6]!)||!digest.test(c[7]!)||c[7]===p.source.identityDigest||c[7]===p.sourceDigest)throw invalid('Unreviewed economic source/beneficiary');
 if(o.kind!=='earningsLog'||o.action!==1||String(o.sourceUserId)!==p.source.sourceId||o.referenceType!=='LEGACY_DISTRIBUTION_EARNING'||o.referenceId!==c[4]||typeof o.referenceSn!=='string'||!o.referenceSn||o.referenceSn.length>255||String(o.createdAt)!==c[6]
 ||sourceYuanToCents(o.amount)!==p.availableCents||sourceSignedYuanToCents(o.leftAmount)!==p.availableCents||a.sourceEntity!=='la_log_earnings'||a.sourceId!==String(o.sourceId)||a.included!==true||a.sourceDigest!==sha(canonicalize(o))||c[7]===a.sourceDigest)throw invalid('Economic source and covered balance observation do not close');
 return r;
}
function batch(inputs:OpeningMaintenanceInput[],reviewed:readonly string[]|FinanceOpeningAdmission):FinanceOpeningAdmission|undefined{
 if(!Array.isArray(reviewed)){if(inputs.length!==1)throw invalid('Reviewed opening admission binds one subject');const scope=reviewed as FinanceOpeningAdmission;reviewedInput(inputs[0]!,scope);return scope;}
 if(inputs.length!==3||reviewed.length!==3||new Set(reviewed).size!==3||new Set(inputs.map(i=>i.proof.userId)).size!==3)throw invalid('Opening batch must be the three distinct reviewed subjects');
 const expected=new Set(reviewed);for(const input of inputs)if(!expected.has(sha(canonicalize(input))))throw invalid('Opening body changed after review');return undefined;
}
export async function authorizeFinanceMaintenance(client:PoolClient,actor:Actor){await assertAdminContextInTransaction(client,actor);const access=await loadEffectiveAdminAccess(client,actor.userId);const user=(await client.query('SELECT suspended FROM zzsh_auth_admin."user" WHERE id=$1',[actor.userId])).rows[0];if(!access||!access.isBoss||access.status!=='ACTIVE'||access.passwordChangeRequired||user?.suspended!==false)throw forbidden('Explicit active Boss maintenance actor required');}
export async function planFinanceOpening(client:PoolClient,actor:Actor,input:OpeningMaintenanceInput,scope?:FinanceOpeningAdmission){return planOpening(client,actor,input,scope);}
async function planOpening(client:PoolClient,actor:Actor,input:OpeningMaintenanceInput,scope?:FinanceOpeningAdmission,recover=false){
 // Request fingerprints retain the original JSON key order; review digests stay canonical.
 input=JSON.parse(JSON.stringify(input));
 await authorizeFinanceMaintenance(client,actor);
 if(scope){reviewedInput(input,scope);await assertAdmission(client,actor,scope,recover);}
 else if(input.inputSha256!=='ee431b3ac1ed74952bbc08e57581c6d9ab04a4bd01100ca05ac00a77e6175ec0'||input.cutoff!=='2026-10-03T02:31:22.516Z')throw invalid('Unreviewed frozen input or cutoff');
 const p=input.proof;if(!/^(0|[1-9]\d{0,23})$/.test(p.availableCents)||p.source.sourceEntity!=='la_user'||p.coveredCount!==p.coveredSet.length)throw invalid('Opening proof invalid');
 if(scope&&admission(scope).stored){const schema=(await client.query(`/* stored opening review schema */ SELECT to_regclass('zzsh_order.finance_stored_opening_review') IS NOT NULL AS ready,
  (SELECT pg_get_userbyid(relowner) FROM pg_class WHERE oid=to_regclass('zzsh_order.finance_stored_opening_review')) AS owner,
  to_regprocedure('zzsh_order.legacy_opening_source_proof(text)') IS NOT NULL AND EXISTS(SELECT 1 FROM pg_trigger
   WHERE tgrelid=to_regclass('zzsh_order.finance_stored_opening_review') AND tgname='stored_opening_source_proof_guard' AND tgenabled='O' AND NOT tgisinternal) AS proof_ready`)).rows[0];
  if(schema?.ready!==true||schema.owner!==admission(scope).review.resource.role)throw conflict('Stored opening review schema/owner not admitted');
  if((input as StoredOpeningInput).sourceProof!==undefined&&schema.proof_ready!==true)throw new SecurityApiError(503,'EVIDENCE_UNAVAILABLE','Reviewed legacy source-proof schema is not deployed');}
 const identity=(await client.query(`SELECT 1 FROM zzsh_iam.audit_event WHERE object_id=$1 AND action='user.legacy_owner.migrated' AND outcome='SUCCESS' AND details->>'sourceSystem'=$2 AND details->>'sourceEntity'='la_user' AND details->>'legacyId'=$3 AND details->>'sourceDigest'=$4`,[p.userId,p.source.sourceSystem,p.source.sourceId,p.source.identityDigest])).rowCount;
 if(!identity)throw conflict('Opening source identity changed');
 if(sha(p.coveredSet.map(row=>JSON.stringify(row)).join('\n'))!==p.coveredDigest)throw invalid('Covered set digest mismatch');
 const basisId='basis_'+sha(p.userId).slice(0,32),admitted=new Map(input.admissions.map(a=>[a.sourceEntity+':'+a.sourceId,a]));
 if(admitted.size!==input.admissions.length||input.observations.length!==input.admissions.length)throw invalid('Observation admission set mismatch');
 const observations=input.observations.map(row=>{const entity=row.kind==='earningsLog'?'la_log_earnings':row.kind==='historicalDistribution'?'la_distribution_order':row.kind==='withdrawObservation'?'la_withdraw_apply':null;if(!entity)throw invalid('Historical entity unsupported');const a=admitted.get(entity+':'+String(row.sourceId));if(!a)throw invalid('Historical row absent from frozen admission');const prepared=prepareHistoricalObservation(row,{userId:p.userId,legacyUserId:p.source.sourceId,sourceSystem:p.source.sourceSystem,basisId,openingAdmission:{sourceDigest:a.sourceDigest,included:a.included,cutoff:input.cutoff}});if(prepared.sourceEventAt!==a.sourceEventAt)throw invalid('Historical event time changed');return prepared;});
 return {basisId,rootId:'root_'+sha(p.userId).slice(0,32),eventId:'opening_'+sha(p.userId).slice(0,32),observations,bodyDigest:sha(canonicalize(input)),key:'u2-opening-'+sha(canonicalize([p.source.sourceSystem,p.source.sourceId,p.userId])).slice(0,32)};
}
/** Caller owns a transaction and only a separately reviewed maintenance runner
 * may call this. There is no public HTTP import endpoint or default execute. */
export async function importFinanceOpening(client:PoolClient,actor:Actor,input:OpeningMaintenanceInput,scope?:FinanceOpeningAdmission){
 input=JSON.parse(JSON.stringify(input));
 const plan=await planFinanceOpening(client,actor,input,scope),p=input.proof;
 const result=await withIdempotency(client,{realm:'admin',principalId:actor.userId,operation:'finance.opening.import'},plan.key,fingerprintRequest('finance.opening.import',p.userId,input),async()=>{await authorizeFinanceMaintenance(client,actor);if(scope)await assertAdmission(client,actor,scope);},async()=>{
  await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`,[p.userId]);
  const stored=scope?admission(scope).stored:undefined,reused=new Set<string>();
  if(stored)await setAuditContext(client,'admin',actor.userId,actor.sessionId,actor.requestId);
  if(stored)for(const o of plan.observations){
   const row=(await client.query(`/* stored opening existing observation */ SELECT * FROM zzsh_order.personal_finance_observation WHERE source_type='LEGACY_MYSQL' AND source_system=$1 AND source_entity=$2 AND source_id=$3`,[o.sourceSystem,o.sourceEntity,o.sourceId])).rows[0];
   if(!row)continue;
   if(row.user_id!==p.userId||row.legacy_user_id!==o.legacyUserId||row.source_kind!==o.sourceKind||row.basis_id!==null||row.included_in_opening!==false||row.source_digest!==o.sourceDigest||row.source_canonical!==o.sourceCanonical||canonicalize(row.snapshot)!==o.sourceCanonical||new Date(row.source_event_at).toISOString()!==o.sourceEventAt)throw conflict('Existing historical fact cannot be attached to this opening');
   reused.add(o.sourceEntity+':'+o.sourceId);
  }
  const revision=(await client.query('SELECT ledger_revision::text FROM zzsh_order.wallet_revision WHERE user_id=$1',[p.userId])).rows[0]?.ledger_revision??'0';
  await client.query(`INSERT INTO zzsh_order.finance_opening_basis(id,user_id,source_kind,source_system,source_entity,source_id,identity_source_digest,source_digest,available_cents,source_cutoff,covered_count,covered_set_digest) VALUES($1,$2,'LEGACY_OPENING',$3,'la_user',$4,$5,$6,$7,$8,$9,$10)`,[plan.basisId,p.userId,p.source.sourceSystem,p.source.sourceId,p.source.identityDigest,p.sourceDigest,p.availableCents,input.cutoff,p.coveredCount,p.coveredDigest]);
  if(stored&&scope)await client.query(`INSERT INTO zzsh_order.finance_stored_opening_review(basis_id,body_digest,source_canonical,review_canonical,review_digest,input_canonical) VALUES($1,$2,$3,$4,$5,$6)`,[plan.basisId,plan.bodyDigest,(input as StoredOpeningInput).sourceCanonical,canonicalize({...admission(scope).review,...stored}),sha(canonicalize({...admission(scope).review,...stored})),canonicalize(input)]);
  for(const row of p.coveredSet)await client.query(`INSERT INTO zzsh_order.finance_covered_event(basis_id,user_id,source_kind,source_type,source_entity,source_id,beneficiary_role,source_event_at,source_digest) VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),$9)`,[plan.basisId,...row]);
  await client.query(`INSERT INTO zzsh_order.finance_economic_root(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,source_digest) VALUES($1,$2,'LEGACY_OPENING','LEGACY_MYSQL',$3,'la_user',$4,$5,'WALLET_HOLDER',$6)`,[plan.rootId,plan.basisId,p.source.sourceSystem,p.source.sourceId,p.userId,p.sourceDigest]);
  await client.query(`INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision) VALUES($1,$2,'OPENING',$3,$4)`,[plan.eventId,plan.rootId,p.userId,revision]);
  if(p.availableCents!=='0')await client.query(`INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details) VALUES($1,$2,1,'LEGACY_OPENING_SOURCE',$3,0,NULL,$5::jsonb),($4,$2,2,'WALLET_AVAILABLE',0,$3,$6,$5::jsonb)`,['dr_'+plan.eventId,plan.eventId,p.availableCents,'cr_'+plan.eventId,JSON.stringify({basisId:plan.basisId,economicRootId:plan.rootId,sourceDigest:p.sourceDigest}),p.userId]);
  for(const o of plan.observations){await client.query(`INSERT INTO zzsh_order.finance_observation_admission(basis_id,user_id,source_system,legacy_user_id,source_entity,source_id,source_digest,source_event_at,included_in_opening) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[plan.basisId,p.userId,o.sourceSystem,o.legacyUserId,o.sourceEntity,o.sourceId,o.sourceDigest,o.sourceEventAt,o.includedInOpening]);if(!reused.has(o.sourceEntity+':'+o.sourceId))await client.query(`INSERT INTO zzsh_order.personal_finance_observation(id,user_id,basis_id,source_kind,source_type,source_system,legacy_user_id,source_entity,source_id,source_digest,source_canonical,source_event_at,included_in_opening,snapshot) VALUES($1,$2,$3,$4,'LEGACY_MYSQL',$5,$6,$7,$8,$9,$10::text,$11,$12,$10::text::jsonb)`,['obs_'+sha(canonicalize([o.sourceSystem,o.sourceEntity,o.sourceId])).slice(0,32),p.userId,plan.basisId,o.sourceKind,o.sourceSystem,o.legacyUserId,o.sourceEntity,o.sourceId,o.sourceDigest,o.sourceCanonical,o.sourceEventAt,o.includedInOpening]);}
  if(scope)await assertAdmission(client,actor,scope);
  await recordAudit(client,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:'finance.opening.imported',objectType:'finance_event',objectId:plan.eventId,outcome:'SUCCESS',reason:'Master-reviewed local frozen opening',details:{inputSha256:input.inputSha256,bodyDigest:plan.bodyDigest,subjectId:p.userId,sourceDigest:p.sourceDigest,cutoff:input.cutoff,observations:plan.observations.length,...(scope?{approvalRef:admission(scope).review.ref,attempt:admission(scope).review.attempt}:{})}});
  return {status:200,body:{eventId:plan.eventId,subjectId:p.userId,bodyDigest:plan.bodyDigest}};
 });
 if(scope)await assertAdmission(client,actor,scope);
 return result;
}

/** The authenticated, separately approved CLI supplies the exact reviewed body
 * digests. All subjects share one transaction; no half-import checkpoint. */
export async function importReviewedFinanceOpeningBatch(pool:Pool,actor:Actor,inputs:OpeningMaintenanceInput[],reviewed:readonly string[]|FinanceOpeningAdmission){
 inputs=JSON.parse(JSON.stringify(inputs));
 const scope=batch(inputs,reviewed);
 return withTransaction(pool,async client=>{
  await client.query(`SELECT s.id FROM zzsh_auth_admin.session s JOIN zzsh_auth_admin."user" u ON u.id=s."userId" JOIN zzsh_iam.admin_security a ON a.admin_user_id=s."userId" WHERE s.id=$1 AND s."userId"=$2 FOR SHARE OF s,u,a`,[actor.sessionId,actor.userId]);
  const results=[];
  for(const input of [...inputs].sort((a,b)=>a.proof.userId<b.proof.userId?-1:1))results.push(await importFinanceOpening(client,actor,input,scope));
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  if(scope)await assertAdmission(client,actor,scope);
  return results;
 });
}

function storedPairs(inputs:StoredOpeningInput[],scopes:FinanceOpeningAdmission[]){
 if(!Array.isArray(inputs)||inputs.length<1||inputs.length>100||inputs.length!==scopes.length||new Set(inputs.map(i=>i.proof.userId)).size!==inputs.length
  ||inputs.reduce((n,i)=>n+i.observations.length,0)>50000)throw invalid('Bounded distinct stored opening subjects required');
 return inputs.map((input,i)=>{const scope=scopes[i]!;if(!admission(scope).stored)throw invalid('Stored opening requires its separate internal review');reviewedInput(input,scope);return{input,scope};}).sort((a,b)=>a.input.proof.userId<b.input.proof.userId?-1:1);
}
/** Each subject is explicitly reviewed; this is not an arbitrary digest allowlist or a default execution path. */
export async function importReviewedStoredOpeningBatch(pool:Pool,actor:Actor,inputs:StoredOpeningInput[],scopes:FinanceOpeningAdmission[]){
 const pairs=storedPairs(JSON.parse(JSON.stringify(inputs)),scopes);
 return withTransaction(pool,async client=>{const results=[];for(const p of pairs)results.push(await importFinanceOpening(client,actor,p.input,p.scope));await client.query('SET CONSTRAINTS ALL IMMEDIATE');for(const p of pairs)await assertAdmission(client,actor,p.scope);return results;});
}
export async function recoverReviewedStoredOpeningBatch(client:PoolClient,actor:Actor,inputs:StoredOpeningInput[],scopes:FinanceOpeningAdmission[]){
 const pairs=storedPairs(JSON.parse(JSON.stringify(inputs)),scopes),results=[];
 for(const p of pairs)results.push(...(await recoverReviewedFinanceOpeningBatch(client,actor,[p.input],p.scope)).results);
 return{knowledge:results.every(r=>r.knowledge==='KNOWN')?'KNOWN':'UNKNOWN',results};
}

/** Read-only recovery after a commit acknowledgement or readback failure.
 * Missing receipts stay UNKNOWN; this never calls the import action or invents a key. */
export async function recoverReviewedFinanceOpeningBatch(client:PoolClient,actor:Actor,inputs:OpeningMaintenanceInput[],reviewed:readonly string[]|FinanceOpeningAdmission){
 inputs=JSON.parse(JSON.stringify(inputs));
 await authorizeFinanceMaintenance(client,actor);
 const scope=batch(inputs,reviewed),results=[];
 for(const input of inputs){
  const bodyDigest=sha(canonicalize(input));
  const plan=await planOpening(client,actor,input,scope,true);
  const row=(await client.query(`SELECT request_fingerprint AS fingerprint,response_status AS status,response_body AS body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2`,[JSON.stringify(['admin',actor.userId,'finance.opening.import',null]),plan.key])).rows[0];
  if(!row){results.push({subjectId:input.proof.userId,key:plan.key,knowledge:'UNKNOWN',receipt:null});continue;}
  if(row.fingerprint!==fingerprintRequest('finance.opening.import',input.proof.userId,input)||row.status!==200||row.body?.eventId!==plan.eventId||row.body?.subjectId!==input.proof.userId||row.body?.bodyDigest!==bodyDigest)throw conflict('Opening recovery receipt conflicts with original body');
  const facts=(await client.query(`SELECT b.available_cents::text AS amount,b.user_id AS subject,e.kind,count(l.id)::int AS lines,COALESCE(sum(l.debit_cents),0)::text AS debits,COALESCE(sum(l.credit_cents),0)::text AS credits FROM zzsh_order.finance_opening_basis b JOIN zzsh_order.finance_economic_root r ON r.basis_id=b.id JOIN zzsh_order.finance_event e ON e.economic_root_id=r.id LEFT JOIN zzsh_order.settlement_ledger_entry l ON l.finance_event_id=e.id WHERE b.id=$1 AND r.id=$2 AND e.id=$3 GROUP BY b.available_cents,b.user_id,e.kind`,[plan.basisId,plan.rootId,plan.eventId])).rows[0];
  const amount=BigInt(input.proof.availableCents);
  if(!facts||facts.subject!==input.proof.userId||facts.kind!=='OPENING'||facts.amount!==amount.toString()||facts.lines!==(amount===0n?0:2)||facts.debits!==amount.toString()||facts.credits!==amount.toString())throw conflict('Opening recovery financial evidence conflicts with receipt');
  if(scope)await verifyReviewedRecovery(client,actor,input,plan,scope);
  results.push({subjectId:input.proof.userId,key:plan.key,knowledge:'KNOWN',receipt:{status:row.status,body:row.body},originalOpeningVerified:true});
 }
 if(scope){await authorizeFinanceMaintenance(client,actor);await assertAdmission(client,actor,scope,true);}
 return {knowledge:results.every(r=>r.knowledge==='KNOWN')?'KNOWN':'UNKNOWN',results};
}

async function verifyReviewedRecovery(client:PoolClient,actor:Actor,input:OpeningMaintenanceInput,plan:Awaited<ReturnType<typeof planFinanceOpening>>,scope:FinanceOpeningAdmission){
 const p=input.proof,r=admission(scope).review;
 const stored=admission(scope).stored;
 if(stored){const row=(await client.query(`/* stored opening recovery review */ SELECT body_digest,source_canonical,review_canonical,review_digest FROM zzsh_order.finance_stored_opening_review WHERE basis_id=$1`,[plan.basisId])).rows[0],canonical=canonicalize({...r,...stored});if(!row||row.body_digest!==plan.bodyDigest||row.source_canonical!==(input as StoredOpeningInput).sourceCanonical||row.review_canonical!==canonical||row.review_digest!==sha(canonical))throw conflict('Stored opening recovery review differs from original');}
 const basis=(await client.query(`/* finance-opening recovery basis */ SELECT b.user_id AS "userId",b.source_system AS "sourceSystem",b.source_entity AS "sourceEntity",b.source_id AS "sourceId",b.identity_source_digest AS "identityDigest",b.source_digest AS "sourceDigest",
 to_char(b.source_cutoff AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS cutoff,b.covered_count AS "coveredCount",b.covered_set_digest AS "coveredDigest",
 r.source_kind AS "rootKind",r.source_type AS "rootType",r.source_system AS "rootSystem",r.source_entity AS "rootEntity",r.source_id AS "rootSourceId",r.subject_user_id AS "rootSubject",r.beneficiary_role AS "rootRole"
 FROM zzsh_order.finance_opening_basis b JOIN zzsh_order.finance_economic_root r ON r.basis_id=b.id AND r.id=$2 WHERE b.id=$1`,[plan.basisId,plan.rootId])).rows;
 const expectedBasis={userId:p.userId,sourceSystem:p.source.sourceSystem,sourceEntity:'la_user',sourceId:p.source.sourceId,identityDigest:p.source.identityDigest,sourceDigest:p.sourceDigest,cutoff:new Date(input.cutoff).toISOString(),coveredCount:p.coveredCount,coveredDigest:p.coveredDigest,rootKind:'LEGACY_OPENING',rootType:'LEGACY_MYSQL',rootSystem:p.source.sourceSystem,rootEntity:'la_user',rootSourceId:p.source.sourceId,rootSubject:p.userId,rootRole:'WALLET_HOLDER'};
 const covered=(await client.query(`/* finance-opening recovery covered */ SELECT jsonb_build_array(user_id,source_kind,source_type,source_entity,source_id,beneficiary_role,extract(epoch FROM source_event_at)::bigint::text,source_digest) AS row FROM zzsh_order.finance_covered_event WHERE basis_id=$1 ORDER BY source_kind COLLATE "C",source_type COLLATE "C",source_entity COLLATE "C",source_id COLLATE "C",beneficiary_role COLLATE "C"`,[plan.basisId])).rows.map(x=>x.row);
 const observed=(await client.query(`/* finance-opening recovery observations */ SELECT a.user_id AS "userId",a.source_system AS "sourceSystem",a.legacy_user_id AS "legacyUserId",a.source_entity AS "sourceEntity",a.source_id AS "sourceId",a.source_digest AS "sourceDigest",to_char(a.source_event_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "sourceEventAt",a.included_in_opening AS included,o.source_canonical AS canonical,o.user_id AS "observationUserId",o.basis_id AS "observationBasis",o.source_digest AS "observationDigest",o.source_canonical AS "observationCanonical",o.included_in_opening AS "observationIncluded"
 FROM zzsh_order.finance_observation_admission a FULL JOIN zzsh_order.personal_finance_observation o ON ${stored?'o.user_id=a.user_id AND o.source_system=a.source_system':'o.basis_id=a.basis_id'} AND o.source_entity=a.source_entity AND o.source_id=a.source_id WHERE a.basis_id=$1 OR o.basis_id=$1 ORDER BY a.source_entity COLLATE "C",a.source_id COLLATE "C"`,[plan.basisId])).rows;
 const expectedObservations=plan.observations.map(o=>({userId:p.userId,sourceSystem:o.sourceSystem,legacyUserId:o.legacyUserId,sourceEntity:o.sourceEntity,sourceId:o.sourceId,sourceDigest:o.sourceDigest,sourceEventAt:o.sourceEventAt,included:o.includedInOpening,canonical:o.sourceCanonical,observationUserId:p.userId,observationBasis:plan.basisId,observationDigest:o.sourceDigest,observationCanonical:o.sourceCanonical,observationIncluded:o.includedInOpening}));
 if(stored)expectedObservations.sort((a,b)=>a.sourceEntity<b.sourceEntity?-1:a.sourceEntity>b.sourceEntity?1:a.sourceId<b.sourceId?-1:a.sourceId>b.sourceId?1:0);
 const ledger=(await client.query(`/* finance-opening recovery ledger */ SELECT line_no AS line,account_code AS account,debit_cents::text AS debit,credit_cents::text AS credit,counterparty_user_id AS subject FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=$1 ORDER BY line_no`,[plan.eventId])).rows;
 const expectedLedger=p.availableCents==='0'?[]:[{line:1,account:'LEGACY_OPENING_SOURCE',debit:p.availableCents,credit:'0',subject:null},{line:2,account:'WALLET_AVAILABLE',debit:'0',credit:p.availableCents,subject:p.userId}];
 const audit=await client.query(`/* finance-opening recovery audit */ SELECT 1 FROM zzsh_iam.audit_event WHERE action='finance.opening.imported' AND object_type='finance_event' AND object_id=$1 AND actor_type='admin' AND actor_id=$2 AND session_id=$7 AND outcome='SUCCESS' AND details->>'bodyDigest'=$3 AND details->>'inputSha256'=$4 AND details->>'approvalRef'=$5 AND details->>'attempt'=$6`,[plan.eventId,actor.userId,plan.bodyDigest,input.inputSha256,r.ref,r.attempt,actor.sessionId]);
 if(stored)for(const row of observed)if(row.observationBasis===null&&row.observationIncluded===false){row.observationBasis=plan.basisId;row.observationIncluded=row.included;}
 if(canonicalize(basis)!==canonicalize([expectedBasis])||canonicalize(covered)!==canonicalize(p.coveredSet)||canonicalize(observed)!==canonicalize(expectedObservations)||canonicalize(ledger)!==canonicalize(expectedLedger)||audit.rowCount!==1)throw conflict('Opening recovery coverage/observations/audit differ from original review');
}
