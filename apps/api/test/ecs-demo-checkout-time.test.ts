import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool, PoolClient } from "pg";
import { confirmEcsDemoCheckout } from "../src/order/ecs-demo-checkout-service";

test("demo confirmation uses transaction time once and same-key replay preserves the original fact",async t=>{
 const security:typeof import('../src/auth/security-core')=require('../src/auth/security-core');
 const identity:typeof import('../src/auth/user-identity')=require('../src/auth/user-identity');
 const resource:typeof import('../src/finance/ecs-test-demo-resource')=require('../src/finance/ecs-test-demo-resource');
 const policy:typeof import('../src/finance/distribution-policy-store')=require('../src/finance/distribution-policy-store');
 const payment:typeof import('../src/order/payment-confirmation')=require('../src/order/payment-confirmation');
 const util:typeof import('../src/supply/supply-util')=require('../src/supply/supply-util');
 let now='2026-01-02T00:00:00.000Z',paid=false,calls=0,captured='';let saved:{status:number;body:unknown}|undefined;
 const client={query:async(sql:string)=>{
  if(sql.includes("to_char(clock_timestamp()"))return{rows:[{at:now}]};
  if(sql.includes('FROM zzsh_order.rental_order WHERE id='))return{rows:[{id:'order_1',display_no:'ORDER1',status:paid?'PAID':'PENDING_PAYMENT',currency:'CNY',amount_cents:'200',created_at:'2026-01-01T00:00:00.000Z',hold_until:'2026-01-03T00:00:00.000Z'}]};
  if(sql.includes('SELECT 1 FROM zzsh_supply.idempotency_record'))return{rows:[{}],rowCount:1};return{rows:[],rowCount:0};
 }} as unknown as PoolClient;
 t.mock.method(security,'withTransaction',async(...[_pool,work]:Parameters<typeof security.withTransaction>)=>work(client));
 t.mock.method(security,'recordAudit',async()=>{});
 t.mock.method(identity,'assertUserContextInTransaction',async()=>{});
 t.mock.method(resource,'assertEcsTestDemoResource',async()=>({} as never));
 t.mock.method(resource,'ensureEcsTestDemoOrderAdmission',async()=> 'admission_1');
 t.mock.method(resource,'ecsTestDemoPaymentAnchor',()=>({declarationId:'d1',providerTransactionId:'demo_tx',requestId:'demo_request',merchantScopeId:'demo_scope'}));
 t.mock.method(resource,'demoFinanceScope',()=> 'LOCAL_DEMO_SIMULATED');
 t.mock.method(policy,'readDistributionPolicyRowInTransaction',async()=>({knowledge:'KNOWN',policy:{} as never}));
 t.mock.method(payment,'createEcsDemoControlledPaymentSource',()=>((fact:any)=>fact) as never);
 t.mock.method(payment,'confirmOrderPayment',async(...[_c,fact]:Parameters<typeof payment.confirmOrderPayment>)=>{calls++;captured=fact.providerPaidAt;paid=true;return{confirmationId:'payment_1',disposition:'APPLIED',reasonCode:null,replay:false};});
 t.mock.method(util,'withIdempotency',async(...[_c,_scope,_key,_fingerprint,authorize,action]:Parameters<typeof util.withIdempotency>)=>{
  await authorize(saved?{publishRequired:false}:null);if(saved)return{replayed:true,...saved};
  saved=await action();return{replayed:false,...saved};
 });
 const options={demo:{} as never,appId:'demo_app',distribution:{} as never},actor={userId:'renter_1',sessionId:'session_1',requestId:'request_1'};
 const first=await confirmEcsDemoCheckout({} as Pool,actor,'order_1','original_key',options);
 assert.equal(captured,'2026-01-02T00:00:00.000Z');assert.equal(calls,1);
 now='2026-01-02T00:01:00.000Z';const replay=await confirmEcsDemoCheckout({} as Pool,actor,'order_1','original_key',options);
 assert.equal(replay.replayed,true);assert.deepEqual(replay.body,first.body);assert.equal(calls,1);assert.equal(captured,'2026-01-02T00:00:00.000Z');
});
