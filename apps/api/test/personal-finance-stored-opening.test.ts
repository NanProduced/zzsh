import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalize} from '../src/supply/content-hash';
import {bindReviewedStoredOpeningAdmission,bindReviewedFinanceOpeningAdmission,planFinanceOpening,importReviewedStoredOpeningBatch,recoverReviewedStoredOpeningBatch,type StoredOpeningInput,type StoredOpeningReview} from '../src/finance/personal-finance-maintenance';
const sha=(s:unknown)=>createHash('sha256').update(typeof s==='string'?s:canonicalize(s)).digest('hex');
const actor={userId:'fixture-boss',sessionId:'fixture-session',requestId:'fixture-request'};
const resource={host:'127.0.0.1' as const,port:55432 as const,database:'zzsh_test_order_stored_fixture',oid:42,owner:'fixture_owner',marker:'zzsh:order-reservation-test:v1',role:'fixture_owner',roleOid:43};
function input(userId='fixture-wallet',sourceId='101',stored='7.50'):StoredOpeningInput{
 const selected={id:sourceId,earnings:stored,money:'0.00'},sourceCanonical=canonicalize(selected);
 const observations=[{kind:'earningsLog',sourceId:501,sourceUserId:Number(sourceId),amount:'1.00',leftAmount:'2.00',action:1,createdAt:1779469800,referenceType:'LEGACY_ADMIN_LOG',referenceId:'501',referenceSn:'FIXTURE'}];
 return{inputSha256:'a'.repeat(64),cutoff:'2026-09-13T13:31:22.000Z',sourceCanonical,proof:{userId,source:{sourceSystem:'legacy_mysql_restore',sourceEntity:'la_user',sourceId,identityDigest:'b'.repeat(64)},availableCents:BigInt(stored.replace('.','')).toString(),sourceDigest:sha(JSON.stringify(selected)),coveredCount:0,coveredDigest:sha(''),coveredSet:[]},observations,admissions:observations.map(o=>({sourceEntity:'la_log_earnings',sourceId:String(o.sourceId),sourceDigest:sha(o),sourceEventAt:new Date(o.createdAt*1000).toISOString(),included:true}))};
}
function review(i=input()):StoredOpeningReview{return{ref:'FIXTURE-NOT-APPROVAL',attempt:'fixture-1',actor:{userId:actor.userId,sessionId:actor.sessionId},resource:{...resource},notBefore:'2026-10-15T08:00:00.000Z',expiresAt:'2026-10-15T09:00:00.000Z',inputSha256:i.inputSha256,cutoff:i.cutoff,subject:{userId:i.proof.userId,sourceId:i.proof.source.sourceId,identityDigest:i.proof.source.identityDigest,sourceDigest:i.proof.sourceDigest,availableCents:i.proof.availableCents,coveredDigest:i.proof.coveredDigest},bodyDigest:sha(i),coveredCount:i.proof.coveredCount,observationCount:i.observations.length,admissionDigest:sha(i.admissions)};}
function fixture(){
 const state={queries:[] as {sql:string;args:any[]}[],receipts:new Map<string,any>(),now:'2026-10-15T08:30:00.000Z',identity:true,role:'fixture_owner',existing:null as any,failAudit:false};
 const query=async(sql:string,args:any[]=[])=>{
  state.queries.push({sql,args});
  if(sql.includes('finance-opening resource'))return{rows:[{...resource,role:state.role,now:state.now,tableOwner:state.role}],rowCount:1};
  if(sql.includes('stored opening review schema'))return{rows:[{ready:true,owner:state.role}],rowCount:1};
  if(sql.includes('s."locked",u."twoFactorEnabled"'))return{rows:[{locked:false,twoFactorEnabled:true}],rowCount:1};
  if(sql.includes('admin_security'))return{rows:[{status:'ACTIVE',isBoss:true,passwordChangeRequired:false}],rowCount:1};
  if(sql.includes('SELECT suspended'))return{rows:[{suspended:false}],rowCount:1};
  if(sql.includes('user.legacy_owner.migrated'))return{rows:state.identity?[{}]:[],rowCount:state.identity?1:0};
  if(sql.includes('stored opening existing observation'))return{rows:state.existing?[state.existing]:[],rowCount:state.existing?1:0};
  if(sql.includes('"requestFingerprint"')){const r=state.receipts.get(args[1]);return{rows:r?[{requestFingerprint:r.fingerprint,responseStatus:r.status,responseBody:r.body,publishRequired:false}]:[],rowCount:r?1:0};}
  if(sql.includes('request_fingerprint AS fingerprint')){const r=state.receipts.get(args[1]);return{rows:r?[r]:[],rowCount:r?1:0};}
  if(sql.includes('INSERT INTO "zzsh_supply"."idempotency_record"'))state.receipts.set(args[1],{fingerprint:args[2],status:args[3],body:JSON.parse(args[4])});
  if(sql.includes('INSERT INTO zzsh_iam.audit_event')&&state.failAudit)throw Error('FIXTURE_AUDIT_FAILED');
  return{rows:sql.includes('wallet_revision')?[{ledger_revision:'0'}]:[],rowCount:1};
 };
 const client={query,connectionParameters:{host:resource.host,port:resource.port,database:resource.database,user:resource.role},release(){}};
 return{state,client:client as any,pool:{connect:async()=>client} as any};
}
async function prepare(i=input(),mode?:'recover'){const f=fixture(),r=review(i),scope=await bindReviewedStoredOpeningAdmission(f.client,actor,r,mode);return{...f,i,r,scope};}

