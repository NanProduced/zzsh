// SYNTHETIC_COMPONENT_MODEL：执行真实领域函数；PG、锁、正式原款与渠道均未运行。
import assert from "node:assert/strict";
import test from "node:test";
import type { PoolClient } from "pg";
import { hashApprovalPayload } from "../src/auth/approval-audit";
import * as userIdentity from "../src/auth/user-identity";
import * as adminIdentity from "../src/auth/auth-security";
import * as adminAccess from "../src/auth/admin-authorization";
import * as settlement from "../src/order/settlement-record";
import * as liability from "../src/finance/prestart-refund-liability";
import { readPrestartTermination, requestPrestartTermination, reviewPrestartTermination, type PrestartPaymentBasis } from "../src/order/prestart-termination";

const renter={realm:"user" as const,userId:"renter",sessionId:"sr"},owner={realm:"user" as const,userId:"owner",sessionId:"so"};
const support={realm:"admin" as const,userId:"staff",sessionId:"sa"};
const source={orderId:"order_1",renterUserId:"renter",ownerUserId:"owner",paymentConfirmationId:"pc_1",source:"JOINPAY" as const,
  merchantIdentityId:"merchant_1",merchantOrderNo:"ORIGINAL_1",channelTrxNo:"TRX_1",amountCents:"15908",currency:"CNY" as const};
const basis:PrestartPaymentBasis={...source,digest:hashApprovalPayload({schema:"prestart-payment-basis.v1",...source}).hash};
function fixture(t:any,patch:Record<string,unknown>={}){
 const calls:{sql:string;values:any[]}[]=[],recognized:any[]=[];
 let row:any=null;
 const facts={id:"order_1",renter_user_id:"renter",owner_user_id:"owner",revision:"1",status:"PAID",order_cents:"15908",
  paid_confirmation_id:"pc_1",confirmation_id:"pc_1",payment_source:"JOINPAY",disposition:"APPLIED",currency:"CNY",amount_cents:"15908",
  merchant_identity_id:"merchant_1",merchant_order_no:"ORIGINAL_1",channel_trx_no:"TRX_1",opening_confirmed:false,has_posting:false,pending_adjustment:false,earning_count:"0",...patch};
 const client={query:async(sql:string,values:any[]=[])=>{calls.push({sql,values});
  if(sql.includes('to_regclass'))return{rows:[{ready:true}]};
  if(sql.startsWith('SELECT id FROM zzsh_order.rental_order WHERE'))return{rows:[],rowCount:["renter","owner"].includes(values[1])?1:0};
  if(sql.includes('FROM zzsh_order.rental_order o LEFT JOIN'))return{rows:[facts]};
  if(sql.startsWith('SELECT id,order_id,requested_by'))return{rows:row?[row]:[]};
  if(sql.startsWith('INSERT INTO zzsh_order.prestart_termination\n')){row={id:values[0],order_id:values[1],requested_by_user_id:values[2],requested_by_party:values[3],reason:values[4],
   basis_digest:values[5],payment_basis:JSON.parse(values[6]),state:'REQUESTED',revision:'1',created_at:'2026-10-28T00:00:00.000000Z',updated_at:'2026-10-28T00:00:00.000000Z',
   approved_at:null,liability_root_id:null,liability_event_id:null,last_reason:null};return{rows:[row],rowCount:1};}
  if(sql.startsWith('UPDATE zzsh_order.prestart_termination SET state=')){row={...row,state:values[1],revision:(BigInt(row.revision)+1n).toString(),last_reason:values[2],approved_at:values[1]==='APPROVED'?'2026-10-28T00:00:01.000000Z':null};return{rows:[row],rowCount:1};}
  if(sql.startsWith('UPDATE zzsh_order.prestart_termination SET liability_root')){row.liability_root_id=values[1];row.liability_event_id=values[2];return{rows:[],rowCount:1};}
  if(sql.startsWith('UPDATE zzsh_order.rental_order SET status=')){facts.status='CANCELLED';return{rows:[],rowCount:1};}
  if(sql.includes('INSERT INTO "zzsh_iam"."audit_event"')||sql.startsWith('INSERT INTO zzsh_order.prestart_termination_decision'))return{rows:[],rowCount:1};
  throw Error('Unexpected synthetic SQL: '+sql.slice(0,100));
 }} as unknown as PoolClient;
 t.mock.method(settlement,'lockSettlement',async(c:unknown,id:string,a:any,mode:unknown)=>{assert.equal(c,client);assert.equal(id,'order_1');assert.equal(mode,'PRESTART_TERMINATION');
  if(a.realm==='user'&&!["renter","owner"].includes(a.userId))throw Object.assign(Error('denied'),{status:404});return facts as any;});
 t.mock.method(userIdentity,'assertUserContextInTransaction',async(_c:unknown,_a:unknown,mode:unknown)=>{assert.equal(mode,'READ');});
 t.mock.method(adminIdentity,'assertAdminContextInTransaction',async()=>{});
 t.mock.method(adminAccess,'loadEffectiveAdminAccess',async()=>({status:'ACTIVE',isBoss:true,permissions:new Set(['order.read','finance.read'])}) as any);
 t.mock.method(liability,'recognizePrestartRefundLiability',async(_c:unknown,id:string,b:unknown)=>{recognized.push(b);return{rootId:'root_1',eventId:'event_1'} as any;});
 t.mock.method(liability,'verifyPrestartRefundLiability',async()=>({} as any));
 return{client,calls,recognized,facts,get row(){return row;},seed(){row={id:'pterm_1',order_id:'order_1',requested_by_user_id:'renter',requested_by_party:'RENTER',reason:'申请未开租结束',
  state:'REQUESTED',revision:'1',basis_digest:basis.digest,payment_basis:basis,created_at:'2026-10-28T00:00:00.000000Z',updated_at:'2026-10-28T00:00:00.000000Z',approved_at:null,
  liability_root_id:null,liability_event_id:null,last_reason:null};}};
}
const request={orderId:'order_1',expectedOrderRevision:'1',reason:'双方尚未正式开租',requestId:'req_1'};
const review={orderId:'order_1',terminationId:'pterm_1',expectedRevision:'1',decision:'APPROVE',assessment:'NO_USE_NO_DISPUTE',reason:'已核实无使用和费用争议',requestId:'req_2'};

