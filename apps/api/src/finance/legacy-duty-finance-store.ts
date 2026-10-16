import type {PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {canonicalize} from '../supply/content-hash';
import {assertAdminContextInTransaction} from '../auth/auth-security';
import {loadEffectiveAdminAccess,requirePermission} from '../auth/admin-authorization';
import {recordAudit,setAuditContext,SecurityApiError} from '../auth/security-core';
import {assertGameScope,conflict,ensureOnlyFields,fingerprintRequest,invalid,notFound,withIdempotency} from '../supply/supply-util';
import {assertFinanceMaintenanceResource,authorizeFinanceMaintenance,type FinanceOpeningReview} from './personal-finance-maintenance';
import {LEGACY_DUTY_FINANCE_CONTRACT,parseLegacyDutyPostingInput,planLegacyDutyFinalization,verifyLegacyDutyFinalization,type LegacyDutyFinalBasis,type LegacyDutyFundingProof,type LegacyFinanceDuty,type LegacyDutyPostingInput,type LegacyDutyFinalization,type LegacyDutyRef} from './legacy-duty-finance';
import {readLegacyDutyFundingProof} from './legacy-duty-funding';

type Actor={userId:string;sessionId:string;requestId:string};
type Binding={id:string;legacyId:string;gameId:string;accountId:string;ownerUserId:string;renterUserId:string;sourceDigest:string};
/** Exactly T's shared domain functions, supplied by the single assembly owner. No fallback lock or evidence calculator. */
export type LegacyDutyTradeReader={
 readBinding:(c:PoolClient,orderId:string)=>Promise<Binding>;
 lockOrder:(c:PoolClient,orderId:string)=>Promise<{duties:LegacyFinanceDuty[];head:unknown}>;
 readFinalBasis:(c:PoolClient,orderId:string,duty:LegacyFinanceDuty)=>Promise<{knowledge:'KNOWN';basis:LegacyDutyFinalBasis}|{knowledge:'UNKNOWN';reason:string}>;
};
export type LegacyDutyFinanceReview=Pick<FinanceOpeningReview,'ref'|'attempt'|'actor'|'resource'|'notBefore'|'expiresAt'>&{contractVersion:typeof LEGACY_DUTY_FINANCE_CONTRACT;orderId:string;inputDigest:string;funding:LegacyDutyFundingProof};
export type LegacyDutyFinanceAdmission=Readonly<{kind:'REVIEWED_LEGACY_DUTY_FINANCE'}>;
const scopes=new WeakMap<object,{review:LegacyDutyFinanceReview;recoveryOnly:boolean}>(),sha=(s:string)=>createHash('sha256').update(s).digest('hex');
const operation='finance.legacy-duty.finalize';
const copy=<T>(v:T):T=>JSON.parse(JSON.stringify(v));
const unavailable=(s:string)=>new SecurityApiError(503,'EVIDENCE_UNAVAILABLE',s);
function scope(s:LegacyDutyFinanceAdmission){const b=scopes.get(s);if(!b)throw invalid('Internally bound legacy finance review required');return b;}
async function resource(c:PoolClient,actor:Actor,s:LegacyDutyFinanceAdmission,recover=false){
 const b=scope(s);await assertFinanceMaintenanceResource(c,actor,b.review,{recover,recoveryOnly:b.recoveryOnly});
 const schema=(await c.query(`/* legacy duty finance schema */ SELECT to_regclass('zzsh_order.legacy_duty_finance_contract') IS NOT NULL AND to_regclass('zzsh_order.legacy_duty_finance_fact') IS NOT NULL AS ready`)).rows[0];if(schema?.ready!==true)throw unavailable('Legacy duty finance schema is unavailable');
 const row=(await c.query(`/* legacy duty finance contract */ SELECT contract_version,enabled FROM zzsh_order.legacy_duty_finance_contract WHERE singleton=true`)).rows[0];
 if(row?.contract_version!==LEGACY_DUTY_FINANCE_CONTRACT||row.enabled!==true)throw unavailable('Legacy duty physical contract is not admitted');
}
/** Only the separately reviewed local runner supplies this binding. It is never parsed from a request. */
export async function bindReviewedLegacyDutyFinance(c:PoolClient,actor:Actor,review:LegacyDutyFinanceReview,mode:'execute'|'recover'='execute'){
 if(!review||typeof review!=='object')throw invalid('Exact legacy finance review required');
 ensureOnlyFields(review,['ref','attempt','actor','resource','notBefore','expiresAt','contractVersion','orderId','inputDigest','funding']);
 const r=copy(review);
 if(r.contractVersion!==LEGACY_DUTY_FINANCE_CONTRACT||!/^legacy_order_[a-f0-9]{40}$/.test(r.orderId)||!/^[a-f0-9]{64}$/.test(r.inputDigest)
  ||!['execute','recover'].includes(mode)||!r.funding||r.funding.orderId!==r.orderId||!r.ref||!r.attempt
  ||r.resource?.host!=='127.0.0.1'||r.resource.port!==55432||!/^zzsh_test_order_[a-z][a-z0-9_]{0,20}$/.test(r.resource.database)||r.resource.marker!=='zzsh:order-reservation-test:v1'
  ||![r.resource.oid,r.resource.roleOid].every(n=>Number.isSafeInteger(n)&&n>0)||![r.resource.role,r.resource.owner].every(s=>typeof s==='string'&&/^[a-zA-Z_][a-zA-Z0-9_]{0,62}$/.test(s)))throw invalid('Bounded actual legacy finance resource required');
 ensureOnlyFields(r.actor,['userId','sessionId']);ensureOnlyFields(r.resource,['host','port','database','oid','owner','marker','role','roleOid']);
 if(![r.notBefore,r.expiresAt].every(s=>typeof s==='string'&&/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(s))||r.ref.length>128||r.attempt.length>128)throw invalid('Exact legacy finance window required');
 const token=Object.freeze({kind:'REVIEWED_LEGACY_DUTY_FINANCE' as const});scopes.set(token,{review:r,recoveryOnly:mode==='recover'});
 try{await authorizeFinanceMaintenance(c,actor);await resource(c,actor,token,mode==='recover');return token;}catch(e){scopes.delete(token);throw e;}
}
async function authorize(c:PoolClient,actor:Actor,binding:Binding,s:LegacyDutyFinanceAdmission,recover=false){
 await assertAdminContextInTransaction(c,actor);const access=await loadEffectiveAdminAccess(c,actor.userId);requirePermission(access,'order.settlement.write');
 if(access?.passwordChangeRequired||access?.status!=='ACTIVE')throw unavailable('Current settlement authority unavailable');
 await assertGameScope(c,actor.userId,access.isBoss,binding.gameId);await resource(c,actor,s,recover);
}
function checkedInput(input:Record<string,unknown>,s:LegacyDutyFinanceAdmission){
 const original=copy(input),parsed=parseLegacyDutyPostingInput(original),r=scope(s).review;
 if(sha(canonicalize(original))!==r.inputDigest||parsed.dutyId!==r.funding.dutyId)throw invalid('Legacy duty intent differs from exact review');return{original,parsed,r};
}
async function hint(c:PoolClient,orderId:string){return(await c.query(`/* legacy duty subject prefix */ SELECT id,counterparty_user_id FROM zzsh_order.legacy_order_duty WHERE order_id=$1 ORDER BY id`,[orderId])).rows;}
async function lock(c:PoolClient,b:Binding,t:LegacyDutyTradeReader){
 const before=await hint(c,b.id),subjects=[...new Set([b.ownerUserId,b.renterUserId,...before.map(d=>d.counterparty_user_id).filter((v):v is string=>typeof v==='string')])].sort();
 const users=await c.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=ANY($1::text[]) ORDER BY id FOR UPDATE`,[subjects]);if(users.rowCount!==subjects.length)throw conflict('Legacy finance party mapping changed');
 await c.query('SELECT id FROM zzsh_supply.game WHERE id=$1 FOR SHARE',[b.gameId]);await c.query('SELECT id FROM zzsh_supply.rental_account WHERE id=$1 FOR SHARE',[b.accountId]);
 const locked=await t.lockOrder(c,b.id),after=locked.duties.map(d=>({id:d.id,counterparty_user_id:d.counterpartyUserId}));
 if(canonicalize(before)!==canonicalize(after))throw conflict('Legacy duty subject set changed; retry original intent after reread');return locked;
}
const economicKey=(orderId:string,dutyId:string)=>'legacy-duty-finalize-'+sha(canonicalize([orderId,dutyId])).slice(0,40);
const originalFactSql=`SELECT f.*,e.kind AS event_kind,e.subject_user_id AS event_subject,r.source_kind AS root_kind,r.source_type AS root_type,r.source_system AS root_system,r.source_entity AS root_entity,r.source_id AS root_source,r.subject_user_id AS root_subject,r.beneficiary_role AS root_role,r.source_digest AS root_digest,r.policy_version AS root_policy,r.basis_id
 FROM zzsh_order.legacy_duty_finance_fact f JOIN zzsh_order.finance_event e ON e.id=f.event_id AND e.economic_root_id=f.root_id JOIN zzsh_order.finance_economic_root r ON r.id=f.root_id`;
function verifyStoredFact(duty:LegacyFinanceDuty,fact:Record<string,any>,rawLines:Record<string,any>[]):LegacyDutyFinalization{
 if(fact.root_kind!=='LEGACY_CONTINUATION_DUTY'||fact.root_type!=='LEGACY_CONTINUATION'||fact.root_system!=='zzsh'||fact.root_entity!=='legacy_order_duty'||fact.root_source!==duty.id||fact.root_subject!==duty.counterpartyUserId||fact.event_subject!==duty.counterpartyUserId||fact.root_role!==duty.kind||fact.root_digest!==fact.facts_digest||fact.root_policy!==null||fact.basis_id!==null)return'UNKNOWN';
 let funding:LegacyDutyFundingProof;try{funding=JSON.parse(fact.facts_canonical).funding;if(!funding||typeof funding!=='object')return'UNKNOWN';}catch{return'UNKNOWN';}
 const expectedDetails={legacyDutyId:duty.id,legacyOrderId:duty.orderId,legacyOrderNumber:funding.originalOrderNumber,factsDigest:fact.facts_digest};
 if(rawLines.some(row=>canonicalize(row.details)!==canonicalize(expectedDetails)))return'UNKNOWN';const lines=rawLines.map(({details,...line})=>line) as ReturnType<typeof planLegacyDutyFinalization>['lines'];
 return verifyLegacyDutyFinalization(duty,{canonical:fact.facts_canonical,digest:fact.facts_digest,rootId:fact.root_id,eventId:fact.event_id,eventKind:fact.event_kind,ref:{type:fact.ref_type,id:fact.ref_id,digest:fact.facts_digest},lines});
}
async function verifyOriginal(c:PoolClient,duty:LegacyFinanceDuty):Promise<LegacyDutyFinalization>{
 if(duty.settledBy==='LEGACY_RECORDS')return duty.settledRefType===null&&duty.settledRefId===null&&duty.settledRefDigest===null?'NONE':'UNKNOWN';
 const fact=(await c.query(`/* legacy duty original final facts */ ${originalFactSql} WHERE f.duty_id=$1`,[duty.id])).rows[0];
 if(!fact)return duty.status==='SETTLED'&&duty.settledBy==='FINANCE'?'UNKNOWN':'NONE';
 const rawLines=(await c.query(`SELECT id,line_no AS line,account_code AS account,debit_cents::text AS debit,credit_cents::text AS credit,counterparty_user_id AS subject,details FROM zzsh_order.settlement_ledger_entry WHERE finance_event_id=$1 ORDER BY line_no`,[fact.event_id])).rows;
 return verifyStoredFact(duty,fact,rawLines);
}
export type LegacyCommissionFinance= {knowledge:'UNKNOWN';reason:string}|{knowledge:'KNOWN';state:'SETTLED';amountCents:string;zeroFinalization:boolean;reference:LegacyDutyRef};
export async function readLegacyCommissionFinanceVersion(c:PoolClient,userId:string){
 if(typeof userId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(userId))throw invalid('Original earning subject required');
 const row=(await c.query(`/* own legacy commission financial version */ SELECT md5(COALESCE(string_agg(f.duty_id||':'||f.facts_digest||':'||d.revision::text||':'||COALESCE(d.settled_ref_type,'')||':'||COALESCE(d.settled_ref_id,'')||':'||COALESCE(d.settled_ref_digest,''),chr(10) ORDER BY f.duty_id COLLATE "C"),'')) AS version
  FROM zzsh_order.legacy_duty_finance_fact f JOIN zzsh_order.legacy_order_duty d ON d.id=f.duty_id WHERE f.subject_user_id=$1 AND f.kind='COMMISSION'`,[userId])).rows[0];
 if(typeof row?.version!=='string'||!/^[a-f0-9]{32}$/.test(row.version))throw unavailable('Legacy commission finance version is inconsistent');return row.version as string;
}
/** One bounded page query reuses the same complete fact/ref/batch verifier as command recovery. */
export async function readLegacyCommissionFinance(c:PoolClient,userId:string,sourceIds:string[]):Promise<Map<string,LegacyCommissionFinance>>{
 if(typeof userId!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,179}$/.test(userId)||sourceIds.length>50||sourceIds.some(id=>!/^[1-9]\d{0,23}$/.test(id))||new Set(sourceIds).size!==sourceIds.length)throw invalid('Bounded original commission sources required');
 const out=new Map<string,LegacyCommissionFinance>();if(!sourceIds.length)return out;
 const rows=(await c.query(`/* own legacy commission complete financial facts */ SELECT observed.*,to_jsonb(d)||jsonb_build_object('amount_cents',d.amount_cents::text,'revision',d.revision::text) AS actual_duty,
  COALESCE((SELECT jsonb_agg(jsonb_build_object('id',l.id,'line',l.line_no,'account',l.account_code,'debit',l.debit_cents::text,'credit',l.credit_cents::text,'subject',l.counterparty_user_id,'details',l.details) ORDER BY l.line_no) FROM zzsh_order.settlement_ledger_entry l WHERE l.finance_event_id=observed.event_id),'[]'::jsonb) AS actual_lines,
  to_char(d.maturity_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS maturity
  FROM (${originalFactSql} WHERE f.subject_user_id=$1 AND f.kind='COMMISSION') observed JOIN zzsh_order.legacy_order_duty d ON d.id=observed.duty_id
  WHERE d.counterparty_user_id=$1 AND d.kind='COMMISSION' AND d.source_record_id=ANY($2::text[]) ORDER BY d.id COLLATE "C" LIMIT 51`,[userId,sourceIds])).rows;
 if(rows.length>50)throw unavailable('Legacy commission financial source is ambiguous');
 for(const row of rows){const d=row.actual_duty;if(!d||typeof d!=='object'||!Array.isArray(row.actual_lines)||out.has(d.source_record_id)||!sourceIds.includes(d.source_record_id)||d.counterparty_user_id!==userId
   ||typeof d.amount_cents!=='string'||!/^(0|[1-9]\d{0,23})$/.test(d.amount_cents)||typeof d.revision!=='string'||!/^[1-9]\d{0,18}$/.test(d.revision))throw unavailable('Legacy commission financial subject/source changed');
  const duty:LegacyFinanceDuty={id:d.id,orderId:d.order_id,kind:d.kind,sourceRecordId:d.source_record_id,counterpartyUserId:d.counterparty_user_id,amountCents:String(d.amount_cents),currency:d.currency,revision:String(d.revision),status:d.status,source:d.source,sourceStatus:d.source_status,continuationVersionId:d.continuation_version_id,admissionId:d.admission_id,maturityAt:row.maturity,settledBy:d.settled_by,settledRefType:d.settled_ref_type,settledRefId:d.settled_ref_id,settledRefDigest:d.settled_ref_digest};
  if(duty.status!=='SETTLED'||duty.settledBy!=='FINANCE'||verifyStoredFact(duty,row,row.actual_lines)==='UNKNOWN')throw unavailable('Legacy commission final financial facts require reconciliation');
  out.set(duty.sourceRecordId,{knowledge:'KNOWN',state:'SETTLED',amountCents:duty.amountCents,zeroFinalization:duty.amountCents==='0',reference:{type:duty.settledRefType as LegacyDutyRef['type'],id:duty.settledRefId!,digest:duty.settledRefDigest!}});
 }return out;
}
/** Caller owns one transaction/order. No HTTP mount or automatic worker; contract DDL remains a separately approved prerequisite. */
export async function finalizeReviewedLegacyDuty(c:PoolClient,actor:Actor,input:Record<string,unknown>,s:LegacyDutyFinanceAdmission,t:LegacyDutyTradeReader){
 const {original,parsed,r}=checkedInput(input,s),b=await t.readBinding(c,r.orderId);
 await authorize(c,actor,b,s);
 const result=await withIdempotency(c,{realm:'admin',principalId:actor.userId,operation,resourceId:r.orderId},economicKey(r.orderId,parsed.dutyId),fingerprintRequest(operation,r.orderId,original),async()=>authorize(c,actor,b,s),async()=>{
  const locked=await lock(c,b,t),duty=locked.duties.find(d=>d.id===parsed.dutyId);if(!duty)throw notFound();
  const basis=await t.readFinalBasis(c,r.orderId,duty);if(basis.knowledge!=='KNOWN')throw unavailable(basis.reason);
  if(basis.basis.parentSourceDigest!==b.sourceDigest||basis.basis.parentSourceId!==b.legacyId)throw conflict('Original mapped order source changed');
  const funding=await readLegacyDutyFundingProof(c,duty,basis.basis);if(funding.knowledge!=='KNOWN')throw unavailable(funding.reason);
  if(canonicalize(funding.proof)!==canonicalize(r.funding))throw conflict('Reviewed funding differs from immutable source witness');
  const now=(await c.query(`SELECT to_char(clock_timestamp() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS now`)).rows[0]?.now;
  const p=planLegacyDutyFinalization(duty,basis.basis,funding.proof,parsed,now);
  await setAuditContext(c,'admin',actor.userId,actor.sessionId,actor.requestId);
  const revision=(await c.query('SELECT ledger_revision::text FROM zzsh_order.wallet_revision WHERE user_id=$1',[duty.counterpartyUserId])).rows[0]?.ledger_revision??'0';
  await c.query(`INSERT INTO zzsh_order.legacy_duty_finance_fact(duty_id,order_id,root_id,event_id,subject_user_id,kind,amount_cents,currency,duty_revision,effective_head_id,effective_head_revision,parent_source_digest,source_record_digest,basis_facts_digest,effective_facts_digest,zero_finalization,ref_type,ref_id,facts_canonical,facts_digest,funding_canonical,funding_digest,approval_ref,attempt,actor_id,session_id,request_id)
   VALUES($1,$2,$3,$4,$5,$6,$7,'CNY',$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26)`,[duty.id,b.id,p.rootId,p.eventId,duty.counterpartyUserId,duty.kind,duty.amountCents,duty.revision,basis.basis.effectiveHeadId,basis.basis.effectiveHeadRevision,b.sourceDigest,basis.basis.sourceRecordDigest,basis.basis.basisFactsDigest,basis.basis.evidenceDigest,p.zero,p.ref.type,p.ref.id,p.canonical,p.factDigest,canonicalize(r.funding),sha(canonicalize(r.funding)),r.ref,r.attempt,actor.userId,actor.sessionId,actor.requestId]);
  await c.query(`INSERT INTO zzsh_order.finance_economic_root(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,source_digest) VALUES($1,NULL,'LEGACY_CONTINUATION_DUTY','LEGACY_CONTINUATION','zzsh','legacy_order_duty',$2,$3,$4,$5)`,[p.rootId,duty.id,duty.counterpartyUserId,duty.kind,p.factDigest]);
  await c.query(`INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision) VALUES($1,$2,'LEGACY_DUTY_SETTLED',$3,$4)`,[p.eventId,p.rootId,duty.counterpartyUserId,revision]);
  for(const l of p.lines)await c.query(`INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,[l.id,p.eventId,l.line,l.account,l.debit,l.credit,l.subject,JSON.stringify({legacyDutyId:duty.id,legacyOrderId:duty.orderId,legacyOrderNumber:funding.proof.originalOrderNumber,factsDigest:p.factDigest})]);
  const updated=await c.query(`UPDATE zzsh_order.legacy_order_duty SET status='SETTLED',settled_by='FINANCE',settled_ref_type=$2,settled_ref_id=$3,settled_ref_digest=$4,revision=revision+1 WHERE id=$1 AND revision=$5 AND status=$6 AND settled_by IS NULL`,[duty.id,p.ref.type,p.ref.id,p.ref.digest,duty.revision,duty.status]);if(updated.rowCount!==1)throw conflict('Legacy duty changed during finalization');
  await recordAudit(c,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:operation,objectType:'legacy_order_duty',objectId:duty.id,outcome:'SUCCESS',details:{orderId:b.id,originalDutyRevision:duty.revision,reference:p.ref,factsDigest:p.factDigest,approvalRef:r.ref,attempt:r.attempt,zeroFinalization:p.zero,channelArrival:'UNKNOWN'}});
  await c.query('SET CONSTRAINTS ALL IMMEDIATE');await authorize(c,actor,b,s);
  return{status:200,body:{dutyId:duty.id,orderId:b.id,reference:p.ref,amountCents:duty.amountCents,currency:'CNY',zeroFinalization:p.zero,channelArrival:'UNKNOWN'}};
 });
 const final=(await lock(c,b,t)).duties.find(d=>d.id===parsed.dutyId),receipt=result.body as Record<string,unknown>|null;
 if(!receipt||typeof receipt!=='object'||Array.isArray(receipt)||!final||final.status!=='SETTLED'||final.settledBy!=='FINANCE'||await verifyOriginal(c,final)==='UNKNOWN'||receipt.dutyId!==final.id
  ||receipt.orderId!==b.id||receipt.amountCents!==final.amountCents||receipt.currency!=='CNY'||receipt.channelArrival!=='UNKNOWN'
  ||receipt.zeroFinalization!==(final.amountCents==='0')||canonicalize(receipt.reference)!==canonicalize({type:final.settledRefType,id:final.settledRefId,digest:final.settledRefDigest}))throw conflict('Original legacy duty receipt/ref/final fact differs');
 await authorize(c,actor,b,s);return result;
}

