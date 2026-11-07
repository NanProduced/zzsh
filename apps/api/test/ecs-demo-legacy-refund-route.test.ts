import assert from "node:assert/strict";
import { test } from "node:test";
import type { Pool } from "pg";
import { handleLegacyContinuationRoute } from "../src/order/legacy-continuation-routes";
import { legacyBinding } from "./legacy-continuation-fixture";

function response(){return {headersSent:false,statusCode:0,payload:undefined as unknown,status(n:number){this.statusCode=n;return this;},setHeader(){return this;},json(body:unknown){this.payload=body;this.headersSent=true;return this;}};}
test("demo old-order refund has an authorized, same-key recoverable admin route",async t=>{
  const auth:typeof import("../src/auth/auth-security")=require("../src/auth/auth-security");
  const finance:typeof import("../src/order/legacy-finance-duty")=require("../src/order/legacy-finance-duty");
  const demo:typeof import("../src/order/ecs-demo-legacy-refund")=require("../src/order/ecs-demo-legacy-refund");
  t.mock.method(auth,"readAdminContext",async()=>({userId:"staff_1",sessionId:"session_1"} as never));
  t.mock.method(finance,"authorizeLegacyFinanceDuty",async(...[_client,actor,orderId,kind]:Parameters<typeof finance.authorizeLegacyFinanceDuty>)=>{
    assert.equal(kind,"RENTER_REFUND");return {binding:{...legacyBinding,id:orderId},userIds:[],actor,financeDutyKind:kind};
  });
  const records=new Map<string,any>();let writes=0;
  const pool={connect:async()=>({release(){},query:async(sql:string,v:unknown[]=[])=>{
    if(sql.includes('"request_fingerprint" AS')){const r=records.get(String(v[1]));return{rows:r?[r]:[],rowCount:r?1:0};}
    if(sql.startsWith('INSERT INTO "zzsh_supply"."idempotency_record"'))records.set(String(v[1]),{requestFingerprint:v[2],responseStatus:v[3],responseBody:JSON.parse(String(v[4])),publishRequired:false});
    if(sql.includes('response_status AS status')){const r=records.get(String(v[1]));return{rows:r?[{status:r.responseStatus,body:r.responseBody,fingerprint:r.requestFingerprint}]:[]};}
    if(sql.includes('FROM zzsh_order.legacy_order_duty WHERE id='))return{rows:[{id:'duty_1'}],rowCount:1};return{rows:[],rowCount:0};
  }})} as unknown as Pool;
  const receipt={contractVersion:'demo-legacy-refund.v1' as const,scope:'LOCAL_DEMO_SIMULATED' as const,orderId:legacyBinding.id,dutyId:'duty_1',operationId:'demo_legacy_refund_1',amountCents:'100',paidCents:'200',assumption:'SIMULATION_ASSUME_NO_PRIOR_REFUND',simulatedAt:'2026-01-01T00:00:00.000Z',state:'SIMULATED' as const,bankArrival:'UNKNOWN' as const};
  t.mock.method(demo,'readDemoLegacyRefundReadiness',async()=>({scope:'LOCAL_DEMO_SIMULATED',headRevision:'2',dutyRevision:'1',canSubmit:true,reason:null,receipt:null,bankArrival:'UNKNOWN'} as never));
  t.mock.method(demo,'simulateLegacyRefund',async()=>{writes++;return{status:200,body:receipt};});
  t.mock.method(demo,'readDemoLegacyRefund',async()=>receipt);
  const options={pool,apiOrigin:'http://api.invalid',adminOrigin:'http://admin.invalid',ecsTestDemo:{} as never} as never;
  const body={expectedDutyRevision:'1',expectedHeadRevision:'2',assumption:'SIMULATION_ASSUME_NO_PRIOR_REFUND',reason:'演示核对'};
  const call=async(method:string,suffix:string,payload:Record<string,unknown>=body,key='original_key')=>{const r=response();
    await handleLegacyContinuationRoute({method,originalUrl:`/api/v1/admin/orders/legacy/${legacyBinding.id}/continuation${suffix}`,headers:{origin:'http://admin.invalid','idempotency-key':key},body:payload} as never,r as never,options,'admin');return r;};
  const path='/duties/duty_1/demo-refund';assert.equal((await call('GET',path)).statusCode,200);
  assert.equal((await call('POST',path)).statusCode,200);assert.equal((await call('POST',path)).statusCode,200);assert.equal(writes,1);
  const recovered=await call('GET','/receipt?command=demo-refund&dutyId=duty_1&key=original_key');
  assert.equal((recovered.payload as {state:string}).state,'KNOWN_SUCCESS');
  await assert.rejects(call('POST',path,{...body,reason:'另一项原因'}));assert.equal(writes,1);
});
