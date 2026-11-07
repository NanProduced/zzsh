import {test} from 'node:test';
import {strict as assert} from 'node:assert';
import type {PoolClient} from 'pg';
import {SecurityApiError} from '../src/auth/security-core';
import {LegacyCommissionCommitUnknown,runLegacyCommissionDuePage} from '../src/finance/legacy-commission-due-worker';
const duty:typeof import('../src/order/legacy-finance-duty')=require('../src/order/legacy-finance-duty');
const at='2026-11-01T00:00:00.000000Z';

function fixture(rows:Array<{id:string;orderId:string;at:string}>,options:{ready?:boolean;failCommitAt?:number}={}){
 const calls:Array<{sql:string;args:unknown[]}> = [];let commits=0;
 const client={query:async(sql:string,args:unknown[]=[])=>{
  calls.push({sql,args});
  if(sql.includes('FROM pg_index'))return {rows:[{ready:options.ready!==false}]};
  if(sql.includes('FROM zzsh_order.legacy_order_duty d JOIN'))return {rows};
  if(sql==='COMMIT' && ++commits===options.failCommitAt)throw new Error('COMMIT_ACK_LOST');
  return {rows:[],rowCount:0};
 }} as unknown as PoolClient;
 return {client,calls};
}

test('an unavailable legacy schema leaves the native worker untouched',async t=>{
 const f=fixture([],{ready:false}),call=t.mock.method(duty,'settleLegacyCommissionDueOn',async()=>{throw new Error('unexpected');});
 assert.deepEqual(await runLegacyCommissionDuePage(f.client,null,20),{available:false,cursor:null,posted:0,deferred:0,scanned:0});assert.equal(call.mock.callCount(),0);
});
test('a bounded page advances past deferred duties and preserves its exact cursor',async t=>{
 const rows=[{id:'duty_1',orderId:'order_1',at},{id:'duty_2',orderId:'order_2',at}],f=fixture(rows);
 t.mock.method(duty,'settleLegacyCommissionDueOn',async(...[_client,_order,id]:Parameters<typeof duty.settleLegacyCommissionDueOn>)=>id==='duty_1'?{outcome:'REVIEW_REQUIRED'} as any:{outcome:'POSTED',receipt:{}} as any);
 const result=await runLegacyCommissionDuePage(f.client,null,2);
 assert.deepEqual(result,{available:true,cursor:{at,id:'duty_2'},posted:1,deferred:1,scanned:2});
 assert.equal(f.calls.filter(c=>c.sql==='COMMIT').length,3);
 const next=fixture([]);await runLegacyCommissionDuePage(next.client,result.cursor,2);
 assert.deepEqual(next.calls.find(c=>c.sql.includes('FROM zzsh_order.legacy_order_duty d JOIN'))?.args,[at,'duty_2',2]);
});
test('a known conflict does not block later duties, but an unknown commit stops the batch',async t=>{
 const rows=[{id:'duty_1',orderId:'order_1',at},{id:'duty_2',orderId:'order_2',at}],f=fixture(rows);
 let attempted=0;t.mock.method(duty,'settleLegacyCommissionDueOn',async()=>{if(++attempted===1)throw new SecurityApiError(409,'CONFLICT','source changed');return {outcome:'POSTED',receipt:{}} as any;});
 assert.deepEqual(await runLegacyCommissionDuePage(f.client,null,2),{available:true,cursor:{at,id:'duty_2'},posted:1,deferred:1,scanned:2});
 t.mock.restoreAll();attempted=0;const uncertain=fixture(rows,{failCommitAt:2});
 t.mock.method(duty,'settleLegacyCommissionDueOn',async()=>{attempted++;return {outcome:'POSTED',receipt:{}} as any;});
 await assert.rejects(runLegacyCommissionDuePage(uncertain.client,null,2),LegacyCommissionCommitUnknown);assert.equal(attempted,1);
});
test('shutdown stops between duties without discarding the last processed cursor',async t=>{
 const f=fixture([{id:'duty_1',orderId:'order_1',at},{id:'duty_2',orderId:'order_2',at}]);let done=0;
 t.mock.method(duty,'settleLegacyCommissionDueOn',async()=>{done++;return {outcome:'POSTED',receipt:{}} as any;});
 assert.deepEqual(await runLegacyCommissionDuePage(f.client,null,2,()=>done>0),{available:true,cursor:{at,id:'duty_1'},posted:1,deferred:0,scanned:1});
});
