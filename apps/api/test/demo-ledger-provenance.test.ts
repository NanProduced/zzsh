import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { readDemoLedgerOrigins } from "../src/finance/demo-ledger-provenance";

test("demo provenance requires readable registered evidence and does not label old history",async()=>{
  let calls=0;
  const absent={query:async()=>{calls++;return{rows:[{present:false,ready:false}]};}} as unknown as PoolClient;
  assert.deepEqual([...await readDemoLedgerOrigins(absent,[])],[]);assert.equal(calls,0);
  assert.deepEqual([...await readDemoLedgerOrigins(absent,["ledger_1"])],[]);assert.equal(calls,1);
  const unavailable={query:async()=>({rows:[{present:true,ready:false}]})} as unknown as PoolClient;
  await assert.rejects(readDemoLedgerOrigins(unavailable,["ledger_1"]),/测试资金来源暂不可核对/);
  const client={query:async(sql:string,params?:unknown[])=>{
    if(sql.includes("AS present"))return{rows:[{present:true,ready:true}]};
    assert.deepEqual(params,[["local","ecs","unproved","legacy"]]);
    return{rows:[{id:"local",candidate:true,schema:"local-demo-clone-finance.v1"},
      {id:"ecs",candidate:true,schema:"ecs-test-demo-finance.v1"},{id:"unproved",candidate:true,schema:null},
      {id:"legacy",candidate:false,schema:null}]};
  }} as unknown as PoolClient;
  const result=await readDemoLedgerOrigins(client,["local","ecs","unproved","legacy"]);
  assert.equal(result.get("local"),"LOCAL_DEMO_SIMULATED");assert.equal(result.get("ecs"),"ECS_TEST_SIMULATED");
  assert.equal(result.get("unproved"),"UNKNOWN");assert.equal(result.has("legacy"),false);
});

test("客服取消测试账本仅在原付款与登记闭合时识别，缺依据保持未知",async()=>{
 let sqlText='';
 const client={query:async(sql:string)=>{
  if(sql.includes('AS present'))return{rows:[{present:true,ready:true,support_ready:true}]};
  sqlText=sql;return{rows:[{id:'controlled',candidate:true,schema:'local-demo-clone-finance.v1'},
   {id:'unproved',candidate:true,schema:null},{id:'formal',candidate:false,schema:null}]};
 }} as unknown as PoolClient;
 const result=await readDemoLedgerOrigins(client,['controlled','unproved','formal']);
 assert.equal(result.get('controlled'),'LOCAL_DEMO_SIMULATED');assert.equal(result.get('unproved'),'UNKNOWN');assert.equal(result.has('formal'),false);
 assert.match(sqlText,/support_poststart_cancellation_complete\(sp\.id\)/);
 assert.match(sqlText,/spay\.source IS DISTINCT FROM 'JOINPAY'/);
 assert.match(sqlText,/s\.registration_digest=encode\(sha256/);
});
