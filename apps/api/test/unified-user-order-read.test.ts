import assert from "node:assert/strict";
import { test } from "node:test";
import type { PoolClient } from "pg";
import { listUnifiedUserOrders, parseUnifiedOrderQuery } from "../src/order/unified-user-order-read";

const record = { id:"same-id",displayNo:"ORDER-1",sourceOrderStatus:4,sourcePayStatus:1,ownerUserId:"owner",renterUserId:"renter",gameId:"g",title:null,accountId:"a",accountDisplayNo:null,accountReadable:false,createdAt:null,paidAt:null,cancelledAt:null,completedAt:null,dueCents:"6600",paidCents:"6600",depositCents:"0",goodsYuan:"60.00",itemsYuan:"6.00",refundYuan:null };
test("unified query validates subject-independent bounded filters",()=>{
 for(const query of ["userId=owner","party=x","limit=0","limit=101","limit=1e2","party=owner&party=renter","status=bad","accountId=a/b","cursor=","orderNo=","orderNo=%20x","createdFrom=2026-02-30","createdFrom=2026-11-03&createdTo=2026-11-02","stage=OTHER"]){
  assert.throws(()=>parseUnifiedOrderQuery(new URLSearchParams(query)),Error,query);
 }
 assert.deepEqual(parseUnifiedOrderQuery(new URLSearchParams()),{party:"renter",limit:20});
 assert.deepEqual(parseUnifiedOrderQuery(new URLSearchParams("party=owner&orderNo=%E6%97%A7_%25%E5%8D%95&createdFrom=2026-09-01&createdTo=2026-11-03&stage=UNKNOWN")),{party:"owner",limit:20,orderNo:"旧_%单",createdFrom:"2026-09-01",createdTo:"2026-11-03",stage:"UNKNOWN"});
});
test("unified keyset binds subject, filters and source while retaining nullable dates",async()=>{
 let sql="",params:unknown[]=[];
 const row={origin:"LEGACY",id:"same-id",createdAt:null,record};
 const client={query:async(s:string,p:unknown[])=>{if(s.includes("visible_orders")){sql=s;params=p;}return {rows:[row,row]};}} as unknown as PoolClient;
 const result=await listUnifiedUserOrders(client,"renter",{party:"renter",limit:1});
 assert.equal(result.subjectId,"renter");
 assert.equal(result.items.length,1);assert.equal(result.items[0]!.readOnly,true);
 assert.equal((result.items[0]!.source as {origin:string}).origin,"LEGACY");
 assert.equal("ownerUserId" in result.items[0]!,false);
 assert.match(sql,/UNION ALL/);assert.match(sql,/o.renter_user_id\}=|o.renter_user_id=\$1/);
 assert.match(sql,/l.renter_user_id=\$1/);assert.match(sql,/NULLS LAST/);assert.match(sql,/x.origin COLLATE "C"/);
 const cursor=result.nextCursor!;
 await listUnifiedUserOrders(client,"renter",{party:"renter",limit:1,cursor});
 assert.deepEqual(params.slice(3),[true,null,"LEGACY","same-id",2,null,null,null]);
 for(const input of [{user:"stranger",party:"renter" as const},{user:"renter",party:"owner" as const}]){
  await assert.rejects(()=>listUnifiedUserOrders(client,input.user,{party:input.party,limit:1,cursor}),e=>(e as {status:number}).status===409);
 }
 await assert.rejects(()=>listUnifiedUserOrders(client,"renter",{party:"renter",limit:1,status:"PAID",cursor}),e=>(e as {status:number}).status===409);
 await assert.rejects(()=>listUnifiedUserOrders(client,"renter",{party:"renter",limit:1,orderNo:"ORDER-1",cursor}),e=>(e as {status:number}).status===409);
});

test("stage search is bounded and returns a continuation even when 500 records are unclassified",async()=>{
 const rows=Array.from({length:505},(_,i)=>{const id=`legacy-${String(504-i).padStart(4,"0")}`;return {origin:"LEGACY",id,createdAt:null,record:{...record,id}};});
 const calls:unknown[][]=[];
 const client={query:async(s:string,p:unknown[]=[])=>{
  if(s.includes("visible_orders")){calls.push(p);const start=p[3]?rows.findIndex(row=>row.id===p[6])+1:0;return {rows:rows.slice(start,start+Number(p[7]))};}
  return {rows:[]};
 }} as unknown as PoolClient;
 const first=await listUnifiedUserOrders(client,"renter",{party:"renter",stage:"POSTED",limit:20});
 assert.equal(first.items.length,0);assert.equal(first.scanIncomplete,true);assert.equal(first.stageUnknownObserved,true);assert.ok(first.nextCursor);assert.equal(calls.length,5);
 const next=await listUnifiedUserOrders(client,"renter",{party:"renter",stage:"POSTED",limit:20,cursor:first.nextCursor!});
 assert.equal(next.items.length,0);assert.equal(next.nextCursor,null);assert.equal(next.stageUnknownObserved,true);
 const unknown=await listUnifiedUserOrders(client,"renter",{party:"renter",stage:"UNKNOWN",limit:2});
 assert.equal(unknown.items.length,2);assert.ok(unknown.nextCursor);
 const unknownNext=await listUnifiedUserOrders(client,"renter",{party:"renter",stage:"UNKNOWN",limit:2,cursor:unknown.nextCursor!});
 assert.equal(new Set([...unknown.items,...unknownNext.items].map(item=>item.id)).size,4);
});

test("server applies subject, literal order number and Beijing date bounds before pagination",async()=>{
 let sql="",params:unknown[]=[];
 const client={query:async(s:string,p:unknown[]=[])=>{if(s.includes("visible_orders")){sql=s;params=p;}return {rows:[]};}} as unknown as PoolClient;
 const result=await listUnifiedUserOrders(client,"owner-1",{party:"owner",orderNo:"旧_%单",createdFrom:"2026-09-01",createdTo:"2026-11-03",limit:20});
 assert.equal(result.subjectId,"owner-1");assert.deepEqual(result.items,[]);
 assert.match(sql,/o.owner_user_id=\$1/);assert.match(sql,/l.owner_user_id=\$1/);
 assert.match(sql,/strpos\(lower\(o.display_no\),lower\(\$9\)\)/);assert.match(sql,/strpos\(lower\(l.original_order_no\),lower\(\$9\)\)/);
 assert.match(sql,/AT TIME ZONE 'Asia\/Shanghai'/);assert.deepEqual(params.slice(8),["旧_%单","2026-09-01","2026-11-03"]);
});
