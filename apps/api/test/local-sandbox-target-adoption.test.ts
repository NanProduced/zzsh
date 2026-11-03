import assert from 'node:assert/strict';
import {test} from 'node:test';
import type {Pool,PoolClient} from 'pg';
import {createHash} from 'node:crypto';
import {canonicalize} from '../src/supply/content-hash';
import {declareLocalSandboxWithdrawalTarget,readLocalSandboxWithdrawalTargetReceipt,LocalSandboxTargetCommitUnknown} from '../src/finance/local-sandbox-withdrawal-target';
import {readAdoptedLocalPayment} from '../src/finance/local-sandbox-adoption-read';
import {sandboxFixture,sandboxClient,restoreDocument} from './local-financial-sandbox-fixture';
import {localFinancialSandboxRegistration} from '../src/finance/local-financial-sandbox-resource';
const actor={userId:'user_fixture',sessionId:'session_fixture',requestId:'request_fixture'},input={bankBindingId:'bank_'+'a'.repeat(32),bankBindingRevision:'1',amountCents:'200'};
function targetFixture(){
 const sandbox=sandboxFixture(),base=sandboxClient(sandbox),p=localFinancialSandboxRegistration(sandbox),seen:string[]=[];
 let state={admissions:new Map<string,any>(),targets:new Map<string,any>(),idem:new Map<string,any>(),audits:[] as any[]},before:typeof state|undefined;
 const controls={revision:'1',mask:'**** **** 1234',frozen:false,failAudit:false,commitUnknown:false};
 const one=(row?:unknown)=>({rows:row?[row]:[],rowCount:row?1:0});
 const query=async(sql:string,v:any[]=[]):Promise<any>=>{
  seen.push(sql);
  if(sql==='BEGIN'){before=structuredClone(state);return one();}
  if(sql==='ROLLBACK'){if(before)state=before;return one();}
  if(sql==='COMMIT'){before=undefined;if(controls.commitUnknown)throw Error('synthetic commit ACK lost');return one();}
  if(sql.startsWith('SET TRANSACTION')||sql==='SET CONSTRAINTS ALL IMMEDIATE'||sql.startsWith('SELECT pg_advisory_xact_lock')||sql.startsWith('SELECT set_config'))return one();
  if(sql.startsWith('SELECT "suspended"'))return one({suspended:controls.frozen});
  if(sql.includes('FROM "zzsh_iam"."user_identity_state"'))return one({accountStatus:controls.frozen?'FROZEN':'ACTIVE'});
  if(sql.includes('FROM "zzsh_auth_user"."session"'))return v[0]===actor.sessionId&&v[1]===actor.userId?one({ok:1}):one();
  if(sql.startsWith('SELECT current_database() AS database,current_user AS runtime_user'))return one({database:p.registration.resource.database,runtime_user:p.registration.resource.runtimeRole,ready:true});
  if(sql.includes('FROM zzsh_order.withdrawal_bank_binding WHERE user_id=$1'))return v[0]===actor.userId?one({id:input.bankBindingId,user_id:actor.userId,revision:controls.revision,card_mask:controls.mask,holder_mask:'测**',updated_at:'2026-11-02T10:00:00.000000Z'}):one();
  if(sql.includes('FROM "zzsh_supply"."idempotency_record"'))return one(state.idem.get(v[0]+'|'+v[1]));
  if(sql.startsWith('SELECT response_body AS body')){const found=state.idem.get(v[0]+'|'+v[1]);return found?one({body:found.responseBody}):one();}
  if(sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"')){state.idem.set(v[0]+'|'+v[1],{requestFingerprint:v[2],responseStatus:v[3],responseBody:JSON.parse(v[4]),publishRequired:false});return one();}
  if(sql.startsWith("SELECT to_char(date_trunc('milliseconds',clock_timestamp())"))return one({at:'2026-11-02T15:59:00.000Z'});
  if(sql.startsWith('INSERT INTO zzsh_order.withdrawal_admission')){state.admissions.set(v[0],{id:v[0],userId:v[1],oid:v[2],name:v[3],marker:v[4],amount:v[5],expiresAt:v[7],admin:v[8],reference:v[9]});return one();}
  if(sql.startsWith('INSERT INTO zzsh_order.withdrawal_destination')){state.targets.set(v[0],{id:v[0],userId:v[1],admissionId:v[2],mask:v[3],reference:v[4],bankId:v[5],revision:v[6]});return one();}
  if(sql.startsWith('SELECT d.id FROM zzsh_order.withdrawal_destination')){const d=state.targets.get(v[0]),a=d&&state.admissions.get(d.admissionId);return d&&a&&d.userId===v[1]&&d.reference===v[2]&&a.reference===v[2]&&a.oid===v[3]&&a.name===v[4]&&a.marker===v[5]?one({id:d.id}):one();}
  if(sql.includes('INSERT INTO "zzsh_iam"."audit_event"')){if(controls.failAudit)throw Error('synthetic audit unavailable');state.audits.push(v);return one();}
  return base.query(sql,v);
 };
 const c={query,release(){}} as unknown as PoolClient,pool={connect:async()=>c} as unknown as Pool;
 return{sandbox,controls,seen,pool,state:()=>state};
}

test('actual target service freezes only own stored masked binding and old-key replay cannot redirect or extend its declaration',async()=>{
 const f=targetFixture(),accepted=await declareLocalSandboxWithdrawalTarget(f.pool,actor,input,'target-fixture-key',f.sandbox),body=accepted.body as any;
 assert.equal(body.identityMeaning,'EXPLICIT_LOCAL_TEST_ADMISSION_NOT_REAL_KYC');assert.equal(body.reservationState,'REQUIRES_CURRENT_QUOTE');assert.equal(body.target.expiresAt,'2026-11-02T16:00:00.000Z');
 assert(!f.seen.some(sql=>sql.includes('sealed_details')||sql.startsWith('INSERT INTO zzsh_order.withdrawal_intent')||sql.includes('INSERT INTO zzsh_order.finance_event')));
 f.controls.revision='2';f.controls.mask='**** **** 9999';const replay=await declareLocalSandboxWithdrawalTarget(f.pool,actor,input,'target-fixture-key',f.sandbox);
 assert.equal(replay.replayed,true);assert.equal(JSON.stringify(replay.body)===JSON.stringify(accepted.body),true);assert.equal(f.state().targets.size,1);
 await assert.rejects(declareLocalSandboxWithdrawalTarget(f.pool,actor,{...input,amountCents:'201'},'target-fixture-key',f.sandbox));
 await assert.rejects(declareLocalSandboxWithdrawalTarget(f.pool,actor,input,'target-new-key',f.sandbox));
 const start=f.seen.length,found=await readLocalSandboxWithdrawalTargetReceipt(f.pool,actor,'target-fixture-key',f.sandbox);assert.equal(found.knowledge,'KNOWN');
 assert(!f.seen.slice(start).some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql)||sql.includes('FOR UPDATE')));
 f.state().targets.clear();await assert.rejects(readLocalSandboxWithdrawalTargetReceipt(f.pool,actor,'target-fixture-key',f.sandbox));
});

