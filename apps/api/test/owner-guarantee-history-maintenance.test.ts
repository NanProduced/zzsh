import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {canonicalize} from '../src/supply/content-hash';
import {bindReviewedOwnerGuaranteeHistory,importReviewedOwnerGuaranteeHistory,recoverReviewedOwnerGuaranteeHistory,type GuaranteeHistoryReview} from '../src/finance/owner-guarantee-history-maintenance';
import {planOwnerGuaranteeHistoryBatch,type OwnerGuaranteeHistoryBatch} from '../src/finance/owner-guarantee-history';
const sha=(v:unknown)=>createHash('sha256').update(canonicalize(v)).digest('hex'),actor={userId:'fixture-boss',sessionId:'fixture-session',requestId:'fixture-request'};
function fixture(zero=false){
 const input:OwnerGuaranteeHistoryBatch={userId:'fixture-owner',legacyUserId:'11',identityDigest:'a'.repeat(64),inputSha256:'b'.repeat(64),cutoff:'2026-09-13T13:31:22.000Z',sourceCount:zero?0:1,rows:zero?[]:[{userId:'fixture-owner',legacyUserId:'11',accountId:'fixture-account',source:{id:'101',user_id:'11',no:'FIXTURE',pay_money:'0.00',pay_is:'0',pay_time:null,return_is:null},payOrders:[{id:'501',order_id:'101',order_type:'2',pay_money:'5.00',pay_is:'1',create_time:'1779469700',pay_time:'1779469800',pay_order_sn:'FIXTURE-MERCHANT'}]}],isolated:[]};
 const resource={host:'127.0.0.1' as const,port:55432 as const,database:'zzsh_test_order_guar_fixture',oid:42,owner:'fixture_owner',marker:'zzsh:order-reservation-test:v1',role:'fixture_owner',roleOid:43};
 const review:GuaranteeHistoryReview={ref:'FIXTURE-NOT-APPROVAL',attempt:'fixture-1',actor:{userId:actor.userId,sessionId:actor.sessionId},resource,notBefore:'2026-10-15T08:00:00.000Z',expiresAt:'2026-10-15T09:00:00.000Z',userId:input.userId,inputSha256:input.inputSha256,bodyDigest:sha(input),cutoff:input.cutoff,sourceCount:input.sourceCount};
 const state={queries:[] as {sql:string;args:any[]}[],identity:true,mapped:true,receipt:null as any,coverage:null as any,observations:[] as any[],audit:false,badRow:false};
 const query=async(sql:string,args:any[]=[])=>{state.queries.push({sql,args});
  if(sql.includes('finance-opening resource'))return{rows:[{...resource,now:'2026-10-15T08:30:00.000Z',tableOwner:resource.role}],rowCount:1};
  if(sql.includes('s."locked",u."twoFactorEnabled"'))return{rows:state.identity?[{locked:false,twoFactorEnabled:true}]:[],rowCount:state.identity?1:0};
  if(sql.includes('admin_security'))return{rows:[{status:'ACTIVE',isBoss:true,passwordChangeRequired:false}],rowCount:1};
  if(sql.includes('SELECT suspended'))return{rows:[{suspended:false}],rowCount:1};
  if(sql.includes('owner guarantee maintenance schema'))return{rows:[{ready:true,owner:resource.role}],rowCount:1};
  if(sql.includes('guarantee history source identity')||sql.includes('FROM zzsh_supply.legacy_supply_map'))return{rows:state.mapped?[{}]:[],rowCount:state.mapped?1:0};
  if(sql.includes('"requestFingerprint"'))return{rows:state.receipt?[{requestFingerprint:state.receipt.fingerprint,responseStatus:state.receipt.status,responseBody:state.receipt.body,publishRequired:false}]:[],rowCount:state.receipt?1:0};
  if(sql.includes('request_fingerprint AS fingerprint'))return{rows:state.receipt?[state.receipt]:[],rowCount:state.receipt?1:0};
  if(sql.includes('INSERT INTO zzsh_order.legacy_owner_guarantee_observation'))state.observations.push({id:args[4],digest:args[9],canonical:args[8]});
  if(sql.includes('INSERT INTO zzsh_order.legacy_owner_guarantee_coverage'))state.coverage={body_digest:args[12]};
  if(sql.includes('INSERT INTO "zzsh_iam"."audit_event"'))state.audit=true;
  if(sql.includes('INSERT INTO "zzsh_supply"."idempotency_record"'))state.receipt={fingerprint:args[2],status:args[3],body:JSON.parse(args[4])};
  if(sql.includes('SELECT body_digest FROM zzsh_order.legacy_owner_guarantee_coverage'))return{rows:state.coverage?[state.coverage]:[],rowCount:state.coverage?1:0};
  if(sql.startsWith('SELECT legacy_account_id AS id'))return{rows:state.observations.map(r=>state.badRow?{...r,digest:'f'.repeat(64)}:r),rowCount:state.observations.length};
  if(sql.startsWith('SELECT 1 FROM zzsh_iam.audit_event'))return{rows:state.audit?[{}]:[],rowCount:state.audit?1:0};
  return{rows:[],rowCount:1};
 };
 return{input,review,state,c:{query,connectionParameters:{host:resource.host,port:resource.port,database:resource.database,user:resource.role}} as any};
}
test('actual guarantee history importer records only observations/coverage/audit, retaining paid-vs-reset facts and original receipt',async()=>{
 const f=fixture(),s=await bindReviewedOwnerGuaranteeHistory(f.c,actor,f.review),r=await importReviewedOwnerGuaranteeHistory(f.c,actor,f.input,s);
 assert.equal((r.body as Record<string,unknown>).financialEffect,'NONE');assert.equal(f.state.observations.length,1);assert.equal(planOwnerGuaranteeHistoryBatch(f.input).rows[0]!.paidRecordCents,'500');
 const writes=f.state.queries.filter(q=>/^INSERT|^UPDATE|^DELETE/.test(q.sql));assert(!writes.some(q=>/settlement_ledger_entry|finance_event|wallet_coverage|owner_guarantee_requirement|owner_guarantee_payment|owner_guarantee_refund/.test(q.sql)));
 const count=writes.length;await importReviewedOwnerGuaranteeHistory(f.c,actor,f.input,s);assert.equal(f.state.queries.filter(q=>/^INSERT|^UPDATE|^DELETE/.test(q.sql)).length,count);
 const recovered=await recoverReviewedOwnerGuaranteeHistory(f.c,actor,f.input,s);assert.equal(recovered.knowledge,'KNOWN');assert.equal(recovered.financialEffect,'NONE');
 f.state.badRow=true;await assert.rejects(recoverReviewedOwnerGuaranteeHistory(f.c,actor,f.input,s),(e:any)=>e.status===409);
});
test('proved zero source universe keeps its coverage; missing receipt and changed binding never initialize funds or replay',async()=>{
 const f=fixture(true),s=await bindReviewedOwnerGuaranteeHistory(f.c,actor,f.review);assert.equal((await recoverReviewedOwnerGuaranteeHistory(f.c,actor,f.input,s)).knowledge,'UNKNOWN');assert.equal(f.state.queries.filter(q=>/^INSERT/.test(q.sql)).length,0);
 await importReviewedOwnerGuaranteeHistory(f.c,actor,f.input,s);assert.equal(f.state.observations.length,0);assert(f.state.coverage);assert.equal((await recoverReviewedOwnerGuaranteeHistory(f.c,actor,f.input,s)).knowledge,'KNOWN');
 await assert.rejects(importReviewedOwnerGuaranteeHistory(f.c,actor,f.input,{...s}));f.state.identity=false;await assert.rejects(recoverReviewedOwnerGuaranteeHistory(f.c,actor,f.input,s),(e:any)=>e.status===401);
});
test('exact subject, canonical body, source mapping and recovery-only admission reject before observation writes',async()=>{
 for(const change of ['body','mapping','recover'] as const){const f=fixture(),s=await bindReviewedOwnerGuaranteeHistory(f.c,actor,f.review,change==='recover'?'recover':'execute');if(change==='body')f.input.rows[0]!.payOrders[0]!.pay_money='6.00';if(change==='mapping')f.state.mapped=false;await assert.rejects(importReviewedOwnerGuaranteeHistory(f.c,actor,f.input,s));assert.equal(f.state.observations.length,0);}
});
