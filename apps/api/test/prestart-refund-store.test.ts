// SYNTHETIC_COMPONENT_MODEL：真实store/执行器与PG替身，不代表真实锁、渠道或到账。
import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash} from 'node:crypto';
import type {Pool,PoolClient} from 'pg';
import {hashApprovalPayload} from '../src/auth/approval-audit';
import * as liability from '../src/finance/prestart-refund-liability';
import * as profiles from '../src/order/joinpay-refund-profile';
import {createPrestartFormalRefundIntent,readPrestartRefundGate,readPrestartRefundProgress,allocatePrestartJoinpayRefunds,PrestartRefundAllocationUnknown} from '../src/order/prestart-refund-store';
import {executeJoinpayRefund} from '../src/order/joinpay-refund-attempt';
import * as store from '../src/order/channel-refund-store';

const fields={orderId:'order_1',renterUserId:'renter_1',ownerUserId:'owner_1',paymentConfirmationId:'pc_1',source:'JOINPAY' as const,
 merchantIdentityId:'merchant_1',merchantOrderNo:'ORIGINAL_1',channelTrxNo:'TRX_1',amountCents:'15908',currency:'CNY' as const};
const b={...fields,digest:hashApprovalPayload({schema:'prestart-payment-basis.v1',...fields}).hash};
const initial={kind:'FORMAL_NATIVE_REFUND_SERVER_REVIEW',reference:'component_reference',database:'component_db',runtimeUser:'component_r',
 merchantIdentityId:b.merchantIdentityId,merchantNo:'999900000000001',acceptedProfiles:[{operation:'SUBMIT',profileId:'component_profile',profileSha256:'a'.repeat(64),keyVersionRef:'component_key_reference'}]};
const canonical=JSON.stringify(initial),a={...initial,canonical,sha256:createHash('sha256').update(canonical).digest('hex')};
const p={merchantNo:a.merchantNo,profileId:'component_profile',profileSha256:'a'.repeat(64),keyVersionRef:'component_key_reference',notifyUrl:'https://component.invalid/refund',fundsAccount:undefined};
const term={id:'term_1',order_id:'order_1',state:'APPROVED',payment_basis:b,basis_digest:b.digest,approved_at:'2026-10-28T00:00:00.000000Z',liability_root_id:'root_1',liability_event_id:'event_1'};
const input={terminationId:term.id,idempotencyKey:'original_key',requestId:'request_1',admission:{} as profiles.FormalRefundAdmission,profile:{} as profiles.BoundRefundProfile};
function fixture(t:any){
 let original:any=null,transactions='1',allocated='0',requiresReview:boolean|null=null,rows:any[]=[];
 const calls:{sql:string;v:any[]}[]=[];
 t.mock.method(liability,'verifyPrestartRefundLiability',async()=>({}) as any);
 t.mock.method(profiles,'assertFormalRefundProfile',()=>a as any);t.mock.method(profiles,'describeRefundProfile',()=>p as any);
 t.mock.method(profiles,'readFormalRefundAdmission',()=>a as any);
 t.mock.method(profiles,'assertRefundStart',()=>{});t.mock.method(profiles,'assertRefundBinding',()=>{});
 t.mock.method(store,'assertRefundResource',async()=> '11');
 const c={query:async(sql:string,v:any[]=[])=>{calls.push({sql,v});
  if(['BEGIN','COMMIT','ROLLBACK'].includes(sql))return{rows:[]};
  if(sql.includes('FROM zzsh_order.prestart_termination'))return{rows:[term]};
  if(sql.startsWith('SELECT current_database()'))return{rows:[{db:a.database,actor:a.runtimeUser}]};
  if(sql.includes('to_regprocedure'))return{rows:[{ready:true}]};
  if(sql.startsWith('SELECT pg_advisory'))return{rows:[]};
  if(sql.startsWith('SELECT id FROM zzsh_auth_user'))return{rows:[{id:b.renterUserId}],rowCount:1};
  if(sql.includes('count(DISTINCT c.provider_transaction_id)'))return{rows:[{transactions,bound:true}]};
  if(sql.includes('count(DISTINCT provider_transaction_id)'))return{rows:[{transactions}]};
  if(sql.includes('COALESCE(sum(amount_cents)'))return{rows:[{allocated,requires_review:requiresReview}]};
  if(sql.includes('WHERE payment_confirmation_id=$1 AND idempotency_key=$2'))return{rows:original&&original.idempotency_key===v[1]?[original]:[]};
  if(sql.includes('FROM zzsh_order.channel_refund_intent i LEFT JOIN'))return{rows};
  if(sql.startsWith('INSERT INTO zzsh_order.channel_refund_intent')){
   original={id:v[0],order_id:v[1],payment_confirmation_id:v[2],renter_user_id:v[3],merchant_identity_id:v[4],original_payment_trx_no:v[5],original_payment_order_no:v[6],
    responsibility_version_hash:v[7],refund_order_no:v[8],amount_cents:v[9],idempotency_key:v[10],request_fingerprint:v[11],
    initial_admission_ref:v[13],initial_admission_sha256:v[14],initial_admission_canonical:v[15],wire_merchant_no:v[16],initial_profile_id:v[17],initial_profile_sha256:v[18],
    initial_key_version_ref:v[19],liability_root_id:v[22],liability_event_id:v[23],basis_kind:'PRESTART_TERMINATION',payment_source:'JOINPAY',posting_id:null,
    evidence_level:'JOINPAY_FORMAL',currency:'CNY',state:'READY',budget_disposition:'ALLOCATED',requires_review:false,lease_version:'0'};
   return{rows:[original],rowCount:1};}
  if(sql.includes('"zzsh_iam"."audit_event"'))return{rows:[],rowCount:1};
  throw Error('Unexpected synthetic SQL '+sql.slice(0,110));
 },release(){}} as unknown as PoolClient;
 return{c,calls,get original(){return original;},transactions(v:string){transactions=v;},budget(v:string,r:boolean|null=null){allocated=v;requiresReview=r;},rows(v:any[]){rows=v;}};
}

