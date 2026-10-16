import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalize} from '../src/supply/content-hash';
import {prepareHistoricalObservation} from '../src/finance/personal-finance-read';
import {bindReviewedFinanceObservationAdmission,importReviewedFinanceObservationsBatch,planFinanceObservations,recoverReviewedFinanceObservations,type ObservationImportInput,type ObservationImportReview} from '../src/finance/personal-finance-observation-maintenance';

const actor={userId:'fixture_boss',sessionId:'fixture_session',requestId:'fixture_request'};
const resource={host:'127.0.0.1' as const,port:55432 as const,database:'zzsh_test_order_history',oid:42,owner:'fixture_owner',marker:'zzsh:order-reservation-test:v1',role:'fixture_owner',roleOid:43};
const sha=(v:unknown)=>createHash('sha256').update(canonicalize(v)).digest('hex');
function input(empty=false):ObservationImportInput{
 const row={kind:'withdrawObservation',sourceId:42,sourceUserId:11,sourceStatus:2,amount:'12.34',net:'12.00',fee:'0.34',createdAt:1759276800};
 const p=prepareHistoricalObservation(row,{userId:'fixture_user',legacyUserId:'11',sourceSystem:'legacy_mysql_restore',basisId:null});
 return{coverage:{userId:'fixture_user',legacyUserId:'11',sourceSystem:'legacy_mysql_restore',sourceKind:'HISTORICAL_WITHDRAWAL',cutoff:'2026-10-01T00:00:00.000Z',inputSha256:'a'.repeat(64),identityDigest:'b'.repeat(64),sourceCount:empty?0:1,imported:empty?[]:[{sourceId:p.sourceId,sourceDigest:p.sourceDigest}],isolated:[]},observations:empty?[]:[row]};
}
function review(i=input()):ObservationImportReview{return{ref:'FIXTURE_NOT_REAL_APPROVAL',attempt:'fixture_attempt',actor:{userId:actor.userId,sessionId:actor.sessionId},resource:{...resource},notBefore:'2026-10-16T05:00:00.000Z',expiresAt:'2026-10-16T06:00:00.000Z',inputSha256:i.coverage.inputSha256,cutoff:i.coverage.cutoff,bodyDigest:sha(i),userId:i.coverage.userId,sourceKind:i.coverage.sourceKind};}
function fixture(){
 const state={now:'2026-10-16T05:30:00.000Z',identity:true,owner:resource.role,revoked:false,audit:true,readError:false,failAudit:false,queries:[] as {sql:string;args:any[]}[],receipts:new Map<string,any>(),observations:new Map<string,any>(),coverage:new Map<string,any>(),before:null as any};
 const client:any={connectionParameters:{host:resource.host,port:resource.port,database:resource.database,user:resource.role},release(){},query:async(sql:string,args:any[]=[])=>{
  state.queries.push({sql,args});
  if(sql==='BEGIN'){state.before=structuredClone({receipts:state.receipts,observations:state.observations,coverage:state.coverage});return{rows:[]};}
  if(sql==='ROLLBACK'){if(state.before)Object.assign(state,state.before);return{rows:[]};}if(sql==='COMMIT'){state.before=null;return{rows:[]};}
  if(sql.includes('finance-opening resource'))return{rows:[{...resource,tableOwner:state.owner,now:state.now}]};
  if(sql.includes('s."locked",u."twoFactorEnabled"'))return{rows:state.revoked?[]:[{locked:false,twoFactorEnabled:true}],rowCount:state.revoked?0:1};
  if(sql.includes('admin_security'))return{rows:[{status:'ACTIVE',isBoss:true,passwordChangeRequired:false}],rowCount:1};
  if(sql.includes('SELECT suspended'))return{rows:[{suspended:false}],rowCount:1};
  if(sql.includes('finance history maintenance schema'))return{rows:[{ready:true,owner:state.owner}]};
  if(sql.includes('finance history source identity'))return{rows:state.identity?[{}]:[],rowCount:state.identity?1:0};
  if(sql.includes('"requestFingerprint"')){const r=state.receipts.get(args[1]);return{rows:r?[{requestFingerprint:r.fingerprint,responseStatus:r.status,responseBody:r.body,publishRequired:false}]:[]};}
  if(sql.includes('request_fingerprint AS fingerprint')){if(state.readError)throw Error('FIXTURE_READBACK_UNKNOWN');const r=state.receipts.get(args[1]);return{rows:r?[r]:[]};}
  if(sql.includes('finance history existing observation')){const row=state.observations.get(args.join(':'));return{rows:row?[row]:[]};}
  if(sql.startsWith('INSERT INTO zzsh_order.personal_finance_observation(')){
   state.observations.set([args[3],args[5],args[6]].join(':'),{id:args[0],user_id:args[1],basis_id:null,source_kind:args[2],source_type:'LEGACY_MYSQL',source_system:args[3],legacy_user_id:args[4],source_entity:args[5],source_id:args[6],source_digest:args[7],source_canonical:args[8],source_event_at:args[9],snapshot:JSON.parse(args[10]),included_in_opening:false});return{rows:[]};
  }
  if(sql.startsWith('INSERT INTO zzsh_order.personal_finance_observation_coverage(')){state.coverage.set(args[0],{body_digest:args[15]});return{rows:[]};}
  if(sql.includes('finance history recovery coverage')){const c=state.coverage.get(args[0]);return{rows:c?[c]:[]};}
  if(sql.includes('finance history recovery audit'))return{rows:state.audit?[{}]:[],rowCount:state.audit?1:0};
  if(sql.includes('INSERT INTO "zzsh_supply"."idempotency_record"')){state.receipts.set(args[1],{fingerprint:args[2],status:args[3],body:JSON.parse(args[4])});return{rows:[]};}
  if(sql.includes('INSERT INTO "zzsh_iam"."audit_event"')&&state.failAudit)throw Error('FIXTURE_AUDIT_FAILED');
  return{rows:[],rowCount:1};
 }};
 return{state,client,pool:{connect:async()=>client} as any};
}