test('stored review is distinct from original one-root admission, and original stored amount wins over log residual',async()=>{
 const f=await prepare(),p=await planFinanceOpening(f.client,actor,f.i,f.scope);assert.equal(p.observations[0]!.includedInOpening,true);
 const result=await importReviewedStoredOpeningBatch(f.pool,actor,[f.i],[f.scope]);assert.equal(result[0]!.status,200);
 const ledger=f.state.queries.find(q=>q.sql.includes('INSERT INTO zzsh_order.settlement_ledger_entry'));assert.equal(ledger?.args[2],'750');
 assert(f.state.queries.some(q=>q.sql.includes('finance_stored_opening_review(')));assert(f.state.queries.some(q=>q.sql==='SET CONSTRAINTS ALL IMMEDIATE'));
 const {coveredCount:_,observationCount:__,admissionDigest:___,...oldReview}=f.r,old=await bindReviewedFinanceOpeningAdmission(f.client,actor,oldReview);
 await assert.rejects(planFinanceOpening(f.client,actor,f.i,old),/One reviewed economic root/);
});
test('exact stored source, subject and every coverage/admission remain required even when review hashes change',async()=>{
 for(const change of [(i:StoredOpeningInput)=>i.proof.availableCents='100', (i:StoredOpeningInput)=>i.sourceCanonical=canonicalize({id:'999',stored:'7.50'}), (i:StoredOpeningInput)=>i.proof.sourceDigest='d'.repeat(64), (i:StoredOpeningInput)=>i.admissions[0]!.included='yes' as any, (i:StoredOpeningInput)=>i.proof.coveredSet.push(['fixture-wallet','UNRESOLVED','LEGACY_MYSQL','la_order','1','OWNER','1779469800','f'.repeat(64)])]){
  const i=input();change(i);i.proof.coveredCount=i.proof.coveredSet.length;i.proof.coveredDigest=sha(i.proof.coveredSet.map(row=>JSON.stringify(row)).join('\n'));const f=await prepare(i);await assert.rejects(planFinanceOpening(f.client,actor,i,f.scope));assert(!f.state.queries.some(q=>q.sql.startsWith('INSERT')));
 }
});
test('proved zero opening creates basis/event/receipt, without fake zero ledger or rewriting historical facts',async()=>{
 const f=await prepare(input('fixture-wallet','101','0.00'));await importReviewedStoredOpeningBatch(f.pool,actor,[f.i],[f.scope]);
 assert(f.state.queries.some(q=>q.sql.includes('INSERT INTO zzsh_order.finance_event')));assert(f.state.queries.some(q=>q.sql.includes('INSERT INTO zzsh_order.finance_opening_basis')));assert(!f.state.queries.some(q=>q.sql.includes('INSERT INTO zzsh_order.settlement_ledger_entry')));
});
test('an independently imported identical observation is linked by immutable admission, never updated or reinserted',async()=>{
 const f=await prepare(),o=(await planFinanceOpening(f.client,actor,f.i,f.scope)).observations[0]!;
 f.state.existing={user_id:o.userId,legacy_user_id:o.legacyUserId,source_kind:o.sourceKind,basis_id:null,included_in_opening:false,source_digest:o.sourceDigest,source_canonical:o.sourceCanonical,snapshot:JSON.parse(o.sourceCanonical),source_event_at:o.sourceEventAt};
 await importReviewedStoredOpeningBatch(f.pool,actor,[f.i],[f.scope]);assert(f.state.queries.some(q=>q.sql.includes('INSERT INTO zzsh_order.finance_observation_admission')));assert(!f.state.queries.some(q=>q.sql.includes('INSERT INTO zzsh_order.personal_finance_observation')));assert(!f.state.queries.some(q=>/^UPDATE/.test(q.sql)));
 const g=await prepare();g.state.existing={...f.state.existing,source_digest:'c'.repeat(64)};await assert.rejects(importReviewedStoredOpeningBatch(g.pool,actor,[g.i],[g.scope]),/cannot be attached/);assert(!g.state.queries.some(q=>q.sql.includes('INSERT INTO zzsh_order.finance_opening_basis')));
});
test('bounded batch rejects duplicate/unbound subjects before connecting; snapshots and actual window are not mutable authority',async()=>{
 const f=await prepare(),pool={connect:async()=>{throw Error('MUST_NOT_CONNECT');}};
 for(const scopes of [[f.scope,f.scope],[{kind:'REVIEWED_FINANCE_OPENING'}]])await assert.rejects(importReviewedStoredOpeningBatch(pool as any,actor,scopes.length===2?[f.i,f.i]:[f.i],scopes as any),(e:any)=>e.status===400);
 f.r.expiresAt='2099-01-01T00:00:00.000Z';f.state.now='2026-10-15T09:00:00.000Z';await assert.rejects(importReviewedStoredOpeningBatch(f.pool,actor,[f.i],[f.scope]),(e:any)=>e.status===403);
 const g=await prepare(input(),'recover');await assert.rejects(importReviewedStoredOpeningBatch(g.pool,actor,[g.i],[g.scope]),(e:any)=>e.status===403);
});
test('missing original stored receipt stays UNKNOWN with the same economic key and no import replay',async()=>{
 const f=await prepare(input(),'recover'),result=await recoverReviewedStoredOpeningBatch(f.client,actor,[f.i],[f.scope]);assert.equal(result.knowledge,'UNKNOWN');assert.equal(result.results[0]!.receipt,null);assert.match(result.results[0]!.key,/^u2-opening-/);assert(!f.state.queries.some(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql)));
});
