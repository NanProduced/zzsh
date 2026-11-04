import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {withTransaction} from '../src/auth/security-core';
import {canonicalize} from '../src/supply/content-hash';
import {bindReviewedEmptyFinanceObservationBatch,importReviewedEmptyFinanceObservationBatch,recoverReviewedEmptyFinanceObservationBatch,type ObservationImportInput,type ObservationImportReview} from '../src/finance/personal-finance-observation-maintenance';

const actor={userId:'fixture_boss',sessionId:'fixture_session',requestId:'fixture_request'},resource={host:'127.0.0.1' as const,port:55432 as const,database:'zzsh_test_order_empty',oid:42,owner:'fixture_owner',marker:'zzsh:order-reservation-test:v1',role:'fixture_owner',roleOid:43};
const sha=(value:unknown)=>createHash('sha256').update(canonicalize(value)).digest('hex');
function inputs():ObservationImportInput[]{return ['11','12'].flatMap(legacyUserId=>(['HISTORICAL_EARNINGS_LOG','HISTORICAL_PAYMENT'] as const).map(sourceKind=>({coverage:{userId:'fixture_'+legacyUserId,legacyUserId,sourceSystem:'legacy_mysql_restore',sourceKind,cutoff:'2026-10-01T00:00:00.000Z',inputSha256:'a'.repeat(64),identityDigest:'b'.repeat(64),sourceCount:0,imported:[],isolated:[]},observations:[]})));}
const reviews=(rows:ObservationImportInput[]):ObservationImportReview[]=>rows.map(input=>({ref:'FIXTURE_EMPTY_REVIEW',attempt:'fixture_attempt',actor:{userId:actor.userId,sessionId:actor.sessionId},resource:{...resource},notBefore:'2026-10-16T05:00:00.000Z',expiresAt:'2026-10-16T06:00:00.000Z',inputSha256:input.coverage.inputSha256,cutoff:input.coverage.cutoff,bodyDigest:sha(input),userId:input.coverage.userId,sourceKind:input.coverage.sourceKind}));
function fixture(){
 const state={now:'2026-10-16T05:30:00.000Z',badSource:false,badCutoff:false,failAudit:false,queries:[] as {sql:string;args:any[]}[],coverage:new Map<string,any>(),audit:new Map<string,any>(),receipts:new Map<string,any>(),before:null as any};
 const client:any={connectionParameters:{host:resource.host,port:resource.port,database:resource.database,user:resource.role},release(){},query:async(sql:string,args:any[]=[])=>{
  state.queries.push({sql,args});
  if(sql==='BEGIN')state.before=structuredClone({coverage:state.coverage,audit:state.audit,receipts:state.receipts});
  if(sql==='ROLLBACK'&&state.before)Object.assign(state,state.before);
  if(sql.includes('finance-opening resource'))return{rows:[{...resource,tableOwner:resource.role,now:state.now}]};
  if(sql.includes('s."locked",u."twoFactorEnabled"'))return{rows:[{locked:false,twoFactorEnabled:true}],rowCount:1};
  if(sql.includes('admin_security'))return{rows:[{status:'ACTIVE',isBoss:true,passwordChangeRequired:false}],rowCount:1};
  if(sql.includes('SELECT suspended'))return{rows:[{suspended:false}],rowCount:1};
  if(sql.includes('finance history maintenance schema'))return{rows:[{ready:true,owner:resource.role}]};
  if(sql.includes('finance history source identity'))return{rows:[{}],rowCount:1};
  if(sql.includes('finance empty subject locks'))return{rows:args[0].map((id:string)=>({id})),rowCount:args[0].length};
  if(sql.includes('finance empty exact source identities'))return{rows:state.badSource?[{user_id:'fixture_12'}]:[],rowCount:state.badSource?1:0};
  if(sql.includes('finance empty single cutoff'))return{rows:[{differs:state.badCutoff}],rowCount:1};
  if(sql.includes('finance empty original receipts'))return{rows:args[1].flatMap((key:string)=>state.receipts.has(key)?[state.receipts.get(key)]:[])};
  if(sql.includes('finance empty original coverage audit'))return{rows:args[0].flatMap((id:string)=>state.coverage.has(id)?[{...state.coverage.get(id),actual_count:'0',...state.audit.get(id)}]:[])};
  if(sql.includes('finance empty coverage insert'))for(const row of JSON.parse(args[0]))state.coverage.set(row.id,row);
  if(sql.includes('finance empty original audit insert')){if(state.failAudit)throw Error('FIXTURE_AUDIT_FAILED');for(const row of JSON.parse(args[0]))state.audit.set(row.object_id,{actor_id:args[1],session_id:args[2],details:row.details});}
  if(sql.includes('finance empty original receipt insert'))for(const row of JSON.parse(args[0]))state.receipts.set(row.key,{key:row.key,request_fingerprint:row.fingerprint,response_status:200,response_body:row.body});
  return{rows:[],rowCount:1};
 }};return{state,client,pool:{connect:async()=>client} as any};
}