test('本人租客/号主可申请；号主不取得租客原款金额，申请不记钱/改订单状态',async t=>{
 for(const actor of [renter,owner]){const h=fixture(t),r=await requestPrestartTermination(h.client,actor,request);
  assert.equal(r.status,200);assert.equal(r.body.request?.fullRefundCents,actor===renter?'15908':null);
  assert.equal(h.facts.status,'PAID');assert.equal(h.recognized.length,0);assert.equal(h.calls.some(c=>c.sql.includes('INSERT INTO zzsh_order.finance_')),false);}
});
test('他人和未付款/已开租/已有过账/争议调整/分佣阻断，不创建终止请求',async t=>{
 const h=fixture(t);await assert.rejects(requestPrestartTermination(h.client,{...renter,userId:'other'},request),(e:any)=>e.status===404);
 for(const p of [{status:'PENDING_PAYMENT'},{opening_confirmed:true},{has_posting:true},{pending_adjustment:true},{earning_count:'1'}]){
  const f=fixture(t,p);await assert.rejects(requestPrestartTermination(f.client,renter,request),(e:any)=>e.status===409);assert.equal(f.row,null);}
});
test('重复申请回原当前请求，过期订单revision不能产生新对象',async t=>{
 const h=fixture(t);h.seed();const r=await requestPrestartTermination(h.client,owner,request);assert.equal(r.body.existing,true);assert.equal(r.body.request?.id,'pterm_1');
 await assert.rejects(requestPrestartTermination(h.client,renter,{...request,expectedOrderRevision:'2'}),(e:any)=>e.status===409);
 assert.equal(h.calls.some(c=>c.sql.startsWith('INSERT INTO zzsh_order.prestart_termination\n')),false);
});
test('客服核准全退：同事务识别原款责任并取消，保留付款指针，不生成opening/posting或分佣冲回',async t=>{
 const h=fixture(t);h.seed();const result=await reviewPrestartTermination(h.client,support,review);
 assert.equal(result.body.request?.state,'APPROVED');assert.equal(result.body.request?.liabilityRecognized,true);
 assert.equal(h.recognized[0].paymentConfirmationId,'pc_1');assert.equal(h.recognized[0].amountCents,'15908');assert.equal(h.facts.status,'CANCELLED');
 assert.equal(h.calls.some(c=>/INSERT INTO zzsh_order\.(settlement_posting|rental_opening|rental_referral_earning)/.test(c.sql)),false);
 const status=h.calls.find(c=>c.sql.startsWith('UPDATE zzsh_order.rental_order'))!;assert.doesNotMatch(status.sql,/SET paid_confirmation_id|paid_at\s*=/);
});
test('核准前重新检查当前开租事实；原款绑定改变保持409且不记责任',async t=>{
 for(const patch of [{opening_confirmed:true},{channel_trx_no:'TRX_OTHER'}]){const h=fixture(t,patch);h.seed();await assert.rejects(reviewPrestartTermination(h.client,support,review),(e:any)=>e.status===409);assert.equal(h.recognized.length,0);}
});
test('争议转复核/驳回不取消订单、不分配退款，也不允许用户假扮客服',async t=>{
 for(const decision of ['REVIEW_REQUIRED','REJECT']){const h=fixture(t);h.seed();const out=await reviewPrestartTermination(h.client,support,{...review,decision,assessment:undefined});
  assert.equal(out.body.request?.state,decision==='REJECT'?'REJECTED':'REVIEW_REQUIRED');assert.equal(h.facts.status,'PAID');assert.equal(h.recognized.length,0);}
 const h=fixture(t);h.seed();await assert.rejects(reviewPrestartTermination(h.client,renter,review),(e:any)=>e.status===403);
});
test('终态复核只读原责任，不重建；不能用新键把核准冒充驳回',async t=>{
 const h=fixture(t);h.seed();await reviewPrestartTermination(h.client,support,review);const before=h.recognized.length;
 const out=await reviewPrestartTermination(h.client,support,{...review,expectedRevision:'2'});assert.equal(out.body.existing,true);assert.equal(h.recognized.length,before);
 await assert.rejects(reviewPrestartTermination(h.client,support,{...review,decision:'REJECT',assessment:undefined}),(e:any)=>e.status===409);
});
test('普通GET限本人，缺结构不可报无申请；不取资金锁/改状态',async t=>{
 const h=fixture(t);h.seed();const out=await readPrestartTermination(h.client,owner,'order_1');assert.equal(out.request?.fullRefundCents,null);assert.equal(out.eligibility.refundCents,null);
 assert.equal(h.calls.some(c=>/\b(INSERT|UPDATE|DELETE)\b|FOR UPDATE|advisory/i.test(c.sql)),false);
 const stranger=fixture(t);await assert.rejects(readPrestartTermination(stranger.client,{...renter,userId:'stranger'},'order_1'),(e:any)=>e.status===404);
 const noSchema=fixture(t);(noSchema.client as any).query=async()=>({rowCount:1,rows:[{ready:false}]});await assert.rejects(readPrestartTermination(noSchema.client,renter,'order_1'),(e:any)=>e.status===503);
});
