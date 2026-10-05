import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import type {Pool,PoolClient} from 'pg';
import type {AppConfig} from '../src/config/config';
import {withTransaction} from '../src/auth/security-core';
import {confirmOrderPayment,createControlledPaymentSource} from '../src/order/payment-confirmation';
import type {PaymentDistributionStore} from '../src/finance/distribution-payment-store';

const input={orderId:'order',merchantOrderNo:'merchant',providerTransactionId:'transaction',amountCents:'100',currency:'CNY',providerPaidAt:'2026-10-04T00:00:00.000Z',requestId:'request'};
const config={profile:'test',provider:'fake',testOperationsEnabled:true,database:{target:'local-compose',host:'127.0.0.1',port:55432,name:'zzsh_test_order_seam',user:'zzsh_order_seam_r'}} as AppConfig;
const fact=()=>createControlledPaymentSource({config,resourceSet:'seam',appId:'app',merchantScopeId:'merchant_scope',allowedOrderIds:['order']})(input);
function probe({existing,review=false,auditFailure=false}:{existing?:Record<string,unknown>;review?:boolean;auditFailure?:boolean}={}){
 const seen:string[]=[];const c={release(){},query:async(sql:string)=>{seen.push(sql);
  if(sql.includes('current_database() AS db'))return{rows:[{db:config.database.name,actor:config.database.user}]};
  if(sql.includes('FROM zzsh_order.payment_confirmation'))return{rows:existing?[existing]:[]};
  if(sql.startsWith('SELECT account_id'))return{rows:[{account_id:'account',renter_user_id:'renter',owner_user_id:'owner'}]};
  if(sql.includes('WHERE id = ANY'))return{rows:[{id:'owner'},{id:'renter'}]};
  if(sql.startsWith('SELECT status, display_no'))return{rows:[{status:'PENDING_PAYMENT',display_no:'merchant',currency:'CNY',total:review?'101':'100',hold:'2026-10-05T00:00:00.000000Z'}]};
  if(sql.includes(' AS accepted,'))return{rows:[{accepted:'2026-10-04T00:00:00.000000Z',open:true}]};
  if(auditFailure&&sql.includes('INSERT INTO "zzsh_iam"."audit_event"'))throw Error('audit unavailable');
  return{rows:[],rowCount:1};
 }} as unknown as PoolClient;
 const pool={connect:async()=>c} as unknown as Pool;return{c,pool,seen};
}
function store(p:ReturnType<typeof probe>,options:{missing?:boolean;recordFailure?:boolean}={}){
 const prepared={orderId:'order'},calls:string[]=[];
 const value={prepare:async(c:PoolClient,id:string)=>{assert.equal(c,p.c);assert.equal(id,'order');calls.push('prepare');p.seen.push('PREPARE');return options.missing?null:prepared;},
  record:async(c:PoolClient,proof:unknown,confirmationId:string,requestId:string)=>{assert.equal(c,p.c);assert.equal(proof,prepared);assert(confirmationId.startsWith('payment_'));assert.equal(requestId,'request');calls.push('record');p.seen.push('RECORD');if(options.recordFailure)throw Error('basis unavailable');return{};},
  readOriginal:async(c:PoolClient,id:string,confirmationId:string)=>{assert.equal(c,p.c);assert.equal(id,'order');assert.equal(confirmationId,'original');calls.push('readOriginal');return{knowledge:'UNKNOWN',basis:null};}} as unknown as PaymentDistributionStore;
 return{value,calls};
}
const prior=(disposition='APPLIED')=>({id:'original',...input,disposition,reasonCode:disposition==='APPLIED'?null:'LATE_PAYMENT'});
test('existing callers and unverified capabilities keep original payment boundary',async()=>{
 const p=probe();assert.equal((await confirmOrderPayment(p.c,fact())).disposition,'APPLIED');assert(!p.seen.includes('PREPARE'));
 const bad=probe(),s=store(bad);await assert.rejects(confirmOrderPayment(bad.c,{...fact()},s.value),/not verified/);assert.equal(bad.seen.length,0);assert.equal(s.calls.length,0);
});
test('first APPLIED prepares after both advisory locks and before user locks, then records on the same client',async()=>{
 const p=probe(),s=store(p);const r=await confirmOrderPayment(p.c,fact(),s.value);assert.equal(r.disposition,'APPLIED');assert.deepEqual(s.calls,['prepare','record']);
 const prepare=p.seen.indexOf('PREPARE'),record=p.seen.indexOf('RECORD');assert.equal(p.seen.slice(0,prepare).filter(sql=>sql.includes('pg_advisory_xact_lock')).length,2);
 assert(prepare<p.seen.findIndex(sql=>sql.includes('WHERE id = ANY')));assert(record>p.seen.findIndex(sql=>sql.includes('INSERT INTO zzsh_order.im_order_group')));assert(record<p.seen.findIndex(sql=>sql.includes('INSERT INTO "zzsh_iam"."audit_event"')));
});
test('replay reads only original APPLIED basis, while REVIEW_REQUIRED retains its original result',async()=>{
 for(const disposition of ['APPLIED','REVIEW_REQUIRED']){const p=probe({existing:prior(disposition)}),s=store(p),r=await confirmOrderPayment(p.c,fact(),s.value);assert.equal(r.replay,true);assert.equal(r.disposition,disposition);assert.deepEqual(s.calls,disposition==='APPLIED'?['readOriginal']:[]);assert(!p.seen.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql)));}
});
test('conflicting original transaction retains conflict audit without touching distribution',async()=>{
 const p=probe({existing:{...prior(),amountCents:'99'}}),s=store(p),r=await confirmOrderPayment(p.c,fact(),s.value);assert.equal(r.disposition,'CONFLICT');assert.deepEqual(s.calls,[]);assert(p.seen.some(sql=>sql.includes('INSERT INTO "zzsh_iam"."audit_event"')));
});
test('explicit composition cannot fall back to plain payment when preparation is unavailable',async()=>{
 const p=probe(),s=store(p,{missing:true});await assert.rejects(confirmOrderPayment(p.c,fact(),s.value),e=>(e as {status?:number}).status===503);assert.deepEqual(s.calls,['prepare']);assert(!p.seen.some(sql=>/^(INSERT|UPDATE|DELETE)/.test(sql)));
});
test('first REVIEW_REQUIRED never records an earning basis',async()=>{
 const p=probe({review:true}),s=store(p),r=await confirmOrderPayment(p.c,fact(),s.value);assert.equal(r.disposition,'REVIEW_REQUIRED');assert.deepEqual(s.calls,['prepare']);assert(!p.seen.some(sql=>sql.includes('INSERT INTO zzsh_order.im_order_group')));
});
test('record and audit failures escape to the transaction owner and request rollback, never commit',async()=>{
 for(const auditFailure of [false,true]){const p=probe({auditFailure}),s=store(p,{recordFailure:!auditFailure});await assert.rejects(withTransaction(p.pool,c=>confirmOrderPayment(c,fact(),s.value)),/unavailable/);assert.equal(p.seen.at(-1),'ROLLBACK');assert(!p.seen.includes('COMMIT'));assert(s.calls.includes('record'));}
});
