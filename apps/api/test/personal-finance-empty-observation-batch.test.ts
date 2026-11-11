import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {withTransaction} from '../src/auth/security-core';
import {canonicalize} from '../src/supply/content-hash';
import {bindReviewedEmptyFinanceObservationBatch,importReviewedEmptyFinanceObservationBatch,recoverReviewedEmptyFinanceObservationBatch,importReviewedCompactEmptyFinanceObservationBatch,recoverReviewedCompactEmptyFinanceObservationBatch,compactEmptyFinanceBatchProof,planFinanceObservations,type ObservationImportInput,type ObservationImportReview} from '../src/finance/personal-finance-observation-maintenance';

const actor={userId:'fixture_boss',sessionId:'fixture_session',requestId:'fixture_request'},resource={host:'127.0.0.1' as const,port:55432 as const,database:'zzsh_test_order_empty',oid:42,owner:'fixture_owner',marker:'zzsh:order-reservation-test:v1',role:'fixture_owner',roleOid:43};
const nextResource={host:'127.0.0.1' as const,port:61690,database:'zzsh_test_regression',oid:42,owner:'zzsh',marker:'zzsh:regression-test:v1',role:'zzsh_regression_migration',roleOid:43,migrationProfile:'LOCAL_MIGRATION_NEXT_V1' as const,systemIdentifier:'123456',nonce:'a'.repeat(24)};
const sha=(value:unknown)=>createHash('sha256').update(canonicalize(value)).digest('hex');
function inputs():ObservationImportInput[]{return ['11','12'].flatMap(legacyUserId=>(['HISTORICAL_EARNINGS_LOG','HISTORICAL_PAYMENT'] as const).map(sourceKind=>({coverage:{userId:'fixture_'+legacyUserId,legacyUserId,sourceSystem:'legacy_mysql_restore',sourceKind,cutoff:'2026-10-01T00:00:00.000Z',inputSha256:'a'.repeat(64),identityDigest:'b'.repeat(64),sourceCount:0,imported:[],isolated:[]},observations:[]})));}
const reviews=(rows:ObservationImportInput[],selected:ObservationImportReview['resource']=resource):ObservationImportReview[]=>rows.map(input=>({ref:'FIXTURE_EMPTY_REVIEW',attempt:'fixture_attempt',actor:{userId:actor.userId,sessionId:actor.sessionId},resource:{...selected},notBefore:'2026-10-16T05:00:00.000Z',expiresAt:'2026-10-16T06:00:00.000Z',inputSha256:input.coverage.inputSha256,cutoff:input.coverage.cutoff,bodyDigest:sha(input),userId:input.coverage.userId,sourceKind:input.coverage.sourceKind}));
function fixture(selected:ObservationImportReview['resource']=resource){
 const state={now:'2026-10-16T05:30:00.000Z',badSource:false,badCutoff:false,failAudit:false,reverseRead:false,duplicateAudit:false,readOnly:false,transaction:true,extraObservation:false,queries:[] as {sql:string;args:any[]}[],coverage:new Map<string,any>(),audit:new Map<string,any>(),batchAudit:new Map<string,any[]>(),receipts:new Map<string,any>(),before:null as any};
 const client:any={connectionParameters:{host:selected.host,port:selected.port,database:selected.database,user:selected.role},getTransactionStatus:()=>state.transaction?'T':'I',release(){},query:async(sql:string,args:any[]=[])=>{
  state.queries.push({sql,args});
  if(sql==='BEGIN')state.before=structuredClone({coverage:state.coverage,audit:state.audit,batchAudit:state.batchAudit,receipts:state.receipts});
  if(sql==='ROLLBACK'&&state.before)Object.assign(state,state.before);
  if(sql.includes('finance-opening resource'))return{rows:[{...selected,tableOwner:selected.role,now:state.now}]};
  if(sql.includes('s."locked",u."twoFactorEnabled"'))return{rows:[{locked:false,twoFactorEnabled:true}],rowCount:1};
  if(sql.includes('admin_security'))return{rows:[{status:'ACTIVE',isBoss:true,passwordChangeRequired:false}],rowCount:1};
  if(sql.includes('SELECT suspended'))return{rows:[{suspended:false}],rowCount:1};
  if(sql.includes('finance history maintenance schema'))return{rows:[{ready:true,owner:selected.role}]};
  if(sql.includes('finance history source identity'))return{rows:[{}],rowCount:1};
  if(sql.includes('finance empty subject locks'))return{rows:args[0].map((id:string)=>({id})),rowCount:args[0].length};
  if(sql.includes('finance empty exact source identities'))return{rows:state.badSource?[{user_id:'fixture_12'}]:[],rowCount:state.badSource?1:0};
  if(sql.includes('finance empty single cutoff'))return{rows:[{differs:state.badCutoff}],rowCount:1};
  if(sql.includes('finance empty original receipts')){const rows=args[1].flatMap((key:string)=>state.receipts.has(key)?[state.receipts.get(key)]:[]);return{rows:state.reverseRead?rows.reverse():rows};}
  if(sql.includes('finance empty original coverage audit')){const rows=args[0].flatMap((id:string)=>state.coverage.has(id)?[{...state.coverage.get(id),actual_count:'0',...state.audit.get(id)}]:[]);if(state.duplicateAudit&&rows.length)rows.push({...rows[0]});return{rows:state.reverseRead?rows.reverse():rows};}
  if(sql.includes('finance empty coverage insert'))for(const row of JSON.parse(args[0]))state.coverage.set(row.id,row);
  if(sql.includes('finance empty original audit insert')){if(state.failAudit)throw Error('FIXTURE_AUDIT_FAILED');for(const row of JSON.parse(args[0]))state.audit.set(row.object_id,{actor_id:args[1],session_id:args[2],details:row.details});}
  if(sql.includes('finance empty original receipt insert'))for(const row of JSON.parse(args[0]))state.receipts.set(row.key,{key:row.key,request_fingerprint:row.fingerprint,response_status:200,response_body:row.body});
  if(sql.includes("current_setting('transaction_isolation')"))return{rows:[{isolation:'repeatable read',read_only:state.readOnly?'on':'off'}]};
  if(sql.includes('finance compact old receipts'))return{rows:args[1].flatMap((key:string)=>{const row=state.receipts.get(key);return row&&(!row.scope_key||row.scope_key===args[0])?[row]:[];})};
  if(sql.includes('finance compact old audits'))return{rows:args[0].filter((id:string)=>state.audit.has(id)).map((id:string)=>({object_id:id}))};
  if(sql.includes('finance compact coverage'))return{rows:args[0].flatMap((id:string)=>state.coverage.has(id)?[{...state.coverage.get(id),actual_count:state.extraObservation?'1':'0'}]:[])};
  if(sql.includes('finance compact batch audit'))return{rows:state.batchAudit.get(args[0])??[]};
  if(sql.includes('finance compact batch receipt')){const row=state.receipts.get(args[1]);return{rows:row&&row.scope_key===args[0]?[row]:[]};}
  if(sql.includes('AS "requestFingerprint"')&&sql.includes('idempotency_record')){const row=state.receipts.get(args[1]);return{rows:row&&row.scope_key===args[0]?[{requestFingerprint:row.request_fingerprint,responseStatus:row.response_status,responseBody:row.response_body,publishRequired:false}]:[]};}
  if(sql.includes('INSERT INTO "zzsh_iam"."audit_event"')){if(state.failAudit)throw Error('FIXTURE_AUDIT_FAILED');state.batchAudit.set(args[6],[{actor_id:args[2],session_id:args[3],request_id:args[8],details:JSON.parse(args[10])}]);}
  if(sql.includes('INSERT INTO "zzsh_supply"."idempotency_record"'))state.receipts.set(args[1],{scope_key:args[0],key:args[1],request_fingerprint:args[2],response_status:args[3],response_body:JSON.parse(args[4]),publish_required:args[5]});
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

test('full empty batch recovery matches shuffled results and still rejects missing receipts or duplicate audits',async()=>{
 const f=fixture(),sample=inputs()[0]!,rows=Array.from({length:400},(_,i)=>({...sample,coverage:{...sample.coverage,userId:'fixture_batch_'+i,legacyUserId:String(1000+i)}}));
 const scope=await bindReviewedEmptyFinanceObservationBatch(f.client,actor,rows,reviews(rows));
 assert.equal((await importReviewedEmptyFinanceObservationBatch(f.client,actor,rows,scope)).body.created,400);
 f.state.reverseRead=true;
 const recovered=await recoverReviewedEmptyFinanceObservationBatch(f.client,actor,rows,scope);
 assert.equal(recovered.length,400);assert(recovered.every(row=>row.knowledge==='KNOWN'));
 const [key,receipt]=f.state.receipts.entries().next().value!;f.state.receipts.delete(key);
 await assert.rejects(recoverReviewedEmptyFinanceObservationBatch(f.client,actor,rows,scope));
 f.state.receipts.set(key,receipt);f.state.duplicateAudit=true;
 await assert.rejects(recoverReviewedEmptyFinanceObservationBatch(f.client,actor,rows,scope));
});

test('next-round compact batch keeps each coverage but records and recovers only one exact batch receipt',async()=>{
 const f=fixture(nextResource),rows=inputs(),scope=await bindReviewedEmptyFinanceObservationBatch(f.client,actor,rows,reviews(rows,nextResource));
 const created=await importReviewedCompactEmptyFinanceObservationBatch(f.client,actor,rows,scope);
 assert.equal(created.body.created,4);assert.equal(f.state.coverage.size,4);assert.equal(f.state.audit.size,0);
 assert.equal(f.state.batchAudit.size,1);assert.equal(f.state.receipts.size,1);
 const replay=await importReviewedCompactEmptyFinanceObservationBatch(f.client,actor,rows,scope);
 assert.equal(replay.body.created,0);assert.equal(replay.body.replayed,4);assert.equal(replay.body.batchId,created.body.batchId);
 const reordered=[...rows].reverse(),reorderedScope=await bindReviewedEmptyFinanceObservationBatch(f.client,actor,reordered,reviews(reordered,nextResource));
 await assert.rejects(importReviewedCompactEmptyFinanceObservationBatch(f.client,actor,reordered,reorderedScope));
 const otherActor={userId:'fixture_other_admin',sessionId:'fixture_other_session',requestId:'fixture_other_request'};
 const otherReviews=reviews(rows,nextResource).map(review=>({...review,actor:{userId:otherActor.userId,sessionId:otherActor.sessionId}}));
 const otherScope=await bindReviewedEmptyFinanceObservationBatch(f.client,otherActor,rows,otherReviews);
 await assert.rejects(importReviewedCompactEmptyFinanceObservationBatch(f.client,otherActor,rows,otherScope));
 f.state.readOnly=true;
 const recovered=await recoverReviewedCompactEmptyFinanceObservationBatch(f.client,actor,rows,scope);
 assert.equal(recovered.knowledge,'KNOWN');assert.equal(recovered.batchId,created.body.batchId);
 assert.equal(recovered.receipt?.body.coverageCount,4);assert.equal(f.state.receipts.size,1);
 const changed=structuredClone(rows);changed[0]!.coverage.legacyUserId='99';
 await assert.rejects(recoverReviewedCompactEmptyFinanceObservationBatch(f.client,actor,changed,scope));
 f.state.extraObservation=true;await assert.rejects(recoverReviewedCompactEmptyFinanceObservationBatch(f.client,actor,rows,scope));
});

test('one compact batch preserves all five historical sources for the same subject',async()=>{
 const f=fixture(nextResource),sample=inputs()[0]!;
 const kinds=['HISTORICAL_EARNINGS_LOG','HISTORICAL_PAYMENT','HISTORICAL_REFUND','HISTORICAL_WITHDRAWAL','HISTORICAL_DISTRIBUTION'] as const;
 const rows=kinds.map(sourceKind=>({...sample,coverage:{...sample.coverage,sourceKind}}));
 const scope=await bindReviewedEmptyFinanceObservationBatch(f.client,actor,rows,reviews(rows,nextResource));
 const result=await importReviewedCompactEmptyFinanceObservationBatch(f.client,actor,rows,scope);
 assert.equal(result.body.created,5);assert.equal(f.state.coverage.size,5);
 assert.equal(f.state.batchAudit.size,1);assert.equal(f.state.receipts.size,1);
 f.state.readOnly=true;
 assert.equal((await recoverReviewedCompactEmptyFinanceObservationBatch(f.client,actor,rows,scope)).knowledge,'KNOWN');
});

test('compact recovery refuses partial or mixed evidence and never treats a missing batch receipt as success',async()=>{
 const f=fixture(nextResource),rows=inputs(),scope=await bindReviewedEmptyFinanceObservationBatch(f.client,actor,rows,reviews(rows,nextResource));
 f.state.readOnly=true;assert.equal((await recoverReviewedCompactEmptyFinanceObservationBatch(f.client,actor,rows,scope)).knowledge,'UNKNOWN');
 f.state.readOnly=false;const result=await importReviewedCompactEmptyFinanceObservationBatch(f.client,actor,rows,scope);
 const key=result.body.batchId,receipt=f.state.receipts.get(key),audit=f.state.batchAudit.get(key)!;
 f.state.readOnly=true;f.state.receipts.delete(key);await assert.rejects(recoverReviewedCompactEmptyFinanceObservationBatch(f.client,actor,rows,scope));
 f.state.receipts.set(key,receipt);receipt.publish_required=true;await assert.rejects(recoverReviewedCompactEmptyFinanceObservationBatch(f.client,actor,rows,scope));receipt.publish_required=false;
 audit.push({...audit[0]});await assert.rejects(recoverReviewedCompactEmptyFinanceObservationBatch(f.client,actor,rows,scope));audit.pop();
 const coverageKey=planFinanceObservations(rows[0]!).coverage.id,original=f.state.coverage.get(coverageKey);f.state.coverage.delete(coverageKey);
 await assert.rejects(recoverReviewedCompactEmptyFinanceObservationBatch(f.client,actor,rows,scope));f.state.coverage.set(coverageKey,original);
 const oldKey=planFinanceObservations(rows[0]!).key;f.state.receipts.set(oldKey,{key:oldKey});
 await assert.rejects(recoverReviewedCompactEmptyFinanceObservationBatch(f.client,actor,rows,scope));
});

test('compact mode requires a next-round target, an explicit transaction and read-only recovery',async()=>{
 const rows=inputs(),old=fixture(),oldScope=await bindReviewedEmptyFinanceObservationBatch(old.client,actor,rows,reviews(rows));
 await assert.rejects(importReviewedCompactEmptyFinanceObservationBatch(old.client,actor,rows,oldScope));
 const f=fixture(nextResource),scope=await bindReviewedEmptyFinanceObservationBatch(f.client,actor,rows,reviews(rows,nextResource));
 f.state.transaction=false;await assert.rejects(importReviewedCompactEmptyFinanceObservationBatch(f.client,actor,rows,scope));
 f.state.transaction=true;await assert.rejects(recoverReviewedCompactEmptyFinanceObservationBatch(f.client,actor,rows,scope));
 assert.equal(f.state.coverage.size,0);assert.equal(f.state.receipts.size,0);
});

test('compact batch proof binds the exact source, cutoff and target and rejects nonempty inputs',()=>{
 const rows=inputs(),review=reviews(rows,nextResource)[0]!,proof=compactEmptyFinanceBatchProof(rows,review,actor.requestId);
 assert.match(proof.batchId,/^history-empty-batch-[a-f0-9]{40}$/);
 assert.notEqual(compactEmptyFinanceBatchProof(rows,{...review,resource:{...nextResource,nonce:'c'.repeat(24)}},actor.requestId).batchId,proof.batchId);
 assert.throws(()=>compactEmptyFinanceBatchProof(rows,{...review,inputSha256:'f'.repeat(64)},actor.requestId));
 const nonempty=structuredClone(rows);nonempty[0]!.coverage.sourceCount=1;
 assert.throws(()=>compactEmptyFinanceBatchProof(nonempty,review,actor.requestId));
 assert.throws(()=>compactEmptyFinanceBatchProof([...rows,rows[0]!],review,actor.requestId));
});

test('compact batch audit failure rolls back all coverage and emits no receipt',async()=>{
 const f=fixture(nextResource),rows=inputs(),scope=await bindReviewedEmptyFinanceObservationBatch(f.client,actor,rows,reviews(rows,nextResource));
 f.state.failAudit=true;
 await assert.rejects(withTransaction(f.pool,c=>importReviewedCompactEmptyFinanceObservationBatch(c,actor,rows,scope)),/FIXTURE_AUDIT_FAILED/);
 assert.equal(f.state.coverage.size,0);assert.equal(f.state.batchAudit.size,0);assert.equal(f.state.receipts.size,0);
 assert(f.state.queries.some(q=>q.sql==='ROLLBACK'));
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
