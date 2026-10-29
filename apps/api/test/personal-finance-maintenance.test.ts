import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import * as maintenance from '../src/finance/personal-finance-maintenance';
import {canonicalize} from '../src/supply/content-hash';
import {fingerprintRequest} from '../src/supply/supply-util';
import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {resolve} from 'node:path';
import {runInNewContext} from 'node:vm';
import {transpileModule,ModuleKind,ScriptTarget} from 'typescript';

// All identities, resources and approval refs here are synthetic; query is an offline SQL seam.
const api=maintenance as any,sha=(value:unknown)=>createHash('sha256').update(typeof value==='string'?value:canonicalize(value)).digest('hex');
const actor={userId:'fixture-boss',sessionId:'fixture-session',requestId:'fixture-request'};
const resource={host:'127.0.0.1',port:55432,database:'zzsh_test_order_cf1_fixture',oid:42,owner:'fixture_owner',marker:'zzsh:order-reservation-test:v1',role:'fixture_owner',roleOid:43};
const cutoff='2026-09-13T13:31:22.000Z';
function legacyMaintenance(){
 // Frozen pre-admission implementation; only its unchanged shared dependencies come from this build.
 const source=execFileSync('git',['show','2be66f7619ede1c684c442fd4faf2c42274d11ba:apps/api/src/finance/personal-finance-maintenance.ts'],{cwd:resolve(__dirname,'../../../..')});
 assert.equal(createHash('sha256').update(source).digest('hex'),'cd1b96bfd7d660fa9b26ba6c6e661e393aba76d8e12b086bdf38604f4281257a');
 const exports:Record<string,any>={};
 runInNewContext(transpileModule(source.toString('utf8'),{compilerOptions:{target:ScriptTarget.ES2022,module:ModuleKind.CommonJS}}).outputText,{exports,require:createRequire(resolve(__dirname,'../src/finance/personal-finance-maintenance.js'))});
 assert.notEqual(exports.importReviewedFinanceOpeningBatch,api.importReviewedFinanceOpeningBatch);return exports;
}
function input(userId='fixture-wallet',sourceId='101',amount='110'){
 const observation={kind:'earningsLog',sourceId:501,sourceUserId:Number(sourceId),amount:amount==='0'?'0.00':'1.10',leftAmount:amount==='0'?'0.00':'1.10',action:1,createdAt:1779469800,referenceType:'LEGACY_DISTRIBUTION_EARNING',referenceId:'901',referenceSn:'FIXTURE-COMMISSION-NOT-A-REAL-NUMBER'};
 const coveredSet=[[userId,'LEGACY_DISTRIBUTION_EARNING','LEGACY_MYSQL','la_distribution_order','901','RENTER_REFERRAL',String(observation.createdAt),'d'.repeat(64)]];
 return {inputSha256:'a'.repeat(64),cutoff,proof:{userId,source:{sourceSystem:'legacy_mysql_restore',sourceEntity:'la_user',sourceId,identityDigest:'b'.repeat(64)},availableCents:amount,sourceDigest:'c'.repeat(64),coveredCount:1,coveredDigest:sha(coveredSet.map(row=>JSON.stringify(row)).join('\n')),coveredSet},observations:[observation],admissions:[{sourceEntity:'la_log_earnings',sourceId:'501',sourceDigest:sha(observation),sourceEventAt:new Date(observation.createdAt*1000).toISOString(),included:true}]};
}
function review(i=input()){
 return {ref:'FIXTURE-REVIEW-NOT-APPROVAL',attempt:'fixture-attempt-1',actor:{userId:actor.userId,sessionId:actor.sessionId},resource:{...resource},notBefore:'2026-10-15T08:00:00.000Z',expiresAt:'2026-10-15T09:00:00.000Z',inputSha256:i.inputSha256,cutoff:i.cutoff,subject:{userId:i.proof.userId,sourceId:i.proof.source.sourceId,identityDigest:i.proof.source.identityDigest,sourceDigest:i.proof.sourceDigest,availableCents:i.proof.availableCents,coveredDigest:i.proof.coveredDigest},bodyDigest:sha(i)};
}
function fixture(){
 const state:any={now:'2026-10-15T08:30:00.000Z',resource:{...resource},suspended:false,identity:true,revoked:false,queries:[],writes:0,receipts:new Map(),facts:new Map(),failAt:null,commitUnknown:false,readUnknown:false,cutoffGate:{openingDiffers:false,coverageDiffers:false}};
 const query=async(sql:string,args:any[]=[])=>{
  state.queries.push({sql,args});
  if(sql==='BEGIN'){state.before={receipts:new Map(state.receipts),facts:structuredClone(state.facts)};return {rows:[],rowCount:0};}
  if(sql==='COMMIT'){state.before=null;if(state.commitUnknown)throw new Error('FIXTURE_COMMIT_ACK_UNKNOWN');return {rows:[],rowCount:0};}
  if(sql==='ROLLBACK'){if(state.before){state.receipts=state.before.receipts;state.facts=state.before.facts;state.before=null;}return {rows:[],rowCount:0};}
  if(sql.includes('finance-opening resource')){state.onResource?.();return {rows:[{...state.resource,now:state.now,tableOwner:state.resource.role}],rowCount:1};}
  if(sql.includes('s."locked",u."twoFactorEnabled"'))return {rows:state.revoked?[]:[{locked:false,twoFactorEnabled:true}],rowCount:state.revoked?0:1};
  if(sql.includes('admin_security'))return {rows:[{status:'ACTIVE',isBoss:true,passwordChangeRequired:false}],rowCount:1};
  if(sql.includes('SELECT suspended'))return {rows:[{suspended:state.suspended}],rowCount:1};
  if(sql.includes('finance single cutoff admission'))return {rows:[{openingDiffers:state.cutoffGate.openingDiffers,coverageDiffers:state.cutoffGate.coverageDiffers}],rowCount:1};
  if(sql.includes('user.legacy_owner.migrated'))return {rows:state.identity?[{}]:[],rowCount:state.identity?1:0};
  if(sql.includes('"requestFingerprint"')){const r=state.receipts.get(args[1]);return {rows:r?[{requestFingerprint:r.fingerprint,responseStatus:r.status,responseBody:r.body,publishRequired:false}]:[],rowCount:r?1:0};}
  if(sql.includes('request_fingerprint AS fingerprint')){if(state.readUnknown)throw Error('FIXTURE_READBACK_UNKNOWN');const r=state.receipts.get(args[1]);return {rows:r?[r]:[],rowCount:r?1:0};}
  if(sql.includes('AS lines,COALESCE')){const f=state.facts.get(args[0]);return {rows:f?[{amount:f.amount,subject:f.userId,kind:'OPENING',lines:f.amount==='0'?0:2,debits:f.amount,credits:f.amount}]:[],rowCount:f?1:0};}
  if(sql.includes('finance-opening recovery basis'))return {rows:state.recoveryRows?.basis??[],rowCount:state.recoveryRows?.basis.length??0};
  if(sql.includes('finance-opening recovery covered'))return {rows:state.recoveryRows?.covered??[],rowCount:state.recoveryRows?.covered.length??0};
  if(sql.includes('finance-opening recovery observations'))return {rows:state.recoveryRows?.observations??[],rowCount:state.recoveryRows?.observations.length??0};
  if(sql.includes('finance-opening recovery ledger'))return {rows:state.recoveryRows?.ledger??[],rowCount:state.recoveryRows?.ledger.length??0};
  if(sql.includes('finance-opening recovery audit'))return {rows:state.recoveryRows?.audit??[],rowCount:state.recoveryRows?.audit.length??0};
  if(/^INSERT\b/.test(sql)){
   state.writes++;if(state.expireOnWrite)state.now='2026-10-15T09:00:00.000Z';if(state.failAt&&sql.includes(state.failAt))throw Error('FIXTURE_WRITE_FAILED');
   if(sql.includes('finance_opening_basis('))state.facts.set(args[0],{userId:args[1],amount:args[6]});
   if(sql.includes('"idempotency_record"'))state.receipts.set(args[1],{fingerprint:args[2],status:args[3],body:JSON.parse(args[4])});
  }
  return {rows:sql.includes('wallet_revision')?[{ledger_revision:'0'}]:[],rowCount:1};
 };
 const client:any={connectionParameters:{host:resource.host,port:resource.port,database:resource.database,user:resource.role},query,release(){}};
 const pool:any={connect:async()=>client};
 return {state,client,pool};
}
async function admitted(f=fixture(),i=input(),r=review(i),mode?:'recover'){
 const scope=await api.bindReviewedFinanceOpeningAdmission(f.client,actor,r,mode);
 return {...f,i,r,scope};
}
function recoveryEvidence(f:any,plan:any){
 const i=f.i,p=i.proof,o=plan.observations[0];
 f.state.recoveryRows={basis:[{userId:p.userId,sourceSystem:p.source.sourceSystem,sourceEntity:'la_user',sourceId:p.source.sourceId,identityDigest:p.source.identityDigest,sourceDigest:p.sourceDigest,cutoff:i.cutoff,coveredCount:1,coveredDigest:p.coveredDigest,rootKind:'LEGACY_OPENING',rootType:'LEGACY_MYSQL',rootSystem:p.source.sourceSystem,rootEntity:'la_user',rootSourceId:p.source.sourceId,rootSubject:p.userId,rootRole:'WALLET_HOLDER'}],covered:p.coveredSet.map((row:any)=>({row})),observations:[{userId:p.userId,sourceSystem:o.sourceSystem,legacyUserId:o.legacyUserId,sourceEntity:o.sourceEntity,sourceId:o.sourceId,sourceDigest:o.sourceDigest,sourceEventAt:o.sourceEventAt,included:true,canonical:o.sourceCanonical,observationUserId:p.userId,observationBasis:plan.basisId,observationDigest:o.sourceDigest,observationCanonical:o.sourceCanonical,observationIncluded:true}],ledger:[{line:1,account:'LEGACY_OPENING_SOURCE',debit:'110',credit:'0',subject:null},{line:2,account:'WALLET_AVAILABLE',debit:'0',credit:'110',subject:p.userId}],audit:[{}]};
}