/** Original body/key/actor, current authorization, and complete ref/fact/ledger verification. Never replays a write. */
export async function recoverReviewedLegacyDuty(c:PoolClient,actor:Actor,input:Record<string,unknown>,s:LegacyDutyFinanceAdmission,t:LegacyDutyTradeReader){
 const {original,parsed,r}=checkedInput(input,s),b=await t.readBinding(c,r.orderId);await authorize(c,actor,b,s,true);
 const key=economicKey(r.orderId,parsed.dutyId),row=(await c.query(`SELECT request_fingerprint AS fingerprint,response_status AS status,response_body AS body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2`,[JSON.stringify(['admin',actor.userId,operation,r.orderId]),key])).rows[0];
 if(!row)return{knowledge:'UNKNOWN' as const,key,receipt:null};
 if(row.fingerprint!==fingerprintRequest(operation,r.orderId,original)||row.status!==200||row.body?.dutyId!==parsed.dutyId||row.body?.orderId!==r.orderId||row.body?.amountCents!==parsed.expectedAmountCents||row.body?.currency!=='CNY'||row.body?.channelArrival!=='UNKNOWN')throw conflict('Original legacy duty receipt differs');
 const locked=await lock(c,b,t),duty=locked.duties.find(d=>d.id===parsed.dutyId);if(!duty||await verifyOriginal(c,duty)==='UNKNOWN'||duty.status!=='SETTLED'||duty.settledBy!=='FINANCE'
  ||canonicalize(row.body.reference)!==canonicalize({type:duty.settledRefType,id:duty.settledRefId,digest:duty.settledRefDigest})||row.body.zeroFinalization!==(duty.amountCents==='0'))throw conflict('Original legacy duty financial facts differ');
 const audit=await c.query(`SELECT 1 FROM zzsh_iam.audit_event WHERE action=$1 AND object_type='legacy_order_duty' AND object_id=$2 AND actor_id=$3 AND session_id=$4 AND outcome='SUCCESS' AND details->>'approvalRef'=$5 AND details->>'attempt'=$6`,[operation,duty.id,actor.userId,actor.sessionId,r.ref,r.attempt]);if(audit.rowCount!==1)throw conflict('Original legacy duty audit is missing');
 await authorize(c,actor,b,s,true);return{knowledge:'KNOWN' as const,key,receipt:{status:row.status,body:row.body},originalFinancialFactVerified:true};
}
/** T's read-side resolver. Independent historical LEGACY_RECORDS never counts as a new payment. */
export async function readLegacyDutyFinalization(c:PoolClient,orderId:string,duties:readonly LegacyFinanceDuty[]):Promise<LegacyDutyFinalization>{
 const installed=(await c.query(`/* legacy duty finance schema */ SELECT to_regclass('zzsh_order.legacy_duty_finance_fact') IS NOT NULL AS ready`)).rows[0];if(installed?.ready===false)return'UNKNOWN';if(installed?.ready!==true)throw unavailable('Legacy duty finance schema metadata unavailable');
 let zero=false,positive=false;for(const d of duties){if(d.orderId!==orderId)return'UNKNOWN';const state=await verifyOriginal(c,d);if(state==='UNKNOWN')return'UNKNOWN';positive ||=state==='POSTED_POSITIVE_REFUND';zero ||=state==='FINALIZED_ZERO';}return positive?'POSTED_POSITIVE_REFUND':zero?'FINALIZED_ZERO':'NONE';
}