test('invalid/cross identity/frozen target and audit errors never leave a target; lost COMMIT ACK only permits original-key recovery',async()=>{
 for(const body of [{...input,amountCents:'199'},{...input,amountCents:'1.00'},{...input,outcome:'SUCCEEDED'}]){
  const f=targetFixture();await assert.rejects(declareLocalSandboxWithdrawalTarget(f.pool,actor,body,'target-fixture-key',f.sandbox));assert.equal(f.state().targets.size,0);
 }
 const other=targetFixture();await assert.rejects(declareLocalSandboxWithdrawalTarget(other.pool,{...actor,userId:'other_fixture'},input,'target-fixture-key',other.sandbox));assert.equal(other.state().targets.size,0);
 const frozen=targetFixture();frozen.controls.frozen=true;await assert.rejects(declareLocalSandboxWithdrawalTarget(frozen.pool,actor,input,'target-fixture-key',frozen.sandbox));assert.equal(frozen.state().targets.size,0);
 const audit=targetFixture();audit.controls.failAudit=true;await assert.rejects(declareLocalSandboxWithdrawalTarget(audit.pool,actor,input,'target-fixture-key',audit.sandbox));assert.equal(audit.state().targets.size,0);assert.equal(audit.state().admissions.size,0);assert.equal(audit.state().idem.size,0);
 const unknown=targetFixture();unknown.controls.commitUnknown=true;
 await assert.rejects(declareLocalSandboxWithdrawalTarget(unknown.pool,actor,input,'target-fixture-key',unknown.sandbox),e=>e instanceof LocalSandboxTargetCommitUnknown&&e.originalKey==='target-fixture-key');
 unknown.controls.commitUnknown=false;assert.equal((await readLocalSandboxWithdrawalTargetReceipt(unknown.pool,actor,'target-fixture-key',unknown.sandbox)).knowledge,'KNOWN');assert.equal(unknown.state().targets.size,1);
});