test('observation plan closes source rows and exact cutoff/digest without a wallet effect',()=>{
 const i=input(),p=planFinanceObservations(i);assert.equal(p.observations.length,1);assert.equal(p.observations[0]?.includedInOpening,false);
 for(const change of [(v:ObservationImportInput)=>{v.observations=[];},(v:ObservationImportInput)=>{v.observations[0]!.sourceUserId=99;},(v:ObservationImportInput)=>{v.observations[0]!.sourceStatus=9;},(v:ObservationImportInput)=>{v.coverage.imported[0]!.sourceDigest='c'.repeat(64);}]){const v=structuredClone(i);change(v);assert.throws(()=>planFinanceObservations(v));}
});
test('opaque reviewed import is idempotent, preserves exact source and does not credit or initialize',async()=>{
 const f=fixture(),i=input(),scope=await bindReviewedFinanceObservationAdmission(f.client,actor,review(i));
 const first=await importReviewedFinanceObservationsBatch(f.pool,actor,[i],[scope]);assert.equal(first[0]?.replayed,false);const count=f.state.observations.size;
 const replay=await importReviewedFinanceObservationsBatch(f.pool,actor,[i],[scope]);assert.equal(replay[0]?.replayed,true);assert.equal(f.state.observations.size,count);assert.equal(f.state.coverage.size,1);
 assert(!f.state.queries.some(q=>q.sql.startsWith('INSERT')&&/finance_event|ledger_entry|finance_opening_basis|withdrawal_intent/.test(q.sql)));
 const changed=structuredClone(i);changed.observations[0]!.fee='0.33';await assert.rejects(()=>importReviewedFinanceObservationsBatch(f.pool,actor,[changed],[scope]));
 await assert.rejects(()=>importReviewedFinanceObservationsBatch(f.pool,actor,[i],[JSON.parse(JSON.stringify(scope))]));
});
test('known empty coverage is an explicit import, not a zero balance or synthesized observation',async()=>{
 const f=fixture(),i=input(true),scope=await bindReviewedFinanceObservationAdmission(f.client,actor,review(i));
 const r=await importReviewedFinanceObservationsBatch(f.pool,actor,[i],[scope]);const body=r[0]?.body;assert(body&&typeof body==='object'&&'importedCount' in body);assert.equal(body.importedCount,0);assert.equal(f.state.observations.size,0);assert.equal(f.state.coverage.size,1);
 assert(!f.state.queries.some(q=>q.sql.startsWith('INSERT')&&/finance_event|ledger_entry|finance_opening_basis|withdrawal_intent/.test(q.sql)));
});
test('bad resource/actor/identity and self-approval never become admission',async()=>{
 const f=fixture(),i=input();await assert.rejects(()=>bindReviewedFinanceObservationAdmission(f.client,actor,{...review(i),approved:true} as any));
 f.client.connectionParameters.database='zzsh_test_order_other';await assert.rejects(()=>bindReviewedFinanceObservationAdmission(f.client,actor,review(i)));f.client.connectionParameters.database=resource.database;
 const scope=await bindReviewedFinanceObservationAdmission(f.client,actor,review(i));f.state.identity=false;await assert.rejects(()=>importReviewedFinanceObservationsBatch(f.pool,actor,[i],[scope]));assert.equal(f.state.coverage.size,0);
});
test('expired/recovery-only scopes cannot write and recovery verifies original facts/audit only',async()=>{
 const f=fixture(),i=input(),scope=await bindReviewedFinanceObservationAdmission(f.client,actor,review(i));
 const missing=await recoverReviewedFinanceObservations(f.client,actor,i,scope);assert.equal(missing.knowledge,'UNKNOWN');
 await importReviewedFinanceObservationsBatch(f.pool,actor,[i],[scope]);f.state.now='2026-10-16T07:00:00.000Z';
 await assert.rejects(()=>importReviewedFinanceObservationsBatch(f.pool,actor,[i],[scope]));
 const recover=await bindReviewedFinanceObservationAdmission(f.client,actor,review(i),'recover'),before=f.state.queries.length;
 assert.equal((await recoverReviewedFinanceObservations(f.client,actor,i,recover)).knowledge,'KNOWN');assert(!f.state.queries.slice(before).some(q=>/^(INSERT|UPDATE|DELETE)/.test(q.sql)));
 f.state.audit=false;await assert.rejects(()=>recoverReviewedFinanceObservations(f.client,actor,i,recover));f.state.audit=true;
 f.state.readError=true;await assert.rejects(()=>recoverReviewedFinanceObservations(f.client,actor,i,recover),/READBACK_UNKNOWN/);
});
test('audit failure calls outer rollback and leaves no synthetic import receipt',async()=>{
 const f=fixture(),i=input(),scope=await bindReviewedFinanceObservationAdmission(f.client,actor,review(i));f.state.failAudit=true;
 await assert.rejects(()=>importReviewedFinanceObservationsBatch(f.pool,actor,[i],[scope]),/AUDIT_FAILED/);
 assert.equal(f.state.coverage.size,0);assert.equal(f.state.observations.size,0);assert.equal(f.state.receipts.size,0);assert(f.state.queries.some(q=>q.sql==='ROLLBACK'));
});