test('全额原笔分配由核准快照取得；无posting、客户端金额和目标',async t=>{
 const f=fixture(t),r=await createPrestartFormalRefundIntent(f.c,input);assert.equal(r.kind,'ALLOCATED');
 assert.equal(f.original.amount_cents,'15908');assert.equal(f.original.posting_id,null);assert.equal(f.original.basis_kind,'PRESTART_TERMINATION');
 assert.equal(f.original.original_payment_order_no,b.merchantOrderNo);assert.equal(f.calls.some(c=>/INSERT INTO zzsh_order.settlement_posting/.test(c.sql)),false);
 const funds=f.calls.findIndex(c=>c.sql.includes('refund-funds:v1')),number=f.calls.findIndex(c=>c.sql.includes('refund-order-no:v1')),user=f.calls.findIndex(c=>c.sql.includes('zzsh_auth_user'));
 assert(funds<number&&number<user);
});
test('新准入关闭后旧键仍恢复；原canonical/绑定改变不被升级',async t=>{
 const f=fixture(t);await createPrestartFormalRefundIntent(f.c,input);
 const r=await createPrestartFormalRefundIntent(f.c,{...input,admission:undefined,profile:undefined});assert.equal(r.kind,'REPLAYED');
 f.original.initial_admission_canonical+=' ';await assert.rejects(createPrestartFormalRefundIntent(f.c,input),(e:any)=>e.status===503);
});
test('同原号多trx、共同预算活跃或人工复核阻断新分配；释放后可新键且不重认负债',async t=>{
 const f=fixture(t);f.transactions('2');assert.equal((await createPrestartFormalRefundIntent(f.c,input)).kind,'REVIEW_REQUIRED');assert.equal(f.original,null);
 f.transactions('1');f.budget('15908');await assert.rejects(createPrestartFormalRefundIntent(f.c,input),(e:any)=>e.status===409);
 f.budget('0',true);await assert.rejects(createPrestartFormalRefundIntent(f.c,input),(e:any)=>e.status===409);
 f.budget('0');await createPrestartFormalRefundIntent(f.c,input);const released:any=f.original;released.state='FAILED';released.budget_disposition='RELEASED';
 assert.equal((await createPrestartFormalRefundIntent(f.c,{...input,idempotencyKey:'next_after_release'})).kind,'ALLOCATED');
 assert.equal(f.calls.some(c=>c.sql.startsWith('INSERT INTO zzsh_order.finance_')),false);
});
test('首派门禁重核新发现的同原号流水；未领lease、不取钥、不HTTP且保留原预算',async t=>{
 const f=fixture(t);await createPrestartFormalRefundIntent(f.c,input);f.transactions('2');
 assert.equal((await readPrestartRefundGate(f.c,f.original)).valid,false);
 t.mock.method(store,'lockFormalRefundContext',async()=>f.original);t.mock.method(store,'formalRefundBinding',()=>({}) as any);
 const q=f.c.query.bind(f.c);(f.c as any).query=async(sql:string,v:any[])=>sql.includes('to_regclass')?{rows:[{ready:true}]}:
  sql.includes('AS blocked')?{rows:[{blocked:false}]}:q(sql,v);
 let profilesRead=0,keys=0,http=0;
 const result=await executeJoinpayRefund({pool:{connect:async()=>f.c} as Pool,admission:input.admission,
  profileFor:()=>{profilesRead++;throw Error('not allowed');},keyFor:()=>{keys++;return 'SYNTHETIC_NEVER_READ';},fetch:async()=>{http++;throw Error('not allowed');}} as any,f.original.id,'worker_1');
 assert.equal(result,null);assert.deepEqual([profilesRead,keys,http],[0,0,0]);assert.equal(f.original.state,'READY');
 assert(f.calls.some(c=>c.v.includes('order.refund.prestart.first_submit.blocked')));
});
test('只读进度明确区分释放/未知/核销和保存证据；不调渠道、不把坏绑定补0',async t=>{
 const f=fixture(t);await createPrestartFormalRefundIntent(f.c,input);
 const row={...f.original,complete:true,dispatched:true,blocked_reason:null,updated_at:'2026-10-28T00:00:00.000000Z',saved_terminal:null,saved_trx:null,saved_completed_at:null,saved_at:null};
 for(const [state,disposition,consumed,remaining] of [['UNKNOWN','ALLOCATED','0','0'],['FAILED','RELEASED','0','15908'],['SUCCEEDED','CONSUMED','15908','0']]){
  f.rows([{...row,state,budget_disposition:disposition}]);const p=await readPrestartRefundProgress(f.c,term.id,b,true);
  assert.equal(p.totals?.consumedCents,consumed);assert.equal(p.totals?.remainingCents,remaining);assert.equal(p.bankArrival,'UNKNOWN');
 }
 f.rows([{...row,renter_user_id:'other'}]);const bad=await readPrestartRefundProgress(f.c,term.id,b,true);assert.equal(bad.integration,'UNAVAILABLE');assert.equal(bad.totals,null);assert.equal(bad.intents?.[0]?.amountCents,null);
 f.rows([row]);const owner=await readPrestartRefundProgress(f.c,term.id,b,false);assert.equal(owner.totals,null);assert.equal(owner.intents?.[0]?.refundOrderNo,null);
});
test('只读截断及多重活跃分配不给完整合计；原责任不按重试次数相乘',async t=>{
 const f=fixture(t);await createPrestartFormalRefundIntent(f.c,input);const row={...f.original,complete:true,dispatched:false};
 f.rows(Array.from({length:51},(_,n)=>({...row,id:`refund_${n}`})));const p=await readPrestartRefundProgress(f.c,term.id,b,true);assert.equal(p.truncated,true);assert.equal(p.totals,null);assert.equal(p.intents?.length,50);
});
test('无SUBMIT配置不扫描未开租责任，非法批量在连接前拒绝',async()=>{
 let connects=0;const o={pool:{connect:async()=>{connects++;throw Error('NO_IO');}}} as any;
 assert.deepEqual(await allocatePrestartJoinpayRefunds(o,1),{selected:0,allocated:0,replayed:0,skipped:0});
 await assert.rejects(allocatePrestartJoinpayRefunds(o,11));assert.equal(connects,0);
});
test('自动分配COMMIT未确认保留termination和固定原键，停止下一笔',async t=>{
 const f=fixture(t),query=f.c.query.bind(f.c);let count=0;
 (f.c as any).query=async(sql:string,v:any[])=>{
  if(sql.includes('to_regclass'))return{rows:[{ready:true}]};
  if(sql.startsWith('SELECT t.id FROM'))return{rows:[{id:'term_1'},{id:'term_2'}]};
  if(sql==='COMMIT')throw Error('SYNTHETIC_COMMIT_RESPONSE_LOST');return query(sql,v);};
 const o={pool:{connect:async()=>{count++;return f.c;}},admission:input.admission,initialProfile:input.profile} as any;
 await assert.rejects(allocatePrestartJoinpayRefunds(o,2),(e:any)=>e instanceof PrestartRefundAllocationUnknown&&e.terminationId==='term_1'&&e.idempotencyKey.startsWith('auto_prestart_'));
 assert.equal(count,2);
});