test('new one-subject input and self-reported approval fail before business writes',async()=>{
 const f=fixture(),i=input();await assert.rejects(api.planFinanceOpening(f.client,actor,i));
 for(const action of ['planFinanceOpening','importFinanceOpening'])await assert.rejects(api[action](f.client,actor,i,{approved:true,kind:'REVIEWED_FINANCE_OPENING'}));
 for(const action of ['importReviewedFinanceOpeningBatch','recoverReviewedFinanceOpeningBatch'])await assert.rejects(api[action](action.startsWith('import')?f.pool:f.client,actor,[i],{approved:true,reviewedBodyDigests:[sha(i)]}));
 assert.equal(f.state.writes,0);
});
test('internal admission binds actual resource and frozen body for plan/import/batch',async()=>{
 const f=await admitted();const plan=await api.planFinanceOpening(f.client,actor,f.i,f.scope);assert.equal(plan.bodyDigest,sha(f.i));assert.equal(plan.key,'u2-opening-'+sha(['legacy_mysql_restore',f.i.proof.source.sourceId,f.i.proof.userId]).slice(0,32));
 const result=await api.importReviewedFinanceOpeningBatch(f.pool,actor,[f.i],f.scope);assert.equal(result.length,1);assert.equal(result[0].status,200);assert.equal(f.state.facts.size,1);assert(f.state.queries.some((q:any)=>q.sql==='SET CONSTRAINTS ALL IMMEDIATE'));
});
test('all new boundaries reject changed subject/identity/input/cutoff/body/actor',async()=>{
 const f=await admitted();for(const change of [(i:any)=>i.proof.userId='wrong-user',(i:any)=>i.proof.source.identityDigest='f'.repeat(64),(i:any)=>i.inputSha256='f'.repeat(64),(i:any)=>i.cutoff='2026-09-14T00:00:00.000Z',(i:any)=>i.proof.availableCents='2200']){const i=structuredClone(f.i);change(i);await assert.rejects(api.planFinanceOpening(f.client,actor,i,f.scope));}
 await assert.rejects(api.planFinanceOpening(f.client,{...actor,userId:'wrong-actor'},f.i,f.scope));assert.equal(f.state.writes,0);
});
test('reported resource is not proof; server and driver identity must match',async()=>{
 for(const patch of [{oid:99},{owner:'wrong_owner'},{marker:'wrong-marker'},{role:'wrong_role'},{roleOid:99},{database:'wrong_db'}]){const f=fixture();Object.assign(f.state.resource,patch);await assert.rejects(admitted(f));assert.equal(f.state.writes,0);}
 const f=fixture();f.client.connectionParameters.host='external.example';await assert.rejects(admitted(f));
});
test('duplicate/missing coverage and observations, same-id wrong entity and UNRESOLVED are rejected even if reviewed hash follows them',async()=>{
 for(const change of [(i:any)=>i.proof.coveredSet.push([...i.proof.coveredSet[0]]),(i:any)=>i.proof.coveredSet=[],(i:any)=>i.observations.push({...i.observations[0]}),(i:any)=>i.admissions=[],(i:any)=>i.proof.coveredSet[0][3]='la_order',(i:any)=>i.proof.coveredSet[0][1]='UNRESOLVED_ECONOMIC_SOURCE']){const i=input();change(i);i.proof.coveredCount=i.proof.coveredSet.length;i.proof.coveredDigest=sha(i.proof.coveredSet.map((r:any)=>JSON.stringify(r)).join('\n'));const f=await admitted(fixture(),i,review(i));await assert.rejects(api.planFinanceOpening(f.client,actor,i,f.scope));}
});
test('approval and inputs are snapshotted; runtime identity still rechecks',async()=>{
 const f=await admitted();f.r.expiresAt='2099-01-01T00:00:00.000Z';f.r.subject.availableCents='2200';f.state.identity=false;await assert.rejects(api.planFinanceOpening(f.client,actor,f.i,f.scope));f.state.identity=true;f.state.resource.oid=99;await assert.rejects(api.importFinanceOpening(f.client,actor,f.i,f.scope));assert.equal(f.state.writes,0);
});
test('expired new writes fail, recovery-only admission cannot import',async()=>{
 const f=await admitted();f.state.now='2026-10-15T09:00:00.000Z';await assert.rejects(api.importReviewedFinanceOpeningBatch(f.pool,actor,[f.i],f.scope));assert.equal(f.state.writes,0);
 const g=fixture();g.state.now=f.state.now;const r=await admitted(g,input(),review(),'recover');await assert.rejects(api.planFinanceOpening(r.client,actor,r.i,r.scope));await assert.rejects(api.importReviewedFinanceOpeningBatch(r.pool,actor,[r.i],r.scope));
 const recovered=await api.recoverReviewedFinanceOpeningBatch(r.client,actor,[r.i],r.scope);assert.equal(recovered.knowledge,'UNKNOWN');assert.equal(r.state.writes,0);
});
test('same original key replays and a conflicting receipt rejects',async()=>{
 const f=await admitted();const first=await api.importReviewedFinanceOpeningBatch(f.pool,actor,[f.i],f.scope),writes=f.state.writes;const second=await api.importReviewedFinanceOpeningBatch(f.pool,actor,[f.i],f.scope);assert.equal(second[0].replayed,true);assert.deepEqual(second[0].body,first[0].body);assert.equal(f.state.writes,writes);
 const receipt=[...f.state.receipts.values()][0] as any;receipt.fingerprint='WRONG';await assert.rejects(api.importReviewedFinanceOpeningBatch(f.pool,actor,[f.i],f.scope),(e:any)=>e.status===409);
});
test('failed observation rolls back all one-subject financial/idempotency facts',async()=>{
 const f=await admitted();f.state.failAt='personal_finance_observation(';await assert.rejects(api.importReviewedFinanceOpeningBatch(f.pool,actor,[f.i],f.scope));assert.equal(f.state.facts.size,0);assert.equal(f.state.receipts.size,0);assert(f.state.queries.some((q:any)=>q.sql==='ROLLBACK'));
});
test('commit acknowledgement unknown has no invented success; expired original recovery verifies all facts',async()=>{
 const f=await admitted();const plan=await api.planFinanceOpening(f.client,actor,f.i,f.scope);f.state.commitUnknown=true;await assert.rejects(api.importReviewedFinanceOpeningBatch(f.pool,actor,[f.i],f.scope),/COMMIT_ACK_UNKNOWN/);recoveryEvidence(f,plan);f.state.now='2026-10-15T10:00:00.000Z';const before=f.state.writes;const recovered=await api.recoverReviewedFinanceOpeningBatch(f.client,actor,[f.i],f.scope);assert.equal(recovered.knowledge,'KNOWN');assert.equal(f.state.writes,before);
 f.state.recoveryRows.observations=[];await assert.rejects(api.recoverReviewedFinanceOpeningBatch(f.client,actor,[f.i],f.scope));f.state.revoked=true;await assert.rejects(api.recoverReviewedFinanceOpeningBatch(f.client,actor,[f.i],f.scope),(e:any)=>e.status===401);
});
test('missing receipt stays UNKNOWN; failed readback throws without an import',async()=>{
 const f=await admitted();assert.equal((await api.recoverReviewedFinanceOpeningBatch(f.client,actor,[f.i],f.scope)).knowledge,'UNKNOWN');f.state.readUnknown=true;await assert.rejects(api.recoverReviewedFinanceOpeningBatch(f.client,actor,[f.i],f.scope),/READBACK_UNKNOWN/);assert.equal(f.state.writes,0);
});
test('old implementation receipts replay and recover unchanged after upgrade, including zero opening',async()=>{
 const f=fixture(),inputs=['1','2','3'].map((id,n)=>{const i=input('fixture-legacy-'+id,id,n===0?'0':'110');i.inputSha256='ee431b3ac1ed74952bbc08e57581c6d9ab04a4bd01100ca05ac00a77e6175ec0';i.cutoff='2026-10-03T02:31:22.516Z';return i;});
 const old=legacyMaintenance(),approved=inputs.map(i=>sha(i)),originalBody=JSON.stringify(inputs);
 const result=await old.importReviewedFinanceOpeningBatch(f.pool,actor,inputs,approved);assert.equal(result.length,3);assert.equal(f.state.receipts.size,3);assert.equal(f.state.facts.size,3);assert.equal(f.state.facts.get('basis_'+sha(inputs[0]!.proof.userId).slice(0,32)).amount,'0');
 assert.equal((await old.recoverReviewedFinanceOpeningBatch(f.client,actor,inputs,approved)).knowledge,'KNOWN');
 const writes=f.state.writes,receipts=JSON.stringify([...f.state.receipts]);
 const replay=await api.importReviewedFinanceOpeningBatch(f.pool,actor,inputs,approved);assert(replay.every((r:any)=>r.replayed===true));assert.equal(JSON.stringify(replay.map((r:any)=>r.body)),JSON.stringify(result.map((r:any)=>r.body)));
 const recovered=await api.recoverReviewedFinanceOpeningBatch(f.client,actor,inputs,approved);assert.equal(recovered.knowledge,'KNOWN');assert.equal(recovered.results.length,3);assert(recovered.results.every((r:any)=>r.originalOpeningVerified));
 assert.equal(f.state.writes,writes);assert.equal(JSON.stringify([...f.state.receipts]),receipts);assert.equal(JSON.stringify(inputs),originalBody);
 assert.notEqual(fingerprintRequest('finance.opening.import',inputs[0]!.proof.userId,inputs[0]),fingerprintRequest('finance.opening.import',inputs[0]!.proof.userId,JSON.parse(canonicalize(inputs[0]))));
 const changed=structuredClone(inputs[1]!);changed.proof.availableCents='2200';await assert.rejects(api.importFinanceOpening(f.client,actor,changed),(e:any)=>e.status===409);assert.equal(f.state.writes,writes);
 const bad=structuredClone(inputs);bad[0]!.inputSha256='a'.repeat(64);await assert.rejects(api.importReviewedFinanceOpeningBatch(f.pool,actor,bad,bad.map(i=>sha(i))));
});
test('binder rejects self-approval fields and serialized/cloned scope has no authority',async()=>{
 const f=fixture();await assert.rejects(api.bindReviewedFinanceOpeningAdmission(f.client,actor,{...review(),approved:true}));
 await assert.rejects(api.bindReviewedFinanceOpeningAdmission(f.client,actor,{...review(),ref:42}));await assert.rejects(api.bindReviewedFinanceOpeningAdmission(f.client,actor,{...review(),expiresAt:'2026-10-15T09:00:00'}));
 const a=await admitted(f);await assert.rejects(api.planFinanceOpening(a.client,actor,a.i,JSON.parse(JSON.stringify(a.scope))));assert.equal(f.state.writes,0);
});
test('window not started rejects and expiration during writes aborts the whole batch',async()=>{
 const f=fixture();f.state.now='2026-10-15T07:59:59.999Z';await assert.rejects(admitted(f));
 const a=await admitted();a.state.expireOnWrite=true;await assert.rejects(api.importReviewedFinanceOpeningBatch(a.pool,actor,[a.i],a.scope));assert.equal(a.state.facts.size,0);assert.equal(a.state.receipts.size,0);assert(a.state.queries.some((x:any)=>x.sql==='ROLLBACK'));
});
test('a success receipt alone never recovers missing or conflicting basis/coverage/observations/ledger/audit',async()=>{
 const f=await admitted();const plan=await api.planFinanceOpening(f.client,actor,f.i,f.scope);await api.importReviewedFinanceOpeningBatch(f.pool,actor,[f.i],f.scope);recoveryEvidence(f,plan);const full=structuredClone(f.state.recoveryRows),before=f.state.writes;
 for(const key of ['basis','covered','observations','ledger','audit']){f.state.recoveryRows=structuredClone(full);f.state.recoveryRows[key]=[];await assert.rejects(api.recoverReviewedFinanceOpeningBatch(f.client,actor,[f.i],f.scope));}
 f.state.recoveryRows=structuredClone(full);f.state.recoveryRows.ledger[1].account='OWNER_AVAILABLE';await assert.rejects(api.recoverReviewedFinanceOpeningBatch(f.client,actor,[f.i],f.scope));assert.equal(f.state.writes,before);
});
test('external input mutation across an await never changes approved write bytes',async()=>{
 const f=await admitted();const digest=sha(f.i);f.state.onResource=()=>{f.i.proof.availableCents='2200';f.i.observations[0]!.amount='22.00';};
 const result=await api.importReviewedFinanceOpeningBatch(f.pool,actor,[f.i],f.scope);assert.equal(result[0].body.bodyDigest,digest);assert.equal([...f.state.facts.values()][0].amount,'110');assert.equal(f.i.proof.availableCents,'2200');
});
test('opening=C rejects a new coverage=D before any write, while original success, replay and read-only recovery stay successful',async()=>{
 const f=await admitted();const plan=await api.planFinanceOpening(f.client,actor,f.i,f.scope);
 f.state.cutoffGate.coverageDiffers=true;
 await assert.rejects(api.importReviewedFinanceOpeningBatch(f.pool,actor,[f.i],f.scope),(e:any)=>e.status===409);
 assert.equal(f.state.writes,0);assert.equal(f.state.facts.size,0);assert.equal(f.state.receipts.size,0);
 const gate=f.state.queries.findIndex((q:any)=>q.sql.includes('finance single cutoff admission')),lock=f.state.queries.findIndex((q:any)=>q.sql.includes('WHERE id=$1 FOR UPDATE')),insert=f.state.queries.findIndex((q:any)=>/^INSERT/.test(q.sql));
 assert(lock>=0&&gate>lock&&(insert===-1||insert>gate),'the gate runs inside the subject lock and before any insert');
 const sql=f.state.queries[gate]!.sql;assert.match(sql,/source_kind='LEGACY_OPENING'/);assert.match(sql,/b\.source_system='legacy_mysql_restore'/);assert.match(sql,/c\.source_system='legacy_mysql_restore'/);assert.deepEqual(f.state.queries[gate]!.args,[f.i.proof.userId,f.i.cutoff]);
 f.state.cutoffGate.coverageDiffers=false;await api.importReviewedFinanceOpeningBatch(f.pool,actor,[f.i],f.scope);const writes=f.state.writes;recoveryEvidence(f,plan);
 f.state.cutoffGate.coverageDiffers=true;
 const replay=await api.importReviewedFinanceOpeningBatch(f.pool,actor,[f.i],f.scope);assert.equal(replay[0].replayed,true);assert.equal(f.state.writes,writes);
 assert.equal((await api.recoverReviewedFinanceOpeningBatch(f.client,actor,[f.i],f.scope)).knowledge,'KNOWN');assert.equal(f.state.writes,writes);
});
test('same-cutoff opening writes keep working and an inconsistent gate answer is unavailable, not silently allowed',async()=>{
 const f=await admitted();await api.importReviewedFinanceOpeningBatch(f.pool,actor,[f.i],f.scope);assert.equal(f.state.facts.size,1);
 const g=await admitted();g.state.cutoffGate={};
 await assert.rejects(api.importReviewedFinanceOpeningBatch(g.pool,actor,[g.i],g.scope),(e:any)=>e.status===503);assert.equal(g.state.writes,0);
});
