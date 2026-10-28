import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalize} from '../src/supply/content-hash';
import {bindReviewedStoredOpeningAdmission,bindReviewedFinanceOpeningAdmission,planFinanceOpening,importReviewedStoredOpeningBatch,recoverReviewedStoredOpeningBatch,type StoredOpeningInput,type StoredOpeningReview} from '../src/finance/personal-finance-maintenance';
import {prepareFrozenFinanceObservation,prepareStoredOpeningCandidate} from '../src/finance/legacy-finance-source-preparation';
const sha=(s:unknown)=>createHash('sha256').update(typeof s==='string'?s:canonicalize(s)).digest('hex');
const actor={userId:'fixture-boss',sessionId:'fixture-session',requestId:'fixture-request'};
const resource={host:'127.0.0.1' as const,port:55432 as const,database:'zzsh_test_order_stored_fixture',oid:42,owner:'fixture_owner',marker:'zzsh:order-reservation-test:v1',role:'fixture_owner',roleOid:43};
function input(userId='fixture-wallet',sourceId='101',stored='7.50'):StoredOpeningInput{
 const selected={id:sourceId,earnings:stored,money:'0.00'},sourceCanonical=canonicalize(selected);
 const observations=[{kind:'earningsLog',sourceId:501,sourceUserId:Number(sourceId),amount:'1.00',leftAmount:'2.00',action:1,createdAt:1779469800,referenceType:'LEGACY_ADMIN_LOG',referenceId:'501',referenceSn:'FIXTURE'}];
 return{inputSha256:'a'.repeat(64),cutoff:'2026-09-13T13:31:22.000Z',sourceCanonical,proof:{userId,source:{sourceSystem:'legacy_mysql_restore',sourceEntity:'la_user',sourceId,identityDigest:'b'.repeat(64)},availableCents:BigInt(stored.replace('.','')).toString(),sourceDigest:sha(JSON.stringify(selected)),coveredCount:0,coveredDigest:sha(''),coveredSet:[]},observations,admissions:observations.map(o=>({sourceEntity:'la_log_earnings',sourceId:String(o.sourceId),sourceDigest:sha(o),sourceEventAt:new Date(o.createdAt*1000).toISOString(),included:true}))};
}
function review(i=input()):StoredOpeningReview{return{ref:'FIXTURE-NOT-APPROVAL',attempt:'fixture-1',actor:{userId:actor.userId,sessionId:actor.sessionId},resource:{...resource},notBefore:'2026-10-15T08:00:00.000Z',expiresAt:'2026-10-15T09:00:00.000Z',inputSha256:i.inputSha256,cutoff:i.cutoff,subject:{userId:i.proof.userId,sourceId:i.proof.source.sourceId,identityDigest:i.proof.source.identityDigest,sourceDigest:i.proof.sourceDigest,availableCents:i.proof.availableCents,coveredDigest:i.proof.coveredDigest},bodyDigest:sha(i),coveredCount:i.proof.coveredCount,observationCount:i.observations.length,admissionDigest:sha(i.admissions),...(i.sourceProof?{sourceProofDigest:sha(i.sourceProof)}:{})};}
function returnInput(returnNumber='FIXTURE-RETURN'):StoredOpeningInput{
 const base=input(),source=JSON.parse(base.sourceCanonical),subject={userId:base.proof.userId,legacyUserId:source.id,identityDigest:base.proof.source.identityDigest};
 const attempt={id:201,sn:'FIXTURE-WITHDRAWAL',type:1,money:'5.00',status:4,userId:101,batch_no:'FIXTURE',is_delete:0,left_money:'4.50',create_time:1779469800,handling_fee:'0.50',payment_time:0};
 const debit={id:301,sn:'FIXTURE-DEBIT',action:2,amount:'5.00',userId:101,sourceId:201,createdAt:1779469800,changeType:1002,leftAmount:'2.50'},returned={...debit,id:302,sn:returnNumber,action:1,createdAt:1779469801,changeType:1004,leftAmount:'7.50'};
 const observed=[debit,returned].map(log=>prepareFrozenFinanceObservation('HISTORICAL_EARNINGS_LOG',log,subject));
 const covered=[{sourceKind:'LEGACY_WITHDRAWAL',sourceEntity:'la_withdraw_apply',sourceId:'201',beneficiaryRole:'WALLET_HOLDER',sourceEventAt:String(attempt.create_time),sourceCanonical:canonicalize(attempt),sourceDigest:sha(attempt)},
  {sourceKind:'LEGACY_WITHDRAWAL_RETURN',sourceEntity:'la_log_earnings',sourceId:'302',beneficiaryRole:'WALLET_HOLDER',sourceEventAt:String(returned.createdAt),sourceCanonical:canonicalize(returned),sourceDigest:sha(returned)}];
 const candidate=prepareStoredOpeningCandidate({subject,source,candidate:{legacyId:source.id,targetUserId:subject.userId,storedEarningsCents:'750',storedMoneyCents:'0',sourceDigest:base.proof.sourceDigest,admission:'MAPPED_PENDING_BATCH_APPROVAL'},inputSha256:base.inputSha256,cutoff:base.cutoff,covered,observations:observed.map(o=>o.row),included:['la_log_earnings:301','la_log_earnings:302'],
  logBindings:observed.map((o,index)=>({observationId:o.sourceId,observationDigest:o.sourceDigest,sourceKind:covered[index]!.sourceKind,sourceEntity:covered[index]!.sourceEntity,sourceId:covered[index]!.sourceId,beneficiaryRole:covered[index]!.beneficiaryRole,sourceDigest:covered[index]!.sourceDigest}))});
 assert.equal(candidate.state,'CANDIDATE');if(candidate.state!=='CANDIDATE')throw Error('Fixture proof failed');return candidate.input;
}
function adminInput():StoredOpeningInput{
 const base=input(),source=JSON.parse(base.sourceCanonical),subject={userId:base.proof.userId,legacyUserId:source.id,identityDigest:base.proof.source.identityDigest};
 const raw={id:501,sn:'FIXTURE-LOG',action:1,amount:'1.00',userId:101,sourceId:0,createdAt:1779469800,changeType:1006,leftAmount:'2.00'},observed=prepareFrozenFinanceObservation('HISTORICAL_EARNINGS_LOG',raw,subject);
 const root={sourceKind:'LEGACY_ADMIN_LOG',sourceEntity:'la_log_earnings',sourceId:'501',beneficiaryRole:'WALLET_HOLDER',sourceEventAt:String(raw.createdAt),sourceCanonical:canonicalize(raw),sourceDigest:sha(raw)};
 const supplemental={...raw,source_sn:'',remark:'Fixture original reason',extra:null},candidate=prepareStoredOpeningCandidate({subject,source,candidate:{legacyId:source.id,targetUserId:subject.userId,storedEarningsCents:'750',storedMoneyCents:'0',sourceDigest:base.proof.sourceDigest,admission:'MAPPED_PENDING_BATCH_APPROVAL'},inputSha256:base.inputSha256,cutoff:base.cutoff,covered:[root],observations:[observed.row],included:['la_log_earnings:501'],
  logBindings:[{observationId:'501',observationDigest:observed.sourceDigest,sourceKind:root.sourceKind,sourceEntity:root.sourceEntity,sourceId:root.sourceId,beneficiaryRole:root.beneficiaryRole,sourceDigest:root.sourceDigest}],
  sourceEvidence:[{observationId:'501',originalDigest:sha(raw),extractSha256:'c'.repeat(64),canonical:canonicalize(supplemental),digest:sha(supplemental)}]});
 assert.equal(candidate.state,'CANDIDATE');if(candidate.state!=='CANDIDATE')throw Error('Fixture proof failed');return candidate.input;
}
function fixture(){
 const state={queries:[] as {sql:string;args:any[]}[],receipts:new Map<string,any>(),now:'2026-10-15T08:30:00.000Z',identity:true,role:'fixture_owner',existing:null as any,failAudit:false};
 const query=async(sql:string,args:any[]=[])=>{
  state.queries.push({sql,args});
  if(sql.includes('finance-opening resource'))return{rows:[{...resource,role:state.role,now:state.now,tableOwner:state.role}],rowCount:1};
  if(sql.includes('stored opening review schema'))return{rows:[{ready:true,owner:state.role,proof_ready:true}],rowCount:1};
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

test('new paired return proof is sealed in the existing reviewed input and exact replay never posts the two historical movements',async()=>{
 const f=await prepare(returnInput());await importReviewedStoredOpeningBatch(f.pool,actor,[f.i],[f.scope]);
 const sealed=f.state.queries.find(q=>q.sql.includes('finance_stored_opening_review('));assert(sealed);
 assert.equal(sealed.args[5],canonicalize(f.i));assert.equal(JSON.parse(sealed.args[3]).sourceProofDigest,sha(f.i.sourceProof));
 assert.equal(f.state.queries.filter(q=>q.sql.includes('INSERT INTO zzsh_order.finance_event')).length,1);
 assert.equal(f.state.queries.find(q=>q.sql.includes('INSERT INTO zzsh_order.settlement_ledger_entry'))?.args[2],'750');
 const before=f.state.queries.filter(q=>/^\s*INSERT/.test(q.sql)).length;
 await importReviewedStoredOpeningBatch(f.pool,actor,[f.i],[f.scope]);assert.equal(f.state.queries.filter(q=>/^\s*INSERT/.test(q.sql)).length,before);
 const changed=returnInput('FIXTURE-CHANGED-ORIGINAL'),scope=await bindReviewedStoredOpeningAdmission(f.client,actor,review(changed));
 await assert.rejects(importReviewedStoredOpeningBatch(f.pool,actor,[changed],[scope]),(error:any)=>error.status===409);
});

test('return source proof cannot be dropped, detached from coverage or rebound without its separate digest',async()=>{
 for(const change of [(i:StoredOpeningInput)=>{delete i.sourceProof;},(i:StoredOpeningInput)=>i.sourceProof!.sources.pop(),(i:StoredOpeningInput)=>i.sourceProof!.logBindings.pop(),(i:StoredOpeningInput)=>{i.admissions[1]!.included=false;}]){
  const i=returnInput();change(i);const f=await prepare(i);await assert.rejects(planFinanceOpening(f.client,actor,i,f.scope));assert(!f.state.queries.some(q=>/^\s*INSERT/.test(q.sql)));
 }
 const i=returnInput(),r=review(i),f=fixture();delete r.sourceProofDigest;
 const scope=await bindReviewedStoredOpeningAdmission(f.client,actor,r);await assert.rejects(planFinanceOpening(f.client,actor,i,scope),/not separately reviewed/);
 const recovery=await prepare(returnInput(),'recover'),result=await recoverReviewedStoredOpeningBatch(recovery.client,actor,[recovery.i],[recovery.scope]);
 assert.equal(result.knowledge,'UNKNOWN');assert(!recovery.state.queries.some(q=>/^\s*(INSERT|UPDATE|DELETE)/.test(q.sql)));
});

test('old stored input and review keep their original byte shape with no implicit source-proof field',async()=>{
 const f=await prepare();assert.equal(Object.hasOwn(f.i,'sourceProof'),false);assert.equal(Object.hasOwn(f.r,'sourceProofDigest'),false);
 await importReviewedStoredOpeningBatch(f.pool,actor,[f.i],[f.scope]);const sealed=f.state.queries.find(q=>q.sql.includes('finance_stored_opening_review('));assert(sealed);
 assert.equal(sealed.args[3],canonicalize(f.r));assert.equal(sealed.args[5],canonicalize(f.i));
 assert.equal(Object.hasOwn(JSON.parse(sealed.args[3]),'sourceProofDigest'),false);assert.equal(Object.hasOwn(JSON.parse(sealed.args[5]),'sourceProof'),false);
});

test('FIN02 supplement is admitted only through a new sealed opening without replacing an already immutable nine-field observation',async()=>{
 const f=await prepare(adminInput()),o=(await planFinanceOpening(f.client,actor,f.i,f.scope)).observations[0]!;
 f.state.existing={user_id:o.userId,legacy_user_id:o.legacyUserId,source_kind:o.sourceKind,basis_id:null,included_in_opening:false,source_digest:o.sourceDigest,source_canonical:o.sourceCanonical,snapshot:JSON.parse(o.sourceCanonical),source_event_at:o.sourceEventAt};
 await importReviewedStoredOpeningBatch(f.pool,actor,[f.i],[f.scope]);
 assert(!f.state.queries.some(q=>/^\s*UPDATE/.test(q.sql)||q.sql.includes('INSERT INTO zzsh_order.personal_finance_observation')));
 const sealed=f.state.queries.find(q=>q.sql.includes('finance_stored_opening_review('));assert(sealed);
 const body=JSON.parse(sealed.args[5]),original=JSON.parse(body.observations[0].rawSource.canonical),supplement=JSON.parse(body.sourceProof.supplementalLogs[0].canonical);
 assert.equal(Object.keys(original).length,9);assert.equal(supplement.source_sn,'');assert.equal(supplement.remark,'Fixture original reason');assert.equal(supplement.extra,null);
 const missing=adminInput(),evidence=missing.sourceProof!.supplementalLogs[0]!,value=JSON.parse(evidence.canonical);delete value.remark;evidence.canonical=canonicalize(value);evidence.digest=sha(value);
 const g=await prepare(missing);await assert.rejects(planFinanceOpening(g.client,actor,missing,g.scope),/incomplete/);
});