test('bounded empty batches retain individual original keys, immutable coverage and audits while sharing the exact resource admission',async()=>{
 const f=fixture(),rows=inputs(),scope=await bindReviewedEmptyFinanceObservationBatch(f.client,actor,rows,reviews(rows));
 const missing=await recoverReviewedEmptyFinanceObservationBatch(f.client,actor,rows,scope);assert(missing.every(r=>r.knowledge==='UNKNOWN'));assert.equal(f.state.coverage.size,0);
 const before=f.state.queries.length,created=await importReviewedEmptyFinanceObservationBatch(f.client,actor,rows,scope);assert.equal(created.body.created,4);assert.equal(f.state.coverage.size,4);assert.equal(f.state.audit.size,4);assert.equal(f.state.receipts.size,4);
 assert.equal(f.state.queries.slice(before).filter(q=>q.sql.includes('finance-opening resource')).length,2);
 const replay=await importReviewedEmptyFinanceObservationBatch(f.client,actor,rows,scope);assert.equal(replay.body.created,0);assert.equal(replay.body.replayed,4);assert.equal(f.state.receipts.size,4);
 assert((await recoverReviewedEmptyFinanceObservationBatch(f.client,actor,rows,scope)).every(r=>r.knowledge==='KNOWN'));
 const firstReceipt=f.state.receipts.values().next().value!,originalFingerprint=firstReceipt.request_fingerprint;firstReceipt.request_fingerprint='f'.repeat(64);await assert.rejects(recoverReviewedEmptyFinanceObservationBatch(f.client,actor,rows,scope));assert.equal(f.state.receipts.size,4);firstReceipt.request_fingerprint=originalFingerprint;
 assert(!f.state.queries.some(q=>/\bINSERT INTO\b/.test(q.sql)&&/settlement_ledger_entry|finance_event|finance_opening_basis|wallet_coverage|withdrawal_intent/.test(q.sql)));
 assert(f.state.queries.some(q=>q.sql.includes('jsonb_populate_recordset(NULL::zzsh_order.personal_finance_observation_coverage')));
});

test('changed reviews, a foreign subject or an incompatible earnings cutoff fail before any empty coverage is written',async()=>{
 const f=fixture(),rows=inputs(),changed=reviews(rows);changed[1]!.resource.oid++;
 await assert.rejects(bindReviewedEmptyFinanceObservationBatch(f.client,actor,rows,changed));
 const scope=await bindReviewedEmptyFinanceObservationBatch(f.client,actor,rows,reviews(rows));f.state.badSource=true;await assert.rejects(importReviewedEmptyFinanceObservationBatch(f.client,actor,rows,scope));assert.equal(f.state.coverage.size,0);
 f.state.badSource=false;f.state.badCutoff=true;await assert.rejects(importReviewedEmptyFinanceObservationBatch(f.client,actor,rows,scope));assert.equal(f.state.coverage.size,0);
 const changedRows=structuredClone(rows);changedRows[0]!.coverage.legacyUserId='99';await assert.rejects(importReviewedEmptyFinanceObservationBatch(f.client,actor,changedRows,scope));
 await assert.rejects(bindReviewedEmptyFinanceObservationBatch(f.client,actor,Array(401).fill(rows[0]),Array(401).fill(reviews(rows)[0])));
});

test('an audit failure rolls the entire empty batch back; expired and recovery-only admissions cannot write',async()=>{
 const f=fixture(),rows=inputs(),scope=await bindReviewedEmptyFinanceObservationBatch(f.client,actor,rows,reviews(rows));f.state.failAudit=true;
 await assert.rejects(withTransaction(f.pool,c=>importReviewedEmptyFinanceObservationBatch(c,actor,rows,scope)),/FIXTURE_AUDIT_FAILED/);assert.equal(f.state.coverage.size,0);assert.equal(f.state.receipts.size,0);assert(f.state.queries.some(q=>q.sql==='ROLLBACK'));
 f.state.failAudit=false;f.state.now='2026-10-16T07:00:00.000Z';await assert.rejects(importReviewedEmptyFinanceObservationBatch(f.client,actor,rows,scope));
 const recovery=await bindReviewedEmptyFinanceObservationBatch(f.client,actor,rows,reviews(rows),'recover'),before=f.state.queries.length;
 assert((await recoverReviewedEmptyFinanceObservationBatch(f.client,actor,rows,recovery)).every(r=>r.knowledge==='UNKNOWN'));await assert.rejects(importReviewedEmptyFinanceObservationBatch(f.client,actor,rows,recovery));assert(!f.state.queries.slice(before).some(q=>/\b(?:INSERT|UPDATE|DELETE) INTO\b/.test(q.sql)));
});
