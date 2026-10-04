import type {Pool,PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {loadEffectiveAdminAccess} from '../auth/admin-authorization';
import {assertAdminContextInTransaction} from '../auth/auth-security';
import {recordAudit,withTransaction} from '../auth/security-core';
import {forbidden,invalid,conflict,withIdempotency,fingerprintRequest} from '../supply/supply-util';
import {canonicalize} from '../supply/content-hash';
import {prepareHistoricalObservation} from './personal-finance-read';

type Actor={userId:string;sessionId:string;requestId:string};
export type OpeningMaintenanceInput={inputSha256:string;cutoff:string;proof:{userId:string;source:{sourceSystem:string;sourceEntity:string;sourceId:string;identityDigest:string};availableCents:string;sourceDigest:string;coveredCount:number;coveredDigest:string;coveredSet:string[][]};observations:Record<string,unknown>[];admissions:{sourceEntity:string;sourceId:string;sourceDigest:string;sourceEventAt:string;included:boolean}[]};
const sha=(s:string)=>createHash('sha256').update(s).digest('hex');
export async function authorizeFinanceMaintenance(client:PoolClient,actor:Actor){await assertAdminContextInTransaction(client,actor);const access=await loadEffectiveAdminAccess(client,actor.userId);const user=(await client.query('SELECT suspended FROM zzsh_auth_admin."user" WHERE id=$1',[actor.userId])).rows[0];if(!access||!access.isBoss||access.status!=='ACTIVE'||access.passwordChangeRequired||user?.suspended!==false)throw forbidden('Explicit active Boss maintenance actor required');}
export async function planFinanceOpening(client:PoolClient,actor:Actor,input:OpeningMaintenanceInput){
 await authorizeFinanceMaintenance(client,actor);
 if(input.inputSha256!=='ee431b3ac1ed74952bbc08e57581c6d9ab04a4bd01100ca05ac00a77e6175ec0'||input.cutoff!=='2026-10-03T02:31:22.516Z')throw invalid('Unreviewed frozen input or cutoff');
 const p=input.proof;if(!/^(0|[1-9]\d{0,23})$/.test(p.availableCents)||p.source.sourceEntity!=='la_user'||p.coveredCount!==p.coveredSet.length)throw invalid('Opening proof invalid');
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
export async function importFinanceOpening(client:PoolClient,actor:Actor,input:OpeningMaintenanceInput){
 const plan=await planFinanceOpening(client,actor,input),p=input.proof;
 return withIdempotency(client,{realm:'admin',principalId:actor.userId,operation:'finance.opening.import'},plan.key,fingerprintRequest('finance.opening.import',p.userId,input),()=>authorizeFinanceMaintenance(client,actor),async()=>{
  await client.query(`SELECT id FROM zzsh_auth_user."user" WHERE id=$1 FOR UPDATE`,[p.userId]);
  const revision=(await client.query('SELECT ledger_revision::text FROM zzsh_order.wallet_revision WHERE user_id=$1',[p.userId])).rows[0]?.ledger_revision??'0';
  await client.query(`INSERT INTO zzsh_order.finance_opening_basis(id,user_id,source_kind,source_system,source_entity,source_id,identity_source_digest,source_digest,available_cents,source_cutoff,covered_count,covered_set_digest) VALUES($1,$2,'LEGACY_OPENING',$3,'la_user',$4,$5,$6,$7,$8,$9,$10)`,[plan.basisId,p.userId,p.source.sourceSystem,p.source.sourceId,p.source.identityDigest,p.sourceDigest,p.availableCents,input.cutoff,p.coveredCount,p.coveredDigest]);
  for(const row of p.coveredSet)await client.query(`INSERT INTO zzsh_order.finance_covered_event(basis_id,user_id,source_kind,source_type,source_entity,source_id,beneficiary_role,source_event_at,source_digest) VALUES($1,$2,$3,$4,$5,$6,$7,to_timestamp($8),$9)`,[plan.basisId,...row]);
  await client.query(`INSERT INTO zzsh_order.finance_economic_root(id,basis_id,source_kind,source_type,source_system,source_entity,source_id,subject_user_id,beneficiary_role,source_digest) VALUES($1,$2,'LEGACY_OPENING','LEGACY_MYSQL',$3,'la_user',$4,$5,'WALLET_HOLDER',$6)`,[plan.rootId,plan.basisId,p.source.sourceSystem,p.source.sourceId,p.userId,p.sourceDigest]);
  await client.query(`INSERT INTO zzsh_order.finance_event(id,economic_root_id,kind,subject_user_id,expected_ledger_revision) VALUES($1,$2,'OPENING',$3,$4)`,[plan.eventId,plan.rootId,p.userId,revision]);
  if(p.availableCents!=='0')await client.query(`INSERT INTO zzsh_order.settlement_ledger_entry(id,finance_event_id,line_no,account_code,debit_cents,credit_cents,counterparty_user_id,details) VALUES($1,$2,1,'LEGACY_OPENING_SOURCE',$3,0,NULL,$5::jsonb),($4,$2,2,'WALLET_AVAILABLE',0,$3,$6,$5::jsonb)`,['dr_'+plan.eventId,plan.eventId,p.availableCents,'cr_'+plan.eventId,JSON.stringify({basisId:plan.basisId,economicRootId:plan.rootId,sourceDigest:p.sourceDigest}),p.userId]);
  for(const o of plan.observations){await client.query(`INSERT INTO zzsh_order.finance_observation_admission(basis_id,user_id,source_system,legacy_user_id,source_entity,source_id,source_digest,source_event_at,included_in_opening) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[plan.basisId,p.userId,o.sourceSystem,o.legacyUserId,o.sourceEntity,o.sourceId,o.sourceDigest,o.sourceEventAt,o.includedInOpening]);await client.query(`INSERT INTO zzsh_order.personal_finance_observation(id,user_id,basis_id,source_kind,source_type,source_system,legacy_user_id,source_entity,source_id,source_digest,source_canonical,source_event_at,included_in_opening,snapshot) VALUES($1,$2,$3,$4,'LEGACY_MYSQL',$5,$6,$7,$8,$9,$10::text,$11,$12,$10::text::jsonb)`,['obs_'+sha(canonicalize([o.sourceSystem,o.sourceEntity,o.sourceId])).slice(0,32),p.userId,plan.basisId,o.sourceKind,o.sourceSystem,o.legacyUserId,o.sourceEntity,o.sourceId,o.sourceDigest,o.sourceCanonical,o.sourceEventAt,o.includedInOpening]);}
  await recordAudit(client,{actorType:'admin',actorId:actor.userId,sessionId:actor.sessionId,requestId:actor.requestId,action:'finance.opening.imported',objectType:'finance_event',objectId:plan.eventId,outcome:'SUCCESS',reason:'Master-reviewed local frozen opening',details:{inputSha256:input.inputSha256,bodyDigest:plan.bodyDigest,subjectId:p.userId,sourceDigest:p.sourceDigest,cutoff:input.cutoff,observations:plan.observations.length}});
  return {status:200,body:{eventId:plan.eventId,subjectId:p.userId,bodyDigest:plan.bodyDigest}};
 });
}

/** The authenticated, separately approved CLI supplies the exact reviewed body
 * digests. All subjects share one transaction; no half-import checkpoint. */
export async function importReviewedFinanceOpeningBatch(pool:Pool,actor:Actor,inputs:OpeningMaintenanceInput[],reviewedBodyDigests:readonly string[]){
 if(inputs.length!==3||reviewedBodyDigests.length!==3||new Set(reviewedBodyDigests).size!==3||new Set(inputs.map(i=>i.proof.userId)).size!==3)throw invalid('Opening batch must be the three distinct reviewed subjects');
 const expected=new Set(reviewedBodyDigests);
 for(const input of inputs)if(!expected.has(sha(canonicalize(input))))throw invalid('Opening body changed after review');
 return withTransaction(pool,async client=>{
  await client.query(`SELECT s.id FROM zzsh_auth_admin.session s JOIN zzsh_auth_admin."user" u ON u.id=s."userId" JOIN zzsh_iam.admin_security a ON a.admin_user_id=s."userId" WHERE s.id=$1 AND s."userId"=$2 FOR SHARE OF s,u,a`,[actor.sessionId,actor.userId]);
  const results=[];
  for(const input of [...inputs].sort((a,b)=>a.proof.userId<b.proof.userId?-1:1))results.push(await importFinanceOpening(client,actor,input));
  await client.query('SET CONSTRAINTS ALL IMMEDIATE');
  return results;
 });
}

/** Read-only recovery after a commit acknowledgement or readback failure.
 * Missing receipts stay UNKNOWN; this never calls the import action or invents a key. */
export async function recoverReviewedFinanceOpeningBatch(client:PoolClient,actor:Actor,inputs:OpeningMaintenanceInput[],reviewedBodyDigests:readonly string[]){
 await authorizeFinanceMaintenance(client,actor);
 if(inputs.length!==3||reviewedBodyDigests.length!==3||new Set(reviewedBodyDigests).size!==3||new Set(inputs.map(i=>i.proof.userId)).size!==3)throw invalid('Recovery must bind three reviewed subjects');
 const expected=new Set(reviewedBodyDigests),results=[];
 for(const input of inputs){
  const bodyDigest=sha(canonicalize(input));if(!expected.has(bodyDigest))throw invalid('Recovery body changed after review');
  const plan=await planFinanceOpening(client,actor,input);
  const row=(await client.query(`SELECT request_fingerprint AS fingerprint,response_status AS status,response_body AS body FROM zzsh_supply.idempotency_record WHERE scope_key=$1 AND key=$2`,[JSON.stringify(['admin',actor.userId,'finance.opening.import',null]),plan.key])).rows[0];
  if(!row){results.push({subjectId:input.proof.userId,key:plan.key,knowledge:'UNKNOWN',receipt:null});continue;}
  if(row.fingerprint!==fingerprintRequest('finance.opening.import',input.proof.userId,input)||row.status!==200||row.body?.eventId!==plan.eventId||row.body?.subjectId!==input.proof.userId||row.body?.bodyDigest!==bodyDigest)throw conflict('Opening recovery receipt conflicts with original body');
  const facts=(await client.query(`SELECT b.available_cents::text AS amount,b.user_id AS subject,e.kind,count(l.id)::int AS lines,COALESCE(sum(l.debit_cents),0)::text AS debits,COALESCE(sum(l.credit_cents),0)::text AS credits FROM zzsh_order.finance_opening_basis b JOIN zzsh_order.finance_economic_root r ON r.basis_id=b.id JOIN zzsh_order.finance_event e ON e.economic_root_id=r.id LEFT JOIN zzsh_order.settlement_ledger_entry l ON l.finance_event_id=e.id WHERE b.id=$1 AND r.id=$2 AND e.id=$3 GROUP BY b.available_cents,b.user_id,e.kind`,[plan.basisId,plan.rootId,plan.eventId])).rows[0];
  const amount=BigInt(input.proof.availableCents);
  if(!facts||facts.subject!==input.proof.userId||facts.kind!=='OPENING'||facts.amount!==amount.toString()||facts.lines!==(amount===0n?0:2)||facts.debits!==amount.toString()||facts.credits!==amount.toString())throw conflict('Opening recovery financial evidence conflicts with receipt');
  results.push({subjectId:input.proof.userId,key:plan.key,knowledge:'KNOWN',receipt:{status:row.status,body:row.body},originalOpeningVerified:true});
 }
 return {knowledge:results.every(r=>r.knowledge==='KNOWN')?'KNOWN':'UNKNOWN',results};
}