test('restored original payment is read-only, exact source/digest bound, missing acceptance UNKNOWN and cannot mint a new fact',async()=>{
 const sandbox=sandboxFixture(),base=sandboxClient(sandbox),seen:string[]=[],original={orderId:'old_order',merchantOrderNo:'OLD_NO',providerTransactionId:'old_trx',amountCents:'200',currency:'CNY',providerPaidAt:'2026-10-01T00:00:00.000Z',requestId:'old_request'};
 const canonical=canonicalize(original),sha=createHash('sha256').update(canonical).digest('hex');let accepted=false,foreignOid=false,badDigest=false;
 const c={query:async(sql:string,v:any[]=[]):Promise<any>=>{
  seen.push(sql);if(sql==='BEGIN'||sql==='COMMIT'||sql==='ROLLBACK'||sql.startsWith('SET TRANSACTION')||sql.startsWith('SELECT set_config'))return{rows:[]};
  if(sql.startsWith('SELECT "suspended"'))return{rows:[{suspended:false}]};if(sql.includes('FROM "zzsh_iam"."user_identity_state"'))return{rows:[{accountStatus:'ACTIVE'}]};if(sql.includes('FROM "zzsh_auth_user"."session"'))return{rows:[{}],rowCount:1};
  if(sql.startsWith('SELECT id FROM zzsh_order.rental_order'))return{rows:v[1]===actor.userId?[{id:'old_order'}]:[]};
  if(sql.startsWith('SELECT d.id,d.mode'))return{rows:[{id:'old_declaration',mode:'LOCAL_CONTROLLED_DECLARED_PAYMENT',resource_oid:foreignOid?'1141209':restoreDocument.source.oid,app_id:'old_app',merchant_scope_id:'old_merchant',admission_id:'old_admission',admission_revision:'1',
   merchant_order_no:original.merchantOrderNo,provider_transaction_id:original.providerTransactionId,canonical_payment:canonical,payment_digest:badDigest?'0'.repeat(64):sha,approval_digest:'a'.repeat(64),admission_mode:'LOCAL_CONTROLLED',resource_name:'zzsh_test_regression',resource_marker:'zzsh:regression-test:v1',admission_resource_oid:'2220718',admission_digest:'a'.repeat(64),current_admission_revision:'1'}]};
  if(sql.startsWith('SELECT p.id,p.disposition'))return{rows:accepted?[{id:'old_confirmation',order_id:'old_order',merchant_scope_id:'old_merchant',provider_transaction_id:original.providerTransactionId,merchant_order_no:original.merchantOrderNo,amount_cents:'200',currency:'CNY',provider_paid_at:original.providerPaidAt,request_id:original.requestId,
   disposition:'APPLIED',reason_code:null,paid_confirmation_id:'old_confirmation',original_audit_complete:true,original_group_complete:true,accepted_at:'2026-10-01T00:01:00.000000Z'}]:[]};
  return base.query(sql,v);
 },release(){}} as unknown as PoolClient,pool={connect:async()=>c} as unknown as Pool;
 const missing=await readAdoptedLocalPayment(pool,actor,'old_order',sandbox);assert.equal(missing.knowledge,'UNKNOWN');assert.equal(missing.mayReapply,false);
 accepted=true;const found=await readAdoptedLocalPayment(pool,actor,'old_order',sandbox);assert.equal(found.knowledge,'KNOWN');assert.equal(found.adoption,'ADOPTED_READ_ONLY');assert.equal(Object.hasOwn(found,'fact'),false);assert.equal(found.bankArrival,'UNKNOWN');
 foreignOid=true;await assert.rejects(readAdoptedLocalPayment(pool,actor,'old_order',sandbox));foreignOid=false;badDigest=true;await assert.rejects(readAdoptedLocalPayment(pool,actor,'old_order',sandbox));
 assert(!seen.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql)||sql.includes('FOR UPDATE')));
});
