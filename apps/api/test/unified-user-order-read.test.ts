import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { listUnifiedUserOrders, parseUnifiedOrderQuery } from "../src/order/unified-user-order-read";

const record = { id:"same-id",displayNo:"ORDER-1",sourceOrderStatus:4,sourcePayStatus:1,ownerUserId:"owner",renterUserId:"renter",gameId:"g",title:null,accountId:"a",accountDisplayNo:null,accountReadable:false,createdAt:null,paidAt:null,cancelledAt:null,completedAt:null,dueCents:"6600",paidCents:"6600",depositCents:"0",goodsYuan:"60.00",itemsYuan:"6.00",refundYuan:null };
test("unified query validates subject-independent bounded filters",()=>{
 for(const query of ["userId=owner","party=x","limit=0","limit=101","limit=1e2","party=owner&party=renter","status=bad","accountId=a/b","cursor="]){
  assert.throws(()=>parseUnifiedOrderQuery(new URLSearchParams(query)),Error,query);
 }
 assert.deepEqual(parseUnifiedOrderQuery(new URLSearchParams()),{party:"renter",limit:20});
});
test("unified keyset binds subject, filters and source while retaining nullable dates",async()=>{
 let sql="",params:unknown[]=[];
 const row={origin:"LEGACY",id:"same-id",createdAt:null,record};
 const client={query:async(s:string,p:unknown[])=>{if(s.includes("visible_orders")){sql=s;params=p;}return {rows:[row,row]};}} as unknown as PoolClient;
 const result=await listUnifiedUserOrders(client,"renter",{party:"renter",limit:1});
 assert.equal(result.items.length,1);assert.equal(result.items[0]!.readOnly,true);
 assert.equal((result.items[0]!.source as {origin:string}).origin,"LEGACY");
 assert.equal("ownerUserId" in result.items[0]!,false);
 assert.match(sql,/UNION ALL/);assert.match(sql,/o.renter_user_id\}=|o.renter_user_id=\$1/);
 assert.match(sql,/l.renter_user_id=\$1/);assert.match(sql,/NULLS LAST/);assert.match(sql,/x.origin COLLATE "C"/);
 const cursor=result.nextCursor!;
 await listUnifiedUserOrders(client,"renter",{party:"renter",limit:1,cursor});
 assert.deepEqual(params.slice(3),[true,null,"LEGACY","same-id",2]);
 for(const input of [{user:"stranger",party:"renter" as const},{user:"renter",party:"owner" as const}]){
  await assert.rejects(()=>listUnifiedUserOrders(client,input.user,{party:input.party,limit:1,cursor}),e=>(e as {status:number}).status===409);
 }
 await assert.rejects(()=>listUnifiedUserOrders(client,"renter",{party:"renter",limit:1,status:"PAID",cursor}),e=>(e as {status:number}).status===409);
});
